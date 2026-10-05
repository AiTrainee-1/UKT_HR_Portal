"""Attrition & Hiring Review (``md-attrition-hiring``): who joined, who left and what is being done about it.

Per department: opening headcount, joiners, leavers, closing headcount, attrition %, open positions and resignations
waiting for a decision; a KPI strip for the company; notes on early attrition (people who left within 90 days of
joining) and on departments losing people fastest. The movement is the Employees page's (``employees.flow`` over the
people of each department, so ``opening + joiners - leavers = closing`` holds on every row and attrition is the page's
leavers / average headcount); open positions and pending resignations are the Recruitment page's
(``recruitment.positions`` / ``resignations``).
"""

from __future__ import annotations

from collections import defaultdict

from api.md_portal.analytics import employees as EMP

from ..filters import branches
from ..registry import register
from ..types import INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import (
    CATEGORY,
    CAVEAT_ATTRITION,
    CAVEAT_HEADCOUNT,
    NO_DEPARTMENT,
    day_range,
    distinct,
    fmt_day,
    kpi,
    period_between,
    plural,
    scope_from,
    with_company_row,
)

COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.4),
    ColumnSpec("opening", "Opening headcount", INTEGER, 1.0),
    ColumnSpec("joiners", "Joiners", INTEGER, 0.8),
    ColumnSpec("leavers", "Leavers", INTEGER, 0.8),
    ColumnSpec("closing", "Closing headcount", INTEGER, 1.0),
    ColumnSpec("attritionPct", "Attrition %", PERCENT, 0.9),
    ColumnSpec("openPositions", "Open positions", INTEGER, 0.9),
    ColumnSpec("pendingResignations", "Pending resignations", INTEGER, 1.1),
)
EARLY_NAMES = 5  # how many early leavers the notes name


def _early_note(attrition: dict, leavers: int) -> str:
    early = attrition["early"]
    if not leavers:
        return "Nobody left in this period."
    if not early["count"]:
        return f"None of the {plural(leavers, 'leaver')} left within {EMP.EARLY_EXIT_DAYS} days of joining."
    named = "; ".join(
        f"{i['name']} ({i['department']}, {i['days']} days)"
        for i in early["items"][:EARLY_NAMES]
        if i["days"] is not None
    )
    more = early["count"] - min(len(early["items"]), EARLY_NAMES)
    return (
        f"Early attrition: {early['count']} of {plural(leavers, 'leaver')} ({early['pctOfLeavers']}%) left within "
        f"{EMP.EARLY_EXIT_DAYS} days of joining: {named}" + (f" and {more} more" if more > 0 else "") + "."
    )


def _run(ctx) -> ReportResult:
    scope = scope_from(ctx)
    asked = period_between(ctx.date_from, ctx.date_to)
    cur = S.clamp_to_today(asked, ctx.today)
    if cur.days <= 0:
        return ReportResult(
            rows=[],
            notes=[f"{asked.label} has not started yet (today is {fmt_day(ctx.today)}), so there is nothing to count."],
        )

    wf = EMP.load(scope, ctx.today)
    lookups = wf.lookups
    by_department: dict[int | None, list[EMP.Person]] = defaultdict(list)
    for person in wf.people:
        by_department[person.dept_id].append(person)
    flows = {dept_id: EMP.flow(people, cur) for dept_id, people in by_department.items()}
    company = EMP.flow(wf.people, cur)
    hiring = S.hiring(scope, asked, ctx.today)
    attrition = EMP.attrition(scope, cur, limit=EARLY_NAMES, today=ctx.today)

    dept_ids = {d for d, f in flows.items() if f.opening or f.closing or f.joiners or f.leavers}
    dept_ids |= set(hiring.open_by_dept) | set(hiring.pending_by_dept)
    empty = EMP.flow([], cur)
    rows = []
    for dept_id in dept_ids:
        f = flows.get(dept_id, empty)
        rows.append(
            {
                "department": lookups.dept(dept_id),
                "opening": f.opening,
                "joiners": f.joiners,
                "leavers": f.leavers,
                "closing": f.closing,
                "attritionPct": f.attrition,
                "openPositions": hiring.open_by_dept.get(dept_id, 0),
                "pendingResignations": hiring.pending_by_dept.get(dept_id, 0),
            }
        )
    # highest attrition first, as the Employees page ranks it; a department with no rate (nobody on the rolls) last
    rows.sort(
        key=lambda r: (
            r["attritionPct"] is None,
            -(r["attritionPct"] or 0),
            -r["leavers"],
            r["department"] == NO_DEPARTMENT,
            r["department"].lower(),
        )
    )

    totals = {
        "department": "Company",
        "opening": company.opening,
        "joiners": company.joiners,
        "leavers": company.leavers,
        "closing": company.closing,
        "attritionPct": company.attrition,
        "openPositions": hiring.open_total,
        "pendingResignations": hiring.pending_total,
    }
    summary = [
        kpi("Opening headcount", company.opening, "integer"),
        kpi("Joiners", company.joiners, "integer"),
        kpi("Leavers", company.leavers, "integer"),
        kpi("Closing headcount", company.closing, "integer"),
        kpi("Attrition %", company.attrition, "percent"),
        kpi("Attrition, annualised %", company.annualised, "percent"),
        kpi("Left within 90 days", company.early, "integer"),
        kpi("Open positions", hiring.open_total, "integer"),
        kpi("Pending resignations", hiring.pending_total, "integer"),
    ]
    hotspots = attrition["hotspots"]
    notes = distinct(
        [
            f"Period: {fmt_day(cur.start)} to {fmt_day(cur.end)}"
            + (f" (cut at today, {fmt_day(ctx.today)})" if cur.end < asked.end else "")
            + ". Opening headcount is the number on the rolls the day before the period; closing is on its last day.",
            _early_note(attrition, company.leavers),
            "Hot-spots (attrition at least {factor:g} times the company's, with {leavers}+ leavers): {names}.".format(
                factor=EMP.HOTSPOT_FACTOR,
                leavers=EMP.HOTSPOT_MIN_LEAVERS,
                names=", ".join(f"{h['label']} ({h['attritionPct']}%)" for h in hotspots),
            )
            if hotspots
            else None,
            CAVEAT_ATTRITION,
            "Open positions are job postings whose status is Open (the system has no number-of-openings field). A "
            "resignation is pending until it has been decided; its employee is still on the rolls.",
            f"Only the {hiring.open_listed} oldest of {hiring.open_total} open positions are split by department."
            if hiring.open_listed < hiring.open_total
            else None,
            f"Only the {hiring.pending_listed} longest-waiting of {hiring.pending_total} pending resignations are "
            "split by department."
            if hiring.pending_listed < hiring.pending_total
            else None,
            CAVEAT_HEADCOUNT,
            *attrition["notes"],
            "No employees, open positions or resignations exist for this selection." if not rows else None,
        ]
    )
    return ReportResult(rows=with_company_row(rows, totals, ctx), summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-attrition-hiring",
        title="Attrition & Hiring Review",
        description="By department: opening and closing headcount, joiners, leavers, attrition %, open positions and "
        "resignations waiting, with notes on early attrition.",
        category=CATEGORY,
        icon="UserMinus",
        tags=("md", "executive", "attrition", "hiring", "joiners", "leavers", "resignation", "recruitment"),
        landscape=False,
        md_only=True,
        filters=(day_range("lastMonth", "Period", 366), branches("Unit")),
        columns=COLUMNS,
        run=_run,
    )
)
