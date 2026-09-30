"""Small value helpers shared by report definitions and both exporters."""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, time
from decimal import Decimal

MONTH_NAMES = [
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
MONTH_ABBR = [m[:3] for m in MONTH_NAMES]


def r2(value) -> float | None:
    """Money / decimal -> float rounded to 2 places. None stays None."""
    if value is None or value == "":
        return None
    return round(float(value), 2)


def num(value, places: int = 2) -> float | int | None:
    if value is None or value == "":
        return None
    f = round(float(value), places)
    return int(f) if places == 0 else f


def parse_date(value) -> date | None:
    """Tolerant ISO parser for the string-typed date columns in this schema
    (Employee.join_date, LeaveRequest.start_date, ...). Never raises."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def iso(value) -> str | None:
    """date / datetime / ISO-ish string -> 'YYYY-MM-DD', or None."""
    d = parse_date(value)
    return d.isoformat() if d else None


def fmt_time(value) -> str | None:
    """time / datetime -> 'HH:MM'."""
    if value is None or value == "":
        return None
    if isinstance(value, (time, datetime)):
        return value.strftime("%H:%M")
    return str(value)[:5]


def fmt_dt(value) -> str | None:
    """A datetime -> 'YYYY-MM-DD HH:MM' in IST wall-clock.

    Aware datetimes (DateTimeField values, stored in UTC) are converted to
    Asia/Kolkata first; naive ones are assumed to already be factory time (this
    codebase stores punches as naive local time)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            from api.clock import FACTORY_TZ

            value = value.astimezone(FACTORY_TZ)
        return value.strftime("%Y-%m-%d %H:%M")
    return str(value)[:16]


def full_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def month_label(year: int, month: int) -> str:
    return f"{MONTH_NAMES[month - 1]} {year}"


_PERIOD_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def parse_period(value: str) -> tuple[int, int] | None:
    m = _PERIOD_RE.match((value or "").strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def minutes_text(minutes) -> str:
    """125 -> '2h 05m', 45 -> '45m', 0 -> '0m', None -> ''."""
    if minutes is None or minutes == "":
        return ""
    total = int(round(float(minutes)))
    sign = "-" if total < 0 else ""
    total = abs(total)
    h, m = divmod(total, 60)
    return f"{sign}{h}h {m:02d}m" if h else f"{sign}{m}m"


def indian_number(value: float, places: int = 2) -> str:
    """12345678.5 -> '1,23,45,678.50' (lakh/crore grouping)."""
    negative = value < 0
    value = abs(value)
    whole, _, frac = f"{value:.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts) + "," + tail
    text = whole + (f".{frac}" if places else "")
    return "-" + text if negative else text


def display_date(value) -> str:
    """'2026-09-05' -> '05-Sep-2026' ('' when empty/unparseable, original text kept if not a date)."""
    if value is None or value == "":
        return ""
    d = parse_date(value)
    if d is None:
        return str(value)
    return f"{d.day:02d}-{MONTH_ABBR[d.month - 1]}-{d.year}"


def display_datetime(value) -> str:
    """'2026-09-05 14:30' -> '05-Sep-2026 14:30'."""
    if value is None or value == "":
        return ""
    text = str(value)
    d = parse_date(text[:10])
    if d is None:
        return text
    return f"{display_date(d)} {text[11:16]}".rstrip()


def json_safe(value):
    """Decimal/date/time -> JSON primitives; leaves str/int/float/bool/None alone."""
    if isinstance(value, Decimal):
        return round(float(value), 2)
    if isinstance(value, datetime):
        return fmt_dt(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    return value
