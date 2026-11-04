"""Casual Leave Carry Forward (owner 2026-11-04): on the HR Casual Leave page (Carry Forward tab) HR turns an employee's
ABSENT or ON LEAVE days into Casual Leave from their yearly balance. HR portal only for now: the employee apps just read the
balance and the Casual Leave, which already include these.

The yearly balance stays a fixed 12 (owner: never add extra days). "Deduct days": HR enters how many days at most, the
system detects the employee's absent and on-leave days of a month, and HR picks that many of them (or fewer); exactly the
picked dates become approved, paid Casual Leave (attendance Present 1.00, as an approved Casual Leave always writes it) and
the balance goes down by their number. The number is only the most that may be picked, never a deduction of its own.

    GET  /api/casual-leaves/absent-dates?employeeIds=1,2&month=10&year=2026
         -> {year, month, monthLabel, monthStart, monthEnd, lastDay, assignable,
             employees: [{employeeId, balance, absent: [Day], onLeave: [Day], dates: [Day],
                          calendar: [{date, weekday, status, selectable, label}]}]}
         Day = {date, weekday, status: "absent"|"on_leave", label}; `dates` = absent + onLeave by date (what can be picked)
    POST /api/casual-leaves/assign {reason, items: [{employeeId, limit, dates: ["2026-10-07", ...]}]}
         -> 201 {count, days, items: [Adjustment]} | 400 {error, problems: [{employeeId, employeeName, error}]}
    GET  /api/casual-leaves/adjustments?year=&employeeId=&page=&pageSize=
         -> {year, items: [Adjustment], total, page, pageSize, summary: {changes, employees, days}}

Rules: this year's dates up to today only; staff, active, 6 months of service, within the caller's branch; every date must
be absent or on leave and hold no Casual Leave yet; no more dates than the number entered nor than the balance has left; a
reason always; all or nothing. The log keeps one line per employee per save (CasualLeaveAdjustment kind "assign"); it is a
record only, the approved Casual Leave itself lowers the balance. Gated by the Casual Leave module (HrPermissionMiddleware:
viewing reads, changing needs edit).
"""

from __future__ import annotations

import calendar
from datetime import date
from decimal import Decimal

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
MAX_LIMIT = 31
REASON_MIN, REASON_MAX = 3, 300
CONVERTIBLE = ("absent", "on_leave")  # AttendanceDayRecord statuses HR may turn into Casual Leave
LEAVE_REASON = {"sick": "Sick Leave", "emergency": "Emergency", "personal": "Personal", "other": "Other"}


def _name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip() or emp.employee_code


def adjustment_json(a: CasualLeaveAdjustment) -> dict:
    emp = a.employee
    return {
        "id": a.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": _name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "year": a.year,
        "days": cl_balance.number(a.days),  # minus the number of dates given
        "dates": list(a.dates or []),
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
                "days": sum(len(a.dates or []) for a in rows),
            },
        }
    )


# ── detection ────────────────────────────────────────────────────────────────


def _leave_labels(employee_ids, first: date, last: date) -> dict[tuple[int, date], str]:
    """{(employee id, date): "Sick Leave"} for the approved full-day leave behind an On Leave day."""
    from datetime import timedelta

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


def _convertible(employee_ids, first: date, last: date) -> dict[int, list[tuple[date, str]]]:
    """{employee id: [(date, status), ...]} the days between first and last the attendance marks Absent or On Leave and
    that hold no Casual Leave yet (pending or approved, or one HR proposed through an attendance edit)."""
    from .models import AttendanceDayRecord

    ids = list(employee_ids)
    out: dict[int, list[tuple[date, str]]] = {i: [] for i in ids}
    if not ids or first > last:
        return out
    held = cl_balance.parts(ids, first, last)
    taken = {i: {p.date for p in held.get(i, [])} for i in ids}
    for emp_id, day, status in (
        AttendanceDayRecord.objects.filter(employee_id__in=ids, date__range=(first, last), status__in=CONVERTIBLE)
        .order_by("date")
        .values_list("employee_id", "date", "status")
    ):
        if day not in taken[emp_id]:
            out[emp_id].append((day, status))
    return out


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
    found = list(scope_to_branch(Employee.objects, request).filter(pk__in=ids).values_list("id", flat=True))
    days = _convertible(found, first, last)
    labels = _leave_labels(found, first, last)
    statuses: dict[int, dict[date, str]] = {i: {} for i in found}
    for emp_id, day, status in AttendanceDayRecord.objects.filter(
        employee_id__in=found, date__range=(first, month_end)
    ).values_list("employee_id", "date", "status"):
        statuses[emp_id][day] = status
    held = cl_balance.parts(found, first, month_end)
    balances = cl_balance.balances(found, today.year)

    def day_json(emp_id: int, d: date, status: str) -> dict:
        label = "Absent" if status == "absent" else f"On Leave · {labels.get((emp_id, d), 'Leave')}"
        return {"date": d.isoformat(), "weekday": d.strftime("%a"), "status": status, "label": label}

    employees = []
    for emp_id in found:
        mine = [day_json(emp_id, d, s) for d, s in days[emp_id]]
        pickable = {x["date"] for x in mine}
        cl_days = {p.date for p in held.get(emp_id, [])}
        cal = []
        d = first
        while d <= month_end:
            iso = d.isoformat()
            if d > today:
                status, label = "future", "Still to come"
            elif d in cl_days:
                status, label = "cl", "Casual Leave"
            else:
                status = statuses[emp_id].get(d, "none")
                label = {
                    "present": "Present",
                    "half_shift": "Half day",
                    "holiday": "Holiday / week off",
                    "absent": "Absent",
                    "on_leave": f"On Leave · {labels.get((emp_id, d), 'Leave')}",
                    "none": "No attendance record",
                }.get(status, status)
            cal.append(
                {
                    "date": iso,
                    "weekday": d.strftime("%a"),
                    "status": status,
                    "selectable": iso in pickable,
                    "label": label,
                }
            )
            d = date.fromordinal(d.toordinal() + 1)
        employees.append(
            {
                "employeeId": emp_id,
                "balance": balances.get(emp_id),
                "absent": [x for x in mine if x["status"] == "absent"],
                "onLeave": [x for x in mine if x["status"] == "on_leave"],
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
            "employees": employees,
        }
    )


# ── assigning ────────────────────────────────────────────────────────────────


def _parse_date(raw):
    try:
        return date.fromisoformat(str(raw)[:10])
    except (TypeError, ValueError):
        return None


def _parse_limit(raw) -> int | None:
    if isinstance(raw, bool) or raw is None or str(raw).strip() == "":
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


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

    wanted: list[tuple[int, list]] = []
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
        raw_dates = item.get("dates") if isinstance(item.get("dates"), list) else []
        dates = [_parse_date(d) for d in raw_dates]
        if limit is None or not (1 <= limit <= MAX_LIMIT):
            problems.append({"employeeId": emp_id, "error": f"Enter the days as a whole number from 1 to {MAX_LIMIT}."})
        elif not dates:
            problems.append({"employeeId": emp_id, "error": "Pick at least one date."})
        elif any(d is None for d in dates) or len(set(dates)) != len(dates):
            problems.append({"employeeId": emp_id, "error": "The dates must be real dates, each picked once."})
        elif len(dates) > limit:
            problems.append(
                {"employeeId": emp_id, "error": f"{len(dates)} dates picked, but the days allow {limit} at most."}
            )
        elif any(d.year != today.year or d > today for d in dates):
            problems.append(
                {"employeeId": emp_id, "error": f"Only dates of {today.year} up to today can be given Casual Leave."}
            )
        else:
            wanted.append((emp_id, sorted(dates)))

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
        for emp_id, dates in wanted:
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
            open_days = {d for d, _s in _convertible([emp_id], dates[0], dates[-1])[emp_id]}
            not_open = [d for d in dates if d not in open_days]
            if not_open:
                listed = ", ".join(d.strftime("%d %b") for d in not_open)
                problems.append(
                    {
                        "employeeId": emp_id,
                        "error": f"Not an absent or leave day (or it already has Casual Leave): {listed}. Pick again.",
                    }
                )
                continue
            remaining = Decimal(str(balances[emp_id]["remaining"]))
            if Decimal(len(dates)) > remaining:
                problems.append(
                    {
                        "employeeId": emp_id,
                        "error": f"Only {_days_word(remaining)} of Casual Leave left, so {len(dates)} dates cannot be given.",
                    }
                )
                continue
            plan.append((emp, dates, remaining))

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
        for emp, dates, before in plan:
            for d in dates:
                cl = CasualLeaveRequest.objects.create(
                    employee=emp,
                    date=d,
                    portion=CasualLeaveRequest.PORTION_FULL,
                    reason=f"Given by HR for an absent / leave day: {reason}",
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
                    days=-Decimal(len(dates)),
                    reason=reason,
                    balance_before=before,
                    balance_after=before - len(dates),
                    created_by=actor,
                    kind=CasualLeaveAdjustment.KIND_ASSIGN,
                    dates=[d.isoformat() for d in dates],
                )
            )

    for a, (emp, dates, before) in zip(made, plan):
        word = "day" if len(dates) == 1 else "days"
        listed = ", ".join(d.strftime("%d %b %Y") for d in dates)
        log_action(
            request,
            "create",
            "casual_leave",
            record_id=a.id,
            description=(
                f"Casual Leave {today.year}: {_name(emp)} ({emp.employee_code})'s absent / leave {word} {listed} given "
                f"as Casual Leave, {cl_balance.number(before)} → {cl_balance.number(before - len(dates))} left. "
                f"Reason: {reason}"
            ),
            new_values={"employeeId": emp.id, "dates": [d.isoformat() for d in dates]},
        )
    named = Employee.objects.select_related("department", "branch").in_bulk([a.employee_id for a in made])
    for a in made:
        a.employee = named[a.employee_id]
    return Response(
        {
            "count": len(made),
            "days": sum(len(dates) for _emp, dates, _before in plan),
            "items": [adjustment_json(a) for a in made],
        },
        status=201,
    )
