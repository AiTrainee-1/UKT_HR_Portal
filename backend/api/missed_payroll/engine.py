"""Missed Payroll figures: what the REGULAR payroll engine would write for one employee, without writing it.

Staff: payroll_views._generate_staff_payroll for the month. Production: payroll_views._generate_production_payroll for the
days of the month that no payroll pays yet (production_coverage.py), or - for a parked new joiner - for the parked row's
own period. Each runs inside a transaction that is always rolled back (as the Staff Payroll's skip check does), so the
figures are exactly the regular payroll's - attendance, OT, Excess, PF / ESI / TDS, late pricing, advance instalments -
and nothing is saved: not the payroll, not the slip, not the advance repayments, not the day records it works out.

`figures` keeps the Payroll and SalarySlip values the engine produced; Done (write()) writes exactly those values into the
month's rows, marks the advance repayments they deducted as processed (once) and stamps the row source "missed_payroll".
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.db import models, transaction
from django.utils import timezone

from .. import production_coverage as coverage
from ..clock import ist_today
from ..models import Employee, MissedPayroll, Payroll, SalarySlip

KIND_STAFF = MissedPayroll.KIND_STAFF
KIND_PRODUCTION = MissedPayroll.KIND_PRODUCTION
MONTHS = (
    "",
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

PAYROLL_FIELDS = (
    "salary_mode",
    "month",
    "year",
    "week_number",
    "total_working_days",
    "present_days",
    "absent_days",
    "completed_sessions",
    "ot_hours",
    "ot_amount",
    "base_salary",
    "gross_salary",
    "deductions",
    "tds_deduction",
    "tds_percent",
    "bonus",
    "final_salary",
    "notes",
    "period_start",
    "period_end",
    "pay_cycle",
    "paid_ranges",
)
SLIP_FIELDS = (
    "month",
    "year",
    "week_number",
    "slip_number",
    "basic",
    "hra",
    "allowances",
    "incentives",
    "bonuses",
    "ot_amount",
    "gross_salary",
    "pf_deduction",
    "esi_deduction",
    "tds_deduction",
    "tds_percent",
    "advance_deduction",
    "other_deductions",
    "total_deductions",
    "net_salary",
    "working_days",
    "present_days",
    "absent_days",
    "paid_leave_days",
    "unpaid_leave_days",
    "late_days",
    "completed_sessions",
    "breakdown_details",
    "period_start",
    "period_end",
    "pay_cycle",
)


class Refused(Exception):
    """The employee's missed payroll cannot be worked out / written: the message says why, in plain words."""


class _Rollback(Exception):
    pass


def label(month: int, year: int) -> str:
    return f"{MONTHS[month]} {year}"


def month_bounds(month: int, year: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def month_ended(month: int, year: int, today: date | None = None) -> bool:
    """A production month can be paid from the day after its last day (a night shift of the last day ends then)."""
    return month_bounds(month, year)[1] < (today or ist_today())


def month_started(month: int, year: int, today: date | None = None) -> bool:
    return month_bounds(month, year)[0] <= (today or ist_today())


def production_cycle(emp: Employee) -> str:
    """The cycle a missed production row is stamped with: the worker's own, Monthly when they have none (its late rules
    and its PF / ESI month equivalent)."""
    return emp.production_pay_cycle or "monthly"


# ─────────────────────────────────────────────────────────────────────────────
#  Values in and out of JSON
# ─────────────────────────────────────────────────────────────────────────────


def _dump(obj, fields) -> dict:
    out = {}
    for name in fields:
        value = getattr(obj, name)
        if isinstance(value, Decimal):
            value = str(value)
        elif isinstance(value, (date, datetime)):
            value = value.isoformat()
        out[name] = value
    return out


def restore(model, values: dict) -> dict:
    """Saved values back to what the model's fields hold (dates, Decimals)."""
    out = {}
    for name, value in (values or {}).items():
        f = model._meta.get_field(name)
        if value is not None and not isinstance(f, models.JSONField):
            value = f.to_python(value)
        out[name] = value
    return out


def advance_details(slip_values: dict) -> list[dict]:
    bd = (slip_values or {}).get("breakdown_details") or {}
    return list(((bd.get("deductions") or {}).get("advanceDetails")) or [])


def _capture(payroll: Payroll, slip: SalarySlip, kind: str) -> dict:
    p = _dump(payroll, PAYROLL_FIELDS)
    s = _dump(slip, SLIP_FIELDS)
    extra = Decimal(str(payroll.ot_amount or 0)) if kind == KIND_STAFF else Decimal("0")
    return {
        "kind": kind,
        "payroll": p,
        "slip": s,
        "advanceDetails": advance_details(s),
        # E salary as the Salary Statement prints it: gross + OT (staff) + Excess / bonus
        "gross": str(Decimal(str(payroll.gross_salary)) + extra + Decimal(str(payroll.bonus or 0))),
        "deductions": str(payroll.deductions),
        "net": str(payroll.final_salary),
    }


def amounts(figures: dict) -> tuple[Decimal, Decimal, Decimal]:
    return (
        Decimal(str(figures.get("gross") or 0)),
        Decimal(str(figures.get("deductions") or 0)),
        Decimal(str(figures.get("net") or 0)),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  The rows the regular payroll already has
# ─────────────────────────────────────────────────────────────────────────────


def staff_row(employee_id: int, month: int, year: int) -> Payroll | None:
    """The employee's staff payroll of the month, if the regular payroll made one (held, parked or in the payroll)."""
    return (
        Payroll.objects.filter(
            employee_id=employee_id,
            salary_mode=Payroll.SALARY_MODE_MONTHLY,
            month=month,
            year=year,
            week_number=None,
            period_start__isnull=True,
        )
        .order_by("id")
        .first()
    )


def parked_rows(employee_ids, month: int, year: int) -> dict[int, Payroll]:
    """employee id -> their parked production row (a new joiner / transfer waiting in New Joiners) whose period ends in the
    month (the month a production row belongs to)."""
    out: dict[int, Payroll] = {}
    for p in Payroll.objects.filter(
        employee_id__in=list(employee_ids),
        salary_mode=Payroll.SALARY_MODE_SHIFT,
        period_start__isnull=False,
        month=month,
        year=year,
        new_joiner_parked=True,
    ).order_by("period_start", "id"):
        out.setdefault(p.employee_id, p)
    return out


def unpaid_ranges(spans, month: int, year: int, today: date | None = None) -> list[tuple[date, date]]:
    """The days of the month (up to yesterday) no payroll row pays: a final row, a draft or a staff month all count, so
    Missed Payroll never pays a day the Production Payroll has worked out."""
    first, last = month_bounds(month, year)
    last = min(last, (today or ist_today()) - timedelta(days=1))
    if last < first:
        return []
    return coverage.subtract((first, last), [(s.start, s.end) for s in spans])


def ranges_json(ranges) -> list[list[str]]:
    return [[a.isoformat(), b.isoformat()] for a, b in ranges]


def ranges_from_json(raw) -> list[tuple[date, date]]:
    return [(date.fromisoformat(a), date.fromisoformat(b)) for a, b in raw or []]


# ─────────────────────────────────────────────────────────────────────────────
#  Working it out (always rolled back)
# ─────────────────────────────────────────────────────────────────────────────


def _dry_run(fn) -> dict:
    from ..payroll_views import PayrollSkip

    captured: dict = {}
    try:
        with transaction.atomic():
            captured = fn()
            raise _Rollback()
    except _Rollback:
        return captured
    except PayrollSkip as exc:
        raise Refused(str(exc)) from None
    except Refused:
        raise
    except Exception as exc:  # the engine's own failure, said as it is
        raise Refused(f"The payroll could not be worked out: {exc}") from None


def _check_row(row: Payroll | None) -> None:
    if row is None:
        return
    if row.source == Payroll.SOURCE_MISSED_PAYROLL:
        raise Refused("Already added to the month's payroll from this page (Done).")
    if row.payment_status == Payroll.PAYMENT_PAID:
        raise Refused("This salary is already marked Paid: a paid salary is never worked out again.")
    if row.released_from:
        raise Refused("Already released and paid separately on the Staff Payroll page.")


def compute_staff(emp: Employee, month: int, year: int) -> dict:
    """The staff month as the Staff Payroll would work it out now. `replaces`: the held / parked (or, for someone made
    inactive, the earlier) row of the month this one will replace on Done."""
    from ..payroll_views import _generate_staff_payroll

    if not month_started(month, year):
        raise Refused(f"{label(month, year)} has not started yet.")
    existing = staff_row(emp.id, month, year)
    _check_row(existing)

    def run():
        result = _generate_staff_payroll(emp, month, year, allow_locked=True)
        return _capture(result["payroll"], result["slip"], KIND_STAFF)

    figures = _dry_run(run)
    figures["replaces"] = existing.id if existing is not None else None
    first, last = month_bounds(month, year)
    figures["payRanges"] = ranges_json([(first, last)])
    return figures


def compute_production(emp: Employee, month: int, year: int, parked: Payroll | None = None, spans=None) -> dict:
    """Production: a parked new joiner's own period (as the Production Payroll would work it out now), else the days of
    the month that no payroll pays yet, as one row for the whole month."""
    from ..payroll_views import _generate_production_payroll

    if not month_ended(month, year):
        raise Refused(f"{label(month, year)} has not ended yet: production pay is worked out once the month is over.")
    spans = spans if spans is not None else coverage.spans_for_employee(emp.id)
    if parked is not None:
        _check_row(parked)
        start, end = parked.period_start, parked.period_end
        cycle = parked.pay_cycle or production_cycle(emp)
        plan = coverage.plan_period(spans, start, end, cycle)
        if plan.refused:
            raise Refused(plan.refusal_reason())
        pay_ranges = plan
        pay_json = ranges_json(plan.paid_ranges)
    else:
        start, end = month_bounds(month, year)
        cycle = production_cycle(emp)
        ranges = unpaid_ranges(spans, month, year)
        if not ranges:
            raise Refused(f"Every day of {label(month, year)} is already in a payroll.")
        if Payroll.objects.filter(employee=emp, period_start=start, period_end=end).exists():
            raise Refused(f"A payroll for exactly {label(month, year)} already exists for this worker.")
        pay_ranges = ranges
        pay_json = ranges_json(ranges)

    def run():
        result = _generate_production_payroll(
            emp, start, end, pay_cycle=cycle, pay_ranges=pay_ranges, allow_locked=True
        )
        return _capture(result["payroll"], result["slip"], KIND_PRODUCTION)

    figures = _dry_run(run)
    figures["replaces"] = parked.id if parked is not None else None
    figures["payRanges"] = pay_json
    return figures


# ─────────────────────────────────────────────────────────────────────────────
#  Done: into the month's payroll
# ─────────────────────────────────────────────────────────────────────────────


def _slip_for(emp: Employee, kind: str, values: dict) -> SalarySlip:
    if kind == KIND_STAFF:
        found = SalarySlip.objects.filter(
            employee=emp, month=values["month"], year=values["year"], week_number=None, period_start__isnull=True
        ).first()
    else:
        found = SalarySlip.objects.filter(
            employee=emp, period_start=values["period_start"], period_end=values["period_end"]
        ).first()
    if found is None:
        found = SalarySlip.objects.filter(slip_number=values["slip_number"]).first()
    return found if found is not None else SalarySlip(employee=emp)


def write(entry: MissedPayroll, actor: str) -> Payroll:
    """Done: the saved figures become the month's Payroll + SalarySlip (a held / parked row is replaced and released into
    the month; otherwise a new row). The row is Cleared, in the month's records and statement, source "missed_payroll"
    (the month's bank file and Mark as Paid leave it out: this page pays it). The advance instalments it deducted are
    marked processed. Raises Refused when the month's rows changed since the figures were worked out."""
    from ..payroll_views import _mark_repayments_processed

    figures = entry.figures or {}
    p_values = restore(Payroll, figures.get("payroll"))
    s_values = restore(SalarySlip, figures.get("slip"))
    if not p_values or not s_values:
        raise Refused("Nothing was worked out for this employee: generate it again.")
    emp = entry.employee
    if entry.kind == KIND_STAFF:
        existing = staff_row(emp.id, entry.month, entry.year)
    else:
        existing = (
            Payroll.objects.filter(
                employee=emp, period_start=p_values["period_start"], period_end=p_values["period_end"]
            )
            .order_by("id")
            .first()
        )
    if entry.replaces_id:
        if existing is None or existing.id != entry.replaces_id:
            raise Refused("The payroll row this one replaces has changed since it was worked out: generate it again.")
        _check_row(existing)
        row = existing
    else:
        if existing is not None:
            raise Refused(
                f"{label(entry.month, entry.year)} now has a payroll for this employee (made on the "
                f"{'Staff' if entry.kind == KIND_STAFF else 'Production'} Payroll page): nothing to add."
            )
        if entry.kind == KIND_PRODUCTION:
            now_unpaid = unpaid_ranges(coverage.spans_for_employee(emp.id), entry.month, entry.year)
            if ranges_json(now_unpaid) != figures.get("payRanges"):
                raise Refused("Other payrolls paid some of these days since they were worked out: generate it again.")
        row = Payroll(employee=emp)

    now = timezone.now()
    was_held, was_parked = bool(row.on_hold), bool(row.new_joiner_parked)
    for name, value in p_values.items():
        setattr(row, name, value)
    row.status = Payroll.STATUS_PAID  # Cleared: it was checked on this page before Done
    row.on_hold = False
    row.new_joiner_parked = False
    row.parked_reason = ""
    row.released_from = None
    row.source = Payroll.SOURCE_MISSED_PAYROLL
    if was_held:
        row.hold_changed_at, row.hold_changed_by = now, actor
    if was_parked or entry.category == "new_joiner":
        row.added_to_payroll_at, row.added_to_payroll_by = now, actor
    row.save()

    slip = _slip_for(emp, entry.kind, s_values)
    for name, value in s_values.items():
        setattr(slip, name, value)
    slip.payroll_run = None
    slip.save()

    details = figures.get("advanceDetails") or []
    if details:
        _mark_repayments_processed(details)
    return row
