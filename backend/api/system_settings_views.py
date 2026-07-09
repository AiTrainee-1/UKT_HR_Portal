"""
System Settings — Biometric Devices & ID Card Template
========================================================
Extensible device configuration (no code changes needed to add a new
biometric device model) and a customizable employee ID card template,
both stored in the database and editable from Settings.
"""

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from datetime import time as time_type

from .auth import require_hr, require_auth
from .models import BiometricDevice, IdCardSettings, ProductionShiftConfig, ProductionShiftSegment


# ── Biometric Devices ───────────────────────────────────────────────────────

def _device_dict(d: BiometricDevice) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "deviceType": d.device_type,
        "host": d.host,
        "port": d.port,
        "hasApiKey": bool(d.api_key),
        "connectionConfig": d.connection_config or {},
        "isActive": d.is_active,
        "isDefault": d.is_default,
        "lastSyncedAt": d.last_synced_at.isoformat() if d.last_synced_at else None,
        "notes": d.notes,
        "createdAt": d.created_at.isoformat() if d.created_at else None,
    }


def _env_device_dict() -> dict | None:
    """The legacy .env device as a read-only virtual entry (id='env')."""
    from .biometric_sync import get_env_device
    env = get_env_device()
    if not env:
        return None
    return {
        "id": "env",
        "name": env["label"],
        "deviceType": "essl",
        "host": env["host"],
        "port": env["port"],
        "hasApiKey": False,
        "connectionConfig": {},
        "isActive": True,
        "isDefault": False,
        "isEnv": True,
        "lastSyncedAt": None,
        "notes": "Configured in backend/.env — edit the file to change it.",
        "createdAt": None,
    }


@api_view(["GET", "POST"])
@require_hr
def biometric_devices(request: Request) -> Response:
    if request.method == "GET":
        items = [_device_dict(d) for d in BiometricDevice.objects.all()]
        env_entry = _env_device_dict()
        # Show the .env device too (unless a Settings row already uses the same host)
        if env_entry and not any(i["host"] == env_entry["host"] for i in items):
            items.insert(0, env_entry)
        return Response(items)

    data = request.data
    name = (data.get("name") or "").strip()
    if not name:
        return Response({"error": "Device name is required"}, status=400)

    device = BiometricDevice.objects.create(
        name=name,
        device_type=data.get("deviceType", "aiface_mars"),
        host=data.get("host", ""),
        port=data.get("port") or None,
        api_key=data.get("apiKey", ""),
        connection_config=data.get("connectionConfig") or {},
        is_active=bool(data.get("isActive", True)),
        notes=data.get("notes"),
    )
    if data.get("isDefault"):
        BiometricDevice.objects.exclude(pk=device.pk).update(is_default=False)
        device.is_default = True
        device.save(update_fields=["is_default"])
    return Response(_device_dict(device), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def biometric_device_detail(request: Request, pk: int) -> Response:
    device = BiometricDevice.objects.filter(pk=pk).first()
    if not device:
        return Response({"error": "Device not found"}, status=404)

    if request.method == "GET":
        return Response(_device_dict(device))

    if request.method == "DELETE":
        device.delete()
        return Response(status=204)

    data = request.data
    field_map = {
        "name": "name", "deviceType": "device_type", "host": "host",
        "port": "port", "notes": "notes",
    }
    for json_key, attr in field_map.items():
        if json_key in data:
            setattr(device, attr, data[json_key])
    if "apiKey" in data and data["apiKey"]:
        device.api_key = data["apiKey"]
    if "connectionConfig" in data and isinstance(data["connectionConfig"], dict):
        device.connection_config = {**(device.connection_config or {}), **data["connectionConfig"]}
    if "isActive" in data:
        device.is_active = bool(data["isActive"])
    if data.get("isDefault"):
        BiometricDevice.objects.exclude(pk=device.pk).update(is_default=False)
        device.is_default = True
    elif "isDefault" in data:
        device.is_default = bool(data["isDefault"])
    device.save()
    return Response(_device_dict(device))


# ── ID Card Template Settings ───────────────────────────────────────────────

def _idcard_settings_dict(s: IdCardSettings) -> dict:
    return {
        "primaryColor": s.primary_color,
        "secondaryColor": s.secondary_color,
        "textColor": s.text_color,
        "fontFamily": s.font_family,
        "backgroundStyle": s.background_style,
        "logoPosition": s.logo_position,
        "cornerStyle": s.corner_style,
        "showQrOnBack": s.show_qr_on_back,
        "footerText": s.footer_text,
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_auth
def idcard_settings_view(request: Request) -> Response:
    s = IdCardSettings.get()
    if request.method == "GET":
        # Read-only template info — any authenticated user (mobile employees
        # need this to render their own ID card). Editing stays HR-only.
        return Response(_idcard_settings_dict(s))

    from .auth import is_hr
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    data = request.data
    field_map = {
        "primaryColor": "primary_color",
        "secondaryColor": "secondary_color",
        "textColor": "text_color",
        "fontFamily": "font_family",
        "backgroundStyle": "background_style",
        "logoPosition": "logo_position",
        "cornerStyle": "corner_style",
        "footerText": "footer_text",
    }
    for json_key, attr in field_map.items():
        if json_key in data:
            setattr(s, attr, data[json_key])
    if "showQrOnBack" in data:
        s.show_qr_on_back = bool(data["showQrOnBack"])
    s.save()
    return Response(_idcard_settings_dict(s))


# ── Production Shift Workflow (punch times + dynamic segments) ─────────────

def _parse_time(val):
    if not val:
        return None
    return time_type.fromisoformat(val[:5])


def _prod_segment_dict(s: ProductionShiftSegment) -> dict:
    return {
        "id": s.id,
        "label": s.label,
        "startTime": s.start_time.strftime("%H:%M") if s.start_time else None,
        "endTime": s.end_time.strftime("%H:%M") if s.end_time else None,
        "shiftValue": float(s.shift_value),
        "order": s.order,
        "isActive": s.is_active,
    }


def _prod_config_dict(c: ProductionShiftConfig) -> dict:
    return {
        "punch1Time": c.punch1_time.strftime("%H:%M") if c.punch1_time else None,
        "punch2Time": c.punch2_time.strftime("%H:%M") if c.punch2_time else None,
        "punch3Time": c.punch3_time.strftime("%H:%M") if c.punch3_time else None,
        "punch4Time": c.punch4_time.strftime("%H:%M") if c.punch4_time else None,
        "graceMinutes": c.grace_minutes,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_hr
def production_shift_config_view(request: Request) -> Response:
    c = ProductionShiftConfig.get()
    if request.method == "GET":
        return Response({
            **_prod_config_dict(c),
            "segments": [_prod_segment_dict(s) for s in ProductionShiftSegment.objects.all()],
        })

    data = request.data
    field_map = {
        "punch1Time": "punch1_time", "punch2Time": "punch2_time",
        "punch3Time": "punch3_time", "punch4Time": "punch4_time",
    }
    for json_key, attr in field_map.items():
        if json_key in data and data[json_key]:
            setattr(c, attr, _parse_time(data[json_key]))
    if "graceMinutes" in data:
        c.grace_minutes = int(data["graceMinutes"])
    c.save()
    return Response(_prod_config_dict(c))


@api_view(["GET", "POST"])
@require_hr
def production_shift_segments(request: Request) -> Response:
    if request.method == "GET":
        return Response([_prod_segment_dict(s) for s in ProductionShiftSegment.objects.all()])

    data = request.data
    label = (data.get("label") or "").strip()
    start = _parse_time(data.get("startTime"))
    end = _parse_time(data.get("endTime"))
    if not label or not start or not end or data.get("shiftValue") is None:
        return Response({"error": "label, startTime, endTime and shiftValue are required"}, status=400)

    seg = ProductionShiftSegment.objects.create(
        label=label, start_time=start, end_time=end,
        shift_value=data["shiftValue"], order=data.get("order", 0),
        is_active=bool(data.get("isActive", True)),
    )
    return Response(_prod_segment_dict(seg), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def production_shift_segment_detail(request: Request, pk: int) -> Response:
    seg = ProductionShiftSegment.objects.filter(pk=pk).first()
    if not seg:
        return Response({"error": "Segment not found"}, status=404)

    if request.method == "DELETE":
        seg.delete()
        return Response(status=204)

    data = request.data
    if "label" in data:
        seg.label = data["label"]
    if "startTime" in data and data["startTime"]:
        seg.start_time = _parse_time(data["startTime"])
    if "endTime" in data and data["endTime"]:
        seg.end_time = _parse_time(data["endTime"])
    if "shiftValue" in data:
        seg.shift_value = data["shiftValue"]
    if "order" in data:
        seg.order = data["order"]
    if "isActive" in data:
        seg.is_active = bool(data["isActive"])
    seg.save()
    return Response(_prod_segment_dict(seg))
