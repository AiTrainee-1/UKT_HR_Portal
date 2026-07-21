"""
Combined multi-employee Salary Slip PDF — one continuous file, landscape A4,
2 slips per page laid out side by side (left slip / right slip), meant to be
printed and physically distributed.

Reuses the exact same SalarySlip data/fields as the single-slip PDF
(company_documents_views.build_salary_slip_pdf) via a dedicated compact
flowables builder sized to fit one ~13cm-wide column — see
company_documents_views._compact_salary_slip_flowables().

Vector, not rasterized: each slip is drawn straight into the combined
document's page frames (the same reportlab/Platypus content model as every
other document in this app), not a PNG image — smaller file, crisp text at
any zoom/print size, no new PDF-to-image dependency.
"""
import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import cm
from reportlab.platypus import BaseDocTemplate, Frame, FrameBreak, PageTemplate, Spacer

from .company_documents_views import _compact_salary_slip_flowables
from .document_pdf import _hex
from .models import CompanyDocumentSettings, PayrollSettings

PAGE_W, PAGE_H = landscape(A4)
_MARGIN_X = 1 * cm
_MARGIN_Y = 1 * cm
_GAP = 0.6 * cm
_FRAME_PADDING = 4  # points, matches leftPadding/rightPadding on each Frame below
_HALF_W = (PAGE_W - 2 * _MARGIN_X - _GAP) / 2
_CONTENT_H = PAGE_H - 2 * _MARGIN_Y
_COL_WIDTH = _HALF_W - 2 * _FRAME_PADDING


def _draw_cut_line(c, doc):
    """Faint dashed line between the two side-by-side slips, for scissors/paper-cutter."""
    mid_x = _MARGIN_X + _HALF_W + _GAP / 2
    c.saveState()
    c.setStrokeColor(colors.HexColor("#d1d5db"))
    c.setLineWidth(0.5)
    c.setDash(3, 3)
    c.line(mid_x, 0.6 * cm, mid_x, PAGE_H - 0.6 * cm)
    c.restoreState()


def build_bulk_salary_slip_pdf(slips, on_progress=None) -> bytes:
    """
    slips: iterable of SalarySlip instances (already filtered/ordered by the caller)
    on_progress(employee_name, ok): optional callback invoked once per slip,
        so the caller can report live progress (see salary_slip_bulk_progress.py)
    Returns the combined PDF as bytes.
    """
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP)
    ps = PayrollSettings.get()
    primary = _hex(ds.primary_color, "#0E4B3A")
    accent = _hex(ds.accent_color, "#C9A227")

    left_frame = Frame(
        _MARGIN_X, _MARGIN_Y, _HALF_W, _CONTENT_H, id="left",
        leftPadding=4, rightPadding=4, topPadding=4, bottomPadding=4,
    )
    right_frame = Frame(
        _MARGIN_X + _HALF_W + _GAP, _MARGIN_Y, _HALF_W, _CONTENT_H, id="right",
        leftPadding=4, rightPadding=4, topPadding=4, bottomPadding=4,
    )

    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer, pagesize=(PAGE_W, PAGE_H),
        leftMargin=_MARGIN_X, rightMargin=_MARGIN_X, topMargin=_MARGIN_Y, bottomMargin=_MARGIN_Y,
    )
    doc.addPageTemplates([PageTemplate(id="dual", frames=[left_frame, right_frame], onPage=_draw_cut_line)])

    story = []
    for i, s in enumerate(slips):
        emp_name = f"{s.employee.first_name} {s.employee.last_name}".strip()
        try:
            if i > 0:
                story.append(FrameBreak())
            story.extend(_compact_salary_slip_flowables(s, ds, ps, primary, accent, col_width=_COL_WIDTH))
            ok = True
        except Exception:
            ok = False
        if on_progress:
            on_progress(emp_name, ok)

    if not story:
        story = [Spacer(1, 1)]

    doc.build(story)
    return buffer.getvalue()
