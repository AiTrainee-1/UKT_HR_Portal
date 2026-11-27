"""What a staff employee has EARNED in the first 20 days of a month - the base of the Salary Advance limit (owner
2026-11-26) - and the Term Loan's service rule.

Salary Advance (owner 2026-11-26, replaces 60 % of the monthly salary): at most 50 % of the salary earned from the 1st to
the 20th of the month, worked out exactly as the staff payroll prices a day (payroll_views._generate_staff_payroll):

  per-day salary  = monthly fixed salary / the company month (staff_pay_days: Sundays and Saturday-off Saturdays out,
                    declared holidays IN)
  paid days       = present shifts (a Half Day 0.5, quarter shifts as earned) on the working days 1st-20th
                    + days marked Holiday by HR + the declared holidays on/after the joining date (paid like payroll)
  earned          = per-day salary x paid days (rounded to the paisa once, like payroll)
  working days    = the PAID days: present shifts + the company holidays (declared holidays and days HR marked Holiday)
                    of the 1st-20th (owner 2026-11-26: "company-announced holidays count as paid working days"); the API
                    also gives the split, presentShifts + holidayDays

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

# The defaults; the rules in force are HR's, in Settings -> Loan & Advance (advance_rules.rules(), 2026-11-27).
EARNED_THROUGH_DAY = 20
SALARY_ADVANCE_PERCENT = 50
TERM_LOAN_SERVICE_MONTHS = 6
FILL_PER_READ = 25  # at most this many advances get their figures worked out on one list read (the rest: next read,
# or `manage.py fill_advance_earnings` once after deploying migration 0187)


@dataclass(frozen=True)
class Earnings:
    month: int
    year: int
    through: date  # the last day counted (the 20th)
    fixed_salary: Decimal  # the monthly fixed salary
    daily_rate: Decimal  # per-day salary, rounded to the paisa (display only)
    company_days: int
    working_days: Decimal  # present shifts 1st-20th (kept in Advance.earned_working_days)
    paid_days: Decimal  # present shifts + paid holidays / HR holiday days: the "Working Days" shown (2026-11-26)
    earned: Decimal  # per-day salary x paid days
    percent: int = SALARY_ADVANCE_PERCENT  # the Salary Advance % of Settings when worked out

    @property
    def limit(self) -> Decimal:
        """The Salary Advance limit: `percent` of the earned salary, whole rupees rounded down."""
        return Decimal(math.floor(self.earned * self.percent / 100))

    def to_json(self) -> dict:
        return {
            "month": self.month,
            "year": self.year,
            "throughDay": self.through.day,
            "through": self.through.isoformat(),
            "fixedSalary": float(self.fixed_salary),
            "dailyRate": float(self.daily_rate),
            "companyDays": self.company_days,
            # Working Days = the paid days: present shifts + company holidays of the 1st-20th (owner 2026-11-26)
            "workingDays": float(self.paid_days),
            "presentShifts": float(self.working_days),
            "holidayDays": float(self.paid_days - self.working_days),
            "paidDays": float(self.paid_days),
            "earnedAmount": float(self.earned),
            "percent": self.percent,
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
    emp,
    month: int,
    year: int,
    through_day: int | None = None,
    settings=None,
    salary: Decimal | None = None,
    today: date | None = None,
) -> Earnings | None:
    """The salary `emp` earned from the 1st to `through_day` of the month, priced exactly like the staff payroll (see the
    module docstring). None without a monthly fixed salary or a company month. `salary` prices it at a given monthly
    salary (the one in force then) instead of today's; `today` is the factory date (declared holidays still to come are
    not earned yet)."""
    import calendar

    from .advance_rules import rules
    from .clock import ist_today

    from .attendance_final import compute_month_records
    from .compensation_shared import parse_join_date
    from .day_progress import is_in_progress
    from .models import Holiday, PayrollSettings
    from .payroll_views import _build_working_days, _d2, _effective_shift_times, _get_active_assignment

    current = monthly_fixed_salary(emp)
    if current is None:
        return None  # production (paid per shift) or no salary recorded
    salary = Decimal(str(salary)) if salary else current
    today = today or ist_today()
    assignment = _get_active_assignment(emp, date(year, month, 15))
    saturday_off = _effective_shift_times(assignment)[3] if assignment else False
    company_days = len(_build_working_days(month, year, saturday_off, set()))
    if not company_days:
        return None
    r = rules()
    through_day = through_day or r.sa_earned_through
    through = date(year, month, min(through_day, calendar.monthrange(year, month)[1]))

    holiday_dates = set(Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True))
    working = [d for d in _build_working_days(month, year, saturday_off, holiday_dates) if d <= through]
    joined = parse_join_date(emp.join_date)
    paid_holidays = sum(
        1
        for d in _build_working_days(month, year, saturday_off, set())
        if d <= through and d <= today and d in holiday_dates and (joined is None or d >= joined)
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
        percent=r.sa_percent,
    )


# ─────────────────────────── leave taken in the 1st-20th ───────────────────────────

LEAVE_WARNING_DAYS = Decimal("3")  # exactly 3 = warning (orange); more than 3 = critical (red) (owner 2026-11-26)


def leave_dates_in_month(emp, month: int, year: int, through_day: int | None = None, today: date | None = None,
                         settings=None) -> list[dict]:  # fmt: skip
    """The leave days themselves (the Leave calendar, 2026-11-27): every working day of the 1st to `through_day` that
    counts as leave - {date, kind: absent | on_leave | half_day_leave, weight 1 | 0.5} - by the rules of
    leave_days_in_month."""
    import calendar

    from .attendance_final import compute_month_records
    from .clock import ist_today
    from .day_progress import is_in_progress
    from .models import AttendanceDayRecord as R, Holiday, PayrollSettings
    from .payroll_views import _build_working_days, _effective_shift_times, _get_active_assignment

    from .advance_rules import rules

    today = today or ist_today()
    through_day = through_day or rules().sa_earned_through
    through = date(year, month, min(through_day, calendar.monthrange(year, month)[1]))
    assignment = _get_active_assignment(emp, date(year, month, 15))
    saturday_off = _effective_shift_times(assignment)[3] if assignment else False
    holiday_dates = set(Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True))
    working = [d for d in _build_working_days(month, year, saturday_off, holiday_dates) if d <= through and d <= today]
    if not working:
        return []
    records = {r.date: r for r in compute_month_records(emp, year, month, settings or PayrollSettings.get())}
    out = []
    for d in working:
        fr = records.get(d)
        if fr is None or is_in_progress(fr.provisional_until):
            continue
        if fr.status == R.STATUS_ABSENT:
            out.append({"date": d.isoformat(), "kind": "absent", "label": "Absent", "weight": 1.0})
        elif fr.status == R.STATUS_LEAVE:
            out.append({"date": d.isoformat(), "kind": "on_leave", "label": "On leave", "weight": 1.0})
        elif fr.status == R.STATUS_HALF and getattr(fr, "is_half_day_leave", False):
            out.append({"date": d.isoformat(), "kind": "half_day_leave", "label": "Half-day leave", "weight": 0.5})
    return out


def leave_days_in_month(emp, month: int, year: int, through_day: int | None = None, today: date | None = None,
                        settings=None) -> Decimal:  # fmt: skip
    """The leave an employee took from the 1st to `through_day` of the month (owner 2026-11-26, for the Salary Advance /
    Term Loan check): on the working days (Sundays, Saturday-offs and declared holidays never count) each Absent day and
    each day of approved leave (On Leave) counts 1, an approved half-day leave 0.5. Casual Leave does NOT count (the
    owner's choice: it is paid). Days not judged yet (to come, or still in progress) count nothing. Staff and production
    alike."""
    return sum(
        (Decimal(str(d["weight"])) for d in leave_dates_in_month(emp, month, year, through_day, today, settings)),
        Decimal("0"),
    )


def leave_calendar_json(adv) -> dict:
    """An advance's Leave calendar: the month it was raised in, the days counted (1st to the kept last day), every leave
    day (red on the calendar), the declared holidays, the total and its flag."""
    from .models import Holiday

    month, year = raised_month(adv)
    through = through_day_of(adv)
    days = leave_dates_in_month(adv.employee, month, year, through_day=through)
    total = sum((Decimal(str(d["weight"])) for d in days), Decimal("0"))
    return {
        "employee": {
            "code": adv.employee.employee_code,
            "name": f"{adv.employee.first_name} {adv.employee.last_name}".strip(),
        },
        "month": month,
        "year": year,
        "throughDay": through,
        "days": days,
        "holidays": [
            {"date": h.date.isoformat(), "name": h.name}
            for h in Holiday.objects.filter(date__year=year, date__month=month).order_by("date")
        ],
        "total": float(total),
        "flag": leave_flag(total),
    }


def leave_flag(days) -> str | None:
    """ "critical" (more than 3 days), "warning" (exactly 3), "ok" (fewer); None when not worked out."""
    if days is None:
        return None
    days = Decimal(str(days))
    if days > LEAVE_WARNING_DAYS:
        return "critical"
    if days == LEAVE_WARNING_DAYS:
        return "warning"
    return "ok"


def leave_check_json(adv) -> dict | None:
    """The leave check as the API serves it (null until worked out)."""
    if adv.leave_days_1_20 is None:
        return None
    month, year = raised_month(adv)
    days = Decimal(str(adv.leave_days_1_20))
    return {
        "month": month,
        "year": year,
        "throughDay": through_day_of(adv),
        "days": float(days),
        "flag": leave_flag(days),
        "warningAt": float(LEAVE_WARNING_DAYS),
    }


# ─────────────────────────── kept on the advance ───────────────────────────


def raised_month(adv) -> tuple[int, int]:
    """The month an advance's figures are for: the month it was raised in (factory time)."""
    from .clock import FACTORY_TZ, ist_today

    if adv.created_at:
        local = adv.created_at.astimezone(FACTORY_TZ)
        return local.month, local.year
    today = ist_today()
    return today.month, today.year


def through_day_of(adv) -> int:
    """The last day an advance's kept figures count: the one kept with them (since 2026-11-27); figures kept before
    that were all counted to the 20th. (No database read: the lists call this for every row.)"""
    return getattr(adv, "earned_through_day", None) or EARNED_THROUGH_DAY


def store(adv, earnings: Earnings | None, today: date | None = None, leave_days: Decimal | None = None) -> None:
    """Keep `earnings` (and the leave taken in the 1st-20th, when given) on the advance (only these columns are
    written)."""
    from .clock import ist_today
    from .models import Advance

    fields = {
        "earned_month": earnings.month if earnings else None,
        "earned_year": earnings.year if earnings else None,
        "earned_working_days": earnings.working_days if earnings else None,
        "earned_paid_days": earnings.paid_days if earnings else None,
        "earned_amount": earnings.earned if earnings else None,
        "earned_limit": earnings.limit if earnings else None,
        "earned_percent": earnings.percent if earnings else None,
        "earned_through_day": earnings.through.day if earnings else through_day_of(adv),
        "earned_on": today or ist_today(),
    }
    if earnings and adv.salary_at_request is None:
        fields["salary_at_request"] = earnings.fixed_salary
    if leave_days is not None:
        fields["leave_days_1_20"] = leave_days
    Advance.objects.filter(pk=adv.pk).update(**fields)
    for name, value in fields.items():
        setattr(adv, name, value)


def salary_for_month(emp, month: int, year: int) -> Decimal | None:
    """The monthly salary a past month was paid at: its staff payroll's base salary, when that month has one."""
    from .models import Payroll

    base = (
        Payroll.objects.filter(employee=emp, month=month, year=year, week_number=None, salary_mode="monthly")
        .order_by("-id")
        .values_list("base_salary", flat=True)
        .first()
    )
    return Decimal(str(base)) if base and Decimal(str(base)) > 0 else None


def refresh(adv, today: date | None = None) -> None:
    """Work the figures out again for the month the advance was raised in and keep them, priced at the salary of that
    time: the one kept when it was raised, else that month's payroll's, else today's (an older advance HR recorded)."""
    month, year = raised_month(adv)
    salary = adv.salary_at_request or salary_for_month(adv.employee, month, year)
    store(
        adv,
        earned_in_month(adv.employee, month, year, salary=salary),
        today,
        leave_days=leave_days_in_month(adv.employee, month, year),
    )


def is_stale(adv, today: date) -> bool:
    """No figures yet, or a still-waiting advance whose figures were taken before its month's 20th was over (a Term Loan
    asked for on the 5th): those are worked out again once the 20th has passed."""
    if adv.earned_on is None or adv.leave_days_1_20 is None:
        return True  # never worked out, or before the leave check existed (2026-11-26)
    if adv.status != "pending":
        return False
    month, year = raised_month(adv)
    through = date(year, month, through_day_of(adv))
    return adv.earned_on <= through < today


def fill_missing(advances, today: date | None = None, limit: int = FILL_PER_READ) -> int:
    """Give the advances in this list that lack figures (or have stale ones) their figures, at most `limit`."""
    from .clock import ist_today

    today = today or ist_today()
    done = 0
    for adv in advances:
        if done >= limit:
            break
        if is_stale(adv, today):
            refresh(adv, today)
            done += 1
    return done


def earnings_json(adv) -> dict | None:
    """The kept figures as the API serves them (null when the advance has none: a production employee, or none yet)."""
    if adv.earned_month is None or adv.earned_amount is None:
        return None
    present = Decimal(str(adv.earned_working_days or 0))
    paid = Decimal(str(adv.earned_paid_days)) if adv.earned_paid_days is not None else present
    return {
        "month": adv.earned_month,
        "year": adv.earned_year,
        "throughDay": through_day_of(adv),
        "fixedSalary": float(adv.salary_at_request) if adv.salary_at_request is not None else None,
        # Working Days = present shifts + company holidays of the 1st-20th (owner 2026-11-26), the days the salary pays
        "workingDays": float(paid),
        "presentShifts": float(present),
        "holidayDays": float(paid - present),
        "paidDays": float(paid),
        "earnedAmount": float(adv.earned_amount),
        "workingSalary": float(adv.earned_amount),
        "percent": getattr(adv, "earned_percent", None) or SALARY_ADVANCE_PERCENT,
        "limit": float(adv.earned_limit) if adv.earned_limit is not None else None,
        "workedOutOn": adv.earned_on.isoformat() if adv.earned_on else None,
    }


# ─────────────────────────── Term Loan service ───────────────────────────


def _service_policy(months: int = TERM_LOAN_SERVICE_MONTHS):
    from . import cl_balance

    return dataclasses.replace(cl_balance.policy(), basis="months", service=months)


def term_loan_service(emp, on: date, r=None) -> dict:
    """{eligible, joinDate, serviceMonths, requiredMonths, eligibleFrom, reason}: the completed months of service
    Settings asks for (default 6) from the joining date, counted like the Casual Leave service rule."""
    from . import cl_balance
    from .advance_rules import rules

    required = (r or rules()).tl_min_service_months
    joined = cl_balance.parse_join_date(emp.join_date)
    base = {"requiredMonths": required}
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
    eligible_on = cl_balance.eligible_from(joined, _service_policy(required)) if required else joined
    eligible = on >= eligible_on
    reason = None
    if not eligible:
        reason = (
            f"A Term Loan needs {required} months of service. You can apply from "
            f"{eligible_on.day} {eligible_on.strftime('%B %Y')} ({months}/{required} months of service)."
        )
    return {
        **base,
        "eligible": eligible,
        "joinDate": joined.isoformat(),
        "serviceMonths": months,
        "eligibleFrom": eligible_on.isoformat(),
        "reason": reason,
    }
