"""MD portal, Manage Shift: who works which shift, is every shift staffed, and does it show in attendance?

Source data is ``ShiftTemplate`` (a shift: name, unit, type, timings) and ``EmployeeShiftAssignment`` (one employee on one
shift from a first day to an optional last day). Attendance and payroll follow the assignment in force on each day, so this
module uses the same rule the attendance engine uses to decide who is on what, and says so in every provenance entry.

The rules this module applies (the tests pin each of them)
-----------------------------------------------------------
* An assignment **covers** a day when it started on or before the day and has no last day, or a last day on or after it.
  One whose last day is before its first day (how HR cancels an assignment that had not begun) covers no day at all and is
  ignored everywhere.
* The shift an employee is **on** for a day is the covering assignment with the latest start; when two start the same day
  the older record wins, as in the attendance engine. An employee with no covering assignment is "on no shift".
* "Right now" figures (who is on which shift, who has none, what ends soon) are as of the factory's today
  (``ist_today()``); changes and attendance follow the chosen period.
* Employees are the ACTIVE ones for "right now" figures; the history of a period (changes, attendance) keeps people who
  have since left, so a past period never changes.
* A **shift change** is a new assignment that follows a different shift (a move). A new assignment for someone who had
  none before is a first assignment; one that follows the same shift (new dates, new custom timings) is a renewal.

Production (2026-11-16, Manage Shifts -> Production). Once the production rules are in force (Settings -> Production
Shifts switched on, on or after their effective date, with a default group enabled), a production worker is not on a
shift template any more: every production day is judged by the DEFAULT production shifts of Settings (Day, Night,
Sunday ... picked by the first punch), unless the worker is on a SPECIAL shift (``ProductionSpecialShiftAssignment``)
that covers the day. The old Production Shift template is retired (only days before the effective date use it), so in
that mode production workers are never "without a shift", their template assignments are not counted, and they are filed
under "Production shifts (Settings)" or their special shift. Staff keep their shift templates exactly as before. Without
the rules in force (an older database) production workers are read from their templates, as the attendance engine does.

Attendance by shift does not re-derive anything: it classifies the same day records, with the same Report Center helpers,
as the Attendance analytics (``attendance.frame_for``), and files each day under the shift the employee was on that day.

Nothing here writes; the REST views and the assistant tools run inside ``common.read_only_db()``.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Iterable

from dataclasses import dataclass, field
from functools import cached_property

from django.db.models import Case, CharField, Count, Exists, F, OuterRef, Q, Subquery, Value, When
from django.db.models.functions import Lower

from ...clock import ist_today
from ...models import (
    EmployeeShiftAssignment,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionSpecialShiftAssignment,
    ShiftTemplate,
)
from ...reporting.formatting import parse_date
from ..assistant.tools_base import integer_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, prov
from . import attendance as att

PAGE = "shifts"

# ─── named thresholds (quoted in the provenance; the tests pin them) ───────────────────────────────────────────────

#: An assignment that ends within this many days, with nothing after it, is "ending soon".
ENDING_SOON_DAYS = 14
MAX_ENDING_SOON_DAYS = 90
#: Shifts of one unit and type are "unevenly staffed" when the smallest has this share fewer people than the biggest ...
IMBALANCE_FLAG_PCT = 40.0
#: ... and the biggest has at least this many people (two or three people on a shift is not an imbalance).
IMBALANCE_MIN_LARGEST = 10
#: Fewer worked days than this on a shift is too little to rank it or call it a problem (marked "small sample").
MIN_SAMPLE_DAYS = 20
#: A shift's late % is flagged at this multiple of the overall late % AND this many points above it.
LATE_FLAG_RATIO = 1.5
LATE_FLAG_POINTS = 3.0
LATE_CRITICAL_RATIO = 2.0
LATE_CRITICAL_MIN_PCT = 15.0
#: Employees without a shift are critical from this share of the active workforce.
UNASSIGNED_CRITICAL_PCT = 10.0
#: Shift moves flagged as a spike: at least this many, and at least double the previous period's.
CHANGE_SPIKE_MIN = 20
CHANGE_SPIKE_RATIO = 2.0
#: Periods longer than this are drawn by week instead of by day.
WEEKLY_ROLLUP_AFTER_DAYS = 62
LIST_MAX = 25
LIST_DEFAULT = 10
SHIFT_ROWS_MAX = 25
DEPARTMENT_COLUMNS = 10
FLOW_ROWS = 12

FIRST, MOVED, RENEWED = "first", "moved", "renewed"
NONE_KEY = "none"
PRODUCTION_KEY = "production"
SPECIAL_PREFIX = "special-"
PRODUCTION_LABEL = "Production shifts (Settings)"
APPLIES_ON_TEXT = {"mon_sat": "Monday to Saturday", "sunday": "Sunday", "all": "Every day"}
OTHER_KEY = "__other__"
NO_SHIFT_LABEL = "No shift assigned"
NO_DEPARTMENT = "No department"
NO_UNIT = "No unit"

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────


def _num(value: float | int | None, places: int = 0) -> str:
    """12,34,567 (Indian grouping), because text built here is read by the MD as it is."""
    if value is None:
        return "n/a"
    number = round(float(value), places)
    whole, _, frac = f"{abs(number):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{'-' if number < 0 else ''}{whole}{'.' + frac if frac else ''}"


def _p(value: float | None, places: int = 1) -> str:
    return "n/a" if value is None else f"{_num(value, places)}%"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _int_arg(value, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high] when given, a readable error when it
    is not a number."""
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def _within(period: Period) -> str:
    """The period as it reads inside a sentence: "in the last 30 days", "in Sep 2026", "this month", "yesterday"."""
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


def _previous_phrase(period: Period) -> str:
    return "the day before" if period.days == 1 else f"the previous {period.days} days"


def _person(first: str | None, last: str | None, code: str | None) -> str:
    return f"{first or ''} {last or ''}".strip() or (code or "Unknown")


# ─── the production rules (Settings -> Production Shifts, Manage Shifts -> Production) ───────────────────────────


def _hm(t) -> str | None:
    return t.strftime("%H:%M") if t else None


@dataclass
class ProductionRules:
    """What decides a production worker's shift: the rules switch and effective date, the enabled default groups and
    special shifts, and who is on a special shift when. Read in three small queries."""

    enabled: bool = False
    effective_from: date | None = None
    defaults: list[dict] = field(default_factory=list)
    specials: dict[int, dict] = field(default_factory=dict)
    #: (employee id, group id, first day, last day or None) of every special assignment of an enabled special shift
    assignments: list[tuple[int, int, date, date | None]] = field(default_factory=list)

    def applies_on(self, day: date) -> bool:
        """True when production days on ``day`` are judged by the rules (not by a shift template)."""
        return bool(self.enabled and self.effective_from is not None and day >= self.effective_from and self.defaults)

    def special_on(self, employee_id: int, day: date) -> int | None:
        for emp_id, group_id, start, end in self._by_employee.get(employee_id, ()):
            if start <= day and (end is None or day <= end):
                return group_id
        return None

    @cached_property
    def _by_employee(self) -> dict[int, list[tuple[int, int, date, date | None]]]:
        index: dict[int, list] = defaultdict(list)
        for row in self.assignments:
            index[row[0]].append(row)
        for rows in index.values():
            rows.sort(key=lambda r: r[2], reverse=True)  # the latest start first
        return index

    def ref(self, key: str) -> dict:
        """A production row as a shift row shows it."""
        if key == PRODUCTION_KEY:
            starts = ", ".join(f"{g['label']} {g['start']}" for g in self.defaults if g["start"])
            return {
                "id": None,
                "key": PRODUCTION_KEY,
                "label": PRODUCTION_LABEL,
                "name": PRODUCTION_LABEL,
                "unit": None,
                "unitId": None,
                "type": "production",
                "start": None,
                "end": None,
                "isActive": True,
                "source": "production",
                "detail": starts or None,
            }
        group_id = int(key[len(SPECIAL_PREFIX) :])
        g = self.specials.get(group_id) or {"label": "Special shift", "start": None, "mainOut": None}
        return {
            "id": group_id,
            "key": key,
            "label": f"{g['label']} (special)",
            "name": g["label"],
            "unit": None,
            "unitId": None,
            "type": "production",
            "start": g["start"],
            "end": g["mainOut"],
            "isActive": True,
            "source": "special",
            "detail": APPLIES_ON_TEXT.get(g.get("appliesOn") or "", None),
        }


def _group_doc(g: dict) -> dict:
    return {
        "id": g["id"],
        "label": g["label"],
        "kind": g["kind"],
        "appliesOn": g["applies_on"],
        "appliesOnText": APPLIES_ON_TEXT.get(g["applies_on"], g["applies_on"]),
        "start": _hm(g["start_time"]),
        "firstPunchFrom": _hm(g["first_punch_from"]),
        "firstPunchTo": _hm(g["first_punch_to"]),
        "mainOut": _hm(g["main_out_time"]),
        "mainOutNextDay": bool(g["main_out_next_day"]),
    }


def production_rules() -> ProductionRules:
    """The production rules as they stand (read-only: the config row may not exist on an older database)."""
    config = (
        ProductionShiftConfig.objects.filter(pk=1).only("rules_enabled", "rules_effective_from").first()
    )  # never .get(): it would INSERT
    groups = list(
        ProductionShiftGroup.objects.filter(enabled=True)
        .order_by("order", "id")
        .values(
            "id",
            "label",
            "kind",
            "applies_on",
            "start_time",
            "first_punch_from",
            "first_punch_to",
            "main_out_time",
            "main_out_next_day",
            "is_special",
        )
    )
    specials = {g["id"]: _group_doc(g) for g in groups if g["is_special"]}
    assignments = (
        list(
            ProductionSpecialShiftAssignment.objects.filter(group_id__in=list(specials)).values_list(
                "employee_id", "group_id", "effective_from", "effective_to"
            )
        )
        if specials
        else []
    )
    return ProductionRules(
        enabled=bool(config is not None and getattr(config, "rules_enabled", True)),
        effective_from=getattr(config, "rules_effective_from", None) if config is not None else None,
        defaults=[_group_doc(g) for g in groups if not g["is_special"]],
        specials=specials,
        assignments=[(e, g, a, b) for e, g, a, b in assignments if b is None or b >= a],
    )


def _covering_special(day: date) -> Subquery:
    """The special shift (group id) a production worker is on for ``day``, latest start first."""
    return Subquery(
        ProductionSpecialShiftAssignment.objects.filter(
            employee_id=OuterRef("pk"), group__enabled=True, group__is_special=True
        )
        .filter(_covers(day))
        .order_by("-effective_from", "-id")
        .values("group_id")[:1]
    )


# ─── who is on which shift: the queries ─────────────────────────────────────────────────────────────────────────────

#: An assignment closed before it started (a cancelled one) covers no day.
_VALID = Q(effective_to__isnull=True) | Q(effective_to__gte=F("effective_from"))


def _covers(day: date) -> Q:
    return Q(effective_from__lte=day) & (Q(effective_to__isnull=True) | Q(effective_to__gte=day))


def _assignments_of(outer: str = "pk"):
    return EmployeeShiftAssignment.objects.filter(employee_id=OuterRef(outer))


def _current_shift(day: date) -> Subquery:
    """The shift an employee is on for ``day``: the covering assignment that started last (older record on a tie)."""
    return Subquery(_assignments_of().filter(_covers(day)).order_by("-effective_from", "id").values("shift_id")[:1])


def _on_a_shift(day: date) -> Exists:
    return Exists(_assignments_of().filter(_covers(day)))


def _scoped_templates(scope: Scope, staff_only: bool = False) -> Q:
    """The shift templates a scope concerns: the chosen unit(s) and type. A department has no shifts of its own. Once
    the production rules are in force the production templates are retired, so only staff templates are "the shifts"."""
    q = Q()
    if scope.branch_ids:
        q &= Q(branch_id__in=scope.branch_ids)
    if scope.employment_type:
        q &= Q(shift_type=scope.employment_type)
    if staff_only:
        q &= Q(shift_type="staff")
    return q


def _load_shifts(
    ids: Iterable[int], scope: Scope | None = None, staff_only: bool = False
) -> tuple[dict[int, dict], set[int]]:
    """({shift id: shift description}, ids of the ACTIVE shifts of the scope). One query. A shift's label is its name,
    plus the unit when two shifts share a name (each unit keeps its own Morning), plus the type when even that is not
    enough."""
    wanted = Q(pk__in=list(ids))
    if scope is not None:
        wanted |= Q(is_active=True) & _scoped_templates(scope, staff_only)
    rows = list(
        ShiftTemplate.objects.filter(wanted)
        .order_by("name", "id")
        .values("id", "name", "shift_type", "start_time", "end_time", "is_active", "branch_id", "branch__name")
    )
    # a shift keeps ONE label on every view: whether a name needs its unit is decided against every shift there is,
    # not just the ones this answer happens to load (Unit 2's Morning stays "Morning (Unit 2)" when filtered to Unit 2)
    every = list(ShiftTemplate.objects.values_list("name", "branch__name")) if rows else []
    by_name = Counter(name for name, _unit in every)
    by_name_unit = Counter(every)
    shifts: dict[int, dict] = {}
    active_in_scope: set[int] = set()
    for r in rows:
        unit = r["branch__name"] or NO_UNIT
        label = r["name"]
        if by_name[r["name"]] > 1:
            label = f"{r['name']} ({unit})"
            if by_name_unit[(r["name"], r["branch__name"])] > 1:
                label = f"{r['name']} ({unit}, {r['shift_type']})"
        shifts[r["id"]] = {
            "id": r["id"],
            "key": str(r["id"]),
            "label": label,
            "name": r["name"],
            "unit": unit,
            "unitId": r["branch_id"],
            "type": r["shift_type"],
            "start": r["start_time"].strftime("%H:%M") if r["start_time"] else None,
            "end": r["end_time"].strftime("%H:%M") if r["end_time"] else None,
            "isActive": bool(r["is_active"]),
            "source": "template",
            "detail": None,
        }
        # only the active shifts that belong to the scope's unit(s) and type count as "its" shifts
        if (
            scope is not None
            and r["is_active"]
            and (not scope.branch_ids or r["branch_id"] in scope.branch_ids)
            and (not scope.employment_type or r["shift_type"] == scope.employment_type)
            and (not staff_only or r["shift_type"] == "staff")
        ):
            active_in_scope.add(r["id"])
    return shifts, active_in_scope


def _shift_ref(shifts: dict[int, dict], shift_id: int | None) -> dict:
    """A shift as a row shows it; None / 0 is "no shift"; a shift deleted since is "Unknown shift"."""
    if not shift_id:
        return {
            "id": None,
            "key": NONE_KEY,
            "label": NO_SHIFT_LABEL,
            "name": NO_SHIFT_LABEL,
            "unit": None,
            "unitId": None,
            "type": None,
            "source": "none",
        }
    found = shifts.get(shift_id)
    if found is None:
        return {
            "id": shift_id,
            "key": str(shift_id),
            "label": "Unknown shift",
            "name": "Unknown shift",
            "unit": None,
            "unitId": None,
            "type": None,
            "source": "template",
        }
    return dict(found)


def _ref_for(key: str, shifts: dict[int, dict], rules: ProductionRules) -> dict:
    """Any row key (a template id, "none", "production", "special-<id>") as a shift row shows it."""
    if key == NONE_KEY:
        return _shift_ref(shifts, None)
    if key == PRODUCTION_KEY or key.startswith(SPECIAL_PREFIX):
        return rules.ref(key)
    return _shift_ref(shifts, int(key))


# ─── provenance (what a card's "How is this calculated?" says, and what the assistant quotes) ──────────────────────

_RULE = (
    "Who is on which shift follows the attendance engine's own rule: the assignment that covers the day and started "
    "last (the older record when two start the same day). An assignment closed before it started covers no day."
)


def _provenance(scope: Scope, period: Period | None, today: date, *, rows: dict[str, int | None]) -> dict[str, dict]:
    filters = [scope.describe(), f"As of {today.isoformat()}"]
    over = [period.label, f"{period.start.isoformat()} to {period.end.isoformat()}", scope.describe()] if period else []
    return {
        "shift-coverage": prov(
            "shift-coverage",
            "Employees on a shift",
            dataset="Employees, shift assignments",
            definition=(
                "Active employees for whom an assignment covers today, out of all active employees in the selection. "
                + _RULE
            ),
            formula="employees on a shift ÷ active employees × 100",
            rows=rows.get("active"),
            filters=filters,
            caveats=[
                "An assignment scheduled to start later does not count until its first day; those employees are "
                "shown as having a shift 'starting later'.",
                "The Manage Shift page's Unassigned tab lists employees with no open-ended assignment, so it can also "
                "hold people whose shift is about to end, and omit people whose only assignment starts later.",
            ],
        ),
        "shift-unassigned": prov(
            "shift-unassigned",
            "Employees without a shift",
            dataset="Employees, shift assignments",
            definition=(
                "Active employees for whom no assignment covers today. Attendance cannot be judged against a shift "
                "for them, so lateness and half days are not detected. " + _RULE
            ),
            formula="active employees − employees on a shift",
            rows=rows.get("without"),
            filters=filters,
            caveats=[
                "'Starting later' means a future assignment exists; 'never had a shift' means no assignment of any "
                "date; the rest had a shift that ended.",
                "Production employees are normally given the production shift when they are added, so a production "
                "employee here usually means no production shift exists for their unit.",
            ],
        ),
        "shift-people": prov(
            "shift-people",
            "People on each shift",
            dataset="Employees, shift assignments, shifts",
            definition=(
                "Active employees counted under the shift they are on today. Departments with the same name in "
                "several units are one department of the company. Shifts that share a name carry their unit." + " " + _RULE
            ),
            formula="employees on the shift; share = shift people ÷ active employees",
            rows=rows.get("active"),
            filters=filters,
            caveats=[
                "A shift's custom per-person timings (set when assigning) are not reflected: only who is on which "
                "shift is counted.",
            ],
        ),
        "shift-balance": prov(
            "shift-balance",
            "Staffing balance",
            dataset="Employees, shift assignments, shifts",
            definition=(
                "Shifts of the same unit and type are compared with each other: the smallest against the biggest. It "
                f"is flagged when it has {IMBALANCE_FLAG_PCT:g}% or more fewer people and the biggest has at least "
                f"{IMBALANCE_MIN_LARGEST} people. A short shift can be deliberate."
            ),
            formula="gap = (biggest shift − smallest shift) ÷ biggest shift × 100",
            filters=filters,
            caveats=["There is no staffing target per shift in the system: this compares shifts with each other."],
        ),
        "shift-templates": prov(
            "shift-templates",
            "Shifts in use",
            dataset="Shifts, shift assignments",
            definition=(
                "Active shifts of the selected unit and type; 'in use' means at least one active employee is on it "
                "today (any department). A shift nobody is on may be a leftover that can be switched off."
            ),
            formula="active shifts with people ÷ active shifts",
            rows=rows.get("shifts"),
            filters=filters,
        ),
        "shift-changes": prov(
            "shift-changes",
            "Shift changes",
            dataset="Shift assignments",
            definition=(
                "Every assignment that starts in the period (cancelled ones excluded) is one of: a MOVE (the "
                "employee's previous shift was a different one), a first assignment (they had none before) or a "
                "renewal (the same shift again, with new dates or timings). 'Shift changes' means moves."
            ),
            formula="moves = new assignments whose previous shift differs; compared with the previous period",
            rows=rows.get("started"),
            filters=over,
            caveats=[
                "An employee who moved twice counts twice as moves and once as a person.",
                "Moves made through the Assign dialog are dated by their first day, not the day HR typed them in.",
            ],
        ),
        "shift-watch": prov(
            "shift-watch",
            "Assignments to watch",
            dataset="Shift assignments",
            definition=(
                f"Ending soon: an assignment covering today whose last day falls within the next {ENDING_SOON_DAYS} "
                "days and which has no assignment covering the day after it. Overlapping: an employee covered by "
                "two or more assignments today (a handover day, when one ends the day another starts, is not an "
                "overlap)."
            ),
            formula="counts of assignments / employees meeting the rule today",
            filters=filters,
            caveats=["When two assignments overlap, the one that started later is the one attendance uses."],
        ),
        "shift-late": prov(
            "shift-late",
            "Late arrivals by shift",
            dataset="Attendance day records (what payroll pays from), shift assignments",
            definition=(
                "Days the attendance engine flagged a late arrival, as a share of the days people worked, filed "
                "under the shift the employee was on that day. Days with no covering assignment are 'No shift "
                "assigned'. The attendance rules (weekly offs, holidays, approved leave) are those of the Attendance "
                "analytics."
            ),
            formula="late days ÷ days worked (full and half days), per shift",
            rows=rows.get("worked"),
            filters=[*over, "Complete days only: today is left out"],
            caveats=[
                "Day records are created when HR opens Attendance or runs payroll, so some days may have none yet.",
                f"A shift with fewer than {MIN_SAMPLE_DAYS} worked days is marked 'small sample' and never called out.",
                "A shift's grace period and start time differ, so a shift with a strict start can look worse.",
            ],
        ),
        "shift-attendance": prov(
            "shift-attendance",
            "Attendance by shift",
            dataset="Attendance day records (what payroll pays from), shift assignments",
            definition=(
                "Attendance % = (present + half × 0.5) ÷ scheduled days; absenteeism % = absent ÷ scheduled days, "
                "for the days that have a record, per shift. Same definitions as the Attendance analytics."
            ),
            formula="(present + 0.5 × half-days) ÷ scheduled days",
            rows=rows.get("scheduled"),
            filters=[*over, "Complete days only: today is left out"],
        ),
        "shift-production": prov(
            "shift-production",
            "Production shifts",
            dataset="Settings -> Production Shifts, special shift assignments (Manage Shifts -> Production)",
            definition=(
                "Once the production rules are in force (switched on, on or after their effective date), every production "
                "day is judged by the default production shifts of Settings, picked by the worker's first punch (Day, "
                "Night, Sunday ...), unless the worker is on a special shift that covers the day: a special shift judges "
                "and pays its workers on its own days. The old Production Shift template only judges the days before the "
                "effective date, so production workers are never counted as 'without a shift' and their template "
                "assignments are left out."
            ),
            formula="production workers on a special shift today + on the default shifts = production workers",
            filters=filters,
            caveats=["Which default shift a worker works (Day or Night) is decided each day by the first punch."],
        ),
        "shift-previous": prov(
            "shift-previous",
            "Comparison with the previous period",
            dataset="Shift assignments",
            definition=(
                "Every change is against the period of the same length that ends the day before this one starts, "
                "worked out the same way."
            ),
            formula="change = this period − previous period (percentages change in points)",
            filters=[f"{period.previous().start.isoformat()} to {period.previous().end.isoformat()}"] if period else [],
        ),
    }


def _pick(entries: dict[str, dict], *ids: str) -> list[dict]:
    return [entries[i] for i in ids if i in entries]


# ─── coverage: how many people on each shift, and where ─────────────────────────────────────────────────────────────


def _balance(shifts: list[dict]) -> list[dict]:
    """Shifts of one unit and type, smallest against biggest. ``shifts`` carry ``people``."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for s in shifts:
        if s["people"] > 0:
            groups[(s["unitId"], s["type"])].append(s)
    out = []
    for members in groups.values():
        if len(members) < 2:
            continue
        largest = max(members, key=lambda s: (s["people"], s["label"]))
        smallest = min(members, key=lambda s: (s["people"], s["label"]))
        gap = round(100.0 * (largest["people"] - smallest["people"]) / largest["people"], 1)
        flagged = gap >= IMBALANCE_FLAG_PCT and largest["people"] >= IMBALANCE_MIN_LARGEST
        out.append(
            {
                "group": f"{largest['unit']} · {largest['type']}",
                "unit": largest["unit"],
                "type": largest["type"],
                "shifts": len(members),
                "largest": {"key": largest["key"], "label": largest["label"], "people": largest["people"]},
                "smallest": {"key": smallest["key"], "label": smallest["label"], "people": smallest["people"]},
                "gapPct": gap,
                "flagged": flagged,
            }
        )
    out.sort(key=lambda b: (not b["flagged"], -b["gapPct"], b["group"]))
    return out


def _people_by_shift(scope: Scope, today: date, rules: ProductionRules, in_force: bool) -> list[tuple[str, str, int, int, int]]:
    """(row key, department, people, staff, production) for the active employees of the scope, grouped by the shift
    they are on today: their covering template assignment; once the production rules are in force, production workers
    by their special shift or the default production shifts instead. Two grouped queries at most."""
    base = scope.employees()
    out: list[tuple[str, str, int, int, int]] = []
    on_templates = base.exclude(employment_type="production") if in_force else base
    for r in (
        on_templates.annotate(cur=_current_shift(today))
        .values("cur", "department__name")
        .annotate(
            n=Count("id"),
            staff=Count("id", filter=Q(employment_type="staff")),
            production=Count("id", filter=Q(employment_type="production")),
        )
        .order_by()
    ):
        key = str(r["cur"]) if r["cur"] else NONE_KEY
        out.append((key, r["department__name"] or NO_DEPARTMENT, r["n"], r["staff"], r["production"]))
    if in_force:
        for r in (
            base.filter(employment_type="production")
            .annotate(sp=_covering_special(today))
            .values("sp", "department__name")
            .annotate(n=Count("id"))
            .order_by()
        ):
            key = f"{SPECIAL_PREFIX}{r['sp']}" if r["sp"] and r["sp"] in rules.specials else PRODUCTION_KEY
            out.append((key, r["department__name"] or NO_DEPARTMENT, r["n"], 0, r["n"]))
    return out


def _production_block(rules: ProductionRules, in_force: bool, per_shift: dict[str, dict], workers: int) -> dict:
    specials = []
    for group_id, g in rules.specials.items():
        slot = per_shift.get(f"{SPECIAL_PREFIX}{group_id}")
        specials.append({**g, "key": f"{SPECIAL_PREFIX}{group_id}", "people": slot["people"] if slot else 0})
    specials.sort(key=lambda g: (-g["people"], g["label"]))
    on_special = sum(g["people"] for g in specials)
    return {
        "inForce": in_force,
        "effectiveFrom": rules.effective_from.isoformat() if rules.effective_from else None,
        "workers": workers,
        "onDefaults": (workers - on_special) if in_force else None,
        "onSpecial": on_special if in_force else None,
        "defaults": rules.defaults,
        "specials": specials,
    }


@cached()
def shifts_coverage(scope: Scope, *, today: date | None = None) -> dict:
    """Who is on each shift today: people per shift (staff / production split, share), the shift × department grid
    (departments beyond the biggest ten are one 'Other departments' column), people on no shift, shifts nobody is on, and
    how evenly the shifts of one unit and type are staffed. Production workers follow the production rules once they
    are in force (the default production shifts of Settings or a special shift), see the module docstring."""
    today = today or ist_today()
    rules = production_rules()
    in_force = rules.applies_on(today)
    rows = _people_by_shift(scope, today, rules, in_force)
    total = sum(r[2] for r in rows)
    workers = sum(r[4] for r in rows)
    per_shift: dict[str, dict] = {}
    per_dept: Counter = Counter()
    cell: Counter = Counter()
    for key, dept, n, staff, production in rows:
        slot = per_shift.setdefault(key, {"people": 0, "staff": 0, "production": 0, "departments": set()})
        slot["people"] += n
        slot["staff"] += staff
        slot["production"] += production
        slot["departments"].add(dept)
        per_dept[dept] += n
        cell[(key, dept)] += n

    template_ids = [int(k) for k in per_shift if k.isdigit()]
    shifts, active_ids = _load_shifts(template_ids, scope, staff_only=in_force)
    in_use = EmployeeShiftAssignment.objects.filter(_covers(today), employee__status="active")
    if in_force:
        in_use = in_use.exclude(employee__employment_type="production")
    used_anywhere = set(in_use.values_list("shift_id", flat=True))

    shift_rows = []
    for key, slot in per_shift.items():
        if key == NONE_KEY:
            continue
        shift_rows.append(
            {
                **_ref_for(key, shifts, rules),
                "people": slot["people"],
                "staff": slot["staff"],
                "production": slot["production"],
                "sharePct": pct(slot["people"], total),
                "departments": len(slot["departments"]),
            }
        )
    shift_rows.sort(key=lambda s: (-s["people"], s["label"]))
    # only shift templates of one unit and type are staffed side by side; production groups are picked by the first punch
    balance = _balance([r for r in shift_rows if r["source"] == "template"])
    none_people = per_shift.get(NONE_KEY, {}).get("people", 0)

    # the grid's columns: the biggest departments, the rest together
    ranked = sorted(per_dept.items(), key=lambda kv: (-kv[1], kv[0]))
    kept = [name for name, _ in ranked[:DEPARTMENT_COLUMNS]]
    rest = [name for name, _ in ranked[DEPARTMENT_COLUMNS:]]
    columns = [{"key": n, "label": n, "people": per_dept[n], "other": False} for n in kept]
    if rest:
        columns.append(
            {"key": OTHER_KEY, "label": "Other departments", "people": sum(per_dept[n] for n in rest), "other": True}
        )
    shown = {s["key"] for s in shift_rows[:SHIFT_ROWS_MAX]} | {NONE_KEY}
    folded: Counter = Counter()
    for (key, dept), n in cell.items():
        if key not in shown:
            continue
        folded[(key, dept if dept in kept else OTHER_KEY)] += n

    def _order(key: str) -> tuple:
        return (0, int(key), "") if key.isdigit() else (1 if key == NONE_KEY else 2, 0, key)

    cells = [
        {"shift": key, "department": dept, "people": n}
        for (key, dept), n in sorted(folded.items(), key=lambda kv: (_order(kv[0][0]), kv[0][1]))
    ]

    unused_ids = sorted((active_ids - used_anywhere), key=lambda i: (shifts[i]["label"], i))
    templates = {"active": len(active_ids), "inUse": len(active_ids & used_anywhere), "unused": len(unused_ids)}
    by_type = Counter(shifts[i]["type"] for i in active_ids)
    templates["staff"] = by_type.get("staff", 0)
    # once the production templates are retired, production's shifts are the enabled production groups
    templates["production"] = (
        len(rules.defaults) + len(rules.specials) if in_force else by_type.get("production", 0)
    )
    people_by_type = {
        "staff": sum(slot["staff"] for slot in per_shift.values()),
        "production": sum(slot["production"] for slot in per_shift.values()),
    }

    entries = _provenance(scope, None, today, rows={"active": total, "shifts": len(active_ids)})
    notes = []
    if not total:
        notes.append(f"There are no active employees in this selection ({scope.describe()}).")
    if none_people and total and none_people * 10 >= total:
        notes.append(
            f"{_num(none_people)} of {_num(total)} active employees are on no shift today, so they are not in any "
            "shift's count."
        )
    if in_force and workers:
        notes.append(
            "Production workers follow the production shifts of Settings (picked by the first punch) unless they are "
            "on a special shift; their old shift-template assignments are not counted."
        )
    return envelope(
        {
            "asOf": today.isoformat(),
            "total": total,
            "onShift": total - none_people,
            "shifts": shift_rows[:SHIFT_ROWS_MAX],
            "shiftsTotal": len(shift_rows),
            "noShift": {"people": none_people, "sharePct": pct(none_people, total)},
            "departments": columns,
            "cells": cells,
            "byType": people_by_type,
            "templates": templates,
            "unused": [_shift_ref(shifts, i) for i in unused_ids[:LIST_MAX]],
            "balance": balance,
            "imbalanceFlagPct": IMBALANCE_FLAG_PCT,
            "imbalanceMinLargest": IMBALANCE_MIN_LARGEST,
            "production": _production_block(rules, in_force, per_shift, workers),
        },
        scope=scope,
        provenance=_pick(
            entries, "shift-people", "shift-balance", "shift-templates", "shift-coverage", "shift-production"
        ),
        notes=notes,
    )


# ─── employees with no shift ────────────────────────────────────────────────────────────────────────────────────────


@cached()
def shifts_unassigned(scope: Scope, *, limit: int = LIST_DEFAULT, today: date | None = None) -> dict:
    """Active employees with no shift today: how many, whether a shift starts later or one ended, which departments they
    are in, and the longest-uncovered first. Names are shown because this is a list HR acts on."""
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    today = today or ist_today()
    later = Subquery(
        _assignments_of()
        .filter(_VALID, effective_from__gt=today)
        .order_by("effective_from", "id")
        .values("effective_from")[:1]
    )
    last_end = Subquery(
        _assignments_of()
        .filter(_VALID, effective_to__lt=today)
        .order_by("-effective_to", "-id")
        .values("effective_to")[:1]
    )
    last_shift = Subquery(
        _assignments_of()
        .filter(_VALID, effective_to__lt=today)
        .order_by("-effective_to", "-id")
        .values("shift__name")[:1]
    )
    people = scope.employees().annotate(has_shift=_on_a_shift(today))
    # once the production rules are in force a production worker is always on the production shifts
    no_shift = Q(has_shift=False)
    if production_rules().applies_on(today):
        no_shift &= ~Q(employment_type="production")

    totals = people.aggregate(active=Count("id"), without=Count("id", filter=no_shift))
    without_qs = people.filter(no_shift).annotate(next_start=later, last_end=last_end)
    split = without_qs.aggregate(
        starts_later=Count("id", filter=Q(next_start__isnull=False)),
        never=Count("id", filter=Q(next_start__isnull=True, last_end__isnull=True)),
    )
    by_department = list(
        people.values("department__name")
        .annotate(total=Count("id"), without=Count("id", filter=no_shift))
        .filter(without__gt=0)
        .order_by("-without", "department__name")[:LIST_MAX]
    )
    listing = list(
        without_qs.annotate(last_shift=last_shift)
        .order_by(F("next_start").asc(nulls_first=True), F("last_end").asc(nulls_first=True), "employee_code")
        .values(
            "id",
            "employee_code",
            "first_name",
            "last_name",
            "employment_type",
            "join_date",
            "department__name",
            "branch__name",
            "next_start",
            "last_end",
            "last_shift",
        )[:limit]
    )

    active, without = totals["active"], totals["without"]
    starts_later, never = split["starts_later"] or 0, split["never"] or 0
    rows = []
    for r in listing:
        ended = r["last_end"]
        rows.append(
            {
                "employeeId": r["id"],
                "employeeCode": r["employee_code"],
                "employeeName": _person(r["first_name"], r["last_name"], r["employee_code"]),
                "department": r["department__name"] or NO_DEPARTMENT,
                "unit": r["branch__name"] or NO_UNIT,
                "type": r["employment_type"],
                "joined": (parse_date(r["join_date"]).isoformat() if parse_date(r["join_date"]) else None),
                "lastShift": r["last_shift"],
                "lastEnded": ended.isoformat() if ended else None,
                "withoutSince": (ended + timedelta(days=1)).isoformat() if ended else None,
                "startsOn": r["next_start"].isoformat() if r["next_start"] else None,
            }
        )
    entries = _provenance(scope, None, today, rows={"active": active, "without": without})
    notes = []
    if not active:
        notes.append(f"There are no active employees in this selection ({scope.describe()}).")
    elif not without:
        notes.append("Every active employee in this selection is on a shift today.")
    return envelope(
        {
            "asOf": today.isoformat(),
            "active": active,
            "total": without,
            "pct": pct(without, active),
            "startsLater": starts_later,
            "neverHadShift": never,
            "endedWithout": without - starts_later - never,
            "byDepartment": [
                {
                    "label": r["department__name"] or NO_DEPARTMENT,
                    "people": r["total"],
                    "without": r["without"],
                    "withoutPct": pct(r["without"], r["total"]),
                }
                for r in by_department
            ],
            "rows": rows,
            "truncated": without > len(rows),
        },
        scope=scope,
        provenance=_pick(entries, "shift-unassigned", "shift-coverage"),
        notes=notes,
    )


# ─── assignments to watch: ending soon, overlapping, starting later ─────────────────────────────────────────────────


def _people_values(prefix: str = "employee__") -> tuple[str, ...]:
    return tuple(
        f"{prefix}{f}"
        for f in ("id", "employee_code", "first_name", "last_name", "employment_type", "department__name", "branch__name")
    )


def _person_row(r: dict) -> dict:
    return {
        "employeeId": r["employee__id"],
        "employeeCode": r["employee__employee_code"],
        "employeeName": _person(r["employee__first_name"], r["employee__last_name"], r["employee__employee_code"]),
        "department": r["employee__department__name"] or NO_DEPARTMENT,
        "unit": r["employee__branch__name"] or NO_UNIT,
        "type": r["employee__employment_type"],
    }


@cached()
def shifts_watch(
    scope: Scope, *, days: int = ENDING_SOON_DAYS, limit: int = LIST_DEFAULT, today: date | None = None
) -> dict:
    """Assignments that need a decision: those ending within ``days`` with nothing after them (the employee would be left
    on no shift), employees covered by two assignments at once, and shifts scheduled to start later."""
    days = _int_arg(days, "days", ENDING_SOON_DAYS, 1, MAX_ENDING_SOON_DAYS)
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    today = today or ist_today()
    horizon = today + timedelta(days=days)
    base = EmployeeShiftAssignment.objects.filter(scope.employee_q("employee__"), employee__status="active")
    if production_rules().applies_on(today):  # production workers are on the production rules, not on templates
        base = base.exclude(employee__employment_type="production")
    covering = base.filter(_covers(today))

    # ending soon, and not followed by anything
    ending = list(
        covering.filter(effective_to__isnull=False, effective_to__lte=horizon)
        .order_by("effective_to", "employee__employee_code", "id")
        .values("id", "employee_id", "shift_id", "effective_from", "effective_to", *_people_values())
    )
    successors: dict[int, list[tuple[int, date, date | None]]] = defaultdict(list)
    if ending:
        later = (
            base.filter(_VALID, employee_id__in={r["employee_id"] for r in ending})
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gt=today))
            .values_list("employee_id", "id", "effective_from", "effective_to")
        )
        for employee_id, aid, start, end in later:
            successors[employee_id].append((aid, start, end))
    left_alone = []
    for r in ending:
        day_after = r["effective_to"] + timedelta(days=1)
        has_next = any(
            aid != r["id"] and start <= day_after and (end is None or end >= day_after)
            for aid, start, end in successors[r["employee_id"]]
        )
        if not has_next:
            left_alone.append(r)

    # employees covered by more than one assignment today (a handover day is not an overlap)
    crowded = {
        r["employee_id"]
        for r in covering.values("employee_id").annotate(n=Count("id")).filter(n__gt=1).order_by()
    }
    overlaps = []
    if crowded:
        grouped: dict[int, list[dict]] = defaultdict(list)
        for r in covering.filter(employee_id__in=crowded).order_by("effective_from", "id").values(
            "id", "employee_id", "shift_id", "effective_from", "effective_to", *_people_values()
        ):
            grouped[r["employee_id"]].append(r)
        for members in grouped.values():
            handover = all(
                a["effective_to"] is not None and a["effective_to"] == b["effective_from"]
                for a, b in zip(members, members[1:])
            )
            if not handover:
                overlaps.append(members)
        overlaps.sort(key=lambda m: (m[0]["employee__employee_code"] or "", m[0]["employee_id"]))

    starting_later = base.filter(_VALID, effective_from__gt=today).values("employee_id").distinct().count()

    needed = {r["shift_id"] for r in left_alone[:limit]} | {a["shift_id"] for m in overlaps[:limit] for a in m}
    shifts, _ = _load_shifts(needed)
    ending_rows = [
        {
            **_person_row(r),
            "shift": _shift_ref(shifts, r["shift_id"])["label"],
            "endsOn": r["effective_to"].isoformat(),
            "daysLeft": (r["effective_to"] - today).days,
        }
        for r in left_alone[:limit]
    ]
    overlap_rows = [
        {
            **_person_row(m[0]),
            "sameShift": len({a["shift_id"] for a in m}) == 1,
            "shifts": [
                {
                    "label": _shift_ref(shifts, a["shift_id"])["label"],
                    "from": a["effective_from"].isoformat(),
                    "to": a["effective_to"].isoformat() if a["effective_to"] else None,
                }
                for a in m
            ],
        }
        for m in overlaps[:limit]
    ]
    entries = _provenance(scope, None, today, rows={})
    return envelope(
        {
            "asOf": today.isoformat(),
            "days": days,
            "endingSoon": {"count": len(left_alone), "rows": ending_rows, "truncated": len(left_alone) > limit},
            "overlapping": {"count": len(overlaps), "rows": overlap_rows, "truncated": len(overlaps) > limit},
            "startsLater": {"count": starting_later},
        },
        scope=scope,
        provenance=_pick(entries, "shift-watch"),
        notes=[],
    )


# ─── shift changes: who moved, and when ─────────────────────────────────────────────────────────────────────────────


def _retired_from() -> date | None:
    """The day from which the production templates no longer decide anything (the rules' effective date), or None."""
    rules = production_rules()
    return rules.effective_from if rules.enabled and rules.effective_from and rules.defaults else None


def _starts(scope: Scope, lo: date, hi: date):
    """The assignments that START in [lo, hi] (cancelled ones excluded), each labelled FIRST (the employee had no earlier
    assignment), MOVED (the one before it was another shift) or RENEWED (the same shift again). A production template's
    assignment starting once the production rules are in force changes nothing and is left out."""
    prior = (
        EmployeeShiftAssignment.objects.filter(
            _VALID, employee_id=OuterRef("employee_id"), effective_from__lt=OuterRef("effective_from")
        )
        .order_by("-effective_from", "-id")
        .values("shift_id")[:1]
    )
    qs = EmployeeShiftAssignment.objects.filter(
        scope.employee_q("employee__"), _VALID, effective_from__gte=lo, effective_from__lte=hi
    )
    retired = _retired_from()
    if retired is not None:
        qs = qs.exclude(shift__shift_type="production", effective_from__gte=retired)
    return (
        qs.annotate(prev_shift=Subquery(prior))
        .annotate(
            kind=Case(
                When(prev_shift__isnull=True, then=Value(FIRST)),
                When(prev_shift=F("shift_id"), then=Value(RENEWED)),
                default=Value(MOVED),
                output_field=CharField(),
            )
        )
    )


def _change_totals(scope: Scope, lo: date, hi: date) -> dict:
    raw = _starts(scope, lo, hi).aggregate(
        first=Count("id", filter=Q(kind=FIRST)),
        moved=Count("id", filter=Q(kind=MOVED)),
        renewed=Count("id", filter=Q(kind=RENEWED)),
        people=Count("employee_id", distinct=True),
        people_moved=Count("employee_id", distinct=True, filter=Q(kind=MOVED)),
    )
    first, moved, renewed = raw["first"] or 0, raw["moved"] or 0, raw["renewed"] or 0
    return {
        "first": first,
        "moved": moved,
        "renewed": renewed,
        "started": first + moved + renewed,
        "people": raw["people"] or 0,
        "peopleMoved": raw["people_moved"] or 0,
    }


def _daily_starts(scope: Scope, lo: date, hi: date) -> dict[date, dict[str, int]]:
    out: dict[date, dict[str, int]] = {}
    rows = _starts(scope, lo, hi).values("effective_from", "kind").annotate(n=Count("id")).order_by()
    for r in rows:
        out.setdefault(r["effective_from"], {FIRST: 0, MOVED: 0, RENEWED: 0})[r["kind"]] += r["n"]
    return out


def _point(first_day: date, days: list[date], per_day: dict[date, dict[str, int]]) -> dict:
    first = sum(per_day.get(d, {}).get(FIRST, 0) for d in days)
    moved = sum(per_day.get(d, {}).get(MOVED, 0) for d in days)
    renewed = sum(per_day.get(d, {}).get(RENEWED, 0) for d in days)
    return {
        "date": first_day.isoformat(),
        "days": len(days),
        "first": first,
        "moved": moved,
        "renewed": renewed,
        "started": first + moved + renewed,
    }


@cached()
def shifts_changes(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Shift changes in a period: day by day (week by week beyond 62 days) how many assignments started, split into
    moves between shifts, first assignments and renewals, the totals against the previous period, and each shift's
    people moved in and out."""
    today = today or ist_today()
    previous = period.previous()
    per_day = _daily_starts(scope, period.start, period.end)
    cur = _change_totals(scope, period.start, period.end)
    prev = _change_totals(scope, previous.start, previous.end)

    period_days = [period.start + timedelta(days=n) for n in range(period.days)]
    weekly = period.days > WEEKLY_ROLLUP_AFTER_DAYS
    points: list[dict] = []
    if weekly:
        by_week: dict[date, list[date]] = {}
        for d in period_days:
            by_week.setdefault(d - timedelta(days=d.weekday()), []).append(d)
        # a week is dated by its Monday (as every weekly chart of the portal), even when the period starts mid-week
        points = [_point(monday, days, per_day) for monday, days in by_week.items()]
    else:
        points = [_point(d, [d], per_day) for d in period_days]

    flows = list(
        _starts(scope, period.start, period.end)
        .values("shift_id", "prev_shift", "kind")
        .annotate(n=Count("id"))
        .order_by()
    )
    shift_ids = {f["shift_id"] for f in flows} | {f["prev_shift"] for f in flows if f["prev_shift"]}
    shifts, _ = _load_shifts(shift_ids)
    per_shift: dict[int, dict] = {}
    for f in flows:
        slot = per_shift.setdefault(f["shift_id"], {"first": 0, "movedIn": 0, "movedOut": 0, "renewed": 0})
        if f["kind"] == FIRST:
            slot["first"] += f["n"]
        elif f["kind"] == RENEWED:
            slot["renewed"] += f["n"]
        else:
            slot["movedIn"] += f["n"]
            out = per_shift.setdefault(f["prev_shift"], {"first": 0, "movedIn": 0, "movedOut": 0, "renewed": 0})
            out["movedOut"] += f["n"]
    flow_rows = [
        {**_shift_ref(shifts, sid), **slot, "net": slot["movedIn"] - slot["movedOut"]}
        for sid, slot in per_shift.items()
    ]
    flow_rows.sort(key=lambda r: (-abs(r["net"]), -(r["movedIn"] + r["movedOut"]), r["label"]))

    scheduled = sum(sum(v.values()) for d, v in per_day.items() if d > today)
    special_starts = ProductionSpecialShiftAssignment.objects.filter(
        scope.employee_q("employee__"), effective_from__gte=period.start, effective_from__lte=period.end
    ).filter(Q(effective_to__isnull=True) | Q(effective_to__gte=F("effective_from")))
    entries = _provenance(scope, period, today, rows={"started": cur["started"]})
    notes = [] if cur["started"] else [f"No shift was assigned or changed {_within(period)} ({scope.describe()})."]
    if scheduled:
        notes.append(
            f"{_num(scheduled)} of these {_plural(scheduled, 'assignment starts', 'assignments start')} after today: "
            "they are scheduled, not yet in force."
        )
    return envelope(
        {
            "granularity": "week" if weekly else "day",
            "points": points,
            "totals": {
                **cur,
                "scheduled": scheduled,
                "specialStarts": special_starts.count(),
                "previous": prev,
                "change": {
                    "moved": change(cur["moved"], prev["moved"]),
                    "started": change(cur["started"], prev["started"]),
                },
            },
            "byShift": flow_rows[:FLOW_ROWS],
            "byShiftTotal": len(flow_rows),
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "shift-changes", "shift-previous"),
        notes=notes,
    )


# ─── attendance and lateness by shift ───────────────────────────────────────────────────────────────────────────────


def _att_figures(tally: list[int]) -> dict:
    return {
        "scheduledDays": att.t_scheduled(tally),
        "workedDays": att.t_worked(tally),
        "lateDays": tally[att.T_LATE],
        "absentDays": tally[att.SA],
        "latePct": att.t_late(tally),
        "attendancePct": att.t_attendance(tally),
        "absentPct": att.t_absence(tally),
    }


@cached()
def shifts_attendance(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Attendance, absenteeism and late arrivals per shift, each against the previous period and against the company:
    every day record is filed under the shift the employee was on that day. The days are judged by the Attendance
    analytics (same frame, so the figures agree with that page)."""
    today = today or ist_today()
    frame, win = att.frame_for(scope, period, today)
    previous_block = win.previous.to_json() if win.previous else None
    if win.measured is None:
        return envelope(
            {
                "measured": None,
                "previous": None,
                "overall": None,
                "rows": [],
                "total": 0,
                "minSample": MIN_SAMPLE_DAYS,
                "coverage": None,
            },
            period=period,
            scope=scope,
            provenance=_pick(_provenance(scope, period, today, rows={}), "shift-late", "shift-attendance"),
            notes=[
                "Today is still running, so this period has no completed day yet: attendance by shift is empty until "
                "tomorrow."
            ],
        )
    measured = win.measured
    roster = frame.roster
    rules = production_rules()

    def key_of(eid: int, d: date) -> str:
        person = frame.people.get(eid)
        kind = getattr(person, "employment_type", None) or getattr(person, "kind", None)
        if kind == "production" and rules.applies_on(d):
            special = rules.special_on(eid, d)
            return f"{SPECIAL_PREFIX}{special}" if special in rules.specials else PRODUCTION_KEY
        assignment = roster.assignment_on(eid, d)
        return str(assignment.shift_id) if assignment else NONE_KEY

    def file_under(rows):
        tallies: dict[str, list[int]] = defaultdict(att.new_tally)
        people: dict[str, set[int]] = defaultdict(set)
        for d, eid, code, flags in rows:
            key = key_of(eid, d)
            att.add_row(tallies[key], code, flags)
            people[key].add(eid)
        return tallies, people

    cur_rows = frame.window(measured.start, measured.end)
    cur, cur_people = file_under(cur_rows)
    prev, _ = file_under(frame.window(win.previous.start, win.previous.end)) if win.previous else ({}, {})
    overall_cur = att.tally_rows(cur_rows)
    overall_prev = att.tally_rows(frame.window(win.previous.start, win.previous.end)) if win.previous else None
    overall = _att_figures(overall_cur)
    overall_prev_fig = _att_figures(overall_prev) if overall_prev else None

    shifts, _ = _load_shifts({int(k) for k in cur if k.isdigit()})
    rows = []
    for sid, tally in cur.items():
        f = _att_figures(tally)
        p = _att_figures(prev[sid]) if sid in prev else None
        late_vs = (
            round(f["latePct"] - overall["latePct"], 1)
            if f["latePct"] is not None and overall["latePct"] is not None
            else None
        )
        rows.append(
            {
                **_ref_for(sid, shifts, rules),
                "people": len(cur_people[sid]),
                **f,
                "lowSample": f["workedDays"] < MIN_SAMPLE_DAYS,
                "vsOverallLatePts": late_vs,
                "previous": None if p is None else {"latePct": p["latePct"], "attendancePct": p["attendancePct"]},
                "change": {
                    "latePct": change(f["latePct"], p["latePct"]) if p else None,
                    "attendancePct": change(f["attendancePct"], p["attendancePct"]) if p else None,
                },
            }
        )
    rows.sort(key=lambda r: (r["latePct"] is None, -(r["latePct"] or 0), -r["workedDays"], r["label"]))

    coverage = att.coverage_of(frame, measured.start, measured.end)
    entries = _provenance(
        scope, period, today, rows={"worked": overall["workedDays"], "scheduled": overall["scheduledDays"]}
    )
    notes: list[str] = []
    if win.includes_today:
        notes.append("Today is still running and is left out: its absences would only mean 'not in yet'.")
    if frame.people and not frame.rows:
        notes.append("No attendance day records exist for these days: HR has not opened or processed them yet.")
    elif coverage["partial"]:
        notes.append(
            f"Attendance day records exist for {_p(coverage['coveragePct'])} of scheduled days "
            f"({_num(coverage['recordedDays'])} of {_num(coverage['expectedDays'])} employee-days): the figures cover "
            "the days HR has processed."
        )
    if not getattr(frame.settings, "morning_late_in_enabled", True):
        notes.append("Morning Late-In detection is switched off in Settings, so late figures are understated.")
    unassigned_days = cur.get(NONE_KEY)
    if unassigned_days and overall["workedDays"] and att.t_worked(unassigned_days) * 10 >= overall["workedDays"]:
        notes.append(
            f"{_num(att.t_worked(unassigned_days))} of {_num(overall['workedDays'])} worked days belong to employees "
            "with no shift that day: they are shown as 'No shift assigned'."
        )
    return envelope(
        {
            "measured": {"start": measured.start.isoformat(), "end": measured.end.isoformat(), "days": measured.days},
            "previous": previous_block,
            "overall": {**overall, "previous": overall_prev_fig},
            "rows": rows,
            "total": len(rows),
            "minSample": MIN_SAMPLE_DAYS,
            "coverage": coverage,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "shift-late", "shift-attendance"),
        notes=notes,
    )


# ─── the people on one shift (the Insights drill-down) ──────────────────────────────────────────────────────────────


@cached()
def shifts_people(
    scope: Scope, shift: str, *, page: int = 1, page_size: int = 25, today: date | None = None
) -> dict:
    """The active employees on one shift today, a page at a time: ``shift`` is a shift template id, "none" (no shift),
    "production" (the default production shifts of Settings) or "special-<id>" (a special production shift). Each row
    has the assignment's first and last day where there is one."""
    today = today or ist_today()
    key = str(shift or "").strip().lower()
    page_size = _int_arg(page_size, "pageSize", 25, 1, 100)
    rules = production_rules()
    in_force = rules.applies_on(today)
    people = scope.employees()
    since = until = None
    if key == NONE_KEY:
        people = people.annotate(has_shift=_on_a_shift(today)).filter(has_shift=False)
        if in_force:
            people = people.exclude(employment_type="production")
    elif key == PRODUCTION_KEY or key.startswith(SPECIAL_PREFIX):
        if not in_force:
            raise MdParamError("The production rules are not in force, so production workers are on shift templates.")
        people = people.filter(employment_type="production").annotate(sp=_covering_special(today))
        if key == PRODUCTION_KEY:
            people = people.filter(Q(sp__isnull=True) | ~Q(sp__in=list(rules.specials)))
        else:
            ident = key[len(SPECIAL_PREFIX) :]
            if not ident.isdigit():
                raise MdParamError("A special shift is written special-<id>, for example special-4.")
            people = people.filter(sp=int(ident))
            covering = (
                ProductionSpecialShiftAssignment.objects.filter(employee_id=OuterRef("pk"), group_id=int(ident))
                .filter(_covers(today))
                .order_by("-effective_from", "-id")
            )
            since, until = Subquery(covering.values("effective_from")[:1]), Subquery(covering.values("effective_to")[:1])
    elif key.isdigit():
        people = people.annotate(cur=_current_shift(today)).filter(cur=int(key))
        if in_force:
            people = people.exclude(employment_type="production")
        covering = (
            _assignments_of().filter(_covers(today), shift_id=int(key)).order_by("-effective_from", "id")
        )
        since, until = Subquery(covering.values("effective_from")[:1]), Subquery(covering.values("effective_to")[:1])
    else:
        raise MdParamError("'shift' must be a shift id, none, production or special-<id>.")
    if since is not None:
        people = people.annotate(since=since, until=until)

    total = people.count()
    pages = max(1, -(-total // page_size))
    page = min(_int_arg(page, "page", 1, 1, 1_000_000), pages)
    fields = ["id", "employee_code", "first_name", "last_name", "employment_type", "department__name", "branch__name"]
    if since is not None:
        fields += ["since", "until"]
    listing = list(
        people.order_by(Lower("first_name"), Lower("last_name"), "employee_code").values(*fields)[
            (page - 1) * page_size : page * page_size
        ]
    )
    shifts, _ = _load_shifts([int(key)] if key.isdigit() else [])
    ref = _ref_for(key, shifts, rules)
    rows = [
        {
            "employeeId": r["id"],
            "employeeCode": r["employee_code"],
            "employeeName": _person(r["first_name"], r["last_name"], r["employee_code"]),
            "department": r["department__name"] or NO_DEPARTMENT,
            "unit": r["branch__name"] or NO_UNIT,
            "type": r["employment_type"],
            "since": r["since"].isoformat() if r.get("since") else None,
            "until": r["until"].isoformat() if r.get("until") else None,
        }
        for r in listing
    ]
    entries = _provenance(scope, None, today, rows={"active": total})
    return envelope(
        {
            "asOf": today.isoformat(),
            "shift": ref,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": pages,
            "rows": rows,
        },
        scope=scope,
        provenance=_pick(
            entries, "shift-production" if ref.get("source") in ("production", "special") else "shift-people"
        ),
        notes=[] if total else [f"Nobody in this selection is on {ref['label']} today ({scope.describe()})."],
    )


# ─── the headline figures of a period ───────────────────────────────────────────────────────────────────────────────


@cached()
def shifts_summary(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Employees on a shift and without one, the shifts in use, shift changes against the previous period, what needs
    a decision (assignments ending, overlapping) and whether the shifts are evenly staffed. The call the KPI cards, the
    Dashboard and the assistant rest on."""
    today = today or ist_today()
    cov = shifts_coverage(scope, today=today)
    unassigned = shifts_unassigned(scope, limit=1, today=today)
    watch = shifts_watch(scope, limit=1, today=today)
    chg = shifts_changes(scope, period, today=today)
    active, without = cov["total"], cov["noShift"]["people"]
    flagged = [b for b in cov["balance"] if b["flagged"]]
    entries = _provenance(scope, period, today, rows={"active": active, "without": without, "started": None})
    notes = [] if active else [f"There are no active employees in this selection ({scope.describe()})."]
    return envelope(
        {
            "asOf": today.isoformat(),
            "employees": {
                "active": active,
                "onShift": cov["onShift"],
                "noShift": without,
                "startsLater": unassigned["startsLater"],
                "neverHadShift": unassigned["neverHadShift"],
                "coveragePct": pct(cov["onShift"], active),
                "staff": cov["byType"]["staff"],
                "production": cov["byType"]["production"],
            },
            "shifts": cov["templates"],
            "biggest": cov["shifts"][0] if cov["shifts"] else None,
            "changes": {**chg["totals"]},
            "watch": {
                "days": watch["days"],
                "endingSoon": watch["endingSoon"]["count"],
                "overlapping": watch["overlapping"]["count"],
                "startsLater": watch["startsLater"]["count"],
            },
            "balance": {"groups": len(cov["balance"]), "flagged": len(flagged), "worst": flagged[0] if flagged else None},
            "production": {
                "inForce": cov["production"]["inForce"],
                "workers": cov["production"]["workers"],
                "onSpecial": cov["production"]["onSpecial"],
                "defaults": len(cov["production"]["defaults"]),
                "specials": len(cov["production"]["specials"]),
            },
            "previousPeriod": period.previous().to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "shift-coverage",
            "shift-unassigned",
            "shift-templates",
            "shift-changes",
            "shift-watch",
            "shift-balance",
            "shift-previous",
        ),
        notes=notes,
    )


# ─── the plain-English summary ──────────────────────────────────────────────────────────────────────────────────────


def _line(id_: str, text: str, tone: str) -> dict:
    return {"id": id_, "text": text, "tone": tone, "page": PAGE}


@cached()
def shifts_briefing(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Two to five plain sentences about the shifts, every figure taken from the same answers the cards show (summary,
    coverage, attendance, watch). Fixed rules, no AI: it is instant and cannot say anything the cards do not."""
    today = today or ist_today()
    summary = shifts_summary(scope, period, today=today)
    cov = shifts_coverage(scope, today=today)
    late = shifts_attendance(scope, period, today=today)
    e, ch, w = summary["employees"], summary["changes"], summary["watch"]
    sentences: list[dict] = []

    if e["active"]:
        if not e["noShift"]:
            sentences.append(
                _line(
                    "coverage",
                    f"All {_num(e['active'])} active employees are on a shift today, across "
                    f"{_num(summary['shifts']['inUse'])} {_plural(summary['shifts']['inUse'], 'shift')} in use.",
                    "good",
                )
            )
        else:
            later = (
                f", and {_num(e['startsLater'])} of them {'has' if e['startsLater'] == 1 else 'have'} one that starts later"
                if e["startsLater"]
                else ""
            )
            sentences.append(
                _line(
                    "coverage",
                    f"{_num(e['onShift'])} of {_num(e['active'])} active employees ({_p(e['coveragePct'])}) are on a "
                    f"shift today; {_num(e['noShift'])} {'has' if e['noShift'] == 1 else 'have'} none{later}.",
                    "watch",
                )
            )
        # the biggest shift a person is ASSIGNED to (the production groups are picked by the first punch each day)
        shifts = [r for r in cov["shifts"] if r.get("source", "template") != "production"]
        if shifts:
            big = shifts[0]
            text = (
                f"The biggest shift is {big['label']} with {_num(big['people'])} "
                f"{_plural(big['people'], 'person', 'people')} ({_p(big['sharePct'], 0)} of everyone)"
            )
            worst = summary["balance"]["worst"]
            if worst:
                text += (
                    f". {worst['smallest']['label']} has {_p(worst['gapPct'], 0)} fewer people than "
                    f"{worst['largest']['label']} ({_num(worst['smallest']['people'])} against "
                    f"{_num(worst['largest']['people'])}, same unit and type)."
                )
            else:
                text += "."
            sentences.append(_line("balance", text, "watch" if worst else "neutral"))
        prod = cov["production"]
        if prod["inForce"] and prod["workers"]:
            names = ", ".join(g["label"] for g in prod["defaults"]) or "the default shifts"
            special = (
                f"; {_num(prod['onSpecial'])} {_plural(prod['onSpecial'], 'is', 'are')} on a special shift"
                if prod["onSpecial"]
                else ""
            )
            sentences.append(
                _line(
                    "production",
                    f"{_num(prod['workers'])} production {_plural(prod['workers'], 'worker follows', 'workers follow')} "
                    f"the production shifts of Settings ({names}){special}.",
                    "neutral",
                )
            )

    if ch["started"] or ch["previous"]["started"]:
        moved_change = summary["changes"]["change"]["moved"]
        versus = ""
        if moved_change and moved_change["abs"]:
            direction = "more" if moved_change["abs"] > 0 else "fewer"
            versus = f", {_num(abs(moved_change['abs']))} {direction} than {_previous_phrase(period)}"
        sentences.append(
            _line(
                "changes",
                f"{_num(ch['moved'])} {_plural(ch['moved'], 'shift change')} {_within(period)}{versus}: "
                f"{_num(ch['peopleMoved'])} {_plural(ch['peopleMoved'], 'person', 'people')} moved between shifts, "
                f"{_num(ch['first'])} got a first shift and {_num(ch['renewed'])} {_plural(ch['renewed'], 'assignment was', 'assignments were')} renewed.",
                "neutral",
            )
        )

    overall = (late.get("overall") or {}).get("latePct")
    ranked = [r for r in late["rows"] if not r["lowSample"] and r["latePct"] is not None and r["key"] != NONE_KEY]
    if overall is not None and ranked:
        top = max(ranked, key=lambda r: r["latePct"])
        low = min(ranked, key=lambda r: r["latePct"])
        gap = _late_gap_row(late)
        if gap:
            sentences.append(
                _line(
                    "late",
                    f"Late arrivals are highest on {gap['label']} at {_p(gap['latePct'])}, against {_p(overall)} "
                    f"across all shifts {_within(period)}.",
                    "watch",
                )
            )
        elif top["key"] != low["key"]:
            sentences.append(
                _line(
                    "late",
                    f"Late arrivals {_within(period)} range from {_p(low['latePct'])} on {low['label']} to "
                    f"{_p(top['latePct'])} on {top['label']} ({_p(overall)} overall).",
                    "neutral",
                )
            )
        else:
            sentences.append(_line("late", f"Late arrivals {_within(period)} were {_p(overall)} overall.", "neutral"))

    attention = w["endingSoon"] + w["overlapping"]
    if attention:
        parts = []
        if w["endingSoon"]:
            parts.append(
                f"{_num(w['endingSoon'])} {_plural(w['endingSoon'], 'assignment ends', 'assignments end')} within "
                f"{w['days']} days with nothing after {_plural(w['endingSoon'], 'it', 'them')}"
            )
        if w["overlapping"]:
            parts.append(
                f"{_num(w['overlapping'])} {_plural(w['overlapping'], 'employee is', 'employees are')} on two shifts "
                "at once"
            )
        sentences.append(_line("watch", f"{' and '.join(parts).capitalize()}.", "watch"))

    entries = _provenance(scope, period, today, rows={})
    entries["shift-briefing"] = prov(
        "shift-briefing",
        "The summary",
        dataset="The figures on this page",
        definition=(
            "Written by fixed rules from the same figures as the cards below (coverage, staffing balance, shift "
            "changes, late arrivals and assignments to watch). No AI is involved, so it says nothing the cards do not."
        ),
        formula="sentences built from the page's own numbers",
        filters=[period.label, scope.describe()],
    )
    return envelope(
        {
            "briefing": {
                "sentences": sentences,
                "text": " ".join(s["text"] for s in sentences),
                "ask": f"Give me a briefing on the shifts {_within(period)}: staffing, who has no shift, changes and "
                "lateness. What stands out and why?",
            }
        },
        period=period,
        scope=scope,
        provenance=[entries["shift-briefing"]],
        notes=[] if sentences else [f"There is nothing to summarise for this selection ({scope.describe()})."],
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ──────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"shifts.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _late_gap_row(late: dict) -> dict | None:
    """The shift whose late % is clearly above the overall rate (and has enough days behind it to trust)."""
    overall = (late.get("overall") or {}).get("latePct")
    if overall is None:
        return None
    floor = max(LATE_FLAG_RATIO * overall, overall + LATE_FLAG_POINTS)
    candidates = [
        r
        for r in late["rows"]
        if not r["lowSample"] and r["key"] != NONE_KEY and r["latePct"] is not None and r["latePct"] >= floor
    ]
    return max(candidates, key=lambda r: (r["latePct"], r["workedDays"]), default=None)


def _exceptions(scope: Scope, period: Period, today: date, *, limit: int) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``. Built on
    the public analytics so a flag always points at a figure that is on the page."""
    summary = shifts_summary(scope, period, today=today)
    e, w, ch = summary["employees"], summary["watch"], summary["changes"]
    items: list[dict] = []

    if e["noShift"]:
        n = e["noShift"]
        share = pct(n, e["active"]) or 0.0
        later = f" {_num(e['startsLater'])} of them have a shift that starts later." if e["startsLater"] else ""
        items.append(
            _item(
                "unassigned",
                "critical" if share >= UNASSIGNED_CRITICAL_PCT else "warning",
                f"{_num(n)} {_plural(n, 'employee has', 'employees have')} no shift",
                f"{_num(n)} of {_num(e['active'])} active employees ({_p(share)}) are not on any shift today, so "
                f"lateness and half days cannot be detected for them.{later}",
                _num(n),
                "Which employees have no shift assigned today, which departments are they in, and who should assign them?",
            )
        )
    if w["overlapping"]:
        n = w["overlapping"]
        items.append(
            _item(
                "overlap",
                "warning",
                f"{_num(n)} {_plural(n, 'employee is', 'employees are')} on two shifts at once",
                "Two assignments cover them today; attendance follows the one that started later, which is often "
                "not what HR meant.",
                _num(n),
                "Which employees are assigned to two shifts at the same time, and which assignment should be ended?",
            )
        )
    if w["endingSoon"]:
        n = w["endingSoon"]
        items.append(
            _item(
                "ending-soon",
                "warning",
                f"{_num(n)} shift {_plural(n, 'assignment ends', 'assignments end')} within {w['days']} days with "
                "nothing after",
                "When they end these employees will be on no shift unless HR assigns one.",
                _num(n),
                f"Whose shift ends in the next {w['days']} days with no new shift after it?",
            )
        )
    worst = summary["balance"]["worst"]
    if worst:
        small, large = worst["smallest"], worst["largest"]
        items.append(
            _item(
                "imbalance",
                "warning",
                f"{small['label']} has {_p(worst['gapPct'], 0)} fewer people than {large['label']}",
                f"{_num(small['people'])} against {_num(large['people'])} people on shifts of the same unit and type "
                f"({worst['group']}). A short shift can be deliberate.",
                _p(worst["gapPct"], 0),
                f"Why does {small['label']} have so few people compared with {large['label']}, and is the staffing right?",
            )
        )
    late = shifts_attendance(scope, period, today=today)
    gap = _late_gap_row(late)
    if gap:
        overall = late["overall"]["latePct"]
        critical = gap["latePct"] >= max(LATE_CRITICAL_RATIO * overall, LATE_CRITICAL_MIN_PCT)
        items.append(
            _item(
                "late-gap",
                "critical" if critical else "warning",
                f"Late arrivals are {_p(gap['latePct'])} on {gap['label']}, against {_p(overall)} overall",
                f"{period.label}: {_num(gap['lateDays'])} late days in {_num(gap['workedDays'])} worked days on this "
                "shift.",
                _p(gap["latePct"]),
                f"Why are late arrivals so high on {gap['label']} ({period.label}), and which departments drive it?",
            )
        )
    moved, prev_moved = ch["moved"], ch["previous"]["moved"]
    if moved >= CHANGE_SPIKE_MIN and prev_moved and moved >= CHANGE_SPIKE_RATIO * prev_moved:
        items.append(
            _item(
                "changes",
                "info",
                f"Shift changes jumped to {_num(moved)} from {_num(prev_moved)}",
                f"{period.label} against {_previous_phrase(period)}: {_num(ch['peopleMoved'])} people moved between "
                "shifts.",
                _num(moved),
                f"Why did so many employees change shift ({period.label}), and which shifts did they move between?",
            )
        )
    unused = summary["shifts"]["unused"]
    if unused:
        items.append(
            _item(
                "unused",
                "info",
                f"{_num(unused)} active {_plural(unused, 'shift has', 'shifts have')} nobody on {_plural(unused, 'it', 'them')}",
                "A shift nobody works is usually a leftover: it can be switched off in Manage Shift.",
                _num(unused),
                "Which shifts have nobody assigned, and can they be switched off?",
            )
        )
    if e["active"] and not any(i["severity"] in ("critical", "warning") for i in items):
        items.append(
            _item(
                "healthy",
                "good",
                f"Every employee is on a shift ({_num(e['active'])} of {_num(e['active'])})",
                "Nobody is without a shift, no assignment overlaps or runs out soon, and the shifts are evenly staffed.",
                _p(e["coveragePct"]),
                "Summarise how the shifts are staffed and whether anything needs attention.",
            )
        )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items[:limit]


@cached()
def shifts_attention(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    today = today or ist_today()
    items = _exceptions(scope, period, today, limit=6)
    thresholds = prov(
        "shift-attention",
        "Needs your attention",
        dataset="Employees, shift assignments, attendance day records",
        definition=(
            "Employees with no shift are flagged whenever there are any (critical from "
            f"{_p(UNASSIGNED_CRITICAL_PCT, 0)} of the workforce). Shifts of one unit and type are 'uneven' when the "
            f"smallest has {_p(IMBALANCE_FLAG_PCT, 0)}+ fewer people than the biggest and the biggest has "
            f"{IMBALANCE_MIN_LARGEST}+ people. A shift's late % is flagged at {LATE_FLAG_RATIO:g}× the overall rate and "
            f"{LATE_FLAG_POINTS:g}+ points above it, with {MIN_SAMPLE_DAYS}+ worked days (critical from "
            f"{LATE_CRITICAL_RATIO:g}× and {_p(LATE_CRITICAL_MIN_PCT, 0)}). Shift moves are flagged at "
            f"{CHANGE_SPIKE_MIN}+ and {CHANGE_SPIKE_RATIO:g}× the previous period."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe()],
        caveats=["These are rules of thumb: no staffing target per shift is configured in the system."],
    )
    return envelope({"items": items, "total": len(items)}, period=period, scope=scope, provenance=[thresholds])


def _recent_period(today: date) -> Period:
    """The last 30 days, built exactly as the attendance headline builds it so the two share one cached frame."""
    return Period(today - timedelta(days=29), today, "last_30_days", "Last 30 days")


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3)."""
    today = today or ist_today()
    return _exceptions(Scope(), _recent_period(today), today, limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's shift cards: employees with no shift (now) and shift changes over the last 30 days against the 30
    before, with a 14-day sparkline. Fewer people without a shift is good news; whether more changes is good is not
    for us to say."""
    today = today or ist_today()
    period = _recent_period(today)
    scope = Scope()
    unassigned = shifts_unassigned(scope, limit=1, today=today)
    totals = _change_totals(scope, period.start, period.end)
    prev = _change_totals(scope, period.previous().start, period.previous().end)
    per_day = _daily_starts(scope, today - timedelta(days=13), today)
    spark = [per_day.get(today - timedelta(days=13 - i), {}).get(MOVED, 0) for i in range(14)]
    moved_delta = change(totals["moved"], prev["moved"])
    active, without = unassigned["active"], unassigned["total"]
    kpis = [
        {
            "id": "shifts.unassigned",
            "label": "Employees without a shift",
            "value": without if active else None,
            "format": "number",
            "sub": (
                f"of {_num(active)} active · {_p(pct(active - without, active))} on a shift"
                if active
                else "No active employees"
            ),
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
        {
            "id": "shifts.changes",
            "label": "Shift changes, 30 days",
            "value": totals["moved"],
            "format": "number",
            "sub": f"{_num(totals['peopleMoved'])} {_plural(totals['peopleMoved'], 'person', 'people')} moved · "
            f"{_num(prev['moved'])} in the previous 30 days",
            "delta": {**moved_delta, "good": None} if moved_delta else None,
            "spark": spark,
            "page": PAGE,
        },
    ]
    entries = _provenance(scope, period, today, rows={"without": without, "active": active, "started": totals["started"]})
    return {"kpis": kpis, "provenance": _pick(entries, "shift-unassigned", "shift-changes", "shift-previous")}


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)
_DAYS = integer_param(
    f"Look this many days ahead (default {ENDING_SOON_DAYS}, at most {MAX_ENDING_SOON_DAYS})",
    minimum=1,
    maximum=MAX_ENDING_SOON_DAYS,
)

TOOLS = [
    tool(
        "shifts_summary",
        "Shifts and who works them, in one lookup: active employees, how many are on a shift today and how many have "
        "none (and how many of those have one starting later), the shifts in use and shifts nobody is on, shift "
        "changes in the period (moves between shifts, first assignments, renewals) against the previous period, "
        "assignments ending soon or overlapping, and whether the shifts of a unit are evenly staffed. Use for 'how are "
        "shifts staffed', 'does everyone have a shift' and 'how many people changed shift'. Percentages are 0-100. "
        "'Today' is the factory's date; changes follow the period.",
        shifts_summary,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "shifts_coverage",
        "How many people are on each shift TODAY, with the staff / production split and share of the workforce, the "
        "shift x department grid, people on no shift, active shifts nobody is on, and a staffing balance check (the "
        "smallest shift against the biggest of the same unit and type). Use for 'how many people are on the night "
        "shift', 'which departments work which shift' and 'is any shift under-staffed'. Shifts that share a name carry "
        "their unit in the label.",
        shifts_coverage,
        page=PAGE,
        period=None,
    ),
    tool(
        "shifts_unassigned",
        "Active employees who are on no shift today, with their department, unit, joining date, the shift they had "
        "(if one ended) or the date a new one starts, the longest uncovered first, plus counts by department. Use for "
        "'who has no shift', 'which department has people without a shift'. They get no late or half-day detection in "
        "attendance until a shift is assigned.",
        shifts_unassigned,
        page=PAGE,
        period=None,
        extra={"limit": _LIMIT},
        defaults={"limit": LIST_DEFAULT},
    ),
    tool(
        "shifts_changes",
        "Shift changes over a period: day by day (week by week beyond 62 days) how many assignments started, split into "
        "moves between shifts, first assignments and renewals, the totals with the previous period, and each shift's "
        "people moved in and out (net). Use for 'how often do people change shift', 'who moved to the night shift' and "
        "'is shift churn rising'.",
        shifts_changes,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "shifts_attendance",
        "Attendance, absenteeism and late arrivals per shift for a period, each with the previous period and against the "
        "overall rate: worked days, late days, late %, attendance %, absent %, and the people on the shift. Days with no "
        "shift are 'No shift assigned'. Use for 'which shift has the most late arrivals', 'does attendance differ by "
        "shift'. Shifts with few worked days are marked 'small sample'. Percentages are 0-100.",
        shifts_attendance,
        page=PAGE,
        period="last_30_days",
    ),
    tool(
        "shifts_watch",
        "Shift assignments that need a decision: employees whose shift ends within N days (default 14) with nothing "
        "after it, employees covered by two assignments at once, and how many employees have a shift scheduled to "
        "start later. Lists the people with the shift and the dates. Use for 'whose shift ends soon', 'who is assigned "
        "to two shifts'.",
        shifts_watch,
        page=PAGE,
        period=None,
        extra={"days": _DAYS, "limit": _LIMIT},
        defaults={"days": ENDING_SOON_DAYS, "limit": LIST_DEFAULT},
    ),
]
