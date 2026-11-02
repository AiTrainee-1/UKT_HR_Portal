"""
Every compensation of the signed-in employee for one calendar year, for the mobile app's Compensation timeline.
READ-ONLY (unlike GET /api/employee/compensation, it never refreshes the OT rows: that endpoint does, and the screen
calls it too).

    GET /api/my/compensation-history?year=YYYY

GET /api/employee/compensation lists the last 90 days. This lists the whole year and adds what it never lists:
  compensation_day    a Compensation Day HR announced (CompensationDayAnnouncement kind "day": the day, or the part of it
                      after `leave_until_time`, is exempt from late / permission rules)
  balance_credit      a credit HR put on the compensation balance that is not a holiday-work approval (an overtime
                      relaxation added to the balance without a date, a migrated credit): the ledger's own credit rows
  alternative_day     an Alternative Day credit from before the compensation overhaul (CompensationLeaveCredit), with
                      whether it is still available or was used
and, per month, the overtime pay the staff salary slip of that month paid (SalarySlip.ot_amount: payroll pays the
announced OT of a month on that month's slip), so "Overtime pay assigned by HR" can say what it came to.

Every item has the fields of the 90-day list (see employee_compensation_views: key, kind, group, date, title, detail,
status, statusLabel, shifts, minutes, minutesUsed, used, workDate?, time?, legacy?) plus:
  month        'YYYY-MM' the item is filed under (its `date`)
  source       hr | automatic | company     who gave it
  sourceLabel  'Given by HR' | 'Automatic' | 'Announced by HR for everyone'
  givenByHr    true for everything HR gave or announced (source hr or company)

Staff only, like the 90-day list: a production employee gets `isStaff: false`, nothing listed and the same message.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from django.db.models import Max, Min, Sum

from .compensation_shared import date_text, holiday_names, shifts_text, switches
from .employee_compensation_views import (
    _birthday_items,
    _claim_items,
    _covers,
    _item,
    _ot_items,
    _redemption_items,
    _stop,
    _window_items,
    balance_shifts,
)
from .models import (
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    CompensationLedger,
    EmployeeShiftAssignment,
    HolidayWorkClaim,
    OvertimeRecord,
    SalarySlip,
)
from .payroll_insights import MONTH_NAMES, money

SOURCE_LABELS = {
    "hr": "Given by HR",
    "automatic": "Automatic",
    "company": "Announced by HR for everyone",
}

# who gives each kind of item
KIND_SOURCE = {
    "ot_allowance": "automatic",
    "ot_shift": "automatic",
    "ot_shift_relaxation": "hr",
    "ot_shift_pay": "hr",
    "holiday_work": "hr",
    "redemption": "hr",
    "window_late_in": "company",
    "window_early_out": "company",
    "compensation_day": "company",
    "birthday": "automatic",
    "balance_credit": "hr",
    "alternative_day": "hr",
}


def _tag(item: dict) -> dict:
    source = KIND_SOURCE.get(item["kind"], "hr")
    item["source"] = source
    item["sourceLabel"] = SOURCE_LABELS[source]
    item["givenByHr"] = source in ("hr", "company")
    item["month"] = (item.get("date") or "")[:7] or None
    return item


def _compensation_day_items(emp, today: date, start: date, end: date) -> list[dict]:
    """The Compensation Days HR announced (kind "day") that cover the employee, in the year."""
    out = []
    for a in (
        CompensationDayAnnouncement.objects.filter(
            kind=CompensationDayAnnouncement.KIND_DAY, date__gte=start, date__lte=end
        )
        .prefetch_related("employees")
        .order_by("-date", "-id")
    ):
        if not _covers(a, emp):
            continue
        until = a.leave_until_time.strftime("%H:%M") if a.leave_until_time else None
        if until:
            title = f"Compensation day: you may leave from {until}"
            detail = (
                f"HR announced a compensation day on {date_text(a.date)}: you may leave from {until} without an "
                "early-out mark."
            )
        else:
            title = "Compensation day"
            detail = (
                f"HR announced a compensation day on {date_text(a.date)}: no late or permission rule applies that day."
            )
        if a.reason:
            detail += f" Reason: {_stop(a.reason)}"
        status = "upcoming" if a.date > today else ("today" if a.date == today else "announced")
        item = _item(f"cd-{a.id}", "compensation_day", "company", a.date, title, detail, status, time=until)
        if status == "announced":
            item["statusLabel"] = "Announced by HR"
        out.append(item)
    return out


def _credit_items(emp, start: date, end: date) -> list[dict]:
    """Credits on the balance that are not a holiday-work approval (those are listed as their claim)."""
    out = []
    for e in (
        CompensationLedger.objects.filter(
            employee=emp, entry_type=CompensationLedger.ENTRY_CREDIT, date__gte=start, date__lte=end
        )
        .exclude(source="holiday_work")
        .order_by("-date", "-id")
    ):
        if e.source == "ot_shift":
            detail = (
                f"HR added {shifts_text(e.shifts)} shift to your compensation balance for the extra hours you worked on "
                f"{date_text(e.date)}."
            )
        else:
            detail = f"HR added {shifts_text(e.shifts)} shift to your compensation balance ({date_text(e.date)})."
        item = _item(
            f"cr-{e.id}",
            "balance_credit",
            "balance",
            e.date,
            f"Added to your balance: {shifts_text(e.shifts)} shift",
            detail,
            "approved",
            shifts=float(e.shifts),
        )
        item["statusLabel"] = "Added to balance"
        out.append(item)
    return out


def _alternative_day_items(emp, start: date, end: date) -> list[dict]:
    """The Alternative Day credits from before the overhaul (one shift each), filed under the overtime day that earned them
    (or the day they were made when that record is gone)."""
    out = []
    for c in CompensationLeaveCredit.objects.filter(employee=emp).select_related("source_overtime_record"):
        source = c.source_overtime_record
        earned = source.date if source is not None else c.created_at.date()
        if not (start <= earned <= end):
            continue
        detail = "An alternative day off HR gave you for overtime"
        detail += f" on {date_text(earned)}." if source is not None else "."
        if c.status == CompensationLeaveCredit.STATUS_USED:
            detail += f" Used on {date_text(c.used_date)}." if c.used_date else " Already used."
            status, label = "taken", "Used"
        else:
            detail += " Still available: HR gives you the day off from it."
            status, label = "available", "Available"
        item = _item(
            f"ad-{c.id}",
            "alternative_day",
            "balance",
            earned,
            "Alternative day off: 1.00 shift",
            detail,
            status,
            shifts=1.0,
            legacy=True,
        )
        item["statusLabel"] = label
        out.append(item)
    return out


def _ot_pay_by_month(emp, year: int) -> list[dict]:
    """The overtime pay each staff salary slip of the year paid, as payroll stored it (SalarySlip.ot_amount)."""
    out = []
    for slip in SalarySlip.objects.filter(employee=emp, year=year, period_start__isnull=True, week_number__isnull=True):
        amount = Decimal(slip.ot_amount or 0)
        if amount <= 0:
            continue
        earnings = (slip.breakdown_details or {}).get("earnings") if isinstance(slip.breakdown_details, dict) else None
        shifts = (earnings or {}).get("otShifts")
        out.append(
            {
                "month": f"{year}-{slip.month:02d}",
                "label": f"{MONTH_NAMES[slip.month - 1]} {year}",
                "amount": money(amount),
                "shifts": money(shifts) if shifts is not None else None,
                "slipId": slip.id,
            }
        )
    out.sort(key=lambda r: r["month"])
    return out


def _years(emp, today: date) -> list[int]:
    """Every year that has something for the employee, newest first; always this year."""
    lows, highs = [today.year], [today.year]
    for model, field in (
        (OvertimeRecord, "date"),
        (HolidayWorkClaim, "work_date"),
        (CompensationLedger, "date"),
    ):
        agg = model.objects.filter(employee=emp).aggregate(lo=Min(field), hi=Max(field))
        if agg["lo"]:
            lows.append(agg["lo"].year)
        if agg["hi"]:
            highs.append(agg["hi"].year)
    return list(range(max(highs), min(lows) - 1, -1))


def _disabled(message: str, year: int) -> dict:
    return {
        "isStaff": False,
        "year": year,
        "years": [year],
        "balance": None,
        "totals": None,
        "otPayByMonth": [],
        "items": [],
        "message": message,
    }


def history_for(emp, year: int, today: date) -> dict:
    if emp.employment_type != "staff":
        return _disabled("Compensation is for staff employees only.", year)
    start, end = date(year, 1, 1), date(year, 12, 31)
    flags = switches()
    cfg = CompensationConfig.get()
    assignments = list(EmployeeShiftAssignment.objects.filter(employee=emp).select_related("shift"))
    holidays = holiday_names(start, end)

    def holidays_for(day: date) -> dict:
        return holidays if start <= day <= end else holiday_names(day, day)

    items, _today, _tomorrow = _ot_items(emp, today, cfg, flags["master"], assignments, since=start)
    items += _claim_items(emp, today, holidays, since=start)
    items += _redemption_items(emp, today, since=start)
    if flags["windows"]:
        items += _window_items(emp, today, since=start, until=end)
    if flags["birthday"]:
        items += _birthday_items(emp, today, holidays_for, cfg, flags["master"], assignments, year=year)
    items += _compensation_day_items(emp, today, start, end)
    items += _credit_items(emp, start, end)
    items += _alternative_day_items(emp, start, end)
    # the builders read "from `since` on": keep the year only
    items = [_tag(i) for i in items if i.get("date") and start.isoformat() <= i["date"] <= end.isoformat()]
    items.sort(key=lambda i: (i["date"] or "", i["key"]), reverse=True)

    ledger = CompensationLedger.objects.filter(employee=emp, date__gte=start, date__lte=end)
    credited = ledger.filter(entry_type=CompensationLedger.ENTRY_CREDIT).aggregate(s=Sum("shifts"))["s"] or 0
    taken = ledger.filter(entry_type=CompensationLedger.ENTRY_DEBIT).aggregate(s=Sum("shifts"))["s"] or 0
    ot_pay = _ot_pay_by_month(emp, year)
    hr_shifts = sum(
        (
            Decimal(str(i["shifts"]))
            for i in items
            if i["kind"] in ("ot_shift_relaxation", "ot_shift_pay")
            or (i["kind"] == "holiday_work" and i["status"] == "approved")
            if i["shifts"] is not None
        ),
        Decimal("0"),
    )
    return {
        "isStaff": True,
        "year": year,
        "years": _years(emp, today),
        "enabled": flags,
        "balance": {
            "shifts": float(balance_shifts(emp)),
            "creditedThisYear": money(credited),
            "takenThisYear": money(taken),
            "alternativeDaysAvailable": CompensationLeaveCredit.objects.filter(
                employee=emp, status=CompensationLeaveCredit.STATUS_AVAILABLE
            ).count(),
        },
        "totals": {
            "items": len(items),
            "givenByHr": sum(1 for i in items if i["source"] == "hr"),
            "company": sum(1 for i in items if i["source"] == "company"),
            "automatic": sum(1 for i in items if i["source"] == "automatic"),
            "shiftsGivenByHr": money(hr_shifts),
            "otPay": money(sum((Decimal(str(r["amount"])) for r in ot_pay), Decimal("0"))),
        },
        "otPayByMonth": ot_pay,
        "items": items,
        "message": None,
    }
