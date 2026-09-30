"""Time Card -- one row per employee per day (in / out punches, worked hours, late / early / overtime /
permission minutes, status), with a printable one-page-per-employee PDF.

Facts come from the persisted engine verdict (AttendanceDayRecord) and the raw punches; see
attendance_core_data for the rules. A day nobody has opened yet is blank and counted as "not processed".
"""

from __future__ import annotations

import io
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from ..branding import company
from ..common import with_subtotals
from ..export_pdf import BRAND, BRAND_SOFT, GRID, INK, MUTED, ZEBRA, ensure_fonts
from ..filters import ReportParamError, boolean, date_range, select
from ..formatting import MONTH_ABBR, display_date, parse_date
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import BADGE, DATE, HOURS, INTEGER, MINUTES, NUMBER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    MAX_EMPLOYEE_DAYS,
    AttendanceData,
    build_day,
    detection_notes,
    drop_dormant,
    emp_days_guard,
    hhmm,
    hours,
    scope_filters,
    scoped_employees,
    weekday_text,
)
from .attendance_core_pdf import letterhead, numbered_canvas, short, style_factory, title_bar

REPORT_ID = "time-card"
LONG_RANGE_DAYS = 31
LONG_RANGE_MAX_EMPLOYEES = 5

DAY_STATUS_OPTIONS = [
    ("present", "Present"),
    ("half", "Half day"),
    ("absent", "Absent"),
    ("leave", "On leave"),
    ("off", "Holiday / weekly off"),
    ("late", "Late"),
    ("early_out", "Early out"),
    ("exceptions", "Punch exceptions"),
    ("unprocessed", "Not processed"),
]

COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.2),
    ColumnSpec("in1", "In 1", TIME, 0.7),
    ColumnSpec("out1", "Out 1", TIME, 0.7),
    ColumnSpec("in2", "In 2", TIME, 0.7),
    ColumnSpec("out2", "Out 2", TIME, 0.7),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.7),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.9, total="sum"),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early Out (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("halfDay", "Half Day", BADGE, 0.9),
    ColumnSpec("otMinutes", "OT (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("permissionMinutes", "Permission (min)", MINUTES, 1.0, total="sum"),
    ColumnSpec("status", "Status", BADGE, 1.1),
    ColumnSpec("shiftsEarned", "Shift Credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 2.6),
)
SUM_KEYS = ("workedHours", "lateMinutes", "earlyOutMinutes", "otMinutes", "permissionMinutes", "shiftsEarned")


def _remarks(day, data: AttendanceData, ctx_today) -> str | None:
    emp, d, rec = day.emp, day.date, day.rec
    out: list[str] = []
    if not day.in_service:
        out.append("Outside joining / leaving dates")
    elif day.unprocessed:
        out.append("Not processed yet - open Attendance for this date")
    if day.label == "Holiday" and d in data.holidays:
        out.append(f"Holiday: {data.holidays[d]}")
    if day.leave is not None:
        ltype = day.leave.leave_type_ref.code if day.leave.leave_type_ref_id else (day.leave.type or "leave")
        out.append(f"Approved leave ({ltype})")
    slot = data.half_leave.get((emp.id, d))
    if slot:
        out.append(f"Half-day leave ({slot})")
    if rec is not None and rec.source == "manual":
        who = rec.override_by or "HR"
        note = (rec.override_note or "").strip()
        out.append(f"Manual entry by {who}" + (f": {note}" if note else ""))
    if day.perm_types:
        out.append("Permission: " + ", ".join(day.perm_types))
    for flag in day.flags:
        if flag == "Late" and day.late_min is not None:
            continue
        if flag == "Early out" and day.early_min is not None:
            continue
        if flag in ("Permission", "HR override", "Half-day leave"):
            continue  # already spelled out above
        out.append(flag)
    if emp.employment_type != "production" and rec is not None and day.shift is None:
        out.append("No shift assigned - late / OT cannot be judged")
    if day.basis == "single" and d != ctx_today:
        out.append("Single punch - worked hours not computed")
    elif day.basis == "odd" and d != ctx_today:
        out.append(f"Odd punches ({len(day.punches)}) - worked hours not computed")
    if len(day.punches) > 4:
        out.append("Punches: " + ", ".join(hhmm(p.at) for p in day.punches))
    return "; ".join(out) or None


def _matches(day, key: str) -> bool:
    if key == "present":
        return day.kind == "present"
    if key == "half":
        return day.kind == "half"
    if key == "absent":
        return day.kind == "absent"
    if key == "leave":
        return day.kind == "leave"
    if key == "off":
        return day.kind in ("holiday", "weekly_off")
    if key == "late":
        return bool(day.rec and day.rec.is_late)
    if key == "early_out":
        return bool(day.rec and day.rec.early_leave)
    if key == "exceptions":
        return bool(day.issues)
    if key == "unprocessed":
        return day.unprocessed
    return True


def _run(ctx) -> ReportResult:
    days = ctx.days_in_range
    d_from, d_to = ctx.date_from, ctx.date_to
    everyone = scoped_employees(ctx, order="dept_code")
    if len(days) > LONG_RANGE_DAYS and len(everyone) > LONG_RANGE_MAX_EMPLOYEES:
        raise ReportParamError(
            f"For more than {LONG_RANGE_DAYS} days choose at most {LONG_RANGE_MAX_EMPLOYEES} employees "
            "(a month is the widest range for a whole department)",
            "employee",
        )
    deduct = bool(ctx.params.get("deductLunch", True))
    include_off = bool(ctx.params.get("includeOffDays", True))
    want = ctx.params.get("dayStatus")
    today = ctx.today

    # The roster is worked through in blocks of the size whose day rows would just fill the row limit. The day
    # filters, "no holidays" and the dormant-leaver rule all remove rows AFTER an employee is loaded, so a block is
    # judged by the rows it really produced: a later block is read until the limit is reached (the runner then
    # reports "truncated") or the roster is exhausted. An employee is never dropped silently.
    per_emp = len(days) + 1  # one row per day plus the employee's total row
    block = max(1, ctx.row_limit // per_emp + 1)
    blocks = [everyone[i : i + block] for i in range(0, len(everyone), block)] or [[]]

    rows: list[dict] = []
    cache_emps: dict[str, dict] = {}
    counts = {"present": 0, "half": 0, "absent": 0, "leave": 0, "off": 0, "late": 0, "unprocessed": 0}
    worked_hours: list[float] = []
    data = None
    scanned = 0
    for chunk in blocks:
        scanned += len(chunk)
        if scanned * len(days) > MAX_EMPLOYEE_DAYS:
            emp_days_guard(len(everyone), len(days))  # the filters leave too few rows to stop early: say so
        data = AttendanceData(ctx, chunk, d_from, d_to, punches=True, leaves=True, permissions=True, service=True)
        for emp in drop_dormant(ctx, chunk, data):
            shifts_seen: list[str] = []
            emp_rows = 0
            for d in days:
                day = build_day(data, emp, d, deduct_lunch=deduct)
                if day.kind in ("holiday", "weekly_off") and not include_off:
                    continue
                if want and not _matches(day, want):
                    continue
                if day.shift is not None and day.shift.name not in shifts_seen and day.in_service:
                    shifts_seen.append(day.shift.name)
                p = day.punches
                punch_at = [hhmm(x.at) for x in p[:4]]
                punch_at += [None] * (4 - len(punch_at))
                if not p and day.first_in:  # manual entry: HR typed the times
                    punch_at = [day.first_in, day.last_out, None, None]
                rec = day.rec
                rows.append(
                    {
                        "employeeCode": emp.employee_code,
                        "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                        "department": emp.department.name if emp.department_id else "Unassigned",
                        "date": d.isoformat(),
                        "day": weekday_text(d),
                        "shift": day.shift.name if day.shift is not None else None,
                        "in1": punch_at[0],
                        "out1": punch_at[1],
                        "in2": punch_at[2],
                        "out2": punch_at[3],
                        "punchCount": len(p) or None,
                        "workedHours": hours(day.worked_min),
                        "lateMinutes": day.late_min,
                        "earlyOutMinutes": day.early_min,
                        "halfDay": day.half,
                        "otMinutes": day.ot_min,
                        "permissionMinutes": day.perm_min,
                        "status": day.label,
                        "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                        "remarks": _remarks(day, data, today),
                    }
                )
                emp_rows += 1
                if day.kind in ("present", "half", "absent", "leave"):
                    counts[day.kind] += 1
                elif day.kind in ("holiday", "weekly_off"):
                    counts["off"] += 1
                if rec is not None and rec.is_late:
                    counts["late"] += 1
                if day.unprocessed:
                    counts["unprocessed"] += 1
                # the card adds the figures the rows show (rounded per day), exactly as the totals row does
                worked_hours.append(hours(day.worked_min) or 0.0)
            if emp_rows:
                cache_emps[emp.employee_code] = {
                    "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                    "department": emp.department.name if emp.department_id else "Unassigned",
                    "designation": emp.designation.title if emp.designation_id else None,
                    "type": "Production" if emp.employment_type == "production" else "Staff",
                    "shifts": shifts_seen,
                }
        if len(rows) + len(cache_emps) >= ctx.row_limit:
            break  # over the limit already (the runner cuts it and says so); the rest is not read

    rows = with_subtotals(rows, group_by=lambda r: r["employeeCode"], sum_keys=SUM_KEYS)
    ctx._cache["time_card"] = {"employees": cache_emps, "from": d_from, "to": d_to}

    notes = [
        "Status, half-day, late, early-out and permission flags are the attendance engine's own verdict "
        "(the same record payroll reads). Worked hours, late, early-out and overtime minutes are derived here "
        "from the raw punches and the assigned shift.",
        "In / Out are positional (1st punch = In 1, 2nd = Out 1 ...); double taps within 5 minutes are ignored "
        "for worked hours. Worked hours need an even number of punches; a two-punch day counts the whole span "
        + ("minus the shift's lunch break when it lies inside the span." if deduct else "including any lunch break."),
        "Late (min) = first punch minus shift start (a Morning Late-In permission moves the start by 60 minutes); "
        "the day is flagged late only after the shift's grace period. OT (min) = last punch beyond shift end, "
        f"shown when at least the Settings threshold ({data.settings.ot_threshold_minutes or 60} min); "
        "overtime is paid only after HR announces it.",
    ]
    if not (data.settings.ot_detection_enabled and data.settings.compensation_feature_enabled):
        notes.append(
            "Overtime detection is switched off in Settings: OT minutes are shown for information only "
            "(no overtime record is created, announced or paid from them)."
        )
    notes += detection_notes(data.settings)
    if counts["unprocessed"]:
        notes.append(
            f"{counts['unprocessed']} day(s) have no attendance record yet (nobody has opened them in Attendance): "
            "status is blank; reports never compute attendance themselves."
        )
    if d_to >= today >= d_from:
        notes.append("Today's status is provisional until the shift ends.")
    summary = [
        {"label": "Employees", "value": len(cache_emps), "format": "integer"},
        {"label": "Present days", "value": counts["present"], "format": "integer"},
        {"label": "Half days", "value": counts["half"], "format": "integer"},
        {"label": "Absent days", "value": counts["absent"], "format": "integer"},
        {"label": "Leave days", "value": counts["leave"], "format": "integer"},
        {"label": "Late days", "value": counts["late"], "format": "integer"},
        {"label": "Worked hours", "value": round(sum(worked_hours), 2), "format": "hours"},
        {"label": "Days not processed", "value": counts["unprocessed"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ── printable PDF: one page per employee ────────────────────────────────────────


def _short_date(iso) -> str:
    d = parse_date(iso)
    return f"{d.day:02d}-{MONTH_ABBR[d.month - 1]}-{d.year % 100:02d}" if d else ""


def _cell(v, kind: str = "text") -> str:
    if v is None or v == "":
        return "-"
    if kind == "hours":
        return f"{float(v):.2f}"
    if kind == "int":
        return f"{int(v):,}"
    return str(v)


def build_time_card_pdf(ctx, out) -> bytes:
    """A printable time card: for every employee a page with the header block, the daily table, a totals
    footer and signature lines. A period of up to a month fits one A4 page per employee; a longer one flows
    onto further pages of the same card."""
    regular, bold, _rupee = ensure_fonts()
    co = company()
    cache = ctx._cache.get("time_card", {})
    info = cache.get("employees", {})
    period = f"{display_date(cache.get('from'))} to {display_date(cache.get('to'))}" if cache.get("from") else ""

    page = A4
    margin = 1.2 * cm
    avail = page[0] - 2 * margin
    style = style_factory(regular, 7.0, 8.6)
    s_small = style("s", fontSize=6.3, leading=7.6)
    s_head = style("h", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=6.6, leading=7.8)
    s_label = style("lb", fontSize=6.5, leading=8, textColor=MUTED)
    s_value = style("vl", fontName=bold, fontSize=8.5, leading=10.5)
    s_note = style("nt", fontSize=6.3, leading=7.8, textColor=MUTED)
    s_foot = style("fv", fontName=bold, fontSize=9, leading=11, textColor=BRAND, alignment=TA_LEFT)

    # group the (already normalised) rows by employee, keeping structural rows out
    by_emp: dict[str, list[dict]] = {}
    for r in out.rows:
        if r.get("_kind") == KIND_SUBTOTAL or not r.get("employeeCode"):
            continue
        by_emp.setdefault(r["employeeCode"], []).append(r)

    story: list = []
    first = True
    for code, rows in by_emp.items():
        if not first:
            story.append(PageBreak())
        first = False
        meta = info.get(code, {})
        name = meta.get("name") or rows[0].get("employeeName") or ""
        dept = meta.get("department") or rows[0].get("department") or ""

        story += letterhead(co, avail, regular, bold, style)
        story.append(title_bar("TIME CARD", period, avail, bold, style))

        def field(label, value):
            return [Paragraph(escape(label), s_label), Paragraph(escape(value or "-"), s_value)]

        grid = Table(
            [
                [field("Employee", name), field("Employee code", code), field("Employee type", meta.get("type"))],
                [
                    field("Department", dept),
                    field("Designation", meta.get("designation")),
                    field("Shift", ", ".join(meta.get("shifts") or []) or None),
                ],
            ],
            colWidths=[avail * 0.42, avail * 0.29, avail * 0.29],
        )
        grid.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), BRAND_SOFT),
                    ("BOX", (0, 0), (-1, -1), 0.5, GRID),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        story.append(grid)
        story.append(Spacer(1, 5))

        # -- daily table ----------------------------------------------------
        head = [
            "Date",
            "Day",
            "In",
            "Out",
            "In",
            "Out",
            "Hours",
            "Late<br/>min",
            "Early<br/>min",
            "OT<br/>min",
            "Perm<br/>min",
            "Status",
            "Remarks",
        ]
        weights = [1.2, 0.65, 0.72, 0.72, 0.72, 0.72, 0.75, 0.65, 0.65, 0.65, 0.65, 1.1, 3.6]
        widths = [avail * w / sum(weights) for w in weights]
        data_rows: list[list] = [[Paragraph(h, s_head) for h in head]]
        cmds: list[tuple] = [
            ("BACKGROUND", (0, 0), (-1, 0), BRAND),
            ("FONTNAME", (0, 1), (-1, -1), regular),
            ("FONTSIZE", (0, 1), (-1, -1), 7),
            ("LEADING", (0, 1), (-1, -1), 8.4),
            ("TEXTCOLOR", (0, 1), (-1, -1), INK),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (2, 1), (10, -1), "CENTER"),
            ("ALIGN", (1, 1), (1, -1), "CENTER"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, GRID),
            ("BOX", (0, 0), (-1, -1), 0.5, GRID),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 1.6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6),
        ]
        tot = {"hours": 0.0, "late": 0, "early": 0, "ot": 0, "perm": 0, "shifts": 0.0}
        n_status = {"Present": 0, "Half Day": 0, "Absent": 0, "Leave": 0, "Off": 0}
        late_days = 0
        for r in rows:
            i = len(data_rows)
            status = r.get("status")
            data_rows.append(
                [
                    _short_date(r.get("date")),
                    r.get("day") or "",
                    _cell(r.get("in1")),
                    _cell(r.get("out1")),
                    _cell(r.get("in2")),
                    _cell(r.get("out2")),
                    _cell(r.get("workedHours"), "hours"),
                    _cell(r.get("lateMinutes"), "int"),
                    _cell(r.get("earlyOutMinutes"), "int"),
                    _cell(r.get("otMinutes"), "int"),
                    _cell(r.get("permissionMinutes"), "int"),
                    status or "-",
                    Paragraph(escape(short(r.get("remarks"), 90)), s_small),
                ]
            )
            if status in ("Holiday", "Weekly Off"):
                cmds.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
            elif status == "Absent":
                cmds.append(("TEXTCOLOR", (11, i), (11, i), colors.HexColor("#B91C1C")))
            if r.get("lateMinutes"):
                cmds.append(("TEXTCOLOR", (7, i), (7, i), colors.HexColor("#B45309")))
            tot["hours"] += float(r.get("workedHours") or 0)
            tot["late"] += int(r.get("lateMinutes") or 0)
            tot["early"] += int(r.get("earlyOutMinutes") or 0)
            tot["ot"] += int(r.get("otMinutes") or 0)
            tot["perm"] += int(r.get("permissionMinutes") or 0)
            tot["shifts"] += float(r.get("shiftsEarned") or 0)
            if status in ("Present", "Casual Leave", "Comp Off"):
                n_status["Present"] += 1
            elif status in n_status:
                n_status[status] += 1
            elif status in ("Holiday", "Weekly Off"):
                n_status["Off"] += 1
            if r.get("lateMinutes") or "Late" in (r.get("remarks") or "").split("; "):
                late_days += 1
        table = Table(data_rows, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle(cmds))
        story.append(table)
        story.append(Spacer(1, 5))

        # -- totals footer --------------------------------------------------
        story.append(CondPageBreak(5.4 * cm))
        labels = [
            "Present",
            "Half days",
            "Absent",
            "Leave",
            "Holiday / off",
            "Late days",
            "Late min",
            "Worked hrs",
            "OT min",
            "Shift credit",
        ]
        values = [
            n_status["Present"],
            n_status["Half Day"],
            n_status["Absent"],
            n_status["Leave"],
            n_status["Off"],
            late_days,
            f"{tot['late']:,}",
            f"{tot['hours']:.2f}",
            f"{tot['ot']:,}",
            f"{tot['shifts']:.2f}",
        ]
        foot = Table(
            [
                [Paragraph(escape(x), s_label) for x in labels],
                [Paragraph(f"<b>{escape(str(v))}</b>", s_foot) for v in values],
            ],
            colWidths=[avail / len(labels)] * len(labels),
        )
        foot.setStyle(
            TableStyle(
                [
                    ("BOX", (0, 0), (-1, -1), 0.5, GRID),
                    ("INNERGRID", (0, 0), (-1, -1), 0.25, GRID),
                    ("BACKGROUND", (0, 0), (-1, 0), BRAND_SOFT),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                ]
            )
        )
        story.append(foot)
        story.append(Spacer(1, 3))
        story.append(
            Paragraph(
                "Late / early / OT / permission are minutes; hours are worked hours between punches (an odd number of punches "
                "leaves the day's hours blank). Status is the attendance engine's verdict.",
                s_note,
            )
        )
        story.append(Spacer(1, 24))
        gap = avail * 0.06
        sig_w = (avail - 2 * gap) / 3
        sig = Table(
            [["", "", "", "", ""], ["Employee signature", "", "Supervisor / HOD", "", "HR"]],
            colWidths=[sig_w, gap, sig_w, gap, sig_w],
            rowHeights=[8, 12],
        )
        sig.setStyle(
            TableStyle(
                [
                    ("LINEABOVE", (0, 1), (0, 1), 0.6, INK),
                    ("LINEABOVE", (2, 1), (2, 1), 0.6, INK),
                    ("LINEABOVE", (4, 1), (4, 1), 0.6, INK),
                    ("FONTNAME", (0, 1), (-1, 1), regular),
                    ("FONTSIZE", (0, 1), (-1, 1), 7),
                    ("TEXTCOLOR", (0, 1), (-1, 1), MUTED),
                    ("ALIGN", (0, 1), (-1, 1), "CENTER"),
                ]
            )
        )
        story.append(sig)

    if not by_emp:
        story += letterhead(co, avail, regular, bold, style)
        story.append(title_bar("TIME CARD", period, avail, bold, style))
        story.append(Spacer(1, 8))
        story.append(
            Paragraph(
                "No time-card rows match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED)
            )
        )

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=1.6 * cm,
        title="Time Card",
        author=co.name,
    )
    frame = Frame(
        margin,
        1.6 * cm,
        avail,
        page[1] - margin - 1.6 * cm,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="card", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(story, canvasmaker=numbered_canvas(f"{co.name} - Time Card  |  {stamp}", regular, margin))
    return buf.getvalue()


register(
    ReportSpec(
        id=REPORT_ID,
        title="Time Card",
        description="Day-by-day punch card per employee: in / out times, worked hours, late, early-out, overtime and "
        "permission minutes. The PDF prints one page per employee with a totals footer and signature lines.",
        category="attendance",
        icon="Clock",
        tags=("timecard", "punch card", "in out", "worked hours", "late", "overtime", "muster"),
        modules=("attendance",),
        filters=(
            date_range(default="thisMonth", label="Period", max_days=100),
            *scope_filters(status="all"),
            select("dayStatus", "Show only", DAY_STATUS_OPTIONS, placeholder="All days"),
            boolean("includeOffDays", "Include holidays and weekly offs", default=True),
            boolean(
                "deductLunch",
                "Deduct lunch on two-punch days",
                default=True,
                help="A day with only an In and an Out counts the whole span minus the shift's lunch break.",
            ),
        ),
        columns=COLUMNS,
        run=_run,
        landscape=True,
        pdf_builder=build_time_card_pdf,
        screen_limit=10_000,
        pdf_max_rows=6_000,
    )
)
