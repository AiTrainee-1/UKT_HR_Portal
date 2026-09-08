"""
Outpass Approval -a second, parallel way to get an Outpass alongside the
QR-scan flow in outpass_visitor_views.py. An employee requests one (or an
On-Duty session generates one automatically on approval, see
geo_attendance_views.py::_create_outpass_from_on_duty), and either their HOD
or HR can approve it -approval from either side is sufficient, exactly like
EmployeePermission (leave_views.py::employee_permissions /
employee_permission_detail, manager_views.py::manager_update_permission_status).

Approving an OutpassRequest creates one OutpassRecord (via
outpass_visitor_views.py::_create_outpass_record_for) -the HR Outpass page
needs no changes at all to show it.
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_hr_display_name, get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .jwt_utils import sign_token
from .models import Employee, Notification, OutpassRequest
from .outpass_visitor_views import _create_outpass_record_for


def _outpass_scan_status(req: OutpassRequest, expires_at, now) -> str:
    if req.exited_at:
        return "exited"
    if req.status != OutpassRequest.STATUS_APPROVED:
        return "not_applicable"
    if expires_at and now >= expires_at:
        return "expired_unscanned"
    return "pending_exit"


def _outpass_request_json(req: OutpassRequest, with_employee: bool = False) -> dict:
    expires_at = req.approved_at + timedelta(minutes=60) if req.approved_at else None
    now = timezone.now()
    scan_status = _outpass_scan_status(req, expires_at, now)

    # The QR only ever encodes a request that is actually presentable at a
    # gate right now -once exited, expired, or never approved, it's simply
    # omitted, so a used/stale pass stops rendering a scannable code at all
    # rather than relying on the gate to reject it.
    qr_token = None
    if scan_status == "pending_exit":
        qr_token = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=expires_at - now)

    data = {
        "id": req.id,
        "employeeId": req.employee_id,
        "destination": req.destination,
        "reason": req.reason,
        "status": req.status,
        "source": req.source,
        "approverRole": req.approver_role,
        "approvedBy": req.approved_by,
        "reviewComment": req.review_comment,
        "approvedAt": req.approved_at.isoformat() if req.approved_at else None,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "createdAt": req.created_at.isoformat(),
        "qrToken": qr_token,
        "exitGateName": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": req.exited_at.isoformat() if req.exited_at else None,
        "scanStatus": scan_status,
    }
    if with_employee:
        emp = req.employee
        # employeeCode (not "code") to match _leave_with_emp/_perm_with_emp's
        # existing nested-employee convention in manager_views.py -photoUrl is
        # the one addition unique to Outpass, for the approved-pass card.
        data["employee"] = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "photoUrl": emp.photo_url,
        }
    return data


def resolve_outpass_request(
    req: OutpassRequest, decision: str, reviewer_name: str, approver_role: str, comment: str | None,
) -> None:
    """Single-stage resolution -unlike On-Duty's two-stage HOD-then-HR chain,
    whichever of HOD/HR acts first on an OutpassRequest is final, matching
    EmployeePermission's "approval from either side is sufficient" shape."""
    req.status = OutpassRequest.STATUS_APPROVED if decision == "approved" else OutpassRequest.STATUS_REJECTED
    req.approver_role = approver_role
    req.approved_by = reviewer_name
    if comment:
        req.review_comment = comment
    if decision == "approved":
        req.approved_at = timezone.now()
        req.outpass_record = _create_outpass_record_for(req.employee, req.destination, source="request")
    req.save()
    Notification.objects.create(
        employee=req.employee,
        type="outpass",
        message=f"Your Outpass request for {req.destination} was "
                f"{'Approved' if decision == 'approved' else 'Not Approved'}.",
    )


@api_view(["GET", "POST"])
@require_auth
def outpass_requests(request: Request) -> Response:
    if request.method == "GET":
        qs = OutpassRequest.objects.select_related(
            "employee__department", "employee__designation", "exit_gate"
        ).order_by("-created_at")
        qs = scope_to_branch(qs, request, field="employee__branch_id")

        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        elif emp_id := request.query_params.get("employeeId"):
            qs = qs.filter(employee_id=emp_id)
        if status := request.query_params.get("status"):
            qs = qs.filter(status=status)

        # An employee only ever sees their own -no employee{} block needed.
        # HR's list (no token_emp_id) includes it, same convention as
        # manager_pending_requests' *_with_emp() serializers.
        return Response([_outpass_request_json(r, with_employee=not token_emp_id) for r in qs])

    data = request.data
    token_emp_id = get_token_employee_id(request)
    emp_id = token_emp_id or data.get("employeeId") or data.get("employee_id")
    if token_emp_id and str(token_emp_id) != str(emp_id):
        return Response({"error": "You can only submit outpass requests for yourself"}, status=403)
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)

    destination = (data.get("destination") or "").strip()
    reason = (data.get("reason") or "").strip()
    if not destination or not reason:
        return Response({"error": "destination and reason are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    req = OutpassRequest.objects.create(employee=emp, destination=destination, reason=reason)
    return Response(_outpass_request_json(req), status=201)


@api_view(["PUT"])
@require_hr
def outpass_request_hr_status(request: Request, pk: int) -> Response:
    try:
        req = OutpassRequest.objects.select_related("employee").get(pk=pk)
    except OutpassRequest.DoesNotExist:
        return Response({"error": "Outpass request not found"}, status=404)

    status = request.data.get("status")
    if status not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    resolve_outpass_request(req, status, get_hr_display_name(request), "hr", request.data.get("comment"))
    return Response(_outpass_request_json(req))
