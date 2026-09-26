"""
WhatsApp notification service -the one place every HRMS module sends through
======================================================================
    HRMS module -> send_notification() -> template (whatsapp_catalog) -> WAClient -> employee

  * whatsapp_catalog   what each message is, its default wording and variables
  * this module        switches, wording, the log, delivery (in the background for
                       system messages), and the WAClient calls themselves
  * whatsapp_approvals / whatsapp_notifications / whatsapp_alerts
                       what to say for each HRMS event

Every attempt -sent, failed, switched off by HR, or interrupted- ends up as a
WhatsAppMessageLog row that HR sees on the WhatsApp Control page, and a failed
message never raises into the workflow that triggered it.

Sending goes through WAClient's WhatsApp Web API (linked WhatsApp number), so there
are no Meta templates to approve: wording is plain text with {{name}} placeholders
that HR can edit (WhatsAppMessageTemplate.message_body); a type with no saved wording
uses the catalog default. The API has no native buttons, so "components" are what it
does offer: formatted text and emojis, a link (sent as a preview card), documents and
images with a caption, and contact cards (the visitor's tap-to-call card).

Credentials (WACLIENT_INSTANCE_ID / WACLIENT_ACCESS_TOKEN) are .env-only -see
config/settings.py -never stored in the database or editable from the UI.

Documents are sent by giving WAClient a *public URL* to fetch -see
WhatsAppMediaAsset / _store_media / _media_url.

send_document() / send_text() / send_notification() never raise for an "expected"
failure (not configured, no phone on file, switched off, or a WAClient API error).
"""

import ipaddress
import logging
import re
import secrets
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from functools import partial
from urllib.parse import urlparse

import requests
from django.conf import settings as dj_settings
from django.db import connections, transaction
from django.utils import timezone

from . import whatsapp_catalog as catalog

logger = logging.getLogger(__name__)

_MEDIA_ASSET_TTL = timedelta(hours=24)

# Derived from whatsapp_catalog (the single source); kept under these names for older callers.
DEFAULT_MESSAGES = {t.key: t.body for t in catalog.TYPES.values()}
PLACEHOLDER_HELP = {key: catalog.variable_help(key) for key in catalog.TYPES}
# Message type -> the WhatsAppSettings column that switches just that type on/off.
FEATURE_SWITCHES = {t.key: t.switch for t in catalog.TYPES.values() if t.switch}


class WhatsAppServiceError(Exception):
    pass


def has_credentials() -> bool:
    return bool(dj_settings.WACLIENT_INSTANCE_ID and dj_settings.WACLIENT_ACCESS_TOKEN)


def sending_allowed() -> bool:
    """May this machine send WhatsApp messages? On a real server yes; on a development machine no, unless
    WHATSAPP_ALLOW_SENDING=true says otherwise (see config/settings.py for why)."""
    forced = getattr(dj_settings, "WHATSAPP_ALLOW_SENDING", None)
    if forced is not None:
        return bool(forced)
    return not dj_settings.DEBUG and "runserver" not in sys.argv


def sending_block_reason() -> str | None:
    """Why nothing can be sent from here, or None when it can."""
    if not has_credentials():
        return (
            "WhatsApp is not configured on this server (missing WACLIENT_INSTANCE_ID / WACLIENT_ACCESS_TOKEN in .env)."
        )
    if not sending_allowed():
        return (
            "WhatsApp sending is switched off on this machine because it is a development setup (DEBUG on or "
            "runserver), so it can't message employees from the live number. Set WHATSAPP_ALLOW_SENDING=true to override."
        )
    return None


def is_configured() -> bool:
    """Credentials present AND this machine is allowed to send."""
    return sending_block_reason() is None


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
    # "00" is the international dialling prefix, a single leading "0" the domestic trunk prefix.
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]
    # Already international only when the country code is followed by a full
    # 10-digit national number. Checking just "starts with 91" is wrong: many
    # valid Indian mobiles (9123456789, 9111111111 ...) begin with 91.
    if digits.startswith(country_code) and len(digits) >= len(country_code) + 10:
        return digits
    return f"{country_code}{digits}"


_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")


def _values(params, order: list[str] | None) -> dict[str, str]:
    """name -> text, also reachable by position ({{1}} = the first variable) so wording HR
    saved with numbered placeholders keeps working."""
    order = order or []
    values: dict[str, str] = {}
    if isinstance(params, dict):
        values.update({str(k): "" if v is None else str(v) for k, v in params.items()})
        for i, name in enumerate(order, start=1):
            values.setdefault(str(i), values.get(name, ""))
    else:
        seq = ["" if v is None else str(v) for v in (params or [])]
        for i, v in enumerate(seq, start=1):
            values[str(i)] = v
        for i, name in enumerate(order):
            if i < len(seq):
                values.setdefault(name, seq[i])
    return values


def render_message(body: str, params, order: list[str] | None = None) -> str:
    """Fill {{name}} / {{1}} placeholders. `params` is a dict (by name) or a list (by position);
    `order` names the positions. A placeholder with no value renders empty rather than leaking
    "{{3}}" to a person, and a line whose placeholders are ALL empty is dropped, so an optional
    detail ("Note: {{comment}}") disappears instead of leaving an empty label."""
    values = _values(params, order)
    lines = []
    for line in body.split("\n"):
        names = _PLACEHOLDER.findall(line)
        if not names:
            lines.append(line)
            continue
        if all(not values.get(n, "").strip() for n in names):
            continue
        lines.append(_PLACEHOLDER.sub(lambda m: values.get(m.group(1), ""), line).rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _order_for(document_type: str) -> list[str]:
    t = catalog.get(document_type)
    return t.variable_names if t else []


def _template_body(document_type: str) -> str:
    """The wording that will be sent for this type: HR's saved text, else the default."""
    from .models import WhatsAppMessageTemplate

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type).first()
    return (template.message_body.strip() if template else "") or DEFAULT_MESSAGES.get(document_type, "")


def _message_for(document_type: str, params) -> tuple[str | None, str | None]:
    """(text, None) to send, or (None, reason) when HR has switched this
    message type's wording off."""
    from .models import WhatsAppMessageTemplate

    template = WhatsAppMessageTemplate.objects.filter(document_type=document_type).first()
    if template is not None and not template.is_enabled:
        return None, f"WhatsApp sending for '{document_type}' is turned off in Settings → WhatsApp."
    body = (template.message_body.strip() if template else "") or DEFAULT_MESSAGES.get(document_type, "")
    return render_message(body, params, _order_for(document_type)), None


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


def _post_send(payload: dict, url: str | None = None) -> dict:
    """POST one message to WAClient (JSON body, credentials included in the body). Returns
    the parsed response; raises WhatsAppServiceError with WAClient's own message on any failure."""
    blocked = sending_block_reason()
    if blocked:
        raise WhatsAppServiceError(blocked)
    body = {
        **payload,
        "instance_id": dj_settings.WACLIENT_INSTANCE_ID,
        "access_token": dj_settings.WACLIENT_ACCESS_TOKEN,
    }
    try:
        resp = requests.post(url or dj_settings.WACLIENT_API_URL, json=body, timeout=30)
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


def send_text_message(to_phone: str, text: str, link_url: str = "") -> dict:
    """Plain text, or -when there is a link- WAClient's "link" type, which shows a preview card.
    If WAClient refuses the link type the text goes out plain, so a link can only add polish."""
    if link_url and dj_settings.WHATSAPP_LINK_PREVIEW:
        try:
            return _post_send({"number": to_phone, "type": "link", "message": text, "url": link_url})
        except WhatsAppServiceError as exc:
            logger.warning("WAClient link message refused (%s); sending as plain text", exc)
    return _post_send({"number": to_phone, "type": "text", "message": text})


def send_contact_message(to_phone: str, first_name: str, last_name: str, contact_phone: str) -> dict:
    """A WhatsApp contact card the recipient can tap to call, message or save."""
    payload = {
        "number": to_phone,
        "first_name": first_name or "Visitor",
        "phone_number": "".join(ch for ch in contact_phone if ch.isdigit()),
    }
    if last_name:
        payload["last_name"] = last_name
    return _post_send(payload, dj_settings.WACLIENT_CONTACT_API_URL)


def pace() -> None:
    """Sleep between messages in a bulk run. Sending over a linked WhatsApp
    session in a tight loop is what gets numbers flagged, so bulk sends are
    spread out (WHATSAPP_SEND_DELAY_SECONDS, default 2, 0 disables)."""
    delay = dj_settings.WHATSAPP_SEND_DELAY_SECONDS
    if delay > 0:
        time.sleep(delay)


def switch_off_reason(document_type: str, related_module: str = "") -> str | None:
    """Why HR's switches say this message must not go out, or None when it may. A message is
    sent only when its own switch AND its module's switch (and, for the shared approval
    wording, that approval workflow's switch) are on."""
    t = catalog.get(document_type)
    if t is None:
        return None
    from .models import WhatsAppSettings

    s = WhatsAppSettings.get()
    if t.switch and not getattr(s, t.switch):
        return f"'{t.label}' is switched off on the WhatsApp Control page."
    master = catalog.MODULE_SWITCHES.get(t.module)
    if master and not getattr(s, master):
        return f"{catalog.MODULES[t.module]} notifications are switched off on the WhatsApp Control page."
    if t.module == "approvals" and related_module and related_module in (s.disabled_approval_modules or []):
        name = catalog.APPROVAL_MODULES.get(related_module, related_module)
        return f"{name} approval messages are switched off on the WhatsApp Control page."
    return None


def feature_enabled(document_type: str, related_module: str = "") -> bool:
    """False when HR has switched this message type (or its whole module) off on the
    WhatsApp Control page."""
    return switch_off_reason(document_type, related_module) is None


def _log(
    employee,
    document_type: str,
    document_ref_id,
    phone_number: str,
    status: str,
    provider_message_id: str = "",
    error_message: str = "",
    sent_by_id=None,
    message_text: str = "",
    dedupe_key: str = "",
    related_module: str = "",
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
        message_text=message_text,
        dedupe_key=dedupe_key,
        related_module=related_module,
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

    blocked = sending_block_reason()
    if blocked:
        return phone, None, fail(blocked)
    if not phone:
        return phone, None, fail("No phone number on file for this employee.")
    off = switch_off_reason(document_type)
    if off:
        return phone, None, fail(off)
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
            message_text=caption,
        )

    return _log(
        employee,
        document_type,
        document_ref_id,
        phone,
        "sent",
        provider_message_id=_provider_message_id(result),
        sent_by_id=sent_by_id,
        message_text=caption,
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
            message_text=text,
        )

    return _log(
        employee,
        document_type,
        document_ref_id,
        phone,
        "sent",
        provider_message_id=_provider_message_id(result),
        sent_by_id=sent_by_id,
        message_text=text,
    )


_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()
_last_send_at = 0.0


def _run_in_background(job) -> None:
    """Hand `job` to the single delivery worker once the current transaction commits. One
    worker means messages leave one at a time with a small gap, and a WhatsApp outage costs
    the person clicking Approve nothing."""

    def run():
        global _last_send_at
        try:
            gap = dj_settings.WHATSAPP_MIN_SEND_GAP_SECONDS
            wait = _last_send_at + gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            job()
        except Exception:
            logger.exception("WhatsApp background delivery failed unexpectedly")
        finally:
            _last_send_at = time.monotonic()
            connections.close_all()

    def submit():
        global _executor
        with _executor_lock:
            if _executor is None:
                _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whatsapp")
        _executor.submit(run)

    transaction.on_commit(submit)


def _deliver(log_id: int, phone: str, text: str, link_url: str, contact: dict | None, on_sent):
    """Send the message a pending log row was reserved for, and record the outcome."""
    from .models import WhatsAppMessageLog

    log = WhatsAppMessageLog.objects.select_related("employee").get(pk=log_id)
    try:
        result = send_text_message(phone, text, link_url=link_url)
    except WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)
    except Exception as exc:  # never leave a row pending because of a bug in a helper
        logger.exception("Unexpected error sending WhatsApp message %s", log_id)
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = f"Unexpected error: {exc}"
    else:
        log.status = WhatsAppMessageLog.STATUS_SENT
        log.provider_message_id = _provider_message_id(result)
    log.save(update_fields=["status", "error_message", "provider_message_id", "updated_at"])

    if log.status == WhatsAppMessageLog.STATUS_SENT:
        if contact:
            _deliver_contact_card(log.employee, phone, contact, log.document_ref_id)
        if on_sent is not None:
            try:
                on_sent(log)
            except Exception:
                logger.exception("WhatsApp on_sent hook failed for message %s", log_id)
    return log


def _deliver_contact_card(employee, phone: str, contact: dict, ref_id) -> None:
    """The follow-up contact card, logged as its own message so HR sees exactly what went out."""
    from .models import WhatsAppMessageLog

    name = f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip()
    log = WhatsAppMessageLog.objects.create(
        employee=employee,
        document_type=contact.get("document_type", "visitor_contact"),
        document_ref_id=ref_id,
        phone_number=phone,
        status=WhatsAppMessageLog.STATUS_PENDING,
        message_text=f"Contact card: {name} ({contact.get('phone', '')})",
        related_module=contact.get("related_module", ""),
    )
    try:
        result = send_contact_message(
            phone, contact.get("first_name", ""), contact.get("last_name", ""), contact.get("phone", "")
        )
    except WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)
    except Exception as exc:
        logger.exception("Unexpected error sending WhatsApp contact card")
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = f"Unexpected error: {exc}"
    else:
        log.status = WhatsAppMessageLog.STATUS_SENT
        log.provider_message_id = _provider_message_id(result)
    log.save(update_fields=["status", "error_message", "provider_message_id", "updated_at"])


def send_notification(
    employee,
    document_type: str,
    params,
    *,
    dedupe_key: str = "",
    document_ref_id: int | None = None,
    log_params=None,
    related_module: str = "",
    link_url: str = "",
    contact: dict | None = None,
    on_sent=None,
    asynchronous: bool | None = None,
):
    """THE entry point for a message the *system* decided to send (an alert, an approval, a gate
    movement, a visitor arrival) or that an employee asked for (a one-time code). Returns the
    WhatsAppMessageLog row, or None when nothing was attempted.

    `params` are the template's variables, by name (a dict) or by position (a list).
    `related_module` names the workflow behind a shared message ("leave" for the Approved wording).
    `link_url` adds a link (sent as a preview card); `contact` follows the message with a contact
    card (dict of first_name, last_name, phone); `on_sent(log)` runs after a successful send.

    None -not a failed row- is returned when: HR has this type (or its module) switched off,
    WhatsApp isn't configured on this server, the type's wording is disabled, or `dedupe_key` was
    already used (the message already went out, or another worker is sending it right now). Those
    aren't failures worth listing; a *failed* row is reserved for a real attempt that couldn't
    complete (no phone on file, provider error).

    The row is reserved as "pending" BEFORE the API call. With dedupe_key that reservation is what
    makes the message exactly-once: the unique constraint rejects a second reservation, so two
    overlapping runs cannot both send. `log_params` lets a caller store a redacted version of the
    text (the one-time code must never sit in the history).

    `asynchronous` (default: settings.WHATSAPP_ASYNC_SEND) delivers from the background worker and
    returns the pending row straight away; pass False when the caller needs the outcome now (codes,
    the attendance job). Nothing in here raises into the calling workflow.
    """
    from django.db import IntegrityError

    from .models import WhatsAppMessageLog

    try:
        if not feature_enabled(document_type, related_module) or not is_configured():
            return None
        text, disabled_reason = _message_for(document_type, params)
        if disabled_reason:
            return None

        phone = normalize_phone(getattr(employee, "phone", None))
        order = _order_for(document_type)
        logged_text = (
            render_message(_template_body(document_type), log_params, order) if log_params is not None else text
        )
        try:
            with transaction.atomic():
                log = WhatsAppMessageLog.objects.create(
                    employee=employee,
                    document_type=document_type,
                    document_ref_id=document_ref_id,
                    phone_number=phone or "",
                    status=WhatsAppMessageLog.STATUS_PENDING,
                    message_text=logged_text,
                    dedupe_key=dedupe_key,
                    related_module=related_module,
                )
        except IntegrityError:
            return None

        if not phone:
            log.status = WhatsAppMessageLog.STATUS_FAILED
            log.error_message = "No phone number on file for this employee."
            log.save(update_fields=["status", "error_message", "updated_at"])
            return log

        job = partial(_deliver, log.id, phone, text, link_url, contact, on_sent)
        if dj_settings.WHATSAPP_ASYNC_SEND if asynchronous is None else asynchronous:
            _run_in_background(job)
            return log
        return job()
    except Exception:
        logger.exception("WhatsApp notification %s could not be prepared", document_type)
        return None


def expire_stale_pending(minutes: int = 10) -> int:
    """A message still "pending" long after it was reserved never left (the server stopped
    between reserving it and sending). Mark it failed so HR sees it instead of a forever-pending
    row. Run from the 5-minute alert job."""
    from .models import WhatsAppMessageLog

    return WhatsAppMessageLog.objects.filter(
        status=WhatsAppMessageLog.STATUS_PENDING, created_at__lt=timezone.now() - timedelta(minutes=minutes)
    ).update(
        status=WhatsAppMessageLog.STATUS_FAILED,
        error_message="This message was never sent - the server stopped before it could be delivered.",
        updated_at=timezone.now(),
    )
