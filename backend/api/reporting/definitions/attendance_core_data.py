"""Shared loaders and day-level helpers of the attendance_core report definitions (registers no report).

Design rules every attendance_core report follows (see also reporting/README.md):

* The engine's verdict -- ``AttendanceDayRecord`` -- is the only source of a day's status, half-day,
  late and permission flags. Nothing here re-derives them from punches, so a report always agrees
  with payroll and with the Attendance screens.
* A GET must never write. ``attendance_final.compute_day_record`` persists, so it is never called;
  a day nobody has opened yet has no record and is shown blank ("not processed") and counted.
* Facts the engine does not store (worked hours, late / early / overtime minutes, which punch is
  IN or OUT) are derived here from the raw punches and the assigned shift, read-only, using the
  engine's own helpers (``resolve_day_punch_logs`` for cross-midnight exits, ``_get_shift_for_date``,
  ``_t2s_minute`` ...). IN / OUT is always positional (even index = IN); the stored ``punch_type``
  is unreliable.
* A stored verdict is only as fresh as the last time somebody opened the day in Attendance. When punches changed, or a
  leave was approved, after it was stored, the day keeps its stored status but carries an "Out of date" flag
  (build_day) -- and the absentee list treats a leave approved after the fact as leave, not absence.
* Everything is loaded once per run (constant query count) -- no per-employee or per-day queries.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import NamedTuple

from django.db.models import F, Q

from api.attendance_final import half_period
from api.models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    LeaveRequest,
    PayrollSettings,
    ProductionShiftConfig,
    ResignationRequest,
)
from api.shift_engine import (
    _get_assignment_for_date,
    _get_shift_for_date,
    _t2s,
    _t2s_minute,
    resolve_day_punch_logs,
)

from ..filters import ReportParamError, scope, select, text
from ..formatting import parse_date

# A guard for the 30 s worker timeout: employees x days the loaders will materialise in one request.
MAX_EMPLOYEE_DAYS = 60_000
# A second tap on the biometric within this many seconds of the previous punch is a double tap
# (the same 5-minute rule the WhatsApp alerts use in whatsapp_alerts.collapse_taps).
TAP_GAP_S = 300
DAY_S = 86400

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# Display words. They double as the words the report UI colours as badges.
L_PRESENT = "Present"
L_HALF = "Half Day"
L_ABSENT = "Absent"
L_LEAVE = "Leave"
L_HOLIDAY = "Holiday"
L_WEEKLY_OFF = "Weekly Off"
L_CASUAL = "Casual Leave"
L_COMP = "Comp Off"

# Flags a day carries when its stored verdict no longer matches the facts around it (see build_day).
STALE_PUNCHES = "Out of date: punches changed after this day was stored - open it in Attendance to recompute"
STALE_LEAVE = "Out of date: leave approved after this day was stored - open it in Attendance to recompute"

KIND_LABELS = {
    "present": L_PRESENT,
    "half": L_HALF,
    "absent": L_ABSENT,
    "leave": L_LEAVE,
    "holiday": L_HOLIDAY,
    "weekly_off": L_WEEKLY_OFF,
}

# Exceptions a day can carry (punch-exceptions, and the "exceptions" filters of the registers).
EXC_SINGLE = "single_punch"
EXC_ODD = "odd_punches"
EXC_MANY = "many_punches"
EXC_DUPLICATE = "duplicate_taps"
EXC_NO_PUNCHES = "present_no_punches"
EXC_ON_LEAVE = "punch_on_leave"
EXC_ON_HOLIDAY = "punch_on_holiday"
EXCEPTION_LABELS = {
    EXC_SINGLE: "Single punch",
    EXC_ODD: "Odd punches",
    EXC_MANY: "Many punches",
    EXC_DUPLICATE: "Duplicate taps",
    EXC_NO_PUNCHES: "Present without punches",
    EXC_ON_LEAVE: "Punch on leave",
    EXC_ON_HOLIDAY: "Punch on holiday",
}


class Punch(NamedTuple):
    """One raw AttendanceLog row, as light as a tuple (a month of punches for a roster is tens of thousands)."""

    employee_id: int
    date: dt.date
    punch_time: dt.time
    source: str


class DayPunch(NamedTuple):
    """A punch placed on its working day: ``secs`` counts from that day's midnight, so a 01:05 exit that
    the engine re-attributed to the previous day is 25:05 (90300), never a negative duration."""

    secs: int
    at: dt.time
    on: dt.date
    source: str


# ── filters ─────────────────────────────────────────────────────────────────────


def staff_type_filter(default: str = "staff"):
    """Employee-type choice whose default is applied by the server as well as pre-filled by the form
    (the shared ``employmentType`` filter has no server-side default). Reports that mirror the legacy
    staff-only Report Log pages default to Staff; the user can still pick Production or All."""
    return select(
        "staffType",
        "Employee type",
        [("staff", "Staff"), ("production", "Production"), ("all", "All employees")],
        default=default,
        placeholder="Staff",
        help="Production employees are judged on shift credit (0.25 steps), staff on the two-half rule.",
    )


def search_filter():
    return text("search", "Search", placeholder="Employee code or name")


def scope_filters(*, status: str | None = "all", staff_default: str | None = None, search: bool = False):
    """Employee-scope filters. ``staff_default`` swaps the shared employee-type filter for one that has a
    real server-side default (see staff_type_filter)."""
    if staff_default is None:
        out = list(scope(status=status))
    else:
        out = list(scope(status=status, employment=False))
        out.insert(min(3, len(out)), staff_type_filter(staff_default))
    if search:
        out.append(search_filter())
    return tuple(out)


# ── employees ───────────────────────────────────────────────────────────────────


def scoped_employees(ctx, *, order: str = "dept", search: str | None = None, limit: int | None = None) -> list:
    """The employees a report covers: the report's own scope filters + branch isolation (ctx.emp_q),
    plus the optional ``staffType`` choice and ``search`` text. ``order``: "dept" = department name
    (unassigned last) then first name -- the Report Log's daily order; "dept_code" = department then
    code; "first_name" = the Report Log's monthly order; "code"."""
    qs = Employee.objects.select_related("department", "designation", "branch").filter(ctx.emp_q())
    staff_type = ctx.params.get("staffType")
    if staff_type in ("staff", "production"):
        qs = qs.filter(employment_type=staff_type)
    term = (search if search is not None else ctx.params.get("search") or "").strip()
    if term:
        qs = qs.filter(Q(employee_code__icontains=term) | Q(first_name__icontains=term) | Q(last_name__icontains=term))
    dept = F("department__name").asc(nulls_last=True)
    if order == "first_name":
        qs = qs.order_by("first_name", "last_name", "employee_code")
    elif order == "code":
        qs = qs.order_by("employee_code")
    elif order == "dept_code":
        qs = qs.order_by(dept, "employee_code")
    else:
        qs = qs.order_by(dept, "first_name", "last_name", "employee_code")
    return list(qs[:limit]) if limit else list(qs)


def emp_days_guard(n_employees: int, n_days: int) -> None:
    if n_employees * n_days > MAX_EMPLOYEE_DAYS:
        raise ReportParamError(
            f"{n_employees:,} employees x {n_days} days is too much for one report - narrow the dates or pick "
            "a department / employees and try again",
            "dateRange",
        )


def drop_dormant(ctx, employees: list, data: AttendanceData) -> list:
    """People who have left (inactive) and have no attendance record or punch in the range would only add
    an empty row to a register: omit them. Active employees always stay (an empty row for them is a
    signal). Explicitly chosen employees are never omitted."""
    if ctx.params.get("employee_ids") or ctx.params.get("employee_status") == "active":
        return employees
    return [e for e in employees if e.status == "active" or data.has_activity(e.id)]


# ── punches ─────────────────────────────────────────────────────────────────────


def collapse_taps(secs: list[int]) -> list[int]:
    """Sorted punch seconds with a second tap within TAP_GAP_S of the previous kept punch dropped."""
    kept: list[int] = []
    for s in sorted(secs):
        if not kept or s - kept[-1] >= TAP_GAP_S:
            kept.append(s)
    return kept


def hhmm(t: dt.time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def device_of(source: str | None) -> str | None:
    """The biometric device behind a source tag: 'biometric:<label>' / 'biometric:adms:<SN>' / ..."""
    s = source or ""
    if not s.startswith("biometric"):
        return None
    rest = s[len("biometric") :].lstrip(":")
    if not rest:
        return None
    if rest == "adms":
        return "ADMS"
    if rest.startswith("adms:"):
        return f"ADMS {rest[5:]}"
    return {"essl": "eSSL", "excel-import": "Excel import"}.get(rest, rest)


def worked_minutes(secs: list[int], shift, deduct_lunch: bool = True) -> tuple[int | None, str | None]:
    """(minutes, basis) worked in a day from its punch seconds.

    Double taps are collapsed first. An even number of punches is paired In->Out and summed ("paired").
    A day with exactly two punches is the whole span; when ``deduct_lunch`` and the assigned shift has a
    lunch break, the break is subtracted if the span covers the entire lunch window ("span-lunch").
    A single or odd punch count has no reliable answer: (None, "single" | "odd")."""
    taps = collapse_taps(secs)
    n = len(taps)
    if n == 0:
        return None, None
    if n == 1:
        return None, "single"
    if n % 2:
        return None, "odd"
    total = sum(taps[i + 1] - taps[i] for i in range(0, n, 2)) // 60
    basis = "paired"
    lunch = int(getattr(shift, "lunch_duration_minutes", 0) or 0) if shift is not None else 0
    if n == 2 and deduct_lunch and lunch > 0:
        start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
        window_start = _t2s(shift.first_half_end) if shift.first_half_end else (start_s + end_s) // 2
        if end_s > start_s and taps[0] <= window_start and taps[1] >= window_start + lunch * 60:
            total = max(0, total - lunch)
            basis = "span-lunch"
    return total, basis


def punch_exceptions(secs: list[int], rec, *, is_today: bool, has_leave: bool, is_holiday: bool) -> list[str]:
    """Exception keys (EXC_*) for one working day. ``secs`` are the day's date-aware punch seconds."""
    out: list[str] = []
    n = len(secs)
    taps = collapse_taps(secs)
    if n > len(taps):
        out.append(EXC_DUPLICATE)
    if n >= 6:
        out.append(EXC_MANY)
    if not is_today:  # today an odd count just means the employee is still in the shift
        if len(taps) == 1:
            out.append(EXC_SINGLE)
        elif len(taps) % 2 == 1:
            out.append(EXC_ODD)
    if rec is not None and rec.status in ("present", "half_shift") and rec.source == "auto" and n == 0:
        out.append(EXC_NO_PUNCHES)
    if has_leave and n:
        out.append(EXC_ON_LEAVE)
    if is_holiday and n:
        out.append(EXC_ON_HOLIDAY)
    return out


# ── the loader ──────────────────────────────────────────────────────────────────


class AttendanceData:
    """Everything the day-level attendance reports join, loaded once for ``employees`` x [date_from, date_to].

    Query count is constant in the number of employees and days (records, punches, assignments, holidays and
    at most four more). ``punches`` / ``leaves`` / ``permissions`` / ``service`` switch the optional loads."""

    def __init__(
        self,
        ctx,
        employees: list,
        date_from: dt.date,
        date_to: dt.date,
        *,
        punches: bool = False,
        leaves: bool = False,
        permissions: bool = False,
        service: bool = False,
    ):
        self.today: dt.date = ctx.today
        self.employees = employees
        self.date_from, self.date_to = date_from, date_to
        self.settings = PayrollSettings.get()
        ids = [e.id for e in employees]
        self.has_production = any(e.employment_type == "production" for e in employees)

        self.records: dict[tuple[int, dt.date], AttendanceDayRecord] = {}
        self.logs: dict[int, dict[dt.date, list[Punch]]] = {}
        self.assignments: dict[int, list] = defaultdict(list)
        self.holidays: dict[dt.date, str] = {}
        self.full_leave: dict[tuple[int, dt.date], LeaveRequest] = {}
        self.half_leave: dict[tuple[int, dt.date], str] = {}
        self.casual: set[tuple[int, dt.date]] = set()
        self.permissions: dict[tuple[int, dt.date], list] = defaultdict(list)
        self.exit_date: dict[int, dt.date] = {}
        self._sat: dict[tuple[int, int, int], bool] = {}
        self._day_punches: dict[tuple[int, dt.date], list[DayPunch]] = {}
        self._prod_config = None
        self._rec_emps: set[int] = set()
        self._punch_ids: set[int] = set()  # employees whose raw punches are loaded (all of them, or a few)
        self.service_masking = service
        self.has_punch_data = punches  # False: the punches were not loaded, so the day's own punch count stands in
        if not ids:
            return

        self.records = {
            (r.employee_id, r.date): r
            for r in AttendanceDayRecord.objects.filter(employee_id__in=ids, date__gte=date_from, date__lte=date_to)
        }
        self._rec_emps = {eid for eid, _d in self.records}
        self.holidays = {}
        for d, name in (
            Holiday.objects.filter(date__gte=date_from, date__lte=date_to).order_by("id").values_list("date", "name")
        ):
            self.holidays.setdefault(d, name)

        # The shift in force on the 15th decides Saturday-off (payroll's rule), so cover whole months.
        a_from = date_from.replace(day=1) - dt.timedelta(days=1)
        a_to = (date_to.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
        for a in (
            EmployeeShiftAssignment.objects.filter(employee_id__in=ids, effective_from__lte=a_to)
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=a_from))
            .select_related("shift")
        ):
            self.assignments[a.employee_id].append(a)

        if punches:
            self.load_punches(ids)
        else:
            self._load_saturday_off_punches(employees)

        if leaves:
            self._load_leaves(ids, date_from, date_to)
        if permissions:
            for p in EmployeePermission.objects.filter(
                employee_id__in=ids, date__gte=date_from, date__lte=date_to, status="approved"
            ).order_by("date", "id"):
                self.permissions[(p.employee_id, p.date)].append(p)
        if service:
            for eid, last in (
                ResignationRequest.objects.filter(
                    employee_id__in=ids, status="approved", last_working_date__isnull=False
                )
                .order_by("last_working_date")
                .values_list("employee_id", "last_working_date")
            ):
                self.exit_date[eid] = last

    # -- loading helpers ----------------------------------------------------
    def load_punches(self, ids) -> None:
        """Load the raw punches of these employees for the range (plus a day either side, for cross-midnight exits)
        in ONE query. Loading is additive; an employee is loaded at most once."""
        todo = {i for i in ids if i not in self._punch_ids}
        if not todo:
            return
        raw: dict[int, dict[dt.date, list[Punch]]] = defaultdict(lambda: defaultdict(list))
        for eid, d, t, src in (
            AttendanceLog.objects.filter(
                employee_id__in=todo,
                date__gte=self.date_from - dt.timedelta(days=1),
                date__lte=self.date_to + dt.timedelta(days=1),
            )
            .order_by("employee_id", "date", "punch_time", "id")
            .values_list("employee_id", "date", "punch_time", "source")
        ):
            raw[eid][d].append(Punch(eid, d, t, src or ""))
        for eid, by_date in raw.items():
            self.logs[eid] = dict(by_date)
        self._punch_ids |= todo

    def punches_loaded(self, emp_id: int) -> bool:
        return emp_id in self._punch_ids

    def _load_saturday_off_punches(self, employees: list) -> None:
        """A report that does not read punches still has to tell a Saturday-off Saturday from an absence, and the
        engine's own punch count cannot: it counts a night exit stamped after midnight (really Friday's) as a punch
        of the Saturday. Load the punches of just the staff on a saturday_off schedule with a Saturday stored as
        absent that has a punch on it (rare), so ``kind`` can look at the re-attributed list."""
        by_id = {e.id: e for e in employees}
        need = {
            eid
            for (eid, d), rec in self.records.items()
            if d.weekday() == 5
            and rec.status == "absent"
            and (rec.total_punches or 0) > 0
            and eid in by_id
            and self.saturday_off(by_id[eid], d)
        }
        if need:
            self.load_punches(need)

    def _load_leaves(self, ids: list[int], date_from: dt.date, date_to: dt.date) -> None:
        # start_date / end_date are TEXT columns. "~" sorts after every digit, space and "T", so a value that
        # carries a time suffix still passes the prefilter; the exact overlap is decided on parsed dates.
        for lr in LeaveRequest.objects.filter(
            employee_id__in=ids,
            status="approved",
            start_date__lte=date_to.isoformat() + "~",
            end_date__gte=date_from.isoformat(),
        ).select_related("leave_type_ref"):
            start, end = parse_date(lr.start_date), parse_date(lr.end_date)
            if start is None or end is None:
                continue
            if lr.is_half_day:
                if date_from <= start <= date_to:
                    self.half_leave[(lr.employee_id, start)] = lr.half_day_slot or ""
                continue
            d = max(start, date_from)
            while d <= min(end, date_to):
                self.full_leave.setdefault((lr.employee_id, d), lr)
                d += dt.timedelta(days=1)
        self.casual = set(
            CasualLeaveRequest.objects.filter(
                employee_id__in=ids, status="approved", date__gte=date_from, date__lte=date_to
            ).values_list("employee_id", "date")
        )

    # -- lookups --------------------------------------------------------------
    def record(self, emp_id: int, d: dt.date):
        """The persisted verdict, or None for a day nobody has opened yet -- and always None for a future day
        (a stale row must never show a future day as absent)."""
        if d > self.today:
            return None
        return self.records.get((emp_id, d))

    def shift(self, emp, d: dt.date):
        return _get_shift_for_date(emp, d, assignments=self.assignments.get(emp.id, []))

    def saturday_off(self, emp, d: dt.date) -> bool:
        """Staff only: the assignment in force on the 15th of the month has saturday_off (payroll's rule;
        the attendance engine itself ignores it, so such a Saturday is stored as 'absent')."""
        if emp.employment_type == "production":
            return False
        key = (emp.id, d.year, d.month)
        if key not in self._sat:
            asg = _get_assignment_for_date(
                emp, dt.date(d.year, d.month, 15), assignments=self.assignments.get(emp.id, [])
            )
            self._sat[key] = bool(asg and asg.saturday_off)
        return self._sat[key]

    def prod_config(self):
        """The production punch-1 / punch-4 reference times (ProductionShiftConfig), read once."""
        if self._prod_config is None:
            cfg = ProductionShiftConfig.get()
            # a freshly created singleton keeps its TimeField defaults as text until reloaded
            for name in ("punch1_time", "punch4_time"):
                v = getattr(cfg, name)
                if isinstance(v, str):
                    setattr(cfg, name, dt.datetime.strptime(v[:5], "%H:%M").time())
            self._prod_config = cfg
        return self._prod_config

    def in_service(self, emp, d: dt.date) -> bool:
        """False before the joining date and after the approved last working day (the engine ignores both)."""
        join = parse_date(emp.join_date)
        if join is not None and d < join:
            return False
        last = self.exit_date.get(emp.id)
        return not (last is not None and d > last)

    def leave_approved_late(self, emp, d: dt.date, rec) -> bool:
        """A day stored as absent, with no punch, that a full-day approved leave now covers: the leave was approved
        after the day was stored. The engine gives such a day 'on leave' the next time it is computed (payroll
        computes every day again before it pays), so the stored 'absent' is out of date. Production has no leave."""
        return (
            rec is not None
            and rec.status == "absent"
            and rec.source != "manual"
            and (rec.total_punches or 0) == 0
            and emp.employment_type != "production"
            and (emp.id, d) in self.full_leave
        )

    def has_activity(self, emp_id: int) -> bool:
        """Any attendance record, or any punch stamped inside the range."""
        if emp_id in self._rec_emps:
            return True
        return any(self.date_from <= d <= self.date_to for d in self.logs.get(emp_id, {}))

    def punches(self, emp, d: dt.date) -> list[DayPunch]:
        """The day's punches, chronological and date-aware: cross-midnight exits re-attributed exactly as the
        engine does (resolve_day_punch_logs), so a night exit belongs to the day it closes."""
        key = (emp.id, d)
        got = self._day_punches.get(key)
        if got is not None:
            return got
        by_date = self.logs.get(emp.id, {})
        own = by_date.get(d, [])
        resolved = resolve_day_punch_logs(
            emp, d, own, self.settings, assignments=self.assignments.get(emp.id, []), logs_by_date=by_date
        )
        out = sorted(
            (
                DayPunch(_t2s(p.punch_time) + DAY_S * (p.date - d).days, p.punch_time, p.date, p.source)
                for p in resolved
            ),
            key=lambda p: (p.secs, p.at),
        )
        self._day_punches[key] = out
        return out

    # -- classification -------------------------------------------------------
    def kind(self, emp, d: dt.date, rec, has_punches: bool | None = None) -> str | None:
        """present | half | absent | leave | holiday | weekly_off, None when there is no record.

        Weekly off: a staff 'holiday' verdict with no Holiday row is a Sunday; a staff 'absent' Saturday with no
        valid punch on a saturday_off assignment is also a weekly off (the engine stores it as absent).
        ``has_punches`` defaults to the day's re-attributed punches when this employee's punches were loaded, else to
        the record's own punch count (the engine's, counted before cross-midnight re-attribution: a night exit stamped
        after midnight counts for the Saturday although it closes Friday's shift)."""
        if rec is None:
            return None
        s = rec.status
        if s == "present":
            return "present"
        if s == "half_shift":
            return "half"
        if s == "on_leave":
            return "leave"
        if s == "holiday":
            return "holiday" if d in self.holidays else "weekly_off"
        if d.weekday() == 5 and self.saturday_off(emp, d):
            if has_punches is None:
                if self.punches_loaded(emp.id):
                    has_punches = bool(self.punches(emp, d))
                else:
                    has_punches = (rec.total_punches or 0) > 0
            if not has_punches:
                return "weekly_off"
        return "absent"


def label_for(kind: str | None, rec) -> str | None:
    """Status word: casual-leave and compensation-redemption days are stored as a manual 'present' verdict."""
    if kind is None:
        return None
    if kind == "present" and rec is not None and rec.source == "manual":
        note = rec.override_note or ""
        if note.startswith("Casual Leave (paid)"):
            return L_CASUAL
        if note.startswith("Compensation Alternative Day"):
            return L_COMP
    return KIND_LABELS[kind]


def leave_type_text(lr) -> str | None:
    if lr is None:
        return None
    ref = lr.leave_type_ref
    return (ref.code or ref.name) if ref is not None else ((lr.type or "").strip() or "Leave")


def half_worked(rec, employee, settings) -> str | None:
    """Which half a staff half-day was worked: the day record says so itself (its arrival zone: a first punch inside
    the shift's first-half limit is the morning, a later one the evening; older / manual rows fall back to the retired
    fixed cut-off - see attendance_final.half_period). Production half-shifts are shift credit, not halves. "Half"
    when the record has no first punch."""
    if rec is None or rec.status != "half_shift":
        return None
    if employee.employment_type == "production":
        return "Half"
    period = half_period(rec, settings)
    if period is None:
        return "Half"
    return "Morning" if period == "morning" else "Evening"


def late_minutes(rec, shift, employee, data: AttendanceData) -> int | None:
    """Minutes the first punch is after the (permission-shifted) shift start, for a day the engine flagged late.
    The flag itself (grace, compensation day, half-day leave ...) is the engine's; minutes are not stored anywhere."""
    if rec is None or not rec.is_late or rec.first_punch is None:
        return None
    if employee.employment_type == "production":
        base = _t2s(data.prod_config().punch1_time)
    elif shift is None:
        return None
    else:
        base = _t2s(shift.start_time) + (3600 if rec.morning_permission_applied else 0)
    m = (_t2s_minute(rec.first_punch) - base) // 60
    return m if m > 0 else None


def early_minutes(rec, shift, employee, data: AttendanceData, last_secs: int | None) -> int | None:
    """Minutes the last punch is before the (permission-shifted) shift end, for a day flagged early-out."""
    if rec is None or not rec.early_leave:
        return None
    last = last_secs if last_secs is not None else (_t2s(rec.last_punch) if rec.last_punch else None)
    if last is None:
        return None
    if employee.employment_type == "production":
        end = _t2s(data.prod_config().punch4_time)
    elif shift is None:
        return None
    else:
        end = _t2s(shift.end_time) - (3600 if rec.evening_permission_applied else 0)
    m = (end - last) // 60
    return m if m > 0 else None


def overtime_minutes(rec, shift, employee, punches: list[DayPunch], threshold: int) -> int | None:
    """Staff overtime: minutes of the last punch beyond the shift end, when at least the Settings threshold
    (the overtime engine's rule, but date-aware so a night exit is not lost). None otherwise.

    The engine stores no last punch for a day with a single punch (that one punch may as well be the arrival), so
    it can never detect overtime there: nor does this."""
    if rec is None or employee.employment_type == "production" or shift is None or len(punches) < 2:
        return None
    if rec.status not in ("present", "half_shift"):
        return None
    start_s, end_s = _t2s(shift.start_time), _t2s(shift.end_time)
    if end_s <= start_s:  # overnight shift: the engine does not support it either
        return None
    m = (punches[-1].secs - end_s) // 60
    return m if m >= max(1, threshold) else None


class Day:
    """One employee on one date, with everything the registers print."""

    __slots__ = (
        "emp",
        "date",
        "rec",
        "kind",
        "label",
        "in_service",
        "punches",
        "shift",
        "first_in",
        "last_out",
        "worked_min",
        "basis",
        "late_min",
        "early_min",
        "ot_min",
        "perm_min",
        "perm_types",
        "half",
        "flags",
        "leave",
        "issues",
        "unprocessed",
        "in_progress",
    )


def build_day(data: AttendanceData, emp, d: dt.date, *, deduct_lunch: bool = True) -> Day:
    day = Day()
    day.emp, day.date = emp, d
    day.in_service = data.in_service(emp, d) if data.service_masking else True
    rec = data.record(emp.id, d) if day.in_service else None
    day.rec = rec
    live = day.in_service and d <= data.today
    punches = data.punches(emp, d) if live else []
    day.punches = punches
    shift = data.shift(emp, d)
    day.shift = shift
    day.kind = data.kind(emp, d, rec, bool(punches) if live and data.punches_loaded(emp.id) else None)
    day.label = label_for(day.kind, rec)
    # Today's absent is provisional: the engine judges the day live, so anyone who has not punched yet is absent.
    day.in_progress = day.kind == "absent" and d == data.today and not punches and (rec.total_punches or 0) == 0
    day.unprocessed = live and rec is None
    # Production employees have no leave (the engine ignores approved leave for them), so a leave request
    # on file is neither a status nor a "punch on leave" exception for them.
    day.leave = None if emp.employment_type == "production" else data.full_leave.get((emp.id, d))

    day.first_in = day.last_out = None
    if punches:
        day.first_in = hhmm(punches[0].at)
        day.last_out = hhmm(punches[-1].at) if len(punches) >= 2 else None
    elif rec is not None and rec.source == "manual":
        day.first_in, day.last_out = hhmm(rec.first_punch), hhmm(rec.last_punch)

    day.worked_min, day.basis = (
        worked_minutes([p.secs for p in punches], shift, deduct_lunch) if punches else (None, None)
    )
    last_secs = punches[-1].secs if len(punches) >= 2 else None
    day.late_min = late_minutes(rec, shift, emp, data)
    day.early_min = early_minutes(rec, shift, emp, data, last_secs)
    day.ot_min = overtime_minutes(rec, shift, emp, punches, data.settings.ot_threshold_minutes or 60)

    perms = data.permissions.get((emp.id, d), [])
    day.perm_min = sum((p.duration_minutes or 60) for p in perms) if perms else None
    day.perm_types = [EmployeePermission.TYPE_LABELS.get(p.type_key, "Permission") for p in perms]
    day.half = half_worked(rec, emp, data.settings)

    flags: list[str] = []
    if rec is not None:
        if rec.is_late:
            flags.append("Late")
        if rec.early_leave:
            flags.append("Early out")
        if rec.late_afternoon:
            flags.append("Late after lunch")
        if rec.morning_permission_applied or rec.evening_permission_applied:
            flags.append("Permission")
        if rec.morning_permission_excess or rec.evening_permission_excess:
            flags.append("Permission (excess)")
        if rec.middle_permission_today and "Permission" not in flags:
            flags.append("Permission")
        if rec.is_compensation_day:
            flags.append("Compensation day")
        if rec.is_half_day_leave:
            flags.append("Half-day leave")
        if rec.source == "manual" and day.label in (L_PRESENT, L_HALF, L_ABSENT, L_LEAVE, L_HOLIDAY):
            flags.append("HR override")
    if punches and punches[-1].on > d:
        flags.append("Exit after midnight")
    if live and rec is not None and rec.source != "manual":
        # The stored verdict is only as fresh as the last time somebody opened the day in Attendance. Punches that
        # synced afterwards, or a leave approved afterwards, are on the row but not in its status: say so.
        if data.punches_loaded(emp.id) and len(data.logs.get(emp.id, {}).get(d, ())) != (rec.total_punches or 0):
            flags.append(STALE_PUNCHES)
        if data.leave_approved_late(emp, d, rec):
            flags.append(STALE_LEAVE)
    if day.in_progress:
        flags.append("Provisional (day in progress)")
    day.flags = flags
    day.issues = (
        punch_exceptions(
            [p.secs for p in punches],
            rec,
            is_today=d == data.today,
            has_leave=day.leave is not None,
            is_holiday=d in data.holidays,
        )
        if live
        else []
    )
    return day


def detection_notes(settings, *, late: bool = True, early: bool = True) -> list[str]:
    """Notes for a report with Late / Early-Out figures when Settings has that detection switched off: the engine then
    stores no late / early-out flag on the days it computes, so the figures are zeros that mean 'not measured', not
    'punctual'. (Days stored while it was on keep the flag they were given.)"""
    out: list[str] = []
    if late and not settings.morning_late_in_enabled:
        out.append(
            "Morning Late-In detection is switched off in Settings: days computed while it is off carry no late flag, "
            "so late figures of those days are zero because nothing was measured, not because everyone was on time."
        )
    if early and not settings.evening_early_out_enabled:
        out.append(
            "Evening Early-Out detection is switched off in Settings: days computed while it is off carry no "
            "early-out flag, so early-out figures of those days are zero because nothing was measured."
        )
    return out


def weekday_text(d: dt.date) -> str:
    return WEEKDAYS[d.weekday()]


def minutes_or_none(v: int | None) -> int | None:
    return v if v else None


def hours(minutes: int | None) -> float | None:
    return None if minutes is None else round(minutes / 60.0, 2)


def source_text(day: Day) -> str | None:
    rec = day.rec
    if rec is None:
        return None
    if rec.source == "manual":
        return "Manual"
    return rec.primary_source
