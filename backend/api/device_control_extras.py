"""
Device Control additions (owner 2026-11-17): the Link / Unlink summary and its history, the history of user changes on the
devices, and the employee picker of Data Fetch.

  GET /api/attendance/device-control/links/summary    ?employmentType=staff|production   who is on which device, linked
  GET /api/attendance/device-control/links/history    ?search=&action=link|unlink&employmentType=&device=&page=
  GET /api/attendance/device-control/users/history    ?kind=create|update|delete&search=&page=
  GET /api/attendance/device-control/fetch/employees  ?search=&employmentType=      active employees to fetch one of

Everything here only reads. The histories are written where the changes happen: EmployeeDeviceLinkChange by
device_directory.set_employee_device_links, BiometricUserChange where a user change finishes (device_directory
finish_apply / finish_delete), which is the same code for a device the server talks to itself and for one behind a Site
Connector, so both are in the history.

"Registered" on a device = a user with the employee's code is in the device's user list as it was last read (Data Push ->
Read). "Linked" = the device's punches are taken for the employee (every device is, unless unlinked on Link / Unlink).
A branch-limited caller sees the employees of their branch only, and no names of other branches in the histories.
"""

from __future__ import annotations

from django.db.models import Q

from .branch_scope import get_branch_scope, scope_to_branch
from .models import BiometricDevice, BiometricDeviceUser, BiometricUserChange, Employee, EmployeeDeviceLinkChange

PAGE_SIZE = 50
EMPLOYMENT_TYPES = ("staff", "production")


def _type_of(raw) -> str:
    return raw if raw in EMPLOYMENT_TYPES else ""


def _name(e) -> str:
    return f"{e.first_name or ''} {e.last_name or ''}".strip()


def _actor(request) -> str:
    user = getattr(request, "jwt_user", {}) or {}
    return user.get("name") or user.get("username") or ""


# ── Link / Unlink -> Home ─────────────────────────────────────────────────────────────────────────────────────────


def link_summary(request, employment_type: str = "") -> dict:
    """Who is registered on which device and which devices are linked, for the active employees the caller may see
    (optionally one employment type), and every device's own numbers."""
    employment_type = _type_of(employment_type)
    devices = list(BiometricDevice.objects.order_by("name"))
    device_ids = [d.pk for d in devices]
    emps = scope_to_branch(Employee.objects, request).filter(status="active").defer("photo_url")
    if employment_type:
        emps = emps.filter(employment_type=employment_type)
    employees = {str(e.employee_code).strip(): e for e in emps.only("id", "employee_code", "employment_type")}
    by_id = {e.pk: e for e in employees.values()}

    # everyone the caller may see, for the device's own numbers (inactive employees, the other type)
    everyone = {
        str(code).strip(): (status, kind)
        for code, status, kind in scope_to_branch(Employee.objects, request).values_list(
            "employee_code", "status", "employment_type"
        )
    }
    registered: dict[str, set[int]] = {}
    per_device_users: dict[int, list[str]] = {pk: [] for pk in device_ids}
    for device_id, user_id in BiometricDeviceUser.objects.values_list("device_id", "user_id"):
        code = str(user_id).strip()
        per_device_users.setdefault(device_id, []).append(code)
        if code in employees:
            registered.setdefault(code, set()).add(device_id)
    unlinked: dict[int, set[int]] = {}
    for emp_id, device_id in Employee.unlinked_devices.through.objects.filter(employee_id__in=list(by_id)).values_list(
        "employee_id", "biometricdevice_id"
    ):
        unlinked.setdefault(emp_id, set()).add(device_id)

    on_any = on_multiple = linked_multiple = with_unlinked = 0
    for code, e in employees.items():
        on = registered.get(code, set())
        linked_on = on - unlinked.get(e.pk, set())
        on_any += bool(on)
        on_multiple += len(on) >= 2
        linked_multiple += len(linked_on) >= 2
        with_unlinked += bool(unlinked.get(e.pk))

    rows = []
    for d in devices:
        codes = per_device_users.get(d.pk, [])
        staff = production = inactive = unknown = other_type = elsewhere = unlinked_here = 0
        for code in codes:
            known = everyone.get(code)
            if known is None:
                unknown += 1
                continue
            status, kind = known
            if status != "active":
                inactive += 1
                continue
            if code not in employees:
                other_type += 1
                continue
            staff += kind == "staff"
            production += kind == "production"
            elsewhere += len(registered.get(code, set())) >= 2
            unlinked_here += d.pk in unlinked.get(employees[code].pk, set())
        rows.append(
            {
                "deviceId": d.pk,
                "deviceName": d.name,
                "isActive": d.is_active,
                "via": "connector" if d.connector_id else "direct",
                "usersOnDevice": len(codes),
                "employees": staff + production,
                "staff": staff,
                "production": production,
                "alsoOnOtherDevices": elsewhere,
                "unlinkedHere": unlinked_here,
                "inactiveEmployees": inactive,
                "notInHrms": unknown,
                "otherType": other_type,
                "usersReadAt": d.users_read_at.isoformat() if getattr(d, "users_read_at", None) else None,
            }
        )
    return {
        "employmentType": employment_type,
        "summary": {
            "employees": len(employees),
            "onAnyDevice": on_any,
            "onNoDevice": len(employees) - on_any,
            "onMultipleDevices": on_multiple,
            "linkedToMultipleDevices": linked_multiple,
            "withUnlinkedDevices": with_unlinked,
            "devices": len(devices),
        },
        "devices": rows,
    }


# ── Link / Unlink -> Modified ─────────────────────────────────────────────────────────────────────────────────────


def record_link_changes(request, emp, before: list[int], after: list[int], names: dict[int, str]) -> None:
    """One history row per device whose state changed: unlinked now (and not before), or linked again."""
    by = _actor(request)
    rows = [
        EmployeeDeviceLinkChange(
            employee=emp,
            device_id=pk,
            device_name=names.get(pk, ""),
            action=EmployeeDeviceLinkChange.ACTION_UNLINK,
            changed_by=by,
        )
        for pk in sorted(set(after) - set(before))
    ] + [
        EmployeeDeviceLinkChange(
            employee=emp,
            device_id=pk if pk in names else None,
            device_name=names.get(pk, ""),
            action=EmployeeDeviceLinkChange.ACTION_LINK,
            changed_by=by,
        )
        for pk in sorted(set(before) - set(after))
    ]
    if rows:
        EmployeeDeviceLinkChange.objects.bulk_create(rows)


def link_history(
    request, search: str = "", action: str = "", employment_type: str = "", device_id=None, page=1
) -> dict:
    """The link / unlink changes, newest first, of the employees the caller may see; and who has devices unlinked now."""
    employment_type = _type_of(employment_type)
    emps = scope_to_branch(Employee.objects.all(), request)
    qs = EmployeeDeviceLinkChange.objects.filter(employee__in=emps).select_related(
        "employee", "employee__department", "device"
    )
    if action in (EmployeeDeviceLinkChange.ACTION_LINK, EmployeeDeviceLinkChange.ACTION_UNLINK):
        qs = qs.filter(action=action)
    if employment_type:
        qs = qs.filter(employee__employment_type=employment_type)
    if device_id:
        qs = qs.filter(device_id=device_id)
    search = (search or "").strip()
    if search:
        cond = Q()
        for w in search.split():
            cond &= (
                Q(employee__employee_code__icontains=w)
                | Q(employee__first_name__icontains=w)
                | Q(employee__last_name__icontains=w)
            )
        qs = qs.filter(cond)
    total = qs.count()
    page = max(1, int(page or 1))
    rows = list(qs.order_by("-created_at", "-id")[(page - 1) * PAGE_SIZE : page * PAGE_SIZE])

    # who has a device unlinked right now (the state the history led to)
    names = dict(BiometricDevice.objects.values_list("pk", "name"))
    current_q = Employee.unlinked_devices.through.objects.filter(employee__in=emps)
    if employment_type:
        current_q = current_q.filter(employee__employment_type=employment_type)
    current: dict[int, list[str]] = {}
    for emp_id, dev_id in current_q.values_list("employee_id", "biometricdevice_id"):
        current.setdefault(emp_id, []).append(names.get(dev_id, f"#{dev_id}"))
    people = {
        e.pk: e
        for e in Employee.objects.filter(pk__in=list(current))
        .select_related("department")
        .only("id", "employee_code", "first_name", "last_name", "employment_type", "department__name")
    }

    def emp_json(e) -> dict:
        return {
            "id": e.pk,
            "code": e.employee_code,
            "name": _name(e),
            "employmentType": e.employment_type,
            "department": e.department.name if e.department_id and e.department else None,
        }

    return {
        "total": total,
        "page": page,
        "pageSize": PAGE_SIZE,
        "rows": [
            {
                "id": r.pk,
                "employee": emp_json(r.employee),
                "deviceId": r.device_id,
                "deviceName": r.device.name if r.device else r.device_name,
                "action": r.action,
                "changedBy": r.changed_by,
                "at": r.created_at.isoformat(),
            }
            for r in rows
        ],
        "current": [
            {"employee": emp_json(people[pk]), "unlinkedDevices": sorted(devs)}
            for pk, devs in sorted(
                current.items(), key=lambda kv: str(people[kv[0]].employee_code) if kv[0] in people else ""
            )
            if pk in people
        ],
    }


# ── Data Push -> the history of user changes ──────────────────────────────────────────────────────────────────────


def record_user_change(
    request,
    kind: str,
    devices,
    entries: list[dict],
    rejected: list[dict],
    context: str = "",
    user_ids=None,
    user_names=None,
) -> None:
    """One history row for an add / change / delete as it finished (see the module docstring)."""
    ids = list(dict.fromkeys(str(u) for u in (user_ids or [])))
    if not ids:
        for e in entries:
            for key in ("added", "updated", "deleted", "absent", "skipped", "failed"):
                for item in e.get(key) or []:
                    ids.append(str(item.get("userId") if isinstance(item, dict) else item))
        ids = list(dict.fromkeys(ids))
    failed_devices = sum(1 for e in entries if not e.get("ok"))
    failed_users = sum(len(e.get("failed") or []) for e in entries)
    if entries and failed_devices == len(entries):
        status = "failed"
    elif failed_devices or failed_users or rejected:
        status = "partial"
    else:
        status = "done"
    BiometricUserChange.objects.create(
        kind=kind,
        context=(context or "")[:30],
        user_ids=ids[:500],
        user_names={k: v for k, v in (user_names or {}).items() if k in set(ids[:500])},
        device_ids=[d.pk for d in devices],
        device_names=[d.name for d in devices],
        results=entries,
        rejected=rejected or [],
        status=status,
        via_connector=any(getattr(d, "connector_id", None) for d in devices),
        requested_by=_actor(request),
    )


def user_history(request, kind: str = "", search: str = "", page=1, contexts=None) -> dict:
    """The user changes on the devices, newest first. A branch-limited caller sees the IDs, not the names.
    `contexts` keeps only the changes made for those reasons (Data Push -> Edit Users shows edits, copies and moves)."""
    qs = BiometricUserChange.objects.all()
    if kind in ("create", "update", "delete"):
        qs = qs.filter(kind=kind)
    if contexts:
        qs = qs.filter(context__in=list(contexts))
    search = (search or "").strip()
    if search:
        qs = qs.filter(
            Q(user_ids__icontains=search) | Q(user_names__icontains=search) | Q(device_names__icontains=search)
        )
    total = qs.count()
    page = max(1, int(page or 1))
    mask = get_branch_scope(request) is not None
    rows = []
    for c in qs[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]:
        rows.append(
            {
                "id": c.pk,
                "kind": c.kind,
                "context": c.context,
                "status": c.status,
                "userIds": c.user_ids,
                "userNames": {} if mask else c.user_names,
                "deviceNames": c.device_names,
                "results": [
                    {
                        "deviceName": e.get("deviceName"),
                        "ok": e.get("ok"),
                        "error": e.get("error"),
                        "added": len(e.get("added") or []),
                        "updated": len(e.get("updated") or []),
                        "deleted": len(e.get("deleted") or []),
                        "absent": len(e.get("absent") or []),
                        "skipped": len(e.get("skipped") or []),
                        "failed": len(e.get("failed") or []),
                    }
                    for e in c.results
                ],
                "rejected": len(c.rejected or []),
                "viaConnector": c.via_connector,
                "requestedBy": c.requested_by,
                "at": c.created_at.isoformat(),
            }
        )
    return {"total": total, "page": page, "pageSize": PAGE_SIZE, "rows": rows}


# ── Data Fetch -> choose one employee ────────────────────────────────────────────────────────────────────────────


def fetch_employee_search(request, search: str = "", employment_type: str = "", limit: int = 20) -> dict:
    """Active employees (the caller's branch) by code or name, for fetching one employee's punches."""
    employment_type = _type_of(employment_type)
    qs = scope_to_branch(Employee.objects, request).filter(status="active").select_related("department")
    if employment_type:
        qs = qs.filter(employment_type=employment_type)
    search = (search or "").strip()
    if search:
        exact = list(qs.filter(employee_code=search)[:1])
        cond = Q()
        for w in search.split():
            cond &= Q(employee_code__icontains=w) | Q(first_name__icontains=w) | Q(last_name__icontains=w)
        rows = exact + [
            e for e in qs.filter(cond).order_by("employee_code")[:limit] if not exact or e.pk != exact[0].pk
        ]
    else:
        rows = list(qs.order_by("employee_code")[:limit])
    codes = [str(e.employee_code).strip() for e in rows]
    on: dict[str, list[str]] = {}
    names = dict(BiometricDevice.objects.values_list("pk", "name"))
    for user_id, device_id in BiometricDeviceUser.objects.filter(user_id__in=codes).values_list("user_id", "device_id"):
        on.setdefault(str(user_id).strip(), []).append(names.get(device_id, ""))
    return {
        "items": [
            {
                "id": e.pk,
                "code": str(e.employee_code).strip(),
                "name": _name(e),
                "employmentType": e.employment_type,
                "department": e.department.name if e.department_id and e.department else None,
                "onDevices": sorted(on.get(str(e.employee_code).strip(), [])),
            }
            for e in rows[:limit]
        ]
    }
