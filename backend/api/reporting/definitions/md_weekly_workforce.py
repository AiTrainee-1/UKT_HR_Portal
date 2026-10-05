"""Weekly Workforce Summary (``md-weekly-workforce``): one row per department, each figure with its change on the week
before.

For the 7 days chosen (Monday to Sunday is the usual week) and the 7 days before them: headcount at the end of the
week, attendance %, absenteeism %, late %, overtime hours, joiners and leavers. The figures are the analytics modules':

* attendance / absenteeism / late % and overtime hours ... the Attendance page's department ranking
  (``attendance.department_rows``) and summary (``attendance.summary_for``) for each of the two weeks;
* headcount, joiners, leavers ........................... the Employees page's ``flow`` over the people of the
  department (opening + joiners - leavers = closing, so the headcount change is the net movement).

Today is provisional: a week that includes it is cut at yesterday for EVERY column, so the week and the week it is
compared with have the same number of days and the same rules.
"""

from __future__ import annotations

from datetime import timedelta

from api.md_portal.analytics import attendance as ATT
from api.md_portal.analytics import employees as EMP

from ..filters import branches
from ..registry import register
from ..types import HOURS, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import (
    CATEGORY,
    CAVEAT_COVERAGE,
    CAVEAT_HEADCOUNT,
    NO_DEPARTMENT,
    day_range,
    delta,
    distinct,
    fmt_day,
    kpi,
    period_between,
    scope_from,
    with_company_row,
)

COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.6),
    ColumnSpec("headcount", "Headcount", INTEGER, 1.2),
    ColumnSpec("headcountChange", "Change", INTEGER, 0.9),
    ColumnSpec("attendancePct", "Attendance %", PERCENT, 1.25),
    ColumnSpec("attendanceChange", "Change (pts)", NUMBER, 1.0),
    ColumnSpec("absenteeismPct", "Absenteeism %", PERCENT, 1.35),
    ColumnSpec("absenteeismChange", "Change (pts)", NUMBER, 1.0),
    ColumnSpec("latePct", "Late %", PERCENT, 1.0),
    ColumnSpec("lateChange", "Change (pts)", NUMBER, 1.0),
    ColumnSpec("overtimeHours", "Overtime hours", HOURS, 1.15),
    ColumnSpec("overtimeChange", "Change (hrs)", HOURS, 1.0),
    ColumnSpec("joiners", "Joiners", INTEGER, 0.95),
    ColumnSpec("joinersChange", "Change", INTEGER, 0.9),
    ColumnSpec("leavers", "Leavers", INTEGER, 0.95),
    ColumnSpec("leaversChange", "Change", INTEGER, 0.9),
)


def _row(name: str, a, pa, flow, pflow, tracked: bool) -> dict:
    """One department: this week's figures and the change on the week before (None where either side has no data)."""
    cur_ot = a["overtimeHours"] if a and tracked else None
    prev_ot = pa["overtimeHours"] if pa and tracked else None
    return {
        "department": name,
        "headcount": flow.closing if flow else None,
        "headcountChange": delta(flow.closing, pflow.closing, 0) if flow and pflow else None,
        "attendancePct": a["attendancePct"] if a else None,
        "attendanceChange": delta(a["attendancePct"], pa["attendancePct"]) if a and pa else None,
        "absenteeismPct": a["absenteeismPct"] if a else None,
        "absenteeismChange": delta(a["absenteeismPct"], pa["absenteeismPct"]) if a and pa else None,
        "latePct": a["latePct"] if a else None,
        "lateChange": delta(a["latePct"], pa["latePct"]) if a and pa else None,
        "overtimeHours": cur_ot,
        "overtimeChange": delta(cur_ot, prev_ot),
        "joiners": flow.joiners if flow else None,
        "joinersChange": flow.joiners - pflow.joiners if flow and pflow else None,
        "leavers": flow.leavers if flow else None,
        "leaversChange": flow.leavers - pflow.leavers if flow and pflow else None,
    }


def _run(ctx) -> ReportResult:
    start, end = ctx.date_from, ctx.date_to
    scope = scope_from(ctx)
    through = min(end, ctx.today - timedelta(days=1))  # today is provisional: complete days only, in every column
    if through < start:
        return ReportResult(
            rows=[],
            notes=[
                f"{fmt_day(start)} to {fmt_day(end)} has no completed day yet (today is provisional), so there is "
                "nothing to summarise. Choose a week that has finished."
            ],
        )
    cur = period_between(start, through)
    prev = cur.previous()

    att, att_prev = S.attendance_view(scope, cur, ctx.today), S.attendance_view(scope, prev, ctx.today)
    summary_cur = ATT.summary_for(scope, cur, ctx.today)
    wf = EMP.load(scope, ctx.today)
    groups = S.people_by_department(wf)
    flows = {name: EMP.flow(people, cur) for name, people in groups.items()}
    flows_prev = {name: EMP.flow(people, prev) for name, people in groups.items()}

    m = summary_cur["metrics"]
    # department rows show 0.0 for a department with no overtime; that only means something when overtime is tracked
    tracked = att.overtime_tracked and m["overtimeHours"]["value"] is not None
    names = set(att.departments)
    for name, f in flows.items():
        if f.opening or f.closing or f.joiners or f.leavers:
            names.add(name)
    rows = [
        _row(
            name,
            att.departments.get(name),
            att_prev.departments.get(name),
            flows.get(name),
            flows_prev.get(name),
            tracked,
        )
        for name in sorted(names, key=lambda n: (n == NO_DEPARTMENT, n.lower()))
    ]

    company_flow, company_prev = EMP.flow(wf.people, cur), EMP.flow(wf.people, prev)

    def metric(key: str) -> tuple[float | None, float | None]:
        return m[key]["value"], delta(m[key]["value"], m[key]["previous"])

    attendance, attendance_d = metric("attendancePct")
    absence, absence_d = metric("absenteeismPct")
    late, late_d = metric("latePct")
    overtime, overtime_d = metric("overtimeHours")
    company = {
        "department": "Company",
        "headcount": company_flow.closing,
        "headcountChange": delta(company_flow.closing, company_prev.closing, 0),
        "attendancePct": attendance,
        "attendanceChange": attendance_d,
        "absenteeismPct": absence,
        "absenteeismChange": absence_d,
        "latePct": late,
        "lateChange": late_d,
        "overtimeHours": overtime,
        "overtimeChange": overtime_d,
        "joiners": company_flow.joiners,
        "joinersChange": company_flow.joiners - company_prev.joiners,
        "leavers": company_flow.leavers,
        "leaversChange": company_flow.leavers - company_prev.leavers,
    }
    summary = [
        kpi("Headcount", company["headcount"], "integer"),
        kpi("Attendance %", attendance, "percent"),
        kpi("Absenteeism %", absence, "percent"),
        kpi("Late %", late, "percent"),
        kpi("Overtime hours", overtime, "hours"),
        kpi("Joiners", company["joiners"], "integer"),
        kpi("Leavers", company["leavers"], "integer"),
    ]

    falls = [
        (r["attendanceChange"], r["department"], r["attendancePct"])
        for r in rows
        if r["attendanceChange"] is not None and r["attendanceChange"] < 0
    ]
    worst = max(
        ((r["absenteeismPct"], r["department"]) for r in rows if r["absenteeismPct"]),
        default=None,
    )
    notes = distinct(
        [
            f"Week: {fmt_day(cur.start)} to {fmt_day(cur.end)}. Every change compares with the previous {prev.days} "
            f"days ({fmt_day(prev.start)} to {fmt_day(prev.end)}); changes in percentages are in percentage points.",
            f"The week you chose includes today, which is provisional, so every column covers {fmt_day(cur.start)} "
            f"to {fmt_day(cur.end)}."
            if through < end
            else None,
            f"Biggest fall in attendance: {min(falls)[1]} ({min(falls)[0]:+.1f} points, now {min(falls)[2]}%)."
            if falls
            else None,
            f"Highest absenteeism: {worst[1]} ({worst[0]}%)." if worst else None,
            "Headcount is the number on the rolls at the end of the week; its change is joiners minus leavers.",
            "Overtime hours are those HR has detected or announced; days HR rejected are left out. Overtime is paid "
            "as one day's pay per announced day, not by the hour (the rupee cost is in the Monthly Payroll Summary).",
            CAVEAT_COVERAGE,
            *summary_cur["notes"],
            CAVEAT_HEADCOUNT,
            "No employees or attendance records exist for this selection." if not rows else None,
        ]
    )
    return ReportResult(rows=with_company_row(rows, company, ctx), summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-weekly-workforce",
        title="Weekly Workforce Summary",
        description="Each department's headcount, attendance, absence, lateness, overtime, joiners and leavers for a "
        "week, with the change on the week before.",
        category=CATEGORY,
        icon="Users",
        tags=("md", "executive", "weekly", "workforce", "attendance", "overtime", "joiners", "leavers"),
        landscape=True,  # fifteen columns: each measure with its change on the week before
        md_only=True,
        filters=(
            day_range(
                "last7",
                "Week (up to 7 days)",
                7,
                "The 7 days to report on; they are compared with the 7 days before. Today is left out until it ends.",
            ),
            branches("Unit"),
        ),
        columns=COLUMNS,
        run=_run,
    )
)
