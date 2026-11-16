"""Production Payroll period workflow (owner 2026-11-16): the Staff Payroll month workflow, per pay period of a cycle.

Everything here is added ON TOP of the production engine (payroll_views._generate_production_payroll). Nothing in this module
works out or changes a payroll figure: it decides which list a production payroll shows up in, locks a finished pay period,
and records that the period was paid.

    The rows of one period of a cycle: the production payrolls generated for exactly that period on the cycle (and older rows
    with no cycle stamped whose worker is on the cycle now), active workers only, as every payroll list shows them.

    main payroll  the Records, their totals, the bank file, the Salary Statement and its report: every row that is not parked
    New Joiners   rows PARKED by the engine (park_if_needed, right after it saved the row): the worker joined during the
                  period ("new_joiner"), or this is their first period on the cycle after they moved here from another cycle
                  ("transfer", see ProductionCycleTransfer). Calculated as usual, but out of every list above until HR presses
                  "Add to payroll" (one, or all); once added they stay added through every regeneration.
    Payroll Done  finalize(): the period is LOCKED for good. No generate, regenerate, adjust or Mark as Cleared on it, no
                  add to payroll, and no transfer changes it any more; there is no reopen. Refused before the period has
                  ended and while anyone is still parked in it (so no worker's wages are silently dropped).
    Mark as Paid  mark_paid(): HR enters the day the money was paid; every payroll in the period's main payroll gets payment
                  status Paid. Cleared (Payroll.status "paid") stays HR's "verified" check, not payment.
    Unlock        unlock() (owner 2026-11-16: "once finalized, payroll should not be regenerated unless it is explicitly
                  unlocked"): a finalized period that is NOT paid (no Mark as Paid, no payroll of it marked Paid) goes back to
                  Generated, with a reason; the same rights as Payroll Done. A paid period is locked for good.

The owner decided (2026-11-16): no Hold, no Release & pay, no phone message and no change to the employee apps for
production, so payroll_month_workflow.employee_sees_paid keeps its production rule and nobody is notified here.

Who may act (permission_tree.py, production_payroll.*, all at Edit): Payroll Done = .finalize, Mark as Paid = .mark_paid
(both also need a whole-company login: a period is one schedule for every unit), Add to payroll = .new_joiners, Adjust =
.adjust; Mark as Cleared = Production Payroll edit plus the account's own "Mark a salary as cleared" switch.
"""

from __future__ import annotations

from datetime import date, datetime

from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Min, Q, Sum
from django.utils import timezone

from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ, ist_today
from .compensation_shared import parse_join_date
from .models import Employee, Payroll, ProductionCycleTransfer, ProductionPeriodClose
from .production_coverage import fmt_day, fmt_range
from .production_cycles import CYCLE_LABELS
from .production_period import period_ended

# Which list a production payroll of a period is in
MAIN_Q = Q(new_joiner_parked=False)
PARKED_Q = Q(new_joiner_parked=True)

# The permission keys of the workflow (permission_tree.py)
KEY_SECTION = "production_payroll"
KEY_FINALIZE = "production_payroll.finalize"
KEY_MARK_PAID = "production_payroll.mark_paid"
KEY_NEW_JOINERS = "production_payroll.new_joiners"
KEY_ADJUST = "production_payroll.adjust"
KEY_GENERATE = "production_payroll.generate"
KEY_EXPORTS = "production_payroll.exports"

NOTE_BACKFILL = "Cleared before the period workflow"

WHOLE_COMPANY_ONLY = (
    "Only a whole-company login can do this: a pay period is one schedule for every unit. A unit login can see the "
    "period's status but not change it."
)


def cycle_label(cycle: str | None) -> str:
    return CYCLE_LABELS.get(cycle or "", "No pay cycle")


def period_label(cycle: str, start: date, end: date) -> str:
    """'BiWeekly 2 Nov – 15 Nov 2026'."""
    return f"{cycle_label(cycle)} {fmt_range(start, end)}"


# ─────────────────────────────────────────────────────────────────────────────
#  The rows of a period
# ─────────────────────────────────────────────────────────────────────────────


def cycle_q(cycle: str, prefix: str = "") -> Q:
    """Rows of a cycle: generated on it, or generated before the cycles existed (none stamped) for a worker on it now."""
    return Q(**{f"{prefix}pay_cycle": cycle}) | Q(
        **{f"{prefix}pay_cycle__isnull": True, f"{prefix}employee__production_pay_cycle": cycle}
    )


def period_rows(cycle: str, start: date, end: date):
    """Every production payroll of one period of a cycle, company-wide, active workers only."""
    return Payroll.objects.filter(
        salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=start, period_end=end, employee__status="active"
    ).filter(cycle_q(cycle))


def row_cycle(payroll: Payroll) -> str | None:
    """The cycle a production row belongs to: the one it was generated on, or (an older row) its worker's cycle now."""
    if payroll.pay_cycle:
        return payroll.pay_cycle
    emp = getattr(payroll, "employee", None)
    return getattr(emp, "production_pay_cycle", None)


def is_production_period_row(payroll: Payroll) -> bool:
    return payroll.period_start is not None and payroll.period_end is not None


# ─────────────────────────────────────────────────────────────────────────────
#  The lock
# ─────────────────────────────────────────────────────────────────────────────


class PeriodLocked(Exception):
    """A write to a finalized production period: answered as a 409 with this plain message."""


def period_close(cycle: str, start: date, end: date) -> ProductionPeriodClose | None:
    return ProductionPeriodClose.objects.filter(cycle=cycle, period_start=start, period_end=end).first()


def is_locked(cycle: str | None, start: date | None, end: date | None) -> bool:
    if not cycle or start is None or end is None:
        return False
    return ProductionPeriodClose.objects.filter(cycle=cycle, period_start=start, period_end=end).exists()


def locked_message(cycle: str, start: date, end: date) -> str:
    return (
        f"{period_label(cycle, start, end)} is finalized (Payroll Done) and locked for good: its payroll can no longer be "
        "generated, recomputed, adjusted or changed."
    )


def assert_open(cycle: str, start: date, end: date) -> None:
    if is_locked(cycle, start, end):
        raise PeriodLocked(locked_message(cycle, start, end))


def row_locked(payroll: Payroll) -> bool:
    """Is this production row in a finalized period?"""
    if not is_production_period_row(payroll):
        return False
    return is_locked(row_cycle(payroll), payroll.period_start, payroll.period_end)


def row_locked_message(payroll: Payroll) -> str:
    return locked_message(row_cycle(payroll) or "", payroll.period_start, payroll.period_end)


# ─────────────────────────────────────────────────────────────────────────────
#  New joiners and workers who moved here: parked until HR adds them
# ─────────────────────────────────────────────────────────────────────────────


def joined_in(emp, start: date, end: date) -> date | None:
    """The join date when it falls inside [start, end] (Employee.join_date is free text: unreadable = not new)."""
    joined = parse_join_date(getattr(emp, "join_date", None))
    return joined if joined is not None and start <= joined <= end else None


def latest_move_in(employee_id: int, cycle: str) -> ProductionCycleTransfer | None:
    """The worker's latest move INTO this cycle."""
    return (
        ProductionCycleTransfer.objects.filter(employee_id=employee_id, to_cycle=cycle)
        .order_by("-changed_at", "-id")
        .first()
    )


def came_from(move: ProductionCycleTransfer) -> str | None:
    """The cycle a move into a cycle came from: its own from-cycle, or -a move from Unassigned- the cycle the worker was
    taken off before that (Weekly -> Unassigned -> BiWeekly came from Weekly). None: the worker had no cycle before."""
    if move.from_cycle:
        return move.from_cycle
    before = (
        ProductionCycleTransfer.objects.filter(employee_id=move.employee_id, changed_at__lte=move.changed_at)
        .exclude(pk=move.pk)
        .exclude(from_cycle__isnull=True)
        .order_by("-changed_at", "-id")
        .first()
    )
    return before.from_cycle if before is not None else None


def is_first_after_move(payroll: Payroll, cycle: str, move: ProductionCycleTransfer) -> bool:
    """Is this the worker's first payroll on the cycle since the move: generated after it, and no other row of the cycle
    generated after it is for an earlier period?"""
    if payroll.created_at is None or payroll.created_at < move.changed_at:
        return False
    earlier = (
        Payroll.objects.filter(
            employee_id=payroll.employee_id,
            salary_mode=Payroll.SALARY_MODE_SHIFT,
            pay_cycle=cycle,
            created_at__gte=move.changed_at,
            period_start__lt=payroll.period_start,
        )
        .exclude(pk=payroll.pk)
        .exists()
    )
    return not earlier


def moved_in_for(payroll: Payroll, cycle: str) -> ProductionCycleTransfer | None:
    """The move that makes this row the worker's first period here after coming from ANOTHER cycle, or None."""
    move = latest_move_in(payroll.employee_id, cycle)
    if move is None:
        return None
    previous = came_from(move)
    if previous is None or previous == cycle:
        return None
    return move if is_first_after_move(payroll, cycle, move) else None


def park_if_needed(payroll: Payroll, emp, cycle: str | None) -> None:
    """Called by the production engine right after it saved a period row. A worker who joined during the period, or whose
    first period on this cycle this is after a move from another cycle, is PARKED until HR adds them (added_to_payroll_at)
    -never a paid row, never one HR already added. Only the two flags are written (an UPDATE, so the row's "last computed"
    time stays the engine's own), never a figure."""
    if not cycle or not is_production_period_row(payroll):
        return
    reason = ""
    if payroll.added_to_payroll_at is None and payroll.payment_status != Payroll.PAYMENT_PAID:
        if moved_in_for(payroll, cycle) is not None:
            reason = Payroll.PARKED_TRANSFER
        elif joined_in(emp, payroll.period_start, payroll.period_end) is not None:
            reason = Payroll.PARKED_NEW_JOINER
    parked = bool(reason)
    if bool(payroll.new_joiner_parked) != parked or (payroll.parked_reason or "") != reason:
        Payroll.objects.filter(pk=payroll.pk).update(new_joiner_parked=parked, parked_reason=reason)
        payroll.new_joiner_parked, payroll.parked_reason = parked, reason


# ─────────────────────────────────────────────────────────────────────────────
#  Who may act
# ─────────────────────────────────────────────────────────────────────────────


def _hr_user(request):
    from .models import HRUser

    cached = getattr(request, "_pp_hr_user", False)
    if cached is not False:
        return cached
    hr_user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first() if hr_user_id else None
    try:
        request._pp_hr_user = hr
    except AttributeError:
        pass
    return hr


def level(request, key: str) -> str:
    """hidden / view / edit of one permission key for the caller (a super administrator: edit)."""
    from .permission_registry import effective_permissions, resolve_permission

    hr = _hr_user(request)
    if hr is None:
        return "hidden"
    if hr.is_super_admin:
        return "edit"
    return resolve_permission(effective_permissions(hr), key)


def can(request, key: str) -> bool:
    return level(request, key) == "edit"


def may_clear(request) -> bool:
    """Mark as Cleared on a production payroll: Production Payroll edit, and the account's own "Mark a salary as cleared"
    switch (hr_access, kind payroll_mark_cleared: staff and production) judged against the PRODUCTION payroll's level, so a
    login that may edit production payroll but not staff payroll can still clear, and a switch set off still says no."""
    from . import hr_access
    from .permission_registry import effective_permissions, resolve_permission

    hr = _hr_user(request)
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    perms = effective_permissions(hr)
    production = resolve_permission(perms, KEY_SECTION)
    if production != "edit":
        return False
    return bool(hr_access.effective_approvals(hr, {**perms, "payroll": production}).get("payroll_mark_cleared"))


def is_whole_company(request) -> bool:
    return get_branch_scope(request) is None


def actor_name(request) -> str:
    from .auth import get_hr_display_name

    return get_hr_display_name(request)


# ─────────────────────────────────────────────────────────────────────────────
#  Where a period stands
# ─────────────────────────────────────────────────────────────────────────────


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def days_between(start: datetime | None, end: datetime | None) -> int | None:
    """Whole calendar days in India from finalizing to paying (the same evening = 0, the next day = 1)."""
    if start is None or end is None:
        return None
    return (end.astimezone(FACTORY_TZ).date() - start.astimezone(FACTORY_TZ).date()).days


def state_of(close: ProductionPeriodClose | None, generated: int) -> str:
    """not_generated | generated | finalized | paid."""
    if close is not None:
        return "paid" if close.paid_at else "finalized"
    return "generated" if generated else "not_generated"


STATE_LABELS = {
    "not_generated": "Not generated",
    "generated": "Generated",
    "finalized": "Payroll Done",
    "paid": "Paid",
}


def period_states(cycle: str, periods, request=None) -> dict[tuple[date, date], dict]:
    """{(start, end): {"state", "generated", "parked"}} for many periods of a cycle in two queries (the period picker).
    `generated` / `parked` count the caller's scope when a request is given; the state is company-wide."""
    periods = list(periods)
    if not periods:
        return {}
    first, last = min(p[0] for p in periods), max(p[1] for p in periods)
    rows = Payroll.objects.filter(
        salary_mode=Payroll.SALARY_MODE_SHIFT,
        period_start__gte=first,
        period_end__lte=last,
        employee__status="active",
    ).filter(cycle_q(cycle))
    if request is not None:
        rows = scope_to_branch(rows, request, field="employee__branch_id")
    counted = {
        (r["period_start"], r["period_end"]): r
        for r in rows.values("period_start", "period_end").annotate(
            total=Count("id"), parked=Count("id", filter=PARKED_Q)
        )
    }
    closes = {
        (c.period_start, c.period_end): c
        for c in ProductionPeriodClose.objects.filter(cycle=cycle, period_start__gte=first, period_end__lte=last)
    }
    out = {}
    for start, end in periods:
        row = counted.get((start, end)) or {}
        close = closes.get((start, end))
        generated = int(row.get("total") or 0)
        out[(start, end)] = {
            "state": state_of(close, generated),
            "generated": generated,
            "parked": int(row.get("parked") or 0),
        }
    return out


def _counts(rows) -> dict:
    """How many of a period's payrolls (a queryset of period_rows, maybe branch-scoped) are in each list."""
    agg = rows.aggregate(
        total=Count("id"),
        parked=Count("id", filter=PARKED_Q),
        parked_new=Count("id", filter=PARKED_Q & Q(parked_reason=Payroll.PARKED_NEW_JOINER)),
        parked_moved=Count("id", filter=PARKED_Q & Q(parked_reason=Payroll.PARKED_TRANSFER)),
        main=Count("id", filter=MAIN_Q),
        not_cleared=Count("id", filter=MAIN_Q & ~Q(status=Payroll.STATUS_PAID)),
        paid=Count("id", filter=MAIN_Q & Q(payment_status=Payroll.PAYMENT_PAID)),
        main_net=Sum("final_salary", filter=MAIN_Q),
        added=Count("id", filter=Q(added_to_payroll_at__isnull=False)),
    )
    parked = int(agg["parked"] or 0)
    new = int(agg["parked_new"] or 0)
    moved = int(agg["parked_moved"] or 0)
    return {
        "generated": int(agg["total"] or 0),
        "inPayroll": int(agg["main"] or 0),
        "notCleared": int(agg["not_cleared"] or 0),
        "parked": parked,
        # an older row parked before the reason was recorded counts as a new joiner
        "newJoiners": new + max(0, parked - new - moved),
        "movedIn": moved,
        "addedToPayroll": int(agg["added"] or 0),
        "paid": int(agg["paid"] or 0),
        "notPaid": int(agg["main"] or 0) - int(agg["paid"] or 0),
        "mainNet": float(agg["main_net"] or 0),
    }


def finalize_blockers(cycle: str, start: date, end: date, company_counts: dict, today: date | None = None) -> list[str]:
    """Why Payroll Done cannot be pressed for the period now (empty: it can), in plain words."""
    out = []
    label = period_label(cycle, start, end)
    if not period_ended(end, today):
        out.append(f"{label} has not ended yet: it can be finalized from {fmt_day(end_plus_one(end))}.")
    if company_counts["inPayroll"] == 0:
        out.append(f"There is no payroll for {label} yet: generate it first.")
    if company_counts["parked"]:
        n = company_counts["parked"]
        out.append(
            f"{n} worker{'s are' if n != 1 else ' is'} still waiting in New Joiners (joined during the period or moved "
            "here from another cycle). Add them to the payroll first, so no worker's wages are left out."
        )
    return out


def end_plus_one(end: date) -> date:
    from datetime import timedelta

    return end + timedelta(days=1)


def period_status(request, cycle: str, start: date, end: date) -> dict:
    """GET /api/payroll/production/period-workflow: where the period stands, its timeline, the counts in the caller's
    scope, why Payroll Done is blocked and what the caller may do."""
    close = period_close(cycle, start, end)
    company = period_rows(cycle, start, end)
    rows = scope_to_branch(company, request, field="employee__branch_id")
    counts = _counts(rows)
    company_counts = counts if get_branch_scope(request) is None else _counts(company)
    stamps = rows.aggregate(first=Min("created_at"), last=Max("updated_at"))
    locked = close is not None
    paid = bool(close and close.paid_at)
    whole = is_whole_company(request)
    ended = period_ended(end)
    blockers = [] if locked else finalize_blockers(cycle, start, end, company_counts)
    state = state_of(close, company_counts["generated"])
    unlock_problem = unlock_blocker(cycle, start, end, close) if locked else None
    return {
        "cycle": cycle,
        "label": cycle_label(cycle),
        "periodStart": start.isoformat(),
        "periodEnd": end.isoformat(),
        "periodLabel": fmt_range(start, end),
        "state": state,
        "stateLabel": STATE_LABELS[state],
        "locked": locked,
        "periodEnded": ended,
        "finalizedAt": _iso(close.finalized_at) if close else None,
        "finalizedBy": (close.finalized_by or None) if close else None,
        "paidAt": _iso(close.paid_at) if paid else None,
        "paidBy": (close.paid_by or None) if paid else None,
        "paidOn": close.paid_on.isoformat() if paid and close.paid_on else None,
        "daysToPay": days_between(close.finalized_at, close.paid_at) if paid else None,
        "firstGeneratedAt": _iso(close.first_generated_at if close else stamps["first"]),
        "lastComputedAt": _iso(close.last_computed_at if close else stamps["last"]),
        "counts": counts,
        "snapshot": (close.snapshot or None) if close else None,
        "finalizeBlockers": blockers,
        # a finalized period: why it cannot be unlocked (paid: locked for good), or null
        "unlockBlocked": unlock_problem,
        "wholeCompany": whole,
        "can": {
            "finalize": whole and not locked and not blockers and can(request, KEY_FINALIZE),
            "markPaid": whole and locked and not paid and can(request, KEY_MARK_PAID),
            "addToPayroll": not locked and can(request, KEY_NEW_JOINERS),
            "adjust": not locked and can(request, KEY_ADJUST),
            "markCleared": not locked and may_clear(request),
            "generate": not locked and ended and can(request, KEY_GENERATE),
            # a finalized, unpaid period back to Generated (same rights as Payroll Done)
            "unlock": whole and locked and unlock_problem is None and can(request, KEY_FINALIZE),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Actions
# ─────────────────────────────────────────────────────────────────────────────


class WorkflowRefused(ValueError):
    """An action that cannot be done now (answered as a 409 with this plain message)."""


def finalize(cycle: str, start: date, end: date, actor: str) -> ProductionPeriodClose:
    """Payroll Done: lock the period for good, with a snapshot of how it stood. Raises WorkflowRefused (not ended, nothing
    generated, someone still parked) or PeriodLocked (already done)."""
    rows = period_rows(cycle, start, end)
    counts = _counts(rows)
    blockers = finalize_blockers(cycle, start, end, counts)
    if is_locked(cycle, start, end):
        raise PeriodLocked(f"{period_label(cycle, start, end)} was already finalized.")
    if blockers:
        raise WorkflowRefused(" ".join(blockers))
    stamps = rows.aggregate(first=Min("created_at"), last=Max("updated_at"))
    try:
        with transaction.atomic():
            return ProductionPeriodClose.objects.create(
                cycle=cycle,
                period_start=start,
                period_end=end,
                finalized_at=timezone.now(),
                finalized_by=actor,
                first_generated_at=stamps["first"],
                last_computed_at=stamps["last"],
                snapshot={
                    "inPayroll": counts["inPayroll"],
                    "notCleared": counts["notCleared"],
                    "addedToPayroll": counts["addedToPayroll"],
                    "mainNet": counts["mainNet"],
                },
            )
    except IntegrityError:
        raise PeriodLocked(f"{period_label(cycle, start, end)} was already finalized.") from None


UNLOCK_PAID = "Paid: locked for good. Once a pay period is paid its payroll can never be changed or unlocked."
REASON_MIN, REASON_MAX = 3, 500


def any_paid(cycle: str, start: date, end: date) -> bool:
    """Is any payroll of the period (any worker, active or not) marked Paid?"""
    return (
        Payroll.objects.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=start, period_end=end)
        .filter(cycle_q(cycle))
        .filter(payment_status=Payroll.PAYMENT_PAID)
        .exists()
    )


def unlock_blocker(cycle: str, start: date, end: date, close: ProductionPeriodClose | None) -> str | None:
    """Why the period cannot be unlocked (None: it can)."""
    if close is None:
        return f"{period_label(cycle, start, end)} is not finalized: there is nothing to unlock."
    if close.paid_at is not None or any_paid(cycle, start, end):
        return UNLOCK_PAID
    return None


def clean_reason(raw) -> str:
    text = " ".join(str(raw or "").split())
    if len(text) < REASON_MIN:
        raise WorkflowRefused("Give a short reason for unlocking (a few words).")
    return text[:REASON_MAX]


def unlock(cycle: str, start: date, end: date, actor: str, reason: str) -> dict:
    """Unlock a finalized, unpaid period: it is Generated again (it can be generated, recomputed and adjusted, and
    Payroll Done can be pressed again). Returns what the close said (for the audit log). Raises WorkflowRefused."""
    with transaction.atomic():
        close = (
            ProductionPeriodClose.objects.select_for_update()
            .filter(cycle=cycle, period_start=start, period_end=end)
            .first()
        )
        problem = unlock_blocker(cycle, start, end, close)
        if problem:
            raise WorkflowRefused(problem)
        was = {
            "finalizedAt": _iso(close.finalized_at),
            "finalizedBy": close.finalized_by or None,
            "snapshot": close.snapshot or {},
            "unlockedBy": actor,
            "reason": reason,
        }
        close.delete()
    return was


def check_paid_on(raw, start: date, end: date, today: date | None = None) -> date:
    """The day HR says the money was paid: a real date, not in the future and not before the period's last day."""
    today = today or ist_today()
    try:
        paid_on = date.fromisoformat(str(raw or "").strip()[:10])
    except ValueError:
        raise WorkflowRefused("Enter the date the salaries were paid (YYYY-MM-DD).") from None
    if paid_on > today:
        raise WorkflowRefused("The paid date cannot be in the future.")
    if paid_on < end:
        raise WorkflowRefused(f"The paid date cannot be before the period's last day ({fmt_day(end)}).")
    return paid_on


def mark_paid(cycle: str, start: date, end: date, paid_on: date, actor: str) -> tuple[ProductionPeriodClose, int]:
    """Mark as Paid: the period is Paid on `paid_on`, and every payroll in its main payroll that is not paid yet gets
    payment status Paid. Returns (the close, how many payrolls were newly marked). Raises WorkflowRefused."""
    with transaction.atomic():
        close = (
            ProductionPeriodClose.objects.select_for_update()
            .filter(cycle=cycle, period_start=start, period_end=end)
            .first()
        )
        label = period_label(cycle, start, end)
        if close is None:
            raise WorkflowRefused(f"{label} is not finalized yet: press Payroll Done first.")
        if close.paid_at is not None:
            raise WorkflowRefused(f"{label} was already marked as paid.")
        now = timezone.now()
        close.paid_at, close.paid_by, close.paid_on = now, actor, paid_on
        close.save(update_fields=["paid_at", "paid_by", "paid_on"])
        ids = list(
            period_rows(cycle, start, end)
            .filter(MAIN_Q)
            .exclude(payment_status=Payroll.PAYMENT_PAID)
            .values_list("id", flat=True)
        )
        Payroll.objects.filter(id__in=ids).update(
            payment_status=Payroll.PAYMENT_PAID, payment_paid_at=now, payment_paid_by=actor
        )
    return close, len(ids)


def add_to_payroll(payrolls, actor: str) -> list[int]:
    """Parked rows join their period's payroll (and stay in it through every regeneration). Raises PeriodLocked when one of
    their periods is finalized. Returns the ids that were added (rows not parked are left as they are)."""
    payrolls = [p for p in payrolls if p.new_joiner_parked]
    for p in payrolls:
        if row_locked(p):
            raise PeriodLocked(row_locked_message(p))
    ids = [p.pk for p in payrolls]
    if ids:
        Payroll.objects.filter(id__in=ids, new_joiner_parked=True).update(
            new_joiner_parked=False, parked_reason="", added_to_payroll_at=timezone.now(), added_to_payroll_by=actor
        )
    return ids


# ─────────────────────────────────────────────────────────────────────────────
#  Workers who moved here, and who moved away
# ─────────────────────────────────────────────────────────────────────────────


def move_json(move: ProductionCycleTransfer | None, previous: str | None = None) -> dict | None:
    if move is None:
        return None
    came = previous if previous is not None else move.from_cycle
    return {
        "id": move.pk,
        "fromCycle": move.from_cycle,
        "fromLabel": cycle_label(move.from_cycle) if move.from_cycle else "Unassigned",
        # the cycle the worker came from when the move was from Unassigned (Weekly -> Unassigned -> BiWeekly)
        "cameFrom": came,
        "cameFromLabel": cycle_label(came) if came else "Unassigned",
        "toCycle": move.to_cycle,
        "toLabel": cycle_label(move.to_cycle) if move.to_cycle else "Unassigned",
        "changedAt": _iso(move.changed_at),
        "changedOn": timezone.localtime(move.changed_at, FACTORY_TZ).date().isoformat(),
        "changedBy": move.changed_by or None,
        "reason": move.reason or "",
        "lastPaidThrough": move.last_paid_through.isoformat() if move.last_paid_through else None,
        "paysFrom": move.pays_from.isoformat() if move.pays_from else None,
        "paidPeriods": move.paid_periods,
        "paidNet": float(move.paid_net or 0),
    }


def moves_in(employee_ids, cycle: str) -> dict[int, tuple[ProductionCycleTransfer, str | None, bool]]:
    """{employee id: (their latest move into `cycle`, the cycle they came from, whether no payroll was generated on the
    cycle since)} for the workers whose latest move into the cycle came from ANOTHER cycle. Three queries."""
    ids = [int(i) for i in employee_ids]
    if not ids:
        return {}
    every = list(
        ProductionCycleTransfer.objects.filter(employee_id__in=ids).order_by("employee_id", "changed_at", "id")
    )
    by_emp: dict[int, list[ProductionCycleTransfer]] = {}
    for t in every:
        by_emp.setdefault(t.employee_id, []).append(t)
    latest: dict[int, tuple[ProductionCycleTransfer, str]] = {}
    for emp_id, moves in by_emp.items():
        into = [m for m in moves if m.to_cycle == cycle]
        if not into:
            continue
        move = into[-1]
        previous = move.from_cycle
        if previous is None:
            before = [m for m in moves if m.changed_at <= move.changed_at and m.pk != move.pk and m.from_cycle]
            previous = before[-1].from_cycle if before else None
        if previous is not None and previous != cycle:
            latest[emp_id] = (move, previous)
    if not latest:
        return {}
    since = min(m.changed_at for m, _p in latest.values())
    generated = set()
    for emp_id, created in Payroll.objects.filter(
        employee_id__in=list(latest), salary_mode=Payroll.SALARY_MODE_SHIFT, pay_cycle=cycle, created_at__gte=since
    ).values_list("employee_id", "created_at"):
        if created >= latest[emp_id][0].changed_at:
            generated.add(emp_id)
    return {emp_id: (move, prev, emp_id not in generated) for emp_id, (move, prev) in latest.items()}


def first_generations(cycle: str) -> list[datetime]:
    """When each generated period of a cycle was first generated (company-wide), oldest first."""
    rows = (
        Payroll.objects.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, pay_cycle=cycle, period_start__isnull=False)
        .values("period_start", "period_end")
        .annotate(first=Min("created_at"))
    )
    return sorted(r["first"] for r in rows if r["first"] is not None)


# A worker who moved away stays on the old cycle's "Moved out" tab for this many of its payroll generations after the move
MOVED_OUT_VISIBLE_GENERATIONS = 2


def moved_out(request, cycle: str, include_older: bool = False) -> dict:
    """The workers who moved FROM this cycle to another (or off every cycle), newest first, with what this cycle had paid
    them. A move stays listed until this cycle has generated two more pay periods after it; older ones only with
    include_older ("Show older")."""
    moves = scope_to_branch(
        ProductionCycleTransfer.objects.select_related("employee", "employee__department"),
        request,
        field="employee__branch_id",
    ).filter(from_cycle=cycle)
    moves = list(moves.order_by("-changed_at", "-id"))
    firsts = first_generations(cycle)
    emp_ids = {m.employee_id for m in moves}
    # the worker's latest payroll generated on this cycle (a row from before the cycles, none stamped, when that is all)
    last_rows: dict[int, Payroll] = {}
    legacy_rows: dict[int, Payroll] = {}
    if emp_ids:
        for p in (
            Payroll.objects.filter(
                employee_id__in=emp_ids, salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False
            )
            .filter(Q(pay_cycle=cycle) | Q(pay_cycle__isnull=True))
            .order_by("employee_id", "-period_end", "-id")
        ):
            (last_rows if p.pay_cycle else legacy_rows).setdefault(p.employee_id, p)
    shown, older = [], 0
    for m in moves:
        since = sum(1 for f in firsts if f > m.changed_at)
        hidden = since >= MOVED_OUT_VISIBLE_GENERATIONS
        if hidden:
            older += 1
            if not include_older:
                continue
        emp = m.employee
        last = last_rows.get(m.employee_id) or legacy_rows.get(m.employee_id)
        shown.append(
            {
                **move_json(m),
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "name": f"{emp.first_name} {emp.last_name}".strip(),
                "departmentName": emp.department.name if emp.department_id else None,
                "employeeStatus": emp.status,
                "currentCycle": emp.production_pay_cycle,
                "generationsSince": since,
                "hidden": hidden,
                "lastPayroll": {
                    "payrollId": last.pk,
                    "periodStart": last.period_start.isoformat(),
                    "periodEnd": last.period_end.isoformat(),
                    "status": last.status,
                    "paymentStatus": last.payment_status or Payroll.PAYMENT_NOT_PAID,
                    "net": float(last.final_salary),
                }
                if last is not None and last.period_start is not None
                else None,
            }
        )
    return {
        "cycle": cycle,
        "label": cycle_label(cycle),
        "visibleGenerations": MOVED_OUT_VISIBLE_GENERATIONS,
        "includeOlder": include_older,
        "olderCount": older,
        "moves": shown,
    }


def employees_by_id(ids) -> dict[int, Employee]:
    return {e.id: e for e in Employee.objects.filter(id__in=list(ids))}
