"""
Birthday Compensation on a chosen date (owner brief 2026-11-25): the rules. The writes live in
birthday_compensation_service.py, the endpoints in birthday_compensation_views.py, the model in
models/birthday_compensation.py; the full API contract is in api-database-reference.md ("Birthday Compensation").

What a birthday gives (new birthday rule, CompensationConfig.birthday_claims_apply_on):
  * NOT worked (no punch / approved leave): paid birthday leave on the day itself, automatically (attendance_final,
    unchanged);
  * WORKED (present, or a half day - a half day worked on the birthday counts as worked, nothing automatic): 1.00 day of
    Birthday Compensation the employee (or HR for them) places on dates they choose - a full day, or a first / second half
    (two halves may go on two different dates). This replaces the 1.00 credit claim of 2026-11-19: a birthday whose credit
    claim is already waiting or approved keeps it (state "credit_claim", nothing to place), and no new credit claim can be
    raised (compensation_claims refuses it, code use_birthday_compensation).

The window is the BIRTHDAY MONTH (the calendar month of the celebrated date; 29 Feb is the 28th in a common year). The
compensation can be placed as soon as the birthday is known to be worked (a punch on it: compensation_effects.birthday_
outcome says credit_claimable), and what is not placed by the month's last day LAPSES (no carry). A use waiting for a
decision (pending) or approved holds its part of the 1.00; a rejected / withdrawn one frees it.

Eligible dates (day_options): a working day of the birthday month - never the birthday itself, never a Sunday, a declared
holiday or an off Saturday (compensation_engine.is_off_day), never before the employee joined, never in a finalized (Payroll
Done) month (attendance_edit.lock_refusal), never a day that already holds Casual Leave or a compensation day off (an open
use_balance claim) - that is either still to come (today counts while it has no punch yet: a full day or either half) or
already passed and marked Absent / On Leave (a full day or either half) or Half Day (the MISSED half, or a full day; the
Casual Leave carry-forward rule of cl_adjustment_views: a day HR set by hand takes a full day only). A present past day
is not eligible. A half already placed on a date (pending / approved) is taken; a full day takes both.

Approval: the Department Head, then HR (approval workflow "birthday_compensation", fixed). Applied on the final approval:
the attendance engine pays the day (or half) like a Casual Leave (compensation_engine.CompContext.birthday_uses ->
attendance_final, marker compensation_kind "birthday_comp", note "Birthday compensation (birthday 12 Nov): ...").
"""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal

from .compensation_shared import birthday_in_year, date_text, employee_json, full_name, parse_join_date

WORKFLOW = "birthday_compensation"
ZERO = Decimal("0.00")
HALF = Decimal("0.50")
ONE = Decimal("1.00")
MAX_REASON_LENGTH = 500

FULL, FIRST, SECOND = "full", "first_half", "second_half"
PORTIONS = (FULL, FIRST, SECOND)
PORTION_DAYS = {FULL: ONE, FIRST: HALF, SECOND: HALF}
PORTION_LABEL = {FULL: "Full day", FIRST: "First half", SECOND: "Second half"}
PORTION_PHRASE = {FULL: "full day", FIRST: "first half", SECOND: "second half"}
HALVES_OF = {FULL: frozenset((FIRST, SECOND)), FIRST: frozenset((FIRST,)), SECOND: frozenset((SECOND,))}

# Entitlement states (Entitlement.state)
STATE_AVAILABLE = "available"  # worked; some of the 1.00 is still to place and the birthday month is not over
STATE_PLACED = "placed"  # worked; all of it is placed (waiting / approved)
STATE_LAPSED = "lapsed"  # the birthday month is over and some of it was never placed
STATE_UPCOMING = "upcoming"  # the birthday is still to come (or today, no punch yet)
STATE_PAID_LEAVE = "paid_leave"  # not worked: the birthday itself is paid birthday leave (automatic)
STATE_CREDIT_CLAIM = "credit_claim"  # worked, and a birthday CREDIT claim (the 2026-11-19 flow) is waiting / approved
STATE_OFF_DAY = "off_day"  # the birthday is a Sunday / holiday / off Saturday: nothing to give
STATE_OLD_RULE = "old_rule"  # before the claim rules: the birthday was paid automatically
STATE_NOT_ELIGIBLE = "not_eligible"  # switched off, not active staff, no date of birth, not worked out yet ...

STATE_LABELS = {
    STATE_AVAILABLE: "To place",
    STATE_PLACED: "Placed",
    STATE_LAPSED: "Lapsed",
    STATE_UPCOMING: "Upcoming",
    STATE_PAID_LEAVE: "Paid birthday leave",
    STATE_CREDIT_CLAIM: "Birthday credit claim",
    STATE_OFF_DAY: "Day off: nothing to give",
    STATE_OLD_RULE: "Paid automatically (old rule)",
    STATE_NOT_ELIGIBLE: "Not eligible",
}

# What the HR Birthdays list says a worked birthday gives now (compensation_birthday_views: replaces credit_claimable /
# credit_rejected for a birthday with no open credit claim)
OUTCOME_TO_PLACE = "comp_to_place"
OUTCOME_PLACED = "comp_placed"
OUTCOME_LAPSED = "comp_lapsed"
OUTCOME_OF_STATE = {STATE_AVAILABLE: OUTCOME_TO_PLACE, STATE_PLACED: OUTCOME_PLACED, STATE_LAPSED: OUTCOME_LAPSED}

STATUS_LABELS = {
    "pending": "Waiting for the Department Head",
    "pending_hr": "Approved by the Department Head, waiting for HR",
    "approved": "Approved",
    "rejected": "Not approved",
    "withdrawn": "Withdrawn",
}

# Day statuses of the eligible-dates calendar (DayOption.status)
DAY_FUTURE = "future"
DAY_TODAY = "today"


def number(value) -> float:
    return float(Decimal(value or 0).quantize(Decimal("0.01")))


def days_text(value) -> str:
    """'1.00 day', '0.50 day' (never more than a day here)."""
    value = Decimal(value or 0)
    return f"{value:.2f} day" if value <= ONE else f"{value:.2f} days"


def short_day(d: dt.date) -> str:
    return f"{d.day} {d.strftime('%b')}"


def month_bounds(d: dt.date) -> tuple[dt.date, dt.date]:
    return d.replace(day=1), d.replace(day=calendar.monthrange(d.year, d.month)[1])


def month_label(d: dt.date) -> str:
    return d.strftime("%B %Y")


def birthday_for(emp, year: int) -> dt.date | None:
    """The employee's birthday as celebrated in `year` (None without a date of birth)."""
    dob = getattr(emp, "date_of_birth", None)
    return birthday_in_year(dob, year) if dob else None


def current_birthday(emp, today: dt.date) -> dt.date | None:
    """The birthday the employee's page is about: this year's (still to come, in its month, or passed)."""
    return birthday_for(emp, today.year)


def birthday_of_use_date(emp, use_date: dt.date) -> dt.date | None:
    """The birthday whose month `use_date` is in, or None (no date of birth, or another month)."""
    birthday = birthday_for(emp, use_date.year)
    if birthday is None or (birthday.year, birthday.month) != (use_date.year, use_date.month):
        return None
    return birthday


# ─────────────────────────── the uses of a birthday ───────────────────────────


def open_uses(emp_id: int, birthday: dt.date, exclude_use_id: int | None = None) -> list:
    """The waiting / approved uses placed from one birthday, oldest first."""
    from .models import BirthdayCompensationUse

    qs = BirthdayCompensationUse.objects.filter(
        employee_id=emp_id, birthday=birthday, status__in=BirthdayCompensationUse.OPEN_STATUSES
    )
    if exclude_use_id is not None:
        qs = qs.exclude(pk=exclude_use_id)
    return list(qs.order_by("use_date", "id"))


def held_and_used(uses) -> tuple[Decimal, Decimal]:
    """(days waiting, days approved) of these uses (rejected / withdrawn ones count for nothing)."""
    held = sum((Decimal(u.days) for u in uses if u.status == "pending"), ZERO)
    used = sum((Decimal(u.days) for u in uses if u.status == "approved"), ZERO)
    return held, used


def taken_halves(emp_id: int, first: dt.date, last: dt.date, exclude_use_id: int | None = None) -> dict:
    """{date: {"first_half", "second_half"}} the open uses of an employee already cover between first and last (whatever
    birthday they come from)."""
    from .models import BirthdayCompensationUse

    qs = BirthdayCompensationUse.objects.filter(
        employee_id=emp_id, use_date__range=(first, last), status__in=BirthdayCompensationUse.OPEN_STATUSES
    )
    if exclude_use_id is not None:
        qs = qs.exclude(pk=exclude_use_id)
    out: dict = {}
    for day, portion in qs.values_list("use_date", "portion"):
        out.setdefault(day, set()).update(HALVES_OF.get(portion, ()))
    return out


# ─────────────────────────── eligible dates ───────────────────────────


@dataclass
class DayOption:
    """One day of the birthday month and what Birthday Compensation it can take."""

    date: dt.date
    status: str  # future | today | absent | on_leave | half_shift | present | holiday | none | off_day | birthday ...
    label: str
    portions: tuple = ()
    suggested: str | None = None
    reason: str | None = None  # why it cannot be chosen (or why only some portions)
    worked: str | None = None  # a half day: "morning" | "evening" | None
    first_punch: str | None = None
    last_punch: str | None = None
    manual: bool = False
    halves: dict | None = None
    placed: list = field(default_factory=list)  # [{id, portion, status}] of the uses already on this date

    @property
    def selectable(self) -> bool:
        return bool(self.portions)

    def to_json(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "weekday": self.date.strftime("%a"),
            "status": self.status,
            "label": self.label,
            "selectable": self.selectable,
            "portions": list(self.portions),
            "suggested": self.suggested if self.portions else None,
            "reason": self.reason,
            "worked": self.worked,
            "firstPunch": self.first_punch,
            "lastPunch": self.last_punch,
            "manual": self.manual,
            "halves": self.halves,
            "placed": self.placed,
        }


def _clock(t) -> str | None:
    return t.strftime("%H:%M") if t else None


def _hm(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _halves_json(shift) -> dict | None:
    """{first: "09:00-13:00", second: "14:00-18:00"}: what each half means in clock time on the day's shift (the split
    casual_leave_views._shift_halves_json uses for a half-day Casual Leave)."""
    if shift is None or shift.start_time is None or shift.end_time is None:
        return None
    start = shift.start_time.hour * 60 + shift.start_time.minute
    end = shift.end_time.hour * 60 + shift.end_time.minute
    length = (end - start) % (24 * 60) or 24 * 60
    if shift.first_half_end is not None:
        first_end = shift.first_half_end.hour * 60 + shift.first_half_end.minute
        second_start = first_end + max(0, int(shift.lunch_duration_minutes or 0))
    else:
        first_end = second_start = start + length // 2
    return {"first": f"{_hm(start)}-{_hm(first_end)}", "second": f"{_hm(second_start)}-{_hm(end)}"}


def _preferred(portions, preferred: str | None) -> str | None:
    if not portions:
        return None
    return preferred if preferred in portions else portions[0]


def day_options(
    emp,
    birthday: dt.date,
    today: dt.date,
    *,
    for_employee: bool = False,
    exclude_use_id: int | None = None,
    amount_left: Decimal | None = None,
) -> list[DayOption]:
    """Every day of the birthday month with the portions it can take (see the module docstring). `amount_left` limits the
    portions to what is still to place (None = do not limit: the approval re-check, which judges the day only).
    `exclude_use_id` leaves one use out of what is already placed (the use being approved). A handful of queries for the
    whole month: the stored days, the shift assignments, Casual Leave, open use_balance claims, the uses."""
    from . import cl_balance
    from .attendance_edit import lock_refusal
    from .attendance_final import _holiday_dates_for_month, half_period
    from .compensation_shared import holiday_names
    from .models import AttendanceDayRecord, EmployeeShiftAssignment, HolidayWorkClaim, PayrollSettings
    from .shift_engine import _get_assignment_for_date, _get_shift_for_date

    first, last = month_bounds(birthday)
    you = "You" if for_employee else full_name(emp)
    your = "your" if for_employee else "the employee's"
    assignments = list(
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=last).select_related("shift")
    )
    records = {r.date: r for r in AttendanceDayRecord.objects.filter(employee=emp, date__range=(first, last))}
    holidays = holiday_names(first, last)
    declared = _holiday_dates_for_month(first.year, first.month)
    cl_days = {p.date for p in cl_balance.parts([emp.id], first, last).get(emp.id, [])}
    use_balance_days = set(
        HolidayWorkClaim.objects.filter(
            employee=emp,
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            work_date__range=(first, last),
            status__in=HolidayWorkClaim.OPEN_STATUSES,
        ).values_list("work_date", flat=True)
    )
    taken = taken_halves(emp.id, first, last, exclude_use_id)
    placed_rows: dict = {}
    from .models import BirthdayCompensationUse

    placed_qs = BirthdayCompensationUse.objects.filter(
        employee=emp, use_date__range=(first, last), status__in=BirthdayCompensationUse.OPEN_STATUSES
    )
    if exclude_use_id is not None:
        placed_qs = placed_qs.exclude(pk=exclude_use_id)
    for u in placed_qs.order_by("use_date", "id"):
        placed_rows.setdefault(u.use_date, []).append({"id": u.id, "portion": u.portion, "status": u.status})
    settings = PayrollSettings.get()
    joined = parse_join_date(emp.join_date)
    locked = lock_refusal(emp, first)

    out: list[DayOption] = []
    d = first
    while d <= last:
        rec = records.get(d)
        opt = DayOption(d, "none", "")
        opt.placed = placed_rows.get(d, [])
        if rec is not None:
            opt.first_punch, opt.last_punch = _clock(rec.first_punch), _clock(rec.last_punch)
            opt.manual = rec.source == "manual"
        refused = None
        if d == birthday:
            opt.status, opt.label = "birthday", "Birthday"
            refused = f"The birthday itself cannot be chosen: choose another day of {month_label(birthday)}."
        elif joined is not None and d < joined:
            opt.status, opt.label = "not_joined", "Before joining"
            refused = f"{you} had not joined yet on this day."
        elif d.weekday() == 6:
            opt.status, opt.label = "off_day", "Sunday"
            refused = "A Sunday is already a day off: choose a working day."
        elif d in declared:
            name = holidays.get(d) or "A company holiday"
            opt.status, opt.label = "off_day", name
            refused = f"{name} is a company holiday, already a day off: choose a working day."
        elif d.weekday() == 5 and getattr(
            _get_assignment_for_date(emp, d, assignments=assignments), "saturday_off", False
        ):
            opt.status, opt.label = "off_day", "Off Saturday"
            refused = f"Saturday is a day off on {your} shift: choose a working day."
        elif locked:
            opt.status, opt.label = "locked", "Payroll Done"
            refused = locked
        elif d in cl_days:
            opt.status, opt.label = "casual_leave", "Casual Leave"
            refused = "Casual Leave is already asked for or approved on this day."
        elif d in use_balance_days:
            opt.status, opt.label = "compensation", "Compensation day off"
            refused = "A day off from the compensation balance is already asked for or approved on this day."
        allowed: tuple = ()
        preferred = FULL
        if refused is None:
            punched = rec is not None and bool(rec.first_punch or rec.total_punches)
            if d > today or (d == today and not punched):
                opt.status = DAY_FUTURE if d > today else DAY_TODAY
                opt.label = "Still to come" if d > today else "Today"
                allowed = (FULL, FIRST, SECOND)
            elif rec is None:
                opt.label = "Not worked out yet"
                refused = "The attendance of this day has not been worked out yet."
            else:
                opt.status = rec.status
                if rec.status == AttendanceDayRecord.STATUS_PRESENT:
                    opt.label = "Present"
                    refused = (
                        f"{you} {'were' if for_employee else 'was'} present this day (a full day worked): there is "
                        "nothing to make up."
                    )
                elif rec.status in (AttendanceDayRecord.STATUS_ABSENT, "on_leave"):
                    opt.label = "Absent" if rec.status == AttendanceDayRecord.STATUS_ABSENT else "On Leave"
                    allowed = (FULL,) if opt.manual else (FULL, FIRST, SECOND)
                elif rec.status == AttendanceDayRecord.STATUS_HALF:
                    opt.worked = half_period(rec, settings)
                    missing = SECOND if opt.worked == "morning" else FIRST if opt.worked == "evening" else None
                    opt.label = {
                        "morning": "Half Day · worked the morning",
                        "evening": "Half Day · worked the evening",
                    }.get(opt.worked or "", "Half Day")
                    if opt.manual:
                        allowed = (FULL,)
                    elif missing:
                        allowed, preferred = (missing, FULL), missing
                    else:
                        allowed, preferred = (FIRST, SECOND, FULL), SECOND
                elif rec.status == "holiday":
                    opt.label = "Holiday / week off"
                    refused = "This day is already a holiday / day off."
                else:
                    opt.label = rec.status.replace("_", " ").capitalize()
                    refused = "This day cannot take Birthday Compensation."
        if refused is None and allowed:
            covered = taken.get(d, set())
            if covered:
                allowed = tuple(p for p in allowed if not (HALVES_OF[p] & covered))
                if not allowed:
                    refused = "Birthday Compensation is already placed on this day."
            if allowed and amount_left is not None:
                fits = tuple(p for p in allowed if PORTION_DAYS[p] <= amount_left)
                if not fits:
                    refused = (
                        f"Only {days_text(amount_left)} is left to place, and this day can only take a full day."
                        if amount_left > ZERO
                        else "Nothing is left to place."
                    )
                elif len(fits) < len(allowed):
                    opt.reason = f"Only {days_text(amount_left)} is left to place: a half can be chosen."
                allowed = fits
        if refused is not None:
            opt.reason = refused
            allowed = ()
        opt.portions = allowed
        opt.suggested = _preferred(allowed, preferred)
        if allowed and (FIRST in allowed or SECOND in allowed):
            opt.halves = _halves_json(_get_shift_for_date(emp, d, assignments=assignments))
        out.append(opt)
        d += dt.timedelta(days=1)
    return out


def option_for(options: list[DayOption], d: dt.date) -> DayOption | None:
    return next((o for o in options if o.date == d), None)


def portion_refusal(opt: DayOption | None, portion: str, use_date: dt.date) -> str | None:
    """Why `portion` cannot be placed on the day of `opt` (None = it can)."""
    if opt is None:
        return f"{date_text(use_date)} is not in the birthday month."
    if not opt.portions:
        return f"{date_text(use_date)}: {opt.reason or 'this day cannot take Birthday Compensation.'}"
    if portion not in opt.portions:
        allowed = " or ".join(PORTION_PHRASE[p] for p in opt.portions)
        why = f" ({opt.reason})" if opt.reason else ""
        return f"On {date_text(use_date)} only a {allowed} can be placed{why}."
    return None


# ─────────────────────────── the entitlement ───────────────────────────


@dataclass
class Entitlement:
    employee: object
    birthday: dt.date | None
    today: dt.date
    state: str = STATE_NOT_ELIGIBLE
    message: str = ""
    worked: bool | None = None
    total: Decimal = ZERO
    held: Decimal = ZERO
    used: Decimal = ZERO
    uses: list = field(default_factory=list)  # every use of this birthday (any status), oldest first
    credit_claim: object = None  # the latest birthday CREDIT claim of this birthday (2026-11-19 flow), any status
    day_status: str | None = None
    options: list = field(default_factory=list)
    can_place: bool = False
    place_message: str | None = None

    @property
    def month_start(self) -> dt.date | None:
        return month_bounds(self.birthday)[0] if self.birthday else None

    @property
    def month_end(self) -> dt.date | None:
        return month_bounds(self.birthday)[1] if self.birthday else None

    @property
    def window_open(self) -> bool:
        return bool(self.birthday) and self.today <= self.month_end

    @property
    def unplaced(self) -> Decimal:
        return max(ZERO, self.total - self.held - self.used)

    @property
    def available(self) -> Decimal:
        return self.unplaced if self.window_open else ZERO

    @property
    def lapsed(self) -> Decimal:
        return ZERO if self.window_open else self.unplaced


def _switches():
    from .compensation_shared import master_enabled
    from .models import CompensationConfig

    return master_enabled(), CompensationConfig.get()


def entitlement(
    emp,
    birthday: dt.date | None,
    today: dt.date,
    *,
    for_employee: bool = False,
    refresh: bool = False,
    with_options: bool = True,
    exclude_use_id: int | None = None,
) -> Entitlement:
    """What `birthday` gives `emp` now (see the module docstring). `refresh` (a caller that may write attendance: the
    employee's own page, HR with Edit, a write): the birthday's stored day and the month's past days are worked out again
    first (compute_range_records; never a manual day, never a finalized month). `with_options` adds the eligible dates."""
    from . import compensation_effects as effects
    from .models import BirthdayCompensationUse, HolidayWorkClaim

    ent = Entitlement(emp, birthday, today)
    if birthday is None:
        ent.message = (
            "Your date of birth is not on record: please contact HR."
            if for_employee
            else f"{full_name(emp)} has no date of birth on record."
        )
        ent.place_message = ent.message
        return ent
    if refresh:
        _refresh_month(emp, birthday, today)
    ent.uses = list(BirthdayCompensationUse.objects.filter(employee=emp, birthday=birthday).order_by("use_date", "id"))
    open_ = [u for u in ent.uses if u.status in BirthdayCompensationUse.OPEN_STATUSES and u.pk != exclude_use_id]
    ent.held, ent.used = held_and_used(open_)
    ent.credit_claim = (
        HolidayWorkClaim.objects.filter(employee=emp, kind=HolidayWorkClaim.KIND_BIRTHDAY, work_date=birthday)
        .order_by("-id")
        .first()
    )
    outcome = effects.birthday_outcome(emp, birthday, refresh=False) or {}
    base = outcome.get("base") or outcome.get("outcome")
    ent.day_status = outcome.get("dayStatus")
    ent.worked = base == effects.BIRTHDAY_CREDIT_CLAIMABLE if base else None
    claim_open = ent.credit_claim is not None and ent.credit_claim.status in HolidayWorkClaim.OPEN_STATUSES
    if claim_open:
        ent.state = STATE_CREDIT_CLAIM
        ent.message = (
            "This birthday was already claimed as a 1.00 shift credit "
            f"({'approved' if ent.credit_claim.status == 'approved' else 'waiting for the Department Head'}): "
            "there is no Birthday Compensation to place for it."
        )
    elif ent.worked or open_:
        # a birthday whose punches were corrected away after uses were placed keeps those uses, but nothing more can be
        # placed from it (the approval refuses them too: birthday_compensation_service._approval_problem)
        ent.total = ONE if ent.worked else ent.held + ent.used
        if ent.unplaced > ZERO and ent.window_open:
            ent.state = STATE_AVAILABLE
        elif ent.unplaced > ZERO:
            ent.state = STATE_LAPSED
        else:
            ent.state = STATE_PLACED
        ent.message = _worked_message(ent, for_employee)
        if not ent.worked:
            ent.message += " The attendance no longer shows the birthday as worked: ask HR to check it."
    else:
        ent.state = {
            effects.BIRTHDAY_PAID_LEAVE: STATE_PAID_LEAVE,
            effects.BIRTHDAY_UPCOMING: STATE_UPCOMING,
            effects.BIRTHDAY_OFF_DAY: STATE_OFF_DAY,
            effects.BIRTHDAY_OLD_RULE: STATE_OLD_RULE,
        }.get(base, STATE_NOT_ELIGIBLE)
        ent.message = _other_message(ent, outcome, for_employee)
        if ent.state == STATE_UPCOMING:
            ent.worked = None  # not known yet
    if with_options and ent.state in (STATE_AVAILABLE, STATE_PLACED):
        ent.options = day_options(
            emp,
            birthday,
            today,
            for_employee=for_employee,
            exclude_use_id=exclude_use_id,
            amount_left=ent.available,
        )
    ent.can_place, ent.place_message = _can_place(ent, for_employee)
    return ent


def _worked_message(ent: Entitlement, for_employee: bool) -> str:
    who = "You" if for_employee else full_name(ent.employee)
    month = month_label(ent.birthday)
    head = f"{who} worked on {'your' if for_employee else 'the'} birthday ({date_text(ent.birthday)})"
    if ent.state == STATE_AVAILABLE:
        if ent.held or ent.used:
            return (
                f"{head}: {days_text(ent.available)} of Birthday Compensation is still to place on a day of {month} "
                f"(by {short_day(ent.month_end)}); {days_text(ent.held + ent.used)} is placed."
            )
        return (
            f"{head}: 1.00 day of Birthday Compensation to place on a day (or two halves) of {month}, by "
            f"{short_day(ent.month_end)}. Unused compensation lapses when the month ends."
        )
    if ent.state == STATE_LAPSED:
        placed = f" {days_text(ent.held + ent.used)} was placed." if (ent.held or ent.used) else ""
        return f"{head}. {month} is over: {days_text(ent.lapsed)} of Birthday Compensation was not placed and lapsed.{placed}"
    return f"{head}: all of the 1.00 day of Birthday Compensation is placed."


def _other_message(ent: Entitlement, outcome: dict, for_employee: bool) -> str:
    if ent.state == STATE_UPCOMING:
        return (
            "Still to come: if the birthday is not worked it becomes paid birthday leave; if it is worked, 1.00 day of "
            f"Birthday Compensation can be placed on a day of {month_label(ent.birthday)}."
        )
    if ent.state == STATE_PAID_LEAVE:
        return "Not worked on the birthday: it is paid birthday leave (a full paid day), so there is nothing to place."
    return outcome.get("message") or "This birthday gives no Birthday Compensation."


def _can_place(ent: Entitlement, for_employee: bool) -> tuple[bool, str | None]:
    """(can a new use be raised now, why not)."""
    from . import approval_workflow as approval

    if ent.state != STATE_AVAILABLE:
        return False, ent.message or None
    master, cfg = _switches()
    if not master:
        return False, "The OT / Compensation features are switched off in Settings, so nothing can be placed right now."
    if not cfg.birthday_enabled:
        return False, "Birthday compensation is switched off in Settings > Compensation, so nothing can be placed now."
    if not approval.get_config(WORKFLOW).enabled:
        return False, "Birthday Compensation requests are switched off right now. Please contact HR."
    emp = ent.employee
    if emp.employment_type != "staff" or emp.status != "active":
        return False, "Birthday Compensation is for active staff employees only."
    problem = hod_problem(emp, for_employee=for_employee)
    if problem:
        return False, problem
    if ent.options and not any(o.selectable for o in ent.options):
        return False, f"No day of {month_label(ent.birthday)} can take Birthday Compensation any more."
    return True, None


def hod_problem(emp, *, for_employee: bool = False) -> str | None:
    """Why nobody could give the Department Head's approval (no active head, the employee is their own head, or the
    head may not approve compensation), or None."""
    from .hod_scope import effective_manager

    head = effective_manager(emp)
    name = full_name(emp)
    if head is None or not head.is_active:
        if for_employee:
            return "You have no Department Head assigned, so nobody could approve Birthday Compensation. Please contact HR."
        return f"{name} has no Department Head assigned: assign one in HOD Assignment first."
    if head.employee_id == emp.id:
        if for_employee:
            return (
                "You are a Department Head yourself and a head never approves their own request. Please contact HR to "
                "have another Department Head assigned to you."
            )
        return (
            f"{name} is a Department Head, and a head never approves their own request: assign them another head first."
        )
    if not head.can_approve_compensation:
        if for_employee:
            return (
                f"Your Department Head {full_name(head.employee)} is not allowed to approve compensation yet, so nobody "
                "could approve Birthday Compensation. Please contact HR."
            )
        return (
            f"{full_name(head.employee)} cannot approve compensation: switch it on in User Management (HOD Assignment) "
            f"before placing Birthday Compensation for {name}."
        )
    return None


def _refresh_month(emp, birthday: dt.date, today: dt.date) -> None:
    """Work out the birthday month's days that have come again (compute_range_records: never a manual day), unless the
    month's payroll is finalized. Never raises (the stored days are then judged as they are)."""
    import logging

    from django.db import transaction

    from .attendance_edit import lock_refusal
    from .attendance_final import compute_range_records

    first, last = month_bounds(birthday)
    last = min(last, today)
    if first > last or emp.employment_type != "staff" or lock_refusal(emp, first):
        return
    try:
        with transaction.atomic():
            compute_range_records(emp, first, last)
    except Exception:
        logging.getLogger(__name__).exception(
            "Working out the birthday month of employee %s (%s) failed", emp.pk, birthday
        )


# ─────────────────────────── many birthdays at once (the HR Birthdays list) ───────────────────────────


def summaries(pairs, today: dt.date) -> dict:
    """{(employee_id, birthday): {"held", "used", "uses": [BirthdayCompensationUse]}} for many (employee, birthday) pairs
    (one query): what the HR Birthdays list shows of the placements."""
    from .models import BirthdayCompensationUse

    pairs = list(pairs)
    out = {(emp.pk, day): {"held": ZERO, "used": ZERO, "uses": []} for emp, day in pairs}
    if not pairs:
        return out
    for u in BirthdayCompensationUse.objects.filter(
        employee_id__in={emp.pk for emp, _d in pairs}, birthday__in={d for _e, d in pairs}
    ).order_by("use_date", "id"):
        row = out.get((u.employee_id, u.birthday))
        if row is None:
            continue
        row["uses"].append(u)
        if u.status == "pending":
            row["held"] += Decimal(u.days)
        elif u.status == "approved":
            row["used"] += Decimal(u.days)
    return out


def empty_summary() -> dict:
    return {"held": ZERO, "used": ZERO, "uses": []}


def list_block(birthday: dt.date, today: dt.date, worked: bool, credit_open: bool, summary: dict) -> dict:
    """The `birthdayCompensation` block of one HR Birthdays row (compensation_birthday_views): what the worked birthday
    gives now."""
    held, used = summary["held"], summary["used"]
    open_uses_ = [u for u in summary["uses"] if u.status in ("pending", "approved")]
    first, last = month_bounds(birthday)
    window_open = today <= last
    total = ONE if (worked or open_uses_) and not credit_open else ZERO
    unplaced = max(ZERO, total - held - used)
    if credit_open:
        state = STATE_CREDIT_CLAIM
    elif total == ZERO:
        state = None
    elif unplaced > ZERO:
        state = STATE_AVAILABLE if window_open else STATE_LAPSED
    else:
        state = STATE_PLACED
    if state == STATE_AVAILABLE:
        label = f"{days_text(unplaced)} to place by {short_day(last)}"
    elif state == STATE_LAPSED:
        label = f"{days_text(unplaced)} lapsed"
    elif state == STATE_PLACED:
        label = "Placed: " + ", ".join(
            f"{short_day(u.use_date)} ({PORTION_PHRASE[u.portion]}, {u.status})" for u in open_uses_
        )
    else:
        label = STATE_LABELS.get(state or "", "")
    return {
        "state": state,
        "label": label or None,
        "total": number(total),
        "held": number(held),
        "used": number(used),
        "available": number(unplaced if window_open else ZERO),
        "lapsed": number(ZERO if window_open else unplaced),
        "windowFrom": first.isoformat(),
        "lapsesOn": last.isoformat(),
        "windowOpen": window_open,
        "uses": [use_brief(u) for u in summary["uses"]],
    }


# ─────────────────────────── JSON ───────────────────────────


def what_text(use) -> str:
    """'Birthday Compensation request for Thursday 3 Dec 2026 (full day)' (the notices)."""
    return (
        f"Birthday Compensation request for {date_text(use.use_date)} ({PORTION_PHRASE.get(use.portion, use.portion)})"
    )


def status_key(use) -> str:
    """pending | pending_hr | approved | rejected | withdrawn: pending_hr once the Department Head approved it."""
    if use.status == "pending":
        hod_done = any(e.get("role") == "hod" and e.get("decision") == "approved" for e in (use.approval_trail or []))
        return "pending_hr" if hod_done else "pending"
    return use.status


def status_label(use) -> str:
    key = status_key(use)
    if key == "approved":
        return f"Approved: {PORTION_PHRASE.get(use.portion, '')} paid on {short_day(use.use_date)}"
    return STATUS_LABELS.get(key, key)


def use_brief(u) -> dict:
    return {
        "id": u.id,
        "useDate": u.use_date.isoformat(),
        "portion": u.portion,
        "portionLabel": PORTION_LABEL.get(u.portion, u.portion),
        "days": number(u.days),
        "status": u.status,
        "statusKey": status_key(u),
        "statusLabel": status_label(u),
    }


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def use_json(u, *, for_role: str = "hr", cfg=None) -> dict:
    """One use as every endpoint returns it (HR, the employee, the Department Head; `for_role` only changes
    `canWithdraw`). Needs employee__department / designation / branch select_related for a list."""
    from . import approval_workflow as approval

    emp = u.employee
    pending = u.status == "pending"
    if for_role == "employee":
        can_withdraw = pending and u.raised_by_role == "employee"
    elif for_role == "hr":
        can_withdraw = pending and u.raised_by_role == "hr"
    else:
        can_withdraw = False
    last = None
    for e in reversed(u.approval_trail or []):
        if e.get("decision") in ("approved", "rejected"):
            last = e
            break
    return {
        "id": u.id,
        "kind": WORKFLOW,
        "workflow": WORKFLOW,
        **employee_json(emp),
        "employee": {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": full_name(emp),
            "firstName": emp.first_name,
            "lastName": emp.last_name,
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        },
        "birthday": u.birthday.isoformat(),
        "birthdayText": date_text(u.birthday),
        "useDate": u.use_date.isoformat(),
        "useDateText": date_text(u.use_date),
        "date": u.use_date.isoformat(),
        "weekday": u.use_date.strftime("%A"),
        "portion": u.portion,
        "portionLabel": PORTION_LABEL.get(u.portion, u.portion),
        "days": number(u.days),
        "status": u.status,
        "statusKey": status_key(u),
        "statusLabel": status_label(u),
        "reason": u.reason or None,
        "raisedByRole": u.raised_by_role,
        "requestedBy": u.requested_by or None,
        "createdAt": _iso(u.created_at),
        "hodReviewedBy": u.hod_reviewed_by,
        "hodReviewedAt": _iso(u.hod_reviewed_at),
        "hodReviewComment": u.hod_review_comment,
        "hrReviewedBy": u.hr_reviewed_by,
        "hrReviewedAt": _iso(u.hr_reviewed_at),
        "hrReviewComment": u.hr_review_comment,
        "reviewedBy": last.get("by") if last else None,
        "reviewedAt": last.get("at") if last else None,
        "reviewComment": last.get("comment") if last else None,
        "withdrawnBy": u.withdrawn_by,
        "withdrawnAt": _iso(u.withdrawn_at),
        "canWithdraw": can_withdraw,
        "approval": approval.progress(WORKFLOW, u, cfg),
    }


def entitlement_json(ent: Entitlement, *, for_role: str = "hr") -> dict:
    """The entitlement of one employee for one birthday (GET /api/employee/compensation/birthday and GET
    /api/compensation/birthday-compensation)."""
    from . import approval_workflow as approval

    emp = ent.employee
    cfg = approval.get_config(WORKFLOW)
    first, last = (ent.month_start, ent.month_end) if ent.birthday else (None, None)
    claim = ent.credit_claim
    return {
        **employee_json(emp),
        "birthday": ent.birthday.isoformat() if ent.birthday else None,
        "birthdayText": date_text(ent.birthday) if ent.birthday else None,
        "weekday": ent.birthday.strftime("%A") if ent.birthday else None,
        "month": (
            {
                "year": ent.birthday.year,
                "month": ent.birthday.month,
                "label": month_label(ent.birthday),
                "from": first.isoformat(),
                "to": last.isoformat(),
            }
            if ent.birthday
            else None
        ),
        "state": ent.state,
        "stateLabel": STATE_LABELS.get(ent.state, ent.state),
        "message": ent.message or None,
        "worked": ent.worked,
        "dayStatus": ent.day_status,
        "days": {
            "total": number(ent.total),
            "held": number(ent.held),
            "used": number(ent.used),
            "available": number(ent.available),
            "lapsed": number(ent.lapsed),
        },
        "windowOpen": ent.window_open,
        "lapsesOn": last.isoformat() if last else None,
        "canPlace": ent.can_place,
        "placeMessage": ent.place_message,
        "portions": [{"key": p, "label": PORTION_LABEL[p], "days": number(PORTION_DAYS[p])} for p in PORTIONS],
        "uses": [use_json(u, for_role=for_role, cfg=cfg) for u in ent.uses],
        "eligibleDates": [o.to_json() for o in ent.options],
        "creditClaim": (
            {
                "id": claim.id,
                "status": claim.status,
                "shifts": number(claim.shifts),
                "workDate": claim.work_date.isoformat(),
            }
            if claim is not None
            else None
        ),
        "approvalPath": approval.pipeline_text(approval.definition(WORKFLOW).requested_by, cfg.steps),
        "workflowEnabled": cfg.enabled,
    }
