"""
Company-announced late-in / early-out windows (Compensation Leave, part A).

HR announces, for a date, that ALL staff may arrive up to a time (Late-in) or may leave from a time (Early-out). On that
date only, the regular shift start / end AND grace do not apply for the announced edge and late-in / early-out detection
does not run for it (the attendance engine does that; it marks the day `compensation_kind` = window_late_in |
window_early_out when the employee's punch used the window). An announcement covers every active staff member unless it is
scoped to a branch, a department or a list of employees. Production employees are never covered.

    GET    /api/compensation/windows          the announcements, newest first (?kind=late_in|early_out|day|all &month= &year=
                                              &date= &upcoming=1 &limit= ; 2026-11-19: &departmentId= &branchId= &q=
                                              &status=upcoming|past|all &page= &pageSize=)
    POST   /api/compensation/windows          {date, kind: "late_in"|"early_out", time: "HH:MM", reason,
                                               branchId?, departmentId?, employeeIds?}
    DELETE /api/compensation/windows/<id>     remove an announcement, for ANY date (2026-11-19)

Rules, every refusal a plain sentence:

  * changes need the master switch (Settings -> Payroll -> OT / Compensation) and the Windows switch (Settings ->
    Compensation); reading never needs them;
  * `date` is any day of the CURRENT month, past or upcoming, the 1st to the last (owner 2026-11-13: "announce leave for
    any past or upcoming date within the current month, but not for dates belonging to previous months"). Once the next
    month begins the previous one is closed; a later month opens on its own 1st. A month whose payroll is finalized
    (Payroll Done) is closed too;
  * a window for today or a past day re-derives the stored attendance of the staff it covers for that day straight away,
    so their Late / Early-out marks follow it (a day HR set by hand is never recomputed, as everywhere else);
  * `time` is required; `reason` is required (what happened: rain, a transport strike ...);
  * ONE window of a kind can apply to a person on a date: an announcement that would cover anybody an earlier one of the
    same kind and date already covers is refused (so the engine never has to choose between two times);
  * at least one active staff member must be covered;
  * a branch-scoped HR user announces for their own branch only (the announcement is stamped with it) and cannot remove a
    company-wide one; an unscoped HR user can announce for any branch or for the whole company;
  * removing (owner brief 2026-11-19: "delete existing announcements"): an announcement of ANY date can be removed, unless
    its month's payroll is finalized (Payroll Done, payroll_month_workflow.is_locked): then a 409 says why, whatever the
    date (that month is paid and closed). Removing one for today or a past day re-derives the stored attendance of the
    staff it covered for that day at once (refresh_attendance, the same path an announcement takes; a day HR set by hand
    is never recomputed), so the Late / Early-out marks it lifted come back. Every covered staff member is told on their
    phone that it was cancelled (compensation_notices.announcement_cancelled), and the removal is audited.

The list (GET) filters, all optional and combined with AND (the old parameters keep their meaning):
  * departmentId: the announcements that cover somebody of that department by their scope: the department's own ones,
    the company-wide ones, the branch-wide ones of the department's branch, and those that list an employee of it;
  * branchId: the branch's own ones (incl. its departments'), the company-wide ones and those that list an employee of it;
  * q: text in the reason or the name of who announced it (case-insensitive);
  * status: upcoming (today and later), past (before today) or all (the default); `upcoming=1` still means upcoming;
  * page / pageSize: only when either is sent, the answer is that page of the list (pageSize 1 to 200, default 25) and
    also carries `total`, `page`, `pageSize`; without them the old `limit` (default 200, at most 500) applies as before.
`canDelete` on each row: a late-in / early-out window or an older Compensation Day (kind "day"), of any date, the caller
may edit Compensation, its month is not finalized, and (for a branch-scoped user) it is their own branch's;
`deleteBlockedReason` says why not (null when it can). DELETE /api/compensation/windows/<id> removes a "day" row the same
way as a window (payroll-lock check, attendance re-derived for today / a past day, covered staff told, audited).

The legacy /api/compensation/leave-days routes are untouched: they keep creating and listing the old "day exemption" kind.
Both routes read and write the same table, so rows made here also appear in the legacy list (with no `kind` field there).
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

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
from .compensation_views import can_edit_compensation, require_compensation_features_for_changes
from .models import (
    AttendanceDayRecord,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    Department,
    Employee,
    PayrollMonthClose,
    PayrollSettings,
)

logger = logging.getLogger(__name__)

KIND_LABEL = {
    CompensationDayAnnouncement.KIND_LATE_IN: "Late-in",
    CompensationDayAnnouncement.KIND_EARLY_OUT: "Early-out",
    CompensationDayAnnouncement.KIND_DAY: "Day exemption",
}
WINDOW_KINDS = (CompensationDayAnnouncement.KIND_LATE_IN, CompensationDayAnnouncement.KIND_EARLY_OUT)
# What DELETE /api/compensation/windows/<id> removes: the windows and the older "Compensation Day" (day exemption) rows,
# which nothing else could remove once their day had come (verification 2026-11-19)
DELETABLE_KINDS = (*WINDOW_KINDS, CompensationDayAnnouncement.KIND_DAY)


def announce_month(today: date) -> tuple[date, date]:
    """The first and last day a window can be announced for: the current month, past days included."""
    first = today.replace(day=1)
    last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    return first, last


def refresh_attendance(day: date, staff_ids) -> int:
    """Re-derive the stored attendance of these staff for `day` (a window announced for today or a past day changes how
    that day is judged). Only days already stored are touched: a day nobody has looked at yet is worked out, window and
    all, the first time it is. A day HR set by hand (source manual) is never recomputed. One person's failure is logged
    and never undoes the announcement. Returns how many staff were re-derived."""
    from .attendance_final import compensation_prefetch_for_range, compute_range_records

    ids = list(
        AttendanceDayRecord.objects.filter(date=day, employee_id__in=list(staff_ids))
        .exclude(source="manual")
        .values_list("employee_id", flat=True)
    )
    if not ids:
        return 0
    settings = PayrollSettings.get()
    prefetch = compensation_prefetch_for_range(settings, day, day)
    done = 0
    for emp in Employee.objects.filter(pk__in=ids).order_by("pk"):
        try:
            compute_range_records(emp, day, day, settings, comp_prefetch=prefetch)
            done += 1
        except Exception:
            logger.exception("Re-deriving the attendance of employee %s on %s after a window failed", emp.pk, day)
    return done


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


def locked_months() -> set[tuple[int, int]]:
    """{(year, month)} of every staff payroll month finalized (Payroll Done): one query, a handful of rows."""
    return set(PayrollMonthClose.objects.values_list("year", "month"))


def owns(ann: CompensationDayAnnouncement, scope_branch) -> bool:
    """May a user scoped to `scope_branch` (None = unscoped) remove this announcement: their own branch's, or one that
    lists only employees of their branch (prefetch `employees`)."""
    if scope_branch is None or ann.branch_id == scope_branch:
        return True
    listed = list(ann.employees.all())
    return bool(listed) and all(e.branch_id == scope_branch for e in listed)


def window_json(
    ann: CompensationDayAnnouncement,
    table: dict,
    today,
    scope_branch=None,
    locked: set | None = None,
    may_edit: bool = True,
) -> dict:
    """One announcement. `table` is _coverage_table (the staff in the caller's scope per branch / department), `locked`
    locked_months() (None = read it here), `may_edit` whether the caller may change Compensation. `today` is kept for the
    callers: since 2026-11-19 an announcement of any date can be removed (see the module docstring)."""
    listed = list(ann.employees.all())
    covers = covers_count(ann, table)
    if locked is None:
        locked = locked_months()
    blocked = None
    if not may_edit:
        blocked = "You can view Compensation but not change it."
    elif ann.kind not in DELETABLE_KINDS:
        blocked = "This announcement cannot be removed."
    elif (ann.date.year, ann.date.month) in locked:
        from .payroll_month_workflow import month_label

        blocked = (
            f"Payroll for {month_label(ann.date.month, ann.date.year)} is done, so this announcement can no longer be "
            "removed."
        )
    elif not owns(ann, scope_branch):
        blocked = "This announcement belongs to the whole company or another branch: only its owner can remove it."
    deletable = blocked is None
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
        # why canDelete is false (a plain sentence for the button's title), null when it is true (added 2026-11-19)
        "deleteBlockedReason": blocked,
    }


def _enabled_block() -> dict:
    flags = switches()
    return {"master": flags["master"], "windows": flags["windows"], "canAnnounce": flags["windows"]}


# ─────────────────────────── list ───────────────────────────


PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 200
STATUSES = ("upcoming", "past", "all")


def _department_filter(department: Department) -> Q:
    """The announcements that cover somebody of `department` by their scope (see the module docstring)."""
    wide = Q(department__isnull=True, employees__isnull=True)
    if department.branch_id is not None:
        wide &= Q(branch__isnull=True) | Q(branch_id=department.branch_id)
    return Q(department_id=department.pk) | wide | Q(employees__department_id=department.pk)


def _branch_filter(branch_id: int) -> Q:
    """The announcements of a branch: its own (incl. a department of it with no branch stamped), the company-wide ones
    and those that list an employee of it."""
    unlisted = Q(employees__isnull=True)
    return (
        Q(branch_id=branch_id)
        | (Q(branch__isnull=True) & unlisted & (Q(department__isnull=True) | Q(department__branch_id=branch_id)))
        | Q(employees__branch_id=branch_id)
    )


def _list_windows(request: Request) -> Response:
    q = request.query_params
    today = ist_today()
    kind = (q.get("kind") or "windows").lower()
    if kind not in ("windows", "all", *KIND_LABEL):
        return _bad("kind must be late_in, early_out, day, windows (late-in and early-out) or all.")
    qs = CompensationDayAnnouncement.objects.select_related("branch", "department").prefetch_related("employees")
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
    status = (q.get("status") or "all").lower()
    if status not in STATUSES:
        return _bad("status must be upcoming, past or all.")
    joined = False  # a filter through the employee list repeats rows: made distinct once at the end
    if q.get("departmentId") not in (None, ""):
        dept_id = parse_int(q.get("departmentId"))
        department = Department.objects.filter(pk=dept_id).first() if dept_id and dept_id > 0 else None
        if department is None:
            return _bad("departmentId must be the id of a department.")
        qs = qs.filter(_department_filter(department))
        joined = True
    if q.get("branchId") not in (None, ""):
        branch_id = parse_int(q.get("branchId"))
        if branch_id is None or branch_id < 1:
            return _bad("branchId must be the id of a branch.")
        qs = qs.filter(_branch_filter(branch_id))
        joined = True
    text = (q.get("q") or "").strip()
    if text:
        qs = qs.filter(Q(reason__icontains=text) | Q(announced_by__icontains=text))
    if joined:
        qs = qs.distinct()
    # The tiles: the late-in / early-out windows matching every filter except kind and status (date, month, department,
    # branch, search), so they do not change while the user flips the kind / status chips.
    summary = _summary(qs, today)
    if kind == "windows":
        qs = qs.filter(kind__in=WINDOW_KINDS)
    elif kind != "all":
        qs = qs.filter(kind=kind)
    if (q.get("upcoming") or "").lower() in ("1", "true", "yes"):
        qs = qs.filter(date__gte=today)
    if status == "upcoming":
        qs = qs.filter(date__gte=today)
    elif status == "past":
        qs = qs.filter(date__lt=today)

    paged = "page" in q or "pageSize" in q
    if paged:
        page = parse_int(q.get("page")) if q.get("page") not in (None, "") else 1
        size = parse_int(q.get("pageSize")) if q.get("pageSize") not in (None, "") else PAGE_SIZE_DEFAULT
        if page is None or page < 1:
            return _bad("page must be a whole number from 1.")
        if size is None or not 1 <= size <= PAGE_SIZE_MAX:
            return _bad(f"pageSize must be a whole number from 1 to {PAGE_SIZE_MAX}.")
        start = (page - 1) * size
    else:
        start, size = 0, max(1, min(parse_int(q.get("limit")) or LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT))
    total = qs.count()
    rows = list(qs.order_by("-date", "-id")[start : start + size])
    table = _coverage_table(request)
    locked = locked_months()
    may_edit = can_edit_compensation(request)
    body = {
        "results": [window_json(a, table, today, scope, locked, may_edit) for a in rows],
        "count": total,
        "truncated": total > start + len(rows),
        "today": today.isoformat(),
        "enabled": _enabled_block(),
        "summary": summary,
    }
    if paged:
        body.update(total=total, page=page, pageSize=size)
    return Response(body)


def _summary(qs, today) -> dict:
    """{total, lateIn, earlyOut, upcoming, past} of the late-in / early-out windows in `qs` (one query)."""
    rows = qs.filter(kind__in=WINDOW_KINDS).order_by().values_list("id", "kind", "date").distinct()
    out = {"total": 0, "lateIn": 0, "earlyOut": 0, "upcoming": 0, "past": 0}
    for _id, kind, day in rows:
        out["total"] += 1
        out["lateIn" if kind == CompensationDayAnnouncement.KIND_LATE_IN else "earlyOut"] += 1
        out["upcoming" if day >= today else "past"] += 1
    return out


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
    first, last = announce_month(today)
    if not first <= day <= last:
        return _bad(
            f"A window can only be announced for a date in the current month, {today.strftime('%B %Y')} "
            f"(1 to {last.day} {today.strftime('%B')}): an earlier month is closed, and a later month opens on its 1st."
        )
    from . import payroll_month_workflow as month_workflow

    if month_workflow.is_locked(day.month, day.year):
        return _bad(
            f"{today.strftime('%B %Y')} payroll is finalized (Payroll Done), so no window can be announced for it."
        )
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
                    "date: remove that one first or announce for different people."
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
    # today or a past day: the covered staff's stored day is judged again at once, so Attendance and History show it
    refreshed = refresh_attendance(day, covered) if day <= today else 0
    log_action(
        request,
        "create",
        "compensation",
        record_id=ann.id,
        description=f"Announced {label} window for {day.isoformat()} at {_hhmm(at)} ({len(covered)} staff)",
        new_values={"date": day.isoformat(), "kind": kind, "time": _hhmm(at), "reason": reason},
    )
    from . import compensation_notices

    compensation_notices.announcement_made(ann, covered)  # every covered staff member's phone
    ann = (
        CompensationDayAnnouncement.objects.select_related("branch", "department")
        .prefetch_related("employees")
        .get(pk=ann.pk)
    )
    body = window_json(ann, _coverage_table(request), today, get_branch_scope(request))
    body["attendanceUpdated"] = refreshed
    return Response(body, status=201)


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
        .filter(pk=pk, kind__in=DELETABLE_KINDS)
        .first()
    )
    if ann is None:
        return _bad("Window not found.", 404)
    today = ist_today()
    if not owns(ann, get_branch_scope(request)):
        return _bad("This window belongs to the whole company or another branch: only its owner can remove it.", 403)
    from . import payroll_month_workflow as month_workflow

    day = ann.date
    if month_workflow.is_locked(day.month, day.year):
        return _bad(
            f"Payroll for {month_workflow.month_label(day.month, day.year)} is done, so this announcement can no "
            "longer be removed.",
            409,
        )
    listed = [e.id for e in ann.employees.all()]
    covered = covered_staff_ids(ann.branch_id, ann.department_id, listed)
    snapshot = {
        "date": day.isoformat(),
        "kind": ann.kind,
        "time": _hhmm(window_time(ann)),
        "reason": ann.reason,
        "branchId": ann.branch_id,
        "departmentId": ann.department_id,
        "employeeIds": listed,
    }
    with transaction.atomic():
        # the settings row is the mutex an announcement takes too: a removal and an announcement are never interleaved
        CompensationConfig.objects.select_for_update().filter(pk=1).first()
        ann.delete()
    # today or a past day: the covered staff's stored day is judged again without the window (its marks come back)
    refreshed = refresh_attendance(day, covered) if day <= today else 0
    label = KIND_LABEL[snapshot["kind"]].lower()
    log_action(
        request,
        "delete",
        "compensation",
        record_id=pk,
        description=(
            f"Removed {label} window for {snapshot['date']} ({len(covered)} staff"
            + (f", attendance re-derived for {refreshed}" if day <= today else "")
            + ")"
        ),
        old_values=snapshot,
    )
    from . import compensation_notices

    compensation_notices.announcement_cancelled(ann, covered, announcement_id=pk)  # every covered staff member's phone
    return Response(status=204)
