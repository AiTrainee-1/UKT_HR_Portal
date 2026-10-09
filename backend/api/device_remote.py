"""
Devices behind a Site Connector.

A device the server cannot open a connection to (it sits on a factory network with no way in) is assigned to a Site
Connector: a small service on that network that calls this server, asks for work, runs it on the local network and reports
back. Nothing here connects to a device; it queues jobs and reads their results.

Why nothing waits for a connector inside a web request: the server has one worker and a 30 second limit, and the connector
reports back through that same worker, so a request that waited for it would block the very request that could end the wait.
So a change that includes a connector device records what was asked (a `BiometricDeviceOperation`), starts a job per
connector device and returns at once; the page polls the operation. When the last job reports, the operation is finished by
the same code that finishes a direct change (device_directory.finish_operation).

Job kinds, what the connector is told and what it answers (see the connector's docs/PROTOCOL.md):

  probe          {}                                 → the probe dict of device_client.timed_probe
  read_users     {}                                 → {users, capacity, ms}
  apply_users    {mode, specs}                      → {added, updated, skipped, failed, users, capacity}
  delete_users   {userIds}                          → {deleted, absent, skipped, failed, users, capacity}
  read_punches   {since, until}                     → {total, invalid, count, ms}; the punches themselves arrive first, in
                                                      numbered chunks, and are held in BiometricConnectorPunch

Every job also carries `target` {host, port, password}: the device's address as this server has it, so a change made in
Settings → Devices is in force for the next job without waiting for the connector to refresh anything.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

from django.core.cache import cache
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .audit_utils import log_action
from .branch_scope import get_branch_scope
from .device_client import DeviceUser, Punch
from .device_health import client_ip
from .models import (
    BiometricConnectorJob,
    BiometricConnectorPunch,
    BiometricDevice,
    BiometricDeviceOperation,
    BiometricSiteConnector,
)

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
POLL_SECONDS = 5  # how often a connector asks for work
ONLINE_SECONDS = 45  # heard from within this long = online
MAX_JOBS_PER_POLL = 4

# How long a job may wait to be picked up, and (from the pick-up) to finish, before it is given up on.
JOB_TTL_SECONDS = {
    "probe": 90,
    "read_users": 240,
    "apply_users": 420,
    "delete_users": 420,
    "read_punches": 1800,
}
# How long a job may run once it was taken, before it is given up on as lost (and a little more for a slow connector). Counted
# from the moment it was taken, not from when it was queued: a connector that was busy and took it late still gets its time.
RUNNING_SECONDS = {"probe": 60, "read_users": 150, "apply_users": 300, "delete_users": 300, "read_punches": 1800}
RUNNING_GRACE_SECONDS = 60
WRITE_KINDS = ("apply_users", "delete_users")
PUNCH_CHUNK_MAX = 5000
MAX_PUNCH_CHUNKS = (
    150  # a job's punches: at most this many numbered chunks (150 x 5000 is five times a full device log)
)
MAX_RESULT_USERS = 20_000
STALE_REPORT_SECONDS = 150  # a device report older than this is no longer "how the device is"
# a job closed as one of these may still have changed the device (the connector was running it when it was given up on)
LATE_CODES = ("lost", "revoked", "removed")
IST = dt_timezone(timedelta(hours=5, minutes=30))

NOT_PICKED_UP = "The site connector did not pick this up in time (it is offline or busy). Nothing was changed."
LOST_CONNECTOR = (
    "The site connector stopped answering before it reported back. The device may or may not have been changed: "
    "read it again to see where things stand."
)
SWITCHED_OFF_RUNNING = (
    "The site connector was switched off or removed while it was working on this. The device may or may not have been "
    "changed: read it again to see where things stand."
)


# ── is the connector there ──────────────────────────────────────────────────────────────────────────────────────────


def is_remote(device: BiometricDevice) -> bool:
    return device.connector_id is not None


def connector_online(connector: BiometricSiteConnector, now: datetime | None = None) -> bool:
    now = now or timezone.now()
    return bool(
        connector.is_active
        and connector.last_seen_at
        and (now - connector.last_seen_at).total_seconds() <= ONLINE_SECONDS
    )


def _ago(moment: datetime, now: datetime) -> str:
    seconds = max(0, int((now - moment).total_seconds()))
    if seconds < 90:
        return "a minute ago" if seconds >= 45 else f"{seconds} seconds ago"
    minutes = seconds // 60
    if minutes < 90:
        return f"{minutes} minutes ago"
    hours = minutes // 60
    if hours < 48:
        return f"{hours} hours ago"
    return f"{hours // 24} days ago"


def offline_reason(connector: BiometricSiteConnector, now: datetime | None = None) -> str:
    """Why this connector cannot be used right now, in words a person can act on. Empty when it can."""
    now = now or timezone.now()
    if not connector.is_active:
        return f"The site connector “{connector.name}” is switched off in the HRMS."
    if not connector.token_hash:
        return f"The site connector “{connector.name}” has not been paired yet: install it at the site and enter its pairing code."
    if connector.last_seen_at is None:
        return f"The site connector “{connector.name}” has not connected yet."
    if not connector_online(connector, now):
        return (
            f"The site connector “{connector.name}” was last heard from {_ago(connector.last_seen_at, now)}. "
            "Check that its computer is on and has internet."
        )
    return ""


def _comm_key(device: BiometricDevice) -> int | None:
    raw = (device.connection_config or {}).get("password", 0) or 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def target_of(device: BiometricDevice) -> dict:
    return {"host": device.host, "port": device.port or 4370, "password": _comm_key(device) or 0}


# ── what a connector says, cut down to what the pages know ──────────────────────────────────────────────────────────────

PROBE_KEYS = ("ok", "code", "error", "latencyMs", "capacity", "deviceTime", "ageSeconds", "busy")
CAPACITY_KEYS = (
    "users",
    "usersCap",
    "records",
    "recordsCap",
    "faces",
    "facesCap",
    "cards",
    "pinWidth",
    "platform",
    "firmware",
    "serial",
)
SYNC_KEYS = (
    "ageSeconds",
    "ok",
    "error",
    "read",
    "queued",
    "inRange",
    "matched",
    "alreadyInHrms",
    "new",
    "created",
    "unmatchedPunches",
    "skipped",
    "windowDays",
    "busy",
)


def _text(value, limit: int) -> str:
    return str(value if value is not None else "")[:limit]


def _naive_iso(value) -> str | None:
    """A device time as the naive wall-clock text the pages compare with the server's own clock; None if it is not one."""
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value)[:40])
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(IST).replace(tzinfo=None)
    return moment.replace(microsecond=0).isoformat()


def clean_probe(raw) -> dict | None:
    """One device's check as a connector reported it, cut down to the fields the pages know. None if it is not one."""
    if not isinstance(raw, dict):
        return None
    out = {k: raw[k] for k in PROBE_KEYS if k in raw}
    out["ok"] = bool(out.get("ok"))
    out["code"] = _text(out.get("code") or ("ok" if out["ok"] else "error"), 40)
    out["error"] = _text(out.get("error"), 500)
    latency = out.get("latencyMs")
    out["latencyMs"] = float(latency) if isinstance(latency, (int, float)) and not isinstance(latency, bool) else None
    out["deviceTime"] = _naive_iso(out.get("deviceTime"))
    out["checkedAt"] = _moment(out.pop("ageSeconds", None))
    capacity = out.get("capacity")
    out["capacity"] = (
        {k: capacity[k] for k in CAPACITY_KEYS if k in capacity and isinstance(capacity[k], (int, float, str))}
        if isinstance(capacity, dict)
        else None
    )
    if out["capacity"]:
        out["capacity"] = {k: (_text(v, 80) if isinstance(v, str) else v) for k, v in out["capacity"].items()}
    out["busy"] = bool(out.get("busy"))
    return out


def _moment(age_seconds) -> str:
    """When something happened, as the server's own clock has it: the connector says how long ago (its own clock and time
    zone are not trusted for this), and the server counts back from the moment the report arrived."""
    age = age_seconds if isinstance(age_seconds, (int, float)) and not isinstance(age_seconds, bool) else 0
    return (timezone.now() - timedelta(seconds=max(0, min(float(age), 30 * 86400)))).isoformat()


def clean_sync(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {
        k: (_text(raw[k], 500) if isinstance(raw[k], str) else raw[k])
        for k in SYNC_KEYS
        if k != "ageSeconds" and k in raw and isinstance(raw[k], (int, float, str, bool, type(None)))
    }
    out["at"] = _moment(raw.get("ageSeconds"))
    return out


# ── what the connector is told about its devices ────────────────────────────────────────────────────────────────────


def config_for(connector: BiometricSiteConnector) -> dict:
    """The devices assigned to a connector and its settings. The hash lets it ask for the whole thing only when it changed."""
    devices = [
        {
            "id": d.pk,
            "name": d.name,
            "host": d.host,
            "port": d.port or 4370,
            "password": _comm_key(d) or 0,
            "serialNumber": d.serial_number or "",
            "deviceType": d.device_type,
            "isActive": d.is_active,
        }
        for d in BiometricDevice.objects.filter(connector=connector).order_by("pk")
    ]
    body = {
        "devices": devices,
        "punchSyncMinutes": connector.punch_sync_minutes,
        "punchSyncDays": connector.punch_sync_days,
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return {**body, "hash": digest}


# ── checking what a connector reports back ──────────────────────────────────────────────────────────────────────────────


def _str_list(value, name: str) -> None:
    if value is None:
        return
    if not isinstance(value, list) or len(value) > 5000 or not all(isinstance(v, str) for v in value):
        raise ValueError(f"{name} must be a list of user IDs")


def _entry_list(value, name: str) -> None:
    if value is None:
        return
    if (
        not isinstance(value, list)
        or len(value) > 5000
        or not all(isinstance(v, dict) and isinstance(v.get("userId"), str) for v in value)
    ):
        raise ValueError(f"{name} must be a list of {{userId, ...}}")


def validate_result(kind: str, ok: bool, data) -> None:
    """Refuse (ValueError) a job result that is not in the form the finishing code relies on. A connector is trusted to be
    honest, not to be bug free: a result that would leave an operation half finished is turned away here instead."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("data must be an object")
    users = data.get("users")
    if users is not None:
        if not isinstance(users, list) or len(users) > MAX_RESULT_USERS:
            raise ValueError("users must be a list")
        try:
            decode_users(users)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("the users are not in the expected form") from exc
    capacity = data.get("capacity")
    if capacity is not None and not isinstance(capacity, dict):
        raise ValueError("capacity must be an object")
    if kind == "read_users" and ok and (not isinstance(users, list) or not isinstance(capacity, dict)):
        raise ValueError("a successful read must carry the users and the capacity")
    if kind in WRITE_KINDS:
        for key in ("added", "updated", "deleted", "absent"):
            _str_list(data.get(key), key)
        for key in ("skipped", "failed"):
            _entry_list(data.get(key), key)
    if kind == "read_punches" and ok:
        for key in ("count", "total", "invalid", "ms"):
            value = data.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
                raise ValueError(f"{key} must be a whole number")
    if kind == "probe" and ok and clean_probe(data) is None:
        raise ValueError("a probe result must be an object")


# ── users and punches as JSON ───────────────────────────────────────────────────────────────────────────────────────────


def encode_users(users) -> list[dict]:
    return [
        {
            "uid": u.uid,
            "userId": u.user_id,
            "name": u.name,
            "privilege": u.privilege,
            "card": u.card,
            "hasPassword": bool(u.has_password),
            "group": u.group,
        }
        for u in users
    ]


def decode_users(rows) -> list[DeviceUser]:
    """Users as the connector sent them. The password is never sent, so a stand-in marks "has one" for the snapshot."""
    out = []
    for r in rows or []:
        out.append(
            DeviceUser(
                uid=int(r["uid"]),
                user_id=str(r["userId"]),
                name=str(r.get("name") or ""),
                privilege=int(r.get("privilege") or 0),
                card=int(r.get("card") or 0),
                password="*" if r.get("hasPassword") else "",
                group=str(r.get("group") or ""),
                raw=b"",
            )
        )
    return out


def encode_result(result: dict) -> dict:
    """A device's result as it is kept on an operation: the same dict, with the users as plain data."""
    out = dict(result)
    if out.get("users") is not None:
        out["users"] = encode_users(out["users"])
    return out


def decode_result(result: dict) -> dict:
    out = dict(result)
    if out.get("users") is not None:
        out["users"] = decode_users(out["users"])
    return out


def result_from_job(job: BiometricConnectorJob) -> dict:
    """What a finished job says, in the shape the direct code returns for the same work, so one finish path serves both."""
    data = dict(job.result or {})
    ok = job.status == BiometricConnectorJob.STATUS_SUCCEEDED
    if job.kind == "read_users":
        if ok and not isinstance(data.get("users"), list):
            return {"ok": False, "code": "protocol", "error": "The connector reported a read without the users."}
        if ok:
            return {
                "ok": True,
                "users": decode_users(data.get("users")),
                "capacity": data.get("capacity") or {},
                "ms": int(data.get("ms") or 0),
            }
        return {"ok": False, "code": job.error_code or "error", "error": job.error_message or "The read failed."}
    base = {"ok": ok, "added": [], "updated": [], "deleted": [], "absent": [], "skipped": [], "failed": []}
    base.update({k: data[k] for k in ("added", "updated", "deleted", "absent", "skipped", "failed") if k in data})
    base["users"] = decode_users(data["users"]) if data.get("users") is not None else None
    base["capacity"] = data.get("capacity")
    if not ok:
        base.update(code=job.error_code or "error", error=job.error_message or "The device did not complete this.")
    return base


# ── jobs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def submit_job(
    device: BiometricDevice, kind: str, payload: dict | None = None, operation: BiometricDeviceOperation | None = None
) -> BiometricConnectorJob:
    ttl = JOB_TTL_SECONDS[kind]
    return BiometricConnectorJob.objects.create(
        connector_id=device.connector_id,
        device=device,
        operation=operation,
        kind=kind,
        payload={**(payload or {}), "target": target_of(device)},
        expires_at=timezone.now() + timedelta(seconds=ttl),
    )


def _scrub(job: BiometricConnectorJob) -> None:
    """A finished job keeps what it did and what it found, not what it was told: that can hold device passwords."""
    BiometricConnectorJob.objects.filter(pk=job.pk).update(payload={})


def claim_jobs(connector: BiometricSiteConnector, limit: int) -> list[BiometricConnectorJob]:
    """Hand the connector the oldest jobs waiting for it (at most `limit`), marking them running. Two changes to one device are
    never handed out together, nor while another is still running on it: the second waits for the first."""
    limit = max(0, min(int(limit), MAX_JOBS_PER_POLL))
    if limit == 0:
        return []
    now = timezone.now()
    with transaction.atomic():
        busy = set(
            BiometricConnectorJob.objects.filter(
                connector=connector, status=BiometricConnectorJob.STATUS_RUNNING, kind__in=WRITE_KINDS
            ).values_list("device_id", flat=True)
        )
        waiting = list(
            BiometricConnectorJob.objects.select_for_update(skip_locked=True)
            .filter(connector=connector, status=BiometricConnectorJob.STATUS_QUEUED, expires_at__gt=now)
            .order_by("created_at")[: limit * 4]
        )
        jobs = []
        for job in waiting:
            if job.kind in WRITE_KINDS:
                if job.device_id in busy:
                    continue
                busy.add(job.device_id)
            jobs.append(job)
            if len(jobs) >= limit:
                break
        if jobs:
            BiometricConnectorJob.objects.filter(pk__in=[j.pk for j in jobs]).update(
                status=BiometricConnectorJob.STATUS_RUNNING, claimed_at=now, attempts=F("attempts") + 1
            )
            for job in jobs:
                job.status = BiometricConnectorJob.STATUS_RUNNING
                job.claimed_at = now
    return jobs


def expire_jobs(now: datetime | None = None) -> int:
    """Give up on jobs nobody took, and on jobs taken and never reported. Finishes the operations they belonged to, and any
    operation whose jobs have all closed without it being finished (a worker that died in between)."""
    now = now or timezone.now()
    ended: set[int] = set()
    changed = 0
    for job in BiometricConnectorJob.objects.filter(
        status=BiometricConnectorJob.STATUS_QUEUED, expires_at__lt=now
    ).only("pk", "operation_id"):
        if BiometricConnectorJob.objects.filter(pk=job.pk, status=BiometricConnectorJob.STATUS_QUEUED).update(
            status=BiometricConnectorJob.STATUS_EXPIRED,
            error_code="expired",
            error_message=NOT_PICKED_UP,
            finished_at=now,
            payload={},
        ):
            changed += 1
            if job.operation_id:
                ended.add(job.operation_id)
    for kind, seconds in RUNNING_SECONDS.items():
        cutoff = now - timedelta(seconds=seconds + RUNNING_GRACE_SECONDS)
        for job in BiometricConnectorJob.objects.filter(
            status=BiometricConnectorJob.STATUS_RUNNING, kind=kind, claimed_at__lt=cutoff
        ).only("pk", "operation_id"):
            if BiometricConnectorJob.objects.filter(pk=job.pk, status=BiometricConnectorJob.STATUS_RUNNING).update(
                status=BiometricConnectorJob.STATUS_FAILED,
                error_code="lost",
                error_message=LOST_CONNECTOR,
                finished_at=now,
                payload={},
            ):
                changed += 1
                if job.operation_id:
                    ended.add(job.operation_id)
    stranded = BiometricDeviceOperation.objects.filter(
        status="running", created_at__lt=now - timedelta(seconds=15)
    ).exclude(jobs__status__in=BiometricConnectorJob.OPEN_STATUSES)
    ended.update(stranded.values_list("pk", flat=True)[:20])
    for op_id in ended:
        maybe_finalize(op_id)
    maybe_prune()
    return changed


def fail_open_jobs(connector_id: int, code: str, message: str) -> None:
    """End every job still waiting for or running on a connector (it was switched off or removed), and finish the
    operations they belonged to, so nobody is left waiting for an answer that cannot come. A job that was already running
    may still have changed its device, and says so."""
    now = timezone.now()
    ended: set[int] = set()
    for job in BiometricConnectorJob.objects.filter(
        connector_id=connector_id, status__in=BiometricConnectorJob.OPEN_STATUSES
    ).only("pk", "operation_id", "status"):
        running = job.status == BiometricConnectorJob.STATUS_RUNNING
        if BiometricConnectorJob.objects.filter(pk=job.pk, status=job.status).update(
            status=BiometricConnectorJob.STATUS_FAILED,
            error_code="lost" if running else code,
            error_message=SWITCHED_OFF_RUNNING if running else message,
            finished_at=now,
            payload={},
        ):
            if job.operation_id:
                ended.add(job.operation_id)
    for op_id in ended:
        maybe_finalize(op_id)


def finish_job(
    job_id: int, ok: bool, code: str = "", message: str = "", data: dict | None = None
) -> BiometricConnectorJob | None:
    """The connector reports a job done (or failed). None when the job was already closed (a late or repeated report); a
    late report of a change the job was given up on while it was being made is still recorded (see _late_write)."""
    now = timezone.now()
    late = closed_now = False
    with transaction.atomic():
        job = BiometricConnectorJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None:
            return None
        if job.status != BiometricConnectorJob.STATUS_RUNNING:
            late = (
                job.status == BiometricConnectorJob.STATUS_FAILED
                and job.error_code in LATE_CODES
                and job.kind in WRITE_KINDS
                and job.result is None  # a lost job has no result: once one is kept, a repeat of the report is not news
            )
            if late:
                job.result = {"late": True}
                job.save(update_fields=["result"])
        else:
            closed_now = True
            job.status = BiometricConnectorJob.STATUS_SUCCEEDED if ok else BiometricConnectorJob.STATUS_FAILED
            job.result = data if isinstance(data, dict) else None
            job.error_code = "" if ok else (str(code or "error"))[:60]
            job.error_message = "" if ok else (str(message or "The connector reported a failure."))[:2000]
            job.finished_at = now
            job.payload = {}
            job.save(update_fields=["status", "result", "error_code", "error_message", "finished_at", "payload"])
    if late:
        _late_write(job, ok, data)
        return None
    if not closed_now:
        return None
    if job.kind == "probe":
        _remember_probe(job, ok, code, message, data)
    elif job.kind == "read_users" and ok and job.operation_id is None:
        _store_resync(job, data)
    if job.operation_id:
        maybe_finalize(job.operation_id)
    return job


def _late_write(job: BiometricConnectorJob, ok: bool, data: dict | None) -> None:
    """A change the HRMS had given up on (the connector looked lost, or was switched off while working) turns out to have been
    made. The user was told "it may or may not have been changed": so say what it did in the audit trail, and read the device
    again so the lists show where things stand."""
    data = data if isinstance(data, dict) else {}
    parts = [
        f"{len(data[k])} {k}" for k in ("added", "updated", "deleted") if isinstance(data.get(k), list) and data[k]
    ]
    log_action(
        request_for({"jwtUser": {"name": f"Site connector {job.connector.name}"}}),
        "update",
        "attendance",
        description=(
            f"Late report from site connector “{job.connector.name}” for device {job.device.name}: the job had been given up "
            f"on ({job.error_code}) but finished"
            + (f": {', '.join(parts)}" if parts else " with no change to report")
            + ("" if ok else " (reporting a failure)")
        ),
    )
    if (
        connector_online(job.connector)
        and not BiometricConnectorJob.objects.filter(
            device=job.device, kind="read_users", status__in=BiometricConnectorJob.OPEN_STATUSES
        ).exists()
    ):
        submit_job(job.device, "read_users")


def _store_resync(job: BiometricConnectorJob, data: dict | None) -> None:
    """A read that no operation is waiting for (the follow-up to a late report): keep what it found as the device's users."""
    from . import device_directory

    try:
        device_directory.store_snapshot(
            job.device, decode_users((data or {}).get("users")), (data or {}).get("capacity")
        )
    except Exception:  # noqa: BLE001 -- a refresh nobody asked for must never break the report that brought it
        logger.exception("Could not store the users a connector read for %s", job.device_id)


# ── what the connector last said about each device ──────────────────────────────────────────────────────────────────────


def merge_status(connector_id: int, devices: dict | None = None, sync: dict | None = None, **top) -> None:
    """Fold a report into the connector's stored status. Entries for devices the connector no longer has are dropped."""
    with transaction.atomic():
        connector = BiometricSiteConnector.objects.select_for_update().get(pk=connector_id)
        status = dict(connector.status or {})
        known = {str(i) for i in BiometricDevice.objects.filter(connector=connector).values_list("pk", flat=True)}
        for key, incoming in (("devices", devices), ("sync", sync)):
            if incoming is None:
                continue
            merged = {k: v for k, v in (status.get(key) or {}).items() if k in known}
            merged.update({str(k): v for k, v in incoming.items() if str(k) in known})
            status[key] = merged
        status.update(top)
        connector.status = status
        connector.save(update_fields=["status"])


def _remember_probe(job: BiometricConnectorJob, ok: bool, code: str, message: str, data: dict | None) -> None:
    probe = clean_probe(data) if ok else None
    if probe is None:
        probe = clean_probe({"ok": False, "code": code or "error", "error": message or "The probe failed."})
    probe["checkedAt"] = timezone.now().isoformat()
    merge_status(job.connector_id, devices={job.device_id: probe})


def remote_probe(device: BiometricDevice, now: datetime) -> dict:
    """The overview's answer for a device behind a connector: what its connector last reported."""
    connector = device.connector
    reason = offline_reason(connector, now)
    blank = {"latencyMs": None, "capacity": None, "deviceTime": None}
    if reason:
        code = "connector_off" if not connector.is_active else "connector_offline"
        return {"ok": False, "code": code, "error": reason, **blank}
    report = ((connector.status or {}).get("devices") or {}).get(str(device.pk))
    if not report:
        return {
            "ok": False,
            "code": "pending",
            "error": f"The site connector “{connector.name}” has not checked this device yet.",
            **blank,
        }
    try:
        age = (now - datetime.fromisoformat(str(report.get("checkedAt")))).total_seconds()
    except (TypeError, ValueError):
        age = 0
    if age > STALE_REPORT_SECONDS:
        return {
            "ok": False,
            "code": "pending",
            "error": (
                f"The site connector “{connector.name}” has not checked this device for {int(age // 60)} minutes "
                "(it is still calling in, but its checks have stopped)."
            ),
            **blank,
        }
    return {
        "ok": bool(report.get("ok")),
        "code": report.get("code") or ("ok" if report.get("ok") else "error"),
        "error": report.get("error") or "",
        "latencyMs": report.get("latencyMs"),
        "capacity": report.get("capacity"),
        "deviceTime": report.get("deviceTime"),
    }


def probe_remote(devices: list[BiometricDevice], fresh: bool = False) -> dict[int, dict]:
    """Probe results for the devices behind connectors. A fresh check queues a probe job per device whose connector is
    online (unless one is already waiting); the answer is the latest report, and the next one is a few seconds away."""
    now = timezone.now()
    results = {}
    for d in devices:
        if not d.is_active or not is_remote(d):
            continue
        results[d.pk] = remote_probe(d, now)
        if fresh and connector_online(d.connector, now):
            waiting = BiometricConnectorJob.objects.filter(
                device=d, kind="probe", status__in=BiometricConnectorJob.OPEN_STATUSES
            ).exists()
            if not waiting:
                submit_job(d, "probe")
    return results


# ── operations ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def actor_of(request) -> dict:
    user = getattr(request, "jwt_user", None) or {}
    keep = {k: user.get(k) for k in ("hrUserId", "name", "username", "role") if user.get(k) is not None}
    meta = getattr(request, "META", {}) or {}
    return {"jwtUser": keep, "branchScope": get_branch_scope(request), "remoteAddr": client_ip(request) if meta else ""}


def request_for(actor: dict):
    """A stand-in for the request that started an operation, for the code that finishes it: it carries who asked, which
    branch they are limited to and where from, which is everything that code reads from a request."""
    return SimpleNamespace(
        hr_branch_id=actor.get("branchScope"),
        jwt_user=actor.get("jwtUser") or {},
        META={"REMOTE_ADDR": actor.get("remoteAddr") or ""},
    )


def start_operation(
    request,
    kind: str,
    params: dict,
    local_results: dict[int, dict],
    remote: list[tuple[BiometricDevice, str, dict]],
) -> BiometricDeviceOperation:
    """Record an operation that includes connector devices and start their jobs.

    local_results are the results of the devices that were run directly, already in hand. A connector device whose
    connector is off or not answering fails at once, with the reason, rather than waiting for a job that nobody will take.
    The operation and all its jobs are made together: a connector polling in between must never see half of them."""
    now = timezone.now()
    with transaction.atomic():
        op = BiometricDeviceOperation.objects.create(
            kind=kind,
            params=params,
            actor=actor_of(request),
            results={str(pk): encode_result(r) for pk, r in local_results.items()},
        )
        results = dict(op.results)
        for device, job_kind, payload in remote:
            reason = offline_reason(device.connector, now)
            if reason:
                code = "connector_off" if not device.connector.is_active else "connector_offline"
                results[str(device.pk)] = {"ok": False, "code": code, "error": reason}
                continue
            submit_job(device, job_kind, payload, operation=op)
        if results != op.results:
            BiometricDeviceOperation.objects.filter(pk=op.pk).update(results=results)
    maybe_finalize(op.pk)
    op.refresh_from_db()
    return op


def _slim(results: dict) -> dict:
    """Results as they are kept once an operation is over: without the full lists of users, which can be thousands of names."""
    return {pk: {k: v for k, v in r.items() if k != "users"} for pk, r in results.items()}


def _audit_unfinished(op: BiometricDeviceOperation, results: dict) -> None:
    """An operation that could not be finished still changed devices: leave a trace of what they reported."""
    said = []
    for pk, r in sorted(results.items()):
        counts = [f"{len(r[k])} {k}" for k in ("added", "updated", "deleted") if isinstance(r.get(k), list) and r[k]]
        said.append(
            f"device {pk}: " + (", ".join(counts) or ("no change" if r.get("ok") else _text(r.get("error"), 80)))
        )
    log_action(
        request_for(op.actor or {}),
        "update",
        "attendance",
        record_id=op.pk,
        description=f"A {op.kind} on biometric devices through a site connector could not be recorded. They reported: "
        + "; ".join(said),
    )


def maybe_finalize(operation_id: int) -> bool:
    """Finish the operation if every job is closed. Safe to call from any worker at any time: the operation row is locked,
    and whoever arrives second finds it already finished. Finishing is all or nothing: if it fails, what it had already
    done is undone (it is a savepoint), the operation says so, and the audit trail still says what the devices reported."""
    from . import device_directory

    with transaction.atomic():
        op = BiometricDeviceOperation.objects.select_for_update().filter(pk=operation_id).first()
        if op is None or op.status != "running":
            return False
        jobs = list(op.jobs.all())
        if any(j.status in BiometricConnectorJob.OPEN_STATUSES for j in jobs):
            return False
        results = dict(op.results or {})
        for job in jobs:
            results[str(job.device_id)] = encode_result(result_from_job(job))
        try:
            decoded = {int(pk): decode_result(r) for pk, r in results.items()}
            with transaction.atomic():
                final = device_directory.finish_operation(op, decoded)
            op.status, op.final, op.error = "done", final, ""
        except Exception as exc:  # noqa: BLE001 -- the operation must end, whatever went wrong in finishing it
            logger.exception("Device operation %s could not be finished", op.pk)
            op.status, op.final, op.error = "failed", None, f"The operation could not be finished: {exc}"
            _audit_unfinished(op, results)
        op.results = _slim(results)
        op.finished_at = timezone.now()
        op.save(update_fields=["status", "final", "error", "results", "finished_at", "updated_at"])
        for job in jobs:
            if isinstance(job.result, dict) and "users" in job.result:
                BiometricConnectorJob.objects.filter(pk=job.pk).update(
                    result={k: v for k, v in job.result.items() if k != "users"}
                )
    return True


def serialize_operation(op: BiometricDeviceOperation) -> dict:
    """What the page polls. While it runs, `pending` says which devices are still being waited for."""
    pending = []
    if op.status == "running":
        for job in op.jobs.select_related("device", "connector"):
            if job.status in BiometricConnectorJob.OPEN_STATUSES:
                pending.append(
                    {
                        "deviceId": job.device_id,
                        "deviceName": job.device.name,
                        "connector": job.connector.name,
                        "state": "waiting" if job.status == BiometricConnectorJob.STATUS_QUEUED else "working",
                    }
                )
    return {
        "id": op.pk,
        "kind": op.kind,
        "status": op.status,
        "pending": pending,
        "final": op.final,
        "error": op.error,
        "createdAt": op.created_at.isoformat(),
        "finishedAt": op.finished_at.isoformat() if op.finished_at else None,
    }


def refresh_operation(op: BiometricDeviceOperation) -> BiometricDeviceOperation:
    """Give up on overdue jobs, finish the operation if nothing is left to wait for (whoever should have finished it may have
    died), and return the operation as it now stands."""
    if op.status == "running":
        expire_jobs()
        maybe_finalize(op.pk)
        op.refresh_from_db()
    return op


def prune_operations(keep_days: int = 7) -> None:
    cutoff = timezone.now() - timedelta(days=keep_days)
    BiometricDeviceOperation.objects.filter(created_at__lt=cutoff).exclude(status="running").delete()
    BiometricConnectorJob.objects.filter(created_at__lt=cutoff).exclude(
        status__in=BiometricConnectorJob.OPEN_STATUSES
    ).delete()


def maybe_prune() -> None:
    """Clean up old operations, jobs and any punches left staged, at most once an hour (it rides on the connectors' polls)."""
    if cache.add("device-remote-prune", 1, 3600):
        try:
            prune_operations()
        except Exception:  # noqa: BLE001
            logger.exception("Could not prune old connector operations")


# ── punches ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


def parse_punch_rows(rows) -> list[tuple[str, datetime, int]]:
    """Punch rows as a connector sends them [{userId, at, status}] -> (user id, naive datetime, status). ValueError if a row
    is not one: the chunk is refused whole, so a half-understood chunk is never stored. A time that carries a time zone is
    converted to the factory's (IST); the device's own times have none."""
    if not isinstance(rows, list):
        raise ValueError("punches must be a list")
    if len(rows) > PUNCH_CHUNK_MAX:
        raise ValueError(f"at most {PUNCH_CHUNK_MAX} punches at a time")
    out = []
    for r in rows:
        if not isinstance(r, dict):
            raise ValueError("each punch must be an object")
        user_id = str(r.get("userId") or "").strip()
        if not user_id or len(user_id) > 40:
            raise ValueError("a punch has no usable userId")
        at = datetime.fromisoformat(str(r.get("at")))
        if at.tzinfo is not None:
            at = at.astimezone(IST).replace(tzinfo=None)
        status = int(r.get("status") or 0)
        if not 0 <= status <= 255:
            raise ValueError("a punch has a status outside 0 to 255")
        out.append((user_id, at.replace(microsecond=0), status))
    return out


def sane_punch_time(at: datetime) -> bool:
    """A device with a flat battery or a wrong clock stamps punches in 1970 or next year: those are not written."""
    return at.year >= 2000 and at <= datetime.now(IST).replace(tzinfo=None) + timedelta(days=1)


def stage_punches(job: BiometricConnectorJob, seq: int, rows: list[tuple[str, datetime, int]]) -> bool:
    """Keep one numbered chunk of a read_punches job's punches. False when this chunk (or a later one) was already stored,
    which is what a resent chunk looks like, so a retry never stores a chunk twice. ValueError if the job is no longer
    taking punches (it closed while the chunk was on its way) or has had more chunks than a device can have."""
    if seq > MAX_PUNCH_CHUNKS:
        raise ValueError("too many chunks for one job")
    with transaction.atomic():
        locked = BiometricConnectorJob.objects.select_for_update().get(pk=job.pk)
        if locked.status != BiometricConnectorJob.STATUS_RUNNING:
            raise ValueError("the job is no longer taking punches")
        if seq <= locked.last_seq:
            return False
        BiometricConnectorPunch.objects.bulk_create(
            [
                BiometricConnectorPunch(job=locked, user_id=u, punch_date=at.date(), punch_time=at.time(), status=s)
                for u, at, s in rows
            ],
            batch_size=1000,
        )
        locked.last_seq = seq
        locked.save(update_fields=["last_seq"])
    return True


def collect_punches(job) -> dict:
    """A finished read_punches job as the direct reader returns it: {"ok", "punches", "invalid", "total", "ms"}.
    The staged punches are removed once read. Never raises: whatever is wrong with a connector's answer is that device's
    failure, not the run's."""
    try:
        if getattr(job, "status", None) != BiometricConnectorJob.STATUS_SUCCEEDED:
            return {
                "ok": False,
                "code": getattr(job, "error_code", "") or "error",
                "error": getattr(job, "error_message", "") or "The read failed.",
            }
        data = job.result or {}
        expected = data.get("count")
        rows = list(
            BiometricConnectorPunch.objects.filter(job_id=job.pk)
            .order_by("pk")
            .values_list("user_id", "punch_date", "punch_time", "status")
            .iterator(chunk_size=5000)
        )
        if expected is not None and int(expected) != len(rows):
            return {
                "ok": False,
                "code": "incomplete",
                "error": (
                    f"Only {len(rows):,} of the {int(expected):,} punches reached the server. "
                    "Nothing was written: run the fetch again."
                ),
            }
        punches, odd = [], 0
        for user_id, day, moment, status in rows:
            at = datetime.combine(day, moment)
            if sane_punch_time(at):
                punches.append(Punch(user_id, at, status))
            else:
                odd += 1
        return {
            "ok": True,
            "punches": punches,
            "invalid": int(data.get("invalid") or 0) + odd,
            "total": int(data.get("total") or len(rows)),
            "ms": int(data.get("ms") or 0),
        }
    except (TypeError, ValueError) as exc:
        return {"ok": False, "code": "invalid", "error": f"The connector's answer could not be read: {exc}"}
    finally:
        BiometricConnectorPunch.objects.filter(job_id=getattr(job, "pk", 0)).delete()


def wait_for_jobs(jobs: list[BiometricConnectorJob], sleep=time.sleep, poll: float = 1.0):
    """Yield each job as it closes, in the order they close. For the background thread of a manual fetch only: it waits by
    reading the database, so it never holds a web request, and the connector can report through the same server meanwhile.
    A job that has vanished (its device or its connector was deleted meanwhile) closes as failed instead of ending the run."""
    waiting = {j.pk: j for j in jobs}
    while waiting:
        expire_jobs()
        for pk in list(waiting):
            fresh = BiometricConnectorJob.objects.filter(pk=pk).first()
            if fresh is None:
                del waiting[pk]
                yield SimpleNamespace(
                    pk=pk,
                    status=BiometricConnectorJob.STATUS_FAILED,
                    error_code="removed",
                    error_message="The site connector or the device was removed while this was being read.",
                    result=None,
                )
            elif fresh.status not in BiometricConnectorJob.OPEN_STATUSES:
                del waiting[pk]
                yield fresh
        if waiting:
            sleep(poll)


def remote_check_result(device: BiometricDevice) -> dict:
    """A device behind a connector, as Biometric Device Status records a check: what its connector reports, in that page's
    own terms (the server cannot probe such a device, and must not claim it is unreachable for that reason)."""
    probe = remote_probe(device, timezone.now())
    if probe["ok"]:
        status = "reachable"
    elif probe["code"] in ("timeout", "refused", "unreachable", "auth"):
        status = probe["code"]
    else:
        status = "error"
    return {
        "status": status,
        "latencyMs": probe.get("latencyMs"),
        "icmp": None,
        "detail": probe.get("capacity"),
        "steps": [],
        "error": probe.get("error") or "",
    }
