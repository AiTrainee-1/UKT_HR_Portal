"""
Automatic attendance for the MD department (owner 2026-11-05).

Every day at 8:00 PM (IST) ``md_auto_attendance_scheduler`` calls :func:`run`. For each employee on the list (for now
2671 and 1: ``AUTO_PRESENT_CODES``, or the ``MD_AUTO_ATTENDANCE_CODES`` environment variable) who is active staff in the
MD department, every working day from the start date (owner 2026-11-05: 1 January 2026, ``START_DATE``, or the
``MD_AUTO_ATTENDANCE_START`` environment variable as YYYY-MM-DD; or the joining day if later) up to today that has no
attendance of its own gets one IN and one OUT punch at a random time inside the employee's own shift for that day, and the
day's attendance record is recomputed by the attendance engine straight away, so the day reads Full-Day Present:

  - IN between 15 minutes before the shift start and the end of the shift's grace (never Late);
  - OUT between the start of the evening grace (shift end - grace) and 10 minutes after the shift end (never Early-Out,
    always well under the overtime threshold, so no OT is detected).

What it never touches:
  - anybody not on the list, and anybody on it who is not active staff in the MD department (logged and skipped);
  - a day that already has a punch of any kind (biometric, Geo Punch, On-Duty, HR entry), an HR-edited (manual) day
    record or an HR "Add Attendance" row, an approved leave, half-day leave or Casual Leave;
  - Sundays, company holidays, Saturdays on a Saturday-off shift, days before joining, an overnight shift, and days still
    to come;
  - today until its OUT time has passed (a shift ending after 8 PM gets today filled on the next evening's run).

A day before the employee's first shift assignment is timed by that first shift (Karan's shift is assigned from
1 Oct 2026 only); an employee with no shift at all is skipped.

Running it again is harmless: a filled day has punches, so it is skipped (the first run after the start date was set fills
the months behind; every later run only adds the new day). Every attendance rule is unchanged: the engine
judges these punches exactly like any other.

The punches carry source ``auto:md`` (shown as "Auto Attendance"), so they can always be told apart from biometric
punches and HR entries, and removed in one go if the rule is dropped. The random times are drawn from a generator seeded
per employee and day, so a day's times are the same whenever they are worked out (and tests are repeatable).
"""

from __future__ import annotations

import logging
import os
import random
from datetime import date, datetime, time, timedelta

logger = logging.getLogger(__name__)

# Employee codes (ID NO) whose attendance is generated. Owner 2026-11-05: "for now, only these two".
AUTO_PRESENT_CODES = ("2671", "1")
# The first day attendance is counted from (owner 2026-11-05: "from 1/1/2026").
START_DATE = date(2026, 1, 1)
DEPARTMENT = "MD"
SOURCE = "auto:md"
SOURCE_LABEL = "Auto Attendance"
IN_BEFORE_START_MINUTES = 15
OUT_AFTER_END_MINUTES = 10


def configured_codes() -> tuple[str, ...]:
    """The employee codes the rule covers: MD_AUTO_ATTENDANCE_CODES (comma separated) when set, else AUTO_PRESENT_CODES."""
    raw = os.environ.get("MD_AUTO_ATTENDANCE_CODES")
    if raw is None:
        return AUTO_PRESENT_CODES
    return tuple(code.strip() for code in raw.split(",") if code.strip())


def start_date() -> date:
    """The first day the rule fills: MD_AUTO_ATTENDANCE_START (YYYY-MM-DD) when set and readable, else START_DATE."""
    raw = (os.environ.get("MD_AUTO_ATTENDANCE_START") or "").strip()
    if raw:
        try:
            return date.fromisoformat(raw)
        except ValueError:
            logger.warning(
                "MD auto attendance: MD_AUTO_ATTENDANCE_START %r is not YYYY-MM-DD, using %s", raw, START_DATE
            )
    return START_DATE


def eligible_employees() -> list:
    """The listed employees who are active staff in the MD department (anyone else on the list is logged and skipped)."""
    from .models import Employee

    out = []
    for emp in Employee.objects.select_related("department").filter(employee_code__in=configured_codes()):
        department = (emp.department.name if emp.department_id and emp.department else "") or ""
        if emp.status != "active" or emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF:
            logger.info("MD auto attendance: %s is not active staff, skipped", emp.employee_code)
            continue
        if department.strip().upper() != DEPARTMENT:
            logger.warning(
                "MD auto attendance: %s is in department %r, not %s, skipped", emp.employee_code, department, DEPARTMENT
            )
            continue
        out.append(emp)
    return out


def _secs(t: time) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def _clock(secs: int) -> time:
    return time(secs // 3600, secs // 60 % 60, secs % 60)


def punch_pair(shift, day: date, now: datetime, rng: random.Random, ot_threshold_minutes: int = 60):
    """(IN, OUT) for a Full-Day Present inside `shift` on `day`, or None when the day cannot be timed (an overnight shift,
    or today with its OUT window still ahead of `now`).

    The late check reads the first punch in whole minutes against shift start + grace, the early-out check compares the
    last punch with shift end - grace, and overtime starts `ot_threshold_minutes` after the end."""
    start, end = _secs(shift.start_time), _secs(shift.end_time)
    if end <= start:
        return None
    grace = max(0, int(shift.grace_period_minutes or 0))
    in_lo = max(0, start - IN_BEFORE_START_MINUTES * 60)
    in_hi = start + max(0, grace - 1) * 60 + 59  # the last second still on time, with a minute to spare
    out_lo = end - grace * 60
    out_hi = min(86399, end + min(OUT_AFTER_END_MINUTES, max(1, int(ot_threshold_minutes or 60) - 1)) * 60)
    if day == now.date():
        out_hi = min(out_hi, _secs(now.time()) - 60)  # never a punch in the future
    if day > now.date() or out_hi < out_lo or in_hi < in_lo:
        return None
    in_secs, out_secs = rng.randint(in_lo, in_hi), rng.randint(out_lo, out_hi)
    if in_secs >= out_secs:
        return None
    return _clock(in_secs), _clock(out_secs)


def _joined(emp) -> date | None:
    from .reporting.definitions.employees_master_base import join_date_of

    joined, _state = join_date_of(emp)
    return joined


def days_to_fill(emp, first: date, last: date) -> list[tuple[date, object]]:
    """[(day, shift)] of the working days in [first, last] that have no attendance of their own (see the module notes)."""
    from .attendance_final import _half_day_leave_dates_for_month, _leave_dates_for_month
    from .models import (
        Attendance,
        AttendanceDayRecord,
        AttendanceLog,
        CasualLeaveRequest,
        EmployeeShiftAssignment,
        Holiday,
    )
    from .shift_engine import _get_assignment_for_date, _get_shift_for_date

    if last < first:
        return []
    punched = set(AttendanceLog.objects.filter(employee=emp, date__range=(first, last)).values_list("date", flat=True))
    manual = set(
        AttendanceDayRecord.objects.filter(employee=emp, date__range=(first, last), source="manual").values_list(
            "date", flat=True
        )
    )
    added = {
        text
        for text in Attendance.objects.filter(employee=emp, present=True).values_list("date", flat=True)
        if text and first.isoformat() <= str(text)[:10] <= last.isoformat()
    }
    casual = set(
        CasualLeaveRequest.objects.filter(
            employee=emp, date__range=(first, last), status=CasualLeaveRequest.STATUS_APPROVED
        ).values_list("date", flat=True)
    )
    # approved full-day and half-day leave, read the way the attendance engine reads it
    on_leave: set[date] = set()
    year, month = first.year, first.month
    while (year, month) <= (last.year, last.month):
        on_leave |= _leave_dates_for_month(emp, year, month)
        on_leave |= set(_half_day_leave_dates_for_month(emp, year, month))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    holidays = set(Holiday.objects.filter(date__range=(first, last)).values_list("date", flat=True))
    joined = _joined(emp)
    # the shift assignments, read once; a day before the first one is timed by the first one
    assignments = list(EmployeeShiftAssignment.objects.select_related("shift").filter(employee=emp))
    earliest = min(assignments, key=lambda a: a.effective_from) if assignments else None

    out = []
    d = first
    while d <= last:
        day, d = d, d + timedelta(days=1)
        if day.weekday() == 6 or day in holidays or (joined and day < joined):
            continue
        if day in punched or day in manual or day.isoformat() in added or day in casual or day in on_leave:
            continue
        assignment = _get_assignment_for_date(emp, day, assignments=assignments)
        timed_on = day
        if assignment is None and earliest is not None and day < earliest.effective_from:
            assignment, timed_on = earliest, earliest.effective_from
        if assignment is None or (assignment.saturday_off and day.weekday() == 5):
            continue
        shift = _get_shift_for_date(emp, timed_on, assignments=assignments)
        if shift is None or shift.start_time is None or shift.end_time is None:
            continue
        out.append((day, shift))
    return out


def run(now: datetime | None = None, first: date | None = None, dry_run: bool = False) -> dict:
    """Fill the listed MD employees' working days from `first` (default: start_date(), 1 Jan 2026) up to `now` (default:
    the current IST time). Returns {"employees": {code: [days filled]}, "punches": n}. `dry_run` writes nothing."""
    from django.db import transaction

    from .attendance_final import compute_range_records
    from .clock import ist_now
    from .models import AttendanceLog
    from .user_settings import settings_for_employee

    now = now or ist_now()
    first = first or start_date()
    summary: dict = {"employees": {}, "punches": 0, "dryRun": dry_run}
    for emp in eligible_employees():
        threshold = getattr(settings_for_employee(emp), "ot_threshold_minutes", 60) or 60
        logs = []
        for day, shift in days_to_fill(emp, first, now.date()):
            pair = punch_pair(shift, day, now, random.Random(f"md-auto:{emp.pk}:{day.isoformat()}"), threshold)
            if pair is None:
                continue
            for punch, kind in zip(pair, (AttendanceLog.PUNCH_IN, AttendanceLog.PUNCH_OUT)):
                logs.append(AttendanceLog(employee=emp, date=day, punch_time=punch, punch_type=kind, source=SOURCE))
        days = sorted({log.date for log in logs})
        summary["employees"][emp.employee_code] = [d.isoformat() for d in days]
        summary["punches"] += len(logs)
        if not logs or dry_run:
            continue
        with transaction.atomic():
            AttendanceLog.objects.bulk_create(logs, ignore_conflicts=True)
        compute_range_records(emp, days[0], days[-1])  # the day records read Present at once
    return summary
