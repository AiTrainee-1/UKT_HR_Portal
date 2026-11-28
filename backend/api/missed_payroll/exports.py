"""Missed Payroll downloads: the payroll report (Excel), the Salary Statement (PDF / Excel) and the bank file (the bank
template of every payroll bank file), plus one entry's figures for the page's detail panel.

The statement rows come from the Salary Statement's OWN row builder (payroll_statement_views._staff_values /
_production_values) fed with the saved figures, so a missed payroll reads exactly like the month's statement row it
becomes on Done. The bank file pays only entries marked Done and not yet paid, with a bank account and an IFSC code, at the
NET (a whole rupee already, the engines round it up).
"""

from __future__ import annotations

import io
from datetime import datetime
from decimal import Decimal

from ..models import MissedPayroll, Payroll, PayrollSettings, SalarySlip
from ..payroll_insights import breakdown_of, casual_leave_days, money_lines, plain
from ..payroll_statement_views import _production_values, _staff_values, production_columns, staff_columns
from ..salary_slip_center import bank_file as slip_bank
from . import engine, lists

STATUS_TEXT = {
    MissedPayroll.STATUS_GENERATED: "GENERATED",
    MissedPayroll.STATUS_CLEARED: "CLEARED",
    MissedPayroll.STATUS_DONE: "DONE",
    MissedPayroll.STATUS_PAID: "PAID",
}
CATEGORY_TEXT = {k: v.upper() for k, v in lists.CATEGORY_LABELS.items()}


def objects(entry: MissedPayroll) -> tuple[Payroll, SalarySlip]:
    """The saved figures as (unsaved) Payroll and SalarySlip objects, as the engine made them."""
    figures = entry.figures or {}
    payroll = Payroll(employee=entry.employee, **engine.restore(Payroll, figures.get("payroll")))
    slip = SalarySlip(employee=entry.employee, **engine.restore(SalarySlip, figures.get("slip")))
    return payroll, slip


def detail_json(entry: MissedPayroll) -> dict:
    payroll, slip = objects(entry)
    bd = breakdown_of(slip)
    earnings, deductions = money_lines(payroll, slip, bd)
    summary = (bd or {}).get("summary") or {}
    return {
        "entry": lists.entry_json(entry),
        "employee": {
            "id": entry.employee_id,
            "code": entry.employee.employee_code,
            "name": lists._name(entry.employee),
        },
        "kind": entry.kind,
        "month": entry.month,
        "year": entry.year,
        "periodStart": payroll.period_start.isoformat() if payroll.period_start else None,
        "periodEnd": payroll.period_end.isoformat() if payroll.period_end else None,
        "earnings": earnings,
        "deductions": deductions,
        "statement": statement_values([entry])[entry.id],
        "summary": summary,
        "days": (bd or {}).get("days") or [],
        "notes": payroll.notes,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Statement rows
# ─────────────────────────────────────────────────────────────────────────────


def statement_values(entries: list[MissedPayroll]) -> dict[int, dict]:
    """entry id -> the statement row of its saved figures (plus the page's own status)."""
    out: dict[int, dict] = {}
    staff = [e for e in entries if e.kind == engine.KIND_STAFF]
    cl: dict[tuple[int, int], dict] = {}
    for e in staff:
        cl.setdefault((e.year, e.month), {})
    for (year, month), _ in cl.items():
        cl[(year, month)] = casual_leave_days(
            [e.employee_id for e in staff if (e.year, e.month) == (year, month)], year, month
        )
    for entry in entries:
        payroll, slip = objects(entry)
        bd = breakdown_of(slip)
        start, end = engine.month_bounds(entry.month, entry.year)
        if entry.kind == engine.KIND_STAFF:
            values = _staff_values(
                payroll, slip, bd, cl[(entry.year, entry.month)].get(entry.employee_id, {}), start, end
            )
        else:
            values = _production_values(payroll, slip, bd, start, end)
        values["status"] = STATUS_TEXT.get(entry.status, entry.status.upper())
        values["category"] = CATEGORY_TEXT.get(entry.category, entry.category.upper())
        out[entry.id] = values
    return out


def _columns(kind: str) -> list[dict]:
    cols = staff_columns() if kind == engine.KIND_STAFF else production_columns()
    return cols + [
        {"key": "category", "label": "Why missed", "format": "text", "total": False},
        {"key": "status", "label": "Status", "format": "text", "total": False},
    ]


def _fmt(value, fmt: str) -> str:
    if value is None or value == "":
        return ""
    if fmt == "money":
        return f"{Decimal(str(value)):,.2f}"
    if fmt == "days":
        return plain(value)
    return str(value)


def _groups(entries: list[MissedPayroll], values: dict[int, dict]) -> list[tuple[str, list[MissedPayroll]]]:
    def key(e):
        emp = e.employee
        unit = lists._unit(emp)
        dept = emp.department.name if emp.department_id and emp.department else "No department"
        return unit, dept

    several_units = len({lists._unit(e.employee) for e in entries}) > 1
    ordered = sorted(entries, key=lambda e: (key(e), e.employee.employee_code))
    groups: list[tuple[str, list[MissedPayroll]]] = []
    for e in ordered:
        unit, dept = key(e)
        title = f"{dept} ({unit})" if several_units and unit else dept
        if not groups or groups[-1][0] != title:
            groups.append((title, []))
        groups[-1][1].append(e)
    return groups


def _sums(rows: list[dict], columns: list[dict]) -> dict:
    out = {}
    for c in columns:
        if c.get("total"):
            out[c["key"]] = sum((Decimal(str(r.get(c["key"]) or 0)) for r in rows), Decimal("0"))
    return out


def _company() -> str:
    ps = PayrollSettings.objects.filter(pk=1).first()  # read-only: a download never creates the settings row
    name = (getattr(ps, "slip_company_name", "") or getattr(ps, "company_name", "")) if ps else ""
    return (name or "UK TEXTILES").upper()


def build_statement_xlsx(entries: list[MissedPayroll], kind: str, month: int, year: int) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    columns = _columns(kind)
    values = statement_values(entries)
    wb = Workbook()
    ws = wb.active
    ws.title = "Salary Statement"
    period = engine.label(month, year)
    ws.append(
        [f"{_company()} - Missed Payroll Salary Statement ({'Staff' if kind == 'staff' else 'Production'}) {period}"]
    )
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([f"Printed {datetime.now():%d-%m-%Y %H:%M}. Amounts in Rs."])
    ws.append([])
    ws.append([c["label"] for c in columns])
    band = PatternFill("solid", fgColor="0E4B3A")
    for cell in ws[4]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = band
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sno = 0
    all_rows = []
    for title, group in _groups(entries, values):
        ws.append([title])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
        rows = []
        for e in group:
            sno += 1
            row = {**values[e.id], "sno": sno}
            rows.append(row)
            ws.append(
                [
                    float(row[c["key"]])
                    if c["format"] == "money" and row.get(c["key"]) is not None
                    else row.get(c["key"])
                    for c in columns
                ]
            )
        sub = _sums(rows, columns)
        ws.append(["Sub total"] + [float(sub[c["key"]]) if c["key"] in sub else None for c in columns[1:]])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
        all_rows += rows
    total = _sums(all_rows, columns)
    ws.append(["Total"] + [float(total[c["key"]]) if c["key"] in total else None for c in columns[1:]])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    for i, c in enumerate(columns, start=1):
        letter = ws.cell(row=4, column=i).column_letter
        ws.column_dimensions[letter].width = 28 if c["key"] in ("name", "remarks") else 14
        if c["format"] == "money":
            for (cell,) in ws.iter_rows(min_row=5, min_col=i, max_col=i):
                cell.number_format = "#,##0.00"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def build_statement_pdf(entries: list[MissedPayroll], kind: str, month: int, year: int) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from ..document_pdf import FONT_BODY, FONT_BODY_BOLD

    columns = _columns(kind)
    values = statement_values(entries)
    period = engine.label(month, year)
    buffer = io.BytesIO()
    page = landscape(A3)
    doc = SimpleDocTemplate(
        buffer,
        pagesize=page,
        leftMargin=1 * cm,
        rightMargin=1 * cm,
        topMargin=1 * cm,
        bottomMargin=1 * cm,
        title=f"Missed Payroll Salary Statement {period}",
    )
    title_style = ParagraphStyle("T", fontName=FONT_BODY_BOLD, fontSize=15, leading=19)
    sub_style = ParagraphStyle("S", fontName=FONT_BODY, fontSize=9, leading=12, textColor=colors.HexColor("#4b5563"))
    cell = ParagraphStyle("C", fontName=FONT_BODY, fontSize=7.5, leading=9)
    head = ParagraphStyle("H", fontName=FONT_BODY_BOLD, fontSize=7, leading=8.5, textColor=colors.white)
    band = colors.HexColor("#0E4B3A")
    kind_label = "Staff" if kind == engine.KIND_STAFF else "Production"
    story = [
        Paragraph(f"{_company()} - Missed Payroll Salary Statement ({kind_label}) {period}", title_style),
        Paragraph(
            "Employees the regular payroll missed, worked out on the Missed Payroll page. Status DONE / PAID: in the "
            f"month's payroll. Amounts in Rs. Printed {datetime.now():%d-%m-%Y %H:%M}.",
            sub_style,
        ),
        Spacer(1, 0.35 * cm),
    ]
    usable = page[0] - 2 * cm
    weights = [float(c.get("weight") or 1.2) for c in columns]
    widths = [w * usable / sum(weights) for w in weights]
    data = [[Paragraph(c["label"], head) for c in columns]]
    styles = [
        ("BACKGROUND", (0, 0), (-1, 0), band),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
        ("FONTSIZE", (0, 1), (-1, -1), 7.5),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d1d5db")),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]
    for i, c in enumerate(columns):
        if c["format"] in ("money", "days", "int") and c["key"] != "sno":
            styles.append(("ALIGN", (i, 1), (i, -1), "RIGHT"))
    sno = 0
    all_rows = []
    for title, group in _groups(entries, values):
        r = len(data)
        data.append([title] + [""] * (len(columns) - 1))
        styles += [
            ("SPAN", (0, r), (-1, r)),
            ("FONTNAME", (0, r), (-1, r), FONT_BODY_BOLD),
            ("BACKGROUND", (0, r), (-1, r), colors.HexColor("#eef2f0")),
        ]
        rows = []
        for e in group:
            sno += 1
            row = {**values[e.id], "sno": sno}
            rows.append(row)
            data.append(
                [
                    Paragraph(_fmt(row.get(c["key"]), c["format"]), cell)
                    if c["key"] in ("name", "designation", "remarks")
                    else _fmt(row.get(c["key"]), c["format"])
                    for c in columns
                ]
            )
        sub = _sums(rows, columns)
        r = len(data)
        data.append(["Sub total"] + [_fmt(sub[c["key"]], c["format"]) if c["key"] in sub else "" for c in columns[1:]])
        styles += [("SPAN", (0, r), (3, r)), ("FONTNAME", (0, r), (-1, r), FONT_BODY_BOLD)]
        all_rows += rows
    total = _sums(all_rows, columns)
    r = len(data)
    data.append(["Total"] + [_fmt(total[c["key"]], c["format"]) if c["key"] in total else "" for c in columns[1:]])
    styles += [
        ("SPAN", (0, r), (3, r)),
        ("FONTNAME", (0, r), (-1, r), FONT_BODY_BOLD),
        ("BACKGROUND", (0, r), (-1, r), colors.HexColor("#fdf6e3")),
    ]
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle(styles))
    story.append(table)
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


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll report
# ─────────────────────────────────────────────────────────────────────────────

REPORT_HEADERS = [
    "Code",
    "Name",
    "Department",
    "Designation",
    "Unit",
    "Employee status",
    "Why missed",
    "Status",
    "Days paid",
    "Present / shifts",
    "Absent",
    "Gross",
    "OT",
    "Excess / bonus",
    "PF",
    "ESI",
    "TDS",
    "Advance",
    "Others",
    "Total deduction",
    "NET",
    "Bank",
    "Generated",
    "Cleared",
    "Done",
    "Paid on",
]


def build_report_xlsx(entries: list[MissedPayroll], kind: str, month: int, year: int) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Missed Payroll"
    ws.append(
        [f"Missed Payroll ({'Staff' if kind == 'staff' else 'Production'}) {engine.label(month, year)} - {_company()}"]
    )
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([f"Printed {datetime.now():%d-%m-%Y %H:%M}. Amounts in Rs."])
    ws.append([])
    ws.append(REPORT_HEADERS)
    for c in ws[4]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="0E4B3A")
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    def stamp(at, by):
        return f"{at:%d-%m-%Y} {by}".strip() if at else ""

    for e in sorted(entries, key=lambda x: x.employee.employee_code):
        payroll, slip = objects(e)
        emp = e.employee
        pay_days = engine.ranges_from_json((e.figures or {}).get("payRanges"))
        from .. import production_coverage as coverage

        ws.append(
            [
                emp.employee_code,
                lists._name(emp),
                emp.department.name if emp.department_id and emp.department else "",
                emp.designation.title if emp.designation_id and emp.designation else "",
                lists._unit(emp),
                (emp.status or "").title(),
                lists.CATEGORY_LABELS.get(e.category, e.category),
                e.get_status_display(),
                coverage.day_count(pay_days) if kind == engine.KIND_PRODUCTION else payroll.total_working_days,
                float(payroll.present_days),
                float(payroll.absent_days),
                float(payroll.gross_salary),
                float(payroll.ot_amount),
                float(payroll.bonus),
                float(slip.pf_deduction),
                float(slip.esi_deduction),
                float(payroll.tds_deduction),
                float(slip.advance_deduction),
                float(slip.other_deductions),
                float(payroll.deductions),
                float(payroll.final_salary),
                lists._bank_issue(emp) or "Ready",
                stamp(e.regenerated_at or e.generated_at, e.generated_by),
                stamp(e.cleared_at, e.cleared_by),
                stamp(e.done_at, e.done_by),
                f"{e.paid_on:%d-%m-%Y}" if e.paid_on else "",
            ]
        )
    for i, h in enumerate(REPORT_HEADERS, start=1):
        ws.column_dimensions[ws.cell(row=4, column=i).column_letter].width = 26 if h in ("Name", "Why missed") else 14
    for row in ws.iter_rows(min_row=5, min_col=12, max_col=21):
        for c in row:
            c.number_format = "#,##0.00"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  Bank file (only Done and not yet paid)
# ─────────────────────────────────────────────────────────────────────────────


def bank_check(entries: list[MissedPayroll]) -> dict:
    included, left_out = [], []
    total = Decimal("0")
    for e in sorted(entries, key=lambda x: x.employee.employee_code):
        emp = e.employee
        base = {"employeeId": emp.id, "code": emp.employee_code, "name": lists._name(emp)}
        if e.status == MissedPayroll.STATUS_PAID:
            reason = "Already marked paid"
        elif e.status != MissedPayroll.STATUS_DONE:
            reason = "Not Done yet: only a payroll marked Done is paid"
        elif lists._bank_issue(emp):
            reason = lists._bank_issue(emp)
        elif e.net <= 0:
            reason = "Net pay is zero"
        else:
            reason = None
        if reason:
            left_out.append({**base, "reason": reason})
            continue
        total += e.net
        included.append({**base, "amount": float(e.net)})
    return {"included": included, "total": float(total), "leftOut": left_out}


def build_bank_xlsx(entries: list[MissedPayroll], sheet: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    result = bank_check(entries)
    paying = {row["employeeId"] for row in result["included"]}
    wb = Workbook()
    ws = wb.active
    ws.title = sheet[:31]
    for i, width in enumerate(slip_bank.WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    green = PatternFill("solid", fgColor="5B8C00")
    for i, text in enumerate(slip_bank.HEADERS, start=1):
        c = ws.cell(row=1, column=i, value=text)
        c.fill = green
        c.font = Font(bold=True, color="FF0000" if i == slip_bank.AMOUNT_COLUMN else "FFFFFF")
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 72
    for i, text in enumerate(slip_bank.INDICATORS, start=1):
        c = ws.cell(row=2, column=i, value=text or None)
        c.fill = green
        c.font = Font(bold=True, color="FFFFFF")
        c.alignment = Alignment(horizontal="center", vertical="center")
    r = 2
    for e in sorted(entries, key=lambda x: x.employee.employee_code):
        emp = e.employee
        if emp.id not in paying:
            continue
        r += 1
        values = [
            "",
            "",
            emp.employee_code or "",
            (emp.bank_account or "").strip().upper(),
            slip_bank.whole_rupees(e.net),
            lists._name(emp).upper(),
            (emp.bank_ifsc or "").strip().upper(),
            (emp.bank_name or "").strip().upper(),
            "",
            "",
        ]
        for i, value in enumerate(values, start=1):
            c = ws.cell(row=r, column=i, value=value)
            c.alignment = Alignment(horizontal="center", vertical="center")
            if i in (3, 4):
                c.number_format = "@"
            if i == slip_bank.AMOUNT_COLUMN:
                c.number_format = "General"  # a whole number, no commas or decimals (2026-11-28)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
