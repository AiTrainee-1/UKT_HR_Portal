"""
Reception -per-desk kiosk login onto the existing Visitor data (VisitorVisit,
outpass_visitor_views.py). Deliberately NOT a scanner: the visitor's own
phone scanning the existing permanent per-branch Visitor QR (GateQRCode) is
still the only way a visit gets recorded (see outpass_visitor_views.py's
module docstring) -this only gives Reception staff their own login and
dashboard onto that data, without needing an HR login, mirroring
gate_scanner_views.py's ReceptionDevice/GateDevice split at the model layer.
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

from .auth import get_hr_display_name, require_hr, require_reception_device
from .branch_scope import get_branch_scope, scope_to_branch
from .jwt_utils import sign_token
from .models import Branch, ReceptionDevice, VisitorVisit
from .outpass_visitor_views import _paginate_params, _range_bounds, _range_start, _visitor_visit_dict


def _reception_device_json(device: ReceptionDevice) -> dict:
    return {
        "id": device.id,
        "name": device.name,
        "branchId": device.branch_id,
        "branchName": device.branch.name if device.branch_id else None,
        "username": device.username,
        "isActive": device.is_active,
        "loginToken": device.login_token,
        "createdBy": device.created_by,
        "createdAt": device.created_at.isoformat(),
        "lastLoginAt": device.last_login_at.isoformat() if device.last_login_at else None,
    }


# ── Reception device management -HR portal ─────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def reception_devices(request: Request) -> Response:
    if request.method == "GET":
        qs = scope_to_branch(ReceptionDevice.objects.select_related("branch").order_by("name"), request)
        return Response([_reception_device_json(d) for d in qs])

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

    if ReceptionDevice.objects.filter(username__iexact=username).exists():
        return Response({"error": "That username is already taken"}, status=409)

    device = ReceptionDevice.objects.create(
        name=name,
        branch=branch,
        username=username,
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode(),
        login_token=uuid.uuid4().hex,
        created_by=get_hr_display_name(request),
    )
    return Response(_reception_device_json(device), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def reception_device_detail(request: Request, pk: int) -> Response:
    device = scope_to_branch(ReceptionDevice.objects.all(), request).filter(pk=pk).first()
    if not device:
        return Response({"error": "Reception desk not found"}, status=404)

    if request.method == "DELETE":
        device.delete()
        return Response(status=204)

    data = request.data
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return Response({"error": "name cannot be empty"}, status=400)
        device.name = name
    if "isActive" in data:
        device.is_active = bool(data.get("isActive"))
    if data.get("password"):
        password = data["password"]
        if len(password) < 6:
            return Response({"error": "Password must be at least 6 characters"}, status=400)
        device.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    device.save()
    return Response(_reception_device_json(device))


# ── Reception device auth -public ───────────────────────────────────────────

@api_view(["GET"])
def reception_login_info(request: Request, login_token: str) -> Response:
    device = ReceptionDevice.objects.filter(login_token=login_token).select_related("branch").first()
    if not device:
        return Response({"error": "This reception login link is not recognized."}, status=404)
    return Response({"deskName": device.name, "branchName": device.branch.name, "isActive": device.is_active})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def reception_login(request: Request) -> Response:
    request.throttle_scope = "login"
    username = (request.data.get("username") or "").strip()
    password = request.data.get("password") or ""

    device = ReceptionDevice.objects.filter(username__iexact=username).first()
    valid = bool(device) and device.is_active and bcrypt.checkpw(password.encode(), device.password_hash.encode())
    if not valid:
        return Response({"error": "Invalid username or password"}, status=401)

    token = sign_token(
        {"role": "reception_device", "deviceId": device.id, "deskName": device.name},
        expires_in=timedelta(hours=24),
    )
    device.last_login_at = timezone.now()
    device.save(update_fields=["last_login_at"])
    return Response({"token": token, "deviceId": device.id, "deskName": device.name})


# ── Reception dashboard -today's visitors, who they came to see ────────────

@api_view(["GET"])
@require_reception_device
def reception_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = VisitorVisit.objects.filter(branch_id=request.reception_device.branch_id)
    return Response({
        "today": qs.filter(visited_at__gte=today_start).count(),
        "thisWeek": qs.filter(visited_at__gte=week_start).count(),
        "thisMonth": qs.filter(visited_at__gte=month_start).count(),
    })


@api_view(["GET"])
@require_reception_device
def reception_visits(request: Request) -> Response:
    start = _range_start(request.query_params.get("range", "today"))
    page, page_size = _paginate_params(request)
    qs = (
        VisitorVisit.objects
        .filter(branch_id=request.reception_device.branch_id, visited_at__gte=start)
        .select_related("visitor", "branch", "meeting_employee__department", "meeting_employee__designation")
        .order_by("-visited_at")
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
