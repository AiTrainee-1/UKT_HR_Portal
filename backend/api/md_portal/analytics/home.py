"""MD portal: the Dashboard below the welcome card (owner 2026-11-13). "How many people do we have, who is here today, and
what did we pay?" in one read-only answer for ``GET /api/md/dashboard/home``:

* employees   active employees: the total, staff, production, and both per unit;
* attendance  today, per staff / production and per unit: Present (punched in), CL (approved Casual Leave, not punched),
              Absent (everybody else who was due today, the people on approved leave INCLUDED, as the owner asked);
              plus the same three counts for each of the last 14 days, so the page can draw the trend;
* payroll     month by month for the last 6 calendar months (current month included, still running), with the staff /
              production split and each month's payment state (payroll.months_by_type).

Today is counted the way the Staff / Production Attendance pages count it while the day runs: from the punch log (the
stored day records of a running day are not complete). Who was due a day is payroll's own calendar (Schedule: staff per
their working days, production every day but holidays and Sundays). A joining date that is not a real date (an Excel
serial number left by an old import, e.g. "01-01-45640") does not hide anybody: it reads as "no joining date", where the
other MD pages would read it as a year far in the future and leave the person out.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, timedelta

from django.db.models import Count

from ...clock import ist_now, ist_today
from ...models import AttendanceLog, CasualLeaveRequest, Employee, LeaveRequest
from ...reporting.definitions.attendance_analysis_common import Roster
from ...reporting.definitions.requests_leave_common import leave_overlap_q, parse_leave_range
from ...reporting.formatting import parse_date
from ..common import Scope, TtlCache, cache_seconds, envelope, pct, prov
from .attendance import LIVE_PUNCH_FROM, UNASSIGNED_UNIT, Person, Schedule, _RosterCtx, load_people
from .payroll import months_by_type

TREND_DAYS = 14
PAYROLL_MONTHS = 6
NO_UNIT = UNASSIGNED_UNIT
TYPES = ("staff", "production")

# A joining date the import kept as text: only these two shapes are real dates.
_REAL_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})$")

_cache = TtlCache(maxsize=16)


def _joined(text) -> date | None:
    """The joining date when it is a real one; None for anything else (blank, or "01-01-45640")."""
    value = str(text or "").strip()
    return parse_date(value) if _REAL_DATE.match(value) else None


def _type(p: Person) -> str:
    return "production" if p.employment_type == "production" else "staff"


def _unit(p: Person) -> tuple[int | None, str]:
    return p.branch_id, (p.unit or NO_UNIT)


def _counts() -> dict:
    return {"expected": 0, "present": 0, "absent": 0, "onLeave": 0, "cl": 0}


def _finish(c: dict) -> dict:
    """A count block with its shares of the people who were due."""
    return {
        **c,
        "presentPct": pct(c["present"], c["expected"]),
        "absentPct": pct(c["absent"], c["expected"]),
        "clPct": pct(c["cl"], c["expected"]),
    }


# ─── employees ────────────────────────────────────────────────────────────────────────────────────────────────────


GENDER_KEYS = ("male", "female", "other")


def _genders() -> dict:
    """Active employees by gender, for staff, production and everyone (owner 2026-11-13). A blank or unknown value is
    "notRecorded". One query."""
    out = {t: {"male": 0, "female": 0, "other": 0, "notRecorded": 0} for t in (*TYPES, "all")}
    rows = (
        Employee.objects.filter(status="active").values("employment_type", "gender").annotate(n=Count("id")).order_by()
    )
    for row in rows:
        kind = "production" if row["employment_type"] == "production" else "staff"
        gender = str(row["gender"] or "").strip().lower()
        key = gender if gender in GENDER_KEYS else "notRecorded"
        out[kind][key] += row["n"]
        out["all"][key] += row["n"]
    for block in out.values():
        block["total"] = sum(block[k] for k in (*GENDER_KEYS, "notRecorded"))
    return out


def _employees(people: dict[int, Person]) -> dict:
    units: dict[tuple[int | None, str], dict] = {}
    totals = {"staff": 0, "production": 0}
    for p in people.values():
        kind = _type(p)
        totals[kind] += 1
        key = _unit(p)
        row = units.setdefault(key, {"id": key[0], "name": key[1], "staff": 0, "production": 0})
        row[kind] += 1
    rows = [{**r, "total": r["staff"] + r["production"]} for r in units.values()]
    rows.sort(key=lambda r: (-r["total"], r["name"] == NO_UNIT, r["name"]))
    total = totals["staff"] + totals["production"]
    return {
        "total": total,
        "staff": totals["staff"],
        "production": totals["production"],
        "staffPct": pct(totals["staff"], total),
        "productionPct": pct(totals["production"], total),
        "units": rows,
        "gender": _genders(),
    }


# ─── attendance ───────────────────────────────────────────────────────────────────────────────────────────────────


class _Days:
    """Who was due, who punched, who had CL and who was on approved leave, for every day of a window: four queries."""

    def __init__(self, scope: Scope, people: dict[int, Person], first: date, last: date) -> None:
        self.people = people
        self.first, self.last = first, last
        roster = Roster(_RosterCtx(scope, last), first, last)
        self.schedule = Schedule(roster)
        self.exits = roster.exits
        self.joined = {eid: _joined(p.join_date) for eid, p in people.items()}
        self.punched: dict[date, set[int]] = defaultdict(set)
        for eid, d in (
            AttendanceLog.objects.filter(
                scope.employee_q("employee__"), date__gte=first, date__lte=last, punch_time__gte=LIVE_PUNCH_FROM
            )
            .order_by()
            .values_list("employee_id", "date")
            .distinct()
        ):
            self.punched[d].add(eid)
        self.cl: dict[date, set[int]] = defaultdict(set)
        for eid, d in (
            CasualLeaveRequest.objects.filter(
                scope.employee_q("employee__"), status="approved", date__gte=first, date__lte=last
            )
            .order_by()
            .values_list("employee_id", "date")
        ):
            self.cl[d].add(eid)
        self.leave: dict[date, set[int]] = defaultdict(set)
        for lr in LeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved").filter(
            leave_overlap_q(first, last)
        ):
            span = parse_leave_range(lr)
            if span is None:
                continue
            d = max(span[0], first)
            while d <= min(span[1], last):
                self.leave[d].add(lr.employee_id)
                d += timedelta(days=1)

    def due(self, p: Person, d: date) -> bool:
        joined, left = self.joined.get(p.id), self.exits.get(p.id)
        if (joined and joined > d) or (left and left < d):
            return False
        return self.schedule.is_scheduled(p, d)

    def verdict(self, p: Person, d: date) -> str:
        """present | cl | leave | absent for someone who was due on ``d``. A punch wins (a person on half-day CL who
        worked the other half is in); production has no leave or CL in this system."""
        if p.id in self.punched[d]:
            return "present"
        if _type(p) == "staff":
            if p.id in self.cl[d]:
                return "cl"
            if p.id in self.leave[d]:
                return "leave"
        return "absent"

    @staticmethod
    def add(c: dict, verdict: str) -> None:
        c["expected"] += 1
        if verdict == "present":
            c["present"] += 1
        elif verdict == "cl":
            c["cl"] += 1
        else:
            c["absent"] += 1  # the owner's rule: Absent includes the people on approved leave
            if verdict == "leave":
                c["onLeave"] += 1

    def worked_day_off(self, d: date) -> int:
        return sum(1 for eid in self.punched[d] if eid in self.people and not self.due(self.people[eid], d))


def _attendance(scope: Scope, people: dict[int, Person], today: date) -> dict:
    first = today - timedelta(days=TREND_DAYS - 1)
    days = _Days(scope, people, first, today)

    total, by_type = _counts(), {t: _counts() for t in TYPES}
    units: dict[tuple[int | None, str], dict] = {}
    for p in people.values():
        if not days.due(p, today):
            continue
        verdict = days.verdict(p, today)
        key = _unit(p)
        unit = units.setdefault(key, {"id": key[0], "name": key[1], "staff": _counts(), "production": _counts()})
        for block in (total, by_type[_type(p)], unit[_type(p)]):
            days.add(block, verdict)

    unit_rows = []
    for u in units.values():
        both = {k: u["staff"][k] + u["production"][k] for k in u["staff"]}
        unit_rows.append(
            {
                "id": u["id"],
                "name": u["name"],
                **_finish(both),
                "staff": _finish(u["staff"]),
                "production": _finish(u["production"]),
            }
        )
    unit_rows.sort(key=lambda r: (-r["expected"], r["name"] == NO_UNIT, r["name"]))

    trend = []
    d = first
    while d <= today:
        row = {t: _counts() for t in TYPES}
        for p in people.values():
            if days.due(p, d):
                days.add(row[_type(p)], days.verdict(p, d))
        both = {k: row["staff"][k] + row["production"][k] for k in row["staff"]}
        trend.append(
            {
                "date": d.isoformat(),
                "today": d == today,
                **_finish(both),
                "staff": _finish(row["staff"]),
                "production": _finish(row["production"]),
            }
        )
        d += timedelta(days=1)

    return {
        "date": today.isoformat(),
        "asOf": ist_now().isoformat(timespec="minutes"),
        "provisional": True,
        "isWorkingDay": total["expected"] > 0,
        "workedDayOff": days.worked_day_off(today),
        **_finish(total),
        "staff": _finish(by_type["staff"]),
        "production": _finish(by_type["production"]),
        "units": unit_rows,
        "trend": trend,
    }


# ─── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────


def _build(today: date) -> dict:
    scope = Scope()
    people = {eid: p for eid, p in load_people(scope).items() if p.status == "active"}
    unreal = sum(1 for p in people.values() if str(p.join_date or "").strip() and _joined(p.join_date) is None)
    notes = []
    if unreal:
        notes.append(
            f"{unreal} active employee(s) have a joining date that is not a real date (for example an Excel serial "
            "number from an old import): they are counted here as if they had joined long ago. Correct them on the "
            "Employees page."
        )
    return envelope(
        {
            "today": today.isoformat(),
            "employees": _employees(people),
            "attendance": _attendance(scope, people, today),
            "payroll": {"months": months_by_type(scope, PAYROLL_MONTHS, today=today)},
        },
        scope=scope,
        provenance=[
            prov(
                "home-employees",
                "Employees",
                dataset="Employee records",
                definition="Every ACTIVE employee, as staff or production by their employee record, and by the unit "
                "(branch) on their record; 'No unit' when none is set.",
            ),
            prov(
                "home-attendance",
                "Attendance",
                dataset="The punch log, Casual Leave and Leave requests, and payroll's working-day calendar",
                definition="Of the people due that day (staff on their payroll working days, production every day "
                "except holidays and Sundays, after joining and before leaving): Present = punched in (from 05:00); "
                "CL = approved Casual Leave and no punch; Absent = everybody else, the people on approved leave "
                "INCLUDED. Today is still running, so its Absent means 'not in yet'.",
                formula="Present + CL + Absent = due",
            ),
            prov(
                "home-payroll",
                "Payroll",
                dataset="Generated salary slips",
                definition="Gross = salary earned + overtime; Net = what is paid after deductions; people = distinct "
                "employees with a slip. Production slips belong to the month of their pay period. The current month "
                "is still running: its figures are what has been generated so far.",
                formula="Gross = salary earned + overtime",
            ),
        ],
        notes=notes,
    )


def home(*, today: date | None = None) -> dict:
    """Employees, today's attendance with a 14-day trend, and 6 months of payroll, for the Dashboard."""
    day = today or ist_today()
    return _cache.get_or_compute(("home", day.isoformat()), min(cache_seconds(), 30), lambda: _build(day))
