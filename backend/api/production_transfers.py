"""Moving a production worker between pay cycles (owner 2026-11-16): what they were already paid, and the record of the move.

Paying a worker under Weekly and then BiWeekly could pay the same days twice, so a move is never casual:

    * The engine pays the new cycle only for days NO payroll has paid (production_coverage.py): a day can never be paid
      twice, whatever the order of moves, generations and regenerations.
    * The Production Employees page warns before a move with the facts of what was already paid: up to which day, how many
      pay periods and how much on the old cycle, and from which day the new cycle pays.
    * The server refuses (409) a move of a worker who already has payroll unless the request says it was confirmed and
      gives a short reason; every move -assigning an Unassigned worker and taking one off a cycle included- writes a
      ProductionCycleTransfer, which the cycle pages read (New Joiners on the new cycle, Moved out on the old one).

Everything here reads; record_moves() is the only writer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, Max, Q, Sum
from django.utils import timezone

from .models import Employee, Payroll, ProductionCycleTransfer
from .production_coverage import PeriodPlan, draft_json, fmt_day, fmt_range, fmt_ranges, plan_period, ranges_json
from .production_cycles import CYCLE_LABELS
from .production_period import InvalidPeriodConfig, next_cycle_period

REASON_MAX = 500
UNASSIGNED_LABEL = "Unassigned"


def label_of(cycle: str | None) -> str:
    return CYCLE_LABELS.get(cycle or "", UNASSIGNED_LABEL)


def inr(value) -> str:
    """₹ with Indian grouping and no paise (12,34,567)."""
    v = round(float(value or 0))
    sign = "-" if v < 0 else ""
    whole = str(abs(v))
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join([*parts, tail])
    return f"{sign}₹{whole}"


def _plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


# ─────────────────────────────────────────────────────────────────────────────
#  What a worker was already paid
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class CyclePay:
    """The production payroll of one worker on one cycle (None = generated before the cycles existed)."""

    periods: int = 0
    net: Decimal = Decimal("0")
    paid: int = 0  # payment status Paid
    last_end: date | None = None


@dataclass
class PayHistory:
    by_cycle: dict = field(default_factory=dict)  # cycle | None -> CyclePay
    staff_months: int = 0

    def on(self, cycle: str | None) -> CyclePay:
        """What the worker's OLD cycle paid them: its own rows plus rows with no cycle stamped (they are shown under the
        worker's cycle). With no old cycle: every production row."""
        rows = [self.by_cycle.get(cycle), self.by_cycle.get(None)] if cycle else list(self.by_cycle.values())
        out = CyclePay()
        for r in rows:
            if r is None:
                continue
            out.periods += r.periods
            out.net += r.net
            out.paid += r.paid
            if r.last_end and (out.last_end is None or r.last_end > out.last_end):
                out.last_end = r.last_end
        return out


def pay_history(employee_ids) -> dict[int, PayHistory]:
    """employee id -> their production payroll per cycle and how many staff months they have (one query)."""
    out: dict[int, PayHistory] = {int(i): PayHistory() for i in employee_ids}
    if not out:
        return out
    rows = (
        Payroll.objects.filter(employee_id__in=list(out))
        .filter(Q(period_start__isnull=False) | Q(salary_mode=Payroll.SALARY_MODE_MONTHLY))
        .values("employee_id", "pay_cycle", "salary_mode")
        .annotate(
            n=Count("id"),
            net=Sum("final_salary"),
            paid=Count("id", filter=Q(payment_status=Payroll.PAYMENT_PAID)),
            last=Max("period_end"),
        )
    )
    for r in rows:
        history = out[r["employee_id"]]
        if r["salary_mode"] == Payroll.SALARY_MODE_MONTHLY:
            history.staff_months += r["n"]
            continue
        cp = history.by_cycle.setdefault(r["pay_cycle"], CyclePay())
        cp.periods += r["n"]
        cp.net += r["net"] or Decimal("0")
        cp.paid += r["paid"]
        if r["last"] and (cp.last_end is None or r["last"] > cp.last_end):
            cp.last_end = r["last"]
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  The facts of one move
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class MoveFacts:
    employee: Employee
    from_cycle: str | None
    to_cycle: str | None
    changes: bool
    paid_through: date | None  # the last day any payroll of the worker pays (draft or final)
    old: CyclePay  # what the old cycle (or, from Unassigned, every production payroll) paid
    staff_months: int
    first_period: tuple[date, date] | None  # the target cycle's period the move is planned for
    plan: PeriodPlan | None
    pays_from: date | None
    config_problem: str | None = None
    # FINAL payroll (paid, or its period finalized) vs DRAFTS (only Generated, replaced when an overlapping period of the
    # new cycle is generated: owner 2026-11-16), on the old cycle (from Unassigned: any production payroll)
    final_through: date | None = None
    final_periods: int = 0
    final_net: Decimal = Decimal("0")
    drafts: list = field(default_factory=list)

    @property
    def has_history(self) -> bool:
        return self.paid_through is not None

    @property
    def needs_confirmation(self) -> bool:
        """A worker who already has payroll may change cycle only on purpose: confirmed, with a reason."""
        return self.changes and self.has_history

    def message(self) -> str | None:
        """The owner's warning in plain words, with the real cycles, dates and amounts (None: nothing to warn about)."""
        if not self.needs_confirmation:
            return None
        name = f"{self.employee.first_name} {self.employee.last_name}".strip() or self.employee.employee_code
        old_label, new_label = label_of(self.from_cycle), label_of(self.to_cycle)
        where = f"under {old_label}" if self.from_cycle else "on production payroll"
        parts = []
        if self.final_periods:
            parts.append(
                f"{name} has already received salary {where} up to {fmt_day(self.final_through)}: "
                f"{_plural(self.final_periods, 'pay period')}, {inr(self.final_net)} net (paid or finalized)."
            )
        elif self.final_through:
            parts.append(f"{name} has already received salary up to {fmt_day(self.final_through)}.")
        if self.drafts:
            shown = [fmt_range(d.period_start, d.period_end) for d in self.drafts[:3]]
            more = f" and {len(self.drafts) - 3} more" if len(self.drafts) > 3 else ""
            net = sum((d.net or Decimal("0")) for d in self.drafts)
            lead = f"{name} also has" if parts else f"{name} has"
            draft_note = (
                f"{lead} {_plural(len(self.drafts), 'draft payslip')} {where} (generated, not finalized: "
                f"{', '.join(shown)}{more}; {inr(net)} net)."
            )
            if self.to_cycle is not None:
                draft_note += (
                    f" A {new_label} period that shares days with a draft replaces it when it is generated, so those days "
                    f"are paid once, under {new_label}; a draft that shares no day stays on the {old_label} page."
                )
            parts.append(draft_note)
        if self.to_cycle is None:
            parts.append(
                "If you take them off their pay cycle, no payroll will include them until they are assigned again; then "
                "the salary already paid for that time will not be paid again."
            )
        else:
            since = f", from {fmt_day(self.pays_from)}" if self.pays_from else ""
            if self.final_through:
                parts.append(
                    f"If you move them to {new_label}, the salary already paid for that time will not be paid again: "
                    f"only the remaining eligible days are calculated under {new_label}{since}."
                )
            else:
                parts.append(f"If you move them to {new_label}, their days are calculated under {new_label}{since}.")
            if self.plan is not None and self.first_period is not None:
                first = fmt_range(*self.first_period)
                if self.plan.refused:
                    parts.append(
                        f"Every day of the {new_label} period {first} is already paid, so nothing is paid there."
                    )
                else:
                    days = self.plan.paid_days
                    replacing = f", replacing the {self.plan.drafts_text()}" if self.plan.drafts else ""
                    parts.append(
                        f"First {new_label} period: {first}, paying {_plural(days, 'day')} "
                        f"({fmt_ranges(self.plan.paid_ranges)}){replacing}."
                    )
                for c in self.plan.catch_up:
                    n = (c.end - c.start).days + 1
                    parts.append(
                        f"{fmt_range(c.start, c.end)} {'was' if n == 1 else 'were'} not paid by any payroll, so "
                        f"{'it is' if n == 1 else 'they are'} added to that first {new_label} payroll as catch-up days."
                    )
                if self.plan.legacy_gap is not None:
                    g = self.plan.legacy_gap
                    parts.append(
                        f"{fmt_range(g.start, g.end)} were not paid by any payroll; the payroll before them was generated "
                        "before pay cycles existed, so they are not added automatically."
                    )
            parts.append(f"They will be listed under New Joiners on the {new_label} page until HR adds them.")
        if self.config_problem:
            parts.append(f"Note: {self.config_problem}")
        return " ".join(parts)

    def json(self) -> dict:
        plan = self.plan
        return {
            "employeeId": self.employee.id,
            "employeeCode": self.employee.employee_code,
            "name": f"{self.employee.first_name} {self.employee.last_name}".strip(),
            "fromCycle": self.from_cycle,
            "toCycle": self.to_cycle,
            "changes": self.changes,
            "needsConfirmation": self.needs_confirmation,
            "paidThrough": self.paid_through.isoformat() if self.paid_through else None,
            # FINAL payroll only (paid, or its period finalized), and the drafts the new cycle would replace
            "finalThrough": self.final_through.isoformat() if self.final_through else None,
            "finalPeriods": self.final_periods,
            "finalNet": float(self.final_net),
            "draftPeriods": len(self.drafts),
            "replacesDrafts": [draft_json(d) for d in self.plan.drafts] if self.plan is not None else [],
            "paysFrom": self.pays_from.isoformat() if self.pays_from else None,
            "oldCycle": {
                "cycle": self.from_cycle,
                "label": label_of(self.from_cycle) if self.from_cycle else "Production Payroll",
                "periods": self.old.periods,
                "net": float(self.old.net),
                "paidPeriods": self.old.paid,
                "lastPeriodEnd": self.old.last_end.isoformat() if self.old.last_end else None,
            },
            "staffMonths": self.staff_months,
            "firstPeriod": {"start": self.first_period[0].isoformat(), "end": self.first_period[1].isoformat()}
            if self.first_period
            else None,
            "firstPeriodPayDays": plan.paid_days if plan is not None and not plan.refused else 0,
            "payRanges": ranges_json(plan.pay_ranges) if plan is not None else [],
            "alreadyPaid": [p.json() for p in plan.already_paid] if plan is not None else [],
            "catchUp": [c.json() for c in plan.catch_up] if plan is not None else [],
            "legacyGap": plan.legacy_gap.json() if plan is not None and plan.legacy_gap is not None else None,
            "refused": bool(plan is not None and plan.refused),
            "message": self.message(),
        }


def target_period(ps, to_cycle: str | None, branch_id: int | None) -> tuple[tuple[date, date] | None, str | None]:
    """(the target cycle's next due period, or None; why it cannot be worked out, or None)."""
    if to_cycle is None:
        return None, None
    try:
        return next_cycle_period(ps, to_cycle, branch_id=branch_id), None
    except InvalidPeriodConfig as exc:
        return None, str(exc)


def facts_for(
    employees, to_cycle: str | None, ps, branch_id: int | None, spans: dict | None = None
) -> dict[int, MoveFacts]:
    """employee id -> the facts of moving them to `to_cycle` (None = off their cycle). A fixed number of queries."""
    from .production_coverage import spans_for_employees

    employees = list(employees)
    ids = [e.id for e in employees]
    spans = spans if spans is not None else spans_for_employees(ids)
    history = pay_history(ids)
    nxt, problem = target_period(ps, to_cycle, branch_id)
    out = {}
    for emp in employees:
        own = spans.get(emp.id, [])
        paid_through = max((s.end for s in own), default=None)
        final_through = max((s.end for s in own if s.row.final), default=None)
        # the old cycle's own rows (and rows from before the cycles); from Unassigned every production row
        old_cycle = emp.production_pay_cycle

        def on_old(row) -> bool:
            return not row.staff and (old_cycle is None or row.cycle in (old_cycle, None))

        rows = {s.row.payroll_id: s.row for s in own if on_old(s.row)}
        finals = [r for r in rows.values() if r.final]
        drafts = sorted((r for r in rows.values() if not r.final), key=lambda r: (r.period_start, r.payroll_id))
        plan = plan_period(own, nxt[0], nxt[1], to_cycle) if nxt is not None else None
        if plan is not None and not plan.refused:
            pays_from = plan.paid_ranges[0][0]
        else:
            pays_from = final_through + timedelta(days=1) if final_through and to_cycle else None
        hist = history.get(emp.id) or PayHistory()
        out[emp.id] = MoveFacts(
            employee=emp,
            from_cycle=emp.production_pay_cycle,
            to_cycle=to_cycle,
            changes=emp.production_pay_cycle != to_cycle,
            paid_through=paid_through,
            old=hist.on(emp.production_pay_cycle),
            staff_months=hist.staff_months,
            first_period=nxt,
            plan=plan,
            pays_from=pays_from,
            config_problem=problem,
            final_through=max((r.period_end for r in finals), default=None) or final_through,
            final_periods=len(finals),
            final_net=sum((r.net or Decimal("0")) for r in finals),
            drafts=drafts,
        )
    return out


def clean_reason(raw) -> str:
    return " ".join(str(raw or "").split())[:REASON_MAX]


def record_moves(facts: list[MoveFacts], actor: str, reason: str) -> list[ProductionCycleTransfer]:
    """One ProductionCycleTransfer per worker who really changes cycle, with what the old cycle had paid them."""
    now = timezone.now()
    rows = [
        ProductionCycleTransfer(
            employee=f.employee,
            from_cycle=f.from_cycle,
            to_cycle=f.to_cycle,
            changed_at=now,
            changed_by=actor,
            reason=reason,
            last_paid_through=f.paid_through,
            pays_from=f.pays_from,
            paid_periods=f.old.periods,
            paid_net=f.old.net,
        )
        for f in facts
        if f.changes
    ]
    return ProductionCycleTransfer.objects.bulk_create(rows)


def transfers_json(employee_id: int) -> list[dict]:
    """Every move of one worker, newest first (the transfer history on Production Employees)."""
    from .production_period_workflow import move_json

    return [
        move_json(m)
        for m in ProductionCycleTransfer.objects.filter(employee_id=employee_id).order_by("-changed_at", "-id")
    ]


def latest_moves(employee_ids) -> dict[int, ProductionCycleTransfer]:
    """employee id -> their latest move (one query)."""
    out: dict[int, ProductionCycleTransfer] = {}
    ids = list(employee_ids)
    if not ids:
        return out
    for m in (
        ProductionCycleTransfer.objects.filter(employee_id__in=ids)
        .order_by("employee_id", "-changed_at", "-id")
        .distinct("employee_id")
    ):
        out[m.employee_id] = m
    return out


def move_counts(employee_ids) -> dict[int, int]:
    ids = list(employee_ids)
    if not ids:
        return {}
    return dict(
        ProductionCycleTransfer.objects.filter(employee_id__in=ids)
        .values_list("employee_id")
        .annotate(n=Count("id"))
        .values_list("employee_id", "n")
    )
