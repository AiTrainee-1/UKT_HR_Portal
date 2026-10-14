"""
Payroll insights: the rules a payroll is paid under. READ-ONLY, no HTTP.

Two questions are answered here with the same building blocks:

  * "What rules does this kind of payroll run on?" -the Settings page's values, grouped and linked back to the Settings
    block that changes each one (the Rules tab, `settings`);
  * "Which rules was THIS payroll generated with, and have they changed since?" -the details page. Every item carries the
    value in force NOW (`value`), what the payroll was generated with (`applied`, read from the breakdown stored on its
    salary slip) and `changed` when the two differ, so the page can say "changed since this payroll was generated:
    regenerating would price it differently".

Nothing is recomputed: an `applied` value is read from the stored breakdown, a current one from the live settings and the
employee's profile / shift. The only calculations are pure look-ups of the same kind the engine makes (which late slab a
stored count of lates falls in, which production PF/EF band a stored monthly-equivalent pay falls in), so a changed slab
table or band list is detected without touching any payroll.

Which settings an item is read from mirrors the engine: the staff attendance and late rules come from the company-wide
settings row (the attendance engine only ever reads that one), PF / ESI / the OT switch from the employee's own branch
settings (settings_for_employee), and every production rule from the employee's branch settings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from .arrival_rules import limits_for
from .payroll_insights import (
    SETTINGS,
    WEEKDAY_NAMES,
    SettingRef,
    bank_info,
    clock_of,
    cycle_ref,
    dec,
    ddmmyyyy,
    first_half_limit,
    full_name,
    inr,
    plain,
    plural,
    shifts_text,
)
from .payroll_views import _build_working_days, _effective_shift_times, late_shift_deduction
from .production_cycles import (
    CYCLE_DAYS,
    CYCLE_LABELS,
    DEFAULT_MONTHLY_EQUIVALENT_FACTOR,
    MONTHLY_EQUIVALENT_FACTOR,
    cycle_config,
    cycle_late_rules,
)

GROUP_ATTENDANCE = "Attendance & late detection"
GROUP_HALF_DAY = "Half day & permissions"
GROUP_STATUTORY = "Statutory (PF / ESI)"
GROUP_PAY_BASIS = "Pay basis"
GROUP_OVERTIME = "Overtime / Compensation switch"
GROUP_CYCLE = "Pay cycle"
GROUP_PRODUCTION_ATTENDANCE = "Attendance mode & late detection"

_UNSET = object()


# ─────────────────────────────────────────────────────────────────────────────
#  Items
# ─────────────────────────────────────────────────────────────────────────────


def _norm(value):
    """A value in a comparable form: 12 == 12.00 == Decimal('12'), '14:30:00' == time(14, 30)."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return dec(value).normalize()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, str) and re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", value):
        return value[:5].zfill(5)
    if isinstance(value, (list, tuple)):
        return tuple(_norm(v) for v in value)
    return value


def _item(
    key: str,
    label: str,
    source: str,
    *,
    current,
    fmt=str,
    text: str | None = None,
    ref: SettingRef | None = None,
    detail: str | None = None,
    applied=_UNSET,
    applied_fmt=None,
) -> dict:
    """One RuleItem. `current` is the value in force now (compared with `applied`), `text` overrides how it reads. When
    `applied` is given (an explanation of one payroll) the item also says what that payroll was generated with, and
    `changed` when that differs; None means the stored breakdown does not say, which is never reported as a change."""
    out = {
        "key": key,
        "label": label,
        "value": text if text is not None else fmt(current),
        "detail": detail,
        "source": source,
        "settingsPath": ref.path if ref is not None else None,
    }
    if applied is not _UNSET:
        out["applied"] = (applied_fmt or fmt)(applied) if applied is not None else None
        out["changed"] = applied is not None and _norm(current) != _norm(applied)
    return out


def _got(bd: dict | None, *path):
    """What a stored breakdown says at `path`: _UNSET when no payroll is being explained (bd is None), else the value, or
    None when the breakdown does not carry it."""
    if bd is None:
        return _UNSET
    node = bd
    for step in path:
        if not isinstance(node, dict):
            return None
        node = node.get(step)
    return node


def _on_off(value) -> str:
    return "On" if value else "Off"


def _minutes(value) -> str:
    return f"{int(value)} min"


def _free_marks(value) -> str:
    return f"{plural(int(value), 'free mark')} a month"


def _free_late_days(value) -> str:
    return f"{plural(int(value), 'free late day')} a period"


def _permission_cap(value) -> str:
    return f"Cap of {plural(int(value), 'approved permission')} a month"


def _period_pct(value) -> str:
    """A production PF / ESI rate as it applied to a period's pay ('Not deducted' for 0)."""
    return "Not deducted" if dec(value) == 0 else f"{_pct(value)} of the period pay"


def _production_rate_text(ps, flat_rate) -> str:
    """How a production worker's PF / ESI is worked out under the settings in force: salary bands when they are in use,
    else the flat rate while its switch is on, else not at all."""
    if ps.prod_pf_ef_enabled:
        return "By salary band (the flat rate when no band fits)" if ps.prod_payroll_rules_enabled else "By salary band"
    if ps.prod_payroll_rules_enabled and dec(flat_rate) > 0:
        return _period_pct(flat_rate)
    return "Not deducted: the flat-rate switch is off and no salary bands are in use"


def _pct(value) -> str:
    return f"{plain(value)}%"


def _inr_or_unset(value) -> str:
    return "Not set" if value is None else inr(value)


def _attendance_mode(value) -> str:
    return {"strict": "Strict (4-punch)", "simple": "Simple (first and last punch)"}.get(str(value), str(value))


def _group(name: str, items: list[dict]) -> dict:
    return {"group": name, "items": items}


def _assemble(*groups: tuple[str, list[dict]]) -> list[dict]:
    """Groups in the order given, without the ones that ended up empty."""
    return [_group(name, items) for name, items in groups if items]


# ── slabs ────────────────────────────────────────────────────────────────────


def slab_rows(slabs) -> list[tuple[int, Decimal]]:
    """The usable rows of a late deduction table, ascending (a malformed row is skipped, as the engine skips it)."""
    rows: list[tuple[int, Decimal]] = []
    for row in slabs or []:
        if not isinstance(row, dict):
            continue
        try:
            rows.append((int(row["fromLates"]), Decimal(str(row["deductionShifts"]))))
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue
    rows.sort(key=lambda r: r[0])
    return rows


def describe_slabs(slabs, noun: str) -> str:
    """'From 3 billable lates: 0.25 shift; from 6: 0.5 shift; ...': the table in words (no rows: nothing is deducted)."""
    rows = slab_rows(slabs)
    if not rows:
        return f"No slabs: a {noun} costs nothing"
    shown = rows if len(rows) <= 4 else [*rows[:3], None, rows[-1]]
    parts = []
    for index, row in enumerate(shown):
        if row is None:
            parts.append("...")
            continue
        count, cut = row
        lead = f"From {plural(count, 'billable ' + noun)}" if index == 0 else f"from {count}"
        parts.append(f"{lead}: {shifts_text(cut)}")
    text = "; ".join(parts)
    return f"{text} ({len(rows)} slabs)" if len(rows) > 4 else text


def _slab_item(key, label, ref, current_slabs, noun, bd_summary, with_applied: bool, detail: str) -> dict:
    """The late deduction table. It is not stored on the payroll, so `applied` is what the payroll actually paid for its
    billable lates, and `changed` is true when the table as it stands now would price those lates differently."""
    item = _item(key, label, "settings", current=None, text=describe_slabs(current_slabs, noun), ref=ref, detail=detail)
    if not with_applied:
        return item
    billable = (bd_summary or {}).get("billableLateCount")
    stored = (bd_summary or {}).get("shiftDeductions")
    if billable is None or stored is None:
        item["applied"], item["changed"] = None, False
        return item
    now = late_shift_deduction(int(billable), None, slabs=list(current_slabs or []))
    item["applied"] = f"{plural(billable, 'billable ' + noun)} cost {shifts_text(stored)}"
    item["changed"] = dec(now) != dec(stored)
    if item["changed"]:
        item["detail"] = (
            f"{detail}. The slabs as they stand now would take {shifts_text(now)} for those {plural(billable, noun)}"
        )
    return item


# ─────────────────────────────────────────────────────────────────────────────
#  Staff
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class StaffRuleInput:
    """What the staff rule builders read: the employee, the month, the settings that govern them (the company row and
    their own branch's), their shift assignment and the month's holidays; `bd` is the stored breakdown of the payroll
    being explained, or None on the Rules tab (current values only)."""

    emp: object
    month: int
    year: int
    base: object
    ps: object
    assignment: object | None
    holidays: set[date] = field(default_factory=set)
    bd: dict | None = None

    @property
    def shift(self):
        return self.assignment.shift if self.assignment is not None else None

    def shift_times(self):
        """(start, end, grace, saturday_off) of the assigned shift, or (None, None, None, False)."""
        if self.assignment is None:
            return None, None, None, False
        return _effective_shift_times(self.assignment)

    def working_days(self) -> int:
        return len(_build_working_days(self.month, self.year, self.shift_times()[3], self.holidays))


def staff_chips(emp, ps, inp: StaffRuleInput) -> list[dict]:
    """The short, coloured facts about one staff member's rules for the table: shift, Saturday, PF, ESI, bank."""
    chips = []
    start, end, _grace, saturday_off = inp.shift_times()
    if inp.assignment is None:
        chips.append({"key": "shift", "label": "No shift", "tone": "warning"})
    else:
        label = f"{inp.shift.name} {start.strftime('%H:%M')}-{end.strftime('%H:%M')}"
        chips.append({"key": "shift", "label": label, "tone": "info"})
        if saturday_off:
            chips.append({"key": "saturday_off", "label": "Saturday off", "tone": "neutral"})
    pf_on = bool(ps.staff_payroll_rules_enabled) and dec(ps.pf_rate) > 0
    chips.append({"key": "pf", "label": f"PF {_pct(ps.pf_rate)}" if pf_on else "No PF", "tone": "neutral"})
    esi_on = bool(ps.staff_payroll_rules_enabled) and dec(ps.esi_rate) > 0
    if not esi_on:
        chips.append({"key": "esi", "label": "No ESI", "tone": "neutral"})
    elif emp.salary_amount is not None and dec(emp.salary_amount) > dec(ps.esi_applicable_below):
        chips.append({"key": "esi", "label": "ESI above ceiling", "tone": "neutral"})
    else:
        chips.append({"key": "esi", "label": f"ESI {_pct(ps.esi_rate)}", "tone": "neutral"})
    bank = bank_info(emp)
    if not bank["hasAccount"] or not bank["hasIfsc"]:
        chips.append({"key": "bank", "label": "No bank details", "tone": "warning"})
    return chips


def staff_flags(emp, inp: StaffRuleInput) -> list[str]:
    flags = []
    if inp.assignment is None:
        flags.append("no_shift")
    if emp.salary_amount is None or dec(emp.salary_amount) <= 0:
        flags.append("no_rate")
    bank = bank_info(emp)
    if not bank["hasAccount"] or not bank["hasIfsc"]:
        flags.append("no_bank")
    return flags


def _inferred_rules_switch(bd: dict | None) -> bool | None:
    """Whether the staff PF / ESI switch was on when a payroll was generated, as far as the stored numbers show: a PF or
    ESI amount means on; a configured rate with nothing deducted from real pay means off; otherwise it cannot be told."""
    if bd is None:
        return None
    d, e = bd.get("deductions") or {}, bd.get("earnings") or {}
    if dec(d.get("pf")) > 0 or dec(d.get("esi")) > 0:
        return True
    if dec(d.get("pfRate")) > 0 and dec(e.get("basic")) > 0:
        return False
    if (
        dec(d.get("esiRate")) > 0
        and dec(e.get("monthlySalary")) <= dec(d.get("esiApplicableBelow"))
        and dec(e.get("grossSalary")) > 0
    ):
        return False
    return None


def staff_rule_groups(inp: StaffRuleInput, company: bool = True) -> list[dict]:
    """The rules one staff member is paid under, grouped. With `company` the company-wide rules are included (the
    details page); without it only what is specific to this employee (the Rules tab's employee table: shift, calendar,
    salary basis, PF / ESI). `inp.bd` makes it an explanation of one payroll (each item gets applied / changed)."""
    emp, base, ps, bd = inp.emp, inp.base, inp.ps, inp.bd
    start, end, grace, saturday_off = inp.shift_times()
    shift = inp.shift
    attendance: list[dict] = []
    half_day: list[dict] = []
    statutory: list[dict] = []
    pay: list[dict] = []
    overtime: list[dict] = []

    # ── this employee's shift ──
    stored_shift = _got(bd, "shift")
    current_shift = (shift.id if shift else None, start.strftime("%H:%M") if start else None, grace)
    applied_shift = (
        _UNSET
        if stored_shift is _UNSET
        else (
            None
            if not isinstance(stored_shift, dict)
            else (stored_shift.get("id"), stored_shift.get("startTime"), stored_shift.get("gracePeriodMinutes"))
        )
    )

    def shift_text(parts, name):
        if parts is None or parts[0] is None:
            return "No shift assigned"
        return f"{name}, starts {parts[1]}, {parts[2]} min grace"

    attendance.append(
        _item(
            "shift",
            "Assigned shift",
            "shift",
            current=current_shift,
            text=shift_text(current_shift, shift.name if shift else None),
            detail=(
                f"Works {start.strftime('%H:%M')}-{end.strftime('%H:%M')}. Late-In and Early-Out are judged against it"
                if shift
                else "Late-In, Early-Out and the arrival timeline cannot be applied without a shift: assign one in Manage Shifts"
            ),
            applied=applied_shift,
            applied_fmt=lambda parts: shift_text(parts, (stored_shift or {}).get("name")),
        )
    )
    attendance.append(
        _item(
            "saturday_off",
            "Saturday",
            "shift",
            current=bool(saturday_off),
            text="Saturday is a day off" if saturday_off else "Saturday is a working day",
            detail="Decided by the shift assignment; it changes how many working days the month has",
            applied=_got(bd, "shift", "saturdayOff"),
            applied_fmt=lambda v: "Saturday is a day off" if v else "Saturday is a working day",
        )
    )
    if company:
        attendance.append(
            _item(
                "attendance_mode",
                "Attendance mode",
                "settings",
                current=base.attendance_mode,
                fmt=_attendance_mode,
                ref=SETTINGS["attendance_mode"],
                detail="Full Day, Half Day, Absent, Late and Early Out are decided the same way in both modes",
                applied=_got(bd, "attendanceMode"),
            )
        )
        attendance.append(
            _item(
                "morning_late_in",
                "Morning Late-In",
                "settings",
                current=bool(base.morning_late_in_enabled),
                fmt=_on_off,
                ref=SETTINGS["morning_late_in"],
                detail="A first punch after shift start + grace, inside the Late window, is one mark in the monthly late pool",
                applied=None if bd is not None else _UNSET,
            )
        )
        attendance.append(
            _item(
                "evening_early_out",
                "Evening Early-Out",
                "settings",
                current=bool(base.evening_early_out_enabled),
                fmt=_on_off,
                ref=SETTINGS["evening_early_out"],
                detail="A last punch before shift end - grace is one mark in the same monthly pool",
                applied=None if bd is not None else _UNSET,
            )
        )
        for key, label, field_name, setting, detail in (
            (
                "late_window",
                "Late window",
                "arrival_late_window_minutes",
                "late_window",
                "Minutes after shift start + grace that an arrival is only Late",
            ),
            (
                "permission_window",
                "Permission window",
                "arrival_permission_window_minutes",
                "permission_window",
                "Minutes after the Late window that an approved, in-cap Morning Late-In permission still excuses",
            ),
            (
                "extra_minutes",
                "Extra minutes",
                "arrival_extra_minutes",
                "extra_minutes",
                "A last stretch that still counts as the first half but always takes the quarter-shift deduction",
            ),
        ):
            stored_key = {
                "late_window": "lateWindowMinutes",
                "permission_window": "permissionWindowMinutes",
                "extra_minutes": "extraMinutes",
            }[key]
            attendance.append(
                _item(
                    key,
                    label,
                    "settings",
                    current=getattr(base, field_name),
                    fmt=_minutes,
                    ref=SETTINGS[setting],
                    detail=detail,
                    applied=_got(bd, "arrivalTimeline", stored_key),
                )
            )
        attendance.append(
            _item(
                "quarter_deduction",
                "Quarter-shift deduction",
                "settings",
                current=base.arrival_quarter_deduction,
                fmt=shifts_text,
                ref=SETTINGS["quarter_deduction"],
                detail="Taken off the day for an arrival after the Late window that no permission covers",
                applied=_got(bd, "arrivalTimeline", "quarterDeduction"),
            )
        )
        attendance.append(
            _item(
                "late_free_allowance",
                "Free late marks a month",
                "settings",
                current=base.late_free_allowance,
                text=_free_marks(base.late_free_allowance),
                ref=SETTINGS["late_free_allowance"],
                detail="Late, Early Out and excess permissions share one pool: only marks beyond this are priced",
                applied=_got(bd, "deductions", "lateSummary", "freeAllowance"),
                applied_fmt=_free_marks,
            )
        )
        attendance.append(
            _slab_item(
                "late_slabs",
                "Late deduction slabs",
                SETTINGS["late_slabs"],
                base.late_deduction_slabs,
                "late mark",
                _got(bd, "deductions", "lateSummary") if bd is not None else None,
                bd is not None,
                "The highest slab the billable count reaches applies; the last slab holds beyond it",
            )
        )

    # ── half day & permissions ──
    # The limit is measured from the assignment's own start (a per-employee override beats the template), as the engine does.
    limits = (
        limits_for(SimpleNamespace(start_time=start, grace_period_minutes=grace), base) if shift is not None else None
    )
    current_limit = clock_of(limits.first_half_until // 60) if limits else None
    half_day.append(
        _item(
            "first_half_limit",
            "Latest arrival that counts as the morning half",
            "shift",
            current=current_limit,
            text=(
                f"{current_limit} (shift start + grace + Late window + permission window + extra minutes)"
                if current_limit
                else "No limit without a shift: the fixed first-half cut-off applies"
            ),
            detail="An arrival after it misses the morning half: Absent until a second-half punch, then Half Day",
            applied=first_half_limit(bd) if bd is not None else _UNSET,
        )
    )
    if company:
        stored_shift_id = (stored_shift or {}).get("id") if isinstance(stored_shift, dict) else None
        if shift is None or (isinstance(stored_shift, dict) and stored_shift_id is None):
            # The fixed cut-off each shift's own limit replaced: still what decides the morning half for a worker with no shift.
            half_day.append(
                _item(
                    "first_half_fixed_end",
                    "First half ends at (workers with no shift)",
                    "settings",
                    current=base.half_day_first_half_end_time,
                    fmt=lambda v: _norm(v),
                    detail="Retired for workers with a shift, whose own limit is used; a worker with no shift is judged against this time",
                    applied=_got(bd, "halfDayFirstHalfEndTime"),
                )
            )
        half_day.append(
            _item(
                "second_half_start",
                "Second half starts at",
                "settings",
                current=base.half_day_second_half_start_time,
                fmt=lambda v: _norm(v),
                ref=SETTINGS["second_half_start"],
                detail="A punch at or after this time counts as having worked the evening half",
                applied=_got(bd, "halfDaySecondHalfStartTime"),
            )
        )
        half_day.append(
            _item(
                "permission_cap",
                "Permission monthly cap",
                "settings",
                current=base.permission_monthly_cap,
                text=_permission_cap(base.permission_monthly_cap),
                ref=SETTINGS["permission_cap"],
                detail="Approved permissions up to the cap protect a day; one beyond it excuses nothing and adds one mark to the late pool",
                applied=_got(bd, "deductions", "lateSummary", "permissionMonthlyCap"),
                applied_fmt=_permission_cap,
            )
        )

    # ── PF / ESI (the employee's own branch settings) ──
    rules_on = bool(ps.staff_payroll_rules_enabled)
    salary = emp.salary_amount
    ceiling = dec(ps.esi_applicable_below)
    if company:
        statutory.append(
            _item(
                "pf_esi_switch",
                "Deduct PF and ESI from staff pay",
                "settings",
                current=rules_on,
                fmt=_on_off,
                ref=SETTINGS["staff_pf_esi_switch"],
                detail="While it is off no staff payslip gets a PF or ESI deduction, whatever the rates are",
                applied=_inferred_rules_switch(bd) if bd is not None else _UNSET,
            )
        )
    pf_text = (
        f"{_pct(ps.pf_rate)} of Basic"
        if rules_on and dec(ps.pf_rate) > 0
        else ("Not deducted: the PF / ESI switch is off" if not rules_on else "Not deducted: the PF rate is 0%")
    )
    statutory.append(
        _item(
            "pf_rate",
            "PF",
            "settings",
            current=ps.pf_rate,
            text=pf_text,
            ref=SETTINGS["staff_pf_rate"],
            detail="Basic is fixed at 50% of the salary earned in the month, whatever Salary Split is recorded",
            applied=_got(bd, "deductions", "pfRate"),
            applied_fmt=lambda v: f"{_pct(v)} of Basic",
        )
    )
    if not rules_on or dec(ps.esi_rate) <= 0:
        esi_text = "Not deducted: the PF / ESI switch is off" if not rules_on else "Not deducted: the ESI rate is 0%"
    elif salary is not None and dec(salary) > ceiling:
        esi_text = f"Not applicable: the salary {inr(salary)} is above the ESI ceiling {inr(ceiling)}"
    else:
        esi_text = f"{_pct(ps.esi_rate)} of the pay earned"
    statutory.append(
        _item(
            "esi_rate",
            "ESI",
            "settings",
            current=ps.esi_rate,
            text=esi_text,
            ref=SETTINGS["staff_esi_rate"],
            detail="Applies while the full monthly salary is at or below the ESI ceiling",
            applied=_got(bd, "deductions", "esiRate"),
            applied_fmt=lambda v: f"{_pct(v)} of the pay earned",
        )
    )
    if company:
        statutory.append(
            _item(
                "esi_ceiling",
                "ESI ceiling",
                "settings",
                current=ceiling,
                fmt=inr,
                ref=SETTINGS["staff_esi_ceiling"],
                detail="A salary equal to the ceiling still pays ESI",
                applied=_got(bd, "deductions", "esiApplicableBelow"),
            )
        )

    # ── pay basis (the profile and the calendar) ──
    working_now = inp.working_days()
    pay.append(
        _item(
            "monthly_salary",
            "Monthly salary",
            "employee",
            current=salary,
            fmt=_inr_or_unset,
            detail="Pay is this amount, shared over the month's working days, times the days paid",
            applied=_got(bd, "earnings", "monthlySalary"),
            applied_fmt=inr,
        )
    )
    pay.append(
        _item(
            "working_days",
            "Working days in the month",
            "shift",
            current=working_now,
            text=f"{working_now} working days",
            detail="Sundays, company holidays and (when the shift has Saturday off) Saturdays are not working days",
            applied=_got(bd, "summary", "totalWorkingDays"),
            applied_fmt=lambda v: f"{int(v)} working days",
        )
    )
    daily_now = (dec(salary) / working_now).quantize(Decimal("0.01")) if salary is not None and working_now else None
    pay.append(
        _item(
            "daily_rate",
            "Daily rate",
            "employee",
            current=daily_now,
            fmt=_inr_or_unset,
            detail="The monthly salary divided by the working days: what a late or half-day mark is priced in",
            applied=_got(bd, "earnings", "dailyRate"),
            applied_fmt=_inr_or_unset,
        )
    )

    if company:
        overtime.append(
            _item(
                "compensation_features",
                "OT & Compensation features",
                "settings",
                current=bool(ps.compensation_feature_enabled),
                fmt=_on_off,
                ref=SETTINGS["compensation_features"],
                detail=(
                    "When on, assigned Pay-type overtime adds shifts x one day's pay to the payroll (an older announced "
                    "record is one whole day)"
                ),
                applied=(True if dec(_got(bd, "earnings", "otAmount")) > 0 else None) if bd is not None else _UNSET,
            )
        )

    return _assemble(
        (GROUP_ATTENDANCE, attendance),
        (GROUP_HALF_DAY, half_day),
        (GROUP_STATUTORY, statutory),
        (GROUP_PAY_BASIS, pay),
        (GROUP_OVERTIME, overtime),
    )


def staff_settings_groups(base, ps) -> list[dict]:
    """The Settings page rules staff payroll uses, grouped, each with the Settings block that changes it. `base` is the
    company row (attendance and late rules), `ps` the settings of the caller's branch (PF / ESI / overtime)."""
    attendance = [
        _item(
            "attendance_mode",
            "Attendance mode",
            "settings",
            current=base.attendance_mode,
            fmt=_attendance_mode,
            ref=SETTINGS["attendance_mode"],
            detail="Strict also tracks the lunch return; Full Day, Half Day, Absent, Late and Early Out are decided the same way in both",
        ),
        _item(
            "morning_late_in",
            "Morning Late-In",
            "settings",
            current=bool(base.morning_late_in_enabled),
            fmt=_on_off,
            ref=SETTINGS["morning_late_in"],
            detail="A first punch after shift start + grace, inside the Late window, is one mark in the monthly late pool",
        ),
        _item(
            "evening_early_out",
            "Evening Early-Out",
            "settings",
            current=bool(base.evening_early_out_enabled),
            fmt=_on_off,
            ref=SETTINGS["evening_early_out"],
            detail="A last punch before shift end - grace is one mark in the same monthly pool",
        ),
        _item(
            "late_window",
            "Late window",
            "settings",
            current=base.arrival_late_window_minutes,
            fmt=_minutes,
            ref=SETTINGS["late_window"],
            detail="Minutes after shift start + grace that an arrival is only Late: the day stays a Full Day",
        ),
        _item(
            "permission_window",
            "Permission window",
            "settings",
            current=base.arrival_permission_window_minutes,
            fmt=_minutes,
            ref=SETTINGS["permission_window"],
            detail="Minutes after the Late window that an approved, in-cap Morning Late-In permission still excuses",
        ),
        _item(
            "extra_minutes",
            "Extra minutes",
            "settings",
            current=base.arrival_extra_minutes,
            fmt=_minutes,
            ref=SETTINGS["extra_minutes"],
            detail="A last stretch that still counts as the first half but always takes the quarter-shift deduction",
        ),
        _item(
            "quarter_deduction",
            "Quarter-shift deduction",
            "settings",
            current=base.arrival_quarter_deduction,
            fmt=shifts_text,
            ref=SETTINGS["quarter_deduction"],
            detail="Taken off the day for an arrival after the Late window that no permission covers",
        ),
        _item(
            "late_free_allowance",
            "Free late marks a month",
            "settings",
            current=base.late_free_allowance,
            text=_free_marks(base.late_free_allowance),
            ref=SETTINGS["late_free_allowance"],
            detail="Late, Early Out and excess permissions share one pool: only the marks beyond this are priced",
        ),
        _item(
            "late_slabs",
            "Late deduction slabs",
            "settings",
            current=None,
            text=describe_slabs(base.late_deduction_slabs, "late mark"),
            ref=SETTINGS["late_slabs"],
            detail="The highest slab the billable count reaches applies; the last slab holds beyond it",
        ),
    ]
    half_day = [
        _item(
            "second_half_start",
            "Second half starts at",
            "settings",
            current=base.half_day_second_half_start_time,
            fmt=lambda v: _norm(v),
            ref=SETTINGS["second_half_start"],
            detail="A punch at or after this time counts as having worked the evening half",
        ),
        _item(
            "first_half_limit",
            "Latest arrival that counts as the morning half",
            "settings",
            current=None,
            text="Shift start + grace + Late window + permission window + extra minutes",
            detail="Worked out from each employee's own shift: see the employee table",
        ),
        _item(
            "permission_cap",
            "Permission monthly cap",
            "settings",
            current=base.permission_monthly_cap,
            text=_permission_cap(base.permission_monthly_cap),
            ref=SETTINGS["permission_cap"],
            detail="Approved permissions up to the cap protect a day; one beyond it excuses nothing and adds one mark to the late pool",
        ),
    ]
    statutory = [
        _item(
            "pf_esi_switch",
            "Deduct PF and ESI from staff pay",
            "settings",
            current=bool(ps.staff_payroll_rules_enabled),
            fmt=_on_off,
            ref=SETTINGS["staff_pf_esi_switch"],
            detail="While it is off no staff payslip gets a PF or ESI deduction, whatever the rates are",
        ),
        _item(
            "pf_rate",
            "PF rate",
            "settings",
            current=ps.pf_rate,
            text=f"{_pct(ps.pf_rate)} of Basic",
            ref=SETTINGS["staff_pf_rate"],
            detail="Basic is fixed at 50% of the salary earned in the month, whatever Salary Split is recorded",
        ),
        _item(
            "esi_rate",
            "ESI rate",
            "settings",
            current=ps.esi_rate,
            text=f"{_pct(ps.esi_rate)} of the pay earned",
            ref=SETTINGS["staff_esi_rate"],
            detail="Applies while the full monthly salary is at or below the ESI ceiling",
        ),
        _item(
            "esi_ceiling",
            "ESI ceiling",
            "settings",
            current=ps.esi_applicable_below,
            fmt=inr,
            ref=SETTINGS["staff_esi_ceiling"],
            detail="A salary equal to the ceiling still pays ESI",
        ),
    ]
    pay = [
        _item(
            "pay_basis",
            "How salary is worked out",
            "settings",
            current=None,
            text="Monthly salary / working days x days paid",
            detail="Sundays and company holidays are not working days (nor Saturdays on a shift with Saturday off). A half day pays 0.5 and a quarter-shift arrival 0.75. Basic is 50% of the salary earned",
        ),
        _item(
            "pay_day",
            "Salary pay day",
            "settings",
            current=ps.pay_day,
            text=f"Day {int(ps.pay_day)} of the month",
            ref=SETTINGS["pay_day"],
            detail="The day last month's salary should be paid by; it only warns on the MD portal and changes no pay",
        ),
    ]
    # read-only: a missing row is read as the defaults and never created by a GET
    from .models import CompensationConfig

    cfg = CompensationConfig.objects.filter(pk=1).first() or CompensationConfig()
    overtime = [
        _item(
            "compensation_features",
            "OT & Compensation features",
            "settings",
            current=bool(ps.compensation_feature_enabled),
            fmt=_on_off,
            ref=SETTINGS["compensation_features"],
            detail=(
                "The master switch of every OT and Compensation feature below. When on, assigned Pay-type overtime adds "
                "shifts x one day's pay to the payslip"
            ),
        ),
        _item(
            "ot_allowance",
            "Next-day late-in allowance (Type 1)",
            "settings",
            current=bool(cfg.allowance_enabled),
            fmt=_on_off,
            ref=SETTINGS["ot_allowance"],
            detail="Staff who work extra after the shift end may arrive later next morning without a Late mark; automatic, never paid",
        ),
        _item(
            "ot_shift",
            "Shift-based OT compensation (Type 2)",
            "settings",
            current=bool(cfg.shift_enabled),
            fmt=_on_off,
            ref=SETTINGS["ot_shift"],
            detail="Flags staff who work well past their shift end so HR can assign 0.25 to 1 shift as relaxation or pay; a flag alone pays nothing",
        ),
        _item(
            "ot_shift_threshold",
            "Type 2 starts after",
            "settings",
            current=cfg.shift_min_extra_minutes,
            fmt=_minutes,
            ref=SETTINGS["ot_shift_threshold"],
            detail="Minutes past the shift end a last punch must be for the day to need an HR decision (Type 1 covers less)",
        ),
        _item(
            "ot_shift_pay",
            "Type 2 as payment",
            "settings",
            current=bool(cfg.pay_enabled),
            fmt=_on_off,
            ref=SETTINGS["ot_shift_pay"],
            detail="Whether HR may give Type 2 as money (shifts x one day's pay); relaxation is a separate switch",
        ),
    ]
    return _assemble(
        (GROUP_ATTENDANCE, attendance),
        (GROUP_HALF_DAY, half_day),
        (GROUP_STATUTORY, statutory),
        (GROUP_PAY_BASIS, pay),
        (GROUP_OVERTIME, overtime),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Production
# ─────────────────────────────────────────────────────────────────────────────


def production_rule_now(ps, monthly_equivalent) -> tuple[dict | None, Decimal, Decimal]:
    """(salary band, PF %, ESI/EF %) the CURRENT settings would apply to a production pay whose monthly-equivalent is
    `monthly_equivalent`: the same order the engine uses (a matching band, else the flat rates while their switch is on,
    else nothing). Only used to tell whether a payroll's stored rate has been overtaken by a settings change."""
    equivalent = dec(monthly_equivalent)
    if ps.prod_pf_ef_enabled:
        for rule in ps.prod_pf_ef_rules or []:
            try:
                low = Decimal(str(rule.get("minSalary", 0) or 0))
                high = Decimal(str(rule.get("maxSalary", 0) or 0))
            except Exception:
                continue
            if equivalent >= low and (high <= 0 or equivalent <= high):
                return rule, dec(rule.get("pfRate") or 0), dec(rule.get("efRate") or 0)
    if ps.prod_payroll_rules_enabled:
        esi = (
            dec(ps.prod_esi_rate)
            if dec(ps.prod_esi_rate) > 0 and equivalent <= dec(ps.prod_esi_applicable_below)
            else Decimal("0")
        )
        return None, dec(ps.prod_pf_rate), esi
    return None, Decimal("0"), Decimal("0")


def describe_bands(rules) -> list[str]:
    """One line per production PF / EF salary band: 'Mid: Rs 10,001 to Rs 20,000: PF 12%, EF 1%'."""
    out = []
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue
        high = dec(rule.get("maxSalary") or 0)
        span = (
            f"{inr(rule.get('minSalary') or 0)} to {inr(high)}"
            if high > 0
            else f"{inr(rule.get('minSalary') or 0)} and above"
        )
        out.append(
            f"{rule.get('label') or 'Salary band'}: {span}: PF {_pct(rule.get('pfRate') or 0)}, EF {_pct(rule.get('efRate') or 0)}"
        )
    return out


@dataclass
class ProductionRuleInput:
    """What the production rule builders read: the employee, the pay cycle and period, their branch's settings, the
    production shift assigned to them and (when explaining a payroll) its stored breakdown."""

    emp: object
    cycle: str | None
    period_start: date
    period_end: date
    ps: object
    assignment: object | None
    bd: dict | None = None

    @property
    def shift(self):
        return self.assignment.shift if self.assignment is not None else None


def production_chips(emp, ps, inp: ProductionRuleInput) -> list[dict]:
    chips = []
    if emp.production_pay_cycle in CYCLE_LABELS:
        chips.append({"key": "cycle", "label": CYCLE_LABELS[emp.production_pay_cycle], "tone": "accent"})
    else:
        chips.append({"key": "cycle", "label": "No pay cycle", "tone": "danger"})
    if emp.salary_per_shift is None or dec(emp.salary_per_shift) <= 0:
        chips.append({"key": "rate", "label": "No rate", "tone": "danger"})
    else:
        chips.append({"key": "rate", "label": f"{inr(emp.salary_per_shift)} / shift", "tone": "info"})
    if inp.assignment is None:
        chips.append({"key": "shift", "label": "No shift", "tone": "warning"})
    else:
        start, end, _grace, _sat = _effective_shift_times(inp.assignment)
        chips.append(
            {
                "key": "shift",
                "label": f"{inp.shift.name} {start.strftime('%H:%M')}-{end.strftime('%H:%M')}",
                "tone": "info",
            }
        )
    if ps.prod_pf_ef_enabled:
        chips.append({"key": "statutory", "label": "PF / EF by salary band", "tone": "neutral"})
    elif ps.prod_payroll_rules_enabled and (dec(ps.prod_pf_rate) > 0 or dec(ps.prod_esi_rate) > 0):
        chips.append({"key": "statutory", "label": f"PF {_pct(ps.prod_pf_rate)}", "tone": "neutral"})
    else:
        chips.append({"key": "statutory", "label": "No PF / ESI", "tone": "neutral"})
    bank = bank_info(emp)
    if not bank["hasAccount"] or not bank["hasIfsc"]:
        chips.append({"key": "bank", "label": "No bank details", "tone": "warning"})
    return chips


def production_flags(emp, inp: ProductionRuleInput) -> list[str]:
    flags = []
    if inp.assignment is None:
        flags.append("no_shift")
    if emp.salary_per_shift is None or dec(emp.salary_per_shift) <= 0:
        flags.append("no_rate")
    if emp.production_pay_cycle not in CYCLE_LABELS:
        flags.append("no_cycle")
    bank = bank_info(emp)
    if not bank["hasAccount"] or not bank["hasIfsc"]:
        flags.append("no_bank")
    return flags


def _cycle_text(cycle) -> str:
    return f"{CYCLE_LABELS[cycle]} ({CYCLE_DAYS[cycle]} days)" if cycle in CYCLE_LABELS else "No pay cycle assigned"


def production_rule_groups(inp: ProductionRuleInput, company: bool = True) -> list[dict]:
    """The rules one production worker is paid under, grouped (see staff_rule_groups for `company` and `inp.bd`)."""
    emp, ps, bd, cycle = inp.emp, inp.ps, inp.bd, inp.cycle
    cfg = cycle_config(ps, cycle) if cycle in CYCLE_LABELS else None
    pay_cycle: list[dict] = []
    attendance: list[dict] = []
    statutory: list[dict] = []
    pay: list[dict] = []

    # ── pay cycle ──
    pay_cycle.append(
        _item(
            "pay_cycle",
            "Pay cycle",
            "cycle",
            current=emp.production_pay_cycle,
            fmt=_cycle_text,
            detail="Assigned on Employees > Production Employees; the cycle decides the pay period and the late rules",
            applied=cycle if bd is not None else _UNSET,
            applied_fmt=_cycle_text,
        )
    )
    if company and cfg is not None:
        pay_cycle.append(
            _item(
                "week_start",
                "Week starts on",
                "settings",
                current=cfg.week_start,
                text=cfg.week_start.capitalize(),
                ref=cycle_ref(cycle, "week_start"),
                detail="A week ends on the day before its start weekday comes round again",
                applied=WEEKDAY_NAMES[inp.period_start.weekday()].lower() if bd is not None else _UNSET,
                applied_fmt=str.capitalize,
            )
        )
        pay_cycle.append(
            _item(
                "first_period",
                "First period starts on",
                "settings",
                current=cfg.anchor_date,
                text=ddmmyyyy(cfg.anchor_date)
                if cfg.anchor_date
                else ("Not needed for Weekly" if cycle == "weekly" else "Not set"),
                ref=cycle_ref(cycle, "first_period"),
                detail="The date the periods are counted from, moved back to the start weekday (optional for Weekly)",
                applied=None if bd is not None else _UNSET,
            )
        )
        factor = MONTHLY_EQUIVALENT_FACTOR.get(cycle, DEFAULT_MONTHLY_EQUIVALENT_FACTOR)
        pay_cycle.append(
            _item(
                "monthly_factor",
                "Monthly-equivalent factor",
                "cycle",
                current=factor,
                text=f"x{factor}",
                detail="A period's pay is multiplied by this before it is compared with the monthly PF / ESI bands and the ESI ceiling",
                applied=_got(bd, "deductions", "monthlyEquivalentFactor"),
                applied_fmt=lambda v: f"x{int(v)}",
            )
        )

    # ── attendance mode & late detection ──
    if company:
        # A production payroll stores its late summary only while late detection was on, so its presence says it was.
        applied_switch = _UNSET if bd is None else ((_got(bd, "deductions", "lateSummary") is not None) if bd else None)
        attendance.append(
            _item(
                "late_switch",
                "Deduct pay for late production workers",
                "settings",
                current=bool(ps.prod_late_detection_enabled),
                fmt=_on_off,
                ref=SETTINGS["prod_late_switch"],
                detail="When on, each worker's punches are checked against the production shift they are assigned",
                applied=applied_switch,
                applied_fmt=_on_off,
            )
        )
        attendance.append(
            _item(
                "attendance_mode",
                "What counts as late",
                "settings",
                current=ps.prod_attendance_mode,
                text="Simple: only a late first punch"
                if ps.prod_attendance_mode == "simple"
                else "Strict: a late first punch or an early last punch",
                ref=SETTINGS["prod_attendance_mode"],
                detail="A day counts once, either way",
                applied=None if bd is not None else _UNSET,
            )
        )
        allowance, slabs = cycle_late_rules(ps, cycle)
        late = _got(bd, "deductions", "lateSummary") if bd is not None else None
        stored_free = None
        if isinstance(late, dict) and int(late.get("billableLateCount") or 0) > 0:
            stored_free = int(late.get("totalLateCount") or 0) - int(late.get("billableLateCount") or 0)
        attendance.append(
            _item(
                "free_allowance",
                "Free late days a period",
                "settings",
                current=allowance,
                text=_free_late_days(allowance),
                ref=cycle_ref(cycle, "late_allowance") or SETTINGS["prod_late_switch"],
                detail=(
                    "This cycle has its own late rules"
                    if cfg is not None and cfg.own_late_rules
                    else "The shared production late rules apply: this cycle has none of its own"
                ),
                applied=stored_free if bd is not None else _UNSET,
                applied_fmt=_free_late_days,
            )
        )
        attendance.append(
            _slab_item(
                "late_slabs",
                "Late deduction slabs",
                cycle_ref(cycle, "late_slabs") or SETTINGS["prod_late_switch"],
                slabs,
                "late",
                late if isinstance(late, dict) else None,
                bd is not None,
                "The highest slab the billable lates reach applies; the last slab holds beyond it",
            )
        )
    shift = inp.shift
    start, end, grace, _sat = (
        _effective_shift_times(inp.assignment) if inp.assignment is not None else (None, None, None, False)
    )
    attendance.append(
        _item(
            "production_shift",
            "Assigned production shift",
            "shift",
            current=shift.id if shift else None,
            text=f"{shift.name}, {start.strftime('%H:%M')}-{end.strftime('%H:%M')}, {grace} min grace"
            if shift
            else "No shift assigned",
            detail=(
                "Late detection compares each punch with this shift's start, end and grace"
                if shift
                else "A worker with no assigned shift is never marked late: assign one in Manage Shifts"
            ),
        )
    )

    # ── PF / ESI ──
    equivalent = _got(bd, "deductions", "monthlyEquivalent") if bd is not None else None
    band_now, pf_now, esi_now = production_rule_now(ps, equivalent) if equivalent is not None else (None, None, None)
    stored_band = _got(bd, "deductions", "pfEfRule")
    if company:
        statutory.append(
            _item(
                "pf_ef_switch",
                "Use salary bands for PF and ESI",
                "settings",
                current=bool(ps.prod_pf_ef_enabled),
                fmt=_on_off,
                ref=SETTINGS["pf_ef_switch"],
                detail="A matching band is used instead of the flat rates, even while the flat-rate switch is off",
                applied=(True if stored_band else None) if bd is not None else _UNSET,
                applied_fmt=_on_off,
            )
        )
        bands = describe_bands(ps.prod_pf_ef_rules)
        band_item = _item(
            "pf_ef_rule",
            "Salary band",
            "settings",
            current=(band_now.get("label") or "Salary band") if band_now else "No band",
            text="; ".join(bands) if bands else "No bands defined",
            ref=SETTINGS["pf_ef_rules"],
            detail="The first band that fits the worker's monthly-equivalent pay is used",
        )
        if bd is not None:
            if equivalent is not None and stored_band:
                label = stored_band.get("label") or "Salary band"
                band_item["applied"] = label
                band_item["changed"] = (band_now.get("label") if band_now else None) != stored_band.get("label")
                if band_item["changed"]:
                    band_item["detail"] += (
                        f". Under the bands as they stand now this pay would use {(band_now or {}).get('label') or 'no band'}"
                    )
            else:
                band_item["applied"], band_item["changed"] = None, False
        statutory.append(band_item)
        statutory.append(
            _item(
                "flat_rules_switch",
                "Deduct flat-rate PF and ESI",
                "settings",
                current=bool(ps.prod_payroll_rules_enabled),
                fmt=_on_off,
                ref=SETTINGS["prod_pf_esi_switch"],
                detail="Applies only when no salary band matches",
                applied=None if bd is not None else _UNSET,
            )
        )
    statutory.append(
        _item(
            "pf_rate",
            "PF",
            "settings",
            current=pf_now if pf_now is not None else ps.prod_pf_rate,
            text=_production_rate_text(ps, ps.prod_pf_rate),
            ref=SETTINGS["prod_pf_rate"],
            detail="Taken from the whole period pay, not from half of it as for staff",
            applied=_got(bd, "deductions", "pfRate"),
            applied_fmt=_period_pct,
        )
    )
    statutory.append(
        _item(
            "esi_rate",
            "ESI / EF",
            "settings",
            current=esi_now if esi_now is not None else ps.prod_esi_rate,
            text=_production_rate_text(ps, ps.prod_esi_rate),
            ref=SETTINGS["prod_esi_rate"],
            detail="Applies while the monthly-equivalent pay is at or below the ESI ceiling",
            applied=_got(bd, "deductions", "esiRate"),
            applied_fmt=_period_pct,
        )
    )
    if company:
        statutory.append(
            _item(
                "esi_ceiling",
                "ESI ceiling",
                "settings",
                current=ps.prod_esi_applicable_below,
                fmt=inr,
                ref=SETTINGS["prod_esi_ceiling"],
                detail="The monthly-equivalent pay up to which a production worker pays ESI",
                applied=_got(bd, "deductions", "esiApplicableBelow"),
            )
        )

    # ── pay basis ──
    pay.append(
        _item(
            "salary_per_shift",
            "Salary per shift",
            "employee",
            current=emp.salary_per_shift,
            fmt=_inr_or_unset,
            detail="Pay is the shifts earned in the period times this rate",
            applied=_got(bd, "salaryPerShift"),
            applied_fmt=inr,
        )
    )
    if company:
        pay.append(
            _item(
                "shifts_earned",
                "How a production day earns pay",
                "settings",
                current=None,
                text="0.25, 0.5, 1 or 1.5 shifts a day from the production punch times",
                ref=SETTINGS["prod_shifts_earned"],
                detail="Each day's punches are matched against the production shift segments kept in Manage Shifts",
            )
        )

    return _assemble(
        (GROUP_CYCLE, pay_cycle),
        (GROUP_PRODUCTION_ATTENDANCE, attendance),
        (GROUP_STATUTORY, statutory),
        (GROUP_PAY_BASIS, pay),
    )


def production_settings_groups(ps, cycle: str) -> list[dict]:
    """The Settings page rules production payroll of one pay cycle uses, grouped, each with its Settings link."""
    cfg = cycle_config(ps, cycle)
    factor = MONTHLY_EQUIVALENT_FACTOR.get(cycle, DEFAULT_MONTHLY_EQUIVALENT_FACTOR)
    allowance, slabs = cycle_late_rules(ps, cycle)
    label = CYCLE_LABELS[cycle]
    pay_cycle = [
        _item(
            "pay_cycle",
            "Pay cycle",
            "cycle",
            current=cycle,
            text=_cycle_text(cycle),
            detail="One period is whole weeks counted from the first period start; months play no part",
        ),
        _item(
            "week_start",
            "Week starts on",
            "settings",
            current=cfg.week_start,
            text=cfg.week_start.capitalize(),
            ref=cycle_ref(cycle, "week_start"),
            detail=f"A {label} period starts on this weekday and ends on the day before it comes round again",
        ),
        _item(
            "first_period",
            "First period starts on",
            "settings",
            current=cfg.anchor_date,
            text=ddmmyyyy(cfg.anchor_date)
            if cfg.anchor_date
            else ("Not needed for Weekly" if cycle == "weekly" else "Not set: this cycle cannot be generated"),
            ref=cycle_ref(cycle, "first_period"),
            detail="The date the periods are counted from, moved back to the start weekday",
        ),
        _item(
            "period_length",
            "Period length",
            "cycle",
            current=CYCLE_DAYS[cycle],
            text=f"{CYCLE_DAYS[cycle]} days ({plural(CYCLE_DAYS[cycle] // 7, 'week')})",
            detail="Fixed by the cycle: Weekly is one week, BiWeekly two and Monthly four weeks (not a calendar month)",
        ),
        _item(
            "monthly_factor",
            "Monthly-equivalent factor",
            "cycle",
            current=factor,
            text=f"x{factor}",
            detail="A period's pay is multiplied by this before it is compared with the monthly PF / ESI bands and the ESI ceiling",
        ),
    ]
    attendance = [
        _item(
            "late_switch",
            "Deduct pay for late production workers",
            "settings",
            current=bool(ps.prod_late_detection_enabled),
            fmt=_on_off,
            ref=SETTINGS["prod_late_switch"],
            detail="One switch for every pay cycle: workers are checked against the production shift they are assigned",
        ),
        _item(
            "attendance_mode",
            "What counts as late",
            "settings",
            current=ps.prod_attendance_mode,
            text="Simple: only a late first punch"
            if ps.prod_attendance_mode == "simple"
            else "Strict: a late first punch or an early last punch",
            ref=SETTINGS["prod_attendance_mode"],
            detail="A day counts once, either way",
        ),
        _item(
            "free_allowance",
            "Free late days a period",
            "settings",
            current=allowance,
            text=_free_late_days(allowance),
            ref=cycle_ref(cycle, "late_allowance"),
            detail=f"The {label} cycle has its own value"
            if cfg.own_late_rules
            else "The shared production value applies: this cycle has none of its own",
        ),
        _item(
            "late_slabs",
            "Late deduction slabs",
            "settings",
            current=None,
            text=describe_slabs(slabs, "late"),
            ref=cycle_ref(cycle, "late_slabs"),
            detail="The highest slab the billable lates reach applies; the last slab holds beyond it",
        ),
    ]
    bands = describe_bands(ps.prod_pf_ef_rules)
    statutory = [
        _item(
            "pf_ef_switch",
            "Use salary bands for PF and ESI",
            "settings",
            current=bool(ps.prod_pf_ef_enabled),
            fmt=_on_off,
            ref=SETTINGS["pf_ef_switch"],
            detail="A matching band is used instead of the flat rates, even while the flat-rate switch is off",
        ),
        _item(
            "pf_ef_rule",
            "Salary bands",
            "settings",
            current=None,
            text="; ".join(bands) if bands else "No bands defined",
            ref=SETTINGS["pf_ef_rules"],
            detail="The first band that fits the worker's monthly-equivalent pay is used",
        ),
        _item(
            "flat_rules_switch",
            "Deduct flat-rate PF and ESI",
            "settings",
            current=bool(ps.prod_payroll_rules_enabled),
            fmt=_on_off,
            ref=SETTINGS["prod_pf_esi_switch"],
            detail="Used when no salary band matches",
        ),
        _item(
            "pf_rate",
            "PF rate",
            "settings",
            current=ps.prod_pf_rate,
            text=f"{_pct(ps.prod_pf_rate)} of the period pay",
            ref=SETTINGS["prod_pf_rate"],
            detail="Taken from the whole period pay, not from half of it as for staff",
        ),
        _item(
            "esi_rate",
            "ESI rate",
            "settings",
            current=ps.prod_esi_rate,
            text=f"{_pct(ps.prod_esi_rate)} of the period pay",
            ref=SETTINGS["prod_esi_rate"],
            detail="Applies while the monthly-equivalent pay is at or below the ESI ceiling",
        ),
        _item(
            "esi_ceiling",
            "ESI ceiling",
            "settings",
            current=ps.prod_esi_applicable_below,
            fmt=inr,
            ref=SETTINGS["prod_esi_ceiling"],
            detail="The monthly-equivalent pay up to which a production worker pays ESI",
        ),
    ]
    pay = [
        _item(
            "shifts_earned",
            "How a production day earns pay",
            "settings",
            current=None,
            text="Shifts earned x the worker's salary per shift",
            ref=SETTINGS["prod_shifts_earned"],
            detail="A day earns 0.25, 0.5, 1 or 1.5 shifts from the production punch times kept in Manage Shifts",
        ),
    ]
    return _assemble(
        (GROUP_CYCLE, pay_cycle),
        (GROUP_PRODUCTION_ATTENDANCE, attendance),
        (GROUP_STATUTORY, statutory),
        (GROUP_PAY_BASIS, pay),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  The Rules tab's employee table
# ─────────────────────────────────────────────────────────────────────────────


def employee_rules_entry(emp, payroll_id: int | None, groups: list[dict], chips: list[dict], flags: list[str]) -> dict:
    """One EmployeeRules row."""
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": full_name(emp),
        "department": emp.department.name if emp.department_id else None,
        "designation": emp.designation.title if emp.designation_id else None,
        "payrollId": payroll_id,
        "chips": chips,
        "groups": groups,
        "flags": flags,
    }
