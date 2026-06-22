from datetime import datetime

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import Advance, AdvanceRepayment, Employee


def advance_json(a):
    emp = a.employee
    return {
        "id": a.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "advanceType": a.advance_type,
        "amount": float(a.amount),
        "purpose": a.purpose,
        "status": a.status,
        "approvedBy": a.approved_by,
        "approvedAt": a.approved_at.isoformat() if a.approved_at else None,
        "disbursedAt": a.disbursed_at.isoformat() if a.disbursed_at else None,
        "repaymentStartMonth": a.repayment_start_month,
        "repaymentStartYear": a.repayment_start_year,
        "emiAmount": float(a.emi_amount),
        "totalRepaid": float(a.total_repaid),
        "outstanding": float(a.outstanding),
        "notes": a.notes,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


def repayment_json(r):
    return {
        "id": r.id,
        "advanceId": r.advance_id,
        "month": r.month,
        "year": r.year,
        "amount": float(r.amount),
        "payrollRunId": r.payroll_run_id,
        "notes": r.notes,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


@api_view(["GET", "POST"])
@require_hr
def advances(request: Request) -> Response:
    if request.method == "GET":
        emp_id = request.query_params.get("employeeId")
        advance_type = request.query_params.get("advanceType")
        adv_status = request.query_params.get("status")
        qs = Advance.objects.select_related("employee").order_by("-created_at")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if advance_type:
            qs = qs.filter(advance_type=advance_type)
        if adv_status:
            qs = qs.filter(status=adv_status)
        return Response([advance_json(a) for a in qs])

    data = request.data
    if not data.get("employeeId") or not data.get("amount") or not data.get("advanceType"):
        return Response({"error": "employeeId, amount, advanceType are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=data["employeeId"])
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    amount = float(data["amount"])
    emi = float(data.get("emiAmount", 0))

    adv = Advance.objects.create(
        employee=emp,
        advance_type=data["advanceType"],
        amount=amount,
        purpose=data.get("purpose"),
        emi_amount=emi,
        outstanding=amount,
        repayment_start_month=data.get("repaymentStartMonth"),
        repayment_start_year=data.get("repaymentStartYear"),
        notes=data.get("notes"),
    )
    return Response(advance_json(adv), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def advance_detail(request: Request, pk: int) -> Response:
    try:
        adv = Advance.objects.select_related("employee").get(pk=pk)
    except Advance.DoesNotExist:
        return Response({"error": "Advance not found"}, status=404)

    if request.method == "GET":
        return Response(advance_json(adv))

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("status", "status"), ("approvedBy", "approved_by"), ("notes", "notes"),
            ("emiAmount", "emi_amount"), ("repaymentStartMonth", "repayment_start_month"),
            ("repaymentStartYear", "repayment_start_year"),
        ]:
            if field in data:
                setattr(adv, attr, data[field])
        if data.get("status") == "approved" and not adv.approved_at:
            adv.approved_at = datetime.utcnow()
        adv.save()
        return Response(advance_json(adv))

    adv.delete()
    return Response(status=204)


@api_view(["GET", "POST"])
@require_hr
def advance_repayments(request: Request, pk: int) -> Response:
    try:
        adv = Advance.objects.get(pk=pk)
    except Advance.DoesNotExist:
        return Response({"error": "Advance not found"}, status=404)

    if request.method == "GET":
        reps = AdvanceRepayment.objects.filter(advance=adv).order_by("-year", "-month")
        return Response([repayment_json(r) for r in reps])

    data = request.data
    month = data.get("month")
    year = data.get("year")
    amount = float(data.get("amount", 0))
    if not month or not year or not amount:
        return Response({"error": "month, year, amount required"}, status=400)

    rep = AdvanceRepayment.objects.create(
        advance=adv, month=month, year=year, amount=amount, notes=data.get("notes")
    )
    adv.total_repaid = float(adv.total_repaid) + amount
    adv.outstanding = max(0, float(adv.amount) - float(adv.total_repaid))
    if adv.outstanding == 0:
        adv.status = "closed"
    adv.save()
    return Response(repayment_json(rep), status=201)
