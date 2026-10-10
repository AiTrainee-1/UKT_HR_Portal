"""MD portal, Geo Attendance: who works away from the premises, how often, and is it being verified?

Where the numbers come from
---------------------------
Two things happen under "Geo Attendance" (see ``geo_attendance_views.py``):

* **On-duty (off-site) work.** An employee working away from the unit asks for an *on-duty session* (``OnDutySession``:
  a destination and the approval chain Department Head -> HR). They may work and punch the moment they ask: every punch
  they make is an ``OnDutyPunchVerification`` (selfie + GPS + the time they pressed the button) that is held *pending*
  until HR approves it, and only then becomes real attendance. A rejected request voids the punches taken under it.
* **Office geo punch.** Staff inside the unit's geofence may punch with the phone instead of the biometric device. That
  punch is written straight to ``AttendanceLog`` tagged ``geo:auto``; a punch outside the fence is refused and nothing
  is stored, so "outside the fence" cannot be counted for it.

Decisions that make the numbers mean something (each is repeated in the provenance the screen shows):

* A session belongs to the factory day it was *requested* (``created_at`` in Asia/Kolkata); a punch to its ``punch_date``
  (already the factory's calendar), so a period never depends on the server's time zone.
* **Verified / rejected / pending** are the states of the *punches* HR decides on. A punch rejected only because its
  whole request was rejected is **voided** (``hr_review_comment`` starts "Voided automatically"), not counted again as an
  individual rejection; verified + rejected + voided + pending = punches captured.
* **How long verification takes** is the median time from capture to HR's decision (a few forgotten punches would drag an
  average a long way); for requests it is from the request to the final decision.
* **Distance from the unit** is the great-circle distance from the punch to the geofence centre of the employee's unit
  (Manage Branches). A unit with no location configured cannot place its punches: they are counted as "unknown", never
  as 0 km. On-duty work is away from the unit by design, so distance is a lens, not a verdict.
* **Unusual** is a short, named rule list (see the thresholds below), not a score: a simulated (mock) GPS location, a
  punch far from the unit, a punch at odd hours, a session left open for very long or past its day, HR rejections, and
  repeated rejections of the same person. Each is a reason to look, and the provenance says so.
* Headcount behind "participation" is today's active employees (there is no headcount history).

Nothing here writes. GPS coordinates are used to measure distance only: they are never returned.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from django.db.models import (
    Aggregate,
    Case,
    Count,
    DateTimeField,
    ExpressionWrapper,
    F,
    FloatField,
    Max,
    Min,
    Q,
    Value,
    When,
)
from django.db.models.functions import (
    ASin,
    Cast,
    Coalesce,
    Cos,
    Extract,
    ExtractHour,
    Greatest,
    Least,
    Power,
    Radians,
    Sin,
    Sqrt,
    TruncDate,
)
from django.utils import timezone

from ...clock import FACTORY_TZ
from ...geo_attendance_views import DEFAULT_RADIUS_M, PUNCHABLE_STATUSES
from ...geo_utils import haversine_distance_m
from ...models import AttendanceLog, Employee, LiveLocationPing, OnDutyPunchVerification, OnDutySession
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, prov

PAGE = "geo-attendance"

# ─── named thresholds (shown in provenance; the tests pin them) ─────────────────────────────────────────────────────

#: ``AttendanceLog.source`` of an office geo punch (``geo_attendance_views.geo_punch``).
OFFICE_SOURCE = "geo:auto"
#: ``hr_review_comment`` of a punch voided because its request was rejected (``_void_session_punches``).
VOID_COMMENT_PREFIX = "Voided automatically"
#: A session open (request to end, or to now) for longer than this is "very long". The 11 pm day-end job closes a
#: session left open, so a normal one is shorter than a working day.
LONG_SESSION_HOURS = 16
#: A punch farther than this from its unit is worth a look (a field visit can be far; the destination should say why).
FAR_KM = 100.0
#: Distance bands for the "how far" chart (km), the last edge is FAR_KM so the chart and the flag agree.
BAND_EDGES_KM = (2.0, 10.0, 50.0, FAR_KM)
#: A punch at or after this hour, or before ODD_BEFORE_HOUR, is at "odd hours" (factory clock).
ODD_FROM_HOUR = 22
ODD_BEFORE_HOUR = 5
#: Rejections (requests + punches HR rejected) of one person in the period before it is called repeated.
REPEAT_MIN_REJECTIONS = 2
#: Sessions in the period from which a person is "frequently" out.
FREQUENT_MIN_SESSIONS = 5
#: Something waiting for HR longer than this is overdue; older than CRITICAL_BACKLOG_DAYS is critical.
OVERDUE_HOURS = 48
CRITICAL_BACKLOG_DAYS = 7
#: Age buckets of what is waiting for HR (hours): under a day, 1-2 days, 2-7 days, over a week.
AGE_EDGES_HOURS = (24, 48, 24 * CRITICAL_BACKLOG_DAYS)
#: Verification slower than this (median) is flagged, with at least MIN_DECIDED decisions behind it.
SLOW_VERIFY_HOURS = 48.0
MIN_DECIDED = 5
#: Share of decided punches HR rejected (or that were voided) from which it is flagged.
HIGH_REJECTION_PCT = 25.0
#: Simulated-GPS punches from which the finding is critical.
MOCKED_CRITICAL_MIN = 3
#: On-duty sessions this much (and at least SURGE_MIN_EXTRA) above the previous period is a surge worth knowing about.
SURGE_PCT = 50.0
SURGE_MIN_EXTRA = 10
#: A tracked person whose last location is older than this is "silent" (no signal).
SILENT_MINUTES = 30
#: How long the app keeps location pings (``geo_attendance_views.PING_RETENTION_HOURS``).
PING_RETENTION_HOURS = 72
#: A group with fewer sessions than this is marked "small sample" and never called out.
MIN_SAMPLE_SESSIONS = 5
WEEKLY_ROLLUP_AFTER_DAYS = 62
MOVING_AVERAGE_DAYS = 7
LIVE_MAX = 50
LIST_MAX = 25
LIST_DEFAULT = 10
EARTH_RADIUS_M = 6371000.0

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}

_APPROVED_SESSION = (OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED)
_PENDING_SESSION = (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR)
_DECIDED_SESSION = (*_APPROVED_SESSION, OnDutySession.STATUS_REJECTED)
_PS = OnDutyPunchVerification


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────


def now_utc() -> datetime:
    """The clock this module reads (tests freeze it by patching this function)."""
    return timezone.now()


def _today(now: datetime | None = None) -> date:
    return timezone.localtime(now or now_utc(), FACTORY_TZ).date()


def _bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """[start 00:00, end + 1 day 00:00) in factory time, as aware datetimes."""
    return (
        datetime.combine(start, time.min, tzinfo=FACTORY_TZ),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=FACTORY_TZ),
    )


def _wall(dt: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if dt is None:
        return None
    return timezone.localtime(dt, FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


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


def _hours(seconds: float | None) -> float | None:
    return None if seconds is None else round(float(seconds) / 3600.0, 1)


def _hours_text(hours: float | None) -> str:
    """5.4 -> "5.4 hours", 30 -> "1.3 days" (what a person reads for a waiting time)."""
    if hours is None:
        return "n/a"
    if hours >= 48:
        return f"{_num(hours / 24, 1)} days"
    return f"{_num(hours, 1)} hours"


def _previous_phrase(period: Period) -> str:
    if period.days == 1:
        return "the day before"
    if period.days == 7:
        return "the 7 days before"
    return f"the previous {period.days} days"


def _name(first: str | None, last: str | None, code: str | None = None) -> str:
    return f"{first or ''} {last or ''}".strip() or (code or "Unknown")


class _Percentile(Aggregate):
    """``percentile_cont(q) WITHIN GROUP (ORDER BY x)``: the median (q=0.5) of a number of seconds, NULL on no rows."""

    function = "PERCENTILE_CONT"
    template = "%(function)s(%(q)s) WITHIN GROUP (ORDER BY %(expressions)s)"
    output_field = FloatField()
    allow_distinct = False


def _seconds(duration) -> Extract:
    return Extract(duration, "epoch")


# ─── the queries ────────────────────────────────────────────────────────────────────────────────────────────────────


def _distance_m() -> Case:
    """Great-circle metres from a punch to the geofence centre of its employee's unit (NULL when the unit has none).
    The same haversine as ``geo_utils.haversine_distance_m`` (a test pins that they agree), done in the database so
    every punch is measured in one query."""
    lat1 = Radians(Cast("latitude", FloatField()))
    lng1 = Radians(Cast("longitude", FloatField()))
    lat2 = Radians(Cast("employee__branch__geofence_lat", FloatField()))
    lng2 = Radians(Cast("employee__branch__geofence_lng", FloatField()))
    a = Power(Sin((lat2 - lat1) / 2), 2) + Cos(lat1) * Cos(lat2) * Power(Sin((lng2 - lng1) / 2), 2)
    distance = ExpressionWrapper(
        2 * EARTH_RADIUS_M * ASin(Sqrt(Least(a, Value(1.0, output_field=FloatField())))), output_field=FloatField()
    )
    # LEAST ignores NULL in PostgreSQL, so a unit without a location would come out as half the earth: say NULL
    # (unknown) explicitly instead.
    return Case(
        When(
            Q(employee__branch__geofence_lat__isnull=True) | Q(employee__branch__geofence_lng__isnull=True),
            then=Value(None, output_field=FloatField()),
        ),
        default=distance,
        output_field=FloatField(),
    )


def _sessions(scope: Scope, start: date, end: date):
    """On-duty sessions REQUESTED on a factory day inside [start, end] by the people in scope (leavers included)."""
    lo, hi = _bounds(start, end)
    return OnDutySession.objects.filter(scope.employee_q("employee__"), created_at__gte=lo, created_at__lt=hi)


def _punch_rows(scope: Scope, start: date, end: date):
    """On-duty punches taken on a day inside [start, end], each with its hour (``hr``) and its distance from the unit
    in metres (``dist_m``, NULL when the unit has no location)."""
    return OnDutyPunchVerification.objects.filter(
        scope.employee_q("employee__"), punch_date__gte=start, punch_date__lte=end
    ).annotate(hr=ExtractHour("punch_time"), dist_m=_distance_m())


def _office(scope: Scope, start: date, end: date):
    return AttendanceLog.objects.filter(
        scope.employee_q("employee__"), source=OFFICE_SOURCE, date__gte=start, date__lte=end
    )


def _voided_q() -> Q:
    return Q(status=_PS.STATUS_REJECTED, hr_review_comment__startswith=VOID_COMMENT_PREFIX)


def _rejected_q() -> Q:
    """Rejected by HR on the punch itself (not voided with its request)."""
    return Q(status=_PS.STATUS_REJECTED) & ~Q(hr_review_comment__startswith=VOID_COMMENT_PREFIX)


def _odd_q() -> Q:
    return Q(hr__gte=ODD_FROM_HOUR) | Q(hr__lt=ODD_BEFORE_HOUR)


def _far_q() -> Q:
    return Q(dist_m__gt=FAR_KM * 1000.0)


def _decided_punch_q() -> Q:
    """A punch HR looked at (approved, or rejected on its own): the ones whose waiting time means something."""
    return Q(status__in=(_PS.STATUS_APPROVED, _PS.STATUS_REJECTED)) & ~_voided_q() & Q(hr_reviewed_at__isnull=False)


def _decided_at():
    """When a request was finally decided: the later of the two reviewers' stamps (the other is NULL or earlier)."""
    return Greatest("hr_reviewed_at", "hod_reviewed_at")


def _session_measures() -> dict:
    decided = Q(status__in=_DECIDED_SESSION, decided_at__isnull=False)
    wait = _seconds(F("decided_at") - F("created_at"))
    return {
        "sessions": Count("id"),
        "people": Count("employee_id", distinct=True),
        "active_people": Count("employee_id", distinct=True, filter=Q(employee__status="active")),
        "awaiting_hod": Count("id", filter=Q(status=OnDutySession.STATUS_PENDING_HOD)),
        "awaiting_hr": Count("id", filter=Q(status=OnDutySession.STATUS_PENDING_HR)),
        "active": Count("id", filter=Q(status=OnDutySession.STATUS_ACTIVE)),
        "completed": Count("id", filter=Q(status=OnDutySession.STATUS_COMPLETED)),
        "rejected": Count("id", filter=Q(status=OnDutySession.STATUS_REJECTED)),
        "s_decided": Count("id", filter=decided),
        "s_median": _Percentile(wait, q=0.5, filter=decided),
        "s_p90": _Percentile(wait, q=0.9, filter=decided),
        "s_within24": Count("id", filter=decided & Q(decided_at__lte=F("created_at") + timedelta(hours=24))),
    }


def _punch_measures() -> dict:
    decided = _decided_punch_q()
    wait = _seconds(F("hr_reviewed_at") - F("created_at"))
    return {
        "punches": Count("id"),
        "punchers": Count("employee_id", distinct=True),
        "p_approved": Count("id", filter=Q(status=_PS.STATUS_APPROVED)),
        "p_rejected": Count("id", filter=_rejected_q()),
        "p_voided": Count("id", filter=_voided_q()),
        "p_pending": Count("id", filter=Q(status=_PS.STATUS_PENDING)),
        "mocked": Count("id", filter=Q(is_mocked=True)),
        "mocked_people": Count("employee_id", distinct=True, filter=Q(is_mocked=True)),
        "far": Count("id", filter=_far_q()),
        "far_people": Count("employee_id", distinct=True, filter=_far_q()),
        "unplaced": Count("id", filter=Q(dist_m__isnull=True)),
        "odd": Count("id", filter=_odd_q()),
        "odd_people": Count("employee_id", distinct=True, filter=_odd_q()),
        "p_decided": Count("id", filter=decided),
        "p_median": _Percentile(wait, q=0.5, filter=decided),
        "p_p90": _Percentile(wait, q=0.9, filter=decided),
        "p_within24": Count("id", filter=decided & Q(hr_reviewed_at__lte=F("created_at") + timedelta(hours=24))),
    }


def _totals(scope: Scope, start: date, end: date) -> dict:
    """Every raw aggregate of one window: three queries (sessions, punches, office geo punches)."""
    sessions = _sessions(scope, start, end).annotate(decided_at=_decided_at()).aggregate(**_session_measures())
    punches = _punch_rows(scope, start, end).aggregate(**_punch_measures())
    office = _office(scope, start, end).aggregate(
        office=Count("id"), office_people=Count("employee_id", distinct=True), office_days=Count("date", distinct=True)
    )
    return {**sessions, **punches, **office}


def _figures(raw: dict) -> dict:
    """Raw aggregates -> the figures the MD reads. "No data" is None, never 0: a rate needs punches behind it."""
    punches = int(raw.get("punches") or 0)
    approved = int(raw.get("p_approved") or 0)
    rejected = int(raw.get("p_rejected") or 0) + int(raw.get("p_voided") or 0)
    return {
        "sessions": int(raw.get("sessions") or 0),
        "people": int(raw.get("people") or 0),
        "punches": punches,
        "officePunches": int(raw.get("office") or 0),
        "verifiedPct": pct(approved, punches),
        "rejectedPct": pct(rejected, punches),
        "pendingPunches": int(raw.get("p_pending") or 0),
        "medianVerifyHours": _hours(raw.get("p_median")),
        "mockedPunches": int(raw.get("mocked") or 0),
        "farPunches": int(raw.get("far") or 0),
        "oddPunches": int(raw.get("odd") or 0),
    }


# ─── provenance ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _provenance(scope: Scope, period: Period, *, rows: dict[str, int | None]) -> dict[str, dict]:
    filters = [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()]
    return {
        "geo-sessions": prov(
            "geo-sessions",
            "On-duty sessions and people out",
            dataset="On-duty (geo attendance) requests",
            definition=(
                "One session is one request to work away from the unit. It counts on the day it was requested "
                "(Indian time). People out are the different employees with at least one session; participation "
                "is those people ÷ today's active employees in the selection."
            ),
            formula="sessions = requests made in the period; people = distinct employees among them",
            rows=rows.get("sessions"),
            filters=filters,
            caveats=[
                "Employees can start working the moment they ask, before anyone approves, so a session is a request "
                "for approval as well as a day out.",
                "Headcount is today's active employees (there is no headcount history).",
            ],
        ),
        "geo-punches": prov(
            "geo-punches",
            "On-duty punches",
            dataset="On-duty punch verifications",
            definition=(
                "One punch is one of the day's attendance punches taken while on duty: a selfie, the GPS position and "
                "the time the button was pressed. It counts on the day of the punch."
            ),
            formula="punches taken in the period under an on-duty session",
            rows=rows.get("punches"),
            filters=filters,
            caveats=["Only punches that were submitted are here; a punch the employee never made leaves no trace."],
        ),
        "geo-office-punches": prov(
            "geo-office-punches",
            "Office geo punches",
            dataset="Attendance punches tagged geo:auto",
            definition=(
                "Punches made with the phone from inside a unit's geofence instead of the biometric device. They go "
                "straight into attendance, with no photo and no approval."
            ),
            formula="attendance punches with source 'geo:auto' dated in the period",
            rows=rows.get("office"),
            filters=filters,
            caveats=[
                "A punch outside the fence is refused and not stored, so attempts from outside cannot be counted.",
            ],
        ),
        "geo-verification": prov(
            "geo-verification",
            "Verification status",
            dataset="On-duty punch verifications, on-duty requests",
            definition=(
                "Every punch is held until HR approves it. Verified = approved; rejected = HR rejected that punch; "
                "voided = rejected automatically because its whole request was rejected; pending = still waiting. "
                "The four add up to the punches captured."
            ),
            formula="verified % = approved punches ÷ punches captured × 100 (same for rejected, voided, pending)",
            rows=rows.get("punches"),
            filters=filters,
            caveats=[
                "A punch can only be approved after its request is approved, so a request waiting on approval also "
                "holds its punches back.",
            ],
        ),
        "geo-turnaround": prov(
            "geo-turnaround",
            "How long verification takes",
            dataset="On-duty punch verifications, on-duty requests",
            definition=(
                "The median time between a punch being taken and HR deciding it, and between a request being made and "
                "its final decision. The median is used because a few forgotten items would drag an average a long way. "
                "'Within 24 hours' is the share decided in a day."
            ),
            formula="median of (decision time − capture time); punches voided with a rejected request are left out",
            rows=rows.get("decided"),
            filters=filters,
            caveats=["Only decided items are timed; what is still waiting is shown separately as the backlog."],
        ),
        "geo-distance": prov(
            "geo-distance",
            "Distance from the unit",
            dataset="On-duty punch verifications, unit locations (Manage Branches)",
            definition=(
                "The straight-line distance between where a punch was taken and the geofence centre of the "
                "employee's unit. 'At the unit' means inside that unit's radius. A unit with no location set cannot "
                f"place its punches (shown as unknown). More than {_num(FAR_KM)} km is 'far'."
            ),
            formula="haversine distance (great circle) to the unit's geofence centre",
            rows=rows.get("punches"),
            filters=filters,
            caveats=[
                "On-duty work is away from the unit by design: distance says where, not whether it was legitimate.",
                "GPS can be wrong by tens of metres, and a simulated location can be anywhere.",
            ],
        ),
        "geo-previous": prov(
            "geo-previous",
            "Comparison with the previous period",
            dataset="On-duty requests and punches",
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
    return (
        f"No on-duty sessions, on-duty punches or office geo punches were recorded for this selection ({period.label})."
    )


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────────

_METRIC_KEYS = (
    "sessions",
    "people",
    "punches",
    "officePunches",
    "verifiedPct",
    "rejectedPct",
    "pendingPunches",
    "medianVerifyHours",
    "mockedPunches",
    "farPunches",
    "oddPunches",
)


@cached()
def geo_summary(scope: Scope, period: Period) -> dict:
    """Sessions, people out, punches (on duty and in the office), how many were verified, rejected and are waiting, how
    long verification takes and the unusual ones, each against the previous period."""
    previous = period.previous()
    cur_raw = _totals(scope, period.start, period.end)
    prev_raw = _totals(scope, previous.start, previous.end)
    cur, prev = _figures(cur_raw), _figures(prev_raw)
    headcount = scope.employees().count()

    def metric(key: str) -> dict:
        return {"value": cur[key], "previous": prev[key], "change": change(cur[key], prev[key])}

    nothing = not (cur["sessions"] or cur["punches"] or cur["officePunches"])
    notes = [_no_data_note(period)] if nothing else []
    if period.end >= _today():
        notes.append("Today is still in progress, so the latest day is partial.")
    entries = _provenance(
        scope,
        period,
        rows={
            "sessions": cur["sessions"],
            "punches": cur["punches"],
            "office": cur["officePunches"],
            "decided": int(cur_raw["p_decided"] or 0),
        },
    )
    return envelope(
        {
            "metrics": {key: metric(key) for key in _METRIC_KEYS},
            "headcount": headcount,
            "participationPct": pct(int(cur_raw["active_people"] or 0), headcount),
            "officePeople": int(cur_raw["office_people"] or 0),
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "geo-sessions",
            "geo-punches",
            "geo-office-punches",
            "geo-verification",
            "geo-turnaround",
            "geo-distance",
            "geo-previous",
        ),
        notes=notes,
    )


# ─── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def _daily(scope: Scope, start: date, end: date) -> dict[date, dict]:
    """{factory day: raw counts}: sessions requested, punches by status, office geo punches. Three queries."""
    days: dict[date, dict] = {}

    def row(d: date) -> dict:
        return days.setdefault(
            d,
            {"sessions": 0, "punches": 0, "p_approved": 0, "p_rejected": 0, "p_pending": 0, "mocked": 0, "office": 0},
        )

    sessions = (
        _sessions(scope, start, end)
        .annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("d")
        .annotate(n=Count("id"))
        .order_by()
    )
    for r in sessions:
        row(r["d"])["sessions"] += r["n"]
    punches = (
        _punch_rows(scope, start, end)
        .values("punch_date")
        .annotate(
            n=Count("id"),
            approved=Count("id", filter=Q(status=_PS.STATUS_APPROVED)),
            rejected=Count("id", filter=_rejected_q() | _voided_q()),
            pending=Count("id", filter=Q(status=_PS.STATUS_PENDING)),
            mocked=Count("id", filter=Q(is_mocked=True)),
        )
        .order_by()
    )
    for r in punches:
        d = row(r["punch_date"])
        d["punches"] += r["n"]
        d["p_approved"] += r["approved"]
        d["p_rejected"] += r["rejected"]
        d["p_pending"] += r["pending"]
        d["mocked"] += r["mocked"]
    for r in _office(scope, start, end).values("date").annotate(n=Count("id")).order_by():
        row(r["date"])["office"] += r["n"]
    return days


_DAY_KEYS = ("sessions", "punches", "p_approved", "p_rejected", "p_pending", "mocked", "office")


def _sum_days(per_day: dict[date, dict], start: date, end: date) -> dict:
    total = dict.fromkeys(_DAY_KEYS, 0)
    d = start
    while d <= end:
        for key, value in (per_day.get(d) or {}).items():
            total[key] += value
        d += timedelta(days=1)
    return total


def _point(first_day: date, days: int, raw: dict) -> dict:
    return {
        "date": first_day.isoformat(),
        "days": days,
        "sessions": raw["sessions"],
        "punches": raw["punches"],
        "approved": raw["p_approved"],
        "rejected": raw["p_rejected"],
        "pending": raw["p_pending"],
        "officePunches": raw["office"],
        "maSessions": None,
    }


def _momentum(per_day: dict[date, dict], end: date) -> dict:
    """Is on-duty use rising or falling? Sessions in the last 7 days of the period against the 7 days before. A verdict
    needs a few sessions on one side at least; otherwise it says it cannot tell."""
    window = MOVING_AVERAGE_DAYS
    cur_start = end - timedelta(days=window - 1)
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=window - 1)
    cur = _sum_days(per_day, cur_start, end)["sessions"]
    prev = _sum_days(per_day, prev_start, prev_end)["sessions"]
    delta = change(cur, prev)
    if cur + prev < MIN_SAMPLE_SESSIONS or delta is None:
        verdict, text = (
            "unclear",
            f"Too few on-duty sessions in the last {window} days and the {window} before to see a direction.",
        )
    elif prev and abs(delta["abs"]) >= max(2, 0.25 * prev):
        rising = delta["abs"] > 0
        verdict = "rising" if rising else "falling"
        text = (
            f"On-duty requests are {'rising' if rising else 'falling'}: {_num(cur)} in the last {window} days "
            f"against {_num(prev)} in the {window} before."
        )
    elif not prev and cur >= MIN_SAMPLE_SESSIONS:
        verdict, text = (
            "rising",
            f"On-duty requests are rising: {_num(cur)} in the last {window} days, none in the {window} before.",
        )
    else:
        verdict = "steady"
        text = f"On-duty requests are steady: {_num(cur)} in the last {window} days against {_num(prev)} in the {window} before."
    return {
        "windowDays": window,
        "verdict": verdict,
        "text": text,
        "current": {"start": cur_start.isoformat(), "end": end.isoformat(), "sessions": cur},
        "previous": {"start": prev_start.isoformat(), "end": prev_end.isoformat(), "sessions": prev},
        "sessionsChange": delta,
    }


@cached()
def geo_trend(scope: Scope, period: Period) -> dict:
    """Sessions, on-duty punches (verified / rejected / waiting) and office geo punches day by day (week by week beyond
    62 days), a 7-day average of sessions and a verdict on whether on-duty use is rising or falling."""
    window = MOVING_AVERAGE_DAYS
    first = min(period.start, period.end - timedelta(days=2 * window - 1)) - timedelta(days=window - 1)
    per_day = _daily(scope, first, period.end)
    period_days = [period.start + timedelta(days=n) for n in range(period.days)]
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    points: list[dict] = []
    if weekly:
        by_week: dict[date, list[date]] = {}
        for d in period_days:
            by_week.setdefault(d - timedelta(days=d.weekday()), []).append(d)
        for days in by_week.values():
            raw = dict.fromkeys(_DAY_KEYS, 0)
            for d in days:
                for key, value in (per_day.get(d) or {}).items():
                    raw[key] += value
            points.append(_point(days[0], len(days), raw))
    else:
        for d in period_days:
            point = _point(d, 1, per_day.get(d) or dict.fromkeys(_DAY_KEYS, 0))
            ma = _sum_days(per_day, d - timedelta(days=window - 1), d)["sessions"]
            point["maSessions"] = round(ma / window, 1)
            points.append(point)

    total = _sum_days(per_day, period.start, period.end)
    busiest = None
    if not weekly:
        candidates = [p for p in points if p["sessions"] > 0]
        if candidates:
            top = max(candidates, key=lambda p: (p["sessions"], p["punches"], p["date"]))
            busiest = {key: top[key] for key in ("date", "sessions", "punches")}
    nothing = not (total["sessions"] or total["punches"] or total["office"])
    entries = _provenance(
        scope, period, rows={"sessions": total["sessions"], "punches": total["punches"], "office": total["office"]}
    )
    entries["geo-trend"] = prov(
        "geo-trend",
        "Trend",
        dataset="On-duty requests and punches, attendance punches tagged geo:auto",
        definition=(
            "Sessions count on the day they were requested, punches on the day they were taken, split by what HR has "
            "decided so far. The 7-day average adds up the last 7 calendar days' sessions ÷ 7. Periods over "
            f"{WEEKLY_ROLLUP_AFTER_DAYS} days are shown by week (Monday to Sunday) with no moving average."
        ),
        formula="rising / falling compares sessions in the last 7 days of the period with the 7 days before",
        rows=total["sessions"] + total["punches"],
        filters=[period.label, scope.describe()],
        caveats=[
            "The 'waiting' part of a day shrinks as HR decides, so recent days always show more waiting.",
            f"A verdict needs at least {MIN_SAMPLE_SESSIONS} sessions across the two weeks.",
        ],
    )
    return envelope(
        {
            "granularity": "week" if weekly else "day",
            "points": points,
            "momentum": _momentum(per_day, period.end),
            "busiestDay": busiest,
        },
        period=period,
        scope=scope,
        provenance=[entries["geo-trend"], *_pick(entries, "geo-sessions", "geo-punches", "geo-office-punches")],
        notes=[_no_data_note(period)] if nothing else [],
    )


# ─── verification: status, how long it takes, what is waiting ───────────────────────────────────────────────────────


def _backlog(scope: Scope, now: datetime) -> dict:
    """What is waiting for HR right now, whenever it was captured: counts, the oldest, and by age. Two queries."""
    edges = [now - timedelta(hours=h) for h in AGE_EDGES_HOURS]  # 24 h, 48 h, 7 days ago (newest edge first)

    def aged(model_qs):
        return model_qs.aggregate(
            n=Count("id"),
            oldest=Min("created_at"),
            b0=Count("id", filter=Q(created_at__gte=edges[0])),
            b1=Count("id", filter=Q(created_at__lt=edges[0], created_at__gte=edges[1])),
            b2=Count("id", filter=Q(created_at__lt=edges[1], created_at__gte=edges[2])),
            b3=Count("id", filter=Q(created_at__lt=edges[2])),
        )

    punches = aged(OnDutyPunchVerification.objects.filter(scope.employee_q("employee__"), status=_PS.STATUS_PENDING))
    sessions = aged(OnDutySession.objects.filter(scope.employee_q("employee__"), status__in=_PENDING_SESSION))

    def oldest_hours(raw: dict) -> float | None:
        return _hours((now - raw["oldest"]).total_seconds()) if raw["oldest"] else None

    labels = ["Under a day", "1 to 2 days", "2 to 7 days", "Over a week"]
    return {
        "pendingPunches": punches["n"],
        "pendingSessions": sessions["n"],
        "oldestPunchHours": oldest_hours(punches),
        "oldestSessionHours": oldest_hours(sessions),
        "overdueHours": OVERDUE_HOURS,
        "overduePunches": punches["b1"] + punches["b2"] + punches["b3"],
        "overdueSessions": sessions["b1"] + sessions["b2"] + sessions["b3"],
        "ageBuckets": [
            {"label": label, "punches": punches[f"b{i}"], "sessions": sessions[f"b{i}"]}
            for i, label in enumerate(labels)
        ],
    }


def _timing(raw: dict, prefix: str) -> dict:
    decided = int(raw.get(f"{prefix}_decided") or 0)
    return {
        "decided": decided,
        "medianHours": _hours(raw.get(f"{prefix}_median")),
        "p90Hours": _hours(raw.get(f"{prefix}_p90")),
        "within24hPct": pct(int(raw.get(f"{prefix}_within24") or 0), decided),
    }


@cached()
def geo_verification(scope: Scope, period: Period) -> dict:
    """Where requests and punches stand (pending / verified / rejected / voided), how long HR takes to decide, and what
    is waiting right now (whenever it was captured) with how long it has waited."""
    now = now_utc()
    raw = _totals(scope, period.start, period.end)
    backlog = _backlog(scope, now)
    punches = int(raw["punches"] or 0)
    rejected = int(raw["p_rejected"] or 0)
    voided = int(raw["p_voided"] or 0)
    entries = _provenance(
        scope,
        period,
        rows={"sessions": raw["sessions"], "punches": punches, "decided": int(raw["p_decided"] or 0)},
    )
    entries["geo-backlog"] = prov(
        "geo-backlog",
        "Waiting for HR now",
        dataset="On-duty punch verifications, on-duty requests",
        definition=(
            "Punches and requests still pending at this moment, whenever they were captured (the period does not "
            f"apply). Overdue means waiting more than {OVERDUE_HOURS} hours; the age chart splits them by how long."
        ),
        formula="pending items now; age = now − captured / requested",
        rows=backlog["pendingPunches"] + backlog["pendingSessions"],
        filters=[scope.describe()],
        caveats=["A punch waits for its request to be approved first, so the same delay can show in both."],
    )
    notes = []
    if not (raw["sessions"] or punches):
        notes.append(f"No on-duty sessions or punches were recorded for this selection ({period.label}).")
    return envelope(
        {
            "sessions": {
                "requested": int(raw["sessions"] or 0),
                "awaitingHod": int(raw["awaiting_hod"] or 0),
                "awaitingHr": int(raw["awaiting_hr"] or 0),
                "approved": int(raw["active"] or 0) + int(raw["completed"] or 0),
                "active": int(raw["active"] or 0),
                "completed": int(raw["completed"] or 0),
                "rejected": int(raw["rejected"] or 0),
            },
            "punches": {
                "captured": punches,
                "approved": int(raw["p_approved"] or 0),
                "rejected": rejected,
                "voided": voided,
                "pending": int(raw["p_pending"] or 0),
            },
            "verifiedPct": pct(int(raw["p_approved"] or 0), punches),
            "rejectedPct": pct(rejected + voided, punches),
            "decisionTime": {"punches": _timing(raw, "p"), "requests": _timing(raw, "s")},
            "backlog": backlog,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "geo-verification", "geo-turnaround", "geo-backlog"),
        notes=notes,
    )


# ─── comparison by department, unit or staff/production ─────────────────────────────────────────────────────────────

#: by -> (field on a session or punch, field on Employee, label for "no value")
_GROUPS = {
    "department": ("employee__department__name", "department__name", "No department"),
    "unit": ("employee__branch__name", "branch__name", "No unit"),
    "type": ("employee__employment_type", "employment_type", "Not set"),
}
_TYPE_LABEL = {"staff": "Staff", "production": "Production"}
NONE_KEY = "__none__"
BY_CHOICES = tuple(_GROUPS)


@cached()
def geo_breakdown(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    """Who goes out, by department (the same name in several units is one department), unit, or staff vs production:
    sessions, people, participation, punches, rejections and unusual punches, ranked by sessions."""
    if by not in _GROUPS:
        raise MdParamError(f"'by' must be one of: {', '.join(BY_CHOICES)}.")
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    field, emp_field, none_label = _GROUPS[by]
    previous = period.previous()

    def sessions_by(start: date, end: date) -> dict:
        qs = (
            _sessions(scope, start, end)
            .values(grp=F(field))
            .annotate(
                n=Count("id"),
                people=Count("employee_id", distinct=True),
                active_people=Count("employee_id", distinct=True, filter=Q(employee__status="active")),
                rejected=Count("id", filter=Q(status=OnDutySession.STATUS_REJECTED)),
            )
            .order_by()
        )
        return {r["grp"]: r for r in qs}

    def punches_by(start: date, end: date) -> dict:
        qs = (
            _punch_rows(scope, start, end)
            .values(grp=F(field))
            .annotate(
                n=Count("id"),
                rejected=Count("id", filter=_rejected_q() | _voided_q()),
                mocked=Count("id", filter=Q(is_mocked=True)),
                far=Count("id", filter=_far_q()),
            )
            .order_by()
        )
        return {r["grp"]: r for r in qs}

    cur_s, prev_s = sessions_by(period.start, period.end), sessions_by(previous.start, previous.end)
    cur_p = punches_by(period.start, period.end)
    heads = dict(scope.employees().values_list(emp_field).annotate(n=Count("id")).order_by())
    total_sessions = sum(r["n"] for r in cur_s.values())
    rows = []
    for grp in set(cur_s) | set(cur_p):  # only groups with on-duty activity: who never goes out is not a finding
        key = NONE_KEY if grp is None or grp == "" else str(grp)
        label = (
            none_label if key == NONE_KEY else (_TYPE_LABEL.get(grp, str(grp).title()) if by == "type" else str(grp))
        )
        s = cur_s.get(grp) or {"n": 0, "people": 0, "active_people": 0, "rejected": 0}
        p = cur_p.get(grp) or {"n": 0, "rejected": 0, "mocked": 0, "far": 0}
        head = int(heads.get(grp, 0))
        prev_n = (prev_s.get(grp) or {"n": 0})["n"]
        rows.append(
            {
                "key": key,
                "label": label,
                "headcount": head,
                "people": s["people"],
                "participationPct": pct(s["active_people"], head),
                "sessions": s["n"],
                "shareOfSessionsPct": pct(s["n"], total_sessions),
                "sessionsPerPerson": round(s["n"] / s["people"], 1) if s["people"] else None,
                "rejectedSessions": s["rejected"],
                "punches": p["n"],
                "rejectedPunches": p["rejected"],
                "mockedPunches": p["mocked"],
                "farPunches": p["far"],
                "lowSample": s["n"] < MIN_SAMPLE_SESSIONS,
                "previous": {"sessions": prev_n},
                "change": {"sessions": change(s["n"], prev_n)},
            }
        )
    rows.sort(key=lambda r: (-r["sessions"], -r["punches"], r["label"].lower()))
    entries = _provenance(scope, period, rows={"sessions": total_sessions})
    grouping = prov(
        "geo-grouping",
        "Comparison",
        dataset="On-duty requests and punches, employee list",
        definition=(
            "Sessions and punches are grouped by the department, unit or type each employee belongs to today (there "
            "is no history of transfers). A department with the same name in several units is one department. Ranked "
            "by sessions, most first; participation = active people who went out ÷ active employees in the group "
            "(people who have since left are in 'people' but not in participation)."
        ),
        formula="sessions per group; share = group sessions ÷ all sessions; per person = sessions ÷ people out",
        rows=total_sessions,
        filters=[period.label, scope.describe()],
        caveats=[f"Groups with fewer than {MIN_SAMPLE_SESSIONS} sessions are marked 'small sample'."],
    )
    everyone = _sessions(scope, period.start, period.end).aggregate(
        n=Count("employee_id", distinct=True),
        active=Count("employee_id", distinct=True, filter=Q(employee__status="active")),
    )
    all_people = everyone["n"]
    return envelope(
        {
            "by": by,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "average": {
                "sessions": total_sessions,
                "people": all_people,
                "sessionsPerPerson": round(total_sessions / all_people, 1) if all_people else None,
                "participationPct": pct(everyone["active"], sum(int(h) for h in heads.values())),
            },
            "minSample": MIN_SAMPLE_SESSIONS,
        },
        period=period,
        scope=scope,
        provenance=[grouping, *_pick(entries, "geo-sessions", "geo-previous")],
        notes=[] if total_sessions else [_no_data_note(period)],
    )


# ─── who is out, and how often ──────────────────────────────────────────────────────────────────────────────────────


@cached()
def geo_people(scope: Scope, period: Period, limit: int = LIST_DEFAULT, min_sessions: int = 1) -> dict:
    """The people who went out most in the period: how many sessions on how many days, their on-duty punches and how
    many were rejected, simulated, far from the unit or at odd hours. Names are shown because the MD acts on this list."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    min_sessions = _int_arg(min_sessions, "min_sessions", 1, 1, 1000)
    person = (
        "employee_id",
        "employee__employee_code",
        "employee__first_name",
        "employee__last_name",
        "employee__department__name",
        "employee__branch__name",
        "employee__employment_type",
    )
    sessions = list(
        _sessions(scope, period.start, period.end)
        .annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values(*person)
        .annotate(
            n=Count("id"),
            days=Count("d", distinct=True),
            rejected=Count("id", filter=Q(status=OnDutySession.STATUS_REJECTED)),
            last=Max("d"),
        )
        .filter(n__gte=min_sessions)
        .order_by()
    )
    sessions.sort(key=lambda r: (-r["n"], -r["days"], r["employee__employee_code"] or ""))
    top = sessions[:limit]
    ids = [r["employee_id"] for r in top]
    punches = {}
    if ids:
        punches = {
            r["employee_id"]: r
            for r in _punch_rows(scope, period.start, period.end)
            .filter(employee_id__in=ids)
            .values("employee_id")
            .annotate(
                n=Count("id"),
                rejected=Count("id", filter=_rejected_q()),
                mocked=Count("id", filter=Q(is_mocked=True)),
                far=Count("id", filter=_far_q()),
                odd=Count("id", filter=_odd_q()),
            )
            .order_by()
        }
    rows = []
    for r in top:
        p = punches.get(r["employee_id"]) or {"n": 0, "rejected": 0, "mocked": 0, "far": 0, "odd": 0}
        rows.append(
            {
                "employeeCode": r["employee__employee_code"],
                "employeeName": _name(
                    r["employee__first_name"], r["employee__last_name"], r["employee__employee_code"]
                ),
                "department": r["employee__department__name"] or "No department",
                "unit": r["employee__branch__name"],
                "type": _TYPE_LABEL.get(r["employee__employment_type"], r["employee__employment_type"]),
                "sessions": r["n"],
                "daysOut": r["days"],
                "lastDate": r["last"].isoformat() if r["last"] else None,
                "rejectedSessions": r["rejected"],
                "punches": p["n"],
                "rejectedPunches": p["rejected"],
                "mockedPunches": p["mocked"],
                "farPunches": p["far"],
                "oddPunches": p["odd"],
                "frequent": r["n"] >= FREQUENT_MIN_SESSIONS,
            }
        )
    total_sessions = sum(r["n"] for r in sessions)
    entries = _provenance(scope, period, rows={"sessions": total_sessions})
    ranking = prov(
        "geo-people",
        "Who is out, and how often",
        dataset="On-duty requests and punches, employee list",
        definition=(
            "Employees ranked by on-duty sessions in the period. Days out are the different days they asked on; "
            f"'frequent' means {FREQUENT_MIN_SESSIONS} or more sessions. Rejected, simulated-GPS, far (over "
            f"{_num(FAR_KM)} km from the unit) and odd-hour ({ODD_FROM_HOUR}:00 to {ODD_BEFORE_HOUR:02d}:00) counts are "
            "their punches in the same period."
        ),
        formula="sessions per employee; punches counted separately from sessions",
        rows=total_sessions,
        filters=[period.label, scope.describe()],
        caveats=["People who have since left are included.", "A flag is a reason to look, not a finding."],
    )
    return envelope(
        {
            "threshold": min_sessions,
            "total": len(sessions),
            "frequent": sum(1 for r in sessions if r["n"] >= FREQUENT_MIN_SESSIONS),
            "frequentMin": FREQUENT_MIN_SESSIONS,
            "rows": rows,
            "truncated": len(sessions) > limit,
        },
        period=period,
        scope=scope,
        provenance=[ranking, *_pick(entries, "geo-sessions", "geo-distance")],
        notes=[] if sessions else [f"Nobody went on duty in this period ({period.label})."],
    )


# ─── how far from the unit ──────────────────────────────────────────────────────────────────────────────────────────


def _band_labels() -> list[tuple[str, str]]:
    labels = [("at_unit", "At the unit")]
    low = 0.0
    for edge in BAND_EDGES_KM:
        labels.append((f"upto_{edge:g}", f"{low:g} to {edge:g} km" if low else f"Up to {edge:g} km"))
        low = edge
    labels.append(("beyond", f"Over {BAND_EDGES_KM[-1]:g} km"))
    labels.append(("unknown", "Unit has no location"))
    return labels


@cached()
def geo_reach(scope: Scope, period: Period) -> dict:
    """How far from their unit on-duty punches were taken: at the unit, then 0-2 / 2-10 / 10-50 / 50-100 km and beyond,
    plus the punches that cannot be placed because the unit has no location."""
    radius = Coalesce(F("employee__branch__geofence_radius_m"), Value(DEFAULT_RADIUS_M))
    whens = [
        When(dist_m__isnull=True, then=Value("unknown")),
        When(dist_m__lte=radius, then=Value("at_unit")),
        *[When(dist_m__lte=edge * 1000.0, then=Value(f"upto_{edge:g}")) for edge in BAND_EDGES_KM],
    ]
    rows = {
        r["band"]: r
        for r in _punch_rows(scope, period.start, period.end)
        .annotate(band=Case(*whens, default=Value("beyond")))
        .values("band")
        .annotate(n=Count("id"), people=Count("employee_id", distinct=True))
        .order_by()
    }
    total = sum(r["n"] for r in rows.values())
    farthest = _punch_rows(scope, period.start, period.end).aggregate(m=Max("dist_m"))["m"]
    bands = []
    for key, label in _band_labels():
        r = rows.get(key) or {"n": 0, "people": 0}
        bands.append(
            {"key": key, "label": label, "punches": r["n"], "people": r["people"], "sharePct": pct(r["n"], total)}
        )
    far = rows.get("beyond") or {"n": 0, "people": 0}
    entries = _provenance(scope, period, rows={"punches": total})
    unknown = (rows.get("unknown") or {"n": 0})["n"]
    notes = [] if total else [f"No on-duty punches were recorded for this selection ({period.label})."]
    if unknown:
        notes.append(
            f"{_num(unknown)} of {_num(total)} punches are by people whose unit has no location set (Manage Branches), "
            "so their distance is unknown."
        )
    return envelope(
        {
            "bands": bands,
            "punches": total,
            "farKm": FAR_KM,
            "farPunches": far["n"],
            "farPeople": far["people"],
            "unknownPunches": unknown,
            "farthestKm": round(farthest / 1000.0, 1) if farthest is not None else None,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "geo-distance", "geo-punches"),
        notes=notes,
    )


# ─── unusual sessions ───────────────────────────────────────────────────────────────────────────────────────────────

_REASON_LABEL = {
    "mocked": "Simulated GPS location",
    "far": f"More than {_num(FAR_KM)} km from the unit",
    "odd": f"Punch at odd hours ({ODD_FROM_HOUR}:00 to {ODD_BEFORE_HOUR:02d}:00)",
    "long": f"Open for more than {LONG_SESSION_HOURS} hours",
    "stale": "Still open after its day",
    "rejected": "HR rejected a punch",
}


def _stale_q(today_start: datetime) -> Q:
    """Still punchable, never ended by the employee, and requested on an earlier day than today."""
    return Q(status__in=PUNCHABLE_STATUSES, employee_ended_at__isnull=True, created_at__lt=today_start)


def _session_end(now: datetime):
    """When a session ended: the employee's Done, else the automatic close, else now for one still open; NULL for one
    that was rejected (it never ran)."""
    open_now = Case(
        When(status__in=PUNCHABLE_STATUSES, then=Value(now, output_field=DateTimeField())),
        default=Value(None, output_field=DateTimeField()),
        output_field=DateTimeField(),
    )
    return Coalesce("employee_ended_at", "completed_at", open_now, output_field=DateTimeField())


def _repeat_rejections(scope: Scope, period: Period) -> list[dict]:
    """People with REPEAT_MIN_REJECTIONS or more rejections in the period (requests rejected + punches HR rejected, a
    punch voided with its rejected request is not counted twice), most first. Two queries."""
    counts: dict[int, list[int]] = {}
    sessions = (
        _sessions(scope, period.start, period.end)
        .filter(status=OnDutySession.STATUS_REJECTED)
        .values("employee_id")
        .annotate(n=Count("id"))
        .order_by()
    )
    for r in sessions:
        counts.setdefault(r["employee_id"], [0, 0])[0] += r["n"]
    punches = (
        _punch_rows(scope, period.start, period.end)
        .filter(_rejected_q())
        .values("employee_id")
        .annotate(n=Count("id"))
        .order_by()
    )
    for r in punches:
        counts.setdefault(r["employee_id"], [0, 0])[1] += r["n"]
    return [
        {"employeeId": eid, "rejectedSessions": s, "rejectedPunches": p, "rejections": s + p}
        for eid, (s, p) in counts.items()
        if s + p >= REPEAT_MIN_REJECTIONS
    ]


@cached()
def geo_unusual(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """The on-duty sessions that look unusual, with the reason(s): a simulated GPS location, punches far from the unit
    or at odd hours, a session open for very long or past its day, punches HR rejected; and the people with repeated
    rejections. A reason to look, not a finding."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    now = now_utc()
    today_start = _bounds(_today(now), _today(now))[0]
    flags: dict[int, dict[str, int]] = {}

    flagged_punches = (
        _punch_rows(scope, period.start, period.end)
        .values("session_id")
        .annotate(
            mocked=Count("id", filter=Q(is_mocked=True)),
            far=Count("id", filter=_far_q()),
            odd=Count("id", filter=_odd_q()),
            rejected=Count("id", filter=_rejected_q()),
            farthest=Max("dist_m"),
        )
        .filter(Q(mocked__gt=0) | Q(far__gt=0) | Q(odd__gt=0) | Q(rejected__gt=0))
        .order_by()
    )
    farthest: dict[int, float] = {}
    for r in flagged_punches:
        entry = flags.setdefault(r["session_id"], {})
        for code in ("mocked", "far", "odd", "rejected"):
            if r[code]:
                entry[code] = r[code]
        if r["far"] and r["farthest"] is not None:
            farthest[r["session_id"]] = r["farthest"]

    elapsed = _seconds(F("end_at") - Coalesce("started_at", "created_at", output_field=DateTimeField()))
    long_q = Q(elapsed__gt=LONG_SESSION_HOURS * 3600)
    stale = _stale_q(today_start)
    flagged_sessions = (
        _sessions(scope, period.start, period.end)
        .annotate(end_at=_session_end(now))
        .annotate(elapsed=elapsed)
        .filter(long_q | stale)
        .annotate(is_stale=Case(When(stale, then=Value(True)), default=Value(False)))
        .values("id", "elapsed", "is_stale")
    )
    for r in flagged_sessions:
        entry = flags.setdefault(r["id"], {})
        if r["elapsed"] is not None and r["elapsed"] > LONG_SESSION_HOURS * 3600:
            entry["long"] = int(r["elapsed"])
        if r["is_stale"]:
            entry["stale"] = 1

    counts = {code: sum(1 for f in flags.values() if code in f) for code in _REASON_LABEL}

    def severity(codes: dict[str, int]) -> str:
        if "mocked" in codes:
            return "critical"
        if len(codes) >= 2 or codes.keys() & {"far", "long", "stale", "rejected"}:
            return "warning"
        return "info"

    ranked = sorted(flags.items(), key=lambda kv: (_SEVERITY_RANK[severity(kv[1])], -len(kv[1]), -kv[0]))
    top_ids = [sid for sid, _ in ranked[:limit]]
    rows = []
    if top_ids:
        details = {
            r["id"]: r
            for r in OnDutySession.objects.filter(id__in=top_ids)
            .annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
            .values(
                "id",
                "d",
                "destination",
                "status",
                "employee__employee_code",
                "employee__first_name",
                "employee__last_name",
                "employee__department__name",
                "employee__branch__name",
            )
        }
        for sid in top_ids:
            r, codes = details[sid], flags[sid]
            reasons = []
            for code in _REASON_LABEL:
                if code not in codes:
                    continue
                n = codes[code]
                label = _REASON_LABEL[code]
                if code in ("mocked", "far", "odd", "rejected"):
                    label = f"{label} ({_num(n)} {_plural(n, 'punch', 'punches')})"
                elif code == "long":
                    label = f"{label} ({_num(n / 3600, 1)} h)"
                if code == "far" and sid in farthest:
                    label += f", farthest {_num(farthest[sid] / 1000, 0)} km"
                reasons.append({"code": code, "label": label})
            rows.append(
                {
                    "sessionId": sid,
                    "employeeCode": r["employee__employee_code"],
                    "employeeName": _name(
                        r["employee__first_name"], r["employee__last_name"], r["employee__employee_code"]
                    ),
                    "department": r["employee__department__name"] or "No department",
                    "unit": r["employee__branch__name"],
                    "date": r["d"].isoformat() if r["d"] else None,
                    "destination": (r["destination"] or "")[:120],
                    "status": r["status"],
                    "severity": severity(codes),
                    "reasons": reasons,
                }
            )

    repeaters = sorted(_repeat_rejections(scope, period), key=lambda x: (-x["rejections"], x["employeeId"]))
    repeat_rows = []
    if repeaters[:limit]:
        names = {
            r["id"]: r
            for r in Employee.objects.filter(id__in=[x["employeeId"] for x in repeaters[:limit]]).values(
                "id", "employee_code", "first_name", "last_name", "department__name", "branch__name"
            )
        }
        for x in repeaters[:limit]:
            e = names[x["employeeId"]]
            repeat_rows.append(
                {
                    "employeeCode": e["employee_code"],
                    "employeeName": _name(e["first_name"], e["last_name"], e["employee_code"]),
                    "department": e["department__name"] or "No department",
                    "unit": e["branch__name"],
                    "rejectedSessions": x["rejectedSessions"],
                    "rejectedPunches": x["rejectedPunches"],
                    "rejections": x["rejections"],
                }
            )
    entries = _provenance(scope, period, rows={"sessions": len(flags)})
    rules = prov(
        "geo-unusual",
        "What counts as unusual",
        dataset="On-duty requests and punches, unit locations",
        definition=(
            "A session is listed when one of these is true: a punch used a simulated (mock) GPS location; a punch was "
            f"more than {_num(FAR_KM)} km from the unit; a punch was taken at {ODD_FROM_HOUR}:00 or later or before "
            f"{ODD_BEFORE_HOUR:02d}:00; the session stayed open more than {LONG_SESSION_HOURS} hours; it is still open "
            "although it was requested on an earlier day (the 11 pm close should have ended it); HR rejected one of its "
            f"punches. A person is listed for repeated rejections at {REPEAT_MIN_REJECTIONS} or more (requests rejected "
            "plus punches rejected; punches voided with a rejected request are not counted again)."
        ),
        formula="simple rules over the sessions and punches of the period; critical = simulated GPS",
        rows=len(flags),
        filters=[period.label, scope.describe()],
        caveats=[
            "Each rule is a reason to look, not proof of anything: a field visit can legitimately be far or late.",
            "GPS coordinates are not shown here; the photo and map are on the Operations tab.",
        ],
    )
    return envelope(
        {
            "counts": {
                "sessionsFlagged": len(flags),
                "mockedSessions": counts["mocked"],
                "farSessions": counts["far"],
                "oddSessions": counts["odd"],
                "longSessions": counts["long"],
                "staleSessions": counts["stale"],
                "rejectedPunchSessions": counts["rejected"],
                "repeatRejectedPeople": len(repeaters),
            },
            "rows": rows,
            "truncated": len(flags) > limit,
            "repeatRejected": repeat_rows,
            "thresholds": {
                "longSessionHours": LONG_SESSION_HOURS,
                "farKm": FAR_KM,
                "oddFromHour": ODD_FROM_HOUR,
                "oddBeforeHour": ODD_BEFORE_HOUR,
                "repeatMinRejections": REPEAT_MIN_REJECTIONS,
            },
        },
        period=period,
        scope=scope,
        provenance=[rules, *_pick(entries, "geo-distance")],
        notes=[] if flags or repeaters else [f"Nothing unusual was found in this period ({period.label})."],
    )


# ─── who is on duty now ─────────────────────────────────────────────────────────────────────────────────────────────


@cached(20)
def geo_live(scope: Scope) -> dict:
    """The live picture: everyone with an on-duty session still open, how long they have been out, their punches so
    far, and when their phone last reported a location (employees tracked by the app only). Names are shown."""
    now = now_utc()
    today = _today(now)
    today_start = _bounds(today, today)[0]
    open_qs = OnDutySession.objects.filter(
        scope.employee_q("employee__"), status__in=PUNCHABLE_STATUSES, employee_ended_at__isnull=True
    )
    rows_raw = list(
        open_qs.order_by("created_at").values(
            "id",
            "employee_id",
            "employee__employee_code",
            "employee__first_name",
            "employee__last_name",
            "employee__department__name",
            "employee__branch__name",
            "employee__branch__geofence_lat",
            "employee__branch__geofence_lng",
            "employee__location_tracking_enabled",
            "destination",
            "status",
            "created_at",
        )[: LIVE_MAX + 1]
    )
    total_open = open_qs.count()
    rows_raw = rows_raw[:LIVE_MAX]
    session_ids = [r["id"] for r in rows_raw]
    employee_ids = [r["employee_id"] for r in rows_raw]

    punches = {}
    if session_ids:
        punches = {
            r["session_id"]: r
            for r in OnDutyPunchVerification.objects.filter(session_id__in=session_ids, punch_date=today)
            .values("session_id")
            .annotate(
                n=Count("id"),
                last=Max("punch_time"),
                pending=Count("id", filter=Q(status=_PS.STATUS_PENDING)),
                mocked=Count("id", filter=Q(is_mocked=True)),
            )
            .order_by()
        }
    pings = {}
    if employee_ids:
        pings = {
            r["employee_id"]: r
            for r in LiveLocationPing.objects.filter(
                employee_id__in=employee_ids, recorded_at__gte=now - timedelta(hours=PING_RETENTION_HOURS)
            )
            .order_by("employee_id", "-recorded_at")
            .distinct("employee_id")
            .values("employee_id", "recorded_at", "latitude", "longitude", "is_mocked")
        }
    rows = []
    stats = {"today": 0, "stale": 0, "awaiting": 0, "withSignal": 0, "silent": 0}
    for r in rows_raw:
        stale = r["created_at"] < today_start
        provisional = r["status"] in _PENDING_SESSION
        tracked = bool(r["employee__location_tracking_enabled"])
        ping = pings.get(r["employee_id"])
        minutes_since = int((now - ping["recorded_at"]).total_seconds() // 60) if ping else None
        distance_km = None
        if ping and r["employee__branch__geofence_lat"] is not None and r["employee__branch__geofence_lng"] is not None:
            distance_km = round(
                haversine_distance_m(
                    float(ping["latitude"]),
                    float(ping["longitude"]),
                    float(r["employee__branch__geofence_lat"]),
                    float(r["employee__branch__geofence_lng"]),
                )
                / 1000.0,
                1,
            )
        p = punches.get(r["id"]) or {"n": 0, "last": None, "pending": 0, "mocked": 0}
        stats["stale" if stale else "today"] += 1
        stats["awaiting"] += 1 if provisional else 0
        if ping and minutes_since is not None and minutes_since <= SILENT_MINUTES:
            stats["withSignal"] += 1
        elif tracked or ping:
            stats["silent"] += 1
        rows.append(
            {
                "employeeCode": r["employee__employee_code"],
                "employeeName": _name(
                    r["employee__first_name"], r["employee__last_name"], r["employee__employee_code"]
                ),
                "department": r["employee__department__name"] or "No department",
                "unit": r["employee__branch__name"],
                "destination": (r["destination"] or "")[:120],
                "since": _wall(r["created_at"]),
                "minutesOut": int((now - r["created_at"]).total_seconds() // 60),
                "stale": stale,
                "approved": not provisional,
                "punchesToday": p["n"],
                "pendingPunches": p["pending"],
                "lastPunch": p["last"].strftime("%H:%M") if p["last"] else None,
                "mockedPunches": p["mocked"],
                "tracked": tracked,
                "lastSeen": _wall(ping["recorded_at"]) if ping else None,
                "minutesSinceSeen": minutes_since,
                "lastSeenMocked": bool(ping["is_mocked"]) if ping else False,
                "distanceFromUnitKm": distance_km,
            }
        )
    headcount = scope.employees().count()
    out_people = len({r["employee_id"] for r in rows_raw})
    entry = prov(
        "geo-live",
        "On duty now",
        dataset="On-duty requests, location pings, unit locations",
        definition=(
            "Everyone whose on-duty session is open: requested (approved or not) and not yet ended by them, by the "
            "11 pm close or by their fourth punch. 'Last seen' is the newest location ping from the app, which only "
            f"reports for people tracked or on duty; older than {SILENT_MINUTES} minutes counts as no signal. "
            "A session still open from an earlier day is shown as left open."
        ),
        formula="open sessions now; out % = people out ÷ active employees in the selection",
        rows=len(rows_raw),
        filters=[scope.describe()],
        caveats=[
            f"Location pings are kept for {PING_RETENTION_HOURS} hours only.",
            "Distance is from the last ping to the unit's geofence centre; it is not shown when either is missing.",
        ],
    )
    return envelope(
        {
            "asOf": _wall(now),
            "onDutyNow": stats["today"],
            "leftOpen": stats["stale"],
            "awaitingApproval": stats["awaiting"],
            "withSignal": stats["withSignal"],
            "noSignal": stats["silent"],
            "silentMinutes": SILENT_MINUTES,
            "activeHeadcount": headcount,
            "outPct": pct(out_people, headcount),
            "rows": rows,
            "total": total_open,
            "truncated": total_open > len(rows),
        },
        scope=scope,
        provenance=[entry],
        notes=[] if rows else ["Nobody has an open on-duty session right now."],
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ──────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"geo.{id_}",
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
    summary = geo_summary(scope, period)
    m = summary["metrics"]
    unusual = geo_unusual(scope, period, limit=1)
    verification = geo_verification(scope, period)
    counts, backlog = unusual["counts"], verification["backlog"]
    raw_mocked = m["mockedPunches"]["value"]
    items: list[dict] = []

    if raw_mocked:
        people = _mocked_people(scope, period)
        items.append(
            _item(
                "mocked",
                "critical" if raw_mocked >= MOCKED_CRITICAL_MIN else "warning",
                f"{_num(raw_mocked)} on-duty {_plural(raw_mocked, 'punch used', 'punches used')} a simulated GPS location",
                f"{period.label}: {_num(people)} {_plural(people, 'person', 'people')}. A simulated location means the "
                "position the app reported is not real, so the photo is the only evidence: check them before approving.",
                _num(raw_mocked),
                f"Which on-duty punches used a simulated GPS location ({period.label}), who took them and were they approved?",
            )
        )

    waiting = backlog["overduePunches"] + backlog["overdueSessions"]
    if waiting:
        oldest = max(backlog["oldestPunchHours"] or 0, backlog["oldestSessionHours"] or 0)
        punches_waiting, sessions_waiting = backlog["overduePunches"], backlog["overdueSessions"]
        parts = []
        if punches_waiting:
            parts.append(f"{_num(punches_waiting)} {_plural(punches_waiting, 'punch', 'punches')}")
        if sessions_waiting:
            parts.append(f"{_num(sessions_waiting)} {_plural(sessions_waiting, 'request')}")
        items.append(
            _item(
                "backlog",
                "critical" if oldest >= CRITICAL_BACKLOG_DAYS * 24 else "warning",
                f"{' and '.join(parts)} waiting more than {OVERDUE_HOURS // 24} days for HR",
                f"The oldest has waited {_hours_text(oldest)}. Until HR decides, on-duty days do not count as attendance.",
                _hours_text(oldest),
                "Which on-duty requests and punches have been waiting for HR the longest, and for which departments?",
            )
        )

    repeat = counts["repeatRejectedPeople"]
    if repeat:
        items.append(
            _item(
                "rejections",
                "warning",
                f"{_num(repeat)} {_plural(repeat, 'person had', 'people had')} {REPEAT_MIN_REJECTIONS} or more on-duty "
                "rejections",
                f"{period.label}: requests or punches HR rejected, more than once for the same person.",
                _num(repeat),
                f"Who had repeated on-duty rejections ({period.label}) and what were the reasons?",
            )
        )

    stale = counts["staleSessions"]
    if stale:
        items.append(
            _item(
                "stale",
                "warning",
                f"{_num(stale)} on-duty {_plural(stale, 'session is', 'sessions are')} still open after {_plural(stale, 'its', 'their')} day",
                "The 11 pm day-end close should have ended them: either it did not run, or the session was reopened.",
                _num(stale),
                f"Which on-duty sessions are still open from earlier days ({period.label})?",
            )
        )

    decided = verification["decisionTime"]["punches"]
    if (
        decided["decided"] >= MIN_DECIDED
        and decided["medianHours"] is not None
        and decided["medianHours"] > SLOW_VERIFY_HOURS
    ):
        items.append(
            _item(
                "slow",
                "warning",
                f"HR takes {_hours_text(decided['medianHours'])} to verify an on-duty punch",
                f"{period.label}: the median over {_num(decided['decided'])} decided punches; "
                f"{_p(decided['within24hPct'])} were decided within a day.",
                _hours_text(decided["medianHours"]),
                f"Why is on-duty punch verification slow ({period.label}) and which departments wait longest?",
            )
        )

    rejected_pct = m["rejectedPct"]["value"]
    verified_n = verification["punches"]
    decided_n = verified_n["approved"] + verified_n["rejected"] + verified_n["voided"]
    if rejected_pct is not None and decided_n >= MIN_DECIDED and rejected_pct >= HIGH_REJECTION_PCT:
        rejected_n = verified_n["rejected"] + verified_n["voided"]
        items.append(
            _item(
                "rejection-rate",
                "warning",
                f"{_p(rejected_pct, 1)} of on-duty punches were rejected",
                f"{period.label}: {_num(rejected_n)} of {_num(verified_n['captured'])} punches were rejected or voided.",
                _p(rejected_pct, 1),
                f"Why are so many on-duty punches rejected ({period.label}) and who do they belong to?",
            )
        )

    far = m["farPunches"]["value"]
    if far:
        items.append(
            _item(
                "far",
                "info",
                f"{_num(far)} on-duty {_plural(far, 'punch was', 'punches were')} more than {_num(FAR_KM)} km from the unit",
                f"{period.label}. Field visits can be far; worth checking that the destination explains it.",
                _num(far),
                f"Which on-duty punches were more than {_num(FAR_KM)} km from the unit ({period.label}), by whom and where to?",
            )
        )

    long_n = counts["longSessions"]
    if long_n:
        items.append(
            _item(
                "long",
                "info",
                f"{_num(long_n)} on-duty {_plural(long_n, 'session ran', 'sessions ran')} longer than {LONG_SESSION_HOURS} hours",
                f"{period.label}: open from the request until the employee or the 11 pm close ended it.",
                _num(long_n),
                f"Which on-duty sessions ran longer than {LONG_SESSION_HOURS} hours ({period.label})?",
            )
        )

    odd = m["oddPunches"]["value"]
    if odd:
        items.append(
            _item(
                "odd-hours",
                "info",
                f"{_num(odd)} on-duty {_plural(odd, 'punch was', 'punches were')} taken at odd hours",
                f"{period.label}: at {ODD_FROM_HOUR}:00 or later, or before {ODD_BEFORE_HOUR:02d}:00.",
                _num(odd),
                f"Who took on-duty punches at odd hours ({period.label})?",
            )
        )

    sessions, previous = m["sessions"]["value"], m["sessions"]["previous"]
    if sessions - previous >= SURGE_MIN_EXTRA and previous and 100.0 * (sessions - previous) / previous >= SURGE_PCT:
        items.append(
            _item(
                "surge",
                "info",
                f"On-duty requests rose to {_num(sessions)} from {_num(previous)}",
                f"{period.label} against {_previous_phrase(period)}.",
                f"+{_num(sessions - previous)}",
                f"Why did on-duty requests rise from {_num(previous)} to {_num(sessions)} ({period.label}), and where?",
            )
        )

    if not items and sessions:
        items.append(
            _item(
                "healthy",
                "good",
                "No on-duty exceptions",
                f"{period.label}: {_num(sessions)} {_plural(sessions, 'session')}, none of them unusual, and nothing "
                "is waiting too long for HR.",
                None,
                f"Summarise on-duty attendance ({period.label}).",
            )
        )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


def _mocked_people(scope: Scope, period: Period) -> int:
    return int(
        _punch_rows(scope, period.start, period.end)
        .filter(is_mocked=True)
        .aggregate(n=Count("employee_id", distinct=True))["n"]
    )


@cached()
def geo_attention(scope: Scope, period: Period) -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    items = _exceptions(scope, period, limit=6)
    rules = prov(
        "geo-attention",
        "Needs your attention",
        dataset="On-duty requests and punches, unit locations",
        definition=(
            f"Flagged: any simulated-GPS punch (critical from {MOCKED_CRITICAL_MIN}); anything waiting for HR more than "
            f"{OVERDUE_HOURS} hours (critical past {CRITICAL_BACKLOG_DAYS} days); people with {REPEAT_MIN_REJECTIONS}+ "
            f"rejections; sessions still open after their day; a median verification time over "
            f"{_num(SLOW_VERIFY_HOURS)} hours or {_p(HIGH_REJECTION_PCT)}+ of punches rejected (with {MIN_DECIDED}+ "
            f"decided); punches over {_num(FAR_KM)} km from the unit or at odd hours; sessions over {LONG_SESSION_HOURS} "
            f"hours; a rise of {_p(SURGE_PCT)} and {SURGE_MIN_EXTRA}+ sessions on the previous period."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe()],
        caveats=["These are rules of thumb: no on-duty target is configured in the system."],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[rules])


# ─── the plain-English summary ──────────────────────────────────────────────────────────────────────────────────────


def _sentence(id_: str, text: str, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "tone": tone}


@cached()
def geo_briefing(scope: Scope, period: Period) -> dict:
    """Three to five plain sentences with the numbers, written by fixed rules from the same figures as the cards (no AI):
    the volume, verification, the busiest department, what is unusual and who is out now."""
    summary = geo_summary(scope, period)
    verification = geo_verification(scope, period)
    unusual = geo_unusual(scope, period, limit=1)
    live = geo_live(scope)
    departments = geo_breakdown(scope, period, by="department", limit=1)
    m = summary["metrics"]
    sessions, people, punches = m["sessions"]["value"], m["people"]["value"], m["punches"]["value"]
    sentences: list[dict] = []

    if not (sessions or punches or m["officePunches"]["value"]):
        sentences.append(
            _sentence("volume", f"No on-duty sessions or geo punches were recorded in {period.label.lower()}.")
        )
    else:
        delta = m["sessions"]["change"]
        trend = ""
        if delta and delta["pct"] is not None and delta["abs"]:
            trend = f" ({'up' if delta['abs'] > 0 else 'down'} {_p(abs(delta['pct']))} on {_previous_phrase(period)})"
        office = m["officePunches"]["value"]
        sentences.append(
            _sentence(
                "volume",
                f"{period.label}: {_num(sessions)} on-duty {_plural(sessions, 'session')} by {_num(people)} "
                f"{_plural(people, 'person', 'people')}{trend}, {_num(punches)} on-duty {_plural(punches, 'punch', 'punches')} "
                f"and {_num(office)} office geo {_plural(office, 'punch', 'punches')}.",
            )
        )

    pv = verification["punches"]
    if pv["captured"]:
        timing = verification["decisionTime"]["punches"]
        wait = (
            f"; HR typically decides in {_hours_text(timing['medianHours'])}"
            if timing["medianHours"] is not None
            else ""
        )
        pending = f", {_num(pv['pending'])} still waiting" if pv["pending"] else ""
        rejected = pv["rejected"] + pv["voided"]
        sentences.append(
            _sentence(
                "verification",
                f"HR has verified {_p(verification['verifiedPct'])} of the on-duty punches"
                f"{', rejected ' + _num(rejected) if rejected else ''}{pending}{wait}.",
                "bad" if verification["backlog"]["overduePunches"] else "neutral",
            )
        )

    if departments["rows"]:
        top = departments["rows"][0]
        sentences.append(
            _sentence(
                "where",
                f"{top['label']} has the most on-duty sessions: {_num(top['sessions'])} "
                f"({_p(top['shareOfSessionsPct'])} of all), by {_num(top['people'])} "
                f"{_plural(top['people'], 'person', 'people')}.",
            )
        )

    counts = unusual["counts"]
    odd = [
        f"{_num(n)} {_plural(n, one, many)}"
        for n, one, many in (
            (m["mockedPunches"]["value"], "punch with simulated GPS", "punches with simulated GPS"),
            (
                m["farPunches"]["value"],
                f"punch over {_num(FAR_KM)} km from the unit",
                f"punches over {_num(FAR_KM)} km from the unit",
            ),
            (counts["staleSessions"], "session left open past its day", "sessions left open past their day"),
            (counts["repeatRejectedPeople"], "person with repeated rejections", "people with repeated rejections"),
        )
        if n
    ]
    if punches or sessions:
        sentences.append(
            _sentence(
                "unusual",
                f"Worth a look: {', '.join(odd)}." if odd else "Nothing unusual stands out in the on-duty records.",
                "bad" if m["mockedPunches"]["value"] else ("neutral" if odd else "good"),
            )
        )

    if live["rows"]:
        extras = []
        if live["awaitingApproval"]:
            extras.append(f"{_num(live['awaitingApproval'])} awaiting approval")
        if live["noSignal"]:
            extras.append(f"{_num(live['noSignal'])} with no location signal")
        sentences.append(
            _sentence(
                "now",
                f"Right now {_num(live['onDutyNow'])} {_plural(live['onDutyNow'], 'person is', 'people are')} on duty"
                f"{' (' + ', '.join(extras) + ')' if extras else ''}.",
            )
        )
    return envelope(
        {
            "sentences": sentences,
            "text": " ".join(s["text"] for s in sentences),
            "ask": f"Give me a briefing on geo attendance and on-duty work ({period.label}): what stands out, and why?",
        },
        period=period,
        scope=scope,
        provenance=[
            *_pick(_provenance(scope, period, rows={}), "geo-sessions", "geo-verification", "geo-turnaround"),
        ],
        notes=summary["notes"],
    )


# ─── the Dashboard's pieces ─────────────────────────────────────────────────────────────────────────────────────────


def _recent_windows(today: date | None) -> tuple[Period, Period]:
    """The last 7 COMPLETE days (to yesterday) and the 7 before them."""
    today = today or _today()
    end = today - timedelta(days=1)
    current = Period(end - timedelta(days=6), end, None, "Last 7 days")
    return current, current.previous()


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3). The window
    is the last 30 days: on-duty work is sparse, so a week is too short to say anything about verification."""
    today = today or _today()
    period = Period(today - timedelta(days=29), today, None, "Last 30 days")
    return _exceptions(Scope(), period, limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's geo cards: people on duty now, sessions in the last 7 complete days against the 7 before them
    (with a 14-day sparkline) and the punches waiting for HR."""
    current, previous = _recent_windows(today)
    scope = Scope()
    now = now_utc()
    per_day = _daily(scope, previous.start, current.end)
    cur = _sum_days(per_day, current.start, current.end)
    prev = _sum_days(per_day, previous.start, previous.end)
    spark = [(per_day.get(previous.start + timedelta(days=n)) or {}).get("sessions", 0) for n in range(14)]
    delta = change(cur["sessions"], prev["sessions"]) if (cur["sessions"] or prev["sessions"]) else None
    backlog = _backlog(scope, now)
    live = geo_live(scope)
    window = f"{current.start:%d %b} to {current.end:%d %b}"
    oldest = backlog["oldestPunchHours"]
    kpis = [
        {
            "id": "geo.on-duty-now",
            "label": "On duty now",
            "value": live["onDutyNow"],
            "format": "number",
            "sub": (
                f"{_num(live['awaitingApproval'])} awaiting approval · {_num(live['noSignal'])} with no location signal"
                if live["rows"]
                else "Nobody has an open on-duty session"
            ),
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
        {
            "id": "geo.sessions",
            "label": "On-duty sessions",
            "value": cur["sessions"],
            "format": "number",
            "sub": f"{_num(cur['punches'])} on-duty punches · {window}",
            "delta": {**delta, "good": None} if delta else None,
            "spark": spark,
            "page": PAGE,
        },
        {
            "id": "geo.awaiting-hr",
            "label": "Punches waiting for HR",
            "value": backlog["pendingPunches"],
            "format": "number",
            "sub": (f"The oldest has waited {_hours_text(oldest)}" if oldest is not None else "Nothing is waiting"),
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
    ]
    entries = _provenance(scope, current, rows={"sessions": cur["sessions"], "punches": cur["punches"]})
    entries["geo-backlog"] = prov(
        "geo-backlog",
        "Waiting for HR now",
        dataset="On-duty punch verifications, on-duty requests",
        definition="On-duty punches still pending at this moment, whenever they were captured.",
        formula="pending punches now",
        rows=backlog["pendingPunches"],
    )
    return {
        "kpis": kpis,
        "provenance": [*_pick(entries, "geo-sessions", "geo-backlog", "geo-previous"), live["provenance"][0]],
    }


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)


def _breakdown_tool(scope: Scope, period: Period, by: str = "department", limit: int = LIST_DEFAULT) -> dict:
    return geo_breakdown(scope, period, by=by, limit=limit)


def _without_destinations(result: dict) -> dict:
    """The same answer without the free-text destination of each session: it is typed by the employee and can name
    people or places, and what the assistant is sent leaves the server. (The MD's own page shows it.)"""
    out = dict(result)
    out["rows"] = [{k: v for k, v in row.items() if k != "destination"} for row in result["rows"]]
    return out


def _unusual_tool(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    return _without_destinations(geo_unusual(scope, period, limit=limit))


def _live_tool(scope: Scope) -> dict:
    return _without_destinations(geo_live(scope))


TOOLS = [
    tool(
        "geo_attendance_summary",
        "Geo attendance for a period: on-duty (working away from the unit) sessions and the people who went out, "
        "participation as a % of active employees, on-duty punches, office geo punches (made with the phone inside the "
        "unit), the % of on-duty punches HR verified and rejected, how many wait for HR, the median hours HR takes to "
        "verify, and the punches with a simulated GPS location, far from the unit or at odd hours, each with the "
        "previous period. Use for 'how much on-duty work is there', 'who works outside the premises' and 'is geo "
        "attendance being verified'. Percentages are 0-100.",
        geo_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "geo_attendance_trend",
        "On-duty sessions, on-duty punches (verified, rejected, waiting) and office geo punches day by day (week by week "
        "for periods over 62 days) with a 7-day average of sessions, the busiest day and a verdict on whether on-duty "
        "use is rising or falling. Use for 'is on-duty work increasing' and 'what happened last week'.",
        geo_trend,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "geo_verification_status",
        "Where on-duty requests and punches stand: requests awaiting the Department Head or HR, approved and rejected; "
        "punches verified, rejected, voided (with a rejected request) and pending; how long HR takes to decide (median, "
        "90th percentile, % within 24 hours); and what is waiting for HR right now with how long (the period does not "
        "apply to the backlog). Use for 'how long does verification take', 'what is pending' and 'how many were rejected'.",
        geo_verification,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "geo_attendance_breakdown",
        "Who goes out, by department, unit or staff-vs-production type: sessions, people, participation % of the group, "
        "sessions per person, punches, rejections and simulated or far punches, with the change in sessions against "
        "the previous period. Ranked by sessions. Use for 'which department works outside most', 'which unit'.",
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
        "geo_frequent_people",
        f"The people who went on duty most in the period: sessions, days out, on-duty punches and how many were "
        f"rejected, simulated, far from the unit or at odd hours; 'frequent' means {FREQUENT_MIN_SESSIONS}+ sessions. "
        "Use for 'who works outside the premises and how often' and 'who is always on duty'.",
        geo_people,
        page=PAGE,
        period="last_30_days",
        extra={
            "limit": _LIMIT,
            "min_sessions": integer_param("Only people with at least this many sessions", minimum=1, maximum=1000),
        },
        defaults={"limit": LIST_DEFAULT, "min_sessions": 1},
    ),
    tool(
        "geo_unusual_sessions",
        "On-duty sessions that look unusual, each with its reasons: simulated (mock) GPS location, punches far from the "
        f"unit (over {_num(FAR_KM)} km) or at odd hours, a session open more than {LONG_SESSION_HOURS} hours or past its "
        f"day, punches HR rejected; plus people with {REPEAT_MIN_REJECTIONS}+ rejections and the counts of each reason. "
        "Use for 'is anything suspicious', 'any fake locations' and 'who had repeated rejections'. A reason to look, "
        "not proof.",
        _unusual_tool,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "geo_distance_from_unit",
        "How far from their unit on-duty punches were taken: at the unit, up to 2, 2-10, 10-50, 50-100 and over 100 km, "
        "and the punches that cannot be placed because the unit has no location set, with the farthest distance. Use "
        "for 'how far do people travel' and 'who is working far away'.",
        geo_reach,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "geo_on_duty_now",
        "Who is on duty right now: everyone with an open on-duty session, how long they have been out, whether the "
        "request is approved yet, punches so far today and when their phone last reported a location (and its distance "
        "from the unit), plus counts of people out, awaiting approval and with no signal. Use for 'who is out of the "
        "premises right now'. Live: it takes no period.",
        _live_tool,
        page=PAGE,
        period=None,
    ),
]
