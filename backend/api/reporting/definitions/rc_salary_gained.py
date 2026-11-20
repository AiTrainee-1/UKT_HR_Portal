"""Salary category: gained-salary-report and expected-salary-report, salary worked out from attendance BEFORE (or
without) payroll.

Both read the STORED attendance days (AttendanceDayRecord, what payroll pays from) and price them the way the payroll
engines do; nothing is computed, recomputed or saved.

Staff (payroll_views._generate_staff_payroll, company month policy of 2026-11-04):
    company days  = the month's days but Sundays (and Saturdays on a Saturday-off shift), holidays INCLUDED
                    (payroll_views._build_working_days with no holidays; the shift assignment in force on the 15th decides
                    Saturday-off, as payroll_views.staff_pay_days)
    per-day rate  = monthly salary / company days (payroll_views.staff_daily_rate shows it rounded to the paisa; the
                    amounts use the exact rate and are rounded once, as payroll does)
    paid days     = on each working day (company days without the holidays): the stored shifts earned of a present /
                    half-shift day (a quarter day 0.25 / 0.75, a half day 0.5; a present day with no shifts stored 1), 1 for
                    a day HR marked as a holiday, 0 for absent / leave; plus 1 for every declared holiday on a company
                    day from the join date on
    gained        = per-day rate x paid days up to the cut-off day
Production (payroll_views._generate_production_payroll):
    gained        = the stored shifts earned of every day in the window up to the cut-off day x the rate per shift

Expected = gained + the days still to come at full attendance: staff, every working day after the cut-off (from the join
date on) and every holiday still to come, at the per-day rate; production, one shift for every day after the cut-off that
is not a Sunday or a declared holiday, at the rate per shift. Next to it the fixed monthly salary (production: the pay for
one shift on every such day of the window) and the difference.

Cut-off day: today in the current month, the month's last day for a past month (a future month has gained nothing yet).
Production window (filter "Production days"): the chosen calendar month (default), or the worker's own pay period
(Weekly / BiWeekly / Monthly, production_period.resolve_cycle_period) that holds the cut-off day.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from api.compensation_shared import parse_join_date
from api.models import AttendanceDayRecord, Holiday
from api.payroll_insights import assignments_on
from api.payroll_views import _build_working_days
from api.production_cycles import CYCLE_LABELS
from api.production_period import InvalidPeriodConfig, resolve_cycle_period

from .. import filters as F
from ..formatting import display_date
from ..registry import register
from ..types import CURRENCY, DATE, INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import rc_salary_common as C

MODULES = ("payroll", "production_payroll", "salary")
WINDOW_MONTH, WINDOW_PERIOD = "month", "payPeriod"
WINDOW_OPTIONS = (
    (WINDOW_MONTH, "The chosen month"),
    (WINDOW_PERIOD, "The worker's pay period"),
)
ONE = Decimal("1")
QUARTER = Decimal("0.25")
PRESENT_STATUSES = (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)


@dataclass
class Figures:
    """One employee's gained / expected salary."""

    emp: object
    kind: str
    start: date
    end: date
    cutoff: date
    fixed: Decimal | None = None  # staff: monthly salary; production: full-attendance pay for the window
    rate: Decimal | None = None  # staff: per-day rate (rounded); production: rate per shift
    rate_exact: Decimal | None = None
    days_so_far: int = 0  # working days up to the cut-off (from the join date on)
    shifts: Decimal = C.ZERO  # staff: shifts earned on working days; production: shifts earned
    holidays: Decimal = C.ZERO  # staff: holidays paid up to the cut-off (+ days HR marked as a holiday)
    paid: Decimal = C.ZERO  # what the rate multiplies: staff paid days, production shifts
    gained: Decimal | None = None
    to_come: Decimal = C.ZERO  # staff: working days + holidays still to come; production: shifts still to come
    to_come_amount: Decimal | None = None
    expected: Decimal | None = None
    cycle: str | None = None
    remarks: list[str] = field(default_factory=list)

    @property
    def difference(self) -> Decimal | None:
        if self.expected is None or self.fixed is None:
            return None
        return self.expected - self.fixed


def _cutoff(ctx, start: date, end: date) -> date:
    """Today in the current month, the window's last day once it is over; the day before it when it has not begun."""
    today = ctx.today
    if today < start:
        return start - timedelta(days=1)
    return min(today, end)


def _reference_day(ctx, m_start: date, m_end: date) -> date:
    """The day a worker's pay period is picked by: today in the current month, else the month's last (past) or first
    (future) day."""
    return min(max(ctx.today, m_start), m_end)


def _staff(emp, records: dict, holidays: set, year: int, month: int, sat_off: bool, ctx) -> Figures:
    m_start, m_end = C.month_bounds(year, month)
    cutoff = _cutoff(ctx, m_start, m_end)
    today = ctx.today
    f = Figures(emp, C.STAFF, m_start, m_end, cutoff)
    work_days = _build_working_days(month, year, sat_off, holidays)
    pay_days = _build_working_days(month, year, sat_off, set())
    company_days = len(pay_days)
    salary = Decimal(str(emp.salary_amount)) if emp.salary_amount else None
    if not salary or not company_days:
        f.remarks.append("NO MONTHLY SALARY" if not salary else "NO WORKING DAYS")
        return f
    f.fixed = C.d2(salary)
    f.rate_exact = salary / Decimal(company_days)
    f.rate = C.d2(f.rate_exact)
    joined, _state = C.join_date(emp)
    # payroll pays a declared holiday from the join date as IT reads it (compensation_shared.parse_join_date)
    paid_from = parse_join_date(emp.join_date)
    not_computed = 0
    for d in work_days:
        if joined is not None and d < joined:
            continue
        rec = records.get(d)
        if d <= cutoff:
            f.days_so_far += 1
            if rec is None:
                not_computed += d < today
                if d == today:
                    f.to_come += ONE  # today not computed yet: still to come
                continue
            status, shifts = rec
            if status in PRESENT_STATUSES:
                f.shifts += shifts if shifts > 0 else ONE
            elif status == AttendanceDayRecord.STATUS_HOLIDAY:
                f.holidays += ONE
        else:
            f.to_come += ONE
    for d in pay_days:
        if d in holidays and (paid_from is None or d >= paid_from):
            if d <= cutoff:
                f.holidays += ONE
            else:
                f.to_come += ONE
    f.paid = f.shifts + f.holidays
    f.gained = C.d2(f.rate_exact * f.paid)
    f.expected = C.d2(f.rate_exact * (f.paid + f.to_come))
    f.to_come_amount = f.expected - f.gained
    if not_computed:
        f.remarks.append(f"{not_computed} DAY(S) NOT COMPUTED")
    if joined is not None and m_start < joined <= m_end:
        f.remarks.append(f"JOINED {joined.day:02d}-{joined.month:02d}")
    return f


def _production(emp, records: dict, holidays: set, start: date, end: date, ctx, cycle: str | None) -> Figures:
    cutoff = _cutoff(ctx, start, end)
    today = ctx.today
    f = Figures(emp, C.PRODUCTION, start, end, cutoff, cycle=cycle)
    rate = Decimal(str(emp.salary_per_shift)) if emp.salary_per_shift else None
    joined, _state = C.join_date(emp)
    off_grid = 0
    full_days = 0
    d = start
    while d <= end:
        working = d.weekday() != 6 and d not in holidays and (joined is None or d >= joined)
        full_days += working
        rec = records.get(d)
        if d <= cutoff and rec is not None:
            shifts = rec[1]
            f.shifts += shifts
            off_grid += (shifts % QUARTER) != 0
        if working:
            if d <= cutoff:
                f.days_so_far += 1
                if rec is None and d == today:
                    f.to_come += ONE
            else:
                f.to_come += ONE
        d += timedelta(days=1)
    f.paid = f.shifts
    if off_grid:
        f.remarks.append(f"{off_grid} DAY(S) OUT OF DATE")
    if not rate:
        f.remarks.append("NO RATE PER SHIFT")
        return f
    f.rate = f.rate_exact = C.d2(rate)
    f.fixed = C.d2(rate * full_days)
    f.gained = C.d2(rate * f.shifts)
    f.to_come_amount = C.d2(rate * f.to_come)
    f.expected = f.gained + f.to_come_amount
    return f


def compute(ctx) -> tuple[list[Figures], list[str]]:
    """Every employee in scope with their figures, and the notes the run found. A fixed number of queries: employees,
    stored days, holidays, shift assignments, settings."""
    year, month = ctx.period
    m_start, m_end = C.month_bounds(year, month)
    kinds, notes = C.visible_kinds(ctx, C.SALARY_MODULES)
    emps = list(C.employees_by_kind(ctx, kinds)[: ctx.row_limit])
    staff = [e for e in emps if e.employment_type == C.STAFF]
    production = [e for e in emps if e.employment_type == C.PRODUCTION]

    window = ctx.params.get("window") or WINDOW_MONTH
    windows: dict[int, tuple[date, date, str | None]] = {}
    if production:
        ref = _reference_day(ctx, m_start, m_end)
        ps = C.read_settings(ctx.request) if window == WINDOW_PERIOD else None
        periods: dict[str, tuple[date, date] | None] = {}
        for e in production:
            cycle = e.production_pay_cycle or None
            if window == WINDOW_PERIOD and cycle and ps is not None:
                if cycle not in periods:
                    try:
                        periods[cycle] = resolve_cycle_period(ref, ps, cycle)
                    except InvalidPeriodConfig as exc:
                        periods[cycle] = None
                        notes.append(f"{CYCLE_LABELS.get(cycle, cycle)}: {exc} The calendar month is used instead.")
                got = periods[cycle]
                windows[e.id] = (*got, cycle) if got else (m_start, m_end, cycle)
            else:
                windows[e.id] = (m_start, m_end, cycle)
    lo = min([m_start, *(w[0] for w in windows.values())])
    hi = max([m_end, *(w[1] for w in windows.values())])

    records: dict[int, dict[date, tuple[str, Decimal]]] = defaultdict(dict)
    if emps:
        for emp_id, day, status, shifts in AttendanceDayRecord.objects.filter(
            employee_id__in=[e.id for e in emps], date__gte=lo, date__lte=hi
        ).values_list("employee_id", "date", "status", "shifts_earned"):
            records[emp_id][day] = (status, Decimal(str(shifts or 0)))
    holidays = set(Holiday.objects.filter(date__gte=lo, date__lte=hi).values_list("date", flat=True))
    month_holidays = {d for d in holidays if m_start <= d <= m_end}
    assignments = assignments_on([e.id for e in staff], date(year, month, 15)) if staff else {}

    out: list[Figures] = []
    for e in emps:
        if e.employment_type == C.STAFF:
            sat_off = bool(assignments[e.id].saturday_off) if e.id in assignments else False
            out.append(_staff(e, records[e.id], month_holidays, year, month, sat_off, ctx))
        else:
            start, end, cycle = windows[e.id]
            out.append(_production(e, records[e.id], holidays, start, end, ctx, cycle))
    if production and window == WINDOW_PERIOD and not any(e.production_pay_cycle for e in production):
        notes.append("No production worker in this selection is on a pay cycle, so their calendar month is shown.")
    return out, notes


# ── rows ─────────────────────────────────────────────────────────────────────

ID_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("designation", "Designation", TEXT, 1.3),
    ColumnSpec("type", "Type", TEXT, 0.9),
    ColumnSpec("cycle", "Pay cycle", TEXT, 0.9),
    ColumnSpec("from", "From", DATE, 1.0),
    ColumnSpec("to", "To", DATE, 1.0),
    ColumnSpec("upTo", "Up to", DATE, 1.0),
)
GAINED_COLUMNS = (
    *ID_COLUMNS,
    ColumnSpec("fixed", "Fixed salary", CURRENCY, 1.15, total="sum"),
    ColumnSpec("rate", "Rate (day / shift)", CURRENCY, 1.0),
    ColumnSpec("daysSoFar", "Working days so far", INTEGER, 0.9),
    ColumnSpec("shifts", "Shifts earned", NUMBER, 0.9, total="sum"),
    ColumnSpec("holidays", "Paid holidays", NUMBER, 0.8),
    ColumnSpec("paid", "Paid days / shifts", NUMBER, 0.9, total="sum"),
    ColumnSpec("gained", "Gained salary", CURRENCY, 1.2, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 1.6),
)
EXPECTED_COLUMNS = (
    *ID_COLUMNS,
    ColumnSpec("fixed", "Fixed salary", CURRENCY, 1.15, total="sum"),
    ColumnSpec("rate", "Rate (day / shift)", CURRENCY, 1.0),
    ColumnSpec("paid", "Paid so far", NUMBER, 0.85),
    ColumnSpec("gained", "Gained so far", CURRENCY, 1.15, total="sum"),
    ColumnSpec("toCome", "Days to come", NUMBER, 0.85),
    ColumnSpec("toComeAmount", "Amount to come", CURRENCY, 1.15, total="sum"),
    ColumnSpec("expected", "Expected salary", CURRENCY, 1.2, total="sum"),
    ColumnSpec("difference", "Difference", CURRENCY, 1.1, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 1.6),
)


def _num(value) -> float | None:
    return None if value is None else float(value)


def _row(f: Figures, depts: dict) -> dict:
    emp = f.emp
    staff = f.kind == C.STAFF
    return {
        "employeeCode": emp.employee_code,
        "employeeName": C.full(emp),
        "department": depts[emp.department_id],
        "designation": emp.designation.title if emp.designation_id else None,
        "type": C.KIND_LABEL[f.kind],
        "cycle": None if staff else CYCLE_LABELS.get(f.cycle or "", "No pay cycle"),
        "from": f.start.isoformat(),
        "to": f.end.isoformat(),
        "upTo": f.cutoff.isoformat() if f.cutoff >= f.start else None,
        "fixed": _num(f.fixed),
        "rate": _num(f.rate),
        "daysSoFar": f.days_so_far,
        "shifts": float(f.shifts),
        "holidays": float(f.holidays) if staff else None,
        "paid": float(f.paid),
        "gained": _num(f.gained),
        "toCome": float(f.to_come),
        "toComeAmount": _num(f.to_come_amount),
        "expected": _num(f.expected),
        "difference": _num(f.difference),
        "remarks": ", ".join(f.remarks) or None,
    }


def _rows(ctx, figures: list[Figures]) -> list[dict]:
    depts = C.department_map([f.emp for f in figures])
    rows = [_row(f, depts) for f in figures]
    rows.sort(key=lambda r: (C.dept_sort(r["department"]), r["type"] != "Staff", C.code_sort(r["employeeCode"])))
    return rows


def _sum(rows, key, kind=None) -> float:
    return round(sum(r[key] or 0 for r in rows if kind is None or r["type"] == C.KIND_LABEL[kind]), 2)


def _period_words(ctx) -> str:
    year, month = ctx.period
    m_start, m_end = C.month_bounds(year, month)
    cutoff = _cutoff(ctx, m_start, m_end)
    if cutoff < m_start:
        return f"{C.month_label(year, month)} has not begun, so nothing is gained yet"
    if cutoff < m_end:
        return f"{C.month_label(year, month)} up to today, {display_date(cutoff)}"
    return f"the whole of {C.month_label(year, month)}"


def _rule_notes(window: str) -> list[str]:
    return [
        "Staff: the per-day rate is the monthly salary / the company days of the month (every day but Sundays, and "
        "Saturdays on a Saturday-off shift, holidays included), as payroll divides it. Paid days = the shifts earned on "
        "the working days so far (a half day 0.5, a quarter day 0.25 / 0.75, a Penalty Early Out day less) + the declared "
        "holidays so far from the join date + any day HR marked as a holiday. Gained = rate x paid days.",
        "Production: Gained = the shifts earned on the days so far (every day, Sundays included, as production payroll "
        "pays them) x the rate per shift. "
        + (
            "Window: the worker's pay period (Weekly / BiWeekly / Monthly by Settings > Production Payroll) that holds "
            "the cut-off day; a worker on no pay cycle is shown for the calendar month."
            if window == WINDOW_PERIOD
            else "Window: the days of the chosen calendar month (production is paid per pay period; pick 'The worker's "
            "pay period' to see the running period)."
        ),
        "Read from the STORED attendance days (what payroll pays from); nothing is computed or saved here. A working day "
        "with no stored record yet counts as not earned (Remarks DAYS NOT COMPUTED); refreshing attendance adds it. "
        "Production days whose shifts are off the quarter-shift grid were stored before the quarter rules and are "
        "shown as stored (Remarks OUT OF DATE).",
        "Gross pay before deductions: overtime pay, HR bonus, and the late / permission, PF, ESI, TDS and advance "
        "deductions that payroll adds when it is generated are not included.",
    ]


def _gained_run(ctx) -> ReportResult:
    figures, notes = compute(ctx)
    rows = _rows(ctx, figures)
    window = ctx.params.get("window") or WINDOW_MONTH
    summary = [
        {"label": "Employees", "value": len(rows), "format": INTEGER},
        {"label": "Gained salary", "value": _sum(rows, "gained"), "format": CURRENCY},
        {"label": "Staff gained", "value": _sum(rows, "gained", C.STAFF), "format": CURRENCY},
        {"label": "Production gained", "value": _sum(rows, "gained", C.PRODUCTION), "format": CURRENCY},
        {"label": "Staff fixed salaries", "value": _sum(rows, "fixed", C.STAFF), "format": CURRENCY},
        {"label": "Production shifts", "value": _sum(rows, "shifts", C.PRODUCTION), "format": NUMBER},
    ]
    notes = [
        f"Salary gained from attendance before payroll is generated, one line per employee: {_period_words(ctx)}. Up "
        "to = the last day counted.",
        *notes,
        *_rule_notes(window),
        "Fixed salary: the staff monthly salary; for production the pay for one shift on every day of the window that "
        "is not a Sunday or a holiday (full attendance).",
        "Once a month's payroll is generated, the Salary Statement report shows what was paid. This report follows the "
        "attendance as it is stored now, so it differs from a generated payroll where attendance was refreshed after the "
        "payroll was generated.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


def _expected_run(ctx) -> ReportResult:
    figures, notes = compute(ctx)
    rows = _rows(ctx, figures)
    window = ctx.params.get("window") or WINDOW_MONTH
    summary = [
        {"label": "Employees", "value": len(rows), "format": INTEGER},
        {"label": "Fixed salary", "value": _sum(rows, "fixed"), "format": CURRENCY},
        {"label": "Gained so far", "value": _sum(rows, "gained"), "format": CURRENCY},
        {"label": "Amount to come", "value": _sum(rows, "toComeAmount"), "format": CURRENCY},
        {"label": "Expected salary", "value": _sum(rows, "expected"), "format": CURRENCY},
        {"label": "Difference", "value": _sum(rows, "difference"), "format": CURRENCY},
    ]
    notes = [
        f"Expected salary for the whole month / pay period: what is gained so far ({_period_words(ctx)}) plus every day "
        "still to come at full attendance, next to the fixed salary.",
        *notes,
        "Days to come: staff, the working days after the cut-off day (from the join date on) plus the holidays still to "
        "come, at the per-day rate; production, one shift for every day after the cut-off that is not a Sunday or a "
        "declared holiday, at the rate per shift. Today counts as to come while its attendance is not stored yet.",
        "Fixed salary: the staff monthly salary; for production the pay for one shift on every day of the window that is "
        "not a Sunday or a holiday. Difference = Expected salary - Fixed salary (below zero: pay already lost to absence, "
        "LOP or part days; above zero for production: extra shifts or Sunday work).",
        *_rule_notes(window),
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


FILTERS = (
    F.period(default="thisMonth"),
    F.select(
        "window",
        "Production days",
        WINDOW_OPTIONS,
        default=WINDOW_MONTH,
        required=True,
        help="Staff always use the calendar month. Production: the chosen month's days, or the worker's pay period that "
        "holds today (or the month's last day for a past month).",
    ),
    *F.scope(status="active"),
)

register(
    ReportSpec(
        id="gained-salary-report",
        title="Gained Salary Report",
        description="Salary earned so far this month (or pay period) from attendance, before payroll: working days so "
        "far, shifts earned and the gained amount at the payroll's daily rate or shift rate.",
        category=C.CATEGORY,
        modules=MODULES,
        icon="TrendingUp",
        tags=("gained", "earned", "salary", "attendance", "shift", "live", "advance", "staff", "production"),
        filters=FILTERS,
        columns=GAINED_COLUMNS,
        run=_gained_run,
        landscape=True,
    )
)

register(
    ReportSpec(
        id="expected-salary-report",
        title="Expected Salary Report",
        description="Projected pay for the whole month or pay period: gained so far plus the remaining working days at "
        "full attendance, next to the fixed salary and the difference.",
        category=C.CATEGORY,
        modules=MODULES,
        icon="Calculator",
        tags=("expected", "projected", "forecast", "salary", "attendance", "budget", "staff", "production"),
        filters=FILTERS,
        columns=EXPECTED_COLUMNS,
        run=_expected_run,
        landscape=True,
    )
)
