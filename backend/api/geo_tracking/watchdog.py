"""The scheduler's tracking jobs (api/geo_tracking_scheduler.py calls these; tests call them directly).

run_watchdog   every 2 minutes: end orphan tracks, write ONE SIGNAL_LOST interval event for each recording track that has
               been silent for signal_lost_seconds (the next batch closes it), refresh every recording track's state, then
               let the reverse-geocode worker fill a few addresses (a no-op while the provider is 'off')
purge_old      daily: delete raw points and events older than retention_days (segments and the summary are kept, and the
               track is flagged so a rebuild can never wipe its history)
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.db import transaction
from django.utils import timezone

from ..models import DutyTrack, DutyTrackEvent, DutyTrackPoint
from . import geocode, live, sessions
from . import settings as geo_settings

logger = logging.getLogger(__name__)

PURGE_BATCH = 5000


def run_watchdog(now: datetime | None = None) -> dict:
    now = now or timezone.now()
    s = geo_settings.get()
    result = {"orphansEnded": 0, "signalLost": 0, "statesRefreshed": 0, "geocode": None}
    try:
        result["orphansEnded"] = sessions.reconcile_orphan_tracks(now=now)
    except Exception:
        logger.exception("Geo-tracking orphan check failed")
    for track in DutyTrack.objects.filter(status=DutyTrack.STATUS_ACTIVE):
        try:
            if _mark_signal_lost(track.pk, now, s.signal_lost_seconds):
                result["signalLost"] += 1
            live.refresh_state(DutyTrack.objects.get(pk=track.pk), now, s)
            result["statesRefreshed"] += 1
        except Exception:
            logger.exception("Geo-tracking watchdog failed for track %s", track.pk)
    try:
        result["geocode"] = geocode.run_geocode_worker()
    except Exception:
        logger.exception("Geo-tracking geocode worker failed")
    return result


def _mark_signal_lost(track_id: int, now: datetime, signal_lost_seconds: int) -> bool:
    """Create the SIGNAL_LOST interval for a silent recording track (once). Locks the track row so a batch arriving at the
    same moment is either seen (not silent) or serialised after the event exists (and then closes it)."""
    with transaction.atomic():
        track = DutyTrack.objects.select_for_update().get(pk=track_id)
        if track.status != DutyTrack.STATUS_ACTIVE:
            return False
        heard = track.last_point_at or track.started_at
        if (now - heard).total_seconds() < signal_lost_seconds:
            return False
        if DutyTrackEvent.objects.filter(track=track, kind=DutyTrackEvent.KIND_GPS_OFF, ended_at__isnull=True).exists():
            return False  # location is off: that already says why
        if DutyTrackEvent.objects.filter(
            track=track, kind=DutyTrackEvent.KIND_SIGNAL_LOST, ended_at__isnull=True
        ).exists():
            return False
        sessions.add_event(track, DutyTrackEvent.KIND_SIGNAL_LOST, heard, meta={"detectedAt": now.isoformat()})
        return True


def purge_old(now: datetime | None = None) -> dict:
    """Delete raw points and events past the retention window. Segments, the summary and the track row stay."""
    now = now or timezone.now()
    cutoff = now - timedelta(days=geo_settings.get().retention_days)
    purged_points = purged_events = 0
    tracks: set[int] = set()
    while True:
        rows = list(
            DutyTrackPoint.objects.filter(recorded_at__lt=cutoff, track__status=DutyTrack.STATUS_ENDED).values_list(
                "id", "track_id"
            )[:PURGE_BATCH]
        )
        if not rows:
            break
        tracks.update(t for _, t in rows)
        purged_points += DutyTrackPoint.objects.filter(id__in=[i for i, _ in rows]).delete()[0]
    while True:
        rows = list(
            DutyTrackEvent.objects.filter(started_at__lt=cutoff, track__status=DutyTrack.STATUS_ENDED).values_list(
                "id", "track_id"
            )[:PURGE_BATCH]
        )
        if not rows:
            break
        tracks.update(t for _, t in rows)
        purged_events += DutyTrackEvent.objects.filter(id__in=[i for i, _ in rows]).delete()[0]
    for track in DutyTrack.objects.filter(pk__in=tracks):
        DutyTrack.objects.filter(pk=track.pk).update(flags={**(track.flags or {}), "purgedAt": now.isoformat()})
    return {"points": purged_points, "events": purged_events, "tracks": len(tracks), "cutoff": cutoff.isoformat()}
