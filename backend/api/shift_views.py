from datetime import date, time as time_type
from typing import Optional

from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import shift_planner
from .auth import require_hr, require_auth, get_token_employee_id, is_hr, get_hr_display_name
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .models import ShiftTemplate, EmployeeShiftAssignment, Employee


def auto_assign_production_shift(emp: Employee, effective_from: Optional[date] = None) -> bool:
    """
    Assign the production shift to a production employee if they don't already
    have an active shift assignment.  Returns True if a new assignment was created.
    Production shifts are gender-agnostic -every production employee uses the
    same shift configuration regardless of gender.
    """
    if emp.employment_type != "production" or emp.status != "active":
        return False
    if EmployeeShiftAssignment.objects.filter(employee=emp, effective_to__isnull=True).exists():
        return False

    # Now that templates carry a branch, pick from the employee's OWN branch
    # first -otherwise a new Unit1 joiner could silently inherit Head
    # Office's timings, and their attendance would be graded against the
    # wrong shift. Unbranched templates are the fallback so employees added
    # before any per-branch shift exists still get one.
    base = ShiftTemplate.objects.filter(shift_type="production", is_active=True)
    shift = (
        base.filter(branch_id=emp.branch_id).order_by("-is_default", "id").first()
        if emp.branch_id else None
    )
    if shift is None:
        shift = base.filter(branch__isnull=True).order_by("-is_default", "id").first()
    if not shift:
        return False

    EmployeeShiftAssignment.objects.create(
        employee=emp,
        shift=shift,
        effective_from=effective_from or ist_today(),
        assigned_by="System (Auto)",
        notes="Auto-assigned production shift",
    )
    return True


def shift_json(shift):
    return {
        "id": shift.id,
        "name": shift.name,
        "shiftType": shift.shift_type,
        "startTime": shift.start_time.strftime("%H:%M") if shift.start_time else None,
        "endTime": shift.end_time.strftime("%H:%M") if shift.end_time else None,
        "genderRule": shift.gender_rule,
        "gracePeriodMinutes": shift.grace_period_minutes,
        # Staff 4-punch fields
        "firstHalfEnd": shift.first_half_end.strftime("%H:%M") if shift.first_half_end else None,
        "lunchDurationMinutes": shift.lunch_duration_minutes,
        "lunchGraceMinutes": shift.lunch_grace_minutes,
        "departmentId": shift.department_id,
        "departmentName": shift.department.name if shift.department else None,
        "isDefault": shift.is_default,
        "isActive": shift.is_active,
        "branchId": shift.branch_id,
        # active employees on it right now (the list annotates it; elsewhere it is counted on demand)
        "assignedCount": shift.assigned_count if hasattr(shift, "assigned_count") else _assigned_count(shift),
        "createdAt": shift.created_at.isoformat() if shift.created_at else None,
    }


def _assigned_count(shift) -> int:
    return shift.assignments.filter(effective_to__isnull=True, employee__status="active").count()


# ── Shift template validation ────────────────────────────────────────────────

SHIFT_TYPES = ("staff", "production")
GENDER_RULES = ("all", "male", "female")
MIN_SHIFT_MINUTES = 60


def _minutes(t: time_type) -> int:
    return t.hour * 60 + t.minute


def _int_in(raw, lo: int, hi: int, label: str, errors: dict, key: str, default=None):
    if raw in (None, ""):
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        errors[key] = f"{label} must be a whole number"
        return default
    if not lo <= n <= hi:
        errors[key] = f"{label} must be between {lo} and {hi}"
    return n


def _time_of(raw, label: str, errors: dict, key: str):
    if raw in (None, ""):
        return None
    if isinstance(raw, time_type):
        return raw
    try:
        return time_type.fromisoformat(str(raw))
    except ValueError:
        errors[key] = f"{label} must be a time like 09:30"
        return None


def validate_template(request, data, instance=None):
    """(values, field_errors) for creating a shift template or editing ``instance``.

    ``values`` holds model attribute names, merged over the instance's current ones so a partial PUT is validated as the
    whole template it will become. Everything the attendance engine and the Report Center treat as a data problem is
    refused here instead: overnight shifts, a lunch break outside the shift, a duplicate name, a shift type that
    would contradict the people already on it."""
    errors: dict[str, str] = {}
    cur = instance
    v: dict = {
        "name": cur.name if cur else None,
        "shift_type": cur.shift_type if cur else None,
        "start_time": cur.start_time if cur else None,
        "end_time": cur.end_time if cur else None,
        "gender_rule": cur.gender_rule if cur else "all",
        "grace_period_minutes": cur.grace_period_minutes if cur else 15,
        "first_half_end": cur.first_half_end if cur else None,
        "lunch_duration_minutes": cur.lunch_duration_minutes if cur else 60,
        "lunch_grace_minutes": cur.lunch_grace_minutes if cur else 10,
        "department_id": cur.department_id if cur else None,
        "is_default": cur.is_default if cur else False,
        "is_active": cur.is_active if cur else True,
    }
    if "name" in data:
        v["name"] = str(data["name"] or "").strip()
    if "shiftType" in data:
        v["shift_type"] = data["shiftType"]
    if "startTime" in data:
        v["start_time"] = _time_of(data["startTime"], "Start time", errors, "startTime")
    if "endTime" in data:
        v["end_time"] = _time_of(data["endTime"], "End time", errors, "endTime")
    if "genderRule" in data:
        v["gender_rule"] = data["genderRule"] or "all"
    if "gracePeriodMinutes" in data:
        v["grace_period_minutes"] = _int_in(data["gracePeriodMinutes"], 0, 60, "Grace period", errors, "gracePeriodMinutes", 15)
    if "firstHalfEnd" in data:
        v["first_half_end"] = _time_of(data["firstHalfEnd"], "First half end", errors, "firstHalfEnd")
    if "lunchDurationMinutes" in data:
        v["lunch_duration_minutes"] = _int_in(data["lunchDurationMinutes"], 15, 120, "Lunch duration", errors, "lunchDurationMinutes", 60)
    if "lunchGraceMinutes" in data:
        v["lunch_grace_minutes"] = _int_in(data["lunchGraceMinutes"], 0, 30, "Lunch grace", errors, "lunchGraceMinutes", 10)
    if "departmentId" in data:
        v["department_id"] = data["departmentId"] or None
    if "isDefault" in data:
        v["is_default"] = bool(data["isDefault"])
    if "isActive" in data:
        v["is_active"] = bool(data["isActive"])

    # name
    if not v["name"]:
        errors["name"] = "Shift name is required"
    elif len(v["name"]) > 80:
        errors["name"] = "Shift name can be at most 80 characters"
    # type and gender
    if v["shift_type"] not in SHIFT_TYPES:
        errors["shiftType"] = "Shift type must be staff or production"
    if v["gender_rule"] not in GENDER_RULES:
        errors["genderRule"] = "Gender rule must be all, male or female"
    elif v["shift_type"] == "production" and v["gender_rule"] != "all":
        errors["genderRule"] = "Production shifts apply to every gender"
    # times
    st, en = v["start_time"], v["end_time"]
    if st is None and "startTime" not in errors:
        errors["startTime"] = "Start time is required"
    if en is None and "endTime" not in errors:
        errors["endTime"] = "End time is required"
    if st is not None and en is not None:
        if _minutes(en) <= _minutes(st):
            errors["endTime"] = "A shift cannot end before it starts. Overnight shifts are not supported"
        elif _minutes(en) - _minutes(st) < MIN_SHIFT_MINUTES:
            errors["endTime"] = f"A shift must be at least {MIN_SHIFT_MINUTES // 60} hour long"
    # the staff lunch structure
    if v["shift_type"] == "staff":
        fh = v["first_half_end"]
        if fh is not None and st is not None and en is not None and not (_minutes(st) < _minutes(fh) < _minutes(en)):
            errors["firstHalfEnd"] = "The first half must end between the start and the end of the shift"
    else:
        v["first_half_end"] = None
    # a name is unique per branch and type
    if v["name"] and "name" not in errors and v["shift_type"] in SHIFT_TYPES:
        branch_id = cur.branch_id if cur else get_branch_scope(request)
        clash = ShiftTemplate.objects.filter(branch_id=branch_id, shift_type=v["shift_type"], name__iexact=v["name"])
        if cur:
            clash = clash.exclude(pk=cur.pk)
        if clash.exists():
            errors["name"] = f"A {v['shift_type']} shift called '{v['name']}' already exists"

    # an edit must not contradict the people already on the shift
    if cur is not None and not errors:
        if v["shift_type"] != cur.shift_type and cur.assignments.exists():
            errors["shiftType"] = "Employees have been assigned to this shift, so its type cannot change. Create a new shift instead"
        active = cur.assignments.filter(effective_to__isnull=True, employee__status="active")
        if v["gender_rule"] != cur.gender_rule and v["gender_rule"] != "all":
            wrong = active.exclude(employee__gender=v["gender_rule"]).count()
            if wrong:
                errors["genderRule"] = (
                    f"{wrong} employee{'s' if wrong != 1 else ''} on this shift {'are' if wrong != 1 else 'is'} not {v['gender_rule']}. "
                    "Move them to another shift first"
                )
        if cur.is_active and not v["is_active"]:
            n = active.count()
            if n:
                errors["isActive"] = f"{n} employee{'s are' if n != 1 else ' is'} on this shift. Move them to another shift before deactivating it"
    return v, errors


def _invalid(errors: dict) -> Response:
    return Response({"error": next(iter(errors.values())), "fieldErrors": errors}, status=400)


def assignment_json(a):
    emp = a.employee
    shift = a.shift
    return {
        "id": a.id,
        # employee details
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "employmentType": emp.employment_type,
        "gender": emp.gender,
        "departmentId": emp.department_id,
        "departmentName": emp.department.name if emp.department_id and emp.department else None,
        "designationId": emp.designation_id,
        "designationTitle": emp.designation.title if emp.designation_id and emp.designation else None,
        # shift details (embedded so the frontend can group without a second fetch)
        "shiftId": a.shift_id,
        "shiftName": shift.name if shift else None,
        "shiftType": shift.shift_type if shift else None,
        "startTime": shift.start_time.strftime("%H:%M") if shift and shift.start_time else None,
        "endTime": shift.end_time.strftime("%H:%M") if shift and shift.end_time else None,
        "genderRule": shift.gender_rule if shift else None,
        "gracePeriodMinutes": shift.grace_period_minutes if shift else None,
        # per-employee overrides (null = use shift template value)
        "customStartTime": a.custom_start_time.strftime("%H:%M") if a.custom_start_time else None,
        "customEndTime": a.custom_end_time.strftime("%H:%M") if a.custom_end_time else None,
        "saturdayOff": a.saturday_off,
        # effective times shown to HR (override takes precedence)
        "effectiveStartTime": (
            a.custom_start_time.strftime("%H:%M") if a.custom_start_time
            else (shift.start_time.strftime("%H:%M") if shift and shift.start_time else None)
        ),
        "effectiveEndTime": (
            a.custom_end_time.strftime("%H:%M") if a.custom_end_time
            else (shift.end_time.strftime("%H:%M") if shift and shift.end_time else None)
        ),
        # assignment meta
        "effectiveFrom": a.effective_from.isoformat() if a.effective_from else None,
        "effectiveTo": a.effective_to.isoformat() if a.effective_to else None,
        "assignedBy": a.assigned_by,
        "notes": a.notes,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


@api_view(["GET", "POST"])
@require_hr
def shift_templates(request: Request) -> Response:
    if request.method == "GET":
        shift_type = request.query_params.get("shiftType")
        dept_id = request.query_params.get("departmentId")
        # Shifts are per branch now. A branch admin manages only their
        # own; templates predating the branch column are admin-only.
        qs = scope_to_branch(
            ShiftTemplate.objects, request, field="branch_id"
        ).select_related("department").annotate(
            assigned_count=Count(
                "assignments",
                filter=Q(assignments__effective_to__isnull=True, assignments__employee__status="active"),
                distinct=True,
            )
        ).order_by("shift_type", "name")
        if shift_type:
            qs = qs.filter(shift_type=shift_type)
        if dept_id:
            qs = qs.filter(department_id=dept_id)
        return Response([shift_json(s) for s in qs])

    values, errors = validate_template(request, request.data)
    if errors:
        return _invalid(errors)

    # Stamped from the creator, so a branch admin's new shift is theirs and
    # an unscoped admin creates a template no branch owns until assigned.
    shift = ShiftTemplate.objects.create(branch_id=get_branch_scope(request), **values)
    # reload so TimeField strings are converted to datetime.time objects
    shift.refresh_from_db()
    return Response(shift_json(shift), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def shift_template_detail(request: Request, pk: int) -> Response:
    try:
        shift = scope_to_branch(
            ShiftTemplate.objects, request, field="branch_id"
        ).select_related("department").get(pk=pk)
    except ShiftTemplate.DoesNotExist:
        return Response({"error": "Shift not found"}, status=404)

    if request.method == "GET":
        return Response(shift_json(shift))

    if request.method == "PUT":
        values, errors = validate_template(request, request.data, instance=shift)
        if errors:
            return _invalid(errors)
        for attr, val in values.items():
            setattr(shift, attr, val)
        shift.save()
        shift.refresh_from_db()
        return Response(shift_json(shift))

    # Deleting a shift deletes every assignment on it, and with them the shift attendance and payroll used for the
    # days those employees worked. Refuse while any exist; the shift can be deactivated instead.
    total = shift.assignments.count()
    if total:
        active = _assigned_count(shift)
        return Response(
            {
                "error": (
                    f"'{shift.name}' is used by {active} employee{'s' if active != 1 else ''} now"
                    + (" and by past assignments" if total > active else "")
                    + ". Move them to another shift, then deactivate this one to keep the history."
                ),
                "code": "shift_in_use",
                "activeAssignments": active,
                "totalAssignments": total,
            },
            status=409,
        )
    shift.delete()
    return Response(status=204)


@api_view(["GET", "POST"])
@require_auth
def shift_assignments(request: Request) -> Response:
    if request.method == "GET":
        emp_id = request.query_params.get("employeeId")
        # Employees can only view their own shift assignment
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            emp_id = str(token_emp_id)
        shift_id = request.query_params.get("shiftId")
        active_only = request.query_params.get("activeOnly") in ("true", "1")
        emp_type = request.query_params.get("employmentType")
        qs = (
            EmployeeShiftAssignment.objects
            .select_related("employee__department", "employee__designation", "shift")
            .filter(employee__status="active")
            .order_by("shift__name", "employee__first_name")
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if shift_id:
            qs = qs.filter(shift_id=shift_id)
        if active_only:
            qs = qs.filter(effective_to__isnull=True)
        if emp_type:
            qs = qs.filter(employee__employment_type=emp_type)
        return Response([assignment_json(a) for a in qs])

    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)
    data = request.data
    required = ["employeeId", "shiftId", "effectiveFrom"]
    for f in required:
        if not data.get(f):
            return Response({"error": f"{f} is required"}, status=400)

    try:
        emp = scope_to_branch(Employee.objects, request).get(pk=data["employeeId"])
        shift = scope_to_branch(
            ShiftTemplate.objects, request, field="branch_id"
        ).get(pk=data["shiftId"])
    except (Employee.DoesNotExist, ShiftTemplate.DoesNotExist) as e:
        return Response({"error": str(e)}, status=404)

    from datetime import time as time_type

    def _parse_time(val):
        return time_type.fromisoformat(val) if val else None

    assignment = EmployeeShiftAssignment.objects.create(
        employee=emp,
        shift=shift,
        effective_from=data["effectiveFrom"],
        effective_to=data.get("effectiveTo"),
        assigned_by=data.get("assignedBy", "HR"),
        notes=data.get("notes"),
        custom_start_time=_parse_time(data.get("customStartTime")),
        custom_end_time=_parse_time(data.get("customEndTime")),
        saturday_off=bool(data.get("saturdayOff", False)),
    )
    return Response(assignment_json(assignment), status=201)


@api_view(["POST"])
@require_hr
def bulk_shift_assignments(request: Request) -> Response:
    """
    Assign a shift to multiple employees in one call.
    Body: { shiftId, effectiveFrom, employeeIds?[], departmentId?, designationId?,
            employmentType?, genderRule?, notes? }
    - For production auto-assign by gender: pass employmentType="production" + genderRule
    - For staff dept-wide: pass departmentId + employmentType="staff"
    - For staff desig-wide: pass designationId + employmentType="staff"
    - For individual: pass employeeIds=[...]
    Existing open assignment for each employee is ended before creating the new one.
    """
    data = request.data
    shift_id = data.get("shiftId")
    effective_from = data.get("effectiveFrom")

    if not shift_id or not effective_from:
        return Response({"error": "shiftId and effectiveFrom are required"}, status=400)

    try:
        shift = scope_to_branch(
            ShiftTemplate.objects, request, field="branch_id"
        ).get(pk=shift_id)
    except ShiftTemplate.DoesNotExist:
        return Response({"error": "Shift not found"}, status=404)

    qs = scope_to_branch(Employee.objects, request).filter(status="active")

    employee_ids = data.get("employeeIds")
    dept_id = data.get("departmentId")
    desig_id = data.get("designationId")
    employment_type = data.get("employmentType")
    gender_rule = data.get("genderRule")

    if employee_ids:
        qs = qs.filter(pk__in=employee_ids)
    elif dept_id:
        qs = qs.filter(department_id=dept_id)
    elif desig_id:
        qs = qs.filter(designation_id=desig_id)

    if employment_type:
        qs = qs.filter(employment_type=employment_type)

    # Enforce gender rule: use the caller's override first, then fall back to
    # the shift template's own gender_rule so assignments never cross genders.
    effective_gender_rule = gender_rule if (gender_rule and gender_rule != "all") else shift.gender_rule
    if effective_gender_rule and effective_gender_rule != "all":
        qs = qs.filter(gender=effective_gender_rule)

    from datetime import time as time_type

    def _parse_time(val):
        return time_type.fromisoformat(val) if val else None

    custom_start = _parse_time(data.get("customStartTime"))
    custom_end = _parse_time(data.get("customEndTime"))
    saturday_off = bool(data.get("saturdayOff", False))

    created_count = 0
    for emp in qs:
        EmployeeShiftAssignment.objects.filter(
            employee=emp, effective_to__isnull=True
        ).update(effective_to=effective_from)
        EmployeeShiftAssignment.objects.create(
            employee=emp,
            shift=shift,
            effective_from=effective_from,
            assigned_by=data.get("assignedBy", "HR"),
            notes=data.get("notes"),
            custom_start_time=custom_start,
            custom_end_time=custom_end,
            saturday_off=saturday_off,
        )
        created_count += 1

    return Response({"assigned": created_count, "shiftName": shift.name}, status=201)


@api_view(["POST"])
@require_hr
def shift_assignment_plan(request: Request) -> Response:
    """Preview: what assigning a shift to a selection of employees / departments / designations would do, employee by
    employee, without writing anything. See shift_planner.py for the selection and conflict rules."""
    req = shift_planner.parse_request(request.data)
    return Response(shift_planner.plan(request, req).as_json())


@api_view(["POST"])
@require_hr
def shift_assignment_apply(request: Request) -> Response:
    """Do what ``shift_assignment_plan`` shows. The plan is made again inside a transaction, so it is the fresh plan
    (never the one the screen showed a minute ago) that is written; with any error nothing is."""
    req = shift_planner.parse_request(request.data)
    result = shift_planner.apply(request, req, get_hr_display_name(request))
    body = result.as_json()
    if not result.ok:
        return Response(body, status=400)
    applied = shift_planner.applied_counts(result)
    body["applied"] = applied
    return Response(body, status=201 if applied["assigned"] else 200)


@api_view(["POST"])
@require_hr
def end_shift_assignments(request: Request) -> Response:
    """Take employees off their shift: ``assignmentIds`` and ``lastDay`` (the last day they are on it, default today).
    Days before ``lastDay`` keep the shift, so past attendance and payroll are unchanged. An assignment that has not
    started yet is cancelled. Nothing is changed if any assignment cannot be ended."""
    data = request.data
    raw_ids = data.get("assignmentIds")
    if not isinstance(raw_ids, list) or not raw_ids:
        return Response({"error": "assignmentIds is required"}, status=400)
    try:
        ids = list(dict.fromkeys(int(i) for i in raw_ids))
    except (TypeError, ValueError):
        return Response({"error": "assignmentIds must be ids"}, status=400)
    today = ist_today()
    try:
        last_day = date.fromisoformat(str(data["lastDay"])[:10]) if data.get("lastDay") else today
    except ValueError:
        return Response({"error": "lastDay is not a valid date"}, status=400)

    with transaction.atomic():
        found = {
            a.id: a
            for a in scope_to_branch(EmployeeShiftAssignment.objects, request, field="employee__branch_id")
            .select_related("employee", "shift")
            .select_for_update(of=("self",))
            .filter(pk__in=ids)
        }
        problems = []
        for i in ids:
            a = found.get(i)
            name = f"{a.employee.first_name} {a.employee.last_name}".strip() if a else None
            if a is None:
                problems.append({"assignmentId": i, "message": "Assignment not found"})
            elif a.effective_from > last_day and a.effective_from <= today:
                problems.append({
                    "assignmentId": i,
                    "message": f"{name} has been on '{a.shift.name}' since {a.effective_from.isoformat()}; "
                               f"the last day cannot be before that",
                })
        if problems:
            return Response({"error": problems[0]["message"], "problems": problems}, status=400)
        ended = cancelled = unchanged = 0
        for a in found.values():
            if a.effective_from > last_day:  # not started yet: nothing to keep
                a.delete()
                cancelled += 1
            elif a.effective_to is not None and a.effective_to <= last_day:
                unchanged += 1
            else:
                a.effective_to = last_day
                a.save(update_fields=["effective_to"])
                ended += 1
    return Response({"ended": ended, "cancelled": cancelled, "unchanged": unchanged, "lastDay": last_day.isoformat()})


@api_view(["POST"])
@require_hr
def sync_production_shifts(request: Request) -> Response:
    """
    Silently assign the production shift to all unassigned active production employees.
    Uses today as effective_from -no date needed from the caller.
    """
    today = ist_today()
    employees = scope_to_branch(Employee.objects, request).filter(employment_type="production", status="active")
    synced = 0
    skipped = 0
    for emp in employees:
        if auto_assign_production_shift(emp, effective_from=today):
            synced += 1
        else:
            skipped += 1
    return Response({"synced": synced, "skipped": skipped})


@api_view(["PUT", "DELETE"])
@require_hr
def shift_assignment_detail(request: Request, pk: int) -> Response:
    try:
        assignment = scope_to_branch(
            EmployeeShiftAssignment.objects, request, field="employee__branch_id"
        ).select_related("employee__department", "employee__designation", "shift").get(pk=pk)
    except EmployeeShiftAssignment.DoesNotExist:
        return Response({"error": "Assignment not found"}, status=404)

    if request.method == "PUT":
        data = request.data
        errors: dict[str, str] = {}
        if "shiftId" in data and str(data["shiftId"]) != str(assignment.shift_id):
            new_shift = scope_to_branch(ShiftTemplate.objects, request, field="branch_id").filter(pk=data["shiftId"]).first()
            emp = assignment.employee
            if new_shift is None:
                errors["shiftId"] = "That shift was not found"
            elif not new_shift.is_active:
                errors["shiftId"] = "That shift is inactive"
            elif new_shift.shift_type != emp.employment_type:
                errors["shiftId"] = f"{new_shift.shift_type.title()} shifts are for {new_shift.shift_type} employees"
            elif new_shift.gender_rule != "all" and emp.gender != new_shift.gender_rule:
                errors["shiftId"] = f"That shift is {new_shift.gender_rule} only"
            else:
                assignment.shift = new_shift
        for field, attr in [("effectiveFrom", "effective_from"), ("effectiveTo", "effective_to")]:
            if field in data:
                raw = data[field]
                try:
                    setattr(assignment, attr, date.fromisoformat(str(raw)[:10]) if raw else None)
                except ValueError:
                    errors[field] = "Not a valid date"
        if "notes" in data:
            assignment.notes = (str(data["notes"]).strip()[:500] or None) if data["notes"] else None
        for field, attr, label in [
            ("customStartTime", "custom_start_time", "Custom start time"),
            ("customEndTime", "custom_end_time", "Custom end time"),
        ]:
            if field in data:
                setattr(assignment, attr, _time_of(data[field], label, errors, field))
        if "saturdayOff" in data:
            assignment.saturday_off = bool(data["saturdayOff"])
        if not errors:
            start = assignment.custom_start_time or assignment.shift.start_time
            end = assignment.custom_end_time or assignment.shift.end_time
            if (assignment.custom_start_time or assignment.custom_end_time) and end <= start:
                errors["customEndTime"] = "A shift cannot end before it starts. Overnight shifts are not supported"
            if assignment.saturday_off and assignment.shift.shift_type != "staff":
                errors["saturdayOff"] = "Saturday off applies to staff shifts only"
            if assignment.effective_to and assignment.effective_to < assignment.effective_from:
                errors["effectiveTo"] = "The last day cannot be before the start date"
        if errors:
            return _invalid(errors)
        assignment.save()
        return Response(assignment_json(assignment))

    assignment.delete()
    return Response(status=204)
