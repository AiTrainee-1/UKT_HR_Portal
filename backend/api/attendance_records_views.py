"""Basic manual Attendance list/create."""

from .auth import get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .models import Attendance
from .serializers import attendance_json, parse_decimal
from .view_common import paginate
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Attendance ---


@api_view(["GET", "POST"])
def attendance(request: Request) -> Response:
    if request.method == "GET":
        return require_auth(_attendance_list)(request)
    return require_hr(_attendance_create)(request)


def _attendance_list(request: Request) -> Response:
    qs = scope_to_branch(Attendance.objects.order_by("-id"), request, field="employee__branch_id")
    employee_id = request.query_params.get("employeeId")
    year = request.query_params.get("year")
    # An employee token only ever sees its own rows, whatever employeeId says.
    if (token_emp_id := get_token_employee_id(request)) is not None:
        employee_id = token_emp_id
    if employee_id:
        qs = qs.filter(employee_id=int(employee_id))
    if year:
        qs = qs.filter(date__startswith=str(year))
    return paginate(request, qs, attendance_json)


def _attendance_create(request: Request) -> Response:
    data = request.data
    record, _created = Attendance.objects.update_or_create(
        employee_id=data.get("employeeId"),
        date=data.get("date"),
        defaults={
            "present": data.get("present", True),
            "hours_worked": parse_decimal(data.get("hoursWorked")),
            "notes": data.get("notes"),
        },
    )
    return Response(attendance_json(record), status=201)
