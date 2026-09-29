"""
Shift Computation Engine -Staff employees (4-punch day model)
==============================================================
Determines first-half / second-half completion and late status from raw
AttendanceLog punches, then persists results to DailyShiftLog and
MonthlyShiftSummary.

Punch flow:
  punch1 -first IN  of the day            (morning check-in)
  punch2 -first OUT after first_half_end  (going for lunch)
  punch3 -first IN  after punch2          (return from lunch)
  punch4 -last OUT  of the day            (end of day)

Late Detection (judged against the day's EFFECTIVE shift -see attendance_final.py):
  Morning Late-In    = first punch  > effective start + grace   (PayrollSettings.morning_late_in_enabled)
  Evening Early-Out  = last punch   < effective end   - grace   (PayrollSettings.evening_early_out_enabled)
  An approved Morning Late-In / Evening Early-Out permission still inside the
  monthly cap moves that ONE day's effective start / end by 60 minutes; the
  Shift Management times themselves never change.
  Night Late (strict mode only) = punch3 > punch2 + lunch_duration_minutes: a
  separate, informational lunch-return flag that never affects shift value.

Monthly deduction -one shared formula, attendance_final.late_pool_summary:
  pool = Morning Late-In days + Evening Early-Out days
         + approved permissions beyond PayrollSettings.permission_monthly_cap
  (a day that is late AND carries an excess permission on the same edge counts
   once -the excess permission is that occurrence)
  billable = max(0, pool - PayrollSettings.late_free_allowance)
  shift_deductions = payroll_views.late_shift_deduction(billable)  (HR slab table)
  salary_deduction_amount = shift_deductions * daily_rate

Full / Half / Absent is NOT decided here: see Half-Day Detection in
attendance_final.py (identical in Simple and Strict mode).
"""

from datetime import date as date_type, time as time_type, timedelta
from decimal import Decimal

from django.db.models import Q

# Full/Half/Absent rule fix (2026-07-25, user-mandated): a staff day earns a
# Full Shift whenever a first punch AND a distinct last punch both exist AND
# both fall within the shift's punctuality window, replacing the old
# "punch3+punch4 required" (strict) / "half if first punch after 13:30"
# (simple, see attendance_final.py) rules. Originally gated to apply only
# from 2026-07-25 forward, with pre-cutover days frozen under the OLD rule,
# so already-computed DailyShiftLog/AttendanceDayRecord history wouldn't
# silently change when re-read.
#
# Retroactive recompute (2026-07-25, explicit user approval via
# AskUserQuestion after reviewing a pre-cutover day that showed Full Shift
# despite a ~3-hour-late first punch -legacy days had no punctuality check
# at all): pushed back to cover all real attendance history, so every
# AttendanceDayRecord now recomputes under the current rule the next time
# it's read. This does NOT retroactively change any already-generated
# Payroll/SalarySlip record -those are separate frozen rows and were left
# untouched; regenerating them is its own, separately-approved action.
NEW_ATTENDANCE_RULE_CUTOVER = date_type(2000, 1, 1)

def _t2s(t: time_type) -> int:
    """Convert time to seconds-since-midnight."""
    return t.hour * 3600 + t.minute * 60 + t.second


def _s2t(s: int) -> time_type:
    s = max(0, min(s, 86399))
    return time_type(s // 3600, (s % 3600) // 60, s % 60)


def _t2s_minute(t: time_type) -> int:
    """Seconds-since-midnight with the seconds dropped: a punch counts as the minute it was made in.

    Used for every ARRIVAL check against a whole-minute limit (start + grace, the punctuality and
    permission windows, the lunch return). With a 9:10 limit a punch at 9:10:20 is a 9:10 punch, on time;
    the first late minute is 9:11. Same rule as _is_after_half_shift_late_reference. Departure checks
    don't need it: their limits are whole minutes too, so dropping the seconds can't change the answer."""
    return t.hour * 3600 + t.minute * 60


# ── Late Detection: Morning Late-In / Evening Early-Out ─────────────────────
#
# Two simple, independent checks against a shift's own start/end time (or,
# on a day with an approved in-cap Permission, that day's effective boundary
# -see attendance_final.py, which builds the adjusted `shift` object BEFORE
# calling these; neither function here knows or cares whether the shift it
# was given is the real one or a permission-shifted copy). Each is only ever
# consulted when its own PayrollSettings switch (morning_late_in_enabled /
# evening_early_out_enabled) is on -callers check that before calling.
# Replaces the old 4-zone auto-detected chain (_classify_zone/_punctuality_ok)
# for these two axes entirely: there is no more "auto-detected Permission
# zone" here, and lateness never by itself caps a day at Half Shift -see
# attendance_final.py's Half-Day Detection for what does.

def morning_late_in(first_punch: time_type | None, shift, basis: str | None = None) -> tuple[bool, str | None]:
    """(is_late, reason) for the morning arrival edge. Compared at MINUTE
    granularity (a punch counts as its own minute; see _t2s_minute).

    `basis`, when given, is a short plain-language account of how the
    deadline was built ("shift start 08:30 + 10 min grace") appended to the
    reason, so HR can read the rule back to an employee who asks why."""
    if not shift or not first_punch:
        return False, None
    grace_secs = (shift.grace_period_minutes or 0) * 60
    deadline_secs = _t2s(shift.start_time) + grace_secs
    if _t2s_minute(first_punch) > deadline_secs:
        why = f" ({basis})" if basis else ""
        return True, (
            f"Morning Late-In: first punch {first_punch.strftime('%H:%M')} is after the "
            f"deadline {_s2t(deadline_secs).strftime('%H:%M')}{why}"
        )
    return False, None


def evening_early_out(
    last_punch: time_type | None, shift, basis: str | None = None, punch_secs: int | None = None
) -> tuple[bool, str | None]:
    """(is_early_out, reason) for the evening departure edge. `basis` as for morning_late_in.

    `punch_secs` is the punch's position in seconds since the START of the working day. It differs
    from the clock time only for a cross-midnight punch (a 01:00 exit reattributed from the next
    calendar date to this day is 25:00, not 01:00 -read as a bare clock time it would look like an
    early-out at the crack of dawn). Omitted, the clock time is used, exactly as before."""
    if not shift or not last_punch:
        return False, None
    grace_secs = (shift.grace_period_minutes or 0) * 60
    deadline_secs = _t2s(shift.end_time) - grace_secs
    if (punch_secs if punch_secs is not None else _t2s(last_punch)) < deadline_secs:
        why = f" ({basis})" if basis else ""
        return True, (
            f"Evening Early-Out: last punch {last_punch.strftime('%H:%M')} is before the "
            f"deadline {_s2t(deadline_secs).strftime('%H:%M')}{why}"
        )
    return False, None


# ── Zone classification (4-zone chain: on time -> late -> permission -> half shift) ──
# Retained only for the (untouched) strict-mode lunch-return axis below -
# Morning Late-In/Evening Early-Out above no longer use this.
ZONE_ON_TIME = "on_time"
ZONE_LATE = "late"
ZONE_PERMISSION = "permission"
ZONE_HALF_SHIFT = "half_shift"


def _classify_zone(delta_secs: int, grace_secs: int, late_window_secs: int, permission_window_secs: int) -> str:
    """
    Classify how far past a reference point an edge is, in one of 4 zones:
      [0, grace]                                    -> on_time
      (grace, late_window]                          -> late
      (late_window, late_window + permission_window] -> permission (auto-detected)
      > late_window + permission_window             -> half_shift
    `delta_secs` is always >= 0 -the caller clamps the raw (possibly
    negative, i.e. early/on-time) difference before calling this.
    """
    if delta_secs <= grace_secs:
        return ZONE_ON_TIME
    if delta_secs <= late_window_secs:
        return ZONE_LATE
    if delta_secs <= late_window_secs + permission_window_secs:
        return ZONE_PERMISSION
    return ZONE_HALF_SHIFT


def _permission_covers_afternoon(permission_time, return_deadline_secs: int, window_minutes: int) -> bool:
    """
    Strict mode only. Whether an approved EmployeePermission's own time
    covers the lunch-return edge -analogous to _permission_covers_late_in
    but anchored at the lunch-return deadline (punch2 + lunch_duration)
    instead of a fixed shift edge, since the lunch window is a duration.
    """
    if permission_time is None:
        return True
    window_secs = window_minutes * 60
    return return_deadline_secs <= _t2s(permission_time) <= return_deadline_secs + window_secs


# ── Afternoon (Night) Late / lunch-return zone (staff, strict mode) ────────

def _afternoon_late_window_minutes(settings=None) -> int:
    if settings is None:
        from .models import PayrollSettings
        settings = PayrollSettings.get()
    return settings.afternoon_late_window_minutes or 60


def _afternoon_permission_window_minutes(settings=None) -> int:
    if settings is None:
        from .models import PayrollSettings
        settings = PayrollSettings.get()
    return settings.afternoon_permission_window_minutes or 0


# ── Cross-midnight punch reattribution (2026-07-26, user-mandated) ────────
#
# A forgotten evening exit punch is sometimes made hours late, after
# midnight -the biometric device stamps it under the NEXT calendar date,
# which (without this) gets misread as tomorrow's first punch, silently
# shifting every one of tomorrow's real punches down a slot (P1->P2,
# P2->P3, ...) and corrupting tomorrow's whole shift calculation, on top
# of today showing a missing/wrong last-out.
#
# Configurable via PayrollSettings.last_punch_post_shift_grace_hours (how
# far past shift end the grace extends -e.g. 9 hours past a 20:00 end
# reaches 05:00) and first_punch_pre_shift_buffer_hours (a protective cap
# so that grace window can never reach into tomorrow's own pre-shift-start
# buffer, so a genuinely early arrival is never stolen and misattributed
# to yesterday). Either at 0 disables its respective effect;
# last_punch_post_shift_grace_hours=0 disables the whole feature.

def _cross_midnight_claim_cutoff(shift_for_prev_day, shift_for_this_day, settings) -> int | None:
    """
    The latest seconds-since-midnight of THIS day (0-86399) at or before
    which an early punch is claimed as the PREVIOUS day's forgotten
    last-out, instead of counting as this day's own first punch. None
    means the rule doesn't apply here (disabled in Settings, or no
    reference shift for the previous day to anchor "shift end" from).
    """
    if not shift_for_prev_day or not shift_for_prev_day.end_time:
        return None
    grace_hours = settings.last_punch_post_shift_grace_hours
    if not grace_hours or grace_hours <= 0:
        return None
    grace_end_secs = _t2s(shift_for_prev_day.end_time) + int(float(grace_hours) * 3600)
    if shift_for_this_day and shift_for_this_day.start_time:
        buffer_hours = settings.first_punch_pre_shift_buffer_hours or 0
        cap_secs = 86400 + _t2s(shift_for_this_day.start_time) - int(float(buffer_hours) * 3600)
        grace_end_secs = min(grace_end_secs, cap_secs)
    if grace_end_secs <= 86400:
        return None
    return max(0, min(86399, grace_end_secs - 86400))


def _claimed_by_previous_day(punch_time, prev_day_last_punch, shift_for_prev_day, shift_for_this_day, settings) -> bool:
    """
    True iff a punch at `punch_time` on THIS day should be reattributed as
    the PREVIOUS day's last-out rather than counting toward this day's own
    punches. Two conditions must both hold:
      1. `punch_time` is at/before the cutoff from
         _cross_midnight_claim_cutoff.
      2. The previous day doesn't already have a punch at or after its own
         shift end -an already-complete day never has anything stolen
         from a stray next-day punch (which just stays that next day's own).
    """
    cutoff = _cross_midnight_claim_cutoff(shift_for_prev_day, shift_for_this_day, settings)
    if cutoff is None:
        return False
    if _t2s(punch_time) > cutoff:
        return False
    if prev_day_last_punch is not None and _t2s(prev_day_last_punch) >= _t2s(shift_for_prev_day.end_time):
        return False
    return True


def resolve_day_punch_logs(emp, d: date_type, own_day_logs: list, settings, assignments=None, logs_by_date=None) -> list:
    """
    The definitive punch list for (emp, d) once cross-midnight
    reattribution is applied in both directions:
      - EXCLUDES any of this day's own early-morning punches that are
        actually yesterday's forgotten last-out, made late.
      - INCLUDES tomorrow's early-morning punches that are actually
        today's own forgotten last-out.
    Every staff shift-value computation (simple mode via compute_day_record
    and strict mode via compute_daily_shift_log alike) should source its
    punches through this instead of a raw `AttendanceLog.filter(date=d)`
    query. Production employees are unaffected (their segment-coverage
    model doesn't use punch-order logic) -returns `own_day_logs` untouched
    for them.

    `logs_by_date`, when given, is a {date: [AttendanceLog, ...]} map a
    bulk caller (compute_month_records/compute_range_records) already
    fetched once for the employee's whole range, spanning at least one day
    before and one day after the range being computed -this looks up
    `d-1`/`d+1` from it instead of querying. Omitted, both are queried
    directly (cheap: one employee, one day, at most a handful of rows).

    Disabled entirely when PayrollSettings.last_punch_post_shift_grace_hours
    is 0 -returns `own_day_logs` unchanged, matching exact pre-feature
    behavior.
    """
    if emp.employment_type != "staff":
        return own_day_logs
    if not settings.last_punch_post_shift_grace_hours:
        return own_day_logs

    from .models import AttendanceLog
    prev_d = d - timedelta(days=1)
    next_d = d + timedelta(days=1)

    shift_for_prev_d = _get_shift_for_date(emp, prev_d, assignments=assignments)
    shift_for_d = _get_shift_for_date(emp, d, assignments=assignments)
    shift_for_next_d = _get_shift_for_date(emp, next_d, assignments=assignments)

    def _logs_for(date_val):
        if logs_by_date is not None:
            return logs_by_date.get(date_val, [])
        return list(AttendanceLog.objects.filter(employee=emp, date=date_val).order_by("punch_time"))

    # ── Exclude: this day's own early punches actually belong to yesterday ──
    result = own_day_logs
    if shift_for_prev_d and result:
        prev_logs = _logs_for(prev_d)
        prev_last_punch = max((p.punch_time for p in prev_logs), default=None)
        result = [
            p for p in result
            if not _claimed_by_previous_day(p.punch_time, prev_last_punch, shift_for_prev_d, shift_for_d, settings)
        ]

    # ── Claim: tomorrow's early punches actually belong to today ───────────
    if shift_for_d:
        this_day_last_punch = max((p.punch_time for p in result), default=None)
        next_logs = _logs_for(next_d)
        claimed = [
            p for p in next_logs
            if _claimed_by_previous_day(p.punch_time, this_day_last_punch, shift_for_d, shift_for_next_d, settings)
        ]
        if claimed:
            result = result + claimed

    return result


def _get_assignment_for_date(emp, d: date_type, assignments=None):
    """
    Return the active EmployeeShiftAssignment for an employee on a date (or None).

    `assignments`, when given, is this employee's full assignment list
    (any order) prefetched once by the caller -e.g. compute_month_records
    fetching it once per employee instead of once per day. Resolving "which
    assignment covers this date" then happens in Python instead of a fresh
    query, which is what makes a month-wide bulk computation viable.
    """
    if assignments is not None:
        best = None
        for a in assignments:
            if a.effective_from <= d and (a.effective_to is None or a.effective_to >= d):
                if best is None or a.effective_from > best.effective_from:
                    best = a
        return best

    from .models import EmployeeShiftAssignment
    return (
        EmployeeShiftAssignment.objects
        .filter(employee=emp, effective_from__lte=d)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=d))
        .select_related("shift")
        .order_by("-effective_from")
        .first()
    )


def _get_shift_for_date(emp, d: date_type, assignments=None):
    """
    Return the effective ShiftTemplate for an employee on a given date (or None).
    Per-employee custom start/end overrides on the assignment take precedence
    over the template's own times -HR sets these for individual schedules.
    """
    asgn = _get_assignment_for_date(emp, d, assignments=assignments)
    if not asgn:
        return None
    shift = asgn.shift
    if shift and (asgn.custom_start_time or asgn.custom_end_time):
        # Never mutate the shared template row -apply overrides to a detached copy.
        from copy import copy
        shift = copy(shift)
        if asgn.custom_start_time:
            shift.start_time = asgn.custom_start_time
        if asgn.custom_end_time:
            shift.end_time = asgn.custom_end_time
    return shift


def compute_daily_shift_log(emp, d: date_type, punches: list, assignments=None, legacy: bool = False,
                             has_permission: bool = False, permission_time=None, settings=None,
                             shift_override=None, reason_notes: dict | None = None) -> dict:
    """
    Given a list of AttendanceLog objects for (emp, date), compute the
    4-punch shift result and persist it to DailyShiftLog.

    `assignments` lets a bulk caller (compute_month_records) pass in data it
    already fetched/computed once for the whole month, instead of this
    function re-querying per day -see the same parameter on
    _get_shift_for_date. Any other caller (single-day recompute, etc.) can
    omit it and behavior is unchanged: everything is looked up fresh,
    exactly as before.

    `legacy=True` preserves the pre-2026-07-25 full-shift rule (required
    punch3 AND punch4 for a staff day with a configured lunch window) for
    days before NEW_ATTENDANCE_RULE_CUTOVER (year 2000 -unreachable for any
    real attendance date, kept only so history is never silently recomputed
    under a different rule if that constant is ever changed back). Punch1-4
    *identification* (which raw punch fills which role, including the
    lunch-window heuristic for punch2/punch3) is unchanged either way.

    `has_permission`/`permission_time` -this day's approved EmployeePermission,
    if any. Only consulted for the strict-mode lunch-return ("Night Late")
    axis below, which the Late Detection/Permission rewrite left untouched;
    Morning Late-In/Evening Early-Out no longer use these at all -see
    `shift_override`.

    `shift_override`, when given, is used AS the day's shift outright,
    skipping this function's own _get_shift_for_date lookup entirely. The
    caller (attendance_final.py's compute_day_record) is the single place
    that decides the day's EFFECTIVE shift -stacking a Compensation Day's
    `leave_until_time` and/or an in-cap Permission's boundary shift onto a
    copy of the real assigned shift -so both attendance modes judge Late
    Detection against the exact same effective boundary. Omit it (None) to
    use the real assigned shift unmodified.

    Returns the resulting DailyShiftLog instance dict.
    """
    from .models import DailyShiftLog

    shift = shift_override if shift_override is not None else _get_shift_for_date(emp, d, assignments=assignments)

    # Sort punches chronologically by (date, time) rather than bare time —
    # a cross-midnight punch reattributed onto this day (see
    # resolve_day_punch_logs) carries a real .date one day later than `d`
    # and an early-morning .punch_time (e.g. 02:00); sorting by bare time
    # alone would wrongly put it FIRST instead of last.
    sorted_punches = sorted(punches, key=lambda p: (p.date, p.punch_time))

    # Extract the 4 logical punches from raw logs
    punch1 = punch2 = punch3 = punch4 = None

    if shift and shift.shift_type == "staff" and shift.first_half_end:
        fhe_secs = _t2s(shift.first_half_end)
        # Use a ±60-min midday window to locate the lunch departure punch.
        # Biometric devices often record all punches as "IN", so we classify
        # by time position rather than by stored punch_type.
        midday_start = fhe_secs - 60 * 60   # first_half_end − 60 min
        midday_end   = fhe_secs + 60 * 60   # first_half_end + 60 min

        # punch1 = first punch of the day
        if sorted_punches:
            punch1 = sorted_punches[0].punch_time

        # punch2 = first punch inside the midday window that is not punch1
        for p in sorted_punches:
            ps = _t2s(p.punch_time)
            if midday_start <= ps <= midday_end and p.punch_time != punch1:
                punch2 = p.punch_time
                break

        if punch2:
            punch2_secs = _t2s(punch2)
            # punch3 = first punch strictly after punch2
            for p in sorted_punches:
                if _t2s(p.punch_time) > punch2_secs:
                    punch3 = p.punch_time
                    break

        # punch4 = last punch of the day, must differ from punch2
        if sorted_punches:
            last = sorted_punches[-1].punch_time
            punch4 = last if last != punch2 else None

    else:
        # Non-staff or no first_half_end configured:
        # first punch = arrival, last punch = departure (ignore punch_type)
        if sorted_punches:
            punch1 = sorted_punches[0].punch_time
        if len(sorted_punches) > 1:
            punch4 = sorted_punches[-1].punch_time

    # ── Half completion ──────────────────────────────────────────────────────
    first_half = bool(punch1)
    second_half = False

    if legacy and shift and shift.shift_type == "staff" and shift.first_half_end:
        # Pre-cutover rule, frozen for history: second half required a
        # return punch (punch3) AND an end-of-day punch (punch4).
        if punch3 and punch4:
            second_half = True
    else:
        # Current rule (also used for production/no-lunch-window staff even
        # under legacy=True, matching the pre-cutover behavior there too):
        # any distinct last punch of the day completes the second half,
        # regardless of whether the lunch punches (punch2/punch3) exist.
        second_half = bool(punch4)

    shifts_completed = Decimal("0")
    if first_half and second_half:
        shifts_completed = Decimal("1.00")
    elif first_half or second_half:
        shifts_completed = Decimal("0.50")
    # Full/Half/Absent is no longer decided here at all -see
    # attendance_final.py's Half-Day Detection, which overrides status/
    # shifts_earned/is_half_shift on the returned AttendanceDayRecord for
    # BOTH modes uniformly. shifts_completed above is kept only because
    # DailyShiftLog (a separate, lightweight display/debug table -see
    # compute_shift_logs in attendance_views.py) still has the column;
    # nothing in the payroll/attendance engine reads it anymore.

    # ── Late Detection: Morning Late-In / Evening Early-Out ────────────────
    # Same two checks _compute_staff_simple uses (attendance_final.py) -see
    # morning_late_in/evening_early_out above. `shift` here is already the
    # day's fully-resolved EFFECTIVE shift (see `shift_override`), so no
    # further permission handling is needed at this layer.
    from .models import PayrollSettings
    if settings is None:
        settings = PayrollSettings.get()
    late_morning = False
    early_leave = False
    late_reasons = []
    notes = reason_notes or {}
    if settings.morning_late_in_enabled:
        late_morning, reason = morning_late_in(punch1, shift, basis=notes.get("morning"))
        if reason:
            late_reasons.append(reason)
    if settings.evening_early_out_enabled:
        # The day's exit is its LAST punch, provided there is more than one punch -a lone punch says
        # when someone arrived, not when they left, so it can never be an early-out. (punch4 above is
        # the lunch-aware role used for the 4-punch display and is not the same thing: it drops a
        # last punch that is also the lunch-out, and repeats punch1 for a single punch. Simple mode
        # uses exactly this rule, so both modes flag the same days.) A punch reattributed from the
        # next calendar date is measured as seconds past this day's midnight, not as a clock time.
        exit_log = sorted_punches[-1] if len(sorted_punches) > 1 else None
        exit_secs = (
            _t2s(exit_log.punch_time) + 86400 * (exit_log.date - d).days if exit_log is not None else None
        )
        early_leave, reason = evening_early_out(
            exit_log.punch_time if exit_log is not None else None,
            shift,
            basis=notes.get("evening"),
            punch_secs=exit_secs,
        )
        if reason:
            late_reasons.append(reason)

    # ── Night Late / lunch-return zone (strict mode only) ──────────────────
    # A different, untouched axis -see PayrollSettings.afternoon_late_window_
    # minutes/afternoon_permission_window_minutes. No longer able to demote
    # the day to Half Shift (nothing does that anymore except the fixed
    # Half-Day rule) -purely a display/audit flag now.
    late_afternoon = False
    late_return = False  # kept for DailyShiftLog backward-compat; mirrors late_afternoon
    permission_afternoon = permission_afternoon_with_request = False

    if shift and punch2 and punch3:
        afternoon_late_window_min = _afternoon_late_window_minutes(settings=settings)
        afternoon_permission_window_min = _afternoon_permission_window_minutes(settings=settings)
        lunch_dur_secs = (shift.lunch_duration_minutes or 60) * 60
        return_deadline_secs = _t2s_minute(punch2) + lunch_dur_secs
        delta = max(0, _t2s_minute(punch3) - return_deadline_secs)
        zone = _classify_zone(delta, 0, afternoon_late_window_min * 60, afternoon_permission_window_min * 60)
        deadline_t = _s2t(return_deadline_secs)
        if zone in (ZONE_LATE, ZONE_HALF_SHIFT):
            late_afternoon = True
            late_return = True
            late_reasons.append(
                f"Night Late: left {punch2.strftime('%H:%M')}, "
                f"returned {punch3.strftime('%H:%M')}, deadline {deadline_t.strftime('%H:%M')}"
            )
        elif zone == ZONE_PERMISSION:
            permission_afternoon = True
            permission_afternoon_with_request = bool(has_permission and _permission_covers_afternoon(
                permission_time, return_deadline_secs, afternoon_late_window_min + afternoon_permission_window_min,
            ))
            tag = "With Permission" if permission_afternoon_with_request else "Without Permission"
            late_reasons.append(f"Permission (afternoon, {tag}): returned {punch3.strftime('%H:%M')}")

    late_reason = "; ".join(late_reasons) if late_reasons else None

    # ── Persist ──────────────────────────────────────────────────────────────
    log, _ = DailyShiftLog.objects.update_or_create(
        employee=emp,
        date=d,
        defaults={
            "shift": shift,
            "punch1": punch1,
            "punch2": punch2,
            "punch3": punch3,
            "punch4": punch4,
            "total_punches": len(punches),
            "first_half": first_half,
            "second_half": second_half,
            "shifts_completed": shifts_completed,
            "late_morning": late_morning,
            "late_return": late_return,
            "late_reason": late_reason,
        },
    )
    # Not persisted on DailyShiftLog (a strict-mode-only internal detail
    # table) -attached as plain attributes purely so _compute_staff_strict
    # can read them without a schema change to a table with only one caller.
    log.early_leave = early_leave
    log.late_afternoon = late_afternoon
    log.permission_afternoon = permission_afternoon
    log.permission_afternoon_with_request = permission_afternoon_with_request
    return log


def compute_monthly_shift_summary(emp, year: int, month: int, daily_rate: Decimal = None, records=None,
                                  counted_dates=None):
    """
    Aggregate one employee's month into a MonthlyShiftSummary row (read by
    the mobile/web "My Shift" screens). Shares the EXACT SAME combined-pool
    formula as payroll_views._generate_staff_payroll's late-penalty block,
    reading AttendanceDayRecord (via attendance_final.compute_month_records)
    rather than the strict-mode-only DailyShiftLog table this used to read
    -before this, this function had its own separately-hardcoded formula
    that only ever reflected strict-mode data and a fixed 3-free/quarter-
    shift rule, silently diverging from whatever HR had actually configured
    in Settings → Late Detection. Now there is exactly one formula.

    `records`, when given (the payroll engine already has them), skips a
    second compute_month_records call for the same employee/month.
    `counted_dates` restricts which days may contribute an occurrence (payroll
    passes its working days) -see attendance_final.late_pool_summary.
    """
    from .models import MonthlyShiftSummary, EmployeePermission, PayrollSettings
    from .attendance_final import compute_month_records, late_pool_summary
    from .payroll_views import late_shift_deduction

    settings = PayrollSettings.get()
    if records is None:
        records = compute_month_records(emp, year, month, settings)

    total_shifts = sum((r.shifts_earned or Decimal("0")) for r in records) or Decimal("0")

    # ONE shared formula for the whole system (payroll, this summary, the employee shift-stats
    # screen): morning late-ins + evening early-outs + approved permissions beyond the monthly
    # cap -see attendance_final.late_pool_summary.
    approved_permissions = EmployeePermission.objects.filter(
        employee=emp, date__year=year, date__month=month, status="approved",
    ).count()
    pool = late_pool_summary(records, approved_permissions, settings, counted_dates=counted_dates)
    late_in_count = pool["late_in"]
    early_out_count = pool["early_out"]
    excess_permissions = pool["excess_permissions"]
    permissions_used = pool["free_used"]
    billable_late = pool["billable"]
    shift_deductions = late_shift_deduction(billable_late, settings)

    salary_deduction = Decimal("0")
    if daily_rate and shift_deductions > 0:
        salary_deduction = (shift_deductions * daily_rate).quantize(Decimal("0.01"))

    summary, _ = MonthlyShiftSummary.objects.update_or_create(
        employee=emp,
        year=year,
        month=month,
        defaults={
            "total_shifts": total_shifts,
            "total_late_count": late_in_count + early_out_count,
            "permission_overage_count": excess_permissions,
            "permissions_used": permissions_used,
            "billable_late_count": billable_late,
            "shift_deductions": shift_deductions,
            "salary_deduction_amount": salary_deduction,
        },
    )
    return summary


def recompute_date(d: date_type):
    """
    Recompute DailyShiftLog for ALL staff employees for a given date.
    Called after biometric sync or manual attendance entry.
    """
    from .models import AttendanceLog, Employee, PayrollSettings
    from collections import defaultdict

    # +/-1 day padding so cross-midnight punch reattribution
    # (resolve_day_punch_logs) has the neighboring days' punches to check —
    # a forgotten evening exit punch made after midnight lands under d+1's
    # date, and needs to be pulled back into d's computation here too, not
    # just in the AttendanceDayRecord path (compute_day_record).
    padded_logs = list(
        AttendanceLog.objects.filter(
            date__gte=d - timedelta(days=1), date__lte=d + timedelta(days=1),
        ).select_related("employee")
    )
    logs_by_emp: dict = defaultdict(lambda: defaultdict(list))
    for log in padded_logs:
        logs_by_emp[log.employee_id][log.date].append(log)

    staff_ids = set(
        Employee.objects.filter(status="active", employment_type="staff")
        .values_list("id", flat=True)
    )

    # Only process employees who have punches today (staff only)
    emp_ids_with_punches = {
        emp_id for emp_id, by_date in logs_by_emp.items() if by_date.get(d)
    } & staff_ids
    if not emp_ids_with_punches:
        return 0

    emps = {e.id: e for e in Employee.objects.filter(id__in=emp_ids_with_punches)}
    settings = PayrollSettings.get()
    count = 0
    for emp_id in emp_ids_with_punches:
        emp = emps.get(emp_id)
        if not emp:
            continue
        emp_logs_by_date = logs_by_emp.get(emp_id, {})
        punches = resolve_day_punch_logs(
            emp, d, emp_logs_by_date.get(d, []), settings,
            logs_by_date=emp_logs_by_date,
        )
        compute_daily_shift_log(emp, d, punches, legacy=d < NEW_ATTENDANCE_RULE_CUTOVER)
        count += 1
    return count
