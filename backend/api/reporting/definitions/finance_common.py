"""Helpers shared by the finance report definitions (advances, bonus, increments, promotions).

This module registers no reports; ``finance_advances`` and ``finance_growth`` import from it.

Why a "period" *select* instead of a date-range filter: the framework pre-fills every date-range
filter with a concrete range in the UI (an optional range still opens as "this month"), which would
make a ledger or a history register open on an almost empty page. A select whose default is "All
time" opens on the full register, and its relative windows (this month ... last financial year)
cover the way HR and payroll actually ask for these figures.
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Iterable

from django.db.models import Q

from api.clock import FACTORY_TZ

from ..filters import ReportContext, select
from ..formatting import display_date, month_bounds
from ..runner import KIND_SUBTOTAL
from ..types import FilterSpec

# Indian financial year, April to March. (Bonus rows carry their own FY label; this constant is only
# used for the relative "financial year" windows and the FY filter on increments / promotions.)
FY_START_MONTH = 4

WINDOW_OPTIONS: tuple[tuple[str, str], ...] = (
    ("thisMonth", "This month"),
    ("lastMonth", "Last month"),
    ("last3", "Last 3 months (incl. this month)"),
    ("last6", "Last 6 months (incl. this month)"),
    ("last12", "Last 12 months (incl. this month)"),
    ("thisFY", "This financial year (Apr-Mar)"),
    ("lastFY", "Last financial year (Apr-Mar)"),
    ("thisYear", "This calendar year"),
    ("lastYear", "Last calendar year"),
)


def _fy_label(start_year: int) -> str:
    return f"{start_year}-{str(start_year + 1)[-2:]}"


# Newest first. A generous fixed range: options must be static, and the filter is optional, so a
# financial year outside the list is still reachable through "All".
FY_OPTIONS: tuple[tuple[str, str], ...] = tuple(
    (_fy_label(y), f"FY {_fy_label(y)}") for y in range(2045, 2009, -1)
)


def window_filter(key: str, label: str, help: str | None = None) -> FilterSpec:
    return select(key, label, WINDOW_OPTIONS, placeholder="All time", help=help)


def financial_year_filter(label: str = "Financial year", multi: bool = False, help: str | None = None) -> FilterSpec:
    return select("financialYear", label, FY_OPTIONS, multi=multi, placeholder="All financial years", help=help)


# ── date windows ────────────────────────────────────────────────────────────

def add_months(first_of_month: date, n: int) -> date:
    """First day of the month ``n`` months after (or before, n < 0) the given month."""
    idx = first_of_month.year * 12 + (first_of_month.month - 1) + n
    return date(idx // 12, idx % 12 + 1, 1)


def fy_start_year(d: date) -> int:
    return d.year if d.month >= FY_START_MONTH else d.year - 1


def fy_bounds(label: str) -> tuple[date, date] | None:
    """'2025-26' -> (2025-04-01, 2026-03-31); None when the label is not YYYY-YY."""
    m = re.match(r"^(\d{4})-\d{2}$", (label or "").strip())
    if not m:
        return None
    y = int(m.group(1))
    return date(y, FY_START_MONTH, 1), date(y + 1, FY_START_MONTH, 1) - timedelta(days=1)


def window_bounds(token: str | None, today: date) -> tuple[date | None, date | None]:
    """A ``WINDOW_OPTIONS`` token -> inclusive (from, to). ``None`` / unknown = no restriction."""
    if not token:
        return None, None
    first = today.replace(day=1)
    if token == "thisMonth":
        return month_bounds(today.year, today.month)
    if token == "lastMonth":
        prev = add_months(first, -1)
        return month_bounds(prev.year, prev.month)
    if token in ("last3", "last6", "last12"):
        n = {"last3": 3, "last6": 6, "last12": 12}[token]
        start = add_months(first, -(n - 1))
        return start, month_bounds(today.year, today.month)[1]
    if token in ("thisFY", "lastFY"):
        y = fy_start_year(today) - (1 if token == "lastFY" else 0)
        return fy_bounds(_fy_label(y))  # type: ignore[return-value]
    if token in ("thisYear", "lastYear"):
        y = today.year - (1 if token == "lastYear" else 0)
        return date(y, 1, 1), date(y, 12, 31)
    return None, None


def date_bounds(ctx: ReportContext, window_key: str, fy_key: str | None = None) -> tuple[date | None, date | None]:
    """The inclusive date range implied by the period select and (optionally) the FY select.
    When both are set the ranges are intersected, so each one narrows the result."""
    lo, hi = window_bounds(ctx.params.get(window_key), ctx.today)
    fy = ctx.params.get(fy_key) if fy_key else None
    if fy:
        bounds = fy_bounds(fy if isinstance(fy, str) else fy[0])
        if bounds:
            lo = max(lo, bounds[0]) if lo else bounds[0]
            hi = min(hi, bounds[1]) if hi else bounds[1]
    return lo, hi


def describe_bounds(lo: date | None, hi: date | None, what: str) -> str | None:
    if lo and hi:
        return f"{what} from {display_date(lo)} to {display_date(hi)}."
    if lo:
        return f"{what} on or after {display_date(lo)}."
    if hi:
        return f"{what} on or before {display_date(hi)}."
    return None


def ist_range_q(field: str, lo: date | None, hi: date | None) -> Q:
    """Q for a UTC-aware DateTimeField restricted to the IST calendar days lo..hi (inclusive).
    ``__date`` would use UTC and put 18:30-24:00 IST on the wrong day."""
    q = Q()
    if lo:
        q &= Q(**{f"{field}__gte": datetime.combine(lo, time.min, tzinfo=FACTORY_TZ)})
    if hi:
        q &= Q(**{f"{field}__lt": datetime.combine(hi + timedelta(days=1), time.min, tzinfo=FACTORY_TZ)})
    return q


# ── value helpers ───────────────────────────────────────────────────────────

def ist_date_iso(value: Any) -> str | None:
    """A UTC-aware datetime -> its IST calendar date as 'YYYY-MM-DD' (naive values are taken as IST)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(FACTORY_TZ)
        return value.date().isoformat()
    return str(value)[:10]


def natural_key(text: str | None) -> list:
    """Sort key that orders '2' before '10' (employee codes are numeric-looking text)."""
    parts = re.split(r"(\d+)", (text or "").strip().lower())
    return [int(p) if i % 2 else p for i, p in enumerate(parts)]


def pretty(value: str | None, labels: dict[str, str] | None = None) -> str | None:
    """Badge text: a known label, else the raw value title-cased; None stays None."""
    if value is None or str(value).strip() == "":
        return None
    v = str(value).strip()
    if labels and v.lower() in labels:
        return labels[v.lower()]
    return v.replace("_", " ").title()


def group_subtotals(
    rows: Iterable[dict],
    group_by: Callable[[dict], str],
    sums: Iterable[str] = (),
    avgs: Iterable[str] = (),
    label_key: str = "employeeName",
    label: Callable[[str], str] = lambda g: f"{g} total",
) -> list[dict]:
    """Like ``common.with_subtotals`` (rows must already be ordered by the group) but a subtotal row
    can also carry the *average* of a column - an increment percentage must be averaged, not summed."""
    sums, avgs = list(sums), list(avgs)
    out: list[dict] = []
    bucket: list[dict] = []
    current: str | None = None

    def flush() -> None:
        if current is None or not bucket:
            return
        row: dict = {label_key: label(current), "_kind": KIND_SUBTOTAL}
        for k in sums:
            vals = [r[k] for r in bucket if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)]
            row[k] = round(sum(vals), 2) if vals else None
        for k in avgs:
            vals = [r[k] for r in bucket if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)]
            row[k] = round(sum(vals) / len(vals), 2) if vals else None
        out.append(row)

    for r in rows:
        g = group_by(r)
        if g != current:
            flush()
            current, bucket = g, []
        out.append(r)
        bucket.append(r)
    flush()
    return out


def distinct_groups(rows: Iterable[dict], group_by: Callable[[dict], str]) -> int:
    return len({group_by(r) for r in rows})
