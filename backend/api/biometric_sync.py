"""
Shared biometric device pull-sync core.

Connects to a single ZKTeco-protocol device (host/port/password), pulls
attendance punches, and writes them to AttendanceLog + Attendance. Used by
both the `sync_biometric` management command (cron/manual CLI) and the
HR Settings "Sync Biometric" API — so device connection logic lives in
exactly one place instead of being duplicated per caller.

Two device sources, both supported together:
  • backend/.env  — BIOMETRIC_DEVICE_IP / PORT / PASSWORD (legacy, always works)
  • Settings → Devices — any number of BiometricDevice rows added from the UI
"""

import os
from datetime import date as date_type

from .models import Attendance, AttendanceLog, Employee


# Status codes sent by eSSL/ZKTeco devices
# 0 = Check-In,  1 = Check-Out,  255 = undefined (treat as Check-In)
_STATUS_MAP = {
    0: AttendanceLog.PUNCH_IN,
    1: AttendanceLog.PUNCH_OUT,
    4: AttendanceLog.PUNCH_IN,   # Overtime-In → treat as IN
    5: AttendanceLog.PUNCH_OUT,  # Overtime-Out → treat as OUT
}

ENV_DEVICE_ID = "env"


class BiometricSyncError(Exception):
    pass


def get_env_device() -> dict | None:
    """
    The legacy .env-configured device (BIOMETRIC_DEVICE_IP/PORT/PASSWORD).
    Always supported — Settings-managed devices are an additional layer on
    top, not a replacement. Returns None when the IP is not set.
    """
    host = os.environ.get("BIOMETRIC_DEVICE_IP", "").strip()
    if not host:
        return None
    return {
        "id": ENV_DEVICE_ID,
        "host": host,
        "port": int(os.environ.get("BIOMETRIC_DEVICE_PORT", "4370") or 4370),
        "password": int(os.environ.get("BIOMETRIC_DEVICE_PASSWORD", "0") or 0),
        "config_error": None,
        "label": "Default Device (.env)",
        "device": None,  # not a DB row
    }


def get_sync_targets(device_id=None) -> list[dict]:
    """
    Resolve which device(s) to sync. Each target is a dict:
      {id, host, port, password, label, device (BiometricDevice row or None)}

    device_id:
      None / "" / "all" → the .env device (if configured) + every enabled
                          Settings device, merged. Duplicate hosts are
                          de-duplicated (Settings row wins).
      "env"             → only the .env device.
      <int>             → only that Settings device (must be enabled).
      <list[int]>       → exactly those Settings devices (each must be
                          enabled) — the HR Portal's multi-select device
                          checklist sends this shape.
    Raises BiometricSyncError when the selection resolves to nothing.
    """
    from .models import BiometricDevice

    def db_target(d: BiometricDevice) -> dict:
        raw_password = (d.connection_config or {}).get("password", 0) or 0
        try:
            password = int(raw_password)
            config_error = None
        except (TypeError, ValueError):
            # Never let one bad device config crash the whole sync — surface it
            # as a per-device error instead (caught by the sync loop).
            password = 0
            config_error = (
                f"Comm password '{raw_password}' is not valid — it must be numeric "
                f"(the device's Comm Key, usually 0). Edit this device in Settings."
            )
        return {
            "id": d.id,
            "host": d.host,
            "port": d.port or 4370,
            "password": password,
            "config_error": config_error,
            "label": d.name,
            "device": d,
        }

    if device_id == ENV_DEVICE_ID:
        env = get_env_device()
        if not env:
            raise BiometricSyncError(
                "BIOMETRIC_DEVICE_IP is not set in backend/.env — configure it "
                "or pick a device added in Settings."
            )
        return [env]

    if isinstance(device_id, (list, tuple)):
        # The checklist can include the "env" pseudo-device alongside real
        # numeric Settings device ids — split them apart before resolving.
        wants_env = ENV_DEVICE_ID in device_id
        numeric_ids = [x for x in device_id if x != ENV_DEVICE_ID]
        try:
            ids = [int(x) for x in numeric_ids]
        except (TypeError, ValueError):
            raise BiometricSyncError("Invalid device selection")
        if not ids and not wants_env:
            raise BiometricSyncError("Select at least one device to sync")

        devices = {d.id: d for d in BiometricDevice.objects.filter(pk__in=ids, is_active=True)}
        missing = [i for i in ids if i not in devices]
        if missing:
            raise BiometricSyncError(f"Device(s) not found or disabled: {', '.join(map(str, missing))}")

        # Preserve the order the caller selected them in.
        targets = []
        for x in device_id:
            if x == ENV_DEVICE_ID:
                env = get_env_device()
                if env:
                    targets.append(env)
            else:
                targets.append(db_target(devices[int(x)]))
        return targets

    if device_id not in (None, "", "all"):
        try:
            d = BiometricDevice.objects.get(pk=int(device_id), is_active=True)
        except (BiometricDevice.DoesNotExist, ValueError, TypeError):
            raise BiometricSyncError("Device not found or disabled")
        return [db_target(d)]

    # "all" (and the no-selection default): .env device + every enabled Settings device
    targets = [db_target(d) for d in BiometricDevice.objects.filter(is_active=True).order_by("id")]
    env = get_env_device()
    if env and not any(t["host"] == env["host"] for t in targets):
        targets.insert(0, env)
    if not targets:
        raise BiometricSyncError(
            "No biometric device configured — set BIOMETRIC_DEVICE_IP in backend/.env "
            "or add a device in Settings → Devices."
        )
    return targets


def pull_from_device(host: str, port: int, password: int, date_from: date_type | None,
                      device_label: str = "") -> dict:
    """
    Connect to one device, pull attendance, write logs. Returns a summary dict:
    {"created": int, "skipped": int, "notFound": set[str], "total": int,
     "suspiciousDays": list[dict]}
    Raises BiometricSyncError on connection failure.
    """
    try:
        from zk import ZK
    except ImportError:
        raise BiometricSyncError("pyzk is not installed. Run: pip install pyzk")

    zk = ZK(host, port=port, timeout=10, password=password, force_udp=False)
    conn = None
    try:
        conn = zk.connect()
        conn.disable_device()
        raw_records = conn.get_attendance()
    except Exception as exc:
        raise BiometricSyncError(
            f"Could not connect to device at {host}:{port} — {exc}"
        )
    finally:
        if conn:
            try:
                conn.enable_device()
                conn.disconnect()
            except Exception:
                pass

    active_employees = list(Employee.objects.filter(status="active"))
    # Employee Code is the ONLY identifier ever used to match a device punch to
    # an employee — never name, never the internal database row id. A device
    # user_id must equal either the employee's assigned Biometric Device ID or
    # their Employee Code, exactly. Anything else is reported as "not found"
    # rather than guessed, so two different people can never be silently
    # merged onto one employee record.
    by_device_id = {
        str(e.biometric_device_id).strip(): e
        for e in active_employees if e.biometric_device_id
    }
    by_code = {str(e.employee_code): e for e in active_employees}

    created = 0
    skipped = 0
    not_found: set[str] = set()
    source_tag = f"biometric:{device_label}" if device_label else "biometric:essl"
    daily_punch_counts: dict[tuple[int, date_type], int] = {}

    for rec in raw_records:
        if date_from and rec.timestamp.date() < date_from:
            skipped += 1
            continue

        uid = str(rec.user_id).strip()
        emp = by_device_id.get(uid) or by_code.get(uid)

        if not emp:
            not_found.add(uid)
            skipped += 1
            continue

        punch_date = rec.timestamp.date()
        punch_time = rec.timestamp.time().replace(microsecond=0)
        punch_type = _STATUS_MAP.get(rec.status, AttendanceLog.PUNCH_IN)

        try:
            _, was_created = AttendanceLog.objects.get_or_create(
                employee=emp, date=punch_date, punch_time=punch_time, punch_type=punch_type,
                defaults={"source": source_tag},
            )
        except AttendanceLog.MultipleObjectsReturned:
            # A pre-existing duplicate for this exact punch (shouldn't happen now
            # that the table has a real unique constraint, but never let one bad
            # row abort every employee after it in this device's sync batch).
            was_created = False
        if was_created:
            created += 1
            try:
                Attendance.objects.update_or_create(
                    employee=emp, date=str(punch_date), defaults={"present": True},
                )
            except Attendance.MultipleObjectsReturned:
                # Same defensive skip as above — a real unique constraint now
                # backs this table too, so this should be unreachable.
                pass
            key = (emp.id, punch_date)
            daily_punch_counts[key] = daily_punch_counts.get(key, 0) + 1
        else:
            skipped += 1

    # A normal day has 2-4 punches (in/out, maybe a break). 6+ almost always
    # means the device has two different people sharing one Device User ID —
    # exactly the kind of silent identity merge Employee-Code-only matching
    # cannot detect on its own, since the device itself sent one uid for both.
    suspicious = [
        {"employeeId": emp_id, "date": str(d), "punches": count}
        for (emp_id, d), count in daily_punch_counts.items()
        if count >= 6
    ]

    return {
        "created": created, "skipped": skipped,
        "notFound": not_found, "total": len(raw_records),
        "suspiciousDays": suspicious,
    }
