"""POST /api/tracking/batch: the phone uploads what it recorded since the last acknowledged batch.

The contract (camelCase or snake_case at every level; times as epoch milliseconds or ISO-8601):

  body     {deviceId, app:{version, os, osVersion, model}, health:{permission, locationEnabled, backgroundRestricted,
            batteryOptimised, powerSave, batteryPct, charging, network}, clientTime?,
            points:[{seq, recordedAt, latitude, longitude, accuracy, speed, bearing, altitude, activity, battery,
                     charging, network, provider, isMocked}],
            events:[{seq, kind, startedAt, endedAt?, latitude?, longitude?, meta?}]}
  answer   {ok, ackSeq, accepted, duplicates, rejected, trackActive, endReason, serverTime, config}

Rules (each one is pinned by tests_geo_tracking_ingest.py):

* IDEMPOTENT. Every point and event carries a device-wide counter ``seq``; (employee, deviceId, seq) is unique, so a batch
  sent twice only counts as ``duplicates`` the second time. ``ackSeq`` is the highest seq among the rows the server has
  dealt with in THIS request (stored, already known, or refused for good): the app deletes its rows up to it. Send the rows
  of the queue in ascending seq order as one contiguous prefix. A batch with no rows acknowledges nothing (0).
* PER-ROW VALIDATION. A row that is not valid (bad seq/time/coordinates/accuracy, an unknown event kind, a time outside the
  tracks' windows) is counted ``rejected`` and never fails the batch.
* WHICH TRACK. Without a trackId in the body the server routes every row by its time: the newest track the row's time falls
  into (a recording track takes everything from its start; an ENDED track still takes rows up to 5 minutes after its end,
  the offline queue; a row up to 2 minutes before a track's start is accepted for the device clock's sake). A row no track
  wants is rejected. An employee with no track at all gets trackActive:false and nothing is stored.
* CONSENT. While the employee has not accepted the current notice version the batch is refused 403 CONSENT_REQUIRED.
* LIMITS. At most 500 points + 100 events and about 1 MB per call (413 BATCH_TOO_LARGE; nothing stored).
* EVENT PAIRING. An interval event (GPS_OFF, NETWORK_LOST, AIRPLANE_ON, POWER_SAVE_ON) is stored open; its END event
  (GPS_ON, NETWORK_RESTORED, AIRPLANE_OFF, POWER_SAVE_OFF) is never stored as a row: it closes the latest open interval of
  the paired kind (the closing seq is kept in that row's meta.endSeq so a re-sent END is a duplicate too). An END with no
  open start is stored as a zero-length interval of the start kind (meta.unpaired). A second START while one is open is a
  duplicate.
* ONE TRANSACTION, short locks. The employee's newest tracks are locked with select_for_update for the length of the insert,
  so two concurrent batches (or a batch racing end_track) serialise and the counters stay exact. Points are inserted with
  bulk_create(ignore_conflicts=True). The journey rebuild is throttled (>= 30 s apart), runs after the commit, inline when
  the track is small and in a background thread when it is not.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from ..models import (
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    GeoTrackingSettings,
    TrackingConsent,
    TrackingDevice,
)
from . import background, journey, live
from . import settings as geo_settings
from .parsing import normalize, parse_bool, parse_float, parse_int, parse_time, pick

logger = logging.getLogger(__name__)

MAX_POINTS = 500
MAX_EVENTS = 100
MAX_BODY_BYTES = 1024 * 1024
LATE_GRACE = timedelta(minutes=5)
START_SLACK = timedelta(minutes=2)
FUTURE_SUSPECT = timedelta(minutes=2)
FUTURE_REJECT = timedelta(days=1)
CLOCK_SKEW_SUSPECT_S = 120
REBUILD_THROTTLE_S = 30
INLINE_REBUILD_MAX_POINTS = 800
META_MAX_CHARS = 2000

_ACTIVITY_ALIASES = {
    "stationary": "still",
    "idle": "still",
    "on_foot": "walking",
    "walk": "walking",
    "run": "running",
    "in_vehicle": "vehicle",
    "automotive": "vehicle",
    "driving": "vehicle",
    "car": "vehicle",
    "on_bicycle": "bicycle",
    "cycling": "bicycle",
}
_NETWORK_ALIASES = {
    "cellular": "cell",
    "mobile": "cell",
    "4g": "cell",
    "5g": "cell",
    "3g": "cell",
    "offline": "none",
    "no": "none",
}
_PERMISSION_ALIASES = {
    "always": "always",
    "background": "always",
    "granted_always": "always",
    "all_the_time": "always",
    "while_using": "while_using",
    "foreground": "while_using",
    "when_in_use": "while_using",
    "whenInUse": "while_using",
    "wheninuse": "while_using",
    "granted": "while_using",
    "denied": "denied",
    "blocked": "denied",
    "none": "denied",
}


class BatchError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.body = {"error": message, "code": code, **extra}


@dataclass
class _Point:
    seq: int
    recorded_at: datetime
    latitude: float
    longitude: float
    accuracy: float
    speed: float | None
    bearing: float | None
    altitude: float | None
    activity: str
    battery: int | None
    charging: bool | None
    network: str
    provider: str
    is_mock: bool
    suspect: bool


@dataclass
class _Event:
    seq: int
    kind: str
    started_at: datetime
    ended_at: datetime | None
    latitude: float | None
    longitude: float | None
    meta: dict


@dataclass
class _Tally:
    accepted: int = 0
    duplicates: int = 0
    rejected: int = 0
    accepted_points: int = 0
    accepted_events: int = 0
    reasons: dict = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        self.rejected += 1
        self.reasons[reason] = self.reasons.get(reason, 0) + 1


# ── parsing one row ──────────────────────────────────────────────────────────────────────────────────────────────────


def _clean_choice(value, allowed, aliases=None) -> str:
    text = str(value).strip().lower() if value is not None else ""
    text = (aliases or {}).get(text, text)
    return text if text in allowed else "unknown"


def _parse_battery(value) -> int | None:
    n = parse_float(value, lo=0.0, hi=100.0)
    if n is None:
        return None
    if isinstance(value, float) and 0.0 < n <= 1.0:  # a 0..1 fraction (expo-battery) rather than a percentage
        n *= 100.0
    return int(round(n))


def parse_point(raw, now: datetime, batch_skewed: bool) -> tuple[_Point | None, str]:
    if not isinstance(raw, dict):
        return None, "shape"
    r = normalize(raw)
    seq = parse_int(pick(r, "seq"), lo=0)
    if seq is None:
        return None, "seq"
    recorded_at = parse_time(pick(r, "recorded_at", "timestamp", "time", "t"))
    if recorded_at is None or recorded_at - now > FUTURE_REJECT:
        return None, "time"
    lat = parse_float(pick(r, "latitude", "lat"), lo=-90.0, hi=90.0)
    lng = parse_float(pick(r, "longitude", "lng", "lon"), lo=-180.0, hi=180.0)
    if lat is None or lng is None or (lat == 0.0 and lng == 0.0):
        return None, "coordinates"
    accuracy = parse_float(pick(r, "accuracy", "accuracy_m"), lo=0.0)
    if accuracy is None:
        return None, "accuracy"
    speed = parse_float(pick(r, "speed", "speed_mps"), lo=0.0)
    bearing = parse_float(pick(r, "bearing", "heading", "bearing_deg"), lo=0.0, hi=360.0)
    altitude = parse_float(pick(r, "altitude", "altitude_m"))
    return (
        _Point(
            seq=seq,
            recorded_at=recorded_at,
            latitude=lat,
            longitude=lng,
            accuracy=accuracy,
            speed=speed,
            bearing=bearing,
            altitude=altitude,
            activity=_clean_choice(pick(r, "activity"), DutyTrackPoint.ACTIVITIES, _ACTIVITY_ALIASES),
            battery=_parse_battery(pick(r, "battery", "battery_pct", "battery_level")),
            charging=parse_bool(pick(r, "charging", "is_charging")),
            network=_clean_choice(pick(r, "network"), DutyTrackPoint.NETWORKS, _NETWORK_ALIASES),
            provider=_clean_choice(pick(r, "provider"), DutyTrackPoint.PROVIDERS),
            is_mock=bool(parse_bool(pick(r, "is_mocked", "is_mock", "mocked"), default=False)),
            suspect=batch_skewed or recorded_at - now > FUTURE_SUSPECT,
        ),
        "",
    )


def parse_event(raw) -> tuple[_Event | None, str]:
    if not isinstance(raw, dict):
        return None, "shape"
    r = normalize(raw)
    seq = parse_int(pick(r, "seq"), lo=0)
    if seq is None:
        return None, "seq"
    kind = str(pick(r, "kind", "type", default="")).strip().upper()
    if kind not in DutyTrackEvent.DEVICE_KINDS and kind not in DutyTrackEvent.END_KINDS:
        return None, "kind"
    started = parse_time(pick(r, "started_at", "start", "recorded_at", "at", "time"))
    if started is None:
        return None, "time"
    ended = parse_time(pick(r, "ended_at", "end"))
    if ended is not None and ended < started:
        ended = started
    lat = parse_float(pick(r, "latitude", "lat"), lo=-90.0, hi=90.0)
    lng = parse_float(pick(r, "longitude", "lng", "lon"), lo=-180.0, hi=180.0)
    if lat is None or lng is None:
        lat = lng = None
    meta = r.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    try:
        if len(json.dumps(meta, default=str)) > META_MAX_CHARS:
            meta = {"truncated": True}
    except (TypeError, ValueError):
        meta = {}
    return _Event(seq, kind, started, ended, lat, lng, meta), ""


# ── routing ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def route(t: datetime, tracks: list[DutyTrack]) -> DutyTrack | None:
    """The track (of ``tracks``, newest first) that owns an instant, or None. A recording track owns everything from its
    start; an ended one owns up to 5 minutes after its end; before the first track's start 2 minutes of slack apply."""
    stopped_at = len(tracks)
    for i, track in enumerate(tracks):
        if t >= track.started_at:
            if track.status == DutyTrack.STATUS_ACTIVE or (track.ended_at and t <= track.ended_at + LATE_GRACE):
                return track
            stopped_at = i
            break
    if stopped_at > 0:
        newer = tracks[stopped_at - 1]
        if t >= newer.started_at - START_SLACK:
            return newer
    return None


# ── consent ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def consent_required(employee_id: int, s: GeoTrackingSettings) -> bool:
    return not TrackingConsent.objects.filter(employee_id=employee_id, notice_version=s.notice_version).exists()


def record_consent(employee_id: int, device_id: str, notice_version: int, ip: str = "") -> TrackingConsent:
    return TrackingConsent.objects.create(
        employee_id=employee_id, device_id=device_id[:64], notice_version=notice_version, ip=(ip or "")[:45]
    )


# ── the batch ────────────────────────────────────────────────────────────────────────────────────────────────────────


def ingest_batch(employee, body, *, ip: str = "", now: datetime | None = None) -> dict:
    """Process one upload for ``employee`` and return the answer body. Raises BatchError for a refusal (400/403/413)."""
    now = now or timezone.now()
    s = GeoTrackingSettings.get()
    data = normalize(body)
    points_raw = data.get("points") if data.get("points") is not None else []
    events_raw = data.get("events") if data.get("events") is not None else []
    if not isinstance(points_raw, list) or not isinstance(events_raw, list):
        raise BatchError(400, "BAD_BATCH", "points and events must be lists.")
    if len(points_raw) > MAX_POINTS or len(events_raw) > MAX_EVENTS:
        raise BatchError(
            413,
            "BATCH_TOO_LARGE",
            f"A batch holds at most {MAX_POINTS} points and {MAX_EVENTS} events.",
            maxPoints=MAX_POINTS,
            maxEvents=MAX_EVENTS,
        )
    device_id = str(pick(data, "device_id", default="")).strip()[:64]
    if not device_id:
        raise BatchError(400, "DEVICE_ID_REQUIRED", "deviceId is required.")

    client_time = parse_time(pick(data, "client_time", "sent_at", "device_time"))
    batch_skewed = client_time is not None and abs((now - client_time).total_seconds()) > CLOCK_SKEW_SUSPECT_S

    tally = _Tally()
    points: list[_Point] = []
    events: list[_Event] = []
    acked: list[int] = []
    for raw in points_raw:
        point, why = parse_point(raw, now, batch_skewed)
        if point is None:
            tally.reject(why)
            seq = parse_int(pick(normalize(raw), "seq"), lo=0) if isinstance(raw, dict) else None
            if seq is not None and why != "seq":
                acked.append(seq)
            continue
        points.append(point)
    for raw in events_raw:
        event, why = parse_event(raw)
        if event is None:
            tally.reject(why)
            seq = parse_int(pick(normalize(raw), "seq"), lo=0) if isinstance(raw, dict) else None
            if seq is not None and why != "seq":
                acked.append(seq)
            continue
        events.append(event)

    tracks = list(DutyTrack.objects.filter(employee=employee).order_by("-started_at", "-id")[:3])
    if not s.enabled or not tracks:
        # Nothing here can ever be stored: hand every seq back so the app drains its queue and stops.
        for p in points:
            tally.reject("no_track")
            acked.append(p.seq)
        for e in events:
            tally.reject("no_track")
            acked.append(e.seq)
        return _answer(s, now, tally, acked, track_active=False, end_reason=None)

    if consent_required(employee.pk, s):
        raise BatchError(
            403,
            "CONSENT_REQUIRED",
            "Accept the tracking notice before location can be recorded.",
            noticeVersion=s.notice_version,
        )

    touched: dict[int, DutyTrack] = {}
    new_events_for: set[int] = set()
    with transaction.atomic():
        locked = {
            t.pk: t for t in DutyTrack.objects.select_for_update().filter(pk__in=[t.pk for t in tracks]).order_by("id")
        }
        tracks = sorted(locked.values(), key=lambda t: (t.started_at, t.pk), reverse=True)

        _store_points(employee, device_id, points, tracks, now, tally, acked, touched)
        _store_events(employee, device_id, events, tracks, tally, acked, touched, new_events_for)

        for track in touched.values():
            if track.status == DutyTrack.STATUS_ACTIVE:
                DutyTrackEvent.objects.filter(
                    track=track, kind=DutyTrackEvent.KIND_SIGNAL_LOST, ended_at__isnull=True
                ).update(ended_at=now)
                live.refresh_state(track, now, s)
        primary = tracks[0]

    _update_device(employee, device_id, data, now, touched)
    for track in touched.values():
        _maybe_rebuild(track, now)

    return _answer(
        s,
        now,
        tally,
        acked,
        track_active=primary.status == DutyTrack.STATUS_ACTIVE,
        end_reason=primary.end_reason or None if primary.status == DutyTrack.STATUS_ENDED else None,
    )


def _answer(s, now, tally: _Tally, acked: list[int], *, track_active: bool, end_reason) -> dict:
    return {
        "ok": True,
        "ackSeq": max(acked) if acked else 0,
        "accepted": tally.accepted,
        "duplicates": tally.duplicates,
        "rejected": tally.rejected,
        "acceptedPoints": tally.accepted_points,
        "acceptedEvents": tally.accepted_events,
        "rejectedReasons": tally.reasons,
        "trackActive": track_active,
        "endReason": end_reason,
        "serverTime": now.isoformat(),
        "config": geo_settings.client_config(s),
    }


def _store_points(employee, device_id, points, tracks, now, tally, acked, touched) -> None:
    if not points:
        return
    known = set(
        DutyTrackPoint.objects.filter(
            employee=employee, device_id=device_id, seq__in=[p.seq for p in points]
        ).values_list("seq", flat=True)
    )
    seen: set[int] = set()
    fresh: list[tuple[DutyTrack, _Point]] = []
    for p in sorted(points, key=lambda p: (p.recorded_at, p.seq)):
        acked.append(p.seq)
        if p.seq in known or p.seq in seen:
            tally.duplicates += 1
            continue
        owner = route(p.recorded_at, tracks)
        if owner is None:
            tally.reject("outside_track")
            continue
        seen.add(p.seq)
        fresh.append((owner, p))
    if not fresh:
        return
    DutyTrackPoint.objects.bulk_create(
        [
            DutyTrackPoint(
                track=owner,
                employee=employee,
                device_id=device_id,
                seq=p.seq,
                recorded_at=p.recorded_at,
                received_at=now,
                latitude=round(p.latitude, 6),
                longitude=round(p.longitude, 6),
                accuracy_m=p.accuracy,
                speed_mps=p.speed,
                bearing_deg=p.bearing,
                altitude_m=p.altitude,
                activity=p.activity,
                battery_pct=p.battery,
                charging=p.charging,
                network=p.network,
                provider=p.provider,
                is_mock=p.is_mock,
                time_suspect=p.suspect,
            )
            for owner, p in fresh
        ],
        ignore_conflicts=True,
    )
    by_track: dict[int, list[_Point]] = {}
    for owner, p in fresh:
        by_track.setdefault(owner.pk, []).append(p)
        touched[owner.pk] = owner
    for track_id, rows in by_track.items():
        track = touched[track_id]
        mocks = sum(1 for p in rows if p.is_mock)
        DutyTrack.objects.filter(pk=track_id).update(
            points_count=F("points_count") + len(rows), mock_points=F("mock_points") + mocks
        )
        track.points_count += len(rows)
        track.mock_points += mocks
        newest = max(rows, key=lambda p: (p.recorded_at, p.seq))
        seen_at = min(newest.recorded_at, now)
        if track.last_point_at is None or seen_at > track.last_point_at:
            track.last_point_at = seen_at
            track.last_latitude = round(newest.latitude, 6)
            track.last_longitude = round(newest.longitude, 6)
            track.last_accuracy_m = newest.accuracy
            if newest.battery is not None:
                track.last_battery_pct = newest.battery
            if newest.network != "unknown":
                track.last_network = newest.network
            track.last_device_id = device_id
            DutyTrack.objects.filter(pk=track_id).update(
                last_point_at=track.last_point_at,
                last_latitude=track.last_latitude,
                last_longitude=track.last_longitude,
                last_accuracy_m=track.last_accuracy_m,
                last_battery_pct=track.last_battery_pct,
                last_network=track.last_network,
                last_device_id=device_id,
            )
    tally.accepted += len(fresh)
    tally.accepted_points += len(fresh)


def _store_events(employee, device_id, events, tracks, tally, acked, touched, new_events_for) -> None:
    if not events:
        return
    seqs = [e.seq for e in events]
    known = set(
        DutyTrackEvent.objects.filter(employee=employee, device_id=device_id, seq__in=seqs).values_list(
            "seq", flat=True
        )
    )
    # the seq of an END event lives in the closed interval's meta (END events have no row of their own)
    known |= {
        int(v)
        for v in DutyTrackEvent.objects.filter(
            employee=employee, device_id=device_id, meta__endSeq__in=seqs
        ).values_list("meta__endSeq", flat=True)
        if v is not None
    }
    seen: set[int] = set()
    for e in sorted(events, key=lambda e: (e.started_at, e.seq)):
        acked.append(e.seq)
        if e.seq in known or e.seq in seen:
            tally.duplicates += 1
            continue
        owner = route(e.started_at, tracks)
        if owner is None:
            tally.reject("outside_track")
            continue
        seen.add(e.seq)
        outcome = _apply_event(employee, device_id, owner, e)
        if outcome == "duplicate":
            tally.duplicates += 1
            continue
        tally.accepted += 1
        tally.accepted_events += 1
        touched[owner.pk] = owner
        if outcome == "created":
            DutyTrack.objects.filter(pk=owner.pk).update(events_count=F("events_count") + 1)
            owner.events_count += 1


def _apply_event(employee, device_id, track: DutyTrack, e: _Event) -> str:
    """Store or pair one event. Returns 'created', 'closed' (an END event closed an open interval) or 'duplicate'."""
    row = dict(
        track=track,
        employee=employee,
        device_id=device_id,
        source=DutyTrackEvent.SOURCE_DEVICE,
        latitude=round(e.latitude, 6) if e.latitude is not None else None,
        longitude=round(e.longitude, 6) if e.longitude is not None else None,
    )
    if e.kind in DutyTrackEvent.END_KINDS:
        start_kind = DutyTrackEvent.END_KINDS[e.kind]
        open_interval = (
            DutyTrackEvent.objects.filter(
                track=track, kind=start_kind, ended_at__isnull=True, started_at__lte=e.started_at
            )
            .order_by("-started_at", "-id")
            .first()
        )
        if open_interval is not None:
            open_interval.ended_at = e.started_at
            open_interval.meta = {**(open_interval.meta or {}), "endSeq": e.seq, "closedBy": "device"}
            open_interval.save(update_fields=["ended_at", "meta"])
            return "closed"
        DutyTrackEvent.objects.create(
            seq=e.seq,
            kind=start_kind,
            started_at=e.started_at,
            ended_at=e.started_at,
            meta={**e.meta, "unpaired": True, "endKind": e.kind},
            **row,
        )
        return "created"
    if e.kind in DutyTrackEvent.INTERVAL_KINDS:
        if (
            DutyTrackEvent.objects.filter(track=track, kind=e.kind, ended_at__isnull=True).exists()
            and e.ended_at is None
        ):
            return "duplicate"  # already open: the app re-reported the state after a restart
        DutyTrackEvent.objects.create(
            seq=e.seq, kind=e.kind, started_at=e.started_at, ended_at=e.ended_at, meta=e.meta, **row
        )
        return "created"
    DutyTrackEvent.objects.create(seq=e.seq, kind=e.kind, started_at=e.started_at, ended_at=None, meta=e.meta, **row)
    return "created"


# ── device health ────────────────────────────────────────────────────────────────────────────────────────────────────


def _update_device(employee, device_id: str, data: dict, now: datetime, touched: dict) -> None:
    app = normalize(data.get("app"))
    health = normalize(data.get("health"))
    fields: dict = {"last_seen_at": now, "last_heartbeat_at": now}
    for column, value in (
        ("platform", pick(app, "os", "platform")),
        ("os_version", pick(app, "os_version")),
        ("model", pick(app, "model")),
        ("app_version", pick(app, "version", "app_version")),
    ):
        if value not in (None, ""):
            limit = {"platform": 16, "os_version": 32, "model": 64, "app_version": 32}[column]
            fields[column] = str(value).strip().lower()[:limit] if column == "platform" else str(value).strip()[:limit]
    permission = pick(health, "permission", "permission_level")
    if permission is not None:
        fields["permission_level"] = _clean_choice(permission, TrackingDevice.PERMISSION_LEVELS, _PERMISSION_ALIASES)
    for column, names in (
        ("location_enabled", ("location_enabled",)),
        ("background_restricted", ("background_restricted",)),
        ("battery_optimised", ("battery_optimised", "battery_optimized")),
        ("power_save", ("power_save",)),
    ):
        value = parse_bool(pick(health, *names))
        if value is not None:
            fields[column] = value
    battery = _parse_battery(pick(health, "battery_pct", "battery"))
    if battery is not None:
        fields["last_battery_pct"] = battery
    network = pick(health, "network")
    if network is not None:
        fields["last_network"] = _clean_choice(network, DutyTrackPoint.NETWORKS, _NETWORK_ALIASES)
    try:
        with transaction.atomic():
            updated = TrackingDevice.objects.filter(employee=employee, device_id=device_id).update(**fields)
            if not updated:
                TrackingDevice.objects.create(employee=employee, device_id=device_id, **fields)
    except IntegrityError:  # two first batches from a new phone at once: the other one created it
        TrackingDevice.objects.filter(employee=employee, device_id=device_id).update(**fields)
    # the newest health values also describe the track itself when the points carried none
    for track in touched.values():
        update = {}
        if "last_battery_pct" in fields and track.last_battery_pct is None:
            update["last_battery_pct"] = fields["last_battery_pct"]
        if fields.get("last_network") not in (None, "unknown") and not track.last_network:
            update["last_network"] = fields["last_network"]
        if update:
            DutyTrack.objects.filter(pk=track.pk).update(**update)


# ── rebuild scheduling ───────────────────────────────────────────────────────────────────────────────────────────────


def _maybe_rebuild(track: DutyTrack, now: datetime) -> None:
    """Rebuild the journey when it is stale: always for an ended track (late data), at most every 30 s for a recording one.
    Small tracks rebuild inline (it takes milliseconds), big ones in a background thread. Never raises."""
    try:
        if track.status == DutyTrack.STATUS_ACTIVE:
            fresh = DutyTrack.objects.filter(pk=track.pk).values_list("rebuilt_at", flat=True).first()
            if fresh is not None and (now - fresh).total_seconds() < REBUILD_THROTTLE_S:
                return
        if background.inline_mode() or track.points_count <= INLINE_REBUILD_MAX_POINTS:
            journey.rebuild(track.pk, now=now)
        else:
            background.run_job(("rebuild", track.pk), background.rebuild_job, track.pk)
    except Exception:
        logger.exception("Journey rebuild of track %s failed", track.pk)
