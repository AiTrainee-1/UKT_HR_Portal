"""Shared pieces of the staff-side Attendance reports of the 2026-11-19 Report Center layout (registers no report).

``rc_attendance_staff`` registers Staff Attendance, Staff Time Card, Time Card with Shift Count, Late Detection, Monthly
Misspunch Records and the Attendance Log on top of what is here:

* ``RcData``: the attendance_core loader (``AttendanceData``: stored day verdicts, punches placed on their working day /
  production SHIFT day, leave, permissions, holidays) whose employment window reads the joining date with the bounded
  parser ``employees_master_base.join_date_of``. The production rows store their joining date as Excel-serial text
  ('01-01-45640'), which the plain ``parse_date`` reads as the year 4564 - every day would then be "before joining" and
  the worker would vanish. An unreadable date now means "employed", never "dropped".
* The staff rules the engine stores but the older reports never showed: the arrival zone of the first punch (On time /
  Late / Excused / Quarter / Second half), the quarter-shift deduction and Penalty Early Out (both already taken off
  ``shifts_earned``, which is what payroll pays).
* The production shift group of a stored day, and the "Out of date" flag of a production day stored before the quarter
  rule (its shifts earned is off the 0.25 grid; payroll recomputes it, the report shows what is stored and says so).
* The one-query loaders of approved on-duty days, half-day Casual Leave and Missing Punch requests.
* The coloured exports of the Staff Attendance grid (one column per date).

Everything here READS: no attendance is computed or saved.
"""

from __future__ import annotations

import datetime as dt
import io
import re
from collections import defaultdict
from decimal import Decimal
from xml.sax.saxutils import escape

from django.db.models import Q
from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

from api.arrival_rules import ZONE_EXCUSED, ZONE_LATE, ZONE_ON_TIME, ZONE_QUARTER, ZONE_SECOND_HALF
from api.models import AttendanceDayRecord, AttendanceLog, CasualLeaveRequest, MissingPunchRequest

from ..branding import company
from ..export_pdf import BRAND, GRID, INK, MUTED, ensure_fonts, pdf_text
from ..export_xlsx import HEADER_ROW, build_xlsx
from ..formatting import display_date
from ..runner import KIND_SUBTOTAL, KIND_TOTAL
from .attendance_core_data import AttendanceData
from .attendance_core_pdf import filter_box, kpi_strip, letterhead, numbered_canvas, style_factory, title_bar
from .employees_master_base import join_date_of

# ── employees ───────────────────────────────────────────────────────────────────

STAFF_TYPE_ALL = "all"


def rc_employees(ctx, *, staff_type: str | None = None, search: str | None = None, order: str = "dept_code") -> list:
    """The employees a report covers: its scope filters + branch isolation (``ctx.employees()``, which never loads the
    photo or the password hash), narrowed to one employee type ("staff" / "production"; None or "all" = both) and an
    optional code / name search. ``order``: "dept_code" = department (unassigned last) then code; "code"."""
    qs = ctx.employees()
    if staff_type in ("staff", "production"):
        qs = qs.filter(employment_type=staff_type)
    term = (search or "").strip()
    if term:
        qs = qs.filter(Q(employee_code__icontains=term) | Q(first_name__icontains=term) | Q(last_name__icontains=term))
    if order == "code":
        return list(qs.order_by("employee_code"))
    return sorted(
        qs,
        key=lambda e: (
            0 if e.department_id else 1,
            (e.department.name or "").lower() if e.department_id else "",
            e.employee_code or "",
        ),
    )


def dept_name(emp) -> str:
    return emp.department.name if emp.department_id else "Unassigned"


def emp_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def type_text(emp) -> str:
    return "Production" if emp.employment_type == "production" else "Staff"


class RcData(AttendanceData):
    """``AttendanceData`` whose employment window reads the joining date with ``join_date_of`` (bounded years), so a
    production worker whose joining date is stored as Excel-serial text is treated as employed, not as "before joining".
    The approved last working day still ends the window (``service=True`` loads it)."""

    def __init__(self, *args, **kwargs):
        self._joined: dict[int, dt.date | None] = {}
        super().__init__(*args, **kwargs)

    def joined(self, emp) -> dt.date | None:
        if emp.id not in self._joined:
            self._joined[emp.id] = join_date_of(emp)[0]
        return self._joined[emp.id]

    def in_service(self, emp, d: dt.date) -> bool:
        join = self.joined(emp)
        if join is not None and d < join:
            return False
        last = self.exit_date.get(emp.id)
        return not (last is not None and d > last)


def staff_working_day(data: AttendanceData, emp, d: dt.date) -> bool:
    """A payroll working day of a staff employee (payroll_views._build_working_days): not a Sunday, not a Saturday-off
    Saturday (the shift in force on the 15th decides) and not a company holiday."""
    if d.weekday() == 6 or d in data.holidays:
        return False
    return not (d.weekday() == 5 and data.saturday_off(emp, d))


# ── staff arrival timeline / deductions (stored by the engine) ─────────────────────────

ZONE_LABELS = {
    ZONE_ON_TIME: "On time",
    ZONE_LATE: "Late",
    ZONE_EXCUSED: "Excused",
    ZONE_QUARTER: "Quarter",
    ZONE_SECOND_HALF: "Second half",
}
ARRIVAL_OPTIONS = [
    (ZONE_LATE, "Late (late pool)"),
    (ZONE_EXCUSED, "Excused by permission"),
    (ZONE_QUARTER, "Quarter shift"),
    (ZONE_SECOND_HALF, "Second half"),
]


def arrival_label(rec) -> str | None:
    """Where the first punch fell on the morning arrival timeline, as stored; a day stored without a zone (production,
    manual, no shift, older rows) that the engine flagged late reads "Late"."""
    if rec is None:
        return None
    zone = getattr(rec, "arrival_zone", "") or ""
    if zone:
        return ZONE_LABELS.get(zone, zone)
    return ZONE_LABELS[ZONE_LATE] if rec.is_late else None


def zone_of(rec) -> str:
    """The stored zone, or "late" for a zoneless day the engine flagged late ("" otherwise)."""
    zone = getattr(rec, "arrival_zone", "") or ""
    if zone:
        return zone
    return ZONE_LATE if rec is not None and rec.is_late else ""


def num(v) -> float:
    return float(v or 0)


def quarter_deducted(rec) -> float | None:
    """The shift the quarter-shift rule took off this day (Settings: 0.25 by default): a present day whose first punch
    fell in the quarter zone. A quarter arrival already cut to a Half Day is not docked twice, and a manual day is HR's
    own value. Worked out from what is stored: 1.00 - shifts earned - the Penalty Early Out part."""
    if rec is None or rec.source == "manual" or rec.status != "present":
        return None
    if (getattr(rec, "arrival_zone", "") or "") != ZONE_QUARTER:
        return None
    penalty = Decimal(rec.penalty_deduction or 0) if rec.penalty_early_out else Decimal("0")
    taken = Decimal("1.00") - Decimal(rec.shifts_earned or 0) - penalty
    return float(taken) if taken > 0 else None


def penalty_deducted(rec) -> float | None:
    """The shift Penalty Early Out took off this day (already out of shifts_earned), None when it did not apply."""
    if rec is None or not getattr(rec, "penalty_early_out", False):
        return None
    return float(rec.penalty_deduction or 0)


def _amount(v: float) -> str:
    return f"{v:g}"


def zone_flags(rec) -> list[str]:
    """The staff timeline facts of a day as plain words for a register's flags / remarks."""
    if rec is None:
        return []
    out: list[str] = []
    zone = getattr(rec, "arrival_zone", "") or ""
    q = quarter_deducted(rec)
    if q:
        out.append(f"Quarter shift (-{_amount(q)})")
    elif zone == ZONE_QUARTER:
        out.append("Quarter-shift arrival (already a half day, nothing more deducted)")
    if zone == ZONE_SECOND_HALF:
        out.append("Second-half arrival (first half missed)")
    elif zone == ZONE_EXCUSED:
        out.append("Late arrival excused by permission")
    p = penalty_deducted(rec)
    if p is not None:
        minutes = int(getattr(rec, "early_out_minutes", 0) or 0)
        out.append(f"Penalty early out (-{_amount(p)}" + (f", left {minutes} min early)" if minutes else ")"))
    return out


# ── production ──────────────────────────────────────────────────────────────────

MANUAL_SHIFT = "Manual entry"
LEGACY_SHIFT = "Legacy rules"
OFF_GRID = "Out of date: stored before the quarter rule (not on the 0.25 grid) - payroll pays the recomputed value"


def production_group(data: AttendanceData, rec) -> str | None:
    """The shift group a stored production day was judged by (Day / Night / Sunday / a special shift), "Manual entry"
    for a day HR entered, "Legacy rules" for a day before the shift-table rules start; None with no first punch."""
    if rec is None:
        return None
    if rec.source == "manual":
        return MANUAL_SHIFT
    judged = data.prod_judge().judgement(rec)
    if judged is not None:
        return judged.group.label
    if rec.first_punch is None:
        return None
    return LEGACY_SHIFT if not data.prod_judge().in_force(rec.date) else None


def off_quarter_grid(emp, rec) -> bool:
    """A production day whose stored shifts earned is not a multiple of 0.25 (stored before the 2026-11-18 quarter rule):
    never recomputed here, but flagged."""
    if rec is None or emp.employment_type != "production" or rec.source == "manual":
        return False
    return (Decimal(rec.shifts_earned or 0) * 4) % 1 != 0


def shift_text(data: AttendanceData, emp, day) -> str | None:
    """The shift column: the staff shift's name, or the production group of the stored day."""
    if emp.employment_type == "production":
        return production_group(data, day.rec)
    return day.shift.name if day.shift is not None else None


# ── one-query loaders ───────────────────────────────────────────────────────────


def on_duty_days(ids, d_from: dt.date, d_to: dt.date) -> set[tuple[int, dt.date]]:
    """(employee id, date) of every day with an approved on-duty punch (AttendanceLog source "on_duty:approved")."""
    if not ids:
        return set()
    return set(
        AttendanceLog.objects.filter(
            employee_id__in=ids, date__gte=d_from, date__lte=d_to, source="on_duty:approved"
        ).values_list("employee_id", "date")
    )


def half_casual_leave(ids, d_from: dt.date, d_to: dt.date) -> dict[tuple[int, dt.date], str]:
    """{(employee id, date): "first_half" | "second_half" | "full"} of APPROVED half-day Casual Leave (both halves on one
    date make a full day). A full-day CL is written as a manual paid day and is read from the day record instead."""
    out: dict[tuple[int, dt.date], str] = {}
    if not ids:
        return out
    for eid, d, portion in (
        CasualLeaveRequest.objects.filter(
            employee_id__in=ids, date__gte=d_from, date__lte=d_to, status=CasualLeaveRequest.STATUS_APPROVED
        )
        .exclude(portion=CasualLeaveRequest.PORTION_FULL)
        .values_list("employee_id", "date", "portion")
    ):
        held = out.get((eid, d))
        out[(eid, d)] = portion if held is None or held == portion else CasualLeaveRequest.PORTION_FULL
    return out


def missing_punch_requests(ids, d_from: dt.date, d_to: dt.date) -> dict[tuple[int, dt.date], list]:
    """{(employee id, date): [MissingPunchRequest, oldest first]} of every request for a date in the range."""
    out: dict[tuple[int, dt.date], list] = defaultdict(list)
    if not ids:
        return out
    for r in (
        MissingPunchRequest.objects.filter(employee_id__in=ids, date__gte=d_from, date__lte=d_to)
        .only("id", "employee_id", "date", "punch_time", "punch_slot", "status", "created_at")
        .order_by("created_at", "id")
    ):
        out[(r.employee_id, r.date)].append(r)
    return out


def coverage_missing(ctx, employees, d_from: dt.date, d_to: dt.date) -> int:
    """Elapsed employee-days of ACTIVE employees (from their joining date, read with join_date_of) that have no stored
    day record. One query."""
    last = min(d_to, ctx.today)
    actives = [e for e in employees if e.status == "active"]
    if last < d_from or not actives:
        return 0
    recorded = set(
        AttendanceDayRecord.objects.filter(
            employee_id__in=[e.id for e in actives], date__gte=d_from, date__lte=last
        ).values_list("employee_id", "date")
    )
    missing = 0
    for e in actives:
        joined = join_date_of(e)[0]
        d = max(d_from, joined) if joined else d_from
        while d <= last:
            if (e.id, d) not in recorded:
                missing += 1
            d += dt.timedelta(days=1)
    return missing


# ── Staff Attendance grid: codes, colours, exports ─────────────────────────────────────

FRACTIONS = {Decimal("0.75"): "¾", Decimal("0.50"): "½", Decimal("0.25"): "¼", Decimal("0.00"): "0"}

# The Report Log Attendance Sheet's palette for the codes it shares (AttendanceSheet.tsx STATUS_META) + the new ones.
GRID_PALETTE = {
    "P": "C6EFCE",
    "CL": "C6EFCE",
    "CO": "C6EFCE",
    "½M": "FFEB9C",
    "½": "FFEB9C",
    "½E": "FED7AA",
    "A": "FFC7CE",
    "L": "BDD7EE",
    "H": "E2E8F0",
    "WO": "E2E8F0",
    "OD": "D9E1F2",
}
DEDUCTED_FILL = "FFF2CC"  # a present day with a shift deduction (P¾, P½ ...)
GRID_LEGEND = [
    ("P", "Present"),
    ("P¾", "Present, 0.25 shift deducted"),
    ("½M", "Half day - morning"),
    ("½E", "Half day - evening"),
    ("A", "Absent"),
    ("L", "Leave"),
    ("CL", "Casual leave"),
    ("CL½", "Half-day casual leave"),
    ("OD", "On-duty"),
    ("H", "Holiday"),
    ("WO", "Weekly off"),
]
DAY_KEY = re.compile(r"^d(\d{4})(\d{2})(\d{2})$")
SUNDAY_HEAD = "FFE4E6"
STRENGTH_FILL = "F1F5F9"


def day_key(d: dt.date) -> str:
    return f"d{d.strftime('%Y%m%d')}"


def fraction_suffix(earned, full: Decimal = Decimal("1.00")) -> str:
    """'' for a full day, else the shifts earned as a glyph: 0.75 -> '¾', 0.5 -> '½', 0.25 -> '¼'."""
    value = Decimal(earned or 0).quantize(Decimal("0.01"))
    if value >= full:
        return ""
    return FRACTIONS.get(value, f"{value.normalize():f}")


def grid_fill(code) -> str | None:
    """Hex fill of a grid cell; None for an empty cell."""
    if not isinstance(code, str) or not code.strip() or code == "-":
        return None
    if code in GRID_PALETTE:
        return GRID_PALETTE[code]
    if code.startswith("CL"):  # CL½: a half-day casual leave
        return GRID_PALETTE["CL"]
    if code.startswith("½"):
        return GRID_PALETTE["½"]
    if code.startswith(("P", "CO", "OD")):  # P¾, OD½ ...: a present day with a shift deduction
        return DEDUCTED_FILL
    return GRID_PALETTE["L"]


def _is_sunday(key: str) -> bool:
    m = DAY_KEY.match(key)
    return bool(m) and dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).weekday() == 6


def build_grid_xlsx(ctx, out) -> bytes:
    """The framework's workbook with the day cells coloured by code and the Strength row as numbers."""
    raw = build_xlsx(out)
    if not out.rows:
        return raw
    wb = load_workbook(io.BytesIO(raw))
    ws = wb.active
    day_cols = [(i, c) for i, c in enumerate(out.columns, start=1) if DAY_KEY.match(c.key)]
    code_font = Font(name="Calibri", size=9, bold=True)
    centre = Alignment(horizontal="center", vertical="center")
    for i, c in day_cols:
        ws.column_dimensions[get_column_letter(i)].width = 5.5
        if _is_sunday(c.key):
            head = ws.cell(row=HEADER_ROW, column=i)
            head.fill = PatternFill("solid", fgColor=SUNDAY_HEAD)
            head.font = Font(name="Calibri", size=10, bold=True, color="9F1239")
    for r, row in enumerate(out.rows, start=HEADER_ROW + 1):
        if row.get("_kind") == KIND_TOTAL:
            for i, c in day_cols:
                cell = ws.cell(row=r, column=i)
                count = row.get(c.key)
                if isinstance(count, (int, float)):
                    cell.value = count
                cell.fill = PatternFill("solid", fgColor=STRENGTH_FILL)
                cell.alignment = centre
            continue
        for i, c in day_cols:
            fill = grid_fill(row.get(c.key))
            if fill is None:
                continue
            cell = ws.cell(row=r, column=i)
            cell.fill = PatternFill("solid", fgColor=fill)
            cell.font = code_font
            cell.alignment = centre
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _fit(text: str, width: float, font: str, size: float, pad: float = 2.0) -> str:
    if pdfmetrics.stringWidth(text, font, size) <= width - 2 * pad:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > width - 2 * pad:
        text = text[:-1]
    return text.rstrip() + "…"


GRID_FIXED_CM = {
    "sno": 0.9,
    "employeeCode": 1.7,
    "employeeName": 3.8,
    "department": 2.6,
    "shifts": 1.1,
    "offDayShifts": 1.1,
    "attendancePct": 1.1,
}
GRID_TEXT_KEYS = ("employeeCode", "employeeName", "department")


def build_grid_pdf(ctx, out) -> bytes:
    """An A3 (more than 16 dates) or A4 landscape register: identity columns, one coloured cell per date, the totals,
    the Strength row, a legend and the notes."""
    regular, bold, rupee_ok = ensure_fonts()
    co = company()
    cols = out.columns
    day_idx = [i for i, c in enumerate(cols) if DAY_KEY.match(c.key)]
    n_days = len(day_idx)
    page = landscape(A3) if n_days > 16 else landscape(A4)
    margin = 1.0 * cm
    avail = page[0] - 2 * margin
    size = 7.0
    style = style_factory(regular, size)

    widths = [0.0 if i in day_idx else GRID_FIXED_CM.get(c.key, 0.8) * cm for i, c in enumerate(cols)]
    base = sum(widths)
    day_w = min(1.0 * cm, max(0.5 * cm, (avail - base) / n_days)) if n_days else 0.0
    for i in day_idx:
        widths[i] = day_w
    used = sum(widths)
    if used < avail:
        extra = avail - used
        for i, c in enumerate(cols):
            if c.key in ("employeeName", "department"):
                widths[i] += extra / 2
    elif used > avail:
        widths = [w * avail / used for w in widths]

    s_head = style("h", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=6.4, leading=7.6)
    s_head_sun = style(
        "hs", fontName=bold, alignment=TA_CENTER, textColor=colors.HexColor("#9F1239"), fontSize=6.4, leading=7.6
    )
    s_note = style("n", fontSize=7, leading=9, textColor=MUTED)

    story: list = []
    story += letterhead(co, avail, regular, bold, style)
    right = f"{display_date(ctx.date_from)} to {display_date(ctx.date_to)}" if ctx.date_from and ctx.date_to else ""
    story.append(title_bar(out.spec.title.upper(), right, avail, bold, style))
    story.append(filter_box(out.filters, avail, style))
    story.append(Spacer(1, 4))
    strip = kpi_strip(out.summary, avail, bold, style, rupee_ok)
    if strip is not None:
        story.append(strip)
        story.append(Spacer(1, 4))

    def head_cell(i: int, c):
        if i in day_idx:
            n, _, wd = c.label.partition(" ")
            return Paragraph(f"{escape(n)}<br/>{escape(wd)}", s_head_sun if _is_sunday(c.key) else s_head)
        return Paragraph(escape(c.label), s_head)

    data: list[list] = [[head_cell(i, c) for i, c in enumerate(cols)]]
    cmds: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("FONTNAME", (0, 1), (-1, -1), regular),
        ("FONTSIZE", (0, 1), (-1, -1), size),
        ("LEADING", (0, 1), (-1, -1), size * 1.2),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.25, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), 1.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1.5),
        ("TOPPADDING", (0, 0), (-1, -1), 1.8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
    ]
    for i in day_idx:
        if _is_sunday(cols[i].key):
            cmds.append(("BACKGROUND", (i, 0), (i, 0), colors.HexColor("#" + SUNDAY_HEAD)))
    text_cols = [i for i, c in enumerate(cols) if c.key in GRID_TEXT_KEYS]
    for i in text_cols:
        cmds.append(("ALIGN", (i, 1), (i, -1), "LEFT"))
    for i in range(len(cols)):
        if i not in text_cols:
            cmds.append(("ALIGN", (i, 1), (i, -1), "CENTER"))

    for row in out.rows:
        idx = len(data)
        kind = row.get("_kind")
        cells = []
        for i, c in enumerate(cols):
            v = row.get(c.key)
            if i in day_idx:
                cells.append("-" if v is None or v == "" else str(v))
            elif i in text_cols:
                cells.append(_fit("" if v is None else str(v), widths[i], bold if kind else regular, size))
            elif kind and v is None:
                cells.append("")
            else:
                cells.append(pdf_text(c, v, rupee_ok))
        data.append(cells)
        if kind in (KIND_TOTAL, KIND_SUBTOTAL):
            cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
            cmds.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#" + STRENGTH_FILL)))
            continue
        for i in day_idx:
            fill = grid_fill(row.get(cols[i].key))
            if fill:
                cmds.append(("BACKGROUND", (i, idx), (i, idx), colors.HexColor("#" + fill)))
                cmds.append(("FONTNAME", (i, idx), (i, idx), bold))
    if out.totals:
        idx = len(data)
        cells = []
        placed = False
        for c in cols:
            v = out.totals.get(c.key)
            if v is None:
                cells.append("" if placed or c.key != "employeeName" else "TOTAL")
                placed = placed or c.key == "employeeName"
            else:
                cells.append(pdf_text(c, v, rupee_ok))
        data.append(cells)
        cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
        cmds.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#DCE6F2")))
        cmds.append(("LINEABOVE", (0, idx), (-1, idx), 0.9, BRAND))

    if len(data) == 1:
        story.append(
            Paragraph("No records match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED))
        )
    else:
        table = Table(data, colWidths=widths, repeatRows=1, splitByRow=1)
        table.setStyle(TableStyle(cmds))
        story.append(table)

    story.append(Spacer(1, 6))
    chip_w, label_w = 0.9 * cm, 3.6 * cm
    per_row = max(1, int(avail // (chip_w + label_w)))
    legend_rows: list[list] = []
    legend_cmds: list[tuple] = [
        ("FONTNAME", (0, 0), (-1, -1), regular),
        ("FONTSIZE", (0, 0), (-1, -1), 6.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]
    for n, (code, label) in enumerate(GRID_LEGEND):
        r, k = divmod(n, per_row)
        if k == 0:
            legend_rows.append([""] * (2 * per_row))
        legend_rows[r][2 * k] = code
        legend_rows[r][2 * k + 1] = _fit(label, label_w, regular, 6.5)
        legend_cmds.append(("BACKGROUND", (2 * k, r), (2 * k, r), colors.HexColor("#" + (grid_fill(code) or "FFFFFF"))))
        legend_cmds.append(("FONTNAME", (2 * k, r), (2 * k, r), bold))
        legend_cmds.append(("ALIGN", (2 * k, r), (2 * k, r), "CENTER"))
    legend = Table(legend_rows, colWidths=[chip_w, label_w] * per_row, hAlign="LEFT")
    legend.setStyle(TableStyle(legend_cmds))
    story.append(legend)
    if out.truncated:
        story.append(Spacer(1, 4))
        story.append(
            Paragraph(
                f"<b>Note:</b> only the first {out.row_count:,} rows are printed here. Narrow the filters to see the rest.",
                s_note,
            )
        )
    for note in out.notes:
        story.append(Spacer(1, 2))
        story.append(Paragraph(escape(note), s_note))

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=1.5 * cm,
        title=out.spec.title,
        author=co.name,
    )
    frame = Frame(
        margin,
        1.5 * cm,
        avail,
        page[1] - margin - 1.5 * cm,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="sheet", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(story, canvasmaker=numbered_canvas(f"{co.name} - {out.spec.title}  |  {stamp}", regular, margin))
    return buf.getvalue()
