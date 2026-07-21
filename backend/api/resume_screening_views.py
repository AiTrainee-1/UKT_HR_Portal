"""
Resume Screening (ATS)
=======================
Department-scoped hiring rule sets, single/bulk resume upload + ML scoring
(resume_screening_ml.py), the Shortlisted -> Selected/Rejected candidate
pipeline, and bulk email actions (rejection notice, interview invite).

Same conventions as the rest of this codebase: plain @api_view + @require_hr
functions, no serializers/viewsets, hand-built response dicts. Email sending
reuses the exact smtplib + PayrollSettings pattern already proven in
offer_letter_email/resignation_email.
"""
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from django.core.files.base import ContentFile
from django.db.models import Q
from django.http import FileResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import Department, HiringRuleSet, PayrollSettings, ScreeningCandidate
from . import resume_screening_progress


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


# ── JSON shapers ────────────────────────────────────────────────────────────

def _rule_set_json(rs: HiringRuleSet) -> dict:
    return {
        "id": rs.id,
        "name": rs.name,
        "departmentId": rs.department_id,
        "departmentName": rs.department.name if rs.department_id else None,
        "requiredSkills": rs.required_skills or [],
        "softSkills": rs.soft_skills or [],
        "educationQualification": rs.education_qualification,
        "minExperienceYears": float(rs.min_experience_years or 0),
        "preferredCity": rs.preferred_city,
        "otherRequirements": rs.other_requirements,
        "isActive": rs.is_active,
        "candidateCount": getattr(rs, "candidate_count", None),
        "createdAt": rs.created_at.isoformat() if rs.created_at else None,
        "updatedAt": rs.updated_at.isoformat() if rs.updated_at else None,
    }


def _candidate_json(c: ScreeningCandidate) -> dict:
    return {
        "id": c.id,
        "ruleSetId": c.rule_set_id,
        "ruleSetName": c.rule_set.name if c.rule_set_id else None,
        "departmentId": c.department_id,
        "departmentName": c.department.name if c.department_id else None,
        "originalFilename": c.original_filename,
        "hasResume": bool(c.resume_file),
        "source": c.source,
        "candidateName": c.candidate_name,
        "email": c.email,
        "phone": c.phone,
        "city": c.city,
        "extractedSkills": c.extracted_skills or [],
        "extractedSoftSkills": c.extracted_soft_skills or [],
        "extractedExperienceYears": (
            float(c.extracted_experience_years) if c.extracted_experience_years is not None else None
        ),
        "extractedEducation": c.extracted_education,
        "matchScore": float(c.match_score) if c.match_score is not None else None,
        "scoreBreakdown": c.score_breakdown,
        "rankInBatch": c.rank_in_batch,
        "status": c.status,
        "screenedAt": c.screened_at.isoformat() if c.screened_at else None,
        "interviewInvitedAt": c.interview_invited_at.isoformat() if c.interview_invited_at else None,
        "interviewDatetime": c.interview_datetime.isoformat() if c.interview_datetime else None,
        "rejectionEmailedAt": c.rejection_emailed_at.isoformat() if c.rejection_emailed_at else None,
        "notes": c.notes,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "resumeUrl": f"/api/recruitment/resume-screening/candidates/{c.id}/resume",
    }


def _active_vocabularies() -> tuple[list[str], list[str], list[str]]:
    from . import resume_screening_ml as ml
    active = list(HiringRuleSet.objects.filter(is_active=True))
    vocabulary = ml.build_skill_vocabulary(active)
    soft_vocabulary = ml.build_soft_skill_vocabulary(active)
    known_cities = sorted({rs.preferred_city.strip() for rs in active if rs.preferred_city and rs.preferred_city.strip()})
    return vocabulary, soft_vocabulary, known_cities


# ── Hiring rule sets ─────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def rule_sets(request: Request) -> Response:
    if request.method == "GET":
        qs = HiringRuleSet.objects.select_related("department").order_by("-created_at")
        dept_id = request.query_params.get("departmentId")
        if dept_id:
            qs = qs.filter(department_id=dept_id)
        is_active = request.query_params.get("isActive")
        if is_active is not None:
            qs = qs.filter(is_active=is_active.lower() == "true")
        return Response([_rule_set_json(rs) for rs in qs])

    data = request.data
    dept_id = data.get("departmentId")
    if not data.get("name") or not dept_id:
        return _error("name and departmentId are required")
    dept = Department.objects.filter(id=dept_id).first()
    if not dept:
        return _error("Department not found", 404)

    rs = HiringRuleSet.objects.create(
        name=data["name"],
        department=dept,
        required_skills=data.get("requiredSkills") or [],
        soft_skills=data.get("softSkills") or [],
        education_qualification=data.get("educationQualification"),
        min_experience_years=data.get("minExperienceYears") or 0,
        preferred_city=data.get("preferredCity"),
        other_requirements=data.get("otherRequirements"),
    )
    return Response(_rule_set_json(rs), status=201)


@api_view(["GET", "PATCH", "DELETE"])
@require_hr
def rule_set_detail(request: Request, pk: int) -> Response:
    rs = HiringRuleSet.objects.select_related("department").filter(pk=pk).first()
    if not rs:
        return _error("Rule set not found", 404)

    if request.method == "GET":
        return Response(_rule_set_json(rs))

    if request.method == "DELETE":
        if ScreeningCandidate.objects.filter(rule_set=rs).exists():
            return _error(
                "This rule set has screened candidates attached and can't be deleted — "
                "deactivate it instead so it stops appearing in new screening runs.",
                409,
            )
        rs.delete()
        return Response({"ok": True})

    data = request.data
    if "name" in data:
        rs.name = data["name"]
    if "departmentId" in data:
        dept = Department.objects.filter(id=data["departmentId"]).first()
        if not dept:
            return _error("Department not found", 404)
        rs.department = dept
    if "requiredSkills" in data:
        rs.required_skills = data["requiredSkills"] or []
    if "softSkills" in data:
        rs.soft_skills = data["softSkills"] or []
    if "educationQualification" in data:
        rs.education_qualification = data["educationQualification"]
    if "minExperienceYears" in data:
        rs.min_experience_years = data["minExperienceYears"] or 0
    if "preferredCity" in data:
        rs.preferred_city = data["preferredCity"]
    if "otherRequirements" in data:
        rs.other_requirements = data["otherRequirements"]
    if "isActive" in data:
        rs.is_active = bool(data["isActive"])
    rs.save()
    return Response(_rule_set_json(rs))


# ── Single resume upload + score ────────────────────────────────────────────

@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def upload_single(request: Request) -> Response:
    file = request.FILES.get("file")
    rule_set_id = request.data.get("ruleSetId")
    if not file:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")
    if not rule_set_id:
        return _error("ruleSetId is required")
    rule_set = HiringRuleSet.objects.select_related("department").filter(pk=rule_set_id, is_active=True).first()
    if not rule_set:
        return _error("Rule set not found or inactive", 404)

    from . import resume_screening_ml as ml
    vocabulary, soft_vocabulary, known_cities = _active_vocabularies()

    file_bytes = file.read()
    try:
        result = ml.screen_resume(file_bytes, file.name, rule_set, vocabulary, soft_vocabulary, known_cities)
    except ValueError as exc:
        return _error(str(exc))
    except Exception as exc:
        return _error(f"Failed to screen this resume: {exc}", 500)

    candidate = ScreeningCandidate(
        rule_set=rule_set, department=rule_set.department,
        original_filename=file.name, source="single",
        status="screened", screened_at=timezone.now(),
        **result,
    )
    candidate.resume_file.save(file.name, ContentFile(file_bytes), save=False)
    candidate.save()
    return Response(_candidate_json(candidate), status=201)


@api_view(["POST"])
@require_hr
def shortlist_candidate(request: Request, pk: int) -> Response:
    """Manual promote — used by the single-upload 'Add to Shortlist' button
    and the 'move to shortlist' action on a Not Shortlisted bulk candidate."""
    c = ScreeningCandidate.objects.filter(pk=pk).first()
    if not c:
        return _error("Candidate not found", 404)
    if c.status not in ("uploaded", "screened", "not_shortlisted"):
        return _error(f"Cannot shortlist a candidate with status '{c.status}'")
    c.status = "shortlisted"
    c.save(update_fields=["status", "updated_at"])
    return Response(_candidate_json(c))


# ── Bulk resume upload + screen (with progress) ─────────────────────────────

@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def upload_bulk(request: Request) -> Response:
    files = request.FILES.getlist("files")
    rule_set_id = request.data.get("ruleSetId")
    top_n_raw = request.data.get("topN")
    if not files:
        return _error("No files uploaded. Send as multipart/form-data with repeated key 'files'.")
    if not rule_set_id:
        return _error("ruleSetId is required")
    try:
        top_n = int(top_n_raw)
    except (TypeError, ValueError):
        return _error("topN (how many candidates to shortlist) is required")
    if top_n < 1:
        return _error("topN must be at least 1")

    rule_set = HiringRuleSet.objects.select_related("department").filter(pk=rule_set_id, is_active=True).first()
    if not rule_set:
        return _error("Rule set not found or inactive", 404)

    from . import resume_screening_ml as ml
    vocabulary, soft_vocabulary, known_cities = _active_vocabularies()

    resume_screening_progress.start(len(files))
    created: list[ScreeningCandidate] = []
    failed: list[dict] = []

    for f in files:
        ok = False
        try:
            file_bytes = f.read()
            result = ml.screen_resume(file_bytes, f.name, rule_set, vocabulary, soft_vocabulary, known_cities)
            candidate = ScreeningCandidate(
                rule_set=rule_set, department=rule_set.department,
                original_filename=f.name, source="bulk",
                status="screened", screened_at=timezone.now(),
                **result,
            )
            candidate.resume_file.save(f.name, ContentFile(file_bytes), save=False)
            candidate.save()
            created.append(candidate)
            ok = True
        except Exception as exc:
            failed.append({"filename": f.name, "error": str(exc)})
        resume_screening_progress.step(f.name, ok)

    # Rank the batch by score and split top-N shortlisted vs. the rest.
    created.sort(key=lambda c: c.match_score or 0, reverse=True)
    for i, c in enumerate(created, start=1):
        c.rank_in_batch = i
        c.status = "shortlisted" if i <= top_n else "not_shortlisted"
        c.save(update_fields=["rank_in_batch", "status", "updated_at"])

    resume_screening_progress.finish()

    shortlisted_count = min(top_n, len(created))
    not_shortlisted_count = max(0, len(created) - shortlisted_count)
    return Response({
        "message": (
            f"Screened {len(created)} resume(s): {shortlisted_count} shortlisted, "
            f"{not_shortlisted_count} not shortlisted"
            + (f", {len(failed)} failed" if failed else "") + "."
        ),
        "totalUploaded": len(files),
        "shortlisted": shortlisted_count,
        "notShortlisted": not_shortlisted_count,
        "failed": failed,
    }, status=201)


@api_view(["GET"])
@require_hr
def upload_bulk_progress(request: Request) -> Response:
    return Response(resume_screening_progress.snapshot())


# ── Candidates: list, status transitions, delete, resume file ──────────────

_ALLOWED_TRANSITIONS = {
    ("uploaded", "shortlisted"), ("screened", "shortlisted"), ("not_shortlisted", "shortlisted"),
    ("uploaded", "not_shortlisted"), ("screened", "not_shortlisted"),
    ("shortlisted", "selected"),
    ("shortlisted", "rejected"), ("selected", "rejected"),
}


@api_view(["GET"])
@require_hr
def candidates(request: Request) -> Response:
    qs = ScreeningCandidate.objects.select_related("rule_set", "department").order_by("-match_score", "-created_at")
    status_param = request.query_params.get("status")
    if status_param:
        qs = qs.filter(status=status_param)
    rule_set_id = request.query_params.get("ruleSetId")
    if rule_set_id:
        qs = qs.filter(rule_set_id=rule_set_id)
    dept_id = request.query_params.get("departmentId")
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    search = request.query_params.get("search")
    if search:
        qs = qs.filter(
            Q(candidate_name__icontains=search) | Q(email__icontains=search) | Q(phone__icontains=search)
        )
    return Response([_candidate_json(c) for c in qs])


@api_view(["PATCH", "DELETE"])
@require_hr
def candidate_detail(request: Request, pk: int) -> Response:
    c = ScreeningCandidate.objects.select_related("rule_set", "department").filter(pk=pk).first()
    if not c:
        return _error("Candidate not found", 404)

    if request.method == "DELETE":
        c.resume_file.delete(save=False)
        c.delete()
        return Response({"ok": True})

    data = request.data
    if "status" in data:
        new_status = data["status"]
        if new_status != c.status and (c.status, new_status) not in _ALLOWED_TRANSITIONS:
            return _error(f"Cannot move a candidate from '{c.status}' to '{new_status}'")
        # Once a candidate is rejected, their resume file is removed from
        # storage automatically — only the resume binary goes; every
        # extracted detail (name, phone, email, city, education, skills,
        # score breakdown) stays on the row for HR's records. Selected/
        # shortlisted candidates keep their file untouched.
        if new_status == "rejected" and c.status != "rejected" and c.resume_file:
            c.resume_file.delete(save=False)
        c.status = new_status
    if "notes" in data:
        c.notes = data["notes"]
    c.save()
    return Response(_candidate_json(c))


@api_view(["GET"])
@require_hr
def candidate_resume(request: Request, pk: int) -> Response:
    c = ScreeningCandidate.objects.filter(pk=pk).first()
    if not c or not c.resume_file:
        return _error("Resume not found", 404)
    disposition = "attachment" if request.query_params.get("download") else "inline"
    response = FileResponse(c.resume_file.open("rb"))
    response["Content-Disposition"] = f'{disposition}; filename="{c.original_filename}"'
    return response


# ── Email: rejection notice + interview invite ──────────────────────────────

def _send_mail(ps: PayrollSettings, to_email: str, subject: str, html_body: str) -> None:
    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = f"{ps.smtp_from_name} <{ps.smtp_from_email or ps.smtp_username}>"
    msg["To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

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


def _email_shell(ps: PayrollSettings, title: str, body_html: str) -> str:
    company_name = ps.company_name or "UKTextiles"
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a2e">
      <div style="background:#0E4B3A;padding:20px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:18px">{company_name.upper()}</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">{title}</p>
      </div>
      <div style="background:#ffffff;padding:30px;border:1px solid #d8e5df;border-top:none">
        {body_html}
        <p style="color:#888;font-size:12px;margin-top:24px">
          This is a system-generated email from the {company_name} HR Portal.
        </p>
      </div>
    </div>
    """


def send_rejection_email(candidate: ScreeningCandidate, ps: PayrollSettings) -> None:
    company_name = ps.company_name or "UKTextiles"
    name = candidate.candidate_name or "Candidate"
    body = f"""
      <p>Dear <strong>{name}</strong>,</p>
      <p>
        Thank you for participating in our recruitment process and for your interest in
        {company_name}. We appreciate your time and effort. Unfortunately, you were not
        selected this time. We wish you all the best and hope to connect with you again
        in the future.
      </p>
    """
    _send_mail(
        ps, candidate.email,
        f"Application Update — {company_name}",
        _email_shell(ps, "Recruitment Update", body),
    )


def send_interview_invite_email(candidate: ScreeningCandidate, ps: PayrollSettings) -> None:
    company_name = ps.company_name or "UKTextiles"
    name = candidate.candidate_name or "Candidate"
    when = timezone.localtime(candidate.interview_datetime).strftime("%A, %d %B %Y at %I:%M %p")
    address = ps.company_address or ""
    body = f"""
      <p>Dear <strong>{name}</strong>,</p>
      <p>
        We are pleased to inform you that you have been shortlisted for the next stage of
        our recruitment process at {company_name}. We would like to invite you for a
        face-to-face interview at our office.
      </p>
      <p style="background:#f3f9f6;border:1px solid #d8e5df;border-radius:6px;padding:12px 16px">
        <strong>Date &amp; Time:</strong> {when}<br/>
        {f"<strong>Location:</strong> {address}<br/>" if address else ""}
      </p>
      <p>Please bring a copy of your resume and a valid photo ID. We look forward to meeting you.</p>
    """
    _send_mail(
        ps, candidate.email,
        f"Interview Invitation — {company_name}",
        _email_shell(ps, "Interview Invitation", body),
    )


def _require_smtp() -> tuple[PayrollSettings | None, Response | None]:
    ps = PayrollSettings.get()
    if not ps.smtp_host or not ps.smtp_username or not ps.smtp_password:
        return None, _error("SMTP settings not configured. Please save SMTP settings in Settings first.")
    return ps, None


def _parse_interview_datetime(raw):
    """
    request.data.get("interviewDateTime") is a plain JSON string — Django
    does NOT parse a DateTimeField's value into a real datetime until the row
    is saved and reloaded from the DB, so using it immediately afterward
    (e.g. timezone.localtime() in the email body) would fail on the raw
    string. Parse it into a real, timezone-aware datetime up front instead.
    Raises ValueError with a clear message if the string isn't parseable.
    """
    dt = parse_datetime(raw) if isinstance(raw, str) else None
    if dt is None:
        raise ValueError(f"'{raw}' is not a valid date/time")
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_default_timezone())
    return dt


@api_view(["POST"])
@require_hr
def reject_email_all(request: Request) -> Response:
    ps, err = _require_smtp()
    if err:
        return err

    pending = ScreeningCandidate.objects.filter(status="rejected", rejection_emailed_at__isnull=True)
    sent = 0
    failed = []
    for c in pending:
        if not c.email:
            failed.append({"candidateId": c.id, "name": c.candidate_name, "error": "No email address on file"})
            continue
        try:
            send_rejection_email(c, ps)
            c.rejection_emailed_at = timezone.now()
            c.save(update_fields=["rejection_emailed_at", "updated_at"])
            sent += 1
        except Exception as exc:
            failed.append({"candidateId": c.id, "name": c.candidate_name, "error": str(exc)})
    return Response({"sent": sent, "failed": failed})


@api_view(["POST"])
@require_hr
def interview_invite_single(request: Request, pk: int) -> Response:
    ps, err = _require_smtp()
    if err:
        return err
    c = ScreeningCandidate.objects.filter(pk=pk, status="selected").first()
    if not c:
        return _error("Selected candidate not found", 404)
    interview_dt = request.data.get("interviewDateTime")
    if not interview_dt:
        return _error("interviewDateTime is required")
    if not c.email:
        return _error("This candidate has no email address on file")
    try:
        interview_dt = _parse_interview_datetime(interview_dt)
    except ValueError as exc:
        return _error(str(exc))

    c.interview_datetime = interview_dt
    c.save(update_fields=["interview_datetime", "updated_at"])
    try:
        send_interview_invite_email(c, ps)
    except Exception as exc:
        return _error(f"Failed to send email: {exc}", 502)
    c.interview_invited_at = timezone.now()
    c.save(update_fields=["interview_invited_at", "updated_at"])
    return Response(_candidate_json(c))


@api_view(["POST"])
@require_hr
def interview_invite_bulk(request: Request) -> Response:
    ps, err = _require_smtp()
    if err:
        return err
    interview_dt = request.data.get("interviewDateTime")
    if not interview_dt:
        return _error("interviewDateTime is required")
    try:
        interview_dt = _parse_interview_datetime(interview_dt)
    except ValueError as exc:
        return _error(str(exc))

    pending = ScreeningCandidate.objects.filter(status="selected", interview_invited_at__isnull=True)
    sent = 0
    failed = []
    for c in pending:
        if not c.email:
            failed.append({"candidateId": c.id, "name": c.candidate_name, "error": "No email address on file"})
            continue
        c.interview_datetime = interview_dt
        try:
            send_interview_invite_email(c, ps)
            c.interview_invited_at = timezone.now()
            c.save(update_fields=["interview_datetime", "interview_invited_at", "updated_at"])
            sent += 1
        except Exception as exc:
            failed.append({"candidateId": c.id, "name": c.candidate_name, "error": str(exc)})
    return Response({"sent": sent, "failed": failed})
