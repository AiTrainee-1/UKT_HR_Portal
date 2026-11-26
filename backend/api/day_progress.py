"""TODAY's unfinished attendance day (owner 2026-11-26).

While a staff day's shift is still running the engine stores it as provisional (AttendanceDayRecord.provisional_until,
see attendance_final._evening_open_until): someone with only a morning punch is a Half Day for now (as before 13 Nov;
owner 2026-11-26) and the background refresh (attendance_refresh.refresh_provisional) judges the day again once the shift is over. Every screen
shows such a day as "In progress" with no shift count, and payroll never pays it: these helpers are the one place that
decides it.

API contract (api-database-reference.md, "In-progress days"): every served day carries
  inProgress        bool  - provisional_until is set and still in the future (IST)
  provisionalUntil  str   - ISO datetime (IST offset) of the moment the shift is OVER (shift end + grace), i.e. the
                            stored provisional_until minus the one minute the engine adds; null when not provisional.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

#: The note a payroll day breakdown carries for a day that was still running when the payroll was generated.
IN_PROGRESS_PAYROLL_NOTE = "In progress when payroll was generated - generate again after the shift ends"

#: The engine stores the first minute the evening can be judged (shift end + grace + 1 minute); the API shows the
#: moment the shift is over.
_JUDGE_MARGIN = timedelta(minutes=1)


def _aware_ist(value: datetime) -> datetime:
    from .clock import FACTORY_TZ

    if value.tzinfo is None:
        return value.replace(tzinfo=FACTORY_TZ)
    return value.astimezone(FACTORY_TZ)


def _now_ist() -> datetime:
    from . import clock

    return clock.ist_now().replace(tzinfo=clock.FACTORY_TZ)


def is_in_progress(provisional_until, now: datetime | None = None) -> bool:
    """True while `provisional_until` (a stored value, a record, or None) is in the future, IST."""
    if provisional_until is not None and not isinstance(provisional_until, datetime):
        provisional_until = getattr(provisional_until, "provisional_until", None)
    if not provisional_until:
        return False
    current = _aware_ist(now) if now is not None else _now_ist()
    return _aware_ist(provisional_until) > current


def shift_over_at(provisional_until) -> str | None:
    """The API's provisionalUntil: ISO (IST) of shift end + grace, or None."""
    if provisional_until is not None and not isinstance(provisional_until, datetime):
        provisional_until = getattr(provisional_until, "provisional_until", None)
    if not provisional_until:
        return None
    return (_aware_ist(provisional_until) - _JUDGE_MARGIN).isoformat()


def progress_fields(rec, now: datetime | None = None) -> dict:
    """{"inProgress", "provisionalUntil"} for a stored/computed day record (or None: both off)."""
    value = getattr(rec, "provisional_until", None) if rec is not None else None
    if isinstance(rec, dict):
        value = rec.get("provisional_until")
    return {"inProgress": is_in_progress(value, now), "provisionalUntil": shift_over_at(value)}


def earned_shifts(rec, now: datetime | None = None) -> Decimal:
    """The shifts a day may be PAID / totalled: its shifts_earned, or 0 while it is still in progress."""
    if is_in_progress(getattr(rec, "provisional_until", None), now):
        return Decimal("0")
    return Decimal(str(getattr(rec, "shifts_earned", 0) or 0))
