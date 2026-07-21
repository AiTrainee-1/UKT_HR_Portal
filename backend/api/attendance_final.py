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
from datetime import date as date_type, datetime, timedelta
from decimal import Decimal

from django.db.models import Q

from .models import (
    AttendanceDayRecord, AttendanceLog, Attendance, Employee, Holiday,
    LeaveRequest, PayrollSettings, ProductionShiftConfig, ProductionShiftSegment,
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

    # Late: morning punch beyond shift start + grace — both values come solely
    # from the employee's assigned ShiftTemplate (Shift Management). There is
    # no Settings-level default: without an assigned shift there is no basis
    # for late detection, so the day is simply never flagged late.
    is_late = False
    early_leave = False
    if shift:
        grace = (shift.grace_period_minutes if shift.grace_period_minutes is not None else 0) * 60
        if _t2s(first) > _t2s(shift.start_time) + grace:
            is_late = True
        if last and _t2s(last) < _t2s(shift.end_time):
            early_leave = True

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

def _compute_staff_strict(emp, d, punch_logs, punch_times, assignments=None, relaxation=None):
    from .shift_engine import compute_daily_shift_log
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}
    log = compute_daily_shift_log(emp, d, punch_logs, assignments=assignments, relaxation=relaxation)
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


# ── Production: dynamic shift-segment day ───────────────────────────────────
#
# Default 4-punch day (8:30 arrival / 12:45 lunch-out / 13:30 lunch-return /
# 20:00 departure) is scored against an ordered list of ProductionShiftSegment
# rows. Each segment is credited when a continuous worked span covers it
# (within the configured grace). With 4 punches the day splits into a morning
# span and an afternoon span; with any other punch count a single first→last
# span is used instead, so a bare arrival+departure without a lunch punch
# still earns credit for every segment it fully covers.

def _as_time(v):
    """TimeField defaults may still be raw strings on a freshly-created row
    (before the next DB round-trip parses them) — normalize defensively."""
    if isinstance(v, str):
        return datetime.strptime(v[:5], "%H:%M").time()
    return v


def _production_spans(punch_times):
    if len(punch_times) >= 4:
        return [(punch_times[0], punch_times[1]), (punch_times[2], punch_times[3])]
    if len(punch_times) >= 2:
        return [(punch_times[0], punch_times[-1])]
    return []


def _compute_production(emp, d, punch_times, settings, config=None, segments=None):
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}

    if config is None:
        config = ProductionShiftConfig.get()
    if segments is None:
        segments = list(ProductionShiftSegment.objects.filter(is_active=True))

    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else None

    spans = _production_spans(punch_times)
    grace = (config.grace_minutes or 10) * 60

    def covered(seg) -> bool:
        # Arrival may be up to `grace` late, departure up to `grace` early,
        # and the segment is still credited in full.
        latest_ok_start = _t2s(_as_time(seg.start_time)) + grace
        earliest_ok_end = _t2s(_as_time(seg.end_time)) - grace
        return any(_t2s(s) <= latest_ok_start and _t2s(e) >= earliest_ok_end for s, e in spans)

    shifts = Decimal("0")
    for seg in segments:
        if covered(seg):
            shifts += Decimal(str(seg.shift_value))

    max_possible = sum((Decimal(str(s.shift_value)) for s in segments), Decimal("0"))
    if max_possible <= 0:
        max_possible = Decimal("1.50")
    if shifts == 0 and spans:
        # Punched in/out but matched no configured segment window → minimal credit for showing up
        shifts = Decimal("0.25")
    shifts = min(shifts, max_possible)

    is_late = _t2s(first) > _t2s(_as_time(config.punch1_time)) + grace
    early_leave = last is not None and _t2s(last) < _t2s(_as_time(config.punch4_time)) - grace
    is_half = shifts <= (max_possible / 2)

    return {
        "status": "half_shift" if is_half else "present",
        "is_late": is_late,
        "is_half_shift": is_half,
        "early_leave": early_leave,
        "shifts_earned": shifts,
        "first_punch": first,
        "last_punch": last,
    }


# ── Main entry: compute (or keep) the final record for one day ─────────────

def compute_day_record(emp, d: date_type, punch_logs=None, settings=None,
                       leave_dates=None, holiday_dates=None,
                       prod_config=None, prod_segments=None, prefetch=None):
    """
    Compute and persist the AttendanceDayRecord for (emp, d).
    Manual overrides are preserved — returns the existing row untouched.

    `prefetch`, when given, is a dict of data a bulk caller (compute_month_records)
    already fetched once for this employee's whole month instead of this
    function re-querying per day — this is what makes computing every
    employee's month (Report Log summary, payroll generation) fast instead
    of an O(employees × days) query storm. Recognized keys, all optional:
      assignments            — this employee's EmployeeShiftAssignment list
      existing_day_records    — {date: AttendanceDayRecord}
      manual_attendance_dates — set of date objects with a manual present row
      night_logs_by_date      — {date: [AttendanceLog, ...]} spanning one day
                                 before the month through the month's end
      night_rules             — active NightShiftRule list
      existing_relaxations    — {date: NightShiftRelaxation} by relaxation_date
    Omitted (the default), every one of these is looked up fresh exactly as
    before — every other caller is unaffected.
    """
    prefetch = prefetch or {}
    assignments = prefetch.get("assignments")

    existing_day_records = prefetch.get("existing_day_records")
    if existing_day_records is not None:
        existing = existing_day_records.get(d)
    else:
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

    # ── Night Shift Relaxation ──────────────────────────────────────────
    # If the employee worked late last night they may report late today
    # without Late / Half-Shift penalties. Also, early-morning punches that
    # are actually last night's checkout must not count as today's arrival.
    from .night_shift import get_relaxation_for, record_report, MORNING_CUTOFF
    relaxation = get_relaxation_for(
        emp, d,
        assignments=assignments,
        logs_by_date=prefetch.get("night_logs_by_date"),
        rules=prefetch.get("night_rules"),
        existing_relaxations=prefetch.get("existing_relaxations"),
    ) if punch_times else None
    if relaxation and relaxation.crossed_midnight:
        day_times = [t for t in punch_times if t > MORNING_CUTOFF]
        punch_logs = [p for p in punch_logs if p.punch_time > MORNING_CUTOFF]
    else:
        day_times = punch_times

    # Manual attendance entries (Attendance table) count as presence too
    manual_attendance_dates = prefetch.get("manual_attendance_dates")
    if manual_attendance_dates is not None:
        has_manual = d in manual_attendance_dates
    else:
        has_manual = Attendance.objects.filter(
            employee=emp, date=d.isoformat(), present=True
        ).exists()

    on_leave = (d in leave_dates) if leave_dates is not None else False
    is_holiday = (d in holiday_dates) if holiday_dates is not None else False

    fields = {
        "is_late": False, "is_half_shift": False, "early_leave": False,
        "first_punch": None, "last_punch": None,
    }

    is_production = emp.employment_type == "production"

    if day_times or has_manual:
        if not day_times and has_manual:
            computed = {"status": "present", "shifts_earned": Decimal("1.00")}
        elif is_production:
            computed = _compute_production(emp, d, day_times, settings, prod_config, prod_segments)
        elif settings.attendance_mode == "simple":
            shift = _get_shift_for_date(emp, d, assignments=assignments)
            computed = _compute_staff_simple(emp, d, day_times, settings, shift)
        else:
            computed = _compute_staff_strict(emp, d, punch_logs, day_times, assignments=assignments, relaxation=relaxation)
    elif punch_times and relaxation and relaxation.crossed_midnight:
        # Only last night's checkout punches exist so far today — the employee
        # has not yet reported for the new day. Not absent; still within the
        # relaxation window (or simply not arrived yet).
        computed = {"status": "absent", "shifts_earned": Decimal("0")}
    elif is_production:
        # Production employees have no leave/CL and work Sundays as a normal
        # day — only an explicit company Holiday exempts them; otherwise a
        # day with zero punches is simply Absent.
        if is_holiday:
            computed = {"status": "holiday", "shifts_earned": Decimal("0")}
        else:
            computed = {"status": "absent", "shifts_earned": Decimal("0")}
    elif on_leave:
        computed = {"status": "on_leave", "shifts_earned": Decimal("0")}
    elif is_holiday or _sunday(d):
        computed = {"status": "holiday", "shifts_earned": Decimal("0")}
    else:
        computed = {"status": "absent", "shifts_earned": Decimal("0")}

    fields.update(computed)

    # Apply the relaxation: arriving within the allowed window is never Late,
    # and a half-shift caused purely by the late arrival becomes a full shift
    # once the day is completed (a distinct evening punch exists).
    if relaxation and day_times:
        first_day_punch = day_times[0]
        record_report(relaxation, first_day_punch)
        if first_day_punch <= relaxation.allowed_until:
            fields["is_late"] = False
            if fields.get("status") == "half_shift" and len(day_times) > 1:
                fields["status"] = "present"
                fields["is_half_shift"] = False
                fields["shifts_earned"] = Decimal("1.00")
    fields["total_punches"] = len(punch_times)
    fields["computed_mode"] = (
        "production" if emp.employment_type == "production" else settings.attendance_mode
    )
    fields["source"] = "auto"
    # Normalize to the field's actual DB precision (2 decimal places) so a
    # freshly computed value (e.g. the literal Decimal("0")) compares equal
    # in *representation*, not just value, to one read back from the DB —
    # otherwise the skip-write check below would never fire for zero-shift
    # days, since Decimal("0") == Decimal("0.00") but str() differs.
    fields["shifts_earned"] = Decimal(fields["shifts_earned"]).quantize(Decimal("0.01"))

    # Skip the write entirely when the freshly computed values match what's
    # already persisted — a day's outcome rarely changes once computed, and
    # this turns the common "nothing changed since last time" case (bulk
    # month-wide reads) into zero write queries instead of one per day.
    if existing is not None and all(getattr(existing, k) == v for k, v in fields.items()):
        return existing

    record, _ = AttendanceDayRecord.objects.update_or_create(
        employee=emp, date=d, defaults=fields,
    )
    return record


def compute_month_records(emp, year: int, month: int, settings=None):
    """
    Compute final records for every elapsed day of the month. Returns list.

    Everything compute_day_record() would otherwise look up one day at a
    time (existing AttendanceDayRecord, manual Attendance rows, the
    employee's shift assignment(s), night-shift rules/relaxation state) is
    fetched here ONCE for the whole month and handed down via `prefetch`.
    Calling this per employee across a full roster (Report Log summary,
    Payroll generation) would otherwise be an O(employees × days) query
    storm — this keeps each employee's month to a small, fixed number of
    queries regardless of how many days are in it.
    """
    if settings is None:
        settings = PayrollSettings.get()

    days_in_month = calendar.monthrange(year, month)[1]
    today = date_type.today()
    month_start = date_type(year, month, 1)
    month_end = date_type(year, month, days_in_month)

    # One day before the month too — night-shift detection for day 1 needs
    # the previous night's (last day of the prior month) punches.
    logs = AttendanceLog.objects.filter(
        employee=emp, date__gte=month_start - timedelta(days=1), date__lte=month_end,
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    leave_dates = _leave_dates_for_month(emp, year, month)
    holiday_dates = _holiday_dates_for_month(year, month)

    prod_config = ProductionShiftConfig.get() if emp.employment_type == "production" else None
    prod_segments = (
        list(ProductionShiftSegment.objects.filter(is_active=True))
        if emp.employment_type == "production" else None
    )

    from .models import EmployeeShiftAssignment, NightShiftRelaxation, NightShiftRule
    from .night_shift import ensure_default_rules

    assignments = list(
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=month_end)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=month_start - timedelta(days=1)))
        .select_related("shift")
    )
    existing_day_records = {
        r.date: r for r in AttendanceDayRecord.objects.filter(
            employee=emp, date__gte=month_start, date__lte=month_end,
        )
    }
    manual_attendance_dates = {
        date_type.fromisoformat(str(dt)[:10])
        for dt in Attendance.objects.filter(
            employee=emp, date__gte=month_start.isoformat(), date__lte=month_end.isoformat(),
            present=True,
        ).values_list("date", flat=True)
    }
    ensure_default_rules()
    night_rules = list(NightShiftRule.objects.filter(is_active=True))
    existing_relaxations = {
        r.relaxation_date: r for r in NightShiftRelaxation.objects.filter(
            employee=emp, relaxation_date__gte=month_start, relaxation_date__lte=month_end,
        )
    }
    prefetch = {
        "assignments": assignments,
        "existing_day_records": existing_day_records,
        "manual_attendance_dates": manual_attendance_dates,
        "night_logs_by_date": logs_by_date,
        "night_rules": night_rules,
        "existing_relaxations": existing_relaxations,
    }

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
            prod_config=prod_config,
            prod_segments=prod_segments,
            prefetch=prefetch,
        ))
    return records


def compute_range_records(emp, date_from: date_type, date_to: date_type, settings=None):
    """Compute final records for every day in [date_from, date_to] (inclusive)."""
    if settings is None:
        settings = PayrollSettings.get()

    today = date_type.today()
    logs = AttendanceLog.objects.filter(
        employee=emp, date__gte=date_from, date__lte=date_to
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    months = {(d.year, d.month) for d in (date_from, date_to)}
    leave_dates, holiday_dates = set(), set()
    for y, m in months:
        leave_dates |= _leave_dates_for_month(emp, y, m)
        holiday_dates |= _holiday_dates_for_month(y, m)

    prod_config = ProductionShiftConfig.get() if emp.employment_type == "production" else None
    prod_segments = (
        list(ProductionShiftSegment.objects.filter(is_active=True))
        if emp.employment_type == "production" else None
    )

    records = []
    d = date_from
    while d <= date_to:
        if d > today:
            break
        records.append(compute_day_record(
            emp, d,
            punch_logs=logs_by_date.get(d, []),
            settings=settings,
            leave_dates=leave_dates,
            holiday_dates=holiday_dates,
            prod_config=prod_config,
            prod_segments=prod_segments,
        ))
        d += timedelta(days=1)
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
