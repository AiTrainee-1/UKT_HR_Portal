"""
Device health + unmatched-punch recording, shared by every ingest path.

Both the ADMS push path (adms_views) and the pull path (biometric_sync) call
into here, so the Attendance page's "Skipped", "Sync" and "Errors" views
report the same facts regardless of how a punch arrived. Keeping this in one
module is deliberate -the two paths have already diverged once (status-code
mapping), and health data drifting between them would be much harder to
notice than a wrong punch type.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.db.models import F
from django.utils import timezone

from .models import BiometricDevice, UnmatchedPunch

logger = logging.getLogger(__name__)

# How long a configured, enabled device may stay silent before the portal
# calls it a problem. Deliberately generous: a device only pushes when
# somebody actually punches, so a quiet lunch hour or an early shift end must
# not raise an alarm. Roughly "nothing all morning" rather than "nothing for
# a few minutes".
SILENT_AFTER_HOURS = 6


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


def record_device_push(serial: str) -> None:
    """Stamp 'this device just sent us something', for the live Sync status.

    Also self-registers the serial against a configured device the first time
    it's seen. Devices are configured by IP (for pull), but an ADMS push
    arrives carrying only a serial -so without this there is no link between
    the two, and the portal cannot say which configured device has gone
    quiet. When exactly one enabled device has no serial recorded yet, the
    incoming serial is attributed to it; with several ambiguous candidates
    nothing is guessed, and the push is tracked as an unknown device instead
    (which the Errors view reports, since an unrecognised device pushing
    attendance is itself worth knowing about).
    """
    try:
        serial = (serial or "").strip()
        if not serial:
            return
        now = timezone.now()

        dev = BiometricDevice.objects.filter(serial_number=serial).first()
        if dev:
            BiometricDevice.objects.filter(pk=dev.pk).update(last_push_at=now)
            return

        candidates = list(BiometricDevice.objects.filter(is_active=True, serial_number=""))
        if len(candidates) == 1:
            BiometricDevice.objects.filter(pk=candidates[0].pk).update(
                serial_number=serial, last_push_at=now,
            )
            logger.info("Auto-linked ADMS serial %s to device %r", serial, candidates[0].name)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to record device push for serial %r", serial)


def device_health() -> dict:
    """Per-device status for the Sync indicator and Errors view.

    Status meanings:
      live     -pushed within the silence window; data is flowing
      silent   -enabled and known, but nothing received for a while
      never    -enabled and configured, but has never sent anything
      disabled -switched off in Settings; excluded from problem counts
    """
    now = timezone.now()
    cutoff = now - timedelta(hours=SILENT_AFTER_HOURS)

    devices = []
    for d in BiometricDevice.objects.all():
        if not d.is_active:
            status = "disabled"
        elif d.last_push_at is None:
            status = "never"
        elif d.last_push_at >= cutoff:
            status = "live"
        else:
            status = "silent"

        devices.append({
            "id": d.id,
            "name": d.name,
            "host": d.host,
            "serialNumber": d.serial_number or None,
            "isActive": d.is_active,
            "status": status,
            "lastPushAt": d.last_push_at.isoformat() if d.last_push_at else None,
            "lastSyncedAt": d.last_synced_at.isoformat() if d.last_synced_at else None,
        })

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
        "checkedAt": now.isoformat(),
    }
