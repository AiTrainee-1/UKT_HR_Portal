"""
WhatsApp notification service -the one place every HRMS module sends through
======================================================================
    HRMS module -> send_notification() / send_document() -> template (whatsapp_catalog)
                -> queued WhatsAppMessageLog row -> whatsapp_dispatcher (paced) -> WAClient -> employee

  * whatsapp_catalog     what each message is, its default wording, variables and queue kind
  * this module          switches (master, module, type, opt-out), wording, the log rows,
                         and the WAClient calls themselves
  * whatsapp_dispatcher  the one paced sender: at least `min_gap_seconds` between messages,
                         hourly / daily / per-employee caps, quiet hours, today-only expiry,
                         one retry for a temporary failure, a circuit breaker
  * whatsapp_approvals / whatsapp_notifications / whatsapp_alerts
                         what to say for each HRMS event

Since 2026-11-06 nothing but a one-time code is sent from the request (or job) that raised it:
everything else is written as a `queued` row and leaves when the dispatcher's pacing allows,
so a burst of approvals, a shift's worth of alerts or a month of salary slips can never go out
as the burst that gets the linked number restricted. A code is sent at once (the employee is
waiting for it), blocked only by the master switch.

Every attempt -queued, sent, failed, expired, skipped, switched off by HR- ends up as a
WhatsAppMessageLog row that HR sees on the WhatsApp Control page, and a failed
message never raises into the workflow that triggered it.

Sending goes through WAClient's WhatsApp Web API (linked WhatsApp number), so there
are no Meta templates to approve: wording is plain text with {{name}} placeholders
that HR can edit (WhatsAppMessageTemplate.message_body); a type with no saved wording
uses the catalog default. The API has no native buttons, so "components" are what it
does offer: formatted text and emojis, documents and images with a caption, and
contact cards (the visitor's tap-to-call card). No message carries a link to the
Employee Web App, so every text goes out as a plain WAClient "text" message.

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
from datetime import datetime, timedelta
from urllib.parse import urlparse

import requests
from django.conf import settings as dj_settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from . import push_messages
from . import whatsapp_catalog as catalog

logger = logging.getLogger(__name__)

_MEDIA_ASSET_TTL = timedelta(hours=24)

# Derived from whatsapp_catalog (the single source); kept under these names for older callers.
DEFAULT_MESSAGES = {t.key: t.body for t in catalog.TYPES.values()}
PLACEHOLDER_HELP = {key: catalog.variable_help(key) for key in catalog.TYPES}
# Message type -> the WhatsAppSettings column that switches just that type on/off.
FEATURE_SWITCHES = {t.key: t.switch for t in catalog.TYPES.values() if t.switch}

# A row in one of these states was accepted for sending: it is queued, on its way, or the provider took it. An endpoint
# that sends one document reports success for these (the message may still be waiting for its turn in the queue).
ACCEPTED_STATUSES = ("queued", "sending", "sent", "delivered", "read")

REASON_OPTED_OUT = "This employee has opted out of WhatsApp messages: not sent."
REASON_QUIET = "Quiet hours: not sent"

# Documents built only when their turn comes (a bulk send must answer at once, not build a few hundred PDFs inside one
# web request): a name stored in the queued row's payload -> the function that returns the file's bytes.
DOCUMENT_BUILDERS = {"salary_slip": "api.salary_slip_views.whatsapp_slip_pdf"}


class WhatsAppServiceError(Exception):
    """A send that did not work. `temporary` is True for a failure worth ONE retry a minute later (the provider could
    not be reached, timed out, answered 5xx or 429); everything else (a refused number, a disconnected instance, a bad
    token) is final."""

    def __init__(self, message: str = "", temporary: bool = False):
        super().__init__(message)
        self.temporary = temporary


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
    for retired in catalog.RETIRED_VARIABLES:
        values.pop(retired, None)
    lines = []
    for line in body.split("\n"):
        names = _PLACEHOLDER.findall(line)
        if not names:
            lines.append(line)
            continue
        # Wording saved long ago can still name a placeholder that was retired (the Employee Web App link): the
        # whole line goes, so an employee never gets a label with nothing after it, a raw {{...}} or an address.
        if any(n in catalog.RETIRED_VARIABLES for n in names):
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
    return media_url_for_base(_backend_public_base_url(request), token)


def media_url_for_base(base: str, token: str) -> str:
    """The public link of a stored media asset, from a base address saved when the message was queued (the dispatcher
    sends later, with no request at hand)."""
    return f"{(dj_settings.BACKEND_PUBLIC_URL or base or '').rstrip('/')}/api/whatsapp/media/{token}"


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
        # (connect, read): 5 s to reach WAClient, 20 s for its answer. It was 30 s for each, as long as the whole request
        # may take on the server, so a slow WAClient made the click (an OTP login, sending a document) kill the worker.
        resp = requests.post(url or dj_settings.WACLIENT_API_URL, json=body, timeout=(5, 20))
    except requests.RequestException as exc:
        raise WhatsAppServiceError(f"Could not reach WAClient: {exc}", temporary=True)

    try:
        data = resp.json() if resp.content else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}

    if resp.status_code >= 400 or str(data.get("status", "")).lower() != "success":
        detail = data.get("message") or data.get("error") or resp.text[:200] or f"HTTP {resp.status_code}"
        # The provider's own trouble (5xx) or "slow down" (429) may pass; a refusal of THIS message will not.
        temporary = resp.status_code >= 500 or resp.status_code == 429
        raise WhatsAppServiceError(f"Send failed: {detail}", temporary=temporary)
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
    """A plain text message (WAClient's "text" type)."""
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


def engine_enabled(s=None) -> bool:
    """The master switch (WhatsApp Control): False stops EVERY WhatsApp message, one-time codes included."""
    from .models import WhatsAppSettings

    return bool((s or WhatsAppSettings.get()).engine_enabled)


def switch_off_reason(document_type: str, related_module: str = "", s=None) -> str | None:
    """Why HR's switches say this message must not go out, or None when it may. A message is sent only when the master
    switch, its module's switch, and its own switch are all on: its own boolean where it has one, and it is not in the
    list of types switched off one by one (WhatsAppSettings.disabled_message_types). The shared approval wording also
    needs that approval workflow's switch."""
    t = catalog.get(document_type)
    if t is None:
        return None
    from .models import WhatsAppSettings

    s = s or WhatsAppSettings.get()
    if not s.engine_enabled:
        return "WhatsApp sending is switched off (master switch) on the WhatsApp Control page."
    if t.switch and not getattr(s, t.switch):
        return f"'{t.label}' is switched off on the WhatsApp Control page."
    if document_type in (s.disabled_message_types or []):
        return f"'{t.label}' is switched off on the WhatsApp Control page."
    master = catalog.MODULE_SWITCHES.get(t.module)
    if master and not getattr(s, master):
        return f"{catalog.MODULES[t.module]} notifications are switched off on the WhatsApp Control page."
    if t.module == "approvals" and related_module and related_module in (s.disabled_approval_modules or []):
        name = catalog.APPROVAL_MODULES.get(related_module, related_module)
        return f"{name} approval messages are switched off on the WhatsApp Control page."
    return None


def feature_enabled(document_type: str, related_module: str = "") -> bool:
    """False when HR has switched this message type (or its whole module, or WhatsApp itself) off on the
    WhatsApp Control page."""
    return switch_off_reason(document_type, related_module) is None


def opted_out(employee) -> bool:
    """Has this employee opted out of WhatsApp notifications and documents (WhatsApp Control -> Employees)? A code they
    ask for themselves still goes."""
    from .models import WhatsAppOptOut

    emp_id = employee if isinstance(employee, int) else getattr(employee, "pk", None)  # an employee or its id
    return bool(emp_id) and WhatsAppOptOut.objects.filter(employee_id=emp_id).exists()


def accepted(log) -> bool:
    """Was this send accepted (queued, on its way, or taken by the provider)? See ACCEPTED_STATUSES."""
    return log is not None and log.status in ACCEPTED_STATUSES


def _inline_delivery() -> bool:
    """settings.WHATSAPP_ASYNC_SEND False (always under `manage.py test`): a queued row is delivered at once, inside the
    call that queued it, ignoring the pacing, caps and quiet hours, so a test sees the outcome straight away. Never set
    it on a real server: it would bypass everything that keeps the number from being restricted."""
    return not dj_settings.WHATSAPP_ASYNC_SEND


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
    payload: dict | None = None,
    priority: int | None = None,
):
    from .models import WhatsAppMessageLog

    spec = catalog.get(document_type)
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
        kind=spec.kind if spec else catalog.KIND_AUTOMATIC,
        priority=priority if priority is not None else (spec.priority if spec else 5),
        payload=payload or {},
    )


def _precheck(employee, document_type, document_ref_id, sent_by_id, params, payload=None, priority=None):
    """Shared guard clauses for the document / text send paths. Returns (phone, text, stopped_log): when stopped_log is
    set, the send must stop and return it (a failed row for a switch or a missing phone, a skipped row for an employee
    who opted out or quiet hours)."""
    phone = normalize_phone(getattr(employee, "phone", None))

    def stop(msg, status="failed", text=""):
        return _log(
            employee,
            document_type,
            document_ref_id,
            phone or "",
            status,
            error_message=msg,
            sent_by_id=sent_by_id,
            message_text=text,
            payload=payload,
            priority=priority,
        )

    blocked = sending_block_reason()
    if blocked:
        return phone, None, stop(blocked)
    if not phone:
        return phone, None, stop("No phone number on file for this employee.")
    off = switch_off_reason(document_type)
    if off:
        return phone, None, stop(off)
    text, disabled_reason = _message_for(document_type, params)
    if disabled_reason:
        return phone, None, stop(disabled_reason)
    if opted_out(employee):
        return phone, None, stop(REASON_OPTED_OUT, "skipped", text)
    if not _inline_delivery():
        from . import whatsapp_dispatcher

        if whatsapp_dispatcher.in_quiet_hours():
            return phone, None, stop(REASON_QUIET, "skipped", text)
    return phone, text, None


def _queue_row(employee, document_type, phone, text, *, document_ref_id, sent_by_id, payload, priority):
    """Write the queued row of a document / text send (no dedupe key), and deliver it at once in inline mode."""
    from . import whatsapp_dispatcher
    from .models import WhatsAppMessageLog, WhatsAppSettings

    now = timezone.now()
    spec = catalog.get(document_type)
    log = WhatsAppMessageLog.objects.create(
        employee=employee,
        document_type=document_type,
        document_ref_id=document_ref_id,
        phone_number=phone,
        status=WhatsAppMessageLog.STATUS_QUEUED,
        sent_by_id=sent_by_id,
        message_text=text,
        kind=spec.kind if spec else catalog.KIND_DOCUMENT,
        priority=priority if priority is not None else (spec.priority if spec else 3),
        send_after=now,
        expires_at=whatsapp_dispatcher.expiry_for(document_type, WhatsAppSettings.get(), now),
        payload=payload,
    )
    if _inline_delivery():
        return whatsapp_dispatcher.deliver_now(log)
    return log


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
    The one entry point every single-document send endpoint calls. Normalizes the phone, builds the caption from the
    saved (or default) wording, stores the document as a fetchable media asset and QUEUES it (the dispatcher sends it
    when the pacing allows, usually within a minute). Always returns a WhatsAppMessageLog row: queued when accepted,
    failed (not configured / no phone / switched off / wording off / unreachable link) or skipped (opted out, quiet
    hours) otherwise, so callers never need their own try/except to get a uniform result to report back to the user.
    Report success with `accepted(log)`.

    `request` is needed to build the public media URL WAClient fetches the document from -see
    _backend_public_base_url.
    """
    # the caption of the document is also a phone notification and an in-app record (push_messages.py)
    push_messages.announce(
        employee, document_type, render_message(_template_body(document_type), body_params, _order_for(document_type))
    )
    phone, caption, stopped = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if stopped is not None:
        return stopped

    try:
        _require_public_base_url(request)
        token = _store_media(pdf_bytes, filename, mime_type)
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
    payload = {"media_url": _media_url(request, token), "filename": filename, "mime_type": mime_type}
    return _queue_row(
        employee,
        document_type,
        phone,
        caption,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload=payload,
        priority=None,
    )


def queue_document(
    request,
    employee,
    document_type: str,
    body_params,
    *,
    build: str,
    build_args: dict,
    filename: str,
    mime_type: str = "application/pdf",
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
    batch_id: str = "",
):
    """One document of a BULK send: queued without its file, which the dispatcher builds when the row's turn comes
    (DOCUMENT_BUILDERS[build](**build_args)), so the request that queues a few hundred answers at once. Every row of
    one bulk send carries `batch_id` in its payload (whatsapp_bulk_progress reads the batch's progress from the rows)
    and goes behind everything time-critical (catalog.PRIORITY_BULK). Same return contract as send_document."""
    if build not in DOCUMENT_BUILDERS:
        raise ValueError(f"Unknown document builder: {build}")
    push_messages.announce(
        employee, document_type, render_message(_template_body(document_type), body_params, _order_for(document_type))
    )
    marker = {"batch": batch_id} if batch_id else {}
    phone, caption, stopped = _precheck(
        employee,
        document_type,
        document_ref_id,
        sent_by_id,
        body_params,
        payload=marker,
        priority=catalog.PRIORITY_BULK,
    )
    if stopped is not None:
        return stopped
    try:
        _require_public_base_url(request)
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
            payload=marker,
            priority=catalog.PRIORITY_BULK,
        )
    payload = {
        **marker,
        "build": build,
        "build_args": build_args,
        "base_url": _backend_public_base_url(request),
        "filename": filename,
        "mime_type": mime_type,
    }
    return _queue_row(
        employee,
        document_type,
        phone,
        caption,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload=payload,
        priority=catalog.PRIORITY_BULK,
    )


def build_document(name: str, args: dict) -> bytes:
    """The bytes of a document queued without its file (queue_document)."""
    return import_string(DOCUMENT_BUILDERS[name])(**(args or {}))


def send_text(
    employee,
    document_type: str,
    body_params: list[str],
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
):
    """Same contract as send_document above (always returns a WhatsAppMessageLog row, never raises) but a plain text
    message with no attachment, queued like every other non-code message."""
    phone, text, stopped = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if stopped is not None:
        return stopped
    return _queue_row(
        employee,
        document_type,
        phone,
        text,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload={},
        priority=None,
    )


def _send_code_now(log, phone: str, text: str):
    """A one-time code: sent from the request that asked for it (the employee is waiting), outcome recorded on its
    pending row. It counts as the last message sent for the queue's gap."""
    from .models import WhatsAppMessageLog

    log.attempts = 1
    try:
        result = send_text_message(phone, text)
    except WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)
    except Exception as exc:  # never leave a row pending because of a bug in a helper
        logger.exception("Unexpected error sending WhatsApp code %s", log.id)
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = f"Unexpected error: {exc}"
    else:
        log.status = WhatsAppMessageLog.STATUS_SENT
        log.provider_message_id = _provider_message_id(result)
        log.sent_at = timezone.now()
    log.save(update_fields=["status", "error_message", "provider_message_id", "sent_at", "attempts", "updated_at"])
    return log


def send_notification(
    employee,
    document_type: str,
    params,
    *,
    dedupe_key: str = "",
    document_ref_id: int | None = None,
    log_params=None,
    related_module: str = "",
    contact: dict | None = None,
    on_sent: str | None = None,
    expires_at: datetime | None = None,
    asynchronous: bool | None = None,
    announce: bool = True,
):
    """THE entry point for a message the *system* decided to send (an alert, an approval, a gate
    movement, a visitor arrival) or that an employee asked for (a one-time code). Returns the
    WhatsAppMessageLog row, or None when nothing was attempted.

    `params` are the template's variables, by name (a dict) or by position (a list).
    `related_module` names the workflow behind a shared message ("leave" for the Approved wording).
    `contact` follows the message with a contact card (dict of first_name, last_name, phone).
    `on_sent` names a hook (whatsapp_dispatcher.ON_SENT_HOOKS) run once the message is really sent.
    `expires_at` is a moment after which the message is no longer worth sending (the alert job knows it exactly); the
    row expires at the earliest of that, the type's freshness and the end of today.

    None -not a failed row- is returned when: HR has this type (or its module, or WhatsApp itself) switched off,
    WhatsApp isn't configured on this server, the type's wording is disabled, or `dedupe_key` was already used (the
    message already went out, or is queued). Those aren't failures worth listing; a *failed* row is reserved for a real
    attempt that couldn't complete (no phone on file, provider error).

    A one-time code is sent at once and the row comes back sent / failed. Everything else is QUEUED (the row comes back
    "queued") and leaves when whatsapp_dispatcher's pacing allows; during quiet hours it is recorded "skipped" instead,
    and for an employee who opted out it is recorded "skipped" too. With dedupe_key the reserved row is what makes the
    message exactly-once: the unique constraint rejects a second reservation, so two overlapping runs cannot both queue
    it. `log_params` lets a caller store a redacted version of the text (the one-time code must never sit in the
    history).

    `asynchronous` is accepted for older callers and ignored: whether a message waits in the queue is decided by its kind
    (whatsapp_catalog), never by the caller. Nothing in here raises into the calling workflow.

    `announce=False` skips the phone notification + in-app record this message would otherwise also make
    (push_messages.py): for a caller that makes its own, with its own on/off switch (the Department Head
    reminders, hod_reminders.py, whose push must still go when WhatsApp is off and never twice).
    """
    from .models import WhatsAppMessageLog, WhatsAppSettings

    try:
        # The same message is also a phone notification and an in-app record (push_messages.py). That is the employee's
        # own channel, so it does not wait for WhatsApp to be configured or switched on, and a one-time code never goes
        # through it.
        if announce:
            push_messages.announce(
                employee,
                document_type,
                render_message(_template_body(document_type), params, _order_for(document_type)),
                related_module=related_module,
                dedupe_key=dedupe_key,
            )
        settings_row = WhatsAppSettings.get()
        if switch_off_reason(document_type, related_module, settings_row) or not is_configured():
            return None
        text, disabled_reason = _message_for(document_type, params)
        if disabled_reason:
            return None

        spec = catalog.get(document_type)
        kind = spec.kind if spec else catalog.KIND_AUTOMATIC
        phone = normalize_phone(getattr(employee, "phone", None))
        order = _order_for(document_type)
        logged_text = (
            render_message(_template_body(document_type), log_params, order) if log_params is not None else text
        )
        now = timezone.now()
        fields = {
            "employee": employee,
            "document_type": document_type,
            "document_ref_id": document_ref_id,
            "phone_number": phone or "",
            "message_text": logged_text,
            "dedupe_key": dedupe_key,
            "related_module": related_module,
            "kind": kind,
            "priority": spec.priority if spec else 5,
        }

        if kind == catalog.KIND_CODE:
            try:
                with transaction.atomic():
                    log = WhatsAppMessageLog.objects.create(status=WhatsAppMessageLog.STATUS_PENDING, **fields)
            except IntegrityError:
                return None
            if not phone:
                log.status = WhatsAppMessageLog.STATUS_FAILED
                log.error_message = "No phone number on file for this employee."
                log.save(update_fields=["status", "error_message", "updated_at"])
                return log
            return _send_code_now(log, phone, text)

        from . import whatsapp_dispatcher

        payload = {}
        if logged_text != text:
            payload["text"] = text
        if contact:
            payload["contact"] = contact
        if on_sent:
            payload["on_sent"] = on_sent
        status, reason = WhatsAppMessageLog.STATUS_QUEUED, ""
        if not phone:
            status, reason = WhatsAppMessageLog.STATUS_FAILED, "No phone number on file for this employee."
        elif opted_out(employee):
            status, reason = WhatsAppMessageLog.STATUS_SKIPPED, REASON_OPTED_OUT
        elif not _inline_delivery() and whatsapp_dispatcher.in_quiet_hours(settings_row, now):
            status, reason = WhatsAppMessageLog.STATUS_SKIPPED, REASON_QUIET
        try:
            with transaction.atomic():
                log = WhatsAppMessageLog.objects.create(
                    status=status,
                    error_message=reason,
                    send_after=now,
                    expires_at=whatsapp_dispatcher.expiry_for(document_type, settings_row, now, until=expires_at),
                    payload=payload,
                    **fields,
                )
        except IntegrityError:
            return None
        if status == WhatsAppMessageLog.STATUS_QUEUED and _inline_delivery():
            return whatsapp_dispatcher.deliver_now(log)
        return log
    except Exception:
        logger.exception("WhatsApp notification %s could not be prepared", document_type)
        return None


def expire_stale_pending(minutes: int = 10) -> int:
    """A code still "pending" long after it was reserved, or a queued message still "sending" long after the dispatcher
    took it, never left (the server stopped between taking it and recording the outcome). Mark it failed so HR sees it
    instead of a forever-pending row; it is never retried (it may have reached the employee). Run from the alert job
    and the dispatcher."""
    from django.db.models import Q

    from .models import WhatsAppMessageLog

    cutoff = timezone.now() - timedelta(minutes=minutes)
    return WhatsAppMessageLog.objects.filter(
        Q(status=WhatsAppMessageLog.STATUS_PENDING, created_at__lt=cutoff)
        | Q(status=WhatsAppMessageLog.STATUS_SENDING, updated_at__lt=cutoff)
    ).update(
        status=WhatsAppMessageLog.STATUS_FAILED,
        error_message="This message was never sent - the server stopped before it could be delivered.",
        updated_at=timezone.now(),
    )
