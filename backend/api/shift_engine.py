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


def _t2s(t: time_type) -> int:
    """Convert time to seconds-since-midnight."""
    return t.hour * 3600 + t.minute * 60 + t.second


def _s2t(s: int) -> time_type:
    s = max(0, min(s, 86399))
    return time_type(s // 3600, (s % 3600) // 60, s % 60)


def _get_assignment_for_date(emp, d: date_type):
    """Return the active EmployeeShiftAssignment for an employee on a date (or None)."""
    from .models import EmployeeShiftAssignment
    return (
        EmployeeShiftAssignment.objects
        .filter(employee=emp, effective_from__lte=d)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=d))
        .select_related("shift")
        .order_by("-effective_from")
        .first()
    )


def _get_shift_for_date(emp, d: date_type):
    """
    Return the effective ShiftTemplate for an employee on a given date (or None).
    Per-employee custom start/end overrides on the assignment take precedence
    over the template's own times — HR sets these for individual schedules.
    """
    asgn = _get_assignment_for_date(emp, d)
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


def compute_daily_shift_log(emp, d: date_type, punches: list) -> dict:
    """
    Given a list of AttendanceLog objects for (emp, date), compute the
    4-punch shift result and persist it to DailyShiftLog.

    Returns the resulting DailyShiftLog instance dict.
    """
    from .models import DailyShiftLog

    shift = _get_shift_for_date(emp, d)

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

    if shift and shift.shift_type == "staff" and shift.first_half_end:
        # Second half requires a return punch (punch3) AND an end-of-day punch (punch4)
        if punch3 and punch4:
            second_half = True
    else:
        # Production / simple shift: if they punched out they completed the day
        second_half = bool(punch4)

    shifts_completed = Decimal("0")
    if first_half and second_half:
        shifts_completed = Decimal("1.00")
    elif first_half or second_half:
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
    try:
        from .night_shift import get_relaxation_for
        relaxation = get_relaxation_for(emp, d) if punch1 else None
    except Exception:
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
            compute_daily_shift_log(emp, d, punches)
            count += 1
    return count
