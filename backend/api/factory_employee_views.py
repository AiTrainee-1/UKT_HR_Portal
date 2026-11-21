"""Employees -> Factory Employees (/hr/employees/factory-emp; owner 2026-11-20): drivers, housekeeping, chefs, security and
other factory support staff, managed on one page. Permission key `employees.factory` (API prefix employees/factory).

    GET    employees/factory                      the factory employees (filters), the labels and the counts
    POST   employees/factory                      create a NEW employee as a factory employee (the employee create rules)
    GET    employees/factory/candidates?search=   employees not in Factory Employees yet
    POST   employees/factory/add                  {employeeIds, labelId?}  mark existing employees as factory employees
    POST   employees/factory/remove               {employeeIds}            take them out (they stay normal employees)
    POST   employees/factory/label                {employeeIds, labelId}   assign a label (null = none)
    GET    employees/factory/labels               the labels
    POST   employees/factory/labels               {name, color?, description?}
    PATCH  employees/factory/labels/<id>          {name?, color?, description?, sortOrder?}
    DELETE employees/factory/labels/<id>[?unassign=1]
    GET    employees/factory/<id>/history         the employee's audit trail

A factory employee is an ordinary Employee (is_factory + factory_label, models/factory.py): attendance, Staff Payroll
(employment type staff) and Production Payroll (production, with a pay cycle) treat them like everyone else. Editing,
departments, designations, shifts and pay cycles go through their existing endpoints and permission keys. Everything is
branch-scoped.
"""

from __future__ import annotations

import re

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, TextField, Value
from django.db.models.functions import Concat
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import parse_join_date
from .models import AuditLog, Employee, EmployeeShiftAssignment, FactoryLabel, HRUser
from .unit_labels import unit_label

KEY = "employees.factory"
PALETTE = ["#2563eb", "#0d9488", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#475569"]
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
NAME_MAX = 40


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _actor(request):
    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    return HRUser.objects.filter(pk=user_id).first() if user_id else None


def _can_edit(request) -> bool:
    from .permission_registry import effective_permissions, resolve_permission

    hr = getattr(request, "hr_actor", None) or _actor(request)
    if hr is None:
        return False
    return bool(hr.is_super_admin) or resolve_permission(effective_permissions(hr), KEY) == "edit"


def _scope(request):
    return scope_to_branch(Employee.objects, request)


def _ids(raw) -> list[int] | None:
    if not isinstance(raw, (list, tuple)) or not raw:
        return None
    try:
        return list(dict.fromkeys(int(v) for v in raw))
    except (TypeError, ValueError):
        return None


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _label_json(label: FactoryLabel, count: int | None = None) -> dict:
    out = {
        "id": label.id,
        "name": label.name,
        "color": label.color,
        "description": label.description,
        "sortOrder": label.sort_order,
    }
    if count is not None:
        out["employees"] = count
    return out


def _current_shifts(employee_ids) -> dict[int, EmployeeShiftAssignment]:
    today = ist_today()
    rows = (
        EmployeeShiftAssignment.objects.select_related("shift")
        .filter(employee_id__in=list(employee_ids), effective_from__lte=today)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=today))
        .order_by("employee_id", "-effective_from", "-id")
    )
    out: dict[int, EmployeeShiftAssignment] = {}
    for a in rows:
        out.setdefault(a.employee_id, a)
    return out


def _hhmm(t) -> str | None:
    return t.strftime("%H:%M") if t else None


def payroll_issue(emp: Employee) -> str | None:
    """What keeps this employee out of their payroll (None = nothing)."""
    if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION:
        if not emp.salary_per_shift or emp.salary_per_shift <= 0:
            return "No salary per shift"
        if not emp.production_pay_cycle:
            return "No pay cycle (in no Production Payroll yet)"
        return None
    if not emp.salary_amount or emp.salary_amount <= 0:
        return "No monthly salary"
    return None


def row_json(emp: Employee, shift: EmployeeShiftAssignment | None) -> dict:
    joined = parse_join_date(emp.join_date)
    label = emp.factory_label if emp.factory_label_id else None
    issue = payroll_issue(emp)
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": _name(emp),
        "firstName": emp.first_name,
        "lastName": emp.last_name,
        "phone": emp.phone,
        "employmentType": emp.employment_type,
        "status": (emp.status or "active").lower(),
        "isFactory": bool(emp.is_factory),
        "labelId": emp.factory_label_id,
        "label": label.name if label else None,
        "labelColor": label.color if label else None,
        "departmentId": emp.department_id,
        "department": emp.department.name if emp.department_id and emp.department else "",
        "designationId": emp.designation_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else "",
        "branchId": emp.branch_id,
        "unit": (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else "",
        "joinDate": joined.isoformat() if joined else None,
        "salaryAmount": float(emp.salary_amount) if emp.salary_amount is not None else None,
        "salaryPerShift": float(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
        "productionPayCycle": emp.production_pay_cycle,
        "shift": (
            {
                "assignmentId": shift.id,
                "shiftId": shift.shift_id,
                "name": shift.shift.name,
                "startTime": _hhmm(shift.custom_start_time or shift.shift.start_time),
                "endTime": _hhmm(shift.custom_end_time or shift.shift.end_time),
                "effectiveFrom": shift.effective_from.isoformat() if shift.effective_from else None,
                "saturdayOff": bool(shift.saturday_off),
            }
            if shift
            else None
        ),
        "payrollReady": issue is None,
        "payrollIssue": issue,
    }


def _factory_qs(request):
    return (
        _scope(request)
        .filter(is_factory=True)
        .select_related("department", "designation", "branch", "factory_label")
        .defer("photo_url", "password_hash", "address")
    )


def _labels_with_counts(request) -> list[dict]:
    counts = dict(
        _scope(request)
        .filter(is_factory=True, factory_label__isnull=False)
        .values_list("factory_label_id")
        .annotate(n=Count("id"))
    )
    return [_label_json(label, counts.get(label.id, 0)) for label in FactoryLabel.objects.all()]


def _search(qs, text: str):
    text = (text or "").strip()
    if not text:
        return qs
    return qs.annotate(_full=Concat("first_name", Value(" "), "last_name", output_field=TextField())).filter(
        Q(employee_code__icontains=text) | Q(_full__icontains=text) | Q(phone__icontains=text)
    )


# ───────────────────────────── the list / create ─────────────────────────────


@api_view(["GET", "POST"])
@require_hr
def factory_employees(request: Request) -> Response:
    if request.method == "POST":
        return _create(request)
    params = request.query_params
    qs = _factory_qs(request)
    status = (params.get("status") or "all").lower()
    if status in ("active", "inactive"):
        qs = qs.filter(status=status)
    try:
        if params.get("departmentId"):
            qs = qs.filter(department_id=int(params["departmentId"]))
        if params.get("designationId"):
            qs = qs.filter(designation_id=int(params["designationId"]))
    except (TypeError, ValueError):
        return _error("Check the filters.")
    if params.get("employmentType") in (Employee.EMPLOYMENT_TYPE_STAFF, Employee.EMPLOYMENT_TYPE_PRODUCTION):
        qs = qs.filter(employment_type=params["employmentType"])
    qs = _search(qs, params.get("search", ""))
    all_rows = list(qs.order_by("employee_code"))
    counts = {
        "total": len(all_rows),
        "active": sum(1 for e in all_rows if (e.status or "").lower() == "active"),
        "inactive": sum(1 for e in all_rows if (e.status or "").lower() != "active"),
        "unlabeled": sum(1 for e in all_rows if e.factory_label_id is None),
        "byLabel": {},
    }
    for e in all_rows:
        if e.factory_label_id:
            counts["byLabel"][str(e.factory_label_id)] = counts["byLabel"].get(str(e.factory_label_id), 0) + 1
    label_filter = params.get("labelId")
    rows = all_rows
    if label_filter == "none":
        rows = [e for e in all_rows if e.factory_label_id is None]
    elif label_filter:
        try:
            wanted = int(label_filter)
        except ValueError:
            return _error("Check the filters.")
        rows = [e for e in all_rows if e.factory_label_id == wanted]
    shifts = _current_shifts(e.id for e in rows)
    return Response({
        "employees": [row_json(e, shifts.get(e.id)) for e in rows],
        "labels": _labels_with_counts(request),
        "counts": counts,
        "canEdit": _can_edit(request),
    })  # fmt: skip


def _label_or_none(raw) -> tuple[FactoryLabel | None, str | None]:
    if raw in (None, "", "none"):
        return None, None
    try:
        label = FactoryLabel.objects.filter(pk=int(raw)).first()
    except (TypeError, ValueError):
        label = None
    return (label, None) if label else (None, "That label no longer exists.")


def _create(request: Request) -> Response:
    from .employee_views import _create_employee_from_data

    data = request.data if isinstance(request.data, dict) else {}
    label, problem = _label_or_none(data.get("labelId"))
    if problem:
        return _error(problem)
    with transaction.atomic():
        emp, error, warnings = _create_employee_from_data(data, request)
        if error:
            return _error(error)
        Employee.objects.filter(pk=emp.pk).update(is_factory=True, factory_label=label)
        try:
            apply_label_org_many(request, [emp.pk])  # the label is their department and designation
        except ValueError as exc:
            transaction.set_rollback(True)
            return _error(str(exc))
    emp = _factory_qs(request).get(pk=emp.pk)
    log_action(
        request, "create", "employees", record_id=emp.id,
        description=f"Created factory employee {emp.employee_code} - {_name(emp)}"
        + (f" ({label.name})" if label else ""),
    )  # fmt: skip
    body = row_json(emp, _current_shifts([emp.id]).get(emp.id))
    if warnings:
        body["warnings"] = warnings
    return Response(body, status=201)


@api_view(["GET"])
@require_hr
def factory_candidates(request: Request) -> Response:
    qs = _scope(request).filter(is_factory=False).select_related("department", "designation")
    qs = _search(qs, request.query_params.get("search", ""))
    rows = list(qs.order_by("status", "employee_code")[:50])
    return Response({
        "employees": [
            {
                "id": e.id, "code": e.employee_code, "name": _name(e), "employmentType": e.employment_type,
                "department": e.department.name if e.department_id and e.department else "",
                "designation": e.designation.title if e.designation_id and e.designation else "",
                "status": (e.status or "active").lower(),
            }
            for e in rows
        ]
    })  # fmt: skip


def _update_many(request, action: str, **fields) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    ids = _ids(data.get("employeeIds"))
    if ids is None:
        return _error("Select at least one employee.")
    qs = _scope(request).filter(id__in=ids)
    if action != "add":
        qs = qs.filter(is_factory=True)
    emps = list(qs.only("id", "employee_code", "first_name", "last_name", "factory_label_id"))
    if not emps:
        return _error("None of these employees is in your list.")
    Employee.objects.filter(id__in=[e.id for e in emps]).update(**fields)
    label = fields.get("factory_label")
    for e in emps:
        what = {
            "add": "Added to Factory Employees" + (f" with the label {label.name}" if label else ""),
            "remove": "Removed from Factory Employees (still an employee)",
            "label": f"Factory label set to {label.name}" if label else "Factory label removed",
        }[action]
        log_action(
            request, "update", "employees", record_id=e.id, description=f"{what}: {e.employee_code} - {_name(e)}"
        )
    moved = []
    if label is not None:  # the label is their department and designation
        try:
            moved = apply_label_org_many(request, [e.id for e in emps])
        except ValueError as exc:
            return _error(str(exc))
    return Response({"updated": len(emps), "moved": moved})


@api_view(["POST"])
@require_hr
def factory_add(request: Request) -> Response:
    label, problem = _label_or_none((request.data or {}).get("labelId") if isinstance(request.data, dict) else None)
    if problem:
        return _error(problem)
    fields = {"is_factory": True}
    if label is not None:
        fields["factory_label"] = label
    return _update_many(request, "add", **fields)


@api_view(["POST"])
@require_hr
def factory_remove(request: Request) -> Response:
    return _update_many(request, "remove", is_factory=False, factory_label=None)


@api_view(["POST"])
@require_hr
def factory_assign_label(request: Request) -> Response:
    label, problem = _label_or_none((request.data or {}).get("labelId") if isinstance(request.data, dict) else None)
    if problem:
        return _error(problem)
    return _update_many(request, "label", factory_label=label)


# ───────────────────────────── labels ─────────────────────────────


def _clean_label(data: dict, label: FactoryLabel | None) -> tuple[dict, str | None]:
    out = {}
    if "name" in data or label is None:
        name = " ".join(str(data.get("name") or "").split())
        if not name:
            return {}, "Give the label a name."
        if len(name) > NAME_MAX:
            return {}, f"Keep the label name under {NAME_MAX} characters."
        clash = FactoryLabel.objects.filter(name__iexact=name)
        if label is not None:
            clash = clash.exclude(pk=label.pk)
        if clash.exists():
            return {}, f'A label called "{name}" already exists.'
        out["name"] = name
    if "color" in data:
        color = str(data.get("color") or "").strip()
        if not COLOR_RE.match(color):
            return {}, "Pick a colour."
        out["color"] = color.lower()
    if "description" in data:
        out["description"] = str(data.get("description") or "").strip()[:200]
    if "sortOrder" in data:
        try:
            out["sort_order"] = int(data["sortOrder"])
        except (TypeError, ValueError):
            return {}, "The order must be a number."
    return out, None


@api_view(["GET", "POST"])
@require_hr
def factory_labels(request: Request) -> Response:
    if request.method == "GET":
        return Response({"labels": _labels_with_counts(request)})
    data = request.data if isinstance(request.data, dict) else {}
    fields, problem = _clean_label(data, None)
    if problem:
        return _error(problem)
    if "color" not in fields:
        used = FactoryLabel.objects.count()
        fields["color"] = PALETTE[used % len(PALETTE)]
    if "sort_order" not in fields:
        fields["sort_order"] = (FactoryLabel.objects.order_by("-sort_order").values_list("sort_order", flat=True).first()
                                or 0) + 1  # fmt: skip
    try:
        label = FactoryLabel.objects.create(created_by_name=get_hr_display_name(request), **fields)
    except IntegrityError:
        return _error("A label with this name already exists.")
    log_action(request, "create", "employees", description=f"Factory label created: {label.name}")
    return Response(_label_json(label, 0), status=201)


@api_view(["PATCH", "DELETE"])
@require_hr
def factory_label_detail(request: Request, pk: int) -> Response:
    label = FactoryLabel.objects.filter(pk=pk).first()
    if label is None:
        return _error("Label not found.", 404)
    if request.method == "DELETE":
        carrying = Employee.objects.filter(factory_label=label)
        n = carrying.count()
        if n and request.query_params.get("unassign") not in ("1", "true"):
            return _error(f'{n} employee(s) still have the label "{label.name}".', 409, employees=n)
        name = label.name
        with transaction.atomic():
            carrying.update(factory_label=None)
            label.delete()
        log_action(
            request, "delete", "employees", description=f"Factory label deleted: {name} ({n} employee(s) cleared)"
        )
        return Response(status=204)
    data = request.data if isinstance(request.data, dict) else {}
    fields, problem = _clean_label(data, label)
    if problem:
        return _error(problem)
    old_name = label.name
    for k, v in fields.items():
        setattr(label, k, v)
    try:
        with transaction.atomic():
            label.save()
            if label.name != old_name:  # its department and designation follow the new name
                rename_label_org(request, label, old_name)
    except IntegrityError:
        return _error("A label with this name already exists.")
    except ValueError as exc:
        return _error(str(exc))
    count = Employee.objects.filter(factory_label=label, is_factory=True).count()
    return Response(_label_json(label, count))


# ───────────────────────────── history ─────────────────────────────


@api_view(["GET"])
@require_hr
def factory_history(request: Request, pk: int) -> Response:
    emp = _scope(request).filter(pk=pk).first()
    if emp is None:
        return _error("Employee not found.", 404)
    rows = AuditLog.objects.filter(record_id=emp.id, module__in=["employees", "factory_employees"]).order_by(
        "-created_at", "-id"
    )[:200]
    return Response({
        "items": [
            {
                "at": r.created_at.isoformat() if r.created_at else None,
                "by": r.user_name,
                "action": r.action,
                "module": r.module,
                "description": r.record_description or "",
            }
            for r in rows
        ]
    })  # fmt: skip


# ───────────────────────────── shifts (owner 2026-11-20: existing shifts only) ─────────────────────────────
# The page shows every existing shift and moves factory employees on and off them. Creating, editing and deleting a
# shift stays on Manage Shifts. The assignment itself is the Manage Shifts planner (shift_planner.py: shift type,
# gender, branch checks, moving people in place), limited to factory employees and checked with this page's key.


def _factory_ids(request, raw) -> list[int] | None:
    ids = _ids(raw)
    if ids is None:
        return None
    return list(_scope(request).filter(is_factory=True, id__in=ids).values_list("id", flat=True))


@api_view(["GET"])
@require_hr
def factory_shifts(request: Request) -> Response:
    from .models import ShiftTemplate

    people = list(_factory_qs(request).filter(status="active").order_by("employee_code"))
    current = _current_shifts(e.id for e in people)
    by_shift: dict[int, list] = {}
    no_shift = []
    for e in people:
        a = current.get(e.id)
        entry = {"id": e.id, "code": e.employee_code, "name": _name(e), "employmentType": e.employment_type}
        if a is None:
            no_shift.append(entry)
        else:
            by_shift.setdefault(a.shift_id, []).append(
                {
                    **entry,
                    "assignmentId": a.id,
                    "effectiveFrom": a.effective_from.isoformat() if a.effective_from else None,
                    # set once the employee was taken off the shift: on it up to and including this day
                    "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
                }
            )
    from .branch_scope import get_branch_scope

    shifts = ShiftTemplate.objects.all()
    branch_id = get_branch_scope(request)
    if branch_id is not None:  # a unit login: the company-wide shifts and its own
        shifts = shifts.filter(Q(branch__isnull=True) | Q(branch_id=branch_id))
    out = []
    for s in shifts.order_by("shift_type", "start_time", "name"):
        if getattr(s, "is_active", True) is False:
            continue
        out.append({
            "id": s.id,
            "name": s.name,
            "shiftType": s.shift_type,
            "startTime": _hhmm(s.start_time),
            "endTime": _hhmm(s.end_time),
            "graceMinutes": s.grace_period_minutes,
            "genderRule": getattr(s, "gender_rule", "all"),
            "employees": by_shift.get(s.id, []),
        })  # fmt: skip
    return Response({"shifts": out, "noShift": no_shift, "canEdit": _can_edit(request)})


def _planner_body(request, data: dict) -> tuple[dict | None, str | None]:
    ids = _factory_ids(request, data.get("employeeIds"))
    if not ids:
        return None, "Select at least one factory employee."
    body = {
        "shiftId": data.get("shiftId"),
        "effectiveFrom": data.get("effectiveFrom") or ist_today().isoformat(),
        "selection": {"employees": {"include": ids}},
        "onConflict": "reassign",
        "saturdayOff": bool(data.get("saturdayOff", False)),
    }
    return body, None


@api_view(["POST"])
@require_hr
def factory_shift_plan(request: Request) -> Response:
    """What assigning the shift would do, employee by employee (nothing is written). Read-only: a view role may call it."""
    from . import shift_planner

    body, problem = _planner_body(request, request.data if isinstance(request.data, dict) else {})
    if problem:
        return _error(problem)
    return Response(shift_planner.plan(request, shift_planner.parse_request(body)).as_json())


@api_view(["POST"])
@require_hr
def factory_shift_apply(request: Request) -> Response:
    from . import shift_planner

    body, problem = _planner_body(request, request.data if isinstance(request.data, dict) else {})
    if problem:
        return _error(problem)
    result = shift_planner.apply(request, shift_planner.parse_request(body), get_hr_display_name(request))
    out = result.as_json()
    if not result.ok:
        return Response(out, status=400)
    out["applied"] = shift_planner.applied_counts(result)
    return Response(out, status=201 if out["applied"]["assigned"] else 200)


@api_view(["POST"])
@require_hr
def factory_shift_remove(request: Request) -> Response:
    """Take factory employees off their current shift: the last day on it is `lastDay` (default today), so past
    attendance and payroll keep it; a shift that has not started yet is cancelled (as Manage Shifts does)."""
    from datetime import date

    data = request.data if isinstance(request.data, dict) else {}
    ids = _factory_ids(request, data.get("employeeIds"))
    if not ids:
        return _error("Select at least one factory employee.")
    today = ist_today()
    try:
        last_day = date.fromisoformat(str(data["lastDay"])[:10]) if data.get("lastDay") else today
    except ValueError:
        return _error("The last day is not a valid date.")
    current = _current_shifts(ids)
    upcoming = EmployeeShiftAssignment.objects.filter(employee_id__in=ids, effective_from__gt=today)
    ended = cancelled = 0
    with transaction.atomic():
        for emp_id, a in current.items():
            if a.effective_from and a.effective_from > last_day:
                return _error(f"The last day cannot be before {a.effective_from:%d %b %Y}, when the shift started.")
            EmployeeShiftAssignment.objects.filter(pk=a.pk).update(effective_to=last_day)
            ended += 1
        cancelled = upcoming.count()
        upcoming.delete()
    for emp_id in ids:
        log_action(
            request,
            "update",
            "employees",
            record_id=emp_id,
            description=f"Taken off the shift (last day {last_day:%d %b %Y})",
        )
    return Response({"ended": ended, "cancelled": cancelled})


# ───────────────────────────── payroll category (owner 2026-11-20) ─────────────────────────────
# Staff Payroll = monthly. Production Payroll = Weekly, BiWeekly or Monthly (the employee's production pay cycle): the
# cycle page of that frequency generates their payroll. A move between cycles follows the Production Employees rules
# (production_transfers.py): a worker who already has payroll moves only with a confirmation and a reason, and every
# move is recorded.


def _money(raw, label: str):
    from decimal import Decimal, InvalidOperation

    if raw in (None, ""):
        return None, None
    try:
        value = Decimal(str(raw)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return None, f"{label} must be an amount in rupees."
    if value <= 0:
        return None, f"{label} must be more than zero."
    return value, None


@api_view(["POST"])
@require_hr
def factory_payroll(request: Request) -> Response:
    """POST employees/factory/payroll {employeeIds, category: staff|production, payCycle (production: weekly | biweekly |
    monthly), salaryAmount? + salaryBreakup? (staff), salaryPerShift? (production), confirm?, reason?}"""
    from . import org_category, salary_split
    from .branch_scope import get_branch_scope
    from .production_cycles import CYCLE_LABELS, CYCLES
    from .production_employee_views import CONFIRM_NEEDED
    from .production_transfers import clean_reason, facts_for, record_moves
    from .shift_views import auto_assign_production_shift
    from .user_settings import settings_for

    data = request.data if isinstance(request.data, dict) else {}
    ids = _factory_ids(request, data.get("employeeIds"))
    if not ids:
        return _error("Select at least one factory employee.")
    category = str(data.get("category") or "").strip().lower()
    if category not in (Employee.EMPLOYMENT_TYPE_STAFF, Employee.EMPLOYMENT_TYPE_PRODUCTION):
        return _error("Choose Staff Payroll or Production Payroll.")
    production = category == Employee.EMPLOYMENT_TYPE_PRODUCTION
    cycle = str(data.get("payCycle") or "").strip().lower() or None
    if production and cycle not in CYCLES:
        return _error("Choose the Production Payroll frequency: Weekly, BiWeekly or Monthly.")
    if not production:
        cycle = None
    salary, problem = _money(data.get("salaryAmount"), "The monthly salary")
    rate, problem2 = _money(data.get("salaryPerShift"), "The salary per shift")
    if problem or problem2:
        return _error(problem or problem2)

    emps = list(Employee.objects.filter(pk__in=ids).select_related("department", "designation"))
    refused = []
    ok = []
    for e in emps:
        if production and not (rate or (e.salary_per_shift and e.salary_per_shift > 0)):
            refused.append({"employeeId": e.id, "code": e.employee_code, "name": _name(e),
                            "reason": "Enter the salary per shift."})  # fmt: skip
        elif not production and not (salary or (e.salary_amount and e.salary_amount > 0)):
            refused.append({"employeeId": e.id, "code": e.employee_code, "name": _name(e),
                            "reason": "Enter the monthly salary."})  # fmt: skip
        else:
            ok.append(e)
    if not ok:
        return _error(refused[0]["reason"], refused=refused)

    # the production pay cycle move (to the chosen cycle, or off any cycle for staff) - the Production Employees rules
    moving = [e for e in ok if e.production_pay_cycle != cycle]
    facts = facts_for(moving, cycle, settings_for(request), get_branch_scope(request)) if moving else {}
    needing = [f for f in facts.values() if f.needs_confirmation]
    reason = clean_reason(data.get("reason"))
    if needing and not (data.get("confirm") is True and reason):
        return Response(
            {
                "error": f"{CONFIRM_NEEDED} (missing: {'a reason' if data.get('confirm') is True else 'a confirmation and a reason'})",
                "code": "confirm_cycle_change",
                "needsReason": True,
                "employees": [f.json() for f in needing],
            },
            status=409,
        )  # fmt: skip

    cleared = []
    actor = get_hr_display_name(request)
    with transaction.atomic():
        for e in ok:
            before = (e.employment_type, e.production_pay_cycle)
            e.employment_type = category
            if production:
                if rate:
                    e.salary_per_shift = rate
            elif salary or data.get("salaryBreakup") is not None:
                stored = salary_split.breakup_of(e)
                changed = salary is not None and (e.salary_amount is None or salary != e.salary_amount)
                if salary is not None:
                    e.salary_amount = salary
                parts, split_error = salary_split.resolve(
                    e.salary_amount, data.get("salaryBreakup"), stored, total_changed=changed
                )
                if split_error:
                    transaction.set_rollback(True)
                    return _error(f"{e.employee_code}: {split_error}")
                salary_split.apply_to_employee(e, parts)
            # a department / designation of the other kind cannot stay (org_category.py); this page does not manage them
            if e.department_id and org_category.department_mismatch(e.department, category):
                cleared.append({"employeeId": e.id, "code": e.employee_code, "what": f"department {e.department.name}"})
                e.department = None
            if e.designation_id and org_category.designation_mismatch(e.designation, category):
                cleared.append(
                    {"employeeId": e.id, "code": e.employee_code, "what": f"designation {e.designation.title}"}
                )
                e.designation = None
            e.save()
            if production and before[0] != category:
                auto_assign_production_shift(Employee.objects.get(pk=e.pk))
            what = "Staff Payroll (monthly)" if not production else f"Production Payroll ({CYCLE_LABELS[cycle]})"
            log_action(request, "update", "employees", record_id=e.id,
                       description=f"Payroll set to {what}: {e.employee_code} - {_name(e)}")  # fmt: skip
        if moving:
            Employee.objects.filter(id__in=[e.id for e in moving]).update(production_pay_cycle=cycle)
            record_moves([facts[e.id] for e in moving], actor, reason)
    try:  # a labelled employee goes to the label's department and designation of the new kind
        moved = apply_label_org_many(request, [e.id for e in ok])
    except ValueError as exc:
        return _error(str(exc))
    rows = _factory_qs(request).filter(pk__in=[e.id for e in ok])
    shifts = _current_shifts(e.id for e in ok)
    return Response({
        "updated": [row_json(e, shifts.get(e.id)) for e in rows],
        "refused": refused,
        "cleared": cleared,
        "moved": moved,
    })  # fmt: skip


# ───────────────────────────── the label is the department and designation (owner 2026-11-20) ─────────────────────────────
# A factory employee's label IS their department and designation: setting the label "Driver" moves them to the
# department "DRIVER" and the designation "DRIVER" of their kind (staff / production) and branch, created when there is
# none (org_lookup.OrgLookup, the same find-or-create the employee forms use by name). So every screen, report, salary
# statement, payslip, ID card and the mobile app shows the label. Their Department Head follows the new department.
# Taking the label away keeps the department and designation they have.


def label_org_name(label: FactoryLabel) -> str:
    return " ".join(label.name.split()).upper()


def apply_label_org(emp: Employee, label: FactoryLabel | None, org=None) -> str | None:
    """Put a labelled factory employee in the label's department and designation. Returns a short note of what moved
    ("department ADMIN -> DRIVER, designation MIS -> DRIVER"), None when nothing changed, or raises ValueError with
    the lookup's own problem."""
    from . import org_category
    from .org_lookup import OrgLookup

    if label is None or not emp.is_factory:
        return None
    org = org or OrgLookup()
    kind = org_category.category_of_type(emp.employment_type)
    name = label_org_name(label)
    dept = org.department(name, emp.branch_id, category=kind)
    if dept.problem or dept.obj is None:
        raise ValueError(dept.problem or f"The department {name} could not be made.")
    desig = org.designation(name, dept.obj, category=kind)
    if desig.problem or desig.obj is None:
        raise ValueError(desig.problem or f"The designation {name} could not be made.")
    if emp.department_id == dept.obj.id and emp.designation_id == desig.obj.id:
        return None
    old_dept = emp.department.name if emp.department_id and emp.department else "none"
    old_desig = emp.designation.title if emp.designation_id and emp.designation else "none"
    Employee.objects.filter(pk=emp.pk).update(department=dept.obj, designation=desig.obj)
    emp.department, emp.designation = dept.obj, desig.obj
    return f"department {old_dept} -> {dept.obj.name}, designation {old_desig} -> {desig.obj.title}"


def apply_label_org_many(request, employee_ids) -> list[dict]:
    """apply_label_org for every labelled factory employee of `employee_ids`; each move is in the employee's history."""
    from .org_lookup import OrgLookup

    org = OrgLookup()
    moved = []
    emps = (
        Employee.objects.filter(pk__in=list(employee_ids), is_factory=True, factory_label__isnull=False)
        .select_related("department", "designation", "factory_label")
        .defer("photo_url", "password_hash", "address")
    )
    for e in emps:
        note = apply_label_org(e, e.factory_label, org)
        if note:
            moved.append({"employeeId": e.id, "code": e.employee_code, "what": note})
            log_action(
                request, "update", "employees", record_id=e.id,
                description=f"Label {e.factory_label.name} applied: {note} ({e.employee_code} - {_name(e)})",
            )  # fmt: skip
    return moved


def rename_label_org(request, label: FactoryLabel, old_name: str) -> None:
    """After a label is renamed: a department / designation of the old name that only the label's factory employees use
    is renamed with it (when the new name is free in its branch and kind); everyone carrying the label is then put in
    the label's department and designation (apply_label_org), so nobody stays behind under the old name."""
    from .models import Department, Designation

    old, new = old_name.upper(), label_org_name(label)
    carriers = Employee.objects.filter(factory_label=label, is_factory=True)
    if old != new:
        for dept in Department.objects.filter(name__iexact=old):
            members = Employee.objects.filter(department=dept)
            if not members.exists() or members.exclude(pk__in=carriers.values("pk")).exists():
                continue
            if Department.objects.filter(name__iexact=new, branch_id=dept.branch_id, category=dept.category).exists():
                continue
            Department.objects.filter(pk=dept.pk).update(name=new)
            for desig in Designation.objects.filter(department=dept, title__iexact=old):
                holders = Employee.objects.filter(designation=desig)
                if holders.exclude(pk__in=carriers.values("pk")).exists():
                    continue
                if not Designation.objects.filter(department=dept, title__iexact=new).exists():
                    Designation.objects.filter(pk=desig.pk).update(title=new)
    apply_label_org_many(request, carriers.values_list("pk", flat=True))
