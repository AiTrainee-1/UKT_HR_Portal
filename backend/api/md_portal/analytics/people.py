"""MD assistant: questions about ONE employee, and lists of the people of one day (owner 2026-11-13).

"What is the attendance status of Ravi Kumar?", "How many leaves has Asha taken this month?", "Show the salary details
of employee code 30020", "Who reported late today in Stitching?". The other analytics answer for groups (a department, a
unit, the company); these four tools answer for people, by NAME or EMPLOYEE CODE, from the stored records:

  employee_attendance        one person's days in a period: status, first in / last out, late, early out, shifts
  employee_leave             one person's leave, Casual Leave and permission requests in a period, with totals
  employee_salary            one person's salary slips: earned, overtime, each deduction, net, days paid, paid or not
  attendance_people_on_date  the people of one day by what happened (late, absent, present, on leave, CL ...), for a
                             department / unit / staff or production

Finding the person (``find_person``): an exact employee code first, then the employee id (what an @emp token becomes when
privacy mode is on), then the name, word by word ("surya m", "Surya"). Several matches come back as a short list for the
MD to choose from; the tools never guess between people.

Read-only like every MD tool: they only READ the stored day records, punches and requests (a day nobody has worked out
yet is described from its punches), and phone numbers, addresses, bank and government ids are never part of the answer.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from django.db.models import Case, IntegerField, Q, Value, When

from ...clock import ist_today
from ...models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    Holiday,
    LeaveRequest,
    Payroll,
    SalarySlip,
)
from ...payroll_month_workflow import employee_sees_paid
from ...reporting.definitions.attendance_analysis_common import Roster
from ...reporting.definitions.requests_leave_common import leave_overlap_q, parse_leave_range
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, envelope, prov
from .attendance import Person, Schedule, _RosterCtx, load_people
from .home import _Days, _joined

MAX_DAYS = 93  # one person's attendance: at most about three months at once
DAY_ROWS = 31  # the days listed (the latest ones); the totals cover the whole period
MAX_MATCHES = 8
LIST_LIMIT = 30
MAX_LIST = 100
MAX_SLIPS = 12

STATUS_LABELS = {
    "present": "Present",
    "half_shift": "Half Day",
    "absent": "Absent",
    "on_leave": "On leave",
    "holiday": "Holiday",
}
DAY_STATUSES = (
    "late",
    "absent",
    "present",
    "on_leave",
    "cl",
    "early_out",
    "penalty_early_out",
    "half_day",
    "quarter_shift",
    "all",
)


# ─── how each answer is made (shown under the assistant's answer) ───────────────────────────────────────────────

P_FIND = prov(
    "people-find",
    "Finding the person",
    dataset="Employee records",
    definition="The employee code first (exactly), then the name word by word; active employees before former ones. "
    "Several matches are listed for the MD to choose from: the tools never guess between people.",
)
P_ATTENDANCE = prov(
    "people-attendance",
    "One employee's attendance",
    dataset="Attendance day records, punches, Casual Leave and leave requests, holidays",
    definition="Each day as the attendance engine stored it (status, first in, last out, Late, Early Out, Penalty Early "
    "Out, shifts earned). A day not worked out yet is described from its punches; a day with no punch and no record is "
    "Casual Leave, leave, a holiday or day off, or Absent, in that order.",
    caveats=["Today is still running: its status can change until the shift ends."],
)
P_LEAVE = prov(
    "people-leave",
    "One employee's leave",
    dataset="Leave requests, Casual Leave requests and permission requests",
    definition="Every request that overlaps the period, with its status. Approved leave days in the period count "
    "Monday to Saturday; a half day is 0.5. Casual Leave is a full day or a half.",
)
P_SALARY = prov(
    "people-salary",
    "One employee's salary",
    dataset="Generated salary slips",
    definition="Each slip's salary earned, overtime, bonus, deductions and net pay as payroll generated it, and whether "
    "the month was marked paid.",
    formula="Gross = salary earned + overtime; net = gross - deductions",
)
P_DAY = prov(
    "people-day",
    "The people of one day",
    dataset="The punch log, attendance day records, Casual Leave and leave requests, payroll's working-day calendar",
    definition="Of the people due that day: present = punched in (from 05:00); CL = approved Casual Leave and no punch; "
    "on leave = approved leave and no punch; absent = everybody else. Late, Early Out, Penalty Early Out, half day and "
    "quarter shift come from the stored day record; minutes late = first punch - (shift start + grace).",
    caveats=["Today is still running: absent means not in yet."],
)


# ─── finding the person ─────────────────────────────────────────────────────────────────────────────────────────


def _normal(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[.\-_]", " ", text or "")).strip().lower()


def _full_name(e: Employee) -> str:
    return f"{e.first_name or ''} {e.last_name or ''}".strip() or (e.employee_code or f"#{e.pk}")


def person_card(e: Employee) -> dict:
    """Who the person is, as every answer starts: name, code, designation, department, unit, staff / production."""
    return {
        "employeeId": e.pk,
        "name": _full_name(e),
        "code": e.employee_code,
        "designation": e.designation.title if e.designation_id else None,
        "department": e.department.name if e.department_id else None,
        "unit": e.branch.name if e.branch_id else None,
        "type": "production" if e.employment_type == "production" else "staff",
        "status": e.status,
        "joinDate": e.join_date if _joined(e.join_date) else None,
    }


def find_person(employee: str | None) -> tuple[Employee | None, list[Employee]]:
    """(the one employee meant, or None with the candidates). Exact code, then id, then the name word by word; active
    people before inactive ones; an exact full-name match wins over partial ones."""
    text = str(employee or "").strip()
    if not text:
        raise MdParamError("'employee' is required: the employee's name or employee code.")
    people = Employee.objects.select_related("department", "branch", "designation")
    hit = people.filter(employee_code__iexact=text).first()
    if hit:
        return hit, []
    if text.isdigit():
        hit = people.filter(pk=int(text)).first()  # an @emp token the server turned into the employee's id
        if hit:
            return hit, []
    words = [w for w in re.split(r"[\s,]+", text.replace(".", " ")) if w]
    q = Q()
    for word in words:
        q &= Q(first_name__icontains=word) | Q(last_name__icontains=word) | Q(employee_code__iexact=word)
    ranked = people.filter(q).order_by(
        Case(When(status="active", then=Value(0)), default=Value(1), output_field=IntegerField()),
        "first_name",
        "last_name",
    )
    matches = list(ranked[: MAX_MATCHES + 1])
    exact = [e for e in matches if _normal(_full_name(e)) == _normal(text)]
    if len(exact) == 1:
        return exact[0], []
    active = [e for e in matches if e.status == "active"]
    if len(matches) == 1:
        return matches[0], []
    if len(active) == 1 and len(matches) > 1 and all(_normal(text) in _normal(_full_name(e)) for e in active):
        return active[0], []
    return None, matches[:MAX_MATCHES]


def _not_one(employee: str, candidates: list[Employee]) -> dict:
    """The answer when the name does not point at exactly one person."""
    if not candidates:
        return envelope(
            {
                "found": False,
                "matches": [],
                "note": f"No employee matches '{employee}' by employee code or name. Check the code or the spelling.",
            },
            provenance=[P_FIND],
        )
    return envelope(
        {
            "found": False,
            "matches": [person_card(e) for e in candidates],
            "note": f"{len(candidates)} employees match '{employee}'. Ask the MD which one is meant (by code), then "
            "call again with that code.",
        },
        provenance=[P_FIND],
    )


def _period_days(period: Period, e: Employee, today: date) -> tuple[date, date]:
    start = period.start
    joined = _joined(e.join_date)
    if joined and joined > start:
        start = joined
    end = min(period.end, today)
    if (end - start).days + 1 > MAX_DAYS:
        start = end - timedelta(days=MAX_DAYS - 1)
    return start, end


def _as_person(e: Employee) -> Person:
    return Person(
        id=e.pk,
        code=e.employee_code or "",
        name=_full_name(e),
        employment_type=e.employment_type or "staff",
        status=e.status or "",
        join_date=e.join_date,
        dept_id=e.department_id,
        dept=e.department.name if e.department_id else "",
        branch_id=e.branch_id,
        unit=e.branch.name if e.branch_id else "",
    )


def _hm(t) -> str | None:
    return t.strftime("%H:%M") if t else None


# ─── one person's attendance ────────────────────────────────────────────────────────────────────────────────────


def employee_attendance(*, period: Period, employee: str) -> dict:
    e, candidates = find_person(employee)
    if e is None:
        return _not_one(employee, candidates)
    today = ist_today()
    start, end = _period_days(period, e, today)
    if end < start:
        return envelope(
            {"found": True, "employee": person_card(e), "days": [], "note": "The period is before this person joined."},
            provenance=[P_ATTENDANCE],
        )
    person = _as_person(e)
    schedule = Schedule(Roster(_RosterCtx(Scope(), end), start, end))
    exit_on = schedule.roster.exits.get(e.pk)
    on_leave: set[date] = set()
    for lr in LeaveRequest.objects.filter(employee=e, status="approved").filter(leave_overlap_q(start, end)):
        span = parse_leave_range(lr)
        if span is not None:
            day = max(span[0], start)
            while day <= min(span[1], end):
                on_leave.add(day)
                day += timedelta(days=1)
    records = {r.date: r for r in AttendanceDayRecord.objects.filter(employee=e, date__gte=start, date__lte=end)}
    punches: dict[date, list] = defaultdict(list)
    for d, t in AttendanceLog.objects.filter(employee=e, date__gte=start, date__lte=end).values_list(
        "date", "punch_time"
    ):
        punches[d].append(t)
    cl = dict(
        CasualLeaveRequest.objects.filter(employee=e, status="approved", date__gte=start, date__lte=end).values_list(
            "date", "portion"
        )
    )
    holidays = dict(Holiday.objects.filter(date__gte=start, date__lte=end).values_list("date", "name"))

    totals = defaultdict(float)
    rows = []
    d = start
    while d <= end:
        rec = records.get(d)
        times = sorted(punches.get(d, []))
        due = (exit_on is None or d <= exit_on) and schedule.is_scheduled(person, d)
        row: dict = {"date": d.isoformat(), "day": d.strftime("%a")}
        if d == today:
            row["today"] = True
        if rec is not None:
            status = STATUS_LABELS.get(rec.status, rec.status)
            row.update(
                status=status,
                firstIn=_hm(rec.first_punch),
                lastOut=_hm(rec.last_punch),
                shifts=float(rec.shifts_earned or 0),
                late=bool(rec.is_late),
                earlyOut=bool(rec.early_leave),
                penaltyEarlyOut=bool(getattr(rec, "penalty_early_out", False)),
                quarterShift=rec.arrival_zone == "quarter",
                setByHr=rec.source == "manual",
                note=rec.late_reason or rec.compensation_note or None,
            )
            totals["shiftsEarned"] += float(rec.shifts_earned or 0)
            for flag, key in (
                ("late", "late"),
                ("earlyOut", "earlyOut"),
                ("penaltyEarlyOut", "penaltyEarlyOut"),
                ("quarterShift", "quarterShift"),
            ):
                if row[flag]:
                    totals[key] += 1
            kind = {"present": "present", "half_shift": "halfDay", "absent": "absent", "on_leave": "onLeave"}.get(
                rec.status, "holidayOrOff"
            )
        elif times:
            row.update(
                status="Punched (not worked out yet)",
                firstIn=_hm(times[0]),
                lastOut=_hm(times[-1]) if len(times) > 1 else None,
            )
            kind = "present"
        elif d in cl:
            row.update(status=f"Casual Leave ({cl[d].replace('_', ' ')})")
            kind = "cl"
        elif d in on_leave:
            row.update(status="On leave")
            kind = "onLeave"
        elif d in holidays:
            row.update(status=f"Holiday ({holidays[d]})")
            kind = "holidayOrOff"
        elif not due:
            row.update(status="Day off")
            kind = "holidayOrOff"
        else:
            row.update(status="Not in yet" if d == today else "Absent")
            kind = "absent"
        if d in cl and rec is not None:
            row["casualLeave"] = cl[d].replace("_", " ")
            if not times:
                kind = "cl"
        totals[kind] += 1
        if due:
            totals["daysDue"] += 1
        rows.append(row)
        d += timedelta(days=1)

    summary = {
        k: (round(v, 2) if k == "shiftsEarned" else int(v))
        for k, v in totals.items()
        if k
        in (
            "daysDue",
            "present",
            "halfDay",
            "absent",
            "onLeave",
            "cl",
            "holidayOrOff",
            "late",
            "earlyOut",
            "penaltyEarlyOut",
            "quarterShift",
            "shiftsEarned",
        )
    }
    notes = []
    if len(rows) > DAY_ROWS:
        notes.append(f"The totals cover all {len(rows)} days; only the latest {DAY_ROWS} days are listed.")
    if end == today:
        notes.append("Today is still running: its status can change until the shift ends.")
    return envelope(
        {
            "found": True,
            "employee": person_card(e),
            "from": start.isoformat(),
            "to": end.isoformat(),
            "summary": summary,
            "days": rows[-DAY_ROWS:],
        },
        period=Period(start, end, period.preset, period.label),
        provenance=[P_FIND, P_ATTENDANCE],
        notes=notes,
    )


# ─── one person's leave ─────────────────────────────────────────────────────────────────────────────────────────


def _permission_label(p: EmployeePermission) -> str:
    slug = EmployeePermission.normalize_type(p.type) if p.type else None
    return EmployeePermission.TYPE_LABELS.get(slug, p.type or "Permission")


def employee_leave(*, period: Period, employee: str) -> dict:
    e, candidates = find_person(employee)
    if e is None:
        return _not_one(employee, candidates)
    lo, hi = period.start, period.end
    leaves = []
    approved_days = 0.0
    for lr in LeaveRequest.objects.filter(employee=e).filter(leave_overlap_q(lo, hi)).order_by("start_date", "id"):
        span = parse_leave_range(lr)
        if span is None or span[1] < lo or span[0] > hi:
            continue
        in_period = 0.0
        if lr.is_half_day:
            in_period = 0.5
        else:
            day = max(span[0], lo)
            while day <= min(span[1], hi):
                if day.weekday() != 6:
                    in_period += 1
                day += timedelta(days=1)
        if lr.status == "approved":
            approved_days += in_period
        leaves.append(
            {
                "type": (lr.type or "leave").replace("_", " ").title(),
                "from": span[0].isoformat(),
                "to": span[1].isoformat(),
                "days": float(lr.total_days or 0),
                "daysInPeriod": in_period,
                "halfDay": (lr.half_day_slot or True) if lr.is_half_day else False,
                "status": lr.status,
                "reason": (lr.reason or "")[:120] or None,
            }
        )
    cls = []
    cl_days = 0.0
    for c in CasualLeaveRequest.objects.filter(employee=e, date__gte=lo, date__lte=hi).order_by("date", "id"):
        size = 1.0 if c.portion == "full" else 0.5
        if c.status == "approved":
            cl_days += size
        cls.append(
            {"date": c.date.isoformat(), "portion": c.portion.replace("_", " "), "days": size, "status": c.status}
        )
    perms = []
    for p in EmployeePermission.objects.filter(employee=e, date__gte=lo, date__lte=hi).order_by("date", "id"):
        perms.append(
            {
                "date": p.date.isoformat(),
                "type": _permission_label(p),
                "time": _hm(p.permission_time),
                "status": p.status,
            }
        )
    count = lambda rows, status: sum(1 for r in rows if r["status"] == status)  # noqa: E731
    return envelope(
        {
            "found": True,
            "employee": person_card(e),
            "summary": {
                "leaveDaysApproved": approved_days,
                "leaveRequests": len(leaves),
                "leavePending": count(leaves, "pending"),
                "leaveRejected": count(leaves, "rejected"),
                "casualLeaveDaysApproved": cl_days,
                "casualLeavePending": count(cls, "pending"),
                "permissionsApproved": count(perms, "approved"),
                "permissionsPending": count(perms, "pending"),
            },
            "leave": leaves,
            "casualLeave": cls,
            "permissions": perms,
        },
        period=period,
        provenance=[P_FIND, P_LEAVE],
        notes=[
            "Leave days in the period count Monday to Saturday (Sundays are skipped, as on the leave request); a half "
            "day is 0.5. Casual Leave is its own request (a full day or a half)."
        ],
    )


# ─── one person's salary ────────────────────────────────────────────────────────────────────────────────────────


def _money(value) -> float:
    return round(float(value or 0), 2)


def employee_salary(*, employee: str, month: str | None = None, months: int = 3) -> dict:
    e, candidates = find_person(employee)
    if e is None:
        return _not_one(employee, candidates)
    slips = SalarySlip.objects.filter(employee=e, week_number__isnull=True).order_by("-year", "-month", "-period_end")
    if month:
        try:
            y, m = (int(x) for x in str(month).split("-")[:2])
            date(y, m, 1)
        except (TypeError, ValueError):
            raise MdParamError(f"'month' must be YYYY-MM, got '{month}'.") from None
        slips = slips.filter(year=y, month=m)
    rows = []
    # paid as the employee apps show it (payroll_month_workflow, 2026-11-10): a staff month once it was marked paid,
    # Cleared alone is only "verified"; a production period when Cleared (it has no payment step)
    paid_rows = {
        (p.year, p.month, p.period_start): employee_sees_paid(p)
        for p in Payroll.objects.filter(employee=e, week_number__isnull=True)
    }
    for s in slips[: max(1, min(int(months or 3), MAX_SLIPS)) if not month else MAX_SLIPS]:
        detail = s.breakdown_details if isinstance(s.breakdown_details, dict) else {}
        summary = detail.get("summary") or {}
        deductions = detail.get("deductions") or {}
        rows.append(
            {
                "month": f"{s.year}-{s.month:02d}",
                "payPeriod": f"{s.period_start.isoformat()} to {s.period_end.isoformat()}" if s.period_start else None,
                "salaryEarned": _money(s.gross_salary),
                "overtime": _money(s.ot_amount),
                "bonusAndIncentives": _money((s.bonuses or 0) + (s.incentives or 0)),
                "grossPay": _money((s.gross_salary or 0) + (s.ot_amount or 0)),
                "deductions": {
                    "pf": _money(s.pf_deduction),
                    "esi": _money(s.esi_deduction),
                    "tds": _money(getattr(s, "tds_deduction", 0)),
                    "advance": _money(s.advance_deduction),
                    "late": _money(deductions.get("lateShiftPenalty")),
                    "permission": _money(deductions.get("permissionPenalty")),
                    "other": _money(s.other_deductions),
                    "total": _money(s.total_deductions),
                },
                "netPay": _money(s.net_salary),
                "workingDays": s.working_days,
                "daysPaidFor": summary.get("effectivePaidDays", float(s.present_days or 0)),
                "absentDays": float(s.absent_days or 0),
                "lateDays": summary.get("lateDays"),
                "penaltyEarlyOutDays": summary.get("penaltyEarlyOutDays"),
                "markedPaid": paid_rows.get((s.year, s.month, s.period_start), False),
            }
        )
    notes = []
    if not rows:
        notes.append("No salary slip has been generated for this person" + (f" for {month}." if month else " yet."))
    return envelope(
        {
            "found": True,
            "employee": person_card(e),
            "monthlySalary": _money(e.salary_amount),
            "slips": rows,
        },
        provenance=[P_FIND, P_SALARY],
        notes=notes
        + [
            "Gross pay = salary earned for the days paid + overtime; net pay = what is paid after deductions. The "
            "monthly salary is the person's current contract amount."
        ],
    )


# ─── the people of one day ──────────────────────────────────────────────────────────────────────────────────────


def _parse_day(value: str | None, today: date) -> date:
    if not value:
        return today
    text = str(value).strip().lower()
    if text in ("today", "now"):
        return today
    if text == "yesterday":
        return today - timedelta(days=1)
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        raise MdParamError(f"'date' must be YYYY-MM-DD, 'today' or 'yesterday', got '{value}'.") from None


def _minutes_late(roster, emp_id: int, d: date, first) -> int | None:
    shift = roster.shift_on(emp_id, d)
    if shift is None or first is None or not getattr(shift, "start_time", None):
        return None
    deadline = datetime.combine(d, shift.start_time) + timedelta(minutes=int(shift.grace_period_minutes or 0))
    late = int((datetime.combine(d, first) - deadline).total_seconds() // 60)
    return late if late > 0 else None


def attendance_people_on_date(
    *, scope: Scope, date: str | None = None, status: str = "late", limit: int = LIST_LIMIT
) -> dict:  # noqa: A002
    today = ist_today()
    day = _parse_day(date, today)
    if day > today:
        raise MdParamError("That date is in the future: attendance is only known up to today.")
    if status not in DAY_STATUSES:
        raise MdParamError(f"'status' must be one of: {', '.join(DAY_STATUSES)}.")
    people = {eid: p for eid, p in load_people(scope).items() if p.status == "active"}
    days = _Days(scope, people, day, day)
    records = {
        r.employee_id: r
        for r in AttendanceDayRecord.objects.filter(
            scope.employee_q("employee__"), date=day, employee_id__in=list(people)
        )
    }
    first_last: dict[int, list] = defaultdict(list)
    for eid, t in AttendanceLog.objects.filter(scope.employee_q("employee__"), date=day).values_list(
        "employee_id", "punch_time"
    ):
        first_last[eid].append(t)
    roster = days.schedule.roster

    counts = defaultdict(int)
    rows = []
    punched_due = worked_out = 0
    for eid, p in people.items():
        if not days.due(p, day):
            continue
        verdict = days.verdict(p, day)
        rec = records.get(eid)
        times = sorted(first_last.get(eid, []))
        tags = {verdict if verdict != "leave" else "on_leave"}
        if verdict == "present":
            punched_due += 1
            if rec is not None:
                worked_out += 1
                if rec.is_late:
                    tags.add("late")
                if rec.early_leave:
                    tags.add("early_out")
                if getattr(rec, "penalty_early_out", False):
                    tags.add("penalty_early_out")
                if rec.status == "half_shift":
                    tags.add("half_day")
                if rec.arrival_zone == "quarter":
                    tags.add("quarter_shift")
        for tag in tags:
            counts[tag] += 1
        if status == "all" or status in tags:
            row = {
                "employeeId": eid,
                "name": p.name,
                "code": p.code,
                "department": p.dept or None,
                "unit": p.unit or None,
                "type": "production" if p.employment_type == "production" else "staff",
                "status": sorted(tags),
                "firstIn": _hm(times[0]) if times else None,
                "lastOut": _hm(times[-1]) if len(times) > 1 else None,
            }
            if "late" in tags:
                row["minutesLate"] = _minutes_late(roster, eid, day, times[0] if times else None)
            rows.append(row)
    rows.sort(key=lambda r: (r["department"] or "", r["name"]))
    limit = max(1, min(int(limit or LIST_LIMIT), MAX_LIST))
    notes = []
    if day == today:
        notes.append(
            "Today is still running: 'absent' means not in yet, and lateness is known once a day is worked out."
        )
    if status in ("late", "early_out", "penalty_early_out", "half_day", "quarter_shift") and worked_out < punched_due:
        notes.append(
            f"Late / early marks are known for {worked_out} of the {punched_due} people who punched in; the rest have "
            "not been worked out yet (the background refresh does it within minutes)."
        )
    if len(rows) > limit:
        notes.append(f"{len(rows)} people match; the first {limit} are listed (by department, then name).")
    return envelope(
        {
            "date": day.isoformat(),
            "status": status,
            "counts": {
                "due": sum(1 for p in people.values() if days.due(p, day)),
                **{k: counts.get(k, 0) for k in DAY_STATUSES if k != "all"},
            },
            "total": len(rows),
            "people": rows[:limit],
        },
        scope=scope,
        provenance=[P_DAY],
        notes=notes,
    )


# ─── what the assistant may ask ─────────────────────────────────────────────────────────────────────────────────

_EMPLOYEE = string_param("The employee's name (or part of it, e.g. 'Surya M') or employee code (e.g. '30020').")

TOOLS = [
    tool(
        "employee_attendance",
        "ONE employee's attendance by name or employee code, day by day for a period (default this month): each day's "
        "status (Present, Half Day, Absent, On leave, Casual Leave, Holiday, Day off), first in and last out, Late, Early "
        "Out, Penalty Early Out, quarter-shift arrival and shifts earned, with totals. Use it for 'what is the attendance "
        "status of <name> today', 'how many days was <code> absent this month', 'was <name> late this week'.",
        employee_attendance,
        page="employees",
        period="this_month",
        scope=False,
        extra={"employee": _EMPLOYEE},
        required=("employee",),
        person_fields=("name",),
        example={"employee": "E1"},
    ),
    tool(
        "employee_leave",
        "ONE employee's leave by name or employee code for a period (default this month): every leave request (type, "
        "dates, days, status), Casual Leave days (full or half) and permissions (type, time, status), with the approved "
        "and pending totals. Use it for 'how many leaves has <name> taken this month', 'did <code> take CL'.",
        employee_leave,
        page="employees",
        period="this_month",
        scope=False,
        extra={"employee": _EMPLOYEE},
        required=("employee",),
        person_fields=("name",),
        example={"employee": "E1"},
    ),
    tool(
        "employee_salary",
        "ONE employee's salary by name or employee code: the monthly salary and the latest salary slips (or one month): "
        "salary earned, overtime, bonus, each deduction (PF, ESI, TDS, advance, late, permission, other), net pay, days "
        "paid for, absent days and whether it was marked paid. Use it for 'show the salary details of employee code "
        "<code>', 'what was <name> paid last month'.",
        employee_salary,
        page="payroll",
        scope=False,
        extra={
            "employee": _EMPLOYEE,
            "month": string_param("One month, YYYY-MM. Omit for the latest slips."),
            "months": integer_param("How many latest slips (default 3, at most 12).", minimum=1, maximum=MAX_SLIPS),
        },
        required=("employee",),
        defaults={"months": 3},
        person_fields=("name",),
        example={"employee": "E1"},
    ),
    tool(
        "attendance_people_on_date",
        "The PEOPLE of one day (default today) by what happened to them: late, absent, present, on_leave, cl, early_out, "
        "penalty_early_out, half_day, quarter_shift or all, optionally for a department, unit or staff / production. "
        "Lists name, code, department, unit, first in, last out and minutes late, with the counts of every status. Use it "
        "for 'who reported late today in <department>', 'who is absent today in <unit>', 'who was on leave yesterday'.",
        attendance_people_on_date,
        page="attendance",
        extra={
            "date": string_param("The day: YYYY-MM-DD, 'today' (default) or 'yesterday'."),
            "status": string_param("Which people to list (default late).", enum=list(DAY_STATUSES)),
            "limit": integer_param(
                f"How many people to list (default {LIST_LIMIT}, at most {MAX_LIST}).", minimum=1, maximum=MAX_LIST
            ),
        },
        defaults={"status": "late", "limit": LIST_LIMIT},
        person_fields=("name",),
        example={"status": "late"},
    ),
]

__all__ = [
    "TOOLS",
    "attendance_people_on_date",
    "employee_attendance",
    "employee_leave",
    "employee_salary",
    "find_person",
]
