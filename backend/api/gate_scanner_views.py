"""
Gate Scanner -per-gate kiosk login + QR exit verification for approved
Outpasses (OutpassRequest, outpass_request_views.py).

Deliberately separate from outpass_visitor_views.py's GateQRCode/OutpassRecord
flow: that one is a permanent, unauthenticated, per-branch QR that lets
anyone submit an outpass/visitor entry from their own phone with no login at
all. This one is a real username/password login for a physical device that
VERIFIES an already-approved OutpassRequest's QR (see
outpass_request_views.py::_outpass_request_json's qrToken field) and records
the employee's exit against that specific gate. Two unrelated concepts that
happen to share the word "gate" -see GateDevice's docstring in models.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import bcrypt
from django.utils import timezone
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from .auth import get_hr_display_name, require_gate_device, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .jwt_utils import sign_token, verify_token
from .models import Branch, GateDevice, OutpassGateScan, OutpassRequest
from .outpass_visitor_views import _paginate_params


def _today_start():
    """Asia/Kolkata midnight -matches outpass_visitor_views.py::_range_bounds
    so "today" means the same thing everywhere in this feature."""
    now_ist = timezone.now().astimezone(FACTORY_TZ)
    return now_ist.replace(hour=0, minute=0, second=0, microsecond=0)


def _gate_device_json(gate: GateDevice) -> dict:
    return {
        "id": gate.id,
        "name": gate.name,
        "branchId": gate.branch_id,
        "branchName": gate.branch.name if gate.branch_id else None,
        "username": gate.username,
        "isActive": gate.is_active,
        "loginToken": gate.login_token,
        "createdBy": gate.created_by,
        "createdAt": gate.created_at.isoformat(),
        "lastLoginAt": gate.last_login_at.isoformat() if gate.last_login_at else None,
    }


def _gate_scan_employee_payload(req: OutpassRequest) -> dict:
    emp = req.employee
    expires_at = req.approved_at + timedelta(minutes=60) if req.approved_at else None
    return {
        "employee": {
            "name": f"{emp.first_name} {emp.last_name}",
            "employeeCode": emp.employee_code,
            "department": emp.department.name if emp.department else None,
            "photoUrl": emp.photo_url,
        },
        "destination": req.destination,
        "reason": req.reason,
        "approvedBy": req.approved_by,
        "approverRole": req.approver_role,
        "approvedAt": req.approved_at.isoformat() if req.approved_at else None,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "gateName": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": req.exited_at.isoformat() if req.exited_at else None,
    }


# ── Gate device management -HR portal ───────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def gate_devices(request: Request) -> Response:
    if request.method == "GET":
        qs = scope_to_branch(GateDevice.objects.select_related("branch").order_by("name"), request)
        return Response([_gate_device_json(g) for g in qs])

    data = request.data
    name = (data.get("name") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not name or not username or not password:
        return Response({"error": "name, username and password are required"}, status=400)
    if len(password) < 6:
        return Response({"error": "Password must be at least 6 characters"}, status=400)

    branch_id = get_branch_scope(request) or data.get("branchId")
    if not branch_id:
        return Response({"error": "branchId is required"}, status=400)
    branch = Branch.objects.filter(id=branch_id).first()
    if not branch:
        return Response({"error": "Branch not found"}, status=404)

    if GateDevice.objects.filter(username__iexact=username).exists():
        return Response({"error": "That username is already taken"}, status=409)

    gate = GateDevice.objects.create(
        name=name,
        branch=branch,
        username=username,
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode(),
        login_token=uuid.uuid4().hex,
        created_by=get_hr_display_name(request),
    )
    return Response(_gate_device_json(gate), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def gate_device_detail(request: Request, pk: int) -> Response:
    gate = scope_to_branch(GateDevice.objects.all(), request).filter(pk=pk).first()
    if not gate:
        return Response({"error": "Gate not found"}, status=404)

    if request.method == "DELETE":
        gate.delete()
        return Response(status=204)

    data = request.data
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return Response({"error": "name cannot be empty"}, status=400)
        gate.name = name
    if "isActive" in data:
        gate.is_active = bool(data.get("isActive"))
    if data.get("password"):
        password = data["password"]
        if len(password) < 6:
            return Response({"error": "Password must be at least 6 characters"}, status=400)
        gate.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    gate.save()
    return Response(_gate_device_json(gate))


# ── Gate device auth -public ─────────────────────────────────────────────────

@api_view(["GET"])
def gate_login_info(request: Request, login_token: str) -> Response:
    gate = GateDevice.objects.filter(login_token=login_token).select_related("branch").first()
    if not gate:
        return Response({"error": "This gate login link is not recognized."}, status=404)
    return Response({"gateName": gate.name, "branchName": gate.branch.name, "isActive": gate.is_active})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def gate_login(request: Request) -> Response:
    request.throttle_scope = "login"
    username = (request.data.get("username") or "").strip()
    password = request.data.get("password") or ""

    gate = GateDevice.objects.filter(username__iexact=username).first()
    valid = bool(gate) and gate.is_active and bcrypt.checkpw(password.encode(), gate.password_hash.encode())
    if not valid:
        return Response({"error": "Invalid username or password"}, status=401)

    token = sign_token({"role": "gate_device", "deviceId": gate.id, "gateName": gate.name}, expires_in=timedelta(hours=24))
    gate.last_login_at = timezone.now()
    gate.save(update_fields=["last_login_at"])
    return Response({"token": token, "gateId": gate.id, "gateName": gate.name})


# ── QR verification + exit recording -gate kiosk ────────────────────────────

def resolve_gate_scan(gate: GateDevice, qr_token: str) -> tuple[dict, int]:
    """The whole verify-and-record decision, factored out of the view so it
    can be unit-tested directly (this codebase's convention -see
    outpass_request_views.py::resolve_outpass_request) without going through
    the HTTP/JWT-decorator stack. Every branch, success or failure, logs an
    OutpassGateScan row -HR should be able to see denied attempts too."""
    qr_token = (qr_token or "").strip()
    if not qr_token:
        return {"result": "invalid_qr", "message": "qrToken is required"}, 400

    try:
        payload = verify_token(qr_token)
        if payload.get("role") != "outpass_pass":
            raise ValueError("wrong token role")
        req_id = payload["requestId"]
    except Exception:
        message = "This QR code is not a valid Outpass pass."
        OutpassGateScan.objects.create(gate=gate, result=OutpassGateScan.RESULT_INVALID_QR, message=message)
        return {"result": "invalid_qr", "message": message}, 400

    req = OutpassRequest.objects.select_related(
        "employee__department", "employee__designation", "exit_gate"
    ).filter(pk=req_id).first()
    if not req:
        message = "This Outpass request no longer exists."
        OutpassGateScan.objects.create(gate=gate, result=OutpassGateScan.RESULT_INVALID_QR, message=message)
        return {"result": "invalid_qr", "message": message}, 404

    now = timezone.now()
    expires_at = req.approved_at + timedelta(minutes=60) if req.approved_at else None

    if req.exited_at:
        message = "Already exited at " + req.exited_at.strftime("%I:%M %p")
        if req.exit_gate_id:
            message += f" via {req.exit_gate.name}"
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee,
            result=OutpassGateScan.RESULT_ALREADY_SCANNED, message=message,
        )
        return {"result": "already_scanned", "message": message, **_gate_scan_employee_payload(req)}, 409

    if req.status != OutpassRequest.STATUS_APPROVED:
        message = "This Outpass request was not approved."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee,
            result=OutpassGateScan.RESULT_NOT_APPROVED, message=message,
        )
        return {"result": "not_approved", "message": message, **_gate_scan_employee_payload(req)}, 403

    if not expires_at or now >= expires_at:
        message = "This Outpass has expired."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee,
            result=OutpassGateScan.RESULT_EXPIRED, message=message,
        )
        return {"result": "expired", "message": message, **_gate_scan_employee_payload(req)}, 410

    req.exit_gate = gate
    req.exited_at = now
    req.save(update_fields=["exit_gate", "exited_at", "updated_at"])
    message = f"Exit recorded via {gate.name}"
    OutpassGateScan.objects.create(
        gate=gate, outpass_request=req, employee=req.employee,
        result=OutpassGateScan.RESULT_SUCCESS, message=message,
    )
    return {"result": "success", "message": message, **_gate_scan_employee_payload(req)}, 200


@api_view(["POST"])
@require_gate_device
def gate_scan(request: Request) -> Response:
    body, status = resolve_gate_scan(request.gate_device, request.data.get("qrToken"))
    return Response(body, status=status)


# ── Today's gate-out log -gate kiosk ─────────────────────────────────────────

@api_view(["GET"])
@require_gate_device
def gate_scan_log(request: Request) -> Response:
    """Every successful exit recorded through THIS gate today, newest first —
    the left-hand "Today's Gate-Out Report" on the kiosk console. Scoped to
    the authenticated gate, not the whole branch, since that's what the
    operator standing at this specific gate actually wants to see. Paginated
    the same way outpass_visitor_views.py::outpass_records is -page/pageSize
    query params, {items,total,page,pageSize} shape -so the console can reuse
    the app's usual RecordsPagination component, and the "export everything"
    flow can page through it without a separate unbounded endpoint."""
    page, page_size = _paginate_params(request)
    qs = (
        OutpassGateScan.objects
        .filter(gate=request.gate_device, result=OutpassGateScan.RESULT_SUCCESS, scanned_at__gte=_today_start())
        .select_related("employee__department", "outpass_request")
        .order_by("-scanned_at")
    )
    total = qs.count()
    offset = (page - 1) * page_size
    rows = qs[offset:offset + page_size]
    return Response({
        "items": [
            {
                "id": s.id,
                "employeeName": f"{s.employee.first_name} {s.employee.last_name}" if s.employee else "—",
                "employeeCode": s.employee.employee_code if s.employee else None,
                "department": s.employee.department.name if s.employee and s.employee.department else None,
                "photoUrl": s.employee.photo_url if s.employee else None,
                "destination": s.outpass_request.destination if s.outpass_request else None,
                "reason": s.outpass_request.reason if s.outpass_request else None,
                "approvedBy": s.outpass_request.approved_by if s.outpass_request else None,
                "approverRole": s.outpass_request.approver_role if s.outpass_request else None,
                "exitedAt": s.scanned_at.isoformat(),
            }
            for s in rows
        ],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })
