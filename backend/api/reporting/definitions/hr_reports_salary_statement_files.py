"""The Salary Statement's own PDF and Excel files (hr-salary-statement), unit by unit like the Report Log's Late Detection
exports, with bigger type in less space (owner 2026-11-04: "split the records by their units ... increase the font size,
keep the layout, less border spacing, padding and empty space").

PDF, A3 landscape as before: the letterhead, the title band (the month and "Amounts in ₹" on its right), then straight
away the table (no headline figures above it: owner 2026-11-05, "the report should start directly with the column
headers"):

  - per unit a full-width band ("HO – Head Office   119 employees") in the Report Log's indigo;
  - per department a heading line, its rows (zebra) and its Sub total; per unit its total; at the end the TOTAL;
  - one blank row between departments (after a Sub total, before the next department's heading) and before each further
    unit's band (owner 2026-11-05: "leave one empty row before the next department, cleaner and easier to read");
  - the column header repeats on every page; a band never ends a page (it travels with its first department heading and
    row), a sub total never starts one (it travels with the department's last row), and a unit that runs onto the next page
    starts it with a "(contd.)" band that also names the department carrying on;
  - the type size is the largest (10 pt down to 6 pt) at which every figure fits its column on one line: names and
    designations may wrap, numbers never do. Amounts carry no ₹ on every cell (the title band says "Amounts in ₹"), zeros
    are grey so the real figures stand out, and the padding, margins and header block are tight.

Then the notes, and the PF, ESI & TDS details on a page of their own, unit by unit the same way.

Excel: the company block, title and filters as every other export, then the same lines: a merged band per unit, the
department headings, rows, sub totals, unit totals and the TOTAL, with the same blank rows. The Unit column (the last) is filled on every line of a
unit, so filtering it to one unit leaves that unit's statement (band, departments, sub totals, unit total), while filtering
any other column hides the furniture and leaves a clean list. (Filter, do not sort: Excel refuses to sort a range holding
merged cells, the same as the Report Log's file.) The header row and the first three columns (SNO, ID NO, Name) are frozen;
the sheet prints A3 landscape, one page wide. Amounts are real numbers (lakh grouping), days real numbers.

Nothing here works a figure out: every number is the statement's own (``statement_rows`` through ``unit_blocks``); the
sub totals and unit totals add up the same columns the screen's lines do.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XlImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus import Image as RLImage

from ..branding import company
from ..export_pdf import (
    BRAND,
    GRID,
    INK,
    MUTED,
    SUBTOTAL,
    TOTAL,
    ZEBRA,
    _canvas_maker,
    build_pdf,
    ensure_fonts,
)
from ..export_xlsx import build_xlsx, safe_cell, sheet_title, typed_value
from ..formatting import display_date, indian_number
from ..types import CURRENCY, DATE, DATETIME, DURATION, HOURS, INTEGER, MINUTES, NUMBER, PERCENT, TIME, ColumnSpec

# The Report Log's unit band (late.ts UNIT_BAND_COLORS)
UNIT_BG = colors.HexColor("#E0E7FF")
UNIT_INK = colors.HexColor("#312E81")
ZERO_INK = colors.HexColor("#9AA3AF")

# Type sizes tried, largest first; padding (points)
SIZES = (10.0, 9.75, 9.5, 9.25, 9.0, 8.75, 8.5, 8.25, 8.0, 7.75, 7.5, 7.25, 7.0, 6.5, 6.0)
PAD_X = 2.2
PAD_Y = 1.5
# Text columns that may wrap, with the widest they are given before wrapping (in ems of the type size)
WRAP_EMS = {"name": 13.0, "designation": 11.0, "remarks": 8.0, "department": 10.0, "how": 24.0}
MARGIN = 0.8 * cm
FOOTER = 1.1 * cm
_NUMERIC = (CURRENCY, NUMBER, INTEGER, PERCENT, HOURS, MINUTES, DURATION)

BAND, HEADING, ROW, SUB, UNIT_TOTAL, GRAND = "band", "heading", "row", "subtotal", "unit_total", "total"
GAP = "gap"  # a blank row between two departments, or before a further unit's band
_CLOSING = (SUB, UNIT_TOTAL, GRAND)


@dataclass
class Line:
    """One line of a file's table."""

    kind: str
    values: dict = field(default_factory=dict)
    text: str = ""  # the band / heading / closing label
    unit: str = ""  # the unit's short label (the Unit column)
    title: str = ""  # the unit's title, for a "(contd.)" band
    count: int = 0  # a band's number of employees
    zebra: bool = False  # a row on the tinted stripe


# ── Lines ─────────────────────────────────────────────────────────────────────


def _sums(rows: list[dict], keys) -> dict:
    return {k: round(sum(r.get(k) or 0 for r in rows), 2) for k in keys}


def _with_gaps(lines: list[Line]) -> list[Line]:
    """One blank row before a department heading that follows the previous department's Sub total, and before every unit
    band but the first. A Sub total keeps its unit total and the TOTAL right under it."""
    out: list[Line] = []
    for line in lines:
        if out and (line.kind == BAND or (line.kind == HEADING and out[-1].kind == SUB)):
            out.append(Line(GAP, unit=line.unit))
        out.append(line)
    return out


def statement_lines(blocks, sum_keys, grand: dict | None) -> list[Line]:
    """The statement unit by unit: band, departments (heading, rows, Sub total), the unit's total when there are several
    units, then the TOTAL."""
    lines: list[Line] = []
    several = len(blocks) > 1
    employees = 0
    for b in blocks:
        lines.append(Line(BAND, text=b.title, unit=b.label, title=b.title, count=b.count))
        for g in b.groups:
            lines.append(Line(HEADING, text=g["label"], unit=b.label, title=b.title))
            values = [r["values"] for r in g["rows"]]
            for i, v in enumerate(values):
                lines.append(Line(ROW, values=v, unit=b.label, zebra=i % 2 == 1))
            lines.append(Line(SUB, values=_sums(values, sum_keys), text=f"{g['label']} Sub total", unit=b.label))
        employees += b.count
        if several:
            lines.append(Line(UNIT_TOTAL, values=b.total, text=f"{b.title} total", unit=b.label))
    if lines and grand:
        lines.append(Line(GRAND, values=grand, text=_grand_label(employees, len(blocks)), count=employees))
    return _with_gaps(lines)


def _grand_label(employees: int, units: int) -> str:
    people = f"{employees} employee{'' if employees == 1 else 's'}"
    return f"TOTAL   {people} in {units} units" if units > 1 else f"TOTAL   {people}"


def section_lines(section, blocks, sum_keys) -> list[Line]:
    """A further table (the PF, ESI & TDS details) unit by unit: its rows are already in the statement's unit order."""
    titles = {b.label: b.title for b in blocks}
    units: list[tuple[str, list[dict]]] = []
    for r in section.rows:
        unit = r.get("unit") or ""
        if not units or units[-1][0] != unit:
            units.append((unit, []))
        units[-1][1].append(r)
    lines: list[Line] = []
    several = len(units) > 1
    for unit, rows in units:
        title = titles.get(unit, unit)
        lines.append(Line(BAND, text=title, unit=unit, title=title, count=len(rows)))
        for i, r in enumerate(rows):
            lines.append(Line(ROW, values=r, unit=unit, zebra=i % 2 == 1))
        if several:
            lines.append(Line(UNIT_TOTAL, values=_sums(rows, sum_keys), text=f"{title} total", unit=unit))
    if lines and section.totals:
        count = len(section.rows)
        lines.append(Line(GRAND, values=section.totals, text=_grand_label(count, len(units)), count=count))
    return _with_gaps(lines)


def _band_text(line: Line) -> str:
    return f"{line.text}   {line.count} employee{'' if line.count == 1 else 's'}"


# ── PDF ───────────────────────────────────────────────────────────────────────


def _cell_text(c: ColumnSpec, v) -> str:
    """A cell's text: amounts with lakh grouping and no ₹ (the title says it), blanks stay blank."""
    if v is None or v == "":
        return ""
    try:
        if c.type in (CURRENCY, NUMBER):
            return indian_number(float(v))
        if c.type == INTEGER:
            return indian_number(float(v), 0)
        if c.type == PERCENT:
            return f"{float(v):g}%"
    except (TypeError, ValueError):
        return str(v)
    return str(v)


def _is_zero(c: ColumnSpec, v) -> bool:
    return c.type in _NUMERIC and isinstance(v, (int, float)) and not isinstance(v, bool) and float(v) == 0


def _align(c: ColumnSpec) -> str:
    return c.align or ("right" if c.type in _NUMERIC else "center" if c.type in (DATE, TIME, DATETIME) else "left")


class _Band(Paragraph):
    """A unit's band (the first cell of a full-width line); `title` names the unit for a "(contd.)" band."""

    title = ""
    department = ""


class _Heading(Paragraph):
    """A department's heading line."""

    title = ""


class _Closing(Paragraph):
    """The label of a Sub total, a unit total or the TOTAL."""


def _first(cell):
    """The flowable of a table cell (reportlab keeps a flowable cell as a one-item tuple)."""
    return cell[0] if isinstance(cell, (list, tuple)) and cell else cell


class _UnitTable(Table):
    """The statement's table. The column header repeats on every page; when a unit runs onto the next page, that page opens
    with the unit's band again, worded "(contd.)" and naming the department that carries on."""

    contd_style: ParagraphStyle | None = None

    def split(self, availWidth, availHeight):
        self._calc(availWidth, availHeight)
        n = self._getFirstPossibleSplitRowPosition(availHeight)
        band, department = self._carrying_on(n)
        if band is None:
            return super().split(availWidth, availHeight)
        self.repeatRows = (0, band)  # the header and the unit's band are copied to the top of the next part ...
        try:
            parts = super().split(availWidth, availHeight)
        finally:
            self.repeatRows = 1
        if len(parts) == 2:
            first, rest = parts
            first.repeatRows = rest.repeatRows = 1
            original = _first(self._cellvalues[band][0])
            # ... where the band is reworded "(contd.)"
            text = f"<b>{escape(original.title)}</b>&nbsp;&nbsp;(contd.)"
            if department:
                text += f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{escape(department)} (contd.)"
            cell = _Band(text, original.style)
            cell.title = original.title
            cell.department = department
            # the repeated row is the very list the earlier part draws: reword a copy, not the original
            row = list(rest._cellvalues[1])
            row[0] = type(row[0])((cell,))
            rest._cellvalues[1] = row
        return parts

    def _carrying_on(self, n: int) -> tuple[int | None, str]:
        """(the band row of the unit row `n` belongs to, the department carrying on at row `n`) when the next page starts
        inside a unit; (None, "") when it starts a new unit or nothing splits."""
        rows = self._cellvalues
        if n <= 1 or n >= len(rows) or isinstance(_first(rows[n][0]), _Band):
            return None, ""
        department, closed = "", isinstance(_first(rows[n][0]), _Heading)
        for i in range(n - 1, 0, -1):
            cell = _first(rows[i][0])
            if isinstance(cell, _Band):
                if not closed and not department:
                    department = cell.department  # a department running over several pages
                return i, department
            if not closed and not department:
                if isinstance(cell, _Closing):
                    closed = True  # the department ended before the page does
                elif isinstance(cell, _Heading):
                    department = cell.title
        return None, ""


def _two_lines(text: str, font: str, size: float) -> float:
    """The narrowest width that shows `text` on at most two lines (split between words)."""
    words = text.split()
    if len(words) < 2:
        return pdfmetrics.stringWidth(text, font, size)
    return min(
        max(
            pdfmetrics.stringWidth(" ".join(words[:k]), font, size),
            pdfmetrics.stringWidth(" ".join(words[k:]), font, size),
        )
        for k in range(1, len(words))
    )


def _measure(cols, lines, size, regular, bold) -> tuple[list[float], list[float], list[float]]:
    """At type size `size`, in points: (the width each column is given, the narrowest a wrapping column may get - every
    text on two lines at most, the width that shows every text on one line). Numbers never wrap; a header wraps between
    its words."""
    head = max(6.0, size - 0.5)
    measured = [line for line in lines if line.kind == ROW or line.kind in _CLOSING]
    need, floor, full = [], [], []
    for c in cols:
        # 1.5 pt of slack: a word exactly as wide as its cell would still be broken by the paragraph wrapper
        header = max(pdfmetrics.stringWidth(w, bold, head) for w in (c.label.split() or [""])) + 2 * PAD_X + 1.5
        widest = two = 0.0
        for line in measured:
            text = _cell_text(c, line.values.get(c.key))
            if not text:
                continue
            font = regular if line.kind == ROW else bold
            widest = max(widest, pdfmetrics.stringWidth(text, font, size))
            if c.key in WRAP_EMS:
                two = max(two, _two_lines(text, font, size))
        one = max(header, widest + 2 * PAD_X + 0.6)
        if c.key in WRAP_EMS:
            two_lines = max(header, two + 2 * PAD_X + 0.6)
            need.append(max(two_lines, min(one, WRAP_EMS[c.key] * size)))
            floor.append(two_lines)
        else:
            need.append(one)
            floor.append(one)
        full.append(one)
    return need, floor, full


def fit_columns(cols, lines, avail: float, regular: str, bold: str) -> tuple[float, list[float]]:
    """The largest type size at which every column fits the page, and the column widths: numbers keep one line, names and
    designations give way first (never past two lines), and what is left over goes to them first (fewer wrapped lines),
    then to every column alike so the table fills the width."""
    size, widths, full = SIZES[-1], None, None
    for candidate in SIZES:
        need, floor, full = _measure(cols, lines, candidate, regular, bold)
        if sum(need) <= avail:
            size, widths = candidate, need
            break
        if sum(floor) <= avail:
            give = sum(need) - avail
            room = sum(n - f for n, f in zip(need, floor)) or 1
            size, widths = candidate, [n - (n - f) * give / room for n, f in zip(need, floor)]
            break
    if widths is None:  # even the smallest size is too wide: scale to the page
        need, _floor, full = _measure(cols, lines, size, regular, bold)
        return size, [w * avail / sum(need) for w in need]
    extra = avail - sum(widths)
    short = [max(0.0, f - w) for f, w in zip(full, widths)]
    if extra > 0 and sum(short):
        share = min(1.0, extra / sum(short))
        widths = [w + s * share for w, s in zip(widths, short)]
        extra = avail - sum(widths)
    if extra > 0:
        total = sum(widths)
        widths = [w + extra * w / total for w in widths]
    return size, widths


def _table(cols, lines, sum_keys, avail, regular, bold, base_style) -> list:
    """The flowables of one unit-by-unit table."""
    size, widths = fit_columns(cols, lines, avail, regular, bold)
    leading = round(size * 1.2, 2)
    aligns = [_align(c) for c in cols]
    first_sum = min((i for i, c in enumerate(cols) if c.key in sum_keys), default=len(cols))
    label_span = max(1, first_sum)
    label_indent = max(0.0, sum(widths[:2]) - 2 * PAD_X) if label_span > 2 else 0.0

    def style(name, **kw) -> ParagraphStyle:
        return base_style(name, **{"fontSize": size, "leading": leading, **kw})

    s_head = style("uh", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=max(6.0, size - 0.5))
    s_cell = {a: style(f"u{a}", alignment={"left": TA_LEFT, "right": TA_RIGHT}.get(a, TA_CENTER)) for a in aligns}
    s_band = style(
        "ub", fontName=regular, textColor=UNIT_INK, fontSize=size + 1.5, leading=round((size + 1.5) * 1.2, 2)
    )
    s_heading = style("ud", fontName=bold, textColor=BRAND, leftIndent=label_indent)
    s_closing = style("uc", fontName=bold, leftIndent=label_indent)

    data: list[list] = [[Paragraph(escape(c.label), s_head) for c in cols]]
    cmds: list[tuple] = [
        ("FONTNAME", (0, 1), (-1, -1), regular),
        ("FONTSIZE", (0, 1), (-1, -1), size),
        ("LEADING", (0, 1), (-1, -1), leading),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("LINEBELOW", (0, 0), (-1, 0), 0.25, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), PAD_X),
        ("RIGHTPADDING", (0, 0), (-1, -1), PAD_X),
        ("TOPPADDING", (0, 0), (-1, -1), PAD_Y),
        ("BOTTOMPADDING", (0, 0), (-1, -1), PAD_Y),
    ]
    for i, a in enumerate(aligns):
        cmds.append(("ALIGN", (i, 1), (i, -1), a.upper()))

    blank = [""] * len(cols)
    heights: list[float | None] = [None]  # None = as tall as the row's text
    gap = round(leading + 2 * PAD_Y, 2)  # a blank row is as tall as a one-line row
    last_band, last_heading = 0, 0
    for line in lines:
        r = len(data)
        heights.append(gap if line.kind == GAP else None)
        if line.kind == GAP:
            data.append(list(blank))
            cmds.append(("NOSPLIT", (0, r - 1), (-1, r)))  # never opens a page: it stays under the Sub total above it
            continue
        cmds.append(("LINEBELOW", (0, r), (-1, r), 0.25, GRID))
        if line.kind == BAND:
            cell = _Band(
                f"<b>{escape(line.text)}</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{line.count} employee{'' if line.count == 1 else 's'}",
                s_band,
            )
            cell.title = line.text
            data.append([cell, *blank[1:]])
            cmds += [
                ("SPAN", (0, r), (-1, r)),
                ("BACKGROUND", (0, r), (-1, r), UNIT_BG),
                ("LINEBELOW", (0, r), (-1, r), 0.6, UNIT_INK),
                ("TOPPADDING", (0, r), (-1, r), PAD_Y + 1.2),
                ("BOTTOMPADDING", (0, r), (-1, r), PAD_Y + 1.2),
            ]
            last_band = r
        elif line.kind == HEADING:
            cell = _Heading(escape(line.text), s_heading)
            cell.title = line.text
            data.append([cell, *blank[1:]])
            cmds += [("SPAN", (0, r), (-1, r)), ("BACKGROUND", (0, r), (-1, r), SUBTOTAL)]
            last_heading = r
        elif line.kind == ROW:
            row = []
            for i, c in enumerate(cols):
                v = line.values.get(c.key)
                text = _cell_text(c, v)
                if text and pdfmetrics.stringWidth(text, regular, size) > widths[i] - 2 * PAD_X:
                    row.append(Paragraph(escape(text), s_cell[aligns[i]]))
                else:
                    row.append(text)
                if _is_zero(c, v):
                    cmds.append(("TEXTCOLOR", (i, r), (i, r), ZERO_INK))
            data.append(row)
            if line.zebra:
                cmds.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
            # a band or heading never ends a page: it travels with the first row after it
            if last_band and r == last_band + 1:
                cmds.append(("NOSPLIT", (0, last_band), (-1, r)))
            elif last_band and last_heading == r - 1 and last_heading == last_band + 1:
                cmds.append(("NOSPLIT", (0, last_band), (-1, r)))
            elif last_heading == r - 1:
                cmds.append(("NOSPLIT", (0, last_heading), (-1, r)))
        else:  # a Sub total, a unit total or the TOTAL
            row = [
                _Closing(escape(line.text).replace("   ", "&nbsp;&nbsp;&nbsp;&nbsp;"), s_closing),
                *blank[1:label_span],
            ]
            for c in cols[label_span:]:
                row.append(_cell_text(c, line.values.get(c.key)))
            data.append(row)
            fill = SUBTOTAL if line.kind == SUB else TOTAL
            cmds += [
                ("SPAN", (0, r), (label_span - 1, r)),
                ("FONTNAME", (0, r), (-1, r), bold),
                ("BACKGROUND", (0, r), (-1, r), fill),
                ("NOSPLIT", (0, r - 1), (-1, r)),  # never the first line of a page
            ]
            if line.kind == UNIT_TOTAL:
                cmds.append(("LINEABOVE", (0, r), (-1, r), 0.6, BRAND))
            if line.kind == GRAND:
                cmds += [("LINEABOVE", (0, r), (-1, r), 1.0, BRAND), ("LINEBELOW", (0, r), (-1, r), 1.0, BRAND)]
    table = _UnitTable(data, colWidths=widths, rowHeights=heights, repeatRows=1, splitByRow=1)
    table.setStyle(TableStyle(cmds))
    return [table]


def _header(out, avail, regular, bold, rupee_ok, base_style) -> list:
    """The letterhead and the title band (title left; the filters and "Amounts in ₹" right). No headline figures."""
    co = company()
    story: list = []
    name = Paragraph(escape(co.name), base_style("co", fontName=bold, fontSize=13, leading=15, textColor=BRAND))
    sub = "  |  ".join(b for b in (co.address, co.contact, f"GSTIN {co.gstin}" if co.gstin else "") if b)
    head_left = [name] + (
        [Paragraph(escape(sub), base_style("sub", fontSize=7, leading=9, textColor=MUTED))] if sub else []
    )
    logo = None
    if co.logo_png:
        try:
            logo = RLImage(io.BytesIO(co.logo_png), width=1.0 * cm, height=1.0 * cm, kind="proportional")
        except Exception:
            logo = None
    hdr = (
        Table([[logo, head_left]], colWidths=[1.3 * cm, avail - 1.3 * cm])
        if logo
        else Table([[head_left]], colWidths=[avail])
    )
    hdr.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story += [hdr, Spacer(1, 3)]

    filt = "&nbsp;&nbsp;|&nbsp;&nbsp;".join(f"<b>{escape(k)}:</b> {escape(v)}" for k, v in out.filters) or "All records"
    money = "Amounts in ₹" if rupee_ok else "Amounts in Rs."
    title = Table(
        [
            [
                Paragraph(
                    escape(out.spec.title.upper()),
                    base_style("t", fontName=bold, fontSize=11.5, leading=14, textColor=colors.white),
                ),
                Paragraph(
                    f"{filt}&nbsp;&nbsp;|&nbsp;&nbsp;{money}",
                    base_style("tf", fontSize=9, leading=11, textColor=colors.white, alignment=TA_RIGHT),
                ),
            ]
        ],
        colWidths=[avail * 0.4, avail * 0.6],
    )
    title.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BRAND),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(title)

    story.append(Spacer(1, 4))
    return story


def statement_pdf(out, blocks) -> bytes:
    """The Salary Statement PDF, unit by unit (see the module docstring). Without the run's units (or for a list cut short
    by the row limit) the framework's own table is printed instead."""
    if blocks is None or out.truncated:
        return build_pdf(out)
    from .hr_reports_salary_statement import STATUTORY_SUM_KEYS, SUM_KEYS

    regular, bold, rupee_ok = ensure_fonts()
    co = company()
    page = landscape(A3)
    avail = page[0] - 2 * MARGIN

    def base_style(name, **kw) -> ParagraphStyle:
        values = dict(fontName=regular, fontSize=8, leading=10, textColor=INK)
        values.update(kw)
        return ParagraphStyle(name, **values)

    s_note = base_style("n", fontSize=8, leading=10, textColor=MUTED)
    cols = [c for c in out.columns if c.key != "unit"]
    story = _header(out, avail, regular, bold, rupee_ok, base_style)
    lines = statement_lines(blocks, SUM_KEYS, out.totals)
    if lines:
        story += _table(cols, lines, SUM_KEYS, avail, regular, bold, base_style)
    else:
        story.append(Paragraph("No records match the selected filters.", base_style("e", fontSize=10, leading=13)))
    for note in out.notes:
        story += [Spacer(1, 2), Paragraph(escape(note), s_note)]

    for section in out.sections:
        story.append(PageBreak())
        band = Table(
            [
                [
                    Paragraph(
                        escape(section.title.upper()),
                        base_style("st", fontName=bold, fontSize=11.5, leading=14, textColor=colors.white),
                    )
                ]
            ],
            colWidths=[avail],
        )
        band.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), BRAND),
                    ("LEFTPADDING", (0, 0), (-1, -1), 7),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story += [band, Spacer(1, 4)]
        s_cols = [c for c in section.columns if c.key != "unit"]
        s_lines = section_lines(section, blocks, STATUTORY_SUM_KEYS)
        if s_lines:
            story += _table(s_cols, s_lines, STATUTORY_SUM_KEYS, avail, regular, bold, base_style)
        else:
            story.append(Paragraph(escape(section.empty), base_style("se", fontSize=10, leading=13, textColor=MUTED)))
        for note in section.notes:
            story += [Spacer(1, 2), Paragraph(escape(note), s_note)]

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=FOOTER,
        title=out.spec.title,
        author=co.name,
    )
    frame = Frame(
        MARGIN,
        FOOTER,
        avail,
        page[1] - MARGIN - FOOTER,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="statement", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(
        story,
        canvasmaker=_canvas_maker(stamp, f"{co.name} - {out.spec.title}", regular, margin=MARGIN, baseline=0.45 * cm),
    )
    return buf.getvalue()


# ── Excel ─────────────────────────────────────────────────────────────────────

X_BRAND, X_SOFT, X_ZEBRA, X_SUB, X_TOTAL, X_GRID = "1E3A5F", "E8EEF6", "F6F8FB", "EEF2F7", "DCE6F2", "D5DBE3"
X_UNIT_BG, X_UNIT_INK, X_ZERO = "E0E7FF", "312E81", "9AA3AF"
# Lakh / crore grouping without the ₹ on every cell (the title row says "Amounts in ₹")
X_MONEY = "[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00"
_X_FORMATS = {CURRENCY: X_MONEY, NUMBER: "0.00", INTEGER: "0", PERCENT: '0.##"%"'}
_X_CAPS = {"name": 30, "designation": 26, "remarks": 22, "department": 22, "how": 48}


class _Sheet:
    """Writes one unit-by-unit table onto a worksheet."""

    def __init__(self, ws, cols):
        self.ws, self.cols, self.n = ws, cols, len(cols)
        thin = Side(style="thin", color=X_GRID)
        self.border = Border(left=thin, right=thin, top=thin, bottom=thin)
        self.strong_top = Border(left=thin, right=thin, top=Side(style="medium", color=X_BRAND), bottom=thin)
        self.f_body = Font(name="Calibri", size=11)
        self.f_zero = Font(name="Calibri", size=11, color=X_ZERO)
        self.f_bold = Font(name="Calibri", size=11, bold=True)
        self.f_head = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        self.f_band = Font(name="Calibri", size=12, bold=True, color=X_UNIT_INK)
        self.f_heading = Font(name="Calibri", size=11, bold=True, color=X_BRAND)
        self.f_note = Font(name="Calibri", size=10, italic=True, color="555555")
        self.fill = {
            "brand": PatternFill("solid", fgColor=X_BRAND),
            "soft": PatternFill("solid", fgColor=X_SOFT),
            "zebra": PatternFill("solid", fgColor=X_ZEBRA),
            "sub": PatternFill("solid", fgColor=X_SUB),
            "total": PatternFill("solid", fgColor=X_TOTAL),
            "unit": PatternFill("solid", fgColor=X_UNIT_BG),
        }
        self.keys = [c.key for c in cols]
        self.label_col = self.keys.index("name") + 1 if "name" in self.keys else 1
        self.unit_col = self.keys.index("unit") + 1 if "unit" in self.keys else None

    def text_row(self, text, font, fill=None, merge=True, height=None):
        ws = self.ws
        ws.append([safe_cell(text)])
        r = ws.max_row
        cell = ws.cell(row=r, column=1)
        cell.data_type = "s"
        cell.font = font
        cell.alignment = Alignment(horizontal="left", vertical="center")
        if fill is not None:
            for i in range(1, self.n + 1):
                ws.cell(row=r, column=i).fill = fill
        if merge and self.n > 1:
            ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=self.n)
        if height:
            ws.row_dimensions[r].height = height
        return r

    def header(self):
        ws = self.ws
        ws.append([safe_cell(c.label) for c in self.cols])
        r = ws.max_row
        for i in range(1, self.n + 1):
            cell = ws.cell(row=r, column=i)
            cell.font, cell.fill, cell.border = self.f_head, self.fill["brand"], self.border
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.row_dimensions[r].height = 32
        return r

    def line(self, line: Line):
        ws, cols = self.ws, self.cols
        last = self.n - (1 if self.unit_col else 0)
        if line.kind == GAP:
            ws.append([])  # a blank row between departments (it hides with the furniture when a column is filtered)
            return
        if line.kind == BAND:
            values = [None] * self.n
            values[0] = _band_text(line)
            if self.unit_col:
                values[self.unit_col - 1] = line.unit
            ws.append(values)
            r = ws.max_row
            for i in range(1, self.n + 1):
                cell = ws.cell(row=r, column=i)
                cell.fill, cell.font, cell.border = self.fill["unit"], self.f_band, self.border
                cell.alignment = Alignment(horizontal="center" if i == self.unit_col else "left", vertical="center")
            ws.cell(row=r, column=1).data_type = "s"
            if last > 1:
                ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=last)
            ws.row_dimensions[r].height = 21
            return
        values = [None] * self.n
        if line.kind == HEADING:
            values[self.label_col - 1] = line.text
            fill, font = self.fill["sub"], self.f_heading
        elif line.kind == ROW:
            values = [safe_cell(typed_value(c, line.values.get(c.key))) for c in cols]
            fill, font = (self.fill["zebra"] if line.zebra else None), self.f_body
        else:
            for i, c in enumerate(cols):
                v = line.values.get(c.key)
                if c.key != "unit" and isinstance(v, (int, float)) and not isinstance(v, bool):
                    values[i] = v
            if line.kind == GRAND:
                values[0] = "TOTAL"
                values[self.label_col - 1] = line.text.replace("TOTAL", "", 1).strip() or None
            else:
                values[self.label_col - 1] = line.text
            fill = self.fill["sub"] if line.kind == SUB else self.fill["total"]
            font = self.f_bold
        if self.unit_col and line.kind != GRAND:
            values[self.unit_col - 1] = line.unit
        ws.append(values)
        r = ws.max_row
        for i, c in enumerate(cols, start=1):
            cell = ws.cell(row=r, column=i)
            fmt = _X_FORMATS.get(c.type)
            if fmt:
                cell.number_format = fmt
            zero = line.kind == ROW and _is_zero(c, cell.value)
            cell.font = self.f_zero if zero else font
            if fill is not None:
                cell.fill = fill
            cell.border = self.strong_top if line.kind in (UNIT_TOTAL, GRAND) else self.border
            wrap = line.kind == ROW and c.key in _X_CAPS
            cell.alignment = Alignment(horizontal=_align(c), vertical="center", wrap_text=wrap)
            if isinstance(cell.value, str):
                cell.data_type = "s"  # never a formula, even if it starts with = + - @
        if line.kind in (HEADING, SUB, UNIT_TOTAL, GRAND):
            ws.cell(row=r, column=self.label_col).alignment = Alignment(horizontal="left", vertical="center")
            if line.kind == GRAND:
                ws.cell(row=r, column=1).alignment = Alignment(horizontal="left", vertical="center")

    def widths(self, lines):
        for i, c in enumerate(self.cols, start=1):
            words = max((len(w) for w in c.label.split()), default=4)
            longest = 0
            for line in lines:
                if line.kind == ROW or line.kind in _CLOSING:
                    v = line.values.get(c.key)
                    text = _cell_text(c, v)
                    longest = max(longest, len(text))
            width = max(words + 2, longest + 2)
            if c.key in _X_CAPS:
                width = min(width, _X_CAPS[c.key])
            if c.key == "unit":
                width = max(width, 8)
            self.ws.column_dimensions[get_column_letter(i)].width = round(min(width, 50) * 1.05, 1)


def _letterhead(ws, sheet: _Sheet, out, title: str, rupee_ok_text: str) -> None:
    co = company()
    if co.logo_png:
        try:
            img = XlImage(io.BytesIO(co.logo_png))
            img.width = img.height = 40
            ws.add_image(img, "A1")
        except Exception:
            pass
    indent = "       " if co.logo_png else ""
    sheet.text_row(indent + co.name, Font(name="Calibri", size=15, bold=True, color=X_BRAND), merge=False, height=26)
    sub = "  |  ".join(b for b in (co.address, co.contact, f"GSTIN {co.gstin}" if co.gstin else "") if b)
    sheet.text_row(indent + (sub or co.tagline), Font(name="Calibri", size=10, color="666666"), merge=False)
    sheet.text_row(
        title.upper(), Font(name="Calibri", size=13, bold=True, color="FFFFFF"), sheet.fill["brand"], height=22
    )
    filt = "   |   ".join(f"{k}: {v}" for k, v in out.filters) or "All records"
    sheet.text_row(f"{filt}   |   {rupee_ok_text}", Font(name="Calibri", size=11, bold=True), sheet.fill["soft"])


def _print_setup(ws, header_row: int, last_row: int, n: int, footer: str) -> None:
    ws.sheet_view.showGridLines = False
    if last_row > header_row:
        ws.auto_filter.ref = f"A{header_row}:{get_column_letter(n)}{last_row}"
    ws.print_title_rows = f"{header_row}:{header_row}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = 8  # A3, as the PDF
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.page_margins.left = ws.page_margins.right = 0.3
    ws.page_margins.top = ws.page_margins.bottom = 0.4
    ws.oddFooter.left.text = footer
    ws.oddFooter.right.text = "Page &P of &N"


def statement_xlsx(out, blocks) -> bytes:
    """The Salary Statement workbook, unit by unit (see the module docstring)."""
    if blocks is None or out.truncated:
        return build_xlsx(out)
    from .hr_reports_salary_statement import STATUTORY_SUM_KEYS, SUM_KEYS

    co = company()
    money = "Amounts in ₹"
    wb = Workbook()
    wb.properties.creator = "UKTextiles HRMS"
    wb.properties.title = out.spec.title
    ws = wb.active
    ws.title = sheet_title(out.spec.title)
    cols = list(out.columns)
    sheet = _Sheet(ws, cols)
    lines = statement_lines(blocks, SUM_KEYS, out.totals)
    sheet.widths(lines)

    _letterhead(ws, sheet, out, out.spec.title, money)
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    sheet.text_row(stamp, sheet.f_note, merge=False)
    ws.append([])
    header_row = sheet.header()  # HEADER_ROW, as every other Report Center workbook
    for line in lines:
        sheet.line(line)
    last_row = ws.max_row
    if not lines:
        sheet.text_row("No records match the selected filters.", sheet.f_note, merge=False)
    if out.notes:
        ws.append([])
        for note in out.notes:
            sheet.text_row(note, sheet.f_note, merge=False)
    ws.freeze_panes = f"D{header_row + 1}"
    _print_setup(ws, header_row, last_row, len(cols), f"{co.name} - {out.spec.title}")

    taken = {ws.title}
    for section in out.sections:
        name = sheet_title(section.sheet or section.title)
        base, i = name, 2
        while name in taken:
            suffix = f" ({i})"
            name, i = base[: 31 - len(suffix)] + suffix, i + 1
        taken.add(name)
        sws = wb.create_sheet(name)
        s_cols = list(section.columns)
        s_sheet = _Sheet(sws, s_cols)
        s_lines = section_lines(section, blocks, STATUTORY_SUM_KEYS)
        s_sheet.widths(s_lines)
        s_sheet.text_row(
            section.title.upper(),
            Font(name="Calibri", size=13, bold=True, color="FFFFFF"),
            s_sheet.fill["brand"],
            height=22,
        )
        filt = "   |   ".join(f"{k}: {v}" for k, v in out.filters) or "All records"
        s_sheet.text_row(f"{filt}   |   {money}", s_sheet.f_note, merge=False)
        s_header = s_sheet.header()
        for line in s_lines:
            s_sheet.line(line)
        s_last = sws.max_row
        if not s_lines:
            s_sheet.text_row(section.empty, s_sheet.f_note, merge=False)
        if section.notes:
            sws.append([])
            for note in section.notes:
                s_sheet.text_row(note, s_sheet.f_note, merge=False)
        sws.freeze_panes = f"D{s_header + 1}"
        _print_setup(sws, s_header, s_last, len(s_cols), f"{co.name} - {section.title}")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
