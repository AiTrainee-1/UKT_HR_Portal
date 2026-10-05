"""MD portal: Attendance Analytics. "Are people turning up, on time, and what does overtime cost?"

Where the numbers come from
---------------------------
* ``AttendanceDayRecord`` (ADR) is the verdict payroll pays from, so every attendance figure here is built from it and
  from nothing else. The Report Center's own helpers do the judging (``Roster`` and ``classify_day`` in
  reporting/definitions/attendance_analysis_common.py): a Saturday off is not an absence, nor are Sundays, holidays,
  days before joining or after an approved last working day, and approved leave is not absence. The definitions follow
  the Report Center's Absentee Analysis (absent days), Monthly Attendance Summary (attendance %, late % of worked days),
  Half-Day, Late Coming Detail (minutes) and Department-wise Daily Strength reports, so a number here and the same
  number in a report cannot disagree for a reason that is not stated.
* ADR rows are computed lazily (when HR opens Attendance, runs payroll...), so some days have no row. We never compute
  them (that would write): the figures cover the days that have a row and the **coverage** says how many scheduled
  employee-days that is. Coverage is always reported next to the numbers.
* **Today is never part of a rate.** The day is still running, so its absences are "not in yet", not absences. Period
  figures cover complete days (up to yesterday); today is shown separately as a live, provisional count of who has
  punched in so far (``AttendanceLog``).

Everything here is read-only; the REST views and the assistant tools run inside ``common.read_only_db()``.
"""

from __future__ import annotations

import threading
from bisect import bisect_left, bisect_right
from collections import defaultdict, namedtuple
from dataclasses import dataclass
from datetime import date, time, timedelta
from typing import Any, Callable, Iterable

from django.db.models import Count, Min, Q

from ...clock import ist_now, ist_today
from ...models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    LeaveRequest,
    MissingPunchRequest,
    OvertimeRecord,
)
from ...reporting.definitions.attendance_analysis_common import (
    ABSENT,
    HALF,
    LEAVE,
    PRESENT,
    Roster,
    classify_day,
    morning_lateness,
    payroll_settings,
    production_config,
    scheduled_seconds,
)
from ...reporting.definitions.requests_leave_common import (
    LeaveTypeCatalog,
    ist_date,
    leave_dates,
    leave_overlap_q,
    parse_leave_range,
)
from ...reporting.formatting import parse_date
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import (
    MdParamError,
    Period,
    Scope,
    TtlCache,
    cache_seconds,
    cached,
    change,
    envelope,
    parse_day,
    pct,
    prov,
    resolve_period,
)

# ─── rules and thresholds (named, and quoted in the provenance so the MD can see what "chronic" means) ────────────

#: Production Sundays are a weekly off: the engine stores a production Sunday with no punch as "absent", which would
#: count every production worker absent every Sunday. The Report Center's Absentee Analysis defaults to the same.
PRODUCTION_SUNDAY_IS_OFF = True

CHRONIC_ABSENT_MIN_DAYS = 3  # unplanned absence days in the period ...
CHRONIC_ABSENT_MIN_PCT = 10.0  # ... and at least this share of the person's scheduled days
HABITUAL_LATE_MIN_DAYS = 4  # late arrivals in the period ...
HABITUAL_LATE_MIN_PCT = 15.0  # ... and at least this share of the days the person worked
LONG_ABSENCE_MIN_DAYS = 3  # consecutive unexplained absence days (possible absconding)
MISSING_PUNCH_MIN_REQUESTS = 3  # missing-punch requests in the period
AFTER_OFF_MIN_ABSENCES = 3  # absences, of which ...
AFTER_OFF_MIN_SHARE_PCT = 60.0  # ... this share fall on the first working day after a weekly off or holiday
BASELINE_GAP_PTS = 3.0  # a department this many points below the company's attendance %
BASELINE_MIN_HEADCOUNT = 5  # ... with at least this many people

WEEKLY_ROLLUP_AFTER_DAYS = 62  # a trend longer than this is shown week by week
MAX_COMPARE_DAYS = 190  # no previous-period comparison for a period longer than this (it would double the work)
SPARK_WEEKS = 8  # department sparklines: eight consecutive 7-day windows ending with the period
HEATMAP_MAX_DAYS = 31
HEATMAP_MAX_DEPARTMENTS = 15
HEATMAP_MAX_WEEKS = 14
LIST_LIMIT_DEFAULT = 10
LIST_LIMIT_MAX = 25
DEPARTMENT_LIMIT_DEFAULT = 25
DEPARTMENT_LIMIT_MAX = 50
EVIDENCE_DATES = 8  # dates shown as evidence on a person row

#: Punches before this time of day belong to the previous day's late exit (the engine's cross-midnight window ends
#: about 05:00), so they do not mean "in today".
LIVE_PUNCH_FROM = time(5, 0)

UNASSIGNED_DEPARTMENT = "Unassigned"
UNASSIGNED_UNIT = "No unit"
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# ─── a day, as the analytics see it ──────────────────────────────────────────────────────────────────────────────

# Row codes. "Scheduled" = the person was expected to work that day. S* rows are on scheduled days; X* rows are days
# worked on a day off (a Sunday, a holiday, a Saturday off), which never enter the attendance denominators.
SP, SH, SA, SL, XP, XH = range(6)  # present, half day, absent, on approved leave, worked a day off (full / half)
LATE_FLAG = 1  # the engine flagged the arrival late
INFORMED_FLAG = 2  # HR marked the absence as informed in advance
# Tally slots (a tally is a list of ints: the six codes, then these two counters)
T_LATE, T_INFORMED = 6, 7
TALLY_SIZE = 8

_Rec = namedtuple("_Rec", "status date")  # what classify_day reads of a day record


def new_tally() -> list[int]:
    return [0] * TALLY_SIZE


def add_row(tally: list[int], code: int, flags: int) -> None:
    tally[code] += 1
    if flags:
        if flags & LATE_FLAG:
            tally[T_LATE] += 1
        if flags & INFORMED_FLAG:
            tally[T_INFORMED] += 1


def tally_rows(rows: Iterable[tuple]) -> list[int]:
    tally = new_tally()
    for _d, _e, code, flags in rows:
        add_row(tally, code, flags)
    return tally


def t_scheduled(t: list[int]) -> int:
    """Scheduled days that have a day record (the denominator of attendance % and absenteeism %)."""
    return t[SP] + t[SH] + t[SA] + t[SL]


def t_worked(t: list[int]) -> int:
    """Days worked, whether scheduled or not (the denominator of late %)."""
    return t[SP] + t[SH] + t[XP] + t[XH]


def t_attendance(t: list[int]) -> float | None:
    return pct(t[SP] + 0.5 * t[SH], t_scheduled(t))


def t_absence(t: list[int]) -> float | None:
    return pct(t[SA], t_scheduled(t))


def t_late(t: list[int]) -> float | None:
    return pct(t[T_LATE], t_worked(t))


def t_halves(t: list[int]) -> int:
    return t[SH] + t[XH]


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def _hours(minutes: float | int | None) -> float:
    return round((minutes or 0) / 60.0, 1)


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _days(start: date, end: date) -> Iterable[date]:
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


# ─── the people ──────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class Person:
    """The employee columns the analytics read, plus the attribute names the Report Center's Roster / classify_day
    expect (``id``, ``employment_type``, ``join_date``, ``status``)."""

    id: int
    code: str
    name: str
    employment_type: str
    status: str
    join_date: str | None
    dept_id: int | None
    dept: str
    branch_id: int | None
    unit: str


def load_people(scope: Scope) -> dict[int, Person]:
    """Every employee in the scope (leavers too: their attendance history is still part of the period)."""
    rows = (
        Employee.objects.filter(scope.employee_q())
        .order_by()
        .values_list(
            "id",
            "employee_code",
            "first_name",
            "last_name",
            "employment_type",
            "status",
            "join_date",
            "department_id",
            "department__name",
            "branch_id",
            "branch__name",
        )
    )
    people: dict[int, Person] = {}
    for eid, code, first, last, etype, status, join, dept_id, dept_name, branch_id, branch_name in rows:
        people[eid] = Person(
            id=eid,
            code=code or "",
            name=f"{first or ''} {last or ''}".strip() or (code or f"#{eid}"),
            employment_type=etype or "staff",
            status=status or "",
            join_date=join,
            dept_id=dept_id,
            dept=dept_name or UNASSIGNED_DEPARTMENT,
            branch_id=branch_id,
            unit=branch_name or UNASSIGNED_UNIT,
        )
    return people


class _RosterCtx:
    """The two things the Report Center's Roster reads from a report context: the employee filter and today."""

    def __init__(self, scope: Scope, today: date) -> None:
        self._scope = scope
        self.today = today

    def emp_q(self, prefix: str = "") -> Q:
        return self._scope.employee_q(prefix)


class Schedule:
    """Is a day a working day for this person? Staff: payroll working days (no Sundays, Saturday-off Saturdays or
    holidays); production: every day except holidays and (see PRODUCTION_SUNDAY_IS_OFF) Sundays. The same calendar the
    Report Center's Absentee Analysis uses, built from payroll's own ``_build_working_days`` through Roster."""

    def __init__(self, roster: Roster) -> None:
        self.roster = roster
        self._sets: dict[tuple[int, int, int], set[date]] = {}

    def is_scheduled(self, emp: Person, d: date) -> bool:
        if emp.employment_type == "production":
            if PRODUCTION_SUNDAY_IS_OFF and d.weekday() == 6:
                return False
            return self.roster.holiday_name(d) is None
        key = (emp.id, d.year, d.month)
        days = self._sets.get(key)
        if days is None:
            days = self._sets[key] = self.roster.working_days(emp.id, d.year, d.month)
        return d in days


# ─── the frame: the classified day records of a scope over a window ──────────────────────────────────────────────


@dataclass
class Frame:
    """The day records of ``scope`` from ``start`` to ``end`` (complete days only), judged once and shared by every
    endpoint of a page load. ``rows`` are ``(date, employee id, code, flags)`` sorted by date: compact tuples, so an
    endpoint can aggregate them with a plain loop and the database is asked once however many endpoints run."""

    scope: Scope
    start: date
    end: date  # the last complete day loaded; before ``start`` when there is nothing measurable
    today: date
    people: dict[int, Person]
    rows: list[tuple[date, int, int, int]]
    row_dates: list[date]
    expected: dict[date, int]  # scheduled employees per day, with or without a day record (the coverage denominator)
    roster_people: list[tuple[Person, date | None, date | None]]  # (person, joined, last day) the expected counts use
    roster: Roster
    schedule: Schedule
    settings: Any
    _late: dict[tuple[int, date], int] | None = None
    _late_unknown: int = 0

    def window(self, start: date, end: date) -> list[tuple[date, int, int, int]]:
        lo, hi = bisect_left(self.row_dates, start), bisect_right(self.row_dates, end)
        return self.rows[lo:hi]

    def rostered_ids(self, d: date) -> set[int]:
        """Employees expected to work on ``d`` (scheduled and employed that day)."""
        out: set[int] = set()
        for emp, joined, last in self.roster_people:
            if (joined and d < joined) or (last and d > last):
                continue
            if self.schedule.is_scheduled(emp, d):
                out.add(emp.id)
        return out

    def late_minutes(self) -> dict[tuple[int, date], int]:
        """Minutes late for each late-flagged day, re-derived the way the Late Coming Detail report does it: the ADR
        stores only the flag, so minutes = first punch - the shift's (permission-shifted) start. A day whose shift
        cannot be found or whose flag no longer matches the shift gets no entry (never a guess)."""
        if self._late is None:
            wanted = {(eid, d) for d, eid, _code, flags in self.rows if flags & LATE_FLAG}
            out: dict[tuple[int, date], int] = {}
            if wanted:
                pcfg = production_config()
                late_rows = (
                    AttendanceDayRecord.objects.filter(
                        self.scope.employee_q("employee__"), date__gte=self.start, date__lte=self.end, is_late=True
                    )
                    .order_by()
                    .values_list("employee_id", "date", "first_punch", "morning_permission_applied")
                )
                for eid, d, first_punch, permission in late_rows:
                    if (eid, d) not in wanted:
                        continue
                    emp = self.people[eid]
                    if emp.employment_type == "production":
                        start, grace, exact = pcfg.punch1_time, pcfg.grace_minutes or 10, True
                    else:
                        shift = self.roster.shift_on(eid, d)
                        if shift is None:
                            continue
                        start, grace, exact = shift.start_time, shift.grace_period_minutes, False
                    late = morning_lateness(first_punch, start, grace, permission, exact_seconds=exact)
                    if late is not None:
                        out[(eid, d)] = late[2]
            self._late = out
            self._late_unknown = len(wanted) - len(out)
        return self._late

    @property
    def late_unknown(self) -> int:
        self.late_minutes()
        return self._late_unknown


def _classify(
    scope: Scope, people: dict[int, Person], roster: Roster, schedule: Schedule, start: date, last: date, today: date
) -> tuple[list[tuple[date, int, int, int]], dict[int, date | None]]:
    """The day records of the window as compact rows, and the last day each leaver is counted to."""
    raw = (
        AttendanceDayRecord.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=last)
        .order_by()
        .values_list("employee_id", "date", "status", "is_late", "is_informed")
    )
    rows: list[tuple[date, int, int, int]] = []
    last_worked: dict[int, date] = {}
    for eid, d, status, is_late, informed in raw:
        emp = people.get(eid)
        if emp is None:
            continue
        verdict = classify_day(_Rec(status, d), emp, roster, today, PRODUCTION_SUNDAY_IS_OFF)
        if verdict == PRESENT or verdict == HALF:
            scheduled = schedule.is_scheduled(emp, d)
            if verdict == PRESENT:
                code = SP if scheduled else XP
            else:
                code = SH if scheduled else XH
            flags = LATE_FLAG if is_late else 0
            if eid not in last_worked or d > last_worked[eid]:
                last_worked[eid] = d
        elif verdict == ABSENT or verdict == LEAVE:
            if not schedule.is_scheduled(emp, d):
                continue
            code = SA if verdict == ABSENT else SL
            flags = INFORMED_FLAG if (verdict == ABSENT and informed) else 0
        else:  # a day off, outside employment, or still pending: not part of any rate
            continue
        rows.append((d, eid, code, flags))

    # People who have left count up to their last working day: the approved one, else the last day they were seen
    # working. Without this a leaver with no recorded last day would be "absent" on every day the engine computed
    # after they went.
    exits = roster.exits
    cutoff: dict[int, date | None] = {}
    for eid, emp in people.items():
        if emp.status != "active":
            known = [x for x in (exits.get(eid), last_worked.get(eid)) if x is not None]
            cutoff[eid] = max(known) if known else None
    if cutoff:
        rows = [r for r in rows if r[1] not in cutoff or (cutoff[r[1]] is not None and r[0] <= cutoff[r[1]])]
    rows.sort()
    return rows, cutoff


def _build_frame(scope: Scope, start: date, end: date, today: date) -> Frame:
    last = min(end, today - timedelta(days=1))
    people = load_people(scope)
    settings = payroll_settings()
    roster = Roster(_RosterCtx(scope, today), start - timedelta(days=7), max(last, start) + timedelta(days=1))
    schedule = Schedule(roster)
    rows: list[tuple[date, int, int, int]] = []
    expected: dict[date, int] = {}
    roster_people: list[tuple[Person, date | None, date | None]] = []
    if people and last >= start:
        rows, cutoff = _classify(scope, people, roster, schedule, start, last, today)
        exits = roster.exits
        for eid, emp in people.items():
            if emp.status == "active":
                finish = exits.get(eid)
            else:
                finish = cutoff.get(eid)
                if finish is None:
                    continue  # a leaver we cannot place in the window
            roster_people.append((emp, parse_date(emp.join_date), finish))
        for d in _days(start, last):
            n = 0
            for emp, joined, finish in roster_people:
                if (joined and d < joined) or (finish and d > finish):
                    continue
                if schedule.is_scheduled(emp, d):
                    n += 1
            expected[d] = n
    return Frame(
        scope=scope,
        start=start,
        end=last,
        today=today,
        people=people,
        rows=rows,
        row_dates=[r[0] for r in rows],
        expected=expected,
        roster_people=roster_people,
        roster=roster,
        schedule=schedule,
        settings=settings,
    )


_FRAMES = TtlCache(maxsize=6)
_FRAME_LOCK = threading.Lock()


def get_frame(scope: Scope, start: date, end: date, today: date | None = None) -> Frame:
    """The frame for a window, built once and shared. A page load fires about nine requests with the same period and
    scope at once: the lock makes the first one build the frame while the others wait for it (instead of all nine
    reading and judging the same 30,000 rows), and the 60 s cache serves the rest. No caching in tests."""
    today = today or ist_today()
    ttl = cache_seconds()
    if ttl <= 0:
        return _build_frame(scope, start, end, today)
    key = (scope.key(), start.isoformat(), end.isoformat(), today.isoformat())
    with _FRAME_LOCK:
        return _FRAMES.get_or_compute(key, ttl, lambda: _build_frame(scope, start, end, today))


# ─── what window a period needs ──────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Windows:
    """A requested period split into what can be measured: ``measured`` is its complete days (today is left out), and
    ``previous`` is the window of the same length just before it, for "vs previous" figures."""

    period: Period
    measured: Period | None
    previous: Period | None
    start: date  # the first day the frame loads (previous period and the sparkline weeks)
    end: date
    today: date

    @property
    def includes_today(self) -> bool:
        return self.period.end >= self.today

    @property
    def spark_start(self) -> date | None:
        return self.measured.end - timedelta(days=SPARK_WEEKS * 7 - 1) if self.measured else None


def windows_for(period: Period, today: date | None = None) -> Windows:
    today = today or ist_today()
    last = today - timedelta(days=1)
    end = min(period.end, last)
    if end < period.start:
        return Windows(period, None, None, today, today - timedelta(days=1), today)
    measured = Period(period.start, end, period.preset, period.label)
    previous = measured.previous() if measured.days <= MAX_COMPARE_DAYS else None
    start = min(previous.start if previous else measured.start, end - timedelta(days=SPARK_WEEKS * 7 - 1))
    return Windows(period, measured, previous, start, end, today)


def frame_for(scope: Scope, period: Period, today: date | None = None) -> tuple[Frame, Windows]:
    win = windows_for(period, today)
    return get_frame(scope, win.start, win.end, win.today), win


# ─── small aggregation helpers ───────────────────────────────────────────────────────────────────────────────────


def grouped(rows: Iterable[tuple], key: Callable[[tuple], Any]) -> dict[Any, list[int]]:
    out: dict[Any, list[int]] = defaultdict(new_tally)
    for row in rows:
        add_row(out[key(row)], row[2], row[3])
    return out


def expected_total(frame: Frame, start: date, end: date) -> int:
    return sum(n for d, n in frame.expected.items() if start <= d <= end)


def coverage_of(frame: Frame, start: date, end: date, rows: list[tuple] | None = None) -> dict:
    """How many scheduled employee-days of the window have a day record. Weekly offs and holidays are not expected, so
    they never count as missing. ``worstDays`` are the days with the lowest coverage (what HR should open first)."""
    rows = frame.window(start, end) if rows is None else rows
    per_day: dict[date, int] = defaultdict(int)
    for d, _eid, code, _flags in rows:
        if code <= SL:
            per_day[d] += 1
    expected = expected_total(frame, start, end)
    recorded = sum(min(per_day.get(d, 0), n) for d, n in frame.expected.items() if start <= d <= end)
    worst = sorted(
        (
            (min(per_day.get(d, 0), n) / n, d, n, min(per_day.get(d, 0), n))
            for d, n in frame.expected.items()
            if start <= d <= end and n > 0 and per_day.get(d, 0) < n
        ),
        key=lambda x: (x[0], x[1]),
    )[:5]
    return {
        "expectedDays": expected,
        "recordedDays": recorded,
        "missingDays": expected - recorded,
        "coveragePct": pct(recorded, expected),
        "partial": expected > 0 and recorded < expected,
        "worstDays": [
            {"date": d.isoformat(), "expected": n, "recorded": rec, "coveragePct": pct(rec, n)}
            for _c, d, n, rec in worst
        ],
    }


# ─── provenance: how each figure is made, in HR's words ──────────────────────────────────────────────────────────

_SCHEDULED_FILTERS = [
    "Complete days only: today is left out (it is still running)",
    "Staff: payroll working days (no Sundays, Saturday-off Saturdays or holidays); production: every day except holidays and Sundays",
    "Days before joining or after an approved last working day are not counted",
]
_DAY_RECORDS = "Attendance day records (what payroll pays from)"
_COVERAGE_CAVEAT = (
    "Day records are created when HR opens Attendance or runs payroll, so some days may not have one yet; "
    "the figure covers the days that do (see Data coverage)."
)


def _prov_attendance(rows: int | None) -> dict:
    return prov(
        "attendance-pct",
        "Attendance %",
        dataset=_DAY_RECORDS,
        definition=(
            "How much of the scheduled working time people actually worked. A full day counts 1 and a half day 0.5. "
            "Days on approved leave stay in the total (the person was not at work) but are not counted as absence."
        ),
        formula="(full days + 0.5 × half days) ÷ scheduled days that have a day record",
        rows=rows,
        filters=_SCHEDULED_FILTERS,
        caveats=[
            _COVERAGE_CAVEAT,
            "Same rule as the Report Center's Monthly Attendance Summary. Casual leave is recorded as a paid present day, so it counts as attendance.",
        ],
    )


def _prov_absenteeism(rows: int | None) -> dict:
    return prov(
        "absenteeism-pct",
        "Absenteeism %",
        dataset=_DAY_RECORDS,
        definition=(
            "Unplanned absence: days marked absent on a scheduled working day. Approved leave, holidays, weekly offs "
            "and Saturday-off Saturdays are not absence."
        ),
        formula="absent days ÷ scheduled days that have a day record",
        rows=rows,
        filters=_SCHEDULED_FILTERS,
        caveats=[
            "Same rule as the Report Center's Absentee Analysis. Production Sundays are treated as a weekly off (the attendance engine stores a production Sunday without punches as absent).",
        ],
    )


def _prov_late(rows: int | None, settings: Any) -> dict:
    caveats = [
        f"Attendance mode is {getattr(settings, 'attendance_mode', 'strict')}: late and half-day rules are the same in "
        "Simple and Strict mode. Strict mode's lunch-return 'night late' is informational and not counted here."
    ]
    if not getattr(settings, "morning_late_in_enabled", True):
        caveats.append(
            "Morning Late-In detection is switched off in Settings: days processed while it is off carry no late flag, "
            "so late figures are understated, not 'everyone was on time'."
        )
    return prov(
        "late-pct",
        "Late arrivals %",
        dataset=_DAY_RECORDS,
        definition=(
            "Days the attendance engine flagged a late arrival (after the shift's start plus grace, allowing for an "
            "approved Morning Late-In permission), as a share of the days people worked."
        ),
        formula="late days ÷ days worked (full and half days)",
        rows=rows,
        filters=["Complete days only: today is left out"],
        caveats=caveats,
    )


def _prov_avg_late(rows: int | None, unknown: int) -> dict:
    caveats = [
        "Minutes are not stored anywhere: they are re-derived from the first punch and the shift in force that day, "
        "as the Late Coming Detail report does."
    ]
    if unknown:
        caveats.append(
            f"{_plural(unknown, 'late day')} could not be measured (no shift found for the day) and "
            f"{'is' if unknown == 1 else 'are'} left out."
        )
    return prov(
        "avg-late-minutes",
        "Average minutes late",
        dataset=f"{_DAY_RECORDS} and shift assignments",
        definition="How late the late arrivals were on average: first punch minus the shift's start time.",
        formula="total minutes late ÷ late days that can be measured",
        rows=rows,
        caveats=caveats,
    )


def _prov_overtime(rows: int | None, settings: Any) -> dict:
    caveats = [
        "Overtime appears only once HR's overtime detection has run (Compensation > Overtime); days not yet detected "
        "are not counted.",
        "Overtime is paid as one day's pay per announced 'Pay' day, not by the hour: the rupee cost is on the Payroll Analysis page.",
    ]
    if not getattr(settings, "compensation_feature_enabled", True):
        caveats.append("The Compensation feature is switched off in Settings, so no overtime is detected or paid.")
    elif not getattr(settings, "ot_detection_enabled", False):
        caveats.append(
            "Overtime detection is switched off in Settings: only overtime already on record (for example "
            "announced by HR by hand) is counted."
        )
    return prov(
        "overtime-hours",
        "Overtime hours",
        dataset="Overtime records (staff)",
        definition=(
            "Time worked beyond the shift's end on days HR has detected or announced as overtime. "
            "Days HR rejected are left out."
        ),
        formula="sum of overtime minutes ÷ 60",
        rows=rows,
        filters=["Staff only: production extra shifts are already inside their shift pay"],
        caveats=caveats,
    )


def _prov_half_days(rows: int | None) -> dict:
    return prov(
        "half-days",
        "Half days",
        dataset=_DAY_RECORDS,
        definition=(
            "Days a person earned only half a day: a punch in one half only (often a single punch), a very late "
            "arrival, an early exit or half-day leave. For production, a day worth at most half of the full shift credit."
        ),
        formula="count of half-day verdicts",
        rows=rows,
        caveats=["Same rule as the Report Center's Half-Day report."],
    )


def _prov_missing_punches(rows: int | None) -> dict:
    return prov(
        "missing-punches",
        "Missing punches waiting",
        dataset="Missing punch requests",
        definition=(
            "Requests from employees who forgot to punch, for days in the period, that are still waiting for a "
            "decision by the department head or HR."
        ),
        formula="requests for days in the period with status pending (HOD or HR)",
        rows=rows,
        caveats=["Counts requests, not days: a day with a single punch and no request is not included."],
    )


def _prov_leave_days(rows: int | None) -> dict:
    return prov(
        "leave-days",
        "Leave days",
        dataset=_DAY_RECORDS,
        definition="Scheduled working days on which the person was on approved leave.",
        formula="count of 'on leave' verdicts on scheduled days",
        rows=rows,
        filters=_SCHEDULED_FILTERS[:1],
    )


def _prov_scheduled(rows: int | None) -> dict:
    return prov(
        "scheduled-days",
        "Scheduled days",
        dataset="Employees, shift assignments, holidays",
        definition=(
            "Employee-days the roster expected people to work: everyone employed that day, on a working day for them "
            "(leavers are counted up to their last working day)."
        ),
        formula="sum over days of employees scheduled that day",
        rows=rows,
        filters=_SCHEDULED_FILTERS[1:],
    )


def _prov_coverage(cov: dict) -> dict:
    return prov(
        "coverage",
        "Data coverage",
        dataset=_DAY_RECORDS,
        definition=(
            "How many scheduled employee-days have a day record. Records are created lazily (HR opens Attendance, "
            "payroll runs), so recent or unopened days may be missing; the attendance figures cover the days that "
            "exist and never guess the rest."
        ),
        formula="scheduled employee-days with a day record ÷ scheduled employee-days",
        rows=cov.get("recordedDays"),
        filters=_SCHEDULED_FILTERS[:1],
        caveats=[
            "Only employees who are active today (and leavers up to their last day) are expected; nothing is estimated."
        ],
    )


def _metric(value: Any, previous: Any, good: str | None, spark: list | None = None) -> dict:
    """One headline figure with the previous period's value and the change between the two (as displayed)."""
    return {"value": value, "previous": previous, "delta": change(value, previous), "good": good, "spark": spark}


def _notes(frame: Frame, win: Windows, cov: dict | None) -> list[str]:
    notes: list[str] = []
    if win.measured is None:
        notes.append(
            "Today is still running, so this period has no completed day yet: the figures below stay empty and the "
            "live count shows who has punched in so far."
        )
        return notes
    if win.includes_today:
        notes.append(
            "Today is still running and is left out of the figures (its absences would only mean 'not in yet'); "
            "the live count of who has punched in so far is shown separately."
        )
    if frame.people and not frame.rows:
        notes.append(
            "No attendance day records exist for these days: HR has not opened or processed them in Attendance yet."
        )
    elif cov and cov["partial"]:
        notes.append(
            f"Attendance day records exist for {cov['coveragePct']}% of scheduled days "
            f"({cov['recordedDays']:,} of {cov['expectedDays']:,} employee-days). The figures cover the days HR has "
            "processed; opening Attendance for the missing dates completes them."
        )
    if win.previous is None and win.measured.days > MAX_COMPARE_DAYS:
        notes.append(
            f"The comparison with the previous period is not shown for periods longer than {MAX_COMPARE_DAYS} days."
        )
    return notes


# ─── extra sources: overtime and missing punches ─────────────────────────────────────────────────────────────────

PENDING_PUNCH = ("pending_hod", "pending_hr")


def _overtime_rows(scope: Scope, start: date, end: date) -> list[tuple]:
    return list(
        OvertimeRecord.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)
        .order_by()
        .values_list("employee_id", "date", "ot_minutes", "status", "compensation_type")
    )


def _punch_request_rows(scope: Scope, start: date, end: date) -> list[tuple]:
    return list(
        MissingPunchRequest.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)
        .order_by()
        .values_list("employee_id", "date", "status")
    )


def _ot_hours(rows: list[tuple], start: date, end: date, settings: Any) -> float | None:
    """None = not tracked (feature off, or detection off and nothing on record); 0.0 = tracked and none."""
    if not getattr(settings, "compensation_feature_enabled", True):
        return None
    minutes = [m for _e, d, m, status, _c in rows if start <= d <= end and status != "rejected"]
    if minutes:
        return _hours(sum(minutes))
    return 0.0 if getattr(settings, "ot_detection_enabled", False) else None


def _figures(frame: Frame, start: date, end: date, ot_rows: list[tuple], punch_rows: list[tuple]) -> dict:
    """Every headline figure of a window, from the frame and the two extra sources."""
    rows = frame.window(start, end)
    t = tally_rows(rows)
    has_rows = bool(rows)
    minutes = frame.late_minutes()
    known = [minutes[(eid, d)] for d, eid, _c, flags in rows if flags & LATE_FLAG and (eid, d) in minutes]
    cov = coverage_of(frame, start, end, rows)
    pending = sum(1 for _e, d, status in punch_rows if start <= d <= end and status in PENDING_PUNCH)
    return {
        "tally": t,
        "rows": len(rows),
        "attendancePct": t_attendance(t),
        "absenteeismPct": t_absence(t),
        "latePct": t_late(t),
        "avgLateMinutes": _round(sum(known) / len(known), 1) if known else None,
        "lateMeasured": len(known),
        "overtimeHours": _ot_hours(ot_rows, start, end, frame.settings),
        "halfDays": t_halves(t) if has_rows else None,
        "leaveDays": t[SL] if has_rows else None,
        "missingPunches": pending if frame.people else None,
        "scheduledDays": cov["expectedDays"] or None,
        "coveragePct": cov["coveragePct"],
        "coverage": cov,
    }


# ─── time series: days, or weeks for a long period ───────────────────────────────────────────────────────────────


def _bucketed(frame: Frame, start: date, end: date, weekly: bool) -> list[tuple[date, int, list[int], int]]:
    """``[(bucket start, working days in it, tally, rostered)]`` oldest first. A day appears only when someone was
    scheduled or recorded (Sundays and holidays have no point), so a working day nobody processed shows as a gap."""
    per_day = grouped(frame.window(start, end), lambda r: r[0])
    buckets: dict[date, list] = {}
    for d in _days(start, end):
        rostered = frame.expected.get(d, 0)
        t = per_day.get(d)
        if rostered == 0 and t is None:
            continue
        b = buckets.setdefault(_week_start(d) if weekly else d, [0, new_tally(), 0])
        b[0] += 1
        b[2] += rostered
        if t is not None:
            for i in range(TALLY_SIZE):
                b[1][i] += t[i]
    return [(k, v[0], v[1], v[2]) for k, v in sorted(buckets.items())]


def _trend_point(key: date, days: int, t: list[int], rostered: int) -> dict:
    scheduled = t_scheduled(t)
    return {
        "date": key.isoformat(),
        "days": days,
        "attendancePct": t_attendance(t),
        "absentPct": t_absence(t),
        "latePct": t_late(t),
        "present": t[SP] + t[SH],
        "half": t[SH],
        "absent": t[SA],
        "leave": t[SL],
        "late": t[T_LATE],
        "expected": scheduled,
        "rostered": rostered,
        "coveragePct": pct(min(scheduled, rostered), rostered),
    }


def _ot_by_bucket(rows: list[tuple], start: date, end: date, weekly: bool) -> dict[date, float]:
    out: dict[date, float] = defaultdict(float)
    for _e, d, minutes, status, _c in rows:
        if start <= d <= end and status != "rejected":
            out[_week_start(d) if weekly else d] += minutes or 0
    return {k: _hours(v) for k, v in out.items()}


SPARK_POINTS = 30


def _sparks(frame: Frame, win: Windows, ot_rows: list[tuple]) -> dict[str, list]:
    """Sparklines for the KPI cards: the trend's own points (daily, or weekly for a long period), newest last."""
    measured = win.measured
    assert measured is not None
    weekly = measured.days > WEEKLY_ROLLUP_AFTER_DAYS
    buckets = _bucketed(frame, measured.start, measured.end, weekly)[-SPARK_POINTS:]
    ot = _ot_by_bucket(ot_rows, measured.start, measured.end, weekly)
    tracked = _ot_hours(ot_rows, measured.start, measured.end, frame.settings) is not None
    return {
        "attendancePct": [t_attendance(t) for _k, _n, t, _r in buckets],
        "absenteeismPct": [t_absence(t) for _k, _n, t, _r in buckets],
        "latePct": [t_late(t) for _k, _n, t, _r in buckets],
        "halfDays": [t_halves(t) for _k, _n, t, _r in buckets],
        "overtimeHours": [ot.get(k, 0.0) for k, _n, _t, _r in buckets] if tracked else [],
    }


# ─── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _period_block(p: Period | None) -> dict | None:
    return None if p is None else {"start": p.start.isoformat(), "end": p.end.isoformat(), "days": p.days}


@cached()
def attendance_summary(scope: Scope, period: Period) -> dict:
    """The headline figures of a period, each with the previous period's value and the change. Complete days only
    (today is left out and shown live); percentages are 0-100 floats, and ``None`` means "no data" (never 0)."""
    return summary_for(scope, period, ist_today())


def summary_for(scope: Scope, period: Period, today: date) -> dict:
    """``attendance_summary`` for an explicit "today" (the Dashboard's headline and the tests pin the day)."""
    frame, win = frame_for(scope, period, today)
    live = live_today(scope, win.today) if win.includes_today else None
    if win.measured is None:
        return envelope(
            {"measured": None, "previous": None, "metrics": {}, "counts": {}, "coverage": None, "live": live},
            period=period,
            scope=scope,
            provenance=[_prov_live()] if live else [],
            notes=_notes(frame, win, None),
        )
    measured, previous = win.measured, win.previous
    ot_rows = _overtime_rows(scope, (previous or measured).start, measured.end)
    punch_rows = _punch_request_rows(scope, (previous or measured).start, measured.end)
    cur = _figures(frame, measured.start, measured.end, ot_rows, punch_rows)
    prev = _figures(frame, previous.start, previous.end, ot_rows, punch_rows) if previous else None
    spark = _sparks(frame, win, ot_rows)

    def metric(key: str, good: str | None) -> dict:
        return _metric(cur[key], prev[key] if prev else None, good, spark.get(key) or None)

    t = cur["tally"]
    metrics = {
        "attendancePct": metric("attendancePct", "up"),
        "absenteeismPct": metric("absenteeismPct", "down"),
        "latePct": metric("latePct", "down"),
        "avgLateMinutes": metric("avgLateMinutes", "down"),
        "overtimeHours": metric("overtimeHours", "down"),
        "halfDays": metric("halfDays", "down"),
        "missingPunches": metric("missingPunches", "down"),
        "leaveDays": metric("leaveDays", None),
        "scheduledDays": metric("scheduledDays", None),
        "coveragePct": metric("coveragePct", "up"),
    }
    counts = {
        "present": t[SP],
        "half": t[SH],
        "absent": t[SA],
        "leave": t[SL],
        "late": t[T_LATE],
        "worked": t_worked(t),
        "scheduledWithRecord": t_scheduled(t),
        "workedOnDaysOff": t[XP] + t[XH],
        "informedAbsences": t[T_INFORMED],
        "overtimeDays": sum(
            1 for _e, d, _m, s, _c in ot_rows if measured.start <= d <= measured.end and s != "rejected"
        ),
    }
    provenance = [
        _prov_attendance(t_scheduled(t)),
        _prov_absenteeism(t_scheduled(t)),
        _prov_late(t_worked(t), frame.settings),
        _prov_avg_late(cur["lateMeasured"], frame.late_unknown),
        _prov_overtime(counts["overtimeDays"], frame.settings),
        _prov_half_days(t_halves(t)),
        _prov_missing_punches(sum(1 for _e, d, _s in punch_rows if measured.start <= d <= measured.end)),
        _prov_leave_days(t[SL]),
        _prov_scheduled(cur["coverage"]["expectedDays"]),
        _prov_coverage(cur["coverage"]),
    ]
    if live:
        provenance.append(_prov_live())
    notes = _notes(frame, win, cur["coverage"])
    if not getattr(frame.settings, "compensation_feature_enabled", True):
        notes.append("Overtime is not shown: the Compensation feature is switched off in Settings.")
    if not getattr(frame.settings, "morning_late_in_enabled", True):
        notes.append("Morning Late-In detection is switched off in Settings, so late figures are understated.")
    return envelope(
        {
            "measured": _period_block(measured),
            "previous": _period_block(previous),
            "metrics": metrics,
            "counts": counts,
            "coverage": cur["coverage"],
            "live": live,
        },
        period=period,
        scope=scope,
        provenance=provenance,
        notes=notes,
    )


# ─── trend ───────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def attendance_trend(scope: Scope, period: Period) -> dict:
    """Attendance, absence and lateness over the period: one point per working day, or per week when the period is
    longer than about two months. Days nobody was scheduled (Sundays, holidays) have no point."""
    frame, win = frame_for(scope, period)
    if win.measured is None:
        return envelope(
            {"granularity": "day", "points": [], "average": None},
            period=period,
            scope=scope,
            provenance=[],
            notes=_notes(frame, win, None),
        )
    measured = win.measured
    weekly = measured.days > WEEKLY_ROLLUP_AFTER_DAYS
    buckets = _bucketed(frame, measured.start, measured.end, weekly)
    points = [_trend_point(k, n, t, r) for k, n, t, r in buckets]
    t = tally_rows(frame.window(measured.start, measured.end))
    cov = coverage_of(frame, measured.start, measured.end)
    notes = _notes(frame, win, cov)
    if weekly:
        notes.append(
            "The period is long, so each point is one week (Monday to Sunday); a week at the edge may be partial."
        )
    return envelope(
        {
            "granularity": "week" if weekly else "day",
            "points": points,
            "average": {"attendancePct": t_attendance(t), "absentPct": t_absence(t), "latePct": t_late(t)},
        },
        period=period,
        scope=scope,
        provenance=[
            _prov_attendance(t_scheduled(t)),
            _prov_absenteeism(t_scheduled(t)),
            _prov_late(t_worked(t), frame.settings),
            _prov_coverage(cov),
        ],
        notes=notes,
    )


# ─── weekday pattern ─────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def attendance_weekday(scope: Scope, period: Period) -> dict:
    """Attendance by day of the week (is Monday worse?) and a weekday x week heatmap."""
    frame, win = frame_for(scope, period)
    empty = {
        "weekdays": [],
        "lowest": None,
        "mondayEffect": None,
        "heatmap": {"weeks": [], "weekdays": [], "values": []},
    }
    if win.measured is None:
        return envelope(empty, period=period, scope=scope, provenance=[], notes=_notes(frame, win, None))
    measured = win.measured
    rows = frame.window(measured.start, measured.end)
    per_day = grouped(rows, lambda r: r[0])
    by_weekday: dict[int, list[int]] = defaultdict(new_tally)
    dates_seen: dict[int, int] = defaultdict(int)
    for d, t in per_day.items():
        if t_scheduled(t):
            dates_seen[d.weekday()] += 1
        for i in range(TALLY_SIZE):
            by_weekday[d.weekday()][i] += t[i]
    weekdays = [
        {
            "weekday": i,
            "name": WEEKDAYS[i],
            "days": dates_seen[i],
            "attendancePct": t_attendance(by_weekday[i]),
            "absentPct": t_absence(by_weekday[i]),
            "latePct": t_late(by_weekday[i]),
            "absent": by_weekday[i][SA],
            "scheduledDays": t_scheduled(by_weekday[i]),
        }
        for i in range(7)
        if t_scheduled(by_weekday[i]) > 0
    ]
    lowest = min(
        (w for w in weekdays if w["attendancePct"] is not None),
        key=lambda w: (w["attendancePct"], w["weekday"]),
        default=None,
    )
    monday = next((w for w in weekdays if w["weekday"] == 0), None)
    others = new_tally()
    for i, t in by_weekday.items():
        if i != 0:
            for j in range(TALLY_SIZE):
                others[j] += t[j]
    monday_effect = None
    if monday and t_scheduled(others) and monday["absentPct"] is not None:
        monday_effect = {
            "mondayAbsentPct": monday["absentPct"],
            "otherDaysAbsentPct": t_absence(others),
            "gapPts": _round(monday["absentPct"] - (t_absence(others) or 0), 1),
            "mondays": monday["days"],
        }
    # weekday x week grid: the last HEATMAP_MAX_WEEKS weeks of the period, a cell = that day's attendance %
    first_week, last_week = _week_start(measured.start), _week_start(measured.end)
    weeks = []
    w = last_week
    while w >= first_week and len(weeks) < HEATMAP_MAX_WEEKS:
        weeks.append(w)
        w -= timedelta(days=7)
    weeks.reverse()
    shown_weekdays = [x["weekday"] for x in weekdays]
    values = [
        [t_attendance(per_day[w + timedelta(days=i)]) if (w + timedelta(days=i)) in per_day else None for w in weeks]
        for i in shown_weekdays
    ]
    t_all = tally_rows(rows)
    cov = coverage_of(frame, measured.start, measured.end, rows)
    notes = _notes(frame, win, cov)
    if len(weeks) < (last_week - first_week).days // 7 + 1:
        notes.append(f"The grid shows the last {HEATMAP_MAX_WEEKS} weeks of the period.")
    return envelope(
        {
            "weekdays": weekdays,
            "lowest": lowest,
            "mondayEffect": monday_effect,
            "heatmap": {
                "weeks": [x.isoformat() for x in weeks],
                "weekdays": [WEEKDAYS[i] for i in shown_weekdays],
                "values": values,
            },
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "weekday-pattern",
                "Attendance by weekday",
                dataset=_DAY_RECORDS,
                definition=(
                    "The attendance % of every Monday in the period together, every Tuesday together, and so on, "
                    "so a day that is regularly worse than the rest stands out."
                ),
                formula="(full days + 0.5 × half days) ÷ scheduled days that have a day record, per weekday",
                rows=t_scheduled(t_all),
                filters=_SCHEDULED_FILTERS[:1],
                caveats=[_COVERAGE_CAVEAT],
            )
        ],
        notes=notes,
    )


# ─── department heatmap ──────────────────────────────────────────────────────────────────────────────────────────


@cached()
def attendance_heatmap(scope: Scope, period: Period) -> dict:
    """Attendance % of each department on each working day (the worst departments first, days capped)."""
    frame, win = frame_for(scope, period)
    if win.measured is None:
        return envelope(
            {
                "days": [],
                "departments": [],
                "values": [],
                "totalDepartments": 0,
                "shownDepartments": 0,
                "capped": False,
            },
            period=period,
            scope=scope,
            provenance=[],
            notes=_notes(frame, win, None),
        )
    measured = win.measured
    rows = frame.window(measured.start, measured.end)
    people = frame.people
    cell = grouped(rows, lambda r: (people[r[1]].dept, r[0]))
    overall = grouped(rows, lambda r: people[r[1]].dept)
    ranked = sorted(
        (name for name, t in overall.items() if t_scheduled(t) > 0),
        key=lambda n: (t_attendance(overall[n]) if t_attendance(overall[n]) is not None else 101.0, n),
    )
    shown = ranked[:HEATMAP_MAX_DEPARTMENTS]
    all_days = sorted(
        {d for d, n in frame.expected.items() if measured.start <= d <= measured.end and n > 0} | {r[0] for r in rows}
    )
    days = all_days[-HEATMAP_MAX_DAYS:]
    values = [[t_attendance(cell[(name, d)]) if (name, d) in cell else None for d in days] for name in shown]
    cov = coverage_of(frame, measured.start, measured.end, rows)
    notes = _notes(frame, win, cov)
    capped = len(ranked) > len(shown) or len(all_days) > len(days)
    if len(all_days) > len(days):
        notes.append(f"The grid shows the last {HEATMAP_MAX_DAYS} working days of the period.")
    if len(ranked) > len(shown):
        notes.append(f"The {len(shown)} departments with the lowest attendance are shown, of {len(ranked)}.")
    return envelope(
        {
            "days": [d.isoformat() for d in days],
            "departments": shown,
            "values": values,
            "totalDepartments": len(ranked),
            "shownDepartments": len(shown),
            "capped": capped,
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "department-heatmap",
                "Department attendance by day",
                dataset=_DAY_RECORDS,
                definition="Each cell is one department's attendance % on one working day; a dash means nobody was recorded.",
                formula="(full days + 0.5 × half days) ÷ scheduled days that have a day record, per department and day",
                rows=sum(t_scheduled(t) for t in overall.values()),
                filters=_SCHEDULED_FILTERS[:1],
                caveats=[_COVERAGE_CAVEAT, "Departments with the same name in several units are one row."],
            )
        ],
        notes=notes,
    )


# ─── departments, units, staff vs production ─────────────────────────────────────────────────────────────────────


def _delta_pts(current: float | None, previous: float | None) -> float | None:
    return None if current is None or previous is None else round(current - previous, 1)


def _group_rows(
    frame: Frame,
    win: Windows,
    key: Callable[[Person], Any],
    ot_minutes: dict[int, float],
    label: Callable[[Any], str] = str,
) -> list[dict]:
    """One ranking row per group (department, unit or type): this period, the previous one and the 8-week sparkline."""
    measured, previous, people = win.measured, win.previous, frame.people
    assert measured is not None
    cur = grouped(frame.window(measured.start, measured.end), lambda r: key(people[r[1]]))
    prev = grouped(frame.window(previous.start, previous.end), lambda r: key(people[r[1]])) if previous else {}
    spark_rows = frame.window(win.spark_start or measured.start, measured.end)
    weeks: dict[Any, dict[int, list[int]]] = defaultdict(lambda: defaultdict(new_tally))
    for row in spark_rows:
        bucket = (measured.end - row[0]).days // 7
        if bucket < SPARK_WEEKS:
            add_row(weeks[key(people[row[1]])][bucket], row[2], row[3])
    headcount: dict[Any, int] = defaultdict(int)
    ot: dict[Any, float] = defaultdict(float)
    for p in people.values():
        if p.status == "active":
            headcount[key(p)] += 1
    for eid, minutes in ot_minutes.items():
        if eid in people:
            ot[key(people[eid])] += minutes
    names = set(cur) | {k for k, n in headcount.items() if n}
    out = []
    for k in names:
        t = cur.get(k, new_tally())
        pt = prev.get(k)
        a, ab, lt = t_attendance(t), t_absence(t), t_late(t)
        pa, pab, plt = (t_attendance(pt), t_absence(pt), t_late(pt)) if pt else (None, None, None)
        out.append(
            {
                "key": k if isinstance(k, (str, int)) else str(k),
                "name": label(k),
                "headcount": headcount.get(k, 0),
                "scheduledDays": t_scheduled(t),
                "attendancePct": a,
                "absenteeismPct": ab,
                "latePct": lt,
                "halfDays": t_halves(t),
                "absentDays": t[SA],
                "overtimeHours": _hours(ot.get(k, 0)),
                "previous": {"attendancePct": pa, "absenteeismPct": pab, "latePct": plt},
                "delta": {
                    "attendancePct": _delta_pts(a, pa),
                    "absenteeismPct": _delta_pts(ab, pab),
                    "latePct": _delta_pts(lt, plt),
                },
                "spark": [
                    t_attendance(weeks[k][i]) if k in weeks and i in weeks[k] else None
                    for i in range(SPARK_WEEKS - 1, -1, -1)
                ],
                "hasRecords": t_scheduled(t) > 0,
            }
        )
    return out


def _rank(rows: list[dict]) -> list[dict]:
    """Lowest attendance first (the ones to look at); groups without records last."""
    return sorted(
        rows,
        key=lambda r: (
            r["attendancePct"] is None,
            r["attendancePct"] if r["attendancePct"] is not None else 0,
            r["name"],
        ),
    )


def _ot_minutes_by_employee(rows: list[tuple], start: date, end: date) -> dict[int, float]:
    out: dict[int, float] = defaultdict(float)
    for eid, d, minutes, status, _c in rows:
        if start <= d <= end and status != "rejected":
            out[eid] += minutes or 0
    return out


def department_rows(frame: Frame, win: Windows) -> dict:
    """Departments, units and staff/production for a period (shared by the page's ranking and the exceptions)."""
    measured = win.measured
    assert measured is not None
    ot_rows = _overtime_rows(frame.scope, measured.start, measured.end)
    ot_minutes = _ot_minutes_by_employee(ot_rows, measured.start, measured.end)
    t_all = tally_rows(frame.window(measured.start, measured.end))
    baseline = t_attendance(t_all)
    departments = _group_rows(frame, win, lambda p: p.dept, ot_minutes)
    for row in departments:
        gap = _delta_pts(row["attendancePct"], baseline)
        row["gapPts"] = gap
        row["belowBaseline"] = bool(
            gap is not None and gap <= -BASELINE_GAP_PTS and row["headcount"] >= BASELINE_MIN_HEADCOUNT
        )
    units = _group_rows(frame, win, lambda p: p.unit, ot_minutes)
    unit_ids = {p.unit: p.branch_id for p in frame.people.values()}
    for row in units:
        row["id"] = unit_ids.get(row["name"])
    types = _group_rows(
        frame,
        win,
        lambda p: p.employment_type,
        ot_minutes,
        label=lambda k: {"staff": "Staff", "production": "Production"}.get(k, str(k).title()),
    )
    return {
        "baseline": {"attendancePct": baseline, "absenteeismPct": t_absence(t_all), "latePct": t_late(t_all)},
        "departments": _rank(departments),
        "units": _rank(units),
        "types": _rank(types),
        "rows": t_scheduled(t_all),
    }


@cached()
def attendance_by_department(scope: Scope, period: Period, limit: int = DEPARTMENT_LIMIT_DEFAULT) -> dict:
    """Departments ranked by attendance (lowest first) with absence, lateness, overtime, headcount, the change against
    the previous period and an 8-week sparkline; plus the same by unit and for staff against production."""
    limit = max(1, min(int(limit), DEPARTMENT_LIMIT_MAX))
    frame, win = frame_for(scope, period)
    if win.measured is None:
        return envelope(
            {"baseline": None, "departments": [], "units": [], "types": [], "total": 0, "limit": limit},
            period=period,
            scope=scope,
            provenance=[],
            notes=_notes(frame, win, None),
        )
    data = department_rows(frame, win)
    measured = win.measured
    cov = coverage_of(frame, measured.start, measured.end)
    notes = _notes(frame, win, cov)
    total = len(data["departments"])
    departments = data["departments"][:limit]
    if total > limit:
        notes.append(f"The {limit} departments with the lowest attendance are shown, of {total}.")
    return envelope(
        {
            "baseline": data["baseline"],
            "departments": departments,
            "units": data["units"],
            "types": data["types"],
            "total": total,
            "limit": limit,
            "belowBaselineRule": {"gapPts": BASELINE_GAP_PTS, "minHeadcount": BASELINE_MIN_HEADCOUNT},
        },
        period=period,
        scope=scope,
        provenance=[
            _prov_attendance(data["rows"]),
            _prov_absenteeism(data["rows"]),
            _prov_late(None, frame.settings),
            prov(
                "department-ranking",
                "Department ranking",
                dataset=f"{_DAY_RECORDS}, overtime records, employees",
                definition=(
                    "Each department's attendance %, absenteeism %, late % and overtime hours for the period, "
                    "ranked lowest attendance first. 'Change' is in percentage points against the previous period of "
                    "the same length. The sparkline is the attendance % of eight consecutive 7-day windows ending "
                    "with the period. Departments with the same name in several units are one row; headcount is "
                    "active employees today."
                ),
                formula="per department: (full days + 0.5 × half days) ÷ scheduled days with a day record",
                rows=data["rows"],
                filters=[
                    f"Flagged 'below the company average' when {BASELINE_GAP_PTS:g} or more points under the company's "
                    f"attendance % with at least {BASELINE_MIN_HEADCOUNT} people"
                ],
                caveats=[_COVERAGE_CAVEAT],
            ),
        ],
        notes=notes,
    )


# ─── today, live ─────────────────────────────────────────────────────────────────────────────────────────────────


def _prov_live() -> dict:
    return prov(
        "live-today",
        "In so far today",
        dataset="Punch log, employees, approved leave, holidays",
        definition=(
            "Employees who have punched at least once today, out of everyone scheduled to work today (people on "
            "approved leave are in the total but are not 'not in yet')."
        ),
        formula="employees with a punch today ÷ employees scheduled today",
        caveats=[
            "Provisional: the day is still running, so 'not in yet' is not 'absent'.",
            "Built from the raw punches, not from HR's attendance day record (which may not be computed yet today); "
            "late arrivals and half days are not known until it is.",
            "Punches before 05:00 are treated as the previous day's late exit.",
        ],
    )


def _live_groups(members: dict[str, list[int]], extra: dict[str, Any] | None = None) -> list[dict]:
    out = []
    for name, (scheduled, inside, leave, not_in) in members.items():
        row = {
            "name": name,
            "expected": scheduled,
            "present": inside,
            "leave": leave,
            "absent": not_in,
            "attendancePct": pct(inside, scheduled),
        }
        if extra and name in extra:
            row["id"] = extra[name]
        out.append(row)
    return sorted(out, key=lambda r: (-r["absent"], r["name"]))


def live_today(scope: Scope, today: date | None = None) -> dict:
    """Who is in so far today, from the punch log. The attendance day records of today are usually not computed until
    HR opens Attendance, and a rate over a half-finished day would be wrong anyway; so today is shown as a count:
    scheduled, in (punched), on approved leave, not in yet. Always provisional."""
    today = today or ist_today()
    people = {eid: p for eid, p in load_people(scope).items() if p.status == "active"}
    roster = Roster(_RosterCtx(scope, today), today, today)
    schedule = Schedule(roster)
    exits = roster.exits
    working: dict[int, Person] = {}
    for eid, p in people.items():
        joined = parse_date(p.join_date)
        last = exits.get(eid)
        if (joined and joined > today) or (last and last < today):
            continue
        if schedule.is_scheduled(p, today):
            working[eid] = p

    on_leave: set[int] = set()
    staff = {
        eid for eid, p in working.items() if p.employment_type != "production"
    }  # the engine ignores leave for production
    if staff:
        for lr in LeaveRequest.objects.filter(
            scope.employee_q("employee__"), status="approved", is_half_day=False
        ).filter(leave_overlap_q(today, today)):
            span = parse_leave_range(lr)
            if span and span[0] <= today <= span[1] and lr.employee_id in staff:
                on_leave.add(lr.employee_id)
        on_leave |= staff & set(
            CasualLeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved", date=today)
            .order_by()
            .values_list("employee_id", flat=True)
        )
    punched = set(
        AttendanceLog.objects.filter(scope.employee_q("employee__"), date=today, punch_time__gte=LIVE_PUNCH_FROM)
        .order_by()
        .values_list("employee_id", flat=True)
        .distinct()
    )
    by_unit: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    by_dept: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    by_type: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    totals = [0, 0, 0, 0]
    for eid, p in working.items():
        slot = 1 if eid in punched else (2 if eid in on_leave else 3)
        for bucket in (totals, by_unit[p.unit], by_dept[p.dept], by_type[p.employment_type]):
            bucket[0] += 1
            bucket[slot] += 1
    scheduled, inside, leave, not_in = totals
    unit_ids = {p.unit: p.branch_id for p in people.values()}
    is_real_today = today == ist_today()
    return {
        "date": today.isoformat(),
        "provisional": True,
        "asOf": ist_now().isoformat(timespec="seconds") if is_real_today else None,
        "isWorkingDay": scheduled > 0,
        "expected": scheduled,
        "present": inside,
        "leave": leave,
        "absent": not_in,
        "attendancePct": pct(inside, scheduled),
        "workedDayOff": len((punched & set(people)) - set(working)),
        "byUnit": _live_groups(by_unit, unit_ids),
        "byDepartment": _live_groups(by_dept),
        "byType": _live_groups(
            {{"staff": "Staff", "production": "Production"}.get(k, k): v for k, v in by_type.items()}
        ),
    }


# ─── exceptions: who and where needs the MD's attention ──────────────────────────────────────────────────────────

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "good": 3}


def _person_row(p: Person, **evidence: Any) -> dict:
    return {"employeeId": p.id, "name": p.name, "code": p.code, "department": p.dept, "unit": p.unit, **evidence}


def _iso_dates(dates: Iterable[date], newest_first: bool = True) -> list[str]:
    return [d.isoformat() for d in sorted(dates, reverse=newest_first)[:EVIDENCE_DATES]]


def find_chronic_absentees(per_emp: dict[int, list[tuple]], people: dict[int, Person]) -> list[dict]:
    out = []
    for eid, emp_rows in per_emp.items():
        t = tally_rows(emp_rows)
        absence = t_absence(t)
        if t[SA] >= CHRONIC_ABSENT_MIN_DAYS and absence is not None and absence >= CHRONIC_ABSENT_MIN_PCT:
            out.append(
                _person_row(
                    people[eid],
                    absentDays=t[SA],
                    scheduledDays=t_scheduled(t),
                    absentPct=absence,
                    informedDays=t[T_INFORMED],
                    leaveDays=t[SL],
                    dates=_iso_dates(r[0] for r in emp_rows if r[2] == SA),
                )
            )
    return sorted(out, key=lambda r: (-r["absentDays"], -(r["absentPct"] or 0), r["name"]))


def find_habitual_late(
    per_emp: dict[int, list[tuple]], people: dict[int, Person], minutes: dict[tuple[int, date], int]
) -> list[dict]:
    out = []
    for eid, emp_rows in per_emp.items():
        t = tally_rows(emp_rows)
        late = t_late(t)
        if t[T_LATE] >= HABITUAL_LATE_MIN_DAYS and late is not None and late >= HABITUAL_LATE_MIN_PCT:
            late_days = [r[0] for r in emp_rows if r[3] & LATE_FLAG]
            known = [minutes[(eid, d)] for d in late_days if (eid, d) in minutes]
            out.append(
                _person_row(
                    people[eid],
                    lateDays=t[T_LATE],
                    workedDays=t_worked(t),
                    latePct=late,
                    avgLateMinutes=_round(sum(known) / len(known), 1) if known else None,
                    dates=_iso_dates(late_days),
                )
            )
    return sorted(out, key=lambda r: (-r["lateDays"], -(r["latePct"] or 0), r["name"]))


def _longest_run(frame: Frame, emp: Person, emp_rows: list[tuple], start: date, end: date) -> dict | None:
    """The run of consecutive unexplained absences to report for one person, or None when no run reaches
    LONG_ABSENCE_MIN_DAYS. Follows the Report Center's Absentee Analysis: a weekly off or holiday between two absences
    does not break the run (a Sunday between Saturday and Monday), a day with no record on a working day does, and so
    does a day present, on leave, or an absence HR marked as informed (that one is explained). The run that is still
    going at the end of the window is preferred: that is the one the MD can act on."""
    by_day = {r[0]: r for r in emp_rows}
    runs: list[list] = []  # [days, first date, last date]
    current: list | None = None
    gap = False
    last_worked: date | None = None
    for d in _days(start, end):
        r = by_day.get(d)
        if r is None:
            if frame.schedule.is_scheduled(emp, d):
                gap = True
            continue
        code, flags = r[2], r[3]
        if code == SA and not flags & INFORMED_FLAG:
            if gap and current:
                runs.append(current)
                current = None
            gap = False
            if current is None:
                current = [0, d, d]
            current[0] += 1
            current[2] = d
        else:
            if current:
                runs.append(current)
                current = None
            gap = False
            if code in (SP, SH, XP, XH):
                last_worked = d
    ongoing = current is not None and not gap
    if current:
        runs.append(current)
    long_runs = [x for x in runs if x[0] >= LONG_ABSENCE_MIN_DAYS]
    if not long_runs:
        return None
    pick = long_runs[-1] if ongoing and runs[-1] is long_runs[-1] else max(long_runs, key=lambda x: (x[0], x[2]))
    return {
        "days": pick[0],
        "from": pick[1].isoformat(),
        "to": pick[2].isoformat(),
        "ongoing": bool(ongoing and pick is runs[-1]),
        "lastWorked": last_worked.isoformat() if last_worked else None,
    }


def find_long_absences(frame: Frame, per_emp: dict[int, list[tuple]], start: date, end: date) -> list[dict]:
    out = []
    for eid, emp_rows in per_emp.items():
        if sum(1 for r in emp_rows if r[2] == SA) < LONG_ABSENCE_MIN_DAYS:
            continue
        run = _longest_run(frame, frame.people[eid], emp_rows, start, end)
        if run:
            out.append(
                _person_row(
                    frame.people[eid],
                    streakDays=run["days"],
                    **{"from": run["from"], "to": run["to"]},
                    ongoing=run["ongoing"],
                    lastWorked=run["lastWorked"],
                )
            )
    return sorted(out, key=lambda r: (not r["ongoing"], -r["streakDays"], r["name"]))


def find_frequent_missing_punches(punch_rows: list[tuple], people: dict[int, Person]) -> list[dict]:
    by_emp: dict[int, list[tuple]] = defaultdict(list)
    for eid, d, status in punch_rows:
        if eid in people:
            by_emp[eid].append((d, status))
    out = []
    for eid, items in by_emp.items():
        if len(items) >= MISSING_PUNCH_MIN_REQUESTS:
            out.append(
                _person_row(
                    people[eid],
                    requests=len(items),
                    pending=sum(1 for _d, s in items if s in PENDING_PUNCH),
                    approved=sum(1 for _d, s in items if s == "approved"),
                    rejected=sum(1 for _d, s in items if s == "rejected"),
                    dates=_iso_dates(d for d, _s in items),
                )
            )
    return sorted(out, key=lambda r: (-r["requests"], -r["pending"], r["name"]))


def find_after_off_absences(frame: Frame, per_emp: dict[int, list[tuple]]) -> list[dict]:
    """People whose absences mostly fall on the first working day after a weekly off or holiday (a Monday, the day
    after a festival): the 'long weekend' pattern, which a plain count of absences does not show."""
    out = []
    for eid, emp_rows in per_emp.items():
        absences = [r[0] for r in emp_rows if r[2] == SA]
        if len(absences) < AFTER_OFF_MIN_ABSENCES:
            continue
        emp = frame.people[eid]
        after_off = [d for d in absences if not frame.schedule.is_scheduled(emp, d - timedelta(days=1))]
        share = pct(len(after_off), len(absences))
        if share is not None and share >= AFTER_OFF_MIN_SHARE_PCT:
            out.append(
                _person_row(
                    emp,
                    absences=len(absences),
                    afterOffAbsences=len(after_off),
                    mondayAbsences=sum(1 for d in after_off if d.weekday() == 0),
                    sharePct=share,
                    dates=_iso_dates(after_off),
                )
            )
    return sorted(out, key=lambda r: (-r["afterOffAbsences"], -(r["sharePct"] or 0), r["name"]))


def _monday_effect(rows: list[tuple]) -> dict | None:
    mondays, others = new_tally(), new_tally()
    monday_dates: set[date] = set()
    for d, _e, code, flags in rows:
        target = mondays if d.weekday() == 0 else others
        add_row(target, code, flags)
        if d.weekday() == 0 and code <= SL:
            monday_dates.add(d)
    monday_pct, other_pct = t_absence(mondays), t_absence(others)
    if monday_pct is None or other_pct is None:
        return None
    return {
        "mondayAbsentPct": monday_pct,
        "otherDaysAbsentPct": other_pct,
        "gapPts": round(monday_pct - other_pct, 1),
        "mondays": len(monday_dates),
    }


def _insight(
    id: str, severity: str, title: str, detail: str | None, metric: str | None, ask: str, page: str | None = None
) -> dict:
    return {
        "id": id,
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": page,
        "ask": ask,
    }


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one}" if n == 1 else f"{n:,} {many or one + 's'}"


def _attention_items(
    label: str,
    chronic: int,
    late: int,
    long_absences: list[dict],
    punches: int,
    after_off: int,
    below: list[dict],
    baseline: float | None,
    cov: dict | None,
    monday: dict | None,
    page: str | None = None,
) -> list[dict]:
    """The findings of a period as the page's "Needs your attention" list (the Dashboard builds its own, company-wide)."""
    items: list[dict] = []
    ongoing = [r for r in long_absences if r["ongoing"]]
    if long_absences:
        longest = max(r["streakDays"] for r in long_absences)
        items.append(
            _insight(
                "attendance.long-absence",
                "critical" if any(r["ongoing"] and r["streakDays"] >= 7 for r in long_absences) else "warning",
                f"{_plural(len(long_absences), 'employee has', 'employees have')} been absent {LONG_ABSENCE_MIN_DAYS}+ days in a row without explanation",
                f"The longest run is {longest} days; {len(ongoing)} of them {'is' if len(ongoing) == 1 else 'are'} still absent on the last recorded day. Worth a call before it becomes absconding.",
                str(len(long_absences)),
                f"Which employees have been absent {LONG_ABSENCE_MIN_DAYS} or more days in a row ({label}), and are any of them still absent?",
                page,
            )
        )
    if below:
        names = ", ".join(r["name"] for r in below[1:3])
        worst = below[0]
        items.append(
            _insight(
                "attendance.dept-below-baseline",
                "warning",
                f"{_plural(len(below), 'department is', 'departments are')} well below the company's attendance",
                f"{worst['name']} is at {worst['attendancePct']}% against {baseline}% for the company"
                + (f" (also {names})." if len(below) > 1 else "."),
                f"{worst['attendancePct']}%",
                f"Why is attendance low in {worst['name']} ({label}) compared with the rest of the company?",
                page,
            )
        )
    if chronic:
        items.append(
            _insight(
                "attendance.chronic-absentees",
                "warning" if chronic >= 3 else "info",
                f"{_plural(chronic, 'employee was', 'employees were')} absent on {CHRONIC_ABSENT_MIN_DAYS}+ unplanned days",
                f"At least {CHRONIC_ABSENT_MIN_PCT:g}% of their scheduled days ({label}).",
                str(chronic),
                f"Who are the chronic absentees ({label}) and which departments are they in?",
                page,
            )
        )
    if monday and monday["gapPts"] >= 2.0 and monday["mondayAbsentPct"] >= 1.5 * max(monday["otherDaysAbsentPct"], 0.1):
        items.append(
            _insight(
                "attendance.monday-effect",
                "info",
                f"Mondays are the worst day: {monday['mondayAbsentPct']}% absent against {monday['otherDaysAbsentPct']}% on other days",
                f"Across {monday['mondays']} Mondays ({label}).",
                f"+{monday['gapPts']} pts",
                f"Is absenteeism higher on Mondays or after holidays ({label}), and who is behind it?",
                page,
            )
        )
    if after_off:
        items.append(
            _insight(
                "attendance.after-off-pattern",
                "info",
                f"{_plural(after_off, 'employee is', 'employees are')} mostly absent right after a weekly off or holiday",
                f"{AFTER_OFF_MIN_ABSENCES}+ absences, at least {AFTER_OFF_MIN_SHARE_PCT:g}% of them on the first working day after a day off.",
                str(after_off),
                f"Which employees are regularly absent right after weekly offs or holidays ({label})?",
                page,
            )
        )
    if late:
        items.append(
            _insight(
                "attendance.habitual-late",
                "warning" if late >= 5 else "info",
                f"{_plural(late, 'employee is', 'employees are')} habitually late",
                f"Late on {HABITUAL_LATE_MIN_DAYS}+ days and on at least {HABITUAL_LATE_MIN_PCT:g}% of the days they worked ({label}).",
                str(late),
                f"Who are the habitual late-comers ({label}) and how late are they on average?",
                page,
            )
        )
    if punches:
        items.append(
            _insight(
                "attendance.missing-punches",
                "info",
                f"{_plural(punches, 'employee has', 'employees have')} filed {MISSING_PUNCH_MIN_REQUESTS}+ missing-punch requests",
                "Repeated forgotten punches usually mean a faulty device, a rule people do not follow, or manual corrections.",
                str(punches),
                f"Who files the most missing-punch requests ({label}) and is one device or department behind it?",
                page,
            )
        )
    if cov and cov["partial"] and cov["coveragePct"] is not None and cov["coveragePct"] < 100:
        items.append(
            _insight(
                "attendance.coverage-gap",
                "warning" if cov["coveragePct"] < 80 else "info",
                f"Attendance records are missing for {round(100 - cov['coveragePct'], 1):g}% of scheduled days",
                f"{cov['recordedDays']:,} of {cov['expectedDays']:,} employee-days have a day record ({label}); the rest are not in any figure until HR processes those dates.",
                f"{cov['coveragePct']}%",
                f"Which dates still have no attendance records ({label}) and which units are affected?",
                page,
            )
        )
    items.sort(key=lambda i: SEVERITY_ORDER[i["severity"]])
    return items


def _clamp_limit(limit: Any, default: int = LIST_LIMIT_DEFAULT, maximum: int = LIST_LIMIT_MAX) -> int:
    try:
        return max(1, min(int(limit), maximum))
    except (TypeError, ValueError):
        return default


def _by_employee(rows: Iterable[tuple]) -> dict[int, list[tuple]]:
    out: dict[int, list[tuple]] = defaultdict(list)
    for r in rows:
        out[r[1]].append(r)
    return out


def _thresholds() -> dict:
    return {
        "chronicAbsent": {"minDays": CHRONIC_ABSENT_MIN_DAYS, "minPctOfScheduledDays": CHRONIC_ABSENT_MIN_PCT},
        "habitualLate": {"minDays": HABITUAL_LATE_MIN_DAYS, "minPctOfWorkedDays": HABITUAL_LATE_MIN_PCT},
        "longAbsence": {"minDays": LONG_ABSENCE_MIN_DAYS},
        "missingPunches": {"minRequests": MISSING_PUNCH_MIN_REQUESTS},
        "afterOff": {"minAbsences": AFTER_OFF_MIN_ABSENCES, "minSharePct": AFTER_OFF_MIN_SHARE_PCT},
        "belowBaseline": {"gapPts": BASELINE_GAP_PTS, "minHeadcount": BASELINE_MIN_HEADCOUNT},
    }


def _prov_exceptions(counts: dict, rows: int) -> list[dict]:
    return [
        prov(
            "exceptions-absence",
            "Chronic absentees and long absences",
            dataset=_DAY_RECORDS,
            definition=(
                f"Chronic absentee: {CHRONIC_ABSENT_MIN_DAYS} or more unplanned absence days in the period and at "
                f"least {CHRONIC_ABSENT_MIN_PCT:g}% of the person's scheduled days. Long absence: "
                f"{LONG_ABSENCE_MIN_DAYS} or more consecutive unplanned absences that nobody explained (HR did not "
                "mark them informed); a weekly off or holiday between two absences does not break the run, "
                "a day with no record does."
            ),
            formula="absent days ÷ scheduled days with a day record; runs of consecutive absent days",
            rows=rows,
            filters=_SCHEDULED_FILTERS[:1],
            caveats=[
                _COVERAGE_CAVEAT,
                "Same counting as the Report Center's Absentee Analysis; a run that began before the period is cut at the period's start.",
            ],
        ),
        prov(
            "exceptions-late",
            "Habitual late-comers",
            dataset=_DAY_RECORDS,
            definition=(
                f"Late on {HABITUAL_LATE_MIN_DAYS} or more days and on at least {HABITUAL_LATE_MIN_PCT:g}% of the days "
                "the person worked; average minutes late are re-derived from the first punch and the shift."
            ),
            formula="late days ÷ days worked",
            rows=rows,
            caveats=["Same flag as the Report Center's Late Coming Detail report."],
        ),
        prov(
            "exceptions-punches",
            "Frequent missing punches",
            dataset="Missing punch requests",
            definition=f"{MISSING_PUNCH_MIN_REQUESTS} or more missing-punch requests for days in the period (any outcome).",
            formula="requests per employee",
            rows=counts.get("punchRequests"),
        ),
        prov(
            "exceptions-after-off",
            "Absent after a day off",
            dataset=f"{_DAY_RECORDS} and the working calendar",
            definition=(
                f"{AFTER_OFF_MIN_ABSENCES} or more absences, at least {AFTER_OFF_MIN_SHARE_PCT:g}% of them on the "
                "first working day after a weekly off or a holiday (a Monday, the day after a festival)."
            ),
            formula="absences after a day off ÷ all absences",
            rows=rows,
        ),
        prov(
            "exceptions-baseline",
            "Departments below the company average",
            dataset=_DAY_RECORDS,
            definition=(
                f"A department whose attendance % is {BASELINE_GAP_PTS:g} or more points below the company's for the "
                f"period, with at least {BASELINE_MIN_HEADCOUNT} active people."
            ),
            formula="department attendance % − company attendance %",
            rows=rows,
        ),
    ]


@cached()
def attendance_exceptions(scope: Scope, period: Period, limit: int = LIST_LIMIT_DEFAULT) -> dict:
    """What needs attention: chronic absentees, habitual late-comers, long unexplained absences (possible absconding),
    frequent missing-punch requests, people absent mostly after a day off, and departments well below the company
    average. Every threshold is a named constant (returned under ``thresholds``). Lists are capped at ``limit`` with the
    full count in ``total``."""
    limit = _clamp_limit(limit)
    frame, win = frame_for(scope, period)
    empty_list = {"total": 0, "rows": []}
    if win.measured is None:
        return envelope(
            {
                "thresholds": _thresholds(),
                "chronicAbsentees": empty_list,
                "habitualLate": empty_list,
                "longAbsences": empty_list,
                "missingPunches": empty_list,
                "afterOffAbsences": empty_list,
                "belowBaseline": empty_list,
                "mondayEffect": None,
                "counts": {},
                "attention": [],
            },
            period=period,
            scope=scope,
            provenance=[],
            notes=_notes(frame, win, None),
        )
    measured = win.measured
    rows = frame.window(measured.start, measured.end)
    per_emp = _by_employee(rows)
    people = frame.people
    chronic = find_chronic_absentees(per_emp, people)
    late = find_habitual_late(per_emp, people, frame.late_minutes())
    long_absences = find_long_absences(frame, per_emp, measured.start, measured.end)
    punch_rows = _punch_request_rows(scope, measured.start, measured.end)
    punches = find_frequent_missing_punches(punch_rows, people)
    after_off = find_after_off_absences(frame, per_emp)
    dept_data = department_rows(frame, win)
    below = [d for d in dept_data["departments"] if d["belowBaseline"]]
    below.sort(key=lambda d: (d["gapPts"], d["name"]))
    monday = _monday_effect(rows)
    cov = coverage_of(frame, measured.start, measured.end, rows)
    counts = {
        "chronicAbsentees": len(chronic),
        "habitualLate": len(late),
        "longAbsences": len(long_absences),
        "ongoingAbsences": sum(1 for r in long_absences if r["ongoing"]),
        "missingPunches": len(punches),
        "afterOffAbsences": len(after_off),
        "belowBaseline": len(below),
        "punchRequests": len(punch_rows),
    }

    def block(items: list[dict]) -> dict:
        return {"total": len(items), "rows": items[:limit]}

    attention = _attention_items(
        measured.label,
        len(chronic),
        len(late),
        long_absences,
        len(punches),
        len(after_off),
        below,
        dept_data["baseline"]["attendancePct"],
        cov,
        monday,
    )
    return envelope(
        {
            "thresholds": _thresholds(),
            "chronicAbsentees": block(chronic),
            "habitualLate": block(late),
            "longAbsences": block(long_absences),
            "missingPunches": block(punches),
            "afterOffAbsences": block(after_off),
            "belowBaseline": block(below),
            "mondayEffect": monday,
            "counts": counts,
            "attention": attention,
        },
        period=period,
        scope=scope,
        provenance=_prov_exceptions(counts, t_scheduled(tally_rows(rows))),
        notes=_notes(frame, win, cov)
        + (["Minutes late are left out for days whose shift could not be found."] if frame.late_unknown else []),
    )


# ─── overtime ────────────────────────────────────────────────────────────────────────────────────────────────────


def _shift_hours(frame: Frame, eid: int, year: int, month: int, lo: date, hi: date, cache: dict) -> float | None:
    """Scheduled hours of the person's shift for a month: the assignment in force on the 15th (payroll's own rule for
    the month), clamped into the window; None when they have no shift."""
    key = (eid, year, month)
    if key not in cache:
        mid = min(max(date(year, month, 15), lo), hi)
        shift = frame.roster.shift_on(eid, mid) or frame.roster.shift_on(eid, hi)
        seconds = scheduled_seconds(shift)
        cache[key] = None if not seconds else seconds / 3600.0
    return cache[key]


def _prov_ot_share() -> dict:
    return prov(
        "overtime-share",
        "Overtime as % of scheduled hours",
        dataset="Overtime records, attendance day records, shift assignments",
        definition=(
            "Staff overtime hours as a share of the hours staff were scheduled to work: scheduled days with a day "
            "record × the length of their shift (start to end, less the lunch break)."
        ),
        formula="staff overtime hours ÷ (scheduled staff days × shift hours)",
        caveats=[
            "Uses the shift assigned on the 15th of each month; staff with no shift assignment are left out of the "
            "denominator.",
            "Overtime is detected for staff only.",
        ],
    )


@cached()
def attendance_overtime(scope: Scope, period: Period, limit: int = LIST_LIMIT_DEFAULT) -> dict:
    """Overtime hours by department, the people with the most overtime, the trend, the mix of HR decisions (pay,
    relaxation, detected, rejected) and overtime as a share of scheduled hours. Hours are informational: payroll pays
    one day's pay per announced 'Pay' day (the rupee cost is on the Payroll Analysis page)."""
    limit = _clamp_limit(limit)
    frame, win = frame_for(scope, period)
    settings = frame.settings
    tracking = {
        "featureEnabled": bool(getattr(settings, "compensation_feature_enabled", True)),
        "detectionEnabled": bool(getattr(settings, "ot_detection_enabled", False)),
    }
    if win.measured is None:
        return envelope(
            {
                "totalHours": None,
                "tracking": tracking,
                "byDepartment": [],
                "topEarners": [],
                "trend": {"granularity": "day", "points": []},
            },
            period=period,
            scope=scope,
            provenance=[],
            notes=_notes(frame, win, None),
        )
    measured, previous = win.measured, win.previous
    people = frame.people
    all_rows = _overtime_rows(scope, (previous or measured).start, measured.end)
    cur_rows = [r for r in all_rows if measured.start <= r[1] <= measured.end]
    counted = [r for r in cur_rows if r[3] != "rejected"]
    total_hours = _ot_hours(all_rows, measured.start, measured.end, settings)
    prev_hours = _ot_hours(all_rows, previous.start, previous.end, settings) if previous else None

    by_dept: dict[str, list] = {}
    by_emp: dict[int, list] = {}
    for eid, _d, minutes, _s, _c in counted:
        p = people.get(eid)
        if p is None:
            continue
        a = by_dept.setdefault(p.dept, [0, 0, set()])
        a[0] += minutes or 0
        a[1] += 1
        a[2].add(eid)
        b = by_emp.setdefault(eid, [0, 0])
        b[0] += minutes or 0
        b[1] += 1
    total_minutes = sum(v[0] for v in by_dept.values())
    by_department = sorted(
        (
            {
                "name": name,
                "hours": _hours(v[0]),
                "days": v[1],
                "employees": len(v[2]),
                "sharePct": pct(v[0], total_minutes),
            }
            for name, v in by_dept.items()
        ),
        key=lambda r: (-r["hours"], r["name"]),
    )
    top = sorted(by_emp.items(), key=lambda kv: (-kv[1][0], people[kv[0]].name))[:limit]
    top_earners = [_person_row(people[eid], hours=_hours(v[0]), days=v[1]) for eid, v in top]

    decisions: dict[str, list] = {
        "announcedPay": [0, 0],
        "announcedRelaxation": [0, 0],
        "detected": [0, 0],
        "rejected": [0, 0],
    }
    for _e, _d, minutes, status, ctype in cur_rows:
        if status == "announced":
            key = "announcedRelaxation" if ctype == "relaxation" else "announcedPay"
        elif status in ("detected", "rejected"):
            key = status
        else:
            continue
        decisions[key][0] += 1
        decisions[key][1] += minutes or 0

    weekly = measured.days > WEEKLY_ROLLUP_AFTER_DAYS
    buckets: dict[date, list] = {}
    for d in _days(measured.start, measured.end):
        if frame.expected.get(d):  # a working day with no overtime is a zero, not a gap
            buckets.setdefault(_week_start(d) if weekly else d, [0, set()])
    for eid, d, minutes, _s, _c in counted:
        b = buckets.setdefault(_week_start(d) if weekly else d, [0, set()])
        b[0] += minutes or 0
        b[1].add(eid)
    trend = [{"date": k.isoformat(), "hours": _hours(v[0]), "employees": len(v[1])} for k, v in sorted(buckets.items())]

    # overtime against the hours staff were scheduled for
    sched_days: dict[tuple[int, int, int], int] = defaultdict(int)
    for d, eid, code, _flags in frame.window(measured.start, measured.end):
        if code <= SL and people[eid].employment_type == "staff":
            sched_days[(eid, d.year, d.month)] += 1
    cache: dict = {}
    scheduled_hours = 0.0
    unmeasured = set()
    for (eid, y, m), n in sched_days.items():
        hours_per_day = _shift_hours(frame, eid, y, m, measured.start, measured.end, cache)
        if hours_per_day is None:
            unmeasured.add(eid)
        else:
            scheduled_hours += n * hours_per_day
    staff_minutes = sum(
        m or 0 for eid, _d, m, _s, _c in counted if people.get(eid) and people[eid].employment_type == "staff"
    )
    share = pct(staff_minutes / 60.0, scheduled_hours) if scheduled_hours else None

    cov = coverage_of(frame, measured.start, measured.end)
    notes = _notes(frame, win, cov)
    if not tracking["featureEnabled"]:
        notes.append("Overtime is not tracked: the Compensation feature is switched off in Settings.")
    elif not tracking["detectionEnabled"]:
        notes.append("Overtime detection is switched off in Settings: only overtime already on record is counted.")
    if unmeasured:
        notes.append(
            f"{_plural(len(unmeasured), 'staff member')} {'has' if len(unmeasured) == 1 else 'have'} no shift "
            f"assignment and {'is' if len(unmeasured) == 1 else 'are'} left out of the scheduled hours."
        )
    return envelope(
        {
            "totalHours": total_hours,
            "previousHours": prev_hours,
            "delta": change(total_hours, prev_hours),
            "days": len(counted),
            "employees": len(by_emp),
            "pctOfScheduledHours": share,
            "scheduledHours": round(scheduled_hours, 1) if scheduled_hours else None,
            "decisions": {k: {"days": v[0], "hours": _hours(v[1])} for k, v in decisions.items()},
            "tracking": tracking,
            "byDepartment": by_department[: max(limit, 10)],
            "departmentsTotal": len(by_department),
            "topEarners": top_earners,
            "earnersTotal": len(by_emp),
            "trend": {"granularity": "week" if weekly else "day", "points": trend},
        },
        period=period,
        scope=scope,
        provenance=[
            _prov_overtime(len(counted), settings),
            _prov_ot_share(),
            prov(
                "overtime-decisions",
                "Overtime by HR decision",
                dataset="Overtime records",
                definition=(
                    "Detected: found from the punches, not yet decided. Announced Pay: HR will pay one day's pay. "
                    "Announced Relaxation: HR grants an alternative day off. Rejected: HR refused it (not counted in hours)."
                ),
                formula="count and hours of records per status",
                rows=len(cur_rows),
            ),
        ],
        notes=notes,
    )


# ─── leave, permissions and approvals waiting ────────────────────────────────────────────────────────────────────


def _pending_snapshot(scope: Scope, today: date) -> list[dict]:
    """Requests waiting for a decision right now (not limited to the period): how many and how long the oldest has
    waited. A request that waits for weeks is a process problem the MD can fix with one message."""
    kinds = (
        ("leave", "Leave requests", LeaveRequest.objects.filter(status="pending")),
        ("casual_leave", "Casual leave requests", CasualLeaveRequest.objects.filter(status="pending")),
        ("permission", "Permission requests", EmployeePermission.objects.filter(status="pending")),
        ("missing_punch", "Missing punch requests", MissingPunchRequest.objects.filter(status__in=PENDING_PUNCH)),
    )
    out = []
    for kind, label, qs in kinds:
        agg = qs.filter(scope.employee_q("employee__")).order_by().aggregate(n=Count("id"), oldest=Min("created_at"))
        oldest = ist_date(agg["oldest"])
        out.append(
            {
                "kind": kind,
                "label": label,
                "count": agg["n"] or 0,
                "oldestDays": (today - oldest).days if oldest else None,
                "oldestOn": oldest.isoformat() if oldest else None,
            }
        )
    return out


def _leave_days_by_type(scope: Scope, people: dict[int, Person], lo: date, hi: date) -> tuple[list[dict], int, int]:
    """Approved leave days by type inside [lo, hi] (Sundays skipped, a half day = 0.5, one request per employee-day),
    plus casual leave. Production employees are left out: attendance does not use leave for them."""
    catalog = LeaveTypeCatalog()
    seen: set[tuple[int, date]] = set()
    by_type: dict[str, dict] = {}
    requests = (
        LeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved")
        .filter(leave_overlap_q(lo, hi))
        .order_by("id")
    )
    on_leave: set[int] = set()
    for lr in requests:
        p = people.get(lr.employee_id)
        if p is None or p.employment_type == "production":
            continue
        span = parse_leave_range(lr)
        if span is None:
            continue
        info = catalog.resolve(lr)
        weight = 0.5 if lr.is_half_day else 1.0
        for d in leave_dates(lr, span[0], span[1], lo, hi):
            if (lr.employee_id, d) in seen:
                continue
            seen.add((lr.employee_id, d))
            slot = by_type.setdefault(
                info.key, {"key": info.key, "name": info.label, "days": 0.0, "requests": set(), "paid": info.is_paid}
            )
            slot["days"] += weight
            slot["requests"].add(lr.id)
            on_leave.add(lr.employee_id)
    casual = list(
        CasualLeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved", date__gte=lo, date__lte=hi)
        .order_by()
        .values_list("employee_id", "date")
    )
    casual = [(e, d) for e, d in casual if e in people]
    if casual:
        by_type["casual-paid"] = {
            "key": "casual-paid",
            "name": "Casual leave (paid day)",
            "days": float(len(casual)),
            "requests": {("c", e, d) for e, d in casual},
            "paid": True,
        }
        on_leave |= {e for e, _d in casual}
    rows = sorted(
        (
            {
                "key": v["key"],
                "name": v["name"],
                "days": round(v["days"], 1),
                "requests": len(v["requests"]),
                "paid": v["paid"],
            }
            for v in by_type.values()
        ),
        key=lambda r: (-r["days"], r["name"]),
    )
    return rows, len(on_leave), len(casual)


PERMISSION_LABELS = {
    "morning_late_in": "Morning late-in",
    "evening_early_out": "Evening early-out",
    "middle_permission": "Middle one-hour",
}


def _permission_counts(scope: Scope, lo: date, hi: date) -> tuple[int, dict[str, int]]:
    rows = (
        EmployeePermission.objects.filter(scope.employee_q("employee__"), date__gte=lo, date__lte=hi, status="approved")
        .order_by()
        .values_list("type")
    )
    by_type: dict[str, int] = defaultdict(int)
    total = 0
    for (raw,) in rows:
        total += 1
        key = EmployeePermission.normalize_type(raw)
        by_type[PERMISSION_LABELS.get(key or "", "Not typed")] += 1
    return total, dict(by_type)


@cached()
def attendance_leave(scope: Scope, period: Period) -> dict:
    """Approved leave days by type, the approvals waiting (and how long the oldest has waited) and the permissions
    taken, each against the previous period."""
    frame, win = frame_for(scope, period)
    pending = _pending_snapshot(scope, win.today)
    waiting = sum(p["count"] for p in pending)
    oldest = max((p["oldestDays"] for p in pending if p["oldestDays"] is not None), default=None)
    base = {
        "pending": pending,
        "pendingTotal": waiting,
        "oldestPendingDays": oldest,
    }
    prov_pending = prov(
        "pending-approvals",
        "Approvals waiting",
        dataset="Leave, casual leave, permission and missing punch requests",
        definition="Requests still waiting for a decision right now (any date), and how many days the oldest has waited.",
        formula="count and age of requests with status pending (missing punch: pending HOD or HR)",
        rows=waiting,
    )
    if win.measured is None:
        return envelope(
            {**base, "totalDays": None, "byType": [], "employeesOnLeave": None, "permissions": None},
            period=period,
            scope=scope,
            provenance=[prov_pending],
            notes=_notes(frame, win, None),
        )
    measured, previous = win.measured, win.previous
    by_type, employees, casual = _leave_days_by_type(scope, frame.people, measured.start, measured.end)
    total_days = round(sum(r["days"] for r in by_type), 1) if by_type or frame.people else None
    previous_days = None
    if previous:
        prev_types, _e, _c = _leave_days_by_type(scope, frame.people, previous.start, previous.end)
        previous_days = round(sum(r["days"] for r in prev_types), 1) if frame.people else None
    perm_total, perm_types = _permission_counts(scope, measured.start, measured.end)
    perm_prev = _permission_counts(scope, previous.start, previous.end)[0] if previous else None
    notes = _notes(frame, win, None)
    notes.append(
        "Leave days come from approved leave requests (Sundays excluded, half a day = 0.5); production staff are left out "
        "because attendance does not use leave for them."
    )
    return envelope(
        {
            **base,
            "totalDays": total_days,
            "previousDays": previous_days,
            "delta": change(total_days, previous_days),
            "byType": by_type,
            "employeesOnLeave": employees,
            "casualLeaveDays": casual,
            "permissions": {
                "approved": perm_total if frame.people else None,
                "previousApproved": perm_prev if frame.people else None,
                "delta": change(perm_total, perm_prev) if frame.people else None,
                "byType": [
                    {"type": k, "count": v} for k, v in sorted(perm_types.items(), key=lambda kv: (-kv[1], kv[0]))
                ],
            },
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "leave-by-type",
                "Leave days by type",
                dataset="Leave requests (approved), casual leave requests",
                definition=(
                    "Approved leave days inside the period, by leave type. A half-day request counts 0.5; "
                    "overlapping requests count a day once; casual leave is shown separately (it is a paid day)."
                ),
                formula="sum of approved leave days per type",
                rows=sum(r["requests"] for r in by_type),
                caveats=["Leave requests saved without a type are grouped as 'untyped'."],
            ),
            prov(
                "permissions",
                "Permissions taken",
                dataset="Permission requests (approved)",
                definition="Approved one-hour permissions (late-in, early-out, middle) for days in the period.",
                formula="count of approved permissions",
                rows=perm_total,
            ),
            prov_pending,
        ],
        notes=notes,
    )


# ─── one day ─────────────────────────────────────────────────────────────────────────────────────────────────────


def parse_day_param(value: Any, today: date | None = None) -> date:
    """'today', 'yesterday' or YYYY-MM-DD (what the REST route and the assistant tool accept)."""
    today = today or ist_today()
    text = str(value or "yesterday").strip().lower()
    if text == "today":
        return today
    if text == "yesterday":
        return today - timedelta(days=1)
    return parse_day(text, "date")


def _day_group_row(name: str, t: list[int], rostered: int, extra: dict | None = None) -> dict:
    scheduled = t_scheduled(t)
    row = {
        "name": name,
        "expected": scheduled,
        "present": t[SP] + t[SH],
        "half": t[SH],
        "absent": t[SA],
        "leave": t[SL],
        "late": t[T_LATE],
        "notRecorded": max(0, rostered - scheduled),
        "attendancePct": t_attendance(t),
        "absentPct": t_absence(t),
    }
    if extra:
        row.update(extra)
    return row


@cached()
def attendance_on_date(scope: Scope, day: date, limit: int = DEPARTMENT_LIMIT_DEFAULT) -> dict:
    """One day's snapshot: who was in and who was absent, late or on leave, by unit, department and staff/production.
    For a past day it is the attendance day records; for today it is the live punch count (provisional)."""
    limit = _clamp_limit(limit, DEPARTMENT_LIMIT_DEFAULT, DEPARTMENT_LIMIT_MAX)
    today = ist_today()
    period = resolve_period({"from": day.isoformat(), "to": day.isoformat()})
    base = {"date": day.isoformat(), "weekday": WEEKDAYS[day.weekday()], "isToday": day == today}
    if day > today:
        raise MdParamError(
            f"{day.isoformat()} has not happened yet: today is {today.isoformat()}. Pick today or an earlier day."
        )
    if day == today:
        live = live_today(scope, today)
        totals = {
            "expected": live["expected"],
            "present": live["present"],
            "half": None,
            "absent": live["absent"],
            "leave": live["leave"],
            "late": None,
            "notRecorded": None,
            "attendancePct": live["attendancePct"],
            "absentPct": pct(live["absent"], live["expected"]),
            "workedDayOff": live["workedDayOff"],
        }
        return envelope(
            {
                **base,
                "provisional": True,
                "source": "punches so far today",
                "isWorkingDay": live["isWorkingDay"],
                "asOf": live["asOf"],
                "totals": totals,
                "byUnit": live["byUnit"][:limit],
                "byDepartment": live["byDepartment"][:limit],
                "byType": live["byType"],
            },
            period=period,
            scope=scope,
            provenance=[_prov_live()],
            notes=[
                "Today is still running: 'absent' here means 'not in yet' (nobody has punched), and late arrivals and half "
                "days are not known until HR's attendance day record for today is computed."
            ]
            + ([] if live["isWorkingDay"] else ["Nobody is scheduled to work today (weekly off or holiday)."]),
        )
    frame = get_frame(scope, day, day, today)
    rows = frame.window(day, day)
    people = frame.people
    rostered = frame.rostered_ids(day)
    rostered_by: dict[str, dict[Any, int]] = {
        "unit": defaultdict(int),
        "dept": defaultdict(int),
        "type": defaultdict(int),
    }
    for eid in rostered:
        p = people[eid]
        rostered_by["unit"][p.unit] += 1
        rostered_by["dept"][p.dept] += 1
        rostered_by["type"][p.employment_type] += 1
    by_unit = grouped(rows, lambda r: people[r[1]].unit)
    by_dept = grouped(rows, lambda r: people[r[1]].dept)
    by_type = grouped(rows, lambda r: people[r[1]].employment_type)
    unit_ids = {p.unit: p.branch_id for p in people.values()}
    total = tally_rows(rows)
    working = len(rostered) > 0
    totals = _day_group_row("All", total, len(rostered))
    totals["workedDayOff"] = total[XP] + total[XH]
    cov = coverage_of(frame, day, day, rows)
    unit_rows = [
        _day_group_row(n, by_unit.get(n, new_tally()), rostered_by["unit"].get(n, 0), {"id": unit_ids.get(n)})
        for n in sorted(set(by_unit) | set(rostered_by["unit"]))
    ]
    dept_rows = [
        _day_group_row(n, by_dept.get(n, new_tally()), rostered_by["dept"].get(n, 0))
        for n in sorted(set(by_dept) | set(rostered_by["dept"]))
    ]
    type_rows = [
        _day_group_row(
            {"staff": "Staff", "production": "Production"}.get(n, n),
            by_type.get(n, new_tally()),
            rostered_by["type"].get(n, 0),
        )
        for n in sorted(set(by_type) | set(rostered_by["type"]))
    ]

    def order(r: dict) -> tuple:
        return (-r["absent"], -r["notRecorded"], r["name"])

    notes = []
    if not working:
        notes.append("Nobody was scheduled to work that day (weekly off or holiday).")
        if totals["workedDayOff"]:
            notes.append(f"{_plural(totals['workedDayOff'], 'person', 'people')} worked anyway.")
    elif cov["partial"]:
        notes.append(
            f"HR has processed attendance for {cov['recordedDays']:,} of {cov['expectedDays']:,} employees scheduled that "
            "day; the rest are shown as 'not recorded'."
        )
    return envelope(
        {
            **base,
            "provisional": False,
            "source": "attendance day records",
            "isWorkingDay": working,
            "totals": totals,
            "byUnit": sorted(unit_rows, key=order),
            "byDepartment": sorted(dept_rows, key=order)[:limit],
            "byType": sorted(type_rows, key=order),
            "coverage": cov,
        },
        period=period,
        scope=scope,
        provenance=[
            _prov_attendance(t_scheduled(total)),
            _prov_absenteeism(t_scheduled(total)),
            _prov_late(t_worked(total), frame.settings),
            _prov_coverage(cov),
        ],
        notes=notes,
    )


# ─── two periods side by side ────────────────────────────────────────────────────────────────────────────────────

_COMPARE_KEYS = (
    "attendancePct",
    "absenteeismPct",
    "latePct",
    "avgLateMinutes",
    "overtimeHours",
    "halfDays",
    "leaveDays",
    "missingPunches",
    "scheduledDays",
    "coveragePct",
)


def period_from_text(text: Any, today: date | None = None) -> Period:
    """A period the assistant names: a preset ('last_month'), a month ('2026-09') or 'YYYY-MM-DD..YYYY-MM-DD'."""
    raw = str(text or "").strip()
    if not raw:
        raise MdParamError(
            "Name a period: a preset such as last_month, a month like 2026-09, or 2026-09-01..2026-09-15."
        )
    for sep in ("..", " to ", "/"):
        if sep in raw:
            a, b = raw.split(sep, 1)
            return resolve_period({"from": a.strip(), "to": b.strip()}, today=today)
    if len(raw) == 7 and raw[4] == "-":
        return resolve_period({"month": raw}, today=today)
    return resolve_period({"period": raw}, today=today)


def _figures_of(scope: Scope, period: Period, today: date) -> tuple[dict, dict | None, Frame | None]:
    """(the block shown for one period, its coverage, its frame): the figures of the period's complete days."""
    win = windows_for(period, today)
    block: dict[str, Any] = {"label": period.label, "period": period.to_json(), "measured": _period_block(win.measured)}
    if win.measured is None:
        block["metrics"] = {k: None for k in _COMPARE_KEYS}
        return block, None, None
    frame = get_frame(scope, win.measured.start, win.measured.end, today)
    ot_rows = _overtime_rows(scope, win.measured.start, win.measured.end)
    punch_rows = _punch_request_rows(scope, win.measured.start, win.measured.end)
    figures = _figures(frame, win.measured.start, win.measured.end, ot_rows, punch_rows)
    block["metrics"] = {k: figures[k] for k in _COMPARE_KEYS}
    return block, figures["coverage"], frame


@cached()
def attendance_compare_periods(scope: Scope, period_a: Period, period_b: Period) -> dict:
    """Two periods side by side (for example last month against the month before): the headline figures of each and
    the difference B minus A. Each period covers its complete days only."""
    today = ist_today()
    a, cov_a, frame_a = _figures_of(scope, period_a, today)
    b, cov_b, frame_b = _figures_of(scope, period_b, today)
    differences = {k: change(b["metrics"][k], a["metrics"][k]) for k in _COMPARE_KEYS}
    notes = []
    for tag, block, cov, period in (("A", a, cov_a, period_a), ("B", b, cov_b, period_b)):
        if block["measured"] is None:
            notes.append(f"Period {tag} ({period.label}) has no completed day yet, so it has no figures.")
        elif period.end >= today:
            notes.append(f"Period {tag} ({period.label}) includes today, which is still running and left out.")
        if cov and cov["partial"]:
            notes.append(
                f"Period {tag} ({period.label}): attendance records exist for {cov['coveragePct']}% of scheduled days."
            )
    settings = (frame_a or frame_b).settings if (frame_a or frame_b) else payroll_settings()
    days_a, days_b = (a["measured"] or {}).get("days"), (b["measured"] or {}).get("days")
    if days_a and days_b and days_a != days_b:
        notes.append(
            "The two periods have different lengths: compare the percentages, not the totals "
            "(overtime hours, half days, leave days)."
        )
    return envelope(
        {"a": a, "b": b, "differences": differences},
        period=period_b,
        scope=scope,
        provenance=[
            prov(
                "compare-periods",
                "Period comparison",
                dataset=_DAY_RECORDS,
                definition=(
                    "The same figures as the Attendance Analytics summary, worked out separately for each period. "
                    "The difference is B minus A (in percentage points for percentages)."
                ),
                formula="figure(B) − figure(A)",
                caveats=[_COVERAGE_CAVEAT],
            ),
            _prov_attendance(None),
            _prov_absenteeism(None),
            _prov_late(None, settings),
        ],
        notes=notes,
    )


# ─── for the Dashboard: insights() and headline() ────────────────────────────────────────────────────────────────

SPIKE_RECENT_DAYS = 7  # "recent" = the last 7 complete days
SPIKE_BASELINE_DAYS = 90  # the department's own normal = the 90 days before that
SPIKE_RATIO = 1.5  # absenteeism this many times its own baseline ...
SPIKE_MIN_PCT = 4.0  # ... and at least this high (a rise from 0.5% to 0.9% is noise) ...
SPIKE_MIN_ABSENT_DAYS = 5  # ... on at least this many absence days ...
SPIKE_MIN_HEADCOUNT = 8  # ... in a department of at least this many people
UNIT_TODAY_MIN_PCT = 85.0  # a unit below this share in so far today
UNIT_TODAY_MIN_HEADCOUNT = 10
UNIT_TODAY_AFTER_HOUR = 11  # not before 11:00 factory time: people are still arriving at 9
COVERAGE_WARN_PCT = 90.0
GOOD_NEWS_MIN_PTS = 1.5  # attendance up by at least this many points against the previous 30 days
INSIGHT_LIMIT = 5


@cached()
def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide attendance exceptions for the Dashboard, most severe first, at most five. Cheap: one frame of 97
    days. A department's absenteeism well above its own 90-day normal, a unit under 85% today, chronic absentees, people
    still absent after 3+ days in a row, records missing for a large share of days, and a 'good news' line when
    attendance has clearly improved."""
    now = ist_now()
    pinned = today is not None
    today = today or now.date()
    scope = Scope()
    last = today - timedelta(days=1)
    recent_start = last - timedelta(days=SPIKE_RECENT_DAYS - 1)
    base_end = recent_start - timedelta(days=1)
    base_start = base_end - timedelta(days=SPIKE_BASELINE_DAYS - 1)
    cur = Period(today - timedelta(days=30), last, "last_30_days", "the last 30 days")
    prev = cur.previous()
    frame = get_frame(scope, min(base_start, prev.start), last, today)
    if not frame.people:
        return []
    people = frame.people
    items: list[dict] = []

    # 1. a department far above its own normal
    recent = grouped(frame.window(recent_start, last), lambda r: people[r[1]].dept)
    baseline = grouped(frame.window(base_start, base_end), lambda r: people[r[1]].dept)
    headcount: dict[str, int] = defaultdict(int)
    for p in people.values():
        if p.status == "active":
            headcount[p.dept] += 1
    spikes = []
    for name, t in recent.items():
        rate = t_absence(t)
        base = t_absence(baseline[name]) if name in baseline else None
        if rate is None or base is None or headcount[name] < SPIKE_MIN_HEADCOUNT or t[SA] < SPIKE_MIN_ABSENT_DAYS:
            continue
        if rate >= max(SPIKE_RATIO * base, SPIKE_MIN_PCT):
            spikes.append((rate / max(base, 0.1), name, rate, base, t[SA], headcount[name]))
    for ratio, name, rate, base, absent, heads in sorted(spikes, reverse=True)[:2]:
        against = (
            f"{ratio:.1f}× its 90-day average ({base:g}%)"
            if base >= 0.5
            else f"far above its 90-day average ({base:g}%)"
        )
        items.append(
            _insight(
                "attendance.dept-spike",
                "critical" if rate >= 2 * base and rate >= 8.0 else "warning",
                f"{name} absenteeism is {rate:g}%, {against}",
                f"{absent:,} unplanned absence days in the last {SPIKE_RECENT_DAYS} days across {heads:,} employees.",
                f"{rate:g}%",
                f"Why is absenteeism high in {name} over the last {SPIKE_RECENT_DAYS} days, and who is absent?",
                "attendance",
            )
        )

    # 2. a unit under 85% so far today (not before the morning rush is over)
    if pinned or now.hour >= UNIT_TODAY_AFTER_HOUR:
        live = live_today(scope, today)
        weak = [
            u
            for u in live["byUnit"]
            if u["expected"] >= UNIT_TODAY_MIN_HEADCOUNT
            and u["attendancePct"] is not None
            and u["attendancePct"] < UNIT_TODAY_MIN_PCT
        ]
        if weak:
            worst = min(weak, key=lambda u: (u["attendancePct"], u["name"]))
            items.append(
                _insight(
                    "attendance.unit-low-today",
                    "warning",
                    f"{worst['name']} is at {worst['attendancePct']:.0f}% attendance so far today",
                    f"{worst['present']:,} of {worst['expected']:,} scheduled people have punched in; "
                    f"{worst['absent']:,} are not in yet (provisional: the day is still running).",
                    f"{worst['attendancePct']:.0f}%",
                    f"Who is not in yet at {worst['name']} today, and which departments are affected?",
                    "attendance",
                )
            )

    # 3-4. people: long runs of absence that are still going, and chronic absentees (last 30 days)
    per_emp = _by_employee(frame.window(cur.start, cur.end))
    long_absences = [r for r in find_long_absences(frame, per_emp, cur.start, cur.end) if r["ongoing"]]
    if long_absences:
        longest = max(r["streakDays"] for r in long_absences)
        items.append(
            _insight(
                "attendance.long-absence",
                "critical" if longest >= 7 else "warning",
                f"{_plural(len(long_absences), 'employee has', 'employees have')} been absent {LONG_ABSENCE_MIN_DAYS}+ days in a row and "
                f"{'is' if len(long_absences) == 1 else 'are'} still out",
                f"The longest run is {longest} days with no explanation recorded: worth a call before it becomes absconding.",
                str(len(long_absences)),
                "Which employees have been absent for 3 or more days in a row and are still absent?",
                "attendance",
            )
        )
    chronic = find_chronic_absentees(per_emp, people)
    if chronic:
        items.append(
            _insight(
                "attendance.chronic-absentees",
                "warning" if len(chronic) >= 3 else "info",
                f"{_plural(len(chronic), 'employee was', 'employees were')} absent on {CHRONIC_ABSENT_MIN_DAYS}+ unplanned days in the last 30 days",
                f"At least {CHRONIC_ABSENT_MIN_PCT:g}% of their scheduled days.",
                str(len(chronic)),
                "Who are the chronic absentees in the last 30 days and which departments are they in?",
                "attendance",
            )
        )

    # 5. the data itself: day records missing for a large share of days
    cov = coverage_of(frame, cur.start, cur.end)
    if cov["coveragePct"] is not None and cov["coveragePct"] < COVERAGE_WARN_PCT:
        items.append(
            _insight(
                "attendance.coverage-gap",
                "warning" if cov["coveragePct"] < 75 else "info",
                f"Attendance records are missing for {round(100 - cov['coveragePct'], 1):g}% of scheduled days in the last 30 days",
                f"{cov['recordedDays']:,} of {cov['expectedDays']:,} employee-days have a day record, so the attendance figures cover only part of the workforce.",
                f"{cov['coveragePct']}%",
                "Which dates in the last 30 days have no attendance records, and which units are affected?",
                "attendance",
            )
        )

    # 6. good news
    now_pct = t_attendance(tally_rows(frame.window(cur.start, cur.end)))
    before_pct = t_attendance(tally_rows(frame.window(prev.start, prev.end)))
    if now_pct is not None and before_pct is not None and now_pct - before_pct >= GOOD_NEWS_MIN_PTS:
        items.append(
            _insight(
                "attendance.improved",
                "good",
                f"Attendance rose {round(now_pct - before_pct, 1):g} points to {now_pct:g}%",
                f"Against {before_pct:g}% in the previous 30 days.",
                f"{now_pct:g}%",
                "What drove the improvement in attendance over the last 30 days?",
                "attendance",
            )
        )
    items.sort(key=lambda i: SEVERITY_ORDER[i["severity"]])
    return items[:INSIGHT_LIMIT]


def _kpi(id: str, label: str, metric: dict | None, fmt: str, sub: str | None) -> dict:
    metric = metric or {}
    delta = metric.get("delta")
    return {
        "id": id,
        "label": label,
        "value": metric.get("value"),
        "format": fmt,
        "sub": sub,
        "delta": None if not delta else {"abs": delta["abs"], "pct": delta["pct"], "good": metric.get("good")},
        "spark": metric.get("spark") or None,
        "page": "attendance",
    }


@cached()
def headline(*, today: date | None = None) -> dict:
    """The Dashboard's attendance cards: today so far (provisional), and the last 30 days' absenteeism and late %, with
    sparklines and the direction that is good news. The numbers are the page's own (``summary_for``)."""
    today = today or ist_today()
    scope = Scope()
    period = Period(today - timedelta(days=29), today, "last_30_days", "Last 30 days")
    data = summary_for(scope, period, today)
    metrics = data.get("metrics") or {}
    live = data.get("live") or {}
    attendance_spark = (metrics.get("attendancePct") or {}).get("spark") or []

    if live.get("isWorkingDay"):
        today_value = live["attendancePct"]
        today_sub = f"{live['present']:,} of {live['expected']:,} in so far · provisional, the day is running"
    else:
        today_value = None
        today_sub = "Weekly off or holiday today" if live else None
    today_kpi = {
        "id": "attendance-today",
        "label": "Attendance today",
        "value": today_value,
        "format": "pct",
        "sub": today_sub,
        "delta": None,
        "spark": attendance_spark[-14:] or None,
        "page": "attendance",
    }

    def compare_text(key: str) -> str | None:
        previous = (metrics.get(key) or {}).get("previous")
        return None if previous is None else f"{previous:g}% in the previous 30 days"

    kpis = [
        today_kpi,
        _kpi(
            "absenteeism-30d",
            "Absenteeism, 30 days",
            metrics.get("absenteeismPct"),
            "pct",
            compare_text("absenteeismPct"),
        ),
        _kpi("late-30d", "Late arrivals, 30 days", metrics.get("latePct"), "pct", compare_text("latePct")),
    ]
    wanted = {"absenteeism-pct", "late-pct"}
    return {"kpis": kpis, "provenance": [_prov_live(), *[p for p in data.get("provenance", []) if p["id"] in wanted]]}


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param("How many rows to return (default 5, at most 15).", minimum=1, maximum=15)
_PERIOD_TEXT = (
    "A period: a preset (today, yesterday, last_7_days, last_30_days, last_90_days, this_week, last_week, this_month, "
    "last_month, last_12_months, this_year, this_fy), a month like 2026-09, or two dates like 2026-09-01..2026-09-15."
)


def _on_date_tool(*, scope: Scope, date: str, limit: int) -> dict:  # noqa: A002 - the parameter is called "date" for the model
    return attendance_on_date(scope, parse_day_param(date), limit)


def _compare_tool(*, scope: Scope, period_a: str, period_b: str) -> dict:
    return attendance_compare_periods(scope, period_from_text(period_a), period_from_text(period_b))


TOOLS = [
    tool(
        "attendance_summary",
        "Attendance headline figures for a period (default last 30 days), for the whole company or one unit, department "
        "or staff/production group: attendance %, absenteeism % (unplanned absence), late arrivals % and average minutes "
        "late, overtime hours, half days, leave days, missing-punch requests still waiting, scheduled days and data "
        "coverage, each with the previous period's value and the change. Use it for 'how was attendance', 'is "
        "absenteeism rising', 'how much overtime'. Percentages are 0-100. Today is left out (still running) and returned "
        "as a live 'in so far' count.",
        attendance_summary,
        page="attendance",
        period="last_30_days",
    ),
    tool(
        "attendance_trend",
        "Attendance %, absent %, late % and head counts over time: one point per working day, or per week when the "
        "period is longer than about two months. Use it for 'is attendance improving' or 'when did it dip'. "
        "Days nobody was scheduled (Sundays, holidays) have no point.",
        attendance_trend,
        page="attendance",
        period="last_30_days",
    ),
    tool(
        "attendance_by_department",
        "Departments ranked by attendance, lowest first: attendance %, absenteeism %, late %, overtime hours, headcount, "
        "the change against the previous period and an 8-week sparkline; also the same by unit and for staff against "
        "production. Use it for 'which department has the worst attendance' or 'how is Stitching doing'.",
        attendance_by_department,
        page="attendance",
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": 10},
    ),
    tool(
        "attendance_exceptions",
        "People and departments that need attention in a period: chronic absentees (3+ unplanned absence days), habitual "
        "late-comers, long unexplained absences (3+ days in a row, possible absconding), frequent missing-punch "
        "requesters, employees mostly absent after a weekly off or holiday, and departments well below the company's "
        "attendance. Returns names, codes, departments and the dates as evidence, plus the thresholds used. Use it for "
        "'who are the chronic absentees' or 'is anyone absconding'.",
        attendance_exceptions,
        page="attendance",
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": 5},
        person_fields=("name",),
    ),
    tool(
        "attendance_overtime",
        "Overtime in a period: total hours against the previous period, hours by department, the people with the most "
        "overtime, the trend, the mix of HR decisions (pay, relaxation, detected, rejected) and overtime as a share of "
        "scheduled hours. Staff only. Hours are informational: payroll pays one day's pay per announced Pay day, so use "
        "the payroll tools for the rupee cost. Use it for 'how much overtime' or 'who works the most overtime'.",
        attendance_overtime,
        page="attendance",
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": 5},
        person_fields=("name",),
    ),
    tool(
        "attendance_leave",
        "Leave and approvals in a period: approved leave days by leave type against the previous period, permissions "
        "taken, and the requests waiting for a decision right now (leave, casual leave, permission, missing punch) with "
        "how many days the oldest has waited. Use it for 'how much leave was taken' or 'what is waiting for approval'.",
        attendance_leave,
        page="attendance",
        period="last_30_days",
    ),
    tool(
        "attendance_on_date",
        "One day's attendance snapshot: how many people were in, absent, late or on leave, by unit, department and "
        "staff/production. Give date as YYYY-MM-DD, 'today' or 'yesterday' (default yesterday). For a past day it uses "
        "HR's attendance day records (and says how many are not recorded yet); for today it is a live, provisional count "
        "of who has punched in so far. Use it for 'how many people were absent yesterday in Stitching'.",
        _on_date_tool,
        page="attendance",
        extra={
            "date": string_param("The day: YYYY-MM-DD, 'today' or 'yesterday'."),
            "limit": integer_param("How many departments to list (default 10, at most 25).", minimum=1, maximum=25),
        },
        defaults={"date": "yesterday", "limit": 10},
    ),
    tool(
        "attendance_compare_periods",
        "Two periods side by side (for example this month against last month): attendance %, absenteeism %, late %, "
        "average minutes late, overtime hours, half days, leave days, missing punches, scheduled days and coverage for "
        "each, and the difference B minus A. Give each period as a preset (last_month), a month (2026-09) or two dates "
        "(2026-09-01..2026-09-15). Use it for 'how does September compare with August'.",
        _compare_tool,
        page="attendance",
        extra={
            "period_a": string_param(f"The first (base) period. {_PERIOD_TEXT}"),
            "period_b": string_param(f"The second period. {_PERIOD_TEXT}"),
        },
        required=("period_a", "period_b"),
        example={"period_a": "last_month", "period_b": "this_month"},
    ),
]
