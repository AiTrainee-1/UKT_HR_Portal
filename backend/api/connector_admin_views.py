"""
Managing Site Connectors from the HR portal (Attendance → Device Control → Site connectors), and following an operation.

  GET    /api/attendance/device-control/connectors                 every connector, with how it and its devices are
  POST   /api/attendance/device-control/connectors                 add a connector: returns its pairing code, once
  PATCH  /api/attendance/device-control/connectors/<id>            rename, switch on or off, change how it reads punches
  POST   /api/attendance/device-control/connectors/<id>/pairing    a new pairing code (to install it again or on another computer)
  DELETE /api/attendance/device-control/connectors/<id>            remove it; its devices go back to being connected directly
  GET    /api/attendance/device-control/operations/<id>            a change or read waiting on a connector: poll until it is done

They sit under /api/attendance/, so the Attendance permission decides who may look (View) and what the middleware lets a
write through (Edit). Anything that changes who may reach the devices (adding, switching, re-pairing or removing a
connector) also needs Edit on Settings, as adding a device does.
"""

from __future__ import annotations

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import device_remote
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope
from .connector_auth import new_pairing_code, pairing_digest, pairing_expiry
from .device_directory import can_edit_module
from .models import BiometricConnectorJob, BiometricDevice, BiometricDeviceOperation, BiometricSiteConnector

MAX_NAME = 80


def _bad(message: str, status: int = 400) -> Response:
    return Response({"error": message}, status=status)


def _int_in(raw, low: int, high: int):
    if isinstance(raw, bool):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if low <= value <= high else None


def _state(c: BiometricSiteConnector, now) -> str:
    if not c.is_active:
        return "off"
    if not c.token_hash:
        return "unpaired"
    return "online" if device_remote.connector_online(c, now) else "offline"


def serialize_connector(c: BiometricSiteConnector, now=None, mask: bool = False) -> dict:
    """One connector for the page. `mask` is for a branch-limited caller, who may see that a connector is there and how it is
    but not where it is (its computer, its address, or its devices' addresses): it serves other branches' devices too."""
    now = now or timezone.now()
    status = c.status or {}
    sync = status.get("sync") or {}
    devices = []
    for d in BiometricDevice.objects.filter(connector=c).order_by("name"):
        probe = device_remote.remote_probe(d, now) if d.is_active else None
        devices.append(
            {
                "id": d.pk,
                "name": d.name,
                "host": "" if mask else d.host,
                "port": 0 if mask else (d.port or 4370),
                "isActive": d.is_active,
                "connected": bool(probe and probe["ok"]),
                "code": probe["code"] if probe else "disabled",
                "reason": probe["error"] if probe else "Switched off in Settings → Devices.",
                "sync": sync.get(str(d.pk)),
            }
        )
    return {
        "id": c.pk,
        "name": c.name,
        "notes": c.notes,
        "isActive": c.is_active,
        "state": _state(c, now),
        "paired": bool(c.token_hash),
        "pairedAt": c.paired_at.isoformat() if c.paired_at else None,
        "pairingPending": bool(c.pairing_hash and c.pairing_expires_at and c.pairing_expires_at > now),
        "pairingExpiresAt": c.pairing_expires_at.isoformat() if c.pairing_hash and c.pairing_expires_at else None,
        "lastSeenAt": c.last_seen_at.isoformat() if c.last_seen_at else None,
        "lastRemoteIp": None if mask else (c.last_remote_ip or None),
        "version": c.version or None,
        "hostname": None if mask else (c.hostname or None),
        "os": None if mask else (c.os_info or None),
        "punchSyncMinutes": c.punch_sync_minutes,
        "punchSyncDays": c.punch_sync_days,
        "uptimeSeconds": status.get("uptimeSeconds"),
        "outbox": status.get("outbox"),
        "openJobs": BiometricConnectorJob.objects.filter(
            connector=c, status__in=BiometricConnectorJob.OPEN_STATUSES
        ).count(),
        "devices": devices,
        "createdBy": c.created_by,
        "createdAt": c.created_at.isoformat(),
    }


def _may_manage(request: Request) -> bool:
    # a connector serves devices of every branch: changing one is for someone who is not limited to a branch
    return get_branch_scope(request) is None and can_edit_module(request, "settings")


def _forbidden() -> Response:
    return _bad(
        "Your role cannot change Site Connectors (it needs Edit access to Settings, and no branch limit: a connector serves every branch).",
        403,
    )


def _issue_pairing(connector: BiometricSiteConnector) -> tuple[str, object]:
    code = new_pairing_code()
    expires = pairing_expiry()
    connector.pairing_hash = pairing_digest(code)
    connector.pairing_expires_at = expires
    return code, expires


@api_view(["GET", "POST"])
@require_hr
def device_control_connectors(request: Request) -> Response:
    if request.method == "GET":
        now = timezone.now()
        mask = get_branch_scope(request) is not None
        return Response(
            {"connectors": [serialize_connector(c, now, mask) for c in BiometricSiteConnector.objects.all()]}
        )

    if not _may_manage(request):
        return _forbidden()
    name = " ".join(str(request.data.get("name") or "").split())
    if not name:
        return _bad("Give the connector a name, such as the site it is installed at.")
    if len(name) > MAX_NAME:
        return _bad(f"The name is at most {MAX_NAME} characters.")
    user = getattr(request, "jwt_user", {}) or {}
    connector = BiometricSiteConnector(
        name=name,
        notes=str(request.data.get("notes") or "")[:500],
        created_by=user.get("name") or user.get("username") or "",
    )
    code, expires = _issue_pairing(connector)
    try:
        with transaction.atomic():
            connector.save()
    except IntegrityError:
        return _bad("There is already a connector with that name.")
    log_action(request, "create", "attendance", record_id=connector.pk, description=f"Added Site Connector “{name}”")
    return Response(
        {"connector": serialize_connector(connector), "pairingCode": code, "pairingExpiresAt": expires.isoformat()},
        status=201,
    )


_FIELD_OF = {
    "name": "name",
    "notes": "notes",
    "isActive": "is_active",
    "punchSyncMinutes": "punch_sync_minutes",
    "punchSyncDays": "punch_sync_days",
}


def _changed_fields(data) -> set[str]:
    return {field for key, field in _FIELD_OF.items() if key in data}


@api_view(["PATCH", "DELETE"])
@require_hr
def device_control_connector_detail(request: Request, pk: int) -> Response:
    connector = BiometricSiteConnector.objects.filter(pk=pk).first()
    if connector is None:
        return _bad("Connector not found", 404)
    if not _may_manage(request):
        return _forbidden()

    if request.method == "DELETE":
        device_remote.fail_open_jobs(connector.pk, "removed", "The site connector was removed in the HRMS.")
        moved = list(BiometricDevice.objects.filter(connector=connector).values_list("name", flat=True))
        name = connector.name
        connector.delete()
        log_action(
            request,
            "delete",
            "attendance",
            record_id=pk,
            description=f"Removed Site Connector “{name}”"
            + (f"; its devices are now connected directly: {', '.join(moved)}" if moved else ""),
        )
        return Response(status=204)

    data = request.data
    changes = []
    if "name" in data:
        name = " ".join(str(data["name"] or "").split())
        if not name or len(name) > MAX_NAME:
            return _bad(f"The name must be 1 to {MAX_NAME} characters.")
        if BiometricSiteConnector.objects.exclude(pk=pk).filter(name=name).exists():
            return _bad("There is already a connector with that name.")
        connector.name = name
        changes.append("name")
    if "notes" in data:
        connector.notes = str(data["notes"] or "")[:500]
        changes.append("notes")
    if "isActive" in data:
        if not isinstance(data["isActive"], bool):
            return _bad("isActive must be true or false.")
        connector.is_active = data["isActive"]
        changes.append("switched on" if connector.is_active else "switched off")
    if "punchSyncMinutes" in data:
        minutes = _int_in(data["punchSyncMinutes"], 0, 1440)
        if minutes is None:
            return _bad("Reading punches every 0 (never) to 1440 minutes.")
        connector.punch_sync_minutes = minutes
        changes.append("punch reading interval")
    if "punchSyncDays" in data:
        days = _int_in(data["punchSyncDays"], 1, 31)
        if days is None:
            return _bad("Each reading looks back 1 to 31 days.")
        connector.punch_sync_days = days
        changes.append("punch reading window")
    try:
        # only the fields changed here: a whole-row save from this (possibly old) copy could undo what the connector has just
        # reported or a pairing that has just completed
        connector.save(
            update_fields=[
                f
                for f in ("name", "notes", "is_active", "punch_sync_minutes", "punch_sync_days")
                if f in _changed_fields(data)
            ]
        )
    except IntegrityError:
        return _bad("There is already a connector with that name.")
    if "isActive" in data and not connector.is_active:
        device_remote.fail_open_jobs(connector.pk, "revoked", "The site connector was switched off in the HRMS.")
    if changes:
        log_action(
            request,
            "update",
            "attendance",
            record_id=connector.pk,
            description=f"Changed Site Connector “{connector.name}”: {', '.join(changes)}",
        )
    return Response({"connector": serialize_connector(connector)})


@api_view(["POST"])
@require_hr
def device_control_connector_pairing(request: Request, pk: int) -> Response:
    connector = BiometricSiteConnector.objects.filter(pk=pk).first()
    if connector is None:
        return _bad("Connector not found", 404)
    if not _may_manage(request):
        return _forbidden()
    code, expires = _issue_pairing(connector)
    connector.save(update_fields=["pairing_hash", "pairing_expires_at"])
    log_action(
        request,
        "update",
        "attendance",
        record_id=connector.pk,
        description=f"Made a new pairing code for Site Connector “{connector.name}”",
    )
    return Response(
        {"connector": serialize_connector(connector), "pairingCode": code, "pairingExpiresAt": expires.isoformat()}
    )


@api_view(["GET"])
@require_hr
def device_control_operation(request: Request, pk: int) -> Response:
    op = BiometricDeviceOperation.objects.filter(pk=pk).first()
    if op is None:
        return _bad("Operation not found", 404)
    # a branch-limited caller follows only what they started: the answer names people
    scope = get_branch_scope(request)
    asker = (getattr(request, "jwt_user", {}) or {}).get("hrUserId")
    if scope is not None and (op.actor or {}).get("jwtUser", {}).get("hrUserId") != asker:
        return _bad("Operation not found", 404)
    return Response(device_remote.serialize_operation(device_remote.refresh_operation(op)))
