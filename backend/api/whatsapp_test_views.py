"""WhatsApp Control -> Send a test / Settings (connection check), for the Meta WhatsApp Cloud API (2026-11-20).

    GET  /api/whatsapp-control/connection    the readiness checklist, in one answer. Sends nothing:
            env         [{name, set, secret, required}] for every WHATSAPP_CLOUD_* variable (names only, never a value)
            configured  the variables needed to send are set;  sendingAllowed  this machine may send (development
                        safety, WHATSAPP_ONLY_TO_EMPLOYEES);  blockReasons  every reason nothing can be sent right now
            phone       Meta's view of the number (asked live): displayPhoneNumber, verifiedName, qualityRating,
                        messagingLimitTier, status, nameStatus, codeVerificationStatus, throughput, platformType | null
            tokenOk     Meta accepted the token (True) / refused it (False) / not known (null);  error  Meta's answer
            apiVersion, apiBase (host only), templateLanguage
            webhook     {url (this server's /api/whatsapp/webhook/, from BACKEND_PUBLIC_URL or the request), verifyTokenSet,
                        appSecretSet, lastWebhookAt}
            devLock     {onlyToEmployees: [codes] | []}  (WHATSAPP_ONLY_TO_EMPLOYEES, local runserver only)
            templates   {approved, total}
            plus, for the older page: ok, problems, machine, queue, lastFailure, checkedAt.
    GET  /api/whatsapp-control/test-message  who may receive a test (on a limited machine: only the named employees) and
                                             the message types that can be tried, each with its template and status
    POST /api/whatsapp-control/test-message  {documentType, employeeId, params?, dryRun?}: the type's template filled with
                                             sample values, the employee's own name and HR's edits (`params`); with
                                             dryRun only the preview (template, language, status, variables, the text the
                                             employee would read, and why it would not go), else SENT AT ONCE (not
                                             queued) and Meta's real answer returned: sent with the wamid, or failed with
                                             Meta's error code and message. Free text (`text`) is refused: Meta only
                                             delivers approved templates.

A test message ignores the switches, quiet hours and pacing (it is a check of the connection and of the template), but
never this machine's send rules: credentials, the development-machine lock and the recipient limit apply exactly as for
every other message (whatsapp_service._guard). A document / ID card type sends a small sample file in the template's
header; a one-time-code type sends a random test code (it does not sign anybody in). Every test is a WhatsAppMessageLog
row (payload {"test": true}) and an audit entry.
"""

from __future__ import annotations

import base64
import secrets

from django.conf import settings as dj_settings
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_cloud, whatsapp_dispatcher, whatsapp_service
from . import whatsapp_catalog as catalog
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Employee, WhatsAppMessageLog, WhatsAppSettings, WhatsAppTemplate
from .view_common import error_response as _error

AUDIT_MODULE = "whatsapp_control"
MAX_PARAM = 300

# A 1x1 PNG: the picture a test of an ID card (image header) template carries.
SAMPLE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def sample_pdf() -> bytes:
    """A one-page PDF: the file a test of a document template carries in its header."""
    from io import BytesIO

    from reportlab.lib.pagesizes import A6
    from reportlab.pdfgen import canvas

    out = BytesIO()
    page = canvas.Canvas(out, pagesize=A6)
    page.setFont("Helvetica-Bold", 13)
    page.drawString(24, 330, "UK Textiles HRMS")
    page.setFont("Helvetica", 10)
    page.drawString(24, 310, "WhatsApp test document")
    page.drawString(24, 294, timezone.now().strftime("Sent %d %b %Y"))
    page.showPage()
    page.save()
    return out.getvalue()


def _mask(phone: str | None) -> str | None:
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    return f"••••{digits[-4:]}" if len(digits) >= 4 else None


def _employees(request: Request):
    return scope_to_branch(Employee.objects.filter(status="active"), request, field="branch_id").defer("photo_url")


def _recipient_row(e: Employee) -> dict:
    phone = whatsapp_service.normalize_phone(e.phone)
    return {
        "id": e.id,
        "code": e.employee_code,
        "name": f"{e.first_name} {e.last_name}".strip(),
        "phone": _mask(phone),
        "hasPhone": bool(phone),
        "blockedReason": whatsapp_service.recipient_block_reason(phone) if phone else "No phone number on file",
    }


def _template_json(choice: whatsapp_service.TemplateChoice) -> dict:
    return {
        "name": choice.name,
        "language": choice.language,
        "status": choice.status,
        "category": choice.category,
        "approved": choice.problem is None,
        "problem": choice.problem,
        "header": choice.header,
    }


def _types(s) -> list[dict]:
    out = []
    for key, t in catalog.TYPES.items():
        if t.default_template_name is None:
            continue  # never sent through Meta (the retired visitor contact card ...)
        choice = whatsapp_service.template_for(key, s)
        out.append(
            {
                "documentType": key,
                "label": t.label,
                "module": t.module,
                "moduleLabel": catalog.MODULES.get(t.module, t.module),
                "kind": t.kind,
                "variables": [{"name": v.name, "sample": v.sample} for v in t.variables],
                "template": _template_json(choice),
            }
        )
    return out


def _sample_media(choice: whatsapp_service.TemplateChoice):
    if choice.header == "image":
        return SAMPLE_PNG, "test.png", "image/png"
    if choice.header == "document":
        return lambda: (sample_pdf(), "UK-Textiles-HRMS-test.pdf", "application/pdf")
    return None


@api_view(["GET", "POST"])
@require_hr
def whatsapp_test_message(request: Request) -> Response:
    s = WhatsAppSettings.get()
    if request.method == "GET":
        limited = whatsapp_service.recipient_codes()
        qs = _employees(request)
        if whatsapp_service.allowed_numbers() is not None:
            # a limited machine: only the employees it may message are offered
            qs = qs.filter(employee_code__in=limited)
        elif search := (request.query_params.get("search") or "").strip():
            qs = qs.filter(
                Q(first_name__icontains=search) | Q(last_name__icontains=search) | Q(employee_code__icontains=search)
            )
        else:
            qs = qs.none()
        return Response(
            {
                "blockReason": whatsapp_service.sending_block_reason(),
                "limitedTo": limited or None,
                "recipients": [_recipient_row(e) for e in qs.order_by("first_name", "id")[:20]],
                "types": _types(s),
            }
        )

    data = request.data if isinstance(request.data, dict) else {}
    key = str(data.get("documentType") or "")
    spec = catalog.get(key)
    if spec is None or spec.default_template_name is None:
        return _error("Choose a message type that is sent as a WhatsApp template.")
    if data.get("text") not in (None, ""):
        return _error(
            "Free text can't be sent through the WhatsApp Cloud API: Meta delivers approved templates only. "
            "Change the template's variables instead."
        )
    edits = data.get("params")
    if edits is not None and not isinstance(edits, dict):
        return _error("params must be an object of variable name -> value.")
    emp_id = data.get("employeeId")
    emp = _employees(request).filter(pk=emp_id).first() if str(emp_id or "").isdigit() else None
    if emp is None:
        return _error("Choose an active employee.", 404)
    phone = whatsapp_service.normalize_phone(emp.phone)
    if not phone:
        return _error(f"{emp.first_name} {emp.last_name} has no usable phone number on file.")

    choice = whatsapp_service.template_for(key, s)
    params = {**catalog.sample_params(key), "employee_name": f"{emp.first_name} {emp.last_name}".strip()}
    for name, value in (edits or {}).items():
        if not isinstance(value, (str, int, float)) or len(str(value)) > MAX_PARAM:
            return _error(f"The value of '{name}' must be text of at most {MAX_PARAM} characters.")
        params[str(name)] = str(value)
    is_code = choice.category == whatsapp_service.AUTHENTICATION or spec.kind == catalog.KIND_CODE
    code = f"{secrets.randbelow(10**6):06d}" if is_code else None
    if is_code:
        params["code"] = code
    sent_params = (
        {"code": code}
        if choice.category == whatsapp_service.AUTHENTICATION
        else {k: whatsapp_cloud.sanitize_param(v) for k, v in whatsapp_service.template_params(choice, params).items()}
    )
    text = whatsapp_service.render_template_text(choice, params)
    block = whatsapp_service.sending_block_reason() or whatsapp_service.recipient_block_reason(phone) or choice.problem
    head = {
        "documentType": key,
        "to": _mask(phone),
        "employee": _recipient_row(emp),
        "template": _template_json(choice),
        "params": sent_params,
        "header": choice.header or None,
        "text": text,
    }
    if data.get("dryRun") is True:
        return Response({**head, "status": "preview", "blockReason": block})
    if block:
        return Response(
            {**head, "status": "blocked", "error": block, "code": None, "httpStatus": None, "providerResponse": None}
        )

    log = WhatsAppMessageLog.objects.create(
        employee=emp,
        document_type=key,
        phone_number=phone,
        status=WhatsAppMessageLog.STATUS_SENDING,
        sent_by=getattr(request, "hr_actor", None),
        message_text=whatsapp_service.render_auth_text("••••••", choice) if is_code else text,
        kind=spec.kind,
        priority=0,
        attempts=1,
        payload={"test": True},
        template_name=choice.name or "",
    )
    try:
        if is_code:
            result = whatsapp_service.deliver_code(phone, key, code, choice=choice)
        else:
            result = whatsapp_service.deliver_template(phone, key, params, media=_sample_media(choice), choice=choice)
    except whatsapp_service.WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)[:1000]
        log.save(update_fields=["status", "error_message", "updated_at"])
        log_action(
            request,
            "test",
            AUDIT_MODULE,
            record_id=log.pk,
            description=f"Test WhatsApp ({choice.name}) to {emp.employee_code} failed: {exc}",
        )
        return Response(
            {
                **head,
                "status": "failed",
                "logId": log.pk,
                "error": str(exc),
                "code": exc.code,
                "metaMessage": exc.meta_message or None,
                "httpStatus": exc.http_status,
                "providerResponse": whatsapp_service._without_credentials(exc.provider_response),
            }
        )
    log.status = WhatsAppMessageLog.STATUS_SENT
    log.provider_message_id = result.wamid
    log.sent_at = timezone.now()
    log.save(update_fields=["status", "provider_message_id", "sent_at", "updated_at"])
    log_action(
        request,
        "test",
        AUDIT_MODULE,
        record_id=log.pk,
        description=f"Test WhatsApp ({choice.name}) sent to {emp.employee_code}",
    )
    return Response(
        {
            **head,
            "status": "sent",
            "logId": log.pk,
            "providerMessageId": result.wamid,
            "testCode": code,
        }
    )


def webhook_url(request) -> str:
    base = whatsapp_service._backend_public_base_url(request)
    return f"{base}/api/whatsapp/webhook/" if base else "/api/whatsapp/webhook/"


@api_view(["GET"])
@require_hr
def whatsapp_connection(request: Request) -> Response:
    """The readiness checklist (see the module docstring). Asks Meta about the number live."""
    s = WhatsAppSettings.get()
    configured = whatsapp_cloud.is_configured()
    status = whatsapp_service.phone_status(refresh=True) if configured else None
    queue = whatsapp_dispatcher.queue_status()
    last = (
        WhatsAppMessageLog.objects.filter(status=WhatsAppMessageLog.STATUS_FAILED)
        .order_by("-updated_at")
        .values("updated_at", "error_message", "document_type")
        .first()
    )
    limited = whatsapp_service.recipient_codes()
    block = whatsapp_service.sending_block_reason()

    block_reasons: list[str] = []
    missing = whatsapp_cloud.missing_env()
    if not configured:
        block_reasons.append(
            "WhatsApp (Meta Cloud API) is not configured: set "
            + ", ".join(missing or ["the WHATSAPP_CLOUD_* variables"])
            + " (backend/.env locally, Railway Variables on the live server) and restart the backend."
        )
    elif block:
        block_reasons.append(block)
    if status is not None and not status.get("ok"):
        if status.get("tokenOk") is False:
            block_reasons.append(f"Meta refused the access token: {status.get('error')}")
        else:
            block_reasons.append(f"Meta did not answer the number check: {status.get('error')}")
    if not s.engine_enabled:
        block_reasons.append(
            "The master switch is OFF (Message Controls): no WhatsApp message is sent, codes included."
        )
    if queue.get("paused"):
        block_reasons.append(f"Sending is paused: {queue.get('pausedReason')}")

    warnings: list[str] = []
    if queue.get("inQuietHours"):
        warnings.append("It is quiet hours: messages raised now are not sent (codes still are).")
    if configured and missing:
        warnings.append(
            "The webhook is not fully set up (missing " + ", ".join(missing) + "): delivery and read receipts, "
            "template approvals and STOP replies will not reach this server."
        )
    if configured and s.last_webhook_at is None:
        warnings.append(
            "Meta's webhook has never reached this server: check the callback URL and verify token in Meta."
        )

    phone = status.get("phone") if status else None
    return Response(
        {
            "env": whatsapp_cloud.env_status(),
            "configured": configured,
            "sendingAllowed": whatsapp_service.sending_allowed(),
            "blockReasons": block_reasons,
            "warnings": warnings,
            "phone": phone,
            "tokenOk": status.get("tokenOk") if status else None,
            "error": status.get("error") if status and not status.get("ok") else None,
            "errorCode": status.get("code") if status and not status.get("ok") else None,
            "apiVersion": whatsapp_cloud.api_version(),
            "apiBase": whatsapp_cloud.api_base(),
            "templateLanguage": whatsapp_cloud.template_language(),
            "webhook": {
                "url": webhook_url(request),
                "verifyTokenSet": bool(str(getattr(dj_settings, "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", "") or "")),
                "appSecretSet": bool(str(getattr(dj_settings, "WHATSAPP_CLOUD_APP_SECRET", "") or "")),
                "lastWebhookAt": s.last_webhook_at.isoformat() if s.last_webhook_at else None,
            },
            "devLock": {"onlyToEmployees": limited},
            "templates": {
                "approved": WhatsAppTemplate.objects.filter(status=whatsapp_service.APPROVED).count(),
                "total": WhatsAppTemplate.objects.count(),
            },
            # the older page's keys
            "ok": not block_reasons,
            "problems": block_reasons + warnings,
            "machine": {
                "developmentMachine": whatsapp_service.development_machine(),
                "sendingAllowed": whatsapp_service.sending_allowed(),
                "blockReason": block,
                "limitedTo": limited or None,
            },
            "queue": {
                k: queue.get(k)
                for k in (
                    "engineEnabled",
                    "paused",
                    "pausedReason",
                    "inQuietHours",
                    "queued",
                    "sentToday",
                    "failedToday",
                )
            },
            "lastFailure": (
                {
                    "at": last["updated_at"].isoformat(),
                    "error": last["error_message"],
                    "documentType": last["document_type"],
                }
                if last
                else None
            ),
            "checkedAt": timezone.now().isoformat(),
        }
    )
