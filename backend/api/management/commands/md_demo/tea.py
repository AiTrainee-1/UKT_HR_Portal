"""Tea breaks: the OUT / IN scans at the gate kiosks (``TeaBreakLog``).

The Tea Break page of the MD portal asks whether break discipline costs production time, so the data has a clear answer:
most breaks are inside the 15 minutes the rule allows, one department and shift overruns (Stitching on the Extended Shift,
in every unit), a few people overrun again and again, and the last week is worse than the weeks before it.

Only people who were at work scan, and only between their first and last punch of the day. A break that has not been
scanned back in yet (today, or the odd forgotten scan) is left open, exactly as the kiosk leaves it.
"""

from __future__ import annotations

import random
from datetime import datetime, time, timedelta

from api.models import TeaBreakLog

from .common import World, at, chance, clipped_normal, s2t, t2s

ALLOWED_MINUTES = 15
BASELINE_OVERRUN = 0.07
PAIR_OVERRUN = 0.46  # Stitching on the Extended Shift
OFFENDER_OVERRUN = 0.70
WORSE_WEEK_EXTRA = 0.06  # extra overrun chance in the last seven days
PAIR = ("Stitching", "extended")
ADOPTION = {"production": 0.88, "staff": 0.40}  # share of each group that scans at all
NEVER_SCANNED_BACK = 0.0004


def _break_slots(kind: str, shift_key: str) -> list[tuple[time, float]]:
    """(usual start, chance of taking that break) for the morning, afternoon and (long shifts) evening tea."""
    slots = [(time(10, 30), 0.85), (time(15, 35), 0.80)]
    if shift_key == "extended":
        slots.append((time(18, 40), 0.55))
    return slots


def _length(rng: random.Random, overrun: bool, worse: bool) -> float:
    """Minutes the break takes. An overrun is 16 minutes or more; a normal break stays inside the allowance."""
    if overrun:
        return 16 + min(rng.expovariate(1 / (3.5 + (1.5 if worse else 0))), 22)
    return clipped_normal(rng, 11.5, 2.8, 4, 15)


def create_tea_breaks(world: World) -> None:
    world.say("Tea breaks")
    plan = world.plan
    rng = world.streams("tea")
    today = plan.today
    now = at(today, plan.now)
    worse_from = today - timedelta(days=6)
    people = {p.idx: p for p in world.people}
    scans = {p.idx: chance(rng, ADOPTION[p.kind]) for p in world.people}
    rows: list[TeaBreakLog] = []
    for day in sorted(d for d in world.attended if d >= plan.window_start):
        worse = day >= worse_from
        for idx in world.attended[day]:
            if not scans[idx]:
                continue
            p = people[idx]
            record = world.days[idx][day]
            if record.first_punch is None and not record.punches:
                continue
            arrival = record.punches[0] if record.punches else None
            leaving = record.punches[-1] if len(record.punches) > 1 else None
            for start, probability in _break_slots(p.kind, p.shift_key):
                if not chance(rng, probability):
                    continue
                out_clock = s2t(t2s(start) + rng.randint(-14 * 60, 14 * 60))
                if arrival and out_clock <= s2t(t2s(arrival) + 45 * 60):
                    continue
                if leaving and out_clock >= s2t(t2s(leaving) - 15 * 60):
                    continue
                odds = BASELINE_OVERRUN
                if (p.dept, p.shift_key) == PAIR and p.kind == "production":
                    odds = PAIR_OVERRUN
                if "tea_offender" in p.flags:
                    odds = OFFENDER_OVERRUN
                if worse:
                    odds += WORSE_WEEK_EXTRA
                minutes = _length(rng, chance(rng, odds), worse)
                out_at = at(day, out_clock) + timedelta(seconds=rng.randint(0, 59))
                in_at: datetime | None = out_at + timedelta(minutes=minutes, seconds=rng.randint(0, 40))
                if in_at > now or chance(rng, NEVER_SCANNED_BACK):
                    in_at = None  # still on the break, or never scanned back in
                gates = world.gates[p.unit]
                out_gate = rng.choice(gates)
                in_gate = out_gate if chance(rng, 0.9) else rng.choice(gates)
                if out_at > now:
                    continue
                rows.append(
                    TeaBreakLog(
                        employee=p.emp,
                        out_gate=out_gate,
                        out_at=out_at,
                        in_gate=in_gate if in_at else None,
                        in_at=in_at,
                        created_at=out_at,
                    )
                )
    world.insert(TeaBreakLog, rows, batch_size=5000)
    world.stories["teaBreak"] = {
        "overrunningGroup": {"department": PAIR[0], "shift": "Extended Shift", "units": "all"},
        "worseningSince": worse_from.isoformat(),
        "allowedMinutes": ALLOWED_MINUTES,
    }
    world.summary["teaBreaks"] = len(rows)
    world.say(f"  {len(rows):,} tea breaks")
