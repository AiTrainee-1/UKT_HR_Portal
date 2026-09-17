"""
Tea Break -a permanent, no-approval, per-EMPLOYEE QR (unlike OutpassRequest's
per-request, HOD/HR-approved flow) that simply toggles an OUT/IN timing
record each time it's scanned at any active GateDevice. Reuses Gate
Scanner's existing login/device infrastructure entirely -no separate device
or login concept, per explicit product decision: the same gate logins that
scan an Outpass exit/return QR also scan a Tea Break QR, routed by
gate_scanner_views.py::resolve_gate_scan's role dispatch, which calls
resolve_tea_break_scan below.

Deliberately has no OutpassGateScan-style audit-of-denied-attempts table:
there's nothing to deny here (no approval, no expiry, no single-use token) -
every recognized tea_break-role token just toggles OUT/IN, so TeaBreakLog
itself is already the complete record.
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .jwt_utils import sign_token
from .models import Employee, GateDevice, TeaBreakLog, TeaBreakRule
from .outpass_visitor_views import _paginate_params, _range_bounds, _range_start

# How long an OUT scan stays eligible to be closed by the NEXT scan as an IN
# -guards against a long-forgotten open row (employee never returned, went
# home for the day) silently swallowing a brand new OUT scan as if it were
# that stale row's return. Generous enough to cover a full shift, not unbounded.
STALE_OPEN_CUTOFF = timedelta(hours=12)

# Fixed, NOT the HR-configurable TeaBreakRule.allowed_minutes -this is just
# "how long can an open scan plausibly still be mid-break before we call it
# a no-return", per explicit spec ("time exceeds 60 minutes").
NOT_RETURNED_MINUTES = 60


def _employee_json(emp: Employee) -> dict:
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "photoUrl": emp.photo_url,
    }


def _log_json(log: TeaBreakLog, allowed_minutes: int, now) -> dict:
    if log.in_at:
        taken_minutes = round((log.in_at - log.out_at).total_seconds() / 60)
        remark = "overtime" if taken_minutes > allowed_minutes else "on_time"
    else:
        taken_minutes = round((now - log.out_at).total_seconds() / 60)
        remark = "not_returned" if taken_minutes > NOT_RETURNED_MINUTES else "in_progress"
    return {
        "id": log.id,
        "employee": _employee_json(log.employee),
        "outGateName": log.out_gate.name if log.out_gate_id else None,
        "outAt": log.out_at.isoformat(),
        "inGateName": log.in_gate.name if log.in_gate_id else None,
        "inAt": log.in_at.isoformat() if log.in_at else None,
        "takenMinutes": taken_minutes,
        "remark": remark,
    }


# ── QR verification + toggle -gate kiosk ─────────────────────────────────
# Dispatched from gate_scanner_views.py::resolve_gate_scan, not called
# directly from a view of its own -there is only ever one scan endpoint
# (POST /api/gate-devices/scan), shared across every QR kind.

def resolve_tea_break_scan(gate: GateDevice, employee: Employee) -> tuple[dict, int]:
    now = timezone.now()
    open_log = (
        TeaBreakLog.objects
        .filter(employee=employee, in_at__isnull=True, out_at__gte=now - STALE_OPEN_CUTOFF)
        .order_by("-out_at")
        .first()
    )
    if open_log:
        open_log.in_gate = gate
        open_log.in_at = now
        open_log.save(update_fields=["in_gate", "in_at"])
        taken_minutes = round((now - open_log.out_at).total_seconds() / 60)
        message = f"Tea break ended -{taken_minutes} min, via {gate.name}"
        return {
            "result": "success", "action": "in", "message": message,
            "takenMinutes": taken_minutes, "employee": _employee_json(employee),
        }, 200

    TeaBreakLog.objects.create(employee=employee, out_gate=gate, out_at=now)
    message = f"Tea break started via {gate.name}"
    return {"result": "success", "action": "out", "message": message, "employee": _employee_json(employee)}, 200


# ── Employee-facing: permanent QR + own status -mobile/web apps ────────────

@api_view(["GET"])
@require_auth
def tea_break_qr_token(request: Request) -> Response:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return Response({"error": "Employee login required"}, status=403)
    # Long-lived and NOT single-use/invalidated-on-regenerate like the
    # Outpass return QR -this one just identifies the employee, and is meant
    # to be scanned indefinitely across many separate tea breaks.
    token = sign_token({"role": "tea_break", "employeeId": emp_id}, expires_in=timedelta(days=3650))
    return Response({"qrToken": token})


@api_view(["GET"])
@require_auth
def tea_break_my_status(request: Request) -> Response:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return Response({"error": "Employee login required"}, status=403)
    now = timezone.now()
    rule = TeaBreakRule.get()
    logs = list(
        TeaBreakLog.objects.filter(employee_id=emp_id)
        .select_related("out_gate", "in_gate", "employee__department")
        .order_by("-out_at")[:10]
    )
    open_log = next((log for log in logs if not log.in_at), None)
    return Response({
        "onBreak": bool(open_log),
        "outAt": open_log.out_at.isoformat() if open_log else None,
        "allowedMinutes": rule.allowed_minutes,
        "recent": [_log_json(log, rule.allowed_minutes, now) for log in logs],
    })


# ── HR dashboard ─────────────────────────────────────────────────────────

@api_view(["GET", "PUT"])
@require_hr
def tea_break_rule(request: Request) -> Response:
    rule = TeaBreakRule.get()
    if request.method == "PUT":
        try:
            minutes = int(request.data.get("allowedMinutes"))
        except (TypeError, ValueError):
            return Response({"error": "allowedMinutes must be a whole number"}, status=400)
        if minutes < 1:
            return Response({"error": "allowedMinutes must be at least 1"}, status=400)
        rule.allowed_minutes = minutes
        rule.save(update_fields=["allowed_minutes", "updated_at"])
    return Response({"allowedMinutes": rule.allowed_minutes, "updatedAt": rule.updated_at.isoformat()})


@api_view(["GET"])
@require_hr
def tea_break_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = scope_to_branch(TeaBreakLog.objects, request, field="employee__branch_id")
    return Response({
        "today": qs.filter(out_at__gte=today_start).count(),
        "thisWeek": qs.filter(out_at__gte=week_start).count(),
        "thisMonth": qs.filter(out_at__gte=month_start).count(),
    })


@api_view(["GET"])
@require_hr
def tea_break_records(request: Request) -> Response:
    """Computed remarks (overtime/not_returned/etc) can't be filtered at the
    SQL level -evaluated per-row in Python against "now" and the live
    TeaBreakRule, then filtered/paginated in Python. Fine at this feature's
    scale (one branch's tea-break volume for a day/week/month), matching the
    same reasoning already used for _find_employee_by_phone's full scan in
    outpass_visitor_views.py."""
    start = _range_start(request.query_params.get("range", "today"))
    page, page_size = _paginate_params(request)
    filter_key = request.query_params.get("filter")  # "overtime" | "not_returned" | None

    now = timezone.now()
    rule = TeaBreakRule.get()
    qs = (
        scope_to_branch(TeaBreakLog.objects, request, field="employee__branch_id")
        .filter(out_at__gte=start)
        .select_related("employee__department", "out_gate", "in_gate")
        .order_by("-out_at")
    )
    rows = [_log_json(log, rule.allowed_minutes, now) for log in qs]
    if filter_key in ("overtime", "not_returned"):
        rows = [r for r in rows if r["remark"] == filter_key]

    total = len(rows)
    offset = (page - 1) * page_size
    return Response({
        "items": rows[offset:offset + page_size],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })
