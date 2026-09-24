"""Leave requests: list/create, approve/reject, delete."""

from .auth import get_hr_display_name, get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import Employee, LeaveBalance, LeaveRequest, LeaveType, Notification
from .serializers import leave_request_json
from .view_common import _employee_name, _error, paginate
from datetime import date, timedelta
from decimal import Decimal
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Leave ---


def _leave_with_name(record: LeaveRequest) -> dict:
    emp = getattr(record, "employee", None)
    name = f"{emp.first_name} {emp.last_name}" if emp else _employee_name(record.employee_id)
    return leave_request_json(record, name)


@api_view(["GET", "POST"])
def leave_requests(request: Request) -> Response:
    if request.method == "GET":
        return require_auth(_leave_requests_list)(request)
    return require_auth(_leave_requests_create)(request)


def _resolve_employee_filter(params) -> int | None:
    """Return employee pk from either ?employeeId=N or ?employeeCode=XXXX."""
    if code := params.get("employeeCode") or params.get("employee_code"):
        emp = Employee.objects.filter(employee_code=code).first()
        return emp.id if emp else None
    if eid := params.get("employeeId") or params.get("employee_id"):
        return int(eid)
    return None


def _leave_requests_list(request: Request) -> Response:
    qs = LeaveRequest.objects.select_related("employee__department", "employee__designation").order_by("-id")
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    employee_id = _resolve_employee_filter(request.query_params)
    # An employee token only ever sees its own requests, whatever the filter says.
    if (token_emp_id := get_token_employee_id(request)) is not None:
        employee_id = token_emp_id
    leave_status = request.query_params.get("status")
    if employee_id:
        qs = qs.filter(employee_id=employee_id)
    if leave_status:
        qs = qs.filter(status=leave_status)
    return paginate(request, qs, _leave_with_name)


def _count_leave_days(start_str, end_str) -> int:
    """Count working days (Mon–Sat) between start and end inclusive."""
    try:
        start = date.fromisoformat(str(start_str))
        end   = date.fromisoformat(str(end_str))
    except Exception:
        return 1
    count = 0
    cur = start
    while cur <= end:
        if cur.weekday() != 6:   # skip Sunday
            count += 1
        cur += timedelta(days=1)
    return max(1, count)


def _leave_requests_create(request: Request) -> Response:
    data = request.data
    # Accept employeeCode, camelCase, or snake_case
    employee_id = None
    if code := data.get("employeeCode") or data.get("employee_code"):
        emp = Employee.objects.filter(employee_code=code).first()
        employee_id = emp.id if emp else None
    if not employee_id:
        employee_id = data.get("employeeId") or data.get("employee_id")
    # Employees can only file leave for themselves.
    if (token_emp_id := get_token_employee_id(request)) is not None:
        if employee_id and int(employee_id) != token_emp_id:
            return _error("You can only apply for leave on your own behalf", 403)
        employee_id = token_emp_id
    start_date  = data.get("startDate")  or data.get("start_date")
    end_date    = data.get("endDate")    or data.get("end_date") or start_date
    # The mobile app's Apply Leave form submits leaveTypeId (see
    # useApplyLeave/app/(tabs)/leave.tsx), not a "type" string -this was
    # previously never read here, so every mobile-submitted leave silently
    # stored as type="casual" regardless of what the employee actually
    # picked, and leave_type_ref stayed unset (which also made
    # update_leave_status's LeaveBalance deduction below match ANY balance
    # row for the employee/year instead of the specific leave type's row).
    # HR web's own create form, if any, keeps working exactly as before by
    # sending "type"/"leave_type" directly.
    leave_type_id = data.get("leaveTypeId") or data.get("leave_type_id")
    leave_type_ref = LeaveType.objects.filter(pk=leave_type_id).first() if leave_type_id else None
    leave_type = data.get("type") or data.get("leave_type") or (leave_type_ref.name if leave_type_ref else "casual")
    is_half_day = bool(data.get("isHalfDay") or data.get("is_half_day"))
    half_day_slot = data.get("halfDaySlot") or data.get("half_day_slot")

    if not employee_id or not start_date:
        return Response({"error": "employeeId and startDate are required"}, status=400)

    if is_half_day:
        if half_day_slot not in (LeaveRequest.HALF_DAY_MORNING, LeaveRequest.HALF_DAY_AFTERNOON):
            return Response({"error": "halfDaySlot must be 'morning' or 'afternoon'"}, status=400)
        if end_date != start_date:
            return Response({"error": "A half-day leave request must be for a single day"}, status=400)
        total_days = Decimal("0.5")
    else:
        half_day_slot = None
        total_days = _count_leave_days(start_date, end_date)

    record = LeaveRequest.objects.create(
        employee_id=employee_id,
        type=leave_type,
        leave_type_ref=leave_type_ref,
        start_date=start_date,
        end_date=end_date,
        total_days=total_days,
        is_half_day=is_half_day,
        half_day_slot=half_day_slot,
        reason=data.get("reason"),
    )
    return Response(_leave_with_name(record), status=201)


@api_view(["PATCH"])
@require_hr
def update_leave_status(request: Request, pk: int) -> Response:
    record = LeaveRequest.objects.filter(pk=pk).first()
    if not record:
        return _error("Not found", 404)

    old_status = record.status
    new_status = request.data.get("status", old_status)
    record.status = new_status
    if "hrComment" in request.data:
        record.hr_comment = request.data["hrComment"]
    if new_status in ("approved", "rejected") and old_status != new_status:
        record.approved_by = get_hr_display_name(request)
        record.approver_role = "hr"
    record.save()

    if new_status == "approved" and old_status != "approved":
        days = Decimal(str(record.total_days or 1))
        try:
            year = int(record.start_date[:4])
        except Exception:
            year = ist_today().year
        qs = LeaveBalance.objects.filter(employee_id=record.employee_id, year=year)
        if record.leave_type_ref_id:
            qs = qs.filter(leave_type_id=record.leave_type_ref_id)
        for lb in qs:
            lb.used = Decimal(str(lb.used)) + days
            lb.remaining = max(Decimal("0"), Decimal(str(lb.remaining)) - days)
            lb.save()
        Notification.objects.create(
            employee_id=record.employee_id,
            type="leave",
            message=f"Your leave request ({record.start_date} → {record.end_date}) has been approved.",
        )

    elif new_status == "rejected" and old_status != "rejected":
        Notification.objects.create(
            employee_id=record.employee_id,
            type="leave",
            message=f"Your leave request ({record.start_date} → {record.end_date}) has been rejected.",
        )

    return Response(_leave_with_name(record))


@api_view(["DELETE"])
@require_hr
def delete_leave_request(request: Request, pk: int) -> Response:
    record = LeaveRequest.objects.filter(pk=pk).first()
    if not record:
        return _error("Not found", 404)
    record.delete()
    return Response(status=204)
