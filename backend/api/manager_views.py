from django.db.models import Q

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .models import (
    Employee, Department,
    DepartmentManager, ManagerDepartmentAssignment, ManagerEmployeeAssignment,
    ResignationRequest, AttendanceOverrideRequest, AttendanceDayRecord,
    CasualLeaveRequest, Notification, OnDutyRequest,
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
        "canApproveResignations": m.can_approve_resignations,
        "canApproveAttendance": m.can_approve_attendance,
        "canApproveCasualLeave": m.can_approve_casual_leave,
        "canApproveOnDuty": m.can_approve_on_duty,
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
        can_approve_resignations=bool(data.get("canApproveResignations", True)),
        can_approve_attendance=bool(data.get("canApproveAttendance", True)),
        can_approve_casual_leave=bool(data.get("canApproveCasualLeave", True)),
        can_approve_on_duty=bool(data.get("canApproveOnDuty", True)),
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
    if "canApproveResignations" in data:
        m.can_approve_resignations = bool(data["canApproveResignations"])
    if "canApproveAttendance" in data:
        m.can_approve_attendance = bool(data["canApproveAttendance"])
    if "canApproveCasualLeave" in data:
        m.can_approve_casual_leave = bool(data["canApproveCasualLeave"])
    if "canApproveOnDuty" in data:
        m.can_approve_on_duty = bool(data["canApproveOnDuty"])
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

    pending_leaves = LeaveRequest.objects.filter(emp_filter, status="pending").count()
    pending_perms = EmployeePermission.objects.filter(emp_filter, status="pending").count()
    pending_resignations = (
        ResignationRequest.objects.filter(emp_filter, status="pending").count()
        if m.can_approve_resignations else 0
    )
    pending_attendance = (
        AttendanceOverrideRequest.objects.filter(emp_filter, status="pending").count()
        if m.can_approve_attendance else 0
    )
    pending_casual = (
        CasualLeaveRequest.objects.filter(emp_filter, status="pending").count()
        if m.can_approve_casual_leave else 0
    )
    pending_on_duty = (
        OnDutyRequest.objects.filter(emp_filter, status=OnDutyRequest.STATUS_PENDING_HOD).count()
        if m.can_approve_on_duty else 0
    )
    pending_count = (
        pending_leaves + pending_perms + pending_resignations
        + pending_attendance + pending_casual + pending_on_duty
    )

    return Response({
        "isManager": True,
        "canSubmitLeave": True,
        "canApproveResignations": m.can_approve_resignations,
        "canApproveAttendance": m.can_approve_attendance,
        "canApproveCasualLeave": m.can_approve_casual_leave,
        "canApproveOnDuty": m.can_approve_on_duty,
        "pendingApprovalsCount": pending_count,
        "pendingLeavesCount": pending_leaves,
        "pendingPermissionsCount": pending_perms,
        "pendingResignationsCount": pending_resignations,
        "pendingAttendanceCount": pending_attendance,
        "pendingCasualLeaveCount": pending_casual,
        "pendingOnDutyCount": pending_on_duty,
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

    from .recruitment_views import _resignation_json
    resign_qs = ResignationRequest.objects.select_related(
        "employee", "employee__department", "employee__designation", "dept_head"
    ).filter(emp_filter)
    if status_filter != "all" and m.can_approve_resignations:
        resign_qs = resign_qs.filter(status=status_filter)
    elif not m.can_approve_resignations:
        resign_qs = ResignationRequest.objects.none()
    resign_qs = resign_qs.order_by("-created_at")

    from .growth_views import _override_request_dict
    attendance_qs = AttendanceOverrideRequest.objects.select_related(
        "employee__department", "employee__designation"
    ).filter(emp_filter)
    if status_filter != "all" and m.can_approve_attendance:
        attendance_qs = attendance_qs.filter(status=status_filter)
    elif not m.can_approve_attendance:
        attendance_qs = AttendanceOverrideRequest.objects.none()
    attendance_qs = attendance_qs.order_by("-created_at")

    from .casual_leave_views import _cl_dict
    casual_qs = CasualLeaveRequest.objects.select_related(
        "employee__department", "employee__designation"
    ).filter(emp_filter)
    if status_filter != "all" and m.can_approve_casual_leave:
        casual_qs = casual_qs.filter(status=status_filter)
    elif not m.can_approve_casual_leave:
        casual_qs = CasualLeaveRequest.objects.none()
    casual_qs = casual_qs.order_by("-created_at")

    from .geo_attendance_views import _on_duty_request_dict
    on_duty_qs = OnDutyRequest.objects.select_related(
        "employee__department", "employee__designation", "branch"
    ).filter(emp_filter)
    if m.can_approve_on_duty:
        if status_filter == "pending":
            on_duty_qs = on_duty_qs.filter(status=OnDutyRequest.STATUS_PENDING_HOD)
        elif status_filter != "all":
            on_duty_qs = on_duty_qs.filter(status=status_filter)
    else:
        on_duty_qs = OnDutyRequest.objects.none()
    on_duty_qs = on_duty_qs.order_by("-created_at")

    return Response({
        "leaveRequests": [_leave_with_emp(r) for r in leave_qs],
        "permissions": [_perm_with_emp(p) for p in perm_qs],
        "resignations": [_resignation_json(r) for r in resign_qs],
        "attendanceRequests": [_override_request_dict(r) for r in attendance_qs],
        "casualLeaves": [_cl_dict(r) for r in casual_qs],
        "onDutyRequests": [_on_duty_request_dict(r) for r in on_duty_qs],
        "totalPending": (
            LeaveRequest.objects.filter(emp_filter, status="pending").count()
            + EmployeePermission.objects.filter(emp_filter, status="pending").count()
            + (ResignationRequest.objects.filter(emp_filter, status="pending").count() if m.can_approve_resignations else 0)
            + (AttendanceOverrideRequest.objects.filter(emp_filter, status="pending").count() if m.can_approve_attendance else 0)
            + (CasualLeaveRequest.objects.filter(emp_filter, status="pending").count() if m.can_approve_casual_leave else 0)
            + (OnDutyRequest.objects.filter(emp_filter, status=OnDutyRequest.STATUS_PENDING_HOD).count() if m.can_approve_on_duty else 0)
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
    Notification.objects.create(
        employee=leave.employee,
        type="leave",
        message=f"Your leave request ({leave.start_date} to {leave.end_date}) was {status}.",
    )
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
    Notification.objects.create(
        employee=perm.employee,
        type="permission",
        message=f"Your permission request for {perm.date.isoformat()} was {status}.",
    )
    return Response(_permission_json(perm))


@api_view(["PATCH"])
@require_auth
def manager_update_attendance_status(request: Request, pk: int) -> Response:
    """
    Department Head approves/rejects an HR-submitted attendance override request.
    Approval writes the requested values onto AttendanceDayRecord (used by payroll).
    Rejection leaves the original attendance data untouched.
    """
    from .growth_views import _override_request_dict, apply_override_values
    from .attendance_final import compute_day_record

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.select_related("employee").prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    if not m.can_approve_attendance:
        return Response({
            "error": "Approve-attendance access is disabled for your account. Ask HR to enable it.",
            "code": "APPROVE_ATTENDANCE_DISABLED",
        }, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    try:
        req = AttendanceOverrideRequest.objects.select_related(
            "employee__department", "employee__designation"
        ).filter(emp_filter).get(pk=pk)
    except AttendanceOverrideRequest.DoesNotExist:
        if AttendanceOverrideRequest.objects.filter(pk=pk).exists():
            return Response({"error": "This request is not in your approval scope"}, status=403)
        return Response({"error": "Attendance override request not found"}, status=404)

    if req.status != "pending":
        return Response({"error": f"This request was already {req.status}"}, status=400)

    status_val = request.data.get("status")
    if status_val not in ["approved", "rejected"]:
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    from django.utils import timezone
    reviewer_name = f"{m.employee.first_name} {m.employee.last_name}"

    if status_val == "approved":
        record = AttendanceDayRecord.objects.filter(employee=req.employee, date=req.date).first()
        if record is None:
            record = compute_day_record(req.employee, req.date)
        apply_override_values(record, req.requested_values, reviewer_name)

    req.status = status_val
    req.reviewed_by = reviewer_name
    req.reviewed_at = timezone.now()
    if comment := request.data.get("comment"):
        req.review_comment = comment
    req.save()
    Notification.objects.create(
        employee=req.employee,
        type="attendance",
        message=f"Your attendance correction request for {req.date} was {status_val}.",
    )
    return Response(_override_request_dict(req))


@api_view(["PATCH"])
@require_auth
def manager_update_on_duty_status(request: Request, pk: int) -> Response:
    """
    Department Head — stage 1 of the On-Duty approval chain. Approval moves
    the request to pending_hr (HR still has to approve before the punch is
    recorded); rejection is terminal. Shares resolve_on_duty_hod() with
    nothing else — it's the only caller of stage 1 — but writes the same
    request row HR's endpoints (geo_attendance_views.py) read from.
    """
    from .geo_attendance_views import _on_duty_request_dict, resolve_on_duty_hod

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.select_related("employee").prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    if not m.can_approve_on_duty:
        return Response({
            "error": "Approve-on-duty access is disabled for your account. Ask HR to enable it.",
            "code": "APPROVE_ON_DUTY_DISABLED",
        }, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    try:
        req = OnDutyRequest.objects.select_related(
            "employee__department", "employee__designation", "branch"
        ).filter(emp_filter).get(pk=pk)
    except OnDutyRequest.DoesNotExist:
        if OnDutyRequest.objects.filter(pk=pk).exists():
            return Response({"error": "This request is not in your approval scope"}, status=403)
        return Response({"error": "On-Duty request not found"}, status=404)

    if req.status != OnDutyRequest.STATUS_PENDING_HOD:
        return Response({"error": f"This request was already actioned (status: {req.status})"}, status=400)

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    reviewer_name = f"{m.employee.first_name} {m.employee.last_name}"
    resolve_on_duty_hod(req, status_val, reviewer_name, request.data.get("comment"))
    return Response(_on_duty_request_dict(req))


@api_view(["PATCH"])
@require_auth
def manager_update_casual_leave_status(request: Request, pk: int) -> Response:
    """Department Head approves/rejects a Casual Leave request from their team."""
    from .casual_leave_views import _cl_dict, apply_cl_decision

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    try:
        m = DepartmentManager.objects.select_related("employee").prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return Response({"error": "Not a department manager"}, status=403)

    if not m.can_approve_casual_leave:
        return Response({
            "error": "Approve-casual-leave access is disabled for your account. Ask HR to enable it.",
            "code": "APPROVE_CASUAL_LEAVE_DISABLED",
        }, status=403)

    dept_ids, direct_ids = _get_manager_employee_ids(m)
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

    try:
        cl = CasualLeaveRequest.objects.select_related(
            "employee__department", "employee__designation"
        ).filter(emp_filter).get(pk=pk)
    except CasualLeaveRequest.DoesNotExist:
        if CasualLeaveRequest.objects.filter(pk=pk).exists():
            return Response({"error": "This request is not in your approval scope"}, status=403)
        return Response({"error": "Casual leave request not found"}, status=404)

    if cl.status != "pending":
        return Response({"error": f"This request was already {cl.status}"}, status=400)

    status_val = request.data.get("status")
    if status_val not in ["approved", "rejected"]:
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    reviewer_name = f"{m.employee.first_name} {m.employee.last_name}"
    apply_cl_decision(cl, status_val, reviewer_name, "dept_head", request.data.get("comment"))
    return Response(_cl_dict(cl))
