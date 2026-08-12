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

import calendar
from datetime import date as date_type, timedelta

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
    candidate_ref = last_end + timedelta(days=1) if last_end is not None else date_type.today()
    return resolve_production_period(candidate_ref, ps)
