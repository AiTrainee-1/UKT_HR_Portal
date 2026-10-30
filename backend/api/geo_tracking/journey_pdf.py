"""The On-Duty journey report: one employee, one On-Duty request, as a PDF.

    GET /api/tracking/journeys/<id>/export?format=pdf

What it holds, in this order (hr_views.journey_export asks for it):
    1. the journey map: a picture of the map with the whole route drawn on it, the start and end, and every stop numbered
    2. journey details: start / end time, distance, duration, travel / stationary / no-data time, speeds, tracking counts
    3. route breakdown: the start, every leg of travel, every stop and every gap, in order, then the end
    4. stop details: each stop with its own close-up map, time, duration and place
    5. attendance details: the employee, the On-Duty request and who approved it, the geo-punches and the day's attendance
    6. tracking notices (GPS off, network lost ...), when there were any
    7. location history: every recorded GPS fix with its time (capped, see HISTORY_CAP)

The pictures come from static_map.py. All times are Indian time. Everything is read; nothing is written.
"""

from __future__ import annotations

import io
from datetime import datetime
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as canvas_mod
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    Image as RLImage,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from ..clock import FACTORY_TZ
from ..document_pdf import FONT_BODY, FONT_BODY_BOLD
from ..models import (
    AttendanceDayRecord,
    DutyTrack,
    DutyTrackEvent,
    DutyTrackSegment,
    OnDutyPunchVerification,
    OutpassRequest,
    PayrollSettings,
)
from . import static_map as smap

PAGE_W, PAGE_H = A4
MARGIN = 1.5 * cm
CONTENT_W = PAGE_W - 2 * MARGIN

INK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#64748B")
LINE = colors.HexColor("#E2E8F0")
BAND = colors.HexColor("#1E3A8A")
SOFT = colors.HexColor("#F1F5F9")
ACCENT = colors.HexColor("#2563EB")

# the most location fixes listed in the report (the Excel export has every one); more are thinned evenly
HISTORY_CAP = 3000
# stops that get a close-up map of their own (the rest are listed with their place and coordinates)
STOP_MAP_CAP = 10
LONG_STOP_S = 15 * 60

KIND_LABEL = {"travel": "Travel", "stop": "Stop", "gap": "No data"}
STATUS_LABEL = {
    "pending_hod": "Waiting for the Department Head",
    "pending_hr": "Waiting for HR",
    "active": "Approved (on duty)",
    "completed": "Approved (completed)",
    "rejected": "Rejected",
}


def _s(name: str, **kw) -> ParagraphStyle:
    base = dict(fontName=FONT_BODY, fontSize=8.5, leading=11, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    "body": _s("body"),
    "small": _s("small", fontSize=7.5, leading=9.5, textColor=MUTED),
    "cell": _s("cell", fontSize=8, leading=10),
    "cellb": _s("cellb", fontSize=8, leading=10, fontName=FONT_BODY_BOLD),
    "head": _s("head", fontName=FONT_BODY_BOLD, fontSize=8, leading=10, textColor=colors.white),
    "h1": _s("h1", fontName=FONT_BODY_BOLD, fontSize=13, leading=16, textColor=BAND, spaceBefore=10, spaceAfter=5),
    "h2": _s("h2", fontName=FONT_BODY_BOLD, fontSize=10, leading=13, textColor=INK, spaceBefore=4, spaceAfter=2),
    "kpi_v": _s("kpi_v", fontName=FONT_BODY_BOLD, fontSize=13, leading=16, alignment=TA_CENTER, textColor=BAND),
    "kpi_l": _s("kpi_l", fontSize=7.5, leading=9, alignment=TA_CENTER, textColor=MUTED),
    "mono": _s("mono", fontSize=6.8, leading=8.2),
    "monoh": _s("monoh", fontName=FONT_BODY_BOLD, fontSize=6.8, leading=8.2, textColor=colors.white),
}


def P(text, style="cell") -> Paragraph:
    return Paragraph(escape("" if text is None else str(text)), ST[style])


def _ist(dt: datetime | None, with_date: bool = True) -> str:
    if not dt:
        return "-"
    return dt.astimezone(FACTORY_TZ).strftime("%d-%b-%Y %H:%M:%S" if with_date else "%H:%M:%S")


def _hm(seconds: int | None) -> str:
    if seconds is None:
        return "-"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h} h {m:02d} min"
    if m:
        return f"{m} min {sec:02d} s"
    return f"{sec} s"


def _km(meters: float | None) -> str:
    return f"{(meters or 0) / 1000:.2f} km"


def _coord(lat, lng) -> str:
    if lat is None or lng is None:
        return "-"
    return f"{float(lat):.6f}, {float(lng):.6f}"


def _full_name(e) -> str:
    return f"{e.first_name or ''} {e.last_name or ''}".strip()


# ── page furniture ──────────────────────────────────────────────────────────────────────────────────────────────────


class _Numbered(canvas_mod.Canvas):
    """A canvas that knows the page count, for the "Page 2 of 7" in every footer."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self.setFont(FONT_BODY, 7.5)
            self.setFillColor(MUTED)
            self.drawRightString(PAGE_W - MARGIN, 0.8 * cm, f"Page {self._pageNumber} of {total}")
            super().showPage()
        super().save()


def _decorator(company: str, who: str, stamp: str):
    def draw(c: canvas_mod.Canvas, doc):
        c.saveState()
        c.setFont(FONT_BODY, 7.5)
        c.setFillColor(MUTED)
        c.drawString(MARGIN, 0.8 * cm, f"{company}  |  On-Duty journey report  |  {who}")
        c.setStrokeColor(LINE)
        c.line(MARGIN, 1.2 * cm, PAGE_W - MARGIN, 1.2 * cm)
        if doc.page > 1:
            c.setFillColor(BAND)
            c.rect(0, PAGE_H - 0.55 * cm, PAGE_W, 0.55 * cm, stroke=0, fill=1)
        c.restoreState()

    return draw


# ── small building blocks ───────────────────────────────────────────────────────────────────────────────────────────


def _section(title: str) -> list:
    rule = Table([[""]], colWidths=[CONTENT_W], rowHeights=[2])
    rule.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)]))
    return [CondPageBreak(6 * cm), Paragraph(escape(title), ST["h1"]), rule, Spacer(1, 6)]


def _kv(rows: list[tuple[str, str]], cols: int = 2, width: float = CONTENT_W) -> Table:
    """Label / value pairs laid out in `cols` pairs per row, aligned."""
    cells, row = [], []
    for label, value in rows:
        row += [P(label, "small"), P(value, "cellb")]
        if len(row) == cols * 2:
            cells.append(row)
            row = []
    if row:
        row += [""] * (cols * 2 - len(row))
        cells.append(row)
    label_w, value_w = 3.0 * cm, width / cols - 3.0 * cm
    table = Table(cells, colWidths=[label_w, value_w] * cols)
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def _grid(header: list[str], rows: list[list], widths: list[float], *, mono: bool = False, repeat: int = 1) -> Table:
    style_h, style_c = ("monoh", "mono") if mono else ("head", "cell")
    data = [[P(h, style_h) for h in header]] + [
        [c if isinstance(c, Paragraph) else P(c, style_c) for c in r] for r in rows
    ]
    table = Table(data, colWidths=widths, repeatRows=repeat)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), BAND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 if not mono else 1.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 if not mono else 1.2),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in range(2, len(data), 2):
        commands.append(("BACKGROUND", (0, i), (-1, i), SOFT))
    table.setStyle(TableStyle(commands))
    return table


def _image(data: bytes, width: float) -> RLImage:
    from PIL import Image

    w, h = Image.open(io.BytesIO(data)).size
    return RLImage(io.BytesIO(data), width=width, height=width * h / w)


def _legend() -> Table:
    def dot(color):
        return Table(
            [[""]],
            colWidths=[9],
            rowHeights=[9],
            style=[("BACKGROUND", (0, 0), (-1, -1), colors.Color(*[c / 255 for c in color]))],
        )

    items = [
        (smap.START_COLOR, "Start (S) and end (E)"),
        (smap.STOP_SHORT_COLOR, "Stop under 15 minutes"),
        (smap.STOP_LONG_COLOR, "Stop of 15 minutes or more"),
        (smap.ROUTE_COLOR, "Route travelled"),
    ]
    row, widths = [], []
    for color, label in items:
        row += [dot(color), P(label, "small")]
        widths += [0.45 * cm, 3.8 * cm]
    table = Table([row], colWidths=widths)
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 2)]))
    return table


# ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────────


def build(
    track: DutyTrack, segments: list[DutyTrackSegment], events: list[DutyTrackEvent], trail: dict, now: datetime
) -> bytes:
    """The PDF (bytes) of one journey. `trail` is hr_views.trail_payload(): every recorded fix, in time order."""
    emp = track.employee
    session = track.session
    company = (PayrollSettings.get().company_name or "UKTextiles").strip()
    points = trail.get("points") or []
    used = [p for p in points if p.get("used", True)] or points
    route = [(p["lat"], p["lng"]) for p in used]
    stops = [s for s in segments if s.kind == DutyTrackSegment.KIND_STOP]
    stop_no = {s.pk: i + 1 for i, s in enumerate(stops)}
    day = track.started_at.astimezone(FACTORY_TZ).strftime("%d %B %Y")
    who = f"{_full_name(emp)} ({emp.employee_code})"
    budget = smap.MapBudget()

    story: list = []

    # ── title band ──
    title = Table(
        [
            [P("ON-DUTY JOURNEY REPORT", "head"), P(company, "head")],
            [P(f"{_full_name(emp)}  ({emp.employee_code})", "h2"), P(day, "h2")],
        ],
        colWidths=[CONTENT_W * 0.68, CONTENT_W * 0.32],
    )
    title.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), BAND),
                ("BACKGROUND", (0, 1), (-1, 1), SOFT),
                ("ALIGN", (1, 0), (1, 1), "RIGHT"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story += [title, Spacer(1, 4)]
    sub = f"Destination: {session.destination}   |   Request status: {STATUS_LABEL.get(session.status, session.status)}"
    story += [P(sub, "small"), Spacer(1, 8)]

    # ── the numbers up front ──
    ended = track.ended_at or (None if track.status == DutyTrack.STATUS_ACTIVE else track.last_point_at)
    total_s = int(((ended or now) - track.started_at).total_seconds())
    kpis = [
        (_km(track.distance_m), "Distance travelled"),
        (_hm(total_s), "Journey duration"),
        (_hm(track.travel_s), "Time travelling"),
        (str(track.stop_count), "Stops"),
        (_hm(track.longest_stop_s) if track.stop_count else "-", "Longest stop"),
        (f"{track.max_speed_kmh or 0:.0f} km/h", "Top speed"),
    ]
    kpi = Table(
        [[P(v, "kpi_v") for v, _ in kpis], [P(label, "kpi_l") for _, label in kpis]],
        colWidths=[CONTENT_W / len(kpis)] * len(kpis),
    )
    kpi.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SOFT),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("LINEAFTER", (0, 0), (-2, -1), 0.5, LINE),
                ("TOPPADDING", (0, 0), (-1, 0), 7),
                ("BOTTOMPADDING", (0, 1), (-1, 1), 6),
            ]
        )
    )
    story += [kpi]

    # ── 1. journey map ──
    story += _section("1. Journey map")
    markers: list[smap.Marker] = []
    if route:
        markers.append(smap.Marker(route[0][0], route[0][1], "S", smap.START_COLOR, 20, tag="START"))
        markers.append(smap.Marker(route[-1][0], route[-1][1], "E", smap.START_COLOR, 20, tag="END", tag_below=True))
    for s in stops:
        if s.center_lat is None or s.center_lng is None:
            continue
        color = smap.STOP_LONG_COLOR if s.duration_s >= LONG_STOP_S else smap.STOP_SHORT_COLOR
        markers.append(smap.Marker(float(s.center_lat), float(s.center_lng), str(stop_no[s.pk]), color, 12))
    if route or markers:
        img, has_tiles = smap.render(route, markers, 1500, 860, budget)
        story += [_image(img, CONTENT_W), Spacer(1, 3), _legend()]
        story += [P(f"Route drawn from {len(route)} recorded locations.", "small")]
    else:
        story += [P("No location was recorded for this journey, so there is no route to draw.", "body")]

    # ── 2. journey details ──
    story += _section("2. Journey details")
    story.append(
        _kv(
            [
                ("Journey started", _ist(track.started_at)),
                ("Journey ended", _ist(ended) if ended else "Still recording"),
                (
                    "Ended because",
                    (track.get_end_reason_display() if track.end_reason else "")
                    or ("Still recording" if not ended else "-"),
                ),
                ("Total duration", _hm(total_s)),
                ("Distance travelled", _km(track.distance_m)),
                ("Time travelling", _hm(track.travel_s)),
                ("Time stationary", _hm(track.stop_s)),
                ("Time with no data", _hm(track.gap_s)),
                ("Stops", str(track.stop_count)),
                ("Longest stop", _hm(track.longest_stop_s) if track.stop_count else "-"),
                ("Top speed", f"{track.max_speed_kmh or 0:.1f} km/h"),
                ("Location points", str(track.points_count)),
                ("Tracking events", str(track.events_count)),
                ("Fake-location points", str(track.mock_points)),
                ("Last known battery", f"{track.last_battery_pct}%" if track.last_battery_pct is not None else "-"),
                ("Report generated", _ist(now)),
            ]
        )
    )

    # ── 3. route breakdown ──
    story += _section("3. Route breakdown")
    if route:
        story.append(
            _kv(
                [
                    ("Starting point", _coord(*route[0])),
                    ("Start time", _ist(track.started_at)),
                    ("Ending point", _coord(*route[-1])),
                    ("End time", _ist(ended) if ended else "Still recording"),
                ]
            )
        )
        story.append(Spacer(1, 6))

    def place_of(seg: DutyTrackSegment) -> str:
        if seg.kind == DutyTrackSegment.KIND_STOP:
            where = seg.address or _coord(seg.center_lat, seg.center_lng)
            if seg.radius_m:
                where += f" (within {seg.radius_m:.0f} m)"
            return where
        if seg.kind == DutyTrackSegment.KIND_TRAVEL:
            return (
                f"{_coord(seg.start_lat, seg.start_lng)}  to  {_coord(seg.end_lat, seg.end_lng)}; "
                f"average {seg.avg_speed_kmh:.0f} km/h, top {seg.max_speed_kmh:.0f} km/h"
            )
        return {"signal_lost": "Signal was lost", "gps_off": "GPS was off", "network_lost": "No network"}.get(
            seg.cause, "No location was received" + (f" ({seg.cause})" if seg.cause else "")
        )

    rows = []
    for seg in segments:
        label = KIND_LABEL.get(seg.kind, seg.kind)
        if seg.kind == DutyTrackSegment.KIND_STOP:
            label = f"Stop {stop_no[seg.pk]}"
        rows.append(
            [
                str(seg.seq_no),
                label,
                f"{_ist(seg.started_at, False)} to {_ist(seg.ended_at, False)}",
                _hm(seg.duration_s),
                _km(seg.distance_m) if seg.kind == DutyTrackSegment.KIND_TRAVEL else "-",
                place_of(seg),
            ]
        )
    if rows:
        story.append(
            _grid(
                ["#", "Part", "Time (IST)", "Duration", "Distance", "Where / how"],
                rows,
                [0.8 * cm, 1.7 * cm, 3.6 * cm, 2.1 * cm, 1.8 * cm, CONTENT_W - 10.0 * cm],
            )
        )
    else:
        story.append(P("No travel, stop or gap was recorded.", "body"))

    # ── 4. stop details ──
    story += _section("4. Stop details")
    if not stops:
        story.append(P("No stop was detected on this journey.", "body"))
    for i, seg in enumerate(stops):
        number = stop_no[seg.pk]
        block: list = [P(f"Stop {number}", "h2")]
        details = _kv(
            [
                ("Arrived", _ist(seg.started_at)),
                ("Left", _ist(seg.ended_at)),
                ("Stayed", _hm(seg.duration_s)),
                ("Location", seg.address or "Place name not recorded"),
                ("Coordinates", _coord(seg.center_lat, seg.center_lng)),
                ("Within", f"{seg.radius_m:.0f} m" if seg.radius_m else "-"),
                ("Locations", str(seg.point_count)),
                (
                    "Google Maps",
                    f"maps.google.com/?q={float(seg.center_lat):.6f},{float(seg.center_lng):.6f}"
                    if seg.center_lat is not None
                    else "-",
                ),
            ],
            cols=1,
            width=CONTENT_W - 6.9 * cm,
        )
        if i < STOP_MAP_CAP and seg.center_lat is not None and seg.center_lng is not None:
            color = smap.STOP_LONG_COLOR if seg.duration_s >= LONG_STOP_S else smap.STOP_SHORT_COLOR
            here = [(float(seg.center_lat), float(seg.center_lng))]
            local = [
                (p["lat"], p["lng"]) for p in points if p.get("stop") == seg.seq_no and p.get("used", True)
            ] or here
            near = [smap.Marker(here[0][0], here[0][1], str(number), color, 13)]
            img, _tiles = smap.render(local, near, 720, 520, budget, zoom=17, pad=40, line_width=4)
            picture = _image(img, 6.6 * cm)
            side = Table([[picture, details]], colWidths=[6.9 * cm, CONTENT_W - 6.9 * cm])
            side.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
            block.append(side)
        else:
            block.append(details)
        block.append(Spacer(1, 6))
        story.append(KeepTogether(block))
    if len(stops) > STOP_MAP_CAP:
        story.append(
            P(
                f"Close-up maps are drawn for the first {STOP_MAP_CAP} stops; the others are listed above with their coordinates.",
                "small",
            )
        )

    # ── 5. attendance details ──
    story += _section("5. Attendance details")
    story.append(P("Employee", "h2"))
    story.append(
        _kv(
            [
                ("Name", _full_name(emp)),
                ("Employee code", emp.employee_code),
                ("Department", emp.department.name if emp.department_id and emp.department else "-"),
                (
                    "Designation",
                    emp.designation.title if getattr(emp, "designation_id", None) and emp.designation else "-",
                ),
                ("Branch", track.branch.name if track.branch_id and track.branch else "-"),
                ("Phone", (emp.phone or "-").strip() or "-"),
            ]
        )
    )
    story.append(P("On-Duty request", "h2"))
    story.append(
        _kv(
            [
                ("Destination", session.destination),
                ("Request submitted", _ist(session.created_at)),
                ("Status", STATUS_LABEL.get(session.status, session.status)),
                ("Started on duty", _ist(session.started_at)),
                (
                    "Department Head",
                    _decision(session.hod_reviewed_by, session.hod_reviewed_at, session.hod_review_comment),
                ),
                ("HR", _decision(session.hr_reviewed_by, session.hr_reviewed_at, session.hr_review_comment)),
                ("Ended by employee", _ist(session.employee_ended_at)),
                (
                    "Completed",
                    _ist(session.completed_at) + (f" by {session.completed_by}" if session.completed_by else ""),
                ),
            ]
        )
    )
    outpass = OutpassRequest.objects.filter(on_duty_session=session).first()
    if outpass is not None:
        story.append(P(f"Outpass raised with the approval: {getattr(outpass, 'status', '-')}.", "small"))

    story.append(P("Geo-punches of this request", "h2"))
    punches = list(OnDutyPunchVerification.objects.filter(session=session).order_by("punch_number", "created_at", "id"))
    if punches:
        story.append(
            _grid(
                ["#", "Date", "Time", "Type", "Location", "Decision", "Decided by (HR)"],
                [
                    [
                        str(v.punch_number),
                        v.punch_date.strftime("%d-%b-%Y"),
                        v.punch_time.strftime("%H:%M:%S"),
                        "In" if v.punch_type == "IN" else "Out",
                        _coord(v.latitude, v.longitude) + (" (fake location flagged)" if v.is_mocked else ""),
                        v.status.capitalize(),
                        _decision(v.hr_reviewed_by, v.hr_reviewed_at, v.hr_review_comment),
                    ]
                    for v in punches
                ],
                [0.7 * cm, 2.0 * cm, 1.8 * cm, 1.1 * cm, 4.6 * cm, 1.8 * cm, CONTENT_W - 12.0 * cm],
            )
        )
    else:
        story.append(P("No geo-punch was made under this request.", "body"))

    story.append(P("Attendance records of the day", "h2"))
    first_day = track.started_at.astimezone(FACTORY_TZ).date()
    last_day = (ended or now).astimezone(FACTORY_TZ).date()
    records = list(
        AttendanceDayRecord.objects.filter(employee=emp, date__range=(first_day, max(first_day, last_day))).order_by(
            "date"
        )
    )
    if records:
        story.append(
            _grid(
                ["Date", "Status", "First punch", "Last punch", "Shifts", "Source"],
                [
                    [
                        r.date.strftime("%d-%b-%Y"),
                        r.get_status_display(),
                        r.first_punch.strftime("%H:%M") if r.first_punch else "-",
                        r.last_punch.strftime("%H:%M") if r.last_punch else "-",
                        f"{r.shifts_earned}",
                        r.source or "-",
                    ]
                    for r in records
                ],
                [2.6 * cm, 2.6 * cm, 2.4 * cm, 2.4 * cm, 1.8 * cm, CONTENT_W - 11.8 * cm],
            )
        )
    else:
        story.append(P("No attendance record is stored for the day yet.", "body"))
    story.append(
        P("An On-Duty day counts as worked only when HR approved the request and the punches are there.", "small")
    )

    # ── 6. tracking notices ──
    notices = [e for e in events if e.kind not in (DutyTrackEvent.KIND_TRACKING_STARTED,)]
    if notices:
        story += _section("6. Tracking notices")
        story.append(
            _grid(
                ["Time (IST)", "Notice", "Until", "Where"],
                [
                    [
                        _ist(e.started_at),
                        e.kind.replace("_", " ").capitalize(),
                        _ist(e.ended_at, False) if e.ended_at else "-",
                        _coord(e.latitude, e.longitude),
                    ]
                    for e in notices[:200]
                ],
                [3.6 * cm, 6.0 * cm, 2.4 * cm, CONTENT_W - 12.0 * cm],
            )
        )

    # ── 7. location history ──
    story += _section("7. Location history")
    if points:
        listed = _cap_points(points)
        note = f"Every recorded location with its time ({len(points)} in all)."
        if len(listed) < len(points):
            note = (
                f"{len(points)} locations were recorded; {len(listed)} are listed here, spread evenly across the journey "
                "(the Excel export has every one)."
            )
        if trail.get("truncated"):
            note += " The server already thinned the trail before it was listed."
        story.append(P(note, "small"))
        story.append(Spacer(1, 4))
        story.append(_history(listed))
    else:
        story.append(P("No location was recorded.", "body"))

    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=1.6 * cm,
        title=f"On-Duty journey report - {who} - {day}",
        author=company,
    )
    frame = Frame(
        MARGIN,
        1.6 * cm,
        CONTENT_W,
        PAGE_H - MARGIN - 1.6 * cm,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=_decorator(company, who, _ist(now)))])
    doc.build(story, canvasmaker=_Numbered)
    return buffer.getvalue()


def _decision(by, at, comment) -> str:
    if not by:
        return "-"
    text = f"{by}, {_ist(at)}"
    return f"{text} ({comment})" if comment else text


def _cap_points(points: list[dict]) -> list[dict]:
    if len(points) <= HISTORY_CAP:
        return points
    step = (len(points) - 1) / (HISTORY_CAP - 1)
    return [points[round(i * step)] for i in range(HISTORY_CAP)]


def _history(points: list[dict]) -> Table:
    """The fixes as two side-by-side blocks (time, latitude, longitude, accuracy, speed), so a long journey takes half the pages."""
    header = ["#", "Time (IST)", "Latitude", "Longitude", "Acc (m)", "km/h"]
    half = (len(points) + 1) // 2

    def row(i: int, p: dict) -> list[str]:
        t = datetime.fromtimestamp(p["t"] / 1000, tz=FACTORY_TZ)
        return [
            str(i + 1),
            t.strftime("%d-%b %H:%M:%S"),
            f"{p['lat']:.6f}",
            f"{p['lng']:.6f}",
            "-" if p.get("acc") is None else f"{p['acc']:.0f}",
            "-" if p.get("spd") is None else f"{p['spd']:.0f}",
        ]

    left = [row(i, p) for i, p in enumerate(points[:half])]
    right = [row(half + i, p) for i, p in enumerate(points[half:])]
    right += [[""] * len(header)] * (len(left) - len(right))
    widths = [0.9 * cm, 2.4 * cm, 1.9 * cm, 1.9 * cm, 1.0 * cm, 0.9 * cm]
    data = [[P(h, "monoh") for h in header] * 2]
    for a, b in zip(left, right):
        data.append([P(x, "mono") for x in a + b])
    table = Table(data, colWidths=widths * 2, repeatRows=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), BAND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
        ("LINEAFTER", (len(header) - 1, 0), (len(header) - 1, -1), 0.8, MUTED),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]
    table.setStyle(TableStyle(commands))
    return table
