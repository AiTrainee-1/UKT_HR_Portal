"""Customise data source "employees": one row per employee with figures for a month (the "Monthly Employee Performance
Report": code, name, department, present days, late count, OT hours, leave taken, net salary ...).

Sections: Personal, Employment, Salary (fixed salary and its 50 / 50 split, PF / ESI, bank), Attendance in the month (from
the stored day verdicts, as payroll reads them) and Payroll for the month (from the saved payrolls, as the Salary
Statement prints them). Only the sections the chosen fields need are loaded, each in a fixed number of queries.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date


from api.cl_balance import ENTITLEMENT, balance_json, parts, since
from api.models import EmployeePermission, MissingPunchRequest, OnDutySession
from api.models.payroll import CL_BALANCE_DEFAULT_SINCE
from api.payroll_insights import assignments_on
from api.production_cycles import CYCLE_LABELS
from api.salary_split import effective_split
from api.shift_engine import _get_assignment_for_date

from .. import filters as Fl
from ..definitions.attendance_core_data import L_PRESENT, build_day, label_for, late_minutes
from ..definitions.employees_master_base import (
    age_on,
    blood_group_of,
    clean,
    gender_label,
    hod_name_map,
    mask_tail,
    months_between,
    service_end_dates,
)
from ..definitions.rc_salary_common import PRODUCTION, SALARY_MODULES, STAFF, may_view
from ..definitions.requests_leave_common import ist_bounds, ist_date
from ..formatting import month_bounds, r2
from ..types import CURRENCY, DATE, HOURS, INTEGER, MINUTES, NUMBER, PERCENT, TEXT
from . import attendance as A
from .common import EMPLOYEE_MODULES, employee_cells, join_date, scope_filters, scoped_employees
from .ds_payroll import PAY_MODULES, payroll_lines, per_employee
from .fields import Dataset, Field, LoadResult, needs_of

ATT = ("attendance",)
# The salary structure: the Salary module, or the payroll that pays it. Any of them offers the fields; each ROW then needs
# its own kind's (rc_salary_common.SALARY_MODULES: staff Salary or Payroll, production Salary or Production Payroll), so a
# Payroll-only role never reads a production worker's rate here either.
SALARY = ("salary", "payroll", "production_payroll")
ON_DUTY_APPROVED = (OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED)
# Anyone who may open an employee list, an attendance register or a payroll can use this source (the identity columns);
# each section then needs its own module.
DATASET_MODULES = ("employees", "attendance", "salary", "payroll", "production_payroll")


def _att(key, label, type_, desc, needs="att", total="sum", modules=ATT, width=1.0) -> Field:
    return Field(key, label, type_, "attendance", needs, desc, modules=modules, width=width, total=total)


def _sal(key, label, desc=None, type_=CURRENCY, width=1.1, total=None) -> Field:
    return Field(key, label, type_, "salary", "salary", desc, modules=SALARY, width=width, total=total)


def _pay(key, label, type_, desc=None, total="sum", width=1.1) -> Field:
    return Field(key, label, type_, "payroll", "pay", desc, modules=PAY_MODULES, width=width, total=total)


FIELDS = (
    # Personal
    Field("emp.code", "Emp code", TEXT, "personal", "emp"),
    Field("emp.name", "Employee name", TEXT, "personal", "emp", width=2.2),
    Field("emp.gender", "Gender", TEXT, "personal", "emp", modules=EMPLOYEE_MODULES, width=0.8),
    Field("emp.dob", "Date of birth", DATE, "personal", "emp", modules=EMPLOYEE_MODULES),
    Field("emp.age", "Age", INTEGER, "personal", "emp", "Completed years today", modules=EMPLOYEE_MODULES, width=0.6),
    Field("emp.blood_group", "Blood group", TEXT, "personal", "emp", modules=EMPLOYEE_MODULES, width=0.7),
    Field("emp.phone", "Phone", TEXT, "personal", "emp", modules=EMPLOYEE_MODULES, width=1.2),
    Field("emp.email", "Email", TEXT, "personal", "emp", modules=EMPLOYEE_MODULES, width=1.8),
    Field("emp.address", "Address", TEXT, "personal", "emp", modules=EMPLOYEE_MODULES, width=3.0),
    # Employment
    Field("emp.department", "Department", TEXT, "employment", "emp", width=1.5),
    Field("emp.designation", "Designation", TEXT, "employment", "emp", width=1.5),
    Field("emp.branch", "Unit / branch", TEXT, "employment", "emp", width=1.1),
    Field("emp.type", "Employee type", TEXT, "employment", "emp", "Staff or Production", width=0.9),
    Field("emp.status", "Employee status", TEXT, "employment", "emp", "Active or Inactive (left)", width=0.9),
    Field("emp.join_date", "Join date", DATE, "employment", "emp"),
    Field(
        "emp.service_years",
        "Service (years)",
        NUMBER,
        "employment",
        "service",
        "From the join date to today (to the last working day for someone who has left)",
        width=0.8,
    ),  # fmt: skip
    Field("emp.hod", "Department head (HOD)", TEXT, "employment", "hod", width=1.6),
    Field("emp.shift", "Assigned shift", TEXT, "employment", "shift", "On the month's last day (today in this month)"),
    Field("emp.pay_cycle", "Production pay cycle", TEXT, "employment", "emp", "Weekly / BiWeekly / Monthly"),
    # Salary
    _sal("sal.monthly", "Fixed monthly salary", "Staff monthly salary", total="sum"),
    _sal("sal.per_shift", "Rate per shift", "Production pay per shift"),
    _sal("sal.basic", "Basic"),
    _sal("sal.da", "DA"),
    _sal("sal.retaining", "Retaining allowance"),
    _sal("sal.first_portion", "First portion (50%)", "Basic + DA + Retaining allowance"),
    _sal("sal.other", "Other allowance"),
    _sal("sal.petrol", "Petrol allowance"),
    _sal("sal.hra", "HRA"),
    _sal("sal.special", "Special allowance"),
    _sal("sal.ca", "CA"),
    _sal("sal.second_portion", "Second portion (50%)", "Other + Petrol + HRA + Special allowance + CA"),
    _sal("sal.co_emp", "PF / ESI apply (Co Emp)", "Only Co Emp employees have PF and ESI", TEXT, 0.9),
    _sal("sal.pf_number", "PF number", type_=TEXT, width=1.3),
    _sal("sal.esi_number", "ESI number", type_=TEXT, width=1.3),
    _sal("sal.uan", "UAN", type_=TEXT, width=1.3),
    _sal("sal.tds", "TDS %", "When TDS is switched on for the employee", NUMBER, 0.7),
    _sal("sal.bank_name", "Bank name", type_=TEXT, width=1.4),
    _sal("sal.account_last4", "Bank account (last 4)", "Only the last 4 digits are shown", TEXT),
    # Attendance in the month
    _att(
        "att.working_days",
        "Working days",
        INTEGER,
        "Days of the month up to today that are not a Sunday, a declared holiday or (staff) a Saturday off, while "
        "employed",
    ),  # fmt: skip
    _att("att.present_days", "Present days", INTEGER, "Full days present (Casual Leave and comp-off days not counted)"),
    _att("att.half_days", "Half days", INTEGER, "Days with one half (or less than a full production shift)"),
    _att("att.absent_days", "Absent days", INTEGER, "Stored absent (a Saturday off and today's open day are not)"),
    _att("att.leave_days", "Leave days", NUMBER, "Days on approved leave (a half-day leave counts 0.5)"),
    _att(
        "att.cl_days",
        "Casual Leave days",
        NUMBER,
        "Approved Casual Leave (a half day counts 0.5)",
        "cl",
        modules=("attendance", "casual_leave"),
    ),  # fmt: skip
    _att(
        "att.cl_balance",
        "CL balance left (year)",
        NUMBER,
        f"Of the {ENTITLEMENT} Casual Leave days of the month's year (staff)",
        "cl_balance",
        None,
        ("attendance", "casual_leave"),
    ),  # fmt: skip
    _att(
        "att.on_duty_days",
        "On-duty days",
        INTEGER,
        "Days with an approved on-duty session",
        "onduty",
        modules=("attendance", "geo_attendance"),
    ),  # fmt: skip
    _att("att.late_count", "Late days", INTEGER, "Days the engine marked late"),
    _att("att.late_minutes", "Late minutes", MINUTES, "Minutes after the (permission-shifted) start on late days"),
    _att(
        "att.quarter_days",
        "Quarter-shift days",
        INTEGER,
        "Staff: arrived in the quarter window (0.25 off); production: a credit ending in .25 or .75",
    ),  # fmt: skip
    _att("att.penalty_days", "Penalty early-out days", INTEGER, "Left more than the penalty minutes early"),
    _att(
        "att.permissions",
        "Permissions",
        INTEGER,
        "Approved permission requests dated in the month",
        "perm",
        modules=("attendance", "requests"),
    ),  # fmt: skip
    _att(
        "att.missing_punch",
        "Missing-punch requests",
        INTEGER,
        "Missing-punch requests dated in the month (any status)",
        "mpr",
        modules=("attendance", "missing_punch"),
    ),  # fmt: skip
    _att("att.shifts_earned", "Shifts earned", NUMBER, "The shift credit payroll pays (staff 1.00 a day at most)"),
    _att("att.extra_shifts", "Extra shifts", NUMBER, "Production: credit over 1.00 on a shift day"),
    _att(
        "att.worked_hours", "Worked hours", HOURS, "First to last punch less lunch, from the raw punches", "att_punches"
    ),  # fmt: skip
    _att("att.ot_hours", "OT hours", HOURS, "Staff overtime as the HR Time Card counts it", "ot"),
    _att(
        "att.attendance_pct",
        "Attendance %",
        PERCENT,
        "Shifts earned on working days over working days, as the Staff Attendance Report's Eff. %: a quarter-shift or "
        "Penalty Early Out day counts 0.75, a half day 0.5 (production: at most 1.00 a day)",
        total="avg",
    ),  # fmt: skip
    # Payroll for the month
    _pay("pay.paid_days", "Days / shifts paid", NUMBER, "Staff: days paid; production: shifts paid"),
    _pay("pay.lop_days", "LOP days", NUMBER, "Staff: company days not paid"),
    _pay("pay.gross", "Gross pay", CURRENCY),
    _pay("pay.ot_amount", "OT pay", CURRENCY),
    _pay("pay.bonus", "Bonus", CURRENCY),
    _pay("pay.earned", "Total earned", CURRENCY, "Gross + OT + bonus"),
    _pay("pay.pf", "PF", CURRENCY),
    _pay("pay.esi", "ESI (as printed)", CURRENCY, "Rounded up as printed on the statement"),
    _pay("pay.tds", "TDS", CURRENCY),
    _pay("pay.advance", "Advance recovered", CURRENCY),
    _pay("pay.other_deductions", "Other deductions", CURRENCY, "Late / permission and any other deduction"),
    _pay("pay.deductions", "Total deductions", CURRENCY),
    _pay("pay.net", "Net pay (as printed)", CURRENCY, "The saved net rounded up to the next whole rupee, as printed"),
    _pay(
        "pay.net_saved",
        "Net pay (saved)",
        CURRENCY,
        "The net exactly as the payroll saved it (to the paisa), as the Salary category's Salary Statement shows it",
    ),
    _pay(
        "pay.payment_status",
        "Payment status",
        TEXT,
        "Paid, Part paid (some production periods) or Not paid",
        total=None,
    ),  # fmt: skip
    _pay("pay.payrolls", "Payrolls in the month", INTEGER, "Production: pay periods ending in the month"),
)


# ── the sections ────────────────────────────────────────────────────────────


def _employee_cells(emp, today: date) -> dict:
    cycle = emp.production_pay_cycle if (emp.employment_type or "") == "production" else None
    joined = join_date(emp)
    return {
        **employee_cells(emp),
        "emp.gender": gender_label(emp.gender),
        "emp.dob": emp.date_of_birth.isoformat() if emp.date_of_birth else None,
        "emp.age": age_on(emp.date_of_birth, today),
        "emp.blood_group": blood_group_of(emp.blood_group),
        "emp.phone": clean(emp.phone),
        "emp.email": clean(emp.email),
        "emp.address": clean(emp.address),
        "emp.join_date": joined.isoformat() if joined else None,
        "emp.pay_cycle": CYCLE_LABELS.get(cycle) if cycle else None,
    }


def _salary_cells(emp) -> dict:
    production = (emp.employment_type or "") == "production"
    split, _recorded = (None, False) if production else effective_split(emp)
    s = split or {}

    def part(name):
        v = s.get(name)
        return r2(v) if v is not None else None

    first = [s.get(c) for c in ("basic", "da", "retaining_allowance")]
    second = [s.get(c) for c in ("other_allowance", "petrol_allowance", "hra", "special_allowance", "ca")]
    return {
        "sal.monthly": None if production else r2(emp.salary_amount),
        "sal.per_shift": r2(emp.salary_per_shift) if production else None,
        "sal.basic": part("basic"),
        "sal.da": part("da"),
        "sal.retaining": part("retaining_allowance"),
        "sal.first_portion": r2(sum(first)) if split else None,
        "sal.other": part("other_allowance"),
        "sal.petrol": part("petrol_allowance"),
        "sal.hra": part("hra"),
        "sal.special": part("special_allowance"),
        "sal.ca": part("ca"),
        "sal.second_portion": r2(sum(second)) if split else None,
        "sal.co_emp": "Yes" if emp.co_emp_enabled else "No",
        "sal.pf_number": clean(emp.pf_number),
        "sal.esi_number": clean(emp.esi_number),
        "sal.uan": clean(emp.uan_number),
        "sal.tds": r2(emp.tds_percent) if emp.tds_enabled and emp.tds_percent is not None else None,
        "sal.bank_name": clean(emp.bank_name),
        "sal.account_last4": mask_tail(emp.bank_account),
    }


def _cut_over(settings) -> date:
    """cl_balance.since() from settings already loaded (the row AttendanceData read), without reading it again."""
    if settings is None:
        return since()
    value = settings.cl_balance_since
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    return value or CL_BALANCE_DEFAULT_SINCE


def _day_figures(ctx, data, employees, start: date, last: date, needs: set[str]) -> tuple[dict[int, dict], list[str]]:
    """{employee id: att.* cells from the stored day verdicts} for start..last (last <= today)."""
    out: dict[int, dict] = {}
    exits = A.exit_dates(employees)
    threshold = data.settings.ot_threshold_minutes or 60
    ot_map = A.overtime_by_day([e.id for e in employees], start, last) if "ot" in needs else {}
    unprocessed = 0
    for emp in employees:
        c = Counter()
        win = A.window(emp, start, last, exits)
        worked_min = ot_min = 0
        for d in A.days(*win) if win is not None else ():
            working = A.is_working_day(data, emp, d)
            c["working"] += working
            rec = data.record(emp.id, d)
            if rec is None:
                unprocessed += working
                continue
            kind = data.kind(emp, d, rec)
            if kind == "present" and label_for(kind, rec) == L_PRESENT:
                c["present"] += 1
            elif kind == "half":
                c["half"] += 1
            elif kind == "absent" and not (d == ctx.today and (rec.total_punches or 0) == 0):
                c["absent"] += 1
            if kind == "leave":
                c["leave2"] += 2
            elif rec.is_half_day_leave:
                c["leave2"] += 1
            if rec.is_late:
                c["late"] += 1
                c["late_min"] += late_minutes(rec, data.shift(emp, d), emp, data) or 0
            c["quarter"] += A.quarter_day(rec, emp)
            c["penalty"] += bool(rec.penalty_early_out)
            se = A.shifts(rec) or 0.0
            c["shifts100"] += round(se * 100)
            if working:  # Attendance %: the credit of the working day, a full day at most (extra production shifts out)
                c["eff100"] += round(min(se, 1.0) * 100)
            if A.is_production(emp):
                c["extra100"] += round(max(0.0, se - 1.0) * 100)
            if "ot" in needs:
                ot_min += A.ot_minutes(rec, emp, ot_map.get((emp.id, d)), threshold) or 0
            if "att_punches" in needs:
                worked_min += build_day(data, emp, d).worked_min or 0
        working = c["working"]
        production = A.is_production(emp)
        out[emp.id] = {
            "att.working_days": working,
            "att.present_days": c["present"],
            "att.half_days": c["half"],
            "att.absent_days": c["absent"],
            "att.leave_days": c["leave2"] / 2,
            "att.late_count": c["late"],
            "att.late_minutes": c["late_min"],
            "att.quarter_days": c["quarter"],
            "att.penalty_days": c["penalty"],
            "att.shifts_earned": c["shifts100"] / 100,
            "att.extra_shifts": c["extra100"] / 100 if production else None,
            "att.worked_hours": round(worked_min / 60, 2),
            "att.ot_hours": None if production else round(ot_min / 60, 2),
            "att.attendance_pct": round(c["eff100"] / working, 1) if working else None,
        }
    notes = []
    if unprocessed:
        notes.append(
            f"{unprocessed:,} working employee-day(s) of the month have no stored attendance record yet (nobody has "
            "opened them in Attendance); they are not counted. Opening those dates in Attendance computes them."
        )
    return out, notes


def _attendance(ctx, employees, start: date, end: date, needs: set[str]):
    """({employee id: att.* cells}, notes, the AttendanceData or None) for the month: the day figures up to today (one
    AttendanceData load: records, holidays, shift assignments, punches only for Worked hours), plus one or two queries
    per request figure chosen."""
    notes: list[str] = []
    out: dict[int, dict] = {e.id: {} for e in employees}
    ids = [e.id for e in employees]
    data = None
    if needs & {"att", "att_punches", "ot"} and employees:
        last = min(end, ctx.today)
        if last < start:
            notes.append("The month has not started yet, so there are no attendance figures.")
        else:
            data = A.load(ctx, employees, start, last, punches="att_punches" in needs)
            figures, day_notes = _day_figures(ctx, data, employees, start, last, needs)
            for emp_id, cells in figures.items():
                out[emp_id].update(cells)
            notes += day_notes
    if needs & {"cl", "cl_balance"} and employees:
        # the Casual Leave of the whole year in one read (two queries): the month's days and the year's balance
        cut_over = _cut_over(data.settings if data is not None else None)
        held = parts(ids, date(start.year, 1, 1), date(start.year, 12, 31))
        for emp in employees:
            items = held.get(emp.id, [])
            if "cl" in needs:
                out[emp.id]["att.cl_days"] = float(
                    sum(
                        p.days
                        for p in items
                        if start <= p.date <= end
                        and p.status == "approved"
                        and p.kind == "casual_leave"
                        and not p.birthday
                    )
                )
            if "cl_balance" in needs:
                block = balance_json(items, start.year, cut_over)
                staff = not A.is_production(emp)
                out[emp.id]["att.cl_balance"] = block["remaining"] if staff and block["tracked"] else None
    if "onduty" in needs and employees:
        lo, hi = ist_bounds(start, end)
        seen: dict[int, set] = defaultdict(set)
        for emp_id, created in OnDutySession.objects.filter(
            employee_id__in=ids, status__in=ON_DUTY_APPROVED, created_at__gte=lo, created_at__lt=hi
        ).values_list("employee_id", "created_at"):
            seen[emp_id].add(ist_date(created))
        for emp_id in ids:
            out[emp_id]["att.on_duty_days"] = len(seen.get(emp_id, ()))
    if "perm" in needs and employees:
        counts = Counter(
            EmployeePermission.objects.filter(
                employee_id__in=ids, status=EmployeePermission.STATUS_APPROVED, date__gte=start, date__lte=end
            ).values_list("employee_id", flat=True)
        )
        for emp_id in ids:
            out[emp_id]["att.permissions"] = counts.get(emp_id, 0)
    if "mpr" in needs and employees:
        counts = Counter(
            MissingPunchRequest.objects.filter(employee_id__in=ids, date__gte=start, date__lte=end).values_list(
                "employee_id", flat=True
            )
        )
        for emp_id in ids:
            out[emp_id]["att.missing_punch"] = counts.get(emp_id, 0)
    return out, notes, data


def _load(ctx, keys: list[str], ceiling: int) -> LoadResult:
    year, month = ctx.period
    start, end = month_bounds(year, month)
    needs = needs_of(EMPLOYEES, keys)
    employees = scoped_employees(ctx)
    capped = len(employees) > ceiling
    employees = employees[:ceiling]
    notes: list[str] = []
    today = ctx.today
    rows = {e.id: _employee_cells(e, today) for e in employees}

    if "salary" in needs:
        # per row: the employee's own kind decides (staff Salary or Payroll, production Salary or Production Payroll)
        open_kinds = {kind: may_view(ctx, SALARY_MODULES[kind]) for kind in (STAFF, PRODUCTION)}
        hidden: Counter = Counter()
        for e in employees:
            kind = PRODUCTION if A.is_production(e) else STAFF
            if open_kinds[kind]:
                rows[e.id].update(_salary_cells(e))
            else:
                hidden[kind] += 1
        for kind, n in sorted(hidden.items()):
            module = "Payroll" if kind == STAFF else "Production Payroll"
            notes.append(
                f"Salary fields are blank for {n} {kind} employee(s): your role cannot see {kind} salaries (it needs "
                f"Salary or {module})."
            )
    if "service" in needs:
        ends = service_end_dates(employees, today)
        for e in employees:
            joined = join_date(e)
            stop = ends.get(e.id, today)
            months = months_between(joined, stop) if joined and stop >= joined else None
            rows[e.id]["emp.service_years"] = round(months / 12, 1) if months is not None else None
    if "hod" in needs:
        hods = hod_name_map(employees)
        for e in employees:
            rows[e.id]["emp.hod"] = hods.get(e.id)
    data = None
    if needs & {"att", "att_punches", "ot", "cl", "cl_balance", "onduty", "perm", "mpr"}:
        figures, att_notes, data = _attendance(ctx, employees, start, end, needs)
        for emp_id, cells in figures.items():
            rows[emp_id].update(cells)
        notes += att_notes
    if "shift" in needs:
        ref = start if start > today else min(end, today)
        if data is not None:  # the attendance load already holds the month's shift assignments
            shifts = {
                e.id: _get_assignment_for_date(e, ref, assignments=data.assignments.get(e.id, [])) for e in employees
            }
        else:
            shifts = assignments_on([e.id for e in employees], ref)
        for e in employees:
            a = shifts.get(e.id)
            rows[e.id]["emp.shift"] = a.shift.name if a is not None and a.shift_id else None
    if "pay" in needs:
        lines, pay_notes, _capped = payroll_lines(ctx, year, month, employee_ids=[e.id for e in employees])
        sums = per_employee(lines)
        for e in employees:
            rows[e.id].update(sums.get(e.id, {}))
        notes += pay_notes
        notes.append(
            "Payroll for the month: the saved payrolls of the month (staff) and the production pay periods ending in the "
            "month, added up per employee; blank when the employee has no payroll for it yet."
        )
    return LoadResult(rows=[rows[e.id] for e in employees], notes=notes, capped=capped)


EMPLOYEES = Dataset(
    id="employees",
    label="Employees with month figures",
    description="One row per employee: personal and job details, salary, the month's attendance and the month's "
    "payroll. Use it for a monthly employee performance report.",
    grain="employee",
    filters=(Fl.period(), *scope_filters()),
    sections=(
        ("personal", "Personal"),
        ("employment", "Employment"),
        ("salary", "Salary"),
        ("attendance", "Attendance in the month"),
        ("payroll", "Payroll for the month"),
    ),
    fields=FIELDS,
    default_fields=(
        "emp.code",
        "emp.name",
        "emp.department",
        "att.present_days",
        "att.late_count",
        "att.ot_hours",
        "att.leave_days",
        "pay.net",
    ),  # fmt: skip
    load=_load,
    modules=DATASET_MODULES,
    notes=(
        "Attendance figures are read from the stored day verdicts (what payroll pays), up to today, between the joining "
        "date and the last working day. Staff days are calendar days; production days are shift days (a night shift "
        "counts on the day it began).",
    ),
)
