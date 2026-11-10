"""Staff Payroll month workflow (owner 2026-11-10): Hold / Unhold, new joiners, Payroll Done, Mark as Paid.

Everything here is added ON TOP of the staff payroll engine (payroll_views._generate_staff_payroll). Nothing in this module
works out or changes a payroll figure: it only decides which list a staff payroll shows up in, locks a finished month, and
records (and tells the employee) that a salary was paid.

    Lists of one staff month (staff = Payroll.salary_mode "monthly", active employees only, as every payroll list):
        main payroll  the Records, their totals and the bank file: not on hold, not a parked new joiner, not paid separately
        statement     the Salary Statement (screen, PDF, Excel): main + on hold (Remarks HOLD) + paid separately; a parked
                      new joiner is NOT on it
        skipped       the Skipped Employees view: not generated (the engine's skip check), on hold, new joiners (parked),
                      and, once the month is locked, the held / new people that were released and paid on their own

    Hold          HR holds one employee's salary (details page). Unhold puts them back. Kept when the month is generated
                  again. Not allowed once the month is locked.
    New joiner    a join date inside the payroll month: the engine calculates them exactly as before, but the row is
                  PARKED (park_if_new_joiner, called by the engine after it saved the row) until HR presses "Add to
                  payroll" on Skipped. Once added they stay added through every regeneration.
    Payroll Done  finalize(): the month is LOCKED for good. No generate, regenerate, bonus / deduction change, Mark as
                  Cleared, hold or unhold, add to payroll; there is no reopen. The ONE exception: release_and_pay().
    Mark as Paid  mark_paid(): every employee in the main payroll gets payment status Paid with the date, and a phone
                  notification (no amount). The employee apps say Paid only from this status (mobile_pay.py): Cleared
                  (Payroll.status = "paid") is HR's own check and no longer reads as paid to the employee.
    Release & pay release_and_pay(): after the lock, one employee who was on hold or a parked new joiner leaves that list,
                  is marked Paid on their own date and notified; the page offers a bank file of just that person.

Who may act: Hold / Unhold / Add to payroll need payroll EDIT rights (the permission middleware already refuses a view-only
role on every POST under /api/payroll) and only reach the caller's own unit. Payroll Done, Mark as Paid and Release & pay are
company-wide: they also need a whole-company login (no unit / branch scope). A unit login sees the status, timer and dates.
"""

from __future__ import annotations

import calendar
import logging
import threading
from datetime import date, datetime

from django.db import IntegrityError, connections, transaction
from django.db.models import Max, Min, Q
from django.utils import timezone

from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ, ist_today
from .compensation_shared import parse_join_date
from .models import Payroll, PayrollMonthClose

logger = logging.getLogger(__name__)

MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

# The phone notification of a paid salary (a "Salary paid" switch on Mobile App Login > Mobile Messages, mobile_messages.py)
SALARY_PAID_SOURCE = "salary_paid"
SALARY_PAID_TITLE = "Salary Paid"


def month_label(month: int, year: int) -> str:
    return f"{MONTH_NAMES[month - 1]} {year}" if 1 <= month <= 12 else f"{month}/{year}"


# ─────────────────────────────────────────────────────────────────────────────
#  The lock
# ─────────────────────────────────────────────────────────────────────────────


class MonthLocked(Exception):
    """A write to a finalized staff month: answered as a 409 with this plain message."""


def month_close(month: int, year: int) -> PayrollMonthClose | None:
    return PayrollMonthClose.objects.filter(month=month, year=year).first()


def is_locked(month: int, year: int) -> bool:
    return PayrollMonthClose.objects.filter(month=month, year=year).exists()


def locked_message(month: int, year: int) -> str:
    return (
        f"{month_label(month, year)} payroll is finalized (Payroll Done) and locked for good: it can no longer be "
        "generated, recomputed or changed."
    )


def assert_open(month: int, year: int) -> None:
    """Raise MonthLocked when the staff month is finalized."""
    if is_locked(month, year):
        raise MonthLocked(locked_message(month, year))


def is_staff_month_row(payroll: Payroll) -> bool:
    """A staff monthly payroll (the only kind this workflow covers; production rows are never locked by it)."""
    return payroll.salary_mode == Payroll.SALARY_MODE_MONTHLY and payroll.period_start is None


# ─────────────────────────────────────────────────────────────────────────────
#  Which list a payroll is in
# ─────────────────────────────────────────────────────────────────────────────

# The Records, totals and bank file. Production rows are never held / parked / released, so this keeps all of them.
MAIN_PAYROLL_Q = Q(on_hold=False, new_joiner_parked=False, released_from__isnull=True)
# The month's Salary Statement: the main payroll plus the held salaries (Remarks HOLD; still HOLD-listed after a release
# and pay, then with PAID SEPARATELY). Never a new joiner, parked or released: they are only on the Skipped statement.
ON_STATEMENT_Q = Q(new_joiner_parked=False) & ~Q(released_from=Payroll.RELEASED_FROM_NEW_JOINER)
# The Skipped Employees' own statement and bank file (owner 2026-11-10): the payrolls NOT in the main payroll - on hold,
# new joiners not added, and those released and paid on their own. (Not generated employees have no payroll at all.)
SKIPPED_Q = Q(on_hold=True) | Q(new_joiner_parked=True) | Q(released_from__isnull=False)


def staff_month(month: int, year: int):
    """Every staff monthly payroll of the month, active employees only (as every payroll list shows them)."""
    return Payroll.objects.filter(
        salary_mode=Payroll.SALARY_MODE_MONTHLY,
        month=month,
        year=year,
        week_number=None,
        period_start__isnull=True,
        employee__status="active",
    )


def is_new_joiner(emp, month: int, year: int) -> bool:
    """Joined inside the payroll month (Employee.join_date is free text: unreadable = not new)."""
    joined = parse_join_date(getattr(emp, "join_date", None))
    return joined is not None and joined.year == year and joined.month == month


def park_if_new_joiner(payroll: Payroll, emp, month: int, year: int) -> None:
    """Called by the staff engine right after it saved the month's row: a new joiner is parked unless HR already added
    them (added_to_payroll_at) or they were released and paid after the lock. Only the flag is written, never a figure,
    and with an UPDATE so the row's "last computed" time stays the engine's own."""
    parked = is_new_joiner(emp, month, year) and payroll.added_to_payroll_at is None and not payroll.released_from
    if bool(payroll.new_joiner_parked) != parked:
        Payroll.objects.filter(pk=payroll.pk).update(new_joiner_parked=parked)
        payroll.new_joiner_parked = parked


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def payroll_flags(p: Payroll) -> dict:
    """The workflow keys of one payroll row in the API (the list, the details page, the employee side)."""
    return {
        "onHold": bool(p.on_hold),
        "holdChangedAt": _iso(p.hold_changed_at),
        "holdChangedBy": p.hold_changed_by or None,
        "newJoinerParked": bool(p.new_joiner_parked),
        "addedToPayrollAt": _iso(p.added_to_payroll_at),
        "addedToPayrollBy": p.added_to_payroll_by or None,
        "paymentStatus": p.payment_status or Payroll.PAYMENT_NOT_PAID,
        "paymentPaidAt": _iso(p.payment_paid_at),
        "paymentPaidBy": p.payment_paid_by or None,
        "releasedFrom": p.released_from or None,
    }


def employee_sees_paid(p: Payroll) -> bool:
    """Is this payroll PAID as the employee apps show it? A staff payroll: only once the month was marked paid (or the
    employee was released and paid on their own) - Cleared alone is not paid. A production payroll has no payment step
    in this workflow, so it keeps the rule it always had (status "paid")."""
    if is_staff_month_row(p):
        return p.payment_status == Payroll.PAYMENT_PAID
    return p.status == Payroll.STATUS_PAID


# ─────────────────────────────────────────────────────────────────────────────
#  Who may act
# ─────────────────────────────────────────────────────────────────────────────


def _hr_user(request):
    from .models import HRUser

    hr_user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    if not hr_user_id:
        return None
    return HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first()


def can_edit_payroll(request) -> bool:
    """Payroll EDIT rights (a super administrator always has them)."""
    from .permission_registry import effective_permissions, resolve_permission

    hr_user = _hr_user(request)
    if hr_user is None:
        return False
    if hr_user.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr_user), "payroll") == "edit"


def is_whole_company(request) -> bool:
    """Not limited to one unit / branch (a super administrator, or a role with no branch)."""
    return get_branch_scope(request) is None


def actor_name(request) -> str:
    from .auth import get_hr_display_name

    return get_hr_display_name(request)


# ─────────────────────────────────────────────────────────────────────────────
#  The month's status (Payroll Done / Payment Pending / Paid) and its timeline
# ─────────────────────────────────────────────────────────────────────────────


def _counts(rows) -> dict:
    """How many of the month's staff payrolls (a queryset of `staff_month`) are in each list."""
    main = rows.filter(MAIN_PAYROLL_Q)
    return {
        "inPayroll": main.count(),
        "notCleared": main.exclude(status=Payroll.STATUS_PAID).count(),
        "onHold": rows.filter(on_hold=True).count(),
        "newJoiners": rows.filter(new_joiner_parked=True).count(),
        "paidSeparately": rows.filter(released_from__isnull=False).count(),
        "paid": rows.filter(payment_status=Payroll.PAYMENT_PAID).count(),
        "notPaid": main.exclude(payment_status=Payroll.PAYMENT_PAID).count(),
    }


def days_between(start: datetime | None, end: datetime | None) -> int | None:
    """Whole days from finalizing to paying, counted on the calendar in India (the same evening = 0, next day = 1)."""
    if start is None or end is None:
        return None
    return (end.astimezone(FACTORY_TZ).date() - start.astimezone(FACTORY_TZ).date()).days


def month_status(request, month: int, year: int) -> dict:
    """GET /api/payroll/month-status: where the month stands, its timeline, the counts in the caller's scope and what the
    caller may do."""
    close = month_close(month, year)
    rows = scope_to_branch(staff_month(month, year), request, field="employee__branch_id")
    stamps = rows.aggregate(first=Min("created_at"), last=Max("updated_at"))
    edit = can_edit_payroll(request)
    whole = is_whole_company(request)
    locked = close is not None
    paid = bool(close and close.paid_at)
    counts = _counts(rows)
    last_day = date(year, month, calendar.monthrange(year, month)[1])
    return {
        "month": month,
        "year": year,
        "label": month_label(month, year),
        "state": "paid" if paid else "finalized" if locked else "open",
        "locked": locked,
        "monthEnded": ist_today() > last_day,
        "finalizedAt": _iso(close.finalized_at) if close else None,
        "finalizedBy": (close.finalized_by or None) if close else None,
        "paidAt": _iso(close.paid_at) if paid else None,
        "paidBy": (close.paid_by or None) if paid else None,
        "daysToPay": days_between(close.finalized_at, close.paid_at) if paid else None,
        # the timeline: the month's first generation and last computation (as they stood at finalization once locked)
        "firstGeneratedAt": _iso(close.first_generated_at if close else stamps["first"]),
        "lastComputedAt": _iso(close.last_computed_at if close else stamps["last"]),
        "counts": counts,
        "snapshot": (close.snapshot or None) if close else None,
        "wholeCompany": whole,
        "can": {
            "finalize": edit and whole and not locked and counts["inPayroll"] + counts["onHold"] > 0,
            "markPaid": edit and whole and locked and not paid,
            "hold": edit and not locked,
            "addToPayroll": edit and not locked,
            "releaseAndPay": edit and whole and locked,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Actions
# ─────────────────────────────────────────────────────────────────────────────


def set_hold(payroll: Payroll, hold: bool, actor: str) -> Payroll:
    """Hold or Unhold one staff payroll of an open month. Raises MonthLocked once the month is finalized."""
    assert_open(payroll.month, payroll.year)
    now = timezone.now()
    Payroll.objects.filter(pk=payroll.pk).update(on_hold=hold, hold_changed_at=now, hold_changed_by=actor)
    payroll.on_hold, payroll.hold_changed_at, payroll.hold_changed_by = hold, now, actor
    return payroll


def add_to_payroll(payroll: Payroll, actor: str) -> Payroll:
    """A parked new joiner joins the month's payroll (and stays in it through every regeneration)."""
    assert_open(payroll.month, payroll.year)
    now = timezone.now()
    Payroll.objects.filter(pk=payroll.pk).update(
        new_joiner_parked=False, added_to_payroll_at=now, added_to_payroll_by=actor
    )
    payroll.new_joiner_parked, payroll.added_to_payroll_at, payroll.added_to_payroll_by = False, now, actor
    return payroll


def finalize(month: int, year: int, actor: str) -> PayrollMonthClose:
    """Payroll Done: lock the month for good, with a snapshot of how it stood. Raises MonthLocked when already done."""
    rows = staff_month(month, year)
    stamps = rows.aggregate(first=Min("created_at"), last=Max("updated_at"))
    counts = _counts(rows)
    main_net = sum((p.final_salary for p in rows.filter(MAIN_PAYROLL_Q).only("final_salary")), 0)
    try:
        with transaction.atomic():
            return PayrollMonthClose.objects.create(
                month=month,
                year=year,
                finalized_at=timezone.now(),
                finalized_by=actor,
                first_generated_at=stamps["first"],
                last_computed_at=stamps["last"],
                snapshot={
                    "inPayroll": counts["inPayroll"],
                    "notCleared": counts["notCleared"],
                    "onHold": counts["onHold"],
                    "newJoiners": counts["newJoiners"],
                    "mainNet": float(main_net),
                },
            )
    except IntegrityError:
        raise MonthLocked(f"{month_label(month, year)} payroll was already finalized.") from None


def mark_paid(month: int, year: int, actor: str) -> tuple[PayrollMonthClose, list[int]]:
    """Mark as Paid: the month is Paid, and every employee in its main payroll who is not paid yet gets payment status
    Paid with this date. Returns (the month's close, the payroll ids newly marked paid). Raises ValueError when the month
    is not finalized or already paid."""
    with transaction.atomic():
        close = PayrollMonthClose.objects.select_for_update().filter(month=month, year=year).first()
        if close is None:
            raise ValueError(f"{month_label(month, year)} payroll is not finalized yet: press Payroll Done first.")
        if close.paid_at is not None:
            raise ValueError(f"{month_label(month, year)} payroll was already marked paid.")
        now = timezone.now()
        close.paid_at, close.paid_by = now, actor
        close.save(update_fields=["paid_at", "paid_by"])
        eligible = staff_month(month, year).filter(MAIN_PAYROLL_Q).exclude(payment_status=Payroll.PAYMENT_PAID)
        ids = list(eligible.values_list("id", flat=True))
        Payroll.objects.filter(id__in=ids).update(
            payment_status=Payroll.PAYMENT_PAID, payment_paid_at=now, payment_paid_by=actor
        )
    return close, ids


def release_and_pay(payroll: Payroll, actor: str) -> Payroll:
    """After the lock: an employee who was on hold or a parked new joiner is released and marked Paid on their own.
    Raises ValueError when the month is not finalized or the employee is neither held nor parked."""
    if not is_locked(payroll.month, payroll.year):
        raise ValueError("Release & pay is for after Payroll Done. Before that, use Unhold or Add to payroll instead.")
    if payroll.on_hold:
        released = Payroll.RELEASED_FROM_HOLD
    elif payroll.new_joiner_parked:
        released = Payroll.RELEASED_FROM_NEW_JOINER
    else:
        raise ValueError("Only an employee on hold or a new joiner not yet in the payroll can be released and paid.")
    now = timezone.now()
    changes = dict(
        on_hold=False,
        new_joiner_parked=False,
        released_from=released,
        payment_status=Payroll.PAYMENT_PAID,
        payment_paid_at=now,
        payment_paid_by=actor,
    )
    if released == Payroll.RELEASED_FROM_HOLD:
        changes.update(hold_changed_at=now, hold_changed_by=actor)
    with transaction.atomic():
        # only while still held / parked: a double click never releases twice
        done = (
            Payroll.objects.filter(pk=payroll.pk).filter(Q(on_hold=True) | Q(new_joiner_parked=True)).update(**changes)
        )
    if not done:
        raise ValueError("This employee was already released and paid.")
    for field, value in changes.items():
        setattr(payroll, field, value)
    return payroll


# ─────────────────────────────────────────────────────────────────────────────
#  Telling the employee: one phone notification per employee and month
# ─────────────────────────────────────────────────────────────────────────────


def salary_paid_text(month: int, year: int) -> str:
    """The notification's words: the month, never the amount (a lock screen shows it)."""
    return f"Your salary for {month_label(month, year)} has been paid."


def dedupe_key(employee_id: int, month: int, year: int) -> str:
    return f"salary_paid:{employee_id}:{year}-{month:02d}"


def notify_salary_paid(payroll_ids) -> int:
    """Save a "Salary Paid" notification for the employee of each payroll (which sends the phone push, signals.py). At
    most once per employee and month (the dedupe key), so a retry never notifies twice. Returns how many were made."""
    from .models import Notification

    made = 0
    rows = Payroll.objects.select_related("employee").filter(id__in=list(payroll_ids)).order_by("id")
    for p in rows:
        try:
            with transaction.atomic():
                Notification.objects.create(
                    employee=p.employee,
                    type="salary_slip",
                    title=SALARY_PAID_TITLE,
                    message=salary_paid_text(p.month, p.year),
                    source=SALARY_PAID_SOURCE,
                    related_module="payroll",
                    dedupe_key=dedupe_key(p.employee_id, p.month, p.year),
                )
            made += 1
        except IntegrityError:
            continue  # already told
        except Exception:
            logger.exception("Could not save the salary-paid notification of payroll %s", p.pk)
    return made


def run_in_background(job, name: str) -> None:
    """Run `job` on a thread once the current transaction has committed (never inside the request: a phone push per
    employee can take a while). Tests replace this to run the job at once."""

    def runner() -> None:
        try:
            job()
        except Exception:
            logger.exception("Background job %s failed", name)
        finally:
            connections.close_all()  # this thread's own connection

    transaction.on_commit(lambda: threading.Thread(target=runner, name=name, daemon=True).start())


def notify_later(payroll_ids, name: str) -> None:
    ids = list(payroll_ids)
    if ids:
        run_in_background(lambda: notify_salary_paid(ids), name)
