"""HR Reports (category ``hr``): ready-made HR lists that bring together data several modules own.

employee-confo-details: one line per employee with who they are (code, name, department, designation), what they are
paid, the department head their requests go to, when they joined and the shift they work.

Salary is printed here on purpose, so the report is gated on the payroll modules (see ``MODULES``), not on the
employee module alone: the employee registers in ``employees_master_*`` never print salary.
"""

from __future__ import annotations

from collections import defaultdict

from django.db.models import Q

from api.models import EmployeeShiftAssignment
from api.shift_engine import _get_assignment_for_date

from .. import filters as F
from ..formatting import full_name, indian_number
from ..registry import register
from ..types import DATE, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_master_base import code_key, department_name, employees_qs, hod_name_map, join_date_of

CATEGORY = "hr"
# Salary amounts are payroll data: a role needs the Salary or Payroll module, "employees" alone is not enough.
MODULES = ("salary", "payroll")

NOT_ASSIGNED = "Not Assigned"
STAFF, PRODUCTION, OTHER = "staff", "production", "other"
TYPE_OPTIONS = ((STAFF, "Staff"), (PRODUCTION, "Production"), (OTHER, "Other"))

COLUMNS = (
    ColumnSpec("employeeCode", "Employee Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Name", TEXT, 1.9),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.6),
    ColumnSpec("salary", "Salary", TEXT, 1.7),
    ColumnSpec("assignedHod", "Assigned HOD", TEXT, 1.7),
    ColumnSpec("joinDate", "Date of Joining", DATE, 1.3),
    ColumnSpec("shift", "Shift Assign", TEXT, 2.1),
)


def _type_filter(selected) -> Q:
    """Rows of the chosen employee types. "Other" is every type that is neither Staff nor Production."""
    q = Q()
    named = [t for t in selected if t in (STAFF, PRODUCTION)]
    if named:
        q |= Q(employment_type__in=named)
    if OTHER in selected:
        q |= ~Q(employment_type__in=(STAFF, PRODUCTION))
    return q


def _salary_text(emp) -> str | None:
    """The pay on the employee record with its unit: production is paid per shift, everyone else a monthly (or, when
    the record says so, weekly) salary. The unit travels with the figure because the two are not comparable."""
    if (emp.employment_type or "").strip() == PRODUCTION:
        amount, unit = emp.salary_per_shift, "shift"
    else:
        amount = emp.salary_amount
        unit = "week" if (emp.salary_type or "").strip().lower() == "weekly" else "month"
    if not amount:  # unset, and a 0 salary means the same: nothing has been entered yet
        return None
    return f"₹{indian_number(float(amount))} / {unit}"


def _shift_names(emp_ids, today) -> dict[int, tuple[str, bool]]:
    """{employee id: (shift name, starts later)} by the attendance engine's own rule: of the assignments covering
    today the one with the latest start wins. With none covering today, the next one scheduled is shown (flagged).
    Employees with neither are absent."""
    per_emp: dict[int, list] = defaultdict(list)
    assignments = (
        EmployeeShiftAssignment.objects.filter(employee_id__in=list(emp_ids))
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=today))
        .select_related("shift")
        .order_by("effective_from", "id")
    )
    for a in assignments:
        per_emp[a.employee_id].append(a)

    def name_of(a) -> str:
        return (a.shift.name or "").strip() or "Unnamed shift"

    out: dict[int, tuple[str, bool]] = {}
    for emp_id, rows in per_emp.items():
        current = _get_assignment_for_date(None, today, assignments=rows)
        if current is not None:
            out[emp_id] = (name_of(current), False)
            continue
        upcoming = next((a for a in rows if a.effective_from > today), None)
        if upcoming is not None:
            out[emp_id] = (name_of(upcoming), True)
    return out


def _confo_run(ctx) -> ReportResult:
    today = ctx.today
    selected = ctx.params.get("employeeType") or []
    qs = employees_qs(ctx)
    if selected:
        qs = qs.filter(_type_filter(selected))
    emps = sorted(qs, key=lambda e: code_key(e.employee_code))

    hods = hod_name_map(emps)
    shifts = _shift_names((e.id for e in emps), today)

    rows = []
    counts = {STAFF: 0, PRODUCTION: 0, OTHER: 0}
    no_hod = no_shift = scheduled_later = no_salary = bad_join = 0
    for e in emps:
        etype = (e.employment_type or "").strip()
        counts[etype if etype in (STAFF, PRODUCTION) else OTHER] += 1
        joined, _state = join_date_of(e)
        bad_join += joined is None
        salary = _salary_text(e)
        no_salary += salary is None
        hod = hods.get(e.id)
        no_hod += hod is None
        shift = shifts.get(e.id)
        no_shift += shift is None
        scheduled_later += bool(shift and shift[1])
        rows.append(
            {
                "employeeCode": e.employee_code,
                "employeeName": full_name(e),
                "department": department_name(e),
                "designation": e.designation.title if e.designation_id else None,
                "salary": salary,
                "assignedHod": hod or NOT_ASSIGNED,
                "joinDate": joined.isoformat() if joined else None,
                "shift": shift[0] if shift else NOT_ASSIGNED,
            }
        )

    summary = [
        {"label": "Employees listed", "value": len(rows), "format": "integer"},
        {"label": "Staff", "value": counts[STAFF], "format": "integer"},
        {"label": "Production", "value": counts[PRODUCTION], "format": "integer"},
        {"label": "Other types", "value": counts[OTHER], "format": "integer"},
        {"label": "No HOD assigned", "value": no_hod, "format": "integer"},
        {"label": "No shift assigned", "value": no_shift, "format": "integer"},
    ]
    notes = [
        "Salary is the amount on the employee record, with its unit: a monthly (or weekly) salary for staff and the "
        "rate per shift for production employees. A dash (an empty cell in Excel) means no salary has been entered.",
        "Assigned HOD is the one department head the employee's requests are approved by (an individual assignment "
        "beats department coverage and only active HODs count). Employees with no active HOD, and department heads "
        "themselves, show Not Assigned.",
        f"Shift Assign is the shift the employee is on today ({today.strftime('%d-%b-%Y')}). Employees with no shift "
        "in force or scheduled show Not Assigned.",
        "Other types are employees whose type is neither Staff nor Production.",
    ]
    if scheduled_later:
        notes.append(
            f"{scheduled_later} employee(s) have no shift in force yet: the shift scheduled to start later is shown."
        )
    if no_salary:
        notes.append(f"{no_salary} employee(s) have no salary entered.")
    if bad_join:
        notes.append(f"{bad_join} employee(s) have no joining date on file, or one that cannot be read.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-confo-details",
        title="Employee Confo Details",
        description="Code, name, department, designation, salary, assigned HOD, joining date and shift of every employee.",
        category=CATEGORY,
        modules=MODULES,
        icon="ClipboardList",
        tags=("employee", "details", "salary", "hod", "shift", "joining", "staff", "production", "confo"),
        filters=(
            F.branches(),
            F.departments(),
            F.designations(),
            F.select(
                "employeeType",
                "Employee type",
                TYPE_OPTIONS,
                multi=True,
                placeholder="All types",
                help="Other = any employee type that is neither Staff nor Production.",
            ),
            F.employees(),
            F.employee_status("active"),
        ),
        columns=COLUMNS,
        run=_confo_run,
    )
)
