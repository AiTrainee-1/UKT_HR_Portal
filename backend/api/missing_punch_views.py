"""
Missing Punch Module
=====================
Employee self-service "I forgot to punch" request -date + time + reason.

Who decides, and in what order, is the "missing_punch" pipeline of approval_workflow.py (User Management ->
Approval Workflow Control). Out of the box it is the two-stage chain it always was: the Department Head approves
first, then HR gives the final approval, and HR cannot short-circuit past a Department Head (that step is mandatory).
`status` is pending_hod / pending_hr according to who the request is waiting for now, and rejected / approved when done.

A rejection by whoever may decide is terminal. On the FINAL approval, resolve_missing_punch() creates one ordinary
AttendanceLog row (source="missing_punch:approved") instead of overwriting
the day's AttendanceDayRecord directly -it becomes just another punch that
day and flows through the normal engine (punch-order combination rule,
punctuality window, cross-midnight reattribution) exactly like a real
biometric punch would. Idempotent against double-approval because
AttendanceLog already has unique_together on
(employee, date, punch_time, punch_type).
"""

from datetime import date as date_type, time as time_type

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, whatsapp_approvals
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name
from .branch_scope import scope_to_branch
from .hod_scope import managers_to_notify
from .models import AttendanceLog, Employee, MissingPunchRequest, Notification
from .request_window import enforce_employee_date


# ── Helpers ────────────────────────────────────────────────────────────────

WORKFLOW = "missing_punch"


def _missing_punch_dict(r: MissingPunchRequest, cfg: approval.Config | None = None) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "branchId": emp.branch_id,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "date": str(r.date),
        "punchTime": r.punch_time.strftime("%H:%M") if r.punch_time else None,
        "punchType": r.punch_type,
        "punchSlot": r.punch_slot,
        "reason": r.reason,
        "status": r.status,
        "hodReviewedBy": r.hod_reviewed_by,
        "hodReviewComment": r.hod_review_comment,
        "hodReviewedAt": r.hod_reviewed_at.isoformat() if r.hod_reviewed_at else None,
        "hrReviewedBy": r.hr_reviewed_by,
        "hrReviewComment": r.hr_review_comment,
        "hrReviewedAt": r.hr_reviewed_at.isoformat() if r.hr_reviewed_at else None,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
        "approval": approval.progress(WORKFLOW, r, cfg),
    }


def _notify_hod_approvers(req: MissingPunchRequest) -> None:
    """Push a Notification to every active Department Head covering this
    employee with Missing Punch approval enabled -same submission-time
    pattern as OnDutySession's _notify_hod_approvers (geo_attendance_views.py).
    HR always sees the request too via the HR portal's pending queue (no push
    needed there -HRUser accounts aren't push-token-registered)."""
    emp = req.employee
    # The employee's ONE HOD (hod_scope.py), if allowed to act on missing-punch requests.
    for m in managers_to_notify(emp, "can_approve_missing_punch"):
        Notification.objects.create(
            employee=m.employee,
            type="missing_punch",
            message=f"{emp.first_name} {emp.last_name} submitted a Missing Punch request for {req.date.isoformat()}.",
        )


def resolve_missing_punch(
    req: MissingPunchRequest, role: str, decision: str, reviewer_name: str, comment: str | None
) -> approval.Outcome:
    """One decision by `role` ('hod' or 'hr') on a request, under the pipeline in force. Raises approval.ApprovalError
    when that role may not decide it now (already decided, or still waiting for someone else).

    An intermediate approval only passes the request to the next step; the FINAL approval creates the actual punch;
    a rejection writes nothing to attendance. WhatsApp goes out for a final decision or any rejection only."""
    outcome = approval.decide(WORKFLOW, req, role, decision, actor=reviewer_name, comment=comment)
    now = timezone.now()
    if role == approval.HOD:
        req.hod_reviewed_by, req.hod_reviewed_at = reviewer_name, now
        if comment:
            req.hod_review_comment = comment
    else:
        req.hr_reviewed_by, req.hr_reviewed_at = reviewer_name, now
        if comment:
            req.hr_review_comment = comment
    if outcome.final:
        AttendanceLog.objects.get_or_create(
            employee=req.employee, date=req.date, punch_time=req.punch_time, punch_type=req.punch_type,
            defaults={"source": "missing_punch:approved"},
        )
    req.status = outcome.status
    req.save()
    what = f"Missing Punch request for {req.date.isoformat()}"
    Notification.objects.create(
        employee=req.employee,
        type="missing_punch",
        message=approval.notice_for(what, outcome, final_tail=" and has been added to your attendance"),
    )
    if outcome.kind == "advanced" and approval.HOD in outcome.waiting and role != approval.HOD:
        _notify_hod_approvers(req)  # the request has just reached the Department Head's step
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            WORKFLOW, req, decision, approver=reviewer_name, role=approval.LEGACY_ROLE[role], comment=comment
        )
    return outcome


def resolve_missing_punch_hod(req: MissingPunchRequest, decision: str, reviewer_name: str, comment: str | None):
    """The Department Head's decision (kept under its old name for callers that predate the pipeline)."""
    return resolve_missing_punch(req, approval.HOD, decision, reviewer_name, comment)


def resolve_missing_punch_hr(req: MissingPunchRequest, decision: str, reviewer_name: str, comment: str | None):
    """HR's decision (kept under its old name for callers that predate the pipeline)."""
    return resolve_missing_punch(req, approval.HR, decision, reviewer_name, comment)


# ── List / submit ────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def missing_punch_requests(request: Request) -> Response:
    if request.method == "GET":
        qs = MissingPunchRequest.objects.select_related(
            "employee__department", "employee__designation", "employee__branch"
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        # Employees see only their own requests
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        else:
            if emp_id := request.query_params.get("employeeId"):
                qs = qs.filter(employee_id=emp_id)
            if code := request.query_params.get("employeeCode"):
                qs = qs.filter(employee__employee_code__iexact=code.strip())
        status_filter = request.query_params.get("status")
        if status_filter == "pending":
            qs = qs.filter(status__in=[MissingPunchRequest.STATUS_PENDING_HOD, MissingPunchRequest.STATUS_PENDING_HR])
        elif status_filter and status_filter != "all":
            qs = qs.filter(status=status_filter)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=int(month))
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=int(year))
        cfg = approval.get_config(WORKFLOW)
        return Response([_missing_punch_dict(r, cfg) for r in qs.order_by("-created_at")[:300]])

    # POST -submit a Missing Punch request (mobile/web app only, self-bound).
    # The mobile app's shared axios client decamelizes every JSON body to
    # snake_case before sending (src/lib/api.ts), so accept both forms for
    # every multi-word field here -same dual-key pattern every other
    # mobile-facing endpoint in this file uses (see employee_permissions).
    data = request.data
    emp_id = None
    if code := data.get("employeeCode") or data.get("employee_code"):
        found = Employee.objects.filter(employee_code__iexact=str(code).strip()).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId") or data.get("employee_id")

    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        if emp_id and str(emp_id) != str(token_emp_id):
            return Response({"error": "You can only submit a Missing Punch request for yourself"}, status=403)
        emp_id = token_emp_id

    punch_time_raw = data.get("punchTime") or data.get("punch_time")
    if not emp_id or not data.get("date") or not punch_time_raw or not data.get("reason"):
        return Response({"error": "employeeId, date, punchTime and reason are required"}, status=400)

    # punchSlot (which of the day's 4 punches this is -morning check-in,
    # lunch check-out, lunch check-in, evening check-out) is the preferred,
    # more precise input from the newer form UI: it's the single source of
    # truth for punch_type when present, so a client can never send a slot
    # and a type that disagree. Older/other callers can still send a bare
    # punchType directly (kept for backward compatibility).
    punch_slot = data.get("punchSlot") or data.get("punch_slot")
    if punch_slot:
        if punch_slot not in MissingPunchRequest.PUNCH_SLOT_TO_TYPE:
            return Response({"error": "punchSlot must be one of: morning_in, lunch_out, lunch_in, evening_out"}, status=400)
        punch_type = MissingPunchRequest.PUNCH_SLOT_TO_TYPE[punch_slot]
    else:
        punch_type = str(data.get("punchType") or data.get("punch_type") or "IN").upper()
        if punch_type not in (AttendanceLog.PUNCH_IN, AttendanceLog.PUNCH_OUT):
            return Response({"error": "punchType must be 'IN' or 'OUT'"}, status=400)

    emp = Employee.objects.filter(id=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    try:
        req_date = date_type.fromisoformat(str(data["date"]))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    try:
        h, m = str(punch_time_raw).split(":")
        punch_time = time_type(int(h), int(m))
    except Exception:
        return Response({"error": "Invalid punchTime format (HH:MM)"}, status=400)

    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    # An employee may only request a date in the current month (plus last month on its 1st and 2nd) and never a future one
    # (a punch cannot be missed tomorrow); HR is never limited.
    if refused := enforce_employee_date(request, req_date.isoformat(), no_future=True):
        return refused
    cfg = approval.get_config(WORKFLOW)
    first = cfg.steps[0].roles  # the request starts with whoever the pipeline's first step names
    req = MissingPunchRequest.objects.create(
        employee=emp, date=req_date, punch_time=punch_time, punch_type=punch_type,
        punch_slot=punch_slot or None, reason=data["reason"], status=approval.project_status(WORKFLOW, first),
        approval_trail=[],
    )
    if approval.HOD in first:
        _notify_hod_approvers(req)
    return Response(_missing_punch_dict(req, cfg), status=201)


# ── HR decision ──────────────────────────────────────────────────────────────

@api_view(["PATCH", "DELETE"])
@require_hr
def missing_punch_request_hr_status(request: Request, pk: int) -> Response:
    req = MissingPunchRequest.objects.select_related("employee").filter(pk=pk).first()
    if not req:
        return Response({"error": "Missing Punch request not found"}, status=404)

    if request.method == "DELETE":
        req.delete()
        return Response({"ok": True})

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected") and approval.is_pending(WORKFLOW, req):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    reviewer = get_hr_display_name(request)
    try:
        resolve_missing_punch(req, approval.HR, status_val, reviewer, request.data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    return Response(_missing_punch_dict(req))
