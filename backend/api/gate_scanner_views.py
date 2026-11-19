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

from datetime import datetime, timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import gate_qr, whatsapp_notifications
from .auth import require_gate_device
from .clock import FACTORY_TZ
from .employee_photo import employee_photo_link, photo_links
from .gate_credentials import LOGIN_ERRORS, LOGIN_LOCKED, LOGIN_OK, check_gate_login, start_gate_session
from .gate_records import already_scanned_message
from .jwt_utils import verify_token
from .models import GateDevice, OutpassGateScan, OutpassRequest
from .outpass_visitor_views import _paginate_params
from .throttles import throttle

# A recognised code of a kind this gate is set not to take (GateDevice.allow_outpass / allow_tea_break): 403.
NOT_ALLOWED_HERE = OutpassGateScan.RESULT_NOT_ALLOWED_HERE
NOT_ALLOWED_PASS_MESSAGE = "This gate does not take gate passes."
NOT_ALLOWED_TEA_MESSAGE = "This gate does not take tea-break scans."


def _today_start():
    """Asia/Kolkata midnight -matches outpass_visitor_views.py::_range_bounds
    so "today" means the same thing everywhere in this feature."""
    now_ist = timezone.now().astimezone(FACTORY_TZ)
    return now_ist.replace(hour=0, minute=0, second=0, microsecond=0)


def _gate_scan_employee_payload(req: OutpassRequest) -> dict:
    emp = req.employee
    expires_at = req.approved_at + timedelta(minutes=60) if req.approved_at else None
    return {
        "employee": {
            "name": f"{emp.first_name} {emp.last_name}",
            "employeeCode": emp.employee_code,
            "department": emp.department.name if emp.department else None,
            # a signed link the kiosk's <img> loads with no token (employee_photo.py), not the embedded picture
            "photoUrl": employee_photo_link(emp),
        },
        "destination": req.destination,
        "reason": req.reason,
        "approvedBy": req.approved_by,
        "approverRole": req.approver_role,
        "approvedAt": req.approved_at.isoformat() if req.approved_at else None,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "gateName": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": req.exited_at.isoformat() if req.exited_at else None,
        "entryGateName": req.entry_gate.name if req.entry_gate_id else None,
        "enteredAt": req.entered_at.isoformat() if req.entered_at else None,
    }


# Gate device management (HR portal: gate_devices, gate_device_detail, _gate_device_json) lives in gate_admin_views.py
# since 18 Nov 2026.

# ── Gate device auth -public ─────────────────────────────────────────────────

@api_view(["GET"])
def gate_login_info(request: Request, login_token: str) -> Response:
    gate = GateDevice.objects.filter(login_token=login_token).select_related("branch").first()
    if not gate:
        return Response({"error": "This gate login link is not recognized."}, status=404)
    return Response({"gateName": gate.name, "branchName": gate.branch.name, "isActive": gate.is_active})


@api_view(["POST"])
@throttle("login")
def gate_login(request: Request) -> Response:
    """The old kiosk sign-in (before /gatemonitor; e2e still uses it), same keys {token, gateId, gateName}.
    Since 18 Nov 2026 it shares gate_credentials.check_gate_login with POST gate-monitor/login: it records the
    attempt, honours the 5-wrong-tries lock (429) and opens a GateSession (a 30-day token with gsid). A wrong
    password and a switched-off gate still both answer the old 401."""
    data = request.data if hasattr(request.data, "get") else {}
    gate, outcome = check_gate_login(request, data.get("username"), data.get("password"))
    if outcome == LOGIN_LOCKED:
        status, message = LOGIN_ERRORS[LOGIN_LOCKED]
        return Response({"error": message}, status=status)
    if outcome != LOGIN_OK:
        return Response({"error": "Invalid username or password"}, status=401)
    _session, token = start_gate_session(gate, request)
    return Response({"token": token, "gateId": gate.id, "gateName": gate.name})


# ── QR verification + exit recording -gate kiosk ────────────────────────────

def _resolve_exit_scan(gate: GateDevice, req: OutpassRequest) -> tuple[dict, int]:
    now = timezone.now()
    expires_at = req.approved_at + timedelta(minutes=60) if req.approved_at else None

    if req.exited_at:
        # in India time (the stored message of a scan before 19 Nov 2026 has the UTC clock: gate_records rebuilds it)
        message = already_scanned_message(False, req.exited_at, req.exit_gate.name if req.exit_gate_id else None)
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_EXIT,
            result=OutpassGateScan.RESULT_ALREADY_SCANNED, message=message,
        )
        return {"result": "already_scanned", "scanType": "exit", "message": message, **_gate_scan_employee_payload(req)}, 409

    if req.status != OutpassRequest.STATUS_APPROVED:
        message = "This Outpass request was not approved."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_EXIT,
            result=OutpassGateScan.RESULT_NOT_APPROVED, message=message,
        )
        return {"result": "not_approved", "scanType": "exit", "message": message, **_gate_scan_employee_payload(req)}, 403

    if not expires_at or now >= expires_at:
        message = "This Outpass has expired."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_EXIT,
            result=OutpassGateScan.RESULT_EXPIRED, message=message,
        )
        return {"result": "expired", "scanType": "exit", "message": message, **_gate_scan_employee_payload(req)}, 410

    req.exit_gate = gate
    req.exited_at = now
    req.save(update_fields=["exit_gate", "exited_at", "updated_at"])
    message = f"Exit recorded via {gate.name}"
    OutpassGateScan.objects.create(
        gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_EXIT,
        result=OutpassGateScan.RESULT_SUCCESS, message=message,
    )
    whatsapp_notifications.notify_gate_out(req)
    return {"result": "success", "scanType": "exit", "message": message, **_gate_scan_employee_payload(req)}, 200


def _same_instant(claim: str | None, current) -> bool:
    """True when the code's generatedAt claim is the very moment the live return QR was generated (a text compare of
    the old token's ISO string, now a compare of instants so the short code and the old token both work)."""
    if not claim or current is None:
        return False
    try:
        return datetime.fromisoformat(claim) == current
    except (TypeError, ValueError):
        return False


def _resolve_return_scan(gate: GateDevice, req: OutpassRequest, generated_at_claim: str | None) -> tuple[dict, int]:
    now = timezone.now()

    if req.entered_at:
        message = already_scanned_message(True, req.entered_at, req.entry_gate.name if req.entry_gate_id else None)
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_ENTRY,
            result=OutpassGateScan.RESULT_ALREADY_SCANNED, message=message,
        )
        return {"result": "already_scanned", "scanType": "entry", "message": message, **_gate_scan_employee_payload(req)}, 409

    if not req.exited_at:
        message = "This employee hasn't exited yet -there's no return to record."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_ENTRY,
            result=OutpassGateScan.RESULT_NOT_EXITED, message=message,
        )
        return {"result": "not_exited", "scanType": "entry", "message": message, **_gate_scan_employee_payload(req)}, 403

    # The token's own "generatedAt" claim must match the live column -if the
    # employee has since re-clicked "Generate Return QR", a newer token now
    # exists and this one, though still cryptographically valid and unexpired
    # on its own terms, is stale and must be rejected.
    if not _same_instant(generated_at_claim, req.return_qr_generated_at):
        message = "This return QR is no longer valid -a newer one was generated for this Outpass."
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_ENTRY,
            result=OutpassGateScan.RESULT_INVALID_QR, message=message,
        )
        return {"result": "invalid_qr", "scanType": "entry", "message": message, **_gate_scan_employee_payload(req)}, 400

    req.entry_gate = gate
    req.entered_at = now
    req.save(update_fields=["entry_gate", "entered_at", "updated_at"])
    message = f"Return recorded via {gate.name}"
    OutpassGateScan.objects.create(
        gate=gate, outpass_request=req, employee=req.employee, scan_type=OutpassGateScan.SCAN_TYPE_ENTRY,
        result=OutpassGateScan.RESULT_SUCCESS, message=message,
    )
    whatsapp_notifications.notify_gate_in(req)
    return {"result": "success", "scanType": "entry", "message": message, **_gate_scan_employee_payload(req)}, 200


def resolve_gate_scan(gate: GateDevice, qr_token: str) -> tuple[dict, int]:
    """The whole verify-and-record decision, factored out of the view so it
    can be unit-tested directly (this codebase's convention -see
    outpass_request_views.py::resolve_outpass_request) without going through
    the HTTP/JWT-decorator stack. Every branch, success or failure, logs an
    OutpassGateScan row -HR should be able to see denied attempts too
    (except the tea_break branch below, which has no approval/denial states
    to log -see tea_break_views.py's module docstring).

    Branches on the token's "role" claim -"outpass_pass" is the original exit
    QR (unchanged behaviour), "outpass_return" is the return/re-entry QR
    generated on demand via outpass_request_views.py::generate_return_qr,
    "tea_break" is the permanent per-employee QR from tea_break_views.py::
    tea_break_qr_token -the same gate logins scan all three, deliberately,
    per explicit product decision not to stand up a separate device/login
    concept just for tea breaks.

    Since 18 Nov 2026 a gate may be set to take only one kind
    (GateDevice.allow_outpass / allow_tea_break, Manage Gates). A recognised
    code of a kind the gate does not take is refused with 403
    {"result": "not_allowed_here", "message"} (plus the employee and pass
    details the code names) and logged as a denied OutpassGateScan row
    (RESULT_NOT_ALLOWED_HERE) -for a tea-break code too, so the refusal shows
    in the gate's records: since 19 Nov 2026 as a denied scan of type "tea"
    (SCAN_TYPE_TEA; the records show it as a refused tea break, never as an
    exit; TeaBreakLog only holds breaks that happened). An unreadable code is
    still "invalid_qr" (with the default type, as before)."""
    qr_token = qr_token.strip() if isinstance(qr_token, str) else ""
    if not qr_token:
        return {"result": "invalid_qr", "message": "qrToken is required"}, 400

    try:
        # The short signed code (gate_qr.py) is what the apps show now; the old long JWT still works so a pass that was
        # already open on a phone before the change is not refused.
        payload = gate_qr.parse(qr_token) if gate_qr.looks_like_code(qr_token) else verify_token(qr_token)
        role = payload.get("role")
        if role not in ("outpass_pass", "outpass_return", "tea_break"):
            raise ValueError("wrong token role")
    except Exception:
        message = (
            "This QR code was read incompletely by the scanner. Please scan it again."
            if gate_qr.looks_like_cut_jwt(qr_token)
            else "This QR code is not recognized."
        )
        OutpassGateScan.objects.create(gate=gate, result=OutpassGateScan.RESULT_INVALID_QR, message=message)
        return {"result": "invalid_qr", "message": message}, 400

    if role == "tea_break":
        from .models import Employee
        from .tea_break_views import resolve_tea_break_scan

        employee = Employee.objects.select_related("department").filter(pk=payload.get("employeeId")).first()
        if not gate.allow_tea_break:
            OutpassGateScan.objects.create(
                gate=gate, employee=employee, scan_type=OutpassGateScan.SCAN_TYPE_TEA,
                result=OutpassGateScan.RESULT_NOT_ALLOWED_HERE, message=NOT_ALLOWED_TEA_MESSAGE,
            )
            body = {"result": NOT_ALLOWED_HERE, "kind": "tea_break", "message": NOT_ALLOWED_TEA_MESSAGE}
            if employee:
                body["employee"] = {
                    "id": employee.id,
                    "employeeCode": employee.employee_code,
                    "name": f"{employee.first_name} {employee.last_name}",
                    "department": employee.department.name if employee.department else None,
                    "photoUrl": employee_photo_link(employee),
                }
            return body, 403
        if not employee:
            message = "This employee no longer exists."
            OutpassGateScan.objects.create(gate=gate, result=OutpassGateScan.RESULT_INVALID_QR, message=message)
            return {"result": "invalid_qr", "message": message}, 404
        return resolve_tea_break_scan(gate, employee)

    req_id = payload.get("requestId")
    req = OutpassRequest.objects.select_related(
        "employee__department", "employee__designation", "exit_gate", "entry_gate"
    ).filter(pk=req_id).first()
    if not gate.allow_outpass:
        scan_type = OutpassGateScan.SCAN_TYPE_ENTRY if role == "outpass_return" else OutpassGateScan.SCAN_TYPE_EXIT
        OutpassGateScan.objects.create(
            gate=gate, outpass_request=req, employee=req.employee if req else None, scan_type=scan_type,
            result=OutpassGateScan.RESULT_NOT_ALLOWED_HERE, message=NOT_ALLOWED_PASS_MESSAGE,
        )
        body = {
            "result": NOT_ALLOWED_HERE, "kind": "outpass", "scanType": scan_type, "message": NOT_ALLOWED_PASS_MESSAGE,
        }
        if req:
            body.update(_gate_scan_employee_payload(req))
        return body, 403
    if not req:
        message = "This Outpass request no longer exists."
        OutpassGateScan.objects.create(gate=gate, result=OutpassGateScan.RESULT_INVALID_QR, message=message)
        return {"result": "invalid_qr", "message": message}, 404

    if role == "outpass_return":
        return _resolve_return_scan(gate, req, payload.get("generatedAt"))
    return _resolve_exit_scan(gate, req)


@api_view(["POST"])
@require_gate_device
def gate_scan(request: Request) -> Response:
    data = request.data if hasattr(request.data, "get") else {}
    body, status = resolve_gate_scan(request.gate_device, data.get("qrToken"))
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
        .filter(
            gate=request.gate_device, result=OutpassGateScan.RESULT_SUCCESS,
            scan_type=OutpassGateScan.SCAN_TYPE_EXIT, scanned_at__gte=_today_start(),
        )
        .select_related("employee__department", "outpass_request")
        .defer("employee__photo_url")  # the list sends a link to the photo (photo_links), never the picture
        .order_by("-scanned_at")
    )
    total = qs.count()
    offset = (page - 1) * page_size
    rows = list(qs[offset:offset + page_size])
    photos = photo_links(s.employee_id for s in rows)
    return Response({
        "items": [
            {
                "id": s.id,
                "employeeName": f"{s.employee.first_name} {s.employee.last_name}" if s.employee else "—",
                "employeeCode": s.employee.employee_code if s.employee else None,
                "department": s.employee.department.name if s.employee and s.employee.department else None,
                "photoUrl": employee_photo_link(s.employee, photos),
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
