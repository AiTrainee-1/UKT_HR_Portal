"""Production Payroll period workflow endpoints (owner 2026-11-16). The rules are in production_period_workflow.py.

    GET  /api/payroll/production/period-workflow?cycle=&periodStart=&periodEnd=
                                        the period's state (Not generated / Generated / Payroll Done / Paid), timeline,
                                        counts, why Payroll Done is blocked, what the caller may do
    POST /api/payroll/production/period-finalize   {cycle, periodStart, periodEnd}          Payroll Done (locks for good)
    POST /api/payroll/production/period-paid       {cycle, periodStart, periodEnd, paidOn}  Mark as Paid
    POST /api/payroll/production/period-unlock     {cycle, periodStart, periodEnd, reason}  a finalized, unpaid period
                                        back to Generated (same rights as Payroll Done; a paid one is locked for good)
    GET  /api/payroll/production/new-joiners?cycle=&periodStart=&periodEnd=
                                        the period's New Joiners: parked rows (joined during the period, or moved here
                                        from another cycle) and the ones already added
    POST /api/payroll/production/new-joiners/add   {payrollIds} or {cycle, periodStart, periodEnd, all: true}
    GET  /api/payroll/production/moved-out?cycle=[&older=1]
                                        the workers who moved away from this cycle

Every route is under /api/payroll/production, so the permission middleware maps it to production_payroll (Payroll Done =
production_payroll.finalize, Mark as Paid = .mark_paid, New Joiners = .new_joiners, Moved out = .payroll.moved_out; a
view-only role can read but every POST is refused). Payroll Done and Mark as Paid also need a whole-company login (403 for a
unit login). A write to a finalized period answers 409 with a plain message. Nothing here changes a payroll figure.
"""

from __future__ import annotations

from datetime import date

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import production_period_workflow as wf
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Payroll, SalarySlip
from .production_coverage import day_count, parse_ranges
from .production_cycles import normalize_cycle
from .production_payroll_views import _flag, list_row
from .production_period import is_cycle_period
from .user_settings import settings_for
from .view_common import error_response as _error


class _BadRequest(ValueError):
    pass


def _period(source, request) -> tuple[str, date, date]:
    """(cycle, start, end) from a query or body: a cycle and exactly one of its periods. Raises _BadRequest."""
    cycle = normalize_cycle(source.get("cycle"))
    if cycle is None:
        raise _BadRequest("Choose a pay cycle: weekly, biweekly or monthly.")
    try:
        start = date.fromisoformat(str(source.get("periodStart") or ""))
        end = date.fromisoformat(str(source.get("periodEnd") or ""))
    except ValueError:
        raise _BadRequest("periodStart and periodEnd must be dates (YYYY-MM-DD).") from None
    if end < start:
        raise _BadRequest("periodEnd cannot be before periodStart.")
    # a period that exists (generated, or finalized) is accepted as it is, also after the week start was changed
    known = wf.period_rows(cycle, start, end).exists() or wf.period_close(cycle, start, end) is not None
    if not known:
        try:
            ok = is_cycle_period(start, end, settings_for(request), cycle)
        except Exception:
            ok = False
        if not ok:
            raise _BadRequest(f"{start.isoformat()} to {end.isoformat()} is not a {wf.cycle_label(cycle)} pay period.")
    return cycle, start, end


# ─────────────────────────────────────────────────────────────────────────────
#  Where the period stands
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def production_period_workflow(request: Request) -> Response:
    try:
        cycle, start, end = _period(request.query_params, request)
    except _BadRequest as exc:
        return _error(str(exc))
    return Response(wf.period_status(request, cycle, start, end))


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll Done, Mark as Paid
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_hr
def production_period_finalize(request: Request) -> Response:
    if not wf.is_whole_company(request):
        return _error(wf.WHOLE_COMPANY_ONLY, 403)
    try:
        cycle, start, end = _period(request.data, request)
    except _BadRequest as exc:
        return _error(str(exc))
    from . import payroll_progress

    # never while a payroll run is writing: the period would be locked half way through it
    if not payroll_progress.try_begin_run():
        return _error("A payroll run is in progress. Wait for it to finish, then press Payroll Done again.", 409)
    try:
        close = wf.finalize(cycle, start, end, wf.actor_name(request))
    except (wf.PeriodLocked, wf.WorkflowRefused) as exc:
        return _error(str(exc), 409)
    finally:
        payroll_progress.end_run()
    snap = close.snapshot or {}
    log_action(
        request,
        "update",
        "payroll",
        record_id=close.pk,
        description=(
            f"Payroll Done: finalized and locked the {wf.period_label(cycle, start, end)} production payroll "
            f"({snap.get('inPayroll', 0)} in the payroll, {snap.get('notCleared', 0)} not cleared)"
        ),
        new_values={"finalizedAt": close.finalized_at.isoformat(), **snap},
    )
    return Response(wf.period_status(request, cycle, start, end), status=201)


@api_view(["POST"])
@require_hr
def production_period_paid(request: Request) -> Response:
    if not wf.is_whole_company(request):
        return _error(wf.WHOLE_COMPANY_ONLY, 403)
    try:
        cycle, start, end = _period(request.data, request)
    except _BadRequest as exc:
        return _error(str(exc))
    try:
        paid_on = wf.check_paid_on(request.data.get("paidOn"), start, end)
    except wf.WorkflowRefused as exc:
        return _error(str(exc))
    try:
        close, count = wf.mark_paid(cycle, start, end, paid_on, wf.actor_name(request))
    except wf.WorkflowRefused as exc:
        return _error(str(exc), 409)
    log_action(
        request,
        "update",
        "payroll",
        record_id=close.pk,
        description=(
            f"Marked the {wf.period_label(cycle, start, end)} production payroll as Paid on {paid_on.isoformat()}: "
            f"{count} worker(s) paid ({wf.days_between(close.finalized_at, close.paid_at)} day(s) after Payroll Done)"
        ),
        new_values={"paidAt": close.paid_at.isoformat(), "paidOn": paid_on.isoformat(), "workersPaid": count},
    )
    status = wf.period_status(request, cycle, start, end)
    status["workersPaid"] = count
    return Response(status)


@api_view(["POST"])
@require_hr
def production_period_unlock(request: Request) -> Response:
    if not wf.is_whole_company(request):
        return _error(wf.WHOLE_COMPANY_ONLY, 403)
    try:
        cycle, start, end = _period(request.data, request)
    except _BadRequest as exc:
        return _error(str(exc))
    try:
        reason = wf.clean_reason(request.data.get("reason"))
    except wf.WorkflowRefused as exc:
        return _error(str(exc))
    from . import payroll_progress

    if not payroll_progress.try_begin_run():
        return _error("A payroll run is in progress. Wait for it to finish, then unlock again.", 409)
    try:
        was = wf.unlock(cycle, start, end, wf.actor_name(request), reason)
    except wf.WorkflowRefused as exc:
        return _error(str(exc), 409)
    finally:
        payroll_progress.end_run()
    log_action(
        request,
        "update",
        "payroll",
        description=(
            f"Unlocked the finalized {wf.period_label(cycle, start, end)} production payroll (back to Generated). "
            f"Reason: {reason}"
        ),
        old_values=was,
        new_values={"state": "generated", "reason": reason},
    )
    return Response(wf.period_status(request, cycle, start, end))


# ─────────────────────────────────────────────────────────────────────────────
#  New Joiners
# ─────────────────────────────────────────────────────────────────────────────


def _days_of(slip: SalarySlip | None, payroll: Payroll) -> dict:
    """What a New Joiner row is paid for: the eligible days, the days of the period left out because another payroll
    already paid them, and the catch-up days added before the period."""
    bd = (slip.breakdown_details if slip is not None else None) or {}
    period_days = (payroll.period_end - payroll.period_start).days + 1
    paid = parse_ranges(payroll.paid_ranges)
    paid_days = day_count(paid) if paid else period_days
    excluded = sum(
        (date.fromisoformat(p["to"]) - date.fromisoformat(p["from"])).days + 1
        for p in bd.get("alreadyPaid") or []
        if p.get("from") and p.get("to")
    )
    catch_up = sum(int(c.get("days") or 0) for c in bd.get("catchUp") or [])
    return {
        "periodDays": period_days,
        "eligibleDays": paid_days,
        "excludedDays": excluded,
        "catchUpDays": catch_up,
        "alreadyPaid": bd.get("alreadyPaid") or [],
        "catchUp": bd.get("catchUp") or [],
        "shifts": float(payroll.present_days),
    }


def _new_joiner_row(payroll: Payroll, slip, moves: dict) -> dict:
    row = list_row(payroll)
    emp = payroll.employee
    joined = wf.joined_in(emp, payroll.period_start, payroll.period_end)
    found = moves.get(payroll.employee_id)
    move = None
    if found is not None and payroll.created_at and payroll.created_at >= found[0].changed_at:
        move = wf.move_json(found[0], found[1])
    parked = bool(payroll.new_joiner_parked)
    reason = payroll.parked_reason or ("transfer" if parked and move else "new_joiner" if parked else None)
    row.update(
        {
            "parked": parked,
            "parkedReason": reason,
            "joinedOn": joined.isoformat() if joined else None,
            "move": move,
            "days": _days_of(slip, payroll),
            "addedToPayrollAt": payroll.added_to_payroll_at.isoformat() if payroll.added_to_payroll_at else None,
            "addedToPayrollBy": payroll.added_to_payroll_by or None,
        }
    )
    return row


@api_view(["GET"])
@require_hr
def production_new_joiners(request: Request) -> Response:
    """The period's New Joiners in the caller's scope: `waiting` (parked: out of the records, totals, bank file and
    statement until added) and `added` (were parked or are new / moved, already added by HR)."""
    try:
        cycle, start, end = _period(request.query_params, request)
    except _BadRequest as exc:
        return _error(str(exc))
    rows = scope_to_branch(
        wf.period_rows(cycle, start, end).select_related("employee", "employee__department"),
        request,
        field="employee__branch_id",
    ).order_by("employee__first_name", "employee__last_name", "id")
    rows = list(rows.filter(wf.PARKED_Q | Q(added_to_payroll_at__isnull=False)))
    slips = {
        s.employee_id: s
        for s in SalarySlip.objects.filter(
            employee_id__in=[p.employee_id for p in rows], period_start=start, period_end=end
        )
    }
    moves = wf.moves_in([p.employee_id for p in rows], cycle)
    out = [_new_joiner_row(p, slips.get(p.employee_id), moves) for p in rows]
    waiting = [r for r in out if r["parked"]]
    added = [r for r in out if not r["parked"]]
    return Response(
        {
            "cycle": cycle,
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "locked": wf.is_locked(cycle, start, end),
            "canAdd": not wf.is_locked(cycle, start, end) and wf.can(request, wf.KEY_NEW_JOINERS),
            "waiting": waiting,
            "added": added,
            "waitingNet": round(sum(r["finalSalary"] for r in waiting), 2),
        }
    )


@api_view(["POST"])
@require_hr
def production_new_joiners_add(request: Request) -> Response:
    """Add parked workers to their period's payroll: `payrollIds` (one or several), or every one of a period ({cycle,
    periodStart, periodEnd, all: true}) in the caller's scope."""
    data = request.data
    base = scope_to_branch(
        Payroll.objects.select_related("employee").filter(
            salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False
        ),
        request,
        field="employee__branch_id",
    )
    if _flag(data.get("all")):
        try:
            cycle, start, end = _period(data, request)
        except _BadRequest as exc:
            return _error(str(exc))
        if wf.is_locked(cycle, start, end):
            return _error(wf.locked_message(cycle, start, end), 409)
        payrolls = list(base.filter(id__in=wf.period_rows(cycle, start, end).values("id")).filter(wf.PARKED_Q))
    else:
        raw = data.get("payrollIds")
        if not isinstance(raw, list) or not raw:
            return _error("payrollIds must be a non-empty list (or send all: true with the period)")
        try:
            ids = [int(i) for i in raw]
        except (TypeError, ValueError):
            return _error("payrollIds must be whole numbers")
        payrolls = list(base.filter(id__in=ids))
        if len({p.pk for p in payrolls}) != len(set(ids)):
            return _error("Not found", 404)
    try:
        added = wf.add_to_payroll(payrolls, wf.actor_name(request))
    except wf.PeriodLocked as exc:
        return _error(str(exc), 409)
    if added:
        names = [f"{p.employee.first_name} {p.employee.last_name}".strip() for p in payrolls if p.pk in added]
        sample = ", ".join(names[:5]) + (f" and {len(names) - 5} more" if len(names) > 5 else "")
        first = payrolls[0]
        log_action(
            request,
            "update",
            "payroll",
            record_id=added[0] if len(added) == 1 else None,
            description=(
                f"Added {len(added)} worker(s) from New Joiners to the "
                f"{wf.period_label(wf.row_cycle(first) or '', first.period_start, first.period_end)} production "
                f"payroll ({sample})"
            ),
            new_values={"payrollIds": added},
        )
    return Response({"added": len(added), "payrollIds": added})


# ─────────────────────────────────────────────────────────────────────────────
#  Moved out
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def production_moved_out(request: Request) -> Response:
    cycle = normalize_cycle(request.query_params.get("cycle"))
    if cycle is None:
        return _error("Choose a pay cycle: weekly, biweekly or monthly.")
    return Response(wf.moved_out(request, cycle, include_older=_flag(request.query_params.get("older"))))
