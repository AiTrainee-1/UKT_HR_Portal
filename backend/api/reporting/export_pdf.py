"""PDF export: a letterhead, filter summary, KPI strip and a zebra table with repeating header,
totals row and "Page X of Y" footer, built with reportlab.

Text uses the bundled DejaVu Sans (reporting/fonts) so the rupee sign and long names render the same
on Windows and on Railway's Linux containers -- the system Arial the older PDFs use is Windows-only."""

from __future__ import annotations

import io
import os
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as canvas_mod
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image as RLImage,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from .branding import company
from .formatting import display_date, display_datetime, indian_number, minutes_text
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
    TIME,
    ColumnSpec,
)

FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
BRAND = colors.HexColor("#1E3A5F")
BRAND_SOFT = colors.HexColor("#E8EEF6")
ZEBRA = colors.HexColor("#F1F4F9")
GRID = colors.HexColor("#D5DBE3")
SUBTOTAL = colors.HexColor("#EEF2F7")
TOTAL = colors.HexColor("#DCE6F2")
MUTED = colors.HexColor("#5B6573")
INK = colors.HexColor("#111827")

_NUMERIC = (CURRENCY, NUMBER, INTEGER, PERCENT, HOURS, MINUTES, DURATION)
_fonts: tuple[str, str, bool] | None = None


def ensure_fonts() -> tuple[str, str, bool]:
    """(regular, bold, rupee_glyph_ok). Falls back to Helvetica + "Rs." if the bundle is missing."""
    global _fonts
    if _fonts is not None:
        return _fonts
    try:
        pdfmetrics.registerFont(TTFont("RptSans", os.path.join(FONT_DIR, "DejaVuSans.ttf")))
        pdfmetrics.registerFont(TTFont("RptSans-Bold", os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf")))
        pdfmetrics.registerFontFamily(
            "RptSans", normal="RptSans", bold="RptSans-Bold", italic="RptSans", boldItalic="RptSans-Bold"
        )
        _fonts = ("RptSans", "RptSans-Bold", True)
    except Exception:
        _fonts = ("Helvetica", "Helvetica-Bold", False)
    return _fonts


def pdf_text(c: ColumnSpec, v, rupee_ok: bool = True) -> str:
    """One cell's display text."""
    if v is None or v == "":
        return "-"
    t = c.type
    try:
        if t == CURRENCY:
            return ("₹ " if rupee_ok else "Rs. ") + indian_number(float(v))
        if t == NUMBER:
            return indian_number(float(v))
        if t == INTEGER:
            return indian_number(float(v), 0)
        if t == PERCENT:
            return f"{float(v):.1f}%"
        if t == HOURS:
            return f"{float(v):.2f}"
        if t == MINUTES:
            return indian_number(float(v), 0)
        if t == DURATION:
            return minutes_text(v)
    except (TypeError, ValueError):
        return str(v)
    if t == DATE:
        return display_date(v)
    if t == DATETIME:
        return display_datetime(v)
    if t == TIME:
        return str(v)[:5]
    return str(v)


def _page_size(spec, n_cols: int):
    if n_cols > 18:
        return landscape(A3)
    return landscape(A4) if spec.landscape else A4


def _column_widths(cols: list[ColumnSpec], avail: float) -> list[float]:
    weights = [max(0.5, c.width) for c in cols]
    widths = [avail * w / sum(weights) for w in weights]
    # The floor must itself fit on the page (a 40-column muster would otherwise get negative widths).
    floor = min(1.1 * cm, avail / len(cols) * 0.85)
    if any(w < floor for w in widths):
        fixed = sum(floor for w in widths if w < floor)
        rest = [i for i, w in enumerate(widths) if w >= floor]
        pool = avail - fixed
        rw = sum(weights[i] for i in rest) or 1
        widths = [floor if w < floor else pool * weights[i] / rw for i, w in enumerate(widths)]
    return widths


def _canvas_maker(footer_left: str, footer_mid: str, regular: str):
    class NumberedCanvas(canvas_mod.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved: list[dict] = []

        def showPage(self):
            self._saved.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved)
            for state in self._saved:
                self.__dict__.update(state)
                w, _h = self._pagesize
                self.setStrokeColor(GRID)
                self.setLineWidth(0.5)
                self.line(1 * cm, 1.15 * cm, w - 1 * cm, 1.15 * cm)
                self.setFont(regular, 7)
                self.setFillColor(MUTED)
                self.drawString(1 * cm, 0.7 * cm, footer_left)
                self.drawCentredString(w / 2, 0.7 * cm, footer_mid)
                self.drawRightString(w - 1 * cm, 0.7 * cm, f"Page {self._pageNumber} of {total}")
                super().showPage()
            super().save()

    return NumberedCanvas


def build_pdf(out: RunOutput) -> bytes:
    spec, cols = out.spec, out.columns
    regular, bold, rupee_ok = ensure_fonts()
    co = company()
    page = _page_size(spec, len(cols))
    margin = 1.0 * cm
    avail = page[0] - 2 * margin
    n = len(cols)
    size = 8.0 if n <= 12 else 7.0 if n <= 18 else 6.0 if n <= 30 else 5.0

    def style(name, **kw) -> ParagraphStyle:
        base = dict(fontName=regular, fontSize=size, leading=size * 1.25, textColor=INK)
        base.update(kw)
        return ParagraphStyle(name, **base)

    s_left = style("l", alignment=TA_LEFT)
    s_center = style("c", alignment=TA_CENTER)
    s_right = style("r", alignment=TA_RIGHT)
    s_head = style("h", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=size, leading=size * 1.2)
    s_bold_left = style("bl", fontName=bold, alignment=TA_LEFT)
    s_bold_right = style("br", fontName=bold, alignment=TA_RIGHT)
    s_bold_center = style("bc", fontName=bold, alignment=TA_CENTER)
    s_note = style("n", fontSize=7, leading=9, textColor=MUTED)

    def align_style(c: ColumnSpec, strong: bool):
        a = c.align or (
            "right" if c.type in _NUMERIC else "center" if c.type in (DATE, TIME, DATETIME, BADGE) else "left"
        )
        if strong:
            return {"left": s_bold_left, "right": s_bold_right, "center": s_bold_center}[a]
        return {"left": s_left, "right": s_right, "center": s_center}[a]

    story: list = []

    # ── letterhead ───────────────────────────────────────────────────────────
    head_left = [
        Paragraph(f"<b>{escape(co.name)}</b>", style("co", fontName=bold, fontSize=14, leading=17, textColor=BRAND)),
    ]
    sub = "  |  ".join(b for b in (co.address, co.contact, f"GSTIN {co.gstin}" if co.gstin else "") if b)
    if sub:
        head_left.append(Paragraph(escape(sub), style("sub", fontSize=7.5, leading=10, textColor=MUTED)))
    logo = None
    if co.logo_png:
        try:
            logo = RLImage(io.BytesIO(co.logo_png), width=1.3 * cm, height=1.3 * cm, kind="proportional")
        except Exception:
            logo = None
    if logo is not None:
        hdr = Table([[logo, head_left]], colWidths=[1.7 * cm, avail - 1.7 * cm])
    else:
        hdr = Table([[head_left]], colWidths=[avail])
    hdr.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(hdr)
    story.append(Spacer(1, 4))

    title = Table(
        [
            [
                Paragraph(
                    escape(spec.title.upper()),
                    style("t", fontName=bold, fontSize=11, leading=14, textColor=colors.white),
                )
            ]
        ],
        colWidths=[avail],
    )
    title.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BRAND),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(title)

    filt = "   |   ".join(f"<b>{escape(k)}:</b> {escape(v)}" for k, v in out.filters) or "All records"
    fbox = Table([[Paragraph(filt, style("f", fontSize=8, leading=11))]], colWidths=[avail])
    fbox.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BRAND_SOFT),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(fbox)
    story.append(Spacer(1, 6))

    # ── KPI strip ────────────────────────────────────────────────────────────
    if out.summary:
        cards = []
        for s in out.summary[:12]:
            fake = ColumnSpec("v", s["label"], s.get("format", INTEGER))
            cards.append(
                [
                    Paragraph(escape(str(s["label"])), style("kl", fontSize=7, leading=9, textColor=MUTED)),
                    Paragraph(
                        f"<b>{escape(pdf_text(fake, s.get('value'), rupee_ok))}</b>",
                        style("kv", fontName=bold, fontSize=11, leading=14, textColor=BRAND),
                    ),
                ]
            )
        per_row = min(len(cards), 6)
        rows_ = [cards[i : i + per_row] for i in range(0, len(cards), per_row)]
        for chunk in rows_:
            cells = [[c[0], c[1]] for c in chunk]
            kt = Table([[cell for cell in cells]], colWidths=[avail / per_row] * len(cells))
            kt.setStyle(
                TableStyle(
                    [
                        ("BOX", (0, 0), (-1, -1), 0.5, GRID),
                        ("INNERGRID", (0, 0), (-1, -1), 0.5, GRID),
                        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 4),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ]
                )
            )
            story.append(kt)
        story.append(Spacer(1, 6))

    # ── main table ───────────────────────────────────────────────────────────
    # Plain strings are ~10x cheaper than Paragraphs, so only a cell whose text does not fit its
    # column is wrapped in a Paragraph; everything else is drawn as text with column-level styles.
    widths = _column_widths(cols, avail)
    pad = 3.0
    aligns = [
        c.align or ("right" if c.type in _NUMERIC else "center" if c.type in (DATE, TIME, DATETIME, BADGE) else "left")
        for c in cols
    ]

    def cell_for(c: ColumnSpec, i: int, text: str, strong: bool):
        if pdfmetrics.stringWidth(text, bold if strong else regular, size) <= widths[i] - 2 * pad:
            return text
        return Paragraph(escape(text), align_style(c, strong))

    data: list[list] = [[Paragraph(escape(c.label), s_head) for c in cols]]
    cmds: list[tuple] = [
        ("FONTNAME", (0, 1), (-1, -1), regular),
        ("FONTSIZE", (0, 1), (-1, -1), size),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), pad),
        ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]
    for i, a in enumerate(aligns):
        cmds.append(("ALIGN", (i, 1), (i, -1), a.upper()))
    for r in out.rows:
        kind = r.get("_kind")
        strong = kind in (KIND_SUBTOTAL, KIND_TOTAL)
        idx = len(data)
        data.append(
            [
                cell_for(c, i, "" if strong and r.get(c.key) is None else pdf_text(c, r.get(c.key), rupee_ok), strong)
                for i, c in enumerate(cols)
            ]
        )
        if strong:
            cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
            cmds.append(("BACKGROUND", (0, idx), (-1, idx), TOTAL if kind == KIND_TOTAL else SUBTOTAL))
    if out.totals:
        idx = len(data)
        first = True
        row = []
        for i, c in enumerate(cols):
            v = out.totals.get(c.key)
            if v is None:
                row.append("TOTAL" if first else "")
                first = False
            else:
                row.append(cell_for(c, i, pdf_text(c, v, rupee_ok), True))
        data.append(row)
        cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
        cmds.append(("BACKGROUND", (0, idx), (-1, idx), TOTAL))
        cmds.append(("LINEABOVE", (0, idx), (-1, idx), 0.9, BRAND))
        for i, c in enumerate(cols):
            if out.totals.get(c.key) is None:
                cmds.append(("ALIGN", (i, idx), (i, idx), "LEFT"))

    if len(data) == 1:
        story.append(
            Paragraph("No records match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED))
        )
    else:
        tbl = Table(data, colWidths=widths, repeatRows=1, splitByRow=1)
        tbl.setStyle(TableStyle(cmds))
        story.append(tbl)

    if out.truncated:
        story.append(Spacer(1, 4))
        story.append(
            Paragraph(
                f"<b>Note:</b> only the first {out.row_count:,} rows are printed here. Narrow the filters or use the Excel export for the full data.",
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
        title=spec.title,
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
    doc.addPageTemplates([PageTemplate(id="report", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(story, canvasmaker=_canvas_maker(stamp, f"{co.name} - {spec.title}", regular))
    return buf.getvalue()
