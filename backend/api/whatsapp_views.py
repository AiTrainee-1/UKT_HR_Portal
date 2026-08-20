"""
WhatsApp Settings (Settings -> WhatsApp tab)
================================================
Two things, deliberately kept separate:
  1. Credential status -read-only, sourced from settings.WHATSAPP_* (.env),
     never editable here. Mirrors how the Backup tab shows pgDumpAvailable
     as a read-only capability flag rather than an input.
  2. Message template configuration -which pre-approved Meta template
     name/language to use per document type, genuinely editable, stored in
     WhatsAppMessageTemplate. This is business configuration, not a secret.
"""

from django.conf import settings as dj_settings
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_service
from .auth import require_hr
from .models import WhatsAppMessageLog, WhatsAppMessageTemplate

DOCUMENT_TYPES = [key for key, _ in WhatsAppMessageLog.DOCUMENT_TYPES]


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


@api_view(["GET"])
@require_hr
def whatsapp_status(request: Request) -> Response:
    return Response({
        "configured": whatsapp_service.is_configured(),
        "phoneNumberId": dj_settings.WHATSAPP_PHONE_NUMBER_ID[-4:] if dj_settings.WHATSAPP_PHONE_NUMBER_ID else None,
        "apiVersion": dj_settings.WHATSAPP_API_VERSION,
    })


def _template_json(t: WhatsAppMessageTemplate) -> dict:
    return {
        "documentType": t.document_type,
        "metaTemplateName": t.meta_template_name,
        "metaLanguageCode": t.meta_language_code,
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
            "documentType": doc_type, "metaTemplateName": "", "metaLanguageCode": "en",
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
    if "metaTemplateName" in data:
        t.meta_template_name = (data.get("metaTemplateName") or "").strip()
    if "metaLanguageCode" in data:
        t.meta_language_code = (data.get("metaLanguageCode") or "en").strip()
    if "variableNote" in data:
        t.variable_note = data.get("variableNote") or ""
    if "isEnabled" in data:
        t.is_enabled = bool(data.get("isEnabled"))
    t.save()
    return Response(_template_json(t))
