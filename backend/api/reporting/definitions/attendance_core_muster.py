"""Attendance Sheet (muster roll) and the Monthly Attendance Summary.

* attendance-muster-sheet reproduces the Report Log's "Monthly Report" grid: one row per employee, one column per
  date, the same status codes (P, half morning / evening, A, L, H, - for no record), the Strength row and the
  P / A / Eff. totals of ``attendance_report_log_sheet``, computed from the same engine records and the same
  ``month_summary_from_records``. By default it lists the same employees (active staff, ordered by first name).
* attendance-summary-monthly is the per-employee monthly tally with payroll working days and attendance %.

Both read the persisted engine verdict and never compute or write attendance: a past day nobody has opened has
no record and shows "-" (and is counted in the notes).
"""

from __future__ import annotations

import calendar
import datetime as dt
from collections import defaultdict
from decimal import Decimal

from django.db.models import Count

from api.attendance_final import month_summary_from_records
from api.models import CasualLeaveRequest, EmployeePermission
from api.payroll_views import _build_working_days

from ..common import with_subtotals
from ..filters import boolean, date_range, period
from ..formatting import month_bounds, month_label
from ..registry import register
from ..runner import KIND_TOTAL
from ..types import INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    WEEKDAYS,
    AttendanceData,
    drop_dormant,
    emp_days_guard,
    label_for,
    leave_type_text,
    scope_filters,
    scoped_employees,
)

# ── Attendance Sheet (muster roll) ──────────────────────────────────────────────

# The colour of each code in the Report Log's Attendance Sheet (AttendanceSheet.tsx STATUS_META).
PALETTE = {
    "P": "C6EFCE", "CL": "C6EFCE", "CO": "C6EFCE", "½M": "FFEB9C", "½": "FFEB9C", "½E": "FED7AA",
    "A": "FFC7CE", "L": "BDD7EE", "H": "E2E8F0", "WO": "E2E8F0",
}
LEGEND = [
    ("P", "Present"), ("½M", "Half day - morning worked"), ("½E", "Half day - evening worked"),
    ("A", "Absent"), ("L", "On leave"), ("H", "Holiday / weekly off"),
]


def day_key(d: dt.date) -> str:
    return f"d{d.strftime('%Y%m%d')}"


def cell_code(data: AttendanceData, emp, d: dt.date, *, leave_codes: bool, weekly_off: bool, half_ref) -> str | None:
    """The Attendance Sheet's cell code for one employee-day; None (shown '-') when there is no record."""
    rec = data.record(emp.id, d)
    if rec is None:
        return None
    s = rec.status
    if s == "present":
        if leave_codes:
            lab = label_for("present", rec)
            if lab == "Casual Leave":
                return "CL"
            if lab == "Comp Off":
                return "CO"
        return "P"
    if s == "half_shift":
        if emp.employment_type == "production":
            return "½"
        # the same inference as the legacy sheet: a first punch before the half-day cut-off means the morning was
        # worked; otherwise (including a manual row with no first punch) the evening
        return "½M" if rec.first_punch and rec.first_punch < half_ref else "½E"
    if s == "on_leave":
        if leave_codes:
            lr = data.full_leave.get((emp.id, d))
            if lr is not None:
                return leave_type_text(lr)[:3].upper()
        return "L"
    if s == "holiday":
        return "WO" if weekly_off and d not in data.holidays else "H"
    if weekly_off and data.kind(emp, d, rec) == "weekly_off":
        return "WO"
    return "A"


def _run_muster(ctx) -> ReportResult:
    days = ctx.days_in_range
    employees = scoped_employees(ctx, order="first_name")
    emp_days_guard(len(employees), len(days))
    leave_codes = bool(ctx.params.get("showLeaveCodes"))
    weekly_off = bool(ctx.params.get("weeklyOff"))
    mask = bool(ctx.params.get("maskService"))
    data = AttendanceData(ctx, employees, ctx.date_from, ctx.date_to, leaves=leave_codes, service=mask)
    employees = drop_dormant(ctx, employees, data)
    half_ref = data.settings.half_day_first_half_end_time
    today = ctx.today

    columns: list[ColumnSpec] = [
        ColumnSpec("sno", "S.No", INTEGER, 0.5),
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee Name", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.4),
    ]
    columns += [ColumnSpec(day_key(d), f"{d.day} {WEEKDAYS[d.weekday()][:2]}", TEXT, 0.45, align="center") for d in days]
    columns += [
        ColumnSpec("present", "P", INTEGER, 0.5, total="sum"),
        ColumnSpec("half", "½", INTEGER, 0.5, total="sum"),
        ColumnSpec("absent", "A", INTEGER, 0.5, total="sum"),
        ColumnSpec("leave", "L", INTEGER, 0.5, total="sum"),
        ColumnSpec("holiday", "H", INTEGER, 0.5, total="sum"),
    ]
    if weekly_off:
        columns.append(ColumnSpec("weeklyOff", "WO", INTEGER, 0.5, total="sum"))
    columns += [
        ColumnSpec("late", "Late", INTEGER, 0.6, total="sum"),
        ColumnSpec("effective", "Eff.", NUMBER, 0.7, total="sum"),
        ColumnSpec("shifts", "Shifts", NUMBER, 0.7, total="sum"),
    ]

    rows: list[dict] = []
    strength: dict[str, int] = defaultdict(int)
    missing = 0
    for i, emp in enumerate(employees, start=1):
        row = {
            "sno": i,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": emp.department.name if emp.department_id else None,
        }
        recs = []
        wo = 0
        absent_extra = 0
        holiday_days = 0
        for d in days:
            if mask and not data.in_service(emp, d):
                row[day_key(d)] = None
                continue
            code = cell_code(data, emp, d, leave_codes=leave_codes, weekly_off=weekly_off, half_ref=half_ref)
            row[day_key(d)] = code
            rec = data.record(emp.id, d)
            if rec is None:
                if d <= today:
                    missing += 1
                continue
            recs.append(rec)
            if rec.status in ("present", "half_shift"):
                strength[day_key(d)] += 1
            if code == "WO":
                wo += 1
                if rec.status == "holiday":
                    holiday_days += 1  # counted in H by the legacy summary; moved to WO by this option
                else:
                    absent_extra += 1  # a saturday-off Saturday the engine stored as absent
        s = month_summary_from_records(recs)
        row.update({
            "present": s["present"],
            "half": s["halfShift"],
            "absent": s["absent"] - absent_extra,
            "leave": s["onLeave"],
            "holiday": s["holidays"] - holiday_days,
            "late": s["late"],
            "effective": float(Decimal(s["effectiveDays"])),
            "shifts": float(Decimal(s["totalShifts"])),
        })
        if weekly_off:
            row["weeklyOff"] = wo
        rows.append(row)

    if rows:
        rows.append({"employeeName": "Strength", "_kind": KIND_TOTAL, **{day_key(d): strength.get(day_key(d), 0) for d in days}})

    notes = [
        "Codes: " + "  ".join(f"{c} {n}" for c, n in LEGEND) + ". '-' = no attendance record yet (or a future day). "
        "P / A / Eff. follow the Report Log sheet: P counts full days only, Eff. = full days + 0.5 x half days. "
        "Strength = employees present or on a half day that date.",
        "Each cell is the attendance engine's stored verdict for the day (the record payroll reads). The half-day period "
        "is inferred from the first punch (before the half-day cut-off = morning).",
    ]
    if not weekly_off:
        notes.append("H covers every holiday verdict, Sundays included, and a Saturday-off Saturday shows as A - as on the "
                     "Report Log sheet. Switch on 'Mark weekly offs as WO' to separate them.")
    if leave_codes:
        notes.append("CL = paid casual leave and CO = compensation off (both are paid present days in the engine); "
                     "leave days show the leave-type code.")
    if any(e.employment_type == "production" for e in employees):
        notes.append("Production rows: ½ means 0.75 shift or less, and the Shifts column is their real measure.")
    if missing:
        notes.append(
            f"{missing} past employee-day(s) have no attendance record yet (nobody has opened them in Attendance) and "
            "show '-'; reports read the engine's stored result and never compute attendance."
        )
    if mask:
        notes.append("Days before an employee's joining date or after their approved last working day are blank.")
    summary = [
        {"label": "Employees", "value": len(employees), "format": "integer"},
        {"label": "Man-days present", "value": sum(r.get("present", 0) for r in rows if not r.get("_kind")), "format": "integer"},
        {"label": "Absent days", "value": sum(r.get("absent", 0) for r in rows if not r.get("_kind")), "format": "integer"},
        {"label": "Days with no record", "value": missing, "format": "integer"},
    ]
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(ReportSpec(
    id="attendance-muster-sheet",
    title="Attendance Sheet (Muster Roll)",
    description="Employee x date grid of P / half-day / A / L / H codes with the Strength row and P / A / Eff. totals - "
    "the Report Log monthly sheet, for any range up to 31 days.",
    category="attendance",
    icon="Grid3x3",
    tags=("muster", "attendance sheet", "monthly report", "report log", "grid", "strength", "P A"),
    modules=("attendance",),
    filters=(
        date_range(default="thisMonth", label="Dates", max_days=31),
        *scope_filters(status="active", staff_default="staff", search=True),
        boolean("showLeaveCodes", "Show leave and casual-leave codes", default=False),
        boolean("weeklyOff", "Mark weekly offs as WO", default=False,
                help="Separates Sundays and Saturday-off Saturdays from holidays and absences."),
        boolean("maskService", "Blank days outside joining / leaving dates", default=False,
                help="Off matches the Report Log sheet, which shows such days as A."),
    ),
    columns=(),
    run=_run_muster,
    landscape=True,
    screen_limit=2_000,
    pdf_max_rows=1_500,
))


# ── Monthly Attendance Summary ──────────────────────────────────────────────────

SUMMARY_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("designation", "Designation", TEXT, 1.4),
    ColumnSpec("employeeType", "Type", TEXT, 0.9),
    ColumnSpec("workingDays", "Working Days", INTEGER, 0.8, total="sum"),
    ColumnSpec("presentDays", "Present", INTEGER, 0.7, total="sum"),
    ColumnSpec("halfDays", "Half Days", INTEGER, 0.7, total="sum"),
    ColumnSpec("absentDays", "Absent", INTEGER, 0.7, total="sum"),
    ColumnSpec("leaveDays", "Leave", INTEGER, 0.7, total="sum"),
    ColumnSpec("casualLeaves", "Casual Leave (in Present)", INTEGER, 0.9, total="sum"),
    ColumnSpec("permissions", "Permissions", INTEGER, 0.8, total="sum"),
    ColumnSpec("holidays", "Holidays", INTEGER, 0.7, total="sum"),
    ColumnSpec("weeklyOff", "Weekly Off", INTEGER, 0.7, total="sum"),
    ColumnSpec("lateDays", "Late Days", INTEGER, 0.7, total="sum"),
    ColumnSpec("earlyOutDays", "Early-Out Days", INTEGER, 0.8, total="sum"),
    ColumnSpec("effectiveDays", "Effective Days", NUMBER, 0.8, total="sum"),
    ColumnSpec("totalShifts", "Shift Credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("attendancePct", "Attendance %", PERCENT, 0.8),
    ColumnSpec("notProcessed", "Not Processed", INTEGER, 0.8, total="sum"),
)
_SUM_KEYS = [c.key for c in SUMMARY_COLUMNS if c.total == "sum"]
_FLOAT_KEYS = ("effectiveDays", "totalShifts")


def _run_summary(ctx) -> ReportResult:
    year, month = ctx.period
    m_start, m_end = month_bounds(year, month)
    today = ctx.today
    as_of = min(m_end, today)
    employees = scoped_employees(ctx, order="dept_code")
    emp_days_guard(len(employees), (m_end - m_start).days + 1)
    mask = bool(ctx.params.get("maskService"))
    data = AttendanceData(ctx, employees, m_start, m_end, service=mask)
    employees = drop_dormant(ctx, employees, data)
    ids = [e.id for e in employees]
    cl_counts = {
        r["employee_id"]: r["n"]
        for r in CasualLeaveRequest.objects.filter(
            employee_id__in=ids, status="approved", date__gte=m_start, date__lte=m_end
        ).values("employee_id").annotate(n=Count("id"))
    }
    perm_counts = {
        r["employee_id"]: r["n"]
        for r in EmployeePermission.objects.filter(
            employee_id__in=ids, status="approved", date__gte=m_start, date__lte=m_end
        ).values("employee_id").annotate(n=Count("id"))
    }

    all_days = [m_start + dt.timedelta(days=i) for i in range(calendar.monthrange(year, month)[1])]
    rows: list[dict] = []
    tot = defaultdict(float)
    staff_eff = staff_wd = staff_absent = 0.0
    for emp in employees:
        is_prod = emp.employment_type == "production"
        recs = []
        elapsed = 0
        counts = {"present": 0, "half": 0, "absent": 0, "leave": 0, "holiday": 0, "weekly_off": 0}
        eff_on_working = 0.0
        working = None
        if not is_prod:
            asg_sat = data.saturday_off(emp, m_start.replace(day=15))
            wd = {d for d in _build_working_days(month, year, asg_sat, set(data.holidays)) if d <= as_of}
            if mask:
                wd = {d for d in wd if data.in_service(emp, d)}
            working = len(wd)
        for d in all_days:
            if d > today or (mask and not data.in_service(emp, d)):
                continue
            elapsed += 1
            rec = data.record(emp.id, d)
            if rec is None:
                continue
            recs.append(rec)
            kind = data.kind(emp, d, rec)
            counts[kind] += 1
            if not is_prod and d in wd:
                eff_on_working += 1.0 if rec.status == "present" else 0.5 if rec.status == "half_shift" else 0.0
        s = month_summary_from_records(recs)
        row = {
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": emp.department.name if emp.department_id else "Unassigned",
            "designation": emp.designation.title if emp.designation_id else None,
            "employeeType": "Production" if is_prod else "Staff",
            "workingDays": working,
            "presentDays": counts["present"],
            "halfDays": counts["half"],
            "absentDays": counts["absent"],
            "leaveDays": counts["leave"],
            "casualLeaves": cl_counts.get(emp.id, 0),
            "permissions": perm_counts.get(emp.id, 0),
            "holidays": counts["holiday"],
            "weeklyOff": counts["weekly_off"],
            "lateDays": s["late"],
            "earlyOutDays": sum(1 for r in recs if r.early_leave),
            "effectiveDays": float(Decimal(s["effectiveDays"])),
            "totalShifts": float(Decimal(s["totalShifts"])),
            "attendancePct": round(eff_on_working * 100.0 / working, 1) if working else None,
            "notProcessed": elapsed - len(recs),
        }
        rows.append(row)
        for k in _SUM_KEYS:
            tot[k] += row[k] or 0
        if not is_prod and working:
            staff_eff += eff_on_working
            staff_wd += working
            staff_absent += counts["absent"]

    rows = with_subtotals(rows, group_by=lambda r: r["department"], sum_keys=_SUM_KEYS)
    totals = {k: (round(tot[k], 2) if k in _FLOAT_KEYS else int(tot[k])) for k in _SUM_KEYS}
    totals["attendancePct"] = round(staff_eff * 100.0 / staff_wd, 1) if staff_wd else None

    late_days = int(tot["lateDays"])
    heads = int(tot["presentDays"] + tot["halfDays"])
    notes = [
        f"Month: {month_label(year, month)}" + (f" - counted up to {today.strftime('%d-%b-%Y')} (the month is not over)." if as_of < m_end else "."),
        "Present / Half Days / Leave are the attendance engine's day verdicts (Present = both halves; casual-leave days are "
        "paid presents, so 'Casual Leave' is a subset of Present, not extra). Absent excludes Sundays and Saturday-off "
        "Saturdays (Weekly Off) and approved leave; Holidays are the company holiday list.",
        "Working days = payroll working days elapsed (Sundays, Saturday-off Saturdays and holidays excluded) for staff; "
        "attendance % = (full days + half a day per half day, on working days) / working days. Production is paid by "
        "shifts, so it has no working-day denominator or %: read Shift Credit.",
        "Late Days counts every day the engine flagged late (the late pool used for salary deduction merges excess "
        "permissions and only counts working days - see the late reports).",
    ]
    if mask:
        notes.append("Days before joining or after the approved last working day are not counted.")
    if tot["notProcessed"]:
        notes.append(
            f"{int(tot['notProcessed'])} elapsed employee-day(s) have no attendance record yet and are not counted in any "
            "status column (reports read the engine's stored result and never compute attendance)."
        )
    summary = [
        {"label": "Employees", "value": len(employees), "format": "integer"},
        {"label": "Staff attendance %", "value": totals["attendancePct"], "format": "percent"},
        {"label": "Staff absenteeism %", "value": round(staff_absent * 100.0 / staff_wd, 1) if staff_wd else None, "format": "percent"},
        {"label": "Present days", "value": int(tot["presentDays"]), "format": "integer"},
        {"label": "Absent days", "value": int(tot["absentDays"]), "format": "integer"},
        {"label": "Leave days", "value": int(tot["leaveDays"]), "format": "integer"},
        {"label": "Late % of worked days", "value": round(late_days * 100.0 / heads, 1) if heads else None, "format": "percent"},
        {"label": "Days not processed", "value": int(tot["notProcessed"]), "format": "integer"},
    ]
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="attendance-summary-monthly",
    title="Monthly Attendance Summary",
    description="Per-employee month tally: present, half, absent, leave, casual leave, permissions, holidays, late, "
    "effective days and attendance % against payroll working days, with department subtotals.",
    category="attendance",
    icon="BarChart3",
    tags=("monthly", "summary", "attendance percentage", "absenteeism", "present days", "working days"),
    modules=("attendance",),
    filters=(
        period(default="thisMonth", label="Month"),
        *scope_filters(status="all"),
        boolean("maskService", "Ignore days before joining / after leaving", default=True),
    ),
    columns=SUMMARY_COLUMNS,
    run=_run_summary,
    landscape=True,
    screen_limit=5_000,
    pdf_max_rows=3_000,
))

