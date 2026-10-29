"""HR Reports (category ``hr``): Time Card (Form 25 B) in the format of the company's printed register.

hr-time-card: one card per employee for a period of up to a month -- one row per day with the In / Lunch Out / Lunch In /
Out punches, the overtime window, the hours worked, the shifts present and the OT shifts -- and a printable PDF with one
page per employee in the layout of the printed form (header box, two-level table, legend, totals, signature lines).

It adds no data rules of its own. The facts come from the same loader the generic Time Card (attendance_core_timecard)
uses: the persisted engine verdict (AttendanceDayRecord) and the raw punches, never computed on a GET. A day nobody has
opened in Attendance has no verdict and prints "Not processed". See ``NOTES`` for how each printed field is mapped.
"""

from __future__ import annotations

import datetime as dt
import io
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.platypus import BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

from django.db.models import F

from api.models import Holiday, OvertimeRecord

from ..branding import company
from ..export_pdf import BRAND_SOFT, GRID, INK, MUTED, ZEBRA, ensure_fonts
from ..filters import ReportParamError, boolean, date_range
from ..formatting import display_date, full_name, parse_date
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    L_CASUAL,
    L_COMP,
    WEEKDAYS,
    AttendanceData,
    build_day,
    drop_dormant,
    emp_days_guard,
    leave_type_text,
    scope_filters,
)
from .attendance_core_pdf import letterhead, numbered_canvas, style_factory

REPORT_ID = "hr-time-card"
MODULES = ("attendance",)
MAX_DAYS = 31  # a card is a month: one A4 page per employee
MAX_EMPLOYEES = 200  # 200 cards x (31 days + a total line) stays inside the PDF row ceiling set on the spec

# What a day with no punches prints in the In Time cell (the legend of the printed form).
WEEKLY_OFF = "WO"
NOT_APPLICABLE = "NA"  # before the joining date / after the last working day
NOT_PROCESSED = "Not processed"
HOLIDAY_CODES = {"national": "NH", "regional": "FH", "company": "OH"}
LEGEND_NOTE = (
    "Leave days print the leave type's own code (EL, SL ...); CL - Casual Leave (paid), CO - Compensation Off, "
    "NP - Not processed (nobody has opened the day in Attendance yet)."
)

COLUMNS = (
    ColumnSpec("employeeCode", "Employee Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee Name", TEXT, 1.8),
    ColumnSpec("department", "Department", TEXT, 1.2),
    ColumnSpec("designation", "Designation", TEXT, 1.3),
    ColumnSpec("sno", "SNo", INTEGER, 0.5, align="center"),
    ColumnSpec("date", "Date", TEXT, 1.6),
    ColumnSpec("inTime", "In Time", TEXT, 0.95, align="center"),
    ColumnSpec("lunchOut", "Lunch Out", TEXT, 0.95, align="center"),
    ColumnSpec("lunchIn", "Lunch In", TEXT, 0.95, align="center"),
    ColumnSpec("outTime", "Out Time", TEXT, 0.95, align="center"),
    ColumnSpec("otIn", "OT In", TEXT, 0.95, align="center"),
    ColumnSpec("otOut", "OT Out", TEXT, 0.95, align="center"),
    ColumnSpec("totalHrs", "Total Hrs", TEXT, 1.0, align="center"),
    ColumnSpec("totalOtHrs", "Total OT Hrs", TEXT, 1.0, align="center"),
    ColumnSpec("present", "Present", NUMBER, 0.7, total="sum"),
    ColumnSpec("ot", "OT", NUMBER, 0.6, total="sum"),
)


# ── small formatters ────────────────────────────────────────────────────────────


def _t12(t: dt.time | None) -> str | None:
    """'09:03 AM', the way the printed card shows a punch."""
    return t.strftime("%I:%M %p") if t is not None else None


def _hrs(minutes: int | None) -> str | None:
    """'11:01 Hrs'."""
    return None if minutes is None else f"{minutes // 60:02d}:{minutes % 60:02d} Hrs"


def _day_text(d: dt.date) -> str:
    """'01-09-2026 Tue'."""
    return f"{d.day:02d}-{d.month:02d}-{d.year} {WEEKDAYS[d.weekday()]}"


def _dmy(d: dt.date | None) -> str:
    return f"{d.day:02d}-{d.month:02d}-{d.year}" if d else "-"


def _span_text(start: dt.time | None, end: dt.time | None) -> str:
    return f"{_t12(start)} To {_t12(end)}" if start is not None and end is not None else "-"


def _lunch_text(shift) -> str:
    """The lunch window of the assigned shift: it starts when the first half ends and lasts the lunch duration (the
    window the engine itself uses). A shift with no first-half end (production shifts) has none."""
    if shift is None or shift.first_half_end is None or not shift.lunch_duration_minutes:
        return "-"
    start = dt.datetime.combine(dt.date.min, shift.first_half_end)
    end = start + dt.timedelta(minutes=int(shift.lunch_duration_minutes))
    return _span_text(shift.first_half_end, end.time())


def _day_punches(day) -> list:
    """The day's punches in order with a second tap within 5 minutes of the previous kept punch dropped (the same
    double-tap rule worked hours use), so the printed times and the printed total agree."""
    kept: list = []
    for p in day.punches:
        if not kept or p.secs - kept[-1].secs >= 300:
            kept.append(p)
    return kept


# ── one employee-day ────────────────────────────────────────────────────────────


def _marker(day, hol_types: dict) -> str | None:
    """What stands in the In Time cell on a day the employee did not punch (the printed legend)."""
    if not day.in_service:
        return NOT_APPLICABLE
    if day.kind == "weekly_off":
        return WEEKLY_OFF
    if day.kind == "holiday":
        return HOLIDAY_CODES.get(hol_types.get(day.date), "OH")
    if day.kind == "leave":
        return (leave_type_text(day.leave) or "LV")[:6]
    if day.label == L_CASUAL:
        return "CL"
    if day.label == L_COMP:
        return "CO"
    if day.unprocessed:
        return NOT_PROCESSED
    return None


def _paid_shifts(ot) -> Decimal:
    """OT shifts payroll pays for one overtime record: the shifts HR announced as Pay (a record from before the
    shift-based rules, with none, is one whole day). Relaxation, automatic allowance, detected and rejected pay nothing."""
    if ot.status != "announced" or ot.compensation_type != "pay" or ot.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE:
        return Decimal("0")
    return Decimal(str(ot.shifts)) if ot.shifts is not None else Decimal("1")


def _overtime(day, ot, threshold: int) -> tuple[int, Decimal, dt.time | None, dt.time | None]:
    """(OT minutes, OT shifts paid, OT In, OT Out) of one day. Staff only. OT In is the shift end and OT Out the last
    punch: the engine keeps no separate overtime punch pair. The minutes are the overtime record's (a rejected one counts
    nothing), or, with no record, the minutes the attendance engine stored past the shift end when they reach the
    Settings threshold (shown for information)."""
    rec = day.rec
    zero = (0, Decimal("0"), None, None)
    if rec is None or day.emp.employment_type == "production":
        return zero
    last = day.punches[-1].at if day.punches else None
    if ot is not None:
        if ot.status == OvertimeRecord.STATUS_REJECTED:
            return zero
        return (
            int(ot.ot_minutes or 0),
            _paid_shifts(ot),
            ot.shift_end_time or (day.shift.end_time if day.shift is not None else None),
            ot.last_punch_out or last,
        )
    minutes = int(rec.ot_extra_minutes or 0)
    if minutes < max(1, threshold):
        return zero
    return minutes, Decimal("0"), (day.shift.end_time if day.shift is not None else None), last


def _punch_cells(day) -> tuple[str | None, str | None, str | None, str | None]:
    """(In, Lunch Out, Lunch In, Out): first and last punch; the two middle punches only on a four-punch day."""
    kept = _day_punches(day)
    if kept:
        first, last = _t12(kept[0].at), (_t12(kept[-1].at) if len(kept) >= 2 else None)
        if len(kept) == 4:
            return first, _t12(kept[1].at), _t12(kept[2].at), last
        return first, None, None, last
    rec = day.rec
    if rec is not None and rec.source == "manual" and rec.first_punch is not None:  # HR typed the times
        return _t12(rec.first_punch), None, None, _t12(rec.last_punch)
    return None, None, None, None


# ── the report ──────────────────────────────────────────────────────────────────


def _ot_header(emp, settings) -> str:
    """What the card's 'OT :' header says. The printed form says 'Double The Wage'; our overtime rules do not: an
    announced Pay record pays its shifts x the daily wage (Settings > Compensation), so that is what is printed."""
    if emp.employment_type == "production":
        return "Extra shifts (in shift credit)"
    if not (settings.compensation_feature_enabled and settings.ot_detection_enabled):
        return "Not detected (switched off)"
    return "OT Shifts x Daily Wage"


def _wages_header(emp) -> str:
    if emp.employment_type == "production":
        return "Shift"
    return "Week" if (emp.salary_type or "").strip().lower() == "weekly" else "Month"


def _run(ctx) -> ReportResult:
    days = ctx.days_in_range
    d_from, d_to = ctx.date_from, ctx.date_to
    # ctx.employees() leaves out the photo and the password hash; department, then code, like the generic Time Card
    everyone = list(
        ctx.employees().order_by(F("department__name").asc(nulls_last=True), "employee_code")[: MAX_EMPLOYEES + 1]
    )
    if len(everyone) > MAX_EMPLOYEES:
        raise ReportParamError(
            f"A card run covers at most {MAX_EMPLOYEES} employees (one page each): choose a department, designation "
            "or employees and try again",
            "employee",
        )
    emp_days_guard(len(everyone), len(days))
    deduct = bool(ctx.params.get("deductLunch", False))
    today = ctx.today
    data = AttendanceData(ctx, everyone, d_from, d_to, punches=True, leaves=True, service=True)
    settings = data.settings
    threshold = settings.ot_threshold_minutes or 60

    hol_types: dict[dt.date, str] = {}
    ot_by_day: dict[tuple[int, dt.date], OvertimeRecord] = {}
    if everyone:
        # the first Holiday row of a date decides (as AttendanceData.holidays does); its type picks NH / FH / OH
        for d, htype in (
            Holiday.objects.filter(date__gte=d_from, date__lte=d_to).order_by("id").values_list("date", "holiday_type")
        ):
            hol_types.setdefault(d, htype)
        for ot in OvertimeRecord.objects.filter(
            employee_id__in=[e.id for e in everyone], date__gte=d_from, date__lte=d_to
        ).only(
            "employee_id", "date", "ot_minutes", "status", "compensation_type", "ot_type", "shifts",
            "shift_end_time", "last_punch_out",
        ):  # fmt: skip
            ot_by_day[(ot.employee_id, ot.date)] = ot

    rows: list[dict] = []
    cards: dict[str, dict] = {}
    data_rows = 0
    grand = {"present": 0.0, "holiday": 0, "off": 0, "absent": 0, "leave": 0, "ot_min": 0, "unprocessed": 0}
    punched_unprocessed = no_shift = 0
    for emp in drop_dormant(ctx, everyone, data):
        if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export; never build more than it keeps
            break
        name = full_name(emp)
        dept = emp.department.name if emp.department_id else "Unassigned"
        desig = emp.designation.title if emp.designation_id else None
        tot = {"present": 0.0, "holiday": 0, "off": 0, "absent": 0, "leave": 0, "ot_min": 0, "work_min": 0, "ot": 0.0}
        shift = next((s for s in (data.shift(emp, d) for d in reversed(days)) if s is not None), None)
        no_shift += shift is None and emp.employment_type != "production"
        for n, d in enumerate(days, 1):
            day = build_day(data, emp, d, deduct_lunch=deduct)
            rec = day.rec
            p_in, p_lo, p_li, p_out = _punch_cells(day)
            worked = bool(day.punches) or p_in is not None
            if p_in is None:
                p_in = _marker(day, hol_types)
            elif day.unprocessed:
                punched_unprocessed += 1
            ot_min, ot_shifts, ot_in, ot_out = _overtime(day, ot_by_day.get((emp.id, d)), threshold)
            present = float(rec.shifts_earned) if rec is not None else None
            rows.append(
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": name,
                    "department": dept,
                    "designation": desig,
                    "sno": n,
                    "date": _day_text(d),
                    "inTime": p_in,
                    "lunchOut": p_lo,
                    "lunchIn": p_li,
                    "outTime": p_out,
                    "otIn": _t12(ot_in) if ot_min else None,
                    "otOut": _t12(ot_out) if ot_min else None,
                    "totalHrs": _hrs(day.worked_min),
                    "totalOtHrs": _hrs(ot_min) if rec is not None and worked else None,
                    "present": present,
                    "ot": float(ot_shifts) if present is not None else None,
                }
            )
            data_rows += 1
            if present is not None:
                tot["present"] += present
                tot["ot"] += float(ot_shifts)
            tot["work_min"] += day.worked_min or 0
            tot["ot_min"] += ot_min
            if day.kind == "holiday":
                tot["holiday"] += 1
            elif day.kind == "weekly_off":
                tot["off"] += 1
            elif day.kind == "leave":
                tot["leave"] += 1
            elif day.kind == "absent" and not day.in_progress:
                tot["absent"] += 1
            if day.unprocessed:
                grand["unprocessed"] += 1
        rows.append(
            {
                "employeeName": f"{name} ({emp.employee_code}) total",
                "date": (
                    f"Holidays {tot['holiday']:.2f}  Weekly off {tot['off']:.2f}  "
                    f"Absent {tot['absent']:.2f}  Leave {tot['leave']:.2f}"
                ),
                "totalHrs": _hrs(tot["work_min"]),
                "totalOtHrs": _hrs(tot["ot_min"]),
                "present": round(tot["present"], 2),
                "ot": round(tot["ot"], 2),
                "_kind": KIND_SUBTOTAL,
            }
        )
        for k in ("present", "holiday", "off", "absent", "leave", "ot_min"):
            grand[k] += tot[k]
        doj = parse_date(emp.join_date)
        cards[emp.employee_code] = {
            "name": name,
            "department": dept,
            "designation": desig,
            "father": (emp.father_name or "").strip() or None,
            "doj": _dmy(doj) if doj else ((emp.join_date or "").strip() or "-"),
            "wages": _wages_header(emp),
            "ot": _ot_header(emp, settings),
            "working": _span_text(shift.start_time, shift.end_time) if shift is not None else "-",
            "lunch": _lunch_text(shift),
            "weekly": (
                "Sunday Working Day"
                if emp.employment_type == "production"
                else "Sunday Holiday" + (" and Saturday Holiday" if data.saturday_off(emp, d_to) else "")
            ),
            "totals": {
                "present": round(tot["present"], 2),
                "holidays": tot["holiday"],
                "absent": tot["absent"],
                "leave": tot["leave"],
                "weeklyOff": tot["off"],
                "otHours": round(tot["ot_min"] / 60, 2),
            },
        }

    ctx._cache["hr_time_card"] = {
        "employees": cards,
        "from": d_from,
        "to": d_to,
        "company": (settings.slip_company_name or settings.company_name or "").strip(),
        "town": (settings.slip_company_address or "").strip(),
    }

    notes = [
        f"One card per employee for {display_date(d_from)} to {display_date(d_to)} (at most {MAX_DAYS} days and "
        f"{MAX_EMPLOYEES} employees per run: the PDF prints one page per employee). Father Name, date of joining, the "
        "shift's working and lunch hours and the wage basis print in the PDF header only.",
        "Facts come from the attendance engine's stored verdict and the raw punches; nothing is computed while you "
        "view or export. In Time / Out Time are the first and last punch of the day (a second tap within 5 minutes is "
        "ignored); Lunch Out / Lunch In show only on a day with exactly four punches, otherwise a dash. Total Hrs is the "
        "time between the punches"
        + (
            ", less the shift's lunch on a two-punch day."
            if deduct
            else " (the full span on a two-punch day, as on the printed form)."
        )
        + " A day with one or an odd number of punches has no Total Hrs.",
        "Present is the shifts the engine stored for the day (staff 1.00 or 0.50, production up to 1.50); absent, leave, "
        "holiday and weekly-off days are 0.00, and a day with no stored verdict is a dash. Staff weekly off is Sunday "
        "(and Saturday on a Saturday-off schedule); production works Sundays, so a production card has no WO days.",
        "In Time prints WO (weekly off), NH / FH / OH (a National / Regional / Company holiday, by the holiday's type), "
        "the leave type's code on a leave day, CL / CO (casual leave / compensation day), NA (before joining or after the "
        "last working day) or Not processed (printed NP) on a day without punches.",
        "Overtime: OT In is the shift end and OT Out the last punch (the engine keeps no separate overtime punch times); "
        "Total OT Hrs is the overtime record's minutes, or the minutes past shift end the engine stored when they reach "
        f"the Settings threshold ({threshold} min; shown for information). OT is the shifts HR announced as Pay "
        "(shifts x the daily wage, so the card's OT header reads 'OT Shifts x Daily Wage', not 'Double The Wage'); "
        "relaxation, automatic-allowance, detected and rejected overtime count 0.00. Overtime is for staff only: "
        "production extra shifts are already inside Present.",
    ]
    if not (settings.compensation_feature_enabled and settings.ot_detection_enabled):
        notes.append(
            "Overtime detection is switched off in Settings > Compensation: only the overtime already on record and the "
            "minutes the engine stored are shown, and nothing new is detected."
        )
    if grand["unprocessed"]:
        notes.append(
            f"{grand['unprocessed']} day(s) have no attendance record yet (nobody has opened them in Attendance), so "
            "Present is a dash and they are counted in no total; reports never compute attendance themselves."
            + (f" {punched_unprocessed} of them have punches, which are shown." if punched_unprocessed else "")
        )
    if no_shift:
        notes.append(
            f"{no_shift} staff employee(s) have no shift assigned: their working and lunch hours print as a dash."
        )
    if d_to >= today >= d_from:
        notes.append("Today's status is provisional until the shift ends.")
    summary = [
        {"label": "Employees", "value": len(cards), "format": "integer"},
        {"label": "Present (shifts)", "value": round(grand["present"], 2), "format": "number"},
        {"label": "Holidays", "value": grand["holiday"], "format": "integer"},
        {"label": "Weekly offs", "value": grand["off"], "format": "integer"},
        {"label": "Absent days", "value": grand["absent"], "format": "integer"},
        {"label": "Leave days", "value": grand["leave"], "format": "integer"},
        {"label": "OT hours", "value": round(grand["ot_min"] / 60, 2), "format": "hours"},
        {"label": "Days not processed", "value": grand["unprocessed"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ── printable PDF: one page per employee, in the layout of the printed form ──────


def _cell(v, *, number: bool = False) -> str:
    if v is None or v == "":
        return "-"
    if number:
        return f"{float(v):.2f}"
    return "NP" if v == NOT_PROCESSED else str(v)


def build_time_card_pdf(ctx, out) -> bytes:
    regular, bold, _rupee = ensure_fonts()
    cache = ctx._cache.get("hr_time_card", {})
    info = cache.get("employees", {})
    co = company()
    company_name = cache.get("company") or co.name
    town = cache.get("town")
    period = (cache.get("from"), cache.get("to"))

    page = A4
    margin = 1.0 * cm
    avail = page[0] - 2 * margin
    style = style_factory(regular, 7.6, 9.4)
    s_c = style("c", alignment=TA_CENTER, fontName=bold, fontSize=8.4, leading=11)
    s_from = style("fr", alignment=TA_CENTER, fontName=bold, fontSize=7.8, leading=10)
    s_l = style("l", alignment=TA_LEFT, fontName=bold, fontSize=7.6, leading=10)
    s_co = style("co", alignment=TA_LEFT, fontName=bold, fontSize=11, leading=13)
    s_town = style("tw", alignment=TA_LEFT, fontSize=8, leading=10)
    s_lic = style("lic", alignment=TA_LEFT, fontName=bold, fontSize=7.6, leading=10)
    s_field = style("fl", fontSize=8.4, leading=11)
    s_head = style("hd", fontName=bold, alignment=TA_CENTER, fontSize=7.0, leading=8.4)
    s_note = style("nt", fontSize=7.2, leading=9)
    s_tot = style("tt", fontName=bold, fontSize=8.4, leading=11)
    s_tiny = style("tn", fontSize=6.4, leading=8, textColor=MUTED)

    by_emp: dict[str, list[dict]] = {}
    for r in out.rows:
        if r.get("_kind") == KIND_SUBTOTAL or not r.get("employeeCode"):
            continue
        by_emp.setdefault(r["employeeCode"], []).append(r)

    def para(text, st):
        return Paragraph(text, st)

    story: list = []
    for i, (code, rows) in enumerate(by_emp.items()):
        if i:
            story.append(PageBreak())
        meta = info.get(code, {})
        totals = meta.get("totals", {})

        # -- header boxes --------------------------------------------------------
        top = [
            [para(escape(company_name), s_co), para(escape(town or ""), s_town)],
            [
                para("Time Card", s_c),
                para("Monthly Consolidated Report", s_c),
                para("Form 25 B, see Rule 103", s_c),
                para("License No :", s_lic),
            ],
            [
                para(f"DOJ : {escape(meta.get('doj') or '-')}", s_c),
                para(f"Normal Wages : {escape(meta.get('wages') or '-')}", s_c),
                para(f"OT : {escape(meta.get('ot') or '-')}", s_c),
            ],
        ]
        bottom = [
            [
                para(f"Working Hours : {escape(meta.get('working') or '-')}", s_l),
                para(escape(meta.get("weekly") or ""), s_l),
            ],
            [para(f"From {_dmy(period[0])} To {_dmy(period[1])}", s_from)],
            [para(f"Lunch Hours : {escape(meta.get('lunch') or '-')}", s_l)],
        ]
        widths = [avail * 0.37, avail * 0.29, avail * 0.34]
        header = Table([top, bottom], colWidths=widths)
        header.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.9, INK),
                    ("VALIGN", (0, 0), (-1, 0), "TOP"),
                    ("VALIGN", (0, 1), (-1, 1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        story.append(header)
        story.append(Spacer(1, 7))

        def field(label, value):
            return para(f"<b>{escape(label)} :</b>&nbsp;&nbsp;{escape(value or '-')}", s_field)

        who = Table(
            [
                [
                    field("Employee Name", meta.get("name")),
                    field("Employee Code", code),
                    field("Department", meta.get("department")),
                ],
                [field("Father Name", meta.get("father")), "", field("Designation", meta.get("designation"))],
            ],
            colWidths=[avail * 0.40, avail * 0.27, avail * 0.33],
        )
        who.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 2),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story.append(who)
        story.append(Spacer(1, 5))

        # -- daily table (two-level header) ----------------------------------------
        head0 = [
            "SNo",
            "AttDate",
            "Shift Time",
            "",
            "",
            "",
            "OT Time",
            "",
            "Total<br/>Hrs",
            "Total<br/>OT Hrs",
            "Present",
            "OT",
        ]
        head1 = ["", "", "InTime", "LunchOut", "LunchIn", "OutTime", "OT In", "OTOut", "", "", "", ""]
        weights = [0.8, 2.7, 1.8, 1.8, 1.7, 1.8, 1.5, 1.5, 1.8, 1.8, 1.6, 1.0]
        col_w = [avail * w / sum(weights) for w in weights]
        data_rows: list[list] = [
            [para(h, s_head) if h else "" for h in head0],
            [para(h, s_head) if h else "" for h in head1],
        ]
        cmds: list[tuple] = [
            ("SPAN", (0, 0), (0, 1)),
            ("SPAN", (1, 0), (1, 1)),
            ("SPAN", (2, 0), (5, 0)),
            ("SPAN", (6, 0), (7, 0)),
            ("SPAN", (8, 0), (8, 1)),
            ("SPAN", (9, 0), (9, 1)),
            ("SPAN", (10, 0), (10, 1)),
            ("SPAN", (11, 0), (11, 1)),
            ("BACKGROUND", (0, 0), (-1, 1), BRAND_SOFT),
            ("FONTNAME", (0, 2), (-1, -1), regular),
            ("FONTSIZE", (0, 2), (-1, -1), 7.4),
            ("LEADING", (0, 2), (-1, -1), 8.8),
            ("TEXTCOLOR", (0, 2), (-1, -1), INK),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("ALIGN", (1, 2), (1, -1), "LEFT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.4, GRID),
            ("BOX", (0, 0), (-1, -1), 0.9, INK),
            ("LINEBELOW", (0, 1), (-1, 1), 0.9, INK),
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 2.0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.0),
        ]
        for r in rows:
            idx = len(data_rows)
            data_rows.append(
                [
                    str(r.get("sno") or ""),
                    r.get("date") or "",
                    _cell(r.get("inTime")),
                    _cell(r.get("lunchOut")),
                    _cell(r.get("lunchIn")),
                    _cell(r.get("outTime")),
                    _cell(r.get("otIn")),
                    _cell(r.get("otOut")),
                    _cell(r.get("totalHrs")),
                    _cell(r.get("totalOtHrs")),
                    _cell(r.get("present"), number=True),
                    _cell(r.get("ot"), number=True),
                ]
            )
            if r.get("inTime") in (WEEKLY_OFF, *HOLIDAY_CODES.values()):
                cmds.append(("BACKGROUND", (0, idx), (-1, idx), ZEBRA))
        table = Table(data_rows, colWidths=col_w, repeatRows=2)
        table.setStyle(TableStyle(cmds))
        story.append(table)
        story.append(Spacer(1, 6))

        # -- legend and totals --------------------------------------------------------
        legend = Table(
            [
                [para("<b>Note :</b>", s_note), para("WO - Weekly Off", s_note), para("EL - Earned Leave", s_note)],
                ["", para("NH - National Holiday", s_note), para("FH - Festival Holiday", s_note)],
                ["", para("OH - Other Holiday", s_note), para("NA - Not Applicable", s_note)],
            ],
            colWidths=[avail * 0.08, avail * 0.21, avail * 0.21],
        )
        legend.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 1),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                ]
            )
        )

        def tot(label, value):
            return para(f"{escape(label)} : {value}", s_tot)

        sums = Table(
            [
                [
                    tot("Total Present", f"{totals.get('present', 0):.2f}"),
                    tot("Total OT Hours", f"{totals.get('otHours', 0):.2f}"),
                ],
                [
                    tot("Total Holidays", f"{totals.get('holidays', 0):.2f}"),
                    tot("Total weeklyOff", f"{totals.get('weeklyOff', 0):.2f}"),
                ],
                [
                    tot("Total Absent", f"{totals.get('absent', 0):.2f}"),
                    tot("Total Leave", f"{totals.get('leave', 0):.2f}"),
                ],
            ],
            colWidths=[avail * 0.25, avail * 0.25],
        )
        sums.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        foot = Table([[legend, sums]], colWidths=[avail * 0.5, avail * 0.5])
        foot.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        story.append(foot)
        story.append(para(escape(LEGEND_NOTE), s_tiny))
        story.append(Spacer(1, 34))
        sig = Table(
            [["Employee signature", "", "Authorised Signatory"]],
            colWidths=[avail * 0.34, avail * 0.32, avail * 0.34],
        )
        sig.setStyle(
            TableStyle(
                [
                    ("LINEABOVE", (0, 0), (0, 0), 0.6, INK),
                    ("LINEABOVE", (2, 0), (2, 0), 0.6, INK),
                    ("FONTNAME", (0, 0), (-1, 0), bold),
                    ("FONTSIZE", (0, 0), (-1, 0), 8),
                    ("ALIGN", (0, 0), (-1, 0), "CENTER"),
                    ("TOPPADDING", (0, 0), (-1, 0), 3),
                ]
            )
        )
        story.append(sig)

    if not by_emp:
        story += letterhead(co, avail, regular, bold, style)
        story.append(Spacer(1, 8))
        story.append(
            para("No time-card rows match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED))
        )

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=1.6 * cm,
        title="Time Card (Form 25 B)",
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
    doc.build(story, canvasmaker=numbered_canvas(f"{co.name} - Time Card (Form 25 B)  |  {stamp}", regular, margin))
    return buf.getvalue()


register(
    ReportSpec(
        id=REPORT_ID,
        title="Time Card (Form 25 B)",
        description="The monthly time card in the company's Form 25 B layout: punches, hours, overtime and shifts present "
        "for each day, with totals. The PDF prints one page per employee.",
        category="hr",
        icon="ClipboardList",
        tags=(
            "time card",
            "timecard",
            "form 25 b",
            "rule 103",
            "monthly consolidated",
            "punch card",
            "in out",
            "lunch",
            "weekly off",
            "overtime",
            "present",
            "register",
        ),
        modules=MODULES,
        filters=(
            date_range(default="thisMonth", label="Period", max_days=MAX_DAYS),
            *scope_filters(status="all"),
            boolean(
                "deductLunch",
                "Deduct lunch on two-punch days",
                default=False,
                help="Off prints Total Hrs as the whole span between the first and last punch, as the printed card does.",
            ),
        ),
        columns=COLUMNS,
        run=_run,
        landscape=True,
        pdf_builder=build_time_card_pdf,
        screen_limit=7_000,
        pdf_max_rows=7_000,
    )
)
