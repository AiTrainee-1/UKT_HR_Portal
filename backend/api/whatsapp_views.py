"""
WhatsApp Settings (Settings -> WhatsApp tab)
================================================
Two things, deliberately kept separate:
  1. Credential status -read-only, sourced from settings.WACLIENT_* (.env),
     never editable here. Mirrors how the Backup tab shows pgDumpAvailable
     as a read-only capability flag rather than an input.
  2. Message wording per document type -genuinely editable, stored in
     WhatsAppMessageTemplate. This is business configuration, not a secret.

Also serves the public, unauthenticated media endpoint (whatsapp_media)
WAClient's servers fetch document/image attachments from, and the webhook
WAClient calls with delivery/read receipts -see whatsapp_service.send_document
/ WhatsAppMediaAsset.
"""

import logging
import re

from django.conf import settings as dj_settings
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_catalog, whatsapp_service
from .view_common import error_response as _error
from .auth import require_hr
from .models import WhatsAppMediaAsset, WhatsAppMessageLog, WhatsAppMessageTemplate

logger = logging.getLogger(__name__)

# Settings -> WhatsApp edits the wording of the documents HR sends (and the visitor message);
# every other message type is managed on the WhatsApp Control page.
DOCUMENT_TYPES = list(whatsapp_catalog.types_in("documents")) + list(whatsapp_catalog.types_in("visitors"))
DOCUMENT_TYPES = [key for key in DOCUMENT_TYPES if whatsapp_catalog.get(key).has_wording]


@api_view(["GET"])
@require_hr
def whatsapp_status(request: Request) -> Response:
    instance = dj_settings.WACLIENT_INSTANCE_ID
    return Response(
        {
            "configured": whatsapp_service.is_configured(),
            # Enough to recognise which instance is wired up, not enough to use it.
            "instanceId": f"…{instance[-4:]}" if instance else None,
        }
    )


def _template_json(document_type: str, t: WhatsAppMessageTemplate | None) -> dict:
    return {
        "documentType": document_type,
        "messageBody": (t.message_body if t else "") or "",
        "defaultMessage": whatsapp_service.DEFAULT_MESSAGES.get(document_type, ""),
        "placeholders": whatsapp_service.PLACEHOLDER_HELP.get(document_type, ""),
        "isEnabled": t.is_enabled if t else True,
    }


@api_view(["GET"])
@require_hr
def whatsapp_templates(request: Request) -> Response:
    """One row per document type, always all DOCUMENT_TYPES represented
    (even if never customised) so the Settings UI can render a fixed set of
    rows without guessing what's missing."""
    existing = {t.document_type: t for t in WhatsAppMessageTemplate.objects.all()}
    return Response([_template_json(doc_type, existing.get(doc_type)) for doc_type in DOCUMENT_TYPES])


@api_view(["PUT"])
@require_hr
def whatsapp_template_update(request: Request, document_type: str) -> Response:
    if document_type not in DOCUMENT_TYPES:
        return _error(f"Unknown document type: {document_type}")

    from .whatsapp_control_views import _wording_error

    data = request.data
    if "messageBody" in data:
        problem = _wording_error(document_type, (data.get("messageBody") or "").strip())
        if problem:
            return _error(problem)
    t, _ = WhatsAppMessageTemplate.objects.get_or_create(document_type=document_type)
    if "messageBody" in data:
        t.message_body = (data.get("messageBody") or "").strip()
    if "isEnabled" in data:
        t.is_enabled = bool(data.get("isEnabled"))
    t.save()
    return Response(_template_json(document_type, t))


@api_view(["GET"])
def whatsapp_media(request: Request, token: str):
    """Public, unauthenticated -this is the URL WAClient's own servers fetch
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


# ── WAClient webhook (delivery / read receipts) ──────────────────────────────

# Later states never get overwritten by earlier ones: events can arrive out of
# order or more than once.
_STATUS_RANK = {"sent": 0, "delivered": 1, "read": 2}

# WhatsApp (Baileys) numeric message states, as sent by Web-API gateways.
_NUMERIC_STATUS = {0: "failed", 1: "sent", 2: "sent", 3: "delivered", 4: "read", 5: "read"}


def _normalize_status(value) -> str | None:
    """Map whatever WAClient reports to sent / delivered / read / failed.
    Accepts Baileys numbers (3 = delivered, 4 = read ...) and names such as
    DELIVERY_ACK, delivered, READ, played, SERVER_ACK, error."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return _NUMERIC_STATUS.get(value)
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if v.isdigit():
        return _NUMERIC_STATUS.get(int(v))
    if "deliver" in v:
        return "delivered"
    if "read" in v or "played" in v:
        return "read"
    if "error" in v or "fail" in v:
        return "failed"
    if "server_ack" in v or v in ("sent", "pending"):
        return "sent"
    return None


def _status_updates(node):
    """Yield (message_id, status) for every message-status update found
    anywhere in a webhook payload.

    WAClient's webhook body isn't publicly documented, so this doesn't rely
    on one shape. It walks the JSON and recognises the two forms gateways
    like this use: {"key": {"id": ...}, "update": {"status": ...}} /
    {"key": {"id": ...}, "status": ...}, and a flat {"id": ..., "status": ...}
    (also message_id / messageId). Anything else is simply not an update.
    """
    if isinstance(node, list):
        for item in node:
            yield from _status_updates(item)
        return
    if not isinstance(node, dict):
        return

    key = node.get("key")
    msg_id = None
    if isinstance(key, dict) and key.get("id"):
        msg_id = key["id"]
    else:
        msg_id = node.get("message_id") or node.get("messageId") or (node.get("id") if "status" in node else None)

    if msg_id:
        raw_status = None
        update = node.get("update")
        if isinstance(update, dict) and "status" in update:
            raw_status = update["status"]
        elif "status" in node:
            raw_status = node["status"]
        status = _normalize_status(raw_status)
        if status:
            yield str(msg_id), status

    for value in node.values():
        if isinstance(value, (dict, list)):
            yield from _status_updates(value)


def _apply_message_event(payload) -> None:
    """Fold delivery events into WhatsAppMessageLog.status."""
    for msg_id, new_status in _status_updates(payload):
        logger.warning("WhatsApp event: id=%s status=%s", msg_id, new_status)
        for log in WhatsAppMessageLog.objects.filter(provider_message_id=msg_id):
            if new_status == "failed":
                log.status = "failed"
                log.error_message = log.error_message or "Delivery failed"
            elif _STATUS_RANK.get(new_status, -1) > _STATUS_RANK.get(log.status, 0):
                log.status = new_status
            else:
                continue
            log.save(update_fields=["status", "error_message"])


# Lists inside a webhook body that hold one entry per message.
_MESSAGE_LISTS = ("message_echoes", "messages", "statuses")
_SAFE_WORD = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")


def _walk(node):
    """Every dict anywhere inside a JSON value."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def _webhook_summary(payload) -> tuple[str, bool]:
    """A one-line description of a webhook body that contains none of its data, and whether its
    shape was recognised.

    Webhook bodies carry employees' phone numbers and the full text of the messages sent to them,
    so the body itself must never reach the logs. Only things from a fixed vocabulary are printed:
    the event field name, how many messages of each kind it holds, their type (text, image...) and
    delivery statuses. An unrecognised body is described by the names of its top-level keys, never
    their values, which is enough to tell what WAClient started sending.
    """
    fields, counts, types = set(), {}, set()
    for node in _walk(payload):
        field = node.get("field")
        if isinstance(field, str) and _SAFE_WORD.match(field):
            fields.add(field)
        for kind in _MESSAGE_LISTS:
            items = node.get(kind)
            if not isinstance(items, list):
                continue
            counts[kind] = counts.get(kind, 0) + len(items)
            for item in items:
                kind_of_message = item.get("type") if isinstance(item, dict) else None
                if isinstance(kind_of_message, str) and _SAFE_WORD.match(kind_of_message):
                    types.add(kind_of_message)
    statuses = {status for _, status in _status_updates(payload)}

    parts = []
    if fields:
        parts.append("fields=" + ",".join(sorted(fields)))
    parts += [f"{kind}={count}" for kind, count in sorted(counts.items())]
    if types:
        parts.append("types=" + ",".join(sorted(types)))
    if statuses:
        parts.append("statuses=" + ",".join(sorted(statuses)))
    if parts:
        return " ".join(parts), True

    keys = (
        sorted(k for k in payload if isinstance(k, str) and _SAFE_WORD.match(k))[:10]
        if isinstance(payload, dict)
        else []
    )
    return f"body_type={type(payload).__name__} keys={','.join(keys) or '-'}", False


@api_view(["GET", "POST", "HEAD", "OPTIONS"])
@parser_classes([JSONParser, FormParser, MultiPartParser])
def whatsapp_webhook(request: Request) -> Response:
    """Public callback URL for WAClient (set as the webhook URL on the instance).

    Always answers 200 -even for an empty or unrecognised body, and even if
    processing an event fails- so the sender never sees an error and retries
    or disables the callback. If WHATSAPP_WEBHOOK_TOKEN is set, the URL must
    carry it as ?token=...; a wrong token is a 403.

    What is logged is a summary with no personal data (see _webhook_summary), never the body.
    A recognised event is logged at INFO, so it stays quiet in production; a body whose shape is
    not recognised is a WARNING, since it may mean WAClient changed its format.
    """
    expected = dj_settings.WHATSAPP_WEBHOOK_TOKEN
    if expected and request.query_params.get("token") != expected:
        return _error("Forbidden", 403)

    if request.method == "POST":
        try:
            # Reading the body can itself raise (non-JSON content type, bad JSON).
            body = request.data
            summary, recognised = _webhook_summary(body)
            if recognised:
                logger.info("WhatsApp webhook: %s", summary)
            else:
                logger.warning("WhatsApp webhook in an unrecognised shape: %s", summary)
            _apply_message_event(body)
        except Exception:
            logger.exception("WAClient webhook event could not be processed")
    return Response({"status": "ok"})
