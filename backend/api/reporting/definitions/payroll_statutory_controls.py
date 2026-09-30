"""
Payroll controls: data-quality and reconciliation reports.

They only DETECT. Nothing here regenerates payroll, edits a slip or "fixes" a known defect (advance deductions lost on
regeneration, mark-paid dropping overtime): those need their own approval. Every finding is one row with a plain-English
detail so HR can act on it.
"""

from __future__ import annotations

from decimal import Decimal

from django.db.models import Sum

from api.models import AdvanceRepayment, Employee, Payroll, SalarySlip

from ..filters import boolean, period, scope, select
from ..formatting import month_label, parse_date
from ..registry import register
from ..types import BADGE, CURRENCY, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .payroll_statutory_common import (
    PAYROLL_MODULES,
    PRODUCTION,
    STAFF,
    TYPE_LABEL,
    as_dict,
    blank,
    dec,
    dec_or_none,
    dept_name,
    employee_type_q,
    money,
    month_end,
    natural_key,
    no_slips_note,
    period_text,
    provisional_note,
    provisional_slip_ids,
    read_settings,
    slip_type,
    slip_type_q,
    visible_types,
    with_breakdown,
)

_ZERO = Decimal("0")
_TOL = Decimal("0.01")


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


# -- payroll exceptions ---------------------------------------------------------------------------------------------
EXCEPTIONS = {
    "no-slip": "No slip",
    "no-salary": "No salary set",
    "no-bank": "Bank details",
    "pf-id-missing": "PF ID missing",
    "esi-id-missing": "ESI ID missing",
    "zero-net": "Zero net pay",
    "negative-net": "Negative net pay",
    "provisional": "Provisional",
}
_ORDER = list(EXCEPTIONS)


def _run_exceptions(ctx) -> ReportResult:
    year, month = ctx.period
    types = visible_types(ctx)
    want = ctx.param("exceptionType") or "all"
    emps = list(ctx.employees().filter(employee_type_q(types)))
    slips = list(
        SalarySlip.objects.filter(ctx.emp_q("employee__"), slip_type_q(types), year=year, month=month)
        .select_related("employee__department")
        .defer("breakdown_details")
        .order_by("employee_id", "id")
    )
    by_emp: dict[int, list] = {}
    for s in slips:
        by_emp.setdefault(s.employee_id, []).append(s)
    last_day = month_end(year, month)
    ended = last_day < ctx.today
    provisional_ids = provisional_slip_ids(slips, year, month, ctx.today)

    found: list[tuple[list, dict]] = []  # (sort key, row)

    def add(emp, kind: str, detail: str, typ: str, when: str, net=None):
        found.append(
            (
                [natural_key(emp.employee_code), _ORDER.index(kind), when],
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": _name(emp),
                    "department": dept_name(emp),
                    "employmentType": TYPE_LABEL[typ],
                    "period": when,
                    "exceptionType": EXCEPTIONS[kind],
                    "detail": detail,
                    "netPay": money(net),
                    "_kind": kind,
                },
            )
        )

    for e in emps:
        if e.status != "active":
            continue
        typ = PRODUCTION if e.employment_type == PRODUCTION else STAFF
        rate = e.salary_per_shift if typ == PRODUCTION else e.salary_amount
        label = "salary per shift" if typ == PRODUCTION else "monthly salary"
        if rate is None or rate <= 0:
            add(
                e,
                "no-salary",
                f"No {label} on the profile - payroll skips this employee.",
                typ,
                month_label(year, month),
            )
        elif e.id not in by_emp:
            joined = parse_date(e.join_date)  # text column: an unreadable date simply means "assume employed"
            if joined is not None and joined > last_day:
                continue  # joined after this month: not expected to have a slip for it
            extra = "" if ended else " (the month has not ended yet)"
            add(
                e,
                "no-slip",
                f"Active employee with no salary slip for {month_label(year, month)}{extra}.",
                typ,
                month_label(year, month),
            )

    for emp_id, group in by_emp.items():
        s0 = group[0]
        emp = s0.employee
        typ0 = slip_type(s0)
        gaps = [n for n, v in (("bank account", emp.bank_account), ("IFSC", emp.bank_ifsc)) if blank(v)]
        if gaps:
            add(
                emp,
                "no-bank",
                "Missing " + " and ".join(gaps) + " on the profile.",
                typ0,
                period_text(s0),
                s0.net_salary,
            )
        pf = sum((dec(s.pf_deduction) for s in group), _ZERO)
        esi = sum((dec(s.esi_deduction) for s in group), _ZERO)
        pf_gaps = [n for n, v in (("UAN", emp.uan_number), ("PF no.", emp.pf_number)) if blank(v)]
        if pf > 0 and pf_gaps:
            add(
                emp,
                "pf-id-missing",
                f"PF of Rs. {pf:,.2f} deducted but {' and '.join(pf_gaps)} not on the profile.",
                typ0,
                period_text(s0),
                s0.net_salary,
            )
        if esi > 0 and blank(emp.esi_number):
            add(
                emp,
                "esi-id-missing",
                f"ESI of Rs. {esi:,.2f} deducted but no ESI IP number on the profile.",
                typ0,
                period_text(s0),
                s0.net_salary,
            )
        for s in group:
            typ = slip_type(s)
            net = dec(s.net_salary)
            if net == 0:
                add(
                    emp,
                    "zero-net",
                    f"Net pay is zero (earnings Rs. {dec(s.gross_salary) + dec(s.ot_amount):,.2f}, "
                    f"deductions Rs. {dec(s.total_deductions):,.2f}).",
                    typ,
                    period_text(s),
                    net,
                )
            elif net < 0:
                add(
                    emp,
                    "negative-net",
                    f"Deductions of Rs. {dec(s.total_deductions):,.2f} exceed earnings of "
                    f"Rs. {dec(s.gross_salary) + dec(s.ot_amount):,.2f}.",
                    typ,
                    period_text(s),
                    net,
                )
            if s.id in provisional_ids:
                add(
                    emp,
                    "provisional",
                    "Staff slip generated before the month ended: remaining working days were "
                    "counted as absent until payroll is regenerated."
                    + (" It has not been regenerated since." if ended else ""),
                    typ,
                    period_text(s),
                    net,
                )

    counts = {k: 0 for k in EXCEPTIONS}
    for _key, row in found:
        counts[row["_kind"]] += 1
    found.sort(key=lambda kr: kr[0])
    rows = [{k: v for k, v in r.items() if k != "_kind"} for _key, r in found if want in ("all", r["_kind"])]

    notes = [
        "'No slip' and 'No salary set' are checked for ACTIVE employees only; the likely reason an active employee has no "
        "slip is a missing salary or no working days in the month. Employees whose joining date is after the month are "
        "not expected to have a slip. Production periods are attributed to the month they end "
        "in, so 'No slip' is only meaningful once that month's periods have been generated.",
        "'Bank details' = bank account or IFSC blank; 'PF / ESI ID missing' = a PF / ESI amount was deducted but the "
        "identifier is blank on the employee profile. Staff slips are 'provisional' while their month has not ended, "
        "and stay so after it ends until payroll is regenerated (judged from the last update of the slip and its "
        "payroll row).",
        "Employees with no branch are not visible to branch-limited logins, so they are not checked for those users.",
    ]
    if not rows:
        what = "the selected check" if want != "all" else "any check"
        notes.insert(0, f"No exceptions found for {what} in {month_label(year, month)}.")
    summary = [
        {"label": "Employees checked", "value": len(emps), "format": "integer"},
        {"label": "No slip", "value": counts["no-slip"], "format": "integer"},
        {"label": "No salary set", "value": counts["no-salary"], "format": "integer"},
        {"label": "Bank details missing", "value": counts["no-bank"], "format": "integer"},
        {
            "label": "PF / ESI ID missing",
            "value": counts["pf-id-missing"] + counts["esi-id-missing"],
            "format": "integer",
        },
        {"label": "Zero / negative net", "value": counts["zero-net"] + counts["negative-net"], "format": "integer"},
        {"label": "Provisional slips", "value": counts["provisional"], "format": "integer"},
        {"label": "Findings listed", "value": len(rows), "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="payroll-exceptions",
        title="Payroll Exceptions",
        description="Data-quality checks around a payroll month: missing slips or salary, missing bank / PF / ESI details, "
        "zero or negative net pay and provisional slips.",
        category="payroll",
        icon="TriangleAlert",
        tags=(
            "exceptions",
            "data quality",
            "missing bank",
            "missing uan",
            "zero net",
            "negative net",
            "payroll checks",
        ),
        modules=PAYROLL_MODULES,
        filters=(
            period(default="lastMonth"),
            *scope(status="active"),
            select(
                "exceptionType",
                "Check",
                [("all", "All checks")] + [(k, v) for k, v in EXCEPTIONS.items()],
                default="all",
            ),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.0),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("employmentType", "Type", BADGE, 0.9),
            ColumnSpec("period", "Period", TEXT, 1.4),
            ColumnSpec("exceptionType", "Check", BADGE, 1.2),
            ColumnSpec("detail", "Detail", TEXT, 4.0),
            ColumnSpec("netPay", "Net pay", CURRENCY, 1.1),
        ),
        run=_run_exceptions,
    )
)


# -- minimum wage compliance -----------------------------------------------------------------------------------------
def _run_min_wage(ctx) -> ReportResult:
    year, month = ctx.period
    settings = read_settings()
    rate = dec(settings.min_wage_rate)
    basis = ctx.param("basis") or "day"
    only_below = bool(ctx.param("onlyBelow"))
    if rate <= 0:
        return ReportResult(
            rows=[],
            notes=[
                "The Minimum Rate of Wages is not set (Settings > Salary Slip), so there is nothing to compare against. "
                "Set it and run this check again."
            ],
        )
    qs = SalarySlip.objects.filter(
        ctx.emp_q("employee__"), slip_type_q(visible_types(ctx)), year=year, month=month
    ).select_related("employee__department")
    slips = list(with_breakdown(qs, "bd_summary", "bd_earn").order_by("employee_id", "id"))

    rows: list[dict] = []
    below = checked = 0
    shortfall_total = _ZERO
    skipped_prod = 0
    for s in slips:
        emp = s.employee
        typ = slip_type(s)
        summ, earn = as_dict(s.bd_summary), as_dict(s.bd_earn)
        earned = dec(s.gross_salary)  # basic + HRA + allowances, excluding overtime pay
        if typ == STAFF:
            paid = dec_or_none(summ.get("effectivePaidDays"))
            if paid is None:
                paid = dec(s.present_days) + dec(s.paid_leave_days)
            if basis == "month":
                wage = dec_or_none(earn.get("monthlySalary"))
            else:
                wage = earned / paid if paid > 0 else None
        else:
            if basis == "month":
                skipped_prod += 1
                continue
            paid = dec_or_none(summ.get("totalShifts"))
            if paid is None:
                paid = dec_or_none(as_dict(s.bd_earn).get("totalShifts"))
            wage = earned / paid if paid and paid > 0 else None
        if wage is None:
            result, short = "No data", None
        elif wage < rate:
            result = "Below minimum"
            if basis == "month":
                working = Decimal(s.working_days) or Decimal(1)
                short = (rate - wage) * paid / working
            else:
                short = (rate - wage) * paid
        else:
            result, short = "OK", None
        checked += 1
        below += result == "Below minimum"
        shortfall_total += short or _ZERO
        if only_below and result != "Below minimum":
            continue
        rows.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": _name(emp),
                "department": dept_name(emp),
                "employmentType": TYPE_LABEL[typ],
                "period": period_text(s),
                "paidDays": money(paid),
                "earnedWages": money(earned),
                "wageRate": money(wage),
                "minWageRate": money(rate),
                "shortfallAmount": money(short),
                "result": result,
            }
        )
    rows.sort(key=lambda r: (natural_key(r["employeeCode"]), r["period"]))

    per = "per paid day (staff) / per shift (production)" if basis == "day" else "per month (staff monthly salary)"
    notes = [
        "The Minimum Rate of Wages in Settings is a single figure with no unit and no skill / zone category (it is printed on "
        f"salary slips). It is compared here as a rate {per}; change 'Minimum rate is' if the figure means the other. "
        "Confirm what the figure means before relying on this report.",
        "Wages compared = the slip's gross salary (basic + HRA + allowances, excluding overtime); the system stores no "
        "DA / retaining allowance. Staff wage per paid day = gross / effective paid days; production = gross / shifts. "
        "Shortfall = the amount needed to bring the period's pay up to the minimum on the days paid.",
    ]
    if basis == "month" and skipped_prod:
        notes.append(f"{skipped_prod} production slip(s) skipped: production pay has no monthly wage to compare.")
    warning = provisional_note(len(provisional_slip_ids(slips, year, month, ctx.today)), year, month, ctx.today)
    if warning:
        notes.insert(0, warning)
    if not slips:
        notes.insert(0, no_slips_note(year, month))
    summary = [
        {"label": "Slips checked", "value": checked, "format": "integer"},
        {"label": "Below minimum", "value": below, "format": "integer"},
        {"label": "Total shortfall", "value": money(shortfall_total), "format": "currency"},
        {"label": "Minimum rate used", "value": money(rate), "format": "currency"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="min-wage-compliance",
        title="Minimum Wage Compliance",
        description="Compares each slip's wage rate with the Minimum Rate of Wages configured in Settings and flags "
        "anyone below it.",
        category="payroll",
        icon="Scale",
        tags=("minimum wage", "compliance", "statutory", "rate of wages"),
        modules=PAYROLL_MODULES,
        filters=(
            period(default="lastMonth"),
            *scope(status=None),
            select(
                "basis",
                "Minimum rate is",
                [("day", "Per day / shift"), ("month", "Per month (staff only)")],
                default="day",
                help="The setting has no unit; choose how the configured figure should be read.",
            ),
            boolean("onlyBelow", "Only those below the minimum"),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("employmentType", "Type", BADGE, 0.9),
            ColumnSpec("period", "Period", TEXT, 1.4),
            ColumnSpec("paidDays", "Paid days / shifts", NUMBER, 0.9),
            ColumnSpec("earnedWages", "Earned wages", CURRENCY, 1.2, total="sum"),
            ColumnSpec("wageRate", "Wage rate", CURRENCY, 1.1),
            ColumnSpec("minWageRate", "Minimum rate", CURRENCY, 1.1),
            ColumnSpec("shortfallAmount", "Shortfall", CURRENCY, 1.1, total="sum"),
            ColumnSpec("result", "Result", BADGE, 1.4),
        ),
        run=_run_min_wage,
    )
)


# -- payroll vs slip reconciliation -----------------------------------------------------------------------------------
ISSUES = {
    "net-mismatch": "Net differs",
    "orphan-slip": "Slip without payroll",
    "orphan-payroll": "Payroll without slip",
    "arithmetic": "Arithmetic",
    "advance-mismatch": "Advance mismatch",
    "manual-edit": "Manual edit",
}


def _key(x) -> tuple:
    if x.period_start is not None:
        return ("P", x.employee_id, x.period_start, x.period_end)
    if x.week_number is not None:
        return ("W", x.employee_id, x.year, x.month, x.week_number)
    return ("S", x.employee_id, x.year, x.month)


def _run_recon(ctx) -> ReportResult:
    year, month = ctx.period
    want = ctx.param("issue") or "all"
    types = visible_types(ctx)
    tq = slip_type_q(types)
    slips = list(
        with_breakdown(
            SalarySlip.objects.filter(ctx.emp_q("employee__"), tq, year=year, month=month).select_related(
                "employee__department"
            ),
            "bd_penalty",
        ).order_by("employee_id", "id")
    )
    payrolls = list(
        Payroll.objects.filter(ctx.emp_q("employee__"), tq, year=year, month=month)
        .select_related("employee__department")
        .order_by("employee_id", "id")
    )
    repaid = {
        r["advance__employee_id"]: r["total"]
        for r in AdvanceRepayment.objects.filter(
            ctx.emp_q("advance__employee__"),
            employee_type_q(types, "advance__employee__"),
            month=month,
            year=year,
            is_processed=True,
        )
        .order_by()
        .values("advance__employee_id")
        .annotate(total=Sum("amount"))
    }
    pay_by_key = {_key(p): p for p in payrolls}
    slip_adv: dict[int, Decimal] = {}
    first_slip: dict[int, SalarySlip] = {}
    for s in slips:
        slip_adv[s.employee_id] = slip_adv.get(s.employee_id, _ZERO) + dec(s.advance_deduction)
        first_slip.setdefault(s.employee_id, s)

    found: list[tuple[list, dict]] = []

    def add(emp, issue: str, detail: str, s=None, p=None, adv_processed=None):
        ref = s or p
        typ = slip_type(ref) if ref is not None else (PRODUCTION if emp.employment_type == PRODUCTION else STAFF)
        when = period_text(ref) if ref is not None else month_label(year, month)
        slip_net = dec(s.net_salary) if s else None
        pay_net = dec(p.final_salary) if p else None
        found.append(
            (
                [natural_key(emp.employee_code), list(ISSUES).index(issue), str(_key(ref)) if ref is not None else ""],
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": _name(emp),
                    "department": dept_name(emp),
                    "employmentType": TYPE_LABEL[typ],
                    "period": when,
                    "slipNet": money(slip_net),
                    "payrollNet": money(pay_net),
                    # The variance belongs to the "Net differs" finding ONLY: a bonus edit is one difference however
                    # many findings (net differs, manual edit, arithmetic, advance) describe the same slip, so the
                    # column total and the summary card count it once.
                    "variance": money(pay_net - slip_net)
                    if (issue == "net-mismatch" and slip_net is not None and pay_net is not None)
                    else None,
                    "slipDeductions": money(dec(s.total_deductions)) if s else None,
                    "payrollDeductions": money(dec(p.deductions)) if p else None,
                    "payrollBonus": money(dec(p.bonus)) if p else None,
                    "advanceProcessed": money(adv_processed),
                    "slipAdvance": money(dec(s.advance_deduction)) if s else None,
                    "issue": ISSUES[issue],
                    "detail": detail,
                    "_kind": issue,
                },
            )
        )

    ot_dropped = 0
    for s in slips:
        emp = s.employee
        p = pay_by_key.get(_key(s))
        if p is None:
            add(emp, "orphan-slip", "A salary slip exists but there is no payroll row for it.", s)
        else:
            diff = dec(p.final_salary) - dec(s.net_salary)
            if abs(diff) > _TOL:
                detail = f"Payroll final pay Rs. {dec(p.final_salary):,.2f} vs slip net Rs. {dec(s.net_salary):,.2f}."
                if dec(s.ot_amount) > 0 and abs(diff + dec(s.ot_amount)) <= _TOL:
                    detail += (
                        " The difference is the slip's overtime: payroll was recomputed without it (status change)."
                    )
                    ot_dropped += 1
                add(emp, "net-mismatch", detail, s, p)
            if dec(p.bonus) != 0 or abs(dec(p.deductions) - dec(s.total_deductions)) > _TOL:
                add(
                    emp,
                    "manual-edit",
                    "Payroll bonus or deductions were edited after generation; the slip does not carry those edits.",
                    s,
                    p,
                )
        typ = slip_type(s)
        problems = []
        expected_net = dec(s.gross_salary) + dec(s.ot_amount) - dec(s.total_deductions)
        if abs(expected_net - dec(s.net_salary)) > _TOL:
            problems.append(f"net Rs. {dec(s.net_salary):,.2f} != gross + OT - deductions (Rs. {expected_net:,.2f})")
        late = dec(s.other_deductions) if typ == STAFF else dec(s.bd_penalty)
        parts = dec(s.pf_deduction) + dec(s.esi_deduction) + dec(s.advance_deduction) + late
        if abs(parts - dec(s.total_deductions)) > _TOL:
            problems.append(
                f"total deductions Rs. {dec(s.total_deductions):,.2f} != PF + ESI + advance + late (Rs. {parts:,.2f})"
            )
        if problems:
            text = "; ".join(problems)
            add(emp, "arithmetic", text[0].upper() + text[1:] + ".", s, p)

    slip_keys = {_key(s) for s in slips}
    for p in payrolls:
        if _key(p) not in slip_keys:
            add(p.employee, "orphan-payroll", "A payroll row exists but there is no salary slip for it.", None, p)

    orphan_emps = [e for e in repaid if e not in first_slip]
    extra_emps = (
        {e.id: e for e in Employee.objects.filter(id__in=orphan_emps).select_related("department")}
        if orphan_emps
        else {}
    )
    for emp_id in sorted(set(first_slip) | set(repaid)):
        deducted, processed = slip_adv.get(emp_id, _ZERO), dec(repaid.get(emp_id))
        if abs(deducted - processed) > _TOL:
            s = first_slip.get(emp_id)
            emp = s.employee if s else extra_emps[emp_id]
            add(
                emp,
                "advance-mismatch",
                f"Advance instalments processed for {month_label(year, month)}: Rs. "
                f"{processed:,.2f}; deducted on the slip(s): Rs. {deducted:,.2f}. (Regenerating payroll after "
                "instalments were processed loses the slip deduction.)",
                s,
                pay_by_key.get(_key(s)) if s else None,
                processed,
            )

    counts = {k: 0 for k in ISSUES}
    variance_total = _ZERO
    for _k, r in found:
        counts[r["_kind"]] += 1
        if r["_kind"] == "net-mismatch":
            variance_total += Decimal(str(r["variance"]))
    found.sort(key=lambda kr: kr[0])
    rows = [{k: v for k, v in r.items() if k != "_kind"} for _k, r in found if want in ("all", r["_kind"])]

    notes = [
        f"Compares the Payroll rows with the salary slips for {month_label(year, month)}. Read-only: nothing is regenerated or "
        "corrected here. Slip net pay is the printed figure; Payroll final pay is what the payroll screens total.",
        "Known behaviours this report detects: setting a payroll row to paid recomputes its final pay from gross + bonus - "
        "deductions and drops overtime; regenerating a month after its advance instalments were processed loses the slip's "
        "advance deduction. Arithmetic checks use a Rs. 0.01 tolerance; production late penalties sit inside total deductions.",
        "Variance (payroll - slip) is shown on the 'Net differs' finding only; the other findings of the same slip "
        "repeat its figures without a variance, so the Variance total and the 'Net variance' card count each "
        "difference once.",
    ]
    if not slips and not payrolls and not repaid:
        notes.insert(
            0,
            f"No salary slips or payroll rows exist for {month_label(year, month)} (within your access): generate "
            "payroll first - there is nothing to reconcile yet.",
        )
    elif not rows:
        notes.insert(0, f"No differences found for {month_label(year, month)}: payroll rows and salary slips agree.")
    summary = [
        {"label": "Net pay differs", "value": counts["net-mismatch"], "format": "integer"},
        {"label": "Net variance (payroll - slip)", "value": money(variance_total), "format": "currency"},
        {"label": "Overtime dropped by status change", "value": ot_dropped, "format": "integer"},
        {"label": "Slip without payroll", "value": counts["orphan-slip"], "format": "integer"},
        {"label": "Payroll without slip", "value": counts["orphan-payroll"], "format": "integer"},
        {"label": "Arithmetic issues", "value": counts["arithmetic"], "format": "integer"},
        {"label": "Advance mismatches", "value": counts["advance-mismatch"], "format": "integer"},
        {"label": "Manual edits", "value": counts["manual-edit"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="payroll-slip-reconciliation",
        title="Payroll vs Slip Reconciliation",
        description="Finds payroll rows and salary slips that disagree: net pay differences, missing counterparts, "
        "arithmetic that does not close, advance recoveries and manual edits.",
        category="payroll",
        icon="ArrowRightLeft",
        tags=("reconciliation", "payroll", "slip", "variance", "control", "advance", "mark paid"),
        modules=PAYROLL_MODULES,
        filters=(
            period(default="lastMonth"),
            *scope(status=None, designation=False),
            select("issue", "Issue", [("all", "All issues")] + [(k, v) for k, v in ISSUES.items()], default="all"),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
            ColumnSpec("employeeName", "Employee", TEXT, 1.7),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("employmentType", "Type", BADGE, 0.9),
            ColumnSpec("period", "Period", TEXT, 1.2),
            ColumnSpec("slipNet", "Slip net", CURRENCY, 1.3),
            ColumnSpec("payrollNet", "Payroll final", CURRENCY, 1.3),
            ColumnSpec("variance", "Variance", CURRENCY, 1.3, total="sum"),
            ColumnSpec("slipDeductions", "Slip deductions", CURRENCY, 1.3),
            ColumnSpec("payrollDeductions", "Payroll deductions", CURRENCY, 1.3),
            ColumnSpec("payrollBonus", "Payroll bonus", CURRENCY, 1.1),
            ColumnSpec("advanceProcessed", "Advance processed", CURRENCY, 1.2),
            ColumnSpec("slipAdvance", "Slip advance", CURRENCY, 1.1),
            ColumnSpec("issue", "Issue", BADGE, 1.3),
            ColumnSpec("detail", "Detail", TEXT, 2.2),
        ),
        run=_run_recon,
    )
)
