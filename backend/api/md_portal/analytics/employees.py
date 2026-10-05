"""MD portal · Employees: the shape of the workforce and how it is moving.

The page answers "who works here, how is that changing, and where are we losing people?". Everything is computed from
the ``Employee`` table (plus approved resignations for exit dates, promotions, increments, the required-headcount plan
and the attendance day records for one person's profile). Four facts shape the arithmetic, and each is repeated in the
``provenance`` of the figures it touches so the MD (and the assistant) can read it:

* **There is no headcount history.** Headcount on a past day is *reconstructed*: people who had joined by that day and
  had not yet left. A person counts in the headcount of a day until their exit date; on the exit date they are a leaver.
  With that rule ``opening + joiners - leavers = closing`` holds exactly for every period.
* **There is no exit-date field.** Exit dates come from the Report Center's own rule (``exit_infos``): the approved
  resignation's last working date, else its approval date, else (a plain deactivation) the day the record last changed,
  which is approximate and is reported as such. A last working day in the future counts as today, because the person is
  already inactive in the system: that makes today's reconstructed headcount equal the number of ``status == active``
  people, which is the portal-wide definition of headcount.
* **``Employee.join_date`` is TEXT.** One that is missing, unreadable, absurd, in the future or later than the exit date
  cannot place a person in time. Such a person is *assumed to have been here since before any period asked about*: they
  are in the headcount until they leave, are never counted as a joiner and have no tenure. How many there are is
  reported in ``notes``.
* **People are counted where they are today.** Transfers between departments or units are not tracked, so a past
  figure by department uses the department the person belongs to now.

Every public function is read-only (it only reads tables), takes a ``Scope`` (and a ``Period`` where the figure has
one), returns ``common.envelope(...)`` and is used both by ``routes/employees.py`` and by the assistant's tools.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any, Callable

from django.db.models import Count, F, Q, Value
from django.db.models.functions import Lower, NullIf

from ...clock import ist_today
from ...models import (
    AttendanceDayRecord,
    Branch,
    Department,
    DepartmentHeadcount,
    Designation,
    Employee,
    EmployeeDocument,
    LeaveBalance,
    Promotion,
    SalaryIncrement,
)
from ...reporting.definitions.employees_master_base import (
    BASIS_APPROX,
    age_on,
    document_map,
    exit_infos,
    gender_bucket,
    join_date_of,
    months_between,
    occurrence_in_window,
    tenure_text,
)
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import (
    MdParamError,
    Period,
    Scope,
    add_months,
    cached,
    change,
    envelope,
    month_bounds,
    month_label,
    pct,
    period_for_preset,
    prov,
)

# ─── rules the figures follow (named so the provenance and the tests quote the same numbers) ──────────────────

EARLY_EXIT_DAYS = 90  # "early attrition": left within this many days of joining (90 days or fewer)
LONG_SERVICE_YEARS = 5  # work anniversaries are listed from this many completed years
DEFAULT_LIMIT, MAX_LIMIT = 10, 25
HOTSPOT_FACTOR = 1.5  # a department is a hot-spot at 1.5x the company's attrition ...
HOTSPOT_MIN_LEAVERS = 3  # ... but only with at least this many leavers ...
HOTSPOT_MIN_AVERAGE = 10  # ... out of an average headcount of at least this many (tiny teams are noise)
BULK_DEACTIVATION_MIN = 5  # this many people switched to inactive on one day, with no resignation, is a clean-up
MIN_ANNUALISE_DAYS = 28  # a window shorter than this is not scaled up to a year
PROBATION_SOON_DAYS = 30
NEW_JOINER_DAYS = 30  # "new joiners" for the documents check: joined in the last this-many days
DOCUMENTS_PENDING_MIN = 3  # this many new joiners with required documents missing is worth a line
EXIT_APPROXIMATE, EXIT_RESIGNATION = "approximate", "resignation"

AGE_BANDS = ("Under 18", "18-25", "26-35", "36-45", "46-55", "56+")
TENURE_BANDS = ("Under 1 year", "1-3 years", "3-5 years", "5-10 years", "10+ years")
EXIT_BUCKETS = (
    ("early", f"Within {EARLY_EXIT_DAYS} days"),
    ("under1y", "3-12 months"),
    ("1to3", "1-3 years"),
    ("3to5", "3-5 years"),
    ("5plus", "5+ years"),
    ("unknown", "Not known"),
)
_MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

CAVEAT_RECONSTRUCTED = (
    "The system keeps no headcount history: headcount on a past day is rebuilt from join dates and exit dates "
    "(people who had joined by that day and had not yet left)."
)
CAVEAT_EXIT_DATES = (
    "There is no exit-date field: an exit is dated by the approved resignation's last working date (or its approval "
    "date). A person deactivated without a resignation is dated by when the record was last changed, which is "
    "approximate. An exit dated in the future counts as today, because the person is already inactive."
)
CAVEAT_JOIN_DATES = (
    "A missing, unreadable or inconsistent join date cannot place a person in time: they are assumed to have been here "
    "since before the period, are never counted as a joiner and have no tenure."
)
CAVEAT_EXIT_RATE = (
    "The Report Center's Joiners vs Leavers report shows an 'exit rate' that divides by today's staff plus the "
    "leavers; attrition here divides by the average of the opening and closing headcount, so the two differ."
)
CAVEAT_DEPARTMENTS = (
    "People are counted in the department and unit they belong to today; transfers are not tracked, so past figures "
    "use today's department."
)

# ─── why people leave: the resignation text is free writing, so it is grouped by keyword (first matching group wins) ─

REASON_GROUPS: tuple[tuple[str, str, str], ...] = (
    (
        "health",
        "Health",
        r"health|medical|\bill(ness)?\b|\bsick|surgery|surgical|accident|hospital|treatment|disease|injur|cancer|diabet",
    ),
    ("studies", "Higher studies", r"\bstud(y|ies|ent|ying)\b|education|college|course|\bexam|degree|diploma|universit"),
    (
        "business",
        "Own business or farming",
        r"own business|start(ing)? (a )?business|business of my own|self[- ]?employ|own shop|farming|agricultur|start[- ]?up",
    ),
    ("retirement", "Retirement", r"retire|superannuat"),
    (
        "better_pay",
        "Better pay or opportunity",
        r"salary|\bpay\b|payment|wage|opportunit|career|growth|promotion|increment|better (job|offer|position|package|"
        r"prospect|future)|higher (pay|position|package)|another (company|job|firm)|other (company|job|firm)|new job|"
        r"job offer|package",
    ),
    (
        "workplace",
        "Work environment or management",
        r"pressure|stress|environment|supervisor|manager|management|behaviou?r|harass|workload|work load|long hours|"
        r"working hours|timing|overtime|\bot\b|not happy|unhappy|dissatisf|conflict|fed up|discriminat|unfair|insult|scold",
    ),
    (
        "relocation",
        "Relocation or distance",
        r"relocat|shift(ing)? to|moving|\bmove\b|native|village|hometown|home town|distance|far from|transport|commut|"
        r"travel|transfer|own place|abroad|another city|other city",
    ),
    (
        "personal",
        "Family or personal reasons",
        r"family|personal|marri|wedding|pregnan|maternity|child|\bkids?\b|parent|mother|father|wife|husband|domestic|"
        r"\bhome\b|baby|elder|care of",
    ),
)
_REASON_PATTERNS = tuple((key, label, re.compile(pattern, re.IGNORECASE)) for key, label, pattern in REASON_GROUPS)
REASON_LABELS = {key: label for key, label, _ in REASON_GROUPS} | {
    "other": "Other reasons",
    "none": "No reason recorded",
}


def classify_reason(*texts: str | None) -> str:
    """The reason group (a key of REASON_LABELS) for what the person wrote. The texts are tried in order (the exit
    survey's "main reason" first, then the resignation reason): the first one that matches a group decides; text that
    matches nothing is "other"; no text at all is "none"."""
    written = [t.strip() for t in texts if t and t.strip()]
    for text in written:
        for key, _label, pattern in _REASON_PATTERNS:
            if pattern.search(text):
                return key
    return "other" if written else "none"


# ─── who is in scope: one pass over the Employee table, every other figure is arithmetic on this ─────────────


@dataclass(frozen=True, slots=True)
class Person:
    id: int
    code: str
    name: str
    kind: str  # staff | production | other
    active: bool
    gender: str  # male | female | other | unspecified
    dob: date | None
    dept_id: int | None
    desig_id: int | None
    branch_id: int | None
    joined: date | None  # None = cannot be placed in time (see the module docstring)
    left: date | None  # the exit date of someone who is not active; None while on the rolls
    exit_basis: str | None  # EXIT_RESIGNATION | EXIT_APPROXIMATE
    reason_survey: str | None
    reason_text: str | None
    probation_end: date | None
    confirmed_on: date | None


@dataclass
class Lookups:
    branches: dict[int, str]
    departments: dict[int, tuple[str, int | None]]  # id -> (name, unit id)
    designations: dict[int, str]
    dept_labels: dict[int, str]

    def unit(self, branch_id: int | None) -> str:
        return self.branches.get(branch_id, "No unit") if branch_id else "No unit"

    def dept(self, dept_id: int | None) -> str:
        return self.dept_labels.get(dept_id, "No department") if dept_id else "No department"

    def dept_unit(self, dept_id: int | None) -> str | None:
        entry = self.departments.get(dept_id) if dept_id else None
        return self.unit(entry[1]) if entry and entry[1] else None

    def desig(self, desig_id: int | None) -> str | None:
        return self.designations.get(desig_id) if desig_id else None


@dataclass
class Workforce:
    today: date
    people: list[Person]
    lookups: Lookups
    no_join_date: int = 0  # missing or unreadable
    future_join_date: int = 0
    exit_before_join: int = 0

    @property
    def unplaced(self) -> int:
        return sum(1 for p in self.people if p.joined is None)

    def active(self) -> list[Person]:
        return [p for p in self.people if p.active]


_PEOPLE_FIELDS = (
    "id",
    "employee_code",
    "first_name",
    "last_name",
    "gender",
    "date_of_birth",
    "employment_type",
    "status",
    "department_id",
    "designation_id",
    "branch_id",
    "join_date",
    "updated_at",
    "probation_end_date",
    "confirmation_date",
)


def _department_labels(departments: dict[int, tuple[str, int | None]], branches: dict[int, str]) -> dict[int, str]:
    """The plain name, plus " (Unit)" only where two departments share a name (Stitching of Unit 1 and of Unit 2)."""
    by_name: dict[str, list[int]] = defaultdict(list)
    for dept_id, (name, _unit) in departments.items():
        by_name[(name or "").strip().lower()].append(dept_id)
    labels: dict[int, str] = {}
    for ids in by_name.values():
        for dept_id in ids:
            name, unit = departments[dept_id]
            suffix = f" ({branches.get(unit, 'No unit') if unit else 'No unit'})"
            labels[dept_id] = name if len(ids) == 1 else name + suffix
    taken = Counter(labels.values())
    for dept_id, label in labels.items():
        if taken[label] > 1:  # two departments of one unit with one name: only the id tells them apart
            labels[dept_id] = f"{label} #{dept_id}"
    return labels


def load_lookups() -> Lookups:
    branches = dict(Branch.objects.values_list("id", "name"))
    departments = {i: (name, unit) for i, name, unit in Department.objects.values_list("id", "name", "branch_id")}
    designations = dict(Designation.objects.values_list("id", "title"))
    return Lookups(branches, departments, designations, _department_labels(departments, branches))


def load(scope: Scope, today: date) -> Workforce:
    """Every employee in scope (active or not) as a ``Person``: a fixed number of queries however many there are."""
    rows = list(scope.employees(active=None).order_by("id").values_list(*_PEOPLE_FIELDS))
    stubs = {r[0]: SimpleNamespace(id=r[0], join_date=r[11], updated_at=r[12]) for r in rows}
    infos = exit_infos([stubs[r[0]] for r in rows if (r[7] or "") != "active"])
    wf = Workforce(today=today, people=[], lookups=load_lookups())
    for id_, code, first, last, gender, dob, kind, status, dept, desig, branch, _join, _upd, prob, conf in rows:
        active = (status or "") == "active"
        kind = (kind or "").strip().lower()
        joined, state = join_date_of(stubs[id_])
        wf.no_join_date += state != "ok"
        left = basis = res = None
        if not active:
            info = infos.get(id_)
            when = info.when if info is not None and info.when is not None else today
            left = min(when, today)  # a last working day still ahead: already inactive, so it is today
            approximate = info is None or info.basis == BASIS_APPROX
            basis = EXIT_APPROXIMATE if approximate else EXIT_RESIGNATION
            res = info.resignation if info is not None else None
        if joined is not None and joined > today:
            wf.future_join_date += 1
            joined = None
        if joined is not None and left is not None and left < joined:
            wf.exit_before_join += 1
            joined = None
        wf.people.append(
            Person(
                id=id_,
                code=code or "",
                name=f"{first or ''} {last or ''}".strip(),
                kind=kind if kind in ("staff", "production") else "other",
                active=active,
                gender=gender_bucket(gender),
                dob=dob,
                dept_id=dept,
                desig_id=desig,
                branch_id=branch,
                joined=joined,
                left=left,
                exit_basis=basis,
                reason_survey=(res.survey_q1_answer if res is not None else None),
                reason_text=(res.reason if res is not None else None),
                probation_end=prob,
                confirmed_on=conf,
            )
        )
    return wf


# ─── headcount on any day, from sorted dates ─────────────────────────────────────────────────────────────────


class Roll:
    """Who was on the rolls on any day, answered from the sorted join and exit dates (a binary search per question).

    ``headcount(d)`` = people who had joined by ``d`` + people with no usable join date - people who had left by ``d``.
    Everyone who has left by ``d`` either joined by then (so is in the first term) or is in the second, so nobody is
    subtracted twice; and a person who is still active never appears in the exit dates."""

    __slots__ = ("joins", "lefts", "unplaced")

    def __init__(self, people: list[Person]) -> None:
        self.joins = sorted(p.joined for p in people if p.joined is not None)
        self.lefts = sorted(p.left for p in people if p.left is not None)
        self.unplaced = sum(1 for p in people if p.joined is None)

    def headcount(self, day: date) -> int:
        return bisect_right(self.joins, day) + self.unplaced - bisect_right(self.lefts, day)

    def joined(self, start: date, end: date) -> int:
        return bisect_right(self.joins, end) - bisect_left(self.joins, start)

    def left(self, start: date, end: date) -> int:
        return bisect_right(self.lefts, end) - bisect_left(self.lefts, start)


def _clamped(period: Period, today: date) -> Period:
    """A period never reaches past today; one that has not started yet is empty (``days == 0``)."""
    if period.end <= today:
        return period
    return Period(period.start, max(today, period.start - timedelta(days=1)), period.preset, period.label)


@dataclass(frozen=True)
class Flow:
    """Joiners, leavers and headcount over one period."""

    start: date
    end: date
    days: int
    opening: int | None
    closing: int | None
    joiners: int
    leavers: int
    early: int  # leavers within EARLY_EXIT_DAYS of joining
    approximate: int  # leavers whose exit date is only approximate

    @property
    def net(self) -> int:
        return self.joiners - self.leavers

    @property
    def average(self) -> float | None:
        if self.opening is None or self.closing is None:
            return None
        return (self.opening + self.closing) / 2

    @property
    def attrition(self) -> float | None:
        return pct(self.leavers, self.average)

    @property
    def annualised(self) -> float | None:
        average = self.average
        if self.attrition is None or average is None or self.days < MIN_ANNUALISE_DAYS:
            return None
        # scaled from the exact rate, not the rounded one (rounding first is multiplied by up to 12); the Recruitment
        # page does the same, and tests_md_consistency keeps the two equal
        return round(100.0 * self.leavers / average * 365 / self.days, 1)

    @property
    def early_share(self) -> float | None:
        return pct(self.early, self.leavers)


def _is_early(p: Person) -> bool:
    return p.joined is not None and p.left is not None and (p.left - p.joined).days <= EARLY_EXIT_DAYS


def flow(people: list[Person], period: Period, roll: Roll | None = None) -> Flow:
    roll = roll or Roll(people)
    if period.days <= 0:
        return Flow(period.start, period.end, 0, None, None, 0, 0, 0, 0)
    leavers = [p for p in people if p.left is not None and period.start <= p.left <= period.end]
    return Flow(
        start=period.start,
        end=period.end,
        days=period.days,
        opening=roll.headcount(period.start - timedelta(days=1)),
        closing=roll.headcount(period.end),
        joiners=roll.joined(period.start, period.end),
        leavers=len(leavers),
        early=sum(1 for p in leavers if _is_early(p)),
        approximate=sum(1 for p in leavers if p.exit_basis == EXIT_APPROXIMATE),
    )


def _tenure_years(people: list[Person], on: date) -> tuple[float | None, int]:
    """(average tenure in years of the people on the rolls on ``on`` who can be placed, how many could not)."""
    days, unknown = [], 0
    for p in people:
        if p.left is not None and p.left <= on:
            continue
        if p.joined is None:
            unknown += 1
        elif p.joined <= on:
            days.append((on - p.joined).days)
    return (round(sum(days) / len(days) / 365.25, 1) if days else None), unknown


def _completed_years(joined: date, on: date) -> int:
    return age_on(joined, on) or 0


def _age_band(age: int | None) -> str | None:
    if age is None:
        return None
    for limit, label in zip((18, 26, 36, 46, 56), AGE_BANDS):
        if age < limit:
            return label
    return AGE_BANDS[-1]


def _tenure_band(years: int) -> str:
    for limit, label in zip((1, 3, 5, 10), TENURE_BANDS):
        if years < limit:
            return label
    return TENURE_BANDS[-1]


def _exit_bucket(p: Person) -> str:
    if p.joined is None or p.left is None:
        return "unknown"
    if (p.left - p.joined).days <= EARLY_EXIT_DAYS:
        return "early"
    years = _completed_years(p.joined, p.left)
    return "under1y" if years < 1 else "1to3" if years < 3 else "3to5" if years < 5 else "5plus"


def _limit(value: int | None, default: int = DEFAULT_LIMIT, maximum: int = MAX_LIMIT) -> int:
    return default if value is None else max(1, min(int(value), maximum))


def _within(period: Period) -> str:
    """The period as it reads inside a sentence: "in the last 12 months", "in Sep 2026", "this month", "yesterday"."""
    label = period.label
    if period.preset in ("month", "custom"):
        return f"in {label}"
    if period.preset in (
        "today",
        "yesterday",
        "this_week",
        "last_week",
        "this_month",
        "last_month",
        "this_year",
        "this_fy",
    ):
        return label.lower()
    return f"in the {label.lower()}"


def _iso(day: date | None) -> str | None:
    return day.isoformat() if day else None


def _data_notes(wf: Workforce) -> list[str]:
    notes = []
    unplaced = wf.unplaced
    if unplaced:
        notes.append(
            f"{unplaced:,} {'person has' if unplaced == 1 else 'people have'} a missing or unusable join date: they are "
            "counted as having been here since before the period, never as joiners, and have no tenure."
        )
    return notes


def _approximate_note(approximate: int, leavers: int) -> str:
    """One wording on every Employees endpoint, so the page (which shows the notes of several) says it once."""
    return (
        f"{approximate} of the {leavers} leavers in this period have only an approximate exit date (they were "
        "deactivated without a resignation, so the date the record last changed is used)."
    )


def _unit_scope_text(scope: Scope) -> list[str]:
    return [scope.describe()]


# ─── summary ─────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def summary(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """The headline figures: headcount today (staff vs production), joiners, leavers, net change, attrition %, average
    tenure and early attrition for the period, each against the previous period of the same length; plus the gender
    split and average age of the people here today."""
    today = today or ist_today()
    wf = load(scope, today)
    period = _clamped(period, today)
    previous = period.previous()
    roll = Roll(wf.people)
    now, before = flow(wf.people, period, roll), flow(wf.people, previous, roll)

    active = wf.active()
    kinds = Counter(p.kind for p in active)
    genders = Counter(p.gender for p in active)
    recorded = genders["male"] + genders["female"] + genders["other"]
    ages = [a for a in (age_on(p.dob, today) for p in active if p.dob) if a is not None]
    # tenure is read on the last day of each period, so "now" and "before" are the same question asked twice
    tenure_end, tenure_unknown = _tenure_years(wf.people, period.end if period.days > 0 else today)
    tenure_then = _tenure_years(wf.people, previous.end)[0] if previous.days > 0 else None
    on_rolls_at_end = (now.closing if now.closing is not None else len(active)) - tenure_unknown

    notes = _data_notes(wf)
    if period.days <= 0:
        notes.append("This period has not started yet, so there is nothing to count in it.")
    if now.approximate:
        notes.append(_approximate_note(now.approximate, now.leavers))

    provenance = [
        prov(
            "headcount",
            "Active headcount",
            dataset="Employee records",
            definition="Everyone whose status is Active today. Staff and production follow the employee type.",
            formula="count of employees with status = active",
            rows=len(wf.people),
            filters=_unit_scope_text(scope),
        ),
        prov(
            "reconstructed-headcount",
            "Headcount at the start and end of the period",
            dataset="Employee records (join dates) and resignations (exit dates)",
            definition="Rebuilt for the start and end of the period: people who had joined by then and had not yet left.",
            formula="joined by the day - left by the day",
            rows=len(wf.people),
            caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_JOIN_DATES, CAVEAT_EXIT_DATES],
        ),
        prov(
            "joiners-leavers",
            "Joiners, leavers and net change",
            dataset="Employee records and resignations",
            definition="Joiners have a join date in the period; leavers have an exit date in the period. Both include "
            "the first and last day. Net change is joiners minus leavers.",
            formula="net = joiners - leavers (opening headcount + net = closing headcount)",
            rows=now.joiners + now.leavers,
            caveats=[CAVEAT_EXIT_DATES, CAVEAT_JOIN_DATES, "People deleted from the system are not counted anywhere."],
        ),
        prov(
            "attrition",
            "Attrition %",
            dataset="Employee records and resignations",
            definition="The share of the workforce that left in the period, against the average headcount of the period. "
            "It is not scaled to a year unless labelled so.",
            formula="leavers ÷ ((opening headcount + closing headcount) ÷ 2) × 100. "
            f"Annualised (only for periods of {MIN_ANNUALISE_DAYS}+ days) = attrition × 365 ÷ days in the period.",
            rows=now.leavers,
            caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_EXIT_DATES, CAVEAT_EXIT_RATE],
        ),
        prov(
            "tenure",
            "Average tenure",
            dataset="Employee records (join dates)",
            definition="How long the people on the rolls on the last day of the period have been with the company, on "
            "average, counting people whose join date is usable. The comparison is the workforce on the last day of "
            "the previous period.",
            formula="sum of (last day - join date) in days ÷ 365.25 ÷ people counted",
            rows=on_rolls_at_end,
            caveats=[CAVEAT_JOIN_DATES],
        ),
        prov(
            "early-attrition",
            "Early attrition",
            dataset="Employee records and resignations",
            definition=f"Leavers in the period who left {EARLY_EXIT_DAYS} days or fewer after joining.",
            formula=f"leavers with (exit date - join date) <= {EARLY_EXIT_DAYS} days; share = these ÷ all leavers",
            rows=now.leavers,
            caveats=[CAVEAT_EXIT_DATES, "People with no usable join date cannot be tested and are not counted."],
        ),
        prov(
            "gender-age",
            "Gender split and average age",
            dataset="Employee records (gender, date of birth)",
            definition="Of the people here today. The share is taken over those with a gender recorded; age is in "
            "completed years from the date of birth, over those who have one.",
            formula="women ÷ people with a gender recorded × 100; average of completed years",
            rows=len(active),
            caveats=[
                text
                for missing, text in (
                    (genders["unspecified"], f"{genders['unspecified']:,} of {len(active):,} have no gender recorded."),
                    (len(active) - len(ages), f"{len(active) - len(ages):,} of {len(active):,} have no date of birth."),
                )
                if missing
            ],
        ),
    ]
    return envelope(
        {
            "asOf": today.isoformat(),
            "headcount": {
                "current": len(active),
                "staff": kinds["staff"],
                "production": kinds["production"],
                "other": kinds["other"],
                "opening": now.opening,
                "closing": now.closing,
                "change": change(now.closing, now.opening),
            },
            "joiners": {
                "count": now.joiners,
                "previous": before.joiners,
                "change": change(now.joiners, before.joiners),
            },
            "leavers": {
                "count": now.leavers,
                "previous": before.leavers,
                "change": change(now.leavers, before.leavers),
                "approximate": now.approximate,
            },
            "net": {"count": now.net, "previous": before.net, "change": change(now.net, before.net)},
            "attrition": {
                "pct": now.attrition,
                "annualisedPct": now.annualised,
                "averageHeadcount": None if now.average is None else round(now.average, 1),
                "previousPct": before.attrition,
                "change": change(now.attrition, before.attrition),
            },
            "tenure": {
                "averageYears": tenure_end,
                "previousYears": tenure_then,
                "change": change(tenure_end, tenure_then),
                "unknown": tenure_unknown,
            },
            "earlyAttrition": {
                "count": now.early,
                "pctOfLeavers": now.early_share,
                "previous": before.early,
                "change": change(now.early, before.early),
            },
            "gender": {
                "male": genders["male"],
                "female": genders["female"],
                "other": genders["other"],
                "unspecified": genders["unspecified"],
                "recorded": recorded,
                "femalePct": pct(genders["female"], recorded),
            },
            "age": {"average": round(sum(ages) / len(ages), 1) if ages else None, "known": len(ages)},
            "previousPeriod": previous.to_json(),
            "dataQuality": {
                "noJoinDate": wf.no_join_date,
                "futureJoinDate": wf.future_join_date,
                "exitBeforeJoin": wf.exit_before_join,
                "unplaced": wf.unplaced,
            },
        },
        period=period,
        scope=scope,
        provenance=provenance,
        notes=notes,
    )


# ─── composition ─────────────────────────────────────────────────────────────────────────────────────────────


def _share_rows(counts: dict[str, int], total: int, order: tuple[str, ...] | None = None) -> list[dict]:
    keys = list(order) if order else sorted(counts, key=lambda k: (-counts[k], k))
    return [{"label": k, "count": counts.get(k, 0), "pct": pct(counts.get(k, 0), total)} for k in keys]


def _top_rows(rows: list[dict], limit: int, sum_keys: tuple[str, ...] = ()) -> list[dict]:
    """The ``limit`` biggest rows, then one "Other" row for the rest (so the chart stays readable)."""
    rows = sorted(rows, key=lambda r: (-r["count"], r["label"]))
    head, rest = rows[:limit], rows[limit:]
    if rest:
        other = {"id": None, "label": f"Other ({len(rest)})", "count": sum(r["count"] for r in rest), "other": True}
        for key in sum_keys:
            other[key] = sum(r[key] for r in rest)
        head.append(other)
    return head


def _staffing(scope: Scope, wf: Workforce) -> tuple[list[dict], dict, list[str]]:
    """Planned vs actual STAFF per department (the plan on the Required Roles page counts staff, not production)."""
    notes: list[str] = []
    if scope.employment_type == "production":
        empty = {"required": 0, "actual": 0, "vacancies": 0, "departmentsBelow": 0}
        return [], empty, ["The staffing plan covers staff only, so it is not shown for production."]
    plans = DepartmentHeadcount.objects.filter(required_count__gt=0)
    if scope.branch_ids:
        plans = plans.filter(department__branch_id__in=scope.branch_ids)
    if scope.department_ids:
        plans = plans.filter(department_id__in=scope.department_ids)
    actual = Counter(p.dept_id for p in wf.active() if p.kind == "staff")
    rows = []
    for dept_id, required in plans.values_list("department_id", "required_count"):
        have = actual.get(dept_id, 0)
        rows.append(
            {
                "departmentId": dept_id,
                "label": wf.lookups.dept(dept_id),
                "unit": wf.lookups.dept_unit(dept_id),
                "required": required,
                "actual": have,
                "gap": required - have,
                "fillPct": pct(have, required),
            }
        )
    rows.sort(key=lambda r: (-r["gap"], r["label"]))
    totals = {
        "required": sum(r["required"] for r in rows),
        "actual": sum(r["actual"] for r in rows),
        "vacancies": sum(max(0, r["gap"]) for r in rows),
        "departmentsBelow": sum(1 for r in rows if r["gap"] > 0),
    }
    if not rows:
        notes.append(
            "No required headcount is set for these departments (Recruitment, Required Roles), so staffing gaps "
            "cannot be shown."
        )
    return rows, totals, notes


@cached()
def composition(scope: Scope, *, limit: int = 8, today: date | None = None) -> dict:
    """How the people here TODAY are made up: staff / production, unit, department, designation, gender, age band and
    length of service, plus planned vs actual staff per department where a plan is set."""
    today = today or ist_today()
    limit = _limit(limit, 8)
    wf = load(scope, today)
    lk = wf.lookups
    people = wf.active()
    total = len(people)

    def with_pct(rows: list[dict]) -> list[dict]:
        for r in rows:
            r["pct"] = pct(r["count"], total)
        return rows

    kinds = Counter(p.kind for p in people)
    by_type = [
        {"key": k, "label": label, "count": kinds[k], "pct": pct(kinds[k], total)}
        for k, label in (("staff", "Staff"), ("production", "Production"), ("other", "Other"))
        if kinds[k] or k != "other"
    ]

    units: dict[int | None, dict] = {}
    depts: dict[int | None, dict] = {}
    desigs: dict[str, dict] = {}
    for p in people:
        unit = units.setdefault(
            p.branch_id, {"id": p.branch_id, "label": lk.unit(p.branch_id), "count": 0, "staff": 0, "production": 0}
        )
        dept = depts.setdefault(
            p.dept_id,
            {
                "id": p.dept_id,
                "label": lk.dept(p.dept_id),
                "unit": lk.dept_unit(p.dept_id),
                "count": 0,
                "staff": 0,
                "production": 0,
            },
        )
        title = (lk.desig(p.desig_id) or "No designation").strip()
        desig = desigs.setdefault(title.lower(), {"id": None, "label": title, "count": 0})
        for row in (unit, dept):
            row["count"] += 1
            if p.kind in ("staff", "production"):
                row[p.kind] += 1
        desig["count"] += 1

    genders = Counter(p.gender for p in people)
    gender_labels = (("male", "Male"), ("female", "Female"), ("other", "Other"), ("unspecified", "Not recorded"))
    by_gender = [
        {"key": k, "label": label, "count": genders[k], "pct": pct(genders[k], total)}
        for k, label in gender_labels
        if genders[k]
    ]
    ages = Counter(_age_band(age_on(p.dob, today)) or "Not recorded" for p in people)
    tenures = Counter(_tenure_band(_completed_years(p.joined, today)) if p.joined else "Not known" for p in people)
    staffing, staffing_totals, staffing_notes = _staffing(scope, wf)

    notes = _data_notes(wf) + staffing_notes
    return envelope(
        {
            "asOf": today.isoformat(),
            "total": total,
            "byType": by_type,
            "byUnit": with_pct(sorted(units.values(), key=lambda r: (-r["count"], r["label"]))),
            "byDepartment": with_pct(_top_rows(list(depts.values()), limit, ("staff", "production"))),
            "departmentsTotal": len(depts),
            "byDesignation": with_pct(_top_rows(list(desigs.values()), limit)),
            "designationsTotal": len(desigs),
            "byGender": by_gender,
            "byAgeBand": _share_rows(ages, total, (*AGE_BANDS, "Not recorded")),
            "byTenureBand": _share_rows(tenures, total, (*TENURE_BANDS, "Not known")),
            "staffing": {"rows": staffing, **staffing_totals, "planned": bool(staffing)},
        },
        scope=scope,
        provenance=[
            prov(
                "composition",
                "Workforce composition",
                dataset="Employee records",
                definition="The people who are Active today, split by employee type, unit, department, designation, "
                "gender, age and length of service. The biggest groups are shown and the rest are added up as 'Other'.",
                formula="count of active employees in each group ÷ all active employees × 100",
                rows=total,
                filters=_unit_scope_text(scope),
                caveats=[CAVEAT_DEPARTMENTS, CAVEAT_JOIN_DATES],
            ),
            prov(
                "age-tenure-bands",
                "Age and length of service",
                dataset="Employee records (date of birth, join date)",
                definition="Age and service are in completed years on today's date. People with no date of birth, or "
                "no usable join date, are listed as 'Not recorded' / 'Not known'.",
                formula="completed years between the date and today",
                rows=total,
            ),
            prov(
                "staffing-plan",
                "Planned vs actual staff",
                dataset="Required headcount (Recruitment, Required Roles) and employee records",
                definition="Each department's planned number of staff against the active STAFF working there today. "
                "The plan counts staff only; production is not part of it. Departments with no plan are left out.",
                formula="gap = planned - active staff (positive = vacancies); filled % = active staff ÷ planned × 100",
                rows=len(staffing),
                caveats=["A department's plan is a number somebody typed in: it is only as current as that entry."],
            ),
        ],
        notes=notes,
    )


# ─── movement over time ──────────────────────────────────────────────────────────────────────────────────────


def _grain_for(days: int) -> str:
    return "day" if days <= 14 else "week" if days <= 100 else "month"


def _day_text(day: date) -> str:
    return f"{day.day:02d} {_MONTH_ABBR[day.month - 1]}"


def _buckets(start: date, end: date, grain: str) -> list[tuple[str, str, date, date]]:
    """(key, label, first day, last day) of each step of a period, the first and last clipped to the period."""
    out: list[tuple[str, str, date, date]] = []
    if end < start:
        return out
    if grain == "day":
        day = start
        while day <= end:
            out.append((day.isoformat(), _day_text(day), day, day))
            day += timedelta(days=1)
    elif grain == "week":
        day = start
        while day <= end:
            last = min(day + timedelta(days=6), end)
            out.append((day.isoformat(), f"{_day_text(day)} - {_day_text(last)}", day, last))
            day = last + timedelta(days=1)
    else:
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            first, last = month_bounds(year, month)
            out.append((f"{year}-{month:02d}", month_label(year, month), max(first, start), min(last, end)))
            year, month = add_months(year, month, 1)
    return out


@cached()
def movement(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Joiners, leavers, net change and reconstructed headcount over the period, in day / week / month steps
    (a short period is shown in finer steps so there is something to read)."""
    today = today or ist_today()
    wf = load(scope, today)
    period = _clamped(period, today)
    roll = Roll(wf.people)
    grain = _grain_for(max(period.days, 1))
    points = []
    for key, label, first, last in _buckets(period.start, period.end, grain):
        joiners, leavers = roll.joined(first, last), roll.left(first, last)
        points.append(
            {
                "key": key,
                "label": label,
                "start": first.isoformat(),
                "end": last.isoformat(),
                "joiners": joiners,
                "leavers": leavers,
                "net": joiners - leavers,
                "headcount": roll.headcount(last),
            }
        )
    whole = flow(wf.people, period, roll)
    notes = _data_notes(wf)
    if period.days <= 0:
        notes.append("This period has not started yet, so there is nothing to count in it.")
    if whole.approximate:
        notes.append(_approximate_note(whole.approximate, whole.leavers))
    return envelope(
        {
            "grain": grain,
            "points": points,
            "totals": {
                "joiners": whole.joiners,
                "leavers": whole.leavers,
                "net": whole.net,
                "opening": whole.opening,
                "closing": whole.closing,
            },
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "movement",
                "Joiners, leavers and headcount over time",
                dataset="Employee records (join dates) and resignations (exit dates)",
                definition="For each step of the period: people who joined, people who left, the difference, and the "
                "headcount at the end of the step. A short period is shown by day or week, a longer one by month.",
                formula="headcount at the end of a step = joined by then - left by then; net = joiners - leavers",
                rows=whole.joiners + whole.leavers,
                filters=[f"Steps: {grain}", *_unit_scope_text(scope)],
                caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_EXIT_DATES, CAVEAT_JOIN_DATES, CAVEAT_DEPARTMENTS],
            )
        ],
        notes=notes,
    )


# ─── attrition ───────────────────────────────────────────────────────────────────────────────────────────────


def _group_rows(
    groups: dict[Any, list[Person]], period: Period, label_of: Callable[[Any], str], extra_of: Callable | None = None
) -> list[dict]:
    """Attrition per group: leavers against the group's own average headcount over the period."""
    rows = []
    for key, members in groups.items():
        f = flow(members, period)
        row = {
            "id": key,
            "label": label_of(key),
            "leavers": f.leavers,
            "averageHeadcount": None if f.average is None else round(f.average, 1),
            "attritionPct": f.attrition,
            "opening": f.opening,
            "closing": f.closing,
        }
        if extra_of:
            row.update(extra_of(key))
        rows.append(row)
    return rows


def _rank(rows: list[dict]) -> list[dict]:
    """Highest attrition first; a group with no rate (no one on the rolls) goes last."""
    return sorted(rows, key=lambda r: (r["attritionPct"] is None, -(r["attritionPct"] or 0), -r["leavers"], r["label"]))


def _is_hotspot(row_rate: float | None, leavers: int, average: float | None, company_rate: float | None) -> bool:
    """Well above the company's attrition, with enough people involved for it to mean something."""
    return bool(
        company_rate
        and row_rate is not None
        and leavers >= HOTSPOT_MIN_LEAVERS
        and (average or 0) >= HOTSPOT_MIN_AVERAGE
        and row_rate >= HOTSPOT_FACTOR * company_rate
    )


def _reason_key(p: Person) -> str:
    """The reason group of a leaver; only a resignation carries words, a plain deactivation has none on file."""
    return classify_reason(p.reason_survey, p.reason_text) if p.exit_basis == EXIT_RESIGNATION else "none"


def _early_item(p: Person, wf: Workforce) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "code": p.code,
        "department": wf.lookups.dept(p.dept_id),
        "designation": wf.lookups.desig(p.desig_id),
        "unit": wf.lookups.unit(p.branch_id),
        "joined": _iso(p.joined),
        "left": _iso(p.left),
        "days": (p.left - p.joined).days if p.joined and p.left else None,
        "reason": REASON_LABELS[_reason_key(p)],
        "approximate": p.exit_basis == EXIT_APPROXIMATE,
    }


@cached()
def attrition(scope: Scope, period: Period, *, limit: int = DEFAULT_LIMIT, today: date | None = None) -> dict:
    """Where people leave from and why, in the period: attrition by department, unit and employee type, hot-spot
    departments, how long leavers stayed, the reasons they gave (grouped) and the people who left within 90 days."""
    today = today or ist_today()
    limit = _limit(limit)
    wf = load(scope, today)
    lk = wf.lookups
    period = _clamped(period, today)
    company = flow(wf.people, period)
    leavers = [p for p in wf.people if p.left is not None and period.start <= p.left <= period.end]
    approx = sum(1 for p in leavers if p.exit_basis == EXIT_APPROXIMATE)

    by_dept_groups: dict[int | None, list[Person]] = defaultdict(list)
    by_unit_groups: dict[int | None, list[Person]] = defaultdict(list)
    by_kind_groups: dict[str, list[Person]] = defaultdict(list)
    for p in wf.people:
        by_dept_groups[p.dept_id].append(p)
        by_unit_groups[p.branch_id].append(p)
        by_kind_groups[p.kind].append(p)

    dept_rows = _group_rows(by_dept_groups, period, lk.dept, lambda k: {"unit": lk.dept_unit(k)})
    company_rate = company.attrition
    for row in dept_rows:
        row["hotspot"] = _is_hotspot(row["attritionPct"], row["leavers"], row["averageHeadcount"], company_rate)
    with_leavers = _rank([r for r in dept_rows if r["leavers"] > 0])
    # every unit that had people in the period, so "Unit 2: 0%" is visible next to "Unit 1: 12%"
    unit_rows = _rank(
        [
            r
            for r in _group_rows(by_unit_groups, period, lk.unit)
            if r["leavers"] > 0 or (r["averageHeadcount"] or 0) > 0
        ]
    )
    kind_labels = {"staff": "Staff", "production": "Production", "other": "Other"}
    kind_rows = _rank(
        [r for r in _group_rows(by_kind_groups, period, kind_labels.get) if r["leavers"] > 0 or r["id"] != "other"]
    )

    buckets = Counter(_exit_bucket(p) for p in leavers)
    reason_counts = Counter(_reason_key(p) for p in leavers)
    reasons = [
        {"key": k, "label": REASON_LABELS[k], "count": n, "pct": pct(n, len(leavers))}
        for k, n in sorted(reason_counts.items(), key=lambda kv: (kv[0] == "none", kv[0] == "other", -kv[1], kv[0]))
    ]
    early = sorted((p for p in leavers if _is_early(p)), key=lambda p: (p.left, p.name), reverse=True)

    return envelope(
        {
            "company": {
                "leavers": company.leavers,
                "averageHeadcount": None if company.average is None else round(company.average, 1),
                "attritionPct": company.attrition,
                "annualisedPct": company.annualised,
            },
            "byDepartment": with_leavers[:limit],
            "departmentsWithLeavers": len(with_leavers),
            "departmentsTotal": len(dept_rows),
            "byUnit": unit_rows[:limit],
            "byType": kind_rows,
            "hotspots": [r for r in with_leavers if r["hotspot"]][:5],
            "tenureAtExit": [
                {"key": k, "label": label, "count": buckets[k], "pct": pct(buckets[k], len(leavers))}
                for k, label in EXIT_BUCKETS
                if buckets[k] or k != "unknown"
            ],
            "reasons": reasons,
            "early": {
                "count": len(early),
                "pctOfLeavers": pct(len(early), len(leavers)),
                "items": [_early_item(p, wf) for p in early[:limit]],
            },
            "approximateExits": approx,
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "attrition-by-group",
                "Attrition by department, unit and employee type",
                dataset="Employee records and resignations",
                definition="Each group's leavers in the period against that group's own average headcount. A "
                f"department is flagged a hot-spot when its attrition is at least {HOTSPOT_FACTOR}x the company's, "
                f"with at least {HOTSPOT_MIN_LEAVERS} leavers and an average headcount of {HOTSPOT_MIN_AVERAGE}+.",
                formula="leavers ÷ ((opening + closing headcount) ÷ 2) × 100, for each group",
                rows=len(leavers),
                filters=_unit_scope_text(scope),
                caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_EXIT_DATES, CAVEAT_DEPARTMENTS, CAVEAT_EXIT_RATE],
            ),
            prov(
                "tenure-at-exit",
                "How long people stayed",
                dataset="Employee records and resignations",
                definition=f"Time between the join date and the exit date of each leaver: within {EARLY_EXIT_DAYS} "
                "days, then in completed years. Leavers with no usable join date are 'Not known'.",
                formula="exit date - join date",
                rows=len(leavers),
                caveats=[CAVEAT_EXIT_DATES, CAVEAT_JOIN_DATES],
            ),
            prov(
                "leaving-reasons",
                "Why people leave",
                dataset="Resignation requests (reason and exit survey)",
                definition="What the person wrote as the main reason (exit survey, else the resignation reason) grouped "
                "by keyword into a few plain headings. People deactivated without a resignation have no reason on file.",
                formula="count of leavers per group ÷ all leavers × 100",
                rows=len(leavers),
                caveats=[
                    "The reasons are free writing, so the grouping is a keyword match, not a coded field: read it as a "
                    "guide. A person appears in one group only (the first that matches).",
                ],
            ),
            prov(
                "early-leavers",
                "Left within 90 days",
                dataset="Employee records and resignations",
                definition=f"Leavers in the period who left {EARLY_EXIT_DAYS} days or fewer after joining, most "
                "recent first. People are named because this is an exception list.",
                formula=f"exit date - join date <= {EARLY_EXIT_DAYS} days",
                rows=len(early),
                caveats=[CAVEAT_EXIT_DATES],
            ),
        ],
        notes=_data_notes(wf)
        + ([_approximate_note(approx, len(leavers))] if approx else [])
        + (["This period has not started yet, so there is nothing to count in it."] if period.days <= 0 else []),
    )


# ─── milestones: the human side ──────────────────────────────────────────────────────────────────────────────


@cached()
def milestones(
    scope: Scope,
    *,
    days: int = 30,
    limit: int = DEFAULT_LIMIT,
    birthday_days: int = 7,
    birthday_names: bool = True,
    today: date | None = None,
) -> dict:
    """Work anniversaries of 5+ years in the next ``days`` days, birthdays in the next ``birthday_days`` days and
    probation due, for the people here today. Birthdays show the day and month only, never the age; with
    ``birthday_names=False`` (what the assistant gets: it is never sent dates of birth) they are only counted."""
    today = today or ist_today()
    limit = _limit(limit)
    days = max(1, min(int(days), 90))
    birthday_days = max(1, min(int(birthday_days), 30))
    wf = load(scope, today)
    lk = wf.lookups
    people = wf.active()
    window_end = today + timedelta(days=days - 1)
    birthday_end = today + timedelta(days=birthday_days - 1)

    def card(p: Person, **extra: Any) -> dict:
        return {
            "id": p.id,
            "name": p.name,
            "code": p.code,
            "department": lk.dept(p.dept_id),
            "designation": lk.desig(p.desig_id),
            **extra,
        }

    anniversaries = []
    for p in people:
        if p.joined is None:
            continue
        when = occurrence_in_window(p.joined.month, p.joined.day, today, window_end)
        if when is not None and when.year - p.joined.year >= LONG_SERVICE_YEARS:
            anniversaries.append((when, when.year - p.joined.year, p))
    anniversaries.sort(key=lambda t: (t[0], -t[1], t[2].name))

    birthdays = []
    with_dob = 0
    for p in people:
        if p.dob is None:
            continue
        with_dob += 1
        when = occurrence_in_window(p.dob.month, p.dob.day, today, birthday_end)
        if when is not None:
            birthdays.append((when, p))
    birthdays.sort(key=lambda t: (t[0], t[1].name))

    recorded = [p for p in people if p.probation_end is not None]
    unconfirmed = [p for p in recorded if p.confirmed_on is None or p.confirmed_on > today]
    soon = sorted(
        (p for p in unconfirmed if today <= p.probation_end <= today + timedelta(days=PROBATION_SOON_DAYS)),
        key=lambda p: (p.probation_end, p.name),
    )
    overdue = [p for p in unconfirmed if p.probation_end < today]

    notes = _data_notes(wf)
    if not recorded:
        notes.append("No probation end dates are recorded for the people here today, so probation cannot be shown.")
    if people and with_dob < len(people):
        notes.append(
            f"{len(people) - with_dob:,} of {len(people):,} people have no date of birth, so their birthday is not listed."
        )
    return envelope(
        {
            "asOf": today.isoformat(),
            "windowDays": days,
            "anniversaries": {
                "minYears": LONG_SERVICE_YEARS,
                "total": len(anniversaries),
                "today": sum(1 for when, _y, _p in anniversaries if when == today),
                "items": [
                    card(p, date=when.isoformat(), years=years, joined=p.joined.isoformat())
                    for when, years, p in anniversaries[:limit]
                ],
            },
            "birthdays": {
                "windowDays": birthday_days,
                "total": len(birthdays),
                "items": [card(p, date=when.isoformat()) for when, p in birthdays[:limit]] if birthday_names else [],
                "namesWithheld": not birthday_names,
            },
            "probation": {
                "recorded": len(recorded),
                "dueSoonDays": PROBATION_SOON_DAYS,
                "dueSoon": len(soon),
                "pendingConfirmation": len(overdue),
                "items": [card(p, date=p.probation_end.isoformat()) for p in soon[:limit]],
            },
        },
        scope=scope,
        provenance=[
            prov(
                "anniversaries",
                "Work anniversaries",
                dataset="Employee records (join dates)",
                definition=f"People here today whose join-date anniversary falls in the next {days} days and who "
                f"complete {LONG_SERVICE_YEARS} or more years of service on it.",
                formula="years = year of the anniversary - year of joining",
                rows=len(anniversaries),
                caveats=["A 29 February join date is marked on 28 February in other years.", CAVEAT_JOIN_DATES],
            ),
            prov(
                "birthdays",
                "Birthdays",
                dataset="Employee records (date of birth)",
                definition=f"People here today whose birthday falls in the next {birthday_days} days. Only the day and "
                "month are shown.",
                rows=len(birthdays),
                caveats=["People with no date of birth on file cannot be listed."],
            ),
            prov(
                "probation",
                "Probation and confirmation",
                dataset="Employee records (probation end date, confirmation date)",
                definition=f"People whose recorded probation ends within {PROBATION_SOON_DAYS} days and who are not "
                "confirmed yet; and people whose probation has ended but who are not confirmed.",
                rows=len(recorded),
                caveats=["Only recorded dates are used: no probation policy is applied to people with no date."],
            ),
        ],
        notes=notes,
    )


# ─── the people directory ────────────────────────────────────────────────────────────────────────────────────

#: What each ``sort`` orders by first (ties fall back to name, then code). ``joined`` uses the TEXT join date, which sorts
#: correctly only while it is written as YYYY-MM-DD (the format the app stores); an empty one is treated as missing.
DIRECTORY_SORTS = {
    "name": Lower("first_name"),
    "code": F("employee_code"),
    "department": Lower("department__name"),
    "joined": F("join_date_clean"),
}


def _exit_dates(rows: list[tuple], today: date) -> dict[int, date]:
    """{employee id: exit date (never after today)} for the people who are not active among
    (id, join_date, updated_at, status) rows: one query for all of them."""
    stubs = [SimpleNamespace(id=r[0], join_date=r[1], updated_at=r[2]) for r in rows if (r[3] or "") != "active"]
    return {emp_id: min(info.when or today, today) for emp_id, info in exit_infos(stubs).items()}


def directory(
    scope: Scope,
    *,
    query: str | None = None,
    status: str = "active",
    designation: str | None = None,
    sort: str = "name",
    descending: bool = False,
    page: int = 1,
    page_size: int = 25,
    today: date | None = None,
) -> dict:
    """A page of people (no salary): name, code, designation, department, unit, join date, tenure and status. ``query``
    matches name or code word by word; ``status`` is active | inactive | all."""
    today = today or ist_today()
    status = (status or "active").strip().lower()
    if status not in ("active", "inactive", "all"):
        raise MdParamError("'status' must be active, inactive or all.")
    if sort not in DIRECTORY_SORTS:
        raise MdParamError(f"'sort' must be one of: {', '.join(DIRECTORY_SORTS)}.")
    page_size = max(1, min(int(page_size), 100))
    page = max(1, int(page))

    in_status = scope.employees(active=None if status == "all" else status == "active")
    qs = in_status
    for word in (query or "").split():
        qs = qs.filter(
            Q(first_name__icontains=word)
            | Q(last_name__icontains=word)
            | Q(employee_code__icontains=word)
            | Q(unit_code__icontains=word)
        )
    designation = (designation or "").strip()
    if designation:
        if designation.isdigit():
            qs = qs.filter(designation_id=int(designation))
        else:
            qs = qs.filter(designation__title__iexact=designation)
    total = qs.count()
    pages = max(1, -(-total // page_size))
    page = min(page, pages)

    first_key = DIRECTORY_SORTS[sort]
    first_key = first_key.desc(nulls_last=True) if descending else first_key.asc(nulls_last=True)
    rows = list(
        qs.annotate(join_date_clean=NullIf("join_date", Value("")))
        .order_by(first_key, Lower("first_name"), Lower("last_name"), "employee_code")
        .values_list(
            "id",
            "employee_code",
            "first_name",
            "last_name",
            "designation_id",
            "department_id",
            "branch_id",
            "employment_type",
            "status",
            "join_date",
            "updated_at",
        )[(page - 1) * page_size : page * page_size]
    )
    lk = load_lookups()
    exits = _exit_dates([(r[0], r[9], r[10], r[8]) for r in rows], today)
    people = []
    for id_, code, first, last, desig, dept, branch, kind, state, join_raw, _updated in rows:
        joined, _state = join_date_of(SimpleNamespace(join_date=join_raw))
        end = exits.get(id_, today)
        months = months_between(joined, end) if joined and joined <= end else None
        people.append(
            {
                "id": id_,
                "name": f"{first or ''} {last or ''}".strip(),
                "code": code,
                "designation": lk.desig(desig),
                "department": lk.dept(dept) if dept else None,
                "unit": lk.unit(branch) if branch else None,
                "type": (kind or "").strip().lower() or None,
                "joinDate": _iso(joined),
                "tenure": tenure_text(months),
                "tenureYears": round(months / 12, 1) if months is not None else None,
                "status": "inactive" if id_ in exits else "active",
                "leftOn": _iso(exits.get(id_)),
            }
        )
    titles = (
        in_status.filter(designation_id__isnull=False)
        .order_by()
        .values("designation__title")
        .annotate(n=Count("id"))
        .order_by("-n", "designation__title")[:80]
    )
    return envelope(
        {
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": pages,
            "rows": people,
            "options": {"designations": [t["designation__title"] for t in titles]},
        },
        scope=scope,
        provenance=[
            prov(
                "directory",
                "People directory",
                dataset="Employee records",
                definition="The people matching the search and filters, one page at a time. No pay is shown. Tenure runs "
                "to today for people who are here and to the exit date for people who have left.",
                formula="tenure = completed months between the join date and today (or the exit date)",
                rows=total,
                filters=[
                    f"Status: {status}",
                    *([f"Search: {query}"] if (query or "").strip() else []),
                    *([f"Designation: {designation}"] if designation else []),
                    *_unit_scope_text(scope),
                ],
                caveats=[CAVEAT_EXIT_DATES],
            )
        ],
    )


# ─── one person (the side sheet) ─────────────────────────────────────────────────────────────────────────────

PROFILE_ATTENDANCE_DAYS = 90


class _OneEmployee:
    """What the Report Center's attendance ``Roster`` wants of a report context: a filter for 'this employee'."""

    def __init__(self, employee_id: int) -> None:
        self.employee_id = employee_id

    def emp_q(self, prefix: str = "") -> Q:
        return Q(**{f"{prefix}id": self.employee_id})


def _attendance_last_90(emp: Employee, left: date | None, today: date) -> dict:
    """Attendance over the 90 completed days before today (or up to the exit date), read the way the Report Center's
    absenteeism report reads the stored day records: only days the person was SCHEDULED to work count (staff: not
    Sundays, Saturday-off Saturdays or holidays; production: not holidays or Sundays), approved leave is left out of the
    percentage, and a day with no stored record is neither present nor absent."""
    from ...reporting.definitions.attendance_analysis_common import (  # imported here: it pulls in payroll code
        ABSENT,
        HALF,
        LEAVE,
        PRESENT,
        Roster,
        classify_day,
    )

    end = min(today - timedelta(days=1), left) if left else today - timedelta(days=1)
    start = end - timedelta(days=PROFILE_ATTENDANCE_DAYS - 1)
    by_day = {r.date: r for r in AttendanceDayRecord.objects.filter(employee_id=emp.id, date__range=(start, end))}
    roster = Roster(_OneEmployee(emp.id), start, end)
    month_days: dict[tuple[int, int], set[date]] = {}

    def scheduled(day: date) -> bool:
        if emp.employment_type == "production":
            return roster.holiday_name(day) is None and day.weekday() != 6
        if (day.year, day.month) not in month_days:
            month_days[(day.year, day.month)] = set(roster.working_days(emp.id, day.year, day.month))
        return day in month_days[(day.year, day.month)]

    counts: Counter = Counter()
    late = 0
    for day, rec in by_day.items():
        kind = classify_day(rec, emp, roster, today, production_sunday_off=True)
        if kind in (PRESENT, HALF, ABSENT, LEAVE) and scheduled(day):
            counts[kind] += 1
            late += bool(rec.is_late) and kind in (PRESENT, HALF)
    joined, _state = join_date_of(emp)
    elapsed = max(0, (end - (max(start, joined) if joined else start)).days + 1)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "attendancePct": pct(counts[PRESENT] + 0.5 * counts[HALF], counts[PRESENT] + counts[HALF] + counts[ABSENT]),
        "presentDays": counts[PRESENT],
        "halfDays": counts[HALF],
        "absentDays": counts[ABSENT],
        "leaveDays": counts[LEAVE],
        "lateDays": late,
        "recordedDays": len(by_day),
        "coveragePct": pct(len(by_day), elapsed),
    }


def _documents_on_file(emp: Employee) -> dict:
    """How many of the required documents (the list the Documents page tracks) have a file: counts and category names
    only, never the files."""
    from ...employee_documents_views import _required_categories  # the one list of what is required

    required = _required_categories((emp.employment_type or "").strip().lower())
    present = set(
        EmployeeDocument.objects.filter(employee_id=emp.id, category__in=required).values_list("category", flat=True)
    )
    names = dict(EmployeeDocument.CATEGORY_CHOICES)
    return {
        "required": len(required),
        "onFile": sum(1 for c in required if c in present),
        "missing": [names.get(c, c) for c in required if c not in present],
    }


def _profile_history(
    emp: Employee, joined: date | None, left: date | None, basis: str | None, reason: str | None, lk: Lookups
) -> list[dict]:
    events: list[dict] = []
    if joined:
        events.append({"type": "joined", "date": joined.isoformat(), "title": "Joined the company", "detail": None})
    for p in Promotion.objects.filter(employee_id=emp.id).select_related(
        "previous_department", "previous_designation", "new_department", "new_designation"
    ):
        moved = []
        if p.new_designation_id and p.new_designation_id != p.previous_designation_id:
            moved.append(f"Promoted to {p.new_designation.title}")
        if p.new_department_id and p.new_department_id != p.previous_department_id:
            moved.append(f"Moved to {lk.dept(p.new_department_id)}")
        before = " · ".join(
            x
            for x in (
                p.previous_designation.title if p.previous_designation_id else None,
                lk.dept(p.previous_department_id) if p.previous_department_id else None,
            )
            if x
        )
        events.append(
            {
                "type": "promotion",
                "date": p.effective_date.isoformat(),
                "title": " · ".join(moved) or "Role change",
                "detail": f"From {before}" if before else None,
            }
        )
    for inc in SalaryIncrement.objects.filter(employee_id=emp.id).only("effective_date", "percent"):
        # only the percentage: the MD's Employees page never shows what anybody is paid
        events.append(
            {
                "type": "increment",
                "date": inc.effective_date.isoformat(),
                "title": "Increment given",
                "detail": f"{float(inc.percent):g}%",
            }
        )
    if left:
        events.append(
            {
                "type": "exit",
                "date": left.isoformat(),
                "title": "Left the company" if basis == EXIT_RESIGNATION else "Deactivated (date approximate)",
                "detail": reason,
            }
        )
    events.sort(key=lambda e: e["date"], reverse=True)
    return events


def employee_profile(
    *, employee_id: int | None = None, code: str | None = None, detail: bool = True, today: date | None = None
) -> dict:
    """A short read-only profile of one employee: basics, tenure, what happened to them (joined, promotions,
    increments as a percentage, exit), attendance over the last 90 days and this year's leave balance. NO salary.
    ``detail`` adds the person's own words for leaving (left out for the assistant, which gets the group only)."""
    today = today or ist_today()
    base = Employee.objects.select_related("department", "designation", "branch", "reporting_manager").defer(
        "photo_url", "password_hash"
    )
    emp = None
    if employee_id is not None:
        emp = base.filter(pk=employee_id).first()
    elif (code or "").strip():
        emp = (
            base.filter(employee_code__iexact=code.strip()).first()
            or base.filter(unit_code__iexact=code.strip()).first()
        )
    provenance = [
        prov(
            "profile",
            "Employee profile",
            dataset="Employee records, promotions, increments, resignations, attendance day records, leave balances",
            definition="One person's basics, service history, attendance over the 90 completed days before today (or "
            "before they left) and leave balance for this year. No pay is shown.",
            formula="attendance % = (present days + ½ × half days) ÷ (present + half + absent days); leave, holidays and "
            "weekly offs are not counted",
            caveats=[
                "Attendance is read from stored day records; days nobody has opened yet have no record and are not "
                "counted (the coverage figure says how many are missing).",
                "Increments are shown as a percentage only.",
                "Documents counts the required categories that have at least one file; the files themselves are not shown.",
                CAVEAT_EXIT_DATES,
            ],
        )
    ]
    if emp is None:
        return envelope(
            {"found": False, "asOf": today.isoformat()}, provenance=provenance, notes=["No employee matches."]
        )

    lk = load_lookups()
    joined, _state = join_date_of(emp)
    left = basis = res = None
    active = (emp.status or "") == "active"
    if not active:
        info = exit_infos([emp]).get(emp.id)
        left = min(info.when or today, today) if info else today
        basis = EXIT_APPROXIMATE if info is None or info.basis == BASIS_APPROX else EXIT_RESIGNATION
        res = info.resignation if info else None
    end = left or today
    months = months_between(joined, end) if joined and joined <= end else None
    group = (
        classify_reason(res.survey_q1_answer, res.reason) if res is not None and basis == EXIT_RESIGNATION else "none"
    )
    reason_text = " · ".join(
        t.strip() for t in ((res.survey_q1_answer if res else None), (res.reason if res else None)) if t and t.strip()
    )
    leave = [
        {
            "type": b.leave_type.name,
            "allocated": float(b.allocated),
            "used": float(b.used),
            "remaining": float(b.remaining),
        }
        for b in LeaveBalance.objects.filter(employee_id=emp.id, year=today.year, leave_type__is_active=True)
        .select_related("leave_type")
        .order_by("leave_type__name")
    ]
    age = age_on(emp.date_of_birth, today)
    profile = {
        "id": emp.id,
        "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
        "code": emp.employee_code,
        "status": "active" if active else "inactive",
        "type": (emp.employment_type or "").strip().lower() or None,
        "designation": emp.designation.title if emp.designation_id else None,
        "department": lk.dept(emp.department_id) if emp.department_id else None,
        "unit": emp.branch.name if emp.branch_id else None,
        "reportsTo": f"{emp.reporting_manager.first_name or ''} {emp.reporting_manager.last_name or ''}".strip()
        if emp.reporting_manager_id
        else None,
        "gender": gender_bucket(emp.gender) if emp.gender else None,
        "ageBand": _age_band(age)
        if detail
        else None,  # the assistant is never given anything drawn from a date of birth
        "joinDate": _iso(joined),
        "tenure": tenure_text(months),
        "tenureYears": round(months / 12, 1) if months is not None else None,
        "leftOn": _iso(left),
        "exitApproximate": basis == EXIT_APPROXIMATE if left else None,
        "leavingReason": REASON_LABELS[group] if left else None,
        "leavingReasonText": (reason_text or None) if (left and detail) else None,
        "probationEnd": _iso(emp.probation_end_date),
        "confirmedOn": _iso(emp.confirmation_date),
    }
    return envelope(
        {
            "found": True,
            "asOf": today.isoformat(),
            "profile": profile,
            "history": _profile_history(emp, joined, left, basis, REASON_LABELS[group] if left else None, lk),
            "attendance": _attendance_last_90(emp, left, today),
            "leaveBalance": leave,
            "documents": _documents_on_file(emp),
        },
        provenance=provenance,
    )


# ─── what needs the MD's attention (the page's "Needs your attention" and the Dashboard's insights) ──────────


def _delta(current: float | None, previous: float | None, good: str | None) -> dict:
    """A KPI's change chip: {"abs", "pct", "good"}; abs and pct are None when either side is missing."""
    return {**(change(current, previous) or {"abs": None, "pct": None}), "good": good}


def _exceptions(scope: Scope, period: Period, today: date) -> list[dict]:
    """Every exception worth showing, most severe first (the caller trims the list)."""
    wf = load(scope, today)
    period = _clamped(period, today)
    if period.days <= 0:
        return []
    previous = period.previous()
    roll = Roll(wf.people)
    now, before = flow(wf.people, period, roll), flow(wf.people, previous, roll)
    lk = wf.lookups
    when = _within(period)
    found: list[dict] = []

    def add(id_: str, severity: str, title: str, detail: str, metric: str, ask: str) -> None:
        found.append(
            {
                "id": id_,
                "severity": severity,
                "title": title,
                "detail": detail,
                "metric": metric,
                "page": "employees",
                "ask": ask,
            }
        )

    groups: dict[int | None, list[Person]] = defaultdict(list)
    for p in wf.people:
        groups[p.dept_id].append(p)
    by_dept = {dept_id: flow(members, period) for dept_id, members in groups.items()}

    # a clean-up: many people switched to inactive on one day with no resignation. Their exit date is the day the record
    # changed, so the day lifts leavers and attrition for the period although nobody "left" that day
    approximate = Counter(
        p.left
        for p in wf.people
        if p.exit_basis == EXIT_APPROXIMATE and p.left and period.start <= p.left <= period.end
    )
    if approximate:
        day, n = max(approximate.items(), key=lambda kv: (kv[1], kv[0]))
        if n >= BULK_DEACTIVATION_MIN:
            share = pct(n, now.leavers)
            add(
                "employees.bulk-deactivation",
                "warning" if (share or 0) >= 25 else "info",
                f"{n} people were switched to inactive on {day.day:02d} {_MONTH_ABBR[day.month - 1]} with no resignation",
                f"That is {share:g}% of the {now.leavers} leavers {when}. Their exit date is only the day the record "
                "changed, so a clean-up like this lifts the leaver and attrition figures.",
                str(n),
                f"Why were {n} people deactivated on {day.day:02d} {_MONTH_ABBR[day.month - 1]}, and does that explain "
                f"the attrition {when}?",
            )

    # departments losing people much faster than the company
    company_rate = now.attrition
    hot = [
        (f.attrition, dept_id, f)
        for dept_id, f in by_dept.items()
        if _is_hotspot(f.attrition, f.leavers, f.average, company_rate)
    ]
    for rate, dept_id, f in sorted(hot, key=lambda t: (-t[0], t[1] or 0))[:2]:
        name = lk.dept(dept_id)
        severe = rate >= 2 * company_rate and f.leavers >= 5
        add(
            f"employees.attrition-hotspot.{dept_id}",
            "critical" if severe else "warning",
            f"{name} attrition is {rate:g}%, against {company_rate:g}% across the company",
            f"{f.leavers} people left from an average of {round(f.average or 0, 1):g} {when}.",
            f"{rate:g}%",
            f"Why is attrition high in {name} ({period.label})? Who left, after how long, and why?",
        )

    # people leaving soon after they join
    if now.early >= 3 and (now.early >= 1.5 * before.early or (now.early_share or 0) >= 30):
        add(
            "employees.early-attrition",
            "warning",
            f"{now.early} people left within {EARLY_EXIT_DAYS} days of joining",
            f"That is {now.early_share:g}% of everyone who left {when} (previous period: {before.early}).",
            str(now.early),
            f"Which departments lose new joiners within {EARLY_EXIT_DAYS} days, and what reasons do they give?",
        )

    # the workforce shrinking, or leaving faster than before
    opening = now.opening or 0
    if now.net <= -5 and opening and now.net / opening <= -0.03:
        add(
            "employees.headcount-falling",
            "warning",
            f"Headcount fell by {abs(now.net)} to {now.closing} {when}",
            f"{now.joiners} joined and {now.leavers} left, from {now.opening} at the start.",
            f"{now.net}",
            f"Why did headcount fall in {period.label}? Which departments and units lost the most people?",
        )
    if (
        now.attrition is not None
        and before.attrition is not None
        and now.leavers >= 5
        and now.attrition >= before.attrition + 2
    ):
        add(
            "employees.attrition-rising",
            "warning",
            f"Attrition rose to {now.attrition:g}% from {before.attrition:g}%",
            f"{now.leavers} left {when}; {before.leavers} in the {previous.days} days before.",
            f"{now.attrition:g}%",
            f"Why has attrition risen in {period.label}, and where is it coming from?",
        )

    # departments below their planned staff
    rows, totals, _notes = _staffing(scope, wf)
    below = [r for r in rows if r["gap"] > 0]
    if below:
        worst = min(below, key=lambda r: (r["fillPct"] if r["fillPct"] is not None else 100, -r["gap"]))
        add(
            "employees.staffing-gap",
            "warning" if (worst["fillPct"] or 100) < 80 else "info",
            f"{worst['label']} has {worst['actual']} staff against {worst['required']} planned",
            f"{totals['departmentsBelow']} "
            f"{'department is' if totals['departmentsBelow'] == 1 else 'departments are'} below their planned staff, "
            f"{totals['vacancies']} {'vacancy' if totals['vacancies'] == 1 else 'vacancies'} in all.",
            f"-{worst['gap']}",
            "Which departments are below their planned staffing, and by how many people?",
        )

    # a department growing fast
    growth = [
        (f.closing - f.opening, dept_id, f)
        for dept_id, f in by_dept.items()
        if f.opening
        and f.opening >= 5
        and (f.closing or 0) - f.opening >= 5
        and ((f.closing or 0) - f.opening) / f.opening >= 0.25
    ]
    for grew, dept_id, f in sorted(growth, key=lambda t: (-t[0], t[1] or 0))[:1]:
        add(
            f"employees.fast-growth.{dept_id}",
            "info",
            f"{lk.dept(dept_id)} grew from {f.opening} to {f.closing} people {when}",
            f"{f.joiners} joined and {f.leavers} left.",
            f"+{grew}",
            f"What is driving the growth of {lk.dept(dept_id)} in {period.label}?",
        )

    # the human side
    ahead = today + timedelta(days=29)
    long_service = 0
    for p in wf.active():
        if p.joined is not None:
            when = occurrence_in_window(p.joined.month, p.joined.day, today, ahead)
            long_service += when is not None and when.year - p.joined.year >= LONG_SERVICE_YEARS
    if long_service:
        who = "person completes" if long_service == 1 else "people complete"
        add(
            "employees.long-service",
            "good",
            f"{long_service} {who} {LONG_SERVICE_YEARS}+ years of service in the next 30 days",
            "Worth a word of thanks.",
            str(long_service),
            f"Who completes {LONG_SERVICE_YEARS} or more years of service in the next 30 days?",
        )
    recent = [
        p for p in wf.active() if p.joined is not None and today - timedelta(days=NEW_JOINER_DAYS - 1) <= p.joined
    ]
    if recent:
        from ...employee_documents_views import _required_categories  # the one list of what is required

        on_file = document_map([p.id for p in recent])
        short = sum(1 for p in recent if any(c not in on_file.get(p.id, set()) for c in _required_categories(p.kind)))
        if short >= DOCUMENTS_PENDING_MIN:
            add(
                "employees.documents-pending",
                "info",
                f"{short} of {len(recent)} people who joined in the last {NEW_JOINER_DAYS} days are missing required documents",
                "Identity, education, bank passbook and the staff letter or production documents are not all uploaded.",
                str(short),
                "Which recent joiners are missing required documents? Which report lists them?",
            )
    unconfirmed = sum(
        1
        for p in wf.active()
        if p.probation_end is not None
        and p.probation_end < today
        and (p.confirmed_on is None or p.confirmed_on > today)
    )
    if unconfirmed >= 5:
        add(
            "employees.confirmations-overdue",
            "info",
            f"{unconfirmed} people are past their probation end date and not confirmed",
            "Their probation end date is on record but no confirmation date.",
            str(unconfirmed),
            "Who is past their probation end date without being confirmed?",
        )
    order = {"critical": 0, "warning": 1, "info": 2, "good": 3}
    found.sort(key=lambda item: order[item["severity"]])
    return found


@cached()
def exceptions(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """The page's "Needs your attention": the exceptions above for the chosen period and scope."""
    today = today or ist_today()
    items = _exceptions(scope, period, today)
    return envelope(
        {"items": items[:6], "total": len(items)},
        period=_clamped(period, today),
        scope=scope,
        provenance=[
            prov(
                "exceptions",
                "What needs attention",
                dataset="Employee records, resignations and the required-headcount plan",
                definition="Departments losing people much faster than the company, new joiners leaving early, a "
                "shrinking or fast-growing workforce, departments below their planned staff and good news such as "
                "long service. Each is found with the same figures as the cards below.",
                formula=f"hot-spot: attrition >= {HOTSPOT_FACTOR}x the company's with >= {HOTSPOT_MIN_LEAVERS} leavers; "
                f"early: >= 3 leavers within {EARLY_EXIT_DAYS} days of joining",
                caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_EXIT_DATES],
            )
        ],
    )


@cached()
def insights(*, today: date | None = None) -> list[dict]:
    """The Dashboard's exceptions for this page: company-wide, the last 90 days, at most 5, most severe first."""
    today = today or ist_today()
    return _exceptions(Scope(), period_for_preset("last_90_days", today), today)[:5]


@cached()
def headline(*, today: date | None = None) -> dict:
    """The Dashboard's Employees cards: active headcount, 12-month attrition and this month's joiners vs leavers."""
    today = today or ist_today()
    wf = load(Scope(), today)
    roll = Roll(wf.people)
    active = wf.active()
    kinds = Counter(p.kind for p in active)
    spans = []  # (first day, last day up to today) of each of the last 12 months, oldest first
    for year, month in (add_months(today.year, today.month, -i) for i in range(11, -1, -1)):
        first, last = month_bounds(year, month)
        spans.append((first, min(last, today)))
    heads = [roll.headcount(last) for _first, last in spans]
    leavers_by_month = [roll.left(first, last) for first, last in spans]
    net_by_month = [roll.joined(first, last) - gone for (first, last), gone in zip(spans, leavers_by_month)]
    last_year = Period(spans[0][0], today, "last_12_months", "Last 12 months")
    year, year_before = flow(wf.people, last_year, roll), flow(wf.people, last_year.previous(), roll)
    month = flow(wf.people, Period(today.replace(day=1), today, "this_month", "This month"), roll)
    return {
        "kpis": [
            {
                "id": "employees.headcount",
                "label": "Active headcount",
                "value": len(active),
                "format": "number",
                "sub": f"Staff {kinds['staff']:,} · Production {kinds['production']:,}",
                "delta": _delta(len(active), roll.headcount(today - timedelta(days=30)), "up"),
                "spark": heads,
                "page": "employees",
            },
            {
                "id": "employees.attrition-12m",
                "label": "Attrition (12 months)",
                "value": year.attrition,
                "format": "pct",
                "sub": f"{year.leavers:,} left in the last 12 months",
                "delta": _delta(year.attrition, year_before.attrition, "down"),
                "spark": leavers_by_month,
                "page": "employees",
            },
            {
                "id": "employees.joiners-leavers",
                "label": "Joiners vs leavers (this month)",
                "value": month.net,
                "format": "number",
                "sub": f"{month.joiners:,} joined · {month.leavers:,} left",
                "delta": None,
                "spark": net_by_month,
                "page": "employees",
            },
        ],
        "provenance": [
            prov(
                "headcount",
                "Active headcount",
                dataset="Employee records",
                definition="Everyone whose status is Active today; the change is against 30 days ago and the line is "
                "the headcount at the end of each of the last 12 months.",
                formula="count of employees with status = active",
                rows=len(wf.people),
                caveats=[CAVEAT_RECONSTRUCTED],
            ),
            prov(
                "attrition",
                "Attrition over 12 months",
                dataset="Employee records and resignations",
                definition="People who left in the last 12 months against the average headcount of those months; the "
                "change is against the 12 months before. The line is leavers per month.",
                formula="leavers ÷ ((opening + closing headcount) ÷ 2) × 100",
                rows=year.leavers,
                caveats=[CAVEAT_RECONSTRUCTED, CAVEAT_EXIT_DATES, CAVEAT_EXIT_RATE],
            ),
        ],
    }


# ─── what the assistant may ask ──────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param("How many rows to return (default 10, at most 25).", minimum=1, maximum=MAX_LIMIT)


def _milestones_tool(**kwargs) -> dict:
    """The assistant's view of the milestones: birthdays are counted, never listed (it is not sent dates of birth)."""
    return milestones(birthday_names=False, **kwargs)


def _find_employees(
    *, scope: Scope, query: str | None = None, designation: str | None = None, status: str = "active", limit: int = 10
) -> dict:
    """Find people by name or code (first ``limit`` of the matches, at most 10)."""
    return directory(scope, query=query, designation=designation, status=status, page=1, page_size=min(limit, 10))


def _profile_tool(*, id: int | None = None, code: str | None = None) -> dict:  # noqa: A002 - the parameter is called 'id' for the model
    return employee_profile(employee_id=id, code=code, detail=False)


TOOLS = [
    tool(
        "workforce_headcount",
        "How big the workforce is and how it moved in a period: active headcount today (staff vs production), joiners, "
        "leavers, net change, attrition % (leavers ÷ average headcount, not annualised unless stated), average tenure in "
        "years, early attrition (people who left within 90 days of joining), gender split and average age, each with the "
        "previous period of the same length. Use it for 'how many employees do we have', 'what is our attrition', 'how "
        "many people joined or left last month'. Past headcount is reconstructed from join and exit dates.",
        summary,
        page="employees",
        period="last_12_months",
    ),
    tool(
        "workforce_composition",
        "How the people who work here TODAY are made up: staff vs production, by unit, department, designation (biggest "
        "groups plus 'Other'), gender, age band and length of service, and planned vs actual staff per department when a "
        "required headcount is set. Use it for 'which department is biggest', 'how many women work here', 'how "
        "experienced is the workforce', 'which departments are short of staff'. Takes no period.",
        composition,
        page="employees",
        extra={
            "limit": integer_param(
                "How many departments and designations to list (default 8).", minimum=1, maximum=MAX_LIMIT
            )
        },
        defaults={"limit": 8},
    ),
    tool(
        "workforce_movement",
        "Joiners, leavers, net change and (reconstructed) headcount over time for a period, in day, week or month steps. "
        "Use it for trend questions: 'is headcount growing', 'which month had the most leavers', 'how did we do this year'.",
        movement,
        page="employees",
        period="last_12_months",
    ),
    tool(
        "workforce_attrition",
        "Who is leaving and why, in a period: attrition % for the company and by department, unit and staff/production, "
        "hot-spot departments (well above the company rate), how long leavers stayed, the reasons they gave (grouped), and "
        "the people who left within 90 days of joining (limited list, with names). Use it for 'where is attrition "
        "highest', 'why do people leave', 'who left soon after joining'.",
        attrition,
        page="employees",
        period="last_12_months",
        extra={"limit": _LIMIT},
        defaults={"limit": DEFAULT_LIMIT},
        person_fields=("name",),
    ),
    tool(
        "workforce_milestones",
        "Upcoming people moments: work anniversaries of 5+ years in the next N days, probation ending or overdue where "
        "dates are recorded, and a COUNT of birthdays in the next few days (birthdays are not listed: dates of birth are "
        "never shared with the assistant; point the MD to the Employees page for the names). Use it for 'who completes "
        "10 years this month', 'how many birthdays this week', 'who is due for confirmation'.",
        _milestones_tool,
        page="employees",
        extra={
            "days": integer_param(
                "Look-ahead for anniversaries, in days (default 30, at most 90).", minimum=1, maximum=90
            ),
            "birthday_days": integer_param(
                "Look-ahead for birthdays, in days (default 7, at most 30).", minimum=1, maximum=30
            ),
            "limit": _LIMIT,
        },
        defaults={"days": 30, "birthday_days": 7, "limit": DEFAULT_LIMIT},
        person_fields=("name",),
    ),
    tool(
        "workforce_find_employees",
        "Find employees by name or employee code (partial match, word by word), optionally limited to a department, unit, "
        "type, designation and status (active by default). Returns at most 10 people: code, designation, department, unit, "
        "join date, tenure and status. No salary. Use it to identify someone or to list the people in a department or "
        "designation; follow with workforce_employee_profile for one person's history.",
        _find_employees,
        page="employees",
        extra={
            "query": string_param("Part of a name or employee code."),
            "designation": string_param("Designation title, for example 'Operator'."),
            "status": string_param("active (default), inactive or all.", enum=["active", "inactive", "all"]),
            "limit": integer_param("How many people (default 10, at most 10).", minimum=1, maximum=10),
        },
        defaults={"status": "active", "limit": 10},
        person_fields=("name",),
        example={"query": "a"},
    ),
    tool(
        "workforce_employee_profile",
        "One employee's short profile by employee code or id: designation, department, unit, tenure, what happened to "
        "them (joined, promotions, increments as a percentage, exit and the reason group), attendance over the last 90 "
        "days and this year's leave balance. No salary. Use it for 'tell me about employee E104'.",
        _profile_tool,
        page="employees",
        scope=False,
        extra={
            "code": string_param("The employee code, for example 'E104'."),
            "id": integer_param("The employee's id, when the code is not known."),
        },
        person_fields=("name", "reportsTo"),  # reportsTo is another person's name
        example={"code": "E1"},
    ),
]
