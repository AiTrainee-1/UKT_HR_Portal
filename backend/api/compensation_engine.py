"""
Compensation engine: what the attendance engine (attendance_final.compute_day_record) needs from the database to
judge a staff day with the OT / Compensation features. The arithmetic itself lives in compensation_rules.py (pure).

Everything here is gated, in this order, by
  1. the MASTER switch (PayrollSettings.compensation_feature_enabled): off = nothing here acts at all and, because the
     context is then empty, nothing is even queried;
  2. the feature's OWN switch (CompensationConfig.allowance_enabled / windows_enabled / birthday_enabled);
  3. the feature's `effective_from` date (never applied to an earlier day, so re-generating an old month cannot change);
  4. staff only (employment_type == "staff"), never production.
Relaxation top-ups (an OT relaxation HR assigned, a balance HR redeemed) are commitments HR already made, so they follow
the master switch only: switching a feature off later does not take back what was granted.

Query discipline: a bulk caller (compute_month_records / compute_range_records) builds ONE CompContext for its employee
and range - a fixed handful of queries whatever the number of days - and the day-level helpers below do no queries of
their own on that path. A single-day caller gets the same context built for just that day. A loop over MANY employees
(a roster day, a Report Log month, the sheet) builds the employee-independent part once (build_context with no
employee ids) and hands it to every employee's call, so the per-employee cost is the look-back alone.
"""

from collections import namedtuple
from dataclasses import dataclass, field, replace
from datetime import date as date_type, datetime, timedelta
from decimal import Decimal

from django.db.models import Q

from . import compensation_rules as rules
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLedger,
    CompensationRule,
    EmployeeShiftAssignment,
    OvertimeRecord,
)
from .shift_engine import _get_assignment_for_date, _t2s

KIND_OT_ALLOWANCE = "ot_allowance"
KIND_WINDOW_LATE_IN = "window_late_in"
KIND_WINDOW_EARLY_OUT = "window_early_out"
KIND_BIRTHDAY = "birthday"
KIND_RELAXATION = "relaxation"


@dataclass
class CompContext:
    """The compensation facts one compute call needs. An empty context (master off) switches everything off."""

    master: bool = False
    config: object = None
    allowance_rules: list = field(default_factory=list)  # enabled Type 1 rows, sort order
    # {(employee_id, date): [(Decimal shifts, label), ...]}: relaxation HR assigned or redeemed for that day
    relaxation: dict = field(default_factory=dict)
    # {date: stored ot_extra_minutes} for the LOOKBACK_DAYS before the range, for ONE employee; None = not prefetched
    # (a single-day caller). Whatever is stored, the previous day's figure is also re-derived from its punches and the
    # larger one counts (see previous_day_extra), so a stale record never costs anyone the allowance.
    ot_lookback: dict | None = None
    # The same facts for a whole ROSTER on one date (many employees, one day), loaded together the first time a late
    # arrival needs them. None = not a roster context.
    roster: "RosterLookback | None" = None

    @property
    def allowance_on(self) -> bool:
        return bool(self.master and self.config is not None and self.config.allowance_enabled and self.allowance_rules)

    @property
    def windows_on(self) -> bool:
        return bool(self.master and self.config is not None and self.config.windows_enabled)

    @property
    def birthday_on(self) -> bool:
        return bool(self.master and self.config is not None and self.config.birthday_enabled)


Punch = namedtuple("Punch", "date punch_time")  # what the shift engine reads of an AttendanceLog (a light stand-in)


def _stored_ot_lookback(emp, date_from: date_type) -> dict:
    """{date: ot_extra_minutes} of `emp`'s days in the LOOKBACK_DAYS before `date_from` that stored some."""
    return dict(
        AttendanceDayRecord.objects.filter(
            employee=emp,
            date__gte=date_from - timedelta(days=rules.LOOKBACK_DAYS),
            date__lt=date_from,
            ot_extra_minutes__gt=0,
        ).values_list("date", "ot_extra_minutes")
    )


class RosterLookback:
    """What the Type 1 allowance needs about the PREVIOUS working day of every employee of a roster on one date, loaded
    in three queries for the whole roster - and only the first time a late arrival asks for it (an on-time roster costs
    nothing): the stored OT figures, the shift assignments and the raw punches of the look-back window. Without this,
    each late arrival re-derived the previous day with up to four queries of its own."""

    def __init__(self, employee_ids, d: date_type):
        self.employee_ids = list(employee_ids)
        self.d = d
        self._loaded = False
        self._stored: dict = {}  # {employee_id: {date: minutes}}
        self._assignments: dict = {}  # {employee_id: [EmployeeShiftAssignment]}
        self._logs: dict = {}  # {employee_id: {date: [Punch]}}

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        ids = self.employee_ids
        # one day before the earliest previous working day too: cross-midnight punches are reattributed from p+1 to p
        first = self.d - timedelta(days=rules.LOOKBACK_DAYS + 1)
        for emp_id, day, minutes in AttendanceDayRecord.objects.filter(
            employee_id__in=ids, date__gte=first, date__lt=self.d, ot_extra_minutes__gt=0
        ).values_list("employee_id", "date", "ot_extra_minutes"):
            self._stored.setdefault(emp_id, {})[day] = minutes
        for a in (
            EmployeeShiftAssignment.objects.filter(employee_id__in=ids, effective_from__lte=self.d)
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=first))
            .select_related("shift")
        ):
            self._assignments.setdefault(a.employee_id, []).append(a)
        for emp_id, day, punch_time in (
            AttendanceLog.objects.filter(employee_id__in=ids, date__gte=first, date__lte=self.d)
            .order_by("punch_time")
            .values_list("employee_id", "date", "punch_time")
        ):
            self._logs.setdefault(emp_id, {}).setdefault(day, []).append(Punch(day, punch_time))

    def facts(self, employee_id: int) -> tuple[list, dict, dict]:
        """(assignments, logs_by_date, {date: stored OT minutes}) of one employee of the roster."""
        self._load()
        return (
            self._assignments.get(employee_id, []),
            self._logs.get(employee_id, {}),
            self._stored.get(employee_id, {}),
        )


def with_lookback(ctx: CompContext, emp, date_from: date_type) -> CompContext:
    """`ctx` (an employee-independent context for a whole loop, build_context with no employee ids) for ONE employee of
    that loop: the same switches, rules and relaxation, plus - when the Type 1 allowance is on - that employee's stored
    OT of the days before `date_from`, so the first days of the range need no query of their own."""
    if not ctx.allowance_on:
        return ctx
    return replace(ctx, ot_lookback=_stored_ot_lookback(emp, date_from))


def build_context(settings, date_from: date_type, date_to: date_type, employee_ids=None, lookback_employee=None):
    """The context for [date_from, date_to]. `employee_ids` narrows the relaxation lookup (None = every employee: for a
    roster, or the employee-independent context of a loop that adds each employee's look-back with with_lookback).
    `lookback_employee` (one employee, month/range callers) also preloads the stored OT of the days before
    `date_from`, so the Type 1 allowance of the first days of the range needs no query."""
    if not getattr(settings, "compensation_feature_enabled", False):
        return CompContext()
    config = CompensationConfig.get()
    ctx = CompContext(master=True, config=config)
    if config.allowance_enabled:
        ctx.allowance_rules = list(
            CompensationRule.objects.filter(kind=CompensationRule.KIND_ALLOWANCE, enabled=True).order_by(
                "sort_order", "id"
            )
        )

    # Relaxation: an announced Type 2 record whose mode is relaxation (its claim date), and every ledger debit (a balance
    # redemption: its date). Both are plain rows HR wrote; the day is topped up from them whenever it is computed.
    ot_rows = OvertimeRecord.objects.filter(
        ot_type=OvertimeRecord.OT_TYPE_SHIFT,
        status=OvertimeRecord.STATUS_ANNOUNCED,
        compensation_type=OvertimeRecord.TYPE_RELAXATION,
        claim_date__gte=date_from,
        claim_date__lte=date_to,
        shifts__isnull=False,
    )
    debits = CompensationLedger.objects.filter(
        entry_type=CompensationLedger.ENTRY_DEBIT, date__gte=date_from, date__lte=date_to
    )
    if employee_ids is not None:
        ot_rows = ot_rows.filter(employee_id__in=list(employee_ids))
        debits = debits.filter(employee_id__in=list(employee_ids))
    for emp_id, claim_date, shifts, ot_date in ot_rows.values_list("employee_id", "claim_date", "shifts", "date"):
        ctx.relaxation.setdefault((emp_id, claim_date), []).append(
            (Decimal(shifts), f"the overtime of {ot_date.strftime('%d %b %Y')}")
        )
    for emp_id, day, shifts in debits.values_list("employee_id", "date", "shifts"):
        ctx.relaxation.setdefault((emp_id, day), []).append((Decimal(shifts), "the compensation balance"))

    if lookback_employee is not None and config.allowance_enabled:
        ctx.ot_lookback = _stored_ot_lookback(lookback_employee, date_from)
    return ctx


# ── announcements (legacy day exemptions + the new windows) ─────────────────


def announcement_applies(emp, ann) -> bool:
    """Scoping of a CompensationDayAnnouncement (Holiday's nullable-FK convention, plus an explicit employee list): it
    applies to `emp` when `emp` is listed, or when the list is empty and the branch / department (each null = anyone)
    match. `ann.employees` must be prefetched by a bulk caller."""
    listed = {e.pk for e in ann.employees.all()}
    if emp.pk in listed:
        return True
    if listed:
        return False
    if ann.branch_id and ann.branch_id != emp.branch_id:
        return False
    if ann.department_id and ann.department_id != emp.department_id:
        return False
    return True


def window_times(emp, announcements, ctx: CompContext):
    """(late_in_time, early_out_time) the announced windows allow `emp` today (each None when there is none). Needs the
    master switch and the windows switch. Several windows of one kind: the most generous (the latest arrival time, the
    earliest leaving time)."""
    if not ctx.windows_on:
        return None, None
    late = early = None
    for ann in announcements:
        if ann.kind not in (CompensationDayAnnouncement.KIND_LATE_IN, CompensationDayAnnouncement.KIND_EARLY_OUT):
            continue
        when = ann.allowed_time or ann.leave_until_time
        if when is None or not announcement_applies(emp, ann):
            continue
        if ann.kind == CompensationDayAnnouncement.KIND_LATE_IN:
            if late is None or when > late:
                late = when
        elif early is None or when < early:
            early = when
    return late, early


# ── working days ────────────────────────────────────────────────────────────


def is_off_day(emp, d: date_type, assignments=None) -> bool:
    """A day the employee is not expected: a Sunday, a declared company holiday, or a Saturday the shift assignment in
    force marks as off."""
    from .attendance_final import _holiday_dates_for_month

    if d.weekday() == 6 or d in _holiday_dates_for_month(d.year, d.month):
        return True
    if d.weekday() == 5:
        assignment = _get_assignment_for_date(emp, d, assignments=assignments)
        return bool(assignment is not None and assignment.saturday_off)
    return False


# ── OT measurement ──────────────────────────────────────────────────────────


def shift_end_secs(shift):
    """The REAL shift end in seconds since the shift day's midnight (an overnight shift ends the next calendar day, so
    its end is past 86400), or None when there is no shift to measure from."""
    if shift is None or shift.end_time is None or shift.start_time is None:
        return None
    end, start = _t2s(shift.end_time), _t2s(shift.start_time)
    return end + 86400 if end <= start else end


def ot_extra_for_day(day_secs, shift, off_day: bool) -> int:
    """Minutes of extra work the day shows: its last punch past the real shift end. 0 on a day off, with fewer than two
    punches (one punch says when someone arrived, not when they left), or without a shift."""
    if off_day or shift is None or len(day_secs) < 2:
        return 0
    end = shift_end_secs(shift)
    if end is None:
        return 0
    return rules.extra_minutes(day_secs[-1], end)


# ── Type 1: the next-day allowance ──────────────────────────────────────────


@dataclass(frozen=True)
class AllowanceGrant:
    minutes: int  # what the OT day earned
    source_date: date_type  # the previous working day it was earned on
    extra: int  # that day's extra minutes


def previous_day_extra(emp, p: date_type, settings, prefetch, ctx: CompContext) -> int:
    """Extra minutes worked on the working day `p` (the day before an arrival).

    A month / range caller (ctx.ot_lookback is not None) computes its days oldest first and keeps each result in
    `existing_day_records`, so a day inside its range is FRESH there; a day before the range comes from the preloaded
    look-back, and - when that holds 0, because the day may never have been recomputed since the late punches - from the
    punches the caller already prefetched (no query). A single-day caller (a dashboard / roster call) reads the stored
    figure and, when that is 0, re-derives it from the day's punches, so a stale record never costs anyone the allowance.
    A ROSTER caller (ctx.roster) does the same from facts loaded once for the whole roster (RosterLookback), so a late
    arrival costs it no query of its own."""
    prefetch = prefetch or {}
    existing = prefetch.get("existing_day_records")
    bulk = ctx.ot_lookback is not None
    assignments = prefetch.get("assignments")
    logs_by_date = prefetch.get("night_logs_by_date") if bulk else None
    if existing is not None and p in existing:
        stored = existing[p].ot_extra_minutes or 0
        if bulk:
            return stored
    elif bulk:
        stored = ctx.ot_lookback.get(p, 0)
    elif ctx.roster is not None:
        assignments, logs_by_date, stored_by_date = ctx.roster.facts(emp.pk)
        stored = stored_by_date.get(p, 0)
    else:
        stored = (
            AttendanceDayRecord.objects.filter(employee=emp, date=p).values_list("ot_extra_minutes", flat=True).first()
            or 0
        )
    if stored:
        return stored
    return _extra_from_punches(emp, p, settings, assignments, logs_by_date)


def _extra_from_punches(emp, p: date_type, settings, assignments, logs_by_date=None) -> int:
    """The day's extra minutes from its raw punches (what compute_day_record would store). `logs_by_date`, when the caller
    has prefetched every punch around `p`, avoids any query."""
    from .models import AttendanceLog
    from .shift_engine import _get_shift_for_date, resolve_day_punch_logs

    shift = _get_shift_for_date(emp, p, assignments=assignments)
    if shift is None:
        return 0
    if logs_by_date is not None:
        logs = list(logs_by_date.get(p, []))
    else:
        logs = list(AttendanceLog.objects.filter(employee=emp, date=p).order_by("punch_time"))
    if not logs:
        return 0
    logs = resolve_day_punch_logs(emp, p, logs, settings, assignments=assignments, logs_by_date=logs_by_date)
    secs = sorted(_t2s(log.punch_time) + 86400 * (log.date - p).days for log in logs)
    return ot_extra_for_day(secs, shift, is_off_day(emp, p, assignments))


def allowance_for_arrival(emp, d: date_type, ctx: CompContext, settings, prefetch=None):
    """The Type 1 allowance (AllowanceGrant) the arrival on working day `d` may use, or None. The OT day is the previous
    WORKING day (Sundays, company holidays and an off Saturday in between do not count); both days must be on or after
    the feature's effective-from date; extra work beyond the Type 2 threshold is Type 2's, not the allowance's."""
    if not ctx.allowance_on:
        return None
    effective = ctx.config.allowance_effective_from
    assignments = (prefetch or {}).get("assignments")
    if effective and d < effective:
        return None
    if is_off_day(emp, d, assignments):
        return None
    p = rules.previous_working_day(d, lambda day: is_off_day(emp, day, assignments))
    if p is None or (effective and p < effective):
        return None
    extra = previous_day_extra(emp, p, settings, prefetch, ctx)
    minutes = rules.allowance_minutes_for(extra, ctx.allowance_rules, max_extra=ctx.config.shift_min_extra_minutes)
    if minutes <= 0:
        return None
    return AllowanceGrant(minutes=minutes, source_date=p, extra=extra)


# ── birthday ────────────────────────────────────────────────────────────────


def _parse_join_date(raw):
    if not raw:
        return None
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def birthday_applies(emp, d: date_type, ctx: CompContext, assignments=None) -> bool:
    """Is `d` this employee's paid birthday leave? Feature (and master) on, on or after the effective-from date, an
    active STAFF employee whose date of birth falls on `d` (29 Feb -> 28 Feb in a non-leap year), on a working day (a
    Sunday / holiday / off Saturday is already a day off) that is not before the employee joined."""
    if not ctx.birthday_on:
        return False
    effective = ctx.config.birthday_effective_from
    if effective and d < effective:
        return False
    if emp.employment_type != "staff" or emp.status != "active":
        return False
    if not rules.is_birthday(emp.date_of_birth, d):
        return False
    joined = _parse_join_date(emp.join_date)
    if joined is not None and d < joined:
        return False
    return not is_off_day(emp, d, assignments)


# ── relaxation top-up ───────────────────────────────────────────────────────


def relaxation_entries(emp, d: date_type, ctx: CompContext) -> list:
    return ctx.relaxation.get((emp.pk, d), []) if ctx.master else []


def relaxation_topup(base_shifts: Decimal, entries) -> tuple[Decimal, Decimal]:
    """(new total, added): the day's shifts raised by the relaxation entries but never above 1.00 (a staff day is one
    shift), so a relaxation never pays more than a full day."""
    total = Decimal(base_shifts)
    cap = Decimal("1.00")
    for shifts, _label in entries:
        total = min(cap, total + Decimal(shifts))
    return total, total - Decimal(base_shifts)


def status_for_total(total: Decimal) -> tuple[str, bool]:
    """(status, is_half_shift) of a day whose shifts total `total`: more than half a shift is a (reduced) present day
    like a quarter-shift arrival's 0.75, half or less is a half shift."""
    if total > Decimal("0.50"):
        return AttendanceDayRecord.STATUS_PRESENT, False
    return AttendanceDayRecord.STATUS_HALF, True
