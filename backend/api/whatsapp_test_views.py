"""WhatsApp Control -> Send a test / Connection (owner 2026-11-17: "WhatsApp is still not working; add a dedicated test").

    GET  /api/whatsapp-control/connection    every reason WhatsApp may not be sending, in one answer: the WAClient keys,
                                             this machine's send rules (development safety, WHATSAPP_ONLY_TO_EMPLOYEES),
                                             WAClient's own view of the linked number (GET /instance_status, live), the
                                             master switch, quiet hours, the circuit breaker, the queue, the last failure,
                                             and whether WAClient can download documents from this server. Sends nothing.
    GET  /api/whatsapp-control/test-message  who may receive a test (on a limited machine: only the named employees) and
                                             the message types that can be tried
    POST /api/whatsapp-control/test-message  {documentType, employeeId, text?, dryRun?}: the message's wording (HR's,
                                             else the default) filled with sample values and the employee's own name, or
                                             the text HR edited; with dryRun only the preview, else SENT AT ONCE (not
                                             queued) and the real answer returned: sent with WAClient's message id, or
                                             failed with WAClient's own error, its HTTP status and response.

A test message ignores the switches, quiet hours and pacing (it is a check of the connection), but never this machine's send
rules: credentials, the development-machine lock and the recipient limit apply exactly as for every other message (they are
enforced in whatsapp_service._post_send). Documents are tried as their text only (the file is not attached). Every test is a
WhatsAppMessageLog row (payload {"test": true}) and an audit entry.
"""

from __future__ import annotations

from urllib.parse import urlparse

from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_dispatcher, whatsapp_service
from . import whatsapp_catalog as catalog
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Employee, WhatsAppMessageLog
from .view_common import error_response as _error

AUDIT_MODULE = "whatsapp_control"
NOT_TESTABLE = frozenset({"visitor_contact"})  # a contact card, not text


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


def _types() -> list[dict]:
    return [
        {
            "documentType": key,
            "label": t.label,
            "module": t.module,
            "moduleLabel": catalog.MODULES.get(t.module, t.module),
            "kind": t.kind,
            "variables": [{"name": v.name, "sample": v.sample} for v in t.variables],
        }
        for key, t in catalog.TYPES.items()
        if t.has_wording and key not in NOT_TESTABLE
    ]


@api_view(["GET", "POST"])
@require_hr
def whatsapp_test_message(request: Request) -> Response:
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
                "types": _types(),
            }
        )

    data = request.data if isinstance(request.data, dict) else {}
    key = str(data.get("documentType") or "")
    spec = catalog.get(key)
    if spec is None or not spec.has_wording or key in NOT_TESTABLE:
        return _error("Choose a message type that has text.")
    emp_id = data.get("employeeId")
    emp = _employees(request).filter(pk=emp_id).first() if str(emp_id or "").isdigit() else None
    if emp is None:
        return _error("Choose an active employee.", 404)
    phone = whatsapp_service.normalize_phone(emp.phone)
    if not phone:
        return _error(f"{emp.first_name} {emp.last_name} has no usable phone number on file.")

    edited = data.get("text")
    if edited is not None and (not isinstance(edited, str) or not edited.strip()):
        return _error("The message cannot be empty.")
    if isinstance(edited, str) and len(edited) > 4000:
        return _error("The message can be at most 4000 characters.")
    if edited:
        text = edited.strip()
    else:
        params = {**catalog.sample_params(key), "employee_name": f"{emp.first_name} {emp.last_name}".strip()}
        text = whatsapp_service.render_message(
            whatsapp_service._template_body(key), params, whatsapp_service._order_for(key)
        )
    block = whatsapp_service.sending_block_reason() or whatsapp_service.recipient_block_reason(phone)
    head = {"documentType": key, "to": _mask(phone), "employee": _recipient_row(emp), "text": text}
    if data.get("dryRun") is True:
        return Response({**head, "status": "preview", "blockReason": block})
    if block:
        return Response({**head, "status": "blocked", "error": block, "httpStatus": None, "providerResponse": None})

    log = WhatsAppMessageLog.objects.create(
        employee=emp,
        document_type=key,
        phone_number=phone,
        status=WhatsAppMessageLog.STATUS_SENDING,
        sent_by=getattr(request, "hr_actor", None),
        message_text=text,
        kind=spec.kind,
        priority=0,
        attempts=1,
        payload={"test": True},
    )
    try:
        result = whatsapp_service.send_text_message(phone, text)
    except whatsapp_service.WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)[:1000]
        log.save(update_fields=["status", "error_message", "updated_at"])
        log_action(
            request,
            "test",
            AUDIT_MODULE,
            record_id=log.pk,
            description=f"Test WhatsApp to {emp.employee_code} failed: {exc}",
        )
        return Response(
            {
                **head,
                "status": "failed",
                "logId": log.pk,
                "error": str(exc),
                "httpStatus": exc.http_status,
                "providerResponse": exc.provider_response,
            }
        )
    log.status = WhatsAppMessageLog.STATUS_SENT
    log.provider_message_id = whatsapp_service._provider_message_id(result)
    log.sent_at = timezone.now()
    log.save(update_fields=["status", "provider_message_id", "sent_at", "updated_at"])
    log_action(
        request, "test", AUDIT_MODULE, record_id=log.pk, description=f"Test WhatsApp sent to {emp.employee_code}"
    )
    return Response(
        {
            **head,
            "status": "sent",
            "logId": log.pk,
            "providerMessageId": log.provider_message_id or None,
            "providerResponse": whatsapp_service._without_credentials(result),
        }
    )


@api_view(["GET"])
@require_hr
def whatsapp_connection(request: Request) -> Response:
    """Every reason WhatsApp may not be sending, most important first in `problems`."""
    from django.conf import settings as dj_settings

    creds = whatsapp_service.has_credentials()
    provider = whatsapp_service.instance_status() if creds else None
    queue = whatsapp_dispatcher.queue_status()
    last = (
        WhatsAppMessageLog.objects.filter(status=WhatsAppMessageLog.STATUS_FAILED)
        .order_by("-updated_at")
        .values("updated_at", "error_message", "document_type")
        .first()
    )
    base = whatsapp_service._backend_public_base_url(request)
    documents = whatsapp_service.public_base_problem(base)
    limited = whatsapp_service.recipient_codes()

    problems: list[str] = []
    if not creds:
        problems.append(
            "The WAClient keys are missing on this server: set WACLIENT_INSTANCE_ID and WACLIENT_ACCESS_TOKEN (backend/.env "
            "locally, Railway Variables on the live server) and restart the backend."
        )
    elif provider and not provider.get("ok"):
        problems.append(f"WAClient did not answer the status check: {provider.get('error')}")
    elif provider and provider.get("state") != "connected":
        problems.append(
            f"The WhatsApp number is '{provider.get('state')}' at WAClient, not connected: open app.waclient.com and "
            "link the number again (scan the QR code)."
        )
    elif provider and provider.get("reloginRequired"):
        problems.append("WAClient says the number must be linked again (scan the QR code at app.waclient.com).")
    block = whatsapp_service.sending_block_reason()
    if creds and block:
        problems.append(block)
    if not queue.get("engineEnabled"):
        problems.append("The master switch is OFF (Feature Controls): no WhatsApp message is sent, codes included.")
    if queue.get("paused"):
        problems.append(f"Sending is paused: {queue.get('pausedReason')}")
    if queue.get("inQuietHours"):
        problems.append("It is quiet hours: messages raised now are not sent (codes still are).")
    if documents:
        problems.append(f"Documents cannot be sent from here: {documents}")

    return Response(
        {
            "ok": not problems,
            "problems": problems,
            "credentials": creds,
            "instance": f"…{dj_settings.WACLIENT_INSTANCE_ID[-4:]}" if creds else None,
            "apiHost": (urlparse(dj_settings.WACLIENT_API_URL).hostname or None),
            "machine": {
                "developmentMachine": whatsapp_service.development_machine(),
                "sendingAllowed": whatsapp_service.sending_allowed(),
                "blockReason": block,
                "limitedTo": limited or None,
            },
            "provider": provider,
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
            "documents": {"publicBase": base, "problem": documents},
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
