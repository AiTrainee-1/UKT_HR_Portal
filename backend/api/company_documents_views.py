"""
Company Documents — Offer Letter, Experience Letter, Salary Slip
==================================================================
Backend-rendered (reportlab) PDF generation + per-document Settings, mirroring
the existing Resignation Letter pattern (recruitment_views.py) and the
IdCardSettings settings pattern (system_settings_views.py).

Offer Letter and Experience Letter are generated on demand from an existing
Employee record (there is no separate "candidate" table in this system) —
a couple of fields that aren't stored on Employee (last working day, etc.)
are accepted as optional query params at generation time and are not persisted.
"""
import io
import smtplib
import ssl
from datetime import date
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from django.http import HttpResponse
from django.utils import timezone
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import HRFlowable, Image as RLImage, Paragraph, Spacer, Table, TableStyle
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, is_hr, require_auth, require_hr
from .branch_scope import get_branch_scope
from .document_pdf import (
    FONT_BODY, FONT_BODY_BOLD, _decode_b64_image, _hex, company_header,
    fmt_date, full_name, new_premium_document, num_to_words, PremiumPageDecorator, rupee,
    signature_block, styles_for, title_block,
)
from .models import CompanyDocumentSettings, Employee, LeaveBalance, PayrollSettings, SalarySlip


# ── Settings ─────────────────────────────────────────────────────────────

def _settings_dict(s: CompanyDocumentSettings) -> dict:
    return {
        "docType": s.doc_type,
        "primaryColor": s.primary_color,
        "accentColor": s.accent_color,
        "headingStyle": s.heading_style,
        "showWatermark": s.show_watermark,
        "footerTagline": s.footer_tagline,
        "logoOverride": s.logo_override or "",
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_auth
def document_settings_view(request: Request, doc_type: str) -> Response:
    valid_types = {v for v, _ in CompanyDocumentSettings.DOC_TYPES}
    if doc_type not in valid_types:
        return Response({"error": "Unknown document type"}, status=404)

    s = CompanyDocumentSettings.get(doc_type)
    if request.method == "GET":
        return Response(_settings_dict(s))

    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    data = request.data
    field_map = {
        "primaryColor": "primary_color",
        "accentColor": "accent_color",
        "headingStyle": "heading_style",
        "footerTagline": "footer_tagline",
    }
    for json_key, attr in field_map.items():
        if json_key in data:
            setattr(s, attr, data[json_key])
    if "showWatermark" in data:
        s.show_watermark = bool(data["showWatermark"])
    if "logoOverride" in data:
        s.logo_override = data["logoOverride"] or None
    s.save()
    return Response(_settings_dict(s))


@api_view(["GET"])
@require_auth
def document_settings_list(request: Request) -> Response:
    return Response([_settings_dict(CompanyDocumentSettings.get(dt)) for dt, _ in CompanyDocumentSettings.DOC_TYPES])


SAMPLE_EMPLOYEE_KWARGS = dict(
    employee_code="SAMPLE-001", first_name="Priya", last_name="Sharma",
    address="12 MG Road, Coimbatore, Tamil Nadu - 641001",
    join_date="2024-01-15", salary_type="monthly", salary_amount=25000,
    father_name="Ganesan R", pf_number="TN/12345/678", esi_number="3412345678",
)


@api_view(["GET"])
@require_hr
def document_settings_preview(request: Request, doc_type: str) -> Response:
    """Renders a sample PDF (unsaved dummy employee/slip, never hits real records)
    so HR can see the effect of theme changes from the Settings page."""
    valid_types = {v for v, _ in CompanyDocumentSettings.DOC_TYPES}
    if doc_type not in valid_types:
        return Response({"error": "Unknown document type"}, status=404)

    sample_emp = Employee(**SAMPLE_EMPLOYEE_KWARGS)

    if doc_type == CompanyDocumentSettings.DOC_TYPE_OFFER_LETTER:
        pdf_bytes = build_offer_letter_pdf(sample_emp, {})
    elif doc_type == CompanyDocumentSettings.DOC_TYPE_EXPERIENCE_LETTER:
        pdf_bytes = build_experience_letter_pdf(sample_emp, {"lastWorkingDate": "2026-06-30"})
    elif doc_type == CompanyDocumentSettings.DOC_TYPE_RESIGNATION_LETTER:
        from .models import ResignationRequest
        sample_r = ResignationRequest(
            employee=sample_emp, last_working_date=date(2026, 6, 30),
            status="approved", approved_by="HR Management", approved_at=timezone.now(),
        )
        sample_r.id = 1
        pdf_bytes = build_resignation_letter_pdf(sample_r)
    else:
        sample_slip = SalarySlip(
            employee=sample_emp, month=7, year=2026, slip_number="SAMPLE-PREVIEW",
            basic=18000, hra=2000, allowances=1500, incentives=0, bonuses=0,
            ot_amount=500, gross_salary=22000, pf_deduction=2160, esi_deduction=165,
            advance_deduction=0, other_deductions=0, total_deductions=2325,
            net_salary=19675, present_days=26, completed_sessions=0,
        )
        pdf_bytes = build_salary_slip_pdf(sample_slip)

    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    response["Content-Disposition"] = 'inline; filename="preview.pdf"'
    return response


# ── Offer Letter ─────────────────────────────────────────────────────────

def build_offer_letter_pdf(emp: Employee, opts: dict) -> bytes:
    ps = PayrollSettings.get()
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_OFFER_LETTER)
    st = styles_for(ds.heading_style, _hex(ds.primary_color, "#0E4B3A"))
    today = timezone.now().strftime("%d %B %Y")
    company_name = ps.company_name or "UK Textiles"

    joining_date = opts.get("joiningDate") or emp.join_date or "the mutually agreed date"
    probation_months = opts.get("probationMonths") or 3
    working_hours = opts.get("workingHours") or "9:00 AM to 6:00 PM, Monday to Saturday"
    dept_name = emp.department.name if emp.department_id and emp.department else "the concerned department"
    desig_title = emp.designation.title if emp.designation_id and emp.designation else "the offered role"
    if emp.reporting_manager_id and emp.reporting_manager:
        rm = emp.reporting_manager
        rm_title = rm.designation.title if rm.designation_id and rm.designation else ""
        manager_line = full_name(rm) + (f" ({rm_title})" if rm_title else "")
    else:
        manager_line = "the Department Head"

    if opts.get("ctcNote"):
        comp_note = opts["ctcNote"]
    elif emp.salary_type == "monthly" and emp.salary_amount:
        comp_note = f"a monthly consolidated salary of {rupee(emp.salary_amount)}, subject to applicable statutory deductions"
    elif emp.salary_per_shift:
        comp_note = f"a per-shift wage of {rupee(emp.salary_per_shift)}, subject to applicable statutory deductions"
    else:
        comp_note = "a compensation package to be communicated separately by HR"

    buffer = io.BytesIO()
    decorator = PremiumPageDecorator(ds, ps, footer_note=f"This is a system-generated offer letter from the {company_name} HR Portal.")
    doc = new_premium_document(buffer, decorator)

    story = []
    company_header(story, ps, ds, st)
    title_block(story, "OFFER LETTER", st, decorator.accent)

    story.append(Paragraph(f"Date: {today}", st["body"]))
    story.append(Spacer(1, 0.25 * cm))
    story.append(Paragraph(f"<b>{full_name(emp)}</b>", st["bodyBold"]))
    if emp.address:
        story.append(Paragraph(emp.address, st["body"]))
    story.append(Spacer(1, 0.25 * cm))
    story.append(Paragraph(f"<b>Subject: Offer of Employment - {desig_title}</b>", st["bodyBold"]))
    story.append(Spacer(1, 0.3 * cm))

    story.append(Paragraph(f"Dear {emp.first_name},", st["body"]))
    story.append(Spacer(1, 0.2 * cm))

    paragraphs = [
        (
            f"We are pleased to offer you employment with {company_name}. This letter sets out the terms of "
            f"your appointment, which we trust you will find to be in order."
        ),
        (
            f"You are being offered the position of <b>{desig_title}</b> in the <b>{dept_name}</b>, reporting to "
            f"<b>{manager_line}</b>. Your date of joining will be <b>{fmt_date(joining_date)}</b>."
        ),
        (
            f"Your compensation will comprise {comp_note}, payable in accordance with the Company's standard "
            f"payroll cycle."
        ),
        (
            f"Your standard working hours will be {working_hours}, subject to change as per operational "
            f"requirements and applicable labour regulations."
        ),
        (
            f"You will be on probation for a period of <b>{probation_months} months</b> from your date of joining, "
            f"during which your performance and conduct will be reviewed prior to confirmation."
        ),
        (
            "You will be required to abide by the Company's policies, code of conduct, and applicable rules and "
            "regulations as amended from time to time, copies of which will be made available to you."
        ),
        (
            "You agree to maintain strict confidentiality regarding the Company's business, operations, and "
            "proprietary information, both during and after your employment."
        ),
        (
            "Kindly confirm your acceptance of this offer by signing and returning a copy of this letter on or "
            "before your date of joining."
        ),
        (
            f"We look forward to welcoming you to the {company_name} family and to a long and mutually rewarding "
            f"association."
        ),
    ]
    for p in paragraphs:
        story.append(Paragraph(p, st["body"]))
        story.append(Spacer(1, 0.22 * cm))

    story.append(Spacer(1, 0.4 * cm))
    signature_block(story, ps, st)

    doc.build(story)
    return buffer.getvalue()


@api_view(["GET"])
@require_hr
def offer_letter_pdf(request: Request, employee_id: int) -> Response:
    emp = (
        Employee.objects
        .select_related("department", "designation", "reporting_manager", "reporting_manager__designation")
        .filter(pk=employee_id).first()
    )
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    opts = {
        "joiningDate": request.query_params.get("joiningDate"),
        "probationMonths": request.query_params.get("probationMonths"),
        "workingHours": request.query_params.get("workingHours"),
        "ctcNote": request.query_params.get("ctcNote"),
    }
    pdf_bytes = build_offer_letter_pdf(emp, opts)
    filename = f"offer_letter_{emp.employee_code}.pdf"
    disposition = "inline" if request.query_params.get("preview") else "attachment"
    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return response


@api_view(["POST"])
@require_hr
def offer_letter_email(request: Request, employee_id: int) -> Response:
    emp = (
        Employee.objects
        .select_related("department", "designation", "reporting_manager", "reporting_manager__designation")
        .filter(pk=employee_id).first()
    )
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    ps = PayrollSettings.get()
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return Response({"error": "SMTP settings not configured. Please save SMTP settings in Settings first."}, status=400)

    to_email = request.data.get("toEmail") or emp.email
    if not to_email:
        return Response({"error": "Employee has no email address. Provide toEmail in request body."}, status=400)

    company_name = ps.company_name or "UKTextiles"
    emp_name = full_name(emp)
    desig_title = emp.designation.title if emp.designation_id and emp.designation else "your new role"

    opts = {
        "joiningDate": request.data.get("joiningDate"),
        "probationMonths": request.data.get("probationMonths"),
        "workingHours": request.data.get("workingHours"),
        "ctcNote": request.data.get("ctcNote"),
    }
    pdf_bytes = build_offer_letter_pdf(emp, opts)
    pdf_filename = f"offer_letter_{emp.employee_code}.pdf"

    subject = f"Offer of Employment — {desig_title} | {company_name}"
    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a2e">
      <div style="background:#0E4B3A;padding:20px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:18px">{company_name.upper()}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">Offer of Employment</p>
      </div>
      <div style="background:#ffffff;padding:30px;border:1px solid #d8e5df;border-top:none">
        <p>Dear <strong>{emp_name}</strong>,</p>
        <p>
          We are pleased to share your offer of employment as <strong>{desig_title}</strong> with
          {company_name}. Please find the detailed offer letter attached.
        </p>
        <p style="color:#888;font-size:12px">
          This is a system-generated email from the {company_name} HR Portal.
        </p>
      </div>
    </div>
    """

    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

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
        return Response({"error": "SMTP authentication failed. Check username/password."}, status=502)
    except Exception as exc:
        return Response({"error": f"Failed to send email: {exc}"}, status=502)

    return Response({"ok": True, "sentTo": to_email, "pdfAttached": True})


# ── Experience Letter ───────────────────────────────────────────────────

def build_experience_letter_pdf(emp: Employee, opts: dict) -> bytes:
    ps = PayrollSettings.get()
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_EXPERIENCE_LETTER)
    st = styles_for(ds.heading_style, _hex(ds.primary_color, "#0E4B3A"))
    today = timezone.now().strftime("%d %B %Y")
    company_name = ps.company_name or "UK Textiles"

    cert_number = opts.get("certificateNumber") or f"EXP/{emp.employee_code}/{timezone.now().strftime('%Y%m')}"
    last_working = opts.get("lastWorkingDate") or timezone.now().strftime("%Y-%m-%d")
    dept_name = emp.department.name if emp.department_id and emp.department else "—"
    desig_title = emp.designation.title if emp.designation_id and emp.designation else "—"
    nature_of_work = opts.get("natureOfWork") or (
        f"discharging the duties and responsibilities of {desig_title} in the {dept_name} department"
    )
    performance_note = opts.get("performanceNote") or (
        "sincere, dedicated, and consistently performed to the satisfaction of the management"
    )

    buffer = io.BytesIO()
    decorator = PremiumPageDecorator(ds, ps, footer_note=f"This is a system-generated certificate from the {company_name} HR Portal.")
    doc = new_premium_document(buffer, decorator)

    story = []
    company_header(story, ps, ds, st)
    title_block(story, "WORK EXPERIENCE CERTIFICATE", st, decorator.accent)

    story.append(Paragraph(f"Certificate No: {cert_number}   •   Date: {today}", st["certMeta"]))
    story.append(Spacer(1, 0.5 * cm))

    story.append(Paragraph("TO WHOMSOEVER IT MAY CONCERN", st["bodyBold"]))
    story.append(Spacer(1, 0.3 * cm))

    paragraphs = [
        (
            f"This is to certify that <b>{full_name(emp)}</b> (Employee ID: <b>{emp.employee_code}</b>) was employed "
            f"with {company_name} as <b>{desig_title}</b> in the <b>{dept_name}</b> department, from "
            f"<b>{fmt_date(emp.join_date)}</b> to <b>{fmt_date(last_working)}</b>."
        ),
        f"During this period, {emp.first_name} was responsible for {nature_of_work}.",
        (
            f"We found {emp.first_name} to be {performance_note}, and maintained professional conduct and "
            f"discipline throughout the tenure of employment with us."
        ),
        (
            f"We place on record our appreciation for the contribution made by {emp.first_name} to the organisation "
            f"and wish them continued success in all future professional endeavours."
        ),
        "This certificate is issued upon the request of the employee for whatever purpose it may serve them best.",
    ]
    for p in paragraphs:
        story.append(Paragraph(p, st["body"]))
        story.append(Spacer(1, 0.22 * cm))

    story.append(Spacer(1, 0.5 * cm))
    signature_block(story, ps, st, sub="Company Seal")

    doc.build(story)
    return buffer.getvalue()


@api_view(["GET"])
@require_hr
def experience_letter_pdf(request: Request, employee_id: int) -> Response:
    emp = Employee.objects.select_related("department", "designation").filter(pk=employee_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    opts = {
        "lastWorkingDate": request.query_params.get("lastWorkingDate"),
        "certificateNumber": request.query_params.get("certificateNumber"),
        "natureOfWork": request.query_params.get("natureOfWork"),
        "performanceNote": request.query_params.get("performanceNote"),
    }
    pdf_bytes = build_experience_letter_pdf(emp, opts)
    filename = f"experience_letter_{emp.employee_code}.pdf"
    disposition = "inline" if request.query_params.get("preview") else "attachment"
    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return response


# ── Salary Slip ──────────────────────────────────────────────────────────

def _make_qr_image(payload: str):
    try:
        import qrcode
        qr = qrcode.QRCode(box_size=4, border=1)
        qr.add_data(payload)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return RLImage(buf, width=2 * cm, height=2 * cm)
    except Exception:
        return None


def build_salary_slip_pdf(s: SalarySlip) -> bytes:
    ps = PayrollSettings.get()
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP)
    st = styles_for(ds.heading_style, _hex(ds.primary_color, "#0E4B3A"))
    primary = _hex(ds.primary_color, "#0E4B3A")
    accent = _hex(ds.accent_color, "#C9A227")
    emp = s.employee
    MONTHS = ["", "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December"]
    period_label = f"{MONTHS[s.month]} {s.year}" + (f" — Week {s.week_number}" if s.week_number else "")

    other_allowances = float(s.allowances) + float(s.incentives) + float(s.bonuses)
    shifts_worked = s.completed_sessions if s.week_number else float(s.present_days)
    balances = (
        list(LeaveBalance.objects.select_related("leave_type").filter(employee=emp, year=s.year))
        if emp.pk else []
    )

    buffer = io.BytesIO()
    decorator = PremiumPageDecorator(ds, ps, footer_note=f"System-generated payslip — {s.slip_number}")
    doc = new_premium_document(buffer, decorator)

    story = []

    # Header: logo left, SALARY SLIP + month badge right
    logo_buf = _decode_b64_image(ds.logo_override or ps.company_logo)
    logo_img = None
    if logo_buf:
        try:
            logo_img = RLImage(logo_buf, width=2.6 * cm, height=1.5 * cm)
        except Exception:
            logo_img = None
    left_cell = [logo_img] if logo_img else []
    left_cell.append(Paragraph((ps.slip_company_name or ps.company_name or "UK TEXTILES").upper(), st["companyName"]))
    if ps.slip_company_address:
        left_cell.append(Paragraph(ps.slip_company_address, st["companyLoc"]))

    badge = Table([[period_label]], colWidths=[5 * cm], rowHeights=[0.8 * cm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), primary),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("FONTNAME", (0, 0), (-1, -1), FONT_BODY_BOLD),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 1, accent),
    ]))
    right_cell = [Paragraph("SALARY SLIP", st["title"]), Spacer(1, 0.15 * cm), badge]

    header_table = Table([[left_cell, right_cell]], colWidths=[10 * cm, 7.7 * cm])
    header_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (1, 0), (1, 0), "RIGHT")]))
    story.append(header_table)
    story.append(Spacer(1, 0.3 * cm))
    story.append(HRFlowable(width="100%", thickness=0.8, color=accent))
    story.append(Spacer(1, 0.3 * cm))

    # Employee info rows
    info_rows = [
        ["Employee Code", emp.employee_code, "Employee Name", full_name(emp)],
        ["Designation", emp.designation.title if emp.designation_id and emp.designation else "—",
         "Department", emp.department.name if emp.department_id and emp.department else "—"],
        ["Payroll Period", period_label, "Date of Joining", fmt_date(emp.join_date)],
    ]
    info_table = Table(info_rows, colWidths=[3.2 * cm, 5.3 * cm, 3.2 * cm, 5.3 * cm])
    info_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), FONT_BODY_BOLD),
        ("FONTNAME", (2, 0), (2, -1), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, -1), FONT_BODY),
        ("FONTNAME", (3, 0), (3, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), primary),
        ("TEXTCOLOR", (2, 0), (2, -1), primary),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 0.4 * cm))

    # Earnings / Deductions tables side by side
    earn_rows = [
        ["Earnings", "Amount"],
        ["Basic Pay", rupee(s.basic)],
        ["DA", rupee(0)],
        ["HRA", rupee(s.hra)],
        ["CA", rupee(0)],
        ["EA", rupee(0)],
        ["Other Allowances", rupee(other_allowances)],
        ["OT Wages", rupee(s.ot_amount)],
        ["PTRL", rupee(0)],
        ["Total Earnings", rupee(s.gross_salary)],
    ]
    ded_rows = [
        ["Deductions", "Amount"],
        ["P.F", rupee(s.pf_deduction)],
        ["E.S.I", rupee(s.esi_deduction)],
        ["Advance", rupee(s.advance_deduction)],
        ["T.Advance", rupee(0)],
        ["TDS", rupee(0)],
        ["LOP", rupee(0)],
        ["Other Deductions", rupee(s.other_deductions)],
        ["Total Deductions", rupee(s.total_deductions)],
    ]

    def _money_table(rows, header_color):
        t = Table(rows, colWidths=[4.3 * cm, 3.4 * cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), header_color),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), FONT_BODY_BOLD),
            ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
            ("FONTNAME", (0, -1), (-1, -1), FONT_BODY_BOLD),
            ("FONTSIZE", (0, 0), (-1, -1), 8.7),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("LINEBELOW", (0, 1), (-1, -2), 0.3, colors.HexColor("#eef2f0")),
            ("LINEABOVE", (0, -1), (-1, -1), 0.8, header_color),
            ("TOPPADDING", (0, 0), (-1, -1), 4.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ]))
        return t

    tables_row = Table(
        [[_money_table(earn_rows, primary), _money_table(ded_rows, accent)]],
        colWidths=[8.6 * cm, 8.6 * cm],
    )
    tables_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(tables_row)
    story.append(Spacer(1, 0.4 * cm))

    # Personal info + leave summary side by side
    personal_rows = [
        ["Father's/Husband's Name", emp.father_name or "—"],
        ["No. of Shifts Worked", f"{shifts_worked}"],
        ["OT Hours", f"{float(s.ot_amount):.2f}"],
        ["Minimum Rate of Wages", rupee(ps.min_wage_rate)],
        ["PF Number", emp.pf_number or "—"],
        ["ESI Number", emp.esi_number or "—"],
    ]
    personal_table = Table(personal_rows, colWidths=[4.4 * cm, 4 * cm])
    personal_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#4b5563")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))

    if balances:
        leave_rows = [["Leave Type", "Total", "Used", "Balance"]] + [
            [lb.leave_type.name, f"{float(lb.allocated):.1f}", f"{float(lb.used):.1f}", f"{float(lb.remaining):.1f}"]
            for lb in balances
        ]
    else:
        leave_rows = [["Leave Type", "Total", "Used", "Balance"], ["Casual Leave", "0.0", "0.0", "0.0"]]
    leave_table = Table(leave_rows, colWidths=[3.2 * cm, 1.5 * cm, 1.5 * cm, 1.5 * cm])
    leave_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("FONTNAME", (0, 0), (-1, 0), FONT_BODY_BOLD),
        ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 7.7),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))

    lower_row = Table([[personal_table, leave_table]], colWidths=[8.6 * cm, 8.6 * cm])
    lower_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(lower_row)
    story.append(Spacer(1, 0.45 * cm))

    # Net Amount Paid — highlighted green card
    words = num_to_words(int(float(s.net_salary)))
    net_card = Table(
        [["NET AMOUNT PAID", rupee(s.net_salary)], [f"Amount in Words: {words} ONLY", ""]],
        colWidths=[10.6 * cm, 6.6 * cm],
    )
    net_card.setStyle(TableStyle([
        ("SPAN", (0, 1), (1, 1)),
        ("BACKGROUND", (0, 0), (-1, 0), primary),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (0, 0), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, 0), FONT_BODY_BOLD),
        ("FONTSIZE", (0, 0), (0, 0), 11),
        ("FONTSIZE", (1, 0), (1, 0), 15),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("VALIGN", (0, 0), (-1, 0), "MIDDLE"),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#f0f7f4")),
        ("FONTNAME", (0, 1), (-1, 1), FONT_BODY),
        ("FONTSIZE", (0, 1), (-1, 1), 8),
        ("TEXTCOLOR", (0, 1), (-1, 1), colors.HexColor("#374151")),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("TOPPADDING", (0, 1), (-1, 1), 5),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("BOX", (0, 0), (-1, -1), 1, accent),
    ]))
    story.append(net_card)
    story.append(Spacer(1, 0.5 * cm))

    # Signature row + QR code
    qr_img = _make_qr_image(f"UKTEX-SLIP-{s.id}-{s.slip_number}")
    sig_source = _decode_b64_image(ps.signature_image)
    employer_cell = []
    if sig_source:
        try:
            employer_cell.append(RLImage(sig_source, width=2.6 * cm, height=1.2 * cm))
        except Exception:
            employer_cell.append(Spacer(1, 1.2 * cm))
    else:
        employer_cell.append(Spacer(1, 1.2 * cm))
    employer_cell.append(Paragraph("<b>Employer Signature</b>", st["sigLabel"]))

    footer_row = Table(
        [[
            Paragraph("_______________________<br/>Employee Signature", st["sigLabel"]),
            Paragraph(f"Date of Payment<br/><b>{timezone.now().strftime('%d %B %Y')}</b>", st["sigLabel"]),
            employer_cell,
            qr_img if qr_img else "",
        ]],
        colWidths=[4.6 * cm, 4.2 * cm, 4.2 * cm, 4 * cm],
    )
    footer_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("ALIGN", (3, 0), (3, 0), "RIGHT")]))
    story.append(footer_row)

    doc.build(story)
    return buffer.getvalue()


def _compact_salary_slip_flowables(s: SalarySlip, ds: CompanyDocumentSettings, ps: PayrollSettings,
                                     primary, accent, col_width=13.2 * cm) -> list:
    """
    Full-detail salary-slip layout for the bulk "2 slips per landscape-A4
    page" combined PDF (see salary_slip_bulk_pdf.py) — same header/info/
    earnings-deductions/net-amount/footer arrangement as the single-slip PDF
    (build_salary_slip_pdf), scaled to fit one ~13cm-wide column since the
    bulk PDF places one slip in the left half of the (landscape) page and one
    in the right half, both running the full page height.
    """
    emp = s.employee
    MONTHS = ["", "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December"]
    period_label = f"{MONTHS[s.month]} {s.year}" + (f" — Week {s.week_number}" if s.week_number else "")
    other_allowances = float(s.allowances) + float(s.incentives) + float(s.bonuses)
    shifts_worked = s.completed_sessions if s.week_number else float(s.present_days)
    leave_taken = float(s.paid_leave_days) + float(s.unpaid_leave_days)
    balances = (
        list(LeaveBalance.objects.select_related("leave_type").filter(employee=emp, year=s.year))
        if emp.pk else []
    )

    company_style = ParagraphStyle("CBoldC", fontName=FONT_BODY_BOLD, fontSize=13, textColor=primary)
    title_style = ParagraphStyle("CTitle", fontName=FONT_BODY_BOLD, fontSize=11, textColor=accent, alignment=2)
    info_label_style = ParagraphStyle("CInfoL", fontName=FONT_BODY_BOLD, fontSize=9, textColor=primary)
    info_val_style = ParagraphStyle("CInfoV", fontName=FONT_BODY, fontSize=9, textColor=colors.HexColor("#1f2937"))
    personal_label_style = ParagraphStyle("CPersL", fontName=FONT_BODY_BOLD, fontSize=8, textColor=colors.HexColor("#4b5563"))
    personal_val_style = ParagraphStyle("CPersV", fontName=FONT_BODY, fontSize=8, textColor=colors.HexColor("#1f2937"))
    words_style = ParagraphStyle("CWords", fontName=FONT_BODY, fontSize=7.7, textColor=colors.HexColor("#6b7280"))
    sig_style = ParagraphStyle("CSig", fontName=FONT_BODY, fontSize=8.7, textColor=colors.HexColor("#4b5563"))

    CW = col_width

    story = []

    header = Table(
        [[
            Paragraph((ps.slip_company_name or ps.company_name or "UK TEXTILES").upper(), company_style),
            Paragraph(f"SALARY SLIP — {period_label}", title_style),
        ]],
        colWidths=[CW * 0.42, CW * 0.58],
    )
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(header)
    story.append(Spacer(1, 0.22 * cm))
    story.append(HRFlowable(width="100%", thickness=0.8, color=accent))
    story.append(Spacer(1, 0.4 * cm))

    info_rows = [
        ["Employee Code", emp.employee_code, "Employee Name", full_name(emp)],
        ["Designation", emp.designation.title if emp.designation_id and emp.designation else "—",
         "Department", emp.department.name if emp.department_id and emp.department else "—"],
        ["Payroll Period", period_label, "Date of Joining", fmt_date(emp.join_date)],
        ["Working Days", str(s.working_days), "Leave Taken", f"{leave_taken:g}"],
    ]
    info_table = Table(
        [[Paragraph(a, info_label_style), Paragraph(str(b), info_val_style),
          Paragraph(c, info_label_style), Paragraph(str(d), info_val_style)] for a, b, c, d in info_rows],
        colWidths=[CW * 0.19, CW * 0.31, CW * 0.19, CW * 0.31],
    )
    info_table.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#e5e7eb")),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 0.22 * cm))

    earn_rows = [
        ["Earnings", "Amount"],
        ["Basic Pay", rupee(s.basic)],
        ["HRA", rupee(s.hra)],
        ["Other Allowances", rupee(other_allowances)],
        ["OT Wages", rupee(s.ot_amount)],
        ["Total Earnings", rupee(s.gross_salary)],
    ]
    ded_rows = [
        ["Deductions", "Amount"],
        ["P.F", rupee(s.pf_deduction)],
        ["E.S.I", rupee(s.esi_deduction)],
        ["Advance", rupee(s.advance_deduction)],
        ["Other Deductions", rupee(s.other_deductions)],
        ["Total Deductions", rupee(s.total_deductions)],
    ]

    def _mini_table(rows, header_color, width):
        t = Table(rows, colWidths=[width * 0.62, width * 0.38])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), header_color),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), FONT_BODY_BOLD),
            ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
            ("FONTNAME", (0, -1), (-1, -1), FONT_BODY_BOLD),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("LINEBELOW", (0, 1), (-1, -2), 0.25, colors.HexColor("#eef2f0")),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ]))
        return t

    half = (CW - 0.4 * cm) / 2
    tables_row = Table(
        [[_mini_table(earn_rows, primary, half), _mini_table(ded_rows, accent, half)]],
        colWidths=[half, half],
    )
    tables_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(tables_row)
    story.append(Spacer(1, 0.3 * cm))

    personal_rows = [
        ["Father's/Husband's Name", emp.father_name or "—"],
        ["No. of Shifts Worked", f"{shifts_worked}"],
        ["OT Hours", f"{float(s.ot_amount):.2f}"],
        ["Min. Rate of Wages", rupee(ps.min_wage_rate)],
        ["PF Number", emp.pf_number or "—"],
        ["ESI Number", emp.esi_number or "—"],
    ]
    personal_table = Table(personal_rows, colWidths=[half * 0.62, half * 0.38])
    personal_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#4b5563")),
        ("RIGHTPADDING", (0, 0), (0, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
    ]))

    if balances:
        leave_rows = [["Leave Type", "Total", "Used", "Balance"]] + [
            [lb.leave_type.name, f"{float(lb.allocated):.1f}", f"{float(lb.used):.1f}", f"{float(lb.remaining):.1f}"]
            for lb in balances
        ]
    else:
        leave_rows = [["Leave Type", "Total", "Used", "Balance"], ["Casual Leave", "0.0", "0.0", "0.0"]]
    leave_table = Table(leave_rows, colWidths=[half * 0.4, half * 0.2, half * 0.2, half * 0.2])
    leave_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("FONTNAME", (0, 0), (-1, 0), FONT_BODY_BOLD),
        ("FONTNAME", (0, 1), (-1, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))

    lower_row = Table([[personal_table, leave_table]], colWidths=[half, half])
    lower_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(lower_row)
    story.append(Spacer(1, 0.35 * cm))

    words = num_to_words(int(float(s.net_salary)))
    net_card = Table([["NET AMOUNT PAID", rupee(s.net_salary)]], colWidths=[CW * 0.6, CW * 0.4])
    net_card.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), primary),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("FONTNAME", (0, 0), (0, 0), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, 0), FONT_BODY_BOLD),
        ("FONTSIZE", (0, 0), (0, 0), 10.5),
        ("FONTSIZE", (1, 0), (1, 0), 14.5),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("BOX", (0, 0), (-1, -1), 0.6, accent),
    ]))
    story.append(net_card)
    story.append(Spacer(1, 0.12 * cm))
    story.append(Paragraph(f"Amount in Words: {words} ONLY", words_style))
    story.append(Spacer(1, 0.35 * cm))

    qr_img = _make_qr_image(f"UKTEX-SLIP-{s.id}-{s.slip_number}")
    footer_row = Table(
        [[
            Paragraph("Employee Signature:<br/>_______________", sig_style),
            Paragraph("Employer Signature:<br/>_______________", sig_style),
            Paragraph(f"Date of Payment<br/><b>{timezone.now().strftime('%d %B %Y')}</b>", sig_style),
            qr_img if qr_img else "",
        ]],
        colWidths=[CW * 0.32, CW * 0.32, CW * 0.21, CW * 0.15],
    )
    footer_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("ALIGN", (3, 0), (3, 0), "RIGHT")]))
    story.append(footer_row)

    return story


@api_view(["GET"])
@require_auth
def salary_slip_pdf(request: Request, pk: int) -> Response:
    s = SalarySlip.objects.select_related("employee", "employee__department", "employee__designation").filter(pk=pk).first()
    if not s:
        return Response({"error": "Not found"}, status=404)

    token_emp_id = get_token_employee_id(request)
    if token_emp_id and s.employee_id != token_emp_id:
        return Response({"error": "Access denied"}, status=403)
    branch_id = get_branch_scope(request)
    if branch_id is not None and s.employee.branch_id != branch_id:
        return Response({"error": "Access denied"}, status=403)

    pdf_bytes = build_salary_slip_pdf(s)
    filename = f"salary_slip_{s.slip_number}.pdf"
    disposition = "inline" if request.query_params.get("preview") else "attachment"
    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return response


# ── Resignation Letter ──────────────────────────────────────────────────

def build_resignation_letter_pdf(r) -> bytes:
    """r is a ResignationRequest — kept loosely typed to avoid a circular import
    with recruitment_views.py, which owns that model's CRUD."""
    ps = PayrollSettings.get()
    ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_RESIGNATION_LETTER)
    st = styles_for(ds.heading_style, _hex(ds.primary_color, "#0E4B3A"))
    primary = _hex(ds.primary_color, "#0E4B3A")
    accent = _hex(ds.accent_color, "#C9A227")
    emp = r.employee
    today = timezone.now().strftime("%d %B %Y")
    company_name = ps.company_name or "UK Textiles"
    last_working = fmt_date(r.last_working_date) if r.last_working_date else "as mutually agreed"

    buffer = io.BytesIO()
    decorator = PremiumPageDecorator(ds, ps, footer_note=f"This is a system-generated letter from the {company_name} HR Portal.")
    doc = new_premium_document(buffer, decorator)

    story = []
    company_header(story, ps, ds, st)
    title_block(story, "RESIGNATION ACCEPTANCE LETTER", st, decorator.accent)

    story.append(Paragraph(f"Ref No: RES/{emp.employee_code}/{r.id}   •   Date: {today}", st["certMeta"]))
    story.append(Spacer(1, 0.4 * cm))

    story.append(Paragraph("To,", st["body"]))
    story.append(Paragraph(f"<b>{full_name(emp)}</b>", st["bodyBold"]))
    if emp.designation_id and emp.designation:
        story.append(Paragraph(emp.designation.title, st["body"]))
    if emp.department_id and emp.department:
        story.append(Paragraph(emp.department.name, st["body"]))
    story.append(Paragraph(f"Employee Code: {emp.employee_code}", st["body"]))
    story.append(Spacer(1, 0.35 * cm))

    story.append(Paragraph(f"Dear {emp.first_name},", st["body"]))
    story.append(Spacer(1, 0.2 * cm))

    paragraphs = [
        (
            f"We acknowledge receipt of your resignation letter and wish to inform you that your resignation "
            f"has been accepted with effect from <b>{last_working}</b>."
        ),
        (
            "We appreciate your contributions to the company during your tenure and thank you for your "
            "dedication and commitment. We wish you all the best in your future endeavours."
        ),
        (
            "Please ensure that all company property, access cards, and pending work are handed over properly "
            "before your last working day. Full and final settlement will be processed as per company policy."
        ),
    ]
    for p in paragraphs:
        story.append(Paragraph(p, st["body"]))
        story.append(Spacer(1, 0.22 * cm))

    story.append(Spacer(1, 0.2 * cm))
    details = [
        ["Employee Name", full_name(emp)],
        ["Employee Code", emp.employee_code],
        ["Department", emp.department.name if emp.department_id and emp.department else "—"],
        ["Designation", emp.designation.title if emp.designation_id and emp.designation else "—"],
        ["Date of Joining", fmt_date(emp.join_date)],
        ["Last Working Date", last_working],
        ["Resignation Date", fmt_date(r.created_at) if r.created_at else "—"],
        ["Approved By (HR)", r.approved_by or "HR Management"],
        ["Approval Date", fmt_date(r.approved_at) if r.approved_at else today],
    ]
    details_table = Table(details, colWidths=[6 * cm, 10.7 * cm])
    details_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f5f2e8")),
        ("TEXTCOLOR", (0, 0), (0, -1), primary),
        ("FONTNAME", (0, 0), (0, -1), FONT_BODY_BOLD),
        ("FONTNAME", (1, 0), (1, -1), FONT_BODY),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("BOX", (0, 0), (-1, -1), 0.8, accent),
    ]))
    story.append(details_table)
    story.append(Spacer(1, 0.6 * cm))

    signature_block(story, ps, st)

    doc.build(story)
    return buffer.getvalue()
