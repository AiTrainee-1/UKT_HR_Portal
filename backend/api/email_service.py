"""
Email service -the one place every HRMS module sends email through
==================================================================
    HRMS module -> send_email() -> wording (email_catalog) -> Gmail / SMTP -> recipient

  * email_catalog   what each email is, its default subject and wording, and its variables
  * this module     switches, wording, the log, and the SMTP conversation itself

Every attempt -sent, failed, or held back by HR's switches- ends up as an EmailMessageLog
row that HR sees on the Gmail Control page, and send_email() never raises for an "expected"
failure (no address, switched off, SMTP not set up, the mail server refusing it): callers get
the log row back and report from it.

The Gmail account (host, port, user, app password, from name / address) is the SMTP block of
Settings, resolved by the caller (`settings_for(request)` or `settings_for_employee(emp)`, so a
branch's own account is honoured) and passed in as `ps`. It is never stored on the log.
"""

import html as html_lib
import logging
import re
import smtplib
import ssl
import sys
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr

from django.conf import settings as dj_settings
from django.utils import timezone

from . import email_catalog as catalog
from .clock import FACTORY_TZ

logger = logging.getLogger(__name__)

# What an email row's status can be (EmailMessageLog.STATUS_*).
EMAIL_SENT = "sent"
EMAIL_FAILED = "failed"
EMAIL_BLOCKED = "blocked"

SMTP_TIMEOUT = 15
SMTP_NOT_CONFIGURED = "SMTP settings not configured. Please save SMTP settings in Settings first."

# email_catalog is the single source; kept under these names for callers that want the defaults.
DEFAULT_SUBJECTS = {t.key: t.subject for t in catalog.TYPES.values()}
DEFAULT_BODIES = {t.key: t.body for t in catalog.TYPES.values()}

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ADDRESS = re.compile(r"[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+")
_DETAILS_MARK = object()


# ── SMTP / sending guards ──────────────────────────────────────────────────────


def company_name(ps) -> str:
    return getattr(ps, "company_name", "") or getattr(ps, "slip_company_name", "") or "UKTextiles"


def smtp_missing_reason(ps) -> str | None:
    """Why this account can't send (host, user or password blank), else None."""
    if not (ps.smtp_host and ps.smtp_username and ps.smtp_password):
        return SMTP_NOT_CONFIGURED
    return None


def sending_allowed() -> bool:
    """May this machine send email? On a real server yes; on a development machine no, unless
    EMAIL_ALLOW_SENDING=true says otherwise (see config/settings.py for why)."""
    forced = getattr(dj_settings, "EMAIL_ALLOW_SENDING", None)
    if forced is not None:
        return bool(forced)
    return not dj_settings.DEBUG and "runserver" not in sys.argv


def sending_block_reason(ps) -> str | None:
    """Why nothing can be sent from here, or None when it can."""
    missing = smtp_missing_reason(ps)
    if missing:
        return missing
    if not sending_allowed():
        return (
            "Email sending is switched off on this machine because it is a development setup (DEBUG on or "
            "runserver), so it can't email employees from the live Gmail account. "
            "Set EMAIL_ALLOW_SENDING=true to override."
        )
    return None


def is_configured(ps) -> bool:
    """SMTP details present AND this machine is allowed to send."""
    return sending_block_reason(ps) is None


def _day_start() -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date()
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


def sent_today() -> int:
    from .models import EmailMessageLog

    return EmailMessageLog.objects.filter(status=EmailMessageLog.STATUS_SENT, created_at__gte=_day_start()).count()


def daily_limit_reason() -> str | None:
    from .models import EmailSettings

    limit = EmailSettings.get().daily_send_limit
    if limit and sent_today() >= limit:
        return (
            f"Today's email limit ({limit}) has been reached. It starts again tomorrow, "
            "or raise the limit on the Gmail Control page."
        )
    return None


def switch_off_reason(email_type: str) -> str | None:
    """Why HR's switches say this email must not go out, or None when it may. An email is sent
    only when the master switch, its module's switch and its own switch (Message Text tab) are on."""
    t = catalog.get(email_type)
    if t is None:
        return None
    from .models import EmailMessageTemplate, EmailSettings

    s = EmailSettings.get()
    if not s.emails_enabled:
        return "All emails are switched off on the Gmail Control page."
    master = catalog.MODULE_SWITCHES.get(t.module)
    if master and not getattr(s, master):
        return f"{catalog.MODULES[t.module]} emails are switched off on the Gmail Control page."
    template = EmailMessageTemplate.objects.filter(email_type=email_type).first()
    if template is not None and not template.is_enabled:
        return f"'{t.label}' emails are switched off on the Gmail Control page (Message Text)."
    return None


def feature_enabled(email_type: str) -> bool:
    return switch_off_reason(email_type) is None


# ── wording ────────────────────────────────────────────────────────────────────


def _values(params) -> dict[str, str]:
    return {str(k): "" if v is None else str(v) for k, v in (params or {}).items()}


def _paragraphs(template: str, values: dict[str, str]) -> list:
    """The wording as paragraphs: each a list of lines (placeholders filled), or _DETAILS_MARK where the
    details table goes. A line whose placeholders are ALL empty is dropped, so an optional detail
    ("Location: {{location}}") disappears instead of leaving an empty label."""
    lines: list = []
    for raw in template.replace("\r\n", "\n").split("\n"):
        if raw.strip() in ("{{" + catalog.DETAILS_TOKEN + "}}", "{{ " + catalog.DETAILS_TOKEN + " }}"):
            lines.append(_DETAILS_MARK)
            continue
        names = _PLACEHOLDER.findall(raw)
        if names and all(not values.get(n, "").strip() for n in names):
            continue
        lines.append(_PLACEHOLDER.sub(lambda m: values.get(m.group(1), ""), raw).rstrip())

    paragraphs: list = []
    current: list[str] = []
    for line in lines:
        if line is _DETAILS_MARK:
            if current:
                paragraphs.append(current)
                current = []
            paragraphs.append(_DETAILS_MARK)
        elif not line.strip():
            if current:
                paragraphs.append(current)
                current = []
        else:
            current.append(line)
    if current:
        paragraphs.append(current)
    return paragraphs


def _detail_rows(spec: catalog.EmailType, values: dict[str, str]) -> list[tuple[str, str]]:
    return [(label, values[var].strip()) for label, var in spec.details if values.get(var, "").strip()]


def render_subject(template: str, params) -> str:
    """One line of plain text: a value with a line break in it can never add a mail header."""
    values = _values(params)
    text = _PLACEHOLDER.sub(lambda m: values.get(m.group(1), ""), template)
    return re.sub(r"\s+", " ", text).strip()


def _plain(paragraphs: list, rows: list[tuple[str, str]]) -> str:
    blocks = []
    placed = False
    for p in paragraphs:
        if p is _DETAILS_MARK:
            if rows:
                blocks.append("\n".join(f"{label}: {value}" for label, value in rows))
            placed = True
        else:
            blocks.append("\n".join(_BOLD.sub(r"\1", line) for line in p))
    if rows and not placed:
        blocks.append("\n".join(f"{label}: {value}" for label, value in rows))
    return "\n\n".join(blocks).strip()


def _esc(text: str) -> str:
    return _BOLD.sub(r"<strong>\1</strong>", html_lib.escape(text, quote=True))


def _html(paragraphs: list, rows: list[tuple[str, str]], spec: catalog.EmailType, heading: str, company: str) -> str:
    accent = spec.accent

    def table() -> str:
        cells = "".join(
            f'<tr><td style="padding:4px 8px;color:{accent};font-weight:bold;width:40%">{html_lib.escape(label)}</td>'
            f'<td style="padding:4px 8px">{html_lib.escape(value)}</td></tr>'
            for label, value in rows
        )
        return (
            f'<div style="background:#f3f7f5;padding:14px 16px;border-radius:8px;margin:18px 0;'
            f'border-left:4px solid {accent}">'
            f'<table style="width:100%;border-collapse:collapse;font-size:13px">{cells}</table></div>'
        )

    parts = []
    placed = False
    for p in paragraphs:
        if p is _DETAILS_MARK:
            if rows:
                parts.append(table())
            placed = True
        else:
            parts.append(f'<p style="margin:0 0 14px;line-height:1.5">{"<br>".join(_esc(line) for line in p)}</p>')
    if rows and not placed:
        parts.append(table())

    name = html_lib.escape(company)
    return (
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a3a2e">'
        f'<div style="background:{accent};padding:20px;text-align:center;border-radius:8px 8px 0 0">'
        f'<h1 style="color:white;margin:0;font-size:18px">{name.upper()}</h1>'
        f'<p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">{html_lib.escape(heading)}</p></div>'
        '<div style="background:#ffffff;padding:30px;border:1px solid #d8e5df;border-top:none">'
        f"{''.join(parts)}"
        f'<p style="color:#888;font-size:12px;margin:24px 0 0">This is a system-generated email from the {name} HR Portal.</p>'
        "</div></div>"
    )


def render_email(email_type: str, params, *, subject: str | None = None, body: str | None = None, company: str = ""):
    """(subject, plain_text, html) for `email_type` with `params` filled in. `subject` / `body` override the
    wording (the Message Text preview renders text HR has not saved yet); otherwise HR's saved wording,
    else the catalog default."""
    spec = catalog.get(email_type)
    if spec is None:
        raise ValueError(f"Unknown email type: {email_type}")
    saved_subject, saved_body = _saved_wording(email_type)
    values = {"company_name": "UKTextiles", **_values(params)}
    if company:
        values["company_name"] = company
    subject_tpl = (subject if subject is not None else saved_subject).strip() or spec.subject
    body_tpl = (body if body is not None else saved_body).strip() or spec.body
    paragraphs = _paragraphs(body_tpl, values)
    rows = _detail_rows(spec, values)
    heading = render_subject(spec.heading, values) if spec.heading else spec.label
    return (
        render_subject(subject_tpl, values),
        _plain(paragraphs, rows),
        _html(paragraphs, rows, spec, heading, values["company_name"]),
    )


def _saved_wording(email_type: str) -> tuple[str, str]:
    from .models import EmailMessageTemplate

    row = EmailMessageTemplate.objects.filter(email_type=email_type).first()
    return ((row.subject or "").strip(), (row.message_body or "").strip()) if row else ("", "")


# ── delivery ───────────────────────────────────────────────────────────────────


def _build_message(*, subject, text, html, from_addr, from_name, to_email, attachments) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name or "", from_addr))
    msg["To"] = to_email
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    for filename, content, mime_type in attachments:
        maintype, _, subtype = (mime_type or "application/octet-stream").partition("/")
        msg.add_attachment(content, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
    return msg


def _deliver(ps, msg: EmailMessage, to_email: str) -> None:
    """One SMTP conversation. Port 465 is implicit SSL; anything else is STARTTLS (never a plain
    login), the same as the senders this replaced."""
    from_addr = ps.smtp_from_email or ps.smtp_username
    context = ssl.create_default_context()
    port = ps.smtp_port
    if port == 465:
        with smtplib.SMTP_SSL(ps.smtp_host, port, context=context, timeout=SMTP_TIMEOUT) as server:
            server.login(ps.smtp_username, ps.smtp_password)
            server.send_message(msg, from_addr=from_addr, to_addrs=[to_email])
    else:
        with smtplib.SMTP(ps.smtp_host, port, timeout=SMTP_TIMEOUT) as server:
            server.ehlo()
            server.starttls(context=context)
            server.login(ps.smtp_username, ps.smtp_password)
            server.send_message(msg, from_addr=from_addr, to_addrs=[to_email])


def _failure_text(exc: Exception, ps, to_email: str) -> str:
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        text = "SMTP authentication failed. Check username/password."
        if "gmail" in (ps.smtp_host or "").lower():
            text += (
                " Gmail needs a 16-character App Password (Google Account > Security > 2-Step Verification > "
                "App passwords), not the account's own password."
            )
        return text
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        return f"The mail server refused the address {to_email}."
    return f"Failed to send email: {exc}"


def _log(
    spec_key: str,
    *,
    status: str,
    to_email: str,
    recipient_name: str,
    employee,
    subject: str = "",
    text: str = "",
    attachment_name: str = "",
    error: str = "",
    related_module: str = "",
    ref_id=None,
    sent_by_id=None,
    http_status: int = 200,
):
    from .models import EmailMessageLog

    log = EmailMessageLog.objects.create(
        employee=employee if getattr(employee, "pk", None) else None,
        recipient_name=recipient_name,
        recipient_email=to_email,
        email_type=spec_key,
        related_module=related_module,
        ref_id=ref_id,
        subject=subject,
        message_text=text,
        attachment_name=attachment_name,
        status=status,
        error_message=error,
        sent_by_id=sent_by_id,
    )
    # What an endpoint should answer with when this is not "sent" (not stored).
    log.http_status = http_status
    return log


def send_email(
    email_type: str,
    *,
    to_email: str | None,
    params,
    ps,
    recipient_name: str = "",
    employee=None,
    attachments=None,
    related_module: str = "",
    ref_id: int | None = None,
    sent_by_id: int | None = None,
    automatic: bool = False,
):
    """
    THE entry point for every email. Returns the EmailMessageLog row -status "sent", "failed" or
    "blocked" (see the model)- and never raises for an expected failure. On a row that is not sent,
    `log.http_status` (not stored) is what an endpoint should answer with: 400 when the request
    can't be done (no address, switched off, SMTP not set up), 502 when the mail server said no.

    `params` are the wording's {{variables}}; `ps` is the SMTP account (PayrollSettings or a branch
    overlay); `attachments` is a list of (filename, bytes, mime_type) or a function returning one
    (called only once the email is actually going to be sent, so a switched-off bulk run doesn't
    render a thousand PDFs for nothing).

    `automatic=True` is for mail the system decides to send on its own (a visitor's arrival): when
    it isn't going to be attempted (no address, switched off, SMTP not set up, over the limit) it
    returns None and leaves no row, because nobody asked for it and the history would only fill
    with rows that mean nothing. A real attempt that fails is always logged.
    """
    spec = catalog.get(email_type)
    if spec is None:
        raise ValueError(f"Unknown email type: {email_type}")

    to_email = (to_email or "").strip()
    company = company_name(ps)
    common = dict(
        to_email=to_email,
        recipient_name=recipient_name,
        employee=employee,
        related_module=related_module,
        ref_id=ref_id,
        sent_by_id=sent_by_id,
    )

    def refuse(status: str, reason: str, http_status: int = 400):
        if automatic:
            return None
        return _log(email_type, status=status, error=reason, http_status=http_status, **common)

    try:
        if not to_email:
            return refuse(EMAIL_FAILED, "No email address on file for this recipient.")
        if not _ADDRESS.fullmatch(to_email):
            return refuse(EMAIL_FAILED, f"'{to_email}' is not a valid email address.")
        off = switch_off_reason(email_type)
        if off:
            return refuse(EMAIL_BLOCKED, off)
        block = sending_block_reason(ps)
        if block:
            return refuse(EMAIL_BLOCKED, block)
        limit = daily_limit_reason()
        if limit:
            return refuse(EMAIL_BLOCKED, limit)

        subject, text, html = render_email(email_type, params, company=company)
        files = list(attachments() if callable(attachments) else attachments or [])
    except Exception as exc:
        logger.exception("Email %s could not be prepared", email_type)
        return refuse(EMAIL_FAILED, f"Could not prepare the email: {exc}", 500)

    attachment_name = ", ".join(name for name, _content, _mime in files)
    detail = dict(subject=subject, text=text, attachment_name=attachment_name)
    try:
        msg = _build_message(
            subject=subject,
            text=text,
            html=html,
            from_addr=ps.smtp_from_email or ps.smtp_username,
            from_name=ps.smtp_from_name,
            to_email=to_email,
            attachments=files,
        )
        _deliver(ps, msg, to_email)
    except Exception as exc:
        if not isinstance(exc, (smtplib.SMTPException, OSError)):
            logger.exception("Unexpected error sending %s email", email_type)
        else:
            logger.warning("%s email to %s failed: %s", email_type, to_email, exc)
        return _log(
            email_type,
            status=EMAIL_FAILED,
            error=_failure_text(exc, ps, to_email),
            http_status=502,
            **common,
            **detail,
        )
    return _log(email_type, status=EMAIL_SENT, **common, **detail)
