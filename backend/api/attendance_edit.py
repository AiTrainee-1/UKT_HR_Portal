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
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .models import AttendanceDayRecord, AttendanceOverrideRequest, Employee

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


def resolve(data: dict) -> dict:
    """The `requested_values` of a proposal from what the Attendance Edit page sent (type, shifts, firstPunch, lastPunch,
    isLate, isEarlyOut, note). Validates everything; raises EditError."""
    t = BY_KEY.get(str(data.get("type") or ""))
    if t is None:
        raise EditError("Choose an attendance type.")
    note = str(data.get("note") or "").strip()
    if len(note) < 3:
        raise EditError("Give a reason for the change (a few words): the Department Head and HR read it.")

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


def hod_of(emp: Employee):
    """The employee's one Department Head (a DepartmentManager) who can actually decide their requests, or None: nobody is
    assigned, or the only head is the employee themselves (a head never decides their own request)."""
    from .hod_scope import effective_manager

    m = effective_manager(emp)
    if m is None or m.employee_id == emp.pk:
        return None
    return m


def finalize(req: AttendanceOverrideRequest, reviewer: str, request=None) -> AttendanceDayRecord:
    """Both approvals are in: write the day's record (a manual record, which the engine never recomputes), and put what
    changed in the Punch View History."""
    from .attendance_final import compute_day_record
    from .growth_views import apply_override_values

    record = AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first()
    if record is None:
        record = compute_day_record(req.employee, req.date)
    before = _history_state(record)
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
