"""MD portal, Leave & Holiday: how much leave is taken, who is out, what waits for a decision, and what looks unusual.

The page behind this module is HR's Leave & Holiday page (leave requests, half-day leave, permissions, holidays); the MD's
copy of it has an Insights tab built on these functions. They answer: how much leave was taken by type, department and
unit and how that compares with the previous period; who is out today and this week; how leave bunches around holidays;
which balances are running out or going unused; which requests wait too long or are rejected; and which patterns look
unusual (repeat Monday/Friday leave, long leave taken without notice, leave just before a resignation).

Source data and how a figure is made
------------------------------------
* Leave taken comes from ``LeaveRequest`` (approved) and ``CasualLeaveRequest`` (approved) and is counted by
  ``analytics/leave_data.py`` with the SAME rules as the attendance analytics (Sundays skipped, a half day is 0.5,
  overlapping requests count once, production staff left out, requests clipped to the period): the module docstring
  there lists them, and ``tests_md_leave`` pins that the two modules give the same total.
* Balances come from ``LeaveBalance`` (the yearly allocation HR sets) but the days *used* are recomputed from the approved
  requests, because the ledger is bumped on approval only and can drift; the drift is reported.
* Holidays come from ``Holiday``. The attendance engine applies every holiday row to every employee (the branch and
  department written on a row are not used), so holidays are not narrowed to the selected unit or department.

Nothing here writes. Reading goes through the data layer; no ``get()`` that creates a row is used.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import date, timedelta

from ...models import Holiday, ResignationRequest
from ...reporting.definitions.requests_leave_common import ist_bounds, ist_date
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, add_months, cached, change, envelope, parse_day, pct, prov
from . import leave_data as D
from .leave_data import NONE_KEY, WEEKDAYS, days_text, int_arg, num, pct_text, plural, short_date, weekday_date

PAGE = "leave"

# ─── named thresholds (shown in provenance; the tests pin them) ─────────────────────────────────────────────────

LIST_MAX = 25
LIST_DEFAULT = 10
#: A period of at most this many days is drawn day by day, up to WEEKLY_UNTIL_DAYS by week, beyond by month.
DAILY_UNTIL_DAYS = 31
WEEKLY_UNTIL_DAYS = 190
#: The calendar heat map shows at most this many days (the most recent ones of the period).
CALENDAR_MAX_DAYS = 186
#: The trend names this many leave types; the rest are added up as "Other types".
TREND_TOP_TYPES = 4
MOMENTUM_DAYS = 7
#: A move of the last 7 days against the 7 before is "rising" / "falling" from this share and this many days.
MOMENTUM_FLAG_PCT = 15.0
MOMENTUM_MIN_DAYS = 3.0
#: A department or unit with fewer employees than this is marked "small group" and never called out.
MIN_GROUP_HEADS = 5
#: A department is flagged when its leave per employee is this multiple of the company's, with at least this many days.
GROUP_FLAG_RATIO = 1.5
GROUP_FLAG_MIN_DAYS = 8.0
#: Leave days moving by this share (and this many days) against a previous period with at least SPIKE_MIN_BASE days.
SPIKE_PCT = 25.0
SPIKE_CRITICAL_PCT = 50.0
SPIKE_MIN_DAYS = 5.0
SPIKE_MIN_BASE = 10.0
#: Requests waiting this many days are "waiting too long" (critical from the second figure).
PENDING_WARN_DAYS = 3
PENDING_CRITICAL_DAYS = 7
#: Rejection rate is called out from this share of the requests decided, once this many were decided.
REJECTION_WARN_PCT = 25.0
REJECTION_CRITICAL_PCT = 40.0
REJECTION_MIN_DECIDED = 10
#: People out today, as a share of staff (and at least this many people).
OUT_TODAY_WARN_PCT = 10.0
OUT_TODAY_CRITICAL_PCT = 20.0
OUT_TODAY_MIN_PEOPLE = 5
SOON_DAYS = 7
#: Monday and Friday: the days that join the weekend (0 = Monday).
EDGE_WEEKDAYS = (0, 4)
REPEAT_EDGE_MIN_DAYS = 3.0
REPEAT_EDGE_MIN_SHARE_PCT = 60.0
#: A leave of at least this many days applied for on or after its first day is "long and unplanned".
LONG_LEAVE_DAYS = 3.0
UNPLANNED_NOTICE_DAYS = 0
RESIGNATION_LOOKBACK_DAYS = 30
RESIGNATION_MIN_LEAVE_DAYS = 3.0
FREQUENT_MIN_REQUESTS = 4
UPCOMING_DAYS = 90
UPCOMING_DEFAULT = 6
UPCOMING_MAX = 12
#: A holiday this close, with this many people already on leave around it, is worth the MD's notice.
HOLIDAY_ALERT_DAYS = 14
HOLIDAY_ALERT_MIN_PEOPLE = 5
#: A balance this close to nothing is "running low".
LOW_BALANCE_DAYS = 2.0
LEDGER_MISMATCH_DAYS = 0.05
LEDGER_WARN_ROWS = 5
OVERDRAWN_WARN_PEOPLE = 5
GROUP_BY = ("type", "department", "unit")

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────


def _iso(day: date | None) -> str | None:
    return day.isoformat() if day else None


def _metric(current, previous) -> dict:
    return {"value": current, "previous": previous, "change": change(current, previous)}


def _filters(scope: Scope, period: Period) -> list[str]:
    return [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()]


def _pick(entries: dict[str, dict], *ids: str) -> list[dict]:
    return [entries[i] for i in ids if i in entries]


def _tally(facts: D.Facts, lo: date, hi: date, key) -> dict:
    """{group: {"days", "people", "requests"}} for the leave days in [lo, hi]; ``key(employee id, type key)`` names the group."""
    out: dict = {}
    for eid, _day, weight, type_key, rid in facts.between(lo, hi):
        slot = out.setdefault(key(eid, type_key), {"days": 0.0, "people": set(), "requests": set()})
        slot["days"] += weight
        slot["people"].add(eid)
        slot["requests"].add(rid)
    return out


def _window(facts: D.Facts, heads: D.Heads, lo: date, hi: date, holidays: set[date]) -> dict:
    """The headline numbers of one stretch of days."""
    days, people = 0.0, set()
    for eid, _day, weight, _type, _rid in facts.between(lo, hi):
        days += weight
        people.add(eid)
    capacity = D.working_days(lo, hi, holidays)
    return {
        "days": round(days, 1),
        "people": len(people),
        "capacity": capacity,
        "perEmployee": round(days / heads.total, 2) if heads.total else None,
        "ratePct": pct(days, heads.total * capacity),
    }


def _app_stats(apps: list[D.Application]) -> dict:
    """What happened to the requests applied for in a period (every status)."""
    counts = Counter(a.status for a in apps)
    approved, rejected, pending = counts["approved"], counts["rejected"], counts["pending"]
    decided = approved + rejected
    noticed = [a for a in apps if a.notice is not None]
    short = sum(1 for a in noticed if a.notice <= UNPLANNED_NOTICE_DAYS)
    hours = [
        (a.decided_at - a.applied_at).total_seconds() / 3600
        for a in apps
        if a.decided_at is not None and a.applied_at is not None and a.decided_at >= a.applied_at
    ]
    return {
        "applied": len(apps),
        "approved": approved,
        "rejected": rejected,
        "pending": pending,
        "decided": decided,
        "rejectionPct": pct(rejected, decided),
        "shortNotice": short,
        "noticeKnown": len(noticed),
        "shortNoticePct": pct(short, len(noticed)),
        "decisionHours": hours,
    }


def _pending_stats(apps: list[D.Application], today: date) -> dict:
    """The requests waiting for a decision right now and how long they have waited (calendar days, factory time)."""
    waits = [max(0, (today - a.applied).days) for a in apps if a.applied is not None]
    return {
        "count": len(apps),
        "oldestDays": max(waits) if waits else None,
        "averageDays": round(sum(waits) / len(waits), 1) if waits else None,
        "waitingTooLong": sum(1 for w in waits if w >= PENDING_WARN_DAYS),
        "pastStart": sum(1 for a in apps if a.start is not None and a.start < today),
        "buckets": [
            {"label": "Under 2 days", "count": sum(1 for w in waits if w < 2)},
            {"label": "2 to 6 days", "count": sum(1 for w in waits if 2 <= w < PENDING_CRITICAL_DAYS)},
            {"label": f"{PENDING_CRITICAL_DAYS} days or more", "count": sum(1 for w in waits if w >= PENDING_CRITICAL_DAYS)},
        ],
    }


def _scope_notes(scope: Scope, facts: D.Facts, heads: D.Heads) -> list[str]:
    notes: list[str] = []
    if scope.employment_type == "production":
        notes.append(
            "Leave is not applied to production employees (the attendance engine ignores it for them), so there are "
            "no leave figures for a production-only selection."
        )
    elif facts.production_requests:
        notes.append(
            f"{num(facts.production_requests)} approved leave {plural(facts.production_requests, 'request')} by "
            "production employees are not counted: attendance does not use leave for them."
        )
    if facts.unreadable:
        notes.append(
            f"{num(facts.unreadable)} approved leave {plural(facts.unreadable, 'request')} with unreadable dates "
            f"{plural(facts.unreadable, 'is', 'are')} not counted."
        )
    if not heads.total and scope.employment_type != "production":
        notes.append("There are no active staff in this selection, so leave rates cannot be worked out.")
    return notes


def _future_note(period: Period, today: date) -> list[str]:
    if period.end > today:
        return ["This period runs past today, so it includes leave that is approved but not yet taken."]
    return []


# ─── provenance (what the card's "How is this calculated?" says, and what the assistant quotes) ─────────────────

_COMMON_CAVEATS = [
    "Same rule as the Attendance page: only approved leave, Sundays skipped, a half day is 0.5, requests that overlap "
    "count once, production employees left out, casual leave added as a paid day.",
]


def _provenance(scope: Scope, period: Period, rows: dict[str, int | None]) -> dict[str, dict]:
    f = _filters(scope, period)
    heads_caveat = (
        "Headcount is today's active staff (there is no headcount history); leave taken by people who have since left "
        "is included in the days."
    )
    return {
        "leave-days": prov(
            "leave-days",
            "Leave days taken",
            dataset="Leave requests (approved), casual leave requests",
            definition=(
                "Days of approved leave that fall inside the period, whatever month the request was made in. A leave "
                "that starts before or ends after the period counts only its days inside it."
            ),
            formula="sum of each approved request's Monday-to-Saturday days in the period (half day = 0.5), plus casual leave days",
            rows=rows.get("requests"),
            filters=f,
            caveats=[*_COMMON_CAVEATS, "Holidays inside a leave are not subtracted: the leave was still taken."],
        ),
        "leave-people": prov(
            "leave-people",
            "Employees who took leave",
            dataset="Leave requests (approved), casual leave requests",
            definition="Employees with at least one day of approved leave in the period.",
            formula="distinct employees with a leave day in the period",
            rows=rows.get("people"),
            filters=f,
        ),
        "leave-rate": prov(
            "leave-rate",
            "Leave rate",
            dataset="Leave requests, casual leave requests, employee list, holidays",
            definition="The share of the working days of the period that staff spent on approved leave.",
            formula="leave days ÷ (active staff × working days) × 100; working days = Monday to Saturday dates that are not a holiday",
            rows=rows.get("heads"),
            filters=f,
            caveats=[
                heads_caveat,
                "Production employees are not in the headcount because leave does not apply to them.",
                "Saturdays are counted as working days; a staff member with Saturday off is still counted.",
            ],
        ),
        "leave-per-employee": prov(
            "leave-per-employee",
            "Leave days per employee",
            dataset="Leave requests, casual leave requests, employee list",
            definition="Average days of leave per active staff member in the period.",
            formula="leave days ÷ active staff",
            rows=rows.get("heads"),
            filters=f,
            caveats=[heads_caveat],
        ),
        "leave-applications": prov(
            "leave-applications",
            "Leave requests applied for",
            dataset="Leave requests",
            definition=(
                "Requests created in the period, every status and every kind of employee (it measures the approval "
                "process, so production employees' requests are included here)."
            ),
            formula="number of leave requests whose application date falls in the period",
            rows=rows.get("applied"),
            filters=f,
            caveats=["A request counts in the period it was applied for, not the period its leave falls in."],
        ),
        "leave-rejection": prov(
            "leave-rejection",
            "Rejection rate",
            dataset="Leave requests",
            definition="The share of the requests applied for in the period that have been decided and were rejected.",
            formula="rejected ÷ (approved + rejected) × 100; requests still waiting are not in either side",
            rows=rows.get("decided"),
            filters=f,
            caveats=[
                f"Called out only from {REJECTION_MIN_DECIDED}+ decided requests: a rate of a handful of requests says little."
            ],
        ),
        "leave-notice": prov(
            "leave-notice",
            "Short-notice requests",
            dataset="Leave requests",
            definition=(
                "Requests applied for on the first day of the leave or after it had started. HR can enter leave after "
                "the fact on an employee's behalf, and the data cannot tell who entered it."
            ),
            formula="requests with (first leave day − application date) ≤ 0 ÷ requests with a readable date × 100",
            rows=rows.get("noticeKnown"),
            filters=f,
        ),
        "leave-previous": prov(
            "leave-previous",
            "Comparison with the previous period",
            dataset="Leave requests, casual leave requests",
            definition=(
                "Every change is against the period of the same length that ends the day before this one starts, "
                "worked out the same way."
            ),
            formula="change = this period − previous period (percentage figures change in points)",
            filters=[f"{period.previous().start.isoformat()} to {period.previous().end.isoformat()}"],
        ),
    }


def _pending_provenance(scope: Scope, rows: int | None) -> dict:
    return prov(
        "leave-pending",
        "Leave requests waiting",
        dataset="Leave requests",
        definition=(
            "Requests still waiting for a decision right now, whatever date the leave is for, and how many calendar "
            "days each has waited since it was applied for (factory time). The same count the Attendance page shows."
        ),
        formula="count and age of leave requests with status pending",
        rows=rows,
        filters=["Right now", scope.describe()],
        caveats=[
            "How long a request has waited is counted from when it was applied for; leave requests do not record when "
            "a decision was made for older requests.",
            "A request that is waiting for a second approver (for example HR after the department head) is still waiting.",
        ],
    )


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def leave_summary(scope: Scope, period: Period, today: date | None = None) -> dict:
    """Leave days, people, rate and per-employee average, the requests applied for and their rejection and short-notice
    rates (each against the previous period), and the requests waiting right now. The one call the KPI strip, the
    Dashboard and the assistant all rest on."""
    now = today or D.today()
    previous = period.previous()
    facts = D.load_facts(scope, previous.start, period.end)
    heads = D.load_heads(scope)
    holidays = D.holiday_dates(previous.start, period.end)
    cur = _window(facts, heads, period.start, period.end, holidays)
    old = _window(facts, heads, previous.start, previous.end, holidays)
    apps_cur = _app_stats(D.applications_made(scope, period.start, period.end))
    apps_old = _app_stats(D.applications_made(scope, previous.start, previous.end))
    pending_apps = D.applications_pending(scope)
    pending = _pending_stats(pending_apps, now)

    in_period = [r for r in facts.reqs.values() if any(True for _ in _days_of(facts, r.id, period.start, period.end))]
    metrics = {
        "leaveDays": _metric(cur["days"], old["days"]),
        "employeesOnLeave": _metric(cur["people"], old["people"]),
        "daysPerEmployee": _metric(cur["perEmployee"], old["perEmployee"]),
        "leaveRatePct": _metric(cur["ratePct"], old["ratePct"]),
        "applied": _metric(apps_cur["applied"], apps_old["applied"]),
        "rejectionPct": _metric(apps_cur["rejectionPct"], apps_old["rejectionPct"]),
        "shortNoticePct": _metric(apps_cur["shortNoticePct"], apps_old["shortNoticePct"]),
    }
    notes = D_notes = _scope_notes(scope, facts, heads)
    del D_notes
    if cur["days"] == 0 and heads.total:
        notes.insert(0, f"No approved leave falls in {period.label} for this selection.")
    notes.extend(_future_note(period, now))
    entries = _provenance(
        scope,
        period,
        rows={
            "requests": len(in_period),
            "people": cur["people"],
            "heads": heads.total,
            "applied": apps_cur["applied"],
            "decided": apps_cur["decided"],
            "noticeKnown": apps_cur["noticeKnown"],
        },
    )
    return envelope(
        {
            "metrics": metrics,
            "eligibleHeadcount": heads.total,
            "workingDays": cur["capacity"],
            "previousPeriod": previous.to_json(),
            "requests": {k: apps_cur[k] for k in ("applied", "approved", "rejected", "pending", "decided")},
            "pending": pending,
        },
        period=period,
        scope=scope,
        provenance=[
            *_pick(
                entries,
                "leave-days",
                "leave-people",
                "leave-rate",
                "leave-per-employee",
                "leave-applications",
                "leave-rejection",
                "leave-notice",
            ),
            _pending_provenance(scope, pending["count"]),
            entries["leave-previous"],
        ],
        notes=notes,
    )


def _days_of(facts: D.Facts, request_id: int, lo: date, hi: date):
    for entry in facts.between(lo, hi):
        if entry[4] == request_id:
            yield entry


# ─── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _buckets(period: Period) -> tuple[str, list[tuple[date, date]]]:
    """The stretches the trend is drawn in: days, Monday-to-Sunday weeks, or calendar months, each clipped to the period."""
    if period.days <= DAILY_UNTIL_DAYS:
        return "day", [(d, d) for d in D.daterange(period.start, period.end)]
    out: list[tuple[date, date]] = []
    first = period.start
    weekly = period.days <= WEEKLY_UNTIL_DAYS
    while first <= period.end:
        if weekly:
            last = first - timedelta(days=first.weekday()) + timedelta(days=6)
        else:
            year, month = add_months(first.year, first.month, 1)
            last = date(year, month, 1) - timedelta(days=1)
        last = min(last, period.end)
        out.append((first, last))
        first = last + timedelta(days=1)
    return ("week" if weekly else "month"), out


def _momentum(per_day: dict[date, dict], end: date) -> dict:
    """Is leave rising or falling? The last 7 days of the period against the 7 before them."""
    cur_start = end - timedelta(days=MOMENTUM_DAYS - 1)
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=MOMENTUM_DAYS - 1)

    def total(lo: date, hi: date) -> float:
        return round(sum(per_day[d]["days"] for d in D.daterange(lo, hi) if d in per_day), 1)

    cur, prev = total(cur_start, end), total(prev_start, prev_end)
    delta = change(cur, prev)
    until = short_date(end)
    if delta is None or (cur == 0 and prev == 0):
        verdict, text = "unclear", f"There was no approved leave in the 7 days to {until} or the 7 days before."
    elif delta["pct"] is not None and delta["pct"] >= MOMENTUM_FLAG_PCT and delta["abs"] >= MOMENTUM_MIN_DAYS:
        verdict = "rising"
        text = f"Leave is rising: {days_text(cur)} in the 7 days to {until}, up {pct_text(delta['pct'], 0)} on the 7 days before ({days_text(prev)})."
    elif delta["pct"] is not None and delta["pct"] <= -MOMENTUM_FLAG_PCT and -delta["abs"] >= MOMENTUM_MIN_DAYS:
        verdict = "falling"
        text = f"Leave is falling: {days_text(cur)} in the 7 days to {until}, down {pct_text(abs(delta['pct']), 0)} on the 7 days before ({days_text(prev)})."
    elif prev == 0:
        verdict = "rising"
        text = f"Leave is rising: {days_text(cur)} in the 7 days to {until}, none in the 7 days before."
    else:
        verdict = "steady"
        text = f"Leave is steady: {days_text(cur)} in the 7 days to {until} ({days_text(prev)} in the 7 days before)."
    return {
        "windowDays": MOMENTUM_DAYS,
        "verdict": verdict,
        "text": text,
        "current": {"start": _iso(cur_start), "end": _iso(end), "leaveDays": cur},
        "previous": {"start": _iso(prev_start), "end": _iso(prev_end), "leaveDays": prev},
        "change": delta,
    }


@cached()
def leave_trend(scope: Scope, period: Period) -> dict:
    """Leave days by type over time (by day up to 31 days, by week up to about 6 months, then by month), the same for
    the previous period to lay beside it, the busiest day, and whether leave is rising or falling."""
    previous = period.previous()
    first = min(previous.start, period.end - timedelta(days=2 * MOMENTUM_DAYS - 1))
    facts = D.load_facts(scope, first, period.end)
    holidays = D.holiday_dates(period.start, period.end)

    per_day: dict[date, dict] = {}
    for eid, day, weight, type_key, _rid in facts.between(first, period.end):
        slot = per_day.setdefault(day, {"days": 0.0, "people": set(), "types": defaultdict(float)})
        slot["days"] += weight
        slot["people"].add(eid)
        slot["types"][type_key] += weight

    by_type = Counter()
    for day in D.daterange(period.start, period.end):
        for type_key, days in (per_day.get(day) or {"types": {}})["types"].items():
            by_type[type_key] += days
    top = [key for key, _ in sorted(by_type.items(), key=lambda kv: (-kv[1], facts.types[kv[0]].label))][
        :TREND_TOP_TYPES
    ]
    has_other = len(by_type) > len(top)
    types = [{"key": k, "label": facts.types[k].label, "days": round(by_type[k], 1)} for k in top]
    if has_other:
        types.append(
            {"key": "other", "label": "Other types", "days": round(sum(v for k, v in by_type.items() if k not in top), 1)}
        )

    granularity, spans = _buckets(period)

    def point(lo: date, hi: date) -> dict:
        people: set[int] = set()
        days = 0.0
        shares: dict[str, float] = defaultdict(float)
        for day in D.daterange(lo, hi):
            slot = per_day.get(day)
            if not slot:
                continue
            days += slot["days"]
            people |= slot["people"]
            for type_key, amount in slot["types"].items():
                shares[type_key if type_key in top else "other"] += amount
        return {
            "date": _iso(lo),
            "days": (hi - lo).days + 1,
            "leaveDays": round(days, 1),
            "onLeave": len(people),
            "byType": {t["key"]: round(shares.get(t["key"], 0.0), 1) for t in types},
        }

    points = [point(lo, hi) for lo, hi in spans]
    _, previous_spans = _buckets(previous)
    previous_points = [{"date": _iso(lo), "leaveDays": point(lo, hi)["leaveDays"]} for lo, hi in previous_spans]

    busiest = None
    candidates = [
        (len(per_day[d]["people"]), per_day[d]["days"], d) for d in D.daterange(period.start, period.end) if d in per_day
    ]
    if candidates:
        top_day = max(candidates, key=lambda c: (c[0], c[1], -c[2].toordinal()))
        busiest = {"date": _iso(top_day[2]), "onLeave": top_day[0], "leaveDays": round(top_day[1], 1)}

    total = round(sum(p["leaveDays"] for p in points), 1)
    capacity = D.working_days(period.start, period.end, holidays)
    notes = _scope_notes(scope, facts, D.Heads())
    notes = [n for n in notes if "no active staff" not in n]
    if not total:
        notes.insert(0, f"No approved leave falls in {period.label} for this selection.")
    entries = _provenance(scope, period, rows={"requests": len(facts.reqs)})
    entries["leave-trend"] = prov(
        "leave-trend",
        "Leave over time",
        dataset="Leave requests (approved), casual leave requests",
        definition=(
            "Leave days in each day, week (Monday to Sunday) or month of the period, split by leave type. The four "
            "biggest types are named and the rest are added up as 'Other types'. The previous period is drawn the same "
            "way for comparison and lined up by position, not by date."
        ),
        formula="leave days per stretch = approved leave days on the dates in it",
        rows=len(facts.reqs),
        filters=_filters(scope, period),
        caveats=[
            *_COMMON_CAVEATS,
            f"'Rising' or 'falling' compares the last {MOMENTUM_DAYS} days with the {MOMENTUM_DAYS} before: a move of "
            f"{MOMENTUM_FLAG_PCT:g}% and {MOMENTUM_MIN_DAYS:g} days or more.",
        ],
    )
    return envelope(
        {
            "granularity": granularity,
            "points": points,
            "previousPoints": previous_points,
            "types": types,
            "totalDays": total,
            "averagePerWorkingDay": round(total / capacity, 1) if capacity else None,
            "busiestDay": busiest,
            "momentum": _momentum(per_day, period.end),
        },
        period=period,
        scope=scope,
        provenance=[entries["leave-trend"], *_pick(entries, "leave-days", "leave-previous")],
        notes=notes,
    )


# ─── comparison: by type, department, unit ──────────────────────────────────────────────────────────────────────


@cached()
def leave_groups(scope: Scope, period: Period, by: str = "type", limit: int = LIST_DEFAULT) -> dict:
    """Leave days ranked by leave type, department (the same name in several units is one department) or unit, with the
    previous period, each group's share, and for departments and units the days per employee against the company's."""
    if by not in GROUP_BY:
        raise MdParamError(f"'by' must be one of: {', '.join(GROUP_BY)}.")
    limit = int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    previous = period.previous()
    facts = D.load_facts(scope, previous.start, period.end)
    heads = D.load_heads(scope)
    holidays = D.holiday_dates(previous.start, period.end)
    capacity = D.working_days(period.start, period.end, holidays)

    def key(eid: int, type_key: str) -> str:
        if by == "type":
            return type_key
        who = facts.who[eid]
        return who.dept if by == "department" else who.unit

    cur = _tally(facts, period.start, period.end, key)
    old = _tally(facts, previous.start, previous.end, key)
    head_counts = {"type": None, "department": heads.by_dept, "unit": heads.by_unit}[by]
    total_days = sum(v["days"] for v in cur.values())
    company_per_head = total_days / heads.total if heads.total else None

    labels = set(cur) | set(old) | set(head_counts or {})
    rows = []
    for name in labels:
        now_, before = cur.get(name), old.get(name)
        days = round(now_["days"], 1) if now_ else 0.0
        prior = round(before["days"], 1) if before else 0.0
        meta = facts.types.get(name) if by == "type" else None
        headcount = head_counts.get(name, 0) if head_counts is not None else None
        per_head = round(days / headcount, 2) if headcount else None
        label = meta.label if meta else name
        none_label = D.NO_DEPARTMENT if by == "department" else D.NO_UNIT
        rows.append(
            {
                "key": NONE_KEY if label == none_label and by != "type" else (name if by == "type" else label),
                "label": label,
                "sub": ("Paid" if meta.paid else "Unpaid" if meta.paid is False else None) if meta else None,
                "leaveDays": days,
                "previousDays": prior,
                "change": change(days, prior),
                "sharePct": pct(days, total_days),
                "employeesOnLeave": len(now_["people"]) if now_ else 0,
                "requests": len(now_["requests"]) if now_ else 0,
                "headcount": headcount,
                "daysPerEmployee": per_head,
                "leaveRatePct": pct(days, headcount * capacity) if headcount else None,
                "vsCompany": round(per_head / company_per_head, 2) if per_head is not None and company_per_head else None,
                "lowSample": headcount is not None and headcount < MIN_GROUP_HEADS,
            }
        )
    if by == "type":
        rows = [r for r in rows if r["leaveDays"] or r["previousDays"]]
        rows.sort(key=lambda r: (-r["leaveDays"], -r["previousDays"], r["label"].lower()))
    else:
        rows.sort(
            key=lambda r: (
                r["daysPerEmployee"] is None,
                -(r["daysPerEmployee"] or 0),
                -r["leaveDays"],
                r["label"].lower(),
            )
        )
    notes = _scope_notes(scope, facts, heads)
    if not total_days and heads.total:
        notes.insert(0, f"No approved leave falls in {period.label} for this selection.")
    entries = _provenance(scope, period, rows={"requests": len(facts.reqs), "heads": heads.total})
    entries["leave-grouping"] = prov(
        "leave-grouping",
        "Ranking",
        dataset="Leave requests (approved), casual leave requests, employee list",
        definition=(
            "Leave days grouped by leave type, or by the department or unit each employee belongs to today (there is no "
            "history of transfers). A department with the same name in several units is one department. Leave types "
            "are ranked by days; departments and units by days per employee, so a big department does not win by size."
        ),
        formula="days per employee = group leave days ÷ group active staff; share = group days ÷ all leave days; vs company = days per employee ÷ the company's",
        rows=len(facts.reqs),
        filters=_filters(scope, period),
        caveats=[
            f"Groups with fewer than {MIN_GROUP_HEADS} staff are marked 'small group' and never called out.",
            "Leave requests saved without a leave type are grouped under their own '(untyped)' name.",
            *_COMMON_CAVEATS,
        ],
    )
    return envelope(
        {
            "by": by,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "average": {
                "leaveDays": round(total_days, 1),
                "daysPerEmployee": round(company_per_head, 2) if company_per_head is not None else None,
                "headcount": heads.total,
            },
            "minGroupHeads": MIN_GROUP_HEADS,
        },
        period=period,
        scope=scope,
        provenance=[entries["leave-grouping"], *_pick(entries, "leave-days", "leave-per-employee", "leave-previous")],
        notes=notes,
    )


# ─── who is out ─────────────────────────────────────────────────────────────────────────────────────────────────


def _target_day(value, today: date) -> date:
    text = str(value or "today").strip().lower()
    if text == "today":
        return today
    if text == "tomorrow":
        return today + timedelta(days=1)
    if text == "yesterday":
        return today - timedelta(days=1)
    return parse_day(text, "day")


@cached()
def leave_today(scope: Scope, day: str = "today", limit: int = LIST_DEFAULT, today: date | None = None) -> dict:
    """Who is on approved leave on one day (today unless asked), by department, who is out on each day of that week, and
    how many people start leave in the next 7 days. Active staff only. Names are in ``employeeName`` fields."""
    limit = int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    now = today or D.today()
    target = _target_day(day, now)
    week_start = target - timedelta(days=target.weekday())
    week_end = week_start + timedelta(days=6)
    soon_end = target + timedelta(days=SOON_DAYS)
    facts = D.load_facts(scope, week_start, max(week_end, soon_end))
    heads = D.load_heads(scope)
    holiday_names = D.holiday_names(week_start, week_end)

    per_day: dict[date, dict[int, float]] = defaultdict(dict)
    entries_today: dict[int, tuple[str, int]] = {}
    for eid, d, weight, type_key, rid in facts.between(week_start, week_end):
        if facts.who[eid].status != "active":
            continue
        per_day[d][eid] = per_day[d].get(eid, 0.0) + weight
        if d == target:
            entries_today[eid] = (type_key, rid)

    out = per_day.get(target, {})
    full = sum(1 for w in out.values() if w >= 1)
    half = len(out) - full
    week = []
    for d in D.daterange(week_start, week_end):
        people = per_day.get(d, {})
        week.append(
            {
                "date": _iso(d),
                "weekday": WEEKDAYS[d.weekday()],
                "out": len(people),
                "halfDay": sum(1 for w in people.values() if w < 1),
                "holiday": holiday_names.get(d),
                "isSunday": d.weekday() == D.SUNDAY,
                "isTarget": d == target,
            }
        )
    week_people = {eid for people in per_day.values() for eid in people}

    by_dept: dict[str, int] = defaultdict(int)
    rows = []
    for eid, (type_key, rid) in entries_today.items():
        who = facts.who[eid]
        by_dept[who.dept] += 1
        req = facts.reqs[rid]
        rows.append(
            {
                **D.person_row(who),
                "type": facts.types[type_key].label,
                "from": _iso(req.start),
                "to": _iso(req.end),
                "halfDay": req.slot if req.half else None,
                "days": req.total,
            }
        )
    rows.sort(key=lambda r: (r["department"].lower(), r["employeeName"].lower(), r["employeeCode"]))
    departments = sorted(
        (
            {
                "label": name,
                "out": n,
                "headcount": heads.by_dept.get(name),
                "outPct": pct(n, heads.by_dept.get(name)),
            }
            for name, n in by_dept.items()
        ),
        key=lambda r: (-r["out"], r["label"].lower()),
    )[:8]

    soon = {
        r.employee_id
        for r in facts.reqs.values()
        if target < r.start <= soon_end and facts.who[r.employee_id].status == "active"
    }
    notes = _scope_notes(scope, facts, heads)
    if not out and heads.total:
        notes.insert(0, f"Nobody in this selection is on approved leave on {weekday_date(target)}.")
    if holiday_names.get(target):
        notes.append(f"{weekday_date(target)} is a holiday ({holiday_names[target]}).")
    elif target.weekday() == D.SUNDAY:
        notes.append(f"{weekday_date(target)} is a Sunday, the weekly off.")
    filters = [weekday_date(target), scope.describe()]
    entry = prov(
        "leave-today",
        "Who is on leave",
        dataset="Leave requests (approved), casual leave requests, employee list, holidays",
        definition=(
            "Active staff with approved leave on the day (a half-day leave counts as a person on a half day). 'This week' "
            "is Monday to Sunday of that day; 'starting soon' counts people whose leave begins in the next 7 days."
        ),
        formula="distinct active staff with a leave day on the date; % of staff = those ÷ active staff in the selection × 100",
        rows=len(out),
        filters=filters,
        caveats=[
            *_COMMON_CAVEATS,
            "People who have left are not listed. Reasons for leave are never shown here.",
        ],
    )
    return envelope(
        {
            "date": _iso(target),
            "weekday": WEEKDAYS[target.weekday()],
            "isToday": target == now,
            "holiday": holiday_names.get(target),
            "outToday": {
                "people": len(out),
                "fullDay": full,
                "halfDay": half,
                "pct": pct(len(out), heads.total),
                "headcount": heads.total,
            },
            "week": week,
            "weekPeople": len(week_people),
            "startingSoon": len(soon),
            "byDepartment": departments,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
        },
        scope=scope,
        provenance=[entry],
        notes=notes,
    )


# ─── balances: the yearly allocation, taken and unused ──────────────────────────────────────────────────────────


def _year_progress(year: int, today: date) -> float:
    if year < today.year:
        return 100.0
    if year > today.year:
        return 0.0
    first = date(year, 1, 1)
    length = (date(year + 1, 1, 1) - first).days
    return round(100.0 * ((today - first).days + 1) / length, 1)


@cached()
def leave_balances(scope: Scope, year: int | None = None, limit: int = LIST_DEFAULT, today: date | None = None) -> dict:
    """The yearly leave allocation against the days actually taken, by leave type and by department: days unused (the
    'liability' that carries over or lapses), balances that are exhausted or running low, people who took more than they
    were allocated, and how far HR's ledger disagrees with the approved requests."""
    now = today or D.today()
    year = int_arg(year, "year", now.year, 2000, 2100)
    limit = int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    rows, without_allocation, unreadable = D.load_balances(scope, year)

    by_type: dict[str, dict] = {}
    by_dept: dict[str, dict] = {}
    overdrawn: list[dict] = []
    total = {"allocated": 0.0, "used": 0.0, "unused": 0.0, "overdrawn": 0.0, "mismatches": 0}
    people: set[int] = set()
    for r in rows:
        remaining = r.allocated - r.used
        unused = max(0.0, remaining)
        over = max(0.0, -remaining)
        mismatch = abs(r.ledger_used - r.used) >= LEDGER_MISMATCH_DAYS
        t = by_type.setdefault(
            r.type_key,
            {
                "key": r.type_key,
                "label": r.type_label,
                "code": r.code,
                "paid": r.paid,
                "carryForward": r.carry_forward,
                "employees": 0,
                "allocated": 0.0,
                "used": 0.0,
                "unused": 0.0,
                "overdrawnDays": 0.0,
                "overdrawnEmployees": 0,
                "exhausted": 0,
                "low": 0,
                "untouched": 0,
                "carryOverDays": 0.0,
                "ledgerMismatches": 0,
            },
        )
        d = by_dept.setdefault(
            r.who.dept,
            {"label": r.who.dept, "people": set(), "allocated": 0.0, "used": 0.0, "unused": 0.0, "overdrawnDays": 0.0},
        )
        t["employees"] += 1
        t["allocated"] += r.allocated
        t["used"] += r.used
        t["unused"] += unused
        t["overdrawnDays"] += over
        t["overdrawnEmployees"] += 1 if over > 0 else 0
        t["exhausted"] += 1 if r.allocated > 0 and remaining <= 0 else 0
        t["low"] += 1 if 0 < remaining <= LOW_BALANCE_DAYS else 0
        t["untouched"] += 1 if r.allocated > 0 and r.used == 0 else 0
        t["carryOverDays"] += min(unused, r.max_carry) if r.carry_forward else 0.0
        t["ledgerMismatches"] += 1 if mismatch else 0
        d["people"].add(r.who.id)
        d["allocated"] += r.allocated
        d["used"] += r.used
        d["unused"] += unused
        d["overdrawnDays"] += over
        people.add(r.who.id)
        total["allocated"] += r.allocated
        total["used"] += r.used
        total["unused"] += unused
        total["overdrawn"] += over
        total["mismatches"] += 1 if mismatch else 0
        if over > 0:
            overdrawn.append(
                {
                    **D.person_row(r.who),
                    "type": r.type_label,
                    "allocated": round(r.allocated, 1),
                    "used": round(r.used, 1),
                    "overBy": round(over, 1),
                }
            )

    type_rows = []
    for t in by_type.values():
        type_rows.append(
            {
                **t,
                "allocated": round(t["allocated"], 1),
                "used": round(t["used"], 1),
                "unused": round(t["unused"], 1),
                "overdrawnDays": round(t["overdrawnDays"], 1),
                "carryOverDays": round(t["carryOverDays"], 1),
                "usedPct": pct(t["used"], t["allocated"]),
            }
        )
    type_rows.sort(key=lambda r: (-r["unused"], r["label"].lower()))
    dept_rows = sorted(
        (
            {
                "label": d["label"],
                "employees": len(d["people"]),
                "allocated": round(d["allocated"], 1),
                "used": round(d["used"], 1),
                "unused": round(d["unused"], 1),
                "overdrawnDays": round(d["overdrawnDays"], 1),
                "usedPct": pct(d["used"], d["allocated"]),
                "unusedPerEmployee": round(d["unused"] / len(d["people"]), 1),
            }
            for d in by_dept.values()
        ),
        key=lambda r: (-r["unused"], r["label"].lower()),
    )
    overdrawn.sort(key=lambda r: (-r["overBy"], r["employeeCode"], r["type"]))
    progress = _year_progress(year, now)
    notes = []
    if not rows:
        notes.append(f"No leave balances have been allocated for {year} to the active staff in this selection.")
    if scope.employment_type == "production":
        notes.append("Leave does not apply to production employees, so there are no balances for a production-only selection.")
    if without_allocation:
        notes.append(
            f"{days_text(without_allocation)} of approved leave in {year} is for an employee and leave type that have no "
            "allocation (including leave saved without a type)."
        )
    if unreadable:
        notes.append(f"{num(unreadable)} approved leave {plural(unreadable, 'request')} with an unreadable date is not counted.")
    entry = prov(
        "leave-balance",
        "Leave balances",
        dataset="Leave balances (HR's yearly allocation), leave requests (approved)",
        definition=(
            "For each active staff member and leave type with an allocation for the year: days taken (recomputed from the "
            "approved requests that start in the year, each request's stored days, a half day = 0.5), days unused, and "
            "days taken beyond the allocation. 'Unused' is days the person could still take, not money: the app records "
            "no leave pay rate and no encashment."
        ),
        formula="unused = max(0, allocated − taken); beyond allocation = max(0, taken − allocated); carry-over = min(unused, the type's carry-forward limit) for types that carry forward",
        rows=len(rows),
        filters=[str(year), scope.describe()],
        caveats=[
            "The app does not stop leave beyond the allocation, and the allocation is a record HR maintains by hand.",
            "Production employees, leavers and leave types HR has switched off are left out. Casual leave (its own "
            "one-a-month system) has no allocation here.",
            "Carried-forward days are not added to the allocation (the ledger shows them for information only).",
        ],
    )
    ledger = prov(
        "leave-ledger",
        "HR's balance ledger against the requests",
        dataset="Leave balances, leave requests (approved)",
        definition=(
            "HR's balance ledger is bumped when a request is approved and is not restored when it is later rejected or "
            "deleted, so it can drift from the requests. A row is counted when the ledger's used days differ from the "
            "approved requests' days by 0.05 or more."
        ),
        formula="ledger mismatches = balance rows where |ledger used − approved days| ≥ 0.05",
        rows=len(rows),
        filters=[str(year), scope.describe()],
    )
    return envelope(
        {
            "year": year,
            "yearProgressPct": progress,
            "totals": {
                "employees": len(people),
                "allocated": round(total["allocated"], 1),
                "used": round(total["used"], 1),
                "unused": round(total["unused"], 1),
                "usedPct": pct(total["used"], total["allocated"]),
                "overdrawnDays": round(total["overdrawn"], 1),
                "overdrawnEmployees": len({o["employeeCode"] for o in overdrawn}),
                "exhausted": sum(t["exhausted"] for t in by_type.values()),
                "low": sum(t["low"] for t in by_type.values()),
                "untouched": sum(t["untouched"] for t in by_type.values()),
                "carryOverDays": round(sum(t["carryOverDays"] for t in by_type.values()), 1),
                "ledgerMismatches": total["mismatches"],
                "usedWithoutAllocation": without_allocation,
            },
            "lowBalanceDays": LOW_BALANCE_DAYS,
            "byType": type_rows,
            "byDepartment": dept_rows[:LIST_MAX],
            "overdrawn": overdrawn[:limit],
            "overdrawnTotal": len(overdrawn),
        },
        scope=scope,
        provenance=[entry, ledger],
        notes=notes,
    )


# ─── unusual patterns ───────────────────────────────────────────────────────────────────────────────────────────


@cached()
def leave_patterns(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """What looks unusual: leave bunched on Mondays and Fridays (and the people who do it repeatedly), long leave taken
    without notice, leave in the 30 days before a resignation, and people with many separate leaves. Each list names the
    people (in ``employeeName`` fields) because the MD acts on exceptions."""
    limit = int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    lookback = timedelta(days=RESIGNATION_LOOKBACK_DAYS)
    facts = D.load_facts(scope, period.start - lookback, period.end)
    holidays = D.holiday_dates(period.start, period.end)

    per_weekday = [0.0] * 7
    per_person: dict[int, dict] = {}
    by_person_days: dict[int, list[tuple[date, float]]] = defaultdict(list)
    for eid, day, weight, _type, rid in facts.days:
        by_person_days[eid].append((day, weight))
        if not (period.start <= day <= period.end):
            continue
        per_weekday[day.weekday()] += weight
        p = per_person.setdefault(eid, {"days": 0.0, "edge": 0.0, "dates": [], "requests": set()})
        p["days"] += weight
        p["requests"].add(rid)
        if day.weekday() in EDGE_WEEKDAYS:
            p["edge"] += weight
            p["dates"].append(day)

    work_dates = [d for d in D.daterange(period.start, period.end) if d.weekday() != D.SUNDAY and d not in holidays]
    expected_count = Counter(d.weekday() for d in work_dates)
    total_days = sum(per_weekday)
    weekdays = []
    for index in range(7):
        if index == D.SUNDAY and not per_weekday[index]:
            continue
        expected = pct(expected_count[index], len(work_dates))
        share = pct(per_weekday[index], total_days)
        weekdays.append(
            {
                "weekday": index,
                "label": WEEKDAYS[index],
                "leaveDays": round(per_weekday[index], 1),
                "sharePct": share,
                "expectedSharePct": expected,
                "index": round(share / expected, 2) if share is not None and expected else None,
            }
        )
    edge_days = per_weekday[0] + per_weekday[4]
    expected_edge = pct(expected_count[0] + expected_count[4], len(work_dates))

    repeat = []
    for eid, p in per_person.items():
        share = pct(p["edge"], p["days"])
        if p["edge"] >= REPEAT_EDGE_MIN_DAYS and share is not None and share >= REPEAT_EDGE_MIN_SHARE_PCT:
            repeat.append(
                {
                    **D.person_row(facts.who[eid]),
                    "leaveDays": round(p["days"], 1),
                    "edgeDays": round(p["edge"], 1),
                    "edgeSharePct": share,
                    "dates": [_iso(d) for d in sorted(p["dates"])[:6]],
                }
            )
    repeat.sort(key=lambda r: (-r["edgeDays"], -r["edgeSharePct"], r["employeeCode"]))

    unplanned = []
    for req in facts.reqs.values():
        if req.id < 0 or not (period.start <= req.start <= period.end):
            continue
        if req.total < LONG_LEAVE_DAYS or req.notice is None or req.notice > UNPLANNED_NOTICE_DAYS:
            continue
        unplanned.append(
            {
                **D.person_row(facts.who[req.employee_id]),
                "type": facts.types[req.type_key].label,
                "isSick": facts.types[req.type_key].sick,
                "from": _iso(req.start),
                "to": _iso(req.end),
                "days": req.total,
                "noticeDays": req.notice,
            }
        )
    unplanned.sort(key=lambda r: (-r["days"], r["from"], r["employeeCode"]))

    start_at, end_at = ist_bounds(period.start, period.end)
    resignations = list(
        ResignationRequest.objects.filter(scope.employee_q("employee__"), created_at__gte=start_at, created_at__lt=end_at)
        .exclude(status="rejected")
        .order_by("created_at", "id")
        .values("id", "employee_id", "created_at", "last_working_date", *D.EMP_VALUES)
    )
    before_resignation = []
    for row in resignations:
        resigned = ist_date(row["created_at"])
        window_start = resigned - lookback
        taken = sum(w for d, w in by_person_days.get(row["employee_id"], ()) if window_start <= d < resigned)
        if taken >= RESIGNATION_MIN_LEAVE_DAYS:
            before_resignation.append(
                {
                    **D.person_row(D.who_from(row, row["employee_id"])),
                    "resignedOn": _iso(resigned),
                    "lastWorkingDate": _iso(row["last_working_date"]),
                    "leaveDaysBefore": round(taken, 1),
                }
            )
    before_resignation.sort(key=lambda r: (-r["leaveDaysBefore"], r["employeeCode"]))

    frequent = [
        {
            **D.person_row(facts.who[eid]),
            "requests": len(p["requests"]),
            "leaveDays": round(p["days"], 1),
        }
        for eid, p in per_person.items()
        if len(p["requests"]) >= FREQUENT_MIN_REQUESTS
    ]
    frequent.sort(key=lambda r: (-r["requests"], -r["leaveDays"], r["employeeCode"]))

    notes = _scope_notes(scope, facts, D.Heads())
    notes = [n for n in notes if "no active staff" not in n]
    if not total_days:
        notes.insert(0, f"No approved leave falls in {period.label} for this selection, so there are no patterns to show.")
    f = _filters(scope, period)
    entries = {
        "leave-weekday": prov(
            "leave-weekday",
            "Leave by weekday",
            dataset="Leave requests (approved), casual leave requests, holidays",
            definition=(
                "Leave days on each weekday, against the share each weekday has of the period's working days (Monday to "
                "Saturday dates that are not a holiday). An index above 1 means that weekday has more leave than its share. "
                "Monday and Friday are the days that join the weekend."
            ),
            formula="share = weekday leave days ÷ all leave days; index = share ÷ the weekday's share of working days",
            rows=len(facts.reqs),
            filters=f,
            caveats=["Staff on Saturday off or a different weekly off are counted on the same calendar."],
        ),
        "leave-pattern-edge": prov(
            "leave-pattern-edge",
            "Repeat Monday and Friday leave",
            dataset="Leave requests (approved), casual leave requests",
            definition=(
                f"Employees with at least {REPEAT_EDGE_MIN_DAYS:g} leave days on a Monday or Friday in the period and at "
                f"least {REPEAT_EDGE_MIN_SHARE_PCT:g}% of their leave days on those two days. A long leave that happens "
                "to include a Monday and a Friday does not qualify."
            ),
            formula="Monday + Friday leave days ≥ 3 and ÷ the person's leave days ≥ 60%",
            rows=len(repeat),
            filters=f,
            caveats=["A pattern is a reason to ask, not a finding: the reason for each leave is not used."],
        ),
        "leave-pattern-unplanned": prov(
            "leave-pattern-unplanned",
            "Long leave taken without notice",
            dataset="Leave requests (approved)",
            definition=(
                f"Approved leaves of {LONG_LEAVE_DAYS:g} or more days that started in the period and were applied for on "
                "or after their first day. A leave is called sick when its type is a sick or medical type."
            ),
            formula="total days ≥ 3 and (first leave day − application date) ≤ 0",
            rows=len(unplanned),
            filters=f,
            caveats=["HR can enter leave after the fact on an employee's behalf; the data cannot tell who entered it."],
        ),
        "leave-pattern-resignation": prov(
            "leave-pattern-resignation",
            "Leave before a resignation",
            dataset="Resignation requests, leave requests (approved)",
            definition=(
                f"Employees who submitted a resignation in the period (not rejected) and took {RESIGNATION_MIN_LEAVE_DAYS:g} "
                f"or more days of approved leave in the {RESIGNATION_LOOKBACK_DAYS} days before submitting it."
            ),
            formula="leave days in [resignation date − 30, resignation date) ≥ 3",
            rows=len(resignations),
            filters=f,
            caveats=["It shows a timing, not a cause. People who leave often use up leave first."],
        ),
        "leave-pattern-frequent": prov(
            "leave-pattern-frequent",
            "Many separate leaves",
            dataset="Leave requests (approved), casual leave requests",
            definition=f"Employees with {FREQUENT_MIN_REQUESTS} or more separate approved leaves with days in the period.",
            formula="distinct approved requests with a day in the period ≥ 4",
            rows=len(frequent),
            filters=f,
        ),
    }
    return envelope(
        {
            "weekdays": weekdays,
            "edgeDays": {
                "leaveDays": round(edge_days, 1),
                "sharePct": pct(edge_days, total_days),
                "expectedSharePct": expected_edge,
            },
            "repeatEdge": {"total": len(repeat), "rows": repeat[:limit], "truncated": len(repeat) > limit},
            "longUnplanned": {
                "total": len(unplanned),
                "sick": sum(1 for u in unplanned if u["isSick"]),
                "rows": unplanned[:limit],
                "truncated": len(unplanned) > limit,
            },
            "beforeResignation": {
                "total": len(before_resignation),
                "resignations": len(resignations),
                "rows": before_resignation[:limit],
                "truncated": len(before_resignation) > limit,
            },
            "frequent": {"total": len(frequent), "rows": frequent[:limit], "truncated": len(frequent) > limit},
            "thresholds": {
                "repeatEdgeMinDays": REPEAT_EDGE_MIN_DAYS,
                "repeatEdgeMinSharePct": REPEAT_EDGE_MIN_SHARE_PCT,
                "longLeaveDays": LONG_LEAVE_DAYS,
                "resignationLookbackDays": RESIGNATION_LOOKBACK_DAYS,
                "resignationMinLeaveDays": RESIGNATION_MIN_LEAVE_DAYS,
                "frequentMinRequests": FREQUENT_MIN_REQUESTS,
            },
        },
        period=period,
        scope=scope,
        provenance=list(entries.values()),
        notes=notes,
    )


# ─── holidays and the leave around them ─────────────────────────────────────────────────────────────────────────


def _step(day: date, direction: int, holidays: set[date]) -> date:
    """The nearest working day (not a Sunday or a holiday) before (-1) or after (+1) ``day``."""
    step = day + timedelta(days=direction)
    for _ in range(14):
        if step.weekday() != D.SUNDAY and step not in holidays:
            return step
        step += timedelta(days=direction)
    return step


@cached()
def leave_holidays(scope: Scope, period: Period, limit: int = UPCOMING_DEFAULT, today: date | None = None) -> dict:
    """The holiday calendar against leave: a day-by-day grid for the period (leave days, people out, holidays marked), the
    holidays in it with the leave on the working day before and after each, whether leave bunches around holidays, and
    the next holidays with how much approved leave already sits around them."""
    limit = int_arg(limit, "limit", UPCOMING_DEFAULT, 1, UPCOMING_MAX)
    now = today or D.today()
    cal_start = max(period.start, period.end - timedelta(days=CALENDAR_MAX_DAYS - 1))
    horizon = now + timedelta(days=UPCOMING_DAYS)
    reach = timedelta(days=7)
    low, high = min(cal_start, now) - reach, max(period.end, horizon) + reach
    rows = list(
        Holiday.objects.filter(date__gte=low, date__lte=high)
        .order_by("date", "id")
        .values("id", "name", "date", "holiday_type", "branch__name", "department__name")
    )
    holiday_set = {r["date"] for r in rows}
    names: dict[date, str] = {}
    for r in rows:
        names[r["date"]] = f"{names[r['date']]} / {r['name']}" if r["date"] in names else r["name"]
    facts = D.load_facts(scope, low, high)
    heads = D.load_heads(scope)

    leave_on: dict[date, float] = defaultdict(float)
    people_on: dict[date, set[int]] = defaultdict(set)
    for eid, day, weight, _type, _rid in facts.days:
        leave_on[day] += weight
        people_on[day].add(eid)

    calendar = [
        {
            "date": _iso(d),
            "weekday": d.weekday(),
            "leaveDays": round(leave_on.get(d, 0.0), 1),
            "onLeave": len(people_on.get(d, ())),
            "isHoliday": d in holiday_set,
            "holiday": names.get(d),
            "isSunday": d.weekday() == D.SUNDAY,
        }
        for d in D.daterange(cal_start, period.end)
    ]

    def around(day: date) -> dict:
        before, after = _step(day, -1, holiday_set), _step(day, 1, holiday_set)
        return {
            "before": {"date": _iso(before), "leaveDays": round(leave_on.get(before, 0.0), 1)},
            "after": {"date": _iso(after), "leaveDays": round(leave_on.get(after, 0.0), 1)},
            "aroundDays": round(leave_on.get(before, 0.0) + leave_on.get(after, 0.0), 1),
            "aroundPeople": len(people_on.get(before, set()) | people_on.get(after, set())),
        }

    def entry(row: dict) -> dict:
        day = row["date"]
        sunday = day.weekday() == D.SUNDAY
        return {
            "id": row["id"],
            "date": _iso(day),
            "name": row["name"],
            "type": row["holiday_type"],
            "weekday": WEEKDAYS[day.weekday()],
            "unit": row["branch__name"],
            "department": row["department__name"],
            "isSunday": sunday,
            "joinsWeekend": day.weekday() in (0, 5),
            "daysUntil": (day - now).days,
            **(
                {"before": None, "after": None, "aroundDays": None, "aroundPeople": None}
                if sunday
                else around(day)
            ),
        }

    in_calendar = [entry(r) for r in rows if cal_start <= r["date"] <= period.end]
    upcoming = [entry(r) for r in rows if now <= r["date"] <= horizon][:limit]

    working = [d for d in D.daterange(cal_start, period.end) if d.weekday() != D.SUNDAY and d not in holiday_set]
    baseline_total = sum(leave_on.get(d, 0.0) for d in working)
    baseline = baseline_total / len(working) if working else None
    sides = [h for h in in_calendar if not h["isSunday"]]
    around_total = sum(h["aroundDays"] for h in sides)
    around_average = around_total / (2 * len(sides)) if sides else None
    lift = (
        round((around_average / baseline - 1) * 100, 1)
        if baseline and around_average is not None
        else None
    )

    notes = _scope_notes(scope, facts, heads)
    if not rows:
        notes.insert(0, "No holidays are listed in the calendar for this period or the next 90 days.")
    notes.append(
        "Holidays apply to every employee: the attendance engine ignores the unit and department written on a holiday, so "
        "the list is not narrowed to the selection."
    )
    if period.days > CALENDAR_MAX_DAYS:
        notes.append(f"The grid shows the last {CALENDAR_MAX_DAYS} days of the period.")
    f = _filters(scope, period)
    entries = {
        "leave-calendar": prov(
            "leave-calendar",
            "Leave calendar",
            dataset="Leave requests (approved), casual leave requests, holidays",
            definition="Each day's leave days and people on leave, with holidays and Sundays marked.",
            formula="leave days on the date; people = distinct employees with a leave day on it",
            rows=len(facts.reqs),
            filters=f,
            caveats=[*_COMMON_CAVEATS, f"At most the last {CALENDAR_MAX_DAYS} days of the period are drawn."],
        ),
        "leave-bridge": prov(
            "leave-bridge",
            "Leave around holidays",
            dataset="Leave requests (approved), casual leave requests, holidays",
            definition=(
                "For each holiday that is not a Sunday: the leave days on the nearest working day before it and the nearest "
                "working day after it. 'Lift' compares their average with the average leave per working day in the grid."
            ),
            formula="lift = average leave on the days just before and after holidays ÷ average leave per working day − 1",
            rows=len(sides),
            filters=f,
            caveats=["A working day is a Monday to Saturday date that is not a holiday. Few holidays make a noisy average."],
        ),
        "leave-upcoming": prov(
            "leave-upcoming",
            "Next holidays",
            dataset="Holidays, leave requests (approved), casual leave requests",
            definition=(
                f"Holidays in the next {UPCOMING_DAYS} days with the approved leave already on the working day before and "
                "after each. A holiday on a Monday or Saturday joins the Sunday off into a long weekend."
            ),
            formula="leave days on the nearest working day before + after the holiday",
            rows=len(upcoming),
            filters=[f"Next {UPCOMING_DAYS} days", scope.describe()],
            caveats=["Only leave that is already approved is counted: more may be asked for."],
        ),
    }
    return envelope(
        {
            "calendar": calendar,
            "calendarStart": _iso(cal_start),
            "holidays": in_calendar,
            "upcoming": upcoming,
            "bridging": {
                "holidays": len(sides),
                "averageAroundHolidays": round(around_average, 2) if around_average is not None else None,
                "averagePerWorkingDay": round(baseline, 2) if baseline is not None else None,
                "liftPct": lift,
            },
            "eligibleHeadcount": heads.total,
        },
        period=period,
        scope=scope,
        provenance=list(entries.values()),
        notes=notes,
    )


# ─── approvals: what waits, what is rejected ────────────────────────────────────────────────────────────────────


def _rejection_rows(apps: list[D.Application], key, limit: int) -> list[dict]:
    groups: dict[str, Counter] = defaultdict(Counter)
    for a in apps:
        groups[key(a)][a.status] += 1
    rows = []
    for label, counts in groups.items():
        decided = counts["approved"] + counts["rejected"]
        rows.append(
            {
                "label": label,
                "applied": sum(counts.values()),
                "approved": counts["approved"],
                "rejected": counts["rejected"],
                "pending": counts["pending"],
                "rejectionPct": pct(counts["rejected"], decided),
            }
        )
    rows.sort(key=lambda r: (-r["rejected"], -(r["rejectionPct"] or 0), -r["applied"], r["label"].lower()))
    return rows[:limit]


@cached()
def leave_approvals(scope: Scope, period: Period, limit: int = LIST_DEFAULT, today: date | None = None) -> dict:
    """The approval process: requests applied for in the period and what became of them (approved, rejected, still waiting,
    rejection rate by type and department, how long decisions take, how many came without notice) and every request waiting
    right now with the oldest named."""
    limit = int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    now = today or D.today()
    previous = period.previous()
    cur_apps = D.applications_made(scope, period.start, period.end)
    old_apps = D.applications_made(scope, previous.start, previous.end)
    pending_apps = D.applications_pending(scope)
    cur, old = _app_stats(cur_apps), _app_stats(old_apps)
    pending = _pending_stats(pending_apps, now)

    hours = sorted(cur["decisionHours"])
    decision = {
        "known": len(hours),
        "decided": cur["decided"],
        "averageHours": round(sum(hours) / len(hours), 1) if hours else None,
        "medianHours": round(statistics.median(hours), 1) if hours else None,
        "withinDayPct": pct(sum(1 for h in hours if h <= 24), len(hours)),
    }
    waiting = [
        {
            **D.person_row(a.who),
            "type": a.type_label,
            "from": _iso(a.start),
            "to": _iso(a.end),
            "days": a.total,
            "halfDay": a.half,
            "appliedOn": _iso(a.applied),
            "waitingDays": max(0, (now - a.applied).days) if a.applied else None,
            "startsInDays": (a.start - now).days if a.start else None,
            "stage": a.stage,
        }
        for a in pending_apps[:limit]
    ]
    f = _filters(scope, period)
    entries = _provenance(
        scope,
        period,
        rows={"applied": cur["applied"], "decided": cur["decided"], "noticeKnown": cur["noticeKnown"]},
    )
    entries["leave-decision-time"] = prov(
        "leave-decision-time",
        "How long decisions take",
        dataset="Leave requests (approval history)",
        definition=(
            "Hours from applying to the last recorded decision, for the requests of the period that have been decided and "
            "whose decision time was recorded. Older requests do not record it and are left out."
        ),
        formula="decision time = time of the last decision − time applied for",
        rows=len(hours),
        filters=f,
        caveats=["Requests whose decision time is not recorded are left out, so this describes only part of them."],
    )
    notes = []
    if not cur["applied"]:
        notes.append(f"No leave requests were applied for in {period.label} for this selection.")
    if cur["decided"] and len(hours) < cur["decided"]:
        notes.append(
            f"The decision time is known for {num(len(hours))} of the {num(cur['decided'])} requests decided: older "
            "requests do not record when they were decided."
        )
    if not pending["count"]:
        notes.append("No leave requests are waiting for a decision right now.")
    return envelope(
        {
            "cohort": {
                **{k: cur[k] for k in ("applied", "approved", "rejected", "pending", "decided")},
                "rejectionPct": cur["rejectionPct"],
                "shortNotice": cur["shortNotice"],
                "shortNoticePct": cur["shortNoticePct"],
                "previous": {k: old[k] for k in ("applied", "approved", "rejected", "pending", "decided", "rejectionPct")},
                "change": {
                    "applied": change(cur["applied"], old["applied"]),
                    "rejectionPct": change(cur["rejectionPct"], old["rejectionPct"]),
                },
            },
            "decisionTime": decision,
            "rejectionByType": _rejection_rows(cur_apps, lambda a: a.type_label, 8),
            "rejectionByDepartment": _rejection_rows(cur_apps, lambda a: a.who.dept, 8),
            "pending": {**pending, "rows": waiting, "total": pending["count"], "truncated": pending["count"] > limit},
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=[
            *_pick(entries, "leave-applications", "leave-rejection", "leave-notice"),
            entries["leave-decision-time"],
            _pending_provenance(scope, pending["count"]),
        ],
        notes=notes,
    )


# ─── the plain-English summary (composed by rules from the figures above: no AI) ────────────────────────────────


def _line(id_: str, text: str, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "page": PAGE, "tone": tone}


def _change_phrase(metric: dict, previous: Period) -> str:
    delta, prior = metric["change"], metric["previous"]
    if delta is None:
        return ""
    if not prior:
        return f", with none in {D.previous_phrase(previous.days)}" if metric["value"] else ""
    if delta["pct"] is not None and abs(delta["pct"]) < 1:
        return f", level with {D.previous_phrase(previous.days)}"
    direction = "up" if delta["abs"] > 0 else "down"
    return f", {direction} {pct_text(abs(delta['pct']), 0)} on {D.previous_phrase(previous.days)}"


@cached()
def leave_briefing(scope: Scope, period: Period, today: date | None = None) -> dict:
    """Four or five plain sentences about leave with the numbers (taken, mix, out now, waiting, next holiday), written by
    fixed rules from the same figures the page shows. No AI is involved, so opening the page costs no quota and sends nothing
    to Google; the assistant explains on demand."""
    now = today or D.today()
    summary = leave_summary(scope, period, now)
    kinds = leave_groups(scope, period, by="type", limit=LIST_MAX)
    departments = leave_groups(scope, period, by="department", limit=LIST_MAX)
    current = leave_today(scope, "today", 1, now)
    holidays = leave_holidays(scope, period, 1, now)
    m = summary["metrics"]
    days, people, rate = m["leaveDays"]["value"], m["employeesOnLeave"]["value"], m["leaveRatePct"]["value"]
    previous = period.previous()
    sentences: list[dict] = []

    if not days:
        sentences.append(_line("volume", f"No approved leave was taken in {period.label}."))
    else:
        delta = m["leaveDays"]["change"]
        spike = bool(
            delta
            and delta["pct"] is not None
            and delta["pct"] >= SPIKE_PCT
            and delta["abs"] >= SPIKE_MIN_DAYS
            and (m["leaveDays"]["previous"] or 0) >= SPIKE_MIN_BASE
        )
        rate_text = f", {pct_text(rate, 1)} of working days" if rate is not None else ""
        sentences.append(
            _line(
                "volume",
                f"{period.label}: {days_text(days)} of approved leave taken by {num(people)} "
                f"{plural(people, 'employee', 'employees')}{rate_text}{_change_phrase(m['leaveDays'], previous)}.",
                "watch" if spike else "neutral",
            )
        )

    mix = []
    tone = "neutral"
    if days and kinds["rows"]:
        top = kinds["rows"][0]
        mix.append(f"{top['label']} makes up {pct_text(top['sharePct'], 0)} of the days")
    ranked = [r for r in departments["rows"] if r["daysPerEmployee"] is not None and not r["lowSample"] and r["leaveDays"]]
    if days and len(ranked) >= 2:
        top = ranked[0]
        average = departments["average"]["daysPerEmployee"]
        if average and top["vsCompany"] is not None and top["vsCompany"] >= 1.25:
            mix.append(
                f"{top['label']} takes the most per employee ({num(top['daysPerEmployee'], 1)} days against "
                f"{num(average, 1)} across the company)"
            )
            if top["vsCompany"] >= GROUP_FLAG_RATIO and top["leaveDays"] >= GROUP_FLAG_MIN_DAYS:
                tone = "watch"
    if mix:
        sentences.append(_line("mix", "; ".join(mix) + ".", tone))

    out = current["outToday"]
    if out["people"] or current["weekPeople"]:
        head = (
            f"Today {num(out['people'])} {plural(out['people'], 'person is', 'people are')} on leave"
            if out["people"]
            else "Nobody is on leave today"
        )
        half = f" ({num(out['halfDay'])} on a half day)" if out["halfDay"] else ""
        share = f", {pct_text(out['pct'], 0)} of staff" if out["people"] and out["pct"] is not None else ""
        week = f"; {num(current['weekPeople'])} {plural(current['weekPeople'], 'person has', 'people have')} leave on at least one day this week"
        warn = bool(
            out["pct"] is not None and out["pct"] >= OUT_TODAY_WARN_PCT and out["people"] >= OUT_TODAY_MIN_PEOPLE
        )
        sentences.append(_line("now", f"{head}{half}{share}{week}.", "watch" if warn else "neutral"))
    else:
        sentences.append(_line("now", "Nobody is on approved leave today or later this week."))

    waiting = summary["pending"]
    requests = summary["requests"]
    if not waiting["count"]:
        text, tone = "No leave requests are waiting for a decision", "good"
    else:
        text = (
            f"{num(waiting['count'])} leave {plural(waiting['count'], 'request is', 'requests are')} waiting for a decision, "
            f"the oldest for {days_text(waiting['oldestDays'])}"
        )
        tone = "watch" if (waiting["waitingTooLong"] or waiting["pastStart"]) else "neutral"
    rejection = m["rejectionPct"]["value"]
    if requests["decided"] and rejection is not None:
        text += f"; {pct_text(rejection, 0)} of the {num(requests['decided'])} requests decided in {period.label} were rejected"
        if requests["decided"] >= REJECTION_MIN_DECIDED and rejection >= REJECTION_WARN_PCT:
            tone = "watch"
    sentences.append(_line("approvals", text + ".", tone))

    if holidays["upcoming"]:
        nxt = holidays["upcoming"][0]
        when = "today" if nxt["daysUntil"] == 0 else f"in {days_text(nxt['daysUntil'])}"
        text = f"Next holiday: {nxt['name']}, {weekday_date(date.fromisoformat(nxt['date']))} ({when})"
        if nxt["aroundDays"]:
            text += f"; {days_text(nxt['aroundDays'])} of approved leave already sit on the working days around it"
        sentences.append(_line("holiday", text + "."))

    ask = (
        f"Give me a briefing on leave and holidays ({period.label}): how much leave was taken and where, who is out, what "
        "is waiting for approval and anything unusual."
    )
    entry = prov(
        "leave-briefing",
        "The summary",
        dataset="The figures on this page",
        definition=(
            "A few sentences written by fixed rules from the leave figures on this page (days taken, the biggest type and "
            "department, who is out today, what is waiting, the next holiday). No AI is used to write it."
        ),
        formula="rules over leave_summary, leave_groups, leave_today and leave_holidays",
        filters=_filters(scope, period),
    )
    return envelope(
        {
            "sentences": sentences,
            "text": " ".join(s["text"] for s in sentences),
            "ask": ask,
        },
        period=period,
        scope=scope,
        provenance=[entry, *summary["provenance"][:3]],
        notes=summary["notes"],
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ──────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"leave.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _exceptions(scope: Scope, period: Period, *, limit: int, today: date | None = None) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``. Built on
    the public analytics so a flag always points at a figure that is on the page."""
    now = today or D.today()
    summary = leave_summary(scope, period, now)
    m = summary["metrics"]
    pending = summary["pending"]
    items: list[dict] = []
    when = period.label

    # requests waiting too long, or already past their first day
    if pending["waitingTooLong"] or pending["pastStart"]:
        oldest = pending["oldestDays"] or 0
        waits = pending["waitingTooLong"]
        parts = []
        if waits:
            parts.append(f"{num(waits)} {plural(waits, 'has', 'have')} waited {PENDING_WARN_DAYS} days or more")
        if pending["pastStart"]:
            parts.append(f"{num(pending['pastStart'])} {plural(pending['pastStart'], 'is', 'are')} for dates that have already begun")
        items.append(
            _item(
                "pending",
                "critical" if oldest >= PENDING_CRITICAL_DAYS else "warning",
                f"{num(pending['count'])} leave {plural(pending['count'], 'request is', 'requests are')} waiting for a decision, the oldest for {days_text(oldest)}",
                f"{'; '.join(parts).capitalize()}. The requests are on the Leave & Holiday page.",
                days_text(oldest),
                "Which leave requests have been waiting longest for a decision, who are they for, and who has to decide them?",
            )
        )

    # a rise (or a fall) in leave against the previous period
    leave, prior = m["leaveDays"]["value"], m["leaveDays"]["previous"]
    delta = m["leaveDays"]["change"]
    if delta and delta["pct"] is not None and (prior or 0) >= SPIKE_MIN_BASE and abs(delta["abs"]) >= SPIKE_MIN_DAYS:
        if delta["pct"] >= SPIKE_PCT:
            items.append(
                _item(
                    "spike",
                    "critical" if delta["pct"] >= SPIKE_CRITICAL_PCT else "warning",
                    f"Leave rose {pct_text(delta['pct'], 0)} to {days_text(leave)} from {days_text(prior)}",
                    f"{when} against {D.previous_phrase(period.days)}: {days_text(delta['abs'])} more.",
                    f"+{pct_text(delta['pct'], 0)}",
                    f"Why did leave rise from {days_text(prior)} to {days_text(leave)} ({when}), and which types, departments and weeks drive it?",
                )
            )
        elif delta["pct"] <= -SPIKE_PCT:
            items.append(
                _item(
                    "drop",
                    "info",
                    f"Leave fell {pct_text(abs(delta['pct']), 0)} to {days_text(leave)} from {days_text(prior)}",
                    f"{when} against {D.previous_phrase(period.days)}: {days_text(abs(delta['abs']))} fewer.",
                    f"-{pct_text(abs(delta['pct']), 0)}",
                    f"Why did leave fall from {days_text(prior)} to {days_text(leave)} ({when})?",
                )
            )

    # a department taking much more leave than the company
    departments = leave_groups(scope, period, by="department", limit=LIST_MAX)
    average = departments["average"]["daysPerEmployee"]
    hot = [
        r
        for r in departments["rows"]
        if not r["lowSample"]
        and r["vsCompany"] is not None
        and r["vsCompany"] >= GROUP_FLAG_RATIO
        and r["leaveDays"] >= GROUP_FLAG_MIN_DAYS
        and r["key"] != NONE_KEY
    ]
    if average and hot:
        top = max(hot, key=lambda r: (r["vsCompany"], r["leaveDays"]))
        items.append(
            _item(
                "department",
                "warning",
                f"{top['label']} took {num(top['daysPerEmployee'], 1)} days of leave per employee, {num(top['vsCompany'], 1)}× the company's {num(average, 1)}",
                f"{when}: {days_text(top['leaveDays'])} across {num(top['headcount'])} employees ({pct_text(top['sharePct'], 0)} of all leave).",
                f"{num(top['daysPerEmployee'], 1)} days each",
                f"Why is leave so high in {top['label']} ({when}), and who and what types account for it?",
            )
        )

    # many requests refused
    rejection = m["rejectionPct"]["value"]
    decided = summary["requests"]["decided"]
    if decided >= REJECTION_MIN_DECIDED and rejection is not None and rejection >= REJECTION_WARN_PCT:
        items.append(
            _item(
                "rejection",
                "critical" if rejection >= REJECTION_CRITICAL_PCT else "warning",
                f"{pct_text(rejection, 0)} of leave requests were rejected",
                f"{when}: {num(summary['requests']['rejected'])} of the {num(decided)} requests decided were rejected.",
                pct_text(rejection, 0),
                f"Why are so many leave requests being rejected ({when}), and in which departments and leave types?",
            )
        )

    # unusual patterns
    patterns = leave_patterns(scope, period, limit=LIST_MAX)
    unplanned = patterns["longUnplanned"]
    if unplanned["total"]:
        n = unplanned["total"]
        items.append(
            _item(
                "unplanned",
                "warning" if unplanned["sick"] >= 3 else "info",
                f"{num(n)} long {plural(n, 'leave')} of {LONG_LEAVE_DAYS:g}+ days started without notice",
                f"{when}: {num(unplanned['sick'])} of them {plural(unplanned['sick'], 'is', 'are')} sick leave. Applied for on or after the first day.",
                num(n),
                f"Who took long leave without notice ({when}), for how many days, and is it sick leave?",
            )
        )
    repeat = patterns["repeatEdge"]
    if repeat["total"]:
        n = repeat["total"]
        items.append(
            _item(
                "edge-days",
                "warning" if n >= 3 else "info",
                f"{num(n)} {plural(n, 'person')} take leave mostly on Mondays and Fridays",
                f"{when}: each had {REPEAT_EDGE_MIN_DAYS:g}+ leave days on those days, {REPEAT_EDGE_MIN_SHARE_PCT:g}%+ of their leave. The names are on the Insights tab.",
                num(n),
                f"Who repeatedly takes leave on Mondays and Fridays ({when}), and how many days is it?",
            )
        )
    resign = patterns["beforeResignation"]
    if resign["total"]:
        n = resign["total"]
        items.append(
            _item(
                "resignation",
                "warning" if n >= 2 else "info",
                f"{num(n)} of {num(resign['resignations'])} {plural(resign['resignations'], 'resignation')} followed {RESIGNATION_MIN_LEAVE_DAYS:g}+ days of leave",
                f"{when}: taken in the {RESIGNATION_LOOKBACK_DAYS} days before the resignation was submitted.",
                num(n),
                f"Which employees took leave just before resigning ({when}), and is there a pattern by department or manager?",
            )
        )

    # today's absence
    current = leave_today(scope, "today", 1, now)
    out = current["outToday"]
    if out["pct"] is not None and out["pct"] >= OUT_TODAY_WARN_PCT and out["people"] >= OUT_TODAY_MIN_PEOPLE:
        items.append(
            _item(
                "out-today",
                "critical" if out["pct"] >= OUT_TODAY_CRITICAL_PCT else "warning",
                f"{num(out['people'])} people ({pct_text(out['pct'], 0)} of staff) are on leave today",
                f"{num(out['fullDay'])} full day and {num(out['halfDay'])} half day. {num(current['startingSoon'])} more start leave in the next {SOON_DAYS} days.",
                pct_text(out['pct'], 0),
                "Who is on leave today, which departments are thinnest, and who starts leave this week?",
            )
        )

    # an approaching holiday with a lot of leave around it
    holidays = leave_holidays(scope, period, limit=UPCOMING_MAX, today=now)
    near = [
        h
        for h in holidays["upcoming"]
        if not h["isSunday"] and 0 <= h["daysUntil"] <= HOLIDAY_ALERT_DAYS and (h["aroundPeople"] or 0) >= HOLIDAY_ALERT_MIN_PEOPLE
    ]
    if near:
        h = near[0]
        when_text = "today" if h["daysUntil"] == 0 else f"in {days_text(h['daysUntil'])}"
        items.append(
            _item(
                "holiday",
                "info",
                f"{h['name']} is {when_text}, with {num(h['aroundPeople'])} people already on leave around it",
                f"{days_text(h['aroundDays'])} of approved leave on the working days before and after {weekday_date(date.fromisoformat(h['date']))}"
                + (" (a long weekend)." if h["joinsWeekend"] else "."),
                num(h["aroundPeople"]),
                f"How much leave is already approved around {h['name']}, and which departments will be short-staffed?",
            )
        )

    # balances
    year = period.end.year
    balances = leave_balances(scope, year, LIST_MAX, now)
    totals = balances["totals"]
    if totals["overdrawnEmployees"]:
        n = totals["overdrawnEmployees"]
        items.append(
            _item(
                "overdrawn",
                "warning" if n >= OVERDRAWN_WARN_PEOPLE else "info",
                f"{num(n)} {plural(n, 'person')} took more leave than {plural(n, 'was', 'were')} allocated in {year}",
                f"{days_text(totals['overdrawnDays'])} beyond allocation in all. The app does not stop leave beyond the allocation.",
                days_text(totals["overdrawnDays"]),
                f"Who has taken more leave than their {year} allocation, by how much, and how is it being treated in payroll?",
            )
        )
    if totals["ledgerMismatches"] >= LEDGER_WARN_ROWS:
        n = totals["ledgerMismatches"]
        items.append(
            _item(
                "ledger",
                "info",
                f"HR's leave balances disagree with approved requests for {num(n)} employee and leave-type pairs",
                f"{year}: the ledger is bumped on approval and never restored, so used days drift. The figures here are recomputed from the requests.",
                num(n),
                f"Why do HR's {year} leave balances not match the approved leave requests, and which are off by the most?",
            )
        )

    if leave and not any(i["severity"] in ("critical", "warning") for i in items):
        items.append(
            _item(
                "healthy",
                "good",
                f"No leave exceptions: {days_text(leave)} taken in {when}",
                "Nothing is waiting too long and no department, pattern or balance stands out.",
                days_text(leave),
                f"Summarise leave and holidays ({when}).",
            )
        )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


@cached()
def leave_attention(scope: Scope, period: Period, today: date | None = None) -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    items = _exceptions(scope, period, limit=6, today=today)
    thresholds = prov(
        "leave-attention",
        "Needs your attention",
        dataset="Leave requests, casual leave requests, leave balances, holidays, resignations",
        definition=(
            f"Requests waiting {PENDING_WARN_DAYS}+ days (critical from {PENDING_CRITICAL_DAYS}) or for dates already begun. "
            f"Leave moving {SPIKE_PCT:g}%+ and {SPIKE_MIN_DAYS:g}+ days against the previous period (critical from "
            f"{SPIKE_CRITICAL_PCT:g}%). A department with {GROUP_FLAG_RATIO:g}× the company's leave per employee, {GROUP_FLAG_MIN_DAYS:g}+ "
            f"days and {MIN_GROUP_HEADS}+ staff. Rejection from {REJECTION_WARN_PCT:g}% of {REJECTION_MIN_DECIDED}+ decided "
            f"requests. People out today from {OUT_TODAY_WARN_PCT:g}% of staff. Patterns: long leave without notice, repeat "
            "Monday and Friday leave, leave before a resignation. A holiday within "
            f"{HOLIDAY_ALERT_DAYS} days with {HOLIDAY_ALERT_MIN_PEOPLE}+ people on leave around it. People who took more than their allocation."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=_filters(scope, period),
        caveats=["These are rules of thumb: no leave target or limit is configured in the system."],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[thresholds])


def _recent(today: date | None) -> Period:
    """The last 30 days up to and including today (the Dashboard's window)."""
    now = today or D.today()
    return Period(now - timedelta(days=29), now, "last_30_days", "Last 30 days")


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3)."""
    now = today or D.today()
    return _exceptions(Scope(), _recent(now), limit=5, today=now)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's leave cards: people on leave today, leave days over the last 7 complete days against the 7 before
    (with a 14-day sparkline), and the leave requests waiting for a decision."""
    now = today or D.today()
    scope = Scope()
    end = now - timedelta(days=1)
    current = Period(end - timedelta(days=6), end, None, "Last 7 days")
    previous = current.previous()
    facts = D.load_facts(scope, previous.start, current.end)
    per_day: dict[date, float] = defaultdict(float)
    for _eid, day, weight, _type, _rid in facts.days:
        per_day[day] += weight
    spark = [round(per_day.get(d, 0.0), 1) for d in D.daterange(previous.start, current.end)]
    cur_days = round(sum(spark[7:]), 1)
    prev_days = round(sum(spark[:7]), 1)
    people = len({eid for eid, d, *_ in facts.between(current.start, current.end)})
    delta = change(cur_days, prev_days)

    today_ = leave_today(scope, now.isoformat(), 1, now)
    out = today_["outToday"]
    pending = _pending_stats(D.applications_pending(scope), now)
    window = f"{short_date(current.start)} to {short_date(current.end)}"
    kpis = [
        {
            "id": "leave.out-today",
            "label": "On leave today",
            "value": out["people"],
            "format": "number",
            "sub": (
                f"{pct_text(out['pct'], 0)} of staff · {num(today_['weekPeople'])} out at some point this week"
                if out["pct"] is not None
                else "No staff in the selection"
            ),
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
        {
            "id": "leave.days-7d",
            "label": "Leave days, last 7 days",
            "value": cur_days,
            "format": "number",
            "sub": f"{num(people)} {plural(people, 'employee', 'employees')} · {window}",
            "delta": {**delta, "good": None} if delta else None,
            "spark": spark,
            "page": PAGE,
        },
        {
            "id": "leave.pending",
            "label": "Leave requests waiting",
            "value": pending["count"],
            "format": "number",
            "sub": (
                f"The oldest has waited {days_text(pending['oldestDays'])}" if pending["count"] else "Nothing waiting"
            ),
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
    ]
    entries = _provenance(Scope(), current, rows={"requests": len(facts.reqs), "people": people})
    return {
        "kpis": kpis,
        "provenance": [*today_["provenance"], *_pick(entries, "leave-days"), _pending_provenance(scope, pending["count"])],
    }


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)

TOOLS = [
    tool(
        "leave_summary",
        "Leave for a period: days of approved leave taken, how many employees took leave, the leave rate (share of working "
        "days), days per employee, the leave requests applied for, the rejection rate and how many came without notice, each "
        "with the previous period for comparison, plus how many requests are waiting for a decision right now and how long "
        "the oldest has waited. Use for 'how much leave was taken', 'is leave going up', 'how many leave requests are "
        "pending'. Only approved leave counts, Sundays are not counted, a half day is 0.5, production staff are left out "
        "(attendance ignores their leave). Percentages are 0-100.",
        leave_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "leave_trend",
        "Leave days over time split by leave type (by day, week or month depending on the period) with the previous "
        "period lined up beside it, the busiest day, and a verdict on whether leave is rising or falling (last 7 days "
        "against the 7 before). Use for 'is leave rising', 'what happened to leave last month' and 'which week had the "
        "most leave'.",
        leave_trend,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "leave_breakdown",
        "Leave days ranked by leave type, by department or by unit: days, share of all leave, the previous period, people "
        "on leave and, for departments and units, days per employee and how it compares with the company average. Use for "
        "'which leave type is used most', 'which department takes the most leave' and 'compare units'. Small groups "
        "(fewer than 5 staff) are flagged.",
        leave_groups,
        page=PAGE,
        period="last_30_days",
        extra={
            "by": string_param("What to group by", enum=list(GROUP_BY)),
            "limit": _LIMIT,
        },
        defaults={"by": "type", "limit": LIST_DEFAULT},
    ),
    tool(
        "leave_who_is_out",
        "Who is on approved leave on one day (today by default; 'tomorrow', 'yesterday' or YYYY-MM-DD), with department, "
        "leave type and dates, how many are on half days, the share of staff, a department breakdown, the number out on "
        "each day of that week and how many people start leave in the next 7 days. Active staff only; reasons are never "
        "included. Use for 'who is on leave today', 'how many people are out this week' and 'who is away tomorrow'.",
        leave_today,
        page=PAGE,
        period=None,
        extra={
            "day": string_param("today, tomorrow, yesterday or a date YYYY-MM-DD"),
            "limit": _LIMIT,
        },
        defaults={"day": "today", "limit": LIST_DEFAULT},
    ),
    tool(
        "leave_balances_summary",
        "Yearly leave balances for the active staff: days allocated, days taken (recomputed from approved requests), days "
        "unused (the leave liability, in days not money), balances exhausted or running low, people who took more than "
        "they were allocated (named), days that carry over, and how far HR's balance ledger disagrees with the requests; by "
        "leave type and by department. Use for 'how much leave is unused', 'who has used up their leave' and 'what is "
        "our leave liability'. The year defaults to this year.",
        leave_balances,
        page=PAGE,
        period=None,
        extra={
            "year": integer_param("Calendar year (default this year)", minimum=2000, maximum=2100),
            "limit": _LIMIT,
        },
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "leave_patterns",
        "Unusual leave patterns in a period: leave by weekday (are Mondays and Fridays over-represented), people who take "
        "leave mostly on Mondays and Fridays, long leaves (3+ days) applied for on or after the first day (sick or other), "
        "people who took leave in the 30 days before a resignation, and people with many separate leaves. Each list names "
        "the people. Use for 'is anyone abusing leave', 'who takes Monday or Friday leave', 'long sick leave' and 'leave "
        "before resignation'. These are reasons to ask, not findings.",
        leave_patterns,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "leave_holidays_outlook",
        "The holiday calendar against leave: the next holidays (date, weekday, days away, whether it makes a long weekend) "
        "with the approved leave already on the working days before and after each, whether leave bunches around holidays "
        "(lift against an ordinary day), and the holidays in the period. Use for 'which holidays are coming up', 'will "
        "people take leave around the holiday' and 'do people extend holidays with leave'. Holidays apply to everyone.",
        leave_holidays,
        page=PAGE,
        period="last_90_days",
        extra={"limit": integer_param(f"How many upcoming holidays (default {UPCOMING_DEFAULT}, at most {UPCOMING_MAX})", minimum=1, maximum=UPCOMING_MAX)},
        defaults={"limit": UPCOMING_DEFAULT},
    ),
    tool(
        "leave_approvals",
        "The leave approval process: requests applied for in the period and what became of them (approved, rejected, "
        "waiting), the rejection rate overall and by leave type and department, how many came without notice, how long "
        "decisions take, and every request waiting right now with the oldest named (employee, dates, days waiting, who has "
        "approved so far). Use for 'what is waiting for approval', 'how long do leave approvals take' and 'how many leave "
        "requests are rejected'.",
        leave_approvals,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
]
