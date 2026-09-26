"""
Automatic WhatsApp attendance alerts and punch reminders (staff employees).

`run_attendance_alerts()` runs every minute (see whatsapp_alert_scheduler) and looks at TODAY
only. Each message is exactly-once per employee and day: the row in WhatsAppMessageLog is reserved
under a dedupe key before sending (see whatsapp_service.send_notification), so overlapping runs or a
restart can never double-send.

Everything is judged against the employee's OWN assigned shift for today (start, end, grace, lunch
timings), never a company-wide time. The four alerts, each with its own switch on the WhatsApp
Control page (plus one for attendance as a whole):

  absent_alert        No punch at all once the shift's punctuality window has passed -the same
                      "waits an hour, then Absent" rule the attendance engine uses (Settings ->
                      Attendance: maximum first punch allowed, 60 minutes by default), plus any extra
                      minutes HR adds- and the shift hasn't ended. A polite "are you absent, or did
                      you forget to punch?".
  late_alert          The first punch of the day came after shift start + THIS shift's grace. Sent as
                      soon as that punch is seen; says the shift start, the grace, the first punch and
                      how many minutes past the allowed time it was.
  four_punch_alert    A friendly reminder a while (HR sets it, 15 minutes by default) BEFORE each of the
                      day's punches is expected: check-in at the shift start, lunch-out, lunch-in and
                      check-out at the shift end (just check-in and check-out for a shift with no lunch
                      break; the attendance mode makes no difference) - and only if that punch
                      is still missing. Carries a short motivational line. On-Duty employees get the same
                      reminder worded for their Geo Punch (on_duty_punch_reminder).
  missing_punch_alert A punch is still missing a set time (HR sets it, 20 minutes by default) AFTER it
                      was expected: "Expected Punch 9:00 AM, Current Status: Punch Not Recorded".
                      One message per missing punch, never repeated.

Nobody is messaged on Sundays, holidays, a Saturday-off, on approved leave (full or half day), when HR
has already set their day by hand, or on a Compensation Day. While an employee has an On-Duty request
today only the punch reminders apply (they have their own punches to make). A permission covering the
employee excuses the late alert. Employees with no shift, or a shift that runs past midnight, are left
alone -there is no reliable deadline to judge them by.

"HR has already handled the day" means an AttendanceDayRecord written by hand (source "manual": an HR
override or an approved casual leave), or an Attendance presence row for someone with NO punches at all
(HR marked them present). A presence row next to real punches is NOT a decision: the punch ingest writes
one for everybody who punches, and treating it as one silenced every alert for anyone who had punched.

`evaluate()` is the whole decision for one employee and can narrate it (`trace`), which is what the
`whatsapp_alert_trace` management command prints to explain why a message was, or wasn't, sent.
"""

import logging
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time as time_type, timedelta

from django.conf import settings as dj_settings
from django.db.models import Q
from django.utils import timezone

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

# Two taps on the biometric within this long are one punch (someone pressing twice), not two.
TAP_GAP_S = 5 * 60
# The last punch of the day may still be missing this long after the shift ends.
CHECK_OUT_ALERT_WINDOW_S = 4 * 3600
DAY_S = 86400

# An alert is about something happening NOW. Once it is this old it is not sent, whatever the reason it was
# not sent sooner (the server was down, a limit held it back, a bug was fixed hours later): a message about the
# morning arriving at lunchtime is spam, and a backlog released all at once is exactly the burst that gets a
# WhatsApp number restricted. Reminders need no such limit: their own window is only minutes long.
ABSENT_FRESH_S = 60 * 60  # after the moment the Absent alert became due
LATE_FRESH_S = 30 * 60  # after the late punch
MISSING_FRESH_S = 60 * 60  # after the Missing Punch alert became due

ALERT_TYPES = ("absent_alert", "late_alert", "four_punch_alert", "on_duty_punch_reminder", "missing_punch_alert")
# If this many alerts failed in the last BREAKER_WINDOW_S the provider is refusing us (a disconnected or restricted
# number, an outage): stop sending until it recovers rather than hammering it. A missing phone number is the
# employee's problem, not the provider's, and doesn't count.
BREAKER_FAILURES = 3
BREAKER_WINDOW_S = 30 * 60

# Short lines for the friendly reminder, chosen per employee, day and punch so the same person
# doesn't see the same one twice in a day but a re-run of the job never changes a message's text.
QUOTES = [
    "Great teams are built by people who show up, stay committed, and give their best every day.",
    "Small, steady efforts from everyone add up to something extraordinary.",
    "Punctuality is the soul of business, and a habit of every strong team.",
    "Alone we can do so little; together we can do so much.",
    "Your consistency is what keeps the whole team moving forward.",
    "Success is the sum of small efforts, repeated day in and day out.",
    "A productive day starts with a good start, and you are already on your way.",
    "Every stitch counts, and so does every person on this team.",
    "Teamwork makes the dream work, and you are a big part of ours.",
    "Do your best today; your team is stronger because you are in it.",
    "Reliable people are the pillars every company is built on.",
    "Good habits build a great workplace. Thank you for yours.",
]

# What each punch's reminder says. {left} becomes the minutes actually remaining ("15 minutes").
REMINDER_TEXT = {
    "in": (
        "your attendance punch is coming up in {left}. Please remember to punch in on time.",
        "Thank you for being one of the pillars of our team. Have a productive day! 💪",
    ),
    "lunch_out": (
        "your lunch break is coming up in {left}. Please remember to punch out when you leave for lunch.",
        "Enjoy your break, you've earned it! 🍽️",
    ),
    "lunch_in": (
        "your lunch break ends in {left}. Please remember to punch back in when you return.",
        "Welcome back! Let's finish the day strong. 💪",
    ),
    "out": (
        "your shift ends in {left}. Please remember to punch out before you leave.",
        "Thank you for your hard work today. See you tomorrow! 🌙",
    ),
}

# The opening of the Missing Punch message for each punch.
MISSING_TEXT = {
    "in": "your attendance punch is still missing.",
    "lunch_out": "your lunch-out punch is still missing.",
    "lunch_in": "your lunch-in punch is still missing.",
    "out": "your check-out punch is still missing.",
}


def _fmt_time(t) -> str:
    return time_str(t)


def _fmt_date(d) -> str:
    return date_str(d)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _greeting(now_s: int) -> str:
    return "Good morning" if now_s < 12 * 3600 else "Good afternoon" if now_s < 17 * 3600 else "Good evening"


def _quote(emp_id: int, d: date, slot_number: int) -> str:
    return QUOTES[(d.toordinal() + emp_id * 7 + slot_number) % len(QUOTES)]


# ── punches and the schedule ─────────────────────────────────────────────────────


def collapse_taps(times: list[int]) -> list[int]:
    """Seconds-since-midnight punch times, sorted, with a second tap on the device within TAP_GAP_S
    of the previous punch dropped. The count of punches decides which one is due next, so a
    double-press must not turn 'checked in' into 'checked in and out for lunch'."""
    kept: list[int] = []
    for t in sorted(times):
        if not kept or t - kept[-1] >= TAP_GAP_S:
            kept.append(t)
    return kept


@dataclass(frozen=True)
class Slot:
    """One punch the employee is expected to make, at the time their shift says."""

    number: int  # 1-based, in the order they are made
    name: str
    expected_s: int  # seconds since midnight
    position: str  # "2 of 4"
    role: str  # in | lunch_out | lunch_in | out
    # Whether a missing punch is worth a Missing Punch alert. Check-in and check-out always; the lunch
    # punches only when the attendance mode counts them (strict). They are always worth a heads-up.
    required: bool = True


def expected_slots(shift, strict: bool) -> list[Slot]:
    """The punches this shift expects and when: check-in at the start, then, when the shift has a lunch
    break, lunch-out at the shift's first-half end and lunch-in one lunch duration later, then
    check-out at the end. That is every mode: simple attendance mode only ignores the lunch punches
    when working out the day's pay, people still make them and are still reminded (`strict` decides
    only whether a missing lunch punch is worth a Missing Punch alert). A lunch that doesn't fit
    inside the shift is ignored rather than guessed at, leaving check-in and check-out."""
    start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
    if shift.first_half_end is not None:
        out_s = _t2s(shift.first_half_end)
        back_s = out_s + (shift.lunch_duration_minutes or 0) * 60
        if start_s < out_s < back_s < end_s:
            return [
                Slot(1, STRICT_PUNCH_NAMES[0], start_s, "1 of 4", "in"),
                Slot(2, STRICT_PUNCH_NAMES[1], out_s, "2 of 4", "lunch_out", required=strict),
                Slot(3, STRICT_PUNCH_NAMES[2], back_s, "3 of 4", "lunch_in", required=strict),
                Slot(4, STRICT_PUNCH_NAMES[3], end_s, "4 of 4", "out"),
            ]
    return [
        Slot(1, SIMPLE_PUNCH_NAMES[0], start_s, "1 of 2", "in"),
        Slot(2, SIMPLE_PUNCH_NAMES[1], end_s, "2 of 2", "out"),
    ]


def slot_is_pending(slot: Slot, slots: list[Slot], n: int) -> bool:
    """Is this the punch the employee still owes, having made `n` punches so far?

    Punches alternate in/out, so the next one is the slot after the ones made. The check-out is the
    exception: it is owed whenever they are clocked in (an odd number of punches), even if a lunch
    punch was skipped."""
    if slot.number == len(slots):
        return n % 2 == 1
    return n == slot.number - 1


def reminder_window(slot: Slot, lead_s: int) -> tuple[int, int]:
    """[from, until) in seconds since midnight: from `lead` before the punch is expected until it is."""
    return slot.expected_s - lead_s, slot.expected_s if lead_s > 0 else slot.expected_s + 60


def missing_window(slot: Slot, slots: list[Slot], wait_s: int, lead_s: int, end_s: int) -> tuple[int, int]:
    """[from, until): from `wait` after the punch was expected until it stops being worth saying.
    That is when the next punch's reminder starts (the day has moved on), or, for the last punch,
    some hours after the shift ends. Never more than MISSING_FRESH_S after it became due."""
    if slot.number == len(slots):
        until = min(DAY_S, end_s + CHECK_OUT_ALERT_WINDOW_S)
    else:
        until = slots[slot.number].expected_s - lead_s
    start = slot.expected_s + wait_s
    return start, min(until, start + MISSING_FRESH_S)


def due_reminder_slot(slots: list[Slot], n: int, now_s: int, lead_s: int) -> Slot | None:
    """The punch to send a heads-up about right now, or None."""
    for slot in slots:
        lo, hi = reminder_window(slot, lead_s)
        if lo <= now_s < hi and slot_is_pending(slot, slots, n):
            return slot
    return None


def due_missing_slot(slots: list[Slot], n: int, now_s: int, wait_s: int, lead_s: int, end_s: int) -> Slot | None:
    """The punch to say is missing right now, or None. Only punches worth chasing (see Slot.required)."""
    for slot in slots:
        if not slot.required:
            continue
        lo, hi = missing_window(slot, slots, wait_s, lead_s, end_s)
        if lo <= now_s < hi and slot_is_pending(slot, slots, n):
            return slot
    return None


# ── the day's data, loaded once ──────────────────────────────────────────────────


@dataclass
class DayData:
    now: datetime
    today: date
    now_s: int
    strict: bool
    payroll: object
    switches: object
    permission_window_s: int
    assignments: dict
    punches: dict
    on_leave: set
    decided: set
    permitted: set
    on_duty: dict
    already: set = field(default_factory=set)

    @property
    def iso(self) -> str:
        return self.today.isoformat()


@dataclass
class Due:
    """One message to send: what kind, the dedupe tag that makes it once-a-day, and its variables."""

    doc_type: str
    tag: str
    params: dict


def non_working_reason(today: date) -> str | None:
    if today.weekday() == 6:
        return "Sunday"
    if today in _holiday_dates_for_month(today.year, today.month):
        return "a company holiday"
    return None


def load_day(now: datetime, switches=None) -> DayData:
    """Everything the run needs about today, in a handful of queries rather than a few per employee."""
    today = now.date()
    iso = today.isoformat()
    day_start = datetime.combine(today, time_type(0, 0), tzinfo=FACTORY_TZ)
    payroll = PayrollSettings.get()

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
    # HR has already decided the day. An hand-written day record (an HR override, an approved casual
    # leave) is one. A presence row is one only for someone with no punches at all: the punch ingest
    # writes a presence row for everyone who punches, which is not a decision by anybody.
    marked_present = set(Attendance.objects.filter(date=iso, present=True).values_list("employee_id", flat=True))
    decided = set(
        AttendanceDayRecord.objects.filter(date=today, source="manual").values_list("employee_id", flat=True)
    ) | (marked_present - set(punches))
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
    return DayData(
        now=now,
        today=today,
        now_s=now.hour * 3600 + now.minute * 60 + now.second,
        strict=payroll.attendance_mode != "simple",
        payroll=payroll,
        switches=switches or WhatsAppSettings.get(),
        permission_window_s=_permission_window_minutes(payroll) * 60,
        assignments=assignments,
        punches=punches,
        on_leave=on_leave,
        decided=decided,
        permitted=permitted,
        on_duty=on_duty,
        already=already,
    )


def _late_status(delta_s: int, grace_s: int, window_s: int, permission_window_s: int) -> str:
    zone = _classify_zone(delta_s, grace_s, window_s, permission_window_s)
    if zone == ZONE_HALF_SHIFT:
        return "Late - Half Shift"
    if zone == ZONE_PERMISSION:
        return "Late - counted as an automatic Permission"
    return "Late"


# ── the decision for one employee ────────────────────────────────────────────────


def evaluate(emp, day: DayData, trace: list | None = None) -> list[Due]:
    """Every message that is due for this employee right now. Pure with respect to sending: it only
    reads `day`. `trace`, when given, is filled with one plain sentence per step, including why an
    alert was NOT due."""
    say = trace.append if trace is not None else (lambda _msg: None)
    sw = day.switches
    due: list[Due] = []

    def tag_sent(tag: str) -> bool:
        return f"{tag}:{day.iso}:{emp.id}" in day.already

    emp_assignments = day.assignments.get(emp.id)
    if not emp_assignments:
        say("No shift is assigned to this employee for today, so nothing can be judged.")
        return due
    if emp.id in day.on_leave:
        say("Has approved leave today: no alerts.")
        return due
    if emp.id in day.decided:
        say("HR has already set today's attendance by hand (or marked them present with no punches): no alerts.")
        return due
    assignment = _get_assignment_for_date(emp, day.today, assignments=emp_assignments)
    shift = _get_shift_for_date(emp, day.today, assignments=emp_assignments)
    if assignment is None or shift is None:
        say("No shift covers today: no alerts.")
        return due
    if day.today.weekday() == 5 and assignment.saturday_off:
        say("Saturday is this employee's day off: no alerts.")
        return due
    start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
    if end_s <= start_s:
        say("The shift runs past midnight, so there is no single-day deadline: no alerts.")
        return due

    grace_s = (shift.grace_period_minutes or 0) * 60
    window_s = _punctuality_window_minutes(shift, day.payroll) * 60
    absent_cutoff_s = start_s + window_s + sw.absent_extra_minutes * 60
    lead_s = sw.four_punch_lead_minutes * 60
    wait_s = sw.missing_punch_after_minutes * 60
    times = collapse_taps(sorted({_t2s(t) for t in day.punches.get(emp.id, [])}))
    n = len(times)
    slots = expected_slots(shift, day.strict)
    name = full_name(emp)
    date_text = _fmt_date(day.today)
    now_s = day.now_s

    say(
        f"Shift '{shift.name}' {_fmt_time(start_s)} to {_fmt_time(end_s)}, grace {shift.grace_period_minutes or 0} min "
        f"(latest on-time punch {_fmt_time(start_s + grace_s)}); "
        + ", ".join(f"{s.name} {_fmt_time(s.expected_s)}" for s in slots)
        + "."
    )
    say(
        f"Punches recorded today: {n}"
        + (f" ({', '.join(_fmt_time(t) for t in times)})" if times else "")
        + f". Time now {_fmt_time(now_s)}."
    )

    # Compensation days are never penalised; looked up only if something is due.
    comp = {}

    def excused() -> bool:
        if "v" not in comp:
            comp["v"] = bool(_compensation_day_for(emp, day.today, settings=day.payroll))
            if comp["v"]:
                say("Today is a Compensation Day for this employee: never penalised, no alerts.")
        return comp["v"]

    if emp.id in day.on_duty:
        # Working On-Duty: their punches are Geo Punches, so only the reminders apply.
        say(f"On duty at {day.on_duty[emp.id]}: only the Geo Punch reminders apply.")
        if not sw.four_punch_alert_enabled:
            say("Punch Reminder switch is OFF.")
        elif not excused():
            from .geo_attendance_views import _taken_slots

            taken = len(_taken_slots(emp, day.today))
            slot = due_reminder_slot(slots, taken, now_s, lead_s)
            if slot is None:
                say(f"No Geo Punch is due in the next {sw.four_punch_lead_minutes} minutes ({taken} taken).")
            elif tag_sent(f"duty{slot.number}"):
                say(f"On-Duty reminder for {slot.name} was already sent today.")
            else:
                due.append(
                    Due(
                        "on_duty_punch_reminder",
                        f"duty{slot.number}",
                        _reminder_params(emp, day, slot, name, date_text) | {"destination": day.on_duty[emp.id]},
                    )
                )
                say(f"DUE: On-Duty reminder for {slot.name}.")
        return due

    # 1. Absent: nothing recorded within the permitted time after the shift started.
    if not sw.absent_alert_enabled:
        say("Absent alert: switch is OFF.")
    elif n != 0:
        say("Absent alert: not due, the employee has punched.")
    elif not (absent_cutoff_s <= now_s < end_s):
        say(f"Absent alert: not due yet, it goes out at {_fmt_time(absent_cutoff_s)} if there is still no punch.")
    elif now_s >= absent_cutoff_s + ABSENT_FRESH_S:
        say("Absent alert: not sent, it became due over an hour ago and would arrive stale.")
    elif excused():
        pass
    elif tag_sent("absent"):
        say("Absent alert: already sent today.")
    else:
        due.append(
            Due(
                "absent_alert",
                "absent",
                {
                    "employee_name": name,
                    "date": date_text,
                    "shift_start": _fmt_time(shift.start_time),
                    "cutoff_time": _fmt_time(absent_cutoff_s),
                    "status": "No punch recorded yet",
                    "shift_end": _fmt_time(shift.end_time),
                    "wait_minutes": str(window_s // 60 + sw.absent_extra_minutes),
                },
            )
        )
        say("DUE: Absent alert.")

    # 2. Late arrival (needs an approved permission to be excused). The allowed time is the shift
    # start plus THIS shift's grace. Seconds don't count: the first punch is the minute it was made in,
    # exactly as the attendance engine judges it, so with a 9:10 limit a punch at 9:10:40 is on time and
    # the first late minute is 9:11.
    allowed_s = start_s + grace_s
    first_minute_s = times[0] // 60 * 60 if times else None
    if not sw.late_alert_enabled:
        say("Late alert: switch is OFF.")
    elif n == 0:
        say("Late alert: not due, no punch yet.")
    elif not first_minute_s > allowed_s:
        say(
            f"Late alert: not due, first punch {_fmt_time(times[0])} is within the allowed time {_fmt_time(allowed_s)} (seconds are ignored)."
        )
    elif times[0] > end_s:
        say("Late alert: not due, the first punch came after the shift ended.")
    elif now_s - first_minute_s > LATE_FRESH_S:
        say("Late alert: not sent, the punch was more than 30 minutes ago and the message would arrive stale.")
    elif emp.id in day.permitted:
        say("Late alert: not due, an approved permission covers today.")
    elif excused():
        pass
    elif tag_sent("late"):
        say("Late alert: already sent today.")
    else:
        past_allowed_s = first_minute_s - allowed_s  # whole minutes past the allowed time, at least one
        due.append(
            Due(
                "late_alert",
                "late",
                {
                    "employee_name": name,
                    "date": date_text,
                    "shift_start": _fmt_time(shift.start_time),
                    "first_punch": _fmt_time(times[0]),
                    "late_by": duration_str(past_allowed_s),
                    "status": _late_status(first_minute_s - start_s, grace_s, window_s, day.permission_window_s),
                    "grace_minutes": str(shift.grace_period_minutes or 0),
                    "grace_period": _plural(shift.grace_period_minutes or 0, "minute"),
                },
            )
        )
        say(
            f"DUE: Late alert (first punch {_fmt_time(times[0])}, {duration_str(past_allowed_s)} after {_fmt_time(allowed_s)})."
        )

    # 3. A heads-up shortly before each punch is expected, if it is still missing.
    if not sw.four_punch_alert_enabled:
        say("Punch reminder: switch is OFF.")
    elif not excused():
        slot = due_reminder_slot(slots, n, now_s, lead_s)
        if slot is None:
            say(
                f"Punch reminder: none due (they go out {sw.four_punch_lead_minutes} min before a punch that is still missing)."
            )
        elif tag_sent(f"four{slot.number}"):
            say(f"Punch reminder for {slot.name}: already sent today.")
        else:
            due.append(Due("four_punch_alert", f"four{slot.number}", _reminder_params(emp, day, slot, name, date_text)))
            say(f"DUE: Punch reminder for {slot.name}.")

    # 4. A punch is still missing some time after it was expected.
    if not sw.missing_punch_alert_enabled:
        say("Missing punch alert: switch is OFF.")
    elif not excused():
        slot = due_missing_slot(slots, n, now_s, wait_s, lead_s, end_s)
        if slot is None:
            say(
                f"Missing punch alert: none due (one goes out {sw.missing_punch_after_minutes} min after a punch was expected)."
            )
        elif tag_sent(f"missing{slot.number}"):
            say(f"Missing punch alert for {slot.name}: already sent today.")
        else:
            due.append(
                Due(
                    "missing_punch_alert",
                    f"missing{slot.number}",
                    {
                        "employee_name": name,
                        "date": date_text,
                        "punch_name": slot.name,
                        "expected_time": _fmt_time(slot.expected_s),
                        "status": "Punch Not Recorded",
                        "intro": MISSING_TEXT[slot.role],
                        # Kept for wording HR saved before punches were judged one at a time.
                        "recorded": f"{n} of {len(slots)}",
                        "missing": ", ".join(s.name for s in slots[n:]),
                    },
                )
            )
            say(f"DUE: Missing punch alert for {slot.name}.")
    return due


def _reminder_params(emp, day: DayData, slot: Slot, name: str, date_text: str) -> dict:
    action, closing = REMINDER_TEXT[slot.role]
    left = _plural(max(1, math.ceil((slot.expected_s - day.now_s) / 60)), "minute")
    return {
        "employee_name": name,
        "date": date_text,
        "punch_name": slot.name,
        "punch_number": slot.position,
        "expected_time": _fmt_time(slot.expected_s),
        "greeting": _greeting(day.now_s),
        "action": action.format(left=left),
        "minutes_left": left,
        "quote": _quote(emp.id, day.today, slot.number),
        "closing": closing,
        "hint": f"Expected at {_fmt_time(slot.expected_s)}.",
    }


def _recently_sent() -> tuple[int, int]:
    """How many alert messages went out in the last hour and since midnight (factory time)."""
    now_utc = timezone.now()
    day_start = now_utc.astimezone(FACTORY_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    attempted = WhatsAppMessageLog.objects.filter(
        document_type__in=ALERT_TYPES,
        status__in=(
            WhatsAppMessageLog.STATUS_PENDING,
            WhatsAppMessageLog.STATUS_SENT,
            WhatsAppMessageLog.STATUS_DELIVERED,
            WhatsAppMessageLog.STATUS_READ,
        ),
    )
    return (
        attempted.filter(created_at__gte=now_utc - timedelta(hours=1)).count(),
        attempted.filter(created_at__gte=day_start).count(),
    )


def provider_is_failing() -> bool:
    """Have several alerts failed lately for a reason that is the provider's, not the employee's?"""
    failed = (
        WhatsAppMessageLog.objects.filter(
            document_type__in=ALERT_TYPES,
            status=WhatsAppMessageLog.STATUS_FAILED,
            created_at__gte=timezone.now() - timedelta(seconds=BREAKER_WINDOW_S),
        )
        .exclude(error_message__startswith="No phone")
        .count()
    )
    return failed >= BREAKER_FAILURES


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
    if non_working_reason(now.date()):
        return dict(sent)
    if provider_is_failing():
        logger.warning(
            "WhatsApp attendance alerts paused: %s or more alerts failed in the last %s minutes, so the provider "
            "is refusing messages (a disconnected or restricted number?). Fix that and they resume by themselves.",
            BREAKER_FAILURES,
            BREAKER_WINDOW_S // 60,
        )
        return dict(sent)
    day = load_day(now, switches)

    per_run = dj_settings.WHATSAPP_ALERTS_MAX_PER_RUN
    per_hour = dj_settings.WHATSAPP_ALERTS_MAX_PER_HOUR
    per_day = dj_settings.WHATSAPP_ALERTS_MAX_PER_DAY
    hour_sent, day_sent = _recently_sent()
    held = 0

    for emp in Employee.objects.filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_STAFF):
        for item in evaluate(emp, day):
            key = f"{item.tag}:{day.iso}:{emp.id}"
            if key in day.already:
                continue
            this_run = sum(sent.values())
            if (
                (per_run and this_run >= per_run)
                or (per_hour and hour_sent + this_run >= per_hour)
                or (per_day and day_sent + this_run >= per_day)
            ):
                held += 1  # not marked as sent: it is looked at again next minute while it is still fresh
                continue
            day.already.add(key)
            # Inline (not the background worker): this job is already a background thread, and running
            # in order keeps the pause between messages meaningful.
            log = whatsapp_service.send_notification(
                emp, item.doc_type, item.params, dedupe_key=key, asynchronous=False
            )
            if log is not None:
                sent[item.doc_type] += 1
                whatsapp_service.pace()

    if held:
        logger.warning(
            "WhatsApp attendance alerts: %s message(s) held back by the send limits (%s per run, %s per hour, %s per day); "
            "each is retried next minute only while it is still fresh, otherwise dropped.",
            held,
            per_run,
            per_hour,
            per_day,
        )
    if sent:
        logger.warning("WhatsApp attendance alerts sent: %s", dict(sent))
    return dict(sent)
