"""
Device health + unmatched-punch recording, shared by every ingest path.

Both the ADMS push path (adms_views) and the pull path (biometric_sync) call
into here, so the Attendance page's "Skipped", "Sync" and "Errors" views
report the same facts regardless of how a punch arrived. Keeping this in one
module is deliberate -the two paths have already diverged once (status-code
mapping), and health data drifting between them would be much harder to
notice than a wrong punch type.

It is also where "is this device connected?" is decided (connection_state), so
the Sync indicator on the Attendance page and the Biometric Device Status page
can never disagree about it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.db.models import F, Q
from django.utils import timezone

from .models import BiometricDevice, BiometricUnknownPusher, UnmatchedPunch

logger = logging.getLogger(__name__)

# How long a configured, enabled device that does NOT poll us may stay silent before the portal calls it a
# problem. Deliberately generous: such a device only pushes when somebody actually punches, so a quiet lunch hour
# or an early shift end must not raise an alarm. Roughly "nothing all morning" rather than "nothing for a few
# minutes".
SILENT_AFTER_HOURS = 6

# A device that is online polls the server (GET /iclock/getrequest) about every 10 seconds, punch or no punch, so
# for one that does, three minutes of silence is a real disconnection, not a quiet hour. A device counts as one that
# polls once it has been heard polling in the last day.
HEARTBEAT_FRESH_SECONDS = 180
HEARTBEAT_EXPECTED_WITHIN_HOURS = 24
# The device polls every ~10 s; writing each poll to the database would be pointless, so a poll is recorded at
# most this often per device.
HEARTBEAT_WRITE_EVERY_SECONDS = 30

# What a device's own "here are my settings" upload may add to reported_config: a whitelist, with short values, so
# a malformed or hostile request cannot fill the table with junk.
REPORTED_CONFIG_KEYS = (
    "~DeviceName",
    "~Platform",
    "~SerialNumber",
    "FWVersion",
    "FirmVer",
    "MAC",
    "IPAddress",
    "NetMask",
    "GATEIPAddress",
    "DNS",
    "TZAdj",
    "TimeZone",
    "pushver",
    "language",
    "DeviceType",
    "~ZKFPVersion",
)
REPORTED_CONFIG_VALUE_MAX = 80


def client_ip(request) -> str:
    """The address a request came from: the first hop of X-Forwarded-For (Railway's proxy sets it), else the socket.
    Informational only (it is shown on the status page), so it is not trusted for anything."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() if forwarded else request.META.get("REMOTE_ADDR", "")
    return (ip or "")[:64]


def record_unmatched_punch(device_user_id: str, device_serial: str, punch_dt: datetime) -> None:
    """Upsert one aggregated 'this device ID has no employee' row.

    Aggregated per (user id, device) rather than one row per punch: the same
    unknown ID punches several times a day, every day, and HR needs the fact
    once with a count -not thousands of identical rows.

    Never raises: this runs inside the ingest loop, and failing to record a
    diagnostic must never abort ingesting the punches that DID match.
    """
    try:
        device_user_id = str(device_user_id).strip()
        if not device_user_id:
            return

        label = ""
        dev = BiometricDevice.objects.filter(serial_number=device_serial).first() if device_serial else None
        if dev:
            label = dev.name

        row, created = UnmatchedPunch.objects.get_or_create(
            device_user_id=device_user_id,
            device_serial=device_serial or "",
            defaults={
                "device_label": label,
                "punch_count": 1,
                "last_punch_date": punch_dt.date(),
                "last_punch_time": punch_dt.time().replace(microsecond=0),
            },
        )
        if not created:
            UnmatchedPunch.objects.filter(pk=row.pk).update(
                punch_count=F("punch_count") + 1,
                last_punch_date=punch_dt.date(),
                last_punch_time=punch_dt.time().replace(microsecond=0),
                last_seen_at=timezone.now(),
                # An ID that starts punching again after being dismissed is
                # worth re-surfacing rather than staying hidden forever.
                resolved=False,
                device_label=label or row.device_label,
            )
    except Exception:  # noqa: BLE001 -diagnostics must not break ingest
        logger.exception("Failed to record unmatched punch for %r", device_user_id)


def record_device_push(serial: str, remote_ip: str = "") -> None:
    """Stamp 'this device just sent us something' (any request to /iclock/cdata), for the live Sync status.
    Kept under its old name for the callers that predate record_adms_contact."""
    record_adms_contact(serial, kind="push", remote_ip=remote_ip)


def record_adms_contact(serial: str, *, kind: str = "push", remote_ip: str = "") -> None:
    """Note that the device with this serial number just talked to the ADMS listener.

    kind "push"      -any request to /iclock/cdata (handshake, options, attendance): last_push_at and the heartbeat.
    kind "heartbeat" -the device polling for commands (/iclock/getrequest, /iclock/devicecmd): the heartbeat only,
                       and written at most every HEARTBEAT_WRITE_EVERY_SECONDS.

    Also self-registers the serial against a configured device the first time it's seen. Devices are configured by
    IP (for pull), but an ADMS push arrives carrying only a serial -so without this there is no link between the
    two, and the portal cannot say which configured device has gone quiet. When exactly one enabled device has no
    serial recorded yet, the incoming serial is attributed to it; with several ambiguous candidates nothing is
    guessed, and the contact is kept as an unknown pusher instead (shown on the Biometric Device Status page, since
    an unrecognised device sending attendance is itself worth knowing about).

    Never raises: it runs on every device request, and a failure to record must not make the device retry or stop.
    """
    try:
        serial = (serial or "").strip()
        if not serial:
            return
        now = timezone.now()
        ip = (remote_ip or "")[:64]

        if kind == "heartbeat":
            stale = now - timedelta(seconds=HEARTBEAT_WRITE_EVERY_SECONDS)
            updated = (
                BiometricDevice.objects.filter(serial_number=serial)
                .filter(Q(last_heartbeat_at__isnull=True) | Q(last_heartbeat_at__lt=stale))
                .update(last_heartbeat_at=now, **({"last_remote_ip": ip} if ip else {}))
            )
            if updated or BiometricDevice.objects.filter(serial_number=serial).exists():
                return
        else:
            fields: dict = {"last_push_at": now, "last_heartbeat_at": now}
            if ip:
                fields["last_remote_ip"] = ip
            if BiometricDevice.objects.filter(serial_number=serial).update(**fields):
                return

        # Not a known serial. Link it to the one configured device that is still waiting for one...
        candidates = list(BiometricDevice.objects.filter(is_active=True, serial_number=""))
        if len(candidates) == 1:
            BiometricDevice.objects.filter(pk=candidates[0].pk).update(
                serial_number=serial,
                last_push_at=now,
                last_heartbeat_at=now,
                **({"last_remote_ip": ip} if ip else {}),
            )
            logger.info("Auto-linked ADMS serial %s to device %r", serial, candidates[0].name)
            return
        # ...otherwise remember it as a device the portal does not know.
        _note_unknown_pusher(serial, now, ip)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to record device contact for serial %r", serial)


def _note_unknown_pusher(serial: str, now, ip: str) -> None:
    """Upsert the unknown-pusher row, writing at most once a minute per serial."""
    stale = now - timedelta(seconds=60)
    updated = BiometricUnknownPusher.objects.filter(serial_number=serial, last_seen_at__lt=stale).update(
        last_seen_at=now, last_remote_ip=ip, contact_count=F("contact_count") + 1
    )
    if not updated:
        BiometricUnknownPusher.objects.get_or_create(
            serial_number=serial,
            defaults={"first_seen_at": now, "last_seen_at": now, "last_remote_ip": ip, "contact_count": 1},
        )


def record_attlog_result(serial: str, *, processed: int, last_punch_dt: datetime | None, unparsable: int) -> None:
    """An attendance push was handled: stamp when data last arrived and the newest punch in it, and note (or clear)
    the one thing that can go wrong on the device's side of it, lines the server could not read. Never raises."""
    try:
        serial = (serial or "").strip()
        if not serial:
            return
        now = timezone.now()
        dev = BiometricDevice.objects.filter(serial_number=serial).first()
        if dev is None:
            BiometricUnknownPusher.objects.filter(serial_number=serial).update(punch_count=F("punch_count") + processed)
            return
        fields: dict = {"last_data_at": now}
        if last_punch_dt is not None:
            newest = (last_punch_dt.date(), last_punch_dt.time().replace(microsecond=0))
            stored = (dev.last_punch_date, dev.last_punch_time) if dev.last_punch_date else None
            if stored is None or newest > (stored[0], stored[1] or newest[1]):
                fields["last_punch_date"], fields["last_punch_time"] = newest
        if unparsable:
            fields["last_error"] = (
                f"{unparsable} attendance line{'' if unparsable == 1 else 's'} in the last push could not be read "
                "(unexpected format), so those punches were not recorded."
            )
            fields["last_error_at"] = now
        elif dev.last_error:
            fields["last_error"] = ""
        BiometricDevice.objects.filter(pk=dev.pk).update(**fields)
    except Exception:  # noqa: BLE001 -diagnostics must not break ingest
        logger.exception("Failed to record attendance push for serial %r", serial)


def record_reported_config(serial: str, params: dict) -> None:
    """Keep the settings a device reports about itself (from its handshake query string or its options upload).
    Only whitelisted keys, trimmed, merged over what was reported before. Never raises."""
    try:
        serial = (serial or "").strip()
        if not serial or not params:
            return
        picked = {
            k: str(v).strip()[:REPORTED_CONFIG_VALUE_MAX]
            for k, v in params.items()
            if k in REPORTED_CONFIG_KEYS and str(v).strip()
        }
        if not picked:
            return
        dev = BiometricDevice.objects.filter(serial_number=serial).first()
        if dev is None:
            return
        merged = {**(dev.reported_config or {}), **picked}
        if merged != (dev.reported_config or {}):
            BiometricDevice.objects.filter(pk=dev.pk).update(reported_config=merged, reported_config_at=timezone.now())
    except Exception:  # noqa: BLE001
        logger.exception("Failed to record reported config for serial %r", serial)


def parse_options_body(body: str) -> dict:
    """The key=value pairs of an ADMS options upload. Devices separate them with commas, newlines or ampersands."""
    pairs: dict = {}
    for chunk in body.replace("&", "\n").replace(",", "\n").splitlines():
        if "=" in chunk:
            key, _, value = chunk.partition("=")
            pairs[key.strip()] = value.strip()
    return pairs


def last_contact(device: BiometricDevice) -> datetime | None:
    """The newest time we heard anything from the device (a poll or a push)."""
    stamps = [s for s in (device.last_heartbeat_at, device.last_push_at) if s is not None]
    return max(stamps) if stamps else None


def connection_state(device: BiometricDevice, now: datetime | None = None) -> str:
    """The one place that decides whether a device is connected: 'disabled', 'never', 'connected' or 'disconnected'.

    A device that polls us (it has been heard polling in the last day) is connected while the poll is fresh, three
    minutes. One that does not poll is judged by its last push, with the generous quiet-hours window."""
    if not device.is_active:
        return "disabled"
    if last_contact(device) is None:
        return "never"
    now = now or timezone.now()
    heartbeat_age = (now - device.last_heartbeat_at).total_seconds() if device.last_heartbeat_at else None
    if heartbeat_age is not None and heartbeat_age <= HEARTBEAT_FRESH_SECONDS:
        return "connected"
    polls = heartbeat_age is not None and heartbeat_age <= HEARTBEAT_EXPECTED_WITHIN_HOURS * 3600
    if not polls and device.last_push_at is not None:
        if (now - device.last_push_at).total_seconds() <= SILENT_AFTER_HOURS * 3600:
            return "connected"
    return "disconnected"


def device_health() -> dict:
    """Per-device status for the Sync indicator and Errors view.

    Status meanings:
      live     -connected: polling us, or (for a device that does not poll) pushed within the silence window
      silent   -enabled and known, but gone quiet
      never    -enabled and configured, but has never sent anything
      disabled -switched off in Settings; excluded from problem counts
    """
    now = timezone.now()
    names = {"connected": "live", "disconnected": "silent", "never": "never", "disabled": "disabled"}

    devices = []
    for d in BiometricDevice.objects.all():
        contact = last_contact(d)
        devices.append(
            {
                "id": d.id,
                "name": d.name,
                "host": d.host,
                "serialNumber": d.serial_number or None,
                "isActive": d.is_active,
                "status": names[connection_state(d, now)],
                "lastPushAt": d.last_push_at.isoformat() if d.last_push_at else None,
                "lastContactAt": contact.isoformat() if contact else None,
                "lastSyncedAt": d.last_synced_at.isoformat() if d.last_synced_at else None,
            }
        )

    problems = [d for d in devices if d["status"] in ("silent", "never")]
    live = [d for d in devices if d["status"] == "live"]

    return {
        "devices": devices,
        "liveCount": len(live),
        "problemCount": len(problems),
        # "Is the pipeline working at all right now" -drives the blinking
        # live dot. False when every enabled device has gone quiet.
        "isLive": len(live) > 0,
        "silentAfterHours": SILENT_AFTER_HOURS,
        "heartbeatFreshSeconds": HEARTBEAT_FRESH_SECONDS,
        "checkedAt": now.isoformat(),
    }
