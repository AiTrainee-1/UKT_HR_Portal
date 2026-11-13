"""Keep every stored attendance day in line with its punches (owner 2026-11-13: "Quarter-day, half-day, full-day,
permission, late attendance ... are not being detected properly").

A day's verdict (Present / Half Day / Absent, the arrival zone, Late, the shift earned) is worked out by
attendance_final.compute_day_record and STORED in attendance_day_records. Some screens work the day out again every time
they are opened (the Attendance pages, the Report Log), but many read the stored row as it is (the Report Center's
punch / strength / permission reports, the MD portal, the payroll calendar marks, the Compensation reports, an
employee's punch history). A stored row was only ever re-judged when somebody opened one of the first kind, so a punch
that arrived AFTER its day had been judged (a device that was offline and catches up, a Data Fetch from Device Control,
Auto Sync, the site connector, an approved missing punch, a punch HR adds by hand) left that day as it was: Absent or
Half Day although the person worked a full day, an arrival with no Late / Quarter mark. The only automatic refresh was
the OT job's: the last 3 days, staff only, and only while the OT / Compensation features are switched on.

Two things now keep the rows true:

  * refresh_after_punches(): the paths that save a few punches for HR (biometric_sync._ingest_punches - Auto Sync,
    Device Control's Sync, the geo punch; missing-punch approval; the manual punch endpoints) re-judge the days they
    touched straight away, plus the day before each one (a punch after midnight can be the previous day's exit). A big
    batch (more than INLINE_MAX_EMPLOYEES people or INLINE_MAX_EMPLOYEE_DAYS employee-days) is left to the pass below,
    so the request that saved it stays quick. It never raises: the punches stay saved, and the pass below retries.
  * refresh_stale(): a background pass every few minutes (attendance_refresh_scheduler.py) re-judges any day, staff and
    production, from the 1st of the previous month to today, whose punches arrived after it was last worked out. It
    catches a device's own live push (ADMS) and the bulk catch-ups (the site connector, Device Control's Data Fetch:
    device_fetch's bulk writer must stay a handful of queries inside a 30-second request), a big batch above, and any
    path not listed. Nothing stale = two queries.

A day HR set by hand (source manual) is never recomputed, as everywhere else. Nothing here touches a payroll: a
generated payroll changes only when HR generates it again.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from django.db import transaction

from .clock import ist_today

logger = logging.getLogger(__name__)

# How far back a set of saved punches is re-judged at once (a Data Fetch of a whole year re-judges its last ~3 months;
# an older day is worked out again whenever a screen that recomputes opens it).
MAX_INLINE_DAYS = 93
# Above either of these a batch is left to the background pass (within 5 minutes) instead of being re-judged inside the
# request that saved it: a missing punch, a manual punch, a geo punch or a small Sync are well below them.
INLINE_MAX_EMPLOYEES = 25
INLINE_MAX_EMPLOYEE_DAYS = 200


def window(today: date | None = None) -> tuple[date, date]:
    """The days the background pass looks at: the 1st of the previous month to today (last month's payroll is usually
    generated in the first days of this one, so its late punches must still count)."""
    today = today or ist_today()
    first_this = today.replace(day=1)
    first_prev = (first_this - timedelta(days=1)).replace(day=1)
    return first_prev, today


def refresh_after_punches(pairs) -> int:
    """Re-judge the stored days of these just-saved punches: `pairs` is an iterable of (employee id, punch date). Each
    employee's days from the day before their earliest punch to their latest one (never after today, at most
    MAX_INLINE_DAYS back) are worked out again in one call. Returns how many employees were re-judged."""
    from .attendance_final import compute_range_records
    from .models import Employee, PayrollSettings

    today = ist_today()
    floor = today - timedelta(days=MAX_INLINE_DAYS)
    days: dict[int, set[date]] = defaultdict(set)
    for employee_id, punch_date in pairs:
        if employee_id is None or punch_date is None:
            continue
        if isinstance(punch_date, str):
            punch_date = date.fromisoformat(punch_date[:10])
        if punch_date > today:
            continue
        days[int(employee_id)].add(punch_date)
    if not days:
        return 0
    spans = {emp_id: (max(min(ds) - timedelta(days=1), floor), min(max(ds), today)) for emp_id, ds in days.items()}
    spans = {emp_id: span for emp_id, span in spans.items() if span[0] <= span[1]}
    employee_days = sum((hi - lo).days + 1 for lo, hi in spans.values())
    if len(spans) > INLINE_MAX_EMPLOYEES or employee_days > INLINE_MAX_EMPLOYEE_DAYS:
        logger.info(
            "%s new-punch day(s) of %s employee(s) left to the background attendance refresh", employee_days, len(spans)
        )
        return 0
    settings = PayrollSettings.get()
    done = 0
    for emp in Employee.objects.filter(pk__in=list(spans)).order_by("pk"):
        lo, hi = spans[emp.pk]
        try:
            with transaction.atomic():
                compute_range_records(emp, lo, hi, settings)
            done += 1
        except Exception:
            # the punches are saved whatever happens here; the background pass tries this employee again
            logger.exception(
                "Re-judging the attendance of employee %s (%s to %s) after new punches failed", emp.pk, lo, hi
            )
    return done


def refresh_stale(today: date | None = None) -> int:
    """The background pass: every active employee, staff and production, whose punches arrived after their stored day
    was last worked out, over window(); then every day that was worked out while its shift was still running and whose
    shift is now over (refresh_provisional). Independent of the OT / Compensation switches. Returns how many employees
    were re-judged."""
    from .overtime import recompute_stale_days

    lo, hi = window(today)
    return recompute_stale_days(lo, hi, employment_types=("staff", "production")) + refresh_provisional()


def refresh_provisional() -> int:
    """Work out again every stored day that was judged while its shift was still running (provisional_until set,
    attendance_final._evening_open_until) once that moment has passed: until then its evening edge was not decided (no
    Early-Out, no Penalty Early Out, someone with only a morning punch counted as still at work). Without this a day
    whose last punch never changes would keep its mid-day verdict, because nothing new arrives to make it stale. A day
    HR set by hand is left alone. One query when there is nothing to do. Returns how many employees were re-judged."""
    from django.utils import timezone

    from .attendance_final import compute_range_records
    from .models import AttendanceDayRecord, Employee, PayrollSettings

    due: dict[int, list[date]] = defaultdict(list)
    for emp_id, day in (
        AttendanceDayRecord.objects.filter(provisional_until__isnull=False, provisional_until__lte=timezone.now())
        .exclude(source="manual")
        .values_list("employee_id", "date")
    ):
        due[emp_id].append(day)
    if not due:
        return 0
    settings = PayrollSettings.get()
    done = 0
    for emp in Employee.objects.filter(pk__in=list(due)).order_by("pk"):
        days = due[emp.pk]
        try:
            with transaction.atomic():
                compute_range_records(emp, min(days), max(days), settings)
            done += 1
        except Exception:
            logger.exception(
                "Re-judging the provisional attendance of employee %s (%s to %s) failed", emp.pk, min(days), max(days)
            )
    return done
