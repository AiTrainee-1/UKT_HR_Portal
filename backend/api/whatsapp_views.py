"""
WhatsApp Settings (Settings -> WhatsApp tab)
================================================
Two things, deliberately kept separate:
  1. Credential status -read-only, sourced from settings.GUPSHUP_* (.env),
     never editable here. Mirrors how the Backup tab shows pgDumpAvailable
     as a read-only capability flag rather than an input.
  2. Message template configuration -which pre-approved Gupshup template ID
     to use per document type, genuinely editable, stored in
     WhatsAppMessageTemplate. This is business configuration, not a secret.

Also serves the public, unauthenticated media endpoint (whatsapp_media)
Gupshup's servers fetch document/image attachments from -see
whatsapp_service.send_document / WhatsAppMediaAsset.
"""

from django.conf import settings as dj_settings
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_service
from .view_common import error_response as _error
from .auth import require_hr
from .models import WhatsAppMediaAsset, WhatsAppMessageLog, WhatsAppMessageTemplate

DOCUMENT_TYPES = [key for key, _ in WhatsAppMessageLog.DOCUMENT_TYPES]


@api_view(["GET"])
@require_hr
def whatsapp_status(request: Request) -> Response:
    return Response({
        "configured": whatsapp_service.is_configured(),
        "sourceNumber": dj_settings.GUPSHUP_SOURCE_NUMBER[-4:] if dj_settings.GUPSHUP_SOURCE_NUMBER else None,
        "appName": dj_settings.GUPSHUP_APP_NAME or None,
    })


def _template_json(t: WhatsAppMessageTemplate) -> dict:
    return {
        "documentType": t.document_type,
        "gupshupTemplateId": t.gupshup_template_id,
        "variableNote": t.variable_note,
        "isEnabled": t.is_enabled,
    }


@api_view(["GET"])
@require_hr
def whatsapp_templates(request: Request) -> Response:
    """One row per document type, always all DOCUMENT_TYPES represented
    (even if never configured yet) so the Settings UI can render a fixed
    set of rows without guessing what's missing."""
    existing = {t.document_type: t for t in WhatsAppMessageTemplate.objects.all()}
    rows = []
    for doc_type in DOCUMENT_TYPES:
        t = existing.get(doc_type)
        rows.append(_template_json(t) if t else {
            "documentType": doc_type, "gupshupTemplateId": "",
            "variableNote": "", "isEnabled": False,
        })
    return Response(rows)


@api_view(["PUT"])
@require_hr
def whatsapp_template_update(request: Request, document_type: str) -> Response:
    if document_type not in DOCUMENT_TYPES:
        return _error(f"Unknown document type: {document_type}")

    data = request.data
    t, _ = WhatsAppMessageTemplate.objects.get_or_create(document_type=document_type)
    if "gupshupTemplateId" in data:
        t.gupshup_template_id = (data.get("gupshupTemplateId") or "").strip()
    if "variableNote" in data:
        t.variable_note = data.get("variableNote") or ""
    if "isEnabled" in data:
        t.is_enabled = bool(data.get("isEnabled"))
    t.save()
    return Response(_template_json(t))


@api_view(["GET"])
def whatsapp_media(request: Request, token: str):
    """Public, unauthenticated -this is the URL Gupshup's own servers fetch
    a document/image attachment from (see whatsapp_service._media_url), so
    it can't require the HR bearer token. The token itself is the only
    credential: a random 32-byte urlsafe string, unguessable, and the row
    is pruned (see whatsapp_service._store_media) well before it could
    realistically be brute-forced."""
    asset = WhatsAppMediaAsset.objects.filter(token=token).first()
    if not asset or asset.expires_at < timezone.now():
        return Response({"error": "Not found or expired"}, status=404)

    response = HttpResponse(bytes(asset.content), content_type=asset.mime_type)
    response["Content-Disposition"] = f'inline; filename="{asset.filename}"'
    return response


# ── Gupshup webhook (delivery / read receipts) ───────────────────────────────

# Later states never get overwritten by earlier ones: Gupshup can deliver
# events out of order or more than once.
_STATUS_RANK = {"sent": 0, "enqueued": 0, "delivered": 1, "read": 2}


def _status_updates(event: dict):
    """Yield (ids, status, error_text) from either Gupshup payload format.

    v2 (Gupshup format): {"type": "message-event", "payload": {"id": <WhatsApp
    id>, "gsId": <Gupshup id>, "type": "sent|delivered|read|failed|enqueued",
    "payload": {"code": ..., "reason": ...}}}

    v3 (Meta format): {"object": "whatsapp_business_account", "entry": [{
    "changes": [{"value": {"statuses": [{"id": <WhatsApp id>, "gs_id":
    <Gupshup id>, "status": "...", "errors": [{"code", "title", "message"}]}]}}]}]}

    Our stored gupshup_message_id is what the send API returned, which is the
    Gupshup id (gsId / gs_id), so both ids are tried.
    """
    if event.get("type") == "message-event":
        outer = event.get("payload") or {}
        detail = outer.get("payload") or {}
        yield (
            [i for i in (outer.get("gsId"), outer.get("id")) if i],
            outer.get("type"),
            str(detail.get("reason") or detail.get("code") or ""),
        )
        return
    for entry in event.get("entry") or []:
        for change in entry.get("changes") or []:
            for st in (change.get("value") or {}).get("statuses") or []:
                err = (st.get("errors") or [{}])[0]
                yield (
                    [i for i in (st.get("gs_id"), st.get("id")) if i],
                    st.get("status"),
                    str(err.get("message") or err.get("title") or err.get("code") or ""),
                )


def _apply_message_event(event: dict) -> None:
    """Fold Gupshup delivery events (either payload format) into WhatsAppMessageLog.status."""
    for ids, new_status, error_text in _status_updates(event):
        if not new_status or not ids:
            continue
        for log in WhatsAppMessageLog.objects.filter(gupshup_message_id__in=ids):
            if new_status == "failed":
                log.status = "failed"
                log.error_message = (error_text or "Delivery failed")[:500]
            elif _STATUS_RANK.get(new_status, -1) > _STATUS_RANK.get(log.status, 0):
                log.status = new_status
            else:
                continue
            log.save(update_fields=["status", "error_message"])


@api_view(["GET", "POST", "HEAD", "OPTIONS"])
def whatsapp_webhook(request: Request) -> Response:
    """Public callback URL for Gupshup (Settings -> Webhook in the Gupshup console).

    Gupshup validates the URL when you save it by calling it and requiring a
    2xx, so this must always answer 200 -even for an empty or unrecognised
    body, and even if processing an event fails (a 5xx makes Gupshup retry and
    eventually disable the callback). If WHATSAPP_WEBHOOK_TOKEN is set, the
    callback URL must carry it as ?token=...; a wrong token is a 403.
    """
    expected = dj_settings.WHATSAPP_WEBHOOK_TOKEN
    if expected and request.query_params.get("token") != expected:
        return _error("Forbidden", 403)

    if request.method == "POST":
        try:
            # Reading the body can itself raise (non-JSON content type, bad JSON).
            body = request.data
            if isinstance(body, dict):
                _apply_message_event(body)
        except Exception:
            import logging

            logging.getLogger(__name__).exception("Gupshup webhook event could not be processed")
    return Response({"status": "ok"})
