"""The employee-facing tracking endpoints, plus the journey detail both roles read.

  GET  /api/tracking/state                 employee: is there a recording track, must the notice be accepted, the cadence
  POST /api/tracking/consent               employee: the employee accepted the notice
  POST /api/tracking/batch                 employee: upload points + events (see ingest.py)
  GET  /api/tracking/my-journeys           employee: own tracks (the HR list shape)
  GET  /api/tracking/journeys/<id>         employee: own track | HR: any track of their branch scope (audit-logged)

Employee routes answer an HR token 403 (and the HR-only routes in hr_views.py answer an employee token 403).
"""

from __future__ import annotations

import logging
from datetime import datetime, time, timedelta

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import get_token_employee_id, is_hr, require_auth
from ..branch_scope import scope_to_branch
from ..clock import FACTORY_TZ
from ..models import (
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    DutyTrackSegment,
    Employee,
    GeoTrackingSettings,
    OnDutyPunchVerification,
    TrackingDevice,
)
from ..view_common import error_response as _error
from . import ingest, journey, serializers, sessions
from . import settings as geo_settings
from .parsing import normalize, parse_int, parse_time, pick

logger = logging.getLogger(__name__)

MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 25
DETAIL_EVENT_CAP = 2000


def _employee(request: Request) -> Employee | None:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None
    return Employee.objects.select_related("branch").filter(pk=emp_id).first()


def _client_ip(request: Request) -> str:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return (forwarded.split(",")[-1].strip() if forwarded else request.META.get("REMOTE_ADDR", "")) or ""


def next_day_end(now: datetime, day_end: time) -> datetime:
    """The next moment the automatic close happens (today's day-end time while it is still ahead, else tomorrow's), in IST."""
    local = now.astimezone(FACTORY_TZ)
    candidate = datetime.combine(local.date(), day_end, tzinfo=FACTORY_TZ)
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate


# ── date filters / paging shared with hr_views ───────────────────────────────────────────────────────────────────────


def parse_range(value: str | None, *, end: bool) -> datetime | None:
    """A `from` / `to` query value: a date (an IST calendar day: its start for `from`, the start of the NEXT day for `to`,
    so the day itself is included) or a full ISO time / epoch."""
    if not value:
        return None
    text = value.strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        try:
            day = datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            return None
        start = day.replace(tzinfo=FACTORY_TZ)
        return start + timedelta(days=1) if end else start
    return parse_time(text)


def paging(request: Request) -> tuple[int, int]:
    page = parse_int(request.query_params.get("page"), lo=1) or 1
    size = (
        parse_int(request.query_params.get("pageSize") or request.query_params.get("page_size"), lo=1)
        or DEFAULT_PAGE_SIZE
    )
    return page, min(size, MAX_PAGE_SIZE)


def list_response(request: Request, qs, now: datetime, s: GeoTrackingSettings) -> Response:
    """Filter by from/to/status/state, paginate and serialise a DutyTrack queryset (employee and HR share it)."""
    q = request.query_params
    start = parse_range(q.get("from"), end=False)
    stop = parse_range(q.get("to"), end=True)
    if (q.get("from") and start is None) or (q.get("to") and stop is None):
        return _error("from and to must be dates (YYYY-MM-DD) or ISO times")
    if start:
        qs = qs.filter(started_at__gte=start)
    if stop:
        qs = qs.filter(started_at__lt=stop)
    status = q.get("status")
    if status in (DutyTrack.STATUS_ACTIVE, DutyTrack.STATUS_ENDED):
        qs = qs.filter(status=status)
    end_reason = q.get("endReason") or q.get("end_reason")
    if end_reason in dict(DutyTrack.END_REASON_CHOICES):
        qs = qs.filter(end_reason=end_reason)
    page, size = paging(request)
    total = qs.count()
    rows = list(
        qs.select_related("employee__department", "branch", "session").order_by("-started_at", "-id")[
            (page - 1) * size : page * size
        ]
    )
    punches = serializers.punch_counts([t.session_id for t in rows])
    return Response(
        {
            "results": [
                serializers.track_item(t, now, s.signal_lost_seconds, punches.get(t.session_id, 0)) for t in rows
            ],
            "page": page,
            "pageSize": size,
            "total": total,
        }
    )


# ── employee ─────────────────────────────────────────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_auth
def tracking_state(request: Request) -> Response:
    """GET /api/tracking/state. The app asks this when it opens, after boot and every few minutes: is there a track it must
    be recording, has the employee accepted the notice, and how to sample and upload."""
    emp = _employee(request)
    if not emp:
        return _error("Employee authentication required", 403)
    s = geo_settings.get()
    now = serializers.now_utc()
    track = None
    if s.enabled:
        track = DutyTrack.objects.filter(employee=emp, status=DutyTrack.STATUS_ACTIVE).select_related("session").first()
        if track is None:
            track = _start_for_running_session(emp, now)
    body = {
        "enabled": s.enabled,
        "active": track is not None,
        "consentRequired": ingest.consent_required(emp.pk, s),
        "noticeVersion": s.notice_version,
        "noticeText": s.notice_text,
        "serverTime": now.isoformat(),
        "track": None,
        "config": geo_settings.client_config(s),
        "punchPhotos": s.onduty_punch_photos,
    }
    if track is not None:
        from . import live

        body["track"] = {
            "id": track.pk,
            "sessionId": track.session_id,
            "startedAt": track.started_at.isoformat(),
            "endsAt": next_day_end(now, s.day_end_time).isoformat(),
            "state": live.effective_state(track, now, s.signal_lost_seconds),
        }
    return Response(body)


def _start_for_running_session(emp: Employee, now: datetime) -> DutyTrack | None:
    """An employee working under an On-Duty request that has no track (the request was made before tracking existed or while
    it was switched off) starts one the first time the app asks. Tracking then runs under the same rules as any other."""
    from ..geo_attendance_views import _punchable_on_duty_session

    session = _punchable_on_duty_session(emp)
    if session is None or DutyTrack.objects.filter(session=session).exists():
        return None
    track = sessions.start_track(session, now=now)
    if track is not None:
        track = DutyTrack.objects.select_related("session").get(pk=track.pk)
    return track


@api_view(["POST"])
@require_auth
def tracking_consent(request: Request) -> Response:
    """POST /api/tracking/consent {deviceId, noticeVersion}: the employee saw and accepted the notice."""
    emp = _employee(request)
    if not emp:
        return _error("Employee authentication required", 403)
    data = normalize(request.data)
    s = geo_settings.get()
    version = parse_int(pick(data, "notice_version"), lo=1)
    if version is None:
        return _error("noticeVersion is required")
    if version != s.notice_version:
        return Response(
            {
                "error": "The notice has changed: read the current version and accept it.",
                "code": "NOTICE_VERSION_MISMATCH",
                "noticeVersion": s.notice_version,
            },
            status=400,
        )
    device_id = str(pick(data, "device_id", default="")).strip()[:64]
    from ..models import TrackingConsent

    if not TrackingConsent.objects.filter(employee=emp, device_id=device_id, notice_version=version).exists():
        ingest.record_consent(emp.pk, device_id, version, _client_ip(request))
    return Response({"ok": True})


@api_view(["POST"])
@require_auth
def tracking_batch(request: Request) -> Response:
    """POST /api/tracking/batch (see ingest.py for the contract)."""
    emp = _employee(request)
    if not emp:
        return _error("Employee authentication required", 403)
    length = parse_int(request.META.get("CONTENT_LENGTH"), lo=0)
    if length is not None and length > ingest.MAX_BODY_BYTES:
        return Response(
            {
                "error": "The batch is too large: send fewer rows per call.",
                "code": "BATCH_TOO_LARGE",
                "maxBytes": ingest.MAX_BODY_BYTES,
            },
            status=413,
        )
    try:
        body = request.data
    except Exception:
        return _error("The body is not valid JSON")
    if not isinstance(body, dict):
        return _error("Send a JSON object")
    try:
        answer = ingest.ingest_batch(emp, body, ip=_client_ip(request))
    except ingest.BatchError as exc:
        return Response(exc.body, status=exc.status)
    return Response(answer)


@api_view(["GET"])
@require_auth
def my_journeys(request: Request) -> Response:
    """GET /api/tracking/my-journeys?from=&to=&status=&page=&pageSize= : the employee's own tracks."""
    emp = _employee(request)
    if not emp:
        return _error("Employee authentication required", 403)
    s = geo_settings.get()
    return list_response(request, DutyTrack.objects.filter(employee=emp), serializers.now_utc(), s)


# ── the journey detail (both roles) ──────────────────────────────────────────────────────────────────────────────────


def _path_for(track: DutyTrack, segments: list[DutyTrackSegment], s: GeoTrackingSettings) -> tuple[list, str]:
    """The simplified whole-journey path [[lat, lng, epoch_ms], ...] (at most 1500 vertices). From the raw points while they
    exist; once retention has purged them, from the segments' own polylines."""
    rows = list(
        DutyTrackPoint.objects.filter(track=track)
        .order_by("recorded_at", "seq")
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
        )
    )
    if rows:
        cleaned = journey.clean([journey.fix_from_row(r) for r in rows], journey.Params.from_settings(s))
        return journey._path(cleaned.fixes), "points"
    return path_from_segments(segments)[: journey.MAX_PATH_POINTS], "segments"


def path_from_segments(segments: list[DutyTrackSegment]) -> list[list]:
    """[[lat, lng, epoch_ms], ...] rebuilt from the stored segments alone: every vertex of every travel polyline (its time
    spread evenly over the segment) and the centre of every stop (at the stop's start). What is left of a track once the
    retention rule has deleted its raw points. Not capped: callers cap it."""
    path: list[list] = []
    for seg in segments:
        if seg.kind == "travel" and seg.polyline:
            n = len(seg.polyline)
            span = (seg.ended_at - seg.started_at).total_seconds()
            for i, (lat, lng) in enumerate(seg.polyline):
                t = seg.started_at.timestamp() + (span * i / (n - 1) if n > 1 else 0)
                path.append([lat, lng, int(t * 1000)])
        elif seg.kind == "stop" and seg.center_lat is not None:
            path.append([float(seg.center_lat), float(seg.center_lng), int(seg.started_at.timestamp() * 1000)])
    return path


def journey_payload(track: DutyTrack, now: datetime, s: GeoTrackingSettings) -> dict:
    segments = list(DutyTrackSegment.objects.filter(track=track).order_by("seq_no"))
    events = list(DutyTrackEvent.objects.filter(track=track).order_by("started_at", "id")[:DETAIL_EVENT_CAP])
    path, source = _path_for(track, segments, s)
    device = (
        TrackingDevice.objects.filter(employee_id=track.employee_id, device_id=track.last_device_id).first()
        if track.last_device_id
        else None
    ) or TrackingDevice.objects.filter(employee_id=track.employee_id).order_by("-last_seen_at").first()
    seg_dicts = [serializers.segment_dict(x) for x in segments]
    event_dicts = [serializers.event_dict(x) for x in events]
    punches = OnDutyPunchVerification.objects.filter(session_id=track.session_id).order_by(
        "punch_number", "created_at", "id"
    )
    return {
        "track": serializers.track_head(track, now, s.signal_lost_seconds),
        "summary": serializers.summary_dict(track, now),
        "segments": seg_dicts,
        "events": event_dicts,
        "path": path,
        "pathSource": source,
        "device": serializers.device_dict(device),
        "timeline": serializers.timeline(seg_dicts, event_dicts),
        # The geo-punches recorded under the journey's session (a rejected punch that was redone appears twice).
        "punches": [serializers.punch_dict(v) for v in punches],
    }


@api_view(["GET"])
@require_auth
def journey_detail(request: Request, pk: int) -> Response:
    """GET /api/tracking/journeys/<id>. An employee reads their own tracks only; HR reads any track in their branch scope,
    and every HR view is audit-logged (module geo_tracking)."""
    qs = DutyTrack.objects.select_related("employee__department", "branch", "session")
    if is_hr(request):
        track = scope_to_branch(qs, request).filter(pk=pk).first()
    else:
        emp_id = get_token_employee_id(request)
        if not emp_id:
            return _error("Employee authentication required", 403)
        track = qs.filter(pk=pk, employee_id=emp_id).first()
    if track is None:
        return _error("Journey not found", 404)
    s = geo_settings.get()
    body = journey_payload(track, serializers.now_utc(), s)
    if is_hr(request):
        log_action(
            request,
            "view",
            "geo_tracking",
            record_id=track.pk,
            description=f"Viewed the journey of {track.employee.first_name} {track.employee.last_name} "
            f"({track.employee.employee_code}) started {track.started_at.astimezone(FACTORY_TZ):%d-%b-%Y %H:%M}",
        )
    return Response(body)
