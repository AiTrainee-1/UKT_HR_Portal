"""HR Reports (category ``hr``): hr-salary-statement, the company's printed Salary Statement.

The printed register is one line per employee under a department heading, serial numbers running on across the
departments, with the money of the whole statement added up at the end. The Payroll page already builds exactly that
statement (GET /api/payroll/salary-statement, ``api.payroll_statement_views``). This report does NOT work any figure out
itself: it reads the same payroll rows and calls the same builder (``statement_rows``), the same department grouping
and serial numbering (``_groups``), the same column labels (``staff_columns``) and the same explanatory notes
(``statement_notes``), so the Report Center and Payroll > Salary Statement can never disagree.

Only employees that HAVE a generated staff payroll for the month are listed. Nobody is invented for an employee payroll
has not been run for: the notes say how many active staff in scope have none yet. Production pay is paid per pay cycle,
has its own columns and stays on Production Payroll > Salary Statement.

Salary and deductions are printed, so the report is gated on the ``payroll`` module exactly like the statement endpoint.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace

from django.db.models import Exists, OuterRef

from api.models import Employee, Payroll
from api.payroll_insights import KIND_STAFF, ddmmyyyy, parse_iso_date, staff_period
from api.payroll_statement_views import NO_DEPARTMENT, _groups, staff_columns, statement_notes, statement_rows

from .. import filters as F
from ..common import with_subtotals
from ..formatting import month_bounds
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import CURRENCY, INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_master_base import join_date_of

CATEGORY = "hr"
# The statement endpoint is gated on the payroll module alone; so is this report. (The Salary module is the employee's
# salary structure: it does not grant the pay actually earned and deducted that this statement prints.)
MODULES = ("payroll",)

# The printed statement adds up these columns, and only these (its grand total prints no Basic, Total or day counts).
SUM_KEYS = (
    "petrol",
    "othersAllow",
    "eSalary",
    "tAdvance",
    "advance",
    "esi",
    "pf",
    "tds",
    "others",
    "totalDeduction",
    "net",
)

_TYPE_OF_FORMAT = {"int": INTEGER, "days": NUMBER, "money": CURRENCY, "text": TEXT}

PAYROLL_RELATIONS = ("employee", "employee__department", "employee__designation", "employee__branch")
PAYMENT_OPTIONS = ((Payroll.STATUS_PENDING, "Pending"), (Payroll.STATUS_PAID, "Cleared"))


def _columns() -> tuple[ColumnSpec, ...]:
    """The statement's own columns (labels, order, widths), typed for the Report Center."""
    out = []
    for c in staff_columns():
        out.append(
            ColumnSpec(
                c["key"],
                c["label"],
                _TYPE_OF_FORMAT[c["format"]],
                c["weight"],
                total="sum" if c["key"] in SUM_KEYS else None,
                align=c["align"],
            )
        )
    return tuple(out)


COLUMNS = _columns()
VALUE_KEYS = [c.key for c in COLUMNS if c.key != "sno"]


def _no_payroll_count(ctx, year: int, month: int) -> int:
    """Active staff in the report's scope (branch, department, designation, employee) who joined by the end of the month
    and have no monthly payroll for it. The employee-status filter does not apply: this counts active people only."""
    params = {k: v for k, v in ctx.params.items() if k not in ("employee_status", "employment_type")}
    scope_q = dataclasses.replace(ctx, params=params).emp_q()
    has_payroll = Payroll.objects.filter(
        employee_id=OuterRef("pk"), salary_mode=Payroll.SALARY_MODE_MONTHLY, month=month, year=year
    )
    missing = (
        Employee.objects.filter(scope_q, status="active", employment_type="staff")
        .annotate(has_payroll=Exists(has_payroll))
        .filter(has_payroll=False)
        .values_list("join_date", flat=True)
    )
    _first, last = month_bounds(year, month)

    count = 0
    for text in missing:
        joined, _state = join_date_of(SimpleNamespace(join_date=text))  # it only reads the text field
        if joined is None or joined <= last:  # an unreadable / missing date counts: nothing says they had not joined
            count += 1
    return count


def _run(ctx) -> ReportResult:
    year, month = ctx.period
    info = staff_period(month, year)

    # photo_url is often a ~43 KB base64 data URI and password_hash is a secret: a statement needs neither
    qs = (
        Payroll.objects.select_related(*PAYROLL_RELATIONS)
        .defer("employee__photo_url", "employee__password_hash")
        .filter(ctx.emp_q("employee__"), salary_mode=Payroll.SALARY_MODE_MONTHLY, month=month, year=year)
    )
    payment = ctx.params.get("paymentStatus")
    if payment:
        qs = qs.filter(status=payment)
    payrolls = list(qs.order_by("employee__first_name", "employee__last_name", "id")[: ctx.row_limit])

    values, no_slip, mismatched = statement_rows(payrolls, KIND_STAFF, info)
    groups = _groups(payrolls, values, staff_columns())

    rows: list[dict] = []
    for group in groups:
        band = group["label"]
        rows.append({"name": band, "_kind": KIND_SUBTOTAL})  # the department heading line
        body = [{**r["values"]} for r in group["rows"]]
        rows.extend(
            with_subtotals(
                body,
                group_by=lambda _r, band=band: band,
                sum_keys=SUM_KEYS,
                label_key="name",
                label=lambda g: f"{g} Sub total",
            )
        )

    data = [r for r in rows if r.get("_kind") is None]
    paid = sum(1 for p in payrolls if p.status == Payroll.STATUS_PAID)

    def total(key: str) -> float:
        return round(sum(r[key] for r in data), 2)

    summary = [
        {"label": "Employees listed", "value": len(payrolls), "format": "integer"},
        {"label": "Departments", "value": len(groups), "format": "integer"},
        {"label": "E salary", "value": total("eSalary"), "format": "currency"},
        {"label": "Total deduction", "value": total("totalDeduction"), "format": "currency"},
        {"label": "Net pay", "value": total("net"), "format": "currency"},
        {"label": "Cleared", "value": paid, "format": "integer"},
        {"label": "Pending", "value": len(payrolls) - paid, "format": "integer"},
    ]

    notes = [
        f"Salary Statement From {ddmmyyyy(parse_iso_date(info['start']))} To {ddmmyyyy(parse_iso_date(info['end']))}: "
        "staff monthly payroll, one line per employee under the department heading, in employee-code order, with the "
        "serial number running on across departments. These are the same figures as Payroll > Salary Statement.",
        "Sub totals and the total line add up the money columns of the printed statement (PTRL to NET). Basic, Total, the "
        "day columns and Lop& PSAmt are not added up, as on the printed sheet.",
        "Only employees whose payroll has been generated for the month are listed (the saved payroll is read; nothing is "
        "calculated or saved here). Production workers are paid per pay cycle and are on Production Payroll > Salary "
        "Statement.",
        *statement_notes(KIND_STAFF, no_slip, mismatched),
    ]
    missing = _no_payroll_count(ctx, year, month)
    if missing:
        notes.append(
            f"{missing} active staff member(s) in this selection have no payroll generated for this month and are not "
            "listed. Generate the month's payroll on Payroll to include them."
        )
    if not payrolls:
        notes.append("No staff payroll has been generated for this month and selection.")
    if any(g["label"].startswith(NO_DEPARTMENT) for g in groups):
        notes.append(f"Employees with no department are listed under '{NO_DEPARTMENT}', last.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="hr-salary-statement",
        title="Salary Statement",
        description="The printed monthly Salary Statement: every employee's salary, days, allowances, deductions and NET "
        "under their department, with sub totals and a grand total.",
        category=CATEGORY,
        modules=MODULES,
        icon="FileSpreadsheet",
        tags=(
            "salary",
            "statement",
            "payroll",
            "net",
            "pf",
            "esi",
            "tds",
            "advance",
            "department",
            "printed",
            "register",
        ),
        filters=(
            F.period(default="lastMonth", label="Month"),
            *F.scope(employment=False, status="all"),
            F.select(
                "paymentStatus",
                "Payment status",
                PAYMENT_OPTIONS,
                placeholder="Cleared and pending",
            ),
        ),
        columns=COLUMNS,
        run=_run,
        landscape=True,
        screen_limit=5_000,
        pdf_max_rows=3_000,
    )
)
