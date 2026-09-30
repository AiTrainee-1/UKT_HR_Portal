"""Excel export: one styled worksheet per report, streamed (openpyxl write-only mode) so
large registers do not hold every cell in memory."""

from __future__ import annotations

import io
import re
from datetime import datetime, time

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.drawing.image import Image as XlImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties

from .branding import company
from .formatting import display_date, parse_date
from .runner import KIND_SUBTOTAL, KIND_TOTAL, RunOutput
from .types import (
    BADGE,
    CURRENCY,
    DATE,
    DATETIME,
    DURATION,
    HOURS,
    INTEGER,
    MINUTES,
    NUMBER,
    PERCENT,
    TEXT,
    TIME,
    ColumnSpec,
)

BRAND = "1E3A5F"
BRAND_SOFT = "E8EEF6"
ZEBRA = "F6F8FB"
SUBTOTAL_FILL = "EEF2F7"
TOTAL_FILL = "DCE6F2"
GRID = "D5DBE3"

# Indian lakh/crore digit grouping with the rupee sign.
_INR = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"##,##0.00'
_FORMATS = {
    CURRENCY: _INR,
    NUMBER: "#,##0.00",
    INTEGER: "#,##0",
    PERCENT: '0.0"%"',
    HOURS: "0.00",
    MINUTES: "#,##0",
    DURATION: "[h]:mm",
    DATE: "dd-mmm-yyyy",
    TIME: "hh:mm",
    DATETIME: "dd-mmm-yyyy hh:mm",
}
_NUMERIC = (CURRENCY, NUMBER, INTEGER, PERCENT, HOURS, MINUTES, DURATION)
_BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")

HEADER_ROW = 7


def sheet_title(title: str) -> str:
    return (_BAD_SHEET_CHARS.sub(" ", title).strip() or "Report")[:31]


def col_width(c: ColumnSpec) -> float:
    return round(min(48.0, max(9.0, c.width * 13.0)), 1)


def _align(c: ColumnSpec) -> str:
    if c.align:
        return c.align
    if c.type in _NUMERIC:
        return "right"
    if c.type in (DATE, TIME, DATETIME, BADGE):
        return "center"
    return "left"


def typed_value(c: ColumnSpec, value):
    """Cell value + whether it must be stored as text. Text is never allowed to become a formula."""
    if value is None or value == "":
        return None
    t = c.type
    if t in _NUMERIC:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return value / 1440.0 if t == DURATION else value
        return str(value)  # a stray label in a numeric column stays visible as text
    if t == DATE:
        return parse_date(value) or str(value)
    if t == TIME:
        text = str(value)[:5]
        try:
            h, m = text.split(":")
            return time(int(h), int(m))
        except ValueError:
            return text
    if t == DATETIME:
        text = str(value)
        try:
            return datetime.strptime(text[:16], "%Y-%m-%d %H:%M")
        except ValueError:
            return text
    return str(value)


def safe_cell(value):
    """Strip control characters openpyxl refuses (they raise IllegalCharacterError)."""
    if isinstance(value, str):
        return ILLEGAL_CHARACTERS_RE.sub("", value)
    return value


def build_xlsx(out: RunOutput) -> bytes:
    spec, cols = out.spec, out.columns
    co = company()
    n_cols = max(1, len(cols))

    wb = Workbook(write_only=True)
    wb.properties.creator = "UKTextiles HRMS"
    wb.properties.title = spec.title
    ws = wb.create_sheet(sheet_title(spec.title))

    for i, c in enumerate(cols, start=1):
        ws.column_dimensions[get_column_letter(i)].width = col_width(c)
    ws.freeze_panes = f"A{HEADER_ROW + 1}"
    ws.sheet_view.showGridLines = False

    # ── shared styles (one instance each -- write-only cells reference them) ──
    thin = Side(style="thin", color=GRID)
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    f_company = Font(name="Calibri", size=15, bold=True, color=BRAND)
    f_sub = Font(name="Calibri", size=10, color="666666")
    f_title = Font(name="Calibri", size=13, bold=True, color="FFFFFF")
    f_head = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
    f_body = Font(name="Calibri", size=10)
    f_bold = Font(name="Calibri", size=10, bold=True)
    f_note = Font(name="Calibri", size=9, italic=True, color="666666")
    fill_brand = PatternFill("solid", fgColor=BRAND)
    fill_zebra = PatternFill("solid", fgColor=ZEBRA)
    fill_sub = PatternFill("solid", fgColor=SUBTOTAL_FILL)
    fill_total = PatternFill("solid", fgColor=TOTAL_FILL)
    fill_soft = PatternFill("solid", fgColor=BRAND_SOFT)

    def text_cell(value, font, fill=None, align="left", wrap=False) -> WriteOnlyCell:
        cell = WriteOnlyCell(ws, value=safe_cell(value))
        cell.data_type = "s"
        cell.font = font
        if fill is not None:
            cell.fill = fill
        cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap)
        return cell

    # ── letterhead ───────────────────────────────────────────────────────────
    if co.logo_png:
        try:
            img = XlImage(io.BytesIO(co.logo_png))
            img.width = img.height = 44
            ws.add_image(img, "A1")
        except Exception:
            pass
    indent = "      " if co.logo_png else ""
    ws.append([text_cell(indent + co.name, f_company)])
    ws.row_dimensions[1].height = 26
    sub = "  |  ".join(b for b in (co.address, co.contact, f"GSTIN {co.gstin}" if co.gstin else "") if b)
    ws.append([text_cell(indent + (sub or co.tagline), f_sub)])
    title_row = [text_cell(spec.title.upper(), f_title, fill_brand)]
    title_row += [text_cell("", f_title, fill_brand) for _ in range(n_cols - 1)]
    ws.append(title_row)
    ws.row_dimensions[3].height = 24
    filt = "   |   ".join(f"{k}: {v}" for k, v in out.filters) or "All records"
    ws.append([text_cell(filt, f_bold, fill_soft)] + [text_cell("", f_bold, fill_soft) for _ in range(n_cols - 1)])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    ws.append([text_cell(stamp, f_note)])
    ws.append([])

    # ── header row ───────────────────────────────────────────────────────────
    ws.append([text_cell(c.label, f_head, fill_brand, "center", wrap=True) for c in cols])
    ws.row_dimensions[HEADER_ROW].height = 30

    # ── data ─────────────────────────────────────────────────────────────────
    # Styling a WriteOnlyCell attribute by attribute costs ~5x more than copying a prebuilt style
    # array, so each (row variant, column) style is built once and reused for every row.
    def template(col: ColumnSpec, font, fill) -> object:
        cell = WriteOnlyCell(ws, value=0)
        fmt = _FORMATS.get(col.type)
        if fmt:
            cell.number_format = fmt
        cell.font = font
        cell.border = border
        if fill is not None:
            cell.fill = fill
        cell.alignment = Alignment(horizontal=_align(col), vertical="center", wrap_text=col.type == TEXT)
        return cell._style

    variants = {
        "plain": (f_body, None),
        "zebra": (f_body, fill_zebra),
        KIND_SUBTOTAL: (f_bold, fill_sub),
        KIND_TOTAL: (f_bold, fill_total),
    }
    styles = {(v, i): template(c, *variants[v]) for v in variants for i, c in enumerate(cols)}

    data_count = 0
    for r in out.rows:
        kind = r.get("_kind")
        if kind in (KIND_SUBTOTAL, KIND_TOTAL):
            variant = kind
        else:
            data_count += 1
            variant = "zebra" if data_count % 2 == 0 else "plain"
        cells = []
        for i, c in enumerate(cols):
            cell = WriteOnlyCell(ws, value=safe_cell(typed_value(c, r.get(c.key))))
            cell._style = styles[(variant, i)]
            if isinstance(cell.value, str):
                cell.data_type = "s"  # never a formula, even if it starts with = + - @
            cells.append(cell)
        ws.append(cells)

    # ── totals ───────────────────────────────────────────────────────────────
    if out.totals:
        cells = []
        placed_label = False
        for c in cols:
            v = out.totals.get(c.key)
            if v is None:
                label = "" if placed_label else "TOTAL"
                placed_label = True
                cell = text_cell(label, f_bold, fill_total, "left")
            else:
                cell = WriteOnlyCell(ws, value=(v / 1440.0 if c.type == DURATION else v))
                fmt = _FORMATS.get(c.type)
                if fmt:
                    cell.number_format = fmt
                cell.font = f_bold
                cell.fill = fill_total
                cell.alignment = Alignment(horizontal="right", vertical="center")
            cell.border = border
            cells.append(cell)
        ws.append(cells)

    # ── notes ────────────────────────────────────────────────────────────────
    if out.truncated:
        ws.append([])
        ws.append(
            [text_cell(f"Showing the first {out.row_count:,} rows only - narrow the filters to see the rest.", f_note)]
        )
    if out.notes:
        ws.append([])
        for n in out.notes:
            ws.append([text_cell(n, f_note)])

    # ── sheet furniture ──────────────────────────────────────────────────────
    if data_count:
        ws.auto_filter.ref = f"A{HEADER_ROW}:{get_column_letter(n_cols)}{HEADER_ROW + len(out.rows)}"
    ws.print_title_rows = f"{HEADER_ROW}:{HEADER_ROW}"
    ws.page_setup.orientation = "landscape" if spec.landscape else "portrait"
    ws.page_setup.paperSize = 9  # A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.oddFooter.left.text = f"{co.name} - {spec.title}"
    ws.oddFooter.right.text = "Page &P of &N"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
