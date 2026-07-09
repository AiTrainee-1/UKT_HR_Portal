from datetime import date as date_type

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id, is_hr
from .models import LeaveType, LeaveBalance, Holiday, LeaveRequest, Employee, Notification, EmployeePermission


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
@require_auth
def leave_types(request: Request) -> Response:
    if request.method == "GET":
        qs = LeaveType.objects.filter(is_active=True).order_by("name")
        return Response([leave_type_json(lt) for lt in qs])
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

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
@require_auth
def leave_balances(request: Request) -> Response:
    emp_id = request.query_params.get("employeeId")
    year = request.query_params.get("year")
    # Employees can only see their own balance
    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp_id = token_emp_id
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
@require_auth
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
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    data = request.data
    if not data.get("name") or not data.get("date"):
        return Response({"error": "name and date are required"}, status=400)

    try:
        parsed_date = date_type.fromisoformat(data["date"])
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    h = Holiday.objects.create(
        name=data["name"],
        date=parsed_date,
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

def _req_json(r):
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


@api_view(["GET", "POST"])
def employee_requests(request: Request) -> Response:
    from .models import EmployeeRequest
    from .auth import require_auth

    if request.method == "POST":
        return require_auth(_employee_request_create)(request)

    @require_hr
    def _get(req):
        req_type = req.query_params.get("requestType")
        req_status = req.query_params.get("status")
        qs = EmployeeRequest.objects.select_related("employee").order_by("-created_at")
        if req_type:
            qs = qs.filter(request_type=req_type)
        if req_status:
            qs = qs.filter(status=req_status)
        return Response([_req_json(r) for r in qs])

    return _get(request)


def _employee_request_create(request: Request) -> Response:
    from .models import EmployeeRequest
    data = request.data
    emp_id = data.get("employeeId")
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)
    if not data.get("subject") or not data.get("requestType"):
        return Response({"error": "subject and requestType are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    from .models import EmployeeRequest
    er = EmployeeRequest.objects.create(
        employee=emp,
        request_type=data["requestType"],
        subject=data["subject"],
        description=data.get("description", ""),
    )

    label = dict(EmployeeRequest.REQUEST_TYPES).get(data["requestType"], data["requestType"])
    Notification.objects.create(
        employee=emp,
        type="employee_request",
        message=f"New {label} submitted by {emp.first_name} {emp.last_name}: '{data['subject']}'",
    )

    return Response(_req_json(er), status=201)


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
    prev_status = er.status
    if "status" in data:
        er.status = data["status"]
    if "hrNotes" in data:
        er.hr_notes = data["hrNotes"]
    if "handledBy" in data:
        er.handled_by = data["handledBy"]
    er.handled_at = datetime.utcnow()
    er.save()
    if er.status != prev_status:
        Notification.objects.create(
            employee=er.employee,
            type="employee_request",
            message=f"Your request '{er.subject}' is now {er.status.replace('_', ' ')}.",
        )
    return Response({"id": er.id, "status": er.status})


# ── Employee Permissions ──────────────────────────────────────────────────────

MONTHLY_PERMISSION_LIMIT = 3


def _permission_json(p, monthly_used=None):
    emp = p.employee
    return {
        "id": p.id,
        "employeeId": emp.id,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "employeeCode": emp.employee_code,
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "date": p.date.isoformat() if p.date else None,
        "permissionTime": p.permission_time.strftime("%H:%M") if p.permission_time else None,
        "reason": p.reason,
        "status": p.status,
        "hrComment": p.hr_comment,
        "approvedBy": p.approved_by,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "monthlyUsed": monthly_used,
        "monthlyLimit": MONTHLY_PERMISSION_LIMIT,
    }


@api_view(["GET", "POST"])
@require_auth
def employee_permissions(request: Request) -> Response:
    if request.method == "GET":
        qs = EmployeePermission.objects.select_related("employee__department", "employee__designation").order_by("-date", "-created_at")
        # Resolve employee by code or ID; employees can only see their own
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            emp_id = token_emp_id
        elif code := request.query_params.get("employeeCode") or request.query_params.get("employee_code"):
            from .models import Employee as _Emp
            found = _Emp.objects.filter(employee_code=code).first()
            emp_id = found.id if found else None
        else:
            emp_id = request.query_params.get("employeeId") or request.query_params.get("employee_id")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if status := request.query_params.get("status"):
            qs = qs.filter(status=status)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=month)
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=year)
        return Response([_permission_json(p) for p in qs])

    data = request.data
    # Accept employeeCode, camelCase, or snake_case
    emp_id    = None
    if code := data.get("employeeCode") or data.get("employee_code"):
        found = Employee.objects.filter(employee_code=code).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId") or data.get("employee_id")
    perm_date = data.get("date") or data.get("permission_date")
    # Employees can only submit permissions for themselves
    token_emp_id = get_token_employee_id(request)
    if token_emp_id and str(token_emp_id) != str(emp_id):
        return Response({"error": "You can only submit permissions for yourself"}, status=403)
    if not emp_id or not perm_date:
        return Response({"error": "employeeId and date are required"}, status=400)

    try:
        parsed_date = date_type.fromisoformat(perm_date)
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    month_used = EmployeePermission.objects.filter(
        employee=emp,
        date__year=parsed_date.year,
        date__month=parsed_date.month,
        status__in=["pending", "approved"],
    ).count()

    if month_used >= MONTHLY_PERMISSION_LIMIT:
        return Response(
            {"error": f"Employee has already used {MONTHLY_PERMISSION_LIMIT} permissions this month"},
            status=400,
        )

    perm_time = data.get("permissionTime") or data.get("permission_time") or None
    if perm_time:
        from datetime import time as time_type
        try:
            h, m = perm_time.split(":")
            perm_time = time_type(int(h), int(m))
        except Exception:
            return Response({"error": "Invalid permissionTime format (HH:MM)"}, status=400)

    p = EmployeePermission.objects.create(
        employee=emp,
        date=parsed_date,
        permission_time=perm_time,
        reason=data.get("reason"),
        status=data.get("status", "pending"),
    )

    month_used_after = EmployeePermission.objects.filter(
        employee=emp,
        date__year=parsed_date.year,
        date__month=parsed_date.month,
        status__in=["pending", "approved"],
    ).count()

    return Response(_permission_json(p, monthly_used=month_used_after), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def employee_permission_detail(request: Request, pk: int) -> Response:
    try:
        p = EmployeePermission.objects.select_related("employee").get(pk=pk)
    except EmployeePermission.DoesNotExist:
        return Response({"error": "Permission not found"}, status=404)

    if request.method == "DELETE":
        p.delete()
        return Response(status=204)

    data = request.data
    prev_status = p.status
    if "status" in data:
        p.status = data["status"]
    if "hrComment" in data:
        p.hr_comment = data["hrComment"]
    if "approvedBy" in data:
        p.approved_by = data["approvedBy"]
    p.save()
    if p.status != prev_status and p.status in ("approved", "rejected"):
        Notification.objects.create(
            employee=p.employee,
            type="permission",
            message=f"Your permission request for {p.date.isoformat()} was {p.status}.",
        )
    return Response(_permission_json(p))
