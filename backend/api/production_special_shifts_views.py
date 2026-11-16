"""
Production shifts on Manage Shifts (owner 2026-11-16).

The production shifts ARE the shift groups of Settings -> Production Shifts: Manage Shifts shows those default groups
(their timings, the detection timings worked out from the rules' grace, their Earned Shift tables and the unpaid
breaks) instead of a separate, unrelated shift template; they are edited in Settings only. Every production worker is on
them unless put on a SPECIAL shift: a complete shift of its own (start, standard departure, the days it applies to and
its own Earned Shift table) made here, for the workers assigned to it, from a chosen date. On those dates and days the
worker is judged AND paid by it (production_shift_rules.select_group); on its other days, and everyone else always, the
defaults. Staff shifts are not touched by anything here.

  GET    /api/shifts/production                                  the default shifts, the special shifts and who is on them
  POST   /api/shifts/production/special                          a new special shift
  PUT    /api/shifts/production/special/<id>                     change one (its ladder, times, on / off)
  DELETE /api/shifts/production/special/<id>[?force=1]           one that had workers needs force=1: its assignments go
                                                                  with it and those workers' days go back to the defaults
  POST   /api/shifts/production/special/<id>/assign              {employeeIds, effectiveFrom, effectiveTo?, note?}
  POST   /api/shifts/production/special-assignments/<id>/end     {lastDay?}: the worker is on it up to that day
  DELETE /api/shifts/production/special-assignments/<id>[?force=1]  take a worker off; one that has started needs
                                                                  force=1 (its days go back to the default shifts)

The shift tables are company-wide, so a branch login may read them and assign its own workers but not create, change or
delete a special shift. Days already worked out are worked out again from the punches the next time they are read (as
after any rule change); a production payroll already generated for those days needs Generate again (a Paid one never
changes).
"""

from __future__ import annotations

from datetime import date as date_type, timedelta

from django.db import transaction
from django.db.models import Max
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .models import (
    Employee,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
    ProductionSpecialShiftAssignment,
)
from .production_period_workflow import actor_name
from .production_shift_rules_views import (
    MAX_GROUPS,
    SettingsError,
    _document,
    _load_state,
    _parse_groups,
    _plain,
    _read_body,
    _to_time,
    _write_row,
    group_doc,
    special_group_docs,
    validate_special,
)

COMPANY_WIDE = (
    "Special production shifts apply to the whole company, so a branch login can assign its own workers but not "
    "create, change or delete one. Ask an administrator or a head-office login."
)
BACK_TO_DEFAULTS_NOTE = (
    "{who} {verb} back on the default production shifts for {span}: those days are worked out again with them. A "
    "production payroll already generated for those days needs Generate again; a Paid one never changes."
)
PAST_DAYS_NOTE = (
    "Days from {day} are worked out again with this change. A production payroll already generated for those days "
    "needs Generate again; a Paid one never changes."
)


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _forced(request: Request) -> bool:
    return str(request.query_params.get("force", "")).lower() in ("1", "true", "yes")


def _worked_span(assignments, today: date_type) -> tuple[date_type, date_type] | None:
    """The days already worked under these assignments (from the earliest start to the latest day up to today), or
    None when none has started: the days a removal sends back to the default shifts."""
    started = [a for a in assignments if a.effective_from <= today]
    if not started:
        return None
    first = min(a.effective_from for a in started)
    last = max(min(a.effective_to or today, today) for a in started)
    return first, last


def _span_text(span: tuple[date_type, date_type]) -> str:
    first, last = span
    if first == last:
        return first.strftime("%d %b %Y")
    return f"{first.strftime('%d %b %Y')} to {last.strftime('%d %b %Y')}"


def _date(value, what: str) -> date_type:
    try:
        return date_type.fromisoformat(str(value)[:10])
    except (TypeError, ValueError) as exc:
        raise SettingsError(f"{what} must be a date written YYYY-MM-DD.") from exc


def _assignment_json(a: ProductionSpecialShiftAssignment, today: date_type) -> dict:
    e = a.employee
    return {
        "id": a.id,
        "groupId": a.group_id,
        "employeeId": e.id,
        "employeeCode": e.employee_code,
        "employeeName": f"{e.first_name} {e.last_name}".strip(),
        "department": e.department.name if e.department_id and e.department else None,
        "effectiveFrom": a.effective_from.isoformat(),
        "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
        "note": a.note or "",
        # on it today / not started yet / over
        "state": (
            "upcoming"
            if a.effective_from > today
            else "ended"
            if a.effective_to is not None and a.effective_to < today
            else "active"
        ),
    }


def _plain_group(doc: dict) -> dict:
    """A group document as Settings sends it: shift values are JSON numbers (0.25), the same both ways."""
    return _plain(doc)


def overview_body(request: Request) -> dict:
    today = ist_today()
    state = _load_state()
    doc = _document(state)
    production = scope_to_branch(Employee.objects, request).filter(status="active", employment_type="production")
    roster = production.count()
    assignments = list(
        ProductionSpecialShiftAssignment.objects.filter(employee__in=production)
        .select_related("employee", "employee__department")
        .order_by("group_id", "effective_from", "employee__first_name")
    )
    by_group: dict[int, list] = {}
    on_special_today: set[int] = set()
    for a in assignments:
        row = _assignment_json(a, today)
        by_group.setdefault(a.group_id, []).append(row)
        if row["state"] == "active":
            on_special_today.add(a.employee_id)
    special = []
    for g in special_group_docs():
        rows = by_group.get(g["id"], [])
        special.append({
            **_plain_group(g),
            "assignments": rows,
            "activeCount": sum(1 for r in rows if r["state"] == "active"),
            # every assignment ever made (in this login's scope): one that has any cannot be deleted
            "everAssigned": ProductionSpecialShiftAssignment.objects.filter(group_id=g["id"]).exists(),
        })
    return {
        "enabled": doc["enabled"],
        "effectiveFrom": doc["effectiveFrom"],
        "graceMinutes": doc["graceMinutes"],
        "minCredit": float(doc["minCredit"]),
        "roundingStep": float(doc["roundingStep"]),
        "fullDayValue": float(doc["fullDayValue"]),
        "breaks": [b for b in doc["breaks"] if b["enabled"]],
        "defaults": [_plain_group(g) for g in doc["groups"]],
        "special": special,
        "roster": {"production": roster, "onSpecialToday": len(on_special_today)},
        "today": today.isoformat(),
    }


@api_view(["GET"])
@require_hr
def production_shifts_overview(request: Request) -> Response:
    """GET /api/shifts/production: see the module docstring."""
    return Response(overview_body(request))


def _parse_special(data: dict, existing: ProductionShiftGroup | None) -> dict:
    """The submitted special shift, parsed and checked like a Settings group. A special shift takes part in no
    first-punch selection, so its first-punch window is optional (its start time when not sent)."""
    before = [group_doc(existing, list(existing.rules.order_by("order", "id")))] if existing else []
    item = dict(data)
    if existing is not None:
        item["id"] = existing.id
    else:
        item.pop("id", None)
    item.setdefault("kind", "custom")
    # never used to pick the shift (it is assigned), so it simply follows the start time unless sent
    start = item.get("startTime") or (before[0]["startTime"] if before else None)
    item["firstPunchFrom"] = item.get("firstPunchFrom") or start
    item["firstPunchTo"] = item.get("firstPunchTo") or start
    for rule in item.get("rules") or []:
        if isinstance(rule, dict) and "id" in rule and existing is None:
            rule.pop("id")
    group = _parse_groups([item], before)[0]
    breaks = [b for b in _document(_load_state())["breaks"]]
    validate_special(group, breaks, ProductionShiftConfig.get().rules_min_credit)
    if not [r for r in group["rules"] if r["enabled"]]:
        raise SettingsError(f"{group['label']} needs at least one Earned Shift row that is switched on.")
    return group


def _write_special(group: dict, existing: ProductionShiftGroup | None) -> ProductionShiftGroup:
    order = existing.order if existing else (ProductionShiftGroup.objects.aggregate(m=Max("order"))["m"] or 0) + 1
    fields = {
        "label": group["label"],
        "kind": group["kind"],
        "applies_on": group["appliesOn"],
        "start_time": _to_time(group["startTime"]),
        "first_punch_from": _to_time(group["firstPunchFrom"]),
        "first_punch_to": _to_time(group["firstPunchTo"]),
        "main_out_time": _to_time(group["mainOutTime"]) if group["mainOutTime"] is not None else None,
        "main_out_next_day": group["mainOutNextDay"],
        "enabled": group["enabled"],
        "order": order,
        "is_special": True,
    }
    saved = _write_row(ProductionShiftGroup, existing, fields)
    stored_rules = {r.id: r for r in saved.rules.all()} if existing else {}
    keep = {r["id"] for r in group["rules"] if r["id"] is not None}
    gone = [rid for rid in stored_rules if rid not in keep]
    if gone:
        ProductionShiftRule.objects.filter(id__in=gone).delete()
    for rule_order, r in enumerate(group["rules"], start=1):
        _write_row(
            ProductionShiftRule,
            stored_rules.get(r["id"]),
            {
                "label": r["label"],
                "out_time": _to_time(r["outTime"]),
                "out_next_day": r["outNextDay"],
                "shift_value": r["shiftValue"],
                "enabled": r["enabled"],
                "order": rule_order,
            },
            group=saved,
        )
    return saved


def _special_or_404(pk: int) -> ProductionShiftGroup | None:
    return ProductionShiftGroup.objects.filter(pk=pk, is_special=True).first()


@api_view(["POST"])
@require_hr
def production_special_shifts(request: Request) -> Response:
    """POST /api/shifts/production/special: a new special shift (see the module docstring)."""
    if get_branch_scope(request) is not None:
        return _error(COMPANY_WIDE, 403, code="company_wide_settings")
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    if ProductionShiftGroup.objects.count() >= MAX_GROUPS:
        return _error(f"There can be at most {MAX_GROUPS} production shifts (default and special together).")
    try:
        with transaction.atomic():
            group = _parse_special(data, None)
            saved = _write_special(group, None)
    except SettingsError as exc:
        return _error(str(exc))
    log_action(
        request, "create", "production_special_shift", record_id=saved.id,
        description=f"Created the special production shift {saved.label}",
        new_values=_plain_group(group_doc(saved, list(saved.rules.order_by("order", "id")))),
    )
    return Response(overview_body(request), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def production_special_shift_detail(request: Request, pk: int) -> Response:
    """PUT / DELETE /api/shifts/production/special/<id> (see the module docstring)."""
    if get_branch_scope(request) is not None:
        return _error(COMPANY_WIDE, 403, code="company_wide_settings")
    existing = _special_or_404(pk)
    if existing is None:
        return _error("That special shift does not exist (it may have been deleted).", 404)
    before = _plain_group(group_doc(existing, list(existing.rules.order_by("order", "id"))))

    if request.method == "DELETE":
        assignments = list(existing.special_assignments.select_related("employee"))
        today = ist_today()
        span = _worked_span(assignments, today)
        if assignments and not _forced(request):
            # the owner's choice (2026-11-16): it CAN be deleted, but only once HR has seen what it does
            workers = len({a.employee_id for a in assignments})
            return _error(
                f"{existing.label} has had {workers} worker{'s' if workers != 1 else ''} on it. Deleting it takes "
                "them off it as well"
                + (f", and their days from {_span_text(span)} are worked out again with the default shifts" if span else "")
                + ". Confirm to delete it.",
                409,
                code="special_in_use",
                workers=workers,
            )
        label = existing.label
        removed = [
            {
                "employee": f"{a.employee.first_name} {a.employee.last_name}".strip(),
                "employeeCode": a.employee.employee_code,
                "effectiveFrom": a.effective_from.isoformat(),
                "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
            }
            for a in assignments
        ]
        with transaction.atomic():
            existing.special_assignments.all().delete()
            existing.delete()
        log_action(
            request, "delete", "production_special_shift", record_id=pk,
            description=f"Deleted the special production shift {label}"
            + (f" and took {len(removed)} assignment(s) off it" if removed else ""),
            old_values={**before, "assignments": removed},
        )
        warnings = (
            [BACK_TO_DEFAULTS_NOTE.format(who="Its workers", verb="are", span=_span_text(span))] if span else []
        )
        return Response({**overview_body(request), "warnings": warnings})

    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        with transaction.atomic():
            group = _parse_special(data, existing)
            saved = _write_special(group, existing)
    except SettingsError as exc:
        return _error(str(exc))
    after = _plain_group(group_doc(saved, list(saved.rules.order_by("order", "id"))))
    warnings = []
    first = (
        ProductionSpecialShiftAssignment.objects.filter(group=saved).order_by("effective_from").first()
        if after != before
        else None
    )
    if first is not None and first.effective_from <= ist_today():
        warnings.append(PAST_DAYS_NOTE.format(day=first.effective_from.strftime("%d %b %Y")))
    if after != before:
        log_action(
            request, "update", "production_special_shift", record_id=saved.id,
            description=f"Changed the special production shift {saved.label}", old_values=before, new_values=after,
        )
    return Response({**overview_body(request), "warnings": warnings})


@api_view(["POST"])
@require_hr
def production_special_shift_assign(request: Request, pk: int) -> Response:
    """POST /api/shifts/production/special/<id>/assign: put production workers on a special shift from a date. A
    worker's own earlier assignment that is still running is ended the day before; one that starts on or after the new
    date is refused (change that one first), so a worker is never on two shifts on one day."""
    group = _special_or_404(pk)
    if group is None:
        return _error("That special shift does not exist (it may have been deleted).", 404)
    if not group.enabled:
        return _error(f"{group.label} is switched off: switch it on before putting anyone on it.")
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    ids = data.get("employeeIds")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        return _error("Choose at least one production employee.")
    try:
        start = _date(data.get("effectiveFrom"), "The start date")
        end = _date(data["effectiveTo"], "The last day") if data.get("effectiveTo") else None
    except SettingsError as exc:
        return _error(str(exc))
    if end is not None and end < start:
        return _error("The last day cannot be before the start date.")
    note = str(data.get("note") or "")[:500]

    workers = {
        e.id: e
        for e in scope_to_branch(Employee.objects, request).filter(
            id__in=ids, status="active", employment_type="production"
        )
    }
    missing = [i for i in ids if i not in workers]
    if missing:
        return _error(
            "Only active production employees can be put on a production special shift "
            f"({len(missing)} of the chosen {'is' if len(missing) == 1 else 'are'} not)."
        )
    clashes = []
    with transaction.atomic():
        current = list(
            ProductionSpecialShiftAssignment.objects.select_for_update()
            .filter(employee_id__in=list(workers))
            .select_related("group")
        )
        for a in current:
            if end is not None and a.effective_from > end:
                continue  # wholly after the new one
            if a.effective_to is not None and a.effective_to < start:
                continue  # wholly before
            if a.effective_from >= start:
                e = workers[a.employee_id]
                clashes.append(
                    f"{e.first_name} {e.last_name} ({e.employee_code}) is on {a.group.label} from "
                    f"{a.effective_from.strftime('%d %b %Y')}"
                )
        if clashes:
            transaction.set_rollback(True)
            return _error(
                "These workers already have a special shift starting on or after that date; change or remove it first: "
                + "; ".join(clashes)
                + ".",
                409,
                code="special_overlap",
            )
        by = actor_name(request)
        for a in current:
            if a.effective_from < start and (a.effective_to is None or a.effective_to >= start):
                a.effective_to = start - timedelta(days=1)
                a.save(update_fields=["effective_to", "updated_at"])
        created = [
            ProductionSpecialShiftAssignment.objects.create(
                employee_id=eid, group=group, effective_from=start, effective_to=end, note=note, created_by=by
            )
            for eid in workers
        ]
    log_action(
        request, "create", "production_special_shift", record_id=group.id,
        description=f"Put {len(created)} production worker(s) on {group.label} from {start.isoformat()}"
        + (f" to {end.isoformat()}" if end else ""),
        new_values={"employeeIds": sorted(workers), "effectiveFrom": start.isoformat(),
                    "effectiveTo": end.isoformat() if end else None},
    )
    warnings = [PAST_DAYS_NOTE.format(day=start.strftime("%d %b %Y"))] if start <= ist_today() else []
    return Response({**overview_body(request), "warnings": warnings, "assigned": len(created)}, status=201)


def _assignment_or_404(request: Request, pk: int):
    production = scope_to_branch(Employee.objects, request).filter(employment_type="production")
    return (
        ProductionSpecialShiftAssignment.objects.filter(pk=pk, employee__in=production)
        .select_related("employee", "group")
        .first()
    )


@api_view(["POST"])
@require_hr
def production_special_assignment_end(request: Request, pk: int) -> Response:
    """POST /api/shifts/production/special-assignments/<id>/end {lastDay?}: the worker is on the special shift up to
    and including lastDay (today when not sent); the defaults from the day after."""
    a = _assignment_or_404(request, pk)
    if a is None:
        return _error("That assignment does not exist (it may have been removed).", 404)
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        last = _date(data.get("lastDay") or ist_today().isoformat(), "The last day")
    except SettingsError as exc:
        return _error(str(exc))
    if last < a.effective_from:
        return _error(
            f"The last day cannot be before the start ({a.effective_from.strftime('%d %b %Y')}). "
            "To take back an assignment that has not started, remove it instead."
        )
    if a.effective_to is not None and last > a.effective_to:
        return _error(f"It already ends on {a.effective_to.strftime('%d %b %Y')}.")
    old = a.effective_to
    a.effective_to = last
    a.save(update_fields=["effective_to", "updated_at"])
    name = f"{a.employee.first_name} {a.employee.last_name}".strip()
    log_action(
        request, "update", "production_special_shift", record_id=a.group_id,
        description=f"Ended {name} on {a.group.label} on {last.isoformat()}",
        old_values={"effectiveTo": old.isoformat() if old else None}, new_values={"effectiveTo": last.isoformat()},
    )
    warnings = [PAST_DAYS_NOTE.format(day=(last + timedelta(days=1)).strftime("%d %b %Y"))] if last < ist_today() else []
    return Response({**overview_body(request), "warnings": warnings})


@api_view(["DELETE"])
@require_hr
def production_special_assignment_detail(request: Request, pk: int) -> Response:
    """DELETE /api/shifts/production/special-assignments/<id>[?force=1]: take a worker off a special shift altogether.
    One that has not started goes at once; one that has started needs force=1 (the owner's choice, 2026-11-16): every
    day it covered is then worked out again with the default shifts. To keep the days already worked on the special
    shift, end it instead."""
    a = _assignment_or_404(request, pk)
    if a is None:
        return _error("That assignment does not exist (it may have been removed).", 404)
    today = ist_today()
    span = _worked_span([a], today)
    name = f"{a.employee.first_name} {a.employee.last_name}".strip()
    if span and not _forced(request):
        return _error(
            f"{name} has worked on {a.group.label} since {a.effective_from.strftime('%d %b %Y')}. Removing them puts "
            f"their days from {_span_text(span)} back on the default shifts. Confirm to remove, or end it instead to "
            "keep those days on the special shift.",
            409,
            code="assignment_started",
        )
    label, group_id = a.group.label, a.group_id
    old = {
        "employeeCode": a.employee.employee_code,
        "effectiveFrom": a.effective_from.isoformat(),
        "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
    }
    a.delete()
    log_action(
        request, "delete", "production_special_shift", record_id=group_id,
        description=f"Took {name} off {label}" + (" (days already worked go back to the defaults)" if span else ""),
        old_values=old,
    )
    warnings = [BACK_TO_DEFAULTS_NOTE.format(who=name, verb="is", span=_span_text(span))] if span else []
    return Response({**overview_body(request), "warnings": warnings})
