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

PF, ESI & TDS details (owner 2026-11-04: "the PF, ESI and TDS deduction details must be in the PDF and Excel"): the
statement's ESI / PF / TDS columns are 0 for everybody outside Co Emp and the TDS list, so the few real deductions are easy
to miss among a hundred-odd rows. The exports add a section of their own (a second Excel sheet, a further PDF page): one line
per employee in Co Emp or on the TDS list (or with any PF / ESI / TDS on the slip), with the wages, the rates and the
amounts as the payroll stored them in the slip (``breakdown_details.deductions.statutory``), and their totals.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace

from decimal import Decimal

from django.db.models import Exists, OuterRef

from api.models import Employee, Payroll
from api.payroll_insights import KIND_STAFF, ddmmyyyy, parse_iso_date, slip_key, slips_for, staff_period
from api.payroll_statement_views import NO_DEPARTMENT, _groups, staff_columns, statement_notes, statement_rows

from .. import filters as F
from ..common import with_subtotals
from ..formatting import month_bounds
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import CURRENCY, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSection, ReportSpec
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


# ── PF, ESI & TDS details ────────────────────────────────────────────────────

STATUTORY_TITLE = "PF, ESI & TDS details"
STATUTORY_COLUMNS = (
    ColumnSpec("sno", "SNO", INTEGER, 0.6, align="center"),
    ColumnSpec("code", "ID NO", TEXT, 1.0),
    ColumnSpec("name", "Name", TEXT, 2.6),
    ColumnSpec("department", "Department", TEXT, 1.8),
    ColumnSpec("category", "Covered by", TEXT, 1.3),
    ColumnSpec("wages", "PF / ESI wages", CURRENCY, 1.4),
    ColumnSpec("pfRate", "PF %", PERCENT, 0.8),
    ColumnSpec("pf", "PF", CURRENCY, 1.3, total="sum"),
    ColumnSpec("esiRate", "ESI %", PERCENT, 0.8),
    ColumnSpec("esi", "ESI", CURRENCY, 1.3, total="sum"),
    ColumnSpec("tdsRate", "TDS %", PERCENT, 0.8),
    ColumnSpec("tdsBase", "TDS on (pay earned)", CURRENCY, 1.4),
    ColumnSpec("tds", "TDS", CURRENCY, 1.3, total="sum"),
    ColumnSpec("total", "PF + ESI + TDS", CURRENCY, 1.4, total="sum"),
    ColumnSpec("how", "How it was worked out", TEXT, 3.2),
)
_COVER = {"co_emp": "Co Emp", "tds": "TDS list"}


def _num(value) -> Decimal | None:
    try:
        return None if value is None or isinstance(value, bool) else Decimal(str(value))
    except Exception:
        return None


def _money(value: Decimal | None) -> float:
    return float((value or Decimal("0")).quantize(Decimal("0.01")))


def _plain(value: Decimal | None) -> str:
    if value is None:
        return ""
    text = f"{value.normalize():f}"
    return text


def statutory_rows(payrolls: list, values: list[dict]) -> list[dict]:
    """One line per employee in Co Emp or on the TDS list (or with any PF / ESI / TDS on the slip), in the statement's
    order, with the wages, rates and amounts the payroll stored in the slip. `values` = the statement's own rows (for
    the order and the department), keyed by payroll id. One query (the slips)."""
    slips = slips_for(payrolls)
    by_id = {p.id: p for p in payrolls}
    out = []
    for v in values:
        p = by_id.get(v.get("_payrollId"))
        if p is None:
            continue
        emp = p.employee
        slip = slips.get(slip_key(p))
        ded = ((slip.breakdown_details or {}).get("deductions") or {}) if slip is not None else {}
        stat = ded.get("statutory") if isinstance(ded.get("statutory"), dict) else {}
        pf = _num(slip.pf_deduction) if slip is not None else Decimal("0")
        esi = _num(slip.esi_deduction) if slip is not None else Decimal("0")
        tds = _num(p.tds_deduction) or Decimal("0")
        category = stat.get("category") or (
            "co_emp" if getattr(emp, "co_emp_enabled", False) else "tds" if getattr(emp, "tds_enabled", False) else ""
        )
        if category not in _COVER and not (pf or esi or tds):
            continue
        wages = _num(stat.get("pfWages"))
        if wages is None and slip is not None and (pf or esi):
            wages = _num(slip.basic)  # an older slip without the statutory block
        pf_rule = stat.get("pfRule") if isinstance(stat.get("pfRule"), dict) else None
        esi_rule = stat.get("esiRule") if isinstance(stat.get("esiRule"), dict) else None
        pf_rate = _num(pf_rule.get("ratePercent")) if pf_rule else _num(ded.get("pfRate")) if pf else None
        esi_rate = _num(esi_rule.get("ratePercent")) if esi_rule else _num(ded.get("esiRate")) if esi else None
        tds_block = stat.get("tds") if isinstance(stat.get("tds"), dict) else None
        tds_rate = _num(ded.get("tdsPercent"))
        if tds_rate is None and tds_block:
            tds_rate = _num(tds_block.get("percent"))
        if tds_rate is None:
            tds_rate = _num(p.tds_percent)
        tds_base = _num(tds_block.get("base")) if tds_block else (_num(p.gross_salary) if tds else None)

        how = []
        if category == "co_emp":
            basis = "Basic + DA + Retaining Allowance (prorated)"
            if pf_rule:
                how.append(f"PF {_plain(pf_rate)}% of {basis}")
            else:
                how.append("No PF rule matched the salary")
            if esi_rule:
                how.append(f"ESI {_plain(esi_rate)}%")
            else:
                how.append("no ESI rule matched the salary")
        if tds_rate is not None and (tds or category == "tds"):
            how.append(f"TDS {_plain(tds_rate)}% of the pay earned")
        if stat.get("reason"):
            how.append(str(stat["reason"]))
        out.append(
            {
                "code": v.get("code") or emp.employee_code,
                "name": v.get("name") or f"{emp.first_name} {emp.last_name}".strip(),
                "department": emp.department.name if emp.department_id and emp.department else "",
                "category": _COVER.get(category, "-"),
                "wages": _money(wages) if wages is not None else None,
                "pfRate": float(pf_rate) if pf_rate is not None else None,
                "pf": _money(pf),
                "esiRate": float(esi_rate) if esi_rate is not None else None,
                "esi": _money(esi),
                "tdsRate": float(tds_rate) if tds_rate is not None else None,
                "tdsBase": _money(tds_base) if tds_base is not None else None,
                "tds": _money(tds),
                "total": _money((pf or 0) + (esi or 0) + tds),
                "how": "; ".join(how),
            }
        )
    for i, r in enumerate(out, start=1):
        r["sno"] = i
    return out


def statutory_section(payrolls: list, values: list[dict]) -> ReportSection:
    rows = statutory_rows(payrolls, values)
    co_emp = sum(1 for r in rows if r["category"] == "Co Emp")
    tds_list = sum(1 for r in rows if r["category"] == "TDS list")
    totals = {k: round(sum(r[k] for r in rows), 2) for k in ("pf", "esi", "tds", "total")}
    notes = [
        f"{len(rows)} of the {len(payrolls)} employees on this statement have PF, ESI or TDS: {co_emp} in Co Emp "
        f"(Employees > Co Emp) and {tds_list} on the TDS list. Everybody else has none, so their ESI, PF and TDS "
        "columns on the statement are 0.",
        "PF and ESI are taken from Co Emp employees only, by the rules of Settings > PF & ESI, from Basic + DA + Retaining "
        "Allowance (the first portion of the salary, prorated for the days paid). TDS is taken from employees on the TDS "
        "list only: their TDS percentage of the pay earned.",
        "The figures are the ones payroll saved when it was generated. A change to Co Emp, the TDS list or the rules shows "
        "here only after the month's payroll is generated again.",
    ]
    if not any(r["tds"] for r in rows) and not tds_list:
        notes.append("No employee is on the TDS list for this month, so no TDS was deducted.")
    return ReportSection(
        title=STATUTORY_TITLE,
        columns=STATUTORY_COLUMNS,
        rows=rows,
        totals=totals if rows else None,
        notes=notes,
        sheet="PF ESI TDS",
        empty="No employee on this statement is in Co Emp or on the TDS list, so nobody has PF, ESI or TDS this month.",
    )


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
    ordered = [{**r["values"], "_payrollId": r["payrollId"]} for group in groups for r in group["rows"]]

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
    # the PF / ESI / TDS lines get a section of their own in the files (the screen keeps the statement as printed)
    sections = [statutory_section(payrolls, ordered)] if ctx.purpose in ("xlsx", "pdf") else []
    return ReportResult(rows=rows, summary=summary, notes=notes, sections=sections)


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
