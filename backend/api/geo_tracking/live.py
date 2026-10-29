"""The live state of a track: what the Live Map shows for each employee on duty.

  waiting_first_fix  the track started and no fix has arrived yet
  moving             recording, not inside a stop (includes "stopped for less than stop_seconds")
  stationary         inside a stop of at least stop_seconds (the newest fixes all stay in one place)
  offline            no data for signal_lost_seconds and location is not switched off (the watchdog also writes a
                     SIGNAL_LOST event)
  location_off       the phone reported GPS off and has not reported it back on
  ended              the track is over

``classify_state`` is pure. ``tail_state`` / ``refresh_state`` read only the newest fixes (a time window of a few stop
lengths, capped), so a batch can update the state cheaply. ``effective_state`` is the no-query overlay the HR views use so
a track that has gone quiet reads "offline" at once, not up to two minutes later when the watchdog next runs.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.utils import timezone

from ..models import DutyTrack, DutyTrackEvent, DutyTrackPoint, GeoTrackingSettings
from . import journey

TAIL_MAX_ROWS = 400
TAIL_MIN_WINDOW_S = 900


def classify_state(
    *,
    status: str,
    now: datetime,
    started_at: datetime,
    last_point_at: datetime | None,
    location_off: bool,
    in_open_stop: bool,
    signal_lost_seconds: int,
) -> str:
    if status == DutyTrack.STATUS_ENDED:
        return DutyTrack.STATE_ENDED
    if location_off:
        return DutyTrack.STATE_LOCATION_OFF
    if last_point_at is None:
        if (now - started_at).total_seconds() >= signal_lost_seconds:
            return DutyTrack.STATE_OFFLINE
        return DutyTrack.STATE_WAITING
    if (now - last_point_at).total_seconds() >= signal_lost_seconds:
        return DutyTrack.STATE_OFFLINE
    if in_open_stop:
        return DutyTrack.STATE_STATIONARY
    return DutyTrack.STATE_MOVING


def effective_state(track: DutyTrack, now: datetime, signal_lost_seconds: int) -> str:
    """The stored state, except that a recording track with no data for signal_lost_seconds reads as offline (unless
    location is off, which already says why). No queries."""
    state = track.state
    if track.status == DutyTrack.STATUS_ENDED:
        return DutyTrack.STATE_ENDED
    if state in (DutyTrack.STATE_LOCATION_OFF, DutyTrack.STATE_OFFLINE):
        return state
    reference = track.last_point_at or track.started_at
    if (now - reference).total_seconds() >= signal_lost_seconds:
        return DutyTrack.STATE_OFFLINE
    return state


def tail_state(track: DutyTrack, now: datetime, s: GeoTrackingSettings) -> tuple[str, datetime | None]:
    """(state, since) computed from the newest fixes and the open events. ``since`` is a hint for state_since: the start of
    the stop, the start of the GPS-off interval, the last fix before going offline; None means "now"."""
    params = journey.Params.from_settings(s)
    location_off_event = (
        DutyTrackEvent.objects.filter(track=track, kind=DutyTrackEvent.KIND_GPS_OFF, ended_at__isnull=True)
        .order_by("-started_at")
        .first()
    )
    last_point_at = track.last_point_at
    in_open_stop = False
    stop_start: datetime | None = None
    if last_point_at is not None and location_off_event is None:
        window = max(TAIL_MIN_WINDOW_S, 3 * params.stop_seconds)
        rows = list(
            DutyTrackPoint.objects.filter(track=track, recorded_at__gte=last_point_at - timedelta(seconds=window))
            .order_by("-recorded_at", "-seq")
            .values(
                "recorded_at",
                "latitude",
                "longitude",
                "accuracy_m",
                "speed_mps",
                "activity",
                "is_mock",
                "time_suspect",
                "seq",
            )[:TAIL_MAX_ROWS]
        )
        rows.reverse()
        cleaned = journey.clean([journey.fix_from_row(r) for r in rows], params).fixes
        stops = journey.detect_stops(cleaned, params)
        if stops and stops[-1].end == len(cleaned) - 1:
            in_open_stop = True
            stop_start = journey.from_epoch(cleaned[stops[-1].start].t)
    state = classify_state(
        status=track.status,
        now=now,
        started_at=track.started_at,
        last_point_at=last_point_at,
        location_off=location_off_event is not None,
        in_open_stop=in_open_stop,
        signal_lost_seconds=s.signal_lost_seconds,
    )
    since = None
    if state == DutyTrack.STATE_LOCATION_OFF:
        since = location_off_event.started_at
    elif state == DutyTrack.STATE_STATIONARY:
        since = stop_start
    elif state == DutyTrack.STATE_OFFLINE:
        since = last_point_at or track.started_at
    return state, since


def refresh_state(track: DutyTrack, now: datetime | None = None, s: GeoTrackingSettings | None = None) -> str:
    """Recompute the track's state and persist it when it changed. Returns the new state."""
    now = now or timezone.now()
    s = s or GeoTrackingSettings.get()
    state, since = tail_state(track, now, s)
    if state != track.state:
        DutyTrack.objects.filter(pk=track.pk, status=DutyTrack.STATUS_ACTIVE).update(
            state=state, state_since=since or now
        )
        track.state = state
        track.state_since = since or now
    return state
