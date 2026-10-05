"""Adapters between the executive reports and the MD portal's analytics modules.

Why a layer at all: a report has to show EVERY department, with the same fields side by side, while several analytics
functions are shaped for a page (a ranked list capped at 25, or a row without one of the figures a report prints). The
adapters below ask the modules' own building blocks for the uncapped, grouped rows, so a report row is made by the same
code that makes the page row; they never recompute a rule. Where a module has a public function that already gives the
whole answer (summaries, exceptions, offenders) the reports call that function directly.

Two kinds of reliance, both listed so the day a module exposes an uncapped public function this file is the only one to
change (``tests_md_reports`` pins each adapter to the public function it mirrors, so a drift is caught):

* public names of the modules: ``attendance.frame_for`` / ``department_rows``, ``employees.load`` / ``flow`` / ``Roll``;
* module-private helpers that the page's own function is built from: ``tea_break._breaks`` / ``_measures`` /
  ``_figures`` / ``_context``, ``visitors._pass_rows`` / ``_facts`` / ``_by_department`` / ``_visit_qs`` /
  ``_host_breakdown`` / ``_clock``, ``payroll._context`` / ``_departments`` / ``_agg_rows``.

Every function here only reads.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from django.db.models import F

from api.md_portal.analytics import attendance as ATT
from api.md_portal.analytics import employees as EMP
from api.md_portal.analytics import payroll as PAY
from api.md_portal.analytics import recruitment as REC
from api.md_portal.analytics import tea_break as TEA
from api.md_portal.analytics import visitors as VIS
from api.md_portal.common import Period, Scope

from .md_common import NO_DEPARTMENT, dept_name

SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ── attendance ───────────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class AttendanceView:
    """The attendance figures of a period by department, as the Attendance page ranks them (complete days only)."""

    measured: Period | None  # the complete days of the period (None: not one has finished)
    previous: Period | None
    baseline: dict | None  # the company's attendancePct / absenteeismPct / latePct
    departments: dict[str, dict]  # name -> the page's department row (see attendance.department_rows)
    overtime_tracked: bool  # False: the Compensation feature is off, so overtime hours mean nothing
    scheduled_days: int  # scheduled employee-days that have a day record


def attendance_view(scope: Scope, period: Period, today: date) -> AttendanceView:
    frame, win = ATT.frame_for(scope, period, today)
    tracked = bool(getattr(frame.settings, "compensation_feature_enabled", True))
    if win.measured is None:
        return AttendanceView(None, None, None, {}, tracked, 0)
    data = ATT.department_rows(frame, win)
    departments = {dept_name(row["name"]): row for row in data["departments"]}
    return AttendanceView(win.measured, win.previous, data["baseline"], departments, tracked, data["rows"])


# ── people: headcount, joiners, leavers ──────────────────────────────────────────────────────────────────────────────
def clamp_to_today(period: Period, today: date) -> Period:
    """A period never reaches past today (the Employees page's rule); one that has not started is empty (days == 0)."""
    if period.end <= today:
        return period
    return Period(period.start, max(today, period.start - timedelta(days=1)), period.preset, period.label)


def people_by_department(wf: EMP.Workforce) -> dict[str, list[EMP.Person]]:
    """Everyone in scope (leavers too) grouped by department NAME: a name used in several units is one department."""
    names = {dept_id: name for dept_id, (name, _unit) in wf.lookups.departments.items()}
    groups: dict[str, list[EMP.Person]] = defaultdict(list)
    for person in wf.people:
        groups[dept_name(names.get(person.dept_id) if person.dept_id else None)].append(person)
    return dict(groups)


def people_by_unit(wf: EMP.Workforce) -> dict[str, list[EMP.Person]]:
    groups: dict[str, list[EMP.Person]] = defaultdict(list)
    for person in wf.people:
        groups[wf.lookups.unit(person.branch_id)].append(person)
    return dict(groups)


# ── tea breaks (every group, not the page's top 25) ──────────────────────────────────────────────────────────────────
def tea_groups(scope: Scope, period: Period, by: str = "department") -> dict[str, dict]:
    """Tea-break figures per department (or unit), keyed by name: what ``tea_departments`` ranks, without its cap.
    A row is ``tea_break._figures`` plus ``lowSample``; a department nobody scanned in has no row (no rate exists)."""
    log_field, _emp_field, none_label = TEA._GROUPS[by]
    allowed, _rule_at, now = TEA._context()
    rows = TEA._breaks(scope, period.start, period.end).values(grp=F(log_field)).annotate(**TEA._measures(allowed, now))
    out: dict[str, dict] = {}
    for raw in rows.order_by():
        label = none_label if raw["grp"] is None or raw["grp"] == "" else str(raw["grp"])
        figures = TEA._figures(raw, allowed)
        out[dept_name(label) if by == "department" else label] = {
            **figures,
            "lowSample": figures["measured"] < TEA.MIN_SAMPLE_BREAKS,
        }
    return out


# ── outpasses and visitors (every department, not the page's top 25) ─────────────────────────────────────────────────
def outpass_groups(scope: Scope, period: Period, today: date) -> dict[str, dict]:
    """Employee-requested outpasses per department name: what ``outpass_breakdown`` ranks, without its cap. A row has
    requests, returned, notReturned, minutesOut (None until a pass has been scanned back in) and headcount."""
    now, today_ = VIS._clock(today)
    facts, _on_duty = VIS._facts(VIS._pass_rows(scope, period), now, today_)
    rows = VIS._by_department(facts, VIS._headcount_by_department(scope))
    return {dept_name(row["department"]): row for row in rows}


def visit_groups(scope: Scope, period: Period) -> tuple[dict[str, dict], int, int]:
    """(visits by the DEPARTMENT OF THE PERSON VISITED, visits to a host who could not be matched to an employee, all
    visits). A visitor belongs to no department; the host does. Uncapped version of ``visitors_breakdown``."""
    qs = VIS._visit_qs(scope, period)
    total = VIS._visit_totals(qs)["visits"]
    departments, not_linked, _hosts = VIS._host_breakdown(qs, total, 1)
    return {dept_name(d["department"]): d for d in departments}, not_linked["visits"], total


# ── payroll ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def payroll_context(scope: Scope, month: str | None, today: date) -> PAY._Ctx:
    """The month a payroll report is about: the one asked for, else the latest CLOSED month (ended, has slips)."""
    return PAY._context(scope, month, today)


def payroll_departments(ctx: PAY._Ctx) -> list[dict]:
    """The Payroll page's department rows for the month, all of them, each with the month's total deductions (the
    page's row has none). Empty when no payroll exists for the month."""
    if ctx.ym is None:
        return []
    page = PAY._departments(ctx, 10_000)
    deductions = {
        row["employee__department_id"]: PAY._figures(PAY._raw(row))["totalDeductions"]
        for row in PAY._agg_rows(ctx.scope, [ctx.ym], ("dept",))
    }
    return [{**d, "totalDeductions": deductions.get(d["id"])} for d in page["departments"]]


# ── hiring: open positions and resignations waiting ──────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Hiring:
    open_by_dept: Counter  # department id -> open positions
    open_total: int
    open_listed: int  # postings the page lists (it caps the list): below open_total means the split is partial
    pending_by_dept: Counter  # department id -> resignations waiting for a decision
    pending_total: int
    pending_listed: int


def hiring(scope: Scope, period: Period, today: date) -> Hiring:
    positions = REC.positions(scope, limit=REC.MAX_LIST, today=today)
    resignations = REC.resignations(scope, period, limit=25, today=today)
    return Hiring(
        open_by_dept=Counter(p["departmentId"] for p in positions["positions"]),
        open_total=positions["summary"]["open"],
        open_listed=positions["positionsShown"],
        pending_by_dept=Counter(p["departmentId"] for p in resignations["pending"]),
        pending_total=resignations["summary"]["pending"],
        pending_listed=resignations["pendingShown"],
    )


# ── "what to look at" ────────────────────────────────────────────────────────────────────────────────────────────────
def attention_items(scope: Scope, period: Period, today: date) -> list[dict]:
    """The findings the pages list under 'Needs your attention' for this scope and period (attendance, gate, tea
    break, recruitment, workforce), most severe first and in module order within a severity. Good news is left out."""
    groups = (
        ATT.attendance_exceptions(scope, period, limit=1)["attention"],
        VIS.exceptions(scope, period, limit=1)["attention"],
        TEA.tea_attention(scope, period)["items"],
        REC.attention(scope, period, today=today)["items"],
        EMP.exceptions(scope, period, today=today)["items"],
    )
    items = [item for group in groups for item in group if item.get("severity") != "good"]
    items.sort(key=lambda item: SEVERITY_RANK.get(item.get("severity"), len(SEVERITY_RANK)))
    return items


__all__ = [
    "NO_DEPARTMENT",
    "AttendanceView",
    "Hiring",
    "attendance_view",
    "attention_items",
    "clamp_to_today",
    "hiring",
    "outpass_groups",
    "payroll_context",
    "payroll_departments",
    "people_by_department",
    "people_by_unit",
    "tea_groups",
    "visit_groups",
]
