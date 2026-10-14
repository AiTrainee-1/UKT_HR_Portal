"""
Holiday / Sunday work compensation (Compensation Leave, part B).

An employee who works on a Sunday or a company holiday earns 0.25 / 0.50 / 0.75 / 1 shift of compensation. Only HR can
raise the claim; it counts only AFTER the employee's Department Head approves it (approval workflow `holiday_work`,
approval_workflow.py: HR-raised, the HOD always decides). Final approval adds the shifts to the employee's compensation
balance (CompensationLedger, a credit) exactly once.

HR endpoints (permission module `compensation`, staff only, branch-scoped; a view-only role can read, not change):

    POST   /api/compensation/holiday-work              raise a claim for one or several employees
    GET    /api/compensation/holiday-work              the claims, with their approval progress
    GET    /api/compensation/holiday-work/eligible     who worked on a Sunday / holiday, and who can still be claimed for
    GET    /api/compensation/holiday-work/<id>         one claim
    DELETE /api/compensation/holiday-work/<id>         withdraw a claim that is still waiting for the Department Head

Rules (each one is refused with a plain sentence, nothing is saved when any employee of a request fails):

  * changes need the master switch (Settings -> Payroll -> OT / Compensation), the Holiday work switch (Settings ->
    Compensation) and the `holiday_work` workflow to be ON; reading never needs them;
  * `workDate` must be a Sunday or a declared holiday that has already happened, and not older than MAX_CLAIM_AGE_DAYS;
  * the employee must be an ACTIVE STAFF member with punches, a present attendance record or a manual attendance entry on
    that day (the work has to be on record);
  * `shifts` is one of 0.25, 0.50, 0.75, 1;
  * one claim per employee per date: a new one is refused while an earlier one is pending or approved (a rejected claim
    can be raised again).

The Department Head decides through the manager endpoints (manager_views.py), which call `decide_claim` below.
"""

from __future__ import annotations

from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Min, Sum
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from . import whatsapp_approvals
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import (
    SHIFT_TEXT,
    date_text,
    day_kind,
    employee_json,
    full_name,
    holiday_names,
    parse_date,
    parse_int,
    parse_shifts,
    shifts_text,
    switches,
)
from .compensation_views import require_compensation_features_for_changes
from .hod_scope import effective_owner_map
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    CompensationConfig,
    CompensationLedger,
    DepartmentManager,
    Employee,
    HolidayWorkClaim,
    Notification,
)

WORKFLOW = "holiday_work"

# A claim can be raised for work done in the last MAX_CLAIM_AGE_DAYS days (inclusive). The balance it earns is not money,
# so there is no payroll month to protect; the limit only keeps a claim close enough to the work for the Department Head to
# remember it, and stops a typed year from raising a claim for work that never happened.
MAX_CLAIM_AGE_DAYS = 45
MAX_EMPLOYEES_PER_REQUEST = 200
MAX_REASON_LENGTH = 500
LIST_DEFAULT_LIMIT = 500
LIST_MAX_LIMIT = 1000

FEATURE_OFF_MESSAGE = (
    "Holiday / Sunday work compensation is switched off in Settings > Compensation, so a claim can't be raised "
    "or withdrawn right now."
)

_WORKED_STATUSES = (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)


# ─────────────────────────── shapes ───────────────────────────


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _body_int(raw) -> int | None:
    """An employee id from the JSON body. JSON `1e999` parses to infinity, which int() answers with an OverflowError:
    that is a bad id (a 400), not a crash."""
    try:
        return parse_int(raw)
    except OverflowError:
        return None


def hod_names(employee_ids) -> dict[int, str]:
    """{employee_id: name of the ONE Department Head who decides for them} (hod_scope: one HOD per employee). People
    with no active Department Head are absent."""
    ids = list(employee_ids)
    owner = effective_owner_map(ids) if ids else {}
    if not owner:
        return {}
    managers = {
        m.id: m for m in DepartmentManager.objects.select_related("employee").filter(pk__in=set(owner.values()))
    }
    return {eid: full_name(managers[mid].employee) for eid, mid in owner.items() if mid in managers}


def claim_json(
    claim: HolidayWorkClaim,
    cfg: approval.Config | None = None,
    holidays: dict | None = None,
    hods: dict | None = None,
) -> dict:
    """One claim for HR and for the Department Head. `holidays` ({date: name}) and `hods` ({employee_id: HOD name}) are
    passed by a list so it does not query once per row; without them the row says so with nulls."""
    work_date = claim.work_date
    names = holidays or {}
    kind = day_kind(work_date, names)
    ledger = [e for e in claim.ledger_entries.all() if e.entry_type == CompensationLedger.ENTRY_CREDIT]
    return {
        "id": claim.id,
        **employee_json(claim.employee),
        "workDate": work_date.isoformat(),
        "dayKind": kind or ("sunday" if work_date.weekday() == 6 else "holiday"),
        "holidayName": names.get(work_date),
        "shifts": float(claim.shifts),
        "reason": claim.reason,
        "status": claim.status,
        "requestedBy": claim.requested_by,
        "reviewedBy": claim.reviewed_by,
        "reviewComment": claim.review_comment,
        "reviewedAt": claim.reviewed_at.isoformat() if claim.reviewed_at else None,
        "createdAt": claim.created_at.isoformat() if claim.created_at else None,
        "hodName": (hods or {}).get(claim.employee_id),
        "credited": bool(ledger),
        "approval": approval.progress(WORKFLOW, claim, cfg),
    }


def claims_json(claims: list[HolidayWorkClaim]) -> list[dict]:
    """A list of claims, with the holiday names and Department Heads looked up once for the whole list."""
    if not claims:
        return []
    cfg = approval.get_config(WORKFLOW)
    dates = [c.work_date for c in claims]
    holidays = holiday_names(min(dates), max(dates))
    hods = hod_names({c.employee_id for c in claims})
    return [claim_json(c, cfg, holidays, hods) for c in claims]


def _enabled_block() -> dict:
    flags = switches()
    workflow = approval.get_config(WORKFLOW).enabled
    return {
        "master": flags["master"],
        "holidayWork": flags["holidayWork"],
        "workflow": workflow,
        "canRaise": bool(flags["master"] and flags["holidayWork"] and workflow),
    }


# ─────────────────────────── the rules ───────────────────────────


def feature_block() -> Response | None:
    """The refusal for a CHANGE while the feature (or its workflow) is off; the master switch is the decorator's job."""
    if not CompensationConfig.get().holiday_work_enabled:
        return Response({"error": FEATURE_OFF_MESSAGE, "code": "feature_disabled"}, status=403)
    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    return None


def date_problem(work_date, today) -> str | None:
    """Why `work_date` cannot carry a claim, or None. `work_date` is a date."""
    holidays = holiday_names(work_date, work_date)
    if day_kind(work_date, holidays) is None:
        return (
            f"{date_text(work_date)} is neither a Sunday nor a declared holiday, so there is no holiday work to claim."
        )
    if work_date > today:
        return f"{date_text(work_date)} has not happened yet."
    if work_date < today - timedelta(days=MAX_CLAIM_AGE_DAYS):
        return f"A claim can only be raised for work done in the last {MAX_CLAIM_AGE_DAYS} days."
    return None


def worked_ids(work_date, employee_ids=None) -> set[int]:
    """Who has the day on record: punches, a manual attendance entry marked present, or a present / half-shift day record.
    Three queries whatever the number of employees. Restricted to `employee_ids` when given (a list), else everybody."""
    logs = AttendanceLog.objects.filter(date=work_date)
    manual = Attendance.objects.filter(date=work_date.isoformat(), present=True)
    records = AttendanceDayRecord.objects.filter(date=work_date, status__in=_WORKED_STATUSES)
    if employee_ids is not None:
        logs = logs.filter(employee_id__in=employee_ids)
        manual = manual.filter(employee_id__in=employee_ids)
        records = records.filter(employee_id__in=employee_ids)
    return (
        set(logs.values_list("employee_id", flat=True).distinct())
        | set(manual.values_list("employee_id", flat=True))
        | set(records.values_list("employee_id", flat=True))
    )


def open_claims(work_date, employee_ids=None) -> dict[int, HolidayWorkClaim]:
    """{employee_id: the pending or approved claim for that date}: what blocks a second claim."""
    qs = HolidayWorkClaim.objects.filter(
        work_date=work_date, status__in=(HolidayWorkClaim.STATUS_PENDING, HolidayWorkClaim.STATUS_APPROVED)
    ).order_by("-id")
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=employee_ids)
    out: dict[int, HolidayWorkClaim] = {}
    for claim in qs:
        out.setdefault(claim.employee_id, claim)
    return out


def _employee_problem(emp: Employee, evidence: set[int], claims: dict[int, HolidayWorkClaim], work_date) -> str | None:
    name = full_name(emp)
    if emp.employment_type != "staff":
        return f"{name} is a production employee: holiday and Sunday work compensation is only for staff."
    if emp.status != "active":
        return f"{name} is not an active employee."
    if emp.id not in evidence:
        return f"{name} has no punches or attendance on {date_text(work_date)}, so there is no work on record to claim for."
    existing = claims.get(emp.id)
    if existing is not None:
        return f"{name} already has a claim for {date_text(work_date)} that is {existing.status}."
    return None


def _requested_items(data) -> tuple[list[tuple[int, object]] | None, str | None]:
    """[(employee_id, shifts or None)] from `items` ([{employeeId, shifts?}]), `employeeIds` or `employeeId`; the shifts of
    an item win over the request's own `shifts`. (None, message) when the body cannot be read."""
    default = data.get("shifts")
    items: list[tuple[int, object]] = []
    if data.get("items") is not None:
        raw = data.get("items")
        if not isinstance(raw, list) or not raw or not all(isinstance(i, dict) for i in raw):
            return None, "items must be a list of {employeeId, shifts} entries."
        for item in raw:
            emp_id = _body_int(item.get("employeeId"))
            if emp_id is None:
                return None, "Every item needs an employeeId."
            items.append((emp_id, item.get("shifts", default)))
    else:
        raw = data.get("employeeIds")
        if raw is None:
            raw = [data.get("employeeId")] if data.get("employeeId") not in (None, "") else None
        if not isinstance(raw, list) or not raw:
            return None, "employeeId or employeeIds is required."
        for value in raw:
            emp_id = _body_int(value)
            if emp_id is None:
                return None, "employeeIds must be employee ids."
            items.append((emp_id, default))
    seen: dict[int, object] = {}
    for emp_id, shifts in items:
        seen.setdefault(emp_id, shifts)
    if len(seen) > MAX_EMPLOYEES_PER_REQUEST:
        return None, f"A request can cover at most {MAX_EMPLOYEES_PER_REQUEST} employees."
    return list(seen.items()), None


def _bad(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


# ─────────────────────────── HR endpoints ───────────────────────────


def _raise_claims(request: Request) -> Response:
    blocked = feature_block()
    if blocked is not None:
        return blocked
    data = request.data if isinstance(request.data, dict) else {}

    work_date = parse_date(data.get("workDate"))
    if work_date is None:
        return _bad("workDate must be a date (YYYY-MM-DD).")
    problem = date_problem(work_date, ist_today())
    if problem:
        return _bad(problem)
    reason = str(data.get("reason") or "").strip()
    if not reason:
        return _bad("Give a reason (what was the work on that day?): the Department Head reads it before deciding.")
    if len(reason) > MAX_REASON_LENGTH:
        return _bad(f"The reason can be at most {MAX_REASON_LENGTH} characters.")
    items, error = _requested_items(data)
    if error:
        return _bad(error)
    shifts_by_employee: dict[int, object] = {}
    for emp_id, raw in items:
        value = parse_shifts(raw)
        if value is None:
            if raw in (None, ""):
                return _bad(f"shifts is required: {SHIFT_TEXT}.")
            return _bad(f"shifts must be {SHIFT_TEXT}.")
        shifts_by_employee[emp_id] = value

    ids = list(shifts_by_employee)
    hr_name = get_hr_display_name(request)
    with transaction.atomic():
        # Locking the employees serialises two people raising the same claim at the same moment.
        employees = {
            e.id: e
            for e in scope_to_branch(Employee.objects.select_related("department", "designation", "branch"), request)
            .select_for_update(of=("self",))
            .filter(pk__in=ids)
            .order_by("pk")  # always the same order, so two overlapping requests can never wait on each other
        }
        evidence = worked_ids(work_date, list(employees))
        claims = open_claims(work_date, list(employees))
        problems = []
        for emp_id in ids:
            emp = employees.get(emp_id)
            message = "Employee not found." if emp is None else _employee_problem(emp, evidence, claims, work_date)
            if message:
                problems.append({"employeeId": emp_id, "error": message})
        if problems:
            if len(ids) == 1:
                status = 404 if ids[0] not in employees else 400
                return _bad(problems[0]["error"], status, problems=problems)
            return _bad(
                f"{len(problems)} of {len(ids)} employees cannot be claimed for. Nothing was raised: "
                + " ".join(p["error"] for p in problems[:3])
                + (" ..." if len(problems) > 3 else ""),
                problems=problems,
            )

        created = []
        for emp_id in ids:
            emp = employees[emp_id]
            claim = HolidayWorkClaim.objects.create(
                employee=emp,
                work_date=work_date,
                shifts=shifts_by_employee[emp_id],
                reason=reason,
                status=HolidayWorkClaim.STATUS_PENDING,
                requested_by=hr_name,
                approval_trail=[],
            )
            approval.notify_new_request(WORKFLOW, emp, f"holiday-work compensation claim for {date_text(work_date)}")
            log_action(
                request,
                "create",
                "compensation",
                record_id=claim.id,
                description=(
                    f"Raised holiday-work claim for {emp.employee_code} on {work_date.isoformat()}: "
                    f"{shifts_text(claim.shifts)} shift"
                ),
                new_values={"workDate": work_date.isoformat(), "shifts": str(claim.shifts), "reason": reason},
            )
            created.append(claim.id)
    claims_out = list(
        HolidayWorkClaim.objects.select_related("employee__department", "employee__designation", "employee__branch")
        .prefetch_related("ledger_entries")
        .filter(pk__in=created)
        .order_by("id")
    )
    return Response(
        {"created": len(created), "claims": claims_json(claims_out), "warnings": _stuck_warnings(claims_out)},
        status=201,
    )


def _stuck_warnings(claims: list[HolidayWorkClaim]) -> list[str]:
    """Sentences for the claims nobody can decide yet: the employee has no Department Head, is their own, or has one whose
    profile does not allow approving compensation. The claim is raised all the same (HR may fix the assignment next)."""
    owners = effective_owner_map([c.employee_id for c in claims])
    managers = {
        m.id: m for m in DepartmentManager.objects.select_related("employee").filter(pk__in=set(owners.values()))
    }
    out = []
    for c in claims:
        manager = managers.get(owners.get(c.employee_id))
        name = full_name(c.employee)
        if manager is None:
            out.append(
                f"{name} has no Department Head assigned, so nobody can approve this claim yet (HOD Assignment)."
            )
        elif manager.employee_id == c.employee_id:
            out.append(
                f"{name} is a Department Head, and a head never decides their own claim: assign them another head."
            )
        elif not manager.can_approve_compensation:
            out.append(
                f"{full_name(manager.employee)} cannot approve compensation: switch it on in User Management "
                f"(HOD Assignment) so {name}'s claim can be decided."
            )
    return out


def _list_claims(request: Request) -> Response:
    q = request.query_params
    today = ist_today()
    status = (q.get("status") or "all").lower()
    if status not in ("all", "waiting", "pending", "approved", "rejected"):
        return _bad("status must be all, pending, approved or rejected.")
    month = parse_int(q.get("month"))
    year = parse_int(q.get("year"))
    if (q.get("month") not in (None, "") and month is None) or (q.get("year") not in (None, "") and year is None):
        return _bad("month and year must be numbers.")
    if month is not None and not 1 <= month <= 12:
        return _bad("month must be 1 to 12.")
    # `anyMonth=1` lifts the default window (the current month): without an explicit month / year the claims of EVERY
    # month are listed, e.g. status=pending&anyMonth=1 for everything still waiting for a Department Head.
    any_month = (q.get("anyMonth") or "").strip().lower() in ("1", "true", "yes")
    if month is None and year is None:
        if not any_month:
            month, year = today.month, today.year
    elif year is None:
        year = today.year
    limit = parse_int(q.get("limit")) or LIST_DEFAULT_LIMIT
    limit = max(1, min(limit, LIST_MAX_LIMIT))

    qs = scope_to_branch(HolidayWorkClaim.objects.all(), request, field="employee__branch_id")
    if year is not None:
        qs = qs.filter(work_date__year=year)
    if month is not None:
        qs = qs.filter(work_date__month=month)
    if status != "all":
        qs = qs.filter(status=HolidayWorkClaim.STATUS_PENDING if status == "waiting" else status)
    if parse_int(q.get("employeeId")) is not None:
        qs = qs.filter(employee_id=parse_int(q.get("employeeId")))
    if parse_int(q.get("departmentId")) is not None:
        qs = qs.filter(employee__department_id=parse_int(q.get("departmentId")))
    if parse_int(q.get("branchId")) is not None:
        qs = qs.filter(employee__branch_id=parse_int(q.get("branchId")))

    counts = {row["status"]: row for row in qs.order_by().values("status").annotate(n=Count("id"), total=Sum("shifts"))}
    rows = list(
        qs.select_related("employee__department", "employee__designation", "employee__branch")
        .prefetch_related("ledger_entries")
        .order_by("-work_date", "-id")[:limit]
    )
    total = sum(r["n"] for r in counts.values())
    summary = {
        "pending": counts.get("pending", {}).get("n", 0),
        "approved": counts.get("approved", {}).get("n", 0),
        "rejected": counts.get("rejected", {}).get("n", 0),
        "approvedShifts": float(counts.get("approved", {}).get("total") or 0),
        "pendingShifts": float(counts.get("pending", {}).get("total") or 0),
    }
    return Response(
        {
            "results": claims_json(rows),
            "count": total,
            "truncated": total > len(rows),
            "month": month,
            "year": year,
            "summary": summary,
            "enabled": _enabled_block(),
        }
    )


@api_view(["GET", "POST"])
@require_hr
@require_compensation_features_for_changes
def holiday_work_claims(request: Request) -> Response:
    if request.method == "POST":
        try:
            return _raise_claims(request)
        except IntegrityError:
            # the database's own guard (one pending / approved claim per employee per date) caught a clash the checks
            # above missed: the transaction was rolled back, so nothing was raised
            return _bad(
                "One of these employees already has a claim for that date that is waiting or approved. Nothing was raised."
            )
    return _list_claims(request)


@api_view(["GET", "DELETE"])
@require_hr
@require_compensation_features_for_changes
def holiday_work_claim_detail(request: Request, pk: int) -> Response:
    claim = (
        scope_to_branch(HolidayWorkClaim.objects.all(), request, field="employee__branch_id")
        .select_related("employee__department", "employee__designation", "employee__branch")
        .prefetch_related("ledger_entries")
        .filter(pk=pk)
        .first()
    )
    if claim is None:
        return _bad("Claim not found.", 404)
    if request.method == "GET":
        return Response(claims_json([claim])[0])

    blocked = feature_block_for_withdraw()
    if blocked is not None:
        return blocked
    with transaction.atomic():
        locked = HolidayWorkClaim.objects.select_for_update().filter(pk=pk).first()
        if locked is None:
            return _bad("Claim not found.", 404)
        if locked.status != HolidayWorkClaim.STATUS_PENDING:
            return _bad(
                f"This claim is already {locked.status}: only a claim that is still waiting for the Department Head "
                "can be withdrawn."
            )
        snapshot = {"workDate": locked.work_date.isoformat(), "shifts": str(locked.shifts), "reason": locked.reason}
        code = claim.employee.employee_code
        locked.delete()
    log_action(
        request,
        "delete",
        "compensation",
        record_id=pk,
        description=f"Withdrew holiday-work claim for {code} on {snapshot['workDate']}",
        old_values=snapshot,
    )
    return Response(status=204)


def feature_block_for_withdraw() -> Response | None:
    """Withdrawing needs the feature switch on like raising does, but not the workflow: a claim must stay withdrawable
    after HR switches the workflow off to stop NEW claims."""
    if not CompensationConfig.get().holiday_work_enabled:
        return Response({"error": FEATURE_OFF_MESSAGE, "code": "feature_disabled"}, status=403)
    return None


def _punch_rows(work_date, employee_ids) -> dict[int, dict]:
    """{employee_id: {n, first, last}}: the day's punches per employee (one query)."""
    return {
        r["employee_id"]: r
        for r in AttendanceLog.objects.filter(date=work_date, employee_id__in=employee_ids)
        .values("employee_id")
        .annotate(n=Count("id"), first=Min("punch_time"), last=Max("punch_time"))
    }


@api_view(["GET"])
@require_hr
def holiday_work_eligible(request: Request) -> Response:
    """Who worked on `date` (a Sunday or a declared holiday) and whether HR can still raise a claim for them.

    Lists the staff with the day on record (punches, a manual present entry or a present / half-shift day record). Anyone
    who cannot be claimed for says why (`reason`): a claim is already pending or approved for the date. `employeeId`
    returns that one employee even when they did not work, with the reason, so HR can see why somebody is missing."""
    q = request.query_params
    work_date = parse_date(q.get("date"))
    if work_date is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    wanted_id = parse_int(q.get("employeeId"))
    if q.get("employeeId") not in (None, "") and wanted_id is None:
        return _bad("employeeId must be a number.")
    today = ist_today()
    holidays = holiday_names(work_date, work_date)
    kind = day_kind(work_date, holidays)
    message = date_problem(work_date, today)
    body = {
        "date": work_date.isoformat(),
        "dayKind": kind,
        "holidayName": holidays.get(work_date),
        "claimable": message is None,
        "message": message,
        "maxAgeDays": MAX_CLAIM_AGE_DAYS,
        "earliestDate": (today - timedelta(days=MAX_CLAIM_AGE_DAYS)).isoformat(),
        "enabled": _enabled_block(),
        "employees": [],
        "counts": {"worked": 0, "eligible": 0},
    }
    if kind is None:
        return Response(body)

    select = ("department", "designation", "branch")
    if wanted_id is not None:
        emp = scope_to_branch(Employee.objects.select_related(*select), request).filter(pk=wanted_id).first()
        if emp is None:
            return _bad("Employee not found.", 404)
        people = [emp]
        scope_ids = [emp.id]
    else:
        staff = scope_to_branch(Employee.objects.filter(employment_type="staff", status="active"), request)
        if parse_int(q.get("departmentId")) is not None:
            staff = staff.filter(department_id=parse_int(q.get("departmentId")))
        scope_ids = staff.values("pk")
        people = None
    punches = _punch_rows(work_date, scope_ids)
    on_record = worked_ids(work_date, scope_ids)
    if people is None:
        people = list(Employee.objects.select_related(*select).filter(pk__in=on_record))
    ids = [e.id for e in people]
    claims = open_claims(work_date, ids)
    day_records = {r.employee_id: r for r in AttendanceDayRecord.objects.filter(date=work_date, employee_id__in=ids)}
    rows = []
    for emp in sorted(people, key=lambda e: (e.first_name, e.last_name, e.employee_code)):
        reason = _employee_problem(emp, on_record, claims, work_date)
        shown = punches.get(emp.id)
        record = day_records.get(emp.id)
        existing = claims.get(emp.id)
        span = None
        if shown and shown["first"] and shown["last"]:
            span = (shown["last"].hour * 60 + shown["last"].minute) - (shown["first"].hour * 60 + shown["first"].minute)
        rows.append(
            {
                **employee_json(emp),
                "punchCount": shown["n"] if shown else 0,
                "firstPunch": _hhmm(shown["first"]) if shown else (_hhmm(record.first_punch) if record else None),
                "lastPunch": _hhmm(shown["last"]) if shown else (_hhmm(record.last_punch) if record else None),
                "spanMinutes": span,
                "attendanceStatus": record.status if record else None,
                "eligible": reason is None and message is None,
                "reason": reason or message,
                "claim": (
                    {"id": existing.id, "status": existing.status, "shifts": float(existing.shifts)}
                    if existing
                    else None
                ),
            }
        )
    body["employees"] = rows
    body["counts"] = {
        "worked": sum(1 for e in people if e.id in on_record),
        "eligible": sum(1 for r in rows if r["eligible"]),
    }
    return Response(body)


# ─────────────────────────── the Department Head's decision ───────────────────────────


def decide_claim(claim_id: int, role: str, decision: str, *, actor: str, comment: str | None = None):
    """Apply one approve / reject decision by `role` and, on the final approval, add the shifts to the balance.

    The claim row is locked for the whole decision, so two clicks (or two Department Heads) cannot both finish it: the
    second one finds it already decided and is refused by the engine. Returns (claim, outcome); raises
    approval.ApprovalError when the pipeline does not allow the decision. The employee's in-app notice is written here;
    the WhatsApp message goes after the transaction has committed."""
    with transaction.atomic():
        claim = (
            HolidayWorkClaim.objects.select_for_update(of=("self",))
            .select_related("employee__department", "employee__designation", "employee__branch")
            .get(pk=claim_id)
        )
        outcome = approval.decide(WORKFLOW, claim, role, decision, actor=actor, comment=comment)
        claim.status = outcome.status
        claim.reviewed_by = actor
        claim.reviewed_at = timezone.now()
        if comment:
            claim.review_comment = comment
        claim.save()
        if outcome.final:
            credit_balance(claim, actor)
        what = f"holiday-work compensation claim for {date_text(claim.work_date)}"
        tail = f" and {shifts_text(claim.shifts)} shift was added to your compensation balance" if outcome.final else ""
        Notification.objects.create(
            employee=claim.employee,
            type="compensation",
            message=approval.notice_for(what, outcome, tail),
        )
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            WORKFLOW,
            claim,
            decision,
            approver=actor,
            role=approval.LEGACY_ROLE[role],
            comment=claim.review_comment,
        )
    return claim, outcome


def credit_balance(claim: HolidayWorkClaim, actor: str) -> CompensationLedger:
    """The ledger credit for an approved claim: one row, once (a claim that already has its credit gets no second one)."""
    entry, _ = CompensationLedger.objects.get_or_create(
        claim=claim,
        entry_type=CompensationLedger.ENTRY_CREDIT,
        defaults={
            "employee": claim.employee,
            "shifts": claim.shifts,
            "date": claim.work_date,
            "source": "holiday_work",
            "note": f"Holiday / Sunday work on {claim.work_date.isoformat()}",
            "created_by": actor,
        },
    )
    return entry
