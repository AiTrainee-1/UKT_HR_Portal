"""
Outpass / Visitors -pure gate data-collection, no attendance/payroll/leave
link whatsoever. Two independent flows sharing one shape:

  HR portal (this app's own login, @require_hr, branch-scoped via
  branch_scope.py exactly like attendance_views.py):
    - GET  <kind>/qr        get-or-create the permanent per-branch QR token
    - GET  <kind>/summary   today/week/month KPI counts
    - GET  <kind>/records   filtered list

  Public gate form (no auth at all -reached only via the QR's URL, same
  AllowAny-by-default shape as verify_employee in growth_views.py and
  _applicants_submit in views.py):
    - GET  <kind>/gate/<token>            resolve token -> branch name
    - POST outpass/gate/<token>/submit    outpass submission
    - POST visitor/gate/<token>/check-phone / new / repeat   visitor flow

"Today/week/month" boundaries are computed in the factory's own Asia/Kolkata
calendar (clock.py's FACTORY_TZ), not in the server's UTC clock -matching
attendance's own reasoning (clock.py's module docstring) rather than
audit_logs_stats' simpler UTC-midnight boundary, since a gate submission at
say 10:30pm IST should count as "today" even though it's already tomorrow in
UTC.
"""
from __future__ import annotations

import smtplib
import ssl
from datetime import timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from django.utils import timezone
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .models import Branch, Employee, GateQRCode, OutpassRecord, Visitor, VisitorVisit
from .user_settings import settings_for_employee


# ── Shared helpers ───────────────────────────────────────────────────────────

def _range_bounds():
    """(today_start, week_start, month_start), all in Asia/Kolkata."""
    now_ist = timezone.now().astimezone(FACTORY_TZ)
    today_start = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    month_start = today_start.replace(day=1)
    return today_start, week_start, month_start


def _range_start(range_key: str):
    today_start, week_start, month_start = _range_bounds()
    if range_key == "week":
        return week_start
    if range_key == "month":
        return month_start
    return today_start


DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def _paginate_params(request: Request) -> tuple[int, int]:
    try:
        page = int(request.query_params.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = int(request.query_params.get("pageSize", DEFAULT_PAGE_SIZE))
    except (TypeError, ValueError):
        page_size = DEFAULT_PAGE_SIZE
    return max(1, page), max(1, min(page_size, MAX_PAGE_SIZE))


def _resolve_branch_for_qr(request: Request) -> Branch | None:
    """A branch-scoped HR user always gets their own branch, ignoring any
    query param -only an unscoped user (super admin / branch-less role) may
    pick a branch via ?branchId=, since letting a scoped user override this
    would leak another branch's permanent QR token to them."""
    branch_id = get_branch_scope(request)
    if branch_id is None:
        branch_id = request.query_params.get("branchId")
        if not branch_id:
            return None
    return Branch.objects.filter(id=branch_id).first()


def _gate_qr_or_none(token: str, kind: str) -> GateQRCode | None:
    return GateQRCode.objects.filter(token=token, kind=kind).select_related("branch").first()


def _create_outpass_record_for(employee: Employee, destination: str, source: str) -> OutpassRecord:
    """Shared with outpass_request_views.py (manual/HR/HOD-approved requests)
    and geo_attendance_views.py::_create_outpass_from_on_duty -every path
    that produces an Outpass ends up creating exactly this same row shape,
    so the HR Outpass page (outpass_qr/summary/records above) needs no
    changes at all to show requests approved outside the QR flow."""
    return OutpassRecord.objects.create(
        branch=employee.branch,
        employee=employee,
        employee_name=f"{employee.first_name} {employee.last_name}",
        employee_code=employee.employee_code,
        destination=destination,
        source=source,
    )


_QR_NOT_FOUND = Response({"error": "This QR code is not recognized."}, status=404)


def _throttled(request: Request) -> None:
    request.throttle_scope = "gate_submit"


def _digits_only(raw: str | None) -> str:
    return "".join(ch for ch in (raw or "") if ch.isdigit())


def _find_employee_by_phone(raw_phone: str) -> Employee | None:
    """Employee.phone is free-text (no formatting guarantee -see
    whatsapp_service.normalize_phone's own docstring), so an exact match is
    tried first (fast, cheap) and a digits-only comparison is the fallback
    for anything typed with different spacing/punctuation/country-code
    presence. Matches on the LAST 10 digits so a visitor typing a number
    with or without a country code both still resolve to the same person."""
    raw_phone = (raw_phone or "").strip()
    if not raw_phone:
        return None

    exact = Employee.objects.filter(phone=raw_phone).first()
    if exact:
        return exact

    digits = _digits_only(raw_phone)
    if len(digits) < 7:
        return None
    tail = digits[-10:]
    for emp in Employee.objects.exclude(phone__isnull=True).exclude(phone="").only("id", "phone"):
        if _digits_only(emp.phone)[-10:] == tail:
            return Employee.objects.select_related("department", "designation").get(pk=emp.pk)
    return None


def _employee_contact_json(emp: Employee) -> dict:
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "phone": emp.phone,
        "email": emp.email,
        "photoUrl": emp.photo_url,
    }


# ── Visitor -> host employee notification ───────────────────────────────────
# Best-effort on both channels -a visitor's check-in must always succeed
# regardless of whether their host can be reached right now, exactly like
# whatsapp_service.send_document never raises for an "expected" failure.
# Nothing here is ever surfaced back to the visitor's own form; only
# notified_email_at/notified_whatsapp_at on VisitorVisit (read from the
# Reception dashboard) and the WhatsAppMessageLog audit trail reflect it.

def _send_visitor_email(visit: VisitorVisit, emp: Employee) -> None:
    if not emp.email:
        return
    ps = settings_for_employee(emp)
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return

    visitor = visit.visitor
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    company_name = ps.company_name or ps.slip_company_name or "UKTextiles"
    subject = f"You have a visitor: {visitor.name}"
    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a2e">
      <div style="background:#0E4B3A;padding:20px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:18px">{company_name.upper()}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">Visitor Arrival Notice</p>
      </div>
      <div style="background:#ffffff;padding:30px;border:1px solid #d8e5df;border-top:none">
        <p>Dear <strong>{emp_name}</strong>,</p>
        <p><strong>{visitor.name}</strong> has arrived at reception to meet you.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
          <tr><td style="padding:4px 0;color:#666">Phone</td><td style="padding:4px 0"><strong>{visitor.phone}</strong></td></tr>
          <tr><td style="padding:4px 0;color:#666">Purpose</td><td style="padding:4px 0"><strong>{visit.purpose}</strong></td></tr>
        </table>
        <p style="color:#888;font-size:12px">This is a system-generated email from the Reception desk.</p>
      </div>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"] = emp.email
    msg.attach(MIMEText(html_body, "html"))

    try:
        context = ssl.create_default_context()
        if ps.smtp_port == 465:
            with smtplib.SMTP_SSL(ps.smtp_host, ps.smtp_port, context=context) as server:
                server.login(ps.smtp_username, ps.smtp_password)
                server.sendmail(ps.smtp_from_email or ps.smtp_username, emp.email, msg.as_string())
        else:
            with smtplib.SMTP(ps.smtp_host, ps.smtp_port, timeout=15) as server:
                server.ehlo()
                server.starttls(context=context)
                server.login(ps.smtp_username, ps.smtp_password)
                server.sendmail(ps.smtp_from_email or ps.smtp_username, emp.email, msg.as_string())
    except Exception:
        return

    visit.notified_email_at = timezone.now()
    visit.save(update_fields=["notified_email_at"])


def _send_visitor_whatsapp(visit: VisitorVisit, emp: Employee) -> None:
    """The visitor message (name, contact, purpose, whom, department, date and time) plus the
    visitor's contact card to tap and call. Delivered in the background so the visitor's check-in
    never waits on WhatsApp; the Reception "notified" time is stamped once it is really delivered."""
    from . import whatsapp_notifications

    def mark_notified(_log) -> None:
        visit.notified_whatsapp_at = timezone.now()
        visit.save(update_fields=["notified_whatsapp_at"])

    whatsapp_notifications.notify_visitor_arrival(visit, emp, on_sent=mark_notified)


def _notify_employee_of_visitor(visit: VisitorVisit) -> None:
    emp = visit.meeting_employee
    if not emp:
        return
    try:
        _send_visitor_email(visit, emp)
    except Exception:
        pass
    try:
        _send_visitor_whatsapp(visit, emp)
    except Exception:
        pass


# ── Outpass -HR portal ───────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def outpass_qr(request: Request) -> Response:
    branch = _resolve_branch_for_qr(request)
    if branch is None:
        return Response({"error": "No branch selected."}, status=400)
    qr = GateQRCode.get_or_create_for(branch, GateQRCode.KIND_OUTPASS)
    return Response({"token": qr.token, "branchId": branch.id, "branchName": branch.name})


@api_view(["GET"])
@require_hr
def outpass_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = scope_to_branch(OutpassRecord.objects, request)
    return Response({
        "today": qs.filter(submitted_at__gte=today_start).count(),
        "thisWeek": qs.filter(submitted_at__gte=week_start).count(),
        "thisMonth": qs.filter(submitted_at__gte=month_start).count(),
    })


@api_view(["GET"])
@require_hr
def outpass_records(request: Request) -> Response:
    start = _range_start(request.query_params.get("range", "month"))
    page, page_size = _paginate_params(request)
    qs = scope_to_branch(OutpassRecord.objects, request).filter(submitted_at__gte=start).select_related("branch")
    total = qs.count()
    offset = (page - 1) * page_size
    rows = qs[offset:offset + page_size]
    return Response({
        "items": [
            {
                "id": r.id,
                "employeeName": r.employee_name,
                "employeeCode": r.employee_code,
                "destination": r.destination,
                "branchName": r.branch.name if r.branch else None,
                "submittedAt": r.submitted_at.isoformat(),
                "source": r.source,
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


# ── Outpass -public gate form ────────────────────────────────────────────────

@api_view(["GET"])
def outpass_gate_info(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_OUTPASS)
    if not qr:
        return _QR_NOT_FOUND
    return Response({"branchName": qr.branch.name})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def outpass_gate_submit(request: Request, token: str) -> Response:
    _throttled(request)
    qr = _gate_qr_or_none(token, GateQRCode.KIND_OUTPASS)
    if not qr:
        return _QR_NOT_FOUND

    name = (request.data.get("name") or "").strip()
    employee_code = (request.data.get("employeeCode") or "").strip()
    destination = (request.data.get("destination") or "").strip()
    if not name or not employee_code or not destination:
        return Response({"error": "Name, employee code and destination are all required."}, status=400)

    employee = Employee.objects.filter(employee_code__iexact=employee_code).first()
    record = OutpassRecord.objects.create(
        branch=qr.branch, employee=employee,
        employee_name=name, employee_code=employee_code, destination=destination,
    )
    if employee is not None:
        from . import whatsapp_notifications

        whatsapp_notifications.notify_gate_record(record)
    return Response({"submitted": True}, status=201)


# ── Visitors -HR portal ──────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def visitor_qr(request: Request) -> Response:
    branch = _resolve_branch_for_qr(request)
    if branch is None:
        return Response({"error": "No branch selected."}, status=400)
    qr = GateQRCode.get_or_create_for(branch, GateQRCode.KIND_VISITOR)
    return Response({"token": qr.token, "branchId": branch.id, "branchName": branch.name})


@api_view(["GET"])
@require_hr
def visitor_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = scope_to_branch(VisitorVisit.objects, request)
    return Response({
        "today": qs.filter(visited_at__gte=today_start).count(),
        "thisWeek": qs.filter(visited_at__gte=week_start).count(),
        "thisMonth": qs.filter(visited_at__gte=month_start).count(),
    })


def _visitor_visit_dict(v: VisitorVisit) -> dict:
    # Full Aadhaar is included here (not just the last-4 preview) -this
    # endpoint is already @require_hr + RBAC-gated on the "outpass_visitors"
    # module (see permission_registry.py), so whoever can load this table at
    # all is already trusted with the data; the UI just defaults to masked
    # so it isn't left on-screen for anyone glancing at a shared monitor.
    # Same trust level applies to reception_views.py's @require_reception_device
    # endpoint, which calls this same function.
    aadhaar = v.visitor.aadhaar_number or ""
    return {
        "id": v.id,
        "name": v.visitor.name,
        "phone": v.visitor.phone,
        "aadhaar": aadhaar or None,
        "aadhaarLast4": aadhaar[-4:] if len(aadhaar) >= 4 else None,
        "whyCame": v.why_came,
        "whomToMeet": v.whom_to_meet,
        "purpose": v.purpose,
        "branchName": v.branch.name if v.branch else None,
        "visitedAt": v.visited_at.isoformat(),
        "meetingEmployee": _employee_contact_json(v.meeting_employee) if v.meeting_employee_id else None,
        "notifiedEmailAt": v.notified_email_at.isoformat() if v.notified_email_at else None,
        "notifiedWhatsappAt": v.notified_whatsapp_at.isoformat() if v.notified_whatsapp_at else None,
    }


@api_view(["GET"])
@require_hr
def visitor_records(request: Request) -> Response:
    start = _range_start(request.query_params.get("range", "month"))
    page, page_size = _paginate_params(request)
    qs = (
        scope_to_branch(VisitorVisit.objects, request)
        .filter(visited_at__gte=start)
        .select_related("visitor", "branch", "meeting_employee__department", "meeting_employee__designation")
    )
    total = qs.count()
    offset = (page - 1) * page_size
    rows = qs[offset:offset + page_size]
    return Response({
        "items": [_visitor_visit_dict(v) for v in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


# ── Visitors -public gate form ───────────────────────────────────────────────

@api_view(["GET"])
def visitor_gate_info(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND
    return Response({"branchName": qr.branch.name})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def visitor_check_phone(request: Request, token: str) -> Response:
    _throttled(request)
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    if not phone:
        return Response({"error": "Phone number is required."}, status=400)

    visitor = Visitor.objects.filter(phone=phone).first()
    if not visitor:
        return Response({"found": False})
    return Response({"found": True, "name": visitor.name})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def visitor_check_employee_phone(request: Request, token: str) -> Response:
    """"Are you meeting a specific employee?" -> Yes step: the visitor (or
    receptionist filling in on their behalf) enters the employee's name and
    phone number, and this resolves the actual Employee record by matching
    that phone against Employee.phone (see _find_employee_by_phone), so the
    form can show "is this who you mean?" before the visit is recorded and
    an arrival notification goes out. Never blocks check-in: if nothing
    matches, the caller falls back to the plain free-text whomToMeet field,
    exactly like before this feature existed."""
    _throttled(request)
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    if not phone:
        return Response({"error": "Phone number is required."}, status=400)

    employee = _find_employee_by_phone(phone)
    if not employee:
        return Response({"found": False})
    return Response({"found": True, "employee": _employee_contact_json(employee)})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def visitor_gate_new(request: Request, token: str) -> Response:
    _throttled(request)
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    name = (request.data.get("name") or "").strip()
    phone = (request.data.get("phone") or "").strip()
    aadhaar = (request.data.get("aadhaarNumber") or "").strip()
    why_came = (request.data.get("whyCame") or "").strip()
    whom_to_meet = (request.data.get("whomToMeet") or "").strip()
    purpose = (request.data.get("purpose") or "").strip()
    meeting_employee_id = request.data.get("meetingEmployeeId")
    if not name or not phone or not whom_to_meet or not purpose:
        return Response(
            {"error": "Name, phone, whom you're meeting and purpose are all required."}, status=400
        )

    if Visitor.objects.filter(phone=phone).exists():
        return Response(
            {"error": 'A visitor with this phone number already exists. Use "Already Visited" instead.'},
            status=409,
        )

    meeting_employee = Employee.objects.filter(pk=meeting_employee_id).first() if meeting_employee_id else None

    visitor = Visitor.objects.create(name=name, phone=phone, aadhaar_number=aadhaar or None)
    visit = VisitorVisit.objects.create(
        visitor=visitor, branch=qr.branch, why_came=why_came or None,
        whom_to_meet=whom_to_meet, purpose=purpose, meeting_employee=meeting_employee,
    )
    _notify_employee_of_visitor(visit)
    return Response({"submitted": True}, status=201)


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def visitor_gate_repeat(request: Request, token: str) -> Response:
    _throttled(request)
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    whom_to_meet = (request.data.get("whomToMeet") or "").strip()
    purpose = (request.data.get("purpose") or "").strip()
    meeting_employee_id = request.data.get("meetingEmployeeId")

    visitor = Visitor.objects.filter(phone=phone).first()
    if not visitor:
        return Response({"error": "No visitor found with this phone number."}, status=404)
    if not whom_to_meet or not purpose:
        return Response({"error": "Whom you're meeting and purpose are both required."}, status=400)

    meeting_employee = Employee.objects.filter(pk=meeting_employee_id).first() if meeting_employee_id else None

    visit = VisitorVisit.objects.create(
        visitor=visitor, branch=qr.branch, whom_to_meet=whom_to_meet, purpose=purpose,
        meeting_employee=meeting_employee,
    )
    _notify_employee_of_visitor(visit)
    return Response({"submitted": True}, status=201)
