"""Attendance cross-checks (group G7): absences that sandwich a weekly off / holiday, and approvals that the attendance
data does not agree with.

Both read the STORED ``AttendanceDayRecord`` verdicts (never the compute_* engine, which writes) so they are only as
complete as past computation -- both say so in their notes. Neither invents a verdict for a day without a record.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta

from django.db.models import Count, Exists, OuterRef, Q

from .. import filters as F
from ..common import EMP_COLS
from ..formatting import display_date, parse_date
from ..registry import register
from ..types import BADGE, DATE, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import requests_permission_duty_shared as S

STATUS_TEXT = {
    "present": "Present", "absent": "Absent", "half_shift": "Half day", "on_leave": "On leave", "holiday": "Holiday",
}
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def status_text(status) -> str | None:
    if not status:
        return None
    return STATUS_TEXT.get(status, str(status).replace("_", " ").title())


# ── 1. Absence around weekly offs and holidays (sandwich absenteeism) ───────

PATTERN_OPTIONS = (
    ("before", "Away the day before only"),
    ("after", "Away the day after only"),
    ("both", "Away before AND after (sandwich)"),
)
PATTERN_LABELS = {"before": "Before only", "after": "After only", "both": "Before and after"}
PAD_DAYS = 15  # look this far past the range so a run of off days that crosses its edge is still complete


def _saturday_off(assignments: list, cache: dict, eid: int, d: date) -> bool:
    """Weekly-off Saturday, decided like payroll does: the shift assignment in force on the 15th of the month."""
    from api.shift_engine import _get_assignment_for_date

    key = (eid, d.year, d.month)
    if key not in cache:
        a = _get_assignment_for_date(None, date(d.year, d.month, 15), assignments)
        cache[key] = bool(a and a.saturday_off)
    return cache[key]


def _off_runs(emp, holidays: dict, assignments: list, sat_cache: dict, w_from: date, w_to: date):
    """[(first, last, [day names])...]: maximal runs of consecutive days this employee does not work.

    Staff: Sundays, holiday rows and (when the employee's assignment says so) Saturdays. Production works Sundays, so
    only holiday rows exempt them. Runs that touch the window edge are dropped (their neighbours are unknown)."""
    production = emp.employment_type == "production"
    runs = []
    cur: list[tuple[date, str]] = []
    d = w_from
    while d <= w_to + timedelta(days=1):
        name = None
        if d <= w_to:
            if d in holidays:
                name = holidays[d]
            elif not production and d.weekday() == 6:
                name = "Sunday"
            elif not production and d.weekday() == 5 and _saturday_off(assignments, sat_cache, emp.id, d):
                name = "Saturday (weekly off)"
        if name is not None:
            cur.append((d, name))
        elif cur:
            first, last = cur[0][0], cur[-1][0]
            if first > w_from and last < w_to:
                names = list(dict.fromkeys(n for _d, n in cur))
                runs.append((first, last, names))
            cur = []
        d += timedelta(days=1)
    return runs


def _sandwich_run(ctx) -> ReportResult:
    from api.models import AttendanceDayRecord, EmployeeShiftAssignment, Holiday

    d_from, d_to = ctx.date_from, ctx.date_to
    w_from, w_to = d_from - timedelta(days=PAD_DAYS), d_to + timedelta(days=PAD_DAYS)
    employees = list(ctx.employees())
    holidays: dict[date, str] = {}
    for name, d in Holiday.objects.filter(date__gte=w_from, date__lte=w_to).order_by("date", "id").values_list("name", "date"):
        holidays[d] = f"{holidays[d]} / {name}" if d in holidays else name
    staff_ids = [e.id for e in employees if e.employment_type != "production"]
    assignments: dict[int, list] = defaultdict(list)
    if staff_ids:
        for a in EmployeeShiftAssignment.objects.filter(employee_id__in=staff_ids).only(
            "employee", "effective_from", "effective_to", "saturday_off"
        ):
            assignments[a.employee_id].append(a)

    # Phase 1: every employee's runs that touch the requested range, and the neighbour days to look up.
    sat_cache: dict = {}
    found = []
    neighbour_days: set[date] = set()
    for emp in employees:
        for first, last, names in _off_runs(emp, holidays, assignments.get(emp.id, []), sat_cache, w_from, w_to):
            if last < d_from or first > d_to:
                continue
            found.append((emp, first, last, names))
            neighbour_days.update((first - timedelta(days=1), last + timedelta(days=1)))

    # Phase 2: the stored verdict of those neighbour days, in one query.
    status_of: dict[tuple[int, date], str] = {}
    if found:
        for eid, d, status in AttendanceDayRecord.objects.filter(
            employee_id__in={f[0].id for f in found}, date__in=neighbour_days
        ).values_list("employee_id", "date", "status"):
            status_of[(eid, d)] = status

    away = {"absent", "on_leave"} if ctx.param("includeLeave", True) else {"absent"}
    today = ctx.today
    rows = []
    for emp, first, last, names in found:
        joined = parse_date(emp.join_date)

        def verdict(day: date) -> str | None:
            """The stored status of a working day, or None when it is unknown (no record, still in progress, or
            before the employee joined -- the engine marks those days absent)."""
            if day >= today or (joined is not None and day < joined):
                return None
            return status_of.get((emp.id, day))

        before_day, after_day = first - timedelta(days=1), last + timedelta(days=1)
        before, after = verdict(before_day), verdict(after_day)
        b_away, a_away = before in away, after in away
        if not (b_away or a_away):
            continue
        pattern = "both" if (b_away and a_away) else "before" if b_away else "after"
        if ctx.param("pattern") and ctx.param("pattern") != pattern:
            continue
        rows.append({
            **S.base_cells(emp),
            "offDay": first.isoformat(),
            "offDayName": " + ".join(names),
            "offDays": (last - first).days + 1,
            "beforeDate": before_day.isoformat(),
            "dayBefore": status_text(before),
            "afterDate": after_day.isoformat(),
            "dayAfter": status_text(after),
            "pattern": PATTERN_LABELS[pattern],
        })
    rows.sort(key=lambda r: (r["employeeCode"] or "", r["offDay"]))
    rows = rows[: ctx.row_limit]
    per_emp = Counter(r["employeeCode"] for r in rows)
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Sandwich absences", "value": len(rows), "format": "integer"},
            {"label": "Away before and after", "value": sum(1 for r in rows if r["pattern"] == PATTERN_LABELS["both"]), "format": "integer"},
            {"label": "Employees affected", "value": len(per_emp), "format": "integer"},
            {"label": "Employees with 3 or more", "value": sum(1 for n in per_emp.values() if n >= 3), "format": "integer"},
        ],
        notes=[
            "A row is one weekly off / holiday block (consecutive off days are one block) with the employee absent "
            + ("or on leave " if ctx.param("includeLeave", True) else "")
            + "on the working day before and/or after it. Staff off days = Sundays, holidays and weekly-off Saturdays "
            "(from the shift assignment, like payroll); production employees work Sundays, so only holidays count.",
            "Verdicts are the stored attendance records: a day with no record, today and later days, and days before "
            "the employee's joining date are treated as unknown and never flagged. Months nobody has opened in "
            "attendance or payroll may have no records yet.",
        ],
    )


register(ReportSpec(
    id="absence-around-holidays",
    title="Absence Around Holidays",
    description="Employees absent or on leave the working day before and/or after a weekly off or holiday.",
    category=S.CATEGORY,
    icon="CalendarX",
    tags=("sandwich", "absenteeism", "holiday", "sunday", "weekly off", "leave"),
    modules=("attendance",),
    filters=(
        F.date_range("thisMonth", "Off-day range", max_days=93),
        *F.scope(status="all"),
        F.select("pattern", "Pattern", PATTERN_OPTIONS),
        F.boolean("includeLeave", "Count approved leave as away", default=True),
    ),
    columns=(
        *EMP_COLS,
        S.BRANCH_COL,
        ColumnSpec("offDay", "Off day (first)", DATE, 1.2),
        ColumnSpec("offDayName", "Off day", TEXT, 2.0),
        ColumnSpec("offDays", "Off days", INTEGER, 0.7),
        ColumnSpec("beforeDate", "Day before", DATE, 1.1),
        ColumnSpec("dayBefore", "Status before", BADGE, 1.0),
        ColumnSpec("afterDate", "Day after", DATE, 1.1),
        ColumnSpec("dayAfter", "Status after", BADGE, 1.0),
        ColumnSpec("pattern", "Pattern", BADGE, 1.3),
    ),
    run=_sandwich_run,
))


# ── 2. Approvals versus attendance ──────────────────────────────────────────

CONFLICT_OPTIONS = (
    ("leave_but_punched", "Approved leave, but punched"),
    ("cl_rejected_but_worked", "Casual leave rejected, but worked"),
    ("on_duty_no_punches", "On-duty approved, no approved punches"),
    ("missing_punch_not_written", "Missing punch approved, not in the log"),
    ("permission_no_effect", "Permission approved, not reflected"),
)
CONFLICT_LABELS = dict(CONFLICT_OPTIONS)
# The permission module that owns each request type: a conflict is only shown to a role that can open it elsewhere.
CONFLICT_MODULE = {
    "leave_but_punched": "leave",
    "cl_rejected_but_worked": "casual_leave",
    "on_duty_no_punches": "geo_attendance",
    "missing_punch_not_written": "missing_punch",
    "permission_no_effect": "requests",
}


def _allowed_conflicts(ctx) -> list[str]:
    from ..access import permission_level

    return [k for k, module in CONFLICT_MODULE.items() if permission_level(ctx.request, module) in ("view", "edit")]


def _day_records(ctx, pairs: set[tuple[int, date]]) -> dict:
    """{(employee_id, date): AttendanceDayRecord} for the given pairs, one query."""
    from api.models import AttendanceDayRecord

    if not pairs:
        return {}
    out = {}
    for rec in AttendanceDayRecord.objects.filter(
        employee_id__in={p[0] for p in pairs}, date__gte=ctx.date_from, date__lte=ctx.date_to
    ):
        if (rec.employee_id, rec.date) in pairs:
            out[(rec.employee_id, rec.date)] = rec
    return out


def _punch_counts(ctx, employee_ids) -> dict[tuple[int, date], int]:
    from api.models import AttendanceLog

    if not employee_ids:
        return {}
    return {
        (r["employee_id"], r["date"]): r["n"]
        for r in AttendanceLog.objects.filter(employee_id__in=employee_ids, date__gte=ctx.date_from, date__lte=ctx.date_to)
        .order_by().values("employee_id", "date").annotate(n=Count("id"))
    }


def _conflict_leave_punched(ctx, staff_ids) -> list[dict]:
    from api.models import LeaveRequest

    if not staff_ids:
        return []
    leaves = LeaveRequest.objects.filter(
        employee_id__in=staff_ids, status="approved", is_half_day=False,
        start_date__lt=(ctx.date_to + timedelta(days=1)).isoformat(), end_date__gte=ctx.date_from.isoformat(),
    ).select_related("leave_type_ref").order_by("id")
    days: dict[tuple[int, date], list] = defaultdict(list)
    for lr in leaves:
        start, end = parse_date(lr.start_date), parse_date(lr.end_date)
        if start is None or end is None:
            continue
        d = max(start, ctx.date_from)
        while d <= min(end, ctx.date_to):
            days[(lr.employee_id, d)].append(lr)
            d += timedelta(days=1)
    punches = _punch_counts(ctx, {k[0] for k in days})
    hits = {k: v for k, v in days.items() if punches.get(k)}
    records = _day_records(ctx, set(hits))
    out = []
    for (eid, d), lrs in hits.items():
        refs = ", ".join(f"Leave #{lr.id}" for lr in lrs)
        first = lrs[0]
        kind = first.leave_type_ref.name if first.leave_type_ref_id else (first.type or "leave")
        rec = records.get((eid, d))
        out.append({
            "eid": eid, "date": d, "type": "leave_but_punched", "ref": refs,
            "detail": f"Approved {kind} ({display_date(first.start_date)} to {display_date(first.end_date)}) but "
                      f"{punches[(eid, d)]} punch(es) recorded; punches win over leave, so the day counts as worked.",
            "status": rec.status if rec else None,
        })
    return out


def _conflict_cl_rejected(ctx, staff_ids) -> list[dict]:
    from api.models import CasualLeaveRequest

    if not staff_ids:
        return []
    cls = list(CasualLeaveRequest.objects.filter(
        employee_id__in=staff_ids, status="rejected", date__gte=ctx.date_from, date__lte=ctx.date_to
    ).order_by("date", "id"))
    punches = _punch_counts(ctx, {c.employee_id for c in cls})
    hits = [c for c in cls if punches.get((c.employee_id, c.date))]
    records = _day_records(ctx, {(c.employee_id, c.date) for c in hits})
    out = []
    for c in hits:
        rec = records.get((c.employee_id, c.date))
        out.append({
            "eid": c.employee_id, "date": c.date, "type": "cl_rejected_but_worked", "ref": f"Casual leave #{c.id}",
            "detail": f"Casual leave was rejected, which marks the day as unpaid leave, yet "
                      f"{punches[(c.employee_id, c.date)]} punch(es) were recorded.",
            "status": rec.status if rec else None,
        })
    return out


def _conflict_on_duty(ctx, ids) -> list[dict]:
    from api.models import OnDutySession

    start, end = S.ist_bounds(ctx.date_from, ctx.date_to)
    sessions = list(
        OnDutySession.objects.filter(
            employee_id__in=ids, status__in=("active", "completed"), created_at__gte=start, created_at__lt=end
        ).annotate(ok=Count("punch_verifications", filter=Q(punch_verifications__status="approved")))
        .filter(ok=0).order_by("created_at", "id")
    )
    records = _day_records(ctx, {(s.employee_id, S.ist_date(s.created_at)) for s in sessions})
    out = []
    for s in sessions:
        d = S.ist_date(s.created_at)
        rec = records.get((s.employee_id, d))
        out.append({
            "eid": s.employee_id, "date": d, "type": "on_duty_no_punches", "ref": f"On-duty #{s.id}",
            "detail": f"HR approved the on-duty request to {s.destination}, but no punch under it was approved, so it "
                      "added nothing to attendance.",
            "status": rec.status if rec else None,
        })
    return out


def _conflict_missing_punch(ctx, ids) -> list[dict]:
    from api.models import AttendanceLog, MissingPunchRequest

    logged = AttendanceLog.objects.filter(
        employee_id=OuterRef("employee_id"), date=OuterRef("date"), punch_time=OuterRef("punch_time"),
        punch_type=OuterRef("punch_type"),
    )
    reqs = list(
        MissingPunchRequest.objects.filter(
            employee_id__in=ids, status="approved", date__gte=ctx.date_from, date__lte=ctx.date_to
        ).filter(~Exists(logged)).order_by("date", "id")
    )
    records = _day_records(ctx, {(r.employee_id, r.date) for r in reqs})
    out = []
    for r in reqs:
        rec = records.get((r.employee_id, r.date))
        out.append({
            "eid": r.employee_id, "date": r.date, "type": "missing_punch_not_written", "ref": f"Missing punch #{r.id}",
            "detail": f"Approved {r.punch_type} punch at {S.tstr(r.punch_time)} is not in the punch log "
                      "(deleted, or never written).",
            "status": rec.status if rec else None,
        })
    return out


def _conflict_permission(ctx, staff_ids) -> list[dict]:
    from api.models import EmployeePermission

    if not staff_ids:
        return []
    perms = list(EmployeePermission.objects.filter(
        employee_id__in=staff_ids, status="approved", date__gte=ctx.date_from, date__lte=ctx.date_to
    ).order_by("date", "id"))
    records = _day_records(ctx, {(p.employee_id, p.date) for p in perms})
    out = []
    for p in perms:
        kind = EmployeePermission.normalize_type(p.type)
        rec = records.get((p.employee_id, p.date))
        # Only a day the employee actually worked, computed automatically, can prove the flag is missing; the type must be
        # known (an untyped request is inferred by the engine, which needs the shift).
        if kind is None or rec is None or rec.source != "auto" or rec.status not in ("present", "half_shift"):
            continue
        if kind == "morning_late_in":
            reflected = rec.morning_permission_applied or rec.morning_permission_excess
        elif kind == "evening_early_out":
            reflected = rec.evening_permission_applied or rec.evening_permission_excess or rec.is_compensation_day
        else:
            reflected = rec.middle_permission_today
        if reflected:
            continue
        out.append({
            "eid": p.employee_id, "date": p.date, "type": "permission_no_effect", "ref": f"Permission #{p.id}",
            "detail": f"Approved {EmployeePermission.TYPE_LABELS[kind]} permission is not reflected on the day record "
                      "(possibly stale: the record may pre-date the approval).",
            "status": rec.status,
        })
    return out


def _conflicts_run(ctx) -> ReportResult:
    allowed = _allowed_conflicts(ctx)
    wanted = [k for k in allowed if not ctx.param("conflictType") or ctx.param("conflictType") == k]
    employees = {e.id: e for e in ctx.employees()}
    ids = list(employees)
    staff_ids = [i for i, e in employees.items() if e.employment_type != "production"]

    found: list[dict] = []
    if "leave_but_punched" in wanted:
        found += _conflict_leave_punched(ctx, staff_ids)
    if "cl_rejected_but_worked" in wanted:
        found += _conflict_cl_rejected(ctx, staff_ids)
    if "on_duty_no_punches" in wanted:
        found += _conflict_on_duty(ctx, ids)
    if "missing_punch_not_written" in wanted:
        found += _conflict_missing_punch(ctx, ids)
    if "permission_no_effect" in wanted:
        found += _conflict_permission(ctx, staff_ids)

    found.sort(key=lambda c: (employees[c["eid"]].employee_code, c["date"], c["type"]))
    found = found[: ctx.row_limit]
    rows = [{
        **S.base_cells(employees[c["eid"]]),
        "date": c["date"].isoformat(),
        "conflictType": CONFLICT_LABELS[c["type"]],
        "requestRef": c["ref"],
        "detail": c["detail"],
        "attendanceStatus": status_text(c["status"]),
    } for c in found]
    by_type = Counter(c["type"] for c in found)
    notes = [
        "Each row is an approval that the attendance data does not agree with. Punches always win over approved "
        "leave by design, so 'approved leave but punched' is a payroll heads-up, not necessarily an error.",
        "Attendance verdicts are read from the stored day records, which are refreshed only when a screen or payroll "
        "computes them: 'not reflected' rows can be stale records. Casual leave, permissions and leave are staff-only "
        "concepts, so production employees are not checked for those.",
    ]
    hidden = [CONFLICT_LABELS[k] for k in CONFLICT_MODULE if k not in allowed]
    if hidden:
        notes.append("Not shown, because your role cannot open the underlying requests: " + "; ".join(hidden) + ".")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Conflicts", "value": len(rows), "format": "integer"},
            {"label": "Employees affected", "value": len({c["eid"] for c in found}), "format": "integer"},
            *[{"label": CONFLICT_LABELS[k], "value": by_type.get(k, 0), "format": "integer"} for k in wanted],
        ][:8],
        notes=notes,
    )


register(ReportSpec(
    id="leave-attendance-conflicts",
    title="Leave and Request Conflicts",
    description="Approvals that attendance disagrees with: leave or rejected casual leave but punched, on-duty or missing punch that left no punch.",
    category=S.CATEGORY,
    icon="GitCompare",
    tags=("conflict", "mismatch", "leave", "casual leave", "on duty", "missing punch", "permission", "audit"),
    modules=("attendance",),
    filters=(
        F.date_range("thisMonth", "Date", max_days=93),
        *F.scope(status="all"),
        F.select("conflictType", "Conflict type", CONFLICT_OPTIONS),
    ),
    columns=(
        *EMP_COLS,
        S.BRANCH_COL,
        ColumnSpec("date", "Date", DATE, 1.1),
        ColumnSpec("conflictType", "Conflict", BADGE, 2.0),
        ColumnSpec("requestRef", "Request", TEXT, 1.4),
        ColumnSpec("detail", "Detail", TEXT, 4.0),
        ColumnSpec("attendanceStatus", "Day status", BADGE, 1.0),
    ),
    run=_conflicts_run,
))
