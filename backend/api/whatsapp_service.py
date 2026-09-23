"""
Gupshup WhatsApp API -shared sending service module
=====================================================
Mirrors the shape of the existing email-sending helpers (see
salary_slip_views.py::_send_slip_email) but for Gupshup's WhatsApp Access
API. Every document type's send endpoint (Salary Slip, ID Card, Offer/
Experience/Resignation Letter, other Employee Documents) calls through
send_document() below, so behavior -phone normalization, template lookup,
error logging -never diverges between them, exactly like every email
endpoint shares one SMTP-configured guard clause today.

Credentials (GUPSHUP_API_KEY / GUPSHUP_APP_NAME / GUPSHUP_SOURCE_NUMBER) are
.env-only -see config/settings.py -never stored in the database or editable
from the UI, unlike SMTP. Settings -> WhatsApp only lets HR pick which
pre-approved Gupshup template ID to use per document type
(WhatsAppMessageTemplate), since WhatsApp requires every business-initiated
message to use a template it has already reviewed -the wording itself isn't
freely editable here, only which approved template gets used.

Unlike Meta's Cloud API (direct media upload -> media_id), Gupshup's Access
API sends document/image template messages by fetching a *public URL* --
see WhatsAppMediaAsset / _store_media / _media_url. There is nothing to
upload up front for a plain text template (send_text), same as before.

send_document() / send_text() never raise for an "expected" failure (not
configured, no phone on file, no template configured, or a Gupshup API
error) -they always return a WhatsAppMessageLog row either way, so callers
(single-send views and the bulk-send loop alike) have one uniform way to
report success/failure without needing try/except at every call site.
"""

import json
import logging
import secrets
from datetime import timedelta

import requests
from django.conf import settings as dj_settings
from django.utils import timezone

logger = logging.getLogger(__name__)

_GUPSHUP_BASE = "https://api.gupshup.io/wa/api/v1"
_MEDIA_ASSET_TTL = timedelta(hours=24)


class WhatsAppServiceError(Exception):
    pass


def is_configured() -> bool:
    return bool(
        dj_settings.GUPSHUP_API_KEY
        and dj_settings.GUPSHUP_APP_NAME
        and dj_settings.GUPSHUP_SOURCE_NUMBER
    )


def _auth_headers() -> dict:
    return {"apikey": dj_settings.GUPSHUP_API_KEY, "Content-Type": "application/x-www-form-urlencoded"}


def normalize_phone(raw: str | None) -> str | None:
    """
    Employee.phone is stored as a plain local number (no country code, no
    formatting guarantees at all -it's a free-text field). Gupshup's API
    needs the full international number with no leading '+' or punctuation,
    same as Meta's Cloud API did. Prefixes WHATSAPP_DEFAULT_COUNTRY_CODE
    (default "91") only when the number doesn't already start with it.
    Returns None if there's nothing usable to send to, so callers can report
    "no phone on file" cleanly instead of sending garbage to Gupshup's API.
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


def _backend_public_base_url(request) -> str:
    """Public origin Gupshup's servers can reach to fetch a media asset.
    settings.BACKEND_PUBLIC_URL is an optional override for deployments
    where the request's own Host header isn't the public one (mirrors
    growth_views._public_base_url's identical FRONTEND_URL fallback
    pattern); on-premise, where Nginx serves /api under its real public
    hostname directly, the request-derived origin is already correct."""
    if dj_settings.BACKEND_PUBLIC_URL:
        return dj_settings.BACKEND_PUBLIC_URL.rstrip("/")
    return request.build_absolute_uri("/").rstrip("/")


def _store_media(file_bytes: bytes, filename: str, mime_type: str) -> str:
    """Writes a short-lived, token-addressed row Gupshup can fetch over
    HTTP (see WhatsAppMediaAsset). Also lazily prunes any rows past their
    expiry -cheap at this send volume, avoids needing a separate scheduled
    cleanup job."""
    from .models import WhatsAppMediaAsset

    WhatsAppMediaAsset.objects.filter(expires_at__lt=timezone.now()).delete()

    token = secrets.token_urlsafe(32)
    WhatsAppMediaAsset.objects.create(
        token=token, content=file_bytes, filename=filename, mime_type=mime_type,
        expires_at=timezone.now() + _MEDIA_ASSET_TTL,
    )
    return token


def _media_url(request, token: str) -> str:
    return f"{_backend_public_base_url(request)}/api/whatsapp/media/{token}"


def _post_template_msg(destination: str, template_id: str, params: list[str], message: dict | None = None) -> dict:
    """POST /template/msg -form-encoded, matching Gupshup's Access API
    (apikey header auth, not bearer). `message` carries the header
    attachment for a document/image template; omitted entirely for a
    plain text template (send_text_template below)."""
    data = {
        "channel": "whatsapp",
        "source": dj_settings.GUPSHUP_SOURCE_NUMBER,
        "src.name": dj_settings.GUPSHUP_APP_NAME,
        "destination": destination,
        "template": json.dumps({"id": template_id, "params": params}),
    }
    if message is not None:
        data["message"] = json.dumps(message)

    try:
        resp = requests.post(f"{_GUPSHUP_BASE}/template/msg", headers=_auth_headers(), data=data, timeout=30)
    except requests.RequestException as exc:
        raise WhatsAppServiceError(f"Could not reach Gupshup API: {exc}")

    body = resp.json() if resp.content else {}
    if resp.status_code >= 400 or body.get("status") not in ("submitted", "success"):
        detail = body.get("message") or (body.get("error") if isinstance(body.get("error"), str) else None) or resp.text[:200]
        raise WhatsAppServiceError(f"Send failed: {detail}")
    return body


def send_document_template(
    to_phone: str, template_id: str, media_url: str, filename: str,
    body_params: list[str], header_type: str = "document",
) -> dict:
    """A template message with a header attachment fetched by Gupshup from
    media_url (Document for PDFs, Image for the ID card PNG) plus body
    {{n}} variables filled from body_params, in order. Raises
    WhatsAppServiceError with Gupshup's own error detail on failure."""
    if header_type == "image":
        message = {"type": "image", "image": {"link": media_url}}
    else:
        message = {"type": "document", "document": {"link": media_url, "filename": filename}}
    return _post_template_msg(to_phone, template_id, body_params, message=message)


def send_text_template(to_phone: str, template_id: str, body_params: list[str]) -> dict:
    """A template message with no header component, just body {{n}} params.
    For a plain informational alert (e.g. "you have a visitor") that has no
    document/image to attach, unlike send_document_template above which
    always sends a header attachment."""
    return _post_template_msg(to_phone, template_id, body_params)


def _log(employee, document_type: str, document_ref_id, phone_number: str,
         status: str, gupshup_message_id: str = "", error_message: str = "", sent_by_id=None):
    from .models import WhatsAppMessageLog

    return WhatsAppMessageLog.objects.create(
        employee=employee, document_type=document_type, document_ref_id=document_ref_id,
        phone_number=phone_number or "", status=status,
        gupshup_message_id=gupshup_message_id, error_message=error_message, sent_by_id=sent_by_id,
    )


def send_document(
    request, employee, document_type: str, pdf_bytes: bytes, filename: str,
    body_params: list[str], mime_type: str = "application/pdf",
    document_ref_id: int | None = None, sent_by_id: int | None = None,
):
    """
    The one entry point every document send endpoint (single or bulk) should
    call. Normalizes the phone, looks up the configured+enabled template for
    this document_type, stores the document as a fetchable media asset,
    sends the template message, and always writes a WhatsAppMessageLog row
    -on the "expected" failure paths (not configured / no phone / no
    template) just as much as on success or a Gupshup API error, so callers
    never need their own try/except to get a uniform result to report back
    to the user.

    `request` is needed to build the public media URL Gupshup fetches the
    document from -see _backend_public_base_url.
    """
    from .models import WhatsAppMessageTemplate

    phone = normalize_phone(getattr(employee, "phone", None))

    if not is_configured():
        return _log(employee, document_type, document_ref_id, phone or "", "failed",
                     error_message="WhatsApp is not configured on this server (missing Gupshup credentials in .env).",
                     sent_by_id=sent_by_id)

    if not phone:
        return _log(employee, document_type, document_ref_id, "", "failed",
                     error_message="No phone number on file for this employee.", sent_by_id=sent_by_id)

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type, is_enabled=True).first()
    if not template or not template.gupshup_template_id:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=f"No WhatsApp template configured for '{document_type}' -set one up in Settings → WhatsApp.",
                     sent_by_id=sent_by_id)

    header_type = "image" if mime_type.startswith("image/") else "document"
    try:
        token = _store_media(pdf_bytes, filename, mime_type)
        media_url = _media_url(request, token)
        result = send_document_template(
            phone, template.gupshup_template_id, media_url, filename, body_params,
            header_type=header_type,
        )
    except WhatsAppServiceError as exc:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=str(exc), sent_by_id=sent_by_id)

    return _log(employee, document_type, document_ref_id, phone, "sent",
                gupshup_message_id=result.get("messageId", ""), sent_by_id=sent_by_id)


def send_text(
    employee, document_type: str, body_params: list[str],
    document_ref_id: int | None = None, sent_by_id: int | None = None,
):
    """Same contract as send_document above (always returns a
    WhatsAppMessageLog row, never raises) but for a template with no
    header/media -see send_text_template. Used for the visitor-arrival
    notification (document_type="visitor_notification"), which has nothing
    to attach, so it needs no media URL and therefore no `request`."""
    from .models import WhatsAppMessageTemplate

    phone = normalize_phone(getattr(employee, "phone", None))

    if not is_configured():
        return _log(employee, document_type, document_ref_id, phone or "", "failed",
                     error_message="WhatsApp is not configured on this server (missing Gupshup credentials in .env).",
                     sent_by_id=sent_by_id)

    if not phone:
        return _log(employee, document_type, document_ref_id, "", "failed",
                     error_message="No phone number on file for this employee.", sent_by_id=sent_by_id)

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type, is_enabled=True).first()
    if not template or not template.gupshup_template_id:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=f"No WhatsApp template configured for '{document_type}' -set one up in Settings → WhatsApp.",
                     sent_by_id=sent_by_id)

    try:
        result = send_text_template(phone, template.gupshup_template_id, body_params)
    except WhatsAppServiceError as exc:
        return _log(employee, document_type, document_ref_id, phone, "failed",
                     error_message=str(exc), sent_by_id=sent_by_id)

    return _log(employee, document_type, document_ref_id, phone, "sent",
                gupshup_message_id=result.get("messageId", ""), sent_by_id=sent_by_id)
