"""Excess tab of the Staff Payroll and of each Production Payroll cycle: amounts HR adds to (Excess) or takes off
(Detection) one employee's earned salary, with a mandatory remark (owner 2026-11-20). Models: models/payroll_excess.py;
endpoints: payroll_excess_views.py.

A Scope is what one entry belongs to: a STAFF payroll month, or one PRODUCTION pay period (cycle + periodStart..End).

The rules
---------
* An entry is an Excess (added to the earned salary) or a Detection (taken off it), a positive amount, for one employee
  and one scope, with a mandatory remark. Changing the amount or removing the entry needs a remark too; every action
  writes PayrollExcessHistory (who, when, previous / new amount, remark, the payroll NET before / after).
* Only an employee that payroll can pay may get one. Staff: active staff with a monthly salary, joined by the month's
  end. Production: active production worker with a salary per shift, joined by the period's end, on this cycle now or
  already in the period's payroll, and not already marked Paid for it. Never a month / period in the future, nor one
  finalized with Payroll Done (payroll_month_workflow / production_period_workflow: locked).
* The scope's net (excess - detection) is the payroll's `bonus`: the engines (_generate_staff_payroll,
  _generate_production_payroll) read it on every Generate / Generate again, and apply_to_payroll() puts it on an already
  generated payroll at once, with the NET worked out as the payroll PATCH does (gross + OT + bonus - deductions, rounded
  up to the rupee). So an amount never disappears on a regeneration and is never counted twice: the bonus is always SET
  from the entries, never added to.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from . import payroll_month_workflow as month_workflow
from .clock import ist_today
from .compensation_shared import parse_join_date
from .models import Employee, Payroll, PayrollExcessEntry, PayrollExcessHistory, SalarySlip
from .pf_esi import d2, round_up_rupee

ZERO = Decimal("0")
MAX_AMOUNT = Decimal("1000000")
REMARK_MIN, REMARK_MAX = 3, 500
MONTHS = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]  # fmt: skip
KIND_LABELS = {PayrollExcessEntry.KIND_EXCESS: "Excess", PayrollExcessEntry.KIND_DETECTION: "Detection"}
STAFF, PRODUCTION = "staff", "production"


class ExcessError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class MonthAmounts:
    excess: Decimal = ZERO
    detection: Decimal = ZERO

    @property
    def net(self) -> Decimal:
        return d2(self.excess - self.detection)


@dataclass(frozen=True)
class Scope:
    """A staff payroll month, or one production pay period (month / year = the month the period ends in)."""

    kind: str
    month: int
    year: int
    cycle: str | None = None
    start: date | None = None
    end: date | None = None

    @classmethod
    def staff(cls, month: int, year: int) -> Scope:
        return cls(STAFF, int(month), int(year))

    @classmethod
    def production(cls, cycle: str, start: date, end: date) -> Scope:
        return cls(PRODUCTION, end.month, end.year, cycle, start, end)

    @classmethod
    def of_entry(cls, e) -> Scope:
        if e.period_start is not None:
            return cls.production(e.pay_cycle, e.period_start, e.period_end)
        return cls.staff(e.month, e.year)

    @property
    def is_production(self) -> bool:
        return self.kind == PRODUCTION

    @property
    def last_day(self) -> date:
        return self.end if self.is_production else month_end(self.month, self.year)

    @property
    def label(self) -> str:
        if self.is_production:
            from .production_period_workflow import period_label

            return period_label(self.cycle, self.start, self.end)
        return f"{MONTHS[self.month]} {self.year}"

    def entry_q(self, prefix: str = "") -> Q:
        if self.is_production:
            return Q(**{f"{prefix}period_start": self.start, f"{prefix}period_end": self.end})
        return Q(**{f"{prefix}month": self.month, f"{prefix}year": self.year, f"{prefix}period_start__isnull": True})

    def fields(self) -> dict:
        return {"month": self.month, "year": self.year, "pay_cycle": self.cycle, "period_start": self.start,
                "period_end": self.end}  # fmt: skip

    def payroll_q(self) -> Q:
        if self.is_production:
            return Q(period_start=self.start, period_end=self.end)
        return Q(
            month=self.month,
            year=self.year,
            week_number=None,
            period_start__isnull=True,
            salary_mode=Payroll.SALARY_MODE_MONTHLY,
        )

    def slip_q(self) -> Q:
        if self.is_production:
            return Q(period_start=self.start, period_end=self.end)
        return Q(month=self.month, year=self.year, week_number=None, period_start__isnull=True)

    def locked(self) -> bool:
        if self.is_production:
            from . import production_period_workflow as period_workflow

            return period_workflow.is_locked(self.cycle, self.start, self.end)
        return month_workflow.is_locked(self.month, self.year)

    def locked_message(self) -> str:
        if self.is_production:
            from . import production_period_workflow as period_workflow

            return period_workflow.locked_message(self.cycle, self.start, self.end)
        return month_workflow.locked_message(self.month, self.year)


def month_end(month: int, year: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


# ───────────────────────────── reading ─────────────────────────────


def scope_amounts(employee_ids, scope: Scope) -> dict[int, MonthAmounts]:
    """{employee id: the scope's active excess and detection totals} in one query."""
    rows = (
        PayrollExcessEntry.objects.filter(scope.entry_q())
        .filter(employee_id__in=list(employee_ids), status=PayrollExcessEntry.STATUS_ACTIVE)
        .values("employee_id", "kind")
        .annotate(total=Sum("amount"))
    )
    out: dict[int, dict] = {}
    for row in rows:
        out.setdefault(row["employee_id"], {})[row["kind"]] = d2(row["total"] or ZERO)
    return {
        emp_id: MonthAmounts(
            excess=v.get(PayrollExcessEntry.KIND_EXCESS, ZERO), detection=v.get(PayrollExcessEntry.KIND_DETECTION, ZERO)
        )
        for emp_id, v in out.items()
    }


def month_amounts(employee_ids, month: int, year: int) -> dict[int, MonthAmounts]:
    return scope_amounts(employee_ids, Scope.staff(month, year))


def amounts_for(emp, month: int, year: int) -> MonthAmounts:
    """One staff employee's month (what the staff payroll engine puts in `bonus`)."""
    return month_amounts([emp.id], month, year).get(emp.id, MonthAmounts())


def amounts_for_period(emp, start: date, end: date) -> MonthAmounts:
    """One production worker's pay period (what the production payroll engine puts in `bonus`)."""
    scope = Scope(PRODUCTION, end.month, end.year, None, start, end)
    return scope_amounts([emp.id], scope).get(emp.id, MonthAmounts())


def breakdown_json(amounts: MonthAmounts) -> dict:
    """The `excess` block of a payslip's breakdown (additive; the details page and the slip can show it)."""
    return {"excess": float(amounts.excess), "detection": float(amounts.detection), "net": float(amounts.net)}


def payroll_of(emp_id: int, scope: Scope, *, lock: bool = False) -> Payroll | None:
    qs = Payroll.objects.filter(scope.payroll_q(), employee_id=emp_id)
    if lock:
        qs = qs.select_for_update()
    return qs.order_by("-id").first()


def staff_payroll_of(emp_id: int, month: int, year: int, *, lock: bool = False) -> Payroll | None:
    return payroll_of(emp_id, Scope.staff(month, year), lock=lock)


# ───────────────────────────── validation ─────────────────────────────


def check_scope(scope: Scope) -> None:
    today = ist_today()
    if scope.is_production:
        if scope.start > today:
            raise ExcessError("Pick this pay period or an earlier one: a period that has not started has no payroll.")
    elif (scope.year, scope.month) > (today.year, today.month):
        raise ExcessError("Pick this month or an earlier one: a month that has not started has no payroll yet.")
    if scope.locked():
        raise ExcessError(scope.locked_message(), 409)


def check_month(month: int, year: int) -> None:
    check_scope(Scope.staff(month, year))


def ineligible_reason(emp: Employee, month_or_scope, year: int | None = None) -> str | None:
    """Why this employee cannot get an Excess / Detection for the scope (None = they can). Accepts (emp, month, year)
    for a staff month or (emp, scope)."""
    scope = month_or_scope if isinstance(month_or_scope, Scope) else Scope.staff(month_or_scope, year)
    production = emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION
    if scope.is_production and not production:
        return "Staff employee: not on the Production Payroll"
    if not scope.is_production and production:
        return "Production employee: not on the Staff Payroll"
    if (emp.status or "").lower() != "active":
        return "Inactive employee"
    if scope.is_production:
        if not emp.salary_per_shift or emp.salary_per_shift <= 0:
            return "No salary per shift on the profile"
    elif not emp.salary_amount or emp.salary_amount <= 0:
        return "No monthly salary on the profile"
    joined = parse_join_date(emp.join_date)
    if joined and joined > scope.last_day:
        return f"Joined after {scope.label}"
    if scope.is_production:
        payroll = payroll_of(emp.id, scope)
        if payroll is not None and payroll.payment_status == Payroll.PAYMENT_PAID:
            return "This salary is already marked Paid"
        if payroll is None and emp.production_pay_cycle != scope.cycle:
            from .production_cycles import CYCLE_LABELS

            other = CYCLE_LABELS.get(emp.production_pay_cycle or "")
            return f"On the {other} cycle" if other else "Not assigned to a pay cycle"
    return None


def clean_amount(raw) -> Decimal:
    try:
        amount = d2(Decimal(str(raw)))
    except (InvalidOperation, TypeError, ValueError):
        raise ExcessError("Enter the amount in rupees.") from None
    if amount <= 0:
        raise ExcessError("The amount must be more than zero.")
    if amount > MAX_AMOUNT:
        raise ExcessError("The amount is too large (at most 10,00,000).")
    return amount


def clean_remark(raw, what: str = "a remark") -> str:
    text = " ".join(str(raw or "").split())
    if len(text) < REMARK_MIN:
        raise ExcessError(f"Write {what} (at least {REMARK_MIN} characters).")
    if len(text) > REMARK_MAX:
        raise ExcessError(f"Keep the remark under {REMARK_MAX} characters.")
    return text


def clean_kind(raw) -> str:
    kind = str(raw or "").strip().lower()
    if kind not in KIND_LABELS:
        raise ExcessError("Choose Excess or Detection.")
    return kind


def _check_not_paid(entry) -> None:
    scope = Scope.of_entry(entry)
    if scope.is_production:
        payroll = payroll_of(entry.employee_id, scope)
        if payroll is not None and payroll.payment_status == Payroll.PAYMENT_PAID:
            raise ExcessError("This salary is already marked Paid: it can no longer be changed.", 409)


# ───────────────────────────── the payroll ─────────────────────────────


def apply_scope(emp_id: int, scope: Scope) -> tuple[Decimal, Decimal] | None:
    """Put the scope's excess - detection on an already generated payroll (bonus + NET, the slip's bonuses / net and its
    breakdown block). Returns (NET before, NET after), or None when there is no payroll for the employee yet (then the
    engine picks the entries up when it is generated). Only `bonus` and the NET move: the engine's other figures stay as
    they are, and the row's own "last computed" time too (an UPDATE, not a save)."""
    payroll = payroll_of(emp_id, scope, lock=True)
    if payroll is None:
        return None
    amounts = scope_amounts([emp_id], scope).get(emp_id, MonthAmounts())
    before = d2(payroll.final_salary or ZERO)
    bonus = amounts.net
    after = round_up_rupee(
        d2(payroll.gross_salary or ZERO) + d2(payroll.ot_amount or ZERO) + bonus - d2(payroll.deductions or ZERO)
    )
    Payroll.objects.filter(pk=payroll.pk).update(bonus=bonus, final_salary=after)
    slip = SalarySlip.objects.filter(scope.slip_q(), employee_id=emp_id).order_by("-id").first()
    if slip is not None:
        details = dict(slip.breakdown_details or {})
        details["excess"] = breakdown_json(amounts)
        details["netSalary"] = float(after)
        SalarySlip.objects.filter(pk=slip.pk).update(bonuses=bonus, net_salary=after, breakdown_details=details)
    return before, after


def apply_to_payroll(emp_id: int, month: int, year: int) -> tuple[Decimal, Decimal] | None:
    return apply_scope(emp_id, Scope.staff(month, year))


# ───────────────────────────── writing ─────────────────────────────


def _history(entry, action, previous, new, remark, actor, actor_name, net) -> PayrollExcessHistory:
    before, after = net if net else (None, None)
    return PayrollExcessHistory.objects.create(
        entry=entry,
        employee_id=entry.employee_id,
        month=entry.month,
        year=entry.year,
        pay_cycle=entry.pay_cycle,
        period_start=entry.period_start,
        period_end=entry.period_end,
        kind=entry.kind,
        action=action,
        previous_amount=previous,
        new_amount=new,
        remark=remark,
        source=entry.source,
        actor=actor,
        actor_name=actor_name,
        payroll_net_before=before,
        payroll_net_after=after,
    )


def add_entries(employees, month_or_scope, *args) -> dict:
    """One entry per employee (the same amount for each). Employees who cannot get one are listed with the reason.
    add_entries(employees, scope, kind, amount, remark, actor, actor_name) or, for a staff month,
    add_entries(employees, month, year, kind, amount, remark, actor, actor_name)."""
    if isinstance(month_or_scope, Scope):
        scope, (kind, amount, remark, actor, actor_name) = month_or_scope, args
    else:
        scope = Scope.staff(month_or_scope, args[0])
        kind, amount, remark, actor, actor_name = args[1:]
    check_scope(scope)
    kind, amount, remark = clean_kind(kind), clean_amount(amount), clean_remark(remark)
    employees = list(employees)
    source = PayrollExcessEntry.SOURCE_BULK if len(employees) > 1 else PayrollExcessEntry.SOURCE_MANUAL
    created, refused, updated = [], [], 0
    for emp in employees:
        reason = ineligible_reason(emp, scope)
        if reason:
            refused.append({"employeeId": emp.id, "code": emp.employee_code, "name": _name(emp), "reason": reason})
            continue
        with transaction.atomic():
            Employee.objects.select_for_update().filter(pk=emp.pk).first()
            entry = PayrollExcessEntry.objects.create(
                employee=emp, kind=kind, amount=amount, remark=remark, source=source, created_by=actor,
                created_by_name=actor_name, updated_by=actor, updated_by_name=actor_name, **scope.fields(),
            )  # fmt: skip
            net = apply_scope(emp.id, scope)
            _history(entry, PayrollExcessHistory.ACTION_ADDED, None, amount, remark, actor, actor_name, net)
        updated += 1 if net else 0
        created.append(entry)
    return {"created": created, "refused": refused, "payrollUpdated": updated}


def change_entry(entry: PayrollExcessEntry, amount, remark, actor, actor_name: str) -> tuple[PayrollExcessEntry, bool]:
    if entry.status != PayrollExcessEntry.STATUS_ACTIVE:
        raise ExcessError("This entry was removed; add a new one instead.")
    scope = Scope.of_entry(entry)
    check_scope(scope)
    _check_not_paid(entry)
    amount, remark = clean_amount(amount), clean_remark(remark, "the reason for the change")
    with transaction.atomic():
        entry = PayrollExcessEntry.objects.select_for_update().get(pk=entry.pk)
        previous = entry.amount
        if previous == amount:
            raise ExcessError("The amount is the same as before.")
        entry.amount, entry.updated_by, entry.updated_by_name = amount, actor, actor_name
        entry.save(update_fields=["amount", "updated_by", "updated_by_name", "updated_at"])
        net = apply_scope(entry.employee_id, scope)
        _history(entry, PayrollExcessHistory.ACTION_CHANGED, previous, amount, remark, actor, actor_name, net)
    return entry, net is not None


def remove_entries(entries, remark, actor, actor_name: str) -> dict:
    entries = [e for e in entries if e.status == PayrollExcessEntry.STATUS_ACTIVE]
    if not entries:
        raise ExcessError("Nothing to remove: the entries are already removed.")
    remark = clean_remark(remark, "the reason for removing")
    for scope in {Scope.of_entry(e) for e in entries}:
        check_scope(scope)
    for entry in entries:
        _check_not_paid(entry)
    removed = updated = 0
    for entry in entries:
        with transaction.atomic():
            entry = PayrollExcessEntry.objects.select_for_update().get(pk=entry.pk)
            if entry.status != PayrollExcessEntry.STATUS_ACTIVE:
                continue
            entry.status, entry.updated_by, entry.updated_by_name = PayrollExcessEntry.STATUS_REMOVED, actor, actor_name
            entry.save(update_fields=["status", "updated_by", "updated_by_name", "updated_at"])
            net = apply_scope(entry.employee_id, Scope.of_entry(entry))
            _history(entry, PayrollExcessHistory.ACTION_REMOVED, entry.amount, None, remark, actor, actor_name, net)
        removed += 1
        updated += 1 if net else 0
    return {"removed": removed, "payrollUpdated": updated}


# ───────────────────────────── JSON ─────────────────────────────


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _iso(dt) -> str | None:
    return timezone.localtime(dt).isoformat() if dt else None


def _day(d) -> str | None:
    return d.isoformat() if d else None


def _money(value) -> float | None:
    return float(value) if value is not None else None


def entry_json(e: PayrollExcessEntry) -> dict:
    return {
        "id": e.id,
        "employeeId": e.employee_id,
        "month": e.month,
        "year": e.year,
        "cycle": e.pay_cycle,
        "periodStart": _day(e.period_start),
        "periodEnd": _day(e.period_end),
        "kind": e.kind,
        "amount": float(e.amount),
        "remark": e.remark,
        "source": e.source,
        "status": e.status,
        "createdBy": e.created_by_name or "",
        "createdAt": _iso(e.created_at),
        "updatedBy": e.updated_by_name or "",
        "updatedAt": _iso(e.updated_at),
    }


def history_json(h: PayrollExcessHistory) -> dict:
    emp = h.employee
    return {
        "id": h.id,
        "entryId": h.entry_id,
        "employeeId": h.employee_id,
        "code": emp.employee_code if emp else "",
        "name": _name(emp) if emp else "",
        "department": emp.department.name if emp and emp.department_id and emp.department else "",
        "month": h.month,
        "year": h.year,
        "cycle": h.pay_cycle,
        "periodStart": _day(h.period_start),
        "periodEnd": _day(h.period_end),
        "kind": h.kind,
        "action": h.action,
        "source": h.source,
        "previousAmount": _money(h.previous_amount),
        "newAmount": _money(h.new_amount),
        "remark": h.remark,
        "by": h.actor_name or "",
        "at": _iso(h.at),
        "payrollNetBefore": _money(h.payroll_net_before),
        "payrollNetAfter": _money(h.payroll_net_after),
    }


def history_q(params, kind: str = STAFF) -> Q:
    """The history filters of one page: a staff month (or every staff month), or a production cycle's period (or every
    period of the cycle)."""
    q = Q()
    try:
        if kind == PRODUCTION:
            q &= Q(period_start__isnull=False)
            if params.get("cycle"):
                q &= Q(pay_cycle=str(params["cycle"]).strip().lower())
            if params.get("periodStart") and params.get("periodEnd"):
                q &= Q(
                    period_start=date.fromisoformat(params["periodStart"]),
                    period_end=date.fromisoformat(params["periodEnd"]),
                )
        else:
            q &= Q(period_start__isnull=True)
            if params.get("month") and params.get("year"):
                q &= Q(month=int(params["month"]), year=int(params["year"]))
            elif params.get("year"):
                q &= Q(year=int(params["year"]))
        if params.get("departmentId"):
            q &= Q(employee__department_id=int(params["departmentId"]))
        if params.get("employeeId"):
            q &= Q(employee_id=int(params["employeeId"]))
    except (TypeError, ValueError):
        raise ExcessError("Check the filters.") from None
    if params.get("kind"):
        q &= Q(kind=clean_kind(params["kind"]))
    action = str(params.get("action") or "").strip().lower()
    if action:
        if action not in (PayrollExcessHistory.ACTION_ADDED, PayrollExcessHistory.ACTION_CHANGED,
                          PayrollExcessHistory.ACTION_REMOVED):  # fmt: skip
            raise ExcessError("Check the filters.")
        q &= Q(action=action)
    return q
