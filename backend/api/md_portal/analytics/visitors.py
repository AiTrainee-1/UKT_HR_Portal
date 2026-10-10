"""MD portal: Outpass & Visitors (pages ``outpass`` and ``visitors``, ``/api/md/visitors/*``).

The question this answers for the Managing Director: *who is coming into the premises, who is leaving during shift
hours, and is it under control?* It is about gate discipline and lost time, not a visitor register.

The HR "Outpass / Visitors / Tea Break" screen has one MD address for each subject, and this module serves the first two:
the **outpass** page (employees leaving during the shift) and the **visitors** page (people coming in). Both read the
same tables and the same endpoints; each finding and each card names the page it is about (``PAGE_OUTPASS`` /
``PAGE_VISITORS``) so the page shows its own half and links to the other. ``story`` writes each page's plain-English
summary and ``time_lost`` sets the time employees spend out on passes beside the tea-break minutes lost (tea_break.py).

Where the numbers come from, and the decisions that keep them honest
--------------------------------------------------------------------
* **Visitors**: ``VisitorVisit`` (one row per check-in on the reception QR form). The form records NO check-out and NO
  company, so "who is inside now", time on site and "by company" cannot be derived and are never shown. The visit's
  *purpose* is free text typed by the visitor: it is grouped into a few categories by the words in it
  (``PURPOSE_CATEGORIES``), always with an "Other" bucket, and the typed wording is available too.
* **Outpasses**: ``OutpassRequest`` (the employee's request, the approval, the gate exit and the gate return). The
  status rules, door-to-door duration and rounding are the Report Center's own
  (``reporting/definitions/gate_outpass_common``: ``pass_state``, ``minutes_between``, ``mean_minutes``), so a figure
  here equals the same figure there.
* **One population**: employee-requested passes (``source == "manual"``). A pass created by an approved On-Duty trip is
  official work, is born approved and is often never scanned, so it is *not* lost time: it is counted separately.
* **One anchor**: every pass is counted on the IST day it was *requested* (the Report Center's employee, department and
  purpose summaries do the same). The funnel, hours out and the trend therefore always add up to the same totals.
* **Hours out** = door to door, exit scan to return scan, for passes that were scanned back in. A pass with no return
  scan has no duration, so it is "never returned", never a guessed number.
* **Gate-form exits** (``OutpassRecord`` with ``source == "qr"``) are unverified self-reports with no approval and no
  return time. They are counted next to the passes and never mixed into them (the Report Center keeps them apart too).
* **Gate scans** (``OutpassGateScan``) show how often the gate refused someone (expired, not approved, already used).

Thresholds (what counts as "repeat", "long", "waiting too long", "after hours") are the named constants below. They are
echoed in the response and in the provenance, so the screen and the assistant quote the same rule.

Everything here only reads. ``@cached`` holds an answer for 60 seconds (off in tests).
"""

from __future__ import annotations

import math
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from django.db.models import Count, Max, Min, Q
from django.db.models.functions import ExtractHour, Lower, Trim, TruncDate
from django.utils import timezone

from ...clock import FACTORY_TZ
from ...models import Branch, OutpassGateScan, OutpassRecord, OutpassRequest, VisitorVisit
from ...reporting.definitions import gate_outpass_common as GO
from ...reporting.definitions import gate_visitor_tea_common as GV
from ...reporting.formatting import indian_number
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, parse_day, pct, period_for_preset, prov
from . import tea_break as tea

#: The MD pages this module's findings and cards belong to (md_portal/pages.py): a finding opens the page it is about.
PAGE_OUTPASS = "outpass"
PAGE_VISITORS = "visitors"

# ─── thresholds: named so the response and the provenance can show them ───────────────────────────────────────────

#: An employee with this many granted passes in 30 days is a "repeat outpass user" (scaled to the period, see
#: ``scaled_threshold``): three outings a month is the point where lost time stops being incidental.
REPEAT_OUTPASS_PER_30_DAYS = 3
#: ... and it is serious (critical) at this multiple of the threshold.
REPEAT_OUTPASS_CRITICAL_FACTOR = 2
#: A returned pass is "long" when it lasted at least this many minutes AND at least ``LONG_OUTPASS_FACTOR`` times the
#: typical (median) pass of the period. The floor stops a 40-minute pass being flagged when the median is 10 minutes.
LONG_OUTPASS_MIN_MINUTES = 120
LONG_OUTPASS_FACTOR = 2.0
#: Fewer returned passes than this and the median is not trustworthy: only the floor is used.
LONG_OUTPASS_MIN_SAMPLE = 5
#: A request still undecided after this many hours is "waiting too long" (critical after ``APPROVAL_CRITICAL_HOURS``).
APPROVAL_WAIT_HOURS = 24
APPROVAL_CRITICAL_HOURS = 72
#: Never-returned passes in the period from which the finding is critical rather than a warning.
NOT_RETURNED_CRITICAL = 5
#: ... and only when they are also at least this share of the passes whose outcome is known (a handful out of
#: thousands is a warning).
NOT_RETURNED_CRITICAL_PCT = 10.0
#: With at least this many closed passes and fewer than this share scanned back in, return scanning is probably not
#: in routine use.
LOW_RETURN_SCAN_MIN_PASSES = 10
LOW_RETURN_SCAN_PCT = 50.0
#: A visit is "after hours" when the check-in (IST) is before the start hour or from the end hour on.
VISIT_DAY_START_HOUR = 8
VISIT_DAY_END_HOUR = 18
#: A visitor with this many visits in 30 days is "unusually frequent" (scaled to the period like the outpass one).
FREQUENT_VISITOR_PER_30_DAYS = 4
#: A day is a visitor spike when it reaches this multiple of a typical (median) day AND this many visits.
SPIKE_FACTOR = 2.0
SPIKE_MIN_VISITS = 10
SPIKE_MIN_DAYS = 5
SPIKE_RECENT_DAYS = 7
#: The "good news" finding: hours out (or requests) fell at least this much against the previous period.
IMPROVEMENT_MIN_PCT = 15.0
IMPROVEMENT_MIN_MINUTES = 600
IMPROVEMENT_MIN_REQUESTS = 20
#: Past this many days the trend is rolled up to weeks (Monday to Sunday).
WEEKLY_AFTER_DAYS = 62
#: The activity feed merges three tables, so it only reads the first ``MAX_FEED_DEPTH`` rows of each: narrow the period
#: or search to go deeper.
MAX_FEED_DEPTH = 2000
MAX_LIST = 25
FEED_KINDS = ("all", "visits", "outpasses", "gate_form")

NO_DEPARTMENT = "No department"
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

NOTE_NO_CHECKOUT = (
    "Visitors are recorded at check-in only (there is no check-out), so who is inside right now and how long a visitor "
    "stayed cannot be shown."
)
NOTE_NO_COMPANY = (
    "The gate form does not ask for a company, so visits cannot be grouped by company: the person visited and the "
    "stated purpose are shown instead."
)

#: Why an outpass was taken. ``pass_type`` is the only structured reason (the written reason is free text).
REASONS = (
    ("official", "Official / mill duty"),
    ("personal", "Personal emergency"),
    ("early_dismissal", "Early shift dismissal"),
    ("unspecified", "Type not stated"),
)
REASON_LABEL = dict(REASONS)

#: Where a requested pass ended up (derived from the status and Report Center's pass state).
OUTCOME_LABELS = {
    "waiting": "Waiting for approval",
    "rejected": "Rejected",
    "approved_unused": "Approved, not used",
    "outside_now": "Outside now",
    "returned": "Returned",
    "not_returned": "Never returned",
    "early_dismissal": "Left early (dismissal)",
}

#: How long a returned pass lasted: (key, label, from minutes inclusive, to minutes exclusive).
DURATION_BUCKETS: tuple[tuple[str, str, int, int | None], ...] = (
    ("under_15", "Under 15 min", 0, 15),
    ("15_30", "15 to 30 min", 15, 30),
    ("30_60", "30 min to 1 hour", 30, 60),
    ("1_2h", "1 to 2 hours", 60, 120),
    ("2_4h", "2 to 4 hours", 120, 240),
    ("over_4h", "4 hours or more", 240, None),
)

SCAN_REFUSAL_LABELS = {
    "already_scanned": "Pass already used",
    "expired": "Pass expired",
    "not_approved": "Request not approved",
    "not_exited": "Return scanned before any exit",
    "invalid_qr": "Unreadable or invalid QR",
}

#: Visit purpose categories, checked in this order (the first match wins; anything else is "Other"). A keyword of up to
#: three letters must match a whole word ("pf", "tax"); a longer one matches the start of a word ("deliver" finds
#: "delivery" and "delivering"). The visitor types the purpose freely, so this is a reading aid, not a field.
PURPOSE_CATEGORIES: tuple[tuple[str, str, tuple[str, ...]], ...] = tuple(
    (key, label, tuple(word.replace("_", " ") for word in words.split()))
    for key, label, words in (
        (
            "interview",
            "Interview or job enquiry",
            "interview job vacan recruit hiring resume candidate joining placement",
        ),
        (
            "delivery",
            "Delivery or transport",
            "deliver courier parcel dispatch transport lorry truck vehicle load unload pickup pick_up shipment "
            "consignment goods cargo driver",
        ),
        (
            "audit",
            "Audit, inspection or officials",
            "audit inspect complian government govt officer esi pf labour labor tax gst certif licen fire safety "
            "pollution customs",
        ),
        (
            "buyer",
            "Buyer or merchandising",
            "buyer buying merchandis sampl order brand sourcing tech_pack techpack",
        ),
        (
            "supplier",
            "Supplier, vendor or sales",
            "supplier vendor sales marketing quotation quote demo trims fabric yarn thread accessor material price "
            "purchas product catalog enquiry inquiry stock dealer representative",
        ),
        (
            "service",
            "Service or maintenance",
            "servic repair maintenan technician engineer electric plumb install machine amc contractor civil "
            "construction paint fitting welding calibrat pest cleaning",
        ),
        (
            "payment",
            "Payment or accounts",
            "payment pay invoice bill cheque account ledger bank loan collection outstanding balance money salary",
        ),
        (
            "personal",
            "Family, friend or personal",
            "family relative wife husband mother father brother sister son daughter friend personal uncle aunt "
            "cousin child kid parent",
        ),
        (
            "meeting",
            "Meeting or discussion",
            "meeting meet discuss appointment review presentation training visit call talk",
        ),
    )
)
OTHER_PURPOSE = ("other", "Other (not matched)")


def _keyword_pattern(words: tuple[str, ...]) -> re.Pattern[str]:
    """Short words match as whole words (and their plural), longer ones as the start of a word."""
    parts = [rf"\b{re.escape(w)}s?\b" if len(w) <= 3 else rf"\b{re.escape(w)}" for w in words]
    return re.compile("|".join(parts), re.IGNORECASE)


_PURPOSE_PATTERNS = tuple((key, label, _keyword_pattern(words)) for key, label, words in PURPOSE_CATEGORIES)
PURPOSE_LABEL = {key: label for key, label, _ in PURPOSE_CATEGORIES} | {OTHER_PURPOSE[0]: OTHER_PURPOSE[1]}


def classify_purpose(text: str | None) -> tuple[str, str]:
    """(category key, label) for what a visitor typed as the purpose of the visit."""
    value = (text or "").strip()
    for key, label, pattern in _PURPOSE_PATTERNS:
        if pattern.search(value):
            return key, label
    return OTHER_PURPOSE


# ─── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────


def _now() -> datetime:
    """The instant "now" (aware, UTC). One seam, so a test can pin the clock by patching this function."""
    return timezone.now()


def _clock(today: date | None = None) -> tuple[datetime, date]:
    """(now, factory date). With no ``today``, or today's real date, the real clock; for another date (a test, a
    back-dated call) the end of that factory day, so ages and "outside now" are evaluated as of then."""
    real = _now()
    real_today = GO.ist_date(real)
    if today is None or today == real_today:
        return real, real_today
    return datetime.combine(today, time(23, 59, 59), tzinfo=FACTORY_TZ), today


def _bounds(period: Period) -> tuple[datetime, datetime]:
    """[first day 00:00 IST, day after the last day 00:00 IST): the instants an aware timestamp is filtered on."""
    lo, hi = GV.ist_bounds(period.start, period.end)
    assert lo is not None and hi is not None
    return lo, hi


def _stamp(value: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if value is None:
        return None
    return value.astimezone(FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def _person(first: Any, last: Any) -> str:
    return GV.person_name(first, last)


def _text(value: Any, limit: int = 120) -> str | None:
    return GO.clean(value, limit)


def _round1(value: float | None) -> float | None:
    return None if value is None else round(value, 1)


def _metric(current: float | int | None, previous: float | int | None) -> dict:
    """A figure with its previous-period twin and the change between them (None when either is missing)."""
    return {"value": current, "previous": previous, "change": change(current, previous)}


def _hm(minutes: float | int | None) -> str:
    """Minutes as the screens write them: "45m", "2h 05m"."""
    if minutes is None:
        return "—"
    m = int(round(minutes))
    return f"{m}m" if m < 60 else f"{m // 60}h {m % 60:02d}m"


def _wait_text(minutes: int | None) -> str:
    """How long something has waited, for a sentence: "35 minutes", "5 hours", "3 days 4 hours"."""
    if minutes is None:
        return "—"
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    if minutes < 48 * 60:
        hours = minutes // 60
        return f"{hours} hour{'s' if hours != 1 else ''}"
    days, rest = divmod(minutes, 24 * 60)
    hours = rest // 60
    return f"{days} days" + (f" {hours} hour{'s' if hours != 1 else ''}" if hours else "")


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _clock_label(hour: int) -> str:
    """6 -> "6:00 am", 18 -> "6:00 pm"."""
    return f"{hour % 12 or 12}:00 {'am' if hour < 12 else 'pm'}"


def _hour_label(hour: int) -> str:
    return f"{hour:02d}:00–{hour:02d}:59"


def scaled_threshold(per_30_days: int, days: int) -> int:
    """A "this many in 30 days" rule scaled to a period: 3 a month is 3 in a week or a month, 9 in a quarter. Half
    rounds up and the base figure is the minimum, so a short period never makes the bar easier than the rule."""
    return max(per_30_days, math.floor(per_30_days * days / 30 + 0.5))


_WHEN = {
    "today": "today",
    "yesterday": "yesterday",
    "last_7_days": "in the last 7 days",
    "last_30_days": "in the last 30 days",
    "last_90_days": "in the last 90 days",
    "this_week": "this week",
    "last_week": "last week",
    "this_month": "this month",
    "last_month": "last month",
    "last_12_months": "in the last 12 months",
    "this_year": "this year",
    "this_fy": "this financial year",
}


def _when(period: Period) -> str:
    """The period as it reads inside a sentence: "in the last 30 days", "this month", "between 01 Sep – 15 Sep 2026"."""
    if period.preset in _WHEN:
        return _WHEN[period.preset]
    if period.preset == "month":
        return f"in {period.label}"
    return f"on {period.label}" if period.days == 1 else f"between {period.label}"


def int_param(params: dict, name: str, default: int, lo: int, hi: int) -> int:
    """An integer query parameter, kept inside [lo, hi]. A value that is not a whole number is a 400 (MdParamError)."""
    raw = params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.") from None
    return max(lo, min(hi, value))


def _median_minutes(values: list[int]) -> int | None:
    """The median of whole minutes, halves rounded up (the Report Center's rule)."""
    if not values:
        return None
    return math.floor(statistics.median(values) + 0.5)


def _scope_notes(scope: Scope) -> list[str]:
    notes: list[str] = []
    if scope.department_ids or scope.employment_type:
        who = "department" if scope.department_ids else "staff or production filter"
        notes.append(
            f"Visits are narrowed by the person visited: while a {who} is chosen, only visits whose host was matched "
            "to an employee can be included. Visits to a host typed as free text, and gate-form exits that match no "
            "employee, are left out."
        )
    return notes


def _return_scan_note(returned: int, not_returned: int, rate: float | None) -> list[str]:
    """When most passes that left were never scanned back in, the likelier story is that return scanning is not in
    routine use, not that most employees vanished: say so, so "never returned" is read as "return not scanned"."""
    if rate is None or returned + not_returned < LOW_RETURN_SCAN_MIN_PASSES or rate >= LOW_RETURN_SCAN_PCT:
        return []
    return [
        f"Only {rate:g}% of the passes that left were scanned back in, so hours out and the return rate rest on few "
        "passes. Return scanning may not be in routine use: read 'never returned' as 'return not scanned'."
    ]


# ─── visits ───────────────────────────────────────────────────────────────────────────────────────────────────────


def _visit_scope_q(scope: Scope) -> Q:
    """A visit belongs to the unit whose QR was scanned; a department or staff/production filter can only be answered
    through the employee the visitor came to see (a free-text host has none), exactly as the Report Center does."""
    q = Q()
    if scope.branch_ids:
        q &= Q(branch_id__in=scope.branch_ids)
    if scope.department_ids:
        q &= Q(meeting_employee__department_id__in=scope.department_ids)
    if scope.employment_type:
        q &= Q(meeting_employee__employment_type=scope.employment_type)
    return q


def _visit_qs(scope: Scope, period: Period):
    lo, hi = _bounds(period)
    return VisitorVisit.objects.filter(_visit_scope_q(scope), visited_at__gte=lo, visited_at__lt=hi).order_by()


def _hour_expr():
    return ExtractHour("visited_at", tzinfo=FACTORY_TZ)


def _after_hours_q() -> Q:
    return Q(h__lt=VISIT_DAY_START_HOUR) | Q(h__gte=VISIT_DAY_END_HOUR)


def _visit_cells(qs) -> list[tuple[date, int, int]]:
    """(IST day, IST hour, visits) for every hour that had a visit: the one grouped query behind the daily series, the
    busiest hour and day, the weekday x hour heatmap and the after-hours count."""
    rows = (
        qs.annotate(d=TruncDate("visited_at", tzinfo=FACTORY_TZ), h=_hour_expr())
        .values("d", "h")
        .annotate(n=Count("id"))
        .order_by()
    )
    return [(r["d"], r["h"], r["n"]) for r in rows]


def _visit_totals(qs) -> dict:
    """visits, unique visitors, repeat visitors (2+ visits) and after-hours visits from ONE grouped query (one row per
    visitor), so the previous period costs a single query too."""
    rows = (
        qs.annotate(h=_hour_expr())
        .values("visitor_id")
        .annotate(n=Count("id"), after=Count("id", filter=_after_hours_q()))
        .order_by()
    )
    counts = [(r["n"], r["after"]) for r in rows]
    repeaters = [n for n, _ in counts if n >= 2]
    return {
        "visits": sum(n for n, _ in counts),
        "unique": len(counts),
        "repeatVisitors": len(repeaters),
        "repeatVisits": sum(repeaters),
        "afterHours": sum(a for _, a in counts),
    }


def _peaks(cells: list[tuple[date, int, int]]) -> tuple[dict | None, dict | None]:
    """The busiest hour of the day and the busiest date (the earlier one wins a tie, as in the Report Center)."""
    if not cells:
        return None, None
    per_hour: Counter = Counter()
    per_day: Counter = Counter()
    for d, h, n in cells:
        per_hour[h] += n
        per_day[d] += n
    hour, hour_n = max(per_hour.items(), key=lambda kv: (kv[1], -kv[0]))
    day, day_n = max(per_day.items(), key=lambda kv: (kv[1], -kv[0].toordinal()))
    return (
        {"hour": hour, "label": _hour_label(hour), "visits": hour_n},
        {"date": day.isoformat(), "weekday": WEEKDAYS[day.weekday()], "visits": day_n},
    )


def _daily_visits(cells: list[tuple[date, int, int]]) -> dict[date, int]:
    out: dict[date, int] = defaultdict(int)
    for d, _h, n in cells:
        out[d] += n
    return out


def _heatmap(cells: list[tuple[date, int, int]]) -> dict:
    values = [[0] * 24 for _ in range(7)]
    for d, h, n in cells:
        values[d.weekday()][h] += n
    flat = [v for row in values for v in row]
    return {"weekdays": list(WEEKDAYS), "hours": list(range(24)), "values": values, "max": max(flat) if flat else 0}


# ─── outpasses ────────────────────────────────────────────────────────────────────────────────────────────────────

PASS_VALUES = (
    "id",
    "employee_id",
    "employee__employee_code",
    "employee__first_name",
    "employee__last_name",
    "employee__department__name",
    "employee__branch_id",
    "status",
    "source",
    "pass_type",
    "destination",
    "created_at",
    "approved_at",
    "exited_at",
    "entered_at",
    "return_qr_generated_at",
    "expected_return_at",
)


@dataclass(frozen=True, slots=True)
class PassFact:
    """One requested pass with the figures every card needs, worked out once."""

    row: dict
    state: str  # the Report Center's pass state (gate_outpass_common.pass_state)
    outcome: str  # key of OUTCOME_LABELS
    minutes: int | None  # door to door; only for a pass that was scanned back in
    reason: str  # key of REASON_LABEL


def _reason_key(row: dict) -> str:
    return row["pass_type"] if row["pass_type"] in REASON_LABEL else "unspecified"


def _outcome(row: dict, state: str) -> str:
    status = row["status"]
    if status == "pending":
        return "waiting"
    if status == "rejected":
        return "rejected"
    return {
        "completed": "returned",
        "not_returned": "not_returned",
        "early_dismissal": "early_dismissal",
        "exited": "outside_now",
        "pending_return": "outside_now",
        "return_expired": "outside_now",
    }.get(state, "approved_unused")


def _pass_rows(scope: Scope, period: Period) -> list[dict]:
    """Every pass requested in the period for the people in scope: ONE query, plain dicts, department name joined."""
    lo, hi = _bounds(period)
    qs = OutpassRequest.objects.filter(scope.employee_q("employee__"), created_at__gte=lo, created_at__lt=hi)
    return list(qs.order_by().values(*PASS_VALUES))


def _facts(rows: list[dict], now: datetime, today: date) -> tuple[list[PassFact], int]:
    """(the employee-requested passes, how many On-Duty passes were left out). The state is the Report Center's."""
    out: list[PassFact] = []
    on_duty = 0
    for row in rows:
        if row["source"] != "manual":
            on_duty += 1
            continue
        state = GO.pass_state(GO.as_pass(row), now, today)
        out.append(
            PassFact(
                row=row,
                state=state,
                outcome=_outcome(row, state),
                minutes=GO.minutes_between(row["exited_at"], row["entered_at"]),
                reason=_reason_key(row),
            )
        )
    return out, on_duty


def _emp(row: dict) -> dict:
    """The standard person keys the assistant's privacy layer recognises."""
    return {
        "employeeId": row["employee_id"],
        "name": _person(row["employee__first_name"], row["employee__last_name"]),
        "code": row["employee__employee_code"],
        "department": row["employee__department__name"] or NO_DEPARTMENT,
    }


def _pass_metrics(facts: list[PassFact]) -> dict:
    """The headline figures of a set of requested passes (see the module docstring for what each means)."""
    approved = sum(1 for f in facts if f.row["status"] == "approved")
    rejected = sum(1 for f in facts if f.row["status"] == "rejected")
    pending = sum(1 for f in facts if f.row["status"] == "pending")
    returned = sum(1 for f in facts if f.row["entered_at"] is not None)
    not_returned = sum(1 for f in facts if f.outcome == "not_returned")
    minutes = [f.minutes for f in facts if f.minutes is not None]
    turnaround = [
        max(0.0, (f.row["approved_at"] - f.row["created_at"]).total_seconds())
        for f in facts
        if f.row["status"] == "approved" and f.row["approved_at"] is not None
    ]
    decided = approved + rejected
    return {
        "requests": len(facts),
        "approved": approved,
        "rejected": rejected,
        "pending": pending,
        "rejectionRatePct": pct(rejected, decided),
        "left": sum(1 for f in facts if f.row["exited_at"] is not None),
        "returned": returned,
        "notReturned": not_returned,
        "earlyDismissals": sum(1 for f in facts if f.outcome == "early_dismissal"),
        "returnRatePct": pct(returned, returned + not_returned),
        "measured": len(minutes),
        "minutesOut": sum(minutes) if minutes else None,
        "avgMinutesOut": GO.mean_minutes(minutes),
        "turnaroundCount": len(turnaround),
        "turnaroundAvg": GO.half_up_minutes(sum(turnaround) / len(turnaround)) if turnaround else None,
        "turnaroundMedian": GO.half_up_minutes(statistics.median(turnaround)) if turnaround else None,
    }


def _hours(minutes: int | None) -> float | None:
    return None if minutes is None else round(minutes / 60, 1)


def _waiting_snapshot(scope: Scope, now: datetime) -> dict:
    """Employee requests nobody has decided yet, as of now and across ALL dates: a request that has waited three weeks
    is the worst case, so the period filter must not hide it. Ages use the Report Center's bands."""
    h1, h4, h24 = now - timedelta(hours=1), now - timedelta(hours=4), now - timedelta(hours=APPROVAL_WAIT_HOURS)
    qs = OutpassRequest.objects.filter(
        scope.employee_q("employee__"), status="pending", source="manual", created_at__lte=now
    ).order_by()
    agg = qs.aggregate(
        total=Count("id"),
        oldest=Min("created_at"),
        under_1h=Count("id", filter=Q(created_at__gt=h1)),
        h1_4=Count("id", filter=Q(created_at__lte=h1, created_at__gt=h4)),
        h4_24=Count("id", filter=Q(created_at__lte=h4, created_at__gte=h24)),
        over_24=Count("id", filter=Q(created_at__lt=h24)),
    )
    return {
        "waiting": agg["total"],
        "overOneDay": agg["over_24"],
        "oldestMinutes": GO.minutes_between(agg["oldest"], now) if agg["oldest"] else None,
        "buckets": [
            {"key": "under_1h", "label": "Under 1 hour", "count": agg["under_1h"]},
            {"key": "1_4h", "label": "1 to 4 hours", "count": agg["h1_4"]},
            {"key": "4_24h", "label": "4 to 24 hours", "count": agg["h4_24"]},
            {"key": "over_24h", "label": "Over 24 hours", "count": agg["over_24"]},
        ],
    }


def _outside_now(scope: Scope, now: datetime, today: date) -> int:
    """Employees who left today on a pass and have not been scanned back in (early dismissals do not return)."""
    start = datetime.combine(today, time.min, tzinfo=FACTORY_TZ)
    qs = OutpassRequest.objects.filter(
        scope.employee_q("employee__"),
        source="manual",
        exited_at__gte=start,
        exited_at__lte=now,
        entered_at__isnull=True,
    ).exclude(pass_type="early_dismissal")
    return qs.order_by().count()


# gate-form exits and gate scans


def _gate_form_qs(scope: Scope, period: Period):
    """The anonymous QR exit form (``OutpassRecord`` with source "qr"). Its branch is the QR's; a department or
    staff/production filter needs the matched employee, so unmatched submissions drop out while one is set."""
    lo, hi = _bounds(period)
    qs = OutpassRecord.objects.filter(source="qr", submitted_at__gte=lo, submitted_at__lt=hi)
    if scope.branch_ids:
        qs = qs.filter(branch_id__in=scope.branch_ids)
    if scope.department_ids:
        qs = qs.filter(employee__department_id__in=scope.department_ids)
    if scope.employment_type:
        qs = qs.filter(employee__employment_type=scope.employment_type)
    return qs.order_by()


def _scan_scope_q(scope: Scope) -> Q:
    """A scan belongs to a unit through its gate OR its employee (the Report Center's rule); a forged QR has neither."""
    q = Q()
    if scope.branch_ids:
        q &= Q(gate__branch_id__in=scope.branch_ids) | Q(employee__branch_id__in=scope.branch_ids)
    if scope.department_ids:
        q &= Q(employee__department_id__in=scope.department_ids)
    if scope.employment_type:
        q &= Q(employee__employment_type=scope.employment_type)
    return q


def _scan_stats(scope: Scope, period: Period) -> dict:
    lo, hi = _bounds(period)
    rows = (
        OutpassGateScan.objects.filter(_scan_scope_q(scope), scanned_at__gte=lo, scanned_at__lt=hi)
        .order_by()
        .values("gate__name", "scan_type", "result")
        .annotate(n=Count("id"))
    )
    gates: dict[str, dict] = {}
    refusals: Counter = Counter()
    attempts = successful = 0
    for r in rows:
        name = r["gate__name"] or "Unknown gate"
        g = gates.setdefault(name, {"gate": name, "exits": 0, "returns": 0, "refused": 0})
        attempts += r["n"]
        if r["result"] == "success":
            successful += r["n"]
            g["exits" if r["scan_type"] == "exit" else "returns"] += r["n"]
        else:
            g["refused"] += r["n"]
            refusals[r["result"]] += r["n"]
    refused = attempts - successful
    return {
        "attempts": attempts,
        "successful": successful,
        "refused": refused,
        "refusedPct": pct(refused, attempts),
        "byReason": [
            {"key": key, "label": SCAN_REFUSAL_LABELS.get(key, key), "count": n}
            for key, n in sorted(refusals.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "byGate": sorted(gates.values(), key=lambda g: (-(g["exits"] + g["returns"] + g["refused"]), g["gate"])),
    }


# ─── provenance (the same entries the screen's "How is this calculated?" and the assistant quote) ─────────────────


def _p_visits(rows: int | None, scope: Scope) -> dict:
    filters = ["Check-in time, factory (IST) calendar days, both ends included"]
    if scope.branch_ids:
        filters.append("Only the chosen unit's gate QR")
    if scope.department_ids or scope.employment_type:
        filters.append("Only visits matched to an employee of the chosen department or type")
    return prov(
        "visits",
        "Visits and unique visitors",
        dataset="Visitor check-ins (gate and reception QR form)",
        definition="A visit is one check-in; a visitor who comes three times adds three visits and counts once as a "
        "unique visitor. Same data as the Report Center's Visitor Register and Visitor Daily Summary.",
        formula="visits = check-ins in the period · unique visitors = distinct visitors among them",
        rows=rows,
        filters=filters,
        caveats=[
            NOTE_NO_CHECKOUT,
            "A visitor is identified by the exact phone number typed at the gate: one person typed with and without "
            "+91 counts as two visitors.",
        ],
    )


def _p_peak(rows: int | None) -> dict:
    return prov(
        "peak",
        "Busiest hour and day",
        dataset="Visitor check-ins",
        definition="The hour of the day (all days added together) and the single date with the most check-ins; the "
        "earlier one wins a tie.",
        formula="peak hour = max over hours of visits · peak day = max over dates of visits",
        rows=rows,
    )


def _p_after_hours(rows: int | None) -> dict:
    return prov(
        "after-hours",
        "After-hours visits",
        dataset="Visitor check-ins",
        definition=f"Check-ins before {_clock_label(VISIT_DAY_START_HOUR)} or from {_clock_label(VISIT_DAY_END_HOUR)} "
        "on (factory time). The window is a fixed setting, not each unit's shift.",
        formula=f"visits with hour < {VISIT_DAY_START_HOUR} or hour ≥ {VISIT_DAY_END_HOUR}",
        rows=rows,
        caveats=["Weekly offs and holidays are not treated as after hours: see the busiest-times grid."],
    )


def _p_repeat_visitors(rows: int | None, minimum: int) -> dict:
    return prov(
        "repeat-visitors",
        "Repeat visitors",
        dataset="Visitor check-ins",
        definition="Visitors who checked in more than once in the period. Same idea as the Report Center's Repeat "
        "Visitor Report.",
        formula="visitors with 2 or more visits in the period",
        rows=rows,
        filters=[f"'Unusually frequent' means {minimum} or more visits in this period"],
    )


def _p_purposes(rows: int | None) -> dict:
    return prov(
        "purposes",
        "Why visitors came",
        dataset="Visitor check-ins (the purpose typed at the gate)",
        definition="The purpose is free text, so each visit is placed in a category by the words in it (interview, "
        "delivery, audit, buyer, supplier or sales, service, payment, family, meeting). Anything that matches "
        "none is Other; the first matching category wins.",
        formula="count of visits per category (matched on words, ignoring capitals)",
        rows=rows,
        caveats=["A reading aid, not a field the visitor chose: check the 'Other' wording to see what is missed."],
    )


def _p_hosts(rows: int | None) -> dict:
    return prov(
        "hosts",
        "Who visitors came to meet",
        dataset="Visitor check-ins (person met, matched to an employee by phone where possible)",
        definition="A host is the employee the gate form matched, or, when it could not, the name typed. Host "
        "department is the matched employee's current department; free-text hosts have none.",
        formula="visits grouped by host and by host department",
        rows=rows,
        caveats=[NOTE_NO_COMPANY, "Two spellings of one person typed as free text count as two hosts."],
    )


def _p_heatmap(rows: int | None) -> dict:
    return prov(
        "heatmap",
        "Busiest times",
        dataset="Visitor check-ins",
        definition="Check-ins by weekday and hour of the day (factory time), all weeks in the period added together.",
        formula="visits per (weekday, hour)",
        rows=rows,
    )


def _p_passes(rows: int | None, on_duty: int | None = None) -> dict:
    notes = [
        "On-Duty trips are official work, are approved automatically and are often never scanned, so they are not "
        "counted here" + (f" ({on_duty} in this period)." if on_duty else "."),
    ]
    return prov(
        "passes",
        "Outpass requests",
        dataset="Outpass requests (employee-initiated passes, HR Outpass page)",
        definition="Every request an employee made to leave during the shift, counted on the day it was requested. "
        "Approved, rejected and pending are its current status.",
        formula="requests created in the period · approved + rejected + pending = requests",
        rows=rows,
        filters=["Employee-requested passes only", "Scope applies to the employee's unit, department and type"],
        caveats=notes,
    )


def _p_approvals(rows: int | None) -> dict:
    return prov(
        "approvals",
        "Rejection rate and approvals",
        dataset="Outpass requests",
        definition="Of the requests that were decided, the share that was rejected. Requests still waiting are left "
        "out of the rate.",
        formula="rejected ÷ (approved + rejected) × 100",
        rows=rows,
    )


def _p_turnaround(rows: int | None) -> dict:
    return prov(
        "turnaround",
        "Approval time",
        dataset="Outpass requests",
        definition="How long approved requests waited for a decision (request time to approval time). Same rule as "
        "the Report Center's Outpass Approval Turnaround.",
        formula="approval time − request time, averaged (and the median) over approved requests",
        rows=rows,
        caveats=["A rejection stores no decision time, so rejected requests are not in this figure."],
    )


def _p_hours_out(rows: int | None) -> dict:
    return prov(
        "hours-out",
        "Hours out",
        dataset="Outpass requests with a gate exit and a gate return scan",
        definition="Time employees spent outside the gate on a pass, door to door: exit scan to return scan, for "
        "passes that were scanned back in. Minutes are rounded per pass (halves up) and added up, as in the Report "
        "Center's Outpass Summary by Department.",
        formula="sum of (return scan − exit scan) over returned passes · average = that sum ÷ returned passes",
        rows=rows,
        caveats=[
            "A pass with no return scan has no duration, so its time is not in this total: see 'never returned'.",
            "It is production time away from the line whether the pass is personal or official; the reasons card "
            "splits them.",
        ],
    )


def _p_return_rate(rows: int | None) -> dict:
    return prov(
        "return-rate",
        "Return rate",
        dataset="Outpass requests with a gate exit",
        definition="Of the passes whose outcome is known, the share scanned back in. Someone who left today and may "
        "still return, and an early-shift-dismissal pass (not expected back), are not counted either way.",
        formula="returned ÷ (returned + never returned) × 100",
        rows=rows,
        caveats=[
            "'Never returned' means no return scan on a later day: the employee may have gone home or the return "
            "scan was missed."
        ],
    )


def _p_funnel(rows: int | None) -> dict:
    return prov(
        "funnel",
        "From request to return",
        dataset="Outpass requests",
        definition="The life of the requests made in the period: requested, approved, left through the gate, scanned "
        "back in. The side figures show where the rest went.",
        formula="requested → approved → left → returned",
        rows=rows,
        caveats=["Approved but never used: the pass window closed (60 minutes after approval) with no exit scan."],
    )


def _p_departments(rows: int | None) -> dict:
    return prov(
        "departments",
        "Hours out by department",
        dataset="Outpass requests, employees and departments",
        definition="Hours out and requests by the employee's CURRENT department (a department name that exists in "
        "several units is one department). Per 100 staff uses today's active headcount.",
        formula="hours out = sum of returned-pass minutes · per 100 staff = requests × 100 ÷ active headcount",
        rows=rows,
        caveats=[
            "Headcount is today's, not the headcount of the period, so per-100 figures for old periods are indicative."
        ],
    )


def _p_reasons(rows: int | None) -> dict:
    return prov(
        "reasons",
        "Why people leave",
        dataset="Outpass requests (pass type)",
        definition="The pass type the employee chose: official / mill duty, personal emergency, early shift dismissal. "
        "The written reason and destination are free text and are not grouped.",
        formula="requests (and hours out) per pass type",
        rows=rows,
        caveats=["Requests with no pass type (older requests) are shown as 'Type not stated'."],
    )


def _p_durations(rows: int | None) -> dict:
    return prov(
        "durations",
        "How long people stay out",
        dataset="Outpass requests with a gate exit and return",
        definition="Returned passes by door-to-door duration.",
        formula="count of returned passes per duration band",
        rows=rows,
    )


def _p_waiting(rows: int | None) -> dict:
    return prov(
        "waiting",
        "Requests waiting for a decision",
        dataset="Outpass requests",
        definition="Employee requests that are still pending right now, by how long they have waited. This is a "
        "live snapshot across all dates, not limited to the period: an old undecided request is the worst case.",
        formula="pending requests grouped by (now − request time)",
        rows=rows,
        filters=[f"'Too long' means more than {APPROVAL_WAIT_HOURS} hours"],
    )


def _p_gate_scans(rows: int | None) -> dict:
    return prov(
        "gate-scans",
        "Gate scans",
        dataset="Gate scan log (every exit and return QR scan, successful or refused)",
        definition="How often the gate accepted or refused a scan in the period, and why. Same data as the Report "
        "Center's Gate Scan Audit Log and Gate Activity Summary.",
        formula="refused = scans that were not 'success' · refused % = refused ÷ all scans × 100",
        rows=rows,
        caveats=["A failed tea-break scan is logged as 'Invalid QR', so that reason also holds some tea-break scans."],
    )


def _p_gate_form(rows: int | None) -> dict:
    return prov(
        "gate-form",
        "Gate-form exits",
        dataset="Exit form submissions (QR form at the gate)",
        definition="Anonymous exits logged by typing a name and employee code on the gate form. Unverified: no "
        "approval, no return time, no duration. Counted next to the passes, never mixed into them.",
        formula="count of form submissions in the period",
        rows=rows,
    )


def _p_trend(rows: int | None, weekly: bool) -> dict:
    return prov(
        "trend",
        "Trend",
        dataset="Visitor check-ins, outpass requests, exit-form submissions",
        definition="Visits by check-in day; passes, exits and hours out by the day the pass was requested; "
        + ("rolled up to weeks (Monday to Sunday) because the period is long." if weekly else "one point per day."),
        formula="per day (or week): visits, requests, left, returned, minutes out",
        rows=rows,
        caveats=["The first and last week of a long period can be partial: each point says how many days it covers."]
        if weekly
        else [],
    )


def _p_thresholds(period: Period, long_minutes: int, median: int | None) -> dict:
    repeat = scaled_threshold(REPEAT_OUTPASS_PER_30_DAYS, period.days)
    frequent = scaled_threshold(FREQUENT_VISITOR_PER_30_DAYS, period.days)
    return prov(
        "exceptions",
        "What counts as an exception",
        dataset="Outpass requests, visitor check-ins",
        definition=(
            f"Repeat outpass user: {repeat} or more approved passes ({REPEAT_OUTPASS_PER_30_DAYS} in 30 days, scaled "
            f"to this period). Long outpass: at least {long_minutes} minutes, i.e. the longer of "
            f"{LONG_OUTPASS_MIN_MINUTES} minutes and {LONG_OUTPASS_FACTOR:g}× the typical pass"
            + (f" ({_hm(median)})" if median is not None else "")
            + f". Waiting too long: undecided for more than {APPROVAL_WAIT_HOURS} hours. After hours: check-in before "
            f"{_clock_label(VISIT_DAY_START_HOUR)} or from {_clock_label(VISIT_DAY_END_HOUR)}. Frequent visitor: "
            f"{frequent} or more visits."
        ),
        formula=None,
        caveats=["These are fixed rules for flagging, not company policy: they are named settings in the code."],
    )


def _p_units(rows: int | None) -> dict:
    return prov(
        "units",
        "Unit by unit",
        dataset="Visitor check-ins, outpass requests, employees",
        definition="Visits by the unit whose gate QR was scanned; outpasses by the employee's own unit. Per 100 staff "
        "uses today's active headcount of the unit.",
        formula="requests per 100 staff = requests × 100 ÷ active headcount of the unit",
        rows=rows,
        caveats=[
            "A department or staff/production filter narrows visits to hosts of that kind, so unit visit counts then "
            "cover only visits matched to an employee."
        ],
    )


def _p_activity() -> dict:
    return prov(
        "activity",
        "Recent activity",
        dataset="Visitor check-ins, outpass requests, exit-form submissions",
        definition="The newest records first. A visit is dated by check-in; an outpass by the time it was requested; a "
        "gate-form exit by its submission. On-Duty trips are not listed.",
        formula=None,
        caveats=[NOTE_NO_CHECKOUT],
    )


# ─── summary ──────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def summary(scope: Scope, period: Period) -> dict:
    """The headline figures of the page, each with the previous period of the same length beside it."""
    now, today = _clock()
    previous = period.previous()

    cur_qs, prev_qs = _visit_qs(scope, period), _visit_qs(scope, previous)
    cells = _visit_cells(cur_qs)
    v, pv = _visit_totals(cur_qs), _visit_totals(prev_qs)
    peak_hour, peak_day = _peaks(cells)

    cur_facts, cur_on_duty = _facts(_pass_rows(scope, period), now, today)
    prev_facts, prev_on_duty = _facts(_pass_rows(scope, previous), now, today)
    c, p = _pass_metrics(cur_facts), _pass_metrics(prev_facts)
    waiting = _waiting_snapshot(scope, now)
    cur_forms, prev_forms = _gate_form_qs(scope, period).count(), _gate_form_qs(scope, previous).count()

    def m(key: str, a: dict, b: dict) -> dict:
        return _metric(a[key], b[key])

    visitors = {
        "visits": m("visits", v, pv),
        "uniqueVisitors": m("unique", v, pv),
        "repeatVisitors": m("repeatVisitors", v, pv),
        "afterHours": m("afterHours", v, pv),
        "avgPerDay": _metric(_round1(v["visits"] / period.days), _round1(pv["visits"] / previous.days)),
        "peakHour": peak_hour,
        "peakDay": peak_day,
    }
    outpass = {
        "requests": m("requests", c, p),
        "approved": m("approved", c, p),
        "rejected": m("rejected", c, p),
        "pending": m("pending", c, p),
        "rejectionRatePct": m("rejectionRatePct", c, p),
        "left": m("left", c, p),
        "returned": m("returned", c, p),
        "notReturned": m("notReturned", c, p),
        "returnRatePct": m("returnRatePct", c, p),
        "minutesOut": m("minutesOut", c, p),
        "hoursOut": _metric(_hours(c["minutesOut"]), _hours(p["minutesOut"])),
        "avgMinutesOut": m("avgMinutesOut", c, p),
        "turnaroundAvgMinutes": m("turnaroundAvg", c, p),
        "turnaroundMedianMinutes": m("turnaroundMedian", c, p),
        "onDutyTrips": _metric(cur_on_duty, prev_on_duty),
        "gateFormExits": _metric(cur_forms, prev_forms),
        "outsideNow": _outside_now(scope, now, today),
        "waitingNow": {k: waiting[k] for k in ("waiting", "overOneDay", "oldestMinutes")},
    }
    notes = [
        NOTE_NO_CHECKOUT,
        *_scope_notes(scope),
        *_return_scan_note(c["returned"], c["notReturned"], c["returnRatePct"]),
    ]
    if period.start <= today <= period.end:
        notes.append("Today is still in progress, so its figures grow until the end of the day.")
    return envelope(
        {"previousPeriod": previous.to_json(), "visitors": visitors, "outpass": outpass},
        period=period,
        scope=scope,
        provenance=[
            _p_visits(v["visits"], scope),
            _p_peak(v["visits"]),
            _p_after_hours(v["visits"]),
            _p_repeat_visitors(v["repeatVisitors"], scaled_threshold(FREQUENT_VISITOR_PER_30_DAYS, period.days)),
            _p_passes(c["requests"], cur_on_duty),
            _p_approvals(c["approved"] + c["rejected"]),
            _p_turnaround(c["turnaroundCount"]),
            _p_hours_out(c["measured"]),
            _p_return_rate(c["returned"] + c["notReturned"]),
            _p_waiting(waiting["waiting"]),
            _p_gate_form(cur_forms),
        ],
        notes=notes,
    )


# ─── trend ────────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def trend(scope: Scope, period: Period) -> dict:
    """Visits and outpasses over the period: a point per day, or per week once the period is long."""
    now, today = _clock()
    weekly = period.days > WEEKLY_AFTER_DAYS
    daily_visits = _daily_visits(_visit_cells(_visit_qs(scope, period)))
    facts, _ = _facts(_pass_rows(scope, period), now, today)
    forms: dict[date, int] = {
        r["d"]: r["n"]
        for r in _gate_form_qs(scope, period)
        .annotate(d=TruncDate("submitted_at", tzinfo=FACTORY_TZ))
        .values("d")
        .annotate(n=Count("id"))
        .order_by()
    }
    per_day: dict[date, dict] = defaultdict(lambda: {"passes": 0, "left": 0, "returned": 0, "minutes": 0})
    for f in facts:
        d = GO.ist_date(f.row["created_at"])
        slot = per_day[d]
        slot["passes"] += 1
        slot["left"] += f.row["exited_at"] is not None
        slot["returned"] += f.row["entered_at"] is not None
        slot["minutes"] += f.minutes or 0

    buckets: dict[date, dict] = {}
    for offset in range(period.days):
        d = period.start + timedelta(days=offset)
        key = d - timedelta(days=d.weekday()) if weekly else d
        b = buckets.setdefault(
            key,
            {"key": key.isoformat(), "start": d.isoformat(), "end": d.isoformat(), "days": 0}
            | {"visits": 0, "passes": 0, "left": 0, "returned": 0, "minutesOut": 0, "gateFormExits": 0},
        )
        b["end"] = d.isoformat()
        b["days"] += 1
        b["visits"] += daily_visits.get(d, 0)
        b["gateFormExits"] += forms.get(d, 0)
        slot = per_day.get(d)
        if slot:
            b["passes"] += slot["passes"]
            b["left"] += slot["left"]
            b["returned"] += slot["returned"]
            b["minutesOut"] += slot["minutes"]
    points = list(buckets.values())
    totals = {
        k: sum(b[k] for b in points) for k in ("visits", "passes", "left", "returned", "minutesOut", "gateFormExits")
    }
    return envelope(
        {"granularity": "week" if weekly else "day", "points": points, "totals": totals},
        period=period,
        scope=scope,
        provenance=[_p_trend(len(facts) + totals["visits"], weekly), _p_hours_out(None)],
        notes=_scope_notes(scope),
    )


# ─── visitors ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _purposes(qs, limit: int) -> dict:
    """Visits by purpose category plus the wording behind them. One grouped query on the trimmed, lower-cased text."""
    rows = (
        qs.annotate(p=Lower(Trim("purpose")))
        .values("p")
        .annotate(n=Count("id"), sample=Min(Trim("purpose")))
        .order_by("-n", "p")
    )
    per_category: Counter = Counter()
    other: list[dict] = []
    typed: list[dict] = []
    for r in rows:
        key, _label = classify_purpose(r["p"])
        per_category[key] += r["n"]
        entry = {"text": _text(r["sample"], 80) or "(blank)", "visits": r["n"]}
        typed.append(entry)
        if key == OTHER_PURPOSE[0]:
            other.append(entry)
    total = sum(per_category.values())
    order = [k for k, _, _ in PURPOSE_CATEGORIES] + [OTHER_PURPOSE[0]]
    categories = [
        {"key": k, "label": PURPOSE_LABEL[k], "visits": per_category[k], "sharePct": pct(per_category[k], total)}
        for k in order
        if per_category[k]
    ]
    categories.sort(key=lambda c: (c["key"] == OTHER_PURPOSE[0], -c["visits"], c["label"]))
    return {
        "categories": categories,
        "otherSharePct": pct(per_category[OTHER_PURPOSE[0]], total),
        "otherSamples": other[: min(limit, 8)],
        "typedTop": typed[:limit],
    }


def _host_breakdown(qs, total: int, limit: int) -> tuple[list[dict], dict, list[dict]]:
    """(by host department, the visits with no matched employee, the most visited people)."""
    dept_rows = (
        qs.filter(meeting_employee__isnull=False)
        .values("meeting_employee__department__name")
        .annotate(n=Count("id"), people=Count("visitor_id", distinct=True))
        .order_by()
    )
    merged: dict[str, dict] = {}
    for r in dept_rows:
        name = r["meeting_employee__department__name"] or NO_DEPARTMENT
        slot = merged.setdefault(name, {"department": name, "visits": 0, "uniqueVisitors": 0})
        slot["visits"] += r["n"]
        slot["uniqueVisitors"] += r["people"]  # a visitor who met two units' staff counts in both, never twice in one
    linked_visits = sum(d["visits"] for d in merged.values())
    departments = sorted(merged.values(), key=lambda d: (-d["visits"], d["department"]))
    for d in departments:
        d["sharePct"] = pct(d["visits"], total)
    not_linked = {"visits": total - linked_visits, "sharePct": pct(total - linked_visits, total)}

    linked_hosts = (
        qs.filter(meeting_employee__isnull=False)
        .values(
            "meeting_employee_id",
            "meeting_employee__employee_code",
            "meeting_employee__first_name",
            "meeting_employee__last_name",
            "meeting_employee__department__name",
        )
        .annotate(n=Count("id"), people=Count("visitor_id", distinct=True))
        .order_by("-n", "meeting_employee_id")[:limit]
    )
    free_hosts = (
        qs.filter(meeting_employee__isnull=True)
        .annotate(hk=Lower(Trim("whom_to_meet")))
        .values("hk")
        .annotate(n=Count("id"), people=Count("visitor_id", distinct=True), label=Min(Trim("whom_to_meet")))
        .order_by("-n", "hk")[:limit]
    )
    hosts = [
        {
            "employeeId": r["meeting_employee_id"],
            "name": _person(r["meeting_employee__first_name"], r["meeting_employee__last_name"]),
            "code": r["meeting_employee__employee_code"],
            "department": r["meeting_employee__department__name"] or NO_DEPARTMENT,
            "linked": True,
            "visits": r["n"],
            "uniqueVisitors": r["people"],
        }
        for r in linked_hosts
    ] + [
        {
            "employeeId": None,
            "name": r["label"] or "(blank)",
            "code": None,
            "department": None,
            "linked": False,
            "visits": r["n"],
            "uniqueVisitors": r["people"],
        }
        for r in free_hosts
    ]
    hosts.sort(key=lambda h: (-h["visits"], h["name"].lower(), h["employeeId"] or 0))
    return departments, not_linked, hosts[:limit]


def _repeat_visitor_rows(qs, minimum: int, limit: int) -> tuple[int, int, list[dict]]:
    """(visitors with `minimum`+ visits, how many visits they make up, the top `limit` with their latest purpose)."""
    grouped = list(
        qs.values("visitor_id", "visitor__name")
        .annotate(
            n=Count("id"),
            first=Min("visited_at"),
            last=Max("visited_at"),
            hosts=Count(Lower(Trim("whom_to_meet")), distinct=True),
        )
        .filter(n__gte=minimum)
        .order_by("-n", "visitor__name", "visitor_id")
    )
    top = grouped[:limit]
    latest: dict[int, str | None] = {}
    if top:
        ids = [g["visitor_id"] for g in top]
        for r in (
            qs.filter(visitor_id__in=ids).order_by("visitor_id", "-visited_at", "-id").values("visitor_id", "purpose")
        ):
            latest.setdefault(r["visitor_id"], r["purpose"])
    rows = [
        {
            "visitorId": g["visitor_id"],
            "visitorName": g["visitor__name"],
            "visits": g["n"],
            "hostsMet": g["hosts"],
            "firstVisitAt": _stamp(g["first"]),
            "lastVisitAt": _stamp(g["last"]),
            "lastPurpose": _text(latest.get(g["visitor_id"]), 100),
        }
        for g in top
    ]
    return len(grouped), sum(g["n"] for g in grouped), rows


@cached()
def visitors_breakdown(scope: Scope, period: Period, *, limit: int = 10, include_heatmap: bool = True) -> dict:
    """Who is coming in: purposes, host departments, the most visited people, repeat visitors and the busiest times."""
    limit = max(1, min(MAX_LIST, limit))
    qs = _visit_qs(scope, period)
    cells = _visit_cells(qs)
    totals = _visit_totals(qs)
    total = totals["visits"]
    peak_hour, peak_day = _peaks(cells)
    departments, not_linked, hosts = _host_breakdown(qs, total, limit)
    minimum = scaled_threshold(FREQUENT_VISITOR_PER_30_DAYS, period.days)
    repeat_n, repeat_visits, repeat_rows = _repeat_visitor_rows(qs, 2, limit)
    per_weekday = Counter()
    for d, _h, n in cells:
        per_weekday[d.weekday()] += n
    busiest_weekday = max(per_weekday.items(), key=lambda kv: (kv[1], -kv[0])) if per_weekday else None

    data: dict[str, Any] = {
        "visits": total,
        "uniqueVisitors": totals["unique"],
        "purposes": _purposes(qs, limit),
        "hostDepartments": departments[:limit],
        "hostsNotLinked": not_linked,
        "topHosts": hosts,
        "repeatVisitors": {
            "total": repeat_n,
            "visits": repeat_visits,
            "sharePct": pct(repeat_visits, total),
            "frequentFrom": minimum,
            "rows": repeat_rows,
        },
        "afterHours": {
            "total": totals["afterHours"],
            "sharePct": pct(totals["afterHours"], total),
            "startHour": VISIT_DAY_START_HOUR,
            "endHour": VISIT_DAY_END_HOUR,
            "label": f"before {_clock_label(VISIT_DAY_START_HOUR)} or from {_clock_label(VISIT_DAY_END_HOUR)}",
        },
        "peakHour": peak_hour,
        "peakDay": peak_day,
        "busiestWeekday": {"weekday": WEEKDAYS[busiest_weekday[0]], "visits": busiest_weekday[1]}
        if busiest_weekday
        else None,
    }
    if include_heatmap:
        data["heatmap"] = _heatmap(cells)
    return envelope(
        data,
        period=period,
        scope=scope,
        provenance=[
            _p_visits(total, scope),
            _p_purposes(total),
            _p_hosts(total),
            _p_repeat_visitors(repeat_n, minimum),
            _p_after_hours(total),
            _p_heatmap(total),
            _p_peak(total),
        ],
        notes=[NOTE_NO_CHECKOUT, NOTE_NO_COMPANY, *_scope_notes(scope)],
    )


# ─── outpasses ────────────────────────────────────────────────────────────────────────────────────────────────────


def _by_department(facts: list[PassFact], headcount: dict[str, int]) -> list[dict]:
    groups: dict[str, dict] = {}
    for f in facts:
        name = f.row["employee__department__name"] or NO_DEPARTMENT
        g = groups.setdefault(
            name, {"department": name, "requests": 0, "people": set(), "returned": 0, "measured": [], "notReturned": 0}
        )
        g["requests"] += 1
        g["people"].add(f.row["employee_id"])
        g["returned"] += f.row["entered_at"] is not None
        g["notReturned"] += f.outcome == "not_returned"
        if f.minutes is not None:
            g["measured"].append(f.minutes)
    rows = []
    for g in groups.values():
        staff = headcount.get(g["department"])
        rows.append(
            {
                "department": g["department"],
                "requests": g["requests"],
                "employees": len(g["people"]),
                "headcount": staff,
                "requestsPer100": round(g["requests"] * 100 / staff, 1) if staff else None,
                "returned": g["returned"],
                "minutesOut": sum(g["measured"]) if g["measured"] else None,
                "avgMinutes": GO.mean_minutes(g["measured"]),
                "notReturned": g["notReturned"],
            }
        )
    rows.sort(key=lambda r: (-(r["minutesOut"] or 0), -r["requests"], r["department"]))
    return rows


def _by_reason(facts: list[PassFact]) -> list[dict]:
    total = len(facts)
    rows = []
    for key, label in REASONS:
        group = [f for f in facts if f.reason == key]
        if not group:
            continue
        measured = [f.minutes for f in group if f.minutes is not None]
        rows.append(
            {
                "key": key,
                "label": label,
                "requests": len(group),
                "sharePct": pct(len(group), total),
                "returned": sum(1 for f in group if f.row["entered_at"] is not None),
                "minutesOut": sum(measured) if measured else None,
                "avgMinutes": GO.mean_minutes(measured),
            }
        )
    return rows


def _durations(facts: list[PassFact]) -> dict:
    measured = sorted(f.minutes for f in facts if f.minutes is not None)
    buckets = []
    for key, label, lo, hi in DURATION_BUCKETS:
        n = sum(1 for m in measured if m >= lo and (hi is None or m < hi))
        buckets.append({"key": key, "label": label, "passes": n, "sharePct": pct(n, len(measured))})
    return {
        "buckets": buckets,
        "measured": len(measured),
        "medianMinutes": _median_minutes(measured),
        "avgMinutes": GO.mean_minutes(measured),
        "longestMinutes": measured[-1] if measured else None,
    }


def _funnel(facts: list[PassFact], on_duty: int) -> dict:
    outcomes = Counter(f.outcome for f in facts)
    approved = sum(1 for f in facts if f.row["status"] == "approved")
    left = sum(1 for f in facts if f.row["exited_at"] is not None)
    returned = sum(1 for f in facts if f.row["entered_at"] is not None)
    return {
        "requested": len(facts),
        "approved": approved,
        "left": left,
        "returned": returned,
        "dropOffs": {
            "rejected": outcomes["rejected"],
            "waiting": outcomes["waiting"],
            "approvedNotUsed": outcomes["approved_unused"],
            "outsideNow": outcomes["outside_now"],
            "notReturned": outcomes["not_returned"],
            "earlyDismissal": outcomes["early_dismissal"],
        },
        "onDutyTrips": on_duty,
    }


def _headcount_by_department(scope: Scope) -> dict[str, int]:
    rows = scope.employees(active=True).order_by().values("department__name").annotate(n=Count("id"))
    out: dict[str, int] = defaultdict(int)
    for r in rows:
        out[r["department__name"] or NO_DEPARTMENT] += r["n"]
    return dict(out)


@cached()
def outpass_breakdown(scope: Scope, period: Period, *, limit: int = 10) -> dict:
    """Who leaves and for how long: the funnel, hours out by department, reasons, durations, the approvals queue and the
    gate's refusals."""
    limit = max(1, min(MAX_LIST, limit))
    now, today = _clock()
    facts, on_duty = _facts(_pass_rows(scope, period), now, today)
    metrics = _pass_metrics(facts)
    waiting = _waiting_snapshot(scope, now)
    scans = _scan_stats(scope, period)
    departments = _by_department(facts, _headcount_by_department(scope))
    notes = [
        *_scope_notes(scope),
        *_return_scan_note(metrics["returned"], metrics["notReturned"], metrics["returnRatePct"]),
    ]
    if on_duty:
        notes.append(
            f"{on_duty} On-Duty {_plural(on_duty, 'trip')} in this period {_plural(on_duty, 'is', 'are')} official "
            "work and not counted here."
        )
    return envelope(
        {
            "requests": len(facts),
            "funnel": _funnel(facts, on_duty),
            "byDepartment": departments[:limit],
            "departmentsTotal": len(departments),
            "byReason": _by_reason(facts),
            "durations": _durations(facts),
            "totals": {
                "minutesOut": metrics["minutesOut"],
                "hoursOut": _hours(metrics["minutesOut"]),
                "avgMinutesOut": metrics["avgMinutesOut"],
                "returnRatePct": metrics["returnRatePct"],
            },
            "approvals": {
                "turnaround": {
                    "avgMinutes": metrics["turnaroundAvg"],
                    "medianMinutes": metrics["turnaroundMedian"],
                    "decisions": metrics["turnaroundCount"],
                },
                "rejectionRatePct": metrics["rejectionRatePct"],
                "aging": waiting,
            },
            "gateScans": scans,
        },
        period=period,
        scope=scope,
        provenance=[
            _p_passes(len(facts), on_duty),
            _p_funnel(len(facts)),
            _p_hours_out(metrics["measured"]),
            _p_departments(len(facts)),
            _p_reasons(len(facts)),
            _p_durations(metrics["measured"]),
            _p_turnaround(metrics["turnaroundCount"]),
            _p_waiting(waiting["waiting"]),
            _p_return_rate(metrics["returned"] + metrics["notReturned"]),
            _p_gate_scans(scans["attempts"]),
        ],
        notes=notes,
    )


@cached()
def units(scope: Scope, period: Period) -> dict:
    """The same measures unit by unit, so the MD can see which unit leaks the most time or has the most visitors: visits
    by the unit whose QR was scanned, passes by the employee's unit, requests per 100 staff of that unit."""
    now, today = _clock()
    facts, _ = _facts(_pass_rows(scope, period), now, today)
    groups: dict[int | None, dict] = {}

    def slot(unit_id: int | None) -> dict:
        return groups.setdefault(
            unit_id,
            {"unitId": unit_id, "visits": 0, "uniqueVisitors": 0, "afterHours": 0, "requests": 0, "approved": 0}
            | {"returned": 0, "measured": [], "notReturned": 0, "headcount": None},
        )

    for f in facts:
        g = slot(f.row["employee__branch_id"])
        g["requests"] += 1
        g["approved"] += f.row["status"] == "approved"
        g["returned"] += f.row["entered_at"] is not None
        g["notReturned"] += f.outcome == "not_returned"
        if f.minutes is not None:
            g["measured"].append(f.minutes)
    visit_rows = (
        _visit_qs(scope, period)
        .annotate(h=_hour_expr())
        .values("branch_id")
        .annotate(n=Count("id"), people=Count("visitor_id", distinct=True), after=Count("id", filter=_after_hours_q()))
    )
    for r in visit_rows:
        g = slot(r["branch_id"])
        g["visits"], g["uniqueVisitors"], g["afterHours"] = r["n"], r["people"], r["after"]
    staff = scope.employees(active=True).order_by().values("branch_id").annotate(n=Count("id"))
    for r in staff:
        if r["branch_id"] in groups:
            groups[r["branch_id"]]["headcount"] = r["n"]
    names = dict(Branch.objects.filter(id__in=[k for k in groups if k is not None]).values_list("id", "name"))

    rows = []
    for unit_id, g in groups.items():
        rows.append(
            {
                "unitId": unit_id,
                "unit": names.get(unit_id, "No unit"),
                "visits": g["visits"],
                "uniqueVisitors": g["uniqueVisitors"],
                "afterHours": g["afterHours"],
                "requests": g["requests"],
                "approved": g["approved"],
                "minutesOut": sum(g["measured"]) if g["measured"] else None,
                "avgMinutes": GO.mean_minutes(g["measured"]),
                "notReturned": g["notReturned"],
                "headcount": g["headcount"],
                "requestsPer100": round(g["requests"] * 100 / g["headcount"], 1) if g["headcount"] else None,
            }
        )
    rows.sort(key=lambda r: (-(r["minutesOut"] or 0), -r["requests"], -r["visits"], r["unit"]))
    return envelope(
        {"units": rows},
        period=period,
        scope=scope,
        provenance=[_p_units(sum(r["requests"] + r["visits"] for r in rows)), _p_hours_out(None)],
        notes=_scope_notes(scope),
    )


# ─── exceptions ───────────────────────────────────────────────────────────────────────────────────────────────────

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "good": 3}


def _after_hours_rows(qs, limit: int) -> list[dict]:
    rows = (
        qs.annotate(h=_hour_expr())
        .filter(_after_hours_q())
        .values(
            "id",
            "visited_at",
            "visitor__name",
            "purpose",
            "whom_to_meet",
            "meeting_employee_id",
            "meeting_employee__first_name",
            "meeting_employee__last_name",
            "meeting_employee__department__name",
        )
        .order_by("-visited_at", "-id")[:limit]
    )
    return [_visit_item(r) for r in rows]


def _visit_item(r: dict) -> dict:
    linked = r["meeting_employee_id"] is not None
    host = _person(r["meeting_employee__first_name"], r["meeting_employee__last_name"]) if linked else None
    return {
        "visitId": r["id"],
        "visitedAt": _stamp(r["visited_at"]),
        "visitorName": r["visitor__name"],
        "hostName": host or _text(r["whom_to_meet"], 80),
        "hostLinked": linked,
        "hostDepartment": r["meeting_employee__department__name"] if linked else None,
        "purpose": _text(r["purpose"], 120),
    }


def _visitor_spike(daily: dict[date, int], *, recent_from: date | None = None) -> dict | None:
    """The busiest day if it is far above a typical day (the median of the days that had visits), else None. With
    ``recent_from`` only days from then on are considered (the Dashboard wants this week's spike, not last month's)."""
    busy = [n for n in daily.values() if n > 0]
    if len(busy) < SPIKE_MIN_DAYS:
        return None
    typical = statistics.median(busy)
    floor = max(SPIKE_MIN_VISITS, SPIKE_FACTOR * typical)
    candidates = [(n, d) for d, n in daily.items() if n >= floor and (recent_from is None or d >= recent_from)]
    if not candidates:
        return None
    n, d = max(candidates, key=lambda c: (c[0], -c[1].toordinal()))
    return {
        "date": d.isoformat(),
        "weekday": WEEKDAYS[d.weekday()],
        "label": f"{d.day:02d} {d.strftime('%b')}",
        "visits": n,
        "typical": round(typical),
    }


def _attention(data: dict, period: Period) -> list[dict]:
    """The page's "Needs your attention": findings with a severity, the number, where to look and a question to ask.
    The Dashboard's ``insights()`` shows the same findings for the last 30 days, so a figure is the same in both."""
    when = _when(period)
    items: list[dict] = []

    repeat = data["repeatOutpass"]
    if repeat["total"]:
        top = repeat["rows"][0]
        threshold = data["thresholds"]["repeatOutpass"]["forThisPeriod"]
        critical = top["passes"] >= threshold * REPEAT_OUTPASS_CRITICAL_FACTOR
        items.append(
            {
                "id": "visitors.repeat-outpass",
                "severity": "critical" if critical else "warning",
                "title": f"{repeat['total']} {_plural(repeat['total'], 'employee')} took {threshold} or more outpasses "
                f"{when}",
                "detail": f"The most is {top['passes']} passes ({_hm(top['minutesOut'])} out). Repeated short absences "
                "add up to lost production time.",
                "metric": f"{repeat['total']} {_plural(repeat['total'], 'person', 'people')}",
                "page": PAGE_OUTPASS,
                "ask": f"Which employees took {threshold} or more outpasses {when}, and how many hours were they out?",
            }
        )
    nr = data["notReturned"]
    if nr["neverReturned"]:
        n = nr["neverReturned"]
        items.append(
            {
                "id": "visitors.not-returned",
                "severity": "critical"
                if n >= NOT_RETURNED_CRITICAL and (nr["sharePct"] or 0) >= NOT_RETURNED_CRITICAL_PCT
                else "warning",
                "title": f"{n} {_plural(n, 'outpass', 'outpasses')} taken {when} {_plural(n, 'was', 'were')} never "
                "scanned back in",
                "detail": "The employee left on an earlier day and no return was recorded: they may have gone home, "
                "or the return scan was missed.",
                "metric": f"{n} {_plural(n, 'pass', 'passes')}",
                "page": PAGE_OUTPASS,
                "ask": f"Which outpasses were never returned {when}, and who took them?",
            }
        )
    wait = data["approvalsWaiting"]
    if wait["total"]:
        n = wait["total"]
        oldest = wait["oldestMinutes"]
        items.append(
            {
                "id": "visitors.approvals-waiting",
                "severity": "critical" if oldest is not None and oldest >= APPROVAL_CRITICAL_HOURS * 60 else "warning",
                "title": f"{n} outpass {_plural(n, 'request')} waiting more than {APPROVAL_WAIT_HOURS} hours for a "
                "decision",
                "detail": f"The oldest has waited {_wait_text(oldest)}. A pass is only valid for an hour after "
                "approval, so a late decision is no use to the employee.",
                "metric": f"{n} waiting",
                "page": PAGE_OUTPASS,
                "ask": "Which outpass requests have been waiting more than 24 hours, and with whom?",
            }
        )
    long_ = data["longOutpasses"]
    if long_["total"]:
        n = long_["total"]
        items.append(
            {
                "id": "visitors.long-outpass",
                "severity": "warning",
                "title": f"{n} {_plural(n, 'outpass', 'outpasses')} lasted {_hm(long_['thresholdMinutes'])} or more "
                f"{when}",
                "detail": f"A typical outpass lasts {_hm(long_['medianMinutes'])}."
                if long_["medianMinutes"] is not None
                else "These are far longer than a typical outpass.",
                "metric": f"{n} {_plural(n, 'pass', 'passes')}",
                "page": PAGE_OUTPASS,
                "ask": f"Which outpasses were much longer than usual {when}?",
            }
        )
    after = data["afterHoursVisits"]
    if after["total"]:
        n = after["total"]
        items.append(
            {
                "id": "visitors.after-hours",
                "severity": "warning" if n >= 5 else "info",
                "title": f"{n} {_plural(n, 'visit')} outside {_clock_label(VISIT_DAY_START_HOUR)} to "
                f"{_clock_label(VISIT_DAY_END_HOUR)} {when}",
                "detail": "Check-ins before opening time or after closing time.",
                "metric": f"{n} {_plural(n, 'visit')}",
                "page": PAGE_VISITORS,
                "ask": f"Who visited the factory after hours {when}, and whom did they come to see?",
            }
        )
    frequent = data["frequentVisitors"]
    if frequent["total"]:
        n = frequent["total"]
        items.append(
            {
                "id": "visitors.frequent-visitors",
                "severity": "info",
                "title": f"{n} {_plural(n, 'visitor')} came {frequent['minimum']} or more times {when}",
                "detail": "Regular suppliers are normal; check that each has a reason to come this often.",
                "metric": f"{n} {_plural(n, 'visitor')}",
                "page": PAGE_VISITORS,
                "ask": f"Which visitors came most often {when}, and why?",
            }
        )
    spike = data.get("visitorSpike")
    if spike:
        items.append(
            {
                "id": "visitors.visitor-spike",
                "severity": "info",
                "title": f"{spike['visits']} visitors on {spike['weekday']} {spike['label']}, "
                f"far above a typical day ({spike['typical']})",
                "detail": "An unusually busy day at the gate.",
                "metric": f"{spike['visits']} visits",
                "page": PAGE_VISITORS,
                "ask": f"Why were there so many visitors on {spike['date']}? Who came?",
            }
        )
    good = data.get("improvement")
    if good:
        items.append(
            {
                "id": "visitors.hours-down",
                "severity": "good",
                "title": good["title"],
                "detail": good["detail"],
                "metric": good["metric"],
                "page": PAGE_OUTPASS,
                "ask": good["ask"],
            }
        )
    order = {item["id"]: i for i, item in enumerate(items)}
    items.sort(key=lambda item: (_SEVERITY_ORDER[item["severity"]], order[item["id"]]))
    return items


def _improvement(cur: dict, prev: dict, period: Period) -> dict | None:
    """A "good news" finding: time out (or requests) clearly down against the previous period."""
    before, now_ = prev["minutesOut"], cur["minutesOut"]
    if before and now_ is not None and before >= IMPROVEMENT_MIN_MINUTES:
        drop = 100.0 * (before - now_) / before
        if drop >= IMPROVEMENT_MIN_PCT:
            return {
                "title": f"Time out on outpasses fell {round(drop)}% against the {period.previous().label.lower()}",
                "detail": f"{_hm(now_)} out this period, down from {_hm(before)}.",
                "metric": f"{_hm(now_)} out",
                "ask": f"Why did the time spent out on outpasses fall {_when(period)}? Which departments improved?",
            }
    before_n, now_n = prev["requests"], cur["requests"]
    if before_n >= IMPROVEMENT_MIN_REQUESTS:
        drop = 100.0 * (before_n - now_n) / before_n
        if drop >= IMPROVEMENT_MIN_PCT:
            return {
                "title": f"Outpass requests fell {round(drop)}% against the {period.previous().label.lower()}",
                "detail": f"{now_n} requests this period, down from {before_n}.",
                "metric": f"{now_n} requests",
                "ask": f"Which departments asked for fewer outpasses {_when(period)}?",
            }
    return None


def _exceptions_data(
    scope: Scope, period: Period, now: datetime, today: date, limit: int, *, spike_recent_days: int | None
) -> dict:
    facts, on_duty = _facts(_pass_rows(scope, period), now, today)
    metrics = _pass_metrics(facts)
    days = period.days

    # repeat outpass users: approved passes per employee
    repeat_min = scaled_threshold(REPEAT_OUTPASS_PER_30_DAYS, days)
    per_emp: dict[int, dict] = {}
    for f in facts:
        if f.row["status"] != "approved":
            continue
        g = per_emp.setdefault(
            f.row["employee_id"],
            {**_emp(f.row), "passes": 0, "minutesOut": 0, "last": None} | {key: 0 for key, _ in REASONS},
        )
        g["passes"] += 1
        g[f.reason] += 1
        g["minutesOut"] += f.minutes or 0
        g["last"] = max(g["last"], f.row["created_at"]) if g["last"] else f.row["created_at"]
    repeat_all = sorted(
        (g for g in per_emp.values() if g["passes"] >= repeat_min),
        key=lambda g: (-g["passes"], -g["minutesOut"], g["name"].lower(), g["employeeId"]),
    )
    repeat_rows = [
        {
            "employeeId": g["employeeId"],
            "name": g["name"],
            "code": g["code"],
            "department": g["department"],
            "passes": g["passes"],
            "personal": g["personal"],
            "official": g["official"],
            "earlyDismissal": g["early_dismissal"],
            "notStated": g["unspecified"],
            "minutesOut": g["minutesOut"],
            "lastPassAt": _stamp(g["last"]),
        }
        for g in repeat_all[:limit]
    ]

    # never returned (and outside right now)
    open_facts = [f for f in facts if f.outcome in ("not_returned", "outside_now")]
    open_facts.sort(key=lambda f: (f.outcome != "outside_now", -f.row["exited_at"].timestamp(), -f.row["id"]))
    never = sum(1 for f in open_facts if f.outcome == "not_returned")
    nr_rows = [
        {
            **_emp(f.row),
            "state": f.outcome,
            "stateLabel": OUTCOME_LABELS[f.outcome],
            "passType": f.reason,
            "passTypeLabel": REASON_LABEL[f.reason],
            "destination": _text(f.row["destination"], 80),
            "exitedAt": _stamp(f.row["exited_at"]),
            "daysAgo": (today - GO.ist_date(f.row["exited_at"])).days,
            "minutesOutsideSoFar": GO.minutes_between(f.row["exited_at"], now) if f.outcome == "outside_now" else None,
            "expectedReturnAt": _stamp(f.row["expected_return_at"]),
        }
        for f in open_facts[:limit]
    ]

    # long outpasses
    measured = [f.minutes for f in facts if f.minutes is not None]
    median = _median_minutes(measured) if len(measured) >= LONG_OUTPASS_MIN_SAMPLE else None
    long_floor = LONG_OUTPASS_MIN_MINUTES
    if median is not None:
        long_floor = max(long_floor, math.ceil(LONG_OUTPASS_FACTOR * median))
    long_facts = sorted(
        (f for f in facts if f.minutes is not None and f.minutes >= long_floor),
        key=lambda f: (-f.minutes, f.row["id"]),
    )
    long_rows = [
        {
            **_emp(f.row),
            "minutes": f.minutes,
            "passType": f.reason,
            "passTypeLabel": REASON_LABEL[f.reason],
            "destination": _text(f.row["destination"], 80),
            "exitedAt": _stamp(f.row["exited_at"]),
            "enteredAt": _stamp(f.row["entered_at"]),
        }
        for f in long_facts[:limit]
    ]

    # approvals waiting too long (a live snapshot, all dates)
    waiting = _waiting_snapshot(scope, now)
    cutoff = now - timedelta(hours=APPROVAL_WAIT_HOURS)
    wait_rows: list[dict] = []
    if waiting["overOneDay"]:
        raw = (
            OutpassRequest.objects.filter(
                scope.employee_q("employee__"), status="pending", source="manual", created_at__lt=cutoff
            )
            .order_by("created_at", "id")
            .values(*PASS_VALUES, "reason")[:limit]
        )
        wait_rows = [
            {
                **_emp(r),
                "requestedAt": _stamp(r["created_at"]),
                "waitingMinutes": GO.minutes_between(r["created_at"], now),
                "passType": _reason_key(r),
                "passTypeLabel": REASON_LABEL[_reason_key(r)],
                "destination": _text(r["destination"], 80),
                "reason": _text(r["reason"], 120),
            }
            for r in raw
        ]

    # visitors: after hours, frequent, spike
    vqs = _visit_qs(scope, period)
    cells = _visit_cells(vqs)
    after_total = sum(n for _d, h, n in cells if h < VISIT_DAY_START_HOUR or h >= VISIT_DAY_END_HOUR)
    after_rows = _after_hours_rows(vqs, limit) if after_total else []
    frequent_min = scaled_threshold(FREQUENT_VISITOR_PER_30_DAYS, days)
    frequent_n, _frequent_visits, frequent_rows = _repeat_visitor_rows(vqs, frequent_min, limit)
    recent_from = today - timedelta(days=spike_recent_days - 1) if spike_recent_days else None
    spike = _visitor_spike(_daily_visits(cells), recent_from=recent_from)

    previous = period.previous()
    prev_facts, _ = _facts(_pass_rows(scope, previous), now, today)
    improvement = _improvement(metrics, _pass_metrics(prev_facts), period)

    data = {
        "thresholds": {
            "repeatOutpass": {
                "per30Days": REPEAT_OUTPASS_PER_30_DAYS,
                "forThisPeriod": repeat_min,
                "criticalFrom": repeat_min * REPEAT_OUTPASS_CRITICAL_FACTOR,
            },
            "longOutpass": {
                "minMinutes": LONG_OUTPASS_MIN_MINUTES,
                "factorOfTypical": LONG_OUTPASS_FACTOR,
                "typicalMinutes": median,
                "forThisPeriod": long_floor,
            },
            "approvalWaitHours": APPROVAL_WAIT_HOURS,
            "afterHours": {
                "startHour": VISIT_DAY_START_HOUR,
                "endHour": VISIT_DAY_END_HOUR,
                "label": f"before {_clock_label(VISIT_DAY_START_HOUR)} or from {_clock_label(VISIT_DAY_END_HOUR)}",
            },
            "frequentVisitor": {"per30Days": FREQUENT_VISITOR_PER_30_DAYS, "forThisPeriod": frequent_min},
        },
        "repeatOutpass": {"total": len(repeat_all), "minimum": repeat_min, "rows": repeat_rows},
        "notReturned": {
            "total": len(open_facts),
            "neverReturned": never,
            "outsideNow": len(open_facts) - never,
            "sharePct": pct(never, never + metrics["returned"]),
            "rows": nr_rows,
        },
        "longOutpasses": {
            "total": len(long_facts),
            "thresholdMinutes": long_floor,
            "medianMinutes": median,
            "rows": long_rows,
        },
        "approvalsWaiting": {
            "total": waiting["overOneDay"],
            "pendingTotal": waiting["waiting"],
            "oldestMinutes": waiting["oldestMinutes"],
            "rows": wait_rows,
        },
        "afterHoursVisits": {"total": after_total, "rows": after_rows},
        "frequentVisitors": {"total": frequent_n, "minimum": frequent_min, "rows": frequent_rows},
        "visitorSpike": spike,
        "improvement": improvement,
        "_onDuty": on_duty,
        "_requests": len(facts),
        "_measured": len(measured),
    }
    data["attention"] = _attention(data, period)
    return data


def _exceptions_envelope(data: dict, period: Period, scope: Scope) -> dict:
    data = {k: v for k, v in data.items() if not k.startswith("_") and k not in ("improvement", "visitorSpike")}
    return envelope(
        data,
        period=period,
        scope=scope,
        provenance=[
            _p_thresholds(
                period,
                data["thresholds"]["longOutpass"]["forThisPeriod"],
                data["thresholds"]["longOutpass"]["typicalMinutes"],
            ),
            _p_passes(None),
            _p_waiting(data["approvalsWaiting"]["pendingTotal"]),
            _p_after_hours(data["afterHoursVisits"]["total"]),
            _p_repeat_visitors(data["frequentVisitors"]["total"], data["frequentVisitors"]["minimum"]),
            _p_return_rate(None),
        ],
        notes=[
            "Approvals waiting too long is a live snapshot across all dates; the other lists follow the chosen period.",
            *_scope_notes(scope),
        ],
    )


@cached()
def exceptions(scope: Scope, period: Period, *, limit: int = 10) -> dict:
    """What needs the MD's attention, with the people and records behind each finding (each list is capped)."""
    limit = max(1, min(MAX_LIST, limit))
    now, today = _clock()
    data = _exceptions_data(scope, period, now, today, limit, spike_recent_days=None)
    return _exceptions_envelope(data, period, scope)


# ─── activity feed and the one-day snapshot ───────────────────────────────────────────────────────────────────────


def _text_q(query: str, fields: tuple[str, ...]) -> Q:
    """Every word typed must appear in at least one of the fields (so "ravi stitching" narrows, not widens)."""
    out = Q()
    for word in query.split()[:6]:
        any_field = Q()
        for field in fields:
            any_field |= Q(**{f"{field}__icontains": word})
        out &= any_field
    return out


def _pass_item(r: dict, now: datetime, today: date) -> dict:
    state = GO.pass_state(GO.as_pass(r), now, today)
    outcome = _outcome(r, state)
    return {
        "kind": "outpass",
        "id": f"pass-{r['id']}",
        "at": _stamp(r["created_at"]),
        **_emp(r),
        "passType": _reason_key(r),
        "passTypeLabel": REASON_LABEL[_reason_key(r)],
        "destination": _text(r["destination"], 100),
        "status": r["status"],
        "outcome": outcome,
        "outcomeLabel": OUTCOME_LABELS[outcome],
        "exitedAt": _stamp(r["exited_at"]),
        "enteredAt": _stamp(r["entered_at"]),
        "minutesOut": GO.minutes_between(r["exited_at"], r["entered_at"]),
    }


def _visit_feed_item(r: dict) -> dict:
    item = _visit_item(r)
    return {
        "kind": "visit",
        "id": f"visit-{r['id']}",
        "at": item["visitedAt"],
        "visitorName": item["visitorName"],
        "hostName": item["hostName"],
        "hostLinked": item["hostLinked"],
        "hostDepartment": item["hostDepartment"],
        "purpose": item["purpose"],
        "branch": r.get("branch__name"),
    }


def _form_item(r: dict) -> dict:
    return {
        "kind": "gate_form",
        "id": f"form-{r['id']}",
        "at": _stamp(r["submitted_at"]),
        "employeeId": r["employee_id"],
        "name": _text(r["employee_name"], 80),
        "code": _text(r["employee_code"], 40),  # as typed: unverified
        "department": r["employee__department__name"] if r["employee_id"] else None,
        "matched": r["employee_id"] is not None,
        "destination": _text(r["destination"], 100),
        "branch": r["branch__name"],
    }


VISIT_FEED_VALUES = (
    "id",
    "visited_at",
    "visitor__name",
    "purpose",
    "whom_to_meet",
    "meeting_employee_id",
    "meeting_employee__first_name",
    "meeting_employee__last_name",
    "meeting_employee__department__name",
    "branch__name",
)
FORM_VALUES = (
    "id",
    "submitted_at",
    "employee_id",
    "employee_name",
    "employee_code",
    "employee__department__name",
    "destination",
    "branch__name",
)


def _feed_sources(scope: Scope, period: Period, query: str):
    """(visit rows, pass rows, form rows) querysets for the period, narrowed by the search text."""
    visits = _visit_qs(scope, period)
    lo, hi = _bounds(period)
    passes = OutpassRequest.objects.filter(
        scope.employee_q("employee__"), source="manual", created_at__gte=lo, created_at__lt=hi
    ).order_by()
    forms = _gate_form_qs(scope, period)
    if query:
        visits = visits.filter(
            _text_q(
                query,
                (
                    "visitor__name",
                    "purpose",
                    "whom_to_meet",
                    "meeting_employee__first_name",
                    "meeting_employee__last_name",
                ),
            )
        )
        passes = passes.filter(
            _text_q(
                query,
                (
                    "employee__first_name",
                    "employee__last_name",
                    "employee__employee_code",
                    "employee__department__name",
                    "destination",
                    "reason",
                ),
            )
        )
        forms = forms.filter(_text_q(query, ("employee_name", "employee_code", "destination")))
    return visits, passes, forms


def activity(
    scope: Scope, period: Period, *, page: int = 1, page_size: int = 25, q: str = "", kind: str = "all"
) -> dict:
    """The newest visits, outpass requests and gate-form exits first, one page at a time, with an optional search.
    Three tables are merged, so only the first ``MAX_FEED_DEPTH`` rows of each are reachable: narrow the period or
    search."""
    page, page_size = max(1, page), max(1, min(100, page_size))
    if kind not in FEED_KINDS:
        raise MdParamError(f"'kind' must be one of: {', '.join(FEED_KINDS)}.")
    q = " ".join((q or "").split())[:80]
    need = page * page_size
    if need > MAX_FEED_DEPTH:
        raise MdParamError(
            f"That page is too deep ({need} rows from the newest). Narrow the period or search for a name instead."
        )
    now, today = _clock()
    visits, passes, forms = _feed_sources(scope, period, q)
    counts = {
        "visits": visits.count() if kind in ("all", "visits") else 0,
        "outpasses": passes.count() if kind in ("all", "outpasses") else 0,
        "gateForm": forms.count() if kind in ("all", "gate_form") else 0,
    }
    merged: list[tuple[datetime, int, int, dict]] = []
    if counts["visits"]:
        for r in visits.values(*VISIT_FEED_VALUES).order_by("-visited_at", "-id")[:need]:
            merged.append((r["visited_at"], 0, r["id"], _visit_feed_item(r)))
    if counts["outpasses"]:
        for r in passes.values(*PASS_VALUES).order_by("-created_at", "-id")[:need]:
            merged.append((r["created_at"], 1, r["id"], _pass_item(r, now, today)))
    if counts["gateForm"]:
        for r in forms.values(*FORM_VALUES).order_by("-submitted_at", "-id")[:need]:
            merged.append((r["submitted_at"], 2, r["id"], _form_item(r)))
    merged.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    start = (page - 1) * page_size
    total = sum(counts.values())
    return envelope(
        {
            "page": page,
            "pageSize": page_size,
            "total": total,
            "hasMore": start + page_size < total,
            "kind": kind,
            "q": q,
            "counts": counts,
            "items": [t[3] for t in merged[start : start + page_size]],
        },
        period=period,
        scope=scope,
        provenance=[_p_activity()],
        notes=_scope_notes(scope),
    )


def day_snapshot(scope: Scope, day: date, *, limit: int = 15) -> dict:
    """Everything that happened at the gate on one factory day: who visited, who asked to leave, who used the form.
    Answers "who visited yesterday?". Lists are capped at ``limit`` (the totals are not)."""
    limit = max(1, min(50, limit))
    now, today = _clock()
    period = Period(day, day, "custom", f"{day.day:02d} {day.strftime('%b')} {day.year}")
    vqs = _visit_qs(scope, period)
    totals = _visit_totals(vqs)
    visit_rows = [_visit_feed_item(r) for r in vqs.values(*VISIT_FEED_VALUES).order_by("-visited_at", "-id")[:limit]]
    facts, _ = _facts(_pass_rows(scope, period), now, today)
    manual_rows = sorted(facts, key=lambda f: (f.row["created_at"], f.row["id"]), reverse=True)
    metrics = _pass_metrics(facts)
    forms = _gate_form_qs(scope, period)
    form_total = forms.count()
    form_rows = [_form_item(r) for r in forms.values(*FORM_VALUES).order_by("-submitted_at", "-id")[:limit]]
    notes = [NOTE_NO_CHECKOUT, *_scope_notes(scope)]
    if day > today:
        notes.append("That date has not happened yet.")
    return envelope(
        {
            "date": day.isoformat(),
            "weekday": WEEKDAYS[day.weekday()],
            "isToday": day == today,
            "isFuture": day > today,
            "visitors": {
                "visits": totals["visits"],
                "uniqueVisitors": totals["unique"],
                "afterHours": totals["afterHours"],
                "rows": visit_rows,
                "more": max(0, totals["visits"] - len(visit_rows)),
            },
            "outpass": {
                "requests": metrics["requests"],
                "approved": metrics["approved"],
                "rejected": metrics["rejected"],
                "pending": metrics["pending"],
                "left": metrics["left"],
                "returned": metrics["returned"],
                "notReturned": metrics["notReturned"],
                "minutesOut": metrics["minutesOut"],
                "rows": [_pass_item(f.row, now, today) for f in manual_rows[:limit]],
                "more": max(0, len(manual_rows) - limit),
            },
            "gateFormExits": {"count": form_total, "rows": form_rows, "more": max(0, form_total - len(form_rows))},
        },
        period=period,
        scope=scope,
        provenance=[_p_visits(totals["visits"], scope), _p_passes(metrics["requests"]), _p_gate_form(form_total)],
        notes=notes,
    )


# ─── each page's summary, in plain English ────────────────────────────────────────────────────────────────────────

FOCUS_CHOICES = (PAGE_OUTPASS, PAGE_VISITORS)


def _n(value: float | int | None, places: int = 0) -> str:
    """12,34,567 (Indian grouping), trailing zeros dropped: text written here is read by the MD as it is."""
    if value is None:
        return "—"
    text = indian_number(round(float(value), places), places)
    return text.rstrip("0").rstrip(".") if "." in text else text


def _before(period: Period) -> str:
    return "the day before" if period.days == 1 else f"the previous {period.days} days"


def _moved(metric: dict, unit: str, period: Period, places: int = 0) -> str:
    """ "up 7 on the previous 14 days" (empty when nothing moved or there is nothing to compare)."""
    change_ = metric["change"]
    if not change_ or not change_["abs"]:
        return ""
    return f"{'up' if change_['abs'] > 0 else 'down'} {_n(abs(change_['abs']), places)}{unit} on {_before(period)}"


def _line(id_: str, text: str, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "tone": tone}


def _outpass_lines(s: dict, findings: list[dict], period: Period) -> list[dict]:
    o = s["outpass"]
    when = _when(period)
    lines: list[dict] = []
    requests = o["requests"]["value"]
    if not requests:
        lines.append(_line("volume", f"No employee asked for an outpass {when}."))
    else:
        moved = _moved(o["requests"], "", period)
        parts = [
            f"{_n(o[key]['value'])} {label}"
            for key, label in (("approved", "approved"), ("rejected", "rejected"), ("pending", "not yet decided"))
            if o[key]["value"]
        ]
        text = f"{_n(requests)} outpass {'request was' if requests == 1 else 'requests were'} made {when}"
        text += f" ({moved})" if moved else ""
        text += f": {', '.join(parts)}." if parts else "."
        lines.append(_line("volume", text))
        minutes = o["minutesOut"]["value"]
        if minutes is None:
            lines.append(
                _line("time", "No pass has been scanned back in yet, so there is no time-out figure.", "watch")
            )
        else:
            moved = _moved(o["minutesOut"], " minutes", period)
            text = (
                f"Employees spent {_hm(minutes)} outside the gate on the passes that were scanned back in "
                f"({_hm(o['avgMinutesOut']['value'])} each on average"
            )
            text += f"; {moved})." if moved else ")."
            change_ = o["minutesOut"]["change"]
            tone = "neutral" if not change_ or not change_["abs"] else ("watch" if change_["abs"] > 0 else "good")
            lines.append(_line("time", text, tone))
    returned, never, rate, outside = (
        o["returned"]["value"],
        o["notReturned"]["value"],
        o["returnRatePct"]["value"],
        o["outsideNow"],
    )
    clauses = []
    if rate is not None:
        text = f"{_n(returned)} of the {_n(returned + never)} passes that left were scanned back in ({_n(rate, 1)}%)"
        clauses.append(text + (f"; {_n(never)} never came back" if never else ""))
    if outside:
        clauses.append(f"{_n(outside)} {_plural(outside, 'employee is', 'employees are')} outside right now")
    if clauses:
        lines.append(_line("control", ", and ".join(clauses) + ".", "watch" if never else "neutral"))
    lines.append(tea.attention_line(findings, "outpasses"))
    return lines


def _visitor_lines(s: dict, findings: list[dict], period: Period) -> list[dict]:
    v = s["visitors"]
    when = _when(period)
    visits = v["visits"]["value"]
    if not visits:
        return [_line("volume", f"Nobody checked in at the gate {when}."), tea.attention_line(findings, "visitors")]
    unique = v["uniqueVisitors"]["value"]
    moved = _moved(v["visits"], "", period)
    text = (
        f"{_n(visits)} {_plural(visits, 'visit')} by {_n(unique)} different {_plural(unique, 'visitor')} {when}"
        + (f" ({moved})" if moved else "")
        + f", about {_n(v['avgPerDay']['value'], 1)} a day."
    )
    lines = [_line("volume", text)]
    peak_hour, peak_day = v["peakHour"], v["peakDay"]
    if peak_hour and peak_day:
        day = date.fromisoformat(peak_day["date"])
        lines.append(
            _line(
                "peak",
                f"The busiest hour is {peak_hour['label']} and the busiest day {peak_day['weekday']} "
                f"{day.day:02d} {day.strftime('%b')} ({_n(peak_day['visits'])} {_plural(peak_day['visits'], 'visit')}).",
            )
        )
    after, repeat = v["afterHours"]["value"], v["repeatVisitors"]["value"]
    clauses = []
    if after:
        clauses.append(
            f"{_n(after)} {_plural(after, 'visit was', 'visits were')} outside {_clock_label(VISIT_DAY_START_HOUR)} to "
            f"{_clock_label(VISIT_DAY_END_HOUR)}"
        )
    if repeat:
        clauses.append(f"{_n(repeat)} {_plural(repeat, 'visitor')} came more than once")
    text = (
        "; ".join(clauses) + "." if clauses else "Every visit was inside opening hours and nobody came more than once."
    )
    lines.append(_line("mix", text, "watch" if after else "neutral"))
    lines.append(tea.attention_line(findings, "visitors"))
    return lines


@cached()
def story(scope: Scope, period: Period, focus: str = PAGE_OUTPASS) -> dict:
    """An Insights tab's summary: two to four plain sentences written by fixed rules (no AI, no model call on page load)
    from the very figures the cards show. ``focus`` is the page: ``outpass`` (employees leaving during the shift) or
    ``visitors`` (people coming in). A sentence whose figure does not exist for the selection is left out, never invented."""
    if focus not in FOCUS_CHOICES:
        raise MdParamError(f"'focus' must be one of: {', '.join(FOCUS_CHOICES)}.")
    s = summary(scope, period)
    findings = [i for i in exceptions(scope, period, limit=MAX_LIST)["attention"] if i["page"] == focus]
    outpass = focus == PAGE_OUTPASS
    lines = (_outpass_lines if outpass else _visitor_lines)(s, findings, period)
    wanted = (
        ("passes", "hours-out", "return-rate", "waiting")
        if outpass
        else ("visits", "peak", "after-hours", "repeat-visitors")
    )
    who = "" if scope.is_everyone() else f" ({scope.describe()})"
    subject = "the outpass picture" if outpass else "visitor traffic"
    entry = prov(
        "story",
        "The plain-English summary",
        dataset="Outpass requests, visitor check-ins, gate scans",
        definition=(
            "A few sentences written by fixed rules from the figures on this page (no AI): every number in them is the "
            "same figure the cards below show, for the same period and selection."
        ),
        formula=None,
        filters=[period.label, scope.describe()],
        caveats=[
            "It is not written by the AI. 'Explain with AI' asks the assistant, which looks the figures up itself and "
            "shows how it got its answer.",
            *([] if outpass else [NOTE_NO_CHECKOUT]),
        ],
    )
    return envelope(
        {
            "focus": focus,
            "sentences": lines,
            "text": " ".join(line["text"] for line in lines),
            "ask": f"Explain {subject} {_when(period)}{who}: what changed against {_before(period)}, why, and what "
            "should I look at first?",
        },
        period=period,
        scope=scope,
        provenance=[entry, *[p_ for p_ in s["provenance"] if p_["id"] in wanted]],
        notes=s["notes"],
    )


# ─── time lost: outpasses beside tea breaks ───────────────────────────────────────────────────────────────────────


def _p_time_lost(rows: int | None) -> dict:
    return prov(
        "time-lost",
        "Time lost: outpasses and tea breaks",
        dataset="Outpass requests (gate exit and return scans), tea-break scans, tea-break rule",
        definition=(
            "Two kinds of time that employees spend away from their work, set side by side. Outpass time is door to "
            "door, exit scan to return scan, for the passes scanned back in (official and personal). Tea-break time is "
            "only the minutes beyond the allowance, added up over every overrun. Together = the two added up."
        ),
        formula="outpass minutes out + tea-break minutes beyond the allowance",
        rows=rows,
        caveats=[
            "They are not the same kind of figure: a pass counts all the time spent outside, a tea break only the part "
            "beyond the allowance.",
            "Neither says the line stood still, or that the work was not made up later.",
            "A pass counts on the day it was requested and a tea break on the day it started.",
        ],
    )


@cached()
def time_lost(scope: Scope, period: Period, *, limit: int = 10) -> dict:
    """Time away from work in one picture: the minutes employees spent outside on outpasses and the minutes lost to tea
    breaks that ran over, day by day (week by week once the period is long), in total against the previous period, and
    by department. The tea-break side is the Tea Break page's own figure (tea_break.py)."""
    limit = max(1, min(MAX_LIST, limit))
    now, today = _clock()
    previous = period.previous()
    weekly = period.days > WEEKLY_AFTER_DAYS
    cur_facts, _ = _facts(_pass_rows(scope, period), now, today)
    prev_facts, _ = _facts(_pass_rows(scope, previous), now, today)
    c, p = _pass_metrics(cur_facts), _pass_metrics(prev_facts)
    tea_summary = tea.tea_summary(scope, period)
    tea_total = tea_summary["metrics"]["minutesLost"]

    def together(a: int | None, b: int | None) -> int | None:
        return None if a is None and b is None else (a or 0) + (b or 0)

    outpass_by_day: dict[date, int] = defaultdict(int)
    for f in cur_facts:
        outpass_by_day[GO.ist_date(f.row["created_at"])] += f.minutes or 0
    tea_by_day = tea.daily_minutes_lost(scope, period)
    buckets: dict[date, dict] = {}
    for offset in range(period.days):
        d = period.start + timedelta(days=offset)
        key = d - timedelta(days=d.weekday()) if weekly else d
        b = buckets.setdefault(
            key,
            {"key": key.isoformat(), "start": d.isoformat(), "end": d.isoformat(), "days": 0}
            | {"outpassMinutes": 0, "teaMinutes": 0},
        )
        b["end"] = d.isoformat()
        b["days"] += 1
        b["outpassMinutes"] += outpass_by_day.get(d, 0)
        b["teaMinutes"] += tea_by_day.get(d) or 0

    out_by_dept = {r["department"]: r["minutesOut"] for r in _by_department(cur_facts, {}) if r["minutesOut"]}
    tea_by_dept = tea.department_minutes_lost(scope, period)
    departments = [
        {
            "department": name,
            "outpassMinutes": out_by_dept.get(name),
            "teaMinutes": tea_by_dept.get(name),
            "totalMinutes": (out_by_dept.get(name) or 0) + (tea_by_dept.get(name) or 0),
        }
        for name in set(out_by_dept) | set(tea_by_dept)
    ]
    departments.sort(key=lambda r: (-r["totalMinutes"], r["department"]))
    departments = [r for r in departments if r["totalMinutes"]]
    outpass_now, tea_now = c["minutesOut"], tea_total["value"]
    return envelope(
        {
            "granularity": "week" if weekly else "day",
            "allowedMinutes": tea_summary["allowedMinutes"],
            "points": list(buckets.values()),
            "totals": {
                "outpassMinutes": _metric(outpass_now, p["minutesOut"]),
                "teaMinutes": {k: tea_total[k] for k in ("value", "previous", "change")},
                "togetherMinutes": _metric(
                    together(outpass_now, tea_now), together(p["minutesOut"], tea_total["previous"])
                ),
            },
            "outpassByReason": [
                {"key": r["key"], "label": r["label"], "minutesOut": r["minutesOut"]} for r in _by_reason(cur_facts)
            ],
            "byDepartment": departments[:limit],
            "departmentsTotal": len(departments),
        },
        period=period,
        scope=scope,
        provenance=[
            _p_time_lost(c["measured"] + (tea_summary["metrics"]["overruns"]["value"] or 0)),
            _p_hours_out(c["measured"]),
            *[e for e in tea_summary["provenance"] if e["id"] == "tea-minutes-lost"],
        ],
        notes=tea_summary["notes"],
    )


# ─── the Dashboard's two hooks ────────────────────────────────────────────────────────────────────────────────────


@cached()
def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide findings for the Dashboard (at most 5, most severe first): the page's "Needs your attention" for the
    last 30 days, so a figure is the same on both."""
    now, today_ = _clock(today)
    period = period_for_preset("last_30_days", today_)
    data = _exceptions_data(Scope(), period, now, today_, 1, spike_recent_days=SPIKE_RECENT_DAYS)
    return data["attention"][:5]


def _spark(by_day: dict[date, float], days: list[date]) -> list[float]:
    return [by_day.get(d, 0) for d in days]


@cached()
def headline(*, today: date | None = None) -> dict:
    """What the Dashboard's card strip shows for this page: visitors today, outpasses today (with the approvals waiting)
    and the hours out this week, each with a 14-day sparkline."""
    now, today_ = _clock(today)
    everyone = Scope()
    days = [today_ - timedelta(days=13 - i) for i in range(14)]
    window = Period(days[0], today_, "custom", "Last 14 days")
    visits_by_day = _daily_visits(_visit_cells(_visit_qs(everyone, window)))
    facts, _ = _facts(_pass_rows(everyone, window), now, today_)
    passes_by_day: dict[date, int] = defaultdict(int)
    minutes_by_day: dict[date, int] = defaultdict(int)
    for f in facts:
        d = GO.ist_date(f.row["created_at"])
        passes_by_day[d] += 1
        minutes_by_day[d] += f.minutes or 0
    waiting = _waiting_snapshot(everyone, now)

    week_start = today_ - timedelta(days=today_.weekday())
    this_week = sum(m for d, m in minutes_by_day.items() if week_start <= d <= today_)
    same_days_last_week = sum(
        m for d, m in minutes_by_day.items() if week_start - timedelta(days=7) <= d <= today_ - timedelta(days=7)
    )
    week_passes = sum(n for d, n in passes_by_day.items() if week_start <= d <= today_)
    delta = change(this_week, same_days_last_week) if same_days_last_week else None
    yesterday = today_ - timedelta(days=1)
    kpis = [
        {
            "id": "visitors-today",
            "label": "Visitors today",
            "value": visits_by_day.get(today_, 0),
            "format": "number",
            "sub": f"{visits_by_day.get(yesterday, 0)} yesterday",
            "delta": None,
            "spark": _spark(visits_by_day, days),
            "page": PAGE_VISITORS,
        },
        {
            "id": "outpasses-today",
            "label": "Outpasses today",
            "value": passes_by_day.get(today_, 0),
            "format": "number",
            "sub": f"{waiting['waiting']} waiting for approval",
            "delta": None,
            "spark": _spark(passes_by_day, days),
            "page": PAGE_OUTPASS,
        },
        {
            "id": "hours-out-week",
            "label": "Time out on outpasses this week",
            "value": this_week if week_passes else None,
            "format": "minutes",
            "sub": f"{week_passes} {_plural(week_passes, 'pass', 'passes')} since Monday",
            "delta": {**delta, "good": "down"} if delta else None,
            "spark": _spark(minutes_by_day, days),
            "page": PAGE_OUTPASS,
        },
    ]
    return {
        "kpis": kpis,
        "provenance": [
            _p_visits(sum(visits_by_day.values()), everyone),
            _p_passes(len(facts)),
            _p_waiting(waiting["waiting"]),
            _p_hours_out(None),
        ],
    }


# ─── the assistant's tools ────────────────────────────────────────────────────────────────────────────────────────

LIMIT_PARAM = integer_param("How many rows in each list (default 8, at most 25)", minimum=1, maximum=MAX_LIST)


def _only(result: dict, keys: tuple[str, ...], prov_ids: tuple[str, ...]) -> dict:
    """A tool's result: the envelope with only the named blocks and the provenance entries that explain them."""
    out = {k: v for k, v in result.items() if k in keys or k in ("generatedAt", "period", "scope", "notes")}
    wanted = [p for p in result["provenance"] if p["id"] in prov_ids]
    out["provenance"] = wanted or result["provenance"][:1]
    return out


def _tool_visitors_summary(*, scope: Scope, period: Period) -> dict:
    return _only(
        summary(scope, period),
        ("previousPeriod", "visitors"),
        ("visits", "peak", "after-hours", "repeat-visitors"),
    )


def _tool_visitors_breakdown(*, scope: Scope, period: Period, limit: int = 8) -> dict:
    return visitors_breakdown(scope, period, limit=limit, include_heatmap=False)


def _tool_outpass_summary(*, scope: Scope, period: Period, limit: int = 8) -> dict:
    head = _only(
        summary(scope, period),
        ("previousPeriod", "outpass"),
        ("passes", "approvals", "turnaround", "hours-out", "return-rate", "waiting", "gate-form"),
    )
    detail = outpass_breakdown(scope, period, limit=limit)
    out = {k: v for k, v in head.items() if k != "provenance"}
    out["funnel"] = detail["funnel"]
    out["byDepartment"] = detail["byDepartment"]
    out["byReason"] = detail["byReason"]
    out["durations"] = detail["durations"]
    out["approvalsQueue"] = detail["approvals"]["aging"]
    out["gateScans"] = {k: v for k, v in detail["gateScans"].items() if k != "byGate"}
    out["byUnit"] = units(scope, period)["units"]
    out["provenance"] = detail["provenance"]
    return out


def _tool_outpass_exceptions(*, scope: Scope, period: Period, limit: int = 8) -> dict:
    return exceptions(scope, period, limit=limit)


def _tool_trend(*, scope: Scope, period: Period) -> dict:
    full = trend(scope, period)
    out = {k: v for k, v in full.items() if k != "points"}
    out["points"] = [{k: b[k] for k in ("key", "days", "visits", "passes", "minutesOut")} for b in full["points"]]
    return out


def _tool_day(*, scope: Scope, date: str, limit: int = 10) -> dict:
    """``date`` is the parameter name the model sees (it shadows the type name only inside this function)."""
    return day_snapshot(scope, parse_day(date, "date"), limit=limit)


def _tool_search(*, scope: Scope, period: Period, query: str = "", kind: str = "all", limit: int = 8) -> dict:
    return activity(scope, period, page=1, page_size=limit, q=query, kind=kind)


TOOLS = [
    tool(
        "visitors_summary",
        "Visitors at the gate for a period compared with the previous period of the same length: visits, unique "
        "visitors, repeat visitors, after-hours visits, average per day, the busiest hour and day. Use for 'how many "
        "visitors', 'is footfall up'. Visitors have no check-out, so it cannot say who is inside now or how long "
        "anyone stayed.",
        _tool_visitors_summary,
        page="visitors",
        period="last_30_days",
    ),
    tool(
        "visitors_breakdown",
        "Where visitors come from and whom they meet, for a period: visits by purpose category (and the wording "
        "typed), by host department, the most visited people, repeat visitors, after-hours share and the busiest "
        "weekday. Use for 'why do visitors come', 'who gets the most visitors'. There is no company field, so it "
        "cannot group by company.",
        _tool_visitors_breakdown,
        page="visitors",
        period="last_30_days",
        extra={"limit": LIMIT_PARAM},
        defaults={"limit": 8},
        person_fields=("hostName", "visitorName"),
    ),
    tool(
        "outpass_summary",
        "Employee outpasses (permission to leave during the shift) for a period compared with the previous one: "
        "requests approved, rejected and pending, rejection rate, hours out in total and per pass, return rate, passes "
        "never returned, approval turnaround and who is waiting; then the request-to-return funnel, hours out by "
        "department and by unit, reasons (pass types), duration bands and gate refusals. Use for 'how many "
        "outpasses', 'how much time is lost to outpasses', 'which department or unit'. Hours are door to door for "
        "passes scanned back in; On-Duty trips are not counted.",
        _tool_outpass_summary,
        page="visitors",
        period="last_30_days",
        extra={"limit": LIMIT_PARAM},
        defaults={"limit": 8},
    ),
    tool(
        "outpass_exceptions",
        "What needs attention at the gate for a period: employees with repeated outpasses, passes never returned (and "
        "who is outside now), outpasses far longer than typical, requests waiting more than 24 hours for approval "
        "(live, all dates), after-hours visits and unusually frequent visitors, each with the rule used. Use for "
        "'who takes too many outpasses', 'what is wrong at the gate', 'any approvals stuck'.",
        _tool_outpass_exceptions,
        page="visitors",
        period="last_30_days",
        extra={"limit": LIMIT_PARAM},
        defaults={"limit": 8},
        person_fields=("hostName", "visitorName"),
    ),
    tool(
        "gate_trend",
        "Visits and outpasses over time for a period: one point per day, or per week for long periods, with visits, "
        "outpass requests and total minutes out. Use for 'is it getting better or worse', 'what happened last "
        "week'.",
        _tool_trend,
        page="visitors",
        period="last_30_days",
    ),
    tool(
        "gate_activity_on_date",
        "Everything at the gate on ONE day: visitor count, who visited (and whom they met), outpass requests with "
        "outcomes, and gate-form exits. Use for 'who visited yesterday', 'who left early on 2 October'. The date is "
        "YYYY-MM-DD.",
        _tool_day,
        page="visitors",
        extra={
            "date": string_param("The day, YYYY-MM-DD (for example 2026-10-04)."),
            "limit": integer_param("How many rows in each list (default 10, at most 50)", minimum=1, maximum=50),
        },
        required=("date",),
        defaults={"limit": 10},
        person_fields=("hostName", "visitorName"),
        example={"date": "2026-10-04"},
    ),
    tool(
        "time_lost_comparison",
        "Time away from work in one picture for a period: the minutes employees spent outside on outpasses (door to "
        "door, passes scanned back in, official and personal) next to the minutes lost to tea breaks that ran over the "
        "allowance, day by day, in total against the previous period, and by department. Use for 'how much time do we "
        "lose to outpasses and tea breaks', 'which department loses the most time away from the line'. The two are "
        "different measures (all time outside vs only the part of a tea break beyond the allowance): say so.",
        time_lost,
        page="visitors",
        period="last_30_days",
        extra={"limit": LIMIT_PARAM},
        defaults={"limit": 8},
    ),
    tool(
        "search_gate_activity",
        "Find recent visits, outpass requests or gate-form exits by a name, department, destination or purpose in the "
        "period, newest first. Use for 'when did X last visit', 'did this employee take an outpass this month'. Leave "
        "the query empty for the newest activity.",
        _tool_search,
        page="visitors",
        period="last_30_days",
        extra={
            "query": string_param("Words to look for (a name, a department, a place, a purpose). Optional."),
            "kind": string_param("Which records: all, visits, outpasses or gate_form.", enum=list(FEED_KINDS)),
            "limit": integer_param("How many records (default 8, at most 25)", minimum=1, maximum=MAX_LIST),
        },
        defaults={"kind": "all", "limit": 8},
        person_fields=("hostName", "visitorName"),
    ),
]
