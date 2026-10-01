"""
The request date window: which dates an EMPLOYEE may put on a request (Leave, Casual Leave, Permission / Late-In,
Missing Punch).

The same rule is applied by the Employee Web App (src/lib/request-window.ts) and the Mobile App (src/lib/requestWindow.ts)
and all three are tested against the same vectors, so change them together:

  * An employee may request dates in the CURRENT calendar month: from the 1st to the last day of this month.
  * Grace: on the first GRACE_DAYS (2) days of a month the PREVIOUS month is still open too, so on the 1st and the 2nd the
    window starts on the 1st of last month. From the 3rd it starts on the 1st of this month.
  * A Missing Punch also cannot be in the future (``no_future``): a punch cannot be missed tomorrow.

The server is the authority: "today" is India time (api.clock.ist_today), whatever the employee's phone says. Only an
EMPLOYEE token is held to it. HR creating a request on someone's behalf (a correction, a back-dated entry) is never
limited; ``enforce_*`` return None for any other token. Resignation (a notice-period date), Outpass and On-Duty (no date is
picked) are not covered.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

from rest_framework.response import Response

from .auth import get_token_employee_id
from .clock import ist_today

GRACE_DAYS = 2
CODE = "request_window_closed"

MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class RequestWindow:
    min: date  # first selectable day
    max: date  # last selectable day (the last day of the current month)
    today: date
    grace_open: bool  # last month is still open (the 1st .. GRACE_DAYS-th of a month)
    current_month: str  # 'October 2026'
    previous_month: str  # 'September 2026'


def request_window(today: date | None = None) -> RequestWindow:
    today = today or ist_today()
    y, m, d = today.year, today.month, today.day
    py, pm = (y - 1, 12) if m == 1 else (y, m - 1)
    grace = d <= GRACE_DAYS
    return RequestWindow(
        min=date(py, pm, 1) if grace else date(y, m, 1),
        max=date(y, m, calendar.monthrange(y, m)[1]),
        today=today,
        grace_open=grace,
        current_month=f"{MONTHS[m - 1]} {y}",
        previous_month=f"{MONTHS[pm - 1]} {py}",
    )


def _long(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def window_message(w: RequestWindow) -> str:
    """The sentence shown when a date is outside the window (the same words in both apps)."""
    if not w.grace_open:
        return f"You can only request dates in {w.current_month}."
    prev_name = w.previous_month.split(" ")[0]
    current_name = w.current_month.split(" ")[0]
    return (
        f"You can only request dates from {_long(w.min)} to {_long(w.max)}. "
        f"{prev_name} closes at the end of {GRACE_DAYS} {current_name}."
    )


def window_hint(w: RequestWindow) -> str:
    return f"{_long(w.min)} to {_long(w.max)}" if w.grace_open else f"Any day in {w.current_month}"


def parse_request_date(raw) -> date | None:
    """A real calendar date from 'YYYY-MM-DD' (an ISO date-time is read by its first ten characters), else None."""
    text = str(raw if raw is not None else "").strip()[:10]
    if not _ISO.match(text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def check_date(raw, today: date | None = None, no_future: bool = False) -> str | None:
    """None when ``raw`` may be requested, else the message to show."""
    w = request_window(today)
    value = parse_request_date(raw)
    if value is None:
        return "Choose a valid date."
    if no_future and value > w.today:
        return "Date cannot be in the future."
    if value < w.min or value > w.max:
        return window_message(w)
    return None


def check_range(start_raw, end_raw, today: date | None = None) -> str | None:
    """None when both ends of a leave range may be requested and the end is not before the start."""
    w = request_window(today)
    start, end = parse_request_date(start_raw), parse_request_date(end_raw)
    if start is None or end is None:
        return "Choose a valid date."
    if start < w.min or start > w.max or end < w.min or end > w.max:
        return window_message(w)
    if end < start:
        return "End date must be on or after start date."
    return None


def refusal(message: str, today: date | None = None) -> Response:
    """The 400 an employee gets: ``error`` is the sentence (old apps print it as it is); the rest lets a client react."""
    w = request_window(today)
    return Response(
        {
            "error": message,
            "code": CODE,
            "earliestDate": w.min.isoformat(),
            "latestDate": w.max.isoformat(),
            "graceDays": GRACE_DAYS,
        },
        status=400,
    )


def enforce_employee_date(request, raw, no_future: bool = False, today: date | None = None) -> Response | None:
    """For an employee token: a 400 when ``raw`` is outside the window. None for HR, or when the date is fine."""
    if get_token_employee_id(request) is None:
        return None
    message = check_date(raw, today, no_future)
    return refusal(message, today) if message else None


def enforce_employee_range(request, start_raw, end_raw, today: date | None = None) -> Response | None:
    """The same for a leave range (both ends, and the end not before the start)."""
    if get_token_employee_id(request) is None:
        return None
    message = check_range(start_raw, end_raw, today)
    return refusal(message, today) if message else None
