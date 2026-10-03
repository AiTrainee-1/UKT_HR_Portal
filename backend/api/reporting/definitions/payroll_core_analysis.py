"""
Payroll core - analysis reports:

    department-salary-cost    headcount, earnings, statutory and net cost by department (month or financial year)
    payroll-month-comparison  twelve-month payroll trend with month-on-month change
    annual-earnings-statement employee-wise financial-year (or month-wise) earnings and deductions
    salary-master             current salary / shift rate, increment history summary and identifiers per employee
    employer-cost-ctc         monthly and annual cost-to-company estimate (mirrors the Compensation page)

The money reports aggregate the stored slips in SQL (Sum / Count) instead of loading every slip, and read the late
deduction with the same rule as the row-level reports (payroll_core_common.LATE_SQL).
"""

from __future__ import annotations

from decimal import Decimal

from django.db.models import Case, Count, DecimalField, ExpressionWrapper, F, IntegerField, Sum, When

from api.models import BranchSettingsOverride, Employee, PayrollSettings, SalaryIncrement, SalarySlip
from api.ctc import ctc_figures
from api.payroll_views import _d2
from api.user_settings import _SettingsOverlay

from ..common import EMP_COLS, emp_cells
from ..filters import ReportParamError, boolean, period, scope, select
from ..formatting import iso, month_bounds, r2
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import BADGE, CURRENCY, DATE, INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .payroll_core_common import (
    EMPLOYER_ESI_RATE,
    EMPLOYER_PF_RATE,
    LATE_SQL,
    SLIP_TYPE_SQL,
    current_fy,
    financial_year_filter,
    fy_pairs,
    has_module,
    legacy_filter,
    month_text,
    nat_key,
    pairs_q,
    resolve_window,
    slip_filter,
)

CATEGORY = "payroll"
BOTH = ("payroll", "production_payroll")
MONEY = 1.3
_DEC = DecimalField(max_digits=16, decimal_places=2)


def _cur(key: str, label: str, width: float = MONEY, total: str | None = "sum") -> ColumnSpec:
    return ColumnSpec(key, label, CURRENCY, width, total=total)


def _sum(field) -> Sum:
    return Sum(field, output_field=_DEC)


def _f(v) -> float:
    return float(v or 0)


def _pct(part, whole) -> float | None:
    return round(part / whole * 100, 2) if whole else None


def _slip_aggregates() -> dict:
    """The SQL aggregates every money report needs, over the stored slip columns."""
    return dict(
        slips=Count("id"),
        gross=_sum("gross_salary"),
        ot=_sum("ot_amount"),
        pf=_sum("pf_deduction"),
        esi=_sum("esi_deduction"),
        adv=_sum("advance_deduction"),
        late=_sum("late_amt"),
        ded=_sum("total_deductions"),
        net=_sum("net_salary"),
    )


def _base_qs(ctx, pairs, *, full_modules=("payroll",)):
    q, notes = slip_filter(ctx, full_modules=full_modules)
    qs = SalarySlip.objects.filter(q).filter(pairs_q(pairs)).annotate(late_amt=LATE_SQL, stype=SLIP_TYPE_SQL).order_by()
    return qs, notes


def _fy_or_default(ctx) -> str:
    return ctx.params.get("financialYear") or current_fy(ctx.today)


# ═════════════════════════════════════════════════════════════════════════════
#  department-salary-cost
# ═════════════════════════════════════════════════════════════════════════════

DEPT_KEYS = (
    "headcount",
    "slips",
    "basic",
    "hra",
    "otherAllowances",
    "grossEarned",
    "otAmount",
    "totalEarnings",
    "employeePf",
    "employeeEsi",
    "employerEstimate",
    "employerCost",
    "advanceRecovered",
    "lateDeduction",
    "totalDeductions",
    "netPay",
)


def _dept_row(a: dict, dept_label: str, type_label: str) -> dict:
    gross, ot = _f(a["gross"]), _f(a["ot"])
    employer = float(
        _d2(Decimal(str(a["pf_base"] or 0)) * EMPLOYER_PF_RATE / 100)
        + _d2(Decimal(str(a["esi_base"] or 0)) * EMPLOYER_ESI_RATE / 100)
    )
    total_earnings = round(gross + ot, 2)
    net = _f(a["net"])
    heads = a["headcount"]
    return {
        "department": dept_label,
        "employmentType": type_label,
        "headcount": heads,
        "slips": a["slips"],
        "basic": round(_f(a["basic_amt"]), 2),
        "hra": round(_f(a["hra_amt"]), 2),
        "otherAllowances": round(_f(a["other_amt"]), 2),
        "grossEarned": round(gross, 2),
        "otAmount": round(ot, 2),
        "totalEarnings": total_earnings,
        "employeePf": round(_f(a["pf"]), 2),
        "employeeEsi": round(_f(a["esi"]), 2),
        "employerEstimate": round(employer, 2),
        "employerCost": round(total_earnings + employer, 2),
        "advanceRecovered": round(_f(a["adv"]), 2),
        "lateDeduction": round(_f(a["late"]), 2),
        "totalDeductions": round(_f(a["ded"]), 2),
        "netPay": round(net, 2),
        "avgNetPerEmployee": round(net / heads, 2) if heads else None,
    }


def _dept_aggregates(qs, *by):
    return list(
        qs.values("employee__department_id", "employee__department__name", *by).annotate(
            headcount=Count("employee_id", distinct=True),
            basic_amt=_sum("basic"),
            hra_amt=_sum("hra"),
            other_amt=ExpressionWrapper(_sum("allowances") + _sum("incentives") + _sum("bonuses"), output_field=_DEC),
            pf_base=_sum(Case(When(pf_deduction__gt=0, then=F("basic")), default=0, output_field=_DEC)),
            esi_base=_sum(Case(When(esi_deduction__gt=0, then=F("gross_salary")), default=0, output_field=_DEC)),
            **_slip_aggregates(),
        )
    )


def _type_text(stype: str) -> str:
    return "Production" if stype == "production" else "Staff"


def _department_cost_run(ctx) -> ReportResult:
    pairs, window, fy = resolve_window(ctx)
    qs, notes = _base_qs(ctx, pairs)
    by_dept = _dept_aggregates(qs)
    by_type = _dept_aggregates(qs, "stype")
    breakdown = ctx.param("breakdown", "department")

    def dkey(a):
        return (a["employee__department_id"] is None, (a["employee__department__name"] or "Unassigned").lower())

    dept_rows = {a["employee__department_id"]: a for a in by_dept}
    types_by_dept: dict = {}
    for a in by_type:
        types_by_dept.setdefault(a["employee__department_id"], []).append(a)

    rows: list[dict] = []
    for a in sorted(by_dept, key=dkey):
        dname = a["employee__department__name"] or "Unassigned"
        kinds = sorted(
            {_type_text(t["stype"]) for t in types_by_dept.get(a["employee__department_id"], [])}, reverse=True
        )
        if breakdown == "department_type":
            parts = sorted(types_by_dept.get(a["employee__department_id"], []), key=lambda t: t["stype"])
            for t in parts:
                rows.append(_dept_row(t, dname, _type_text(t["stype"])))
            if len(parts) > 1:
                sub = _dept_row(a, f"{dname} total", " + ".join(kinds))
                sub["_kind"] = KIND_SUBTOTAL
                rows.append(sub)
        else:
            rows.append(_dept_row(a, dname, " + ".join(kinds)))

    # company totals come from the department level (an employee has ONE department), so a person who changed type
    # inside the window is not counted twice.
    company = [_dept_row(a, "", "") for a in dept_rows.values()]
    total_cost = round(sum(r["employerCost"] for r in company), 2)
    for r in rows:
        r["sharePct"] = _pct(r["employerCost"], total_cost)
    totals = None
    if company:
        totals = {k: round(sum(r[k] for r in company), 2) for k in DEPT_KEYS if k not in ("headcount", "slips")}
        totals["headcount"] = sum(r["headcount"] for r in company)
        totals["slips"] = sum(r["slips"] for r in company)
        totals["avgNetPerEmployee"] = round(totals["netPay"] / totals["headcount"], 2) if totals["headcount"] else None
        totals["sharePct"] = 100.0 if total_cost else None

    largest = max(company_named(dept_rows), key=lambda x: x[1], default=None)
    staff_net = round(sum(_f(a["net"]) for a in by_type if a["stype"] == "staff"), 2)
    prod_net = round(sum(_f(a["net"]) for a in by_type if a["stype"] == "production"), 2)
    heads = totals["headcount"] if totals else 0
    summary = [
        {"label": "Employees paid", "value": heads, "format": "integer"},
        {"label": "Total earnings", "value": totals["totalEarnings"] if totals else 0, "format": "currency"},
        {"label": "Employer cost (estimate)", "value": totals["employerCost"] if totals else 0, "format": "currency"},
        {"label": "Net pay", "value": totals["netPay"] if totals else 0, "format": "currency"},
        {"label": "Cost per head", "value": round(total_cost / heads, 2) if heads else None, "format": "currency"},
        {
            "label": f"Largest department share ({largest[0]})" if largest else "Largest department share",
            "value": _pct(largest[1], total_cost) if largest else None,
            "format": "percent",
        },
        {"label": "Staff net pay", "value": staff_net, "format": "currency"},
        {"label": "Production net pay", "value": prod_net, "format": "currency"},
    ]
    all_notes = [
        f"Window: {window}."
        + (
            f" Financial year runs {month_text(*pairs[0])} to {month_text(*pairs[-1])} (the Bonus financial-year start month)."
            if fy
            else ""
        ),
        "Department is each employee's CURRENT department - slips store no department snapshot, so an employee who was "
        "transferred is counted wholly under the department they belong to today. Employees with no department appear "
        "as 'Unassigned'. Headcount counts each person once, even with several production period slips.",
        "Total earnings = gross pay + overtime. Employer cost = total earnings + an ESTIMATE of employer PF "
        f"({EMPLOYER_PF_RATE}% of the Basic wage on slips where PF was deducted) and employer ESI ({EMPLOYER_ESI_RATE}% of "
        "gross pay on slips where ESI was deducted). Payroll does not store employer contributions: these are statutory "
        "rates applied by this report, without the Rs 15,000 PF wage cap, EDLI or admin charges.",
        "Production slips belong to the month their pay period ends in, and they store the whole period wage under Basic "
        "(no HRA / allowance split), so a department with production staff shows their wages in the Basic column. Late "
        "deduction = the slip's late-detection snapshot; advance recovered = the figure stored on the slip. Share % is "
        "each row's share of total employer cost.",
        *notes,
    ]
    if not rows:
        all_notes.append("No salary slips exist for these filters. Generate payroll for the month first.")
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=all_notes)


def company_named(dept_rows: dict) -> list[tuple[str, float]]:
    out = []
    for a in dept_rows.values():
        r = _dept_row(a, a["employee__department__name"] or "Unassigned", "")
        out.append((r["department"], r["employerCost"]))
    return out


register(
    ReportSpec(
        id="department-salary-cost",
        title="Department-wise Salary Cost",
        description="Headcount, earnings, statutory deductions, employer cost estimate and net pay by department.",
        category=CATEGORY,
        modules=BOTH,
        icon="Building2",
        tags=(
            "department",
            "cost",
            "payroll cost",
            "headcount",
            "employer pf",
            "employer esi",
            "annual",
            "financial year",
        ),
        filters=(
            period(default="lastMonth"),
            financial_year_filter(help="When a financial year is chosen it replaces the month."),
            *scope(designation=False, employee=False, status="all"),
            legacy_filter(),
            select(
                "breakdown",
                "Break down by",
                [("department", "Department"), ("department_type", "Department and staff / production")],
                default="department",
                placeholder="Department",
            ),
        ),
        columns=(
            ColumnSpec("department", "Department", TEXT, 2.0),
            ColumnSpec("employmentType", "Type", TEXT, 1.6),
            ColumnSpec("headcount", "Employees", INTEGER, 1.1, total="sum"),
            ColumnSpec("slips", "Slips", INTEGER, 0.7, total="sum"),
            # 20 columns: the PDF exporter prints reports of more than 18 columns on landscape A3, which is what the money
            # columns and their bold totals need to stay on one line.
            _cur("basic", "Basic"),
            _cur("hra", "HRA"),
            _cur("otherAllowances", "Other allowances"),
            _cur("grossEarned", "Gross pay"),
            _cur("otAmount", "OT wages"),
            _cur("totalEarnings", "Total earnings", 1.5),
            _cur("employeePf", "Employee PF"),
            _cur("employeeEsi", "Employee ESI"),
            _cur("employerEstimate", "Employer PF + ESI (est.)"),
            _cur("employerCost", "Employer cost (est.)", 1.5),
            _cur("advanceRecovered", "Advance recovered"),
            _cur("lateDeduction", "Late deduction"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay", 1.5),
            _cur("avgNetPerEmployee", "Avg net / employee", total="avg"),
            ColumnSpec("sharePct", "Share %", PERCENT, 0.9),
        ),
        run=_department_cost_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  payroll-month-comparison
# ═════════════════════════════════════════════════════════════════════════════


def _comparison_run(ctx) -> ReportResult:
    fy = _fy_or_default(ctx)
    pairs = fy_pairs(fy)
    qs, notes = _base_qs(ctx, pairs)
    agg = {
        (a["year"], a["month"]): a
        for a in qs.values("year", "month").annotate(
            employees=Count("employee_id", distinct=True),
            earn=ExpressionWrapper(_sum("gross_salary") + _sum("ot_amount"), output_field=_DEC),
            **_slip_aggregates(),
        )
    }
    today = ctx.today
    rows: list[dict] = []
    prev_net = None
    for y, m in pairs:
        a = agg.get((y, m))
        net = round(_f(a["net"]), 2) if a else 0.0
        earnings = round(_f(a["gross"]) + _f(a["ot"]), 2) if a else 0.0
        flag = "Provisional" if month_bounds(y, m)[1] >= today else ("No payroll" if not a else None)
        rows.append(
            {
                "monthLabel": month_text(y, m),
                "employeesPaid": a["employees"] if a else 0,
                "slips": a["slips"] if a else 0,
                "totalEarnings": earnings,
                "otAmount": round(_f(a["ot"]), 2) if a else 0.0,
                "totalDeductions": round(_f(a["ded"]), 2) if a else 0.0,
                "netPay": net,
                "momChangeAmount": round(net - prev_net, 2) if prev_net is not None else None,
                "momChangePct": _pct(net - prev_net, prev_net) if prev_net else None,
                "avgNetPerEmployee": round(net / a["employees"], 2) if a and a["employees"] else None,
                "flag": flag,
            }
        )
        prev_net = net

    have = [r for r in rows if r["slips"]]
    distinct = qs.values("employee_id").distinct().count() if have else 0
    totals = None
    if have:
        totals = {
            "employeesPaid": distinct,
            "slips": sum(r["slips"] for r in rows),
            **{
                k: round(sum(r[k] for r in rows), 2) for k in ("totalEarnings", "otAmount", "totalDeductions", "netPay")
            },
            "momChangeAmount": None,
            "momChangePct": None,
            "avgNetPerEmployee": None,
        }
    hi = max(have, key=lambda r: r["netPay"], default=None)
    lo = min(have, key=lambda r: r["netPay"], default=None)
    summary = [
        {"label": f"Net pay for FY {fy}", "value": totals["netPay"] if totals else 0, "format": "currency"},
        {
            "label": f"Highest month ({hi['monthLabel']})" if hi else "Highest month",
            "value": hi["netPay"] if hi else None,
            "format": "currency",
        },
        {
            "label": f"Lowest month ({lo['monthLabel']})" if lo else "Lowest month",
            "value": lo["netPay"] if lo else None,
            "format": "currency",
        },
        {
            "label": "Average monthly net pay",
            "value": round(sum(r["netPay"] for r in have) / len(have), 2) if have else None,
            "format": "currency",
        },
        {"label": "Employees paid in the year", "value": distinct, "format": "integer"},
    ]
    all_notes = [
        f"Financial year {fy}: {month_text(*pairs[0])} to {month_text(*pairs[-1])} (start month from the Bonus setting). "
        "Every month is listed - a month with no slips shows zeros so the month-on-month change stays meaningful.",
        "Production slips are counted in the month their pay period ends in, and staff and production totals are not "
        "directly comparable: use the Employee type filter for a like-for-like trend. Employees paid in the year counts "
        "each person once; Provisional = the month has not ended, so staff slips may understate pay.",
        "Total earnings = gross pay + overtime. Reads stored slips only; departments are current departments.",
        *notes,
    ]
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="payroll-month-comparison",
        title="Month-on-Month Payroll Comparison",
        description="Twelve-month payroll trend: employees paid, earnings, overtime, deductions, net pay and monthly change.",
        category=CATEGORY,
        modules=BOTH,
        icon="TrendingUp",
        tags=("trend", "month on month", "comparison", "payroll cost", "financial year"),
        filters=(
            financial_year_filter(),
            *scope(designation=False, employee=False, status=None),
            legacy_filter(),
        ),
        columns=(
            ColumnSpec("monthLabel", "Month", TEXT, 1.4),
            ColumnSpec("employeesPaid", "Employees paid", INTEGER, 1.0, total="sum"),
            ColumnSpec("slips", "Slips", INTEGER, 0.8, total="sum"),
            _cur("totalEarnings", "Total earnings"),
            _cur("otAmount", "OT wages"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay"),
            ColumnSpec("momChangeAmount", "Change vs previous month", CURRENCY, 1.4),
            ColumnSpec("momChangePct", "Change %", PERCENT, 0.9),
            _cur("avgNetPerEmployee", "Avg net / employee", total=None),
            ColumnSpec("flag", "Flag", BADGE, 1.1),
        ),
        run=_comparison_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  annual-earnings-statement
# ═════════════════════════════════════════════════════════════════════════════


def _annual_run(ctx) -> ReportResult:
    fy = _fy_or_default(ctx)
    pairs = fy_pairs(fy)
    month_wise = bool(ctx.params.get("monthWise"))
    qs, notes = _base_qs(ctx, pairs)
    ym = ExpressionWrapper(F("year") * 100 + F("month"), output_field=IntegerField())
    by = ["employee_id", "stype"] + (["year", "month"] if month_wise else [])
    agg = list(
        qs.values(*by).annotate(
            months=Count(ym, distinct=True),
            basic=_sum("basic"),
            hra=_sum("hra"),
            other=ExpressionWrapper(_sum("allowances") + _sum("incentives") + _sum("bonuses"), output_field=_DEC),
            **_slip_aggregates(),
        )
    )
    emps = Employee.objects.select_related("department", "designation").in_bulk({a["employee_id"] for a in agg})
    rows = []
    for a in agg:
        e = emps[a["employee_id"]]
        earn = round(_f(a["gross"]) + _f(a["ot"]), 2)
        net = round(_f(a["net"]), 2)
        rows.append(
            {
                **emp_cells(e),
                "employmentType": _type_text(a["stype"]),
                "period": month_text(a["year"], a["month"]) if month_wise else f"FY {fy}",
                "monthsPaid": a["months"],
                "basic": round(_f(a["basic"]), 2),
                "hra": round(_f(a["hra"]), 2),
                "otherAllowances": round(_f(a["other"]), 2),
                "otAmount": round(_f(a["ot"]), 2),
                "totalEarnings": earn,
                "pfDeduction": round(_f(a["pf"]), 2),
                "esiDeduction": round(_f(a["esi"]), 2),
                "advanceDeduction": round(_f(a["adv"]), 2),
                "lateDeduction": round(_f(a["late"]), 2),
                "totalDeductions": round(_f(a["ded"]), 2),
                "netPay": net,
                "avgMonthlyNet": round(net / a["months"], 2) if a["months"] else None,
                "_sort": (nat_key(e.employee_code), a["stype"], a.get("year") or 0, a.get("month") or 0),
            }
        )
    rows.sort(key=lambda r: r["_sort"])
    for r in rows:
        r.pop("_sort")

    def col(key):
        return round(sum(r[key] for r in rows), 2)

    summary = [
        {"label": "Employees", "value": len({a["employee_id"] for a in agg}), "format": "integer"},
        {"label": "Total earnings", "value": col("totalEarnings"), "format": "currency"},
        {"label": "Total PF", "value": col("pfDeduction"), "format": "currency"},
        {"label": "Total ESI", "value": col("esiDeduction"), "format": "currency"},
        {"label": "Total net pay", "value": col("netPay"), "format": "currency"},
    ]
    all_notes = [
        f"Financial year {fy}: {month_text(*pairs[0])} to {month_text(*pairs[-1])} (start month from the Bonus setting). "
        "Months paid counts each month with a slip once - a production employee's several period slips in a month "
        "count as one month. Choose 'Month-wise rows' to see one row per month instead.",
        "Total earnings = gross pay + overtime; for production, Basic is the period wages (there is no HRA / allowance "
        "split). Employees who have left are included when they were paid in the year. An employee who changed between "
        "staff and production has one row per type.",
        "This is a payroll earnings statement built from the stored slips. It is NOT a Form 16: the system holds no "
        "income-tax (TDS) data.",
        *notes,
    ]
    if not rows:
        all_notes.append("No salary slips exist in this financial year for these filters.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="annual-earnings-statement",
        title="Annual Earnings Statement",
        description="Financial-year earnings heads, PF, ESI, advance and late deductions and net pay per employee.",
        category=CATEGORY,
        modules=BOTH,
        icon="CalendarDays",
        tags=("annual", "financial year", "yearly", "earnings", "form 16", "year end", "fy"),
        filters=(
            financial_year_filter(),
            *scope(status="all"),
            legacy_filter(),
            boolean(
                "monthWise", "Month-wise rows", help="One row per month instead of one per employee (pick an employee)."
            ),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("period", "Period", TEXT, 1.2),
            ColumnSpec("monthsPaid", "Months paid", INTEGER, 0.8, total="sum"),
            _cur("basic", "Basic"),
            _cur("hra", "HRA"),
            _cur("otherAllowances", "Other allowances"),
            _cur("otAmount", "OT wages"),
            _cur("totalEarnings", "Total earnings"),
            _cur("pfDeduction", "PF"),
            _cur("esiDeduction", "ESI"),
            _cur("advanceDeduction", "Advance"),
            _cur("lateDeduction", "Late deduction"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay"),
            _cur("avgMonthlyNet", "Avg monthly net", total=None),
        ),
        run=_annual_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-master
# ═════════════════════════════════════════════════════════════════════════════

# PF / ESI / UAN numbers are statutory identifiers: only roles that already see payroll, salary or the employee
# profile (which carries them) get them here. The report itself is also open to Increment-only roles.
IDENTIFIER_MODULES = ("payroll", "production_payroll", "salary", "salary_slip", "employees")
IDENTIFIER_FILTERS = ("no_pf", "no_esi", "no_uan")

MISSING_OPTIONS = [
    ("no_salary", "No salary / shift rate"),
    ("no_bank", "No bank account"),
    ("no_pf", "No PF number"),
    ("no_esi", "No ESI number"),
    ("no_uan", "No UAN"),
]


def _blank(v) -> bool:
    return not (v or "").strip()


def _missing(e, kind: str) -> bool:
    if kind == "no_salary":
        return not (e.salary_per_shift if e.employment_type == "production" else e.salary_amount)
    return {
        "no_bank": _blank(e.bank_account),
        "no_pf": _blank(e.pf_number),
        "no_esi": _blank(e.esi_number),
        "no_uan": _blank(e.uan_number),
    }[kind]


def mask_account(v) -> str | None:
    text = "".join((v or "").split())
    if not text:
        return None
    return "X" * max(0, len(text) - 4) + text[-4:] if len(text) > 4 else "XXXX"


def _master_run(ctx) -> ReportResult:
    show_ids = any(has_module(ctx, m) for m in IDENTIFIER_MODULES)
    kind = ctx.params.get("missingData")
    if kind in IDENTIFIER_FILTERS and not show_ids:
        raise ReportParamError("Filtering by PF / ESI / UAN needs Payroll, Salary or Employees access.", "missingData")
    emps = sorted(ctx.employees()[: ctx.row_limit], key=lambda e: nat_key(e.employee_code))
    if kind:
        emps = [e for e in emps if _missing(e, kind)]
    incs: dict[int, list] = {}
    for i in (
        SalaryIncrement.objects.filter(ctx.emp_q("employee__"))
        .order_by("employee_id", "effective_date", "id")
        .values("employee_id", "previous_salary", "new_salary", "percent", "effective_date")
    ):
        incs.setdefault(i["employee_id"], []).append(i)

    rows = []
    for e in emps:
        history = incs.get(e.id, [])
        first, last = (history[0], history[-1]) if history else (None, None)
        initial = (
            e.initial_salary
            or (first["previous_salary"] if first else None)
            or (e.salary_amount if e.employment_type == "staff" else None)
        )
        rows.append(
            {
                **emp_cells(e),
                "branch": e.branch.name if e.branch_id else None,
                "employmentType": "Production" if e.employment_type == "production" else "Staff",
                "joinDate": iso(e.join_date),
                "currentSalary": r2(e.salary_amount) if e.salary_amount else None,
                "salaryPerShift": r2(e.salary_per_shift) if e.salary_per_shift else None,
                "initialSalary": r2(initial) if initial else None,
                "totalIncrement": round(sum(float(i["new_salary"] - i["previous_salary"]) for i in history), 2)
                if history
                else None,
                "incrementCount": len(history),
                "lastIncrementDate": last["effective_date"].isoformat() if last else None,
                "lastIncrementPct": r2(last["percent"]) if last else None,
                "pfNumber": ((e.pf_number or "").strip() or None) if show_ids else None,
                "esiNumber": ((e.esi_number or "").strip() or None) if show_ids else None,
                "uanNumber": ((e.uan_number or "").strip() or None) if show_ids else None,
                "bankAccount": mask_account(e.bank_account),
                "status": (e.status or "").title() or None,
            }
        )
    staff = [e for e in emps if e.employment_type == "staff" and e.salary_amount]
    prod = [e for e in emps if e.employment_type == "production" and e.salary_per_shift]
    summary = [
        {"label": "Employees", "value": len(emps), "format": "integer"},
        {
            "label": "Monthly salary commitment (staff)",
            "value": round(sum(float(e.salary_amount) for e in staff), 2),
            "format": "currency",
        },
        {
            "label": "Average staff salary",
            "value": round(sum(float(e.salary_amount) for e in staff) / len(staff), 2) if staff else None,
            "format": "currency",
        },
        {
            "label": "Average rate per shift",
            "value": round(sum(float(e.salary_per_shift) for e in prod) / len(prod), 2) if prod else None,
            "format": "currency",
        },
        {"label": "No salary / rate", "value": sum(1 for e in emps if _missing(e, "no_salary")), "format": "integer"},
        {"label": "No bank account", "value": sum(1 for e in emps if _missing(e, "no_bank")), "format": "integer"},
    ]
    if show_ids:
        summary += [
            {"label": "No PF number", "value": sum(1 for e in emps if _missing(e, "no_pf")), "format": "integer"},
            {"label": "No ESI number", "value": sum(1 for e in emps if _missing(e, "no_esi")), "format": "integer"},
        ]
    no_uan = sum(1 for e in emps if _missing(e, "no_uan"))
    all_notes = [
        "Current salary is the staff monthly salary; production employees are paid per shift (rate per shift column). "
        "Initial salary is the value recorded at joining; where it was never recorded the earliest increment's previous "
        "salary is used, else today's staff salary.",
        "Increment history covers staff salary revisions recorded on the Increment page. A revision made by editing the "
        "employee directly leaves no history row, and production rate changes are not recorded at all.",
        "The bank account is masked to its last 4 digits here - the full number is on the Bank Transfer Advice. "
        + (
            f"{no_uan} employee(s) have no UAN; UAN cannot currently be entered in the application."
            if show_ids
            else "PF / ESI / UAN numbers are hidden: they are shown only to roles with Payroll, Salary or Employees access."
        ),
        "Join date is parsed from free text; it is blank where the stored text is not a recognisable date.",
    ]
    if not rows:
        all_notes.append("No employees match these filters.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="salary-master",
        title="Salary Master",
        description="Current salary or shift rate, initial salary, increment history summary and PF / ESI / UAN identifiers.",
        category=CATEGORY,
        modules=("payroll", "salary", "increment"),
        icon="Scale",
        tags=("salary", "rate", "increment", "pf number", "esi number", "uan", "master", "missing data", "revision"),
        filters=(
            *scope(status="active"),
            select("missingData", "Missing data", MISSING_OPTIONS, placeholder="Show everyone"),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("branch", "Branch", TEXT, 1.2),
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("joinDate", "Join date", DATE, 1.1),
            _cur("currentSalary", "Monthly salary", total=None),
            _cur("salaryPerShift", "Rate per shift", total=None),
            _cur("initialSalary", "Initial salary", total=None),
            _cur("totalIncrement", "Total increment", total=None),
            ColumnSpec("incrementCount", "Increments", INTEGER, 1.0),
            ColumnSpec("lastIncrementDate", "Last increment", DATE, 1.2),
            ColumnSpec("lastIncrementPct", "Last increment %", PERCENT, 1.1),
            ColumnSpec("pfNumber", "PF number", TEXT, 1.4),
            ColumnSpec("esiNumber", "ESI number", TEXT, 1.4),
            ColumnSpec("uanNumber", "UAN", TEXT, 1.4),
            ColumnSpec("bankAccount", "Bank account (masked)", TEXT, 2.0),
            ColumnSpec("status", "Status", BADGE, 0.9),
        ),
        run=_master_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  employer-cost-ctc
# ═════════════════════════════════════════════════════════════════════════════


def _ctc_row(e, s) -> dict:
    """The Compensation page's figures (api.ctc, one shared calculation), with the branch settings passed in (the page's
    helper re-reads the settings for every employee, which would be an N+1 over a whole company)."""
    production = e.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION
    figures = ctc_figures(e, s)
    return {
        **emp_cells(e),
        "branch": e.branch.name if e.branch_id else None,
        "employmentType": "Production" if production else "Staff",
        # "Recorded" = saved on the employee; "Automatic" = none saved yet, so the automatic 50% + 50% split is shown
        "splitStatus": "Recorded" if figures["splitRecorded"] else "Automatic",
        **figures,
    }


def _branch_settings_resolver():
    """``settings_for_employee`` without its side effect: that helper reads PayrollSettings.get(), which INSERTS the
    singleton on a brand-new install, and a report must never write. The same resolution (the company row with the
    employee's branch overrides layered on top) is rebuilt here from two plain reads - which also makes it constant
    in queries however many branches there are."""
    base = PayrollSettings.objects.filter(pk=1).defer("company_logo", "authorized_signature", "signature_image").first()
    base = base or PayrollSettings()
    overrides = dict(BranchSettingsOverride.objects.values_list("branch_id", "overrides"))
    cache: dict = {}

    def settings_of(employee):
        if employee.branch_id is None:
            return base  # an employee with no branch follows the company row
        if employee.branch_id not in cache:
            cache[employee.branch_id] = _SettingsOverlay(
                base, dict(overrides.get(employee.branch_id) or {}), employee.branch_id
            )
        return cache[employee.branch_id]

    return settings_of


def _ctc_run(ctx) -> ReportResult:
    # Not tied to PayrollSettings.compensation_feature_enabled: that switch stops the background OT / Compensation
    # features, while the CTC figures (like the Compensation page's CTC Breakdown) are always available.
    emps = sorted(ctx.employees()[: ctx.row_limit], key=lambda e: nat_key(e.employee_code))
    settings_of = _branch_settings_resolver()

    rows, skipped = [], 0
    for e in emps:
        if not e.salary_amount:
            skipped += 1
            continue
        rows.append(_ctc_row(e, settings_of(e)))

    def col(key):
        return round(sum(r[key] for r in rows), 2)

    monthly_ctc = round(col("grossMonthly") + col("employerPf") + col("employerEsi"), 2)
    summary = [
        {"label": "Employees", "value": len(rows), "format": "integer"},
        {"label": "Monthly cost to company", "value": monthly_ctc, "format": "currency"},
        {"label": "Annual cost to company", "value": col("annualCtc"), "format": "currency"},
        {
            "label": "Average annual CTC",
            "value": round(col("annualCtc") / len(rows), 2) if rows else None,
            "format": "currency",
        },
        {"label": "Employer PF (monthly)", "value": col("employerPf"), "format": "currency"},
        {"label": "Employer ESI (monthly)", "value": col("employerEsi"), "format": "currency"},
    ]
    automatic = sum(1 for r in rows if not r["splitRecorded"])
    all_notes = [
        "ESTIMATE, not a statutory figure. It mirrors the Compensation page: the salary is shown as each employee's "
        "50% + 50% split (Basic + DA + Retaining Allowance, then Other + Petrol + HRA + Special Allowance + CA), employer "
        "PF = the PF rate x the first portion (Basic + DA + Retaining Allowance) with no wage cap or EPS split, and "
        "employer ESI = salary x the EMPLOYEE ESI rate when salary is within the ESI ceiling (the statutory employer "
        "rate is 3.25%, so this understates it).",
        "Annual CTC = (monthly salary + employer PF + employer ESI) x 12. Rates come from each employee's branch settings.",
    ]
    if automatic:
        all_notes.append(
            f"{automatic} employee(s) have no salary split recorded yet (added before the split existed); their automatic "
            "50% + 50% split is shown. Open their Edit Employee page and save to record it - the totals do not change."
        )
    if skipped:
        all_notes.append(
            f"{skipped} employee(s) with no monthly salary are left out (production employees are paid per shift, so a "
            "monthly CTC cannot be computed for them)."
        )
    if not rows:
        all_notes.append("No employees with a monthly salary match these filters.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="employer-cost-ctc",
        title="Employer Cost / CTC Statement",
        description="Monthly and annual cost-to-company per employee: the 50% + 50% salary split (Basic, DA, allowances) and employer PF / ESI estimate.",
        category=CATEGORY,
        modules=("compensation", "payroll"),
        icon="Briefcase",
        tags=("ctc", "cost to company", "employer cost", "employer pf", "employer esi", "compensation", "annual"),
        filters=scope(status="active"),
        columns=(
            *EMP_COLS,
            ColumnSpec("branch", "Branch", TEXT, 1.2),
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("splitStatus", "Salary split", BADGE, 1.1),
            # First portion (50%): Basic + DA + Retaining Allowance. Second portion (50%): the other five.
            _cur("basic", "Basic"),
            _cur("da", "DA"),
            _cur("retainingAllowance", "Retaining Allowance"),
            _cur("otherAllowance", "Other Allowance"),
            _cur("petrolAllowance", "Petrol Allowance"),
            _cur("hra", "HRA"),
            _cur("specialAllowance", "Special Allowance"),
            _cur("ca", "CA"),
            _cur("employerPf", "Employer PF (est.)"),
            _cur("employerEsi", "Employer ESI (est.)"),
            _cur("grossMonthly", "Gross monthly", 1.5),
            _cur("annualCtc", "Annual CTC (est.)", 1.7),
        ),
        run=_ctc_run,
    )
)
