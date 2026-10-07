"""
The Biometric Device Status page: gathers what the server knows about every configured device into one payload.

Two kinds of evidence, kept apart on purpose because they answer different questions:

  RECEIVED  what the device sends to this server (ADMS push: polls, attendance data, the sender's address). Written
            by adms_views / device_health. This is the truth about "is it connected to the deployed API".
  REACHED   what this server can reach (a connection check: ping, port, handshake, the device's own settings).
            Written by run_check below. From the cloud this fails for a device on a private LAN address, and that
            is expected: it is shown as "unreachable from this server", not as a broken device.

device_diagnosis.diagnose turns both into a layer-by-layer verdict per device.
"""

from __future__ import annotations

import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import median

from django.core.exceptions import DisallowedHost
from django.db.models import Count, Sum
from django.utils import timezone

from .clock import FACTORY_TZ, ist_now, ist_today
from .device_diagnosis import SLOW_PUSH_SECONDS, diagnose
from .device_health import (
    HEARTBEAT_EXPECTED_WITHIN_HOURS,
    HEARTBEAT_FRESH_SECONDS,
    SILENT_AFTER_HOURS,
    connection_state,
    last_contact,
)
from .device_probe import (
    AUTH_FAILED,
    DNS_FAILED,
    ERROR,
    REACHABLE,
    REFUSED,
    TIMEOUT,
    UNREACHABLE,
    is_private_host,
    run_checks,
)
from .models import AttendanceLog, BiometricDevice, BiometricProbe, BiometricUnknownPusher, UnmatchedPunch

PROBE_HISTORY_KEEP = 30
# A connection check older than this is shown, but no longer used as evidence in the diagnosis: the device may
# have been rebooted, recabled or reconfigured since.
PROBE_FRESH_HOURS = 6
# An error older than this is history, not a current problem.
ERROR_RECENT_HOURS = 24
SLOW_LATENCY_MS = 250
# The ATTLOG delay is measured over punches that arrived in this window.
DELAY_WINDOW_HOURS = 24
DELAY_SAMPLE_LIMIT = 6000

STATUS_LABELS = {
    "connected": "Connected",
    "disconnected": "Disconnected",
    "error": "Error",
    "disabled": "Disabled",
}
REACH_LABELS = {
    "reachable": "Reachable",
    "unreachable": "Unreachable",
    "refused": "Port closed",
    "auth": "Wrong password",
    "error": "Error",
    "unchecked": "Not checked",
}


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _age(value, now) -> float | None:
    return round((now - value).total_seconds(), 1) if value else None


def server_info(request, probe_rows: list[BiometricProbe]) -> dict:
    """What this server is and what a device must be told to reach it."""
    env = os.environ
    on_cloud = bool(env.get("RAILWAY_ENVIRONMENT") or env.get("RAILWAY_PROJECT_ID") or env.get("RAILWAY_SERVICE_ID"))
    host = ""
    scheme = "http"
    if request is not None:
        try:
            host = request.get_host()
        except DisallowedHost:  # a request that got this far has passed the host check; this is only for direct callers
            host = ""
        forwarded = request.META.get("HTTP_X_FORWARDED_PROTO", "")
        scheme = "https" if (request.is_secure() or forwarded.split(",")[0].strip() == "https") else "http"
    bare_host = host.split(":")[0]
    ok_probes = [p for p in probe_rows if p.status == REACHABLE]
    device_settings = {
        "serverMode": "ADMS",
        "serverAddress": bare_host,
        "serverPort": 443 if scheme == "https" else 80,
        "https": scheme == "https",
        "dnsHint": "8.8.8.8",
        "note": None,
    }
    if not on_cloud:
        # A local server is not what the devices should point at. Show what they ARE pointed at (read from them by a
        # check), which is the deployed server's address, rather than this machine's own.
        urls = Counter((p.detail or {}).get("serverUrl") for p in ok_probes if (p.detail or {}).get("serverUrl"))
        device_settings.update(
            serverAddress=urls.most_common(1)[0][0] if urls else "",
            serverPort=443,
            https=True,
            note="This is a local server: devices must point at the deployed server, not at this one.",
        )
    return {
        "deployment": "railway" if on_cloud else "local",
        "environment": env.get("RAILWAY_ENVIRONMENT_NAME") or env.get("RAILWAY_ENVIRONMENT") or None,
        "commit": (env.get("RAILWAY_GIT_COMMIT_SHA") or "")[:7] or None,
        "host": host,
        "scheme": scheme,
        "serverTimeIst": ist_now().replace(microsecond=0).isoformat(),
        # what to type into the device (Menu → COMM. → Cloud Server Setting)
        "deviceSettings": device_settings,
        "admsUrls": [f"{scheme}://{host}/iclock/cdata", f"{scheme}://{host}/iclock/getrequest"] if host else [],
        # can this server see the factory network at all? None until a check has been run
        "canReachLan": (True if ok_probes else (False if probe_rows else None)),
    }


def _latest_probes(device_ids: list[int]) -> dict[int, BiometricProbe]:
    rows = (
        BiometricProbe.objects.filter(device_id__in=device_ids)
        .order_by("device_id", "-checked_at")
        .distinct("device_id")
    )
    return {p.device_id: p for p in rows}


def _probe_dict(probe: BiometricProbe | None, now) -> dict | None:
    if probe is None:
        return None
    ping = next((s for s in (probe.steps or []) if s.get("key") == "ping"), None)
    return {
        "checkedAt": _iso(probe.checked_at),
        "ageSeconds": _age(probe.checked_at, now),
        "status": probe.status,
        "latencyMs": probe.latency_ms,
        # ok is None when this server has no ping program: the page then shows the port check instead
        "ping": {"available": ping["ok"] is not None, "ok": bool(ping["ok"]), "ms": probe.icmp_ms} if ping else None,
        "error": probe.error,
        "detail": probe.detail,
        "steps": probe.steps or [],
        "checkedFrom": probe.checked_from or None,
    }


def _punches_today(devices: list[BiometricDevice]) -> dict[int, int]:
    """Today's punches per device: the ADMS ones are tagged with the serial, the pulled ones with the device name."""
    by_serial = {d.serial_number: d.id for d in devices if d.serial_number}
    by_name = {d.name: d.id for d in devices}
    counts: dict[int, int] = defaultdict(int)
    rows = (
        AttendanceLog.objects.filter(date=ist_today(), source__startswith="biometric:")
        .values("source")
        .annotate(n=Count("id"))
        .order_by()
    )
    for row in rows:
        source = row["source"]
        if source.startswith("biometric:adms:"):
            device_id = by_serial.get(source[len("biometric:adms:") :])
        else:
            device_id = by_name.get(source[len("biometric:") :])
        if device_id:
            counts[device_id] += row["n"]
    return counts


def _push_delays(devices: list[BiometricDevice], now) -> dict[int, dict]:
    """How long a punch takes to reach the server: the gap between when it happened (the device's clock) and when
    it arrived, per device, over the last day. A realtime device is a few seconds; a device that batches, or has a
    poor link, shows minutes or hours."""
    by_serial = {d.serial_number: d.id for d in devices if d.serial_number}
    if not by_serial:
        return {}
    since = now - timedelta(hours=DELAY_WINDOW_HOURS)
    rows = (
        AttendanceLog.objects.filter(source__startswith="biometric:adms:", created_at__gte=since)
        .order_by("-created_at")
        .values_list("source", "date", "punch_time", "created_at")[:DELAY_SAMPLE_LIMIT]
    )
    lags: dict[int, list[float]] = defaultdict(list)
    for source, day, at, created in rows:
        device_id = by_serial.get(source[len("biometric:adms:") :])
        if device_id is None:
            continue
        arrived = created.astimezone(FACTORY_TZ).replace(tzinfo=None)
        lag = (arrived - datetime.combine(day, at)).total_seconds()
        lags[device_id].append(max(lag, 0.0))
    out = {}
    for device_id, values in lags.items():
        mid = median(values)
        out[device_id] = {
            "medianSeconds": round(mid, 1),
            "maxSeconds": round(max(values), 1),
            "samples": len(values),
            "verdict": "realtime" if mid <= SLOW_PUSH_SECONDS else ("delayed" if mid <= 1800 else "batched"),
        }
    return out


def _skipped_by_serial() -> dict[str, dict]:
    rows = (
        UnmatchedPunch.objects.filter(resolved=False)
        .values("device_serial")
        .annotate(ids=Count("id"), punches=Sum("punch_count"))
        .order_by()
    )
    return {r["device_serial"]: {"ids": r["ids"], "punches": r["punches"] or 0} for r in rows}


def _recent(stamp, now, hours=ERROR_RECENT_HOURS) -> bool:
    return stamp is not None and (now - stamp) <= timedelta(hours=hours)


def _device_errors(d: BiometricDevice, probe: BiometricProbe | None, now) -> list[dict]:
    """Real errors only: things that went wrong with the device or the data. A failed attempt to REACH a device on a
    private LAN from a cloud server is not an error, it is the expected result, and shows as 'unreachable'."""
    errors = []
    if d.last_error and _recent(d.last_error_at, now):
        errors.append({"source": "push", "message": d.last_error, "at": _iso(d.last_error_at)})
    if probe is not None and probe.status in (AUTH_FAILED, ERROR) and _recent(probe.checked_at, now):
        errors.append({"source": "check", "message": probe.error, "at": _iso(probe.checked_at)})
    if (
        d.last_sync_error
        and _recent(d.last_sync_error_at, now)
        and "could not reach device" not in d.last_sync_error.lower()
    ):
        errors.append({"source": "sync", "message": d.last_sync_error, "at": _iso(d.last_sync_error_at)})
    return errors


def _reach(probe: BiometricProbe | None) -> str:
    if probe is None:
        return "unchecked"
    if probe.status == REACHABLE:
        return "reachable"
    if probe.status in (TIMEOUT, UNREACHABLE, DNS_FAILED):
        return "unreachable"
    if probe.status == REFUSED:
        return "refused"
    if probe.status == AUTH_FAILED:
        return "auth"
    return "error"


def build_status(request=None, now=None) -> dict:
    now = now or timezone.now()
    devices = list(BiometricDevice.objects.all().order_by("name"))
    ids = [d.id for d in devices]
    probes = _latest_probes(ids)
    fresh_cutoff = now - timedelta(hours=PROBE_FRESH_HOURS)
    info = server_info(request, list(probes.values()))
    punches = _punches_today(devices)
    delays = _push_delays(devices, now)
    skipped = _skipped_by_serial()
    lan_any = any(p.status == REACHABLE and p.checked_at >= fresh_cutoff for p in probes.values())

    rows = []
    for d in devices:
        state = connection_state(d, now)
        probe = probes.get(d.id)
        errors = _device_errors(d, probe, now)
        status = state if state in ("connected", "disabled") else ("error" if errors else "disconnected")
        fresh_probe = probe is not None and probe.checked_at >= fresh_cutoff
        probe_view = _probe_dict(probe, now)
        delay = delays.get(d.id)
        contact = last_contact(d)
        diagnosis = diagnose(
            {
                "state": state,
                "host": d.host,
                "port": d.port,
                "configuredSerial": d.serial_number,
                "lastContactAgeSeconds": _age(contact, now),
                "remoteIp": d.last_remote_ip,
                "lastError": errors[0]["message"] if errors and errors[0]["source"] == "push" else "",
                "probe": probe_view if fresh_probe else None,
                "reported": d.reported_config,
                "serverOnCloud": info["deployment"] == "railway",
                "serverHost": info["host"],
                "serverScheme": info["scheme"],
                "privateAddress": is_private_host(d.host),
                "lanAnyReachable": lan_any,
                "pushDelaySeconds": delay["medianSeconds"] if delay else None,
            }
        )
        skip = skipped.get(d.serial_number) if d.serial_number else None
        rows.append(
            {
                "id": d.id,
                "name": d.name,
                "deviceType": d.device_type,
                "host": d.host,
                "port": d.port or 4370,
                "serialNumber": d.serial_number or None,
                "isActive": d.is_active,
                "privateAddress": is_private_host(d.host),
                "status": status,
                "statusLabel": STATUS_LABELS[status],
                "neverConnected": state == "never",
                "reach": _reach(probe),
                "reachLabel": REACH_LABELS[_reach(probe)],
                "reachIsFresh": fresh_probe,
                "headline": diagnosis["headline"],
                "action": diagnosis["action"],
                "diagnosis": diagnosis,
                "errors": errors,
                "push": {
                    "lastContactAt": _iso(contact),
                    "lastHeartbeatAt": _iso(d.last_heartbeat_at),
                    "lastDataAt": _iso(d.last_data_at),
                    "lastPushAt": _iso(d.last_push_at),
                    "lastPunch": (
                        {
                            "date": str(d.last_punch_date),
                            "time": d.last_punch_time.strftime("%H:%M:%S") if d.last_punch_time else None,
                        }
                        if d.last_punch_date
                        else None
                    ),
                    "remoteIp": d.last_remote_ip or None,
                    "punchesToday": punches.get(d.id, 0),
                    "delay": delay,
                    "reportedConfig": d.reported_config,
                    "reportedConfigAt": _iso(d.reported_config_at),
                    "skippedIds": skip["ids"] if skip else 0,
                    "skippedPunches": skip["punches"] if skip else 0,
                },
                "pull": {
                    "lastSyncAt": _iso(d.last_synced_at),
                    "lastSyncError": d.last_sync_error or None,
                    "lastSyncErrorAt": _iso(d.last_sync_error_at),
                    "lastReachableAt": _iso(d.last_reachable_at),
                    "probe": probe_view,
                },
            }
        )

    active = [r for r in rows if r["isActive"]]
    summary = {
        "configured": len(rows),
        "enabled": len(active),
        "connected": sum(1 for r in active if r["status"] == "connected"),
        "disconnected": sum(1 for r in active if r["status"] == "disconnected"),
        "error": sum(1 for r in active if r["status"] == "error"),
        "unreachable": sum(1 for r in active if r["reach"] in ("unreachable", "refused")),
        "neverConnected": sum(1 for r in active if r["neverConnected"]),
        "disabled": len(rows) - len(active),
        "punchesToday": sum(r["push"]["punchesToday"] for r in rows),
    }
    newest = [d for d in devices if d.last_punch_date]
    unknown = [
        {
            "serialNumber": u.serial_number,
            "firstSeenAt": _iso(u.first_seen_at),
            "lastSeenAt": _iso(u.last_seen_at),
            "lastRemoteIp": u.last_remote_ip or None,
            "contacts": u.contact_count,
            "punches": u.punch_count,
        }
        for u in BiometricUnknownPusher.objects.all()[:20]
    ]
    return {
        "generatedAt": _iso(now),
        "server": info,
        "summary": summary,
        "devices": rows,
        "unknownPushers": unknown,
        "lastPunchAt": (
            max(f"{d.last_punch_date} {d.last_punch_time or '00:00:00'}" for d in newest) if newest else None
        ),
        "thresholds": {
            "heartbeatFreshSeconds": HEARTBEAT_FRESH_SECONDS,
            "heartbeatExpectedWithinHours": HEARTBEAT_EXPECTED_WITHIN_HOURS,
            "silentAfterHours": SILENT_AFTER_HOURS,
            "slowLatencyMs": SLOW_LATENCY_MS,
            "probeFreshHours": PROBE_FRESH_HOURS,
        },
    }


def probe_history(device: BiometricDevice, limit: int = PROBE_HISTORY_KEEP) -> list[dict]:
    return [
        {
            "id": p.id,
            "checkedAt": _iso(p.checked_at),
            "status": p.status,
            "latencyMs": p.latency_ms,
            "icmpMs": p.icmp_ms,
            "error": p.error or None,
            "checkedFrom": p.checked_from or None,
        }
        for p in device.probes.all()[:limit]
    ]


def _password_of(device: BiometricDevice) -> int | None:
    raw = (device.connection_config or {}).get("password", 0) or 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def run_check(device_ids: list[int] | None = None) -> dict[int, dict]:
    """Check the given devices (every enabled one when none are named) from this server, and keep the results.
    Returns {device id: probe result}. Raises device_probe.CheckBusy when a check is already running."""
    qs = BiometricDevice.objects.all()
    qs = qs.filter(pk__in=device_ids) if device_ids else qs.filter(is_active=True)
    devices = list(qs)
    targets = []
    results: dict[int, dict] = {}
    for d in devices:
        password = _password_of(d)
        if password is None:
            results[d.id] = {
                "status": ERROR,
                "latencyMs": None,
                "icmp": None,
                "detail": None,
                "steps": [],
                "error": "The Comm password in Settings → Devices is not a number (it is the device's Comm Key, usually 0).",
            }
            continue
        targets.append({"id": d.id, "host": d.host, "port": d.port, "password": password})
    if targets:
        results.update(run_checks(targets, ist_now()))
    _save_results(devices, results)
    return results


def _save_results(devices: list[BiometricDevice], results: dict[int, dict]) -> None:
    now = timezone.now()
    source = (
        os.environ.get("RAILWAY_PUBLIC_DOMAIN") or os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or ""
    )
    for d in devices:
        result = results.get(d.id)
        if result is None:
            continue
        icmp = result.get("icmp") or {}
        BiometricProbe.objects.create(
            device=d,
            checked_at=now,
            status=result["status"],
            latency_ms=result.get("latencyMs"),
            icmp_ms=icmp.get("ms"),
            error=(result.get("error") or "")[:1000],
            detail=result.get("detail"),
            steps=result.get("steps") or None,
            checked_from=source[:120],
        )
        if result["status"] == REACHABLE:
            BiometricDevice.objects.filter(pk=d.pk).update(last_reachable_at=now)
        keep = list(d.probes.order_by("-checked_at").values_list("id", flat=True)[:PROBE_HISTORY_KEEP])
        if len(keep) == PROBE_HISTORY_KEEP:
            d.probes.exclude(id__in=keep).delete()
