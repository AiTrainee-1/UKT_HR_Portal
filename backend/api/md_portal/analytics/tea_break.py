"""MD portal, Tea Break: is break discipline costing production time?

Source data is ``TeaBreakLog`` (one row per OUT/IN scan cycle at a gate) and the single ``TeaBreakRule`` (allowed
minutes). Minutes are NOT stored: they are derived with the live rule, and this module does that with the very same
building blocks as the HR Tea Break page and the Report Center's tea-break reports
(``reporting/definitions/gate_visitor_tea_common.py``: same rounding, same Indian-time day, same SQL filters), so this
page, those reports and the assistant can never disagree about a break.

What this module decides on top of them
---------------------------------------
Every break lands in exactly one of three groups (they add up to "breaks taken"):

* **measured**: finished, and no longer than 60 minutes. These are real breaks with a trustworthy length;
* **long**: finished, but longer than 60 minutes. The gate scanner toggles OUT/IN, so one forgotten scan pairs the wrong
  scans and produces "breaks" of several hours; the HR page and the Report Center flag these as "Long break";
* **no return**: no IN scan yet (still in progress, never came back, or the scan was missed).

Overruns, the average, "within allowance" and the minutes lost use ONLY the measured group, so one missed scan cannot
add hours to the headline. That is the Report Center's "Leave out long / unclosed breaks" switch turned on (the
parity tests prove the figures are identical). The other two groups are never hidden: they are counted and reported
as coverage.

Nothing here writes. The rule row is read with ``.filter(pk=1).first()`` (``TeaBreakRule.get()`` would INSERT it).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from django.db.models import Case, Count, F, IntegerField, Q, QuerySet, Sum, Value, When
from django.db.models.functions import ExtractHour, ExtractIsoWeekDay, ExtractMinute

from ...clock import FACTORY_TZ, ist_today
from ...models import EmployeeShiftAssignment, ShiftTemplate, TeaBreakLog
from ...reporting.definitions import gate_visitor_tea_common as C
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, prov

PAGE = "tea-break"

# ─── named thresholds (shown in provenance; the tests pin them) ─────────────────────────────────────────────────

#: A completed break longer than this is a probable missed scan, not a real break (the HR page's own cut-off).
SUSPECT_MINUTES = C.SUSPECT_MINUTES
#: "Repeat overrunner": this many overruns in the period. Same figure as the Report Center's tea exceptions report.
REPEAT_MIN_OVERRUNS = 3
#: Fewer measured breaks than this is too few to rank a group or call it a problem (marked "small sample").
MIN_SAMPLE_BREAKS = 20
#: A heat-map cell with fewer measured breaks than this shows its count but no rate.
MIN_CELL_BREAKS = 5
#: A day with fewer measured breaks than this is never named "the worst day".
MIN_DAY_BREAKS = 10
#: Periods longer than this are drawn by week instead of by day.
WEEKLY_ROLLUP_AFTER_DAYS = 62
MOVING_AVERAGE_DAYS = 7
#: A department or shift is flagged at this multiple of the overall overrun rate, and at least FLAG_MIN_OVERRUN_PCT.
FLAG_RATIO = 1.25
FLAG_MIN_OVERRUN_PCT = 15.0
CRITICAL_OVERRUN_PCT = 35.0
#: The whole selection is flagged from this overrun rate.
OVERALL_WARN_PCT = 20.0
#: A move of at least this many percentage points against the previous period is a trend; below STEADY it is "steady".
TREND_FLAG_POINTS = 5.0
TREND_CRITICAL_POINTS = 10.0
TREND_STEADY_POINTS = 2.0
#: Scan coverage below this share of active employees is itself worth telling the MD.
LOW_PARTICIPATION_PCT = 50.0
#: Share of break records that could not be measured before the MD is told.
UNMEASURED_WARN_PCT = 10.0
LIST_MAX = 25
LIST_DEFAULT = 10
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────


def _context() -> tuple[int, datetime | None, datetime]:
    """(allowed minutes, when the rule last changed, "now"): read once per analytics call so every figure of one answer
    uses the same rule and the same clock. Tests freeze the clock by patching ``gate_visitor_tea_common.now_utc``."""
    allowed, rule_at = C.tea_rule()
    return int(allowed), rule_at, C.now_utc()


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


def _slot_label(index: int) -> str:
    return f"{index // 2:02d}:{30 * (index % 2):02d}"


def _int_arg(value, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high] when given, a readable error when it
    is not a number."""
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


# ─── the queries ────────────────────────────────────────────────────────────────────────────────────────────────


def _breaks(scope: Scope, start: date, end: date) -> QuerySet:
    """Breaks that STARTED on an Indian-time day inside [start, end] for the people in scope (leavers included: their
    breaks stay in the history). A break belongs to the day it started, so 23:50 -> 00:10 is the earlier day."""
    lo, hi = C.ist_bounds(start, end)
    return TeaBreakLog.objects.filter(scope.employee_q("employee__"), out_at__gte=lo, out_at__lt=hi)


def _measures(allowed: int, now: datetime, *, people: bool = True, days: bool = False) -> dict:
    """The aggregates every figure here is built from. measured / long / no-return partition the rows."""
    minutes = C.break_minutes()
    measured = C.within_q(SUSPECT_MINUTES)
    overrun = C.long_q(allowed) & measured
    out = {
        "breaks": Count("id"),
        "measured": Count("id", filter=measured),
        "overruns": Count("id", filter=overrun),
        "measured_min": Sum(minutes, filter=measured),
        "over_sum": Sum(minutes, filter=overrun),
        "long_completed": Count("id", filter=C.long_q(SUSPECT_MINUTES)),
        "no_return": Count("id", filter=C.open_q()),
        "in_progress": Count("id", filter=C.in_progress_q(now)),
    }
    if people:
        out["people"] = Count("employee_id", distinct=True)
        out["active_people"] = Count("employee_id", distinct=True, filter=Q(employee__status="active"))
    if days:
        out["days"] = Count(C.ist_day_expr(), distinct=True)
    return out


_SUM_KEYS = ("breaks", "measured", "overruns", "measured_min", "over_sum", "long_completed", "no_return", "in_progress")


def _zero() -> dict:
    return dict.fromkeys(_SUM_KEYS, 0)


def _add(total: dict, raw: dict | None) -> dict:
    if raw:
        for key in _SUM_KEYS:
            total[key] += int(raw.get(key) or 0)
    return total


def _figures(raw: dict, allowed: int) -> dict:
    """Raw aggregates -> the figures the MD reads. "No data" is None, never 0: a rate needs measured breaks."""
    breaks = int(raw.get("breaks") or 0)
    measured = int(raw.get("measured") or 0)
    overruns = int(raw.get("overruns") or 0)
    # Each overrun counts only the minutes beyond the allowance (its rounded length minus the allowed minutes).
    lost = int(raw.get("over_sum") or 0) - allowed * overruns
    return {
        "breaks": breaks,
        "employees": int(raw.get("people") or 0),
        "measured": measured,
        "overruns": overruns,
        "avgMinutes": round(int(raw.get("measured_min") or 0) / measured, 1) if measured else None,
        "overrunPct": pct(overruns, measured),
        "compliancePct": pct(measured - overruns, measured),
        "minutesLost": lost if measured else None,
        "longCompleted": int(raw.get("long_completed") or 0),
        "noReturn": int(raw.get("no_return") or 0),
        "inProgress": int(raw.get("in_progress") or 0),
    }


def _totals(scope: Scope, start: date, end: date, allowed: int, now: datetime) -> dict:
    return _breaks(scope, start, end).aggregate(**_measures(allowed, now, days=True))


def _daily(scope: Scope, start: date, end: date, allowed: int, now: datetime) -> dict[date, dict]:
    """{Indian-time day: raw aggregates}, one query, only days that have breaks."""
    rows = (
        _breaks(scope, start, end)
        .annotate(d=C.ist_day_expr())
        .values("d")
        .annotate(**_measures(allowed, now, people=False))
        .order_by()
    )
    return {r["d"]: r for r in rows}


def _sum_days(per_day: dict[date, dict], start: date, end: date) -> dict:
    total = _zero()
    day = start
    while day <= end:
        _add(total, per_day.get(day))
        day += timedelta(days=1)
    return total


# ─── provenance (what the card's "How is this calculated?" says, and what the assistant quotes) ─────────────────


def _provenance(allowed: int, scope: Scope, period: Period, *, rows: dict[str, int | None]) -> dict[str, dict]:
    filters = [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()]
    same_rules = (
        "Same rule, rounding and Indian-time day as the HR Tea Break page and the Report Center's tea-break reports "
        "(figures equal those reports with 'Leave out long / unclosed breaks' switched on)."
    )
    return {
        "tea-breaks": prov(
            "tea-breaks",
            "Breaks taken",
            dataset="Gate tea-break scans",
            definition=(
                "One record for each trip to the tea break: the employee scans their tea-break QR at a gate to go out "
                "and again to come back. A break counts on the day it started (Indian time). People who have left are "
                "included, so a past period never changes."
            ),
            formula="number of break records that started in the period",
            rows=rows.get("breaks"),
            filters=filters,
            caveats=[
                "Only people who scan are counted: a low number may mean people do not scan, not that they do not "
                "take breaks.",
            ],
        ),
        "tea-overrun": prov(
            "tea-overrun",
            "Overrun and overrun rate",
            dataset="Gate tea-break scans, tea-break rule",
            definition=(
                f"A break is an overrun when it lasted longer than the {allowed} minutes HR allows, measured to the "
                f"nearest minute. Breaks over {SUSPECT_MINUTES} minutes and breaks with no return scan are left out "
                "because they usually mean a missed scan, not a real break."
            ),
            formula="overrun rate = overruns ÷ measured breaks × 100",
            rows=rows.get("measured"),
            filters=filters,
            caveats=[
                "The allowance is applied, as it stands today, to every break in the period, so changing the rule "
                "changes past figures.",
                same_rules,
            ],
        ),
        "tea-minutes-lost": prov(
            "tea-minutes-lost",
            "Minutes lost to overruns",
            dataset="Gate tea-break scans, tea-break rule",
            definition="Time on break beyond the allowance, added up over every overrun. Hours lost = minutes ÷ 60.",
            formula=f"sum of (minutes taken − {allowed} allowed) over each overrun",
            rows=rows.get("overruns"),
            filters=filters,
            caveats=[
                "It measures break time beyond the allowance. It cannot tell whether the line stood still or the work "
                "was made up later.",
                same_rules,
            ],
        ),
        "tea-average": prov(
            "tea-average",
            "Average break",
            dataset="Gate tea-break scans",
            definition="The mean length of the breaks that could be measured, compared with the allowed minutes.",
            formula="total minutes of measured breaks ÷ measured breaks",
            rows=rows.get("measured"),
            filters=filters,
            caveats=[
                "A double scan at the gate looks like a break of a minute or less and pulls the average down; the HR "
                "page and the Report Center count it the same way.",
            ],
        ),
        "tea-compliance": prov(
            "tea-compliance",
            "Within allowance",
            dataset="Gate tea-break scans, tea-break rule",
            definition=f"The share of measured breaks that finished within the {allowed} minutes allowed.",
            formula="(measured breaks − overruns) ÷ measured breaks × 100",
            rows=rows.get("measured"),
            filters=filters,
        ),
        "tea-coverage": prov(
            "tea-coverage",
            "Scan coverage",
            dataset="Gate tea-break scans, employee list",
            definition="How much of the workforce the scans cover: employees who scanned at least one break.",
            formula="active employees with a break ÷ active employees in the selection × 100",
            rows=rows.get("active"),
            filters=filters,
            caveats=[
                "Headcount is today's active employees (there is no headcount history).",
                "People who do not scan do not appear, so overrun figures describe the people who scan.",
            ],
        ),
        "tea-unmeasured": prov(
            "tea-unmeasured",
            "Breaks left out of the averages",
            dataset="Gate tea-break scans",
            definition=(
                f"Breaks longer than {SUSPECT_MINUTES} minutes (the scanner probably paired the wrong scans) and "
                "breaks with no return scan. They count in 'Breaks taken' but not in overruns, averages or minutes lost."
            ),
            formula="breaks taken − measured breaks",
            rows=rows.get("unmeasured"),
            filters=filters,
            caveats=["A missed scan inverts the OUT/IN pairing for the rest of that day, so these are worth a check."],
        ),
        "tea-previous": prov(
            "tea-previous",
            "Comparison with the previous period",
            dataset="Gate tea-break scans",
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


def _no_data_note(period: Period) -> str:
    return f"No tea-break scans were recorded for this selection ({period.label})."


def _rule_notes(allowed: int, rule_at: datetime | None) -> list[str]:
    notes = []
    if rule_at is None:
        notes.append(f"No tea-break rule has been saved yet, so the default allowance of {allowed} minutes is used.")
    if allowed >= SUSPECT_MINUTES:
        notes.append(
            f"The allowance ({allowed} minutes) is at or above the {SUSPECT_MINUTES}-minute missed-scan cut-off, so no "
            "break can be counted as an overrun. Lower the allowance, or the figures here will show none."
        )
    return notes


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────


def _coverage(raw: dict, figs: dict, active: int, period: Period) -> dict:
    scanning = int(raw.get("active_people") or 0)
    unmeasured = figs["longCompleted"] + figs["noReturn"]
    return {
        "activeEmployees": active,
        "employeesScanning": scanning,
        "participationPct": pct(scanning, active),
        "daysWithScans": int(raw.get("days") or 0),
        "daysInPeriod": period.days,
        "breaks": figs["breaks"],
        "measured": figs["measured"],
        "longCompleted": figs["longCompleted"],
        "noReturn": figs["noReturn"],
        "inProgress": figs["inProgress"],
        "unmeasured": unmeasured,
        "unmeasuredPct": pct(unmeasured, figs["breaks"]),
    }


def _coverage_note(cov: dict) -> str | None:
    if not cov["breaks"]:
        return None
    parts = [
        f"{_num(cov['employeesScanning'])} of {_num(cov['activeEmployees'])} active employees "
        f"({_p(cov['participationPct'])}) scanned at least one break"
    ]
    if cov["unmeasured"]:
        detail = []
        if cov["longCompleted"]:
            detail.append(
                f"{_num(cov['longCompleted'])} lasted over {SUSPECT_MINUTES} minutes (a scan was probably missed)"
            )
        if cov["noReturn"]:
            live = f", {_num(cov['inProgress'])} still in progress" if cov["inProgress"] else ""
            detail.append(f"{_num(cov['noReturn'])} have no return scan{live}")
        parts.append(
            f"{_num(cov['unmeasured'])} of {_num(cov['breaks'])} breaks ({_p(cov['unmeasuredPct'])}) could not be "
            f"measured and are left out of overruns and averages: {'; '.join(detail)}"
        )
    return ". ".join(parts) + "."


@cached()
def tea_summary(scope: Scope, period: Period) -> dict:
    """Breaks, people, average length, overruns, minutes lost and compliance, each against the previous period, plus
    how complete the scans are. The one call the KPI strip, the Dashboard and the assistant all rest on."""
    allowed, rule_at, now = _context()
    previous = period.previous()
    cur_raw = _totals(scope, period.start, period.end, allowed, now)
    prev_raw = _totals(scope, previous.start, previous.end, allowed, now)
    active = scope.employees().count()
    cur, prev = _figures(cur_raw, allowed), _figures(prev_raw, allowed)
    cov = _coverage(cur_raw, cur, active, period)

    def metric(key: str) -> dict:
        return {"value": cur[key], "previous": prev[key], "change": change(cur[key], prev[key])}

    keys = ("breaks", "employees", "measured", "avgMinutes", "overruns", "overrunPct", "compliancePct", "minutesLost")
    lost = cur["minutesLost"]
    notes = [] if cur["breaks"] else [_no_data_note(period)]
    note = _coverage_note(cov)
    if note:
        notes.append(note)
    notes.extend(_rule_notes(allowed, rule_at))
    if cur["breaks"] and C.to_ist(now).date() <= period.end:
        notes.append("Today is still in progress, so the latest day is partial.")
    prov_all = _provenance(
        allowed,
        scope,
        period,
        rows={
            "breaks": cur["breaks"],
            "measured": cur["measured"],
            "overruns": cur["overruns"],
            "active": active,
            "unmeasured": cov["unmeasured"],
        },
    )
    return envelope(
        {
            "allowedMinutes": allowed,
            "metrics": {key: metric(key) for key in keys},
            "hoursLost": round(lost / 60, 1) if lost is not None else None,
            "withinAllowance": cur["measured"] - cur["overruns"] if cur["measured"] else None,
            "previousPeriod": previous.to_json(),
            "coverage": cov,
        },
        period=period,
        scope=scope,
        provenance=_pick(
            prov_all,
            "tea-breaks",
            "tea-overrun",
            "tea-minutes-lost",
            "tea-average",
            "tea-compliance",
            "tea-coverage",
            "tea-unmeasured",
            "tea-previous",
        ),
        notes=notes,
    )


# ─── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _point(first_day: date, days: int, raw: dict, allowed: int) -> dict:
    f = _figures(raw, allowed)
    return {
        "date": first_day.isoformat(),
        "days": days,
        "breaks": f["breaks"],
        "measured": f["measured"],
        "overruns": f["overruns"],
        "overrunPct": f["overrunPct"],
        "minutesLost": f["minutesLost"],
        "avgMinutes": f["avgMinutes"],
        "maOverrunPct": None,
        "maMinutesLost": None,
    }


def _momentum(per_day: dict[date, dict], end: date, allowed: int, today: date) -> dict:
    """Is it getting better or worse? The last 7 days of the period against the 7 days before them. A verdict needs
    enough measured breaks on both sides; otherwise it says it cannot tell."""
    window = MOVING_AVERAGE_DAYS
    cur_start = end - timedelta(days=window - 1)
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=window - 1)
    cur = _figures(_sum_days(per_day, cur_start, end), allowed)
    prev = _figures(_sum_days(per_day, prev_start, prev_end), allowed)
    delta = change(cur["overrunPct"], prev["overrunPct"])
    enough = cur["measured"] >= MIN_SAMPLE_BREAKS and prev["measured"] >= MIN_SAMPLE_BREAKS
    until = "today" if end >= today else end.strftime("%d %b")
    if not enough or delta is None:
        verdict = "unclear"
        text = (
            f"Not enough measured breaks in the 7 days to {until} and the 7 days before to say whether break "
            "discipline is getting better or worse."
        )
    elif delta["abs"] >= TREND_STEADY_POINTS:
        verdict = "worse"
        text = (
            f"Getting worse: {_p(cur['overrunPct'], 1)} of breaks ran over in the 7 days to {until}, up "
            f"{_num(delta['abs'], 1)} points on the 7 days before ({_p(prev['overrunPct'], 1)})."
        )
    elif delta["abs"] <= -TREND_STEADY_POINTS:
        verdict = "better"
        text = (
            f"Getting better: {_p(cur['overrunPct'], 1)} of breaks ran over in the 7 days to {until}, down "
            f"{_num(abs(delta['abs']), 1)} points on the 7 days before ({_p(prev['overrunPct'], 1)})."
        )
    else:
        verdict = "steady"
        text = (
            f"Holding steady: {_p(cur['overrunPct'], 1)} of breaks ran over in the 7 days to {until} "
            f"(the 7 days before: {_p(prev['overrunPct'], 1)})."
        )
    return {
        "windowDays": window,
        "verdict": verdict,
        "text": text,
        "current": {"start": cur_start.isoformat(), "end": end.isoformat(), **_window_json(cur)},
        "previous": {"start": prev_start.isoformat(), "end": prev_end.isoformat(), **_window_json(prev)},
        "overrunPctChange": delta,
        "minutesLostChange": change(cur["minutesLost"], prev["minutesLost"]),
    }


def _window_json(f: dict) -> dict:
    return {
        "breaks": f["breaks"],
        "measured": f["measured"],
        "overrunPct": f["overrunPct"],
        "minutesLost": f["minutesLost"],
    }


@cached()
def tea_trend(scope: Scope, period: Period) -> dict:
    """Overrun rate and minutes lost day by day (week by week beyond 62 days), with a 7-day moving average and a
    verdict on whether the last week is better or worse than the one before."""
    allowed, rule_at, now = _context()
    window = MOVING_AVERAGE_DAYS
    # Enough history for the first day's moving average and for the "last 7 vs the 7 before" verdict.
    first = min(period.start, period.end - timedelta(days=2 * window - 1)) - timedelta(days=window - 1)
    per_day = _daily(scope, first, period.end, allowed, now)

    period_days = [period.start + timedelta(days=n) for n in range(period.days)]
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    points: list[dict] = []
    if weekly:
        by_week: dict[date, list[date]] = {}
        for d in period_days:
            by_week.setdefault(d - timedelta(days=d.weekday()), []).append(d)
        for days in by_week.values():
            raw = _zero()
            for d in days:
                _add(raw, per_day.get(d))
            points.append(_point(days[0], len(days), raw, allowed))
    else:
        for d in period_days:
            point = _point(d, 1, per_day.get(d) or _zero(), allowed)
            ma = _figures(_sum_days(per_day, d - timedelta(days=window - 1), d), allowed)
            point["maOverrunPct"] = ma["overrunPct"]
            point["maMinutesLost"] = round(ma["minutesLost"] / window, 1) if ma["minutesLost"] is not None else None
            points.append(point)

    worst = None
    if not weekly:
        candidates = [p for p in points if p["measured"] >= MIN_DAY_BREAKS and p["minutesLost"]]
        if candidates:
            top = max(candidates, key=lambda p: (p["minutesLost"], p["overrunPct"] or 0, p["date"]))
            worst = {key: top[key] for key in ("date", "overrunPct", "overruns", "measured", "minutesLost")}

    total = _figures(_sum_days(per_day, period.start, period.end), allowed)
    notes = [] if total["breaks"] else [_no_data_note(period)]
    notes.extend(_rule_notes(allowed, rule_at))
    entries = _provenance(allowed, scope, period, rows={"breaks": total["breaks"], "measured": total["measured"]})
    entries["tea-trend"] = prov(
        "tea-trend",
        "Trend",
        dataset="Gate tea-break scans, tea-break rule",
        definition=(
            "Each day's overrun rate is its overruns ÷ its measured breaks. The 7-day average adds up the last 7 "
            "calendar days' overruns and measured breaks before dividing, so busy days count for more than quiet "
            f"ones; its minutes lost are the 7-day total ÷ 7. Periods over {WEEKLY_ROLLUP_AFTER_DAYS} days are shown "
            "by week (Monday to Sunday) with no moving average."
        ),
        formula="overrun rate = overruns ÷ measured breaks × 100; 'better or worse' compares the last 7 days with the 7 before",
        rows=total["measured"],
        filters=[period.label, scope.describe()],
        caveats=[
            "Days with no measured breaks (weekly offs, holidays, no scans) have no rate and appear as gaps.",
            f"A verdict needs at least {MIN_SAMPLE_BREAKS} measured breaks in each of the two weeks.",
        ],
    )
    return envelope(
        {
            "allowedMinutes": allowed,
            "granularity": "week" if weekly else "day",
            "points": points,
            "momentum": _momentum(per_day, period.end, allowed, C.to_ist(now).date()),
            "worstDay": worst,
        },
        period=period,
        scope=scope,
        provenance=[entries["tea-trend"], *_pick(entries, "tea-breaks", "tea-overrun", "tea-minutes-lost")],
        notes=notes,
    )


# ─── rankings: departments, units, staff vs production, shifts ──────────────────────────────────────────────────

#: by -> (field on TeaBreakLog, field on Employee, label for "no value")
_GROUPS = {
    "department": ("employee__department__name", "department__name", "No department"),
    "unit": ("employee__branch__name", "branch__name", "No unit"),
    "type": ("employee__employment_type", "employment_type", "Not set"),
}
_TYPE_LABEL = {"staff": "Staff", "production": "Production"}
NONE_KEY = "__none__"
BY_CHOICES = (*_GROUPS, "shift")


def _group_row(
    key: str,
    label: str,
    cur_raw: dict | None,
    prev_raw: dict | None,
    allowed: int,
    total_lost: int,
    *,
    headcount: int | None = None,
    sub: str | None = None,
    extra: dict | None = None,
) -> dict:
    cur = _figures(cur_raw or _zero(), allowed)
    prev = _figures(prev_raw or _zero(), allowed)
    scanning = int((cur_raw or {}).get("active_people") or 0)
    lost = cur["minutesLost"]
    return {
        "key": key,
        "label": label,
        "sub": sub,
        "headcount": headcount,
        "employees": cur["employees"],
        "participationPct": pct(scanning, headcount) if headcount is not None else None,
        "breaks": cur["breaks"],
        "measured": cur["measured"],
        "avgMinutes": cur["avgMinutes"],
        "overruns": cur["overruns"],
        "overrunPct": cur["overrunPct"],
        "minutesLost": lost,
        "shareOfLostPct": pct(lost, total_lost) if lost is not None else None,
        "lowSample": cur["measured"] < MIN_SAMPLE_BREAKS,
        "previous": {"breaks": prev["breaks"], "overrunPct": prev["overrunPct"], "minutesLost": prev["minutesLost"]},
        "change": {
            "overrunPct": change(cur["overrunPct"], prev["overrunPct"]),
            "minutesLost": change(lost, prev["minutesLost"]),
        },
        **(extra or {}),
    }


def _rank_key(row: dict):
    lost = row["minutesLost"]
    return (lost is None, -(lost or 0), -(row["overrunPct"] or 0), row["label"].lower())


def _breakdown(
    rows: list[dict],
    cur_total: dict,
    allowed: int,
    *,
    by: str,
    limit: int,
    scope: Scope,
    period: Period,
    entries: dict[str, dict],
    extra_prov: list[dict],
    notes: list[str],
) -> dict:
    rows.sort(key=_rank_key)
    overall = _figures(cur_total, allowed)
    return envelope(
        {
            "by": by,
            "allowedMinutes": allowed,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "average": {
                "overrunPct": overall["overrunPct"],
                "avgMinutes": overall["avgMinutes"],
                "measured": overall["measured"],
                "minutesLost": overall["minutesLost"],
            },
            "minSample": MIN_SAMPLE_BREAKS,
        },
        period=period,
        scope=scope,
        provenance=[*extra_prov, *_pick(entries, "tea-overrun", "tea-minutes-lost", "tea-previous")],
        notes=notes,
    )


def _group_prov_entries(allowed: int, scope: Scope, period: Period, total: dict) -> dict[str, dict]:
    return _provenance(
        allowed,
        scope,
        period,
        rows={"breaks": total["breaks"], "measured": total["measured"], "overruns": total["overruns"]},
    )


def _grouped(scope: Scope, start: date, end: date, log_field: str, allowed: int, now: datetime) -> dict:
    """{group value: raw aggregates} for the breaks that started in [start, end], one query."""
    qs = _breaks(scope, start, end).values(grp=F(log_field)).annotate(**_measures(allowed, now)).order_by()
    return {r["grp"]: r for r in qs}


@cached()
def tea_departments(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    """Where the overruns are: ranked by minutes lost, by department (same name in several units = one department),
    unit, or staff vs production, with the change against the previous period and the scan participation."""
    if by not in _GROUPS:
        raise MdParamError(f"'by' must be one of: {', '.join(BY_CHOICES)}.")
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    allowed, rule_at, now = _context()
    log_field, emp_field, none_label = _GROUPS[by]
    previous = period.previous()

    cur = _grouped(scope, period.start, period.end, log_field, allowed, now)
    prev = _grouped(scope, previous.start, previous.end, log_field, allowed, now)
    heads = dict(scope.employees().values_list(emp_field).annotate(n=Count("id")).order_by())

    total_raw = _zero()
    for raw in cur.values():
        _add(total_raw, raw)
    total_lost = _figures(total_raw, allowed)["minutesLost"] or 0
    rows = []
    for grp in set(cur) | set(heads):
        key = NONE_KEY if grp is None or grp == "" else str(grp)
        label = (
            none_label if key == NONE_KEY else (_TYPE_LABEL.get(grp, str(grp).title()) if by == "type" else str(grp))
        )
        rows.append(
            _group_row(key, label, cur.get(grp), prev.get(grp), allowed, total_lost, headcount=heads.get(grp, 0))
        )

    entries = _group_prov_entries(allowed, scope, period, total_raw)
    grouping = prov(
        "tea-grouping",
        "Ranking",
        dataset="Gate tea-break scans, employee list",
        definition=(
            "Breaks are grouped by the department, unit or type each employee belongs to today (there is no history "
            "of transfers). A department with the same name in several units is one department. Ranked by minutes "
            "lost, biggest first."
        ),
        formula="minutes lost per group; share = group minutes lost ÷ all minutes lost; participation = active employees "
        "with a break ÷ active employees in the group",
        rows=total_raw["breaks"],
        filters=[period.label, scope.describe()],
        caveats=[
            f"Groups with fewer than {MIN_SAMPLE_BREAKS} measured breaks are marked 'small sample' and are never "
            "called out as exceptions.",
            "A group with employees but no breaks shows no rate: nobody there scanned.",
        ],
    )
    notes = [] if total_raw["breaks"] else [_no_data_note(period)]
    notes.extend(_rule_notes(allowed, rule_at))
    return _breakdown(
        rows,
        total_raw,
        allowed,
        by=by,
        limit=limit,
        scope=scope,
        period=period,
        entries=entries,
        extra_prov=[grouping],
        notes=notes,
    )


def daily_minutes_lost(scope: Scope, period: Period) -> dict[date, int | None]:
    """Minutes lost to overruns on each day of the period that had breaks (None on a day with no measured break): the
    daily figures behind the trend and the summary, for the page that sets them beside other kinds of lost time."""
    allowed, _, now = _context()
    rows = _daily(scope, period.start, period.end, allowed, now)
    return {d: _figures(raw, allowed)["minutesLost"] for d, raw in rows.items()}


def department_minutes_lost(scope: Scope, period: Period) -> dict[str, int]:
    """Minutes lost to overruns by department name (the same name in several units is one department), for every
    department that had a measured break. Not capped, unlike the ranking, so a comparison never misses a department."""
    allowed, _, now = _context()
    log_field, _, none_label = _GROUPS["department"]
    out: dict[str, int] = {}
    for grp, raw in _grouped(scope, period.start, period.end, log_field, allowed, now).items():
        lost = _figures(raw, allowed)["minutesLost"]
        if lost is not None:
            label = none_label if grp is None or grp == "" else str(grp)
            out[label] = out.get(label, 0) + lost
    return out


class _Roster:
    """One employee's shift assignments. The shift on a day is the assignment covering it with the latest start (the
    attendance engine's own rule; the newest row wins a tie). 0 means no assignment covers that day."""

    __slots__ = ("rows",)

    def __init__(self, rows: list[dict]):
        self.rows = sorted(rows, key=lambda a: (a["effective_from"], a["id"]), reverse=True)

    def on(self, day: date) -> int:
        for a in self.rows:
            if a["effective_from"] <= day and (a["effective_to"] is None or a["effective_to"] >= day):
                return a["shift_id"]
        return 0

    def constant_over(self, start: date, end: date) -> int | None:
        """The one shift the employee is on for every day of [start, end], or None when it changes inside it. The shift
        can only change on a day an assignment starts or the day after one ends, so those are the days to look at."""
        days = {start}
        for a in self.rows:
            edges = [a["effective_from"]]
            if a["effective_to"] is not None:
                edges.append(a["effective_to"] + timedelta(days=1))
            days.update(edge for edge in edges if start < edge <= end)
        shifts = {self.on(d) for d in days}
        return shifts.pop() if len(shifts) == 1 else None


def _rosters(scope: Scope, start: date, end: date) -> dict[int, _Roster]:
    """The shift assignments of everyone in scope that touch [start, end], one query."""
    rows = (
        EmployeeShiftAssignment.objects.filter(scope.employee_q("employee__"), effective_from__lte=end)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=start))
        .values("id", "employee_id", "shift_id", "effective_from", "effective_to")
    )
    by_employee: dict[int, list[dict]] = {}
    for row in rows:
        by_employee.setdefault(row["employee_id"], []).append(row)
    return {employee_id: _Roster(group) for employee_id, group in by_employee.items()}


_NO_ASSIGNMENT = _Roster([])


def _shift_totals(
    scope: Scope, start: date, end: date, allowed: int, now: datetime, rosters: dict[int, _Roster]
) -> dict[int, dict]:
    """{shift id (0 = none): raw aggregates, with the number of people} for the breaks that started in [start, end].

    Almost everybody is on one shift for the whole period, so breaks are aggregated per employee in SQL (a few hundred
    rows) and credited to that shift. Only the few employees whose shift changes inside the period are aggregated per
    day and resolved day by day. Either way the query count does not depend on the number of breaks."""
    per_employee = {
        r["employee_id"]: r
        for r in _breaks(scope, start, end)
        .values("employee_id")
        .annotate(**_measures(allowed, now, people=False))
        .order_by()
    }
    totals: dict[int, dict] = {}
    people: dict[int, set[int]] = {}

    def credit(shift_id: int, raw: dict, employee_id: int) -> None:
        _add(totals.setdefault(shift_id, _zero()), raw)
        people.setdefault(shift_id, set()).add(employee_id)

    changing = []
    for employee_id, raw in per_employee.items():
        shift_id = rosters.get(employee_id, _NO_ASSIGNMENT).constant_over(start, end)
        if shift_id is None:
            changing.append(employee_id)
        else:
            credit(shift_id, raw, employee_id)
    if changing:
        days = (
            _breaks(scope, start, end)
            .filter(employee_id__in=changing)
            .annotate(d=C.ist_day_expr())
            .values("employee_id", "d")
            .annotate(**_measures(allowed, now, people=False))
            .order_by()
        )
        for raw in days:
            credit(rosters[raw["employee_id"]].on(raw["d"]), raw, raw["employee_id"])
    return {shift_id: {**raw, "people": len(people[shift_id])} for shift_id, raw in totals.items()}


@cached()
def tea_shifts(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """The same ranking by shift: a break counts under the shift the employee was assigned to the day it started."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    allowed, rule_at, now = _context()
    previous = period.previous()
    rosters = _rosters(scope, previous.start, period.end)

    def grouped(start: date, end: date) -> dict:
        return _shift_totals(scope, start, end, allowed, now, rosters)

    cur, prev = grouped(period.start, period.end), grouped(previous.start, previous.end)
    ids = {k for k in cur if k}
    templates = {
        t["id"]: t
        for t in ShiftTemplate.objects.filter(pk__in=ids).values(
            "id", "name", "shift_type", "start_time", "end_time", "branch__name"
        )
    }
    name_count: dict[str, int] = {}
    for t in templates.values():
        name_count[t["name"]] = name_count.get(t["name"], 0) + 1

    total_raw = _zero()
    for raw in cur.values():
        _add(total_raw, raw)
    total_lost = _figures(total_raw, allowed)["minutesLost"] or 0
    rows = []
    for shift_pk, raw in cur.items():
        if not shift_pk:
            rows.append(_group_row(NONE_KEY, "No shift assigned", raw, prev.get(shift_pk), allowed, total_lost))
            continue
        t = templates.get(shift_pk)
        if t is None:  # the template was deleted between the two queries: show it rather than lose its breaks
            rows.append(_group_row(str(shift_pk), "Unknown shift", raw, prev.get(shift_pk), allowed, total_lost))
            continue
        label = t["name"] if name_count[t["name"]] == 1 else f"{t['name']} ({t['branch__name'] or 'no unit'})"
        timing = f"{t['start_time']:%H:%M}–{t['end_time']:%H:%M} · {str(t['shift_type']).title()}"
        rows.append(_group_row(str(shift_pk), label, raw, prev.get(shift_pk), allowed, total_lost, sub=timing))

    entries = _group_prov_entries(allowed, scope, period, total_raw)
    attribution = prov(
        "tea-shift",
        "Shift comparison",
        dataset="Gate tea-break scans, shift assignments",
        definition=(
            "A break counts under the shift the employee was assigned to on the day it started. If two assignments "
            "overlap, the one that started later wins (the rule the attendance engine uses). Employees with no "
            "assignment that day are grouped as 'No shift assigned'. Ranked by minutes lost."
        ),
        formula="minutes lost per shift; share = shift minutes lost ÷ all minutes lost",
        rows=total_raw["breaks"],
        filters=[period.label, scope.describe()],
        caveats=[
            "Shift templates that share a name (each unit keeps its own) are listed separately with the unit in brackets.",
            "Rotations that are not recorded as shift assignments cannot be seen here.",
            f"Shifts with fewer than {MIN_SAMPLE_BREAKS} measured breaks are marked 'small sample'.",
        ],
    )
    notes = [] if total_raw["breaks"] else [_no_data_note(period)]
    unassigned = (cur.get(0) or {}).get("breaks") or 0
    if unassigned and total_raw["breaks"] and unassigned * 10 >= total_raw["breaks"]:
        notes.append(
            f"{_num(unassigned)} of {_num(total_raw['breaks'])} breaks are by employees with no shift assigned that day."
        )
    notes.extend(_rule_notes(allowed, rule_at))
    return _breakdown(
        rows,
        total_raw,
        allowed,
        by="shift",
        limit=limit,
        scope=scope,
        period=period,
        entries=entries,
        extra_prov=[attribution],
        notes=notes,
    )


# ─── when breaks happen: 30-minute slots by weekday ─────────────────────────────────────────────────────────────


@cached()
def tea_heatmap(scope: Scope, period: Period) -> dict:
    """Where breaks cluster and where they overrun: the half hour a break started in (Indian time) by weekday."""
    allowed, rule_at, now = _context()
    rows = (
        _breaks(scope, period.start, period.end)
        .annotate(
            wd=ExtractIsoWeekDay("out_at", tzinfo=FACTORY_TZ),
            hr=ExtractHour("out_at", tzinfo=FACTORY_TZ),
            mn=ExtractMinute("out_at", tzinfo=FACTORY_TZ),
        )
        .annotate(
            slot=F("hr") * 2 + Case(When(mn__gte=30, then=Value(1)), default=Value(0), output_field=IntegerField())
        )
        .values("wd", "slot")
        .annotate(**_measures(allowed, now, people=False))
        .order_by("wd", "slot")
    )
    cells, by_slot, by_day = [], {}, {}
    total_breaks = 0
    for r in rows:
        f = _figures(r, allowed)
        weekday = int(r["wd"]) - 1
        slot = int(r["slot"])
        total_breaks += f["breaks"]
        reliable = f["measured"] >= MIN_CELL_BREAKS
        cells.append(
            {
                "weekday": weekday,
                "slot": slot,
                "breaks": f["breaks"],
                "measured": f["measured"],
                "overruns": f["overruns"],
                "overrunPct": f["overrunPct"] if reliable else None,
                "minutesLost": f["minutesLost"],
            }
        )
        _add(by_slot.setdefault(slot, _zero()), r)
        _add(by_day.setdefault(weekday, _zero()), r)

    slots = []
    if cells:
        lo, hi = min(c["slot"] for c in cells), max(c["slot"] for c in cells)
        slots = [{"index": i, "label": _slot_label(i)} for i in range(lo, hi + 1)]
    busiest = sorted(by_slot.items(), key=lambda kv: (-kv[1]["breaks"], kv[0]))[:3]
    worst = sorted(
        (c for c in cells if c["overrunPct"] is not None and c["overruns"]),
        key=lambda c: (-c["overrunPct"], -(c["minutesLost"] or 0), c["weekday"], c["slot"]),
    )[:3]
    by_weekday = []
    for d in range(7):
        f = _figures(by_day.get(d) or _zero(), allowed)
        by_weekday.append(
            {
                "weekday": d,
                "label": WEEKDAYS[d],
                "breaks": f["breaks"],
                "measured": f["measured"],
                "overruns": f["overruns"],
                "overrunPct": f["overrunPct"],
                "minutesLost": f["minutesLost"],
            }
        )
    entries = _provenance(allowed, scope, period, rows={"breaks": total_breaks})
    entries["tea-slots"] = prov(
        "tea-slots",
        "Time of day and weekday",
        dataset="Gate tea-break scans",
        definition=(
            "Each break counts in the half hour in which it started (Indian time) and on the weekday of that day. "
            "The overrun rate of a cell is its overruns ÷ its measured breaks."
        ),
        formula="cell = breaks started in that half hour on that weekday, summed over every such day in the period",
        rows=total_breaks,
        filters=[period.label, scope.describe()],
        caveats=[
            f"A cell with fewer than {MIN_CELL_BREAKS} measured breaks shows its count but no rate.",
            "Night-shift breaks appear in their own hours (00:00 to 05:59), under the weekday they started on.",
        ],
    )
    notes = [] if total_breaks else [_no_data_note(period)]
    notes.extend(_rule_notes(allowed, rule_at))
    return envelope(
        {
            "allowedMinutes": allowed,
            "weekdays": list(WEEKDAYS),
            "slots": slots,
            "cells": cells,
            "totalBreaks": total_breaks,
            "minCellBreaks": MIN_CELL_BREAKS,
            "busiestSlots": [
                {
                    "slot": i,
                    "label": _slot_label(i),
                    "breaks": raw["breaks"],
                    "sharePct": pct(raw["breaks"], total_breaks),
                }
                for i, raw in busiest
            ],
            "worstCells": [
                {
                    "weekday": WEEKDAYS[c["weekday"]],
                    "slot": c["slot"],
                    "label": _slot_label(c["slot"]),
                    "overrunPct": c["overrunPct"],
                    "measured": c["measured"],
                    "minutesLost": c["minutesLost"],
                }
                for c in worst
            ],
            "byWeekday": by_weekday,
        },
        period=period,
        scope=scope,
        provenance=[entries["tea-slots"], *_pick(entries, "tea-breaks", "tea-overrun")],
        notes=notes,
    )


@cached()
def tea_peak_times(scope: Scope, period: Period) -> dict:
    """The heat map without its grid: for the assistant, which half hours are busiest and which overrun most."""
    data = dict(tea_heatmap(scope, period))
    data.pop("cells", None)
    data.pop("slots", None)
    return data


# ─── repeat overrunners ─────────────────────────────────────────────────────────────────────────────────────────


@cached()
def tea_offenders(
    scope: Scope, period: Period, limit: int = LIST_DEFAULT, min_overruns: int = REPEAT_MIN_OVERRUNS
) -> dict:
    """People who overran at least ``min_overruns`` times: how often, how much time, and their worst case. Names are
    shown because this is an exception list the MD acts on."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    min_overruns = _int_arg(min_overruns, "min_overruns", REPEAT_MIN_OVERRUNS, 1, 100)
    allowed, rule_at, now = _context()
    people = list(
        _breaks(scope, period.start, period.end)
        .values(
            "employee_id",
            "employee__employee_code",
            "employee__first_name",
            "employee__last_name",
            "employee__department__name",
            "employee__branch__name",
            "employee__employment_type",
        )
        .annotate(**_measures(allowed, now, people=False))
        .filter(overruns__gte=1)
        .order_by()
    )
    figures = [(r, _figures(r, allowed)) for r in people]
    figures.sort(key=lambda rf: (-rf[1]["overruns"], -(rf[1]["minutesLost"] or 0), rf[0]["employee__employee_code"]))
    repeaters = [(r, f) for r, f in figures if f["overruns"] >= min_overruns]
    total_lost = sum(f["minutesLost"] or 0 for _, f in figures)
    repeat_lost = sum(f["minutesLost"] or 0 for _, f in repeaters)
    top = repeaters[:limit]

    worst: dict[int, tuple[int, datetime]] = {}
    if top:
        detail = (
            _breaks(scope, period.start, period.end)
            .filter(employee_id__in=[r["employee_id"] for r, _ in top])
            .filter(C.long_q(allowed) & C.within_q(SUSPECT_MINUTES))
            .annotate(taken=C.break_minutes())
            .values("employee_id", "out_at", "taken")
        )
        for d in detail:  # the longest overrun; on a tie the earlier one
            best = worst.get(d["employee_id"])
            if best is None or d["taken"] > best[0] or (d["taken"] == best[0] and d["out_at"] < best[1]):
                worst[d["employee_id"]] = (d["taken"], d["out_at"])

    out_rows = []
    for r, f in top:
        taken, when = worst.get(r["employee_id"], (None, None))
        out_rows.append(
            {
                "employeeCode": r["employee__employee_code"],
                "employeeName": C.person_name(r["employee__first_name"], r["employee__last_name"]),
                "department": r["employee__department__name"] or "No department",
                "unit": r["employee__branch__name"],
                "type": _TYPE_LABEL.get(r["employee__employment_type"], r["employee__employment_type"]),
                "breaks": f["breaks"],
                "measured": f["measured"],
                "overruns": f["overruns"],
                "overrunPct": f["overrunPct"],
                "minutesLost": f["minutesLost"],
                "averageOverBy": round(f["minutesLost"] / f["overruns"], 1) if f["overruns"] else None,
                "worstMinutes": taken,
                "worstOverBy": taken - allowed if taken is not None else None,
                "worstDate": C.to_ist(when).date().isoformat() if when else None,
            }
        )
    entries = _provenance(allowed, scope, period, rows={"overruns": sum(f["overruns"] for _, f in figures)})
    entries["tea-repeat"] = prov(
        "tea-repeat",
        "Repeat overrunners",
        dataset="Gate tea-break scans, employee list",
        definition=(
            f"Employees who overran at least {min_overruns} times in the period (the Report Center's tea-break "
            f"exceptions report uses the same {REPEAT_MIN_OVERRUNS}). Their overrun rate is their overruns ÷ their "
            "measured breaks; the worst case is their longest measured break (the earlier date on a tie)."
        ),
        formula=f"overruns per employee ≥ {min_overruns}; minutes lost = Σ (minutes taken − {allowed} allowed)",
        rows=sum(f["overruns"] for _, f in figures),
        filters=[period.label, scope.describe()],
        caveats=[
            "People who have since left are included.",
            "A break with no return scan, or longer than 60 minutes, is never counted as an overrun.",
        ],
    )
    notes: list[str] = []
    if not figures:
        anything = _breaks(scope, period.start, period.end).exists()
        notes.append("Nobody overran their break in this period." if anything else _no_data_note(period))
    notes.extend(_rule_notes(allowed, rule_at))
    return envelope(
        {
            "allowedMinutes": allowed,
            "threshold": min_overruns,
            "total": len(repeaters),
            "overrunners": len(figures),
            "rows": out_rows,
            "truncated": len(repeaters) > limit,
            "minutesLostByRepeaters": repeat_lost if figures else None,
            "shareOfMinutesLostPct": pct(repeat_lost, total_lost),
        },
        period=period,
        scope=scope,
        provenance=[entries["tea-repeat"], *_pick(entries, "tea-overrun", "tea-minutes-lost")],
        notes=notes,
    )


# ─── the rule, in plain words ───────────────────────────────────────────────────────────────────────────────────


@cached(30)
def tea_rule() -> dict:
    """What counts as an overrun. The rule is ONE number HR sets (there are no grace minutes and no break windows in
    the data), plus fixed cut-offs for breaks that cannot be trusted. Said in plain words so the MD can read it."""
    allowed, rule_at, _ = _context()
    statements = [
        f"A tea break may last up to {allowed} minutes. A finished break counts as an overrun when it lasted longer "
        "than that, measured to the nearest whole minute.",
        "There is no grace period on top and no fixed break times: the rule is one number, the same for every employee, "
        "unit and shift.",
        f"Minutes lost are the minutes beyond the allowance: a {allowed + 3}-minute break with {allowed} allowed loses 3 minutes.",
        f"A break with no return scan is not counted as an overrun. It shows as in progress for up to "
        f"{C.NOT_RETURNED_MINUTES} minutes and as not returned after that.",
        f"A finished break longer than {SUSPECT_MINUTES} minutes is treated as a probable missed scan (the scanner "
        "pairs the wrong scans) and is left out of overruns, averages and minutes lost; it is counted separately.",
        "The allowance is applied, as it stands today, to every break in the period. If HR changes it, earlier "
        "periods are recalculated with the new number.",
        "Tea breaks do not affect attendance or payroll: this page is for information.",
    ]
    notes = _rule_notes(allowed, rule_at)
    entry = prov(
        "tea-rule",
        "The tea-break rule",
        dataset="Tea-break rule (HR portal, Outpass & Visitors, Tea Break)",
        definition=(
            "HR sets one allowed length for a tea break. Breaks are measured from the OUT scan to the IN scan at the "
            "gate and rounded to the nearest minute."
        ),
        formula=f"overrun = break minutes > {allowed}",
        rows=None,
        filters=["Applies to every employee, unit and shift"],
        caveats=["The rule is read, never changed, from this portal.", *notes],
    )
    return envelope(
        {
            "allowedMinutes": allowed,
            "isDefault": rule_at is None,
            "updatedAt": C.to_ist(rule_at).date().isoformat() if rule_at else None,
            "missedScanMinutes": SUSPECT_MINUTES,
            "notReturnedMinutes": C.NOT_RETURNED_MINUTES,
            "leftOpenHours": int(C.STALE_OPEN_CUTOFF.total_seconds() // 3600),
            "repeatMinOverruns": REPEAT_MIN_OVERRUNS,
            "minSampleBreaks": MIN_SAMPLE_BREAKS,
            "hasGrace": False,
            "hasWindows": False,
            "statements": statements,
        },
        provenance=[entry],
        notes=notes,
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ──────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"tea-break.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _worst_group(rows: list[dict], overall_pct: float | None) -> dict | None:
    """The group with the highest overrun rate that is large enough to trust and clearly worse than the overall rate."""
    if overall_pct is None:
        return None
    candidates = [
        r
        for r in rows
        if not r["lowSample"]
        and r["overrunPct"] is not None
        and r["key"] != NONE_KEY
        and r["overrunPct"] >= FLAG_MIN_OVERRUN_PCT
        and r["overrunPct"] >= FLAG_RATIO * overall_pct
    ]
    return max(candidates, key=lambda r: (r["overrunPct"], r["minutesLost"] or 0), default=None)


def _exceptions(scope: Scope, period: Period, *, limit: int) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``.
    Built on the public analytics so a flag always points at a figure that is on the page."""
    summary = tea_summary(scope, period)
    allowed = summary["allowedMinutes"]
    m = summary["metrics"]
    cov = summary["coverage"]
    cur_pct, prev_pct = m["overrunPct"]["value"], m["overrunPct"]["previous"]
    measured, prev_measured = m["measured"]["value"], m["measured"]["previous"]
    lost = m["minutesLost"]["value"]
    prev_phrase = _previous_phrase(period)
    items: list[dict] = []
    enough = measured >= MIN_SAMPLE_BREAKS

    if enough and cur_pct is not None and cur_pct >= OVERALL_WARN_PCT:
        items.append(
            _item(
                "overall",
                "critical" if cur_pct >= CRITICAL_OVERRUN_PCT else "warning",
                f"{_p(cur_pct)} of tea breaks ran over the {allowed}-minute allowance",
                f"{period.label}: {_num(m['overruns']['value'])} of {_num(measured)} breaks ran over; "
                f"{_num(lost)} minutes ({_num(summary['hoursLost'], 1)} hours) lost.",
                f"{_num(lost)} min lost",
                f"Why are so many tea breaks running over the {allowed}-minute allowance ({period.label}), and which "
                "departments and shifts drive it?",
            )
        )

    if enough and prev_measured >= MIN_SAMPLE_BREAKS and cur_pct is not None and prev_pct is not None:
        delta = cur_pct - prev_pct
        if delta >= TREND_FLAG_POINTS:
            items.append(
                _item(
                    "trend",
                    "critical" if delta >= TREND_CRITICAL_POINTS else "warning",
                    f"Break overruns rose to {_p(cur_pct)} from {_p(prev_pct)}",
                    f"{period.label} against {prev_phrase}: up {_num(delta, 1)} points.",
                    f"+{_num(delta, 1)} pts",
                    f"Why did tea-break overruns rise from {_p(prev_pct)} to {_p(cur_pct)} ({period.label}), and where?",
                )
            )
        elif delta <= -TREND_FLAG_POINTS:
            items.append(
                _item(
                    "trend",
                    "good",
                    f"Break overruns fell to {_p(cur_pct)} from {_p(prev_pct)}",
                    f"{period.label} against {prev_phrase}: down {_num(abs(delta), 1)} points.",
                    f"-{_num(abs(delta), 1)} pts",
                    f"What improved tea-break discipline, from {_p(prev_pct)} to {_p(cur_pct)} overruns ({period.label})?",
                )
            )

    if enough:
        departments = tea_departments(scope, period, by="department", limit=LIST_MAX)
        worst = _worst_group(departments["rows"], cur_pct)
        if worst:
            items.append(_group_item("department", worst, cur_pct, allowed, period))
        shifts = tea_shifts(scope, period, limit=LIST_MAX)
        worst = _worst_group(shifts["rows"], cur_pct)
        if worst:
            items.append(_group_item("shift", worst, cur_pct, allowed, period))

    repeat = tea_offenders(scope, period, limit=1)
    if repeat["total"]:
        n, share = repeat["total"], repeat["shareOfMinutesLostPct"]
        items.append(
            _item(
                "repeat",
                "warning" if n >= 5 or (share or 0) >= 50 else "info",
                f"{_num(n)} {_plural(n, 'person', 'people')} overran their break {REPEAT_MIN_OVERRUNS} or more times",
                f"{period.label}: they account for {_p(share)} of the minutes lost to overruns. The names are on the "
                "Tea Break page.",
                _num(n),
                f"Who are the repeat tea-break overrunners ({period.label}) and how much time do they account for?",
            )
        )

    if cov["breaks"] and cov["participationPct"] is not None and cov["participationPct"] < LOW_PARTICIPATION_PCT:
        items.append(
            _item(
                "coverage",
                "info",
                f"Only {_p(cov['participationPct'])} of employees scanned a tea break",
                f"{_num(cov['employeesScanning'])} of {_num(cov['activeEmployees'])} active employees. Overrun figures "
                "describe only the people who scan, so the real picture may differ.",
                _p(cov["participationPct"]),
                f"How complete are the tea-break scans ({period.label}), and which departments do not scan?",
            )
        )
    if cov["breaks"] and (cov["unmeasuredPct"] or 0) >= UNMEASURED_WARN_PCT:
        items.append(
            _item(
                "unmeasured",
                "info",
                f"{_p(cov['unmeasuredPct'])} of tea-break records could not be measured",
                f"{_num(cov['unmeasured'])} of {_num(cov['breaks'])} breaks lasted over {SUSPECT_MINUTES} minutes or have "
                "no return scan: a scan was probably missed, so they are left out of the overrun figures.",
                _num(cov["unmeasured"]),
                f"Why are so many tea-break records unmeasured ({period.label}), and where are the scans being missed?",
            )
        )

    # Good news is only said when there is nothing to worry about (and no other good news already says it).
    if enough and cur_pct is not None and all(i["severity"] == "info" for i in items):
        items.append(
            _item(
                "healthy",
                "good",
                f"No tea-break exceptions: {_p(cur_pct)} of breaks ran over the allowance",
                f"{period.label}: {_num(m['overruns']['value'])} of {_num(measured)} breaks ran past {allowed} minutes.",
                _p(cur_pct),
                f"Summarise tea-break discipline ({period.label}).",
            )
        )
    # Stable: findings of equal severity keep the order in which they were found (which is the order of importance).
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


def _group_item(kind: str, row: dict, overall_pct: float, allowed: int, period: Period) -> dict:
    what = row["label"] if kind == "department" else f"The {row['label']} shift"
    return _item(
        kind,
        "critical" if row["overrunPct"] >= CRITICAL_OVERRUN_PCT else "warning",
        f"{what} breaks run over {_p(row['overrunPct'])} of the time, against {_p(overall_pct)} overall",
        f"{period.label}: {_num(row['overruns'])} of {_num(row['measured'])} breaks ran past {allowed} minutes; "
        f"{_num(row['minutesLost'])} minutes lost ({_p(row['shareOfLostPct'])} of the total).",
        _p(row["overrunPct"]),
        f"Why do {row['label']} tea-break overruns run at {_p(row['overrunPct'])} ({period.label}), and who drives it?",
    )


@cached()
def tea_attention(scope: Scope, period: Period) -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    items = _exceptions(scope, period, limit=6)
    thresholds = prov(
        "tea-attention",
        "Needs your attention",
        dataset="Gate tea-break scans, shift assignments, employee list",
        definition=(
            f"A department or shift is flagged when its overrun rate is at least {FLAG_RATIO}× the overall rate and at "
            f"least {_p(FLAG_MIN_OVERRUN_PCT)}, with {MIN_SAMPLE_BREAKS}+ measured breaks (critical from "
            f"{_p(CRITICAL_OVERRUN_PCT)}). The whole selection is flagged from {_p(OVERALL_WARN_PCT)}. A move of "
            f"{TREND_FLAG_POINTS:g}+ points against the previous period is a trend ({TREND_CRITICAL_POINTS:g}+ is "
            f"critical). Repeat overrunners have {REPEAT_MIN_OVERRUNS}+ overruns. Coverage is flagged below "
            f"{_p(LOW_PARTICIPATION_PCT)} of active employees scanning, or when {_p(UNMEASURED_WARN_PCT)} of records "
            "cannot be measured."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe()],
        caveats=["These are rules of thumb: no tea-break target is configured in the system."],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[thresholds])


# ─── the page's summary, in plain English ───────────────────────────────────────────────────────────────────────


def _story_line(id_: str, text: str, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "tone": tone}


def _taken(n: int) -> str:
    return f"{_num(n)} tea {'break was' if n == 1 else 'breaks were'} taken"


def _moved(change_: dict | None, unit: str, before: str, places: int = 0) -> str:
    """ ", up 8.3 points on the previous 14 days" (empty when nothing moved or there is nothing to compare)."""
    if not change_ or not change_["abs"]:
        return ""
    return f", {'up' if change_['abs'] > 0 else 'down'} {_num(abs(change_['abs']), places)} {unit} on {before}"


def attention_line(items: list[dict], subject: str, momentum: dict | None = None) -> dict:
    """The last sentence of a page's summary: what most needs attention among its findings (most severe first), else the
    good news, else (when given) how the trend is going, else what is merely worth knowing, else that nothing does."""
    urgent = [i for i in items if i["severity"] in ("critical", "warning")]
    if urgent:
        others = len(urgent) - 1
        text = f"The most important item: {urgent[0]['title']}."
        if others:
            text += f" {others} other {_plural(others, 'item')} also {'needs' if others == 1 else 'need'} a look."
        return _story_line("attention", text, "watch")
    good = [i for i in items if i["severity"] == "good"]
    if good:
        return _story_line("attention", f"Nothing urgent, and some good news: {good[0]['title']}.", "good")
    if momentum and momentum["verdict"] != "unclear":
        return _story_line(
            "attention", momentum["text"], {"better": "good", "worse": "watch"}.get(momentum["verdict"], "neutral")
        )
    if items:
        return _story_line("attention", f"Nothing urgent. For your information: {items[0]['title']}.")
    return _story_line("attention", f"Nothing about {subject} needs your attention in this period.", "good")


@cached()
def tea_story(scope: Scope, period: Period) -> dict:
    """The Insights tab's summary: three or four plain sentences written by fixed rules (no AI, no model call on page
    load) from the very figures the cards show: breaks and overruns, the time lost, where it is lost, and the one thing
    that most needs attention. A sentence whose figure does not exist for this selection is left out, never invented."""
    summary = tea_summary(scope, period)
    allowed = summary["allowedMinutes"]
    m = summary["metrics"]
    cov = summary["coverage"]
    breaks = m["breaks"]["value"]
    measured = m["measured"]["value"] or 0
    overruns = m["overruns"]["value"] or 0
    rate = m["overrunPct"]["value"]
    lost = m["minutesLost"]["value"]
    before = _previous_phrase(period)
    lines: list[dict] = []

    if not breaks:
        lines.append(_story_line("volume", f"{period.label}: no tea-break scans were recorded for this selection."))
    elif not measured:
        lines.append(
            _story_line(
                "volume",
                f"{period.label}: {_taken(breaks)}, but none could be measured (no return scan, or longer than "
                f"{SUSPECT_MINUTES} minutes), so there is no overrun figure.",
                "watch",
            )
        )
    else:
        delta = m["overrunPct"]["change"]
        text = (
            f"{period.label}: {_taken(breaks)}; {_num(overruns)} of the {_num(measured)} that could be measured ran "
            f"past the {allowed}-minute allowance ({_p(rate, 1)}{_moved(delta, 'points', before, 1)})."
        )
        if cov["unmeasured"]:
            text += f" {_num(cov['unmeasured'])} more could not be measured and are left out."
        tone = "watch" if rate is not None and rate >= OVERALL_WARN_PCT else "neutral"
        if delta and delta["abs"] <= -TREND_FLAG_POINTS:
            tone = "good"
        lines.append(_story_line("volume", text, tone))

    if measured and lost is not None:
        change_ = m["minutesLost"]["change"]
        if not overruns:
            lines.append(_story_line("lost", "Nobody ran over, so no time was lost beyond the allowance.", "good"))
        else:
            text = (
                f"That cost {_num(lost)} minutes ({_num(summary['hoursLost'], 1)} hours) beyond the allowance"
                f"{_moved(change_, 'minutes', before)}."
            )
            tone = "neutral" if not change_ or not change_["abs"] else ("watch" if change_["abs"] > 0 else "good")
            lines.append(_story_line("lost", text, tone))

    if measured >= MIN_SAMPLE_BREAKS:
        rows = tea_departments(scope, period, by="department", limit=LIST_MAX)["rows"]
        compared = [r for r in rows if r["measured"]]
        top = next((r for r in compared if not r["lowSample"] and r["key"] != NONE_KEY and r["minutesLost"]), None)
        if top and len(compared) >= 2:
            lines.append(
                _story_line(
                    "where",
                    f"{top['label']} loses the most time: {_num(top['minutesLost'])} minutes "
                    f"({_p(top['shareOfLostPct'])} of the total), with {_p(top['overrunPct'], 1)} of its breaks running "
                    "over.",
                )
            )

    if breaks:
        items = _exceptions(scope, period, limit=6)
        urgent = any(i["severity"] in ("critical", "warning") for i in items)
        momentum = None if urgent else tea_trend(scope, period)["momentum"]
        lines.append(attention_line(items, "tea breaks", momentum))

    who = "" if scope.is_everyone() else f", {scope.describe()}"
    entry = prov(
        "tea-story",
        "The plain-English summary",
        dataset="Gate tea-break scans, tea-break rule, shift assignments, employee list",
        definition=(
            "A few sentences written by fixed rules from the figures on this page (no AI): every number in them is the "
            "same figure the cards below show, for the same period and selection."
        ),
        formula=None,
        filters=[period.label, scope.describe()],
        caveats=[
            "It is not written by the AI. 'Explain with AI' asks the assistant, which looks the figures up itself and "
            "shows how it got its answer."
        ],
    )
    return envelope(
        {
            "sentences": lines,
            "text": " ".join(line["text"] for line in lines),
            "ask": f"Explain tea-break discipline ({period.label}{who}): what changed against {before}, why, and what "
            "should I look at first?",
        },
        period=period,
        scope=scope,
        provenance=[entry, *_pick({e["id"]: e for e in summary["provenance"]}, "tea-overrun", "tea-minutes-lost")],
        notes=summary["notes"],
    )


def _recent_windows(today: date | None) -> tuple[Period, Period]:
    """The last 7 COMPLETE days (to yesterday, so a half-finished day cannot flatter or hurt the figures) and the 7
    before them."""
    today = today or ist_today()
    end = today - timedelta(days=1)
    current = Period(end - timedelta(days=6), end, None, "Last 7 days")
    return current, current.previous()


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3)."""
    current, _ = _recent_windows(today)
    return _exceptions(Scope(), current, limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's tea-break cards: overrun rate and minutes lost over the last 7 complete days, each against the
    7 days before, with a 14-day sparkline. "Down" is good news for both."""
    current, previous = _recent_windows(today)
    allowed, _, now = _context()
    scope = Scope()
    per_day = _daily(scope, previous.start, current.end, allowed, now)
    cur = _figures(_sum_days(per_day, current.start, current.end), allowed)
    prev = _figures(_sum_days(per_day, previous.start, previous.end), allowed)
    days = [previous.start + timedelta(days=n) for n in range(14)]
    daily = [_figures(per_day.get(d) or _zero(), allowed) for d in days]
    rate_delta = change(cur["overrunPct"], prev["overrunPct"])
    lost_delta = change(cur["minutesLost"], prev["minutesLost"])
    sub_window = f"{current.start:%d %b} to {current.end:%d %b}"
    if cur["measured"]:
        rate_sub = f"{_num(cur['overruns'])} of {_num(cur['measured'])} breaks ran over {allowed} min · {sub_window}"
        lost_sub = f"{_num(cur['overruns'])} overruns · {sub_window}"
    else:
        rate_sub = lost_sub = f"No tea-break scans in the last 7 days · {sub_window}"
    kpis = [
        {
            "id": "tea-break.overrun-pct",
            "label": "Break overruns",
            "value": cur["overrunPct"],
            "format": "pct",
            "sub": rate_sub,
            "delta": {**rate_delta, "good": "down"} if rate_delta else None,
            "spark": [f["overrunPct"] for f in daily],
            "page": PAGE,
        },
        {
            "id": "tea-break.minutes-lost",
            "label": "Minutes lost to overruns",
            "value": cur["minutesLost"],
            "format": "minutes",
            "sub": lost_sub,
            "delta": {**lost_delta, "good": "down"} if lost_delta else None,
            "spark": [f["minutesLost"] for f in daily],
            "page": PAGE,
        },
    ]
    entries = _provenance(
        allowed,
        scope,
        current,
        rows={"measured": cur["measured"], "overruns": cur["overruns"], "breaks": cur["breaks"]},
    )
    return {"kpis": kpis, "provenance": _pick(entries, "tea-overrun", "tea-minutes-lost", "tea-previous")}


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────


def _breakdown_tool(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    if by == "shift":
        return tea_shifts(scope, period, limit=limit)
    return tea_departments(scope, period, by=by, limit=limit)


_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)

TOOLS = [
    tool(
        "tea_break_summary",
        "Tea-break discipline for a period: breaks taken, employees who took one, average break length, the allowed "
        "minutes, how many breaks overran the allowance (count and %), minutes and hours lost to overruns and the % of "
        "breaks within the allowance, each with the previous period for comparison, plus scan coverage (how many "
        "employees scan and how many breaks could not be measured). Use for 'how is tea-break discipline', 'are people "
        "overrunning breaks' and 'how much time do we lose to tea breaks'. Overruns exclude breaks over 60 minutes and "
        "breaks with no return scan because those usually mean a missed scan. Percentages are 0-100, times are minutes.",
        tea_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "tea_break_breakdown",
        "Where tea-break overruns are, ranked by minutes lost: by department, by unit, by staff-vs-production type, or "
        "by shift. Each row has breaks, average minutes, overrun %, minutes lost, its share of all minutes lost, the "
        "scan participation (not for shifts) and the change against the previous period; rows with a small sample are "
        "flagged. Use for 'which department has the worst tea-break overruns', 'which shift', 'which unit'.",
        _breakdown_tool,
        page=PAGE,
        period="last_30_days",
        extra={
            "by": string_param("What to group by", enum=list(BY_CHOICES)),
            "limit": _LIMIT,
        },
        defaults={"by": "department", "limit": LIST_DEFAULT},
    ),
    tool(
        "tea_break_offenders",
        f"Repeat tea-break overrunners: employees who overran at least N times (default {REPEAT_MIN_OVERRUNS}) in the "
        "period, with how many times, the minutes lost, their overrun rate and their worst case (longest break and "
        "date), plus how much of the total lost time they account for. Use for 'who keeps overrunning their tea break'.",
        tea_offenders,
        page=PAGE,
        period="last_30_days",
        extra={
            "limit": _LIMIT,
            "min_overruns": integer_param("Minimum overruns to count as a repeat overrunner", minimum=1, maximum=100),
        },
        defaults={"limit": LIST_DEFAULT, "min_overruns": REPEAT_MIN_OVERRUNS},
    ),
    tool(
        "tea_break_trend",
        "Tea-break overrun % and minutes lost day by day (week by week for periods over 62 days) with a 7-day moving "
        "average, the worst day, and a verdict on whether the last 7 days are better or worse than the 7 before. Use "
        "for 'is break discipline getting better or worse' and 'what happened last week'.",
        tea_trend,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "tea_break_peak_times",
        "When tea breaks happen: the busiest half-hour slots, the weekday and time slots with the highest overrun "
        "rate, and totals per weekday (Indian time, by the half hour a break started in). Use for 'when do people take "
        "tea', 'when do overruns happen'.",
        tea_peak_times,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "tea_break_rule",
        "What counts as a tea-break overrun, in plain words: the allowed minutes HR has set, that there is no grace "
        "period or fixed break time, how breaks are measured, and which breaks are left out as probable missed scans. "
        "Use for 'what is the tea-break limit' and 'what counts as an overrun'.",
        tea_rule,
        page=PAGE,
        period=None,
        scope=False,
    ),
]
