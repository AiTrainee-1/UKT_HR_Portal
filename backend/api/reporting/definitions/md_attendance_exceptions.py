"""Attendance Exceptions (``md-attendance-exceptions``): the people the MD may need to speak to, with the evidence.

Three lists in one table, most urgent first: long unexplained absences (possible absconding), chronic absentees and
habitual late-comers. Each person row carries the days and dates behind the finding. The rules, the counting and the
people are the Attendance page's ``attendance_exceptions`` for the same period and scope (the thresholds are printed
in the notes). Each list is capped (the 'People per list' filter, at most 25) and the notes say when it is cut and how
many there are in all.
"""

from __future__ import annotations

from api.md_portal.analytics import attendance as ATT

from ..filters import branches, departments, number
from ..registry import register
from ..types import INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .md_common import (
    CATEGORY,
    CAVEAT_COVERAGE,
    CAVEAT_TODAY,
    clip,
    day_range,
    distinct,
    fmt_short,
    kpi,
    param_errors,
    period_between,
    plural,
    scope_from,
)

LONG = "Long unexplained absence"
CHRONIC = "Chronic absentee"
LATE = "Habitual late-comer"
DEFAULT_PER_LIST = 15

COLUMNS = (
    ColumnSpec("finding", "Finding", TEXT, 1.6),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 1.8),
    ColumnSpec("department", "Department", TEXT, 1.55),
    ColumnSpec("unit", "Unit", TEXT, 1.1),
    ColumnSpec("days", "Days", INTEGER, 0.6),
    ColumnSpec("outOf", "Out of days", INTEGER, 0.8),
    ColumnSpec("ratePct", "Rate %", PERCENT, 1.0),
    ColumnSpec("evidence", "Evidence", TEXT, 3.2),
)


def _dates(values: list[str]) -> str:
    return ", ".join(fmt_short(d) for d in values)


def _person(p: dict, finding: str, **cells) -> dict:
    return {
        "finding": finding,
        "employeeCode": p["code"],
        "employeeName": p["name"],
        "department": p["department"],
        "unit": p["unit"],
        **cells,
    }


def _long_row(p: dict) -> dict:
    evidence = f"Absent {fmt_short(p['from'])} to {fmt_short(p['to'])}"
    evidence += ", still absent on the last recorded day" if p["ongoing"] else ""
    evidence += (
        f"; last at work {fmt_short(p['lastWorked'])}" if p.get("lastWorked") else "; no day at work in the period"
    )
    return _person(p, LONG, days=p["streakDays"], outOf=None, ratePct=None, evidence=evidence)


def _chronic_row(p: dict) -> dict:
    dates = p["dates"]
    evidence = f"Absent {_dates(dates)}" + (
        f" and {p['absentDays'] - len(dates)} more" if p["absentDays"] > len(dates) else ""
    )
    evidence += f"; {p['informedDays']} of them informed in advance" if p["informedDays"] else ""
    return _person(
        p, CHRONIC, days=p["absentDays"], outOf=p["scheduledDays"], ratePct=p["absentPct"], evidence=evidence
    )


def _late_row(p: dict) -> dict:
    dates = p["dates"]
    evidence = f"Late {_dates(dates)}" + (
        f" and {p['lateDays'] - len(dates)} more" if p["lateDays"] > len(dates) else ""
    )
    evidence += f"; {p['avgLateMinutes']:g} minutes late on average" if p.get("avgLateMinutes") is not None else ""
    return _person(p, LATE, days=p["lateDays"], outOf=p["workedDays"], ratePct=p["latePct"], evidence=evidence)


def _run(ctx) -> ReportResult:
    scope = scope_from(ctx)
    period = period_between(ctx.date_from, ctx.date_to)
    per_list = int(ctx.param("perList", DEFAULT_PER_LIST))
    with param_errors("dateFrom"):
        found = ATT.attendance_exceptions(scope, period, limit=per_list)

    blocks = (
        (LONG, found["longAbsences"], _long_row),
        (CHRONIC, found["chronicAbsentees"], _chronic_row),
        (LATE, found["habitualLate"], _late_row),
    )
    rows: list[dict] = []
    capped: list[str] = []
    for label, block, make in blocks:
        rows.extend(make(p) for p in block["rows"])
        if block["total"] > len(block["rows"]):
            capped.append(f"{label.lower()}s: showing {len(block['rows'])} of {block['total']}")
    rows = clip(rows, ctx)

    long_block = found["longAbsences"]
    still_absent = found["counts"].get("ongoingAbsences", 0) if found["counts"] else 0
    summary = [
        kpi("Long unexplained absences", long_block["total"], "integer"),
        kpi("Still absent on the last recorded day", still_absent, "integer"),
        kpi("Chronic absentees", found["chronicAbsentees"]["total"], "integer"),
        kpi("Habitual late-comers", found["habitualLate"]["total"], "integer"),
    ]
    th = found["thresholds"]
    notes = distinct(
        [
            "Rules: a long unexplained absence is {la} or more absences in a row that nobody explained (a weekly off or "
            "holiday between two absences does not break the run); a chronic absentee has {ca} or more unplanned "
            "absence days and at least {cap:g}% of their scheduled days; a habitual late-comer was late on {hl} or more "
            "days and on at least {hlp:g}% of the days they worked. Days is the count behind the finding, out of the "
            "scheduled days (absent) or the days worked (late).".format(
                la=th["longAbsence"]["minDays"],
                ca=th["chronicAbsent"]["minDays"],
                cap=th["chronicAbsent"]["minPctOfScheduledDays"],
                hl=th["habitualLate"]["minDays"],
                hlp=th["habitualLate"]["minPctOfWorkedDays"],
            ),
            ("Each list is capped at " + plural(per_list, "person", "people") + " (" + "; ".join(capped) + ").")
            if capped
            else None,
            "No one met these rules in this period." if not rows else None,
            "Dates shown are the most recent ones (up to 8 per person). Approved leave is not absence.",
            CAVEAT_TODAY,
            CAVEAT_COVERAGE,
            *found["notes"],
        ]
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-attendance-exceptions",
        title="Attendance Exceptions",
        description="People with long unexplained absences, chronic absence or habitual lateness, with the days and "
        "dates behind each finding.",
        category=CATEGORY,
        icon="TriangleAlert",
        tags=("md", "executive", "attendance", "absent", "late", "absconding", "exceptions", "chronic"),
        landscape=False,
        md_only=True,
        filters=(
            day_range("lastMonth", "Period", 92),
            branches("Unit"),
            departments(),
            number(
                "perList",
                "People per list",
                default=DEFAULT_PER_LIST,
                min=5,
                max=ATT.LIST_LIMIT_MAX,
                help="How many people to list under each finding (at most 25).",
            ),
        ),
        columns=COLUMNS,
        run=_run,
    )
)
