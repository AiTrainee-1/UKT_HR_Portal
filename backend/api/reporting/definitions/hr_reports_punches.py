"""HR Reports (category ``hr``): the company's two printed punch registers, reproduced from the HRMS data.

hr-daily-movement-register: the "Daily Movement Register". One line per employee per date with every punch of the day
in time order (Time1 .. Time12), each as "8:58 AM-I" (12-hour time + the one-letter direction stored on the punch).

hr-punching-register: the "Punching Register (Employees Present List)". One line per PRESENT employee per date with the
shift in-time, the actual (first-punch) in-time and how late it was.

Both are grouped by department the way the printouts are: a department heading line, then its employees in ticket-number
(employee code) order, with the serial number (SNo) running on across departments. Only the DATA, columns and grouping
follow the printouts: the on-screen design, Excel and PDF are the Report Center's own.

Read-only. Punches come from ``AttendanceData.punches`` (the engine's own day placement: a staff exit after midnight
belongs to the day it closes, a production night session to the shift day) and the lateness is the stored day verdict
(``AttendanceDayRecord.is_late``) measured by ``attendance_core_data.late_minutes``. Nothing is computed or saved here.
"""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import timedelta

from django.db.models import Q

from api.models import AttendanceDayRecord, AttendanceLog

from .. import filters as F
from ..formatting import full_name
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    L_HALF,
    L_PRESENT,
    AttendanceData,
    build_day,
    emp_days_guard,
    weekday_text,
)
from .employees_master_base import UNASSIGNED, code_key, department_name

CATEGORY = "hr"
MODULES = ("attendance",)  # punches and attendance verdicts only: no pay is printed
MAX_DAYS = 31  # a month, like Production Daily Punches: the widest range both registers offer

MOVEMENT_ID = "hr-daily-movement-register"
PRESENT_ID = "hr-punching-register"

TIME_SLOTS = 12


# ── shared helpers ──────────────────────────────────────────────────────────────


def _clock12(t, pad: bool) -> str:
    """12-hour clock text: '8:58 AM' (no leading zero, the movement register) or '08:58 AM' (the punching register)."""
    hour = t.hour % 12 or 12
    suffix = "AM" if t.hour < 12 else "PM"
    return f"{hour:02d}:{t.minute:02d} {suffix}" if pad else f"{hour}:{t.minute:02d} {suffix}"


def _dept_sort_key(emp) -> tuple:
    """Department name (A-Z, no-department last), then ticket number in natural order: the printouts' order."""
    name = department_name(emp)
    return (name == UNASSIGNED, name.lower(), code_key(emp.employee_code))


def _employees_to_read(ctx, *, also=None) -> list:
    """The scoped employees (filters + branch isolation, already applied by ``ctx.employees()``) who have a stored punch in
    the range (the day after is included: an exit after midnight is placed on the day it closes), or ``also``. Ordered
    by department, then ticket number. One query for the people, none per person."""
    punched = AttendanceLog.objects.filter(date__gte=ctx.date_from, date__lte=ctx.date_to + timedelta(days=1)).values(
        "employee_id"
    )
    cond = Q(id__in=punched)
    if also is not None:
        cond |= also
    return sorted(ctx.employees().filter(cond), key=_dept_sort_key)


def _scope_note(date_from, date_to) -> str:
    if date_from == date_to:
        return f"One line per employee for {date_from.strftime('%d-%b-%Y')}."
    return (
        f"Date range {date_from.strftime('%d-%b-%Y')} to {date_to.strftime('%d-%b-%Y')}: one line per employee per "
        "date, an employee's dates together in date order."
    )


PLACEMENT_NOTE = (
    "A punch is listed on the day the attendance engine places it: a staff exit made after midnight (within the "
    "post-shift window in Settings) belongs to the day it closes and is marked (+1); from the date the production "
    "shift-table rules start, a night worker's closing punch belongs to the day the shift began. Other punches keep "
    "the calendar date the device stamped, as in the Punch Log."
)


# ── Daily Movement Register ─────────────────────────────────────────────────────

MOVEMENT_COLUMNS = (
    ColumnSpec("sno", "SNo", INTEGER, 0.55),
    ColumnSpec("ticketNo", "TicketNo", TEXT, 0.9),
    ColumnSpec("empName", "EmpName", TEXT, 2.4),
    ColumnSpec("date", "Date", TEXT, 1.3),
    *(ColumnSpec(f"time{n}", f"Time{n}", TEXT, 1.0, align="center") for n in range(1, TIME_SLOTS + 1)),
)


def _direction_letter(stored) -> str:
    """'I' / 'O' from the direction stored on the punch (IN / OUT); anything else keeps its first letter."""
    text = (stored or "").strip().upper()
    if text == "IN":
        return "I"
    if text == "OUT":
        return "O"
    return text[:1] or "I"


def _stored_directions(ctx, ids) -> dict:
    """{(employee id, stamped date, time): [stored directions, oldest row first]} for every punch the run can place, in
    ONE query. A punch the engine places on a day is matched back to its stored row by employee, stamped date and time."""
    out: dict = defaultdict(deque)
    for eid, day, at, direction in (
        AttendanceLog.objects.filter(
            employee_id__in=ids, date__gte=ctx.date_from, date__lte=ctx.date_to + timedelta(days=1)
        )
        .order_by("employee_id", "date", "punch_time", "id")
        .values_list("employee_id", "date", "punch_time", "punch_type")
    ):
        out[(eid, day, at)].append(direction)
    return out


def _movement_run(ctx) -> ReportResult:
    date_from, date_to = ctx.date_from, ctx.date_to
    days = ctx.days_in_range
    emps = _employees_to_read(ctx)
    emp_days_guard(len(emps), len(days))
    data = AttendanceData(ctx, emps, date_from, date_to, punches=True)
    directions = _stored_directions(ctx, [e.id for e in emps]) if emps else {}

    rows: list[dict] = []
    data_rows = total_punches = crowded = after_midnight = 0
    people: set[int] = set()
    departments: set[str] = set()
    heading = None
    for e in emps:
        dept = department_name(e)
        for d in days:
            if d > ctx.today:  # nothing can have happened yet; the engine treats a future day the same way
                continue
            punches = data.punches(e, d)
            if not punches:
                continue
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            if dept != heading:
                rows.append({"empName": dept, "_kind": KIND_SUBTOTAL})
                heading = dept
                departments.add(dept)
            data_rows += 1
            total_punches += len(punches)
            people.add(e.id)
            row = {
                "sno": data_rows,
                "ticketNo": e.employee_code,
                "empName": full_name(e),
                "date": f"{d.strftime('%d/%m/%y')} {weekday_text(d)}",
            }
            for n, p in enumerate(punches[:TIME_SLOTS], start=1):
                stored = directions.get((e.id, p.on, p.at))
                letter = _direction_letter(stored.popleft() if stored else None)
                text = f"{_clock12(p.at, pad=False)}-{letter}"
                if p.on > d:
                    text += " (+1)"
                    after_midnight += 1
                row[f"time{n}"] = text
            if len(punches) > TIME_SLOTS:
                crowded += 1
                row[f"time{TIME_SLOTS}"] += f" (+{len(punches) - TIME_SLOTS} more)"
            rows.append(row)
        else:
            continue
        break  # the row limit was reached inside the date loop

    summary = [
        {"label": "Employees", "value": len(people), "format": "integer"},
        {"label": "Employee-days listed", "value": data_rows, "format": "integer"},
        {"label": "Punches", "value": total_punches, "format": "integer"},
        {"label": "Departments", "value": len(departments), "format": "integer"},
        {"label": f"Days with more than {TIME_SLOTS} punches", "value": crowded, "format": "integer"},
    ]
    notes = [
        _scope_note(date_from, date_to)
        + " Grouped by department, in ticket-number order; SNo runs on across departments. Employees with no punch on "
        "a date are not listed.",
        f"Time1 to Time{TIME_SLOTS} are every punch of that day in time order (12-hour clock), whatever its source: "
        "biometric device, geo punch, on-duty, an approved missing punch or a manual entry. Double taps are listed as "
        "they were stored.",
        "The letter after each time (I or O) is the direction stored on the punch record, kept exactly as stored. "
        "Biometric devices often send every punch as In, so it is not a reliable In / Out; the Punch Log report shows "
        "the positional In / Out (1st punch In, 2nd Out ...).",
        PLACEMENT_NOTE,
    ]
    if crowded:
        notes.append(
            f"{crowded} employee-day(s) have more than {TIME_SLOTS} punches: Time{TIME_SLOTS} shows the "
            f"{TIME_SLOTS}th punch and how many more there were, e.g. (+3 more). The Punch Log report lists them all."
        )
    if after_midnight:
        notes.append(f"{after_midnight} punch(es) were made after midnight and are shown on the day they close, (+1).")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=MOVEMENT_ID,
        title="Daily Movement Register",
        description="Every punch of each employee for the day in time order (Time1 to Time12), grouped by department, "
        "as in the printed Daily Movement Register.",
        category=CATEGORY,
        modules=MODULES,
        icon="ArrowLeftRight",
        tags=(
            "daily movement",
            "movement register",
            "punch",
            "punches",
            "time1",
            "ticket",
            "register",
            "biometric",
            "department",
            "attendance",
        ),
        filters=(
            F.date_range(default="today", label="Date", max_days=MAX_DAYS),
            *F.scope(status="active"),
        ),
        columns=MOVEMENT_COLUMNS,
        run=_movement_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ── Punching Register (Employees Present List) ──────────────────────────────────

NATURE_NOT_RECORDED = (
    "Nature of Emp (Day scholar / Hostel) is not recorded in the HRMS yet: the employee record has no such field, so "
    "this column is blank (a dash) for everyone until one is added."
)

PRESENT_COLUMNS = (
    ColumnSpec("sno", "SNo", INTEGER, 0.55),
    ColumnSpec("ticketNo", "Ticket No", TEXT, 0.9),
    ColumnSpec("empName", "Employee Name", TEXT, 2.3),
    ColumnSpec("designation", "Designation", TEXT, 2.0),
    ColumnSpec("nature", "Nature of Emp", TEXT, 1.1),
    ColumnSpec("date", "Date", TEXT, 1.3),
    ColumnSpec("shiftIn", "Shift InTime", TEXT, 1.0, align="center"),
    ColumnSpec("actIn", "Act InTime", TEXT, 1.0, align="center"),
    ColumnSpec("lateHours", "Late Hours", TEXT, 0.9, align="center"),
)


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _present_run(ctx) -> ReportResult:
    date_from, date_to = ctx.date_from, ctx.date_to
    days = ctx.days_in_range
    # People marked present or half day with no punch at all (an HR entry) belong on the list too.
    marked = Q(
        id__in=AttendanceDayRecord.objects.filter(
            date__gte=date_from,
            date__lte=date_to,
            status__in=(AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF),
        ).values("employee_id")
    )
    emps = _employees_to_read(ctx, also=marked)
    emp_days_guard(len(emps), len(days))
    data = AttendanceData(ctx, emps, date_from, date_to, punches=True)

    rows: list[dict] = []
    data_rows = late_count = late_unmeasured = no_shift = no_punch = unprocessed = 0
    people: set[int] = set()
    departments: set[str] = set()
    heading = None
    for e in emps:
        dept = department_name(e)
        for d in days:
            day = build_day(data, e, d)
            # Present = a punch, or a stored present / half-day verdict (casual-leave and comp-off days are stored as
            # "present" by HR but nobody came in: they are not on this list).
            if not (day.punches or day.label in (L_PRESENT, L_HALF)):
                continue
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            if dept != heading:
                rows.append({"empName": dept, "_kind": KIND_SUBTOTAL})
                heading = dept
                departments.add(dept)
            data_rows += 1
            people.add(e.id)

            shift_in = _clock12(day.shift.start_time, pad=True) if day.shift is not None else None
            no_shift += shift_in is None
            # the first punch of the day; with no punch, an HR-entered day's stored first punch
            first_at = day.punches[0].at if day.punches else (day.rec.first_punch if day.rec is not None else None)
            first_in = _clock12(first_at, pad=True) if first_at is not None else None
            no_punch += first_in is None
            unprocessed += day.rec is None
            late_text = None
            if day.rec is not None and day.rec.is_late:
                late_count += 1
                if day.late_min:
                    late_text = _hhmm(day.late_min)
                else:  # flagged late by the engine but the minutes cannot be measured (a company late-in window ...)
                    late_text = "Late"
                    late_unmeasured += 1
            rows.append(
                {
                    "sno": data_rows,
                    "ticketNo": e.employee_code,
                    "empName": full_name(e),
                    "designation": e.designation.title if e.designation_id else None,
                    "nature": None,
                    "date": f"{d.strftime('%d/%m/%Y')} {weekday_text(d)}",
                    "shiftIn": shift_in,
                    "actIn": first_in,
                    "lateHours": late_text,
                }
            )
        else:
            continue
        break  # the row limit was reached inside the date loop

    summary = [
        {"label": "Present employees", "value": len(people), "format": "integer"},
        {"label": "Employee-days listed", "value": data_rows, "format": "integer"},
        {"label": "Late arrivals", "value": late_count, "format": "integer"},
        {"label": "On time", "value": data_rows - late_count, "format": "integer"},
        {"label": "No shift assigned", "value": no_shift, "format": "integer"},
    ]
    notes = [
        _scope_note(date_from, date_to)
        + " Only employees who were present are listed (a punch, or a present / half-day verdict). Grouped by "
        "department, in ticket-number order; SNo runs on across departments.",
        NATURE_NOT_RECORDED,
        "Shift InTime is the start time of the employee's shift assignment in force on that date (the assignment with "
        "the latest start wins, with any custom start time set for the employee). A dash means no shift was assigned "
        "that day.",
        "Act InTime is the first punch of the day (the engine's placement of the day's punches: a staff exit made after "
        "midnight belongs to the day it closes). A day HR marked present by hand shows the first punch stored on it.",
        "Late Hours is read from the day's stored verdict: when the attendance engine flagged the day late, it is how "
        "far past the shift start (as HH:MM, shifted by an approved morning permission or a next-day overtime allowance "
        "where one applied) the first punch was; otherwise a dash. Nothing is judged again here, so the grace period "
        "and the permission rules are the engine's own. Production days judged by the shift table are measured from "
        "that table's group start, which can differ from the shift assignment's start time shown.",
    ]
    if late_unmeasured:
        notes.append(
            f"{late_unmeasured} late day(s) show the word Late instead of a time: the engine flagged them late but the "
            "minutes cannot be measured (for example a company-announced late-in time applied)."
        )
    if unprocessed:
        notes.append(
            f"{unprocessed} listed day(s) have no stored attendance verdict yet (nobody has opened them in Attendance), "
            "so Late Hours is a dash for them."
        )
    if no_punch:
        notes.append(f"{no_punch} listed day(s) are marked present with no punch, so Act InTime is a dash.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=PRESENT_ID,
        title="Punching Register (Employees Present List)",
        description="Employees present on the date, by department: shift in-time, actual in-time (first punch) and "
        "late hours, as in the printed Punching Register.",
        category=CATEGORY,
        modules=MODULES,
        icon="ClipboardCheck",
        tags=(
            "punching register",
            "present list",
            "employees present",
            "shift intime",
            "act intime",
            "late hours",
            "nature of emp",
            "hostel",
            "day scholar",
            "attendance",
            "department",
        ),
        filters=(
            F.date_range(default="today", label="Date", max_days=MAX_DAYS),
            *F.scope(status="active"),
        ),
        columns=PRESENT_COLUMNS,
        run=_present_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)
