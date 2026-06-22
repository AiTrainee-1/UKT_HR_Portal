from datetime import datetime

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth
from .models import SalarySlip, Employee, Payroll


def slip_json(s):
    emp = s.employee
    return {
        "id": s.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "departmentName": emp.department.name if emp.department else None,
        "designationTitle": emp.designation.title if emp.designation else None,
        "payrollRunId": s.payroll_run_id,
        "month": s.month,
        "year": s.year,
        "slipNumber": s.slip_number,
        "basic": float(s.basic),
        "hra": float(s.hra),
        "allowances": float(s.allowances),
        "incentives": float(s.incentives),
        "bonuses": float(s.bonuses),
        "otAmount": float(s.ot_amount),
        "grossSalary": float(s.gross_salary),
        "pfDeduction": float(s.pf_deduction),
        "esiDeduction": float(s.esi_deduction),
        "advanceDeduction": float(s.advance_deduction),
        "otherDeductions": float(s.other_deductions),
        "totalDeductions": float(s.total_deductions),
        "netSalary": float(s.net_salary),
        "workingDays": s.working_days,
        "presentDays": float(s.present_days),
        "absentDays": float(s.absent_days),
        "generatedAt": s.generated_at.isoformat() if s.generated_at else None,
        "emailedAt": s.emailed_at.isoformat() if s.emailed_at else None,
    }


@api_view(["GET"])
@require_hr
def salary_slips(request: Request) -> Response:
    emp_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")

    qs = SalarySlip.objects.select_related("employee", "employee__department", "employee__designation").order_by("-year", "-month")
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if month:
        qs = qs.filter(month=month)
    if year:
        qs = qs.filter(year=year)
    return Response([slip_json(s) for s in qs])


@api_view(["POST"])
@require_hr
def generate_salary_slip(request: Request) -> Response:
    data = request.data
    emp_id = data.get("employeeId")
    month = data.get("month")
    year = data.get("year")

    if not all([emp_id, month, year]):
        return Response({"error": "employeeId, month, year required"}, status=400)

    try:
        emp = Employee.objects.select_related("department", "designation").get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    if SalarySlip.objects.filter(employee=emp, month=month, year=year).exists():
        return Response({"error": "Salary slip already generated for this period"}, status=400)

    # Pull from Payroll if exists
    payroll = Payroll.objects.filter(employee=emp, month=month, year=year).first()
    if payroll:
        gross = float(payroll.gross_salary)
        deductions = float(payroll.deductions)
        net = float(payroll.final_salary)
        working_days = payroll.total_working_days
        present_days = float(payroll.present_days)
        absent_days = float(payroll.absent_days)
    else:
        gross = float(emp.salary_amount or 0)
        deductions = 0
        net = gross
        working_days = 26
        present_days = 26
        absent_days = 0

    # Calculate standard components
    basic = round(gross * 0.5, 2)
    hra = round(gross * 0.2, 2)
    allowances = round(gross - basic - hra, 2)
    pf = round(basic * 0.12, 2)

    now = datetime.utcnow()
    slip_number = f"SS/{emp.employee_code}/{year}/{str(month).zfill(2)}"

    slip = SalarySlip.objects.create(
        employee=emp,
        month=month,
        year=year,
        slip_number=slip_number,
        basic=basic,
        hra=hra,
        allowances=allowances,
        gross_salary=gross,
        pf_deduction=pf,
        total_deductions=pf,
        net_salary=gross - pf,
        working_days=working_days,
        present_days=present_days,
        absent_days=absent_days,
    )
    return Response(slip_json(slip), status=201)


@api_view(["GET"])
@require_auth
def employee_salary_slips(request: Request) -> Response:
    """Allow employees to view their own salary slips."""
    emp_id = request.jwt_user.get("employeeId")
    if not emp_id:
        return Response({"error": "Employee access required"}, status=403)
    qs = SalarySlip.objects.select_related("employee", "employee__department", "employee__designation").filter(
        employee_id=emp_id
    ).order_by("-year", "-month")
    return Response([slip_json(s) for s in qs])
