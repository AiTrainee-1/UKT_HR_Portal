"""
Day-level attendance analysis (category "attendance"): absenteeism, worked hours vs schedule,
work on weekly-off / holiday, department strength, perfect attendance and the Form 12 style
adult-workers register.

Everything reads the stored ``AttendanceDayRecord`` verdicts (nothing here calls the engine, which
persists) and corrects, the way payroll's calendar does, for what the engine does not model:
Saturday-off Saturdays, joining / leaving dates and the production Sunday.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from django.db.models import Count, Q

from api.models import AttendanceLog, EmployeePermission, OvertimeRecord
from api.shift_engine import _t2s

from ..common import EMP_COLS, EMP_COLS_SHORT, emp_cells
from ..filters import boolean, date_range, period, select
from ..formatting import display_date, month_bounds
from ..registry import register
from ..types import (
    BADGE,
    DATE,
    HOURS,
    INTEGER,
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
    STATUS_LABELS,
    UNASSIGNED,
    Roster,
    classify_day,
    coverage_notes,
    day_abbr,
    day_records,
    days_between,
    emp_sort_key,
    hm,
    payroll_settings,
    people,
    scheduled_seconds,
    scope_filters,
    span_net_seconds,
    subtotals_within_limit,
)

MODULES = ("attendance",)


def _hours(seconds: float | None) -> float | None:
    return None if seconds is None else round(seconds / 3600, 2)


def _pct(part: float, whole: float) -> float | None:
    return round(part * 100.0 / whole, 1) if whole else None


def _scheduled(emp, d: date, roster: Roster, month_sets: dict, production_sunday_off: bool) -> bool:
    """Is ``d`` a day this employee is expected to work? Staff: payroll working days (no Sundays, Saturday-off
    Saturdays or Holiday rows). Production: every day except Holiday rows (and Sundays when asked)."""
    if emp.employment_type == "production":
        if roster.holiday_name(d) is not None:
            return False
        return not (production_sunday_off and d.weekday() == 6)
    key = (d.year, d.month)
    if key not in month_sets:
        month_sets[key] = roster.working_days(emp.id, d.year, d.month)
    return d in month_sets[key]


# ═════════════════════════════════════════════════════════════════════════════
#  absenteeism
# ═════════════════════════════════════════════════════════════════════════════

MIN_STREAK = (
    ("2", "2 or more days"),
    ("3", "3 or more days"),
    ("5", "5 or more days"),
    ("7", "7 or more days"),
    ("10", "10 or more days"),
)

_ABSENT_COLS = (
    *EMP_COLS,
    ColumnSpec("workingDays", "Working days", INTEGER, 0.9, total="sum"),
    ColumnSpec("absentDays", "Absent days", INTEGER, 0.9, total="sum"),
    ColumnSpec("leaveDays", "On leave", INTEGER, 0.8, total="sum"),
    ColumnSpec("informedDays", "Informed", INTEGER, 1.0, total="sum"),
    ColumnSpec("unauthorisedDays", "Unauthorised", INTEGER, 1.3, total="sum"),
    ColumnSpec("absentPct", "Absent %", PERCENT, 0.8),
    ColumnSpec("maxConsecutive", "Longest streak", INTEGER, 0.9),
    ColumnSpec("streakFrom", "Streak from", DATE, 1.4),
    ColumnSpec("streakTo", "Streak to", DATE, 1.4),
    ColumnSpec("currentStreak", "Current streak", INTEGER, 0.9),
    ColumnSpec("lastPresent", "Last present", DATE, 1.4),
    ColumnSpec("risk", "Risk", BADGE, 0.8),
)


def _risk(longest: int, pct: float | None) -> str:
    pct = pct or 0
    if longest >= 5 or pct >= 20:
        return "High"
    if longest >= 3 or pct >= 10:
        return "Medium"
    return "Low"


def _absenteeism_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    bridge = bool(ctx.params.get("bridgeWeeklyOffs"))
    prod_sunday_off = bool(ctx.params.get("productionSundayOff"))
    include_none = bool(ctx.params.get("includeNoAbsence"))
    threshold = int(ctx.params.get("minConsecutive") or 0)

    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)
    by_emp: dict[int, dict[date, object]] = defaultdict(dict)
    for rec in day_records(ctx, d_from, d_to):
        if rec.employee_id in people_by_id:
            by_emp[rec.employee_id][rec.date] = rec

    days = list(days_between(d_from, d_to))
    rows = []
    for emp_id, emp in people_by_id.items():
        recs = by_emp.get(emp_id)
        if not recs:
            continue
        month_sets: dict = {}
        working = absent = informed = leave = 0
        run = 0
        run_start = None
        best = (0, None, None)
        gap = False
        last_present = None
        for d in days:
            rec = recs.get(d)
            cls = classify_day(rec, emp, roster, ctx.today, prod_sunday_off) if rec is not None else None
            sched = _scheduled(emp, d, roster, month_sets, prod_sunday_off)
            if cls in (PRESENT, HALF):
                run, gap, run_start = 0, False, None
                last_present = d
                working += 1 if sched else 0
            elif cls == LEAVE:
                run, gap, run_start = 0, False, None
                working += 1 if sched else 0
                leave += 1 if sched else 0
            elif cls == ABSENT and sched:
                if gap:
                    run, gap, run_start = 0, False, None
                if run == 0:
                    run_start = d
                run += 1
                absent += 1
                working += 1
                if rec.is_informed:
                    informed += 1
                if run > best[0]:
                    best = (run, run_start, d)
            elif cls == PENDING:
                continue  # today is still running: neither absent nor a reason to break a streak
            elif cls == OFF or (cls == ABSENT and not sched):
                gap = gap or not bridge
            else:  # no stored record, or outside the employment window
                gap = True
        if not absent and not include_none:
            continue
        if threshold and best[0] < threshold:
            continue
        pct = _pct(absent, working)
        rows.append(
            (
                emp,
                {
                    **emp_cells(emp),
                    "workingDays": working,
                    "absentDays": absent,
                    "leaveDays": leave,
                    "informedDays": informed,
                    "unauthorisedDays": absent - informed,
                    "absentPct": pct,
                    "maxConsecutive": best[0],
                    "streakFrom": best[1].isoformat() if best[1] else None,
                    "streakTo": best[2].isoformat() if best[2] else None,
                    "currentStreak": run,
                    "lastPresent": last_present.isoformat() if last_present else None,
                    "risk": _risk(best[0], pct),
                },
            )
        )
    rows.sort(key=lambda t: emp_sort_key(t[0]))
    data = [t[1] for t in rows]

    tot_work = sum(r["workingDays"] for r in data)
    tot_abs = sum(r["absentDays"] for r in data)
    tot_inf = sum(r["informedDays"] for r in data)
    out_rows, sub_note = subtotals_within_limit(
        ctx,
        data,
        lambda r: r["department"],
        ["workingDays", "absentDays", "leaveDays", "informedDays", "unauthorisedDays"],
    )
    for r in out_rows:
        if r.get("_kind") == "subtotal":
            r["absentPct"] = _pct(r["absentDays"], r["workingDays"])
    flag = threshold or 3
    summary = [
        {"label": "Employees with absence", "value": sum(1 for r in data if r["absentDays"]), "format": "integer"},
        {"label": "Absent days", "value": tot_abs, "format": "integer"},
        {"label": "Absenteeism %", "value": _pct(tot_abs, tot_work), "format": "percent"},
        {"label": "Unauthorised days", "value": tot_abs - tot_inf, "format": "integer"},
        {
            "label": f"Streak of {flag}+ days",
            "value": sum(1 for r in data if r["maxConsecutive"] >= flag),
            "format": "integer",
        },
    ]
    totals = {
        "workingDays": tot_work,
        "absentDays": tot_abs,
        "leaveDays": sum(r["leaveDays"] for r in data),
        "informedDays": tot_inf,
        "unauthorisedDays": tot_abs - tot_inf,
        "absentPct": _pct(tot_abs, tot_work),
    }
    notes = [
        "Absent = an absent day record on a scheduled working day. Not counted: Sundays, Saturday-off Saturdays and Holiday "
        "rows, approved leave (shown in the On leave column and counted as a working day, not as absent), days before the joining date or after an approved last working day, days "
        "with no stored record, and today (still running).",
        "Unauthorised = absent days not marked Informed on the Report Log daily list. Streaks are measured inside the selected "
        "dates; "
        + (
            "weekly-offs and holidays between two absences do not break a streak (sandwich rule)."
            if bridge
            else "a weekly-off or holiday between two absences breaks the streak."
        ),
        "Risk: High = 5+ consecutive days or 20%+ absent; Medium = 3+ consecutive days or 10%+ absent; otherwise Low.",
    ]
    if prod_sunday_off:
        notes.append(
            "Production employees: Sundays are treated as weekly off (the engine itself counts a Sunday without punches as absent)."
        )
    else:
        notes.append(
            "Production employees: a Sunday without punches counts as absent (production payroll treats Sunday as a working day)."
        )
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=out_rows, summary=summary, notes=notes, totals=totals)


register(
    ReportSpec(
        id="absenteeism",
        title="Absentee Analysis",
        description="Absent days, unauthorised absence, longest and current consecutive streak and a risk band per employee.",
        category="attendance",
        icon="UserMinus",
        tags=("absent", "absenteeism", "consecutive", "unauthorised", "streak", "sandwich"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=92),
            *scope_filters(employment_default="staff"),
            select("minConsecutive", "Longest streak", MIN_STREAK, placeholder="Any absence"),
            boolean("bridgeWeeklyOffs", "Weekly-offs / holidays bridge a streak", default=True),
            boolean("productionSundayOff", "Production: treat Sunday as weekly off", default=True),
            boolean("includeNoAbsence", "Also list employees with no absence"),
        ),
        columns=_ABSENT_COLS,
        run=_absenteeism_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  worked-hours-shortfall
# ═════════════════════════════════════════════════════════════════════════════

MIN_SHORTFALL = (("15", "15+ minutes"), ("30", "30+ minutes"), ("60", "60+ minutes"))
_HOURS_VIEW = (("summary", "Summary (per employee)"), ("daily", "Daily detail"))
TAP_GAP_S = 300  # the same 5-minute double-tap rule the WhatsApp alerts use (whatsapp_alerts.collapse_taps)

_HOURS_SUMMARY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("daysWorked", "Days measured", INTEGER, 0.9, total="sum"),
    ColumnSpec("daysUnknown", "Days unknown", INTEGER, 0.9, total="sum"),
    ColumnSpec("scheduledHours", "Scheduled hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("workedHours", "Worked hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("shortfallHours", "Shortfall hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("excessHours", "Excess hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("avgHours", "Avg hrs / day", HOURS, 1.0),
)

_HOURS_DAILY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.3),
    ColumnSpec("scheduledHours", "Scheduled hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("workedHours", "Worked hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("shortfallHours", "Shortfall hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("excessHours", "Excess hrs", HOURS, 1.0, total="sum"),
    ColumnSpec("basis", "Basis", BADGE, 1.1),
)


def _collapse(seconds: list[int]) -> list[int]:
    """Sorted punch seconds with a tap within TAP_GAP_S of the previous one dropped."""
    kept: list[int] = []
    for t in sorted(seconds):
        if not kept or t - kept[-1] >= TAP_GAP_S:
            kept.append(t)
    return kept


def _day_punch_seconds(rec, own_times, next_times) -> list[int]:
    """The day's punches in seconds since its own midnight, cross-midnight aware, using the stored verdict.

    The engine drops a day's earliest punches when they were yesterday's late exit (they sit before the
    stored first punch) and adds the next date's early punches when this day's exit was made after midnight
    (the stored last punch is then earlier on the clock than the first)."""
    secs = sorted(_t2s(t) for t in own_times)
    if rec.first_punch is not None:
        first = _t2s(rec.first_punch)
        secs = [s for s in secs if s >= first]
    if rec.first_punch is not None and rec.last_punch is not None and _t2s(rec.last_punch) < _t2s(rec.first_punch):
        last = _t2s(rec.last_punch)
        secs += sorted(86400 + _t2s(t) for t in next_times if _t2s(t) <= last)
    return _collapse(secs)


def _worked_seconds(secs: list[int], shift, deduct_lunch: bool):
    """(worked seconds | None, basis). Even count of 4+ punches = paired in/out; otherwise first-to-last,
    less the shift's lunch when that span covers the first-half end (only if asked)."""
    n = len(secs)
    if n == 0:
        return None, "No punches"
    if n == 1:
        return None, "Single punch"
    if n >= 4 and n % 2 == 0:
        return sum(secs[i + 1] - secs[i] for i in range(0, n, 2)), "Paired"
    span = secs[-1] - secs[0]
    if deduct_lunch and shift is not None and shift.first_half_end and shift.lunch_duration_minutes:
        fhe = _t2s(shift.first_half_end)
        if secs[0] < fhe < secs[-1]:
            span = max(0, span - shift.lunch_duration_minutes * 60)
    return span, ("Span" if n == 2 else "Odd punches")


def _hours_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    view = ctx.params.get("view") or "summary"
    deduct = bool(ctx.params.get("deductLunch"))
    min_short = int(ctx.params.get("minShortfall") or 0)

    roster = Roster(ctx, d_from, d_to)
    people_by_id = {i: e for i, e in people(ctx).items() if e.employment_type == "staff"}
    logs: dict[tuple[int, date], list] = defaultdict(list)
    for eid, d, t in AttendanceLog.objects.filter(
        ctx.emp_q("employee__"), employee__employment_type="staff", date__gte=d_from, date__lte=d_to + timedelta(days=1)
    ).values_list("employee_id", "date", "punch_time"):
        logs[(eid, d)].append(t)

    every_day = []
    unknown: dict[int, int] = defaultdict(int)
    recs = day_records(ctx, d_from, d_to, status__in=("present", "half_shift"), employee__employment_type="staff")
    for rec in recs.order_by("employee_id", "date"):
        emp = people_by_id.get(rec.employee_id)
        if emp is None:
            continue
        shift = roster.shift_on(emp.id, rec.date)
        secs = _day_punch_seconds(
            rec, logs.get((emp.id, rec.date), []), logs.get((emp.id, rec.date + timedelta(days=1)), [])
        )
        worked, basis = _worked_seconds(secs, shift, deduct)
        sched = scheduled_seconds(shift)
        if sched is not None:
            sched = sched * min(1.0, float(rec.shifts_earned or 0) or 1.0)
        if worked is None:
            unknown[emp.id] += 1
        short = excess = None
        if worked is not None and sched is not None:
            short, excess = max(0.0, sched - worked), max(0.0, worked - sched)
        every_day.append((emp, rec, shift, sched, worked, short, excess, basis))
    every_day.sort(key=lambda t: (emp_sort_key(t[0]), t[1].date))

    # "Shortfall of at least" chooses WHICH rows are listed, never what an employee's figures are made of: the daily
    # view lists only the qualifying days, the summary view lists only the employees with at least one qualifying day
    # but keeps all of their days (days measured, averages and totals must not depend on a display filter).
    if min_short:

        def qualifies(t) -> bool:
            return t[5] is not None and t[5] >= min_short * 60

        if view == "daily":
            daily = [t for t in every_day if qualifies(t)]
        else:
            flagged = {t[0].id for t in every_day if qualifies(t)}
            daily = [t for t in every_day if t[0].id in flagged]
    else:
        daily = every_day

    tot = lambda idx: sum(t[idx] for t in daily if t[idx] is not None)  # noqa: E731
    measured = [t for t in daily if t[4] is not None]
    summary = [
        {"label": "Employees", "value": len({t[0].id for t in daily}), "format": "integer"},
        {
            "label": "Scheduled hours",
            "value": _hours(sum(t[3] for t in measured if t[3] is not None)),
            "format": "hours",
        },
        {"label": "Worked hours", "value": _hours(sum(t[4] for t in measured)), "format": "hours"},
        {"label": "Shortfall hours", "value": _hours(tot(5)), "format": "hours"},
        {"label": "Excess hours", "value": _hours(tot(6)), "format": "hours"},
    ]
    if view == "daily":
        rows = [
            {
                **emp_cells(emp),
                "date": rec.date.isoformat(),
                "day": day_abbr(rec.date),
                "shift": shift.name if shift else "No shift assigned",
                "scheduledHours": _hours(sched),
                "workedHours": _hours(worked),
                "shortfallHours": _hours(short),
                "excessHours": _hours(excess),
                "basis": basis,
            }
            for emp, rec, shift, sched, worked, short, excess, basis in daily[: ctx.row_limit]
        ]
        columns = list(_HOURS_DAILY_COLS)
        sub_note = None
    else:
        per: dict[int, dict] = {}
        for emp, _rec, _shift, sched, worked, short, excess, _basis in daily:
            a = per.setdefault(
                emp.id, {"emp": emp, "days": 0, "sched": 0.0, "worked": 0.0, "short": 0.0, "excess": 0.0}
            )
            if worked is None:
                continue
            a["days"] += 1
            a["sched"] += sched or 0.0
            a["worked"] += worked
            a["short"] += short or 0.0
            a["excess"] += excess or 0.0
        rows = [
            {
                **emp_cells(a["emp"]),
                "daysWorked": a["days"],
                "daysUnknown": unknown.get(eid, 0),
                "scheduledHours": _hours(a["sched"]),
                "workedHours": _hours(a["worked"]),
                "shortfallHours": _hours(a["short"]),
                "excessHours": _hours(a["excess"]),
                "avgHours": _hours(a["worked"] / a["days"]) if a["days"] else None,
            }
            for eid, a in sorted(per.items(), key=lambda kv: emp_sort_key(kv[1]["emp"]))
        ]
        rows, sub_note = subtotals_within_limit(
            ctx,
            rows,
            lambda r: r["department"],
            ["daysWorked", "daysUnknown", "scheduledHours", "workedHours", "shortfallHours", "excessHours"],
        )
        columns = list(_HOURS_SUMMARY_COLS)

    notes = [
        "Staff only: production wages are paid on shift credit, not hours. Hours here are informational; pay follows the attendance "
        "status, never the hours worked.",
        "Worked hours come from the day's raw punches (double taps within 5 minutes are collapsed). An even number of 4+ punches "
        "is paired in/out; a two-punch or odd day is first to last punch"
        + (", less the shift's lunch break when the span covers the first-half end" if deduct else "")
        + ". A single punch or a day without punches has no hours (counted as unknown).",
        "Scheduled hours = shift start to end less the lunch break; a half day is scheduled for half of that. Shortfall and excess "
        "are summed day by day, so an excess on one day does not cancel a shortfall on another.",
        "Cross-midnight exits use the stored verdict (the engine moves a late-night punch onto the day it belongs to).",
    ]
    if min_short:
        notes.append(
            f"Shortfall of at least {min_short} minutes: "
            + (
                "only the days with such a shortfall are listed."
                if view == "daily"
                else "only employees with at least one such day are listed; their figures still cover every day of the period."
            )
        )
    if any(t[2] is None for t in daily):
        notes.append("Days without a shift assignment have no scheduled hours, so no shortfall or excess.")
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes, columns=columns)


register(
    ReportSpec(
        id="worked-hours-shortfall",
        title="Worked Hours & Shortfall",
        description="Scheduled vs worked hours per employee or per day, with shortfall, excess and average hours.",
        category="attendance",
        icon="Timer",
        tags=("hours", "worked hours", "shortfall", "working hours", "short hours"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=31),
            *scope_filters(employment=False),
            select("view", "View", _HOURS_VIEW, default="summary", placeholder="Summary"),
            boolean("deductLunch", "Deduct lunch on two-punch days", default=True),
            select("minShortfall", "Shortfall of at least", MIN_SHORTFALL, placeholder="Any"),
        ),
        columns=_HOURS_SUMMARY_COLS,
        run=_hours_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  weekly-off-holiday-work
# ═════════════════════════════════════════════════════════════════════════════

DAY_TYPES = (("sunday", "Sunday"), ("saturday_off", "Saturday off"), ("holiday", "Holiday"))
_OT_LABEL = {
    ("announced", "pay"): "Pay announced",
    ("announced", "relaxation"): "Relaxation announced",
    ("detected", None): "Detected",
    ("rejected", None): "Rejected",
}

_OFFDAY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("dayType", "Day type", BADGE, 1.2),
    ColumnSpec("holidayName", "Holiday", TEXT, 1.5),
    ColumnSpec("firstIn", "First in", TIME, 0.8),
    ColumnSpec("lastOut", "Last out", TIME, 0.8),
    ColumnSpec("workedHours", "Hours (net of lunch)", HOURS, 1.1, total="sum"),
    ColumnSpec("status", "Day status", BADGE, 0.9),
    ColumnSpec("compDay", "Comp day", BADGE, 0.8),
    ColumnSpec("compensation", "OT / comp decision", BADGE, 1.4),
    ColumnSpec("source", "Source", TEXT, 1.1),
)


def _offday_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)
    want = ctx.params.get("dayType")

    holiday_dates = {d for d in roster.holidays if d_from <= d <= d_to}
    # Django week_day: 1 = Sunday ... 7 = Saturday. Only candidate days are read.
    qs = day_records(ctx, d_from, d_to, status__in=("present", "half_shift")).filter(
        Q(date__week_day__in=(1, 7)) | Q(date__in=holiday_dates)
    )
    ot = {
        (eid, d): (status, ctype)
        for eid, d, status, ctype in OvertimeRecord.objects.filter(
            ctx.emp_q("employee__"), date__gte=d_from, date__lte=d_to
        ).values_list("employee_id", "date", "status", "compensation_type")
    }

    built = []
    undecided = 0  # staff off-day workings HR has not announced as Overtime (pay) or relaxation: payroll pays nothing
    for rec in qs:
        emp = people_by_id.get(rec.employee_id)
        if emp is None:
            continue
        is_prod = emp.employment_type == "production"
        d = rec.date
        if d in holiday_dates:
            dtype = "holiday"
        elif d.weekday() == 6 and not is_prod:
            dtype = "sunday"
        elif d.weekday() == 5 and not is_prod and roster.saturday_off(emp.id, d):
            dtype = "saturday_off"
        else:
            continue  # a production Sunday, or an ordinary Saturday: a normal working day
        if want and dtype != want:
            continue
        shift = roster.shift_on(emp.id, d)
        net = span_net_seconds(rec.first_punch, rec.last_punch, shift)
        decision = ot.get((emp.id, d))
        if decision:
            label = _OT_LABEL.get(decision) or _OT_LABEL.get((decision[0], None)) or decision[0].title()
        else:
            label = "None announced"
        # A "detected" record is only the system's suggestion (payroll pays announced pay-type overtime alone), so a
        # detected day is as unpaid as one with no record at all.
        if emp.employment_type == "staff" and (decision is None or decision[0] == "detected"):
            undecided += 1
        built.append(
            (
                emp_sort_key(emp),
                d,
                emp,
                {
                    **emp_cells(emp),
                    "date": d.isoformat(),
                    "day": day_abbr(d),
                    "dayType": dict(DAY_TYPES)[dtype],
                    "holidayName": roster.holiday_name(d) if dtype == "holiday" else None,
                    "firstIn": hm(rec.first_punch),
                    "lastOut": hm(rec.last_punch),
                    "workedHours": _hours(net),
                    "status": STATUS_LABELS.get(rec.status, rec.status),
                    "compDay": "Comp day" if rec.is_compensation_day else None,
                    "compensation": label,
                    "source": "HR override" if rec.source == "manual" else rec.primary_source,
                },
            )
        )
    built.sort(key=lambda t: (t[0], t[1]))
    rows = [t[3] for t in built][: ctx.row_limit]
    summary = [
        {"label": "Off-day workings", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len({t[2].id for t in built}), "format": "integer"},
        {"label": "Hours worked", "value": round(sum(r["workedHours"] or 0 for r in rows), 2), "format": "hours"},
        {"label": "Staff days with no OT / comp decision", "value": undecided, "format": "integer"},
    ]
    rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], ["workedHours"])
    notes = [
        "Days a person worked on a Sunday or a Saturday-off Saturday (staff) or on a company Holiday (staff and production), from "
        "the stored day records. Production employees work Sundays as a normal day, so only their Holiday work is listed.",
        "Staff payroll pays only working days: work on a weekly-off or holiday is unpaid unless HR announces Overtime (pay) or a "
        "compensation day (relaxation). The OT / comp column shows that decision when one exists; a merely Detected overtime "
        "record is not a decision and stays unpaid until HR announces it, so it is counted with the days that have no decision.",
        "Hours = first to last punch less the shift's lunch break when the span covers the first-half end. Holiday rows apply company-wide "
        "(the engine ignores their branch / department scope).",
    ]
    settings = payroll_settings()
    if not settings.compensation_feature_enabled:
        notes.append(
            "The Compensation feature is switched off in Settings > Payroll, so overtime is not detected or paid and no "
            "compensation credit is issued: every staff day listed here is unpaid, whatever decision the column shows "
            "(decisions recorded while the feature was on are kept but have no effect)."
        )
    elif not settings.ot_detection_enabled:
        notes.append(
            "Overtime detection is switched off in Settings > Payroll: no new Detected overtime is recorded, so a worked "
            "weekly-off or holiday only turns into pay when HR announces it by hand."
        )
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="weekly-off-holiday-work",
        title="Worked on Weekly-Off / Holiday",
        description="Who worked on Sundays, Saturday-off Saturdays and company holidays, with hours and any OT / comp decision.",
        category="attendance",
        icon="CalendarClock",
        tags=("sunday", "holiday", "weekly off", "comp off", "compensatory", "overtime"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=366),
            *scope_filters(employment_default="staff"),
            select("dayType", "Day type", DAY_TYPES),
        ),
        columns=_OFFDAY_COLS,
        run=_offday_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  department-strength
# ═════════════════════════════════════════════════════════════════════════════

_GROUP_BY = (
    ("date", "Date (departments listed under each day)"),
    ("department", "Department (days listed under each department)"),
)

_STRENGTH_COLS = (
    ColumnSpec("department", "Department", TEXT, 2.0),
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("onRoll", "On roll", INTEGER, 0.8, total="sum"),
    ColumnSpec("present", "Present", INTEGER, 0.8, total="sum"),
    ColumnSpec("halfDay", "Half day", INTEGER, 0.8, total="sum"),
    ColumnSpec("absent", "Absent", INTEGER, 0.8, total="sum"),
    ColumnSpec("onLeave", "On leave", INTEGER, 0.8, total="sum"),
    ColumnSpec("onDuty", "On duty (in present)", INTEGER, 1.1, total="sum"),
    ColumnSpec("weeklyOffHoliday", "Weekly off / holiday", INTEGER, 1.1, total="sum"),
    ColumnSpec("notComputed", "No record yet", INTEGER, 0.9, total="sum"),
    ColumnSpec("late", "Late", INTEGER, 0.7, total="sum"),
    ColumnSpec("strengthPct", "Strength %", PERCENT, 0.9),
    ColumnSpec("shiftCredit", "Shift credit", NUMBER, 0.9, total="sum"),
)
_STRENGTH_SUM = [
    "onRoll",
    "present",
    "halfDay",
    "absent",
    "onLeave",
    "onDuty",
    "weeklyOffHoliday",
    "notComputed",
    "late",
    "shiftCredit",
]


def _strength_pct(row: dict) -> float | None:
    expected = row["onRoll"] - row["weeklyOffHoliday"]
    return _pct(row["present"] + row["halfDay"], expected)


def _strength_run(ctx):
    d_from = ctx.date_from
    d_to = min(ctx.date_to, ctx.today)
    group_by = ctx.params.get("groupBy") or "date"
    if d_to < d_from:
        return ReportResult(rows=[], notes=["The selected dates are in the future: no attendance exists yet."])

    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)
    recs = {(r.employee_id, r.date): r for r in day_records(ctx, d_from, d_to) if r.employee_id in people_by_id}
    # Days on which an approved On-Duty punch exists (people working off-site): one query, no per-row lookups.
    on_duty = set(
        AttendanceLog.objects.filter(
            ctx.emp_q("employee__"), date__gte=d_from, date__lte=d_to, source="on_duty:approved"
        )
        .order_by()
        .values_list("employee_id", "date")
        .distinct()
    )

    agg: dict[tuple, dict] = {}
    dept_names: dict = {}
    for d in days_between(d_from, d_to):
        for emp in people_by_id.values():
            rec = recs.get((emp.id, d))
            worked = rec is not None and rec.status in ("present", "half_shift")
            if roster.outside_employment(emp, d) and not worked:
                continue
            exit_known = roster.exits.get(emp.id)
            if not (emp.status == "active" or rec is not None or (exit_known and exit_known >= d)):
                continue
            key_dept = emp.department_id
            dept_names[key_dept] = emp.department.name if emp.department_id else UNASSIGNED
            a = agg.setdefault((d, key_dept), dict.fromkeys(_STRENGTH_SUM, 0))
            a["onRoll"] += 1
            if rec is None:
                a["notComputed"] += 1
                continue
            cls = classify_day(rec, emp, roster, ctx.today)
            if cls == PRESENT:
                a["present"] += 1
            elif cls == HALF:
                a["halfDay"] += 1
            elif cls in (ABSENT, PENDING):
                a["absent"] += 1
            elif cls == LEAVE:
                a["onLeave"] += 1
            elif cls == OFF:
                a["weeklyOffHoliday"] += 1
            if cls in (PRESENT, HALF) and (emp.id, d) in on_duty:
                a["onDuty"] += 1
            a["late"] += 1 if rec.is_late else 0
            a["shiftCredit"] += float(rec.shifts_earned or 0)

    def dept_key(dept_id):
        return (1, "", 0) if dept_id is None else (0, dept_names[dept_id].lower(), dept_id)

    keys = sorted(
        agg, key=(lambda k: (k[0], dept_key(k[1]))) if group_by == "date" else (lambda k: (dept_key(k[1]), k[0]))
    )
    data = []
    for d, dept_id in keys:
        a = agg[(d, dept_id)]
        row = {"department": dept_names[dept_id], "date": d.isoformat(), **a, "shiftCredit": round(a["shiftCredit"], 2)}
        row["strengthPct"] = _strength_pct(row)
        data.append(row)

    if group_by == "date":
        rows, sub_note = subtotals_within_limit(
            ctx,
            data,
            lambda r: r["date"],
            _STRENGTH_SUM,
            what="Day",
            label_key="department",
            label=lambda g: f"{display_date(g)} total",
        )
    else:
        rows, sub_note = subtotals_within_limit(
            ctx,
            data,
            lambda r: r["department"],
            _STRENGTH_SUM,
            label_key="department",
            label=lambda g: f"{g} total",
        )
    for r in rows:
        if r.get("_kind") == "subtotal":
            r["strengthPct"] = _strength_pct(r)

    grand = {k: sum(r[k] for r in data) for k in _STRENGTH_SUM}
    grand["shiftCredit"] = round(grand["shiftCredit"], 2)
    grand["strengthPct"] = _strength_pct(grand)
    summary = [
        {"label": "Average strength %", "value": grand["strengthPct"], "format": "percent"},
        {"label": "Present man-days", "value": grand["present"] + grand["halfDay"], "format": "integer"},
        {"label": "Absent man-days", "value": grand["absent"], "format": "integer"},
        {"label": "Late man-days", "value": grand["late"], "format": "integer"},
        {"label": "Employee-days with no record yet", "value": grand["notComputed"], "format": "integer"},
    ]
    notes = [
        "On roll = employees employed that day (from the joining date to an approved last working day; an employee marked inactive "
        "with no leaving date is counted only on days that have a record). Present and half-day heads count 1 each (strength).",
        "Strength % = (present + half day) / (on roll - weekly off / holiday). Saturday-off Saturdays count as weekly off for staff; "
        "the engine records them as absent. Today's absences are provisional while the day is running.",
        "No record yet = employees on roll whose day nobody has opened in Attendance; they are neither present nor absent until computed. "
        "Future dates are not shown.",
        "On duty counts present / half-day employees who have an approved On-Duty punch that day (working away from the "
        "branch); they are already included in Present / Half day, so it is not added to the strength.",
        "Production employees work Sundays as a normal day, so a Sunday without punches counts as absent for them; staff "
        "Sundays are weekly off.",
        "Shift credit is the stored shift value (staff 0 / 0.5 / 1; production up to 1.5), so staff and production credits are not "
        "directly comparable.",
    ]
    if ctx.date_to > ctx.today:
        notes.append("Dates after today are omitted.")
    if sub_note:
        notes.append(sub_note)
    return ReportResult(rows=rows, summary=summary, notes=notes, totals={k: v for k, v in grand.items()})


register(
    ReportSpec(
        id="department-strength",
        title="Department-wise Daily Strength",
        description="Headcount on roll vs present, half-day, absent, on-leave and weekly-off strength per department per day.",
        category="attendance",
        icon="Users",
        tags=("strength", "headcount", "department", "daily strength", "manpower"),
        modules=MODULES,
        filters=(
            date_range("today", max_days=31),
            *scope_filters(status="all", designation=False, employee=False),
            select("groupBy", "Group by", _GROUP_BY, default="date", placeholder="Date"),
        ),
        columns=_STRENGTH_COLS,
        run=_strength_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  perfect-attendance
# ═════════════════════════════════════════════════════════════════════════════

ALLOW_LATE = (("0", "None"), ("1", "1 late"), ("2", "2 lates"), ("3", "3 lates"))

_PERFECT_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("workingDays", "Working days", INTEGER, 0.9),
    ColumnSpec("presentDays", "Full days present", INTEGER, 1.0),
    ColumnSpec("absentDays", "Absent", INTEGER, 0.9),
    ColumnSpec("halfDays", "Half days", INTEGER, 0.8),
    ColumnSpec("leaveDays", "Leave", INTEGER, 0.7),
    ColumnSpec("lateCount", "Late / early-out days", INTEGER, 1.1),
    ColumnSpec("permissions", "Permissions", INTEGER, 1.1),
    ColumnSpec("eligible", "Eligible", BADGE, 1.2),
    ColumnSpec("reasonNot", "Why not", TEXT, 3.0),
)


def _perfect_run(ctx):
    year, month = ctx.period
    m_from, m_to = month_bounds(year, month)
    allow_late = int(ctx.params.get("allowLate") or 0)
    allow_perm = bool(ctx.params.get("allowPermission"))
    complete = ctx.today > m_to

    roster = Roster(ctx, m_from, m_to)
    staff = {i: e for i, e in people(ctx).items() if e.employment_type == "staff"}
    by_emp: dict[int, dict[date, object]] = defaultdict(dict)
    for rec in day_records(ctx, m_from, m_to):
        if rec.employee_id in staff:
            by_emp[rec.employee_id][rec.date] = rec
    # Only people who were on the rolls during the month are judged: not someone who joins after it (their
    # month has no working day at all) nor someone who left before it, whatever the status filter says.
    staff = {
        i: e
        for i, e in staff.items()
        if roster.employed_between(
            e, m_from, m_to, worked=any(r.status in ("present", "half_shift") for r in by_emp.get(i, {}).values())
        )
    }
    perms = dict(
        EmployeePermission.objects.filter(ctx.emp_q("employee__"), status="approved", date__gte=m_from, date__lte=m_to)
        .values("employee_id")
        .annotate(n=Count("id"))
        .values_list("employee_id", "n")
    )

    out = []
    for emp_id, emp in staff.items():
        recs = by_emp.get(emp_id, {})
        working = sorted(roster.working_days(emp_id, year, month))
        n_pres = n_abs = n_half = n_leave = n_late = n_missing = n_after_exit = 0
        left = roster.exits.get(emp_id)
        for d in working:
            if d >= ctx.today:
                continue  # today and later are not judged yet
            rec = recs.get(d)
            if rec is None:
                if roster.outside_employment(emp, d):
                    n_after_exit += 1 if (left and d > left) else 0  # before joining: the "joined" reason covers it
                else:
                    n_missing += 1
                continue
            cls = classify_day(rec, emp, roster, ctx.today)
            if cls == MASKED:
                n_after_exit += 1 if (left and d > left) else 0
                continue
            if cls == PRESENT:
                n_pres += 1
            elif cls == HALF:
                n_half += 1
            elif cls == ABSENT:
                n_abs += 1
            elif cls == LEAVE:
                n_leave += 1
            if cls in (PRESENT, HALF) and (rec.is_late or rec.early_leave):
                n_late += 1
        n_perm = perms.get(emp_id, 0)
        joined = roster.join_date(emp)
        reasons = []
        if joined and joined > m_from:
            reasons.append(f"joined {display_date(joined)} (mid-month)")
        if n_after_exit:
            reasons.append(f"left {display_date(left)} (mid-month)")
        if n_abs:
            reasons.append(f"{n_abs} absent")
        if n_half:
            reasons.append(f"{n_half} half day")
        if n_leave:
            reasons.append(f"{n_leave} on leave")
        if n_late > allow_late:
            reasons.append(f"{n_late} late/early-out (allowed {allow_late})")
        if n_missing:
            reasons.append(f"{n_missing} day(s) not computed yet")
        if n_perm and not allow_perm:
            reasons.append(f"{n_perm} permission(s)")
        if reasons:
            eligible = "Not eligible"
        else:
            eligible = "Eligible" if complete else "On track"
        out.append(
            (
                emp,
                {
                    **emp_cells(emp),
                    "workingDays": len(working),
                    "presentDays": n_pres,
                    "absentDays": n_abs,
                    "halfDays": n_half,
                    "leaveDays": n_leave,
                    "lateCount": n_late,
                    "permissions": n_perm,
                    "eligible": eligible,
                    "reasonNot": "; ".join(reasons) or None,
                },
            )
        )
    out.sort(key=lambda t: emp_sort_key(t[0]))
    rows = [t[1] for t in out]
    total = len(rows)
    ok = sum(1 for r in rows if r["eligible"] in ("Eligible", "On track"))
    summary = [
        {"label": "Employees checked", "value": total, "format": "integer"},
        {"label": "Eligible" if complete else "On track", "value": ok, "format": "integer"},
        {"label": "Not eligible", "value": total - ok, "format": "integer"},
        {"label": "Eligible %", "value": _pct(ok, total), "format": "percent"},
    ]
    notes = [
        "Staff only. Eligible = a full day present on every payroll working day of the month, no half days, no unpaid leave, "
        f"no more than {allow_late} late / early-out day(s)"
        + ("" if allow_perm else ", and no approved permission")
        + ". Casual-leave days are recorded as paid present days by the attendance engine and therefore count as present.",
        "Employees who joined after the first of the month, or who left before its last working day, are never eligible for "
        "that month. Someone who joined after the month ended, or left before it began, is not listed.",
    ]
    if not complete:
        notes.append(
            "The month is still running: 'On track' means no disqualifying day so far; eligibility is final only after the last day."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="perfect-attendance",
        title="Perfect Attendance",
        description="Staff with no absence, half day, leave or late in the month (incentive eligibility), with the reason for the rest.",
        category="attendance",
        icon="BadgeCheck",
        tags=("perfect attendance", "incentive", "attendance bonus", "award", "eligibility"),
        modules=MODULES,
        filters=(
            period("lastMonth"),
            *scope_filters(status="active", employment=False),
            select("allowLate", "Lates allowed", ALLOW_LATE, default="0", placeholder="None"),
            boolean("allowPermission", "Approved permissions do not disqualify", default=True),
        ),
        columns=_PERFECT_COLS,
        run=_perfect_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  form12-adult-workers-register
# ═════════════════════════════════════════════════════════════════════════════

_FORM12_COLS = (
    ColumnSpec("sno", "S.No", INTEGER, 0.6),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Name of worker", TEXT, 2.2),
    ColumnSpec("fatherName", "Father's name", TEXT, 1.8),
    ColumnSpec("gender", "Sex", TEXT, 0.6),
    ColumnSpec("dob", "Date of birth", DATE, 1.4),
    ColumnSpec("designation", "Nature of work", TEXT, 1.5),
    ColumnSpec("joinDate", "Date of joining", DATE, 1.4),
    ColumnSpec("shift", "Shift / relay", TEXT, 1.8),
    ColumnSpec("weeklyOffDay", "Weekly off", TEXT, 1.2),
    ColumnSpec("daysWorked", "Days worked", INTEGER, 1.0, total="sum"),
    ColumnSpec("totalHours", "Hours worked", HOURS, 0.9, total="sum"),
    ColumnSpec("otHours", "Overtime hrs", HOURS, 1.1, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 3.0),
)


def _age_on(dob: date, on: date) -> int:
    return on.year - dob.year - ((on.month, on.day) < (dob.month, dob.day))


def _form12_run(ctx):
    year, month = ctx.period
    m_from, m_to = month_bounds(year, month)
    roster = Roster(ctx, m_from, m_to)
    staff = people(ctx, "father_name", "gender", "date_of_birth")
    by_emp: dict[int, list] = defaultdict(list)
    for rec in day_records(ctx, m_from, m_to, status__in=("present", "half_shift")).order_by("date"):
        if rec.employee_id in staff:
            by_emp[rec.employee_id].append(rec)
    ot_min: dict[int, int] = defaultdict(int)
    for eid, minutes in (
        OvertimeRecord.objects.filter(ctx.emp_q("employee__"), date__gte=m_from, date__lte=m_to)
        .exclude(status="rejected")
        .values_list("employee_id", "ot_minutes")
    ):
        ot_min[eid] += minutes or 0

    data = []
    for emp_id in sorted(staff, key=lambda i: emp_sort_key(staff[i])):
        emp = staff[emp_id]
        recs = by_emp.get(emp_id, [])
        # A month's register lists the people employed in that month: a leaver who worked part of it stays,
        # someone who joins after it (or left before it) is not part of it.
        if not roster.employed_between(emp, m_from, m_to, worked=bool(recs)):
            continue
        secs = 0
        for rec in recs:
            net = span_net_seconds(rec.first_punch, rec.last_punch, roster.shift_on(emp_id, rec.date))
            secs += net or 0
        asg = roster.assignment_on(emp_id, m_from.replace(day=15))
        if asg is not None:
            start = asg.custom_start_time or asg.shift.start_time
            end = asg.custom_end_time or asg.shift.end_time
            shift_text = f"{asg.shift.name} ({hm(start)}-{hm(end)})"
        else:
            shift_text = None
        weekly = None
        if emp.employment_type == "staff":
            weekly = "Sunday + Saturday" if asg is not None and asg.saturday_off else "Sunday"
        joined = roster.join_date(emp)
        dob = emp.date_of_birth
        remarks = []
        if not emp.father_name:
            remarks.append("father's name not recorded")
        if dob is None:
            remarks.append("date of birth not recorded")
        elif _age_on(dob, m_to) < 18:
            remarks.append("under 18: check adult-worker eligibility")
        if joined is None:
            remarks.append("joining date not recorded")
        elif joined > m_from:
            remarks.append("joined this month")
        left = roster.exits.get(emp_id)
        if left is not None and m_from <= left <= m_to:
            remarks.append(f"left {display_date(left)}")
        elif left is None and emp.status != "active":
            remarks.append("no longer active (no leaving date recorded)")
        data.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "fatherName": emp.father_name or None,
                "gender": (emp.gender or "").title() or None,
                "dob": dob.isoformat() if dob else None,
                "designation": emp.designation.title if emp.designation_id else None,
                "joinDate": joined.isoformat() if joined else None,
                "shift": shift_text,
                "weeklyOffDay": weekly,
                "daysWorked": len(recs),
                "totalHours": _hours(secs) if recs else None,
                "otHours": round(ot_min[emp_id] / 60, 2) if emp_id in ot_min else None,
                "remarks": "; ".join(remarks) or None,
                "department": emp.department.name if emp.department_id else UNASSIGNED,
            }
        )
    for i, r in enumerate(data, start=1):
        r["sno"] = i
    rows, sub_note = subtotals_within_limit(
        ctx,
        data,
        lambda r: r["department"],
        ["daysWorked", "totalHours", "otHours"],
        label_key="employeeName",
        label=lambda g: f"{g} total",
    )
    summary = [
        {"label": "Workers", "value": len(data), "format": "integer"},
        {"label": "Days worked", "value": sum(r["daysWorked"] for r in data), "format": "integer"},
        {"label": "Hours worked", "value": round(sum(r["totalHours"] or 0 for r in data), 2), "format": "hours"},
        {"label": "Overtime hours", "value": round(sum(r["otHours"] or 0 for r in data), 2), "format": "hours"},
    ]
    notes = [
        "A Form 12 style summary for the month: worker particulars from the employee master plus attendance from the stored day "
        "records. The statutory layout differs by state, so treat this as a working register, not a filed return.",
        "Days worked = full and half days present. Hours = first to last punch less the shift's lunch break when the span covers "
        "the first-half end (a two-punch day has no lunch punches); Overtime hours are the minutes recorded on approved / detected "
        "overtime records only (pay is per day, so hours are informational) and show a dash when none exist.",
        "Weekly off: the system treats Sunday (and Saturday for Saturday-off staff) as the weekly off; production employees work "
        "Sundays as a normal day, so no weekly-off day is shown for them.",
        "Everyone employed at any time in the month is listed, including people who left during it; someone who joined after "
        "the month, or left before it, is not. Set Employee status to Active to list current employees only.",
    ]
    if sub_note:
        notes.append(sub_note)
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="form12-adult-workers-register",
        title="Adult Workers Register (Form 12 style)",
        description="Monthly register of worker particulars, shift, weekly off, days and hours worked and overtime for inspection.",
        category="attendance",
        icon="ClipboardList",
        tags=("form 12", "factories act", "adult workers", "statutory", "register", "inspection"),
        modules=("employees",),  # father's name and date of birth are employee-master data
        filters=(
            period("lastMonth"),
            # a register of a past month must show the people who worked it and have since left
            *scope_filters(status="all"),
        ),
        columns=_FORM12_COLS,
        run=_form12_run,
    )
)
