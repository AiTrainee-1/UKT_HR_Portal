"""
WhatsApp Cloud API -shared sending service module
=====================================================
Mirrors the shape of the existing email-sending helpers (see
salary_slip_views.py::_send_slip_email) but for Meta's WhatsApp Business
Platform (Cloud API). Every document type's send endpoint (Salary Slip, ID
Card, Offer/Experience/Resignation Letter, other Employee Documents) calls
through send_document() below, so behavior -phone normalization, template
lookup, error logging -never diverges between them, exactly like every
email endpoint shares one SMTP-configured guard clause today.

Credentials (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID /
WHATSAPP_BUSINESS_ACCOUNT_ID) are .env-only -see config/settings.py -never
stored in the database or editable from the UI, unlike SMTP. Settings ->
WhatsApp only lets HR pick which pre-approved Meta template name/language
to use per document type (WhatsAppMessageTemplate), since Meta requires
every business-initiated message to use a template it has already reviewed
-the wording itself isn't freely editable here, only which approved
template gets used.

send_document() never raises for an "expected" failure (not configured, no
phone on file, no template configured, or a Meta API error) -it always
returns a WhatsAppMessageLog row either way, so callers (single-send views
and the bulk-send loop alike) have one uniform way to report success/
failure without needing try/except at every call site.
"""

import logging

import requests
from django.conf import settings as dj_settings

logger = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.facebook.com"


class WhatsAppServiceError(Exception):
    pass


def is_configured() -> bool:
    return bool(
        dj_settings.WHATSAPP_ACCESS_TOKEN
        and dj_settings.WHATSAPP_PHONE_NUMBER_ID
    )


def _api_url(path: str) -> str:
    version = dj_settings.WHATSAPP_API_VERSION or "v21.0"
    return f"{_GRAPH_BASE}/{version}/{path}"


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {dj_settings.WHATSAPP_ACCESS_TOKEN}"}


def normalize_phone(raw: str | None) -> str | None:
    """
    Employee.phone is stored as a plain local number (no country code, no
    formatting guarantees at all -it's a free-text field). WhatsApp's Cloud
    API needs the full international number with no leading '+' or
    punctuation. Prefixes WHATSAPP_DEFAULT_COUNTRY_CODE (default "91") only
    when the number doesn't already start with it. Returns None if there's
    nothing usable to send to, so callers can report "no phone on file"
    cleanly instead of sending garbage to Meta's API.
    """
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return None
    country_code = dj_settings.WHATSAPP_DEFAULT_COUNTRY_CODE or "91"
    if digits.startswith(country_code) and len(digits) > len(country_code) + 5:
        return digits
    return f"{country_code}{digits}"


def upload_media(file_bytes: bytes, filename: str, mime_type: str) -> str:
    """POST /{PHONE_NUMBER_ID}/media -uploads the document once, returns
    Meta's media_id to reference in the template send below. Raises
    WhatsAppServiceError with a clean message on any failure."""
    url = _api_url(f"{dj_settings.WHATSAPP_PHONE_NUMBER_ID}/media")
    files = {"file": (filename, file_bytes, mime_type)}
    data = {"messaging_product": "whatsapp", "type": mime_type}
    try:
        resp = requests.post(url, headers=_auth_headers(), files=files, data=data, timeout=30)
    except requests.RequestException as exc:
        raise WhatsAppServiceError(f"Could not reach WhatsApp API: {exc}")

    body = resp.json() if resp.content else {}
    if resp.status_code >= 400 or "id" not in body:
        detail = (body.get("error") or {}).get("message") or resp.text[:200]
        raise WhatsAppServiceError(f"Media upload failed: {detail}")
    return body["id"]


def send_document_template(
    to_phone: str, template_name: str, language_code: str,
    media_id: str, filename: str, body_params: list[str], header_type: str = "document",
) -> dict:
    """POST /{PHONE_NUMBER_ID}/messages -a template message with a header
    referencing the already-uploaded media_id (Document for PDFs, Image for
    the ID card PNG -Meta requires the header parameter's type to match the
    approved template's own header format, so send_document below picks
    this from the mime type it's given) and body {{n}} variables filled
    from body_params, in order. Raises WhatsAppServiceError with Meta's own
    error detail on failure."""
    url = _api_url(f"{dj_settings.WHATSAPP_PHONE_NUMBER_ID}/messages")
    if header_type == "image":
        header_param = {"type": "image", "image": {"id": media_id}}
    else:
        header_param = {"type": "document", "document": {"id": media_id, "filename": filename}}
    components = [
        {"type": "header", "parameters": [header_param]},
    ]
    if body_params:
        components.append({
            "type": "body",
            "parameters": [{"type": "text", "text": p} for p in body_params],
        })
    payload = {
        "messaging_product": "whatsapp",
        "to": to_phone,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": language_code or "en"},
            "components": components,
        },
    }
    try:
        resp = requests.post(url, headers={**_auth_headers(), "Content-Type": "application/json"}, json=payload, timeout=30)
    except requests.RequestException as exc:
        raise WhatsAppServiceError(f"Could not reach WhatsApp API: {exc}")

    body = resp.json() if resp.content else {}
    if resp.status_code >= 400:
        detail = (body.get("error") or {}).get("message") or resp.text[:200]
        raise WhatsAppServiceError(f"Send failed: {detail}")
    return body


def _log(employee, document_type: str, document_ref_id, phone_number: str,
          status: str, meta_message_id: str = "", error_message: str = "", sent_by_id=None):
    from .models import WhatsAppMessageLog

    return WhatsAppMessageLog.objects.create(
        employee=employee, document_type=document_type, document_ref_id=document_ref_id,
        phone_number=phone_number or "", status=status,
        meta_message_id=meta_message_id, error_message=error_message, sent_by_id=sent_by_id,
    )


def send_document(
    employee, document_type: str, pdf_bytes: bytes, filename: str,
    body_params: list[str], mime_type: str = "application/pdf",
    document_ref_id: int | None = None, sent_by_id: int | None = None,
):
    """
    The one entry point every send endpoint (single or bulk) should call.
    Normalizes the phone, looks up the configured+enabled template for this
    document_type, uploads the document, sends the template message, and
    always writes a WhatsAppMessageLog row -on the "expected" failure paths
    (not configured / no phone / no template) just as much as on success or
    a Meta API error, so callers never need their own try/except to get a
    uniform result to report back to the user.
    """
    from .models import WhatsAppMessageTemplate

    phone = normalize_phone(getattr(employee, "phone", None))

    if not is_configured():
        return _log(employee, document_type, document_ref_id, phone or "", "failed",
                     error_message="WhatsApp is not configured on this server (missing credentials in .env).",
                     sent_by_id=sent_by_id)

    if not phone:
        return _log(employee, document_type, document_ref_id, "", "failed",
                     error_message="No phone number on file for this employee.", sent_by_id=sent_by_id)

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type, is_enabled=True).first()
    if not template or not template.meta_template_name:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=f"No WhatsApp template configured for '{document_type}' -set one up in Settings → WhatsApp.",
                     sent_by_id=sent_by_id)

    header_type = "image" if mime_type.startswith("image/") else "document"
    try:
        media_id = upload_media(pdf_bytes, filename, mime_type)
        result = send_document_template(
            phone, template.meta_template_name, template.meta_language_code, media_id, filename, body_params,
            header_type=header_type,
        )
    except WhatsAppServiceError as exc:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=str(exc), sent_by_id=sent_by_id)

    message_id = ""
    messages = result.get("messages") or []
    if messages:
        message_id = messages[0].get("id", "")

    return _log(employee, document_type, document_ref_id, phone, "sent",
                meta_message_id=message_id, sent_by_id=sent_by_id)
