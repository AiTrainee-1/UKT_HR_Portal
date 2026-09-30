"""PDF building blocks shared by the attendance_core document-style exports (registers no report).

The Time Card and the Attendance Sheet (muster roll) are printable registers, not plain tables, so they bring
their own ``pdf_builder`` (see the reporting README). Everything here only composes the framework's own
building blocks (fonts, letterhead data, colours) -- it never touches the database.
"""

from __future__ import annotations

import io
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as canvas_mod
from reportlab.platypus import Image as RLImage
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle

from ..export_pdf import BRAND, BRAND_SOFT, GRID, INK, MUTED, pdf_text
from ..types import INTEGER, ColumnSpec


def numbered_canvas(footer_left: str, regular: str, margin: float = 1.2 * cm):
    """A canvas that stamps "Page X of Y" and a footer line on every page."""

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
                self.line(margin, 1.25 * cm, w - margin, 1.25 * cm)
                self.setFont(regular, 7)
                self.setFillColor(MUTED)
                self.drawString(margin, 0.8 * cm, footer_left)
                self.drawRightString(w - margin, 0.8 * cm, f"Page {self._pageNumber} of {total}")
                super().showPage()
            super().save()

    return NumberedCanvas


def style_factory(regular: str, size: float = 7.0, leading: float | None = None):
    """``style(name, **overrides)`` -> ParagraphStyle in the report font."""

    def style(name: str, **kw) -> ParagraphStyle:
        base = {"fontName": regular, "fontSize": size, "leading": leading or size * 1.25, "textColor": INK}
        base.update(kw)
        return ParagraphStyle(name, **base)

    return style


def letterhead(co, avail: float, regular: str, bold: str, style) -> list:
    """Company name (+ logo, address line) as the first flowables of a page."""
    left = [
        Paragraph(f"<b>{escape(co.name)}</b>", style("co", fontName=bold, fontSize=13, leading=16, textColor=BRAND))
    ]
    sub = "  |  ".join(b for b in (co.address, co.contact, f"GSTIN {co.gstin}" if co.gstin else "") if b)
    if sub:
        left.append(Paragraph(escape(short(sub, 170)), style("sub", fontSize=6.8, leading=8.5, textColor=MUTED)))
    logo = None
    if co.logo_png:
        try:
            logo = RLImage(io.BytesIO(co.logo_png), width=1.2 * cm, height=1.2 * cm, kind="proportional")
        except Exception:
            logo = None
    if logo is not None:
        head = Table([[logo, left]], colWidths=[1.6 * cm, avail - 1.6 * cm])
    else:
        head = Table([[left]], colWidths=[avail])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    return [head, Spacer(1, 4)]


def title_bar(title: str, right: str, avail: float, bold: str, style) -> Table:
    bar = Table(
        [
            [
                Paragraph(escape(title), style("tb", fontName=bold, fontSize=11, leading=14, textColor=colors.white)),
                Paragraph(
                    escape(right),
                    style("tr", fontName=bold, fontSize=9, leading=12, textColor=colors.white, alignment=2),
                ),
            ]
        ],
        colWidths=[avail * 0.5, avail * 0.5],
    )
    bar.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BRAND),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return bar


def filter_box(pairs, avail: float, style) -> Table:
    text = "   |   ".join(f"<b>{escape(k)}:</b> {escape(v)}" for k, v in pairs) or "All records"
    box = Table([[Paragraph(text, style("fb", fontSize=7.5, leading=10))]], colWidths=[avail])
    box.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BRAND_SOFT),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return box


def kpi_strip(summary: list[dict], avail: float, bold: str, style, rupee_ok: bool = True) -> Table | None:
    """The report's summary cards as one row of label / value boxes (at most eight)."""
    cards = []
    for s in summary[:8]:
        fake = ColumnSpec("v", str(s["label"]), s.get("format", INTEGER))
        cards.append(
            [
                Paragraph(escape(str(s["label"])), style("kl", fontSize=6.5, leading=8, textColor=MUTED)),
                Paragraph(
                    f"<b>{escape(pdf_text(fake, s.get('value'), rupee_ok))}</b>",
                    style("kv", fontName=bold, fontSize=10, leading=12, textColor=BRAND),
                ),
            ]
        )
    if not cards:
        return None
    strip = Table([cards], colWidths=[avail / len(cards)] * len(cards))
    strip.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, GRID),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, GRID),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return strip


def short(text: str | None, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
