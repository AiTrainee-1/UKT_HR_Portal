"""Attendance pieces shared by the Customise data sources "employees" (Attendance in the month) and "attendance_days".

Everything is read from the STORED day verdicts (AttendanceDayRecord: what payroll pays) through the loader the attendance
registers use (definitions.attendance_core_data.AttendanceData / build_day), so a custom report shows exactly what the
Attendance pages and the Time Card show. Nothing is computed or written. Staff days are calendar days; production days
are SHIFT days (a night shift's closing punch belongs to the day the shift began), as the engine stores them.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from api.models import OvertimeRecord, ResignationRequest

from ..definitions.attendance_core_data import AttendanceData
from .common import join_date

ZONE_LABELS = {
    "on_time": "On time",
    "late": "Late",
    "excused": "Excused (permission)",
    "quarter": "Quarter (0.25 shift off)",
    "second_half": "Second half only",
}
OFF_GRID_FLAG = "Out of date: shift credit is not on the quarter grid (stored before quarter shifts)"


def days(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def load(ctx, employees: list, start: date, end: date, *, punches: bool = False, leaves: bool = False):
    """AttendanceData for these employees over start..end. Employment masking is done here (``window``), not by the
    loader: its own reading of Employee.join_date takes a production worker's '01-01-45640' as the year 4564."""
    return AttendanceData(ctx, employees, start, end, punches=punches, leaves=leaves, service=False)


def exit_dates(employees: list) -> dict[int, date]:
    """{employee id: last working day} from the approved resignations (one query). A resignation dated before the
    employee's (re)joining date belongs to an earlier stint and is ignored."""
    ids = [e.id for e in employees]
    if not ids:
        return {}
    joins = {e.id: join_date(e) for e in employees}
    out: dict[int, date] = {}
    for emp_id, last in (
        ResignationRequest.objects.filter(employee_id__in=ids, status="approved", last_working_date__isnull=False)
        .order_by("last_working_date", "id")
        .values_list("employee_id", "last_working_date")
    ):
        joined = joins.get(emp_id)
        if joined is not None and last < joined:
            continue
        out[emp_id] = last  # ascending: the latest wins
    return out


def window(emp, start: date, end: date, exits: dict[int, date]) -> tuple[date, date] | None:
    """The part of start..end the employee was employed in (joining date to last working day), or None."""
    a = start
    joined = join_date(emp)
    if joined is not None and joined > a:
        a = joined
    b = end
    left = exits.get(emp.id)
    if left is not None and left < b:
        b = left
    return (a, b) if a <= b else None


def is_production(emp) -> bool:
    return (emp.employment_type or "") == "production"


def is_working_day(data: AttendanceData, emp, d: date) -> bool:
    """A day the employee is expected to work: not a Sunday, not a declared holiday and (staff) not a Saturday off by the
    shift in force on the 15th (payroll's rule)."""
    if d.weekday() == 6 or d in data.holidays:
        return False
    return not (d.weekday() == 5 and data.saturday_off(emp, d))


def day_type(data: AttendanceData, emp, d: date) -> str:
    name = data.holidays.get(d)
    if name:
        return f"Holiday: {name}"
    if d.weekday() == 6:
        return "Sunday"
    if d.weekday() == 5 and data.saturday_off(emp, d):
        return "Saturday off"
    return "Working day"


def shifts(rec) -> float | None:
    return float(rec.shifts_earned) if rec is not None and rec.shifts_earned is not None else None


def off_grid(rec, emp) -> bool:
    """A production day whose stored shift credit is not a multiple of 0.25: it was stored before quarter shifts and has
    not been recomputed since (shown as stored, flagged)."""
    if rec is None or not is_production(emp) or rec.shifts_earned is None:
        return False
    return (Decimal(rec.shifts_earned) * 4) % 1 != 0


def quarter_day(rec, emp) -> bool:
    """A day a quarter of a shift came off: staff = arrival in the quarter window (arrival_zone "quarter"); production = a
    shift credit ending in .25 or .75."""
    if rec is None:
        return False
    if is_production(emp):
        if rec.shifts_earned is None:
            return False
        q = Decimal(rec.shifts_earned) * 4
        return q % 1 == 0 and q % 2 == 1
    return (rec.arrival_zone or "") == "quarter"


def zone_text(rec, emp) -> str | None:
    if rec is None or is_production(emp):
        return None
    zone = rec.arrival_zone or ""
    if zone:
        return ZONE_LABELS.get(zone, zone.replace("_", " ").capitalize())
    return "Late" if rec.is_late else None


def overtime_by_day(employee_ids, start: date, end: date) -> dict[tuple[int, date], tuple[str, int]]:
    """{(employee id, date): (status, OT minutes)} of the OT records of the range (one query)."""
    ids = list(employee_ids)
    if not ids:
        return {}
    return {
        (eid, d): (status, int(minutes or 0))
        for eid, d, status, minutes in OvertimeRecord.objects.filter(
            employee_id__in=ids, date__gte=start, date__lte=end
        ).values_list("employee_id", "date", "status", "ot_minutes")
    }


def ot_minutes(rec, emp, ot: tuple[str, int] | None, threshold: int) -> int | None:
    """Staff overtime minutes of a day, as the HR Time Card counts them: the OT record's minutes (a rejected one: none),
    else the stored minutes past the shift end when they reach the Settings threshold. Production has no OT minutes (its
    extra work is extra shift credit)."""
    if rec is None or is_production(emp):
        return None
    if ot is not None:
        status, minutes = ot
        if status == OvertimeRecord.STATUS_REJECTED:
            return None
        return minutes or None
    minutes = int(rec.ot_extra_minutes or 0)
    return minutes if minutes >= max(1, threshold) else None
