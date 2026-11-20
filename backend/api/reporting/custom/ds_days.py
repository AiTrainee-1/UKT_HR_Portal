"""Customise data source "attendance_days": one row per employee per day (staff: calendar day; production: shift day).

Every value comes from the stored day verdict (AttendanceDayRecord, what payroll pays) and the day builder the attendance
registers use (definitions.attendance_core_data.build_day), so a row reads exactly like the Daily Attendance Register and
the Time Card. Days before the joining date, after the last working day and in the future are left out.
"""

from __future__ import annotations

from .. import filters as Fl
from ..definitions.attendance_core_data import (
    build_day,
    emp_days_guard,
    hours,
    leave_type_text,
    weekday_text,
)
from ..types import BADGE, DATE, HOURS, INTEGER, MINUTES, NUMBER, TEXT, TIME
from . import attendance as A
from .common import employee_cells, employee_fields, scope_filters, scoped_employees
from .fields import Dataset, Field, LoadResult, needs_of

MAX_DAYS = 62
STATUS_OPTIONS = (
    ("present", "Present"),
    ("half", "Half day"),
    ("absent", "Absent"),
    ("leave", "Leave"),
    ("holiday", "Holiday"),
    ("weekly_off", "Weekly off"),
    ("unprocessed", "Not processed yet"),
)


def _day(key, label, type_, desc=None, needs="day", total=None, width=1.0, align=None) -> Field:
    return Field(key, label, type_, "day", needs, desc, width=width, total=total, align=align)


FIELDS = (
    *employee_fields(),
    _day("day.date", "Date", DATE, "Staff: the calendar day; production: the shift day", width=1.1),
    _day("day.weekday", "Day", TEXT, width=0.6),
    _day("day.type", "Day type", TEXT, "Working day, Sunday, Saturday off or Holiday", width=1.2),
    _day("day.status", "Status", BADGE, "The stored verdict: Present, Half Day, Absent, Leave, Casual Leave ..."),
    _day("day.shift", "Shift", TEXT, "Staff: the shift assigned that day; production: the shift group that applied"),
    _day("day.first_in", "First in", TIME, needs="punches", width=0.8, align="center"),
    _day("day.last_out", "Last out", TIME, needs="punches", width=0.8, align="center"),
    _day("day.punch_count", "Punches", INTEGER, needs="punches", width=0.7),
    _day("day.punch_times", "Punch times", TEXT, "Every punch of the day in order", "punches", width=2.2),
    _day("day.worked_hours", "Worked hours", HOURS, "First to last punch less lunch", "punches", "sum", 0.9),
    _day("day.shifts_earned", "Shifts earned", NUMBER, "The shift credit payroll pays", total="sum", width=0.8),
    _day("day.late_minutes", "Late (min)", MINUTES, "Minutes after the (permission-shifted) start", total="sum"),
    _day("day.arrival_zone", "Arrival zone", TEXT, "Staff: On time, Late, Excused, Quarter or Second half", width=1.2),
    _day("day.early_minutes", "Early out (min)", MINUTES, "Minutes before the shift end", total="sum"),
    _day(
        "day.penalty", "Penalty early out (shift)", NUMBER, "Shift credit taken off for leaving too early", total="sum"
    ),
    _day("day.ot_minutes", "OT (min)", MINUTES, "Staff overtime as the HR Time Card counts it", "ot", "sum"),
    _day("day.leave_type", "Leave type", TEXT, needs="leaves"),
    _day(
        "day.flags",
        "Flags",
        TEXT,
        "Late, early out, permission, compensation, HR override, out of date ...",
        "punches",
        width=2.2,
    ),  # fmt: skip
    _day("day.entry", "Entry", TEXT, "Auto (from punches) or Manual (set by HR)", width=0.8),
    _day("day.punch_source", "Punch source", TEXT, "Biometric, On-Duty, Geo Punch or HR Entry", width=1.0),
)


def _load(ctx, keys: list[str], ceiling: int) -> LoadResult:
    needs = needs_of(ATTENDANCE_DAYS, keys)
    d_from, d_to = ctx.date_from, min(ctx.date_to, ctx.today)
    employees = scoped_employees(ctx)
    if d_to < d_from or not employees:
        return LoadResult(rows=[], notes=["The dates are in the future: there is no attendance to show yet."])
    days = list(A.days(d_from, d_to))
    emp_days_guard(len(employees), len(days))
    data = A.load(ctx, employees, d_from, d_to, punches="punches" in needs, leaves="leaves" in needs)
    exits = A.exit_dates(employees)
    threshold = data.settings.ot_threshold_minutes or 60
    ot_map = A.overtime_by_day([e.id for e in employees], d_from, d_to) if "ot" in needs else {}
    wanted = set(ctx.params.get("dayStatus") or ())
    windows = {e.id: A.window(e, d_from, d_to, exits) for e in employees}

    rows: list[dict] = []
    unprocessed = off_grid = 0
    capped = False
    for d in days:
        for emp in employees:
            win = windows[emp.id]
            if win is None or not win[0] <= d <= win[1]:
                continue
            day = build_day(data, emp, d)
            rec = day.rec
            status_key = day.kind or "unprocessed"
            if wanted and status_key not in wanted:
                continue
            if len(rows) >= ceiling:
                capped = True
                break
            flags = list(day.flags)
            if day.unprocessed:
                unprocessed += 1
                flags.append("Not processed yet")
            if A.off_grid(rec, emp):
                off_grid += 1
                flags.append(A.OFF_GRID_FLAG)
            row = {
                **employee_cells(emp),
                "day.date": d.isoformat(),
                "day.weekday": weekday_text(d),
                "day.type": A.day_type(data, emp, d),
                "day.status": day.label if day.label else ("Not processed" if day.unprocessed else None),
                "day.shift": _shift_name(data, day, emp),
                "day.first_in": day.first_in,
                "day.last_out": day.last_out,
                "day.punch_count": len(day.punches) or None,
                "day.punch_times": ", ".join(p.at.strftime("%H:%M") for p in day.punches) or None,
                "day.worked_hours": hours(day.worked_min),
                "day.shifts_earned": A.shifts(rec),
                "day.late_minutes": day.late_min,
                "day.arrival_zone": A.zone_text(rec, emp),
                # the stored minutes when the engine kept them (newer days), else worked out from the shift
                "day.early_minutes": rec.early_out_minutes
                if rec is not None and rec.early_out_minutes
                else day.early_min,
                "day.penalty": float(rec.penalty_deduction) if rec is not None and rec.penalty_early_out else None,
                "day.ot_minutes": A.ot_minutes(rec, emp, ot_map.get((emp.id, d)), threshold),
                "day.leave_type": leave_type_text(day.leave) if day.kind == "leave" else None,
                "day.flags": "; ".join(flags) or None,
                "day.entry": None if rec is None else ("Manual" if rec.source == "manual" else "Auto"),
                "day.punch_source": rec.primary_source if rec is not None else None,
            }
            rows.append(row)
        if capped:
            break
    notes: list[str] = []
    if unprocessed:
        notes.append(
            f"{unprocessed:,} employee-day(s) have no stored attendance record yet (nobody has opened them in Attendance): "
            "they show Not processed. Reports read the stored verdicts and never compute attendance."
        )
    if off_grid:
        notes.append(
            f"{off_grid:,} production day(s) carry a shift credit that is not on the quarter grid: they were stored before "
            "quarter shifts and are shown as stored (flagged Out of date) until the day is recomputed in Attendance."
        )
    return LoadResult(rows=rows, notes=notes, capped=capped)


def _shift_name(data, day, emp) -> str | None:
    if A.is_production(emp):
        judged = data.prod_judge().judgement(day.rec) if day.rec is not None else None
        if judged is not None and judged.group is not None:
            return judged.group.label
        return None
    return day.shift.name if day.shift is not None else None


ATTENDANCE_DAYS = Dataset(
    id="attendance_days",
    label="Attendance days",
    description="One row per employee per day: status, punches, hours, shift credit, late, early out, arrival zone and "
    f"overtime (up to {MAX_DAYS} days at a time).",
    grain="day",
    filters=(
        Fl.date_range(max_days=MAX_DAYS),
        *scope_filters(),
        Fl.select("dayStatus", "Day status", STATUS_OPTIONS, multi=True, placeholder="Every status"),
    ),
    sections=(("employee", "Employee"), ("day", "Day")),
    fields=FIELDS,
    default_fields=(
        "emp.code",
        "emp.name",
        "emp.department",
        "day.date",
        "day.status",
        "day.first_in",
        "day.last_out",
        "day.worked_hours",
        "day.shifts_earned",
        "day.late_minutes",
    ),  # fmt: skip
    load=_load,
    modules=("attendance",),
    notes=(
        "Status is the attendance engine's stored verdict (the record payroll reads); shift credit is what payroll pays. "
        "Staff days are calendar days; production days are shift days: a night shift's closing punch belongs to the day "
        "the shift began. Late / early-out minutes and worked hours are worked out from the punches and the shift, as on "
        "the Time Card.",
    ),
)
