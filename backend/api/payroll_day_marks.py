"""The attendance categories of each day of a payroll, for the calendar on the payroll details page.

A payroll stores what each day was counted as (present, absent, half ...) but not WHY: whether a permission, an On-Duty request,
a missed punch or a late arrival was behind it. HR reading a payroll wants to see those on the calendar, so the details endpoint
asks for them here. Everything is READ from the attendance records, requests and punches as they stand now (nothing is computed or
written; the payroll's own figures are never touched), one query per source for the whole period.

The six categories (the `marks` of a day, always in this order):

    late               a late arrival: the day record says is_late
    permission         an approved permission (Morning Late-In, Evening Early-Out, Middle One-Hour) within the monthly cap
    excess_permission  an approved permission beyond the monthly cap (it did not excuse anything)
    on_duty            the day was inside an approved On-Duty request (active or completed)
    on_duty_punch      a geo-punch of an On-Duty request was approved and became a punch of the day
    missed_punch       an approved Missing Punch request, or a punch that came from one
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta

from .clock import FACTORY_TZ, ist_today
from .models import AttendanceDayRecord, AttendanceLog, EmployeePermission, MissingPunchRequest, OnDutySession

MARK_KEYS = ("late", "permission", "excess_permission", "on_duty", "on_duty_punch", "missed_punch")

ON_DUTY_PUNCH_SOURCE = "on_duty:approved"
MISSED_PUNCH_SOURCE = "missing_punch:approved"


def _ist_day(moment: datetime) -> date:
    return moment.astimezone(FACTORY_TZ).date()


def _parse(value) -> date | None:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def day_marks(employee_id: int, start: date, end: date) -> dict[str, list[str]]:
    """{ISO date: [mark keys]} for the days of start..end (both included) that carry at least one mark."""
    found: dict[date, set[str]] = defaultdict(set)

    # What the day record says: late, and the permission flags the Late Detection engine set.
    records = AttendanceDayRecord.objects.filter(employee_id=employee_id, date__range=(start, end)).values(
        "date",
        "is_late",
        "morning_permission_applied",
        "evening_permission_applied",
        "middle_permission_today",
        "permission_afternoon_with_request",
        "morning_permission_excess",
        "evening_permission_excess",
    )
    excess_days: set[date] = set()
    for r in records:
        if r["is_late"]:
            found[r["date"]].add("late")
        if (
            r["morning_permission_applied"]
            or r["evening_permission_applied"]
            or r["middle_permission_today"]
            or r["permission_afternoon_with_request"]
        ):
            found[r["date"]].add("permission")
        if r["morning_permission_excess"] or r["evening_permission_excess"]:
            found[r["date"]].add("excess_permission")
            excess_days.add(r["date"])

    # An approved permission request is a permission, unless the day record says it went beyond the cap.
    approved = EmployeePermission.objects.filter(
        employee_id=employee_id, date__range=(start, end), status=EmployeePermission.STATUS_APPROVED
    ).values_list("date", flat=True)
    for day in approved:
        if day not in excess_days:
            found[day].add("permission")

    for day in MissingPunchRequest.objects.filter(
        employee_id=employee_id, date__range=(start, end), status=MissingPunchRequest.STATUS_APPROVED
    ).values_list("date", flat=True):
        found[day].add("missed_punch")

    # Punches that came from an On-Duty geo-punch or an approved Missing Punch request.
    logs = (
        AttendanceLog.objects.filter(
            employee_id=employee_id, date__range=(start, end), source__in=(ON_DUTY_PUNCH_SOURCE, MISSED_PUNCH_SOURCE)
        )
        .values_list("date", "source")
        .distinct()
    )
    for day, source in logs:
        if source == ON_DUTY_PUNCH_SOURCE:
            found[day].update(("on_duty_punch", "on_duty"))
        else:
            found[day].add("missed_punch")

    # An approved On-Duty request covers every day from when it started to when the employee finished it (a session that is
    # still running covers up to today).
    today = ist_today()
    sessions = OnDutySession.objects.filter(
        employee_id=employee_id,
        status__in=(OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED),
        started_at__isnull=False,
    ).values_list("started_at", "employee_ended_at", "completed_at", "status")
    for started_at, ended_at, completed_at, status in sessions:
        first = _ist_day(started_at)
        last_moment = ended_at or completed_at
        last = _ist_day(last_moment) if last_moment else (today if status == OnDutySession.STATUS_ACTIVE else first)
        if last < first:
            last = first
        day = max(first, start)
        while day <= min(last, end):
            found[day].add("on_duty")
            day += timedelta(days=1)

    return {d.isoformat(): [k for k in MARK_KEYS if k in keys] for d, keys in sorted(found.items())}


def attach_marks(employee_id: int, days: list[dict]) -> list[dict]:
    """The days of a payroll (see payroll_insights.normalized_days) with their `marks`: [] on a day nothing applies to."""
    dates = [d for d in (_parse(day.get("date")) for day in days) if d is not None]
    marks = day_marks(employee_id, min(dates), max(dates)) if dates else {}
    for day in days:
        day["marks"] = marks.get(str(day.get("date") or ""), [])
    return days
