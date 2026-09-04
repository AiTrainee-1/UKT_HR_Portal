"""Read-only external API for the Co HRMS Portal (a separate application,
separate database) to pull its data from.

Every view here is GET-only and gated by @require_portal_key (a static
shared secret in the X-Portal-Key header -see auth.py) rather than the
JWT-based decorators used everywhere else, since the caller is a scheduled
background job in another application, not a logged-in person. There is no
write path anywhere in this file, deliberately: the Co Portal must never be
able to change anything in this database, only read from it.

Employees are scoped to co_emp_enabled=True throughout -HR opts an employee
into the Co Portal from the main HRMS's Employees -> Co Emp tab, and only
those employees, plus their department/designation/branch and attendance
punches, are ever visible through this API.
"""
from datetime import datetime

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_portal_key
from .models import AttendanceLog, Branch, Department, Designation, Employee
from .serializers import co_portal_employee_json, department_json


def _designation_json(d: Designation) -> dict:
    return {
        "id": d.id,
        "title": d.title,
        "departmentId": d.department_id,
        "level": d.level,
    }


def _branch_json(b: Branch) -> dict:
    return {
        "id": b.id,
        "name": b.name,
        "code": b.code,
        "location": b.location,
        "address": b.address,
        "isHeadOffice": b.is_head_office,
    }


@api_view(["GET"])
@require_portal_key
def co_portal_employees(request: Request) -> Response:
    # Captured BEFORE the query runs, not after -so a row updated mid-request
    # is still safely covered by the caller's NEXT pull (using this as its
    # updatedSince), rather than possibly falling in the gap between the two.
    as_of = timezone.now()

    qs = Employee.objects.filter(co_emp_enabled=True).select_related(
        "department", "designation", "branch"
    )
    updated_since = request.query_params.get("updatedSince")
    if updated_since:
        try:
            cutoff = datetime.fromisoformat(updated_since.replace("Z", "+00:00"))
            qs = qs.filter(updated_at__gte=cutoff)
        except ValueError:
            return Response({"error": "updatedSince must be an ISO 8601 timestamp"}, status=400)

    return Response({
        "results": [co_portal_employee_json(e) for e in qs.order_by("id")],
        "asOf": as_of.isoformat(),
    })


@api_view(["GET"])
@require_portal_key
def co_portal_attendance_logs(request: Request) -> Response:
    qs = AttendanceLog.objects.filter(employee__co_emp_enabled=True).select_related("employee")
    date_from = request.query_params.get("dateFrom")
    if date_from:
        qs = qs.filter(date__gte=date_from)

    return Response({
        "results": [
            {
                "employeeCode": log.employee.employee_code,
                "date": log.date.isoformat(),
                "punchTime": log.punch_time.isoformat(),
                "punchType": log.punch_type,
                "source": log.source,
            }
            for log in qs.order_by("date", "punch_time")
        ],
    })


@api_view(["GET"])
@require_portal_key
def co_portal_departments(request: Request) -> Response:
    return Response({
        "results": [department_json(d) for d in Department.objects.all().order_by("id")],
    })


@api_view(["GET"])
@require_portal_key
def co_portal_designations(request: Request) -> Response:
    return Response({
        "results": [_designation_json(d) for d in Designation.objects.all().order_by("id")],
    })


@api_view(["GET"])
@require_portal_key
def co_portal_branches(request: Request) -> Response:
    return Response({
        "results": [_branch_json(b) for b in Branch.objects.filter(is_active=True).order_by("id")],
    })
