from datetime import date, timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import email_service, whatsapp_approvals
from .view_common import error_response as _error
from .auth import get_token_employee_id, require_auth, require_hr
from .user_settings import settings_for
from .branch_scope import scope_to_branch
from .company_documents_views import build_resignation_letter_pdf
from .clock import ist_today
from .models import (
    Department,
    DepartmentHeadcount,
    DepartmentManager,
    Employee,
    Job,
    LeaveRequest,
    Notification,
    ResignationRequest,
)


# ── Serializers ───────────────────────────────────────────────────────────────

def _resignation_json(r: ResignationRequest) -> dict:
    emp = r.employee
    dept_name = None
    if emp and emp.department_id:
        try:
            dept_name = emp.department.name
        except Exception:
            pass
    dept_head_name = None
    if r.dept_head_id:
        try:
            dh = r.dept_head
            dept_head_name = f"{dh.first_name} {dh.last_name}".strip()
        except Exception:
            pass
    return {
        "id": r.id,
        "employeeId": r.employee_id,
        "employeeName": f"{emp.first_name} {emp.last_name}".strip() if emp else None,
        "employeeCode": emp.employee_code if emp else None,
        "departmentId": emp.department_id if emp else None,
        "departmentName": dept_name,
        "reason": r.reason,
        "lastWorkingDate": r.last_working_date.isoformat() if r.last_working_date else None,
        "surveyQ1Answer": r.survey_q1_answer,
        "surveyQ2Answer": r.survey_q2_answer,
        "surveyQ3Answer": r.survey_q3_answer,
        "status": r.status,
        # Dept head stage
        "deptHeadId": r.dept_head_id,
        "deptHeadName": dept_head_name,
        "deptHeadStatus": r.dept_head_status,
        "deptHeadComment": r.dept_head_comment,
        "deptHeadApprovedAt": r.dept_head_approved_at.isoformat() if r.dept_head_approved_at else None,
        # HR stage
        "hrComment": r.hr_comment,
        "approvedBy": r.approved_by,
        "approvedAt": r.approved_at.isoformat() if r.approved_at else None,
        "rejectedBy": r.rejected_by,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def _dept_headcount_json(dept: Department, hc, current_count: int) -> dict:
    required = hc.required_count if hc else 0
    return {
        "id": hc.id if hc else None,
        "departmentId": dept.id,
        "departmentName": dept.name,
        "currentCount": current_count,
        "requiredCount": required,
        "vacancy": max(0, required - current_count),
        "notes": hc.notes if hc else None,
    }


# ── Resignation notification helpers ─────────────────────────────────────────

def _notify_dept_heads(resignation: ResignationRequest) -> None:
    """Create notification for all active dept-head managers overseeing the employee."""
    emp = resignation.employee
    if not emp:
        return
    # Only the employee's ONE HOD (hod_scope.py), and only if allowed to act on resignations.
    from .hod_scope import managers_to_notify

    for mgr in managers_to_notify(emp, "can_approve_resignations"):
        Notification.objects.create(
            employee_id=mgr.employee_id,
            type="resignation",
            message=f"{emp.first_name} {emp.last_name} has submitted a resignation request. Please review it.",
        )


# ── Recruitment Dashboard ─────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def recruitment_dashboard(request: Request) -> Response:
    today = ist_today()
    thirty_days_ago = today - timedelta(days=30)
    thirty_days_ago_str = thirty_days_ago.isoformat()

    emp_qs = scope_to_branch(Employee.objects, request)
    dept_qs = scope_to_branch(Department.objects, request)
    total_staff = emp_qs.filter(employment_type="staff", status="active").count()
    total_depts = dept_qs.count()

    recent_leaves = scope_to_branch(
        LeaveRequest.objects, request, field="employee__branch_id"
    ).filter(
        created_at__date__gte=thirty_days_ago,
        employee__employment_type="staff",
    ).count()

    new_joinees = emp_qs.filter(
        employment_type="staff",
        status="active",
        join_date__gte=thirty_days_ago_str,
    ).count()

    open_roles = scope_to_branch(
        Job.objects, request, field="department__branch_id"
    ).filter(status="open").count()
    resig_qs = scope_to_branch(ResignationRequest.objects, request, field="employee__branch_id")
    pending_resignations = resig_qs.filter(status="pending").count()
    dept_approved_resignations = resig_qs.filter(status="dept_approved").count()

    departments = list(dept_qs.prefetch_related("headcount").all())
    dept_analysis = []
    total_vacancies = 0

    for dept in departments:
        current = emp_qs.filter(
            department=dept, employment_type="staff", status="active"
        ).count()
        try:
            hc = dept.headcount
            required = hc.required_count
        except DepartmentHeadcount.DoesNotExist:
            required = 0
        vacancy = max(0, required - current)
        total_vacancies += vacancy
        dept_analysis.append({
            "departmentId": dept.id,
            "departmentName": dept.name,
            "currentCount": current,
            "requiredCount": required,
            "vacancy": vacancy,
        })

    recent_joinee_qs = (
        emp_qs.filter(
            employment_type="staff", status="active", join_date__gte=thirty_days_ago_str,
        )
        .select_related("department", "designation")
        .order_by("-join_date")[:10]
    )

    recent_leaves_detail = (
        LeaveRequest.objects.filter(
            created_at__date__gte=thirty_days_ago, employee__employment_type="staff",
        )
        .select_related("employee", "employee__department")
        .order_by("-created_at")[:10]
    )

    return Response({
        "totalStaffEmployees": total_staff,
        "totalDepartments": total_depts,
        "recentLeaves": recent_leaves,
        "newJoinees": new_joinees,
        "openRoles": open_roles,
        "pendingResignations": pending_resignations,
        "deptApprovedResignations": dept_approved_resignations,
        "positionsNeedingStaff": total_vacancies,
        "departmentAnalysis": dept_analysis,
        "recentJoineeList": [
            {
                "id": e.id,
                "name": f"{e.first_name} {e.last_name}".strip(),
                "employeeCode": e.employee_code,
                "department": e.department.name if e.department_id and e.department else None,
                "designation": e.designation.title if e.designation_id and e.designation else None,
                "joinDate": e.join_date,
                "photoUrl": e.photo_url,
            }
            for e in recent_joinee_qs
        ],
        "recentLeavesList": [
            {
                "id": lr.id,
                "employeeName": f"{lr.employee.first_name} {lr.employee.last_name}".strip(),
                "employeeCode": lr.employee.employee_code,
                "department": lr.employee.department.name if lr.employee.department_id and lr.employee.department else None,
                "type": lr.type,
                "startDate": lr.start_date,
                "endDate": lr.end_date,
                "status": lr.status,
            }
            for lr in recent_leaves_detail
        ],
    })


# ── New Joinees ─────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def new_joinees(request: Request) -> Response:
    days = int(request.query_params.get("days") or 30)
    since = (ist_today() - timedelta(days=days)).isoformat()

    qs = (
        scope_to_branch(Employee.objects, request)
        .filter(status="active", join_date__gte=since)
        .select_related("department", "designation", "branch")
        .order_by("-join_date")
    )

    return Response([
        {
            "id": e.id,
            "employeeCode": e.employee_code,
            "name": f"{e.first_name} {e.last_name}".strip(),
            "email": e.email,
            "phone": e.phone,
            "department": e.department.name if e.department_id and e.department else None,
            "designation": e.designation.title if e.designation_id and e.designation else None,
            "branchName": e.branch.name if e.branch_id and e.branch else None,
            "employmentType": e.employment_type,
            "joinDate": e.join_date,
            "photoUrl": e.photo_url,
        }
        for e in qs
    ])


# ── Resignations (HR) ─────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
def resignations(request: Request) -> Response:
    if request.method == "GET":
        return require_hr(_resignations_list)(request)
    return require_auth(_resignation_submit)(request)


def _resignations_list(request: Request) -> Response:
    status_filter = request.query_params.get("status")
    qs = scope_to_branch(
        ResignationRequest.objects, request, field="employee__branch_id"
    ).select_related(
        "employee", "employee__department", "dept_head",
    ).order_by("-created_at")
    if status_filter:
        qs = qs.filter(status=status_filter)
    return Response([_resignation_json(r) for r in qs])


def _resignation_submit(request: Request) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return _error("Employee access required", 403)

    emp = Employee.objects.filter(
        id=employee_id, employment_type="staff", status="active"
    ).first()
    if not emp:
        return _error("Employee not found or not eligible", 404)

    if ResignationRequest.objects.filter(employee_id=employee_id, status__in=["pending", "dept_approved"]).exists():
        return _error("You already have an active resignation request", 400)

    data = request.data
    last_date_raw = data.get("lastWorkingDate")
    last_date = None
    if last_date_raw:
        try:
            last_date = date.fromisoformat(str(last_date_raw))
        except ValueError:
            pass

    r = ResignationRequest.objects.create(
        employee_id=employee_id,
        reason=data.get("reason"),
        last_working_date=last_date,
        survey_q1_answer=data.get("surveyQ1Answer"),
        survey_q2_answer=data.get("surveyQ2Answer"),
        survey_q3_answer=data.get("surveyQ3Answer"),
    )
    r = ResignationRequest.objects.select_related(
        "employee", "employee__department", "dept_head",
    ).get(pk=r.pk)
    _notify_dept_heads(r)
    return Response(_resignation_json(r), status=201)


# ── HR Final Action (approve/reject) ─────────────────────────────────────────

@api_view(["PATCH"])
@require_hr
def resignation_action(request: Request, pk: int) -> Response:
    r = (
        ResignationRequest.objects.select_related("employee", "employee__department", "dept_head")
        .filter(pk=pk)
        .first()
    )
    if not r:
        return _error("Not found", 404)

    action = request.data.get("action")
    hr_comment = request.data.get("hrComment")

    if action not in ("approve", "reject"):
        return _error("action must be 'approve' or 'reject'", 400)

    if r.status == "approved":
        return _error("This resignation has already been approved", 400)
    if r.status == "rejected":
        return _error("This resignation has already been rejected", 400)

    # HR can only APPROVE if dept head has already approved
    if action == "approve" and r.status != "dept_approved":
        return _error(
            "Cannot approve yet -the Department Head must review first. HR can only give final approval after the Department Head approves.",
            400,
        )

    if action == "approve":
        r.status = "approved"
        r.approved_at = timezone.now()
        r.approved_by = request.jwt_user.get("name", "HR")
        r.hr_comment = hr_comment
        r.save()
        Employee.objects.filter(id=r.employee_id).update(status="inactive")
        Notification.objects.create(
            employee_id=r.employee_id,
            type="resignation",
            message="Your resignation has been approved by HR. Your account has been deactivated.",
        )
        whatsapp_approvals.notify_decision(
            "resignation", r, "approved", approver=r.approved_by or "", role="hr", comment=hr_comment
        )
    else:
        # HR can reject at any stage (pending or dept_approved)
        r.status = "rejected"
        r.rejected_by = "hr"
        r.hr_comment = hr_comment
        r.save()
        Notification.objects.create(
            employee_id=r.employee_id,
            type="resignation",
            message="Your resignation request has been reviewed by HR and was not approved. Please contact HR for more information.",
        )
        whatsapp_approvals.notify_decision(
            "resignation", r, "rejected", approver=request.jwt_user.get("name", ""), role="hr", comment=hr_comment
        )

    return Response(_resignation_json(r))


@api_view(["DELETE"])
@require_hr
def resignation_delete(request: Request, pk: int) -> Response:
    r = scope_to_branch(
        ResignationRequest.objects, request, field="employee__branch_id"
    ).filter(pk=pk).first()
    if not r:
        return _error("Not found", 404)
    r.delete()
    return Response(status=204)


# ── My Resignation (employee mobile) ─────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def my_resignation(request: Request) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return _error("Employee access required", 403)

    if request.method == "GET":
        r = (
            ResignationRequest.objects.select_related("employee", "employee__department", "dept_head")
            .filter(employee_id=employee_id)
            .order_by("-created_at")
            .first()
        )
        if not r:
            return Response(None)
        return Response(_resignation_json(r))

    # POST -employee submits a new resignation
    # Block if there is already a pending or dept_approved resignation
    existing = ResignationRequest.objects.filter(
        employee_id=employee_id,
        status__in=["pending", "dept_approved"],
    ).first()
    if existing:
        return _error("You already have a resignation request in progress.", 400)

    data = request.data
    reason = data.get("reason") or data.get("reason")
    if not reason:
        return _error("reason is required", 400)

    last_working_date_raw = data.get("last_working_date") or data.get("lastWorkingDate")
    last_working_date = None
    if last_working_date_raw:
        try:
            from django.utils.dateparse import parse_date
            last_working_date = parse_date(str(last_working_date_raw))
        except Exception:
            pass

    r = ResignationRequest.objects.create(
        employee_id=employee_id,
        reason=reason,
        last_working_date=last_working_date,
        survey_q1_answer=data.get("survey_q1_answer") or data.get("surveyQ1Answer"),
        survey_q2_answer=data.get("survey_q2_answer") or data.get("surveyQ2Answer"),
        survey_q3_answer=data.get("survey_q3_answer") or data.get("surveyQ3Answer"),
        status="pending",
    )
    r.refresh_from_db()
    r = ResignationRequest.objects.select_related(
        "employee", "employee__department", "dept_head"
    ).get(pk=r.pk)
    _notify_dept_heads(r)
    return Response(_resignation_json(r), status=201)


# ── Department Head Mobile Action ─────────────────────────────────────────────

@api_view(["PATCH"])
@require_auth
def manager_resignation_action(request: Request, pk: int) -> Response:
    """Dept head approves or rejects a resignation from the mobile app."""
    from django.db.models import Q

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return _error("Employee authentication required", 403)

    try:
        m = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return _error("Not a department manager", 403)

    if not m.can_approve_resignations:
        return _error(
            "Approve-resignation permission is disabled for your account. Ask HR to enable it.",
            403,
        )

    # The employees this HOD REALLY oversees: one HOD per employee (hod_scope.py).
    from .hod_scope import managed_employee_ids

    emp_filter = Q(employee_id__in=managed_employee_ids(m))
    # A head never decides their own request.
    emp_filter &= ~Q(employee_id=token_emp_id)

    r = (
        ResignationRequest.objects.select_related("employee", "employee__department", "dept_head")
        .filter(emp_filter)
        .filter(pk=pk)
        .first()
    )
    if not r:
        return _error("Resignation request not found or not in your scope", 404)

    if r.status != "pending":
        return _error("This resignation has already been reviewed", 400)

    action = request.data.get("action")
    comment = request.data.get("comment")

    if action not in ("approve", "reject"):
        return _error("action must be 'approve' or 'reject'", 400)

    dept_head_emp = Employee.objects.filter(id=token_emp_id).first()

    if action == "approve":
        r.dept_head_status = "approved"
        r.dept_head = dept_head_emp
        r.dept_head_comment = comment
        r.dept_head_approved_at = timezone.now()
        r.status = "dept_approved"
        r.save()
        Notification.objects.create(
            employee_id=r.employee_id,
            type="resignation",
            message="Your resignation request has been reviewed and approved by your Department Head. It is now with HR for final approval.",
        )
    else:
        r.dept_head_status = "rejected"
        r.dept_head = dept_head_emp
        r.dept_head_comment = comment
        r.dept_head_approved_at = timezone.now()
        r.status = "rejected"
        r.rejected_by = "dept_head"
        r.save()
        Notification.objects.create(
            employee_id=r.employee_id,
            type="resignation",
            message="Your resignation request has been rejected by your Department Head. Please contact them for more information.",
        )
        whatsapp_approvals.notify_decision(
            "resignation", r, "rejected",
            approver=f"{dept_head_emp.first_name} {dept_head_emp.last_name}".strip() if dept_head_emp else "",
            role="dept_head", comment=comment,
        )

    return Response(_resignation_json(r))


# ── Dept head pending resignations (mobile) ───────────────────────────────────

@api_view(["GET"])
@require_auth
def manager_pending_resignations(request: Request) -> Response:
    from django.db.models import Q

    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return _error("Employee authentication required", 403)

    try:
        m = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=token_emp_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        return _error("Not a department manager", 403)

    # The employees this HOD REALLY oversees: one HOD per employee (hod_scope.py).
    from .hod_scope import managed_employee_ids

    emp_filter = Q(employee_id__in=managed_employee_ids(m))

    status_filter = request.query_params.get("status", "pending")
    qs = ResignationRequest.objects.select_related(
        "employee", "employee__department", "dept_head"
    ).filter(emp_filter)
    if status_filter != "all":
        qs = qs.filter(status=status_filter)
    qs = qs.order_by("-created_at")

    return Response([_resignation_json(r) for r in qs])


# ── PDF Generation ────────────────────────────────────────────────────────────
# Resignation Letter PDF is built by company_documents_views.build_resignation_letter_pdf()
# (shared premium reportlab engine, themeable from Settings → Company Documents).


@api_view(["GET"])
@require_hr
def resignation_pdf(request: Request, pk: int) -> Response:
    from django.http import HttpResponse

    r = (
        ResignationRequest.objects.select_related(
            "employee", "employee__department", "employee__designation", "dept_head"
        )
        .filter(pk=pk)
        .first()
    )
    if not r:
        return _error("Not found", 404)

    if r.status != "approved":
        return _error("PDF is only available for approved resignations", 400)

    pdf_bytes = build_resignation_letter_pdf(r)
    emp_code = r.employee.employee_code if r.employee else "emp"
    filename = f"resignation_acceptance_{emp_code}_{r.id}.pdf"

    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@api_view(["POST"])
@require_hr
def resignation_email(request: Request, pk: int) -> Response:
    r = (
        ResignationRequest.objects.select_related(
            "employee", "employee__department", "employee__designation", "dept_head"
        )
        .filter(pk=pk)
        .first()
    )
    if not r:
        return _error("Not found", 404)

    if r.status != "approved":
        return _error("Email is only available for approved resignations", 400)

    ps = settings_for(request)
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return _error("SMTP settings not configured. Please save SMTP settings in Settings first.", 400)

    emp = r.employee
    to_email = request.data.get("toEmail") or emp.email
    if not to_email:
        return _error("Employee has no email address. Provide toEmail in request body.", 400)

    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    today = timezone.now().strftime("%d %B %Y")
    last_working = r.last_working_date.strftime("%d %B %Y") if r.last_working_date else "as mutually agreed"

    # Generate PDF attachment
    try:
        pdf_bytes = build_resignation_letter_pdf(r)
    except Exception:
        pdf_bytes = None
    attachments = (
        [(f"resignation_acceptance_{emp.employee_code}_{r.id}.pdf", pdf_bytes, "application/pdf")] if pdf_bytes else []
    )

    log = email_service.send_email(
        "resignation_letter",
        to_email=to_email,
        params={
            "employee_name": emp_name,
            "employee_code": emp.employee_code,
            "department": emp.department.name if emp.department_id and emp.department else "—",
            "last_working_day": last_working,
            "approved_by": r.approved_by or "HR Management",
            "approval_date": today,
        },
        ps=ps,
        recipient_name=emp_name,
        employee=emp,
        attachments=attachments,
        ref_id=r.id,
        sent_by_id=request.jwt_user.get("hrUserId"),
    )
    if log.status != email_service.EMAIL_SENT:
        return _error(log.error_message, log.http_status)
    return Response({"ok": True, "sentTo": to_email, "pdfAttached": pdf_bytes is not None})


@api_view(["POST"])
@require_hr
def resignation_whatsapp(request: Request, pk: int) -> Response:
    from . import whatsapp_service

    if not whatsapp_service.is_configured():
        return _error("WhatsApp is not configured on this server (missing credentials in .env).", 400)

    r = (
        ResignationRequest.objects.select_related(
            "employee", "employee__department", "employee__designation", "dept_head"
        )
        .filter(pk=pk)
        .first()
    )
    if not r:
        return _error("Not found", 404)
    if r.status != "approved":
        return _error("WhatsApp send is only available for approved resignations", 400)

    emp = r.employee
    pdf_bytes = build_resignation_letter_pdf(r)
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    last_working = r.last_working_date.strftime("%d %B %Y") if r.last_working_date else "as mutually agreed"

    log = whatsapp_service.send_document(
        request, emp, "resignation_letter", pdf_bytes, f"resignation_acceptance_{emp.employee_code}_{r.id}.pdf",
        body_params=[emp_name, last_working],
        document_ref_id=r.id, sent_by_id=request.jwt_user.get("hrUserId"),
    )
    if log.status != "sent":
        return _error(log.error_message, 400)
    return Response({"ok": True, "sentTo": log.phone_number})


# ── Department Headcount / Required Roles ─────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def department_headcount(request: Request) -> Response:
    if request.method == "GET":
        departments = list(
            scope_to_branch(Department.objects, request).prefetch_related("headcount").all()
        )
        emp_qs = scope_to_branch(Employee.objects, request)
        result = []
        for dept in departments:
            current = emp_qs.filter(
                department=dept, employment_type="staff", status="active"
            ).count()
            try:
                hc = dept.headcount
            except DepartmentHeadcount.DoesNotExist:
                hc = None
            result.append(_dept_headcount_json(dept, hc, current))
        return Response(result)

    dept_id = request.data.get("departmentId")
    if not dept_id:
        return _error("departmentId is required")
    dept = Department.objects.filter(id=dept_id).first()
    if not dept:
        return _error("Department not found", 404)

    hc, created = DepartmentHeadcount.objects.get_or_create(department=dept)
    hc.required_count = int(request.data.get("requiredCount", 0))
    hc.notes = request.data.get("notes")
    hc.save()

    current = Employee.objects.filter(
        department=dept, employment_type="staff", status="active"
    ).count()
    return Response(_dept_headcount_json(dept, hc, current), status=201 if created else 200)


@api_view(["PATCH"])
@require_hr
def department_headcount_detail(request: Request, pk: int) -> Response:
    hc = scope_to_branch(
        DepartmentHeadcount.objects, request, field="department__branch_id"
    ).select_related("department").filter(pk=pk).first()
    if not hc:
        return _error("Not found", 404)

    if "requiredCount" in request.data:
        hc.required_count = int(request.data["requiredCount"])
    if "notes" in request.data:
        hc.notes = request.data["notes"]
    hc.save()

    current = scope_to_branch(Employee.objects, request).filter(
        department=hc.department, employment_type="staff", status="active"
    ).count()
    return Response(_dept_headcount_json(hc.department, hc, current))
