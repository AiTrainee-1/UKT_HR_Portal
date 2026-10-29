"""
Which biometric devices may give an employee's punches (Device Control -> Data Push -> edit a person).

Some people share an Employee Code with a different person on a device in another unit: user "188" on the Head Office
terminal is one man, user "188" on a Unit 1 terminal is another. Matching is by Employee Code only, so the Unit 1 man's
punches would land on Head Office's employee. An employee can therefore be limited to the devices that really are theirs:

  * no devices chosen  = the default: punches from any device are accepted, nothing changes;
  * devices chosen     = ONLY those devices' punches are accepted for this employee; a punch with their code from any
                         other device (or from a device the HRMS does not know) is ignored, never written.

The rule is read where a device's punch becomes an AttendanceLog: the ADMS push, Sync Biometric (pull), Data Fetch / the
Site Connector, and the generic HTTP push. Punches that do not come from a device (the Excel imports, HR's manual entry,
geo / on-duty punches) are never limited by it. A rule never deletes or changes a punch that is already recorded.
"""

from __future__ import annotations

from typing import Iterable

# "This punch did not come from a device" (Excel import, geo, manual): no device rule applies. Passing `None` instead means
# "it came from a device the HRMS cannot name": a limited employee's punch is ignored, an unlimited one is accepted.
NOT_A_DEVICE = object()


def device_rules(employee_ids: Iterable[int] | None = None) -> dict[int, frozenset[int]]:
    """{employee id: the device ids that may give their punches}, only for employees who ARE limited (one query)."""
    from .models import Employee

    through = Employee.punch_devices.through
    qs = through.objects.all()
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=list(employee_ids))
    grouped: dict[int, set[int]] = {}
    for employee_id, device_id in qs.values_list("employee_id", "biometricdevice_id"):
        grouped.setdefault(employee_id, set()).add(device_id)
    return {e: frozenset(d) for e, d in grouped.items()}


def accepts(rules: dict[int, frozenset[int]], employee_id: int, device_id) -> bool:
    """May `employee_id`'s punch from `device_id` be recorded? `device_id` is a device id, None (a device the HRMS cannot
    name) or NOT_A_DEVICE."""
    allowed = rules.get(employee_id)
    if allowed is None or device_id is NOT_A_DEVICE:
        return True
    return device_id in allowed


def device_id_for_serial(serial: str | None) -> int | None:
    """The configured device that reports this serial number (ADMS `SN`, the HTTP push's devSN), or None."""
    from .models import BiometricDevice

    serial = (serial or "").strip()
    if not serial:
        return None
    return BiometricDevice.objects.filter(serial_number=serial).values_list("pk", flat=True).first()
