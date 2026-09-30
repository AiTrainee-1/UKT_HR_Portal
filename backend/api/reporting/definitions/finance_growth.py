"""Growth & benefit reports: statutory bonus, salary increments, promotions.

* ``bonus-register``      one row per employee per financial year (``Bonus``), as generated on the Bonus page.
* ``increment-history``   every recorded salary revision (``SalaryIncrement``): previous / new pay and percent.
* ``promotion-history``   every recorded promotion (``Promotion``): previous / new designation and department.

All three read the stored rows - nothing is recalculated - so a report always agrees with the Bonus,
Increment and Promotion screens. Each is scoped through the employee's branch, and none of them filters on the
employee's current status: an employee who has since left still appears in the history.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import replace

from django.db.models import F, Q, Value
from django.db.models.functions import Coalesce

from api.models import Bonus, Promotion, SalaryIncrement

from ..common import EMP_COLS, EMP_COLS_SHORT, emp_cells, with_subtotals
from ..filters import ReportContext, scope, select
from ..formatting import fmt_dt, r2
from ..registry import register
from ..types import BADGE, CURRENCY, DATE, DATETIME, INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .finance_common import (
    date_bounds,
    describe_bounds,
    distinct_groups,
    financial_year_filter,
    group_subtotals,
    ist_date_iso,
    natural_key,
    pretty,
    window_filter,
)

BONUS_STATUS_OPTIONS = (("calculated", "Calculated"), ("approved", "Approved"), ("paid", "Paid"))
BONUS_STATUS_LABELS = {"calculated": "Calculated", "approved": "Approved", "paid": "Paid"}


def _dept_name(row: dict) -> str:
    return row.get("department") or "Unassigned"


def _sum(values) -> float:
    return round(sum(v for v in values if v is not None), 2)


def _fy_sort_key(label: str | None) -> int:
    """Newest financial year first: '2025-26' sorts before '2024-25'."""
    try:
        return -int(str(label)[:4])
    except (TypeError, ValueError):
        return 0


# ═════════════════════════════════════════════════════════════════════════════
#  bonus-register
# ═════════════════════════════════════════════════════════════════════════════


def _bonus_run(ctx: ReportContext) -> ReportResult:
    p = ctx.params
    qs = Bonus.objects.select_related("employee__department", "employee__designation").filter(ctx.emp_q("employee__"))
    if p.get("financialYear"):
        qs = qs.filter(financial_year__in=p["financialYear"])
    if p.get("status"):
        qs = qs.filter(status__in=p["status"])
    bonuses = list(qs.order_by("-financial_year", "employee__employee_code", "id")[: ctx.row_limit])

    entries: list[tuple[dict, dict]] = []
    for b in bonuses:
        emp = b.employee
        row = {
            **emp_cells(emp),
            "employmentType": pretty(emp.employment_type),
            "financialYear": b.financial_year,
            "recordsConsidered": b.records_considered,
            "calculationBase": r2(b.calculation_base),
            "bonusPercent": r2(b.bonus_percent_applied),
            "bonusAmount": r2(b.bonus_amount),
            "status": pretty(b.status, BONUS_STATUS_LABELS),
            "computedBy": b.computed_by or None,
            "createdOn": ist_date_iso(b.created_at),
            "notes": (b.notes or "").strip() or None,
        }
        facts = {
            "emp_id": emp.id,
            "status": (b.status or "").lower(),
            "staff": emp.employment_type == "staff",
            "records": b.records_considered,
            "_key": (
                _fy_sort_key(b.financial_year),
                str(b.financial_year),
                _dept_name(row).lower(),
                natural_key(emp.employee_code),
                b.id,
            ),
        }
        entries.append((row, facts))
    entries.sort(key=lambda e: e[1]["_key"])
    rows = [r for r, _ in entries]

    def amount_of(status: str) -> float:
        return _sum(r["bonusAmount"] for r, f in entries if f["status"] == status)

    total = _sum(r["bonusAmount"] for r in rows)
    n_emp = len({f["emp_id"] for _, f in entries})
    summary = [
        {"label": "Employees", "value": n_emp, "format": "integer"},
        {"label": "Total bonus", "value": total, "format": "currency"},
        {"label": "Average bonus", "value": round(total / len(rows), 2) if rows else None, "format": "currency"},
        {"label": "Calculated (not approved)", "value": amount_of("calculated"), "format": "currency"},
        {"label": "Approved (not paid)", "value": amount_of("approved"), "format": "currency"},
        {"label": "Paid", "value": amount_of("paid"), "format": "currency"},
    ]

    n_fy = distinct_groups(rows, lambda r: r["financialYear"])
    room = len(rows) * 2 <= ctx.row_limit  # subtotal rows must never push an exact-fit result over the row limit
    if n_fy > 1 and room:
        # several financial years: one subtotal per year (rows are ordered year, department, code)
        rows = with_subtotals(
            rows, lambda r: r["financialYear"], ["calculationBase", "bonusAmount"], label=lambda g: f"FY {g} total"
        )
    elif n_fy == 1 and room and distinct_groups(rows, _dept_name) > 1:
        rows = with_subtotals(rows, _dept_name, ["calculationBase", "bonusAmount"])

    notes = [
        "Rows come from the Bonus page's Generate step and exist only for employees who were eligible then "
        "(monthly wage within the eligibility ceiling); employees not listed were not eligible or the register "
        "has not been generated for that year.",
        "Calculation base = sum of min(monthly basic, wage ceiling) over the year's salary slips; bonus = base x percent "
        "applied. Figures are those stored when the register was generated - regenerate on the Bonus page to refresh.",
        "For production employees the wage ceiling is applied per period slip (several a month), so their base can be overstated.",
        "Status 'Paid' is a manual flag; bonus does not appear on salary slips.",
        "'Generated on' is the day the row was first created. Running Generate again for the same year refreshes the "
        "figures and 'Last computed by' but keeps that date.",
    ]
    short = sum(1 for _, f in entries if f["staff"] and f["records"] < 12)
    if short:
        notes.append(
            f"{short} staff row(s) rest on fewer than 12 payroll months (joined or left mid-year, or payroll missing)."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="bonus-register",
        title="Statutory Bonus Register",
        description="Financial-year bonus register: calculation base, percent applied, bonus amount and approval / payment status.",
        category="finance",
        modules=("bonus",),
        icon="Gift",
        tags=("bonus", "statutory bonus", "payment of bonus act", "financial year", "diwali"),
        filters=(
            financial_year_filter(multi=True, help="All financial years by default."),
            select("status", "Bonus status", BONUS_STATUS_OPTIONS, multi=True),
            *scope(status=None),
        ),
        columns=(
            *EMP_COLS_SHORT,
            ColumnSpec("employmentType", "Type", BADGE, 1.0),
            ColumnSpec("financialYear", "Financial year", TEXT, 1.1, align="center"),
            ColumnSpec("recordsConsidered", "Slips used", INTEGER, 0.9),
            ColumnSpec("calculationBase", "Calculation base", CURRENCY, 1.3, total="sum"),
            ColumnSpec("bonusPercent", "Bonus %", NUMBER, 0.8),
            ColumnSpec("bonusAmount", "Bonus amount", CURRENCY, 1.3, total="sum"),
            ColumnSpec("status", "Status", BADGE, 1.0),
            ColumnSpec("computedBy", "Last computed by", TEXT, 1.3),
            ColumnSpec("createdOn", "Generated on", DATE, 1.1),
            ColumnSpec("notes", "Notes", TEXT, 1.5),
        ),
        run=_bonus_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  increment-history
# ═════════════════════════════════════════════════════════════════════════════

INCREMENT_SORT_OPTIONS = (
    ("employee", "Employee code"),
    ("department", "Department (with subtotals)"),
)


def _increment_run(ctx: ReportContext) -> ReportResult:
    p = ctx.params
    lo, hi = date_bounds(ctx, "effective", "financialYear")
    qs = SalaryIncrement.objects.select_related("employee__department", "employee__designation").filter(
        ctx.emp_q("employee__")
    )
    if lo:
        qs = qs.filter(effective_date__gte=lo)
    if hi:
        qs = qs.filter(effective_date__lte=hi)
    incs = list(qs.order_by("-effective_date", "employee__employee_code", "-id")[: ctx.row_limit])

    entries: list[tuple[dict, dict]] = []
    for i in incs:
        emp = i.employee
        row = {
            **emp_cells(emp),
            "effectiveDate": i.effective_date.isoformat(),
            "previousSalary": r2(i.previous_salary),
            "newSalary": r2(i.new_salary),
            "incrementAmount": r2(i.new_salary - i.previous_salary),
            "percent": r2(i.percent),
            "addedBy": i.added_by or None,
            "recordedOn": fmt_dt(i.created_at),
            "notes": (i.notes or "").strip() or None,
        }
        entries.append(
            (
                row,
                {
                    "emp_id": emp.id,
                    "_code": natural_key(emp.employee_code),
                    "_dept": _dept_name(row).lower(),
                    "_eff": i.effective_date.toordinal(),
                    "_id": i.id,
                },
            )
        )

    sort_by = p.get("sortBy") or "date"
    if sort_by == "department":
        entries.sort(key=lambda e: (e[1]["_dept"], e[1]["_code"], -e[1]["_eff"], -e[1]["_id"]))
    elif sort_by == "employee":
        entries.sort(key=lambda e: (e[1]["_code"], -e[1]["_eff"], -e[1]["_id"]))
    else:
        entries.sort(key=lambda e: (-e[1]["_eff"], e[1]["_code"], -e[1]["_id"]))
    rows = [r for r, _ in entries]

    pcts = [r["percent"] for r in rows if r["percent"] is not None]
    uplift = _sum(r["incrementAmount"] for r in rows)
    summary = [
        {"label": "Increments", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len({f["emp_id"] for _, f in entries}), "format": "integer"},
        {"label": "Monthly uplift", "value": uplift, "format": "currency"},
        {"label": "Annual uplift (x12)", "value": round(uplift * 12, 2), "format": "currency"},
        {
            "label": "Average increment (%)",
            "value": round(sum(pcts) / len(pcts), 2) if pcts else None,
            "format": "number",
        },
        {"label": "Highest increment (%)", "value": max(pcts) if pcts else None, "format": "number"},
    ]

    if sort_by == "department" and distinct_groups(rows, _dept_name) > 1 and len(rows) * 2 <= ctx.row_limit:
        rows = group_subtotals(rows, _dept_name, sums=["incrementAmount"], avgs=["percent"])

    notes = [
        "Increments are applied to the employee's salary the moment they are recorded, even when the effective date "
        "is in the future. Direct edits of the salary on an employee profile and production shift-rate changes leave "
        "no record, so this history is incomplete by design.",
        "Department and designation are the employee's current values, not those at the time of the increment.",
        "Increment amount = new salary - previous salary (monthly); the percent is the value recorded with the increment. "
        "Average and highest percent are simple figures over the rows listed (not weighted by salary).",
    ]
    bounds_note = describe_bounds(lo, hi, "Only increments effective")
    if bounds_note:
        notes.append(bounds_note)
    future = sum(1 for r in rows if r.get("effectiveDate") and r["effectiveDate"] > ctx.today.isoformat())
    if future:
        notes.append(f"{future} increment(s) are dated after today but are already applied to the employee's salary.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="increment-history",
        title="Salary Increment History",
        description="Chronological register of salary revisions: previous and new salary, increment amount and percent, and who recorded it.",
        category="finance",
        modules=("increment",),
        icon="TrendingUp",
        tags=("increment", "salary revision", "hike", "appraisal", "raise", "financial year"),
        filters=(
            window_filter(
                "effective", "Effective", help="Filters on the increment's effective date. All time by default."
            ),
            financial_year_filter(help="Combines with the period above (both must match)."),
            *scope(status=None),
            select("sortBy", "Order by", INCREMENT_SORT_OPTIONS, placeholder="Effective date (newest first)"),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("effectiveDate", "Effective date", DATE, 1.4),
            ColumnSpec("previousSalary", "Previous salary", CURRENCY, 1.3),
            ColumnSpec("newSalary", "New salary", CURRENCY, 1.3),
            ColumnSpec("incrementAmount", "Increment", CURRENCY, 1.2, total="sum"),
            ColumnSpec("percent", "Increment %", NUMBER, 1.3, total="avg"),
            ColumnSpec("addedBy", "Recorded by", TEXT, 1.3),
            ColumnSpec("recordedOn", "Recorded on", DATETIME, 2.0),
            ColumnSpec("notes", "Notes", TEXT, 1.5),
        ),
        run=_increment_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  promotion-history
# ═════════════════════════════════════════════════════════════════════════════

CHANGE_OPTIONS = (
    ("designation", "Designation only"),
    ("department", "Department only"),
    ("both", "Designation and department"),
)


def _promotion_scope():
    """The usual employee filters, but department / designation mean "moved from or to" on a promotion."""
    out = []
    for f in scope(status=None):
        if f.key in ("department", "designation"):
            f = replace(f, label=f"{f.label} (moved from or to)")
        out.append(f)
    return tuple(out)


def _change_label(dept_changed: bool, desig_changed: bool) -> str:
    if dept_changed and desig_changed:
        return "Both"
    if desig_changed:
        return "Designation"
    if dept_changed:
        return "Department"
    return "No change"


def _promotion_run(ctx: ReportContext) -> ReportResult:
    p = ctx.params
    lo, hi = date_bounds(ctx, "effective", "financialYear")
    # Department / Designation filters mean "the promotion moved from or to this value" here, not the employee's
    # current one, so they are applied to the promotion's own columns; branch isolation and the other employee
    # filters still go through the framework.
    plain = ReportContext(
        request=ctx.request,
        spec=ctx.spec,
        params={**p, "department_ids": [], "designation_ids": []},
        row_limit=ctx.row_limit,
        purpose=ctx.purpose,
    )
    qs = Promotion.objects.select_related(
        "employee",
        "previous_department",
        "previous_designation",
        "new_department",
        "new_designation",
    ).filter(plain.emp_q("employee__"))
    if lo:
        qs = qs.filter(effective_date__gte=lo)
    if hi:
        qs = qs.filter(effective_date__lte=hi)
    if p.get("department_ids"):
        ids = p["department_ids"]
        qs = qs.filter(Q(previous_department_id__in=ids) | Q(new_department_id__in=ids))
    if p.get("designation_ids"):
        ids = p["designation_ids"]
        qs = qs.filter(Q(previous_designation_id__in=ids) | Q(new_designation_id__in=ids))
    change = p.get("changeType")
    if change:
        # NULL-safe "did it change": a deleted (NULL) department counts as its own value
        qs = qs.annotate(
            pd_key=Coalesce("previous_department_id", Value(0)),
            nd_key=Coalesce("new_department_id", Value(0)),
            pg_key=Coalesce("previous_designation_id", Value(0)),
            ng_key=Coalesce("new_designation_id", Value(0)),
        )
        dept_changed, desig_changed = ~Q(pd_key=F("nd_key")), ~Q(pg_key=F("ng_key"))
        qs = qs.filter(
            {
                "designation": desig_changed & ~dept_changed,
                "department": dept_changed & ~desig_changed,
                "both": dept_changed & desig_changed,
            }[change]
        )
    promos = list(qs.order_by("-effective_date", "employee__employee_code", "-id")[: ctx.row_limit])

    entries: list[tuple[dict, dict]] = []
    for pr in promos:
        emp = pr.employee
        dept_changed = pr.previous_department_id != pr.new_department_id
        desig_changed = pr.previous_designation_id != pr.new_designation_id
        row = {
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "effectiveDate": pr.effective_date.isoformat(),
            "change": _change_label(dept_changed, desig_changed),
            "previousDesignation": pr.previous_designation.title if pr.previous_designation_id else None,
            "newDesignation": pr.new_designation.title if pr.new_designation_id else None,
            "previousDepartment": pr.previous_department.name if pr.previous_department_id else None,
            "newDepartment": pr.new_department.name if pr.new_department_id else None,
            "promotedBy": pr.promoted_by or None,
            "recordedOn": fmt_dt(pr.created_at),
            "notes": (pr.notes or "").strip() or None,
        }
        entries.append(
            (
                row,
                {
                    "emp_id": emp.id,
                    "dept": dept_changed,
                    "desig": desig_changed,
                    "_code": natural_key(emp.employee_code),
                    "_eff": pr.effective_date.toordinal(),
                    "_id": pr.id,
                },
            )
        )
    entries.sort(key=lambda e: (-e[1]["_eff"], e[1]["_code"], -e[1]["_id"]))
    rows = [r for r, _ in entries]

    summary = [
        {"label": "Promotions", "value": len(rows), "format": "integer"},
        {"label": "Employees promoted", "value": len({f["emp_id"] for _, f in entries}), "format": "integer"},
        {"label": "Designation changed", "value": sum(1 for _, f in entries if f["desig"]), "format": "integer"},
        {"label": "Department changed", "value": sum(1 for _, f in entries if f["dept"]), "format": "integer"},
    ]

    notes = [
        "Promotions change the employee's department and/or designation only - pay revisions are recorded separately "
        "(see Salary Increment History).",
        "The Department and Designation filters match the value the employee moved from or to. A department or "
        "designation that has since been deleted shows as a dash.",
    ]
    into = Counter(r["newDesignation"] for r in rows if r["newDesignation"] and r["change"] in ("Designation", "Both"))
    if into:
        notes.append("Promoted into: " + ", ".join(f"{name} ({n})" for name, n in into.most_common(5)) + ".")
    bounds_note = describe_bounds(lo, hi, "Only promotions effective")
    if bounds_note:
        notes.append(bounds_note)
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="promotion-history",
        title="Promotion History",
        description="Designation and department promotions with previous and new values, effective dates and who recorded them.",
        category="finance",
        modules=("promotion",),
        icon="Award",
        tags=("promotion", "designation", "career", "grade", "financial year"),
        filters=(
            window_filter(
                "effective", "Effective", help="Filters on the promotion's effective date. All time by default."
            ),
            financial_year_filter(help="Combines with the period above (both must match)."),
            select("changeType", "Type of change", CHANGE_OPTIONS),
            *_promotion_scope(),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
            ColumnSpec("employeeName", "Employee", TEXT, 1.9),
            ColumnSpec("effectiveDate", "Effective date", DATE, 1.4),
            ColumnSpec("change", "Change", BADGE, 1.3),
            ColumnSpec("previousDesignation", "Previous designation", TEXT, 1.5),
            ColumnSpec("newDesignation", "New designation", TEXT, 1.5),
            ColumnSpec("previousDepartment", "Previous department", TEXT, 1.4),
            ColumnSpec("newDepartment", "New department", TEXT, 1.4),
            ColumnSpec("promotedBy", "Recorded by", TEXT, 1.2),
            ColumnSpec("recordedOn", "Recorded on", DATETIME, 1.7),
            ColumnSpec("notes", "Notes", TEXT, 1.4),
        ),
        run=_promotion_run,
    )
)
