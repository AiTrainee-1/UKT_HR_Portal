"""Advance & loan reports.

* ``advance-ledger``            one row per advance / term loan: approval, plan, recovered, outstanding.
* ``advance-recovery-schedule`` one row per scheduled instalment: deducted, pending or overdue.

Semantics (see settlement_views / payroll_views):

* Approving an advance creates its instalment plan (``AdvanceRepayment`` rows: one full-amount row
  for a general advance, EMI rows for a term loan). A payroll run deducts the unprocessed
  instalment whose month/year equals the payroll month and flags it ``is_processed``.
* ``Advance.outstanding`` is set to the full amount at creation for *every* status, and
  ``disbursed_at`` is never written - so neither is used here. Recovered = the instalments that
  payroll actually deducted; outstanding = sanctioned amount less that (Approved advances only).
* Overdue = an unprocessed instalment scheduled for a month before the current one. (The legacy
  /api/reports/settlement counted months with no repayment row, which is ~always zero because the
  rows are pre-created.)

Both reports are read-only and never touch payroll.
"""

from __future__ import annotations

import operator
from collections import Counter, defaultdict
from decimal import Decimal
from functools import reduce

from django.db.models import F, Q

from api.models import Advance, AdvanceRepayment

from ..common import EMP_COLS_SHORT, emp_cells, with_subtotals
from ..filters import ReportContext, boolean, scope, select
from ..formatting import MONTH_ABBR, month_label, r2
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    F_DATE_RANGE,
    INTEGER,
    PERCENT,
    TEXT,
    ColumnSpec,
    FilterSpec,
    ReportResult,
    ReportSpec,
)
from .finance_common import (
    describe_bounds,
    distinct_groups,
    ist_date_iso,
    ist_range_q,
    natural_key,
    pretty,
    window_bounds,
    window_filter,
)

ZERO = Decimal("0")

APPROVED, CLOSED, PENDING, REJECTED = "approved", "closed", "pending", "rejected"

TYPE_LABELS = {"general": "General", "term": "Term Loan"}
STATUS_LABELS = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected", "closed": "Closed"}
METHOD_LABELS = {"payroll": "Payroll", "cash": "Cash", "gpay": "GPay"}

TYPE_OPTIONS = (("general", "General advance"), ("term", "Term loan (EMI)"))
STATUS_OPTIONS = (
    ("pending", "Pending approval"),
    ("approved", "Approved (open)"),
    ("closed", "Closed (repaid)"),
    ("rejected", "Rejected"),
)
SORT_OPTIONS = (
    ("department", "Department (with subtotals)"),
    ("newest", "Requested date (newest first)"),
    ("outstanding", "Outstanding (highest first)"),
)
INSTALMENT_STATUS_OPTIONS = (
    ("deducted", "Deducted"),
    ("pending", "Pending (due, not yet deducted)"),
    ("overdue", "Overdue (earlier month, not deducted)"),
)


def _month_text(month: int | None, year: int | None) -> str | None:
    if month and year and 1 <= month <= 12:
        return f"{MONTH_ABBR[month - 1]} {year}"
    return None


def _dept_name(row: dict) -> str:
    return row.get("department") or "Unassigned"


def _sum(values) -> float:
    return round(sum(v for v in values if v is not None), 2)


# ═════════════════════════════════════════════════════════════════════════════
#  advance-ledger
# ═════════════════════════════════════════════════════════════════════════════


def _ledger_run(ctx: ReportContext) -> ReportResult:
    p = ctx.params
    today = ctx.today
    cur = (today.year, today.month)
    lo, hi = window_bounds(p.get("requested"), today)

    qs = (
        Advance.objects.select_related("employee__department", "employee__designation")
        .prefetch_related("repayments")
        .filter(ctx.emp_q("employee__"))
    )
    if p.get("status"):
        qs = qs.filter(status__in=p["status"])
    if p.get("advanceType"):
        qs = qs.filter(advance_type=p["advanceType"])
    if lo or hi:
        qs = qs.filter(ist_range_q("created_at", lo, hi))
    if p.get("overdueOnly"):
        overdue_rows = AdvanceRepayment.objects.filter(is_processed=False).filter(
            Q(year__lt=cur[0]) | Q(year=cur[0], month__lt=cur[1])
        )
        qs = qs.filter(status=APPROVED, id__in=overdue_rows.values("advance_id"))
    advances = list(qs.order_by("employee__employee_code", "created_at", "id")[: ctx.row_limit])

    entries: list[tuple[dict, dict]] = []  # (row, facts about it that the summary needs)
    balance_mismatch = 0
    closed_shortfall = ZERO
    closed_short_count = 0
    processed_on_unsanctioned = 0
    no_plan = 0
    short_plan = 0
    unscheduled = ZERO
    for a in advances:
        emp = a.employee
        reps = list(a.repayments.all())  # prefetched: no query per advance
        processed = [r for r in reps if r.is_processed]
        repaid = sum((r.amount for r in processed), ZERO)
        approved = a.status == APPROVED
        sanctioned = a.status in (APPROVED, CLOSED)

        outstanding = None
        if approved:
            outstanding = max(ZERO, a.amount - repaid)
        elif a.status == CLOSED:
            outstanding = ZERO
            if a.amount - repaid > ZERO:
                closed_shortfall += a.amount - repaid
                closed_short_count += 1
        if sanctioned and abs(a.total_repaid - repaid) > Decimal("0.005"):
            balance_mismatch += 1
        if not sanctioned and processed:
            processed_on_unsanctioned += 1
        if approved and not reps:
            no_plan += 1
        elif approved:
            not_planned = a.amount - sum((r.amount for r in reps), ZERO)
            if not_planned > Decimal("0.005"):
                short_plan += 1
                unscheduled += not_planned

        unprocessed = sorted((r for r in reps if not r.is_processed), key=lambda r: (r.year, r.month, r.id))
        overdue = [r for r in unprocessed if (r.year, r.month) < cur] if approved else []
        nxt = unprocessed[0] if (approved and unprocessed) else None

        row = {
            **emp_cells(emp),
            "empStatus": pretty(emp.status),
            "advanceType": pretty(a.advance_type, TYPE_LABELS),
            "status": pretty(a.status, STATUS_LABELS),
            "amount": r2(a.amount),
            "requestedOn": ist_date_iso(a.created_at),
            "approvedOn": ist_date_iso(a.approved_at),
            "approvedBy": a.approved_by or None,
            "purpose": (a.purpose or "").strip() or None,
            "instalments": f"{len(processed)} of {len(reps)}" if reps else None,
            "emi": r2(a.emi_amount) if a.emi_amount and a.emi_amount > 0 else None,
            "repaid": r2(repaid) if (sanctioned or processed) else None,
            "outstanding": r2(outstanding),
            "repaidPct": round(min(100.0, float(repaid / a.amount * 100)), 2) if (sanctioned and a.amount) else None,
            "nextDue": _month_text(nxt.month, nxt.year) if nxt else None,
            "overdueInstalments": len(overdue) if approved else None,
            "overdueAmount": r2(sum((r.amount for r in overdue), ZERO)) if approved else None,
        }
        facts = {
            "sanctioned": sanctioned,
            "approved": approved,
            "pending": a.status == PENDING,
            "left": (emp.status or "").lower() != "active",
            "_code": natural_key(emp.employee_code),
            "_dept": _dept_name(row).lower(),
            "_created": a.created_at.timestamp() if a.created_at else 0.0,
            "_id": a.id,
        }
        entries.append((row, facts))

    sort_by = p.get("sortBy") or "employee"
    if sort_by == "department":
        entries.sort(key=lambda e: (e[1]["_dept"], e[1]["_code"], e[1]["_created"], e[1]["_id"]))
    elif sort_by == "newest":
        entries.sort(key=lambda e: (-e[1]["_created"], e[1]["_id"]))
    elif sort_by == "outstanding":
        entries.sort(
            key=lambda e: (
                -(e[0]["outstanding"] if e[0]["outstanding"] is not None else -1.0),
                e[1]["_code"],
                e[1]["_id"],
            )
        )
    else:
        entries.sort(key=lambda e: (e[1]["_code"], e[1]["_created"], e[1]["_id"]))

    rows = [r for r, _ in entries]
    facts_list = [f for _, f in entries]

    # ── summary: derived from the very rows shown, so cards and totals row always agree ────────
    sanctioned_total = _sum(r["amount"] for r, f in entries if f["sanctioned"])
    summary = [
        {"label": "Advances listed", "value": len(rows), "format": "integer"},
        {"label": "Sanctioned (approved + closed)", "value": sanctioned_total, "format": "currency"},
        {"label": "Recovered", "value": _sum(r["repaid"] for r in rows), "format": "currency"},
        {"label": "Outstanding", "value": _sum(r["outstanding"] for r in rows), "format": "currency"},
        {"label": "Overdue instalments", "value": sum(r["overdueInstalments"] or 0 for r in rows), "format": "integer"},
        {"label": "Overdue amount", "value": _sum(r["overdueAmount"] for r in rows), "format": "currency"},
        {"label": "Awaiting approval", "value": sum(1 for f in facts_list if f["pending"]), "format": "integer"},
        {
            "label": "Outstanding with ex-employees",
            "value": _sum(r["outstanding"] for r, f in entries if f["approved"] and f["left"]),
            "format": "currency",
        },
    ]

    if sort_by == "department" and distinct_groups(rows, _dept_name) > 1 and len(rows) * 2 <= ctx.row_limit:
        rows = with_subtotals(rows, _dept_name, ["repaid", "outstanding", "overdueInstalments", "overdueAmount"])

    notes = [
        "Recovered = instalments already deducted through payroll. Outstanding = sanctioned amount less recovered, "
        "shown for Approved advances only (Closed = 0; Pending and Rejected requests carry no balance).",
        f"Overdue = an instalment scheduled for a month before {month_label(today.year, today.month)} that payroll has "
        "not deducted yet (employee skipped, advance approved after that month's payroll, or payroll not generated).",
        "The system does not record a disbursement date; 'Approved on' is the sanction date.",
    ]
    if advances:
        mix = Counter(a.status for a in advances)
        parts = [f"{mix[k]} {STATUS_LABELS[k]}" for k in (APPROVED, CLOSED, PENDING, REJECTED) if mix.get(k)]
        other = sum(n for k, n in mix.items() if k not in STATUS_LABELS)
        if other:
            parts.append(f"{other} other")
        notes.insert(0, "Status mix: " + ", ".join(parts) + ".")
    window_note = describe_bounds(lo, hi, "Only advances requested")
    if window_note:
        notes.append(window_note + " Choose 'All time' to see the full ledger.")
    if balance_mismatch:
        notes.append(
            f"{balance_mismatch} advance(s) store a 'total repaid' that differs from the instalments payroll deducted; "
            "this report uses the deducted instalments."
        )
    if closed_short_count:
        notes.append(
            f"{closed_short_count} closed advance(s) were closed with less recovered than sanctioned "
            f"(total not recovered: Rs. {closed_shortfall:,.2f}) - closed manually or written off."
        )
    if no_plan:
        notes.append(
            f"{no_plan} approved advance(s) have no instalment schedule, so payroll will not recover them "
            "(a term loan needs an EMI amount when it is approved)."
        )
    if short_plan:
        notes.append(
            f"{short_plan} approved advance(s) have an instalment schedule that adds up to less than the sanctioned amount "
            f"(Rs. {unscheduled:,.2f} is not scheduled for recovery) - extend the plan or recover the balance in final settlement."
        )
    if processed_on_unsanctioned:
        notes.append(
            f"{processed_on_unsanctioned} pending/rejected advance(s) already have deducted instalments - check their status."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="advance-ledger",
        title="Advance & Loan Ledger",
        description="Every salary advance and term loan: approval, instalment plan, amount recovered, outstanding balance and overdue instalments.",
        category="finance",
        modules=("settlement",),
        icon="HandCoins",
        tags=("advance", "loan", "settlement", "outstanding", "emi", "recovery", "term loan"),
        filters=(
            window_filter(
                "requested",
                "Requested",
                help="Filters on the date the advance was requested (IST). All time by default.",
            ),
            select("status", "Status", STATUS_OPTIONS, multi=True),
            select("advanceType", "Advance type", TYPE_OPTIONS),
            *scope(status="all"),
            boolean("overdueOnly", "Only advances with overdue instalments"),
            select("sortBy", "Order by", SORT_OPTIONS, placeholder="Employee code"),
        ),
        columns=(
            *EMP_COLS_SHORT,
            ColumnSpec("empStatus", "Emp. status", BADGE, 0.9),
            ColumnSpec("advanceType", "Type", BADGE, 1.0),
            ColumnSpec("status", "Status", BADGE, 1.0),
            ColumnSpec("amount", "Amount", CURRENCY, 1.2),
            ColumnSpec("requestedOn", "Requested on", DATE, 1.1),
            ColumnSpec("approvedOn", "Approved on", DATE, 1.1),
            ColumnSpec("approvedBy", "Decision by", TEXT, 1.2),
            ColumnSpec("purpose", "Purpose", TEXT, 1.6),
            ColumnSpec("instalments", "Instalments paid", TEXT, 1.15, align="center"),
            ColumnSpec("emi", "EMI", CURRENCY, 1.1),
            ColumnSpec("repaid", "Recovered", CURRENCY, 1.3, total="sum"),
            ColumnSpec("outstanding", "Outstanding", CURRENCY, 1.3, total="sum"),
            ColumnSpec("repaidPct", "% recovered", PERCENT, 0.8),
            ColumnSpec("nextDue", "Next instalment", TEXT, 0.9, align="center"),
            ColumnSpec("overdueInstalments", "Overdue instalments", INTEGER, 1.0, total="sum"),
            ColumnSpec("overdueAmount", "Overdue amount", CURRENCY, 1.2, total="sum"),
        ),
        run=_ledger_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  advance-recovery-schedule
# ═════════════════════════════════════════════════════════════════════════════


def _schedule_run(ctx: ReportContext) -> ReportResult:
    p = ctx.params
    today = ctx.today
    cur_idx = today.year * 12 + today.month
    lo_idx = ctx.date_from.year * 12 + ctx.date_from.month
    hi_idx = ctx.date_to.year * 12 + ctx.date_to.month

    qs = (
        AdvanceRepayment.objects.select_related("advance__employee__department", "advance__employee__designation")
        .filter(ctx.emp_q("advance__employee__"))
        # Instalments of Approved / Closed advances - plus any instalment payroll really deducted, whatever the
        # advance status says now, so a recovery is never hidden.
        .filter(Q(advance__status__in=(APPROVED, CLOSED)) | Q(is_processed=True))
        .annotate(due_idx=F("year") * 12 + F("month"))
        .filter(due_idx__gte=lo_idx, due_idx__lte=hi_idx)
    )
    if p.get("advanceType"):
        qs = qs.filter(advance__advance_type=p["advanceType"])
    wanted = p.get("instalmentStatus") or []
    if wanted:
        conds = []
        if "deducted" in wanted:
            conds.append(Q(is_processed=True))
        if "pending" in wanted:
            conds.append(Q(is_processed=False, due_idx__gte=cur_idx))
        if "overdue" in wanted:
            conds.append(Q(is_processed=False, due_idx__lt=cur_idx))
        qs = qs.filter(reduce(operator.or_, conds))
    reps = list(qs.order_by("year", "month", "advance__employee__employee_code", "id")[: ctx.row_limit])

    # Position of each instalment inside its advance's full plan (needs the siblings that fall outside the filter).
    plan: dict[int, tuple[int, int, Decimal]] = {}
    plan_end: dict[int, Decimal] = {}  # what each advance's whole schedule adds up to
    siblings: dict[int, list[tuple[int, Decimal]]] = defaultdict(list)
    adv_ids = {r.advance_id for r in reps}
    if adv_ids:
        for adv_id, rid, amt in (
            AdvanceRepayment.objects.filter(advance_id__in=adv_ids)
            .order_by("year", "month", "id")
            .values_list("advance_id", "id", "amount")
        ):
            siblings[adv_id].append((rid, amt))
    for adv_id, items in siblings.items():
        cum = ZERO
        for pos, (rid, amt) in enumerate(items, start=1):
            cum += amt
            plan[rid] = (pos, len(items), cum)
        plan_end[adv_id] = cum

    entries: list[tuple[dict, dict]] = []
    for r in reps:
        a = r.advance
        emp = a.employee
        idx = r.year * 12 + r.month
        if r.is_processed:
            state, months_late = "Deducted", None
        elif idx < cur_idx:
            state, months_late = "Overdue", cur_idx - idx
        else:
            state, months_late = "Pending", None
        pos, total, cum = plan.get(r.id, (None, None, None))
        row = {
            **emp_cells(emp),
            "empStatus": pretty(emp.status),
            "advanceType": pretty(a.advance_type, TYPE_LABELS),
            "advanceStatus": pretty(a.status, STATUS_LABELS),
            "advanceAmount": r2(a.amount),
            "instalmentNo": f"{pos} of {total}" if pos else None,
            "dueMonth": _month_text(r.month, r.year),
            "amount": r2(r.amount),
            "paymentMethod": pretty(r.payment_method, METHOD_LABELS),
            "status": state,
            "monthsLate": months_late,
            "balanceAfter": r2(max(ZERO, a.amount - cum)) if cum is not None else None,
            "notes": (r.notes or "").strip() or None,
        }
        facts = {
            "state": state,
            "left": (emp.status or "").lower() != "active",
            "_dept": _dept_name(row).lower(),
            "_code": natural_key(emp.employee_code),
            "_due": (r.year, r.month),
            "_id": r.id,
        }
        entries.append((row, facts))
    entries.sort(key=lambda e: (e[1]["_dept"], e[1]["_code"], e[1]["_due"], e[1]["_id"]))
    rows = [r for r, _ in entries]

    def amount_of(state: str) -> float:
        return _sum(r["amount"] for r, f in entries if f["state"] == state)

    at_risk = [(r, f) for r, f in entries if f["left"] and f["state"] != "Deducted"]
    summary = [
        {"label": "Instalments", "value": len(rows), "format": "integer"},
        {"label": "Total scheduled", "value": _sum(r["amount"] for r in rows), "format": "currency"},
        {"label": "Deducted", "value": amount_of("Deducted"), "format": "currency"},
        {"label": "Pending", "value": amount_of("Pending"), "format": "currency"},
        {"label": "Overdue amount", "value": amount_of("Overdue"), "format": "currency"},
        {
            "label": "Overdue instalments",
            "value": sum(1 for _, f in entries if f["state"] == "Overdue"),
            "format": "integer",
        },
        {
            "label": "Not yet recovered - ex-employees",
            "value": _sum(r["amount"] for r, _ in at_risk),
            "format": "currency",
        },
    ]

    if distinct_groups(rows, _dept_name) > 1 and len(rows) * 2 <= ctx.row_limit:
        rows = with_subtotals(rows, _dept_name, ["amount"])

    notes = [
        f"Instalments due {month_label(ctx.date_from.year, ctx.date_from.month)} to "
        f"{month_label(ctx.date_to.year, ctx.date_to.month)}: instalments fall due by month, so every month touched by "
        "the date range is included.",
        "Deducted = payroll already recovered it. Pending = due this month or later and not yet deducted. "
        f"Overdue = scheduled for a month before {month_label(today.year, today.month)} and still not deducted "
        "(employee skipped, advance approved after that month's payroll, or payroll not generated).",
        "Only instalments of Approved and Closed advances are listed, plus any instalment that payroll has deducted. "
        "Payroll deducts each instalment in its own scheduled month.",
        "'Balance after' is the scheduled balance: the sanctioned amount less this and every earlier scheduled instalment.",
    ]
    closed_open = sum(1 for r, f in entries if f["state"] != "Deducted" and r["advanceStatus"] == "Closed")
    if closed_open:
        notes.append(
            f"{closed_open} pending/overdue instalment(s) belong to advances already marked Closed - payroll does not "
            "check the advance status and would still deduct them; review before the next payroll run."
        )
    if at_risk:
        notes.append(
            f"{len(at_risk)} pending/overdue instalment(s) belong to employees who are no longer active - "
            "recover them through final settlement."
        )
    short_plans = {
        r.advance_id
        for r in reps
        if r.advance.status == APPROVED and r.advance.amount - plan_end.get(r.advance_id, ZERO) > Decimal("0.005")
    }
    if short_plans:
        notes.append(
            f"{len(short_plans)} approved advance(s) listed here have a schedule that adds up to less than the "
            "sanctioned amount, so a balance remains after their last instalment (see 'Balance after')."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="advance-recovery-schedule",
        title="Advance Recovery Schedule",
        description="Instalment-level plan of advance and loan recovery: what payroll has deducted, what is due, and what is overdue.",
        category="finance",
        modules=("settlement",),
        icon="CalendarClock",
        tags=("advance", "loan", "instalment", "emi", "due", "overdue", "deduction", "recovery"),
        filters=(
            FilterSpec(
                "dateRange",
                F_DATE_RANGE,
                "Instalments due between",
                default="thisMonth",
                required=True,
                max_days=1100,
                help="Instalments fall due by month; every month touched by the range is included.",
            ),
            select("instalmentStatus", "Instalment status", INSTALMENT_STATUS_OPTIONS, multi=True),
            select("advanceType", "Advance type", TYPE_OPTIONS),
            *scope(status="all"),
        ),
        columns=(
            *EMP_COLS_SHORT,
            ColumnSpec("empStatus", "Emp. status", BADGE, 0.9),
            ColumnSpec("advanceType", "Type", BADGE, 1.0),
            ColumnSpec("advanceStatus", "Advance status", BADGE, 1.0),
            ColumnSpec("advanceAmount", "Advance amount", CURRENCY, 1.2),
            ColumnSpec("instalmentNo", "Instalment", TEXT, 1.15, align="center"),
            ColumnSpec("dueMonth", "Due month", TEXT, 1.0, align="center"),
            ColumnSpec("amount", "Instalment amount", CURRENCY, 1.3, total="sum"),
            ColumnSpec("paymentMethod", "Method", BADGE, 1.0),
            ColumnSpec("status", "Status", BADGE, 1.0),
            ColumnSpec("monthsLate", "Months late", INTEGER, 0.8),
            ColumnSpec("balanceAfter", "Balance after", CURRENCY, 1.3),
            ColumnSpec("notes", "Notes", TEXT, 1.3),
        ),
        run=_schedule_run,
    )
)
