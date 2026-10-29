"""
Which biometric devices are LINKED to an employee (Device Control -> Link / Unlink).

Some people share an Employee Code with a different person on a device in another unit: user "188" on the Head Office
terminal is one man, user "188" on a Unit 1 terminal is another. Matching is by Employee Code only, so the Unit 1 man's
punches would land on Head Office's employee. An employee's devices can therefore be unlinked one by one:

  * every device is linked to every employee by default, and a device added later is linked too: nothing is stored for an
    employee until a device is unlinked from them, and nothing changes for anyone who has none unlinked;
  * a punch with an employee's code from a device UNLINKED from that employee is ignored, never written; a punch from any
    other device (linked, or one the HRMS cannot name) is recorded as always.

The rule is read where a device's punch becomes an AttendanceLog: the ADMS push, Sync Biometric (pull), Data Fetch / the
Site Connector, and the generic HTTP push. Punches that do not come from a device (the Excel imports, HR's manual entry,
geo / on-duty punches) are never limited by it. A rule never deletes or changes a punch that is already recorded.
"""

from __future__ import annotations

from typing import Iterable

# "This punch did not come from a device" (Excel import, geo, manual): no device rule applies. Passing `None` instead means
# "it came from a device the HRMS cannot name": it is not an unlinked device, so the punch is accepted.
NOT_A_DEVICE = object()


def device_rules(employee_ids: Iterable[int] | None = None) -> dict[int, frozenset[int]]:
    """{employee id: the device ids UNLINKED from them}, only for employees who have one (one query)."""
    from .models import Employee

    through = Employee.unlinked_devices.through
    qs = through.objects.all()
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=list(employee_ids))
    grouped: dict[int, set[int]] = {}
    for employee_id, device_id in qs.values_list("employee_id", "biometricdevice_id"):
        grouped.setdefault(employee_id, set()).add(device_id)
    return {e: frozenset(d) for e, d in grouped.items()}


def accepts(rules: dict[int, frozenset[int]], employee_id: int, device_id) -> bool:
    """May `employee_id`'s punch from `device_id` be recorded? `device_id` is a device id, None (a device the HRMS cannot
    name) or NOT_A_DEVICE. Only a device that is unlinked from the employee says no."""
    unlinked = rules.get(employee_id)
    if not unlinked or device_id is NOT_A_DEVICE or device_id is None:
        return True
    return device_id not in unlinked


def device_id_for_serial(serial: str | None) -> int | None:
    """The configured device that reports this serial number (ADMS `SN`, the HTTP push's devSN), or None."""
    from .models import BiometricDevice

    serial = (serial or "").strip()
    if not serial:
        return None
    return BiometricDevice.objects.filter(serial_number=serial).values_list("pk", flat=True).first()
