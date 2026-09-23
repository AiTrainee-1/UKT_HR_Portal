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
from .auth import require_hr
from .models import WhatsAppMediaAsset, WhatsAppMessageLog, WhatsAppMessageTemplate

DOCUMENT_TYPES = [key for key, _ in WhatsAppMessageLog.DOCUMENT_TYPES]


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


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
