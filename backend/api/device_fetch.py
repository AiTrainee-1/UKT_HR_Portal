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
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta
from types import SimpleNamespace

from django.db import connection, transaction
from django.utils import timezone

from . import device_remote
from .audit_utils import log_action
from .biometric_sync import _STATUS_MAP, _active_employee_lookup, _ingest_punches
from .device_punch_rules import accepts, device_rules
from .clock import ist_today
from .device_client import LOG_READ_DEADLINE_SECONDS, DeviceUnavailable, Punch, open_session
from .device_directory import employee_name, password_of
from .models import Attendance, AttendanceLog, BiometricDevice, BiometricDeviceUser, BiometricFetchRun, Employee

logger = logging.getLogger(__name__)

STALE_RUN_MINUTES = 5  # a run beats its heart every HEARTBEAT_SECONDS; five quiet minutes means it is gone
HEARTBEAT_SECONDS = 30
ADVISORY_LOCK_KEY = 71400271  # one fetch is started at a time, across web workers
READ_PARALLELISM = 3
PROGRESS_SECONDS = 1.0  # how often a run publishes how far its reads have got
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


SCOPE_TYPES = ("staff", "production")
MAX_SCOPE_EMPLOYEES = 50


def clean_scope(request, raw) -> dict | None:
    """Whose punches a run takes (owner 2026-11-17): None = everyone, as before; {"employmentType": "staff" |
    "production"}; or {"employeeIds": [..]} (one employee from the page; a few at most). Employees are active ones the
    caller may see (branch scope), since only an active employee's punches are recorded. ValueError says what is wrong."""
    from .branch_scope import scope_to_branch

    if not raw:
        return None
    if not isinstance(raw, dict):
        raise ValueError("The scope must be an object.")
    kind = raw.get("employmentType") or ""
    ids = raw.get("employeeIds") or []
    if kind and kind not in SCOPE_TYPES:
        raise ValueError("employmentType must be staff or production.")
    if not isinstance(ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise ValueError("employeeIds must be a list of employee ids.")
    if len(ids) > MAX_SCOPE_EMPLOYEES:
        raise ValueError(f"Choose at most {MAX_SCOPE_EMPLOYEES} employees.")
    scope: dict = {}
    if ids:
        found = list(
            scope_to_branch(Employee.objects, request)
            .filter(pk__in=ids)
            .only("id", "employee_code", "first_name", "last_name", "employment_type", "status")
        )
        if len(found) != len(set(ids)):
            raise ValueError("That employee could not be found (or is in another branch).")
        inactive = [e for e in found if e.status != "active"]
        if inactive:
            raise ValueError(
                f"{employee_name(inactive[0])} is not active: punches are only recorded for active employees."
            )
        scope["employeeIds"] = sorted({e.pk for e in found})
        scope["employees"] = [
            {
                "id": e.pk,
                "code": str(e.employee_code).strip(),
                "name": employee_name(e),
                "employmentType": e.employment_type,
            }
            for e in sorted(found, key=lambda x: str(x.employee_code))
        ]
    if kind:
        scope["employmentType"] = kind
    return scope or None


def scope_codes(scope: dict | None, by_code: dict) -> set | None:
    """The Employee Codes a scope takes from `by_code` (active employees by code), or None for everyone."""
    if not scope:
        return None
    ids = set(scope.get("employeeIds") or [])
    kind = scope.get("employmentType") or ""
    return {
        code
        for code, e in by_code.items()
        if (not ids or e.pk in ids) and (not kind or getattr(e, "employment_type", "") == kind)
    }


def scope_label(scope: dict | None) -> str:
    """ "Everyone", "Staff only", "Production only", "PC-7 Kavi Worker"."""
    if not scope:
        return "Everyone"
    people = scope.get("employees") or []
    if people:
        first = f"{people[0]['code']} {people[0]['name']}".strip()
        return first if len(people) == 1 else f"{first} and {len(people) - 1} more"
    return {"staff": "Staff only", "production": "Production only"}.get(scope.get("employmentType") or "", "Everyone")


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


def start_run(
    request, device_ids, preset: str, date_from=None, date_to=None, apply: bool = False, scope=None
) -> BiometricFetchRun:
    """Create a run and start it on a background thread. FetchConflict if the devices are already in use. `scope` (see
    clean_scope) limits whose punches it takes."""
    from . import sync_progress

    start, end, label = resolve_range(preset, date_from, date_to)
    scope = clean_scope(request, scope)
    devices = list(
        BiometricDevice.objects.select_related("connector")
        .filter(pk__in=device_ids or [], is_active=True)
        .order_by("name")
    )
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
            scope=scope,
            results=[
                {
                    "deviceId": d.pk,
                    "deviceName": d.name,
                    "status": "reading",
                    "phase": "Connecting to the device",
                    # progress (owner 2026-11-17): what the device last said it holds, until the read says better
                    "stage": "connecting",
                    "recordsTotal": (d.capacity or {}).get("records"),
                    "recordsRead": 0,
                    "via": "connector" if device_remote.is_remote(d) else "direct",
                }
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
            f"({label}, {scope_label(scope)}) of {', '.join(d.name for d in devices)}"
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


def _read_punches(host: str, port: int | None, password: int, since, until, progress: dict | None = None) -> dict:
    """Worker thread: read one device's log. Plain data in and out; no database. `progress` (a plain dict the run's own
    thread reads) gets {"read", "total"} as the log arrives."""
    started = time.perf_counter()

    def report(read: int, total: int) -> None:
        if progress is not None:
            progress.update(read=read, total=total)

    try:
        with open_session(host, port, password, deadline=LOG_READ_DEADLINE_SECONDS) as session:
            if progress is not None:
                progress.update(stage="reading")
            punches, invalid, total = session.read_attendance(since, until, on_progress=report)
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


def _idle(seconds: float) -> None:
    """How the run waits between looks at the connector jobs (a test replaces it with a simulated connector)."""
    time.sleep(seconds)


def _save_results(run_id: int, results: list[dict]) -> None:
    BiometricFetchRun.objects.filter(pk=run_id).update(results=results, updated_at=timezone.now())


def _process_device(
    run: BiometricFetchRun, device: BiometricDevice, data: dict, by_code: dict, writer=None, in_scope: set | None = None
) -> dict:
    """What one device's punches mean for the HRMS, and (for an update) write the new ones with `writer` (by default the path
    Sync Biometric uses). `in_scope` (Employee Codes) limits whose punches are taken; the others are only counted."""
    punches = data["punches"]
    source_tag = f"biometric:{device.name}"
    out_of_scope = 0
    if in_scope is not None:
        kept = [p for p in punches if p.user_id.strip() in in_scope]
        out_of_scope = len(punches) - len(kept)
        punches = kept
    in_range = len(punches)

    matched = []
    unmatched: dict[str, dict] = {}
    restricted = (
        0  # punches of employees limited to other devices (Device Control): not theirs, so not counted anywhere else
    )
    rules = device_rules()
    for p in punches:
        emp = by_code.get(p.user_id.strip())
        if emp is not None and not accepts(rules, emp.pk, device.pk):
            restricted += 1
            continue
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
        "restricted": restricted,
        "outOfScope": out_of_scope,
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
        written = (writer or _ingest_punches)(new, None, source_tag)
        result["created"] = written["created"]
        names = {e.pk: employee_name(e) for e, *_ in new_meta}
        result["suspiciousDays"] = [
            {**d, "employeeName": names.get(d["employeeId"], "")} for d in written.get("suspiciousDays", [])
        ]
    return result


def execute_run(run_id: int) -> None:
    """Run one fetch to the end. Called on the background thread (and directly by the tests)."""
    run = BiometricFetchRun.objects.get(pk=run_id)
    devices = {d.pk: d for d in BiometricDevice.objects.select_related("connector").filter(pk__in=run.device_ids)}
    order = [d for d in run.device_ids if d in devices]
    results = {r["deviceId"]: r for r in run.results}
    by_code = _active_employee_lookup()
    in_scope = scope_codes(run.scope, by_code)
    updating = run.mode == BiometricFetchRun.MODE_UPDATE

    def publish() -> None:
        _save_results(run.pk, [results[i] for i in order if i in results])

    readable = []
    waiting: list[tuple[BiometricDevice, object]] = []  # devices behind a site connector, and their jobs
    for device_id in order:
        device = devices[device_id]
        pw = password_of(device)
        if pw is None:
            results[device_id].update(
                status="failed",
                code="config",
                error="The Comm password in Settings → Devices is not a number (it is the device's Comm Key, usually 0).",
            )
        elif device_remote.is_remote(device):
            reason = device_remote.offline_reason(device.connector)
            if reason:
                results[device_id].update(status="failed", code="connector_offline", error=reason, stage="failed")
            else:
                job = device_remote.submit_job(
                    device,
                    "read_punches",
                    {
                        "since": run.date_from.isoformat() if run.date_from else None,
                        "until": run.date_to.isoformat() if run.date_to else None,
                    },
                )
                waiting.append((device, job))
                results[device_id].update(
                    phase=f"Waiting for the site connector “{device.connector.name}”", stage="waiting"
                )
        else:
            readable.append((device, pw))
    publish()

    def handle(device: BiometricDevice, data: dict) -> None:
        """What one device's punches mean for the HRMS (and, for an update, write them)."""
        entry = results[device.pk]
        if not data["ok"]:
            entry.update(status="failed", code=data["code"], error=data["error"], stage="failed")
            if updating:
                BiometricDevice.objects.filter(pk=device.pk).update(
                    last_sync_error=data["error"][:1000], last_sync_error_at=timezone.now()
                )
            publish()
            return
        entry.update(
            status="processing",
            stage="writing" if updating else "checking",
            recordsRead=data["total"],
            recordsTotal=data["total"],
            phase=f"Checking {len(data['punches']):,} punches"
            if not updating
            else f"Writing punches to the HRMS ({len(data['punches']):,} in range)",
        )
        publish()
        try:
            entry.update(
                _process_device(run, device, data, by_code, in_scope=in_scope), status="done", phase="", stage="done"
            )
            if updating:
                now = timezone.now()
                BiometricDevice.objects.filter(pk=device.pk).update(
                    last_synced_at=now, last_reachable_at=now, last_sync_error=""
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Manual fetch %s: device %s failed while processing", run.pk, device.name)
            entry.update(
                status="failed", code="error", error=f"Could not process this device's punches: {exc}", stage="failed"
            )
        publish()

    if readable:
        # each worker reports how far its device's log has arrived in a plain dict; this thread (the only one that
        # talks to the database) publishes those numbers about once a second while it waits
        live: dict[int, dict] = {d.pk: {} for d, _pw in readable}
        with ThreadPoolExecutor(max_workers=max(1, min(READ_PARALLELISM, len(readable)))) as pool:
            futures = {
                pool.submit(_read_punches, d.host, d.port, pw, run.date_from, run.date_to, live[d.pk]): d
                for d, pw in readable
            }
            pending = set(futures)
            while pending:
                done_now, pending = wait(pending, timeout=PROGRESS_SECONDS, return_when=FIRST_COMPLETED)
                changed = False
                for f in pending:
                    p = live[futures[f].pk]
                    entry = results[futures[f].pk]
                    if p.get("stage") == "reading" and entry.get("stage") == "connecting":
                        entry.update(stage="reading", phase="Reading the device's attendance log")
                        changed = True
                    if p.get("total") and (entry.get("recordsRead"), entry.get("recordsTotal")) != (
                        p.get("read"),
                        p.get("total"),
                    ):
                        entry.update(recordsRead=p["read"], recordsTotal=p["total"])
                        changed = True
                if changed and not done_now:
                    publish()
                for f in done_now:
                    handle(futures[f], f.result())

    # the connector devices read meanwhile: take each as it reports
    by_job = {job.pk: device for device, job in waiting}
    for job in device_remote.wait_for_jobs([job for _device, job in waiting], sleep=_idle):
        handle(by_job[job.pk], device_remote.collect_punches(job))

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
        "restricted": sum(r.get("restricted", 0) for r in done),
        "outOfScope": sum(r.get("outOfScope", 0) for r in done),
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


def _light_lookup() -> dict:
    """Active employees by Employee Code, with only the columns a punch needs (a full row can carry a photo)."""
    return {
        str(e.employee_code).strip(): e
        for e in Employee.objects.filter(status="active").only("id", "employee_code", "first_name", "last_name")
    }


def _bulk_writer(by_code: dict):
    """The write path for punches that arrive in a web request: the same rows as Sync Biometric writes (an AttendanceLog per
    punch, the day marked present), but in a handful of queries instead of ten per punch, so a catch-up of hundreds of
    punches fits inside the server's 30 second limit. The punches given are already known not to be held (_process_device
    checks), so a conflict is only a race and is ignored."""

    def write(punches, _date_from, source_tag):
        rows = []
        for uid, day, at_time, kind in punches:
            emp = by_code.get(uid)
            if emp is not None:
                rows.append(
                    AttendanceLog(employee_id=emp.pk, date=day, punch_time=at_time, punch_type=kind, source=source_tag)
                )
        if not rows:
            return {"created": 0, "skipped": len(punches), "notFound": set(), "suspiciousDays": []}
        employees = {r.employee_id for r in rows}
        days = {r.date for r in rows}
        with transaction.atomic():
            span = {"employee_id__in": employees, "date__range": (min(days), max(days))}
            before = AttendanceLog.objects.filter(**span).count()
            AttendanceLog.objects.bulk_create(rows, batch_size=500, ignore_conflicts=True)
            created = AttendanceLog.objects.filter(**span).count() - before
            marks = {(r.employee_id, str(r.date)) for r in rows}
            held = set(
                Attendance.objects.filter(employee_id__in=employees, date__in={d for _e, d in marks}).values_list(
                    "employee_id", "date"
                )
            )
            Attendance.objects.bulk_create(
                [Attendance(employee_id=e, date=d, present=True) for e, d in marks - held],
                batch_size=500,
                ignore_conflicts=True,
            )
            by_employee: dict[int, set[str]] = {}
            for e, d in marks & held:
                by_employee.setdefault(e, set()).add(d)
            for e, dates in by_employee.items():
                Attendance.objects.filter(employee_id=e, date__in=dates, present=False).update(present=True)
        counts = Counter((r.employee_id, r.date) for r in rows)
        suspicious = [{"employeeId": e, "date": str(d), "punches": n} for (e, d), n in counts.items() if n >= 6]
        # the fetched days are judged again by the background attendance refresh within 5 minutes (attendance_refresh.py),
        # not here: this catch-up must stay a handful of queries inside the request's 30 seconds
        return {
            "created": max(0, created),
            "skipped": len(punches) - len(rows),
            "notFound": set(),
            "suspiciousDays": suspicious,
        }

    return write


def ingest_from_connector(
    device: BiometricDevice, rows: list[tuple[str, object, int]], invalid: int = 0, total=None
) -> dict:
    """Punches a Site Connector read off one of its devices on its own schedule, written as a manual update writes them
    (matched to active employees by Employee Code; a punch the HRMS already has, by employee, date and time, is recognised
    and left alone), so a window read again and again, or a punch the device also pushed live, is never counted twice.

    A punch with an impossible time (a device whose clock is flat: 1970, or next year) is counted as invalid, not written. An ID
    with no employee is noted once for the Skipped view (its count there is approximate for connector reads: the same window
    is read more than once)."""
    from .device_health import record_unmatched_punch

    kept = [(u, at, s) for u, at, s in rows if device_remote.sane_punch_time(at)]
    invalid += len(rows) - len(kept)
    punches = [Punch(user_id, at, status) for user_id, at, status in kept]
    data = {"punches": punches, "invalid": invalid, "total": total if total is not None else len(punches), "ms": 0}
    by_code = _light_lookup()
    result = _process_device(
        SimpleNamespace(mode=BiometricFetchRun.MODE_UPDATE), device, data, by_code, writer=_bulk_writer(by_code)
    )
    for row in result["unmatched"]:
        try:
            when = (
                datetime.combine(date.fromisoformat(row["lastDate"]), datetime.min.time())
                if row["lastDate"]
                else datetime.now()
            )
        except ValueError:
            when = datetime.now()
        record_unmatched_punch(row["userId"], device.serial_number or "", when)
    now = timezone.now()
    BiometricDevice.objects.filter(pk=device.pk).update(last_synced_at=now, last_reachable_at=now, last_sync_error="")
    keep = ("inRange", "matched", "alreadyInHrms", "new", "created", "unmatchedPunches", "unmatchedIds", "restricted")
    return {k: result[k] for k in keep}


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
        "scope": _scope_out(run.scope, mask_names),
        "scopeLabel": "" if mask_names and (run.scope or {}).get("employees") else scope_label(run.scope),
        "results": results,
        "summary": summary,
        "error": run.error,
        "createdAt": run.created_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "elapsedSeconds": round((end - run.created_at).total_seconds(), 1),
    }


def _scope_out(scope: dict | None, mask_names: bool) -> dict | None:
    if not scope:
        return None
    if mask_names and scope.get("employees"):
        return {**scope, "employees": [{**e, "name": ""} for e in scope["employees"]]}
    return scope


def list_runs(limit: int = 15, mask_names: bool = False) -> list[dict]:
    _expire_stale()
    return [serialize_run(r, mask_names) for r in BiometricFetchRun.objects.all()[:limit]]


def prune_history(keep: int = 100) -> None:
    ids = list(BiometricFetchRun.objects.values_list("pk", flat=True)[keep:])
    if ids:
        BiometricFetchRun.objects.filter(pk__in=ids).delete()
