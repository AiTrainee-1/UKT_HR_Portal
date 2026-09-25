"""Small text formatters shared by every WhatsApp message builder, so a date, a time or a phone
number reads the same in an approval, an alert and a gate message."""

from datetime import date as date_type, datetime, time as time_type

from .clock import FACTORY_TZ


def date_str(value) -> str:
    """25 Sep 2026 -from a date, a datetime (shown in factory time) or an ISO string."""
    if not value:
        return ""
    if isinstance(value, datetime):
        value = value.astimezone(FACTORY_TZ).date()
    if isinstance(value, date_type):
        return value.strftime("%d %b %Y")
    try:
        return date_type.fromisoformat(str(value)[:10]).strftime("%d %b %Y")
    except ValueError:
        return str(value)


def time_str(value) -> str:
    """9:05 AM -from a time, a datetime (factory time) or seconds since midnight."""
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        value = value.astimezone(FACTORY_TZ).time()
    elif isinstance(value, int):
        value = time_type(value // 3600 % 24, value % 3600 // 60)
    if isinstance(value, time_type):
        return value.strftime("%I:%M %p").lstrip("0")
    return str(value)


def stamp_str(value) -> str:
    """25 Sep 2026, 9:05 AM for a datetime; just the date for a date."""
    if not value:
        return ""
    if isinstance(value, datetime):
        value = value.astimezone(FACTORY_TZ)
        return f"{value.strftime('%d %b %Y')}, {time_str(value)}"
    return date_str(value)


def duration_str(seconds: float) -> str:
    """1 hr 15 min / 35 minutes / under a minute."""
    minutes = int(seconds // 60)
    if minutes < 1:
        return "under a minute"
    hours, mins = divmod(minutes, 60)
    if hours == 0:
        return f"{mins} minute{'s' if mins != 1 else ''}"
    return f"{hours} hr {mins} min" if mins else f"{hours} hr"


def full_name(employee) -> str:
    return f"{employee.first_name} {employee.last_name}".strip()


def pretty_phone(raw: str | None, normalized: str | None = None) -> str:
    """+91 98765 43210 from any way of writing an Indian mobile number; the raw text when it
    doesn't look like one."""
    digits = normalized or "".join(ch for ch in (raw or "") if ch.isdigit())
    if len(digits) > 10:
        return f"+{digits[:-10]} {digits[-10:-5]} {digits[-5:]}"
    return (raw or "").strip()


def join(*parts, sep: str = " - ") -> str:
    """Join the non-empty parts."""
    return sep.join(str(p).strip() for p in parts if p and str(p).strip())
