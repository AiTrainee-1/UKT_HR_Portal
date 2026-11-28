"""
Compensation days on a chosen date (owner brief 2026-11-28): the HR endpoints. The rules are in compensation_placement.py;
a placement is a HolidayWorkClaim with hr_step (compensation_claims.create_claim(placement=...)); the full contract is in
api-database-reference.md ("Compensation days on a chosen date").

HR only (require_hr, branch-scoped). Permission key compensation.leave.holiday_work.claims (permission_tree.py): View
reads the calendar, Edit places; HR's decision also needs the approval right "compensation_placement" (hr_access: an
extra right on top of Edit; a role that never set it keeps "edit = approve").

    GET   /api/compensation/placements/calendar?employeeId=&month=YYYY-MM&source=
          source = balance (default) | claim:<credit claim id> | overtime:<OT record id> | holiday_work:<YYYY-MM-DD>
          -> {employee, source, balance, window, month, amounts, days, placements, approvalPath, workflowOn, hodProblem}
    POST  /api/compensation/placements
          {employeeId, source: {type, id?, date?}, useDate, shifts, creditShifts?, reason?} -> 201 {claim, message}
          (creditShifts: the credit of a Sunday / holiday worked placed at once, 1.00 by default)
    PATCH /api/compensation/placements/<id>/decision   {status: approved|rejected, comment}   HR's step, after the head's

The Department Head decides with PATCH /api/manager/holiday-work/<id>/status, like every compensation request (the apps and
the MD portal list these with the others; approval_workflow.routed_key sends a placement to HR once the head approved).
A pending placement is withdrawn with DELETE /api/compensation/claims/<id>, like any claim.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from . import compensation_claims as claims
from . import compensation_placement as places
from . import hr_access
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import employee_json, full_name, parse_date, parse_id, parse_shifts, shifts_text
from .models import Employee, HolidayWorkClaim


def _bad(message: str, status: int = 400, code: str = "invalid") -> Response:
    return Response({"error": message, "code": code}, status=status)


def _body(data, *names):
    """The first of `names` the body carries, camelCase or snake_case."""
    if not isinstance(data, dict):
        return None
    for name in names:
        snake = "".join(f"_{c.lower()}" if c.isupper() else c for c in name)
        for key in (name, snake):
            if key in data and data[key] not in (None, ""):
                return data[key]
    return None


def _scoped_employee(request: Request, raw):
    emp_id = parse_id(raw)
    if emp_id is None:
        return None, _bad("employeeId must be a number.")
    emp = (
        scope_to_branch(Employee.objects.select_related("department", "designation", "branch"), request)
        .filter(pk=emp_id)
        .first()
    )
    if emp is None:
        return None, _bad("Employee not found.", 404, "not_found")
    return emp, None


def _month_json(first, today) -> dict:
    low, high = places.window(today)
    _, last = places.month_bounds(first)
    prev_last = first.replace(day=1) - timedelta(days=1)
    next_first = last + timedelta(days=1)
    return {
        "key": places.month_key(first),
        "label": first.strftime("%B %Y"),
        "first": first.isoformat(),
        "last": last.isoformat(),
        "prev": places.month_key(prev_last) if prev_last >= low else None,
        "next": places.month_key(next_first) if next_first <= high else None,
    }


def _placements_json(emp, today) -> list[dict]:
    """The employee's open placements in the window (every source, whoever placed them), soonest first."""
    low, high = places.window(today)
    rows = places.open_placements(emp.id, low, high)
    out = []
    for c in sorted(rows, key=lambda c: (places.placed_day(c)[0], c.id)):
        day, shifts = places.placed_day(c)
        comp = places.claim_type(c)
        out.append(
            {
                "id": c.id,
                "date": day.isoformat(),
                "shifts": places.number(shifts),
                "status": c.status,
                "statusLabel": claims.status_label(c),
                "stage": places.stage(c) if c.hr_step else None,
                "hrStep": bool(c.hr_step),
                "kind": c.kind,
                "compType": comp,
                "compTypeLabel": places.TYPE_LABELS[comp],
                "sourceClaimId": c.source_claim_id,
                "workDate": c.work_date.isoformat() if c.kind != HolidayWorkClaim.KIND_USE_BALANCE else None,
                "raisedByRole": c.raised_by_role,
                "requestedBy": c.requested_by,
                "reason": c.reason,
                "canWithdraw": c.status == HolidayWorkClaim.STATUS_PENDING,
            }
        )
    return out


@api_view(["GET"])
@require_hr
def placement_calendar(request: Request) -> Response:
    """One employee's calendar month for placing compensation from one source (module docstring)."""
    q = request.query_params
    emp, error = _scoped_employee(request, q.get("employeeId") or q.get("employee_id"))
    if error:
        return error
    today = ist_today()
    try:
        raw = places.parse_source(q.get("source") or places.SOURCE_BALANCE)
    except places.PlacementError as exc:
        return Response(exc.as_json(), status=exc.status)
    first = places.parse_month(q.get("month"), today) if q.get("month") else today.replace(day=1)
    if first is None:
        low, high = places.window(today)
        return _bad(
            f"month must be YYYY-MM between {places.month_key(low)} and {places.month_key(high)} (the days compensation "
            "can be placed on)."
        )
    _, last = places.month_bounds(first)
    if emp.employment_type != "staff":
        return _bad(f"{full_name(emp)} is a production employee: compensation is for staff only.", 403, "not_staff")
    places.refresh_days(emp, first, last, today)
    ctx = claims.context()
    figures = claims.balance_figures([emp.id]).get(emp.id) or {}
    try:
        source = places.resolve_source(emp, raw, ctx=ctx, figures=figures)
    except places.PlacementError as exc:
        return Response(exc.as_json(), status=exc.status)
    left = source.left if source.refusal is None else Decimal("0")
    days = places.day_options(emp, first, last, today, left=left)
    cfg = approval.get_config(places.WORKFLOW)
    low, high = places.window(today)
    return Response(
        {
            "employee": employee_json(emp),
            "source": source.to_json(),
            "balance": claims.figures_json(figures),
            "window": {
                "from": low.isoformat(),
                "to": high.isoformat(),
                "backDays": places.BACK_DAYS,
                "aheadDays": places.AHEAD_DAYS,
            },
            "today": today.isoformat(),
            "month": _month_json(first, today),
            "amounts": [places.number(a) for a in places.AMOUNTS],
            "days": [d.to_json() for d in days],
            "placements": _placements_json(emp, today),
            "approvalPath": approval.pipeline_text(approval.definition(places.WORKFLOW).requested_by, cfg.steps),
            "workflowOn": cfg.enabled,
            "hodProblem": claims.hod_problem(emp),
            "reasonMax": places.MAX_REASON_LENGTH,
        }
    )


@api_view(["POST"])
@require_hr
def placements(request: Request) -> Response:
    """HR places compensation on a chosen date -> 201 {claim, message}: it goes to the Department Head, then HR."""
    data = request.data if isinstance(request.data, dict) else {}
    emp, error = _scoped_employee(request, _body(data, "employeeId"))
    if error:
        return error
    today = ist_today()
    use_date = parse_date(_body(data, "useDate", "date"))
    if use_date is None:
        return _bad("useDate must be a date (YYYY-MM-DD).")
    shifts = parse_shifts(_body(data, "shifts"))
    if shifts is None:
        return _bad(f"shifts must be {claims.SHIFT_TEXT}.")
    try:
        raw = places.parse_source(data.get("source"))
        reason = places.clean_reason(_body(data, "reason") or "")
    except places.PlacementError as exc:
        return Response(exc.as_json(), status=exc.status)
    if emp.employment_type != "staff":
        return _bad(f"{full_name(emp)} is a production employee: compensation is for staff only.", 403, "not_staff")
    # the month of the day worked out again first (never a manual day, never a finalized month), outside the locks
    places.refresh_days(emp, *places.month_bounds(use_date), today)
    try:
        source = places.resolve_source(emp, raw)
    except places.PlacementError as exc:
        return Response(exc.as_json(), status=exc.status)
    if source.refusal is not None:
        return _bad(
            source.refusal, 409 if source.refusal_code == "nothing_left" else 400, source.refusal_code or "invalid"
        )
    credit = None
    if source.type == places.SOURCE_HOLIDAY_WORK:
        raw_credit = _body(data, "creditShifts")
        credit = parse_shifts(raw_credit) if raw_credit is not None else places.ONE
        if credit is None:
            return _bad(f"creditShifts must be {claims.SHIFT_TEXT}.")
        if shifts > credit:
            return _bad(
                f"The credit is {shifts_text(credit)} shift, so {shifts_text(shifts)} cannot be placed from it."
            )
    elif shifts > source.left:
        return _bad(
            f"Only {shifts_text(source.left)} shift is left to place, so {shifts_text(shifts)} cannot be placed.",
            409,
            "nothing_left",
        )
    placement = claims.Placement(
        use_date=use_date,
        shifts=shifts,
        source_claim_id=source.claim.pk if source.type == places.SOURCE_CLAIM else None,
        reason_default=places.default_reason(source, use_date, shifts),
    )
    try:
        claim = claims.create_claim(
            employee=emp,
            kind=source.claim_kind,
            date=source.work_date if source.work_date and source.type != places.SOURCE_CLAIM else use_date,
            shifts=credit if source.type == places.SOURCE_HOLIDAY_WORK else None,
            overtime_record=source.record,
            reason=reason,
            raised_by_role=HolidayWorkClaim.RAISED_BY_HR,
            raised_by_name=get_hr_display_name(request),
            request=request,
            placement=placement,
        )
    except claims.ClaimError as exc:
        return Response(exc.as_json(), status=exc.status)
    fresh = claims.claim_queryset().get(pk=claim.pk)
    return Response(
        {
            "claim": claims.claim_json(fresh, for_role="hr"),
            "message": (
                f"Sent to the Department Head: {places.TYPE_LABELS[source.comp_type].lower()} of "
                f"{shifts_text(shifts)} shift on {use_date.strftime('%d %b %Y')} for {full_name(emp)}. HR approves it "
                "after the Department Head."
            ),
        },
        status=201,
    )


@api_view(["PATCH"])
@require_hr
def placement_decision(request: Request, pk: int) -> Response:
    """PATCH {status: approved|rejected, comment}: HR's decision, the second step after the Department Head's. The final
    approval writes the credit / debit and gives the day; a rejection needs its reason."""
    if refused := hr_access.approval_refusal(request, places.WORKFLOW):
        return refused
    claim = (
        scope_to_branch(claims.claim_queryset(), request, field="employee__branch_id")
        .filter(pk=pk, hr_step=True)
        .first()
    )
    if claim is None:
        return _bad("Compensation day not found.", 404, "not_found")
    data = request.data if isinstance(request.data, dict) else {}
    decision = data.get("status") or data.get("decision")
    if decision not in ("approved", "rejected"):
        return _bad("status must be 'approved' or 'rejected'.")
    if refusal := approval.reject_remark_refusal(decision, data.get("comment")):
        return refusal
    actor = get_hr_display_name(request)
    try:
        claim, _outcome = claims.decide(pk, decision, actor, data.get("comment"), role=approval.HR)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    except HolidayWorkClaim.DoesNotExist:
        return _bad("Compensation day not found.", 404, "not_found")
    day, shifts = places.placed_day(claim)
    hr_access.log_decision(
        request,
        places.WORKFLOW,
        claim,
        decision,
        what=(
            f"{places.TYPE_LABELS[places.claim_type(claim)]} of {full_name(claim.employee)} "
            f"({claim.employee.employee_code}): {shifts_text(shifts)} shift on {day.isoformat() if day else '-'}"
        ),
    )
    fresh = claims.claim_queryset().get(pk=pk)
    return Response({"claim": claims.claim_json(fresh, for_role="hr")})
