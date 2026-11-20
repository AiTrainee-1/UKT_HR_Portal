"""The standalone slips as PDF, in the payroll salary slip's own layouts (company_documents_views):

    single  one full A4 slip per page (salary_slip_story, the layout of the payroll slip PDF)
    double  two slips side by side per landscape A4 page (_compact_salary_slip_flowables, the payroll bulk PDF's)

Only the figures differ: they come from the saved StandaloneSalarySlip (engine.py), never from a payroll.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from decimal import Decimal

from reportlab.platypus import FrameBreak, PageBreak, Spacer

from ..models import CompanyDocumentSettings, Employee, PayrollSettings, StandaloneSalarySlip
from ..salary_slip_figures import SlipFigures, leave_lines_for

LAYOUTS = ("single", "double")


@dataclass
class SlipView:
    """What the payroll slip layouts read from a SalarySlip, for a standalone slip."""

    id: int
    employee: Employee
    month: int
    year: int
    slip_number: str
    working_days: int | float
    paid_leave_days: float = 0.0
    unpaid_leave_days: float = 0.0
    week_number: int | None = None


def _dec(value) -> Decimal:
    return Decimal(str(value or 0))


def _days_text(value) -> str:
    d = _dec(value)
    return str(int(d)) if d == d.to_integral_value() else f"{d.normalize():f}"


def slip_view(slip: StandaloneSalarySlip) -> SlipView:
    f = slip.figures or {}
    days = {row["key"]: row["value"] for row in f.get("days") or []}
    working = days.get("companyDays") if f.get("kind") == "staff" else days.get("monthDays")
    return SlipView(
        id=slip.id,
        employee=slip.employee,
        month=slip.month,
        year=slip.year,
        slip_number=slip.slip_number,
        working_days=_days_text(working or 0),
        unpaid_leave_days=float(f.get("leaveTaken") or 0),
    )


FIRST_PORTION_KEYS = ("basic", "da", "retaining_allowance")


def _compact_earnings(lines: list[dict]) -> list[tuple[str, Decimal]]:
    """The salary split in three lines (the two-per-page slip has room for no more, like payroll's compact slip): Basic
    (Basic + DA + Retaining Allowance), Petrol Allowance, Other Allowances; any other line as it is."""
    first = sum((_dec(x["amount"]) for x in lines if x["key"] in FIRST_PORTION_KEYS), Decimal("0"))
    petrol = sum((_dec(x["amount"]) for x in lines if x["key"] == "petrol_allowance"), Decimal("0"))
    split_keys = {"other_allowance", "hra", "special_allowance", "ca"}
    others = sum((_dec(x["amount"]) for x in lines if x["key"] in split_keys), Decimal("0"))
    rest = [
        (x["label"], _dec(x["amount"]))
        for x in lines
        if x["key"] not in split_keys | {"petrol_allowance"} and x["key"] not in FIRST_PORTION_KEYS
    ]
    out = [("Basic (Basic + DA + Retaining)", first)] if first else []
    out += [("Petrol Allowance", petrol)] if petrol else []
    out += [("Other Allowances", others)] if others else []
    return out + rest


def figures_of(slip: StandaloneSalarySlip, compact: bool = False) -> SlipFigures:
    f = slip.figures or {}
    days = {row["key"]: row["value"] for row in f.get("days") or []}
    st = f.get("statement") or {}
    if f.get("kind") == "production":
        rate = (f.get("rate") or {}).get("salaryPerShift")
        day_rows = [
            ("Days Worked", _days_text(days.get("daysWorked"))),
            ("Shifts Earned", _days_text(days.get("totalShifts"))),
            ("Days Absent", _days_text(days.get("daysAbsent"))),
            ("Salary per Shift", f"{_dec(rate):,.2f}"),
        ]
    else:
        # as the Salary Statement counts them: Present + CL + Paid Holidays = Paid Days; LOP = Company Days - Paid Days
        day_rows = [
            ("Company Days", _days_text(st.get("companyDays", days.get("companyDays")))),
            ("Paid Days", _days_text(st.get("totalDays", days.get("paidDays")))),
            ("Present", _days_text(st.get("present"))),
            ("Casual Leave", _days_text(st.get("cl"))),
            ("Paid Holidays", _days_text(st.get("hd"))),
            ("LOP Days", _days_text(st.get("lop", days.get("lopDays")))),
        ]
    counted = (f.get("period") or {}).get("countedTo")
    if (f.get("period") or {}).get("inProgress") and counted:
        day_rows.append(("Counted Up To", counted))
    lines = f.get("earnings") or []
    return SlipFigures(
        earnings=_compact_earnings(lines) if compact else [(x["label"], _dec(x["amount"])) for x in lines],
        earnings_total=_dec(f.get("grossTotal")),
        deductions=[(line["label"], _dec(line["amount"])) for line in f.get("deductions") or []],
        deductions_total=_dec(f.get("deductionsTotal")),
        net=_dec(f.get("net")),
        days=day_rows,
        source="standalone",
    )


def build_slips_pdf(slips: list[StandaloneSalarySlip], layout: str = "single") -> bytes:
    from ..company_documents_views import build_salary_slip_pdf, salary_slip_story
    from ..document_pdf import PremiumPageDecorator, new_premium_document

    views = [slip_view(s) for s in slips]
    figs = [figures_of(s, compact=layout == "double") for s in slips]
    leaves = leave_lines_for(views)
    ps = PayrollSettings.get()
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP)

    if layout == "double":
        return _double(views, figs, leaves, ps, ds)
    if len(views) == 1:
        return build_salary_slip_pdf(views[0], fig=figs[0], leave_lines=leaves[id(views[0])])

    buffer = io.BytesIO()
    doc = new_premium_document(buffer, PremiumPageDecorator(ds, ps, footer_note="System-generated salary slips"))
    story: list = []
    for i, (view, fig) in enumerate(zip(views, figs)):
        if i:
            story.append(PageBreak())
        story.extend(salary_slip_story(view, ps, ds, fig, leaves[id(view)]))
    doc.build(story)
    return buffer.getvalue()


def _double(views, figs, leaves, ps, ds) -> bytes:
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate

    from ..company_documents_views import _compact_salary_slip_flowables
    from ..document_pdf import _hex
    from ..salary_slip_bulk_pdf import (
        _COL_WIDTH,
        _CONTENT_H,
        _GAP,
        _HALF_W,
        _MARGIN_X,
        _MARGIN_Y,
        PAGE_H,
        PAGE_W,
        _draw_cut_line,
    )

    primary = _hex(ds.primary_color, "#0E4B3A")
    accent = _hex(ds.accent_color, "#C9A227")
    frames = [
        Frame(
            _MARGIN_X,
            _MARGIN_Y,
            _HALF_W,
            _CONTENT_H,
            id="left",
            leftPadding=4,
            rightPadding=4,
            topPadding=4,
            bottomPadding=4,
        ),
        Frame(
            _MARGIN_X + _HALF_W + _GAP,
            _MARGIN_Y,
            _HALF_W,
            _CONTENT_H,
            id="right",
            leftPadding=4,
            rightPadding=4,
            topPadding=4,
            bottomPadding=4,
        ),
    ]
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=(PAGE_W, PAGE_H),
        leftMargin=_MARGIN_X,
        rightMargin=_MARGIN_X,
        topMargin=_MARGIN_Y,
        bottomMargin=_MARGIN_Y,
    )
    doc.addPageTemplates([PageTemplate(id="dual", frames=frames, onPage=_draw_cut_line)])
    story: list = []
    for i, (view, fig) in enumerate(zip(views, figs)):
        if i:
            story.append(FrameBreak())
        story.extend(
            _compact_salary_slip_flowables(
                view, ds, ps, primary, accent, col_width=_COL_WIDTH, fig=fig, leave_lines=leaves[id(view)]
            )
        )
    doc.build(story or [Spacer(1, 1)])
    return buffer.getvalue()
