import smtplib
import ssl
from datetime import date, timedelta
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, require_auth, require_hr
from .company_documents_views import build_resignation_letter_pdf
from .models import (
    Department,
    DepartmentHeadcount,
    DepartmentManager,
    Employee,
    Job,
    LeaveRequest,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    Notification,
    PayrollSettings,
    ResignationRequest,
)


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


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
    dept_id = emp.department_id

    manager_ids_from_dept = set(
        ManagerDepartmentAssignment.objects.filter(
            department_id=dept_id, manager__is_active=True, manager__can_approve_resignations=True,
        ).values_list("manager__employee_id", flat=True)
    ) if dept_id else set()

    manager_ids_direct = set(
        ManagerEmployeeAssignment.objects.filter(
            employee_id=emp.id, manager__is_active=True, manager__can_approve_resignations=True,
        ).values_list("manager__employee_id", flat=True)
    )

    all_manager_emp_ids = manager_ids_from_dept | manager_ids_direct
    for mgr_emp_id in all_manager_emp_ids:
        Notification.objects.create(
            employee_id=mgr_emp_id,
            type="resignation",
            message=f"{emp.first_name} {emp.last_name} has submitted a resignation request. Please review it.",
        )


# ── Recruitment Dashboard ─────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def recruitment_dashboard(_request: Request) -> Response:
    today = date.today()
    thirty_days_ago = today - timedelta(days=30)
    thirty_days_ago_str = thirty_days_ago.isoformat()

    total_staff = Employee.objects.filter(employment_type="staff", status="active").count()
    total_depts = Department.objects.count()

    recent_leaves = LeaveRequest.objects.filter(
        created_at__date__gte=thirty_days_ago,
        employee__employment_type="staff",
    ).count()

    new_joinees = Employee.objects.filter(
        employment_type="staff",
        status="active",
        join_date__gte=thirty_days_ago_str,
    ).count()

    open_roles = Job.objects.filter(status="open").count()
    pending_resignations = ResignationRequest.objects.filter(status="pending").count()
    dept_approved_resignations = ResignationRequest.objects.filter(status="dept_approved").count()

    departments = list(Department.objects.prefetch_related("headcount").all())
    dept_analysis = []
    total_vacancies = 0

    for dept in departments:
        current = Employee.objects.filter(
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
        Employee.objects.filter(
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
    since = (date.today() - timedelta(days=days)).isoformat()

    qs = (
        Employee.objects.filter(status="active", join_date__gte=since)
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
    qs = ResignationRequest.objects.select_related(
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
            "Cannot approve yet — the Department Head must review first. HR can only give final approval after the Department Head approves.",
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

    return Response(_resignation_json(r))


@api_view(["DELETE"])
@require_hr
def resignation_delete(request: Request, pk: int) -> Response:
    r = ResignationRequest.objects.filter(pk=pk).first()
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

    # POST — employee submits a new resignation
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
        from datetime import date as date_type
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

    dept_ids = [da.department_id for da in m.department_assignments.all()]
    direct_ids = [ea.employee_id for ea in m.employee_assignments.all()]
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

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
            message=f"Your resignation request has been reviewed and approved by your Department Head. It is now with HR for final approval.",
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
            message=f"Your resignation request has been rejected by your Department Head. Please contact them for more information.",
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

    dept_ids = [da.department_id for da in m.department_assignments.all()]
    direct_ids = [ea.employee_id for ea in m.employee_assignments.all()]
    emp_filter = Q(employee_id__in=direct_ids)
    if dept_ids:
        emp_filter |= Q(employee__department_id__in=dept_ids)

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

    ps = PayrollSettings.get()
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return _error("SMTP settings not configured. Please save SMTP settings in Settings first.", 400)

    emp = r.employee
    to_email = request.data.get("toEmail") or emp.email
    if not to_email:
        return _error("Employee has no email address. Provide toEmail in request body.", 400)

    company_name = ps.slip_company_name or "UKTextiles"
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    today = timezone.now().strftime("%d %B %Y")
    last_working = r.last_working_date.strftime("%d %B %Y") if r.last_working_date else "as mutually agreed"

    subject = f"Resignation Acceptance Letter | {company_name}"

    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a4a">
      <div style="background:#006496;padding:20px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:18px">{company_name.upper()}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">
          Resignation Acceptance Letter
        </p>
      </div>
      <div style="background:#ffffff;padding:30px;border:1px solid #d0e4f0;border-top:none">
        <p>Dear <strong>{emp_name}</strong>,</p>
        <p>
          We acknowledge receipt of your resignation and are pleased to confirm that your resignation has been
          <strong>accepted with effect from {last_working}</strong>.
        </p>
        <div style="background:#f0f5fa;padding:16px;border-radius:8px;margin:20px 0;border-left:4px solid #006496">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold;width:40%">Employee Name</td><td style="padding:4px 8px">{emp_name}</td></tr>
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold">Employee Code</td><td style="padding:4px 8px">{emp.employee_code}</td></tr>
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold">Department</td><td style="padding:4px 8px">{emp.department.name if emp.department_id and emp.department else "—"}</td></tr>
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold">Last Working Day</td><td style="padding:4px 8px">{last_working}</td></tr>
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold">Approved By</td><td style="padding:4px 8px">{r.approved_by or "HR Management"}</td></tr>
            <tr><td style="padding:4px 8px;color:#006496;font-weight:bold">Approval Date</td><td style="padding:4px 8px">{today}</td></tr>
          </table>
        </div>
        <p>
          We appreciate your valuable contributions during your tenure and wish you all the best in your future endeavors.
          Please ensure all handover formalities are completed before your last working day.
        </p>
        <p>Full and final settlement will be processed as per company policy.</p>
        <br>
        <p style="color:#888;font-size:12px">
          Warm Regards,<br>
          <strong>HR Department</strong><br>
          {company_name}
        </p>
      </div>
      <div style="background:#f0f5fa;padding:12px;text-align:center;font-size:11px;color:#888;border-radius:0 0 8px 8px">
        This is a system-generated letter from {company_name} HR Portal. Generated on {today}.
      </div>
    </div>
    """

    # Generate PDF attachment
    try:
        pdf_bytes = build_resignation_letter_pdf(r)
        emp_code = emp.employee_code
        pdf_filename = f"resignation_acceptance_{emp_code}_{r.id}.pdf"
    except Exception as pdf_err:
        pdf_bytes = None
        pdf_filename = None

    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"] = to_email

    msg.attach(MIMEText(html_body, "html"))

    if pdf_bytes:
        attachment = MIMEApplication(pdf_bytes, _subtype="pdf")
        attachment.add_header("Content-Disposition", "attachment", filename=pdf_filename)
        msg.attach(attachment)

    try:
        context = ssl.create_default_context()
        port = ps.smtp_port
        if port == 465:
            with smtplib.SMTP_SSL(ps.smtp_host, port, context=context) as server:
                server.login(ps.smtp_username, ps.smtp_password)
                server.sendmail(ps.smtp_from_email or ps.smtp_username, to_email, msg.as_string())
        else:
            with smtplib.SMTP(ps.smtp_host, port, timeout=15) as server:
                server.ehlo()
                server.starttls(context=context)
                server.login(ps.smtp_username, ps.smtp_password)
                server.sendmail(ps.smtp_from_email or ps.smtp_username, to_email, msg.as_string())
    except smtplib.SMTPAuthenticationError:
        return _error("SMTP authentication failed. Check username/password.", 502)
    except Exception as exc:
        return _error(f"Failed to send email: {exc}", 502)

    return Response({"ok": True, "sentTo": to_email, "pdfAttached": pdf_bytes is not None})


# ── Department Headcount / Required Roles ─────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def department_headcount(request: Request) -> Response:
    if request.method == "GET":
        departments = list(Department.objects.prefetch_related("headcount").all())
        result = []
        for dept in departments:
            current = Employee.objects.filter(
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
    hc = DepartmentHeadcount.objects.select_related("department").filter(pk=pk).first()
    if not hc:
        return _error("Not found", 404)

    if "requiredCount" in request.data:
        hc.required_count = int(request.data["requiredCount"])
    if "notes" in request.data:
        hc.notes = request.data["notes"]
    hc.save()

    current = Employee.objects.filter(
        department=hc.department, employment_type="staff", status="active"
    ).count()
    return Response(_dept_headcount_json(hc.department, hc, current))
