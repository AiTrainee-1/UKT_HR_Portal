"""Salary category: department-headcount-report and department-employee-report (the workforce by department, with the
fixed salary it carries).

Both read the employee master only (Employee + the approved-resignation trail for exit dates); nothing is computed or
saved. Fixed salary = the staff monthly salary (Employee.salary_amount); a production worker is paid per shift
(Employee.salary_per_shift) and has no monthly salary, so production is shown with its rate per shift. Salary figures are
shown to a role that can see them (staff: Salary or Payroll; production: Salary or Production Payroll); the counts are
shown to every role that can open the report.

Join dates are free text: the shared reader is used, plus the decoding of the 'dd-mm-<Excel serial>' text an old import
left on the production rows (rc_salary_common.join_date), so production workers are never dropped from joins or shown
with a year in the 4000s.
"""

from __future__ import annotations

from collections import Counter

from .. import filters as F
from ..formatting import display_date
from ..registry import register
from ..types import BADGE, CURRENCY, DATE, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import rc_salary_common as C
from .employees_master_base import (
    BASIS_APPROX,
    exit_infos,
    gender_bucket,
    is_active,
    status_label,
)

MODULES = ("salary", "payroll", "production_payroll")


def _salary_access(ctx) -> dict[str, bool]:
    return {kind: C.may_view(ctx, C.SALARY_MODULES[kind]) for kind in (C.STAFF, C.PRODUCTION)}


def _hidden_note(access: dict[str, bool]) -> list[str]:
    hidden = [C.KIND_LABEL[k].lower() for k, ok in access.items() if not ok]
    if not hidden:
        return []
    return [f"Your role cannot see {' or '.join(hidden)} salaries, so those amounts are left blank."]


# ═════════════════════════════════════════════════════════════════════════════
#  department-headcount-report
# ═════════════════════════════════════════════════════════════════════════════

HEADCOUNT_COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.2),
    ColumnSpec("unit", "Unit", TEXT, 0.7, align="center"),
    ColumnSpec("staff", "Active staff", INTEGER, 0.9, total="sum"),
    ColumnSpec("production", "Active production", INTEGER, 0.9, total="sum"),
    ColumnSpec("total", "Total active", INTEGER, 0.9, total="sum"),
    ColumnSpec("male", "Male", INTEGER, 0.7, total="sum"),
    ColumnSpec("female", "Female", INTEGER, 0.7, total="sum"),
    ColumnSpec("otherGender", "Other / not set", INTEGER, 0.8, total="sum"),
    ColumnSpec("joined", "Joined in period", INTEGER, 0.9, total="sum"),
    ColumnSpec("left", "Left in period", INTEGER, 0.9, total="sum"),
    ColumnSpec("fixedSalary", "Fixed monthly salary (staff)", CURRENCY, 1.4, total="sum"),
    ColumnSpec("shiftWages", "Production pay per shift day", CURRENCY, 1.3, total="sum"),
)


def _headcount_run(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    access = _salary_access(ctx)
    # every employee in scope, whatever the status: counts are of the active ones, joins and exits of everybody
    emps = list(ctx.employees())
    depts = C.department_map(emps)
    exits = exit_infos([e for e in emps if not is_active(e)])
    states: Counter = Counter()
    groups: dict[int | None, dict] = {}
    approx_exits = 0
    for e in emps:
        g = groups.setdefault(
            e.department_id,
            {
                "department": depts[e.department_id],
                "units": Counter(),
                **{k: 0 for k in ("staff", "production", "male", "female", "otherGender", "joined", "left")},
                "fixedSalary": C.ZERO,
                "shiftWages": C.ZERO,
            },
        )
        joined, state = C.join_date(e)
        states[state] += 1
        if joined is not None and d_from <= joined <= d_to:
            g["joined"] += 1
        if is_active(e):
            g["units"][C.unit_text(e)] += 1
            kind = e.employment_type if e.employment_type in (C.STAFF, C.PRODUCTION) else C.STAFF
            g[kind] += 1
            bucket = gender_bucket(e.gender)
            g[bucket if bucket in ("male", "female") else "otherGender"] += 1
            if kind == C.STAFF and e.salary_amount:
                g["fixedSalary"] += C.d2(e.salary_amount)
            if kind == C.PRODUCTION and e.salary_per_shift:
                g["shiftWages"] += C.d2(e.salary_per_shift)
        else:
            info = exits.get(e.id)
            if info is not None and info.when is not None and d_from <= info.when <= d_to:
                g["left"] += 1
                approx_exits += info.basis == BASIS_APPROX
    rows = []
    for g in sorted(groups.values(), key=lambda g: C.dept_sort(g["department"])):
        units = g.pop("units")
        rows.append(
            {
                **{k: v for k, v in g.items() if k not in ("fixedSalary", "shiftWages")},
                "unit": ", ".join(u for u, _n in units.most_common()) or None,
                "total": g["staff"] + g["production"],
                "fixedSalary": float(g["fixedSalary"]) if access[C.STAFF] else None,
                "shiftWages": float(g["shiftWages"]) if access[C.PRODUCTION] else None,
            }
        )
    rows = [r for r in rows if r["total"] or r["joined"] or r["left"]]

    def total(key):
        return sum(r[key] or 0 for r in rows)

    summary = [
        {"label": "Active staff", "value": total("staff"), "format": INTEGER},
        {"label": "Active production", "value": total("production"), "format": INTEGER},
        {"label": "Total active", "value": total("total"), "format": INTEGER},
        {"label": "Joined in period", "value": total("joined"), "format": INTEGER},
        {"label": "Left in period", "value": total("left"), "format": INTEGER},
        {
            "label": "Fixed monthly salary (staff)",
            "value": round(total("fixedSalary"), 2) if access[C.STAFF] else None,
            "format": CURRENCY,
        },
    ]
    notes = [
        "One line per department: the ACTIVE employees today (staff, production, by gender), who joined and who left "
        f"between {display_date(d_from)} and {display_date(d_to)}, and the fixed salary the active people carry. Unit = the "
        "units the department's active people work at.",
        "Fixed monthly salary (staff) = the monthly salaries of the active staff. Production workers are paid per shift "
        "and have no monthly salary: Production pay per shift day = their rates per shift added up (one shift each).",
        "Joined = join date inside the period. Left = an employee no longer active whose exit falls inside the period: "
        "the last working day of the approved resignation, else the day it was approved, else (deactivated by hand) the "
        "day the record last changed.",
        *C.join_notes(states),
        *_hidden_note(access),
    ]
    if approx_exits:
        notes.append(f"{approx_exits} exit(s) have no resignation on file: dated by the day the record last changed.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ═════════════════════════════════════════════════════════════════════════════
#  department-employee-report
# ═════════════════════════════════════════════════════════════════════════════

EMPLOYEE_COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 1.6),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("type", "Type", TEXT, 0.9),
    ColumnSpec("joinDate", "Join date", DATE, 1.0),
    ColumnSpec("status", "Status", BADGE, 0.8, align="center"),
    ColumnSpec("fixedSalary", "Fixed monthly salary", CURRENCY, 1.2, total="sum"),
    ColumnSpec("ratePerShift", "Rate / shift", CURRENCY, 0.9),
    ColumnSpec("unit", "Unit", TEXT, 0.6, align="center"),
)


def _employee_run(ctx) -> ReportResult:
    access = _salary_access(ctx)
    emps = list(ctx.employees()[: ctx.row_limit])
    depts = C.department_map(emps)
    states: Counter = Counter()
    lines = []
    for e in emps:
        joined, state = C.join_date(e)
        states[state] += 1
        staff = e.employment_type != C.PRODUCTION
        lines.append(
            {
                "department": depts[e.department_id],
                "employeeCode": e.employee_code,
                "employeeName": C.full(e),
                "designation": e.designation.title if e.designation_id else None,
                "type": C.KIND_LABEL.get(e.employment_type) or (e.employment_type or "").title() or None,
                "joinDate": joined.isoformat() if joined else None,
                "status": status_label(e.status),
                "fixedSalary": C.money(e.salary_amount) if staff and access[C.STAFF] and e.salary_amount else None,
                "ratePerShift": (
                    C.money(e.salary_per_shift) if not staff and access[C.PRODUCTION] and e.salary_per_shift else None
                ),
                "unit": C.unit_text(e),
            }
        )
    lines.sort(key=lambda r: (C.dept_sort(r["department"]), C.code_sort(r["employeeCode"])))
    rows = C.group_subtotals(
        lines,
        "department",
        ("fixedSalary",),
        label_key="employeeName",
        label=lambda d, n: f"{d}: {n} employee{'' if n == 1 else 's'}",
    )
    by_type = Counter(r["type"] for r in lines)
    summary = [
        {"label": "Employees", "value": len(lines), "format": INTEGER},
        {"label": "Departments", "value": len({r["department"] for r in lines}), "format": INTEGER},
        {"label": "Staff", "value": by_type.get("Staff", 0), "format": INTEGER},
        {"label": "Production", "value": by_type.get("Production", 0), "format": INTEGER},
        {
            "label": "Fixed monthly salary",
            "value": round(sum(r["fixedSalary"] or 0 for r in lines), 2) if access[C.STAFF] else None,
            "format": CURRENCY,
        },
    ]
    notes = [
        "Employees grouped by department (departments in name order, employees by code), with a line per department "
        "giving its head count and its fixed monthly salary.",
        "Fixed monthly salary = the staff monthly salary on the profile (Employee > Salary); production workers are paid "
        "per shift, so their Rate / shift is shown instead.",
        *C.join_notes(states),
        *_hidden_note(access),
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


# ═════════════════════════════════════════════════════════════════════════════
#  registration
# ═════════════════════════════════════════════════════════════════════════════

register(
    ReportSpec(
        id="department-headcount-report",
        title="Department-wise Headcount Report",
        description="Per department: active staff and production, male / female, joined and left in the period, and "
        "the fixed monthly salary they carry.",
        category=C.CATEGORY,
        modules=MODULES,
        icon="Users",
        tags=("department", "headcount", "strength", "joined", "left", "gender", "salary", "manpower"),
        filters=(
            F.date_range(default="thisMonth", label="Joined / left between"),
            F.branches(),
            F.departments(),
            F.designations(),
            F.employment_type(),
        ),
        columns=HEADCOUNT_COLUMNS,
        run=_headcount_run,
        landscape=True,
    )
)

register(
    ReportSpec(
        id="department-employee-report",
        title="Department-wise Employee Report",
        description="Employees grouped by department with a line per department: code, name, designation, type, join "
        "date, status and fixed salary.",
        category=C.CATEGORY,
        modules=MODULES,
        icon="Network",
        tags=("department", "employees", "list", "salary", "join date", "status", "roster"),
        filters=F.scope(status="active"),
        columns=EMPLOYEE_COLUMNS,
        run=_employee_run,
        landscape=True,
    )
)
