"""
Outpass Approval -a second, parallel way to get an Outpass alongside the
QR-scan flow in outpass_visitor_views.py. An employee requests one (or an
On-Duty session generates one automatically on approval, see
geo_attendance_views.py::_create_outpass_from_on_duty), and either their HOD
or HR can approve it -approval from either side is sufficient, exactly like
EmployeePermission (leave_views.py::employee_permissions /
employee_permission_detail, manager_views.py::manager_update_permission_status).

Approving an OutpassRequest creates one OutpassRecord (via
outpass_visitor_views.py::_create_outpass_record_for) -the HR Outpass page
needs no changes at all to show it.
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, hr_access, whatsapp_approvals
from .auth import get_hr_display_name, get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .date_span import DaySpanError, parse_day_span
from . import gate_qr
from .employee_photo import employee_photo_link, photo_links
from .models import Employee, OutpassRequest
from .outpass_visitor_views import _create_outpass_record_for
from .view_common import paginate


# How long a generated return QR stays valid, mirroring the exit pass's own
# approved_at + 60min window -see _outpass_request_json's return_qr_token.
RETURN_QR_VALID_MINUTES = 60


PASS_VALID_MINUTES = 60


def is_on_duty_pass(req: OutpassRequest) -> bool:
    return req.source == OutpassRequest.SOURCE_ON_DUTY and req.on_duty_session_id is not None


def pass_window(req: OutpassRequest):
    """(valid_from, expires_at) of a pass's exit QR, or (None, None) when it has none.

    A manual pass: from its approval, for PASS_VALID_MINUTES (unchanged).
    A pass of an On-Duty request: the pass itself is raised (and shown, "Pending approval") the moment the On-Duty is
    submitted, but its QR only exists once the On-Duty is APPROVED (owner 2026-11-24, revised: no QR before HR / HOD
    approval). From that approval until the session ends or, at the latest, the end of that day (India time).
    """
    if is_on_duty_pass(req):
        from .clock import FACTORY_TZ

        if not req.approved_at:
            return None, None
        start = req.approved_at
        local = start.astimezone(FACTORY_TZ)
        day_end = local.replace(hour=23, minute=59, second=59, microsecond=0)
        session = req.on_duty_session
        ended = session.employee_ended_at or (session.completed_at if session.status == "completed" else None)
        expires = max(start, min(day_end, ended)) if ended else day_end
        return start, expires
    if req.approved_at:
        return req.approved_at, req.approved_at + timedelta(minutes=PASS_VALID_MINUTES)
    return None, None


def pass_presentable(req: OutpassRequest) -> bool:
    """Whether the pass's decision allows an exit: only an APPROVED pass (a manual one by its HOD / HR, an On-Duty one with
    its On-Duty's final approval). A pass still waiting for approval has no QR and is refused at the gate."""
    return req.status == OutpassRequest.STATUS_APPROVED


def _outpass_scan_status(req: OutpassRequest, expires_at, now) -> str:
    if req.entered_at:
        return "completed"
    if req.exited_at:
        if req.return_qr_generated_at:
            return_expires_at = req.return_qr_generated_at + timedelta(minutes=RETURN_QR_VALID_MINUTES)
            return "pending_return" if now < return_expires_at else "return_expired"
        return "exited"
    if not pass_presentable(req):
        return "not_applicable"
    if expires_at and now >= expires_at:
        return "expired_unscanned"
    return "pending_exit"


WORKFLOW = "outpass"


def _outpass_request_json(
    req: OutpassRequest, with_employee: bool = False, cfg: approval.Config | None = None, photos: dict | None = None
) -> dict:
    """`photos`: photo_links of the listed employees, when the list loaded its rows without the employee's photo."""
    valid_from, expires_at = pass_window(req)
    now = timezone.now()
    scan_status = _outpass_scan_status(req, expires_at, now)

    # The QR only ever encodes a request that is actually presentable at a
    # gate right now -once exited, expired, or never approved, it's simply
    # omitted, so a used/stale pass stops rendering a scannable code at all
    # rather than relying on the gate to reject it.
    qr_token = None
    if scan_status == "pending_exit":
        qr_token = gate_qr.pass_code(req.id, expires_at - now)

    # The return QR is never auto-computed the way the exit one is -it only
    # exists once the employee explicitly taps "Generate Return QR"
    # (generate_return_qr below), which stamps return_qr_generated_at. The
    # token embeds that same timestamp as a "generatedAt" claim so
    # resolve_gate_scan can tell a stale, since-regenerated token apart from
    # the current one even though both would otherwise still verify/decode.
    return_qr_token = None
    return_qr_expires_at = None
    if req.return_qr_generated_at:
        return_qr_expires_at = req.return_qr_generated_at + timedelta(minutes=RETURN_QR_VALID_MINUTES)
    if scan_status == "pending_return":
        return_qr_token = gate_qr.return_code(req.id, req.return_qr_generated_at, return_qr_expires_at - now)

    data = {
        "id": req.id,
        "employeeId": req.employee_id,
        "destination": req.destination,
        "reason": req.reason,
        "passType": req.pass_type,
        "expectedReturnAt": req.expected_return_at.isoformat() if req.expected_return_at else None,
        "status": req.status,
        "source": req.source,
        "approverRole": req.approver_role,
        "approvedBy": req.approved_by,
        "reviewComment": req.review_comment,
        "approvedAt": req.approved_at.isoformat() if req.approved_at else None,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "validFrom": valid_from.isoformat() if valid_from else None,
        "createdAt": req.created_at.isoformat(),
        # The On-Duty request a pass belongs to (its pass is raised the moment the On-Duty is submitted), and that
        # On-Duty's own state: the app shows "Waiting for approval" on the card while it is pending.
        "onDutySessionId": req.on_duty_session_id,
        "onDutyStatus": req.on_duty_session.status if req.on_duty_session_id else None,
        "qrToken": qr_token,
        "exitGateName": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": req.exited_at.isoformat() if req.exited_at else None,
        "entryGateName": req.entry_gate.name if req.entry_gate_id else None,
        "enteredAt": req.entered_at.isoformat() if req.entered_at else None,
        "returnQrToken": return_qr_token,
        "returnQrExpiresAt": return_qr_expires_at.isoformat() if return_qr_expires_at else None,
        "canGenerateReturnQr": bool(req.exited_at and not req.entered_at),
        "scanStatus": scan_status,
        # The approval pipeline: who it waits for now and how far it has got (approval_workflow.py). A pass raised by an
        # On-Duty approval is born approved by the system and has no pipeline of its own.
        "approval": approval.progress(WORKFLOW, req, cfg) if req.source == OutpassRequest.SOURCE_MANUAL else None,
    }
    if with_employee:
        emp = req.employee
        # employeeCode (not "code") to match _leave_with_emp/_perm_with_emp's
        # existing nested-employee convention in manager_views.py -photoUrl is
        # the one addition unique to Outpass, for the approved-pass card: a
        # signed link to the photo (employee_photo.py), never the picture itself.
        data["employee"] = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "photoUrl": employee_photo_link(emp, photos),
        }
    return data


def resolve_outpass_request(
    req: OutpassRequest, decision: str, reviewer_name: str, approver_role: str, comment: str | None,
) -> approval.Outcome:
    """One decision on an Outpass request, under the "outpass" pipeline (approval_workflow.py): `approver_role` is
    'hr' or 'dept_head', as stored. Out of the box either side is sufficient and whoever acts first is final; HR may
    change that. Raises approval.ApprovalError when that role may not decide it now (or it was already decided).

    The FINAL approval issues the pass (one OutpassRecord); a rejection is final."""
    role = approval.HR if approver_role == "hr" else approval.HOD
    outcome = approval.decide(WORKFLOW, req, role, decision, actor=reviewer_name, comment=comment)
    if outcome.final or outcome.rejected:
        req.approver_role = approver_role
        req.approved_by = reviewer_name
    if comment:
        req.review_comment = comment
    req.status = outcome.status
    if outcome.final:
        req.approved_at = timezone.now()
        req.outpass_record = _create_outpass_record_for(req.employee, req.destination, source="request")
    req.save()
    what = f"Outpass request for {req.destination}"
    approval.stage_notice(req.employee, "outpass", approval.notice_for(what, outcome), outcome)
    if outcome.kind == "advanced" and approval.HOD in outcome.waiting and role != approval.HOD:
        approval.notify_hod_of_request(WORKFLOW, req.employee, "Outpass request", req)
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            "outpass", req, decision, approver=reviewer_name, role=approver_role, comment=comment
        )
    return outcome


@api_view(["GET", "POST"])
@require_auth
def outpass_requests(request: Request) -> Response:
    if request.method == "GET":
        # the employee's photo is never read here (it can be MBs, once per row): the list sends a link to it
        qs = (
            OutpassRequest.objects.select_related(
                "employee__department", "employee__designation", "exit_gate", "entry_gate", "on_duty_session"
            )
            .defer("employee__photo_url")
            .order_by("-created_at")
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")

        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        elif emp_id := request.query_params.get("employeeId"):
            qs = qs.filter(employee_id=emp_id)
        if status := request.query_params.get("status"):
            qs = qs.filter(status=status)
            if status == "pending" and not token_emp_id and request.query_params.get("includeOnDuty") != "1":
                # HR's decision queue: an On-Duty request's pass waits for its On-Duty, not for an Outpass decision
                # (raised at submission since 2026-11-24), so it is not listed among the passes to decide.
                qs = qs.exclude(source=OutpassRequest.SOURCE_ON_DUTY)
        # Optional from / to (YYYY-MM-DD, 2026-11-24: the HR portal's date filter, date_span.py): only the passes FOR
        # those India days -the day the employee went out, or the day it was asked for while they have not gone out.
        # Without them the list is exactly as before (the newest DEFAULT_LIST_CAP).
        try:
            span = parse_day_span(request.query_params)
        except DaySpanError as exc:
            return Response({"error": str(exc)}, status=400)
        if span is not None:
            qs = qs.filter(span.instant_q("exited_at") | (Q(exited_at__isnull=True) & span.instant_q("created_at")))

        # An employee only ever sees their own -no employee{} block needed.
        # HR's list (no token_emp_id) includes it, same convention as
        # manager_pending_requests' *_with_emp() serializers.
        cfg = approval.get_config(WORKFLOW)
        photos: dict = {}
        return paginate(
            request,
            qs,
            lambda r: _outpass_request_json(r, with_employee=not token_emp_id, cfg=cfg, photos=photos),
            prepare=None if token_emp_id else lambda rows: photos.update(photo_links(r.employee_id for r in rows)),
        )

    data = request.data
    token_emp_id = get_token_employee_id(request)
    emp_id = token_emp_id or data.get("employeeId") or data.get("employee_id")
    if token_emp_id and str(token_emp_id) != str(emp_id):
        return Response({"error": "You can only submit outpass requests for yourself"}, status=403)
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)

    destination = (data.get("destination") or "").strip()
    reason = (data.get("reason") or "").strip()
    if not destination or not reason:
        return Response({"error": "destination and reason are required"}, status=400)

    pass_type = data.get("passType") or data.get("pass_type")
    if pass_type and pass_type not in dict(OutpassRequest.PASS_TYPE_CHOICES):
        return Response({"error": "Invalid passType"}, status=400)

    expected_return_at = data.get("expectedReturnAt") or data.get("expected_return_at")
    if expected_return_at:
        from django.utils.dateparse import parse_datetime
        parsed_return = parse_datetime(expected_return_at)
        if parsed_return is None:
            return Response({"error": "Invalid expectedReturnAt format (ISO 8601)"}, status=400)
        expected_return_at = parsed_return
    else:
        expected_return_at = None

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    req = OutpassRequest.objects.create(
        employee=emp, destination=destination, reason=reason,
        pass_type=pass_type, expected_return_at=expected_return_at, approval_trail=[],
    )
    approval.notify_new_request(WORKFLOW, emp, "Outpass request", obj=req)
    return Response(_outpass_request_json(req), status=201)


@api_view(["PUT"])
@require_hr
def outpass_request_hr_status(request: Request, pk: int) -> Response:
    try:
        req = OutpassRequest.objects.select_related("employee").get(pk=pk)
    except OutpassRequest.DoesNotExist:
        return Response({"error": "Outpass request not found"}, status=404)

    if is_on_duty_pass(req):
        # Its On-Duty request decides it (geo_attendance_views.resolve_on_duty_session): approve or reject the On-Duty.
        return Response(
            {"error": "This pass belongs to an On-Duty request: approve or reject the On-Duty request instead.",
             "code": "decided_with_on_duty"},
            status=409,
        )
    status = request.data.get("status")
    if status not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)
    # the approval right, not the edit right (hr_access.py), and only for the HR user's own branch
    if refused := hr_access.approval_refusal(request, WORKFLOW):
        return refused
    if hr_access.out_of_branch(request, req.employee.branch_id):
        return Response({"error": "Outpass request not found"}, status=404)

    try:
        resolve_outpass_request(req, status, get_hr_display_name(request), "hr", request.data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    hr_access.log_decision(request, WORKFLOW, req, status, f"Outpass request for {req.destination}")
    return Response(_outpass_request_json(req))


@api_view(["POST"])
@require_auth
def generate_return_qr(request: Request, pk: int) -> Response:
    """The "manual Generate Return QR button" on the employee's own Outpass
    card -self-scoped exactly like outpass_requests' POST, since this is an
    employee action on their own pass, not an HR one. Re-calling this after
    an earlier return QR already expired (or even before it expires) simply
    issues a fresh one -see the "generatedAt" claim check in
    gate_scanner_views.py::resolve_gate_scan for why that's safe."""
    token_emp_id = get_token_employee_id(request)
    req = OutpassRequest.objects.select_related("employee").filter(pk=pk).first()
    if not req:
        return Response({"error": "Outpass request not found"}, status=404)
    if token_emp_id and str(token_emp_id) != str(req.employee_id):
        return Response({"error": "You can only generate a return QR for your own outpass"}, status=403)
    if not req.exited_at:
        return Response({"error": "This Outpass hasn't been exited yet, so there's no return to record."}, status=400)
    if req.entered_at:
        return Response({"error": "This Outpass has already been marked as returned."}, status=400)

    req.return_qr_generated_at = timezone.now()
    req.save(update_fields=["return_qr_generated_at", "updated_at"])
    return Response(_outpass_request_json(req))
