"""Shift reports (category ``shift``) of the 2026-11-19 Report Center layout.

    assigned-shift-report   who is on which shift (the shift-roster logic) plus the production special shifts
    gained-shift-report     shifts EARNED per employee and day over a period: the stored day verdicts payroll pays
    shift-change-history    every shift assignment change (shift templates + production special shifts) in a period

shift-wise-attendance and shift-assignment-gaps are defined in attendance_analysis_shifts.py (category "shift").

Read-only, like every report: the day figures are the stored ``AttendanceDayRecord`` rows (what payroll pays), never
recomputed. Staff days are calendar days; production days are SHIFT days (the engine stores a night shift's closing
punch on the day the shift began), so the stored value already is the shift day's.

Production join dates: the production bulk upload stored them as spreadsheet serials ('01-01-45640'). Every report
here reads them with ``employees_master_base.join_date_of(decode_serial=True)`` (``JoinAwareData``), so production
workers are on the rolls from their real joining date instead of being masked as 'not joined yet'.
"""

from __future__ import annotations

import datetime as dt
import io
import re
from collections import Counter, defaultdict
from decimal import Decimal
from xml.sax.saxutils import escape

from django.db.models import Q, Sum
from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

from api.models import CompensationLedger, EmployeeShiftAssignment, ProductionSpecialShiftAssignment
from api.shift_engine import _get_assignment_for_date

from .. import filters as F
from ..branding import company
from ..common import EMP_COLS, EMP_COLS_SHORT, emp_cells
from ..derive import base_spec, derive
from ..export_pdf import BRAND, GRID, INK, MUTED, ensure_fonts, pdf_text
from ..export_xlsx import HEADER_ROW, build_xlsx
from ..formatting import display_date, fmt_dt, full_name
from ..registry import register
from ..runner import KIND_SUBTOTAL, KIND_TOTAL
from ..types import (
    BADGE,
    DATE,
    DATETIME,
    INTEGER,
    NUMBER,
    TEXT,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from . import attendance_analysis_shifts  # noqa: F401  (registers shift-roster, the base of the Assigned Shift Report)
from .attendance_analysis_common import emp_sort_key, hm
from .attendance_core_data import (
    L_CASUAL,
    L_COMP,
    AttendanceData,
    emp_days_guard,
    label_for,
    paid_without_punches,
    weekday_text,
)
from .attendance_core_pdf import filter_box, kpi_strip, letterhead, numbered_canvas, style_factory, title_bar
from .employees_master_base import join_date_of

CATEGORY = "shift"
SHIFT_MODULES = ("shifts", "attendance")
QUARTER = Decimal("0.25")
SERIAL_NOTE = (
    "{n} production employee(s) have a joining date stored as a spreadsheet number (e.g. 01-01-45640); it is read as "
    "the date it stands for, so they count from their real joining date."
)


# ── shared helpers (also used by rc_employee_details) ────────────────────────────────────────────────────────


class JoinAwareData(AttendanceData):
    """``AttendanceData`` whose employment window reads the joining date with the spreadsheet-serial decoder
    (``join_date_of(decode_serial=True)``). The shared loader reads it with a plain parser, which turns a production
    join date such as '01-01-45640' into the year 4564 and masks every day as 'before joining'; the HR reports keep
    that loader unchanged, the reports of this layout use this one."""

    def join_date(self, emp) -> dt.date | None:
        cache = self.__dict__.setdefault("_joins", {})
        if emp.id not in cache:
            cache[emp.id] = join_date_of(emp, decode_serial=True)[0]
        return cache[emp.id]

    def in_service(self, emp, d: dt.date) -> bool:
        join = self.join_date(emp)
        if join is not None and d < join:
            return False
        last = self.exit_date.get(emp.id)
        return not (last is not None and d > last)


def serial_join_count(employees) -> int:
    """How many of these employees have a joining date that was decoded from a spreadsheet serial."""
    return sum(1 for e in employees if join_date_of(e, decode_serial=True)[1] == "serial")


def type_text(emp) -> str:
    return "Production" if emp.employment_type == "production" else "Staff"


def shifts_text(value) -> str:
    """Decimal('1.00') -> '1', Decimal('0.75') -> '0.75', Decimal('1.50') -> '1.5'."""
    q = Decimal(value).quantize(Decimal("0.01"))
    return format(q.normalize(), "f")


def off_grid(value) -> bool:
    """A production day stored before quarter rounding (2.72, 1.49 ...): payroll now pays it in steps of 0.25."""
    return Decimal(value) % QUARTER != 0


def day_key(d: dt.date) -> str:
    return f"d{d:%Y%m%d}"


DAY_KEY = re.compile(r"^d(\d{4})(\d{2})(\d{2})$")


def _is_sunday_key(key: str) -> bool:
    m = DAY_KEY.match(key)
    return bool(m) and dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).weekday() == 6


# ═════════════════════════════════════════════════════════════════════════════
#  assigned-shift-report
# ═════════════════════════════════════════════════════════════════════════════

_ROSTER = base_spec("shift-roster")
SPECIAL_TYPE = "Production special"


def _special_rows(ctx) -> list[dict]:
    """Production special shifts (Manage Shifts) in force during the dates, as rows of the roster's columns."""
    d_from, d_to = ctx.date_from, ctx.date_to
    if ctx.params.get("shiftType") == "staff" or ctx.params.get("saturdayOff") == "yes":
        return []
    name_text = (ctx.params.get("shift") or "").lower()
    qs = (
        ProductionSpecialShiftAssignment.objects.filter(ctx.emp_q("employee__"), effective_from__lte=d_to)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=d_from))
        .select_related("group", "employee__department", "employee__designation")
        .defer("employee__photo_url", "employee__password_hash")
        .order_by("group__label", "employee__employee_code", "effective_from", "id")
    )
    out = []
    for a in qs:
        g, emp = a.group, a.employee
        if name_text and name_text not in (g.label or "").lower():
            continue
        warns = []
        if not g.enabled:
            warns.append("Special shift is switched off")
        if emp.employment_type != "production":
            warns.append(f"Production special shift for a {emp.employment_type} employee")
        out.append(
            {
                **emp_cells(emp),
                "shiftName": g.label,
                "shiftType": SPECIAL_TYPE,
                "startTime": hm(g.start_time),
                "endTime": hm(g.main_out_time),
                "graceMinutes": None,
                "customTimes": "Next day out" if g.main_out_next_day else None,
                "saturdayOff": None,
                "effectiveFrom": a.effective_from.isoformat(),
                "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
                "assignedBy": a.created_by or None,
                "warning": "; ".join(warns) or None,
            }
        )
    return out


def _assigned_run(ctx) -> ReportResult:
    result = _ROSTER.run(ctx)
    special = _special_rows(ctx)
    rows = (list(result.rows) + special)[: ctx.row_limit]
    people = {r["employeeCode"] for r in rows}
    summary = []
    for card in result.summary:
        card = dict(card)
        if card["label"] == "Assignments":
            card["value"] = (card["value"] or 0) + len(special)
        elif card["label"] == "Employees":
            card["value"] = len(people)
        summary.append(card)
    summary.insert(2, {"label": "Production special shifts", "value": len(special), "format": "integer"})
    notes = list(result.notes) + [
        "Production employees: the shift template on their assignment is what the Attendance screens list, but the "
        "production engine judges each SHIFT DAY by the shift table (Settings > Production shifts): the group the first "
        "punch picks (Day / Night / Sunday ...). A production special shift (Manage Shifts) replaces those groups for "
        "the dates it covers; such rows show the group's start and standard out time and type 'Production special'.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


derive(
    "shift-roster",
    id="assigned-shift-report",
    title="Assigned Shift Report",
    description="Who is on which shift, staff and production: timings, grace, Saturday off, effective from / to, "
    "production special shifts and data warnings.",
    category=CATEGORY,
    icon="CalendarDays",
    tags=("shift", "assigned", "roster", "assignment", "timings", "saturday off", "special shift", "production"),
    # at most 8 filters: the shift-name text and Saturday choices go (the table's search and sort cover both)
    drop=("shift", "saturdayOff"),
    run=_assigned_run,
)


# ═════════════════════════════════════════════════════════════════════════════
#  gained-shift-report
# ═════════════════════════════════════════════════════════════════════════════

GAINED_MAX_DAYS = 31
GAINED_HEAD = (*EMP_COLS[:3], ColumnSpec("employmentType", "Type", BADGE, 1.0))
GAINED_TAIL = (
    ColumnSpec("daysWorked", "Days worked", INTEGER, 0.8, total="sum"),
    ColumnSpec("shiftsEarned", "Shifts earned", NUMBER, 0.9, total="sum"),
    ColumnSpec("creditShifts", "Paid credits", NUMBER, 0.8, total="sum"),
    ColumnSpec("quarterDays", "Quarter days", INTEGER, 0.8, total="sum"),
    ColumnSpec("penaltyShifts", "Penalty early out", NUMBER, 0.9, total="sum"),
    ColumnSpec("balanceCredits", "Comp. balance credits", NUMBER, 1.0, total="sum"),
    ColumnSpec("outOfDate", "Out of date days", INTEGER, 0.8, total="sum"),
)
# Day cells for days that earned nothing (or a credit day paid in full).
CODE_ABSENT, CODE_HOLIDAY, CODE_WEEKLY_OFF, CODE_LEAVE, CODE_NOT_ON_ROLL = "A", "H", "WO", "L", "NA"
CODE_CL, CODE_CO, CODE_BIRTHDAY, CODE_RELAX = "CL", "CO", "BL", "RX"
STALE_MARK = "*"
GRID_LEGEND = (
    ("1", "Full shift"),
    ("0.75", "Part of a shift (quarter, half, penalty)"),
    ("1.5", "Over one shift (production)"),
    ("2.72*", "Out of date (stored before quarter rounding)"),
    ("A", "Absent"),
    ("L", "Leave / CL / CO / BL / RX"),
    ("WO", "Holiday / weekly off"),
    ("NA", "Not on the rolls"),
)


def _credit_code(rec, label: str | None) -> str | None:
    """The code of a day paid without being worked (it is part of the shifts earned), or None for a worked day."""
    if label == L_CASUAL:
        return CODE_CL
    if label == L_COMP:
        return CODE_CO
    if paid_without_punches(rec) and not (rec.total_punches or 0):
        return CODE_BIRTHDAY if "birthday" in (rec.compensation_kind or "") else CODE_RELAX
    return None


def _zero_code(kind: str | None) -> str:
    return {
        "absent": CODE_ABSENT,
        "holiday": CODE_HOLIDAY,
        "weekly_off": CODE_WEEKLY_OFF,
        "leave": CODE_LEAVE,
    }.get(kind or "", "0")


def _balance_credits(ctx, d_from: dt.date, d_to: dt.date) -> dict[int, Decimal]:
    """{employee id: shifts credited to the compensation balance for work dated in the period} (one query)."""
    return {
        eid: total or Decimal(0)
        for eid, total in CompensationLedger.objects.filter(
            ctx.emp_q("employee__"), entry_type=CompensationLedger.ENTRY_CREDIT, date__gte=d_from, date__lte=d_to
        )
        .order_by()
        .values("employee_id")
        .annotate(total=Sum("shifts"))
        .values_list("employee_id", "total")
    }


def _gained_run(ctx) -> ReportResult:
    d_from, d_to, today = ctx.date_from, ctx.date_to, ctx.today
    days = ctx.days_in_range
    emps = sorted(ctx.employees(), key=emp_sort_key)
    emp_days_guard(len(emps), len(days))
    data = JoinAwareData(ctx, emps, d_from, d_to, service=True)
    balance = _balance_credits(ctx, d_from, d_to)
    keep_dormant = ctx.params.get("employee_status") == "active" or bool(ctx.params.get("employee_ids"))

    day_cols = [ColumnSpec(day_key(d), f"{d.day} {weekday_text(d)}", TEXT, 0.5, align="center") for d in days]
    per_day: dict[str, Decimal] = defaultdict(Decimal)
    rows: list[dict] = []
    off_roll = unprocessed = 0
    for e in emps:
        if len(rows) >= ctx.row_limit:
            break  # the runner reports the cut-off; nothing more is built
        if not keep_dormant and e.status != "active" and not data.has_activity(e.id):
            continue
        is_prod = e.employment_type == "production"
        row = {
            "employeeCode": e.employee_code,
            "employeeName": full_name(e),
            "department": e.department.name if e.department_id else "Unassigned",
            "employmentType": type_text(e),
        }
        worked = quarter = stale = 0
        total = credit = penalty = Decimal(0)
        on_roll = False
        for d in days:
            key = day_key(d)
            if not data.in_service(e, d):
                row[key] = CODE_NOT_ON_ROLL
                continue
            on_roll = True
            rec = data.record(e.id, d)
            if rec is None:
                row[key] = None
                unprocessed += d <= today
                continue
            kind = data.kind(e, d, rec)
            se = Decimal(rec.shifts_earned or 0)
            total += se
            per_day[key] += se
            code = _credit_code(rec, label_for(kind, rec))
            if code is not None:
                credit += se
                row[key] = code if se == 1 else shifts_text(se)
            elif se > 0:
                worked += kind in ("present", "half")
                stale_day = is_prod and off_grid(se)
                stale += stale_day
                row[key] = shifts_text(se) + (STALE_MARK if stale_day else "")
            else:
                row[key] = _zero_code(kind)
            if not is_prod and (rec.arrival_zone or "") == "quarter":
                quarter += 1
            if rec.penalty_early_out:
                penalty += Decimal(rec.penalty_deduction or 0)
        if not on_roll:
            off_roll += 1
            continue
        row.update(
            daysWorked=worked,
            shiftsEarned=float(total),
            creditShifts=float(credit) if credit else None,
            quarterDays=quarter or None,
            penaltyShifts=float(penalty) if penalty else None,
            balanceCredits=float(balance[e.id]) if balance.get(e.id) else None,
            outOfDate=stale or None,
        )
        rows.append(row)

    columns = [*GAINED_HEAD, *day_cols, *GAINED_TAIL]
    if rows:
        rows.append(
            {"employeeName": "Shifts per day", "_kind": KIND_TOTAL, **{k: shifts_text(v) for k, v in per_day.items()}}
        )
    data_rows = [r for r in rows if not r.get("_kind")]
    total_shifts = sum(Decimal(str(r["shiftsEarned"])) for r in data_rows)
    summary = [
        {"label": "Employees", "value": len(data_rows), "format": "integer"},
        {"label": "Shifts earned", "value": float(total_shifts), "format": "number"},
        {"label": "Days worked", "value": sum(r["daysWorked"] for r in data_rows), "format": "integer"},
        {
            "label": "Paid credits (shifts)",
            "value": float(sum(Decimal(str(r["creditShifts"] or 0)) for r in data_rows)),
            "format": "number",
        },
        {"label": "Quarter days (staff)", "value": sum(r["quarterDays"] or 0 for r in data_rows), "format": "integer"},
        {"label": "Out of date days", "value": sum(r["outOfDate"] or 0 for r in data_rows), "format": "integer"},
    ]
    notes = [
        "Each day cell is the shifts the attendance engine stored for the day (shifts earned, the record payroll reads). "
        "Staff are read by calendar day: a quarter-shift arrival is 0.75, a half day 0.5, and a Penalty Early Out "
        "deduction is already taken off. Production employees are read by SHIFT DAY: a night shift's closing punch made "
        "the next morning counts for the day the shift began, and extra shifts above 1.00 are included; production "
        "payroll pays these shifts as they are.",
        "Staff payroll pays the shifts earned on its working days only: work stored on a Sunday, a Saturday off or a "
        "holiday is in Shifts earned here but is not a paid day, and declared holidays are paid on top. So a staff "
        "total here is the shifts earned, not the days payroll pays (the Staff Attendance Report's Shifts paid and the "
        "Gained Salary Report show that figure).",
        "Codes: A absent, H holiday, WO weekly off (Sundays and Saturday-off Saturdays), L leave, CL casual leave, CO "
        "compensation alternative day, BL birthday leave, RX a day paid from an OT relaxation or redeemed balance, NA "
        "not on the rolls (before joining or after the last working day), a dash = no attendance record yet.",
        "Paid credits are the shifts of CL / CO / BL / RX days (paid without being worked); they are part of Shifts "
        "earned. Comp. balance credits are shifts credited to the compensation balance (holiday work, OT, birthday) "
        "for work dated in the period: they are NOT in Shifts earned and are paid only when the balance is used.",
        "Penalty early out = shifts already deducted for leaving more than the penalty minutes early (staff). Quarter "
        "days = staff arrivals after the late window (0.25 shift deducted).",
    ]
    stale_total = sum(r["outOfDate"] or 0 for r in data_rows)
    if stale_total:
        notes.append(
            f"{stale_total} production day(s) marked * hold a value stored before shifts were rounded to quarters "
            "(e.g. 2.72). Reports never recompute a stored day: payroll works such a day out again (in steps of 0.25) "
            "before it pays, so open the day in Attendance to bring the stored value up to date."
        )
    if unprocessed:
        notes.append(
            f"{unprocessed} employee-day(s) up to today have no attendance record yet (shown as a dash); the background "
            "refresh or opening the day in Attendance stores them."
        )
    if off_roll:
        notes.append(f"{off_roll} employee(s) were not on the rolls on any day of the period and are not listed.")
    serial = serial_join_count(e for e in emps if e.employment_type == "production")
    if serial:
        notes.append(SERIAL_NOTE.format(n=serial))
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


# ── grid exports (one column per day) ──────────────────────────────────────────────────────────────────────

FILL_FULL, FILL_PART, FILL_OVER, FILL_STALE = "C6EFCE", "FFEB9C", "A7F3D0", "FED7AA"
FILL_ABSENT, FILL_LEAVE, FILL_OFF = "FFC7CE", "BDD7EE", "E2E8F0"
SUNDAY_HEAD = "FFE4E6"
TOTAL_FILL = "F1F5F9"


def grid_fill(value) -> str | None:
    """Cell colour of a day code / shift value (hex), None for an empty or 'not on roll' cell."""
    if not isinstance(value, str) or not value or value in ("-", CODE_NOT_ON_ROLL):
        return None
    if value.endswith(STALE_MARK):
        return FILL_STALE
    if value == CODE_ABSENT or value == "0":
        return FILL_ABSENT
    if value in (CODE_HOLIDAY, CODE_WEEKLY_OFF):
        return FILL_OFF
    if value in (CODE_LEAVE, CODE_CL, CODE_CO, CODE_BIRTHDAY, CODE_RELAX):
        return FILL_LEAVE
    try:
        v = Decimal(value)
    except ArithmeticError:
        return None
    return FILL_OVER if v > 1 else FILL_FULL if v == 1 else FILL_PART


def build_grid_xlsx(ctx, out) -> bytes:
    """The framework workbook with the day cells coloured by value and the day columns narrowed."""
    raw = build_xlsx(out)
    if not out.rows:
        return raw
    wb = load_workbook(io.BytesIO(raw))
    ws = wb.active
    day_cols = [(i, c) for i, c in enumerate(out.columns, start=1) if DAY_KEY.match(c.key)]
    bold = Font(name="Calibri", size=9, bold=True)
    centre = Alignment(horizontal="center", vertical="center")
    for i, c in day_cols:
        ws.column_dimensions[get_column_letter(i)].width = 6
        if _is_sunday_key(c.key):
            ws.cell(row=HEADER_ROW, column=i).fill = PatternFill("solid", fgColor=SUNDAY_HEAD)
    for r, row in enumerate(out.rows, start=HEADER_ROW + 1):
        structural = row.get("_kind") in (KIND_TOTAL, KIND_SUBTOTAL)
        for i, c in day_cols:
            cell = ws.cell(row=r, column=i)
            cell.alignment = centre
            fill = TOTAL_FILL if structural else grid_fill(row.get(c.key))
            if fill:
                cell.fill = PatternFill("solid", fgColor=fill)
                cell.font = bold
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _fit(text: str, width: float, font: str, size: float, pad: float = 2.0) -> str:
    if pdfmetrics.stringWidth(text, font, size) <= width - 2 * pad:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > width - 2 * pad:
        text = text[:-1]
    return text.rstrip() + "…"


def build_grid_pdf(ctx, out) -> bytes:
    """A3 / A4 landscape register: identity columns, one narrow coloured column per day, the totals, a legend."""
    regular, bold, rupee_ok = ensure_fonts()
    co = company()
    cols = out.columns
    day_idx = [i for i, c in enumerate(cols) if DAY_KEY.match(c.key)]
    n_days = len(day_idx)
    page = landscape(A3) if n_days > 16 else landscape(A4)
    margin = 1.0 * cm
    avail = page[0] - 2 * margin
    size = 6.8
    style = style_factory(regular, size)
    fixed = {"employeeCode": 1.6, "employeeName": 3.8, "department": 2.6, "employmentType": 1.6}
    widths = [0.0 if i in day_idx else fixed.get(c.key, 1.15) * cm for i, c in enumerate(cols)]
    base = sum(widths)
    day_w = min(1.0 * cm, max(0.55 * cm, (avail - base) / n_days)) if n_days else 0.0
    for i in day_idx:
        widths[i] = day_w
    used = sum(widths)
    if used < avail:
        for i, c in enumerate(cols):
            if c.key in ("employeeName", "department"):
                widths[i] += (avail - used) / 2
    elif used > avail:
        widths = [w * avail / used for w in widths]

    s_head = style("h", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=6.4, leading=7.6)
    s_head_sun = style("hs", fontName=bold, alignment=TA_CENTER, textColor=colors.HexColor("#9F1239"), fontSize=6.4)
    s_note = style("n", fontSize=7, leading=9, textColor=MUTED)

    story: list = list(letterhead(co, avail, regular, bold, style))
    right = f"{display_date(ctx.date_from)} to {display_date(ctx.date_to)}" if ctx.date_from and ctx.date_to else ""
    story.append(title_bar(out.spec.title.upper(), right, avail, bold, style))
    story.append(filter_box(out.filters, avail, style))
    story.append(Spacer(1, 4))
    strip = kpi_strip(out.summary, avail, bold, style, rupee_ok)
    if strip is not None:
        story += [strip, Spacer(1, 4)]

    def head(i, c):
        if i in day_idx:
            num, _, wd = c.label.partition(" ")
            return Paragraph(f"{escape(num)}<br/>{escape(wd)}", s_head_sun if _is_sunday_key(c.key) else s_head)
        return Paragraph(escape(c.label), s_head)

    text_cols = [i for i, c in enumerate(cols) if c.key in ("employeeCode", "employeeName", "department")]
    data: list[list] = [[head(i, c) for i, c in enumerate(cols)]]
    cmds: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("FONTNAME", (0, 1), (-1, -1), regular),
        ("FONTSIZE", (0, 1), (-1, -1), size),
        ("LEADING", (0, 1), (-1, -1), size * 1.2),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.25, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6),
    ]
    for i in day_idx:
        cmds.append(("FONTSIZE", (i, 1), (i, -1), size - 0.8))  # '2.72*' must fit a day column
        if _is_sunday_key(cols[i].key):
            cmds.append(("BACKGROUND", (i, 0), (i, 0), colors.HexColor("#" + SUNDAY_HEAD)))
    for i in range(len(cols)):
        cmds.append(("ALIGN", (i, 1), (i, -1), "LEFT" if i in text_cols else "CENTER"))
    for row in out.rows:
        idx = len(data)
        kind = row.get("_kind")
        cells = []
        for i, c in enumerate(cols):
            v = row.get(c.key)
            if i in day_idx:
                cells.append("-" if v in (None, "") else str(v))
            elif i in text_cols:
                cells.append(_fit("" if v is None else str(v), widths[i], bold if kind else regular, size))
            else:
                cells.append("" if kind and v is None else pdf_text(c, v, rupee_ok))
        data.append(cells)
        if kind:
            cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
            cmds.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#" + TOTAL_FILL)))
            continue
        for i in day_idx:
            fill = grid_fill(row.get(cols[i].key))
            if fill:
                cmds.append(("BACKGROUND", (i, idx), (i, idx), colors.HexColor("#" + fill)))
    if out.totals:
        idx = len(data)
        cells, placed = [], False
        for c in cols:
            v = out.totals.get(c.key)
            if v is None:
                cells.append("TOTAL" if c.key == "employeeName" and not placed else "")
                placed = placed or c.key == "employeeName"
            else:
                cells.append(pdf_text(c, v, rupee_ok))
        data.append(cells)
        cmds += [
            ("FONTNAME", (0, idx), (-1, idx), bold),
            ("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#DCE6F2")),
            ("LINEABOVE", (0, idx), (-1, idx), 0.9, BRAND),
        ]
    if len(data) == 1:
        story.append(
            Paragraph("No records match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED))
        )
    else:
        table = Table(data, colWidths=widths, repeatRows=1, splitByRow=1)
        table.setStyle(TableStyle(cmds))
        story.append(table)

    story.append(Spacer(1, 6))
    legend_cells: list = []
    legend_w: list[float] = []
    legend_cmds: list[tuple] = [
        ("FONTNAME", (0, 0), (-1, -1), regular),
        ("FONTSIZE", (0, 0), (-1, -1), 6.3),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    for n, (code, label) in enumerate(GRID_LEGEND):
        legend_cells += [code, label]
        legend_w += [1.0 * cm, avail / len(GRID_LEGEND) - 1.0 * cm]
        fill = grid_fill(code)
        if fill:
            legend_cmds.append(("BACKGROUND", (2 * n, 0), (2 * n, 0), colors.HexColor("#" + fill)))
        legend_cmds += [("FONTNAME", (2 * n, 0), (2 * n, 0), bold), ("ALIGN", (2 * n, 0), (2 * n, 0), "CENTER")]
    legend = Table([legend_cells], colWidths=legend_w, hAlign="LEFT")
    legend.setStyle(TableStyle(legend_cmds))
    story.append(legend)
    if out.truncated:
        story.append(Spacer(1, 4))
        story.append(
            Paragraph(f"<b>Note:</b> only the first {out.row_count:,} rows are printed; narrow the filters.", s_note)
        )
    for note in out.notes:
        story += [Spacer(1, 2), Paragraph(escape(note), s_note)]

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
    frame = Frame(margin, 1.5 * cm, avail, page[1] - margin - 1.5 * cm, id="body", leftPadding=0, rightPadding=0)
    doc.addPageTemplates([PageTemplate(id="grid", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(story, canvasmaker=numbered_canvas(f"{co.name} - {out.spec.title}  |  {stamp}", regular, margin))
    return buf.getvalue()


register(
    ReportSpec(
        id="gained-shift-report",
        title="Gained Shift Report",
        description="Shifts earned per employee and day over a period, staff and production, with totals, paid "
        "credits, quarter days, penalty deductions and compensation balance credits.",
        category=CATEGORY,
        modules=SHIFT_MODULES,
        icon="CalendarCheck",
        tags=("shift", "gained", "earned", "shifts earned", "quarter", "production", "staff", "day wise", "credit"),
        filters=(
            F.date_range("thisMonth", label="Period", max_days=GAINED_MAX_DAYS),
            *F.scope(status="active"),
        ),
        columns=(),
        run=_gained_run,
        xlsx_builder=build_grid_xlsx,
        pdf_builder=build_grid_pdf,
        pdf_max_rows=2_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  shift-change-history
# ═════════════════════════════════════════════════════════════════════════════

CH_NEW, CH_CHANGED, CH_TIMINGS, CH_SAME, CH_CANCELLED, CH_SPECIAL = (
    "new",
    "changed",
    "timings",
    "same",
    "cancelled",
    "special",
)
CHANGE_OPTIONS = (
    (CH_CHANGED, "Shift changed"),
    (CH_NEW, "New assignment"),
    (CH_TIMINGS, "Timings / Saturday off changed"),
    (CH_SAME, "Same shift again"),
    (CH_CANCELLED, "Cancelled before it started"),
    (CH_SPECIAL, "Production special shift"),
)
CHANGE_LABEL = dict(CHANGE_OPTIONS)
BASIS_OPTIONS = (("effective", "Took effect in the period"), ("recorded", "Recorded in the period"))

HISTORY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("employmentType", "Type", BADGE, 1.0),
    ColumnSpec("effectiveFrom", "Effective from", DATE, 1.2),
    ColumnSpec("effectiveTo", "Effective to", DATE, 1.2),
    ColumnSpec("change", "Change", BADGE, 1.5),
    ColumnSpec("fromShift", "From shift", TEXT, 1.6),
    ColumnSpec("toShift", "To shift", TEXT, 1.6),
    ColumnSpec("timings", "Timings", TEXT, 1.2),
    ColumnSpec("saturdayOff", "Saturday off", BADGE, 0.9),
    ColumnSpec("assignedBy", "Changed by", TEXT, 1.5),
    ColumnSpec("recordedAt", "Recorded on", DATETIME, 1.4),
    ColumnSpec("notes", "Notes", TEXT, 2.0),
)


def _timings(a) -> str | None:
    start = a.custom_start_time or a.shift.start_time
    end = a.custom_end_time or a.shift.end_time
    text = f"{hm(start)}-{hm(end)}" if start and end else None
    return f"{text} (custom)" if text and (a.custom_start_time or a.custom_end_time) else text


def _valid(a) -> bool:
    """An assignment closed before it started (how Manage Shifts cancels a scheduled one) covers no day."""
    return a.effective_to is None or a.effective_to >= a.effective_from


def _change_of(a, previous) -> str:
    if not _valid(a):
        return CH_CANCELLED
    if previous is None:
        return CH_NEW
    if previous.shift_id != a.shift_id:
        return CH_CHANGED
    same_times = (previous.custom_start_time, previous.custom_end_time) == (a.custom_start_time, a.custom_end_time)
    if not same_times or bool(previous.saturday_off) != bool(a.saturday_off):
        return CH_TIMINGS
    return CH_SAME


def _in_period(value: dt.date | None, d_from: dt.date, d_to: dt.date) -> bool:
    return value is not None and d_from <= value <= d_to


def _ist_day(value) -> dt.date | None:
    text = fmt_dt(value)
    return dt.date.fromisoformat(text[:10]) if text else None


def _history_run(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    recorded = ctx.params.get("basis") == "recorded"
    want = ctx.params.get("change")
    emps = {e.id: e for e in ctx.employees()}

    per_emp: dict[int, list] = defaultdict(list)
    for a in (
        EmployeeShiftAssignment.objects.filter(ctx.emp_q("employee__"))
        .select_related("shift")
        .order_by("employee_id", "effective_from", "id")
    ):
        if a.employee_id in emps:
            per_emp[a.employee_id].append(a)

    built: list[tuple] = []
    for emp_id, lst in per_emp.items():
        emp = emps[emp_id]
        valid = [x for x in lst if _valid(x)]
        for a in lst:
            when = _ist_day(a.created_at) if recorded else a.effective_from
            if not _in_period(when, d_from, d_to):
                continue
            # Re-saved for the same start date (a bulk assignment closes the old one on the new one's first day): the one
            # it replaced is the previous; otherwise the one in force the day before.
            same_start = [x for x in valid if x.effective_from == a.effective_from and x.id < a.id]
            others = [x for x in valid if x.id != a.id]
            previous = (
                same_start[-1]
                if same_start
                else _get_assignment_for_date(None, a.effective_from - dt.timedelta(days=1), assignments=others)
            )
            change = _change_of(a, previous)
            if want and change != want:
                continue
            built.append(
                (
                    a.effective_from,
                    emp_sort_key(emp),
                    a.id,
                    {
                        **emp_cells(emp),
                        "employmentType": type_text(emp),
                        "effectiveFrom": a.effective_from.isoformat(),
                        "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
                        "change": CHANGE_LABEL[change],
                        "fromShift": previous.shift.name if previous is not None else None,
                        "toShift": a.shift.name,
                        "timings": _timings(a),
                        "saturdayOff": "Yes" if a.saturday_off else "No",
                        "assignedBy": (a.assigned_by or "").strip() or None,
                        "recordedAt": fmt_dt(a.created_at),
                        "notes": (a.notes or "").strip() or None,
                    },
                )
            )

    if not want or want == CH_SPECIAL:
        specials = (
            ProductionSpecialShiftAssignment.objects.filter(ctx.emp_q("employee__"))
            .select_related("group")
            .order_by("employee_id", "effective_from", "id")
        )
        for s in specials:
            emp = emps.get(s.employee_id)
            when = _ist_day(s.created_at) if recorded else s.effective_from
            if emp is None or not _in_period(when, d_from, d_to):
                continue
            g = s.group
            built.append(
                (
                    s.effective_from,
                    emp_sort_key(emp),
                    -s.id,
                    {
                        **emp_cells(emp),
                        "employmentType": type_text(emp),
                        "effectiveFrom": s.effective_from.isoformat(),
                        "effectiveTo": s.effective_to.isoformat() if s.effective_to else None,
                        "change": CHANGE_LABEL[CH_SPECIAL],
                        "fromShift": "Shift table (default groups)",
                        "toShift": g.label,
                        "timings": f"{hm(g.start_time)}-{hm(g.main_out_time)}" if g.main_out_time else hm(g.start_time),
                        "saturdayOff": None,
                        "assignedBy": (s.created_by or "").strip() or None,
                        "recordedAt": fmt_dt(s.created_at),
                        "notes": (s.note or "").strip() or None,
                    },
                )
            )

    built.sort(key=lambda t: t[:3])
    rows = [t[3] for t in built][: ctx.row_limit]
    by = Counter(r["change"] for r in rows)
    summary = [
        {"label": "Changes listed", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Shift changed", "value": by[CHANGE_LABEL[CH_CHANGED]], "format": "integer"},
        {"label": "New assignments", "value": by[CHANGE_LABEL[CH_NEW]], "format": "integer"},
        {"label": "Cancelled", "value": by[CHANGE_LABEL[CH_CANCELLED]], "format": "integer"},
        {"label": "Production special shifts", "value": by[CHANGE_LABEL[CH_SPECIAL]], "format": "integer"},
    ]
    notes = [
        "One line per shift assignment saved for the employee: From shift is the assignment that was in force the day "
        "before it took effect (the attendance engine's rule: of the assignments covering a day, the latest start "
        "wins), or the one it replaced when both start on the same day. New assignment = nothing was in force before.",
        "Changed by and Recorded on are what the assignment itself keeps (who saved it and when). Ending an assignment "
        "(setting its Effective to) is not recorded separately, so who closed an older assignment is not known.",
        "Cancelled before it started = an assignment scheduled for later and then replaced (Manage Shifts keeps it with "
        "an end before its start, so it never applied to any day).",
        "Production special shifts (Manage Shifts) replace the shift-table groups for the dates they cover.",
    ]
    notes.append(
        "Listed by the date the change was recorded (IST)."
        if recorded
        else "Listed by the date the change took effect; pick 'Recorded in the period' to audit when changes were saved."
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="shift-change-history",
        title="Shift Change History",
        description="Every shift assignment change in a period: from shift to shift, effective dates, timings, "
        "Saturday off, who saved it and when, with production special shifts.",
        category=CATEGORY,
        modules=SHIFT_MODULES,
        icon="History",
        tags=("shift", "change", "history", "audit", "assignment", "reassign", "special shift"),
        filters=(
            F.date_range("thisMonth", label="Changes between", max_days=1096),
            *F.scope(designation=False, status="all"),
            F.select("basis", "Date basis", BASIS_OPTIONS, default="effective", placeholder="Took effect"),
            F.select("change", "Change", CHANGE_OPTIONS, placeholder="All changes"),
        ),
        columns=HISTORY_COLS,
        run=_history_run,
    )
)
