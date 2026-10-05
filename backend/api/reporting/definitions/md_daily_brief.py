"""MD Daily Brief (``md-daily-brief``): how the company stands on one day, unit by unit, on one page.

A KPI strip and one row per unit plus a company row: headcount, present, absent, late, attendance %, visitors,
outpasses and tea-break overruns, then a short 'what to look at' list taken from the findings the MD's pages show under
'Needs your attention'. Every figure is the analytics module's own for the same day and unit:

* present / absent / late / attendance % ... ``attendance_on_date`` (the attendance day records; for TODAY the live punch
  count, which is provisional: 'absent' then means 'not in yet' and late is not known until HR computes the day);
* visitors and outpasses ................... ``visitors.summary`` / ``visitors.units`` for the day;
* tea-break overruns ....................... ``tea_break.tea_summary`` / ``tea_departments(by="unit")`` for the day;
* headcount ................................ people on the rolls on that day (``employees.Roll``; for today the active
  employees).
"""

from __future__ import annotations

from datetime import timedelta

from api.md_portal.analytics import attendance as ATT
from api.md_portal.analytics import employees as EMP
from api.md_portal.analytics import tea_break as TEA
from api.md_portal.analytics import visitors as VIS

from ..filters import ReportParamError, branches
from ..registry import register
from ..types import INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import (
    CATEGORY,
    CAVEAT_HEADCOUNT,
    CAVEAT_TEA,
    CAVEAT_VISITORS,
    day_range,
    distinct,
    fmt_day,
    kpi,
    param_errors,
    period_between,
    scope_from,
    sentence,
    unit_name,
    with_company_row,
)

LOOK_AT_ITEMS = 6  # the 'what to look at' list is short on purpose

COLUMNS = (
    ColumnSpec("unit", "Unit", TEXT, 2.0),
    ColumnSpec("headcount", "Headcount", INTEGER, 1.15),
    ColumnSpec("present", "Present", INTEGER, 0.9),
    ColumnSpec("absent", "Absent", INTEGER, 0.9),
    ColumnSpec("late", "Late", INTEGER, 0.8),
    ColumnSpec("attendancePct", "Attendance %", PERCENT, 1.25),
    ColumnSpec("visitors", "Visitors", INTEGER, 0.9),
    ColumnSpec("outpasses", "Outpasses", INTEGER, 1.15),
    ColumnSpec("teaOverruns", "Tea-break overruns", INTEGER, 1.2),
)


def _run(ctx) -> ReportResult:
    day = ctx.date_from
    if day > ctx.today:
        raise ReportParamError(
            f"{fmt_day(day)} has not happened yet: today is {fmt_day(ctx.today)}. Pick today or an earlier day.",
            "dateFrom",
        )
    scope = scope_from(ctx)
    period = period_between(day, day)
    live = day == ctx.today

    with param_errors("dateFrom"):
        att = ATT.attendance_on_date(scope, day, limit=ATT.DEPARTMENT_LIMIT_MAX)
    visitors = VIS.summary(scope, period)
    visitor_units = {unit_name(u["unit"]): u for u in VIS.units(scope, period)["units"]}
    tea = TEA.tea_summary(scope, period)
    tea_units = {
        unit_name(r["label"]): r for r in TEA.tea_departments(scope, period, by="unit", limit=TEA.LIST_MAX)["rows"]
    }
    wf = EMP.load(scope, ctx.today)
    roll_units = {name: EMP.Roll(people) for name, people in S.people_by_unit(wf).items()}
    attendance_units = {unit_name(r["name"]): r for r in att["byUnit"]}
    company_roll = EMP.Roll(wf.people)

    rows: list[dict] = []
    for name in sorted(
        set(roll_units) | set(attendance_units) | set(visitor_units) | set(tea_units),
        key=lambda n: (n == "No unit", n.lower()),
    ):
        a, v, t = attendance_units.get(name), visitor_units.get(name), tea_units.get(name)
        roll = roll_units.get(name)
        headcount = roll.headcount(day) if roll else 0
        row = {
            "unit": name,
            "headcount": headcount,
            "present": a["present"] if a else None,
            "absent": a["absent"] if a else None,
            "late": a.get("late") if a else None,
            "attendancePct": a["attendancePct"] if a else None,
            "visitors": v["visits"] if v else 0,
            "outpasses": v["requests"] if v else 0,
            "teaOverruns": t["overruns"] if t else 0,
        }
        if headcount or a or v or t:
            rows.append(row)

    totals_att = att["totals"]
    company = {
        "unit": "Company",
        "headcount": company_roll.headcount(day),
        "present": totals_att["present"] if totals_att["expected"] or totals_att["present"] else None,
        "absent": totals_att["absent"] if totals_att["expected"] or totals_att["absent"] else None,
        "late": totals_att.get("late"),
        "attendancePct": totals_att["attendancePct"],
        "visitors": visitors["visitors"]["visits"]["value"],
        "outpasses": visitors["outpass"]["requests"]["value"],
        "teaOverruns": tea["metrics"]["overruns"]["value"],
    }
    summary = [
        kpi("Headcount", company["headcount"], "integer"),
        kpi("Present", company["present"], "integer"),
        kpi("Absent", company["absent"], "integer"),
        kpi("Late", company["late"], "integer"),
        kpi("Attendance %", company["attendancePct"], "percent"),
        kpi("Visitors", company["visitors"], "integer"),
        kpi("Outpasses", company["outpasses"], "integer"),
        kpi("Tea-break overruns", company["teaOverruns"], "integer"),
    ]

    look_at = S.attention_items(scope, period_between(day - timedelta(days=29), day), ctx.today)[:LOOK_AT_ITEMS]
    notes = distinct(
        [
            *att["notes"],
            "Present counts full and half days; absent is a day marked absent on a scheduled working day (approved "
            "leave, weekly offs and holidays are not absence). Late arrivals are the days the attendance engine flagged."
            if not live
            else None,
            "Headcount is the number of active employees today."
            if live
            else f"Headcount is the number on the rolls on {fmt_day(day)}. {CAVEAT_HEADCOUNT}",
            f"Visitors are counted by the unit whose gate QR they used; outpasses and tea-break overruns by the "
            f"employee's unit. {CAVEAT_VISITORS} {CAVEAT_TEA}",
            "Today is provisional: present is people who have punched in so far and absent is people not in yet, not "
            "the final day. Today's tea-break figures are partial too: breaks still in progress are not measured yet."
            if live
            else None,
            "There are no employees on record for this selection, so there is nothing to report." if not rows else None,
            *(f"To look at: {sentence(i['title'], i.get('detail'))}" for i in look_at),
        ]
    )
    return ReportResult(rows=with_company_row(rows, company, ctx), summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-daily-brief",
        title="MD Daily Brief",
        description="One page for one day: headcount, attendance, visitors, outpasses and tea-break overruns by unit.",
        category=CATEGORY,
        icon="CalendarCheck",
        tags=("md", "executive", "daily", "brief", "today", "attendance", "visitors", "outpass"),
        landscape=False,
        md_only=True,
        filters=(
            day_range(
                "today",
                "Date",
                1,
                "One day. Today is provisional: it shows who has punched in so far, not final attendance.",
            ),
            branches("Unit"),
        ),
        columns=COLUMNS,
        run=_run,
    )
)
