"""
Compensation apply: turning a relaxation HR grants into attendance, and the compensation BALANCE.

Two ways HR gives an employee a day (or part of a day) off with pay:
  * a Type 2 OT record assigned as RELAXATION on a claim date (compensation_views.overtime_assign), and
  * redeeming shifts from the compensation balance on a date (compensation_views.balance_redeem).
Both write one plain row (the OvertimeRecord's `claim_date` + `shifts`, or a CompensationLedger debit) and then call
`apply_relaxation` here. The row is the source of truth: attendance_final.compute_day_record reads the grants of a date
(compensation_engine.build_context) and tops the computed day up, so the top-up survives every later re-computation (a
punch sync, a payroll run) and disappears with the grant. A day HR set by hand (source = manual) is never recomputed, so
for that one `apply_relaxation` tops the stored row up in place, once.

The rules, in one place (all enforced by `check_relaxation_day`):
  * the date must be a WORKING day for the employee: not a Sunday, a declared company holiday or an off Saturday (those
    are already days off, a relaxation there would be worth nothing);
  * a day that already earns a full paid shift is refused, and so is an amount that would take it past 1.00 shift (the
    relaxation never pays more than one shift for a day, and HR's amount is never silently shortened);
  * an absent day, a half day, a quarter-shift arrival and an approved UNPAID leave day are all fine: the relaxation is
    what makes them paid;
  * a date in the future is fine (the day is topped up when it arrives), checked against what that day WILL earn: a day
    HR set by hand (an approved Casual Leave is one) keeps its stored shifts, and a paid birthday leave is a full day,
    so neither can take a relaxation it would silently waste; a past date too (HR regularising a day off the employee
    already took).

The balance (`balance_of`) is in shifts: ledger credits (approved holiday-work claims) + legacy compensation credits that
are still available (one shift each) - ledger debits (redemptions). A debit with source `legacy_credit` only mirrors a
legacy credit being used and is not subtracted a second time.
"""

from datetime import date as date_type
from decimal import Decimal

from django.db.models import Count, Sum

from . import compensation_engine as comp
from .clock import ist_today
from .models import (
    AttendanceDayRecord,
    CompensationLeaveCredit,
    CompensationLedger,
    OvertimeRecord,
    PayrollSettings,
)

ZERO = Decimal("0.00")
ONE = Decimal("1.00")


class RelaxationRefused(Exception):
    """The relaxation cannot be given on that date. The message is a plain sentence for HR."""


# ── what a day already holds ────────────────────────────────────────────────


def granted_for_day(emp, d: date_type) -> Decimal:
    """Shifts of relaxation already granted for (emp, d): assigned OT relaxation + balance redemptions."""
    ot = OvertimeRecord.objects.filter(
        employee=emp,
        ot_type=OvertimeRecord.OT_TYPE_SHIFT,
        status=OvertimeRecord.STATUS_ANNOUNCED,
        compensation_type=OvertimeRecord.TYPE_RELAXATION,
        claim_date=d,
    ).aggregate(total=Sum("shifts"))["total"]
    debits = CompensationLedger.objects.filter(
        employee=emp, entry_type=CompensationLedger.ENTRY_DEBIT, date=d
    ).aggregate(total=Sum("shifts"))["total"]
    return Decimal(ot or 0) + Decimal(debits or 0)


def day_shifts_now(emp, d: date_type, settings=None) -> Decimal:
    """Shifts the day earns right now. A past / current day: its computed record (which already includes grants). A
    future day has no computed record yet, so what it WILL earn is worked out from what is already known: a day HR set
    by hand keeps its stored shifts (the engine never recomputes it, so a grant is already inside that figure), a paid
    birthday leave is a full day, and anything else earns what has been granted for it."""
    if d > ist_today():
        manual = AttendanceDayRecord.objects.filter(employee=emp, date=d, source="manual").first()
        if manual is not None:
            return Decimal(manual.shifts_earned or 0)
        if _birthday_leave_on(emp, d, settings):
            return ONE
        return granted_for_day(emp, d)
    from .attendance_final import compute_range_records

    records = compute_range_records(emp, d, d, settings)
    return Decimal(records[0].shifts_earned or 0) if records else ZERO


def _birthday_leave_on(emp, d: date_type, settings=None) -> bool:
    """Is `d` this employee's paid birthday leave under the CURRENT switches (the engine decides when the day arrives)?"""
    ctx = comp.build_context(settings or PayrollSettings.get(), d, d, employee_ids=[emp.pk])
    return comp.birthday_applies(emp, d, ctx)


def _off_day_reason(emp, d: date_type) -> str | None:
    if d.weekday() == 6:
        return "a Sunday"
    from .attendance_final import _holiday_dates_for_month

    if d in _holiday_dates_for_month(d.year, d.month):
        return "a company holiday"
    if comp.is_off_day(emp, d):
        return "an off Saturday"
    return None


def check_relaxation_day(emp, d: date_type, shifts: Decimal, settings=None) -> Decimal:
    """Validate giving `shifts` of relaxation on `d` (see the module docstring); returns the shifts the day earns now.
    Raises RelaxationRefused with the reason."""
    if emp.employment_type != "staff":
        raise RelaxationRefused("Compensation applies to staff employees only.")
    if emp.status != "active":
        raise RelaxationRefused("This employee is not active.")
    off = _off_day_reason(emp, d)
    if off:
        raise RelaxationRefused(f"{d.strftime('%d %b %Y')} is {off}, which is already a day off: choose a working day.")
    current = day_shifts_now(emp, d, settings)
    if current >= ONE:
        raise RelaxationRefused(
            f"{d.strftime('%d %b %Y')} is already a full paid day for this employee: choose another day."
        )
    if current + Decimal(shifts) > ONE:
        room = ONE - current
        raise RelaxationRefused(
            f"{d.strftime('%d %b %Y')} already earns {current:.2f} shift, so at most {room:.2f} can be added: "
            "choose a smaller amount or another day."
        )
    return current


# ── applying ────────────────────────────────────────────────────────────────


def apply_relaxation(emp, d: date_type, shifts: Decimal, source_label: str, settings=None):
    """Make the relaxation that was just recorded (an OvertimeRecord claim or a ledger debit) show on the day NOW.
    Returns the day's AttendanceDayRecord, or None for a future date with no day set by hand (it is topped up when the
    day arrives).

    An auto-computed day is simply re-derived (the engine reads the grant). A day HR set by hand is never recomputed, so
    that row is topped up in place - once, here, whatever its date (on the day itself the engine would leave it alone)."""
    from .attendance_final import compute_range_records

    record = AttendanceDayRecord.objects.filter(employee=emp, date=d).first()
    by_hand = record is not None and record.source == "manual"
    if d > ist_today() and not by_hand:
        return None
    if by_hand:
        total, added = comp.relaxation_topup(Decimal(record.shifts_earned or 0), [(Decimal(shifts), source_label)])
        if added > 0:
            record.status, record.is_half_shift = comp.status_for_total(total)
            record.shifts_earned = total
            record.compensation_kind = comp.KIND_RELAXATION
            record.compensation_note = f"Compensation relaxation: {added:.2f} shift added from {source_label}"
            record.save()
        return record
    records = compute_range_records(emp, d, d, settings)
    return records[0] if records else None


# ── the balance ─────────────────────────────────────────────────────────────


def balance_of(emp) -> Decimal:
    """The compensation balance of one employee, in shifts (see the module docstring)."""
    return balances_for([emp.pk]).get(emp.pk, ZERO)


def balances_for(employee_ids) -> dict:
    """{employee_id: balance in shifts} for the given employees (employees with no entry at all are absent)."""
    ids = list(employee_ids)
    out: dict = {}

    def add(emp_id, amount):
        out[emp_id] = out.get(emp_id, ZERO) + Decimal(amount)

    for row in (
        CompensationLedger.objects.filter(employee_id__in=ids, entry_type=CompensationLedger.ENTRY_CREDIT)
        .values("employee_id")
        .annotate(total=Sum("shifts"))
    ):
        add(row["employee_id"], row["total"] or 0)
    for row in (
        CompensationLedger.objects.filter(employee_id__in=ids, entry_type=CompensationLedger.ENTRY_DEBIT)
        .exclude(source="legacy_credit")
        .values("employee_id")
        .annotate(total=Sum("shifts"))
    ):
        add(row["employee_id"], -(row["total"] or 0))
    # one shift per still-available legacy credit
    for row in (
        CompensationLeaveCredit.objects.filter(employee_id__in=ids, status=CompensationLeaveCredit.STATUS_AVAILABLE)
        .values("employee_id")
        .annotate(count=Count("id"))
    ):
        add(row["employee_id"], ONE * row["count"])
    return out
