"""
Shared building blocks for the attendance-analysis reports (late, half-day, absenteeism, shifts,
strength ...). Not a report module itself: it registers nothing.

Rules every report built on it follows (see reporting/README.md):

* Read-only. The day verdict comes from the STORED ``AttendanceDayRecord`` rows (the engine that
  writes them, ``attendance_final.compute_day_record``, persists -- so a report never calls it).
  Days nobody has opened yet have no row; ``coverage_notes`` tells the reader how many.
* Minutes are not stored anywhere (only booleans), so lateness / earliness is re-derived from the
  stored first / last punch and the shift in force that day, with the engine's own rules (minute
  granularity for arrivals, permission shift of 60 minutes, grace).
* Settings are read once per run from the universal ``PayrollSettings`` row (the one payroll uses).
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, time, timedelta

from django.db.models import Q, TimeField

from api.models import (
    AttendanceDayRecord,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    PayrollSettings,
    ProductionShiftConfig,
    ResignationRequest,
)
from api.payroll_views import _build_working_days
from api.shift_engine import _get_assignment_for_date, _get_shift_for_date, _t2s, _t2s_minute

from ..common import with_subtotals
from ..filters import (
    EMPLOYMENT_TYPE_OPTIONS,
    branches,
    departments,
    designations,
    employee_status,
    employees,
)
from ..formatting import parse_date
from ..types import F_EMPLOYMENT_TYPE, FilterSpec

DAY_ABBR = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
UNASSIGNED = "Unassigned"

STATUS_LABELS = {
    "present": "Present",
    "half_shift": "Half day",
    "absent": "Absent",
    "on_leave": "On leave",
    "holiday": "Holiday / off",
}

# Employee columns the reports need; anything else would be a deferred-field query per row.
_PEOPLE_ONLY = (
    "id",
    "employee_code",
    "first_name",
    "last_name",
    "employment_type",
    "status",
    "join_date",
    "branch",
    "department",
    "department__name",
    "designation",
    "designation__title",
)


# ── filters ─────────────────────────────────────────────────────────────────


def scope_filters(
    *,
    status: str | None = None,
    employment_default: str | None = None,
    designation: bool = True,
    employee: bool = True,
    employment: bool = True,
) -> tuple[FilterSpec, ...]:
    """Branch / department / designation / employee-type / employee (+ status) filters.

    ``employment_default`` only pre-fills the form ("staff"); an API call that omits the parameter
    still means "all types", exactly like the other reports."""
    out = [branches(), departments()]
    if designation:
        out.append(designations())
    if employment:
        out.append(
            FilterSpec(
                "employmentType",
                F_EMPLOYMENT_TYPE,
                "Employee type",
                options=EMPLOYMENT_TYPE_OPTIONS,
                placeholder="All types",
                default=employment_default,
            )
        )
    if employee:
        out.append(employees())
    if status:
        out.append(employee_status(status))
    return tuple(out)


# ── settings ────────────────────────────────────────────────────────────────


def payroll_settings() -> PayrollSettings:
    """The universal settings row payroll reads (company-wide late / half-day rules) -- payroll itself
    resolves the late pool from ``PayrollSettings.get()``, never from a branch overlay. Looked up once per
    run without the base64 logo blobs. On a brand-new install where the row does not exist yet the model
    defaults are used WITHOUT saving them (``PayrollSettings.get()`` would insert the row, and a report
    never writes)."""
    obj = PayrollSettings.objects.filter(pk=1).defer("company_logo", "signature_image", "authorized_signature").first()
    if obj is not None:
        return obj
    obj = PayrollSettings()
    for field in obj._meta.get_fields():
        # An unsaved instance keeps TimeField defaults declared as text ("14:30") verbatim.
        if isinstance(field, TimeField) and isinstance(getattr(obj, field.attname), str):
            setattr(obj, field.attname, time.fromisoformat(getattr(obj, field.attname)))
    return obj


def production_config() -> ProductionShiftConfig:
    return ProductionShiftConfig.objects.filter(pk=1).first() or ProductionShiftConfig()


# ── small value helpers ─────────────────────────────────────────────────────


def day_abbr(d: date) -> str:
    return DAY_ABBR[d.weekday()]


def hm(value) -> str | None:
    """time -> 'HH:MM' (None stays None)."""
    if value is None:
        return None
    return value.strftime("%H:%M")


def secs_hm(seconds: int) -> str:
    """Seconds since midnight -> 'HH:MM' (wraps past midnight)."""
    seconds %= 86400
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


def month_span(d_from: date, d_to: date) -> tuple[date, date]:
    """First day of d_from's month .. last day of d_to's month."""
    return d_from.replace(day=1), d_to.replace(day=calendar.monthrange(d_to.year, d_to.month)[1])


def days_between(d_from: date, d_to: date):
    d = d_from
    while d <= d_to:
        yield d
        d += timedelta(days=1)


def dept_label(emp) -> str:
    return emp.department.name if emp.department_id else UNASSIGNED


def emp_sort_key(emp) -> tuple:
    """Department name (unassigned last), department id, employee code -- the order every register uses."""
    return (
        0 if emp.department_id else 1,
        (emp.department.name or "").lower() if emp.department_id else "",
        emp.department_id or 0,
        emp.employee_code or "",
    )


def full_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


# ── subtotals vs the row limit ──────────────────────────────────────────────


def subtotals_within_limit(ctx, rows, group_by, sum_keys, *, what: str = "Department", **kwargs):
    """``with_subtotals`` that never pushes a complete list over the row limit.

    The runner counts every emitted row, subtotal rows included, against the screen / export limit and
    refuses ("narrow the filters") or cuts off a result over it. A list that fits by itself must therefore
    not lose (or be refused) because of the extra subtotal lines: they are only added while data rows plus
    subtotal rows still fit. Returns ``(rows, note)``; ``note`` explains an omission (None when added)."""
    data = list(rows)
    limit = ctx.row_limit - 1  # row_limit is the real limit + 1 so a definition can tell "cut off" from "exactly full"
    groups, prev = 0, object()
    for r in data:
        g = group_by(r)
        if g != prev:
            groups, prev = groups + 1, g
    if len(data) + groups <= limit:
        return with_subtotals(data, group_by, sum_keys, **kwargs), None
    if len(data) > limit:
        return data, f"{what} subtotals are omitted because the list was cut off; narrow the filters."
    return data, (
        f"{what} subtotals are omitted: with them the list would be over the row limit; narrow the filters to see them."
    )


# ── employees / records ─────────────────────────────────────────────────────


def people(ctx, *extra_fields: str) -> dict[int, Employee]:
    """{employee id: Employee} for the report's employee filters + branch isolation, with only the
    columns the reports use (department and designation joined)."""
    qs = (
        Employee.objects.filter(ctx.emp_q())
        .select_related("department", "designation")
        .only(*_PEOPLE_ONLY, *extra_fields)
        .order_by("employee_code")
    )
    return {e.id: e for e in qs}


def day_records(ctx, date_from: date, date_to: date, **extra):
    """Stored day verdicts of the scoped employees. Branch isolation and employee filters ride on the
    employee join; the caller adds ordering / limits."""
    return AttendanceDayRecord.objects.filter(ctx.emp_q("employee__"), date__gte=date_from, date__lte=date_to, **extra)


def coverage_notes(ctx, people_by_id: dict[int, Employee], date_from: date, date_to: date) -> list[str]:
    """How many employee-days of the period have no stored record (nobody has opened them in Attendance
    yet). Only ACTIVE employees are checked, from their joining date, up to today."""
    last = min(date_to, ctx.today)
    if last < date_from:
        return []
    actives = [e for e in people_by_id.values() if e.status == "active"]
    if not actives:
        return []
    recorded = set(
        AttendanceDayRecord.objects.filter(
            ctx.emp_q("employee__"), employee__status="active", date__gte=date_from, date__lte=last
        ).values_list("employee_id", "date")
    )
    missing = 0
    for e in actives:
        start = max(date_from, parse_date(e.join_date) or date_from)
        for d in days_between(start, last):
            if (e.id, d) not in recorded:
                missing += 1
    if not missing:
        return []
    return [
        f"Data freshness: {missing:,} employee-day(s) in this period have no stored attendance record yet "
        "(days nobody has opened in Attendance). They are not counted here; opening the Attendance page for "
        "those dates computes them."
    ]


class Roster:
    """Per-run lookups shared by the reports: shift assignments, holidays, exit dates, payroll working
    days. Each is one query, loaded lazily, never per row."""

    def __init__(self, ctx, date_from: date, date_to: date):
        self.ctx = ctx
        self.month_start, self.month_end = month_span(date_from, date_to)
        self._assignments: dict[int, list] | None = None
        self._holidays: dict[date, list[str]] | None = None
        self._exits: dict[int, date] | None = None
        self._working: dict[tuple, set] = {}
        self._join: dict[int, date | None] = {}

    # shifts -----------------------------------------------------------------
    @property
    def assignments(self) -> dict[int, list]:
        if self._assignments is None:
            qs = (
                EmployeeShiftAssignment.objects.filter(self.ctx.emp_q("employee__"), effective_from__lte=self.month_end)
                .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=self.month_start))
                .select_related("shift")
                .order_by("effective_from", "id")
            )
            by: dict[int, list] = defaultdict(list)
            for a in qs:
                by[a.employee_id].append(a)
            self._assignments = dict(by)
        return self._assignments

    def assignment_on(self, emp_id: int, d: date):
        return _get_assignment_for_date(None, d, assignments=self.assignments.get(emp_id, []))

    def shift_on(self, emp_id: int, d: date):
        """The ShiftTemplate in force that day (custom start/end applied to a detached copy), or None."""
        return _get_shift_for_date(None, d, assignments=self.assignments.get(emp_id, []))

    def saturday_off(self, emp_id: int, d: date) -> bool:
        """Payroll rule: the assignment in force on the 15th of the month decides Saturday-off."""
        a = self.assignment_on(emp_id, date(d.year, d.month, 15))
        return bool(a and a.saturday_off)

    # calendar ---------------------------------------------------------------
    @property
    def holidays(self) -> dict[date, list[str]]:
        if self._holidays is None:
            by: dict[date, list[str]] = defaultdict(list)
            for h in Holiday.objects.filter(date__gte=self.month_start, date__lte=self.month_end).order_by(
                "date", "id"
            ):
                by[h.date].append(h.name)
            self._holidays = dict(by)
        return self._holidays

    def holiday_name(self, d: date) -> str | None:
        names = self.holidays.get(d)
        return ", ".join(names) if names else None

    def working_days(self, emp_id: int, year: int, month: int) -> set[date]:
        """Payroll working days of the month for a staff employee (Sundays, Saturday-off Saturdays and
        Holiday rows excluded) -- built by payroll's own ``_build_working_days``."""
        sat_off = self.saturday_off(emp_id, date(year, month, 15))
        key = (sat_off, year, month)
        if key not in self._working:
            hol = {d for d in self.holidays if d.year == year and d.month == month}
            self._working[key] = set(_build_working_days(month, year, sat_off, hol))
        return self._working[key]

    # employment window ------------------------------------------------------
    @property
    def exits(self) -> dict[int, date]:
        if self._exits is None:
            out: dict[int, date] = {}
            for eid, lwd in ResignationRequest.objects.filter(
                self.ctx.emp_q("employee__"), status="approved", last_working_date__isnull=False
            ).values_list("employee_id", "last_working_date"):
                if eid not in out or lwd > out[eid]:
                    out[eid] = lwd
            self._exits = out
        return self._exits

    def join_date(self, emp) -> date | None:
        if emp.id not in self._join:
            self._join[emp.id] = parse_date(emp.join_date)
        return self._join[emp.id]

    def employed_between(self, emp, d_from: date, d_to: date, worked: bool = False) -> bool:
        """Was the employee on the rolls at any time in ``d_from .. d_to``? For a month's register: someone who joins
        after the month, or who left before it, is not part of it (whatever the status filter says).

        ``worked`` = the employee has a stored present / half day inside the period, which is proof enough of
        employment when the leaving date is missing (an inactive employee with no approved resignation) or stale
        (a re-hire whose old resignation is still on file)."""
        j = self.join_date(emp)
        if j and j > d_to:
            return False
        x = self.exits.get(emp.id)
        if x is not None:
            return x >= d_from or worked
        if emp.status == "active":
            return True
        return worked

    def outside_employment(self, emp, d: date) -> bool:
        """True for a day before the joining date or after the last working day (the engine ignores both)."""
        j = self.join_date(emp)
        if j and d < j:
            return True
        x = self.exits.get(emp.id)
        return bool(x and d > x)


# ── day classification ──────────────────────────────────────────────────────

PRESENT, HALF, ABSENT, LEAVE, OFF, MASKED, PENDING = "present", "half", "absent", "leave", "off", "masked", "pending"


def classify_day(rec, emp, roster: Roster, today: date, production_sunday_off: bool = False) -> str:
    """One of present | half | absent | leave | off | masked | pending for a stored day record.

    The engine has no Saturday-off concept and treats a production Sunday with no punch as absent, and it
    ignores joining / leaving dates; the labels here correct for that the way payroll's working-day
    calendar does: a Saturday-off Saturday without punches is OFF, days before joining / after leaving are
    MASKED, and today's absence is PENDING (the day is still running)."""
    st = rec.status
    if st == "present":
        return PRESENT
    if st == "half_shift":
        return HALF
    if roster.outside_employment(emp, rec.date):
        return MASKED
    if st == "holiday":
        return OFF
    if st == "on_leave":
        return LEAVE
    # absent
    is_prod = emp.employment_type == "production"
    if not is_prod and rec.date.weekday() == 5 and roster.saturday_off(emp.id, rec.date):
        return OFF
    if is_prod and production_sunday_off and rec.date.weekday() == 6:
        return OFF
    if rec.date >= today:
        return PENDING
    return ABSENT


# ── lateness / earliness (never stored, re-derived like the engine) ─────────

PERMISSION_SHIFT_SECONDS = EmployeePermission.FIXED_DURATION_MINUTES * 60


def _ceil_minutes(seconds: int) -> int:
    return -(-seconds // 60)


def morning_lateness(
    first_punch: time | None,
    start: time | None,
    grace_minutes: int,
    permission_applied: bool,
    exact_seconds: bool = False,
):
    """(effective start seconds, deadline seconds, minutes past effective start, minutes past deadline) or
    None when it cannot be worked out or the punch is not actually late under this start time (the shift
    was edited after the day was computed).

    Staff rule, same as ``shift_engine.morning_late_in``: the arrival is compared at minute granularity to
    start + grace, and an in-cap Morning Late-In permission moves the start by 60 minutes.
    ``exact_seconds=True`` is the production rule (``attendance_final._compute_production`` compares the
    punch to the second and never applies permissions); minutes are then rounded up so a day the engine
    flagged never shows "0 minutes past the deadline"."""
    if first_punch is None or start is None:
        return None
    eff = _t2s(start) + (PERMISSION_SHIFT_SECONDS if permission_applied else 0)
    deadline = eff + (grace_minutes or 0) * 60
    fp = _t2s(first_punch) if exact_seconds else _t2s_minute(first_punch)
    if fp <= deadline:
        return None
    if exact_seconds:
        return eff, deadline, _ceil_minutes(fp - eff), _ceil_minutes(fp - deadline)
    return eff, deadline, (fp - eff) // 60, (fp - deadline) // 60


def evening_earliness(last_punch: time | None, end: time | None, grace_minutes: int, permission_applied: bool):
    """(effective end seconds, deadline seconds, minutes before effective end) or None; mirrors
    ``shift_engine.evening_early_out`` (seconds granularity; the deadline is end - grace, and an in-cap
    Evening Early-Out permission moves the end 60 minutes earlier). Minutes are rounded up so a flagged
    day never shows 0."""
    if last_punch is None or end is None:
        return None
    eff = max(0, _t2s(end) - (PERMISSION_SHIFT_SECONDS if permission_applied else 0))
    deadline = eff - (grace_minutes or 0) * 60
    lp = _t2s(last_punch)
    if lp >= deadline:
        return None
    return eff, deadline, _ceil_minutes(eff - lp)


def punch_span_seconds(first_punch: time | None, last_punch: time | None) -> int | None:
    """Seconds from first to last punch; a last punch earlier on the clock than the first is a cross-midnight
    exit (the engine stores bare times) and gets +24h. None with fewer than two distinct punches."""
    if first_punch is None or last_punch is None:
        return None
    span = _t2s(last_punch) - _t2s(first_punch)
    if span < 0:
        span += 86400
    return span or None


def scheduled_seconds(shift) -> int | None:
    """Working seconds a shift schedules: start to end (overnight aware) less the lunch break."""
    if shift is None:
        return None
    span = _t2s(shift.end_time) - _t2s(shift.start_time)
    if span <= 0:
        span += 86400
    return max(0, span - (shift.lunch_duration_minutes or 0) * 60)


def span_net_seconds(first_punch: time | None, last_punch: time | None, shift) -> int | None:
    """First-to-last-punch seconds less the shift's lunch break when the span covers the first-half end
    (an approximation: the register has no lunch punches for a two-punch day)."""
    span = punch_span_seconds(first_punch, last_punch)
    if span is None:
        return None
    if shift is not None and shift.first_half_end and shift.lunch_duration_minutes:
        fp, fhe = _t2s(first_punch), _t2s(shift.first_half_end)
        if fp < fhe < fp + span:
            span = max(0, span - shift.lunch_duration_minutes * 60)
    return span
