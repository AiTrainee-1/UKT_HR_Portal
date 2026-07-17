import smtplib
import ssl
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .branch_scope import get_branch_scope, scope_to_branch
from .models import SalarySlip, Employee, PayrollSettings, LeaveBalance

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


def _render_slip_html(s: SalarySlip, ps: PayrollSettings) -> str:
    """Render the wage slip as a self-contained HTML string for email."""
    emp = s.employee
    other_allowances = float(s.allowances) + float(s.incentives) + float(s.bonuses)
    last_day = 31  # simple fallback
    period = f"01/{s.month:02d}/{s.year} To {last_day:02d}/{s.month:02d}/{s.year}"
    today = datetime.now().strftime("%d-%m-%Y")
    father = (emp.father_name or "—").upper()
    join_date = emp.join_date or "—"

    balances = list(LeaveBalance.objects.select_related("leave_type").filter(employee=emp, year=s.year))
    if not balances:
        leave_rows = '<tr><td style="border:1px solid #000;padding:3px;text-align:center">Casual Leave</td><td style="border:1px solid #000;padding:3px;text-align:center">0.00</td><td style="border:1px solid #000;padding:3px;text-align:center">0.00</td><td style="border:1px solid #000;padding:3px;text-align:center">0.00</td><td style="border:1px solid #000;padding:3px;text-align:center">0.00</td></tr>'
    else:
        leave_rows = "".join(
            f'<tr><td style="border:1px solid #000;padding:3px;text-align:center">{lb.leave_type.name}</td>'
            f'<td style="border:1px solid #000;padding:3px;text-align:center">{float(lb.allocated):.2f}</td>'
            f'<td style="border:1px solid #000;padding:3px;text-align:center">{float(lb.used):.2f}</td>'
            f'<td style="border:1px solid #000;padding:3px;text-align:center">0.00</td>'
            f'<td style="border:1px solid #000;padding:3px;text-align:center">{float(lb.remaining):.2f}</td></tr>'
            for lb in balances
        )

    sig_html = f'<img src="{ps.signature_image}" style="height:40px;display:block;margin:0 auto" />' if ps.signature_image else '<div style="height:40px"></div>'

    net = float(s.net_salary)
    net_fmt = f"{net:,.2f}"

    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{{font-family:Arial,sans-serif;font-size:9pt;color:#000;background:#fff}}
  table{{border-collapse:collapse;width:100%}}
  td{{font-size:9pt;vertical-align:top}}
  .border{{border:1px solid #000;padding:3px 6px}}
</style></head>
<body>
<table style="border:2px solid #000;max-width:700px;margin:0 auto">
  <tr>
    <td colspan="2" class="border" style="text-align:center">
      <div style="font-weight:bold;font-size:14pt;letter-spacing:1px">{ps.slip_company_name}</div>
      <div style="font-size:11pt">{ps.slip_company_address}-</div>
    </td>
    <td colspan="2" class="border" style="text-align:right;white-space:nowrap">
      <strong>Period From</strong> {period}
    </td>
  </tr>
  <tr>
    <td colspan="4" class="border" style="text-align:center">
      <div style="font-weight:bold;font-size:11pt">Wage Slip / ஊதிய ரசீது &nbsp; मजदूरी पचीन</div>
      <div style="font-size:8pt">(UNDER RULE 27(2) OF THE MIN WAGES CHENNAI RULES 1953)</div>
    </td>
  </tr>
  <tr>
    <td colspan="2" class="border"><strong>Emp Code:</strong> {emp.employee_code}</td>
    <td colspan="2" class="border"><strong>Designation:</strong> {emp.designation.title if emp.designation_id else "—"}</td>
  </tr>
  <tr>
    <td colspan="2" class="border"><strong>Name:</strong> {emp.first_name} {emp.last_name}</td>
    <td colspan="2" class="border"><strong>Department:</strong> {emp.department.name if emp.department_id else "—"}</td>
  </tr>
  <tr>
    <td class="border" style="padding:0;width:30%">
      <table style="width:100%">
        <tr><td colspan="2" class="border" style="font-weight:bold">Earnings</td></tr>
        <tr><td class="border">Basic</td><td class="border" style="text-align:right">{float(s.basic):.2f}</td></tr>
        <tr><td class="border">DA</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">HRA</td><td class="border" style="text-align:right">{float(s.hra):.2f}</td></tr>
        <tr><td class="border">CA</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">EA</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">Other Allowances</td><td class="border" style="text-align:right">{other_allowances:.2f}</td></tr>
        <tr><td class="border">OT Wages</td><td class="border" style="text-align:right">{float(s.ot_amount):.2f}</td></tr>
        <tr><td class="border">PTRL</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr style="font-weight:bold"><td class="border">Total</td><td class="border" style="text-align:right">{float(s.gross_salary):.2f}</td></tr>
      </table>
    </td>
    <td class="border" style="padding:0;width:30%">
      <table style="width:100%">
        <tr><td colspan="2" class="border" style="font-weight:bold">Deductions</td></tr>
        <tr><td class="border">P.F</td><td class="border" style="text-align:right">{float(s.pf_deduction):.2f}</td></tr>
        <tr><td class="border">E.S.I</td><td class="border" style="text-align:right">{float(s.esi_deduction):.2f}</td></tr>
        <tr><td class="border">Advance</td><td class="border" style="text-align:right">{float(s.advance_deduction):.2f}</td></tr>
        <tr><td class="border">T.Advance</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">TDS</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">LOP</td><td class="border" style="text-align:right">0.00</td></tr>
        <tr><td class="border">Others</td><td class="border" style="text-align:right">{float(s.other_deductions):.2f}</td></tr>
        <tr style="font-weight:bold"><td class="border">Total</td><td class="border" style="text-align:right">{float(s.total_deductions):.2f}</td></tr>
      </table>
    </td>
    <td colspan="2" class="border" style="width:40%;font-size:8pt">
      <p><strong>Father/Husband:</strong> {father}</p>
      <p><strong>Date of Entry:</strong> {join_date}</p>
      <p><strong>Shifts Worked:</strong> {s.completed_sessions if s.week_number else float(s.present_days)}</p>
      <p><strong>OT:</strong> {float(s.ot_amount):.2f}</p>
      <p><strong>Min Rate:</strong> {float(ps.min_wage_rate):.2f}</p>
      <p><strong>PF No:</strong> {emp.pf_number or ""}</p>
      <p><strong>ESI No:</strong> {emp.esi_number or ""}</p>
      <br>
      <table style="width:100%;border-collapse:collapse;font-size:8pt">
        <tr style="background:#f0f0f0">
          <th style="border:1px solid #000;padding:2px">Leave</th>
          <th style="border:1px solid #000;padding:2px">Total</th>
          <th style="border:1px solid #000;padding:2px">Used</th>
          <th style="border:1px solid #000;padding:2px">Cur</th>
          <th style="border:1px solid #000;padding:2px">Bal</th>
        </tr>
        {leave_rows}
      </table>
    </td>
  </tr>
  <tr>
    <td colspan="2" class="border"><strong>Net Amount: ₹{net_fmt}</strong></td>
    <td colspan="2" class="border" style="text-align:right"></td>
  </tr>
  <tr>
    <td colspan="4" class="border"><strong>In Words:</strong> {_num_to_words(int(net))} ONLY</td>
  </tr>
  <tr>
    <td class="border" style="text-align:center;padding:10px 6px">
      <div style="height:36px"></div>
      <div style="font-size:8pt">Employee Signature</div>
    </td>
    <td class="border" style="text-align:center">
      <div style="font-weight:bold">Date of Payment</div>
      <div>{today}</div>
    </td>
    <td colspan="2" class="border" style="text-align:center">
      {sig_html}
      <div style="font-weight:bold">Proprietor</div>
    </td>
  </tr>
</table>
</body></html>"""


def _num_to_words(n: int) -> str:
    if n < 0:
        return "Rs. ZERO"
    ones = ["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN",
            "ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN","SEVENTEEN","EIGHTEEN","NINETEEN"]
    tens = ["","","TWENTY","THIRTY","FORTY","FIFTY","SIXTY","SEVENTY","EIGHTY","NINETY"]
    def convert(x):
        if x < 20: return ones[x]
        if x < 100: return tens[x//10] + (" " + ones[x%10] if x%10 else "")
        if x < 1000: return ones[x//100] + " HUNDRED" + (" " + convert(x%100) if x%100 else "")
        if x < 100000: return convert(x//1000) + " THOUSAND" + (" " + convert(x%1000) if x%1000 else "")
        if x < 10000000: return convert(x//100000) + " LAKH" + (" " + convert(x%100000) if x%100000 else "")
        return convert(x//10000000) + " CRORE" + (" " + convert(x%10000000) if x%10000000 else "")
    return "Rs. " + (convert(n) if n else "ZERO")


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

    subject = f"Salary Slip – {MONTHS[s.month]} {s.year} | {ps.slip_company_name}"
    html_body = _render_slip_html(s, ps)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(html_body, "html"))

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
