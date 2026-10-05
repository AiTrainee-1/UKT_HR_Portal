"""Gate & Discipline Review (``md-gate-discipline``): who comes in, who leaves in the shift and who overruns the break.

By department: visits (counted against the department of the person visited, because a visitor belongs to none),
employee outpass requests, hours lost on outpasses, passes never scanned back in, tea-break overruns, the overrun rate
and the minutes lost. A KPI strip and notes summarise the repeat offenders (employees with many outpasses, employees who
overrun their tea break again and again). The figures are the Outpass & Visitors and Tea Break pages': the company row
is their summaries, the department rows come from the same groupings (see ``md_sources``), and the repeat offenders are
``visitors.exceptions`` and ``tea_break.tea_offenders``. Tea-break loss is in minutes, never rupees, on purpose.
"""

from __future__ import annotations

from api.md_portal.analytics import tea_break as TEA
from api.md_portal.analytics import visitors as VIS

from ..filters import branches
from ..formatting import minutes_text
from ..registry import register
from ..types import HOURS, INTEGER, MINUTES, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import md_sources as S
from .md_common import (
    CATEGORY,
    CAVEAT_DEPARTMENTS,
    CAVEAT_TEA,
    NO_DEPARTMENT,
    day_range,
    distinct,
    fmt_day,
    kpi,
    param_errors,
    period_between,
    plural,
    scope_from,
    with_company_row,
)

NOT_MATCHED = "Host not matched to an employee"
TOP = 3  # repeat offenders named in the notes

COLUMNS = (
    ColumnSpec("department", "Department", TEXT, 2.4),
    ColumnSpec("visits", "Visits to the department", INTEGER, 1.1),
    ColumnSpec("outpasses", "Outpass requests", INTEGER, 1.0),
    ColumnSpec("hoursOut", "Outpass hours lost", HOURS, 1.0),
    ColumnSpec("notReturned", "Passes never returned", INTEGER, 1.1),
    ColumnSpec("teaOverruns", "Tea-break overruns", INTEGER, 1.0),
    ColumnSpec("teaOverrunPct", "Overrun %", PERCENT, 0.9),
    ColumnSpec("teaMinutesLost", "Tea minutes lost", MINUTES, 1.0),
)


def _hours(minutes: int | float | None) -> float | None:
    return None if minutes is None else round(minutes / 60, 2)


def _offender_notes(exceptions: dict, offenders: dict) -> list[str]:
    out: list[str] = []
    repeat = exceptions["repeatOutpass"]
    if repeat["total"]:
        top = "; ".join(
            f"{r['name']} ({r['department']}, {plural(r['passes'], 'pass', 'passes')}, {minutes_text(r['minutesOut'])} out)"
            for r in repeat["rows"][:TOP]
        )
        out.append(
            f"Repeat outpass users ({repeat['minimum']} or more approved passes): {plural(repeat['total'], 'person', 'people')}. "
            f"Most passes: {top}."
        )
    else:
        out.append(f"No one took {repeat['minimum']} or more approved outpasses in this period.")
    if offenders["total"]:
        top = "; ".join(
            f"{r['employeeName']} ({r['department']}, {plural(r['overruns'], 'overrun')}, {r['minutesLost']} minutes lost)"
            for r in offenders["rows"][:TOP]
        )
        share = offenders["shareOfMinutesLostPct"]
        out.append(
            f"Repeat tea-break overrunners ({offenders['threshold']} or more overruns): "
            f"{plural(offenders['total'], 'person', 'people')}"
            + (f", {share}% of the minutes lost" if share is not None else "")
            + f". Most overruns: {top}."
        )
    else:
        out.append(f"No one overran their tea break {offenders['threshold']} or more times in this period.")
    frequent, after = exceptions["frequentVisitors"], exceptions["afterHoursVisits"]
    if frequent["total"]:
        out.append(f"{plural(frequent['total'], 'visitor')} came {frequent['minimum']} or more times.")
    if after["total"]:
        label = exceptions["thresholds"]["afterHours"]["label"]
        out.append(f"{plural(after['total'], 'visit')} {'was' if after['total'] == 1 else 'were'} {label}.")
    waiting = exceptions["approvalsWaiting"]
    if waiting["total"]:
        out.append(
            f"{plural(waiting['total'], 'outpass request')} "
            f"{'has' if waiting['total'] == 1 else 'have'} waited more than {exceptions['thresholds']['approvalWaitHours']} "
            "hours for a decision (a live count across all dates)."
        )
    return out


def _run(ctx) -> ReportResult:
    scope = scope_from(ctx)
    period = period_between(ctx.date_from, ctx.date_to)
    with param_errors("dateFrom"):
        gate = VIS.summary(scope, period)
        tea = TEA.tea_summary(scope, period)
        exceptions = VIS.exceptions(scope, period, limit=TOP)
        offenders = TEA.tea_offenders(scope, period, limit=TOP)
        visits, not_matched, _all_visits = S.visit_groups(scope, period)
        passes = S.outpass_groups(scope, period, ctx.today)
        breaks = S.tea_groups(scope, period)

    rows = []
    for name in set(visits) | set(passes) | set(breaks):
        v, p, t = visits.get(name), passes.get(name), breaks.get(name)
        rows.append(
            {
                "department": name,
                "visits": v["visits"] if v else 0,
                "outpasses": p["requests"] if p else 0,
                "hoursOut": _hours(p["minutesOut"]) if p else 0.0,
                "notReturned": p["notReturned"] if p else 0,
                "teaOverruns": t["overruns"] if t else None,
                "teaOverrunPct": t["overrunPct"] if t else None,
                "teaMinutesLost": t["minutesLost"] if t else None,
            }
        )
    # the worst first: most hours lost, then tea minutes lost, then visits
    rows.sort(
        key=lambda r: (
            r["department"] == NO_DEPARTMENT,
            -(r["hoursOut"] or 0),
            -(r["teaMinutesLost"] or 0),
            -r["visits"],
            r["department"].lower(),
        )
    )
    if not_matched:
        rows.append(
            {
                "department": NOT_MATCHED,
                "visits": not_matched,
                "outpasses": None,
                "hoursOut": None,
                "notReturned": None,
                "teaOverruns": None,
                "teaOverrunPct": None,
                "teaMinutesLost": None,
            }
        )

    out, visitors, metrics = gate["outpass"], gate["visitors"], tea["metrics"]
    company = {
        "department": "Company",
        "visits": visitors["visits"]["value"],
        "outpasses": out["requests"]["value"],
        "hoursOut": _hours(out["minutesOut"]["value"]),
        "notReturned": out["notReturned"]["value"],
        "teaOverruns": metrics["overruns"]["value"],
        "teaOverrunPct": metrics["overrunPct"]["value"],
        "teaMinutesLost": metrics["minutesLost"]["value"],
    }
    summary = [
        kpi("Visits", company["visits"], "integer"),
        kpi("Unique visitors", visitors["uniqueVisitors"]["value"], "integer"),
        kpi("Outpass requests", company["outpasses"], "integer"),
        kpi("Outpass hours lost", company["hoursOut"], "hours"),
        kpi("Passes never returned", company["notReturned"], "integer"),
        kpi("Tea-break overruns", company["teaOverruns"], "integer"),
        kpi("Tea minutes lost", company["teaMinutesLost"], "minutes"),
        kpi("Repeat outpass users", exceptions["repeatOutpass"]["total"], "integer"),
        kpi("Repeat tea-break overrunners", offenders["total"], "integer"),
    ]
    notes = distinct(
        [
            f"Period: {fmt_day(period.start)} to {fmt_day(period.end)}.",
            *_offender_notes(exceptions, offenders),
            "Visits are counted against the department of the person visited (a visitor belongs to none); visits to a "
            "host who could not be matched to an employee are in their own row. Outpasses are the employee-requested "
            "passes counted on the day they were requested; hours lost are door to door, for passes scanned back in. "
            "Tea-break overruns are counted by the employee's department.",
            CAVEAT_TEA,
            CAVEAT_DEPARTMENTS,
            *gate["notes"],
            *tea["notes"],
            "No visits, outpasses or tea-break scans were recorded in this period." if not rows else None,
        ]
    )
    return ReportResult(rows=with_company_row(rows, company, ctx), summary=summary, notes=notes)


SPEC = register(
    ReportSpec(
        id="md-gate-discipline",
        title="Gate & Discipline Review",
        description="Visitors, outpasses, hours lost and tea-break overruns by department, with the repeat offenders "
        "summarised.",
        category=CATEGORY,
        icon="DoorOpen",
        tags=("md", "executive", "gate", "visitors", "outpass", "tea break", "discipline", "overrun"),
        landscape=False,
        md_only=True,
        filters=(day_range("lastMonth", "Period", 92), branches("Unit")),
        columns=COLUMNS,
        run=_run,
    )
)
