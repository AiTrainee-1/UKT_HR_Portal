"""
Device Control endpoints (Attendance → Device Control): the overview, Data Fetch and Data Push.

  GET  /api/attendance/device-control/overview                 devices, who can be reached now, capacity, counts
  POST /api/attendance/device-control/users/refresh            read the users of devices into the snapshot
  GET  /api/attendance/device-control/people                   everyone on the devices and every active employee, filtered
  POST /api/attendance/device-control/users/push               add users to devices (users already there are left alone)
  POST /api/attendance/device-control/users/update             change users on the devices they are on
  POST /api/attendance/device-control/users/delete             delete users from devices; optionally make the employees Inactive
  POST /api/attendance/device-control/employees/<id>/photo     keep a captured photo as the employee's profile photo
  POST /api/attendance/device-control/fetch/start              preview or run a manual fetch of punches
  GET  /api/attendance/device-control/fetch/runs               the history, newest first
  GET  /api/attendance/device-control/fetch/runs/<id>          one run (the page polls this while it runs)

Devices behind a Site Connector (connector_admin_views.py) cannot be answered inside the request, so a read, add,
change or delete that includes one returns 202 {"operation": {...}} and the page polls
GET /api/attendance/device-control/operations/<id> until its `final` answer is there. Changes that touch only
devices the server connects to itself are answered at once (200), as they always were.

They sit under /api/attendance/, so the Attendance module permission decides who may use them, as for the rest of the
Attendance page: a GET needs View, everything else needs Edit. Making an employee Inactive additionally needs Edit on
Employees (see device_directory.delete_users). Reading never changes a device; only the POSTs that say so do.
"""

from __future__ import annotations

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .device_client import on_cloud
from .device_directory import (
    PeopleFilter,
    apply_users,
    delete_users,
    device_summary,
    facets,
    list_people,
    load_people,
    probe_devices,
    save_employee_photo,
    start_refresh,
)
from .branch_scope import get_branch_scope
from .device_directory import SyncRunning
from .device_fetch import FetchConflict, list_runs, serialize_run, start_run
from .models import BiometricDevice, BiometricFetchRun


def _bad(message: str, status: int = 400) -> Response:
    return Response({"error": message}, status=status)


def _int_list(raw) -> list[int] | None:
    """A list of ints from a JSON list or a comma-separated string. None when something in it is not an int."""
    if raw in (None, ""):
        return []
    items = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    try:
        return [int(i) for i in items if str(i).strip() != ""]
    except (TypeError, ValueError):
        return None


def _flag(raw) -> bool:
    """A true/false from a request body. Only a real true (or "true", "1", "yes") is true: the text "false" is false,
    where bool("false") would make a preview an update."""
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("true", "1", "yes")


def _mask(request: Request) -> bool:
    """A branch-limited caller must not be shown names of people outside their branch."""
    return get_branch_scope(request) is not None


def _answer(body: dict) -> Response:
    """200 with the finished answer, or 202 when a connector is still working on it."""
    return Response(body, status=202 if "operation" in body else 200)


def _int_or_none(raw):
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


@api_view(["GET"])
@require_hr
def device_control_overview(request: Request) -> Response:
    devices = list(BiometricDevice.objects.select_related("connector").order_by("name"))
    fresh = request.query_params.get("fresh") in ("1", "true")
    probes = probe_devices(devices, fresh)
    now = timezone.now()
    rows = [device_summary(d, probes.get(d.pk), now) for d in devices]

    # a session that opened proves the device was reachable: keep the capacity it reported
    for d, row in zip(devices, rows):
        probe = probes.get(d.pk)
        if probe and probe["ok"] and probe.get("capacity"):
            stale = not d.last_reachable_at or (now - d.last_reachable_at).total_seconds() > 120
            known = {k: v for k, v in (d.capacity or {}).items() if k != "readAt"}
            if stale or known != probe["capacity"]:
                BiometricDevice.objects.filter(pk=d.pk).update(
                    capacity={**probe["capacity"], "readAt": now.isoformat()}, last_reachable_at=now
                )

    people, _ = load_people(request)
    counts = facets(people, devices)
    active = [r for r in rows if r["isActive"]]
    connected = sum(1 for r in active if r["connection"]["state"] == "connected")
    return Response(
        {
            "generatedAt": now.isoformat(),
            "server": {"deployment": "railway" if on_cloud() else "local"},
            "summary": {
                "configured": len(rows),
                "enabled": len(active),
                "connected": connected,
                "disconnected": len(active) - connected,
                "disabled": len(rows) - len(active),
                "sendingToServer": sum(1 for r in active if r["push"]["state"] == "live"),
                "peopleOnDevices": counts["onDevices"],
                "linked": counts["linked"],
                "deviceOnly": counts["deviceOnly"],
                "hrmsOnly": counts["hrmsOnly"],
                "inactiveOnDevice": counts["inactiveOnDevice"],
            },
            "devices": rows,
        }
    )


@api_view(["POST"])
@require_hr
def device_control_refresh_users(request: Request) -> Response:
    ids = _int_list(request.data.get("deviceIds"))
    if ids is None:
        return _bad("deviceIds must be a list of device ids")
    return _answer(start_refresh(request, ids or None))


@api_view(["GET"])
@require_hr
def device_control_people(request: Request) -> Response:
    q = request.query_params
    device_ids = _int_list(q.get("devices"))
    if device_ids is None:
        return _bad("devices must be a list of device ids")
    f = PeopleFilter(
        search=(q.get("search") or "").strip()[:80],
        device_ids=tuple(device_ids),
        device_mode=q.get("deviceMode") if q.get("deviceMode") in ("any", "all", "none") else "any",
        link=q.get("link")
        if q.get("link") in ("linked", "device_only", "hrms_only", "inactive_on_device", "restricted")
        else "all",
        count=q.get("count") if q.get("count") in ("single", "multiple") else "any",
        role=q.get("role") if q.get("role") in ("admin", "user") else "any",
        employment_type=q.get("employmentType") if q.get("employmentType") in ("staff", "production") else "",
        department_id=_int_or_none(q.get("departmentId")),
        branch_id=_int_or_none(q.get("branchId")),
        differs=q.get("differs") in ("1", "true"),
    )
    return Response(
        list_people(
            request,
            f,
            sort=q.get("sort") or "name",
            desc=q.get("dir") == "desc",
            page=_int_or_none(q.get("page")) or 1,
            page_size=_int_or_none(q.get("pageSize")) or 50,
        )
    )


def _change(request: Request, mode: str) -> Response:
    ids = _int_list(request.data.get("deviceIds"))
    users = request.data.get("users")
    if ids is None or not isinstance(users, list):
        return _bad("deviceIds and users must be lists")
    try:
        return _answer(apply_users(request, ids, users, mode))
    except SyncRunning as exc:
        return _bad(str(exc), 409)
    except ValueError as exc:
        return _bad(str(exc))


@api_view(["POST"])
@require_hr
def device_control_push_users(request: Request) -> Response:
    return _change(request, "create")


@api_view(["POST"])
@require_hr
def device_control_update_users(request: Request) -> Response:
    return _change(request, "update")


@api_view(["POST"])
@require_hr
def device_control_delete_users(request: Request) -> Response:
    user_ids = request.data.get("userIds")
    ids = _int_list(request.data.get("deviceIds"))
    if not isinstance(user_ids, list) or ids is None:
        return _bad("userIds and deviceIds must be lists")
    try:
        return _answer(delete_users(request, user_ids, ids or None, _flag(request.data.get("markInactive"))))
    except SyncRunning as exc:
        return _bad(str(exc), 409)
    except ValueError as exc:
        return _bad(str(exc))


@api_view(["POST"])
@require_hr
def device_control_employee_photo(request: Request, pk: int) -> Response:
    try:
        return Response(save_employee_photo(request, pk, str(request.data.get("photo") or "")))
    except PermissionError as exc:
        return _bad(str(exc), 403)
    except LookupError as exc:
        return _bad(str(exc), 404)
    except ValueError as exc:
        return _bad(str(exc))


@api_view(["POST"])
@require_hr
def device_control_fetch_start(request: Request) -> Response:
    ids = _int_list(request.data.get("deviceIds"))
    rng = request.data.get("range") or {}
    if ids is None or not isinstance(rng, dict):
        return _bad("deviceIds must be a list and range an object")
    try:
        run = start_run(
            request, ids, str(rng.get("preset") or ""), rng.get("from"), rng.get("to"), _flag(request.data.get("apply"))
        )
    except ValueError as exc:
        return _bad(str(exc))
    except FetchConflict as exc:
        return _bad(str(exc), 409)
    return Response(serialize_run(run, mask_names=_mask(request)), status=202)


@api_view(["GET"])
@require_hr
def device_control_fetch_runs(request: Request) -> Response:
    return Response({"runs": list_runs(mask_names=_mask(request))})


@api_view(["GET"])
@require_hr
def device_control_fetch_run(request: Request, pk: int) -> Response:
    run = BiometricFetchRun.objects.filter(pk=pk).first()
    if run is None:
        return _bad("Run not found", 404)
    return Response(serialize_run(run, mask_names=_mask(request)))
