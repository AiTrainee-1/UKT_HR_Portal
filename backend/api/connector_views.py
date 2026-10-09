"""
The endpoints a Site Connector calls (see device_remote.py for what it is and how jobs work).

  POST /api/connector/pair                        exchange a pairing code for the connector's token (no token needed)
  POST /api/connector/poll                        "I am here; here is how my devices are; is there work?"
  POST /api/connector/jobs/<id>/result            report a job's result
  POST /api/connector/jobs/<id>/punches           one numbered chunk of the punches a read_punches job read
  POST /api/connector/punches                     punches the connector read on its own schedule, to be written to the HRMS

All JSON. Everything except pairing is authenticated by the connector's token (connector_auth.require_connector), which
is checked against the database on every request, so switching a connector off in the HRMS stops it at its next call.
A connector only ever sees and touches its own devices and jobs. The connector asks; the server never calls it.

A connector is trusted to be honest, not to be bug free: every body is checked for its shape and size before anything is
stored, and a result that would leave an operation half finished is refused (device_remote.validate_result).
"""

from __future__ import annotations

import logging
import re

from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import device_remote
from .audit_utils import log_action
from .connector_auth import new_token, normalize_code, pair_throttled, pairing_digest, require_connector, sha256
from .device_fetch import ingest_from_connector
from .device_health import client_ip
from .models import BiometricConnectorJob, BiometricDevice, BiometricSiteConnector

logger = logging.getLogger(__name__)

MAX_REPORTED_DEVICES = 200


def _bad(code: str, message: str, status: int = 400) -> Response:
    return Response({"error": code, "message": message}, status=status)


def _text(value, limit: int) -> str:
    return str(value if value is not None else "")[:limit]


def _body(request: Request) -> dict:
    """The JSON object that was sent; an empty one if it was a list or a plain value."""
    return request.data if isinstance(request.data, dict) else {}


def _by_device(raw, clean) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, value in list(raw.items())[:MAX_REPORTED_DEVICES]:
        if not re.fullmatch(r"[0-9]{1,12}", str(key)):
            continue
        cleaned = clean(value)
        if cleaned is not None:
            out[str(key)] = cleaned
    return out


# ── pairing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


@api_view(["POST"])
def connector_pair(request: Request) -> Response:
    if pair_throttled(request):
        return _bad("too_many_attempts", "Too many attempts. Wait a few minutes and try again.", 429)
    body = _body(request)
    code = normalize_code(body.get("code"))
    if len(code) < 6:
        return _bad("invalid_code", "That pairing code is not valid or has expired.")
    now = timezone.now()
    with transaction.atomic():
        connector = (
            BiometricSiteConnector.objects.select_for_update()
            .filter(pairing_hash=pairing_digest(code), pairing_expires_at__gt=now, is_active=True)
            .first()
        )
        if connector is None:
            return _bad("invalid_code", "That pairing code is not valid or has expired.")
        token = new_token()
        connector.token_hash = sha256(token)
        connector.pairing_hash = ""
        connector.pairing_expires_at = None
        connector.paired_at = now
        connector.last_seen_at = now
        connector.last_remote_ip = client_ip(request)
        connector.hostname = _text(body.get("hostname"), 120)
        connector.version = _text(body.get("version"), 40)
        connector.os_info = _text(body.get("os"), 120)
        connector.save()
    logger.info("Site connector %s paired from %s", connector.name, connector.last_remote_ip)
    # the audit trail says who paired it (a machine, not a person) and from where
    request.jwt_user = {"name": f"Site connector {connector.name}"}
    request.hr_branch_id = None
    log_action(
        request,
        "update",
        "attendance",
        record_id=connector.pk,
        description=f"Site connector “{connector.name}” was paired (computer {connector.hostname or 'unknown'}, from {connector.last_remote_ip or 'unknown'})",
    )
    return Response(
        {
            "connectorId": connector.pk,
            "name": connector.name,
            "token": token,
            "pollSeconds": device_remote.POLL_SECONDS,
            "protocol": device_remote.PROTOCOL_VERSION,
        }
    )


# ── the poll ────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _job_for_connector(job: BiometricConnectorJob) -> dict:
    return {
        "id": job.pk,
        "kind": job.kind,
        "deviceId": job.device_id,
        "payload": job.payload,
        "expiresAt": job.expires_at.isoformat(),
    }


@api_view(["POST"])
@require_connector
def connector_poll(request: Request) -> Response:
    """The connector's heartbeat and its request for work in one call: it says how it and its devices are, and is given the
    jobs waiting for it (up to as many as it says it has room for) and, when its settings changed, the new ones."""
    connector: BiometricSiteConnector = request.connector
    body = _body(request)
    now = timezone.now()

    status = body.get("status")
    fields = {"last_seen_at": now, "last_remote_ip": client_ip(request)}
    if isinstance(status, dict):
        for key, attr, limit in (("version", "version", 40), ("hostname", "hostname", 120), ("os", "os_info", 120)):
            if status.get(key):
                fields[attr] = _text(status[key], limit)
    BiometricSiteConnector.objects.filter(pk=connector.pk).update(**fields)
    if isinstance(status, dict):
        uptime = status.get("uptimeSeconds")
        outbox = status.get("outbox")
        device_remote.merge_status(
            connector.pk,
            devices=_by_device(status.get("devices"), device_remote.clean_probe),
            sync=_by_device(status.get("sync"), device_remote.clean_sync),
            reportedAt=now.isoformat(),
            uptimeSeconds=int(uptime) if isinstance(uptime, (int, float)) and not isinstance(uptime, bool) else None,
            outbox=int(outbox) if isinstance(outbox, (int, float)) and not isinstance(outbox, bool) else None,
        )

    device_remote.expire_jobs(now)
    try:
        want = int(body.get("want", 1))
    except (TypeError, ValueError):
        want = 1
    jobs = device_remote.claim_jobs(connector, want)

    config = device_remote.config_for(connector)
    send_config = body.get("cfgHash") != config["hash"]
    return Response(
        {
            "serverTime": now.isoformat(),
            "pollSeconds": device_remote.POLL_SECONDS,
            "protocol": device_remote.PROTOCOL_VERSION,
            "config": config if send_config else None,
            "jobs": [_job_for_connector(j) for j in jobs],
        }
    )


# ── a job's result and punches ─────────────────────────────────────────────────────────────────────────────────────────


def _own_job(request: Request, pk: int) -> BiometricConnectorJob | None:
    return BiometricConnectorJob.objects.filter(pk=pk, connector=request.connector).first()


@api_view(["POST"])
@require_connector
def connector_job_result(request: Request, pk: int) -> Response:
    job = _own_job(request, pk)
    if job is None:
        return _bad("not_found", "No such job for this connector.", 404)
    body = _body(request)
    ok = body.get("ok") is True
    data = body.get("data")
    try:
        device_remote.validate_result(job.kind, ok, data)
    except ValueError as exc:
        return _bad("invalid", f"The result is not in the expected form: {exc}.")
    closed = device_remote.finish_job(
        job.pk,
        ok,
        _text(body.get("code"), 60),
        _text(body.get("message"), 2000),
        data if isinstance(data, dict) else None,
    )
    # a result for a job already closed (it timed out, or this is a repeat) is acknowledged and ignored
    return Response({"ok": True, "accepted": closed is not None})


@api_view(["POST"])
@require_connector
def connector_job_punches(request: Request, pk: int) -> Response:
    job = _own_job(request, pk)
    if job is None:
        return _bad("not_found", "No such job for this connector.", 404)
    if job.kind != "read_punches" or job.status != BiometricConnectorJob.STATUS_RUNNING:
        return _bad("not_accepting", "This job is not waiting for punches.", 409)
    body = _body(request)
    try:
        seq = int(body.get("seq"))
        rows = device_remote.parse_punch_rows(body.get("punches"))
    except (TypeError, ValueError) as exc:
        return _bad("invalid", f"The punches could not be read: {exc}")
    if seq < 1:
        return _bad("invalid", "A chunk is numbered from 1.")
    try:
        stored = device_remote.stage_punches(job, seq, rows)
    except ValueError as exc:
        return _bad("not_accepting", str(exc), 409)
    return Response({"ok": True, "stored": stored, "received": len(rows)})


# ── punches read on the connector's own schedule ───────────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_connector
def connector_punches(request: Request) -> Response:
    """The connector's own periodic read of a device: written to the HRMS at once, the way a manual update writes them."""
    body = _body(request)
    try:
        device_id = int(body.get("deviceId"))
    except (TypeError, ValueError):
        return _bad("invalid", "deviceId is required.")
    device = BiometricDevice.objects.filter(pk=device_id, connector=request.connector).first()
    if device is None:
        return _bad("not_found", "That device is not assigned to this connector.", 404)
    try:
        rows = device_remote.parse_punch_rows(body.get("punches"))
        invalid = max(0, int(body.get("invalid") or 0))
        total = body.get("total")
        total = int(total) if total is not None else None
    except (TypeError, ValueError) as exc:
        return _bad("invalid", f"The punches could not be read: {exc}")
    zero = {"ok": True, "inRange": 0, "matched": 0, "alreadyInHrms": 0, "new": 0, "created": 0, "unmatchedPunches": 0}
    if not device.is_active:
        # switched off in Settings: its punches are not recorded (as for a direct sync); acknowledged so they are not resent
        return Response({**zero, "ignored": "This device is switched off in Settings → Devices."})
    if not rows:
        BiometricDevice.objects.filter(pk=device.pk).update(
            last_synced_at=timezone.now(), last_reachable_at=timezone.now(), last_sync_error=""
        )
        return Response(zero)
    result = ingest_from_connector(device, rows, invalid, total)
    return Response({"ok": True, **result})
