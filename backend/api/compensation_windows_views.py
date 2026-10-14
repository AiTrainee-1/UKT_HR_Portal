"""
Company-announced late-in / early-out windows (Compensation Leave, part A).

HR announces, for a date, that ALL staff may arrive up to a time (Late-in) or may leave from a time (Early-out). On that
date only, the regular shift start / end AND grace do not apply for the announced edge and late-in / early-out detection
does not run for it (the attendance engine does that; it marks the day `compensation_kind` = window_late_in |
window_early_out when the employee's punch used the window). An announcement covers every active staff member unless it is
scoped to a branch, a department or a list of employees. Production employees are never covered.

    GET    /api/compensation/windows          the announcements, newest first (?kind=late_in|early_out|day|all &month= &year=
                                              &date= &upcoming=1 &limit=)
    POST   /api/compensation/windows          {date, kind: "late_in"|"early_out", time: "HH:MM", reason,
                                               branchId?, departmentId?, employeeIds?}
    DELETE /api/compensation/windows/<id>     remove an announcement for a FUTURE date

Rules, every refusal a plain sentence:

  * changes need the master switch (Settings -> Payroll -> OT / Compensation) and the Windows switch (Settings ->
    Compensation); reading never needs them;
  * `date` is today or a later date, at most MAX_DAYS_AHEAD days ahead (today is allowed: HR often announces in the morning);
  * `time` is required; `reason` is required (what happened: rain, a transport strike ...);
  * ONE window of a kind can apply to a person on a date: an announcement that would cover anybody an earlier one of the
    same kind and date already covers is refused (so the engine never has to choose between two times);
  * at least one active staff member must be covered;
  * a branch-scoped HR user announces for their own branch only (the announcement is stamped with it) and cannot remove a
    company-wide one; an unscoped HR user can announce for any branch or for the whole company;
  * only an announcement for a FUTURE date can be removed (today's has already been acted on), exactly like the legacy
    Compensation Days.

The legacy /api/compensation/leave-days routes are untouched: they keep creating and listing the old "day exemption" kind.
Both routes read and write the same table, so rows made here also appear in the legacy list (with no `kind` field there).
"""

from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .compensation_shared import date_text, parse_date, parse_int, parse_time, switches
from .compensation_views import require_compensation_features_for_changes
from .models import Branch, CompensationConfig, CompensationDayAnnouncement, Department, Employee

KIND_LABEL = {
    CompensationDayAnnouncement.KIND_LATE_IN: "Late-in",
    CompensationDayAnnouncement.KIND_EARLY_OUT: "Early-out",
    CompensationDayAnnouncement.KIND_DAY: "Day exemption",
}
WINDOW_KINDS = (CompensationDayAnnouncement.KIND_LATE_IN, CompensationDayAnnouncement.KIND_EARLY_OUT)
MAX_DAYS_AHEAD = 180
MAX_REASON_LENGTH = 300
MAX_WINDOW_EMPLOYEES = 500
LIST_DEFAULT_LIMIT = 200
LIST_MAX_LIMIT = 500

FEATURE_OFF_MESSAGE = (
    "Company-announced late-in / early-out windows are switched off in Settings > Compensation, so a window can't be "
    "announced or removed right now."
)


def _bad(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def window_time(ann: CompensationDayAnnouncement):
    """The time an announcement is about: late-in and early-out store it in `allowed_time` (an early-out ALSO in
    `leave_until_time`, the column the engine already reads as the evening cut-off); a legacy day has only the latter."""
    return ann.allowed_time or ann.leave_until_time


def covered_staff_ids(branch_id, department_id, employee_ids) -> set[int]:
    """The active staff an announcement with this scope covers (the engine's rule: a listed employee is covered whatever
    their branch; with no list, the branch and department must match where they are set)."""
    qs = Employee.objects.filter(employment_type="staff", status="active")
    if employee_ids:
        qs = qs.filter(pk__in=list(employee_ids))
    else:
        if branch_id:
            qs = qs.filter(branch_id=branch_id)
        if department_id:
            qs = qs.filter(department_id=department_id)
    return set(qs.values_list("pk", flat=True))


def _coverage_table(request: Request) -> dict[tuple, int]:
    """{(branch_id, department_id): active staff} in the caller's scope: one query for the whole list's `covers` figures."""
    rows = (
        scope_to_branch(Employee.objects.filter(employment_type="staff", status="active"), request)
        .values("branch_id", "department_id")
        .annotate(n=Count("id"))
    )
    return {(r["branch_id"], r["department_id"]): r["n"] for r in rows}


def visible_announcements(qs, scope_branch):
    """The announcements a branch-scoped HR user may see: their branch's, the company-wide ones (they cover their staff
    too) and those that list one of their employees. Unscoped (None) sees everything."""
    if scope_branch is None:
        return qs
    return qs.filter(
        Q(branch_id=scope_branch)
        | Q(branch__isnull=True, employees__isnull=True)
        | Q(employees__branch_id=scope_branch)
    ).distinct()


def covers_count(ann: CompensationDayAnnouncement, table: dict) -> int:
    """How many active staff an announcement covers: its listed employees, or the staff of its branch / department
    (`table` is _coverage_table, so a whole list is counted without a query per row; prefetch `employees`)."""
    listed = list(ann.employees.all())
    if listed:
        return sum(1 for e in listed if e.employment_type == "staff" and e.status == "active")
    return sum(
        n
        for (b, d), n in table.items()
        if (ann.branch_id is None or b == ann.branch_id) and (ann.department_id is None or d == ann.department_id)
    )


def coverage_table(request: Request) -> dict[tuple, int]:
    """{(branch_id, department_id): active staff} in the caller's scope (one query)."""
    return _coverage_table(request)


def window_json(ann: CompensationDayAnnouncement, table: dict, today, scope_branch=None) -> dict:
    """One announcement. `table` is _coverage_table (the staff in the caller's scope per branch / department)."""
    listed = list(ann.employees.all())
    covers = covers_count(ann, table)
    deletable = ann.date > today and ann.kind in WINDOW_KINDS
    if deletable and scope_branch is not None and ann.branch_id != scope_branch:
        deletable = bool(listed) and all(e.branch_id == scope_branch for e in listed)
    return {
        "id": ann.id,
        "date": ann.date.isoformat(),
        "kind": ann.kind,
        "kindLabel": KIND_LABEL.get(ann.kind, ann.kind),
        "time": _hhmm(window_time(ann)),
        "reason": ann.reason,
        "branchId": ann.branch_id,
        "branch": ann.branch.name if ann.branch_id and ann.branch else None,
        "departmentId": ann.department_id,
        "department": ann.department.name if ann.department_id and ann.department else None,
        "employeeIds": [e.id for e in listed],
        "employeeCount": len(listed),
        "covers": covers,
        "allStaff": not listed and ann.branch_id is None and ann.department_id is None,
        "announcedBy": ann.announced_by,
        "createdAt": ann.created_at.isoformat() if ann.created_at else None,
        "canDelete": deletable,
    }


def _enabled_block() -> dict:
    flags = switches()
    return {"master": flags["master"], "windows": flags["windows"], "canAnnounce": flags["windows"]}


# ─────────────────────────── list ───────────────────────────


def _list_windows(request: Request) -> Response:
    q = request.query_params
    today = ist_today()
    kind = (q.get("kind") or "windows").lower()
    if kind not in ("windows", "all", *KIND_LABEL):
        return _bad("kind must be late_in, early_out, day, windows (late-in and early-out) or all.")
    qs = CompensationDayAnnouncement.objects.select_related("branch", "department").prefetch_related("employees")
    if kind == "windows":
        qs = qs.filter(kind__in=WINDOW_KINDS)
    elif kind != "all":
        qs = qs.filter(kind=kind)
    scope = get_branch_scope(request)
    qs = visible_announcements(qs, scope)
    if q.get("date"):
        day = parse_date(q.get("date"))
        if day is None:
            return _bad("date must be a date (YYYY-MM-DD).")
        qs = qs.filter(date=day)
    if parse_int(q.get("year")) is not None:
        qs = qs.filter(date__year=parse_int(q.get("year")))
    if parse_int(q.get("month")) is not None:
        qs = qs.filter(date__month=parse_int(q.get("month")))
    if (q.get("upcoming") or "").lower() in ("1", "true", "yes"):
        qs = qs.filter(date__gte=today)
    limit = max(1, min(parse_int(q.get("limit")) or LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT))
    total = qs.count()
    rows = list(qs.order_by("-date", "-id")[:limit])
    table = _coverage_table(request)
    return Response(
        {
            "results": [window_json(a, table, today, scope) for a in rows],
            "count": total,
            "truncated": total > len(rows),
            "today": today.isoformat(),
            "enabled": _enabled_block(),
        }
    )


# ─────────────────────────── announce ───────────────────────────


def _scope_from_body(request: Request, data) -> tuple[dict | None, Response | None]:
    """(scope, None) with branch_id / department_id / employee_ids to store, or (None, the refusal)."""
    branch_scope = get_branch_scope(request)
    branch_id = parse_int(data.get("branchId"))
    department_id = parse_int(data.get("departmentId"))
    raw_ids = data.get("employeeIds")
    employee_ids: list[int] = []
    if raw_ids not in (None, []):
        if not isinstance(raw_ids, list):
            return None, _bad("employeeIds must be a list of employee ids.")
        if len(raw_ids) > MAX_WINDOW_EMPLOYEES:
            return None, _bad(
                f"Choose at most {MAX_WINDOW_EMPLOYEES} employees at once: pick a branch or department instead."
            )
        parsed = [parse_int(i) for i in raw_ids]
        if any(i is None for i in parsed):
            return None, _bad("employeeIds must be employee ids.")
        employee_ids = list(dict.fromkeys(parsed))
    if employee_ids and (branch_id or department_id):
        return None, _bad("Choose either a list of employees or a branch / department, not both.")

    if employee_ids:
        found = scope_to_branch(Employee.objects.filter(pk__in=employee_ids), request)
        staff = set(found.filter(employment_type="staff", status="active").values_list("pk", flat=True))
        missing = [i for i in employee_ids if i not in staff]
        if missing:
            return None, _bad(
                "Only active staff members in your branch can be listed: these ids are not (production employees, "
                f"inactive or unknown people): {', '.join(str(i) for i in missing[:10])}."
            )
        return {"branch_id": None, "department_id": None, "employee_ids": employee_ids}, None

    if branch_scope is not None:
        if branch_id not in (None, branch_scope):
            return None, _bad("You can only announce a window for your own branch.", 403)
        branch_id = branch_scope
    if branch_id is not None and not Branch.objects.filter(pk=branch_id).exists():
        return None, _bad("Branch not found.", 404)
    if department_id is not None:
        dept = Department.objects.filter(pk=department_id).first()
        if dept is None:
            return None, _bad("Department not found.", 404)
        if branch_id is not None and dept.branch_id not in (None, branch_id):
            return None, _bad(f"{dept.name} does not belong to that branch.")
    return {"branch_id": branch_id, "department_id": department_id, "employee_ids": []}, None


def _announce(request: Request) -> Response:
    if not CompensationConfig.get().windows_enabled:
        return Response({"error": FEATURE_OFF_MESSAGE, "code": "feature_disabled"}, status=403)
    data = request.data if isinstance(request.data, dict) else {}
    today = ist_today()

    day = parse_date(data.get("date"))
    if day is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    if day < today:
        return _bad("A window can only be announced for today or a later date.")
    if day > today + timedelta(days=MAX_DAYS_AHEAD):
        return _bad(f"A window can only be announced up to {MAX_DAYS_AHEAD} days ahead.")
    kind = data.get("kind")
    if kind not in WINDOW_KINDS:
        return _bad(
            "kind must be late_in (staff may arrive up to the time) or early_out (staff may leave from the time)."
        )
    if not data.get("time"):
        return _bad("time is required (HH:MM).")
    at = parse_time(data.get("time"))
    if at is None:
        return _bad("time must be a time like 10:30 (HH:MM).")
    reason = str(data.get("reason") or "").strip()
    if not reason:
        return _bad("Give a reason (what happened?): staff see it with the announcement.")
    if len(reason) > MAX_REASON_LENGTH:
        return _bad(f"The reason can be at most {MAX_REASON_LENGTH} characters.")
    scope, refusal = _scope_from_body(request, data)
    if refusal is not None:
        return refusal

    label = KIND_LABEL[kind].lower()
    with transaction.atomic():
        # The settings row is the mutex: two announcements made at the same moment are checked one after the other.
        CompensationConfig.objects.select_for_update().filter(pk=1).first()
        covered = covered_staff_ids(scope["branch_id"], scope["department_id"], scope["employee_ids"])
        if not covered:
            return _bad(
                "No active staff member is covered by that branch / department / list, so there is nobody to announce for."
            )
        # one window of a kind per person per date: a clash is refused, so the engine never has two times to choose from
        for other in CompensationDayAnnouncement.objects.filter(date=day, kind=kind).prefetch_related("employees"):
            overlap = covered & covered_staff_ids(
                other.branch_id, other.department_id, [e.id for e in other.employees.all()]
            )
            if overlap:
                return _bad(
                    f"A {label} window is already announced for {date_text(day)} ({_hhmm(window_time(other))}, by "
                    f"{other.announced_by or 'HR'}) and it covers {len(overlap)} of the same "
                    f"{'person' if len(overlap) == 1 else 'people'}. Only one {label} window can apply to a person on a "
                    "date: remove that one first (only a future date can be removed) or announce for different people."
                )
        ann = CompensationDayAnnouncement.objects.create(
            date=day,
            kind=kind,
            allowed_time=at,
            leave_until_time=at if kind == CompensationDayAnnouncement.KIND_EARLY_OUT else None,
            branch_id=scope["branch_id"],
            department_id=scope["department_id"],
            reason=reason,
            announced_by=get_hr_display_name(request),
        )
        if scope["employee_ids"]:
            ann.employees.set(scope["employee_ids"])
    log_action(
        request,
        "create",
        "compensation",
        record_id=ann.id,
        description=f"Announced {label} window for {day.isoformat()} at {_hhmm(at)} ({len(covered)} staff)",
        new_values={"date": day.isoformat(), "kind": kind, "time": _hhmm(at), "reason": reason},
    )
    ann = (
        CompensationDayAnnouncement.objects.select_related("branch", "department")
        .prefetch_related("employees")
        .get(pk=ann.pk)
    )
    return Response(window_json(ann, _coverage_table(request), today, get_branch_scope(request)), status=201)


@api_view(["GET", "POST"])
@require_hr
@require_compensation_features_for_changes
def compensation_windows(request: Request) -> Response:
    if request.method == "POST":
        return _announce(request)
    return _list_windows(request)


@api_view(["DELETE"])
@require_hr
@require_compensation_features_for_changes
def compensation_window_detail(request: Request, pk: int) -> Response:
    if not CompensationConfig.get().windows_enabled:
        return Response({"error": FEATURE_OFF_MESSAGE, "code": "feature_disabled"}, status=403)
    ann = (
        CompensationDayAnnouncement.objects.select_related("branch", "department")
        .prefetch_related("employees")
        .filter(pk=pk, kind__in=WINDOW_KINDS)
        .first()
    )
    if ann is None:
        return _bad("Window not found.", 404)
    today = ist_today()
    if ann.date <= today:
        return _bad("Cannot remove a window for today or a past date: it has already been acted on.")
    scope = get_branch_scope(request)
    if scope is not None:
        listed = list(ann.employees.all())
        own = ann.branch_id == scope or (bool(listed) and all(e.branch_id == scope for e in listed))
        if not own:
            return _bad(
                "This window belongs to the whole company or another branch: only its owner can remove it.", 403
            )
    snapshot = {"date": ann.date.isoformat(), "kind": ann.kind, "time": _hhmm(window_time(ann)), "reason": ann.reason}
    ann.delete()
    log_action(
        request,
        "delete",
        "compensation",
        record_id=pk,
        description=f"Removed {KIND_LABEL[snapshot['kind']].lower()} window for {snapshot['date']}",
        old_values=snapshot,
    )
    return Response(status=204)
