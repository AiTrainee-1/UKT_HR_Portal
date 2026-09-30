"""Gate reports on TEA BREAKS (report group G9).

Data: ``TeaBreakLog`` -- one row per OUT/IN toggle cycle (open = no IN scan yet) -- and the singleton
``TeaBreakRule`` (allowed minutes). Duration, allowed minutes and the on-time / overtime / not-returned remark are
NOT stored; they are derived at read time exactly as ``tea_break_views._log_json`` does (same rounding), against
the LIVE rule.

Missed scans: a missed IN (or OUT) scan inverts the toggle, so later scans within 12 hours pair the wrong events and
produce "breaks" of several hours that the HR page shows as overtime. Such rows are never presented as real
durations without a marker: a completed break over 60 minutes is flagged "Long break", a break left open for more than
12 hours is flagged "Left open", open breaks show no duration at all, and every summary offers to leave them out.

Summaries are aggregated in SQL (this is the highest-volume gate table); only the register / exception listings
are row-level, and they honour ``ctx.row_limit`` in the query. Employee photos are never loaded (``values()`` only).
"""

from __future__ import annotations

from collections import Counter
from datetime import date

from django.db.models import Count, F, Max, Min, Q, Sum

from ..filters import boolean, date_range, scope, select, text
from ..registry import register
from ..types import (
    BADGE,
    DATE,
    DURATION,
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
from . import gate_visitor_tea_common as C

_REMARK_OPTIONS = [(k, v) for k, v in C.REMARK_LABEL.items()]
_EMPLOYMENT_LABEL = {"staff": "Staff", "production": "Production"}

_EXCLUDE_SUSPECT = boolean(
    "excludeSuspect",
    "Leave out long / unclosed breaks",
    help=f"Drops completed breaks over {C.SUSPECT_MINUTES} minutes and breaks left open for over 12 hours (usually a missed scan).",
)


def _suspect_note() -> str:
    return (
        f"'Long break' = a completed break over {C.SUSPECT_MINUTES} minutes; 'Left open' = never closed and older than "
        "12 hours. Both usually mean a missed OUT/IN scan (the toggle then pairs the wrong scans) rather than a real "
        "break, so they are flagged instead of being trusted as real durations."
    )


def _common_notes(allowed, rule_at, *, excluded: bool = False) -> list[str]:
    notes = [
        C.rule_note(allowed, rule_at),
        "Times are Indian Standard Time; a break belongs to the day it STARTED. Only employees who scan appear - there is "
        "no cross-check with attendance or shift, and low counts may simply mean people do not scan.",
        "Minutes are per completed break, rounded to whole minutes exactly as on the HR Tea Break page. Open breaks have no "
        "duration: more than 60 minutes open is 'Not returned', otherwise 'In progress'.",
        _suspect_note(),
        "Informational only - tea breaks have no effect on attendance or payroll.",
    ]
    if excluded:
        notes.append(
            "Long and left-open breaks were left out of this report (filter 'Leave out long / unclosed breaks')."
        )
    return notes


def _top_list(items, key, label, n: int = 5):
    """'CODE Name (x); ...' for the ``n`` items with the highest non-zero ``key`` (stable on ties)."""
    ranked = [r for r in sorted(items, key=key, reverse=True) if key(r)][:n]
    return "; ".join(f"{r['employeeCode']} {r['employeeName']} ({label(r)})" for r in ranked)


def _top(items, key, label):
    """'CODE Name (n)' of the item with the highest key (first in list order on ties); None if all zero."""
    best = max(items, key=key, default=None)
    if best is None or not key(best):
        return None
    return f"{best['employeeCode']} {best['employeeName']} ({label(best)})"


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-register
# ═════════════════════════════════════════════════════════════════════════════


def _run_register(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    qs = C.tea_queryset(ctx, now=now)
    remark = ctx.params.get("remark")
    if remark:
        qs = qs.filter(C.remark_q(remark, allowed, now))
    long_mode = ctx.params.get("longBreaks")
    if long_mode == "exclude":
        qs = qs.filter(C.not_suspect_q(now))
    elif long_mode == "only":
        qs = qs.filter(C.suspect_q(now))
    gate = ctx.params.get("gate")
    if gate:  # the gate list is data (not a fixed option set), so it is matched by name, on either scan
        qs = qs.filter(Q(out_gate__name__icontains=gate) | Q(in_gate__name__icontains=gate))

    fetched = qs.values(
        "id", "out_at", "in_at", "out_gate__name", "in_gate__name", "employee__employment_type", *C.emp_value_fields()
    ).order_by("out_at", "id")[: ctx.row_limit]
    rows = []
    for r in fetched:
        taken, mark = C.tea_metrics(r["out_at"], r["in_at"], allowed, now)
        done = r["in_at"] is not None
        day = C.to_ist(r["out_at"]).date()
        rows.append(
            {
                "date": day.isoformat(),
                **C.emp_cells_from_values(r),
                "employmentType": _EMPLOYMENT_LABEL.get(r["employee__employment_type"], r["employee__employment_type"]),
                "outAt": C.hhmm(r["out_at"]),
                "outGate": r["out_gate__name"],
                "inAt": C.hhmm_relative(r["in_at"], day),
                "inGate": r["in_gate__name"],
                "takenMinutes": taken if done else None,
                "allowedMinutes": allowed,
                "overMinutes": (max(0, taken - allowed) if done else None),
                "remark": C.REMARK_LABEL[mark],
                "flag": C.tea_flag(r["out_at"], r["in_at"], taken, now),
            }
        )

    agg = qs.aggregate(**C.tea_measures(allowed, now), people=Count("employee_id", distinct=True))
    summary = [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Breaks", "value": agg["breaks"], "format": "integer"},
        {"label": "Overtime", "value": agg["overtime"], "format": "integer"},
        {
            "label": "Minutes over allowance",
            "value": C.over_minutes(agg["over_sum"], agg["overtime"], allowed),
            "format": "minutes",
        },
        {"label": "Not returned", "value": agg["not_returned"], "format": "integer"},
        {"label": "Long or left open", "value": agg["long_breaks"], "format": "integer"},
        {"label": "Avg minutes / break", "value": C.avg(agg["total_min"], agg["completed"]), "format": "number"},
        {"label": "Employees", "value": agg["people"], "format": "integer"},
        {"label": "Longest break (min)", "value": agg["max_min"], "format": "minutes"},
        {"label": "Completed", "value": agg["completed"], "format": "integer"},
        {"label": "On time", "value": agg["on_time"], "format": "integer"},
        {"label": "In progress", "value": agg["in_progress"], "format": "integer"},
        {"label": "Total time taken", "value": int(agg["total_min"] or 0), "format": "duration"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=_common_notes(allowed, rule_at))


register(
    ReportSpec(
        id="tea-break-register",
        title="Tea Break Register",
        description="Every tea-break OUT/IN with duration against the allowed minutes and an on-time / overtime / not-returned remark.",
        category=C.CATEGORY,
        icon="Coffee",
        tags=("tea", "tea time", "break", "canteen", "overtime", "gate"),
        family="tea-break",
        variant="Register",
        modules=C.MODULES,
        filters=(
            date_range("today", "Break date"),
            *scope(status="all"),
            select("remark", "Remark", _REMARK_OPTIONS, placeholder="All"),
            select(
                "longBreaks",
                "Long / unclosed breaks",
                [("exclude", "Leave them out"), ("only", "Only them")],
                placeholder="Include all",
            ),
            text("gate", "Gate name contains", "e.g. Gate 1"),
        ),
        columns=(
            ColumnSpec("date", "Date", DATE, 1.4),
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.95),
            ColumnSpec("employeeName", "Employee", TEXT, 2.0),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("designation", "Designation", TEXT, 1.3),
            ColumnSpec("employmentType", "Type", BADGE, 1.1),
            ColumnSpec("outAt", "Out", TIME, 0.8),
            ColumnSpec("outGate", "Out gate", TEXT, 1.0),
            ColumnSpec("inAt", "In", TEXT, 1.1, align="center"),
            ColumnSpec("inGate", "In gate", TEXT, 1.0),
            ColumnSpec("takenMinutes", "Taken (min)", MINUTES, 0.9, total="sum"),
            ColumnSpec("allowedMinutes", "Allowed (min)", MINUTES, 0.9),
            ColumnSpec("overMinutes", "Over (min)", MINUTES, 0.9, total="sum"),
            ColumnSpec("remark", "Remark", BADGE, 1.15),
            ColumnSpec("flag", "Check", BADGE, 1.1),
        ),
        run=_run_register,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-employee-summary
# ═════════════════════════════════════════════════════════════════════════════


def _run_employee_summary(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    excluded = bool(ctx.params.get("excludeSuspect"))
    qs = C.tea_queryset(ctx, now=now, exclude_suspect=excluded)
    groups = (
        qs.values("employee_id", *C.emp_value_fields())
        .annotate(**C.tea_measures(allowed, now), days=Count(C.ist_day_expr(), distinct=True))
        .order_by("employee__employee_code", "employee_id")
    )
    if ctx.params.get("onlyOvertime"):
        groups = groups.filter(overtime__gt=0)

    rows = []
    for g in groups:
        rows.append(
            {
                **C.emp_cells_from_values(g),
                "breaks": g["breaks"],
                "completed": g["completed"],
                "onTime": g["on_time"],
                "overtime": g["overtime"],
                "notReturned": g["not_returned"],
                "inProgress": g["in_progress"],
                "longBreaks": g["long_breaks"],
                "totalMinutes": int(g["total_min"] or 0),
                "avgMinutes": C.avg(g["total_min"], g["completed"]),
                "maxMinutes": g["max_min"],
                "overMinutesTotal": C.over_minutes(g["over_sum"], g["overtime"], allowed),
                "overtimePct": C.pct(g["overtime"], g["completed"]),
                "daysWithBreaks": g["days"],
                "avgBreaksPerDay": round(g["breaks"] / g["days"], 2) if g["days"] else None,
            }
        )

    completed = sum(r["completed"] for r in rows)
    total_min = sum(r["totalMinutes"] for r in rows)
    summary = [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Employees with breaks", "value": len(rows), "format": "integer"},
        {"label": "Breaks", "value": sum(r["breaks"] for r in rows), "format": "integer"},
        {"label": "Overtime breaks", "value": sum(r["overtime"] for r in rows), "format": "integer"},
        {
            "label": "Avg minutes / break",
            "value": round(total_min / completed, 2) if completed else None,
            "format": "number",
        },
        {"label": "Long or left open", "value": sum(r["longBreaks"] for r in rows), "format": "integer"},
        {
            "label": "Most overtime breaks",
            "value": _top(rows, lambda r: r["overtime"], lambda r: r["overtime"]),
            "format": "text",
        },
        {
            "label": "Most total time",
            "value": _top(rows, lambda r: r["totalMinutes"], lambda r: f"{r['totalMinutes']} min"),
            "format": "text",
        },
    ]
    top_overtime = _top_list(rows, lambda r: r["overtime"], lambda r: r["overtime"])
    top_time = _top_list(rows, lambda r: r["totalMinutes"], lambda r: f"{r['totalMinutes']} min")
    notes = _common_notes(allowed, rule_at, excluded=excluded) + [
        f"Top 5 by overtime breaks: {top_overtime}." if top_overtime else "No overtime breaks in this period.",
        f"Top 5 by total break time: {top_time}." if top_time else "No completed breaks in this period.",
        "Averages, maxima and the overtime % use completed breaks only (overtime % = overtime / completed). Employees with "
        "no breaks in the period are not listed; 'In progress' + 'Not returned' are the breaks still open.",
    ]
    return ReportResult(rows=rows[: ctx.row_limit], summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-employee-summary",
        title="Tea Break Summary by Employee",
        description="Per employee: number of breaks, total and average minutes, overtime and non-return counts.",
        category=C.CATEGORY,
        icon="Users",
        tags=("tea", "tea time", "break", "employee", "overtime"),
        family="tea-break",
        variant="By employee",
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            *scope(status="all"),
            _EXCLUDE_SUSPECT,
            boolean("onlyOvertime", "Only employees with overtime breaks"),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.95),
            ColumnSpec("employeeName", "Employee", TEXT, 1.9),
            ColumnSpec("department", "Department", TEXT, 1.6),
            ColumnSpec("breaks", "Breaks", INTEGER, 1.05, total="sum"),
            ColumnSpec("completed", "Completed", INTEGER, 1.35, total="sum"),
            ColumnSpec("onTime", "On time", INTEGER, 1.05, total="sum"),
            ColumnSpec("overtime", "Overtime", INTEGER, 1.25, total="sum"),
            ColumnSpec("notReturned", "Not returned", INTEGER, 1.15, total="sum"),
            ColumnSpec("inProgress", "In progress", INTEGER, 1.1, total="sum"),
            ColumnSpec("longBreaks", "Long / open", INTEGER, 1.0, total="sum"),
            ColumnSpec("totalMinutes", "Total time", DURATION, 1.0, total="sum"),
            ColumnSpec("avgMinutes", "Avg (min)", NUMBER, 0.85),
            ColumnSpec("maxMinutes", "Longest (min)", MINUTES, 1.15),
            ColumnSpec("overMinutesTotal", "Over allowance", DURATION, 1.4, total="sum"),
            ColumnSpec("overtimePct", "Overtime %", PERCENT, 1.1),
            ColumnSpec("daysWithBreaks", "Days", INTEGER, 0.75, total="sum"),
            ColumnSpec("avgBreaksPerDay", "Breaks / day", NUMBER, 0.95),
        ),
        run=_run_employee_summary,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-department-summary
# ═════════════════════════════════════════════════════════════════════════════

_GROUP_FIELD = {"department": "department_id", "branch": "branch_id", "employmentType": "employment_type"}
_GROUP_LABEL = {"department": "Department", "branch": "Branch", "employmentType": "Employee type"}

_DEPT_COLUMNS = (
    ColumnSpec("group", "Department", TEXT, 2.2),
    ColumnSpec("branch", "Branch", TEXT, 1.3),
    ColumnSpec("headcount", "Headcount", INTEGER, 1.15, total="sum"),
    ColumnSpec("employeesOnBreak", "Employees on break", INTEGER, 1.1, total="sum"),
    ColumnSpec("participationPct", "Participation %", PERCENT, 1.4),
    ColumnSpec("breaks", "Breaks", INTEGER, 0.8, total="sum"),
    ColumnSpec("totalMinutes", "Total time", DURATION, 1.0, total="sum"),
    ColumnSpec("avgMinutes", "Avg (min)", NUMBER, 0.8),
    ColumnSpec("overtime", "Overtime", INTEGER, 1.05, total="sum"),
    ColumnSpec("overtimePct", "Overtime %", PERCENT, 1.1),
    ColumnSpec("notReturned", "Not returned", INTEGER, 1.15, total="sum"),
    ColumnSpec("longBreaks", "Long / open", INTEGER, 0.95, total="sum"),
    ColumnSpec("avgBreaksPerEmployeeDay", "Breaks / emp-day", NUMBER, 1.2),
)


def _group_labels(group_by: str, keys) -> dict:
    """{key: (label, branch name)} for every group key, in a single lookup query."""
    from api.models import Branch, Department

    real = [k for k in keys if k is not None]
    if group_by == "department":
        info = {d["id"]: d for d in Department.objects.filter(id__in=real).values("id", "name", "branch__name")}
        out = {
            k: (info[k]["name"], info[k]["branch__name"]) if k in info else ("Unknown department", None) for k in real
        }
        out[None] = ("No department", None)
    elif group_by == "branch":
        info = dict(Branch.objects.filter(id__in=real).values_list("id", "name"))
        out = {k: (info.get(k, "Unknown branch"), None) for k in real}
        out[None] = ("No branch", None)
    else:
        out = {k: (_EMPLOYMENT_LABEL.get(k, str(k).title()), None) for k in real}
        out[None] = ("Not set", None)
    return out


def _run_department_summary(ctx):
    from api.models import Employee

    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    excluded = bool(ctx.params.get("excludeSuspect"))
    group_by = ctx.params.get("groupBy") or "department"
    field = _GROUP_FIELD[group_by]
    qs = C.tea_queryset(ctx, now=now, exclude_suspect=excluded)

    tea = {
        g["grp"]: g
        for g in qs.values(grp=F(f"employee__{field}"))
        .annotate(
            **C.tea_measures(allowed, now),
            people=Count("employee_id", distinct=True),
            emp_days=Count(C.employee_day_key(), distinct=True),
        )
        .order_by()
    }
    head = {
        h["grp"]: h["n"]
        for h in Employee.objects.filter(ctx.emp_q()).values(grp=F(field)).annotate(n=Count("id")).order_by()
    }
    labels = _group_labels(group_by, set(tea) | set(head))

    rows = []
    for key in set(tea) | set(head):
        g = tea.get(key)
        headcount = head.get(key, 0)
        label, branch = labels[key]
        people = g["people"] if g else 0
        rows.append(
            {
                "group": label,
                "branch": branch,
                "headcount": headcount,
                "employeesOnBreak": people,
                "participationPct": C.pct(people, headcount),
                "breaks": g["breaks"] if g else 0,
                "totalMinutes": int(g["total_min"] or 0) if g else 0,
                "avgMinutes": C.avg(g["total_min"], g["completed"]) if g else None,
                "overtime": g["overtime"] if g else 0,
                "overtimePct": C.pct(g["overtime"], g["completed"]) if g else None,
                "notReturned": g["not_returned"] if g else 0,
                "longBreaks": g["long_breaks"] if g else 0,
                "avgBreaksPerEmployeeDay": round(g["breaks"] / g["emp_days"], 2) if g and g["emp_days"] else None,
                "_key": key,
            }
        )
    rows.sort(key=lambda r: (r["group"].lower(), r["branch"] or "", r["_key"] if r["_key"] is not None else -1))

    columns = [c for c in _DEPT_COLUMNS if group_by == "department" or c.key != "branch"]
    columns[0] = ColumnSpec("group", _GROUP_LABEL[group_by], TEXT, 2.2)

    breaks = sum(r["breaks"] for r in rows)
    people = sum(r["employeesOnBreak"] for r in rows)
    headcount = sum(r["headcount"] for r in rows)
    completed = sum(g["completed"] for g in tea.values())
    overtime = sum(r["overtime"] for r in rows)
    worst = max(
        (r for r in rows if r["overtimePct"]),
        key=lambda r: (r["overtimePct"], r["overtime"]),
        default=None,
    )
    summary = [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Breaks", "value": breaks, "format": "integer"},
        {"label": "Headcount", "value": headcount, "format": "integer"},
        {"label": "Participation", "value": C.pct(people, headcount), "format": "percent"},
        {"label": "Overtime %", "value": C.pct(overtime, completed), "format": "percent"},
        {"label": "Long or left open", "value": sum(r["longBreaks"] for r in rows), "format": "integer"},
        {
            "label": "Highest overtime %",
            "value": f"{worst['group']} ({worst['overtimePct']}%)" if worst else None,
            "format": "text",
        },
    ]
    notes = _common_notes(allowed, rule_at, excluded=excluded) + [
        "Breaks and headcount both cover only the employees matching the filters. Employee status defaults to All so "
        "that breaks by people who have since left stay in the totals, exactly as in the tea register and daily trend; "
        "choose Active to limit breaks and headcount to current employees. Headcount is today's figure, not a "
        "historical one (it includes people who have since left unless you choose Active), and low participation may "
        "just mean people do not scan.",
        "Groups are keyed on the department itself (department names repeat across branches, so the branch is shown). "
        "'Breaks / emp-day' = breaks divided by the number of employee-days (one employee on one day) with at least one break.",
    ]
    return ReportResult(rows=rows[: ctx.row_limit], columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-department-summary",
        title="Tea Break Summary by Department",
        description="Department, branch or staff-vs-production comparison of break volume, duration and overtime against headcount.",
        category=C.CATEGORY,
        icon="Building2",
        tags=("tea", "tea time", "break", "department", "participation"),
        family="tea-break",
        variant="By department",
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            select(
                "groupBy",
                "Group by",
                [("department", "Department"), ("branch", "Branch"), ("employmentType", "Employee type")],
                default="department",
                placeholder="Department",
            ),
            *scope(status="all", designation=False, employment=True, employee=False),
            _EXCLUDE_SUSPECT,
        ),
        columns=_DEPT_COLUMNS,
        run=_run_department_summary,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-exceptions
# ═════════════════════════════════════════════════════════════════════════════


def _run_exceptions(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    base = C.tea_queryset(ctx, now=now)
    kind = ctx.params.get("exceptionType") or "both"
    min_over = int(ctx.params.get("minOverMinutes") or 1)
    overtime_cond = C.long_q(allowed + min_over - 1)  # rounded minutes >= allowed + min_over
    cond = {
        "overtime": overtime_cond,
        "not_returned": C.not_returned_q(now),
        "both": overtime_cond | C.not_returned_q(now),
    }[kind]
    qs = base.filter(cond)

    per_employee = {
        r["employee_id"]: r["n"]
        for r in base.values("employee_id").annotate(n=Count("id", filter=C.long_q(allowed))).order_by()
    }
    fetched = (
        qs.annotate(dur=F("in_at") - F("out_at"))
        .values("id", "out_at", "in_at", "out_gate__name", "in_gate__name", "employee_id", *C.emp_value_fields())
        .order_by(F("dur").desc(nulls_last=True), "out_at", "id")[: ctx.row_limit]
    )
    rows = []
    for r in fetched:
        taken, mark = C.tea_metrics(r["out_at"], r["in_at"], allowed, now)
        done = r["in_at"] is not None
        day = C.to_ist(r["out_at"]).date()
        rows.append(
            {
                "date": day.isoformat(),
                **C.emp_cells_from_values(r),
                "outAt": C.hhmm(r["out_at"]),
                "inAt": C.hhmm_relative(r["in_at"], day),
                "takenMinutes": taken if done else None,
                "allowedMinutes": allowed,
                "overMinutes": (taken - allowed) if done else None,
                "remark": C.REMARK_LABEL[mark],
                "flag": C.tea_flag(r["out_at"], r["in_at"], taken, now),
                "overtimeCountInPeriod": per_employee.get(r["employee_id"], 0),
                "outGate": r["out_gate__name"],
                "inGate": r["in_gate__name"],
            }
        )

    agg = qs.aggregate(**C.tea_measures(allowed, now))
    repeat = sum(1 for n in per_employee.values() if n >= 3)
    summary = [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Overtime breaks", "value": agg["overtime"], "format": "integer"},
        {
            "label": "Minutes over allowance",
            "value": C.over_minutes(agg["over_sum"], agg["overtime"], allowed),
            "format": "minutes",
        },
        {"label": "Not returned", "value": agg["not_returned"], "format": "integer"},
        {"label": "Likely missed scans (long or left open)", "value": agg["long_breaks"], "format": "integer"},
        {"label": "Employees with 3+ overtime breaks (whole period)", "value": repeat, "format": "integer"},
    ]
    notes = _common_notes(allowed, rule_at) + [
        "Worst first: overtime breaks by minutes taken, then breaks that were never closed (no duration). 'Overtime "
        "breaks in period' counts that employee's overtime breaks over the whole date range, whatever the other filters.",
        "'Minimum minutes over' applies to overtime breaks only; breaks that were never closed are not affected by it.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-exceptions",
        title="Tea Break Overtime & Non-Return Exceptions",
        description="Action list of only the breaks that exceeded the allowance or were never closed, worst first.",
        category=C.CATEGORY,
        icon="TriangleAlert",
        tags=("tea", "tea time", "break", "overtime", "not returned", "exception"),
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            *scope(status="all", designation=False),
            select(
                "exceptionType",
                "Exceptions",
                [
                    ("overtime", "Overtime only"),
                    ("not_returned", "Not returned only"),
                    ("both", "Overtime and not returned"),
                ],
                default="both",
                placeholder="Overtime and not returned",
            ),
            select(
                "minOverMinutes",
                "Minimum minutes over",
                [("1", "1+"), ("5", "5+"), ("10", "10+"), ("15", "15+"), ("30", "30+")],
                placeholder="Any",
            ),
        ),
        columns=(
            ColumnSpec("date", "Date", DATE, 1.1),
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.5),
            ColumnSpec("outAt", "Out", TIME, 0.8),
            ColumnSpec("inAt", "In", TEXT, 1.1, align="center"),
            ColumnSpec("takenMinutes", "Taken (min)", MINUTES, 0.9, total="sum"),
            ColumnSpec("allowedMinutes", "Allowed (min)", MINUTES, 0.9),
            ColumnSpec("overMinutes", "Over (min)", MINUTES, 0.9, total="sum"),
            ColumnSpec("remark", "Remark", BADGE, 1.15),
            ColumnSpec("flag", "Check", BADGE, 1.1),
            ColumnSpec("overtimeCountInPeriod", "Overtime breaks in period", INTEGER, 1.0),
            ColumnSpec("outGate", "Out gate", TEXT, 1.0),
            ColumnSpec("inGate", "In gate", TEXT, 1.0),
        ),
        run=_run_exceptions,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-daily-trend
# ═════════════════════════════════════════════════════════════════════════════


def _run_daily_trend(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    excluded = bool(ctx.params.get("excludeSuspect"))
    qs = C.tea_queryset(ctx, now=now, exclude_suspect=excluded)
    day = C.ist_day_expr()
    per_day = {
        g["d"]: g
        for g in qs.annotate(d=day)
        .values("d")
        .annotate(
            **C.tea_measures(allowed, now),
            people=Count("employee_id", distinct=True),
        )
        .order_by()
    }
    hours: dict = {}
    for g in qs.annotate(d=day, h=C.ist_hour_expr()).values("d", "h").annotate(n=Count("id")).order_by():
        hours.setdefault(g["d"], {})[g["h"]] = g["n"]

    rows = []
    for d in ctx.days_in_range:
        g = per_day.get(d)
        rows.append(
            {
                "date": d.isoformat(),
                "weekday": C.weekday_name(d),
                "breaks": g["breaks"] if g else 0,
                "employees": g["people"] if g else 0,
                "totalMinutes": int(g["total_min"] or 0) if g else 0,
                "avgMinutes": C.avg(g["total_min"], g["completed"]) if g else None,
                "overtime": g["overtime"] if g else 0,
                "overtimePct": C.pct(g["overtime"], g["completed"]) if g else None,
                "notReturned": g["not_returned"] if g else 0,
                "peakHour": C.peak_hour_text(hours.get(d, {})),
                "_completed": g["completed"] if g else 0,
            }
        )

    total = sum(r["breaks"] for r in rows)
    worst = max(  # highest overtime %; on a tie the day with more overtime, then the earlier day
        (r for r in rows if r["overtimePct"]),
        key=lambda r: (r["overtimePct"], r["overtime"], -date.fromisoformat(r["date"]).toordinal()),
        default=None,
    )
    summary = [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Breaks", "value": total, "format": "integer"},
        {
            "label": "Avg breaks / calendar day",
            "value": round(total / len(rows), 1) if rows else None,
            "format": "number",
        },
        {"label": "Overtime breaks", "value": sum(r["overtime"] for r in rows), "format": "integer"},
        {
            "label": "Worst day (overtime %)",
            "value": f"{worst['date']} ({worst['overtimePct']}%)" if worst else None,
            "format": "text",
        },
    ]
    notes = _common_notes(allowed, rule_at, excluded=excluded) + [
        "Every calendar day of the range is listed, including days with no breaks. 'Employees' is the number of different "
        "people on break that day, so it does not add up across days. Peak hour = the hour breaks most often started.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-daily-trend",
        title="Tea Break Daily Trend",
        description="Day-wise break counts, minutes, overtime rate and peak hour.",
        category=C.CATEGORY,
        icon="TrendingUp",
        tags=("tea", "tea time", "break", "trend", "daily"),
        landscape=False,
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            *scope(status=None, designation=False, employee=False),
            _EXCLUDE_SUSPECT,
        ),
        columns=(
            ColumnSpec("date", "Date", DATE, 1.1),
            ColumnSpec("weekday", "Day", TEXT, 0.7),
            ColumnSpec("breaks", "Breaks", INTEGER, 0.8, total="sum"),
            ColumnSpec("employees", "Employees", INTEGER, 0.9),
            ColumnSpec("totalMinutes", "Total time", DURATION, 1.0, total="sum"),
            ColumnSpec("avgMinutes", "Avg (min)", NUMBER, 0.8),
            ColumnSpec("overtime", "Overtime", INTEGER, 1.05, total="sum"),
            ColumnSpec("overtimePct", "Overtime %", PERCENT, 1.1),
            ColumnSpec("notReturned", "Not returned", INTEGER, 1.15, total="sum"),
            ColumnSpec("peakHour", "Peak hour", TEXT, 1.1, align="center"),
        ),
        run=_run_daily_trend,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-hourly-distribution
# ═════════════════════════════════════════════════════════════════════════════


def _run_hourly(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    excluded = bool(ctx.params.get("excludeSuspect"))
    qs = C.tea_queryset(ctx, now=now, exclude_suspect=excluded)
    by_hour = {
        g["h"]: g
        for g in qs.annotate(h=C.ist_hour_expr()).values("h").annotate(**C.tea_measures(allowed, now)).order_by()
    }
    total = sum(g["breaks"] for g in by_hour.values())
    rows = []
    if by_hour:
        for h in range(min(by_hour), max(by_hour) + 1):  # contiguous band, so quiet hours between busy ones show
            g = by_hour.get(h)
            rows.append(
                {
                    "hourBand": C.hour_band(h),
                    "breaks": g["breaks"] if g else 0,
                    "sharePct": C.pct(g["breaks"], total) if g else 0.0,
                    "avgMinutes": C.avg(g["total_min"], g["completed"]) if g else None,
                    "overtime": g["overtime"] if g else 0,
                }
            )
    peak = max(by_hour.items(), key=lambda kv: (kv[1]["breaks"], -kv[0]), default=None)
    summary = [
        {"label": "Breaks", "value": total, "format": "integer"},
        {"label": "Peak hour", "value": C.hour_band(peak[0]) if peak else None, "format": "text"},
        {"label": "Breaks in peak hour", "value": peak[1]["breaks"] if peak else None, "format": "integer"},
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
    ]
    notes = _common_notes(allowed, rule_at, excluded=excluded) + [
        "Hours are the Indian Standard Time hour a break STARTED in (night-shift breaks between 00:00 and 05:59 are shown "
        "in their own hours, not folded into the previous day). Average minutes use completed breaks only.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-hourly-distribution",
        title="Tea Break Time-of-Day Distribution",
        description="When in the day breaks start and how long they last - useful for canteen and tea-station planning.",
        category=C.CATEGORY,
        icon="Clock",
        tags=("tea", "tea time", "break", "hour", "peak", "canteen"),
        landscape=False,
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            *scope(status=None, designation=False, employee=False),
            _EXCLUDE_SUSPECT,
        ),
        columns=(
            ColumnSpec("hourBand", "Hour (IST)", TEXT, 1.4),
            ColumnSpec("breaks", "Breaks", INTEGER, 0.9, total="sum"),
            ColumnSpec("sharePct", "Share %", PERCENT, 0.9),
            ColumnSpec("avgMinutes", "Avg (min)", NUMBER, 0.9),
            ColumnSpec("overtime", "Overtime", INTEGER, 0.9, total="sum"),
        ),
        run=_run_hourly,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
# tea-break-frequency
# ═════════════════════════════════════════════════════════════════════════════


def _run_frequency(ctx):
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    threshold = int(ctx.params.get("minBreaksPerDay") or 2)
    qs = C.tea_queryset(ctx, now=now)
    groups = (
        qs.annotate(d=C.ist_day_expr())
        .values("d", "employee_id", *C.emp_value_fields())
        .annotate(
            n=Count("id"),
            first_out=Min("out_at"),
            last_in=Max("in_at"),
            total=Sum(C.break_minutes(), filter=C.completed_q()),
            ot=Count("id", filter=C.long_q(allowed)),
            still_open=Count("id", filter=C.open_q()),
        )
        .filter(n__gt=threshold)
        .order_by("-n", "d", "employee__employee_code", "employee_id")
    )
    fetched = list(groups[: ctx.row_limit])
    rows = []
    for g in fetched:
        rows.append(
            {
                "date": g["d"].isoformat(),
                **C.emp_cells_from_values(g),
                "breaksThatDay": g["n"],
                "totalMinutes": int(g["total"] or 0),
                "overtime": g["ot"],
                "stillOpen": g["still_open"],
                "firstOutAt": C.hhmm(g["first_out"]),
                "lastInAt": C.hhmm_relative(g["last_in"], g["d"]),
            }
        )

    notes = _common_notes(allowed, rule_at) + [
        f"Employee-days with MORE THAN {threshold} breaks. No per-day limit exists in the tea-break rule - the threshold is only "
        "this report's filter. A missed scan can create extra rows (the toggle inverts), so check the 'Still open' and "
        "overtime columns before drawing conclusions.",
    ]
    if len(fetched) >= ctx.row_limit:
        return ReportResult(
            rows=rows, notes=notes + ["Summary cards are omitted because the list is longer than the row limit."]
        )
    per_person = Counter(g["employee_id"] for g in fetched)
    top_id = max(per_person.items(), key=lambda kv: (kv[1], -kv[0]), default=None)
    top = next((r for g, r in zip(fetched, rows) if top_id and g["employee_id"] == top_id[0]), None)
    summary = [
        {"label": "Employee-days flagged", "value": len(rows), "format": "integer"},
        {"label": "Employees flagged", "value": len(per_person), "format": "integer"},
        {
            "label": "Most often flagged",
            "value": (
                f"{top['employeeCode']} {top['employeeName']} ({top_id[1]} day{'s' if top_id[1] != 1 else ''})"
                if top
                else None
            ),
            "format": "text",
        },
        {
            "label": "Highest breaks in a day",
            "value": max((r["breaksThatDay"] for r in rows), default=None),
            "format": "integer",
        },
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="tea-break-frequency",
        title="Multiple Tea Breaks per Day",
        description="Employee-days with more than N tea breaks (informational; no daily limit is configured).",
        category=C.CATEGORY,
        icon="Hourglass",
        tags=("tea", "tea time", "break", "frequency", "multiple"),
        modules=C.MODULES,
        filters=(
            date_range("thisMonth", "Break date"),
            *scope(status="all", designation=False),
            select(
                "minBreaksPerDay",
                "Flag days with more than",
                [(str(i), f"{i} break{'s' if i > 1 else ''}") for i in range(1, 6)],
                default="2",
            ),
        ),
        columns=(
            ColumnSpec("date", "Date", DATE, 1.1),
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.5),
            ColumnSpec("designation", "Designation", TEXT, 1.5),
            ColumnSpec("breaksThatDay", "Breaks that day", INTEGER, 0.9, total="sum"),
            ColumnSpec("totalMinutes", "Total time", DURATION, 1.0, total="sum"),
            ColumnSpec("overtime", "Overtime", INTEGER, 1.05, total="sum"),
            ColumnSpec("stillOpen", "Still open", INTEGER, 0.8, total="sum"),
            ColumnSpec("firstOutAt", "First out", TIME, 0.9),
            ColumnSpec("lastInAt", "Last in", TEXT, 1.0, align="center"),
        ),
        run=_run_frequency,
    )
)
