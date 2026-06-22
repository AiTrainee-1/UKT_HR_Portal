import csv
import io
from datetime import date

from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import Employee, Attendance, AttendanceLog, LeaveRequest, Payroll, Department, Branch


def _csv_response(filename: str, headers: list[str], rows: list[list]) -> HttpResponse:
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    writer = csv.writer(response)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return response


@api_view(["GET"])
@require_hr
def attendance_report(request: Request):
    date_from = request.query_params.get("dateFrom")
    date_to = request.query_params.get("dateTo")
    dept_id = request.query_params.get("departmentId")
    fmt = request.query_params.get("format", "json")

    qs = AttendanceLog.objects.select_related("employee", "employee__department").order_by("date", "employee__employee_code")
    if date_from:
        qs = qs.filter(date__gte=date_from)
    if date_to:
        qs = qs.filter(date__lte=date_to)
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)

    if fmt == "csv":
        rows = [
            [
                log.date, log.employee.employee_code,
                f"{log.employee.first_name} {log.employee.last_name}",
                log.employee.department.name if log.employee.department else "",
                log.punch_type, log.punch_time.strftime("%H:%M"),
            ]
            for log in qs
        ]
        return _csv_response(
            "attendance_report.csv",
            ["Date", "Employee Code", "Employee Name", "Department", "Punch Type", "Punch Time"],
            rows,
        )

    data = [
        {
            "date": log.date.isoformat(),
            "employeeCode": log.employee.employee_code,
            "employeeName": f"{log.employee.first_name} {log.employee.last_name}",
            "department": log.employee.department.name if log.employee.department else None,
            "punchType": log.punch_type,
            "punchTime": log.punch_time.strftime("%H:%M"),
        }
        for log in qs[:1000]
    ]
    return Response({"count": qs.count(), "results": data})


@api_view(["GET"])
@require_hr
def leave_report(request: Request):
    year = request.query_params.get("year", date.today().year)
    dept_id = request.query_params.get("departmentId")
    fmt = request.query_params.get("format", "json")

    qs = LeaveRequest.objects.select_related("employee", "employee__department").filter(
        start_date__startswith=str(year)
    ).order_by("start_date")
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)

    if fmt == "csv":
        rows = [
            [
                lr.employee.employee_code,
                f"{lr.employee.first_name} {lr.employee.last_name}",
                lr.employee.department.name if lr.employee.department else "",
                lr.type, lr.start_date, lr.end_date, lr.status,
            ]
            for lr in qs
        ]
        return _csv_response(
            "leave_report.csv",
            ["Employee Code", "Employee Name", "Department", "Leave Type", "Start Date", "End Date", "Status"],
            rows,
        )

    data = [
        {
            "employeeCode": lr.employee.employee_code,
            "employeeName": f"{lr.employee.first_name} {lr.employee.last_name}",
            "department": lr.employee.department.name if lr.employee.department else None,
            "leaveType": lr.type,
            "startDate": lr.start_date,
            "endDate": lr.end_date,
            "status": lr.status,
        }
        for lr in qs
    ]
    return Response({"count": len(data), "results": data})


@api_view(["GET"])
@require_hr
def payroll_report(request: Request):
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    dept_id = request.query_params.get("departmentId")
    fmt = request.query_params.get("format", "json")

    qs = Payroll.objects.select_related("employee", "employee__department").order_by("employee__employee_code")
    if month:
        qs = qs.filter(month=month)
    if year:
        qs = qs.filter(year=year)
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)

    if fmt == "csv":
        rows = [
            [
                p.employee.employee_code,
                f"{p.employee.first_name} {p.employee.last_name}",
                p.employee.department.name if p.employee.department else "",
                p.month, p.year, float(p.base_salary), float(p.gross_salary),
                float(p.deductions), float(p.final_salary), p.status,
            ]
            for p in qs
        ]
        return _csv_response(
            "payroll_report.csv",
            ["Employee Code", "Employee Name", "Department", "Month", "Year",
             "Base Salary", "Gross Salary", "Deductions", "Net Salary", "Status"],
            rows,
        )

    data = [
        {
            "employeeCode": p.employee.employee_code,
            "employeeName": f"{p.employee.first_name} {p.employee.last_name}",
            "department": p.employee.department.name if p.employee.department else None,
            "month": p.month,
            "year": p.year,
            "baseSalary": float(p.base_salary),
            "grossSalary": float(p.gross_salary),
            "deductions": float(p.deductions),
            "netSalary": float(p.final_salary),
            "status": p.status,
        }
        for p in qs
    ]
    return Response({"count": len(data), "results": data})


@api_view(["GET"])
@require_hr
def employee_report(request: Request):
    dept_id = request.query_params.get("departmentId")
    branch_id = request.query_params.get("branchId")
    employment_type = request.query_params.get("employmentType")
    emp_status = request.query_params.get("status", "active")
    fmt = request.query_params.get("format", "json")

    qs = Employee.objects.select_related("department", "designation", "branch").filter(status=emp_status)
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    if employment_type:
        qs = qs.filter(employment_type=employment_type)

    if fmt == "csv":
        rows = [
            [
                e.employee_code, e.first_name, e.last_name, e.gender or "",
                e.department.name if e.department else "",
                e.designation.title if e.designation else "",
                e.branch.name if e.branch else "",
                e.phone or "", e.email or "", e.join_date or "",
                e.employment_type, e.salary_type, float(e.salary_amount or 0), e.status,
            ]
            for e in qs
        ]
        return _csv_response(
            "employee_report.csv",
            ["Employee Code", "First Name", "Last Name", "Gender", "Department",
             "Designation", "Branch", "Phone", "Email", "Join Date",
             "Employment Type", "Salary Type", "Salary Amount", "Status"],
            rows,
        )

    data = [
        {
            "employeeCode": e.employee_code,
            "name": f"{e.first_name} {e.last_name}",
            "gender": e.gender,
            "department": e.department.name if e.department else None,
            "designation": e.designation.title if e.designation else None,
            "branch": e.branch.name if e.branch else None,
            "phone": e.phone,
            "email": e.email,
            "joinDate": e.join_date,
            "employmentType": e.employment_type,
            "salaryType": e.salary_type,
            "salaryAmount": float(e.salary_amount or 0),
            "status": e.status,
        }
        for e in qs
    ]
    return Response({"count": len(data), "results": data})
