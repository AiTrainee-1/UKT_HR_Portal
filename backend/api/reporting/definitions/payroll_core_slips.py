"""
Payroll core reports built on the stored salary slips (one row per slip):

    salary-slip            slip listing; its PDF export is the real printable salary slips
    salary-register        statutory-style wage register with department subtotals
    salary-wages-statement Basic / HRA / Allowances - fixed vs earned - with OT and loss of pay
    production-wage-sheet  period-wise production wages (shifts, extra shifts, deductions)

All money is read from the SalarySlip row the payroll engine stored (see payroll_core_common).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Q

from api.payroll_views import _d2

from ..common import EMP_COLS, emp_cells
from ..filters import ReportParamError, date_range, period, scope, select
from ..formatting import fmt_dt, iso
from ..registry import register
from ..types import BADGE, CURRENCY, DATE, INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .payroll_core_common import (
    LEGACY_KEY,
    ZERO,
    legacy_filter,
    load_slips,
    nat_key,
    payment_filter,
    pairs_q,
    provisional_note,
    status_text,
    subtotals,
)

CATEGORY = "payroll"
BOTH = ("payroll", "production_payroll")
MONEY = 1.3

MAX_SLIPS_PER_PDF = 300

# The engine's hard-coded salary split (payroll_views._generate_staff_payroll). PayrollSettings.basic_percent /
# hra_percent only drive the Compensation page, so they are NOT used here.
BASIC_SHARE = Decimal("0.50")
HRA_SHARE = Decimal("0.20")


def _cur(key: str, label: str, width: float = MONEY, total: str | None = "sum") -> ColumnSpec:
    return ColumnSpec(key, label, CURRENCY, width, total=total)


def _blank_if_zero_production(d: dict, key: str):
    """Production has no overtime concept: show a dash instead of a meaningless 0.00."""
    return None if d["production"] and not d[key] else d[key]


def _employees(rows) -> int:
    return len({r.slip.employee_id for r in rows})


# ═════════════════════════════════════════════════════════════════════════════
#  salary-slip
# ═════════════════════════════════════════════════════════════════════════════

SLIP_MODULES = ("salary_slip", "payroll", "production_payroll")
SLIP_FULL = ("payroll", "salary_slip")

SLIP_NOTES = [
    "Total earnings = gross pay + overtime. Other deductions = total deductions less PF, ESI and advance: for staff it is "
    "the late-detection deduction (printed on the slip as 'Other Deductions').",
    "Staff paid days count a half-shift day as 0.5; for production, paid days are the shifts worked. Absent days include "
    "days of approved (unpaid) leave. Production employees have one slip per pay period - the Pay period column tells "
    "them apart.",
    "The PDF export prints the existing bulk salary slip layout (two slips per landscape page) unchanged. In that "
    "layout 'Total Earnings' shows gross pay before overtime, 'OT Hours' prints the overtime AMOUNT in rupees and "
    "'Date of Payment' is the day the PDF is printed; the single-slip PDF also prints DA/CA/EA/PTRL/TDS/LOP rows as "
    "fixed zeros because payroll stores none of them.",
]


def _slip_rows(ctx):
    return load_slips(ctx, full_modules=SLIP_FULL)


def _slip_run(ctx) -> ReportResult:
    loaded, notes = _slip_rows(ctx)
    rows = []
    for r in loaded:
        s, d = r.slip, r.d
        rows.append(
            {
                "slipNumber": s.slip_number,
                **emp_cells(s.employee),
                "employmentType": d["type"],
                "period": d["period"],
                "workingDays": d["working_days"],
                "paidDays": d["paid_days"],
                "absentDays": d["absent_days"],
                "lateDays": d["late_days"],
                "basic": d["basic"],
                "hra": None if d["production"] else d["hra"],
                "otherAllowances": None if d["production"] else d["other_allowances"],
                "otAmount": _blank_if_zero_production(d, "ot"),
                "totalEarnings": d["total_earnings"],
                "pfDeduction": d["pf"],
                "esiDeduction": d["esi"],
                "advanceDeduction": d["advance"],
                "otherDeductions": d["residual"],
                "totalDeductions": d["total_deductions"],
                "netPay": d["net"],
                "paymentStatus": status_text(r.payroll),
                "emailedAt": fmt_dt(s.emailed_at),
                "flag": "Provisional" if d["provisional"] else ("Legacy weekly" if d["legacy"] else None),
            }
        )
    paid = sum(1 for r in loaded if r.paid)
    summary = [
        {"label": "Salary slips", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": _employees(loaded), "format": "integer"},
        {"label": "Total earnings", "value": round(sum(x["totalEarnings"] for x in rows), 2), "format": "currency"},
        {"label": "Total deductions", "value": round(sum(x["totalDeductions"] for x in rows), 2), "format": "currency"},
        {"label": "Total net pay", "value": round(sum(x["netPay"] for x in rows), 2), "format": "currency"},
        {"label": "Paid slips", "value": paid, "format": "integer"},
        {"label": "Pending slips", "value": len(rows) - paid, "format": "integer"},
    ]
    all_notes = [*SLIP_NOTES, *notes]
    prov = provisional_note(loaded)
    if prov:
        all_notes.append(prov)
    if not rows:
        all_notes.append(
            "No salary slips exist for these filters. Slips appear after payroll has been generated for the month."
        )
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


def _read_only_document_settings():
    """(salary-slip document settings, payroll settings) WITHOUT creating either row.

    The stock ``build_bulk_salary_slip_pdf`` fetches both through ``.get()`` (get_or_create), so an export on a
    brand-new install would INSERT settings rows - a GET must never write. A missing row falls back to the model's
    defaults, which is exactly what the stock helper would have created and used."""
    from api.models import CompanyDocumentSettings, PayrollSettings

    kind = CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP
    ds = CompanyDocumentSettings.objects.filter(doc_type=kind).first() or CompanyDocumentSettings(doc_type=kind)
    ps = (
        PayrollSettings.objects.filter(pk=1).defer("company_logo", "authorized_signature", "signature_image").first()
        or PayrollSettings()
    )
    return ds, ps


def _build_slip_pdf(slips) -> bytes:
    """Same two-slips-per-landscape-page document as ``api.salary_slip_bulk_pdf.build_bulk_salary_slip_pdf`` (same page
    geometry, same per-slip layout function) with read-only settings, and with a visible notice - instead of a silently
    missing slip - for a slip that could not be laid out."""
    import io

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import BaseDocTemplate, Frame, FrameBreak, PageTemplate, Paragraph, Spacer

    from api import salary_slip_bulk_pdf as bulk
    from api.company_documents_views import _compact_salary_slip_flowables
    from api.document_pdf import _hex

    ds, ps = _read_only_document_settings()
    primary = _hex(ds.primary_color, "#0E4B3A")
    accent = _hex(ds.accent_color, "#C9A227")
    pad = bulk._FRAME_PADDING
    left = Frame(
        bulk._MARGIN_X,
        bulk._MARGIN_Y,
        bulk._HALF_W,
        bulk._CONTENT_H,
        id="left",
        leftPadding=pad,
        rightPadding=pad,
        topPadding=pad,
        bottomPadding=pad,
    )
    right = Frame(
        bulk._MARGIN_X + bulk._HALF_W + bulk._GAP,
        bulk._MARGIN_Y,
        bulk._HALF_W,
        bulk._CONTENT_H,
        id="right",
        leftPadding=pad,
        rightPadding=pad,
        topPadding=pad,
        bottomPadding=pad,
    )
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=bulk._MARGIN_X,
        rightMargin=bulk._MARGIN_X,
        topMargin=bulk._MARGIN_Y,
        bottomMargin=bulk._MARGIN_Y,
    )
    doc.addPageTemplates([PageTemplate(id="dual", frames=[left, right], onPage=bulk._draw_cut_line)])

    story: list = []
    failed: list[str] = []
    for i, s in enumerate(slips):
        try:
            flowables = _compact_salary_slip_flowables(s, ds, ps, primary, accent, col_width=bulk._COL_WIDTH)
        except Exception:  # one unprintable slip must not lose the others - but it must not vanish silently either
            failed.append(s.slip_number)
            continue
        if story:
            story.append(FrameBreak())
        story.extend(flowables)
    if failed:
        note = ParagraphStyle("SlipFail", fontSize=8, textColor=colors.HexColor("#b91c1c"))
        story.append(Spacer(1, 12))
        story.append(Paragraph("Could not be printed (open them one by one): " + ", ".join(failed), note))
    if not story:
        story = [Spacer(1, 1)]
    doc.build(story)
    return buffer.getvalue()


def _slip_pdf(ctx, out) -> bytes:
    """The real printable salary slips for exactly the slips the screen lists (same filters, same branch isolation),
    laid out by the existing slip layout function so the printed slip is never forked."""
    from ..export_pdf import build_pdf

    loaded, _notes = _slip_rows(ctx)
    if not loaded:
        return build_pdf(out)  # the standard "no records match" page
    if len(loaded) > MAX_SLIPS_PER_PDF:
        raise ReportParamError(
            f"This selection has {len(loaded)} salary slips - more than the {MAX_SLIPS_PER_PDF} that fit in one PDF. "
            "Narrow it by department, designation or employee and download again, or use the Excel export for the list.",
            "departmentIds",
        )
    return _build_slip_pdf([r.slip for r in loaded])


register(
    ReportSpec(
        id="salary-slip",
        title="Salary Slips",
        description="Every salary slip for a month with earnings, deductions and net pay. The PDF prints the actual slips.",
        category=CATEGORY,
        modules=SLIP_MODULES,
        icon="Receipt",
        tags=("payslip", "pay slip", "salary", "wages", "print", "net pay"),
        filters=(
            period(default="lastMonth"),
            *scope(status=None),
            payment_filter(),
            legacy_filter(),
        ),
        columns=(
            ColumnSpec("slipNumber", "Slip no.", TEXT, 2.0),
            *EMP_COLS,
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("period", "Pay period", TEXT, 2.0),
            ColumnSpec("workingDays", "Working days", INTEGER, 0.8),
            ColumnSpec("paidDays", "Paid days", NUMBER, 0.8),
            ColumnSpec("absentDays", "Absent days", NUMBER, 0.8),
            ColumnSpec("lateDays", "Late days", INTEGER, 0.7),
            _cur("basic", "Basic"),
            _cur("hra", "HRA"),
            _cur("otherAllowances", "Other allowances"),
            _cur("otAmount", "OT wages"),
            _cur("totalEarnings", "Total earnings"),
            _cur("pfDeduction", "PF"),
            _cur("esiDeduction", "ESI"),
            _cur("advanceDeduction", "Advance"),
            _cur("otherDeductions", "Late / other deductions"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay"),
            ColumnSpec("paymentStatus", "Payment", BADGE, 1.0),
            ColumnSpec("emailedAt", "Emailed", "datetime", 1.5),
            ColumnSpec("flag", "Flag", BADGE, 1.1),
        ),
        run=_slip_run,
        pdf_builder=_slip_pdf,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-register
# ═════════════════════════════════════════════════════════════════════════════

REGISTER_SUM = (
    "basic",
    "hra",
    "otherAllowances",
    "otAmount",
    "totalEarnings",
    "pfDeduction",
    "esiDeduction",
    "advanceDeduction",
    "lateDeduction",
    "totalDeductions",
    "netPay",
)


def _register_run(ctx) -> ReportResult:
    group = ctx.param("groupBy", "department")
    loaded, notes = load_slips(ctx, order="dept" if group == "department" else "code")
    if group == "employmentType":
        loaded.sort(
            key=lambda r: (
                r.d["type"],
                (r.slip.employee.department.name if r.slip.employee.department_id else "").lower(),
                nat_key(r.slip.employee.employee_code),
                r.slip.period_start or date.min,
                r.slip.id,
            )
        )
    rows = []
    for r in loaded:
        s, d = r.slip, r.d
        rows.append(
            {
                **emp_cells(s.employee),
                "employmentType": d["type"],
                "joinDate": iso(s.employee.join_date),
                "period": d["period"],
                "monthlyRate": d["monthly_rate"],
                "workingDays": d["working_days"],
                "paidDays": d["paid_days"],
                "absentDays": d["absent_days"],
                "basic": d["basic"],
                "hra": None if d["production"] else d["hra"],
                "otherAllowances": None if d["production"] else d["other_allowances"],
                "otAmount": _blank_if_zero_production(d, "ot"),
                "totalEarnings": d["total_earnings"],
                "pfDeduction": d["pf"],
                "esiDeduction": d["esi"],
                "advanceDeduction": d["advance"],
                "lateDeduction": d["late"],
                "totalDeductions": d["total_deductions"],
                "netPay": d["net"],
                "paymentStatus": status_text(r.payroll),
            }
        )
    if group == "department":
        rows = subtotals(rows, lambda r: r["department"], REGISTER_SUM)
    elif group == "employmentType":
        rows = subtotals(rows, lambda r: r["employmentType"], REGISTER_SUM)
    data = [r for r in rows if r.get("_kind") != "subtotal"]

    def col(key):
        return round(sum(x[key] or 0 for x in data), 2)

    summary = [
        {"label": "Employees paid", "value": _employees(loaded), "format": "integer"},
        {"label": "Salary slips", "value": len(data), "format": "integer"},
        {"label": "Total earnings", "value": col("totalEarnings"), "format": "currency"},
        {"label": "Overtime", "value": col("otAmount"), "format": "currency"},
        {
            "label": "PF + ESI (employee)",
            "value": round(col("pfDeduction") + col("esiDeduction"), 2),
            "format": "currency",
        },
        {"label": "Advance recovered", "value": col("advanceDeduction"), "format": "currency"},
        {"label": "Late deductions", "value": col("lateDeduction"), "format": "currency"},
        {"label": "Total net pay", "value": col("netPay"), "format": "currency"},
    ]
    all_notes = [
        "One row per salary slip. Production employees are paid per pay period and can appear more than once in a month "
        "(see the Period column); production slips belong to the month their pay period ends in. 'Employees paid' "
        "counts each person once.",
        "Monthly / shift rate is the stored monthly salary for staff and the rate per shift for production. Paid days for "
        "production are shifts worked. Total earnings = gross pay + overtime (overtime is outside PF and ESI wages).",
        "Late deduction comes from the slip's late-detection snapshot and is blank for production slips generated with "
        "Production Late Detection switched off. Loss of pay is not a deduction line: it is already reduced from the "
        "pro-rated gross (see the Salary & Wages Statement).",
        "Employees who have since left are included. This report only reads stored slips - it never generates payroll.",
        *notes,
    ]
    prov = provisional_note(loaded)
    if prov:
        all_notes.append(prov)
    if not rows:
        all_notes.append("No salary slips exist for these filters. Generate payroll for the month first.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="salary-register",
        title="Salary / Wage Register",
        description="Monthly wage register: days, earnings heads, deductions and net pay per employee with department subtotals.",
        category=CATEGORY,
        modules=BOTH,
        icon="FileSpreadsheet",
        tags=("wage register", "salary register", "payroll register", "muster", "statement"),
        filters=(
            period(default="lastMonth"),
            *scope(status="all"),
            payment_filter(),
            legacy_filter(),
            select(
                "groupBy",
                "Group by",
                [("department", "Department"), ("employmentType", "Staff / production"), ("none", "No grouping")],
                default="department",
                placeholder="Department",
            ),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("joinDate", "Join date", DATE, 1.3),
            ColumnSpec("period", "Period", TEXT, 1.9),
            _cur("monthlyRate", "Monthly / shift rate", total=None),
            ColumnSpec("workingDays", "Working days", INTEGER, 1.0),
            ColumnSpec("paidDays", "Paid days / shifts", NUMBER, 1.0),
            ColumnSpec("absentDays", "Absent days", NUMBER, 0.9),
            _cur("basic", "Basic"),
            _cur("hra", "HRA"),
            _cur("otherAllowances", "Other allowances"),
            _cur("otAmount", "OT wages"),
            _cur("totalEarnings", "Total earnings", 1.5),
            _cur("pfDeduction", "PF"),
            _cur("esiDeduction", "ESI"),
            _cur("advanceDeduction", "Advance"),
            _cur("lateDeduction", "Late deduction"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay", 1.5),
            ColumnSpec("paymentStatus", "Payment", BADGE, 1.1),
        ),
        run=_register_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-wages-statement
# ═════════════════════════════════════════════════════════════════════════════

DA_NOTE = (
    "DA (Dearness Allowance) and Retaining Allowance are NOT tracked in this HRMS, so they cannot be reported. Payroll "
    "stores Basic (50% of salary), HRA (20%) and one 'Allowances' balance (the remaining 30%); the Allowances columns "
    "below therefore combine DA, retaining allowance and every other allowance. No DA / Retaining Allowance column is "
    "shown because no such figure exists."
)
WAGES_SUM = (
    "basicFixed",
    "hraFixed",
    "allowancesFixed",
    "basicEarned",
    "hraEarned",
    "allowancesEarned",
    "incentives",
    "otAmount",
    "totalEarnings",
    "lopAmount",
)


def _wages_run(ctx) -> ReportResult:
    loaded, notes = load_slips(ctx, order="dept")
    rows = []
    fixed_bill = ZERO
    no_snapshot = 0
    for r in loaded:
        s, d = r.slip, r.d
        production = d["production"]
        basic_fixed = hra_fixed = allow_fixed = None
        if not production and d["monthly_rate"] is not None:
            monthly = Decimal(str(d["monthly_rate"]))
            b = _d2(monthly * BASIC_SHARE)
            h = _d2(monthly * HRA_SHARE)
            basic_fixed, hra_fixed, allow_fixed = float(b), float(h), float(monthly - b - h)
            fixed_bill += monthly
        elif not production:
            no_snapshot += 1
        rows.append(
            {
                **emp_cells(s.employee),
                "employmentType": d["type"],
                "period": d["period"],
                "monthlyRate": d["monthly_rate"],
                "workingDays": d["working_days"],
                "paidDays": d["paid_days"],
                "basicFixed": basic_fixed,
                "hraFixed": hra_fixed,
                "allowancesFixed": allow_fixed,
                "basicEarned": d["basic"],
                "hraEarned": None if production else d["hra"],
                "allowancesEarned": None if production else d["allowances_only"],
                "incentives": None if production and not d["incentives_bonus"] else d["incentives_bonus"],
                "otAmount": _blank_if_zero_production(d, "ot"),
                "totalEarnings": d["total_earnings"],
                "lopAmount": d["lop"],
            }
        )
    rows = subtotals(rows, lambda r: r["department"], WAGES_SUM)
    data = [x for x in rows if x.get("_kind") != "subtotal"]

    def col(key):
        return round(sum(x[key] or 0 for x in data), 2)

    summary = [
        {"label": "Fixed monthly wage bill (staff)", "value": round(float(fixed_bill), 2), "format": "currency"},
        {"label": "Basic earned", "value": col("basicEarned"), "format": "currency"},
        {"label": "HRA earned", "value": col("hraEarned"), "format": "currency"},
        {"label": "Allowances earned (combined)", "value": col("allowancesEarned"), "format": "currency"},
        {"label": "Overtime", "value": col("otAmount"), "format": "currency"},
        {"label": "Total earnings", "value": col("totalEarnings"), "format": "currency"},
        {"label": "Loss of pay", "value": col("lopAmount"), "format": "currency"},
    ]
    all_notes = [
        DA_NOTE,
        "Fixed heads = the monthly salary split 50% Basic / 20% HRA / 30% Allowances (the payroll engine's fixed split, "
        "not the Compensation page percentages). Earned heads are what the slip paid after pro-rating for attendance. "
        "Loss of pay = monthly salary - gross pay (staff only); it is not a separate deduction on the slip.",
        "Production employees are paid shifts x rate, so they have no fixed or per-head split: their earnings are shown "
        "under Basic earned and the rate column holds the rate per shift. Incentives / bonus are stored on the slip but "
        "the payroll engine does not generate them, so they are normally blank.",
        *notes,
    ]
    if no_snapshot:
        all_notes.append(
            f"{no_snapshot} staff slip(s) carry no salary snapshot (generated by an older version): their fixed heads and "
            "loss of pay are left blank rather than guessed from today's salary."
        )
    prov = provisional_note(loaded)
    if prov:
        all_notes.append(prov)
    if not rows:
        all_notes.append("No salary slips exist for these filters. Generate payroll for the month first.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="salary-wages-statement",
        title="Salary & Wages Statement",
        description="Basic, HRA and combined allowances - fixed vs earned - with overtime and loss of pay per employee.",
        category=CATEGORY,
        modules=BOTH,
        icon="Calculator",
        tags=("basic", "hra", "da", "retaining allowance", "allowances", "wages", "earnings", "loss of pay", "lop"),
        filters=(period(default="lastMonth"), *scope(status="all"), payment_filter(), legacy_filter()),
        columns=(
            *EMP_COLS,
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("period", "Period", TEXT, 1.8),
            _cur("monthlyRate", "Monthly / shift rate", total=None),
            # Working days is shown so the sheet is a wide statement (19 columns): the PDF exporter prints reports of more
            # than 18 columns on landscape A3, where the money columns and their totals fit without wrapping.
            ColumnSpec("workingDays", "Working days", INTEGER, 1.0),
            ColumnSpec("paidDays", "Paid days / shifts", NUMBER, 1.0),
            _cur("basicFixed", "Basic (fixed)"),
            _cur("hraFixed", "HRA (fixed)"),
            _cur("allowancesFixed", "Allowances (fixed)"),
            _cur("basicEarned", "Basic (earned)"),
            _cur("hraEarned", "HRA (earned)"),
            _cur("allowancesEarned", "Allowances (earned)"),
            _cur("incentives", "Incentives / bonus"),
            _cur("otAmount", "OT wages"),
            _cur("totalEarnings", "Total earnings"),
            _cur("lopAmount", "Loss of pay"),
        ),
        run=_wages_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  production-wage-sheet
# ═════════════════════════════════════════════════════════════════════════════

PRODUCTION_SUM = (
    "daysWorked",
    "daysAbsent",
    "totalShifts",
    "extraShifts",
    "grossWages",
    "pfDeduction",
    "esiDeduction",
    "advanceDeduction",
    "lateDeduction",
    "totalDeductions",
    "netPay",
)


def _month_pairs(a: date, b: date) -> list[tuple[int, int]]:
    out, cur = [], date(a.year, a.month, 1)
    while cur <= b:
        out.append((cur.year, cur.month))
        cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


def _extra_shifts(breakdown) -> float | None:
    days = breakdown.get("days") if isinstance(breakdown, dict) else None
    if not isinstance(days, list):
        return None
    total = 0.0
    for day in days:
        v = day.get("shiftsEarned") if isinstance(day, dict) else None
        if isinstance(v, (int, float)) and v > 1:
            total += v - 1
    return round(total, 2)


def _pf_rule_label(d: dict) -> str | None:
    rule = d["ded"].get("pfEfRule") if d["ded"] else None
    if isinstance(rule, dict) and rule.get("label"):
        return str(rule["label"])
    if d["pf"] or d["esi"]:
        return "Flat rates"
    return None


def _production_window(ctx) -> Q:
    a, b = ctx.date_from, ctx.date_to
    q = Q(period_end__gte=a, period_end__lte=b)
    if ctx.params.get(LEGACY_KEY):
        # legacy weekly slips have no period dates: place them by their calendar month
        q |= Q(period_start__isnull=True, week_number__isnull=False) & pairs_q(_month_pairs(a, b))
    return q


def _production_run(ctx) -> ReportResult:
    loaded, notes = load_slips(
        ctx,
        force_kind="production",
        full_breakdown=True,
        order="dept",
        extra_q=_production_window(ctx),
        month_filter=False,
    )
    rows = []
    for r in loaded:
        s, d = r.slip, r.d
        bd = s.breakdown_details if isinstance(s.breakdown_details, dict) else {}
        summary = d["summary"]
        worked = summary.get("daysWorked")
        absent = summary.get("daysAbsent")
        rows.append(
            {
                **emp_cells(s.employee),
                "periodStart": s.period_start.isoformat() if s.period_start else None,
                "periodEnd": s.period_end.isoformat() if s.period_end else None,
                "weekNumber": s.week_number,
                "daysWorked": worked if isinstance(worked, int) else None,
                "daysAbsent": absent if isinstance(absent, int) else float(s.absent_days),
                "totalShifts": d["paid_days"],
                "extraShifts": _extra_shifts(bd),
                "ratePerShift": d["monthly_rate"],
                "grossWages": d["gross"],
                "pfDeduction": d["pf"],
                "esiDeduction": d["esi"],
                "advanceDeduction": d["advance"],
                "lateDeduction": d["late"],
                "totalDeductions": d["total_deductions"],
                "netPay": d["net"],
                "pfRule": _pf_rule_label(d),
                "paymentStatus": status_text(r.payroll),
            }
        )
    rows = subtotals(rows, lambda r: r["department"], PRODUCTION_SUM)
    data = [x for x in rows if x.get("_kind") != "subtotal"]

    def col(key):
        return round(sum(x[key] or 0 for x in data), 2)

    employees = _employees(loaded)
    summary = [
        {"label": "Employees", "value": employees, "format": "integer"},
        {"label": "Total shifts", "value": col("totalShifts"), "format": "number"},
        {"label": "Extra shifts (included)", "value": col("extraShifts"), "format": "number"},
        {"label": "Gross wages", "value": col("grossWages"), "format": "currency"},
        {"label": "Total deductions", "value": col("totalDeductions"), "format": "currency"},
        {"label": "Total net pay", "value": col("netPay"), "format": "currency"},
        {
            "label": "Average shifts per employee",
            "value": round(col("totalShifts") / employees, 2) if employees else None,
            "format": "number",
        },
    ]
    all_notes = [
        "Slips are listed by the date their pay period ends. An employee has one slip per pay period; wages = shifts x "
        "rate per shift. Shifts come from the slip's stored day-by-day breakdown (a production day earns up to 1.50).",
        "Extra shifts = the part of a day's shift value above 1.00 (the production 'extra' shift). It is production's "
        "analogue of overtime and is ALREADY inside total shifts and gross wages - it is not paid separately.",
        "PF / ESI: the payroll engine picks the salary-range rule (or flat rate) from the period's gross x 2 as the "
        "monthly equivalent, whatever the period length; the PF/ESI rule column shows what was applied. Advance "
        "recoveries belong to the month the period ends in.",
        "Late deduction is blank where Production Late Detection was switched off when the slip was generated.",
        *notes,
    ]
    if not rows:
        all_notes.append("No production slips exist for these dates. Generate production payroll for the period first.")
    return ReportResult(rows=rows, summary=summary, notes=all_notes)


register(
    ReportSpec(
        id="production-wage-sheet",
        title="Production Wage Sheet",
        description="Period-wise production wages: days worked, shifts, extra shifts, rate, gross, deductions and net pay.",
        category=CATEGORY,
        modules=("production_payroll", "payroll"),
        icon="Layers",
        tags=("production", "shift", "weekly wages", "piece", "wage sheet", "extra shift"),
        filters=(
            date_range(default="lastMonth", label="Pay period ends between", max_days=400),
            *scope(status=None, employment=False),
            payment_filter(),
            legacy_filter(),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("periodStart", "Period start", DATE, 1.1),
            ColumnSpec("periodEnd", "Period end", DATE, 1.1),
            ColumnSpec("weekNumber", "Legacy week", INTEGER, 0.7),
            ColumnSpec("daysWorked", "Days worked", INTEGER, 0.8, total="sum"),
            ColumnSpec("daysAbsent", "Days absent", NUMBER, 0.8, total="sum"),
            ColumnSpec("totalShifts", "Total shifts", NUMBER, 0.9, total="sum"),
            ColumnSpec("extraShifts", "Extra shifts", NUMBER, 0.9, total="sum"),
            _cur("ratePerShift", "Rate per shift", total=None),
            _cur("grossWages", "Gross wages"),
            _cur("pfDeduction", "PF"),
            _cur("esiDeduction", "ESI"),
            _cur("advanceDeduction", "Advance"),
            _cur("lateDeduction", "Late deduction"),
            _cur("totalDeductions", "Total deductions"),
            _cur("netPay", "Net pay"),
            ColumnSpec("pfRule", "PF / ESI rule", TEXT, 1.3),
            ColumnSpec("paymentStatus", "Payment", BADGE, 1.0),
        ),
        run=_production_run,
    )
)
