"""The lifecycle of a DutyTrack, tied to the On-Duty session it belongs to.

  start_track(session)        called by on_duty_session_request IN THE SAME TRANSACTION that creates the session. The track
                              starts when the request is SUBMITTED (before any approval) and records from then on.
  end_track(track, reason)    the ONE function that ends a track (idempotent). Called by _end_on_duty_session (manual /
                              auto_4th_punch / auto_day_end), by the terminal-rejection branch of resolve_on_duty_session
                              ('rejected') and by an administrator ('admin'). Approving a request never touches the track.

Tracking ends ONLY for those reasons; nothing else (the phone going offline, the app being swiped away) ends it.
end_track closes the open interval events at ended_at, writes a TRACKING_STOPPED event and queues the final journey rebuild
in a background thread. Data collected so far is kept whatever the reason, rejection included.

``reconcile_orphan_tracks`` is the safety net: an ACTIVE track whose session is no longer in progress (a path that closed
the session without calling end_track, or a track left over from before this code) is ended with the reason the session
itself shows. The scheduler runs it every two minutes.
"""

from __future__ import annotations

import logging
from datetime import datetime

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from ..models import DutyTrack, DutyTrackEvent, GeoTrackingSettings, OnDutySession
from . import background

logger = logging.getLogger(__name__)

END_REASONS = tuple(code for code, _ in DutyTrack.END_REASON_CHOICES)


def add_event(
    track: DutyTrack, kind: str, started_at: datetime, *, source: str = "server", ended_at=None, meta=None
) -> DutyTrackEvent:
    """Create a server-side event on ``track`` and count it."""
    event = DutyTrackEvent.objects.create(
        track=track,
        employee_id=track.employee_id,
        device_id="",
        seq=None,
        kind=kind,
        source=source,
        started_at=started_at,
        ended_at=ended_at,
        meta=meta or {},
    )
    DutyTrack.objects.filter(pk=track.pk).update(events_count=F("events_count") + 1)
    return event


def start_track(session: OnDutySession, *, now: datetime | None = None) -> DutyTrack | None:
    """Create the track of a just-submitted On-Duty session (status active, waiting for the first fix) and its
    TRACKING_STARTED event. Returns None when tracking is switched off in the settings, or when the employee already has an
    active track (a second is never created). Call it inside the transaction that creates the session."""
    if not GeoTrackingSettings.get().enabled:
        return None
    existing = DutyTrack.objects.filter(session=session).first()
    if existing is not None:
        return existing
    now = now or timezone.now()
    # An active track whose session is over cannot be left to block the new one: end it as its session says.
    reconcile_orphan_tracks(session.employee_id, now=now, exclude_session_id=session.pk)
    if DutyTrack.objects.filter(employee_id=session.employee_id, status=DutyTrack.STATUS_ACTIVE).exists():
        return None
    try:
        with (
            transaction.atomic()
        ):  # a savepoint: a lost race on the unique index must not poison the caller's transaction
            track = DutyTrack.objects.create(
                session=session,
                employee_id=session.employee_id,
                branch_id=session.branch_id,
                status=DutyTrack.STATUS_ACTIVE,
                started_at=now,
                state=DutyTrack.STATE_WAITING,
                state_since=now,
            )
            add_event(track, DutyTrackEvent.KIND_TRACKING_STARTED, now, meta={"sessionId": session.pk})
    except IntegrityError:
        return None  # the other request won: one active track per employee
    return track


def end_track(track: DutyTrack, reason: str, *, now: datetime | None = None) -> bool:
    """End ``track`` for ``reason`` (one of manual, auto_4th_punch, auto_day_end, rejected, admin). Idempotent: an already
    ended track is left exactly as it is and False is returned. Returns True when this call ended it."""
    if reason not in END_REASONS:
        raise ValueError(f"unknown track end reason: {reason!r}")
    now = now or timezone.now()
    with transaction.atomic():
        locked = DutyTrack.objects.select_for_update().get(pk=track.pk)
        if locked.status == DutyTrack.STATUS_ENDED:
            _sync(track, locked)
            return False
        locked.status = DutyTrack.STATUS_ENDED
        locked.ended_at = now
        locked.end_reason = reason
        locked.state = DutyTrack.STATE_ENDED
        locked.state_since = now
        locked.save(update_fields=["status", "ended_at", "end_reason", "state", "state_since"])
        # An interval still open when the track ends (GPS off, no network, signal lost ...) ends with it.
        for event in DutyTrackEvent.objects.filter(
            track=locked, ended_at__isnull=True, kind__in=DutyTrackEvent.INTERVAL_KINDS
        ):
            event.ended_at = max(now, event.started_at)
            event.meta = {**(event.meta or {}), "closedBy": "track_end"}
            event.save(update_fields=["ended_at", "meta"])
        add_event(locked, DutyTrackEvent.KIND_TRACKING_STOPPED, now, meta={"reason": reason})
    _sync(track, locked)
    _queue_final_rebuild(locked.pk)
    return True


def _sync(target: DutyTrack, source: DutyTrack) -> None:
    """Reflect the stored values onto the instance the caller holds."""
    for attr in ("status", "ended_at", "end_reason", "state", "state_since"):
        setattr(target, attr, getattr(source, attr))


def _queue_final_rebuild(track_id: int) -> None:
    """The final journey rebuild: a background thread in production, started only once the caller's transaction (the session
    close that ended the track) has COMMITTED, so the thread reads the ended track, not the one before. Inline under the
    test runner."""

    def go() -> None:
        try:
            background.run_job(("rebuild", track_id), background.rebuild_job, track_id)
        except Exception:
            # the track IS ended; a failed rebuild is retried by the next late upload or HR's Rebuild button
            logger.exception("Final journey rebuild of track %s failed", track_id)

    if background.inline_mode():
        go()
    else:
        transaction.on_commit(go)  # runs at once when no transaction is open


def end_track_for_session(session: OnDutySession, reason: str, *, now: datetime | None = None) -> bool:
    """end_track for the track of ``session`` (a no-op when the session has none: tracking was off, or the session is older
    than this feature)."""
    track = DutyTrack.objects.filter(session=session).first()
    if track is None:
        return False
    return end_track(track, reason, now=now)


def session_end_reason(session: OnDutySession) -> str:
    """The track end reason a session that is over implies (used for the orphan safety net)."""
    if session.status == OnDutySession.STATUS_REJECTED:
        return DutyTrack.END_REJECTED
    if session.completion_reason in (
        OnDutySession.COMPLETION_AUTO_4TH_PUNCH,
        OnDutySession.COMPLETION_AUTO_DAY_END,
        OnDutySession.COMPLETION_MANUAL,
    ):
        return session.completion_reason
    return DutyTrack.END_MANUAL  # employee_ended_at set with no completion_reason: the employee marked it Done


def session_in_progress(session: OnDutySession) -> bool:
    """Is the session one the employee is still working under (pending or active, not marked Done)?"""
    return session.employee_ended_at is None and session.status in (
        OnDutySession.STATUS_PENDING_HOD,
        OnDutySession.STATUS_PENDING_HR,
        OnDutySession.STATUS_ACTIVE,
    )


def reconcile_orphan_tracks(
    employee_id: int | None = None, *, now: datetime | None = None, exclude_session_id: int | None = None
) -> int:
    """End every ACTIVE track whose session is no longer in progress. Returns how many were ended."""
    qs = DutyTrack.objects.filter(status=DutyTrack.STATUS_ACTIVE).select_related("session")
    if employee_id is not None:
        qs = qs.filter(employee_id=employee_id)
    if exclude_session_id is not None:
        qs = qs.exclude(session_id=exclude_session_id)
    ended = 0
    for track in qs:
        if not session_in_progress(track.session):
            if end_track(track, session_end_reason(track.session), now=now):
                ended += 1
    return ended
