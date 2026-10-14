"""
Small helpers the Compensation overhaul endpoints share (holiday-work claims, announced windows, the birthday list,
the reports and the employee APIs): date / time / shift parsing, the Sunday-or-holiday test, the Monday-Sunday week,
birthday arithmetic (29 February), the switches, and the HR contact block.

Nothing here writes to the database. The attendance engine keeps its own rules (attendance_final.py, compensation_rules.py);
what is mirrored here is only what a SCREEN has to explain, and each helper says which engine rule it follows:

  * a day is "off" for staff when it is a declared Holiday (any Holiday row on that date, company-wide: exactly how the
    engine reads them) or a Sunday; a holiday that falls on a Sunday is the holiday;
  * the NEXT working day is the first later date that is neither.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation

from .models import CompensationConfig, Holiday, PayrollSettings

# The only amounts of compensation HR can give for one day of work (0.25 / 0.50 / 0.75 / 1 shift).
SHIFT_VALUES = (Decimal("0.25"), Decimal("0.50"), Decimal("0.75"), Decimal("1.00"))
SHIFT_TEXT = "0.25, 0.50, 0.75 or 1"

PERIODS = ("today", "week", "month")


def full_name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def employee_json(emp) -> dict:
    """The employee columns every compensation list shows (needs department, designation and branch select_related)."""
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": full_name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "departmentId": emp.department_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "branchId": emp.branch_id,
        "employmentType": emp.employment_type,
    }


# ─────────────────────────── parsing ───────────────────────────


def parse_date(raw) -> date | None:
    if isinstance(raw, date) and not isinstance(raw, datetime):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw.strip()[:10]) if len(raw.strip()) >= 10 else None
    except ValueError:
        return None


def parse_time(raw) -> time | None:
    """'09:30' or '09:30:00' -> time, else None."""
    if isinstance(raw, time):
        return raw.replace(second=0, microsecond=0)
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).time().replace(second=0, microsecond=0)
        except ValueError:
            continue
    return None


def parse_shifts(raw) -> Decimal | None:
    """One of 0.25 / 0.50 / 0.75 / 1.00, from a number or a string; None for anything else (a bool is not a number)."""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = Decimal(str(raw).strip()).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None
    return value if value in SHIFT_VALUES else None


def parse_int(raw) -> int | None:
    if raw is None or isinstance(raw, bool) or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError, OverflowError):  # OverflowError: JSON 1e999 reads as infinity
        return None


def shifts_text(value) -> str:
    """0.5 -> '0.50' (the way shifts are written everywhere in the HRMS)."""
    return f"{Decimal(str(value)).quantize(Decimal('0.01'))}"


def date_text(d: date) -> str:
    """'Sunday 12 Oct 2026'."""
    return f"{d.strftime('%A')} {d.day} {d.strftime('%b %Y')}"


# ─────────────────────────── the calendar ───────────────────────────


def holiday_names(start: date, end: date) -> dict[date, str]:
    """{date: holiday name} for the declared holidays in [start, end] (one query; the first one declared wins a date)."""
    out: dict[date, str] = {}
    for h in Holiday.objects.filter(date__gte=start, date__lte=end).order_by("id"):
        out.setdefault(h.date, h.name)
    return out


def day_kind(d: date, holidays: dict[date, str]) -> str | None:
    """'holiday' | 'sunday' | None: what makes `d` a day off for staff (a declared holiday on a Sunday is the holiday)."""
    if d in holidays:
        return "holiday"
    return "sunday" if d.weekday() == 6 else None


def next_working_day(d: date, holidays: dict[date, str]) -> date:
    """The first date after `d` that is neither a Sunday nor a declared holiday (the day a next-day allowance applies to).
    `holidays` must cover at least d + 14 days; a run of more than two weeks off ends the search at that day."""
    nxt = d + timedelta(days=1)
    for _ in range(14):
        if day_kind(nxt, holidays) is None:
            return nxt
        nxt += timedelta(days=1)
    return nxt


def period_bounds(period: str, anchor: date) -> tuple[date, date]:
    """today = the day itself; week = Monday to Sunday containing it; month = the calendar month containing it."""
    if period == "week":
        start = anchor - timedelta(days=anchor.weekday())
        try:
            return start, start + timedelta(days=6)
        except OverflowError:  # the last week of the calendar
            return start, date.max
    if period == "month":
        return anchor.replace(day=1), anchor.replace(day=calendar.monthrange(anchor.year, anchor.month)[1])
    return anchor, anchor


# ─────────────────────────── birthdays ───────────────────────────


def birthday_in_year(dob: date, year: int) -> date:
    """The day `dob` is celebrated in `year`: a 29 February birthday is the 28th in a year that has no 29th."""
    if dob.month == 2 and dob.day == 29 and not calendar.isleap(year):
        return date(year, 2, 28)
    return date(year, dob.month, dob.day)


def birthdays_between(dob: date, start: date, end: date) -> list[date]:
    """Every celebration of `dob` inside [start, end] (a week can straddle two years). Never before the birth year."""
    out = []
    for year in range(max(start.year, dob.year), end.year + 1):
        day = birthday_in_year(dob, year)
        if start <= day <= end:
            out.append(day)
    return out


def birthday_verdict(d: date, master: bool, cfg: CompensationConfig, holidays: dict[date, str]) -> tuple[bool, str]:
    """(benefits, why not) for a staff employee whose birthday is `d`: the feature is on, `d` is on or after its
    effective date, and it is a working day (a Sunday or declared holiday is off already, so there is nothing to give)."""
    if not master:
        return False, "The Compensation features are switched off in Settings > Payroll."
    if not cfg.birthday_enabled:
        return False, "Birthday leave is switched off in Settings > Compensation."
    if cfg.birthday_effective_from and d < cfg.birthday_effective_from:
        return False, f"Birthday leave only applies from {cfg.birthday_effective_from.isoformat()}."
    if d in holidays:
        return False, f"{holidays[d]} is a declared holiday, so the day is already off."
    if d.weekday() == 6:
        return False, "Sunday is the weekly off, so the day is already off."
    return True, ""


def parse_join_date(raw) -> date | None:
    """Employee.join_date is free text: 2024-03-05, 05/03/2024 or 05-03-2024 (None when it cannot be read)."""
    if not raw:
        return None
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def birthday_employee_problem(emp, d: date, saturday_off: bool) -> str:
    """Why `d` is no birthday benefit for THIS employee even though the calendar allows it ('' = it is): they had not
    joined yet, or `d` is a Saturday their shift takes off (the attendance engine applies the same two rules)."""
    joined = parse_join_date(emp.join_date)
    if joined is not None and d < joined:
        return f"{full_name(emp)} joined on {joined.isoformat()}, after this birthday."
    if d.weekday() == 5 and saturday_off:
        return "Saturday is a day off on this employee's shift, so the day is already off."
    return ""


# ─────────────────────────── switches and contact ───────────────────────────


def master_enabled() -> bool:
    """The OT / Compensation master switch: ONE company-wide answer (PayrollSettings.compensation_feature_enabled). A
    branch's Settings overlay never overrides it (user_settings.COMPANY_WIDE_FIELDS), so this, the attendance engine and
    the payroll OT-pay block always read the same value."""
    return bool(PayrollSettings.get().compensation_feature_enabled)


def switches() -> dict:
    """Every switch an HR page or an employee app needs to explain what is on. `any` = something acts for staff."""
    master = master_enabled()
    cfg = CompensationConfig.get()
    flags = {
        "master": master,
        "allowance": master and cfg.allowance_enabled,
        "shift": master and cfg.shift_enabled,
        "relaxation": master and cfg.shift_enabled and cfg.relaxation_enabled,
        "pay": master and cfg.shift_enabled and cfg.pay_enabled,
        "windows": master and cfg.windows_enabled,
        "holidayWork": master and cfg.holiday_work_enabled,
        "birthday": master and cfg.birthday_enabled,
    }
    flags["any"] = any(v for k, v in flags.items() if k != "master")
    return flags


def hr_contact() -> dict:
    """The HR block of Settings -> HR Contact (the same one GET /api/support-contact publishes)."""
    from .support_contact_views import contact_payload

    return contact_payload(PayrollSettings.get())["hr"]
