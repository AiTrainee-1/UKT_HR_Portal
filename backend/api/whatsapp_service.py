"""
WAClient WhatsApp Web API -shared sending service module
==========================================================
Mirrors the shape of the existing email-sending helpers (see
salary_slip_views.py::_send_slip_email) but for WAClient's WhatsApp Web API.
Every document type's send endpoint (Salary Slip, ID Card, Offer/Experience/
Resignation Letter, other Employee Documents) calls through send_document()
below, so behavior -phone normalization, message wording, error logging -never
diverges between them, exactly like every email endpoint shares one
SMTP-configured guard clause today.

Credentials (WACLIENT_INSTANCE_ID / WACLIENT_ACCESS_TOKEN) are .env-only -see
config/settings.py -never stored in the database or editable from the UI.

The Web API sends over a linked WhatsApp session, so there are no Meta
templates and nothing to get approved: the wording of each message is plain
text HR can edit in Settings -> WhatsApp (WhatsAppMessageTemplate.message_body,
with {{1}}, {{2}} ... placeholders filled from the caller's body_params, in
order). A document type with no saved wording uses DEFAULT_MESSAGES below.

Documents are sent by giving WAClient a *public URL* to fetch -see
WhatsAppMediaAsset / _store_media / _media_url -so there is nothing to upload
up front.

send_document() / send_text() never raise for an "expected" failure (not
configured, no phone on file, disabled in Settings, or a WAClient API error)
-they always return a WhatsAppMessageLog row either way, so callers
(single-send views and the bulk-send loop alike) have one uniform way to
report success/failure without needing try/except at every call site.
"""

import ipaddress
import logging
import re
import secrets
import time
from datetime import timedelta
from urllib.parse import urlparse

import requests
from django.conf import settings as dj_settings
from django.utils import timezone

logger = logging.getLogger(__name__)

_MEDIA_ASSET_TTL = timedelta(hours=24)

# Used whenever HR hasn't saved their own wording for a document type. The
# numbered placeholders match the body_params each caller passes.
DEFAULT_MESSAGES = {
    "salary_slip": "Hello {{1}},\n\nYour salary slip for {{2}} is attached.\n\nRegards,\nUK Textiles HR",
    "id_card": "Hello {{1}},\n\nYour employee ID card is attached.\n\nRegards,\nUK Textiles HR",
    "offer_letter": "Hello {{1}},\n\nPlease find your offer letter for the position of {{2}} attached.\n\nRegards,\nUK Textiles HR",
    "experience_letter": "Hello {{1}},\n\nYour experience letter is attached.\n\nRegards,\nUK Textiles HR",
    "resignation_letter": "Hello {{1}},\n\nYour resignation letter (last working day: {{2}}) is attached.\n\nRegards,\nUK Textiles HR",
    "other": "Hello {{1}},\n\nPlease find your {{2}} document attached.\n\nRegards,\nUK Textiles HR",
    "visitor_notification": "Hello {{1}},\n\nYou have a visitor at the reception: {{2}} ({{3}}).\nPurpose: {{4}}",
}

# Which {{n}} each document type's callers fill, for the Settings screen.
PLACEHOLDER_HELP = {
    "salary_slip": "{{1}} employee name, {{2}} month and year",
    "id_card": "{{1}} employee name",
    "offer_letter": "{{1}} employee name, {{2}} designation",
    "experience_letter": "{{1}} employee name",
    "resignation_letter": "{{1}} employee name, {{2}} last working day",
    "other": "{{1}} employee name, {{2}} document category",
    "visitor_notification": "{{1}} employee name, {{2}} visitor name, {{3}} visitor phone, {{4}} purpose",
}


class WhatsAppServiceError(Exception):
    pass


def is_configured() -> bool:
    return bool(dj_settings.WACLIENT_INSTANCE_ID and dj_settings.WACLIENT_ACCESS_TOKEN)


def normalize_phone(raw: str | None) -> str | None:
    """
    Employee.phone is stored as a plain local number (no country code, no
    formatting guarantees at all -it's a free-text field). WAClient needs the
    full international number as digits only (no '+', spaces or punctuation).
    Prefixes WHATSAPP_DEFAULT_COUNTRY_CODE (default "91") only when the number
    doesn't already start with it. Returns None if there's nothing usable to
    send to, so callers can report "no phone on file" cleanly instead of
    sending garbage to the API.
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


def render_message(body: str, params: list[str]) -> str:
    """Fill {{1}}, {{2}} ... from `params` (1-based). A placeholder with no
    matching parameter renders empty rather than leaking "{{3}}" to a person."""

    def fill(match: re.Match) -> str:
        idx = int(match.group(1)) - 1
        return str(params[idx]) if 0 <= idx < len(params) else ""

    return re.sub(r"\{\{\s*(\d+)\s*\}\}", fill, body)


def _message_for(document_type: str, params: list[str]) -> tuple[str | None, str | None]:
    """(text, None) to send, or (None, reason) when HR has switched this
    document type off in Settings -> WhatsApp."""
    from .models import WhatsAppMessageTemplate

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type).first()
    if template is not None and not template.is_enabled:
        return None, f"WhatsApp sending for '{document_type}' is turned off in Settings → WhatsApp."
    body = (template.message_body.strip() if template else "") or DEFAULT_MESSAGES.get(document_type, "")
    return render_message(body, params), None


def _backend_public_base_url(request) -> str:
    """Public origin WAClient's servers can reach to fetch a media asset.
    settings.BACKEND_PUBLIC_URL is an optional override for deployments
    where the request's own Host header isn't the public one (mirrors
    growth_views._public_base_url's identical FRONTEND_URL fallback
    pattern); on-premise, where Nginx serves /api under its real public
    hostname directly, the request-derived origin is already correct."""
    if dj_settings.BACKEND_PUBLIC_URL:
        return dj_settings.BACKEND_PUBLIC_URL.rstrip("/")
    return request.build_absolute_uri("/").rstrip("/")


def _store_media(file_bytes: bytes, filename: str, mime_type: str) -> str:
    """Writes a short-lived, token-addressed row WAClient can fetch over
    HTTP (see WhatsAppMediaAsset). Also lazily prunes any rows past their
    expiry -cheap at this send volume, avoids needing a separate scheduled
    cleanup job."""
    from .models import WhatsAppMediaAsset

    WhatsAppMediaAsset.objects.filter(expires_at__lt=timezone.now()).delete()

    token = secrets.token_urlsafe(32)
    WhatsAppMediaAsset.objects.create(
        token=token,
        content=file_bytes,
        filename=filename,
        mime_type=mime_type,
        expires_at=timezone.now() + _MEDIA_ASSET_TTL,
    )
    return token


def _media_url(request, token: str) -> str:
    return f"{_backend_public_base_url(request)}/api/whatsapp/media/{token}"


def _require_public_base_url(request) -> None:
    """WAClient downloads each document itself, from its own servers, so the
    link must be reachable from the internet. On a developer machine the link
    is http://localhost:8000/... -which points at WAClient's own localhost, not
    yours- and the send comes back as an opaque "Media URL returned HTTP 403".
    Refuse up front with a message that says what to do instead."""
    base = _backend_public_base_url(request)
    host = (urlparse(base).hostname or "").lower()
    private = host in ("", "localhost") or host.endswith((".local", ".internal", ".lan"))
    if not private:
        try:
            ip = ipaddress.ip_address(host)
            private = ip.is_private or ip.is_loopback or ip.is_link_local
        except ValueError:
            pass
    if private:
        raise WhatsAppServiceError(
            f"WAClient can't download documents from '{base}' because it isn't reachable from the internet. "
            "Set BACKEND_PUBLIC_URL to a public address for this server (for example a tunnel URL when testing "
            "locally, or https://api.uktextiles.in in production), or test from the deployed site."
        )


def _post_send(payload: dict) -> dict:
    """POST one message to WAClient's /send endpoint (JSON body, credentials
    included in the body). Returns the parsed response; raises
    WhatsAppServiceError with WAClient's own message on any failure."""
    body = {
        **payload,
        "instance_id": dj_settings.WACLIENT_INSTANCE_ID,
        "access_token": dj_settings.WACLIENT_ACCESS_TOKEN,
    }
    try:
        resp = requests.post(dj_settings.WACLIENT_API_URL, json=body, timeout=30)
    except requests.RequestException as exc:
        raise WhatsAppServiceError(f"Could not reach WAClient: {exc}")

    try:
        data = resp.json() if resp.content else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}

    if resp.status_code >= 400 or str(data.get("status", "")).lower() != "success":
        detail = data.get("message") or data.get("error") or resp.text[:200] or f"HTTP {resp.status_code}"
        raise WhatsAppServiceError(f"Send failed: {detail}")
    return data


def _provider_message_id(result: dict) -> str:
    """WhatsApp's own id for the message, echoed in message_payload.key.id.
    Delivery/read webhooks refer to the message by this same id."""
    key = (result.get("message_payload") or {}).get("key") or {}
    return str(key.get("id") or "")


def send_document_message(to_phone: str, media_url: str, filename: str, caption: str, mime_type: str) -> dict:
    """A document (PDF) or image (PNG ID card) fetched by WAClient from
    media_url, with `caption` as the message text."""
    if mime_type.startswith("image/"):
        payload = {"number": to_phone, "type": "image", "media_url": media_url, "message": caption}
    else:
        payload = {
            "number": to_phone,
            "type": "document",
            "media_url": media_url,
            "filename": filename,
            "message": caption,
        }
    return _post_send(payload)


def send_text_message(to_phone: str, text: str) -> dict:
    return _post_send({"number": to_phone, "type": "text", "message": text})


def pace() -> None:
    """Sleep between messages in a bulk run. Sending over a linked WhatsApp
    session in a tight loop is what gets numbers flagged, so bulk sends are
    spread out (WHATSAPP_SEND_DELAY_SECONDS, default 2, 0 disables)."""
    delay = dj_settings.WHATSAPP_SEND_DELAY_SECONDS
    if delay > 0:
        time.sleep(delay)


def _log(
    employee,
    document_type: str,
    document_ref_id,
    phone_number: str,
    status: str,
    provider_message_id: str = "",
    error_message: str = "",
    sent_by_id=None,
):
    from .models import WhatsAppMessageLog

    return WhatsAppMessageLog.objects.create(
        employee=employee,
        document_type=document_type,
        document_ref_id=document_ref_id,
        phone_number=phone_number or "",
        status=status,
        provider_message_id=provider_message_id,
        error_message=error_message,
        sent_by_id=sent_by_id,
    )


def _precheck(employee, document_type, document_ref_id, sent_by_id, params):
    """Shared guard clauses for both send paths. Returns (phone, text, failed_log):
    when failed_log is set, the send must stop and return it."""
    phone = normalize_phone(getattr(employee, "phone", None))

    def fail(msg):
        return _log(
            employee,
            document_type,
            document_ref_id,
            phone or "",
            "failed",
            error_message=msg,
            sent_by_id=sent_by_id,
        )

    if not is_configured():
        return (
            phone,
            None,
            fail(
                "WhatsApp is not configured on this server (missing WACLIENT_INSTANCE_ID / WACLIENT_ACCESS_TOKEN in .env)."
            ),
        )
    if not phone:
        return phone, None, fail("No phone number on file for this employee.")
    text, disabled_reason = _message_for(document_type, params)
    if disabled_reason:
        return phone, None, fail(disabled_reason)
    return phone, text, None


def send_document(
    request,
    employee,
    document_type: str,
    pdf_bytes: bytes,
    filename: str,
    body_params: list[str],
    mime_type: str = "application/pdf",
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
):
    """
    The one entry point every document send endpoint (single or bulk) should
    call. Normalizes the phone, builds the caption from the saved (or
    default) wording, stores the document as a fetchable media asset, sends
    it, and always writes a WhatsAppMessageLog row -on the "expected" failure
    paths (not configured / no phone / switched off) just as much as on
    success or an API error, so callers never need their own try/except to
    get a uniform result to report back to the user.

    `request` is needed to build the public media URL WAClient fetches the
    document from -see _backend_public_base_url.
    """
    phone, caption, failed = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if failed is not None:
        return failed

    try:
        _require_public_base_url(request)
        token = _store_media(pdf_bytes, filename, mime_type)
        result = send_document_message(phone, _media_url(request, token), filename, caption, mime_type)
    except WhatsAppServiceError as exc:
        return _log(
            employee,
            document_type,
            document_ref_id,
            phone,
            "failed",
            error_message=str(exc),
            sent_by_id=sent_by_id,
        )

    return _log(
        employee,
        document_type,
        document_ref_id,
        phone,
        "sent",
        provider_message_id=_provider_message_id(result),
        sent_by_id=sent_by_id,
    )


def send_text(
    employee,
    document_type: str,
    body_params: list[str],
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
):
    """Same contract as send_document above (always returns a
    WhatsAppMessageLog row, never raises) but a plain text message with no
    attachment. Used for the visitor-arrival notification
    (document_type="visitor_notification"), which has nothing to attach, so
    it needs no media URL and therefore no `request`."""
    phone, text, failed = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if failed is not None:
        return failed

    try:
        result = send_text_message(phone, text)
    except WhatsAppServiceError as exc:
        return _log(
            employee,
            document_type,
            document_ref_id,
            phone,
            "failed",
            error_message=str(exc),
            sent_by_id=sent_by_id,
        )

    return _log(
        employee,
        document_type,
        document_ref_id,
        phone,
        "sent",
        provider_message_id=_provider_message_id(result),
        sent_by_id=sent_by_id,
    )
