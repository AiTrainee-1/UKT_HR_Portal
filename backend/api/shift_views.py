from datetime import date
from typing import Optional

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework import status

from .auth import require_hr
from .models import ShiftTemplate, EmployeeShiftAssignment, Employee, Department


def auto_assign_production_shift(emp: Employee, effective_from: Optional[date] = None) -> bool:
    """
    Assign the correct production shift to a production employee if they don't already
    have an active shift assignment.  Returns True if a new assignment was created.
    Matches gender-specific shifts first, then falls back to gender_rule="all".
    """
    if emp.employment_type != "production" or emp.status != "active":
        return False
    if EmployeeShiftAssignment.objects.filter(employee=emp, effective_to__isnull=True).exists():
        return False

    shift = None
    if emp.gender:
        shift = (
            ShiftTemplate.objects
            .filter(shift_type="production", is_active=True, gender_rule=emp.gender)
            .first()
        )
    if not shift:
        shift = (
            ShiftTemplate.objects
            .filter(shift_type="production", is_active=True, gender_rule="all")
            .first()
        )
    if not shift:
        return False

    EmployeeShiftAssignment.objects.create(
        employee=emp,
        shift=shift,
        effective_from=effective_from or date.today(),
        assigned_by="System (Auto)",
        notes="Auto-assigned based on employment type and gender rule",
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
        "departmentId": shift.department_id,
        "departmentName": shift.department.name if shift.department else None,
        "isDefault": shift.is_default,
        "isActive": shift.is_active,
        "createdAt": shift.created_at.isoformat() if shift.created_at else None,
    }


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
        qs = ShiftTemplate.objects.select_related("department").order_by("shift_type", "name")
        if shift_type:
            qs = qs.filter(shift_type=shift_type)
        if dept_id:
            qs = qs.filter(department_id=dept_id)
        return Response([shift_json(s) for s in qs])

    data = request.data
    required = ["name", "shiftType", "startTime", "endTime"]
    for field in required:
        if not data.get(field):
            return Response({"error": f"{field} is required"}, status=400)

    shift = ShiftTemplate.objects.create(
        name=data["name"],
        shift_type=data["shiftType"],
        start_time=data["startTime"],
        end_time=data["endTime"],
        gender_rule=data.get("genderRule", "all"),
        grace_period_minutes=int(data.get("gracePeriodMinutes", 15)),
        department_id=data.get("departmentId"),
        is_default=bool(data.get("isDefault", False)),
    )
    # reload so TimeField strings are converted to datetime.time objects
    shift.refresh_from_db()
    return Response(shift_json(shift), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def shift_template_detail(request: Request, pk: int) -> Response:
    try:
        shift = ShiftTemplate.objects.select_related("department").get(pk=pk)
    except ShiftTemplate.DoesNotExist:
        return Response({"error": "Shift not found"}, status=404)

    if request.method == "GET":
        return Response(shift_json(shift))

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("shiftType", "shift_type"), ("startTime", "start_time"),
            ("endTime", "end_time"), ("genderRule", "gender_rule"),
            ("gracePeriodMinutes", "grace_period_minutes"), ("departmentId", "department_id"),
            ("isDefault", "is_default"), ("isActive", "is_active"),
        ]:
            if field in data:
                setattr(shift, attr, data[field])
        shift.save()
        shift.refresh_from_db()
        return Response(shift_json(shift))

    shift.delete()
    return Response(status=204)


@api_view(["GET", "POST"])
@require_hr
def shift_assignments(request: Request) -> Response:
    if request.method == "GET":
        emp_id = request.query_params.get("employeeId")
        shift_id = request.query_params.get("shiftId")
        active_only = request.query_params.get("activeOnly") in ("true", "1")
        emp_type = request.query_params.get("employmentType")
        qs = (
            EmployeeShiftAssignment.objects
            .select_related("employee__department", "employee__designation", "shift")
            .order_by("shift__name", "employee__first_name")
        )
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if shift_id:
            qs = qs.filter(shift_id=shift_id)
        if active_only:
            qs = qs.filter(effective_to__isnull=True)
        if emp_type:
            qs = qs.filter(employee__employment_type=emp_type)
        return Response([assignment_json(a) for a in qs])

    data = request.data
    required = ["employeeId", "shiftId", "effectiveFrom"]
    for f in required:
        if not data.get(f):
            return Response({"error": f"{f} is required"}, status=400)

    try:
        emp = Employee.objects.get(pk=data["employeeId"])
        shift = ShiftTemplate.objects.get(pk=data["shiftId"])
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
        shift = ShiftTemplate.objects.get(pk=shift_id)
    except ShiftTemplate.DoesNotExist:
        return Response({"error": "Shift not found"}, status=404)

    qs = Employee.objects.filter(status="active")

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

    if gender_rule and gender_rule != "all":
        qs = qs.filter(gender=gender_rule)

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
def sync_production_shifts(request: Request) -> Response:
    """
    Silently assign production shifts to all unassigned active production employees.
    Uses today as effective_from — no date needed from the caller.
    Also handles employees whose gender-based shift has changed.
    """
    today = date.today()
    employees = Employee.objects.filter(employment_type="production", status="active")
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
        assignment = EmployeeShiftAssignment.objects.select_related("employee__department", "employee__designation", "shift").get(pk=pk)
    except EmployeeShiftAssignment.DoesNotExist:
        return Response({"error": "Assignment not found"}, status=404)

    if request.method == "PUT":
        from datetime import time as time_type
        data = request.data
        for field, attr in [
            ("shiftId", "shift_id"), ("effectiveFrom", "effective_from"),
            ("effectiveTo", "effective_to"), ("notes", "notes"),
        ]:
            if field in data:
                setattr(assignment, attr, data[field])
        if "customStartTime" in data:
            raw = data["customStartTime"]
            assignment.custom_start_time = time_type.fromisoformat(raw) if raw else None
        if "customEndTime" in data:
            raw = data["customEndTime"]
            assignment.custom_end_time = time_type.fromisoformat(raw) if raw else None
        if "saturdayOff" in data:
            assignment.saturday_off = bool(data["saturdayOff"])
        assignment.save()
        return Response(assignment_json(assignment))

    assignment.delete()
    return Response(status=204)
