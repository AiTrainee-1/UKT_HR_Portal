"""Customise data source "payroll": one row per payroll of the month (staff month rows + production period rows that end in
the month), every money figure as the payroll screens hold it.

The figures are the Salary Statement's own (payroll_statement_views.statement_rows, then the HR Reports' Salary Statement
mappings ``report_values``), so a custom report always agrees with Payroll > Salary Statement, Production Payroll and the
HR Reports' statements: money from the saved Payroll row, PF / ESI / Advance from its salary slip, ESI and NET rounded up
to the next whole rupee as printed. "Paid" is Payroll.payment_status (what the employee sees), "Cleared" is HR's
Payroll.status. Nothing is calculated or saved here.

``payroll_lines`` is shared with the "employees" data source (its Payroll for the month section).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from django.db.models import Q

from api.models import Payroll
from api.payroll_insights import (
    KIND_PRODUCTION,
    KIND_STAFF,
    period_label,
    slip_key,
    slips_for,
    staff_period,
)
from api.payroll_statement_views import statement_rows
from api.production_cycles import CYCLE_LABELS

from .. import filters as Fl
from ..definitions.hr_reports_production_statement import report_values as production_values
from ..definitions.hr_reports_salary_statement import report_values as staff_values
from ..definitions.payroll_core_common import scope_q
from ..definitions.rc_salary_common import PAYROLL_MODULES, may_view
from ..formatting import fmt_dt, month_bounds, month_label, r2
from ..types import BADGE, CURRENCY, DATE, DATETIME, HOURS, INTEGER, NUMBER, TEXT
from .common import employee_cells, employee_fields, employee_order, related, scope_filters
from .fields import Dataset, Field, LoadResult

PAY_MODULES = ("payroll", "production_payroll")
STAFF_ROW_Q = Q(salary_mode=Payroll.SALARY_MODE_MONTHLY, period_start__isnull=True)
PRODUCTION_ROW_Q = Q(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False)
PAYMENT_OPTIONS = ((Payroll.PAYMENT_PAID, "Paid"), (Payroll.PAYMENT_NOT_PAID, "Not paid"))


def _money(key, label, desc=None, total="sum", width=1.2) -> Field:
    return Field(key, label, CURRENCY, "money", "pay", desc, width=width, total=total)


PERIOD_FIELDS = (
    Field("pay.kind", "Payroll type", TEXT, "period", "pay", "Staff (monthly) or Production (pay period)", width=0.9),
    Field("pay.period", "Pay period", TEXT, "period", "pay", width=1.6),
    Field(
        "pay.cycle", "Pay cycle", TEXT, "period", "pay", "Monthly for staff; Weekly / BiWeekly / Monthly for production"
    ),
    Field("pay.period_start", "Period from", DATE, "period", "pay"),
    Field("pay.period_end", "Period to", DATE, "period", "pay"),
    Field(
        "pay.list", "Payroll list", TEXT, "period", "pay", "Main, On hold, or released and paid separately", width=1.4
    ),
)
DAY_FIELDS = (
    Field(
        "pay.company_days",
        "Company / period days",
        INTEGER,
        "days",
        "pay",
        "Staff: the days the month's salary is divided by (Sundays out, holidays in); production: the days of the "
        "period this payroll pays",
    ),  # fmt: skip
    Field(
        "pay.present", "Present days", NUMBER, "days", "pay", "Staff: days paid as worked (a half day 0.5)", total="sum"
    ),
    Field("pay.cl", "CL days", NUMBER, "days", "pay", "Staff: approved Casual Leave paid", total="sum"),
    Field("pay.hd", "Holidays paid", NUMBER, "days", "pay", "Staff: company holidays of the month paid", total="sum"),
    Field(
        "pay.paid_days",
        "Days / shifts paid",
        NUMBER,
        "days",
        "pay",
        "Staff: Present + CL + holidays; production: the shifts paid",
        total="sum",
    ),  # fmt: skip
    Field("pay.lop_days", "LOP days", NUMBER, "days", "pay", "Staff: company days not paid", total="sum"),
    Field("pay.worked", "Days worked", NUMBER, "days", "pay", "Production", total="sum"),
    Field("pay.absent", "Days absent", NUMBER, "days", "pay", "Production", total="sum"),
    Field("pay.ot_hours", "OT hours", HOURS, "days", "pay", "Staff overtime hours on the payroll", total="sum"),
)
MONEY_FIELDS = (
    _money("pay.fixed_salary", "Fixed monthly salary", "Staff: the monthly salary this payroll was worked out on"),
    _money("pay.rate", "Rate per shift", "Production", total=None, width=1.0),
    _money("pay.basic", "Basic salary (50%)", "Staff: the first half of the monthly salary"),
    _money("pay.other_salary", "Other allowance (50%)", "Staff: the second half of the monthly salary"),
    _money("pay.gross", "Gross pay", "Payroll gross salary (before OT and bonus)"),
    _money("pay.ot_amount", "OT pay"),
    _money("pay.bonus", "Bonus"),
    _money("pay.earned", "Total earned", "Gross + OT + bonus (staff), gross + bonus (production)"),
    _money("pay.pf", "PF"),
    _money("pay.esi", "ESI (as printed)", "Rounded up to the next whole rupee, as printed on the statement"),
    _money("pay.tds", "TDS"),
    _money("pay.advance", "Advance recovered"),
    _money("pay.other_deductions", "Other deductions", "Late / permission deductions and any other deduction"),
    _money("pay.deductions", "Total deductions"),
    _money(
        "pay.net",
        "Net pay (as printed)",
        "The saved net rounded up to the next whole rupee, as the printed Salary Statement shows it",
    ),
    _money(
        "pay.net_saved",
        "Net pay (saved)",
        "The net exactly as the payroll saved it (to the paisa), as the Salary category's Salary Statement shows it",
    ),
)
STATUS_FIELDS = (
    Field("pay.hr_status", "HR status", BADGE, "status", "pay", "Pending or Cleared (HR's check)", width=0.9),
    Field("pay.payment_status", "Payment status", BADGE, "status", "pay", "Paid or Not paid (Mark as Paid)", width=0.9),
    Field("pay.paid_at", "Marked paid at", DATETIME, "status", "pay", width=1.3),
    Field("pay.remarks", "Remarks", TEXT, "status", "pay", "JOINED / LEFT / HOLD ... as on the statement", width=1.6),
)


# ── the payroll lines (shared with the employees data source) ───────────────


@dataclass
class PayLine:
    payroll: Payroll
    kind: str  # staff | production
    cells: dict


def _list_text(p: Payroll) -> str:
    if p.on_hold:
        return "On hold"
    if p.released_from == Payroll.RELEASED_FROM_HOLD:
        return "Released from hold (paid separately)"
    if p.released_from == Payroll.RELEASED_FROM_NEW_JOINER:
        return "New joiner (paid separately)"
    if p.added_to_payroll_at is not None:
        return "New joiner (added)"
    return "Main"


def visible_kinds(ctx) -> set[str]:
    """The payroll kinds this role may read, by the Salary category's rule (rc_salary_common.PAYROLL_MODULES, which the
    payroll pages' own APIs follow too): staff payrolls need Payroll, production payrolls need Production Payroll.
    Production Payroll does not come with Payroll, so a Payroll-only role sees no production pay here either."""
    return {kind for kind in (KIND_STAFF, KIND_PRODUCTION) if may_view(ctx, PAYROLL_MODULES[kind])}


def payroll_lines(ctx, year: int, month: int, *, employee_ids=None, ceiling: int | None = None):
    """(lines, notes, capped): the visible payrolls of the month in the report's scope, as statement values.

    Staff rows are the month's (salary_mode monthly); production rows are the period rows that END in the month (month /
    year are set from period_end). A payroll still parked in New Joiners (not added yet) is left out, as on every payroll
    list; held and released-and-paid-separately payrolls are included and named in Payroll list. Legacy week-number
    production rows are not included."""
    kinds = visible_kinds(ctx)
    notes: list[str] = []
    if not kinds:
        return [], notes, False
    if kinds == {KIND_PRODUCTION}:
        notes.append("Your role can view production payroll only, so staff payrolls are not included.")
    elif kinds == {KIND_STAFF}:
        notes.append(
            "Your role can view staff payroll only (not Production Payroll), so production payrolls are not included."
        )
    # the employee type of the ROW (staff month / production period), not the employee's type today
    want = ctx.params.get("employment_type")
    q = Q()
    if KIND_STAFF in kinds and want in (None, "", KIND_STAFF):
        q |= STAFF_ROW_Q
    if KIND_PRODUCTION in kinds and want in (None, "", KIND_PRODUCTION):
        q |= PRODUCTION_ROW_Q
    if not q:
        return [], notes, False
    qs = Payroll.objects.filter(scope_q(ctx, "employee__"), q, month=month, year=year)
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=list(employee_ids))
    payment = ctx.params.get("paymentStatus")
    if payment:
        qs = qs.filter(payment_status=payment)
    every = list(related(qs).order_by("employee_id", "period_start", "id"))
    rows = [p for p in every if not p.new_joiner_parked]
    parked = len(every) - len(rows)
    if parked:
        notes.append(
            f"{parked} payroll(s) parked in New Joiners (not added to the payroll yet) are not included; they appear once "
            "HR adds them."
        )
    # staff months first, then production periods; each by department and natural employee code
    rows.sort(key=lambda p: (0 if p.period_start is None else 1, employee_order(p.employee), p.period_start or 0))
    capped = ceiling is not None and len(rows) > ceiling
    if capped:
        rows = rows[:ceiling]

    staff = [p for p in rows if p.period_start is None]
    production = [p for p in rows if p.period_start is not None]
    info = staff_period(month, year)
    lines: list[PayLine] = []
    m_start, m_end = month_bounds(year, month)
    label = month_label(year, month)
    if staff:
        statement, _no_slip, _mismatched = statement_rows(staff, KIND_STAFF, info)
        slips = slips_for(staff)
        for p in staff:
            v = statement[p.id]
            rv = staff_values(v, slips.get(slip_key(p)), p.total_working_days)
            cells = {
                "pay.kind": "Staff",
                "pay.period": label,
                "pay.cycle": "Monthly",
                "pay.period_start": m_start.isoformat(),
                "pay.period_end": m_end.isoformat(),
                "pay.fixed_salary": rv["total"],
                "pay.basic": rv["basic"],
                "pay.other_salary": rv["otherSalary"],
                "pay.company_days": rv["companyDays"],
                "pay.present": rv["present"],
                "pay.cl": rv["cl"],
                "pay.hd": rv["hd"],
                "pay.paid_days": rv["totalDays"],
                "pay.lop_days": rv["lop"],
                "pay.earned": rv["eSalary"],
                "pay.pf": rv["pf"],
                "pay.esi": rv["esi"],
                "pay.tds": rv["tds"],
                "pay.advance": rv["advance"],
                "pay.other_deductions": rv["others"],
                "pay.deductions": rv["totalDeduction"],
                "pay.net": rv["net"],
                "pay.remarks": rv.get("remarks") or None,
            }
            lines.append(PayLine(p, KIND_STAFF, _common(p, cells)))
    if production:
        statement, _no_slip, _mismatched = statement_rows(production, KIND_PRODUCTION, info)
        for p in production:
            rv = production_values(statement[p.id])
            cycle = p.pay_cycle or p.employee.production_pay_cycle
            cells = {
                "pay.kind": "Production",
                "pay.period": period_label(p.period_start, p.period_end),
                "pay.cycle": CYCLE_LABELS.get(cycle) if cycle else None,
                "pay.period_start": p.period_start.isoformat(),
                "pay.period_end": p.period_end.isoformat(),
                "pay.rate": rv["rate"],
                "pay.company_days": rv["days"],
                "pay.paid_days": rv["shifts"],
                "pay.worked": rv["worked"],
                "pay.absent": rv["absent"],
                "pay.earned": rv["eSalary"],
                "pay.pf": rv["pf"],
                "pay.esi": rv["esi"],
                "pay.tds": rv["tds"],
                "pay.advance": rv["advance"],
                "pay.other_deductions": rv["others"],
                "pay.deductions": rv["totalDeduction"],
                "pay.net": rv["net"],
                "pay.remarks": rv.get("remarks") or None,
            }
            lines.append(PayLine(p, KIND_PRODUCTION, _common(p, cells)))
    order = {p.id: i for i, p in enumerate(rows)}
    lines.sort(key=lambda ln: order[ln.payroll.id])
    return lines, notes, capped


def _common(p: Payroll, cells: dict) -> dict:
    cells.update(
        {
            "pay.gross": r2(p.gross_salary),
            "pay.ot_amount": r2(p.ot_amount),
            "pay.bonus": r2(p.bonus),
            "pay.net_saved": r2(p.final_salary),
            "pay.ot_hours": r2(p.ot_hours) if p.period_start is None else None,
            "pay.list": _list_text(p),
            "pay.hr_status": "Cleared" if p.status == Payroll.STATUS_PAID else "Pending",
            "pay.payment_status": "Paid" if p.payment_status == Payroll.PAYMENT_PAID else "Not paid",
            "pay.paid_at": fmt_dt(p.payment_paid_at),
        }
    )
    return cells


# Summed per employee by the "employees" data source; the others are not additive.
ADDITIVE = (
    "pay.present", "pay.cl", "pay.hd", "pay.paid_days", "pay.lop_days", "pay.worked", "pay.absent", "pay.ot_hours",
    "pay.gross", "pay.ot_amount", "pay.bonus", "pay.earned", "pay.pf", "pay.esi", "pay.tds", "pay.advance",
    "pay.other_deductions", "pay.deductions", "pay.net", "pay.net_saved",
)  # fmt: skip


def per_employee(lines: list[PayLine]) -> dict[int, dict]:
    """{employee id: the month's payroll figures added up} (a production worker can have several periods ending in the
    month). Payment status: Paid when every payroll is paid, Part paid when some are, else Not paid."""
    grouped: dict[int, list[PayLine]] = defaultdict(list)
    for ln in lines:
        grouped[ln.payroll.employee_id].append(ln)
    out: dict[int, dict] = {}
    for emp_id, group in grouped.items():
        cells: dict = {}
        for key in ADDITIVE:
            vals = [ln.cells.get(key) for ln in group if ln.cells.get(key) is not None]
            cells[key] = round(sum(vals), 2) if vals else None
        paid = sum(1 for ln in group if ln.payroll.payment_status == Payroll.PAYMENT_PAID)
        cells["pay.payment_status"] = "Paid" if paid == len(group) else "Part paid" if paid else "Not paid"
        cells["pay.payrolls"] = len(group)
        out[emp_id] = cells
    return out


# ── the data source ─────────────────────────────────────────────────────────


def _load(ctx, keys: list[str], ceiling: int) -> LoadResult:
    year, month = ctx.period
    lines, notes, capped = payroll_lines(ctx, year, month, ceiling=ceiling)
    rows = [{**employee_cells(ln.payroll.employee), **ln.cells} for ln in lines]
    return LoadResult(rows=rows, notes=notes, capped=capped)


PAYROLL = Dataset(
    id="payroll",
    label="Payroll",
    description="One row per payroll of the month: staff month payrolls and production pay periods ending in the month, "
    "with every money figure and the payment status.",
    grain="payroll",
    filters=(
        Fl.period(),
        *scope_filters(),
        Fl.select("paymentStatus", "Payment status", PAYMENT_OPTIONS, placeholder="Paid and not paid"),
    ),
    sections=(
        ("employee", "Employee"),
        ("period", "Pay period"),
        ("days", "Days and shifts"),
        ("money", "Money"),
        ("status", "Status"),
    ),
    fields=(*employee_fields(), *PERIOD_FIELDS, *DAY_FIELDS, *MONEY_FIELDS, *STATUS_FIELDS),
    default_fields=(
        "emp.code",
        "emp.name",
        "emp.department",
        "pay.kind",
        "pay.period",
        "pay.paid_days",
        "pay.earned",
        "pay.deductions",
        "pay.net",
        "pay.payment_status",
    ),  # fmt: skip
    load=_load,
    modules=PAY_MODULES,
    notes=(
        "Money is read from the saved payrolls (the payroll screens' figures) with PF, ESI and Advance from their salary "
        "slips, exactly as Payroll > Salary Statement shows them; ESI and Net pay (as printed) are rounded up to the next "
        "whole rupee as printed, Net pay (saved) is the exact saved net the Salary category's Salary Statement lists. "
        "Nothing is calculated here.",
        "Staff rows are the month's payrolls; production rows are the pay periods that end in the month. Employee type "
        "follows the payroll row (a staff month or a production period), not the employee's type today.",
        "Payment status is Mark as Paid (what the employee sees); HR status Cleared is HR's own check.",
    ),
)
