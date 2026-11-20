"""The Salary Statement of the standalone slips: the selected employees' SAVED slips as one sheet, PDF or Excel.

Staff first, then production, each section grouped by unit and department with a sub total per department, a section
total and, when both sections are there, a grand total. The staff columns follow the owner's Salary Statement (Basic /
Other Allowance / Total Salary | Present / CL / HD / Total Days / LOP / Company Days | Earned Salary | PF / ESI / TDS /
Advance / Others / Total Deduction | NET | Remarks). Remarks: HOLD (this page's Hold), NEW JOINER, INACTIVE.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from ..models import PayrollSettings, StandaloneSalarySlip
from ..unit_labels import unit_label
from . import engine, service

ZERO = Decimal("0")

# (key, header, kind) kind: text | days | money
STAFF_COLUMNS = [
    ("sno", "S.No", "text"),
    ("code", "Code", "text"),
    ("name", "Name", "text"),
    ("designation", "Designation", "text"),
    ("basic", "Basic (50%)", "money"),
    ("otherAllowance", "Other Allowance", "money"),
    ("totalSalary", "Total Salary", "money"),
    ("present", "Present", "days"),
    ("cl", "CL", "days"),
    ("hd", "HD", "days"),
    ("totalDays", "Total Days", "days"),
    ("lop", "LOP", "days"),
    ("companyDays", "Company Days", "days"),
    ("earned", "Earned Salary", "money"),
    ("pf", "PF", "money"),
    ("esi", "ESI", "money"),
    ("tds", "TDS", "money"),
    ("advance", "Advance", "money"),
    ("others", "Others", "money"),
    ("totalDeduction", "Total Deduction", "money"),
    ("net", "NET", "money"),
    ("remarks", "Remarks", "text"),
]
PRODUCTION_COLUMNS = [
    ("sno", "S.No", "text"),
    ("code", "Code", "text"),
    ("name", "Name", "text"),
    ("designation", "Designation", "text"),
    ("salaryPerShift", "Rate / Shift", "money"),
    ("daysWorked", "Days Worked", "days"),
    ("absent", "Absent", "days"),
    ("shifts", "Shifts", "days"),
    ("earned", "Earned Salary", "money"),
    ("pf", "PF", "money"),
    ("esi", "ESI", "money"),
    ("tds", "TDS", "money"),
    ("advance", "Advance", "money"),
    ("others", "Late", "money"),
    ("totalDeduction", "Total Deduction", "money"),
    ("net", "NET", "money"),
    ("remarks", "Remarks", "text"),
]
# columns added up in the sub totals (salary rates are not added up)
STAFF_SUMS = {
    "basic",
    "otherAllowance",
    "totalSalary",
    "earned",
    "pf",
    "esi",
    "tds",
    "advance",
    "others",
    "totalDeduction",
    "net",
}
PRODUCTION_SUMS = {"shifts", "earned", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net"}


@dataclass
class Line:
    kind: str  # "heading" | "row" | "subtotal" | "total"
    label: str = ""
    values: dict = field(default_factory=dict)


@dataclass
class Section:
    title: str
    columns: list
    sums: set
    lines: list
    count: int
    totals: dict


def _dec(value) -> Decimal:
    return Decimal(str(value or 0))


def _section(
    title: str,
    columns,
    sums,
    slips: list[StandaloneSalarySlip],
    held: set[int],
    month: int,
    year: int,
    several_units: bool,
) -> Section | None:
    if not slips:
        return None

    def group_key(s):
        emp = s.employee
        unit = (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else ""
        dept = emp.department.name if emp.department_id and emp.department else "No department"
        return (unit, dept)

    slips = sorted(slips, key=lambda s: (group_key(s), s.employee.employee_code))
    lines: list[Line] = []
    grand = {k: ZERO for k in sums}
    sno = 0
    current = None
    sub = None
    for s in slips:
        key = group_key(s)
        if key != current:
            if sub is not None:
                lines.append(Line("subtotal", "Sub total", sub))
            current = key
            sub = {k: ZERO for k in sums}
            unit, dept = key
            lines.append(Line("heading", f"{dept} ({unit})" if several_units and unit else dept))
        emp = s.employee
        statement = (s.figures or {}).get("statement") or {}
        sno += 1
        values = {
            "sno": sno,
            "code": emp.employee_code,
            "name": engine.full_name(emp),
            "designation": emp.designation.title if emp.designation_id and emp.designation else "",
            "remarks": service.remarks_for(emp, month, year, emp.id in held),
        }
        for key_, _h, kind in columns:
            if kind != "text":
                values[key_] = statement.get(key_, 0)
        for k in sums:
            sub[k] += _dec(values.get(k))
            grand[k] += _dec(values.get(k))
        lines.append(Line("row", values=values))
    if sub is not None:
        lines.append(Line("subtotal", "Sub total", sub))
    lines.append(Line("total", f"{title} total", grand))
    return Section(title, columns, sums, lines, len(slips), grand)


def build_sections(slips: list[StandaloneSalarySlip], held: set[int], month: int, year: int) -> list[Section]:
    units = {s.employee.branch_id for s in slips}
    several = len(units) > 1
    staff = [s for s in slips if (s.figures or {}).get("kind") != engine.KIND_PRODUCTION]
    production = [s for s in slips if (s.figures or {}).get("kind") == engine.KIND_PRODUCTION]
    sections = [
        _section("Staff", STAFF_COLUMNS, STAFF_SUMS, staff, held, month, year, several),
        _section("Production", PRODUCTION_COLUMNS, PRODUCTION_SUMS, production, held, month, year, several),
    ]
    return [s for s in sections if s is not None]


def summary(sections: list[Section]) -> dict:
    out = {"employees": 0, "earned": ZERO, "deductions": ZERO, "net": ZERO}
    for sec in sections:
        out["employees"] += sec.count
        out["earned"] += sec.totals.get("earned", ZERO)
        out["deductions"] += sec.totals.get("totalDeduction", ZERO)
        out["net"] += sec.totals.get("net", ZERO)
    return out


def _company() -> str:
    ps = PayrollSettings.get()
    return (ps.slip_company_name or ps.company_name or "UK TEXTILES").upper()


def _fmt(value, kind: str) -> str:
    if kind == "text":
        return "" if value is None else str(value)
    d = _dec(value)
    if kind == "days":
        return str(int(d)) if d == d.to_integral_value() else f"{d.normalize():f}"
    return f"{d:,.2f}"


# ───────────────────────────── PDF ─────────────────────────────


def build_pdf(slips, held, month: int, year: int) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from ..document_pdf import FONT_BODY, FONT_BODY_BOLD

    sections = build_sections(slips, held, month, year)
    totals = summary(sections)
    period = f"{engine.MONTHS[month]} {year}"
    buffer = io.BytesIO()
    page = landscape(A3)
    doc = SimpleDocTemplate(
        buffer,
        pagesize=page,
        leftMargin=1 * cm,
        rightMargin=1 * cm,
        topMargin=1 * cm,
        bottomMargin=1 * cm,
        title=f"Salary Statement {period}",
    )
    title_style = ParagraphStyle("T", fontName=FONT_BODY_BOLD, fontSize=15, leading=19)
    sub_style = ParagraphStyle("S", fontName=FONT_BODY, fontSize=9, leading=12, textColor=colors.HexColor("#4b5563"))
    cell = ParagraphStyle("C", fontName=FONT_BODY, fontSize=8, leading=10)
    head = ParagraphStyle("H", fontName=FONT_BODY_BOLD, fontSize=7.5, leading=9, textColor=colors.white)
    band = colors.HexColor("#0E4B3A")
    story = [
        Paragraph(f"{_company()} - Salary Statement {period}", title_style),
        Paragraph(
            f"From the standalone salary slips (Salary Slip page), not the payroll. Amounts in Rs. "
            f"Printed {datetime.now().strftime('%d-%m-%Y %H:%M')}.",
            sub_style,
        ),
        Spacer(1, 0.35 * cm),
    ]
    usable = page[0] - 2 * cm
    for n, sec in enumerate(sections):
        if n:
            story.append(PageBreak())
        story.append(
            Paragraph(
                f"{sec.title} ({sec.count})", ParagraphStyle("ST", fontName=FONT_BODY_BOLD, fontSize=12, leading=15)
            )
        )
        story.append(Spacer(1, 0.2 * cm))
        widths = _pdf_widths(sec.columns, usable)
        data = [[Paragraph(h, head) for _k, h, _kind in sec.columns]]
        styles = [
            ("BACKGROUND", (0, 0), (-1, 0), band),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
            ("FONTSIZE", (0, 1), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d1d5db")),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ]
        money_cols = [i for i, (_k, _h, kind) in enumerate(sec.columns) if kind != "text"]
        for i in money_cols:
            styles.append(("ALIGN", (i, 1), (i, -1), "RIGHT"))
        for line in sec.lines:
            r = len(data)
            if line.kind == "heading":
                data.append([line.label] + [""] * (len(sec.columns) - 1))
                styles += [
                    ("SPAN", (0, r), (-1, r)),
                    ("FONTNAME", (0, r), (-1, r), FONT_BODY_BOLD),
                    ("BACKGROUND", (0, r), (-1, r), colors.HexColor("#eef2f0")),
                ]
            elif line.kind == "row":
                data.append(
                    [
                        Paragraph(_fmt(line.values.get(k), kind), cell)
                        if k in ("name", "designation", "remarks")
                        else _fmt(line.values.get(k), kind)
                        for k, _h, kind in sec.columns
                    ]
                )
            else:
                row = [line.label] + [
                    _fmt(line.values[k], kind) if k in line.values else "" for k, _h, kind in sec.columns[1:]
                ]
                data.append(row)
                styles += [("SPAN", (0, r), (3, r)), ("FONTNAME", (0, r), (-1, r), FONT_BODY_BOLD)]
                if line.kind == "total":
                    styles.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor("#fdf6e3")))
        table = Table(data, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle(styles))
        story.append(table)
    story.append(Spacer(1, 0.6 * cm))
    cards = [
        ["Employees", "Earned Salary", "Total Deduction", "Net Pay"],
        [
            str(totals["employees"]),
            f"{totals['earned']:,.2f}",
            f"{totals['deductions']:,.2f}",
            f"{totals['net']:,.2f}",
        ],
    ]
    card_table = Table(cards, colWidths=[6 * cm] * 4)
    card_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), FONT_BODY),
                ("FONTNAME", (0, 1), (-1, 1), FONT_BODY_BOLD),
                ("FONTSIZE", (0, 1), (-1, 1), 13),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#4b5563")),
                ("BOX", (0, 0), (-1, -1), 0.6, band),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d1d5db")),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(card_table)
    story.append(Spacer(1, 1.6 * cm))
    sig = Table([["Prepared By", "Checked By", "HRM", "Auditor", "MD"]], colWidths=[usable / 5] * 5)
    sig.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), FONT_BODY_BOLD),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LINEABOVE", (0, 0), (-1, 0), 0.5, colors.HexColor("#6b7280")),
            ]
        )
    )
    story.append(sig)
    doc.build(story)
    return buffer.getvalue()


def _pdf_widths(columns, usable: float) -> list[float]:
    weights = {"sno": 1.0, "code": 1.3, "name": 3.4, "designation": 2.6, "remarks": 2.0}
    raw = [weights.get(k, 1.5 if kind == "money" else 1.35) for k, _h, kind in columns]
    scale = usable / sum(raw)
    return [w * scale for w in raw]


# ───────────────────────────── Excel ─────────────────────────────


def build_xlsx(slips, held, month: int, year: int) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    sections = build_sections(slips, held, month, year)
    totals = summary(sections)
    period = f"{engine.MONTHS[month]} {year}"
    wb = Workbook()
    wb.remove(wb.active)
    thin = Side(style="thin", color="D1D5DB")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill("solid", fgColor="0E4B3A")
    band_fill = PatternFill("solid", fgColor="EEF2F0")
    total_fill = PatternFill("solid", fgColor="FDF6E3")
    if not sections:
        wb.create_sheet("Statement")
    for sec in sections:
        ws = wb.create_sheet(sec.title)
        ncols = len(sec.columns)
        ws.cell(row=1, column=1, value=f"{_company()} - Salary Statement {period} ({sec.title})").font = Font(
            bold=True, size=14
        )
        ws.cell(
            row=2,
            column=1,
            value="From the standalone salary slips (Salary Slip page), not the payroll. Amounts in Rs.",
        )
        ws.cell(row=2, column=1).font = Font(italic=True, color="4B5563")
        header_row = 4
        for i, (_k, h, _kind) in enumerate(sec.columns, start=1):
            c = ws.cell(row=header_row, column=i, value=h)
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = head_fill
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            c.border = border
        r = header_row
        for line in sec.lines:
            r += 1
            if line.kind == "heading":
                ws.cell(row=r, column=1, value=line.label).font = Font(bold=True)
                ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=ncols)
                for i in range(1, ncols + 1):
                    ws.cell(row=r, column=i).fill = band_fill
                continue
            for i, (k, _h, kind) in enumerate(sec.columns, start=1):
                if line.kind == "row":
                    value = line.values.get(k)
                    if kind == "money":
                        value = float(_dec(value))
                    elif kind == "days":
                        d = _dec(value)
                        value = int(d) if d == d.to_integral_value() else float(d)
                elif i == 1:
                    value = line.label
                elif k in line.values:
                    value = float(line.values[k])
                else:
                    value = None
                c = ws.cell(row=r, column=i, value=value)
                c.border = border
                if kind == "money":
                    c.number_format = "#,##0.00"
                if line.kind != "row":
                    c.font = Font(bold=True)
                    if line.kind == "total":
                        c.fill = total_fill
        for i, (k, _h, kind) in enumerate(sec.columns, start=1):
            width = {"sno": 6, "code": 10, "name": 28, "designation": 22, "remarks": 18}.get(
                k, 14 if kind == "money" else 9
            )
            ws.column_dimensions[get_column_letter(i)].width = width
        ws.row_dimensions[header_row].height = 30
        ws.freeze_panes = f"E{header_row + 1}"  # (a string: the cell below may be a merged department band)
        ws.auto_filter.ref = f"A{header_row}:{get_column_letter(ncols)}{r}"
        ws.page_setup.orientation = "landscape"
        ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws = wb.create_sheet("Summary")
    rows = [
        ("Month", period),
        ("Employees", totals["employees"]),
        ("Earned Salary", float(totals["earned"])),
        ("Total Deduction", float(totals["deductions"])),
        ("Net Pay", float(totals["net"])),
    ]
    for i, (label, value) in enumerate(rows, start=1):
        ws.cell(row=i, column=1, value=label).font = Font(bold=True)
        c = ws.cell(row=i, column=2, value=value)
        if isinstance(value, float):
            c.number_format = "#,##0.00"
    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 18
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
