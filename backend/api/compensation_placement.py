"""
Compensation placed on a chosen date (owner brief 2026-11-28): the rules. The endpoints are in
compensation_placement_views.py; the claims themselves stay HolidayWorkClaim rows (compensation_claims.py), so the
Department Head decides them in the apps exactly where every compensation request already is. The full API contract is in
api-database-reference.md ("Compensation days on a chosen date").

Like Birthday Compensation's "Choose date for employee", HR opens a calendar for one employee and places compensation on a
working day of their choice, as much of a shift as the day can take (0.25 / 0.50 / 0.75 / 1.00). What can be placed (the
SOURCE of a placement):

  * "overtime"      a Type 2 (shift compensation) OT record still waiting, from CompensationConfig.claims_from on: ONE
                    ot_shift claim that credits the quarters credit AND places it (or part of it) on the chosen day
                    ("Shift compensation");
  * "holiday_work"  a Sunday / company holiday / off Saturday the employee worked and nobody claimed yet: ONE holiday_work
                    claim that credits the shifts HR gives (1.00 by default) and places them (or part) on the day
                    ("Sunday compensation" / "Holiday work compensation");
  * "claim"         an APPROVED credit claim (Sunday / holiday work, an OT shift credit, an older birthday credit): a
                    use_balance claim taking part of it from the balance onto the day (source_claim set; what is left of
                    the credit to place = its shifts less the open placements that name it, never more than the balance
                    still available);
  * "balance"       the balance as a whole (Balance tab -> Use balance): a use_balance claim with no source.

Every placement is `hr_step` = True: the Department Head approves it first, then HR (approval workflow
compensation_placement, owner decision 2026-11-28); the employees' own claims and use requests keep the one-step pipeline.
On HR's approval a credit placed at once writes its credit, a debit of `use_shifts` dated `use_date` and relaxes that day;
a use_balance placement writes its debit and relaxes `work_date` (compensation_claims.decide, compensation_effects). The
part of a credit not placed stays in the balance; nothing lapses.

Eligible days (day_options), owner decision 2026-11-28 "today's limits, no lapse": a WORKING day of the employee (never a
Sunday, a declared holiday or an off Saturday), not before they joined, not in a finalized (Payroll Done) month, within
BACK_DAYS before today and AHEAD_DAYS after it, that holds no Casual Leave, no Birthday Compensation and no other
compensation placement (one per day), and that can still take a part of a shift: a day still to come (today counts while it
has no punch) takes what it will not already earn; a past day only what it did not earn (Absent / Half Day / a short day);
a full day worked or paid takes nothing (compensation_apply.check_relaxation_day decides the same at approval).
"""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from .compensation_shared import date_text, day_kind, full_name, holiday_names, parse_join_date, shifts_text

WORKFLOW = "compensation_placement"
ZERO = Decimal("0.00")
ONE = Decimal("1.00")
QUARTER = Decimal("0.25")
AMOUNTS = (Decimal("0.25"), Decimal("0.50"), Decimal("0.75"), Decimal("1.00"))
MAX_REASON_LENGTH = 500

# the same limits a day off from the balance has always had (compensation_claims.CLAIM_WINDOW_DAYS / USE_AHEAD_DAYS)
BACK_DAYS = 45
AHEAD_DAYS = 90

SOURCE_OVERTIME = "overtime"
SOURCE_HOLIDAY_WORK = "holiday_work"
SOURCE_CLAIM = "claim"
SOURCE_BALANCE = "balance"
SOURCES = (SOURCE_OVERTIME, SOURCE_HOLIDAY_WORK, SOURCE_CLAIM, SOURCE_BALANCE)

# What the owner calls each compensation (the dialog's title, the Claims list's chip)
TYPE_SHIFT = "shift"
TYPE_OVERTIME = "overtime"
TYPE_SUNDAY = "sunday"
TYPE_HOLIDAY = "holiday"
TYPE_BIRTHDAY = "birthday"
TYPE_BALANCE = "balance"
TYPE_LABELS = {
    TYPE_SHIFT: "Shift compensation",
    TYPE_OVERTIME: "Overtime compensation",
    TYPE_SUNDAY: "Sunday compensation",
    TYPE_HOLIDAY: "Holiday work compensation",
    TYPE_BIRTHDAY: "Birthday credit",
    TYPE_BALANCE: "Compensation balance",
}

STAGE_HOD = "hod"
STAGE_HR = "hr"
STAGE_LABELS = {
    STAGE_HOD: "Waiting for the Department Head",
    STAGE_HR: "Approved by the Department Head, waiting for HR",
}


def number(value) -> float:
    return float(Decimal(value or 0).quantize(Decimal("0.01")))


def quarters(value) -> Decimal:
    """`value` rounded DOWN to a quarter shift (0.6 -> 0.50), never below 0 or above 1.00."""
    value = max(ZERO, min(ONE, Decimal(value or 0)))
    return (value / QUARTER).to_integral_value(rounding="ROUND_FLOOR") * QUARTER


def month_bounds(d: dt.date) -> tuple[dt.date, dt.date]:
    return d.replace(day=1), d.replace(day=calendar.monthrange(d.year, d.month)[1])


def window(today: dt.date) -> tuple[dt.date, dt.date]:
    return today - timedelta(days=BACK_DAYS), today + timedelta(days=AHEAD_DAYS)


def month_key(d: dt.date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def parse_month(raw, today: dt.date) -> dt.date | None:
    """'2026-11' -> 1 Nov 2026 (None when it is not a month or lies outside the window's months)."""
    try:
        year, month = (int(p) for p in str(raw).split("-")[:2])
        first = dt.date(year, month, 1)
    except (TypeError, ValueError):
        return None
    low, high = window(today)
    if month_bounds(first)[1] < low or first > high:
        return None
    return first


def work_type(kind: str, work_date: dt.date | None, holidays: dict | None = None) -> str:
    """The owner's name for a credit: Sunday / holiday work by the day worked, OT credit, birthday credit."""
    from .models import HolidayWorkClaim

    if kind == HolidayWorkClaim.KIND_OT_SHIFT:
        return TYPE_OVERTIME
    if kind == HolidayWorkClaim.KIND_BIRTHDAY:
        return TYPE_BIRTHDAY
    if kind == HolidayWorkClaim.KIND_HOLIDAY_WORK and work_date is not None:
        names = holidays if holidays is not None else holiday_names(work_date, work_date)
        if work_date.weekday() == 6 and work_date not in names:
            return TYPE_SUNDAY
        return TYPE_HOLIDAY
    return TYPE_BALANCE


def claim_type(claim, holidays: dict | None = None) -> str:
    """The owner's name for a placement claim: what it places (a credit placed at once: its own kind; a use_balance claim:
    its source credit's kind, else the balance)."""
    from .models import HolidayWorkClaim

    if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
        source = getattr(claim, "source_claim", None) if claim.source_claim_id else None
        if source is None:
            return TYPE_BALANCE
        return work_type(source.kind, source.work_date, holidays)
    if claim.kind == HolidayWorkClaim.KIND_OT_SHIFT and claim.hr_step:
        return TYPE_SHIFT
    return work_type(claim.kind, claim.work_date, holidays)


def stage(claim) -> str | None:
    """Where an hr_step claim waits: the Department Head (nobody approved yet) or HR (the head approved). None when it is
    decided."""
    from . import approval_workflow as approval

    if claim.status != "pending":
        return None
    approved = approval.approved_roles(approval.trail_of(WORKFLOW, claim))
    return STAGE_HR if approval.HOD in approved else STAGE_HOD


def placed_day(claim) -> tuple[dt.date | None, Decimal]:
    """(the day a placement gives off, the shifts) of any claim: a use_balance claim's work_date, a credit placed at once's
    use_date; (None, 0) for a claim that places nothing."""
    from .models import HolidayWorkClaim

    if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
        return claim.work_date, Decimal(claim.shifts or 0)
    if claim.use_date is not None and claim.kind in HolidayWorkClaim.CREDIT_KINDS:
        return claim.use_date, Decimal(claim.use_shifts or 0)
    return None, ZERO


# ─────────────────────────── what is left of a credit ───────────────────────────


def placed_from(claim_ids) -> dict[int, Decimal]:
    """{credit claim id: shifts of the OPEN (pending / approved) placements taken from it} (one query)."""
    from django.db.models import Sum

    from .models import HolidayWorkClaim

    ids = [i for i in claim_ids if i]
    if not ids:
        return {}
    return {
        row["source_claim_id"]: Decimal(row["total"] or 0)
        for row in HolidayWorkClaim.objects.filter(
            source_claim_id__in=ids,
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            status__in=HolidayWorkClaim.OPEN_STATUSES,
        )
        .values("source_claim_id")
        .annotate(total=Sum("shifts"))
    }


def credit_left(claim, placed: Decimal | None = None) -> tuple[Decimal, Decimal]:
    """(placed, left) of an approved credit claim: its own placement (placed at once) plus the placements naming it, and
    what is still to place (never below 0). The balance is not looked at here (see Source.left)."""
    if placed is None:
        placed = placed_from([claim.pk]).get(claim.pk, ZERO)
    own = Decimal(claim.use_shifts or 0) if claim.use_date is not None else ZERO
    total = Decimal(claim.shifts or 0)
    used = placed + own
    return used, max(ZERO, total - used)


# ─────────────────────────── the source of a placement ───────────────────────────


class PlacementError(Exception):
    """A placement refused with a plain sentence for HR, a machine code and the HTTP status."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_json(self) -> dict:
        return {"error": self.message, "code": self.code}


@dataclass
class Source:
    """What one placement takes its compensation from (see the module docstring)."""

    type: str  # SOURCE_*
    comp_type: str  # TYPE_*
    title: str  # "Sunday worked on Sun 23 Nov"
    work_date: dt.date | None = None
    claim: object | None = None  # the approved credit claim (claim)
    record: object | None = None  # the Type 2 OT record (overtime)
    claim_kind: str = ""  # the kind of the claim the placement creates
    total: Decimal = ZERO  # what the source gives (a credit; the balance: what is available)
    placed: Decimal = ZERO  # already placed from it
    left: Decimal = ZERO  # what can still be placed now (capped by the balance for claim / balance)
    credit_fixed: bool = True  # False: HR chooses the credit (holiday work placed at once)
    refusal: str | None = None  # why nothing can be placed from it (shown, the calendar stays readable)
    refusal_code: str | None = None

    def key(self) -> dict:
        if self.type == SOURCE_CLAIM:
            return {"type": self.type, "id": getattr(self.claim, "pk", None)}
        if self.type == SOURCE_OVERTIME:
            return {"type": self.type, "id": getattr(self.record, "pk", None)}
        if self.type == SOURCE_HOLIDAY_WORK:
            return {"type": self.type, "date": self.work_date.isoformat() if self.work_date else None}
        return {"type": self.type}

    def to_json(self) -> dict:
        return {
            **self.key(),
            "compType": self.comp_type,
            "compTypeLabel": TYPE_LABELS[self.comp_type],
            "title": self.title,
            "workDate": self.work_date.isoformat() if self.work_date else None,
            "claimId": getattr(self.claim, "pk", None),
            "overtimeRecordId": getattr(self.record, "pk", None),
            "total": number(self.total),
            "placed": number(self.placed),
            "left": number(self.left),
            "creditFixed": self.credit_fixed,
            "placesAtOnce": self.type in (SOURCE_OVERTIME, SOURCE_HOLIDAY_WORK),
            "canPlace": self.refusal is None and self.left > 0,
            "refusal": self.refusal,
            "refusalCode": self.refusal_code,
        }


def _day_title(d: dt.date) -> str:
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b %Y')}"


def parse_source(raw) -> dict:
    """The source as the client sends it ({type, id?, date?} or 'claim:12' / 'overtime:5' / 'holiday_work:2026-11-23' /
    'balance'); raises PlacementError(invalid)."""
    if isinstance(raw, str):
        kind, _, value = raw.partition(":")
        raw = {"type": kind}
        if kind in (SOURCE_CLAIM, SOURCE_OVERTIME):
            raw["id"] = value
        elif kind == SOURCE_HOLIDAY_WORK:
            raw["date"] = value
    if raw is None:
        raw = {"type": SOURCE_BALANCE}
    if not isinstance(raw, dict) or raw.get("type") not in SOURCES:
        raise PlacementError("invalid", "source must be overtime, holiday_work, claim or balance.")
    out = {"type": raw["type"]}
    if raw["type"] in (SOURCE_CLAIM, SOURCE_OVERTIME):
        try:
            out["id"] = int(raw.get("id"))
        except (TypeError, ValueError):
            raise PlacementError("invalid", f"source.id is required for a {raw['type']} source.") from None
    if raw["type"] == SOURCE_HOLIDAY_WORK:
        try:
            out["date"] = dt.date.fromisoformat(str(raw.get("date")))
        except (TypeError, ValueError):
            raise PlacementError("invalid", "source.date (YYYY-MM-DD) is required for a holiday_work source.") from None
    return out


def resolve_source(emp, raw: dict, *, ctx=None, figures: dict | None = None) -> Source:
    """The Source of `raw` (parse_source) for `emp`. Raises PlacementError(not_found) for a claim / record that is not
    this employee's; any other reason nothing can be placed is Source.refusal (the dialog shows it)."""
    from . import compensation_claims as claims
    from .models import HolidayWorkClaim, OvertimeRecord

    ctx = ctx or claims.context()
    if figures is None:
        figures = claims.balance_figures([emp.id]).get(emp.id) or {}
    available = max(ZERO, Decimal(figures.get("available", ZERO)))
    kind = raw["type"]

    if kind == SOURCE_BALANCE:
        src = Source(
            SOURCE_BALANCE, TYPE_BALANCE, "The compensation balance", claim_kind=HolidayWorkClaim.KIND_USE_BALANCE
        )
        src.total = src.left = available
        if available <= 0:
            src.refusal, src.refusal_code = (
                f"{full_name(emp)} has no compensation balance available to place.",
                "nothing_left",
            )
        return src

    if kind == SOURCE_CLAIM:
        claim = HolidayWorkClaim.objects.select_related("overtime_record").filter(pk=raw["id"], employee=emp).first()
        if claim is None or claim.kind not in HolidayWorkClaim.CREDIT_KINDS:
            raise PlacementError("not_found", "That compensation credit was not found for this employee.", 404)
        comp = work_type(claim.kind, claim.work_date)
        what = {
            TYPE_OVERTIME: "OT credit of",
            TYPE_SUNDAY: "Sunday worked on",
            TYPE_HOLIDAY: "Holiday worked on",
            TYPE_BIRTHDAY: "Birthday credit of",
        }.get(comp, "Credit of")
        src = Source(
            SOURCE_CLAIM,
            comp,
            f"{what} {_day_title(claim.work_date)}",
            work_date=claim.work_date,
            claim=claim,
            claim_kind=HolidayWorkClaim.KIND_USE_BALANCE,
        )
        src.total = Decimal(claim.shifts or 0)
        src.placed, own_left = credit_left(claim)
        src.left = min(own_left, available)
        if claim.status != HolidayWorkClaim.STATUS_APPROVED:
            src.left = ZERO
            src.refusal = (
                "This credit is still waiting for approval: once it is approved its compensation can be placed."
                if claim.status == HolidayWorkClaim.STATUS_PENDING
                else "This credit was not approved, so there is nothing to place."
            )
            src.refusal_code = "not_approved"
        elif own_left <= 0:
            src.refusal, src.refusal_code = "All of this credit is already placed.", "nothing_left"
        elif available <= 0:
            src.refusal = (
                f"{full_name(emp)}'s compensation balance is already used or asked for in full, so nothing of this "
                "credit can be placed now."
            )
            src.refusal_code = "nothing_left"
        return src

    if kind == SOURCE_OVERTIME:
        record = OvertimeRecord.objects.filter(pk=raw["id"], employee=emp).first()
        if record is None:
            raise PlacementError("not_found", "That overtime record was not found for this employee.", 404)
        src = Source(
            SOURCE_OVERTIME,
            TYPE_SHIFT,
            f"Overtime of {_day_title(record.date)}",
            work_date=record.date,
            record=record,
            claim_kind=HolidayWorkClaim.KIND_OT_SHIFT,
        )
        found = claims.eligibility(emp, HolidayWorkClaim.KIND_OT_SHIFT, record, ctx=ctx)
        if not found["eligible"]:
            src.refusal, src.refusal_code = found["message"], found["code"]
            return src
        src.total = src.left = Decimal(found["shifts"] or 0)
        return src

    # holiday work: a Sunday / holiday / off Saturday worked, not claimed yet
    day = raw["date"]
    comp = work_type(HolidayWorkClaim.KIND_HOLIDAY_WORK, day)
    src = Source(
        SOURCE_HOLIDAY_WORK,
        comp,
        f"{'Sunday' if comp == TYPE_SUNDAY else 'Holiday'} worked on {_day_title(day)}",
        work_date=day,
        claim_kind=HolidayWorkClaim.KIND_HOLIDAY_WORK,
        credit_fixed=False,
    )
    found = claims.eligibility(emp, HolidayWorkClaim.KIND_HOLIDAY_WORK, day, ctx=ctx)
    if not found["eligible"]:
        src.refusal, src.refusal_code = found["message"], found["code"]
        return src
    src.total = src.left = ONE
    return src


# ─────────────────────────── the calendar ───────────────────────────


@dataclass
class DayOption:
    """One day of the calendar and how much compensation it can take."""

    date: dt.date
    status: str = "none"
    label: str = ""
    room: Decimal = ZERO  # what the day can still take, before what is left to place
    amounts: tuple = ()
    suggested: Decimal | None = None
    reason: str | None = None
    earns: Decimal | None = None
    first_punch: str | None = None
    last_punch: str | None = None
    manual: bool = False
    placed: list = field(default_factory=list)  # [{id, shifts, status, stage, compType}] open placements on the day

    @property
    def selectable(self) -> bool:
        return bool(self.amounts)

    def to_json(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "weekday": self.date.strftime("%a"),
            "status": self.status,
            "label": self.label,
            "selectable": self.selectable,
            "room": number(self.room),
            "amounts": [number(a) for a in self.amounts],
            "suggested": number(self.suggested) if self.suggested is not None and self.amounts else None,
            "reason": self.reason,
            "earns": number(self.earns) if self.earns is not None else None,
            "firstPunch": self.first_punch,
            "lastPunch": self.last_punch,
            "manual": self.manual,
            "placed": self.placed,
        }


def _clock(t) -> str | None:
    return t.strftime("%H:%M") if t else None


def refresh_days(emp, first: dt.date, last: dt.date, today: dt.date) -> None:
    """Work out the days of [first, last] that have come again (compute_range_records: never a manual day), unless the
    month's payroll is finalized. Never raises (the stored days are then judged as they are)."""
    import logging

    from django.db import transaction

    from .attendance_edit import lock_refusal
    from .attendance_final import compute_range_records

    last = min(last, today)
    if first > last or emp.employment_type != "staff" or lock_refusal(emp, first):
        return
    try:
        with transaction.atomic():
            compute_range_records(emp, first, last)
    except Exception:
        logging.getLogger(__name__).exception(
            "Working out the days of employee %s (%s..%s) failed", emp.pk, first, last
        )


def open_placements(emp_id: int, first: dt.date, last: dt.date, exclude_claim_id: int | None = None) -> list:
    """The open (pending / approved) claims of an employee that give a day off between first and last: use_balance claims
    (work_date) and credits placed at once (use_date), whoever raised them."""
    from django.db.models import Q

    from .models import HolidayWorkClaim

    qs = (
        HolidayWorkClaim.objects.filter(employee_id=emp_id, status__in=HolidayWorkClaim.OPEN_STATUSES)
        .filter(
            Q(kind=HolidayWorkClaim.KIND_USE_BALANCE, work_date__range=(first, last))
            | Q(kind__in=HolidayWorkClaim.CREDIT_KINDS, use_date__range=(first, last))
        )
        .select_related("source_claim")
    )
    if exclude_claim_id is not None:
        qs = qs.exclude(pk=exclude_claim_id)
    return list(qs.order_by("id"))


def day_options(
    emp,
    first: dt.date,
    last: dt.date,
    today: dt.date,
    *,
    left: Decimal | None = None,
    exclude_claim_id: int | None = None,
) -> list[DayOption]:
    """Every day of [first, last] (one month) with the amounts it can take (see the module docstring). `left` limits the
    amounts to what is still to place (None: judge the day only). `exclude_claim_id` leaves one claim out of what is
    already placed (the one being approved). A handful of queries for the whole month."""
    from django.db.models import Sum

    from . import cl_balance
    from .attendance_edit import lock_refusal
    from .attendance_final import _holiday_dates_for_month
    from .compensation_apply import _birthday_leave_on
    from .compensation_shared import birthday_in_year
    from .models import (
        AttendanceDayRecord,
        BirthdayCompensationUse,
        CompensationLedger,
        EmployeeShiftAssignment,
        OvertimeRecord,
    )
    from .shift_engine import _get_assignment_for_date

    low, high = window(today)
    you = full_name(emp)
    assignments = list(
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=last).select_related("shift")
    )
    records = {r.date: r for r in AttendanceDayRecord.objects.filter(employee=emp, date__range=(first, last))}
    names = holiday_names(first, last)
    declared: set = set()
    month = first.replace(day=1)
    while month <= last:
        declared |= set(_holiday_dates_for_month(month.year, month.month))
        month = (month + timedelta(days=32)).replace(day=1)
    cl_days = {p.date for p in cl_balance.parts([emp.id], first, last).get(emp.id, [])}
    bday_comp_days = set(
        BirthdayCompensationUse.objects.filter(
            employee=emp, use_date__range=(first, last), status__in=BirthdayCompensationUse.OPEN_STATUSES
        ).values_list("use_date", flat=True)
    )
    placements: dict = {}
    for c in open_placements(emp.id, first, last, exclude_claim_id):
        day, shifts = placed_day(c)
        placements.setdefault(day, []).append(
            {
                "id": c.id,
                "shifts": number(shifts),
                "status": c.status,
                "stage": stage(c),
                "hrStep": bool(c.hr_step),
                "compType": claim_type(c, names),
                "compTypeLabel": TYPE_LABELS[claim_type(c, names)],
            }
        )
    # what the days still to come will already earn: approved relaxations (Type 2 OT on a claim date, ledger debits)
    granted: dict = {}
    for row in (
        CompensationLedger.objects.filter(
            employee=emp, entry_type=CompensationLedger.ENTRY_DEBIT, date__range=(first, last)
        )
        .values("date")
        .annotate(total=Sum("shifts"))
    ):
        granted[row["date"]] = granted.get(row["date"], ZERO) + Decimal(row["total"] or 0)
    for row in (
        OvertimeRecord.objects.filter(
            employee=emp,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_RELAXATION,
            claim_date__range=(first, last),
        )
        .values("claim_date")
        .annotate(total=Sum("shifts"))
    ):
        granted[row["claim_date"]] = granted.get(row["claim_date"], ZERO) + Decimal(row["total"] or 0)
    # a birthday still to come that would be paid birthday leave takes nothing (at most one per month)
    birthday_leave: set = set()
    if emp.date_of_birth:
        for year in {first.year, last.year}:
            bday = birthday_in_year(emp.date_of_birth, year)
            if first <= bday <= last and bday > today and _birthday_leave_on(emp, bday):
                birthday_leave.add(bday)
    joined = parse_join_date(emp.join_date)
    locks: dict = {}

    out: list[DayOption] = []
    d = first
    while d <= last:
        rec = records.get(d)
        opt = DayOption(d)
        opt.placed = placements.get(d, [])
        if rec is not None:
            opt.first_punch, opt.last_punch = _clock(rec.first_punch), _clock(rec.last_punch)
            opt.manual = rec.source == "manual"
        key = (d.year, d.month)
        if key not in locks:
            locks[key] = lock_refusal(emp, d)
        refused = None
        if joined is not None and d < joined:
            opt.status, opt.label = "not_joined", "Before joining"
            refused = f"{you} had not joined yet on this day."
        elif d.weekday() == 6:
            opt.status, opt.label = "off_day", "Sunday"
            refused = "A Sunday is already a day off: choose a working day."
        elif d in declared:
            name = names.get(d) or "A company holiday"
            opt.status, opt.label = "off_day", name
            refused = f"{name} is a company holiday, already a day off: choose a working day."
        elif d.weekday() == 5 and getattr(
            _get_assignment_for_date(emp, d, assignments=assignments), "saturday_off", False
        ):
            opt.status, opt.label = "off_day", "Off Saturday"
            refused = "Saturday is a day off on the employee's shift: choose a working day."
        elif locks[key]:
            opt.status, opt.label = "locked", "Payroll Done"
            refused = locks[key]
        elif d < low:
            opt.status, opt.label = "out_of_window", "Too far back"
            refused = f"Compensation can be placed at most {BACK_DAYS} days back: choose a later day."
        elif d > high:
            opt.status, opt.label = "out_of_window", "Too far ahead"
            refused = f"Compensation can be placed at most {AHEAD_DAYS} days ahead: choose an earlier day."
        elif opt.placed:
            opt.status, opt.label = "placed", "Compensation placed"
            refused = "Compensation is already placed on this day (waiting or approved): choose another day."
        elif d in cl_days:
            opt.status, opt.label = "casual_leave", "Casual Leave"
            refused = "Casual Leave is already asked for or approved on this day."
        elif d in bday_comp_days:
            opt.status, opt.label = "birthday_comp", "Birthday Compensation"
            refused = "Birthday Compensation is placed on this day."
        room = ZERO
        if refused is None:
            punched = rec is not None and bool(rec.first_punch or rec.total_punches)
            if d > today or (d == today and not punched):
                opt.status = "future" if d > today else "today"
                opt.label = "Still to come" if d > today else "Today"
                if rec is not None and opt.manual:
                    earns = Decimal(rec.shifts_earned or 0)
                elif d in birthday_leave:
                    earns = ONE
                    opt.label = "Birthday (paid birthday leave)"
                else:
                    earns = granted.get(d, ZERO)
                opt.earns = earns
                room = ONE - earns
                if room <= 0:
                    refused = (
                        "The birthday is paid birthday leave if not worked, so nothing more can be given on it."
                        if d in birthday_leave
                        else "This day is already a full paid day: choose another day."
                    )
            elif rec is None:
                opt.label = "Not worked out yet"
                refused = "The attendance of this day has not been worked out yet."
            else:
                opt.status = rec.status
                earns = Decimal(rec.shifts_earned or 0)
                opt.earns = earns
                room = ONE - earns
                opt.label = {
                    AttendanceDayRecord.STATUS_PRESENT: "Present",
                    AttendanceDayRecord.STATUS_ABSENT: "Absent",
                    AttendanceDayRecord.STATUS_HALF: "Half Day",
                    "on_leave": "On Leave",
                    "holiday": "Holiday / week off",
                }.get(rec.status, rec.status.replace("_", " ").capitalize())
                if room <= 0:
                    refused = (
                        f"{you} was present this day (a full day worked): there is nothing to make up."
                        if rec.status == AttendanceDayRecord.STATUS_PRESENT
                        else "This day is already a full paid day: there is nothing to make up."
                    )
        if refused is None:
            room = quarters(room)
            opt.room = room
            fits = tuple(a for a in AMOUNTS if a <= room and (left is None or a <= left))
            if not fits:
                refused = (
                    f"Only {shifts_text(left)} shift is left to place and this day can take {shifts_text(room)}."
                    if left is not None and left > 0
                    else "Nothing is left to place."
                    if left is not None
                    else "This day cannot take a quarter of a shift."
                )
            else:
                opt.amounts = fits
                opt.suggested = fits[-1]
                if room < ONE:
                    opt.reason = f"This day already earns {shifts_text(ONE - room)} shift: at most {shifts_text(room)} can be added."
        if refused is not None:
            opt.reason = refused
            opt.amounts = ()
        out.append(opt)
        d += timedelta(days=1)
    return out


def option_for(options: list[DayOption], d: dt.date) -> DayOption | None:
    return next((o for o in options if o.date == d), None)


def day_refusal(
    emp, use_date: dt.date, shifts: Decimal, today: dt.date, *, exclude_claim_id: int | None = None
) -> str | None:
    """Why `shifts` cannot be placed on `use_date` now (None = it can): the calendar's own answer for that day."""
    first, last = month_bounds(use_date)
    opt = option_for(day_options(emp, first, last, today, exclude_claim_id=exclude_claim_id), use_date)
    if opt is None:
        return f"{date_text(use_date)} cannot be chosen."
    if not opt.amounts:
        return f"{date_text(use_date)}: {opt.reason or 'this day cannot take compensation.'}"
    if shifts not in opt.amounts:
        return (
            f"{date_text(use_date)} can take at most {shifts_text(opt.room)} shift, so {shifts_text(shifts)} cannot be "
            "placed there: choose a smaller amount or another day."
        )
    return None


def approval_refusal(claim, today: dt.date) -> str | None:
    """Why the placed day of an hr_step claim can no longer take it (checked at every approval, under the locks): the
    day's payroll is finalized, it became a day off, Casual Leave / Birthday Compensation was given on it, it earns more
    now (worked since, a relaxation given ...). The window is NOT checked again (a request waiting for a decision does not
    expire by waiting). None when it still can."""
    from .attendance_edit import lock_refusal
    from .compensation_apply import RelaxationRefused, check_relaxation_day

    day, shifts = placed_day(claim)
    if day is None:
        return None
    emp = claim.employee
    if refusal := lock_refusal(emp, day):
        return refusal
    opt = option_for(day_options(emp, day, day, today, exclude_claim_id=claim.pk), day)
    if opt is not None and opt.status in ("casual_leave", "birthday_comp", "placed", "off_day", "not_joined"):
        return f"{date_text(day)}: {opt.reason} Reject this request; a new date can be chosen."
    try:
        check_relaxation_day(emp, day, shifts)
    except RelaxationRefused as exc:
        return f"{exc} Reject this request; a new date can be chosen."
    return None


def what_text(claim) -> str:
    """'Sunday compensation (0.50 shift) on 2 Dec' for the notices."""
    day, shifts = placed_day(claim)
    label = TYPE_LABELS[claim_type(claim)]
    if day is None:
        return label
    return f"{label} ({shifts_text(shifts)} shift) on {day.day} {day.strftime('%b')}"


def default_reason(source: Source, use_date: dt.date, shifts: Decimal) -> str:
    return (
        f"{TYPE_LABELS[source.comp_type]}: {shifts_text(shifts)} shift taken on {date_text(use_date)}"
        + (f" ({source.title.lower()})" if source.type != SOURCE_BALANCE else " (from the balance)")
        + ". Date chosen by HR."
    )


def clean_reason(raw) -> str:
    text = " ".join(str(raw or "").split())
    if len(text) > MAX_REASON_LENGTH:
        raise PlacementError("invalid", f"The reason can be at most {MAX_REASON_LENGTH} characters.")
    return text


def day_kind_of(d: dt.date) -> str | None:
    return day_kind(d, holiday_names(d, d))
