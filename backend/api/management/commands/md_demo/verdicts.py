"""The day verdict of the attendance engine, computed from punches WITHOUT touching the database.

``attendance_final.compute_day_record`` decides a day (present / half shift / absent, late, which arrival zone, how many
shifts) from the day's punches, but it reads and writes the database on every call, far too slow for 45,000
employee-days. The decision itself is made by small pure helpers (``_half_day_status``, ``arrival_rules.zone_of``,
``shift_engine.morning_late_in``, ``_compute_production`` ...). This module calls those same helpers in the same order, so a
day the seeder stores is the day the application would compute again from the same punches. ``tests_md_demo_seed``
recomputes a sample through the real ``compute_day_record`` and compares every stored field.

Scope: the strict 4-punch staff day (the default attendance mode) and the production 1.5-shift day, with no compensation
day and no half-day leave. Approved permissions that are within the monthly cap are supported (the seeder never plans more).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time
from decimal import Decimal

from api.arrival_rules import ZONE_EXCUSED, ZONE_LATE, ZONE_QUARTER, ZONE_SECOND_HALF, explain, limits_for, zone_of
from api.attendance_final import _compute_production, _effective_shift_for_day, _half_day_status, _late_basis_notes
from api.attendance_final import _reason_without
from api.overtime import _ot_minutes_for
from api.shift_engine import (
    ZONE_HALF_SHIFT,
    ZONE_LATE as AFTERNOON_LATE,
    ZONE_PERMISSION,
    _afternoon_late_window_minutes,
    _afternoon_permission_window_minutes,
    _classify_zone,
    _s2t,
    _t2s,
    _t2s_minute,
    evening_early_out,
    morning_late_in,
)

ZERO = Decimal("0")
ONE = Decimal("1.00")


@dataclass(slots=True)
class Day:
    """One employee-day: what happened (the punches) and what the engine made of it (the verdict fields)."""

    status: str
    shifts: Decimal = ZERO
    punches: list[time] = field(default_factory=list)  # distinct, ascending clock times
    is_late: bool = False
    is_half_shift: bool = False
    early_leave: bool = False
    late_afternoon: bool = False
    permission_afternoon: bool = False
    morning_permission_applied: bool = False
    evening_permission_applied: bool = False
    middle_permission_today: bool = False
    arrival_zone: str = ""
    late_reason: str | None = None
    first_punch: time | None = None
    last_punch: time | None = None
    mode: str = "strict"  # strict | production
    source: str = "auto"  # auto | manual (HR override)
    override_by: str | None = None
    override_note: str | None = None
    added_punch: time | None = None  # a punch HR added through an approved Missing Punch request
    persist: bool = True  # False: the day happened but no record of it reached the database (a device outage)
    ot_minutes: int = 0  # staff: minutes the last punch is past the shift end (feeds overtime detection)

    @property
    def attended(self) -> bool:
        return bool(self.punches) or (self.source == "manual" and self.status == "present")


def empty_day(status: str, mode: str) -> Day:
    """A day with no punches: absent, a holiday or weekly off, or on approved leave."""
    return Day(status=status, mode=mode)


# ─── staff: the strict 4-punch day ────────────────────────────────────────────────────────────────────────────


def _strict_punches(times: list[time], shift) -> tuple[time | None, time | None, time | None, time | None]:
    """punch1..punch4 as ``shift_engine.compute_daily_shift_log`` identifies them."""
    p1 = p2 = p3 = p4 = None
    fhe = _t2s(shift.first_half_end)
    if times:
        p1 = times[0]
    for t in times:  # the first punch inside the midday window that is not the first punch
        if fhe - 3600 <= _t2s(t) <= fhe + 3600 and t != p1:
            p2 = t
            break
    if p2:
        for t in times:
            if _t2s(t) > _t2s(p2):
                p3 = t
                break
    if times:
        p4 = times[-1] if times[-1] != p2 else None
    return p1, p2, p3, p4


def staff_verdict(settings, shift, times: list[time], permissions: list[str]) -> Day:
    """The verdict for a staff day with punches in strict mode. ``permissions`` are the kinds of the day's approved,
    in-cap permissions ("morning_late_in", "evening_early_out", "middle_permission")."""
    day_perms = [(None, kind, True) for kind in permissions]
    effective, applied_morning, applied_evening = _effective_shift_for_day(shift, None, day_perms)
    notes = _late_basis_notes(shift, None, applied_morning, applied_evening)
    p1, p2, p3, p4 = _strict_punches(times, shift)

    reasons: list[str] = []
    late_morning = early_leave = False
    if settings.morning_late_in_enabled:
        late_morning, reason = morning_late_in(p1, effective, basis=notes.get("morning"))
        if reason:
            reasons.append(reason)
    if settings.evening_early_out_enabled and len(times) > 1:
        early_leave, reason = evening_early_out(
            times[-1], effective, basis=notes.get("evening"), punch_secs=_t2s(times[-1])
        )
        if reason:
            reasons.append(reason)

    late_afternoon = permission_afternoon = False
    if p2 and p3:  # the lunch-return axis ("Night Late"): informational, never changes the day's value
        window = _afternoon_late_window_minutes(settings=settings)
        grace = _afternoon_permission_window_minutes(settings=settings)
        deadline = _t2s_minute(p2) + (effective.lunch_duration_minutes or 60) * 60
        zone = _classify_zone(max(0, _t2s_minute(p3) - deadline), 0, window * 60, grace * 60)
        if zone in (AFTERNOON_LATE, ZONE_HALF_SHIFT):
            late_afternoon = True
            reasons.append(
                f"Night Late: left {p2.strftime('%H:%M')}, returned {p3.strftime('%H:%M')}, deadline {_s2t(deadline).strftime('%H:%M')}"
            )
        elif zone == ZONE_PERMISSION:
            permission_afternoon = True
            reasons.append(f"Permission (afternoon, Without Permission): returned {p3.strftime('%H:%M')}")
    late_reason = "; ".join(reasons) if reasons else None

    secs = [_t2s(t) for t in times]
    limits = limits_for(shift, settings)
    status, shifts, is_half = _half_day_status(secs, settings, None, limits.first_half_until if limits else None)
    is_late = late_morning
    zone = ""
    if limits is not None and secs:
        zone = zone_of(secs[0], limits, permission_covers=applied_morning)
        if zone != ZONE_LATE:  # the timeline overrules the Late-In check: a day is never charged twice
            is_late = False
            late_reason = _reason_without(late_reason, "Morning Late-In")
        if zone in (ZONE_EXCUSED, ZONE_QUARTER, ZONE_SECOND_HALF):
            note = explain(
                zone, secs[0], limits, applied_morning, settings.arrival_quarter_deduction, deducted=status == "present"
            )
            late_reason = "; ".join(part for part in (note, late_reason) if part)
        if zone == ZONE_QUARTER and status == "present":
            deduction = max(ZERO, min(Decimal(1), Decimal(str(settings.arrival_quarter_deduction))))
            shifts = ONE - deduction

    last_punch = p4 or (times[-1] if len(times) > 1 else None)
    overtime = _ot_minutes_for(last_punch, shift.end_time) if last_punch and status in ("present", "half_shift") else 0
    return Day(
        status=status,
        shifts=Decimal(shifts).quantize(Decimal("0.01")),
        punches=list(times),
        is_late=is_late,
        is_half_shift=is_half,
        early_leave=early_leave,
        late_afternoon=late_afternoon,
        permission_afternoon=permission_afternoon,
        morning_permission_applied=applied_morning,
        evening_permission_applied=applied_evening,
        middle_permission_today="middle_permission" in permissions,
        arrival_zone=zone,
        late_reason=late_reason,
        first_punch=p1,
        last_punch=last_punch,
        mode="strict",
        ot_minutes=overtime,
    )


# ─── production: the 1.5-shift day ────────────────────────────────────────────────────────────────────────────


def production_verdict(config, segments: list, times: list[time]) -> Day:
    """The verdict for a production day with punches: shifts earned from the segments the worked spans cover."""
    computed = _compute_production(None, None, times, None, config, segments)
    return Day(
        status=computed["status"],
        shifts=Decimal(computed["shifts_earned"]).quantize(Decimal("0.01")),
        punches=list(times),
        is_late=bool(computed.get("is_late")),
        is_half_shift=bool(computed.get("is_half_shift")),
        early_leave=bool(computed.get("early_leave")),
        first_punch=computed.get("first_punch"),
        last_punch=computed.get("last_punch"),
        mode="production",
    )
