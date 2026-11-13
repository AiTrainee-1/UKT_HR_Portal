"""Staff Payroll month workflow endpoints (owner 2026-11-10). The rules are in payroll_month_workflow.py.

    GET  /api/payroll/month-status?month=&year=     the month's state (open / finalized / paid), timeline, counts, can-do
    GET  /api/payroll/month-skipped?month=&year=    the held, parked and paid-separately payrolls (Skipped Employees)
    POST /api/payroll/<id>/hold          {hold}     Hold (true) / Unhold (false) one staff payroll of an open month
    POST /api/payroll/<id>/add-to-payroll           a parked new joiner joins the month's payroll
    POST /api/payroll/month-finalize     {month, year}   Payroll Done: the month is locked for good
    POST /api/payroll/month-paid         {month, year}   Mark as Paid: everyone in the main payroll is Paid and notified
    POST /api/payroll/<id>/release-and-pay          after the lock: one held / parked employee is released and paid

Every route is under /api/payroll, so the permission middleware maps it to the `payroll` module: a view-only role can read
the status and the lists but every POST is refused (403). Payroll Done, Mark as Paid and Release & pay also need a
whole-company login (403 for a unit / branch login). A write to a locked month answers 409 with a plain message. Nothing
here changes a payroll figure.
"""

from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import hr_access
from . import payroll_month_workflow as wf
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Payroll
from .payroll_views import payroll_list_row
from .view_common import error_response as _error

WHOLE_COMPANY_ONLY = (
    "Only a whole-company login with payroll edit rights can do this: it covers every unit's payroll at once. A unit "
    "login can see the month's status but not change it."
)


def _period(source) -> tuple[int, int] | None:
    try:
        month, year = int(source.get("month")), int(source.get("year"))
    except (TypeError, ValueError):
        return None
    if not 1 <= month <= 12 or not 2000 <= year <= 2100:
        return None
    return month, year


def _staff_payroll(request: Request, pk: int) -> Payroll | None:
    """One staff monthly payroll in the caller's branch scope (a production row is not part of this workflow: 404)."""
    payroll = (
        scope_to_branch(
            Payroll.objects.select_related("employee", "employee__department"), request, field="employee__branch_id"
        )
        .filter(pk=pk)
        .first()
    )
    if payroll is None or not wf.is_staff_month_row(payroll):
        return None
    return payroll


def _row(payroll: Payroll) -> dict:
    payroll.refresh_from_db()
    return payroll_list_row(payroll)


def _name(payroll: Payroll) -> str:
    emp = payroll.employee
    return f"{emp.first_name} {emp.last_name}".strip() if emp else f"payroll {payroll.pk}"


# ─────────────────────────────────────────────────────────────────────────────
#  Reads
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def payroll_month_status(request: Request) -> Response:
    period = _period(request.query_params)
    if period is None:
        return _error("month (1-12) and year are required")
    return Response(wf.month_status(request, *period))


@api_view(["GET"])
@require_hr
def payroll_month_skipped(request: Request) -> Response:
    """The month's held, parked and (after the lock) released-and-paid staff payrolls with their figures and bank
    details (the one-person bank file of a released employee is built from the same row as the month's bank file)."""
    period = _period(request.query_params)
    if period is None:
        return _error("month (1-12) and year are required")
    month, year = period
    rows = scope_to_branch(
        wf.staff_month(month, year).select_related("employee", "employee__department").defer("employee__photo_url"),
        request,
        field="employee__branch_id",
    ).order_by("employee__first_name", "employee__last_name", "id")
    holidays: dict = {}
    on_hold, new_joiners, paid_separately = [], [], []
    for p in rows.filter(wf.SKIPPED_Q):
        row = payroll_list_row(p, holidays)
        row["joinDate"] = p.employee.join_date or None
        if p.released_from:
            paid_separately.append(row)
        elif p.on_hold:
            on_hold.append(row)
        else:
            new_joiners.append(row)
    return Response(
        {
            "month": month,
            "year": year,
            "locked": wf.is_locked(month, year),
            "onHold": on_hold,
            "newJoiners": new_joiners,
            "paidSeparately": paid_separately,
        }
    )


# ─────────────────────────────────────────────────────────────────────────────
#  One employee: Hold / Unhold, Add to payroll, Release & pay
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_hr
def payroll_hold(request: Request, pk: int) -> Response:
    if refused := hr_access.approval_refusal(request, "payroll_hold"):
        return refused
    payroll = _staff_payroll(request, pk)
    if payroll is None:
        return _error("Not found", 404)
    hold = request.data.get("hold")
    if not isinstance(hold, bool):
        return _error("hold must be true (Hold) or false (Unhold)")
    if payroll.new_joiner_parked and hold:
        return _error("This new joiner is not in the payroll yet: add them to the payroll before holding their salary.")
    if bool(payroll.on_hold) == hold:
        return Response(_row(payroll))
    try:
        wf.set_hold(payroll, hold, wf.actor_name(request))
    except wf.MonthLocked as exc:
        return _error(str(exc), 409)
    label = wf.month_label(payroll.month, payroll.year)
    log_action(
        request,
        "update",
        "payroll",
        record_id=payroll.pk,
        description=f"{'Held' if hold else 'Released the hold on'} the {label} salary of {_name(payroll)}",
        old_values={"onHold": not hold},
        new_values={"onHold": hold},
    )
    return Response(_row(payroll))


@api_view(["POST"])
@require_hr
def payroll_add_to_payroll(request: Request, pk: int) -> Response:
    if refused := hr_access.approval_refusal(request, "payroll_add"):
        return refused
    payroll = _staff_payroll(request, pk)
    if payroll is None:
        return _error("Not found", 404)
    if not payroll.new_joiner_parked:
        return Response(_row(payroll))
    try:
        wf.add_to_payroll(payroll, wf.actor_name(request))
    except wf.MonthLocked as exc:
        return _error(str(exc), 409)
    log_action(
        request,
        "update",
        "payroll",
        record_id=payroll.pk,
        description=f"Added new joiner {_name(payroll)} to the {wf.month_label(payroll.month, payroll.year)} payroll",
        old_values={"newJoinerParked": True},
        new_values={"newJoinerParked": False},
    )
    return Response(_row(payroll))


@api_view(["POST"])
@require_hr
def payroll_release_and_pay(request: Request, pk: int) -> Response:
    if not (wf.can_edit_payroll(request) and wf.is_whole_company(request)):
        return _error(WHOLE_COMPANY_ONLY, 403)
    if refused := hr_access.approval_refusal(request, "payroll_release"):
        return refused
    payroll = _staff_payroll(request, pk)
    if payroll is None:
        return _error("Not found", 404)
    was = "on hold" if payroll.on_hold else "a new joiner"
    try:
        wf.release_and_pay(payroll, wf.actor_name(request))
    except ValueError as exc:
        return _error(str(exc), 409)
    wf.notify_later([payroll.pk], f"salary-paid-{payroll.pk}")
    log_action(
        request,
        "update",
        "payroll",
        record_id=payroll.pk,
        description=(
            f"Released and paid the {wf.month_label(payroll.month, payroll.year)} salary of {_name(payroll)} "
            f"(was {was}) after the month was finalized"
        ),
        new_values={"paymentStatus": Payroll.PAYMENT_PAID, "releasedFrom": payroll.released_from},
    )
    return Response(_row(payroll))


# ─────────────────────────────────────────────────────────────────────────────
#  The whole month: Payroll Done, Mark as Paid
# ─────────────────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_hr
def payroll_month_finalize(request: Request) -> Response:
    if not (wf.can_edit_payroll(request) and wf.is_whole_company(request)):
        return _error(WHOLE_COMPANY_ONLY, 403)
    if refused := hr_access.approval_refusal(request, "payroll_finalize"):
        return refused
    period = _period(request.data)
    if period is None:
        return _error("month (1-12) and year are required")
    month, year = period
    label = wf.month_label(month, year)
    if wf.is_locked(month, year):
        return _error(f"{label} payroll was already finalized.", 409)
    if not wf.staff_month(month, year).filter(new_joiner_parked=False).exists():
        return _error(f"There is no staff payroll for {label} yet: generate it before pressing Payroll Done.", 409)

    from . import payroll_progress

    # never while a payroll run is writing: the month would be locked half way through it
    if not payroll_progress.try_begin_run():
        return _error("A payroll run is in progress. Wait for it to finish, then press Payroll Done again.", 409)
    try:
        close = wf.finalize(month, year, wf.actor_name(request))
    except wf.MonthLocked as exc:
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
            f"Payroll Done: finalized and locked the {label} staff payroll ({snap.get('inPayroll', 0)} in the payroll, "
            f"{snap.get('onHold', 0)} on hold, {snap.get('newJoiners', 0)} new joiners not added, "
            f"{snap.get('notCleared', 0)} not cleared)"
        ),
        new_values={"finalizedAt": close.finalized_at.isoformat(), **snap},
    )
    return Response(wf.month_status(request, month, year), status=201)


@api_view(["POST"])
@require_hr
def payroll_month_paid(request: Request) -> Response:
    if not (wf.can_edit_payroll(request) and wf.is_whole_company(request)):
        return _error(WHOLE_COMPANY_ONLY, 403)
    if refused := hr_access.approval_refusal(request, "payroll_mark_paid"):
        return refused
    period = _period(request.data)
    if period is None:
        return _error("month (1-12) and year are required")
    month, year = period
    try:
        close, ids = wf.mark_paid(month, year, wf.actor_name(request))
    except ValueError as exc:
        return _error(str(exc), 409)
    wf.notify_later(ids, f"salary-paid-{year}-{month:02d}")
    log_action(
        request,
        "update",
        "payroll",
        record_id=close.pk,
        description=(
            f"Marked the {wf.month_label(month, year)} staff payroll as Paid: {len(ids)} employee(s) paid and notified "
            f"({wf.days_between(close.finalized_at, close.paid_at)} day(s) after Payroll Done)"
        ),
        new_values={"paidAt": close.paid_at.isoformat(), "employeesPaid": len(ids)},
    )
    status = wf.month_status(request, month, year)
    status["employeesPaid"] = len(ids)
    return Response(status)
