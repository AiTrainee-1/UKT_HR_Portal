"""
Biometric Device Status page endpoints (Attendance → Biometric Device Status).

  GET  /api/attendance/biometric-status                  the whole picture: server, summary, every device
  POST /api/attendance/biometric-status/check            run a connection check now ({"deviceIds": [..]} or all)
  GET  /api/attendance/biometric-status/<id>/history     a device's recent connection checks

They sit under /api/attendance/, so the existing permission middleware applies as it does to the rest of the
Attendance page: a GET needs View on Attendance, the check (a POST) needs Edit. Reading the status never contacts a
device; only the check does, and a check only connects, reads a few settings and disconnects (see device_probe.py).
"""

from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr
from .device_probe import CheckBusy
from .device_status import build_status, probe_history, run_check
from .models import BiometricDevice


@api_view(["GET"])
@require_hr
def biometric_status(request: Request) -> Response:
    return Response(build_status(request))


@api_view(["POST"])
@require_hr
def biometric_status_check(request: Request) -> Response:
    raw = request.data.get("deviceIds") if hasattr(request.data, "get") else None
    ids: list[int] | None = None
    if raw not in (None, ""):
        if not isinstance(raw, list):
            return Response({"error": "deviceIds must be a list of device ids"}, status=400)
        try:
            ids = [int(x) for x in raw]
        except (TypeError, ValueError):
            return Response({"error": "deviceIds must be a list of device ids"}, status=400)
        known = set(BiometricDevice.objects.filter(pk__in=ids).values_list("pk", flat=True))
        if len(ids) > 50 or not set(ids) <= known:
            return Response({"error": "One or more devices were not found."}, status=404)
    try:
        results = run_check(ids)
    except CheckBusy:
        return Response({"error": "A connection check is already running. Wait for it to finish."}, status=409)

    reached = sum(1 for r in results.values() if r["status"] == "reachable")
    log_action(
        request,
        "check",
        "attendance",
        description=f"Biometric device connection check: {len(results)} device(s), {reached} reachable from this server",
    )
    return Response({"ranDeviceIds": sorted(results), "status": build_status(request)})


@api_view(["GET"])
@require_hr
def biometric_status_history(request: Request, pk: int) -> Response:
    device = BiometricDevice.objects.filter(pk=pk).first()
    if device is None:
        return Response({"error": "Device not found"}, status=404)
    return Response({"deviceId": device.id, "checks": probe_history(device)})
