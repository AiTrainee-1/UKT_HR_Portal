"""Employee self-service Salary Advance and Term Loan (owner brief 2026-10-31, the mobile pages round).

Until now only HR could record an advance (Settlement page, POST /api/advances). Employees now apply themselves from the
mobile app, and HR approves on the same Settlement page through the existing "advance" approval workflow (HR only).

Owner's rules, all decided here and nowhere else:
  * Applications are open from the 20th of the month to the month end (factory date, clock.ist_today), for both forms.
  * Salary Advance: at most 60 % of the employee's MONTHLY FIXED salary (`Employee.salary_amount`, the figure the staff
    payroll engine pays). It is deducted in full from THAT month's salary (the month the application is made in).
    No monthly salary on record (production staff are paid per shift) = no Salary Advance.
  * Term Loan: any amount from MIN_TERM_AMOUNT, repaid in 1 to 12 monthly EMIs starting NEXT month. The EMI is the
    amount over the months rounded UP to whole rupees, so the last EMI is the smaller one that absorbs the remainder
    (10,000 over 3 months = 3,334 + 3,334 + 3,332). Nothing is left unscheduled.
  * HR may approve a SMALLER amount and move the first deduction month (settlement_views.advance_detail). `amount` is
    always the APPROVED amount (what is paid and deducted); `requested_amount` keeps what the employee asked for.
  * Duplicates: one Salary Advance per deduction month (unless the earlier one was rejected); no new Term Loan while
    another Term Loan is still waiting for HR.

Payroll is not touched: approval creates the AdvanceRepayment rows (settlement_views._auto_create_repayments) exactly as
for an advance HR records, and payroll deducts them as it always has.

Endpoints (employee token only; an HR token gets 403):
  GET  /api/my/advances/eligibility   window, salary, limit, deduction months, what is already applied, the rules
  GET  /api/my/advances               the employee's own applications with schedule, deductions and timeline
  GET  /api/my/advances/<id>          one of them (404 for anyone else's)
  POST /api/my/advances               {advanceType: "general"|"term", amount, repaymentMonths?, purpose}
"""

import calendar
import math
from datetime import date
from decimal import Decimal, InvalidOperation

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import get_token_employee_id, require_auth
from .clock import FACTORY_TZ, ist_today
from .models import Advance, Employee
from .payroll_insights import inr
from .settlement_views import advance_json, whole_rupee_emi

WORKFLOW = "advance"

WINDOW_OPENS_ON_DAY = 20
SALARY_ADVANCE_PERCENT = 60
MIN_TERM_MONTHS = 1
MAX_TERM_MONTHS = 12
MIN_TERM_AMOUNT = 1000
# Advance.amount is DecimalField(max_digits=10, decimal_places=2).
MAX_AMOUNT = 99_99_999
MIN_PURPOSE = 3
MAX_PURPOSE = 300

TYPE_LABEL = {"general": "Salary Advance", "term": "Term Loan"}
MONTH_NAMES = calendar.month_name  # [""] + "January" ...
MONTH_SHORT = calendar.month_abbr


# ─────────────────────────── the rules (pure) ───────────────────────────


def month_label(month: int | None, year: int | None, short: bool = False) -> str:
    if not month or not year:
        return ""
    return f"{(MONTH_SHORT if short else MONTH_NAMES)[month]} {year}"


def next_month(month: int, year: int) -> tuple[int, int]:
    return (1, year + 1) if month == 12 else (month + 1, year)


def window(today: date) -> dict:
    """The application window of `today`'s month: open from the 20th to the last day."""
    last_day = calendar.monthrange(today.year, today.month)[1]
    opens_on = date(today.year, today.month, WINDOW_OPENS_ON_DAY)
    closes_on = date(today.year, today.month, last_day)
    is_open = today >= opens_on
    nm, ny = next_month(today.month, today.year)
    next_opens_on = date(ny, nm, WINDOW_OPENS_ON_DAY)
    if is_open:
        days_left = (closes_on - today).days + 1  # today included
        message = (
            f"Applications are open until {closes_on.strftime('%d %B')}. "
            f"They open again on {next_opens_on.strftime('%d %B')}."
        )
    else:
        days_left = 0
        message = f"Applications open on {opens_on.strftime('%d %B')} and stay open until the end of the month."
    return {
        "isOpen": is_open,
        "opensOn": opens_on.isoformat(),
        "closesOn": closes_on.isoformat(),
        "nextOpensOn": (next_opens_on if is_open else opens_on).isoformat(),
        "daysUntilOpen": 0 if is_open else (opens_on - today).days,
        "daysLeft": days_left,
        "message": message,
    }


def window_closed_message(today: date) -> str:
    opens_on = date(today.year, today.month, WINDOW_OPENS_ON_DAY)
    return (
        f"Advance and loan applications open on {opens_on.strftime('%d %B')}. "
        "You can apply from the 20th until the end of the month."
    )


def monthly_salary(emp: Employee) -> Decimal | None:
    """The monthly fixed salary the 60 % limit is taken from: `salary_amount`, which the staff payroll pays every month.
    Production employees are paid per shift (`salary_per_shift`), so they have no monthly fixed salary."""
    if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF:
        return None
    s = emp.salary_amount
    return Decimal(s) if s and Decimal(s) > 0 else None


def salary_advance_limit(salary: Decimal) -> Decimal:
    """60 % of the monthly salary, in whole rupees (rounded down)."""
    return Decimal(math.floor(salary * SALARY_ADVANCE_PERCENT / 100))


def term_emi(amount: Decimal, months: int) -> Decimal:
    """The monthly EMI (settlement_views.whole_rupee_emi, the one rule HR's approval uses too)."""
    return whole_rupee_emi(amount, months)


def schedule_plan(advance_type: str, amount: Decimal, months: int | None, start_month: int, start_year: int):
    """The deductions an approval would create: twin of settlement_views._auto_create_repayments for these advances."""
    amount = Decimal(amount)
    if amount <= 0:
        return []
    if advance_type == "general":
        return [(start_month, start_year, amount)]
    months = months or 1
    emi = term_emi(amount, months)
    out, remaining, m, y = [], amount, start_month, start_year
    for _ in range(months):
        if remaining <= 0:
            break
        pay = min(emi, remaining)
        out.append((m, y, pay))
        remaining -= pay
        m, y = next_month(m, y)
    return out


def parse_amount(raw) -> tuple[Decimal | None, str | None]:
    """A whole number of rupees, more than 0. (value, None) or (None, the message)."""
    if raw is None or raw == "" or isinstance(raw, bool):
        return None, "Enter the amount."
    try:
        value = Decimal(str(raw).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None, "Enter the amount in rupees, using numbers only."
    if not value.is_finite() or value <= 0:
        return None, "The amount must be more than ₹0."
    if value != value.to_integral_value():
        return None, "Enter the amount in whole rupees (no paise)."
    if value > MAX_AMOUNT:
        return None, f"The amount cannot be more than {inr(MAX_AMOUNT)}."
    return value, None


def parse_months(raw) -> tuple[int | None, str | None]:
    try:
        months = int(str(raw).strip()) if raw not in (None, "") and not isinstance(raw, bool) else None
    except ValueError:
        months = None
    if months is None or str(months) != str(raw).strip():
        return None, f"Choose how many months to repay in ({MIN_TERM_MONTHS} to {MAX_TERM_MONTHS})."
    if not MIN_TERM_MONTHS <= months <= MAX_TERM_MONTHS:
        return None, f"A Term Loan is repaid in {MIN_TERM_MONTHS} to {MAX_TERM_MONTHS} months."
    return months, None


def _created_in(a: Advance, month: int, year: int) -> bool:
    if not a.created_at:
        return False
    local = a.created_at.astimezone(FACTORY_TZ)
    return (local.month, local.year) == (month, year)


def salary_advance_this_month(emp: Employee, today: date) -> Advance | None:
    """A Salary Advance that already uses this month: deducted this month, or applied for by the employee this month,
    and not rejected. A rejected one never blocks applying again."""
    rows = Advance.objects.filter(employee=emp, advance_type="general").exclude(status="rejected").order_by("-id")
    for a in rows:
        if (a.repayment_start_month, a.repayment_start_year) == (today.month, today.year):
            return a
        if a.applied_by == Advance.APPLIED_BY_EMPLOYEE and _created_in(a, today.month, today.year):
            return a
    return None


def pending_term_loan(emp: Employee) -> Advance | None:
    return Advance.objects.filter(employee=emp, advance_type="term", status="pending").order_by("-id").first()


def rules_text() -> list[str]:
    return [
        f"You can apply from the {WINDOW_OPENS_ON_DAY}th of each month until the month end.",
        f"Salary Advance: up to {SALARY_ADVANCE_PERCENT}% of your monthly fixed salary. "
        "It is deducted in full from that month's salary.",
        f"Term Loan: any amount from {inr(MIN_TERM_AMOUNT)}, repaid in {MIN_TERM_MONTHS} to {MAX_TERM_MONTHS} monthly EMIs "
        "starting from next month's salary.",
        "HR approves every application. HR may approve a smaller amount or change the month deductions start.",
        "One Salary Advance per month. A new Term Loan can be applied for once your earlier one has been decided.",
    ]


# ─────────────────────────── what the phone gets ───────────────────────────


STATUS_LABEL = {
    "pending": "Waiting for HR",
    "approved": "Approved",
    "rejected": "Rejected",
    "closed": "Fully repaid",
}


def my_advance_json(a: Advance, today: date | None = None) -> dict:
    """One application as the employee sees it: advance_json (with the repayment rows) plus the schedule, the money
    figures and a plain-English timeline."""
    today = today or ist_today()
    data = advance_json(a, include_repayments=True)
    requested = a.requested_amount if a.requested_amount is not None else a.amount
    decided = a.status in ("approved", "closed")
    data.update(
        {
            "typeLabel": TYPE_LABEL.get(a.advance_type, "Advance"),
            "statusLabel": STATUS_LABEL.get(a.status, a.status.title()),
            "requestedAmount": float(requested),
            "approvedAmount": float(a.amount) if decided else None,
            "approvedLess": decided and Decimal(a.amount) < Decimal(requested),
        }
    )

    # The schedule: the real repayment rows once approved, else what approval would create (marked as an estimate).
    schedule = []
    now_key = today.year * 12 + today.month
    if decided:
        for r in a.repayments.all():
            key = r.year * 12 + r.month
            state = "deducted" if r.is_processed else ("due" if key <= now_key else "upcoming")
            schedule.append(
                {
                    "month": r.month,
                    "year": r.year,
                    "label": month_label(r.month, r.year, short=True),
                    "amount": float(r.amount),
                    "state": state,
                    "method": r.payment_method,
                }
            )
        schedule.sort(key=lambda s: (s["year"], s["month"]))
    elif a.status == "pending" and a.repayment_start_month and a.repayment_start_year:
        for m, y, amt in schedule_plan(
            a.advance_type, requested, a.repayment_months, a.repayment_start_month, a.repayment_start_year
        ):
            schedule.append(
                {
                    "month": m,
                    "year": y,
                    "label": month_label(m, y, short=True),
                    "amount": float(amt),
                    "state": "planned",
                }
            )
    data["schedule"] = schedule
    data["scheduleIsEstimate"] = a.status == "pending"

    deducted = sum(s["amount"] for s in schedule if s["state"] == "deducted")
    data["deductedTotal"] = round(deducted, 2)
    data["balanceDue"] = float(a.outstanding) if a.status == "approved" else 0.0
    nxt = next((s for s in schedule if s["state"] in ("due", "upcoming")), None)
    data["nextDeduction"] = nxt

    if schedule:
        first, last = schedule[0], schedule[-1]
        if len(schedule) == 1:
            data["deductionLabel"] = month_label(first["month"], first["year"])
        else:
            data["deductionLabel"] = (
                f"{month_label(first['month'], first['year'])} to {month_label(last['month'], last['year'])}"
            )
    else:
        data["deductionLabel"] = (
            month_label(a.repayment_start_month, a.repayment_start_year) if a.status != "rejected" else ""
        )

    data["timeline"] = timeline(a, requested, schedule)
    return data


def timeline(a: Advance, requested: Decimal, schedule: list[dict]) -> list[dict]:
    """What happened, oldest first: applied, HR's decision, each deduction made."""
    events = []
    who = "You" if a.applied_by == Advance.APPLIED_BY_EMPLOYEE else "HR"
    events.append(
        {
            "kind": "applied",
            "at": a.created_at.isoformat() if a.created_at else None,
            "title": "Applied" if who == "You" else "Recorded by HR",
            "text": f"{who} asked for {inr(requested)}"
            + (f" over {a.repayment_months} months" if a.advance_type == "term" and a.repayment_months else "")
            + ".",
        }
    )
    if a.status in ("approved", "closed"):
        text = f"Approved {inr(a.amount)}"
        if Decimal(a.amount) < Decimal(requested):
            text += f" of the {inr(requested)} asked for"
        text += "."
        events.append(
            {
                "kind": "approved",
                "at": a.approved_at.isoformat() if a.approved_at else None,
                "title": "Approved by HR",
                "by": a.approved_by,
                "text": text,
                "comment": a.notes or None,
            }
        )
    elif a.status == "rejected":
        events.append(
            {
                "kind": "rejected",
                "at": a.updated_at.isoformat() if a.updated_at else None,
                "title": "Rejected by HR",
                "by": a.approved_by,
                "text": "Nothing will be deducted from your salary.",
                "comment": a.notes or None,
            }
        )
    else:
        events.append({"kind": "waiting", "at": None, "title": "Waiting for HR", "text": "HR has not decided yet."})
    for s in schedule:
        if s["state"] == "deducted":
            events.append(
                {
                    "kind": "deducted",
                    "at": None,
                    "title": f"Deducted from {s['label']} salary",
                    "text": f"{inr(s['amount'])} recovered.",
                }
            )
    if a.status == "closed":
        events.append({"kind": "closed", "at": None, "title": "Fully repaid", "text": "Nothing more is owed."})
    return events


# ─────────────────────────── endpoints ───────────────────────────


def _employee(request: Request) -> tuple[Employee | None, Response | None]:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None, Response(
            {
                "error": "Only employees can apply here. HR records advances on the Settlement page.",
                "code": "employee_only",
            },
            status=403,
        )
    emp = Employee.objects.filter(pk=emp_id).first()
    if emp is None:
        return None, Response({"error": "Employee not found", "code": "not_found"}, status=404)
    return emp, None


def _own_rows(emp: Employee):
    return (
        Advance.objects.filter(employee=emp)
        .select_related("employee", "employee__department", "employee__designation", "employee__branch")
        .prefetch_related("repayments")
        .order_by("-created_at", "-id")
    )


def eligibility_json(emp: Employee, today: date) -> dict:
    win = window(today)
    cfg = approval.get_config(WORKFLOW)
    workflow_message = None
    if not cfg.enabled:
        try:
            approval.require_enabled(WORKFLOW)
        except approval.ApprovalError as exc:
            workflow_message = exc.message
    active = emp.status == "active"
    inactive_reason = None if active else "Only active employees can apply. Please contact HR."
    common_reason = inactive_reason or workflow_message or (None if win["isOpen"] else win["message"])

    salary = monthly_salary(emp)
    limit = salary_advance_limit(salary) if salary else None
    existing = salary_advance_this_month(emp, today)
    if salary is None:
        general_reason = (
            "A Salary Advance is up to 60% of a monthly fixed salary. You are paid per shift, so there is no monthly "
            "salary to take it from. Please speak to HR."
            if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF
            else "Your monthly salary is not recorded yet, so a Salary Advance cannot be worked out. Please contact HR."
        )
    elif existing is not None:
        general_reason = (
            f"You already have a Salary Advance for {month_label(today.month, today.year)} "
            f"({STATUS_LABEL.get(existing.status, existing.status).lower()}). Only one is allowed each month."
        )
    else:
        general_reason = None
    general_reason = common_reason or general_reason

    pending_term = pending_term_loan(emp)
    term_reason = common_reason or (
        "Your earlier Term Loan application is still waiting for HR. You can apply again once it is decided."
        if pending_term
        else None
    )
    nm, ny = next_month(today.month, today.year)
    active_terms = Advance.objects.filter(employee=emp, advance_type="term", status="approved").count()

    return {
        "today": today.isoformat(),
        "window": win,
        "workflowEnabled": cfg.enabled,
        "workflowMessage": workflow_message,
        "employeeActive": active,
        "monthlySalary": float(salary) if salary else None,
        "salaryAdvance": {
            "canApply": general_reason is None,
            "reason": general_reason,
            "percent": SALARY_ADVANCE_PERCENT,
            "limit": float(limit) if limit is not None else None,
            "deductionMonth": today.month,
            "deductionYear": today.year,
            "deductionLabel": month_label(today.month, today.year),
            "existing": (
                {"id": existing.id, "status": existing.status, "amount": float(existing.amount)} if existing else None
            ),
        },
        "termLoan": {
            "canApply": term_reason is None,
            "reason": term_reason,
            "minMonths": MIN_TERM_MONTHS,
            "maxMonths": MAX_TERM_MONTHS,
            "minAmount": MIN_TERM_AMOUNT,
            "maxAmount": MAX_AMOUNT,
            "firstDeductionMonth": nm,
            "firstDeductionYear": ny,
            "firstDeductionLabel": month_label(nm, ny),
            "pending": {"id": pending_term.id, "amount": float(pending_term.amount)} if pending_term else None,
            "activeCount": active_terms,
        },
        "rules": rules_text(),
        "approvalPath": approval.pipeline_text("Employee", cfg.steps),
    }


@api_view(["GET"])
@require_auth
def my_advance_eligibility(request: Request) -> Response:
    emp, refusal = _employee(request)
    if refusal:
        return refusal
    return Response(eligibility_json(emp, ist_today()))


@api_view(["GET", "POST"])
@require_auth
def my_advances(request: Request) -> Response:
    emp, refusal = _employee(request)
    if refusal:
        return refusal
    if request.method == "GET":
        today = ist_today()
        return Response([my_advance_json(a, today) for a in _own_rows(emp)])
    return _apply(request, emp)


@api_view(["GET"])
@require_auth
def my_advance_detail(request: Request, pk: int) -> Response:
    emp, refusal = _employee(request)
    if refusal:
        return refusal
    a = _own_rows(emp).filter(pk=pk).first()
    if a is None:
        return Response({"error": "Application not found", "code": "not_found"}, status=404)
    return Response(my_advance_json(a))


def _bad(message: str, code: str = "invalid", field: str | None = None, status: int = 400) -> Response:
    body = {"error": message, "code": code}
    if field:
        body["field"] = field
    return Response(body, status=status)


def _field(data, camel: str, snake: str):
    """The mobile app sends snake_case bodies (its axios instance decamelizes), the web clients camelCase: take either."""
    return data.get(camel) if data.get(camel) is not None else data.get(snake)


def _apply(request: Request, emp: Employee) -> Response:
    data = request.data if hasattr(request.data, "get") else {}
    today = ist_today()

    if emp.status != "active":
        return _bad("Only active employees can apply. Please contact HR.", "inactive", status=403)
    try:
        approval.require_enabled(WORKFLOW)  # HR can switch new advances off in Approval Workflow Control
    except approval.ApprovalError as exc:
        return approval.refusal(exc)

    advance_type = str(_field(data, "advanceType", "advance_type") or "").strip()
    if advance_type not in TYPE_LABEL:
        return _bad("Choose Salary Advance or Term Loan.", field="advanceType")

    if today.day < WINDOW_OPENS_ON_DAY:
        return _bad(window_closed_message(today), "window_closed")

    amount, problem = parse_amount(data.get("amount"))
    if problem:
        return _bad(problem, field="amount")

    purpose = str(data.get("purpose") or "").strip()
    if len(purpose) < MIN_PURPOSE:
        return _bad("Tell HR briefly what the money is for.", field="purpose")
    if len(purpose) > MAX_PURPOSE:
        return _bad(f"Keep the purpose under {MAX_PURPOSE} characters.", field="purpose")

    salary = monthly_salary(emp)
    months = None
    if advance_type == "general":
        if salary is None:
            return _bad(
                "A Salary Advance is up to 60% of your monthly fixed salary, and no monthly salary is recorded for "
                "you. Please contact HR.",
                "no_salary",
            )
        limit = salary_advance_limit(salary)
        if amount > limit:
            return _bad(
                f"The most you can ask for is {inr(limit)} ({SALARY_ADVANCE_PERCENT}% of your monthly salary of "
                f"{inr(salary)}).",
                "over_limit",
                field="amount",
            )
        existing = salary_advance_this_month(emp, today)
        if existing is not None:
            return _bad(
                f"You already have a Salary Advance for {month_label(today.month, today.year)}. "
                "Only one is allowed each month.",
                "duplicate",
                status=409,
            )
        start_month, start_year = today.month, today.year
        emi = Decimal("0")
    else:
        months, problem = parse_months(_field(data, "repaymentMonths", "repayment_months"))
        if problem:
            return _bad(problem, field="repaymentMonths")
        if amount < MIN_TERM_AMOUNT:
            return _bad(f"A Term Loan starts from {inr(MIN_TERM_AMOUNT)}.", field="amount")
        if pending_term_loan(emp) is not None:
            return _bad(
                "Your earlier Term Loan application is still waiting for HR. You can apply again once it is decided.",
                "duplicate",
                status=409,
            )
        start_month, start_year = next_month(today.month, today.year)
        emi = term_emi(amount, months)

    adv = Advance.objects.create(
        employee=emp,
        advance_type=advance_type,
        amount=amount,
        requested_amount=amount,
        salary_at_request=salary,
        applied_by=Advance.APPLIED_BY_EMPLOYEE,
        purpose=purpose,
        status=Advance.STATUS_PENDING,
        emi_amount=emi,
        repayment_months=months,
        repayment_start_month=start_month,
        repayment_start_year=start_year,
        outstanding=amount,
    )
    approval.notify_new_request(WORKFLOW, emp, f"{TYPE_LABEL[advance_type]} application")
    adv = _own_rows(emp).get(pk=adv.pk)
    return Response(my_advance_json(adv, today), status=201)
