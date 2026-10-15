"""
Production shift rules: how a PRODUCTION employee's day is turned into shifts.

Spec: the owner's table of "if you leave at this time you earned this many shifts" (see the migration that seeds it,
0121_production_shift_rules, and Settings -> Production shifts). Nothing here touches the database except
load_ruleset(), the small loader at the bottom; every calculation takes a RuleSet and plain numbers, so reports can
call it without writing anything.

The model of a day
------------------
Times are whole seconds since the SHIFT DAY's midnight (a next-day time is +86400): a night worker who started on
Monday and left at 05:30 on Tuesday left at 05:30 + 86400 of Monday's shift day. A punch counts as the minute it was
made in (seconds are dropped, like the staff arrival checks).

A group (Day / Night / Sunday ...) has a start time, a ladder of "left at <out time> => <shift value>" points and is
picked by the clock time of the day's first punch. The unpaid breaks (tea, lunch, dinner) are company-wide.

  paid(t)  = (t - start) minus the overlap of [start, t] with the break windows (a window repeats the next day too).
  V(t)     = the shift value earned by being at work from the start until t: linear interpolation of the ladder over
             PAID time (so each band between two table points has its own rate and a break earns nothing: V is flat
             inside a break), 0 up to the start, the last ladder value from the last point on (the cap).
  The day = sum over the punch pairs (in, out) of V(out) - V(in): a gap between two pairs is unpaid, a break is
  never a loss because V is flat across it, and nobody has to punch at a break.
  Two ladder points that sit on the same PAID time (12:45 and 13:30 are either side of the same lunch) cannot be told
  apart by a function of paid time: from that paid time on the later, higher point wins. Settings warns about a ladder
  point inside a break.

Grace (default 5 min): a first punch at or before start + grace counts as the start; an OUT punch within grace BEFORE a
ladder point snaps up to that point (leaving 17:42 earns the 17:45 value, 17:40 does not). A later first punch loses
value at the band's rate. Grace never applies to the other in-punches.

Cross-midnight (the night session)
----------------------------------
A day whose punch count is odd has an open session. The NEXT calendar day's first punch closes it (it is added to this
day as +86400 and removed from the next day) when ALL of these hold:
  * this day's resolved list has an ODD count (an even count closes nothing);
  * that punch's clock time is at or before the CLOSE-BY time: the latest next-day out time among every enabled group's
    ladder rows and standard departure, plus 90 minutes (RuleSet.close_by_s; 05:30 + 90 min = 07:00 with the owner's
    tables). A normal morning arrival after a forgotten out-punch therefore never closes the day before;
  * it is within `night_session_hours` (default 18) of the open "in" punch, in whole minutes (seconds are dropped, so
    09:00:59 after a 21:00:00 punch is exactly 12 h);
  * both days are judged by the new rules (on/after the effective date) and neither is a MANUAL override day: a day the
    new rules do not judge neither consumes nor is closed, and a manual record stays untouched.
The chain is followed back from the day asked about to the first SYNC POINT: a day whose first punch cannot have been
consumed whatever the resolution before it (the previous day has no punches, the gap from the previous day's last raw
punch exceeds the limit, the punch is later than the close-by time, or one of the two days is not in force / manual).
From there the days are resolved forward, so a continuous run of any number of nights lines up day after day and gives
the same answer whether one day, a range or a whole month is asked for. The walk is capped at MAX_CHAIN_DAYS (62) days
back: a day more than 62 days after the start of an unbroken run of nights is resolved as if the run started at the
cap ('not consumed').
The callers read the punches of the default window (NIGHT_LOOKBACK_DAYS before the day) with their one punch query and
extend it with ONE more query only when needs_history() says no sync point lies inside it.

Double taps: a punch less than TAP_GAP_S (300 s) after the previous kept punch of the same calendar day is dropped before
pairing (the same 5-minute rule the WhatsApp alerts and the Report Center use), because the count of punches decides who
is in and who is out.

Rounding and the cap: the day's total is rounded to the configured step (half up, or down) and THEN limited to the
group's top ladder value, so a step that does not divide the top value can never pay more than the table.

Arithmetic is exact (Fraction) and only the final figure becomes a Decimal, rounded half-up to 0.01: no float, and no
rounding drift between a per-day and a per-month computation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type, time as time_type, timedelta
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from functools import cached_property, lru_cache
from typing import Any, Mapping, Sequence

DAY_S = 86400

#: The DEFAULT window of punches read before the day asked about for the night-session chain (see the module
#: docstring): the chain is followed back to its first sync point, which lies inside this window unless a worker has
#: worked this many nights in a row (then one more read extends it, up to MAX_CHAIN_DAYS).
NIGHT_LOOKBACK_DAYS = 7

#: The longest walk back to a sync point. A day more than MAX_CHAIN_DAYS days after the start of an unbroken run of
#: nights is resolved as if the run started at the cap (the first day of the walk is treated as 'not consumed').
MAX_CHAIN_DAYS = 62

#: The default `night_session_hours`: the longest gap between the open "in" punch and the next day's first punch.
DEFAULT_SESSION_HOURS = 18

#: Minutes added to the latest next-day out time of the rules to get the CLOSE-BY time (RuleSet.close_by_s).
CLOSE_BY_MARGIN_MIN = 90

#: A second tap on the device within this many seconds of the previous punch is a double tap and is ignored (the same
#: 5-minute rule the WhatsApp alerts and the Report Center use): the count of punches decides who is in and who is
#: out, so a double press must not turn "arrived" into "arrived and left".
TAP_GAP_S = 300

ROUNDING_STEPS = (Decimal("0.01"), Decimal("0.05"), Decimal("0.25"))
ROUNDING_MODES = ("nearest", "down")
APPLIES_ON_CHOICES = ("mon_sat", "sunday", "all")
KIND_CHOICES = ("day", "night", "sunday", "custom")

_CENT = Decimal("0.01")
_ZERO = Decimal("0")


# ── Data ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RulePoint:
    """One ladder point: a worker who leaves at `out_s` earned `value` shifts."""

    label: str
    out_s: int  # seconds since the shift day's midnight; the next day is +86400
    value: Decimal


@dataclass(frozen=True)
class BreakWindow:
    label: str
    start_s: int
    end_s: int


def merge_breaks(breaks: Sequence[BreakWindow]) -> tuple[BreakWindow, ...]:
    """The break windows as their union: sorted, overlapping / duplicate / touching windows merged (the first label is
    kept), empty or backwards windows dropped. The API refuses overlaps, but the arithmetic must be right regardless."""
    merged: list[BreakWindow] = []
    for b in sorted((b for b in breaks if b.end_s > b.start_s), key=lambda b: (b.start_s, b.end_s)):
        if merged and b.start_s <= merged[-1].end_s:
            last = merged[-1]
            if b.end_s > last.end_s:
                merged[-1] = BreakWindow(last.label, last.start_s, b.end_s)
        else:
            merged.append(b)
    return tuple(merged)


@dataclass(frozen=True)
class ShiftGroup:
    label: str
    kind: str
    applies_on: str
    start_s: int
    first_from_s: int
    first_to_s: int
    main_out_s: int | None  # standard departure, next day already added; only the early-leave flag uses it
    order: int
    points: tuple[RulePoint, ...]  # enabled points, sorted by out_s
    id: int | None = None


@dataclass(frozen=True)
class RuleSet:
    """Everything the calculation needs; `groups` holds only enabled groups that have at least one usable point."""

    enabled: bool = True
    effective_from: date_type | None = None
    grace_minutes: int = 5
    min_credit: Decimal = Decimal("0.00")
    rounding_step: Decimal = Decimal("0.01")
    rounding_mode: str = "nearest"
    full_day_value: Decimal = Decimal("1.00")
    night_session_hours: int = DEFAULT_SESSION_HOURS
    groups: tuple[ShiftGroup, ...] = ()
    breaks: tuple[BreakWindow, ...] = ()

    def __post_init__(self):
        # overlapping or duplicate break windows are one window (their union): a minute is never subtracted twice
        object.__setattr__(self, "breaks", merge_breaks(self.breaks))

    @cached_property
    def close_by_s(self) -> int:
        """The latest clock time (seconds since midnight) at which the NEXT day's first punch may still close the
        night session of the day before: the latest next-day out time among all groups' ladder rows and standard
        departures, plus CLOSE_BY_MARGIN_MIN minutes (05:30 + 90 min = 07:00 with the default tables). No setting of its
        own: it follows the rules, so adding a later night row moves it."""
        latest = 0
        for g in self.groups:
            for out in [p.out_s for p in g.points] + ([g.main_out_s] if g.main_out_s is not None else []):
                if out >= DAY_S:
                    latest = max(latest, out - DAY_S)
        return latest + CLOSE_BY_MARGIN_MIN * 60

    def applies(self, d: date_type) -> bool:
        """True when the new rules judge day `d`: switched on, `d` on/after the effective date, and a usable group.
        Every earlier day keeps the legacy calculation, so nothing already paid is re-judged. No effective date =
        not scheduled yet = legacy."""
        return bool(self.enabled and self.effective_from is not None and d >= self.effective_from and self.groups)


@dataclass(frozen=True)
class DayJudgement:
    """Late / early-leave of one day judged against the group that applies (for reports and late detection)."""

    group: ShiftGroup | None
    grace_minutes: int
    start_time: time_type | None
    main_out_time: time_type | None
    main_out_next_day: bool
    is_late: bool
    late_minutes: int
    early_leave: bool
    early_minutes: int


# ── Small helpers ──────────────────────────────────────────────────────────


def time_to_s(t) -> int:
    """A time (or "HH:MM[:SS]" text, or an int already in seconds) as seconds since midnight."""
    if isinstance(t, int):
        return t
    if isinstance(t, str):
        parts = [int(x) for x in t.split(":")]
        parts += [0] * (3 - len(parts))
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return t.hour * 3600 + t.minute * 60 + t.second


def s_to_time(s: int) -> time_type:
    s %= DAY_S
    return time_type(s // 3600, (s % 3600) // 60, s % 60)


def parse_punch_list(texts: Sequence[str]) -> list[int]:
    """Punch times typed in the order they happened ("08:30", "12:45", "21:00", "05:30") as seconds since the shift
    day's midnight: a time that is not later than the one before it is the next morning (+86400). Raises ValueError
    for a time that is not HH:MM[:SS]. For the Settings calculator and other tools that take typed punches."""
    out: list[int] = []
    offset = 0
    for text in texts:
        parts = str(text).strip().split(":")
        if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
            raise ValueError(f"'{text}' is not a time (HH:MM)")
        h, m = int(parts[0]), int(parts[1])
        sec = int(parts[2]) if len(parts) == 3 else 0
        if h > 23 or m > 59 or sec > 59:
            raise ValueError(f"'{text}' is not a time (HH:MM)")
        value = h * 3600 + m * 60 + sec + offset
        while out and value <= out[-1]:
            offset += DAY_S
            value += DAY_S
        out.append(value)
    return out


def hhmm(s: int) -> str:
    s %= DAY_S
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def _minute(s: int) -> int:
    return s - s % 60


def _dec(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))


def _attr(obj, name: str, default):
    """obj.name, or `default` when it is missing or None (an unsaved row, an older row)."""
    value = getattr(obj, name, None)
    return default if value is None else value


def _shifts_text(v: Decimal) -> str:
    return f"{Decimal(v).quantize(_CENT, rounding=ROUND_HALF_UP):.2f}"


def collapse_taps(secs: Sequence[int]) -> list[int]:
    """Sorted punch seconds with a double tap (within TAP_GAP_S of the previous KEPT punch) dropped."""
    kept: list[int] = []
    for s in sorted(secs):
        if not kept or s - kept[-1] >= TAP_GAP_S:
            kept.append(s)
    return kept


def _collapse_refs(items: Sequence[tuple[int, Any]] | None) -> list[tuple[int, Any]]:
    kept: list[tuple[int, Any]] = []
    for item in sorted(items or (), key=lambda x: x[0]):
        if not kept or item[0] - kept[-1][0] >= TAP_GAP_S:
            kept.append(item)
    return kept


# ── Building a RuleSet from stored rows ────────────────────────────────────


def build_ruleset(config, groups, rules, breaks) -> RuleSet:
    """A RuleSet from the ORM rows. `groups`/`rules`/`breaks` may include disabled rows: they are dropped here. A
    group with no enabled rule can pay nothing, so it is dropped as well (the callers then fall back to the legacy
    calculation when no group is left)."""
    points_by_group: dict[int, list[RulePoint]] = {}
    for r in rules:
        if not r.enabled:
            continue
        out = time_to_s(r.out_time) + (DAY_S if r.out_next_day else 0)
        points_by_group.setdefault(r.group_id, []).append(RulePoint(r.label or "", out, _dec(r.shift_value)))
    built: list[ShiftGroup] = []
    for g in sorted(groups, key=lambda x: (x.order, x.id or 0)):
        if not g.enabled:
            continue
        start = time_to_s(g.start_time)
        points = tuple(
            sorted(
                (p for p in points_by_group.get(g.id, []) if p.out_s > start),
                key=lambda p: (p.out_s, p.value),
            )
        )
        if not points:
            continue
        main_out = None
        if g.main_out_time is not None:
            main_out = time_to_s(g.main_out_time) + (DAY_S if g.main_out_next_day else 0)
        built.append(
            ShiftGroup(
                label=g.label,
                kind=g.kind,
                applies_on=g.applies_on,
                start_s=start,
                first_from_s=time_to_s(g.first_punch_from),
                first_to_s=time_to_s(g.first_punch_to),
                main_out_s=main_out,
                order=g.order,
                points=points,
                id=g.id,
            )
        )
    windows = tuple(
        BreakWindow(b.label or "", time_to_s(b.start_time), time_to_s(b.end_time))
        for b in sorted(breaks, key=lambda x: (x.order, x.id or 0))
        if b.enabled and time_to_s(b.end_time) > time_to_s(b.start_time)
    )
    step = _dec(_attr(config, "rules_rounding_step", "0.01"))
    mode = _attr(config, "rules_rounding_mode", "nearest")
    return RuleSet(
        enabled=bool(_attr(config, "rules_enabled", True)),
        effective_from=getattr(config, "rules_effective_from", None),
        grace_minutes=max(0, int(_attr(config, "rules_grace_minutes", 5))),
        min_credit=_dec(_attr(config, "rules_min_credit", "0")),
        rounding_step=step if step > 0 else _CENT,
        rounding_mode=mode if mode in ROUNDING_MODES else "nearest",
        full_day_value=_dec(_attr(config, "rules_full_day_value", "1")),
        night_session_hours=max(0, int(_attr(config, "rules_night_session_hours", DEFAULT_SESSION_HOURS))),
        groups=tuple(built),
        breaks=windows,
    )


# ── Paid time, the ladder and V(t) ─────────────────────────────────────────


@lru_cache(maxsize=64)
def _merged(breaks: tuple[BreakWindow, ...]) -> tuple[BreakWindow, ...]:
    return merge_breaks(breaks)


def paid_seconds(start_s: int, t: int, breaks: Sequence[BreakWindow]) -> int:
    """Seconds worked between the start and `t` excluding the break windows (each window also repeats the next day)."""
    if t <= start_s:
        return 0
    total = t - start_s
    for b in _merged(tuple(breaks)):
        for k in (0, 1):
            lo = max(start_s, b.start_s + DAY_S * k)
            hi = min(t, b.end_s + DAY_S * k)
            if hi > lo:
                total -= hi - lo
    return total


@lru_cache(maxsize=256)
def _ladder(group: ShiftGroup, breaks: tuple[BreakWindow, ...]) -> tuple[tuple[int, Fraction, int], ...]:
    """((paid seconds, value, out_s), ...) sorted by out time; the origin (0, 0) is implicit."""
    return tuple((paid_seconds(group.start_s, p.out_s, breaks), Fraction(p.value), p.out_s) for p in group.points)


def value_at(group: ShiftGroup, breaks: tuple[BreakWindow, ...], t: int) -> Fraction:
    """V(t): the shift value earned from the group's start until `t` (exact)."""
    if t <= group.start_s:
        return Fraction(0)
    x = paid_seconds(group.start_s, t, breaks)
    prev_p, prev_v = 0, Fraction(0)
    for p, v, _out in _ladder(group, breaks):
        if x < p:
            return prev_v + (v - prev_v) * Fraction(x - prev_p, p - prev_p)
        prev_p, prev_v = p, v
    return prev_v  # past the last point: capped


def snap_out(group: ShiftGroup, t: int, grace_s: int, limit: int | None = None) -> int:
    """An out punch less than `grace` before a ladder point counts as that point (never beyond `limit`, the next
    punch). With grace 5: 17:42 and 17:41 earn the 17:45 value, 17:40 (a full 5 minutes early) does not."""
    for point in group.points:
        if t <= point.out_s and point.out_s - t < grace_s:
            return point.out_s if limit is None else min(point.out_s, limit)
    return t


# ── Group selection ────────────────────────────────────────────────────────


def select_group(ruleset: RuleSet, d: date_type, first_clock_s: int) -> ShiftGroup | None:
    """The group that judges day `d`, from the clock time of its first punch.

    Sunday -> groups for Sunday / every day; any other day -> Monday-Saturday / every day. Among those, the first (by
    order) group whose first-punch window contains the punch; else the group whose start time is nearest to it (CIRCULAR
    distance on the clock: a 02:00 first punch is 5 h from a 21:00 start but 6.5 h from 08:30, so it goes to Night;
    ties to the earlier order); None when no group applies to that weekday.

    The window is compared in whole minutes at both ends: a window that ends 16:59:59 (the seed) and one saved as 16:59
    (the Settings page) both contain a punch made at 16:59:30."""
    wanted = ("sunday", "all") if d.weekday() == 6 else ("mon_sat", "all")
    candidates = [g for g in ruleset.groups if g.applies_on in wanted]
    if not candidates:
        return None
    f = _minute(first_clock_s % DAY_S)
    for g in candidates:
        if _minute(g.first_from_s) <= f <= _minute(g.first_to_s):
            return g
    return min(candidates, key=lambda g: (_circular_distance(f, g.start_s), g.order))


def _circular_distance(a: int, b: int) -> int:
    gap = abs(a - b) % DAY_S
    return min(gap, DAY_S - gap)


# ── The day ────────────────────────────────────────────────────────────────


def _round_total(total: Fraction, ruleset: RuleSet) -> Decimal:
    step = Fraction(ruleset.rounding_step)
    units = total / step
    whole = units.numerator // units.denominator  # floor (the total is never negative)
    if ruleset.rounding_mode != "down" and units - whole >= Fraction(1, 2):
        whole += 1
    rounded = whole * step
    return (Decimal(rounded.numerator) / Decimal(rounded.denominator)).quantize(_CENT, rounding=ROUND_HALF_UP)


def evaluate_day(ruleset: RuleSet, d: date_type, punches: Sequence) -> dict | None:
    """The result of production day `d` under the new rules, from its RESOLVED punches (seconds since this day's
    midnight, a next-morning exit being +86400; times are accepted too). Same keys as the legacy production result
    (status, is_late, is_half_shift, early_leave, shifts_earned, first_punch, last_punch) plus `rule_group` and
    `rule_note` (never stored). None when no group applies: the caller falls back to the legacy calculation.

    Pure: the caller decides whether the rules apply to `d` at all (RuleSet.applies)."""
    secs = sorted(time_to_s(p) for p in punches)
    if not secs:
        return {"status": "absent", "shifts_earned": _ZERO}
    kept = collapse_taps(secs)
    group = select_group(ruleset, d, kept[0] % DAY_S)
    if group is None:
        return None

    grace_s = ruleset.grace_minutes * 60
    breaks = ruleset.breaks
    cm = [_minute(s) for s in kept]
    top = max(p.value for p in group.points)

    total = Fraction(0)
    pairs: list[tuple[int, int, int, int]] = []  # (in, out, counted in, counted out)
    for i in range(len(cm) // 2):
        t_in, t_out = cm[2 * i], cm[2 * i + 1]
        counted_in = t_in
        if i == 0 and t_in <= group.start_s + grace_s:
            counted_in = min(t_in, group.start_s)  # on time (or early): counts as the start
        following = cm[2 * i + 2] if 2 * i + 2 < len(cm) else None
        counted_out = snap_out(group, t_out, grace_s, following)
        pairs.append((t_in, t_out, counted_in, counted_out))
        total += value_at(group, breaks, counted_out) - value_at(group, breaks, counted_in)
    minimum_applied = False
    if pairs and total < Fraction(ruleset.min_credit):
        total = Fraction(ruleset.min_credit)
        minimum_applied = True
    # round FIRST, then cap: a step that does not divide the top value (0.25 against 1.30) must not pay above the table
    shifts = min(_round_total(total, ruleset), top.quantize(_CENT, rounding=ROUND_HALF_UP))

    is_late = cm[0] > group.start_s + grace_s
    early_leave = len(cm) > 1 and group.main_out_s is not None and cm[-1] < group.main_out_s - grace_s
    half = shifts < ruleset.full_day_value
    return {
        "status": "half_shift" if half else "present",
        "is_late": is_late,
        "is_half_shift": half,
        "early_leave": early_leave,
        "shifts_earned": shifts,
        "first_punch": s_to_time(kept[0]),
        "last_punch": s_to_time(kept[-1]) if len(kept) > 1 else None,
        "rule_group": group.label,
        "rule_note": _note(group, ruleset, cm, pairs, shifts, is_late, minimum_applied),
    }


def _note(group, ruleset, cm, pairs, shifts, is_late, minimum_applied) -> str:
    """One plain sentence saying why the day came out the way it did."""
    label = group.label
    grace_s = ruleset.grace_minutes * 60
    if not pairs:
        return f"{label}: only one punch ({hhmm(cm[0])}), so no shift can be counted until there is an out punch"
    breaks = ruleset.breaks
    ladder = _ladder(group, breaks)
    if len(pairs) == 1:
        t_in, t_out, counted_in, counted_out = pairs[0]
        x = paid_seconds(group.start_s, counted_out, breaks)
        exact = next((p for p, _v, out in ladder if p == x), None)
        if t_out > group.points[-1].out_s:
            last = group.points[-1]
            body = f"left {hhmm(t_out)}, past the last rule {hhmm(last.out_s)} ({_shifts_text(last.value)}), so it stays at {_shifts_text(shifts)}"
        elif exact is not None:
            point = next(p for p in group.points if paid_seconds(group.start_s, p.out_s, breaks) == x)
            if counted_out != t_out:
                body = (
                    f"left {hhmm(t_out)}, counted as {hhmm(counted_out)} within the {ruleset.grace_minutes} min grace, "
                    f"{_shifts_text(shifts)} shift ({hhmm(point.out_s)} rule)"
                )
            else:
                body = f"left {hhmm(t_out)}, {_shifts_text(shifts)} shift ({hhmm(point.out_s)} rule)"
        else:
            lower = [p for p in group.points if paid_seconds(group.start_s, p.out_s, breaks) < x]
            higher = [p for p in group.points if paid_seconds(group.start_s, p.out_s, breaks) > x]
            lo_txt = (
                f"{hhmm(lower[-1].out_s)} ({_shifts_text(lower[-1].value)})"
                if lower
                else f"the start {hhmm(group.start_s)} (0.00)"
            )
            hi_txt = f"{hhmm(higher[0].out_s)} ({_shifts_text(higher[0].value)})" if higher else "the end of the table"
            body = f"left {hhmm(t_out)}, between {lo_txt} and {hi_txt}: {_shifts_text(shifts)}"
        if is_late:
            body += f"; arrived {hhmm(t_in)}, after the {hhmm(group.start_s + grace_s)} cut-off, so the late part is not paid"
        if len(cm) > 2:
            body += f"; the last punch {hhmm(cm[-1])} has no pair and is ignored"
    else:
        spans = " and ".join(f"{hhmm(a)}-{hhmm(b)}" for a, b, _ci, _co in pairs)
        body = f"worked {spans}, {_shifts_text(shifts)} shifts in total (breaks are not paid, gaps between punches are not paid)"
        if len(cm) % 2:
            body += f"; the last punch {hhmm(cm[-1])} has no pair and is ignored"
        if is_late:
            body += f"; arrived {hhmm(pairs[0][0])}, after the {hhmm(group.start_s + grace_s)} cut-off"
    if minimum_applied:
        body += f"; raised to the minimum credit {_shifts_text(ruleset.min_credit)}"
    return f"{label}: {body}"


def judge_day(
    ruleset: RuleSet, d: date_type, first_punch: time_type | int, last_punch: time_type | int | None
) -> DayJudgement:
    """Late / early-leave of a stored day, from its first and last punch clock times: the ONE helper every report and
    detector uses for days on/after the effective date instead of the legacy punch1/punch4/10-minute rule.

    A last punch whose clock is earlier than the first punch's is a next-morning punch (a night exit). Returns an
    all-False judgement without a group when none applies."""
    first_s = time_to_s(first_punch)
    group = select_group(ruleset, d, first_s)
    grace_s = ruleset.grace_minutes * 60
    if group is None:
        return DayJudgement(None, ruleset.grace_minutes, None, None, False, False, 0, False, 0)
    first_m = _minute(first_s % DAY_S)
    is_late = first_m > group.start_s + grace_s
    late_minutes = max(0, (first_m - group.start_s) // 60) if is_late else 0
    early = False
    early_minutes = 0
    if last_punch is not None and group.main_out_s is not None:
        last_s = _minute(time_to_s(last_punch) % DAY_S)
        if last_s < first_m:
            last_s += DAY_S
        if last_s < group.main_out_s - grace_s:
            early = True
            early_minutes = max(0, (group.main_out_s - last_s) // 60)
    main_out_time = s_to_time(group.main_out_s) if group.main_out_s is not None else None
    return DayJudgement(
        group,
        ruleset.grace_minutes,
        s_to_time(group.start_s),
        main_out_time,
        bool(group.main_out_s is not None and group.main_out_s >= DAY_S),
        is_late,
        late_minutes,
        early,
        early_minutes,
    )


# ── Cross-midnight resolution ──────────────────────────────────────────────


def session_kwargs(ruleset: RuleSet, manual=None) -> dict:
    """The keyword arguments of resolve_day / needs_history that make them follow `ruleset` (the session hours, the
    derived close-by time, the days the rules judge) and the dates of MANUAL override days (they neither consume nor
    are closed)."""
    return {
        "hours": ruleset.night_session_hours,
        "close_by_s": ruleset.close_by_s,
        "in_force": ruleset.applies,
        "manual": frozenset(manual or ()),
    }


class _Chain:
    """The night-session chain of one employee over a mapping {date: raw punches}: the per-call cache of the collapsed
    day lists and the two questions the resolver asks (see the module docstring)."""

    def __init__(self, by_date, hours, close_by_s, in_force, manual):
        self.by_date = by_date
        self.limit_min = max(0, int(hours)) * 60
        self.close_by_s = close_by_s
        self.in_force = in_force
        self.manual = manual or ()
        self._raw: dict[date_type, list[tuple[int, Any]]] = {}

    def raw(self, k: date_type) -> list[tuple[int, Any]]:
        if k not in self._raw:
            self._raw[k] = _collapse_refs(self.by_date.get(k))
        return self._raw[k]

    def possible_without_prev(self, k: date_type) -> bool:
        """The checks of can_consume() that need no punch of the day before k: k has punches, neither k nor k-1 is a
        manual day, both are judged by the new rules, and k's first punch is not later than the close-by time."""
        cur = self.raw(k)
        if not cur:
            return False
        prev_day = k - timedelta(days=1)
        if k in self.manual or prev_day in self.manual:
            return False
        if self.in_force is not None and not (self.in_force(k) and self.in_force(prev_day)):
            return False
        return self.close_by_s is None or _minute(cur[0][0]) <= self.close_by_s

    def can_consume(self, k: date_type) -> bool:
        """Could day k's first punch have been used to close day k-1's night, WHATEVER day k-1 itself resolved to? False
        is a sync point: nothing before it can change day k."""
        if not self.possible_without_prev(k):
            return False
        prev = self.raw(k - timedelta(days=1))
        if not prev:
            return False
        # whole minutes at both ends; the open punch of an odd day is always that day's last raw punch
        return (_minute(self.raw(k)[0][0]) + DAY_S - _minute(prev[-1][0])) // 60 <= self.limit_min


def resolve_day(
    by_date: Mapping[date_type, Sequence[tuple[int, Any]]],
    d: date_type,
    hours: int = DEFAULT_SESSION_HOURS,
    lookback: int | None = None,
    close_by_s: int | None = None,
    in_force=None,
    manual=None,
) -> list[tuple[int, Any]]:
    """The punches of shift day `d` once night sessions are resolved: [(seconds since d's midnight, ref)], oldest first.

    `by_date` maps a calendar date to that date's raw punches as (seconds since that date's midnight, anything the
    caller wants back, e.g. the AttendanceLog); a missing date is an empty one, so it should cover d - MAX_CHAIN_DAYS ..
    d + 1 (the callers read the default window and extend it with needs_history()). Double taps are dropped first. See the
    module docstring for the rule: the walk goes back from `d` to the first sync point (at most `lookback`, default
    MAX_CHAIN_DAYS, days; the first day of a capped walk counts as not consumed) and the days are resolved forward from
    there, so one day, a range and a month agree.

    `close_by_s` (seconds since midnight; None = no clock limit), `in_force` (a date -> bool test of the days the new
    rules judge; None = all) and `manual` (dates of manual override days) switch on the guards of the closing-punch rule;
    session_kwargs(ruleset, manual) builds all four from a RuleSet."""
    chain = _Chain(by_date, hours, close_by_s, in_force, manual)
    cap = MAX_CHAIN_DAYS if lookback is None else max(0, int(lookback))
    start, steps = d, 0
    while steps < cap and chain.can_consume(start):
        start -= timedelta(days=1)
        steps += 1
    consumed = False  # the first punch of the day being looked at was used by the day before
    day = start
    while True:
        own = chain.raw(day)
        if consumed:
            own = own[1:]
        nxt_day = day + timedelta(days=1)
        closes = len(own) % 2 == 1 and chain.can_consume(nxt_day)
        if day == d:
            if closes:
                nxt_first = chain.raw(nxt_day)[0]
                return own + [(nxt_first[0] + DAY_S, nxt_first[1])]
            return list(own)
        consumed = closes
        day = nxt_day


def needs_history(
    by_date: Mapping[date_type, Sequence[tuple[int, Any]]],
    d: date_type,
    floor: date_type,
    hours: int = DEFAULT_SESSION_HOURS,
    lookback: int | None = None,
    close_by_s: int | None = None,
    in_force=None,
    manual=None,
) -> bool:
    """True when resolving `d` from `by_date`, which holds the punches from `floor` on, would have to look at days
    BEFORE `floor`: the walk back has not met a sync point yet and is not capped. The caller then reads the punches of
    d - MAX_CHAIN_DAYS .. floor - 1 with one more query. Same keyword arguments as resolve_day."""
    chain = _Chain(by_date, hours, close_by_s, in_force, manual)
    cap = MAX_CHAIN_DAYS if lookback is None else max(0, int(lookback))
    day, steps = d, 0
    while steps < cap:
        if day - timedelta(days=1) < floor:
            return chain.possible_without_prev(day)  # only then do the unread days before `floor` matter
        if not chain.can_consume(day):
            return False
        day -= timedelta(days=1)
        steps += 1
    return False


def resolve_day_times(
    by_date: Mapping[date_type, Sequence], d: date_type, hours: int = DEFAULT_SESSION_HOURS, **kwargs
) -> list[int]:
    """resolve_day for plain punch times: {date: [time | seconds, ...]} -> seconds since d's midnight. `kwargs` are the
    optional guards of resolve_day (close_by_s, in_force, manual, lookback)."""
    converted = {k: [(time_to_s(t), None) for t in v] for k, v in by_date.items()}
    return [s for s, _ref in resolve_day(converted, d, hours, **kwargs)]


def evaluate_with_session(
    ruleset: RuleSet, d: date_type, by_date: Mapping[date_type, Sequence], manual=None
) -> dict | None:
    """The whole pure pipeline for a report: resolve the night session of day `d` from the employee's raw punches and
    evaluate it. None when the new rules do not judge `d` (before the effective date, switched off, no group): the
    caller then uses the legacy calculation on the day's own punches. `manual` = dates of manual override days (their
    punches are never taken from or given to a neighbour)."""
    if not ruleset.applies(d):
        return None
    return evaluate_day(ruleset, d, resolve_day_times(by_date, d, **session_kwargs(ruleset, manual)))


# ── Loading from the database ──────────────────────────────────────────────


def config_applies(config, d: date_type) -> bool:
    """The cheap gate on the config row alone (no query): are the new rules switched on and in force on day `d`?"""
    eff = getattr(config, "rules_effective_from", None)
    return bool(getattr(config, "rules_enabled", True) and eff is not None and d >= eff)


def load_ruleset(config=None) -> RuleSet:
    """The saved rules as a RuleSet: three queries (groups, rules, breaks) on top of the config row. Remembered on the
    config instance, so a loop that shares one config object (a roster day) loads them once."""
    from .models import ProductionBreak, ProductionShiftConfig, ProductionShiftGroup, ProductionShiftRule

    if config is None:
        config = ProductionShiftConfig.get()
    cached = getattr(config, "_production_ruleset", None)
    if cached is not None:
        return cached
    groups = list(ProductionShiftGroup.objects.filter(enabled=True).order_by("order", "id"))
    rules = list(ProductionShiftRule.objects.filter(enabled=True, group__enabled=True).order_by("order", "id"))
    breaks = list(ProductionBreak.objects.filter(enabled=True).order_by("order", "id"))
    ruleset = build_ruleset(config, groups, rules, breaks)
    config._production_ruleset = ruleset
    return ruleset


def rules_for_day(config, d: date_type) -> RuleSet | None:
    """The RuleSet when the new rules judge day `d`, else None (legacy). Loads the tables only when they matter."""
    if not config_applies(config, d):
        return None
    ruleset = load_ruleset(config)
    return ruleset if ruleset.applies(d) else None
