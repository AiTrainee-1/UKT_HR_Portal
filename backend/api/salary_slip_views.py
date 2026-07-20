import smtplib
import ssl
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .branch_scope import get_branch_scope, scope_to_branch
from .models import SalarySlip, PayrollSettings, LeaveBalance

MONTHS = ["","January","February","March","April","May","June",
          "July","August","September","October","November","December"]


def slip_json(s: SalarySlip, include_settings: bool = False) -> dict:
    emp = s.employee

    balances = []
    for lb in LeaveBalance.objects.select_related("leave_type").filter(employee=emp, year=s.year):
        balances.append({
            "leaveType": lb.leave_type.name,
            "leaveCode": lb.leave_type.code,
            "allocated": float(lb.allocated),
            "used": float(lb.used),
            "remaining": float(lb.remaining),
        })

    data = {
        "id": s.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "departmentName": emp.department.name if emp.department_id else None,
        "designationTitle": emp.designation.title if emp.designation_id else None,
        "fatherName": emp.father_name or "",
        "motherName": emp.mother_name or "",
        "joinDate": emp.join_date or "",
        "pfNumber": emp.pf_number or "",
        "esiNumber": emp.esi_number or "",
        "bankAccount": emp.bank_account or "",
        "bankIfsc": emp.bank_ifsc or "",
        "bankName": emp.bank_name or "",
        "employmentType": emp.employment_type,
        "payrollRunId": s.payroll_run_id,
        "month": s.month,
        "year": s.year,
        "weekNumber": s.week_number,
        "slipNumber": s.slip_number,
        "basic": float(s.basic),
        "hra": float(s.hra),
        "allowances": float(s.allowances),
        "incentives": float(s.incentives),
        "bonuses": float(s.bonuses),
        "otAmount": float(s.ot_amount),
        "grossSalary": float(s.gross_salary),
        "pfDeduction": float(s.pf_deduction),
        "esiDeduction": float(s.esi_deduction),
        "advanceDeduction": float(s.advance_deduction),
        "otherDeductions": float(s.other_deductions),
        "totalDeductions": float(s.total_deductions),
        "netSalary": float(s.net_salary),
        "workingDays": s.working_days,
        "presentDays": float(s.present_days),
        "absentDays": float(s.absent_days),
        "paidLeaveDays": float(s.paid_leave_days),
        "unpaidLeaveDays": float(s.unpaid_leave_days),
        "lateDays": s.late_days,
        "completedSessions": s.completed_sessions,
        "leaveBalances": balances,
        "generatedAt": s.generated_at.isoformat() if s.generated_at else None,
        "emailedAt": s.emailed_at.isoformat() if s.emailed_at else None,
    }

    if include_settings:
        ps = PayrollSettings.get()
        data["slipCompanyName"]    = ps.slip_company_name
        data["slipCompanyAddress"] = ps.slip_company_address
        data["minWageRate"]        = float(ps.min_wage_rate)
        data["signatureImage"]     = ps.signature_image or ""

    return data


@api_view(["GET"])
@require_hr
def salary_slips(request: Request) -> Response:
    emp_id     = request.query_params.get("employeeId")
    month      = request.query_params.get("month")
    year       = request.query_params.get("year")
    week_num   = request.query_params.get("weekNumber")
    emp_type   = request.query_params.get("employmentType")

    qs = (
        SalarySlip.objects
        .select_related("employee", "employee__department", "employee__designation")
        .order_by("-year", "-month", "employee__employee_code")
    )
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    if emp_id:   qs = qs.filter(employee_id=emp_id)
    if month:    qs = qs.filter(month=int(month))
    if year:     qs = qs.filter(year=int(year))
    if emp_type == "staff":      qs = qs.filter(week_number__isnull=True)
    elif emp_type == "production": qs = qs.filter(week_number__isnull=False)
    if week_num: qs = qs.filter(week_number=int(week_num))

    ps = PayrollSettings.get()
    settings_data = {
        "slipCompanyName":    ps.slip_company_name,
        "slipCompanyAddress": ps.slip_company_address,
        "minWageRate":        float(ps.min_wage_rate),
        "signatureImage":     ps.signature_image or "",
    }

    result = []
    for s in qs:
        d = slip_json(s, include_settings=False)
        d.update(settings_data)
        result.append(d)

    return Response(result)


@api_view(["GET"])
@require_auth
def salary_slip_detail(request: Request, pk: int) -> Response:
    try:
        s = (
            SalarySlip.objects
            .select_related("employee", "employee__department", "employee__designation")
            .get(pk=pk)
        )
    except SalarySlip.DoesNotExist:
        return Response({"error": "Not found"}, status=404)
    # Employees can only view their own salary slips
    token_emp_id = get_token_employee_id(request)
    if token_emp_id and s.employee_id != token_emp_id:
        return Response({"error": "Access denied"}, status=403)
    branch_id = get_branch_scope(request)
    if branch_id is not None and s.employee.branch_id != branch_id:
        return Response({"error": "Access denied"}, status=403)
    return Response(slip_json(s, include_settings=True))


@api_view(["POST"])
@require_hr
def email_salary_slip(request: Request, pk: int) -> Response:
    """Send a salary slip via email using stored SMTP settings."""
    try:
        s = (
            SalarySlip.objects
            .select_related("employee", "employee__department", "employee__designation")
            .get(pk=pk)
        )
    except SalarySlip.DoesNotExist:
        return Response({"error": "Slip not found"}, status=404)

    ps = PayrollSettings.get()
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return Response({"error": "SMTP settings not configured. Please save SMTP settings first."}, status=400)

    emp = s.employee
    to_email = request.data.get("toEmail") or emp.email
    if not to_email:
        return Response({"error": "Employee has no email address. Provide toEmail in request body."}, status=400)

    company_name = ps.company_name or ps.slip_company_name or "UKTextiles"
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    subject = f"Salary Slip – {MONTHS[s.month]} {s.year} | {company_name}"

    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a2e">
      <div style="background:#0E4B3A;padding:20px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:18px">{company_name.upper()}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">
          Salary Slip — {MONTHS[s.month]} {s.year}
        </p>
      </div>
      <div style="background:#ffffff;padding:30px;border:1px solid #d8e5df;border-top:none">
        <p>Dear <strong>{emp_name}</strong>,</p>
        <p>Please find attached your salary slip for <strong>{MONTHS[s.month]} {s.year}</strong>.</p>
        <p>Net amount paid: <strong>₹{float(s.net_salary):,.2f}</strong></p>
        <p style="color:#888;font-size:12px">
          This is a system-generated email. For any discrepancies, please contact HR.
        </p>
      </div>
    </div>
    """

    from .company_documents_views import build_salary_slip_pdf
    pdf_bytes = build_salary_slip_pdf(s)

    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"]    = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(html_body, "html"))

    attachment = MIMEApplication(pdf_bytes, _subtype="pdf")
    attachment.add_header("Content-Disposition", "attachment", filename=f"salary_slip_{s.slip_number}.pdf")
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
        return Response({"error": "SMTP authentication failed. Check username/password."}, status=502)
    except Exception as exc:
        return Response({"error": f"Failed to send email: {exc}"}, status=502)

    # Mark as emailed
    from django.utils import timezone
    s.emailed_at = timezone.now()
    s.save(update_fields=["emailed_at"])

    return Response({"ok": True, "sentTo": to_email})


@api_view(["GET"])
@require_auth
def employee_salary_slips(request: Request) -> Response:
    """Allow employees to view their own salary slips via mobile app."""
    emp_id = request.jwt_user.get("employeeId")
    if not emp_id:
        return Response({"error": "Employee access required"}, status=403)
    qs = (
        SalarySlip.objects
        .select_related("employee", "employee__department", "employee__designation")
        .filter(employee_id=emp_id)
        .order_by("-year", "-month")
    )
    return Response([slip_json(s) for s in qs])
