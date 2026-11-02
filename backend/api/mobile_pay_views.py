"""
The mobile app's Salary and Compensation pages (2026-10-31 mobile pages round). Employee token only, the signed-in
employee's own data only, READ-ONLY.

    GET /api/my/salary-insights?year=YYYY        allocated vs earned vs payable for every pay period of the year
    GET /api/my/salary-slips/<id>/breakdown      one slip as a waterfall (404 when it is not the employee's own)
    GET /api/my/compensation-history?year=YYYY   every compensation of the year (staff only)

What each figure is and where payroll stored it: mobile_pay.py and mobile_pay_compensation.py.
"""

from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, require_auth
from .clock import ist_today
from .mobile_pay import breakdown_for, insights_for
from .mobile_pay_compensation import history_for
from .models import Employee, SalarySlip

MIN_YEAR, MAX_YEAR = 2000, 2100


def _employee(request: Request):
    """(employee, None) for an employee token, else (None, the refusal). There is no "view as": an HR token is refused."""
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None, Response({"error": "Please sign in as an employee to see this."}, status=403)
    emp = Employee.objects.filter(pk=emp_id).first()
    if emp is None:
        return None, Response({"error": "Employee not found"}, status=404)
    return emp, None


def _year(request: Request, default: int):
    """(year, None) or (None, a 400). No `year` = `default`."""
    raw = (request.query_params.get("year") or "").strip()
    if not raw:
        return default, None
    if not raw.isdigit() or not (MIN_YEAR <= int(raw) <= MAX_YEAR):
        return None, Response({"error": "year must be a year like 2026"}, status=400)
    return int(raw), None


@api_view(["GET"])
@require_auth
def my_salary_insights(request: Request) -> Response:
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    latest = SalarySlip.objects.filter(employee=emp).order_by("-year").values_list("year", flat=True).first()
    year, refusal = _year(request, latest or ist_today().year)
    if refusal is not None:
        return refusal
    return Response(insights_for(emp, year))


@api_view(["GET"])
@require_auth
def my_salary_slip_breakdown(request: Request, pk: int) -> Response:
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    slip = SalarySlip.objects.select_related("employee").filter(pk=pk, employee=emp).first()
    if slip is None:
        return Response({"error": "Salary slip not found"}, status=404)
    return Response(breakdown_for(slip))


@api_view(["GET"])
@require_auth
def my_compensation_history(request: Request) -> Response:
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    today = ist_today()
    year, refusal = _year(request, today.year)
    if refusal is not None:
        return refusal
    return Response(history_for(emp, year, today))
