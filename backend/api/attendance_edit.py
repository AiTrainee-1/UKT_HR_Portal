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

Owner brief 2026-11-24 ("every attendance feature; each approved edit updates its own module's records; HOD then HR for
every edit; payroll calculation untouched, payroll reads it only when it is generated again"):

  compensation, sunday_compensation, ot_compensation   now USE THE COMPENSATION BALANCE (staff only, the OT / Compensation
                master switch on, a working day): the shift chosen is added to what the day already counts, up to a full
                day, exactly like a "use balance" request on the Compensation page. Applied as an APPROVED use_balance
                HolidayWorkClaim + its ledger debit (compensation_claims.credit_or_debit, once) and the day topped up
                (compensation_apply.apply_relaxation). Only amounts the balance and the day can take are offered.
                A proposal made before this (no "useBalance") is still applied the old way (a marked manual day).
  on_duty       also writes a completed OnDutySession for the day (status completed, ended, back-dated, no outpass, no
                geo track), so the On-Duty lists and reports show it; payroll_calendar counts it as a worked On-Duty day.
  leave         choice = the reason (sick | emergency | personal | other, the apps' leave form), `portion` full |
                first_half | second_half. Applied as an APPROVED LeaveRequest (leave_request_views._deduct_leave_balance:
                a reason category uses no balance) and the day worked out again: a full day with no punches becomes On
                Leave (unpaid, as payroll treats every leave), a half day marks the half-day leave on a half day. Replaces
                the old "On Leave" type in the dialog (that type wrote a day with no leave record).
  missing_punch choice = the slot (morning_in | lunch_out | lunch_in | evening_out), `punchTime` HH:MM. Applied as an
                APPROVED MissingPunchRequest + the punch (source "missing_punch:approved"), the day judged again from its
                punches (a day HR had fixed by hand is released first).
  early_out     choice mark | unmark: like Late, for the Early-Out mark.
  penalty_waiver no choice: the day's Penalty Early-Out deduction is added back to its shifts.
  ot_pay        `shifts` 0.25 | 0.50 | 0.75 | 1.00: the day's detected Type 2 overtime is set to Pay with that amount
                (what Compensation > OT "Pay" does); the month's payroll pays it when it is generated.

A day whose payroll is finalized (Payroll Done: the staff month, or the production pay period of a payslip covering it)
cannot be edited: the proposal, every approval and the dialog's options say so (lock_refusal). The final approval checks
the module's rules again (approval_refusal) and applies the change exactly once, under a row lock (finalize).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal

from django.db import transaction
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
    # 2026-11-24: the three compensation types use the compensation balance (see the module docstring); `worked` is off
    # because the day is topped up from the balance, not typed in (no punch times, no Late / Early-Out marks to set)
    EditType(
        "compensation",
        "Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "Uses the compensation balance: the shift chosen is added to what the day already counts, up to a full day.",
        worked=False,
        shift_choices=SHIFT_CHOICES,
        marker=COMPENSATION_KIND,
    ),
    EditType(
        "sunday_compensation",
        "Sunday Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "Uses the balance earned by Sunday / holiday work: the shift chosen is added to the day, up to a full day.",
        worked=False,
        shift_choices=SHIFT_CHOICES,
        marker=COMPENSATION_KIND,
    ),
    EditType(
        "ot_compensation",
        "OT Compensation",
        "Compensation",
        "present",
        Decimal("1.00"),
        "Uses the balance earned by overtime: the shift chosen is added to the day, up to a full day.",
        worked=False,
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


def resolve(data: dict, emp: Employee | None = None, d: date | None = None, exclude_edit_ids=()) -> dict:
    """The `requested_values` of a proposal from what the Attendance Edit page sent (type, shifts, firstPunch, lastPunch,
    isLate, isEarlyOut, note). Validates everything; raises EditError. A compensation type (2026-11-24) is checked against
    the employee's compensation balance and the day (`emp`, `d`): it uses the balance."""
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

    if t.marker and emp is not None and d is not None:
        return _resolve_compensation(t, shifts, note, emp, d, exclude_edit_ids)

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


def _shift_day_logs(emp: Employee, d, own: list) -> list:
    """The punches the day is judged on, oldest first (the SHIFT day, owner 2026-11-18: "all overtime hours and timings
    on the same day's attendance record"): a production day the shift-table rules judge comes from their night-session
    resolver, a staff day from the cross-midnight reattribution (shift_engine.resolve_day_punch_logs). Either way a
    closing punch made the next morning is in the list (it keeps its own date) and the previous night's closing punch
    is not. A day neither touches (a manual production day, a day before the rules) is its own date's punches."""
    if emp.employment_type == "production":
        from .attendance_views import _production_shift_days

        _rules, days = _production_shift_days(emp, d, d)
        if d in days:
            return [log for _secs, log in days[d]]
        return own
    from .shift_engine import resolve_day_punch_logs
    from .user_settings import settings_for_employee

    resolved = resolve_day_punch_logs(emp, d, own, settings_for_employee(emp))
    return sorted(resolved, key=lambda log: (log.date, log.punch_time, log.id))


def day_punches(emp: Employee, d) -> list[dict]:
    """Every punch of this SHIFT day, in the order they happened, each with where it came from (the source tag, a plain
    label, and the biometric device when it came from one) - the punches the day's shifts are counted from, so a night's
    overtime is shown on the day it began (owner 2026-11-18):
      * a closing punch made the next morning is listed last, with its own `date` and `nextDay: true`;
      * a punch of this date that belongs to somewhere else is still listed, `counted: false`, with `note`
        "previous_shift" (it closed the night before: e.g. 02:30 after the 23 Oct overtime, listed on 24 Oct) or
        "double_tap" (a second press within 5 minutes, which the production rules ignore).
    `type` is IN / OUT by position among the counted punches, as Attendance Search and the Report Log label them."""
    from .geo_attendance_views import source_label

    names = dict(BiometricDevice.objects.exclude(serial_number="").values_list("serial_number", "name"))
    own = list(AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time", "id"))
    counted = _shift_day_logs(emp, d, own)

    def entry(log, ptype: str) -> dict:
        item = {
            "id": log.pk,
            "date": log.date.isoformat(),
            "time": log.punch_time.strftime("%H:%M:%S"),
            "type": ptype,
            "source": log.source or "",
            "sourceLabel": "Punch View" if log.source == "manual:punch-view" else source_label(log.source or ""),
            "device": _device_of(log.source or "", names),
            "recordedAt": log.created_at.isoformat() if log.created_at else None,
            "counted": True,
        }
        if log.date > d:
            item["nextDay"] = True
        return item

    if [log.pk for log in counted] == [log.pk for log in own]:
        return [entry(log, log.punch_type) for log in own]  # nothing moved: the date's punches as they were saved
    out = [entry(log, "IN" if i % 2 == 0 else "OUT") for i, log in enumerate(counted)]
    counted_ids = {log.pk for log in counted}
    extras = [log for log in own if log.pk not in counted_ids]
    if extras:
        counted_times = {log.punch_time for log in counted if log.date == d}
        first = own[0].punch_time
        for log in extras:
            item = entry(log, log.punch_type)
            item["counted"] = False
            # production: the date's FIRST punch, when it is not counted, closed the night before; any other was a double
            # tap. Staff: every early punch the reattribution took belongs to the day before.
            closed_previous = emp.employment_type != "production" or (
                log.punch_time == first and first not in counted_times
            )
            item["note"] = "previous_shift" if closed_previous else "double_tap"
            if closed_previous:
                item["type"] = "OUT"  # it ended the night before, whatever the device called it
            out.append(item)
    out.sort(key=lambda p: (p["date"], p["time"]))
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
    (see the module docstring and APPLIERS).

    Exactly once (2026-11-24): the request row is locked while the change is applied and stamped `appliedAt`; a second
    final approval racing the first finds the stamp and applies nothing again. The appliers' own records (the claim, the
    leave, the punch request ...) are written in the same transaction, so a failure leaves nothing half done."""
    from .attendance_final import compute_day_record
    from .growth_views import apply_override_values

    with transaction.atomic():
        locked = AttendanceOverrideRequest.objects.select_for_update().get(pk=req.pk)
        if (locked.requested_values or {}).get("appliedAt"):
            req.requested_values = locked.requested_values
            return AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first() or fresh_day(
                req.employee, req.date
            )
        record = AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first()
        if record is None:
            record = compute_day_record(req.employee, req.date)
        before = _history_state(record)
        if not isinstance(req.requested_values, dict):
            req.requested_values = dict(req.requested_values or {})
        applier = APPLIERS.get(req.requested_values.get("option"))
        if applier is not None:
            record = applier(req, reviewer) or fresh_day(req.employee, req.date)
        else:
            apply_override_values(record, req.requested_values, reviewer)
        req.requested_values["appliedAt"] = timezone.now().isoformat()
        AttendanceOverrideRequest.objects.filter(pk=req.pk).update(requested_values=req.requested_values)
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
# added 2026-11-24 (owner: every attendance feature of the HRMS in the dialog)
OPTION_LEAVE, OPTION_MISSING_PUNCH, OPTION_EARLY_OUT = "leave", "missing_punch", "early_out"
OPTION_PENALTY_WAIVER, OPTION_OT_PAY = "penalty_waiver", "ot_pay"
NEW_OPTIONS = (
    OPTION_PERMISSION,
    OPTION_LATE,
    OPTION_CASUAL_LEAVE,
    OPTION_ON_DUTY,
    OPTION_LEAVE,
    OPTION_MISSING_PUNCH,
    OPTION_EARLY_OUT,
    OPTION_PENALTY_WAIVER,
    OPTION_OT_PAY,
)
GROUP_OF_TYPE_GROUP = {"Attendance": GROUP_WORKED, "Compensation": GROUP_COMPENSATION, "Other": GROUP_NOT_WORKED}
# The types the dialog no longer offers (still accepted from an older client): "On Leave" wrote a day with no leave record;
# the Leave option records the leave itself (2026-11-24).
HIDDEN_TYPES = frozenset({"on_leave"})
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
        "Use the employee's compensation balance: the shift chosen is added to the day and taken from the balance.",
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
        OPTION_EARLY_OUT,
        "Early-Out",
        "Mark the day Early-Out, or take its Early-Out mark away: it then counts, or stops counting, toward the late "
        "deductions.",
    ),
    (
        OPTION_CASUAL_LEAVE,
        "Casual Leave",
        "Give the day as paid Casual Leave: it uses the employee's yearly Casual Leave balance (12 days a year).",
    ),
    (
        OPTION_LEAVE,
        "Leave",
        "Record the day as an approved leave, with its reason. A leave day is not paid (Casual Leave is the paid option).",
    ),
    (
        OPTION_ON_DUTY,
        "On-Duty",
        "The employee worked away from the branch: the day counts as Present (1.00 shift) and an On-Duty record is added.",
    ),
    (
        OPTION_MISSING_PUNCH,
        "Missing Punch",
        "Add the punch the device missed: it is recorded as an approved missing-punch request and the day is worked out "
        "again from its punches.",
    ),
    (
        OPTION_PENALTY_WAIVER,
        "Penalty Waiver",
        "Take back the day's Penalty Early-Out deduction: the shift it took off is added back.",
    ),
    (
        OPTION_OT_PAY,
        "OT Pay",
        "Pay the day's overtime: its overtime record is set to Pay with the shifts chosen, and the month's payroll pays it "
        "when it is generated.",
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
EARLY_CHOICES = (
    (LATE_MARK, "Mark as Early-Out", "The day counts as one Early-Out in the late deductions."),
    (LATE_UNMARK, "Unmark Early-Out", "The Early-Out mark is taken away: the day no longer counts toward the late deductions."),
)  # fmt: skip
# the apps' leave form (owner 2026-10-31): the reason category, descriptive only (it uses no leave balance)
LEAVE_REASONS = (
    ("sick", "Sick Leave", "A leave for illness."),
    ("emergency", "Emergency", "A leave for an emergency."),
    ("personal", "Personal", "A leave for personal reasons."),
    ("other", "Other Reasons", "A leave for any other reason."),
)
LEAVE_PORTIONS = (
    ("full", "Full day", Decimal("1"), None, "The whole day is leave."),
    ("first_half", "First half", Decimal("0.5"), "morning", "The first half is leave; the other half counts by the punches."),
    ("second_half", "Second half", Decimal("0.5"), "afternoon", "The second half is leave; the other half counts by the punches."),
)  # fmt: skip
MISSING_PUNCH_SLOTS = (
    ("morning_in", "Morning Check-In", "The first punch of the day (IN)."),
    ("lunch_out", "Lunch Check-Out", "Going out for lunch (OUT)."),
    ("lunch_in", "Lunch Check-In", "Back from lunch (IN)."),
    ("evening_out", "Evening Check-Out", "The last punch of the day (OUT)."),
)
HR_EDIT_DESTINATION = "On-Duty (HR attendance edit)"


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
               compensation=False, staff_only=False, reason=None, description=None, extra=None) -> dict:  # fmt: skip
    if reason is None and choices and not any(c["available"] for c in choices):
        reason = next((c["unavailableReason"] for c in choices if c["unavailableReason"]), None)
    return {
        **(extra or {}),
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


# ── 2026-11-24: the Payroll Done lock, and the options added for every attendance feature ─────────────────────────────


def lock_refusal(emp: Employee, d: date) -> str | None:
    """Why the attendance of `d` can no longer change for `emp`, or None: its payroll is finalized (Payroll Done) - the
    staff month (payroll_month_workflow), or for a production worker the pay period of a payslip covering the day
    (production_period_workflow). Checked on the proposal, on every approval and in the dialog's options."""
    if emp.employment_type == "production":
        from .models import Payroll
        from .production_period_workflow import row_locked, row_locked_message

        for payroll in Payroll.objects.filter(employee=emp, period_start__lte=d, period_end__gte=d):
            if row_locked(payroll):
                return f"{row_locked_message(payroll)} The attendance of {_day_text(d)} can no longer change."
        return None
    from .payroll_month_workflow import is_locked, month_label

    if is_locked(d.month, d.year):
        return (
            f"{month_label(d.month, d.year)} payroll is finalized (Payroll Done), so the attendance of {_day_text(d)} "
            "can no longer change."
        )
    return None


def _pending_edit_use(emp: Employee, exclude_ids=()) -> Decimal:
    """Shifts of the compensation balance that waiting attendance edits would use (they hold it, like a waiting use
    request on the Compensation page)."""
    total = Decimal("0")
    for values in (
        AttendanceOverrideRequest.objects.filter(employee=emp, status=AttendanceOverrideRequest.STATUS_PENDING)
        .exclude(pk__in=list(exclude_ids))
        .values_list("requested_values", flat=True)
    ):
        values = values or {}
        if values.get("useBalance") and values.get("useShifts"):
            total += Decimal(str(values["useShifts"]))
    return total


def compensation_state(emp: Employee, d: date, exclude_edit_ids=()) -> dict:
    """What using the compensation balance on `d` would look like: {reason (None when it can be used), current (the
    shifts the day counts now), room (what it can still take), available (the balance less what is asked for), allowed
    (the SHIFT_CHOICES that fit both)}. The Compensation page's rules: staff, the master switch on, a working day, no
    other day-off request for the date, at most a full day."""
    from .compensation_apply import _off_day_reason, day_shifts_now
    from .compensation_claims import balance_figures
    from .compensation_shared import master_enabled
    from .models import HolidayWorkClaim

    zero = Decimal("0")
    out = {"reason": None, "current": zero, "room": zero, "available": zero, "allowed": []}
    if emp.employment_type != "staff":
        out["reason"] = (
            "Compensation applies to staff employees only: production attendance has no compensation balance."
        )
        return out
    if not master_enabled():
        out["reason"] = (
            "The OT / Compensation features are switched off in Settings > Payroll, so the compensation balance cannot "
            "be used right now."
        )
        return out
    off = _off_day_reason(emp, d)
    if off:
        out["reason"] = f"{_day_text(d)} is {off}, which is already a day off: the balance is used on a working day."
        return out
    open_claim = HolidayWorkClaim.objects.filter(
        employee=emp, kind=HolidayWorkClaim.KIND_USE_BALANCE, work_date=d, status__in=HolidayWorkClaim.OPEN_STATUSES
    ).first()
    if open_claim is not None:
        state = "is waiting for the Department Head" if open_claim.status == "pending" else "was approved"
        out["reason"] = (
            f"A day off from the balance for {_day_text(d)} {state} on the Compensation page: decide or change that "
            "request instead."
        )
        return out
    current = Decimal(str(day_shifts_now(emp, d) or 0))
    out["current"] = current
    if current >= Decimal("1"):
        out["reason"] = f"{_day_text(d)} already counts a full day ({current:.2f} shift): there is nothing to add."
        return out
    figures = balance_figures([emp.id]).get(emp.id) or {"available": zero}
    available = Decimal(str(figures.get("available") or 0)) - _pending_edit_use(emp, exclude_edit_ids)
    room = Decimal("1") - current
    out.update(room=room, available=max(available, zero))
    out["allowed"] = [c for c in SHIFT_CHOICES if c <= room and c <= available]
    if available <= 0:
        out["reason"] = "The compensation balance available is 0.00 shift: there is nothing to use."
    elif not out["allowed"]:
        out["reason"] = (
            f"The balance available is {max(available, zero):.2f} shift and the day can take {room:.2f} more, so no "
            "amount (0.25, 0.50, 0.75, 1.00) fits."
        )
    return out


def _compensation_item(t: EditType, emp, d) -> dict:
    item = _type_item(t)
    if emp is None or d is None:
        return item
    state = compensation_state(emp, d)
    item["shiftChoices"] = [f"{c:.2f}" for c in state["allowed"]]
    item["dayShifts"] = f"{state['current']:.2f}"
    item["balanceAvailable"] = float(state["available"].quantize(Decimal("0.01")))
    item["staffOnly"] = True
    if state["reason"]:
        item["available"], item["unavailableReason"] = False, state["reason"]
    return item


def _resolve_compensation(t: EditType, shifts: Decimal, note: str, emp: Employee, d: date, exclude_edit_ids) -> dict:
    from .compensation_engine import status_for_total

    state = compensation_state(emp, d, exclude_edit_ids)
    if state["reason"]:
        raise EditError(state["reason"])
    if shifts not in state["allowed"]:
        most = max(state["allowed"])
        raise EditError(
            f"At most {most:.2f} shift can be used on {_day_text(d)} (the day counts {state['current']:.2f}, the balance "
            f"available is {state['available']:.2f})."
        )
    total = state["current"] + shifts
    status, half = status_for_total(total)
    return {
        "type": t.key,
        "option": GROUP_COMPENSATION,
        "typeLabel": t.label,
        "status": status,
        "isHalfShift": half,
        "isLate": False,
        "isEarlyOut": False,
        "firstPunch": None,
        "lastPunch": None,
        "shiftsEarned": f"{total:.2f}",
        "note": f"{t.label}: {note}",
        "reason": note,
        "compensationKind": t.marker,
        "compensationNote": f"{t.label} ({shifts:.2f} shift from the compensation balance) approved by the Department Head and HR",
        "useBalance": True,
        "useShifts": f"{shifts:.2f}",
        "dayShiftsBefore": f"{state['current']:.2f}",
    }  # fmt: skip


def _early_refusal(record: AttendanceDayRecord, action: str) -> str | None:
    d = _day_text(record.date)
    if action == LATE_MARK:
        if record.status not in WORKED_STATUSES:
            status = STATUS_LABEL.get(record.status, record.status)
            return f"{d} is not a worked day ({status}), so it cannot be marked Early-Out."
        if record.early_leave:
            return f"{d} is already marked Early-Out."
        return None
    if not record.early_leave:
        return f"{d} is not marked Early-Out, so there is no Early-Out mark to take away."
    return None


def _early_out_item(emp, d, record) -> dict:
    choices = [
        _choice_json(value, label, text, reason=_early_refusal(record, value) if record is not None else None)
        for value, label, text in EARLY_CHOICES
    ]
    return _item_json(OPTION_EARLY_OUT, "Early-Out", OPTION_EARLY_OUT, choices=choices, worked=True)


def _open_leave(emp: Employee, d: date, exclude_ids=()):
    """A waiting or approved leave request covering `d` (its dates are text: an ISO compare), or None."""
    from .models import LeaveRequest

    day = d.isoformat()
    return (
        LeaveRequest.objects.filter(
            employee=emp, status__in=("pending", "approved"), start_date__lte=day, end_date__gte=day
        )
        .exclude(pk__in=list(exclude_ids))
        .order_by("id")
        .first()
    )


def _leave_refusal(emp: Employee, d: date, exclude_ids=()) -> str | None:
    from .compensation_apply import _off_day_reason

    off = _off_day_reason(emp, d) if emp.employment_type == "staff" else ("a Sunday" if d.weekday() == 6 else None)
    if off:
        return f"{_day_text(d)} is {off}, which is already a day off: no leave is needed."
    held = _open_leave(emp, d, exclude_ids)
    if held is not None:
        if held.status == "approved":
            return f"{_day_text(d)} already has an approved leave."
        return f"{_day_text(d)} already has a leave request waiting for approval: decide that request instead."
    return None


def _portion_refusal(emp: Employee, d: date, record, portion: str) -> str | None:
    """A full-day leave needs a day with no punches (a day with punches counts as worked); a half-day leave marks a day
    the attendance counts as a half day (attendance_final: that is the only day it changes)."""
    if record is None:
        return None
    if portion == "full":
        if AttendanceLog.objects.filter(employee=emp, date=d).exists():
            return (
                f"{_day_text(d)} has punches, so the attendance counts it as worked and a full-day leave would not apply. "
                "Choose Absent, or correct the punches first."
            )
        return None
    if record.status != AttendanceDayRecord.STATUS_HALF:
        status = STATUS_LABEL.get(record.status, record.status)
        return f"A half-day leave goes on a day the attendance counts as a half day; {_day_text(d)} is {status}."
    return None


def _leave_item(emp, d, record) -> dict:
    reason = _leave_refusal(emp, d) if emp is not None and d is not None else None
    choices = [_choice_json(value, label, text, reason=reason) for value, label, text in LEAVE_REASONS]
    portions = [
        _choice_json(
            value,
            label,
            text,
            shifts=f"{days:.2f}",
            days=_num(days),
            reason=reason or (_portion_refusal(emp, d, record, value) if emp is not None and d is not None else None),
        )
        for value, label, days, _slot, text in LEAVE_PORTIONS
    ]
    if reason is None and not any(p["available"] for p in portions):
        reason = next((p["unavailableReason"] for p in portions if p["unavailableReason"]), None)
    return _item_json(
        OPTION_LEAVE,
        "Leave",
        OPTION_LEAVE,
        status="on_leave",
        choices=choices,
        reason=reason,
        extra={"portions": portions},
    )


def _missing_punch_waiting(emp: Employee, d: date, slot: str) -> bool:
    from .models import MissingPunchRequest

    return MissingPunchRequest.objects.filter(
        employee=emp,
        date=d,
        punch_slot=slot,
        status__in=(MissingPunchRequest.STATUS_PENDING_HOD, MissingPunchRequest.STATUS_PENDING_HR),
    ).exists()


def _missing_punch_item(emp, d, record) -> dict:
    choices = []
    for value, label, text in MISSING_PUNCH_SLOTS:
        reason = None
        if emp is not None and d is not None and _missing_punch_waiting(emp, d, value):
            reason = f"A {label} request for {_day_text(d)} is waiting for approval: decide that request instead."
        choices.append(_choice_json(value, label, text, reason=reason))
    return _item_json(
        OPTION_MISSING_PUNCH,
        "Missing Punch",
        OPTION_MISSING_PUNCH,
        choices=choices,
        worked=True,
        extra={"needsTime": True},
    )


def _penalty_item(emp, d, record) -> dict:
    deduction = Decimal(str(getattr(record, "penalty_deduction", 0) or 0)) if record is not None else Decimal("0")
    reason = None
    description = None
    if record is not None:
        if not record.penalty_early_out or deduction <= 0:
            reason = f"{_day_text(d)} has no Penalty Early-Out deduction to waive."
        else:
            description = (
                f"Take back the Penalty Early-Out deduction of {_day_text(d)}: {deduction:.2f} shift is added back to the "
                "day."
            )
    return _item_json(
        OPTION_PENALTY_WAIVER,
        "Penalty Waiver",
        OPTION_PENALTY_WAIVER,
        status=record.status if record is not None else None,
        shifts=f"{deduction:.2f}",
        reason=reason,
        description=description,
        extra={"penaltyMinutes": int(getattr(record, "early_out_minutes", 0) or 0) if record is not None else 0},
    )


def ot_state(emp: Employee, d: date):
    """(the day's Type 2 overtime record, why it cannot be paid or None) by the rules of Compensation > OT "Pay"
    (compensation_views._assign_one): staff, the switches on, a detected shift-based record HR has not decided, no claim
    of the employee's on it, at least a quarter."""
    from .compensation_claims import ot_credit, open_claim_for_record
    from .compensation_shared import master_enabled
    from .models import CompensationConfig, OvertimeRecord

    if emp.employment_type != "staff":
        return None, "OT pay applies to staff employees only."
    if not master_enabled():
        return (
            None,
            "The OT / Compensation features are switched off in Settings > Payroll, so overtime cannot be paid.",
        )
    config = CompensationConfig.get()
    if not config.shift_enabled:
        return None, "Shift-based overtime (Type 2) is switched off in Settings > Compensation."
    if not config.pay_enabled:
        return None, "Paying overtime is switched off in Settings > Compensation."
    rec = OvertimeRecord.objects.filter(employee=emp, date=d).first()
    if rec is None:
        return None, f"No overtime was detected on {_day_text(d)}, so there is nothing to pay."
    if rec.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE:
        return (
            rec,
            f"The overtime of {_day_text(d)} is a next-day late-in allowance (automatic): there is nothing to pay.",
        )
    if rec.ot_type != OvertimeRecord.OT_TYPE_SHIFT:
        return rec, f"The overtime of {_day_text(d)} is an older record: decide it on the Compensation page."
    if rec.status != OvertimeRecord.STATUS_DETECTED:
        label = dict(OvertimeRecord.STATUS_CHOICES).get(rec.status, rec.status).lower()
        return rec, f"The overtime of {_day_text(d)} is already {label}."
    claim = open_claim_for_record(rec.pk)
    if claim is not None:
        state = "is waiting for the Department Head" if claim.status == "pending" else "was approved"
        return rec, (
            f"The employee's claim for the overtime of {_day_text(d)} {state}, so it cannot also be paid: one overtime "
            "day is either paid or credited, never both."
        )
    if ot_credit(rec) <= 0:
        return rec, f"The overtime of {_day_text(d)} is below a quarter of the shift, so there is nothing to pay."
    return rec, None


def _ot_pay_item(emp, d, record) -> dict:
    rec, reason = (None, None)
    if emp is not None and d is not None:
        rec, reason = ot_state(emp, d)
    default = None
    if rec is not None and reason is None:
        from .compensation_claims import ot_credit

        credit = ot_credit(rec)
        default = f"{min(credit, Decimal('1')):.2f}" if credit > 0 else None
    return _item_json(
        OPTION_OT_PAY,
        "OT Pay",
        OPTION_OT_PAY,
        shift_choices=[f"{c:.2f}" for c in SHIFT_CHOICES],
        staff_only=True,
        reason=reason,
        extra={
            "defaultShifts": default,
            "otMinutes": int(rec.ot_minutes or 0) if rec is not None else None,
        },
    )


_OPTION_ITEMS = {
    OPTION_PERMISSION: _permission_item,
    OPTION_LATE: _late_item,
    OPTION_EARLY_OUT: _early_out_item,
    OPTION_CASUAL_LEAVE: _cl_item,
    OPTION_LEAVE: _leave_item,
    OPTION_ON_DUTY: _on_duty_item,
    OPTION_MISSING_PUNCH: _missing_punch_item,
    OPTION_PENALTY_WAIVER: _penalty_item,
    OPTION_OT_PAY: _ot_pay_item,
}


def option_catalogue(emp: Employee | None = None, d: date | None = None, record=None) -> list[dict]:
    """The Attendance Edit dialog's options in groups: [{key, label, description, items: [...]}]. With an employee, a date
    and the day's record, every item and sub-choice says whether it can be chosen for that day (`available`) and if not,
    why (`unavailableReason`); without them everything is available."""
    out = []
    for key, label, description in GROUPS:
        if key == GROUP_COMPENSATION:
            items = [_compensation_item(t, emp, d) for t in TYPES if GROUP_OF_TYPE_GROUP[t.group] == key]
        elif key in (GROUP_WORKED, GROUP_NOT_WORKED):
            items = [_type_item(t) for t in TYPES if GROUP_OF_TYPE_GROUP[t.group] == key and t.key not in HIDDEN_TYPES]
        else:
            items = [_OPTION_ITEMS[key](emp, d, record)]
        out.append({"key": key, "label": label, "description": description, "items": items})
    locked = lock_refusal(emp, d) if emp is not None and d is not None else None
    if locked:
        # Payroll Done: nothing of the day can change (2026-11-24)
        for group in out:
            for item in group["items"]:
                item["available"], item["unavailableReason"] = False, locked
                for choice in [*item.get("choices", ()), *item.get("portions", ())]:
                    choice["available"], choice["unavailableReason"] = False, locked
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

    if option == OPTION_EARLY_OUT:
        action = _choice(data, "earlyOut", "earlyOutAction").lower()
        if action not in (LATE_MARK, LATE_UNMARK):
            raise EditError("Choose Mark as Early-Out or Unmark Early-Out.")
        if refusal := _early_refusal(record, action):
            raise EditError(refusal)
        label = "Mark as Early-Out" if action == LATE_MARK else "Unmark Early-Out"
        return {
            **base,
            "typeLabel": label,
            "earlyOut": action,
            "status": record.status,
            "isHalfShift": bool(record.is_half_shift),
            "isLate": bool(record.is_late),
            "isEarlyOut": action == LATE_MARK,
            "shiftsEarned": f"{Decimal(str(record.shifts_earned or 0)):.2f}",
            "note": f"{label}: {note}",
        }

    if option == OPTION_LEAVE:
        reason_key = _choice(data, "reasonCategory").lower()
        found_reason = next((r for r in LEAVE_REASONS if r[0] == reason_key), None)
        if found_reason is None:
            raise EditError("Choose the reason for the leave: Sick Leave, Emergency, Personal or Other Reasons.")
        portion = str(data.get("portion") or "full").strip().lower()
        found = next((p for p in LEAVE_PORTIONS if p[0] == portion), None)
        if found is None:
            raise EditError("Choose Full day, First half or Second half.")
        if refusal := _leave_refusal(emp, d) or _portion_refusal(emp, d, record, portion):
            raise EditError(refusal)
        value, portion_label, days, slot, _text = found
        full = value == "full"
        label = f"Leave · {found_reason[1]}" + ("" if full else f" · {portion_label}")
        return {
            **base,
            "typeLabel": label,
            "reasonCategory": reason_key,
            "reasonLabel": found_reason[1],
            "portion": value,
            "portionLabel": portion_label,
            "halfDaySlot": slot,
            "days": _num(days),
            "status": "on_leave" if full else record.status,
            "isHalfShift": False if full else bool(record.is_half_shift),
            "shiftsEarned": "0.00" if full else f"{Decimal(str(record.shifts_earned or 0)):.2f}",
            "note": f"{label}: {note}",
        }

    if option == OPTION_MISSING_PUNCH:
        from .models import MissingPunchRequest

        slot = _choice(data, "punchSlot", "slot").lower()
        found = next((s for s in MISSING_PUNCH_SLOTS if s[0] == slot), None)
        if found is None:
            raise EditError("Choose which punch is missing: Morning Check-In, Lunch Check-Out, Lunch Check-In or Evening Check-Out.")  # fmt: skip
        at = _parse_hhmm(data.get("punchTime") or data.get("time"))
        if at is None:
            raise EditError("Give the time of the missing punch, like 09:05.")
        from .clock import FACTORY_TZ, ist_today

        if d == ist_today() and at > timezone.now().astimezone(FACTORY_TZ).time():
            raise EditError("The punch time has not come yet today.")
        punch_type = MissingPunchRequest.PUNCH_SLOT_TO_TYPE[slot]
        if AttendanceLog.objects.filter(employee=emp, date=d, punch_time=at, punch_type=punch_type).exists():
            raise EditError(f"{_day_text(d)} already has an {punch_type} punch at {at.strftime('%H:%M')}.")
        if _missing_punch_waiting(emp, d, slot):
            raise EditError(f"A {found[1]} request for {_day_text(d)} is waiting for approval: decide that request instead.")  # fmt: skip
        label = f"Missing Punch · {found[1]} {at.strftime('%H:%M')}"
        return {
            **base,
            "typeLabel": label,
            "punchSlot": slot,
            "punchSlotLabel": found[1],
            "punchType": punch_type,
            "punchTime": at.strftime("%H:%M"),
            # the engine judges the day again with the punch: the shift count is not fixed here
            "status": record.status,
            "isHalfShift": bool(record.is_half_shift),
            "shiftsEarned": None,
            "note": f"{label}: {note}",
        }

    if option == OPTION_PENALTY_WAIVER:
        from .compensation_engine import status_for_total

        deduction = Decimal(str(record.penalty_deduction or 0))
        if not record.penalty_early_out or deduction <= 0:
            raise EditError(f"{_day_text(d)} has no Penalty Early-Out deduction to waive.")
        total = min(Decimal("1"), Decimal(str(record.shifts_earned or 0)) + deduction)
        status, half = (
            status_for_total(total) if record.status in WORKED_STATUSES else (record.status, record.is_half_shift)
        )
        return {
            **base,
            "typeLabel": "Penalty Waiver",
            "waivedShifts": f"{deduction:.2f}",
            "status": status,
            "isHalfShift": bool(half),
            "shiftsEarned": f"{total:.2f}",
            "note": f"Penalty Early-Out waived ({deduction:.2f} shift added back): {note}",
        }

    if option == OPTION_OT_PAY:
        rec, refusal = ot_state(emp, d)
        if refusal:
            raise EditError(refusal)
        try:
            shifts = Decimal(str(data.get("shifts") or "")).quantize(Decimal("0.01"))
        except Exception:  # noqa: BLE001
            shifts = None
        if shifts not in SHIFT_CHOICES:
            raise EditError("Choose how much overtime to pay: 0.25, 0.50, 0.75 or 1.00 shift.")
        label = f"OT Pay · {shifts:.2f} shift"
        return {
            **base,
            "typeLabel": label,
            "otRecordId": rec.pk,
            "otShifts": f"{shifts:.2f}",
            "otMinutes": int(rec.ot_minutes or 0),
            # the day itself does not change: the overtime is paid by the payroll
            "status": record.status,
            "isHalfShift": bool(record.is_half_shift),
            "shiftsEarned": f"{Decimal(str(record.shifts_earned or 0)):.2f}",
            "note": f"{label}: {note}",
        }
    raise EditError("Choose an attendance type.")


def _parse_hhmm(value) -> time | None:
    text = str(value or "").strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    return None


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


def _trail_stamp(req: AttendanceOverrideRequest, role: str) -> tuple[str | None, datetime | None]:
    """(who, when) of `role`'s approval in the request's trail."""
    for e in req.approval_trail or []:
        if e.get("role") == role and e.get("decision") == "approved":
            at = None
            try:
                at = datetime.fromisoformat(str(e.get("at"))) if e.get("at") else None
            except ValueError:
                at = None
            return e.get("by"), at
    return None, None


def _release_manual_day(emp: Employee, d: date) -> None:
    """A day HR fixed by hand is never recomputed: release it, so the engine judges it again with the record this edit
    just wrote (the punch, the leave). The edit replaces HR's earlier hand-made day - that is what HR asked for."""
    AttendanceDayRecord.objects.filter(employee=emp, date=d, source="manual").update(source="auto")


def _create_on_duty_session(req: AttendanceOverrideRequest, reviewer: str, record: AttendanceDayRecord) -> int:
    """The On-Duty record of the day (owner 2026-11-24: an On-Duty edit updates the On-Duty records). Completed and
    ended, so no live On-Duty logic treats it as running (geo punches, tracks, the live map); no outpass, no geo track;
    created_at moved to the day, so the reports keyed on it show it on the day it is for. Approved by the Department
    Head and HR in the attendance edit (its trail is carried, with via=attendance_correction)."""
    from .clock import FACTORY_TZ
    from .models import OnDutySession

    values = req.requested_values
    d = req.date
    start_t = record.first_punch or time(9, 0)
    end_t = record.last_punch if record.last_punch and record.last_punch > start_t else max(start_t, time(18, 0))
    started = datetime.combine(d, start_t, tzinfo=FACTORY_TZ)
    ended = datetime.combine(d, end_t, tzinfo=FACTORY_TZ)
    hod_by, hod_at = _trail_stamp(req, "hod")
    session = OnDutySession.objects.create(
        employee=req.employee,
        destination=values.get("destination") or HR_EDIT_DESTINATION,
        branch_id=req.employee.branch_id,
        status=OnDutySession.STATUS_COMPLETED,
        hod_reviewed_by=hod_by,
        hod_reviewed_at=hod_at,
        hr_reviewed_by=reviewer,
        hr_reviewed_at=timezone.now(),
        approval_trail=_trail_copy(req),
        started_at=started,
        employee_ended_at=ended,
        completed_at=ended,
        completed_by=reviewer,
        completion_reason=OnDutySession.COMPLETION_MANUAL,
    )
    OnDutySession.objects.filter(pk=session.pk).update(created_at=started)
    return session.pk


def _apply_on_duty(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    from .models import OnDutySession

    values = req.requested_values
    record = fresh_day(req.employee, req.date)
    if not (values.get("onDutySessionId") and OnDutySession.objects.filter(pk=values["onDutySessionId"]).exists()):
        values["onDutySessionId"] = _create_on_duty_session(req, reviewer, record)
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
    if portion != CasualLeaveRequest.PORTION_FULL:
        # a half day is added by the engine, which never recomputes a day HR fixed by hand: release it first
        # (casual_leave_views._refresh_day_for_half_cl would leave such a day alone; gap found 2026-11-23)
        _release_manual_day(req.employee, req.date)
    _write_attendance_for_cl(cl, reviewer)
    return fresh_day(req.employee, req.date)


def _apply_compensation(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord | None:
    """A compensation type: an APPROVED use_balance claim (raised by HR, approved by the Department Head and HR here), its
    ledger debit (once: compensation_claims.credit_or_debit) and the day topped up from it - exactly what approving a
    "use balance" request on the Compensation page does. A proposal made before 2026-11-24 carries no "useBalance" and
    is applied the old way (a marked manual day, the balance untouched)."""
    from .compensation_apply import apply_relaxation
    from .compensation_claims import credit_or_debit
    from .growth_views import apply_override_values
    from .models import HolidayWorkClaim

    values = req.requested_values
    if not values.get("useBalance"):
        record = AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first() or fresh_day(
            req.employee, req.date
        )
        apply_override_values(record, values, reviewer)
        return record
    shifts = Decimal(str(values["useShifts"]))
    # the employee row first: the lock every balance writer takes (compensation_claims.decide, _assign_one)
    Employee.objects.select_for_update().filter(pk=req.employee_id).first()
    claim = HolidayWorkClaim.objects.filter(pk=values.get("claimId")).first() if values.get("claimId") else None
    if claim is None:
        claim = HolidayWorkClaim.objects.create(
            employee=req.employee,
            work_date=req.date,
            shifts=shifts,
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            status=HolidayWorkClaim.STATUS_APPROVED,
            reason=f"HR attendance edit ({values.get('typeLabel') or 'Compensation'}): {values.get('reason') or ''}".strip(),
            requested_by=req.requested_by,
            reviewed_by=reviewer,
            reviewed_at=timezone.now(),
            raised_by_role=HolidayWorkClaim.RAISED_BY_HR,
            approval_trail=_trail_copy(req),
        )
        values["claimId"] = claim.id
    entry = credit_or_debit(claim, reviewer)
    if entry is not None:
        values["ledgerEntryId"] = entry.id
    return apply_relaxation(req.employee, req.date, shifts, f"the compensation balance ({values.get('typeLabel')})")


def _apply_early_out(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    values = req.requested_values
    record = fresh_day(req.employee, req.date)
    record.early_leave = values.get("earlyOut") == LATE_MARK
    record.source = "manual"
    record.override_by = reviewer
    record.override_note = values.get("note")
    record.save()
    return record


def _apply_leave(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    """An APPROVED leave request for the day (the leave module's own record, raised by HR, approved by the Department Head
    and HR here) and the day worked out again with it."""
    from . import approval_workflow as approval
    from .leave_request_views import _deduct_leave_balance
    from .models import LeaveRequest

    values = req.requested_values
    leave = (
        LeaveRequest.objects.filter(pk=values.get("leaveRequestId")).first() if values.get("leaveRequestId") else None
    )
    if leave is None:
        full = values.get("portion", "full") == "full"
        leave = LeaveRequest.objects.create(
            employee=req.employee,
            type="Leave",
            start_date=req.date.isoformat(),
            end_date=req.date.isoformat(),
            total_days=Decimal("1") if full else Decimal("0.5"),
            is_half_day=not full,
            half_day_slot=None if full else values.get("halfDaySlot"),
            reason=f"HR attendance edit: {values.get('reason') or ''}".strip(),
            reason_category=values.get("reasonCategory") or "",
            status="approved",
            approved_by=reviewer,
            approver_role=approval.LEGACY_ROLE[_final_role(req)],
            approval_trail=_trail_copy(req),
        )
        values["leaveRequestId"] = leave.id
        _deduct_leave_balance(leave)  # a reason category uses no balance (the function says so); kept for a leave type
    _release_manual_day(req.employee, req.date)
    return fresh_day(req.employee, req.date)


def _apply_missing_punch(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    """An APPROVED missing-punch request (the module's own record) and its punch, then the day judged again from its
    punches - what the final approval of a missing-punch request does (missing_punch_views.resolve_missing_punch)."""
    from .attendance_refresh import refresh_after_punches
    from .models import MissingPunchRequest

    values = req.requested_values
    at = _parse_hhmm(values.get("punchTime"))
    mp = (
        MissingPunchRequest.objects.filter(pk=values.get("missingPunchId")).first()
        if values.get("missingPunchId")
        else None
    )
    if mp is None:
        hod_by, hod_at = _trail_stamp(req, "hod")
        mp = MissingPunchRequest.objects.create(
            employee=req.employee,
            date=req.date,
            punch_time=at,
            punch_type=values.get("punchType"),
            punch_slot=values.get("punchSlot"),
            reason=f"HR attendance edit: {values.get('reason') or ''}".strip(),
            status=MissingPunchRequest.STATUS_APPROVED,
            hod_reviewed_by=hod_by,
            hod_reviewed_at=hod_at,
            hr_reviewed_by=reviewer,
            hr_reviewed_at=timezone.now(),
            approval_trail=_trail_copy(req),
        )
        values["missingPunchId"] = mp.id
    AttendanceLog.objects.get_or_create(
        employee=req.employee,
        date=req.date,
        punch_time=at,
        punch_type=values.get("punchType"),
        defaults={"source": "missing_punch:approved"},
    )
    _release_manual_day(req.employee, req.date)
    refresh_after_punches([(req.employee_id, req.date)])
    return fresh_day(req.employee, req.date)


def _apply_penalty_waiver(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    from .compensation_engine import status_for_total

    values = req.requested_values
    record = fresh_day(req.employee, req.date)
    deduction = Decimal(str(record.penalty_deduction or 0))
    if record.penalty_early_out and deduction > 0:
        total = min(Decimal("1"), Decimal(str(record.shifts_earned or 0)) + deduction)
        record.shifts_earned = total
        if record.status in WORKED_STATUSES:
            record.status, record.is_half_shift = status_for_total(total)
        record.penalty_early_out = False
        record.penalty_deduction = Decimal("0")
        values["waivedShifts"] = f"{deduction:.2f}"
    record.source = "manual"
    record.override_by = reviewer
    record.override_note = values.get("note")
    record.save()
    return record


def _apply_ot_pay(req: AttendanceOverrideRequest, reviewer: str) -> AttendanceDayRecord:
    """The day's Type 2 overtime set to Pay with the shifts chosen - what Compensation > OT "Pay" does
    (compensation_views._assign_one); the month's payroll pays it when it is generated."""
    from .models import OvertimeRecord

    values = req.requested_values
    rec = OvertimeRecord.objects.select_for_update(of=("self",)).filter(employee=req.employee, date=req.date).first()
    if rec is not None and rec.status == OvertimeRecord.STATUS_DETECTED:
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_PAY
        rec.shifts = Decimal(str(values["otShifts"]))
        rec.claim_date = None
        rec.announced_by = reviewer
        rec.announced_at = timezone.now()
        rec.notes = "; ".join(
            part for part in (rec.notes, f"Paid through HR attendance edit #{req.id} (Department Head and HR)") if part
        )
        rec.save()
        values["otRecordId"] = rec.pk
        try:
            from . import compensation_notices

            compensation_notices.overtime_decided(rec, OvertimeRecord.TYPE_PAY)
        except Exception:  # noqa: BLE001 - a notice never undoes the payment decision
            import logging

            logging.getLogger(__name__).exception("OT pay notice failed for attendance edit %s", req.id)
    return fresh_day(req.employee, req.date)


APPLIERS = {
    OPTION_PERMISSION: _apply_permission,
    OPTION_LATE: _apply_late,
    OPTION_CASUAL_LEAVE: _apply_casual_leave,
    OPTION_ON_DUTY: _apply_on_duty,
    GROUP_COMPENSATION: _apply_compensation,
    OPTION_EARLY_OUT: _apply_early_out,
    OPTION_LEAVE: _apply_leave,
    OPTION_MISSING_PUNCH: _apply_missing_punch,
    OPTION_PENALTY_WAIVER: _apply_penalty_waiver,
    OPTION_OT_PAY: _apply_ot_pay,
}


def approval_refusal(req: AttendanceOverrideRequest, role: str) -> str | None:
    """Why approving `req` as `role` must be refused now, or None. Every approval: the day's payroll is not finalized
    (lock_refusal). The final approval (HR's) also checks the module's rules again on the day as it is now, because the
    day, the balance or the overtime may have changed while the edit waited."""
    from . import approval_workflow as approval

    if refusal := lock_refusal(req.employee, req.date):
        return refusal
    if role != approval.HR:
        return None
    values = req.requested_values or {}
    option = group_of(values)
    emp, d = req.employee, req.date
    if option == GROUP_COMPENSATION and values.get("useBalance"):
        state = compensation_state(emp, d, exclude_edit_ids=[req.pk])
        if state["reason"]:
            return state["reason"]
        shifts = Decimal(str(values.get("useShifts") or 0))
        if shifts not in state["allowed"]:
            return (
                f"{shifts:.2f} shift can no longer be used on {_day_text(d)}: the day counts {state['current']:.2f} now "
                f"and the balance available is {state['available']:.2f}. Reject this edit; a new one can be made."
            )
    elif option == OPTION_LEAVE:
        if refusal := _leave_refusal(
            emp, d, exclude_ids=[values["leaveRequestId"]] if values.get("leaveRequestId") else []
        ):
            return refusal
    elif option == OPTION_OT_PAY:
        _rec, refusal = ot_state(emp, d)
        if refusal:
            return refusal
    elif option == OPTION_PENALTY_WAIVER:
        record = fresh_day(emp, d)
        if not record.penalty_early_out or Decimal(str(record.penalty_deduction or 0)) <= 0:
            return f"{_day_text(d)} no longer has a Penalty Early-Out deduction (the day changed): reject this edit."
    return None
