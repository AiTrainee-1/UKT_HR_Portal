"""Employee self-service Salary Advance and Term Loan (owner brief 2026-10-31, the mobile pages round).

Until now only HR could record an advance (Settlement page, POST /api/advances). Employees now apply themselves from the
mobile app, and HR approves on the same Settlement page through the existing "advance" approval workflow (HR only).

Owner's rules, all decided here and nowhere else:
  * When (factory date, clock.ist_today): a Salary Advance ("general") only on the 21st and 22nd of each month (owner
    2026-11-26; the 20th to the 22nd from 2026-11-25, the 20th to the month end before); a Term Loan on any day.
  * Salary Advance (owner 2026-11-26): at most 50 % of the salary EARNED from the 1st to the 20th of the month, priced
    exactly like the staff payroll (advance_earnings.py: per-day salary x present shifts + paid holidays). Until
    2026-11-26 it was 60 % of the monthly fixed salary. It is deducted in full from THAT month's salary (the month the
    application is made in). No monthly salary on record (production staff are paid per shift) = no Salary Advance.
  * Term Loan: only after 6 completed months of service from the joining date (owner 2026-11-26, counted like the
    Casual Leave service rule). Any amount from MIN_TERM_AMOUNT, repaid in 1 to 12 monthly EMIs starting NEXT month. The EMI is the
    amount over the months rounded UP to whole rupees, so the last EMI is the smaller one that absorbs the remainder
    (10,000 over 3 months = 3,334 + 3,334 + 3,332). Nothing is left unscheduled.
  * HR may approve a SMALLER amount and move the first deduction month (settlement_views.advance_detail). `amount` is
    always the APPROVED amount (what is paid and deducted); `requested_amount` keeps what the employee asked for.
  * Duplicates: one Salary Advance per deduction month (unless the earlier one was rejected); no new Term Loan while
    another Term Loan is still waiting for HR.
  * Withdrawing: the employee may delete their own application only while it is still waiting for HR (POST
    /api/my/requests/advance/<id>/withdraw, mobile_withdraw_views.py); HR's Delete is pending-only too (2026-11-26).

Payroll is not touched: approval creates the AdvanceRepayment rows (settlement_views._auto_create_repayments) exactly as
for an advance HR records, and payroll deducts them as it always has.

Endpoints (employee token only; an HR token gets 403):
  GET  /api/my/advances/eligibility   windows, salary, limit, deduction months, what is already applied, the rules.
                                      `windows: {general, term}` holds each form's own window; `window` (what older apps
                                      read) is the Salary Advance window, the only one with dates since 2026-11-25.
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

from . import advance_earnings, advance_rules, approval_workflow as approval
from .auth import get_token_employee_id, require_auth
from .clock import FACTORY_TZ, ist_today
from .models import Advance, Employee
from .payroll_insights import inr
from .settlement_views import advance_json, whole_rupee_emi

WORKFLOW = "advance"

# The Salary Advance window: the 21st and the 22nd of every month, both days included (owner 2026-11-26; the 20th to the
# 22nd from 2026-11-25). A Term Loan has no window.
SALARY_ADVANCE_OPENS_ON_DAY = 21
SALARY_ADVANCE_CLOSES_ON_DAY = 22
WINDOW_OPENS_ON_DAY = SALARY_ADVANCE_OPENS_ON_DAY  # the old name (one window for both forms until 2026-11-25)
SALARY_ADVANCE_PERCENT = advance_earnings.SALARY_ADVANCE_PERCENT  # 50 % of the salary earned in the 1st-20th
WINDOW_TEXT = "the 21st and 22nd of each month"
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


def _day_month(d: date) -> str:
    """ "20 December" (no leading zero)."""
    return f"{d.day} {MONTH_NAMES[d.month]}"


def _salary_advance_days(month: int, year: int, r=None) -> tuple[date, date]:
    """The Salary Advance window of a month (Settings -> Loan & Advance; default the 21st and 22nd)."""
    r = r or advance_rules.rules()
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(r.sa_window_from, last)), date(year, month, min(r.sa_window_to, last))


TERM_LOAN_ANY_DAY = "You can apply for a Term Loan on any day."


def window(today: date) -> dict:
    """The Salary Advance window around `today`: open on the 21st and the 22nd of the month. Before the 21st it is this
    month's window that is coming; after the 22nd, next month's. Also the `window` key older apps read
    (until 2026-11-25 one window, the 20th to the month end, held both forms)."""
    r = advance_rules.rules()
    opens_on, closes_on = _salary_advance_days(today.month, today.year, r)
    if today > closes_on:
        opens_on, closes_on = _salary_advance_days(*next_month(today.month, today.year), r)
    is_open = opens_on <= today <= closes_on
    nm, ny = next_month(today.month, today.year)
    next_opens_on = _salary_advance_days(nm, ny, r)[0] if is_open else opens_on
    if is_open:
        days_left = (closes_on - today).days + 1  # today included
        message = (
            f"Salary Advance applications are open until {_day_month(closes_on)} ({advance_rules.window_text(r)}). "
            + TERM_LOAN_ANY_DAY
        )
    else:
        days_left = 0
        message = (
            f"Salary Advance applications open on {_day_month(opens_on)} and close on {_day_month(closes_on)}. "
            + TERM_LOAN_ANY_DAY
        )
    return {
        "isOpen": is_open,
        "opensOn": opens_on.isoformat(),
        "closesOn": closes_on.isoformat(),
        "nextOpensOn": next_opens_on.isoformat(),
        "daysUntilOpen": 0 if is_open else (opens_on - today).days,
        "daysLeft": days_left,
        "message": message,
        # additive (2026-11-25): which form this window is for, and that it has dates
        "type": "general",
        "label": TYPE_LABEL["general"],
        "alwaysOpen": False,
        "opensOnDay": r.sa_window_from,
        "closesOnDay": r.sa_window_to,
    }


def term_window(today: date) -> dict:
    """A Term Loan has no window (owner 2026-11-25): open every day. The same keys as window(), with no closing date."""
    return {
        "isOpen": True,
        "opensOn": today.isoformat(),
        "closesOn": None,
        "nextOpensOn": None,
        "daysUntilOpen": 0,
        "daysLeft": None,
        "message": "Term Loan applications are open on any day.",
        "type": "term",
        "label": TYPE_LABEL["term"],
        "alwaysOpen": True,
        "opensOnDay": None,
        "closesOnDay": None,
    }


def windows(today: date) -> dict:
    """Each form's own window (the eligibility reply's `windows`)."""
    return {"general": window(today), "term": term_window(today)}


def window_closed_message(today: date) -> str:
    """Why a Salary Advance cannot be sent today (outside the 21st and 22nd)."""
    w = window(today)
    opens_on = date.fromisoformat(w["opensOn"])
    closes_on = date.fromisoformat(w["closesOn"])
    return (
        f"A Salary Advance can be applied for only on {advance_rules.window_text(advance_rules.rules())}. "
        f"The next window is {_day_month(opens_on)} to {_day_month(closes_on)}. " + TERM_LOAN_ANY_DAY
    )


def monthly_salary(emp: Employee) -> Decimal | None:
    """The monthly fixed salary (`salary_amount`, which the staff payroll pays every month). Production employees are paid
    per shift (`salary_per_shift`), so they have no monthly fixed salary - and no Salary Advance."""
    return advance_earnings.monthly_fixed_salary(emp)


def salary_advance_limit(earned: Decimal) -> Decimal:
    """Settings' % (default 50) of the salary earned in the 1st-20th, in whole rupees (rounded down)."""
    return Decimal(math.floor(earned * advance_rules.rules().sa_percent / 100))


def earned_this_window(emp: Employee, today: date):
    """The 1st-20th earnings the Salary Advance limit is taken from: this month's while its window is open or still
    ahead (before the 21st it is the salary earned so far); None after the 22nd (next month's is not earned yet) or
    without a monthly salary."""
    if today.day > advance_rules.rules().sa_window_to:
        return None
    return advance_earnings.earned_in_month(emp, today.month, today.year)


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
    most = advance_rules.rules().tl_max_months  # Settings -> Loan & Advance (default 6, at most 12)
    if months is None or str(months) != str(raw).strip():
        return None, f"Choose how many months to repay in ({MIN_TERM_MONTHS} to {most})."
    if not MIN_TERM_MONTHS <= months <= most:
        return None, f"A Term Loan is repaid in {MIN_TERM_MONTHS} to {most} months."
    return months, None


def _created_in(a: Advance, month: int, year: int) -> bool:
    if not a.created_at:
        return False
    local = a.created_at.astimezone(FACTORY_TZ)
    return (local.month, local.year) == (month, year)


def salary_advances_this_month(emp: Employee, today: date) -> list[Advance]:
    """The Salary Advances that use this month: deducted this month, or asked for this month (by the employee or by HR
    for them). A rejected one counts only when Settings says so ("a rejected request does not count" is the default)."""
    rows = Advance.objects.filter(employee=emp, advance_type="general").order_by("-id")
    if advance_rules.rules().sa_rejected_allows_reapply:
        rows = rows.exclude(status="rejected")
    out = []
    for a in rows:
        if (a.repayment_start_month, a.repayment_start_year) == (today.month, today.year) or (
            a.applied_by in (Advance.APPLIED_BY_EMPLOYEE, Advance.APPLIED_BY_HR)
            and _created_in(a, today.month, today.year)
        ):
            out.append(a)
    return out


def salary_advance_this_month(emp: Employee, today: date) -> Advance | None:
    """The month's Salary Advance that stops another one: there are already as many as Settings allows a month
    (default 1). None when another may be asked for."""
    rows = salary_advances_this_month(emp, today)
    return rows[0] if len(rows) >= advance_rules.rules().sa_per_month else None


def pending_term_loan(emp: Employee) -> Advance | None:
    return Advance.objects.filter(employee=emp, advance_type="term", status="pending").order_by("-id").first()


def rules_text() -> list[str]:
    """The rules in words, from Settings -> Loan & Advance (shown in the apps and in HR's New request dialog)."""
    r = advance_rules.rules()
    per_month = "One Salary Advance" if r.sa_per_month == 1 else f"Up to {r.sa_per_month} Salary Advances"
    rejected = " (a rejected one does not count)" if r.sa_rejected_allows_reapply else ""
    yearly = "once a year" if r.tl_per_year == 1 else f"{r.tl_per_year} times a year"
    lines = [
        f"Salary Advance: apply on {advance_rules.window_text(r)}. Term Loan: apply on any day.",
        f"Salary Advance: up to {r.sa_percent}% of the salary you earned from the 1st to the "
        f"{advance_rules.ordinal(r.sa_earned_through)} of the month (your present days and paid holidays). It is "
        "deducted in full from that month's salary.",
        f"{per_month} per month{rejected}.",
        f"Term Loan (staff): up to {r.tl_effective_percent}% of your fixed monthly salary, from "
        f"{inr(r.tl_min_amount)}, repaid in {MIN_TERM_MONTHS} to {r.tl_max_months} monthly EMIs starting from next "
        f"month's salary, after {r.tl_min_service_months} months of service.",
        f"A Term Loan can be given {yearly} (January to December)"
        + (", one waiting or being repaid at a time" if r.tl_one_open else "")
        + ("; after a rejection you can apply again from the next month." if r.tl_reapply_next_month else "."),
        "HR approves every application. HR may approve a smaller amount, change the months or the month deductions start.",
        "You can delete an application while it is still waiting for HR; once HR approves or rejects it, it stays.",
    ]
    return lines


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
                "comment": a.decision_remark or a.notes or None,
            }
        )
    elif a.status == "rejected":
        events.append(
            {
                "kind": "rejected",
                "at": (a.decided_at or a.updated_at).isoformat() if (a.decided_at or a.updated_at) else None,
                "title": "Rejected by HR",
                "by": a.approved_by,
                "text": "Nothing will be deducted from your salary.",
                "comment": a.decision_remark or a.notes or None,
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
    win = window(today)  # the Salary Advance window (a Term Loan has none since 2026-11-25)
    cfg = approval.get_config(WORKFLOW)
    workflow_message = None
    if not cfg.enabled:
        try:
            approval.require_enabled(WORKFLOW)
        except approval.ApprovalError as exc:
            workflow_message = exc.message
    active = emp.status == "active"
    inactive_reason = None if active else "Only active employees can apply. Please contact HR."
    # Shared by both forms: the account is not active, or HR switched new applications off. The window is the Salary
    # Advance's alone (below).
    common_reason = inactive_reason or workflow_message

    salary = monthly_salary(emp)
    earnings = earned_this_window(emp, today) if salary else None
    limit = earnings.limit if earnings is not None else None
    existing = salary_advance_this_month(emp, today)
    if salary is None:
        general_reason = (
            f"A Salary Advance is up to {advance_rules.rules().sa_percent}% of the monthly salary you earned in the 1st "
            f"to the {advance_rules.ordinal(advance_rules.rules().sa_earned_through)}. You are paid per shift, so there "
            "is no monthly salary to take it from. Please speak to HR."
            if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF
            else "Your monthly salary is not recorded yet, so a Salary Advance cannot be worked out. Please contact HR."
        )
    elif not win["isOpen"]:
        general_reason = window_closed_message(today)
    elif earnings is not None and earnings.limit <= 0:
        general_reason = (
            f"No salary was earned from the 1st to the {advance_rules.ordinal(earnings.through.day)} of this month (no "
            "present days), so there is nothing to give a Salary Advance from."
        )
    elif existing is not None:
        allowed = advance_rules.rules().sa_per_month
        general_reason = (
            f"You already have a Salary Advance for {month_label(today.month, today.year)} "
            f"({STATUS_LABEL.get(existing.status, existing.status).lower()}). "
            + ("Only one is allowed each month." if allowed == 1 else f"Up to {allowed} are allowed each month.")
        )
    else:
        general_reason = None
    general_reason = common_reason or general_reason

    pending_term = pending_term_loan(emp)
    r = advance_rules.rules()
    service = advance_earnings.term_loan_service(emp, today, r)
    term_status = advance_rules.term_loan_status(emp, today, r)
    term_reason = common_reason or term_status["reason"]
    nm, ny = next_month(today.month, today.year)
    active_terms = Advance.objects.filter(employee=emp, advance_type="term", status="approved").count()
    # The salary a Salary Advance would come out of: this month's while its window is open or still ahead; after the 22nd
    # the next chance is next month's window, so next month's salary (2026-11-25: the closed card said "November").
    ded_month, ded_year = (nm, ny) if today.day > r.sa_window_to else (today.month, today.year)

    return {
        "today": today.isoformat(),
        # what older apps (and the Employee Web App) read: the Salary Advance window
        "window": win,
        # additive (2026-11-25): each form's own window; a Term Loan's is always open
        "windows": windows(today),
        "workflowEnabled": cfg.enabled,
        "workflowMessage": workflow_message,
        "employeeActive": active,
        "monthlySalary": float(salary) if salary else None,
        "salaryAdvance": {
            "canApply": general_reason is None,
            "reason": general_reason,
            "percent": r.sa_percent,
            "limit": float(limit) if limit is not None else None,
            # additive (2026-11-27): the Salary Advance rules of Settings
            "rules": r.sa_json(),
            "deductionMonth": ded_month,
            "deductionYear": ded_year,
            "deductionLabel": month_label(ded_month, ded_year),
            "existing": (
                {"id": existing.id, "status": existing.status, "amount": float(existing.amount)} if existing else None
            ),
            # additive (2026-11-26): what the limit is taken from - the salary earned in the 1st-20th of this month
            # (`final` once the 20th is over; before it, earned so far). Null after the 22nd or without a salary.
            "limitBasis": "earned_1_to_20",
            "earned": (
                {**earnings.to_json(), "final": today.day > earnings.through.day} if earnings is not None else None
            ),
        },
        "termLoan": {
            "canApply": term_reason is None,
            "reason": term_reason,
            "minMonths": MIN_TERM_MONTHS,
            "maxMonths": r.tl_max_months,
            "minAmount": r.tl_min_amount,
            # the most the employee may ask for: Settings' % of the fixed monthly salary (older apps read maxAmount)
            "maxAmount": term_status["limit"] if term_status["limit"] is not None else 0,
            "firstDeductionMonth": nm,
            "firstDeductionYear": ny,
            "firstDeductionLabel": month_label(nm, ny),
            "pending": {"id": pending_term.id, "amount": float(pending_term.amount)} if pending_term else None,
            "activeCount": active_terms,
            # additive (2026-11-26): the service rule
            "service": service,
            # additive (2026-11-27): every Term Loan rule for this employee and the rules of Settings
            "limit": term_status["limit"],
            "limitPercent": term_status["limitPercent"],
            "monthlySalary": term_status["monthlySalary"],
            "approvedThisYear": term_status["approvedThisYear"],
            "perYear": term_status["perYear"],
            "open": term_status["open"],
            "rejectedThisMonth": term_status["rejectedThisMonth"],
            "nextEligibleOn": term_status["nextEligibleOn"],
            "code": term_status["code"],
            "rules": r.tl_json(),
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
    result = apply_for(emp, data, applied_by=Advance.APPLIED_BY_EMPLOYEE, today=today)
    if isinstance(result, Response):
        return result
    adv = _own_rows(emp).get(pk=result.pk)
    return Response(my_advance_json(adv, today), status=201)


def apply_for(emp: Employee, data, *, applied_by: str, today: date | None = None):
    """Every rule of a Salary Advance / Term Loan request, whoever raises it: the employee from the apps, or HR on the
    employee's behalf from the Loan & Advance page (owner 2026-11-27: "manually created requests follow the same
    eligibility rules, validation and approval workflow"). Returns the new Advance, or the refusal Response."""
    today = today or ist_today()

    if emp.status != "active":
        return _bad("Only active employees can apply. Please contact HR.", "inactive", status=403)
    try:
        approval.require_enabled(WORKFLOW)  # HR can switch new advances off in Approval Workflow Control
    except approval.ApprovalError as exc:
        return approval.refusal(exc)

    advance_type = str(_field(data, "advanceType", "advance_type") or "").strip()
    if advance_type not in TYPE_LABEL:
        return _bad("Choose Salary Advance or Term Loan.", field="advanceType")

    # Only a Salary Advance has a window: the 20th to the 22nd (owner 2026-11-25). A Term Loan is open every day.
    if advance_type == "general" and not window(today)["isOpen"]:
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
    earnings = advance_earnings.earned_in_month(emp, today.month, today.year) if salary else None
    months = None
    if advance_type == "general":
        if salary is None or earnings is None:
            return _bad(
                f"A Salary Advance is up to {advance_rules.rules().sa_percent}% of the salary you earned from the 1st to "
                f"the {advance_rules.ordinal(advance_rules.rules().sa_earned_through)}, "
                "and no monthly salary is recorded for you. Please contact HR.",
                "no_salary",
            )
        limit = earnings.limit
        if amount > limit:
            return _bad(
                f"The most you can ask for is {inr(limit)} ({earnings.percent}% of the {inr(earnings.earned)} you "
                f"earned from the 1st to the {advance_rules.ordinal(earnings.through.day)}).",
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
        # every Term Loan rule of Settings -> Loan & Advance (owner 2026-11-27): staff only, the service, one waiting or
        # active at a time, the yearly allowance (calendar year), no new request in the month of a rejection
        r = advance_rules.rules()
        status = advance_rules.term_loan_status(emp, today, r)
        if not status["eligible"]:
            code = status["code"]
            http = {"staff_only": 400, "no_salary": 400, "service": 403}.get(code, 409)
            # older apps know "duplicate" for a request still waiting
            return _bad(status["reason"], "duplicate" if code == "pending" else code, status=http)
        if amount < r.tl_min_amount:
            return _bad(f"A Term Loan starts from {inr(r.tl_min_amount)}.", field="amount")
        term_limit = Decimal(str(status["limit"]))
        if amount > term_limit:
            return _bad(
                f"The most you can ask for is {inr(term_limit)} ({r.tl_effective_percent}% of your monthly salary of "
                f"{inr(status['monthlySalary'])}).",
                "over_limit",
                field="amount",
            )
        start_month, start_year = next_month(today.month, today.year)
        emi = term_emi(amount, months)

    adv = Advance.objects.create(
        employee=emp,
        advance_type=advance_type,
        amount=amount,
        requested_amount=amount,
        salary_at_request=salary,
        applied_by=applied_by,
        purpose=purpose,
        status=Advance.STATUS_PENDING,
        emi_amount=emi,
        repayment_months=months,
        repayment_start_month=start_month,
        repayment_start_year=start_year,
        outstanding=amount,
        # a Term Loan's limit when asked for (Settings' % of the monthly salary), for the reports (2026-11-27)
        term_limit=advance_rules.term_limit(emp) if advance_type == "term" else None,
    )
    # the 1st-20th figures for the Settlement report and the leave check (2026-11-26)
    advance_earnings.store(
        adv, earnings, today, leave_days=advance_earnings.leave_days_in_month(emp, today.month, today.year, today=today)
    )
    by_hr = applied_by != Advance.APPLIED_BY_EMPLOYEE
    what = f"{TYPE_LABEL[advance_type]} application" + (" (raised by HR)" if by_hr else "")
    approval.notify_new_request(WORKFLOW, emp, what, obj=adv)
    return adv
