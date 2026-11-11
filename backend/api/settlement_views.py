import math
from decimal import Decimal, InvalidOperation

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, hr_access, whatsapp_approvals
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name, is_hr
from .clock import ist_today
from .models import Advance, AdvanceRepayment, Employee
from .payroll_insights import inr
from .view_common import paginate


MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _auto_create_repayments(adv: Advance) -> None:
    """Auto-generate repayment schedule when an advance is approved."""
    # Remove any unprocessed scheduled repayments before regenerating
    adv.repayments.filter(is_processed=False).delete()

    start_month = adv.repayment_start_month or ist_today().month
    start_year = adv.repayment_start_year or ist_today().year

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

    # Term advance -generate monthly EMI schedule
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
        "employeeBranchId": emp.branch_id,
        "employeeBranch": emp.branch.name if emp.branch_id else None,
        "employeeType": emp.employment_type,
        "employeeStatus": emp.status,
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
        # Additive (2026-10-31, employee self-service): what the employee asked for (null on an advance HR recorded),
        # the monthly salary the 60 % Salary Advance limit was taken from, and who raised it ("hr" | "employee").
        # `amount` stays the APPROVED amount.
        "requestedAmount": float(a.requested_amount) if a.requested_amount is not None else None,
        "salaryAtRequest": float(a.salary_at_request) if a.salary_at_request is not None else None,
        "appliedBy": a.applied_by or Advance.APPLIED_BY_HR,
        "approval": approval.progress("advance", a),
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
            .select_related("employee", "employee__department", "employee__designation", "employee__branch")
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
        return paginate(request, qs, advance_json)

    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    # POST -create new advance
    data = request.data
    if not data.get("employeeId") or not data.get("amount") or not data.get("advanceType"):
        return Response({"error": "employeeId, amount, advanceType are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=data["employeeId"])
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    try:
        approval.require_enabled("advance")  # HR can switch new advances off in Approval Workflow Control
    except approval.ApprovalError as exc:
        return approval.refusal(exc)

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


MAX_ADVANCE_AMOUNT = Decimal("99999999.99")  # Advance.amount: max_digits=10, decimal_places=2
MAX_EMPLOYEE_TERM_MONTHS = 12  # the owner's 1-12 months for a Term Loan an employee applied for


def whole_rupee_emi(amount, months: int) -> Decimal:
    """The EMI of a Term Loan an employee applied for: amount / months rounded UP to whole rupees. The schedule then ends
    with a smaller last EMI that absorbs the remainder (_auto_create_repayments pays min(emi, remaining) each month),
    so the whole amount is scheduled: 10,000 over 3 months = 3,334 + 3,334 + 3,332."""
    if not months or months <= 0:
        return Decimal("0")
    return Decimal(math.ceil(Decimal(str(amount)) / months))


def _int_or_none(value):
    try:
        if isinstance(value, bool):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _apply_amount_and_start(adv: Advance, data, previous_status: str) -> str | None:
    """HR's approval may set a smaller `amount` (the approved amount) and a different first deduction month. Applies them
    to `adv` in memory (the caller saves) and keeps the EMI in line; returns the refusal message, or None when fine.

    * The amount can change only while the advance is waiting (it is what the schedule is built from), may not go above
      what the employee asked for (`requested_amount`), and must be more than 0.
    * A Term Loan the employee applied for keeps the whole-rupee EMI rule (whole_rupee_emi) and its 1-12 months; one HR
      recorded gets the EMI the create call would have worked out (amount / months to the paisa).
    * The start month must be 1-12 and the year 2000-2100."""
    if "repaymentStartMonth" in data and data.get("repaymentStartMonth") not in (None, ""):
        month = _int_or_none(data.get("repaymentStartMonth"))
        if month is None or not 1 <= month <= 12:
            return "The first deduction month must be 1 to 12."
        adv.repayment_start_month = month
    if "repaymentStartYear" in data and data.get("repaymentStartYear") not in (None, ""):
        year = _int_or_none(data.get("repaymentStartYear"))
        if year is None or not 2000 <= year <= 2100:
            return "The first deduction year must be a 4-digit year."
        adv.repayment_start_year = year

    amount_changed = False
    if "amount" in data:
        try:
            amount = Decimal(str(data.get("amount")))
        except (InvalidOperation, ValueError):
            return "Enter the approved amount in rupees."
        if not amount.is_finite() or amount <= 0:
            return "The approved amount must be more than 0."
        if amount != amount.quantize(Decimal("0.01")):
            return "Use at most 2 decimal places for the approved amount."
        if amount > MAX_ADVANCE_AMOUNT:
            return "That amount is too large."
        if amount != Decimal(adv.amount):
            if previous_status != Advance.STATUS_PENDING:
                return "The amount can only be changed while the advance is waiting for approval."
            if adv.requested_amount is not None and amount > Decimal(adv.requested_amount):
                return (
                    f"The approved amount cannot be more than the {inr(adv.requested_amount)} the employee asked for."
                )
            adv.amount = amount
            adv.outstanding = max(Decimal("0"), amount - Decimal(adv.total_repaid or 0))
            amount_changed = True

    by_employee = adv.applied_by == Advance.APPLIED_BY_EMPLOYEE
    months_changed = "repaymentMonths" in data
    if adv.advance_type == "term" and months_changed and by_employee:
        months = _int_or_none(adv.repayment_months)
        if months is None or not 1 <= months <= MAX_EMPLOYEE_TERM_MONTHS:
            return f"A Term Loan is repaid in 1 to {MAX_EMPLOYEE_TERM_MONTHS} months."
        adv.repayment_months = months
    if (
        adv.advance_type == "term"
        and "emiAmount" not in data
        and adv.repayment_months
        and (amount_changed or (months_changed and by_employee))
    ):
        months = int(adv.repayment_months)
        adv.emi_amount = (
            whole_rupee_emi(adv.amount, months) if by_employee else round(Decimal(adv.amount) / months, 2)
        )
    return None


def _decision_comment(adv: Advance) -> str | None:
    """HR's note on the approval, led by the approved amount when it is less than what the employee asked for."""
    parts = []
    if adv.requested_amount is not None and Decimal(adv.amount) < Decimal(adv.requested_amount):
        parts.append(f"Approved {inr(adv.amount)} of the {inr(adv.requested_amount)} you asked for.")
    if adv.notes:
        parts.append(adv.notes.strip())
    return " ".join(p for p in parts if p) or None


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def advance_detail(request: Request, pk: int) -> Response:
    try:
        adv = (
            Advance.objects
            .select_related("employee", "employee__department", "employee__designation", "employee__branch")
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
        previous_status = adv.status
        new_status = data.get("status", previous_status)
        # approving / rejecting, or taking a decision back to pending (closing an advance is a settlement step, an edit)
        deciding = new_status != previous_status and (
            new_status in ("approved", "rejected") or (new_status == "pending" and previous_status != "closed")
        )
        if deciding:
            # approving / rejecting an advance is the approval right, not the edit right (hr_access.py)
            if refused := hr_access.approval_refusal(request, "advance"):
                return refused
            if hr_access.out_of_branch(request, adv.employee.branch_id):
                return Response({"error": "Advance not found"}, status=404)
        elif refused := hr_access.decision_only_refusal(request):
            return refused  # an edit by an account that may only decide

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

        # Approving a smaller amount and/or moving the first deduction month (2026-10-31). Validated before anything is
        # saved: a refusal leaves the advance exactly as it was.
        problem = _apply_amount_and_start(adv, data, previous_status)
        if problem:
            return Response({"error": problem, "code": "invalid"}, status=400)

        decided_now = adv.status in ("approved", "rejected") and adv.status != previous_status
        if decided_now and not adv.approved_by and "approvedBy" not in data:
            adv.approved_by = get_hr_display_name(request)  # who decided, for the employee's timeline and the HR list

        if data.get("status") == "approved" and not adv.approved_at:
            adv.approved_at = timezone.now()  # was datetime.utcnow(): same instant, without Django's naive-datetime warning
            adv.save()
            _auto_create_repayments(adv)
            adv.refresh_from_db()
            if previous_status != "approved":
                hr_access.log_decision(request, "advance", adv, "approved", f"advance of {inr(adv.amount)}")
                whatsapp_approvals.notify_decision(
                    "advance", adv, "approved", approver=adv.approved_by or request.jwt_user.get("name", ""),
                    role="hr", comment=_decision_comment(adv),
                )
            return Response(advance_json(adv, include_repayments=True))

        adv.save()
        if adv.status == "rejected" and previous_status != "rejected":
            hr_access.log_decision(request, "advance", adv, "rejected", f"advance of {inr(adv.amount)}")
            whatsapp_approvals.notify_decision(
                "advance", adv, "rejected", approver=adv.approved_by or request.jwt_user.get("name", ""),
                role="hr", comment=adv.notes,
            )
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
            .select_related("employee", "employee__department", "employee__designation", "employee__branch")
            .prefetch_related("repayments")
            .get(pk=pk)
        )
    except Advance.DoesNotExist:
        return Response({"error": "Advance not found"}, status=404)

    reps = adv.repayments.order_by("year", "month", "id")
    return Response([repayment_json(r) for r in reps])
