"""
Shift, production-shift and biometric-device reports (category "attendance"):
shift-roster, shift-wise-attendance, shift-assignment-gaps, production-shift-register and
device-sync-health.

Shift facts come from ``EmployeeShiftAssignment`` -> ``ShiftTemplate`` with the engine's own rule
(the assignment with the latest ``effective_from`` covering the day wins; a custom start / end on
the assignment overrides the template). Attendance figures are the stored day records.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta

from django.db.models import Count, Q

from api.branch_scope import get_branch_scope
from api.device_health import SILENT_AFTER_HOURS, device_health
from api.models import (
    AttendanceLog,
    AutoSyncRule,
    BiometricDevice,
    EmployeeShiftAssignment,
    UnmatchedPunch,
)
from api.payroll_views import _d2
from api.production_period import InvalidPeriodConfig, resolve_production_period
from api.shift_engine import _t2s

from ..common import EMP_COLS, EMP_COLS_SHORT, emp_cells, with_subtotals
from ..filters import date_range, select, text
from ..formatting import display_date, fmt_dt
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    DATETIME,
    INTEGER,
    MINUTES,
    NUMBER,
    PERCENT,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .attendance_analysis_common import (
    ABSENT,
    HALF,
    LEAVE,
    MASKED,
    OFF,
    PENDING,
    PRESENT,
    UNASSIGNED,
    Roster,
    classify_day,
    coverage_notes,
    day_records,
    days_between,
    emp_sort_key,
    hm,
    payroll_settings,
    people,
    scope_filters,
)

SHIFT_MODULES = ("shifts", "attendance")
SHIFT_TYPES = (("staff", "Staff"), ("production", "Production"))
_YES_NO = (("yes", "Saturday off"), ("no", "Works Saturdays"))


def _effective_times(asg):
    """(start, end) of an assignment: the custom timings when set, else the template's."""
    return (asg.custom_start_time or asg.shift.start_time), (asg.custom_end_time or asg.shift.end_time)


def _is_overnight(start, end) -> bool:
    return _t2s(end) <= _t2s(start)


def _overlaps(a, b) -> bool:
    a_end = a.effective_to or date.max
    b_end = b.effective_to or date.max
    return a.effective_from <= b_end and b.effective_from <= a_end


# ═════════════════════════════════════════════════════════════════════════════
#  shift-roster
# ═════════════════════════════════════════════════════════════════════════════

_ROSTER_COLS = (
    *EMP_COLS,
    ColumnSpec("shiftName", "Shift", TEXT, 1.4),
    ColumnSpec("shiftType", "Type", BADGE, 0.9),
    ColumnSpec("startTime", "Start", TIME, 0.7),
    ColumnSpec("endTime", "End", TIME, 0.7),
    ColumnSpec("graceMinutes", "Grace (min)", MINUTES, 0.8),
    ColumnSpec("customTimes", "Custom timings", TEXT, 1.2),
    ColumnSpec("saturdayOff", "Saturday off", BADGE, 0.9),
    ColumnSpec("effectiveFrom", "Effective from", DATE, 1.1),
    ColumnSpec("effectiveTo", "Effective to", DATE, 1.1),
    ColumnSpec("assignedBy", "Assigned by", TEXT, 1.2),
    ColumnSpec("warning", "Warnings", TEXT, 2.2),
)


def _assignments(ctx, d_from: date, d_to: date):
    return (
        EmployeeShiftAssignment.objects.filter(ctx.emp_q("employee__"), effective_from__lte=d_to)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=d_from))
        .select_related("shift")
        .order_by("effective_from", "id")
    )


def _roster_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    people_by_id = people(ctx)
    want_type = ctx.params.get("shiftType")
    name_text = (ctx.params.get("shift") or "").lower()
    sat = ctx.params.get("saturdayOff")

    per_emp: dict[int, list] = defaultdict(list)
    for a in _assignments(ctx, d_from, d_to):
        if a.employee_id in people_by_id:
            per_emp[a.employee_id].append(a)
    overlapping = set()
    for lst in per_emp.values():
        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if _overlaps(a, b):
                    overlapping.update((a.id, b.id))

    built = []
    for emp_id, lst in per_emp.items():
        emp = people_by_id[emp_id]
        for a in lst:
            sh = a.shift
            if want_type and sh.shift_type != want_type:
                continue
            if name_text and name_text not in (sh.name or "").lower():
                continue
            if sat == "yes" and not a.saturday_off:
                continue
            if sat == "no" and a.saturday_off:
                continue
            start, end = _effective_times(a)
            warns = []
            if _is_overnight(start, end):
                warns.append("Overnight (not supported by late / half-day rules)")
            if a.id in overlapping:
                warns.append("Overlaps another assignment")
            if not sh.is_active:
                warns.append("Shift template is inactive")
            if sh.branch_id and emp.branch_id != sh.branch_id:
                warns.append("Shift belongs to another branch")
            if sh.shift_type != emp.employment_type:
                warns.append(f"{sh.shift_type.title()} shift for a {emp.employment_type} employee")
            custom = None
            if a.custom_start_time or a.custom_end_time:
                custom = f"{hm(a.custom_start_time) or '-'} to {hm(a.custom_end_time) or '-'}"
            built.append((
                (sh.name or "").lower(), emp_sort_key(emp), a.effective_from, emp, a, {
                    **emp_cells(emp),
                    "shiftName": sh.name,
                    "shiftType": sh.shift_type.title(),
                    "startTime": hm(start),
                    "endTime": hm(end),
                    "graceMinutes": sh.grace_period_minutes,
                    "customTimes": custom,
                    "saturdayOff": "Yes" if a.saturday_off else "No",
                    "effectiveFrom": a.effective_from.isoformat(),
                    "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
                    "assignedBy": a.assigned_by,
                    "warning": "; ".join(warns) or None,
                },
            ))
    built.sort(key=lambda t: t[:3])
    rows = [t[5] for t in built][: ctx.row_limit]

    per_shift = Counter()
    seen = set()
    for _n, _k, _f, emp, a, row in built:
        if (a.shift_id, emp.id) not in seen:
            seen.add((a.shift_id, emp.id))
            per_shift[row["shiftName"]] += 1
    summary = [
        {"label": "Assignments", "value": len(built), "format": "integer"},
        {"label": "Employees", "value": len({t[3].id for t in built}), "format": "integer"},
        {"label": "Saturday off", "value": sum(1 for t in built if t[4].saturday_off), "format": "integer"},
        {"label": "Overnight shifts", "value": sum(1 for t in built if t[5]["warning"] and "Overnight" in t[5]["warning"]), "format": "integer"},
        {"label": "Overlapping assignments", "value": sum(1 for t in built if t[4].id in overlapping), "format": "integer"},
    ]
    notes = [
        "Assignments in force at any time between the selected dates. The shift on a given day is the assignment with the latest "
        "effective-from date that covers it; overlapping assignments are allowed by the data, so they are flagged rather than hidden.",
        "Start / End show the employee's custom timings when set, otherwise the shift template's. A shift with no assignment means "
        "Late Detection never flags that employee (see Shift Assignment Gaps).",
    ]
    if per_shift:
        notes.append("Employees per shift: " + ", ".join(f"{n} {c}" for n, c in sorted(per_shift.items())) + ".")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="shift-roster",
        title="Shift Roster / Assignments",
        description="Who is on which shift, with timings, grace, Saturday-off, effective dates and data warnings.",
        category="attendance",
        icon="CalendarRange",
        tags=("shift", "roster", "assignment", "timings", "saturday off"),
        modules=SHIFT_MODULES,
        filters=(
            date_range("today", label="Assignments in force during", max_days=366),
            *scope_filters(status="active"),
            select("shiftType", "Shift type", SHIFT_TYPES),
            text("shift", "Shift name contains", "e.g. General"),
            select("saturdayOff", "Saturday", _YES_NO),
        ),
        columns=_ROSTER_COLS,
        run=_roster_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  shift-assignment-gaps
# ═════════════════════════════════════════════════════════════════════════════

ISSUES = (
    ("no_shift", "No shift assigned"),
    ("overnight", "Overnight shift"),
    ("overlap", "Overlapping assignments"),
    ("inactive_shift", "Inactive shift template"),
    ("branch_mismatch", "Shift of another branch"),
    ("type_mismatch", "Shift type differs from employee type"),
)
ISSUE_LABEL = dict(ISSUES)

_GAP_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("currentShift", "Shift at end of period", TEXT, 1.6),
    ColumnSpec("issue", "Issue", BADGE, 1.6),
    ColumnSpec("detail", "Detail", TEXT, 4.0),
)


def _uncovered_days(assignments, start: date, end: date) -> tuple[int, date | None]:
    """(number of days in [start, end] no assignment covers, first such day)."""
    if end < start:
        return 0, None
    intervals = sorted(
        (max(a.effective_from, start), min(a.effective_to or end, end)) for a in assignments
        if a.effective_from <= end and (a.effective_to is None or a.effective_to >= start)
    )
    cursor, missing, first = start, 0, None
    for lo, hi in intervals:
        if lo > cursor:
            missing += (lo - cursor).days
            first = first or cursor
        if hi >= cursor:
            cursor = hi + timedelta(days=1)
    if cursor <= end:
        missing += (end - cursor).days + 1
        first = first or cursor
    return missing, first


def _gaps_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    want = ctx.params.get("issue")
    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)
    per_emp: dict[int, list] = defaultdict(list)
    for a in _assignments(ctx, d_from, d_to):
        if a.employee_id in people_by_id:
            per_emp[a.employee_id].append(a)

    built = []
    for emp_id, emp in people_by_id.items():
        lst = per_emp.get(emp_id, [])
        joined = roster.join_date(emp)
        exit_day = roster.exits.get(emp_id)
        start = max(d_from, joined) if joined else d_from
        end = min(d_to, exit_day) if exit_day else d_to
        current = roster.shift_on(emp_id, d_to)
        issues: list[tuple[str, str]] = []
        missing, first = _uncovered_days(lst, start, end)
        if missing:
            total = (end - start).days + 1
            issues.append(("no_shift", f"No shift on {missing} of {total} day(s), first on {display_date(first)}."))
        for a in lst:
            s_time, e_time = _effective_times(a)
            if _is_overnight(s_time, e_time):
                issues.append((
                    "overnight",
                    f"{a.shift.name} runs {hm(s_time)}-{hm(e_time)} (past midnight); late / half-day / early-out rules do not support overnight shifts.",
                ))
            if not a.shift.is_active:
                issues.append(("inactive_shift", f"Assigned to '{a.shift.name}', which is marked inactive."))
            if a.shift.branch_id and emp.branch_id != a.shift.branch_id:
                issues.append(("branch_mismatch", f"'{a.shift.name}' belongs to a different branch than the employee."))
            if a.shift.shift_type != emp.employment_type:
                issues.append((
                    "type_mismatch",
                    f"'{a.shift.name}' is a {a.shift.shift_type} shift but the employee is {emp.employment_type}.",
                ))
        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if _overlaps(a, b):
                    issues.append((
                        "overlap",
                        f"'{a.shift.name}' from {display_date(a.effective_from)} overlaps '{b.shift.name}' from "
                        f"{display_date(b.effective_from)}; the later start wins.",
                    ))
        for code, detail in issues:
            if want and code != want:
                continue
            built.append((emp_sort_key(emp), code, {
                **emp_cells(emp),
                "employmentType": emp.employment_type.title(),
                "currentShift": current.name if current else "No shift assigned",
                "issue": ISSUE_LABEL[code],
                "detail": detail,
            }))
    built.sort(key=lambda t: (t[0], [c for c, _l in ISSUES].index(t[1])))
    rows = [t[2] for t in built][: ctx.row_limit]
    by_code = Counter(t[1] for t in built)
    summary = [
        {"label": "Employees with an issue", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "No shift", "value": by_code["no_shift"], "format": "integer"},
        {"label": "Overnight", "value": by_code["overnight"], "format": "integer"},
        {"label": "Overlapping", "value": by_code["overlap"], "format": "integer"},
    ]
    notes = [
        "No shift means Late Detection can never flag the employee, WhatsApp alerts skip them and Overtime is never detected. "
        "Days before the joining date or after an approved last working day are not counted as gaps.",
        "Overnight shifts (end at or before start) are not reliably handled by the late / half-day / early-out rules. Overlapping "
        "assignments are legal in the data (the latest effective-from wins) but usually a mistake.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="shift-assignment-gaps",
        title="Shift Assignment Gaps",
        description="Employees with no shift, overnight or overlapping assignments and shift templates that do not fit the employee.",
        category="attendance",
        icon="TriangleAlert",
        tags=("shift", "gap", "data quality", "no shift", "overnight", "overlap"),
        modules=SHIFT_MODULES,
        filters=(
            date_range("today", label="Check period", max_days=92),
            *scope_filters(status="active", designation=False, employee=False),
            select("issue", "Issue", ISSUES),
        ),
        columns=_GAP_COLS,
        run=_gaps_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  shift-wise-attendance
# ═════════════════════════════════════════════════════════════════════════════

_SHIFTWISE_COLS = (
    ColumnSpec("shiftName", "Shift", TEXT, 2.0),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("headcount", "Rostered", INTEGER, 0.8, total="sum"),
    ColumnSpec("present", "Present", INTEGER, 0.8, total="sum"),
    ColumnSpec("halfDay", "Half day", INTEGER, 0.8, total="sum"),
    ColumnSpec("absent", "Absent", INTEGER, 0.8, total="sum"),
    ColumnSpec("onLeave", "On leave", INTEGER, 0.8, total="sum"),
    ColumnSpec("late", "Late", INTEGER, 0.7, total="sum"),
    ColumnSpec("strengthPct", "Strength %", PERCENT, 0.9),
    ColumnSpec("shiftCredit", "Shift credit", NUMBER, 0.9, total="sum"),
)
_SW_SUM = ["headcount", "present", "halfDay", "absent", "onLeave", "late", "shiftCredit"]


def _sw_pct(r: dict) -> float | None:
    return round((r["present"] + r["halfDay"]) * 100.0 / r["headcount"], 1) if r["headcount"] else None


def _shiftwise_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    name_text = (ctx.params.get("shift") or "").lower()
    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)

    agg: dict[tuple[str, date], dict] = {}
    for rec in day_records(ctx, d_from, d_to):
        emp = people_by_id.get(rec.employee_id)
        if emp is None:
            continue
        cls = classify_day(rec, emp, roster, ctx.today)
        if cls in (MASKED, OFF):
            continue  # weekly-off / holiday / not yet joined / already left: not part of that shift's headcount
        shift = roster.shift_on(emp.id, rec.date)
        name = shift.name if shift else UNASSIGNED
        if name_text and name_text not in name.lower():
            continue
        a = agg.setdefault((name, rec.date), dict.fromkeys(_SW_SUM, 0))
        a["headcount"] += 1
        if cls == PRESENT:
            a["present"] += 1
        elif cls == HALF:
            a["halfDay"] += 1
        elif cls == LEAVE:
            a["onLeave"] += 1
        elif cls in (ABSENT, PENDING):
            a["absent"] += 1
        a["late"] += 1 if rec.is_late else 0
        a["shiftCredit"] += float(rec.shifts_earned or 0)

    keys = sorted(agg, key=lambda k: (k[0] == UNASSIGNED, k[0].lower(), k[1]))
    data = []
    for name, d in keys:
        a = agg[(name, d)]
        row = {"shiftName": name, "date": d.isoformat(), **a, "shiftCredit": round(a["shiftCredit"], 2)}
        row["strengthPct"] = _sw_pct(row)
        data.append(row)
    rows = with_subtotals(data, lambda r: r["shiftName"], _SW_SUM, label_key="shiftName", label=lambda g: f"{g} total")
    for r in rows:
        if r.get("_kind") == "subtotal":
            r["strengthPct"] = _sw_pct(r)

    grand = {k: sum(r[k] for r in data) for k in _SW_SUM}
    grand["shiftCredit"] = round(grand["shiftCredit"], 2)
    grand["strengthPct"] = _sw_pct(grand)
    heads = grand["present"] + grand["halfDay"]
    summary = [
        {"label": "Shifts", "value": len({r["shiftName"] for r in data}), "format": "integer"},
        {"label": "Present man-days", "value": heads, "format": "integer"},
        {"label": "Absent man-days", "value": grand["absent"], "format": "integer"},
        {"label": "Strength %", "value": grand["strengthPct"], "format": "percent"},
        {"label": "Late %", "value": round(grand["late"] * 100.0 / heads, 1) if heads else None, "format": "percent"},
    ]
    notes = [
        "Each stored day record is counted under the shift the employee was assigned to that day (a mid-period assignment change "
        "moves them between shifts by date). Employees with no assignment are grouped as Unassigned.",
        "Rostered excludes weekly-off, holiday, not-yet-joined and already-left days (Saturday-off Saturdays count as weekly off for "
        "staff). Strength % = (present + half day) / rostered. Staff and production shift credit are not directly comparable.",
    ]
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes, totals=grand)


register(
    ReportSpec(
        id="shift-wise-attendance",
        title="Shift-wise Attendance Summary",
        description="Present, half-day, absent, leave and late counts grouped by shift and day, with strength %.",
        category="attendance",
        icon="Layers",
        tags=("shift", "shift wise", "strength", "attendance summary"),
        modules=SHIFT_MODULES,
        filters=(
            date_range("today", max_days=31),
            *scope_filters(designation=False, employee=False),
            text("shift", "Shift name contains", "e.g. General"),
        ),
        columns=_SHIFTWISE_COLS,
        run=_shiftwise_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  production-shift-register
# ═════════════════════════════════════════════════════════════════════════════

_PROD_FIXED = (
    *EMP_COLS_SHORT,
)
_PROD_TAIL = (
    ColumnSpec("daysWorked", "Days worked", INTEGER, 0.8, total="sum"),
    ColumnSpec("totalShifts", "Total shifts", NUMBER, 0.9, total="sum"),
    ColumnSpec("extraShifts", "Extra (over 1.00)", NUMBER, 1.0, total="sum"),
    ColumnSpec("lateDays", "Late days", INTEGER, 0.8, total="sum"),
    ColumnSpec("salaryPerShift", "Rate / shift", CURRENCY, 1.0),
    ColumnSpec("estimatedGross", "Gross (shifts x rate)", CURRENCY, 1.3, total="sum"),
)
_PROD_STATIC = (*_PROD_FIXED, *_PROD_TAIL)


def _production_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    prod = {i: e for i, e in people(ctx, "salary_per_shift").items() if e.employment_type == "production"}
    by_emp: dict[int, dict[date, object]] = defaultdict(dict)
    for rec in day_records(ctx, d_from, d_to, employee__employment_type="production"):
        if rec.employee_id in prod:
            by_emp[rec.employee_id][rec.date] = rec

    days = list(days_between(d_from, d_to))
    same_month = d_from.month == d_to.month and d_from.year == d_to.year
    day_cols = [
        ColumnSpec(f"day_{d.isoformat()}", f"{d.day:02d}" if same_month else f"{d.day:02d}/{d.month:02d}", NUMBER, 0.55, total="sum")
        for d in days
    ]
    columns = [*_PROD_FIXED, *day_cols, *_PROD_TAIL]

    data = []
    for emp_id in sorted(by_emp, key=lambda i: emp_sort_key(prod[i])):
        emp = prod[emp_id]
        recs = by_emp[emp_id]
        row = {**emp_cells(emp)}
        total = extra = 0.0
        exact_total = 0
        worked = late = 0
        for d in days:
            rec = recs.get(d)
            if rec is None or rec.status in ("holiday", "on_leave"):
                row[f"day_{d.isoformat()}"] = None
                continue
            credit = float(rec.shifts_earned or 0)
            row[f"day_{d.isoformat()}"] = credit
            total += credit
            exact_total += rec.shifts_earned or 0
            extra += max(0.0, credit - 1.0)
            worked += 1 if rec.status in ("present", "half_shift") else 0
            late += 1 if rec.is_late else 0
        rate = emp.salary_per_shift
        row.update({
            "daysWorked": worked,
            "totalShifts": round(total, 2),
            "extraShifts": round(extra, 2),
            "lateDays": late,
            "salaryPerShift": float(rate) if rate else None,
            "estimatedGross": float(_d2(exact_total * rate)) if rate else None,
        })
        data.append(row)
    sum_keys = [c.key for c in day_cols] + ["daysWorked", "totalShifts", "extraShifts", "lateDays", "estimatedGross"]
    rows = with_subtotals(data, lambda r: r["department"], sum_keys)

    summary = [
        {"label": "Employees", "value": len(data), "format": "integer"},
        {"label": "Total shifts", "value": round(sum(r["totalShifts"] for r in data), 2), "format": "number"},
        {"label": "Extra shifts (over 1.00)", "value": round(sum(r["extraShifts"] for r in data), 2), "format": "number"},
        {"label": "Late days", "value": sum(r["lateDays"] for r in data), "format": "integer"},
        {"label": "Gross (shifts x rate)", "value": round(sum(r["estimatedGross"] or 0 for r in data), 2), "format": "currency"},
    ]
    notes = [
        "Shift credit is the stored value of each production day (0.25 steps up to the maximum of the active shift segments). A dash "
        "means a holiday or a day with no stored record; 0 means absent. Production employees have no leave and work Sundays as a "
        "normal day.",
        "Extra shifts = credit above 1.00 on a day (an inference: the segments carry no overtime flag). Late days come from the "
        "production shift reference times in Settings (first punch after arrival + grace); production payroll's own late deduction, when "
        "switched on, uses the assigned shift template instead. Gross = total shifts x rate per shift, exactly as production payroll "
        "computes it before deductions.",
    ]
    try:
        p_from, p_to = resolve_production_period(ctx.today, payroll_settings())
        notes.append(f"Current production payroll period: {display_date(p_from)} to {display_date(p_to)}.")
    except InvalidPeriodConfig:
        pass  # the period hint is a courtesy: an incomplete period setting must not break the register
    if len(days) > 31:
        notes.append("Long ranges make a wide table; the Excel export is easier to read than the PDF.")
    notes.extend(coverage_notes(ctx, prod, d_from, d_to))
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id="production-shift-register",
        title="Production Shift Register",
        description="Production employees' daily shift credit (0.25 steps to 1.50), extra shifts, late days and gross for a period.",
        category="attendance",
        icon="Factory",
        tags=("production", "shift credit", "shifts", "piece", "extra shift", "weekly wages"),
        modules=("production_payroll", "payroll"),
        filters=(
            date_range("thisMonth", max_days=45),
            *scope_filters(employment=False, designation=False),
        ),
        columns=_PROD_STATIC,
        run=_production_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  device-sync-health
# ═════════════════════════════════════════════════════════════════════════════

DEVICE_STATUS = (("live", "Live"), ("silent", "Silent"), ("never", "Never synced"), ("disabled", "Disabled"))
_STATUS_LABEL = dict(DEVICE_STATUS)

_DEVICE_COLS = (
    ColumnSpec("deviceName", "Device", TEXT, 1.8),
    ColumnSpec("host", "Host", TEXT, 1.4),
    ColumnSpec("serialNumber", "Serial no.", TEXT, 1.4),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("lastPushAt", "Last push", DATETIME, 1.4),
    ColumnSpec("lastSyncedAt", "Last pull sync", DATETIME, 1.4),
    ColumnSpec("punchesInPeriod", "Punches in period", INTEGER, 1.1, total="sum"),
    ColumnSpec("lastRuleRun", "Last auto-sync run", DATETIME, 1.4),
    ColumnSpec("lastRuleStatus", "Run result", BADGE, 0.9),
    ColumnSpec("lastRuleSummary", "Run summary", TEXT, 3.0),
)


def _device_run(ctx):
    if get_branch_scope(ctx.request) is not None:
        return ReportResult(
            rows=[],
            notes=["Biometric devices are shared company-wide (they have no branch), so this report is only available to "
                   "head-office users who are not tied to a branch."],
        )
    d_from, d_to = ctx.date_from, ctx.date_to
    want = ctx.params.get("deviceStatus")
    health = {d["id"]: d["status"] for d in device_health()["devices"]}
    devices = list(BiometricDevice.objects.all().order_by("name", "id"))
    rules = list(AutoSyncRule.objects.filter(is_enabled=True).order_by("time", "id"))
    counts = dict(
        AttendanceLog.objects.filter(date__gte=d_from, date__lte=d_to, source__startswith="biometric")
        .order_by().values("source").annotate(n=Count("id")).values_list("source", "n")
    )
    many = (
        AttendanceLog.objects.filter(date__gte=d_from, date__lte=d_to)
        .order_by().values("employee_id", "date").annotate(n=Count("id")).filter(n__gte=6).count()
    )
    unresolved = UnmatchedPunch.objects.filter(resolved=False).count()

    rows = []
    for dev in devices:
        status = health.get(dev.id, "disabled")
        if want and status != want:
            continue
        punches = 0
        if dev.serial_number:
            punches += counts.get(f"biometric:adms:{dev.serial_number}", 0)
        punches += counts.get(f"biometric:{dev.name}", 0)
        covering = [
            r for r in rules
            if not r.device_selection or dev.id in r.device_selection or str(dev.id) in map(str, r.device_selection)
        ]
        ran = [r for r in covering if r.last_run_at]
        last = max(ran, key=lambda r: r.last_run_at) if ran else None
        rows.append({
            "deviceName": dev.name,
            "host": dev.host or None,
            "serialNumber": dev.serial_number or None,
            "status": _STATUS_LABEL[status],
            "lastPushAt": fmt_dt(dev.last_push_at),
            "lastSyncedAt": fmt_dt(dev.last_synced_at),
            "punchesInPeriod": punches,
            "lastRuleRun": fmt_dt(last.last_run_at) if last else None,
            "lastRuleStatus": (last.last_run_status or "").title() or None if last else None,
            "lastRuleSummary": last.last_run_summary if last else None,
        })
    by_status = Counter(health.values())
    summary = [
        {"label": "Devices", "value": len(devices), "format": "integer"},
        {"label": "Live", "value": by_status["live"], "format": "integer"},
        {"label": "Silent or never synced", "value": by_status["silent"] + by_status["never"], "format": "integer"},
        {"label": "Unresolved unmatched IDs", "value": unresolved, "format": "integer"},
        {"label": "Employee-days with 6+ punches", "value": many, "format": "integer"},
    ]
    notes = [
        f"Status: Live = pushed within the last {SILENT_AFTER_HOURS} hours; Silent = enabled but quiet for longer; Never synced = enabled "
        "but nothing received yet; Disabled = switched off in Settings. Devices and sync rules are company-wide.",
        "Punches in period are attributed to a device by the source tag the ingest writes (biometric:<serial> for push, biometric:<name> "
        "for pull); punches from other sources (Excel import, manual, geo) are not attributed. Employee-days with 6 or more punches "
        "usually mean two people share one device user ID.",
        "Only the last sync outcome is stored; live progress is not persisted, so there is no per-run history.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="device-sync-health",
        title="Biometric Device Sync Health",
        description="Configured biometric devices with live / silent / never status, last push and pull, punch volume and last auto-sync run.",
        category="attendance",
        icon="Fingerprint",
        tags=("biometric", "device", "sync", "health", "adms", "punch machine"),
        modules=("settings.devices", "attendance"),
        filters=(
            date_range("thisMonth", label="Punch volume period", max_days=92),
            select("deviceStatus", "Status", DEVICE_STATUS),
        ),
        columns=_DEVICE_COLS,
        run=_device_run,
    )
)
