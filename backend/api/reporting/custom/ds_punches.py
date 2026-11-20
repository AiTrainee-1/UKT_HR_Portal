"""Customise data source "punches": one row per raw punch (AttendanceLog), with the day it counts for.

The day a punch counts for is the engine's: a staff punch after midnight that closes the previous evening's shift counts
for that evening (cross-midnight re-attribution); a production punch belongs to its SHIFT day (a night shift's closing
punch, the next morning, belongs to the day the shift began). Location is the on-duty punch's GPS fix (an approved on-duty
punch becomes an ordinary punch tagged on_duty:approved); other punches carry no location.
"""

from __future__ import annotations

from datetime import timedelta

from django.db.models import Q

from api.geo_attendance_views import source_label
from api.models import AttendanceLog, OnDutyPunchVerification

from .. import filters as Fl
from ..definitions.attendance_core_data import device_of, weekday_text
from ..types import DATE, INTEGER, NUMBER, TEXT, TIME
from . import attendance as A
from .common import employee_cells, employee_fields, related, scope_filters, scoped_employees
from .fields import Dataset, Field, LoadResult, needs_of

MAX_DAYS = 31
SOURCE_OPTIONS = (
    ("biometric", "Biometric device"),
    ("geo", "Geo punch"),
    ("on_duty", "On-duty"),
    ("missing_punch", "Missing punch (approved)"),
    ("manual", "HR / manual entry"),
)
_SOURCE_Q = {
    "biometric": Q(source__startswith="biometric"),
    "geo": Q(source="geo:auto"),
    "on_duty": Q(source="on_duty:approved"),
    "missing_punch": Q(source="missing_punch:approved"),
    "manual": Q(source__startswith="manual"),
}


def _p(key, label, type_, desc=None, needs="punch", width=1.0, align=None) -> Field:
    return Field(key, label, type_, "punch", needs, desc, width=width, align=align)


FIELDS = (
    *employee_fields(),
    _p("punch.date", "Punch date", DATE, "The calendar date the punch was made"),
    _p("punch.weekday", "Day", TEXT, width=0.6),
    _p("punch.time", "Punch time", TIME, width=0.8, align="center"),
    _p(
        "punch.counts_for",
        "Counts for day",
        DATE,
        "The attendance day the punch belongs to: staff after cross-midnight re-attribution, production the shift day",
        "shift_day",
        1.1,
    ),  # fmt: skip
    _p("punch.direction", "Stored type", TEXT, "IN / OUT as stored (the engine orders punches by time)", width=0.7),
    _p("punch.source", "Source", TEXT, "Biometric, Geo Punch, On-Duty, Missing Punch or HR Entry", width=1.0),
    _p("punch.device", "Device", TEXT, "The biometric device the punch came from", width=1.3),
    _p("punch.latitude", "Latitude", NUMBER, "On-duty punches: the GPS fix", "location", 0.9),
    _p("punch.longitude", "Longitude", NUMBER, "On-duty punches: the GPS fix", "location", 0.9),
    _p("punch.accuracy", "GPS accuracy (m)", INTEGER, "On-duty punches", "location", 0.8),
    _p(
        "punch.mocked",
        "Mock location",
        TEXT,
        "On-duty punches: Yes when the phone reported a mocked location",
        "location",
        0.8,
    ),  # fmt: skip
)


def _load(ctx, keys: list[str], ceiling: int) -> LoadResult:
    needs = needs_of(PUNCHES, keys)
    qs = AttendanceLog.objects.filter(ctx.emp_q("employee__"), date__gte=ctx.date_from, date__lte=ctx.date_to)
    source = ctx.params.get("source")
    if source:
        qs = qs.filter(_SOURCE_Q[source])
    logs = list(
        related(qs).order_by("employee__employee_code", "employee_id", "date", "punch_time", "id")[: ceiling + 1]
    )
    capped = len(logs) > ceiling
    logs = logs[:ceiling]
    notes: list[str] = []

    counts_for: dict[tuple[int, object, object], object] = {}
    if "shift_day" in needs and logs:
        ids = {log.employee_id for log in logs}
        employees = scoped_employees(ctx, only_ids=ids)
        # one day either side: a punch can count for the day before (a night exit) or after (an early staff arrival)
        d_from, d_to = ctx.date_from - timedelta(days=1), ctx.date_to + timedelta(days=1)
        data = A.load(ctx, employees, d_from, d_to, punches=True)
        for emp in employees:
            for d in A.days(d_from, d_to):
                for p in data.punches(emp, d):
                    counts_for.setdefault((emp.id, p.on, p.at), d)
    where: dict[tuple[int, object, object], OnDutyPunchVerification] = {}
    if "location" in needs and any(log.source == "on_duty:approved" for log in logs):
        for v in OnDutyPunchVerification.objects.filter(
            employee_id__in={log.employee_id for log in logs},
            status=OnDutyPunchVerification.STATUS_APPROVED,
            punch_date__gte=ctx.date_from,
            punch_date__lte=ctx.date_to,
        ).only("employee_id", "punch_date", "punch_time", "latitude", "longitude", "accuracy_m", "is_mocked"):
            where[(v.employee_id, v.punch_date, v.punch_time)] = v

    rows = []
    for log in logs:
        loc = where.get((log.employee_id, log.date, log.punch_time)) if log.source == "on_duty:approved" else None
        day = counts_for.get((log.employee_id, log.date, log.punch_time))
        rows.append(
            {
                **employee_cells(log.employee),
                "punch.date": log.date.isoformat(),
                "punch.weekday": weekday_text(log.date),
                "punch.time": log.punch_time.strftime("%H:%M:%S"),
                "punch.counts_for": day.isoformat() if day else None,
                "punch.direction": log.punch_type,
                "punch.source": source_label(log.source),
                "punch.device": device_of(log.source),
                "punch.latitude": float(loc.latitude) if loc is not None else None,
                "punch.longitude": float(loc.longitude) if loc is not None else None,
                "punch.accuracy": round(loc.accuracy_m) if loc is not None and loc.accuracy_m is not None else None,
                "punch.mocked": ("Yes" if loc.is_mocked else "No") if loc is not None else None,
            }
        )
    if "shift_day" in needs:
        notes.append(
            "Counts for day is blank for a punch the engine does not use for any day (a duplicate tap, or a punch outside "
            "every shift-day window)."
        )
    return LoadResult(rows=rows, notes=notes, capped=capped)


PUNCHES = Dataset(
    id="punches",
    label="Punches",
    description=f"One row per punch: date, time, the attendance day it counts for, source, device and the GPS fix of "
    f"on-duty punches (up to {MAX_DAYS} days at a time).",
    grain="punch",
    filters=(
        Fl.date_range(max_days=MAX_DAYS),
        *scope_filters(),
        Fl.select("source", "Source", SOURCE_OPTIONS, placeholder="Every source"),
    ),
    sections=(("employee", "Employee"), ("punch", "Punch")),
    fields=FIELDS,
    default_fields=(
        "emp.code",
        "emp.name",
        "emp.department",
        "punch.date",
        "punch.time",
        "punch.counts_for",
        "punch.source",
        "punch.device",
    ),  # fmt: skip
    load=_load,
    modules=("attendance",),
    notes=("Punches are listed as recorded (AttendanceLog); nothing is changed or worked out from them here.",),
)
