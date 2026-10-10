"""
Device Control → Data Push: who is on each biometric device, who they are in the HRMS, and the changes the portal
makes on the devices.

The device is the source of truth for its users. This module keeps a snapshot of each device's user table in the
database (BiometricDeviceUser), refreshed on demand and after every change made here, so the page can search, filter
and compare every device at once without opening a connection per click. It says when each device was last read.

A person is identified the way the rest of the HRMS identifies them: the user ID on the device IS the Employee Code,
exactly as biometric_sync._active_employee_lookup has it (no guessing, no leading-zero tricks). So a device user is
linked to the employee whose code equals their ID, and one with no such employee is "not in the HRMS".

Device input/output runs on worker threads and returns plain data; every database read and write stays on the calling
thread. That keeps the ORM off threads (and makes the logic testable inside a normal test transaction).

A device behind a Site Connector (BiometricDevice.connector) is never connected to from here: the same work is queued as
a job for the connector and the page polls an operation (device_remote.py). Direct and connector devices can be mixed in
one change; the direct ones are done at once and the answer is finished when the last connector job reports.

The HRMS is changed in exactly one way here: deleting a user from a device can also make their employee Inactive
(the same Employee.status the bulk upload and an approved resignation set; the record is kept, so a rehire finds the
history). Nothing about attendance, shifts or payroll is touched.
"""

from __future__ import annotations

import logging
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from .audit_utils import log_action
from .branch_scope import get_branch_scope, scope_to_branch
from .device_client import (
    PRIVILEGE_LABELS,
    PRIVILEGE_USER,
    RECORD_28,
    DeviceUnavailable,
    build_record,
    open_session,
    timed_probe,
)
from . import device_remote
from .device_health import connection_state, last_contact
from .device_probe import is_private_host
from .models import BiometricDevice, BiometricDeviceUser, Employee

logger = logging.getLogger(__name__)

USER_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,24}")
PASSWORD_RE = re.compile(r"[0-9]{0,8}")
ALLOWED_PRIVILEGES = tuple(PRIVILEGE_LABELS)
DEFAULT_PIN_WIDTH = 9
MAX_USERS_PER_CHANGE = 200
MAX_DEVICES_PER_CHANGE = 12
PROBE_CACHE_SECONDS = 15
SNAPSHOT_STALE_HOURS = 24


def password_of(device: BiometricDevice) -> int | None:
    raw = (device.connection_config or {}).get("password", 0) or 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def employee_name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def fit_bytes(text: str, limit: int) -> str:
    """The longest start of `text` that fits in `limit` bytes of UTF-8, never cutting a character in half."""
    out = ""
    for ch in text:
        if len((out + ch).encode("utf-8")) > limit:
            break
        out += ch
    return out


def role_label(privilege: int) -> str:
    return PRIVILEGE_LABELS.get(privilege, f"Role {privilege}")


# ── the snapshot ────────────────────────────────────────────────────────────────────────────────────────────────────


def store_snapshot(device: BiometricDevice, users, capacity: dict | None) -> None:
    """Make the stored copy of the device's users equal to `users` (what was just read from it)."""
    now = timezone.now()
    with transaction.atomic():
        # two reads of the same device at once (a double click, two people) take turns: the second waits for the first
        if not BiometricDevice.objects.select_for_update().filter(pk=device.pk).exists():
            return
        existing = {row.uid: row for row in BiometricDeviceUser.objects.filter(device=device)}
        seen: set[int] = set()
        create, update = [], []
        for u in users:
            seen.add(u.uid)
            row = existing.get(u.uid)
            fields = dict(
                user_id=u.user_id,
                name=u.name,
                privilege=u.privilege,
                card=u.card,
                has_password=u.has_password,
                group=u.group,
                read_at=now,
            )
            if row is None:
                create.append(BiometricDeviceUser(device=device, uid=u.uid, **fields))
            else:
                for key, value in fields.items():
                    setattr(row, key, value)
                update.append(row)
        gone = [uid for uid in existing if uid not in seen]
        if gone:
            BiometricDeviceUser.objects.filter(device=device, uid__in=gone).delete()
        if create:
            BiometricDeviceUser.objects.bulk_create(create, batch_size=500)
        if update:
            BiometricDeviceUser.objects.bulk_update(
                update, ["user_id", "name", "privilege", "card", "has_password", "group", "read_at"], batch_size=500
            )
        fields = {"users_read_at": now, "users_read_error": "", "last_reachable_at": now}
        if capacity:
            fields["capacity"] = {**capacity, "readAt": now.isoformat()}
        BiometricDevice.objects.filter(pk=device.pk).update(**fields)
    _probe_cache.pop(device.pk, None)


def _guarded(fn, *args) -> dict:
    """Run one device's work on a worker thread. Whatever goes wrong inside it is that device's result, never an error
    for the whole request (other devices may already have been changed by then)."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Device Control worker failed")
        return {"ok": False, "code": "error", "error": f"Something unexpected went wrong with this device: {exc}"}


def _read_device(host: str, port: int | None, password: int) -> dict:
    """Worker thread: read one device. Plain data in, plain data out."""
    started = time.perf_counter()
    try:
        with open_session(host, port, password) as session:
            capacity = {**session.sizes(), **session.identity()}
            users = session.read_users()
        return {"ok": True, "users": users, "capacity": capacity, "ms": round((time.perf_counter() - started) * 1000)}
    except DeviceUnavailable as exc:
        return {"ok": False, "code": exc.code, "error": exc.message}


COMM_KEY_ERROR = "The Comm password in Settings → Devices is not a number (it is the device's Comm Key, usually 0)."


def _devices_by_ids(device_ids) -> list[BiometricDevice]:
    qs = BiometricDevice.objects.select_related("connector").order_by("name")
    if device_ids:
        qs = qs.filter(pk__in=device_ids)
    else:
        qs = qs.filter(is_active=True)
    return list(qs)


def _read_direct(devices: list[BiometricDevice]) -> dict[int, dict]:
    """Read the user table of each device the server connects to itself, in parallel. {device pk: result}."""
    results: dict[int, dict] = {}
    runnable = []
    for d in devices:
        pw = password_of(d)
        if pw is None:
            results[d.pk] = {"ok": False, "code": "config", "error": COMM_KEY_ERROR}
        else:
            runnable.append((d, pw))
    if runnable:
        with ThreadPoolExecutor(max_workers=min(6, len(runnable))) as pool:
            futures = [(d, pool.submit(_guarded, _read_device, d.host, d.port, pw)) for d, pw in runnable]
            for d, future in futures:
                results[d.pk] = future.result()
    return results


def finish_refresh(devices: list[BiometricDevice], results: dict[int, dict]) -> dict:
    """Store what each device returned. One entry per device, in the order of the device names."""
    out = []
    for d in devices:
        r = results[d.pk]
        if r["ok"]:
            store_snapshot(d, r["users"], r["capacity"])
            out.append({"deviceId": d.pk, "deviceName": d.name, "ok": True, "count": len(r["users"]), "ms": r["ms"]})
        else:
            BiometricDevice.objects.filter(pk=d.pk).update(users_read_error=r["error"][:1000])
            out.append({"deviceId": d.pk, "deviceName": d.name, "ok": False, "code": r["code"], "error": r["error"]})
    return {"results": out}


def refresh_users(device_ids=None) -> list[dict]:
    """Read the user table of each device the server connects to itself (every enabled one when none are named) into the
    snapshot. Devices behind a Site Connector are read through start_refresh."""
    devices = [d for d in _devices_by_ids(device_ids) if not device_remote.is_remote(d)]
    return finish_refresh(devices, _read_direct(devices))["results"]


def start_refresh(request, device_ids=None) -> dict:
    """refresh_users for every device, including those behind a connector. {"results": [...]} when everything was done
    here and now, {"operation": {...}} when a connector is still working (the page polls it)."""
    devices = _devices_by_ids(device_ids)
    return _dispatch(
        request,
        "refresh",
        devices,
        direct_fn=lambda d, pw: _read_device(d.host, d.port, pw),
        job_kind="read_users",
        payload=lambda d: {},
        params={},
        check_active=False,
    )


# ── running something on devices: directly, or as a job for the connector ──────────────────────────────────────────


def _plan_devices(devices: list[BiometricDevice], check_active: bool):
    """Sort devices into those that fail before anything is tried, those the server connects to, and those a connector
    does. Returns (results so far, [(device, comm key)], [device])."""
    results: dict[int, dict] = {}
    direct: list[tuple[BiometricDevice, int]] = []
    remote: list[BiometricDevice] = []
    for d in devices:
        pw = password_of(d)
        if pw is None:
            results[d.pk] = {"ok": False, "code": "config", "error": COMM_KEY_ERROR}
        elif check_active and not d.is_active:
            results[d.pk] = {
                "ok": False,
                "code": "disabled",
                "error": "The device is switched off in Settings → Devices.",
            }
        elif device_remote.is_remote(d):
            remote.append(d)
        else:
            direct.append((d, pw))
    return results, direct, remote


def _dispatch(request, kind, devices, direct_fn, job_kind, payload, params, check_active=True) -> dict:
    """Do `kind` on `devices` and return the finished answer, or (if a connector is involved and has not yet reported) the
    operation to poll. `direct_fn(device, comm key)` does it on a device the server connects to; `payload(device)` is what
    a connector is told for the same device."""
    results, direct, remote = _plan_devices(devices, check_active)
    if direct:
        with ThreadPoolExecutor(max_workers=min(6, len(direct))) as pool:
            futures = [(d, pool.submit(_guarded, direct_fn, d, pw)) for d, pw in direct]
            for d, future in futures:
                results[d.pk] = future.result()
    if not remote:
        return _finish(kind, request, {**params, "deviceIds": [d.pk for d in devices]}, devices, results)
    op = device_remote.start_operation(
        request,
        kind,
        {**params, "deviceIds": [d.pk for d in devices]},
        results,
        [(d, job_kind, payload(d)) for d in remote],
    )
    if op.status == "done" and op.final is not None:
        return op.final
    return {"operation": device_remote.serialize_operation(op)}


def _only_planned(results: dict[int, dict], plan: dict[int, list[str]] | None, keys: tuple[str, ...]) -> None:
    """What a result says about users nobody asked about is not believed. It would be acted on (an employee made Inactive, a
    snapshot changed) for someone nobody chose, perhaps of another branch, and the branch check was made on the ids that
    were asked for. A user said to be deleted who is still in the list the device returned is not deleted either."""
    if plan is None:
        return
    for pk, r in results.items():
        allowed = set(plan.get(pk, ()))
        for key in keys:
            if isinstance(r.get(key), list):
                r[key] = [u for u in r[key] if u in allowed]
        users = r.get("users")
        if "deleted" in keys and users is not None and isinstance(r.get("deleted"), list):
            still = {u.user_id for u in users}
            r["deleted"] = [u for u in r["deleted"] if u not in still]


def _finish(kind: str, request, params: dict, devices: list[BiometricDevice], results: dict[int, dict]) -> dict:
    if kind == "refresh":
        return finish_refresh(devices, results)
    if kind == "apply":
        if "userIds" in params:
            _only_planned(results, {d.pk: params["userIds"] for d in devices}, ("added", "updated"))
        return finish_apply(request, params["mode"], devices, results, params.get("rejected", []))
    if kind == "delete":
        if "plan" in params:
            _only_planned(results, {int(k): v for k, v in params["plan"].items()}, ("deleted", "absent"))
        return finish_delete(request, params, devices, results)
    raise ValueError(f"unknown operation kind {kind}")


def finish_operation(op, results: dict[int, dict]) -> dict:
    """Finish an operation that waited for connector jobs: the same code that finishes a direct change, with the request
    rebuilt from who asked. `results` are the decoded results of every device."""
    params = op.params or {}
    ids = params.get("deviceIds") or []
    devices = list(BiometricDevice.objects.select_related("connector").filter(pk__in=ids).order_by("name"))
    for d in devices:
        results.setdefault(d.pk, {"ok": False, "code": "lost", "error": device_remote.LOST_CONNECTOR})
    return _finish(op.kind, device_remote.request_for(op.actor or {}), params, devices, results)


# ── the overview: which devices can this server open a session with, right now ─────────────────────────────────────

_probe_cache: dict[int, tuple[float, dict]] = {}


def probe_devices(devices: list[BiometricDevice], fresh: bool = False) -> dict[int, dict]:
    """timed_probe for each enabled device, in parallel, with a short cache so a page that refreshes itself does not
    open a session on every device every few seconds."""
    now = time.monotonic()
    results: dict[int, dict] = {}
    todo = []
    for d in devices:
        if not d.is_active or device_remote.is_remote(d):
            continue
        cached = _probe_cache.get(d.pk)
        if cached and not fresh and now - cached[0] < PROBE_CACHE_SECONDS:
            results[d.pk] = cached[1]
        elif password_of(d) is None:
            results[d.pk] = {
                "ok": False,
                "code": "config",
                "error": "The Comm password in Settings → Devices is not a number (it is the device's Comm Key, usually 0).",
                "latencyMs": None,
                "capacity": None,
                "deviceTime": None,
            }
        else:
            todo.append(d)
    if todo:
        with ThreadPoolExecutor(max_workers=min(6, len(todo))) as pool:
            futures = [(d, pool.submit(timed_probe, d.host, d.port, password_of(d))) for d in todo]
            for d, future in futures:
                results[d.pk] = future.result()
                _probe_cache[d.pk] = (time.monotonic(), results[d.pk])
    # the devices behind a connector: what the connector last reported (a fresh check also asks it to look again)
    results.update(device_remote.probe_remote(devices, fresh))
    return results


def clear_probe_cache() -> None:
    _probe_cache.clear()


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def device_summary(d: BiometricDevice, probe: dict | None, now: datetime) -> dict:
    """One device as the overview shows it."""
    if not d.is_active:
        connection = {
            "state": "disabled",
            "code": "disabled",
            "reason": "Switched off in Settings → Devices.",
            "latencyMs": None,
        }
    elif probe is None:
        connection = {"state": "unknown", "code": "unknown", "reason": "", "latencyMs": None}
    elif probe["ok"]:
        busy = probe["code"] == "busy"
        connection = {
            "state": "connected",
            "code": probe["code"],
            "reason": "Connected, but another operation is using the device right now." if busy else "",
            "latencyMs": probe["latencyMs"],
        }
    else:
        connection = {"state": "disconnected", "code": probe["code"], "reason": probe["error"], "latencyMs": None}
    capacity = (probe or {}).get("capacity") or d.capacity or None
    clock = None
    if probe and probe.get("deviceTime"):
        try:
            clock = int((datetime.fromisoformat(probe["deviceTime"]) - _ist_naive()).total_seconds())
        except ValueError:
            clock = None
    push_state = connection_state(d, now)
    return {
        "id": d.pk,
        "name": d.name,
        "host": d.host,
        "port": d.port or 4370,
        "serialNumber": d.serial_number or None,
        "deviceType": d.device_type,
        "isActive": d.is_active,
        "privateAddress": is_private_host(d.host),
        "via": (
            {
                "id": d.connector_id,
                "name": d.connector.name,
                "online": device_remote.connector_online(d.connector, now),
            }
            if d.connector_id
            else None
        ),
        "connection": connection,
        "push": {
            "state": {"connected": "live", "disconnected": "silent", "never": "never", "disabled": "disabled"}[
                push_state
            ],
            "lastContactAt": _iso(last_contact(d)),
        },
        "capacity": capacity,
        "deviceTime": (probe or {}).get("deviceTime"),
        "clockSkewSeconds": clock,
        "usersRead": {
            "at": _iso(d.users_read_at),
            "error": d.users_read_error or "",
        },
    }


def _ist_naive() -> datetime:
    """The server's clock as the naive IST wall time the devices keep."""
    from .clock import ist_now

    return ist_now().replace(tzinfo=None, microsecond=0)


# ── people: the device users and the employees, as one list ─────────────────────────────────────────────────────────


@dataclass
class Person:
    user_id: str
    presence: list = field(default_factory=list)  # BiometricDeviceUser rows
    employee: Employee | None = None
    restricted: bool = False  # an employee of a branch the caller may not see

    @property
    def link(self) -> str:
        if self.restricted:
            return "restricted"
        if self.employee is None:
            return "device_only"
        if not self.presence:
            return "hrms_only"
        return "linked" if self.employee.status == "active" else "inactive_on_device"

    @property
    def differs(self) -> list[str]:
        """What is not the same on every device this person is on."""
        if len(self.presence) < 2:
            return []
        out = []
        if len({r.name.casefold() for r in self.presence}) > 1:
            out.append("name")
        if len({r.privilege for r in self.presence}) > 1:
            out.append("role")
        if len({r.card for r in self.presence if r.card}) > 1:
            out.append("card")
        return out

    @property
    def display_name(self) -> str:
        if self.employee is not None:
            return employee_name(self.employee)
        for row in self.presence:
            if row.name:
                return row.name
        return ""


def _natural(text: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def load_people(request) -> tuple[list[Person], list[BiometricDevice]]:
    """Every person worth listing: whoever is on a device, and every active employee of the caller's branch.
    (An Inactive employee who is on no device is not listed: there is nothing to do about them.)"""
    from .employee_views import _without_embedded_photos

    devices = list(BiometricDevice.objects.all().order_by("name"))
    people: dict[str, Person] = {}
    for row in BiometricDeviceUser.objects.all().order_by("device_id", "uid"):
        people.setdefault(row.user_id, Person(row.user_id)).presence.append(row)

    scope = get_branch_scope(request)
    qs = Employee.objects.select_related("department", "designation", "branch")
    for emp in _without_embedded_photos(qs):
        code = str(emp.employee_code).strip()
        person = people.get(code)
        if person is None:
            if emp.status != "active" or (scope is not None and emp.branch_id != scope):
                continue
            person = people.setdefault(code, Person(code))
        if scope is not None and emp.branch_id != scope:
            person.restricted = True
            continue
        person.employee = emp
    return list(people.values()), devices


def _photo_url(emp: Employee) -> str | None:
    photo = emp.photo_url
    if not photo:
        return None
    return f"/api/employees/{emp.pk}/photo" if photo.startswith("data:") else photo


RESTRICTED_NAME = "Another branch"


def serialize_person(p: Person) -> dict:
    emp = p.employee
    return {
        "key": p.user_id,
        "userId": p.user_id,
        # an employee of a branch the caller may not see is not named, not even by what the device shows for them
        "name": RESTRICTED_NAME if p.restricted else p.display_name,
        "link": p.link,
        "restricted": p.restricted,
        "employee": (
            {
                "id": emp.pk,
                "code": emp.employee_code,
                "name": employee_name(emp),
                "status": emp.status,
                "employmentType": emp.employment_type,
                "department": emp.department.name if emp.department_id else None,
                "designation": emp.designation.title if emp.designation_id else None,
                "branch": emp.branch.name if emp.branch_id else None,
                "photoUrl": _photo_url(emp),
            }
            if emp is not None
            else None
        ),
        "presence": [
            (
                {
                    "deviceId": r.device_id,
                    "uid": 0,
                    "name": "",
                    "privilege": 0,
                    "role": "",
                    "card": 0,
                    "hasPassword": False,
                    "group": "",
                }
                if p.restricted
                else {
                    "deviceId": r.device_id,
                    "uid": r.uid,
                    "name": r.name,
                    "privilege": r.privilege,
                    "role": role_label(r.privilege),
                    "card": r.card,
                    "hasPassword": r.has_password,
                    "group": r.group,
                }
            )
            for r in p.presence
        ],
        "deviceCount": len(p.presence),
        "differs": p.differs,
    }


@dataclass
class PeopleFilter:
    search: str = ""
    device_ids: tuple[int, ...] = ()
    device_mode: str = "any"  # any | all | none
    link: str = "all"  # all | linked | device_only | hrms_only | inactive_on_device
    count: str = "any"  # any | single | multiple
    role: str = "any"  # any | user | admin
    employment_type: str = ""
    department_id: int | None = None
    branch_id: int | None = None
    differs: bool = False


def _matches(p: Person, f: PeopleFilter) -> bool:
    on = {r.device_id for r in p.presence}
    if f.device_ids:
        wanted = set(f.device_ids)
        if f.device_mode == "all" and not wanted <= on:
            return False
        if f.device_mode == "none" and wanted & on:
            return False
        if f.device_mode == "any" and not wanted & on:
            return False
    if f.link != "all" and p.link != f.link:
        return False
    if f.count == "single" and len(on) != 1:
        return False
    if f.count == "multiple" and len(on) < 2:
        return False
    if f.role == "admin" and not any(r.privilege != PRIVILEGE_USER for r in p.presence):
        return False
    if f.role == "user" and (not p.presence or any(r.privilege != PRIVILEGE_USER for r in p.presence)):
        return False
    if f.differs and not p.differs:
        return False
    emp = p.employee
    if f.employment_type and (emp is None or emp.employment_type != f.employment_type):
        return False
    if f.department_id and (emp is None or emp.department_id != f.department_id):
        return False
    if f.branch_id and (emp is None or emp.branch_id != f.branch_id):
        return False
    if f.search and p.restricted:
        if not all(token in p.user_id.lower() for token in f.search.lower().split()):
            return False
    elif f.search:
        hay = [p.user_id.lower(), p.display_name.lower()]
        hay += [r.name.lower() for r in p.presence] + [str(r.card) for r in p.presence if r.card]
        if emp is not None:
            hay += [employee_name(emp).lower(), (emp.department.name if emp.department_id else "").lower()]
        text = " ".join(hay)
        if not all(token in text for token in f.search.lower().split()):
            return False
    return True


SORTS = {
    "name": lambda p: (p.display_name.lower() or "￿", _natural(p.user_id)),
    "code": lambda p: _natural(p.user_id),
    "devices": lambda p: (len(p.presence), _natural(p.user_id)),
    "department": lambda p: (
        (p.employee.department.name.lower() if p.employee and p.employee.department_id else "￿"),
        _natural(p.user_id),
    ),
}


def facets(people: list[Person], devices: list[BiometricDevice]) -> dict:
    links = Counter(p.link for p in people)
    on_devices = [p for p in people if p.presence]
    per_device = Counter(r.device_id for p in people for r in p.presence)
    return {
        "total": len(people),
        "onDevices": len(on_devices),
        "linked": links["linked"],
        "deviceOnly": links["device_only"],
        "hrmsOnly": links["hrms_only"],
        "inactiveOnDevice": links["inactive_on_device"],
        "restricted": links["restricted"],
        "multipleDevices": sum(1 for p in on_devices if len(p.presence) > 1),
        "singleDevice": sum(1 for p in on_devices if len(p.presence) == 1),
        "admins": sum(1 for p in on_devices if any(r.privilege != PRIVILEGE_USER for r in p.presence)),
        "differs": sum(1 for p in on_devices if p.differs),
        "perDevice": {str(d.pk): per_device.get(d.pk, 0) for d in devices},
    }


def list_people(request, f: PeopleFilter, sort: str = "name", desc: bool = False, page: int = 1, page_size: int = 50):
    people, devices = load_people(request)
    shown = [p for p in people if _matches(p, f)]
    shown.sort(key=SORTS.get(sort, SORTS["name"]), reverse=desc)
    page_size = max(1, min(page_size, 200))
    total = len(shown)
    pages = max(1, -(-total // page_size))
    page = max(1, min(page, pages))
    chunk = shown[(page - 1) * page_size : page * page_size]
    return {
        "total": total,
        "page": page,
        "pages": pages,
        "pageSize": page_size,
        "items": [serialize_person(p) for p in chunk],
        "facets": facets(people, devices),
    }


# ── changing the devices ────────────────────────────────────────────────────────────────────────────────────────────


class SyncRunning(Exception):
    """A biometric sync started from the Attendance page is using the devices."""


def _refuse_during_sync() -> None:
    from . import sync_progress

    if sync_progress.is_running():
        raise SyncRunning("A biometric sync started from the Attendance page is running. Wait for it to finish.")


@dataclass
class UserSpec:
    user_id: str
    name: str | None = None
    privilege: int | None = None
    password: str | None = None
    card: int | None = None
    group: str | None = None
    employee_id: int | None = None


def clean_spec(raw: dict) -> tuple[UserSpec | None, str]:
    """A user as the page sends it, checked. (None, reason) for one that cannot be used."""
    user_id = str(raw.get("userId") or "").strip()
    if not USER_ID_RE.fullmatch(user_id):
        return None, "The user ID must be 1 to 24 letters, digits, dots, dashes or underscores."
    name = raw.get("name")
    if name is not None:
        name = " ".join(str(name).split())
    privilege = raw.get("privilege")
    if privilege is not None:
        try:
            privilege = int(privilege)
        except (TypeError, ValueError):
            return None, "The role is not valid."
        if privilege not in ALLOWED_PRIVILEGES:
            return None, "The role is not one the device has."
    password = raw.get("password")
    if password is not None:
        password = str(password)
        if not PASSWORD_RE.fullmatch(password):
            return None, "The device password is at most 8 digits."
    card = raw.get("card")
    if card in ("", None):
        card = None if raw.get("card") is None else 0
    if card is not None:
        try:
            card = int(card)
        except (TypeError, ValueError):
            return None, "The card number must be a number."
        if not 0 <= card <= 0xFFFFFFFF:
            return None, "The card number is too large."
    group = raw.get("group")
    if group is not None:
        group = str(group).strip()
        if len(group.encode("utf-8")) > 7:
            return None, "The group is at most 7 characters."
    employee_id = raw.get("employeeId")
    if employee_id not in (None, ""):
        try:
            employee_id = int(employee_id)
        except (TypeError, ValueError):
            return None, "The employee is not valid."
    else:
        employee_id = None
    return UserSpec(user_id, name, privilege, password, card, group, employee_id), ""


def _free_uid(used: set[int], cap: int, never_reuse: bool = False) -> int | None:
    """The device slot for a new user: the lowest free one, as a terminal itself chooses.

    never_reuse is for the older terminals (28-byte user records), whose punch log names a person by slot number
    only: a slot given to someone new would silently turn the old occupant's past punches into theirs. They get the
    next number after the highest in use, and only reuse a gap when the end of the table is reached."""
    limit = max(cap, 1)
    if never_reuse and used and max(used) < limit:
        return max(used) + 1
    uid = 1
    while uid in used:
        uid += 1
    return uid if uid <= limit else None


def _verified(kept, spec: UserSpec) -> bool:
    """Whether the record the device returned holds every field that was asked for."""
    if spec.name is not None and kept.name != spec.name:
        return False
    if spec.privilege is not None and kept.privilege != spec.privilege:
        return False
    if spec.card is not None and kept.card != spec.card:
        return False
    if spec.password is not None and kept.password != spec.password:
        return False
    if spec.group is not None and kept.group != spec.group:
        return False
    return True


LOST = "Not attempted: the connection to the device was lost."
UNCONFIRMED = (
    "Sent, but the connection to the device was lost before the change could be confirmed. "
    "Read the device again to see where things stand."
)


def _apply_on_device(host, port, password, specs: list[UserSpec], mode: str) -> dict:
    """Worker thread: add or update users on one device. mode "create" adds users the device does not have (and
    leaves the ones it has); mode "update" changes the users it has (and leaves the ones it does not).

    Everything is read back at the end, field by field, so "done" means the device now holds it. If the connection
    breaks part way, what was acknowledged before that is still accounted for: reported as sent but unconfirmed,
    never silently dropped."""
    out = {"ok": True, "added": [], "updated": [], "skipped": [], "failed": [], "users": None, "capacity": None}
    wrote: list[UserSpec] = []
    existing_before: set[str] = set()
    capacity = None
    after = None
    problem: DeviceUnavailable | None = None
    try:
        with open_session(host, port, password, write=True) as s:
            capacity = {**s.sizes(), **s.identity()}
            if not capacity.get("usersCap"):
                raise DeviceUnavailable(
                    "protocol", "The device did not say how many users it can hold, so it is not changed."
                )
            current = s.read_users()
            by_pin = {u.user_id: u for u in current}
            existing_before = set(by_pin)
            used = {u.uid for u in current}
            cap = capacity["usersCap"]
            pin_width = capacity.get("pinWidth") or DEFAULT_PIN_WIDTH
            for index, spec in enumerate(specs):
                existing = by_pin.get(spec.user_id)
                if mode == "create" and existing is not None:
                    out["skipped"].append({"userId": spec.user_id, "reason": "Already on this device."})
                    continue
                if mode == "update" and existing is None:
                    out["skipped"].append({"userId": spec.user_id, "reason": "Not on this device."})
                    continue
                if len(spec.user_id) > pin_width:
                    out["failed"].append(
                        {
                            "userId": spec.user_id,
                            "error": f"This device takes user IDs of at most {pin_width} characters.",
                        }
                    )
                    continue
                try:
                    if existing is not None:
                        record = build_record(
                            s.record_size,
                            uid=existing.uid,
                            user_id=existing.user_id,
                            name=spec.name,
                            privilege=spec.privilege,
                            password=spec.password,
                            card=spec.card,
                            group=spec.group,
                            base=existing.raw,
                        )
                    else:
                        uid = _free_uid(used, cap, never_reuse=s.record_size == RECORD_28)
                        if uid is None:
                            out["failed"].append(
                                {"userId": spec.user_id, "error": f"The device is full ({cap} users)."}
                            )
                            continue
                        record = build_record(
                            s.record_size,
                            uid=uid,
                            user_id=spec.user_id,
                            name=spec.name if spec.name is not None else "",
                            privilege=spec.privilege if spec.privilege is not None else PRIVILEGE_USER,
                            password=spec.password if spec.password is not None else "",
                            card=spec.card if spec.card is not None else 0,
                            group=spec.group,
                        )
                        used.add(uid)
                    s.write_record(record)
                    wrote.append(spec)
                except ValueError as exc:
                    out["failed"].append({"userId": spec.user_id, "error": str(exc)[0].upper() + str(exc)[1:] + "."})
                except DeviceUnavailable as exc:
                    out["failed"].append({"userId": spec.user_id, "error": exc.message})
                    if (
                        exc.code != "rejected"
                    ):  # the device refusing one record is that user's problem; a lost link is everyone's
                        problem = exc
                        out["failed"] += [{"userId": later.user_id, "error": LOST} for later in specs[index + 1 :]]
                        break
            if wrote:
                try:
                    after = s.read_users()
                except DeviceUnavailable as exc:
                    problem = problem or exc
            else:
                after = current
    except DeviceUnavailable as exc:
        problem = problem or exc

    if after is not None:
        after_by_pin = {u.user_id: u for u in after}
        for spec in wrote:
            kept = after_by_pin.get(spec.user_id)
            if kept is None or not _verified(kept, spec):
                out["failed"].append({"userId": spec.user_id, "error": "The device did not keep the change."})
            elif spec.user_id in existing_before:
                out["updated"].append(spec.user_id)
            else:
                out["added"].append(spec.user_id)
        out["users"] = after
        out["capacity"] = {**capacity, "users": len(after)}
    else:
        out["failed"] += [{"userId": spec.user_id, "error": UNCONFIRMED} for spec in wrote]
    if problem is not None:
        out.update(ok=False, code=problem.code, error=problem.message)
    return out


def _run_on_devices(devices: list[BiometricDevice], fn_args) -> dict[int, dict]:
    """Run fn_args(device, comm key) on each device the server connects to, in parallel. (Direct devices only: the
    callers that can include connector devices go through _dispatch.)"""
    results, direct, _remote = _plan_devices([d for d in devices if not device_remote.is_remote(d)], True)
    if direct:
        with ThreadPoolExecutor(max_workers=min(6, len(direct))) as pool:
            futures = [(d, pool.submit(_guarded, fn_args, d, pw)) for d, pw in direct]
            for d, future in futures:
                results[d.pk] = future.result()
    return results


def _device_entry(d: BiometricDevice, r: dict) -> dict:
    entry = {
        "deviceId": d.pk,
        "deviceName": d.name,
        "ok": r["ok"],
        "added": r.get("added", []),
        "updated": r.get("updated", []),
        "deleted": r.get("deleted", []),
        "absent": r.get("absent", []),
        "skipped": r.get("skipped", []),
        "failed": r.get("failed", []),
    }
    if not r["ok"]:
        entry.update(code=r.get("code", "error"), error=r["error"])
    return entry


def apply_users(request, device_ids, raw_users: list[dict], mode: str) -> dict:
    """Add (mode "create") or change (mode "update") users on the named devices.

    The name of a user sent with an employeeId and no name is taken from that employee, cut to what the device holds."""
    if mode not in ("create", "update"):
        raise ValueError("mode must be create or update")
    _refuse_during_sync()
    if not raw_users:
        raise ValueError("Choose at least one user.")
    if len(raw_users) > MAX_USERS_PER_CHANGE:
        raise ValueError(f"Change at most {MAX_USERS_PER_CHANGE} users at a time.")
    devices = list(BiometricDevice.objects.select_related("connector").filter(pk__in=device_ids or []).order_by("name"))
    if not devices:
        raise ValueError("Choose at least one device.")
    if len(devices) > MAX_DEVICES_PER_CHANGE:
        raise ValueError("Too many devices in one change.")

    specs: list[UserSpec] = []
    rejected: list[dict] = []
    seen: set[str] = set()
    employees = {}
    if not all(isinstance(u, dict) for u in raw_users):
        raise ValueError("Each user must be an object with a userId.")
    wanted = [int(u["employeeId"]) for u in raw_users if re.fullmatch(r"[0-9]{1,12}", str(u.get("employeeId") or ""))]
    if wanted:
        # only employees the caller may see: an employeeId must not be a way to read another branch's names
        employees = {e.pk: e for e in scope_to_branch(Employee.objects, request).filter(pk__in=wanted)}
    for raw in raw_users:
        spec, problem = clean_spec(raw)
        if spec is None:
            rejected.append({"userId": str(raw.get("userId") or ""), "error": problem})
            continue
        if spec.user_id in seen:
            rejected.append({"userId": spec.user_id, "error": "Listed twice."})
            continue
        seen.add(spec.user_id)
        if spec.employee_id:
            emp = employees.get(spec.employee_id)
            if emp is None or str(emp.employee_code).strip() != spec.user_id:
                rejected.append({"userId": spec.user_id, "error": "That employee is not this user ID's employee."})
                continue
            if spec.name is None:
                spec.name = fit_bytes(employee_name(emp), 24)
        if mode == "create" and not spec.name:
            rejected.append({"userId": spec.user_id, "error": "A name is needed."})
            continue
        specs.append(spec)

    blocked = restricted_codes(request, [s.user_id for s in specs])
    if blocked:
        rejected += [{"userId": u, "error": "This person belongs to another branch."} for u in sorted(blocked)]
        specs = [s for s in specs if s.user_id not in blocked]

    if not specs:
        return {
            "mode": mode,
            "rejected": rejected,
            "results": [],
            "summary": {"added": 0, "updated": 0, "failed": len(rejected)},
        }
    return _dispatch(
        request,
        "apply",
        devices,
        direct_fn=lambda d, pw: _apply_on_device(d.host, d.port, pw, specs, mode),
        job_kind="apply_users",
        payload=lambda d: {"mode": mode, "specs": [_spec_payload(s) for s in specs]},
        params={"mode": mode, "rejected": rejected, "userIds": [s.user_id for s in specs]},
    )


def _spec_payload(spec: UserSpec) -> dict:
    """What a connector is told for one user: the fields to set (the ones the person left alone are null)."""
    return {
        "userId": spec.user_id,
        "name": spec.name,
        "privilege": spec.privilege,
        "password": spec.password,
        "card": spec.card,
        "group": spec.group,
    }


def finish_apply(
    request, mode: str, devices: list[BiometricDevice], results: dict[int, dict], rejected: list[dict]
) -> dict:
    """The answer to an add or change, and what it leaves behind: the snapshots, the audit entries."""
    for d in devices:
        r = results[d.pk]
        if r["ok"] and r.get("users") is not None:
            store_snapshot(d, r["users"], r["capacity"])
        elif not r["ok"]:
            BiometricDevice.objects.filter(pk=d.pk).update(users_read_error=r["error"][:1000])
    entries = [_device_entry(d, results[d.pk]) for d in devices]

    added = sum(len(e["added"]) for e in entries)
    updated = sum(len(e["updated"]) for e in entries)
    failed = sum(len(e["failed"]) for e in entries) + sum(1 for e in entries if not e["ok"])
    if added:
        ids = sorted({i for e in entries for i in e["added"]})
        names = ", ".join(e["deviceName"] for e in entries if e["added"])
        log_action(
            request,
            "create",
            "attendance",
            description=f"Added {len(ids)} user(s) to biometric device(s) {names}: {', '.join(ids[:20])}",
        )
    if updated:
        ids = sorted({i for e in entries for i in e["updated"]})
        names = ", ".join(e["deviceName"] for e in entries if e["updated"])
        log_action(
            request,
            "update",
            "attendance",
            description=f"Changed {len(ids)} user(s) on biometric device(s) {names}: {', '.join(ids[:20])}",
        )
    return {
        "mode": mode,
        "rejected": rejected,
        "results": entries,
        "summary": {"added": added, "updated": updated, "failed": failed + len(rejected)},
    }


def _delete_on_device(host, port, password, user_ids: list[str]) -> dict:
    """Worker thread: delete users from one device. "deleted" are the ones the read-back confirms gone, "absent" the ones
    that were not there to begin with (someone removed them at the device). A lost connection part way leaves what was
    acknowledged reported as sent but unconfirmed, never dropped."""
    out = {"ok": True, "deleted": [], "absent": [], "skipped": [], "failed": [], "users": None, "capacity": None}
    removed: list[str] = []
    capacity = None
    after = None
    problem: DeviceUnavailable | None = None
    try:
        with open_session(host, port, password, write=True) as s:
            capacity = {**s.sizes(), **s.identity()}
            if not capacity.get("usersCap"):
                raise DeviceUnavailable(
                    "protocol", "The device did not say how many users it holds, so nothing is deleted from it."
                )
            current = s.read_users()
            by_pin = {u.user_id: u for u in current}
            for index, user_id in enumerate(user_ids):
                user = by_pin.get(user_id)
                if user is None:
                    out["skipped"].append({"userId": user_id, "reason": "Not on this device."})
                    out["absent"].append(user_id)
                    continue
                try:
                    s.delete_uid(user.uid)
                    removed.append(user_id)
                except DeviceUnavailable as exc:
                    out["failed"].append({"userId": user_id, "error": exc.message})
                    if exc.code != "rejected":
                        problem = exc
                        out["failed"] += [{"userId": later, "error": LOST} for later in user_ids[index + 1 :]]
                        break
            if removed:
                try:
                    after = s.read_users()
                except DeviceUnavailable as exc:
                    problem = problem or exc
            else:
                after = current
    except DeviceUnavailable as exc:
        problem = problem or exc

    if after is not None:
        still = {u.user_id for u in after}
        for user_id in removed:
            if user_id in still:
                out["failed"].append({"userId": user_id, "error": "The device still has this user."})
            else:
                out["deleted"].append(user_id)
        out["users"] = after
        out["capacity"] = {**capacity, "users": len(after)}
    else:
        out["failed"] += [{"userId": user_id, "error": UNCONFIRMED} for user_id in removed]
    if problem is not None:
        out.update(ok=False, code=problem.code, error=problem.message)
    return out


def restricted_codes(request, user_ids: list[str]) -> set[str]:
    """The IDs among `user_ids` that belong to an employee of a branch the caller may not touch (always empty for a
    caller who is not limited to a branch)."""
    scope = get_branch_scope(request)
    if scope is None or not user_ids:
        return set()
    return {
        str(code).strip()
        for code in Employee.objects.filter(employee_code__in=user_ids)
        .exclude(branch_id=scope)
        .values_list("employee_code", flat=True)
    }


def can_edit_module(request, module: str) -> bool:
    """Whether the caller's role may edit `module` (Super admins always may)."""
    from .models import HRUser
    from .permission_registry import effective_permissions, resolve_permission

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr), module) == "edit"


def delete_users(request, user_ids: list[str], device_ids=None, mark_inactive: bool = False) -> dict:
    """Delete users from devices and, when asked, make their employees Inactive.

    device_ids None = every device the snapshot says each user is on. The employee is made Inactive only when at least
    one device really removed them (the page reads each device back), and never deleted: the record, history and
    Employee Code stay, so a rehire finds them."""
    _refuse_during_sync()
    user_ids = list(dict.fromkeys(str(u).strip() for u in user_ids if str(u).strip()))
    if not user_ids:
        raise ValueError("Choose at least one user.")
    if len(user_ids) > MAX_USERS_PER_CHANGE:
        raise ValueError(f"Delete at most {MAX_USERS_PER_CHANGE} users at a time.")
    blocked = restricted_codes(request, user_ids)
    rejected = [{"userId": u, "error": "This person belongs to another branch."} for u in sorted(blocked)]
    user_ids = [u for u in user_ids if u not in blocked]
    if not user_ids:
        return {
            "results": [],
            "inactive": [],
            "rejected": rejected,
            "summary": {"deleted": 0, "failed": len(rejected), "madeInactive": 0},
        }

    if device_ids:
        devices = list(BiometricDevice.objects.select_related("connector").filter(pk__in=device_ids).order_by("name"))
        plan = {d.pk: list(user_ids) for d in devices}
    else:
        rows = BiometricDeviceUser.objects.filter(user_id__in=user_ids).values_list("device_id", "user_id")
        plan: dict[int, list[str]] = {}
        for device_id, user_id in rows:
            plan.setdefault(device_id, []).append(user_id)
        devices = list(BiometricDevice.objects.select_related("connector").filter(pk__in=plan).order_by("name"))
    if len(devices) > MAX_DEVICES_PER_CHANGE:
        raise ValueError("Too many devices in one change.")

    on_snapshot = {
        (device_id, user_id)
        for device_id, user_id in BiometricDeviceUser.objects.filter(user_id__in=user_ids).values_list(
            "device_id", "user_id"
        )
    }
    return _dispatch(
        request,
        "delete",
        devices,
        direct_fn=lambda d, pw: _delete_on_device(d.host, d.port, pw, plan[d.pk]),
        job_kind="delete_users",
        payload=lambda d: {"userIds": plan[d.pk]},
        params={
            "userIds": user_ids,
            "markInactive": bool(mark_inactive),
            "rejected": rejected,
            "onSnapshot": sorted([device_id, user_id] for device_id, user_id in on_snapshot),
            "plan": {str(pk): ids for pk, ids in plan.items()},
        },
    )


def finish_delete(request, params: dict, devices: list[BiometricDevice], results: dict[int, dict]) -> dict:
    """The answer to a delete, and its effects: the snapshots, the Inactive employees, the audit entry."""
    on_snapshot = {(device_id, user_id) for device_id, user_id in params.get("onSnapshot", [])}
    rejected = params.get("rejected", [])
    mark_inactive = bool(params.get("markInactive"))
    entries = []
    for d in devices:
        r = results[d.pk]
        if r["ok"] and r.get("users") is not None:
            store_snapshot(d, r["users"], r["capacity"])
        elif not r["ok"]:
            BiometricDevice.objects.filter(pk=d.pk).update(users_read_error=r["error"][:1000])
        entries.append(_device_entry(d, r))

    # who is gone from a device: removed just now, or (stale list) already not there although the list said they were
    removed_from: dict[str, list[str]] = {}
    deleted_from: dict[str, list[str]] = {}
    for e, d in zip(entries, devices):
        for user_id in e["deleted"]:
            removed_from.setdefault(user_id, []).append(e["deviceName"])
            deleted_from.setdefault(user_id, []).append(e["deviceName"])
        for user_id in e["absent"]:
            if (d.pk, user_id) in on_snapshot:
                removed_from.setdefault(user_id, []).append(e["deviceName"])

    inactive = []
    if mark_inactive:
        inactive = _make_inactive(request, removed_from)
    deleted_total = sum(len(e["deleted"]) for e in entries)
    if deleted_total:
        names = ", ".join(sorted({n for names in deleted_from.values() for n in names}))
        ids = sorted(deleted_from)
        log_action(
            request,
            "delete",
            "attendance",
            description=f"Deleted {len(ids)} user(s) from biometric device(s) {names}: {', '.join(ids[:20])}",
        )
    return {
        "results": entries,
        "inactive": inactive,
        "rejected": rejected,
        "summary": {
            "deleted": deleted_total,
            "failed": sum(len(e["failed"]) for e in entries) + sum(1 for e in entries if not e["ok"]) + len(rejected),
            "madeInactive": sum(1 for i in inactive if i["changed"]),
        },
    }


def _make_inactive(request, removed_from: dict[str, list[str]]) -> list[dict]:
    """The HRMS half of a delete. One entry per user the devices removed: what happened to their employee."""
    if not removed_from:
        return []
    allowed = can_edit_module(request, "employees")
    scope = get_branch_scope(request)
    by_code = {str(e.employee_code).strip(): e for e in Employee.objects.filter(employee_code__in=list(removed_from))}
    out = []
    for user_id, device_names in removed_from.items():
        emp = by_code.get(user_id)
        if emp is None:
            out.append(
                {
                    "userId": user_id,
                    "employeeId": None,
                    "name": "",
                    "changed": False,
                    "reason": "Not an employee in the HRMS.",
                }
            )
            continue
        entry = {"userId": user_id, "employeeId": emp.pk, "name": employee_name(emp), "changed": False, "reason": ""}
        if not allowed:
            entry["reason"] = "Your role cannot edit employees, so the employee was left as it is."
        elif scope is not None and emp.branch_id != scope:
            entry["reason"] = "The employee belongs to another branch."
        elif emp.status != "active":
            entry["reason"] = "Already Inactive."
        else:
            Employee.objects.filter(pk=emp.pk).update(status="inactive", updated_at=timezone.now())
            log_action(
                request,
                "update",
                "employees",
                record_id=emp.pk,
                description=(
                    f"Made {emp.employee_code} -{employee_name(emp)} Inactive "
                    f"(deleted from biometric device {', '.join(sorted(device_names))})"
                ),
            )
            entry["changed"] = True
        out.append(entry)
    return out


# ── the photo ──────────────────────────────────────────────────────────────────────────────────────────────────────

MAX_PHOTO_BYTES = 700 * 1024
_PHOTO_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$")


def save_employee_photo(request, employee_id: int, data_url: str) -> dict:
    """Store a captured or uploaded photo as the employee's profile photo (the same field the Employees page edits).
    The terminals do not take a photo over the network connection this portal uses, so it lives in the HRMS."""
    import base64

    if not can_edit_module(request, "employees"):
        raise PermissionError("Your role cannot edit employees.")
    match = _PHOTO_RE.match(data_url or "")
    if not match:
        raise ValueError("The photo must be a JPEG, PNG or WebP image.")
    try:
        raw = base64.b64decode(match.group(2), validate=False)
    except ValueError as exc:
        raise ValueError("The photo could not be read.") from exc
    if len(raw) > MAX_PHOTO_BYTES:
        raise ValueError("The photo is too large. Take it again a little further from the camera.")
    magic_ok = (
        raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n" or (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    )
    if not magic_ok:
        raise ValueError("The file is not an image.")
    qs = Employee.objects.filter(pk=employee_id)
    scope = get_branch_scope(request)
    if scope is not None:
        qs = qs.filter(branch_id=scope)
    emp = qs.first()
    if emp is None:
        raise LookupError("Employee not found.")
    Employee.objects.filter(pk=emp.pk).update(photo_url=data_url, updated_at=timezone.now())
    log_action(
        request,
        "update",
        "employees",
        record_id=emp.pk,
        description=f"Updated the photo of {emp.employee_code} -{employee_name(emp)} (Device Control)",
    )
    return {"employeeId": emp.pk, "photoUrl": f"/api/employees/{emp.pk}/photo"}
