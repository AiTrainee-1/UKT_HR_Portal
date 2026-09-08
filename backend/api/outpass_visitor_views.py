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

from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .models import Branch, Employee, GateQRCode, OutpassRecord, Visitor, VisitorVisit


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
    OutpassRecord.objects.create(
        branch=qr.branch, employee=employee,
        employee_name=name, employee_code=employee_code, destination=destination,
    )
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
    }


@api_view(["GET"])
@require_hr
def visitor_records(request: Request) -> Response:
    start = _range_start(request.query_params.get("range", "month"))
    page, page_size = _paginate_params(request)
    qs = (
        scope_to_branch(VisitorVisit.objects, request)
        .filter(visited_at__gte=start)
        .select_related("visitor", "branch")
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
    if not name or not phone or not whom_to_meet or not purpose:
        return Response(
            {"error": "Name, phone, whom you're meeting and purpose are all required."}, status=400
        )

    if Visitor.objects.filter(phone=phone).exists():
        return Response(
            {"error": 'A visitor with this phone number already exists. Use "Already Visited" instead.'},
            status=409,
        )

    visitor = Visitor.objects.create(name=name, phone=phone, aadhaar_number=aadhaar or None)
    VisitorVisit.objects.create(
        visitor=visitor, branch=qr.branch, why_came=why_came or None,
        whom_to_meet=whom_to_meet, purpose=purpose,
    )
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

    visitor = Visitor.objects.filter(phone=phone).first()
    if not visitor:
        return Response({"error": "No visitor found with this phone number."}, status=404)
    if not whom_to_meet or not purpose:
        return Response({"error": "Whom you're meeting and purpose are both required."}, status=400)

    VisitorVisit.objects.create(visitor=visitor, branch=qr.branch, whom_to_meet=whom_to_meet, purpose=purpose)
    return Response({"submitted": True}, status=201)
