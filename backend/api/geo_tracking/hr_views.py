"""The HR-facing tracking endpoints (every one answers an employee token 403).

  GET  /api/tracking/journeys                        the journey list: filters employeeId, from, to, status, page, pageSize
  GET  /api/tracking/journeys/day-map                ?date=YYYY-MM-DD: every journey of one day with its route, in ONE answer (On-Duty Map)
  GET  /api/tracking/journeys/<id>/points           the raw fixes, cursor paged: ?after=<pointId>&limit=
  GET  /api/tracking/journeys/<id>/trail             every stored fix, compact, in time order (the whole route for the map)
  GET  /api/tracking/journeys/<id>/export            ?format=xlsx (default) | csv: summary, segments, events
  POST /api/tracking/journeys/<id>/rebuild           recompute the segments and summary from the raw rows
  GET  /api/tracking/live                            the recording tracks with their latest position and state
  GET|PUT /api/tracking/settings                     the geo-tracking rules (permission settings.attendance)

Permission and scope: HrPermissionMiddleware maps tracking/journeys and tracking/live to the geo_attendance module and
tracking/settings to settings.attendance (permission_registry.URL_MODULE_MAP); every list/detail is also branch scoped
(scope_to_branch) so another branch's journey answers 404. Viewing, exporting and rebuilding a journey is audit-logged.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, time, timedelta

from django.db.models import Q
from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import require_hr
from ..branch_scope import get_branch_scope, scope_to_branch
from ..clock import FACTORY_TZ, ist_today
from ..models import DutyTrack, DutyTrackEvent, DutyTrackPoint, DutyTrackSegment, HRUser
from ..view_common import error_response as _error
from . import journey, serializers
from . import settings as geo_settings
from .parsing import parse_int
from .views import journey_payload, list_response, path_from_segments

POINTS_DEFAULT_LIMIT = 1000
POINTS_MAX_LIMIT = 5000


class _IgnoreFormatParam(BaseContentNegotiation):
    """`?format=` is the FILE type on the export (the contract's `?format=xlsx`), not a DRF renderer suffix: without this
    DRF would answer 404 because no renderer is called "xlsx"."""

    def select_parser(self, request, parsers):
        return parsers[0] if parsers else None

    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type


def _scoped_track(request: Request, pk: int) -> DutyTrack | None:
    qs = DutyTrack.objects.select_related("employee__department", "branch", "session")
    return scope_to_branch(qs, request).filter(pk=pk).first()


def _who(track: DutyTrack) -> str:
    e = track.employee
    return f"{e.first_name} {e.last_name} ({e.employee_code})"


@api_view(["GET"])
@require_hr
def journeys_list(request: Request) -> Response:
    """GET /api/tracking/journeys?employeeId=&from=&to=&status=&page=&pageSize="""
    qs = scope_to_branch(DutyTrack.objects.all(), request)
    employee_id = parse_int(request.query_params.get("employeeId") or request.query_params.get("employee_id"))
    if request.query_params.get("employeeId") and employee_id is None:
        return _error("employeeId must be a number")
    if employee_id is not None:
        qs = qs.filter(employee_id=employee_id)
    return list_response(request, qs, serializers.now_utc(), geo_settings.get())


#: one map of one day never needs more journeys than this (every employee on duty at once, with room to spare)
DAY_MAP_MAX_JOURNEYS = 300


@api_view(["GET"])
@require_hr
def journeys_day_map(request: Request) -> Response:
    """GET /api/tracking/journeys/day-map?date=YYYY-MM-DD (default: today, India time): every journey that was recording
    on that India calendar day, each with its list-row fields plus its ``segments`` (the travel polylines, the stops and
    the gaps, in order), so the On-Duty Map can draw every employee's route in ONE request instead of one detail request
    per journey (which would also write one audit row per journey on every refresh).

    A journey is on the day when it started before the day ended and ended (or, while it is still recording, last sent a
    position) on or after the day began, so a track that started at 23:55 and is still recording at 09:00 is on both days.
    Ordered by employee name, then start. Branch scoped like the journey list. Read-only and not audit-logged (the page
    reads it every 20 s, like /tracking/live)."""
    raw = (request.query_params.get("date") or "").strip()
    if raw:
        try:
            day = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            return _error("date must be a day: YYYY-MM-DD")
    else:
        day = ist_today()
    day_start = datetime.combine(day, time.min, tzinfo=FACTORY_TZ)
    day_end = day_start + timedelta(days=1)

    s = geo_settings.get()
    now = serializers.now_utc()
    tracks = list(
        scope_to_branch(DutyTrack.objects.select_related("employee__department", "branch", "session"), request)
        .filter(started_at__lt=day_end)
        .filter(
            Q(ended_at__gte=day_start)
            | Q(ended_at__isnull=True, last_point_at__gte=day_start)
            | Q(ended_at__isnull=True, last_point_at__isnull=True, started_at__gte=day_start)
        )
        .order_by("employee__first_name", "employee__last_name", "started_at", "id")[:DAY_MAP_MAX_JOURNEYS]
    )
    by_track: dict[int, list[dict]] = {t.pk: [] for t in tracks}
    for seg in DutyTrackSegment.objects.filter(track_id__in=by_track).order_by("track_id", "seq_no"):
        by_track[seg.track_id].append(serializers.segment_dict(seg))
    return Response(
        {
            "date": str(day),
            "journeys": [
                {**serializers.track_head(t, now, s.signal_lost_seconds), "segments": by_track[t.pk]} for t in tracks
            ],
        }
    )


@api_view(["GET"])
@require_hr
def journey_points(request: Request, pk: int) -> Response:
    """GET /api/tracking/journeys/<id>/points?after=<pointId>&limit= : raw fixes in time order. ``nextAfter`` is the cursor
    for the next page (null at the end)."""
    track = _scoped_track(request, pk)
    if track is None:
        return _error("Journey not found", 404)
    after = parse_int(request.query_params.get("after"), lo=0) or 0
    limit = min(parse_int(request.query_params.get("limit"), lo=1) or POINTS_DEFAULT_LIMIT, POINTS_MAX_LIMIT)
    # id order is insertion order; recorded_at order is what a reader wants, so page by id and let the client sort
    rows = list(DutyTrackPoint.objects.filter(track=track, id__gt=after).order_by("id")[: limit + 1])
    more = len(rows) > limit
    rows = rows[:limit]
    log_action(
        request,
        "view",
        "geo_tracking",
        record_id=track.pk,
        description=f"Viewed raw points of the journey of {_who(track)}",
    )
    return Response(
        {
            "results": [
                {
                    "id": p.pk,
                    "seq": p.seq,
                    "recordedAt": p.recorded_at.isoformat(),
                    "receivedAt": p.received_at.isoformat(),
                    "latitude": float(p.latitude),
                    "longitude": float(p.longitude),
                    "accuracyM": p.accuracy_m,
                    "speedMps": p.speed_mps,
                    "bearingDeg": p.bearing_deg,
                    "altitudeM": p.altitude_m,
                    "activity": p.activity,
                    "batteryPct": p.battery_pct,
                    "charging": p.charging,
                    "network": p.network,
                    "provider": p.provider,
                    "isMock": p.is_mock,
                    "timeSuspect": p.time_suspect,
                }
                for p in rows
            ],
            "nextAfter": rows[-1].pk if more and rows else None,
            "limit": limit,
        }
    )


# ── the route trail: every stored fix, compact, for the map ──────────────────────────────────────────────────────────────

#: the trail never has more points than this (a day of 3-second fixes is about 8000 at the very most)
MAX_TRAIL_POINTS = 8000

_TRAIL_ROW_FIELDS = (
    "recorded_at",
    "latitude",
    "longitude",
    "accuracy_m",
    "speed_mps",
    "activity",
    "battery_pct",
    "network",
    "provider",
    "is_mock",
    "time_suspect",
    "seq",
)


def thin_indices(n: int, keep: set[int], limit: int) -> list[int]:
    """At most ``limit`` of the indices 0..n-1, ascending: every index in ``keep`` plus evenly spaced ones that fill the
    rest of the budget. When ``keep`` alone is over the limit it is thinned evenly (its first and last stay)."""
    wanted = sorted(keep)
    if len(wanted) >= limit:
        step = (len(wanted) - 1) / (limit - 1)
        return sorted({wanted[int(round(k * step))] for k in range(limit)})
    chosen = set(wanted)
    budget = limit - len(wanted)
    step = n / budget
    chosen.update(min(n - 1, int(k * step)) for k in range(budget))
    return sorted(chosen)


def _stop_ranges(segments: list[DutyTrackSegment]) -> list[tuple[int, int, int]]:
    """(start, end, seqNo) in whole epoch seconds of every stop segment, in time order."""
    return [
        (journey.to_epoch(s.started_at), journey.to_epoch(s.ended_at), s.seq_no)
        for s in segments
        if s.kind == DutyTrackSegment.KIND_STOP
    ]


def _stop_of(stops: list[tuple[int, int, int]], cursor: int, t: int) -> tuple[int | None, int]:
    """(the seqNo of the stop whose closed [start, end] holds second ``t``, else None; the cursor to pass on). ``t`` must
    not decrease from one call to the next: the cursor only moves forward, so a whole trail costs one pass."""
    while cursor < len(stops) and stops[cursor][1] < t:
        cursor += 1
    if cursor < len(stops) and stops[cursor][0] <= t:
        return stops[cursor][2], cursor
    return None, cursor


def trail_payload(track: DutyTrack, s) -> dict:
    """The body of GET /tracking/journeys/<id>/trail (see journey_trail)."""
    segments = list(DutyTrackSegment.objects.filter(track=track).order_by("seq_no"))
    stops = _stop_ranges(segments)
    rows = list(DutyTrackPoint.objects.filter(track=track).order_by("recorded_at", "seq").values(*_TRAIL_ROW_FIELDS))
    points: list[dict] = []
    keep: set[int] = set()
    purged = bool((track.flags or {}).get("purgedAt"))
    if rows or not (purged or segments):
        source = "points"
        fixes = [journey.fix_from_row(r) for r in rows]
        used = {id(f) for f in journey.clean(fixes, journey.Params.from_settings(s)).fixes}
        boundaries = {t for seg in segments for t in (journey.to_epoch(seg.started_at), journey.to_epoch(seg.ended_at))}
        cursor = 0
        for i, (r, f) in enumerate(zip(rows, fixes)):
            stop, cursor = _stop_of(stops, cursor, f.t)
            speed = r["speed_mps"]
            points.append(
                {
                    "t": int(round(r["recorded_at"].timestamp() * 1000)),
                    "lat": round(float(r["latitude"]), 6),
                    "lng": round(float(r["longitude"]), 6),
                    "acc": round(r["accuracy_m"], 1) if r["accuracy_m"] is not None else None,
                    "spd": round(speed * 3.6, 1) if speed is not None else None,
                    "act": r["activity"],
                    "bat": r["battery_pct"],
                    "net": r["network"],
                    "prov": r["provider"],
                    "mock": bool(r["is_mock"]),
                    "used": id(f) in used,
                    "stop": stop,
                }
            )
            if id(f) not in used or f.t in boundaries:
                keep.add(i)
    else:
        # the raw rows are gone (the retention rule): the segments are all that is left of the route
        source = "segments"
        cursor = 0
        for lat, lng, ms in path_from_segments(segments):
            stop, cursor = _stop_of(stops, cursor, ms // 1000)
            points.append(
                {
                    "t": ms,
                    "lat": round(float(lat), 6),
                    "lng": round(float(lng), 6),
                    "acc": None,
                    "spd": None,
                    "act": None,
                    "bat": None,
                    "net": None,
                    "prov": None,
                    "mock": None,
                    "used": True,
                    "stop": stop,
                }
            )
    total = len(points)
    truncated = total > MAX_TRAIL_POINTS
    if truncated:
        keep.update((0, total - 1))
        points = [points[i] for i in thin_indices(total, keep, MAX_TRAIL_POINTS)]
    return {
        "trackId": track.pk,
        "source": source,
        "total": total,
        "count": len(points),
        "truncated": truncated,
        "points": points,
    }


@api_view(["GET"])
@require_hr
def journey_trail(request: Request, pk: int) -> Response:
    """GET /api/tracking/journeys/<id>/trail : every stored fix of the track as a compact list, for the map to draw the
    COMPLETE route (the segments' polylines are simplified and a stop is one pin).

    ``{trackId, source: "points"|"segments", total, count, truncated, points: [{t, lat, lng, acc, spd, act, bat, net, prov,
    mock, used, stop}]}`` in time order (recorded_at, seq): ``t`` epoch milliseconds, ``spd`` km/h, ``used`` false for a fix
    the cleaning step dropped (accuracy over the maximum, teleport, duplicate), ``stop`` the seqNo of the stop segment
    whose [startedAt, endedAt] holds the fix (else null). Over MAX_TRAIL_POINTS (8000) the list is thinned evenly, always
    keeping the first and last fix, every fix that starts or ends a segment and every fix with used=false (while they
    fit): ``truncated`` is true and ``count`` < ``total``. Once the retention rule has deleted the raw rows the answer is
    built from the segments (source "segments": lat/lng/t only, the other fields null)."""
    track = _scoped_track(request, pk)
    if track is None:
        return _error("Journey not found", 404)
    body = trail_payload(track, geo_settings.get())
    log_action(
        request,
        "view",
        "geo_tracking",
        record_id=track.pk,
        description=f"Viewed the route trail of the journey of {_who(track)}",
    )
    return Response(body)


@api_view(["POST"])
@require_hr
def journey_rebuild(request: Request, pk: int) -> Response:
    """POST /api/tracking/journeys/<id>/rebuild : recompute from the raw rows; answers the journey detail."""
    track = _scoped_track(request, pk)
    if track is None:
        return _error("Journey not found", 404)
    if (track.flags or {}).get("purgedAt"):
        return _error(
            "The raw location data of this journey was deleted by the retention rule, so it cannot be rebuilt.", 409
        )
    journey.rebuild(track.pk)
    track.refresh_from_db()
    log_action(
        request, "update", "geo_tracking", record_id=track.pk, description=f"Rebuilt the journey of {_who(track)}"
    )
    return Response(journey_payload(track, serializers.now_utc(), geo_settings.get()))


@api_view(["GET"])
@require_hr
def live_tracks(request: Request) -> Response:
    """GET /api/tracking/live : every recording track in the caller's scope, with its latest position and state."""
    s = geo_settings.get()
    now = serializers.now_utc()
    qs = (
        scope_to_branch(DutyTrack.objects.filter(status=DutyTrack.STATUS_ACTIVE), request)
        .select_related("employee__department", "branch", "session")
        .order_by("employee__first_name", "employee__last_name", "id")
    )
    return Response([serializers.live_row(t, now, s.signal_lost_seconds) for t in qs])


# ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────


@api_view(["GET", "PUT"])
@require_hr
def tracking_settings(request: Request) -> Response:
    """GET /api/tracking/settings, PUT /api/tracking/settings (a partial update). These are company-wide rules, so a login
    that belongs to one branch may read them but not change them."""
    s = geo_settings.get()
    if request.method == "GET":
        return Response(geo_settings.to_dict(s))
    if get_branch_scope(request) is not None:
        return _error(
            "Geo-tracking rules apply to the whole company, so a branch login can read them but not change them.", 403
        )
    user = HRUser.objects.filter(pk=request.jwt_user.get("hrUserId")).first()
    try:
        old, new = geo_settings.apply_update(s, request.data, user)
    except geo_settings.SettingsError as exc:
        return _error(str(exc), 400)
    if new:
        log_action(
            request,
            "update",
            "geo_tracking",
            description="Geo-tracking rules changed: " + ", ".join(sorted(new)),
            old_values=old,
            new_values=new,
        )
    return Response(geo_settings.to_dict(geo_settings.get()))


# ── export ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def _ist(dt: datetime | None) -> str:
    return dt.astimezone(FACTORY_TZ).strftime("%d-%b-%Y %H:%M:%S") if dt else ""


def _hms(seconds: int | None) -> str:
    if seconds is None:
        return ""
    h, rem = divmod(int(seconds), 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _safe(value):
    """A cell value that a spreadsheet will not run as a formula (the destination and addresses are typed by people)."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _tables(track: DutyTrack, segments, events) -> list[tuple[str, list[str], list[list]]]:
    e = track.employee
    summary_rows = [
        ["Employee", f"{e.first_name} {e.last_name}"],
        ["Employee code", e.employee_code],
        ["Department", e.department.name if e.department_id and e.department else ""],
        ["Branch", track.branch.name if track.branch_id and track.branch else ""],
        ["Destination", track.session.destination],
        ["Approval status", track.session.status],
        ["Tracking started (IST)", _ist(track.started_at)],
        ["Tracking ended (IST)", _ist(track.ended_at)],
        ["End reason", track.end_reason or ("recording" if track.status == DutyTrack.STATUS_ACTIVE else "")],
        ["Distance travelled (km)", round((track.distance_m or 0) / 1000, 3)],
        ["Travel time", _hms(track.travel_s)],
        ["Stationary time", _hms(track.stop_s)],
        ["No-data time", _hms(track.gap_s)],
        ["Stops", track.stop_count],
        ["Longest stop", _hms(track.longest_stop_s)],
        ["Top speed (km/h)", round(track.max_speed_kmh or 0, 1)],
        ["Location points", track.points_count],
        ["Events", track.events_count],
        ["Fake-location points", track.mock_points],
        ["Summary rebuilt (IST)", _ist(track.rebuilt_at)],
    ]
    segment_rows = [
        [
            s.seq_no,
            {"travel": "Travel", "stop": "Stop", "gap": "No data"}.get(s.kind, s.kind),
            _ist(s.started_at),
            _ist(s.ended_at),
            _hms(s.duration_s),
            round((s.distance_m or 0) / 1000, 3) if s.kind == "travel" else "",
            float(s.center_lat) if s.kind == "stop" and s.center_lat is not None else "",
            float(s.center_lng) if s.kind == "stop" and s.center_lng is not None else "",
            s.address or "",
            s.cause or "",
            "yes" if s.estimated else "",
        ]
        for s in segments
    ]
    event_rows = [
        [
            ev.pk,
            ev.kind,
            ev.source,
            _ist(ev.started_at),
            _ist(ev.ended_at),
            _hms(int((ev.ended_at - ev.started_at).total_seconds())) if ev.ended_at else "",
            float(ev.latitude) if ev.latitude is not None else "",
            float(ev.longitude) if ev.longitude is not None else "",
        ]
        for ev in events
    ]
    return [
        ("Summary", ["Field", "Value"], summary_rows),
        (
            "Segments",
            [
                "#",
                "Kind",
                "Start (IST)",
                "End (IST)",
                "Duration",
                "Distance (km)",
                "Latitude",
                "Longitude",
                "Address",
                "Cause",
                "Estimated",
            ],
            segment_rows,
        ),
        (
            "Events",
            ["Id", "Kind", "Source", "Start (IST)", "End (IST)", "Duration", "Latitude", "Longitude"],
            event_rows,
        ),
    ]


@api_view(["GET"])
@require_hr
def journey_export(request: Request, pk: int) -> HttpResponse:
    """GET /api/tracking/journeys/<id>/export?format=xlsx|csv : the summary, the segments (travel / stops / gaps) and the
    events of one journey, times in Indian time."""
    track = _scoped_track(request, pk)
    if track is None:
        return _error("Journey not found", 404)
    fmt = (request.query_params.get("format") or "xlsx").lower()
    if fmt not in ("xlsx", "csv"):
        return _error("format must be xlsx or csv")
    segments = list(DutyTrackSegment.objects.filter(track=track).order_by("seq_no"))
    events = list(DutyTrackEvent.objects.filter(track=track).order_by("started_at", "id"))
    tables = _tables(track, segments, events)
    stamp = track.started_at.astimezone(FACTORY_TZ).strftime("%Y%m%d")
    filename = f"journey-{track.pk}-{track.employee.employee_code}-{stamp}.{fmt}"
    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Font
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        wb.remove(wb.active)
        for title, header, rows in tables:
            ws = wb.create_sheet(title)
            ws.append(header)
            for cell in ws[1]:
                cell.font = Font(bold=True)
            for row in rows:
                ws.append([_safe(v) for v in row])
            for i in range(1, len(header) + 1):
                width = (
                    max(len(str(header[i - 1])), *(len(str(r[i - 1])) for r in rows))
                    if rows
                    else len(str(header[i - 1]))
                )
                ws.column_dimensions[get_column_letter(i)].width = min(60, width + 2)
        buffer = io.BytesIO()
        wb.save(buffer)
        response = HttpResponse(
            buffer.getvalue(), content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    else:
        out = io.StringIO()
        writer = csv.writer(out)
        for title, header, rows in tables:
            writer.writerow([title])
            writer.writerow(header)
            for row in rows:
                writer.writerow([_safe(v) for v in row])
            writer.writerow([])
        response = HttpResponse(out.getvalue(), content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    log_action(
        request,
        "export",
        "geo_tracking",
        record_id=track.pk,
        description=f"Exported the journey of {_who(track)} as {fmt}",
    )
    return response


journey_export.cls.content_negotiation_class = _IgnoreFormatParam
