"""
OT (Overtime) Detection Engine
==============================
Staff only. A day is OT-eligible when the last punch is more than
`PayrollSettings.ot_threshold_minutes` past the employee's OWN assigned
shift's end time (never a fixed clock time -mirrors night_shift.py's
convention). Detection is a safe, idempotent upsert (status="detected") -it
never changes attendance/payroll on its own; HR must explicitly announce a
record (see compensation_views.py) before it becomes Pay (feeds
SalarySlip.ot_amount at the next payroll generation) or Relaxation (credits
a CompensationLeaveCredit).

Distinct from Night Shift Relaxation (night_shift.py): that feature is about
tomorrow's punctuality after working late tonight; OT compensation rewards
today's extra hours worked. The two are independent and can both apply to
the same late night.
"""

from datetime import date as date_type, timedelta
from decimal import Decimal

from .models import AttendanceDayRecord, Employee, OvertimeRecord, PayrollSettings
from .shift_engine import _get_shift_for_date, _t2s


def _ot_minutes_for(last_punch, shift_end) -> int:
    return max(0, (_t2s(last_punch) - _t2s(shift_end)) // 60)


def detect_overtime_for_month(year: int, month: int, settings=None) -> list[OvertimeRecord]:
    """
    Detect OT for every active staff employee across the given month, upsert
    OvertimeRecord rows (status="detected", never overwriting an already
    announced/rejected row's decision), and return the current full list for
    that month. Safe to call repeatedly -re-running never re-flags a record
    HR has already reviewed.
    """
    if settings is None:
        settings = PayrollSettings.get()
    # Master off-switch: the Compensation feature as a whole. Checked here
    # too (not just at the API layer's @require_compensation_enabled) so any
    # future non-API caller (a management command, a cron job) can't detect
    # OT while the feature is meant to be fully off.
    if not settings.compensation_feature_enabled or not settings.ot_detection_enabled:
        return list(
            OvertimeRecord.objects.filter(date__year=year, date__month=month)
            .select_related("employee")
        )

    threshold_minutes = settings.ot_threshold_minutes or 60
    day = date_type(year, month, 1)
    days = []
    while day.month == month:
        days.append(day)
        day += timedelta(days=1)

    employees = list(Employee.objects.filter(status="active", employment_type="staff"))
    records = list(
        AttendanceDayRecord.objects.filter(
            employee__in=employees, date__year=year, date__month=month,
            status__in=["present", "half_shift"],
        ).exclude(last_punch__isnull=True).select_related("employee")
    )

    existing = {
        (r.employee_id, r.date): r
        for r in OvertimeRecord.objects.filter(employee__in=employees, date__year=year, date__month=month)
    }

    for rec in records:
        shift = _get_shift_for_date(rec.employee, rec.date)
        if not shift or not shift.end_time:
            continue
        ot_minutes = _ot_minutes_for(rec.last_punch, shift.end_time)
        if ot_minutes < threshold_minutes:
            continue
        key = (rec.employee_id, rec.date)
        already = existing.get(key)
        if already and already.status != OvertimeRecord.STATUS_DETECTED:
            # HR already announced/rejected this one -never silently re-flag it.
            continue
        OvertimeRecord.objects.update_or_create(
            employee=rec.employee, date=rec.date,
            defaults={
                "shift_end_time": shift.end_time,
                "last_punch_out": rec.last_punch,
                "ot_minutes": ot_minutes,
                "status": OvertimeRecord.STATUS_DETECTED,
            },
        )

    return list(
        OvertimeRecord.objects.filter(employee__in=employees, date__year=year, date__month=month)
        .select_related("employee")
        .order_by("-date")
    )
