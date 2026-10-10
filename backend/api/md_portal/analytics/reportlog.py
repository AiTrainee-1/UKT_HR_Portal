"""MD portal, Report Log: are absences being followed up, and who produces the attendance reports?

What the Report Log page really is
----------------------------------
It is **not** a list of reports that were produced or sent. It is the HR attendance register for the month (the
"Attendance Sheet" grid, plus the late-penalty breakdown behind payroll's deductions) and the **Daily Report**: the
list of employees who were absent on a day, where HR makes one call per person, *Informed* or *Not informed* (did they
tell anyone in advance?), and then exports the list as Excel, PDF or an image. Those exports are produced in the browser
and are not recorded anywhere, and nothing records that a report was sent to anyone.

So the honest questions an MD can ask of this page, and what the data can say:

* **Is the Daily Report being worked?** Every absence on a scheduled day is *marked* when HR picked Informed or Not
  informed (``AttendanceDayRecord.is_informed``: True / False) and *not yet marked* otherwise (NULL). The share marked is
  the follow-up rate; the days with several absences and nothing marked are the "gaps"; the Not-informed ones are the
  unauthorised absences. This module counts them with exactly the absence rule of the attendance analytics (the Report
  Center's day classification: a weekly off, a holiday, approved leave, today and days outside employment are not
  absences), so the figures agree with the Attendance page and the Absentee Analysis report.
* **Who exports attendance reports, and how often?** The audit trail (``AuditLog``, action ``export``) records the Report
  Center's exports (module ``reports``, titled "<report> - XLSX - 120 rows - ...") and the Attendance Search punch export
  (module ``attendance``). Attendance exports are the ones whose report belongs to the Report Center's Attendance group
  (or the punch export). Exports from the Report Log page itself are not in the audit trail.

What it cannot tell (and the page says so, in ``unknowns``): when or whether a report was *sent*, whether one was *late*
(no schedule or deadline exists), whether a run *failed* (failures are only in the server log), who set an Informed
mark or when (the mark is a bare yes / no), and exports made from the Report Log page itself.

Scope (unit / department / staff-production) applies to absences. An audit entry belongs to an HR user, not to an
employee, so export figures are for the whole company whatever the scope; the notes say so when a scope is chosen.

Nothing here writes; the REST views and the assistant tools run inside ``common.read_only_db()``.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from functools import reduce
from operator import or_
from typing import Any

from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate

from ...clock import FACTORY_TZ, ist_today
from ...models import AttendanceDayRecord, AuditLog
from ...reporting.registry import all_specs
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, prov
from . import attendance as A

PAGE = "report-log"

# ─── named thresholds (shown in provenance; the tests pin them) ─────────────────────────────────────────────────────

#: A day with at least this many absences and none of them marked: the Daily Report was not worked that day.
GAP_MIN_ABSENCES = 2
#: Fewer absences than this in the period is too few to call a follow-up rate a problem.
MIN_ABSENCES = 5
#: Share of absences marked (Informed or Not informed) below which follow-up is flagged, and below which it is critical.
LOW_REVIEW_PCT = 50.0
CRITICAL_REVIEW_PCT = 20.0
CRITICAL_MIN_ABSENCES = 15
#: Share of absences marked "Not informed" from which it is flagged (with at least MIN_ABSENCES of them).
NOT_INFORMED_WARN_PCT = 30.0
#: A department is a hot spot with this many absences, this share of them unmarked and 1.25x the company's share.
HOTSPOT_MIN_ABSENCES = 8
HOTSPOT_MIN_UNMARKED_PCT = 60.0
HOTSPOT_RATIO = 1.25
#: Exports have "stopped" when the last EXPORT_STOP_DAYS days hold none and the days before them at least this many.
EXPORT_STOP_DAYS = 14
EXPORT_STOP_MIN_BEFORE = 3
#: A group with fewer absences than this is marked "small sample" and never called out.
MIN_SAMPLE_ABSENCES = 5
WEEKLY_ROLLUP_AFTER_DAYS = 62
#: The gap calendar shows at most this many of the latest days (a long period would not fit a screen).
CALENDAR_MAX_DAYS = 120
#: Report titles are read from at most this many of the latest export entries.
MAX_EXPORT_ROWS = 5000
LIST_MAX = 25
LIST_DEFAULT = 10
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

#: What the data can never say about this page. Shown on the page and quoted by the assistant.
UNKNOWNS = [
    "Exports made from the Report Log page itself (the Excel, PDF or image of the absent list) are produced in the "
    "browser and are not recorded anywhere.",
    "Nothing records that a report was sent to anyone, so 'sent' and 'not sent' cannot be told apart.",
    "There is no schedule or deadline for a report, so a late or missing report cannot be judged.",
    "A failed export is only written to the server log, never to the audit trail, so failures and re-runs cannot be counted.",
    "An Informed / Not informed mark does not record who made it or when, so who followed up an absence is unknown.",
]

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}

#: how an absence was marked
UNMARKED, INFORMED, NOT_INFORMED = 0, 1, 2
# tally slots: absences, informed, not informed, unmarked
T_ABS, T_INF, T_NOT, T_UNM = range(4)


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────


def _num(value: float | int | None, places: int = 0) -> str:
    """12,34,567 (Indian grouping), because text built here is read by the MD as it is."""
    if value is None:
        return "n/a"
    number = round(float(value), places)
    whole, _, frac = f"{abs(number):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{'-' if number < 0 else ''}{whole}{'.' + frac if frac else ''}"


def _p(value: float | None, places: int = 0) -> str:
    return "n/a" if value is None else f"{_num(value, places)}%"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _int_arg(value: Any, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high], a readable error when not a number."""
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def _previous_phrase(period: Period) -> str:
    if period.days == 1:
        return "the day before"
    if period.days == 7:
        return "the 7 days before"
    return f"the previous {period.days} days"


def _wall(dt: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if dt is None:
        return None
    return dt.astimezone(FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def _bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """[start 00:00, end + 1 day 00:00) in factory time, as aware datetimes."""
    return (
        datetime.combine(start, time.min, tzinfo=FACTORY_TZ),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=FACTORY_TZ),
    )


def _days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def _share(tally: list[int]) -> dict:
    """The follow-up figures of one tally: marked, shares. "No data" is None, never 0: a rate needs absences."""
    absences = tally[T_ABS]
    marked = tally[T_INF] + tally[T_NOT]
    return {
        "absences": absences,
        "informed": tally[T_INF],
        "notInformed": tally[T_NOT],
        "unmarked": tally[T_UNM],
        "reviewedPct": pct(marked, absences),
        "notInformedPct": pct(tally[T_NOT], absences),
        "unmarkedPct": pct(tally[T_UNM], absences),
    }


# ─── absences, with how each was marked ─────────────────────────────────────────────────────────────────────────────


class _Windows:
    """The requested period split into what can be measured: ``measured`` is its complete days (today is left out, its
    absences only mean "not in yet"), ``previous`` the window of the same length just before it."""

    def __init__(self, period: Period, today: date) -> None:
        self.period = period
        self.today = today
        end = min(period.end, today - timedelta(days=1))
        self.measured = Period(period.start, end, period.preset, period.label) if end >= period.start else None
        self.previous = self.measured.previous() if self.measured and self.measured.days <= A.MAX_COMPARE_DAYS else None

    @property
    def start(self) -> date:
        return (self.previous or self.measured).start  # type: ignore[union-attr]

    @property
    def includes_today(self) -> bool:
        return self.period.end >= self.today


class _Absences:
    """Every absence on a scheduled day in the window, as ``(date, employee id, how it was marked)`` rows, the people
    behind them and the attendance coverage."""

    def __init__(self, scope: Scope, win: _Windows) -> None:
        self.win = win
        self.rows: list[tuple[date, int, int]] = []
        self.people: dict[int, Any] = {}
        self.frame: Any = None
        self.coverage: dict | None = None
        if win.measured is None:
            return
        frame = A.get_frame(scope, win.start, win.measured.end, win.today)
        self.frame, self.people = frame, frame.people
        # the engine stores "informed" as True; "not informed" is an explicit False, "not marked" is NULL
        not_informed = set(
            AttendanceDayRecord.objects.filter(
                scope.employee_q("employee__"),
                date__gte=win.start,
                date__lte=win.measured.end,
                status="absent",
                is_informed=False,
            )
            .order_by()
            .values_list("employee_id", "date")
        )
        for d, eid, code, flags in frame.window(win.start, win.measured.end):
            if code != A.SA:
                continue
            state = INFORMED if flags & A.INFORMED_FLAG else (NOT_INFORMED if (eid, d) in not_informed else UNMARKED)
            self.rows.append((d, eid, state))
        self.coverage = A.coverage_of(frame, win.measured.start, win.measured.end)

    def window(self, start: date, end: date) -> list[tuple[date, int, int]]:
        return [r for r in self.rows if start <= r[0] <= end]


def _tally(rows) -> list[int]:
    t = [0, 0, 0, 0]
    for _d, _eid, state in rows:
        t[T_ABS] += 1
        t[(T_UNM, T_INF, T_NOT)[state]] += 1
    return t


def _tally_by(rows, key) -> dict[Any, list[int]]:
    out: dict[Any, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for row in rows:
        t = out[key(row)]
        t[T_ABS] += 1
        t[(T_UNM, T_INF, T_NOT)[row[2]]] += 1
    return out


def _gap_days(rows) -> list[dict]:
    """Days with GAP_MIN_ABSENCES or more absences and none marked, oldest first."""
    by_day = _tally_by(rows, lambda r: r[0])
    return [
        {
            "date": d.isoformat(),
            "weekday": WEEKDAYS[d.weekday()],
            "absences": t[T_ABS],
            "unmarked": t[T_UNM],
        }
        for d, t in sorted(by_day.items())
        if t[T_ABS] >= GAP_MIN_ABSENCES and t[T_UNM] == t[T_ABS]
    ]


# ─── attendance report exports (the audit trail) ────────────────────────────────────────────────────────────────────


def _attendance_titles() -> list[str]:
    """The titles of the Report Center's Attendance reports, longest first (so "Late Coming Summary (Counts)" is not
    taken for "Late Coming Detail")."""
    return sorted({s.title for s in all_specs() if s.category == "attendance"}, key=lambda t: (-len(t), t))


def _attendance_q(titles: list[str]) -> Q:
    """An export entry that is an attendance report: the Attendance Search punch export, or a Report Center export whose
    description starts with an Attendance report's title (the Report Center writes "<title> - <format> - ...")."""
    by_title = reduce(or_, (Q(record_description__startswith=f"{t} - ") for t in titles), Q(pk__in=[]))
    return Q(module="attendance") | (Q(module="reports") & by_title)


def _exports(start: date, end: date):
    lo, hi = _bounds(start, end)
    return AuditLog.objects.filter(action="export", created_at__gte=lo, created_at__lt=hi)


def _export_totals(start: date, end: date, att: Q) -> dict:
    qs = _exports(start, end).annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
    raw = qs.aggregate(
        all=Count("id"),
        attendance=Count("id", filter=att),
        exporters=Count("user_name", distinct=True, filter=att),
        days=Count("d", distinct=True, filter=att),
        last=Max("created_at", filter=att),
    )
    return {
        "all": int(raw["all"] or 0),
        "attendance": int(raw["attendance"] or 0),
        "exporters": int(raw["exporters"] or 0),
        "days": int(raw["days"] or 0),
        "last": raw["last"],
    }


def _report_label(module: str, description: str, titles: list[str]) -> str:
    if module == "attendance":
        return "Attendance Search (punch export)"
    for title in titles:
        if description.startswith(f"{title} - "):
            return title
    return "Other attendance report"


# ─── provenance ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _provenance(scope: Scope, period: Period, *, rows: dict[str, int | None]) -> dict[str, dict]:
    filters = [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()]
    scheduled = [
        "Complete days only: today is left out (its absences only mean 'not in yet')",
        "Weekly offs, holidays, approved leave and days outside employment are not absences",
    ]
    return {
        "reportlog-absences": prov(
            "reportlog-absences",
            "Absences in the Daily Report",
            dataset="Attendance day records (what payroll pays from)",
            definition=(
                "An absence is a scheduled working day on which the day record says absent, counted exactly as the "
                "Attendance page and the Absentee Analysis report count it. These are the people the Report Log's Daily "
                "Report lists for HR to mark."
            ),
            formula="absent days on scheduled days in the period",
            rows=rows.get("absences"),
            filters=[*filters, *scheduled],
            caveats=[
                "Day records are created lazily, so days HR has not opened may be missing; the figures cover the days that exist.",
            ],
        ),
        "reportlog-followup": prov(
            "reportlog-followup",
            "Followed up (Informed / Not informed)",
            dataset="Attendance day records: the Informed / Not informed mark",
            definition=(
                "On the Daily Report HR marks each absent person Informed (told someone in advance) or Not informed. "
                "An absence is 'followed up' when it carries either mark; 'not yet marked' when HR has not chosen. "
                "Not informed absences are the unauthorised ones."
            ),
            formula="followed up % = (informed + not informed) ÷ absences × 100",
            rows=rows.get("absences"),
            filters=filters,
            caveats=[
                "The mark is only set when HR works the Daily Report; it does not change attendance or payroll.",
                "It does not record who marked it or when.",
            ],
        ),
        "reportlog-gaps": prov(
            "reportlog-gaps",
            "Days nobody made the call",
            dataset="Attendance day records: the Informed / Not informed mark",
            definition=(
                f"A day with {GAP_MIN_ABSENCES} or more absences where none of them carries an Informed or Not informed "
                "mark: the Daily Report was probably not worked that day."
            ),
            formula=f"days with absences ≥ {GAP_MIN_ABSENCES} and marked = 0",
            rows=rows.get("absences"),
            filters=filters,
            caveats=["A day that was worked but whose marks were later cleared looks the same."],
        ),
        "reportlog-exports": prov(
            "reportlog-exports",
            "Attendance report exports",
            dataset="Audit trail (exports)",
            definition=(
                "Each time someone exported an attendance report from the Report Center, or exported punches from "
                "Attendance Search, the audit trail records who, when and which report. 'Attendance report' means a "
                "report in the Report Center's Attendance group."
            ),
            formula="audit entries with action 'export' for those reports, counted on the day they were made (Indian time)",
            rows=rows.get("exports"),
            filters=[period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", "Whole company"],
            caveats=[
                "Exports from the Report Log page itself are produced in the browser and are NOT recorded.",
                "The audit trail belongs to HR users, not employees, so unit / department filters do not apply.",
                "Nothing records that a report was sent, was late or failed.",
            ],
        ),
        "reportlog-previous": prov(
            "reportlog-previous",
            "Comparison with the previous period",
            dataset="Attendance day records, audit trail",
            definition=(
                "Every change is against the period of the same length that ends the day before this one starts, "
                "worked out the same way."
            ),
            formula="change = this period − previous period (percentage figures change in points)",
            filters=[f"{period.previous().start.isoformat()} to {period.previous().end.isoformat()}"],
        ),
    }


def _pick(entries: dict[str, dict], *ids: str) -> list[dict]:
    return [entries[i] for i in ids if i in entries]


def _window_json(p: Period | None) -> dict | None:
    return {"start": p.start.isoformat(), "end": p.end.isoformat(), "days": p.days} if p else None


def _notes(win: _Windows, ab: _Absences, scope: Scope) -> list[str]:
    notes: list[str] = []
    if win.measured is None:
        notes.append(
            "Today is still running, so this period has no completed day yet: absences are shown once the day is over."
        )
    elif win.includes_today:
        notes.append(
            "Today is still running and is left out of the absence figures (its absences only mean 'not in yet')."
        )
    cov = ab.coverage
    if win.measured is not None and ab.people and not ab.frame.rows:
        notes.append(
            "No attendance day records exist for these days: HR has not opened or processed them in Attendance yet."
        )
    elif cov and cov["partial"]:
        notes.append(
            f"Attendance day records exist for {_p(cov['coveragePct'], 1)} of scheduled days "
            f"({_num(cov['recordedDays'])} of {_num(cov['expectedDays'])} employee-days): absences are counted for the "
            "days HR has processed."
        )
    if win.measured is not None and win.previous is None:
        notes.append(
            f"The comparison with the previous period is not shown for periods longer than {A.MAX_COMPARE_DAYS} days."
        )
    if not scope.is_everyone():
        notes.append("Export figures are for the whole company: the audit trail is not split by unit or department.")
    return notes


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────────

_FOLLOWUP_KEYS = ("absences", "informed", "notInformed", "unmarked", "reviewedPct", "notInformedPct")


@cached()
def reportlog_summary(scope: Scope, period: Period) -> dict:
    """Absences on scheduled days and how many were followed up (Informed / Not informed / not yet marked), the days
    nobody made the call, and the attendance report exports on record, each against the previous period."""
    today = ist_today()
    win = _Windows(period, today)
    ab = _Absences(scope, win)
    cur = _share(_tally(ab.window(win.measured.start, win.measured.end))) if win.measured else None
    prev = _share(_tally(ab.window(win.previous.start, win.previous.end))) if win.previous else None
    titles = _attendance_titles()
    att = _attendance_q(titles)
    previous_period = period.previous()
    exp_cur = _export_totals(period.start, period.end, att)
    exp_prev = _export_totals(previous_period.start, previous_period.end, att)

    def metric(key: str) -> dict:
        value = cur[key] if cur else None
        before = prev[key] if prev else None
        return {"value": value, "previous": before, "change": change(value, before)}

    metrics = {key: metric(key) for key in _FOLLOWUP_KEYS}
    for key, source in (
        ("exports", "attendance"),
        ("exportsAll", "all"),
        ("exporters", "exporters"),
        ("exportDays", "days"),
    ):
        metrics[key] = {
            "value": exp_cur[source],
            "previous": exp_prev[source],
            "change": change(exp_cur[source], exp_prev[source]),
        }
    gap = _gap_days(ab.window(win.measured.start, win.measured.end)) if win.measured else []
    last_rows = list(
        _exports(period.start, period.end)
        .filter(att)
        .order_by("-created_at")
        .values_list("created_at", "user_name", "module", "record_description")[:1]
    )
    latest = None
    if last_rows:
        at, who, module, description = last_rows[0]
        latest = {
            "at": _wall(at),
            "userName": who or "Unknown",
            "report": _report_label(module, description or "", titles),
        }

    entries = _provenance(
        scope,
        period,
        rows={"absences": cur["absences"] if cur else 0, "exports": exp_cur["attendance"]},
    )
    notes = _notes(win, ab, scope)
    if win.measured is not None and cur["absences"] == 0 and not win.includes_today:
        notes.append(f"There were no absences on scheduled days in this selection ({period.label}).")
    return envelope(
        {
            "measured": _window_json(win.measured),
            "previous": _window_json(win.previous),
            "previousPeriod": previous_period.to_json(),
            "metrics": metrics,
            "gapDays": len(gap),
            "gapMinAbsences": GAP_MIN_ABSENCES,
            "coverage": ab.coverage,
            "latestExport": latest,
            "unknowns": list(UNKNOWNS),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "reportlog-absences",
            "reportlog-followup",
            "reportlog-gaps",
            "reportlog-exports",
            "reportlog-previous",
        ),
        notes=notes,
    )


# ─── trend and the gap calendar ─────────────────────────────────────────────────────────────────────────────────────


def _daily_exports(start: date, end: date, att: Q) -> dict[date, int]:
    qs = (
        _exports(start, end)
        .filter(att)
        .annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("d")
        .annotate(n=Count("id"))
        .order_by()
    )
    return {r["d"]: r["n"] for r in qs}


def _point(first_day: date, days: int, tally: list[int] | None, exports: int) -> dict:
    s = _share(tally) if tally is not None else _share([0, 0, 0, 0])
    unmeasured = tally is None
    return {
        "date": first_day.isoformat(),
        "days": days,
        "absences": None if unmeasured else s["absences"],
        "informed": None if unmeasured else s["informed"],
        "notInformed": None if unmeasured else s["notInformed"],
        "unmarked": None if unmeasured else s["unmarked"],
        "reviewedPct": None if unmeasured else s["reviewedPct"],
        "exports": exports,
    }


@cached()
def reportlog_trend(scope: Scope, period: Period) -> dict:
    """Absences by how they were marked, and attendance report exports, day by day (week by week beyond 62 days)."""
    today = ist_today()
    win = _Windows(period, today)
    ab = _Absences(scope, win)
    att = _attendance_q(_attendance_titles())
    exports = _daily_exports(period.start, period.end, att)
    by_day = _tally_by(ab.rows, lambda r: r[0])
    measured_end = win.measured.end if win.measured else None
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    points: list[dict] = []
    if weekly:
        weeks: dict[date, list[date]] = {}
        for d in _days(period.start, period.end):
            weeks.setdefault(d - timedelta(days=d.weekday()), []).append(d)
        for days in weeks.values():
            known = [d for d in days if measured_end and d <= measured_end]
            tally = [0, 0, 0, 0]
            for d in known:
                for i, v in enumerate(by_day.get(d, [0, 0, 0, 0])):
                    tally[i] += v
            points.append(_point(days[0], len(days), tally if known else None, sum(exports.get(d, 0) for d in days)))
    else:
        for d in _days(period.start, period.end):
            known = measured_end is not None and d <= measured_end
            points.append(_point(d, 1, by_day.get(d, [0, 0, 0, 0]) if known else None, exports.get(d, 0)))
    entries = _provenance(scope, period, rows={"absences": sum(p["absences"] or 0 for p in points)})
    entry = prov(
        "reportlog-trend",
        "Trend",
        dataset="Attendance day records, audit trail",
        definition=(
            "Each day's absences split by how HR marked them, and the attendance report exports made that day. "
            f"Periods over {WEEKLY_ROLLUP_AFTER_DAYS} days are shown by week (Monday to Sunday). Today and any later "
            "day have no absence figures: the day is still running."
        ),
        formula="absences = informed + not informed + not yet marked",
        rows=sum(p["absences"] or 0 for p in points),
        filters=[period.label, scope.describe()],
        caveats=["Exports are for the whole company and exclude the Report Log page's own (unrecorded) exports."],
    )
    return envelope(
        {"granularity": "week" if weekly else "day", "points": points, "measured": _window_json(win.measured)},
        period=period,
        scope=scope,
        provenance=[entry, *_pick(entries, "reportlog-absences", "reportlog-followup", "reportlog-exports")],
        notes=_notes(win, ab, scope),
    )


@cached()
def reportlog_gaps(scope: Scope, period: Period) -> dict:
    """The gap calendar: every day of the period with its absences, how they were marked and the exports made, and the
    days nobody made the Informed / Not informed call."""
    today = ist_today()
    win = _Windows(period, today)
    ab = _Absences(scope, win)
    att = _attendance_q(_attendance_titles())
    first = max(period.start, period.end - timedelta(days=CALENDAR_MAX_DAYS - 1))
    exports = _daily_exports(first, period.end, att)
    by_day = _tally_by(ab.rows, lambda r: r[0])
    measured_end = win.measured.end if win.measured else None
    days = []
    for d in _days(first, period.end):
        known = measured_end is not None and d <= measured_end
        t = by_day.get(d, [0, 0, 0, 0]) if known else None
        s = _share(t) if t is not None else None
        days.append(
            {
                "date": d.isoformat(),
                "weekday": WEEKDAYS[d.weekday()],
                "absences": s["absences"] if s else None,
                "informed": s["informed"] if s else None,
                "notInformed": s["notInformed"] if s else None,
                "unmarked": s["unmarked"] if s else None,
                "exports": exports.get(d, 0),
            }
        )
    gap = _gap_days(ab.window(win.measured.start, win.measured.end)) if win.measured else []
    with_absences = sum(1 for d in days if d["absences"])
    fully_marked = sum(1 for d in days if d["absences"] and d["unmarked"] == 0)
    entries = _provenance(scope, period, rows={"absences": sum(d["absences"] or 0 for d in days)})
    return envelope(
        {
            "days": days,
            "truncated": first > period.start,
            "gapDays": gap,
            "gapDayCount": len(gap),
            "minAbsences": GAP_MIN_ABSENCES,
            "daysWithAbsences": with_absences,
            "daysFullyMarked": fully_marked,
            "measured": _window_json(win.measured),
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "reportlog-gaps", "reportlog-followup", "reportlog-exports"),
        notes=[
            *_notes(win, ab, scope),
            *([f"Showing the latest {CALENDAR_MAX_DAYS} days of the period."] if first > period.start else []),
        ],
    )


# ─── follow-up by department, unit or staff/production ──────────────────────────────────────────────────────────────

_GROUP_KEYS = {
    "department": lambda p: p.dept,
    "unit": lambda p: p.unit,
    "type": lambda p: {"staff": "Staff", "production": "Production"}.get(p.employment_type, p.employment_type),
}
BY_CHOICES = tuple(_GROUP_KEYS)


@cached()
def reportlog_breakdown(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    """Where absences are not followed up: by department (the same name in several units is one department), unit, or
    staff vs production, ranked by absences nobody has marked."""
    if by not in _GROUP_KEYS:
        raise MdParamError(f"'by' must be one of: {', '.join(BY_CHOICES)}.")
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    today = ist_today()
    win = _Windows(period, today)
    ab = _Absences(scope, win)
    label = _GROUP_KEYS[by]
    people = ab.people
    cur_rows = ab.window(win.measured.start, win.measured.end) if win.measured else []
    prev_rows = ab.window(win.previous.start, win.previous.end) if win.previous else []
    cur = _tally_by(cur_rows, lambda r: label(people[r[1]]))
    prev = _tally_by(prev_rows, lambda r: label(people[r[1]]))
    heads: dict[str, int] = defaultdict(int)
    for p in people.values():
        if p.status == "active":
            heads[label(p)] += 1
    rows = []
    for name, t in cur.items():
        s = _share(t)
        before = _share(prev[name]) if name in prev else _share([0, 0, 0, 0])
        rows.append(
            {
                "key": name,
                "label": name,
                "headcount": heads.get(name, 0),
                **s,
                "lowSample": t[T_ABS] < MIN_SAMPLE_ABSENCES,
                "previous": {"absences": before["absences"], "reviewedPct": before["reviewedPct"]},
                "change": {
                    "absences": change(s["absences"], before["absences"]),
                    "reviewedPct": change(s["reviewedPct"], before["reviewedPct"]),
                },
            }
        )
    rows.sort(key=lambda r: (-r["unmarked"], -r["absences"], r["label"].lower()))
    total = _share(_tally(cur_rows))
    entries = _provenance(scope, period, rows={"absences": total["absences"]})
    grouping = prov(
        "reportlog-grouping",
        "Comparison",
        dataset="Attendance day records, employee list",
        definition=(
            "Absences are grouped by the department, unit or type each employee belongs to today (there is no history "
            "of transfers). A department with the same name in several units is one department. Ranked by absences "
            "not yet marked, most first."
        ),
        formula="per group: absences, marked Informed, marked Not informed, not yet marked; followed up % = marked ÷ absences",
        rows=total["absences"],
        filters=[period.label, scope.describe()],
        caveats=[
            f"Groups with fewer than {MIN_SAMPLE_ABSENCES} absences are marked 'small sample' and never called out."
        ],
    )
    return envelope(
        {
            "by": by,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "average": total,
            "minSample": MIN_SAMPLE_ABSENCES,
        },
        period=period,
        scope=scope,
        provenance=[grouping, *_pick(entries, "reportlog-followup", "reportlog-previous")],
        notes=_notes(win, ab, scope),
    )


# ─── who exports attendance reports ─────────────────────────────────────────────────────────────────────────────────


@cached()
def reportlog_exports(period: Period, limit: int = LIST_DEFAULT) -> dict:
    """Who exported attendance reports in the period and how often, which reports, and the latest exports. Whole
    company: the audit trail is not split by unit or department. Names are shown (they are HR users)."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    titles = _attendance_titles()
    att = _attendance_q(titles)
    previous = period.previous()
    totals = _export_totals(period.start, period.end, att)
    before = _export_totals(previous.start, previous.end, att)
    base = _exports(period.start, period.end).filter(att)
    by_user = list(
        base.annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("user_name")
        .annotate(n=Count("id"), days=Count("d", distinct=True), last=Max("created_at"))
        .order_by("-n", "user_name")
    )
    newest = list(
        base.order_by("-created_at", "-id").values_list("created_at", "user_name", "module", "record_description")[
            :MAX_EXPORT_ROWS
        ]
    )
    by_report: dict[str, int] = defaultdict(int)
    for _at, _who, module, description in newest:
        by_report[_report_label(module, description or "", titles)] += 1
    reports = sorted(by_report.items(), key=lambda kv: (-kv[1], kv[0]))
    latest = [
        {"at": _wall(at), "userName": who or "Unknown", "report": _report_label(module, description or "", titles)}
        for at, who, module, description in newest[:5]
    ]
    entries = _provenance(Scope(), period, rows={"exports": totals["attendance"]})
    notes = [] if totals["attendance"] else [f"No attendance report export is on record for {period.label}."]
    if totals["attendance"] > MAX_EXPORT_ROWS:
        notes.append(f"The report list is read from the latest {_num(MAX_EXPORT_ROWS)} exports.")
    notes.append("Exports made from the Report Log page itself are not recorded, so they are not in these figures.")
    return envelope(
        {
            "totals": {
                "attendance": totals["attendance"],
                "all": totals["all"],
                "otherReports": totals["all"] - totals["attendance"],
                "exporters": totals["exporters"],
                "days": totals["days"],
                "daysInPeriod": period.days,
                "previousAttendance": before["attendance"],
                "change": change(totals["attendance"], before["attendance"])
                if (totals["attendance"] or before["attendance"])
                else None,
            },
            "byUser": [
                {
                    "userName": r["user_name"] or "Unknown",
                    "exports": r["n"],
                    "days": r["days"],
                    "sharePct": pct(r["n"], totals["attendance"]),
                    "lastAt": _wall(r["last"]),
                }
                for r in by_user[:limit]
            ],
            "usersTotal": len(by_user),
            "byReport": [
                {"report": name, "exports": n, "sharePct": pct(n, len(newest))} for name, n in reports[:limit]
            ],
            "reportsTotal": len(reports),
            "latest": latest,
            "unknowns": list(UNKNOWNS),
        },
        period=period,
        provenance=_pick(entries, "reportlog-exports", "reportlog-previous"),
        notes=notes,
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ──────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"reportlog.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _exceptions(scope: Scope, period: Period, *, limit: int) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``.
    Built on the public analytics so a flag always points at a figure that is on the page."""
    summary = reportlog_summary(scope, period)
    m = summary["metrics"]
    absences = m["absences"]["value"]
    items: list[dict] = []
    if absences:
        reviewed = m["reviewedPct"]["value"]
        unmarked = m["unmarked"]["value"]
        not_informed = m["notInformed"]["value"]

        if absences >= MIN_ABSENCES and reviewed is not None and reviewed < LOW_REVIEW_PCT:
            critical = reviewed < CRITICAL_REVIEW_PCT and absences >= CRITICAL_MIN_ABSENCES
            items.append(
                _item(
                    "unmarked",
                    "critical" if critical else "warning",
                    f"{_num(unmarked)} of {_num(absences)} absences have no Informed / Not informed call",
                    f"{period.label}: only {_p(reviewed)} were followed up on the Daily Report, so who was away without "
                    "telling anyone is not known for the rest.",
                    _p(reviewed),
                    f"Why are so many absences not marked Informed or Not informed ({period.label}), and where?",
                )
            )

        gaps = summary["gapDays"]
        if gaps >= 2:
            items.append(
                _item(
                    "gap-days",
                    "warning",
                    f"{_num(gaps)} days had {GAP_MIN_ABSENCES}+ absences and nobody made the call",
                    f"{period.label}: the Daily Report was probably not worked on those days.",
                    _num(gaps),
                    f"Which days had absences but no Informed / Not informed marks ({period.label})?",
                )
            )

        not_pct = m["notInformedPct"]["value"]
        if (
            absences >= MIN_ABSENCES
            and not_informed >= MIN_ABSENCES
            and not_pct is not None
            and not_pct >= NOT_INFORMED_WARN_PCT
        ):
            items.append(
                _item(
                    "not-informed",
                    "warning",
                    f"{_p(not_pct)} of absences were marked Not informed",
                    f"{period.label}: {_num(not_informed)} of {_num(absences)} absences, people who did not tell anyone in advance.",
                    _num(not_informed),
                    f"Who and which departments had absences marked Not informed ({period.label})?",
                )
            )

        departments = reportlog_breakdown(scope, period, by="department", limit=LIST_MAX)["rows"]
        company_unmarked = m["unmarked"]["value"] and 100.0 * unmarked / absences
        hot = [
            r
            for r in departments
            if not r["lowSample"]
            and r["absences"] >= HOTSPOT_MIN_ABSENCES
            and (r["unmarkedPct"] or 0) >= HOTSPOT_MIN_UNMARKED_PCT
            and (r["unmarkedPct"] or 0) >= HOTSPOT_RATIO * (company_unmarked or 0)
        ]
        if hot:
            top = max(hot, key=lambda r: (r["unmarked"], r["absences"]))
            items.append(
                _item(
                    "hot-spot",
                    "info",
                    f"{top['label']}: {_num(top['unmarked'])} of {_num(top['absences'])} absences have no call",
                    f"{period.label}: {_p(top['unmarkedPct'])} of its absences are not marked, against "
                    f"{_p(company_unmarked)} for the company.",
                    _p(top["unmarkedPct"]),
                    f"Why are {top['label']} absences not being marked Informed or Not informed ({period.label})?",
                )
            )

        if absences >= MIN_ABSENCES and reviewed is not None and reviewed >= 90.0 and not items:
            items.append(
                _item(
                    "healthy",
                    "good",
                    f"Absences are being followed up: {_p(reviewed)} have a call",
                    f"{period.label}: {_num(absences - unmarked)} of {_num(absences)} absences are marked Informed or Not informed.",
                    _p(reviewed),
                    f"Summarise absence follow-up on the Report Log ({period.label}).",
                )
            )

    exports, before = m["exports"]["value"], m["exports"]["previous"]
    if period.days >= EXPORT_STOP_DAYS and exports == 0 and before >= EXPORT_STOP_MIN_BEFORE:
        items.append(
            _item(
                "exports-stopped",
                "info",
                "No attendance report has been exported lately",
                f"{period.label}: none on record, against {_num(before)} in {_previous_phrase(period)}. Exports from the "
                "Report Log page itself are not recorded, so people may be using that instead.",
                "0",
                f"Who stopped exporting attendance reports, and why ({period.label})?",
            )
        )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


@cached()
def reportlog_attention(scope: Scope, period: Period) -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    items = _exceptions(scope, period, limit=6)
    rules = prov(
        "reportlog-attention",
        "Needs your attention",
        dataset="Attendance day records, audit trail",
        definition=(
            f"Flagged: fewer than {_p(LOW_REVIEW_PCT)} of absences marked (critical under {_p(CRITICAL_REVIEW_PCT)} with "
            f"{CRITICAL_MIN_ABSENCES}+ absences; needs {MIN_ABSENCES}+ absences); {GAP_MIN_ABSENCES}+ absences on a day with "
            f"nothing marked, on 2 or more days; {_p(NOT_INFORMED_WARN_PCT)}+ of absences marked Not informed; a department "
            f"with {HOTSPOT_MIN_ABSENCES}+ absences, {_p(HOTSPOT_MIN_UNMARKED_PCT)}+ of them unmarked and "
            f"{HOTSPOT_RATIO}x the company's share; attendance exports that stopped after at least "
            f"{EXPORT_STOP_MIN_BEFORE} in the period before."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe()],
        caveats=["These are rules of thumb: no follow-up target or report schedule is configured in the system."],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[rules])


# ─── the plain-English summary ──────────────────────────────────────────────────────────────────────────────────────


def _sentence(id_: str, text: str, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "tone": tone}


@cached()
def reportlog_briefing(scope: Scope, period: Period) -> dict:
    """Two to four plain sentences with the numbers, written by fixed rules from the same figures as the cards (no AI):
    absence follow-up, the gaps, who exports reports, and what cannot be known."""
    summary = reportlog_summary(scope, period)
    m = summary["metrics"]
    absences = m["absences"]["value"]
    sentences: list[dict] = []
    if absences is None:
        sentences.append(
            _sentence("followup", f"{period.label} has no completed day yet, so there are no absences to follow up.")
        )
    elif absences == 0:
        sentences.append(_sentence("followup", f"There were no absences on scheduled days in {period.label.lower()}."))
    else:
        reviewed = m["reviewedPct"]["value"]
        unmarked = m["unmarked"]["value"]
        tone = "good" if (reviewed or 0) >= 90 else ("bad" if (reviewed or 0) < LOW_REVIEW_PCT else "neutral")
        sentences.append(
            _sentence(
                "followup",
                f"{period.label}: {_num(absences)} {_plural(absences, 'absence')} on scheduled days; {_p(reviewed)} have an "
                f"Informed ({_num(m['informed']['value'])}) or Not informed ({_num(m['notInformed']['value'])}) mark"
                f"{', ' + _num(unmarked) + ' still unmarked' if unmarked else ''}.",
                tone,
            )
        )
        gaps = summary["gapDays"]
        if gaps:
            sentences.append(
                _sentence(
                    "gaps",
                    f"{_num(gaps)} {_plural(gaps, 'day')} had {GAP_MIN_ABSENCES}+ absences with nothing marked, so the "
                    "Daily Report was probably not worked then.",
                    "bad",
                )
            )
        worst = reportlog_breakdown(scope, period, by="department", limit=1)["rows"]
        if worst and worst[0]["unmarked"]:
            w = worst[0]
            sentences.append(
                _sentence(
                    "where",
                    f"{w['label']} has the most unmarked absences: {_num(w['unmarked'])} of its {_num(w['absences'])}.",
                )
            )
    exports = m["exports"]["value"]
    if exports:
        sentences.append(
            _sentence(
                "exports",
                f"{_num(exports)} attendance report {_plural(exports, 'export is', 'exports are')} on record for "
                f"{period.label.lower()}, by {_num(m['exporters']['value'])} {_plural(m['exporters']['value'], 'person', 'people')} "
                f"on {_num(m['exportDays']['value'])} of {_num(period.days)} days.",
            )
        )
    else:
        sentences.append(_sentence("exports", f"No attendance report export is on record for {period.label.lower()}."))
    sentences.append(
        _sentence(
            "limits",
            "Exports from the Report Log page itself, whether a report was sent, and who marked an absence are not recorded.",
        )
    )
    return envelope(
        {
            "sentences": sentences,
            "text": " ".join(s["text"] for s in sentences),
            "ask": f"Give me a briefing on the Report Log ({period.label}): are absences being followed up, and who exports attendance reports?",
        },
        period=period,
        scope=scope,
        provenance=summary["provenance"][:4],
        notes=summary["notes"],
    )


# ─── the Dashboard's pieces ─────────────────────────────────────────────────────────────────────────────────────────


def _windows_to_yesterday(today: date | None, days: int) -> Period:
    today = today or ist_today()
    end = today - timedelta(days=1)
    return Period(end - timedelta(days=days - 1), end, None, f"Last {days} days")


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3). The window
    is the last 14 complete days: absences are sparse, so a week is too short to call a follow-up rate."""
    return _exceptions(Scope(), _windows_to_yesterday(today, 14), limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's Report Log cards: the share of absences followed up in the last 7 complete days (against the 7
    before), the absences marked Not informed, and the attendance report exports on record."""
    current = _windows_to_yesterday(today, 7)
    previous = current.previous()
    scope = Scope()
    win = _Windows(current, (today or ist_today()))
    ab = _Absences(scope, win)
    cur = _share(_tally(ab.window(current.start, current.end)))
    prev = _share(_tally(ab.window(previous.start, previous.end)))
    att = _attendance_q(_attendance_titles())
    exp = _export_totals(current.start, current.end, att)["attendance"]
    exp_prev = _export_totals(previous.start, previous.end, att)["attendance"]
    by_day = _tally_by(ab.rows, lambda r: r[0])
    days = list(_days(previous.start, current.end))
    sub_window = f"{current.start:%d %b} to {current.end:%d %b}"
    reviewed_delta = change(cur["reviewedPct"], prev["reviewedPct"])
    not_delta = change(cur["notInformed"], prev["notInformed"]) if (cur["notInformed"] or prev["notInformed"]) else None
    exports_delta = change(exp, exp_prev) if (exp or exp_prev) else None
    kpis = [
        {
            "id": "reportlog.reviewed-pct",
            "label": "Absences followed up",
            "value": cur["reviewedPct"],
            "format": "pct",
            "sub": (
                f"{_num(cur['informed'] + cur['notInformed'])} of {_num(cur['absences'])} absences marked · {sub_window}"
                if cur["absences"]
                else f"No absences on scheduled days · {sub_window}"
            ),
            "delta": {**reviewed_delta, "good": "up"} if reviewed_delta else None,
            "spark": [_share(by_day[d])["reviewedPct"] if d in by_day else None for d in days],
            "page": PAGE,
        },
        {
            "id": "reportlog.not-informed",
            "label": "Not-informed absences",
            "value": cur["notInformed"],
            "format": "number",
            "sub": f"{_num(cur['unmarked'])} more not yet marked · {sub_window}",
            "delta": {**not_delta, "good": "down"} if not_delta else None,
            "spark": [by_day[d][T_NOT] if d in by_day else 0 for d in days],
            "page": PAGE,
        },
        {
            "id": "reportlog.exports",
            "label": "Attendance report exports",
            "value": exp,
            "format": "number",
            "sub": f"On record · {sub_window}",
            "delta": {**exports_delta, "good": None} if exports_delta else None,
            "spark": None,
            "page": PAGE,
        },
    ]
    entries = _provenance(scope, current, rows={"absences": cur["absences"], "exports": exp})
    return {
        "kpis": kpis,
        "provenance": _pick(
            entries, "reportlog-absences", "reportlog-followup", "reportlog-exports", "reportlog-previous"
        ),
    }


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)


def _breakdown_tool(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    return reportlog_breakdown(scope, period, by=by, limit=limit)


def _exports_tool(period: Period, limit: int = LIST_DEFAULT) -> dict:
    return reportlog_exports(period, limit=limit)


TOOLS = [
    tool(
        "report_log_summary",
        "The Report Log (HR's daily absence report and attendance register) for a period: absences on scheduled days and "
        "how many HR followed up on the Daily Report (marked Informed, marked Not informed, or not yet marked), the "
        "followed-up %, the days with absences and nothing marked, and the attendance report exports on record (count, "
        "people, days), each with the previous period. Also says what the data cannot show (reports sent, late or failed, "
        "who marked an absence). Use for 'are absences being followed up', 'how many unauthorised absences' and 'how "
        "often are attendance reports produced'. Percentages are 0-100.",
        reportlog_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "report_log_trend",
        "Absences day by day (week by week for periods over 62 days) split by how they were marked (Informed, Not "
        "informed, not yet marked) with the followed-up %, plus the attendance report exports made each day. Use for "
        "'is follow-up getting better' and 'what happened last week on absences'.",
        reportlog_trend,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "report_log_followup_by_group",
        "Where absences are not followed up, by department, unit or staff-vs-production type: absences, marked Informed, "
        "marked Not informed, not yet marked, followed-up % and the change against the previous period. Ranked by "
        "absences nobody has marked; small samples are flagged. Use for 'which department does not mark absences' and "
        "'where are the unauthorised absences'.",
        _breakdown_tool,
        page=PAGE,
        period="last_30_days",
        extra={"by": string_param("What to group by", enum=list(BY_CHOICES)), "limit": _LIMIT},
        defaults={"by": "department", "limit": LIST_DEFAULT},
    ),
    tool(
        "report_log_gap_days",
        f"The days with {GAP_MIN_ABSENCES}+ absences where nobody made the Informed / Not informed call (the Daily Report "
        "was probably not worked), with the day-by-day calendar of absences, marks and exports. Use for 'on which days was "
        "the absence report not done' and 'are there gaps'.",
        reportlog_gaps,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "report_log_exports",
        "Who exported attendance reports (Report Center attendance reports and Attendance Search punch exports) in the "
        "period and how often: totals against the previous period, per person (exports, days, last export), per report, "
        "and the latest exports. Whole company (the audit trail has no unit). Exports from the Report Log page itself are "
        "not recorded. Use for 'who produces the attendance reports' and 'how often are reports exported'.",
        _exports_tool,
        page=PAGE,
        period="last_30_days",
        scope=False,
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
        person_fields=("userName",),
    ),
]
