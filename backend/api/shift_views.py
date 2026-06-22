from datetime import date

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework import status

from .auth import require_hr
from .models import ShiftTemplate, EmployeeShiftAssignment, Employee, Department


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
    return {
        "id": a.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "shiftId": a.shift_id,
        "shiftName": a.shift.name if a.shift else None,
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
        return Response(shift_json(shift))

    shift.delete()
    return Response(status=204)


@api_view(["GET", "POST"])
@require_hr
def shift_assignments(request: Request) -> Response:
    if request.method == "GET":
        emp_id = request.query_params.get("employeeId")
        shift_id = request.query_params.get("shiftId")
        qs = EmployeeShiftAssignment.objects.select_related("employee", "shift").order_by("-effective_from")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if shift_id:
            qs = qs.filter(shift_id=shift_id)
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

    assignment = EmployeeShiftAssignment.objects.create(
        employee=emp,
        shift=shift,
        effective_from=data["effectiveFrom"],
        effective_to=data.get("effectiveTo"),
        assigned_by=data.get("assignedBy", "HR"),
        notes=data.get("notes"),
    )
    return Response(assignment_json(assignment), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def shift_assignment_detail(request: Request, pk: int) -> Response:
    try:
        assignment = EmployeeShiftAssignment.objects.select_related("employee", "shift").get(pk=pk)
    except EmployeeShiftAssignment.DoesNotExist:
        return Response({"error": "Assignment not found"}, status=404)

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("shiftId", "shift_id"), ("effectiveFrom", "effective_from"),
            ("effectiveTo", "effective_to"), ("notes", "notes"),
        ]:
            if field in data:
                setattr(assignment, attr, data[field])
        assignment.save()
        return Response(assignment_json(assignment))

    assignment.delete()
    return Response(status=204)
