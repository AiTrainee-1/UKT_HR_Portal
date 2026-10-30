"""
Attendance Edit: the page behind the pencil on a day, and HR's second-level decision.

  GET   /api/attendance/edit-context?employeeId=&date=   everything the Attendance Edit page needs for one day
  PATCH /api/attendance/override-requests/<id>           HR's decision (approve / reject) on an edit the Department Head
                                                          has already approved

A proposal is made with POST /api/attendance/override (growth_views.attendance_day_override); the Department Head decides
it from the HOD screens (manager_views.manager_update_attendance_status). The pipeline is HOD first, then HR, both
mandatory, for every attendance type (approval_workflow.py, workflow ``attendance_correction``); the day's record is written
only when the second approval is in (attendance_edit.finalize).
"""

from __future__ import annotations

from datetime import date as date_type

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from . import attendance_edit as edit
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .attendance_final import compute_day_record
from .branch_scope import scope_to_branch
from .clock import ist_today
from .device_directory import can_edit_module
from .models import AttendanceDayRecord, AttendanceOverrideRequest, Employee, Notification
from .view_common import error_response as _error

KEY = "attendance_correction"


@api_view(["GET"])
@require_hr
def attendance_edit_context(request: Request) -> Response:
    from .growth_views import _override_request_dict, _record_dict

    qs = scope_to_branch(Employee.objects.select_related("department", "designation"), request, field="branch_id")
    try:
        emp = qs.filter(pk=int(request.query_params.get("employeeId"))).first()
    except (TypeError, ValueError):
        emp = None
    if emp is None:
        return _error("Employee not found", 404)
    try:
        d = date_type.fromisoformat(str(request.query_params.get("date"))[:10])
    except (TypeError, ValueError):
        return _error("Date must look like 2026-10-05")

    record = AttendanceDayRecord.objects.filter(employee=emp, date=d).first() or compute_day_record(emp, d)
    hod = edit.hod_of(emp)
    cfg = approval.get_config(KEY)
    requests = list(AttendanceOverrideRequest.objects.filter(employee=emp, date=d).order_by("-created_at")[:10])
    return Response(
        {
            "employee": {
                "id": emp.pk,
                "code": emp.employee_code,
                "name": f"{emp.first_name} {emp.last_name}".strip(),
                "department": emp.department.name if emp.department_id else None,
                "designation": emp.designation.title if emp.designation_id else None,
                "employmentType": emp.employment_type,
                "photoUrl": None,
            },
            "date": str(d),
            "day": _record_dict(record),
            "future": d > ist_today(),
            "hod": (
                {
                    "name": f"{hod.employee.first_name} {hod.employee.last_name}".strip(),
                    "canApprove": hod.can_approve_attendance,
                }
                if hod
                else None
            ),
            "pipeline": {
                "steps": [s.to_json() for s in cfg.steps],
                "path": approval.pipeline_text("HR", cfg.steps),
            },
            "types": edit.catalogue(),
            "punches": edit.day_punches(emp, d),
            "canEdit": can_edit_module(request, "attendance"),
            "requests": [_override_request_dict(r, cfg) for r in requests],
        }
    )


@api_view(["PATCH"])
@require_hr
def attendance_override_decision(request: Request, pk: int) -> Response:
    """HR's decision on an attendance edit: the second approval, after the Department Head's. Approving it (when the Department
    Head already has) is what changes the day's record; rejecting ends the request and changes nothing."""
    from .growth_views import _override_request_dict
    from . import whatsapp_approvals

    req = (
        scope_to_branch(
            AttendanceOverrideRequest.objects.select_related("employee__department", "employee__designation"),
            request,
            field="employee__branch_id",
        )
        .filter(pk=pk)
        .first()
    )
    if req is None:
        return _error("Request not found", 404)
    status_val = request.data.get("status")
    comment = str(request.data.get("comment") or "").strip() or None
    reviewer = get_hr_display_name(request)
    try:
        outcome = approval.decide(KEY, req, approval.HR, status_val, actor=reviewer, comment=comment)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)

    if outcome.final:
        edit.finalize(req, reviewer, request)
    req.status = outcome.status
    req.reviewed_by = reviewer
    req.reviewed_at = timezone.now()
    if comment:
        req.review_comment = comment
    req.save()

    what = f"attendance change for {req.date}"
    Notification.objects.create(
        employee=req.employee,
        type="attendance",
        message=approval.notice_for(what, outcome, final_tail=" and your attendance has been updated"),
    )
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(KEY, req, status_val, approver=reviewer, role="hr", comment=comment)
    log_action(
        request,
        "approve" if outcome.final else "reject",
        "attendance",
        record_id=req.id,
        description=f"HR {status_val} the attendance change for {req.employee.employee_code} on {req.date}",
    )
    return Response(_override_request_dict(req))
