"""
Compensation rules: the pure part of the OT / Compensation engine (no database, no Django models).

Everything here is arithmetic on plain numbers, dates and rule rows, so the attendance engine, the OT detection
screen, the Settings validation and the tests all read the SAME definition of "how much extra work earns what".

Two rule tables, both editable in Settings -> Compensation (rows can be edited, disabled and added):

  Type 1 - next-day late-in ALLOWANCE (allowance rules)
      Extra work past the shift end earns minutes for the next working day's first punch. Each row says "at least
      `min_extra_minutes` of extra work earns `allowance_minutes`"; the row with the BIGGEST min_extra_minutes the day
      reaches wins (not the biggest allowance). Defaults: 1 h -> 30 min, 1 h 30 -> 30 min, 2 h -> 60 min,
      2 h 30 -> 60 min. It applies only up to the Type 2 threshold (extra work beyond it is Type 2's).

  Type 2 - SHIFT-based compensation (shift rules)
      A day with MORE than the Type 2 threshold (default 150 min) of extra work is a candidate HR assigns by hand.
      The shifts it suggests come from a LADDER on the clock time of the day's LAST punch, in minutes since the OT
      day's midnight (a punch at 01:00 the next calendar day is 1500). The first enabled row, in `until_minutes`
      order, whose `until_minutes` is GREATER than the last punch wins; `until_minutes` None = no upper limit (the
      last row). Defaults: before 21:00 -> 0.25, before 24:00 -> 0.50, before 02:00 -> 0.75, later -> 1.00. So a
      punch AT 21:00 is already in the 0.50 row and a punch at 00:00 in the 0.75 row, as the owner's table reads.

A punch counts as the minute it was made in (a punch at 21:00:40 is 21:00; 20:59:59 is still 20:59), like every
other whole-minute check in the attendance engine.
"""

from dataclasses import dataclass
from datetime import date as date_type, timedelta
from decimal import Decimal, InvalidOperation

MINUTES_PER_DAY = 1440

#: Type 2 gives one of these, and HR may only ever assign one of these.
SHIFT_STEPS = (Decimal("0.25"), Decimal("0.50"), Decimal("0.75"), Decimal("1.00"))

MAX_ALLOWANCE_MINUTES = 240  # an allowance longer than four hours is a typo, not a rule
MAX_UNTIL_MINUTES = 2880  # the ladder's clock limits: up to 48 h after the OT day's midnight
MAX_LABEL_LENGTH = 80

#: How far back "the previous working day" is looked for (a long festival break between two working days).
LOOKBACK_DAYS = 10

#: The default Type 2 threshold (extra minutes past the shift end where Type 2 starts).
DEFAULT_SHIFT_MIN_EXTRA_MINUTES = 150


@dataclass(frozen=True)
class AllowanceRule:
    """Plain stand-in for a CompensationRule(kind=allowance) row (the rules functions accept either)."""

    min_extra_minutes: int
    allowance_minutes: int
    enabled: bool = True
    label: str = ""
    sort_order: int = 0
    id: int | None = None


@dataclass(frozen=True)
class ShiftRule:
    """Plain stand-in for a CompensationRule(kind=shift) row. `until_minutes` None = no upper limit."""

    until_minutes: int | None
    shifts: Decimal
    enabled: bool = True
    label: str = ""
    sort_order: int = 0
    id: int | None = None


# ── clock <-> minutes since midnight ────────────────────────────────────────


def clock_to_minutes(value) -> int:
    """A clock time (datetime.time, or "HH:MM" / "HH:MM:SS") as whole minutes since midnight (seconds dropped)."""
    if isinstance(value, str):
        parts = value.strip().split(":")
        return int(parts[0]) * 60 + int(parts[1])
    return value.hour * 60 + value.minute


def seconds_to_minutes(seconds: int) -> int:
    """Seconds since a day's midnight as whole minutes: the minute the punch was made in."""
    return int(seconds) // 60


def minutes_to_clock(minutes: int) -> str:
    """Minutes since an OT day's midnight as "HH:MM" on the 24-hour clock (1500 -> "01:00": the next calendar day)."""
    minutes = int(minutes) % MINUTES_PER_DAY
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def describe_clock(minutes: int) -> str:
    """Minutes since an OT day's midnight as a person says it: 1260 -> "9:00 PM", 1500 -> "1:00 AM (next day)"."""
    minutes = int(minutes)
    day_offset = minutes // MINUTES_PER_DAY
    within = minutes % MINUTES_PER_DAY
    hour, minute = within // 60, within % 60
    suffix = "AM" if hour < 12 else "PM"
    hour12 = hour % 12 or 12
    text = f"{hour12}:{minute:02d} {suffix}"
    if day_offset >= 1:
        text += " (next day)" if day_offset == 1 else f" (+{day_offset} days)"
    return text


def describe_duration(minutes: int) -> str:
    """90 -> "1 hour 30 minutes", 60 -> "1 hour", 45 -> "45 minutes"."""
    minutes = int(minutes)
    hours, rest = divmod(minutes, 60)
    parts = []
    if hours:
        parts.append(f"{hours} hour" + ("s" if hours != 1 else ""))
    if rest or not hours:
        parts.append(f"{rest} minute" + ("s" if rest != 1 else ""))
    return " ".join(parts)


def extra_minutes(last_punch_secs: int, shift_end_secs: int) -> int:
    """Whole minutes the day's LAST punch is past the shift end, never negative. Both are seconds since the OT day's
    midnight, so a punch after midnight is 86400 + its clock seconds and is correctly AFTER a 17:30 shift end (the
    clock-time subtraction the first OT screen did made it negative, so a 01:00 punch was never detected)."""
    return max(0, int(last_punch_secs) // 60 - int(shift_end_secs) // 60)


# ── Type 1: the allowance ───────────────────────────────────────────────────


def _enabled(rules):
    return [r for r in rules or () if getattr(r, "enabled", True)]


def allowance_rule_for(extra: int, rules, max_extra: int | None = None):
    """The allowance row that `extra` minutes of extra work earns: among the ENABLED rows whose `min_extra_minutes`
    the day reaches, the one with the biggest `min_extra_minutes` (None when it reaches none, or when `max_extra` is
    given and the day is beyond it: more than the Type 2 threshold is Type 2's, not the allowance's)."""
    if extra is None or extra <= 0:
        return None
    if max_extra is not None and extra > max_extra:
        return None
    best = None
    for rule in _enabled(rules):
        floor = rule.min_extra_minutes
        if floor is None or floor < 1 or extra < floor:
            continue
        if best is None or floor > best.min_extra_minutes:
            best = rule
    return best


def allowance_minutes_for(extra: int, rules, max_extra: int | None = None) -> int:
    """Minutes of next-morning allowance that `extra` minutes of extra work earn (0 = none). See allowance_rule_for."""
    rule = allowance_rule_for(extra, rules, max_extra)
    if rule is None:
        return 0
    return max(0, int(rule.allowance_minutes or 0))


# ── Type 2: the shift ladder ────────────────────────────────────────────────


def shift_rule_for_last_punch(last_punch_minutes: int, rules):
    """The ladder row that a last punch (minutes since the OT day's midnight) falls in: the first ENABLED row, in
    `until_minutes` order (rows with no limit last), whose `until_minutes` is greater than the punch."""
    ordered = sorted(
        _enabled(rules),
        key=lambda r: (r.until_minutes is None, r.until_minutes if r.until_minutes is not None else 0),
    )
    for rule in ordered:
        if rule.until_minutes is None or rule.until_minutes > last_punch_minutes:
            return rule
    return None


def shift_for_last_punch(
    last_punch_minutes: int, rules, extra: int | None = None, min_extra_minutes: int | None = None
) -> Decimal | None:
    """The shifts the ladder suggests for a last punch, or None when no enabled row matches. When `extra` and
    `min_extra_minutes` are given the day must be MORE than the threshold past the shift end to qualify at all
    (None otherwise): exactly 150 minutes is still Type 1's, 151 is Type 2's."""
    if extra is not None and min_extra_minutes is not None and extra <= min_extra_minutes:
        return None
    rule = shift_rule_for_last_punch(last_punch_minutes, rules)
    if rule is None or rule.shifts is None:
        return None
    return normalise_shifts(rule.shifts)


def is_type2_day(extra: int, min_extra_minutes: int) -> bool:
    """MORE than the threshold of extra work: a Type 2 candidate."""
    return extra is not None and extra > min_extra_minutes


def normalise_shifts(value) -> Decimal | None:
    """0.25 / "0.5" / 1 -> Decimal("0.25") / Decimal("0.50") / Decimal("1.00") when it is one of the four allowed
    amounts, else None (anything else, a bool, a non-number)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None
    return amount if amount in SHIFT_STEPS else None


# ── validation of the two tables (Settings -> Compensation) ─────────────────


def _int_or_none(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def validate_allowance_rows(rows) -> list[str]:
    """Plain-sentence problems with an allowance table as sent by Settings (dicts with `enabled`,
    `min_extra_minutes`, `allowance_minutes`, `label`). Empty list = valid. The row number is 1-based, in the order sent."""
    errors: list[str] = []
    seen: dict[int, int] = {}
    for position, row in enumerate(rows or (), start=1):
        where = f"Allowance rule {position}"
        label = row.get("label")
        if label is not None and len(str(label)) > MAX_LABEL_LENGTH:
            errors.append(f"{where}: the name is longer than {MAX_LABEL_LENGTH} characters.")
        floor = _int_or_none(row.get("min_extra_minutes"))
        if floor is None or floor < 1:
            errors.append(f"{where}: the extra work needed must be a whole number of minutes, at least 1.")
        minutes = _int_or_none(row.get("allowance_minutes"))
        if minutes is None or minutes < 0 or minutes > MAX_ALLOWANCE_MINUTES:
            errors.append(f"{where}: the allowance must be between 0 and {MAX_ALLOWANCE_MINUTES} minutes.")
        if row.get("enabled", True) and floor is not None and floor >= 1:
            if floor in seen:
                errors.append(
                    f"Allowance rules {seen[floor]} and {position} both start at {describe_duration(floor)} of "
                    "extra work: change one, or switch one off."
                )
            else:
                seen[floor] = position
    return errors


def validate_shift_rows(rows) -> list[str]:
    """Plain-sentence problems with a shift ladder as sent by Settings (dicts with `enabled`, `until_minutes`,
    `shifts`, `label`), in the order sent. Among the ENABLED rows `until_minutes` must strictly increase, and only
    the LAST enabled row may (and must) have no limit, so that every late punch lands on a row."""
    errors: list[str] = []
    enabled_rows: list[tuple[int, int | None]] = []
    for position, row in enumerate(rows or (), start=1):
        where = f"Shift rule {position}"
        label = row.get("label")
        if label is not None and len(str(label)) > MAX_LABEL_LENGTH:
            errors.append(f"{where}: the name is longer than {MAX_LABEL_LENGTH} characters.")
        if normalise_shifts(row.get("shifts")) is None:
            errors.append(f"{where}: the shifts must be one of 0.25, 0.50, 0.75 or 1.")
        until = row.get("until_minutes")
        if until is not None:
            value = _int_or_none(until)
            if value is None or value < 1 or value > MAX_UNTIL_MINUTES:
                errors.append(f"{where}: the time limit must be between 00:01 and 48:00 after the day's midnight.")
                continue
            until = value
        if row.get("enabled", True):
            enabled_rows.append((position, until))
    for index, (position, until) in enumerate(enabled_rows):
        is_last = index == len(enabled_rows) - 1
        if until is None and not is_last:
            errors.append(
                f"Shift rule {position} has no time limit but is not the last row: only the last row can cover "
                "everything later."
            )
        if is_last and until is not None:
            errors.append(
                f"The last shift rule (rule {position}) must have no time limit, so that a punch later than every "
                "other row still earns a value."
            )
        if index and until is not None:
            before = enabled_rows[index - 1][1]
            if before is not None and until <= before:
                errors.append(
                    f"Shift rule {position}: its time limit must be later than the row before it "
                    f"({minutes_to_clock(before)} on the day, then later)."
                )
    return errors


# ── birthday ────────────────────────────────────────────────────────────────


def is_birthday(date_of_birth, d: date_type) -> bool:
    """Is `d` the employee's birthday? Month and day match; a 29 February birthday is kept on 28 February in a year
    that has no 29 February (and not also on 1 March)."""
    if date_of_birth is None or d is None:
        return False
    if date_of_birth.month == 2 and date_of_birth.day == 29:
        leap = d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0)
        return (d.month, d.day) == ((2, 29) if leap else (2, 28))
    return (d.month, d.day) == (date_of_birth.month, date_of_birth.day)


# ── "the next working day" ──────────────────────────────────────────────────


def previous_working_day(d: date_type, is_off, lookback: int = LOOKBACK_DAYS) -> date_type | None:
    """The working day the allowance of `d` was earned on: walk back from d - 1 over off days (`is_off(day)` True:
    Sundays, company holidays, an off Saturday) to the first working day, looking back at most `lookback` days
    (None when only off days lie in between)."""
    cursor = d - timedelta(days=1)
    for _ in range(lookback):
        if not is_off(cursor):
            return cursor
        cursor -= timedelta(days=1)
    return None


# ── arrival zones ───────────────────────────────────────────────────────────

# Better zones rank lower. A permission-excused arrival ranks with Late (both are "after the on-time limit").
_ZONE_RANK = {"on_time": 0, "late": 1, "excused": 1, "quarter": 2, "second_half": 3}


def zone_rank(zone: str | None) -> int:
    return _ZONE_RANK.get(zone or "", 0)
