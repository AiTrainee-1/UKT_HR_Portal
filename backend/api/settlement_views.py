import math
from decimal import Decimal, InvalidOperation

from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import advance_earnings, approval_workflow as approval, hr_access, whatsapp_approvals
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name, is_hr
from .clock import ist_today
from .models import Advance, AdvanceDecision, AdvanceRepayment, Employee
from .payroll_insights import inr
from .view_common import paginate


TYPE_LABELS = {"general": "Salary Advance", "term": "Term Loan"}  # renamed 2026-11-26 ("General" / "Term Advance")

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
        # HR's remark on the decision (mandatory on a rejection and on a different approved amount) and when it was
        # decided (2026-11-20); the months of the deduction schedule ("2026-11"), for the page's month filter.
        "decisionRemark": a.decision_remark or "",
        "decidedAt": a.decided_at.isoformat() if a.decided_at else None,
        "scheduleMonths": sorted({f"{r.year:04d}-{r.month:02d}" for r in a.repayments.all()}),
        # additive (2026-11-26): the salary earned from the 1st to the 20th of the month it was raised in (Fixed Salary,
        # Working Days, Working Salary = Earned Amount, the 50 % Salary Advance limit); null for a production employee.
        # `limitRemark`: why HR recorded a Salary Advance above that limit.
        "typeLabel": TYPE_LABELS.get(a.advance_type, "Advance"),
        "earnings": advance_earnings.earnings_json(a),
        "limitRemark": a.limit_remark or "",
    }
    if include_repayments:
        data["repayments"] = [repayment_json(r) for r in a.repayments.order_by("year", "month", "id")]
        data["history"] = [decision_json(d) for d in a.decisions.all()]
    return data


def decision_json(d: AdvanceDecision) -> dict:
    return {
        "id": d.id,
        "action": d.action,
        "requestedAmount": float(d.requested_amount) if d.requested_amount is not None else None,
        "approvedAmount": float(d.approved_amount) if d.approved_amount is not None else None,
        "startMonth": d.start_month,
        "startYear": d.start_year,
        "remark": d.remark,
        "by": d.actor_name,
        "at": d.at.isoformat() if d.at else None,
    }


REMARK_MIN = 3


def clean_remark(data) -> str:
    """HR's decision remark from a PUT body: `decisionRemark` (the Settlement page), `remark`, or `notes` (what older
    clients sent the reason in)."""
    return " ".join(str(data.get("decisionRemark") or data.get("remark") or data.get("notes") or "").split())[:1000]


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
        # the salary earned in the 1st-20th (2026-11-26): worked out once for advances that do not have it yet (and again
        # for a waiting one asked for before its month's 20th was over); later reads use what is kept
        advance_earnings.fill_missing(
            qs.filter(Q(earned_on__isnull=True) | Q(status="pending"))[: advance_earnings.FILL_PER_READ * 2]
        )
        return paginate(request, qs, advance_json)

    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    # POST -create new advance
    data = request.data
    if not data.get("employeeId") or not data.get("amount") or not data.get("advanceType"):
        return Response({"error": "employeeId, amount, advanceType are required"}, status=400)
    if data["advanceType"] not in TYPE_LABELS:
        return Response({"error": "advanceType must be general (Salary Advance) or term (Term Loan)"}, status=400)

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

    # Salary Advance limit (owner 2026-11-26): 50 % of the salary earned in the 1st-20th of this month. Employees can never
    # ask for more; HR may record more, with a remark saying why.
    today = ist_today()
    earnings = advance_earnings.earned_in_month(emp, today.month, today.year)
    limit_remark = " ".join(str(data.get("limitRemark") or "").split())[:1000]
    if data["advanceType"] == "general" and earnings is not None and Decimal(str(amount)) > earnings.limit:
        if len(limit_remark) < REMARK_MIN:
            return Response(
                {
                    "error": f"{inr(amount)} is above the Salary Advance limit of {inr(earnings.limit)} (50% of "
                    f"{inr(earnings.earned)} earned from the 1st to the 20th). Write a remark to record it anyway.",
                    "code": "over_limit",
                    "limit": float(earnings.limit),
                },
                status=400,
            )
    else:
        limit_remark = ""
    emi = float(data.get("emiAmount", 0))

    # Auto-calculate EMI from months if only months provided
    if repayment_months and not emi:
        emi = round(amount / repayment_months, 2)

    adv = Advance.objects.create(
        employee=emp,
        advance_type=data["advanceType"],
        amount=amount,
        requested_amount=amount,  # what was asked for, kept for audit when a smaller amount is approved (2026-11-20)
        purpose=data.get("purpose"),
        emi_amount=emi,
        repayment_months=repayment_months,
        outstanding=amount,
        repayment_start_month=data.get("repaymentStartMonth"),
        repayment_start_year=data.get("repaymentStartYear"),
        notes=data.get("notes"),
        limit_remark=limit_remark,
    )
    advance_earnings.store(adv, earnings, today)
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
    if adv.decision_remark:
        parts.append(adv.decision_remark.strip())
    elif adv.notes:
        parts.append(adv.notes.strip())
    return " ".join(p for p in parts if p) or None


def _record_decision(adv: Advance, action: str, requested: Decimal, remark: str, request: Request) -> None:
    approved = action == AdvanceDecision.ACTION_APPROVED
    AdvanceDecision.objects.create(
        advance=adv,
        action=action,
        requested_amount=requested,
        approved_amount=adv.amount if approved else None,
        start_month=adv.repayment_start_month if approved else None,
        start_year=adv.repayment_start_year if approved else None,
        remark=remark,
        actor_name=adv.approved_by or get_hr_display_name(request),
    )


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
            # approving / rejecting an advance is the approval right of its type (general / term), not the edit right
            if refused := hr_access.approval_refusal(request, hr_access.kind_for("advance", adv)):
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

        # The amount asked for is kept for audit: an advance HR recorded before 2026-11-20 has none stored, so its
        # amount before this decision is it (and the approved amount can then never go above it).
        amount_before = Decimal(adv.amount)
        if deciding and adv.status == "approved" and adv.requested_amount is None:
            adv.requested_amount = amount_before

        # Approving a smaller amount and/or moving the first deduction month (2026-10-31). Validated before anything is
        # saved: a refusal leaves the advance exactly as it was.
        problem = _apply_amount_and_start(adv, data, previous_status)
        if problem:
            return Response({"error": problem, "code": "invalid"}, status=400)

        # Remarks (owner 2026-11-20): a rejection always needs one, an approval of another amount than was asked for too.
        remark = clean_remark(data)
        if deciding and adv.status == "rejected" and len(remark) < REMARK_MIN:
            return Response(
                {"error": "Write the reason for rejecting (at least 3 characters).", "code": "remark"}, status=400
            )
        requested = Decimal(adv.requested_amount) if adv.requested_amount is not None else amount_before
        if deciding and adv.status == "approved" and Decimal(adv.amount) != requested and len(remark) < REMARK_MIN:
            return Response(
                {
                    "error": f"Write a remark: you are approving {inr(adv.amount)} of the {inr(requested)} asked for.",
                    "code": "remark",
                },
                status=400,
            )
        if deciding:
            adv.decision_remark = remark
            adv.decided_at = timezone.now()

        decided_now = adv.status in ("approved", "rejected") and adv.status != previous_status
        if decided_now and not adv.approved_by and "approvedBy" not in data:
            adv.approved_by = get_hr_display_name(request)  # who decided, for the employee's timeline and the HR list

        if data.get("status") == "approved" and not adv.approved_at:
            adv.approved_at = timezone.now()  # was datetime.utcnow(): same instant, without Django's naive-datetime warning
            adv.save()
            _auto_create_repayments(adv)
            adv.refresh_from_db()
            if deciding:
                advance_earnings.refresh(adv)  # the 1st-20th salary as it stands when HR decides (2026-11-26)
                _record_decision(adv, AdvanceDecision.ACTION_APPROVED, requested, remark, request)
            if previous_status != "approved":
                hr_access.log_decision(
                    request, hr_access.kind_for("advance", adv), adv, "approved", f"advance of {inr(adv.amount)}"
                )
                whatsapp_approvals.notify_decision(
                    "advance", adv, "approved", approver=adv.approved_by or request.jwt_user.get("name", ""),
                    role="hr", comment=_decision_comment(adv),
                )
            return Response(advance_json(adv, include_repayments=True))

        adv.save()
        if deciding:
            advance_earnings.refresh(adv)  # the 1st-20th salary as it stands when HR decides (2026-11-26)
            action = {
                "approved": AdvanceDecision.ACTION_APPROVED,
                "rejected": AdvanceDecision.ACTION_REJECTED,
            }.get(adv.status, AdvanceDecision.ACTION_REOPENED)
            _record_decision(adv, action, requested, remark, request)
        if adv.status == "rejected" and previous_status != "rejected":
            hr_access.log_decision(
                request, hr_access.kind_for("advance", adv), adv, "rejected", f"advance of {inr(adv.amount)}"
            )
            whatsapp_approvals.notify_decision(
                "advance", adv, "rejected", approver=adv.approved_by or request.jwt_user.get("name", ""),
                role="hr", comment=adv.decision_remark or adv.notes,
            )
        return Response(advance_json(adv, include_repayments=was_approved))

    # DELETE: only an advance still waiting for a decision (owner 2026-11-26). An approved / rejected / completed one is
    # history, and an approved one's deductions may already be in a payroll.
    if adv.status != Advance.STATUS_PENDING:
        return Response(
            {
                "error": "Only an advance still waiting for approval can be deleted. Approved, rejected and completed "
                "advances are kept.",
                "code": "not_pending",
                "status": adv.status,
            },
            status=409,
        )
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


@api_view(["GET"])
@require_hr
def advance_earnings_preview(request: Request) -> Response:
    """GET /api/advances/earnings?employeeId=&month=&year= (2026-11-26): the New Salary Advance / Term Loan dialog's
    figures for one employee - the salary earned from the 1st to the 20th (this month unless month/year are given), the
    50 % Salary Advance limit, and the Term Loan's 6-month service check (HR may still record either; it is shown)."""
    try:
        emp = Employee.objects.get(pk=int(request.query_params.get("employeeId") or 0))
    except (Employee.DoesNotExist, ValueError):
        return Response({"error": "Employee not found"}, status=404)
    today = ist_today()
    month = _int_or_none(request.query_params.get("month")) or today.month
    year = _int_or_none(request.query_params.get("year")) or today.year
    if not 1 <= month <= 12 or not 2000 <= year <= 2100:
        return Response({"error": "Invalid month or year"}, status=400)
    earnings = advance_earnings.earned_in_month(emp, month, year)
    no_salary = None
    if earnings is None:
        no_salary = (
            "Paid per shift: there is no monthly fixed salary, so no Salary Advance limit."
            if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF
            else "No monthly salary is recorded for this employee."
        )
    return Response(
        {
            "employeeId": emp.id,
            "employeeType": emp.employment_type,
            "month": month,
            "year": year,
            "throughDay": advance_earnings.EARNED_THROUGH_DAY,
            "percent": advance_earnings.SALARY_ADVANCE_PERCENT,
            "earnings": earnings.to_json() if earnings else None,
            "noSalaryReason": no_salary,
            "termLoanService": advance_earnings.term_loan_service(emp, today),
        }
    )
