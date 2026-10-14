"""HR Reports (category ``hr``): ready-made HR lists that bring together data several modules own.

employee-confo-details: one line per employee with who they are (code, name, department, designation), what they are
paid, the department head their requests go to, when they joined and the shift they work.

Salary is printed here on purpose, so the report is gated on the payroll modules (see ``MODULES``), not on the
employee module alone: the employee registers in ``employees_master_*`` never print salary.

production-daily-punches: every punch of each production employee with its exact time, for one day or (date-wise) for
a week or a month. Gated on the attendance module: it prints no pay.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import groupby

from django.db.models import Q

from api.models import AttendanceLog, EmployeeShiftAssignment
from api.shift_engine import _get_assignment_for_date

from .. import filters as F
from ..formatting import full_name, indian_number
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import DATE, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import weekday_text
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


# ── Production Daily Punches ────────────────────────────────────────────────────

ATTENDANCE_MODULES = ("attendance",)
MAX_PUNCH_DAYS = 31  # a month: the widest span the report offers, so a screen / Excel / PDF never has to be cut off

PUNCH_COLUMNS = (
    ColumnSpec("employeeName", "Employee Name", TEXT, 2.0),
    ColumnSpec("employeeCode", "Employee Code", TEXT, 1.0),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("punchCount", "Total Punch Count", INTEGER, 0.9, total="sum"),
    # last: it is the one long cell, so it takes the room that is left instead of pushing the count off the screen
    ColumnSpec("punches", "All Punches (exact times)", TEXT, 3.6),
)


def _punch_text(times) -> str:
    """'08:02:15, 12:00:41, 13:01:07, 17:30:22': every punch of the day in the order it was made, to the second."""
    return ", ".join(t.strftime("%H:%M:%S") for t in times)


def _punches_run(ctx) -> ReportResult:
    date_from, date_to = ctx.date_from, ctx.date_to
    several_days = date_from != date_to

    ordered = sorted(employees_qs(ctx).filter(employment_type="production"), key=lambda e: code_key(e.employee_code))
    logs = (
        AttendanceLog.objects.filter(
            ctx.emp_q("employee__"),
            employee__employment_type="production",
            date__gte=date_from,
            date__lte=date_to,
        )
        .order_by("employee_id", "date", "punch_time", "id")
        .values_list("employee_id", "date", "punch_time")
    )
    # {employee id: [(date, [punch times in the order they were made])]}, one pass over the punches
    per_emp: dict[int, list[tuple]] = defaultdict(list)
    for (emp_id, day), grouped in groupby(logs, key=lambda r: (r[0], r[1])):
        per_emp[emp_id].append((day, [r[2] for r in grouped]))

    rows: list[dict] = []
    data_rows = total_punches = odd_days = people = 0
    for e in ordered:
        days = per_emp.get(e.id)
        if not days:
            continue
        name = full_name(e)
        shown = person_punches = 0
        for day, times in days:
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export; never build more than it keeps
                break
            rows.append(
                {
                    "employeeName": name,
                    "employeeCode": e.employee_code,
                    "designation": e.designation.title if e.designation_id else None,
                    "department": department_name(e),
                    "date": day.isoformat(),
                    "day": weekday_text(day),
                    "punches": _punch_text(times),
                    "punchCount": len(times),
                }
            )
            data_rows += 1
            shown += 1
            person_punches += len(times)
            odd_days += len(times) % 2
        if not shown:
            break
        people += 1
        total_punches += person_punches
        if several_days:
            rows.append(
                {
                    "employeeName": f"{name} ({e.employee_code}) total",
                    "punches": f"{shown} day{'s' if shown != 1 else ''} with punches",
                    "punchCount": person_punches,
                    "_kind": KIND_SUBTOTAL,
                }
            )

    no_punches = sum(1 for e in ordered if e.status == "active" and e.id not in per_emp)
    summary = [
        {"label": "Production employees with punches", "value": people, "format": "integer"},
        {"label": "Employee-days with punches", "value": data_rows, "format": "integer"},
        {"label": "Total punches", "value": total_punches, "format": "integer"},
        {"label": "Days with an odd punch count", "value": odd_days, "format": "integer"},
        {"label": "Active with no punches", "value": no_punches, "format": "integer"},
    ]
    if several_days:
        shape = (
            f"Date-wise breakdown for {date_from.strftime('%d-%b-%Y')} to {date_to.strftime('%d-%b-%Y')}: each "
            "employee's days are listed in date order, followed by a total line. A day on which the employee made no "
            "punch is not listed."
        )
    else:
        shape = f"One line per employee for {date_from.strftime('%d-%b-%Y')}."
    notes = [
        shape,
        "Production employees only. Every punch stored for the employee on that calendar date is listed in the order "
        "it was made, with its exact time (hh:mm:ss), whatever its source: biometric device, geo punch, on-duty, an "
        "approved missing punch or a manual entry.",
        "Total Punch Count is every stored punch, so a double tap counts twice. A punch belongs to the calendar date the "
        "device stamped: a night shift's exit after midnight is listed on the next date. A day with an odd punch count "
        "may be a missed In or Out.",
    ]
    if no_punches:
        notes.append(f"{no_punches} active production employee(s) made no punch in this period and are not listed.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="production-daily-punches",
        title="Production Daily Punches",
        description="Every punch of each production employee with its exact time and the day's punch count: for one "
        "date, or date-wise for a week or a month.",
        category=CATEGORY,
        modules=ATTENDANCE_MODULES,
        icon="Fingerprint",
        tags=("production", "punch", "punches", "daily", "weekly", "monthly", "biometric", "attendance", "in out"),
        filters=(
            F.date_range(default="today", label="Date", max_days=MAX_PUNCH_DAYS),
            *F.scope(employment=False, status="all"),
        ),
        columns=PUNCH_COLUMNS,
        run=_punches_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)
