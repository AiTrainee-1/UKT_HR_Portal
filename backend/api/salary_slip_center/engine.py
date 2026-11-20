"""One employee's month, worked out for a standalone salary slip. Read-only: nothing is saved here.

The money follows the company's pay policy, the same rules the payroll engines apply (payroll_views
_generate_staff_payroll / _generate_production_payroll), re-applied on their own so a slip never needs a payroll:

Staff       per-day salary = monthly salary / company month days (the month minus Sundays, minus Saturdays on a
            Saturday-off shift, declared holidays INCLUDED - 27 in October 2026). Paid days = the shifts earned on the
            working days (attendance_final.compute_month_records: a half shift 0.5, approved Casual Leave a present day)
            + the declared holidays on a company day from the joining date on. Gross = salary / company days x paid days,
            rounded once. Earnings lines = the employee's 50/50 salary split (Basic, DA, Retaining Allowance | Other,
            Petrol, HRA, Special, CA) prorated by paid days / company days, adding up to the gross to the paisa.
Production  gross = shifts earned in the calendar month (attendance_final.compute_range_records) x salary per shift.

Deductions, each one switched by HR when generating (owner 2026-11-20):
    statutory       PF / ESI / TDS from the employee's Co Emp / TDS setting and the employee's branch rules (pf_esi.py)
    lateDeductions  staff: the month's late pool (late-in, early-out, excess permissions) and the permission slabs,
                    priced at the per-day salary; production: Production Late Detection when it is switched on, with the
                    Monthly cycle's late rules (the cycle closest to a calendar month)
    advances        the month's advance / term-loan instalments scheduled as payroll deductions - READ ONLY: an
                    instalment is never marked recovered here
No OT pay and no bonus (those belong to payroll). NET = gross - deductions, rounded UP to the whole rupee like payroll.

A month still running is counted up to today (holidays too); a month that has not started cannot be worked out.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Q

from ..clock import ist_today
from ..compensation_shared import parse_join_date
from ..document_pdf import num_to_words
from ..models import (
    AdvanceRepayment,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    PayrollSettings,
)
from ..pf_esi import d2, production_statutory, round_up_rupee, staff_statutory
from ..salary_split import FIRST_PORTION, LABELS as SPLIT_LABELS, SECOND_PORTION, effective_split
from ..unit_labels import unit_label
from ..user_settings import settings_for_employee

ZERO = Decimal("0")
ONE = Decimal("1")
MONTHS = [
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
]
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

KIND_STAFF = "staff"
KIND_PRODUCTION = "production"

OPTION_KEYS = ("statutory", "lateDeductions", "advances")
DEFAULT_OPTIONS = {key: True for key in OPTION_KEYS}

# the late rules a calendar month of production work is judged by (production_cycles.cycle_late_rules)
PRODUCTION_LATE_CYCLE = "monthly"


class CannotCalculate(Exception):
    """This employee's month cannot be worked out; the message says why in plain words."""


# ───────────────────────────── period / options ─────────────────────────────


@dataclass(frozen=True)
class Period:
    month: int
    year: int
    start: date
    end: date
    counted_to: date  # the last day counted: the month's end, or today while the month is still running

    @property
    def in_progress(self) -> bool:
        return self.counted_to < self.end

    @property
    def label(self) -> str:
        return f"{MONTHS[self.month]} {self.year}"

    def json(self) -> dict:
        return {
            "month": self.month,
            "year": self.year,
            "label": self.label,
            "from": self.start.isoformat(),
            "to": self.end.isoformat(),
            "countedTo": self.counted_to.isoformat(),
            "inProgress": self.in_progress,
        }


def period_for(month: int, year: int, today: date | None = None) -> Period:
    """The calendar month; CannotCalculate for a month that has not started yet or an impossible one."""
    if not (1 <= int(month) <= 12) or not (2000 <= int(year) <= 2100):
        raise CannotCalculate("Pick a month and a year.")
    month, year = int(month), int(year)
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    today = today or ist_today()
    if start > today:
        raise CannotCalculate(f"{MONTHS[month]} {year} has not started yet.")
    return Period(month, year, start, end, min(end, today))


def clean_options(raw) -> dict:
    """{"statutory": bool, "lateDeductions": bool, "advances": bool}; anything not given stays on."""
    out = dict(DEFAULT_OPTIONS)
    if isinstance(raw, dict):
        for key in OPTION_KEYS:
            if key in raw:
                out[key] = _truthy(raw[key])
    return out


def options_from_query(params) -> dict:
    """The options of a GET (?statutory=0&late=1&advances=1)."""
    names = {"statutory": "statutory", "lateDeductions": "late", "advances": "advances"}
    return clean_options({key: params[name] for key, name in names.items() if name in params})


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off", "")


def slip_number(emp: Employee, month: int, year: int) -> str:
    return f"SSL/{emp.employee_code}/{year}/{month:02d}"


def kind_of(emp: Employee) -> str:
    return KIND_PRODUCTION if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION else KIND_STAFF


def pay_issue(emp: Employee) -> str | None:
    """Why this employee cannot have a slip at all (nothing to pay them by), or None."""
    if kind_of(emp) == KIND_PRODUCTION:
        if not emp.salary_per_shift or emp.salary_per_shift <= 0:
            return "No salary per shift on the profile"
        return None
    if not emp.salary_amount or emp.salary_amount <= 0:
        return "No monthly salary on the profile"
    return None


def mask_account(account: str | None) -> str | None:
    text = (account or "").strip().replace(" ", "")
    if not text:
        return None
    return "X" * max(0, len(text) - 4) + text[-4:]


def bank_issue(emp: Employee) -> str | None:
    if not (emp.bank_account or "").strip():
        return "No bank account number"
    if not (emp.bank_ifsc or "").strip():
        return "No IFSC code"
    return None


def full_name(emp: Employee) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _num(value) -> float:
    return float(d2(value)) if value is not None else 0.0


def _days_value(value) -> float | int:
    value = Decimal(str(value))
    return int(value) if value == value.to_integral_value() else float(value)


# ───────────────────────────── shared facts ─────────────────────────────


def _saturday_off(emp: Employee, ref: date) -> bool:
    """Saturday-off from the shift assignment in force on the 15th (or the latest before it), as payroll decides it."""
    assignment = (
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=ref)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=ref))
        .order_by("-effective_from")
        .only("saturday_off")
        .first()
    )
    return bool(assignment and assignment.saturday_off)


def _company_days(period: Period, saturday_off: bool, holidays: set[date] = frozenset()) -> list[date]:
    """The month's days but Sundays (and Saturdays on a Saturday-off shift) and the given holidays."""
    days, d = [], period.start
    while d <= period.end:
        wd = d.weekday()
        if not (wd == 6 or (wd == 5 and saturday_off) or d in holidays):
            days.append(d)
        d += timedelta(days=1)
    return days


def _holidays(period: Period) -> dict[date, str]:
    return dict(Holiday.objects.filter(date__gte=period.start, date__lte=period.end).values_list("date", "name"))


def _cl_days(emp: Employee, period: Period) -> dict[date, Decimal]:
    """{date: approved Casual Leave on it}: 1 for a full day, 0.5 per half day (what the statement's CL column counts)."""
    out: dict[date, Decimal] = {}
    rows = CasualLeaveRequest.objects.filter(
        employee=emp, date__gte=period.start, date__lte=period.end, status=CasualLeaveRequest.STATUS_APPROVED
    ).values_list("date", "portion")
    for day, portion in rows:
        part = ONE if portion == CasualLeaveRequest.PORTION_FULL else Decimal("0.5")
        out[day] = min(ONE, out.get(day, ZERO) + part)
    return out


def advance_instalments(emp: Employee, month: int, year: int) -> tuple[Decimal, list[dict]]:
    """The month's advance / term-loan instalments deducted from salary: the ones not recovered yet plus the ones
    already recovered through payroll (the same set payroll deducts for a whole month). Read-only."""
    taken = Q(is_processed=False) | Q(is_processed=True, payment_method=AdvanceRepayment.PAYMENT_PAYROLL)
    rows = (
        AdvanceRepayment.objects.select_related("advance")
        .filter(taken, advance__employee=emp, month=month, year=year)
        .order_by("id")
    )
    total, details = ZERO, []
    for r in rows:
        total += r.amount
        kind = getattr(r.advance, "advance_type", "") or ""
        details.append(
            {
                "advanceId": r.advance_id,
                "repaymentId": r.id,
                "amount": float(r.amount),
                "type": "Term advance" if kind == "term" else "Advance",
            }
        )
    return d2(total), details


def _employee_json(emp: Employee) -> dict:
    return {
        "code": emp.employee_code,
        "name": full_name(emp),
        "department": emp.department.name if emp.department_id and emp.department else "",
        "designation": emp.designation.title if emp.designation_id and emp.designation else "",
        "unit": unit_label(emp.branch) if emp.branch_id else "",
        "joinDate": parse_join_date(emp.join_date).isoformat() if parse_join_date(emp.join_date) else None,
        "status": (emp.status or "").lower(),
        "category": kind_of(emp),
        "bankName": emp.bank_name or "",
        "bankAccountMasked": mask_account(emp.bank_account),
        "ifsc": (emp.bank_ifsc or "").upper(),
        "pfNumber": emp.pf_number or None,
        "esiNumber": emp.esi_number or None,
        "uanNumber": emp.uan_number or None,
    }


def _line(key: str, label: str, amount: Decimal, note: str = "") -> dict:
    return {"key": key, "label": label, "amount": _num(amount), "note": note}


def _statutory_lines(statutory) -> list[dict]:
    lines = []
    if statutory.pf > 0:
        lines.append(_line("pf", f"PF ({_rate(statutory.pf_rate)}%)", statutory.pf))
    if statutory.esi > 0:
        lines.append(_line("esi", f"ESI ({_rate(statutory.esi_rate)}%)", statutory.esi))
    if statutory.tds > 0:
        percent = statutory.tds_percent
        lines.append(_line("tds", f"TDS ({_rate(percent)}%)" if percent is not None else "TDS", statutory.tds))
    return lines


def _rate(value) -> str:
    return format(Decimal(str(value or 0)).normalize(), "f")


def _finish(result: dict, gross: Decimal, deduction_lines: list[dict]) -> dict:
    total = d2(sum((Decimal(str(line["amount"])) for line in deduction_lines), ZERO))
    net = round_up_rupee(gross - total)
    result["grossTotal"] = _num(gross)
    result["deductions"] = deduction_lines
    result["deductionsTotal"] = _num(total)
    result["net"] = _num(net)
    result["netInWords"] = num_to_words(int(net)) if net > 0 else "ZERO"
    if net < 0:
        result["notes"].append("The deductions are more than the earnings: the net pay is below zero.")
    return result


# ───────────────────────────── staff ─────────────────────────────


def _calculate_staff(emp: Employee, period: Period, options: dict) -> dict:
    from ..attendance_final import compute_month_records, late_pool_summary
    from ..payroll_views import late_pool_pricing

    attendance_settings = PayrollSettings.get()
    saturday_off = _saturday_off(emp, date(period.year, period.month, 15))
    holiday_names = _holidays(period)
    holiday_dates = set(holiday_names)

    working_days = _company_days(period, saturday_off, holiday_dates)
    if not working_days:
        raise CannotCalculate(
            f"No working days in {period.label} for this employee's shift (check Holidays and Saturday-off)."
        )
    pay_days = _company_days(period, saturday_off)
    company_days = len(pay_days)
    joined = parse_join_date(emp.join_date)
    counted = period.counted_to
    paid_holidays = [d for d in pay_days if d in holiday_dates and d <= counted and (joined is None or d >= joined)]

    records = compute_month_records(emp, period.year, period.month, attendance_settings)
    by_date = {r.date: r for r in records}
    cl = _cl_days(emp, period)

    calendar_rows: list[dict] = []
    present = paid_leave = unpaid_leave = absent = late = early = half = 0
    worked = ZERO
    cl_total = ZERO
    working_set = set(working_days)
    d = period.start
    while d <= period.end:
        row = {
            "date": d.isoformat(),
            "day": DAY_NAMES[d.weekday()],
            "shifts": 0.0,
            "firstIn": None,
            "lastOut": None,
            "late": False,
            "note": "",
        }
        record = by_date.get(d)
        if record is not None:
            row["firstIn"] = record.first_punch.strftime("%H:%M") if record.first_punch else None
            row["lastOut"] = record.last_punch.strftime("%H:%M") if record.last_punch else None
        if d in holiday_dates and d.weekday() != 6 and not (d.weekday() == 5 and saturday_off):
            paid = d in paid_holidays
            row.update(status="holiday", shifts=1.0 if paid else 0.0, note=holiday_names.get(d, "Holiday"))
            if not paid:
                row["note"] += " (not joined yet)" if joined and d < joined else " (not counted yet)"
        elif d not in working_set:
            row.update(status="sunday" if d.weekday() == 6 else "weekly_off")
        elif d > counted:
            row.update(status="future")
        elif record is None or (record.status == "absent" and joined is not None and d < joined):
            # attendance decides the pay, the joining date only names an empty day before it (as payroll does)
            row.update(status="not_joined" if joined is not None and d < joined else "absent")
            absent += 1
        elif record.status in ("present", "half_shift"):
            present += 1
            shifts = Decimal(str(record.shifts_earned or 0))
            shifts = shifts if shifts > 0 else ONE
            if record.is_half_shift or record.status == "half_shift" or shifts == Decimal("0.50"):
                half += 1
                row["status"] = "half_shift"
            else:
                row["status"] = "present"
            worked += shifts
            row["shifts"] = float(shifts)
            row["late"] = bool(record.is_late)
            late += 1 if record.is_late else 0
            early += 1 if record.early_leave else 0
            if d in cl:
                cl_total += min(shifts, cl[d])
                row["note"] = "Casual Leave"
        elif record.status == "on_leave":
            unpaid_leave += 1
            row.update(status="leave", note="Leave (unpaid)")
        elif record.status == "holiday":
            paid_leave += 1
            worked += ONE
            row.update(status="holiday", shifts=1.0, note="Marked holiday")
        else:
            absent += 1
            row.update(status="absent")
        calendar_rows.append(row)
        d += timedelta(days=1)

    worked_days = worked  # shifts on working days (+ a working day HR marked a holiday)
    paid_days = worked_days + Decimal(len(paid_holidays))
    salary = Decimal(str(emp.salary_amount))
    daily_exact = salary / Decimal(company_days)
    gross = d2(daily_exact * paid_days)
    daily_rate = d2(daily_exact)
    factor = paid_days / Decimal(company_days)

    # earnings lines: the salary split prorated by the paid days, adding up to the gross to the paisa
    parts, recorded = effective_split(emp)
    earnings: list[dict] = []
    if parts:
        order = [c for c in FIRST_PORTION + SECOND_PORTION if parts.get(c)]
        amounts = {c: d2(Decimal(str(parts[c])) * factor) for c in order}
        if order:
            biggest = max(order, key=lambda c: (amounts[c], -order.index(c)))
            amounts[biggest] += gross - sum(amounts.values(), ZERO)
        earnings = [_line(c, SPLIT_LABELS[c], amounts[c]) for c in order if amounts[c] != 0]
    if not earnings:
        earnings = [_line("salary", "Salary", gross)]
    first_monthly = sum((Decimal(str(parts[c])) for c in FIRST_PORTION if parts and parts.get(c)), ZERO)
    second_monthly = salary - first_monthly if parts else salary - d2(salary / 2)
    if not parts:
        first_monthly = d2(salary / 2)

    notes: list[str] = []
    if period.in_progress:
        notes.append(f"Counted up to {counted.strftime('%d %B %Y')}: the month is not over yet.")
    if parts and not recorded:
        notes.append("No salary split recorded on the profile: the standard 50/50 split is used.")
    if joined and period.start < joined <= period.end:
        notes.append(f"Joined on {joined.strftime('%d %B %Y')}: the days before it are not paid.")
    if (emp.status or "").lower() != "active":
        notes.append("This employee is inactive.")

    deductions: list[dict] = []
    statutory_breakdown = None
    if options["statutory"]:
        ps = settings_for_employee(emp)
        statutory = staff_statutory(emp, ps, prorate_factor=factor, earned_gross=gross)
        deductions += _statutory_lines(statutory)
        statutory_breakdown = statutory.breakdown()
    late_info = None
    if options["lateDeductions"]:
        approved_permissions = EmployeePermission.objects.filter(
            employee=emp, date__gte=period.start, date__lte=period.end, status="approved"
        ).count()
        pool = late_pool_summary(records, approved_permissions, attendance_settings, counted_dates=working_set)
        pricing = late_pool_pricing(pool, attendance_settings, daily_rate)
        if pricing["late_penalty"] > 0:
            deductions.append(
                _line(
                    "late",
                    "Late deduction",
                    pricing["late_penalty"],
                    f"{pool['billable']} chargeable of {pool['total']} late / early-out "
                    f"({_rate(pricing['late_shifts'])} shift)",
                )
            )
        if pricing["permission_penalty"] > 0:
            deductions.append(
                _line(
                    "permission",
                    "Permission deduction",
                    pricing["permission_penalty"],
                    f"{pool.get('permission_billable', 0)} excess permission(s) "
                    f"({_rate(pricing['permission_shifts'])} shift)",
                )
            )
        late_info = {
            "lateIn": pool["late_in"],
            "earlyOut": pool["early_out"],
            "excessPermissions": pool["excess_permissions"],
            "total": pool["total"],
            "free": pool["free_used"],
            "billable": pool["billable"],
            "shifts": float(pricing["shifts"]),
            "amount": float(pricing["penalty"]),
        }
    advance_total, advance_details = ZERO, []
    if options["advances"]:
        advance_total, advance_details = advance_instalments(emp, period.month, period.year)
        if advance_total > 0:
            deductions.append(
                _line("advance", "Advance instalment", advance_total, f"{len(advance_details)} instalment(s)")
            )

    holidays_paid = Decimal(len(paid_holidays))
    hd = min(holidays_paid, max(paid_days - cl_total, ZERO))
    lop = max(ZERO, Decimal(company_days) - paid_days)
    days = [
        ("companyDays", "Company days", company_days),
        ("workingDays", "Working days", len(working_days)),
        ("holidayDays", "Paid holidays", len(paid_holidays)),
        ("presentDays", "Days present", present),
        ("halfShiftDays", "Half-shift days", half),
        ("clDays", "Casual Leave", cl_total),
        ("absentDays", "Absent / leave", absent + unpaid_leave),
        ("lateDays", "Late days", late),
        ("paidDays", "Paid days", paid_days),
        ("lopDays", "Loss of pay days", lop),
    ]
    result = {
        "employeeId": emp.id,
        "kind": KIND_STAFF,
        "slipNumber": slip_number(emp, period.month, period.year),
        "employee": _employee_json(emp),
        "period": period.json(),
        "rate": {
            "monthlySalary": _num(salary),
            "dailyRate": _num(daily_rate),
            "companyDays": company_days,
            "salaryPerShift": None,
        },
        "days": [{"key": k, "label": label, "value": _days_value(v)} for k, label, v in days],
        "earnings": earnings,
        "calendar": calendar_rows,
        "notes": notes,
        "options": dict(options),
        "late": late_info,
        "advanceDetails": advance_details,
        "statutory": statutory_breakdown,
    }
    _finish(result, gross, deductions)
    by_key = {line["key"]: Decimal(str(line["amount"])) for line in deductions}
    others = by_key.get("late", ZERO) + by_key.get("permission", ZERO)
    result["statement"] = {
        "basic": _num(first_monthly),
        "otherAllowance": _num(second_monthly),
        "totalSalary": _num(salary),
        "present": _days_value(max(paid_days - cl_total - hd, ZERO)),
        "cl": _days_value(cl_total),
        "hd": _days_value(hd),
        "totalDays": _days_value(paid_days),
        "lop": _days_value(lop),
        "companyDays": company_days,
        "earned": _num(gross),
        "pf": _num(by_key.get("pf", ZERO)),
        "esi": _num(by_key.get("esi", ZERO)),
        "tds": _num(by_key.get("tds", ZERO)),
        "advance": _num(by_key.get("advance", ZERO)),
        "others": _num(others),
        "totalDeduction": result["deductionsTotal"],
        "net": result["net"],
    }
    result["paidDays"] = _days_value(paid_days)
    result["leaveTaken"] = unpaid_leave
    return result


# ───────────────────────────── production ─────────────────────────────


def _calculate_production(emp: Employee, period: Period, options: dict) -> dict:
    from ..attendance_final import compute_range_records
    from ..payroll_views import _production_late_days, late_shift_deduction
    from ..production_cycles import cycle_late_rules

    ps = settings_for_employee(emp)
    records = compute_range_records(emp, period.start, period.counted_to)
    joined = parse_join_date(emp.join_date)
    rate = Decimal(str(emp.salary_per_shift))
    holiday_names = _holidays(period)

    shifts_total = ZERO
    worked = absent = 0
    by_date = {r.date: r for r in records}
    late_reasons: dict = {}
    late_count = 0
    late_info = None
    late_penalty = ZERO
    if options["lateDeductions"] and ps.prod_late_detection_enabled:
        late_count, late_reasons = _production_late_days(emp, records, ps)
        allowance, slabs = cycle_late_rules(ps, PRODUCTION_LATE_CYCLE)
        billable = max(0, late_count - (allowance or 0))
        deduction_shifts = late_shift_deduction(billable, ps, slabs_field="prod_late_deduction_slabs", slabs=slabs)
        late_penalty = d2(deduction_shifts * rate) if deduction_shifts > 0 else ZERO
        late_info = {
            "total": late_count,
            "free": min(late_count, allowance or 0),
            "billable": billable,
            "shifts": float(deduction_shifts),
            "amount": float(late_penalty),
        }

    calendar_rows = []
    d = period.start
    while d <= period.end:
        row = {
            "date": d.isoformat(),
            "day": DAY_NAMES[d.weekday()],
            "shifts": 0.0,
            "firstIn": None,
            "lastOut": None,
            "late": d in late_reasons,
            "note": late_reasons.get(d, ""),
        }
        record = by_date.get(d)
        if d > period.counted_to:
            row["status"] = "future"
        elif record is None:
            row["status"] = "not_joined" if joined is not None and d < joined else "absent"
        else:
            shifts = Decimal(str(record.shifts_earned or 0))
            shifts_total += shifts
            row["shifts"] = float(shifts)
            row["firstIn"] = record.first_punch.strftime("%H:%M") if record.first_punch else None
            row["lastOut"] = record.last_punch.strftime("%H:%M") if record.last_punch else None
            if record.status in ("present", "half_shift"):
                worked += 1
                row["status"] = record.status
            elif record.status == "absent":
                absent += 1
                row["status"] = "sunday" if d.weekday() == 6 and not shifts else "absent"
            elif record.status == "holiday":
                row["status"] = "holiday"
                row["note"] = row["note"] or holiday_names.get(d, "Holiday")
            elif record.status == "on_leave":
                row["status"] = "leave"
            else:
                row["status"] = record.status or "absent"
        calendar_rows.append(row)
        d += timedelta(days=1)

    gross = d2(shifts_total * rate)
    notes: list[str] = []
    if period.in_progress:
        notes.append(f"Counted up to {period.counted_to.strftime('%d %B %Y')}: the month is not over yet.")
    if joined and period.start < joined <= period.end:
        notes.append(f"Joined on {joined.strftime('%d %B %Y')}.")
    if (emp.status or "").lower() != "active":
        notes.append("This employee is inactive.")
    if options["lateDeductions"] and not ps.prod_late_detection_enabled:
        notes.append("Production Late Detection is switched off in Settings: no late deduction.")

    deductions: list[dict] = []
    statutory_breakdown = None
    if options["statutory"]:
        statutory = production_statutory(emp, ps, period_gross=gross, monthly_factor=1)
        deductions += _statutory_lines(statutory)
        statutory_breakdown = statutory.breakdown()
    if late_penalty > 0:
        deductions.append(
            _line(
                "late",
                "Late deduction",
                late_penalty,
                f"{late_info['billable']} chargeable of {late_count} late day(s) ({_rate(late_info['shifts'])} shift)",
            )
        )
    advance_total, advance_details = ZERO, []
    if options["advances"]:
        advance_total, advance_details = advance_instalments(emp, period.month, period.year)
        if advance_total > 0:
            deductions.append(
                _line("advance", "Advance instalment", advance_total, f"{len(advance_details)} instalment(s)")
            )

    month_days = (period.counted_to - period.start).days + 1
    days = [
        ("monthDays", "Days counted", month_days),
        ("daysWorked", "Days worked", worked),
        ("daysAbsent", "Days absent", absent),
        ("totalShifts", "Shifts earned", shifts_total),
        ("lateDays", "Late days", late_count),
    ]
    result = {
        "employeeId": emp.id,
        "kind": KIND_PRODUCTION,
        "slipNumber": slip_number(emp, period.month, period.year),
        "employee": _employee_json(emp),
        "period": period.json(),
        "rate": {"monthlySalary": None, "dailyRate": None, "companyDays": None, "salaryPerShift": _num(rate)},
        "days": [{"key": k, "label": label, "value": _days_value(v)} for k, label, v in days],
        "earnings": [_line("wages", f"Shift wages ({_rate(shifts_total)} x {_rate(rate)})", gross)],
        "calendar": calendar_rows,
        "notes": notes,
        "options": dict(options),
        "late": late_info,
        "advanceDetails": advance_details,
        "statutory": statutory_breakdown,
    }
    _finish(result, gross, deductions)
    by_key = {line["key"]: Decimal(str(line["amount"])) for line in deductions}
    result["statement"] = {
        "salaryPerShift": _num(rate),
        "daysWorked": worked,
        "absent": absent,
        "shifts": _days_value(shifts_total),
        "earned": _num(gross),
        "pf": _num(by_key.get("pf", ZERO)),
        "esi": _num(by_key.get("esi", ZERO)),
        "tds": _num(by_key.get("tds", ZERO)),
        "advance": _num(by_key.get("advance", ZERO)),
        "others": _num(by_key.get("late", ZERO)),
        "totalDeduction": result["deductionsTotal"],
        "net": result["net"],
    }
    result["paidDays"] = _days_value(shifts_total)
    result["leaveTaken"] = 0
    return result


# ───────────────────────────── entry point ─────────────────────────────


def calculate(emp: Employee, month: int, year: int, options=None, *, today: date | None = None) -> dict:
    """The worked-out slip of `emp` for the calendar month (the SlipResult of the API contract). Raises CannotCalculate
    with a plain reason when it cannot be worked out (no salary on the profile, a month not started ...)."""
    period = period_for(month, year, today)
    issue = pay_issue(emp)
    if issue:
        raise CannotCalculate(issue)
    options = clean_options(options)
    if kind_of(emp) == KIND_PRODUCTION:
        return _calculate_production(emp, period, options)
    return _calculate_staff(emp, period, options)
