"""MD portal, Attendance Search: how punches ARRIVE and where records are MISSING.

The HR page this sits beside (Attendance Search) looks up one employee. The MD asks the questions around it: are the
devices sending, how much of the attendance was typed in by hand, who keeps forgetting to punch out, and is any
attendance being thrown away?

Source data
-----------
* ``AttendanceLog``: one row per punch. Its ``source`` tag says how the punch arrived: ``biometric:adms:<serial>`` (a
  device pushing to the server), ``biometric:<device name>`` (the server or a Site Connector reading the device),
  ``biometric:excel-import``, ``geo:auto`` (office geo punch), ``on_duty:approved``, ``missing_punch:approved`` (an
  approved correction) and ``manual`` (HR typed it). Dates and times are the factory's own wall clock.
* ``BiometricDevice`` (Settings -> Devices) turns a tag into a named device.
* ``MissingPunchRequest``, ``AttendanceOverrideRequest``, ``AttendanceDayRecord`` (``override_by``), ``UnmatchedPunch``.

Definitions reused rather than re-derived
-----------------------------------------
* The labels of the sources are HR's own (``geo_attendance_views.source_label``) and a device is named the way the Report
  Center's Punch Log names it (``attendance_core_data.device_of``).
* A "double tap" is two punches of one person within ``TAP_GAP_S`` seconds (the Report Center's Punch Exceptions rule).
* A day with an odd number of punches is the Punch Log report's "Days with odd punch count"; six or more punches in a
  day is the Punch Exceptions report's "Many punches".
* Coverage of the day records is the Attendance analytics' (``attendance.attendance_summary``).

What this module decides
------------------------
* **Hand-entered** punches are the ones a person put in rather than a device or a phone captured: HR's own entries
  (``manual``) plus approved missing-punch corrections.
* A device is **silent** when it has sent nothing on 2 or more of the days it normally works (days it normally sends on,
  not company holidays), measured on everything it sent to anybody, so a unit filter never hides an outage.
* Today is never part of a missing-punch figure (the employee may still be in the shift).

Nothing here writes; every query is an aggregate (or returns only the exception rows), never one query per row.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from django.db.models import (
    Case,
    CharField,
    Count,
    DurationField,
    Exists,
    ExpressionWrapper,
    F,
    OuterRef,
    Q,
    QuerySet,
    Value,
    When,
    Window,
)
from django.db.models.functions import ExtractHour, Lag, Mod

from ...clock import FACTORY_TZ, ist_today
from ...geo_attendance_views import source_label
from ...models import (
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    BiometricDevice,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    MissingPunchRequest,
    UnmatchedPunch,
)
from ...reporting.definitions.attendance_core_data import TAP_GAP_S, device_of
from ..assistant.tools_base import integer_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, prov
from . import attendance as attendance_analytics

PAGE = "attendance-search"

# ─── named thresholds (shown in provenance; the tests pin them) ─────────────────────────────────────────────────────

#: A device that has sent nothing on this many of the days it normally works is silent.
SILENT_AFTER_WORKING_DAYS = 2
#: Device activity is read over the last this many days, up to yesterday.
SILENT_LOOKBACK_DAYS = 30
#: A device that sends fewer punches than this on a day it works is too quiet to call silent from a day or two of nothing.
MIN_TYPICAL_DAILY_PUNCHES = 4
#: A weekday is one the device normally works when it sent punches on at least this share of that weekday's dates.
NORMAL_WEEKDAY_SHARE = 0.5
#: Hand-entered share of punches: flagged from here, critical from CRITICAL; a rise of RISE points is a trend.
MANUAL_SHARE_WARN_PCT = 10.0
MANUAL_SHARE_CRITICAL_PCT = 25.0
MANUAL_RISE_POINTS = 5.0
#: Fewer punches than this in a window is too few to call a share (or a rate) a finding.
MIN_PUNCHES_FOR_SHARE = 50
#: A department with fewer punches than this is listed without being ranked as a manual-entry hot spot.
MIN_GROUP_PUNCHES = 30
#: Fewer employee-days with punches than this is too few to call a missing-punch rate a finding.
MIN_PUNCH_DAYS = 30
#: Someone with this many days with a missing punch in the period is a repeat case (the attendance page uses 3 requests).
MISSING_REPEAT_MIN_DAYS = attendance_analytics.MISSING_PUNCH_MIN_REQUESTS
MISSING_WARN_PCT = 3.0
MISSING_CRITICAL_PCT = 8.0
#: Punches before this hour of the day are "night" punches; people on a night shift are expected to have them.
QUIET_UNTIL = attendance_analytics.LIVE_PUNCH_FROM
ODD_HOUR_WARN_PUNCHES = 10
#: Six or more punches in one day (the Report Center's "Many punches").
MANY_PUNCHES_PER_DAY = 6
#: A device with at least this share of double taps (and DUPLICATE_MIN of them) has a sensor worth checking.
DUPLICATE_DEVICE_WARN_PCT = 10.0
DUPLICATE_MIN = 20
COVERAGE_WARN_PCT = attendance_analytics.COVERAGE_WARN_PCT
WEEKLY_ROLLUP_AFTER_DAYS = attendance_analytics.WEEKLY_ROLLUP_AFTER_DAYS
HEATMAP_MAX_DAYS = attendance_analytics.HEATMAP_MAX_DAYS
HEATMAP_MAX_WEEKS = attendance_analytics.HEATMAP_MAX_WEEKS
HEATMAP_MAX_DEPARTMENTS = 12
EVIDENCE_DATES = attendance_analytics.EVIDENCE_DATES
LIST_MAX = 25
LIST_DEFAULT = 10
NO_DEPARTMENT = "No department"

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}

# ─── how a punch arrived ────────────────────────────────────────────────────────────────────────────────────────────

#: In the order the charts stack them (devices at the bottom).
FAMILY_ORDER = ("biometric", "geo", "on_duty", "import", "missing_punch", "manual", "other")
#: Punches a person entered rather than a device or a phone captured.
HAND_ENTERED = ("manual", "missing_punch")
#: A raw source tag per family that ``source_label`` words the way HR does ("Biometric", "Geo Punch", "HR Entry", ...).
_FAMILY_TAG = {
    "biometric": "biometric",
    "geo": "geo:auto",
    "on_duty": "on_duty:approved",
    "missing_punch": "missing_punch:approved",
    "manual": "manual",
}
FAMILY_LABEL = {
    **{family: source_label(tag) for family, tag in _FAMILY_TAG.items()},
    "import": device_of("biometric:excel-import"),
    "other": "Other",
}
FAMILY_LABEL["biometric"] = "Biometric devices"


def family_of(source: str | None) -> str:
    """The family a source tag belongs to. The SQL twin is ``_family_case`` (a test keeps the two in step)."""
    tag = (source or "").strip()
    if tag == "biometric:excel-import":
        return "import"
    if tag.startswith("biometric"):
        return "biometric"
    if tag == "geo:auto":
        return "geo"
    if tag == "on_duty:approved":
        return "on_duty"
    if tag == "missing_punch:approved":
        return "missing_punch"
    if tag.startswith("manual"):
        return "manual"
    return "other"


def _family_case() -> Case:
    return Case(
        When(source="biometric:excel-import", then=Value("import")),
        When(source__startswith="biometric", then=Value("biometric")),
        When(source="geo:auto", then=Value("geo")),
        When(source="on_duty:approved", then=Value("on_duty")),
        When(source="missing_punch:approved", then=Value("missing_punch")),
        When(source__startswith="manual", then=Value("manual")),
        default=Value("other"),
        output_field=CharField(),
    )


def _hand_q() -> Q:
    return Q(source__startswith="manual") | Q(source="missing_punch:approved")


def _device_q() -> Q:
    """A biometric device's punches (an Excel import is not a device)."""
    return Q(source__startswith="biometric") & ~Q(source="biometric:excel-import")


def _is_device_source(source: str) -> bool:
    return family_of(source) == "biometric"


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────


def _today() -> date:
    """The factory's date. A function so a test can pin the day."""
    return ist_today()


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


def _int_arg(value, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high], a readable error when not a number."""
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def _local_iso(value: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if value is None:
        return None
    return value.astimezone(FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _previous_phrase(period: Period) -> str:
    if period.days == 1:
        return "the day before"
    if period.days == 7:
        return "the 7 days before"
    return f"the previous {period.days} days"


def _metric(value, previous) -> dict:
    return {"value": value, "previous": previous, "change": change(value, previous)}


def _complete_end(end: date, today: date) -> date:
    """The last day of [.., end] that is over: today is still running, so a missing punch today means nothing yet."""
    return min(end, today - timedelta(days=1))


def _bucket(d: date, weekly: bool) -> date:
    return d - timedelta(days=d.weekday()) if weekly else d


def _buckets(start: date, end: date, weekly: bool) -> list[date]:
    seen: dict[date, None] = {}
    for n in range((end - start).days + 1):
        seen.setdefault(_bucket(start + timedelta(days=n), weekly), None)
    return list(seen)


def _logs(scope: Scope, start: date, end: date) -> QuerySet:
    """Punches dated in [start, end] (the factory's calendar) for the people in scope, leavers included."""
    return AttendanceLog.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)


def _person_name(first, last) -> str:
    return f"{first or ''} {last or ''}".strip()


# ─── the queries ────────────────────────────────────────────────────────────────────────────────────────────────────


def _by_day_source(scope: Scope, start: date, end: date) -> dict[tuple[date, str], int]:
    """{(day, source tag): punches}: the one query the sources, the devices and the shares are all built from."""
    rows = _logs(scope, start, end).values("date", "source").annotate(n=Count("id")).order_by()
    return {(r["date"], r["source"]): r["n"] for r in rows}


def _family_totals(per: dict[tuple[date, str], int], start: date, end: date) -> dict[str, int]:
    out = dict.fromkeys(FAMILY_ORDER, 0)
    memo: dict[str, str] = {}
    for (day, source), n in per.items():
        if start <= day <= end:
            family = memo.get(source) or memo.setdefault(source, family_of(source))
            out[family] += n
    return out


def _hand_pct(fam: dict[str, int]) -> float | None:
    return pct(sum(fam[k] for k in HAND_ENTERED), sum(fam.values()))


def _people_counts(scope: Scope, period: Period, previous: Period) -> tuple[int, int]:
    """(people with a punch in the period, in the previous period): two distinct counts in one query."""
    agg = (
        AttendanceLog.objects.filter(scope.employee_q("employee__"), date__gte=previous.start, date__lte=period.end)
        .order_by()
        .aggregate(
            cur=Count("employee_id", distinct=True, filter=Q(date__gte=period.start)),
            prev=Count("employee_id", distinct=True, filter=Q(date__lte=previous.end)),
        )
    )
    return int(agg["cur"] or 0), int(agg["prev"] or 0)


def _odd_days(scope: Scope, start: date, end: date) -> list[tuple[int, str, date, int]]:
    """(employee id, department, day, punches) for every employee-day with an ODD number of punches: an in-punch with no
    out-punch, or the reverse. The same test as the Punch Log report's "Days with odd punch count"; only the exception
    rows come back, never every day."""
    rows = (
        _logs(scope, start, end)
        .values("employee_id", "employee__department__name", "date")
        .annotate(n=Count("id"))
        .annotate(parity=Mod("n", 2))
        .filter(parity=1)
        .order_by()
    )
    return [(r["employee_id"], r["employee__department__name"] or NO_DEPARTMENT, r["date"], r["n"]) for r in rows]


def _punch_days_by_day(scope: Scope, start: date, end: date) -> dict[date, int]:
    """{day: people who punched that day}: the employee-days the missing-punch rate is a share of."""
    rows = _logs(scope, start, end).values("date").annotate(n=Count("employee_id", distinct=True)).order_by()
    return {r["date"]: r["n"] for r in rows}


def _request_rows(scope: Scope, start: date, end: date) -> list[tuple[int, date, str]]:
    return list(
        MissingPunchRequest.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)
        .order_by()
        .values_list("employee_id", "date", "status")
    )


# ─── devices: which tag is which machine ────────────────────────────────────────────────────────────────────────────


class _Devices:
    """Settings -> Devices as a lookup from a punch's source tag to one machine."""

    def __init__(self) -> None:
        rows = list(
            BiometricDevice.objects.order_by("id").values(
                "id", "name", "serial_number", "is_active", "last_data_at", "last_heartbeat_at"
            )
        )
        self.rows = {r["id"]: r for r in rows}
        self.by_serial: dict[str, dict] = {}
        self.by_name: dict[str, dict] = {}
        for r in rows:
            serial = (r["serial_number"] or "").strip().lower()
            name = (r["name"] or "").strip().lower()
            if serial:
                self.by_serial.setdefault(serial, r)
            if name:
                self.by_name.setdefault(name, r)

    def resolve(self, source: str) -> tuple[str, str, str, dict | None]:
        """(key, label, "push" | "pull" | "unknown", the configured device or None) for a biometric source tag."""
        tail = source[len("biometric") :].lstrip(":")
        if tail.startswith("adms:"):
            serial = tail[len("adms:") :]
            device = self.by_serial.get(serial.strip().lower())
            if device:
                return f"device:{device['id']}", device["name"], "push", device
            return f"serial:{serial}", f"Unlisted device {serial}", "push", None
        if tail == "adms":
            return "adms", "Device (serial not sent)", "push", None
        if not tail:
            return "unnamed", "Biometric (device not named)", "unknown", None
        device = self.by_name.get(tail.lower())
        if device:
            return f"device:{device['id']}", device["name"], "pull", device
        return f"name:{tail}", device_of(source) or tail, "pull", None


def _judge_activity(days: dict[date, int], lookback_start: date, ref_end: date, holidays: set[date]) -> dict:
    """What one device has done over the lookback: its last punch, how many it sends on a working day, and on how many of
    the days it normally works since its last punch it sent nothing."""
    last = max(days)
    complete = {d: n for d, n in days.items() if d <= ref_end} or days
    typical = sum(complete.values()) / len(complete)
    normal: set[int] = set()
    for weekday in range(7):
        dates = [
            lookback_start + timedelta(days=n)
            for n in range((last - lookback_start).days + 1)
            if (lookback_start + timedelta(days=n)).weekday() == weekday
            and (lookback_start + timedelta(days=n)) not in holidays
        ]
        active = sum(1 for d in dates if d in days)
        if dates and active >= NORMAL_WEEKDAY_SHARE * len(dates) and active > 0:
            normal.add(weekday)
    silent_days = 0
    day = last + timedelta(days=1)
    while day <= ref_end:
        if day.weekday() in normal and day not in holidays:
            silent_days += 1
        day += timedelta(days=1)
    return {"last": last, "typical": round(typical, 1), "silentDays": silent_days, "activeDays": len(complete)}


def _health(devices: _Devices, today: date) -> dict[str, dict]:
    """Every device's activity over the last SILENT_LOOKBACK_DAYS, on everything it sent to anybody (no scope: an outage is
    the device's, whatever filter the MD has chosen). One query for the punches, one for the holidays."""
    lookback_start = today - timedelta(days=SILENT_LOOKBACK_DAYS)
    rows = (
        AttendanceLog.objects.filter(_device_q(), date__gte=lookback_start, date__lte=today)
        .values("date", "source")
        .annotate(n=Count("id"))
        .order_by()
    )
    by_key: dict[str, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_key[devices.resolve(r["source"])[0]][r["date"]] += r["n"]
    holidays = set(Holiday.objects.filter(date__gte=lookback_start, date__lte=today).values_list("date", flat=True))
    ref_end = today - timedelta(days=1)
    return {key: _judge_activity(days, lookback_start, ref_end, holidays) for key, days in by_key.items()}


def _status_of(health: dict | None, meta: dict | None) -> str:
    """ok | silent | stopped | quiet | disabled."""
    if meta is not None and not meta["is_active"]:
        return "disabled"
    if health is None:
        return "stopped"
    if health["silentDays"] < SILENT_AFTER_WORKING_DAYS:
        return "ok"
    return "silent" if health["typical"] >= MIN_TYPICAL_DAILY_PUNCHES else "quiet"


def _status_text(status: str, health: dict | None) -> str:
    if status == "disabled":
        return "Switched off in Settings"
    if status == "stopped":
        return f"No punches in the last {SILENT_LOOKBACK_DAYS} days"
    if status == "silent" and health:
        return f"Nothing for {health['silentDays']} working days (last punch {health['last']:%d %b})"
    if status == "quiet" and health:
        return f"Quiet: {health['silentDays']} working days with nothing, but it sends only a few punches a day"
    return "Sending"


def _device_groups(
    per: dict[tuple[date, str], int], devices: _Devices, start: date, end: date, prev_start: date, prev_end: date
) -> dict[str, dict]:
    """The biometric punches grouped by the machine that took them: this period, the previous one and a daily series."""
    groups: dict[str, dict] = {}
    for (day, source), n in per.items():
        if not _is_device_source(source):
            continue
        key, label, kind, meta = devices.resolve(source)
        g = groups.setdefault(
            key,
            {
                "key": key,
                "label": label,
                "kind": kind,
                "meta": meta,
                "sources": set(),
                "punches": 0,
                "previous": 0,
                "days": defaultdict(int),
            },
        )
        g["sources"].add(source)
        if kind == "push":
            g["kind"] = "push"
        if start <= day <= end:
            g["punches"] += n
            g["days"][day] += n
        elif prev_start <= day <= prev_end:
            g["previous"] += n
    return groups


def _devices_block(scope: Scope, period: Period, previous: Period, per: dict, today: date, devices: _Devices) -> dict:
    """The device rows for a period and scope: volume and its change, who used it, whether it is silent."""
    health = _health(devices, today)
    groups = _device_groups(per, devices, period.start, period.end, previous.start, previous.end)
    pairs = (
        _logs(scope, period.start, period.end)
        .filter(_device_q())
        .values_list("source", "employee_id")
        .distinct()
        .order_by()
    )
    people: dict[str, set[int]] = defaultdict(set)
    for source, employee_id in pairs:
        people[devices.resolve(source)[0]].add(employee_id)

    # A configured, enabled device nobody in this scope used is still listed for the whole company (it may be dead).
    if scope.is_everyone():
        for row in devices.rows.values():
            key = f"device:{row['id']}"
            if key not in groups and row["is_active"]:
                groups[key] = {
                    "key": key,
                    "label": row["name"],
                    "kind": "unknown",
                    "meta": row,
                    "sources": set(),
                    "punches": 0,
                    "previous": 0,
                    "days": defaultdict(int),
                }
    total = sum(g["punches"] for g in groups.values())
    buckets = [period.start + timedelta(days=n) for n in range(period.days)][-30:]
    rows = []
    for key, g in groups.items():
        meta = g["meta"]
        h = health.get(key)
        status = _status_of(h, meta)
        active_days = len(g["days"])
        rows.append(
            {
                "key": key,
                "label": g["label"],
                "kind": g["kind"],
                "configured": meta is not None,
                "isActive": meta["is_active"] if meta is not None else None,
                "punches": g["punches"],
                "previous": g["previous"],
                "change": change(g["punches"], g["previous"]),
                "sharePct": pct(g["punches"], total),
                "people": len(people.get(key, ())),
                "daysWithPunches": active_days,
                "avgPerDay": round(g["punches"] / active_days, 1) if active_days else None,
                "lastPunchDate": _iso(h["last"]) if h else None,
                "daysSilent": h["silentDays"] if h else None,
                "typicalPerDay": h["typical"] if h else None,
                "status": status,
                "silent": status in ("silent", "stopped"),
                "statusText": _status_text(status, h),
                "lastDataAt": _local_iso(meta["last_data_at"]) if meta is not None else None,
                "lastHeartbeatAt": _local_iso(meta["last_heartbeat_at"]) if meta is not None else None,
                "spark": [g["days"].get(d, 0) for d in buckets],
            }
        )
    order = {"silent": 0, "stopped": 1, "quiet": 2, "ok": 3, "disabled": 4}
    rows.sort(key=lambda r: (order[r["status"]], -r["punches"], r["label"].lower()))
    return {
        "rows": rows,
        "total": total,
        "listed": len(rows),
        "reporting": sum(1 for r in rows if r["punches"] > 0),
        "silent": sum(1 for r in rows if r["silent"]),
        "unlisted": sum(1 for r in rows if not r["configured"]),
    }


# ─── missing punches ────────────────────────────────────────────────────────────────────────────────────────────────


def _missing_window(
    odd: list[tuple[int, str, date, int]],
    punch_days: dict[date, int],
    requests: list[tuple[int, date, str]],
    start: date,
    end: date,
) -> dict:
    """Missing-punch figures for one window out of rows loaded once for both windows."""
    rows = [r for r in odd if start <= r[2] <= end]
    per_person = Counter(r[0] for r in rows)
    asked = {(e, d) for e, d, status in requests if status != "rejected" and start <= d <= end}
    return {
        "rows": rows,
        "days": len(rows),
        "punchDays": sum(n for d, n in punch_days.items() if start <= d <= end),
        "people": len(per_person),
        "repeaters": sum(1 for n in per_person.values() if n >= MISSING_REPEAT_MIN_DAYS),
        "withRequest": sum(1 for r in rows if (r[0], r[2]) in asked),
        "requests": [q for q in requests if start <= q[1] <= end],
    }


def _missing_core(scope: Scope, period: Period, previous: Period, today: date) -> dict:
    """Missing-punch figures for the period and the one before: three queries however many people there are."""
    end = _complete_end(period.end, today)
    prev_end = _complete_end(previous.end, today)
    odd = _odd_days(scope, previous.start, end)
    punch_days = _punch_days_by_day(scope, previous.start, end)
    requests = _request_rows(scope, previous.start, period.end)
    complete = end >= period.start
    cur = _missing_window(odd, punch_days, requests, period.start, end) if complete else None
    prev = _missing_window(odd, punch_days, requests, previous.start, prev_end)
    return {"cur": cur, "prev": prev, "end": end, "complete": complete, "punchDays": punch_days}


def _missing_pct(window: dict | None) -> float | None:
    return pct(window["days"], window["punchDays"]) if window else None


# ─── coverage of the day records ────────────────────────────────────────────────────────────────────────────────────


def _punch_exists() -> Exists:
    return Exists(AttendanceLog.objects.filter(employee_id=OuterRef("employee_id"), date=OuterRef("date")))


def _coverage_core(scope: Scope, start: date, end: date, punch_days: dict[date, int]) -> dict | None:
    """How many employee-days with punches have a day record, and the records that disagree with the punches. None when
    the period has no complete day."""
    if end < start:
        return None
    records = AttendanceDayRecord.objects.filter(scope.employee_q("employee__"), date__gte=start, date__lte=end)
    with_record = {
        r["date"]: r["n"]
        for r in records.filter(_punch_exists()).values("date").annotate(n=Count("id")).order_by()
    }
    stale = records.filter(_punch_exists(), status="absent").count()
    no_punches = (
        records.filter(status__in=("present", "half_shift"), source="auto").exclude(_punch_exists()).count()
    )
    punch_total = sum(n for d, n in punch_days.items() if start <= d <= end)
    recorded = sum(with_record.values())
    worst = sorted(
        (
            {
                "date": d.isoformat(),
                "punchDays": n,
                "withRecord": with_record.get(d, 0),
                "missing": max(0, n - with_record.get(d, 0)),
            }
            for d, n in punch_days.items()
            if start <= d <= end
        ),
        key=lambda r: (-r["missing"], r["date"]),
    )
    return {
        "punchDays": punch_total,
        "withRecord": min(recorded, punch_total),
        "withoutRecord": max(0, punch_total - recorded),
        "coveragePct": pct(min(recorded, punch_total), punch_total),
        "staleAbsent": stale,
        "presentWithoutPunches": no_punches,
        "worstDays": [w for w in worst if w["missing"] > 0][:5],
    }


# ─── unmatched device IDs ───────────────────────────────────────────────────────────────────────────────────────────


def _unmatched_core(scope: Scope, period: Period, limit: int) -> dict:
    """Device user IDs that punch but match no employee. They belong to nobody, so they cannot be placed in a unit or a
    department: under a filter they are not listed (and the answer says so)."""
    if not scope.is_everyone():
        return {"available": False, "unresolved": None, "activeInPeriod": None, "punches": None, "rows": [], "byDevice": []}
    qs = UnmatchedPunch.objects.filter(resolved=False)
    items = list(
        qs.order_by("-punch_count", "device_user_id", "device_serial").values(
            "device_user_id",
            "device_label",
            "device_serial",
            "punch_count",
            "first_seen_at",
            "last_punch_date",
        )
    )
    active = [u for u in items if u["last_punch_date"] and period.start <= u["last_punch_date"] <= period.end]
    codes = [u["device_user_id"] for u in active[:limit]]
    status_of = dict(Employee.objects.filter(employee_code__in=codes).values_list("employee_code", "status"))
    by_device: Counter = Counter()
    for u in active:
        by_device[u["device_label"] or (u["device_serial"] and f"Device {u['device_serial']}") or "Unknown device"] += u[
            "punch_count"
        ]
    rows = []
    for u in active[:limit]:
        known = status_of.get(u["device_user_id"])
        rows.append(
            {
                "deviceUserId": u["device_user_id"],
                "device": u["device_label"] or (u["device_serial"] and f"Device {u['device_serial']}") or "Unknown device",
                "punches": u["punch_count"],
                "firstSeen": _local_iso(u["first_seen_at"])[:10] if u["first_seen_at"] else None,
                "lastPunchDate": _iso(u["last_punch_date"]),
                "hint": (
                    "No employee has this code."
                    if known is None
                    else f"An employee with this code exists but is {known}: their punches are ignored."
                ),
            }
        )
    return {
        "available": True,
        "unresolved": len(items),
        "activeInPeriod": len(active),
        "punches": sum(u["punch_count"] for u in active),
        "rows": rows,
        "byDevice": [{"label": label, "punches": n} for label, n in by_device.most_common(5)],
    }


# ─── provenance (what "How is this calculated?" says, and what the assistant quotes) ────────────────────────────────


def _provenance(scope: Scope, period: Period, rows: dict[str, int | None] | None = None) -> dict[str, dict]:
    rows = rows or {}
    filters = [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()]
    previous = period.previous()
    return {
        "punches-total": prov(
            "punches-total",
            "Punches",
            dataset="Attendance punches (every check-in and check-out, from any source)",
            definition=(
                "One record for each punch an employee made, whatever way it arrived: a biometric device, the geo "
                "punch on the phone, an approved on-duty punch, an Excel import, an approved missing-punch correction "
                "or a punch HR typed in. A punch counts on the date it was stamped (the factory's calendar). People "
                "who have left are included, so a past period never changes."
            ),
            formula="number of punch records dated in the period",
            rows=rows.get("punches"),
            filters=filters,
            caveats=["Today is still running, so the latest day is partial."],
        ),
        "punches-sources": prov(
            "punches-sources",
            "How punches arrived",
            dataset="Attendance punches, source tag",
            definition=(
                "Each punch carries a tag for how it arrived. They are grouped as HR names them: Biometric devices "
                "(pushed by the device or read from it), Geo Punch, On-Duty, Excel import, Missing Punch (an approved "
                "correction), HR Entry (typed in by HR) and Other (anything else, such as test data)."
            ),
            formula="share = punches of one group ÷ all punches × 100",
            rows=rows.get("punches"),
            filters=filters,
            caveats=["A punch is stored once: if the same punch reached the server by two routes, the first one is kept."],
        ),
        "punches-hand-entered": prov(
            "punches-hand-entered",
            "Hand-entered punches",
            dataset="Attendance punches, source tag",
            definition=(
                "Punches a person put in rather than a device or a phone captured: punches HR typed in (HR Entry) plus "
                "approved missing-punch corrections. A high or rising share means attendance depends on people "
                "remembering to fix it afterwards."
            ),
            formula="(HR Entry + Missing Punch) ÷ all punches × 100",
            rows=rows.get("handEntered"),
            filters=filters,
            caveats=[
                "The system does not record WHO typed an individual punch; the people shown are the ones who edited day "
                "records or approved corrections.",
                f"A window with fewer than {MIN_PUNCHES_FOR_SHARE} punches is too small to call a share.",
            ],
        ),
        "punches-devices": prov(
            "punches-devices",
            "Punches by device",
            dataset="Attendance punches, biometric devices (Settings, Devices)",
            definition=(
                "Biometric punches are credited to the machine that took them: a device that pushes its punches is "
                "known by its serial number, one the server reads by its name in Settings. A tag that matches no "
                "device in Settings is listed as an unlisted device."
            ),
            formula="punches per device; change = this period - previous period",
            rows=rows.get("devicePunches"),
            filters=filters,
            caveats=["Units and departments filter the people, not the machines: a device with nobody from the selection is not listed."],
        ),
        "punches-silent": prov(
            "punches-silent",
            "Silent devices",
            dataset="Attendance punches, biometric devices, company holidays",
            definition=(
                f"A device is silent when it has sent nothing on {SILENT_AFTER_WORKING_DAYS} or more of the days it "
                f"normally works since its last punch, over the last {SILENT_LOOKBACK_DAYS} days up to yesterday. "
                "A day it normally works is a weekday it sent punches on for at least half of that weekday's dates; "
                "company holidays are not counted. A device that sends fewer than "
                f"{MIN_TYPICAL_DAILY_PUNCHES} punches a working day is called quiet, not silent. An enabled device with "
                "no punches at all in the window is shown as stopped."
            ),
            formula="working days since the last punch with no punch from the device ≥ 2",
            rows=rows.get("devices"),
            filters=[f"Last {SILENT_LOOKBACK_DAYS} days", "Everything the device sent, to anybody"],
            caveats=[
                "Judged on everything the device sent, whatever unit or department is selected, so a filter can neither hide nor invent an outage.",
                "A holiday that applies to one branch only is treated as a holiday for every device.",
            ],
        ),
        "punches-missing": prov(
            "punches-missing",
            "Days with a missing punch",
            dataset="Attendance punches",
            definition=(
                "An employee-day with an odd number of punches: someone punched in and never out, or the reverse (the "
                "Punch Log report's \"Days with odd punch count\"). Today is left out, because the employee may still "
                "be in the shift."
            ),
            formula="employee-days with an odd number of punches ÷ employee-days with any punch × 100",
            rows=rows.get("missingDays"),
            filters=filters,
            caveats=[
                "A shift that crosses midnight can show an odd day at the edge of the period.",
                "Double taps are counted as punches here, as in the Punch Log report.",
            ],
        ),
        "punches-requests": prov(
            "punches-requests",
            "Missing-punch requests",
            dataset="Missing punch requests",
            definition=(
                "Requests from employees who forgot to punch, for days in the period. A day with a missing punch is "
                "'asked for' when a request that has not been rejected exists for that person and day."
            ),
            formula="odd-punch days with a pending or approved request ÷ odd-punch days",
            rows=rows.get("requests"),
            filters=filters,
        ),
        "punches-unmatched": prov(
            "punches-unmatched",
            "Unmatched device IDs",
            dataset="Unmatched device IDs (punches that match no employee)",
            definition=(
                "A device user ID that punches but matches no employee: that attendance is thrown away. Counted from "
                "the IDs still unresolved whose last punch falls in the period."
            ),
            formula="unresolved device IDs with a last punch in the period",
            rows=rows.get("unmatched"),
            filters=[period.label],
            caveats=[
                "These IDs belong to nobody, so they cannot be placed in a unit or department: they are shown only for the whole company.",
                "Punch counts are approximate: a device pull re-counts the whole device log on every sync.",
            ],
        ),
        "punches-coverage": prov(
            "punches-coverage",
            "Day records behind the punches",
            dataset="Attendance punches, attendance day records",
            definition=(
                "Day records are the verdicts payroll pays from; they are made when HR opens Attendance or payroll "
                "runs. This is the share of employee-days with punches that already have one."
            ),
            formula="employee-days with punches and a day record ÷ employee-days with punches × 100",
            rows=rows.get("punchDays"),
            filters=filters,
            caveats=["Today is left out. A missing record is not lost data: opening Attendance for the date creates it."],
        ),
        "punches-duplicates": prov(
            "punches-duplicates",
            "Double taps",
            dataset="Attendance punches",
            definition=(
                f"A punch within {TAP_GAP_S // 60} minutes of the same person's previous punch on the same day (the "
                "Report Center's Punch Exceptions rule). Double taps are ignored when worked hours are counted."
            ),
            formula=f"punches less than {TAP_GAP_S} seconds after the person's previous punch that day",
            rows=rows.get("duplicates"),
            filters=filters,
        ),
        "punches-odd-hours": prov(
            "punches-odd-hours",
            "Night-time punches",
            dataset="Attendance punches, shift assignments",
            definition=(
                f"Punches stamped between midnight and {QUIET_UNTIL:%H:%M} from people who are not on a night shift "
                "(a shift that crosses midnight or starts before then) on that date. They often mean a device with the "
                "wrong clock, or someone else punching."
            ),
            formula=f"punches before {QUIET_UNTIL:%H:%M} by people with no night shift assigned that day",
            rows=rows.get("oddHours"),
            filters=filters,
            caveats=["People with no shift assigned are judged as day workers."],
        ),
        "punches-previous": prov(
            "punches-previous",
            "Comparison with the previous period",
            dataset="Attendance punches",
            definition=(
                "Every change is against the period of the same length that ends the day before this one starts, "
                "worked out the same way."
            ),
            formula="change = this period - previous period (shares change in points)",
            filters=[f"{previous.start.isoformat()} to {previous.end.isoformat()}"],
        ),
    }


def _pick(entries: dict[str, dict], *ids: str) -> list[dict]:
    return [entries[i] for i in ids if i in entries]


def _no_data_note(period: Period) -> str:
    return f"No punches were recorded for this selection ({period.label})."


def _today_note(period: Period, today: date) -> list[str]:
    if period.end >= today:
        return ["Today is still running, so the latest day is partial and is left out of the missing-punch figures."]
    return []


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────────


def _silent_rows(block: dict) -> list[dict]:
    return [
        {
            "key": r["key"],
            "label": r["label"],
            "status": r["status"],
            "daysSilent": r["daysSilent"],
            "lastPunchDate": r["lastPunchDate"],
            "typicalPerDay": r["typicalPerDay"],
        }
        for r in block["rows"]
        if r["silent"]
    ]


def _names_text(rows: list[dict], shown: int = 3) -> str:
    names = [r["label"] for r in rows[:shown]]
    extra = len(rows) - shown
    return ", ".join(names) + (f" and {extra} more" if extra > 0 else "")


def _briefing(
    period: Period,
    scope: Scope,
    fam: dict[str, int],
    prev_fam: dict[str, int],
    devices: dict,
    missing: dict,
    unmatched: dict,
) -> dict:
    """Two to four plain sentences, every figure taken from the numbers on this page. No AI: the MD asks for an
    explanation on demand."""
    total, prev_total = sum(fam.values()), sum(prev_fam.values())
    sentences: list[str] = []
    if total:
        hand = sum(fam[k] for k in HAND_ENTERED)
        biometric = pct(fam["biometric"], total)
        vs = ""
        moved = change(total, prev_total)
        if moved and moved["pct"] is not None:
            vs = f", {'up' if moved['abs'] >= 0 else 'down'} {_p(abs(moved['pct']), 1)} on the previous period"
        hand_pct, prev_hand = pct(hand, total), _hand_pct(prev_fam)
        compare = f", against {_p(prev_hand, 1)} before" if prev_hand is not None and prev_total else ""
        sentences.append(
            f"{period.label}: {_num(total)} punches{vs}. {_p(biometric, 1)} came from biometric devices and "
            f"{_p(hand_pct, 1)} ({_num(hand)}) were entered by hand{compare}."
        )
    else:
        sentences.append(f"No punches were recorded in {period.label} for this selection.")
    silent = _silent_rows(devices)
    if silent:
        worst = max(r["daysSilent"] or 0 for r in silent)
        when = f"nothing for {worst} working days" if worst else f"nothing in the last {SILENT_LOOKBACK_DAYS} days"
        sentences.append(f"{_names_text(silent)} {'has' if len(silent) == 1 else 'have'} stopped sending ({when}).")
    elif devices["reporting"]:
        sentences.append(
            f"All {_num(devices['reporting'])} biometric {_plural(devices['reporting'], 'device is', 'devices are')} sending."
        )
    if missing["complete"] and missing["punchDays"]:
        without = missing["days"] - missing["withRequest"]
        if missing["days"]:
            sentences.append(
                f"{_num(missing['days'])} employee-days ({_p(missing['pct'], 1)}) have a punch missing, and "
                f"{_num(without)} of them have no correction request."
            )
        else:
            sentences.append("No employee-day has a punch missing.")
    if unmatched.get("available") and unmatched.get("activeInPeriod"):
        n = unmatched["activeInPeriod"]
        sentences.append(
            f"{_num(n)} device {_plural(n, 'ID punches', 'IDs punch')} but {_plural(n, 'matches', 'match')} no employee, "
            "so that attendance is being thrown away."
        )
    return {
        "sentences": sentences,
        "text": " ".join(sentences),
        "ask": (
            f"Explain how punches arrived in {period.label} ({scope.describe()}): which sources and devices, what is "
            "missing and what I should do about it."
        ),
    }


def _summary_core(scope: Scope, period: Period, today: date) -> dict:
    previous = period.previous()
    per = _by_day_source(scope, previous.start, period.end)
    fam = _family_totals(per, period.start, period.end)
    prev_fam = _family_totals(per, previous.start, previous.end)
    total, prev_total = sum(fam.values()), sum(prev_fam.values())
    people, prev_people = _people_counts(scope, period, previous)
    hand = sum(fam[k] for k in HAND_ENTERED)
    prev_hand = sum(prev_fam[k] for k in HAND_ENTERED)
    enough = total >= MIN_PUNCHES_FOR_SHARE
    prev_enough = prev_total >= MIN_PUNCHES_FOR_SHARE
    hand_pct = _hand_pct(fam) if enough else None
    prev_hand_pct = _hand_pct(prev_fam) if prev_enough else None

    devices = _Devices()
    block = _devices_block(scope, period, previous, per, today, devices)
    miss = _missing_core(scope, period, previous, today)
    cur, prev = miss["cur"], miss["prev"]
    unmatched = _unmatched_core(scope, period, LIST_DEFAULT)
    coverage = _coverage_core(scope, period.start, miss["end"], miss["punchDays"])
    return {
        "per": per,
        "fam": fam,
        "prev_fam": prev_fam,
        "total": total,
        "prev_total": prev_total,
        "people": (people, prev_people),
        "hand": (hand, prev_hand),
        "hand_pct": (hand_pct, prev_hand_pct),
        "devices": block,
        "missing": miss,
        "cur": cur,
        "prev": prev,
        "unmatched": unmatched,
        "coverage": coverage,
        "previous": previous,
    }


@cached()
def punch_summary(scope: Scope, period: Period) -> dict:
    """How punches arrived and where records are missing, in one answer: punches and who made them, the hand-entered
    share, the devices and whether any is silent, days with a missing punch, unmatched device IDs and how many punch-days
    already have a day record, each against the previous period; plus a plain-English briefing. The call the KPI cards, the
    Dashboard strip and the assistant all rest on."""
    today = _today()
    core = _summary_core(scope, period, today)
    fam, prev_fam = core["fam"], core["prev_fam"]
    total, prev_total = core["total"], core["prev_total"]
    cur, prev = core["cur"], core["prev"]
    coverage = core["coverage"]
    block = core["devices"]
    unmatched = core["unmatched"]
    miss_pct = _missing_pct(cur) if cur and cur["punchDays"] >= MIN_PUNCH_DAYS else None
    prev_miss_pct = _missing_pct(prev) if prev["punchDays"] >= MIN_PUNCH_DAYS else None

    missing = {
        "complete": core["missing"]["complete"],
        "days": cur["days"] if cur else None,
        "punchDays": cur["punchDays"] if cur else 0,
        "pct": _missing_pct(cur),
        "people": cur["people"] if cur else None,
        "repeaters": cur["repeaters"] if cur else None,
        "withRequest": cur["withRequest"] if cur else None,
        "withoutRequest": (cur["days"] - cur["withRequest"]) if cur else None,
        "minDays": MISSING_REPEAT_MIN_DAYS,
    }
    metrics = {
        "punches": _metric(total, prev_total),
        "employees": _metric(*core["people"]),
        "handEntered": _metric(*core["hand"]),
        "handEnteredPct": _metric(*core["hand_pct"]),
        "missingDays": _metric(cur["days"] if cur else None, prev["days"]),
        "missingPct": _metric(miss_pct, prev_miss_pct),
        "coveragePct": _metric(coverage["coveragePct"] if coverage else None, None),
    }
    families = [
        {
            "key": k,
            "label": FAMILY_LABEL[k],
            "punches": fam[k],
            "sharePct": pct(fam[k], total),
            "previous": prev_fam[k],
            "previousSharePct": pct(prev_fam[k], prev_total),
        }
        for k in FAMILY_ORDER
    ]
    entries = _provenance(
        scope,
        period,
        rows={
            "punches": total,
            "handEntered": core["hand"][0],
            "devices": block["listed"],
            "devicePunches": sum(g["punches"] for g in block["rows"]),
            "missingDays": cur["days"] if cur else 0,
            "requests": len(cur["requests"]) if cur else 0,
            "unmatched": unmatched.get("activeInPeriod"),
            "punchDays": coverage["punchDays"] if coverage else 0,
        },
    )
    notes = [] if total else [_no_data_note(period)]
    notes.extend(_today_note(period, _today()))
    if total and total < MIN_PUNCHES_FOR_SHARE:
        notes.append(f"Only {_num(total)} punches in this selection: shares are not shown below {MIN_PUNCHES_FOR_SHARE}.")
    if not core["missing"]["complete"]:
        notes.append("This period has no complete day yet, so missing punches cannot be judged.")
    if unmatched.get("available") is False:
        notes.append("Unmatched device IDs belong to no employee, so they are shown only for the whole company.")
    unlisted = [r for r in block["rows"] if not r["configured"]]
    if unlisted:
        notes.append(
            f"{_num(len(unlisted))} {_plural(len(unlisted), 'source', 'sources')} of punches "
            f"({_names_text(unlisted)}) {_plural(len(unlisted), 'is', 'are')} not a device listed in Settings."
        )
    return envelope(
        {
            "metrics": metrics,
            "families": families,
            "devices": {
                "listed": block["listed"],
                "reporting": block["reporting"],
                "silent": block["silent"],
                "unlisted": block["unlisted"],
                "silentRows": _silent_rows(block),
            },
            "missing": missing,
            "unmatched": {
                "available": unmatched["available"],
                "unresolved": unmatched["unresolved"],
                "activeInPeriod": unmatched["activeInPeriod"],
                "punches": unmatched["punches"],
            },
            "coverage": coverage,
            "previousPeriod": core["previous"].to_json(),
            "briefing": _briefing(
                period, scope, fam, prev_fam, block, {**missing, "complete": core["missing"]["complete"]}, unmatched
            ),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "punches-total",
            "punches-sources",
            "punches-hand-entered",
            "punches-devices",
            "punches-silent",
            "punches-missing",
            "punches-requests",
            "punches-unmatched",
            "punches-coverage",
            "punches-previous",
        ),
        notes=notes,
    )


# ─── how punches arrive: the trend by source ────────────────────────────────────────────────────────────────────────


@cached()
def punch_sources(scope: Scope, period: Period) -> dict:
    """Punches per day (per week beyond 62 days) split by how they arrived, with the hand-entered share of each, and the
    split of the whole period against the previous one."""
    previous = period.previous()
    per = _by_day_source(scope, previous.start, period.end)
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    keys = _buckets(period.start, period.end, weekly)
    grid: dict[date, dict[str, int]] = {k: dict.fromkeys(FAMILY_ORDER, 0) for k in keys}
    memo: dict[str, str] = {}
    for (day, source), n in per.items():
        if period.start <= day <= period.end:
            family = memo.get(source) or memo.setdefault(source, family_of(source))
            grid[_bucket(day, weekly)][family] += n
    points = []
    for k in keys:
        row = grid[k]
        total = sum(row.values())
        hand = sum(row[f] for f in HAND_ENTERED)
        points.append({"date": k.isoformat(), **row, "total": total, "handEntered": hand, "handEnteredPct": pct(hand, total)})

    fam, prev_fam = _family_totals(per, period.start, period.end), _family_totals(per, previous.start, previous.end)
    total, prev_total = sum(fam.values()), sum(prev_fam.values())
    families = []
    for k in FAMILY_ORDER:
        share, prev_share = pct(fam[k], total), pct(prev_fam[k], prev_total)
        families.append(
            {
                "key": k,
                "label": FAMILY_LABEL[k],
                "punches": fam[k],
                "sharePct": share,
                "previous": prev_fam[k],
                "previousSharePct": prev_share,
                "change": change(fam[k], prev_fam[k]),
                "shareChange": change(share, prev_share),
            }
        )
    hand, prev_hand = sum(fam[k] for k in HAND_ENTERED), sum(prev_fam[k] for k in HAND_ENTERED)
    entries = _provenance(scope, period, rows={"punches": total, "handEntered": hand})
    notes = [] if total else [_no_data_note(period)]
    notes.extend(_today_note(period, _today())[:1] if period.end >= _today() else [])
    return envelope(
        {
            "granularity": "week" if weekly else "day",
            "points": points,
            "families": families,
            "total": _metric(total, prev_total),
            "handEntered": {
                "punches": hand,
                "previous": prev_hand,
                "pct": _hand_pct(fam),
                "previousPct": _hand_pct(prev_fam),
                "change": change(_hand_pct(fam), _hand_pct(prev_fam)),
            },
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-sources", "punches-total", "punches-hand-entered", "punches-previous"),
        notes=notes,
    )


# ─── devices ────────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def punch_devices(scope: Scope, period: Period, limit: int = LIST_MAX) -> dict:
    """Punches per biometric device with the change against the previous period, who used it and whether it is silent
    (nothing on the days it normally works), worst first."""
    limit = _int_arg(limit, "limit", LIST_MAX, 1, LIST_MAX)
    today = _today()
    previous = period.previous()
    per = _by_day_source(scope, previous.start, period.end)
    block = _devices_block(scope, period, previous, per, today, _Devices())
    rows = block["rows"]
    entries = _provenance(scope, period, rows={"devices": block["listed"], "devicePunches": block["total"]})
    notes = []
    if not rows:
        notes.append(
            "No biometric device is listed in Settings and no device punches were recorded for this selection."
            if scope.is_everyone()
            else f"No device recorded punches for this selection ({period.label})."
        )
    unlisted = [r for r in rows if not r["configured"]]
    if unlisted:
        notes.append(
            f"{_names_text(unlisted)} {_plural(len(unlisted), 'is', 'are')} sending punches but "
            f"{_plural(len(unlisted), 'is', 'are')} not a device listed in Settings."
        )
    return envelope(
        {
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "listed": block["listed"],
            "reporting": block["reporting"],
            "silent": block["silent"],
            "unlisted": block["unlisted"],
            "devicePunches": block["total"],
            "silentAfterWorkingDays": SILENT_AFTER_WORKING_DAYS,
            "lookbackDays": SILENT_LOOKBACK_DAYS,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-devices", "punches-silent", "punches-previous"),
        notes=notes,
    )


# ─── missing punches: who, where, and has anyone asked for a fix ────────────────────────────────────────────────────


def _person_rows(ids: list[int]) -> dict[int, dict]:
    """Names and places for a handful of employees: one query, ``values`` so the employee's photo is never read."""
    rows = Employee.objects.filter(pk__in=ids).values(
        "id",
        "employee_code",
        "first_name",
        "last_name",
        "department__name",
        "branch__name",
        "employment_type",
        "status",
    )
    return {r["id"]: r for r in rows}


def _person_fields(r: dict) -> dict:
    return {
        "employeeCode": r["employee_code"],
        "employeeName": _person_name(r["first_name"], r["last_name"]),
        "department": r["department__name"] or NO_DEPARTMENT,
        "unit": r["branch__name"],
        "type": {"staff": "Staff", "production": "Production"}.get(r["employment_type"], r["employment_type"]),
    }


@cached()
def punch_missing(scope: Scope, period: Period, limit: int = LIST_DEFAULT, min_days: int = MISSING_REPEAT_MIN_DAYS) -> dict:
    """Days with a punch missing (in without out, or the reverse): how many, how many already have a correction request,
    when and in which department they cluster, and the people who have them again and again."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    min_days = _int_arg(min_days, "min_days", MISSING_REPEAT_MIN_DAYS, 1, 100)
    today = _today()
    previous = period.previous()
    core = _missing_core(scope, period, previous, today)
    cur, prev = core["cur"], core["prev"]
    entries = _provenance(
        scope,
        period,
        rows={"missingDays": cur["days"] if cur else 0, "requests": len(cur["requests"]) if cur else 0},
    )
    base = {
        "complete": core["complete"],
        "minDays": min_days,
        "previousPeriod": previous.to_json(),
    }
    if cur is None:
        return envelope(
            {
                **base,
                "days": None,
                "previousDays": prev["days"],
                "change": None,
                "punchDays": 0,
                "pct": None,
                "previousPct": _missing_pct(prev),
                "people": None,
                "repeaters": None,
                "withRequest": None,
                "withoutRequest": None,
                "requests": None,
                "granularity": "day",
                "points": [],
                "heatmap": {"columns": [], "rows": [], "values": [], "granularity": "day", "capped": False},
                "rows": [],
                "total": 0,
                "truncated": False,
            },
            period=period,
            scope=scope,
            provenance=_pick(entries, "punches-missing", "punches-requests", "punches-previous"),
            notes=["This period has no complete day yet, so missing punches cannot be judged."],
        )

    rows = cur["rows"]
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    end = core["end"]
    keys = _buckets(period.start, end, weekly)
    missing_by, days_by = Counter(), Counter()
    for _e, _dept, day, _n in rows:
        missing_by[_bucket(day, weekly)] += 1
    for day, n in core["punchDays"].items():
        if period.start <= day <= end:
            days_by[_bucket(day, weekly)] += n
    points = [{"date": k.isoformat(), "missing": missing_by.get(k, 0), "punchDays": days_by.get(k, 0)} for k in keys]

    # department x day (or week) grid of missing-punch days
    heat_weekly = (end - period.start).days + 1 > HEATMAP_MAX_DAYS
    columns = _buckets(period.start, end, heat_weekly)
    capped_cols = heat_weekly and len(columns) > HEATMAP_MAX_WEEKS
    columns = columns[-HEATMAP_MAX_WEEKS:] if heat_weekly else columns
    by_dept: dict[str, Counter] = defaultdict(Counter)
    for _e, dept, day, _n in rows:
        by_dept[dept][_bucket(day, heat_weekly)] += 1
    ranked = sorted(by_dept.items(), key=lambda kv: (-sum(kv[1].values()), kv[0].lower()))
    shown = ranked[:HEATMAP_MAX_DEPARTMENTS]
    heatmap = {
        "columns": [c.isoformat() for c in columns],
        "rows": [name for name, _ in shown],
        "values": [[(counter.get(c) or None) for c in columns] for _, counter in shown],
        "granularity": "week" if heat_weekly else "day",
        "capped": len(ranked) > len(shown) or capped_cols,
        "totalDepartments": len(ranked),
    }

    per_person: dict[int, list[date]] = defaultdict(list)
    for employee_id, _dept, day, _n in rows:
        per_person[employee_id].append(day)
    repeaters = sorted(
        ((e, sorted(ds)) for e, ds in per_person.items() if len(ds) >= min_days),
        key=lambda item: (-len(item[1]), item[0]),
    )
    top = repeaters[:limit]
    ids = [e for e, _ in top]
    people = _person_rows(ids) if ids else {}
    days_with_punches: dict[int, int] = {}
    if ids:
        days_with_punches = {
            r["employee_id"]: r["n"]
            for r in _logs(scope, period.start, end)
            .filter(employee_id__in=ids)
            .values("employee_id")
            .annotate(n=Count("date", distinct=True))
            .order_by()
        }
    asked_by = Counter(e for e, d, _s in cur["requests"] if e in set(ids))
    out_rows = []
    for employee_id, dates in top:
        p = people.get(employee_id)
        if p is None:  # the employee was deleted between the two queries
            continue
        out_rows.append(
            {
                **_person_fields(p),
                "missingDays": len(dates),
                "daysWithPunches": days_with_punches.get(employee_id),
                "missingPct": pct(len(dates), days_with_punches.get(employee_id)),
                "requestsRaised": asked_by.get(employee_id, 0),
                "dates": [d.isoformat() for d in reversed(dates)][:EVIDENCE_DATES],
            }
        )

    statuses = Counter(s for _e, _d, s in cur["requests"])
    pending_dates = [d for _e, d, s in cur["requests"] if s in ("pending_hod", "pending_hr")]
    oldest = (today - min(pending_dates)).days if pending_dates else None
    without = cur["days"] - cur["withRequest"]
    notes = [] if core["punchDays"] else [_no_data_note(period)]
    notes.extend(_today_note(period, today))
    return envelope(
        {
            **base,
            "days": cur["days"],
            "previousDays": prev["days"],
            "change": change(cur["days"], prev["days"]),
            "punchDays": cur["punchDays"],
            "pct": _missing_pct(cur),
            "previousPct": _missing_pct(prev),
            "people": cur["people"],
            "repeaters": len(repeaters),
            "withRequest": cur["withRequest"],
            "withoutRequest": without,
            "requests": {
                "total": len(cur["requests"]),
                "pending": statuses.get("pending_hod", 0) + statuses.get("pending_hr", 0),
                "approved": statuses.get("approved", 0),
                "rejected": statuses.get("rejected", 0),
                "oldestPendingDays": oldest,
            },
            "granularity": "week" if weekly else "day",
            "points": points,
            "heatmap": heatmap,
            "rows": out_rows,
            "total": len(repeaters),
            "truncated": len(repeaters) > limit,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-missing", "punches-requests", "punches-previous"),
        notes=notes,
    )


# ─── hand-entered punches: how many, where, and who is behind them ──────────────────────────────────────────────────


def _actor_rows(scope: Scope, start: date, end: date) -> list[dict]:
    """The people behind hand-made attendance: who overrode day records, who approved missing-punch corrections and who
    asked for manual edits. Three small group-bys; a name is whatever the system recorded."""
    emp = scope.employee_q("employee__")
    people: dict[str, dict] = {}

    def row(name: str) -> dict:
        return people.setdefault(
            name, {"userName": name, "dayOverrides": 0, "missingPunchApprovals": 0, "overrideRequests": 0}
        )

    for r in (
        AttendanceDayRecord.objects.filter(emp, source="manual", date__gte=start, date__lte=end)
        .exclude(override_by__isnull=True)
        .exclude(override_by="")
        .values("override_by")
        .annotate(n=Count("id"))
        .order_by()
    ):
        row(r["override_by"])["dayOverrides"] += r["n"]
    for r in (
        MissingPunchRequest.objects.filter(emp, status="approved", date__gte=start, date__lte=end)
        .exclude(hr_reviewed_by__isnull=True)
        .exclude(hr_reviewed_by="")
        .values("hr_reviewed_by")
        .annotate(n=Count("id"))
        .order_by()
    ):
        row(r["hr_reviewed_by"])["missingPunchApprovals"] += r["n"]
    for r in (
        AttendanceOverrideRequest.objects.filter(emp, date__gte=start, date__lte=end)
        .exclude(requested_by__isnull=True)
        .exclude(requested_by="")
        .values("requested_by")
        .annotate(n=Count("id"))
        .order_by()
    ):
        row(r["requested_by"])["overrideRequests"] += r["n"]
    out = []
    for r in people.values():
        out.append({**r, "total": r["dayOverrides"] + r["missingPunchApprovals"] + r["overrideRequests"]})
    out.sort(key=lambda r: (-r["total"], r["userName"].lower()))
    return out


@cached()
def punch_manual(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """Hand-entered punches (HR entries and approved missing-punch corrections): their share of all punches against the
    previous period, day by day, which departments and people they cluster in, who edited day records or approved
    corrections, and the manual edits that need approval."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    today = _today()
    previous = period.previous()
    per = _by_day_source(scope, previous.start, period.end)
    fam, prev_fam = _family_totals(per, period.start, period.end), _family_totals(per, previous.start, previous.end)
    total, prev_total = sum(fam.values()), sum(prev_fam.values())
    hand, prev_hand = sum(fam[k] for k in HAND_ENTERED), sum(prev_fam[k] for k in HAND_ENTERED)
    share, prev_share = _hand_pct(fam), _hand_pct(prev_fam)

    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    grid: dict[date, list[int]] = {k: [0, 0] for k in _buckets(period.start, period.end, weekly)}
    memo: dict[str, str] = {}
    for (day, source), n in per.items():
        if period.start <= day <= period.end:
            family = memo.get(source) or memo.setdefault(source, family_of(source))
            cell = grid[_bucket(day, weekly)]
            cell[0] += n
            cell[1] += n if family in HAND_ENTERED else 0
    points = [
        {"date": k.isoformat(), "total": t, "handEntered": h, "handEnteredPct": pct(h, t)} for k, (t, h) in grid.items()
    ]

    by_dept = (
        _logs(scope, period.start, period.end)
        .values("employee__department__name")
        .annotate(
            punches=Count("id"),
            hand=Count("id", filter=_hand_q()),
            manual=Count("id", filter=Q(source__startswith="manual")),
            missing_punch=Count("id", filter=Q(source="missing_punch:approved")),
        )
        .filter(hand__gt=0)
        .order_by()
    )
    departments = [
        {
            "label": r["employee__department__name"] or NO_DEPARTMENT,
            "punches": r["punches"],
            "handEntered": r["hand"],
            "manual": r["manual"],
            "missingPunch": r["missing_punch"],
            "sharePct": pct(r["hand"], r["punches"]),
            "smallSample": r["punches"] < MIN_GROUP_PUNCHES,
        }
        for r in by_dept
    ]
    departments.sort(key=lambda d: (d["smallSample"], -(d["sharePct"] or 0), -d["handEntered"], d["label"].lower()))

    by_person = list(
        _logs(scope, period.start, period.end)
        .filter(source__startswith="manual")
        .values("employee_id")
        .annotate(n=Count("id"), days=Count("date", distinct=True))
        .order_by("-n", "employee_id")[:limit]
    )
    people = _person_rows([r["employee_id"] for r in by_person]) if by_person else {}
    employees = [
        {**_person_fields(people[r["employee_id"]]), "manualPunches": r["n"], "days": r["days"]}
        for r in by_person
        if r["employee_id"] in people
    ]

    edits_qs = AttendanceOverrideRequest.objects.filter(
        scope.employee_q("employee__"), date__gte=period.start, date__lte=period.end
    )
    statuses = {r["status"]: r["n"] for r in edits_qs.values("status").annotate(n=Count("id")).order_by()}
    oldest = edits_qs.filter(status="pending").order_by("created_at").values_list("created_at", flat=True).first()
    oldest_days = (today - oldest.astimezone(FACTORY_TZ).date()).days if oldest else None
    records = AttendanceDayRecord.objects.filter(scope.employee_q("employee__"), date__gte=period.start, date__lte=period.end)
    agg = records.aggregate(total=Count("id"), manual=Count("id", filter=Q(source="manual")))

    entries = _provenance(scope, period, rows={"punches": total, "handEntered": hand})
    entries["punches-edits"] = prov(
        "punches-edits",
        "Manual edits and who made them",
        dataset="Attendance day records, manual edit requests, missing punch requests",
        definition=(
            "Day records HR overrode by hand (with the person who did it), missing-punch corrections approved by HR "
            "(with the approver) and manual edits requested for approval (with who asked). The system does not record "
            "who typed each individual punch, so these are the people the records themselves name."
        ),
        formula="count of overridden day records, approved corrections and edit requests per person, in the period",
        rows=agg["manual"],
        filters=[period.label, scope.describe()],
        caveats=["A person is counted under the name the system recorded."],
    )
    notes = [] if total else [_no_data_note(period)]
    if 0 < total < MIN_PUNCHES_FOR_SHARE:
        notes.append(f"Only {_num(total)} punches in this selection: treat the share with care.")
    return envelope(
        {
            "total": total,
            "previousTotal": prev_total,
            "handEntered": _metric(hand, prev_hand),
            "handEnteredPct": _metric(share, prev_share),
            "manual": fam["manual"],
            "missingPunch": fam["missing_punch"],
            "granularity": "week" if weekly else "day",
            "points": points,
            "byDepartment": departments[:limit],
            "departmentsTotal": len(departments),
            "byEmployee": employees,
            "actors": _actor_rows(scope, period.start, period.end)[:limit],
            "edits": {
                "pending": statuses.get("pending", 0),
                "approved": statuses.get("approved", 0),
                "rejected": statuses.get("rejected", 0),
                "total": sum(statuses.values()),
                "oldestPendingDays": oldest_days,
            },
            "dayOverrides": {"count": agg["manual"], "ofDayRecords": agg["total"], "sharePct": pct(agg["manual"], agg["total"])},
            "minPunches": MIN_PUNCHES_FOR_SHARE,
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-hand-entered", "punches-edits", "punches-total", "punches-previous"),
        notes=notes,
    )


# ─── odd punches: double taps, night-time punches, many punches ─────────────────────────────────────────────────────


def _night_shift_q() -> Q:
    """A shift that crosses midnight, or starts before the quiet window ends."""
    return Q(shift__end_time__lte=F("shift__start_time")) | Q(shift__start_time__lt=QUIET_UNTIL)


def _device_label_of(source: str, devices: _Devices) -> str:
    family = family_of(source)
    if family == "biometric":
        return devices.resolve(source)[1]
    return FAMILY_LABEL[family]


@cached()
def punch_anomalies(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """Punches that look wrong rather than missing: double taps (and which device has most), night-time punches by people
    who are not on a night shift (often a device with the wrong clock), days with six or more punches, and the hours of the
    day punches arrive in."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    devices = _Devices()
    logs = _logs(scope, period.start, period.end)
    totals_by_source = {r["source"]: r["n"] for r in logs.values("source").annotate(n=Count("id")).order_by()}
    total = sum(totals_by_source.values())
    by_label_total: Counter = Counter()
    for source, n in totals_by_source.items():
        by_label_total[_device_label_of(source, devices)] += n

    # double taps: a punch within TAP_GAP_S of the same person's previous punch that day (only these rows come back)
    previous_time = Window(
        expression=Lag("punch_time"),
        partition_by=[F("employee_id"), F("date")],
        order_by=[F("punch_time").asc(), F("id").asc()],
    )
    duplicates = list(
        logs.annotate(previous_time=previous_time)
        .annotate(gap=ExpressionWrapper(F("punch_time") - F("previous_time"), output_field=DurationField()))
        .filter(gap__lt=timedelta(seconds=TAP_GAP_S))
        .values_list("source", flat=True)
    )
    dup_by: Counter = Counter()
    for source in duplicates:
        dup_by[_device_label_of(source, devices)] += 1

    # night-time punches by people who are not on a night shift that day
    night = EmployeeShiftAssignment.objects.filter(
        _night_shift_q(), employee_id=OuterRef("employee_id"), effective_from__lte=OuterRef("date")
    ).filter(Q(effective_to__isnull=True) | Q(effective_to__gte=OuterRef("date")))
    odd_sources = {
        r["source"]: r["n"]
        for r in logs.filter(punch_time__lt=QUIET_UNTIL)
        .filter(~Exists(night))
        .values("source")
        .annotate(n=Count("id"))
        .order_by()
    }
    odd_by: Counter = Counter()
    for source, n in odd_sources.items():
        odd_by[_device_label_of(source, devices)] += n
    odd_total = sum(odd_sources.values())

    # many punches in a day
    many = list(
        logs.values("employee_id", "date")
        .annotate(n=Count("id"))
        .filter(n__gte=MANY_PUNCHES_PER_DAY)
        .order_by()
        .values_list("employee_id", "date", "n")
    )
    many_by_person = Counter(e for e, _d, _n in many)
    top_many = many_by_person.most_common(limit)
    many_people = _person_rows([e for e, _ in top_many]) if top_many else {}

    hours = {
        r["hour"]: r
        for r in logs.annotate(hour=ExtractHour("punch_time"))
        .values("hour")
        .annotate(n=Count("id"), hand=Count("id", filter=_hand_q()))
        .order_by("hour")
    }
    by_hour = [
        {
            "hour": h,
            "label": f"{h:02d}:00",
            "punches": (hours.get(h) or {}).get("n", 0),
            "handEntered": (hours.get(h) or {}).get("hand", 0),
        }
        for h in range(24)
    ]

    def devices_list(counter: Counter) -> list[dict]:
        return [
            {"label": label, "count": n, "ratePct": pct(n, by_label_total.get(label)), "punches": by_label_total.get(label, 0)}
            for label, n in counter.most_common(limit)
        ]

    entries = _provenance(
        scope, period, rows={"duplicates": len(duplicates), "oddHours": odd_total, "punches": total}
    )
    entries["punches-many"] = prov(
        "punches-many",
        "Days with many punches",
        dataset="Attendance punches",
        definition=(
            f"An employee-day with {MANY_PUNCHES_PER_DAY} or more punches: usually repeated taps, or two people "
            "sharing one device ID (the Report Center's \"Many punches\")."
        ),
        formula=f"employee-days with ≥ {MANY_PUNCHES_PER_DAY} punches",
        rows=len(many),
        filters=[period.label, scope.describe()],
    )
    notes = [] if total else [_no_data_note(period)]
    return envelope(
        {
            "punches": total,
            "duplicates": {
                "count": len(duplicates),
                "sharePct": pct(len(duplicates), total),
                "gapSeconds": TAP_GAP_S,
                "byDevice": devices_list(dup_by),
            },
            "oddHours": {
                "count": odd_total,
                "sharePct": pct(odd_total, total),
                "until": f"{QUIET_UNTIL:%H:%M}",
                "byDevice": devices_list(odd_by),
            },
            "manyPunchDays": {
                "count": len(many),
                "minPunches": MANY_PUNCHES_PER_DAY,
                "people": [
                    {**_person_fields(many_people[e]), "days": n} for e, n in top_many if e in many_people
                ],
            },
            "byHour": by_hour,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-duplicates", "punches-odd-hours", "punches-many", "punches-total"),
        notes=notes,
    )


# ─── unmatched device IDs, coverage ─────────────────────────────────────────────────────────────────────────────────


@cached()
def punch_unmatched(scope: Scope, period: Period, limit: int = LIST_DEFAULT) -> dict:
    """Device user IDs that punch but match no employee, so their attendance is thrown away: how many are still
    unresolved, how many punched in the period, which device they punch at, and whether an employee with that code exists
    but is inactive. Company-wide only: these IDs belong to no unit or department."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    data = _unmatched_core(scope, period, limit)
    entries = _provenance(scope, period, rows={"unmatched": data["activeInPeriod"]})
    notes = []
    if not data["available"]:
        notes.append(
            "Unmatched device IDs belong to no employee, so they cannot be placed in a unit or department. Clear the "
            "filters to see them."
        )
    elif not data["unresolved"]:
        notes.append("Every device ID that has punched matches an employee.")
    return envelope(
        {**data, "total": data["activeInPeriod"], "truncated": bool(data["activeInPeriod"] and data["activeInPeriod"] > limit)},
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-unmatched"),
        notes=notes,
    )


@cached()
def punch_coverage(scope: Scope, period: Period) -> dict:
    """How many employee-days with punches already have an attendance day record, the days with the biggest gap, day
    records that disagree with the punches (absent although the person punched; present with no punch), and the Attendance
    analytics' own coverage of scheduled days."""
    today = _today()
    end = _complete_end(period.end, today)
    punch_days = _punch_days_by_day(scope, period.start, end) if end >= period.start else {}
    data = _coverage_core(scope, period.start, end, punch_days)
    scheduled = attendance_analytics.attendance_summary(scope, period).get("coverage")
    entries = _provenance(scope, period, rows={"punchDays": data["punchDays"] if data else 0})
    notes = [] if data and data["punchDays"] else [_no_data_note(period)]
    notes.extend(_today_note(period, today))
    if data and data["staleAbsent"]:
        notes.append(
            f"{_num(data['staleAbsent'])} day {_plural(data['staleAbsent'], 'record says', 'records say')} absent although "
            "the person punched: the record is out of date, open the day in Attendance to recompute it."
        )
    return envelope(
        {"complete": data is not None, "coverage": data, "scheduled": scheduled},
        period=period,
        scope=scope,
        provenance=_pick(entries, "punches-coverage"),
        notes=notes,
    )


# ─── needs your attention ───────────────────────────────────────────────────────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"punches.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _exceptions(core: dict, scope: Scope, period: Period, *, limit: int, anomalies: dict | None = None) -> list[dict]:
    """Findings worth the MD's attention, most severe first. Built from the same numbers as the page."""
    items: list[dict] = []
    block = core["devices"]
    cur, prev = core["cur"], core["prev"]
    fam, prev_fam = core["fam"], core["prev_fam"]
    total, prev_total = core["total"], core["prev_total"]
    prev_phrase = _previous_phrase(period)

    silent = [r for r in block["rows"] if r["silent"]]
    if silent:
        worst = max(silent, key=lambda r: (r["daysSilent"] or 0, r["typicalPerDay"] or 0))
        stopped = worst["status"] == "stopped"
        days = worst["daysSilent"] or 0
        if len(silent) == 1:
            title = (
                f"{worst['label']} has sent no punches in the last {SILENT_LOOKBACK_DAYS} days"
                if stopped
                else f"{worst['label']} has sent nothing for {days} working days"
            )
            detail = (
                "It is enabled in Settings but no punch from it reached the server. Check its power, network and server address."
                if stopped
                else f"Its last punch was on {worst['lastPunchDate'] and date.fromisoformat(worst['lastPunchDate']):%d %b}; it normally "
                f"sends about {_num(worst['typicalPerDay'])} punches a working day. Check the device and its link to the server."
            )
        else:
            title = f"{_num(len(silent))} devices have stopped sending punches: {_names_text(silent)}"
            detail = f"The longest silence is {_num(days)} working days ({worst['label']}). People punching there are not being recorded."
        items.append(
            _item(
                "device-silent",
                "critical" if (not stopped and days >= 3) or len(silent) >= 2 else "warning",
                title,
                detail,
                f"{_num(days)} days" if not stopped else "no punches",
                f"Why has the {worst['label']} device stopped sending punches, and which employees and departments are affected?"
                if len(silent) == 1
                else "Which biometric devices have stopped sending punches, since when, and which departments are affected?",
            )
        )

    hand_pct, prev_hand_pct = core["hand_pct"]
    if hand_pct is not None:
        rose = prev_hand_pct is not None and hand_pct - prev_hand_pct >= MANUAL_RISE_POINTS and hand_pct >= MANUAL_RISE_POINTS
        if hand_pct >= MANUAL_SHARE_WARN_PCT or rose:
            sub = (
                f", up from {_p(prev_hand_pct, 1)} in {prev_phrase}"
                if prev_hand_pct is not None and hand_pct > prev_hand_pct
                else (f", against {_p(prev_hand_pct, 1)} in {prev_phrase}" if prev_hand_pct is not None else "")
            )
            items.append(
                _item(
                    "manual-share",
                    "critical" if hand_pct >= MANUAL_SHARE_CRITICAL_PCT else "warning",
                    f"Hand-entered punches are {_p(hand_pct, 1)} of all punches in {period.label.lower() if period.preset else period.label}{sub}",
                    f"{_num(core['hand'][0])} of {_num(total)} punches were typed in by HR or added as approved corrections "
                    "instead of being captured by a device or a phone.",
                    _p(hand_pct, 1),
                    f"Why are {_p(hand_pct, 1)} of punches hand-entered ({period.label}), which departments and people are behind it, and is a device failing?",
                )
            )

    if cur and cur["days"] and cur["punchDays"] >= MIN_PUNCH_DAYS:
        pct_now = _missing_pct(cur)
        without = cur["days"] - cur["withRequest"]
        severity = (
            "critical"
            if (pct_now or 0) >= MISSING_CRITICAL_PCT
            else "warning"
            if (pct_now or 0) >= MISSING_WARN_PCT
            else "info"
        )
        trend = ""
        if prev["days"] and prev["punchDays"] >= MIN_PUNCH_DAYS:
            trend = f" ({_p(_missing_pct(prev), 1)} in {prev_phrase})"
        items.append(
            _item(
                "missing-days",
                severity,
                f"{_num(cur['days'])} employee-days have a punch missing, and {_num(without)} of them have no correction request",
                f"{_p(pct_now, 1)} of the days people punched{trend}. Someone punched in and never out (or the reverse); "
                "until it is corrected the day counts as a half day or absence.",
                _p(pct_now, 1),
                f"Who keeps missing punches ({period.label}), in which departments, and why have so few correction requests been raised?",
            )
        )
    if cur and cur["repeaters"]:
        n = cur["repeaters"]
        items.append(
            _item(
                "missing-repeaters",
                "warning" if n >= 5 else "info",
                f"{_num(n)} {_plural(n, 'person', 'people')} had a punch missing on {MISSING_REPEAT_MIN_DAYS} or more days",
                f"{period.label}: the names and dates are in the missing-punch list below.",
                _num(n),
                f"Who are the people with repeated missing punches ({period.label}), and is it one device, department or shift?",
            )
        )

    unmatched = core["unmatched"]
    if unmatched.get("available") and unmatched.get("activeInPeriod"):
        n = unmatched["activeInPeriod"]
        items.append(
            _item(
                "unmatched-ids",
                "warning",
                f"{_num(n)} device {_plural(n, 'ID punches', 'IDs punch')} but {_plural(n, 'matches', 'match')} no employee",
                f"About {_num(unmatched['punches'])} punches are being thrown away. Register the employee or correct the device user ID.",
                _num(n),
                f"Which device IDs punch without matching an employee ({period.label}), at which device, and who might they be?",
            )
        )

    coverage = core["coverage"]
    if coverage and coverage["punchDays"] >= MIN_PUNCH_DAYS and (coverage["coveragePct"] or 100) < COVERAGE_WARN_PCT:
        gap = coverage["withoutRecord"]
        items.append(
            _item(
                "records-gap",
                "warning" if (coverage["coveragePct"] or 0) < 75 else "info",
                f"{_num(gap)} employee-days with punches have no attendance record yet ({_p(100 - (coverage['coveragePct'] or 0), 1)})",
                "Day records are made when HR opens Attendance or payroll runs, so these days are not in attendance, "
                "lateness or payroll figures until they are processed.",
                _p(coverage["coveragePct"], 1),
                f"Which dates and units have punches but no attendance record ({period.label})?",
            )
        )

    if anomalies:
        odd = anomalies["oddHours"]
        if odd["count"] >= ODD_HOUR_WARN_PUNCHES:
            lead = odd["byDevice"][0] if odd["byDevice"] else None
            where = f" {lead['label']} took {_num(lead['count'])} of them: its clock may be wrong." if lead else ""
            items.append(
                _item(
                    "odd-hours",
                    "warning",
                    f"{_num(odd['count'])} punches were made between midnight and {odd['until']} by people who are not on a night shift",
                    f"{period.label}.{where}",
                    _num(odd["count"]),
                    f"Who made the night-time punches ({period.label}), at which device, and is a device clock wrong?",
                )
            )
        bad = [
            d
            for d in anomalies["duplicates"]["byDevice"]
            if (d["ratePct"] or 0) >= DUPLICATE_DEVICE_WARN_PCT and d["count"] >= DUPLICATE_MIN
        ]
        if bad:
            d = max(bad, key=lambda x: x["ratePct"] or 0)
            items.append(
                _item(
                    "double-taps",
                    "info",
                    f"{_p(d['ratePct'], 1)} of {d['label']}'s punches are double taps",
                    f"{_num(d['count'])} of {_num(d['punches'])} punches came within {TAP_GAP_S // 60} minutes of the person's previous punch: "
                    "a sticky or slow sensor makes people tap twice.",
                    _p(d["ratePct"], 1),
                    f"Why does the {d['label']} device record so many double taps ({period.label})?",
                )
            )

    if (
        not items
        and total
        and block["listed"]
        and (hand_pct is None or hand_pct < MANUAL_SHARE_WARN_PCT)
    ):
        items.append(
            _item(
                "healthy",
                "good",
                "Punches are arriving normally: every device is sending and few are hand-entered",
                f"{_num(total)} punches in {period.label}, {_p(hand_pct, 1) if hand_pct is not None else 'a small share'} entered by hand"
                + (f", {_num(cur['days'])} days with a missing punch." if cur else "."),
                _num(total),
                f"Summarise how punches arrived ({period.label}).",
            )
        )
    del fam, prev_fam, prev_total
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


@cached()
def punch_attention(scope: Scope, period: Period) -> dict:
    """"Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    today = _today()
    core = _summary_core(scope, period, today)
    anomalies = punch_anomalies(scope, period)
    items = _exceptions(core, scope, period, limit=6, anomalies=anomalies)
    thresholds = prov(
        "punches-attention",
        "Needs your attention",
        dataset="Attendance punches, devices, missing punch requests, day records",
        definition=(
            f"A device is flagged silent after {SILENT_AFTER_WORKING_DAYS} working days with nothing. Hand-entered "
            f"punches are flagged from {_p(MANUAL_SHARE_WARN_PCT)} of all punches (critical from {_p(MANUAL_SHARE_CRITICAL_PCT)}), or "
            f"when the share rises {MANUAL_RISE_POINTS:g}+ points on the previous period. Missing punches are flagged "
            f"from {_p(MISSING_WARN_PCT)} of the days people punched (critical from {_p(MISSING_CRITICAL_PCT)}). "
            f"Repeat cases have {MISSING_REPEAT_MIN_DAYS}+ days. Night-time punches are flagged from "
            f"{ODD_HOUR_WARN_PUNCHES}; a device with {_p(DUPLICATE_DEVICE_WARN_PCT)}+ double taps is mentioned. Unmatched "
            "device IDs are flagged whenever one punched in the period; day records from below "
            f"{_p(COVERAGE_WARN_PCT)} coverage."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe()],
        caveats=[
            f"Shares and rates need at least {MIN_PUNCHES_FOR_SHARE} punches (or {MIN_PUNCH_DAYS} employee-days): below that nothing is flagged.",
            "These are rules of thumb: no punch target is configured in the system.",
        ],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[thresholds])


def _recent_windows(today: date | None) -> tuple[Period, Period, date]:
    """The last 7 COMPLETE days (to yesterday) and the 7 before them, and today."""
    today = today or _today()
    end = today - timedelta(days=1)
    current = Period(end - timedelta(days=6), end, None, "Last 7 days")
    return current, current.previous(), today


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3). Cheap: the
    summary figures only, no scan for double taps."""
    current, _previous, today = _recent_windows(today)
    scope = Scope()
    return _exceptions(_summary_core(scope, current, today), scope, current, limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's punch cards: the hand-entered share and the days with a missing punch over the last 7 complete days
    against the 7 before, with a 14-day sparkline, and how many devices are silent. "Down" is good news for the first two."""
    current, previous, today = _recent_windows(today)
    scope = Scope()
    per = _by_day_source(scope, previous.start, current.end)
    fam, prev_fam = _family_totals(per, current.start, current.end), _family_totals(per, previous.start, previous.end)
    total, prev_total = sum(fam.values()), sum(prev_fam.values())
    hand = sum(fam[k] for k in HAND_ENTERED)
    hand_pct = _hand_pct(fam) if total >= MIN_PUNCHES_FOR_SHARE else None
    prev_hand_pct = _hand_pct(prev_fam) if prev_total >= MIN_PUNCHES_FOR_SHARE else None

    days = [previous.start + timedelta(days=n) for n in range(14)]
    daily_hand = []
    for d in days:
        row = _family_totals(per, d, d)
        daily_hand.append(_hand_pct(row))
    odd = _odd_days(scope, previous.start, current.end)
    punch_days = _punch_days_by_day(scope, previous.start, current.end)
    miss_cur = _missing_window(odd, punch_days, [], current.start, current.end)
    miss_prev = _missing_window(odd, punch_days, [], previous.start, previous.end)
    odd_by_day = Counter(d for _e, _dept, d, _n in odd)

    devices = _Devices()
    health = _health(devices, today)
    silent = sum(
        1
        for key, h in health.items()
        if _status_of(h, devices.rows.get(int(key.split(":")[1])) if key.startswith("device:") else None) == "silent"
    ) + sum(
        1
        for row in devices.rows.values()
        if row["is_active"] and f"device:{row['id']}" not in health
    )
    hand_delta = change(hand_pct, prev_hand_pct)
    miss_delta = change(miss_cur["days"], miss_prev["days"])
    window = f"{current.start:%d %b} to {current.end:%d %b}"
    kpis = [
        {
            "id": "punches.hand-entered-pct",
            "label": "Hand-entered punches",
            "value": hand_pct,
            "format": "pct",
            "sub": (
                f"{_num(hand)} of {_num(total)} punches typed in or corrected by hand · {window}"
                if hand_pct is not None
                else f"Too few punches to call a share · {window}"
            ),
            "delta": {**hand_delta, "good": "down"} if hand_delta else None,
            "spark": daily_hand,
            "page": PAGE,
        },
        {
            "id": "punches.missing-days",
            "label": "Days with a missing punch",
            "value": miss_cur["days"],
            "format": "number",
            "sub": f"{_p(_missing_pct(miss_cur), 1)} of the days people punched · {window}"
            if miss_cur["punchDays"]
            else f"No punches in the last 7 days · {window}",
            "delta": {**miss_delta, "good": "down"} if miss_delta else None,
            "spark": [odd_by_day.get(d, 0) for d in days],
            "page": PAGE,
        },
        {
            "id": "punches.silent-devices",
            "label": "Silent devices",
            "value": silent,
            "format": "number",
            "sub": f"of {_num(len(devices.rows))} devices listed in Settings" if devices.rows else "No device is listed in Settings",
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
    ]
    entries = _provenance(
        scope, current, rows={"handEntered": hand, "punches": total, "missingDays": miss_cur["days"], "devices": len(devices.rows)}
    )
    return {"kpis": kpis, "provenance": _pick(entries, "punches-hand-entered", "punches-missing", "punches-silent")}


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)

TOOLS = [
    tool(
        "punch_summary",
        "How attendance punches arrived and where records are missing, for a period (default last 30 days), for the "
        "whole company or one unit, department or staff/production group: total punches and employees who punched, the "
        "share that was HAND-ENTERED (typed in by HR or an approved missing-punch correction) instead of captured by a "
        "device or phone, how many biometric devices are sending and which are silent, days with a missing punch (in "
        "without out) and how many have no correction request, unmatched device IDs, and how many employee-days with "
        "punches already have a day record, each with the previous period and a plain-English briefing. Use it for 'how are "
        "punches coming in', 'is any device down', 'how much attendance is typed in by hand'. Percentages are 0-100. Today "
        "is partial and left out of missing-punch figures.",
        punch_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "punch_sources",
        "Punches per day (per week for periods over 62 days) split by how they arrived: biometric devices, geo punch, "
        "on-duty, Excel import, approved missing-punch corrections, HR entries and other, with the hand-entered share of "
        "each day and the split of the whole period against the previous one. Use for 'what share of punches are manual', "
        "'is manual entry rising', 'how many punches come from geo attendance'. Percentages are 0-100.",
        punch_sources,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "punch_devices",
        "Punches per biometric device with the change against the previous period, the people who used it, its last punch "
        "and whether it is SILENT (nothing on 2 or more of the days it normally works) or stopped, worst first, and how many "
        "devices are not listed in Settings. Use for 'which device is down', 'has any device stopped sending', 'which "
        "device is busiest'. A device filter does not exist: units and departments filter the people, not the machines.",
        punch_devices,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_MAX},
    ),
    tool(
        "punch_missing",
        "Days with a punch missing (someone punched in and never out, or the reverse): how many and the share of the days "
        "people punched, against the previous period, how many already have a correction request and how many nobody has "
        "asked for, the correction requests by status, a department-by-day grid, and the people who have it again and again "
        "(default 3 or more days) with their dates. Use for 'who forgets to punch out', 'how many missing punches', 'has "
        "HR chased them'. Today is left out. Names are returned; use them only as the answer needs.",
        punch_missing,
        page=PAGE,
        period="last_30_days",
        extra={
            "limit": _LIMIT,
            "min_days": integer_param("Minimum days with a missing punch to count as a repeat case", minimum=1, maximum=100),
        },
        defaults={"limit": LIST_DEFAULT, "min_days": MISSING_REPEAT_MIN_DAYS},
    ),
    tool(
        "punch_manual",
        "Hand-entered punches (HR entries plus approved missing-punch corrections): their share of all punches against the "
        "previous period and day by day, the departments with the highest share, the employees with most HR-entered "
        "punches, who overrode day records or approved corrections, and manual attendance edits waiting for approval. Use "
        "for 'who is entering manual attendance', 'which department relies on manual punches'. The system does not record "
        "who typed an individual punch.",
        punch_manual,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
        person_fields=("userName",),
    ),
    tool(
        "punch_anomalies",
        "Punches that look wrong: double taps (two punches within 5 minutes) with the devices that have most, night-time "
        "punches (midnight to 05:00) by people not on a night shift with the devices behind them (often a wrong device "
        "clock), employee-days with six or more punches, and punches by hour of the day. Use for 'is a device clock wrong', "
        "'are there duplicate punches', 'when do people punch'.",
        punch_anomalies,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "punch_unmatched",
        "Device user IDs that punch but match no employee (their attendance is thrown away): how many are unresolved, how "
        "many punched in the period, the device they punch at and a hint (no such employee, or one who is inactive). "
        "Company-wide only. Use for 'is attendance being lost', 'which unknown IDs are punching'.",
        punch_unmatched,
        page=PAGE,
        period="last_30_days",
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "punch_coverage",
        "How many employee-days with punches already have an attendance day record (the verdicts payroll pays from), the "
        "dates with the biggest gap, day records that disagree with the punches (absent although the person punched, "
        "present with no punch), and the Attendance analytics' coverage of scheduled days. Use for 'is attendance fully "
        "processed', 'why are some days missing from attendance'. Today is left out.",
        punch_coverage,
        page=PAGE,
        period="last_30_days",
    ),
]
