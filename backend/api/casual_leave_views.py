"""
Casual Leave (CL) Module
========================
Paid leave, staff-only. Fully independent of LeaveRequest / permissions -its
own table and its own approval flow (HR directly, or Department Head from the
mobile app, configurable per-manager in User Management via
can_approve_casual_leave).

Who and how much follow the policy HR sets on Settings -> Casual Leave (owner
2026-11-21, CasualLeavePolicy; nothing hardcoded): the service needed (N months
or N days after joining), the days given (N a month, earned month by month, or
N a year at once), whether unused days carry forward to later months, what
happens to them on 31 December, and whether half days are allowed. The balance
itself is worked out in cl_balance.py. Casual Leave dated before the cut-over
(PayrollSettings.cl_balance_since, 2026-11-02) never counts against the balance
and keeps the older rule: one per calendar month.

  GET     /api/casual-leaves/history?year=&employeeId=   the year's balance as a running story
  GET|PUT /api/casual-leaves/policy                     the policy (read) and the cut-over day (PUT balanceSince)
  GET|PUT /api/casual-leave-policy                      Settings -> Casual Leave: the whole policy (see casual_leave_settings)
  GET /api/casual-leaves/absent-dates, POST /assign       absent / leave days -> Casual Leave (Carry Forward):
  GET /api/casual-leaves/adjustments                     ... and its log; see cl_adjustment_views.py

Attendance integration:
  approved → AttendanceDayRecord for that date = Present, 1.00 shift (paid)
  rejected → AttendanceDayRecord for that date = Leave
Both are written as source="manual" so payroll treats them as authoritative.

Half-day CL (owner 2026-10-31): the month's one CL may instead be two half-days (first / second half of the shift) on any
dates of that month. A half is never written as a manual day: the attendance engine pays the CL half (0.50) and counts the
other half by the punches (attendance_final._apply_half_casual_leave), so a decision only recomputes the day.
"""

import calendar
from datetime import date as date_type
from decimal import Decimal

from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, cl_balance, hr_access, whatsapp_approvals
from .audit_utils import log_action
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name, is_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import AttendanceDayRecord, CasualLeaveRequest, Employee
from .request_window import enforce_employee_date, request_window

# The policy's starting value (6 months). Settings -> Casual Leave decides now (cl_balance.policy()); kept only for the
# retired Report Center reports that still import it.
ELIGIBILITY_MONTHS = 6


# ── Helpers ────────────────────────────────────────────────────────────────

def _parse_join_date(raw) -> date_type | None:
    return cl_balance.parse_join_date(raw)


def _service_months(emp: Employee, today: date_type | None = None) -> int | None:
    """Completed months of service, or None when join date is unknown."""
    joined = cl_balance.parse_join_date(emp.join_date)
    if joined is None:
        return None
    return cl_balance.months_between(joined, today or ist_today())


def _months_between(joined: date_type, on: date_type) -> int:
    """Completed months from `joined` to `on` (the same count as _service_months, for any date)."""
    return cl_balance.months_between(joined, on)


def eligible_from(joined: date_type, pol: cl_balance.Policy | None = None) -> date_type:
    """The first day on which `joined` has the service the Casual Leave policy asks for (N completed months, or N days)."""
    return cl_balance.eligible_from(joined, pol)


def service_progress(joined: date_type, on: date_type, pol: cl_balance.Policy) -> str:
    """ "4/6 months of service" or "120/180 days of service" (the board's reason for someone still too new)."""
    if pol.basis == "days":
        done = max(0, (on - joined).days)
        return f"{done}/{pol.service} days of service"
    return f"{cl_balance.months_between(joined, on)}/{pol.service} months of service"


def service_refusal(emp: Employee, on: date_type, pol: cl_balance.Policy) -> str | None:
    """Why `emp` may not take Casual Leave yet (judged on `on`, the day of asking) for lack of service; None when they
    have the service the policy asks for."""
    joined = cl_balance.parse_join_date(emp.join_date)
    if joined is None:
        return "Join date not set -contact HR"
    if on < cl_balance.eligible_from(joined, pol):
        return f"Eligible after {pol.service_text()} (currently {cl_balance.service_done(joined, on, pol)})"
    return None


def board_reference_date(year: int, month: int, today: date_type) -> date_type:
    """The day the Casual Leave board judges service length on. This month: today, which is the very rule a submission is
    checked with (check_cl_eligibility), so the board never promises what Submit would refuse. A past month: its last day
    (who had qualified by then). A future month: its 15th, as the board always did."""
    if (year, month) == (today.year, today.month):
        return today
    month_end = date_type(year, month, calendar.monthrange(year, month)[1])
    return month_end if month_end < today else date_type(year, month, 15)


def _cl_used_in_month(emp_id: int, year: int, month: int, exclude_id: int | None = None) -> bool:
    qs = CasualLeaveRequest.objects.filter(
        employee_id=emp_id, date__year=year, date__month=month,
        status__in=["pending", "approved"],
    )
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    return qs.exists()


# The month's one Casual Leave is EITHER one full day OR two half-days (first / second half of the shift) on any dates of
# that month (owner 2026-10-31). Pending and approved requests both count; a rejected one frees its part again.
FULL = CasualLeaveRequest.PORTION_FULL
FIRST_HALF = CasualLeaveRequest.PORTION_FIRST_HALF
SECOND_HALF = CasualLeaveRequest.PORTION_SECOND_HALF
PORTIONS = (FULL, FIRST_HALF, SECOND_HALF)
PORTION_LABEL = {FULL: "Full day", FIRST_HALF: "Half day (first half)", SECOND_HALF: "Half day (second half)"}
PORTION_DAYS = {FULL: Decimal("1"), FIRST_HALF: Decimal("0.5"), SECOND_HALF: Decimal("0.5")}
LEFT_FULL, LEFT_ONE_HALF, LEFT_NOTHING = "full", "one_half", "nothing"
USED_UP = "Casual Leave already used this month (limit: 1 per month)"
BOTH_HALVES_USED = "Both half-days of this month's Casual Leave are already used (limit: 1 day per month)"
HALF_ALREADY_USED = (
    "Half a day of this month's Casual Leave is already used, so only the other half-day is left. "
    "Choose First half or Second half."
)


def portion_of(cl: CasualLeaveRequest) -> str:
    return cl.portion if cl.portion in PORTIONS else FULL


def days_number(value) -> int | float:
    """1 -> 1, 1.5 -> 1.5: a whole count stays a whole number for older readers."""
    value = Decimal(str(value))
    return int(value) if value == value.to_integral_value() else float(value)


def month_cl_state(rows) -> dict:
    """What the month's pending/approved Casual Leave rows leave over: "full", "one_half" or "nothing"."""
    full = next((r for r in rows if portion_of(r) == FULL), None)
    halves = [r for r in rows if portion_of(r) != FULL]
    if full is not None or len(halves) >= 2:
        left = LEFT_NOTHING
    else:
        left = LEFT_ONE_HALF if halves else LEFT_FULL
    return {"left": left, "full": full, "halves": halves}


def _month_rows(emp_id: int, year: int, month: int) -> list:
    return list(
        CasualLeaveRequest.objects.filter(
            employee_id=emp_id, date__year=year, date__month=month, status__in=["pending", "approved"],
        ).order_by("date", "id")
    )


def _half_word(portion: str) -> str:
    return "first" if portion == FIRST_HALF else "second"


HALF_DAYS_OFF = "Half-day Casual Leave is switched off. Choose Full day."


def _period_title(year: int, month: int | None) -> str:
    """ "November 2026" for a month, "2026" for the year."""
    return f"{calendar.month_name[month]} {year}" if month else str(year)


def no_balance_reason(year: int, month: int | None = None, pol: cl_balance.Policy | None = None) -> str:
    """Why nothing is left for a date of `month` / `year`, in the policy's own terms (`month` matters only with the
    monthly allocation: each month has its own balance)."""
    pol = pol or cl_balance.policy()
    if not pol.monthly_mode:
        return f"No Casual Leave left for {year}: all {cl_balance.number(pol.yearly)} days are used or waiting for approval"
    title = _period_title(year, month)
    if not pol.carries_within_year:
        one = pol.monthly == 1
        days = f"{cl_balance.number(pol.monthly)} day{'' if one else 's'} {'is' if one else 'are'}"
        return f"No Casual Leave left for {title}: the month's {days} used or waiting for approval"
    return (
        f"No Casual Leave left for {title}: every day given so far ({pol.allocation_text()}) is used or waiting for "
        "approval"
    )


def half_left_reason(year: int, month: int | None = None, half_day: bool = True) -> str:
    title = _period_title(year, month)
    if not half_day:
        return f"Only half a day of Casual Leave is left for {title}, and half days are switched off."
    return f"Only half a day of Casual Leave is left for {title}. Choose First half or Second half."


def _check_yearly_balance(
    emp, for_date, portion, cut_over, exclude_override_ids, pol: cl_balance.Policy | None = None
) -> tuple[bool, str | None]:
    """The rule for a date on/after the cut-over: the policy's balance (cl_balance.py: the days the months so far gave,
    or the year's days, less approved and waiting Casual Leave) must still hold the days asked for, in the date's month.
    On one date: never the same half twice, never a full day over a half or a half over a full day (two different halves
    of one date are that date's full day)."""
    pol = pol or cl_balance.policy()
    led = cl_balance.ledger(emp, for_date.year, exclude_override_ids, cut_over, pol)
    if led.start is None or for_date < led.start:
        joined = cl_balance.parse_join_date(emp.join_date)
        first = led.start or (cl_balance.eligible_from(joined, pol) if joined else None)
        if first is not None and first > for_date:
            return False, (
                f"Casual Leave counts from {first.strftime('%d %b %Y')} ({pol.service_text()} complete). "
                "Choose a later date."
            )
        return False, f"No Casual Leave balance is kept for {for_date.year}"
    available = led.available(for_date.month)
    if portion in PORTIONS:
        need = PORTION_DAYS[portion]
    else:
        need = Decimal("0.5") if pol.half_day else Decimal("1")
    month = for_date.month if pol.monthly_mode else None
    if available <= 0:
        return False, no_balance_reason(for_date.year, month, pol)
    if available < need:
        return False, half_left_reason(for_date.year, month, pol.half_day)
    if portion in PORTIONS:
        held = cl_balance.day_parts(emp, for_date, exclude_override_ids)
        day = for_date.strftime("%d %b %Y")
        if any(p.portion == FULL for p in held):
            return False, f"{day} is already a full day of Casual Leave. Choose another date."
        if portion == FULL and held:
            return False, (
                f"Half of {day} is already asked for as Casual Leave, so a full day cannot be added. "
                "Choose the other half or another date."
            )
        if any(p.portion == portion for p in held):
            return False, (
                f"The {_half_word(portion)} half of {day} is already asked for as Casual Leave. "
                "Choose the other half or another date."
            )
    return True, None


def check_cl_eligibility(
    emp: Employee, for_date: date_type, portion: str | None = None, exclude_override_ids=()
) -> tuple[bool, str | None]:
    """(eligible, reason_if_not). Applies all the CL business rules. Without a `portion` it answers "is anything of the
    Casual Leave left (for `for_date`)?"; with one, "may this employee ask for this part of `for_date`?".

    A date on/after the cut-over (cl_balance.since()) is judged by the policy's balance; an earlier date by the older
    one-per-month rule. `exclude_override_ids`: pending HR attendance edits to leave out of the balance (the Attendance Edit
    page replaces a waiting edit of the same day with the new one, so the old one's Casual Leave must not count)."""
    if emp.employment_type != "staff":
        return False, "Casual Leave is available only for staff employees"
    if emp.status != "active":
        return False, "Employee is not active"
    # the service and the half-day switch come from the policy (Settings -> Casual Leave); service is judged on the day
    # of asking, as before
    pol = cl_balance.policy()
    if refused := service_refusal(emp, ist_today(), pol):
        return False, refused
    if portion in (FIRST_HALF, SECOND_HALF) and not pol.half_day:
        return False, HALF_DAYS_OFF
    cut_over = cl_balance.since()
    if cl_balance.counts(for_date, cut_over):
        return _check_yearly_balance(emp, for_date, portion, cut_over, exclude_override_ids, pol)
    # Before the cut-over: one Casual Leave per calendar month (only that month's days before the cut-over count).
    state = month_cl_state(
        [r for r in _month_rows(emp.id, for_date.year, for_date.month) if not cl_balance.counts(r.date, cut_over)]
    )
    if state["full"] is not None:
        return False, USED_UP
    if state["left"] == LEFT_NOTHING:
        return False, BOTH_HALVES_USED
    if portion == FULL and state["left"] == LEFT_ONE_HALF:
        return False, HALF_ALREADY_USED
    if portion in (FIRST_HALF, SECOND_HALF) and any(
        r.date == for_date and portion_of(r) == portion for r in state["halves"]
    ):
        return False, (
            f"The {_half_word(portion)} half of {for_date.strftime('%d %b %Y')} is already asked for as Casual Leave. "
            "Choose the other half or another date."
        )
    return True, None


WORKFLOW = "casual_leave"


def _cl_dict(r: CasualLeaveRequest, cfg: approval.Config | None = None) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "departmentId": emp.department_id,
        "branchId": emp.branch_id,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "employmentType": emp.employment_type,
        "date": str(r.date),
        # added 2026-10-31: "full" | "first_half" | "second_half", its words, and the days it counts (1 or 0.5)
        "portion": portion_of(r),
        "portionLabel": PORTION_LABEL[portion_of(r)],
        "days": days_number(PORTION_DAYS[portion_of(r)]),
        "reason": r.reason,
        "status": r.status,
        "reviewedBy": r.reviewed_by,
        "reviewerRole": r.reviewer_role,
        "reviewComment": r.review_comment,
        "reviewedAt": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
        "approval": approval.progress(WORKFLOW, r, cfg),
        # added 2026-11-02: "hr_edit" when HR gave it from the Attendance Edit page (approved by the Department Head and HR
        # there), with that attendance change's id; "employee" otherwise
        "source": "hr_edit" if cl_balance.is_hr_edit_cl(r) else "employee",
        "hrEditRequestId": cl_balance.hr_edit_id_of(r),
    }


def _refresh_day_for_half_cl(cl: CasualLeaveRequest) -> None:
    """A half-day CL is never written as a fixed (manual) day: its OTHER half counts by the punches, which may not exist
    yet. The attendance engine adds the paid half itself (attendance_final._apply_half_casual_leave) whenever the day is
    computed, so this only recomputes a day that has already begun; a later day is computed when it comes. A day HR fixed
    by hand stays as HR left it, except one written by an earlier Casual Leave decision for the same date."""
    from .attendance_final import compute_range_records

    if cl.date > ist_today():
        return
    record = AttendanceDayRecord.objects.filter(employee=cl.employee, date=cl.date).first()
    if record is not None and record.source == "manual":
        if not (record.override_note or "").startswith("Casual Leave"):
            return
        record.source = "auto"
        record.save(update_fields=["source"])
    compute_range_records(cl.employee, cl.date, cl.date)


def _write_attendance_for_cl(cl: CasualLeaveRequest, reviewer: str) -> None:
    """Write the final attendance verdict for the CL date (source=manual wins). A half-day CL (approved or rejected)
    only recomputes the day instead: see _refresh_day_for_half_cl."""
    from .attendance_final import compute_day_record

    if portion_of(cl) != FULL:
        _refresh_day_for_half_cl(cl)
        return
    if cl.status != CasualLeaveRequest.STATUS_APPROVED and _unworked_new_rule_birthday(cl):
        # A rejected Casual Leave on a birthday nobody worked (new birthday rule): the birthday itself is a paid birthday
        # leave, so the day is left to the engine instead of being fixed as unpaid leave (correctness review 2026-11-19)
        _refresh_day_for_half_cl(cl)
        return
    record = AttendanceDayRecord.objects.filter(employee=cl.employee, date=cl.date).first()
    if record is None:
        record = compute_day_record(cl.employee, cl.date)

    if cl.status == CasualLeaveRequest.STATUS_APPROVED:
        record.status = "present"
        record.shifts_earned = Decimal("1.00")
        record.is_late = False
        record.early_leave = False  # a paid day carries no late/early-out mark -this row is never recomputed
        record.late_reason = None
        record.is_half_shift = False
        record.override_note = "Casual Leave (paid) -approved"
    else:  # rejected
        record.status = "on_leave"
        record.shifts_earned = Decimal("0")
        record.is_late = False
        record.early_leave = False
        record.late_reason = None
        record.is_half_shift = False
        record.override_note = "Casual Leave rejected -marked as leave"
    # a verdict set by hand is the whole story of the day: no engine compensation marker (a birthday leave, an
    # allowance, a relaxation) may stay on it and claim something the day no longer pays
    record.compensation_kind = ""
    record.compensation_minutes = 0
    record.compensation_note = ""
    record.source = "manual"
    record.override_by = reviewer
    record.save()


def _unworked_new_rule_birthday(cl: CasualLeaveRequest) -> bool:
    """Is the Casual Leave's date the employee's birthday under the NEW birthday rule, not worked (no punch of its own as
    the attendance engine reads the day) and not already an approved credit? (Then the day is a paid birthday leave
    whatever happens to the Casual Leave: cl_balance.new_rule_birthdays.)"""
    emp = cl.employee
    return bool(cl_balance.new_rule_birthdays([(emp.pk, emp.date_of_birth, emp.employment_type, cl.date)]))


def resolve_casual_leave(
    cl: CasualLeaveRequest, role: str, decision: str, reviewer: str, comment: str | None
) -> approval.Outcome:
    """One decision by `role` ('hod' or 'hr') on a Casual Leave request, under the "casual_leave" pipeline
    (approval_workflow.py). Raises approval.ApprovalError when that role may not decide it now.

    An intermediate approval only passes the request on. The FINAL approval marks the day present (paid) and a
    rejection marks it as leave, both as source=manual so payroll treats them as authoritative."""
    outcome = approval.decide(WORKFLOW, cl, role, decision, actor=reviewer, comment=comment)
    if outcome.final or outcome.rejected:
        cl.reviewer_role = approval.LEGACY_ROLE[role]
    cl.reviewed_by = reviewer
    cl.review_comment = comment
    cl.reviewed_at = timezone.now()
    cl.status = outcome.status
    cl.save()
    what = f"Casual Leave request for {cl.date.isoformat()}"
    if portion_of(cl) != FULL:
        what += f" ({_half_word(portion_of(cl))} half)"
    if outcome.final or outcome.rejected:
        _write_attendance_for_cl(cl, reviewer)
    approval.stage_notice(cl.employee, "casual_leave", approval.notice_for(what, outcome), outcome)
    if outcome.kind == "advanced" and approval.HOD in outcome.waiting and role != approval.HOD:
        approval.notify_hod_of_request(WORKFLOW, cl.employee, "Casual Leave request", cl)
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            "casual_leave", cl, decision, approver=reviewer, role=approval.LEGACY_ROLE[role], comment=comment
        )
    return outcome


def apply_cl_decision(cl: CasualLeaveRequest, status: str, reviewer: str,
                      reviewer_role: str, comment: str | None) -> CasualLeaveRequest:
    """Shared by HR and Department Head endpoints (kept under its old name and signature)."""
    role = approval.HR if reviewer_role == "hr" else approval.HOD
    resolve_casual_leave(cl, role, status, reviewer, comment)
    return cl


# ── List / submit ───────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def casual_leaves(request: Request) -> Response:
    if request.method == "GET":
        qs = CasualLeaveRequest.objects.select_related(
            "employee__department", "employee__designation", "employee__branch"
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        # Employees see only their own CLs
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        else:
            if emp_id := request.query_params.get("employeeId"):
                qs = qs.filter(employee_id=emp_id)
            if code := request.query_params.get("employeeCode"):
                qs = qs.filter(employee__employee_code__iexact=code.strip())
        if status_filter := request.query_params.get("status"):
            qs = qs.filter(status=status_filter)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=month)
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=year)
        cfg = approval.get_config(WORKFLOW)
        return Response([_cl_dict(r, cfg) for r in qs[:300]])

    # POST -submit a CL request (mobile app or HR on behalf)
    data = request.data
    emp_id = None
    if code := data.get("employeeCode"):
        found = Employee.objects.filter(employee_code__iexact=str(code).strip()).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId")

    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        # Employees can only submit for themselves
        if emp_id and str(emp_id) != str(token_emp_id):
            return Response({"error": "You can only apply Casual Leave for yourself"}, status=403)
        emp_id = token_emp_id

    if not emp_id or not data.get("date"):
        return Response({"error": "employeeId and date are required"}, status=400)

    emp = Employee.objects.filter(id=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    try:
        cl_date = date_type.fromisoformat(str(data["date"]))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)

    # Full day (the default: older apps send nothing) or one half of the shift.
    portion = str(data.get("portion") or FULL).strip().lower()
    if portion not in PORTIONS:
        return Response({"error": "Choose Full day, First half or Second half"}, status=400)

    eligible, reason = check_cl_eligibility(emp, cl_date, portion)
    if not eligible:
        return Response({"error": reason}, status=400)

    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    # An employee may only request a date in the current month (plus last month on its 1st to 5th); HR is never limited.
    if refused := enforce_employee_date(request, cl_date.isoformat()):
        return refused
    cl = CasualLeaveRequest.objects.create(
        employee=emp,
        date=cl_date,
        portion=portion,
        reason=data.get("reason"),
        approval_trail=[],
    )
    approval.notify_new_request(WORKFLOW, emp, "Casual Leave request", obj=cl)
    return Response(_cl_dict(cl), status=201)


# ── HR decision ─────────────────────────────────────────────────────────────

@api_view(["PATCH", "DELETE"])
@require_hr
def casual_leave_detail(request: Request, pk: int) -> Response:
    cl = CasualLeaveRequest.objects.select_related("employee").filter(pk=pk).first()
    if not cl:
        return Response({"error": "Casual leave request not found"}, status=404)

    if request.method == "DELETE":
        cl.delete()
        return Response({"ok": True})

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)
    # the approval right, not the edit right (hr_access.py), and only for the HR user's own branch
    if refused := hr_access.approval_refusal(request, WORKFLOW):
        return refused
    if hr_access.out_of_branch(request, cl.employee.branch_id):
        return Response({"error": "Casual leave request not found"}, status=404)

    reviewer = get_hr_display_name(request)
    try:
        resolve_casual_leave(cl, approval.HR, status_val, reviewer, request.data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    hr_access.log_decision(request, WORKFLOW, cl, status_val)
    return Response(_cl_dict(cl))


# ── Eligibility board (HR page) ─────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def casual_leave_eligibility(request: Request) -> Response:
    """Every active employee's Casual Leave standing for a month: who has taken (or asked for) it, who still can, and for
    everyone who cannot, why. Staff only by default; `?scope=all` adds production employees (never eligible, with that as
    the reason) so the HR page can name them too. Fields are only ever added to a row: older readers keep working."""
    today = ist_today()
    try:
        month = int(request.query_params.get("month", today.month))
        year = int(request.query_params.get("year", today.year))
        month_start = date_type(year, month, 1)
    except (TypeError, ValueError):
        return Response({"error": "month and year must be a valid month"}, status=400)
    month_end = date_type(year, month, calendar.monthrange(year, month)[1])
    check_date = board_reference_date(year, month, today)
    cfg = approval.get_config(WORKFLOW)
    # A month with any day on/after the cut-over follows the policy's balance; an earlier month the old one-per-month rule.
    cut_over = cl_balance.since()
    yearly = cl_balance.counts(month_end, cut_over)
    pol = cl_balance.policy()

    used_map: dict[int, CasualLeaveRequest] = {}
    month_rows: dict[int, list] = {}
    for r in scope_to_branch(
        CasualLeaveRequest.objects, request, field="employee__branch_id"
    ).filter(
        date__year=year, date__month=month, status__in=["pending", "approved"]
    ).select_related("employee").order_by("-id"):
        month_rows.setdefault(r.employee_id, []).append(r)
        # one a month is the rule, but if data ever holds two, show the approved one
        held = used_map.get(r.employee_id)
        if held is None or (held.status != "approved" and r.status == "approved"):
            used_map[r.employee_id] = r

    employees = scope_to_branch(Employee.objects, request).filter(status="active")
    if request.query_params.get("scope") != "all":
        employees = employees.filter(employment_type="staff")
    employees = list(employees.select_related("department", "designation", "branch"))

    history = {
        row["employee_id"]: row
        for row in CasualLeaveRequest.objects.filter(
            employee_id__in=[e.id for e in employees], status="approved", date__lte=month_end
        )
        .values("employee_id")
        .annotate(
            last=Max("date"),
            this_year=Count("id", filter=Q(date__year=year)),
            halves_this_year=Count("id", filter=Q(date__year=year) & ~Q(portion=FULL)),
        )
    }

    # each staff member's balance as it stands in the board's month (what may still be asked for with a date in it)
    ledgers = cl_balance.ledgers(
        [e.id for e in employees if e.employment_type == "staff"], year, cut_over=cut_over, pol=pol
    )
    balances = {i: cl_balance.balance_json(led, cut_over, today=check_date) for i, led in ledgers.items()}

    rows = []
    for emp in employees:
        joined = cl_balance.parse_join_date(emp.join_date)
        months = cl_balance.months_between(joined, check_date) if joined else None
        is_staff = emp.employment_type == "staff"
        eligible_on = cl_balance.eligible_from(joined, pol) if joined else None
        service_ok = eligible_on is not None and check_date >= eligible_on
        used = used_map.get(emp.id)
        if yearly:
            # the month's own rows still name what was taken this month; `left` comes from the policy's balance
            state = month_cl_state(month_rows.get(emp.id, []))
            state["left"] = cl_balance.left_word(ledgers[emp.id].available(month)) if is_staff else LEFT_NOTHING
            if state["left"] == LEFT_ONE_HALF and not pol.half_day:
                state["left"] = LEFT_NOTHING
        else:
            state = month_cl_state(
                [r for r in month_rows.get(emp.id, []) if not cl_balance.counts(r.date, cut_over)]
            )
        if not is_staff:
            code, reason = "not_staff", "Casual Leave is available only for staff employees"
        elif months is None:
            code, reason = "no_join_date", "Join date not set"
        elif not service_ok:
            code, reason = "under_service", service_progress(joined, check_date, pol)
        elif yearly and state["left"] == LEFT_NOTHING:
            code, reason = "no_balance", no_balance_reason(year, month if pol.monthly_mode else None, pol)
        elif state["left"] == LEFT_NOTHING:
            code, reason = "used_this_month", USED_UP if state["full"] is not None else BOTH_HALVES_USED
        else:
            # nothing used yet, or one half-day used and the other still free (still eligible: for that half)
            code, reason = None, None
        past = history.get(emp.id)
        approved_days = (
            Decimal(past["this_year"]) - Decimal(past["halves_this_year"]) / 2 if past else Decimal("0")
        )
        rows.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
            "joinDate": emp.join_date,
            "serviceMonths": months,
            # added 2026-11-21: service in days too (the policy may count days)
            "serviceDays": max(0, (check_date - joined).days) if joined else None,
            "eligible": code is None,
            "reason": reason,
            "usedThisMonth": bool(used),
            "usedStatus": used.status if used else None,
            "usedDate": str(used.date) if used else None,
            # added for the redesigned page
            "employmentType": emp.employment_type,
            "departmentId": emp.department_id,
            "branchId": emp.branch_id,
            "branch": emp.branch.name if emp.branch_id and emp.branch else None,
            "reasonCode": code,
            "eligibleFrom": str(eligible_on) if eligible_on and is_staff else None,
            "lastClDate": str(past["last"]) if past else None,
            # in days: a half-day counts 0.5
            "approvedThisYear": days_number(approved_days),
            "usedRequestId": used.id if used else None,
            "usedReviewedBy": used.reviewed_by if used else None,
            "usedReviewerRole": used.reviewer_role if used else None,
            "usedApproval": approval.progress(WORKFLOW, used, cfg) if used else None,
            # added 2026-10-31 (half-day CL): what of the month's CL is left and the parts already asked for
            "left": state["left"],
            "usedPortion": portion_of(used) if used else None,
            "usedParts": [_part_json(r) for r in sorted(month_rows.get(emp.id, []), key=lambda r: (r.date, r.id))],
            # added 2026-11-02 (yearly balance): the employee's balance for the board's year (None for production)
            "balance": balances.get(emp.id) if is_staff else None,
        })

    rows.sort(key=lambda r: (not r["eligible"], r["employeeName"]))
    policy = _policy_json(pol, cut_over)
    return Response({
        "month": month,
        "year": year,
        # the months of service the policy asks for (None when it counts days: see `policy`)
        "eligibilityMonths": policy["eligibilityMonths"],
        "referenceDate": str(check_date),
        "monthStart": str(month_start),
        "monthEnd": str(month_end),
        "counts": {
            "eligible": sum(1 for r in rows if r["eligible"]),
            "notEligible": sum(1 for r in rows if not r["eligible"]),
            "usedThisMonth": sum(1 for r in rows if r["usedThisMonth"]),
        },
        "employees": rows,
        # added 2026-11-02: which rule this month follows ("yearly_balance" = the policy's balance | "one_per_month"),
        # the cut-over day and the days a full year gives
        "rule": "yearly_balance" if yearly else "one_per_month",
        "cutOver": cut_over.isoformat(),
        "yearlyEntitlement": policy["yearlyEntitlement"],
        # added 2026-11-21: the whole policy (Settings -> Casual Leave), so the page words everything the same way
        "policy": policy,
    })


# ── Self-service eligibility (mobile / web employee apps) ────────────────────
# casual_leave_eligibility() above is HR-only (@require_hr, lists every staff
# employee) -an employee token 403s on it. This is the single-employee
# equivalent, self-scoped, reusing the same check_cl_eligibility() rule so
# the two never disagree. Also reports the year's usage and balance an
# employee actually wants to see. CL_YEARLY_ENTITLEMENT: the starting yearly
# allocation, kept only for the retired reports that import it (the policy
# decides now).
CL_YEARLY_ENTITLEMENT = 12


@api_view(["GET"])
@require_auth
def my_casual_leave_eligibility(request: Request) -> Response:
    token_emp_id = get_token_employee_id(request)
    emp_id = token_emp_id or request.query_params.get("employeeId")
    if not emp_id:
        return Response({"error": "employeeId required"}, status=400)
    emp = Employee.objects.filter(pk=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    today = ist_today()
    eligible, reason = check_cl_eligibility(emp, today)

    try:
        year = int(request.query_params.get("year") or today.year)
    except (TypeError, ValueError):
        return Response({"error": "year must be a number"}, status=400)
    cut_over = cl_balance.since()
    pol = cl_balance.policy()
    led = cl_balance.ledger(emp, year, cut_over=cut_over, pol=pol)
    balance = cl_balance.balance_json(led, cut_over, today)

    return Response({
        "eligible": eligible,
        "reason": reason,
        "year": year,
        # the days the year gives this employee (carried in + every month's days from the month they start; the year's
        # days with the yearly allocation)
        "yearlyEntitlement": cl_balance.number(led.given_through(12)) if led.start else 0,
        # in days: a half-day counts 0.5 (a whole number stays a whole number). These mirror the balance below: used =
        # approved days that count, remaining = what can still be asked for now (this month's, with the monthly
        # allocation). Casual Leave dated before the cut-over is not counted.
        "usedThisYear": balance["used"],
        "remainingThisYear": balance["remaining"],
        "months": _request_window_months(emp, pol),
        # added 2026-10-31 (half-day CL); the halves only while the policy allows half days
        "waitingThisYear": balance["pending"],
        "portions": [{"value": p, "label": PORTION_LABEL[p]} for p in PORTIONS if p == FULL or pol.half_day],
        "shift": _shift_halves_json(emp, today),
        # added 2026-11-02 (yearly balance): {total, used, pending, remaining, year, since, endsOn, cutOver, tracked, ...},
        # the year month by month, and which rule today's requests follow
        "balance": balance,
        "monthsUsage": cl_balance.month_usage(emp, year, cut_over=cut_over),
        "rule": "yearly_balance" if cl_balance.counts(today, cut_over) else "one_per_month",
        # added 2026-11-21: the policy (Settings -> Casual Leave) and whether half days may be asked for
        "policy": _policy_json(pol, cut_over),
        "halfDayAllowed": pol.half_day,
    })


def _employee_for_cl_read(request: Request):
    """(employee, None) or (None, error response): an employee token reads its own; HR passes ?employeeId= (branch
    scoped)."""
    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp = Employee.objects.filter(pk=token_emp_id).first()
    elif is_hr(request):
        raw = request.query_params.get("employeeId")
        if not raw:
            return None, Response({"error": "employeeId required"}, status=400)
        try:
            emp = scope_to_branch(Employee.objects, request).filter(pk=int(raw)).first()
        except (TypeError, ValueError):
            emp = None
    else:
        return None, Response({"error": "Access denied"}, status=403)
    if emp is None:
        return None, Response({"error": "Employee not found"}, status=404)
    return emp, None


@api_view(["GET"])
@require_auth
def casual_leave_history(request: Request) -> Response:
    """The year's Casual Leave balance as a running story ("12 → 11 on 03 Nov: Casual Leave approved (...)"), oldest first,
    with today's balance. ?year= (default this year); HR adds ?employeeId=. See cl_balance.history."""
    emp, refused = _employee_for_cl_read(request)
    if refused:
        return refused
    try:
        year = int(request.query_params.get("year") or ist_today().year)
    except (TypeError, ValueError):
        return Response({"error": "year must be a number"}, status=400)
    return Response(cl_balance.history(emp, year, today=ist_today()))


def _rule_text(pol: cl_balance.Policy, cut_over: date_type) -> str:
    """The policy in one paragraph, for the pages and the apps."""
    if pol.monthly_mode and pol.carry_forward:
        how = (
            f"earns {pol.allocation_text()}. Unused days carry forward to later months of the year with no monthly "
            "limit; a month's days cannot be used before that month"
        )
    elif pol.monthly_mode:
        how = f"gets {pol.allocation_text()}, for that month only (unused days end with the month)"
    else:
        how = f"has {cl_balance.number(pol.yearly)} days a calendar year, used any time while the balance lasts"
    half = "A half day counts 0.5." if pol.half_day else "Only full days may be taken (half days are switched off)."
    if pol.carries_into_next_year:
        cap = f" (at most {cl_balance.number(pol.year_end_cap)} days)" if pol.year_end_cap is not None else ""
        year_end = f"Unused days on 31 December move into the next year{cap}."
    else:
        year_end = "Unused days lapse on 31 December."
    return (
        f"Casual Leave is for active staff after {pol.service_text()}. Every eligible staff member {how}. {half} "
        "Waiting requests hold their days; a rejected one gives them back. Casual Leave dated before "
        f"{cut_over.strftime('%d %b %Y')} is not counted (it kept the older one per month rule). HR may turn an "
        f"employee's absent or leave days into Casual Leave from the balance (Carry Forward). {year_end}"
    )


def _policy_json(pol: cl_balance.Policy | None = None, cut_over: date_type | None = None) -> dict:
    """The Casual Leave policy as every screen reads it (the keys before 2026-11-21 kept, the policy's added)."""
    pol = pol or cl_balance.policy()
    cut_over = cut_over or cl_balance.since()
    year_days = pol.monthly * 12 if pol.monthly_mode else pol.yearly
    return {
        # the days a full year gives (12 a month x the monthly days, or the yearly days)
        "yearlyEntitlement": cl_balance.number(year_days),
        "halfDayCounts": 0.5,
        "balanceSince": cut_over.isoformat(),
        # the months of service asked for; None when the policy counts days (eligibilityBasis / eligibilityValue)
        "eligibilityMonths": pol.service if pol.basis == "months" else None,
        "staffOnly": True,
        "rule": _rule_text(pol, cut_over),
        # added 2026-11-21 (Settings -> Casual Leave)
        "eligibilityBasis": pol.basis,
        "eligibilityValue": pol.service,
        "serviceText": pol.service_text(),
        "allocation": pol.allocation,
        "monthlyAllocation": cl_balance.number(pol.monthly),
        "yearlyAllocation": cl_balance.number(pol.yearly),
        "allocationText": pol.allocation_text(),
        "carryForward": pol.carry_forward,
        "yearEnd": "carry" if pol.year_end_carry else "lapse",
        "yearEndCarryMax": cl_balance.number(pol.year_end_cap) if pol.year_end_cap is not None else None,
        "halfDayAllowed": pol.half_day,
    }


@api_view(["GET", "PUT"])
@require_hr
def casual_leave_policy(request: Request) -> Response:
    """GET: the policy and the cut-over day. PUT {balanceSince: "YYYY-MM-DD"}: change the cut-over day (Casual Leave dated
    before it never counts against the balance). Only a company-wide login may change it: the balance is one rule for
    everybody. The rest of the policy is changed on Settings -> Casual Leave (casual_leave_settings)."""
    if request.method == "PUT":
        from .branch_scope import get_branch_scope
        from .models import PayrollSettings

        if get_branch_scope(request) is not None:
            return Response(
                {"error": "The Casual Leave balance is one company-wide rule: only a login for all branches can change it."},
                status=403,
            )
        raw = request.data.get("balanceSince")
        try:
            new_since = date_type.fromisoformat(str(raw)[:10])
        except (TypeError, ValueError):
            return Response({"error": "balanceSince must be a date like 2026-11-02"}, status=400)
        if not (2000 <= new_since.year <= 2100):
            return Response({"error": "balanceSince must be a real date"}, status=400)
        ps = PayrollSettings.get()
        before = ps.cl_balance_since
        ps.cl_balance_since = new_since
        ps.save(update_fields=["cl_balance_since", "updated_at"])
        log_action(
            request, "update", "settings", record_id=ps.pk,
            description=f"Casual Leave balance start changed from {before} to {new_since}",
        )
    return Response(_policy_json())


# ── Settings -> Casual Leave (owner 2026-11-21) ───────────────────────────────

MAX_SERVICE = {"months": 120, "days": 3650}
MAX_MONTHLY = Decimal("31")
MAX_YEARLY = Decimal("366")
_POLICY_LABELS = {
    "eligibility_basis": "Service counted in",
    "eligibility_value": "Service needed",
    "allocation": "Allocation",
    "monthly_allocation": "Days a month",
    "yearly_allocation": "Days a year",
    "carry_forward": "Carry forward",
    "year_end_carry": "Unused days on 31 December move to next year",
    "year_end_carry_max": "Most days moved to next year",
    "half_day_allowed": "Half days allowed",
    "cl_balance_since": "Policy starts on",
}


def _half_days(raw, low: Decimal, high: Decimal) -> Decimal | None:
    """A number of days from `low` to `high` in whole or half days; None when it is not one."""
    if isinstance(raw, bool) or raw is None or str(raw).strip() == "":
        return None
    try:
        value = Decimal(str(raw).strip())
    except (ArithmeticError, ValueError):
        return None
    if not value.is_finite() or value < low or value > high or (value * 2) != (value * 2).to_integral_value():
        return None
    return value.quantize(Decimal("0.1"))


def _read_policy(data: dict, row, since: date_type) -> tuple[dict, dict]:
    """The policy as it would be after this save: (values by model field, errors by request key). Keys left out of `data`
    keep what is saved, so a screen may send only what it changed."""
    errors: dict[str, str] = {}
    values = {
        "eligibility_basis": row.eligibility_basis,
        "eligibility_value": row.eligibility_value,
        "allocation": row.allocation,
        "monthly_allocation": Decimal(str(row.monthly_allocation)),
        "yearly_allocation": Decimal(str(row.yearly_allocation)),
        "carry_forward": row.carry_forward,
        "year_end_carry": row.year_end_carry,
        "year_end_carry_max": Decimal(str(row.year_end_carry_max)) if row.year_end_carry_max is not None else None,
        "half_day_allowed": row.half_day_allowed,
        "cl_balance_since": since,
    }

    if "eligibilityBasis" in data:
        if data["eligibilityBasis"] in ("months", "days"):
            values["eligibility_basis"] = data["eligibilityBasis"]
        else:
            errors["eligibilityBasis"] = "Choose months or days."
    if "eligibilityValue" in data:
        raw = data["eligibilityValue"]
        try:
            count = int(str(raw).strip()) if not isinstance(raw, bool) else None
        except (TypeError, ValueError):
            count = None
        values["eligibility_value"] = count
    basis = values["eligibility_basis"]
    top = MAX_SERVICE.get(basis, 120)
    if "eligibilityBasis" not in errors and (
        values["eligibility_value"] is None or not 0 <= values["eligibility_value"] <= top
    ):
        errors["eligibilityValue"] = f"Enter a whole number of {basis} from 0 to {top}."

    if "allocation" in data:
        if data["allocation"] in ("monthly", "yearly"):
            values["allocation"] = data["allocation"]
        else:
            errors["allocation"] = "Choose monthly or yearly."
    for key, field, high, what in (
        ("monthlyAllocation", "monthly_allocation", MAX_MONTHLY, "a month"),
        ("yearlyAllocation", "yearly_allocation", MAX_YEARLY, "a year"),
    ):
        if key in data:
            value = _half_days(data[key], Decimal("0.5"), high)
            if value is None:
                errors[key] = f"Enter the days {what} from 0.5 to {high} (whole or half days)."
            else:
                values[field] = value

    for key, field in (("carryForward", "carry_forward"), ("halfDayAllowed", "half_day_allowed")):
        if key in data:
            if isinstance(data[key], bool):
                values[field] = data[key]
            else:
                errors[key] = "Turn it on or off."
    if "yearEnd" in data:
        if data["yearEnd"] in ("lapse", "carry"):
            values["year_end_carry"] = data["yearEnd"] == "carry"
        else:
            errors["yearEnd"] = "Choose lapse or carry into the next year."
    if "yearEndCarryMax" in data:
        raw = data["yearEndCarryMax"]
        if raw is None or str(raw).strip() == "":
            values["year_end_carry_max"] = None
        else:
            value = _half_days(raw, Decimal("0.5"), MAX_YEARLY)
            if value is None:
                errors["yearEndCarryMax"] = f"Enter the most days from 0.5 to {MAX_YEARLY}, or leave it empty for no limit."
            else:
                values["year_end_carry_max"] = value
    if "balanceSince" in data:
        try:
            new_since = date_type.fromisoformat(str(data["balanceSince"])[:10])
        except (TypeError, ValueError):
            new_since = None
        if new_since is None or not 2000 <= new_since.year <= 2100:
            errors["balanceSince"] = "Enter a real date, like 2026-11-02."
        else:
            values["cl_balance_since"] = new_since

    # the combinations that cannot work
    monthly = values["allocation"] == "monthly"
    if values["year_end_carry"] and monthly and not values["carry_forward"] and "yearEnd" not in errors:
        errors["yearEnd"] = (
            "Unused days can move into the next year only when they carry forward from month to month. Turn on Carry "
            "forward, or let them lapse."
        )
    if not values["half_day_allowed"]:
        whole = {
            "monthlyAllocation": values["monthly_allocation"] if monthly else None,
            "yearlyAllocation": values["yearly_allocation"] if not monthly else None,
            "yearEndCarryMax": values["year_end_carry_max"] if values["year_end_carry"] else None,
        }
        for key, value in whole.items():
            if value is not None and value != value.to_integral_value() and key not in errors:
                errors[key] = "Half days are switched off: give whole days."
    return values, errors


def _settings_json(request: Request) -> dict:
    from .branch_scope import get_branch_scope
    from .models import CasualLeavePolicy

    row = CasualLeavePolicy.objects.filter(pk=1).first()  # read-only: the row is made by the first save
    return {
        **_policy_json(),
        "updatedBy": (row.updated_by or None) if row else None,
        "updatedAt": row.updated_at.isoformat() if row and row.updated_at else None,
        # a branch login reads the policy but may not change it (one rule for the whole company)
        "canEdit": get_branch_scope(request) is None,
        "limits": {
            "monthsMax": MAX_SERVICE["months"],
            "daysMax": MAX_SERVICE["days"],
            "monthlyMax": cl_balance.number(MAX_MONTHLY),
            "yearlyMax": cl_balance.number(MAX_YEARLY),
        },
    }


def _shown(field: str, value) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None:
        return "no limit"
    if isinstance(value, Decimal):
        return str(cl_balance.number(value))
    return str(value)


@api_view(["GET", "PUT"])
@require_hr
def casual_leave_settings(request: Request) -> Response:
    """Settings -> Casual Leave: the whole policy (CasualLeavePolicy + the start day PayrollSettings.cl_balance_since).

    PUT any of {eligibilityBasis "months"|"days", eligibilityValue, allocation "monthly"|"yearly", monthlyAllocation,
    yearlyAllocation, carryForward, yearEnd "lapse"|"carry", yearEndCarryMax (null = no limit), halfDayAllowed,
    balanceSince}; keys left out keep their value. All or nothing: any error refuses the save with {error, errors: {key:
    message}}. Only a company-wide login may change it. Nothing already decided changes: an approved Casual Leave stays
    approved and paid; the policy only decides what may be asked for from now on (the balance is worked out every time).
    Gated as Settings -> Casual Leave (permission node settings.casual_leave)."""
    if request.method == "PUT":
        from .branch_scope import get_branch_scope
        from .models import CasualLeavePolicy, PayrollSettings

        if get_branch_scope(request) is not None:
            return Response(
                {"error": "The Casual Leave policy is one company-wide rule: only a login for all branches can change it."},
                status=403,
            )
        data = request.data if isinstance(request.data, dict) else {}
        row = CasualLeavePolicy.get()
        ps = PayrollSettings.get()
        values, errors = _read_policy(data, row, cl_balance.since())
        if errors:
            return Response({"error": next(iter(errors.values())), "errors": errors}, status=400)
        before = {
            "eligibility_basis": row.eligibility_basis,
            "eligibility_value": row.eligibility_value,
            "allocation": row.allocation,
            "monthly_allocation": Decimal(str(row.monthly_allocation)),
            "yearly_allocation": Decimal(str(row.yearly_allocation)),
            "carry_forward": row.carry_forward,
            "year_end_carry": row.year_end_carry,
            "year_end_carry_max": Decimal(str(row.year_end_carry_max)) if row.year_end_carry_max is not None else None,
            "half_day_allowed": row.half_day_allowed,
            "cl_balance_since": cl_balance.since(),
        }
        changed = [f for f in values if values[f] != before[f]]
        if changed:
            for field in changed:
                if field != "cl_balance_since":
                    setattr(row, field, values[field])
            row.updated_by = get_hr_display_name(request)[:150]
            row.save()
            if "cl_balance_since" in changed:
                ps.cl_balance_since = values["cl_balance_since"]
                ps.save(update_fields=["cl_balance_since", "updated_at"])
            log_action(
                request, "update", "settings", record_id=row.pk,
                description="Casual Leave policy changed: " + "; ".join(
                    f"{_POLICY_LABELS[f]} {_shown(f, before[f])} -> {_shown(f, values[f])}" for f in changed
                ),
            )
    return Response(_settings_json(request))


def _part_json(r: CasualLeaveRequest) -> dict:
    return {
        "id": r.id, "date": str(r.date), "portion": portion_of(r), "portionLabel": PORTION_LABEL[portion_of(r)],
        "status": r.status,
    }


def _request_window_months(emp: Employee, pol: cl_balance.Policy | None = None) -> list[dict]:
    """Eligibility for each month an employee may request a date in right now (request_window.py): last month ONLY while
    its grace days are open (the 1st and 2nd), then this month. Casual Leave is one per calendar month of the requested
    DATE, so on the 1st/2nd someone who has used this month's may still be eligible for last month's.

    Added 2026-10-31 (half-day CL), per month: `left` ("full" | "one_half" | "nothing"; "nothing" also when the employee
    may not take CL at all - `eligible`/`reason` say why), `usedParts` (the pending/approved requests of the month) and
    `usedHalves` (which halves of which dates are taken, so the app can disable them)."""
    window = request_window()
    this_month = (window.max.replace(day=1), window.current_month)
    open_months = [(window.min, window.previous_month), this_month] if window.grace_open else [this_month]
    cut_over = cl_balance.since()
    pol = pol or cl_balance.policy()
    year_ledgers: dict[int, cl_balance.YearLedger] = {}
    months = []
    for first, label in open_months:
        month_end = date_type(first.year, first.month, calendar.monthrange(first.year, first.month)[1])
        # Added 2026-11-02: a month with any day on/after the cut-over follows the policy's balance, and its `left` is
        # what that balance still holds for a date in the month ("full" = a whole day or more, "one_half", "nothing");
        # an earlier month keeps the old one-per-month answer.
        yearly = cl_balance.counts(month_end, cut_over)
        rows = _month_rows(emp.id, first.year, first.month)
        state = month_cl_state(rows)
        remaining = None
        used_halves = [{"date": str(r.date), "portion": portion_of(r)} for r in state["halves"]]
        used_full = [str(r.date) for r in rows if portion_of(r) == FULL]
        if yearly:
            if first.year not in year_ledgers:
                year_ledgers[first.year] = cl_balance.ledger(emp, first.year, cut_over=cut_over, pol=pol)
            led = year_ledgers[first.year]
            # asked about the month's first day that counts (an employee whose service completes mid-month starts then)
            probe = max(first, cut_over)
            if led.start is not None and (led.start.year, led.start.month) == (first.year, first.month):
                probe = max(probe, led.start)
            ok, why = check_cl_eligibility(emp, probe)
            remaining = cl_balance.number(led.available(first.month))
            left = cl_balance.left_word(remaining)
            if left == LEFT_ONE_HALF and not pol.half_day:
                left = LEFT_NOTHING
            # what holds a date includes a Casual Leave HR proposed on the Attendance Edit page that is still waiting
            held = cl_balance.parts([emp.id], first, month_end)[emp.id]
            used_halves = [{"date": p.date.isoformat(), "portion": p.portion} for p in held if p.portion != FULL]
            used_full = [p.date.isoformat() for p in held if p.portion == FULL]
        else:
            ok, why = check_cl_eligibility(emp, first)
            left = state["left"]
        months.append({
            "month": f"{first.year:04d}-{first.month:02d}", "label": label, "eligible": ok, "reason": why,
            "left": left if ok else LEFT_NOTHING,
            "usedParts": [_part_json(r) for r in rows],
            "usedHalves": used_halves,
            # added 2026-11-02: the rule of the month, the yearly days still free (None under the old rule) and the dates
            # already taken as a full day (the app greys them out)
            "rule": "yearly_balance" if yearly else "one_per_month",
            "remaining": remaining,
            "usedFullDates": used_full,
        })
    return months


def _clock(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _shift_halves_json(emp: Employee, on: date_type) -> dict | None:
    """The employee's shift on `on` split into the two halves a half-day CL can cover, for the app to show what each
    choice means in clock time. The first half ends at the shift's own first-half end (its lunch start) when HR set one,
    else at the middle of the shift; the second half starts after lunch. None without a shift."""
    from .shift_engine import _get_shift_for_date

    shift = _get_shift_for_date(emp, on)
    if shift is None or shift.start_time is None or shift.end_time is None:
        return None
    start = shift.start_time.hour * 60 + shift.start_time.minute
    end = shift.end_time.hour * 60 + shift.end_time.minute
    length = (end - start) % (24 * 60) or 24 * 60
    if shift.first_half_end is not None:
        first_end = shift.first_half_end.hour * 60 + shift.first_half_end.minute
        second_start = first_end + max(0, int(shift.lunch_duration_minutes or 0))
    else:
        first_end = second_start = start + length // 2
    return {
        "name": shift.name,
        "start": _clock(start),
        "end": _clock(end),
        "firstHalfEnd": _clock(first_end),
        "secondHalfStart": _clock(second_start),
    }
