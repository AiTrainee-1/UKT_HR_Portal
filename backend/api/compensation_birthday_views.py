"""
Birthday leave (Compensation Leave, part C): who has a birthday in a period and who benefits.

On a staff member's birthday they get PAID compensation leave for that whole day: present, 1.00 shift, no late / early /
half-day / permission detection, whether they attend, stay absent, work half a day, arrive late or leave early. The
attendance engine applies it (and payroll reads the result); this endpoint only LISTS who is affected so HR can see it.

    GET /api/compensation/birthdays?period=today|week|month&date=YYYY-MM-DD

`period` is `today` (default), `week` (Monday to Sunday containing `date`) or `month` (the calendar month); `date` defaults
to today (India). A pure read: nothing is written. Active STAFF only (production is never listed), branch-scoped; an
employee without a date of birth cannot be listed. `departmentId` and `branchId` narrow the list.

A 29 February birthday is celebrated on the 28th in a year that has no 29th. Each row says whether the person BENEFITS:
the master and Birthday switches are on, the day is on or after the feature's effective date (nothing is retroactive) and it
is a working day for them (a Sunday or a declared holiday is a day off already). A row that does not benefit says why. The
day's attendance (`attendanceStatus`, `applied`) comes from the stored day record: `applied` is true once the engine has
marked that day `compensation_kind="birthday"`; before that (a day not computed yet) it is null/false, never guessed.
"""

from __future__ import annotations

from collections import defaultdict

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import (
    PERIODS,
    birthday_employee_problem,
    birthday_verdict,
    birthdays_between,
    employee_json,
    holiday_names,
    master_enabled,
    parse_date,
    parse_int,
    period_bounds,
)
from .models import AttendanceDayRecord, CompensationConfig, Employee, EmployeeShiftAssignment
from .shift_engine import _get_assignment_for_date


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def birthday_rows(request: Request, start, end, department_id=None, branch_id=None) -> list[dict]:
    """The birthdays of active staff in [start, end], each with its verdict and the day's stored attendance. A handful of
    queries whatever the number of employees (people, holidays, day records)."""
    # a period is at most a month, so it touches at most two calendar months (the SQL filter narrows the people read)
    months = {start.month, end.month} if (end - start).days <= 31 else set(range(1, 13))
    qs = scope_to_branch(
        Employee.objects.select_related("department", "designation", "branch").filter(
            employment_type="staff", status="active", date_of_birth__isnull=False, date_of_birth__month__in=months
        ),
        request,
    )
    if department_id is not None:
        qs = qs.filter(department_id=department_id)
    if branch_id is not None:
        qs = qs.filter(branch_id=branch_id)
    people = list(qs)
    if not people:
        return []
    cfg = CompensationConfig.get()
    master = master_enabled()
    holidays = holiday_names(start, end)
    records = {
        (r.employee_id, r.date): r
        for r in AttendanceDayRecord.objects.filter(
            employee_id__in=[e.id for e in people], date__gte=start, date__lte=end
        )
    }
    dated = [(emp, day) for emp in people for day in birthdays_between(emp.date_of_birth, start, end)]
    # a Saturday birthday needs the shift assignment (an off Saturday is already a day off): one query for all of them
    assignments: dict[int, list] = defaultdict(list)
    saturday_ids = {emp.id for emp, day in dated if day.weekday() == 5}
    if saturday_ids:
        for assignment in EmployeeShiftAssignment.objects.filter(employee_id__in=saturday_ids):
            assignments[assignment.employee_id].append(assignment)
    rows = []
    for emp, day in dated:
        benefits, why = birthday_verdict(day, master, cfg, holidays)
        if benefits:
            saturday_off = False
            if day.weekday() == 5:
                assignment = _get_assignment_for_date(emp, day, assignments=assignments[emp.id])
                saturday_off = bool(assignment and assignment.saturday_off)
            why = birthday_employee_problem(emp, day, saturday_off)
            benefits = not why
        record = records.get((emp.id, day))
        rows.append(
            {
                **employee_json(emp),
                "birthday": day.isoformat(),
                "weekday": day.strftime("%A"),
                "benefits": benefits,
                "reason": why or None,
                "attendanceStatus": record.status if record else None,
                "applied": bool(record and record.compensation_kind == "birthday"),
                "compensationKind": (record.compensation_kind or None) if record else None,
                "firstPunch": _hhmm(record.first_punch) if record else None,
                "lastPunch": _hhmm(record.last_punch) if record else None,
                "shiftsEarned": float(record.shifts_earned) if record else None,
            }
        )
    rows.sort(key=lambda r: (r["birthday"], r["employeeName"], r["employeeCode"]))
    return rows


@api_view(["GET"])
@require_hr
def compensation_birthdays(request: Request) -> Response:
    q = request.query_params
    period = (q.get("period") or "today").lower()
    if period not in PERIODS:
        return Response({"error": "period must be today, week or month."}, status=400)
    anchor = ist_today()
    if q.get("date"):
        anchor = parse_date(q.get("date"))
        if anchor is None:
            return Response({"error": "date must be a date (YYYY-MM-DD)."}, status=400)
    for name in ("departmentId", "branchId"):
        if q.get(name) not in (None, "") and parse_int(q.get(name)) is None:
            return Response({"error": f"{name} must be a number."}, status=400)
    start, end = period_bounds(period, anchor)
    rows = birthday_rows(request, start, end, parse_int(q.get("departmentId")), parse_int(q.get("branchId")))
    cfg = CompensationConfig.get()
    master = master_enabled()
    return Response(
        {
            "period": period,
            "date": anchor.isoformat(),
            "from": start.isoformat(),
            "to": end.isoformat(),
            "enabled": {
                "master": master,
                "birthday": master and cfg.birthday_enabled,
                "effectiveFrom": cfg.birthday_effective_from.isoformat() if cfg.birthday_effective_from else None,
            },
            "count": len(rows),
            "benefitCount": sum(1 for r in rows if r["benefits"]),
            "results": rows,
        }
    )
