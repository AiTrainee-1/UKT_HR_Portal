"""HR Reports (category ``hr``): ready-made HR lists that bring together data several modules own.

employee-confo-details: one line per employee with who they are (code, name, department, designation), what they are
paid, the department head their requests go to, when they joined and the shift they work.

Salary is printed here on purpose, so the report is gated on the payroll modules (see ``MODULES``), not on the
employee module alone: the employee registers in ``employees_master_*`` never print salary.

production-daily-punches: every punch of each production employee with its exact time, for one day or (date-wise) for
a week or a month, listed by SHIFT DAY, with the day's shift group, the shifts it earns, the late / early flags and the
rule that decided it (production_shift_rules). Gated on the attendance module: it prints no pay.

production-shift-rules: the saved shift table (groups, ladder rows, breaks, grace, start date) as printable rows.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from django.db.models import Q

from api.attendance_final import production_day_result
from api.models import (
    AttendanceLog,
    EmployeeShiftAssignment,
    ProductionBreak,
    ProductionShiftGroup,
    ProductionShiftRule,
    ProductionShiftSegment,
)
from api.shift_engine import _get_assignment_for_date

from .. import filters as F
from ..formatting import full_name, indian_number
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import BADGE, DATE, INTEGER, NUMBER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import weekday_text
from .employees_master_base import code_key, department_name, employees_qs, hod_name_map, join_date_of
from .production_judge import (
    ProductionJudge,
    employees_needing_history,
    history_floor,
    lookback_days,
    manual_days,
    read_config,
    shift_day_punches,
)

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
    ColumnSpec("shift", "Shift", TEXT, 1.0),
    ColumnSpec("punchCount", "Total Punch Count", INTEGER, 0.9, total="sum"),
    ColumnSpec("shiftsEarned", "Shifts Earned", NUMBER, 0.8, total="sum"),
    ColumnSpec("late", "Late", BADGE, 0.6),
    ColumnSpec("early", "Early", BADGE, 0.6),
    # the long cells come last, so they take the room that is left instead of pushing the figures off the screen
    ColumnSpec("punches", "All Punches (exact times)", TEXT, 3.0),
    ColumnSpec("ruleApplied", "Rule applied", TEXT, 3.2),
)

LEGACY_SHIFT = "Legacy rules"
MANUAL_SHIFT = "Manual entry"
MANUAL_NOTE = "Entered by HR: the saved value is used and the shift table is not applied"


def _secs(t) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def _clock(secs: int) -> str:
    """'08:02:15' for a punch on the shift day itself, '05:30:12 (+1)' for the next morning's closing punch."""
    day, rest = divmod(secs, 86400)
    text = f"{rest // 3600:02d}:{rest % 3600 // 60:02d}:{rest % 60:02d}"
    return f"{text} (+{day})" if day else text


def _punch_secs_of_shift_day(day, by_ref, blocks_cache, manual_e, ruleset) -> list[int] | None:
    """Every stored punch of shift day ``day`` as seconds since that day's midnight (a next-morning closing punch is
    +86400), double taps included, or None when the day holds nothing. From the date the shift-table rules take over a
    night worker's closing punch belongs to the day the shift began (the engine's own resolution); earlier days, and a
    day HR entered by hand, keep the calendar date the device stamped."""
    if ruleset is None or day in manual_e:
        own = by_ref.get(day) or []
        return sorted(s for s, _ref in own) or None
    shown = shift_day_punches(ruleset, day, by_ref, manual_e, blocks_cache)
    return [secs for secs, _ref in shown] or None


def _punches_run(ctx) -> ReportResult:
    date_from, date_to = ctx.date_from, ctx.date_to
    several_days = date_from != date_to

    ordered = sorted(employees_qs(ctx).filter(employment_type="production"), key=lambda e: code_key(e.employee_code))
    ids = [e.id for e in ordered]
    judge = ProductionJudge(read_config())
    config = judge.config
    # The rules judge day d from d - (night look-back) to d + 1, so the punches are read over that wider window; the
    # last day of the range being in force means some day is. Nothing is read beyond the range without rules.
    ruleset_end = judge.ruleset_for(date_to)
    log_from = date_from - timedelta(days=lookback_days(ruleset_end))
    log_to = date_to + timedelta(days=1 if ruleset_end is not None else 0)

    # {employee id: {date: [(seconds since that date's midnight, (date, log id), time)]}}, one pass over the punches
    raw: dict[int, dict] = defaultdict(lambda: defaultdict(list))
    for emp_id, day, punch_time, log_id in (
        AttendanceLog.objects.filter(employee_id__in=ids, date__gte=log_from, date__lte=log_to)
        .order_by("employee_id", "date", "punch_time", "id")
        .values_list("employee_id", "date", "punch_time", "id")
    ):
        raw[emp_id][day].append((_secs(punch_time), (day, log_id), punch_time))
    refs_by_emp = {
        emp_id: {k: [(s_, ref) for s_, ref, _t in v] for k, v in by_date.items()} for emp_id, by_date in raw.items()
    }
    # HR's hand-entered days (kept as entered, and outside every night session): the range itself, and with rules in force
    # the days a night chain can reach back to.
    manual = (
        manual_days(
            ids, history_floor(date_from) if ruleset_end is not None else date_from, date_to + timedelta(days=1)
        )
        if raw
        else {}
    )
    if ruleset_end is not None and raw:
        # a worker on a long unbroken run of nights needs the punches further back (ONE more query for all of them)
        needy = employees_needing_history(refs_by_emp, date_from, log_from, ruleset_end, manual)
        if needy:
            for emp_id, day, punch_time, log_id in (
                AttendanceLog.objects.filter(
                    employee_id__in=needy, date__gte=history_floor(date_from), date__lt=log_from
                )
                .order_by("employee_id", "date", "punch_time", "id")
                .values_list("employee_id", "date", "punch_time", "id")
            ):
                raw[emp_id][day].append((_secs(punch_time), (day, log_id), punch_time))
                refs_by_emp[emp_id].setdefault(day, []).append((_secs(punch_time), (day, log_id)))
    segments = list(ProductionShiftSegment.objects.filter(is_active=True)) if raw else []

    rows: list[dict] = []
    data_rows = total_punches = odd_days = people = late_days = early_days = 0
    total_shifts = 0.0
    listed_ids: set[int] = set()
    for e in ordered:
        by_raw = raw.get(e.id)
        days = sorted(d for d in by_raw if date_from <= d <= date_to) if by_raw else []
        if not days:
            continue
        name = full_name(e)
        manual_e = manual.get(e.id, {})
        by_ref = refs_by_emp[e.id]
        by_secs = {k: [s_ for s_, _ref in v] for k, v in by_ref.items()}
        blocks_cache: dict = {}
        shown = person_punches = 0
        person_shifts = 0.0
        for day in days:
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export; never build more than it keeps
                break
            ruleset = judge.ruleset_for(day)
            punch_secs = _punch_secs_of_shift_day(day, by_ref, blocks_cache, manual_e, ruleset)
            if not punch_secs:  # every punch of this date closes the night before: nothing begins on it
                continue
            if day in manual_e:
                stored, is_late, is_early = manual_e[day]
                shifts, group_label, note = float(stored or 0), MANUAL_SHIFT, MANUAL_NOTE
            else:
                result = production_day_result(day, by_secs, config, segments, ruleset, set(manual_e))
                shifts = float(result.get("shifts_earned") or 0)
                is_late, is_early = bool(result.get("is_late")), bool(result.get("early_leave"))
                group_label = result.get("rule_group") or LEGACY_SHIFT
                note = result.get("rule_note") or judge.legacy_note(day)
            rows.append(
                {
                    "employeeName": name,
                    "employeeCode": e.employee_code,
                    "designation": e.designation.title if e.designation_id else None,
                    "department": department_name(e),
                    "date": day.isoformat(),
                    "day": weekday_text(day),
                    "shift": group_label,
                    "punches": ", ".join(_clock(s) for s in punch_secs),
                    "punchCount": len(punch_secs),
                    "shiftsEarned": shifts,
                    "late": "Late" if is_late else None,
                    "early": "Early" if is_early else None,
                    "ruleApplied": note,
                }
            )
            data_rows += 1
            shown += 1
            person_punches += len(punch_secs)
            person_shifts += shifts
            odd_days += len(punch_secs) % 2
            late_days += is_late
            early_days += is_early
        if not shown:
            continue
        people += 1
        listed_ids.add(e.id)
        total_punches += person_punches
        total_shifts += person_shifts
        if several_days:
            rows.append(
                {
                    "employeeName": f"{name} ({e.employee_code}) total",
                    "punches": f"{shown} day{'s' if shown != 1 else ''} with punches",
                    "punchCount": person_punches,
                    "shiftsEarned": round(person_shifts, 2),
                    "_kind": KIND_SUBTOTAL,
                }
            )

    no_punches = sum(1 for e in ordered if e.status == "active" and e.id not in listed_ids)
    summary = [
        {"label": "Production employees with punches", "value": people, "format": "integer"},
        {"label": "Employee-days with punches", "value": data_rows, "format": "integer"},
        {"label": "Total punches", "value": total_punches, "format": "integer"},
        {"label": "Days with an odd punch count", "value": odd_days, "format": "integer"},
        {"label": "Active with no punches", "value": no_punches, "format": "integer"},
        {"label": "Total shifts earned", "value": round(total_shifts, 2), "format": "number"},
        {"label": "Late days", "value": late_days, "format": "integer"},
        {"label": "Early-leave days", "value": early_days, "format": "integer"},
    ]
    if several_days:
        shape = (
            f"Date-wise breakdown for {date_from.strftime('%d-%b-%Y')} to {date_to.strftime('%d-%b-%Y')}: each "
            "employee's days are listed in date order, followed by a total line. A day on which the employee made no "
            "punch is not listed."
        )
    else:
        shape = f"One line per employee for {date_from.strftime('%d-%b-%Y')}."
    eff = getattr(config, "rules_effective_from", None)
    if ruleset_end is not None:
        listing = (
            f"From {eff.strftime('%d-%b-%Y')} (the day the shift-table rules start) punches are listed by SHIFT DAY: a "
            "night worker's closing punch made the next morning is shown on the day the shift began, marked (+1), and is "
            "not listed again on the next date. Days before that date are listed by the calendar date the device stamped."
        )
    else:
        listing = (
            "A punch belongs to the calendar date the device stamped: a night shift's exit after midnight is listed on "
            "the next date until the shift-table rules start (Settings > Production shifts)."
        )
    notes = [
        shape,
        "Production employees only. Every punch stored for the employee on that day is listed in the order it was made, "
        "with its exact time (hh:mm:ss), whatever its source: biometric device, geo punch, on-duty, an approved missing "
        "punch or a manual entry.",
        "Total Punch Count is every stored punch, so a double tap counts twice. "
        + listing
        + " A day with an odd punch "
        "count may be a missed In or Out.",
        "Shift is the rule group that judged the day (Day, Night, Sunday ...); Legacy rules is the calculation used before "
        "the start date. Shifts Earned, Late and Early come from the same calculation as production payroll and are never "
        "saved by this report; Rule applied says in one sentence why the day came out that way. A day HR entered by hand "
        "shows the value HR entered.",
    ]
    if no_punches:
        notes.append(f"{no_punches} active production employee(s) made no punch in this period and are not listed.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="production-daily-punches",
        title="Production Daily Punches",
        description="Every punch of each production employee by shift day, with the shift group, the shifts earned, "
        "late / early flags and the rule applied: for one date, or date-wise for a week or a month.",
        category=CATEGORY,
        modules=ATTENDANCE_MODULES,
        icon="Fingerprint",
        tags=(
            "production",
            "punch",
            "punches",
            "daily",
            "weekly",
            "monthly",
            "biometric",
            "attendance",
            "in out",
            "shift",
            "shifts earned",
            "night",
        ),
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


# ── Production Shift Rules ──────────────────────────────────────────────────────

RULE_COLUMNS = (
    ColumnSpec("kind", "Type", BADGE, 0.9),
    ColumnSpec("group", "Group", TEXT, 1.6),
    ColumnSpec("appliesOn", "Applies on", TEXT, 1.4),
    ColumnSpec("starts", "Starts", TIME, 0.8),
    ColumnSpec("outTime", "Out time", TEXT, 1.2),
    ColumnSpec("shiftValue", "Shift value", NUMBER, 0.9),
    ColumnSpec("detail", "Detail", TEXT, 3.0),
)

APPLIES_TEXT = dict(ProductionShiftGroup.APPLIES_ON_CHOICES)


def _hm(t) -> str:
    return t.strftime("%H:%M")


def _out_text(t, next_day: bool) -> str:
    return f"{_hm(t)} (next day)" if next_day else _hm(t)


def _minutes_between(a, b) -> int:
    return (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute)


def _rules_run(ctx) -> ReportResult:
    config = read_config()
    groups = list(ProductionShiftGroup.objects.filter(enabled=True).order_by("order", "id"))
    rules_by_group: dict[int, list] = defaultdict(list)
    for r in ProductionShiftRule.objects.filter(enabled=True, group__enabled=True).order_by("order", "id"):
        rules_by_group[r.group_id].append(r)
    breaks = list(ProductionBreak.objects.filter(enabled=True).order_by("order", "id"))
    disabled_groups = ProductionShiftGroup.objects.filter(enabled=False).count()
    disabled_rules = ProductionShiftRule.objects.filter(enabled=False, group__enabled=True).count()
    disabled_breaks = ProductionBreak.objects.filter(enabled=False).count()

    rows: list[dict] = []
    group_notes: list[str] = []
    for g in groups:
        points = sorted(rules_by_group.get(g.id, []), key=lambda r: (r.out_next_day, r.out_time, r.id))
        for r in points:
            rows.append(
                {
                    "kind": "Shift rule",
                    "group": g.label,
                    "appliesOn": APPLIES_TEXT.get(g.applies_on, g.applies_on),
                    "starts": _hm(g.start_time),
                    "outTime": _out_text(r.out_time, r.out_next_day),
                    "shiftValue": float(r.shift_value),
                    "detail": (r.label or "").strip() or None,
                }
            )
        window = f"{_hm(g.first_punch_from)} to {_hm(g.first_punch_to)}"
        main_out = (
            f"; standard out {_out_text(g.main_out_time, g.main_out_next_day)} (leaving earlier than that, less the grace, "
            "is an early leave)"
            if g.main_out_time is not None
            else ""
        )
        group_notes.append(
            f"{g.label}: used when the first punch of the day is between {window}{main_out}."
            + ("" if points else " It has no enabled rule, so it pays nothing and is ignored.")
        )
    for b in breaks:
        rows.append(
            {
                "kind": "Break",
                "group": b.label or "Break",
                "appliesOn": "Every day, every group",
                "starts": _hm(b.start_time),
                "outTime": None,
                "shiftValue": None,
                "detail": f"{_hm(b.start_time)} to {_hm(b.end_time)} ({_minutes_between(b.start_time, b.end_time)} min), "
                "unpaid: nobody has to punch for it",
            }
        )

    eff = config.rules_effective_from
    on = bool(config.rules_enabled)
    live = on and eff is not None and bool(groups)
    summary = [
        {"label": "Enabled groups", "value": len(groups), "format": "integer"},
        {"label": "Shift rules", "value": sum(len(v) for v in rules_by_group.values()), "format": "integer"},
        {"label": "Breaks", "value": len(breaks), "format": "integer"},
        {"label": "Grace (min)", "value": int(config.rules_grace_minutes), "format": "minutes"},
        {"label": "Applies from", "value": eff.isoformat() if eff else None, "format": "date"},
        {"label": "Full-day value", "value": float(config.rules_full_day_value), "format": "number"},
        {"label": "Minimum credit", "value": float(config.rules_min_credit), "format": "number"},
    ]
    if not on:
        state = "The shift-table rules are switched OFF: every production day uses the previous calculation."
    elif eff is None:
        state = "The shift-table rules have no start date yet: every production day uses the previous calculation."
    elif not groups:
        state = "No shift group is enabled, so every production day uses the previous calculation."
    else:
        state = (
            f"The shift-table rules judge production days from {eff.strftime('%d-%b-%Y')} onwards (the 'Applies from' "
            "date in Settings > Production shifts)."
        )
    legacy = (
        f"Days before the start date keep the previous calculation: arrival {_hm(config.punch1_time)}, departure "
        f"{_hm(config.punch4_time)}, a {config.grace_minutes or 10}-minute grace and the shift segments in Manage Shifts. "
        "Nothing already paid is re-judged."
    )
    notes = [
        state,
        legacy,
        "Each row is one point of a group's ladder: a worker who leaves at that out time earned that many shifts. Between "
        "two points the value grows in proportion to the paid time, so every band has its own rate. Breaks are unpaid and "
        "never need punches.",
        f"Grace is {config.rules_grace_minutes} minute(s): arriving within it counts as on time, and leaving within it "
        "before a rule's out time earns that rule's value.",
        (
            f"A day's total is rounded to the nearest {config.rules_rounding_step} shift."
            if config.rules_rounding_mode != "down"
            else f"A day's total is rounded down to a multiple of {config.rules_rounding_step} shift."
        ),
        f"A day below {config.rules_full_day_value} shift is a half shift, at or above it present. A night session may "
        f"close with a punch made up to {config.rules_night_session_hours} hours later.",
        *group_notes,
    ]
    extra = [
        (disabled_groups, "disabled group(s)"),
        (disabled_rules, "disabled rule(s)"),
        (disabled_breaks, "disabled break(s)"),
    ]
    hidden = ", ".join(f"{n} {text}" for n, text in extra if n)
    if hidden:
        notes.append(f"Not listed because they are switched off: {hidden}.")
    if not live and not rows:
        notes.append("There are no enabled shift rules or breaks to list.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="production-shift-rules",
        title="Production Shift Rules",
        description="The saved production shift table: every group's ladder of out times and shift values, the unpaid "
        "breaks, the grace and the date the rules start.",
        category=CATEGORY,
        modules=ATTENDANCE_MODULES,
        icon="Layers",
        tags=("production", "shift", "rules", "ladder", "table", "grace", "breaks", "night", "sunday", "settings"),
        filters=(),
        columns=RULE_COLUMNS,
        run=_rules_run,
        landscape=True,
    )
)
