"""
Production payroll period boundary math (Settings → Payroll → Production).

Replaces the old hardcoded `_get_biweekly_range()` (1st-15th / 16th-end of
month, always) with two independently configurable axes on PayrollSettings:

  prod_period_frequency  -how often periods repeat: weekly / 2weeks / 3weeks / monthly
  prod_period_style      -how boundaries are anchored:
                            calendar_month   -resets on the 1st of each
                                              month; the LAST slice of the
                                              month absorbs any remainder
                                              shorter than a full slice
                                              (generalizes the old 1st-15th/
                                              16th-end split -see note below
                                              on the 1-day shift this causes
                                              for the 2-week case).
                            weekday_anchored -chains N complete 7-day weeks
                                              (Mon-Sat or Sun-Sat) forward
                                              from a stored anchor date,
                                              ignoring month boundaries
                                              entirely. Not valid with
                                              "monthly" frequency.
                            custom_recurring -chains a fixed day-length
                                              forward from a stored anchor
                                              date, ignoring month
                                              boundaries. Frequency is
                                              irrelevant here; prod_period_
                                              custom_days is the source of
                                              truth for the length.

Note on the 2-week calendar-anchored case: this generalized slicer produces
1st-14th / 15th-end, one day earlier than the old hardcoded 1st-15th /
16th-end split. This was a deliberate, confirmed choice (see the
"Configurable Production Payroll Periods" plan) to keep the boundary math
uniform across Weekly/2-Weeks/3-Weeks rather than special-casing 14 days.
"""

from .clock import ist_today
import calendar
from datetime import date as date_type, timedelta
from .production_cycles import (
    CYCLE_DAYS,
    CYCLE_LABELS,
    WEEKLY,
    WEEK_START_WEEKDAY,
    CycleConfig,
    cycle_config,
)

_FREQ_DAYS = {"weekly": 7, "2weeks": 14, "3weeks": 21}  # "monthly" has no fixed length
_WEEKDAY_ANCHOR_PY = {"mon_sat": 0, "sun_sat": 6}  # date.weekday(): Mon=0 ... Sun=6


class InvalidPeriodConfig(Exception):
    """Raised when the current PayrollSettings period configuration is incomplete
    or invalid (e.g. weekday_anchored with no anchor date set)."""


def resolve_production_period(ref_date: date_type, ps) -> tuple[date_type, date_type]:
    """
    Return the (period_start, period_end) -both inclusive- that `ref_date`
    falls into, under the currently configured production period rules.
    Used both at generation time (resolve the period containing the day
    after the last-generated period's end) and to preview "what period is
    ref_date in" for the Settings UI.
    """
    style = ps.prod_period_style
    if style == ps.PERIOD_STYLE_CALENDAR_MONTH:
        return _calendar_month_period(ref_date, ps.prod_period_frequency)
    if style == ps.PERIOD_STYLE_WEEKDAY_ANCHORED:
        if ps.prod_period_anchor_date is None:
            raise InvalidPeriodConfig("Anchor Date is required for Weekday Anchored style.")
        if ps.prod_period_frequency == ps.PERIOD_FREQ_MONTHLY:
            raise InvalidPeriodConfig("Monthly frequency is not valid with Weekday Anchored style.")
        weeks = {"weekly": 1, "2weeks": 2, "3weeks": 3}[ps.prod_period_frequency]
        anchor_weekday = _WEEKDAY_ANCHOR_PY[ps.prod_period_weekday_anchor or ps.WEEKDAY_ANCHOR_MON_SAT]
        # Normalize the stored anchor back to the configured start weekday,
        # so HR can save any date and it still snaps to the right day.
        delta = (ps.prod_period_anchor_date.weekday() - anchor_weekday) % 7
        normalized_anchor = ps.prod_period_anchor_date - timedelta(days=delta)
        return _rolling_period(ref_date, normalized_anchor, weeks * 7)
    if style == ps.PERIOD_STYLE_CUSTOM_RECURRING:
        if ps.prod_period_anchor_date is None or not ps.prod_period_custom_days or ps.prod_period_custom_days <= 0:
            raise InvalidPeriodConfig("Anchor Date and Custom Days are required for Custom Recurring style.")
        return _rolling_period(ref_date, ps.prod_period_anchor_date, ps.prod_period_custom_days)
    raise InvalidPeriodConfig(f"Unknown prod_period_style: {style!r}")


def _rolling_period(ref_date: date_type, anchor: date_type, period_days: int) -> tuple[date_type, date_type]:
    """
    Chain fixed-length periods forward/backward from `anchor`, ignoring
    month boundaries entirely. Python's floor division on a negative
    numerator rounds toward -inf, so this is correct for a ref_date before
    the anchor too (periods extend symmetrically in both directions).
    """
    days_since_anchor = (ref_date - anchor).days
    period_index = days_since_anchor // period_days
    period_start = anchor + timedelta(days=period_index * period_days)
    return period_start, period_start + timedelta(days=period_days - 1)


def _calendar_month_period(ref_date: date_type, freq: str) -> tuple[date_type, date_type]:
    year, month = ref_date.year, ref_date.month
    month_start = date_type(year, month, 1)
    month_end = date_type(year, month, calendar.monthrange(year, month)[1])
    if freq == "monthly":
        return month_start, month_end
    slice_days = _FREQ_DAYS[freq]
    cur_start = month_start
    while cur_start <= month_end:
        cur_end = min(cur_start + timedelta(days=slice_days - 1), month_end)
        remaining_after = (month_end - cur_end).days
        if 0 < remaining_after < slice_days:
            # Not enough days left in the month for another full slice ->
            # this slice absorbs the remainder.
            cur_end = month_end
        if cur_start <= ref_date <= cur_end:
            return cur_start, cur_end
        cur_start = cur_end + timedelta(days=1)
    return month_start, month_end  # unreachable in practice


def get_last_generated_period_end():
    """Latest period_end across all period-based (new-style) Payroll rows,
    regardless of employee -periods are a company-wide schedule, not
    per-employee. None if no period-based row has ever been generated."""
    from django.db.models import Max
    from .models import Payroll
    return Payroll.objects.filter(
        salary_mode="shift", period_start__isnull=False
    ).aggregate(Max("period_end"))["period_end__max"]


def get_next_production_period(ps) -> tuple[date_type, date_type]:
    """
    The next period that should be generated: the one immediately following
    the last-generated period, or (on first-ever run) whichever period
    contains today. Because all three boundary functions tile without gaps,
    `last_end + 1 day` always lands exactly on the next period's start -this
    self-heals if Settings are changed mid-stream, since the next call just
    resolves whichever period the (possibly new) rule assigns to that date.

    On first-ever run the reference is always today -even for weekday_
    anchored/custom_recurring, where the anchor date only fixes the phase
    (which weekday periods start on / where the block-length count begins),
    not the literal first period to generate. Using the anchor date itself
    as the reference would resolve to the anchor's own period, which for an
    anchor set far in the past would silently generate payroll for a period
    years ago instead of the current one.
    """
    last_end = get_last_generated_period_end()
    candidate_ref = last_end + timedelta(days=1) if last_end is not None else ist_today()
    return resolve_production_period(candidate_ref, ps)


# ─────────────────────────────────────────────────────────────────────────────
#  Pay cycles: Weekly / BiWeekly / Monthly (4 weeks) -see production_cycles.py
# ─────────────────────────────────────────────────────────────────────────────
#
# Each cycle is a run of whole weeks (1, 2 or 4) counted forward and backward from an anchor: the configured
# "first period start" moved back to the cycle's start weekday (any of the seven: a Wednesday week runs Wednesday to
# Tuesday). Months play no part. A Weekly cycle needs no date at all (every week starts on the start weekday);
# BiWeekly and Monthly must be told which week a block begins on, because that decides how the weeks pair up.

# 2000-01-03 was a Monday: the fixed reference a Weekly cycle with no date counts from (moved back to the start weekday).
_WEEKLY_REFERENCE = date_type(2000, 1, 3)


def cycle_anchor(cfg: CycleConfig) -> date_type:
    """The date a cycle's periods are counted from, on the cycle's start weekday."""
    if cfg.anchor_date is None:
        if cfg.cycle != WEEKLY:
            label = CYCLE_LABELS[cfg.cycle]
            raise InvalidPeriodConfig(
                f"Set the first period start date for {label} in Settings -> Production Payroll -> {label}."
            )
        base = _WEEKLY_REFERENCE
    else:
        base = cfg.anchor_date
    return base - timedelta(days=(base.weekday() - WEEK_START_WEEKDAY[cfg.week_start]) % 7)


def resolve_cycle_period(ref_date: date_type, ps, cycle: str) -> tuple[date_type, date_type]:
    """The (start, end) -both inclusive- of the `cycle` period that `ref_date` falls in."""
    cfg = cycle_config(ps, cycle)
    return _rolling_period(ref_date, cycle_anchor(cfg), cfg.days)


def is_cycle_period(period_start: date_type, period_end: date_type, ps, cycle: str) -> bool:
    """Whether (start, end) is exactly one of the cycle's periods under the current settings."""
    return resolve_cycle_period(period_start, ps, cycle) == (period_start, period_end)


def last_generated_cycle_end(cycle: str, branch_id: int | None = None):
    """The latest period_end among the payroll already generated for this cycle, or None. Periods are one schedule
    for everyone the caller can see: a login scoped to a branch counts only that branch's payroll, so another branch
    generating a period never moves this branch's "next period"."""
    from django.db.models import Max
    from .models import Payroll

    rows = Payroll.objects.filter(salary_mode="shift", pay_cycle=cycle, period_start__isnull=False)
    if branch_id is not None:
        rows = rows.filter(employee__branch_id=branch_id)
    return rows.aggregate(Max("period_end"))["period_end__max"]


def next_cycle_period(
    ps, cycle: str, today: date_type | None = None, branch_id: int | None = None
) -> tuple[date_type, date_type]:
    """The period a cycle should be generated for next: the one right after the latest generated period, or --on
    the very first run-- the most recent period that has already ended, so the last finished week/fortnight/month
    can be paid straight away (the period holding today cannot be generated yet)."""
    today = today or ist_today()
    last_end = last_generated_cycle_end(cycle, branch_id)
    if last_end is not None:
        return resolve_cycle_period(last_end + timedelta(days=1), ps, cycle)
    current = resolve_cycle_period(today, ps, cycle)
    if current[1] <= today:
        return current
    return resolve_cycle_period(current[0] - timedelta(days=1), ps, cycle)


def recent_cycle_periods(
    ps, cycle: str, today: date_type | None = None, back: int = 8, branch_id: int | None = None
) -> list[tuple[date_type, date_type]]:
    """The periods worth picking from, newest first: the next one to generate, every period after it up to the one
    holding today, and `back` periods before it (so an earlier period can be filled in or looked at)."""
    today = today or ist_today()
    days = CYCLE_DAYS[cycle]
    first = next_cycle_period(ps, cycle, today, branch_id)
    ahead = max(0, min(12, (today - first[0]).days // days))
    out = []
    for k in range(ahead, -back, -1):
        start = first[0] + timedelta(days=k * days)
        out.append((start, start + timedelta(days=days - 1)))
    return out
