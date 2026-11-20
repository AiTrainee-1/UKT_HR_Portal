"""Attendance category of the 2026-11-19 Report Center layout: the staff-side reports (and the Time Card with Shift Count,
which covers both kinds of employee).

* staff-attendance-report  -- the staff muster: one row per employee, a coloured cell per date (P / P¾ / ½M / ½E / A / L /
  CL / OD / H / WO ...), totals, Shifts paid (what staff payroll pays as days: shifts earned on working days + declared
  holidays), Sun/H work and Eff. % from the shifts actually earned (attendance-muster-sheet's grid with the quarter-shift
  and Penalty Early Out deductions made visible).
* staff-time-card-report   -- time-card pinned to staff, plus the arrival zone, quarter-shift and Penalty Early Out.
* time-card-shift-count    -- a day-wise time card for staff or production with the day's shift count and a total line per
  employee (staff: shifts earned on the calendar day; production: shifts earned per SHIFT day).
* late-detection           -- late-coming-detail plus the arrival zone, with the quarter-shift, second-half and excused
  arrivals included (they are not late marks, so the older report never showed them).
* monthly-misspunch        -- every day of a month whose punches are incomplete (single / odd) or that has a Missing Punch
  request, with the request status and the day's verdict now.
* attendance-log-report    -- daily-attendance pinned to staff, with every punch and the quarter / penalty flags.

All of them read the STORED engine verdict (AttendanceDayRecord: what payroll pays) and the raw punches through the
attendance_core loaders; nothing is computed or written. See rc_attendance_staff_util for the shared pieces.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q

from api.arrival_rules import ZONE_EXCUSED, ZONE_LATE, ZONE_QUARTER, ZONE_SECOND_HALF
from api.attendance_final import half_period
from api.models import AttendanceDayRecord, MissingPunchRequest
from api.shift_engine import _t2s

from ..common import EMP_COLS_SHORT, emp_cells
from ..filters import (
    ReportParamError,
    boolean,
    branches,
    date_range,
    departments,
    designations,
    employee_status,
    employees,
    period,
    select,
    text,
)
from ..formatting import month_bounds, month_label
from ..registry import register
from ..runner import KIND_SUBTOTAL, KIND_TOTAL
from ..types import (
    BADGE,
    DATE,
    HOURS,
    INTEGER,
    MINUTES,
    NUMBER,
    PERCENT,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .attendance_analysis_common import (
    Roster,
    STATUS_LABELS,
    day_records,
    emp_sort_key,
    hm,
    morning_lateness,
    payroll_settings,
    people,
    production_config,
    secs_hm,
    subtotals_within_limit,
)
from .attendance_analysis_late import (
    MIN_LATE,
    _lateness,
    _morning_basis,
    _permission_badge,
    _pool_status,
    _window_late,
)
from .attendance_core_daily import STATUS_OPTIONS as LOG_STATUS_OPTIONS
from .attendance_core_daily import _flag_match, _status_match
from .attendance_core_data import (
    EXC_ODD,
    EXC_SINGLE,
    EXCEPTION_LABELS,
    L_CASUAL,
    L_COMP,
    STALE_LEAVE,
    STALE_PUNCHES,
    WEEKDAYS,
    allowance_minutes,
    build_day,
    detection_notes,
    drop_dormant,
    emp_days_guard,
    hhmm,
    hours,
    is_relaxation_day,
    label_for,
    source_text,
    weekday_text,
)
from .attendance_core_timecard import (
    DAY_STATUS_OPTIONS,
    LONG_RANGE_DAYS,
    LONG_RANGE_MAX_EMPLOYEES,
    _matches,
    _remarks,
    build_time_card_pdf,
)
from .rc_attendance_staff_util import (
    ARRIVAL_OPTIONS,
    OFF_GRID,
    RcData,
    arrival_label,
    build_grid_pdf,
    build_grid_xlsx,
    coverage_missing,
    day_key,
    dept_name,
    emp_name,
    fraction_suffix,
    half_casual_leave,
    missing_punch_requests,
    off_quarter_grid,
    on_duty_days,
    penalty_deducted,
    quarter_deducted,
    rc_employees,
    shift_text,
    staff_working_day,
    type_text,
    zone_flags,
    zone_of,
)

CATEGORY = "attendance"
MODULES = ("attendance",)

GRID_ID = "staff-attendance-report"
CARD_ID = "staff-time-card-report"
SHIFT_COUNT_ID = "time-card-shift-count"
LATE_ID = "late-detection"
MISSPUNCH_ID = "monthly-misspunch"
LOG_ID = "attendance-log-report"


# ── shared filters / words ──────────────────────────────────────────────────────


def staff_scope(status: str = "active") -> tuple:
    """Branch / department / designation / employee / status: the scope of a staff-only report (the type is fixed)."""
    return (branches(), departments(), designations(), employees(), employee_status(status))


def type_choice(default: str) -> object:
    """Employee type with a real server-side default (the shared employmentType filter only pre-fills the form)."""
    return select(
        "staffType",
        "Employee type",
        [("staff", "Staff"), ("production", "Production"), ("all", "All employees")],
        default=default,
        placeholder={"staff": "Staff", "production": "Production"}.get(default, "All employees"),
        help="Staff are judged by calendar day and the staff rules; production by SHIFT day and the shift table.",
    )


def _settings_words(settings) -> tuple[str, str, str]:
    q = Decimal(str(getattr(settings, "arrival_quarter_deduction", "0.25") or 0)).normalize()
    p = Decimal(str(getattr(settings, "early_out_penalty_deduction", "0.25") or 0)).normalize()
    m = int(getattr(settings, "early_out_penalty_minutes", 0) or 0)
    return f"{q:f}", f"{p:f}", str(m)


def arrival_note(settings) -> str:
    q, p, m = _settings_words(settings)
    return (
        "Arrival is where the first punch fell on the morning arrival timeline (Settings > Attendance), as the engine "
        "stored it: On time; Late (inside the Late window - a late-pool mark); Excused (an approved Morning Late-In "
        f"permission covered it); Quarter (after the Late window - {q} shift comes off a full day instead of a late "
        "mark); Second half (the first half was missed). Penalty Early Out takes "
        f"{p} shift off a present day left more than {m} minutes before its end. Both deductions are already out of the "
        "stored shifts earned, which is what payroll pays."
    )


def unprocessed_note(n: int) -> str | None:
    if not n:
        return None
    return (
        f"{n:,} past employee-day(s) have no stored attendance record yet and are shown blank. The background refresh "
        "computes the days from the 1st of the previous month to today; reports never compute attendance themselves."
    )


# ═════════════════════════════════════════════════════════════════════════════
#  1. Staff Attendance Report (muster grid)
# ═════════════════════════════════════════════════════════════════════════════

GRID_TOTALS = (
    ColumnSpec("present", "P", INTEGER, 0.5, total="sum"),
    ColumnSpec("half", "½", INTEGER, 0.5, total="sum"),
    ColumnSpec("absent", "A", INTEGER, 0.5, total="sum"),
    ColumnSpec("leave", "L", INTEGER, 0.5, total="sum"),
    ColumnSpec("casualLeave", "CL", NUMBER, 0.55, total="sum"),
    ColumnSpec("onDuty", "OD", INTEGER, 0.5, total="sum"),
    ColumnSpec("off", "H/WO", INTEGER, 0.6, total="sum"),
    ColumnSpec("late", "Late", INTEGER, 0.55, total="sum"),
    ColumnSpec("quarter", "Qtr", INTEGER, 0.5, total="sum"),
    ColumnSpec("penaltyEo", "PEO", INTEGER, 0.5, total="sum"),
    ColumnSpec("workingDays", "WD", INTEGER, 0.5, total="sum"),
    ColumnSpec("shifts", "Shifts paid", NUMBER, 0.7, total="sum"),
    ColumnSpec("offDayShifts", "Sun/H work", NUMBER, 0.7, total="sum"),
    ColumnSpec("attendancePct", "Eff. %", PERCENT, 0.7),
)
# Staff payroll pays these statuses on a working day by their stored shifts earned (a present day with none stored: 1),
# and a day HR marked as a holiday as 1 (rc_salary_gained._staff, payroll_views._generate_staff_payroll)
_PAID_STATUSES = (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)
_GRID_INT = ("present", "half", "absent", "leave", "onDuty", "off", "late", "quarter", "penaltyEo", "workingDays")


def grid_code(data, emp, d, rec, kind: str, on_duty: bool, cl_portion: str | None) -> str:
    """The cell of one stored staff day. A present day shows its shift deduction (P¾ = 0.75 earned: a quarter-shift
    arrival or a Penalty Early Out; P½ = both); an approved on-duty day is OD; a paid casual leave CL (CL½ half a day,
    the other half by the punches); a half day the half that was worked (the stored arrival zone decides)."""
    if kind == "present":
        label = label_for("present", rec)
        if label == L_CASUAL or cl_portion == "full":
            return "CL"
        if cl_portion:
            return "CL½"
        base = "CO" if label == L_COMP else "OD" if on_duty else "P"
        return base + fraction_suffix(rec.shifts_earned)
    if kind == "half":
        if cl_portion:
            return "CL½"
        if is_relaxation_day(rec) and rec.first_punch is None:
            return "½"
        return "½M" if half_period(rec, data.settings) == "morning" else "½E"
    return {"leave": "L", "holiday": "H", "weekly_off": "WO"}.get(kind, "A")


def _run_grid(ctx) -> ReportResult:
    days = ctx.days_in_range
    today = ctx.today
    emps = rc_employees(ctx, staff_type="staff", search=ctx.params.get("search"))
    emp_days_guard(len(emps), len(days))
    data = RcData(ctx, emps, ctx.date_from, ctx.date_to, service=True)
    emps = drop_dormant(ctx, emps, data)
    ids = [e.id for e in emps]
    od_days = on_duty_days(ids, ctx.date_from, ctx.date_to)
    cl_half = half_casual_leave(ids, ctx.date_from, ctx.date_to)

    columns = [
        ColumnSpec("sno", "S.No", INTEGER, 0.45),
        ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
        ColumnSpec("employeeName", "Employee Name", TEXT, 2.0),
        ColumnSpec("department", "Department", TEXT, 1.3),
        *(ColumnSpec(day_key(d), f"{d.day} {WEEKDAYS[d.weekday()][:2]}", TEXT, 0.45, align="center") for d in days),
        *GRID_TOTALS,
    ]
    rows: list[dict] = []
    strength: dict[str, int] = defaultdict(int)
    tot: dict[str, float] = defaultdict(float)
    eff_all = Decimal("0")
    missing = deducted_days = 0
    for i, emp in enumerate(emps, start=1):
        row: dict = {
            "sno": i,
            "employeeCode": emp.employee_code,
            "employeeName": emp_name(emp),
            "department": dept_name(emp),
        }
        c: Counter = Counter()
        cl = Decimal("0")
        paid = eff = off_work = Decimal("0")
        for d in days:
            k = day_key(d)
            row[k] = None
            if d > today:
                continue
            if not data.in_service(emp, d):
                continue
            working = staff_working_day(data, emp, d)
            c["workingDays"] += working
            if d in data.holidays and d.weekday() != 6 and not (d.weekday() == 5 and data.saturday_off(emp, d)):
                paid += 1  # payroll pays a declared holiday on a company day (worked or not)
            rec = data.record(emp.id, d)
            if rec is None:
                missing += 1
                continue
            kind = data.kind(emp, d, rec)
            portion = cl_half.get((emp.id, d)) if kind in ("present", "half") else None
            od = (emp.id, d) in od_days and kind in ("present", "half")
            code = grid_code(data, emp, d, rec, kind, od, portion)
            row[k] = code
            if code == "CL":
                cl += 1
            elif kind == "present":
                c["present"] += 1
            elif kind == "half":
                c["half"] += 1
            elif kind in ("absent", "leave"):
                c[kind] += 1
            else:
                c["off"] += 1
            if portion and code != "CL":
                cl += Decimal("0.5")
            c["onDuty"] += od
            c["late"] += bool(rec.is_late)
            c["quarter"] += quarter_deducted(rec) is not None
            c["penaltyEo"] += bool(rec.penalty_early_out)
            deducted_days += quarter_deducted(rec) is not None or bool(rec.penalty_early_out)
            earned = Decimal(rec.shifts_earned or 0)
            if working:
                eff += earned
                if rec.status in _PAID_STATUSES:
                    paid += earned if earned > 0 else 1
                elif rec.status == AttendanceDayRecord.STATUS_HOLIDAY:
                    paid += 1
            else:
                off_work += earned  # a Sunday, a Saturday off or a holiday: not a payroll day
            if kind in ("present", "half"):
                strength[k] += 1
        row.update({key: c[key] for key in _GRID_INT})
        row["casualLeave"] = float(cl)
        row["shifts"] = float(paid)
        row["offDayShifts"] = float(off_work)
        row["attendancePct"] = round(float(eff) * 100.0 / c["workingDays"], 1) if c["workingDays"] else None
        rows.append(row)
        for key in _GRID_INT:
            tot[key] += c[key]
        tot["casualLeave"] += float(cl)
        tot["shifts"] += float(paid)
        tot["offDayShifts"] += float(off_work)
        eff_all += eff

    totals = None
    if rows:
        totals = {key: int(tot[key]) for key in _GRID_INT}
        totals["casualLeave"] = round(tot["casualLeave"], 2)
        totals["shifts"] = round(tot["shifts"], 2)
        totals["offDayShifts"] = round(tot["offDayShifts"], 2)
        totals["attendancePct"] = round(float(eff_all) * 100.0 / tot["workingDays"], 1) if tot["workingDays"] else None
        rows.append(
            {
                "employeeName": "Strength",
                "_kind": KIND_TOTAL,
                **{day_key(d): (strength.get(day_key(d), 0) if d <= today else None) for d in days},
            }
        )

    settings = data.settings
    notes = [
        "Codes: P present; P¾ present with 0.25 shift deducted (a quarter-shift arrival or a Penalty Early Out; P½ when "
        "both); ½M / ½E half day, morning / evening worked; A absent; L leave; CL paid casual leave (CL½ a half-day CL, "
        "the other half by the punches); OD on-duty (an approved on-duty punch); CO compensation off; H holiday; WO "
        "weekly off (Sunday or a Saturday-off Saturday). '-' = no record yet, a future day, or outside the joining / "
        "leaving dates.",
        "Each cell is the attendance engine's stored verdict (the record payroll reads). Shifts paid = what staff payroll "
        "pays as days for these dates (the Gained Salary Report's paid days): the stored shifts earned on payroll working "
        "days (WD: Sundays, Saturday-off Saturdays and holidays excluded; a P¾ day 0.75, a half day 0.5, a day HR marked "
        "as a holiday 1) plus 1 for every declared holiday on a company day while employed. Sun/H work = the shifts "
        "stored for work on a Sunday, a Saturday off or a holiday: staff payroll does not pay them as days (a holiday-work "
        "credit is in Compensation). Eff. % = shifts earned on working days / working days so far, so a P¾ day counts "
        "0.75, not a full day.",
        "P counts every present day (P¾ and OD included) except full-day casual leave, which is in CL; a half-day CL adds "
        "0.5 to CL and its day stays in P or ½ as the punches decided. OD and the Qtr / PEO deduction days are part of "
        "P / ½. Late counts the days the engine flagged late (the late-pool marks).",
        arrival_note(settings),
        "Days before the joining date or after an approved last working day are blank and not counted.",
    ]
    notes += detection_notes(settings, early=False)
    if n := unprocessed_note(missing):
        notes.append(n)
    data_rows = [r for r in rows if not r.get("_kind")]
    summary = [
        {"label": "Employees", "value": len(data_rows), "format": "integer"},
        {"label": "Present days", "value": int(tot["present"]), "format": "integer"},
        {"label": "Absent days", "value": int(tot["absent"]), "format": "integer"},
        {"label": "Shifts paid", "value": round(tot["shifts"], 2), "format": "number"},
        {"label": "Eff. %", "value": totals["attendancePct"] if totals else None, "format": "percent"},
        {"label": "Quarter / penalty days", "value": deducted_days, "format": "integer"},
    ]
    return ReportResult(rows=rows, columns=columns, totals=totals, summary=summary, notes=notes)


register(
    ReportSpec(
        id=GRID_ID,
        title="Staff Attendance Report",
        description="Staff muster for up to a month: a coloured cell per date (quarter-shift and penalty days shown as "
        "P¾), totals, the shifts payroll pays and Eff. % from the shifts actually earned.",
        category=CATEGORY,
        icon="Grid3x3",
        tags=("muster", "attendance sheet", "staff", "monthly", "quarter shift", "penalty early out", "P A"),
        modules=MODULES,
        filters=(
            date_range(default="thisMonth", label="Dates", max_days=31),
            *staff_scope("active"),
            text("search", "Search", placeholder="Employee code or name"),
        ),
        columns=(),
        run=_run_grid,
        landscape=True,
        pdf_builder=build_grid_pdf,
        xlsx_builder=build_grid_xlsx,
        screen_limit=2_000,
        pdf_max_rows=1_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  3. Staff Time Card Report
# ═════════════════════════════════════════════════════════════════════════════

CARD_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.2),
    ColumnSpec("in1", "In 1", TIME, 0.7),
    ColumnSpec("out1", "Out 1", TIME, 0.7),
    ColumnSpec("in2", "In 2", TIME, 0.7),
    ColumnSpec("out2", "Out 2", TIME, 0.7),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.7),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.9, total="sum"),
    ColumnSpec("arrival", "Arrival", BADGE, 0.9),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early Out (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("quarterDeduction", "Quarter (-)", NUMBER, 0.8, total="sum"),
    ColumnSpec("penaltyDeduction", "Penalty EO (-)", NUMBER, 0.9, total="sum"),
    ColumnSpec("halfDay", "Half Day", BADGE, 0.9),
    ColumnSpec("otMinutes", "OT (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("permissionMinutes", "Permission (min)", MINUTES, 1.0, total="sum"),
    ColumnSpec("status", "Status", BADGE, 1.1),
    ColumnSpec("shiftsEarned", "Shift Credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 2.6),
)
CARD_SUM_KEYS = (
    "workedHours",
    "lateMinutes",
    "earlyOutMinutes",
    "quarterDeduction",
    "penaltyDeduction",
    "otMinutes",
    "permissionMinutes",
    "shiftsEarned",
)
CARD_DAY_OPTIONS = [
    *DAY_STATUS_OPTIONS[:7],
    ("quarter", "Quarter-shift arrival"),
    ("penalty", "Penalty early out"),
    ("second_half", "Second-half arrival"),
    *DAY_STATUS_OPTIONS[7:],
]


def _zone_match(day, key: str) -> bool | None:
    """The timeline keys of the 'Show only' / 'Flag' choices; None for a key the base report decides."""
    rec = day.rec
    if key == "quarter":
        return bool(rec is not None and (rec.arrival_zone or "") == ZONE_QUARTER)
    if key == "penalty":
        return bool(rec is not None and rec.penalty_early_out)
    if key == "second_half":
        return bool(rec is not None and (rec.arrival_zone or "") == ZONE_SECOND_HALF)
    return None


def _early_minutes(day) -> int | None:
    """Minutes left early: the base derivation for an Early-Out day, else the minutes the engine stored for a Penalty
    Early Out day (measured from the same end the penalty was judged against)."""
    if day.early_min is not None:
        return day.early_min
    rec = day.rec
    if rec is not None and rec.penalty_early_out and (rec.early_out_minutes or 0) > 0:
        return int(rec.early_out_minutes)
    return None


def _card_load(ctx, emps, *, leaves: bool = True, permissions: bool = True):
    days = ctx.days_in_range
    if len(days) > LONG_RANGE_DAYS and len(emps) > LONG_RANGE_MAX_EMPLOYEES:
        raise ReportParamError(
            f"For more than {LONG_RANGE_DAYS} days choose at most {LONG_RANGE_MAX_EMPLOYEES} employees "
            "(a month is the widest range for a whole department)",
            "employee",
        )
    emp_days_guard(len(emps), len(days))
    data = RcData(
        ctx, emps, ctx.date_from, ctx.date_to, punches=True, leaves=leaves, permissions=permissions, service=True
    )
    return days, drop_dormant(ctx, emps, data), data


def _run_card(ctx) -> ReportResult:
    emps = rc_employees(ctx, staff_type="staff")
    days, emps, data = _card_load(ctx, emps)
    hide_off = bool(ctx.params.get("hideOffDays"))
    want = ctx.params.get("dayStatus")
    today = ctx.today

    rows: list[dict] = []
    cache_emps: dict[str, dict] = {}
    counts: Counter = Counter()
    for emp in emps:
        if len(rows) > ctx.row_limit:
            break  # over the limit already: the runner cuts it and says so
        shifts_seen: list[str] = []
        emp_rows = 0
        for d in days:
            day = build_day(data, emp, d)
            if hide_off and day.kind in ("holiday", "weekly_off"):
                continue
            if want:
                zoned = _zone_match(day, want)
                if not (zoned if zoned is not None else _matches(day, want)):
                    continue
            if day.shift is not None and day.in_service and day.shift.name not in shifts_seen:
                shifts_seen.append(day.shift.name)
            p = day.punches
            at = [hhmm(x.at) for x in p[:4]] + [None] * max(0, 4 - len(p))
            if not p and day.first_in:  # a manual entry: HR typed the times
                at = [day.first_in, day.last_out, None, None]
            rec = day.rec
            q, pen = quarter_deducted(rec), penalty_deducted(rec)
            base = _remarks(day, data, today)
            rows.append(
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": emp_name(emp),
                    "department": dept_name(emp),
                    "date": d.isoformat(),
                    "day": weekday_text(d),
                    "shift": day.shift.name if day.shift is not None else None,
                    "in1": at[0],
                    "out1": at[1],
                    "in2": at[2],
                    "out2": at[3],
                    "punchCount": len(p) or None,
                    "workedHours": hours(day.worked_min),
                    "arrival": arrival_label(rec),
                    "lateMinutes": day.late_min,
                    "earlyOutMinutes": _early_minutes(day),
                    "quarterDeduction": q,
                    "penaltyDeduction": pen,
                    "halfDay": day.half,
                    "otMinutes": day.ot_min,
                    "permissionMinutes": day.perm_min,
                    "status": day.label,
                    "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                    "remarks": "; ".join([*zone_flags(rec), *([base] if base else [])]) or None,
                }
            )
            emp_rows += 1
            if day.kind in ("present", "half", "absent", "leave"):
                counts[day.kind] += 1
            if rec is not None:
                counts["late"] += bool(rec.is_late)
                counts["deducted"] += q is not None or pen is not None
            counts["unprocessed"] += bool(day.unprocessed)
        if emp_rows:
            cache_emps[emp.employee_code] = {
                "name": emp_name(emp),
                "department": dept_name(emp),
                "designation": emp.designation.title if emp.designation_id else None,
                "type": "Staff",
                "shifts": shifts_seen,
            }

    rows = with_card_subtotals(rows)
    # the printable card (attendance_core_timecard.build_time_card_pdf) reads its header block from here
    ctx._cache["time_card"] = {"employees": cache_emps, "from": ctx.date_from, "to": ctx.date_to}

    settings = data.settings
    notes = [
        "Status, half-day, late, early-out, permission, arrival zone, quarter-shift and Penalty Early Out are the "
        "attendance engine's stored verdict (the record payroll reads). Worked hours, late, early-out and overtime "
        "minutes are derived from the raw punches and the assigned shift; Early Out (min) of a Penalty Early Out day is "
        "the engine's own stored measurement.",
        "In / Out are positional (1st punch = In 1, 2nd = Out 1 ...); double taps within 5 minutes are ignored for "
        "worked hours, and a two-punch day counts the whole span minus the shift's lunch break when it lies inside it.",
        arrival_note(settings),
        f"OT (min) = last punch beyond the shift end, shown from the Settings > Compensation threshold "
        f"({settings.ot_threshold_minutes or 60} min); it is information, not pay.",
    ]
    notes += detection_notes(settings)
    if n := unprocessed_note(counts["unprocessed"]):
        notes.append(n)
    if ctx.date_to >= today >= ctx.date_from:
        notes.append("Today's status is provisional until the shift ends.")
    summary = [
        {"label": "Employees", "value": len(cache_emps), "format": "integer"},
        {"label": "Present days", "value": counts["present"], "format": "integer"},
        {"label": "Half days", "value": counts["half"], "format": "integer"},
        {"label": "Absent days", "value": counts["absent"], "format": "integer"},
        {"label": "Late days", "value": counts["late"], "format": "integer"},
        {"label": "Quarter / penalty days", "value": counts["deducted"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


def with_card_subtotals(rows: list[dict]) -> list[dict]:
    """A total line after each employee's days (the same shape the base Time Card prints)."""
    out: list[dict] = []
    current, acc = None, None
    for r in rows + [None]:
        code = r["employeeCode"] if r is not None else None
        if code != current and acc is not None:
            out.append(
                {
                    "employeeName": f"{current} total",
                    "_kind": KIND_SUBTOTAL,
                    **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in acc.items()},
                }
            )
            acc = None
        if r is None:
            break
        if acc is None:
            current, acc = code, {k: 0 for k in CARD_SUM_KEYS}
        out.append(r)
        for k in CARD_SUM_KEYS:
            v = r.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                acc[k] += v
    return out


register(
    ReportSpec(
        id=CARD_ID,
        title="Staff Time Card Report",
        description="Day-by-day staff time card: in / out, worked hours, late and early-out minutes, arrival zone, "
        "quarter-shift and Penalty Early Out deductions, status and shift credit.",
        category=CATEGORY,
        icon="Clock",
        tags=("timecard", "time card", "staff", "in out", "worked hours", "quarter shift", "penalty early out"),
        modules=MODULES,
        filters=(
            date_range(default="thisMonth", label="Period", max_days=100),
            *staff_scope("active"),
            select("dayStatus", "Show only", CARD_DAY_OPTIONS, placeholder="All days"),
            boolean("hideOffDays", "Leave out holidays and weekly offs", default=False),
        ),
        columns=CARD_COLUMNS,
        run=_run_card,
        landscape=True,
        pdf_builder=build_time_card_pdf,
        screen_limit=10_000,
        pdf_max_rows=6_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  4. Time Card with Shift Count Report (staff or production)
# ═════════════════════════════════════════════════════════════════════════════

SHIFT_COUNT_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.8),
    ColumnSpec("employeeName", "Employee", TEXT, 1.8),
    ColumnSpec("department", "Department", TEXT, 1.2),
    ColumnSpec("employeeType", "Type", TEXT, 1.0),
    ColumnSpec("date", "Date", DATE, 1.25),
    ColumnSpec("day", "Day", TEXT, 0.5),
    ColumnSpec("shift", "Shift", TEXT, 1.6),
    ColumnSpec("firstIn", "In", TIME, 0.6),
    ColumnSpec("lastOut", "Out", TIME, 0.6),
    ColumnSpec("punches", "Punches", TEXT, 2.4),
    ColumnSpec("punchCount", "No.", INTEGER, 0.45),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.7, total="sum"),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.6, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early (min)", MINUTES, 0.6, total="sum"),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("shiftCount", "Shift Count", NUMBER, 0.7, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 2.6),
)


def punch_list(day) -> str | None:
    """Every punch of the day (or production shift day) in order; one made on the next date is marked (+1)."""
    return ", ".join(hhmm(p.at) + (" (+1)" if p.on > day.date else "") for p in day.punches) or None


def _remarks_without_punches(day, data, today) -> list[str]:
    text_ = _remarks(day, data, today) or ""
    return [part for part in text_.split("; ") if part and not part.startswith("Punches: ")]


def _run_shift_count(ctx) -> ReportResult:
    staff_type = ctx.params.get("staffType") or "staff"
    emps = rc_employees(ctx, staff_type=staff_type)
    days, emps, data = _card_load(ctx, emps)
    hide_off = bool(ctx.params.get("hideOffDays"))
    today = ctx.today

    rows: list[dict] = []
    people_n = 0
    c: Counter = Counter()
    total_shifts = total_hours = 0.0
    for emp in emps:
        if len(rows) > ctx.row_limit:
            break
        is_prod = emp.employment_type == "production"
        mine: list[dict] = []
        worked = 0
        for d in days:
            day = build_day(data, emp, d)
            if hide_off and day.kind in ("holiday", "weekly_off"):
                continue
            rec = day.rec
            remarks: list[str] = []
            if off_quarter_grid(emp, rec):
                remarks.append(OFF_GRID)
                c["offGrid"] += 1
            if not is_prod:
                remarks += zone_flags(rec)
            remarks += _remarks_without_punches(day, data, today)
            count = float(rec.shifts_earned) if rec is not None else None
            mine.append(
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": emp_name(emp),
                    "department": dept_name(emp),
                    "employeeType": type_text(emp),
                    "date": d.isoformat(),
                    "day": weekday_text(d),
                    "shift": shift_text(data, emp, day),
                    "firstIn": day.first_in,
                    "lastOut": day.last_out,
                    "punches": punch_list(day),
                    "punchCount": len(day.punches) or None,
                    "workedHours": hours(day.worked_min),
                    "lateMinutes": day.late_min,
                    "earlyOutMinutes": day.early_min if is_prod else _early_minutes(day),
                    "status": day.label,
                    "shiftCount": count,
                    "remarks": "; ".join(remarks) or None,
                }
            )
            worked += day.kind in ("present", "half")
            if day.kind in ("present", "half", "absent"):
                c[day.kind] += 1
            c["late"] += bool(rec is not None and rec.is_late)
            c["unprocessed"] += bool(day.unprocessed)
        if not mine:
            continue
        people_n += 1
        emp_shifts = round(sum(r["shiftCount"] or 0 for r in mine), 2)
        emp_hours = round(sum(r["workedHours"] or 0 for r in mine), 2)
        total_shifts += emp_shifts
        total_hours += emp_hours
        rows += mine
        rows.append(
            {
                "employeeName": f"{emp_name(emp)} ({emp.employee_code}) total",
                "punches": f"{worked} day{'s' if worked != 1 else ''} worked",
                "workedHours": emp_hours,
                "lateMinutes": sum(r["lateMinutes"] or 0 for r in mine),
                "earlyOutMinutes": sum(r["earlyOutMinutes"] or 0 for r in mine),
                "shiftCount": emp_shifts,
                "_kind": KIND_SUBTOTAL,
            }
        )

    settings = data.settings
    notes = [
        "Shift Count is the day's stored shifts earned (the attendance engine's verdict, the record payroll reads). Staff: "
        "1.00 for a full day, 0.50 for a half day, less a quarter-shift or Penalty Early Out deduction (0.75); a calendar "
        "day. Staff payroll pays the count of its working days only (work on a Sunday, a Saturday off or a holiday is "
        "not a paid day; declared holidays are paid on top: see the Staff Attendance Report's Shifts paid). "
        "Production: the shifts earned per SHIFT day from the shift table (a long day earns more than 1.00, in quarters); "
        "from the date the shift-table rules start, a night worker's closing punch made the next morning belongs to the "
        "day the shift began and is marked (+1), and the 06:00 early-arrival rule keeps a next-morning arrival on its "
        "own day.",
        "Shift = the staff shift in force that day, or the production group the day was judged by (Day / Night / Sunday "
        "or a special shift; 'Legacy rules' before the shift table started, 'Manual entry' for a day HR entered).",
        "Worked hours pair the punches In -> Out (double taps within 5 minutes ignored); late / early minutes are measured "
        "from the staff shift, or from the production group's start and standard out with the rules' grace.",
        "A total line follows each employee's days.",
    ]
    if staff_type != "production":
        notes.append(arrival_note(settings))
    if c["offGrid"]:
        notes.append(
            f"{c['offGrid']} production day(s) were stored before the quarter rule (shift count not on the 0.25 grid) and "
            "are marked Out of date: the stored value is shown, payroll recomputes it when it pays."
        )
    notes += detection_notes(settings)
    if n := unprocessed_note(c["unprocessed"]):
        notes.append(n)
    summary = [
        {"label": "Employees", "value": people_n, "format": "integer"},
        {"label": "Days worked", "value": c["present"] + c["half"], "format": "integer"},
        {"label": "Absent days", "value": c["absent"], "format": "integer"},
        {"label": "Late days", "value": c["late"], "format": "integer"},
        {"label": "Total shift count", "value": round(total_shifts, 2), "format": "number"},
        {"label": "Worked hours", "value": round(total_hours, 2), "format": "hours"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=SHIFT_COUNT_ID,
        title="Time Card with Shift Count Report",
        description="Day-wise time card for staff or production with every punch and the day's shift count (production "
        "by shift day), and a total line per employee.",
        category=CATEGORY,
        icon="Timer",
        tags=("time card", "shift count", "shifts earned", "production", "staff", "night shift", "punches"),
        modules=MODULES,
        filters=(
            date_range(default="thisMonth", label="Period", max_days=100),
            branches(),
            departments(),
            designations(),
            type_choice("staff"),
            employees(),
            employee_status("active"),
            boolean("hideOffDays", "Leave out holidays and weekly offs", default=False),
        ),
        columns=SHIFT_COUNT_COLUMNS,
        run=_run_shift_count,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  10. Late Detection Report
# ═════════════════════════════════════════════════════════════════════════════

LATE_COLUMNS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.3),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("shiftStart", "Eff. start", TIME, 0.8),
    ColumnSpec("firstPunch", "First punch", TIME, 0.8),
    ColumnSpec("arrival", "Arrival", BADGE, 0.9),
    ColumnSpec("lateMinutes", "Late by (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("beyondGrace", "After grace (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("permission", "Permission", BADGE, 1.05),
    ColumnSpec("shiftsEarned", "Shift Credit", NUMBER, 0.7, total="sum"),
    ColumnSpec("quarterDeduction", "Qtr (-)", NUMBER, 0.7, total="sum"),
    ColumnSpec("poolStatus", "Late pool", BADGE, 1.4),
    ColumnSpec("status", "Day status", BADGE, 1.0),
    ColumnSpec("reason", "Engine reason", TEXT, 3.2),
)
NOT_A_LATE_MARK = {
    ZONE_QUARTER: "Not a late mark (quarter shift)",
    ZONE_SECOND_HALF: "Not a late mark (second half)",
    ZONE_EXCUSED: "Excused by permission",
}
ALL_ZONES = (ZONE_LATE, ZONE_EXCUSED, ZONE_QUARTER, ZONE_SECOND_HALF)


def _run_late(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    settings = payroll_settings()
    pcfg = production_config()
    roster = Roster(ctx, d_from, d_to)
    staff_type = ctx.params.get("staffType") or "staff"
    people_by_id = people(ctx)
    if staff_type in ("staff", "production"):
        people_by_id = {k: e for k, e in people_by_id.items() if e.employment_type == staff_type}

    wanted = set(ctx.params.get("arrival") or ()) or set(ALL_ZONES)
    cond = Q(is_late=True) if ZONE_LATE in wanted else Q()
    others = sorted(wanted - {ZONE_LATE})
    if others:
        cond |= Q(arrival_zone__in=others)
    qs = day_records(ctx, d_from, d_to).filter(cond)
    if staff_type in ("staff", "production"):
        qs = qs.filter(employee__employment_type=staff_type)
    min_late = int(ctx.params.get("minLate") or 0)
    qs = qs.order_by("date", "id")
    if not min_late:
        qs = qs[: ctx.row_limit]
    records = [r for r in qs if r.employee_id in people_by_id]

    built = []
    windowed = 0
    for rec in records:
        emp = people_by_id[rec.employee_id]
        zone = zone_of(rec)
        shift_name, start, grace = _morning_basis(emp, rec, roster, pcfg)
        window = _window_late(emp, rec)
        allowance = 0 if emp.employment_type == "production" else allowance_minutes(rec)
        if zone == ZONE_EXCUSED:
            # the permission excused it: measured against the shift's own start, which it would have been late for
            late = (
                None
                if window
                else morning_lateness(rec.first_punch, start, grace, False, start_shift_minutes=allowance)
            )
        else:
            late = _lateness(emp, rec, start, grace, pcfg)
        late_min = late[2] if late else None
        if min_late and (late_min is None or late_min < min_late):
            continue
        if rec.is_late:
            pool = _pool_status(
                rec, emp, roster, rec.morning_permission_excess, bool(settings.permission_pricing_enabled)
            )
        else:
            pool = NOT_A_LATE_MARK.get(zone, "Not a late mark")
        windowed += window
        if window:
            shown_start = None
        elif late:
            shown_start = secs_hm(late[0])
        else:
            shown_start = secs_hm(_t2s(start) + 60 * allowance) if start else None
        row = {
            **emp_cells(emp),
            "date": rec.date.isoformat(),
            "shift": shift_name or "No shift assigned",
            "shiftStart": shown_start,
            "firstPunch": hm(rec.first_punch),
            "arrival": arrival_label(rec),
            "lateMinutes": late_min,
            "beyondGrace": late[3] if late else None,
            "permission": _permission_badge(rec.morning_permission_applied, rec.morning_permission_excess),
            "shiftsEarned": float(rec.shifts_earned or 0),
            "quarterDeduction": quarter_deducted(rec),
            "poolStatus": pool,
            "status": STATUS_LABELS.get(rec.status, rec.status),
            "reason": rec.late_reason,
            "_zone": zone,
        }
        built.append((emp_sort_key(emp), rec.date, row))
    built.sort(key=lambda t: (t[0], t[1]))
    rows = [t[2] for t in built]

    by_zone = Counter(r["_zone"] for r in rows)
    minutes = [r["lateMinutes"] for r in rows if r["lateMinutes"] is not None and r["_zone"] == ZONE_LATE]
    deducted = round(sum(r["quarterDeduction"] or 0 for r in rows), 2)
    summary = [
        {"label": "Late arrivals", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {
            "label": "Counted in late pool",
            "value": sum(1 for r in rows if r["poolStatus"] == "Counted"),
            "format": "integer",
        },
        {"label": "Quarter-shift days", "value": by_zone[ZONE_QUARTER], "format": "integer"},
        {"label": "Second-half arrivals", "value": by_zone[ZONE_SECOND_HALF], "format": "integer"},
        {"label": "Shifts deducted (quarter)", "value": deducted, "format": "number"},
    ]
    rows, sub_note = subtotals_within_limit(
        ctx, rows, lambda r: r["department"], ["lateMinutes", "beyondGrace", "shiftsEarned", "quarterDeduction"]
    )

    notes = [
        "Every late arrival of the period: the days the engine flagged Late-In (late-pool marks) and, from the arrival "
        "timeline, the quarter-shift, second-half and permission-excused arrivals, which are not late marks and so were "
        "missing from the older late list. Arrival, Shift Credit and the quarter deduction are the engine's stored "
        "verdict; the minutes are re-derived from the stored first punch and the shift in force that day.",
        arrival_note(settings),
        "Late by = first punch minus the effective start (an approved in-cap Morning Late-In permission moves it by 60 "
        "minutes, a next-day OT allowance by its minutes; an Excused row is measured from the shift's own start). After "
        "grace = first punch minus (effective start + grace). A production day on or after the date the shift-table "
        "rules start is measured from its group's start with the rules' grace.",
        "Late pool: Counted = one occurrence of the payroll late pool (Settings late slabs); quarter-shift and "
        "second-half arrivals are charged through the shifts earned instead and are never also a late mark.",
    ]
    if average := (round(sum(minutes) / len(minutes), 1) if minutes else None):
        notes.append(f"Average late by of the Late arrivals: {average} min over {len(minutes)} measured day(s).")
    if windowed:
        notes.append(
            f"{windowed} row(s) are days with a company-announced late-in time: the engine judged them against that "
            "announced time, which the day record does not keep, so their start and minutes are left blank."
        )
    if by_zone[ZONE_EXCUSED]:
        notes.append(f"{by_zone[ZONE_EXCUSED]} arrival(s) were excused by an approved Morning Late-In permission.")
    if not settings.morning_late_in_enabled:
        notes.append(
            "Morning Late-In detection is switched off in Settings: days computed while it is off carry no late flag."
        )
    if sub_note:
        notes.append(sub_note)
    missing = coverage_missing(ctx, list(people_by_id.values()), d_from, d_to)
    if missing:
        notes.append(
            f"Data freshness: {missing:,} employee-day(s) in this period have no stored attendance record yet and are not "
            "counted here."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=LATE_ID,
        title="Late Detection Report",
        description="Every late arrival with its arrival zone (Late, Excused, Quarter, Second half), minutes late, "
        "permission effect, late-pool status and the shift credit left.",
        category=CATEGORY,
        icon="Hourglass",
        tags=("late", "late in", "late detection", "quarter shift", "second half", "arrival", "punctuality"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=92),
            branches(),
            departments(),
            designations(),
            type_choice("staff"),
            employees(),
            select("arrival", "Arrival", ARRIVAL_OPTIONS, multi=True, placeholder="All late arrivals"),
            select("minLate", "Minimum late by", MIN_LATE),
        ),
        columns=LATE_COLUMNS,
        run=_run_late,
        landscape=True,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  11. Monthly Misspunch Records
# ═════════════════════════════════════════════════════════════════════════════

MISSPUNCH_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("employeeType", "Type", TEXT, 1.0),
    ColumnSpec("date", "Date", DATE, 1.3),
    ColumnSpec("day", "Day", TEXT, 0.5),
    ColumnSpec("shift", "Shift", TEXT, 1.5),
    ColumnSpec("punchCount", "No.", INTEGER, 0.45),
    ColumnSpec("punches", "Punch times", TEXT, 2.0),
    ColumnSpec("issue", "Issue", BADGE, 1.1),
    ColumnSpec("requestStatus", "Request", BADGE, 1.0),
    ColumnSpec("requested", "Requested punch", TEXT, 2.0),
    ColumnSpec("status", "Day status", BADGE, 0.9),
    ColumnSpec("shiftsEarned", "Shift credit now", NUMBER, 0.8, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 2.0),
)
SHOW_OPTIONS = [
    ("open", "Punches still incomplete"),
    ("no_request", "Incomplete, no request raised"),
    ("pending", "Request pending"),
    ("fixed", "Fixed by an approved request"),
]
REQUEST_LABELS = {
    MissingPunchRequest.STATUS_APPROVED: "Approved",
    MissingPunchRequest.STATUS_PENDING_HR: "Pending (HR)",
    MissingPunchRequest.STATUS_PENDING_HOD: "Pending (HOD)",
    MissingPunchRequest.STATUS_REJECTED: "Rejected",
}
_REQUEST_ORDER = (
    MissingPunchRequest.STATUS_APPROVED,
    MissingPunchRequest.STATUS_PENDING_HR,
    MissingPunchRequest.STATUS_PENDING_HOD,
    MissingPunchRequest.STATUS_REJECTED,
)
_SLOT_LABELS = dict(MissingPunchRequest.PUNCH_SLOT_CHOICES)
NO_REQUEST = "None"


def request_state(reqs: list) -> str | None:
    """The most advanced status among the day's requests (approved > pending HR > pending HOD > rejected)."""
    have = {r.status for r in reqs}
    return next((s for s in _REQUEST_ORDER if s in have), None)


def _requested_text(reqs: list) -> str | None:
    parts = []
    for r in reqs:
        slot = _SLOT_LABELS.get(r.punch_slot or "", "")
        label = REQUEST_LABELS.get(r.status, r.status)
        parts.append(f"{hhmm(r.punch_time)}{' ' + slot if slot else ''} - {label}")
    return "; ".join(parts) or None


def _run_misspunch(ctx) -> ReportResult:
    year, month = ctx.period
    m_start, m_end = month_bounds(year, month)
    today = ctx.today
    last = min(m_end, today)
    staff_type = ctx.params.get("staffType") or "all"
    show = ctx.params.get("show")
    emps = rc_employees(ctx, staff_type=staff_type)
    notes = [
        f"Month: {month_label(year, month)}. One row per employee-day whose punches are incomplete now (a single punch, "
        "or an odd number once double taps within 5 minutes are dropped), plus every day a Missing Punch request was "
        "raised for. Staff are read by calendar day (an exit after midnight belongs to the day it closes); production by "
        "SHIFT day (from the date the shift-table rules start, a night worker's closing punch next morning belongs to the "
        "day the shift began), so a night shift is not a misspunch.",
        "Request = the Missing Punch request for that date (Approved > Pending HR > Pending HOD > Rejected when there are "
        "several). An approved request adds its punch to the day like any other punch. Day status and Shift credit now "
        "are the stored verdict (what payroll pays today). Today is left out of the single / odd checks (the shift may "
        "still be running). A holiday or weekly off is listed too when incomplete punches were made on it.",
    ]
    if last < m_start:
        notes.append("This month has not started yet.")
        return ReportResult(rows=[], notes=notes, summary=[])
    days = [m_start + timedelta(days=i) for i in range((last - m_start).days + 1)]
    emp_days_guard(len(emps), len(days))
    data = RcData(ctx, emps, m_start, last, punches=True, service=True)
    emps = drop_dormant(ctx, emps, data)
    mprs = missing_punch_requests([e.id for e in emps], m_start, m_end)

    rows: list[dict] = []
    c: Counter = Counter()
    people_seen: set[int] = set()
    for emp in emps:
        if len(rows) > ctx.row_limit:
            break
        for d in days:
            day = build_day(data, emp, d)
            if not day.in_service:
                continue
            issues = [k for k in day.issues if k in (EXC_SINGLE, EXC_ODD)]
            reqs = mprs.get((emp.id, d), [])
            if not issues and not reqs:
                continue
            state = request_state(reqs)
            approved = state == MissingPunchRequest.STATUS_APPROVED
            if show == "open" and not issues:
                continue
            if show == "no_request" and (not issues or reqs):
                continue
            if show == "pending" and state not in (
                MissingPunchRequest.STATUS_PENDING_HOD,
                MissingPunchRequest.STATUS_PENDING_HR,
            ):
                continue
            if show == "fixed" and (issues or not approved):
                continue
            rec = day.rec
            if issues:
                issue = EXCEPTION_LABELS[issues[0]]
            else:
                issue = "Fixed by request" if approved else "Punches complete"
            remarks = [f for f in day.flags if f in (STALE_PUNCHES, STALE_LEAVE) or f.startswith("Exit after")]
            if off_quarter_grid(emp, rec):
                remarks.append(OFF_GRID)
            rows.append(
                {
                    "employeeCode": emp.employee_code,
                    "employeeName": emp_name(emp),
                    "department": dept_name(emp),
                    "employeeType": type_text(emp),
                    "date": d.isoformat(),
                    "day": weekday_text(d),
                    "shift": shift_text(data, emp, day),
                    "punchCount": len(day.punches) or None,
                    "punches": punch_list(day),
                    "issue": issue,
                    "requestStatus": REQUEST_LABELS.get(state, NO_REQUEST) if state else NO_REQUEST,
                    "requested": _requested_text(reqs),
                    "status": day.label,
                    "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                    "remarks": "; ".join(remarks) or None,
                }
            )
            people_seen.add(emp.id)
            c[issues[0] if issues else "none"] += 1
            if issues and not reqs:
                c["unrequested"] += 1
            if not issues and approved:
                c["fixed"] += 1

    summary = [
        {"label": "Days listed", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len(people_seen), "format": "integer"},
        {"label": "Single punch days", "value": c[EXC_SINGLE], "format": "integer"},
        {"label": "Odd punch days", "value": c[EXC_ODD], "format": "integer"},
        {"label": "Incomplete, no request", "value": c["unrequested"], "format": "integer"},
        {"label": "Fixed by approved request", "value": c["fixed"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=MISSPUNCH_ID,
        title="Monthly Misspunch Records",
        description="Every day of a month with a single or odd punch (staff by calendar day, production by shift day) "
        "or a Missing Punch request: punches seen, request status, day status now.",
        category=CATEGORY,
        icon="Fingerprint",
        tags=("missing punch", "misspunch", "single punch", "odd punches", "request", "monthly"),
        modules=MODULES,
        filters=(
            period(default="thisMonth", label="Month"),
            branches(),
            departments(),
            designations(),
            type_choice("all"),
            employees(),
            select("show", "Show", SHOW_OPTIONS, placeholder="All days"),
        ),
        columns=MISSPUNCH_COLUMNS,
        run=_run_misspunch,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  15. Attendance Log Report (staff day log)
# ═════════════════════════════════════════════════════════════════════════════

LOG_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.3),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("designation", "Designation", TEXT, 1.2),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("firstIn", "First In", TIME, 0.7),
    ColumnSpec("lastOut", "Last Out", TIME, 0.7),
    ColumnSpec("punches", "All punches", TEXT, 2.0),
    ColumnSpec("punchCount", "No.", INTEGER, 0.45),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.8, total="sum"),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("arrival", "Arrival", BADGE, 0.9),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.7, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early Out (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("flags", "Flags", TEXT, 2.4),
    ColumnSpec("shiftsEarned", "Shift Credit", NUMBER, 0.7, total="sum"),
    ColumnSpec("source", "Source", TEXT, 0.9),
)
LOG_FLAG_OPTIONS = [
    ("late", "Late"),
    ("quarter", "Quarter-shift arrival"),
    ("penalty", "Penalty early out"),
    ("second_half", "Second-half arrival"),
    ("early_out", "Early out"),
    ("half_day", "Half day"),
    ("permission", "Permission"),
    ("missing_punch", "Missing / odd punch"),
    ("manual", "Manual / HR override"),
]


def _run_log(ctx) -> ReportResult:
    days = ctx.days_in_range
    emps = rc_employees(ctx, staff_type="staff")
    emp_days_guard(len(emps), len(days))
    data = RcData(ctx, emps, ctx.date_from, ctx.date_to, punches=True, leaves=True, service=True)
    emps = drop_dormant(ctx, emps, data)
    want_status = ctx.params.get("status")
    want_flag = ctx.params.get("flag")
    today = ctx.today

    rows: list[dict] = []
    c: Counter = Counter()
    for d in days:
        for emp in emps:
            day = build_day(data, emp, d)
            if not day.in_service:
                continue
            if want_status and not _status_match(day, want_status):
                continue
            if want_flag:
                zoned = _zone_match(day, want_flag)
                if not (zoned if zoned is not None else _flag_match(day, want_flag)):
                    continue
            rec = day.rec
            rows.append(
                {
                    "date": d.isoformat(),
                    "employeeCode": emp.employee_code,
                    "employeeName": emp_name(emp),
                    "department": dept_name(emp),
                    "designation": emp.designation.title if emp.designation_id else None,
                    "shift": day.shift.name if day.shift is not None else None,
                    "firstIn": day.first_in,
                    "lastOut": day.last_out,
                    "punches": punch_list(day),
                    "punchCount": len(day.punches) or None,
                    "workedHours": hours(day.worked_min),
                    "status": day.label,
                    "arrival": arrival_label(rec),
                    "lateMinutes": day.late_min,
                    "earlyOutMinutes": _early_minutes(day),
                    "flags": "; ".join([*day.flags, *zone_flags(rec)]) or None,
                    "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                    "source": source_text(day),
                }
            )
            if day.kind in ("present", "half", "absent"):
                c[day.kind] += 1
            if rec is not None:
                c["late"] += bool(rec.is_late)
                c["deducted"] += quarter_deducted(rec) is not None or bool(rec.penalty_early_out)
            c["unprocessed"] += bool(day.unprocessed)
            if len(rows) > ctx.row_limit:
                break
        if len(rows) > ctx.row_limit:
            break

    settings = data.settings
    notes = [
        "One row per staff employee per day. Status, flags, arrival zone and shift credit are the attendance engine's "
        "stored verdict (the record payroll reads); first in / last out, all punches, worked hours and the late / early "
        "minutes come from the raw punches (an exit after midnight belongs to the day it closes and is marked (+1)).",
        arrival_note(settings),
        "Days before the joining date or after an approved last working day are not listed.",
    ]
    notes += detection_notes(settings)
    if any(d == today for d in days):
        notes.append("Today's status is provisional until the shift ends.")
    if n := unprocessed_note(c["unprocessed"]):
        notes.append(n)
    summary = [
        {"label": "Employee-days", "value": len(rows), "format": "integer"},
        {"label": "Present", "value": c["present"], "format": "integer"},
        {"label": "Half day", "value": c["half"], "format": "integer"},
        {"label": "Absent", "value": c["absent"], "format": "integer"},
        {"label": "Late", "value": c["late"], "format": "integer"},
        {"label": "Quarter / penalty days", "value": c["deducted"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=LOG_ID,
        title="Attendance Log Report",
        description="Staff day log: one row per employee-day with first in, last out, every punch, hours, status, "
        "arrival zone, late / early / quarter / penalty flags and shift.",
        category=CATEGORY,
        icon="ClipboardList",
        tags=("attendance log", "daily", "staff", "punches", "first in", "last out", "quarter shift", "penalty"),
        modules=MODULES,
        filters=(
            date_range(default="thisMonth", label="Dates", max_days=31),
            *staff_scope("active"),
            select("status", "Status", LOG_STATUS_OPTIONS, placeholder="All statuses"),
            select("flag", "Flag", LOG_FLAG_OPTIONS, placeholder="Any"),
        ),
        columns=LOG_COLUMNS,
        run=_run_log,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)
