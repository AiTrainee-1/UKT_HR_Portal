"""
Production pay cycles: the three ways a production worker can be paid.

    weekly    one week      (7 days)   Production Payroll -> Weekly
    biweekly  two weeks     (14 days)  Production Payroll -> BiWeekly
    monthly   four weeks    (28 days)  Production Payroll -> Monthly

Every production employee is assigned to ONE cycle (Employee.production_pay_cycle, set on Employees ->
Production Employees); each cycle has its own page, its own period boundaries and its own late rules
(PayrollSettings.prod_cycles, set on Settings -> Production Payroll). An employee who is not assigned
yet is in no cycle's payroll.

This module holds only the constants and the plain-data helpers (no Django models), so the models, the
period maths, the settings API and the views can all import it without a cycle.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

WEEKLY = "weekly"
BIWEEKLY = "biweekly"
MONTHLY = "monthly"

CYCLES: tuple[str, ...] = (WEEKLY, BIWEEKLY, MONTHLY)
CYCLE_CHOICES = [(WEEKLY, "Weekly"), (BIWEEKLY, "BiWeekly"), (MONTHLY, "Monthly")]
CYCLE_LABELS: dict[str, str] = dict(CYCLE_CHOICES)

# One pay period, in whole weeks. "Monthly" is four weeks, not a calendar month.
CYCLE_WEEKS: dict[str, int] = {WEEKLY: 1, BIWEEKLY: 2, MONTHLY: 4}
CYCLE_DAYS: dict[str, int] = {cycle: weeks * 7 for cycle, weeks in CYCLE_WEEKS.items()}

# Production PF / ESI bands and the ESI ceiling are written for MONTHLY pay. A production month is four weeks,
# so one period's gross is scaled to a month by this factor before it is compared with them. BiWeekly keeps the
# x2 the engine always used (that is what makes its numbers identical to before the cycles existed).
MONTHLY_EQUIVALENT_FACTOR: dict[str, int] = {WEEKLY: 4, BIWEEKLY: 2, MONTHLY: 1}
DEFAULT_MONTHLY_EQUIVALENT_FACTOR = 2

# A cycle's weeks may start on ANY weekday: a week is always seven days and ends on the weekday before it comes round
# again (Wednesday weeks run Wednesday to Tuesday). The index is date.weekday(): Monday 0 .. Sunday 6.
WEEKDAYS: tuple[str, ...] = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
WEEK_STARTS: tuple[str, ...] = WEEKDAYS
WEEK_START_WEEKDAY: dict[str, int] = {name: number for number, name in enumerate(WEEKDAYS)}
WEEK_START_MONDAY = "monday"
WEEK_START_SUNDAY = "sunday"
DEFAULT_WEEK_START = WEEK_START_MONDAY
# The first release offered only Monday and Sunday weeks, stored as these two keys: they still read, and are saved
# again as the weekday they meant.
LEGACY_WEEK_STARTS: dict[str, str] = {"mon_sat": "monday", "sun_sat": "sunday"}

# The keys one cycle may carry in PayrollSettings.prod_cycles.
CYCLE_SETTING_KEYS: tuple[str, ...] = ("weekStart", "anchorDate", "lateFreeAllowance", "lateSlabs")
LATE_ALLOWANCE_MAX = 366
LATE_SLAB_MAX_SHIFTS = 31
# A number typed as text: plain digits only. float() / int() would also take "1_0", "1e1", "inf" and Unicode digits.
PLAIN_WHOLE = re.compile(r"\s*-?[0-9]+\s*")
PLAIN_DECIMAL = re.compile(r"\s*-?[0-9]+(\.[0-9]+)?\s*")


def normalize_cycle(value) -> str | None:
    """'Weekly', ' bi-weekly ', 'BIWEEKLY' -> the stored key; None when it is not one of the three."""
    text = str(value or "").strip().lower().replace("-", "").replace("_", "").replace(" ", "")
    return text if text in CYCLES else None


def normalize_week_start(value) -> str | None:
    """'Wednesday', ' wednesday ', or a legacy 'mon_sat' / 'sun_sat' -> the stored weekday key; None when it is not a weekday."""
    text = str(value or "").strip().lower()
    text = LEGACY_WEEK_STARTS.get(text, text)
    return text if text in WEEK_START_WEEKDAY else None


@dataclass(frozen=True)
class CycleConfig:
    """What the settings say about one cycle, with the shared values filled in where the cycle has none of its own."""

    cycle: str
    week_start: str
    anchor_date: date | None
    late_free_allowance: int
    late_slabs: list
    own_late_rules: bool

    @property
    def days(self) -> int:
        return CYCLE_DAYS[self.cycle]

    @property
    def weeks(self) -> int:
        return CYCLE_WEEKS[self.cycle]


def _stored(ps, cycle: str) -> dict:
    raw = getattr(ps, "prod_cycles", None)
    entry = raw.get(cycle) if isinstance(raw, dict) else None
    return entry if isinstance(entry, dict) else {}


def _parse_date(value) -> date | None:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def cycle_config(ps, cycle: str) -> CycleConfig:
    """The settings of one cycle. A cycle with no late rules of its own uses the shared production late
    allowance and slabs (PayrollSettings.prod_late_free_allowance / prod_late_deduction_slabs), so rules saved
    before the cycles existed keep applying to every cycle until a cycle gets its own."""
    entry = _stored(ps, cycle)
    allowance = entry.get("lateFreeAllowance")
    slabs = entry.get("lateSlabs")
    return CycleConfig(
        cycle=cycle,
        week_start=normalize_week_start(entry.get("weekStart")) or DEFAULT_WEEK_START,
        anchor_date=_parse_date(entry.get("anchorDate")),
        late_free_allowance=int(allowance)
        if isinstance(allowance, int) and not isinstance(allowance, bool)
        else int(getattr(ps, "prod_late_free_allowance", 0) or 0),
        late_slabs=list(slabs)
        if isinstance(slabs, list)
        else list(getattr(ps, "prod_late_deduction_slabs", None) or []),
        own_late_rules=isinstance(allowance, int) and not isinstance(allowance, bool) or isinstance(slabs, list),
    )


def cycle_late_rules(ps, cycle: str | None) -> tuple[int, list]:
    """(free late allowance, slab rows) a payslip of this cycle is judged by."""
    if cycle not in CYCLES:
        return int(getattr(ps, "prod_late_free_allowance", 0) or 0), list(
            getattr(ps, "prod_late_deduction_slabs", None) or []
        )
    cfg = cycle_config(ps, cycle)
    return cfg.late_free_allowance, cfg.late_slabs


def prod_cycles_response(ps) -> dict:
    """PayrollSettings.prod_cycles as the settings API returns it: every cycle, every key, shared values filled in."""
    out = {}
    for cycle in CYCLES:
        cfg = cycle_config(ps, cycle)
        out[cycle] = {
            "weekStart": cfg.week_start,
            "anchorDate": cfg.anchor_date.isoformat() if cfg.anchor_date else None,
            "lateFreeAllowance": cfg.late_free_allowance,
            "lateSlabs": cfg.late_slabs,
            "ownLateRules": cfg.own_late_rules,
        }
    return out


def clean_slabs(rows) -> tuple[list | None, str | None]:
    """(slab rows ready to store, None) or (None, why they cannot be): numeric, not negative, one row per
    threshold, ascending. The same rules the staff and production late tables are saved under."""
    if not isinstance(rows, list):
        return None, "Late slabs must be a list."
    cleaned: dict[int, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            raw_from, raw_shifts = row["fromLates"], row["deductionShifts"]
            if isinstance(raw_shifts, bool) or (
                isinstance(raw_shifts, str) and not PLAIN_DECIMAL.fullmatch(raw_shifts)
            ):
                raise ValueError("deductionShifts must be a plain number")
            if isinstance(raw_from, str) and not PLAIN_WHOLE.fullmatch(raw_from):
                raise ValueError("fromLates must be a whole number")
            from_lates = int(raw_from)
            shifts = float(raw_shifts)
        except (KeyError, TypeError, ValueError, OverflowError):
            return None, "Each late slab needs a numeric fromLates and deductionShifts."
        if isinstance(raw_from, bool) or (from_lates != raw_from and not isinstance(raw_from, str)):
            return None, "Each late slab's fromLates must be a whole number."
        if shifts != shifts or shifts in (float("inf"), float("-inf")):
            return None, "Late slab values must be finite numbers."
        if from_lates < 0 or shifts < 0:
            return None, "Late slab values cannot be negative."
        if from_lates > LATE_ALLOWANCE_MAX:
            return None, f"A late slab's fromLates cannot be more than {LATE_ALLOWANCE_MAX}."
        if shifts > LATE_SLAB_MAX_SHIFTS:
            return None, f"A late slab cannot cut more than {LATE_SLAB_MAX_SHIFTS} shifts."
        cleaned[from_lates] = shifts
    return [{"fromLates": k, "deductionShifts": cleaned[k]} for k in sorted(cleaned)], None


def merge_prod_cycles(stored, patch) -> tuple[dict | None, str | None]:
    """The new PayrollSettings.prod_cycles after applying `patch` on top of `stored`, or (None, why not).

    `patch` is {cycle: {key: value}}: only the cycles and keys it names change. For the late keys a null clears the
    cycle's own value, which hands that cycle back to the shared production late rules."""
    if not isinstance(patch, dict):
        return None, "prodCycles must be an object with a weekly, biweekly or monthly entry."
    merged: dict = {c: dict(v) for c, v in (stored or {}).items() if c in CYCLES and isinstance(v, dict)}
    for name, changes in patch.items():
        cycle = normalize_cycle(name)
        if cycle is None:
            return None, f"Unknown pay cycle '{name}': use weekly, biweekly or monthly."
        label = CYCLE_LABELS[cycle]
        if not isinstance(changes, dict):
            return None, f"{label} settings must be an object."
        unknown = [k for k in changes if k not in CYCLE_SETTING_KEYS]
        if unknown:
            return None, f"{label}: unknown setting '{unknown[0]}'."
        entry = merged.setdefault(cycle, {})
        if "weekStart" in changes:
            week_start = normalize_week_start(changes["weekStart"])
            if week_start is None:
                return None, f"{label} week start must be a weekday ({WEEKDAYS[0]} to {WEEKDAYS[-1]})."
            entry["weekStart"] = week_start
        if "anchorDate" in changes:
            value = changes["anchorDate"]
            if value in (None, ""):
                entry.pop("anchorDate", None)
            else:
                parsed = None
                if isinstance(value, str) and len(value) == 10:
                    parsed = _parse_date(value)
                if parsed is None:
                    return None, f"{label} first period start must be a real date (YYYY-MM-DD)."
                if not 2000 <= parsed.year <= 2100:
                    return None, f"{label} first period start must be a date between the years 2000 and 2100."
                entry["anchorDate"] = parsed.isoformat()
        if "lateFreeAllowance" in changes:
            value = changes["lateFreeAllowance"]
            if value is None:
                entry.pop("lateFreeAllowance", None)
            else:
                if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                    return None, f"{label} free late days must be a whole number from 0 to {LATE_ALLOWANCE_MAX}."
                if isinstance(value, str) and not PLAIN_WHOLE.fullmatch(value):
                    return None, f"{label} free late days must be a whole number from 0 to {LATE_ALLOWANCE_MAX}."
                try:
                    number = float(value)
                except (ValueError, OverflowError):  # "x", or a whole number too big for a float
                    return None, f"{label} free late days must be a whole number from 0 to {LATE_ALLOWANCE_MAX}."
                if number != number or not number.is_integer() or not 0 <= number <= LATE_ALLOWANCE_MAX:
                    return None, f"{label} free late days must be a whole number from 0 to {LATE_ALLOWANCE_MAX}."
                entry["lateFreeAllowance"] = int(number)
        if "lateSlabs" in changes:
            value = changes["lateSlabs"]
            if value is None:
                entry.pop("lateSlabs", None)
            else:
                slabs, problem = clean_slabs(value)
                if problem:
                    return None, f"{label}: {problem}"
                entry["lateSlabs"] = slabs
    return {c: v for c, v in merged.items() if v}, None
