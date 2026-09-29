"""
Salary deductions caused by attendance, as FINALISED in payroll:

* ``late-salary-impact``     - the late-detection pool (late-in, early-out, excess permissions), free vs billable
  occurrences, shifts deducted and the rupees taken from each slip.
* ``attendance-salary-loss`` - the "salary detection" view: loss of pay for absent days, unpaid leave and half-days
  plus the late penalty, per staff employee.

Both read the values frozen in the generated salary slips (``SalarySlip`` + small ``breakdown_details`` sub-objects),
never a live recomputation, so they always agree with the payslip and with payroll. The live, pre-payroll
late view belongs to the attendance reports.
"""

from __future__ import annotations

from decimal import Decimal

from api.models import SalarySlip

from ..filters import boolean, period, scope, select
from ..formatting import month_label
from ..registry import register
from ..types import BADGE, CURRENCY, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .payroll_statutory_common import (
    PAYROLL_MODULES, STAFF, TYPE_LABEL, as_dict, dec, dec_or_none, dept_name, dept_subtotals, money, month_end,
    natural_key, pct, period_text, slip_type, slip_type_q, visible_types, with_breakdown,
)

_ZERO = Decimal("0")


def _count(value) -> int | None:
    n = dec_or_none(value)
    return None if n is None else int(n)


def _late_penalty(slip, typ: str, has_late_summary: bool) -> Decimal | None:
    """Rupees deducted for lateness, as the engine stored them.

    The breakdown's ``lateShiftPenalty`` is the source (production keeps a penalty ONLY in the breakdown and total,
    while ``other_deductions`` stays 0). Older slips without it: staff falls back to ``other_deductions`` (which
    holds the late penalty for staff); production to any positive residual of total - PF - ESI - advance.
    None = the slip has no late data at all (production with late detection off)."""
    pen = dec_or_none(slip.bd_penalty)
    if pen is not None:
        return pen
    if typ == STAFF:
        return dec(slip.other_deductions)
    residual = dec(slip.total_deductions) - dec(slip.pf_deduction) - dec(slip.esi_deduction) - dec(slip.advance_deduction)
    if residual > 0:
        return residual
    return _ZERO if has_late_summary else None


# -- late detection and salary impact -----------------------------------------------------------------------
_LATE_KEYS = ["lateInCount", "earlyOutCount", "excessPermissionCount", "totalLateCount", "billableLateCount",
              "shiftDeductions", "lateDeductionAmount"]


def _run_late(ctx) -> ReportResult:
    year, month = ctx.period
    min_raw = ctx.param("minLates") or "1"
    min_n = None if min_raw == "all" else int(min_raw)
    only_deducted = bool(ctx.param("onlyDeducted"))
    qs = SalarySlip.objects.filter(
        ctx.emp_q("employee__"), slip_type_q(visible_types(ctx)), year=year, month=month
    ).select_related("employee__department")
    slips = list(with_breakdown(qs, "bd_late", "bd_penalty", "bd_earn", "bd_rate").order_by("employee_id", "id"))

    rows: list[dict] = []
    occurrences = billable = affected = deducted_n = 0
    shifts = amount = _ZERO
    for s in slips:
        emp = s.employee
        typ = slip_type(s)
        late = as_dict(s.bd_late)
        known = bool(late)
        total = _count(late.get("totalLateCount")) if known else None
        pen = _late_penalty(s, typ, known)
        if min_n is not None:
            passes = (total is not None and total >= min_n) or (total is None and pen is not None and pen > 0)
            if not passes:
                continue
        if only_deducted and not (pen is not None and pen > 0):
            continue
        earn = as_dict(s.bd_earn)
        unit = dec_or_none(earn.get("dailyRate")) if typ == STAFF else dec_or_none(s.bd_rate)
        shift_ded = dec_or_none(late.get("shiftDeductions")) if known else None
        bill = _count(late.get("billableLateCount")) if known else None
        earnings = dec(s.gross_salary) + dec(s.ot_amount)
        if total:
            affected += 1
        occurrences += total or 0
        billable += bill or 0
        shifts += shift_ded or _ZERO
        if pen is not None:
            amount += pen
            deducted_n += pen > 0
        rows.append({
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": dept_name(emp),
            "employmentType": TYPE_LABEL[typ],
            "period": period_text(s),
            "lateInCount": _count(late.get("lateInCount")) if known and typ == STAFF else None,
            "earlyOutCount": _count(late.get("earlyOutCount")) if known and typ == STAFF else None,
            "excessPermissionCount": _count(late.get("excessPermissionCount")) if known and typ == STAFF else None,
            "totalLateCount": total,
            "freeAllowance": _count(late.get("freeAllowance")) if known and typ == STAFF else None,
            "freeUsed": _count(late.get("freeAllowanceUsed")) if known and typ == STAFF else None,
            "billableLateCount": bill,
            "shiftDeductions": money(shift_ded),
            "unitRate": money(unit),
            "lateDeductionAmount": money(pen),
            "pctOfEarnings": pct(pen, earnings),
            "netPay": money(dec(s.net_salary)),
        })
    rows.sort(key=lambda r: (r["department"].lower(), natural_key(r["employeeCode"]), r["period"]))
    rows = dept_subtotals(rows, _LATE_KEYS)

    notes = [
        f"Counts and amounts are the values frozen in the salary slips generated for {month_label(year, month)} "
        "(not a live recomputation): one monthly pool of morning late-in days + evening early-out days + approved "
        "permissions beyond the monthly cap; the free allowance is used first, the billable rest is priced by the "
        "slab table in force for the employee's branch when the slip was generated.",
        "Staff deduction = shifts deducted x daily rate; production deduction = shifts deducted x rate per shift "
        "(production late detection is optional and off by default). A dash means the slip holds no late data "
        "(for example production with late detection off, or a slip generated before the late pool was recorded).",
        "Late-days on the slip can be higher than the pool total because a day that carries an excess "
        "permission is one occurrence, not two.",
    ]
    if min_n is not None:
        notes.append("Only slips with at least " + str(min_n) + " late occurrence(s) (or an unexplained late deduction) are listed.")
    summary = [
        {"label": "Employees with lates", "value": affected, "format": "integer"},
        {"label": "Late occurrences", "value": occurrences, "format": "integer"},
        {"label": "Billable occurrences", "value": billable, "format": "integer"},
        {"label": "Shifts deducted", "value": float(shifts), "format": "number"},
        {"label": "Late deduction", "value": money(amount), "format": "currency"},
        {
            "label": "Average per deducted employee",
            "value": money(amount / deducted_n) if deducted_n else None,
            "format": "currency",
        },
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="late-salary-impact",
    title="Late Detection - Salary Impact",
    description="What late-ins, early-outs and excess permissions actually cost: pool counts, free vs billable, "
    "shifts and rupees deducted on each generated slip.",
    category="payroll",
    icon="Timer",
    tags=("late", "salary deduction", "late detection", "permission", "penalty", "payroll"),
    modules=PAYROLL_MODULES,
    filters=(
        period(default="lastMonth"),
        *scope(status=None),
        select(
            "minLates", "Show employees with",
            [("all", "All slips"), ("1", "1 or more lates"), ("3", "3 or more"), ("5", "5 or more"), ("10", "10 or more")],
            default="1",
        ),
        boolean("onlyDeducted", "Only where money was deducted"),
    ),
    columns=(
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("employmentType", "Type", BADGE, 0.9),
        ColumnSpec("period", "Period", TEXT, 1.4),
        ColumnSpec("lateInCount", "Late-in", INTEGER, 0.7, total="sum"),
        ColumnSpec("earlyOutCount", "Early-out", INTEGER, 0.7, total="sum"),
        ColumnSpec("excessPermissionCount", "Excess perm.", INTEGER, 0.8, total="sum"),
        ColumnSpec("totalLateCount", "Pool total", INTEGER, 0.7, total="sum"),
        ColumnSpec("freeAllowance", "Free allowance", INTEGER, 0.8),
        ColumnSpec("freeUsed", "Free used", INTEGER, 0.7),
        ColumnSpec("billableLateCount", "Billable", INTEGER, 0.7, total="sum"),
        ColumnSpec("shiftDeductions", "Shifts deducted", NUMBER, 0.8, total="sum"),
        ColumnSpec("unitRate", "Rate / shift", CURRENCY, 1.1),
        ColumnSpec("lateDeductionAmount", "Late deduction", CURRENCY, 1.2, total="sum"),
        ColumnSpec("pctOfEarnings", "% of earnings", PERCENT, 0.8),
        ColumnSpec("netPay", "Net pay", CURRENCY, 1.2, total="sum"),
    ),
    run=_run_late,
))


# -- salary loss: absent, unpaid leave, half-day (loss of pay) + late -----------------------------------------
_LOSS_KEYS = ["absentDays", "unpaidLeaveDays", "halfDayCount", "halfDayLossDays", "lopDays", "lopAmount",
              "lateDeduction", "totalSalaryImpact"]


def _run_loss(ctx) -> ReportResult:
    year, month = ctx.period
    impact = ctx.param("impact") or "any"
    types = visible_types(ctx) & {STAFF}
    base = SalarySlip.objects.filter(ctx.emp_q("employee__"), slip_type_q(types), year=year, month=month)
    qs = with_breakdown(base.select_related("employee__department"), "bd_summary", "bd_earn", "bd_late", "bd_penalty")
    slips = list(qs.order_by("employee_id", "id"))
    provisional = month_end(year, month) >= ctx.today

    rows: list[dict] = []
    tot = {k: _ZERO for k in ("lop", "late", "absent", "half", "unpaid")}
    affected = 0
    fallback_used = False
    for s in slips:
        emp = s.employee
        summ, earn = as_dict(s.bd_summary), as_dict(s.bd_earn)
        working = Decimal(s.working_days)
        unpaid = dec(s.unpaid_leave_days)
        absent = max(_ZERO, dec(s.absent_days) - unpaid)  # slip.absent_days = absent + unpaid leave
        eff = dec_or_none(summ.get("effectivePaidDays"))
        monthly = dec_or_none(earn.get("monthlySalary"))
        if monthly is None:
            monthly = emp.salary_amount
            fallback_used = True
        halves = _count(summ.get("halfShiftDays")) if summ else None
        if eff is not None:
            lop = max(_ZERO, working - eff)
            half_loss = max(_ZERO, lop - absent - unpaid)  # what is left after absent + unpaid = half-day loss
            paid_days = eff
        else:
            lop, half_loss, paid_days = absent + unpaid, None, None
        gross = dec(s.gross_salary)
        lop_amount = max(_ZERO, monthly - gross) if monthly is not None else None
        pen = _late_penalty(s, STAFF, bool(as_dict(s.bd_late)))
        impact_amt = (lop_amount or _ZERO) + (pen or _ZERO)
        has_impact = (lop_amount or _ZERO) > 0 or lop > 0 or (pen or _ZERO) > 0
        keep = {
            "all": True,
            "any": has_impact,
            "absent": absent > 0,
            "half": (halves or 0) > 0,
            "unpaid": unpaid > 0,
            "late": (pen or _ZERO) > 0,
        }[impact]
        if not keep:
            continue
        affected += has_impact
        tot["lop"] += lop_amount or _ZERO
        tot["late"] += pen or _ZERO
        tot["absent"] += absent
        tot["half"] += Decimal(halves or 0)
        tot["unpaid"] += unpaid
        rows.append({
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": dept_name(emp),
            "monthlySalary": money(monthly),
            "workingDays": int(working),
            "paidDays": money(paid_days),
            "absentDays": money(absent),
            "unpaidLeaveDays": money(unpaid),
            "halfDayCount": halves,
            "halfDayLossDays": money(half_loss),
            "lopDays": money(lop),
            "dailyRate": money(dec_or_none(earn.get("dailyRate"))),
            "lopAmount": money(lop_amount),
            "lateDeduction": money(pen),
            "totalSalaryImpact": money(impact_amt),
            "impactPct": pct(impact_amt, monthly),
            "monthStatus": "Provisional" if provisional else "Month complete",
        })
    rows.sort(key=lambda r: (r["department"].lower(), natural_key(r["employeeCode"])))
    rows = dept_subtotals(rows, _LOSS_KEYS)

    excluded = SalarySlip.objects.filter(
        ctx.emp_q("employee__"), slip_type_q(visible_types(ctx) & {"production"}), year=year, month=month
    ).count()
    notes = [
        "Staff only. Loss of pay = the monthly salary minus the gross salary on the slip, i.e. the pay lost to absent "
        "days, approved-leave days (unpaid: only Casual Leave is paid) and half-days, as payroll pro-rated it. "
        "Loss-of-pay days = working days - effective paid days; half-day loss = what remains after absent and unpaid days.",
        "Late deduction = the late-detection penalty stored on the slip (shifts deducted x daily rate); "
        "see 'Late Detection - Salary Impact' for the pool behind it.",
        f"Production employees are paid shifts x rate per shift, so absence has no defined loss of pay; "
        f"{excluded} production slip(s) for this month are not included here.",
    ]
    if provisional:
        notes.append(
            "This month has not ended: payroll generated mid-month counts the remaining working days as absent, so "
            "losses are overstated until payroll is regenerated after the month closes."
        )
    if fallback_used:
        notes.append(
            "Slips without a stored breakdown use the employee's current profile salary as the monthly salary."
        )
    if impact != "all":
        notes.append("Filtered to employees matching the 'Salary impact' filter; choose 'All staff' to list everyone.")
    summary = [
        {"label": "Loss of pay", "value": money(tot["lop"]), "format": "currency"},
        {"label": "Late deduction", "value": money(tot["late"]), "format": "currency"},
        {"label": "Total salary impact", "value": money(tot["lop"] + tot["late"]), "format": "currency"},
        {"label": "Employees affected", "value": affected, "format": "integer"},
        {"label": "Absent days", "value": float(tot["absent"]), "format": "number"},
        {"label": "Unpaid leave days", "value": float(tot["unpaid"]), "format": "number"},
        {"label": "Half-days", "value": int(tot["half"]), "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="attendance-salary-loss",
    title="Salary Detection - Loss of Pay",
    description="Salary lost to absent days, unpaid leave and half-days, plus the late penalty, per staff employee "
    "for a payroll month.",
    category="payroll",
    icon="UserMinus",
    tags=("salary deduction", "salary detection", "lop", "loss of pay", "absent", "unpaid leave", "half day"),
    modules=("payroll", "salary_slip"),
    filters=(
        period(default="lastMonth"),
        *scope(status=None, employment=False),
        select(
            "impact", "Salary impact",
            [
                ("any", "Any impact"), ("absent", "Absent days"), ("half", "Half-days"), ("unpaid", "Unpaid leave"),
                ("late", "Late deduction"), ("all", "All staff"),
            ],
            default="any",
        ),
    ),
    columns=(
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("monthlySalary", "Monthly salary", CURRENCY, 1.2),
        ColumnSpec("workingDays", "Working days", INTEGER, 0.8),
        ColumnSpec("paidDays", "Paid days", NUMBER, 0.8),
        ColumnSpec("absentDays", "Absent", NUMBER, 0.7, total="sum"),
        ColumnSpec("unpaidLeaveDays", "Unpaid leave", NUMBER, 0.8, total="sum"),
        ColumnSpec("halfDayCount", "Half-days", INTEGER, 0.7, total="sum"),
        ColumnSpec("halfDayLossDays", "Half-day loss (days)", NUMBER, 0.9, total="sum"),
        ColumnSpec("lopDays", "LOP days", NUMBER, 0.8, total="sum"),
        ColumnSpec("dailyRate", "Daily rate", CURRENCY, 1.0),
        ColumnSpec("lopAmount", "LOP amount", CURRENCY, 1.2, total="sum"),
        ColumnSpec("lateDeduction", "Late deduction", CURRENCY, 1.2, total="sum"),
        ColumnSpec("totalSalaryImpact", "Total impact", CURRENCY, 1.3, total="sum"),
        ColumnSpec("impactPct", "% of salary", PERCENT, 0.8),
        ColumnSpec("monthStatus", "Month", BADGE, 1.1),
    ),
    run=_run_loss,
))

