"""What a staff employee has EARNED in the first 20 days of a month - the base of the Salary Advance limit (owner
2026-11-26) - and the Term Loan's service rule.

Salary Advance (owner 2026-11-26, replaces 60 % of the monthly salary): at most 50 % of the salary earned from the 1st to
the 20th of the month, worked out exactly as the staff payroll prices a day (payroll_views._generate_staff_payroll):

  per-day salary  = monthly fixed salary / the company month (staff_pay_days: Sundays and Saturday-off Saturdays out,
                    declared holidays IN)
  paid days       = present shifts (a Half Day 0.5, quarter shifts as earned) on the working days 1st-20th
                    + days marked Holiday by HR + the declared holidays on/after the joining date (paid like payroll)
  earned          = per-day salary x paid days (rounded to the paisa once, like payroll)
  working days    = the present shifts alone (what the report's "Working Days" column shows)

Only days already judged count: a day still in progress (day_progress) and days still to come add nothing, so on the
21st / 22nd the figure is complete. Production employees have no monthly fixed salary: no figures (None).

Term Loan (owner 2026-11-26): only after 6 COMPLETED months of service from the joining date, counted the same way as the
Casual Leave service rule (cl_balance.months_between / eligible_from).

The figures are kept on the advance (Advance.earned_*) when it is raised and again when HR decides it, so the Settlement
report reads them without working the month out again; an advance without them gets them on the next list read
(fill_missing).
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

EARNED_THROUGH_DAY = 20
SALARY_ADVANCE_PERCENT = 50
TERM_LOAN_SERVICE_MONTHS = 6
FILL_PER_READ = 150  # at most this many advances get their figures worked out on one list read


@dataclass(frozen=True)
class Earnings:
    month: int
    year: int
    through: date  # the last day counted (the 20th)
    fixed_salary: Decimal  # the monthly fixed salary
    daily_rate: Decimal  # per-day salary, rounded to the paisa (display only)
    company_days: int
    working_days: Decimal  # present shifts 1st-20th
    paid_days: Decimal  # present shifts + paid holidays / HR holiday days
    earned: Decimal  # per-day salary x paid days

    @property
    def limit(self) -> Decimal:
        """50 % of the earned salary, whole rupees rounded down."""
        return Decimal(math.floor(self.earned * SALARY_ADVANCE_PERCENT / 100))

    def to_json(self) -> dict:
        return {
            "month": self.month,
            "year": self.year,
            "throughDay": self.through.day,
            "through": self.through.isoformat(),
            "fixedSalary": float(self.fixed_salary),
            "dailyRate": float(self.daily_rate),
            "companyDays": self.company_days,
            "workingDays": float(self.working_days),
            "paidDays": float(self.paid_days),
            "earnedAmount": float(self.earned),
            "percent": SALARY_ADVANCE_PERCENT,
            "limit": float(self.limit),
        }


def monthly_fixed_salary(emp) -> Decimal | None:
    """A staff employee's monthly fixed salary; None for production (paid per shift) or when none is recorded."""
    from .models import Employee

    if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF:
        return None
    s = emp.salary_amount
    return Decimal(str(s)) if s and Decimal(str(s)) > 0 else None


def earned_in_month(
    emp, month: int, year: int, through_day: int = EARNED_THROUGH_DAY, settings=None
) -> Earnings | None:
    """The salary `emp` earned from the 1st to `through_day` of the month, priced exactly like the staff payroll (see the
    module docstring). None without a monthly fixed salary or a company month."""
    import calendar

    from .attendance_final import compute_month_records
    from .compensation_shared import parse_join_date
    from .day_progress import is_in_progress
    from .models import Holiday, PayrollSettings
    from .payroll_views import _build_working_days, _d2, _effective_shift_times, _get_active_assignment

    salary = monthly_fixed_salary(emp)
    if salary is None:
        return None
    assignment = _get_active_assignment(emp, date(year, month, 15))
    saturday_off = _effective_shift_times(assignment)[3] if assignment else False
    company_days = len(_build_working_days(month, year, saturday_off, set()))
    if not company_days:
        return None
    through = date(year, month, min(through_day, calendar.monthrange(year, month)[1]))

    holiday_dates = set(Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True))
    working = [d for d in _build_working_days(month, year, saturday_off, holiday_dates) if d <= through]
    joined = parse_join_date(emp.join_date)
    paid_holidays = sum(
        1
        for d in _build_working_days(month, year, saturday_off, set())
        if d <= through and d in holiday_dates and (joined is None or d >= joined)
    )

    records = {r.date: r for r in compute_month_records(emp, year, month, settings or PayrollSettings.get())}
    present = Decimal("0")
    hr_holidays = 0
    for d in working:
        fr = records.get(d)
        if fr is None or is_in_progress(fr.provisional_until):
            continue  # not judged yet: earns nothing so far, as in payroll
        if fr.status in ("present", "half_shift"):
            shifts = Decimal(str(fr.shifts_earned or 0))
            present += shifts if shifts > 0 else Decimal("1.00")
        elif fr.status == "holiday":
            hr_holidays += 1  # a day HR marked Holiday is paid (payroll's "paid_leave")
    paid = present + hr_holidays + paid_holidays
    exact_rate = salary / Decimal(company_days)
    return Earnings(
        month=month,
        year=year,
        through=through,
        fixed_salary=salary,
        daily_rate=_d2(exact_rate),
        company_days=company_days,
        working_days=present,
        paid_days=paid,
        earned=_d2(exact_rate * paid),
    )


# ─────────────────────────── kept on the advance ───────────────────────────


def raised_month(adv) -> tuple[int, int]:
    """The month an advance's figures are for: the month it was raised in (factory time)."""
    from .clock import FACTORY_TZ, ist_today

    if adv.created_at:
        local = adv.created_at.astimezone(FACTORY_TZ)
        return local.month, local.year
    today = ist_today()
    return today.month, today.year


def store(adv, earnings: Earnings | None, today: date | None = None) -> None:
    """Keep `earnings` on the advance (only these columns are written)."""
    from .clock import ist_today
    from .models import Advance

    fields = {
        "earned_month": earnings.month if earnings else None,
        "earned_year": earnings.year if earnings else None,
        "earned_working_days": earnings.working_days if earnings else None,
        "earned_paid_days": earnings.paid_days if earnings else None,
        "earned_amount": earnings.earned if earnings else None,
        "earned_limit": earnings.limit if earnings else None,
        "earned_on": today or ist_today(),
    }
    if earnings and adv.salary_at_request is None:
        fields["salary_at_request"] = earnings.fixed_salary
    Advance.objects.filter(pk=adv.pk).update(**fields)
    for name, value in fields.items():
        setattr(adv, name, value)


def refresh(adv, today: date | None = None) -> None:
    """Work the figures out again for the month the advance was raised in and keep them."""
    month, year = raised_month(adv)
    store(adv, earned_in_month(adv.employee, month, year), today)


def is_stale(adv, today: date) -> bool:
    """No figures yet, or a still-waiting advance whose figures were taken before its month's 20th was over (a Term Loan
    asked for on the 5th): those are worked out again once the 20th has passed."""
    if adv.earned_on is None:
        return True
    if adv.status != "pending" or adv.earned_month is None:
        return False
    through = date(adv.earned_year, adv.earned_month, EARNED_THROUGH_DAY)
    return adv.earned_on <= through < today


def fill_missing(advances, today: date | None = None) -> int:
    """Give the advances in this list that lack figures (or have stale ones) their figures, at most FILL_PER_READ."""
    from .clock import ist_today

    today = today or ist_today()
    done = 0
    for adv in advances:
        if done >= FILL_PER_READ:
            break
        if is_stale(adv, today):
            refresh(adv, today)
            done += 1
    return done


def earnings_json(adv) -> dict | None:
    """The kept figures as the API serves them (null when the advance has none: a production employee, or none yet)."""
    if adv.earned_month is None or adv.earned_amount is None:
        return None
    return {
        "month": adv.earned_month,
        "year": adv.earned_year,
        "throughDay": EARNED_THROUGH_DAY,
        "fixedSalary": float(adv.salary_at_request) if adv.salary_at_request is not None else None,
        "workingDays": float(adv.earned_working_days or 0),
        "paidDays": float(adv.earned_paid_days or 0),
        "earnedAmount": float(adv.earned_amount),
        "workingSalary": float(adv.earned_amount),
        "percent": SALARY_ADVANCE_PERCENT,
        "limit": float(adv.earned_limit) if adv.earned_limit is not None else None,
        "workedOutOn": adv.earned_on.isoformat() if adv.earned_on else None,
    }


# ─────────────────────────── Term Loan service ───────────────────────────


def _service_policy():
    from . import cl_balance

    return dataclasses.replace(cl_balance.policy(), basis="months", service=TERM_LOAN_SERVICE_MONTHS)


def term_loan_service(emp, on: date) -> dict:
    """{eligible, joinDate, serviceMonths, requiredMonths, eligibleFrom, reason}: 6 completed months from the joining date,
    counted like the Casual Leave service rule."""
    from . import cl_balance

    joined = cl_balance.parse_join_date(emp.join_date)
    base = {"requiredMonths": TERM_LOAN_SERVICE_MONTHS}
    if joined is None:
        return {
            **base,
            "eligible": False,
            "joinDate": None,
            "serviceMonths": None,
            "eligibleFrom": None,
            "reason": "Your joining date is not recorded, so a Term Loan cannot be checked. Please contact HR.",
        }
    months = cl_balance.months_between(joined, on)
    eligible_on = cl_balance.eligible_from(joined, _service_policy())
    eligible = on >= eligible_on
    reason = None
    if not eligible:
        reason = (
            f"A Term Loan needs {TERM_LOAN_SERVICE_MONTHS} months of service. You can apply from "
            f"{eligible_on.day} {eligible_on.strftime('%B %Y')} ({months}/{TERM_LOAN_SERVICE_MONTHS} months of service)."
        )
    return {
        **base,
        "eligible": eligible,
        "joinDate": joined.isoformat(),
        "serviceMonths": months,
        "eligibleFrom": eligible_on.isoformat(),
        "reason": reason,
    }
