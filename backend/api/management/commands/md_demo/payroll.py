"""Closed payroll months: pay runs, salary slips, the matching payroll rows, advances and the statutory bonus.

Every slip is computed from the SAME simulated days the attendance tables are written from, with the payroll engine's own
formulas (``payroll_views._generate_staff_payroll`` for staff, ``_generate_production_payroll`` for production), so a slip is
consistent with that month's attendance, the employee's pay on that date, the late-coming pool, announced overtime and the
advance repayments due. Nothing is typed in by hand.

How the cost moves (a nameable reason for every step the MD will see):

* a steady drift from the working-day count, overtime and the people who joined or left;
* the company-wide increment cycle: pay rises from the first day of the increment month (``world.stories``);
* the statutory bonus for the previous financial year, paid with the LATEST closed month's salary (the pay day is the 5th, so
  that month is paid today): the visible jump.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time, timedelta
from decimal import Decimal
from types import SimpleNamespace

from api.attendance_final import late_pool_summary
from api.models import (
    Advance,
    AdvanceRepayment,
    Bonus,
    PayrollRun,
    Payroll,
    SalarySlip,
)
from api.payroll_views import _build_working_days, _d2, late_shift_deduction
from api.production_period import _calendar_month_period

from .common import RUN_CODE_PREFIX, World, at, chance, daterange, month_days
from .org import hr_name
from .people import Person, add_months

BONUS_PERCENT = Decimal("8.33")
ONE = Decimal(1)


@dataclass
class SlipPlan:
    person: Person
    slip: SalarySlip
    payroll: Payroll
    month: tuple[int, int]
    kind: str
    advance: Decimal = Decimal(0)


@dataclass
class AdvancePlan:
    person: Person
    kind: str  # general | term
    amount: Decimal
    status: str  # approved | closed | pending | rejected
    purpose: str
    created: object
    approved_at: object = None
    start: tuple[int, int] | None = None
    months: int = 1
    emi: Decimal = Decimal(0)
    schedule: list[tuple[int, int, Decimal]] = field(default_factory=list)


PURPOSES = [
    "Medical expenses for family",
    "Marriage expenses at native place",
    "Children's school fees",
    "House rent deposit",
    "Festival expenses",
    "Two-wheeler repair",
    "Repayment of a local loan",
    "Travel to native place",
]


# ─── advances ─────────────────────────────────────────────────────────────────────────────────────────────────


def plan_advances(world: World) -> list[AdvancePlan]:
    """A few advances, most of them to production workers: some repaid in full, some part way through, a few waiting."""
    plan = world.plan
    rng = world.streams("advances")
    today = plan.today
    count = max(3, round(plan.employees * 0.06))
    months = plan.closed_months
    first_payroll = date(months[0][0], months[0][1], 1)
    borrowers = [p for p in world.people if p.exit is None and p.join <= first_payroll - timedelta(days=60)]
    rng.shuffle(borrowers)
    out: list[AdvancePlan] = []
    for n, p in enumerate(borrowers[:count]):
        pending = n >= count - 2  # the last two requests are new and undecided (one of them will be rejected)
        kind = "general" if chance(rng, 0.6) else "term"
        monthly = p.rate if p.kind == "staff" else p.rate * 26
        if kind == "general":
            amount = Decimal(rng.choice([2000, 3000, 4000, 5000, 7000, 10000]))
        else:
            amount = Decimal(rng.choice([15000, 20000, 25000, 30000, 40000, 50000]))
        if pending:
            created = at(today - timedelta(days=rng.randint(0, 4)), time(11, 0))
            out.append(
                AdvancePlan(
                    p,
                    kind,
                    amount,
                    "rejected" if n == count - 1 and count > 3 else "pending",
                    rng.choice(PURPOSES),
                    created,
                )
            )
            continue
        approved_on = today - timedelta(days=rng.randint(20, 270))
        start_month = add_months(approved_on.replace(day=1), 1)
        emi = Decimal(0)
        n_months = 1
        if kind == "term":
            n_months = rng.choice([5, 6, 8, 10, 12])
            emi = (amount / n_months / 500).to_integral_value() * 500
            emi = max(emi, Decimal(500))
            emi = min(emi, (monthly * Decimal("0.25") / 100).to_integral_value() * 100)
            n_months = int((amount / emi).to_integral_value(rounding="ROUND_CEILING"))
        advance = AdvancePlan(
            p,
            kind,
            amount,
            "approved",
            rng.choice(PURPOSES),
            at(approved_on - timedelta(days=2), time(11, 0)),
            at(approved_on, time(15, 0)),
            (start_month.year, start_month.month),
            n_months,
            emi,
        )
        remaining = amount
        year, month = start_month.year, start_month.month
        for _ in range(n_months):
            pay = amount if kind == "general" else min(emi, remaining)
            advance.schedule.append((year, month, pay))
            remaining -= pay
            month += 1
            if month > 12:
                year, month = year + 1, 1
        out.append(advance)
    return out


def advance_deductions(
    advances: list[AdvancePlan], closed: set[tuple[int, int]]
) -> dict[tuple[int, int, int], Decimal]:
    """{(person idx, year, month): the repayment deducted in that closed month}."""
    out: dict[tuple[int, int, int], Decimal] = {}
    for a in advances:
        for year, month, pay in a.schedule:
            if (year, month) in closed:
                key = (a.person.idx, year, month)
                out[key] = out.get(key, Decimal(0)) + pay
    return out


# ─── slips ────────────────────────────────────────────────────────────────────────────────────────────────────


def _bonus_amount(p: Person) -> Decimal:
    """Statutory bonus: the year's wages up to the ceiling (min(basic, 7,000) x 12) at 8.33%."""
    monthly = p.rate if p.kind == "staff" else p.rate * 26
    basic = monthly / 2
    return _d2(min(basic, Decimal(7000)) * 12 * BONUS_PERCENT / 100)


def _bonus_eligible(world: World, p: Person) -> bool:
    ceiling = world.settings.bonus_eligibility_ceiling
    monthly = p.rate if p.kind == "staff" else p.rate * 26
    return p.exit is None and monthly <= ceiling and p.join <= world.plan.today - timedelta(days=200)


def _staff_slip(world: World, p: Person, year: int, month: int, extras: dict) -> SlipPlan | None:
    settings = world.settings
    holidays = {d for d in world.holidays if d.year == year and d.month == month}
    month_start = date(year, month, 1)
    month_last = month_days(year, month)[-1]
    if p.join > month_last or (p.exit is not None and p.exit < month_start):
        return None
    salary = p.rate_on(month_start)
    working = _build_working_days(month, year, p.saturday_off, holidays)
    total_days = len(working)
    days = world.days[p.idx]
    effective = Decimal(0)
    present = paid_leave = unpaid_leave = absent = late = early = half = full = 0
    records = []
    for d in working:
        day = days.get(d)
        status = day.status if day else "absent"
        if status in ("present", "half_shift"):
            present += 1
            shifts = day.shifts if day and day.shifts > 0 else ONE
            late += bool(day and day.is_late)
            early += bool(day and day.early_leave)
            if (day and day.is_half_shift) or shifts == Decimal("0.50"):
                half += 1
            else:
                full += 1
            effective += shifts
            records.append(
                SimpleNamespace(
                    date=d,
                    status=status,
                    is_late=day.is_late,
                    early_leave=day.early_leave,
                    morning_permission_excess=False,
                    evening_permission_excess=False,
                )
            )
        elif status == "on_leave":
            unpaid_leave += 1
        elif status == "holiday":
            paid_leave += 1
            effective += ONE
        else:
            absent += 1
    daily_exact = salary / Decimal(total_days)
    base_gross = _d2(daily_exact * effective)
    daily_rate = _d2(daily_exact)
    prorate = effective / Decimal(total_days)
    basic = _d2(_d2(salary * Decimal("0.50")) * prorate)
    hra = _d2(_d2(salary * Decimal("0.20")) * prorate)
    allowances = _d2(base_gross - basic - hra)

    pf = esi = Decimal(0)
    if settings.staff_payroll_rules_enabled:
        pf = _d2(basic * settings.pf_rate / 100) if settings.pf_rate > 0 else Decimal(0)
        if settings.esi_rate > 0 and _d2(salary) <= settings.esi_applicable_below:
            esi = _d2(base_gross * settings.esi_rate / 100)

    ot_days = extras["ot_pay_days"].get((p.idx, year, month), 0) if settings.compensation_feature_enabled else 0
    ot_amount = _d2(daily_rate * ot_days) if ot_days else Decimal(0)

    approved_permissions = extras["permissions"].get((p.idx, year, month), 0)
    pool = late_pool_summary(records, approved_permissions, settings, counted_dates=set(working))
    shift_deductions = late_shift_deduction(pool["billable"], settings)
    late_penalty = _d2(shift_deductions * daily_rate) if shift_deductions > 0 else Decimal(0)

    advance = extras["advances"].get((p.idx, year, month), Decimal(0))
    bonus = extras["bonus"].get((p.idx, year, month), Decimal(0))
    total_deductions = _d2(pf + esi + advance + late_penalty)
    gross = _d2(base_gross + bonus)
    net = _d2(gross + ot_amount - total_deductions)
    breakdown = {
        "type": "staff",
        "attendanceMode": "strict",
        "shift": {"name": world.shifts[(p.unit, p.shift_key)].name, "saturdayOff": p.saturday_off},
        "days": [],
        "summary": {
            "totalWorkingDays": total_days,
            "presentDays": present,
            "paidLeaveDays": paid_leave,
            "unpaidLeaveDays": unpaid_leave,
            "absentDays": absent,
            "lateDays": late,
            "earlyOutDays": early,
            "halfShiftDays": half,
            "fullShiftDays": full,
            "effectivePaidDays": float(effective),
        },
        "earnings": {
            "monthlySalary": float(salary),
            "dailyRate": float(daily_rate),
            "effectiveDays": float(effective),
            "basic": float(basic),
            "hra": float(hra),
            "allowances": float(allowances),
            "grossSalary": float(gross),
            "bonus": float(bonus),
            "otDays": ot_days,
            "otAmount": float(ot_amount),
        },
        "deductions": {
            "pf": float(pf),
            "pfRate": float(settings.pf_rate),
            "esi": float(esi),
            "esiRate": float(settings.esi_rate),
            "advances": float(advance),
            "lateShiftPenalty": float(late_penalty),
            "lateSummary": {
                "totalLateCount": pool["total"],
                "billableLateCount": pool["billable"],
                "shiftDeductions": float(shift_deductions),
                "freeAllowance": settings.late_free_allowance,
            },
            "total": float(total_deductions),
        },
        "netSalary": float(net),
    }
    when = min(at(add_months(month_start, 1).replace(day=3), time(16, 0)), at(world.plan.today, world.plan.now))
    slip = SalarySlip(
        employee=p.emp,
        month=month,
        year=year,
        slip_number=f"SS/{p.code}/{year}/{month:02d}",
        basic=basic,
        hra=hra,
        allowances=allowances,
        incentives=Decimal(0),
        bonuses=bonus,
        ot_amount=ot_amount,
        gross_salary=gross,
        pf_deduction=pf,
        esi_deduction=esi,
        advance_deduction=advance,
        other_deductions=late_penalty,
        total_deductions=total_deductions,
        net_salary=net,
        working_days=total_days,
        present_days=Decimal(present),
        absent_days=Decimal(absent + unpaid_leave),
        paid_leave_days=Decimal(paid_leave),
        unpaid_leave_days=Decimal(unpaid_leave),
        late_days=late,
        completed_sessions=0,
        breakdown_details=breakdown,
        generated_at=when,
    )
    row = Payroll(
        employee=p.emp,
        salary_mode="monthly",
        month=month,
        year=year,
        total_working_days=total_days,
        present_days=Decimal(present + paid_leave),
        absent_days=Decimal(absent + unpaid_leave),
        completed_sessions=0,
        ot_hours=Decimal(0),
        ot_amount=ot_amount,
        base_salary=salary,
        gross_salary=gross,
        deductions=total_deductions,
        bonus=bonus,
        final_salary=net,
        status="paid",
        created_at=when,
        updated_at=when,
        notes=f"Staff monthly: {present} present + {paid_leave} paid leave = {float(effective)} effective days / {total_days} working days.",
    )
    return SlipPlan(p, slip, row, (year, month), "staff", advance)


def _production_slip(
    world: World, p: Person, start: date, end: date, extras: dict, first_in_month: bool, second_in_month: bool
) -> SlipPlan | None:
    settings = world.settings
    if p.join > end or (p.exit is not None and p.exit < start):
        return None
    year, month = end.year, end.month
    rate = p.rate_on(start)
    days = world.days[p.idx]
    shifts = Decimal(0)
    worked = missed = late = 0
    for d in daterange(start, end):
        day = days.get(d)
        if day is None:
            continue
        shifts += day.shifts
        worked += day.status in ("present", "half_shift")
        missed += day.status == "absent"
        late += bool(day.is_late)
    gross = _d2(shifts * rate)
    pf = esi = Decimal(0)
    if settings.prod_payroll_rules_enabled:
        pf = _d2(gross * settings.prod_pf_rate / 100) if settings.prod_pf_rate > 0 else Decimal(0)
        if settings.prod_esi_rate > 0 and _d2(gross * 2) <= settings.prod_esi_applicable_below:
            esi = _d2(gross * settings.prod_esi_rate / 100)
    advance = extras["advances"].get((p.idx, year, month), Decimal(0)) if first_in_month else Decimal(0)
    bonus = extras["bonus"].get((p.idx, year, month), Decimal(0)) if second_in_month else Decimal(0)
    total_deductions = _d2(pf + esi + advance)
    gross_with_bonus = _d2(gross + bonus)
    net = _d2(gross_with_bonus - total_deductions)
    total_days = (end - start).days + 1
    breakdown = {
        "type": "production",
        "periodStart": start.isoformat(),
        "periodEnd": end.isoformat(),
        "salaryPerShift": float(rate),
        "days": [],
        "summary": {
            "totalDays": total_days,
            "daysWorked": int(worked),
            "daysAbsent": int(missed),
            "totalShifts": float(shifts),
        },
        "earnings": {
            "totalShifts": float(shifts),
            "salaryPerShift": float(rate),
            "grossSalary": float(gross_with_bonus),
            "bonus": float(bonus),
        },
        "deductions": {
            "pf": float(pf),
            "pfRate": float(settings.prod_pf_rate),
            "esi": float(esi),
            "esiRate": float(settings.prod_esi_rate),
            "advances": float(advance),
            "total": float(total_deductions),
        },
        "netSalary": float(net),
    }
    when = min(at(end + timedelta(days=2), time(16, 0)), at(world.plan.today, world.plan.now))
    slip = SalarySlip(
        employee=p.emp,
        month=month,
        year=year,
        slip_number=f"SS/{p.code}/{start.isoformat()}_{end.isoformat()}",
        basic=gross,  # the whole period wage; the bonus is its own line, so the lines add up to the gross
        hra=Decimal(0),
        allowances=Decimal(0),
        incentives=Decimal(0),
        bonuses=bonus,
        ot_amount=Decimal(0),
        gross_salary=gross_with_bonus,
        pf_deduction=pf,
        esi_deduction=esi,
        advance_deduction=advance,
        other_deductions=Decimal(0),
        total_deductions=total_deductions,
        net_salary=net,
        working_days=total_days,
        present_days=shifts,
        absent_days=Decimal(int(missed)),
        paid_leave_days=Decimal(0),
        unpaid_leave_days=Decimal(0),
        late_days=late,
        completed_sessions=0,
        breakdown_details=breakdown,
        generated_at=when,
        period_start=start,
        period_end=end,
    )
    row = Payroll(
        employee=p.emp,
        salary_mode="shift",
        month=month,
        year=year,
        total_working_days=total_days,
        present_days=shifts,
        absent_days=Decimal(int(missed)),
        completed_sessions=0,
        ot_hours=Decimal(0),
        ot_amount=Decimal(0),
        base_salary=gross,
        gross_salary=gross_with_bonus,
        deductions=total_deductions,
        bonus=bonus,
        final_salary=net,
        status="paid",
        period_start=start,
        period_end=end,
        created_at=when,
        updated_at=when,
        notes=f"Production period ({start} to {end}): {shifts} shifts x Rs{rate} = Rs{gross}.",
    )
    return SlipPlan(p, slip, row, (year, month), "production", advance)


# ─── the run ──────────────────────────────────────────────────────────────────────────────────────────────────


def create_payroll(world: World) -> None:
    world.say("Payroll")
    plan = world.plan
    months = plan.closed_months
    closed = set(months)
    latest = months[-1]
    advances = plan_advances(world)
    leave = world.extra["leave"]
    permissions: dict[tuple[int, int, int], int] = {}
    for item in leave.permissions:
        if item.status == "approved":
            key = (item.person.idx, item.day.year, item.day.month)
            permissions[key] = permissions.get(key, 0) + 1
    fy_year = plan.today.year - 1 if plan.today.month >= world.settings.bonus_fy_start_month else plan.today.year - 2
    fy_label = f"{fy_year}-{(fy_year + 1) % 100:02d}"
    bonus_map: dict[tuple[int, int, int], Decimal] = {}
    bonus_rows: list[Bonus] = []
    approver = hr_name(world, "payroll_demo")
    for p in sorted(world.people, key=lambda x: x.idx):
        if _bonus_eligible(world, p):
            amount = _bonus_amount(p)
            bonus_map[(p.idx, latest[0], latest[1])] = amount
            monthly = p.rate if p.kind == "staff" else p.rate * 26
            bonus_rows.append(
                Bonus(
                    employee=p.emp,
                    financial_year=fy_label,
                    records_considered=12,
                    calculation_base=_d2(min(monthly / 2, Decimal(7000)) * 12),
                    bonus_percent_applied=BONUS_PERCENT,
                    bonus_amount=amount,
                    status="paid",
                    notes="Statutory bonus paid with the salary",
                    computed_by=approver,
                    created_at=at(date(latest[0], latest[1], 1) + timedelta(days=24), time(12, 0)),
                )
            )
    extras = {
        "ot_pay_days": world.extra.get("ot_pay_days", {}),
        "permissions": permissions,
        "advances": advance_deductions(advances, closed),
        "bonus": bonus_map,
    }

    plans: list[SlipPlan] = []
    for year, month in months:
        first = date(year, month, 1)
        periods: list[tuple[date, date]] = []
        ref = first
        while ref.month == month:
            start, end = _calendar_month_period(ref, "2weeks")
            periods.append((start, end))
            ref = end + timedelta(days=1)
        for p in sorted(world.people, key=lambda x: x.idx):
            if p.kind == "staff":
                slip = _staff_slip(world, p, year, month, extras)
                if slip:
                    plans.append(slip)
                continue
            for n, (start, end) in enumerate(periods):
                slip = _production_slip(world, p, start, end, extras, n == 0, n == len(periods) - 1)
                if slip:
                    plans.append(slip)

    runs: dict[tuple[int, int], PayrollRun] = {}
    for year, month in months:
        mine = [s for s in plans if s.month == (year, month)]
        month_end = date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
        approved_at = at(month_end + timedelta(days=3), time(11, 0))
        locked = (year, month) != latest
        runs[(year, month)] = PayrollRun(
            run_code=f"{RUN_CODE_PREFIX}{year}-{month:02d}",
            month=month,
            year=year,
            run_type="monthly",
            status="locked" if locked else "approved",
            total_employees=len({s.person.idx for s in mine}),
            total_gross=sum((s.slip.gross_salary for s in mine), Decimal(0)),
            total_deductions=sum((s.slip.total_deductions for s in mine), Decimal(0)),
            total_net=sum((s.slip.net_salary for s in mine), Decimal(0)),
            processed_by=hr_name(world, "payroll_demo"),
            approved_by=hr_name(world, "hr_demo"),
            approved_at=approved_at,
            locked_at=at(month_end + timedelta(days=4), time(10, 0)) if locked else None,
            notes=f"Demo data: payroll for {month:02d}/{year}",
            created_at=at(month_end + timedelta(days=2), time(10, 0)),
            updated_at=approved_at,
        )
    world.insert(PayrollRun, list(runs.values()))
    for s in plans:
        s.slip.payroll_run = runs[s.month]
    world.insert(SalarySlip, [s.slip for s in plans], batch_size=500)
    world.insert(Payroll, [s.payroll for s in plans], batch_size=1000)
    world.insert(Bonus, bonus_rows)
    _create_advances(world, advances, runs, closed)
    world.extra["runs"] = runs

    totals = {f"{y}-{m:02d}": float(sum(s.slip.gross_salary for s in plans if s.month == (y, m))) for y, m in months}
    world.stories["payrollGrossByMonth"] = totals
    world.stories["bonusMonth"] = f"{latest[0]}-{latest[1]:02d}"
    world.stories["bonusEmployees"] = len(bonus_rows)
    world.summary["salarySlips"] = len(plans)
    world.say(
        f"  {len(runs)} pay runs, {len(plans):,} salary slips, {len(bonus_rows)} bonus records, {len(advances)} advances"
    )


def _create_advances(world: World, advances: list[AdvancePlan], runs: dict, closed: set[tuple[int, int]]) -> None:
    hr = hr_name(world, "hr_demo")
    rows: list[Advance] = []
    for a in advances:
        paid = Decimal(0)
        if a.status == "approved":
            paid = sum((pay for y, m, pay in a.schedule if (y, m) in closed or (y, m) < min(closed)), Decimal(0))
            if paid >= a.amount:
                a.status = "closed"
        rows.append(
            Advance(
                employee=a.person.emp,
                advance_type=a.kind,
                amount=a.amount,
                purpose=a.purpose,
                status=a.status,
                approved_by=hr if a.status in ("approved", "closed") else None,
                approved_at=a.approved_at,
                disbursed_at=a.approved_at,
                repayment_start_month=a.start[1] if a.start else None,
                repayment_start_year=a.start[0] if a.start else None,
                repayment_months=a.months if a.start else None,
                emi_amount=a.emi,
                total_repaid=paid,
                outstanding=a.amount - paid if a.status in ("approved", "closed") else Decimal(0),
                created_at=a.created,
                updated_at=a.approved_at or a.created,
            )
        )
    world.insert(Advance, rows)
    repayments: list[AdvanceRepayment] = []
    oldest = min(closed)
    for a, row in zip(advances, rows):
        for year, month, pay in a.schedule:
            processed = (year, month) in closed or (year, month) < oldest
            repayments.append(
                AdvanceRepayment(
                    advance=row,
                    month=month,
                    year=year,
                    amount=pay,
                    payment_method="payroll",
                    is_processed=processed,
                    payroll_run=runs.get((year, month)),
                    notes=None,
                    created_at=a.approved_at or a.created,
                )
            )
    world.insert(AdvanceRepayment, repayments)
