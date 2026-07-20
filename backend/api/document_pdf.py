"""
Company Documents — Offer Letter, Experience Letter, Salary Slip
==================================================================
Premium reportlab-based PDF generation shared by all three document types.
Mirrors the Resignation Letter's reportlab/Platypus approach in
recruitment_views.py, but adds a shared "premium" page treatment (double
border with gold corners, faint watermark, curved emerald footer) driven by
CompanyDocumentSettings so HR can theme each document from Settings.

Body/heading fonts are the system Arial/Georgia families (registered as
TrueType so the Indian Rupee glyph "₹" renders correctly — reportlab's
built-in Helvetica/Times AFM fonts do not contain it). If those font files
aren't present on the deployment machine (non-Windows), we fall back to the
built-in Helvetica/Times families and print amounts as "Rs." instead.
"""
import base64
import io
import os
from datetime import date, datetime

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as canvas_mod
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, Image as RLImage, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

from .models import CompanyDocumentSettings, PayrollSettings

# ── Font registration (Windows system fonts; graceful fallback) ────────────

FONTS_DIR = r"C:\Windows\Fonts"
RUPEE_FONT_OK = False
try:
    pdfmetrics.registerFont(TTFont("DocBody", os.path.join(FONTS_DIR, "arial.ttf")))
    pdfmetrics.registerFont(TTFont("DocBody-Bold", os.path.join(FONTS_DIR, "arialbd.ttf")))
    pdfmetrics.registerFont(TTFont("DocBody-Italic", os.path.join(FONTS_DIR, "ariali.ttf")))
    pdfmetrics.registerFont(TTFont("DocSerif", os.path.join(FONTS_DIR, "georgia.ttf")))
    pdfmetrics.registerFont(TTFont("DocSerif-Bold", os.path.join(FONTS_DIR, "georgiab.ttf")))
    pdfmetrics.registerFont(TTFont("DocSerif-Italic", os.path.join(FONTS_DIR, "timesi.ttf")))
    RUPEE_FONT_OK = True
except Exception:
    FONT_BODY, FONT_BODY_BOLD, FONT_BODY_ITALIC = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"
    FONT_SERIF, FONT_SERIF_BOLD, FONT_SERIF_ITALIC = "Times-Roman", "Times-Bold", "Times-Italic"

if RUPEE_FONT_OK:
    FONT_BODY, FONT_BODY_BOLD, FONT_BODY_ITALIC = "DocBody", "DocBody-Bold", "DocBody-Italic"
    FONT_SERIF, FONT_SERIF_BOLD, FONT_SERIF_ITALIC = "DocSerif", "DocSerif-Bold", "DocSerif-Italic"


def rupee(amount) -> str:
    """Format a currency amount, using the real ₹ glyph when it's safe to render."""
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        amount = 0.0
    symbol = "₹" if RUPEE_FONT_OK else "Rs. "
    return f"{symbol}{amount:,.2f}"


# ── Shared helpers ──────────────────────────────────────────────────────────

def _hex(value: str, fallback: str) -> colors.Color:
    try:
        return colors.HexColor(value or fallback)
    except Exception:
        return colors.HexColor(fallback)


def _decode_b64_image(data_url: str | None):
    """Decodes a base64 data-URL into a validated, resolution-capped PNG buffer.

    reportlab's Image flowable embeds whatever bytes it's handed at their
    native pixel resolution regardless of the display width/height — an
    unvalidated or oversized stored logo/signature can silently balloon a
    single-page PDF to several MB. We verify the data actually decodes as an
    image via PIL and downscale anything larger than a small logo needs to be.
    """
    if not data_url:
        return None
    try:
        raw = base64.b64decode(data_url.split(",")[-1])
        from PIL import Image as PILImage
        img = PILImage.open(io.BytesIO(raw))
        img.load()
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        img.thumbnail((600, 600), PILImage.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="PNG", optimize=True)
        out.seek(0)
        return out
    except Exception:
        return None


def heading_fonts(heading_style: str) -> tuple[str, str, str]:
    """Returns (regular, bold, italic) font names for the chosen heading style."""
    if heading_style == "sans":
        return FONT_BODY, FONT_BODY_BOLD, FONT_BODY_ITALIC
    return FONT_SERIF, FONT_SERIF_BOLD, FONT_SERIF_ITALIC


class PremiumPageDecorator:
    """
    Draws the shared "premium" page furniture on every page of a document:
    double-line border with gold corner ticks, a faint diagonal company
    watermark, and a curved emerald footer with a gold accent line carrying
    the tagline + company contact details.
    """

    def __init__(self, doc_settings: CompanyDocumentSettings, ps: PayrollSettings, footer_note: str = ""):
        self.primary = _hex(doc_settings.primary_color, "#0E4B3A")
        self.accent = _hex(doc_settings.accent_color, "#C9A227")
        self.show_watermark = doc_settings.show_watermark
        self.tagline = doc_settings.footer_tagline or ""
        self.company_name = (ps.company_name or "UK TEXTILES").upper()
        self.contact_bits = [b for b in [ps.company_address, ps.company_phone, ps.company_email, ps.company_website] if b]
        self.footer_note = footer_note
        _, self.serif_bold, self.serif_italic = FONT_SERIF, FONT_SERIF_BOLD, FONT_SERIF_ITALIC

    def draw(self, c: canvas_mod.Canvas, doc):
        page_w, page_h = A4
        c.saveState()

        # Double-line border with gold corner ornaments
        margin = 0.9 * cm
        c.setStrokeColor(self.accent)
        c.setLineWidth(1.1)
        c.rect(margin, margin, page_w - 2 * margin, page_h - 2 * margin, stroke=1, fill=0)
        inner = margin + 0.14 * cm
        c.setLineWidth(0.4)
        c.rect(inner, inner, page_w - 2 * inner, page_h - 2 * inner, stroke=1, fill=0)

        corner = 0.6 * cm
        c.setLineWidth(1.8)
        for x, y, dx, dy in (
            (margin, page_h - margin, 1, -1),
            (page_w - margin, page_h - margin, -1, -1),
            (margin, margin, 1, 1),
            (page_w - margin, margin, -1, 1),
        ):
            c.line(x, y, x + dx * corner, y)
            c.line(x, y, x, y + dy * corner)

        # Faint diagonal watermark
        if self.show_watermark:
            c.saveState()
            c.setFillColor(self.primary)
            c.setFillAlpha(0.05)
            c.setFont(self.serif_bold, 66)
            c.translate(page_w / 2, page_h / 2)
            c.rotate(35)
            c.drawCentredString(0, 0, self.company_name)
            c.restoreState()

        # Curved emerald footer with gold accent line
        footer_h = 2.5 * cm
        wave = 0.45 * cm
        path = c.beginPath()
        path.moveTo(0, footer_h)
        path.curveTo(page_w * 0.28, footer_h + wave, page_w * 0.72, footer_h - wave, page_w, footer_h)
        path.lineTo(page_w, 0)
        path.lineTo(0, 0)
        path.close()
        c.setFillColor(self.primary)
        c.setFillAlpha(1)
        c.drawPath(path, fill=1, stroke=0)

        accent_path = c.beginPath()
        accent_path.moveTo(0, footer_h)
        accent_path.curveTo(page_w * 0.28, footer_h + wave, page_w * 0.72, footer_h - wave, page_w, footer_h)
        c.setStrokeColor(self.accent)
        c.setLineWidth(1.6)
        c.drawPath(accent_path, fill=0, stroke=1)

        c.setFillColor(colors.white)
        if self.tagline:
            c.setFont(self.serif_italic, 10.5)
            c.drawCentredString(page_w / 2, footer_h - 0.85 * cm, self.tagline)
        if self.contact_bits:
            c.setFont(FONT_BODY, 7.5)
            c.drawCentredString(page_w / 2, footer_h - 1.45 * cm, "   •   ".join(self.contact_bits))
        if self.footer_note:
            c.setFillAlpha(0.75)
            c.setFont(FONT_BODY, 6.5)
            c.drawCentredString(page_w / 2, footer_h - 1.95 * cm, self.footer_note)

        c.restoreState()


def new_premium_document(buffer: io.BytesIO, decorator: PremiumPageDecorator) -> BaseDocTemplate:
    page_w, page_h = A4
    left = right = 1.5 * cm
    top = 1.35 * cm
    bottom = 3.05 * cm  # clears the curved footer band
    frame = Frame(left, bottom, page_w - left - right, page_h - top - bottom, id="body")
    doc = BaseDocTemplate(
        buffer, pagesize=A4,
        leftMargin=left, rightMargin=right, topMargin=top, bottomMargin=bottom,
    )
    doc.addPageTemplates([PageTemplate(id="premium", frames=[frame], onPage=decorator.draw)])
    return doc


def styles_for(heading_style: str, primary: colors.Color) -> dict:
    heading_font, heading_bold, heading_italic = heading_fonts(heading_style)
    return {
        "body": ParagraphStyle("Body", fontName=FONT_BODY, fontSize=10, leading=16, alignment=TA_LEFT),
        "bodyBold": ParagraphStyle("BodyBold", fontName=FONT_BODY_BOLD, fontSize=10, leading=16),
        "small": ParagraphStyle("Small", fontName=FONT_BODY, fontSize=8.5, leading=12, textColor=colors.grey),
        "companyName": ParagraphStyle(
            "CompanyName", fontName=heading_bold, fontSize=15, leading=18,
            textColor=primary, alignment=TA_LEFT,
        ),
        "companyLoc": ParagraphStyle("CompanyLoc", fontName=FONT_BODY, fontSize=8.5, textColor=colors.grey),
        "contact": ParagraphStyle("Contact", fontName=FONT_BODY, fontSize=8, alignment=2, leading=12, textColor=colors.HexColor("#4b5563")),
        "title": ParagraphStyle(
            "Title", fontName=heading_bold, fontSize=19, leading=24,
            textColor=primary, alignment=TA_CENTER, spaceAfter=2,
        ),
        "certMeta": ParagraphStyle("CertMeta", fontName=FONT_BODY, fontSize=9, alignment=TA_CENTER, textColor=colors.grey),
        "sigLabel": ParagraphStyle("SigLabel", fontName=FONT_BODY, fontSize=9, textColor=colors.grey),
        "sigName": ParagraphStyle("SigName", fontName=heading_bold, fontSize=10.5, textColor=primary),
    }


def company_header(story: list, ps: PayrollSettings, doc_settings: CompanyDocumentSettings, st: dict) -> None:
    logo_src = doc_settings.logo_override or ps.company_logo
    logo_img = None
    logo_buf = _decode_b64_image(logo_src)
    if logo_buf:
        try:
            logo_img = RLImage(logo_buf, width=2.6 * cm, height=1.5 * cm)
            logo_img.hAlign = "LEFT"
        except Exception:
            logo_img = None

    left_cell = []
    if logo_img:
        left_cell.append(logo_img)
        left_cell.append(Spacer(1, 0.15 * cm))
    left_cell.append(Paragraph((ps.company_name or "UK TEXTILES").upper(), st["companyName"]))
    if ps.company_address:
        left_cell.append(Paragraph(ps.company_address, st["companyLoc"]))

    right_lines = [b for b in [ps.company_website, ps.company_email, ps.company_phone] if b]
    right_cell = [Paragraph(line, st["contact"]) for line in right_lines] or [Spacer(1, 0.1 * cm)]

    header_table = Table([[left_cell, right_cell]], colWidths=[11 * cm, 6.7 * cm])
    header_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(header_table)
    story.append(Spacer(1, 0.35 * cm))
    story.append(HRFlowable(width="100%", thickness=0.8, color=_hex(doc_settings.accent_color, "#C9A227")))
    story.append(Spacer(1, 0.15 * cm))


def title_block(story: list, title: str, st: dict, accent: colors.Color) -> None:
    story.append(Spacer(1, 0.15 * cm))
    story.append(Paragraph(title, st["title"]))
    line_table = Table([[""]], colWidths=[4.5 * cm], rowHeights=[0.06 * cm])
    line_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), accent)]))
    line_table.hAlign = "CENTER"
    story.append(line_table)
    story.append(Spacer(1, 0.5 * cm))


def signature_block(story: list, ps: PayrollSettings, st: dict, label: str = "Authorized Signatory", sub: str = "HR Department") -> None:
    sig_cell = []
    sig_buf = _decode_b64_image(ps.authorized_signature)
    if sig_buf:
        try:
            sig_cell.append(RLImage(sig_buf, width=3 * cm, height=1.4 * cm))
        except Exception:
            sig_cell.append(Spacer(1, 1.4 * cm))
    else:
        sig_cell.append(Spacer(1, 1.4 * cm))
    sig_cell.append(Paragraph(f"<b>{label}</b>", st["sigName"]))
    sig_cell.append(Paragraph(sub, st["sigLabel"]))

    table = Table([["", sig_cell]], colWidths=[10.5 * cm, 6.7 * cm])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("ALIGN", (1, 0), (1, 0), "LEFT")]))
    story.append(table)


def full_name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def num_to_words(n: int) -> str:
    if n < 0:
        return "Rs. ZERO"
    ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
            "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
    tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"]

    def convert(x):
        if x < 20: return ones[x]
        if x < 100: return tens[x // 10] + (" " + ones[x % 10] if x % 10 else "")
        if x < 1000: return ones[x // 100] + " HUNDRED" + (" " + convert(x % 100) if x % 100 else "")
        if x < 100000: return convert(x // 1000) + " THOUSAND" + (" " + convert(x % 1000) if x % 1000 else "")
        if x < 10000000: return convert(x // 100000) + " LAKH" + (" " + convert(x % 100000) if x % 100000 else "")
        return convert(x // 10000000) + " CRORE" + (" " + convert(x % 10000000) if x % 10000000 else "")

    return "Rs. " + (convert(n) if n else "ZERO")


def fmt_date(value, fallback: str = "—") -> str:
    if not value:
        return fallback
    if isinstance(value, (date, datetime)):
        return value.strftime("%d %B %Y")
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%d %B %Y")
        except ValueError:
            continue
    return text
