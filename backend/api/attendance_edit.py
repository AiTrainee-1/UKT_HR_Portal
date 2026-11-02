"""
The Attendance Edit page: the attendance types HR can propose for a day, and what happens when a proposal is fully approved.

Every change goes through ONE pipeline (approval_workflow.py, workflow ``attendance_correction``): HR proposes it, the
employee's Department Head approves it first, then HR approves it, and only then is the day's attendance record
written. Until then the day stays exactly as it was (a pending request never changes a record). The pipeline is fixed and
cannot be switched off.

The types (the keys are what the page sends):

  present, full_day, half_day, quarter_shift (0.25), three_quarter_shift (0.75)
  compensation, sunday_compensation, ot_compensation   a paid day given as compensation, worth 0.25 / 0.50 / 0.75 / 1.00 shift
  absent, on_leave, holiday

The three compensation types set the day as compensated (a paid, worked-equivalent day) and mark it with the compensation
marker; they do NOT credit or debit the compensation balance (HR does that on the Compensation page).

Options added 2026-11-02 (the `type` the page sends, with one sub-choice in `choice`), same pipeline, applied when approved:

  permission    choice morning_late_in | evening_early_out | middle_permission (60 minutes, fixed). Staff only. Applied as
                an APPROVED EmployeePermission of that type (the employee's own waiting request of the same type is approved,
                an approved one is reused), so it uses the monthly allowance and the deduction rules like any approved
                permission; the day is then recomputed by the engine (a day HR already fixed by hand stays as fixed).
  late          choice mark | unmark. Applied as a manual day: the engine's verdict of the day as it stands at approval,
                with the Late mark set / taken away, so it counts / stops counting in the late pool.
  casual_leave  choice full | first_half | second_half. Staff only, the Casual Leave rules (6 months' service, the yearly
                balance counting what is waiting, no same half twice on a date) are checked when HR proposes it, and the
                proposal holds its days in the balance while it waits. Applied as an APPROVED CasualLeaveRequest and written
                to the day exactly as an approved Casual Leave is (casual_leave_views._write_attendance_for_cl).
  on_duty       no choice. Applied as a manual day: Present, 1.00 shift, no Late / Early-Out, primary source "On-Duty"
                (the calendars show it as an On-Duty day: hr_edit_marks.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from django.utils import timezone

from .models import AttendanceDayRecord, AttendanceLog, AttendanceOverrideRequest, BiometricDevice, Employee

SHIFT_CHOICES = (Decimal("0.25"), Decimal("0.50"), Decimal("0.75"), Decimal("1.00"))
COMPENSATION_KIND = "relaxation"  # the existing marker kind for a day topped up by compensation


@dataclass(frozen=True)
class EditType:
    key: str
    label: str
    group: str  # "Attendance" | "Compensation" | "Other"
    status: str  # AttendanceDayRecord.status
    shifts: Decimal
    description: str
    worked: bool = True  # shows the first in / last out times and the Late / Early Out marks
    shift_choices: tuple[Decimal, ...] = ()  # when the amount can be chosen (compensation)
    marker: str = ""  # compensation_kind written on the day

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "group": self.group,
            "status": self.status,
            "shifts": f"{self.shifts:.2f}",
            "description": self.description,
            "worked": self.worked,
            "shiftChoices": [f"{c:.2f}" for c in self.shift_choices],
            "compensation": bool(self.marker),
        }


TYPES: tuple[EditType, ...] = (
    EditType("present", "Present", "Attendance", "present", Decimal("1.00"), "A worked day: 1 shift."),
    EditType("half_day", "Half Day", "Attendance", "half_shift", Decimal("0.50"), "Half a day worked: 0.50 shift."),
    EditType("full_day", "Full Day", "Attendance", "present", Decimal("1.00"), "A full day worked: 1.00 shift."),
    EditType(
        "quarter_shift", "0.25 Shift", "Attendance", "present", Decimal("0.25"), "A quarter of a day: 0.25 shift."
    ),
    EditType(
        "three_quarter_shift",
        "0.75 Shift",
        "Attendance",
        "present",
        Decimal("0.75"),
        "Three quarters of a day: 0.75 shift (a full day less a quarter).",
    ),
    EditType(
        "compensation",
        "Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "A paid day given as compensation. Choose how much of a shift it is worth.",
        shift_choices=SHIFT_CHOICES,
        marker=COMPENSATION_KIND,
    ),
    EditType(
        "sunday_compensation",
        "Sunday Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "A paid day given in return for Sunday work. Choose how much of a shift it is worth.",
        shift_choices=SHIFT_CHOICES,
        marker=COMPENSATION_KIND,
    ),
    EditType(
        "ot_compensation",
        "OT Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "A paid day given in return for overtime. Choose how much of a shift it is worth.",
        shift_choices=SHIFT_CHOICES,
        marker=COMPENSATION_KIND,
    ),
    EditType("absent", "Absent", "Other", "absent", Decimal("0.00"), "Not worked, not paid.", worked=False),
    EditType("on_leave", "On Leave", "Other", "on_leave", Decimal("0.00"), "A leave day.", worked=False),
    EditType(
        "holiday",
        "Holiday",
        "Other",
        "holiday",
        Decimal("0.00"),
        "A holiday: paid, no attendance needed.",
        worked=False,
    ),
)
BY_KEY = {t.key: t for t in TYPES}


class EditError(ValueError):
    """A proposal the page sent that cannot be accepted; the message is a plain sentence for HR."""


def catalogue() -> list[dict]:
    return [t.to_json() for t in TYPES]


def _reason(data: dict) -> str:
    note = str(data.get("note") or "").strip()
    if len(note) < 3:
        raise EditError("Give a reason for the change (a few words): the Department Head and HR read it.")
    return note


def resolve(data: dict) -> dict:
    """The `requested_values` of a proposal from what the Attendance Edit page sent (type, shifts, firstPunch, lastPunch,
    isLate, isEarlyOut, note). Validates everything; raises EditError."""
    t = BY_KEY.get(str(data.get("type") or ""))
    if t is None:
        raise EditError("Choose an attendance type.")
    note = _reason(data)

    shifts = t.shifts
    if t.shift_choices:
        try:
            shifts = Decimal(str(data.get("shifts", t.shifts))).quantize(Decimal("0.01"))
        except Exception:  # noqa: BLE001
            raise EditError("The shift value is not a number.") from None
        if shifts not in t.shift_choices:
            raise EditError("A compensation day is worth 0.25, 0.50, 0.75 or 1.00 shift.")

    values = {
        "type": t.key,
        "option": GROUP_OF_TYPE_GROUP[t.group],
        "typeLabel": t.label,
        "status": t.status,
        "isHalfShift": t.status == "half_shift",
        "isLate": bool(data.get("isLate", False)) if t.worked else False,
        "isEarlyOut": bool(data.get("isEarlyOut", False)) if t.worked else False,
        "firstPunch": (data.get("firstPunch") or None) if t.worked else None,
        "lastPunch": (data.get("lastPunch") or None) if t.worked else None,
        "shiftsEarned": f"{shifts:.2f}",
        "note": f"{t.label}: {note}",
        "reason": note,
    }
    if t.marker:
        values["compensationKind"] = t.marker
        values["compensationNote"] = f"{t.label} ({shifts:.2f} shift) approved by the Department Head and HR"
    return values


def snapshot(record: AttendanceDayRecord) -> dict:
    """The day as it is now, kept on the request so the approvers see what is being replaced."""
    return {
        "status": record.status,
        "isLate": record.is_late,
        "isEarlyOut": record.early_leave,
        "isHalfShift": record.is_half_shift,
        "firstPunch": record.first_punch.strftime("%H:%M") if record.first_punch else None,
        "lastPunch": record.last_punch.strftime("%H:%M") if record.last_punch else None,
        "shiftsEarned": f"{Decimal(str(record.shifts_earned or 0)):.2f}",
        "note": record.override_note,
        "source": record.source,
    }


def _device_of(raw: str, names_by_serial: dict[str, str]) -> str | None:
    """Which device or tool a punch came from, when its source tag says: the biometric device's name, or what uploaded it."""
    raw = (raw or "").strip()
    if raw.startswith("biometric:adms:"):
        serial = raw.split(":", 2)[2]
        return names_by_serial.get(serial) or f"device {serial}"
    if raw == "biometric:excel-import":
        return "Excel import"
    if raw.startswith("biometric:"):
        return raw[len("biometric:") :]
    if raw == "manual:punch-view":
        return "Punch View upload"
    return None


def day_punches(emp: Employee, d) -> list[dict]:
    """Every punch the employee has on this calendar day, in time order, each with where it came from (the source tag, a plain
    label, and the biometric device when it came from one)."""
    from .geo_attendance_views import source_label

    names = dict(BiometricDevice.objects.exclude(serial_number="").values_list("serial_number", "name"))
    out = []
    for log in AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time", "id"):
        out.append(
            {
                "id": log.pk,
                "time": log.punch_time.strftime("%H:%M:%S"),
                "type": log.punch_type,
                "source": log.source or "",
                "sourceLabel": "Punch View" if log.source == "manual:punch-view" else source_label(log.source or ""),
                "device": _device_of(log.source or "", names),
                "recordedAt": log.created_at.isoformat() if log.created_at else None,
            }
        )
    return out


def hod_of(emp: Employee):
    """The employee's one Department Head (a DepartmentManager) who can actually decide their requests, or None: nobody is
    assigned, or the only head is the employee themselves (a head never decides their own request)."""
    from .hod_scope import effective_manager

    m = effective_manager(emp)
    if m is None or m.employee_id == emp.pk:
        return None
    return m


def finalize(req: AttendanceOverrideRequest, reviewer: str, request=None) -> AttendanceDayRecord:
    """Both approvals are in: apply the change and put what changed in the Punch View History. The attendance types write
    the day's record (a manual record, which the engine never recomputes); the options added 2026-11-02 apply their own way
    (see the module docstring and APPLIERS)."""
    from .attendance_final import compute_day_record
    from .growth_views import apply_override_values

    record = AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first()
    if record is None:
        record = compute_day_record(req.employee, req.date)
    before = _history_state(record)
    applier = APPLIERS.get((req.requested_values or {}).get("option"))
    if applier is not None:
        record = applier(req, reviewer)
    else:
        apply_override_values(record, req.requested_values, reviewer)
    if request is not None:
        from .punch_history import PunchViewHistory, entry, save_entries

        values = req.requested_values or {}
        trail = req.approval_trail or []
        who = ", ".join(
            f"{e.get('by')} ({str(e.get('role')).upper()})" for e in trail if e.get("decision") == "approved"
        )
        save_entries(
            [
                entry(
                    request,
                    PunchViewHistory.ACTION_STATUS_SET,
                    req.employee,
                    req.date,
                    before=before,
                    after=_history_state(record),
                    note=f"{values.get('typeLabel') or 'Attendance edit'}: {values.get('reason') or ''} - approved by {who}",
                )
            ]
        )
    return record


def _history_state(record: AttendanceDayRecord) -> dict:
    from .punch_history import _state_of

    return _state_of(record)


# ── The option groups of the Attendance Edit dialog (2026-11-02) ─────────────────────────────────────────────────────

GROUP_WORKED, GROUP_COMPENSATION, GROUP_NOT_WORKED = "worked", "compensation", "not_worked"
OPTION_PERMISSION, OPTION_LATE, OPTION_CASUAL_LEAVE, OPTION_ON_DUTY = "permission", "late", "casual_leave", "on_duty"
NEW_OPTIONS = (OPTION_PERMISSION, OPTION_LATE, OPTION_CASUAL_LEAVE, OPTION_ON_DUTY)
GROUP_OF_TYPE_GROUP = {"Attendance": GROUP_WORKED, "Compensation": GROUP_COMPENSATION, "Other": GROUP_NOT_WORKED}
LATE_MARK, LATE_UNMARK = "mark", "unmark"
WORKED_STATUSES = ("present", "half_shift")
STATUS_LABEL = {
    "present": "Present",
    "half_shift": "Half Day",
    "absent": "Absent",
    "on_leave": "On Leave",
    "holiday": "Holiday",
}

GROUPS: tuple[tuple[str, str, str], ...] = (
    (GROUP_WORKED, "Worked", "The day was worked: choose how much of a shift it counts."),
    (
        GROUP_COMPENSATION,
        "Compensation",
        "A paid day given in return for extra work (the compensation balance is not touched).",
    ),
    (GROUP_NOT_WORKED, "Not worked", "The day was not worked."),
    (
        OPTION_PERMISSION,
        "Permission",
        "Give the day an approved permission: it uses the monthly permission allowance and follows the same rules as a "
        "permission the employee asked for.",
    ),
    (
        OPTION_LATE,
        "Late",
        "Mark the day Late, or take its Late mark away: it then counts, or stops counting, toward the late deductions.",
    ),
    (
        OPTION_CASUAL_LEAVE,
        "Casual Leave",
        "Give the day as paid Casual Leave: it uses the employee's yearly Casual Leave balance (12 days a year).",
    ),
    (
        OPTION_ON_DUTY,
        "On-Duty",
        "The employee worked away from the branch: the day counts as Present (1.00 shift) with an On-Duty label.",
    ),
)
GROUP_LABEL = {key: label for key, label, _description in GROUPS}
GROUP_DESCRIPTION = {key: description for key, _label, description in GROUPS}

PERMISSION_CHOICES = (
    (
        "morning_late_in",
        "Arrive up to 60 minutes after the shift start without a Late mark (within the monthly allowance).",
    ),
    (
        "evening_early_out",
        "Leave up to 60 minutes before the shift end without an Early-Out mark (within the allowance).",
    ),
    ("middle_permission", "Step out for one hour in the middle of the shift (it moves no start or end time)."),
)
LATE_CHOICES = (
    (LATE_MARK, "Mark as Late", "The day counts as one Late in the late deductions."),
    (LATE_UNMARK, "Unmark Late", "The Late mark is taken away: the day no longer counts toward the late deductions."),
)
CL_CHOICES = (
    ("full", "Full day", Decimal("1"), "The whole day is paid Casual Leave (1 day of the balance)."),
    ("first_half", "First half", Decimal("0.5"), "The first half is paid Casual Leave (0.5 day); the other half counts by the punches."),
    ("second_half", "Second half", Decimal("0.5"), "The second half is paid Casual Leave (0.5 day); the other half counts by the punches."),
)  # fmt: skip


def group_of(values: dict | None) -> str:
    """The option group of a request's requested_values (requests saved before 2026-11-02 carry no "option")."""
    values = values or {}
    option = values.get("option")
    if option:
        return str(option)
    t = BY_KEY.get(str(values.get("type") or ""))
    if t is not None:
        return GROUP_OF_TYPE_GROUP[t.group]
    return GROUP_WORKED if values.get("status") in WORKED_STATUSES else GROUP_NOT_WORKED


def _day_text(d: date) -> str:
    return d.strftime("%d %b %Y")


def _num(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def _choice_json(value, label, description, *, shifts=None, days=None, minutes=None, reason=None) -> dict:
    return {
        "value": value,
        "label": label,
        "description": description,
        "shifts": shifts,
        "days": days,
        "durationMinutes": minutes,
        "available": reason is None,
        "unavailableReason": reason,
    }


def _item_json(key, label, group, *, status=None, shifts=None, shift_choices=(), choices=(), worked=False,
               compensation=False, staff_only=False, reason=None, description=None) -> dict:  # fmt: skip
    if reason is None and choices and not any(c["available"] for c in choices):
        reason = next((c["unavailableReason"] for c in choices if c["unavailableReason"]), None)
    return {
        "key": key,
        "label": label,
        "group": group,
        "groupLabel": GROUP_LABEL[group],
        "description": description or GROUP_DESCRIPTION[group],
        "status": status,
        "shifts": shifts,
        "shiftChoices": list(shift_choices),
        "choices": list(choices),
        "choiceRequired": bool(choices),
        "worked": worked,
        "compensation": compensation,
        "staffOnly": staff_only,
        "available": reason is None,
        "unavailableReason": reason,
    }


def _type_item(t: EditType) -> dict:
    return _item_json(
        t.key,
        t.label,
        GROUP_OF_TYPE_GROUP[t.group],
        description=t.description,
        status=t.status,
        shifts=f"{t.shifts:.2f}",
        shift_choices=[f"{c:.2f}" for c in t.shift_choices],
        worked=t.worked,
        compensation=bool(t.marker),
    )


def _pending_override_ids(emp: Employee, d: date) -> list[int]:
    """The edits of this day still waiting: a new proposal replaces them, so their Casual Leave must not hold the balance."""
    return list(
        AttendanceOverrideRequest.objects.filter(
            employee=emp, date=d, status=AttendanceOverrideRequest.STATUS_PENDING
        ).values_list("pk", flat=True)
    )


def _permission_taken(emp: Employee, d: date, kind: str) -> str | None:
    from .models import EmployeePermission

    held = list(
        EmployeePermission.objects.filter(
            employee=emp, date=d, status__in=("pending", "approved"), type__in=EmployeePermission.type_values(kind)
        ).values_list("status", flat=True)
    )
    if not held:
        return None
    label = EmployeePermission.TYPE_LABELS[kind]
    if "approved" in held:
        return f"{_day_text(d)} already has an approved {label} permission."
    return f"{_day_text(d)} already has a {label} permission request waiting for approval: decide that request instead."


def _late_refusal(record: AttendanceDayRecord, action: str) -> str | None:
    d = _day_text(record.date)
    if action == LATE_MARK:
        if record.status not in WORKED_STATUSES:
            status = STATUS_LABEL.get(record.status, record.status)
            return f"{d} is not a worked day ({status}), so it cannot be marked Late."
        if record.is_late:
            return f"{d} is already marked Late."
        return None
    if not record.is_late:
        return f"{d} is not marked Late, so there is no Late mark to take away."
    return None


def _permission_item(emp, d, record) -> dict:
    from .models import EmployeePermission

    staff_reason = None
    if emp is not None and emp.employment_type == "production":
        staff_reason = "Permission applies to staff only: production attendance has no permissions."
    choices = [
        _choice_json(
            kind,
            EmployeePermission.TYPE_LABELS[kind],
            text,
            minutes=EmployeePermission.FIXED_DURATION_MINUTES,
            reason=staff_reason or (_permission_taken(emp, d, kind) if emp is not None and d is not None else None),
        )
        for kind, text in PERMISSION_CHOICES
    ]
    return _item_json(
        OPTION_PERMISSION,
        "Permission",
        OPTION_PERMISSION,
        choices=choices,
        worked=True,
        staff_only=True,
        reason=staff_reason,
    )


def _late_item(emp, d, record) -> dict:
    choices = [
        _choice_json(value, label, text, reason=_late_refusal(record, value) if record is not None else None)
        for value, label, text in LATE_CHOICES
    ]
    return _item_json(OPTION_LATE, "Late", OPTION_LATE, choices=choices, worked=True)


def _cl_item(emp, d, record) -> dict:
    staff_reason = None
    if emp is not None and emp.employment_type != "staff":
        staff_reason = "Casual Leave is available only for staff employees."
    exclude = _pending_override_ids(emp, d) if emp is not None and d is not None else []
    choices = []
    for value, label, days, text in CL_CHOICES:
        reason = staff_reason
        if reason is None and emp is not None and d is not None:
            from .casual_leave_views import check_cl_eligibility

            ok, why = check_cl_eligibility(emp, d, value, exclude_override_ids=exclude)
            reason = None if ok else why
        choices.append(_choice_json(value, label, text, shifts=f"{days:.2f}", days=_num(days), reason=reason))
    return _item_json(
        OPTION_CASUAL_LEAVE,
        "Casual Leave",
        OPTION_CASUAL_LEAVE,
        status="present",
        choices=choices,
        staff_only=True,
        reason=staff_reason,
    )


def _on_duty_item(emp, d, record) -> dict:
    return _item_json(OPTION_ON_DUTY, "On-Duty", OPTION_ON_DUTY, status="present", shifts="1.00", worked=True)


_OPTION_ITEMS = {
    OPTION_PERMISSION: _permission_item,
    OPTION_LATE: _late_item,
    OPTION_CASUAL_LEAVE: _cl_item,
    OPTION_ON_DUTY: _on_duty_item,
}


def option_catalogue(emp: Employee | None = None, d: date | None = None, record=None) -> list[dict]:
    """The Attendance Edit dialog's options in groups: [{key, label, description, items: [...]}]. With an employee, a date
    and the day's record, every item and sub-choice says whether it can be chosen for that day (`available`) and if not,
    why (`unavailableReason`); without them everything is available."""
    out = []
    for key, label, description in GROUPS:
        if key in (GROUP_WORKED, GROUP_COMPENSATION, GROUP_NOT_WORKED):
            items = [_type_item(t) for t in TYPES if GROUP_OF_TYPE_GROUP[t.group] == key]
        else:
            items = [_OPTION_ITEMS[key](emp, d, record)]
        out.append({"key": key, "label": label, "description": description, "items": items})
    return out


def _choice(data: dict, *aliases: str) -> str:
    for name in ("choice", *aliases):
        value = data.get(name)
        if value not in (None, ""):
            return str(value).strip()
    return ""


def resolve_option(data: dict, emp: Employee, d: date, record: AttendanceDayRecord) -> dict:
    """The `requested_values` of a Permission / Late / Casual Leave / On-Duty proposal (type = the option, its sub-choice in
    `choice`), checked against the employee and the day as it is now (`record`). Raises EditError."""
    from .models import EmployeePermission

    option = str(data.get("type") or "")
    note = _reason(data)
    base = {"option": option, "type": option, "reason": note}

    if option == OPTION_PERMISSION:
        if emp.employment_type == "production":
            raise EditError("Permission applies to staff only: production attendance has no permissions.")
        kind = EmployeePermission.normalize_type(_choice(data, "permissionType"))
        if kind is None:
            raise EditError("Choose the permission type: Morning Late-In, Evening Early-Out or Middle One-Hour.")
        if refusal := _permission_taken(emp, d, kind):
            raise EditError(refusal)
        label = EmployeePermission.TYPE_LABELS[kind]
        return {
            **base,
            "typeLabel": f"Permission · {label.removesuffix(' Permission')}",
            "permissionType": kind,
            "permissionLabel": label,
            "durationMinutes": EmployeePermission.FIXED_DURATION_MINUTES,
            # the attendance engine decides the day once the permission is approved: the shift count is not fixed here
            "status": record.status,
            "isHalfShift": bool(record.is_half_shift),
            "shiftsEarned": None,
            "note": f"Permission ({label}): {note}",
        }

    if option == OPTION_LATE:
        action = _choice(data, "late", "lateAction").lower()
        if action not in (LATE_MARK, LATE_UNMARK):
            raise EditError("Choose Mark as Late or Unmark Late.")
        if refusal := _late_refusal(record, action):
            raise EditError(refusal)
        label = "Mark as Late" if action == LATE_MARK else "Unmark Late"
        return {
            **base,
            "typeLabel": label,
            "late": action,
            "status": record.status,
            "isHalfShift": bool(record.is_half_shift),
            "isLate": action == LATE_MARK,
            "isEarlyOut": bool(record.early_leave),
            "shiftsEarned": f"{Decimal(str(record.shifts_earned or 0)):.2f}",
            "note": f"{label}: {note}",
        }

    if option == OPTION_CASUAL_LEAVE:
        from .casual_leave_views import check_cl_eligibility

        if emp.employment_type != "staff":
            raise EditError("Casual Leave is available only for staff employees.")
        portion = _choice(data, "portion").lower()
        found = next((c for c in CL_CHOICES if c[0] == portion), None)
        if found is None:
            raise EditError("Choose Full day, First half or Second half.")
        ok, why = check_cl_eligibility(emp, d, portion, exclude_override_ids=_pending_override_ids(emp, d))
        if not ok:
            raise EditError(why)
        value, label, days, _text = found
        full = value == "full"
        return {
            **base,
            "typeLabel": f"Casual Leave · {label}",
            "portion": value,
            "portionLabel": label,
            "days": _num(days),
            "status": "present" if full else record.status,
            "isHalfShift": False if full else bool(record.is_half_shift),
            # a half day: the other half counts by the punches, so the engine decides the shift count
            "shiftsEarned": "1.00" if full else None,
            "note": f"Casual Leave ({label}): {note}",
        }

    if option == OPTION_ON_DUTY:
        destination = str(data.get("destination") or "").strip()[:200] or None
        return {
            **base,
            "typeLabel": "On-Duty",
            "status": "present",
            "isHalfShift": False,
            "isLate": False,
            "isEarlyOut": False,
            "firstPunch": record.first_punch.strftime("%H:%M") if record.first_punch else None,
            "lastPunch": record.last_punch.strftime("%H:%M") if record.last_punch else None,
            "shiftsEarned": "1.00",
            "destination": destination,
            "note": f"On-Duty: {note}",
        }
    raise EditError("Choose an attendance type.")


# ── Applying an approved option ──────────────────────────────────────────────────────────────────────────────────────


def fresh_day(emp: Employee, d: date) -> AttendanceDayRecord:
    """The day's record as the engine sees it now: a day HR fixed by hand (manual) as it is, any other day recomputed with
    every approved leave, Casual Leave and permission (exactly what the attendance pages do)."""
    from .attendance_final import compute_day_record, compute_range_records

    record = AttendanceDayRecord.objects.filter(employee=emp, date=d).first()
    if record is not None and record.source == "manual":
        return record
    computed = compute_range_records(emp, d, d)
    return computed[0] if computed else (record or compute_day_record(emp, d))


def _final_role(req: AttendanceOverrideRequest) -> str:
    from . import approval_workflow as approval

    for e in reversed(req.approval_trail or []):
        if e.get("decision") == "approved" and e.get("role") in approval.ROLES:
            return e["role"]
    return approval.HR


def _trail_copy(req: AttendanceOverrideRequest) -> list[dict]:
    """The attendance change's approvals, carried onto the permission / Casual Leave it creates (so that request shows who
    approved it, and where it came from)."""
    return [{**e, "via": "attendance_correction", "attendanceEditId": req.id} for e in (req.approval_trail or [])]


def _apply_permission(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    from . import approval_workflow as approval
    from .models import EmployeePermission

    values = req.requested_values
    kind = values["permissionType"]
    role = approval.LEGACY_ROLE[_final_role(req)]
    same = EmployeePermission.objects.filter(
        employee=req.employee, date=req.date, type__in=EmployeePermission.type_values(kind)
    )
    perm = same.filter(status="approved").order_by("id").first()
    if perm is None:
        perm = same.filter(status="pending").order_by("id").first()
        if perm is not None:
            # the employee asked for the same permission while this change waited: the Department Head's and HR's approval
            # here decides that request (never two permissions of one kind on a day)
            perm.type = kind
            perm.status = "approved"
            perm.approved_by = reviewer
            perm.approver_role = role
            perm.approval_trail = approval.trail_of("permission", perm) + _trail_copy(req)
            perm.save()
        else:
            perm = EmployeePermission.objects.create(
                employee=req.employee,
                date=req.date,
                type=kind,
                status="approved",
                duration_minutes=EmployeePermission.FIXED_DURATION_MINUTES,
                reason=f"HR attendance edit: {values.get('reason') or ''}".strip(),
                approved_by=reviewer,
                approver_role=role,
                approval_trail=_trail_copy(req),
            )
    values["permissionId"] = perm.id
    return fresh_day(req.employee, req.date)


def _apply_late(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    from .attendance_final import _reason_without

    values = req.requested_values
    record = fresh_day(req.employee, req.date)
    mark = values.get("late") == LATE_MARK
    record.is_late = mark
    if mark:
        record.late_reason = "; ".join(
            part for part in (f"Marked Late by HR: {values.get('reason') or ''}".strip(), record.late_reason) if part
        )
    else:
        record.late_reason = _reason_without(
            _reason_without(record.late_reason, "Morning Late-In"), "Marked Late by HR"
        )
    record.source = "manual"
    record.override_by = reviewer
    record.override_note = values.get("note")
    record.save()
    return record


def _apply_on_duty(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    values = req.requested_values
    record = fresh_day(req.employee, req.date)
    record.status = AttendanceDayRecord.STATUS_PRESENT
    record.shifts_earned = Decimal("1.00")
    record.is_half_shift = False
    record.is_half_day_leave = False
    record.is_late = False
    record.early_leave = False
    record.late_reason = None
    record.arrival_zone = ""
    record.compensation_kind = ""
    record.compensation_minutes = 0
    record.compensation_note = ""
    record.primary_source = "On-Duty"
    record.source = "manual"
    record.override_by = reviewer
    record.override_note = values.get("note")
    record.save()
    return record


def _apply_casual_leave(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    from . import approval_workflow as approval
    from .casual_leave_views import _write_attendance_for_cl
    from .models import CasualLeaveRequest

    values = req.requested_values
    portion = values.get("portion") or CasualLeaveRequest.PORTION_FULL
    cl = CasualLeaveRequest.objects.filter(
        employee=req.employee, date=req.date, portion=portion, status=CasualLeaveRequest.STATUS_APPROVED
    ).first()
    if cl is None:
        cl = CasualLeaveRequest.objects.create(
            employee=req.employee,
            date=req.date,
            portion=portion,
            reason=f"HR attendance edit: {values.get('reason') or ''}".strip(),
            status=CasualLeaveRequest.STATUS_APPROVED,
            approval_trail=_trail_copy(req),
            reviewed_by=reviewer,
            reviewer_role=approval.LEGACY_ROLE[_final_role(req)],
            reviewed_at=timezone.now(),
        )
    values["casualLeaveId"] = cl.id
    _write_attendance_for_cl(cl, reviewer)
    return fresh_day(req.employee, req.date)


APPLIERS = {
    OPTION_PERMISSION: _apply_permission,
    OPTION_LATE: _apply_late,
    OPTION_CASUAL_LEAVE: _apply_casual_leave,
    OPTION_ON_DUTY: _apply_on_duty,
}
