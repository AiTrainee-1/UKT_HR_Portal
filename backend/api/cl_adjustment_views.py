"""Casual Leave Carry Forward (owner 2026-11-04): on the HR Casual Leave page (Carry Forward tab) HR turns an employee's
ABSENT, ON LEAVE or HALF DAY days into Casual Leave from their yearly balance, a full day or a half day each. HR portal
only for now: the employee apps just read the balance and the Casual Leave, which already include these.

The yearly balance stays a fixed 12 (owner: never add extra days). "Deduct days": HR enters how many days at most (a half
counts 0.5), the system detects the employee's absent, on-leave and half days of a month, and HR picks dates up to that
many days, choosing Full day, First half or Second half for each. Exactly the picked dates become approved Casual Leave
(written as an approved Casual Leave always is: a full day = paid Present 1.00; a half pays its half and the other half
counts by the punches, so a half day whose missed half is covered becomes a full paid day) and the balance goes down by
their days. The number is only the most that may be picked, never a deduction of its own.

    GET  /api/casual-leaves/absent-dates?employeeIds=1,2&month=10&year=2026
         -> {year, month, monthLabel, monthStart, monthEnd, lastDay, assignable,
             employees: [{employeeId, balance, absent: [Day], onLeave: [Day], halfDay: [Day], dates: [Day],
                          calendar: [{date, weekday, status, selectable, label}]}]}
         Day = {date, weekday, status: "absent"|"on_leave"|"half_shift", label, portions: ["full", "first_half", ...],
                suggested, worked: "morning"|"evening"|null, firstPunch, lastPunch, manual,
                halves: {first: "09:00-13:00", second: "14:00-18:00"} | null}
         `portions` = what may be given that day: a day HR set by hand takes a full day only (it is never recomputed); a
         half day whose worked half is known takes the OTHER half or a full day (Casual Leave on the worked half would
         pay nothing); `suggested` = what the picker starts on.
    POST /api/casual-leaves/assign {reason, items: [{employeeId, limit, dates: [{date, portion} | "YYYY-MM-DD"]}]}
         -> 201 {count, days, items: [Adjustment]} | 400 {error, problems: [{employeeId, employeeName, error}]}
         a bare date is a full day; `limit` in days (half days allowed)
    GET  /api/casual-leaves/adjustments?year=&employeeId=&page=&pageSize=
         -> {year, items: [Adjustment], total, page, pageSize, summary: {changes, employees, days}}

Rules: this year's dates up to today only; staff, active, 6 months of service, within the caller's branch; every date must
be absent, on leave or a half day and hold no Casual Leave yet, with a portion that day allows; no more days than the
number entered nor than the balance has left; a reason always; all or nothing. The log keeps one line per employee per save
(CasualLeaveAdjustment kind "assign"); it is a record only, the approved Casual Leave itself lowers the balance. Gated by
the Casual Leave module (HrPermissionMiddleware: viewing reads, changing needs edit).
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import cl_balance
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import CasualLeaveAdjustment, Employee

MAX_ITEMS = 500
MAX_LIMIT = Decimal("31")
REASON_MIN, REASON_MAX = 3, 300
CONVERTIBLE = ("absent", "on_leave", "half_shift")  # AttendanceDayRecord statuses HR may turn into Casual Leave
LEAVE_REASON = {"sick": "Sick Leave", "emergency": "Emergency", "personal": "Personal", "other": "Other"}
FULL, FIRST, SECOND = cl_balance.FULL, cl_balance.FIRST_HALF, cl_balance.SECOND_HALF
PORTION_DAYS = cl_balance.PORTION_DAYS
PORTION_WORDS = {FULL: "full day", FIRST: "first half", SECOND: "second half"}
HALF = Decimal("0.5")


def _name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip() or emp.employee_code


def _parts_of(raw) -> list[dict]:
    """The log line's dates as [{date, portion, portionLabel, days}]; a bare date (the first builds) is a full day."""
    out = []
    for entry in raw or []:
        if isinstance(entry, dict):
            d, portion = str(entry.get("date") or ""), cl_balance.portion_of(entry.get("portion"))
        else:
            d, portion = str(entry), FULL
        out.append(
            {
                "date": d,
                "portion": portion,
                "portionLabel": cl_balance.PORTION_LABEL[portion],
                "days": cl_balance.number(PORTION_DAYS[portion]),
            }
        )
    return out


def adjustment_json(a: CasualLeaveAdjustment) -> dict:
    emp = a.employee
    parts = _parts_of(a.dates)
    return {
        "id": a.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": _name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "year": a.year,
        "days": cl_balance.number(a.days),  # minus the days given (a half counts 0.5)
        "dates": [p["date"] for p in parts],
        "parts": parts,  # added with half days: each date and what of it was given
        "reason": a.reason,
        "balanceBefore": cl_balance.number(a.balance_before),
        "balanceAfter": cl_balance.number(a.balance_after),
        "createdBy": a.created_by,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


def _days_word(value) -> str:
    value = abs(Decimal(str(value)))
    return f"{cl_balance.number(value)} day{'' if value == 1 else 's'}"


# ── the log ──────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def casual_leave_adjustments(request: Request) -> Response:
    today = ist_today()
    try:
        year = int(request.query_params.get("year") or today.year)
        page = max(1, int(request.query_params.get("page") or 1))
        size = min(500, max(1, int(request.query_params.get("pageSize") or 100)))
    except (TypeError, ValueError):
        return Response({"error": "year, page and pageSize must be numbers"}, status=400)
    # "balance" lines were the first build's "Add days" (dropped the same day: the 12 is fixed); they count for nothing
    qs = scope_to_branch(
        CasualLeaveAdjustment.objects.filter(year=year, kind=CasualLeaveAdjustment.KIND_ASSIGN).select_related(
            "employee__department", "employee__branch"
        ),
        request,
        field="employee__branch_id",
    )
    if raw := request.query_params.get("employeeId"):
        try:
            qs = qs.filter(employee_id=int(raw))
        except (TypeError, ValueError):
            return Response({"error": "employeeId must be a number"}, status=400)
    rows = list(qs.order_by("-created_at", "-id"))
    start = (page - 1) * size
    days = sum((-Decimal(str(a.days)) for a in rows), Decimal("0"))
    return Response(
        {
            "year": year,
            "items": [adjustment_json(a) for a in rows[start : start + size]],
            "total": len(rows),
            "page": page,
            "pageSize": size,
            "summary": {
                "changes": len(rows),
                "employees": len({a.employee_id for a in rows}),
                "days": cl_balance.number(days),
            },
        }
    )


# ── detection ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OpenDay:
    """A day that can be given as Casual Leave, and how."""

    date: date
    status: str  # absent | on_leave | half_shift
    label: str
    portions: tuple[str, ...]
    suggested: str
    worked: str | None  # a half day: "morning" | "evening" | None (not known)
    first_punch: str | None
    last_punch: str | None
    manual: bool


def _clock(t) -> str | None:
    return t.strftime("%H:%M") if t else None


def _leave_labels(employee_ids, first: date, last: date) -> dict[tuple[int, date], str]:
    """{(employee id, date): "Sick Leave"} for the approved full-day leave behind an On Leave day."""
    from .models import LeaveRequest

    out: dict[tuple[int, date], str] = {}
    for lr in LeaveRequest.objects.filter(employee_id__in=list(employee_ids), status="approved", is_half_day=False):
        try:
            s, e = date.fromisoformat(str(lr.start_date)[:10]), date.fromisoformat(str(lr.end_date)[:10])
        except ValueError:
            continue
        label = LEAVE_REASON.get(getattr(lr, "reason_category", "") or "", "Leave")
        d = max(s, first)
        while d <= min(e, last):
            out[(lr.employee_id, d)] = label
            d += timedelta(days=1)
    return out


def _open_day(rec, leave_label: str | None, settings) -> OpenDay:
    from .attendance_final import half_period

    manual = rec.source == "manual"
    first_punch, last_punch = _clock(rec.first_punch), _clock(rec.last_punch)
    if rec.status == "half_shift":
        worked = half_period(rec, settings)
        missing = SECOND if worked == "morning" else FIRST if worked == "evening" else None
        if manual:
            portions, suggested = (FULL,), FULL
        elif missing:
            portions, suggested = (missing, FULL), missing
        else:
            portions, suggested = (FIRST, SECOND, FULL), SECOND
        span = f" ({first_punch}-{last_punch})" if first_punch and last_punch and first_punch != last_punch else ""
        label = {
            "morning": f"Half Day · worked the morning{span}",
            "evening": f"Half Day · worked the evening{span}",
        }.get(worked or "", "Half Day")
        return OpenDay(rec.date, rec.status, label, portions, suggested, worked, first_punch, last_punch, manual)
    portions = (FULL,) if manual else (FULL, FIRST, SECOND)
    label = "Absent" if rec.status == "absent" else f"On Leave · {leave_label or 'Leave'}"
    return OpenDay(rec.date, rec.status, label, portions, FULL, None, first_punch, last_punch, manual)


def _open_days(employee_ids, first: date, last: date) -> dict[int, list[OpenDay]]:
    """{employee id: [OpenDay, ...]} the days between first and last the attendance marks Absent, On Leave or Half Day
    and that hold no Casual Leave yet (pending or approved, or one HR proposed through an attendance edit)."""
    from .models import AttendanceDayRecord, PayrollSettings

    ids = list(employee_ids)
    out: dict[int, list[OpenDay]] = {i: [] for i in ids}
    if not ids or first > last:
        return out
    held = cl_balance.parts(ids, first, last)
    taken = {i: {p.date for p in held.get(i, [])} for i in ids}
    labels = _leave_labels(ids, first, last)
    settings = PayrollSettings.get()
    for rec in AttendanceDayRecord.objects.filter(
        employee_id__in=ids, date__range=(first, last), status__in=CONVERTIBLE
    ).order_by("date"):
        if rec.date not in taken[rec.employee_id]:
            out[rec.employee_id].append(_open_day(rec, labels.get((rec.employee_id, rec.date)), settings))
    return out


def _halves(emp: Employee, d: date) -> dict | None:
    """{first: "09:00-13:00", second: "14:00-18:00"}: what each half means in clock time on that day's shift."""
    from .casual_leave_views import _shift_halves_json

    shift = _shift_halves_json(emp, d)
    if not shift:
        return None
    return {
        "first": f"{shift['start']}-{shift['firstHalfEnd']}",
        "second": f"{shift['secondHalfStart']}-{shift['end']}",
    }


@api_view(["GET"])
@require_hr
def casual_leave_absent_dates(request: Request) -> Response:
    from .models import AttendanceDayRecord

    today = ist_today()
    try:
        year = int(request.query_params.get("year") or today.year)
        month = int(request.query_params.get("month") or today.month)
        ids = [int(x) for x in str(request.query_params.get("employeeIds") or "").split(",") if x.strip()]
        first = date(year, month, 1)
    except (TypeError, ValueError):
        return Response({"error": "employeeIds, month and year must be numbers"}, status=400)
    if not ids:
        return Response({"error": "Choose at least one employee."}, status=400)
    if len(ids) > MAX_ITEMS:
        return Response({"error": f"At most {MAX_ITEMS} employees at a time."}, status=400)
    month_end = date(year, month, calendar.monthrange(year, month)[1])
    last = min(month_end, today)
    employees = {e.id: e for e in scope_to_branch(Employee.objects, request).filter(pk__in=ids)}
    found = [i for i in ids if i in employees]
    open_days = _open_days(found, first, last)
    statuses: dict[int, dict[date, str]] = {i: {} for i in found}
    for emp_id, day, status in AttendanceDayRecord.objects.filter(
        employee_id__in=found, date__range=(first, month_end)
    ).values_list("employee_id", "date", "status"):
        statuses[emp_id][day] = status
    held = cl_balance.parts(found, first, month_end)
    balances = cl_balance.balances(found, today.year)

    def day_json(emp: Employee, o: OpenDay) -> dict:
        return {
            "date": o.date.isoformat(),
            "weekday": o.date.strftime("%a"),
            "status": o.status,
            "label": o.label,
            "portions": list(o.portions),
            "suggested": o.suggested,
            "worked": o.worked,
            "firstPunch": o.first_punch,
            "lastPunch": o.last_punch,
            "manual": o.manual,
            "halves": _halves(emp, o.date) if len(o.portions) > 1 else None,
        }

    out = []
    for emp_id in found:
        mine = [day_json(employees[emp_id], o) for o in open_days[emp_id]]
        by_date = {x["date"]: x for x in mine}
        cl_days = {p.date for p in held.get(emp_id, [])}
        cal = []
        d = first
        while d <= month_end:
            iso = d.isoformat()
            if d > today:
                status, label = "future", "Still to come"
            elif d in cl_days:
                status, label = "cl", "Casual Leave"
            elif iso in by_date:
                status, label = by_date[iso]["status"], by_date[iso]["label"]
            else:
                status = statuses[emp_id].get(d, "none")
                label = {
                    "present": "Present",
                    "half_shift": "Half Day",
                    "holiday": "Holiday / week off",
                    "absent": "Absent",
                    "on_leave": "On Leave",
                    "none": "No attendance record",
                }.get(status, status)
            cal.append(
                {
                    "date": iso,
                    "weekday": d.strftime("%a"),
                    "status": status,
                    "selectable": iso in by_date,
                    "label": label,
                }
            )
            d += timedelta(days=1)
        out.append(
            {
                "employeeId": emp_id,
                "balance": balances.get(emp_id),
                "absent": [x for x in mine if x["status"] == "absent"],
                "onLeave": [x for x in mine if x["status"] == "on_leave"],
                "halfDay": [x for x in mine if x["status"] == "half_shift"],
                "dates": mine,
                "calendar": cal,
            }
        )
    return Response(
        {
            "year": year,
            "month": month,
            "monthLabel": first.strftime("%B %Y"),
            "monthStart": first.isoformat(),
            "monthEnd": month_end.isoformat(),
            "lastDay": last.isoformat() if last >= first else None,
            # dates of another year cannot be given: that year's balance is not this year's
            "assignable": year == today.year and first <= today,
            "employees": out,
        }
    )


# ── assigning ────────────────────────────────────────────────────────────────


def _parse_limit(raw) -> Decimal | None:
    """The most days, in whole or half days."""
    if isinstance(raw, bool) or raw is None or str(raw).strip() == "":
        return None
    try:
        value = Decimal(str(raw).strip())
    except (InvalidOperation, ValueError):
        return None
    if not value.is_finite() or value % HALF != 0:
        return None
    return value


def _parse_dates(raw) -> list[tuple[date, str]] | None:
    """[(date, portion), ...] from [{date, portion}] or ["YYYY-MM-DD"] (a full day); None when any entry is not one."""
    if not isinstance(raw, list):
        return None
    out = []
    for entry in raw:
        if isinstance(entry, dict):
            d, portion = entry.get("date"), str(entry.get("portion") or FULL)
        else:
            d, portion = entry, FULL
        try:
            day = date.fromisoformat(str(d)[:10])
        except (TypeError, ValueError):
            return None
        if portion not in PORTION_DAYS:
            return None
        out.append((day, portion))
    return out


def _portion_refusal(o: OpenDay, portion: str) -> str | None:
    """Why `portion` cannot be given on this open day (None = it can)."""
    if portion in o.portions:
        return None
    day = o.date.strftime("%d %b")
    if o.manual:
        return f"{day} was set by hand on the attendance pages: only a full day of Casual Leave can be given on it."
    if o.worked:
        part = "morning" if o.worked == "morning" else "evening"
        other = PORTION_WORDS[o.suggested]
        return f"{day}: the {part} was worked, so only the {other} (or a full day) can be given."
    return f"{day}: that part of the day cannot be given."


@api_view(["POST"])
@require_hr
def casual_leave_assign(request: Request) -> Response:
    from django.utils import timezone

    from .casual_leave_views import ELIGIBILITY_MONTHS, _service_months, _write_attendance_for_cl
    from .models import CasualLeaveRequest

    data = request.data if isinstance(request.data, dict) else {}
    today = ist_today()
    reason = str(data.get("reason") or "").strip()
    if not (REASON_MIN <= len(reason) <= REASON_MAX):
        return Response(
            {"error": f"Write a reason of {REASON_MIN} to {REASON_MAX} characters (it is kept with every change)."},
            status=400,
        )
    items = data.get("items")
    if not isinstance(items, list) or not items:
        return Response({"error": "Choose at least one employee."}, status=400)
    if len(items) > MAX_ITEMS:
        return Response({"error": f"At most {MAX_ITEMS} employees at a time."}, status=400)
    cut_over = cl_balance.since()
    if cl_balance.window(today.year, cut_over) is None:
        return Response({"error": f"No Casual Leave balance is kept for {today.year}."}, status=400)

    wanted: list[tuple[int, list[tuple[date, str]], Decimal]] = []
    problems: list[dict] = []
    seen: set[int] = set()
    for item in items:
        item = item if isinstance(item, dict) else {}
        try:
            emp_id = int(item.get("employeeId"))
        except (TypeError, ValueError):
            return Response({"error": "Every line needs an employeeId."}, status=400)
        if emp_id in seen:
            return Response({"error": "An employee is listed twice: give each one a single line."}, status=400)
        seen.add(emp_id)
        limit = _parse_limit(item.get("limit"))
        picks = _parse_dates(item.get("dates"))
        total = sum((PORTION_DAYS[p] for _d, p in picks or []), Decimal("0"))
        if limit is None or not (HALF <= limit <= MAX_LIMIT):
            problems.append({"employeeId": emp_id, "error": "Enter the days from 0.5 to 31 (whole or half days)."})
        elif picks is None:
            problems.append(
                {"employeeId": emp_id, "error": "Each date needs a real date and Full day, First half or Second half."}
            )
        elif not picks:
            problems.append({"employeeId": emp_id, "error": "Pick at least one date."})
        elif len({d for d, _p in picks}) != len(picks):
            problems.append({"employeeId": emp_id, "error": "Each date can be picked once."})
        elif total > limit:
            problems.append(
                {
                    "employeeId": emp_id,
                    "error": f"{_days_word(total)} picked, but the days allow {cl_balance.number(limit)} at most.",
                }
            )
        elif any(d.year != today.year or d > today for d, _p in picks):
            problems.append(
                {"employeeId": emp_id, "error": f"Only dates of {today.year} up to today can be given Casual Leave."}
            )
        else:
            wanted.append((emp_id, sorted(picks), total))

    actor = get_hr_display_name(request)
    now = timezone.now()
    with transaction.atomic():
        # Locks the employees for the rest of the transaction: two HR logins giving the same person Casual Leave at the
        # same moment are taken one after the other, so each sees the real balance.
        found = {
            e.id: e for e in scope_to_branch(Employee.objects.select_for_update(), request).filter(pk__in=list(seen))
        }
        staff_ids = [i for i in found if found[i].employment_type == "staff"]
        balances = cl_balance.balances(staff_ids, today.year, cut_over)
        plan = []
        for emp_id, picks, total in wanted:
            emp = found.get(emp_id)
            if emp is None:
                problems.append({"employeeId": emp_id, "error": "Employee not found."})
                continue
            if emp.employment_type != "staff":
                problems.append({"employeeId": emp_id, "error": "Casual Leave is for staff employees only."})
                continue
            if emp.status != "active":
                problems.append({"employeeId": emp_id, "error": "This employee is not active."})
                continue
            months = _service_months(emp)
            if months is None:
                problems.append({"employeeId": emp_id, "error": "Join date not set: Casual Leave cannot be given."})
                continue
            if months < ELIGIBILITY_MONTHS:
                problems.append(
                    {
                        "employeeId": emp_id,
                        "error": f"Casual Leave starts after {ELIGIBILITY_MONTHS} months of service (now {months}).",
                    }
                )
                continue
            open_days = {o.date: o for o in _open_days([emp_id], picks[0][0], picks[-1][0])[emp_id]}
            closed = [d for d, _p in picks if d not in open_days]
            if closed:
                listed = ", ".join(d.strftime("%d %b") for d in closed)
                problems.append(
                    {
                        "employeeId": emp_id,
                        "error": f"Not an absent, leave or half day (or it already has Casual Leave): {listed}. Pick again.",
                    }
                )
                continue
            refusal = next((r for d, p in picks if (r := _portion_refusal(open_days[d], p))), None)
            if refusal:
                problems.append({"employeeId": emp_id, "error": refusal})
                continue
            remaining = Decimal(str(balances[emp_id]["remaining"]))
            if total > remaining:
                problems.append(
                    {
                        "employeeId": emp_id,
                        "error": f"Only {_days_word(remaining)} of Casual Leave left, so {_days_word(total)} cannot be given.",
                    }
                )
                continue
            plan.append((emp, picks, total, remaining))

        if problems:
            names = {e.id: _name(e) for e in found.values()}
            for p in problems:
                p["employeeName"] = names.get(p["employeeId"])
            transaction.set_rollback(True)
            count = len(problems)
            return Response(
                {
                    "error": f"Nothing was changed: {count} employee{'' if count == 1 else 's'} need a look.",
                    "problems": problems,
                },
                status=400,
            )

        made = []
        for emp, picks, total, before in plan:
            for d, portion in picks:
                cl = CasualLeaveRequest.objects.create(
                    employee=emp,
                    date=d,
                    portion=portion,
                    reason=f"Given by HR for an absent / leave / half day: {reason}",
                    status=CasualLeaveRequest.STATUS_APPROVED,
                    approval_trail=[
                        {
                            "role": "hr",
                            "decision": "approved",
                            "by": actor,
                            "at": now.isoformat(),
                            "comment": reason,
                            "via": cl_balance.ASSIGN_VIA,
                        }
                    ],
                    reviewed_by=actor,
                    reviewer_role="hr",
                    reviewed_at=now,
                    review_comment=reason,
                )
                _write_attendance_for_cl(cl, actor)
            made.append(
                CasualLeaveAdjustment.objects.create(
                    employee=emp,
                    year=today.year,
                    days=-total,
                    reason=reason,
                    balance_before=before,
                    balance_after=before - total,
                    created_by=actor,
                    kind=CasualLeaveAdjustment.KIND_ASSIGN,
                    dates=[{"date": d.isoformat(), "portion": p} for d, p in picks],
                )
            )

    for a, (emp, picks, total, before) in zip(made, plan):
        listed = ", ".join(f"{d.strftime('%d %b %Y')} ({PORTION_WORDS[p]})" for d, p in picks)
        log_action(
            request,
            "create",
            "casual_leave",
            record_id=a.id,
            description=(
                f"Casual Leave {today.year}: {_name(emp)} ({emp.employee_code}) given {_days_word(total)} for "
                f"{listed}, {cl_balance.number(before)} → {cl_balance.number(before - total)} left. Reason: {reason}"
            ),
            new_values={"employeeId": emp.id, "dates": [{"date": d.isoformat(), "portion": p} for d, p in picks]},
        )
    named = Employee.objects.select_related("department", "branch").in_bulk([a.employee_id for a in made])
    for a in made:
        a.employee = named[a.employee_id]
    return Response(
        {
            "count": len(made),
            "days": cl_balance.number(sum((total for _e, _p, total, _b in plan), Decimal("0"))),
            "items": [adjustment_json(a) for a in made],
        },
        status=201,
    )
