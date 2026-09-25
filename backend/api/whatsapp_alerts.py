"""
Automatic WhatsApp attendance alerts and punch reminders (staff employees).

`run_attendance_alerts()` runs every few minutes (see whatsapp_alert_scheduler) and looks at TODAY
only. Each message is exactly-once per employee and day: the row in WhatsAppMessageLog is reserved
under a dedupe key before sending (see whatsapp_service.send_notification), so overlapping runs or a
restart can never double-send.

Alerts, each with its own switch on the WhatsApp Control page (plus one for attendance as a whole):

  absent_alert        No punch at all once the shift's punctuality window has passed -the same
                      "waits an hour, then Absent" rule the attendance engine uses (Settings ->
                      Attendance: maximum first punch allowed, 60 minutes by default), plus any extra
                      minutes HR adds- and the shift hasn't ended.
  late_alert          The first punch of the day came after shift start + grace. Says how late, and
                      whether the day is still a full shift, an automatic permission or a half shift.
  four_punch_alert    A friendly reminder for each of the day's four punches that is still missing:
                      check-in, lunch-out, lunch-in, check-out (two punches in simple mode). Sent once
                      the punch is due plus HR's wait. On-Duty employees get the same reminder worded
                      for their Geo Punch (on_duty_punch_reminder).
  missing_punch_alert End of day: the day finished with fewer punches than expected (4 in strict
                      mode, 2 in simple mode).

Nobody is messaged on Sundays, holidays, a Saturday-off, on approved leave (full or half day), when HR
has already set their day by hand, or on a Compensation Day. While an employee has an On-Duty request
today only the punch reminders apply (they have their own punches to make). A permission covering the
employee excuses the late alert. Employees with no shift, or a shift that runs past midnight, are left
alone -there is no reliable deadline to judge them by.
"""

import logging
from collections import Counter, defaultdict
from datetime import datetime, time as time_type

from django.db.models import Q

from . import whatsapp_service
from .attendance_final import _compensation_day_for, _holiday_dates_for_month
from .clock import FACTORY_TZ, ist_now
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    LeaveRequest,
    OnDutySession,
    PayrollSettings,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .shift_engine import (
    ZONE_HALF_SHIFT,
    ZONE_PERMISSION,
    _classify_zone,
    _get_assignment_for_date,
    _get_shift_for_date,
    _permission_window_minutes,
    _punctuality_window_minutes,
    _t2s,
)
from .whatsapp_format import date_str, duration_str, full_name, time_str

logger = logging.getLogger(__name__)

STRICT_PUNCH_NAMES = ["Morning check-in", "Lunch-out", "Lunch-in", "Evening check-out"]
SIMPLE_PUNCH_NAMES = ["Check-in", "Check-out"]


def _fmt_time(t) -> str:
    return time_str(t)


def _fmt_date(d) -> str:
    return date_str(d)


def due_reminder(*, n: int, times: list[int], shift, now_s: int, wait_s: int, strict: bool, cutoff_s: int | None):
    """The punch this employee should be reminded about right now, or None.

    `n` punches are done (`times` are their seconds-since-midnight). Returns
    (slot, punch name, hint, "k of total"): slot 1..4 in strict mode, 1 and 4 in simple mode. A
    punch is due at its own time in the shift; the reminder goes out `wait_s` later and only while
    the employee still hasn't made it, and never once the moment has clearly passed (the next
    punch's turn, the shift's end, or -for the check-in- the absent cutoff)."""
    start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
    has_lunch = strict and shift.first_half_end is not None
    total = 4 if has_lunch else 2
    lunch_grace_s = (shift.lunch_grace_minutes or 0) * 60
    lunch_s = (shift.lunch_duration_minutes or 0) * 60

    def result(slot, name, hint):
        shown = slot if has_lunch else (1 if slot == 1 else 2)
        return slot, name, hint, f"{shown} of {total}"

    names = STRICT_PUNCH_NAMES if has_lunch else SIMPLE_PUNCH_NAMES

    if n == 0:
        limit = min(cutoff_s if cutoff_s is not None else end_s, end_s)
        if start_s + wait_s <= now_s < limit:
            return result(1, names[0], f"Your shift started at {_fmt_time(shift.start_time)}.")
        return None

    if has_lunch and n == 1:
        due = _t2s(shift.first_half_end) + lunch_grace_s
        if due + wait_s <= now_s < end_s:
            return result(2, names[1], f"It was due around {_fmt_time(shift.first_half_end)}.")
    if has_lunch and n == 2:
        # When they went out (a pending Geo Punch isn't in the punch log yet: use the scheduled time).
        went_out = times[1] if len(times) >= 2 else _t2s(shift.first_half_end) + lunch_grace_s
        back_by = went_out + lunch_s + lunch_grace_s
        # A mid-day out, not an early finish.
        if went_out < end_s - 7200 and back_by + wait_s <= now_s < end_s:
            return result(3, names[2], f"You were due back by {_fmt_time(back_by)}.")

    # Clocked in but never out (or out for lunch and never back): the check-out is the last chance.
    if n % 2 == 1 and end_s + wait_s <= now_s < 86400:
        return result(4, names[-1], f"Your shift ended at {_fmt_time(shift.end_time)}.")
    return None


def _load_today(today):
    """Everything the run needs about today, in a handful of queries rather
    than a few per employee."""
    iso = today.isoformat()
    day_start = datetime.combine(today, time_type(0, 0), tzinfo=FACTORY_TZ)

    assignments = defaultdict(list)
    for a in (
        EmployeeShiftAssignment.objects.filter(effective_from__lte=today)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=today))
        .select_related("shift")
    ):
        assignments[a.employee_id].append(a)

    punches = defaultdict(list)
    for emp_id, t in AttendanceLog.objects.filter(date=today).values_list("employee_id", "punch_time"):
        punches[emp_id].append(t)

    # Approved leave of either kind. start/end are ISO date strings, which sort
    # the same as dates, so the comparison can stay in the database.
    on_leave = set(
        LeaveRequest.objects.filter(status="approved", start_date__lte=iso, end_date__gte=iso).values_list(
            "employee_id", flat=True
        )
    )
    # HR (or an approved casual-leave / override) has already decided the day.
    decided = set(
        AttendanceDayRecord.objects.filter(date=today, source="manual").values_list("employee_id", flat=True)
    ) | set(Attendance.objects.filter(date=iso, present=True).values_list("employee_id", flat=True))
    permitted = set(
        EmployeePermission.objects.filter(date=today, status="approved").values_list("employee_id", flat=True)
    )
    # employee -> where they are on duty today (an On-Duty request awaiting approval or approved).
    on_duty = {}
    for emp_id, destination in (
        OnDutySession.objects.filter(
            status__in=[
                OnDutySession.STATUS_PENDING_HOD,
                OnDutySession.STATUS_PENDING_HR,
                OnDutySession.STATUS_ACTIVE,
            ]
        )
        .filter(Q(status=OnDutySession.STATUS_ACTIVE) | Q(created_at__gte=day_start))
        .order_by("created_at")
        .values_list("employee_id", "destination")
    ):
        on_duty[emp_id] = destination
    already = set(
        WhatsAppMessageLog.objects.filter(dedupe_key__contains=f":{iso}:").values_list("dedupe_key", flat=True)
    )
    return assignments, punches, on_leave, decided, permitted, on_duty, already


def _late_status(delta_s: int, grace_s: int, window_s: int, permission_window_s: int) -> str:
    zone = _classify_zone(delta_s, grace_s, window_s, permission_window_s)
    if zone == ZONE_HALF_SHIFT:
        return "Late - Half Shift"
    if zone == ZONE_PERMISSION:
        return "Late - counted as an automatic Permission"
    return "Late"


def run_attendance_alerts(now: datetime | None = None) -> dict:
    """Evaluate today's attendance and send whichever alerts are due.
    Returns {alert_type: number_sent} (empty when nothing was due)."""
    sent: Counter = Counter()
    switches = WhatsAppSettings.get()
    if not switches.attendance_alerts_enabled:
        return dict(sent)
    if not (
        switches.absent_alert_enabled
        or switches.late_alert_enabled
        or switches.four_punch_alert_enabled
        or switches.missing_punch_alert_enabled
    ):
        return dict(sent)
    if not whatsapp_service.is_configured():
        return dict(sent)

    now = now or ist_now()
    today = now.date()
    if today.weekday() == 6 or today in _holiday_dates_for_month(today.year, today.month):
        return dict(sent)
    now_s = now.hour * 3600 + now.minute * 60 + now.second

    payroll = PayrollSettings.get()
    strict = payroll.attendance_mode != "simple"
    permission_window_s = _permission_window_minutes(payroll) * 60
    assignments, punches, on_leave, decided, permitted, on_duty, already = _load_today(today)
    iso = today.isoformat()

    def send(emp, doc_type, tag, params):
        key = f"{tag}:{iso}:{emp.id}"
        if key in already:
            return
        already.add(key)
        # Inline (not the background worker): this job is already a background thread, and running
        # in order keeps the pause between messages meaningful.
        if whatsapp_service.send_notification(emp, doc_type, params, dedupe_key=key, asynchronous=False) is not None:
            sent[doc_type] += 1
            whatsapp_service.pace()

    for emp in Employee.objects.filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_STAFF):
        emp_assignments = assignments.get(emp.id)
        if not emp_assignments:
            continue
        if emp.id in on_leave or emp.id in decided:
            continue
        assignment = _get_assignment_for_date(emp, today, assignments=emp_assignments)
        shift = _get_shift_for_date(emp, today, assignments=emp_assignments)
        if assignment is None or shift is None:
            continue
        if today.weekday() == 5 and assignment.saturday_off:
            continue
        start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
        if end_s <= start_s:
            continue  # overnight shift: no single-day deadline to judge by
        grace_s = (shift.grace_period_minutes or 0) * 60
        window_s = _punctuality_window_minutes(shift, payroll) * 60
        wait_s = switches.four_punch_wait_minutes * 60
        absent_cutoff_s = start_s + window_s + switches.absent_extra_minutes * 60

        times = sorted({_t2s(t) for t in punches.get(emp.id, [])})
        n = len(times)
        name = full_name(emp)
        date_text = _fmt_date(today)

        # Compensation days are never penalised; looked up only if something is due.
        comp = {}

        def excused():
            if "v" not in comp:
                comp["v"] = bool(_compensation_day_for(emp, today, settings=payroll))
            return comp["v"]

        if emp.id in on_duty:
            # Working On-Duty: their punches are Geo Punches, so only the reminders apply.
            if switches.four_punch_alert_enabled and not excused():
                from .geo_attendance_views import _taken_slots

                taken = len(_taken_slots(emp, today))
                due = due_reminder(
                    n=taken, times=times, shift=shift, now_s=now_s, wait_s=wait_s, strict=strict, cutoff_s=None
                )
                if due:
                    slot, punch_name, hint, position = due
                    send(
                        emp,
                        "on_duty_punch_reminder",
                        f"duty{slot}",
                        {
                            "employee_name": name,
                            "date": date_text,
                            "punch_name": punch_name,
                            "hint": hint,
                            "punch_number": position,
                            "destination": on_duty[emp.id],
                        },
                    )
            continue

        # 1. Absent: nothing recorded within the permitted time after the shift started.
        if switches.absent_alert_enabled and n == 0 and absent_cutoff_s <= now_s < end_s and not excused():
            send(
                emp,
                "absent_alert",
                "absent",
                {
                    "employee_name": name,
                    "date": date_text,
                    "shift_start": _fmt_time(shift.start_time),
                    "cutoff_time": _fmt_time(absent_cutoff_s),
                    "status": "Absent",
                    "shift_end": _fmt_time(shift.end_time),
                    "wait_minutes": str(window_s // 60 + switches.absent_extra_minutes),
                },
            )

        # 2. Late arrival (needs an approved permission to be excused).
        if (
            switches.late_alert_enabled
            and n >= 1
            and start_s + grace_s < times[0] <= end_s
            and emp.id not in permitted
            and not excused()
        ):
            delta_s = times[0] - start_s
            send(
                emp,
                "late_alert",
                "late",
                {
                    "employee_name": name,
                    "date": date_text,
                    "shift_start": _fmt_time(shift.start_time),
                    "first_punch": _fmt_time(times[0]),
                    "late_by": duration_str(delta_s),
                    "status": _late_status(delta_s, grace_s, window_s, permission_window_s),
                    "grace_minutes": str(shift.grace_period_minutes or 0),
                },
            )

        # 3. Punch reminders: whichever of the day's punches is due and still missing.
        if switches.four_punch_alert_enabled and not excused():
            due = due_reminder(
                n=n, times=times, shift=shift, now_s=now_s, wait_s=wait_s, strict=strict, cutoff_s=absent_cutoff_s
            )
            if due:
                slot, punch_name, hint, position = due
                send(
                    emp,
                    "four_punch_alert",
                    f"four{slot}",
                    {
                        "employee_name": name,
                        "date": date_text,
                        "punch_name": punch_name,
                        "hint": hint,
                        "punch_number": position,
                    },
                )

        # 4. End of day: the day is over and punches are still missing.
        if switches.missing_punch_alert_enabled and n >= 1:
            names = STRICT_PUNCH_NAMES if strict and shift.first_half_end is not None else SIMPLE_PUNCH_NAMES
            if n < len(names) and now_s >= end_s + switches.missing_punch_after_minutes * 60 and not excused():
                send(
                    emp,
                    "missing_punch_alert",
                    "missing",
                    {
                        "employee_name": name,
                        "date": date_text,
                        "recorded": f"{n} of {len(names)}",
                        "missing": ", ".join(names[n:]),
                    },
                )

    if sent:
        logger.warning("WhatsApp attendance alerts sent: %s", dict(sent))
    return dict(sent)
