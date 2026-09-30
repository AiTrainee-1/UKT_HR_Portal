"""
Gmail Control page (HR portal -> Gmail Control): one place to monitor and manage every email the
HRMS sends. All endpoints are HR-only and sit under the `gmail_control` permission module (see
permission_registry.URL_MODULE_MAP).

    GET  /api/gmail-control/overview                    totals, today / this month, per-module and per-day counts, config
    GET  /api/gmail-control/messages                    email history (filters + pagination)
    GET  /api/gmail-control/employees                   employee-wise email counts
    GET  /api/gmail-control/settings                    feature switches, daily limit, read-only Gmail configuration
    PUT  /api/gmail-control/settings                    change switches / limit
    GET  /api/gmail-control/templates                   every email type: subject, wording, variables, switch, usage
    PUT  /api/gmail-control/templates/<type>            change subject / wording / per-type switch
    POST /api/gmail-control/templates/<type>/preview    render wording with sample values (text + HTML)
    POST /api/gmail-control/test-email                  send a test email to check the Gmail connection

What the email types, modules and variables are comes from email_catalog.py, so a new email
appears here without touching this file. The Gmail account (host, user, app password) stays in
Settings -> SMTP: it is shown here read-only, and the password is never returned.
"""

import re
from datetime import date, datetime, timedelta

from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import email_catalog as catalog, email_service
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .models import Employee, EmailMessageLog, EmailMessageTemplate, EmailSettings
from .user_settings import settings_for
from .view_common import error_response as _error, paginate

TYPE_LABELS = {key: t.label for key, t in catalog.TYPES.items()}
STATUSES = ["sent", "failed", "blocked"]
CATEGORY_OF = {key: t.module for key, t in catalog.TYPES.items()}
CATEGORIES = catalog.categories()

SUBJECT_MAX = 200
BODY_MAX = 5000

# The groups the Feature Controls tab shows, in order.
GROUPS = [
    (
        "master",
        "All emails",
        "One switch that stops every email the HRMS sends. Use it while the Gmail account has a problem, or while testing.",
    ),
    (
        "documents",
        "Documents",
        "Salary slips, offer letters, ID cards and resignation letters HR emails from the Documents pages.",
    ),
    (
        "visitors",
        "Visitors",
        "Tells an employee when a visitor checks in at reception to meet them. Sent automatically at check-in.",
    ),
    ("recruitment", "Recruitment", "Rejection notices and interview invitations sent from Resume Screening."),
]

# Editable feature switches (EmailSettings booleans): json key, model field, label, group, description.
FEATURES = [
    (
        "emailsEnabled",
        "emails_enabled",
        "Send emails",
        "master",
        "Master switch. While it is off nothing is emailed, whatever the switches below say.",
    ),
    (
        "documentEmailsEnabled",
        "document_emails_enabled",
        "Document emails",
        "documents",
        "Salary slips (single and bulk), offer letters, ID cards and resignation letters sent by email.",
    ),
    (
        "visitorEmailsEnabled",
        "visitor_emails_enabled",
        "Visitor arrival email",
        "visitors",
        "Email the employee a visitor came to meet, with the visitor's phone and purpose.",
    ),
    (
        "recruitmentEmailsEnabled",
        "recruitment_emails_enabled",
        "Recruitment emails",
        "recruitment",
        "Rejection notices and interview invitations to resume-screening candidates.",
    ),
]

# Numeric settings: json key, model field, label, (min, max).
TIMINGS = [
    ("dailySendLimit", "daily_send_limit", "Daily email limit (0 = no limit)", (0, 5000)),
]

_TOKEN = re.compile(r"\{\{([^{}]*)\}\}")


def _messages_qs(request: Request):
    """The history this HR user may see: everything, or -for a branch login- their branch's
    employees plus the mail they sent themselves to people who are not employees (a test email,
    a resume-screening candidate)."""
    qs = EmailMessageLog.objects.select_related("employee", "sent_by")
    branch_id = get_branch_scope(request)
    if branch_id is None:
        return qs
    return qs.filter(Q(employee__branch_id=branch_id) | Q(employee__isnull=True, sent_by__branch_id=branch_id))


def _status_counts(qs) -> dict:
    counts = {s: 0 for s in STATUSES}
    for row in qs.values("status").annotate(n=Count("id")):
        counts[row["status"]] = counts.get(row["status"], 0) + row["n"]
    counts["total"] = sum(counts.values())
    return counts


def _message_json(m: EmailMessageLog) -> dict:
    emp = m.employee
    module = CATEGORY_OF.get(m.email_type, "other")
    return {
        "id": m.id,
        "employeeId": m.employee_id,
        "employeeCode": emp.employee_code if emp else None,
        "recipientName": m.recipient_name or (f"{emp.first_name} {emp.last_name}".strip() if emp else ""),
        "recipientEmail": m.recipient_email,
        "emailType": m.email_type,
        "typeLabel": TYPE_LABELS.get(m.email_type, m.email_type),
        "category": module,
        "categoryLabel": catalog.MODULES.get(module, module),
        "relatedModule": m.related_module,
        "subject": m.subject,
        "status": m.status,
        "error": m.error_message,
        "messageText": m.message_text,
        "attachmentName": m.attachment_name,
        "referenceId": m.ref_id,
        "sentBy": (m.sent_by.full_name or m.sent_by.username) if m.sent_by else None,
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        "updatedAt": m.updated_at.isoformat() if m.updated_at else None,
    }


def _mask(value: str) -> str:
    """ab•••@gmail.com -enough to recognise the account, not enough to read it out."""
    if not value:
        return ""
    local, _, domain = value.partition("@")
    return f"{local[:2]}•••@{domain}" if domain else f"{value[:2]}•••"


def _config(request: Request) -> dict:
    ps = settings_for(request)
    host = ps.smtp_host or ""
    is_gmail = "gmail" in host.lower() or "googlemail" in host.lower()
    return {
        "provider": "Gmail (SMTP)" if is_gmail else "SMTP mail server",
        "isGmail": is_gmail,
        "smtpConfigured": email_service.smtp_missing_reason(ps) is None,
        # Ready to send from this server: SMTP details present AND this machine is allowed to send.
        "configured": email_service.is_configured(ps),
        # Why nothing can be sent from this server (SMTP not set up, or a development machine), else null.
        "sendingBlockedReason": email_service.sending_block_reason(ps),
        "sendingAllowedHere": email_service.sending_allowed(),
        "host": host,
        "port": ps.smtp_port,
        "security": "SSL (port 465)" if ps.smtp_port == 465 else "STARTTLS",
        "username": _mask(ps.smtp_username or ""),
        "passwordSet": bool(ps.smtp_password),
        "fromEmail": ps.smtp_from_email or ps.smtp_username or "",
        "fromName": ps.smtp_from_name or "",
        "companyName": email_service.company_name(ps),
        "sentToday": email_service.sent_today(),
        "dailyLimit": EmailSettings.get().daily_send_limit,
        # Gmail's own ceilings, so the daily limit can be set sensibly.
        "gmailLimits": {"regular": 500, "workspace": 2000},
        "settingsPath": "/hr/settings",
    }


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date() - timedelta(days=days_back)
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


@api_view(["GET"])
@require_hr
def email_overview(request: Request) -> Response:
    """Totals and breakdowns over the last `days` days (default 30), plus today's and this month's
    counts whatever the range."""
    try:
        days = max(1, min(365, int(request.query_params.get("days", 30))))
    except ValueError:
        return _error("days must be a number")
    since = timezone.now() - timedelta(days=days)
    everything = _messages_qs(request)
    qs = everything.filter(created_at__gte=since)

    by_category = {}
    for category, types in CATEGORIES.items():
        by_category[category] = _status_counts(qs.filter(email_type__in=types))

    by_type = [
        {
            "emailType": row["email_type"],
            "label": TYPE_LABELS.get(row["email_type"], row["email_type"]),
            "category": CATEGORY_OF.get(row["email_type"], "other"),
            "total": row["total"],
            "failed": row["failed"],
        }
        for row in qs.values("email_type")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")))
        .order_by("-total")
    ]

    daily_rows = (
        qs.annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")))
        .order_by("day")
    )
    daily = [{"date": r["day"].isoformat(), "total": r["total"], "failed": r["failed"]} for r in daily_rows]

    today_start = _day_start()
    return Response(
        {
            "days": days,
            "config": _config(request),
            "totals": _status_counts(qs),
            "today": _status_counts(everything.filter(created_at__gte=today_start)),
            "thisMonth": _status_counts(everything.filter(created_at__gte=today_start.replace(day=1))),
            "categories": [{"key": key, "label": catalog.MODULES[key]} for key in CATEGORIES],
            "byCategory": by_category,
            "byType": by_type,
            "daily": daily,
            "recentFailures": [_message_json(m) for m in qs.filter(status="failed")[:8]],
        }
    )


@api_view(["GET"])
@require_hr
def email_messages(request: Request) -> Response:
    """Email history, newest first. Filters: status, category (module), type, employeeId, search (name /
    code / email / subject), dateFrom, dateTo (YYYY-MM-DD, IST). Without `page` this is a bare array
    capped like every other list endpoint."""
    q = request.query_params
    qs = _messages_qs(request).order_by("-created_at", "-id")
    if status := q.get("status"):
        if status not in STATUSES:
            return _error(f"status must be one of: {', '.join(STATUSES)}")
        qs = qs.filter(status=status)
    if category := q.get("category"):
        if category not in CATEGORIES:
            return _error(f"category must be one of: {', '.join(CATEGORIES)}")
        qs = qs.filter(email_type__in=CATEGORIES[category])
    if email_type := q.get("type"):
        qs = qs.filter(email_type=email_type)
    if emp_id := q.get("employeeId"):
        try:
            qs = qs.filter(employee_id=int(emp_id))
        except ValueError:
            return _error("employeeId must be a number")
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(employee__first_name__icontains=search)
            | Q(employee__last_name__icontains=search)
            | Q(employee__employee_code__icontains=search)
            | Q(recipient_name__icontains=search)
            | Q(recipient_email__icontains=search)
            | Q(subject__icontains=search)
        )
    for param, op in (("dateFrom", "gte"), ("dateTo", "lt")):
        if raw := q.get(param):
            try:
                d = date.fromisoformat(raw)
            except ValueError:
                return _error(f"{param} must be YYYY-MM-DD")
            if op == "lt":
                d += timedelta(days=1)
            qs = qs.filter(**{f"created_at__{op}": datetime.combine(d, datetime.min.time(), tzinfo=FACTORY_TZ)})
    return paginate(request, qs, _message_json)


@api_view(["GET"])
@require_hr
def email_employees(request: Request) -> Response:
    """Employee-wise view: who has been emailed, how many, and how many failed."""
    qs = scope_to_branch(Employee.objects, request).filter(email_messages__isnull=False)
    if search := (request.query_params.get("search") or "").strip():
        qs = qs.filter(
            Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(employee_code__icontains=search)
            | Q(email__icontains=search)
        )
    qs = (
        qs.annotate(
            total=Count("email_messages"),
            failed=Count("email_messages", filter=Q(email_messages__status="failed")),
            last_at=Max("email_messages__created_at"),
        )
        .select_related("department")
        .order_by("-last_at", "id")
    )
    return paginate(
        request,
        qs,
        lambda e: {
            "employeeId": e.id,
            "employeeCode": e.employee_code,
            "employeeName": f"{e.first_name} {e.last_name}".strip(),
            "email": e.email or "",
            "department": e.department.name if e.department_id else None,
            "total": e.total,
            "failed": e.failed,
            "lastEmailAt": e.last_at.isoformat() if e.last_at else None,
        },
    )


def _settings_json(request: Request, s: EmailSettings) -> dict:
    return {
        "groups": [{"key": key, "title": title, "blurb": blurb} for key, title, blurb in GROUPS],
        "features": [
            {"key": key, "label": label, "description": desc, "group": group, "enabled": bool(getattr(s, field))}
            for key, field, label, group, desc in FEATURES
        ],
        "timings": [
            {"key": key, "label": label, "value": getattr(s, field), "min": lo, "max": hi}
            for key, field, label, (lo, hi) in TIMINGS
        ],
        "config": _config(request),
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_hr
def email_control_settings(request: Request) -> Response:
    s = EmailSettings.get()
    if request.method == "GET":
        return Response(_settings_json(request, s))

    data = request.data
    updates = {}
    for key, field, _label, _group, _desc in FEATURES:
        if key in data:
            if not isinstance(data[key], bool):
                return _error(f"{key} must be true or false")
            updates[field] = data[key]
    for key, field, label, (lo, hi) in TIMINGS:
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, str)):
                return _error(f"{label} must be a whole number")
            try:
                value = int(value)
            except ValueError:
                return _error(f"{label} must be a whole number")
            if not lo <= value <= hi:
                return _error(f"{label} must be between {lo} and {hi}")
            updates[field] = value
    for field, value in updates.items():
        setattr(s, field, value)
    if updates:
        s.save()
    return Response(_settings_json(request, s))


def _sample(email_type: str) -> dict:
    """Sample values for a preview. The company name is left out: previews use the real one."""
    return {k: v for k, v in catalog.sample_params(email_type).items() if k != "company_name"}


def _template_row(email_type: str, t: EmailMessageTemplate | None, usage: dict, settings: EmailSettings, company: str):
    spec = catalog.TYPES[email_type]
    stats = usage.get(email_type, {})
    master_column = catalog.MODULE_SWITCHES.get(spec.module)
    subject = (t.subject if t else "") or ""
    wording = (t.message_body if t else "") or ""
    preview_subject, preview_text, preview_html = email_service.render_email(
        email_type, _sample(email_type), subject=subject, body=wording, company=company
    )
    return {
        "emailType": email_type,
        "label": spec.label,
        "description": spec.description,
        "category": spec.module,
        "categoryLabel": catalog.MODULES.get(spec.module, spec.module),
        "attachment": spec.attachment,
        "subject": subject,
        "messageBody": wording,
        "defaultSubject": spec.subject,
        "defaultMessage": spec.body,
        "placeholders": catalog.variable_help(email_type),
        "variables": [{"name": v.name, "help": v.help, "sample": v.sample} for v in spec.variables],
        # The fixed table under the wording (label -> variable), if this email has one.
        "details": [{"label": label, "variable": var} for label, var in spec.details],
        "previewSubject": preview_subject,
        "preview": preview_text,
        "previewHtml": preview_html,
        "isEnabled": t.is_enabled if t else True,
        "moduleEnabled": bool(getattr(settings, master_column)) if master_column else None,
        "customised": bool(t and (t.subject.strip() or t.message_body.strip())),
        "updatedAt": t.updated_at.isoformat() if t and t.updated_at else None,
        "total": stats.get("total", 0),
        "failed": stats.get("failed", 0),
        "lastSentAt": stats["last"].isoformat() if stats.get("last") else None,
    }


@api_view(["GET"])
@require_hr
def email_control_templates(request: Request) -> Response:
    existing = {t.email_type: t for t in EmailMessageTemplate.objects.all()}
    usage = {
        row["email_type"]: row
        for row in _messages_qs(request)
        .values("email_type")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")), last=Max("created_at"))
    }
    s = EmailSettings.get()
    company = email_service.company_name(settings_for(request))
    return Response([_template_row(key, existing.get(key), usage, s, company) for key in catalog.TYPES])


def _bad_placeholders(email_type: str, text: str, *, allow_details: bool) -> list[str]:
    """Placeholders in `text` this email type doesn't know (a typo would otherwise send blank)."""
    spec = catalog.TYPES[email_type]
    known = set(spec.variable_names)
    if allow_details and spec.details:
        known.add(catalog.DETAILS_TOKEN)
    bad = []
    for token in _TOKEN.findall(text):
        name = token.strip()
        if name not in known and name not in bad:
            bad.append(name)
    return bad


def _wording_error(email_type: str, subject: str, body: str) -> str | None:
    spec = catalog.TYPES[email_type]
    if len(subject) > SUBJECT_MAX:
        return f"The subject must be at most {SUBJECT_MAX} characters."
    if len(body) > BODY_MAX:
        return f"The message must be at most {BODY_MAX} characters."
    for text, allow_details in ((subject, False), (body, True)):
        bad = _bad_placeholders(email_type, text, allow_details=allow_details)
        if bad:
            shown = ", ".join("{{" + b + "}}" for b in bad)
            extra = f", {{{{{catalog.DETAILS_TOKEN}}}}} (the details table)" if spec.details else ""
            return f"Unknown placeholder {shown}. You can use: {catalog.variable_help(email_type)}{extra}"
    return None


def _text_field(data, key: str) -> tuple[str | None, str | None]:
    """(value, error) for an optional text field in the request body."""
    if key not in data:
        return None, None
    value = data.get(key)
    if value is None:
        return "", None
    if not isinstance(value, str):
        return None, f"{key} must be text"
    return value.strip(), None


@api_view(["PUT"])
@require_hr
def email_control_template_update(request: Request, email_type: str) -> Response:
    if email_type not in TYPE_LABELS:
        return _error(f"Unknown email type: {email_type}")
    data = request.data
    subject, err = _text_field(data, "subject")
    if err:
        return _error(err)
    body, err = _text_field(data, "messageBody")
    if err:
        return _error(err)
    if "isEnabled" in data and not isinstance(data["isEnabled"], bool):
        return _error("isEnabled must be true or false")
    t = EmailMessageTemplate.objects.filter(email_type=email_type).first()
    if subject is not None or body is not None:
        problem = _wording_error(
            email_type,
            subject if subject is not None else (t.subject if t else ""),
            body if body is not None else (t.message_body if t else ""),
        )
        if problem:
            return _error(problem)
    if t is None:
        t = EmailMessageTemplate(email_type=email_type)
    if subject is not None:
        t.subject = subject
    if body is not None:
        t.message_body = body
    if "isEnabled" in data:
        t.is_enabled = data["isEnabled"]
    t.save()
    company = email_service.company_name(settings_for(request))
    return Response(_template_row(email_type, t, {}, EmailSettings.get(), company))


@api_view(["POST"])
@require_hr
def email_control_template_preview(request: Request, email_type: str) -> Response:
    """Render wording with sample values, so HR sees how an email will look before saving it."""
    spec = catalog.get(email_type)
    if spec is None:
        return _error(f"Unknown email type: {email_type}")
    subject, err = _text_field(request.data, "subject")
    if err:
        return _error(err)
    body, err = _text_field(request.data, "messageBody")
    if err:
        return _error(err)
    problem = _wording_error(email_type, subject or "", body or "")
    company = email_service.company_name(settings_for(request))
    rendered_subject, text, html = email_service.render_email(
        email_type, _sample(email_type), subject=subject or "", body=body or "", company=company
    )
    return Response({"subject": rendered_subject, "preview": text, "previewHtml": html, "error": problem})


@api_view(["POST"])
@require_hr
def email_control_test(request: Request) -> Response:
    """Send the test email to one address. The outcome is data, not an HTTP error: the answer is 200 with
    `ok` and, when it did not go out, `status` ("failed" / "blocked") and the reason."""
    to_email = request.data.get("toEmail")
    if not isinstance(to_email, str) or not to_email.strip():
        return _error("Enter the email address to send the test to")
    log = email_service.send_email(
        "test_email",
        to_email=to_email,
        params={},
        ps=settings_for(request),
        sent_by_id=request.jwt_user.get("hrUserId"),
    )
    return Response(
        {
            "ok": log.status == EmailMessageLog.STATUS_SENT,
            "status": log.status,
            "error": log.error_message,
            "sentTo": log.recipient_email,
            "message": _message_json(log),
        }
    )
