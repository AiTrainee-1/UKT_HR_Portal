"""The workforce of the demo company and its history: who works where, who joined, who left, who got an increment or a
promotion, who is a department head.

Planning (``plan_people``) is pure Python and runs first, because the leave plan and the attendance simulation need to know
every person before anything is written. ``create_people`` then writes the employees and the rows that hang off them.

The people also carry the flags the planted stories hang on (a chronic absentee, a habitual late-comer, the employee absent
five days running, repeat outpass users, tea-break offenders). The flags are decided here, once, so every later domain
agrees on who is who; ``world.stories`` records them for the report the command prints.
"""

from __future__ import annotations

import calendar
import random
from dataclasses import dataclass, field
from datetime import date, time, timedelta
from decimal import Decimal

from api.models import (
    Branch,
    DepartmentManager,
    Employee,
    EmployeeShiftAssignment,
    ManagerDepartmentAssignment,
    Promotion,
    SalaryIncrement,
)
from api.salary_split import COLUMNS as SPLIT_COLUMNS
from api.salary_split import default_split

from .common import CODE_PREFIX, World, allocate, at, chance, money, pick
from .names import BLOOD_GROUPS, FIRST_NAMES, NameFactory, PersonName
from .org import (
    DEPARTMENTS,
    PRODUCTION_UNITS,
    STORY_MINIMUMS,
    UNIT_BY_KEY,
    Desig,
    designations_for,
    hr_name,
)

PRODUCTION_SHARE = 0.65
#: Share of women by department: the stitching and checking floors are mostly women, cutting and dyeing mostly men.
FEMALE_SHARE = {
    "Stitching": 0.62,
    "Checking": 0.75,
    "Packing": 0.55,
    "Ironing": 0.40,
    "Cutting": 0.18,
    "Dyeing": 0.15,
    "Washing": 0.25,
    "Maintenance": 0.05,
    "Quality Control": 0.55,
    "Stores": 0.20,
    "Administration": 0.35,
    "Human Resources": 0.70,
    "Accounts & Finance": 0.40,
    "Merchandising": 0.55,
    "IT & Systems": 0.25,
    "Purchase & Stores": 0.25,
}
PRODUCTION_REGIONS = {"tamil": 62, "kerala": 2, "telugu": 3, "kannada": 2, "odisha": 12, "hindi_belt": 10, "east": 9}
STAFF_REGIONS = {"tamil": 85, "kerala": 4, "telugu": 4, "kannada": 2, "odisha": 2, "hindi_belt": 2, "east": 1}
#: Who leaves: the dye and wash houses and the second unit's stitching floor lose people fastest.
LEAVER_WEIGHT = {("U3", "Washing"): 4.0, ("U3", "Dyeing"): 2.0, ("U2", "Stitching"): 2.5, ("U1", "Packing"): 1.3}
NEXT_LEVEL = {
    "staff": {"junior": "mid", "mid": "senior", "senior": "manager"},
    "production": {"junior": "senior"},
}
INCREMENT_PERCENTS = (5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10)


@dataclass(eq=False)
class Person:
    """One employee as planned (before the database knows them)."""

    idx: int
    name: PersonName
    kind: str  # staff | production
    unit: str
    dept: str
    desig: Desig
    join: date
    rate: Decimal  # pay now: staff = monthly salary, production = wage per shift
    shift_key: str
    is_head: bool = False
    exit: date | None = None  # last working date; None = still working
    notice: bool = False  # an approved resignation whose last working date is still ahead
    saturday_off: bool = False
    code: str = ""
    flags: set[str] = field(default_factory=set)
    raises: list[tuple[date, Decimal]] = field(default_factory=list)  # planned pay changes as percentages
    changes: list[tuple[date, Decimal]] = field(default_factory=list)  # the same, as (effective date, new rate)
    base_rate: Decimal = Decimal(0)  # the rate before the first change
    joining_rate: Decimal = Decimal(0)
    promoted_from: Desig | None = None
    promoted_on: date | None = None
    resignation_reason: str | None = None
    emp: Employee | None = None

    @property
    def full_name(self) -> str:
        return self.name.full

    @property
    def gender(self) -> str:
        return self.name.gender

    @property
    def left(self) -> bool:
        """Has the employee gone (status inactive)? An employee serving notice is still active."""
        return self.exit is not None and not self.notice

    @property
    def salary_amount(self) -> Decimal:
        """What ``Employee.salary_amount`` holds: the monthly salary (staff) or the weekly wage (production)."""
        return money(self.rate * 6) if self.kind == "production" else self.rate

    def rate_on(self, day: date) -> Decimal:
        """The pay rate in force on ``day``."""
        rate = self.base_rate
        for effective, new_rate in self.changes:
            if day < effective:
                break
            rate = new_rate
        return rate

    def employed_on(self, day: date) -> bool:
        return self.join <= day and (self.exit is None or day <= self.exit)


# ─── dates ────────────────────────────────────────────────────────────────────────────────────────────────────


def add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(day.day, calendar.monthrange(year, month + 1)[1]))


def month_end(day: date) -> date:
    return date(day.year, day.month, calendar.monthrange(day.year, day.month)[1])


def _to_step(value: Decimal | float, step: int) -> Decimal:
    return (Decimal(str(value)) / step).to_integral_value() * step


# ─── planning ─────────────────────────────────────────────────────────────────────────────────────────────────


def _rate_for(rng: random.Random, desig: Desig, tenure_years: float) -> Decimal:
    """A pay rate inside the designation's band: longer service sits higher in it."""
    position = max(0.0, min(1.0, 0.10 * tenure_years + rng.gauss(0.22, 0.17)))
    return _to_step(desig.low + (desig.high - desig.low) * position, 500 if desig.kind == "staff" else 10)


def _shift_for(rng: random.Random, unit: str, dept: str, kind: str) -> str:
    if unit == "HO":
        return "office"
    if kind == "staff":
        return "staff"
    if dept == "Packing":
        return "extended" if rng.random() < 0.85 else "regular"
    if dept == "Stitching":
        return "extended" if rng.random() < 0.45 else "regular"
    return "extended" if rng.random() < 0.08 else "regular"


def _headcounts(world: World) -> list[tuple[str, str, str, int]]:
    """(unit, department, kind, people) for every slot: the production floor and the staff, split by the department weights."""
    total = world.plan.employees
    n_prod = round(total * PRODUCTION_SHARE)
    slots: list[tuple[str, str, str, int]] = []
    prod = [(u, s) for u in PRODUCTION_UNITS for s in DEPARTMENTS[u] if s.prod_weight > 0]
    counts = allocate(
        n_prod, [s.prod_weight for _, s in prod], [STORY_MINIMUMS.get((u, s.name, "production"), 0) for u, s in prod]
    )
    slots += [(u, s.name, "production", c) for (u, s), c in zip(prod, counts) if c]
    staff = [(u, s) for u in UNIT_BY_KEY for s in DEPARTMENTS[u] if s.staff_weight > 0]
    counts = allocate(
        total - n_prod,
        [s.staff_weight for _, s in staff],
        [STORY_MINIMUMS.get((u, s.name, "staff"), 0) for u, s in staff],
    )
    slots += [(u, s.name, "staff", c) for (u, s), c in zip(staff, counts) if c]
    return slots


def _build_person(
    rng: random.Random,
    names: NameFactory,
    today: date,
    idx: int,
    unit: str,
    dept: str,
    kind: str,
    desig: Desig,
    head: bool,
) -> Person:
    regions = PRODUCTION_REGIONS if kind == "production" else STAFF_REGIONS
    region = rng.choices(list(regions), weights=list(regions.values()), k=1)[0]
    gender = "female" if rng.random() < FEMALE_SHARE.get(dept, 0.4) else "male"
    name = names.person(gender=gender, region=region)
    age_days = rng.randint(1500, 3000) if head else int(rng.triangular(60, 3000, 700))
    saturday_off = kind == "staff" and chance(rng, 0.70 if unit == "HO" else 0.25)
    return Person(
        idx,
        name,
        kind,
        unit,
        dept,
        desig,
        today - timedelta(days=age_days),
        _rate_for(rng, desig, age_days / 365.0),
        _shift_for(rng, unit, dept, kind),
        is_head=head,
        saturday_off=saturday_off,
    )


def plan_people(world: World) -> list[Person]:
    """Decide everyone: department, designation, pay, joining date and the history that follows (see the module docstring)."""
    plan = world.plan
    today = plan.today
    rng = world.streams("people")
    names = NameFactory(world.streams("names"))
    people: list[Person] = []

    for unit, dept, kind, count in _headcounts(world):
        options = [d for d in designations_for(unit, dept) if d.kind == kind]
        head = next((d for d in options if d.head), None) if kind == "staff" else None
        others = [d for d in options if not d.head] or options
        for n in range(count):
            if head is not None and n == 0:
                desig, is_head = head, True
            else:
                desig, is_head = pick(rng, others, [d.weight for d in others]), False
            people.append(_build_person(rng, names, today, len(people), unit, dept, kind, desig, is_head))

    movable = [p for p in people if not p.is_head]
    _plan_joiners(world, rng, movable)
    _plan_leavers(world, rng, movable)
    _plan_milestones(rng, movable, today)
    _assign_story_flags(world, rng, people)
    _plan_pay_changes(world, rng, people)
    for p in people:
        _finish_pay(p, today)

    # codes follow the joining order, as they do in a real company
    for number, p in enumerate(sorted(people, key=lambda x: (x.join, x.full_name)), start=1):
        p.code = f"{CODE_PREFIX}{number:04d}"
    world.people = people
    world.extra["names"] = names
    world.extra["heads"] = {(p.unit, p.dept): p for p in people if p.is_head}
    _record_story_people(world, people)
    return people


def _plan_joiners(world: World, rng: random.Random, movable: list[Person]) -> None:
    """Joiners of the last six months. Staff join on the 1st of a month (payroll prefers whole months). The first few are
    the ones who will leave again inside 90 days, so they must have joined at least three months ago."""
    plan = world.plan
    today = plan.today
    first_month = add_months(today.replace(day=1), -5)
    count = min(max(3, round(plan.employees * 0.065)), len(movable))
    n_early = min(max(1, round(plan.employees * 0.0125)), count)
    early = rng.sample(movable, n_early)
    for p in early:
        p.flags.update({"recent", "early_leaver"})
        p.join = (
            add_months(first_month, rng.randint(0, 2))
            if p.kind == "staff"
            else today - timedelta(days=rng.randint(85, 170))
        )
    rest = [p for p in movable if "recent" not in p.flags]
    for p in rng.sample(rest, min(count - n_early, len(rest))):
        p.flags.add("recent")
        p.join = (
            add_months(first_month, rng.randint(0, 5))
            if p.kind == "staff"
            else today - timedelta(days=rng.randint(4, 178))
        )
        p.join = min(p.join, today)


def _plan_leavers(world: World, rng: random.Random, movable: list[Person]) -> None:
    """Leavers of the last twelve months, a few of them inside 90 days of joining, and two staff serving notice."""
    plan = world.plan
    today = plan.today
    last_month_end = month_end(add_months(today.replace(day=1), -1))
    n_leavers = max(3, round(plan.employees * 0.065))

    early = [p for p in movable if "early_leaver" in p.flags]
    for p in early:
        p.exit = month_end(add_months(p.join, 1)) if p.kind == "staff" else p.join + timedelta(days=rng.randint(25, 75))
        p.exit = min(p.exit, last_month_end if p.kind == "staff" else today - timedelta(days=3))
        p.flags.add("leaver")

    pool = [p for p in movable if "recent" not in p.flags and p.join <= today - timedelta(days=100)]
    chosen: list[Person] = []
    wanted_staff = round(n_leavers * 0.45) - sum(p.kind == "staff" for p in early)
    while pool and len(chosen) < n_leavers - len(early):
        # nearly half of the leavers are staff: they resign through the app, so their exits carry a reason
        kind = "staff" if sum(p.kind == "staff" for p in chosen) < wanted_staff else "production"
        candidates = [p for p in pool if p.kind == kind] or pool
        pick_one = rng.choices(candidates, weights=[LEAVER_WEIGHT.get((p.unit, p.dept), 1.0) for p in candidates], k=1)[
            0
        ]
        pool.remove(pick_one)
        chosen.append(pick_one)
    for p in chosen:
        day = today - timedelta(days=rng.randint(6, 360))
        if p.kind == "staff":  # a staff member's last day is a month's last day
            day = month_end(day)
            if day > last_month_end:
                day = last_month_end
        p.exit = max(day, p.join + timedelta(days=45))
        p.flags.add("leaver")

    notice_pool = [p for p in movable if p.kind == "staff" and p.exit is None and "recent" not in p.flags]
    for p in rng.sample(notice_pool, min(2, len(notice_pool))):
        p.exit = month_end(add_months(today, rng.randint(0, 1)))
        if p.exit < today + timedelta(days=5):
            p.exit = month_end(add_months(today, 1))
        p.notice = True
        p.flags.add("notice")


def _plan_milestones(rng: random.Random, movable: list[Person], today: date) -> None:
    """Three people reach 5, 8 and 10 years' service in the next 30 days."""
    pool = [p for p in movable if p.exit is None and "recent" not in p.flags]
    for p, years in zip(rng.sample(pool, min(3, len(pool))), (10, 5, 8)):
        anniversary = today + timedelta(days=rng.randint(3, 26))
        p.join = date(anniversary.year - years, anniversary.month, min(anniversary.day, 28))
        p.flags.add("milestone")


def _assign_story_flags(world: World, rng: random.Random, people: list[Person]) -> None:
    """The people the dashboards' exceptions find. Chosen once so every domain agrees on who they are."""
    plan = world.plan
    today = plan.today
    n = plan.employees
    seasoned = [
        p
        for p in people
        if p.exit is None and not p.is_head and p.join <= today - timedelta(days=240) and "milestone" not in p.flags
    ]

    def take(pool: list[Person], count: int, flag: str) -> list[Person]:
        chosen = rng.sample(pool, min(count, len(pool)))
        for p in chosen:
            p.flags.add(flag)
        return chosen

    staff = [p for p in seasoned if p.kind == "staff"]
    prod = [p for p in seasoned if p.kind == "production"]

    # one person absent five working days running with no leave on record, one on approved leave for five days (a small
    # company has few non-head staff: fall back to a head, then to anyone, rather than lose the story)
    everyone = [p for p in seasoned if p.kind == "staff"] + [
        p
        for p in people
        if p.is_head and p.kind == "staff" and p.exit is None and p.join <= today - timedelta(days=240)
    ]
    quality = [p for p in staff if p.unit == "U1" and p.dept == "Quality Control"]
    take(next(pool for pool in (quality, staff, everyone, prod) if pool), 1, "five_day")
    others = [p for p in everyone if "five_day" not in p.flags and p.dept != "Quality Control"]
    take(
        next(pool for pool in (others, [p for p in prod if "five_day" not in p.flags]) if pool)
        if (others or prod)
        else [],
        1,
        "leave_streak",
    )

    def streaker(p: Person) -> bool:
        return bool(p.flags & {"five_day", "leave_streak"})

    k = max(1, round(n * 0.025))
    take(prod, max(1, round(k * 0.7)), "chronic")
    take([p for p in staff if not streaker(p)], max(1, round(k * 0.3)), "chronic")
    late_pool = [p for p in seasoned if "chronic" not in p.flags and not streaker(p)]
    take([p for p in late_pool if p.kind == "staff"], max(1, round(k * 0.65)), "late")
    take([p for p in late_pool if p.kind == "production"], max(1, round(k * 0.35)), "late")

    floors = [
        p
        for p in prod
        if p.dept in ("Stitching", "Checking", "Ironing", "Packing")
        and not p.flags & {"chronic", "late"}
        and not (p.dept == "Stitching" and p.shift_key == "extended")  # that group overruns as a whole
    ]
    take(floors, max(1, round(n * 0.02)), "tea_offender")
    movers = [p for p in prod if not p.flags & {"chronic", "tea_offender"}]
    take(movers, max(1, round(n * 0.025)), "outpass_repeater")
    for p in prod:
        if chance(rng, 0.20):
            p.flags.add("sunday_worker")


def _next_level_options(p: Person) -> list[Desig]:
    target = NEXT_LEVEL[p.kind].get(p.desig.level)
    return [
        d for d in designations_for(p.unit, p.dept) if target and d.kind == p.kind and d.level == target and not d.head
    ]


def _plan_pay_changes(world: World, rng: random.Random, people: list[Person]) -> None:
    """The company-wide increment cycle (one month) and a handful of promotions in the last year."""
    plan = world.plan
    today = plan.today
    months = plan.closed_months
    year, month = months[-4] if len(months) >= 4 else months[0]
    increment_day = date(year, month, 1)
    world.stories["incrementMonth"] = f"{year}-{month:02d}"

    for p in people:
        # everyone with six months' service on the day, most of them
        if p.employed_on(increment_day) and p.join <= increment_day - timedelta(days=180) and chance(rng, 0.82):
            p.raises.append((increment_day, Decimal(str(rng.choice(INCREMENT_PERCENTS)))))
            p.flags.add("incremented")

    eligible = [
        p
        for p in people
        if p.exit is None
        and not p.is_head
        and "recent" not in p.flags
        and p.join <= today - timedelta(days=400)
        and _next_level_options(p)
    ]
    for p in rng.sample(eligible, min(max(1, round(plan.employees * 0.03)), len(eligible))):
        promoted_on = (today - timedelta(days=rng.randint(25, 330))).replace(day=1)
        if any(day == promoted_on for day, _ in p.raises):  # a promotion and the cycle increment never share a day
            promoted_on = add_months(promoted_on, -1)
        p.promoted_from, p.promoted_on = p.desig, promoted_on
        p.desig = _next_level_options(p)[0]
        p.raises.append((promoted_on, Decimal(12)))
        p.flags.add("promoted")


def _finish_pay(p: Person, today: date) -> None:
    """Turn the planned percentages into rates: ``p.rate`` is the pay NOW, earlier rates are worked back from it."""
    step = 500 if p.kind == "staff" else 10
    raises = sorted(p.raises)
    factor = Decimal(1)
    for _, pct in raises:
        factor *= Decimal(1) + pct / Decimal(100)
    p.base_rate = _to_step(p.rate / factor, step)
    rate = p.base_rate
    p.changes = []
    for day, pct in raises:
        rate = _to_step(rate * (Decimal(1) + pct / Decimal(100)), step)
        p.changes.append((day, rate))
    if p.changes:
        p.rate = p.changes[-1][1]
    else:
        p.base_rate = p.rate
    years = max(0.0, ((raises[0][0] if raises else today) - p.join).days / 365.0 - 0.5)
    p.joining_rate = min(p.base_rate, _to_step(p.base_rate / Decimal(str(1.05**years)), step)) or p.base_rate


def _record_story_people(world: World, people: list[Person]) -> None:
    def codes(flag: str) -> list[str]:
        return sorted(p.code for p in people if flag in p.flags)

    world.stories.update(
        {
            "chronicAbsentees": codes("chronic"),
            "habitualLateComers": codes("late"),
            "teaBreakRepeatOffenders": codes("tea_offender"),
            "outpassRepeatUsers": codes("outpass_repeater"),
            "recentJoiners": codes("recent"),
            "leaversUnder90Days": codes("early_leaver"),
            "servingNotice": codes("notice"),
            "serviceMilestones": codes("milestone"),
        }
    )


# ─── writing ──────────────────────────────────────────────────────────────────────────────────────────────────


def _birth_date(rng: random.Random, p: Person) -> date:
    """Production staff skew younger, staff older. Always at least 19 on the joining date."""
    age = int(rng.triangular(19, 52, 27 if p.kind == "production" else 31))
    return p.join - timedelta(days=int(age * 365.25) + rng.randint(0, 364))


def _employee_row(world: World, p: Person, names: NameFactory, rng: random.Random, seq: dict[str, int]) -> Employee:
    plan = world.plan
    branch = world.branches[p.unit]
    seq[p.unit] += 1
    bank, account, ifsc = names.bank()
    split_columns = {SPLIT_COLUMNS[c]: v for c, v in default_split(p.salary_amount).items()}
    probation_end = confirmation = None
    if p.kind == "staff":
        end = add_months(p.join, 6)
        confirmation, probation_end = (end, None) if end <= plan.today else (None, end)
    if p.left and p.exit:
        modified = at(p.exit, time(17, 0))
    else:
        modified = at(max([p.join] + [d for d, _ in p.changes]), time(11, 0))
    monthly_equivalent = p.rate if p.kind == "staff" else p.rate * 26
    return Employee(
        employee_code=p.code,
        first_name=p.name.first,
        last_name=p.name.last,
        gender=p.gender,
        date_of_birth=_birth_date(rng, p),
        email=names.email(p.name) if p.kind == "staff" and chance(rng, 0.8) else None,
        phone=names.phone(),
        emergency_contact=names.phone(),
        role=p.desig.title,
        employment_type=p.kind,
        department=world.departments[(p.unit, p.dept)],
        designation=world.designations[(p.unit, p.dept, p.desig.title)],
        branch=branch,
        unit_code=f"{branch.code}-{seq[p.unit]}",
        salary_type="weekly" if p.kind == "production" else "monthly",
        salary_amount=p.salary_amount,
        salary_per_shift=p.rate if p.kind == "production" else None,
        status="inactive" if p.left else "active",
        bank_name=bank,
        bank_account=account,
        bank_ifsc=ifsc,
        pf_number=(
            f"TN/TIR/{rng.randint(1000000, 9999999)}/000/{rng.randint(1000000, 9999999)}" if chance(rng, 0.85) else None
        ),
        esi_number=str(rng.randint(10**9, 10**10 - 1)) if monthly_equivalent <= 21000 and chance(rng, 0.8) else None,
        uan_number=str(rng.randint(10**11, 10**12 - 1)) if chance(rng, 0.85) else None,
        address=names.address(),
        join_date=p.join.isoformat(),
        father_name=names.father(p.name),
        mother_name=f"{rng.choice(FIRST_NAMES[p.name.region]['female'])} {p.name.last}",
        probation_end_date=probation_end,
        confirmation_date=confirmation,
        blood_group=pick(rng, BLOOD_GROUPS),
        initial_salary=money(p.joining_rate * 6) if p.kind == "production" else money(p.joining_rate),
        nationality="Indian",
        workstation=f"Line {rng.randint(1, 12)}"
        if p.kind == "production" and p.dept in ("Stitching", "Checking", "Ironing", "Packing")
        else None,
        created_at=at(p.join, time(10, 30)),
        updated_at=modified,
        **split_columns,
    )


def create_people(world: World) -> None:
    """Insert the employees, their shift assignments, the department heads, and the pay-change records."""
    world.say("People")
    rng = world.streams("people-rows")
    names: NameFactory = world.extra["names"]
    seq = {unit: int(world.branches[unit].next_employee_seq or 0) for unit in UNIT_BY_KEY}
    before = dict(seq)

    ordered = sorted(world.people, key=lambda p: p.code)
    rows = [_employee_row(world, p, names, rng, seq) for p in ordered]
    world.insert(Employee, rows)
    for p, row in zip(ordered, rows):
        p.emp = row

    # the unit-code counters move on, so the next employee HR adds does not reuse a Unit Code
    moved: dict[str, dict[str, int]] = {}
    for unit, last in seq.items():
        if last != before[unit]:
            branch = world.branches[unit]
            Branch.objects.filter(pk=branch.pk).update(next_employee_seq=last)
            branch.next_employee_seq = last
            moved[str(branch.pk)] = {"before": before[unit], "after": last}
    world.adjustments["branchSeq"] = moved

    world.insert(
        EmployeeShiftAssignment,
        [
            EmployeeShiftAssignment(
                employee=p.emp,
                shift=world.shifts[(p.unit, p.shift_key)],
                effective_from=p.join,
                effective_to=None,
                assigned_by="System (Auto)" if p.kind == "production" else hr_name(world, "hr_demo"),
                notes="Auto-assigned production shift" if p.kind == "production" else None,
                saturday_off=p.saturday_off,
                created_at=at(p.join, time(11, 0)),
            )
            for p in ordered
        ],
    )
    _create_heads(world, ordered)
    _create_pay_history(world, ordered)
    world.say(
        f"  {len(rows)} employees ({sum(p.kind == 'production' for p in ordered)} production, "
        f"{sum(p.kind == 'staff' for p in ordered)} staff), {sum(p.left for p in ordered)} left, "
        f"{sum(p.notice for p in ordered)} serving notice"
    )


def _create_heads(world: World, ordered: list[Person]) -> None:
    """Each department's head is its HOD: the person its staff's requests go to first (User Management)."""
    heads = [p for p in ordered if p.is_head and not p.left]
    managers = [
        DepartmentManager(
            employee=p.emp,
            can_approve_leaves=True,
            can_approve_permissions=True,
            can_approve_resignations=True,
            can_approve_attendance=True,
            can_approve_casual_leave=True,
            can_approve_on_duty=True,
            can_approve_missing_punch=True,
            is_active=True,
            notes="Department head (demo data)",
            created_at=at(max(p.join, world.plan.history_start - timedelta(days=400)), time(11, 0)),
        )
        for p in heads
    ]
    world.insert(DepartmentManager, managers)
    world.insert(
        ManagerDepartmentAssignment,
        [
            ManagerDepartmentAssignment(
                manager=m, department=world.departments[(p.unit, p.dept)], created_at=m.created_at
            )
            for m, p in zip(managers, heads)
        ],
    )


def _create_pay_history(world: World, ordered: list[Person]) -> None:
    hr = hr_name(world, "hr_demo")
    increments: list[SalaryIncrement] = []
    promotions: list[Promotion] = []
    for p in ordered:
        for day, rate in p.changes:
            previous = p.rate_on(day - timedelta(days=1))
            before = money(previous * 6) if p.kind == "production" else money(previous)
            after = money(rate * 6) if p.kind == "production" else money(rate)
            increments.append(
                SalaryIncrement(
                    employee=p.emp,
                    previous_salary=before,
                    new_salary=after,
                    percent=money((after - before) / before * 100) if before else Decimal(0),
                    effective_date=day,
                    notes=f"Promotion to {p.desig.title}" if p.promoted_on == day else "Annual appraisal increment",
                    added_by=hr,
                    created_at=at(day - timedelta(days=3), time(15, 0)),
                )
            )
        if p.promoted_on and p.promoted_from:
            dept = world.departments[(p.unit, p.dept)]
            promotions.append(
                Promotion(
                    employee=p.emp,
                    previous_department=dept,
                    previous_designation=world.designations[(p.unit, p.dept, p.promoted_from.title)],
                    new_department=dept,
                    new_designation=world.designations[(p.unit, p.dept, p.desig.title)],
                    effective_date=p.promoted_on,
                    notes="Performance based promotion",
                    promoted_by=hr,
                    created_at=at(p.promoted_on - timedelta(days=3), time(15, 0)),
                )
            )
    world.insert(SalaryIncrement, increments)
    world.insert(Promotion, promotions)
