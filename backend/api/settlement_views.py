import math
from datetime import datetime, date

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id, is_hr
from .models import Advance, AdvanceRepayment, Employee


MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _auto_create_repayments(adv: Advance) -> None:
    """Auto-generate repayment schedule when an advance is approved."""
    # Remove any unprocessed scheduled repayments before regenerating
    adv.repayments.filter(is_processed=False).delete()

    start_month = adv.repayment_start_month or date.today().month
    start_year = adv.repayment_start_year or date.today().year

    if adv.advance_type == "general":
        # Single full-amount deduction in the start month
        AdvanceRepayment.objects.create(
            advance=adv,
            month=start_month,
            year=start_year,
            amount=adv.amount,
            payment_method="payroll",
        )
        return

    # Term advance — generate monthly EMI schedule
    emi = float(adv.emi_amount)
    if emi <= 0:
        return

    total_amount = float(adv.amount)
    months_count = adv.repayment_months or math.ceil(total_amount / emi)

    remaining = total_amount
    m, y = start_month, start_year
    for _ in range(months_count):
        if remaining <= 0:
            break
        pay_amount = min(emi, remaining)
        AdvanceRepayment.objects.create(
            advance=adv,
            month=m,
            year=y,
            amount=round(pay_amount, 2),
            payment_method="payroll",
        )
        remaining -= pay_amount
        m += 1
        if m > 12:
            m = 1
            y += 1


def advance_json(a: Advance, include_repayments: bool = False) -> dict:
    emp = a.employee
    data = {
        "id": a.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "employeeDepartment": emp.department.name if emp.department_id else None,
        "employeeDesignation": emp.designation.title if emp.designation_id else None,
        "employeePhone": emp.phone,
        "employeeEmail": emp.email,
        "advanceType": a.advance_type,
        "amount": float(a.amount),
        "purpose": a.purpose,
        "status": a.status,
        "approvedBy": a.approved_by,
        "approvedAt": a.approved_at.isoformat() if a.approved_at else None,
        "disbursedAt": a.disbursed_at.isoformat() if a.disbursed_at else None,
        "repaymentStartMonth": a.repayment_start_month,
        "repaymentStartYear": a.repayment_start_year,
        "repaymentMonths": a.repayment_months,
        "emiAmount": float(a.emi_amount),
        "totalRepaid": float(a.total_repaid),
        "outstanding": float(a.outstanding),
        "notes": a.notes,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
        "updatedAt": a.updated_at.isoformat() if a.updated_at else None,
    }
    if include_repayments:
        data["repayments"] = [repayment_json(r) for r in a.repayments.order_by("year", "month", "id")]
    return data


def repayment_json(r: AdvanceRepayment) -> dict:
    return {
        "id": r.id,
        "advanceId": r.advance_id,
        "month": r.month,
        "year": r.year,
        "amount": float(r.amount),
        "paymentMethod": r.payment_method,
        "isProcessed": r.is_processed,
        "payrollRunId": r.payroll_run_id,
        "notes": r.notes,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


@api_view(["GET", "POST"])
@require_auth
def advances(request: Request) -> Response:
    if request.method == "GET":
        emp_id = request.query_params.get("employeeId")
        # Employees can only view their own advances
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            emp_id = str(token_emp_id)
        advance_type = request.query_params.get("advanceType")
        adv_status = request.query_params.get("status")
        qs = (
            Advance.objects
            .select_related("employee", "employee__department", "employee__designation")
            .prefetch_related("repayments")
            .order_by("-created_at")
        )
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if advance_type:
            qs = qs.filter(advance_type=advance_type)
        if adv_status:
            if adv_status == "active":
                qs = qs.filter(status="approved")
            else:
                qs = qs.filter(status=adv_status)
        return Response([advance_json(a) for a in qs])

    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    # POST — create new advance
    data = request.data
    if not data.get("employeeId") or not data.get("amount") or not data.get("advanceType"):
        return Response({"error": "employeeId, amount, advanceType are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=data["employeeId"])
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    amount = float(data["amount"])
    repayment_months = int(data["repaymentMonths"]) if data.get("repaymentMonths") else None
    emi = float(data.get("emiAmount", 0))

    # Auto-calculate EMI from months if only months provided
    if repayment_months and not emi:
        emi = round(amount / repayment_months, 2)

    adv = Advance.objects.create(
        employee=emp,
        advance_type=data["advanceType"],
        amount=amount,
        purpose=data.get("purpose"),
        emi_amount=emi,
        repayment_months=repayment_months,
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
        adv = (
            Advance.objects
            .select_related("employee", "employee__department", "employee__designation")
            .prefetch_related("repayments")
            .get(pk=pk)
        )
    except Advance.DoesNotExist:
        return Response({"error": "Advance not found"}, status=404)

    if request.method == "GET":
        return Response(advance_json(adv, include_repayments=True))

    if request.method == "PUT":
        data = request.data
        was_approved = adv.status == "approved"

        for field, attr in [
            ("status", "status"),
            ("approvedBy", "approved_by"),
            ("notes", "notes"),
            ("emiAmount", "emi_amount"),
            ("repaymentMonths", "repayment_months"),
            ("repaymentStartMonth", "repayment_start_month"),
            ("repaymentStartYear", "repayment_start_year"),
        ]:
            if field in data:
                setattr(adv, attr, data[field])

        if data.get("status") == "approved" and not adv.approved_at:
            adv.approved_at = datetime.utcnow()
            adv.save()
            _auto_create_repayments(adv)
            adv.refresh_from_db()
            return Response(advance_json(adv, include_repayments=True))

        adv.save()
        return Response(advance_json(adv, include_repayments=was_approved))

    # DELETE
    adv.delete()
    return Response(status=204)


@api_view(["GET"])
@require_hr
def advance_repayments(request: Request, pk: int) -> Response:
    try:
        adv = (
            Advance.objects
            .select_related("employee", "employee__department", "employee__designation")
            .prefetch_related("repayments")
            .get(pk=pk)
        )
    except Advance.DoesNotExist:
        return Response({"error": "Advance not found"}, status=404)

    reps = adv.repayments.order_by("year", "month", "id")
    return Response([repayment_json(r) for r in reps])
