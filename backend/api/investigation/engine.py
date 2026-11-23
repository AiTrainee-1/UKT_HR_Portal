"""How long each employee has been away from the company (Employees -> Investigation, owner 2026-11-23).

ATTENDED DAY  a day with any punch of the employee, or a worked day that needs no punch: an On-Duty day, or a day HR set by
              hand as worked (an approved attendance edit: present / half day, not a Casual Leave or compensation day).
SPELL         the days since the last attended day, up to YESTERDAY (today may still bring a punch). Someone with no attended
              day at all counts from the join date ("never attended"). Calendar days: Sundays and holidays in between count
              (owner decision 2026-11-23).
NO-DATA DAY   a working day (not a Sunday, not a holiday) on which fewer than 1 in 10 of the active employees of the
              employee's unit punched: the unit's punches did not arrive (device down, connector stopped). It says nothing
              about the employee, so it is not counted as a day away (owner decision: a device outage must never inactivate
              people who came to work). `absent_days` = calendar days of the spell minus its no-data days.
APPROVED LEAVE  approved leave / Casual Leave on the spell's working days (hr_analytics.collect.approved_leave). When EVERY
              working day of the spell is approved leave, the spell is `covered_by_leave`: listed, never auto-inactivated.

15 Days list: 15-29 days away. 30 Days list: 30 or more. The Auto Trigger: MORE than InvestigationSettings.auto_days (30)
days away, not covered by leave, not kept active for this spell, and not "never attended" (with no attendance ever recorded
the system cannot tell an absent employee from one whose punches arrive under another code: listed only).

Read-only: nothing here writes anything (the day records it reads are the stored ones; it never recomputes a day).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from types import SimpleNamespace

from django.db.models import Count, Max, Q

from ..clock import ist_today
from ..models import AttendanceDayRecord, AttendanceLog, CasualLeaveRequest, Employee, EmployeeInvestigation, Holiday
from ..reporting.definitions.employees_master_base import join_date_of

LIST_15 = 15
LIST_30 = 30
GAP_SHARE = 10  # a unit day with punches from fewer than 1 in GAP_SHARE of its active employees is a no-data day
GAP_MIN_HEADCOUNT = 5  # a unit this small is never judged (one person away would look like an outage)
LOOKBACK_DAYS = 400  # older days are counted without the no-data check (never more than one query's worth)
ONE = timedelta(days=1)


@dataclass
class Spell:
    employee_id: int
    last_attended: date | None
    start: date | None  # the first day away (None: nothing to measure)
    end: date  # yesterday
    calendar_days: int = 0
    absent_days: int = 0
    gap_days: list[date] = field(default_factory=list)
    working_days: int = 0  # not a Sunday, holiday or no-data day
    leave_days: float = 0.0  # approved leave on those working days (a half day counts 0.5)
    covered_by_leave: bool = False
    never_attended: bool = False

    @property
    def bucket(self) -> str | None:
        if self.absent_days >= LIST_30:
            return "30"
        if self.absent_days >= LIST_15:
            return "15"
        return None


def _days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += ONE


def _last_attended(ids: list[int], yesterday: date) -> dict[int, date]:
    """employee id -> the last day (up to yesterday) they attended: a punch, an On-Duty day or a worked day HR set by hand."""
    out: dict[int, date] = dict(
        AttendanceLog.objects.filter(employee_id__in=ids, date__lte=yesterday)
        .values("employee_id")
        .annotate(last=Max("date"))
        .values_list("employee_id", "last")
    )
    since = yesterday - timedelta(days=LOOKBACK_DAYS)
    worked = list(
        AttendanceDayRecord.objects.filter(
            employee_id__in=ids,
            date__range=(since, yesterday),
            status__in=("present", "half_shift"),
            shifts_earned__gt=0,
        )
        .filter(Q(primary_source="On-Duty") | Q(source="manual", compensation_kind=""))
        .values_list("employee_id", "date")
    )
    if worked:
        cl_days = set(
            CasualLeaveRequest.objects.filter(
                employee_id__in={e for e, _d in worked}, status="approved", date__range=(since, yesterday)
            ).values_list("employee_id", "date")
        )
        for emp_id, day in worked:
            if (emp_id, day) in cl_days:
                continue  # a Casual Leave day is paid, not attended
            if day > out.get(emp_id, date.min):
                out[emp_id] = day
    return out


def _holidays(start: date, end: date) -> set[date]:
    return set(Holiday.objects.filter(date__range=(start, end)).values_list("date", flat=True))


def _gap_days(branch_ids: set, start: date, end: date, holidays: set[date]) -> dict:
    """branch id -> the no-data days of [start, end] (only working days are judged)."""
    if start > end:
        return {}
    headcount = dict(
        Employee.objects.filter(status="active", branch_id__in=branch_ids)
        .values("branch_id")
        .annotate(n=Count("id"))
        .values_list("branch_id", "n")
    )
    if None in branch_ids:
        headcount[None] = Employee.objects.filter(status="active", branch_id__isnull=True).count()
    punched: dict = defaultdict(dict)
    for branch_id, day, n in (
        AttendanceLog.objects.filter(date__range=(start, end), employee__status="active")
        .values("employee__branch_id", "date")
        .annotate(n=Count("employee_id", distinct=True))
        .values_list("employee__branch_id", "date", "n")
    ):
        punched[branch_id][day] = n
    out: dict = {}
    for branch_id in branch_ids:
        size = headcount.get(branch_id, 0)
        if size < GAP_MIN_HEADCOUNT:
            out[branch_id] = set()
            continue
        days = punched.get(branch_id, {})
        out[branch_id] = {
            d for d in _days(start, end) if d.weekday() != 6 and d not in holidays and days.get(d, 0) * GAP_SHARE < size
        }
    return out


def join_of(emp, today: date) -> date | None:
    """The joining date, read as every report reads it: a spreadsheet serial left by an old import ('01-01-45640') is the
    date it stands for; junk, or a date after today, is no joining date at all."""
    joined, _state = join_date_of(emp, decode_serial=True)
    return joined if joined is not None and joined <= today else None


def spells(emps, today: date | None = None, with_leave: bool = True) -> dict[int, Spell]:
    """employee id -> their current absence spell, for `emps` (Employee objects with branch_id / join_date). A fixed
    number of queries for the whole list."""
    today = today or ist_today()
    yesterday = today - ONE
    emps = list(emps)
    ids = [e.id for e in emps]
    if not ids:
        return {}
    last = _last_attended(ids, yesterday)
    starts: dict[int, tuple[date | None, bool]] = {}
    for e in emps:
        attended = last.get(e.id)
        joined = join_of(e, today)
        if attended is not None:
            start = attended + ONE
            if joined is not None and joined > start:
                start = joined  # rejoined after their last attendance: the absence counts from the new join date
            starts[e.id] = (start, False)
        elif joined is not None:
            starts[e.id] = (joined, True)
        else:
            starts[e.id] = (None, True)
    measured = [s for s, _n in starts.values() if s is not None and s <= yesterday]
    window_start = max(min(measured), yesterday - timedelta(days=LOOKBACK_DAYS)) if measured else yesterday
    holidays = _holidays(window_start, yesterday)
    gaps = _gap_days({e.branch_id for e in emps}, window_start, yesterday, holidays) if measured else {}

    out: dict[int, Spell] = {}
    for e in emps:
        start, never = starts[e.id]
        spell = Spell(e.id, last.get(e.id), start, yesterday, never_attended=never)
        if start is not None and start <= yesterday:
            spell.calendar_days = (yesterday - start).days + 1
            unit_gaps = gaps.get(e.branch_id, set())
            spell.gap_days = sorted(d for d in unit_gaps if start <= d <= yesterday)
            spell.absent_days = spell.calendar_days - len(spell.gap_days)
        out[e.id] = spell

    if with_leave:
        listed = [e for e in emps if out[e.id].bucket is not None]
        _add_leave(out, listed, holidays, gaps, yesterday)
    return out


def _add_leave(out: dict[int, Spell], emps, holidays: set[date], gaps: dict, yesterday: date) -> None:
    from ..hr_analytics.collect import approved_leave

    if not emps:
        return
    first = min(out[e.id].start for e in emps)
    leave, _records = approved_leave(SimpleNamespace(start=first, end=yesterday), [e.id for e in emps])
    for e in emps:
        spell = out[e.id]
        unit_gaps = gaps.get(e.branch_id, set())
        working = [
            d for d in _days(spell.start, yesterday) if d.weekday() != 6 and d not in holidays and d not in unit_gaps
        ]
        mine = leave.get(e.id, {})
        spell.working_days = len(working)
        spell.leave_days = sum(mine.get(d, 0) for d in working)
        spell.covered_by_leave = bool(working) and all(mine.get(d, 0) >= 1 for d in working)


def decisions(employee_ids) -> dict[int, EmployeeInvestigation]:
    """employee id -> their latest Investigation decision."""
    out: dict[int, EmployeeInvestigation] = {}
    for d in EmployeeInvestigation.objects.filter(employee_id__in=list(employee_ids)).order_by("-at", "-id"):
        out.setdefault(d.employee_id, d)
    return out


def kept_for_spell(decision: EmployeeInvestigation | None, spell: Spell) -> bool:
    """Does a Keep active (or a Make active again, which keeps them active) hold for this absence?"""
    return (
        decision is not None
        and decision.action in (EmployeeInvestigation.ACTION_KEPT, EmployeeInvestigation.ACTION_REACTIVATED)
        and spell.start is not None
        and decision.spell_start == spell.start
    )


def auto_due(spell: Spell, decision: EmployeeInvestigation | None, days: int) -> tuple[bool, str | None]:
    """(will the Auto Trigger inactivate this active employee, why not)."""
    if spell.absent_days <= days:
        return False, f"Away {spell.absent_days} days: the Auto Trigger acts after more than {days}."
    if spell.never_attended:
        return False, "No attendance ever recorded: listed for HR to check, never inactivated automatically."
    if spell.covered_by_leave:
        return False, "Every working day away is approved leave: listed, never inactivated automatically."
    if kept_for_spell(decision, spell):
        return False, f"Kept active by {decision.by}: {decision.reason}"
    return True, None
