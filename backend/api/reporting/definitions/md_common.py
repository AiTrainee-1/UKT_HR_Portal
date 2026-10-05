"""Shared building blocks of the Managing Director's executive reports (category ``md``, ``ReportSpec.md_only``).

The seven reports of the pack (see ``md_executive``) are one-page summaries for the MD alone. They do no arithmetic of
their own on the company's data: every figure comes from the MD portal's analytics modules (``md_portal/analytics``),
through the adapters in ``md_sources``, so a number in a report equals the same number on the MD's page and in the
assistant for the same period and scope. What lives here is what the reports have in common: the unit / department
filters and the ``Scope`` they make, period handling, the standard data caveats printed under every report, the RAG
rules of the Department Scorecard and a few formatting helpers.

Nothing in this package writes: the reports run on GET, and the analytics underneath are read-only.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date
from typing import Any, Iterable, Iterator

from api.branch_scope import get_branch_scope
from api.md_portal.common import MdParamError, Period, Scope, resolve_period
from api.models import Branch, Department

from ..filters import ReportParamError
from ..formatting import indian_number
from ..runner import KIND_TOTAL
from ..types import F_DATE_RANGE, FilterSpec

CATEGORY = "md"
NO_DEPARTMENT = "No department"
NO_UNIT = "No unit"

# ── RAG rules of the Department Scorecard (printed under the report, so the MD can read the rule that coloured a cell) ──
RAG_RED, RAG_AMBER, RAG_GREEN = "Red", "Amber", "Green"
ATTENDANCE_AMBER_POINTS = 1.0  # attendance: this many percentage points under the company's = Amber ...
ATTENDANCE_RED_POINTS = 3.0  # ... and this many = Red (the same gap the Attendance page flags a department at)
RATIO_AMBER = 1.2  # everything where lower is better: this multiple of the company's figure = Amber ...
RATIO_RED = 1.5  # ... and this multiple = Red
MIN_SCHEDULED_DAYS = 20  # fewer scheduled employee-days than this and an attendance rate is noise: no status
MIN_TEAM_FOR_ATTRITION = 10  # attrition of a team smaller than this (average headcount) is noise: no status
MIN_BREAKS_FOR_TEA = 20  # fewer measured breaks than this and an overrun rate is noise: no status

# ── caveats every report states (the same words, so the MD reads one definition everywhere) ────────────────────────
CAVEAT_TODAY = (
    "Today is provisional: the day is still running, so it is left out of attendance rates (a report says where it "
    "shows who has punched in so far instead)."
)
CAVEAT_COVERAGE = (
    "Attendance figures cover the days HR has processed: day records are created when HR opens Attendance or runs "
    "payroll, so a recent or unopened day may be missing."
)
CAVEAT_HEADCOUNT = (
    "The system keeps no headcount history: headcount on a past date is rebuilt from join and exit dates, and people "
    "are counted in the department and unit they belong to today."
)
CAVEAT_ATTRITION = (
    "Attrition % = leavers divided by the average of the opening and closing headcount. It is not scaled to a year "
    "unless it says annualised (only for periods of 28 days or more)."
)
CAVEAT_PAYROLL = (
    "Money is read from the salary slips (the paid record: what each person was actually paid), by each person's "
    "current department. The latest month may not be closed yet."
)
CAVEAT_VISITORS = "Visitors are recorded at check-in only (there is no check-out), so time on site cannot be shown."
CAVEAT_TEA = (
    "Tea-break loss is in minutes, not rupees: the system cannot say what a lost minute costs. Only breaks of 60 "
    "minutes or less that were scanned back in are measured."
)
CAVEAT_DEPARTMENTS = "A department name used in several units is one department of the company."


# ── filters ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def day_range(default: str, label: str, max_days: int, help: str | None = None) -> FilterSpec:  # noqa: A002
    """The framework's date-range filter with a help line (``filters.date_range`` takes none)."""
    return FilterSpec("dateRange", F_DATE_RANGE, label, default=default, required=True, max_days=max_days, help=help)


# ── scope and period ─────────────────────────────────────────────────────────────────────────────────────────────────
def scope_from(ctx) -> Scope:
    """The analytics ``Scope`` for the unit / department filters of a report.

    The MD is company-wide (the middleware never gives this account a branch), so branch isolation is not what limits
    these reports; it is still honoured here, so that if a branch-limited user were ever allowed to run one they could
    not read another branch's people."""
    branch_ids = tuple(ctx.params.get("branch_ids") or ())
    department_ids = tuple(ctx.params.get("department_ids") or ())
    only = get_branch_scope(ctx.request)
    if only is not None:
        branch_ids = tuple(b for b in branch_ids if b == only) or (only,)
    labels: dict[str, str] = {}
    if branch_ids:
        names = Branch.objects.filter(id__in=branch_ids).order_by("name").values_list("name", flat=True)
        labels["branch"] = ", ".join(names)
    if department_ids:
        names = Department.objects.filter(id__in=department_ids).order_by("name").values_list("name", flat=True)
        labels["department"] = ", ".join(sorted(set(names)))
    return Scope(branch_ids=branch_ids, department_ids=department_ids, labels={k: v for k, v in labels.items() if v})


def period_between(start: date, end: date) -> Period:
    """The analytics ``Period`` for two dates (inclusive), with the label the pages use."""
    with param_errors("dateFrom"):
        return resolve_period({"from": start.isoformat(), "to": end.isoformat()})


@contextmanager
def param_errors(field: str | None = None) -> Iterator[None]:
    """An analytics module refusing a parameter (``MdParamError``) is the report's 400, with the module's own words."""
    try:
        yield
    except MdParamError as exc:
        raise ReportParamError(str(exc), field) from exc


def dept_name(value: Any) -> str:
    """One name for 'no department' (the analytics modules each spell it their own way)."""
    text = value.strip() if isinstance(value, str) else ""
    return NO_DEPARTMENT if text in ("", "Unassigned", NO_DEPARTMENT) else text


def unit_name(value: Any) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text or NO_UNIT


# ── small value helpers ──────────────────────────────────────────────────────────────────────────────────────────────
def delta(current: float | int | None, previous: float | int | None, digits: int = 1) -> float | int | None:
    """current - previous, ``None`` when either side is missing (never 0 for 'no data')."""
    if current is None or previous is None:
        return None
    return round(current - previous, digits)


def kpi(label: str, value: Any, fmt: str) -> dict:
    return {"label": label, "value": value, "format": fmt}


def fmt_day(day: date) -> str:
    return f"{day.day:02d} {day.strftime('%b')} {day.year}"


def fmt_short(day: date | str) -> str:
    """'2026-09-09' -> '09 Sep'."""
    d = date.fromisoformat(day) if isinstance(day, str) else day
    return f"{d.day:02d} {d.strftime('%b')}"


def inr(value: float | int | None) -> str:
    """₹ with lakh / crore grouping, paise only when there are some."""
    if value is None:
        return "n/a"
    amount = float(value)
    return "₹" + indian_number(amount, 0 if round(amount, 2) == round(amount) else 2)


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def clip(rows: list[dict], ctx) -> list[dict]:
    """Honour ``ctx.row_limit`` (the runner flags a result longer than the limit instead of hiding it)."""
    return rows[: ctx.row_limit]


def with_company_row(rows: list[dict], company: dict, ctx) -> list[dict]:
    """The data rows (within ``ctx.row_limit``) closed by the company's own figures as a styled TOTAL line. Company
    percentages and averages are not sums of the rows above them, so they cannot come from a totals row computed by
    the exporter; a structural row of the report's own keeps its label, is bold on screen and in both files, never
    counts against the row limit and is left alone by sorting. No data rows, no company line."""
    data = clip(rows, ctx)
    return [*data, {**company, "_kind": KIND_TOTAL}] if data and company else data


def distinct(lines: Iterable[str | None]) -> list[str]:
    """Notes in order, empties and repeats dropped."""
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        text = (line or "").strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def sentence(title: str, detail: str | None = None) -> str:
    """'Title. Detail.' with exactly one full stop between and after."""
    head = title.strip().rstrip(".")
    tail = (detail or "").strip()
    return f"{head}. {tail}" if tail else f"{head}."


# ── the RAG rules (a pure function each, so the thresholds are tested at their edges) ────────────────────────────────
def rag_points_below(value: float | None, company: float | None) -> str | None:
    """Higher is better (attendance %): Red when 3 or more points under the company's, Amber from 1 point."""
    if value is None or company is None:
        return None
    gap = round(company - value, 1)
    if gap >= ATTENDANCE_RED_POINTS:
        return RAG_RED
    if gap >= ATTENDANCE_AMBER_POINTS:
        return RAG_AMBER
    return RAG_GREEN


def rag_ratio_above(value: float | None, company: float | None) -> str | None:
    """Lower is better: the figure as a multiple of the company's. Red from 1.5x, Amber from 1.2x. With no company
    figure to compare with (missing, or zero) there is no status."""
    if value is None or company is None or company <= 0:
        return None
    ratio = round(value / company, 6)
    if ratio >= RATIO_RED:
        return RAG_RED
    if ratio >= RATIO_AMBER:
        return RAG_AMBER
    return RAG_GREEN


def rag_thresholds_note() -> str:
    return (
        "Status (Red / Amber / Green) compares each department with the company figure. Attendance %: Amber from "
        f"{ATTENDANCE_AMBER_POINTS:g} point under the company's, Red from {ATTENDANCE_RED_POINTS:g} points under. "
        "Where lower is better (absenteeism %, late %, attrition %, tea-break overrun %, and overtime hours, payroll "
        f"cost and outpass hours per head): Amber from {RATIO_AMBER:g} times the company figure, Red from "
        f"{RATIO_RED:g} times. A dash means no status: too little data (under {MIN_SCHEDULED_DAYS} scheduled days for "
        f"attendance, absenteeism and late; under {MIN_BREAKS_FOR_TEA} measured breaks for tea; a team averaging under "
        f"{MIN_TEAM_FOR_ATTRITION} people for attrition) or a company figure of zero."
    )
