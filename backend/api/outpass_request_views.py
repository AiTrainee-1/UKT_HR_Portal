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


# How long a generated return QR stays valid, mirroring the exit pass's own
# approved_at + 60min window -see _outpass_request_json's return_qr_token.
RETURN_QR_VALID_MINUTES = 60


def _outpass_scan_status(req: OutpassRequest, expires_at, now) -> str:
    if req.entered_at:
        return "completed"
    if req.exited_at:
        if req.return_qr_generated_at:
            return_expires_at = req.return_qr_generated_at + timedelta(minutes=RETURN_QR_VALID_MINUTES)
            return "pending_return" if now < return_expires_at else "return_expired"
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

    # The return QR is never auto-computed the way the exit one is -it only
    # exists once the employee explicitly taps "Generate Return QR"
    # (generate_return_qr below), which stamps return_qr_generated_at. The
    # token embeds that same timestamp as a "generatedAt" claim so
    # resolve_gate_scan can tell a stale, since-regenerated token apart from
    # the current one even though both would otherwise still verify/decode.
    return_qr_token = None
    return_qr_expires_at = None
    if req.return_qr_generated_at:
        return_qr_expires_at = req.return_qr_generated_at + timedelta(minutes=RETURN_QR_VALID_MINUTES)
    if scan_status == "pending_return":
        return_qr_token = sign_token(
            {"role": "outpass_return", "requestId": req.id, "generatedAt": req.return_qr_generated_at.isoformat()},
            expires_in=return_qr_expires_at - now,
        )

    data = {
        "id": req.id,
        "employeeId": req.employee_id,
        "destination": req.destination,
        "reason": req.reason,
        "passType": req.pass_type,
        "expectedReturnAt": req.expected_return_at.isoformat() if req.expected_return_at else None,
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
        "entryGateName": req.entry_gate.name if req.entry_gate_id else None,
        "enteredAt": req.entered_at.isoformat() if req.entered_at else None,
        "returnQrToken": return_qr_token,
        "returnQrExpiresAt": return_qr_expires_at.isoformat() if return_qr_expires_at else None,
        "canGenerateReturnQr": bool(req.exited_at and not req.entered_at),
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
            "employee__department", "employee__designation", "exit_gate", "entry_gate"
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

    pass_type = data.get("passType") or data.get("pass_type")
    if pass_type and pass_type not in dict(OutpassRequest.PASS_TYPE_CHOICES):
        return Response({"error": "Invalid passType"}, status=400)

    expected_return_at = data.get("expectedReturnAt") or data.get("expected_return_at")
    if expected_return_at:
        from django.utils.dateparse import parse_datetime
        parsed_return = parse_datetime(expected_return_at)
        if parsed_return is None:
            return Response({"error": "Invalid expectedReturnAt format (ISO 8601)"}, status=400)
        expected_return_at = parsed_return
    else:
        expected_return_at = None

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    req = OutpassRequest.objects.create(
        employee=emp, destination=destination, reason=reason,
        pass_type=pass_type, expected_return_at=expected_return_at,
    )
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


@api_view(["POST"])
@require_auth
def generate_return_qr(request: Request, pk: int) -> Response:
    """The "manual Generate Return QR button" on the employee's own Outpass
    card -self-scoped exactly like outpass_requests' POST, since this is an
    employee action on their own pass, not an HR one. Re-calling this after
    an earlier return QR already expired (or even before it expires) simply
    issues a fresh one -see the "generatedAt" claim check in
    gate_scanner_views.py::resolve_gate_scan for why that's safe."""
    token_emp_id = get_token_employee_id(request)
    req = OutpassRequest.objects.select_related("employee").filter(pk=pk).first()
    if not req:
        return Response({"error": "Outpass request not found"}, status=404)
    if token_emp_id and str(token_emp_id) != str(req.employee_id):
        return Response({"error": "You can only generate a return QR for your own outpass"}, status=403)
    if not req.exited_at:
        return Response({"error": "This Outpass hasn't been exited yet, so there's no return to record."}, status=400)
    if req.entered_at:
        return Response({"error": "This Outpass has already been marked as returned."}, status=400)

    req.return_qr_generated_at = timezone.now()
    req.save(update_fields=["return_qr_generated_at", "updated_at"])
    return Response(_outpass_request_json(req))
