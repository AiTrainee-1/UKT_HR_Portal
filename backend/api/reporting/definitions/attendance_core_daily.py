"""Daily Attendance Register and the Daily Absentee / Leave List (Report Log, Daily Report).

* daily-attendance: every employee for a day (or a short range) with first in / last out, hours, status and
  the late / half-day / permission flags -- the all-status superset of the Report Log's Daily Report.
* absentee-list-daily: the Report Log's Daily Report itself -- absent staff with an Informed / Not Informed
  call per employee, in the legacy order (department, then first name).

Both read the persisted engine verdict (AttendanceDayRecord, including HR's ``is_informed`` note); they never
compute or write attendance. A day nobody has opened has no record and is counted as "not processed".
"""

from __future__ import annotations

from ..filters import date_range, select
from ..registry import register
from ..types import BADGE, DATE, HOURS, INTEGER, MINUTES, NUMBER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    AttendanceData,
    build_day,
    drop_dormant,
    emp_days_guard,
    hours,
    leave_type_text,
    scope_filters,
    scoped_employees,
    source_text,
)

INFORMED = "Informed"
NOT_INFORMED = "Not Informed"
UNSET = "Unset"

STATUS_OPTIONS = [
    ("present", "Present"),
    ("half", "Half day"),
    ("absent", "Absent"),
    ("leave", "On leave"),
    ("holiday", "Holiday"),
    ("weekly_off", "Weekly off"),
    ("unprocessed", "Not processed"),
]
FLAG_OPTIONS = [
    ("late", "Late"),
    ("early_out", "Early out"),
    ("half_day", "Half day"),
    ("permission", "Permission"),
    ("missing_punch", "Missing / odd punch"),
    ("compensation_day", "Compensation day"),
    ("manual", "Manual / HR override"),
]
INFORMED_OPTIONS = [("informed", INFORMED), ("not_informed", NOT_INFORMED), ("unset", UNSET)]


def informed_text(day) -> str | None:
    """HR's call on an absent / on-leave day: Informed, Not Informed, or Unset (never asked). None for other days."""
    if day.rec is None or day.kind not in ("absent", "leave"):
        return None
    v = day.rec.is_informed
    return INFORMED if v is True else NOT_INFORMED if v is False else UNSET


def _flag_match(day, key: str) -> bool:
    rec = day.rec
    if key == "late":
        return bool(rec and rec.is_late)
    if key == "early_out":
        return bool(rec and rec.early_leave)
    if key == "half_day":
        return day.kind == "half"
    if key == "permission":
        return bool(
            rec and (
                rec.morning_permission_applied or rec.evening_permission_applied
                or rec.morning_permission_excess or rec.evening_permission_excess or rec.middle_permission_today
            )
        )
    if key == "missing_punch":
        return any(x in day.issues for x in ("single_punch", "odd_punches", "present_no_punches"))
    if key == "compensation_day":
        return bool(rec and rec.is_compensation_day)
    if key == "manual":
        return bool(rec and rec.source == "manual")
    return True


def _status_match(day, key: str) -> bool:
    if key == "unprocessed":
        return day.unprocessed
    return day.kind == key


def _load(ctx, *, punches: bool, order: str = "dept"):
    days = ctx.days_in_range
    employees = scoped_employees(ctx, order=order, limit=None)
    emp_days_guard(len(employees), len(days))
    data = AttendanceData(ctx, employees, ctx.date_from, ctx.date_to, punches=punches, leaves=True)
    return days, drop_dormant(ctx, employees, data), data


# ── Daily Attendance Register ───────────────────────────────────────────────────

DAILY_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("designation", "Designation", TEXT, 1.3),
    ColumnSpec("employeeType", "Type", TEXT, 0.9),
    ColumnSpec("shift", "Shift", TEXT, 1.2),
    ColumnSpec("firstIn", "First In", TIME, 0.8),
    ColumnSpec("lastOut", "Last Out", TIME, 0.8),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.7),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.9, total="sum"),
    ColumnSpec("status", "Status", BADGE, 1.1),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early Out (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("flags", "Flags", TEXT, 1.9),
    ColumnSpec("leaveType", "Leave Type", TEXT, 0.9),
    ColumnSpec("shiftsEarned", "Shift Credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("informed", "Informed", BADGE, 1.0),
    ColumnSpec("source", "Source", TEXT, 1.0),
)


def _run_daily(ctx) -> ReportResult:
    days, employees, data = _load(ctx, punches=True)
    want_status = ctx.params.get("status")
    want_flag = ctx.params.get("flag")
    want_informed = ctx.params.get("informed")
    today = ctx.today

    rows: list[dict] = []
    c = {"present": 0, "half": 0, "absent": 0, "leave": 0, "off": 0, "late": 0, "early": 0, "unprocessed": 0}
    split = {"staff": 0, "production": 0}
    for d in days:
        for emp in employees:
            day = build_day(data, emp, d)
            if want_status and not _status_match(day, want_status):
                continue
            if want_flag and not _flag_match(day, want_flag):
                continue
            inf = informed_text(day)
            if want_informed and (inf is None or inf != dict(INFORMED_OPTIONS)[want_informed]):
                continue
            rec = day.rec
            punches = day.punches
            rows.append({
                "date": d.isoformat(),
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "department": emp.department.name if emp.department_id else "Unassigned",
                "designation": emp.designation.title if emp.designation_id else None,
                "employeeType": "Production" if emp.employment_type == "production" else "Staff",
                "shift": day.shift.name if day.shift is not None else None,
                "firstIn": day.first_in,
                "lastOut": day.last_out,
                "punchCount": len(punches) or None,
                "workedHours": hours(day.worked_min),
                "status": day.label,
                "lateMinutes": day.late_min,
                "earlyOutMinutes": day.early_min,
                "flags": "; ".join(day.flags) or None,
                "leaveType": leave_type_text(day.leave) if day.kind == "leave" else None,
                "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                "informed": inf,
                "source": source_text(day),
            })
            if day.kind in ("present", "half", "absent", "leave"):
                c[day.kind] += 1
                split["production" if emp.employment_type == "production" else "staff"] += day.kind in ("present", "half")
            elif day.kind in ("holiday", "weekly_off"):
                c["off"] += 1
            if rec is not None and rec.is_late:
                c["late"] += 1
            if rec is not None and rec.early_leave:
                c["early"] += 1
            if day.unprocessed:
                c["unprocessed"] += 1
            if len(rows) > ctx.row_limit:
                break
        if len(rows) > ctx.row_limit:
            break

    working = c["present"] + c["half"] + c["absent"] + c["leave"]
    strength = round((c["present"] + c["half"]) * 100.0 / working, 1) if working else None
    notes = [
        "Status is the attendance engine's stored verdict for the day (the record payroll reads). Present = both "
        "halves attended; Half Day = one half; heads present (strength) = Present + Half Day. Casual-leave and "
        "compensation-off days are paid presents. Production half-day means 0.75 shift or less.",
        f"Present or half-day heads: {split['staff']} staff, {split['production']} production.",
        "Late / early-out minutes and worked hours are derived from the raw punches and the assigned shift "
        "(see the Time Card notes); Informed is HR's note on absent / on-leave days.",
    ]
    if any(d == today for d in days):
        notes.append("Today's Absent is provisional: the day is still in progress until the shift ends.")
    if c["unprocessed"]:
        notes.append(
            f"{c['unprocessed']} employee-day(s) have no attendance record yet (nobody has opened them in Attendance) "
            "and show a blank status - reports read the engine's stored result and never compute attendance."
        )
    summary = [
        {"label": "Employee-days", "value": len(rows), "format": "integer"},
        {"label": "Present", "value": c["present"], "format": "integer"},
        {"label": "Half day", "value": c["half"], "format": "integer"},
        {"label": "Absent", "value": c["absent"], "format": "integer"},
        {"label": "On leave", "value": c["leave"], "format": "integer"},
        {"label": "Late", "value": c["late"], "format": "integer"},
        {"label": "Strength %", "value": strength, "format": "percent"},
        {"label": "Not processed", "value": c["unprocessed"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="daily-attendance",
    title="Daily Attendance Register",
    description="Every employee for a day: first in, last out, hours, status and late / half-day / permission flags "
    "with day strength. The all-status version of the Report Log daily report.",
    category="attendance",
    icon="CalendarCheck",
    tags=("daily", "attendance", "strength", "present", "absent", "register"),
    modules=("attendance",),
    filters=(
        date_range(default="today", label="Date", max_days=31),
        *scope_filters(status="active", search=True),
        select("status", "Status", STATUS_OPTIONS, placeholder="All statuses"),
        select("flag", "Flag", FLAG_OPTIONS, placeholder="Any"),
        select("informed", "Informed", INFORMED_OPTIONS, placeholder="Any",
               help="HR's note on absent or on-leave days."),
    ),
    columns=DAILY_COLUMNS,
    run=_run_daily,
    landscape=True,
    screen_limit=10_000,
    pdf_max_rows=6_000,
))


# ── Daily Absentee / Leave List (Report Log, Daily Report) ──────────────────────

ABSENTEE_COLUMNS = (
    ColumnSpec("sno", "S.No", INTEGER, 0.5),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("employeeCode", "Ticket No", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee Name", TEXT, 2.4),
    ColumnSpec("department", "Department", TEXT, 1.6),
    ColumnSpec("designation", "Designation", TEXT, 1.6),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("informedStatus", "Informed Status", BADGE, 1.2),
)
SHOW_OPTIONS = [("absent", "Absent"), ("leave", "On leave"), ("both", "Absent and on leave")]


def _run_absentee(ctx) -> ReportResult:
    days, employees, data = _load(ctx, punches=False)
    show = ctx.params.get("show") or "absent"
    want_informed = ctx.params.get("informed")
    kinds = {"absent": ("absent",), "leave": ("leave",), "both": ("absent", "leave")}[show]
    today = ctx.today

    rows: list[dict] = []
    counts = {INFORMED: 0, NOT_INFORMED: 0, UNSET: 0}
    weekly_off = unprocessed = provisional = 0
    for d in days:
        sno = 0
        for emp in employees:
            rec = data.record(emp.id, d)
            if rec is None:
                if d <= today:
                    unprocessed += 1
                continue
            kind = data.kind(emp, d, rec)
            if kind == "weekly_off" and rec.status == "absent":
                weekly_off += 1  # a saturday_off Saturday: stored as absent, but not an absence
            if kind not in kinds:
                continue
            day = build_day(data, emp, d)
            inf = informed_text(day)
            if want_informed and inf != dict(INFORMED_OPTIONS)[want_informed]:
                continue
            sno += 1
            counts[inf] += 1
            provisional += bool(day.in_progress)
            rows.append({
                "sno": sno,
                "date": d.isoformat(),
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "department": emp.department.name if emp.department_id else "Unassigned",
                "designation": emp.designation.title if emp.designation_id else None,
                "status": day.label,
                "informedStatus": inf,
            })
            if len(rows) > ctx.row_limit:
                break
        if len(rows) > ctx.row_limit:
            break

    notes = [
        "The Report Log's Daily Report: staff who are absent for the date, with HR's Informed / Not Informed call. "
        "Informed status is set on the Report Log page; this report only reads it.",
        "Employees on approved leave are on leave, not absent; a Saturday-off Saturday and Sundays are weekly offs "
        f"and are not listed ({weekly_off} weekly-off day(s) left out)." if weekly_off else
        "Employees on approved leave are on leave, not absent; Sundays and Saturday-off Saturdays are weekly offs "
        "and are not listed.",
    ]
    if len(days) == 1:
        d0 = days[0]
        notes.insert(0, f"Staff leave list for {d0.day:02d}.{d0.month:02d}.{d0.year}")
    if any(d == today for d in days) and provisional:
        notes.append(
            f"{provisional} absence(s) are for today and provisional - the engine marks everyone who has not punched "
            "yet as absent until the shift ends."
        )
    if unprocessed:
        notes.append(
            f"{unprocessed} employee-day(s) have no attendance record yet and are not listed - open the day in "
            "Attendance first (reports never compute attendance)."
        )
    summary = [
        {"label": "Listed", "value": len(rows), "format": "integer"},
        {"label": INFORMED, "value": counts[INFORMED], "format": "integer"},
        {"label": NOT_INFORMED, "value": counts[NOT_INFORMED], "format": "integer"},
        {"label": UNSET, "value": counts[UNSET], "format": "integer"},
        {"label": "Weekly off (left out)", "value": weekly_off, "format": "integer"},
        {"label": "Not processed", "value": unprocessed, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="absentee-list-daily",
    title="Daily Absentee / Leave List",
    description="Absent staff for a date with HR's Informed / Not Informed status per employee - the Report Log "
    "daily report, ready to print for the morning call round.",
    category="attendance",
    icon="UserX",
    tags=("absent", "absentee", "leave list", "informed", "report log", "daily report"),
    modules=("attendance",),
    filters=(
        date_range(default="today", label="Date", max_days=31),
        *scope_filters(status="active", staff_default="staff", search=True),
        select("show", "Show", SHOW_OPTIONS, default="absent", placeholder="Absent"),
        select("informed", "Informed status", INFORMED_OPTIONS, placeholder="Any"),
    ),
    columns=ABSENTEE_COLUMNS,
    run=_run_absentee,
    landscape=False,
    screen_limit=10_000,
    pdf_max_rows=6_000,
))

