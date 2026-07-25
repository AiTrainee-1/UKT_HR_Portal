"""
Shift Computation Engine — Staff employees (4-punch day model)
==============================================================
Determines first-half / second-half completion and late status from raw
AttendanceLog punches, then persists results to DailyShiftLog and
MonthlyShiftSummary.

Punch flow:
  punch1 — first IN  of the day            (morning check-in)
  punch2 — first OUT after first_half_end  (going for lunch)
  punch3 — first IN  after punch2          (return from lunch)
  punch4 — last OUT  of the day            (end of day)

Late rules:
  late_morning  = punch1_time > shift.start_time + grace_period_minutes
  late_return   = punch3_time > punch2_time + lunch_duration_minutes
  (lunch_grace_minutes = how many extra minutes after first_half_end they
   are allowed to leave — extends the window in which punch2 is valid)

Monthly deduction:
  late_punch_count = sum of (late_morning + late_return) across all days
  approved_permissions = count of approved EmployeePermission requests this month
  total_late = late_punch_count + approved_permissions   (merged pool — every
               approved permission counts as a late entry here, on equal
               footing with a late punch)
  free_permissions = 3 per month (ONE shared allowance across the merged pool —
               NOT 3 free late punches plus a separate 3 free permissions)
  billable_late = max(0, total_late - 3)
  shift_deductions = floor(billable_late / 3) * 0.25
  salary_deduction_amount = shift_deductions * daily_rate
  permission_overage_count (stored, display-only) = max(0, approved_permissions - 3)
               — shown to HR as "excess permissions" context, not used in the
               billable_late math above (which uses the raw approved_permissions
               count merged with late_punch_count before the single 3-free cut)

Note: employees may still SUBMIT more than 3 permission requests per month
(the old hard submission cap was removed) — only the deduction math treats
the 4th-and-beyond approved one as a late entry.
"""

import calendar
from datetime import date as date_type, datetime, time as time_type, timedelta
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
# despite a ~3-hour-late first punch — legacy days had no punctuality check
# at all): pushed back to cover all real attendance history, so every
# AttendanceDayRecord now recomputes under the current rule the next time
# it's read. This does NOT retroactively change any already-generated
# Payroll/SalarySlip record — those are separate frozen rows and were left
# untouched; regenerating them is its own, separately-approved action.
NEW_ATTENDANCE_RULE_CUTOVER = date_type(2000, 1, 1)


def _t2s(t: time_type) -> int:
    """Convert time to seconds-since-midnight."""
    return t.hour * 3600 + t.minute * 60 + t.second


def _s2t(s: int) -> time_type:
    s = max(0, min(s, 86399))
    return time_type(s // 3600, (s % 3600) // 60, s % 60)


def _punctuality_window_minutes(shift) -> int:
    """
    How many minutes of lateness/early-leave a first/last punch gets before
    it caps the day at Half Shift — see _punctuality_ok.

    2026-07-25(d), user-mandated correction: this is a single universal
    threshold — PayrollSettings.shift_punctuality_window_minutes (default
    60, the "maximum first punch allowed" setting) — applied to every
    employee on every day, never conditioned on an approved
    EmployeePermission. An earlier pass, 2026-07-25(c), gated this window
    behind Permission approval, shrinking it to the shift's own tiny
    grace_period_minutes without one; the user clarified that was a
    misreading of their own instruction and reverted it. The shift's own
    grace_period_minutes still separately governs the is_late FLAG (see
    compute_daily_shift_log's late-detection block below) — a punch inside
    this wider window but past that small grace is Late but still a Full
    Shift; only a punch past this window caps the day at Half Shift.
    """
    from .models import PayrollSettings
    return PayrollSettings.get().shift_punctuality_window_minutes or 60


def _punctuality_ok(punch1, punch4, shift, window_minutes: int) -> bool:
    """
    True iff the first punch is within `window_minutes` of the shift's
    start time, and (when a distinct last punch exists) the last punch is
    within the same window of the shift's end time — a first+last punch
    PAIR existing isn't enough for Full Shift on its own; both ends must
    also land near the assigned shift's actual boundaries. `window_minutes`
    comes from _punctuality_window_minutes — a single universal setting,
    the same for every employee. Without a configured shift there's no
    reference to validate against, so this is vacuously True — the punch-presence-only
    rule is all that applies in that case (matches the existing "no shift,
    no basis for lateness" convention used for is_late elsewhere).

    AGREED RULE (2026-07-25, staff shift with start S / end E, lunch fixed
    13:30-14:30, confirmed correct against a 14/14 boundary test — 11am,
    noon, 1:30pm, and an afternoon-only start all verified Half Shift):
      1. First punch in [S, S+window_minutes] -> still Full-Shift-eligible
         (pending the last punch too). Past the shift's own tiny
         grace_period_minutes it's flagged Late, but Late alone never
         demotes the shift value — see the late-detection block below.
      2. First punch after S+window_minutes but before 13:30 -> capped at
         Half Shift, no matter what else happens that day (even a
         perfectly-formed last punch, even a full P1+P2+P3+P4 combo) —
         they missed too much of the morning for it to ever become Full.
      3. First punch at/after 13:30 (no morning attendance at all) -> same
         outcome, Half Shift — treated as an afternoon-only day.
      4. Full Shift only happens when case 1 holds for the first punch AND
         the last punch correctly lands near the shift end — the P1+P2+P3+P4
         / P1+P2+P4 / P1+P3+P4 / P1+P4 combinations (P2/P3, the lunch
         out/in punches, can be missing — people forget to punch for lunch).
    Cases 2 and 3 are not two different rules — they're the same "past the
    window" outcome at different points on the clock, which is exactly why
    a single window check against S (below) is sufficient to implement all
    three cases without a separate 13:30 branch.
    """
    if not shift or not punch1:
        return True
    window_secs = window_minutes * 60
    if _t2s(punch1) > _t2s(shift.start_time) + window_secs:
        return False
    if punch4 and _t2s(punch4) < _t2s(shift.end_time) - window_secs:
        return False
    return True


def _get_assignment_for_date(emp, d: date_type, assignments=None):
    """
    Return the active EmployeeShiftAssignment for an employee on a date (or None).

    `assignments`, when given, is this employee's full assignment list
    (any order) prefetched once by the caller — e.g. compute_month_records
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
    over the template's own times — HR sets these for individual schedules.
    """
    asgn = _get_assignment_for_date(emp, d, assignments=assignments)
    if not asgn:
        return None
    shift = asgn.shift
    if shift and (asgn.custom_start_time or asgn.custom_end_time):
        # Never mutate the shared template row — apply overrides to a detached copy.
        from copy import copy
        shift = copy(shift)
        if asgn.custom_start_time:
            shift.start_time = asgn.custom_start_time
        if asgn.custom_end_time:
            shift.end_time = asgn.custom_end_time
    return shift


_UNSET = object()


def compute_daily_shift_log(emp, d: date_type, punches: list, assignments=None, relaxation=_UNSET, legacy: bool = False) -> dict:
    """
    Given a list of AttendanceLog objects for (emp, date), compute the
    4-punch shift result and persist it to DailyShiftLog.

    `assignments` and `relaxation` let a bulk caller (compute_month_records)
    pass in data it already fetched/computed once for the whole month,
    instead of this function re-querying per day — see the same parameters
    on _get_shift_for_date / night_shift.get_relaxation_for. Any other
    caller (single-day recompute, etc.) can omit them and behavior is
    unchanged: everything is looked up fresh, exactly as before.

    `legacy=True` preserves the pre-2026-07-25 full-shift rule (required
    punch3 AND punch4 for a staff day with a configured lunch window) for
    days before the cutover, so already-computed/paid history never changes
    when re-read. `legacy=False` (the default, used for `d >=` the cutover)
    is the current rule: Full Shift whenever a first punch AND a distinct
    last punch both exist that day AND both fall within the punctuality
    window of the assigned shift's start/end time (see _punctuality_ok) —
    otherwise the day is capped at Half Shift regardless of the middle two
    punches. That window is a single universal threshold — see
    _punctuality_window_minutes — applied the same way to every employee;
    it is NOT conditioned on an approved EmployeePermission (a prior pass
    gated it that way and the user reverted it, see that function's
    docstring). See NEW_ATTENDANCE_RULE_CUTOVER in attendance_final.py for
    the exact cutover date and rationale. Punch1-4 *identification* (which raw punch
    fills which role, including the lunch-window heuristic for
    punch2/punch3) is unchanged either way.

    Returns the resulting DailyShiftLog instance dict.
    """
    from .models import DailyShiftLog

    shift = _get_shift_for_date(emp, d, assignments=assignments)

    # Sort punches by time
    sorted_punches = sorted(punches, key=lambda p: p.punch_time)

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

    # ── Shift punctuality window (current rule only) ─────────────────────────
    # A first+last punch pair isn't enough on its own for Full Shift — both
    # also need to land within the punctuality window (a single universal
    # threshold — see _punctuality_window_minutes, not permission-gated) of
    # the assigned shift's actual start/end time, or the day is capped at
    # Half Shift. Never reduces an already-half or already-absent day
    # further, and frozen out entirely under legacy=True so history never
    # changes.
    if not legacy and shifts_completed == Decimal("1.00"):
        window_minutes = _punctuality_window_minutes(shift)
        if not _punctuality_ok(punch1, punch4, shift, window_minutes):
            shifts_completed = Decimal("0.50")

    # ── Late detection ───────────────────────────────────────────────────────
    late_morning = False
    late_return = False
    late_reasons = []

    if shift and punch1:
        grace_secs = (shift.grace_period_minutes or 0) * 60
        shift_start_secs = _t2s(shift.start_time)
        deadline_secs = shift_start_secs + grace_secs
        if _t2s(punch1) > deadline_secs:
            late_morning = True
            expected = _s2t(deadline_secs)
            late_reasons.append(
                f"Late morning: arrived {punch1.strftime('%H:%M')}, "
                f"deadline {expected.strftime('%H:%M')}"
            )

    if shift and punch2 and punch3:
        lunch_dur_secs = (shift.lunch_duration_minutes or 60) * 60
        return_deadline_secs = _t2s(punch2) + lunch_dur_secs
        if _t2s(punch3) > return_deadline_secs:
            late_return = True
            deadline_t = _s2t(return_deadline_secs)
            late_reasons.append(
                f"Late lunch return: left {punch2.strftime('%H:%M')}, "
                f"returned {punch3.strftime('%H:%M')}, "
                f"deadline {deadline_t.strftime('%H:%M')}"
            )

    late_reason = "; ".join(late_reasons) if late_reasons else None

    # ── Night Shift Relaxation ───────────────────────────────────────────────
    # Worked late last night → allowed to arrive late today without penalty,
    # and the day still counts as a full shift once completed.
    if relaxation is _UNSET:
        try:
            from .night_shift import get_relaxation_for
            relaxation = get_relaxation_for(emp, d) if punch1 else None
        except Exception:
            relaxation = None
    elif not punch1:
        relaxation = None
    if relaxation and punch1 and punch1 <= relaxation.allowed_until:
        if late_morning:
            late_morning = False
            late_reason = (
                f"Night-shift relaxation: worked until "
                f"{relaxation.last_punch_out.strftime('%H:%M')} — allowed until "
                f"{relaxation.allowed_until.strftime('%H:%M')}"
            )
        # A half day caused purely by the late start becomes full once the
        # employee has a distinct end-of-day punch.
        if shifts_completed == Decimal("0.50") and punch4 and punch4 != punch1:
            first_half = True
            second_half = True
            shifts_completed = Decimal("1.00")

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
    return log


def compute_monthly_shift_summary(emp, year: int, month: int, daily_rate: Decimal = None):
    """
    Aggregate all DailyShiftLog entries for (emp, year, month) into a
    MonthlyShiftSummary row.  Applies the 3-free-permission rule and
    computes salary_deduction_amount if daily_rate is supplied.
    Returns the MonthlyShiftSummary instance.
    """
    from .models import DailyShiftLog, MonthlyShiftSummary, EmployeePermission

    logs = DailyShiftLog.objects.filter(
        employee=emp, date__year=year, date__month=month
    )

    total_shifts = sum(l.shifts_completed for l in logs) or Decimal("0")
    late_punch_count = sum(
        (1 if l.late_morning else 0) + (1 if l.late_return else 0)
        for l in logs
    )

    # All approved permission requests this month are merged into the same
    # late-entry pool as late punches — ONE shared 3-free allowance covers
    # the combined raw total (not a separate 3-free for permissions, which
    # would double-discount). permission_overage below is display-only, so
    # HR can see how many permissions pushed past the free-3 mark.
    approved_permissions = EmployeePermission.objects.filter(
        employee=emp, date__year=year, date__month=month, status="approved",
    ).count()
    permission_overage = max(0, approved_permissions - 3)

    total_late = late_punch_count + approved_permissions

    free_permissions = 3
    permissions_used = min(total_late, free_permissions)
    billable_late = max(0, total_late - free_permissions)
    shift_deductions = Decimal(str(billable_late // 3)) * Decimal("0.25")

    salary_deduction = Decimal("0")
    if daily_rate and shift_deductions > 0:
        salary_deduction = (shift_deductions * daily_rate).quantize(Decimal("0.01"))

    summary, _ = MonthlyShiftSummary.objects.update_or_create(
        employee=emp,
        year=year,
        month=month,
        defaults={
            "total_shifts": total_shifts,
            "total_late_count": late_punch_count,
            "permission_overage_count": permission_overage,
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
    from .models import AttendanceLog, Employee
    from collections import defaultdict

    logs = list(
        AttendanceLog.objects.filter(date=d).select_related("employee")
    )
    by_emp: dict = defaultdict(list)
    for log in logs:
        by_emp[log.employee_id].append(log)

    staff_ids = set(
        Employee.objects.filter(status="active", employment_type="staff")
        .values_list("id", flat=True)
    )

    # Only process employees who have punches today (staff only)
    emp_ids_with_punches = set(by_emp.keys()) & staff_ids
    if not emp_ids_with_punches:
        return 0

    emps = {e.id: e for e in Employee.objects.filter(id__in=emp_ids_with_punches)}
    count = 0
    for emp_id, punches in by_emp.items():
        if emp_id not in staff_ids:
            continue
        emp = emps.get(emp_id)
        if emp:
            compute_daily_shift_log(emp, d, punches, legacy=d < NEW_ATTENDANCE_RULE_CUTOVER)
            count += 1
    return count
