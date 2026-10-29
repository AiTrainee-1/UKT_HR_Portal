"""The JSON shapes of the tracking API (all camelCase out). Shared by the employee and the HR views, so an employee's
``/tracking/my-journeys`` and HR's ``/tracking/journeys`` list the same fields."""

from __future__ import annotations

from datetime import datetime

from django.utils import timezone

from ..models import DutyTrack, DutyTrackEvent, DutyTrackSegment, OnDutyPunchVerification, TrackingDevice
from . import live


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _f(value) -> float | None:
    return float(value) if value is not None else None


def duration_s(track: DutyTrack, now: datetime) -> int:
    end = track.ended_at or now
    return max(0, int((end - track.started_at).total_seconds()))


def punch_counts(session_ids: list[int]) -> dict[int, int]:
    """{session id: how many of the day's four punch slots hold a punch that was not rejected}, in one query. A slot that was
    rejected and then punched again counts once, and a rejected punch that was never redone not at all."""
    slots: dict[int, set[int]] = {}
    rows = (
        OnDutyPunchVerification.objects.filter(session_id__in=session_ids)
        .exclude(status=OnDutyPunchVerification.STATUS_REJECTED)
        .values_list("session_id", "punch_number")
    )
    for session_id, number in rows:
        slots.setdefault(session_id, set()).add(number)
    return {session_id: len(numbers) for session_id, numbers in slots.items()}


def track_item(track: DutyTrack, now: datetime, signal_lost_seconds: int, punch_count: int | None = None) -> dict:
    """One row of the journey list (needs track.employee(+department), track.branch and track.session loaded).
    `punch_count` (the list passes it) adds `punchCount`: the geo-punches recorded under this journey's session."""
    emp = track.employee
    item = {
        "id": track.pk,
        "sessionId": track.session_id,
        "employeeId": track.employee_id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "branchName": track.branch.name if track.branch_id and track.branch else None,
        "destination": track.session.destination,
        "startedAt": iso(track.started_at),
        "endedAt": iso(track.ended_at),
        "endReason": track.end_reason or None,
        "status": track.status,
        "state": live.effective_state(track, now, signal_lost_seconds),
        "durationS": duration_s(track, now),
        "distanceM": round(track.distance_m or 0.0, 1),
        "travelS": track.travel_s,
        "stopS": track.stop_s,
        "gapS": track.gap_s,
        "stopCount": track.stop_count,
        "longestStopS": track.longest_stop_s,
        "pointsCount": track.points_count,
        "eventsCount": track.events_count,
        "hasMock": track.mock_points > 0,
        "approvalStatus": track.session.status,
        "lastPointAt": iso(track.last_point_at),
    }
    if punch_count is not None:
        item["punchCount"] = punch_count
    return item


def track_head(track: DutyTrack, now: datetime, signal_lost_seconds: int) -> dict:
    """The list item plus the last known snapshot (the `track` of the journey detail)."""
    return {
        **track_item(track, now, signal_lost_seconds),
        "stateSince": iso(track.state_since),
        "lastLatitude": _f(track.last_latitude),
        "lastLongitude": _f(track.last_longitude),
        "lastAccuracyM": track.last_accuracy_m,
        "lastBatteryPct": track.last_battery_pct,
        "lastNetwork": track.last_network or None,
    }


def summary_dict(track: DutyTrack, now: datetime) -> dict:
    return {
        "distanceM": round(track.distance_m or 0.0, 1),
        "travelS": track.travel_s,
        "stopS": track.stop_s,
        "gapS": track.gap_s,
        "stopCount": track.stop_count,
        "longestStopS": track.longest_stop_s,
        "maxSpeedKmh": round(track.max_speed_kmh or 0.0, 1),
        "durationS": duration_s(track, now),
        "firstPointAt": iso(track.first_point_at),
        "summaryThrough": iso(track.summary_through),
        "rebuiltAt": iso(track.rebuilt_at),
        "pointsCount": track.points_count,
        "eventsCount": track.events_count,
        "mockPoints": track.mock_points,
        "flags": track.flags or {},
    }


def segment_dict(seg: DutyTrackSegment) -> dict:
    return {
        "id": seg.pk,
        "seqNo": seg.seq_no,
        "kind": seg.kind,
        "startedAt": iso(seg.started_at),
        "endedAt": iso(seg.ended_at),
        "durationS": seg.duration_s,
        "distanceM": round(seg.distance_m or 0.0, 1),
        "startLat": _f(seg.start_lat),
        "startLng": _f(seg.start_lng),
        "endLat": _f(seg.end_lat),
        "endLng": _f(seg.end_lng),
        "centerLat": _f(seg.center_lat),
        "centerLng": _f(seg.center_lng),
        "radiusM": seg.radius_m,
        "pointCount": seg.point_count,
        "avgSpeedKmh": seg.avg_speed_kmh,
        "maxSpeedKmh": seg.max_speed_kmh,
        "polyline": seg.polyline or [],
        "address": seg.address or "",
        "cause": seg.cause or "",
        "estimated": seg.estimated,
        "eventId": seg.event_id,
        "meta": seg.meta or {},
    }


def event_dict(ev: DutyTrackEvent) -> dict:
    duration = int((ev.ended_at - ev.started_at).total_seconds()) if ev.ended_at else None
    return {
        "id": ev.pk,
        "kind": ev.kind,
        "source": ev.source,
        "startedAt": iso(ev.started_at),
        "endedAt": iso(ev.ended_at),
        "durationS": duration,
        "open": ev.kind in DutyTrackEvent.INTERVAL_KINDS and ev.ended_at is None,
        "latitude": _f(ev.latitude),
        "longitude": _f(ev.longitude),
        "meta": {k: v for k, v in (ev.meta or {}).items() if k != "endSeq"},
        "deviceId": ev.device_id or None,
    }


def punch_dict(v: OnDutyPunchVerification) -> dict:
    """One geo-punch of the journey's session (the `punches` of the journey detail). The photos are not inlined: `hasPhoto` /
    `hasPhoto2` say they exist, and GET /api/on-duty-punch-verifications/<id>/photo?n=1|2 serves them (the owner, branch
    HR and the department head may open it). `punchDate` / `punchTime` are the factory's (IST) wall clock, like everywhere
    else a punch is shown."""
    return {
        "id": v.pk,
        "punchNumber": v.punch_number,
        "punchType": v.punch_type,
        "punchDate": str(v.punch_date),
        "punchTime": v.punch_time.strftime("%H:%M:%S"),
        "latitude": float(v.latitude),
        "longitude": float(v.longitude),
        "accuracyM": v.accuracy_m,
        "isMocked": v.is_mocked,
        "hasPhoto": bool(v.photo),
        "hasPhoto2": bool(v.photo2),
        "status": v.status,
        "hrReviewComment": v.hr_review_comment or None,
        "hrReviewedAt": iso(v.hr_reviewed_at),
        "createdAt": iso(v.created_at),
    }


def device_dict(dev: TrackingDevice | None) -> dict | None:
    if dev is None:
        return None
    return {
        "deviceId": dev.device_id,
        "platform": dev.platform,
        "osVersion": dev.os_version,
        "model": dev.model,
        "appVersion": dev.app_version,
        "permissionLevel": dev.permission_level,
        "locationEnabled": dev.location_enabled,
        "backgroundRestricted": dev.background_restricted,
        "batteryOptimised": dev.battery_optimised,
        "powerSave": dev.power_save,
        "lastSeenAt": iso(dev.last_seen_at),
        "lastBatteryPct": dev.last_battery_pct,
        "lastNetwork": dev.last_network or None,
        "lastHeartbeatAt": iso(dev.last_heartbeat_at),
    }


_SEGMENT_TITLES = {"travel": "Travelling", "stop": "Stopped", "gap": "No data"}
_EVENT_TITLES = {
    "TRACKING_STARTED": "Tracking started",
    "TRACKING_STOPPED": "Tracking stopped",
    "GPS_OFF": "Location turned off",
    "NETWORK_LOST": "Network lost",
    "AIRPLANE_ON": "Airplane mode on",
    "POWER_SAVE_ON": "Battery saver on",
    "PERMISSION_CHANGED": "Location permission changed",
    "LOW_BATTERY": "Low battery",
    "MOCK_LOCATION": "Fake location detected",
    "CLOCK_CHANGED": "Phone clock changed",
    "APP_RESTARTED": "App restarted",
    "APP_KILLED": "App was closed",
    "DEVICE_SHUTDOWN": "Phone switched off",
    "DEVICE_BOOT": "Phone started",
    "BACKGROUND_RESTRICTED": "Background activity restricted",
    "SIGNAL_LOST": "No signal from the phone",
    "SERVER_NOTE": "Note",
}


def timeline(segments: list[dict], events: list[dict]) -> list[dict]:
    """Segments and events merged in time order, for the HR timeline. A segment sorts before an event that starts at the
    same instant; TRACKING_STARTED always opens the list and TRACKING_STOPPED closes it."""
    items: list[dict] = []
    for s in segments:
        title = _SEGMENT_TITLES.get(s["kind"], s["kind"])
        items.append(
            {
                "type": "segment",
                "id": s["id"],
                "kind": s["kind"],
                "title": title,
                "startedAt": s["startedAt"],
                "endedAt": s["endedAt"],
                "durationS": s["durationS"],
                "latitude": s["centerLat"] if s["kind"] == "stop" else s["startLat"],
                "longitude": s["centerLng"] if s["kind"] == "stop" else s["startLng"],
                "address": s["address"] or None,
                "cause": s["cause"] or None,
                "distanceM": s["distanceM"],
                "estimated": s["estimated"],
                "seqNo": s["seqNo"],
            }
        )
    for e in events:
        items.append(
            {
                "type": "event",
                "id": e["id"],
                "kind": e["kind"],
                "title": _EVENT_TITLES.get(e["kind"], e["kind"]),
                "startedAt": e["startedAt"],
                "endedAt": e["endedAt"],
                "durationS": e["durationS"],
                "latitude": e["latitude"],
                "longitude": e["longitude"],
                "address": None,
                "cause": None,
                "distanceM": None,
                "estimated": False,
                "seqNo": None,
            }
        )

    def key(item: dict):
        rank = (
            0
            if item["kind"] == "TRACKING_STARTED"
            else 3
            if item["kind"] == "TRACKING_STOPPED"
            else 1
            if item["type"] == "segment"
            else 2
        )
        return (item["startedAt"] or "", rank, item["id"])

    items.sort(key=key)
    return items


def live_row(track: DutyTrack, now: datetime, signal_lost_seconds: int) -> dict:
    emp = track.employee
    return {
        "trackId": track.pk,
        "sessionId": track.session_id,
        "employeeId": track.employee_id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "branchName": track.branch.name if track.branch_id and track.branch else None,
        "destination": track.session.destination,
        "state": live.effective_state(track, now, signal_lost_seconds),
        "stateSince": iso(track.state_since),
        "latitude": _f(track.last_latitude),
        "longitude": _f(track.last_longitude),
        "accuracyM": track.last_accuracy_m,
        "lastPointAt": iso(track.last_point_at),
        "batteryPct": track.last_battery_pct,
        "network": track.last_network or None,
        "isMocked": track.mock_points > 0,
        "startedAt": iso(track.started_at),
        "approvalStatus": track.session.status,
        "stopCount": track.stop_count,
        "distanceM": round(track.distance_m or 0.0, 1),
    }


def now_utc() -> datetime:
    return timezone.now()
