"""
"My Insights" on the mobile Home page (owner 2026-11-25): the signed-in employee's own attendance, punctuality, early
outs, leave / permission / Casual Leave usage, On-Duty days, overtime and pay, month by month for the last N months.
READ-ONLY: nothing here recomputes a day, a payroll or writes a row.

Where every figure comes from (all of it already stored by the rest of the system):

  * attendance_day_records - the FINAL per-day verdict (attendance_final.compute_day_record): present / half day /
    absent / on leave / holiday (a staff Sunday is stored as a holiday), Late-In (is_late), Early-Out (early_leave or
    penalty_early_out, with early_out_minutes), the first punch, and the OT minutes past the shift end
    (ot_extra_minutes). The current month is worked out again every time Home opens (dashboard employee-summary) and a
    background pass keeps recent days in step with late punches (attendance_refresh.py); an older month was worked out
    when its payroll was generated. A day with no stored row is simply not counted.
  * employee_shift_assignments - the shift start of each day (a per-employee custom start wins), for "average arrival
    vs shift start".
  * employee_permissions (approved), casual_leave_requests (approved; a half day = 0.5) - counted up to the end of the
    current month, because an approved one later this month already uses this month's allowance.
  * on_duty_sessions (any not rejected: the employee works from the moment it is sent) - one day per India calendar
    date a session was opened.
  * salary_slips (+ the Payroll row HR may have changed) - earned gross, the attendance loss, net pay and OT pay exactly
    as the Salary page shows them (mobile_pay.period_json), summed per calendar month (a weekly production slip belongs
    to its slip month).

Rules for the counts (the app turns them into the score and the sentences, src/lib/myInsights.ts):
  * working days = recorded days - holidays;  attended = present + 0.5 x half days.
  * TODAY counts only once it is more than "absent": before the first punch the day is still running.
  * days before the employee's join date are left out.
  * an arrival = a present / half day with a first punch; on time = not Late-In. The average arrival leaves out a
    second-half arrival and anything more than 4 hours from the shift start (a punch that is not an arrival).

A fixed handful of queries whatever N is: the day records, the shift assignments, the permissions, the Casual Leave,
the On-Duty sessions, the slips and their payrolls.

Endpoint (mobile_analytics_views.py): GET /api/my/analytics?months=6
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.db.models import Q

from .clock import FACTORY_TZ
from .mobile_pay import _key as _slip_payroll_key
from .mobile_pay import payrolls_by_key, period_json
from .models import (
    AttendanceDayRecord,
    CasualLeaveRequest,
    EmployeePermission,
    EmployeeShiftAssignment,
    OnDutySession,
    SalarySlip,
)
from .payroll_insights import MONTH_ABBR, MONTH_NAMES, dec, money

DEFAULT_MONTHS = 6
MAX_MONTHS = 12

# An arrival further than this from the day's shift start is not a normal arrival (a second-half start, a stray punch):
# it stays an arrival for on time / late, but is left out of the average.
ARRIVAL_AVERAGE_WINDOW_MIN = 240


def month_window(today: date, months: int) -> list[tuple[int, int]]:
    """The `months` calendar months ending with today's, oldest first: [(2026, 6), ..., (2026, 11)]."""
    y, m = today.year, today.month
    out: list[tuple[int, int]] = []
    for _ in range(months):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    out.reverse()
    return out


def _month_end(y: int, m: int) -> date:
    first_next = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return first_next - timedelta(days=1)


def _minutes(t: time | None) -> int | None:
    return None if t is None else t.hour * 60 + t.minute


def _hhmm(minutes: float) -> str:
    total = int(round(minutes)) % 1440
    return f"{total // 60:02d}:{total % 60:02d}"


def _join_date(emp) -> date | None:
    raw = str(getattr(emp, "join_date", "") or "")[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


class _Shifts:
    """The employee's shift assignments over the window: which shift (and start) applies on a day."""

    def __init__(self, employee_id: int, start: date, end: date):
        self.rows = list(
            EmployeeShiftAssignment.objects.filter(employee_id=employee_id, effective_from__lte=end)
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=start))
            .select_related("shift")
            .order_by("effective_from", "id")
        )

    def on(self, d: date):
        """The assignment in force on `d` (the latest one that started), or None."""
        found = None
        for a in self.rows:
            if a.effective_from <= d and (a.effective_to is None or a.effective_to >= d):
                found = a
        return found

    def start_minutes(self, d: date) -> int | None:
        a = self.on(d)
        if a is None:
            return None
        return _minutes(a.custom_start_time or a.shift.start_time)

    def current_json(self, d: date) -> dict | None:
        a = self.on(d)
        if a is None:
            return None
        start = a.custom_start_time or a.shift.start_time
        end = a.custom_end_time or a.shift.end_time
        return {
            "name": a.shift.name,
            "start": start.strftime("%H:%M") if start else None,
            "end": end.strftime("%H:%M") if end else None,
            "graceMinutes": a.shift.grace_period_minutes,
        }


def _blank_month(y: int, m: int, today: date) -> dict:
    return {
        "year": y,
        "month": m,
        "label": f"{MONTH_NAMES[m - 1]} {y}",
        "shortLabel": MONTH_ABBR[m - 1],
        "current": (y, m) == (today.year, today.month),
        "days": {"recorded": 0, "working": 0, "present": 0, "half": 0, "absent": 0, "leave": 0.0, "holidays": 0},
        "punctuality": {"arrivals": 0, "onTime": 0, "late": 0, "avgArrival": None, "avgArrivalDelta": None},
        "earlyOut": {"days": 0, "minutes": 0},
        "overtimeMinutes": 0,
        "onDutyDays": 0,
        "permissions": 0,
        "casualLeave": 0.0,
        "salary": None,
    }


def _count_days(emp, out: dict, start: date, today: date) -> _Shifts:
    """Fold the stored day records of [start, today] into the months of `out`; returns the shift assignments read."""
    shifts = _Shifts(emp.id, start, today)
    joined = _join_date(emp)
    arrivals: dict = defaultdict(list)  # (y, m) -> [arrival minutes]
    deltas: dict = defaultdict(list)  # (y, m) -> [minutes after the shift start]
    leave: dict = defaultdict(Decimal)

    rows = AttendanceDayRecord.objects.filter(employee_id=emp.id, date__gte=start, date__lte=today).values(
        "date", "status", "is_late", "is_half_shift", "is_half_day_leave", "early_leave", "penalty_early_out",
        "early_out_minutes", "ot_extra_minutes", "first_punch", "arrival_zone",
    )
    for r in rows:
        d = r["date"]
        if joined is not None and d < joined:
            continue
        status = r["status"]
        if d == today and status == AttendanceDayRecord.STATUS_ABSENT:
            continue  # today is still running: it counts once the employee punches
        key = (d.year, d.month)
        month = out.get(key)
        if month is None:
            continue
        days = month["days"]
        days["recorded"] += 1
        half = status == AttendanceDayRecord.STATUS_HALF or (
            status == AttendanceDayRecord.STATUS_PRESENT and r["is_half_shift"]
        )
        if status == AttendanceDayRecord.STATUS_HOLIDAY:
            days["holidays"] += 1
        elif half:
            days["half"] += 1
        elif status == AttendanceDayRecord.STATUS_PRESENT:
            days["present"] += 1
        elif status == AttendanceDayRecord.STATUS_LEAVE:
            leave[key] += Decimal("1")
        else:
            days["absent"] += 1
        if r["is_half_day_leave"] and status != AttendanceDayRecord.STATUS_LEAVE:
            leave[key] += Decimal("0.5")

        first = _minutes(r["first_punch"])
        if first is not None and (half or status == AttendanceDayRecord.STATUS_PRESENT):
            p = month["punctuality"]
            p["arrivals"] += 1
            if r["is_late"]:
                p["late"] += 1
            else:
                p["onTime"] += 1
            if r["arrival_zone"] != "second_half":
                shift_start = shifts.start_minutes(d)
                if shift_start is None:
                    arrivals[key].append(first)
                else:
                    delta = first - shift_start
                    if delta > 720:
                        delta -= 1440
                    elif delta < -720:
                        delta += 1440
                    if abs(delta) <= ARRIVAL_AVERAGE_WINDOW_MIN:
                        deltas[key].append(delta)
                        arrivals[key].append(shift_start + delta)

        if r["early_leave"] or r["penalty_early_out"]:
            month["earlyOut"]["days"] += 1
            month["earlyOut"]["minutes"] += int(r["early_out_minutes"] or 0)
        month["overtimeMinutes"] += int(r["ot_extra_minutes"] or 0)

    for key, month in out.items():
        days = month["days"]
        days["working"] = days["recorded"] - days["holidays"]
        days["leave"] = float(leave[key])
        if arrivals[key]:
            month["punctuality"]["avgArrival"] = _hhmm(sum(arrivals[key]) / len(arrivals[key]))
        if deltas[key]:
            month["punctuality"]["avgArrivalDelta"] = round(sum(deltas[key]) / len(deltas[key]), 1)
    return shifts


def _count_requests(emp, out: dict, start: date, month_end: date, today: date) -> None:
    """Approved permissions and Casual Leave (to the end of this month), and On-Duty days (to today)."""
    for d in EmployeePermission.objects.filter(
        employee_id=emp.id, status=EmployeePermission.STATUS_APPROVED, date__gte=start, date__lte=month_end
    ).values_list("date", flat=True):
        month = out.get((d.year, d.month))
        if month is not None:
            month["permissions"] += 1

    cl: dict = defaultdict(Decimal)
    for d, portion in CasualLeaveRequest.objects.filter(
        employee_id=emp.id, status=CasualLeaveRequest.STATUS_APPROVED, date__gte=start, date__lte=month_end
    ).values_list("date", "portion"):
        cl[(d.year, d.month)] += Decimal("1") if portion == CasualLeaveRequest.PORTION_FULL else Decimal("0.5")
    for key, value in cl.items():
        if key in out:
            out[key]["casualLeave"] = float(value)

    since = datetime.combine(start, time.min).replace(tzinfo=FACTORY_TZ)
    until = datetime.combine(today + timedelta(days=1), time.min).replace(tzinfo=FACTORY_TZ)
    on_duty: dict = defaultdict(set)
    for created in (
        OnDutySession.objects.filter(employee_id=emp.id, created_at__gte=since, created_at__lt=until)
        .exclude(status=OnDutySession.STATUS_REJECTED)
        .values_list("created_at", flat=True)
    ):
        d = created.astimezone(FACTORY_TZ).date()
        on_duty[(d.year, d.month)].add(d)
    for key, dates in on_duty.items():
        if key in out:
            out[key]["onDutyDays"] = len(dates)


def _count_pay(emp, out: dict, window: list[tuple[int, int]]) -> None:
    """Each month's slips: earned gross, attendance loss, net pay, OT pay (the Salary page's own figures)."""
    q = Q()
    for y, m in window:
        q |= Q(year=y, month=m)
    slips = list(SalarySlip.objects.filter(employee_id=emp.id).filter(q))
    for s in slips:
        s.employee = emp  # kind_of_slip reads the employment type: no second query (and no photo blob)
    payrolls = payrolls_by_key(emp.id, slips)
    sums: dict = {}
    for s in slips:
        p = period_json(s, payrolls.get(_slip_payroll_key(s)))
        acc = sums.setdefault(
            (s.year, s.month),
            {"earned": Decimal("0"), "lost": None, "net": Decimal("0"), "allocated": None, "otPay": Decimal("0"), "slips": 0},
        )
        acc["earned"] += dec(p["earnedGross"])
        acc["net"] += dec(p["netPayable"])
        acc["otPay"] += dec(p["otPay"])
        acc["slips"] += 1
        if p["attendanceLoss"] is not None:
            acc["lost"] = (acc["lost"] or Decimal("0")) + dec(p["attendanceLoss"])
        if p["allocated"] is not None:
            acc["allocated"] = (acc["allocated"] or Decimal("0")) + dec(p["allocated"])
    for key, acc in sums.items():
        if key in out:
            out[key]["salary"] = {
                "earned": money(acc["earned"]),
                "lost": None if acc["lost"] is None else money(acc["lost"]),
                "net": money(acc["net"]),
                "allocated": None if acc["allocated"] is None else money(acc["allocated"]),
                "otPay": money(acc["otPay"]),
                "slips": acc["slips"],
            }


def analytics_for(emp, months: int, today: date) -> dict:
    """GET /my/analytics: the last `months` calendar months of the employee's own figures, oldest first."""
    window = month_window(today, months)
    start = date(window[0][0], window[0][1], 1)
    month_end = _month_end(today.year, today.month)
    out = {(y, m): _blank_month(y, m, today) for y, m in window}
    shifts = _count_days(emp, out, start, today)
    _count_requests(emp, out, start, month_end, today)
    _count_pay(emp, out, window)
    return {
        "employmentType": emp.employment_type,
        "today": today.isoformat(),
        "months": months,
        "shift": shifts.current_json(today),
        "periods": [out[k] for k in window],
    }
