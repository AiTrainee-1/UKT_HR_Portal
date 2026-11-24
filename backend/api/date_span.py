"""
Optional `from` / `to` day filters of the HR portal's record lists (owner brief 2026-11-24: one date filter, Today /
Yesterday / This Month / Custom, on Requests, Geo Attendance and Gate Pass / Visitors / Tea Break).

    ?from=YYYY-MM-DD&to=YYYY-MM-DD   India calendar days, both ends included; either may be left out (open ended)

A list that takes them filters by the day each record is FOR (a leave by its days, a punch by its punch date, a gate pass
by its out day ...); each list says which in its own docstring. Without either param a list behaves exactly as before:
parse_day_span returns None and the caller skips the filter.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from django.db.models import Q

from .clock import FACTORY_TZ, ist_today

# the one sentence every list answers a bad value with
SPAN_ERROR = "from and to must be days (YYYY-MM-DD), from on or before to"


class DaySpanError(ValueError):
    """A `from` / `to` that is not a day, or a `from` after the `to`."""


@dataclass(frozen=True)
class DaySpan:
    start: date | None
    end: date | None

    def bounds(self) -> tuple[datetime | None, datetime | None]:
        """[start of `start`, start of the day after `end`) as aware India times; None for an open end."""
        lo = datetime.combine(self.start, time.min, tzinfo=FACTORY_TZ) if self.start else None
        hi = datetime.combine(self.end + timedelta(days=1), time.min, tzinfo=FACTORY_TZ) if self.end else None
        return lo, hi

    def instant_q(self, field: str) -> Q:
        """A datetime column whose India day is one of the span's days."""
        lo, hi = self.bounds()
        q = Q()
        if lo is not None:
            q &= Q(**{f"{field}__gte": lo})
        if hi is not None:
            q &= Q(**{f"{field}__lt": hi})
        return q

    def day_q(self, field: str, end_field: str | None = None, *, text: bool = False) -> Q:
        """A date column (or a from - to pair of them, `end_field`) with at least one day in the span. `text`: the columns
        hold YYYY-MM-DD text (LeaveRequest), compared as text; an empty end then means one day."""
        last = end_field or field
        value = (lambda d: d.isoformat()) if text else (lambda d: d)  # noqa: E731
        q = Q()
        if self.end is not None:
            q &= Q(**{f"{field}__lte": value(self.end)})
        if self.start is not None:
            reaches = Q(**{f"{last}__gte": value(self.start)})
            if end_field and text:
                reaches |= Q(**{end_field: ""}) & Q(**{f"{field}__gte": value(self.start)})
            q &= reaches
        return q

    def has(self, day: date | None) -> bool:
        """`day` is one of the span's days."""
        if day is None:
            return False
        return (self.start is None or day >= self.start) and (self.end is None or day <= self.end)

    @property
    def has_today(self) -> bool:
        return self.has(ist_today())

    def as_json(self) -> dict:
        return {
            "from": self.start.isoformat() if self.start else None,
            "to": self.end.isoformat() if self.end else None,
        }


def _day(value: str | None) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise DaySpanError(SPAN_ERROR) from None


def parse_day_span(query_params) -> DaySpan | None:
    """The span a request asks for, or None when it gives neither `from` nor `to`. Raises DaySpanError."""
    start, end = _day(query_params.get("from")), _day(query_params.get("to"))
    if start is None and end is None:
        return None
    if start and end and start > end:
        raise DaySpanError(SPAN_ERROR)
    return DaySpan(start, end)
