"""Salary category (category id ``payroll``, label "Salary"), payroll-based reports of the 2026-11-19 layout:

    salary-statement           one month, staff and production together, one line per payroll, department sub totals
    production-salary-report   one pay period of one production pay cycle
    staff-salary-report        one month of staff payroll with the 50% + 50% salary split components
    department-salary-report   one month by department (staff / production apart), with employer PF / ESI

Every figure is read from the generated Payroll rows through the Payroll pages' own builder
(``payroll_statement_views.statement_rows``), the reference the HR category's Salary Statement and Production Salary
Statement use (``hr_reports_salary_statement`` / ``hr_reports_production_statement``, whose output is untouched), so the
money always equals the Payroll pages'. NET is the payroll's saved ``final_salary`` exactly (the HR printed statements
round it up to the next rupee for print). Nothing is calculated or saved here.

Which payrolls (owner's month / period workflows, see rc_salary_common.LIST_WORDS): the "Payroll list" filter, by default
the Salary Statement's list (main payroll + held salaries, never a parked new joiner). Active employees only, as every
payroll page. "Paid" is ``Payroll.payment_status``; ``Payroll.status`` "paid" is HR's Cleared check.
"""

from __future__ import annotations

import dataclasses
from datetime import date
from types import SimpleNamespace

from django.db.models import Exists, OuterRef

from api.models import Employee, Payroll, ProductionPeriodClose
from api.payroll_insights import KIND_PRODUCTION, ddmmyyyy, production_period, slips_for
from api.payroll_statement_views import statement_rows
from api.production_cycles import CYCLE_LABELS, CYCLES
from api.production_period import InvalidPeriodConfig, is_cycle_period, resolve_cycle_period
from api.production_period_workflow import (
    MAIN_Q,
    PARKED_Q,
    STATE_LABELS,
    cycle_q,
    period_rows,
    state_of,
)
from api.salary_split import COMPONENTS, breakup_of, default_split, rescale, to_paise

from .. import filters as F
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    F_DATE_RANGE,
    INTEGER,
    NUMBER,
    TEXT,
    ColumnSpec,
    FilterSpec,
    ReportResult,
    ReportSection,
    ReportSpec,
)
from . import rc_salary_common as C
from .hr_reports_production_statement import resolve_period
from .hr_reports_salary_statement import (
    PRODUCTION_PF_BASIS,
    STAFF_PF_BASIS,
    STATUTORY_COLUMNS,
    STATUTORY_TITLE,
    statutory_rows,
)

MODULES_BOTH = ("payroll", "production_payroll")


def _money(key: str, label: str, width: float = 1.15, total: bool = True) -> ColumnSpec:
    return ColumnSpec(key, label, CURRENCY, width, total="sum" if total else None)


EMP_ID_COLS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.8),
    ColumnSpec("employeeName", "Employee", TEXT, 1.7),
)
DEDUCTION_COLS = (
    _money("pf", "PF", 1.1),
    _money("esi", "ESI", 1.1),
    _money("tds", "TDS", 1.0),
    _money("advance", "Advance", 1.05),
    _money("others", "Other deductions", 1.1),
    _money("totalDeduction", "Total deductions", 1.2),
    _money("net", "Net pay", 1.35),
)
PAYMENT_COL = ColumnSpec("payment", "Payment", BADGE, 1.0, align="center")
REMARKS_COL = ColumnSpec("remarks", "Remarks", TEXT, 1.5)
UNIT_COL = ColumnSpec("unit", "Unit", TEXT, 0.6, align="center")
MONEY_KEYS = ("gross", "ot", "bonus", "earned", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net")

NET_NOTE = (
    "Net pay is the payroll's saved net (Payroll.final_salary), exactly as the Payroll pages show it: since 10 Nov 2026 "
    "payroll saves it rounded up to the next rupee; an older month can carry paise (the HR printed statements and the "
    "bank file round those up)."
)
DEDUCTION_NOTE = (
    "Other deductions = the late and permission deduction plus anything HR added; Total deductions = PF + ESI + TDS + "
    "Advance + Other deductions (the payroll's saved total)."
)


def _deductions(v: dict) -> dict:
    return {k: v.get(k) for k in ("pf", "esi", "tds", "advance", "others", "totalDeduction", "net")}


def _remarks(v: dict, extra: list[str]) -> str | None:
    parts = [v.get("remarks") or "", *extra]
    text = ", ".join(p for p in parts if p)
    return text or None


def _common_notes(kinds_notes, which: str, inactive: int, no_slip: int, mismatched: int) -> list[str]:
    notes = [*kinds_notes, f"Payrolls listed: {C.LIST_WORDS[which]}."]
    if inactive:
        notes.append(
            f"{inactive} payroll(s) of employees who are no longer active are left out, as on the payroll pages."
        )
    if no_slip:
        notes.append(
            f"{no_slip} payroll(s) have no stored day-by-day breakdown, so their day counts come from the payroll record."
        )
    if mismatched:
        notes.append(
            f"For {mismatched} payroll(s) the saved net differs from Gross earned - Total deductions: the payroll was "
            "edited after it was generated; the saved net is shown."
        )
    return notes


def _missing_staff(ctx, year: int, month: int) -> int:
    """Active staff in the report's scope who had joined by the month's end and have no payroll for the month."""
    params = {k: v for k, v in ctx.params.items() if k not in ("employee_status", "employment_type")}
    scope_q = dataclasses.replace(ctx, params=params).emp_q()
    has = Payroll.objects.filter(
        employee_id=OuterRef("pk"), salary_mode=Payroll.SALARY_MODE_MONTHLY, month=month, year=year
    )
    rows = (
        Employee.objects.filter(scope_q, status="active", employment_type=C.STAFF)
        .annotate(has=Exists(has))
        .filter(has=False)
        .values_list("join_date", flat=True)
    )
    _first, last = C.month_bounds(year, month)
    count = 0
    for text in rows:
        joined, _state = C.join_date(SimpleNamespace(join_date=text))  # it only reads the text field
        if joined is None or joined <= last:
            count += 1
    return count


def _statutory_section(payrolls: list[Payroll], order: list[int], slips: dict) -> ReportSection:
    """The PF, ESI & TDS details (the HR statements' own builder, statutory_rows), staff lines then production lines,
    in the report's order, numbered from 1."""
    rows: list[dict] = []
    for production, basis in ((False, STAFF_PF_BASIS), (True, PRODUCTION_PF_BASIS)):
        group = [p for p in payrolls if (p.period_start is not None) == production]
        if group:
            ids = {p.id for p in group}
            rows += statutory_rows(group, [{"_payrollId": i} for i in order if i in ids], slips, basis)
    for i, r in enumerate(rows, 1):
        r["sno"] = i
    totals = {k: round(sum(r[k] for r in rows), 2) for k in ("pf", "esi", "tds", "total")}
    return ReportSection(
        title=STATUTORY_TITLE,
        columns=STATUTORY_COLUMNS,
        rows=rows,
        totals=totals if rows else None,
        notes=[
            f"{len(rows)} of the {len(payrolls)} payrolls listed have PF, ESI or TDS (Co Emp employees and the TDS list), "
            "with the wages, rates and amounts payroll stored on the payslip. ESI is rounded up to the next rupee, as on "
            "the printed statements.",
        ],
        sheet="PF ESI TDS",
        empty="Nobody listed is in Co Emp or on the TDS list, so nobody has PF, ESI or TDS.",
    )


# ═════════════════════════════════════════════════════════════════════════════
#  salary-statement
# ═════════════════════════════════════════════════════════════════════════════

STATEMENT_COLUMNS = (
    *EMP_ID_COLS,
    ColumnSpec("type", "Type", TEXT, 1.05),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("designation", "Designation", TEXT, 1.3),
    ColumnSpec("payPeriod", "Pay period", TEXT, 1.5),
    _money("salary", "Monthly salary", 1.25, total=False),
    _money("rate", "Rate / shift", 0.9, total=False),
    ColumnSpec("daysPaid", "Days paid", NUMBER, 0.75),
    ColumnSpec("lopDays", "LOP days", NUMBER, 0.75),
    _money("lopAmount", "LOP amount", 1.3),
    ColumnSpec("shifts", "Shifts paid", NUMBER, 0.75),
    _money("gross", "Gross", 1.35),
    _money("ot", "OT pay", 1.0),
    _money("bonus", "Bonus", 0.9),
    _money("earned", "Gross earned", 1.35),
    *DEDUCTION_COLS,
    PAYMENT_COL,
    REMARKS_COL,
    UNIT_COL,
)
STATEMENT_SUM_KEYS = ("lopAmount", *MONEY_KEYS)


def payroll_line(p: Payroll, v: dict, dept: str, overlap: bool = False) -> dict:
    """One payroll in the Salary category's columns, from the Payroll page's statement values ``v``."""
    emp = p.employee
    staff = p.period_start is None
    return {
        "employeeCode": emp.employee_code,
        "employeeName": C.full(emp),
        "type": C.KIND_LABEL[C.STAFF if staff else C.PRODUCTION],
        "department": dept,
        "designation": emp.designation.title if emp.designation_id else None,
        "payPeriod": C.pay_period_text(p),
        "cycle": C.cycle_text(p),
        "salary": C.money(p.base_salary) if staff else None,
        "rate": None if staff else v.get("rate"),
        "daysPaid": v.get("totalDays") if staff else v.get("days"),
        "daysWorked": None if staff else v.get("worked"),
        "absent": None if staff else v.get("absent"),
        "late": None if staff else v.get("late"),
        "lopDays": v.get("lop") if staff else None,
        "lopAmount": v.get("lopAmount") if staff else None,
        "shifts": None if staff else v.get("shifts"),
        "gross": C.money(p.gross_salary),
        "ot": C.money(p.ot_amount),
        "bonus": C.money(p.bonus),
        "earned": v.get("eSalary"),
        **_deductions(v),
        "payment": C.payment_label(p),
        "remarks": _remarks(v, ["OVERLAPS ANOTHER PERIOD"] if overlap else []),
        "unit": C.unit_text(emp),
    }


def _ordered(payrolls: list[Payroll], depts: dict) -> list[Payroll]:
    return sorted(
        payrolls,
        key=lambda p: (
            C.dept_sort(depts[p.employee.department_id]),
            p.period_start is not None,
            C.code_sort(p.employee.employee_code),
            p.period_start or date.min,
        ),
    )


def _statement_run(ctx) -> ReportResult:
    year, month = ctx.period
    kinds, kind_notes = C.visible_kinds(ctx, C.PAYROLL_MODULES)
    which = ctx.params.get("payrollList") or C.LIST_STATEMENT
    payrolls = C.month_payrolls(ctx, year, month, kinds, which, ctx.params.get("paymentStatus"))[: ctx.row_limit]
    values, no_slip, mismatched = C.statement_values(payrolls)
    depts = C.department_map([p.employee for p in payrolls])
    overlaps = C.overlapping_ids(payrolls)
    ordered = _ordered(payrolls, depts)
    lines = [payroll_line(p, values[p.id], depts[p.employee.department_id], p.id in overlaps) for p in ordered]
    rows = C.group_subtotals(lines, "department", STATEMENT_SUM_KEYS, label_key="employeeName")

    paid = sum(1 for p in payrolls if p.payment_status == Payroll.PAYMENT_PAID)
    summary = [
        {"label": "Payrolls", "value": len(payrolls), "format": INTEGER},
        {"label": "Gross earned", "value": round(sum(r["earned"] or 0 for r in lines), 2), "format": CURRENCY},
        {
            "label": "Total deductions",
            "value": round(sum(r["totalDeduction"] or 0 for r in lines), 2),
            "format": CURRENCY,
        },
        {"label": "Net pay", "value": round(sum(r["net"] or 0 for r in lines), 2), "format": CURRENCY},
        {"label": "Paid", "value": paid, "format": INTEGER},
        {"label": "Not paid yet", "value": len(payrolls) - paid, "format": INTEGER},
    ]
    notes = [
        f"Salary Statement for {C.month_label(year, month)}: staff monthly payroll for the month and every production pay "
        "period that ENDS in the month (payroll counts a period in the month it ends in), one line per payroll, under "
        "the employee's department with a sub total per department. A production worker can have more than one line "
        "(one per pay period).",
        *_common_notes(kind_notes, which, C.inactive_count(ctx, year, month, kinds), no_slip, mismatched),
        "The money is read from the generated payrolls through the Payroll pages' own statement builder, so every figure "
        "equals Payroll > Salary Statement and Production Payroll > Salary; nothing is calculated or saved here. Legacy "
        "week-numbered production payrolls (before period pay) are not included.",
        "Gross = the pay earned for the days / shifts paid (staff: Monthly salary x Days paid / company days of the "
        "month; production: Shifts paid x Rate / shift); Gross earned = Gross + OT pay + Bonus.",
        "LOP days = the company days of the month not paid (absent, unpaid leave, the missing part of a half or quarter "
        "day); LOP amount = Monthly salary - Gross, the pay lost to them. It is already out of Gross, so it is NOT part "
        "of Total deductions (staff only).",
        DEDUCTION_NOTE,
        NET_NOTE,
        C.PAYMENT_WORDS,
    ]
    if overlaps:
        notes.append(
            f"{len(overlaps)} production payroll(s) share days with another pay period of the same worker (Remarks "
            "OVERLAPS ANOTHER PERIOD): an older draft that generating the period again replaces."
        )
    if C.STAFF in kinds and which != C.LIST_SKIPPED:
        missing = _missing_staff(ctx, year, month)
        if missing:
            notes.append(
                f"{missing} active staff member(s) in this selection have no payroll generated for the month and are "
                "not listed."
            )
    if not payrolls:
        notes.append("No payroll has been generated for this month and selection.")
    notes.append("The Excel and PDF files add a PF, ESI & TDS details table after the statement.")
    sections = []
    if ctx.purpose in ("xlsx", "pdf"):
        sections = [_statutory_section(payrolls, [p.id for p in ordered], slips_for(payrolls))]
    return ReportResult(rows=rows, summary=summary, notes=notes, sections=sections)


# ═════════════════════════════════════════════════════════════════════════════
#  production-salary-report
# ═════════════════════════════════════════════════════════════════════════════

CYCLE_OPTIONS = tuple((c, CYCLE_LABELS[c]) for c in CYCLES)
PROD_LIST_OPTIONS = (
    ("main", "The period's payroll"),
    ("parked", "New joiners waiting (not added yet)"),
)
PRODUCTION_COLUMNS = (
    *EMP_ID_COLS,
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("designation", "Designation", TEXT, 1.3),
    _money("rate", "Rate / shift", 0.9, total=False),
    ColumnSpec("daysPaid", "Days paid", NUMBER, 0.8),
    ColumnSpec("daysWorked", "Days worked", NUMBER, 0.8),
    ColumnSpec("absent", "Absent", NUMBER, 0.8),
    ColumnSpec("late", "Late days", INTEGER, 0.7),
    ColumnSpec("shifts", "Shifts", NUMBER, 0.8, total="sum"),
    _money("gross", "Gross", 1.15),
    _money("bonus", "Bonus", 0.9),
    _money("earned", "Gross earned", 1.2),
    *DEDUCTION_COLS,
    PAYMENT_COL,
    REMARKS_COL,
    UNIT_COL,
)
PRODUCTION_SUM_KEYS = (
    "shifts",
    "gross",
    "bonus",
    "earned",
    "pf",
    "esi",
    "tds",
    "advance",
    "others",
    "totalDeduction",
    "net",
)


def _latest_period(ctx, cycle: str, ps) -> tuple[date, date] | None:
    """The latest generated period of the cycle in the caller's scope that is one of the cycle's periods under today's
    Settings (an old draft left by a changed week start is passed over), else the latest generated one."""
    generated = list(
        Payroll.objects.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False)
        .filter(cycle_q(cycle), ctx.emp_q("employee__"))
        .order_by("-period_end", "-period_start")
        .values_list("period_start", "period_end")
        .distinct()[:24]
    )
    if not generated:
        return None
    if ps is not None:
        for a, b in generated:
            try:
                if is_cycle_period(a, b, ps, cycle):
                    return a, b
            except InvalidPeriodConfig:
                break
    return generated[0]


def _production_period(ctx, cycle: str) -> tuple[date | None, date | None, str | None]:
    """(start, end, note) of the pay period to list. Dates given: the generated period of the cycle that holds them
    (dates touching two generated periods are refused, as on Production Salary Statement), else the cycle's period by
    Settings > Production Payroll (resolve_cycle_period). No dates: the latest generated period of the cycle (one of
    its periods under today's Settings when there is one), else the period running today."""
    ps = C.read_settings(ctx.request)
    given = ctx.date_from or ctx.date_to
    if not given:
        latest = _latest_period(ctx, cycle, ps)
        if latest is not None:
            return latest[0], latest[1], None
        start = end = None
    else:
        start, end = resolve_period(ctx, cycle)
        if Payroll.objects.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=start, period_end=end).exists():
            return start, end, None
    ref = given or ctx.today
    if ps is not None:
        try:
            a, b = resolve_cycle_period(ref, ps, cycle)
            return a, b, None
        except InvalidPeriodConfig as exc:
            return (start, end, str(exc)) if given else (None, None, str(exc))
    return (start, end, None) if given else (None, None, None)


def _production_run(ctx) -> ReportResult:
    cycle = ctx.params.get("cycle") or CYCLES[1]
    label = CYCLE_LABELS[cycle]
    start, end, config_note = _production_period(ctx, cycle)
    payrolls: list[Payroll] = []
    which = ctx.params.get("list") or "main"
    notes: list[str] = [config_note] if config_note else []
    if start is None:
        notes.append(f"No {label} production payroll has been generated yet for this selection.")
        return ReportResult(rows=[], notes=notes)
    ctx.params["date_from"], ctx.params["date_to"] = start, end  # the filters echo names the period listed
    base = period_rows(cycle, start, end).filter(ctx.emp_q("employee__"))
    qs = (
        C.payroll_qs()
        .filter(pk__in=base.values("pk"))
        .filter(PARKED_Q if which == "parked" else MAIN_Q)
        .filter(C.payment_q(ctx.params.get("paymentStatus")))
    )
    payrolls = list(qs.order_by("employee__employee_code", "id")[: ctx.row_limit])
    values, no_slip, mismatched = (
        statement_rows(payrolls, KIND_PRODUCTION, production_period(start, end, cycle)) if payrolls else ({}, 0, 0)
    )
    depts = C.department_map([p.employee for p in payrolls])
    ordered = _ordered(payrolls, depts)
    lines = [payroll_line(p, values[p.id], depts[p.employee.department_id]) for p in ordered]
    rows = C.group_subtotals(lines, "department", PRODUCTION_SUM_KEYS, label_key="employeeName")

    close = ProductionPeriodClose.objects.filter(cycle=cycle, period_start=start, period_end=end).first()
    generated = period_rows(cycle, start, end).count()
    state = STATE_LABELS[state_of(close, generated)]
    if close is not None and close.paid_on:
        state = f"Paid on {ddmmyyyy(close.paid_on)}"
    parked = period_rows(cycle, start, end).filter(ctx.emp_q("employee__")).filter(PARKED_Q).count()
    summary = [
        {"label": "Workers", "value": len(payrolls), "format": INTEGER},
        {"label": "Shifts paid", "value": round(sum(r["shifts"] or 0 for r in lines), 2), "format": NUMBER},
        {"label": "Gross earned", "value": round(sum(r["earned"] or 0 for r in lines), 2), "format": CURRENCY},
        {
            "label": "Total deductions",
            "value": round(sum(r["totalDeduction"] or 0 for r in lines), 2),
            "format": CURRENCY,
        },
        {"label": "Net pay", "value": round(sum(r["net"] or 0 for r in lines), 2), "format": CURRENCY},
        {"label": "Period status", "value": state, "format": TEXT},
    ]
    notes += [
        f"{label} pay period {ddmmyyyy(start)} to {ddmmyyyy(end)} ({state}): one line per production worker under the "
        "department, with a sub total per department. The money is Production Payroll > Salary's, read from the "
        "generated payrolls (nothing is calculated or saved here). Active workers only.",
        "Which period: dates given = the generated period of the cycle that holds them (any day of it is enough); none "
        "= the latest period generated for the cycle. With nothing generated for the dates the cycle's period is named "
        "from Settings > Production Payroll and the list is empty.",
        "Days paid = the days this payslip pays (after a change of pay cycle only the days no other payroll paid: Remarks "
        "PART PERIOD / INCL. CATCH-UP); Shifts = the shifts earned (a day earns 0.25 to 1.5 and more); Gross = Shifts x "
        "Rate / shift; Gross earned = Gross + Bonus.",
        DEDUCTION_NOTE,
        NET_NOTE,
        C.PAYMENT_WORDS,
    ]
    if which == "parked":
        notes.append(
            "NEW JOINERS WAITING: workers of this period kept out of the payroll until HR adds them (joined during the "
            "period, or moved here from another pay cycle). They are not in the period's totals or bank file."
        )
    elif parked:
        notes.append(
            f"{parked} worker(s) of this period are waiting in New Joiners on the {label} page and are not listed (pick "
            "'New joiners waiting' to see them)."
        )
    if no_slip:
        notes.append(
            f"{no_slip} payroll(s) have no stored day-by-day breakdown; their day counts come from the payroll."
        )
    if mismatched:
        notes.append(f"For {mismatched} payroll(s) the saved net was edited after the payroll was generated.")
    if not payrolls:
        notes.append(f"No {label} production payroll is listed for this period and selection.")
    sections = []
    if ctx.purpose in ("xlsx", "pdf"):
        sections = [_statutory_section(payrolls, [p.id for p in ordered], slips_for(payrolls))]
    return ReportResult(rows=rows, summary=summary, notes=notes, sections=sections)


PERIOD_FILTER = FilterSpec(
    "dateRange",
    F_DATE_RANGE,
    "Pay period",
    default="none",
    required=False,
    max_days=120,
    help="Any day of the pay period is enough (From = To). Left empty: the latest period generated for the cycle.",
)


# ═════════════════════════════════════════════════════════════════════════════
#  staff-salary-report
# ═════════════════════════════════════════════════════════════════════════════

SPLIT_LABELS = {
    "basic": ("basic", "Basic"),
    "da": ("da", "DA"),
    "retaining_allowance": ("retaining", "Retaining Allow."),
    "other_allowance": ("otherAllowance", "Other Allow."),
    "petrol_allowance": ("petrol", "Petrol Allow."),
    "hra": ("hra", "HRA"),
    "special_allowance": ("special", "Special Allow."),
    "ca": ("ca", "CA"),
}
STAFF_COLUMNS = (
    *EMP_ID_COLS,
    ColumnSpec("department", "Department", TEXT, 1.2),
    *(_money(SPLIT_LABELS[c][0], SPLIT_LABELS[c][1], 1.15) for c in COMPONENTS),
    _money("salary", "Monthly salary", 1.3),
    ColumnSpec("companyDays", "Company days", INTEGER, 0.65),
    ColumnSpec("daysPaid", "Days paid", NUMBER, 0.7),
    ColumnSpec("lopDays", "LOP days", NUMBER, 0.7),
    _money("lopAmount", "LOP amount", 1.3),
    _money("earned", "Earned gross", 1.35),
    *DEDUCTION_COLS,
    PAYMENT_COL,
    REMARKS_COL,
)
STAFF_SUM_KEYS = (
    *(SPLIT_LABELS[c][0] for c in COMPONENTS),
    "salary",
    "lopAmount",
    "earned",
    "pf",
    "esi",
    "tds",
    "advance",
    "others",
    "totalDeduction",
    "net",
)


def split_of(emp, total) -> tuple[dict, bool]:
    """(the eight components of the payroll's monthly salary, recorded?). The employee's recorded split, rescaled to
    the payroll's salary when it has changed since (an increment), keeping its proportions; with none recorded the
    automatic one (each portion 50%, shared equally) - as Payroll > Salary Statement splits it."""
    parts = breakup_of(emp)
    if parts is None:
        return default_split(total), False
    if sum(to_paise(v) for v in parts.values()) != to_paise(total):
        parts = rescale(parts, total)
    return parts, True


def _staff_run(ctx) -> ReportResult:
    year, month = ctx.period
    kinds = [C.STAFF] if C.may_view(ctx, C.PAYROLL_MODULES[C.STAFF]) else []
    which = ctx.params.get("payrollList") or C.LIST_STATEMENT
    payrolls = C.month_payrolls(ctx, year, month, kinds, which, ctx.params.get("paymentStatus"))[: ctx.row_limit]
    values, no_slip, mismatched = C.statement_values(payrolls)
    depts = C.department_map([p.employee for p in payrolls])
    lines = []
    automatic = 0
    for p in _ordered(payrolls, depts):
        v = values[p.id]
        parts, recorded = split_of(p.employee, C.d2(p.base_salary))
        automatic += not recorded
        line = {
            **payroll_line(p, v, depts[p.employee.department_id]),
            **{SPLIT_LABELS[c][0]: float(parts[c]) for c in COMPONENTS},
            "companyDays": int(p.total_working_days or 0),
        }
        if not recorded:
            line["remarks"] = _remarks({"remarks": line["remarks"]}, ["AUTO SPLIT"])
        lines.append(line)
    rows = C.group_subtotals(lines, "department", STAFF_SUM_KEYS, label_key="employeeName")
    summary = [
        {"label": "Staff paid", "value": len(payrolls), "format": INTEGER},
        {"label": "Monthly salaries", "value": round(sum(r["salary"] or 0 for r in lines), 2), "format": CURRENCY},
        {"label": "Earned gross", "value": round(sum(r["earned"] or 0 for r in lines), 2), "format": CURRENCY},
        {"label": "LOP amount", "value": round(sum(r["lopAmount"] or 0 for r in lines), 2), "format": CURRENCY},
        {
            "label": "Total deductions",
            "value": round(sum(r["totalDeduction"] or 0 for r in lines), 2),
            "format": CURRENCY,
        },
        {"label": "Net pay", "value": round(sum(r["net"] or 0 for r in lines), 2), "format": CURRENCY},
    ]
    notes = [
        f"Staff salary for {C.month_label(year, month)}: one line per staff payroll under the department, with the "
        "monthly salary split into its two 50% portions - Basic + DA + Retaining Allowance (the first portion, what PF and "
        "ESI are taken from) and Other + Petrol + HRA + Special Allowance + CA - then the days, the earned gross, the "
        "deductions and the net exactly as Payroll saved them.",
        *_common_notes(
            [] if kinds else ["Your role cannot see staff payroll."],
            which,
            C.inactive_count(ctx, year, month, kinds),
            no_slip,
            mismatched,
        ),  # fmt: skip
        "The split components are the full MONTHLY amounts of the payroll's salary (the employee's recorded split, "
        "rescaled to the payroll's salary after an increment); the payroll pays Monthly salary x Days paid / Company "
        "days (Earned gross), so the components are not prorated here.",
        "Company days = every day of the month but Sundays (and Saturdays on a Saturday-off shift), company holidays "
        "included: what the salary is divided by. Days paid = days worked (a half day 0.5, a quarter day 0.25 or 0.75) + "
        "paid holidays; LOP days = Company days - Days paid; LOP amount = the pay lost to them (Monthly salary - the pay "
        "for the days paid), already out of the pay, not a deduction. Earned gross = the pay for the days paid + any "
        "OT pay and HR bonus (the Salary Statement report shows OT and bonus apart).",
        DEDUCTION_NOTE,
        NET_NOTE,
        C.PAYMENT_WORDS,
    ]
    if automatic:
        notes.append(
            f"{automatic} employee(s) have no salary split recorded (Remarks AUTO SPLIT): the automatic split is "
            "shown (each portion 50% of the salary, shared equally by its components)."
        )
    if kinds and which != C.LIST_SKIPPED:
        missing = _missing_staff(ctx, year, month)
        if missing:
            notes.append(f"{missing} active staff member(s) in this selection have no payroll for the month yet.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ═════════════════════════════════════════════════════════════════════════════
#  department-salary-report
# ═════════════════════════════════════════════════════════════════════════════

DEPARTMENT_COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.0),
    ColumnSpec("type", "Type", TEXT, 0.9),
    ColumnSpec("headcount", "Employees paid", INTEGER, 0.9, total="sum"),
    _money("earned", "Gross earned", 1.25),
    _money("pf", "PF", 1.1),
    _money("esi", "ESI", 1.1),
    _money("tds", "TDS", 1.0),
    _money("advance", "Advance", 1.05),
    _money("others", "Other deductions", 1.1),
    _money("totalDeduction", "Total deductions", 1.2),
    _money("net", "Net pay", 1.35),
    _money("employerPf", "Employer PF", 1.05),
    _money("employerEsi", "Employer ESI", 1.05),
    _money("employerCost", "Employer cost", 1.25),
)
DEPARTMENT_SUM_KEYS = tuple(c.key for c in DEPARTMENT_COLUMNS if c.total)
_DEPT_MONEY = ("earned", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net")


def _department_run(ctx) -> ReportResult:
    year, month = ctx.period
    kinds, kind_notes = C.visible_kinds(ctx, C.PAYROLL_MODULES)
    which = ctx.params.get("payrollList") or C.LIST_STATEMENT
    payrolls = C.month_payrolls(ctx, year, month, kinds, which, ctx.params.get("paymentStatus"))
    values, no_slip, mismatched = C.statement_values(payrolls)
    slips = slips_for(payrolls)
    depts = C.department_map([p.employee for p in payrolls])
    groups: dict[tuple[str, str], dict] = {}
    for p in payrolls:
        kind = C.kind_of_row(p)
        g = groups.setdefault(
            (depts[p.employee.department_id], kind),
            {"people": set(), **{k: C.ZERO for k in (*_DEPT_MONEY, "employerPf", "employerEsi")}},
        )
        g["people"].add(p.employee_id)
        v = {**values[p.id], "earned": values[p.id].get("eSalary")}
        for k in _DEPT_MONEY:
            g[k] += C.d2(v.get(k))
        er_pf, er_esi = C.employer_contributions(C.slip_of(slips, p))
        g["employerPf"] += er_pf
        g["employerEsi"] += er_esi
    lines = []
    for (dept, kind), g in sorted(groups.items(), key=lambda kv: (C.dept_sort(kv[0][0]), kv[0][1] != C.STAFF)):
        lines.append(
            {
                "department": dept,
                "type": C.KIND_LABEL[kind],
                "headcount": len(g["people"]),
                **{k: float(g[k]) for k in (*_DEPT_MONEY, "employerPf", "employerEsi")},
                "employerCost": float(g["earned"] + g["employerPf"] + g["employerEsi"]),
            }
        )
    rows = C.group_subtotals(
        lines, "department", DEPARTMENT_SUM_KEYS, label_key="department", label=lambda d, n: f"{d} total", min_rows=2
    )
    people = len({p.employee_id for p in payrolls})
    totals_by = {k: round(sum(r[k] for r in lines), 2) for k in ("earned", "totalDeduction", "net", "employerCost")}
    summary = [
        {"label": "Employees paid", "value": people, "format": INTEGER},
        {"label": "Departments", "value": len({r["department"] for r in lines}), "format": INTEGER},
        {"label": "Gross earned", "value": totals_by["earned"], "format": CURRENCY},
        {"label": "Total deductions", "value": totals_by["totalDeduction"], "format": CURRENCY},
        {"label": "Net pay", "value": totals_by["net"], "format": CURRENCY},
        {"label": "Employer cost", "value": totals_by["employerCost"], "format": CURRENCY},
    ]
    notes = [
        f"Department-wise salary for {C.month_label(year, month)}: one line per department and employee type (staff "
        "monthly payroll; production pay periods ENDING in the month), with a department total where it has both. The "
        "figures add up the same payrolls as the Salary Statement report with the same filters.",
        *_common_notes(kind_notes, which, C.inactive_count(ctx, year, month, kinds), no_slip, mismatched),
        "Employees paid counts people (a production worker paid for two periods counts once); the money adds up every "
        "payroll of the month.",
        "Gross earned = pay for the days / shifts paid + OT pay + bonus. " + DEDUCTION_NOTE,
        "Employer PF / ESI: the percentage of the Settings > PF & ESI rule each payslip matched, applied to the same PF / "
        "ESI wages as the employee's share (the app's rules carry one percentage, which the Compensation page's employer "
        "cost also uses); only Co Emp employees have them. Employer cost = Gross earned + Employer PF + Employer ESI.",
        NET_NOTE,
    ]
    if not payrolls:
        notes.append("No payroll has been generated for this month and selection.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ═════════════════════════════════════════════════════════════════════════════
#  registration
# ═════════════════════════════════════════════════════════════════════════════

register(
    ReportSpec(
        id="salary-statement",
        title="Salary Statement",
        description="One month's pay, staff and production together: days or shifts paid, gross, OT, bonus, PF, ESI, "
        "TDS, advance, other deductions, net and payment status per employee, with department sub totals.",
        category=C.CATEGORY,
        modules=MODULES_BOTH,
        icon="FileSpreadsheet",
        tags=("salary", "statement", "payroll", "net", "pf", "esi", "tds", "advance", "lop", "paid", "department"),
        filters=(
            F.period(default="lastMonth"),
            *F.scope(),
            C.payment_filter(),
            C.payroll_list_filter(),
        ),
        columns=STATEMENT_COLUMNS,
        run=_statement_run,
        landscape=True,
        pdf_max_rows=3_000,
    )
)

register(
    ReportSpec(
        id="production-salary-report",
        title="Production Salary Report",
        description="One pay period of a production pay cycle (Weekly, BiWeekly, Monthly): shifts, rate, gross, "
        "deductions, net and payment status per worker, with the period's status.",
        category=C.CATEGORY,
        modules=("production_payroll",),
        icon="Banknote",
        tags=("production", "salary", "shift", "weekly", "biweekly", "monthly", "cycle", "period", "net", "paid"),
        filters=(
            F.select("cycle", "Pay cycle", CYCLE_OPTIONS, default=CYCLES[1], required=True),
            PERIOD_FILTER,
            *F.scope(employment=False),
            C.payment_filter(),
            F.select("list", "Workers", PROD_LIST_OPTIONS, default="main", required=True),
        ),
        columns=PRODUCTION_COLUMNS,
        run=_production_run,
        landscape=True,
        pdf_max_rows=3_000,
    )
)

register(
    ReportSpec(
        id="staff-salary-report",
        title="Staff Salary Report",
        description="One month of staff payroll with the 50% + 50% salary split (Basic, DA, Retaining | Other, "
        "Petrol, HRA, Special, CA), days paid, LOP, earned gross, deductions and net.",
        category=C.CATEGORY,
        modules=("payroll",),
        icon="Wallet",
        tags=("staff", "salary", "split", "basic", "da", "hra", "petrol", "lop", "net", "payroll"),
        filters=(
            F.period(default="lastMonth"),
            *F.scope(employment=False),
            C.payment_filter(),
            C.payroll_list_filter(),
        ),
        columns=STAFF_COLUMNS,
        run=_staff_run,
        landscape=True,
        pdf_max_rows=3_000,
    )
)

register(
    ReportSpec(
        id="department-salary-report",
        title="Department-wise Salary Report",
        description="One month's payroll by department, staff and production apart: people paid, gross, deductions, "
        "net, employer PF / ESI and employer cost.",
        category=C.CATEGORY,
        modules=MODULES_BOTH,
        icon="Building2",
        tags=("department", "salary", "cost", "employer", "pf", "esi", "net", "payroll", "production"),
        filters=(
            F.period(default="lastMonth"),
            F.branches(),
            F.departments(),
            F.employment_type(),
            C.payment_filter(),
            C.payroll_list_filter(),
        ),
        columns=DEPARTMENT_COLUMNS,
        run=_department_run,
        landscape=True,
    )
)
