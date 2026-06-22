from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import LeaveType, LeaveBalance, Holiday, LeaveRequest, Employee


def leave_type_json(lt):
    return {
        "id": lt.id,
        "name": lt.name,
        "code": lt.code,
        "maxDaysPerYear": lt.max_days_per_year,
        "carryForward": lt.carry_forward,
        "maxCarryForwardDays": lt.max_carry_forward_days,
        "isPaid": lt.is_paid,
        "applicableGender": lt.applicable_gender,
        "isActive": lt.is_active,
    }


def leave_balance_json(lb):
    return {
        "id": lb.id,
        "employeeId": lb.employee_id,
        "leaveTypeId": lb.leave_type_id,
        "leaveTypeName": lb.leave_type.name if lb.leave_type else None,
        "leaveTypeCode": lb.leave_type.code if lb.leave_type else None,
        "year": lb.year,
        "allocated": float(lb.allocated),
        "used": float(lb.used),
        "remaining": float(lb.remaining),
        "carriedForward": float(lb.carried_forward),
    }


def holiday_json(h):
    return {
        "id": h.id,
        "name": h.name,
        "date": h.date.isoformat() if h.date else None,
        "holidayType": h.holiday_type,
        "branchId": h.branch_id,
        "branchName": h.branch.name if h.branch else None,
        "departmentId": h.department_id,
        "departmentName": h.department.name if h.department else None,
        "isRecurring": h.is_recurring,
        "description": h.description,
    }


# ── Leave Types ──────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def leave_types(request: Request) -> Response:
    if request.method == "GET":
        qs = LeaveType.objects.filter(is_active=True).order_by("name")
        return Response([leave_type_json(lt) for lt in qs])

    data = request.data
    if not data.get("name") or not data.get("code"):
        return Response({"error": "name and code are required"}, status=400)
    if LeaveType.objects.filter(code=data["code"]).exists():
        return Response({"error": "Leave type code already exists"}, status=400)

    lt = LeaveType.objects.create(
        name=data["name"],
        code=data["code"].upper(),
        max_days_per_year=int(data.get("maxDaysPerYear", 12)),
        carry_forward=bool(data.get("carryForward", False)),
        max_carry_forward_days=int(data.get("maxCarryForwardDays", 0)),
        is_paid=bool(data.get("isPaid", True)),
        applicable_gender=data.get("applicableGender", "all"),
    )
    return Response(leave_type_json(lt), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def leave_type_detail(request: Request, pk: int) -> Response:
    try:
        lt = LeaveType.objects.get(pk=pk)
    except LeaveType.DoesNotExist:
        return Response({"error": "Leave type not found"}, status=404)

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("maxDaysPerYear", "max_days_per_year"),
            ("carryForward", "carry_forward"), ("maxCarryForwardDays", "max_carry_forward_days"),
            ("isPaid", "is_paid"), ("applicableGender", "applicable_gender"),
            ("isActive", "is_active"),
        ]:
            if field in data:
                setattr(lt, attr, data[field])
        lt.save()
        return Response(leave_type_json(lt))

    lt.is_active = False
    lt.save()
    return Response(status=204)


# ── Leave Balances ───────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def leave_balances(request: Request) -> Response:
    emp_id = request.query_params.get("employeeId")
    year = request.query_params.get("year")
    qs = LeaveBalance.objects.select_related("leave_type").order_by("employee_id", "leave_type__name")
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if year:
        qs = qs.filter(year=year)
    return Response([leave_balance_json(lb) for lb in qs])


@api_view(["POST"])
@require_hr
def allocate_leave(request: Request) -> Response:
    data = request.data
    emp_id = data.get("employeeId")
    lt_id = data.get("leaveTypeId")
    year = data.get("year")
    allocated = data.get("allocated")

    if not all([emp_id, lt_id, year, allocated is not None]):
        return Response({"error": "employeeId, leaveTypeId, year, allocated are required"}, status=400)

    lb, _ = LeaveBalance.objects.get_or_create(
        employee_id=emp_id, leave_type_id=lt_id, year=year,
        defaults={"allocated": allocated, "remaining": allocated},
    )
    if not _:
        lb.allocated = allocated
        lb.remaining = float(allocated) - float(lb.used)
        lb.save()
    return Response(leave_balance_json(lb), status=201)


# ── Holidays ─────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def holidays(request: Request) -> Response:
    if request.method == "GET":
        year = request.query_params.get("year")
        branch_id = request.query_params.get("branchId")
        qs = Holiday.objects.select_related("branch", "department").order_by("date")
        if year:
            qs = qs.filter(date__year=year)
        if branch_id:
            qs = qs.filter(branch_id=branch_id)
        return Response([holiday_json(h) for h in qs])

    data = request.data
    if not data.get("name") or not data.get("date"):
        return Response({"error": "name and date are required"}, status=400)

    h = Holiday.objects.create(
        name=data["name"],
        date=data["date"],
        holiday_type=data.get("holidayType", "national"),
        branch_id=data.get("branchId"),
        department_id=data.get("departmentId"),
        is_recurring=bool(data.get("isRecurring", False)),
        description=data.get("description"),
    )
    return Response(holiday_json(h), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def holiday_detail(request: Request, pk: int) -> Response:
    try:
        h = Holiday.objects.select_related("branch", "department").get(pk=pk)
    except Holiday.DoesNotExist:
        return Response({"error": "Holiday not found"}, status=404)

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("date", "date"), ("holidayType", "holiday_type"),
            ("branchId", "branch_id"), ("departmentId", "department_id"),
            ("isRecurring", "is_recurring"), ("description", "description"),
        ]:
            if field in data:
                setattr(h, attr, data[field])
        h.save()
        return Response(holiday_json(h))

    h.delete()
    return Response(status=204)


# ── Approved Requests (Employee Mobile Requests) ─────────────────────────────

@api_view(["GET"])
@require_hr
def employee_requests(request: Request) -> Response:
    from .models import EmployeeRequest
    req_type = request.query_params.get("requestType")
    req_status = request.query_params.get("status")
    qs = EmployeeRequest.objects.select_related("employee").order_by("-created_at")
    if req_type:
        qs = qs.filter(request_type=req_type)
    if req_status:
        qs = qs.filter(status=req_status)

    def req_json(r):
        emp = r.employee
        return {
            "id": r.id,
            "employeeId": emp.id,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "employeeCode": emp.employee_code,
            "requestType": r.request_type,
            "subject": r.subject,
            "description": r.description,
            "status": r.status,
            "hrNotes": r.hr_notes,
            "handledBy": r.handled_by,
            "handledAt": r.handled_at.isoformat() if r.handled_at else None,
            "createdAt": r.created_at.isoformat() if r.created_at else None,
        }

    return Response([req_json(r) for r in qs])


@api_view(["PUT"])
@require_hr
def employee_request_action(request: Request, pk: int) -> Response:
    from .models import EmployeeRequest
    from datetime import datetime
    try:
        er = EmployeeRequest.objects.get(pk=pk)
    except EmployeeRequest.DoesNotExist:
        return Response({"error": "Request not found"}, status=404)

    data = request.data
    if "status" in data:
        er.status = data["status"]
    if "hrNotes" in data:
        er.hr_notes = data["hrNotes"]
    if "handledBy" in data:
        er.handled_by = data["handledBy"]
    er.handled_at = datetime.utcnow()
    er.save()
    return Response({"id": er.id, "status": er.status})
