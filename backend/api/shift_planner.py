"""
Planning (and applying) a shift assignment for many employees at once.

The Manage Shifts screen lets HR pick any number of employees, departments and designations, each either
INCLUDED or EXCLUDED, then shows exactly what would happen before anything is written. This module is the one
place that decides it, for the preview (``plan``) and for the real thing (``apply``), so the two can never disagree:
``apply`` re-plans inside a transaction and acts only on that fresh plan.

Selection
    An active employee is selected when they match ANY included item (the employee, their department, their
    designation, or "everyone of this shift's type"). Anything excluded is then left out, and an exclusion always
    wins over an inclusion.

What happens to each selected employee, on the chosen effective date D
    new        no shift covers them on D                         -> a new assignment is created
    unchanged  already on this shift with the same schedule      -> nothing to do
    conflict   already on another shift, or the same shift with a different schedule, or a shift is scheduled to
               start later -> HR chooses per employee (or for all): KEEP what they have, or REASSIGN them
    skipped    the shift cannot be given to them (production shift for a staff employee, a Female-only shift for a
               man, a shift that belongs to another branch)
    blocked    they already have a shift that STARTED after D (backdating over it would rewrite their history)
    excluded   matched an inclusion but an exclusion removed them

How a reassignment is written (attendance, payroll and the Report Center all resolve a day to the assignment with
the latest ``effective_from`` that covers it, so this must never leave two assignments covering one day):
    * the assignment in effect is closed the day BEFORE D and a new one starts on D;
    * if it already started on D it is changed in place (two assignments starting the same day would tie);
    * an assignment that is merely scheduled for the future is cancelled (closed before it starts).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time, timedelta
from typing import Any

from django.db import transaction
from django.db.models import Q

from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import Department, Designation, Employee, EmployeeShiftAssignment, ShiftTemplate

NEW = "new"
UNCHANGED = "unchanged"
CONFLICT = "conflict"
SKIPPED = "skipped"
BLOCKED = "blocked"
EXCLUDED = "excluded"

KEEP = "keep"
REASSIGN = "reassign"

MAX_NOTES = 500
_ONE_DAY = timedelta(days=1)


# ── The request ──────────────────────────────────────────────────────────────


@dataclass
class Rule:
    include: set[int] = field(default_factory=set)
    exclude: set[int] = field(default_factory=set)


@dataclass
class PlanRequest:
    shift_id: int | None = None
    effective_from: date | None = None
    include_all: bool = False
    employees: Rule = field(default_factory=Rule)
    departments: Rule = field(default_factory=Rule)
    designations: Rule = field(default_factory=Rule)
    custom_start: time | None = None
    custom_end: time | None = None
    saturday_off: bool = False
    notes: str | None = None
    on_conflict: str = KEEP
    decisions: dict[int, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def has_selection(self) -> bool:
        return bool(self.include_all or self.employees.include or self.departments.include or self.designations.include)


def _ids(raw: Any, label: str, errors: list[str]) -> set[int]:
    if raw in (None, ""):
        return set()
    if not isinstance(raw, list):
        errors.append(f"{label} must be a list of ids")
        return set()
    out: set[int] = set()
    for v in raw:
        try:
            out.add(int(v))
        except (TypeError, ValueError):
            errors.append(f"{label} contains an invalid id")
            return set()
    return out


def _rule(raw: Any, label: str, errors: list[str]) -> Rule:
    if raw in (None, ""):
        return Rule()
    if not isinstance(raw, dict):
        errors.append(f"{label} must be an object with include / exclude lists")
        return Rule()
    return Rule(
        _ids(raw.get("include"), f"{label} include", errors), _ids(raw.get("exclude"), f"{label} exclude", errors)
    )


def parse_time(raw: Any, label: str, errors: list[str]) -> time | None:
    if raw in (None, ""):
        return None
    try:
        return time.fromisoformat(str(raw))
    except ValueError:
        errors.append(f"{label} must be a time like 09:30")
        return None


def parse_request(data: Any) -> PlanRequest:
    """Read the request body. Anything malformed becomes an entry in ``errors`` (never an exception)."""
    req = PlanRequest()
    if not isinstance(data, dict):
        req.errors.append("Send a JSON object")
        return req
    errors = req.errors

    try:
        req.shift_id = int(data.get("shiftId")) if data.get("shiftId") not in (None, "") else None
    except (TypeError, ValueError):
        errors.append("shiftId is invalid")
    raw_date = data.get("effectiveFrom")
    if raw_date:
        try:
            req.effective_from = date.fromisoformat(str(raw_date)[:10])
        except ValueError:
            errors.append("Effective date is not a valid date")

    selection = data.get("selection") or {}
    if not isinstance(selection, dict):
        errors.append("selection must be an object")
        selection = {}
    req.include_all = bool(selection.get("includeAll"))
    req.employees = _rule(selection.get("employees"), "employees", errors)
    req.departments = _rule(selection.get("departments"), "departments", errors)
    req.designations = _rule(selection.get("designations"), "designations", errors)

    req.custom_start = parse_time(data.get("customStartTime"), "Custom start time", errors)
    req.custom_end = parse_time(data.get("customEndTime"), "Custom end time", errors)
    req.saturday_off = bool(data.get("saturdayOff", False))
    notes = data.get("notes")
    if notes not in (None, ""):
        notes = str(notes).strip()
        if len(notes) > MAX_NOTES:
            errors.append(f"Notes can be at most {MAX_NOTES} characters")
        req.notes = notes or None

    on_conflict = data.get("onConflict") or KEEP
    if on_conflict not in (KEEP, REASSIGN):
        errors.append("onConflict must be 'keep' or 'reassign'")
    else:
        req.on_conflict = on_conflict
    decisions = data.get("decisions") or {}
    if not isinstance(decisions, dict):
        errors.append("decisions must be an object")
        decisions = {}
    for k, v in decisions.items():
        try:
            emp_id = int(k)
        except (TypeError, ValueError):
            errors.append("decisions has an invalid employee id")
            continue
        if v not in (KEEP, REASSIGN):
            errors.append("Each decision must be 'keep' or 'reassign'")
            continue
        req.decisions[emp_id] = v
    return req


# ── The plan ─────────────────────────────────────────────────────────────────


def _hm(t: time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def _valid(a: EmployeeShiftAssignment) -> bool:
    """An assignment closed before it started (how a cancelled one is stored) covers no day at all."""
    return a.effective_to is None or a.effective_to >= a.effective_from


def _current_json(a: EmployeeShiftAssignment) -> dict:
    s = a.shift
    return {
        "assignmentId": a.id,
        "shiftId": a.shift_id,
        "shiftName": s.name,
        "startTime": _hm(a.custom_start_time or s.start_time),
        "endTime": _hm(a.custom_end_time or s.end_time),
        "effectiveFrom": a.effective_from.isoformat(),
        "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
        "customStartTime": _hm(a.custom_start_time),
        "customEndTime": _hm(a.custom_end_time),
        "saturdayOff": a.saturday_off,
    }


@dataclass
class Row:
    employee: Employee
    via: list[str]
    status: str = NEW
    action: str = "none"  # assign | reassign | keep | none
    reason: str | None = None
    current: EmployeeShiftAssignment | None = None
    scheduled: list[EmployeeShiftAssignment] = field(default_factory=list)
    decision: str | None = None
    outcome: str | None = None  # filled by apply: created | reassigned | updated | kept | unchanged | skipped | ...

    def as_json(self) -> dict:
        e = self.employee
        out = {
            "employeeId": e.id,
            "employeeCode": e.employee_code,
            "name": f"{e.first_name} {e.last_name}".strip(),
            "employmentType": e.employment_type,
            "gender": e.gender,
            "department": e.department.name if e.department_id and e.department else None,
            "designation": e.designation.title if e.designation_id and e.designation else None,
            "via": self.via,
            "status": self.status,
            "action": self.action,
            "reason": self.reason,
            "decision": self.decision,
            "current": _current_json(self.current) if self.current else None,
            "scheduled": [
                {"assignmentId": a.id, "shiftName": a.shift.name, "effectiveFrom": a.effective_from.isoformat()}
                for a in self.scheduled
            ],
        }
        if self.outcome:
            out["outcome"] = self.outcome
        return out


@dataclass
class Plan:
    request: PlanRequest
    shift: ShiftTemplate | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    rows: list[Row] = field(default_factory=list)
    lost: int = 0  # selected by id but not active / not in the caller's branch

    @property
    def ok(self) -> bool:
        return not self.errors

    def counts(self) -> dict:
        by = {k: 0 for k in (NEW, UNCHANGED, CONFLICT, SKIPPED, BLOCKED, EXCLUDED)}
        for r in self.rows:
            by[r.status] += 1
        reassign = sum(1 for r in self.rows if r.status == CONFLICT and r.action == "reassign")
        kept = sum(1 for r in self.rows if r.status == CONFLICT and r.action == "keep")
        return {
            "selected": len(self.rows) - by[EXCLUDED],
            "matched": len(self.rows),
            "new": by[NEW],
            "alreadyAssigned": by[UNCHANGED] + by[CONFLICT],
            "alreadyOnThisShift": by[UNCHANGED],
            "conflicts": by[CONFLICT],
            "willReassign": reassign,
            "kept": kept,
            "skipped": by[SKIPPED],
            "excluded": by[EXCLUDED],
            "blocked": by[BLOCKED],
            "willChange": by[NEW] + reassign,
        }

    def as_json(self) -> dict:
        s = self.shift
        order = {BLOCKED: 0, CONFLICT: 1, NEW: 2, UNCHANGED: 3, SKIPPED: 4, EXCLUDED: 5}
        rows = sorted(self.rows, key=lambda r: (order[r.status], r.employee.first_name.lower(), r.employee.id))
        return {
            "ok": self.ok,
            "errors": self.errors,
            "warnings": self.warnings,
            "shift": (
                {
                    "id": s.id,
                    "name": s.name,
                    "shiftType": s.shift_type,
                    "startTime": _hm(s.start_time),
                    "endTime": _hm(s.end_time),
                    "genderRule": s.gender_rule,
                }
                if s
                else None
            ),
            "effectiveFrom": self.request.effective_from.isoformat() if self.request.effective_from else None,
            "counts": self.counts(),
            "rows": [r.as_json() for r in rows],
        }


def _same_schedule(a: EmployeeShiftAssignment, req: PlanRequest) -> bool:
    return (
        a.custom_start_time == req.custom_start
        and a.custom_end_time == req.custom_end
        and bool(a.saturday_off) == bool(req.saturday_off)
    )


def _schedule_note(a: EmployeeShiftAssignment) -> str:
    bits = []
    if a.custom_start_time or a.custom_end_time:
        bits.append(f"custom hours {_hm(a.custom_start_time) or 'default'} to {_hm(a.custom_end_time) or 'default'}")
    if a.saturday_off:
        bits.append("Saturday off")
    return ", ".join(bits) if bits else "the shift's standard schedule"


def _check_request(request, req: PlanRequest, plan: Plan) -> None:
    errors = plan.errors
    errors.extend(req.errors)

    if req.shift_id is None:
        errors.append("Choose a shift")
    else:
        shift = scope_to_branch(ShiftTemplate.objects, request, field="branch_id").filter(pk=req.shift_id).first()
        if shift is None:
            errors.append("That shift was not found")
        else:
            plan.shift = shift
            if not shift.is_active:
                errors.append(f"'{shift.name}' is inactive. Activate it before assigning anyone to it")

    today = ist_today()
    if req.effective_from is None:
        if not any("date" in e for e in req.errors):
            errors.append("Choose the date the shift starts from")
    else:
        if req.effective_from < today:
            plan.warnings.append(
                f"{req.effective_from.isoformat()} is in the past. Attendance and payroll for the days since then "
                "will use this shift the next time they are calculated."
            )
        if req.effective_from > today + timedelta(days=365):
            errors.append("The start date is more than a year away")

    if not req.has_selection:
        errors.append("Choose at least one employee, department or designation to include")

    if plan.shift is not None:
        s = plan.shift
        start = req.custom_start or s.start_time
        end = req.custom_end or s.end_time
        if (req.custom_start or req.custom_end) and start and end and end <= start:
            errors.append(
                f"The custom schedule runs {_hm(start)} to {_hm(end)}. A shift cannot end before it starts "
                "(overnight shifts are not supported)"
            )
        if req.saturday_off and s.shift_type != "staff":
            errors.append("Saturday off applies to staff shifts only")


def _selected_employees(request, req: PlanRequest, shift: ShiftTemplate, plan: Plan):
    """(employee, via) for everyone an inclusion matches, plus the exclusion explanation for each."""
    qs = scope_to_branch(Employee.objects, request).filter(status="active").select_related("department", "designation")
    q = Q()
    if req.employees.include:
        q |= Q(pk__in=req.employees.include)
    if req.departments.include:
        q |= Q(department_id__in=req.departments.include)
    if req.designations.include:
        q |= Q(designation_id__in=req.designations.include)
    if req.include_all:
        q |= Q(employment_type=shift.shift_type)
    employees = list(qs.filter(q).order_by("first_name", "last_name", "id")) if q else []

    found = {e.id for e in employees}
    plan.lost = len(req.employees.include - found)
    if plan.lost:
        plan.warnings.append(
            f"{plan.lost} selected employee{'s are' if plan.lost != 1 else ' is'} not active or not in your branch "
            "and left out."
        )

    dept_names = dict(
        Department.objects.filter(pk__in=req.departments.include | req.departments.exclude).values_list("id", "name")
    )
    desig_names = dict(
        Designation.objects.filter(pk__in=req.designations.include | req.designations.exclude).values_list(
            "id", "title"
        )
    )

    out = []
    for e in employees:
        via: list[str] = []
        if e.id in req.employees.include:
            via.append("Selected directly")
        if e.department_id in req.departments.include:
            via.append(f"Department: {dept_names.get(e.department_id, e.department_id)}")
        if e.designation_id in req.designations.include:
            via.append(f"Designation: {desig_names.get(e.designation_id, e.designation_id)}")
        if req.include_all and e.employment_type == shift.shift_type:
            via.append(f"All {shift.shift_type} employees")
        why_out: str | None = None
        if e.id in req.employees.exclude:
            why_out = "Left out: employee excluded"
        elif e.department_id and e.department_id in req.departments.exclude:
            why_out = f"Left out: department {dept_names.get(e.department_id, e.department_id)} excluded"
        elif e.designation_id and e.designation_id in req.designations.exclude:
            why_out = f"Left out: designation {desig_names.get(e.designation_id, e.designation_id)} excluded"
        out.append((e, via, why_out))
    return out


def plan(request, req: PlanRequest, *, lock: bool = False) -> Plan:
    """Work out what assigning ``req.shift_id`` from ``req.effective_from`` would do. Reads only (``lock`` takes row
    locks on the employees' assignments, for ``apply``)."""
    result = Plan(request=req)
    _check_request(request, req, result)
    if result.shift is None or req.effective_from is None or not req.has_selection or result.errors:
        return result

    shift, day, today = result.shift, req.effective_from, ist_today()
    picked = _selected_employees(request, req, shift, result)

    ids = [e.id for e, _via, why in picked if why is None]
    asg_qs = EmployeeShiftAssignment.objects.filter(employee_id__in=ids).select_related("shift")
    if lock:
        asg_qs = asg_qs.select_for_update(of=("self",))
    assignments: dict[int, list[EmployeeShiftAssignment]] = {}
    for a in asg_qs.order_by("effective_from", "id"):
        if _valid(a):
            assignments.setdefault(a.employee_id, []).append(a)

    for e, via, why_out in picked:
        row = Row(e, via)
        result.rows.append(row)
        if why_out:
            row.status, row.reason = EXCLUDED, why_out
            continue

        # 1. the shift cannot be given to this person at all
        etype = (e.employment_type or "staff").title()
        if shift.shift_type != e.employment_type:
            row.status = SKIPPED
            row.reason = (
                f"This is a {shift.shift_type} shift; {e.first_name} is a {e.employment_type} employee. "
                f"{etype} employees use {e.employment_type} shifts"
            )
            continue
        if shift.gender_rule and shift.gender_rule != "all" and e.gender != shift.gender_rule:
            row.status = SKIPPED
            row.reason = f"This shift is {shift.gender_rule} only" + (
                "" if e.gender else " and no gender is recorded for this employee"
            )
            continue
        if shift.branch_id and e.branch_id != shift.branch_id:
            row.status, row.reason = SKIPPED, "This shift belongs to another branch"
            continue

        # 2. what they have now, on the chosen day
        mine = assignments.get(e.id, [])
        covering = [a for a in mine if a.effective_from <= day and (a.effective_to is None or a.effective_to >= day)]
        row.current = max(covering, key=lambda a: (a.effective_from, a.id)) if covering else None
        later = [a for a in mine if a.effective_from > day]
        started = [a for a in later if a.effective_from <= today]
        row.scheduled = [a for a in later if a.effective_from > today]

        if started:
            nxt = min(started, key=lambda a: a.effective_from)
            row.status = BLOCKED
            row.reason = (
                f"Already on '{nxt.shift.name}' since {nxt.effective_from.isoformat()}, which is after "
                f"{day.isoformat()}. Choose {nxt.effective_from.isoformat()} or later, or leave this employee out"
            )
            continue

        if row.current is None and not row.scheduled:
            row.status, row.action = NEW, "assign"
            continue

        if (
            row.current is not None
            and row.current.shift_id == shift.id
            and _same_schedule(row.current, req)
            and not row.scheduled
        ):
            row.status, row.reason = UNCHANGED, "Already on this shift"
            continue

        # 3. something is in the way: HR decides
        row.status = CONFLICT
        notes = []
        if row.current is not None:
            if row.current.shift_id != shift.id:
                notes.append(f"Already on '{row.current.shift.name}' since {row.current.effective_from.isoformat()}")
            elif not _same_schedule(row.current, req):
                notes.append(
                    f"Already on this shift with {_schedule_note(row.current)} since {row.current.effective_from.isoformat()}"
                )
        for a in row.scheduled:
            notes.append(f"'{a.shift.name}' is scheduled from {a.effective_from.isoformat()} and would be cancelled")
        row.reason = ". ".join(notes)
        row.decision = req.decisions.get(e.id, req.on_conflict)
        row.action = "reassign" if row.decision == REASSIGN else "keep"
        if row.current is None and row.decision == REASSIGN:
            row.action = "assign"  # nothing to move them from; only the scheduled shift is replaced
    return result


# ── Applying ─────────────────────────────────────────────────────────────────


def _write(
    row: Row, req: PlanRequest, shift: ShiftTemplate, actor: str, existing: list[EmployeeShiftAssignment]
) -> str:
    """Give ``row.employee`` the shift from ``req.effective_from``. Returns what was done."""
    day = req.effective_from
    fresh = dict(
        shift=shift,
        effective_from=day,
        effective_to=None,
        assigned_by=actor,
        notes=req.notes,
        custom_start_time=req.custom_start,
        custom_end_time=req.custom_end,
        saturday_off=req.saturday_off,
    )
    same_day = [a for a in existing if a.effective_from == day]
    for a in existing:
        if a.effective_from > day:  # scheduled for later: cancelled (closed before it starts)
            a.effective_to = a.effective_from - _ONE_DAY
            a.save(update_fields=["effective_to"])
        elif a.effective_from < day and (a.effective_to is None or a.effective_to >= day):
            a.effective_to = day - _ONE_DAY
            a.save(update_fields=["effective_to"])
    if same_day:
        keep = max(same_day, key=lambda a: a.id)
        for k, v in fresh.items():
            setattr(keep, k, v)
        keep.save()
        for a in same_day:
            if a.id != keep.id:
                a.effective_to = day - _ONE_DAY
                a.save(update_fields=["effective_to"])
        return "updated"
    EmployeeShiftAssignment.objects.create(employee=row.employee, **fresh)
    return "reassigned" if row.current is not None else "created"


def apply(request, req: PlanRequest, actor: str) -> Plan:
    """Plan again inside a transaction and write what that plan says. Nothing is written when the plan has errors."""
    with transaction.atomic():
        result = plan(request, req, lock=True)
        if not result.ok or result.shift is None:
            return result
        existing: dict[int, list[EmployeeShiftAssignment]] = {}
        todo = [r for r in result.rows if r.action in ("assign", "reassign")]
        for a in EmployeeShiftAssignment.objects.filter(employee_id__in=[r.employee.id for r in todo]).select_related(
            "shift"
        ):
            if _valid(a):
                existing.setdefault(a.employee_id, []).append(a)
        for r in result.rows:
            if r.action in ("assign", "reassign"):
                r.outcome = _write(r, req, result.shift, actor, existing.get(r.employee.id, []))
            elif r.status == CONFLICT:
                r.outcome = "kept"
            elif r.status == UNCHANGED:
                r.outcome = "unchanged"
            elif r.status in (SKIPPED, BLOCKED, EXCLUDED):
                r.outcome = r.status
    return result


def applied_counts(result: Plan) -> dict:
    out = {
        "created": 0,
        "reassigned": 0,
        "updated": 0,
        "kept": 0,
        "unchanged": 0,
        "skipped": 0,
        "blocked": 0,
        "excluded": 0,
    }
    for r in result.rows:
        if r.outcome in out:
            out[r.outcome] += 1
    out["assigned"] = out["created"] + out["reassigned"] + out["updated"]
    return out
