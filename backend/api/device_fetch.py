"""
Device Control → Data Fetch: pull punches off the biometric devices by hand and put them into the HRMS.

The HRMS already takes punches in automatically (the devices push them, and the Sync Biometric button and Auto Sync
rules pull them). This is the manual version for when someone needs to be sure: choose devices and a date range, look
at what an update WOULD do (a preview changes nothing), then run it.

It does not change how a punch is recorded. A new punch is written by biometric_sync._ingest_punches, the very path the
Sync Biometric button uses, and matched to an employee by the same rule (Employee Code, active employees only); the
status codes mean what they mean there. Two things differ, both on purpose:

  * Punches the HRMS already has are recognised before the write and not offered to it again, so a range the portal
    already holds costs one query rather than a write per punch.
  * IDs with no employee are reported in the run's results, not added to the "Skipped" list a pull or a push keeps:
    reading the same range twice must not count the same punches twice there.

A run is a row (BiometricFetchRun) that a background thread fills in device by device. The page polls the row, so it
works the same whichever web worker answers the poll, and it stays as a history. Only one run at a time, because a
terminal serves one session.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

from django.db import connection, transaction
from django.utils import timezone

from .audit_utils import log_action
from .biometric_sync import _STATUS_MAP, _active_employee_lookup, _ingest_punches
from .clock import ist_today
from .device_client import LOG_READ_DEADLINE_SECONDS, DeviceUnavailable, open_session
from .device_directory import employee_name, password_of
from .models import AttendanceLog, BiometricDevice, BiometricDeviceUser, BiometricFetchRun

logger = logging.getLogger(__name__)

STALE_RUN_MINUTES = 5  # a run beats its heart every HEARTBEAT_SECONDS; five quiet minutes means it is gone
HEARTBEAT_SECONDS = 30
ADVISORY_LOCK_KEY = 71400271  # one fetch is started at a time, across web workers
READ_PARALLELISM = 3
UNMATCHED_SHOWN = 50
SAMPLES_SHOWN = 10

RANGE_LABELS = {
    "today": "Today",
    "yesterday": "Yesterday",
    "last7": "Last 7 days",
    "this_month": "This month",
    "last_month": "Last month",
    "all": "Everything on the device",
}


class FetchConflict(Exception):
    """Another run, or the Attendance page's own sync, is using the devices."""


def resolve_range(preset: str, date_from=None, date_to=None, today: date | None = None):
    """(from, to, label) for a preset or a custom range. None bounds mean no limit."""
    today = today or ist_today()
    if preset == "today":
        return today, today, RANGE_LABELS[preset]
    if preset == "yesterday":
        day = today - timedelta(days=1)
        return day, day, RANGE_LABELS[preset]
    if preset == "last7":
        return today - timedelta(days=6), today, RANGE_LABELS[preset]
    if preset == "this_month":
        return today.replace(day=1), today, RANGE_LABELS[preset]
    if preset == "last_month":
        end = today.replace(day=1) - timedelta(days=1)
        return end.replace(day=1), end, RANGE_LABELS[preset]
    if preset == "all":
        return None, None, RANGE_LABELS[preset]
    if preset == "custom":
        try:
            start = date.fromisoformat(str(date_from))
            end = date.fromisoformat(str(date_to))
        except ValueError as exc:
            raise ValueError("Choose a valid start and end date.") from exc
        if start > end:
            raise ValueError("The start date is after the end date.")
        label = (
            start.strftime("%d %b %Y") if start == end else f"{start.strftime('%d %b %Y')} – {end.strftime('%d %b %Y')}"
        )
        return start, end, label
    raise ValueError("Choose a date range.")


def _expire_stale() -> None:
    cutoff = timezone.now() - timedelta(minutes=STALE_RUN_MINUTES)
    BiometricFetchRun.objects.filter(status="running", updated_at__lt=cutoff).update(
        status="failed",
        error="The run stopped without finishing (the server was restarted while it ran).",
        finished_at=timezone.now(),
    )


def start_run(request, device_ids, preset: str, date_from=None, date_to=None, apply: bool = False) -> BiometricFetchRun:
    """Create a run and start it on a background thread. FetchConflict if the devices are already in use."""
    from . import sync_progress

    start, end, label = resolve_range(preset, date_from, date_to)
    devices = list(BiometricDevice.objects.filter(pk__in=device_ids or [], is_active=True).order_by("name"))
    if not devices:
        raise ValueError("Choose at least one device that is switched on.")
    _expire_stale()
    prune_history()
    if sync_progress.is_running():
        raise FetchConflict("A biometric sync started from the Attendance page is running. Wait for it to finish.")

    user = getattr(request, "jwt_user", {}) or {}
    with transaction.atomic():
        # check and insert under one lock, so two clicks (or two people) cannot both start a run
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", [ADVISORY_LOCK_KEY])
        if BiometricFetchRun.objects.filter(status="running").exists():
            raise FetchConflict("A fetch is already running. Wait for it to finish.")
        run = BiometricFetchRun.objects.create(
            mode=BiometricFetchRun.MODE_UPDATE if apply else BiometricFetchRun.MODE_PREVIEW,
            status="running",
            started_by=user.get("name") or user.get("username") or "",
            range_label=label,
            date_from=start,
            date_to=end,
            device_ids=[d.pk for d in devices],
            results=[
                {"deviceId": d.pk, "deviceName": d.name, "status": "reading", "phase": "Connecting to the device"}
                for d in devices
            ],
        )
    log_action(
        request,
        "update",
        "attendance",
        record_id=run.pk,
        description=(
            f"Started a manual biometric {'fetch that updates punches' if apply else 'fetch preview'} "
            f"({label}) of {', '.join(d.name for d in devices)}"
        ),
    )

    threading.Thread(target=_background, args=(run.pk,), name=f"biometric-fetch-{run.pk}", daemon=True).start()
    return run


def _heartbeat(run_id: int, stop: threading.Event) -> None:
    """While a run is going, keep saying so: a long write to the HRMS has no other sign of life, and a run that has gone
    quiet (the server was restarted) must be told apart from one that is only busy."""
    try:
        while not stop.wait(HEARTBEAT_SECONDS):
            BiometricFetchRun.objects.filter(pk=run_id, status="running").update(updated_at=timezone.now())
    finally:
        connection.close()


def _background(run_id: int) -> None:
    """The thread's body: run the fetch; if it dies, say so on the run (a thread that dies silently would leave the run
    "running" until it is expired); and give the thread's own database connection back."""
    stop = threading.Event()
    beat = threading.Thread(target=_heartbeat, args=(run_id, stop), name=f"biometric-fetch-{run_id}-beat", daemon=True)
    beat.start()
    try:
        execute_run(run_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Manual fetch %s crashed", run_id)
        BiometricFetchRun.objects.filter(pk=run_id).update(
            status="failed", error=f"The run failed: {exc}", finished_at=timezone.now()
        )
    finally:
        stop.set()
        beat.join(timeout=5)
        connection.close()


def _read_punches(host: str, port: int | None, password: int, since, until) -> dict:
    """Worker thread: read one device's log. Plain data in and out; no database."""
    started = time.perf_counter()
    try:
        with open_session(host, port, password, deadline=LOG_READ_DEADLINE_SECONDS) as session:
            punches, invalid, total = session.read_attendance(since, until)
        return {
            "ok": True,
            "punches": punches,
            "invalid": invalid,
            "total": total,
            "ms": round((time.perf_counter() - started) * 1000),
        }
    except DeviceUnavailable as exc:
        return {"ok": False, "code": exc.code, "error": exc.message}
    except Exception as exc:  # noqa: BLE001 -one device's surprise is that device's failure, not the run's
        logger.exception("Manual fetch: unexpected failure reading %s:%s", host, port)
        return {"ok": False, "code": "error", "error": f"Something unexpected went wrong with this device: {exc}"}


def _save_results(run_id: int, results: list[dict]) -> None:
    BiometricFetchRun.objects.filter(pk=run_id).update(results=results, updated_at=timezone.now())


def _process_device(run: BiometricFetchRun, device: BiometricDevice, data: dict, by_code: dict) -> dict:
    """What one device's punches mean for the HRMS, and (for an update) write the new ones."""
    punches = data["punches"]
    source_tag = f"biometric:{device.name}"
    in_range = len(punches)

    matched = []
    unmatched: dict[str, dict] = {}
    for p in punches:
        emp = by_code.get(p.user_id.strip())
        if emp is None:
            row = unmatched.setdefault(p.user_id.strip(), {"userId": p.user_id.strip(), "punches": 0, "lastDate": None})
            row["punches"] += 1
            day = str(p.at.date())
            if row["lastDate"] is None or day > row["lastDate"]:
                row["lastDate"] = day
        else:
            matched.append((emp, p))

    existing: set = set()
    if matched:
        days = [p.at.date() for _e, p in matched]
        # Recognised by who and when, not by In/Out: the same punch reaches the HRMS by more than one road (a pull
        # reads the device's verify byte, a push its In/Out state), and a punch is never made twice at the same second.
        existing = set(
            AttendanceLog.objects.filter(
                employee_id__in={e.pk for e, _p in matched}, date__gte=min(days), date__lte=max(days)
            ).values_list("employee_id", "date", "punch_time")
        )
    new: list[tuple] = []
    new_meta: list[tuple] = []
    seen: set = set()
    already = 0
    for emp, p in matched:
        punch_type = _STATUS_MAP.get(p.status, AttendanceLog.PUNCH_IN)
        at_time = p.at.time().replace(microsecond=0)
        key = (emp.pk, p.at.date(), at_time)
        if key in existing or key in seen:
            already += 1
            continue
        seen.add(key)
        new.append((str(emp.employee_code).strip(), p.at.date(), at_time, punch_type))
        new_meta.append((emp, p.at.date(), at_time, punch_type))

    result = {
        "onDevice": data["total"],
        "inRange": in_range,
        "matched": len(matched),
        "alreadyInHrms": already,
        "new": len(new),
        "unmatchedPunches": sum(r["punches"] for r in unmatched.values()),
        "unmatchedIds": len(unmatched),
        "unmatched": sorted(unmatched.values(), key=lambda r: -r["punches"])[:UNMATCHED_SHOWN],
        "invalidRecords": data["invalid"],
        "samples": [
            {
                "code": str(e.employee_code),
                "name": employee_name(e),
                "date": str(d),
                "time": t.strftime("%H:%M:%S"),
                "type": "IN" if kind == AttendanceLog.PUNCH_IN else "OUT",
            }
            for e, d, t, kind in new_meta[:SAMPLES_SHOWN]
        ],
        "durationMs": data["ms"],
        "created": 0,
        "suspiciousDays": [],
    }
    if run.mode == BiometricFetchRun.MODE_UPDATE and new:
        written = _ingest_punches(new, None, source_tag)
        result["created"] = written["created"]
        names = {e.pk: employee_name(e) for e, *_ in new_meta}
        result["suspiciousDays"] = [
            {**d, "employeeName": names.get(d["employeeId"], "")} for d in written.get("suspiciousDays", [])
        ]
    return result


def execute_run(run_id: int) -> None:
    """Run one fetch to the end. Called on the background thread (and directly by the tests)."""
    run = BiometricFetchRun.objects.get(pk=run_id)
    devices = {d.pk: d for d in BiometricDevice.objects.filter(pk__in=run.device_ids)}
    order = [d for d in run.device_ids if d in devices]
    results = {r["deviceId"]: r for r in run.results}
    by_code = _active_employee_lookup()
    updating = run.mode == BiometricFetchRun.MODE_UPDATE

    def publish() -> None:
        _save_results(run.pk, [results[i] for i in order if i in results])

    readable = []
    for device_id in order:
        device = devices[device_id]
        pw = password_of(device)
        if pw is None:
            results[device_id].update(
                status="failed",
                code="config",
                error="The Comm password in Settings → Devices is not a number (it is the device's Comm Key, usually 0).",
            )
        else:
            readable.append((device, pw))
    publish()

    with ThreadPoolExecutor(max_workers=max(1, min(READ_PARALLELISM, len(readable)))) as pool:
        futures = {pool.submit(_read_punches, d.host, d.port, pw, run.date_from, run.date_to): d for d, pw in readable}
        for future in as_completed(futures):
            device = futures[future]
            data = future.result()
            entry = results[device.pk]
            if not data["ok"]:
                entry.update(status="failed", code=data["code"], error=data["error"])
                if updating:
                    BiometricDevice.objects.filter(pk=device.pk).update(
                        last_sync_error=data["error"][:1000], last_sync_error_at=timezone.now()
                    )
                publish()
                continue
            entry.update(
                status="processing",
                phase=f"Checking {len(data['punches']):,} punches"
                if not updating
                else f"Writing punches to the HRMS ({len(data['punches']):,} in range)",
            )
            publish()
            try:
                entry.update(_process_device(run, device, data, by_code), status="done", phase="")
                if updating:
                    now = timezone.now()
                    BiometricDevice.objects.filter(pk=device.pk).update(
                        last_synced_at=now, last_reachable_at=now, last_sync_error=""
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Manual fetch %s: device %s failed while processing", run.pk, device.name)
                entry.update(status="failed", code="error", error=f"Could not process this device's punches: {exc}")
            publish()

    done = [r for r in results.values() if r["status"] == "done"]
    summary = {
        "devices": len(order),
        "devicesDone": len(done),
        "devicesFailed": len(order) - len(done),
        "onDevice": sum(r["onDevice"] for r in done),
        "inRange": sum(r["inRange"] for r in done),
        "alreadyInHrms": sum(r["alreadyInHrms"] for r in done),
        "new": sum(r["new"] for r in done),
        "created": sum(r["created"] for r in done),
        "unmatchedPunches": sum(r["unmatchedPunches"] for r in done),
        "unmatched": _merge_unmatched(done),
        "suspiciousDays": [d for r in done for d in r["suspiciousDays"]],
    }
    BiometricFetchRun.objects.filter(pk=run.pk).update(
        status="done" if done else "failed",
        summary=summary,
        error="" if done else "No device could be read.",
        finished_at=timezone.now(),
        updated_at=timezone.now(),
    )


def _merge_unmatched(done: list[dict]) -> list[dict]:
    """The IDs with no employee, across the devices, with the name the device shows for each."""
    merged: Counter = Counter()
    last: dict[str, str] = {}
    for r in done:
        for row in r["unmatched"]:
            merged[row["userId"]] += row["punches"]
            if row["lastDate"] and row["lastDate"] > last.get(row["userId"], ""):
                last[row["userId"]] = row["lastDate"]
    top = merged.most_common(UNMATCHED_SHOWN)
    names = {}
    if top:
        for user_id, name in BiometricDeviceUser.objects.filter(user_id__in=[u for u, _n in top]).values_list(
            "user_id", "name"
        ):
            if name:
                names.setdefault(user_id, name)
    return [{"userId": u, "punches": n, "lastDate": last.get(u), "deviceName": names.get(u, "")} for u, n in top]


def _masked(results: list[dict] | None, summary: dict | None) -> tuple[list[dict] | None, dict | None]:
    """The run without names: the people in a run are not limited to one branch, so a branch-limited caller sees the
    counts and codes, not who they are."""

    def blank(rows, keys):
        return [{**row, **{k: "" for k in keys if k in row}} for row in rows or []]

    new_results = None
    if results is not None:
        new_results = []
        for r in results:
            r = dict(r)
            if "samples" in r:
                r["samples"] = blank(r["samples"], ("name",))
            if "suspiciousDays" in r:
                r["suspiciousDays"] = blank(r["suspiciousDays"], ("employeeName",))
            if "unmatched" in r:
                r["unmatched"] = blank(r["unmatched"], ("deviceName",))
            new_results.append(r)
    new_summary = None
    if summary is not None:
        new_summary = dict(summary)
        new_summary["suspiciousDays"] = blank(summary.get("suspiciousDays"), ("employeeName",))
        new_summary["unmatched"] = blank(summary.get("unmatched"), ("deviceName",))
    return new_results, new_summary


def serialize_run(run: BiometricFetchRun, mask_names: bool = False) -> dict:
    end = run.finished_at or timezone.now()
    results, summary = _masked(run.results, run.summary) if mask_names else (run.results, run.summary)
    return {
        "id": run.pk,
        "mode": run.mode,
        "status": run.status,
        "startedBy": run.started_by,
        "rangeLabel": run.range_label,
        "dateFrom": str(run.date_from) if run.date_from else None,
        "dateTo": str(run.date_to) if run.date_to else None,
        "deviceIds": run.device_ids,
        "results": results,
        "summary": summary,
        "error": run.error,
        "createdAt": run.created_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "elapsedSeconds": round((end - run.created_at).total_seconds(), 1),
    }


def list_runs(limit: int = 15, mask_names: bool = False) -> list[dict]:
    _expire_stale()
    return [serialize_run(r, mask_names) for r in BiometricFetchRun.objects.all()[:limit]]


def prune_history(keep: int = 100) -> None:
    ids = list(BiometricFetchRun.objects.values_list("pk", flat=True)[keep:])
    if ids:
        BiometricFetchRun.objects.filter(pk__in=ids).delete()
