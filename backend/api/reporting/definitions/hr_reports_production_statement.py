"""HR Reports (category ``hr``): hr-production-salary-statement, the printed Production Salary Statement.

Owner 2026-11-06: "Just like all the improvements and upgrades we made to the Staff Payroll module yesterday, I want to
implement the same enhancements across all Production Payroll pages as well - Weekly, Biweekly and Monthly." The Staff
Payroll Export menu prints the Report Center's Salary Statement (hr-salary-statement); the Production Payroll pages now
print this report, in the same printed format, for one pay period of one pay cycle.

The figures are NOT worked out here: the rows come from the same builder as Production Payroll > Salary
(``payroll_statement_views.statement_rows`` for the very rows ``scope_payrolls`` lists for the cycle and period), so the
two can never disagree. Production pay itself (salary per shift x shifts) is untouched.

Columns (production's own, in the staff statement's order): SNO, ID NO, Name, Designation | Rate / Shift | Days Paid,
Days Worked, Absent, Shifts | Gross Earned | PF, ESI, TDS, Advance, Others, Total Deduction | NET | Remarks | Unit.
Days Paid is the days the payslip pays (the whole period; after a change of pay cycle only the days no other payroll
paid, plus any catch-up days before the period - Remarks then says PART PERIOD or INCL. CATCH-UP); Gross Earned = shifts x rate (+ any HR bonus); Advance = the advance and term-loan
repayments recovered from this period's pay; Others = the late deduction (and any deduction HR added). The same format
rules as the staff statement (its docstring has every owner decision): unit by unit (head office first, units by name, no
unit last; a unit login sees its own unit only), each unit on a fresh PDF page with "(contd.)" bands, same-name
departments merged into one heading per unit, department sub totals with one blank row between departments, the unit's
totals block (head count + every money column) and Final Summary, the grand TOTAL, the signatures (Prepared By, Checked
By, HRM, Auditor, MD), the PF, ESI & TDS details at the very end, ESI and NET rounded UP to the next rupee (Total
Deduction adds the rounded ESI), ACTIVE employees only, the day columns not added up.

Which period: the Pay cycle filter (Weekly / BiWeekly / Monthly) and the Pay period dates. The Payroll tab sends the
period's own first and last day. In the Report Center any day of the period is enough (From = To): the period of that
cycle that holds the dates is printed. Dates that touch two or more generated periods are refused with the periods named
(pick dates inside one); left empty, the latest generated period of the cycle is printed. The filters echo (screen, file
header, audit log) names the period printed.

Gated on the ``production_payroll`` module, exactly like GET /api/payroll/production/salary-statement.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from django.db.models import Exists, OuterRef, Q

from api.models import Employee, Payroll
from api.payroll_insights import KIND_PRODUCTION, dec, ddmmyyyy, period_label, production_period, slips_for
from api.payroll_insights_views import Scope, scope_payrolls
from api.payroll_statement_views import NO_DEPARTMENT, statement_rows
from api.production_cycles import CYCLE_LABELS, CYCLES

from .. import filters as F
from ..filters import ReportParamError
from ..registry import register
from ..types import CURRENCY, F_DATE_RANGE, INTEGER, NUMBER, TEXT, ColumnSpec, FilterSpec, ReportResult, ReportSpec
from .employees_master_base import join_date_of
from .hr_reports_salary_statement import (
    PAYMENT_OPTIONS,
    STATUTORY_SUM_KEYS,
    UNIT_COLUMN,
    round_up,
    statement_lines,
    statutory_section,
    unit_blocks,
)
from .hr_reports_salary_statement_files import StatementLayout

REPORT_ID = "hr-production-salary-statement"
CATEGORY = "hr"
# The production statement endpoint is gated on the production_payroll module alone; so is this report.
MODULES = ("production_payroll",)

# The money columns that add up (sub totals, unit totals, TOTAL); the rate and the day counts are not added up.
SUM_KEYS = ("eSalary", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net")


def _money_col(key: str, label: str, width: float = 1.3) -> ColumnSpec:
    return ColumnSpec(key, label, CURRENCY, width, total="sum" if key in SUM_KEYS else None)


COLUMNS = (
    ColumnSpec("sno", "SNO", INTEGER, 0.6, align="center"),
    ColumnSpec("code", "ID NO", TEXT, 1.1),
    ColumnSpec("name", "Name", TEXT, 3),
    ColumnSpec("designation", "Designation", TEXT, 2.2),
    _money_col("rate", "Rate / Shift", 1.1),
    ColumnSpec("days", "Days Paid", NUMBER, 1),
    ColumnSpec("worked", "Days Worked", NUMBER, 1),
    ColumnSpec("absent", "Absent", NUMBER, 1),
    ColumnSpec("shifts", "Shifts", NUMBER, 1),
    _money_col("eSalary", "Gross Earned"),
    _money_col("pf", "PF", 1.25),
    _money_col("esi", "ESI", 1.25),
    _money_col("tds", "TDS", 1.25),
    _money_col("advance", "Advance", 1.1),
    _money_col("others", "Others", 1.1),
    _money_col("totalDeduction", "Total Deduction"),
    _money_col("net", "NET"),
    ColumnSpec("remarks", "Remarks", TEXT, 2),
    UNIT_COLUMN,
)
# What the department grouping adds up for its own sub totals (unused here, but it must know the columns)
_GROUP_COLUMNS = [{"key": c.key, "total": c.total} for c in COLUMNS]

# The files' cards: each unit's totals block (the head count and every money column; NET highlighted) and the Final
# Summary (Total Employees, Gross Earned, the Detection Amount = the late deduction, Total Deduction, Net Pay).
LAYOUT = StatementLayout(
    sum_keys=SUM_KEYS,
    statutory_sum_keys=STATUTORY_SUM_KEYS,
    figure_rows=(
        (("Total Employees", None), ("Gross Earned", "eSalary"), ("NET", "net")),
        (
            ("PF", "pf"),
            ("ESI", "esi"),
            ("TDS", "tds"),
            ("Advance", "advance"),
            ("Others", "others"),
            ("Total Deduction", "totalDeduction"),
        ),
    ),  # fmt: skip
    final_figures=(
        ("Total Employees", None),
        ("Gross Earned", "eSalary"),
        ("Detection Amount", "others"),
        ("Total Deduction", "totalDeduction"),
        ("Net Pay", "net"),
    ),  # fmt: skip
)

CYCLE_OPTIONS = tuple((c, CYCLE_LABELS[c]) for c in CYCLES)
PERIOD_FILTER = FilterSpec(
    "dateRange",
    F_DATE_RANGE,
    "Pay period",
    default="none",
    required=False,
    max_days=120,
    help="Any day of the pay period is enough (From = To). Left empty: the latest period generated for the cycle.",
)

# Where _run leaves the unit blocks for the PDF / Excel builders (ReportContext._cache: one run, one export)
PLAN_KEY = "production_statement_units"


def report_values(v: dict) -> dict:
    """One worker's line in the report's columns, from the Production Salary Statement's own row `v`: every figure as the
    statement has it, except that ESI and NET are rounded UP to the next whole rupee and Total Deduction adds up the
    rounded ESI (PF + ESI + TDS + Advance + Others as printed), as on the staff statement."""
    esi = round_up(v.get("esi"))
    keep = (
        "code", "name", "designation", "rate", "days", "worked", "absent", "shifts", "eSalary", "pf", "tds", "advance",
        "others", "remarks",
    )  # fmt: skip
    return {
        **{k: v.get(k) for k in keep},
        "esi": esi,
        "net": round_up(v.get("net")),
        "totalDeduction": float(dec(v.get("totalDeduction")) - dec(v.get("esi")) + Decimal(str(esi))),
    }


# ── Which pay period ─────────────────────────────────────────────────────────


def _cycle_q(cycle: str) -> Q:
    """The production rows of a cycle, as scope_payrolls (and the Production Payroll pages) list them: generated on the
    cycle, or older rows with no cycle stamped whose employee is on it now."""
    return Q(pay_cycle=cycle) | Q(pay_cycle__isnull=True, employee__production_pay_cycle=cycle)


def resolve_period(ctx, cycle: str) -> tuple[date | None, date | None]:
    """(first day, last day) of the pay period to print (see the module docstring), or (None, None) when the cycle has no
    generated period at all in the caller's scope. Raises ReportParamError when the dates touch several periods."""
    generated = Payroll.objects.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False).filter(
        _cycle_q(cycle), ctx.emp_q("employee__")
    )
    d_from, d_to = ctx.date_from, ctx.date_to
    if d_from is None and d_to is None:
        latest = generated.order_by("-period_end", "-period_start").values_list("period_start", "period_end").first()
        return latest if latest else (None, None)
    d_from, d_to = d_from or d_to, d_to or d_from
    periods = sorted(
        set(generated.filter(period_start__lte=d_to, period_end__gte=d_from).values_list("period_start", "period_end"))
    )
    if (d_from, d_to) in periods:
        return d_from, d_to
    if len(periods) == 1:
        return periods[0]
    if not periods:
        return d_from, d_to  # nothing generated for these dates: an empty statement that says so
    names = ", ".join(period_label(a, b) for a, b in periods[:6]) + (" ..." if len(periods) > 6 else "")
    raise ReportParamError(
        f"These dates touch {len(periods)} {CYCLE_LABELS[cycle]} pay periods ({names}). Pick dates inside one period.",
        "dateFrom",
    )


def _no_payroll_count(ctx, cycle: str, start: date, end: date) -> int:
    """Active production employees on the cycle, in the report's scope, who had joined by the period's last day and have
    no payroll for the period."""
    has_payroll = Payroll.objects.filter(
        employee_id=OuterRef("pk"), salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=start, period_end=end
    )
    missing = (
        Employee.objects.filter(ctx.emp_q(), status="active", employment_type="production", production_pay_cycle=cycle)
        .annotate(has_payroll=Exists(has_payroll))
        .filter(has_payroll=False)
        .values_list("join_date", flat=True)
    )
    count = 0
    for text in missing:
        joined, _state = join_date_of(SimpleNamespace(join_date=text))  # it only reads the text field
        if joined is None or joined <= end:
            count += 1
    return count


# ── The report ────────────────────────────────────────────────────────────────


def build_statement_pdf(ctx, out) -> bytes:
    from .hr_reports_salary_statement_files import statement_pdf

    return statement_pdf(out, ctx._cache.get(PLAN_KEY), LAYOUT)


def build_statement_xlsx(ctx, out) -> bytes:
    from .hr_reports_salary_statement_files import statement_xlsx

    return statement_xlsx(out, ctx._cache.get(PLAN_KEY), LAYOUT)


def _run(ctx) -> ReportResult:
    cycle = ctx.params.get("cycle") or CYCLES[0]
    label = CYCLE_LABELS[cycle]
    start, end = resolve_period(ctx, cycle)
    payrolls: list = []
    if start is not None:
        # The filters echo (screen, file header, audit log) is read from these params after the run: it names the
        # period printed, also when the dates were left empty or named only a day of it.
        ctx.params["date_from"], ctx.params["date_to"] = start, end
        scope = Scope(kind=KIND_PRODUCTION, cycle=cycle, period_start=start, period_end=end)
        qs = (
            scope_payrolls(ctx.request, scope)
            .defer("employee__password_hash")
            .filter(ctx.emp_q("employee__"))
            # active employees only, as on the staff statement
            .filter(employee__status="active")
        )
        payment = ctx.params.get("paymentStatus")
        if payment:
            qs = qs.filter(status=payment)
        payrolls = list(qs[: ctx.row_limit])

    info = production_period(start, end, cycle) if start is not None else None
    statement, no_slip, mismatched = statement_rows(payrolls, KIND_PRODUCTION, info) if payrolls else ({}, 0, 0)
    values = {p.id: report_values(statement[p.id]) for p in payrolls}
    blocks = unit_blocks(payrolls, values, SUM_KEYS, _GROUP_COLUMNS)
    ordered = [
        {**r["values"], "_payrollId": r["payrollId"]}
        for block in blocks
        for group in block.groups
        for r in group["rows"]
    ]
    rows = statement_lines(blocks, SUM_KEYS)
    if ctx.purpose in ("xlsx", "pdf"):
        ctx._cache[PLAN_KEY] = blocks  # the files draw the units from these

    notes = []
    if start is None:
        notes.append(f"No {label} production payroll has been generated yet for this selection.")
    else:
        notes += [
            f"Production Salary Statement From {ddmmyyyy(start)} To {ddmmyyyy(end)} ({label} pay period): production "
            "payroll unit by unit (the head office first, employees with no unit last), one line per worker under the "
            "department heading, in employee-code order, with the serial number running on across the unit's "
            "departments. The pay and deductions are the same figures as Production Payroll > Salary.",
            "Sub totals, the unit totals and the total line add up the money columns (Gross Earned to NET); the rate "
            "and the day columns are not added up.",
            "Only ACTIVE employees whose payroll has been generated for the period are listed (the saved payroll is "
            "read; nothing is calculated or saved here). Staff are on Salary Statement.",
            *column_notes(),
        ]
        if not payrolls:
            notes.append(f"No {label} production payroll has been generated for this period and selection.")
        missing = _no_payroll_count(ctx, cycle, start, end)
        if missing:
            notes.append(
                f"{missing} active production employee(s) on the {label} cycle in this selection have no payroll "
                "generated for this period and are not listed. Generate the period on Production Payroll to include "
                "them."
            )
    if no_slip:
        notes.append(
            f"{no_slip} payroll(s) have no stored day-by-day breakdown, so their day counts come from the payroll record "
            "instead."
        )
    if mismatched:
        notes.append(
            f"For {mismatched} payroll(s) NET is the saved payroll figure, which differs from Gross Earned - Total "
            "Deduction: the payroll was edited after it was generated."
        )
    if any(g["label"].startswith(NO_DEPARTMENT) for block in blocks for g in block.groups):
        notes.append(f"Employees with no department are listed under '{NO_DEPARTMENT}', last.")
    slips = slips_for(payrolls) if payrolls and ctx.purpose in ("xlsx", "pdf") else {}
    sections = [statutory_section(payrolls, ordered, slips, production=True)] if ctx.purpose in ("xlsx", "pdf") else []
    return ReportResult(rows=rows, notes=notes, sections=sections)


def column_notes() -> list[str]:
    """How each column is worked out."""
    return [
        "Rate / Shift is the worker's salary per shift. Days Paid is the days the payslip pays (the whole period; after a "
        "change of pay cycle only the days no other payroll paid, plus any catch-up days before the period: Remarks then "
        "says PART PERIOD or INCL. CATCH-UP); Days Worked and Absent count the days; Shifts is the shifts earned (a day "
        "earns 0.25 to 1.5).",
        "Gross Earned is the pay for the shifts earned (Shifts x Rate / Shift) plus any HR bonus.",
        "PF and ESI are deducted only from Co Emp workers (Employees > Co Emp), by the rules of Settings > PF & ESI, from "
        "the first-portion share of the period pay. TDS is deducted only from workers on the TDS list: the TDS percentage "
        "set for them of the period pay (it is 0 for everybody else).",
        "Advance is the advance and term-loan repayments recovered from this period's pay (a balance still owed is not "
        "part of this period's pay).",
        "Others is the late deduction (plus any deduction HR added); Total Deduction = PF + ESI + TDS + Advance + Others; "
        "NET = Gross Earned - Total Deduction, the pay for the period.",
        "ESI and NET are rounded up to the next whole rupee (89.11 -> 90), and Total Deduction adds up the rounded ESI; "
        "every other column keeps the payroll's exact figure.",
    ]


register(
    ReportSpec(
        id=REPORT_ID,
        title="Production Salary Statement",
        description="One pay period of a production cycle (Weekly, BiWeekly, Monthly), unit by unit: each worker's rate, "
        "days, shifts, gross, deductions and NET by department, with sub totals and totals.",
        category=CATEGORY,
        modules=MODULES,
        icon="FileSpreadsheet",
        tags=(
            "production",
            "salary",
            "statement",
            "payroll",
            "shift",
            "weekly",
            "biweekly",
            "monthly",
            "cycle",
            "net",
            "pf",
            "esi",
            "tds",
            "advance",
            "department",
            "unit",
            "printed",
            "register",
        ),
        filters=(
            F.select("cycle", "Pay cycle", CYCLE_OPTIONS, default=CYCLES[0], required=True),
            PERIOD_FILTER,
            *F.scope(employment=False),  # production only; no employee-status filter: active employees only
            F.select("paymentStatus", "Payment status", PAYMENT_OPTIONS, placeholder="Cleared and pending"),
        ),
        columns=COLUMNS,
        run=_run,
        pdf_builder=build_statement_pdf,
        xlsx_builder=build_statement_xlsx,
        landscape=True,
        screen_limit=5_000,
        pdf_max_rows=3_000,
    )
)
