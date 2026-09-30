"""
Morning arrival timeline: where a staff employee's FIRST punch falls, judged from their own shift.

Everything is measured from the shift's start, so it is dynamic per shift and per setting; no clock time is
hard-coded. With a 09:00 shift, 10 min grace and the default windows (Settings -> Attendance):

    up to 09:10        ON TIME       (shift start + the shift's grace)
    09:10 - 10:10      LATE          (arrival_late_window_minutes)        full day, counts in the late pool
    10:10 - 11:10      permission window (arrival_permission_window_minutes)
    11:10 - 11:30      extra minutes (arrival_extra_minutes)
    after 11:30        SECOND HALF   the first half was missed: Absent until a punch at/after the
                                     Second Half Start time, then Half Day

An approved, in-cap Morning Late-In permission EXCUSES an arrival up to the end of the permission window
(the Late window before it included): full day, no Late mark. Without one, an arrival after the Late window
gets the QUARTER-SHIFT rule instead: `arrival_quarter_deduction` (0.25) comes off the day, so the employee earns
0.75 rather than losing a whole Half Day (they did come to work). The extra minutes are the same for everyone:
a permission never covers them. A day is never charged twice: QUARTER and SECOND HALF arrivals are not also
Late-In occurrences.

Judged in whole minutes, like every other late check (a punch at 10:10:40 is still inside a window that ends at
10:10; the first minute past it is 10:11). This module is pure (no database), so the attendance engine, the
WhatsApp late alert and the Settings preview (frontend/src/lib/arrival-rules.ts, same worked examples) can never
disagree about which side of a limit a punch is on.
"""

from dataclasses import dataclass
from decimal import Decimal

ZONE_ON_TIME = "on_time"
ZONE_LATE = "late"
ZONE_EXCUSED = "excused"
ZONE_QUARTER = "quarter"
ZONE_SECOND_HALF = "second_half"
ZONES = (ZONE_ON_TIME, ZONE_LATE, ZONE_EXCUSED, ZONE_QUARTER, ZONE_SECOND_HALF)


def _minutes(value, default: int) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _secs_of(t) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def hhmm(secs: int) -> str:
    """Seconds since midnight as HH:MM (a time past midnight, e.g. 25:00, stays 01:00)."""
    secs = int(secs) % 86400
    return f"{secs // 3600:02d}:{secs % 3600 // 60:02d}"


def _amount(value) -> str:
    """0.25 -> '0.25', 1 -> '1', 0.50 -> '0.5'."""
    return f"{Decimal(str(value)).normalize():f}"


@dataclass(frozen=True)
class ArrivalLimits:
    """The four limits of one shift's morning, in seconds since midnight (each inclusive: a punch AT it is still inside)."""

    start_s: int
    on_time_until: int  # shift start + grace
    late_until: int  # + late window
    permission_until: int  # + permission window
    first_half_until: int  # + extra minutes: the latest arrival that still counts as the first half


def limits_for(shift, settings) -> ArrivalLimits | None:
    """The limits for a shift under the company settings, or None when the employee has no shift to measure from."""
    if shift is None or getattr(shift, "start_time", None) is None:
        return None
    start = _secs_of(shift.start_time)
    on_time = start + _minutes(getattr(shift, "grace_period_minutes", 0), 0) * 60
    late = on_time + _minutes(getattr(settings, "arrival_late_window_minutes", 60), 60) * 60
    permission = late + _minutes(getattr(settings, "arrival_permission_window_minutes", 60), 60) * 60
    first_half = permission + _minutes(getattr(settings, "arrival_extra_minutes", 20), 20) * 60
    return ArrivalLimits(start, on_time, late, permission, first_half)


def zone_of(first_punch_secs: int, limits: ArrivalLimits, permission_covers: bool) -> str:
    """Which zone a first punch (seconds since the day's midnight) falls in. `permission_covers` is True only for an
    approved Morning Late-In permission that is still within the monthly cap."""
    first = int(first_punch_secs) // 60 * 60  # whole minutes
    if first <= limits.on_time_until:
        return ZONE_ON_TIME
    if first <= limits.late_until:
        return ZONE_EXCUSED if permission_covers else ZONE_LATE
    if first <= limits.permission_until:
        return ZONE_EXCUSED if permission_covers else ZONE_QUARTER
    if first <= limits.first_half_until:
        return ZONE_QUARTER
    return ZONE_SECOND_HALF


def explain(
    zone: str, first_punch_secs: int, limits: ArrivalLimits, permission_covers: bool, deduction, deducted: bool = True
) -> str | None:
    """One plain sentence for HR / the employee saying why the day was treated this way (None for on time and Late, whose
    wording comes from the Late-In check itself). `deducted` is False for a quarter-shift arrival whose day is already a
    Half Day (no second-half punch), which is not docked a second time."""
    first = hhmm(first_punch_secs)
    if zone == ZONE_EXCUSED:
        return (
            f"Approved Morning Late-In permission: first punch {first} is within the permission window "
            f"(until {hhmm(limits.permission_until)}), so it is not marked Late"
        )
    if zone == ZONE_QUARTER:
        after = limits.permission_until if permission_covers else limits.late_until
        what = "permission window" if permission_covers else "Late window"
        if not deducted:
            cost = "no second-half punch yet, so the day is a Half Day and nothing further is deducted"
        elif Decimal(str(deduction)) > 0:
            cost = f"{_amount(deduction)} shift deducted"
        else:
            cost = "no shift deducted (set to 0)"
        return (
            f"Quarter-shift arrival: first punch {first} is after the {what} ended ({hhmm(after)}) but within the "
            f"first half (until {hhmm(limits.first_half_until)}): {cost}; not counted as Late"
        )
    if zone == ZONE_SECOND_HALF:
        return (
            f"Second-half arrival: first punch {first} is after the latest first-half arrival "
            f"({hhmm(limits.first_half_until)}), so the first half was missed (Absent until a second-half punch is "
            "recorded, then Half Day; not counted as Late)"
        )
    return None
