"""Leave, casual leave and permission requests, and the leave balances.

The requests are PLANNED before attendance is simulated (``plan_leave``), because an approved leave makes the day an
"on leave" day, an approved Casual Leave makes it a paid manual day and an approved Morning Late-In permission shifts the
day's late boundary: the attendance engine reads all three, so the simulation has to know about them. After the
simulation ``create_leave`` writes the rows and the balances.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from api.models import CasualLeaveRequest, EmployeePermission, LeaveBalance, LeaveRequest

from .common import World, at, chance, daterange, office_hours, pick, s2t, shift_time, t2s
from .org import SHIFT_DEFS, hr_name
from .people import Person, add_months

LEAVE_TYPES = (("SL", 38), ("AL", 28), ("CL", 22), ("EL", 12))
LEAVE_REASONS = {
    "SL": ["Fever and cold", "Not well, doctor's advice", "Stomach infection", "Viral fever", "Body pain"],
    "AL": ["Family function", "Visiting native place", "Temple visit with family", "Personal work", "Festival at home"],
    "CL": ["Personal work", "Bank and government office work", "Child's school meeting", "House shifting"],
    "EL": ["Family emergency", "Relative hospitalised", "Urgent travel to native place"],
}
REJECTION_COMMENTS = [
    "Shipment week: please reschedule",
    "Too many people on leave that day",
    "Not approved: balance exhausted",
]
PERMISSION_REASONS = {
    "morning_late_in": [
        "Child's school admission work",
        "Bank work in the morning",
        "Bus delay",
        "Doctor's appointment",
    ],
    "evening_early_out": ["Parents' meeting at school", "Hospital visit", "Travel to native place"],
    "middle_permission": ["Bank work", "Government office visit", "Medical check-up"],
}
LEAVE_WEIGHTS = {"staff": 0.45 / 26, "production": 0.06 / 26}  # new requests per scheduled day, per person


@dataclass
class LeaveItem:
    person: Person
    type_code: str
    start: date
    end: date
    days: Decimal
    status: str  # approved | rejected | pending
    reason: str
    created: datetime
    decided: datetime | None = None
    decided_by: str | None = None
    role: str | None = None  # "hr" | "dept_head"
    comment: str | None = None


@dataclass
class CasualItem:
    person: Person
    day: date
    status: str
    reason: str
    created: datetime
    reviewed: datetime | None = None
    reviewed_by: str | None = None
    role: str | None = None
    comment: str | None = None


@dataclass
class PermissionItem:
    person: Person
    day: date
    kind: str  # morning_late_in | evening_early_out | middle_permission
    at_time: time
    status: str
    reason: str
    created: datetime
    decided: datetime | None = None
    decided_by: str | None = None
    role: str | None = None


@dataclass
class LeavePlan:
    leaves: list[LeaveItem] = field(default_factory=list)
    casuals: list[CasualItem] = field(default_factory=list)
    permissions: list[PermissionItem] = field(default_factory=list)
    #: person idx -> every calendar day of an APPROVED full-day leave (a Sunday inside the range is on leave too)
    leave_days: dict[int, set[date]] = field(default_factory=dict)
    #: person idx -> {day: "approved" | "rejected"} for decided Casual Leave
    casual_days: dict[int, dict[date, str]] = field(default_factory=dict)
    #: person idx -> {day: [kinds]} for APPROVED permissions
    permission_days: dict[int, dict[date, list[str]]] = field(default_factory=dict)


def is_scheduled(world: World, p: Person, day: date) -> bool:
    """Is ``day`` a day the person is expected to work? (Sundays and holidays are off; production work Saturdays and
    Sundays are covered separately by the attendance simulation.)"""
    if day in world.holidays:
        return False
    if day.weekday() == 6:
        return False
    return not (day.weekday() == 5 and p.saturday_off)


def clean_weeks(world: World) -> list[date]:
    """Mondays of the weeks whose Monday to Friday are all ordinary working days and that ended at least two days ago,
    most recent first: the one place a five-day absence is unambiguous (no Sunday or holiday inside it)."""
    plan = world.plan
    out: list[date] = []
    monday = plan.today - timedelta(days=plan.today.weekday() + 7)
    while monday >= plan.history_start + timedelta(days=7):
        week = [monday + timedelta(days=i) for i in range(5)]
        if not any(d in world.holidays for d in week) and week[-1] <= plan.today - timedelta(days=2):
            out.append(monday)
        monday -= timedelta(days=7)
    return out


def hr_approver(world: World, p: Person) -> tuple[str, str]:
    """(display name, stored role) of whoever decides this person's requests: their department head, or the unit's HR."""
    head: Person | None = world.extra["heads"].get((p.unit, p.dept))
    if head is not None and head is not p and head.exit is None and chance(world.extra["leave_rng"], 0.55):
        return head.full_name, "dept_head"
    return hr_name(world, "unit2hr_demo" if p.unit == "U2" else "hr_demo"), "hr"


def _trail(role: str, decision: str, by: str, when: datetime, comment: str | None) -> list[dict]:
    return [
        {
            "role": "hod" if role == "dept_head" else "hr",
            "decision": decision,
            "by": by,
            "at": when.isoformat(),
            "comment": comment,
        }
    ]


def _count_days(start: date, end: date) -> Decimal:
    """Working days (Monday to Saturday) between two dates, both included: the count the leave screens use."""
    days = sum(1 for d in daterange(start, end) if d.weekday() != 6)
    return Decimal(max(1, days))


def _created_for(rng: random.Random, start: date, today: date, now: time) -> datetime:
    """A request is filed in the month it is for, a day or two ahead (sick leave: on the day or after); never in the future."""
    day = start - timedelta(days=rng.randint(0, 3))
    if day.month != start.month:
        day = start.replace(day=1)
    day = min(day, today)
    return min(at(day, time(rng.randint(8, 17), rng.randint(0, 59))), at(today, now))


def plan_leave(world: World) -> LeavePlan:
    plan = world.plan
    today = plan.today
    rng = world.streams("leave")
    world.extra["leave_rng"] = world.streams("leave-approvers")
    out = LeavePlan()
    month_end = add_months(today.replace(day=1), 1) - timedelta(days=1)

    def block(p: Person, first: date, last: date) -> bool:
        busy = out.leave_days.setdefault(p.idx, set())
        return any(d in busy for d in daterange(first, last))

    for p in sorted(world.people, key=lambda x: x.idx):
        first = max(p.join, plan.history_start)
        last = min(p.exit or month_end, month_end)
        if last < first or "five_day" in p.flags:
            continue
        rate = LEAVE_WEIGHTS[p.kind]
        day = first
        while day <= last:
            if is_scheduled(world, p, day) and chance(rng, rate) and day >= first:
                length = pick(rng, [1, 2, 3, 4, 5], [58, 22, 10, 6, 4])
                end = day + timedelta(days=length - 1)
                if day > today:  # a future request must stay inside the current month
                    end = min(end, month_end)
                if end > last or block(p, day, end):
                    day += timedelta(days=1)
                    continue
                _add_leave(world, rng, out, p, day, end, today)
                day = end + timedelta(days=1)
                continue
            day += timedelta(days=1)

    weeks = clean_weeks(world)
    streaker = next((p for p in world.people if "leave_streak" in p.flags), None)
    absentee = next((p for p in world.people if "five_day" in p.flags), None)
    if absentee and weeks:
        world.stories["fiveDayAbsence"] = {
            "employee": absentee.code,
            "from": weeks[0].isoformat(),
            "to": (weeks[0] + timedelta(days=4)).isoformat(),
            "leaveOnRecord": False,
        }
    if streaker and len(weeks) > 1:
        monday = weeks[1]
        _add_leave(
            world, rng, out, streaker, monday, monday + timedelta(days=4), today, type_code="AL", status="approved"
        )
        world.stories["fiveDayApprovedLeave"] = {
            "employee": streaker.code,
            "from": monday.isoformat(),
            "to": (monday + timedelta(days=4)).isoformat(),
        }

    _plan_casual(world, rng, out)
    _plan_permissions(world, rng, out)
    world.extra["leave"] = out
    return out


def _add_leave(
    world: World,
    rng: random.Random,
    out: LeavePlan,
    p: Person,
    start: date,
    end: date,
    today: date,
    *,
    type_code: str | None = None,
    status: str | None = None,
) -> None:
    code = type_code or pick(rng, [c for c, _ in LEAVE_TYPES], [w for _, w in LEAVE_TYPES])
    if status is None:
        if start > today:
            status = "pending" if chance(rng, 0.8) else "approved"
        elif start >= today - timedelta(days=1):
            status = "pending" if chance(rng, 0.5) else "approved"
        else:
            status = "approved" if chance(rng, 0.88) else "rejected"
    created = _created_for(rng, start, today, world.plan.now)
    item = LeaveItem(p, code, start, end, _count_days(start, end), status, pick(rng, LEAVE_REASONS[code]), created)
    if status != "pending":
        by, role = hr_approver(world, p)
        item.decided = min(office_hours(created + timedelta(hours=rng.randint(3, 30))), at(today, world.plan.now))
        item.decided_by, item.role = by, role
        if status == "rejected":
            item.comment = pick(rng, REJECTION_COMMENTS)
    out.leaves.append(item)
    if status == "approved":
        out.leave_days.setdefault(p.idx, set()).update(daterange(start, end))


def _plan_casual(world: World, rng: random.Random, out: LeavePlan) -> None:
    """Casual Leave: staff only, six months' service, at most one a month; approved = a paid, manual day."""
    plan = world.plan
    today = plan.today
    months = sorted({(d.year, d.month) for d in daterange(plan.history_start, today)})
    for p in sorted(world.people, key=lambda x: x.idx):
        if p.kind != "staff" or "five_day" in p.flags or "leave_streak" in p.flags:
            continue
        for year, month in months:
            if not chance(rng, 0.07):
                continue
            days = [
                d
                for d in daterange(date(year, month, 1), add_months(date(year, month, 1), 1) - timedelta(days=1))
                if d <= today + timedelta(days=10)
                and d >= plan.history_start
                and p.employed_on(d)
                and p.join <= d - timedelta(days=183)
                and is_scheduled(world, p, d)
                and d not in out.leave_days.get(p.idx, set())
                and d != today
            ]
            if not days:
                continue
            day = rng.choice(days)
            created = _created_for(rng, day, today, plan.now)
            status = ("approved" if chance(rng, 0.9) else "rejected") if day < today - timedelta(days=1) else "pending"
            item = CasualItem(p, day, status, rng.choice(LEAVE_REASONS["CL"]), created)
            if status != "pending":
                item.reviewed_by, item.role = hr_approver(world, p)
                item.reviewed = min(office_hours(created + timedelta(hours=rng.randint(3, 30))), at(today, plan.now))
            out.casuals.append(item)
            if status != "pending":
                out.casual_days.setdefault(p.idx, {})[day] = status


def _plan_permissions(world: World, rng: random.Random, out: LeavePlan) -> None:
    """Permissions (staff): late-in, early-out and a one-hour break. At most three approved a month per person, so none is
    ever 'over the cap' and the day's stored flags are exactly what the engine derives."""
    plan = world.plan
    today = plan.today
    approved_in_month: dict[tuple[int, int, int], int] = {}
    for p in sorted(world.people, key=lambda x: x.idx):
        if p.kind != "staff" or "five_day" in p.flags or "leave_streak" in p.flags:
            continue
        shift = SHIFT_DEFS[p.shift_key]
        start, end = shift[2], shift[3]
        day = max(p.join, plan.history_start)
        last = min(p.exit or today, today)
        while day <= last:
            if is_scheduled(world, p, day) and chance(rng, 0.30 / 26) and day not in out.leave_days.get(p.idx, set()):
                if day in out.casual_days.get(p.idx, {}):
                    day += timedelta(days=1)
                    continue
                kind = pick(rng, ["morning_late_in", "evening_early_out", "middle_permission"], [50, 25, 25])
                clock = {
                    "morning_late_in": shift_time(start, 60),
                    "evening_early_out": shift_time(end, -60),
                    "middle_permission": s2t(t2s(start) + 2 * 3600 + 1800),
                }[kind]
                created = at(day - timedelta(days=rng.randint(0, 1)), time(rng.randint(8, 16), rng.randint(0, 59)))
                created = min(created, at(today, plan.now))
                key = (p.idx, day.year, day.month)
                if day >= today - timedelta(days=2):
                    status = "pending" if chance(rng, 0.6) else "approved"
                else:
                    status = "approved" if chance(rng, 0.86) else "rejected"
                if status == "approved" and approved_in_month.get(key, 0) >= 3:
                    status = "rejected"
                item = PermissionItem(p, day, kind, clock, status, rng.choice(PERMISSION_REASONS[kind]), created)
                if status != "pending":
                    item.decided_by, item.role = hr_approver(world, p)
                    item.decided = min(office_hours(created + timedelta(hours=rng.randint(1, 20))), at(today, plan.now))
                if status == "approved":
                    approved_in_month[key] = approved_in_month.get(key, 0) + 1
                    out.permission_days.setdefault(p.idx, {}).setdefault(day, []).append(kind)
                out.permissions.append(item)
            day += timedelta(days=1)


# ─── writing ──────────────────────────────────────────────────────────────────────────────────────────────────


def create_leave(world: World) -> None:
    plan: LeavePlan = world.extra["leave"]
    today = world.plan.today
    world.say("Leave, casual leave and permissions")
    rows: list[LeaveRequest] = []
    for item in plan.leaves:
        decided = item.status != "pending"
        rows.append(
            LeaveRequest(
                employee=item.person.emp,
                leave_type_ref=world.leave_types[item.type_code],
                type=world.leave_types[item.type_code].name,
                start_date=item.start.isoformat(),
                end_date=item.end.isoformat(),
                total_days=item.days,
                is_half_day=False,
                reason=item.reason,
                status=item.status,
                hr_comment=item.comment,
                approved_by=item.decided_by if decided else None,
                approver_role=item.role if decided else None,
                approval_trail=(
                    _trail(
                        item.role or "hr",
                        "approved" if item.status == "approved" else "rejected",
                        item.decided_by or "",
                        item.decided,
                        item.comment,
                    )
                    if decided and item.decided
                    else []
                ),
                created_at=item.created,
            )
        )
    world.insert(LeaveRequest, rows)

    cl_rows = []
    for item in plan.casuals:
        decided = item.status != "pending"
        cl_rows.append(
            CasualLeaveRequest(
                employee=item.person.emp,
                date=item.day,
                reason=item.reason,
                status=item.status,
                reviewed_by=item.reviewed_by if decided else None,
                reviewer_role=item.role if decided else None,
                approval_trail=(
                    _trail(
                        item.role or "hr",
                        "approved" if item.status == "approved" else "rejected",
                        item.reviewed_by or "",
                        item.reviewed,
                        item.comment,
                    )
                    if decided and item.reviewed
                    else []
                ),
                review_comment=item.comment,
                reviewed_at=item.reviewed if decided else None,
                created_at=item.created,
            )
        )
    world.insert(CasualLeaveRequest, cl_rows)

    perm_rows = []
    for item in plan.permissions:
        decided = item.status != "pending"
        perm_rows.append(
            EmployeePermission(
                employee=item.person.emp,
                date=item.day,
                permission_time=item.at_time,
                reason=item.reason,
                status=item.status,
                type=item.kind,
                duration_minutes=EmployeePermission.FIXED_DURATION_MINUTES,
                approved_by=item.decided_by if decided else None,
                approver_role=item.role if decided else None,
                approval_trail=(
                    _trail(
                        item.role or "hr",
                        "approved" if item.status == "approved" else "rejected",
                        item.decided_by or "",
                        item.decided,
                        None,
                    )
                    if decided and item.decided
                    else []
                ),
                created_at=item.created,
                updated_at=item.decided or item.created,
            )
        )
    world.insert(EmployeePermission, perm_rows)
    _create_balances(world, plan, today)
    world.say(f"  {len(rows)} leave requests, {len(cl_rows)} casual leave, {len(perm_rows)} permissions")


def _create_balances(world: World, plan: LeavePlan, today: date) -> None:
    """This year's balance per employee and applicable leave type: the type's allowance less what was approved."""
    used: dict[tuple[int, str], Decimal] = {}
    for item in plan.leaves:
        if item.status == "approved" and item.start.year == today.year:
            key = (item.person.idx, item.type_code)
            used[key] = used.get(key, Decimal(0)) + item.days
    rows: list[LeaveBalance] = []
    for p in world.people:
        if p.left:
            continue
        for code, lt in world.leave_types.items():
            if lt.applicable_gender not in ("all", p.gender):
                continue
            allocated = Decimal(lt.max_days_per_year)
            taken = min(used.get((p.idx, code), Decimal(0)), allocated)
            rows.append(
                LeaveBalance(
                    employee=p.emp,
                    leave_type=lt,
                    year=today.year,
                    allocated=allocated,
                    used=taken,
                    remaining=allocated - taken,
                    carried_forward=Decimal(0),
                )
            )
    world.insert(LeaveBalance, rows)
