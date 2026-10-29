"""HR Reports (category ``hr``): the company's two printed attendance registers.

hr-strength-register: "Attendance Abstract For <date>". One date, grouped by department; per designation the number of
people ON ROLL and the number PRESENT, split Male / Female, with a SUB TOTAL under each department and a GRAND TOTAL.

hr-attendance-register-summary: "Attendance Register From <date> To <date>". One line per employee, grouped by
department: Present (the shifts the attendance engine stored), OT (announced overtime shifts), Total and Leave Days,
with a SUB TOTAL under each department and a GRAND TOTAL.

Both only read what the attendance / compensation engines already stored (rule 3 and 4 of the framework): a day nobody
has opened in Attendance has no stored verdict and is counted and reported, never computed here.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from api.models import AttendanceDayRecord, AttendanceLog, OvertimeRecord

from .. import filters as F
from ..registry import register
from ..runner import KIND_TOTAL
from ..common import with_subtotals
from ..formatting import display_date, full_name
from ..types import INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_analysis_common import Roster, subtotals_within_limit
from .attendance_core_data import AttendanceData, drop_dormant, emp_days_guard, scope_filters
from .employees_master_base import code_key, department_labels, employees_qs, gender_bucket

CATEGORY = "hr"
UNASSIGNED = "Unassigned"
NO_DESIGNATION = "No designation"
SUB_TOTAL = "SUB TOTAL"
GRAND_TOTAL = "GRAND TOTAL"
PRESENT_STATUSES = ("present", "half_shift")
MAX_REGISTER_DAYS = 31  # a month: the widest span the register offers
MAX_RANGE_DAYS = 31  # the abstract uses one date of its range, so the range limit only guards against a typo


def _dept_sort_key(department_id, label: str) -> tuple:
    """Departments in name order, the unassigned ones last (the order of the printed registers)."""
    return (0, label.lower(), department_id) if department_id else (1, "", 0)


def _fix_subtotal_departments(rows: list[dict]) -> None:
    """with_subtotals writes only its label and the sums: give each SUB TOTAL line the department it closes, so the
    Department column reads the same on every line (and an Excel filter on a department keeps its sub total)."""
    last = None
    for r in rows:
        if r.get("_kind") == "subtotal":
            r["department"] = last
        else:
            last = r.get("department")


# ═════════════════════════════════════════════════════════════════════════════
# hr-strength-register
# ═════════════════════════════════════════════════════════════════════════════

STRENGTH_ID = "hr-strength-register"
STRENGTH_MODULES = ("attendance", "employees")  # reads headcount (employees) and the day verdicts (attendance)
GENDERS = (("Male", 0), ("Female", 1), ("Other", 2))

_HEAD = (
    ColumnSpec("sno", "S.No.", INTEGER, 0.5, align="center"),
    ColumnSpec("department", "Department", TEXT, 1.7),
    ColumnSpec("designation", "Designation", TEXT, 2.6),
)
_ROLL = tuple(ColumnSpec(f"onRoll{g}", f"ON Roll Strength - {g}", INTEGER, 1.0) for g in ("Male", "Female"))
_PRESENT = tuple(ColumnSpec(f"present{g}", f"Present Strength - {g}", INTEGER, 1.0) for g in ("Male", "Female"))
STRENGTH_COLUMNS = (*_HEAD, *_ROLL, *_PRESENT)


def _strength_columns(with_other: bool) -> list[ColumnSpec]:
    if not with_other:
        return list(STRENGTH_COLUMNS)
    return [
        *_HEAD,
        *_ROLL,
        ColumnSpec("onRollOther", "ON Roll Strength - Other / Not set", INTEGER, 1.0),
        *_PRESENT,
        ColumnSpec("presentOther", "Present Strength - Other / Not set", INTEGER, 1.0),
    ]


def _strength_run(ctx) -> ReportResult:
    day = ctx.date_to  # an abstract is for ONE date: the To date (the form opens with From = To = today)
    split = bool(ctx.params.get("splitByGender"))
    emps = list(employees_qs(ctx))
    roster = Roster(ctx, day, day)
    # the stored verdict of the date, and the people with a punch on it: two queries whatever the headcount
    status_of = dict(
        AttendanceDayRecord.objects.filter(ctx.emp_q("employee__"), date=day).values_list("employee_id", "status")
    )
    punched = set(
        AttendanceLog.objects.filter(ctx.emp_q("employee__"), date=day)
        .order_by()
        .values_list("employee_id", flat=True)
        .distinct()
    )

    on_roll: list = []
    punch_only = no_join = 0
    present_ids: set[int] = set()
    for e in emps:
        verdict = status_of.get(e.id)
        worked = verdict in PRESENT_STATUSES
        # the headcount reports' own rule (department-strength): not before the joining date, not after the approved last
        # working day, and an inactive employee with no leaving date only on a day that has a stored record
        if roster.outside_employment(e, day) and not worked:
            continue
        left = roster.exits.get(e.id)
        if not (e.status == "active" or verdict is not None or (left is not None and left >= day)):
            continue
        on_roll.append(e)
        no_join += roster.join_date(e) is None
        if worked or e.id in punched:
            present_ids.add(e.id)
            punch_only += not worked

    labels = department_labels({e.department_id: e.department for e in on_roll if e.department_id}.values())
    groups: dict[tuple, dict] = {}
    other_on_roll = 0
    for e in on_roll:
        bucket = gender_bucket(e.gender)
        g_name = "Male" if bucket == "male" else "Female" if bucket == "female" else "Other"
        other_on_roll += g_name == "Other"
        dept = labels[e.department_id] if e.department_id else UNASSIGNED
        key = (
            _dept_sort_key(e.department_id, dept),
            e.designation_id is None,
            e.designation_id or 0,
            dict(GENDERS)[g_name] if split else 0,
        )
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "department": dept,
                "designation": e.designation.title if e.designation_id else NO_DESIGNATION,
                **{f"{p}{n}": 0 for p in ("onRoll", "present") for n, _ in GENDERS},
            }
        g[f"onRoll{g_name}"] += 1
        if e.id in present_ids:
            g[f"present{g_name}"] += 1

    with_other = other_on_roll > 0
    columns = _strength_columns(with_other)
    count_keys = [c.key for c in columns if c.key not in ("sno", "department", "designation")]
    data = [groups[k] for k in sorted(groups)]
    for i, r in enumerate(data, start=1):
        r["sno"] = i  # numbered continuously across the departments, as printed
    rows = with_subtotals(
        data,
        group_by=lambda r: r["department"],
        sum_keys=count_keys,
        label_key="designation",
        label=lambda g: SUB_TOTAL,
    )
    _fix_subtotal_departments(rows)
    grand = {k: sum(r[k] for r in data) for k in count_keys}
    if data:
        rows.append({"designation": GRAND_TOTAL, "_kind": KIND_TOTAL, **grand})

    total_roll = sum(grand.get(f"onRoll{n}", 0) for n, _ in GENDERS)
    total_present = sum(grand.get(f"present{n}", 0) for n, _ in GENDERS)
    summary = [
        {"label": "On roll", "value": total_roll, "format": "integer"},
        {"label": "Present", "value": total_present, "format": "integer"},
        {"label": "Not present", "value": total_roll - total_present, "format": "integer"},
        {"label": "Male on roll", "value": grand.get("onRollMale", 0), "format": "integer"},
        {"label": "Female on roll", "value": grand.get("onRollFemale", 0), "format": "integer"},
    ]
    if with_other:
        summary.append({"label": "Other / not set on roll", "value": other_on_roll, "format": "integer"})
    shown = display_date(day)
    notes = [
        f"Attendance abstract for {shown}. ON ROLL = employees employed that day: from the joining date up to an approved "
        "last working day (an employee who joins after the date is not on roll); an employee marked inactive with no "
        "leaving date is counted only if the day has a stored attendance record. This is the rule of the department-wise "
        "daily strength report.",
        "PRESENT = on-roll employees with a stored Present or Half-day verdict for the date, or a punch on that date. "
        "A day with no verdict and no punch counts as not present. Nothing is computed or saved by this report.",
        "Male / Female come from the gender on the employee record. "
        + (
            f"{other_on_roll} on-roll employee(s) have no gender (or another one) on record: they are in the Other / Not "
            "set columns."
            if with_other
            else "Every on-roll employee has Male or Female on record, so no extra column is needed."
        ),
        (
            "One line per designation and gender, as printed (a designation with men and women is listed twice)."
            if split
            else "One line per designation, men and women side by side."
        )
        + " Lines are numbered continuously across the departments; the department's SUB TOTAL closes each group.",
    ]
    if punch_only:
        notes.append(
            f"{punch_only} employee(s) are counted present from a punch alone because that day has no stored verdict yet "
            "(nobody has opened it in Attendance). A night-shift closing punch made after midnight counts for the "
            "calendar date it was stamped."
        )
    if no_join:
        notes.append(f"{no_join} on-roll employee(s) have no readable joining date and are counted on roll.")
    if ctx.date_from != day:
        notes.append(
            f"An abstract is for one date: the To date, {shown}, is used. Set From and To to the same day to see "
            "this in the filter."
        )
    if day > ctx.today:
        notes.append("The date is in the future: nobody can be present yet.")
    return ReportResult(rows=rows, columns=columns if with_other else None, summary=summary, notes=notes)


register(
    ReportSpec(
        id=STRENGTH_ID,
        title="Strength Register (Attendance Abstract)",
        description="ON roll and present strength of one date, male and female, by department and designation with "
        "sub totals: the printed Attendance Abstract.",
        category=CATEGORY,
        modules=STRENGTH_MODULES,
        icon="Users",
        tags=(
            "strength",
            "attendance abstract",
            "on roll",
            "present strength",
            "headcount",
            "male",
            "female",
            "register",
        ),
        filters=(
            F.date_range(default="today", label="Date", max_days=MAX_RANGE_DAYS),
            *F.scope(employee=False, status=None),
            F.boolean(
                "splitByGender",
                "One line per designation and gender",
                default=True,
                help="On: as the printed register (a designation with men and women is listed twice). Off: men and "
                "women side by side on one line.",
            ),
        ),
        columns=STRENGTH_COLUMNS,
        run=_strength_run,
        landscape=False,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# hr-attendance-register-summary
# ═════════════════════════════════════════════════════════════════════════════

REGISTER_ID = "hr-attendance-register-summary"
REGISTER_MODULES = ("attendance",)
HALF = Decimal("0.5")

REGISTER_COLUMNS = (
    ColumnSpec("sno", "SNo", INTEGER, 0.5, align="center"),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("employeeCode", "TicketNo", TEXT, 1.0),
    ColumnSpec("employeeName", "EmpName", TEXT, 2.2),
    ColumnSpec("designation", "Designation", TEXT, 1.8),
    ColumnSpec("present", "Present", NUMBER, 0.9),
    ColumnSpec("ot", "OT", NUMBER, 0.8),
    ColumnSpec("total", "Total", NUMBER, 0.9),
    ColumnSpec("leaveDays", "Leave Days", NUMBER, 0.9),
)
_REGISTER_SUMS = ["present", "ot", "total", "leaveDays"]


def _ot_shifts(ids: list[int], date_from, date_to) -> dict[int, Decimal]:
    """{employee id: overtime shifts} exactly as payroll pays them: announced, compensation type Pay, the automatic
    next-day allowance excluded, a record made before the shift-based overtime counting as one shift."""
    out: dict[int, Decimal] = defaultdict(Decimal)
    qs = (
        OvertimeRecord.objects.filter(
            employee_id__in=ids,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_PAY,
            date__gte=date_from,
            date__lte=date_to,
        )
        .exclude(ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE)
        .values_list("employee_id", "shifts")
    )
    for emp_id, shifts in qs:
        out[emp_id] += Decimal(shifts) if shifts is not None else Decimal("1")
    return out


def _register_run(ctx) -> ReportResult:
    d_from, d_to, today = ctx.date_from, ctx.date_to, ctx.today
    days = ctx.days_in_range
    employees = list(employees_qs(ctx))
    emp_days_guard(len(employees), len(days))
    data = AttendanceData(ctx, employees, d_from, d_to, service=True)  # service: joining / last working day
    employees = drop_dormant(ctx, employees, data)
    labels = department_labels({e.department_id: e.department for e in employees if e.department_id}.values())
    employees.sort(
        key=lambda e: (
            _dept_sort_key(e.department_id, labels[e.department_id] if e.department_id else ""),
            code_key(e.employee_code),
        )
    )
    ot = (
        _ot_shifts([e.id for e in employees], d_from, d_to)
        if data.settings.compensation_feature_enabled
        else defaultdict(Decimal)
    )

    rows: list[dict] = []
    missing = provisional = 0
    for i, e in enumerate(employees, start=1):
        present = leave = Decimal("0")
        for d in days:
            if d > today or not data.in_service(e, d):
                continue
            rec = data.record(e.id, d)
            if rec is None:
                missing += 1
                continue
            present += rec.shifts_earned or Decimal("0")
            kind = data.kind(e, d, rec)
            if kind == "absent":
                if d == today:  # the day is still running: an absence now is provisional, never counted as leave
                    provisional += 1
                else:
                    leave += 1
            elif kind == "leave":
                leave += 1
            elif kind == "half":
                leave += HALF
        overtime = ot.get(e.id, Decimal("0"))
        rows.append(
            {
                "sno": i,
                "department": labels[e.department_id] if e.department_id else UNASSIGNED,
                "employeeCode": e.employee_code,
                "employeeName": full_name(e),
                "designation": e.designation.title if e.designation_id else None,
                "present": float(round(present, 2)),
                "ot": float(round(overtime, 2)),
                "total": float(round(present + overtime, 2)),
                "leaveDays": float(round(leave, 2)),
            }
        )

    grand = {k: round(sum(r[k] for r in rows), 2) for k in _REGISTER_SUMS}
    out_rows, sub_note = subtotals_within_limit(
        ctx,
        rows,
        lambda r: r["department"],
        _REGISTER_SUMS,
        label_key="employeeName",
        label=lambda g: SUB_TOTAL,
    )
    _fix_subtotal_departments(out_rows)
    if rows:
        out_rows.append({"employeeName": GRAND_TOTAL, "_kind": KIND_TOTAL, **grand})

    summary = [
        {"label": "Employees", "value": len(rows), "format": "integer"},
        {"label": "Present (shifts)", "value": grand["present"], "format": "number"},
        {"label": "OT (shifts)", "value": grand["ot"], "format": "number"},
        {"label": "Total (shifts)", "value": grand["total"], "format": "number"},
        {"label": "Leave days", "value": grand["leaveDays"], "format": "number"},
        {"label": "Days with no record", "value": missing, "format": "integer"},
    ]
    notes = [
        f"Attendance register from {display_date(d_from)} to {display_date(d_to)}. Present = the shifts the attendance "
        "engine stored for the days (a full staff day 1.00, a half day 0.50; production shows the shifts it earned), "
        "the same shift credit payroll reads.",
        "OT = overtime shifts HR announced as Pay in Compensation, the figure payroll adds (an older announced record "
        "counts as one shift; Relaxation-type overtime and the automatic next-day allowance never count). Total = "
        "Present + OT.",
        "Leave Days = each absent day and each approved-leave day as 1.00 and each half-shift day as 0.50. Weekly offs "
        "(Sundays, Saturday-off Saturdays) and company holidays are not leave. For production, whose half shifts earn "
        "any value below a full shift, read Present (the shifts earned) as the real measure.",
        "Days before the joining date or after an approved last working day are left out.",
    ]
    if not data.settings.compensation_feature_enabled:
        notes.append(
            "The Compensation feature is switched off in Settings, so no overtime is paid and OT shows 0.00 "
            "(announced records are kept but have no effect)."
        )
    if missing:
        notes.append(
            f"{missing} past employee-day(s) have no stored attendance record yet (nobody has opened them in Attendance): "
            "they add nothing to Present or Leave Days. This report reads the engine's stored result and never computes "
            "attendance."
        )
    if provisional:
        notes.append(
            f"{provisional} absence(s) today are not counted as leave: the day is still running and an absence can still "
            "turn into a punch."
        )
    if sub_note:
        notes.append(sub_note)
    return ReportResult(rows=out_rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=REGISTER_ID,
        title="Attendance Register (Summary)",
        description="Present, OT, total and leave days of every employee for a date range, grouped by department with "
        "sub totals: the printed Attendance Register.",
        category=CATEGORY,
        modules=REGISTER_MODULES,
        icon="CalendarRange",
        tags=("attendance register", "ticket no", "present", "ot", "leave days", "monthly", "summary", "register"),
        filters=(
            F.date_range(default="thisMonth", label="Dates", max_days=MAX_REGISTER_DAYS),
            *scope_filters(status="all"),
        ),
        columns=REGISTER_COLUMNS,
        run=_register_run,
        landscape=False,
        screen_limit=5_000,
        pdf_max_rows=3_000,
    )
)
