from django.db.models import Q

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .models import (
    Employee, Department,
    DepartmentManager, ManagerDepartmentAssignment, ManagerEmployeeAssignment,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _manager_json(m, include_assignments=False):
    emp = m.employee
    dept_assignments = list(m.department_assignments.select_related("department").all())
    emp_assignments = list(
        m.employee_assignments.select_related("employee__department", "employee__designation").all()
    )
    data = {
        "id": m.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "canApproveLeaves": m.can_approve_leaves,
        "canApprovePermissions": m.can_approve_permissions,
        "isActive": m.is_active,
        "notes": m.notes,
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        "departmentCount": len(dept_assignments),
        "employeeCount": len(emp_assignments),
    }
    if include_assignments:
        data["assignedDepartments"] = [
            {
                "id": da.department.id,
                "name": da.department.name,
                "assignedAt": da.created_at.isoformat() if da.created_at else None,
            }
            for da in dept_assignments
        ]
        data["assignedEmployees"] = [
            {
                "id": ea.employee.id,
                "employeeCode": ea.employee.employee_code,
                "name": f"{ea.employee.first_name} {ea.employee.last_name}",
                "department": ea.employee.department.name if ea.employee.department_id and ea.employee.department else None,
                "designation": ea.employee.designation.title if ea.employee.designation_id and ea.employee.designation else None,
                "assignedAt": ea.created_at.isoformat() if ea.created_at else None,
            }
            for ea in emp_assignments
        ]
    return data


def _get_manager_employee_ids(m):
    """Return all employee IDs that this manager oversees (dept-based + direct)."""
    dept_ids = [da.department_id for da in m.department_assignments.all()]
    direct_ids = [ea.employee_id for ea in m.employee_assignments.all()]
    return dept_ids, direct_ids


# ─── HR-only: CRUD for department managers ────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def department_managers(request: Request) -> Response:
    if request.method == "GET":
        qs = DepartmentManager.objects.select_related(
            "employee__department", "employee__designation"
        ).prefetch_related("department_assignments", "employee_assignments").order_by("-created_at")
        return Response([_manager_json(m) for m in qs])

    data = request.data
    emp_id = None
    if code := data.get("employeeCode") or data.get("employee_code"):
        found = Employee.objects.filter(employee_code=code).first()
        if not found:
            return Response({"error": f"Employee with code '{code}' not found"}, status=404)
        emp_id = found.id
    if not emp_id:
        emp_id = data.get("employeeId") or data.get("employee_id")
    if not emp_id:
        return Response({"error": "employeeCode or employeeId is required"}, status=400)

    try:
        emp = Employee.objects.select_related("department", "designation").get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    if DepartmentManager.objects.filter(employee=emp).exists():
        return Response({"error": "This employee is already a department manager"}, status=400)

    m = DepartmentManager.objects.create(
        employee=emp,
        can_approve_leaves=bool(data.get("canApproveLeaves", True)),
        can_approve_permissions=bool(data.get("canApprovePermissions", True)),
        notes=data.get("notes"),
    )
    return Response(_manager_json(m, include_assignments=True), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def department_manager_detail(request: Request, pk: int) -> Response:
    try:
        m = DepartmentManager.objects.select_related(
            "employee__department", "employee__designation"
        ).prefetch_related(
            "department_assignments__department",
            "employee_assignments__employee__department",
            "employee_assignments__employee__designation",
        ).get(pk=pk)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Manager not found"}, status=404)

    if request.method == "GET":
        return Response(_manager_json(m, include_assignments=True))

    if request.method == "DELETE":
        m.delete()
        return Response(status=204)

    data = request.data
    if "canApproveLeaves" in data:
        m.can_approve_leaves = bool(data["canApproveLeaves"])
    if "canApprovePermissions" in data:
        m.can_approve_permissions = bool(data["canApprovePermissions"])
    if "isActive" in data:
        m.is_active = bool(data["isActive"])
    if "notes" in data:
        m.notes = data["notes"]
    m.save()
    # Re-fetch with fresh prefetch
    m.refresh_from_db()
    return Response(_manager_json(
        DepartmentManager.objects.select_related(
            "employee__department", "employee__designation"
        ).prefetch_related(
            "department_assignments__department",
            "employee_assignments__employee__department",
            "employee_assignments__employee__designation",
        ).get(pk=pk),
        include_assignments=True,
    ))


# ─── Department assignments ───────────────────────────────────────────────────

@api_view(["POST", "DELETE"])
@require_hr
def manager_department_assignments(request: Request, pk: int) -> Response:
    try:
        m = DepartmentManager.objects.get(pk=pk)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Manager not found"}, status=404)

    if request.method == "POST":
        dept_id = request.data.get("departmentId")
        if not dept_id:
            return Response({"error": "departmentId is required"}, status=400)
        try:
            dept = Department.objects.get(pk=dept_id)
        except Department.DoesNotExist:
            return Response({"error": "Department not found"}, status=404)
        _, created = ManagerDepartmentAssignment.objects.get_or_create(manager=m, department=dept)
        if not created:
            return Response({"error": "Department already assigned to this manager"}, status=400)
        return Response({"message": f"Department '{dept.name}' assigned"}, status=201)

    dept_id = request.data.get("departmentId")
    if not dept_id:
        return Response({"error": "departmentId is required"}, status=400)
    deleted, _ = ManagerDepartmentAssignment.objects.filter(manager=m, department_id=dept_id).delete()
    if not deleted:
        return Response({"error": "Assignment not found"}, status=404)
    return Response(status=204)


# ─── Individual employee assignments ─────────────────────────────────────────

@api_view(["POST", "DELETE"])
@require_hr
def manager_employee_assignments(request: Request, pk: int) -> Response:
    try:
        m = DepartmentManager.objects.get(pk=pk)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Manager not found"}, status=404)

    if request.method == "POST":
        emp_id = None
        if code := request.data.get("employeeCode") or request.data.get("employee_code"):
            found = Employee.objects.filter(employee_code=code).first()
            emp_id = found.id if found else None
        if not emp_id:
            emp_id = request.data.get("employeeId") or request.data.get("employee_id")
        if not emp_id:
            return Response({"error": "employeeCode or employeeId is required"}, status=400)
        try:
            emp = Employee.objects.get(pk=emp_id)
        except Employee.DoesNotExist:
            return Response({"error": "Employee not found"}, status=404)
        _, created = ManagerEmployeeAssignment.objects.get_or_create(manager=m, employee=emp)
        if not created:
            return Response({"error": "Employee already assigned to this manager"}, status=400)
        return Response({"message": f"{emp.first_name} {emp.last_name} assigned"}, status=201)

    emp_id = request.data.get("employeeId") or request.data.get("employee_id")
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)
    deleted, _ = ManagerEmployeeAssignment.objects.filter(manager=m, employee_id=emp_id).delete()
    if not deleted:
        return Response({"error": "Assignment not found"}, status=404)
    return Response(status=204)


# ─── Mobile App: Manager profile + approval endpoints ─────────────────────────

@api_view(["GET"])
@require_auth
def manager_me(request: Request) -> Response:
    """Returns the current employee's manager profile and access flags."""
    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.select_related(
            "employee__department", "employee__designation"
        ).prefetch_related(
            "department_assignments__department",
            "employee_assignments__employee__department",
            "employee_assignments__employee__designation",
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"isManager": False, "canSubmitLeave": False, "pendingApprovalsCount": 0})

    from .models import LeaveRequest, EmployeePermission
    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    pending_count = (
        LeaveRequest.objects.filter(emp_filter, status="pending").count()
        + EmployeePermission.objects.filter(emp_filter, status="pending").count()
    )

    return Response({
        "isManager": True,
        "canSubmitLeave": True,
        "pendingApprovalsCount": pending_count,
        **_manager_json(m, include_assignments=True),
    })


@api_view(["GET"])
@require_auth
def manager_pending_requests(request: Request) -> Response:
    """All leave + permission requests for employees under this manager."""
    from .models import LeaveRequest, EmployeePermission
    from .serializers import leave_request_json
    from .leave_views import _permission_json

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    status_filter = request.query_params.get("status", "pending")

    leave_qs = LeaveRequest.objects.select_related(
        "employee__department", "employee__designation"
    ).filter(emp_filter)
    perm_qs = EmployeePermission.objects.select_related(
        "employee__department", "employee__designation"
    ).filter(emp_filter)

    if status_filter != "all":
        leave_qs = leave_qs.filter(status=status_filter)
        perm_qs = perm_qs.filter(status=status_filter)

    leave_qs = leave_qs.order_by("-created_at")
    perm_qs = perm_qs.order_by("-created_at")

    def _leave_with_emp(r):
        data = leave_request_json(r)
        emp = r.employee
        # Include nested employee object so mobile can read either flat or nested fields
        data["employee"] = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "firstName": emp.first_name,
            "lastName": emp.last_name,
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        }
        return data

    def _perm_with_emp(p):
        data = _permission_json(p)
        emp = p.employee
        data["employee"] = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "firstName": emp.first_name,
            "lastName": emp.last_name,
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        }
        return data

    return Response({
        "leaveRequests": [_leave_with_emp(r) for r in leave_qs],
        "permissions": [_perm_with_emp(p) for p in perm_qs],
        "totalPending": (
            LeaveRequest.objects.filter(emp_filter, status="pending").count()
            + EmployeePermission.objects.filter(emp_filter, status="pending").count()
        ),
    })


@api_view(["PATCH"])
@require_auth
def manager_update_leave_status(request: Request, pk: int) -> Response:
    """Manager approves/rejects a leave request from their team."""
    from .models import LeaveRequest
    from .serializers import leave_request_json

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    if not m.can_approve_leaves:
        return Response({
            "error": "Approve-leave permission is disabled for your account. Ask HR to enable it.",
            "code": "APPROVE_LEAVES_DISABLED",
        }, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    try:
        leave = LeaveRequest.objects.select_related(
            "employee__department", "employee__designation"
        ).filter(emp_filter).get(pk=pk)
    except LeaveRequest.DoesNotExist:
        # Either not found or not in this manager's scope
        if LeaveRequest.objects.filter(pk=pk).exists():
            return Response({"error": "This leave request is not in your approval scope"}, status=403)
        return Response({"error": "Leave request not found"}, status=404)

    status = request.data.get("status")
    if status not in ["approved", "rejected"]:
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    leave.status = status
    if comment := request.data.get("comment"):
        leave.hr_comment = comment
    leave.save()
    return Response(leave_request_json(leave))


@api_view(["PATCH"])
@require_auth
def manager_update_permission_status(request: Request, pk: int) -> Response:
    """Manager approves/rejects a permission request from their team."""
    from .models import EmployeePermission
    from .leave_views import _permission_json

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    if not m.can_approve_permissions:
        return Response({
            "error": "Approve-permission access is disabled for your account. Ask HR to enable it.",
            "code": "APPROVE_PERMISSIONS_DISABLED",
        }, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    try:
        perm = EmployeePermission.objects.select_related(
            "employee__department", "employee__designation"
        ).filter(emp_filter).get(pk=pk)
    except EmployeePermission.DoesNotExist:
        if EmployeePermission.objects.filter(pk=pk).exists():
            return Response({"error": "This permission request is not in your approval scope"}, status=403)
        return Response({"error": "Permission request not found"}, status=404)

    status = request.data.get("status")
    if status not in ["approved", "rejected"]:
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    perm.status = status
    if comment := request.data.get("comment"):
        perm.hr_comment = comment
    perm.save()
    return Response(_permission_json(perm))
