"""
Night Shift Relaxation Engine
=============================
Company policy: employees who work late into the night get NO overtime pay.
Instead they may report late the next morning without being marked Late or
Half Shift — and still earn 1 full shift for the day.

Detection
---------
A night shift is detected from raw AttendanceLog punches:
  • last punch on day D at/after NIGHT_START (20:00), or
  • early-morning punches on day D+1 (at/before MORNING_CUTOFF, 06:00) that
    belong to the previous night's session (device logs them under D+1).

The detected punch-out time is matched against DB-driven NightShiftRule rows
(ascending worked_until; first threshold >= actual out-time wins) to find the
allowed first-punch time for day D+1. The result is stored in
NightShiftRelaxation — one row per employee per relaxation day.

Attendance/payroll integration lives in attendance_final.py / payroll_views.py,
which call get_relaxation_for() when classifying a day.
"""

from datetime import date as date_type, datetime, time as time_type, timedelta

from .models import (
    AttendanceLog, Employee, NightShiftRelaxation, NightShiftRule,
)

# Fallback only for employees with no shift assignment at all — everyone else
# uses their own shift's end time (see _night_start_for below), never a fixed
# clock time. A hardcoded global here would misclassify perfectly normal
# checkouts as "worked a night shift" for anyone whose shift simply ends near
# this hour.
_DEFAULT_NIGHT_START = time_type(20, 0)
# How far past an employee's OWN shift end counts as genuinely working into
# the night (as opposed to a normal few-minutes-over checkout).
NIGHT_WORK_BUFFER_MINUTES = 120
# Punches at/before this time belong to the PREVIOUS night's session
MORNING_CUTOFF = time_type(6, 0)


def _t2m(t: time_type) -> int:
    return t.hour * 60 + t.minute


def _night_start_for(emp: Employee, night_date: date_type) -> time_type:
    """
    The time after which this employee is considered to be working into the
    night, derived from their OWN assigned shift end + a buffer — never a
    fixed clock time shared across every employee.
    """
    from .shift_engine import _get_shift_for_date
    shift = _get_shift_for_date(emp, night_date)
    if shift and shift.end_time:
        end_minutes = _t2m(shift.end_time) + NIGHT_WORK_BUFFER_MINUTES
        return time_type((end_minutes // 60) % 24, end_minutes % 60)
    return _DEFAULT_NIGHT_START


def _night_minutes(t: time_type, crossed: bool) -> int:
    """Normalize an out-time to minutes since 12:00 noon of the night day,
    so 22:30 (630) sorts before 02:30 next day (870)."""
    return _t2m(t) + (24 * 60 - 12 * 60) if crossed else _t2m(t) - 12 * 60


DEFAULT_RULES = [
    # (name, worked_until, crosses_midnight, allowed_first_punch, order)
    ("Until 10:30 PM", time_type(22, 30), False, time_type(10, 0), 1),
    ("Until 12:00 AM", time_type(0, 0),   True,  time_type(11, 0), 2),
    ("Until 2:30 AM",  time_type(2, 30),  True,  time_type(12, 0), 3),
    ("Until 4:00 AM",  time_type(4, 0),   True,  time_type(16, 0), 4),
    ("Until 5:00 AM+", time_type(5, 59),  True,  time_type(17, 30), 5),
]


def ensure_default_rules() -> None:
    """Seed the rule table on first use so the feature works out of the box."""
    if NightShiftRule.objects.exists():
        return
    for name, until, crossed, allowed, order in DEFAULT_RULES:
        NightShiftRule.objects.create(
            name=name, worked_until=until, crosses_midnight=crossed,
            allowed_first_punch=allowed, order=order,
        )


def match_rule(out_time: time_type, crossed_midnight: bool) -> NightShiftRule | None:
    """First active rule whose threshold covers the actual punch-out time."""
    ensure_default_rules()
    out_m = _night_minutes(out_time, crossed_midnight)
    best = None
    best_m = None
    for rule in NightShiftRule.objects.filter(is_active=True):
        rule_m = _night_minutes(rule.worked_until, rule.crosses_midnight)
        if rule_m >= out_m and (best_m is None or rule_m < best_m):
            best, best_m = rule, rule_m
    return best


def detect_night_for_employee(emp: Employee, night_date: date_type) -> NightShiftRelaxation | None:
    """
    Inspect punches for (emp, night_date) and the early morning of the next
    day. Creates/updates the NightShiftRelaxation row, or returns None when
    the employee did not work into the night.
    """
    next_day = night_date + timedelta(days=1)
    night_start = _night_start_for(emp, night_date)

    day_punches = list(
        AttendanceLog.objects.filter(employee=emp, date=night_date)
        .order_by("punch_time").values_list("punch_time", flat=True)
    )
    early_punches = list(
        AttendanceLog.objects.filter(
            employee=emp, date=next_day, punch_time__lte=MORNING_CUTOFF,
        ).order_by("punch_time").values_list("punch_time", flat=True)
    )

    worked_late_same_day = bool(day_punches) and day_punches[-1] >= night_start
    crossed = bool(early_punches) and bool(day_punches) and day_punches[-1] >= night_start

    # Crossed midnight: checkout is the last early-morning punch on the next day.
    # (Requires evening presence on the night day so a lone early punch — e.g.
    # an odd 05:50 arrival — is never misread as a night checkout.)
    if crossed:
        last_out, crossed_midnight = early_punches[-1], True
    elif worked_late_same_day:
        last_out, crossed_midnight = day_punches[-1], False
    else:
        # No night work — remove any stale auto row for this night
        NightShiftRelaxation.objects.filter(employee=emp, relaxation_date=next_day).delete()
        return None

    rule = match_rule(last_out, crossed_midnight)
    if rule is None:
        return None

    relax, _ = NightShiftRelaxation.objects.update_or_create(
        employee=emp,
        relaxation_date=next_day,
        defaults={
            "night_date": night_date,
            "last_punch_out": last_out,
            "crossed_midnight": crossed_midnight,
            "allowed_until": rule.allowed_first_punch,
            "rule": rule,
        },
    )
    return relax


def detect_night_for_date(night_date: date_type) -> int:
    """Run detection for every active employee for one night. Returns count."""
    count = 0
    emp_ids = set(
        AttendanceLog.objects.filter(date__in=[night_date, night_date + timedelta(days=1)])
        .values_list("employee_id", flat=True).distinct()
    )
    for emp in Employee.objects.filter(id__in=emp_ids, status="active"):
        if detect_night_for_employee(emp, night_date):
            count += 1
    return count


def get_relaxation_for(emp: Employee, d: date_type) -> NightShiftRelaxation | None:
    """
    Relaxation applying to day `d` for this employee — lazily detected from
    the previous night's punches if not already stored. This is the hook
    attendance/payroll use, so no pre-computation step is ever required.
    """
    relax = NightShiftRelaxation.objects.filter(employee=emp, relaxation_date=d).first()
    if relax is None:
        relax = detect_night_for_employee(emp, d - timedelta(days=1))
    return relax


def record_report(relax: NightShiftRelaxation, first_punch: time_type) -> None:
    """Store when the employee actually reported the next day."""
    within = first_punch <= relax.allowed_until
    if relax.reported_at != first_punch or relax.within_allowance != within:
        relax.reported_at = first_punch
        relax.within_allowance = within
        relax.save(update_fields=["reported_at", "within_allowance", "computed_at"])
