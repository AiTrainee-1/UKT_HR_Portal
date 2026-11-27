"""
Withdraw one of my own requests (mobile app, owner 2026-11-24).

    POST /api/my/requests/<module>/<id>/withdraw        module: leave | permission | casual_leave | advance

Only the kinds the owner chose: Leave, Permission and Casual Leave, and (owner 2026-11-26) a Salary Advance or Term Loan
application (module "advance"; HR decides those alone, so no Department Head is told). Compensation claims already have their own
(DELETE /api/employee/compensation/claims/<id>); On-Duty, missing punch, On-Duty punches and outpasses are deliberately
NOT withdrawable from the app (sensitive: they touch attendance and the gate).

The rule (owner: "until the final decision"): the request must be the caller's own and still waiting for an answer at
ANY step of its approval pipeline (status "pending", even when the Department Head already approved and HR has not
decided yet). Once it is fully approved or rejected it can no longer be withdrawn: nothing is ever reversed here.

Nothing a decision does (balances, attendance) has happened to a pending request yet (approval_workflow.py: only the
FINAL approval runs a module's side effects), so withdrawing removes the row, the same as HR's own delete of these
rows and the compensation claim withdraw. The row is locked first so it cannot be decided and withdrawn at the same
moment; what was withdrawn is kept in the audit log. A Department Head who was waiting on it is told in the app.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .audit_utils import log_action
from .auth import get_token_employee_id, require_auth
from .models import Advance, CasualLeaveRequest, EmployeePermission, LeaveRequest, Notification

# module -> (model, approval workflow key, what to call it in sentences, the Department Head's can_approve_* switch)
WITHDRAWABLE = {
    "leave": (LeaveRequest, "leave", "leave request", "can_approve_leaves"),
    "permission": (EmployeePermission, "permission", "permission request", "can_approve_permissions"),
    "casual_leave": (CasualLeaveRequest, "casual_leave", "casual leave request", "can_approve_casual_leave"),
    # owner 2026-11-26: a Salary Advance / Term Loan while HR has not decided it (HR only: no Department Head flag)
    "advance": (Advance, "advance", "advance application", None),
}
ADVANCE_WHAT = {"general": "Salary Advance application", "term": "Term Loan application"}
# The app also sends these spellings.
ALIASES = {
    "casual-leave": "casual_leave",
    "casualLeave": "casual_leave",
    "leave-requests": "leave",
    "permissions": "permission",
    "advances": "advance",
    "salary_advance": "advance",
    "term_loan": "advance",
}


def _snapshot(obj) -> dict:
    keep = {}
    for field in ("leave_type_id", "start_date", "end_date", "date", "cl_date", "permission_type", "type",
                  "reason", "status", "is_half_day", "half_day_session", "start_time", "end_time",
                  "advance_type", "amount", "requested_amount", "purpose", "repayment_months"):
        if hasattr(obj, field):
            value = getattr(obj, field)
            if hasattr(value, "isoformat"):
                value = value.isoformat()
            elif isinstance(value, Decimal):
                value = str(value)  # an advance's amounts (the audit log stores JSON)
            keep[field] = value
    return keep


def _tell_waiting_head(workflow: str, flag: str, obj, employee, what: str) -> None:
    """In-app note for the Department Head the request was waiting on (when it was waiting on one)."""
    if not flag:
        return  # HR decides it alone (an advance): there is no Department Head to tell
    try:
        progress = approval.progress(workflow, obj) or {}
        waiting = progress.get("waitingFor") or []
        if approval.HOD not in waiting:
            return
        from .hod_scope import managers_to_notify

        name = f"{employee.first_name} {employee.last_name}".strip()
        for manager in managers_to_notify(employee, flag, exclude_self=True):
            head = manager.employee
            Notification.objects.create(
                employee=head,
                type="general",
                title="Request withdrawn",
                message=f"{name} withdrew their {what}. Nothing is waiting for you on it any more.",
                source="request_withdrawn",
            )
    except Exception:
        # Telling the head is a courtesy: it must never stop the withdraw itself.
        pass


@api_view(["POST"])
@require_auth
def withdraw_my_request(request: Request, module: str, pk: int) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return Response({"error": "Only the employee who made a request can withdraw it."}, status=403)
    module = ALIASES.get(module, module)
    if module not in WITHDRAWABLE:
        return Response(
            {"error": "This kind of request cannot be withdrawn from the app. Please contact HR.",
             "code": "not_withdrawable"},
            status=400,
        )
    model, workflow, what, flag = WITHDRAWABLE[module]

    with transaction.atomic():
        obj = model.objects.select_for_update().select_related("employee").filter(pk=pk).first()
        if obj is None or obj.employee_id != employee_id:
            # Someone else's request is reported exactly like a missing one.
            return Response({"error": "Request not found.", "code": "not_found"}, status=404)
        if module == "advance":
            from .settlement_views import _in_workflow

            if _in_workflow(obj):
                # Settlement Automation Method (2026-11-26): HR already forwarded it to the MD
                return Response(
                    {
                        "error": "HR has already forwarded this request for approval, so it can no longer be deleted. "
                        "Please contact HR.",
                        "code": "in_workflow",
                    },
                    status=409,
                )
        if module == "advance" and obj.applied_by != Advance.APPLIED_BY_EMPLOYEE:
            # an advance HR recorded is not the employee's application: only HR may remove it
            return Response(
                {
                    "error": "HR recorded this advance, so only HR can remove it. Please contact HR.",
                    "code": "recorded_by_hr",
                },
                status=409,
            )
        # an advance has a fixed HR-only pipeline (no approval adapter): waiting = status "pending"
        still_waiting = obj.status == "pending" if module == "advance" else approval.is_pending(workflow, obj)
        if not still_waiting:
            status = getattr(obj, "status", "")
            return Response(
                {
                    "error": f"This {what} is already {status or 'decided'}: only a request that is still waiting "
                             "for an answer can be withdrawn.",
                    "code": "not_pending",
                    "status": status,
                },
                status=409,
            )
        employee = obj.employee
        if module == "advance":
            what = ADVANCE_WHAT.get(obj.advance_type, what)
        snapshot = _snapshot(obj)
        _tell_waiting_head(workflow, flag, obj, employee, what)
        obj.delete()

    log_action(
        request, "withdraw", module, record_id=pk,
        description=f"{employee.first_name} {employee.last_name} ({employee.employee_code}) withdrew their {what}",
        old_values=snapshot,
    )
    return Response({
        "withdrawn": True,
        "module": module,
        "id": pk,
        "message": f"Your {what} was withdrawn.",
    })
