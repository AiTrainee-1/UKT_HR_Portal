"""
Casual Leave (CL) Module
========================
Paid leave, staff-only, one per calendar month, eligibility after 6 months of
service. Fully independent of LeaveRequest / permissions -its own table and
its own approval flow (HR directly, or Department Head from the mobile app,
configurable per-manager in User Management via can_approve_casual_leave).

Attendance integration:
  approved → AttendanceDayRecord for that date = Present, 1.00 shift (paid)
  rejected → AttendanceDayRecord for that date = Leave
Both are written as source="manual" so payroll treats them as authoritative.

Half-day CL (owner 2026-10-31): the month's one CL may instead be two half-days (first / second half of the shift) on any
dates of that month. A half is never written as a manual day: the attendance engine pays the CL half (0.50) and counts the
other half by the punches (attendance_final._apply_half_casual_leave), so a decision only recomputes the day.
"""

import calendar
from datetime import date as date_type, datetime, timedelta
from decimal import Decimal

from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, whatsapp_approvals
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name
from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import AttendanceDayRecord, CasualLeaveRequest, Employee
from .request_window import enforce_employee_date, request_window

ELIGIBILITY_MONTHS = 6


# ── Helpers ────────────────────────────────────────────────────────────────

def _parse_join_date(raw) -> date_type | None:
    if not raw:
        return None
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def _service_months(emp: Employee, today: date_type | None = None) -> int | None:
    """Completed months of service, or None when join date is unknown."""
    today = today or ist_today()
    joined = _parse_join_date(emp.join_date)
    if joined is None:
        return None
    months = (today.year - joined.year) * 12 + (today.month - joined.month)
    if today.day < joined.day:
        months -= 1
    return max(0, months)


def _months_between(joined: date_type, on: date_type) -> int:
    """Completed months from `joined` to `on` (the same count as _service_months, for any date)."""
    months = (on.year - joined.year) * 12 + (on.month - joined.month)
    if on.day < joined.day:
        months -= 1
    return max(0, months)


def eligible_from(joined: date_type) -> date_type:
    """The first day on which `joined` counts ELIGIBILITY_MONTHS completed months of service. Joining on the 31st lands
    on a shorter month's end, where the month count is still one short, so move forward a day until it is not."""
    total = joined.month - 1 + ELIGIBILITY_MONTHS
    year, month = joined.year + total // 12, total % 12 + 1
    day = min(joined.day, calendar.monthrange(year, month)[1])
    on = date_type(year, month, day)
    while _months_between(joined, on) < ELIGIBILITY_MONTHS:
        on += timedelta(days=1)
    return on


def board_reference_date(year: int, month: int, today: date_type) -> date_type:
    """The day the Casual Leave board judges service length on. This month: today, which is the very rule a submission is
    checked with (check_cl_eligibility), so the board never promises what Submit would refuse. A past month: its last day
    (who had qualified by then). A future month: its 15th, as the board always did."""
    if (year, month) == (today.year, today.month):
        return today
    month_end = date_type(year, month, calendar.monthrange(year, month)[1])
    return month_end if month_end < today else date_type(year, month, 15)


def _cl_used_in_month(emp_id: int, year: int, month: int, exclude_id: int | None = None) -> bool:
    qs = CasualLeaveRequest.objects.filter(
        employee_id=emp_id, date__year=year, date__month=month,
        status__in=["pending", "approved"],
    )
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    return qs.exists()


# The month's one Casual Leave is EITHER one full day OR two half-days (first / second half of the shift) on any dates of
# that month (owner 2026-10-31). Pending and approved requests both count; a rejected one frees its part again.
FULL = CasualLeaveRequest.PORTION_FULL
FIRST_HALF = CasualLeaveRequest.PORTION_FIRST_HALF
SECOND_HALF = CasualLeaveRequest.PORTION_SECOND_HALF
PORTIONS = (FULL, FIRST_HALF, SECOND_HALF)
PORTION_LABEL = {FULL: "Full day", FIRST_HALF: "Half day (first half)", SECOND_HALF: "Half day (second half)"}
PORTION_DAYS = {FULL: Decimal("1"), FIRST_HALF: Decimal("0.5"), SECOND_HALF: Decimal("0.5")}
LEFT_FULL, LEFT_ONE_HALF, LEFT_NOTHING = "full", "one_half", "nothing"
USED_UP = "Casual Leave already used this month (limit: 1 per month)"
BOTH_HALVES_USED = "Both half-days of this month's Casual Leave are already used (limit: 1 day per month)"
HALF_ALREADY_USED = (
    "Half a day of this month's Casual Leave is already used, so only the other half-day is left. "
    "Choose First half or Second half."
)


def portion_of(cl: CasualLeaveRequest) -> str:
    return cl.portion if cl.portion in PORTIONS else FULL


def days_number(value) -> int | float:
    """1 -> 1, 1.5 -> 1.5: a whole count stays a whole number for older readers."""
    value = Decimal(str(value))
    return int(value) if value == value.to_integral_value() else float(value)


def month_cl_state(rows) -> dict:
    """What the month's pending/approved Casual Leave rows leave over: "full", "one_half" or "nothing"."""
    full = next((r for r in rows if portion_of(r) == FULL), None)
    halves = [r for r in rows if portion_of(r) != FULL]
    if full is not None or len(halves) >= 2:
        left = LEFT_NOTHING
    else:
        left = LEFT_ONE_HALF if halves else LEFT_FULL
    return {"left": left, "full": full, "halves": halves}


def _month_rows(emp_id: int, year: int, month: int) -> list:
    return list(
        CasualLeaveRequest.objects.filter(
            employee_id=emp_id, date__year=year, date__month=month, status__in=["pending", "approved"],
        ).order_by("date", "id")
    )


def _half_word(portion: str) -> str:
    return "first" if portion == FIRST_HALF else "second"


def check_cl_eligibility(
    emp: Employee, for_date: date_type, portion: str | None = None
) -> tuple[bool, str | None]:
    """(eligible, reason_if_not). Applies all the CL business rules. Without a `portion` it answers "is anything of the
    month's Casual Leave left?"; with one, "may this employee ask for this part of `for_date`?"."""
    if emp.employment_type != "staff":
        return False, "Casual Leave is available only for staff employees"
    if emp.status != "active":
        return False, "Employee is not active"
    months = _service_months(emp)
    if months is None:
        return False, "Join date not set -contact HR"
    if months < ELIGIBILITY_MONTHS:
        return False, f"Eligible after {ELIGIBILITY_MONTHS} months of service (currently {months})"
    state = month_cl_state(_month_rows(emp.id, for_date.year, for_date.month))
    if state["full"] is not None:
        return False, USED_UP
    if state["left"] == LEFT_NOTHING:
        return False, BOTH_HALVES_USED
    if portion == FULL and state["left"] == LEFT_ONE_HALF:
        return False, HALF_ALREADY_USED
    if portion in (FIRST_HALF, SECOND_HALF) and any(
        r.date == for_date and portion_of(r) == portion for r in state["halves"]
    ):
        return False, (
            f"The {_half_word(portion)} half of {for_date.strftime('%d %b %Y')} is already asked for as Casual Leave. "
            "Choose the other half or another date."
        )
    return True, None


WORKFLOW = "casual_leave"


def _cl_dict(r: CasualLeaveRequest, cfg: approval.Config | None = None) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "departmentId": emp.department_id,
        "branchId": emp.branch_id,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "employmentType": emp.employment_type,
        "date": str(r.date),
        # added 2026-10-31: "full" | "first_half" | "second_half", its words, and the days it counts (1 or 0.5)
        "portion": portion_of(r),
        "portionLabel": PORTION_LABEL[portion_of(r)],
        "days": days_number(PORTION_DAYS[portion_of(r)]),
        "reason": r.reason,
        "status": r.status,
        "reviewedBy": r.reviewed_by,
        "reviewerRole": r.reviewer_role,
        "reviewComment": r.review_comment,
        "reviewedAt": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
        "approval": approval.progress(WORKFLOW, r, cfg),
    }


def _refresh_day_for_half_cl(cl: CasualLeaveRequest) -> None:
    """A half-day CL is never written as a fixed (manual) day: its OTHER half counts by the punches, which may not exist
    yet. The attendance engine adds the paid half itself (attendance_final._apply_half_casual_leave) whenever the day is
    computed, so this only recomputes a day that has already begun; a later day is computed when it comes. A day HR fixed
    by hand stays as HR left it, except one written by an earlier Casual Leave decision for the same date."""
    from .attendance_final import compute_range_records

    if cl.date > ist_today():
        return
    record = AttendanceDayRecord.objects.filter(employee=cl.employee, date=cl.date).first()
    if record is not None and record.source == "manual":
        if not (record.override_note or "").startswith("Casual Leave"):
            return
        record.source = "auto"
        record.save(update_fields=["source"])
    compute_range_records(cl.employee, cl.date, cl.date)


def _write_attendance_for_cl(cl: CasualLeaveRequest, reviewer: str) -> None:
    """Write the final attendance verdict for the CL date (source=manual wins). A half-day CL (approved or rejected)
    only recomputes the day instead: see _refresh_day_for_half_cl."""
    from .attendance_final import compute_day_record

    if portion_of(cl) != FULL:
        _refresh_day_for_half_cl(cl)
        return
    record = AttendanceDayRecord.objects.filter(employee=cl.employee, date=cl.date).first()
    if record is None:
        record = compute_day_record(cl.employee, cl.date)

    if cl.status == CasualLeaveRequest.STATUS_APPROVED:
        record.status = "present"
        record.shifts_earned = Decimal("1.00")
        record.is_late = False
        record.early_leave = False  # a paid day carries no late/early-out mark -this row is never recomputed
        record.late_reason = None
        record.is_half_shift = False
        record.override_note = "Casual Leave (paid) -approved"
    else:  # rejected
        record.status = "on_leave"
        record.shifts_earned = Decimal("0")
        record.is_late = False
        record.early_leave = False
        record.late_reason = None
        record.is_half_shift = False
        record.override_note = "Casual Leave rejected -marked as leave"
    record.source = "manual"
    record.override_by = reviewer
    record.save()


def resolve_casual_leave(
    cl: CasualLeaveRequest, role: str, decision: str, reviewer: str, comment: str | None
) -> approval.Outcome:
    """One decision by `role` ('hod' or 'hr') on a Casual Leave request, under the "casual_leave" pipeline
    (approval_workflow.py). Raises approval.ApprovalError when that role may not decide it now.

    An intermediate approval only passes the request on. The FINAL approval marks the day present (paid) and a
    rejection marks it as leave, both as source=manual so payroll treats them as authoritative."""
    outcome = approval.decide(WORKFLOW, cl, role, decision, actor=reviewer, comment=comment)
    if outcome.final or outcome.rejected:
        cl.reviewer_role = approval.LEGACY_ROLE[role]
    cl.reviewed_by = reviewer
    cl.review_comment = comment
    cl.reviewed_at = timezone.now()
    cl.status = outcome.status
    cl.save()
    what = f"Casual Leave request for {cl.date.isoformat()}"
    if portion_of(cl) != FULL:
        what += f" ({_half_word(portion_of(cl))} half)"
    if outcome.final or outcome.rejected:
        _write_attendance_for_cl(cl, reviewer)
    approval.stage_notice(cl.employee, "casual_leave", approval.notice_for(what, outcome), outcome)
    if outcome.kind == "advanced" and approval.HOD in outcome.waiting and role != approval.HOD:
        approval.notify_hod_of_request(WORKFLOW, cl.employee, "Casual Leave request")
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            "casual_leave", cl, decision, approver=reviewer, role=approval.LEGACY_ROLE[role], comment=comment
        )
    return outcome


def apply_cl_decision(cl: CasualLeaveRequest, status: str, reviewer: str,
                      reviewer_role: str, comment: str | None) -> CasualLeaveRequest:
    """Shared by HR and Department Head endpoints (kept under its old name and signature)."""
    role = approval.HR if reviewer_role == "hr" else approval.HOD
    resolve_casual_leave(cl, role, status, reviewer, comment)
    return cl


# ── List / submit ───────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def casual_leaves(request: Request) -> Response:
    if request.method == "GET":
        qs = CasualLeaveRequest.objects.select_related(
            "employee__department", "employee__designation", "employee__branch"
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        # Employees see only their own CLs
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        else:
            if emp_id := request.query_params.get("employeeId"):
                qs = qs.filter(employee_id=emp_id)
            if code := request.query_params.get("employeeCode"):
                qs = qs.filter(employee__employee_code__iexact=code.strip())
        if status_filter := request.query_params.get("status"):
            qs = qs.filter(status=status_filter)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=month)
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=year)
        cfg = approval.get_config(WORKFLOW)
        return Response([_cl_dict(r, cfg) for r in qs[:300]])

    # POST -submit a CL request (mobile app or HR on behalf)
    data = request.data
    emp_id = None
    if code := data.get("employeeCode"):
        found = Employee.objects.filter(employee_code__iexact=str(code).strip()).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId")

    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        # Employees can only submit for themselves
        if emp_id and str(emp_id) != str(token_emp_id):
            return Response({"error": "You can only apply Casual Leave for yourself"}, status=403)
        emp_id = token_emp_id

    if not emp_id or not data.get("date"):
        return Response({"error": "employeeId and date are required"}, status=400)

    emp = Employee.objects.filter(id=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    try:
        cl_date = date_type.fromisoformat(str(data["date"]))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)

    # Full day (the default: older apps send nothing) or one half of the shift.
    portion = str(data.get("portion") or FULL).strip().lower()
    if portion not in PORTIONS:
        return Response({"error": "Choose Full day, First half or Second half"}, status=400)

    eligible, reason = check_cl_eligibility(emp, cl_date, portion)
    if not eligible:
        return Response({"error": reason}, status=400)

    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    # An employee may only request a date in the current month (plus last month on its 1st and 2nd); HR is never limited.
    if refused := enforce_employee_date(request, cl_date.isoformat()):
        return refused
    cl = CasualLeaveRequest.objects.create(
        employee=emp,
        date=cl_date,
        portion=portion,
        reason=data.get("reason"),
        approval_trail=[],
    )
    approval.notify_new_request(WORKFLOW, emp, "Casual Leave request")
    return Response(_cl_dict(cl), status=201)


# ── HR decision ─────────────────────────────────────────────────────────────

@api_view(["PATCH", "DELETE"])
@require_hr
def casual_leave_detail(request: Request, pk: int) -> Response:
    cl = CasualLeaveRequest.objects.select_related("employee").filter(pk=pk).first()
    if not cl:
        return Response({"error": "Casual leave request not found"}, status=404)

    if request.method == "DELETE":
        cl.delete()
        return Response({"ok": True})

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    reviewer = get_hr_display_name(request)
    try:
        resolve_casual_leave(cl, approval.HR, status_val, reviewer, request.data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    return Response(_cl_dict(cl))


# ── Eligibility board (HR page) ─────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def casual_leave_eligibility(request: Request) -> Response:
    """Every active employee's Casual Leave standing for a month: who has taken (or asked for) it, who still can, and for
    everyone who cannot, why. Staff only by default; `?scope=all` adds production employees (never eligible, with that as
    the reason) so the HR page can name them too. Fields are only ever added to a row: older readers keep working."""
    today = ist_today()
    try:
        month = int(request.query_params.get("month", today.month))
        year = int(request.query_params.get("year", today.year))
        month_start = date_type(year, month, 1)
    except (TypeError, ValueError):
        return Response({"error": "month and year must be a valid month"}, status=400)
    month_end = date_type(year, month, calendar.monthrange(year, month)[1])
    check_date = board_reference_date(year, month, today)
    cfg = approval.get_config(WORKFLOW)

    used_map: dict[int, CasualLeaveRequest] = {}
    month_rows: dict[int, list] = {}
    for r in scope_to_branch(
        CasualLeaveRequest.objects, request, field="employee__branch_id"
    ).filter(
        date__year=year, date__month=month, status__in=["pending", "approved"]
    ).select_related("employee").order_by("-id"):
        month_rows.setdefault(r.employee_id, []).append(r)
        # one a month is the rule, but if data ever holds two, show the approved one
        held = used_map.get(r.employee_id)
        if held is None or (held.status != "approved" and r.status == "approved"):
            used_map[r.employee_id] = r

    employees = scope_to_branch(Employee.objects, request).filter(status="active")
    if request.query_params.get("scope") != "all":
        employees = employees.filter(employment_type="staff")
    employees = list(employees.select_related("department", "designation", "branch"))

    history = {
        row["employee_id"]: row
        for row in CasualLeaveRequest.objects.filter(
            employee_id__in=[e.id for e in employees], status="approved", date__lte=month_end
        )
        .values("employee_id")
        .annotate(
            last=Max("date"),
            this_year=Count("id", filter=Q(date__year=year)),
            halves_this_year=Count("id", filter=Q(date__year=year) & ~Q(portion=FULL)),
        )
    }

    rows = []
    for emp in employees:
        joined = _parse_join_date(emp.join_date)
        months = _months_between(joined, check_date) if joined else None
        is_staff = emp.employment_type == "staff"
        service_ok = months is not None and months >= ELIGIBILITY_MONTHS
        used = used_map.get(emp.id)
        state = month_cl_state(month_rows.get(emp.id, []))
        if not is_staff:
            code, reason = "not_staff", "Casual Leave is available only for staff employees"
        elif months is None:
            code, reason = "no_join_date", "Join date not set"
        elif not service_ok:
            code, reason = "under_service", f"{months}/{ELIGIBILITY_MONTHS} months of service"
        elif state["left"] == LEFT_NOTHING:
            code, reason = "used_this_month", USED_UP if state["full"] is not None else BOTH_HALVES_USED
        else:
            # nothing used yet, or one half-day used and the other still free (still eligible: for that half)
            code, reason = None, None
        past = history.get(emp.id)
        approved_days = (
            Decimal(past["this_year"]) - Decimal(past["halves_this_year"]) / 2 if past else Decimal("0")
        )
        rows.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
            "joinDate": emp.join_date,
            "serviceMonths": months,
            "eligible": code is None,
            "reason": reason,
            "usedThisMonth": bool(used),
            "usedStatus": used.status if used else None,
            "usedDate": str(used.date) if used else None,
            # added for the redesigned page
            "employmentType": emp.employment_type,
            "departmentId": emp.department_id,
            "branchId": emp.branch_id,
            "branch": emp.branch.name if emp.branch_id and emp.branch else None,
            "reasonCode": code,
            "eligibleFrom": str(eligible_from(joined)) if joined and is_staff else None,
            "lastClDate": str(past["last"]) if past else None,
            # in days: a half-day counts 0.5
            "approvedThisYear": days_number(approved_days),
            "usedRequestId": used.id if used else None,
            "usedReviewedBy": used.reviewed_by if used else None,
            "usedReviewerRole": used.reviewer_role if used else None,
            "usedApproval": approval.progress(WORKFLOW, used, cfg) if used else None,
            # added 2026-10-31 (half-day CL): what of the month's CL is left and the parts already asked for
            "left": state["left"],
            "usedPortion": portion_of(used) if used else None,
            "usedParts": [_part_json(r) for r in sorted(month_rows.get(emp.id, []), key=lambda r: (r.date, r.id))],
        })

    rows.sort(key=lambda r: (not r["eligible"], r["employeeName"]))
    return Response({
        "month": month,
        "year": year,
        "eligibilityMonths": ELIGIBILITY_MONTHS,
        "referenceDate": str(check_date),
        "monthStart": str(month_start),
        "monthEnd": str(month_end),
        "counts": {
            "eligible": sum(1 for r in rows if r["eligible"]),
            "notEligible": sum(1 for r in rows if not r["eligible"]),
            "usedThisMonth": sum(1 for r in rows if r["usedThisMonth"]),
        },
        "employees": rows,
    })


# ── Self-service eligibility (mobile / web employee apps) ────────────────────
# casual_leave_eligibility() above is HR-only (@require_hr, lists every staff
# employee) -an employee token 403s on it. This is the single-employee
# equivalent, self-scoped, reusing the same check_cl_eligibility() rule so
# the two never disagree. Also reports the yearly usage/entitlement (12/yr)
# an employee actually wants to see, which the HR board doesn't compute.
CL_YEARLY_ENTITLEMENT = 12


@api_view(["GET"])
@require_auth
def my_casual_leave_eligibility(request: Request) -> Response:
    token_emp_id = get_token_employee_id(request)
    emp_id = token_emp_id or request.query_params.get("employeeId")
    if not emp_id:
        return Response({"error": "employeeId required"}, status=400)
    emp = Employee.objects.filter(pk=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    today = ist_today()
    eligible, reason = check_cl_eligibility(emp, today)

    try:
        year = int(request.query_params.get("year") or today.year)
    except (TypeError, ValueError):
        return Response({"error": "year must be a number"}, status=400)
    year_rows = list(CasualLeaveRequest.objects.filter(employee_id=emp.id, date__year=year).only("portion", "status"))
    used = sum((PORTION_DAYS[portion_of(r)] for r in year_rows if r.status == "approved"), Decimal("0"))
    waiting = sum((PORTION_DAYS[portion_of(r)] for r in year_rows if r.status == "pending"), Decimal("0"))

    return Response({
        "eligible": eligible,
        "reason": reason,
        "year": year,
        "yearlyEntitlement": CL_YEARLY_ENTITLEMENT,
        # in days: a half-day counts 0.5 (a whole number stays a whole number)
        "usedThisYear": days_number(used),
        "remainingThisYear": days_number(max(Decimal("0"), CL_YEARLY_ENTITLEMENT - used)),
        "months": _request_window_months(emp),
        # added 2026-10-31 (half-day CL)
        "waitingThisYear": days_number(waiting),
        "portions": [{"value": p, "label": PORTION_LABEL[p]} for p in PORTIONS],
        "shift": _shift_halves_json(emp, today),
    })


def _part_json(r: CasualLeaveRequest) -> dict:
    return {
        "id": r.id, "date": str(r.date), "portion": portion_of(r), "portionLabel": PORTION_LABEL[portion_of(r)],
        "status": r.status,
    }


def _request_window_months(emp: Employee) -> list[dict]:
    """Eligibility for each month an employee may request a date in right now (request_window.py): last month ONLY while
    its grace days are open (the 1st and 2nd), then this month. Casual Leave is one per calendar month of the requested
    DATE, so on the 1st/2nd someone who has used this month's may still be eligible for last month's.

    Added 2026-10-31 (half-day CL), per month: `left` ("full" | "one_half" | "nothing"; "nothing" also when the employee
    may not take CL at all - `eligible`/`reason` say why), `usedParts` (the pending/approved requests of the month) and
    `usedHalves` (which halves of which dates are taken, so the app can disable them)."""
    window = request_window()
    this_month = (window.max.replace(day=1), window.current_month)
    open_months = [(window.min, window.previous_month), this_month] if window.grace_open else [this_month]
    months = []
    for first, label in open_months:
        ok, why = check_cl_eligibility(emp, first)
        rows = _month_rows(emp.id, first.year, first.month)
        state = month_cl_state(rows)
        months.append({
            "month": f"{first.year:04d}-{first.month:02d}", "label": label, "eligible": ok, "reason": why,
            "left": state["left"] if ok else LEFT_NOTHING,
            "usedParts": [_part_json(r) for r in rows],
            "usedHalves": [{"date": str(r.date), "portion": portion_of(r)} for r in state["halves"]],
        })
    return months


def _clock(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _shift_halves_json(emp: Employee, on: date_type) -> dict | None:
    """The employee's shift on `on` split into the two halves a half-day CL can cover, for the app to show what each
    choice means in clock time. The first half ends at the shift's own first-half end (its lunch start) when HR set one,
    else at the middle of the shift; the second half starts after lunch. None without a shift."""
    from .shift_engine import _get_shift_for_date

    shift = _get_shift_for_date(emp, on)
    if shift is None or shift.start_time is None or shift.end_time is None:
        return None
    start = shift.start_time.hour * 60 + shift.start_time.minute
    end = shift.end_time.hour * 60 + shift.end_time.minute
    length = (end - start) % (24 * 60) or 24 * 60
    if shift.first_half_end is not None:
        first_end = shift.first_half_end.hour * 60 + shift.first_half_end.minute
        second_start = first_end + max(0, int(shift.lunch_duration_minutes or 0))
    else:
        first_end = second_start = start + length // 2
    return {
        "name": shift.name,
        "start": _clock(start),
        "end": _clock(end),
        "firstHalfEnd": _clock(first_end),
        "secondHalfStart": _clock(second_start),
    }
