"""Monthly Payroll Summary (``md-monthly-payroll``): what the workforce cost in a month, by department, and why it moved.

Per department: people paid, gross pay, net pay, deductions, overtime cost, cost per head and the change on the month
before; a KPI strip with the company totals; notes with the main drivers of the change from the Payroll page's cost
bridge. The money is read from the salary slips (what each person was paid) by the Payroll page's own functions
(``payroll_summary``, ``payroll_bridge`` and the department rows behind ``payroll_departments``), so a figure here
equals the Payroll page's to the paisa. Department and unit are each person's CURRENT ones.
"""

from __future__ import annotations

from collections import Counter

from api.md_portal.analytics import payroll as PAY

from ..filters import branches, period
from ..registry import register
from ..types import INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import CATEGORY, CAVEAT_PAYROLL, distinct, inr, kpi, param_errors, scope_from, with_company_row

# Money is shown in whole rupees so a crore-sized company total still fits a portrait page; the cells keep the exact amount
# (the spreadsheet shows it to the rupee but holds the paise).
COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.0),
    ColumnSpec("headcount", "People paid", INTEGER, 0.9),
    ColumnSpec("grossPay", "Gross pay (₹)", INTEGER, 1.5),
    ColumnSpec("netPay", "Net pay (₹)", INTEGER, 1.5),
    ColumnSpec("deductions", "Deductions (₹)", INTEGER, 1.45),
    ColumnSpec("overtimePay", "Overtime cost (₹)", INTEGER, 1.3),
    ColumnSpec("costPerHead", "Cost per head (₹)", INTEGER, 1.3),
    ColumnSpec("grossChange", "Gross change on last month (₹)", INTEGER, 1.5),
    ColumnSpec("grossChangePct", "Change %", PERCENT, 1.0),
)
DRIVERS = 3  # how many steps of the cost bridge the notes name


def _signed(amount: float) -> str:
    return ("+" if amount > 0 else "-" if amount < 0 else "") + inr(abs(amount))


def _driver_notes(bridge: dict) -> list[str]:
    """The bridge in two sentences: how gross pay moved, and the biggest steps that explain it."""
    if not bridge.get("available"):
        return [bridge["reason"]] if bridge.get("reason") else []
    change = bridge["change"] or {}
    moved = change.get("abs") or 0.0
    pct = change.get("pct")
    head = (
        f"Gross pay moved from {inr(bridge['start']['amount'])} ({bridge['previousLabel']}) to "
        f"{inr(bridge['end']['amount'])} ({bridge['monthLabel']}): {_signed(moved)}"
        + (f" ({pct:+.1f}%)" if pct is not None else "")
        + "."
    )
    steps = sorted((s for s in bridge["steps"] if s["amount"]), key=lambda s: -abs(s["amount"]))[:DRIVERS]
    if not steps:
        return [head]
    named = "; ".join(
        f"{s['label']} {_signed(s['amount'])} ({s['people']} {'person' if s['people'] == 1 else 'people'})"
        for s in steps
    )
    return [head, f"Main drivers: {named}."]


def _run(ctx) -> ReportResult:
    year, month = ctx.period
    key = f"{year:04d}-{month:02d}"
    scope = scope_from(ctx)
    with param_errors("period"):
        pay_ctx = S.payroll_context(scope, key, ctx.today)
        summary = PAY.payroll_summary(scope, key)
        bridge = PAY.payroll_bridge(scope, key)
    departments = S.payroll_departments(pay_ctx)

    names = Counter(d["name"] for d in departments)
    rows = []
    for d in departments:
        gross_change = (d["change"] or {}).get("grossPay") or {}
        rows.append(
            {
                "department": f"{d['name']} ({d['unit']})" if names[d["name"]] > 1 and d.get("unit") else d["name"],
                "headcount": d["headcount"],
                "grossPay": d["grossPay"],
                "netPay": d["netPay"],
                "deductions": d["totalDeductions"],
                "overtimePay": d["overtimePay"],
                "costPerHead": d["costPerHead"],
                "grossChange": gross_change.get("abs"),
                "grossChangePct": gross_change.get("pct"),
            }
        )

    t = summary["totals"]
    company_change = ((summary["change"] or {}).get("grossPay")) or {}
    company = (
        {
            "department": "Company",
            "headcount": t["headcount"],
            "grossPay": t["grossPay"],
            "netPay": t["netPay"],
            "deductions": t["totalDeductions"],
            "overtimePay": t["overtimePay"],
            "costPerHead": t["costPerHead"],
            "grossChange": company_change.get("abs"),
            "grossChangePct": company_change.get("pct"),
        }
        if t
        else None
    )
    status = summary.get("status")
    summary_cards = [
        kpi("People paid", t["headcount"] if t else None, "integer"),
        kpi("Gross pay", t["grossPay"] if t else None, "currency"),
        kpi("Net pay", t["netPay"] if t else None, "currency"),
        kpi("Deductions", t["totalDeductions"] if t else None, "currency"),
        kpi("Overtime cost", t["overtimePay"] if t else None, "currency"),
        kpi("Cost per head", t["costPerHead"] if t else None, "currency"),
        kpi("Gross pay vs last month", company_change.get("pct"), "percent"),
        kpi("Payroll status", status["stateLabel"] if t and status else None, "text"),
    ]
    notes = distinct(
        [
            *(summary["notes"] if not t else []),
            f"Payroll status for {summary['monthLabel']}: {status['stateLabel']} "
            f"({status['paidSlips']} of {status['slips']} slips marked paid)."
            if t and status and status["slips"]
            else None,
            *_driver_notes(bridge),
            "Amounts are shown to the nearest rupee. Gross pay is salary earned plus overtime, before deductions. Cost per head is gross pay divided by the "
            "people paid. Deductions are PF, ESI, advance recovery, late deductions and anything else deducted on the "
            "slip. Overtime cost is the overtime pay on the slips.",
            CAVEAT_PAYROLL,
            *(summary["notes"] if t else []),
            *(bridge["notes"] if bridge.get("available") else []),
        ]
    )
    return ReportResult(rows=with_company_row(rows, company, ctx), summary=summary_cards, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-monthly-payroll",
        title="Monthly Payroll Summary",
        description="What a month's payroll cost, by department: gross, net, deductions, overtime and cost per head, "
        "with the change on the month before and what drove it.",
        category=CATEGORY,
        icon="Wallet",
        tags=("md", "executive", "monthly", "payroll", "cost", "salary", "overtime", "bridge"),
        landscape=False,
        md_only=True,
        filters=(period("lastMonth", "Month"), branches("Unit")),
        columns=COLUMNS,
        run=_run,
    )
)
