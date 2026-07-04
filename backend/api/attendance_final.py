"""
Final Attendance Engine — mode-aware day computation + HR overrides
===================================================================

Produces one AttendanceDayRecord per employee per day. This table is the
single source of truth for Payroll/Salary:

  • source == "auto"   → computed from punches using the mode selected in
                          Settings (strict | simple)
  • source == "manual" → HR override; NEVER recomputed automatically

Modes
-----
strict (staff): existing 4-punch engine (DailyShiftLog) — lunch delays,
                return-late detection, half shift when only 2 punches.

simple (staff): • valid morning punch + evening last punch  → full shift
                • first punch after cutoff (default 13:30)  → half shift
                • no lunch/afternoon delay tracking at all
                • late = first punch > shift start + grace
                • early_leave = last punch < shift end

production:     1.5-shift day (works in both modes):
                • first half   08:30–12:30  → 0.50
                • second half  13:30–17:30  → 0.50
                • extra half   17:50–20:00  → 0.50
                windows configurable in PayrollSettings.
"""

import calendar
from datetime import date as date_type, datetime, time as time_type, timedelta
from decimal import Decimal

from django.db.models import Q

from .models import (
    AttendanceDayRecord, AttendanceLog, Attendance, Employee, Holiday,
    LeaveRequest, PayrollSettings,
)
from .shift_engine import _get_shift_for_date, _t2s


# ── Helpers ────────────────────────────────────────────────────────────────

def _leave_dates_for_month(emp, year: int, month: int) -> set:
    """Set of date objects covered by approved leave in the given month."""
    first = date_type(year, month, 1)
    last = date_type(year, month, calendar.monthrange(year, month)[1])
    dates = set()
    for lr in LeaveRequest.objects.filter(employee=emp, status="approved"):
        try:
            s = datetime.strptime(str(lr.start_date)[:10], "%Y-%m-%d").date()
            e = datetime.strptime(str(lr.end_date)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        d = max(s, first)
        while d <= min(e, last):
            dates.add(d)
            d += timedelta(days=1)
    return dates


def _holiday_dates_for_month(year: int, month: int) -> set:
    return set(
        Holiday.objects.filter(date__year=year, date__month=month)
        .values_list("date", flat=True)
    )


def _sunday(d: date_type) -> bool:
    return d.weekday() == 6


# ── Staff: simple mode ─────────────────────────────────────────────────────

def _compute_staff_simple(emp, d, punch_times, settings, shift):
    """Return dict of computed fields for a staff day in simple mode."""
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}

    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else None

    cutoff = settings.simple_half_shift_cutoff
    if isinstance(cutoff, str):
        cutoff = datetime.strptime(cutoff[:5], "%H:%M").time()

    # Half shift: the day only started after the cutoff (e.g. 13:30)
    if _t2s(first) > _t2s(cutoff):
        return {
            "status": "half_shift", "is_half_shift": True,
            "shifts_earned": Decimal("0.50"),
            "first_punch": first, "last_punch": last,
        }

    # Late: morning punch beyond shift start + grace
    is_late = False
    early_leave = False
    if shift:
        grace = (shift.grace_period_minutes or settings.simple_grace_minutes or 0) * 60
        if _t2s(first) > _t2s(shift.start_time) + grace:
            is_late = True
        if last and _t2s(last) < _t2s(shift.end_time):
            early_leave = True
    else:
        # No shift assigned — fall back to global grace over a 09:00 baseline
        grace = (settings.simple_grace_minutes or 0) * 60
        if _t2s(first) > _t2s(time_type(9, 0)) + grace:
            is_late = True

    # Full shift needs a distinct evening punch; single punch = half day
    if last is None:
        return {
            "status": "half_shift", "is_half_shift": True, "is_late": is_late,
            "shifts_earned": Decimal("0.50"), "first_punch": first,
        }

    return {
        "status": "present", "is_late": is_late, "early_leave": early_leave,
        "shifts_earned": Decimal("1.00"),
        "first_punch": first, "last_punch": last,
    }


# ── Staff: strict mode (reuse 4-punch engine result) ───────────────────────

def _compute_staff_strict(emp, d, punch_logs, punch_times):
    from .shift_engine import compute_daily_shift_log
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}
    log = compute_daily_shift_log(emp, d, punch_logs)
    shifts = Decimal(log.shifts_completed or 0)
    is_half = shifts == Decimal("0.50")
    return {
        "status": "half_shift" if is_half else ("present" if shifts > 0 else "absent"),
        "is_late": bool(log.late_morning or log.late_return),
        "is_half_shift": is_half,
        "shifts_earned": shifts,
        "first_punch": log.punch1,
        "last_punch": log.punch4 or (punch_times[-1] if len(punch_times) > 1 else None),
    }


# ── Production: 1.5-shift day ──────────────────────────────────────────────

def _compute_production(emp, d, punch_times, settings):
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}

    def as_time(v, fallback):
        if isinstance(v, str):
            return datetime.strptime(v[:5], "%H:%M").time()
        return v or fallback

    fh_end   = as_time(settings.prod_first_half_end,   time_type(12, 30))
    sh_end   = as_time(settings.prod_second_half_end,  time_type(17, 30))
    ex_end   = as_time(settings.prod_extra_end,        time_type(20, 0))
    fh_start = as_time(settings.prod_first_half_start, time_type(8, 30))

    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else punch_times[0]

    # First half earned when they arrived within/before the morning window
    first_half = _t2s(first) <= _t2s(fh_end)
    # Second half earned when they stayed until the second-half end (small tolerance)
    second_half = _t2s(last) >= _t2s(sh_end) - 30 * 60
    # Extra half earned when they stayed until (nearly) the extra-window end
    extra_half = _t2s(last) >= _t2s(ex_end) - 15 * 60

    shifts = Decimal("0")
    if first_half:
        shifts += Decimal("0.50")
    if second_half:
        shifts += Decimal("0.50")
    if extra_half:
        shifts += Decimal("0.50")
    if shifts == 0:
        # They punched but matched no window → count a half for showing up
        shifts = Decimal("0.50")

    grace = (settings.simple_grace_minutes or 15) * 60
    is_late = _t2s(first) > _t2s(fh_start) + grace
    is_half = shifts <= Decimal("0.50")

    return {
        "status": "half_shift" if is_half else "present",
        "is_late": is_late,
        "is_half_shift": is_half,
        "early_leave": not second_half and first_half,
        "shifts_earned": min(shifts, Decimal("1.50")),
        "first_punch": first,
        "last_punch": last if last != first else None,
    }


# ── Main entry: compute (or keep) the final record for one day ─────────────

def compute_day_record(emp, d: date_type, punch_logs=None, settings=None,
                       leave_dates=None, holiday_dates=None):
    """
    Compute and persist the AttendanceDayRecord for (emp, d).
    Manual overrides are preserved — returns the existing row untouched.
    """
    existing = AttendanceDayRecord.objects.filter(employee=emp, date=d).first()
    if existing and existing.source == "manual":
        return existing

    if settings is None:
        settings = PayrollSettings.get()

    if punch_logs is None:
        punch_logs = list(
            AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time")
        )
    punch_times = sorted(p.punch_time for p in punch_logs)

    # Manual attendance entries (Attendance table) count as presence too
    has_manual = Attendance.objects.filter(
        employee=emp, date=d.isoformat(), present=True
    ).exists()

    on_leave = (d in leave_dates) if leave_dates is not None else False
    is_holiday = (d in holiday_dates) if holiday_dates is not None else False

    fields = {
        "is_late": False, "is_half_shift": False, "early_leave": False,
        "first_punch": None, "last_punch": None,
    }

    if punch_times or has_manual:
        if not punch_times and has_manual:
            computed = {"status": "present", "shifts_earned": Decimal("1.00")}
        elif emp.employment_type == "production":
            computed = _compute_production(emp, d, punch_times, settings)
        elif settings.attendance_mode == "simple":
            shift = _get_shift_for_date(emp, d)
            computed = _compute_staff_simple(emp, d, punch_times, settings, shift)
        else:
            computed = _compute_staff_strict(emp, d, punch_logs, punch_times)
    elif on_leave:
        computed = {"status": "on_leave", "shifts_earned": Decimal("0")}
    elif is_holiday or _sunday(d):
        computed = {"status": "holiday", "shifts_earned": Decimal("0")}
    else:
        computed = {"status": "absent", "shifts_earned": Decimal("0")}

    fields.update(computed)
    fields["total_punches"] = len(punch_times)
    fields["computed_mode"] = (
        "production" if emp.employment_type == "production" else settings.attendance_mode
    )
    fields["source"] = "auto"

    record, _ = AttendanceDayRecord.objects.update_or_create(
        employee=emp, date=d, defaults=fields,
    )
    return record


def compute_month_records(emp, year: int, month: int, settings=None):
    """Compute final records for every elapsed day of the month. Returns list."""
    if settings is None:
        settings = PayrollSettings.get()

    days_in_month = calendar.monthrange(year, month)[1]
    today = date_type.today()

    logs = AttendanceLog.objects.filter(
        employee=emp, date__year=year, date__month=month
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    leave_dates = _leave_dates_for_month(emp, year, month)
    holiday_dates = _holiday_dates_for_month(year, month)

    records = []
    for day in range(1, days_in_month + 1):
        d = date_type(year, month, day)
        if d > today:
            break
        records.append(compute_day_record(
            emp, d,
            punch_logs=logs_by_date.get(d, []),
            settings=settings,
            leave_dates=leave_dates,
            holiday_dates=holiday_dates,
        ))
    return records


def month_summary_from_records(records) -> dict:
    """Aggregate totals used by the weekly search table and payroll."""
    present = sum(1 for r in records if r.status == "present")
    half = sum(1 for r in records if r.status == "half_shift" or r.is_half_shift)
    absent = sum(1 for r in records if r.status == "absent")
    leave = sum(1 for r in records if r.status == "on_leave")
    holidays = sum(1 for r in records if r.status == "holiday")
    late = sum(1 for r in records if r.is_late)
    shifts = sum((r.shifts_earned or Decimal("0")) for r in records)
    working_days = len(records) - holidays
    return {
        "totalDays": len(records),
        "workingDays": working_days,
        "present": present,
        "halfShift": half,
        "absent": absent,
        "onLeave": leave,
        "holidays": holidays,
        "late": late,
        "totalShifts": str(shifts),
        # Effective attendance = full presents + 0.5 × halves
        "effectiveDays": str(Decimal(present) + Decimal(half) * Decimal("0.5")),
    }
