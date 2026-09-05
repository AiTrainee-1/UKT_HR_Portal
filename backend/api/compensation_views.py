"""Compensation -read-only CTC breakdown per employee.

Purely a display/reporting feature: computes Basic/HRA/Allowances/Employer
PF/Employer ESI/Annual CTC live from each employee's own salary_amount and
the configurable basic_percent/hra_percent settings (Settings -> Payroll).
Deliberately does NOT touch, read from, or feed back into the actual payroll
generation engine (_generate_staff_payroll/_generate_production_payroll in
payroll_views.py), which keeps its own separate, hardcoded 50/20 split
exactly as it already was -this page can be reconfigured freely without
changing a single real payroll number.
"""
from decimal import Decimal

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Employee
from .user_settings import settings_for_employee


def _d2(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def _compensation_dict(emp: Employee) -> dict:
    settings = settings_for_employee(emp)
    salary = emp.salary_amount or Decimal("0")

    basic = _d2(salary * settings.basic_percent / 100)
    hra = _d2(salary * settings.hra_percent / 100)
    allowances = _d2(salary - basic - hra)

    is_production = emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION
    pf_rate = settings.prod_pf_rate if is_production else settings.pf_rate
    esi_rate = settings.prod_esi_rate if is_production else settings.esi_rate
    esi_ceiling = settings.prod_esi_applicable_below if is_production else settings.esi_applicable_below

    employer_pf = _d2(basic * pf_rate / 100) if pf_rate else Decimal("0.00")
    employer_esi = _d2(salary * esi_rate / 100) if esi_rate and salary <= esi_ceiling else Decimal("0.00")

    gross_monthly = _d2(salary)
    annual_ctc = _d2((gross_monthly + employer_pf + employer_esi) * 12)

    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "branch": emp.branch.name if emp.branch else None,
        "employmentType": emp.employment_type,
        "basic": float(basic),
        "hra": float(hra),
        "allowances": float(allowances),
        "employerPf": float(employer_pf),
        "employerEsi": float(employer_esi),
        "grossMonthly": float(gross_monthly),
        "annualCtc": float(annual_ctc),
    }


@api_view(["GET"])
@require_hr
def compensation_list(request: Request) -> Response:
    qs = scope_to_branch(
        Employee.objects.select_related("department", "designation", "branch"), request
    ).filter(status=request.query_params.get("status") or "active")

    dept_id = request.query_params.get("departmentId")
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    branch_id = request.query_params.get("branchId")
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    employment_type = request.query_params.get("employmentType")
    if employment_type:
        qs = qs.filter(employment_type=employment_type)
    search = (request.query_params.get("search") or "").strip()
    if search:
        from django.db.models import Q
        qs = qs.filter(
            Q(first_name__icontains=search) | Q(last_name__icontains=search) | Q(employee_code__icontains=search)
        )

    rows = [_compensation_dict(emp) for emp in qs.order_by("employee_code")]
    return Response({"results": rows, "count": len(rows)})
