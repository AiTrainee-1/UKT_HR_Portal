"""
Missing Punch Module
=====================
Employee self-service "I forgot to punch" request — date + time + reason,
two-stage approval: the Department Head approves first, then HR gives the
final approval (same two-stage status machine as OnDutySession, the only
other genuine HOD-then-HR workflow in this codebase — see models.py).

A HOD rejection is terminal — HR never sees it. HR only ever acts on a
request already at pending_hr (deliberately stricter than OnDutySession's
HR-fallback behavior: HR cannot short-circuit past a Department Head here).

On HR approval, resolve_missing_punch_hr() creates one ordinary
AttendanceLog row (source="missing_punch:approved") instead of overwriting
the day's AttendanceDayRecord directly — it becomes just another punch that
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

from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name
from .branch_scope import scope_to_branch
from .models import AttendanceLog, Employee, MissingPunchRequest, Notification


# ── Helpers ────────────────────────────────────────────────────────────────

def _missing_punch_dict(r: MissingPunchRequest) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
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
    }


def resolve_missing_punch_hod(req: MissingPunchRequest, decision: str, reviewer_name: str, comment: str | None) -> None:
    """Stage 1 — Department Head decision. Approval moves the request to
    pending_hr; rejection is terminal, HR never sees it."""
    req.status = MissingPunchRequest.STATUS_PENDING_HR if decision == "approved" else MissingPunchRequest.STATUS_REJECTED
    req.hod_reviewed_by = reviewer_name
    req.hod_reviewed_at = timezone.now()
    if comment:
        req.hod_review_comment = comment
    req.save()
    if decision == "approved":
        message = f"Your Missing Punch request for {req.date.isoformat()} was approved by your Department Head and is now awaiting HR approval."
    else:
        message = f"Your Missing Punch request for {req.date.isoformat()} was rejected by your Department Head."
    Notification.objects.create(employee=req.employee, type="missing_punch", message=message)


def resolve_missing_punch_hr(req: MissingPunchRequest, decision: str, reviewer_name: str, comment: str | None) -> None:
    """Stage 2 — HR's final decision. Only ever called on a request already
    at pending_hr. Approval creates the actual punch; rejection writes
    nothing to attendance."""
    if decision == "approved":
        AttendanceLog.objects.get_or_create(
            employee=req.employee, date=req.date, punch_time=req.punch_time, punch_type=req.punch_type,
            defaults={"source": "missing_punch:approved"},
        )
        req.status = MissingPunchRequest.STATUS_APPROVED
    else:
        req.status = MissingPunchRequest.STATUS_REJECTED
    req.hr_reviewed_by = reviewer_name
    req.hr_reviewed_at = timezone.now()
    if comment:
        req.hr_review_comment = comment
    req.save()
    if decision == "approved":
        message = f"Your Missing Punch request for {req.date.isoformat()} was approved by HR and has been added to your attendance."
    else:
        message = f"Your Missing Punch request for {req.date.isoformat()} was rejected by HR."
    Notification.objects.create(employee=req.employee, type="missing_punch", message=message)


# ── List / submit ────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def missing_punch_requests(request: Request) -> Response:
    if request.method == "GET":
        qs = MissingPunchRequest.objects.select_related(
            "employee__department", "employee__designation"
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
        return Response([_missing_punch_dict(r) for r in qs.order_by("-created_at")[:300]])

    # POST — submit a Missing Punch request (mobile/web app only, self-bound).
    # The mobile app's shared axios client decamelizes every JSON body to
    # snake_case before sending (src/lib/api.ts), so accept both forms for
    # every multi-word field here — same dual-key pattern every other
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

    # punchSlot (which of the day's 4 punches this is — morning check-in,
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

    req = MissingPunchRequest.objects.create(
        employee=emp, date=req_date, punch_time=punch_time, punch_type=punch_type,
        punch_slot=punch_slot or None, reason=data["reason"],
    )
    return Response(_missing_punch_dict(req), status=201)


# ── HR decision (stage 2 only) ───────────────────────────────────────────────

@api_view(["PATCH", "DELETE"])
@require_hr
def missing_punch_request_hr_status(request: Request, pk: int) -> Response:
    req = MissingPunchRequest.objects.select_related("employee").filter(pk=pk).first()
    if not req:
        return Response({"error": "Missing Punch request not found"}, status=404)

    if request.method == "DELETE":
        req.delete()
        return Response({"ok": True})

    if req.status != MissingPunchRequest.STATUS_PENDING_HR:
        if req.status == MissingPunchRequest.STATUS_PENDING_HOD:
            return Response({"error": "This request is still awaiting Department Head approval"}, status=400)
        return Response({"error": f"This request was already {req.status}"}, status=400)

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)

    reviewer = get_hr_display_name(request)
    resolve_missing_punch_hr(req, status_val, reviewer, request.data.get("comment"))
    return Response(_missing_punch_dict(req))
