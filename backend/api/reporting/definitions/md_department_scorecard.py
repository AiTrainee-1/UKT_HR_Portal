"""Department Scorecard (``md-department-scorecard``): every department on one page, each measure against the company.

One row per department (a name used in several units is one department): attendance %, absenteeism %, late %, overtime
hours, payroll cost per head (the latest CLOSED month), attrition %, tea-break overrun % and outpass hours lost, and
beside each a Red / Amber / Green status against the company figure (the rules are printed in the notes; the rule
functions are in ``md_common``). Every measure is the page's own for the same period and scope:

* attendance, absenteeism, late, overtime ........ Attendance page (``attendance.department_rows``, ``summary_for``);
* payroll cost per head ......................... Payroll page (``payroll`` department rows, summed by name);
* attrition ..................................... Employees page (``employees.flow`` over the department's people);
* tea-break overrun % ........................... Tea Break page (``tea_break`` figures per department);
* outpass hours lost ............................ Outpass & Visitors page (``visitors`` pass figures per department).
"""

from __future__ import annotations

from collections import defaultdict

from api.md_portal.analytics import attendance as ATT
from api.md_portal.analytics import employees as EMP
from api.md_portal.analytics import payroll as PAY
from api.md_portal.analytics import tea_break as TEA
from api.md_portal.analytics import visitors as VIS

from ..filters import branches
from ..registry import register
from ..types import BADGE, HOURS, INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import (
    CATEGORY,
    CAVEAT_ATTRITION,
    CAVEAT_COVERAGE,
    CAVEAT_DEPARTMENTS,
    CAVEAT_HEADCOUNT,
    CAVEAT_PAYROLL,
    CAVEAT_TEA,
    MIN_SCHEDULED_DAYS,
    MIN_TEAM_FOR_ATTRITION,
    NO_DEPARTMENT,
    RAG_AMBER,
    RAG_RED,
    day_range,
    dept_name,
    distinct,
    fmt_day,
    kpi,
    param_errors,
    period_between,
    rag_points_below,
    rag_ratio_above,
    rag_thresholds_note,
    scope_from,
    with_company_row,
)


def _metric_columns() -> tuple[ColumnSpec, ...]:
    """Each measure with its Red / Amber / Green status beside it. The cost is shown in whole rupees (it is an average
    per head); the cells keep the exact amount."""
    pairs = (
        ("attendancePct", "Attendance %", PERCENT, 1.3, "attendanceRag"),
        ("absenteeismPct", "Absenteeism %", PERCENT, 1.45, "absenteeismRag"),
        ("latePct", "Late %", PERCENT, 1.0, "lateRag"),
        ("overtimeHours", "Overtime hours", HOURS, 1.15, "overtimeRag"),
        ("costPerHead", "Payroll cost per head (₹)", INTEGER, 1.25, "costRag"),
        ("attritionPct", "Attrition %", PERCENT, 1.1, "attritionRag"),
        ("teaOverrunPct", "Tea-break overrun %", PERCENT, 1.25, "teaRag"),
        ("outpassHours", "Outpass hours lost", HOURS, 1.2, "outpassRag"),
    )
    cols: list[ColumnSpec] = [ColumnSpec("department", "Department", TEXT, 2.4)]
    for key, label, kind, width, rag_key in pairs:
        cols.append(ColumnSpec(key, label, kind, width))
        cols.append(ColumnSpec(rag_key, "RAG", BADGE, 0.75))
    cols.append(ColumnSpec("redFlags", "Red flags", INTEGER, 0.8))
    return tuple(cols)


COLUMNS = _metric_columns()
RAG_KEYS = (
    "attendanceRag",
    "absenteeismRag",
    "lateRag",
    "overtimeRag",
    "costRag",
    "attritionRag",
    "teaRag",
    "outpassRag",
)


def _per_head(amount: float | None, heads: int) -> float | None:
    return amount / heads if amount is not None and heads else None


def _payroll_by_name(departments: list[dict]) -> dict[str, float | None]:
    """Payroll cost per head by department name: the page's figure for a department, and gross pay over people paid
    for a name that several units use."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for d in departments:
        groups[dept_name(d["name"])].append(d)
    out: dict[str, float | None] = {}
    for name, rows in groups.items():
        if len(rows) == 1:
            out[name] = rows[0]["costPerHead"]
        else:
            heads = sum(r["headcount"] for r in rows)
            out[name] = round(sum(r["grossPay"] for r in rows) / heads, 2) if heads else None
    return out


def _run(ctx) -> ReportResult:
    today = ctx.today
    scope = scope_from(ctx)
    asked = period_between(ctx.date_from, ctx.date_to)
    through = S.clamp_to_today(asked, today)

    # attendance, overtime, attrition, tea breaks, outpasses: the period; payroll: the latest closed month
    attendance = S.attendance_view(scope, asked, today)
    company_att = ATT.summary_for(scope, asked, today)["metrics"] if attendance.measured else {}
    wf = EMP.load(scope, today)
    groups = S.people_by_department(wf)
    flows = {name: EMP.flow(people, through) for name, people in groups.items()}
    company_flow = EMP.flow(wf.people, through)
    active = {name: sum(1 for p in people if p.active) for name, people in groups.items()}
    active_total = sum(active.values())
    with param_errors("dateFrom"):
        pay_ctx = S.payroll_context(scope, None, today)
        pay_month = f"{pay_ctx.ym[0]:04d}-{pay_ctx.ym[1]:02d}" if pay_ctx.ym else None
        pay_summary = PAY.payroll_summary(scope, pay_month) if pay_month else None
        cost = _payroll_by_name(S.payroll_departments(pay_ctx))
        tea = S.tea_groups(scope, asked)
        tea_company = TEA.tea_summary(scope, asked)["metrics"]["overrunPct"]["value"]
        passes = S.outpass_groups(scope, asked, today)
        pass_company = VIS.summary(scope, asked)["outpass"]["minutesOut"]["value"]

    base_att = company_att.get("attendancePct", {}).get("value")
    base_abs = company_att.get("absenteeismPct", {}).get("value")
    base_late = company_att.get("latePct", {}).get("value")
    company_ot = company_att.get("overtimeHours", {}).get("value")
    tracked = attendance.overtime_tracked and company_ot is not None
    company_cost = pay_summary["totals"]["costPerHead"] if pay_summary and pay_summary["totals"] else None
    company_pass_hours = round(pass_company / 60, 2) if pass_company is not None else None

    names = set(attendance.departments) | set(cost) | set(tea) | set(passes)
    names |= {n for n, f in flows.items() if f.opening or f.closing or f.joiners or f.leavers}
    rows = []
    for name in names:
        a, flow, heads = attendance.departments.get(name), flows.get(name), active.get(name, 0)
        enough_days = bool(a) and a["scheduledDays"] >= MIN_SCHEDULED_DAYS
        ot = a["overtimeHours"] if a and tracked else None
        t = tea.get(name)
        p = passes.get(name)
        # a department with people and no pass has lost no outpass time; a pass nobody scanned back in has no length
        pass_hours = (
            (round(p["minutesOut"] / 60, 2) if p["minutesOut"] is not None else None) if p else (0.0 if heads else None)
        )
        row = {
            "department": name,
            "attendancePct": a["attendancePct"] if a else None,
            "attendanceRag": rag_points_below(a["attendancePct"], base_att) if enough_days else None,
            "absenteeismPct": a["absenteeismPct"] if a else None,
            "absenteeismRag": rag_ratio_above(a["absenteeismPct"], base_abs) if enough_days else None,
            "latePct": a["latePct"] if a else None,
            "lateRag": rag_ratio_above(a["latePct"], base_late) if enough_days else None,
            "overtimeHours": ot,
            "overtimeRag": rag_ratio_above(
                _per_head(ot, heads), _per_head(company_ot if tracked else None, active_total)
            ),
            "costPerHead": cost.get(name),
            "costRag": rag_ratio_above(cost.get(name), company_cost),
            "attritionPct": flow.attrition if flow else None,
            "attritionRag": rag_ratio_above(flow.attrition, company_flow.attrition)
            if flow and flow.average is not None and flow.average >= MIN_TEAM_FOR_ATTRITION
            else None,
            "teaOverrunPct": t["overrunPct"] if t else None,
            "teaRag": rag_ratio_above(t["overrunPct"], tea_company) if t and not t["lowSample"] else None,
            "outpassHours": pass_hours,
            "outpassRag": rag_ratio_above(_per_head(pass_hours, heads), _per_head(company_pass_hours, active_total)),
        }
        row["redFlags"] = sum(1 for k in RAG_KEYS if row[k] == RAG_RED)
        row["_ambers"] = sum(1 for k in RAG_KEYS if row[k] == RAG_AMBER)
        rows.append(row)
    rows.sort(key=lambda r: (-r["redFlags"], -r["_ambers"], r["department"] == NO_DEPARTMENT, r["department"].lower()))
    for r in rows:
        del r["_ambers"]

    company = {
        "department": "Company",
        "attendancePct": base_att,
        "absenteeismPct": base_abs,
        "latePct": base_late,
        "overtimeHours": company_ot if tracked else None,
        "costPerHead": company_cost,
        "attritionPct": company_flow.attrition,
        "teaOverrunPct": tea_company,
        "outpassHours": company_pass_hours,
    }
    summary = [
        kpi("Departments", len(rows), "integer"),
        kpi("Departments with a Red", sum(1 for r in rows if r["redFlags"]), "integer"),
        kpi("Attendance %", base_att, "percent"),
        kpi("Absenteeism %", base_abs, "percent"),
        kpi("Late %", base_late, "percent"),
        kpi("Overtime hours", company["overtimeHours"], "hours"),
        kpi("Payroll cost per head", company_cost, "currency"),
        kpi("Attrition %", company_flow.attrition, "percent"),
        kpi("Tea-break overrun %", tea_company, "percent"),
        kpi("Outpass hours lost", company_pass_hours, "hours"),
    ]
    notes = distinct(
        [
            f"Period: {fmt_day(asked.start)} to {fmt_day(asked.end)}. Company figures are in the last row; statuses "
            "compare each department with them.",
            rag_thresholds_note(),
            f"Payroll cost per head is for {pay_summary['monthLabel']}, the latest closed month, whatever period is chosen."
            if pay_summary and pay_summary["hasData"]
            else "No payroll has been processed yet, so payroll cost per head is blank.",
            "Overtime hours are those HR has detected or announced (rejected ones are left out); the status compares "
            "hours per head (people on the rolls today) with the company's."
            if tracked
            else "Overtime is not shown: the Compensation feature is switched off in Settings, or none has been "
            "recorded and detection is off.",
            "Outpass hours lost are door-to-door hours of employee-requested passes that were scanned back in (a pass "
            "never scanned back in has no length); the status compares hours per head with the company's.",
            "Attendance is measured over complete days only (today is provisional)."
            if attendance.measured
            else "The period has no completed day yet, so attendance, absenteeism, late and overtime are blank.",
            CAVEAT_COVERAGE,
            CAVEAT_ATTRITION,
            CAVEAT_TEA,
            CAVEAT_PAYROLL,
            CAVEAT_DEPARTMENTS,
            CAVEAT_HEADCOUNT,
            "No departments to show: there are no employees or activity for this selection." if not rows else None,
        ]
    )
    return ReportResult(rows=with_company_row(rows, company, ctx), summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-department-scorecard",
        title="Department Scorecard",
        description="Every department on one page: attendance, absence, lateness, overtime, payroll cost, attrition, "
        "tea-break overruns and outpass time, each with a Red / Amber / Green status against the company.",
        category=CATEGORY,
        icon="Grid3x3",
        tags=("md", "executive", "scorecard", "department", "rag", "attendance", "payroll", "attrition", "tea"),
        landscape=True,  # eighteen columns: eight measures, each with its status
        md_only=True,
        filters=(day_range("lastMonth", "Period", 92), branches("Unit")),
        columns=COLUMNS,
        run=_run,
    )
)
