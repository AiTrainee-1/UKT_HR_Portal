"""MD portal, Branches: how do the company's units compare, side by side?

A unit (``Branch``) has people, attendance, overtime and payroll. This module puts the units next to each other: one row
per unit, every figure with the company's figure beside it, the difference, and the unit's rank. Nothing here is a new
definition: each figure comes from the module that owns it, by the very same helpers, so a number on the Branches page
means exactly what it means on the Attendance, Employees and Payroll pages (md-portal.md section 2, "shared
definitions") and the assistant cannot disagree with any of them:

* attendance %, absenteeism %, late %  the attendance module's classified day records (``attendance.frame_for``), grouped
                                        by the employee's unit; complete days only (today is left out)
* overtime hours                        ``OvertimeRecord`` minutes, rejected days left out, staff only, as on Attendance
* headcount, joiners, leavers, attrition, tenure   the employees module's rebuilt roll (``employees.load`` / ``flow``)
* payroll cost, cost per head           the salary slips of the latest CLOSED month (``payroll`` helpers)

Windows. The attendance figures, overtime, joiners and leavers cover the period the MD chose. Headcount and tenure are
"today". Attrition is always the last 12 months (a 30-day rate would be noise). Payroll is the latest closed month,
because that is the only month whose money is final. Each of these is named in the figure's provenance.

"Company" means everyone in the selected scope (unit, department and type filters apply), pooled: the company's
attendance % is all its scheduled days together, not the average of the units' percentages, so it equals the Attendance
page's figure for the same period and scope.

Ranks. Rank 1 is the best unit for a rate whose good direction is known (highest attendance, lowest absenteeism) and the
largest for everything else (headcount, payroll cost). Units with the same figure share a rank (1, 1, 3), and a unit with
no figure is left out of the ranking, never ranked last.

Everything here is read-only; the REST views and the assistant tools run inside ``common.read_only_db()``.
"""

from __future__ import annotations

import dataclasses
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import cached_property
from typing import Any, Callable

from django.db.models import Count, Q, Sum

from ...clock import ist_today
from ...models import Branch, Department, OvertimeRecord
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, envelope, pct, period_for_preset, prov, resolve_scope
from . import attendance as att
from . import employees as emp
from . import payroll as pay
from .dashboard import inr_compact

PAGE = "branches"

# ─── named thresholds (shown in provenance; the tests pin them) ───────────────────────────────────────────────────

#: A unit with fewer active people than this is too small to be called out: three people at 66% is not news.
MIN_UNIT_HEADCOUNT = 5
#: A unit this many points below the company's attendance % is flagged; at CRITICAL it is critical.
GAP_WARN_PTS = 3.0
GAP_CRITICAL_PTS = 6.0
#: A unit whose late-arrival rate is this many points above the company's is flagged.
LATE_GAP_PTS = 4.0
#: Overtime per day of the period, against the unit's own per-day average over the 90 days before it.
OT_SPIKE_RATIO = 2.0
OT_SPIKE_MIN_HOURS = 8.0
OT_BASELINE_DAYS = 90
#: A unit's 12-month attrition at this multiple of the company's (with enough leavers and people) is a hot-spot.
ATTRITION_FACTOR = 1.5
ATTRITION_MIN_LEAVERS = 3
ATTRITION_MIN_AVERAGE = 10
#: A difference from the company smaller than this is "similar" (points for a rate, per cent for an average).
SIMILAR_POINTS = 1.0
SIMILAR_PCT = 5.0
#: Every unit is within this many attendance points of the best one: said as good news when nothing else is flagged.
ALIGNED_POINTS = 2.0
LIST_MAX = 25
LIST_DEFAULT = 10
MAX_TREND_UNITS = 12
TREND_PAYROLL_MONTHS = 12
INSIGHT_LIMIT = 5
ATTENTION_LIMIT = 6
DEFAULT_PERIOD = "last_30_days"

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ─── what is compared ─────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Metric:
    id: str
    label: str
    #: number | pct | hours | years | inr_compact: how the screen writes the value
    format: str
    #: which direction is good news (None: neither: it is a size, or a mix)
    good: str | None
    #: rate = a ratio (compare in points); average = per person (compare in per cent); total = a size (share of company)
    kind: str
    group: str  # people | attendance | money
    #: which window the figure covers: today | period | year | payroll
    window: str
    decimals: int
    hint: str

    @property
    def rank_best_first(self) -> bool:
        """Rank 1 is the best unit (a rate or average with a good direction), else the largest."""
        return self.kind != "total" and self.good is not None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "format": self.format,
            "good": self.good,
            "kind": self.kind,
            "group": self.group,
            "window": self.window,
            "rankBy": "best" if self.rank_best_first else "largest",
            "hint": self.hint,
        }


METRICS: tuple[Metric, ...] = (
    Metric("headcount", "Active headcount", "number", None, "total", "people", "today", 0, "Active employees today"),
    Metric(
        "attendancePct", "Attendance", "pct", "up", "rate", "attendance", "period", 1, "Share of scheduled days worked"
    ),
    Metric(
        "absenteeismPct",
        "Absenteeism",
        "pct",
        "down",
        "rate",
        "attendance",
        "period",
        1,
        "Share of scheduled days absent",
    ),
    Metric(
        "latePct",
        "Late arrivals",
        "pct",
        "down",
        "rate",
        "attendance",
        "period",
        1,
        "Share of days worked that began late",
    ),
    Metric(
        "overtimeHours",
        "Overtime hours",
        "hours",
        "down",
        "total",
        "attendance",
        "period",
        1,
        "Overtime worked in the period",
    ),
    Metric(
        "overtimePerHead",
        "Overtime per staff member",
        "hours",
        "down",
        "average",
        "attendance",
        "period",
        2,
        "Overtime hours per active staff member",
    ),
    Metric(
        "attritionPct",
        "Attrition (12 months)",
        "pct",
        "down",
        "rate",
        "people",
        "year",
        1,
        "Leavers against average headcount, last 12 months",
    ),
    Metric("joiners", "Joiners", "number", None, "total", "people", "period", 0, "People who joined in the period"),
    Metric("leavers", "Leavers", "number", "down", "total", "people", "period", 0, "People who left in the period"),
    Metric(
        "avgTenureYears",
        "Average tenure",
        "years",
        "up",
        "average",
        "people",
        "today",
        1,
        "Years of service of the people here today",
    ),
    Metric(
        "payrollCost",
        "Payroll cost",
        "inr_compact",
        None,
        "total",
        "money",
        "payroll",
        2,
        "Gross pay, latest closed month",
    ),
    Metric(
        "costPerHead",
        "Cost per person",
        "inr_compact",
        None,
        "average",
        "money",
        "payroll",
        2,
        "Gross pay per person paid, latest closed month",
    ),
)
METRIC_BY_ID = {m.id: m for m in METRICS}
METRIC_IDS = tuple(METRIC_BY_ID)

#: Metrics that can be drawn over time (the rest have no history to draw: tenure and cost per head are today's figure).
TREND_METRICS = (
    "attendancePct",
    "absenteeismPct",
    "latePct",
    "overtimeHours",
    "headcount",
    "joiners",
    "leavers",
    "payrollCost",
    "costPerHead",
)


@dataclass(frozen=True)
class Group:
    """What the comparison is grouped by: units (the page) or the departments of one unit (a unit's profile)."""

    kind: str
    key_of: Callable[[Any], Any]  # works on both the attendance and the employees ``Person``
    slip_field: str  # the key on a grouped salary-slip / overtime row
    pay_by: str  # payroll's own name for the grouping
    none_label: str


UNITS = Group("unit", lambda p: p.branch_id, "employee__branch_id", "branch", "No unit")
DEPARTMENTS = Group("department", lambda p: p.dept_id, "employee__department_id", "dept", "No department")
GROUPS = {"unit": UNITS, "department": DEPARTMENTS}


# ─── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────


def _n(value: float | int | None, places: int = 0) -> str:
    return "n/a" if value is None else f"{value:,.{places}f}"


def _p(value: float | None, places: int = 1) -> str:
    return "n/a" if value is None else f"{round(value, places):g}%"


def _pts(value: float) -> str:
    size = round(abs(value), 1)
    return f"{size:g} {'point' if size == 1 else 'points'}"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _round(value: float | int | None, places: int) -> float | None:
    return None if value is None else round(float(value), places)


def _hours(minutes: float | int | None) -> float:
    return round((minutes or 0) / 60.0, 1)


def _int_arg(value: Any, name: str, default: int, low: int, high: int) -> int:
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def _metric_arg(value: Any, allowed: tuple[str, ...] = METRIC_IDS) -> str:
    text = str(value or "").strip()
    if text in allowed:
        return text
    lowered = {a.lower(): a for a in allowed}
    if text.lower() in lowered:
        return lowered[text.lower()]
    raise MdParamError(f"'{text}' is not a figure to compare. Choose one of: {', '.join(allowed)}.")


# ─── the comparison: every figure of every group, worked out once ────────────────────────────────────────────────


@dataclass
class Compare:
    """Everything the comparison knows for one scope and period. Built once (``_comparison``), then read by the summary,
    the exceptions, the headline and the profile, so they cannot disagree. Callers must not change it."""

    group: Group
    scope: Scope
    period: Period
    today: date
    win: att.Windows
    year: Period
    payroll_month: dict | None
    names: dict[Any, dict]
    people: dict[Any, dict]  # key -> {"active", "staff", "production"}
    values: dict[str, dict[Any, float | None]]
    previous: dict[str, dict[Any, float | None]]
    company: dict[str, float | None]
    company_previous: dict[str, float | None]
    notes: list[str]
    attendance_rows: int
    coverage: dict | None
    ot_tracked: bool
    settings: Any
    leavers_in_year: dict[Any, int] = field(default_factory=dict)
    average_in_year: dict[Any, float | None] = field(default_factory=dict)
    company_leavers_in_year: int = 0
    unit_scope_label: str = "Company"
    empty_units: int = 0

    @cached_property
    def keys(self) -> list:
        """The groups, biggest first (then by name, so the order never jitters)."""
        return sorted(self.names, key=lambda k: (-self.people[k]["active"], str(self.names[k]["name"]).lower(), str(k)))

    @cached_property
    def ranks(self) -> dict[str, dict[Any, int]]:
        return {m.id: _ranks(self.values[m.id], m) for m in METRICS}

    def entry(self, m: Metric, key: Any) -> dict:
        ranks = self.ranks[m.id]
        return _entry(
            m,
            self.values[m.id].get(key),
            self.company[m.id],
            ranks.get(key),
            len(ranks),
            self.previous[m.id].get(key),
        )

    def row(self, key: Any) -> dict:
        info, people = self.names[key], self.people[key]
        return {
            "id": key,
            "name": info["name"],
            "isHeadOffice": info.get("isHeadOffice", False),
            "isActive": info.get("isActive", True),
            "headcount": people["active"],
            "staff": people["staff"],
            "production": people["production"],
            "metrics": {m.id: self.entry(m, key) for m in METRICS},
        }

    def rows(self) -> list[dict]:
        return [self.row(k) for k in self.keys]

    def company_json(self) -> dict:
        return {
            "label": self.unit_scope_label,
            "headcount": self.company["headcount"],
            "staff": sum(p["staff"] for p in self.people.values()),
            "production": sum(p["production"] for p in self.people.values()),
            "metrics": {m.id: self.company[m.id] for m in METRICS},
            "previous": {m.id: self.company_previous.get(m.id) for m in METRICS},
        }

    def leaders(self) -> dict[str, dict]:
        """For each figure the best and the weakest group (only when at least two have one)."""
        out: dict[str, dict] = {}
        for m in METRICS:
            ranks = self.ranks[m.id]
            if len(ranks) < 2:
                continue
            ordered = sorted(ranks, key=lambda k: (ranks[k], self.keys.index(k)))
            pick = lambda k: {"id": k, "name": self.names[k]["name"], "value": self.values[m.id][k]}  # noqa: E731
            out[m.id] = {"best": pick(ordered[0]), "worst": pick(ordered[-1])}
        return out


def _ranks(values: dict[Any, float | None], m: Metric) -> dict[Any, int]:
    """Competition ranking ("1, 1, 3"): a group's rank is one more than the number of groups strictly ahead of it. Groups
    with no figure are not ranked."""
    present = {k: v for k, v in values.items() if v is not None}
    higher_first = not (m.rank_best_first and m.good == "down")
    out = {}
    for key, value in present.items():
        ahead = sum(1 for other in present.values() if (other > value if higher_first else other < value))
        out[key] = ahead + 1
    return out


def _verdict(m: Metric, diff: float | None, diff_pct: float | None, reference: float | None) -> str | None:
    """better / worse / similar than the company, for a figure with a good direction; None when neither is "better"."""
    if m.good is None or diff is None or m.kind == "total":
        return None
    if m.kind == "rate":
        similar = abs(diff) < SIMILAR_POINTS
    elif reference:
        similar = diff_pct is not None and abs(diff_pct) < SIMILAR_PCT
    else:
        similar = diff == 0
    if similar:
        return "similar"
    return "better" if (diff > 0) == (m.good == "up") else "worse"


def _entry(
    m: Metric, value: float | None, reference: float | None, rank: int | None, of: int, previous: float | None
) -> dict:
    diff = diff_pct = share = delta = None
    if value is not None and reference is not None:
        if m.kind == "total":
            share = pct(value, reference)
        else:
            diff = round(value - reference, max(m.decimals, 1) if m.format != "inr_compact" else 2)
            if m.kind == "average" and reference:
                diff_pct = pct(value - reference, abs(reference))
    if value is not None and previous is not None:
        delta = round(value - previous, max(m.decimals, 1) if m.format != "inr_compact" else 2)
    return {
        "value": value,
        "reference": reference,
        "diff": diff,
        "diffPct": diff_pct,
        "sharePct": share,
        "rank": rank,
        "of": of,
        "verdict": _verdict(m, diff, diff_pct, reference),
        "previous": previous,
        "delta": delta,
    }


def _names(group: Group, keys: set) -> dict[Any, dict]:
    if group is UNITS:
        branches = {
            b["id"]: b
            for b in Branch.objects.filter(id__in=[k for k in keys if k is not None]).values(
                "id", "name", "is_head_office", "is_active"
            )
        }
        out = {}
        for key in keys:
            b = branches.get(key)
            out[key] = (
                {"name": b["name"], "isHeadOffice": b["is_head_office"], "isActive": b["is_active"]}
                if b
                else {"name": group.none_label, "isHeadOffice": False, "isActive": True}
            )
        return out
    departments = dict(Department.objects.filter(id__in=[k for k in keys if k is not None]).values_list("id", "name"))
    return {k: {"name": departments.get(k, group.none_label)} for k in keys}


def _overtime(
    scope: Scope, group: Group, cur: Period | None, prev: Period | None
) -> tuple[dict[Any, int], dict[Any, int], int, int]:
    """Overtime minutes per group in the period and the one before (one grouped query), and how many days of overtime
    each window holds. Rejected days are left out, as on the Attendance page."""
    if cur is None:
        return {}, {}, 0, 0
    lo = (prev or cur).start
    in_cur = Q(date__gte=cur.start, date__lte=cur.end)
    aggs: dict[str, Any] = {"cur": Sum("ot_minutes", filter=in_cur), "cur_n": Count("id", filter=in_cur)}
    if prev is not None:
        in_prev = Q(date__gte=prev.start, date__lte=prev.end)
        aggs["prev"] = Sum("ot_minutes", filter=in_prev)
        aggs["prev_n"] = Count("id", filter=in_prev)
    rows = (
        OvertimeRecord.objects.filter(scope.employee_q("employee__"), date__gte=lo, date__lte=cur.end)
        .exclude(status="rejected")
        .order_by()
        .values(group.slip_field)
        .annotate(**aggs)
    )
    cur_min: dict[Any, int] = defaultdict(int)
    prev_min: dict[Any, int] = defaultdict(int)
    cur_n = prev_n = 0
    for r in rows:
        key = r[group.slip_field]
        cur_min[key] += r["cur"] or 0
        cur_n += r["cur_n"]
        if prev is not None:
            prev_min[key] += r.get("prev") or 0
            prev_n += r["prev_n"]
    return cur_min, prev_min, cur_n, prev_n


def _comparison(scope: Scope, period: Period, today: date, kind: str = "unit") -> Compare:
    """Every figure of every group for the scope and period. The cache lives on ``comparison`` below."""
    group = GROUPS[kind]
    wf = emp.load(scope, today)
    frame, win = att.frame_for(scope, period, today)
    settings = frame.settings
    notes: list[str] = []

    by_key: dict[Any, list] = defaultdict(list)
    for person in wf.people:
        by_key[group.key_of(person)].append(person)
    names = _names(group, set(by_key))
    people = {
        k: {
            "active": sum(1 for p in members if p.active),
            "staff": sum(1 for p in members if p.active and p.kind == "staff"),
            "production": sum(1 for p in members if p.active and p.kind == "production"),
        }
        for k, members in by_key.items()
    }
    values: dict[str, dict[Any, float | None]] = {m.id: {} for m in METRICS}
    previous: dict[str, dict[Any, float | None]] = {m.id: {} for m in METRICS}
    company: dict[str, float | None] = {}
    company_previous: dict[str, float | None] = {}

    # ── people: headcount, joiners, leavers, attrition and tenure (the employees module's own roll and flow)
    period_e = emp._clamped(period, today)
    prev_e = period_e.previous()
    year = period_for_preset("last_12_months", today)
    year_before = year.previous()
    leavers_in_year: dict[Any, int] = {}
    average_in_year: dict[Any, float | None] = {}

    def people_figures(members: list) -> dict[str, tuple[float | None, float | None]]:
        roll = emp.Roll(members)
        cur, prv = emp.flow(members, period_e, roll), emp.flow(members, prev_e, roll)
        yr, yr_before = emp.flow(members, year, roll), emp.flow(members, year_before, roll)
        counted = period_e.days > 0
        return {
            "headcount": (sum(1 for p in members if p.active), None),
            "joiners": (cur.joiners if counted else None, prv.joiners if counted else None),
            "leavers": (cur.leavers if counted else None, prv.leavers if counted else None),
            "attritionPct": (yr.attrition, yr_before.attrition),
            "avgTenureYears": (emp._tenure_years(members, today)[0], None),
            "_year": (yr.leavers, None if yr.average is None else round(yr.average, 1)),
        }

    for key, members in by_key.items():
        figures = people_figures(members)
        for metric_id, (now, before) in figures.items():
            if metric_id == "_year":
                leavers_in_year[key] = now
                average_in_year[key] = before
            else:
                values[metric_id][key] = now
                previous[metric_id][key] = before
    everyone = people_figures(wf.people)
    for metric_id, (now, before) in everyone.items():
        if metric_id != "_year":
            company[metric_id] = now
            company_previous[metric_id] = before
    company_leavers_in_year = everyone["_year"][0] or 0

    # ── attendance: the attendance module's classified day records, grouped by unit (or department)
    measured, before_period = win.measured, win.previous
    coverage = None
    attendance_rows = 0
    attendance_keys = ("attendancePct", "absenteeismPct", "latePct")
    tally_of = {"attendancePct": att.t_attendance, "absenteeismPct": att.t_absence, "latePct": att.t_late}
    if measured is not None:
        cur_rows = frame.window(measured.start, measured.end)
        attendance_rows = len(cur_rows)
        coverage = att.coverage_of(frame, measured.start, measured.end, cur_rows)

        def grouped_tallies(rows: list[tuple]) -> dict[Any, list[int]]:
            return att.grouped(rows, lambda r: group.key_of(frame.people[r[1]]))

        tallies = grouped_tallies(cur_rows)
        for metric_id in attendance_keys:
            for key in by_key:
                tally = tallies.get(key)
                values[metric_id][key] = _round(tally_of[metric_id](tally), 1) if tally else None
            company[metric_id] = _round(tally_of[metric_id](att.tally_rows(cur_rows)), 1) if cur_rows else None
        if before_period is not None:
            prev_rows = frame.window(before_period.start, before_period.end)
            prev_tallies = grouped_tallies(prev_rows)
            for metric_id in attendance_keys:
                for key in by_key:
                    tally = prev_tallies.get(key)
                    previous[metric_id][key] = _round(tally_of[metric_id](tally), 1) if tally else None
                company_previous[metric_id] = (
                    _round(tally_of[metric_id](att.tally_rows(prev_rows)), 1) if prev_rows else None
                )
    else:
        for metric_id in attendance_keys:
            company[metric_id] = None
    notes.extend(att._notes(frame, win, coverage))

    # ── overtime: hours per group, "not tracked" is None (never 0), exactly as the Attendance page decides
    cur_min, prev_min, cur_n, prev_n = _overtime(scope, group, measured, before_period)
    feature_on = getattr(settings, "compensation_feature_enabled", True)
    detecting = getattr(settings, "ot_detection_enabled", False)
    ot_tracked = bool(measured is not None and feature_on and (cur_n > 0 or detecting))
    prev_tracked = bool(before_period is not None and feature_on and (prev_n > 0 or detecting))
    for key in by_key:
        hours = _hours(cur_min.get(key)) if ot_tracked else None
        values["overtimeHours"][key] = hours
        previous["overtimeHours"][key] = _hours(prev_min.get(key)) if prev_tracked else None
        staff = people[key]["staff"]
        values["overtimePerHead"][key] = _round(hours / staff, 2) if hours is not None and staff else None
        before_hours = previous["overtimeHours"][key]
        previous["overtimePerHead"][key] = (
            _round(before_hours / staff, 2) if before_hours is not None and staff else None
        )
    company["overtimeHours"] = _hours(sum(cur_min.values())) if ot_tracked else None
    company_previous["overtimeHours"] = _hours(sum(prev_min.values())) if prev_tracked else None
    staff_total = sum(p["staff"] for p in people.values())
    company["overtimePerHead"] = (
        _round(company["overtimeHours"] / staff_total, 2)
        if company["overtimeHours"] is not None and staff_total
        else None
    )
    company_previous["overtimePerHead"] = (
        _round(company_previous["overtimeHours"] / staff_total, 2)
        if company_previous["overtimeHours"] is not None and staff_total
        else None
    )
    if feature_on is False:
        notes.append("Overtime is not shown: the Compensation feature is switched off in Settings.")

    # ── payroll: the latest closed month's slips, grouped by the employee's current unit (or department)
    ctx = pay._context(scope, None, today)
    payroll_month = None
    for metric_id in ("payrollCost", "costPerHead"):
        company[metric_id] = None
        company_previous[metric_id] = None
    if ctx.ym is not None:
        ym, before_ym = ctx.ym, pay._shift(ctx.ym, -1)
        raws: dict[tuple, dict[Any, dict]] = {ym: {}, before_ym: {}}
        for r in pay._agg_rows(scope, [ym, before_ym], (group.pay_by,)):
            raws[(r["year"], r["month"])][r[group.slip_field]] = pay._raw(r)
        figures = {m: {k: pay._figures(raw) for k, raw in raws[m].items()} for m in (ym, before_ym)}
        for key in by_key:
            for slot, m in ((values, ym), (previous, before_ym)):
                f = figures[m].get(key)
                slot["payrollCost"][key] = f["grossPay"] if f else None
                slot["costPerHead"][key] = f["costPerHead"] if f else None
        if raws[ym]:
            total = pay._figures(pay._sum_raw(raws[ym].values()))
            company["payrollCost"], company["costPerHead"] = total["grossPay"], total["costPerHead"]
        if raws[before_ym]:
            total_before = pay._figures(pay._sum_raw(raws[before_ym].values()))
            company_previous["payrollCost"] = total_before["grossPay"]
            company_previous["costPerHead"] = total_before["costPerHead"]
        payroll_month = {
            "key": pay._key(ym),
            "label": pay._label(ym),
            "ended": ctx.ended,
            "previousLabel": pay._label(before_ym),
        }
        if not ctx.ended:
            notes.append(
                f"{pay._label(ym)} has not ended yet, so its payroll figures are provisional: no month has closed with slips."
            )
    else:
        notes.append(pay.NO_PAYROLL_NOTE)

    unplaced = wf.unplaced
    if unplaced:
        notes.append(
            f"{unplaced:,} {'person has' if unplaced == 1 else 'people have'} a missing or unusable join date: they are "
            "counted as having been here since before the period, never as joiners, and have no tenure."
        )
    empty_units = 0
    if group is UNITS and not scope.branch_ids:
        empty_units = Branch.objects.exclude(id__in=[k for k in by_key if k is not None]).count()
        if empty_units:
            notes.append(
                f"{empty_units} {_plural(empty_units, 'unit has', 'units have')} no employees in this selection and "
                f"{_plural(empty_units, 'is', 'are')} left out."
            )
    return Compare(
        group=group,
        scope=scope,
        period=period,
        today=today,
        win=win,
        year=year,
        payroll_month=payroll_month,
        names=names,
        people=people,
        values=values,
        previous=previous,
        company=company,
        company_previous=company_previous,
        notes=list(dict.fromkeys(notes)),
        attendance_rows=attendance_rows,
        coverage=coverage,
        ot_tracked=ot_tracked,
        settings=settings,
        leavers_in_year=leavers_in_year,
        average_in_year=average_in_year,
        company_leavers_in_year=company_leavers_in_year,
        unit_scope_label="Company" if group is UNITS else "Unit",
        empty_units=empty_units,
    )


@cached()
def comparison(scope: Scope, period: Period, today: date, kind: str = "unit") -> Compare:
    return _comparison(scope, period, today, kind)


# ─── provenance ───────────────────────────────────────────────────────────────────────────────────────────────────

_CAVEAT_UNITS = (
    "People, attendance and pay are counted in the unit each employee belongs to TODAY: transfers between units are not "
    "tracked, so a past figure uses the current unit."
)


def _provenance(c: Compare) -> list[dict]:
    month = (c.payroll_month or {}).get("label")
    where = c.scope.describe()
    comparing = "units" if c.group is UNITS else "departments"
    window = f"{c.win.measured.label}" if c.win.measured else c.period.label
    return [
        prov(
            "units-comparison",
            "How units are compared",
            dataset="Employees, attendance day records, overtime records and salary slips",
            definition=(
                f"One row per {c.group.kind}. 'Company' is everyone in the selection pooled together (the company's "
                "attendance % is all scheduled days added up, not the average of the units' percentages), so it equals the "
                "same figure on the Attendance, Employees and Payroll pages. 'Difference' is the unit's figure minus the "
                "company's (points for a percentage, per cent for a per-person figure); a size such as headcount shows its "
                "share of the company instead. Rank 1 is the best unit when the figure has a good direction (highest "
                "attendance, lowest absenteeism) and the largest otherwise; equal figures share a rank and a unit with no "
                "figure is not ranked. Better / worse / similar: a difference under "
                f"{SIMILAR_POINTS:g} point (or {SIMILAR_PCT:g}% for a per-person figure) is 'similar'."
            ),
            formula="difference = unit figure - company figure; rank = 1 + units strictly ahead",
            rows=len(c.names),
            filters=[where, f"Comparing {comparing}"],
            caveats=[_CAVEAT_UNITS],
        ),
        att._prov_attendance(c.attendance_rows),
        att._prov_absenteeism(c.attendance_rows),
        att._prov_late(None, c.settings),
        att._prov_overtime(None, c.settings),
        prov(
            "unit-overtime-per-head",
            "Overtime per staff member",
            dataset="Overtime records and employees",
            definition=(
                "Overtime hours divided by the active STAFF in the unit (overtime is recorded for staff only), so a big "
                "unit and a small one can be compared."
            ),
            formula="overtime hours ÷ active staff",
            filters=[f"Window: {window}"],
        ),
        prov(
            "unit-headcount",
            "Active headcount, joiners, leavers and tenure",
            dataset="Employee records and resignations",
            definition=(
                "Headcount is everyone whose status is Active today. Joiners and leavers are counted in the period; "
                "tenure is the average service of the people here today who have a usable join date."
            ),
            formula="count of employees with status = active; tenure = (today - join date) ÷ 365.25",
            rows=sum(p["active"] for p in c.people.values()),
            caveats=[emp.CAVEAT_RECONSTRUCTED, emp.CAVEAT_JOIN_DATES, _CAVEAT_UNITS],
        ),
        prov(
            "unit-attrition",
            "Attrition over the last 12 months",
            dataset="Employee records and resignations",
            definition=(
                "People who left in the last 12 months against the unit's average headcount of that time. It is always "
                "the last 12 months, whatever period is chosen, because a shorter window gives noisy rates."
            ),
            formula="leavers ÷ ((opening + closing headcount) ÷ 2) × 100, for each unit",
            rows=c.company_leavers_in_year,
            filters=[c.year.label],
            caveats=[emp.CAVEAT_RECONSTRUCTED, emp.CAVEAT_EXIT_DATES, _CAVEAT_UNITS],
        ),
        prov(
            "unit-payroll",
            "Payroll cost and cost per person",
            dataset="Salary slips",
            definition=(
                f"Gross pay (salary earned plus overtime pay) of the latest closed month{f', {month}' if month else ''}, "
                "for the people each unit paid; cost per person divides it by the people paid. Money comes from the paid "
                "salary slips, never from the payroll rows."
            ),
            formula="cost per person = gross pay ÷ people paid",
            filters=[month or "No payroll yet"],
            caveats=[
                "The month is the latest that has ended and has salary slips, not the period chosen above.",
                "A unit's payroll is for the people it employs today.",
            ],
        ),
    ]


def _pick(entries: list[dict], *ids: str) -> list[dict]:
    return [e for e in entries if e["id"] in ids]


# ─── the plain-English summary, written from the numbers by fixed rules (no AI, no quota) ──────────────────────────


def _line(id_: str, text: str, page: str | None, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "page": page, "tone": tone}


def _briefing(c: Compare) -> dict:
    keys = c.keys
    ask = (
        f"Compare our units ({c.period.label}) on attendance, lateness, overtime, attrition and payroll cost. "
        "Which unit needs attention first, and why?"
    )
    if not keys:
        return {"sentences": [], "text": "", "ask": ask}
    name = lambda k: c.names[k]["name"]  # noqa: E731
    value = lambda m, k: c.values[m][k]  # noqa: E731
    sentences: list[dict] = []
    total = sum(c.people[k]["active"] for k in keys)
    largest = max(keys, key=lambda k: (c.people[k]["active"], name(k)))
    if len(keys) == 1:
        sentences.append(
            _line("units", f"{name(keys[0])} is the only unit in this selection, with {_n(total)} active people.", PAGE)
        )
    else:
        share = pct(c.people[largest]["active"], total)
        sentences.append(
            _line(
                "units",
                f"The company has {len(keys)} units and {_n(total)} active people; {name(largest)} is the largest with "
                f"{_n(c.people[largest]['active'])} ({_p(share, 0)}).",
                PAGE,
            )
        )

    ranked = c.ranks["attendancePct"]
    company_att = c.company["attendancePct"]
    label = c.win.measured.label if c.win.measured else c.period.label
    if company_att is not None and len(ranked) >= 2:
        ordered = sorted(ranked, key=lambda k: (ranked[k], c.keys.index(k)))
        best, worst = ordered[0], ordered[-1]
        gap = round(company_att - value("attendancePct", worst), 1)
        tone = "watch" if gap >= GAP_WARN_PTS and c.people[worst]["active"] >= MIN_UNIT_HEADCOUNT else "neutral"
        sentences.append(
            _line(
                "attendance",
                f"Attendance ({label}) was {_p(company_att)}: {name(best)} led at {_p(value('attendancePct', best))} and "
                f"{name(worst)} trailed at {_p(value('attendancePct', worst))}"
                + (f", {_pts(gap)} below the company figure" if gap >= SIMILAR_POINTS else "")
                + ".",
                "attendance",
                tone,
            )
        )
    elif company_att is not None and len(keys) == 1:
        sentences.append(_line("attendance", f"Attendance ({label}) was {_p(company_att)}.", "attendance"))

    worst_absent = _extreme(c, "absenteeismPct", worst=True)
    if worst_absent is not None and len(c.ranks["absenteeismPct"]) >= 2:
        key, diff = worst_absent
        if diff >= SIMILAR_POINTS:
            sentences.append(
                _line(
                    "absence",
                    f"{name(key)} has the highest absenteeism at {_p(value('absenteeismPct', key))}, against "
                    f"{_p(c.company['absenteeismPct'])} for the company.",
                    "attendance",
                    "watch" if diff >= GAP_WARN_PTS else "neutral",
                )
            )

    if c.ot_tracked and (c.company["overtimeHours"] or 0) > 0 and len(keys) >= 2:
        top = max(keys, key=lambda k: (value("overtimeHours", k) or 0, name(k)))
        entry = c.entry(METRIC_BY_ID["overtimeHours"], top)
        if (value("overtimeHours", top) or 0) > 0:
            sentences.append(
                _line(
                    "overtime",
                    f"{name(top)} worked the most overtime: {_n(value('overtimeHours', top), 1)} hours, "
                    f"{_p(entry['sharePct'], 0)} of the company's {_n(c.company['overtimeHours'], 1)}.",
                    "attendance",
                )
            )

    worst_attrition = _extreme(c, "attritionPct", worst=True)
    if worst_attrition is not None and len(c.ranks["attritionPct"]) >= 2 and c.leavers_in_year.get(worst_attrition[0]):
        key, diff = worst_attrition
        if diff >= SIMILAR_POINTS:
            sentences.append(
                _line(
                    "attrition",
                    f"Over the last 12 months {name(key)} lost {_p(value('attritionPct', key))} of its people, against "
                    f"{_p(c.company['attritionPct'])} for the company.",
                    "employees",
                    "watch" if _is_attrition_hotspot(c, key) else "neutral",
                )
            )

    month = (c.payroll_month or {}).get("label")
    if month and c.company["costPerHead"] is not None:
        priciest = _extreme(c, "costPerHead", worst=True)
        if priciest is not None and len(c.ranks["costPerHead"]) >= 2:
            key = priciest[0]
            sentences.append(
                _line(
                    "payroll",
                    f"In {month}, {name(key)} cost the most per person, {inr_compact(value('costPerHead', key))} against "
                    f"{inr_compact(c.company['costPerHead'])} for the company.",
                    "payroll",
                )
            )
        elif len(keys) == 1:
            sentences.append(
                _line(
                    "payroll",
                    f"{month} payroll came to {inr_compact(c.company['payrollCost'])}, "
                    f"{inr_compact(c.company['costPerHead'])} per person.",
                    "payroll",
                )
            )
    return {"sentences": sentences, "text": " ".join(s["text"] for s in sentences), "ask": ask}


def _extreme(c: Compare, metric_id: str, *, worst: bool) -> tuple[Any, float] | None:
    """The group with the worst (or, for a figure with no good direction, the largest) value and how far it is from the
    company, in the figure's units. None when no group has one."""
    present = {k: v for k, v in c.values[metric_id].items() if v is not None}
    reference = c.company[metric_id]
    if not present or reference is None:
        return None
    high_is_worse = METRIC_BY_ID[metric_id].good != "up"
    pick = max if (worst == high_is_worse) else min
    key = pick(present, key=lambda k: (present[k], str(c.names[k]["name"])))
    return key, round(present[key] - reference, 1)


def _is_attrition_hotspot(c: Compare, key: Any) -> bool:
    rate, company = c.values["attritionPct"].get(key), c.company["attritionPct"]
    return bool(
        company
        and rate is not None
        and (c.leavers_in_year.get(key) or 0) >= ATTRITION_MIN_LEAVERS
        and (c.average_in_year.get(key) or 0) >= ATTRITION_MIN_AVERAGE
        and rate >= ATTRITION_FACTOR * company
    )


# ─── the summary ──────────────────────────────────────────────────────────────────────────────────────────────────


def _period_block(p: Period | None) -> dict | None:
    return None if p is None else {"start": p.start.isoformat(), "end": p.end.isoformat(), "days": p.days}


@cached()
def units_summary(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """The units side by side: one row per unit with headcount, attendance, absenteeism, late arrivals, overtime,
    attrition, joiners, leavers, tenure, payroll cost and cost per person, each with the company's figure, the difference,
    the rank and (where there is one) the previous period's figure; the company's own figures; the best and weakest unit
    on every figure; and a plain-English summary."""
    today = today or ist_today()
    c = comparison(scope, period, today, "unit")
    return envelope(
        {
            "today": today.isoformat(),
            "measured": _period_block(c.win.measured),
            "previous": _period_block(c.win.previous),
            "attrition": {"start": c.year.start.isoformat(), "end": c.year.end.isoformat(), "label": c.year.label},
            "payrollMonth": c.payroll_month,
            "metrics": [m.to_json() for m in METRICS],
            "unitCount": len(c.keys),
            "company": c.company_json(),
            "rows": c.rows(),
            "leaders": c.leaders(),
            "coverage": c.coverage,
            "otTracked": c.ot_tracked,
            "briefing": _briefing(c),
        },
        period=period,
        scope=scope,
        provenance=_provenance(c),
        notes=c.notes,
    )


# ─── a ranking of the units on one figure ─────────────────────────────────────────────────────────────────────────


def units_rank(
    scope: Scope, period: Period, metric: str = "attendancePct", limit: int = LIST_MAX, *, today: date | None = None
) -> dict:
    """The units ranked on one figure, best first: rank, value, the company's figure, the difference and the verdict."""
    metric_id = _metric_arg(metric)
    limit = _int_arg(limit, "limit", LIST_MAX, 1, LIST_MAX)
    m = METRIC_BY_ID[metric_id]
    today = today or ist_today()
    c = comparison(scope, period, today, "unit")
    entries = [(k, c.entry(m, k)) for k in c.keys]
    ranked = sorted(
        entries,
        key=lambda ke: (ke[1]["rank"] is None, ke[1]["rank"] or 0, c.keys.index(ke[0])),
    )
    rows = [
        {
            "rank": e["rank"],
            "id": k,
            "name": c.names[k]["name"],
            "headcount": c.people[k]["active"],
            **{
                key: e[key]
                for key in ("value", "reference", "diff", "diffPct", "sharePct", "verdict", "previous", "delta")
            },
        }
        for k, e in ranked[:limit]
    ]
    wanted = {
        "attendancePct": ("attendance-pct",),
        "absenteeismPct": ("absenteeism-pct",),
        "latePct": ("late-pct",),
        "overtimeHours": ("overtime-hours",),
        "overtimePerHead": ("unit-overtime-per-head",),
        "attritionPct": ("unit-attrition",),
        "payrollCost": ("unit-payroll",),
        "costPerHead": ("unit-payroll",),
    }.get(metric_id, ("unit-headcount",))
    return envelope(
        {
            "metric": m.to_json(),
            "referenceLabel": "Company",
            "reference": c.company[metric_id],
            "total": len(entries),
            "rows": rows,
            "payrollMonth": c.payroll_month,
        },
        period=period,
        scope=scope,
        provenance=_pick(_provenance(c), "units-comparison", *wanted),
        notes=c.notes,
    )


# ─── over time ────────────────────────────────────────────────────────────────────────────────────────────────────


def _day_text(day: date) -> str:
    return emp._day_text(day)


def _bucket_start(d: date, weekly: bool) -> date:
    return att._week_start(d) if weekly else d


@cached()
def units_trend(scope: Scope, period: Period, metric: str = "attendancePct", *, today: date | None = None) -> dict:
    """One figure by unit over time: by day (by week for a long period) for attendance, absenteeism, late arrivals and
    overtime; by day, week or month for headcount, joiners and leavers; by month, over the last 12 closed months, for
    payroll cost and cost per person. The company's own line comes with it."""
    metric_id = _metric_arg(metric, TREND_METRICS)
    m = METRIC_BY_ID[metric_id]
    today = today or ist_today()
    c = comparison(scope, period, today, "unit")
    keys = c.keys[:MAX_TREND_UNITS]
    notes = list(c.notes)
    if len(c.keys) > MAX_TREND_UNITS:
        notes.append(f"The {MAX_TREND_UNITS} biggest of {len(c.keys)} units are drawn.")
    labels: list[tuple[str, str]] = []
    series: dict[Any, list[float | None]] = {k: [] for k in keys}
    whole: list[float | None] = []
    grain = "day"

    if metric_id in ("attendancePct", "absenteeismPct", "latePct", "overtimeHours"):
        measured = c.win.measured
        if measured is None:
            return _trend_result(m, grain, labels, c, keys, series, whole, period, scope, notes)
        grain = "week" if measured.days > att.WEEKLY_ROLLUP_AFTER_DAYS else "day"
        weekly = grain == "week"
        if metric_id == "overtimeHours":
            by_bucket: dict[Any, dict[date, int]] = defaultdict(lambda: defaultdict(int))
            totals: dict[date, int] = defaultdict(int)
            rows = (
                OvertimeRecord.objects.filter(
                    scope.employee_q("employee__"), date__gte=measured.start, date__lte=measured.end
                )
                .exclude(status="rejected")
                .order_by()
                .values("employee__branch_id", "date", "ot_minutes")
            )
            for r in rows:
                b = _bucket_start(r["date"], weekly)
                by_bucket[r["employee__branch_id"]][b] += r["ot_minutes"] or 0
                totals[b] += r["ot_minutes"] or 0
            bucket_keys = sorted(totals)
            if not c.ot_tracked:
                notes.append("Overtime is not tracked for this period (see the Attendance page).")
                bucket_keys = []
            for b in bucket_keys:
                labels.append((b.isoformat(), _day_text(b)))
            for k in keys:
                series[k] = [_hours(by_bucket[k].get(b)) for b in bucket_keys]
            whole = [_hours(totals.get(b)) for b in bucket_keys]
        else:
            frame, _ = att.frame_for(scope, period, today)
            tally_of = {"attendancePct": att.t_attendance, "absenteeismPct": att.t_absence, "latePct": att.t_late}[
                metric_id
            ]
            per: dict[Any, dict[date, list[int]]] = defaultdict(lambda: defaultdict(att.new_tally))
            all_tally: dict[date, list[int]] = defaultdict(att.new_tally)
            for d, eid, code, flags in frame.window(measured.start, measured.end):
                b = _bucket_start(d, weekly)
                att.add_row(per[UNITS.key_of(frame.people[eid])][b], code, flags)
                att.add_row(all_tally[b], code, flags)
            bucket_keys = sorted(all_tally)
            for b in bucket_keys:
                labels.append((b.isoformat(), _day_text(b)))
            for k in keys:
                series[k] = [_round(tally_of(per[k][b]), 1) if b in per[k] else None for b in bucket_keys]
            whole = [_round(tally_of(all_tally[b]), 1) for b in bucket_keys]
    elif metric_id in ("headcount", "joiners", "leavers"):
        wf = emp.load(scope, today)
        period_e = emp._clamped(period, today)
        grain = emp._grain_for(max(period_e.days, 1))
        steps = emp._buckets(period_e.start, period_e.end, grain)
        groups: dict[Any, list] = defaultdict(list)
        for p in wf.people:
            groups[p.branch_id].append(p)
        rolls = {k: emp.Roll(groups.get(k, [])) for k in keys}
        everyone = emp.Roll(wf.people)

        def at(roll: emp.Roll, first: date, last: date) -> float:
            if metric_id == "headcount":
                return roll.headcount(last)
            return roll.joined(first, last) if metric_id == "joiners" else roll.left(first, last)

        for key, label, first, last in steps:
            labels.append((key, label))
        for k in keys:
            series[k] = [at(rolls[k], first, last) for _key, _label, first, last in steps]
        whole = [at(everyone, first, last) for _key, _label, first, last in steps]
    else:  # payrollCost, costPerHead: by month, over the last closed months
        grain = "month"
        ctx = pay._context(scope, None, today)
        if ctx.ym is None:
            notes.append(pay.NO_PAYROLL_NOTE)
        else:
            months = [pay._shift(ctx.ym, -i) for i in range(TREND_PAYROLL_MONTHS - 1, -1, -1)]
            raws: dict[tuple, dict[Any, dict]] = {ym: {} for ym in months}
            for r in pay._agg_rows(scope, months, ("branch",)):
                raws[(r["year"], r["month"])][r["employee__branch_id"]] = pay._raw(r)
            field_name = "grossPay" if metric_id == "payrollCost" else "costPerHead"
            for ym in months:
                labels.append((pay._key(ym), pay._label(ym)))
            for k in keys:
                series[k] = [pay._figures(raws[ym][k])[field_name] if k in raws[ym] else None for ym in months]
            whole = [pay._figures(pay._sum_raw(raws[ym].values()))[field_name] if raws[ym] else None for ym in months]
            notes.append(
                f"Payroll is drawn for the last {TREND_PAYROLL_MONTHS} months up to {pay._label(ctx.ym)}, the latest closed month."
            )
    return _trend_result(m, grain, labels, c, keys, series, whole, period, scope, notes)


def _trend_result(m, grain, labels, c, keys, series, whole, period, scope, notes) -> dict:
    ids = {
        "attendancePct": ("attendance-pct",),
        "absenteeismPct": ("absenteeism-pct",),
        "latePct": ("late-pct",),
        "overtimeHours": ("overtime-hours",),
        "headcount": ("unit-headcount",),
        "joiners": ("unit-headcount",),
        "leavers": ("unit-headcount",),
        "payrollCost": ("unit-payroll",),
        "costPerHead": ("unit-payroll",),
    }[m.id]
    return envelope(
        {
            "metric": m.to_json(),
            "granularity": grain,
            "buckets": [{"key": k, "label": label} for k, label in labels],
            "units": [{"id": k, "name": c.names[k]["name"], "values": series[k]} for k in keys],
            "company": whole,
        },
        period=period,
        scope=scope,
        provenance=_pick(_provenance(c), *ids),
        notes=list(dict.fromkeys(notes)),
    )


# ─── one unit, and its departments ────────────────────────────────────────────────────────────────────────────────


def _one_unit(scope: Scope, unit: str | None) -> tuple[Scope, Scope | None, list[str]]:
    """(the scope without the unit filter, the scope narrowed to the one unit or None, notes). The unit is the scope's own
    (``?branch=``) or the ``unit`` argument (a name or an id, small typos forgiven)."""
    wide = dataclasses.replace(
        scope, branch_ids=(), labels={k: v for k, v in scope.labels.items() if k != "branch"}, notes=[]
    )
    notes: list[str] = []
    chosen = None
    if len(scope.branch_ids) == 1:
        chosen = scope
    elif unit:
        resolved = resolve_scope({"branch": unit})
        notes.extend(resolved.notes)
        chosen = dataclasses.replace(
            scope, branch_ids=resolved.branch_ids, labels={**wide.labels, **resolved.labels}, notes=list(scope.notes)
        )
    return wide, chosen, notes


@cached()
def unit_profile(scope: Scope, period: Period, unit: str | None = None, *, today: date | None = None) -> dict:
    """One unit against the company, and against itself department by department: the same figures as the summary for the
    unit, then every department of the unit with the unit's own figure as the reference. Name a unit with the ``unit``
    argument (or ``?branch=``); without one the answer lists the units to choose from."""
    today = today or ist_today()
    wide, narrow, notes = _one_unit(scope, unit)
    c_wide = comparison(wide, period, today, "unit")
    if narrow is None:
        return envelope(
            {
                "unit": None,
                "row": None,
                "departments": None,
                "units": [{"id": k, "name": c_wide.names[k]["name"]} for k in c_wide.keys],
            },
            period=period,
            scope=scope,
            provenance=_pick(_provenance(c_wide), "units-comparison"),
            notes=[*notes, "Name a unit (for example ?branch=Unit 1) to see its profile."],
        )
    branch_id = narrow.branch_ids[0]
    if branch_id not in c_wide.names:
        found = Branch.objects.filter(pk=branch_id).values("id", "name", "is_head_office", "is_active").first()
        info = (
            {"name": found["name"], "isHeadOffice": found["is_head_office"], "isActive": found["is_active"]}
            if found
            else {"name": "Unit"}
        )
        return envelope(
            {"unit": {"id": branch_id, **info}, "row": None, "departments": None, "units": []},
            period=period,
            scope=scope,
            provenance=_pick(_provenance(c_wide), "units-comparison"),
            notes=[*notes, f"{info['name']} has no employees in this selection, so there is nothing to show."],
        )
    c_unit = comparison(narrow, period, today, "department")
    row = c_wide.row(branch_id)
    departments = c_unit.rows()
    return envelope(
        {
            "unit": {"id": branch_id, **c_wide.names[branch_id]},
            "row": row,
            "company": c_wide.company_json(),
            "departments": {
                "referenceLabel": row["name"],
                "reference": c_unit.company_json(),
                "total": len(departments),
                "rows": departments,
                "leaders": c_unit.leaders(),
            },
            "metrics": [m.to_json() for m in METRICS],
            "payrollMonth": c_wide.payroll_month,
        },
        period=period,
        scope=scope,
        provenance=_provenance(c_unit),
        notes=[*notes, *c_unit.notes],
    )


# ─── needs your attention ─────────────────────────────────────────────────────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"units.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _overtime_baseline(scope: Scope, measured: Period) -> dict[Any, int]:
    """Overtime minutes per unit over the OT_BASELINE_DAYS before the period."""
    end = measured.start - timedelta(days=1)
    start = end - timedelta(days=OT_BASELINE_DAYS - 1)
    rows = (
        OvertimeRecord.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)
        .exclude(status="rejected")
        .order_by()
        .values("employee__branch_id")
        .annotate(minutes=Sum("ot_minutes"))
    )
    return {r["employee__branch_id"]: r["minutes"] or 0 for r in rows}


def _exceptions(c: Compare, *, limit: int) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``. Built on
    the same comparison as the page, so every flag points at a figure that is on it."""
    items: list[dict] = []
    keys = c.keys
    label = c.win.measured.label if c.win.measured else c.period.label
    name = lambda k: c.names[k]["name"]  # noqa: E731
    big = [k for k in keys if c.people[k]["active"] >= MIN_UNIT_HEADCOUNT]

    # attendance below the company
    company_att = c.company["attendancePct"]
    if company_att is not None and len(c.ranks["attendancePct"]) >= 2:
        below = sorted(
            (
                (round(company_att - c.values["attendancePct"][k], 1), k)
                for k in big
                if c.values["attendancePct"].get(k) is not None
                and company_att - c.values["attendancePct"][k] >= GAP_WARN_PTS
            ),
            key=lambda gk: (-gk[0], str(name(gk[1]))),
        )
        if below:
            gap, k = below[0]
            others = len(below) - 1
            items.append(
                _item(
                    "attendance-gap",
                    "critical" if gap >= GAP_CRITICAL_PTS else "warning",
                    f"{name(k)} attendance is {_pts(gap)} below the company average",
                    f"{label}: {name(k)} {_p(c.values['attendancePct'][k])} against {_p(company_att)} for the company"
                    + (
                        f"; {others} other {_plural(others, 'unit is', 'units are')} also {GAP_WARN_PTS:g}+ points below."
                        if others
                        else "."
                    ),
                    f"-{_n(gap, 1)} pts",
                    f"Why is {name(k)}'s attendance {_pts(gap)} below the company average ({label}), and which "
                    "departments and people drive it?",
                )
            )

    # late arrivals above the company
    company_late = c.company["latePct"]
    if company_late is not None and len(c.ranks["latePct"]) >= 2:
        above = sorted(
            (
                (round(c.values["latePct"][k] - company_late, 1), k)
                for k in big
                if c.values["latePct"].get(k) is not None and c.values["latePct"][k] - company_late >= LATE_GAP_PTS
            ),
            key=lambda gk: (-gk[0], str(name(gk[1]))),
        )
        if above:
            gap, k = above[0]
            items.append(
                _item(
                    "late-gap",
                    "warning",
                    f"{name(k)} late arrivals are {_p(c.values['latePct'][k])}, {_pts(gap)} above the company",
                    f"{label}: the company's late rate is {_p(company_late)}.",
                    f"+{_n(gap, 1)} pts",
                    f"Why are late arrivals at {name(k)} {_pts(gap)} above the company ({label}), and which "
                    "departments and shifts?",
                )
            )

    # overtime well above the unit's own normal
    measured = c.win.measured
    if measured is not None and c.ot_tracked and c.group is UNITS:
        baseline = _overtime_baseline(c.scope, measured)
        spikes = []
        for k in keys:
            recent = c.values["overtimeHours"].get(k)
            base_hours = _hours(baseline.get(k))
            if recent is None or recent < OT_SPIKE_MIN_HOURS or base_hours <= 0:
                continue
            ratio = (recent / measured.days) / (base_hours / OT_BASELINE_DAYS)
            if ratio >= OT_SPIKE_RATIO:
                spikes.append((ratio, k, recent, base_hours))
        if spikes:
            ratio, k, recent, base_hours = max(spikes, key=lambda s: (s[0], str(name(s[1]))))
            items.append(
                _item(
                    "overtime-spike",
                    "warning",
                    f"{name(k)} overtime is {_n(ratio, 1)}x its {OT_BASELINE_DAYS}-day average",
                    f"{label}: {_n(recent, 1)} overtime hours, against a usual {_n(base_hours / OT_BASELINE_DAYS * measured.days, 1)} "
                    f"for {measured.days} {_plural(measured.days, 'day')}.",
                    f"{_n(recent, 1)} h",
                    f"Why did overtime at {name(k)} jump to {_n(recent, 1)} hours ({label}), {_n(ratio, 1)} times its "
                    f"usual level, and who worked it?",
                )
            )

    # attrition hot-spot over the last 12 months
    hot = [k for k in keys if _is_attrition_hotspot(c, k)]
    if hot:
        k = max(hot, key=lambda x: (c.values["attritionPct"][x], str(name(x))))
        items.append(
            _item(
                "attrition",
                "warning",
                f"{name(k)} lost {_p(c.values['attritionPct'][k])} of its people in 12 months, against {_p(c.company['attritionPct'])} for the company",
                f"{_n(c.leavers_in_year[k])} {_plural(c.leavers_in_year[k], 'person')} left; {c.year.label.lower()}.",
                _p(c.values["attritionPct"][k]),
                f"Why is attrition at {name(k)} {_p(c.values['attritionPct'][k])} over the last 12 months, and who is leaving?",
            )
        )

    # good news, only when nothing above is worth a look
    ranked = c.ranks["attendancePct"]
    if not items and len(ranked) >= 2 and company_att is not None:
        values = [c.values["attendancePct"][k] for k in ranked]
        spread = round(max(values) - min(values), 1)
        if spread <= ALIGNED_POINTS:
            items.append(
                _item(
                    "aligned",
                    "good",
                    f"All {len(ranked)} units are within {_pts(max(spread, 0.1))} of each other on attendance",
                    f"{label}: the company's attendance is {_p(company_att)}; no unit is far from it.",
                    _p(company_att),
                    f"Summarise how the units compare ({label}).",
                )
            )
        else:
            best = min(ranked, key=lambda k: (ranked[k], c.keys.index(k)))
            items.append(
                _item(
                    "spread",
                    "info",
                    f"{name(best)} leads on attendance ({_p(c.values['attendancePct'][best])}); the spread across units is {_pts(spread)}",
                    f"{label}: no unit is more than {GAP_WARN_PTS:g} points under the company's {_p(company_att)}, "
                    "or the gaps are in units too small to call out.",
                    f"{_n(spread, 1)} pts",
                    f"What explains the {_pts(spread)} spread in attendance between our units ({label})?",
                )
            )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


@cached()
def units_attention(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """ "Needs your attention" for the selected period and scope (same shape as the Dashboard's exceptions)."""
    today = today or ist_today()
    c = comparison(scope, period, today, "unit")
    thresholds = prov(
        "units-attention",
        "Needs your attention",
        dataset="The unit comparison on this page",
        definition=(
            f"A unit with {MIN_UNIT_HEADCOUNT}+ active people is flagged when its attendance is {GAP_WARN_PTS:g}+ points "
            f"below the company's ({GAP_CRITICAL_PTS:g}+ is critical), or its late-arrival rate is {LATE_GAP_PTS:g}+ points "
            f"above; when its overtime per day is {OT_SPIKE_RATIO:g}x its own average of the {OT_BASELINE_DAYS} days before "
            f"the period (and at least {OT_SPIKE_MIN_HOURS:g} hours); or when its 12-month attrition is "
            f"{ATTRITION_FACTOR}x the company's with {ATTRITION_MIN_LEAVERS}+ leavers and an average headcount of "
            f"{ATTRITION_MIN_AVERAGE}+."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[c.period.label, scope.describe()],
        caveats=["These are rules of thumb: no target is configured in the system for units."],
    )
    return envelope(
        {"items": _exceptions(c, limit=ATTENTION_LIMIT)},
        period=period,
        scope=scope,
        provenance=[thresholds],
        notes=c.notes,
    )


# ─── what the Dashboard and the brief use ─────────────────────────────────────────────────────────────────────────


def _recent_period(today: date) -> Period:
    """The last 30 days, to today: attendance leaves today out, as everywhere."""
    return Period(today - timedelta(days=29), today, "last_30_days", "Last 30 days")


@cached()
def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3)."""
    today = today or ist_today()
    return _exceptions(comparison(Scope(), _recent_period(today), today, "unit"), limit=INSIGHT_LIMIT)


@cached()
def headline(*, today: date | None = None) -> dict:
    """The Dashboard's unit cards: how many units there are, and the weakest unit's attendance against the best, over the
    last 30 days, with the weakest unit's change against the 30 days before."""
    today = today or ist_today()
    period = _recent_period(today)
    c = comparison(Scope(), period, today, "unit")
    people = sum(p["active"] for p in c.people.values())
    largest = max(c.keys, key=lambda k: (c.people[k]["active"], str(c.names[k]["name"]))) if c.keys else None
    kpis = [
        {
            "id": "units.count",
            "label": "Units",
            "value": len(c.keys),
            "format": "number",
            "sub": f"{_n(people)} active people"
            + (
                f" · largest: {c.names[largest]['name']} ({_n(c.people[largest]['active'])})"
                if largest is not None
                else ""
            ),
            "delta": None,
            "spark": [],
            "page": PAGE,
        }
    ]
    ranks = c.ranks["attendancePct"]
    if len(ranks) >= 2:
        ordered = sorted(ranks, key=lambda k: (ranks[k], c.keys.index(k)))
        best, worst = ordered[0], ordered[-1]
        e = c.entry(METRIC_BY_ID["attendancePct"], worst)
        kpis.append(
            {
                "id": "units.weakest-attendance",
                "label": "Weakest unit: attendance",
                "value": e["value"],
                "format": "pct",
                "sub": f"{c.names[worst]['name']} · best: {c.names[best]['name']} {_p(c.values['attendancePct'][best])} · last 30 days",
                "delta": {"abs": e["delta"], "pct": None, "good": "up"} if e["delta"] is not None else None,
                "spark": [],
                "page": PAGE,
            }
        )
    return {"kpis": kpis, "provenance": _pick(_provenance(c), "units-comparison", "attendance-pct")}


# ─── the assistant's tools ────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many units (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)
_METRIC = string_param(
    "The figure to rank or draw. attendancePct, absenteeismPct, latePct, overtimeHours, overtimePerHead, attritionPct, "
    "headcount, joiners, leavers, avgTenureYears, payrollCost, costPerHead (trend: not overtimePerHead, attritionPct or "
    "avgTenureYears)",
)


def _rank_tool(*, scope: Scope, period: Period, metric: str = "attendancePct", limit: int = LIST_DEFAULT) -> dict:
    return units_rank(scope, period, metric, limit)


def _trend_tool(*, scope: Scope, period: Period, metric: str = "attendancePct") -> dict:
    return units_trend(scope, period, metric)


def _profile_tool(*, scope: Scope, period: Period, unit: str | None = None) -> dict:
    return unit_profile(scope, period, unit)


TOOLS = [
    tool(
        "units_compare",
        "All the company's units (branches) side by side for a period: for each unit its active headcount (staff and "
        "production), attendance %, absenteeism %, late-arrival %, overtime hours and per staff member, 12-month attrition "
        "%, joiners, leavers, average tenure, payroll cost and cost per person (latest closed month). Every figure comes "
        "with the company's figure, the difference from it, the unit's rank (1 = best) and whether it is better or worse "
        "than the company; plus the best and weakest unit on each figure and a plain-English summary. Use it for 'how do "
        "our units compare', 'which unit is doing worst' and 'compare Unit 1 and Unit 2'. Percentages are 0-100.",
        units_summary,
        page=PAGE,
        period=DEFAULT_PERIOD,
    ),
    tool(
        "units_rank",
        "The units ranked on ONE figure, best first: rank, value, the company's figure, the difference and the verdict. "
        "Use it for 'which unit has the highest absenteeism', 'rank the units by overtime', 'which unit costs the most "
        "per person'. For attendance-type figures rank 1 is the best unit (highest attendance, lowest absenteeism); for "
        "sizes (headcount, payroll cost) rank 1 is the largest.",
        _rank_tool,
        page=PAGE,
        period=DEFAULT_PERIOD,
        extra={"metric": _METRIC, "limit": _LIMIT},
        defaults={"metric": "attendancePct", "limit": LIST_DEFAULT},
    ),
    tool(
        "unit_profile",
        "One unit in depth: all its figures against the company, then each of its departments against the unit as a "
        "whole (headcount, attendance, absenteeism, late %, overtime, attrition, payroll cost). Give the unit's name or id "
        "in `unit` (or `branch`). Without one it lists the units to choose from. Use it for 'tell me about Unit 2', "
        "'which department drags Unit 1 down'.",
        _profile_tool,
        page=PAGE,
        period=DEFAULT_PERIOD,
        extra={"unit": string_param("The unit's name or id, for example 'Unit 1'.")},
    ),
    tool(
        "units_trend",
        "One figure for every unit over time, with the company's line: attendance, absenteeism, late % or overtime by "
        "day (week for a long period); headcount, joiners or leavers by day, week or month; payroll cost or cost per "
        "person by month for the last 12 closed months. Use it for 'is Unit 3 getting worse', 'how has attendance moved "
        "in each unit', 'which unit's headcount is growing'.",
        _trend_tool,
        page=PAGE,
        period=DEFAULT_PERIOD,
        extra={"metric": _METRIC},
        defaults={"metric": "attendancePct"},
    ),
    tool(
        "units_attention",
        "What stands out between the units in a period: a unit whose attendance is well below the company, whose late "
        "arrivals or overtime are unusually high, or whose 12-month attrition is a hot-spot, each with severity and the "
        "numbers. Use it for 'which unit needs my attention' and 'is any unit out of line'.",
        units_attention,
        page=PAGE,
        period=DEFAULT_PERIOD,
    ),
]
