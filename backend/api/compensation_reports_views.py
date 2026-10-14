"""
Compensation reports (History & Reports): who benefited from each kind of compensation, for Today / Week / Month.

    GET /api/compensation/reports?period=today|week|month&date=YYYY-MM-DD&type=<type>[,<type>...]&departmentId=&branchId=

`period`: today (default) = `date` itself; week = the Monday-to-Sunday week containing `date`; month = the calendar month
containing `date`. `date` defaults to today (India). `type` limits the answer to some of the seven types (default: all).
A pure read, for STAFF only (production is never reported), branch-scoped; always readable, whatever the switches say
(the records stay readable when a feature is off).

One section per type, in this order, each with a `summary` (counts / totals) and the beneficiary `rows`. Every row of every
type has the SAME keys, so one export (Excel) can be built from all of them: see ROW_KEYS. What a row is, and which date
puts it in a period:

  ot_allowance         Type 1: one OT day that earned a next-day late-in allowance. The benefit is the morning it was USED,
                       so a used allowance is filed under that day (`usedOn`, `minutesUsed`: the employee arrived late
                       within it); one nobody has used stays under the OT day. `status`: used, not_used (they came on a
                       later day and did not need it) or pending (not worked since). Never paid.
  ot_shift_relaxation  Type 2 given as relaxation: filed under the granted date (`claim_date`, the day off). `status`:
                       applied (the day record carries the relaxation marker), scheduled (the date has not come yet) or
                       not_applied (the date has passed and the engine did not top it up).
  ot_shift_pay         Type 2 given as pay: filed under the granted date (HR need not give one for pay: then the OT day).
                       `amount` = shifts x the daily rate of the month's salary slip (the very rate payroll used) when
                       payroll has been generated; otherwise `amount` is the ESTIMATE shifts x salary / 30 (the one the
                       Compensation summary already uses) and `amountEstimated` is true.
                       `status`: in_payroll (the month's slip covers it: payroll holds a SHIFTS total per employee-month,
                       compared with everything assigned for that month, earliest assigned first) or pending_payroll
                       (assigned after the slip was generated: regenerate it).

`minutes` means what the type needs (the allowance granted, the extra minutes of a Type 2 day, a window's minutes);
`extraMinutes` (minutes worked past the shift end: the Type 1 and Type 2 rows) and `allowanceMinutes` (the late-in
allowance minutes earned: the Type 1 rows) say it explicitly, and are null on every other row.
  window_late_in       Company-announced late-in window USED: one row per employee-day whose attendance carries the
  window_early_out     `window_late_in` / `window_early_out` marker (early-out likewise), with the announcement's time,
                       reason and who announced it. The summary also says how many announcements there were and how many
                       staff-days they covered, so the share who used it is visible.
  holiday_work         Sunday / holiday work claims filed under the work date, with their status (pending / approved /
                       rejected), who raised and who approved them. `redemptions` lists the balance redeemed in the period.
  birthday             Staff whose birthday falls in the period AND who benefit (feature on, effective date reached, a working
                       day). `status`: applied (the day carries the birthday marker), pending (today or later, not applied
                       yet) or not_applied (the day passed without the marker, e.g. a manual override won).

Records made before the overhaul (an old announced OT record) are not in these reports: the unchanged
GET /api/compensation/summary keeps showing them.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ, ist_today
from .compensation_birthday_views import birthday_rows
from .compensation_shared import (
    PERIODS,
    employee_json,
    parse_date,
    parse_int,
    period_bounds,
    switches,
)
from .compensation_windows_views import covers_count, visible_announcements, window_time
from .models import (
    AttendanceDayRecord,
    CompensationDayAnnouncement,
    CompensationLedger,
    Employee,
    HolidayWorkClaim,
    OvertimeRecord,
    SalarySlip,
)

TYPES = (
    "ot_allowance",
    "ot_shift_relaxation",
    "ot_shift_pay",
    "window_late_in",
    "window_early_out",
    "holiday_work",
    "birthday",
)
LABELS = {
    "ot_allowance": "OT: next-day late-in allowance",
    "ot_shift_relaxation": "OT: shift compensation as relaxation",
    "ot_shift_pay": "OT: shift compensation as pay",
    "window_late_in": "Company late-in window",
    "window_early_out": "Company early-out window",
    "holiday_work": "Holiday / Sunday work",
    "birthday": "Birthday leave",
}
# which switch of compensation_shared.switches() says the type is acting
SWITCH_OF = {
    "ot_allowance": "allowance",
    "ot_shift_relaxation": "relaxation",
    "ot_shift_pay": "pay",
    "window_late_in": "windows",
    "window_early_out": "windows",
    "holiday_work": "holidayWork",
    "birthday": "birthday",
}
STATUS_LABELS = {
    "used": "Used",
    "not_used": "Not used",
    "pending": "Pending",
    "applied": "Applied",
    "scheduled": "Scheduled",
    "not_applied": "Not applied",
    "approved": "Approved",
    "rejected": "Rejected",
    "in_payroll": "In payroll",
    "pending_payroll": "Waiting for payroll",
    "redeemed": "Redeemed",
}
# Type 2 records HR has assigned: "announced" is what the assign endpoint stores; "assigned" is accepted too.
ASSIGNED_STATUSES = ("announced", "assigned")
WORKED_STATUSES = (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)
# How long after the OT day an allowance can still be used (the engine looks back this far for "the previous working day").
ALLOWANCE_LOOKBACK_DAYS = 10

ROW_KEYS = (
    "type",
    "employeeId",
    "employeeCode",
    "employeeName",
    "department",
    "departmentId",
    "designation",
    "branch",
    "branchId",
    "employmentType",
    "date",
    "workDate",
    "usedOn",
    "time",
    "firstPunch",
    "lastPunch",
    "minutes",
    "minutesUsed",
    "shifts",
    "status",
    "statusLabel",
    "amount",
    "amountEstimated",
    "assignedBy",
    "approvedBy",
    "grantedOn",
    "reason",
    "detail",
    "extraMinutes",
    "allowanceMinutes",
)
SELECT = ("employee__department", "employee__designation", "employee__branch")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class Ctx:
    def __init__(self, request: Request, start: date, end: date, department_id, branch_id):
        self.request = request
        self.start = start
        self.end = end
        self.today = ist_today()
        self.department_id = department_id
        self.branch_id = branch_id
        self.scope = get_branch_scope(request)


def scoped(qs, ctx: Ctx, prefix: str = "employee__"):
    """Staff only, inside the caller's branch, narrowed by the department / branch filters."""
    qs = qs.filter(**{f"{prefix}employment_type": "staff"})
    if ctx.scope is not None:
        qs = qs.filter(**{f"{prefix}branch_id": ctx.scope})
    if ctx.branch_id is not None:
        qs = qs.filter(**{f"{prefix}branch_id": ctx.branch_id})
    if ctx.department_id is not None:
        qs = qs.filter(**{f"{prefix}department_id": ctx.department_id})
    return qs


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _ist_date(value) -> str | None:
    return value.astimezone(FACTORY_TZ).date().isoformat() if value else None


def _num(value) -> float | None:
    return None if value is None else float(value)


def blank_row(type_: str, emp, day) -> dict:
    row = {key: None for key in ROW_KEYS}
    row.update(employee_json(emp))
    row.update({"type": type_, "date": day.isoformat() if day else None, "amountEstimated": False, "detail": ""})
    return row


def set_status(row: dict, status: str) -> dict:
    row["status"] = status
    row["statusLabel"] = STATUS_LABELS.get(status, status)
    return row


def _employees(rows) -> int:
    return len({r["employeeId"] for r in rows})


# ─────────────────────────── Type 1: the allowance ───────────────────────────


def _filed(r: OvertimeRecord) -> date:
    """The date a Type 2 record is filed under: the day it is granted for - or, for Pay (which needs no date), the OT day."""
    return r.claim_date or r.date


def _shifts(r: OvertimeRecord) -> Decimal:
    """The shifts a Type 2 record is worth: its own, or ONE whole day when it has none (a record from before the overhaul)."""
    return r.shifts if r.shifts is not None else Decimal("1.00")


def _allowance(ctx: Ctx):
    # The benefit of an allowance is the morning it is USED, so a used one is filed under that day and one nobody has
    # used stays under the OT day. An allowance used inside the period can therefore come from an OT day up to
    # ALLOWANCE_LOOKBACK_DAYS before it.
    records = list(
        scoped(
            OvertimeRecord.objects.filter(
                ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE,
                date__gte=ctx.start - timedelta(days=ALLOWANCE_LOOKBACK_DAYS),
                date__lte=ctx.end,
            ).select_related(*SELECT),
            ctx,
        )
    )
    if not records:
        return [], {
            "earned": 0,
            "earnedMinutes": 0,
            "used": 0,
            "usedMinutes": 0,
            "notUsed": 0,
            "pending": 0,
            "employees": 0,
        }
    ids = {r.employee_id for r in records}
    first, last = min(r.date for r in records), max(r.date for r in records)
    horizon = last + timedelta(days=ALLOWANCE_LOOKBACK_DAYS)
    # A day USED an allowance when it carries the allowance minutes. The single stored kind says only the most important
    # thing that shaped the day (a birthday, a relaxation or a window outranks the allowance), so the minutes - which
    # only the allowance writes - decide, with the kind as the second witness.
    markers: dict[int, list] = defaultdict(list)
    for rec in AttendanceDayRecord.objects.filter(
        Q(compensation_kind__contains="ot_allowance") | Q(compensation_minutes__gt=0),
        employee_id__in=ids,
        date__gt=first,
        date__lte=horizon,
    ).order_by("date"):
        markers[rec.employee_id].append(rec)
    worked: dict[int, list] = defaultdict(list)
    for emp_id, day in (
        AttendanceDayRecord.objects.filter(
            employee_id__in=ids, status__in=WORKED_STATUSES, date__gt=first, date__lte=min(horizon, ctx.today)
        )
        .order_by("date")
        .values_list("employee_id", "date")
    ):
        worked[emp_id].append(day)
    # the OT days of the same people just after the period also bound where an allowance can have been used
    later_ot: dict[int, list] = defaultdict(list)
    for emp_id, day in OvertimeRecord.objects.filter(
        employee_id__in=ids, ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE, date__gt=first, date__lte=horizon
    ).values_list("employee_id", "date"):
        later_ot[emp_id].append(day)

    rows = []
    for r in records:
        window_end = r.date + timedelta(days=ALLOWANCE_LOOKBACK_DAYS)
        after = sorted(d for d in later_ot.get(r.employee_id, ()) if d > r.date)
        if after:  # the next OT day's own morning still belongs to THIS allowance; its evening starts the next one
            window_end = min(window_end, after[0])
        used = next((m for m in markers.get(r.employee_id, ()) if r.date < m.date <= window_end), None)
        filed = used.date if used is not None else r.date
        if not ctx.start <= filed <= ctx.end:
            continue
        row = blank_row("ot_allowance", r.employee, filed)
        row.update(
            {
                "workDate": r.date.isoformat(),
                "minutes": r.allowance_minutes,
                "extraMinutes": r.ot_minutes,
                "allowanceMinutes": r.allowance_minutes,
                "assignedBy": "Automatic",
                "grantedOn": _ist_date(r.created_at),
                "lastPunch": _hhmm(r.last_punch_out),
                "detail": (
                    f"Worked until {_hhmm(r.last_punch_out)} ({r.ot_minutes} min past the shift end); "
                    f"{r.allowance_minutes} min allowed on the next working day's first punch."
                ),
            }
        )
        if used is not None:
            row.update(
                {
                    "usedOn": used.date.isoformat(),
                    "minutesUsed": used.compensation_minutes,
                    "firstPunch": _hhmm(used.first_punch),
                    "detail": used.compensation_note or row["detail"],
                }
            )
            set_status(row, "used")
        elif any(r.date < d <= window_end for d in worked.get(r.employee_id, ())):
            set_status(row, "not_used")
        else:
            set_status(row, "pending")
        rows.append(row)
    rows.sort(key=lambda row: (row["date"], row["employeeName"], row["employeeId"], row["workDate"]))
    summary = {
        "earned": len(rows),
        "earnedMinutes": sum(r["minutes"] or 0 for r in rows),
        "used": sum(1 for r in rows if r["status"] == "used"),
        "usedMinutes": sum(r["minutesUsed"] or 0 for r in rows),
        "notUsed": sum(1 for r in rows if r["status"] == "not_used"),
        "pending": sum(1 for r in rows if r["status"] == "pending"),
        "employees": _employees(rows),
    }
    return rows, summary


# ─────────────────────────── Type 2: relaxation and pay ───────────────────────────


def _shift_records(ctx: Ctx):
    """The assigned Type 2 records filed inside the period: by the date they are granted for - and a Pay record HR gave
    no date (the date is optional for Pay, payroll pays it by the OT day) by the OT day."""
    in_period = Q(claim_date__gte=ctx.start, claim_date__lte=ctx.end) | Q(
        claim_date__isnull=True,
        compensation_type=OvertimeRecord.TYPE_PAY,
        date__gte=ctx.start,
        date__lte=ctx.end,
    )
    records = list(
        scoped(
            OvertimeRecord.objects.filter(
                in_period, ot_type=OvertimeRecord.OT_TYPE_SHIFT, status__in=ASSIGNED_STATUSES
            ).select_related(*SELECT),
            ctx,
        )
    )
    records.sort(key=lambda r: (_filed(r), r.employee.first_name, r.employee_id))
    return records


def _shift_row(type_: str, r: OvertimeRecord) -> dict:
    row = blank_row(type_, r.employee, _filed(r))
    row.update(
        {
            "workDate": r.date.isoformat(),
            "minutes": r.ot_minutes,
            "extraMinutes": r.ot_minutes,
            "shifts": _num(r.shifts),
            "assignedBy": r.announced_by,
            "grantedOn": _ist_date(r.announced_at),
            "lastPunch": _hhmm(r.last_punch_out),
            "detail": f"Worked until {_hhmm(r.last_punch_out)} ({r.ot_minutes} min past the shift end).",
        }
    )
    return row


def _relaxation(ctx: Ctx, records: list[OvertimeRecord]):
    records = [r for r in records if r.compensation_type == OvertimeRecord.TYPE_RELAXATION]
    if not records:
        return [], {"records": 0, "shifts": 0.0, "applied": 0, "scheduled": 0, "notApplied": 0, "employees": 0}
    applied = {
        (rec.employee_id, rec.date)
        for rec in AttendanceDayRecord.objects.filter(
            employee_id__in={r.employee_id for r in records},
            compensation_kind__contains="relaxation",
            date__gte=ctx.start,
            date__lte=ctx.end,
        )
    }
    rows = []
    for r in records:
        row = _shift_row("ot_shift_relaxation", r)
        if (r.employee_id, r.claim_date) in applied:
            set_status(row, "applied")
            row["usedOn"] = r.claim_date.isoformat()
        elif r.claim_date >= ctx.today:
            set_status(row, "scheduled")
        else:
            set_status(row, "not_applied")
        row["detail"] += f" Relaxation (alternative day off) on {r.claim_date.isoformat()}."
        rows.append(row)
    summary = {
        "records": len(rows),
        "shifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in rows)),
        "applied": sum(1 for r in rows if r["status"] == "applied"),
        "scheduled": sum(1 for r in rows if r["status"] == "scheduled"),
        "notApplied": sum(1 for r in rows if r["status"] == "not_applied"),
        "employees": _employees(rows),
    }
    return rows, summary


def _slip_shifts(slip: SalarySlip, month_total: Decimal) -> Decimal:
    """The shifts of OT pay a slip holds: the breakdown's `otShifts` (slips generated since the overhaul), else `otDays`
    (older slips pay one whole day per record). A slip with neither figure (typed by hand) has only its OT amount to go
    on: that amount over the daily rate or, with no rate to divide by, "everything" (there is OT pay in it)."""
    earnings = (slip.breakdown_details or {}).get("earnings") or {}
    for key in ("otShifts", "otDays"):
        if earnings.get(key) is not None:
            return Decimal(str(earnings[key]))
    paid = slip.ot_amount or Decimal("0")
    if paid <= 0:
        return Decimal("0")
    rate = earnings.get("dailyRate")
    if not rate:
        return month_total
    return (paid / Decimal(str(rate))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _covered_by_payroll(emp_ids, months, slips) -> set[int]:
    """The ids of the assigned Pay records that payroll has paid. A slip holds only a TOTAL of shifts per employee-month,
    so it is compared with EVERYTHING assigned as Pay for that month (not just the rows of this report), earliest
    assigned first: the slip covers the first records whose shifts add up to what it holds, and any later one is still
    waiting for payroll (it was assigned after the slip was generated)."""
    lo, hi = min(months), max(months)
    by_month: dict[tuple, list] = defaultdict(list)
    for rid, emp_id, day, shifts, announced_at in (
        OvertimeRecord.objects.filter(
            employee_id__in=emp_ids,
            status__in=ASSIGNED_STATUSES,
            compensation_type=OvertimeRecord.TYPE_PAY,
            date__gte=date(lo[0], lo[1], 1),
            date__lte=date(hi[0], hi[1], calendar.monthrange(*hi)[1]),
        )
        .exclude(ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE)  # payroll never pays the Type 1 allowance
        .values_list("id", "employee_id", "date", "shifts", "announced_at")
    ):
        by_month[(emp_id, day.year, day.month)].append(
            (announced_at or _EPOCH, rid, Decimal(str(shifts)) if shifts is not None else Decimal("1.00"))
        )
    covered: set[int] = set()
    for key, items in by_month.items():
        slip = slips.get(key)
        if slip is None:
            continue
        held = _slip_shifts(slip, sum((s for _at, _id, s in items), Decimal("0")))
        running = Decimal("0")
        for _at, rid, shifts in sorted(items):
            running += shifts
            if running <= held:
                covered.add(rid)
    return covered


def _pay(ctx: Ctx, records: list[OvertimeRecord]):
    records = [r for r in records if r.compensation_type == OvertimeRecord.TYPE_PAY]
    empty = {
        "records": 0,
        "shifts": 0.0,
        "amount": 0.0,
        "estimatedAmount": 0.0,
        "inPayroll": 0,
        "pendingPayroll": 0,
        "employees": 0,
    }
    if not records:
        return [], empty
    emp_ids = {r.employee_id for r in records}
    # payroll pays a record in the month of its OT day (not of the day it is granted for)
    months = {(r.date.year, r.date.month) for r in records}
    slips = {
        (s.employee_id, s.year, s.month): s
        for s in SalarySlip.objects.filter(
            employee_id__in=emp_ids,
            year__in={y for y, _m in months},
            month__in={m for _y, m in months},
            week_number__isnull=True,
        )
    }
    paid_ids = _covered_by_payroll(emp_ids, months, slips)
    rows = []
    for r in records:
        row = _shift_row("ot_shift_pay", r)
        slip = slips.get((r.employee_id, r.date.year, r.date.month))
        rate = ((slip.breakdown_details or {}).get("earnings") or {}).get("dailyRate") if slip else None
        shifts = _shifts(r)
        if rate:
            row["amount"] = float((Decimal(str(rate)) * shifts).quantize(Decimal("0.01")))
        elif r.employee.salary_amount:
            row["amount"] = float((r.employee.salary_amount / Decimal("30") * shifts).quantize(Decimal("0.01")))
            row["amountEstimated"] = True
        set_status(row, "in_payroll" if r.id in paid_ids else "pending_payroll")
        row["detail"] += (
            f" Paid as {float(shifts):g} shift of the daily rate, in the {r.date.strftime('%B %Y')} payroll."
        )
        rows.append(row)
    summary = {
        "records": len(rows),
        "shifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in rows)),
        "amount": float(sum(Decimal(str(r["amount"] or 0)) for r in rows if not r["amountEstimated"])),
        "estimatedAmount": float(sum(Decimal(str(r["amount"] or 0)) for r in rows if r["amountEstimated"])),
        "inPayroll": sum(1 for r in rows if r["status"] == "in_payroll"),
        "pendingPayroll": sum(1 for r in rows if r["status"] == "pending_payroll"),
        "employees": _employees(rows),
    }
    return rows, summary


# ─────────────────────────── announced windows ───────────────────────────


def _staff_table(ctx: Ctx) -> dict[tuple, int]:
    from django.db.models import Count

    qs = scoped(Employee.objects.filter(status="active"), ctx, prefix="")
    return {
        (r["branch_id"], r["department_id"]): r["n"]
        for r in qs.values("branch_id", "department_id").annotate(n=Count("id"))
    }


def _covering(announcements: list, emp) -> CompensationDayAnnouncement | None:
    """The announcement of that date that covers `emp` (the engine's rule: listed employees, else branch / department)."""
    for ann in announcements:
        listed = {e.id for e in ann.employees.all()}
        if emp.id in listed:
            return ann
        if listed:
            continue
        if ann.branch_id and ann.branch_id != emp.branch_id:
            continue
        if ann.department_id and ann.department_id != emp.department_id:
            continue
        return ann
    return None


def _window(ctx: Ctx, kind: str, table: dict):
    type_ = f"window_{kind}"
    anns = list(
        visible_announcements(
            CompensationDayAnnouncement.objects.filter(kind=kind, date__gte=ctx.start, date__lte=ctx.end)
            .select_related("branch", "department")
            .prefetch_related("employees"),
            ctx.scope,
        )
    )
    by_date: dict[date, list] = defaultdict(list)
    for ann in anns:
        by_date[ann.date].append(ann)
    used = list(
        scoped(
            AttendanceDayRecord.objects.filter(
                compensation_kind__contains=type_, date__gte=ctx.start, date__lte=ctx.end
            ).select_related(*SELECT),
            ctx,
        ).order_by("date", "employee__first_name", "employee_id")
    )
    rows = []
    for rec in used:
        ann = _covering(by_date.get(rec.date, []), rec.employee)
        row = blank_row(type_, rec.employee, rec.date)
        row.update(
            {
                "workDate": rec.date.isoformat(),
                "usedOn": rec.date.isoformat(),
                "firstPunch": _hhmm(rec.first_punch),
                "lastPunch": _hhmm(rec.last_punch),
                "minutes": rec.compensation_minutes or None,
                "detail": rec.compensation_note or "",
            }
        )
        if ann is not None:
            row.update(
                {
                    "time": _hhmm(window_time(ann)),
                    "reason": ann.reason,
                    "assignedBy": ann.announced_by,
                    "grantedOn": _ist_date(ann.created_at),
                }
            )
        set_status(row, "used")
        rows.append(row)
    summary = {
        "announcements": len(anns),
        "staffCovered": sum(covers_count(a, table) for a in anns),
        "used": len(rows),
        "employees": _employees(rows),
    }
    return rows, summary


# ─────────────────────────── holiday / Sunday work ───────────────────────────


def _holiday_work(ctx: Ctx):
    claims = list(
        scoped(
            HolidayWorkClaim.objects.filter(work_date__gte=ctx.start, work_date__lte=ctx.end)
            .select_related(*SELECT)
            .prefetch_related("ledger_entries"),
            ctx,
        ).order_by("work_date", "employee__first_name", "id")
    )
    rows = []
    for c in claims:
        row = blank_row("holiday_work", c.employee, c.work_date)
        approved = c.status == HolidayWorkClaim.STATUS_APPROVED
        credited = any(e.entry_type == CompensationLedger.ENTRY_CREDIT for e in c.ledger_entries.all())
        row.update(
            {
                "workDate": c.work_date.isoformat(),
                "shifts": _num(c.shifts),
                "assignedBy": c.requested_by,
                "approvedBy": c.reviewed_by if approved else None,
                "grantedOn": _ist_date(c.reviewed_at) if approved else None,
                "reason": c.reason,
                "detail": ("Added to the compensation balance." if credited else (c.review_comment or "")),
            }
        )
        set_status(row, c.status)
        rows.append(row)
    redemptions = []
    for entry in scoped(
        CompensationLedger.objects.filter(
            entry_type=CompensationLedger.ENTRY_DEBIT, date__gte=ctx.start, date__lte=ctx.end
        ).select_related(*SELECT),
        ctx,
    ).order_by("date", "employee__first_name", "id"):
        row = blank_row("holiday_work", entry.employee, entry.date)
        row.update(
            {
                "usedOn": entry.date.isoformat(),
                "shifts": _num(entry.shifts),
                "assignedBy": entry.created_by,
                "grantedOn": _ist_date(entry.created_at),
                "detail": entry.note or "Compensation balance redeemed.",
            }
        )
        set_status(row, "redeemed")
        redemptions.append(row)
    approved_rows = [r for r in rows if r["status"] == "approved"]
    pending_rows = [r for r in rows if r["status"] == "pending"]
    summary = {
        "claims": len(rows),
        "pending": len(pending_rows),
        "approved": len(approved_rows),
        "rejected": sum(1 for r in rows if r["status"] == "rejected"),
        "approvedShifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in approved_rows)),
        "pendingShifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in pending_rows)),
        "redeemedShifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in redemptions)),
        "employees": _employees(rows),
    }
    return rows, summary, redemptions


# ─────────────────────────── birthday ───────────────────────────


def _birthday(ctx: Ctx):
    rows = []
    for b in birthday_rows(ctx.request, ctx.start, ctx.end, ctx.department_id, ctx.branch_id):
        if not b["benefits"]:
            continue
        day = date.fromisoformat(b["birthday"])
        row = {key: None for key in ROW_KEYS}
        row.update({k: b[k] for k in ROW_KEYS if k in b})
        row.update(
            {
                "type": "birthday",
                "date": b["birthday"],
                "workDate": b["birthday"],
                "firstPunch": b["firstPunch"],
                "lastPunch": b["lastPunch"],
                "amountEstimated": False,
                "assignedBy": "Automatic",
                "detail": "",
            }
        )
        if b["applied"]:
            set_status(row, "applied")
            row["usedOn"] = b["birthday"]
            row["shifts"] = b["shiftsEarned"]
            row["detail"] = "Paid birthday leave: present for the whole day, no attendance detection."
        elif day >= ctx.today:
            set_status(row, "pending")
            row["detail"] = "Paid birthday leave applies on the day."
        else:
            set_status(row, "not_applied")
            row["detail"] = "The day was not marked as birthday leave (check the day's attendance)."
        rows.append(row)
    summary = {
        "birthdays": len(rows),
        "applied": sum(1 for r in rows if r["status"] == "applied"),
        "pending": sum(1 for r in rows if r["status"] == "pending"),
        "notApplied": sum(1 for r in rows if r["status"] == "not_applied"),
        "shifts": float(sum(Decimal(str(r["shifts"] or 0)) for r in rows)),
        "employees": _employees(rows),
    }
    return rows, summary


# ─────────────────────────── the endpoint ───────────────────────────


def _requested_types(raw) -> tuple[list[str] | None, str | None]:
    if raw in (None, "", "all"):
        return list(TYPES), None
    wanted = [t.strip() for t in str(raw).split(",") if t.strip()]
    unknown = [t for t in wanted if t not in TYPES]
    if unknown or not wanted:
        return None, f"type must be one or more of: {', '.join(TYPES)}."
    return [t for t in TYPES if t in wanted], None


@api_view(["GET"])
@require_hr
def compensation_reports(request: Request) -> Response:
    q = request.query_params
    period = (q.get("period") or "today").lower()
    if period not in PERIODS:
        return Response({"error": "period must be today, week or month."}, status=400)
    anchor = ist_today()
    if q.get("date"):
        anchor = parse_date(q.get("date"))
        if anchor is None:
            return Response({"error": "date must be a date (YYYY-MM-DD)."}, status=400)
    types, error = _requested_types(q.get("type"))
    if error:
        return Response({"error": error}, status=400)
    for name in ("departmentId", "branchId"):
        if q.get(name) not in (None, "") and parse_int(q.get(name)) is None:
            return Response({"error": f"{name} must be a number."}, status=400)

    start, end = period_bounds(period, anchor)
    ctx = Ctx(request, start, end, parse_int(q.get("departmentId")), parse_int(q.get("branchId")))
    flags = switches()

    shift_records = _shift_records(ctx) if {"ot_shift_relaxation", "ot_shift_pay"} & set(types) else []
    table = _staff_table(ctx) if {"window_late_in", "window_early_out"} & set(types) else {}
    sections = []
    for type_ in types:
        extra: dict = {}
        if type_ == "ot_allowance":
            rows, summary = _allowance(ctx)
        elif type_ == "ot_shift_relaxation":
            rows, summary = _relaxation(ctx, shift_records)
        elif type_ == "ot_shift_pay":
            rows, summary = _pay(ctx, shift_records)
        elif type_ == "window_late_in":
            rows, summary = _window(ctx, CompensationDayAnnouncement.KIND_LATE_IN, table)
        elif type_ == "window_early_out":
            rows, summary = _window(ctx, CompensationDayAnnouncement.KIND_EARLY_OUT, table)
        elif type_ == "holiday_work":
            rows, summary, redemptions = _holiday_work(ctx)
            extra["redemptions"] = redemptions
        else:
            rows, summary = _birthday(ctx)
        sections.append(
            {
                "type": type_,
                "label": LABELS[type_],
                "enabled": bool(flags[SWITCH_OF[type_]]),
                "summary": summary,
                "rows": rows,
                **extra,
            }
        )
    everyone = {r["employeeId"] for s in sections for r in s["rows"]}
    return Response(
        {
            "period": period,
            "date": anchor.isoformat(),
            "from": start.isoformat(),
            "to": end.isoformat(),
            "filters": {"departmentId": ctx.department_id, "branchId": ctx.branch_id},
            "types": types,
            "rowKeys": list(ROW_KEYS),
            "totals": {"rows": sum(len(s["rows"]) for s in sections), "employees": len(everyone)},
            "sections": sections,
        }
    )
