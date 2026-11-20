"""
WhatsApp: Meta's webhook
========================

The webhook (2026-11-20, Meta WhatsApp Cloud API) is how Meta tells this server what happened:

    GET  /api/whatsapp/webhook/   Meta's one-time verification: hub.mode=subscribe and hub.verify_token equal to
                                  WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN -> 200 with hub.challenge as plain text; else 403.
    POST /api/whatsapp/webhook/   events, signed: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(WHATSAPP_CLOUD_APP_SECRET,
                                  the RAW body), compared in constant time. Missing or wrong -> 403 and nothing is read.
                                  A signed body always gets 200 (Meta retries anything else for days), even when an
                                  event in it cannot be processed.

What a signed POST does (entry[].changes[] by `field`):
  * messages / statuses[]       the message (WhatsAppMessageLog by provider_message_id = the wamid) moves sent ->
                                delivered -> read (never backwards; delivered_at / read_at from Meta's timestamp), or to
                                failed with Meta's error in plain words; pricing {billable, category} is recorded for
                                the usage and cost figures.
  * messages / messages[]       an employee's reply. A text "STOP" from an employee's registered number opts them out
                                (WhatsAppOptOut, reason "Replied STOP"). Nothing else is stored: the text is never logged.
  * message_template_status_update   the template's row (WhatsAppTemplate) takes Meta's new status (APPROVED,
                                REJECTED with the reason, PAUSED, DISABLED ...); a template this server did not know is
                                added (a later Sync fills in its text).
  * message_template_quality_update  the template's quality score.
  * phone_number_quality_update, account_update, others   only noted in the log (a summary without personal data).
Every signed POST stamps WhatsAppSettings.last_webhook_at (WhatsApp Control shows whether the webhook is set up).

The body holds employees' phone numbers and message texts, so it never reaches the logs: only a summary of what arrived
(_webhook_summary). The WhatsApp Control page's Settings tab shows the webhook address to paste into Meta.

The old per-type wording endpoints (whatsapp/templates..., the Settings -> WhatsApp editor) were retired on 2026-11-20:
with Meta the wording IS the approved template (WhatsApp Control -> Templates, whatsapp_templates.py).
"""

import json
import logging
import re
from datetime import datetime, timezone as dt_timezone

from django.http import HttpResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from . import whatsapp_cloud, whatsapp_service
from .models import (
    Employee,
    WhatsAppMessageLog,
    WhatsAppOptOut,
    WhatsAppSettings,
    WhatsAppTemplate,
)

logger = logging.getLogger(__name__)

# ── Meta's webhook ───────────────────────────────────────────────────────────────────

# Later states never get overwritten by earlier ones: events can arrive out of order or more than once.
_STATUS_RANK = {"sent": 0, "delivered": 1, "read": 2}
_FINAL_FAILED = "failed"
_SAFE_WORD = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
_STOP_WORDS = frozenset({"stop"})
REASON_STOP = "Replied STOP"


def _when(timestamp) -> datetime:
    try:
        return datetime.fromtimestamp(int(timestamp), tz=dt_timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return timezone.now()


def _failure_text(errors) -> str:
    error = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
    code = error.get("code")
    details = (error.get("error_data") or {}).get("details") if isinstance(error.get("error_data"), dict) else None
    exc = whatsapp_cloud.MetaApiError(code, details or error.get("message") or error.get("title") or "Delivery failed")
    prefix = whatsapp_service.REFUSED_PREFIX if exc.message_level else whatsapp_service.SEND_FAILED_PREFIX
    return f"{prefix}{exc}"[:1000]


def _apply_status(status: dict) -> None:
    """One statuses[] entry onto its message(s)."""
    wamid = str(status.get("id") or "")
    new = str(status.get("status") or "").lower()
    if not wamid or new not in ("sent", "delivered", "read", "failed"):
        return
    pricing = status.get("pricing") if isinstance(status.get("pricing"), dict) else {}
    at = _when(status.get("timestamp"))
    for log in WhatsAppMessageLog.objects.filter(provider_message_id=wamid):
        changed: list[str] = []
        if pricing:
            category = str(pricing.get("category") or "").lower()
            if category and log.pricing_category != category:
                log.pricing_category = category
                changed.append("pricing_category")
            if isinstance(pricing.get("billable"), bool) and log.billable is not pricing["billable"]:
                log.billable = pricing["billable"]
                changed.append("billable")
        if new == _FINAL_FAILED:
            if log.status != _FINAL_FAILED:
                log.status = _FINAL_FAILED
                log.error_message = _failure_text(status.get("errors"))
                changed += ["status", "error_message"]
        elif log.status in _STATUS_RANK or log.status in ("sending", "pending"):
            if _STATUS_RANK[new] > _STATUS_RANK.get(log.status, -1):
                log.status = new
                changed.append("status")
            if new in ("delivered", "read") and log.delivered_at is None:
                log.delivered_at = at
                changed.append("delivered_at")
            if new == "read" and log.read_at is None:
                log.read_at = at
                changed.append("read_at")
        if changed:
            log.save(update_fields=[*dict.fromkeys(changed), "updated_at"])


def _employee_by_number(number: str):
    """The active employee whose registered phone is this WhatsApp number (digits with the country code), or None."""
    digits = "".join(ch for ch in str(number or "") if ch.isdigit())
    if len(digits) < 10:
        return None
    tail = digits[-10:]
    for emp_id, phone in Employee.objects.filter(phone__isnull=False).exclude(phone="").values_list("id", "phone"):
        cleaned = "".join(ch for ch in str(phone or "") if ch.isdigit())
        if cleaned.endswith(tail) and whatsapp_service.normalize_phone(phone) == digits:
            return emp_id
    return None


def _employee_wrote(message: dict) -> None:
    """An inbound message. Only a STOP is acted on (an opt-out); its text is never stored or logged."""
    if str(message.get("type") or "") != "text":
        return
    body = str(((message.get("text") or {}) if isinstance(message.get("text"), dict) else {}).get("body") or "")
    if body.strip().lower() not in _STOP_WORDS:
        return
    emp_id = _employee_by_number(message.get("from"))
    if emp_id is None:
        return
    _, created = WhatsAppOptOut.objects.get_or_create(
        employee_id=emp_id, defaults={"reason": REASON_STOP, "created_by": "WhatsApp (employee replied STOP)"}
    )
    if created:
        logger.info("WhatsApp: employee %s opted out by replying STOP", emp_id)


def _template_status(value: dict) -> None:
    name = str(value.get("message_template_name") or "").strip()
    if not name:
        return
    language = str(value.get("message_template_language") or "").strip() or whatsapp_cloud.template_language()
    meta_id = str(value.get("message_template_id") or "").strip()
    event = str(value.get("event") or "").strip().upper()
    if not event:
        return
    reason = str(value.get("reason") or "").strip()
    row = (WhatsAppTemplate.objects.filter(meta_id=meta_id).first() if meta_id else None) or (
        WhatsAppTemplate.objects.filter(name=name, language=language).first()
    )
    if row is None:
        row = WhatsAppTemplate(name=name, language=language, meta_id=meta_id)
    row.status = event
    if meta_id:
        row.meta_id = meta_id
    row.rejected_reason = reason if reason and reason.upper() != "NONE" and event in ("REJECTED", "DISABLED") else ""
    row.save()


def _template_quality(value: dict) -> None:
    name = str(value.get("message_template_name") or "").strip()
    meta_id = str(value.get("message_template_id") or "").strip()
    score = str(value.get("new_quality_score") or "").strip().upper()
    if not score or not (name or meta_id):
        return
    rows = WhatsAppTemplate.objects.filter(meta_id=meta_id) if meta_id else WhatsAppTemplate.objects.none()
    if not rows.exists() and name:
        language = str(value.get("message_template_language") or "").strip()
        rows = WhatsAppTemplate.objects.filter(name=name, **({"language": language} if language else {}))
    rows.update(quality_score=score, updated_at=timezone.now())


def _process(payload) -> None:
    if not isinstance(payload, dict):
        return
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            field = change.get("field")
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            try:
                if field == "messages":
                    for status in value.get("statuses") or []:
                        if isinstance(status, dict):
                            _apply_status(status)
                    for message in value.get("messages") or []:
                        if isinstance(message, dict):
                            _employee_wrote(message)
                elif field == "message_template_status_update":
                    _template_status(value)
                elif field == "message_template_quality_update":
                    _template_quality(value)
                elif field in ("phone_number_quality_update", "account_update", "phone_number_name_update"):
                    event = value.get("event")
                    logger.warning(
                        "WhatsApp account event: %s %s",
                        field,
                        event if isinstance(event, str) and _SAFE_WORD.match(event) else "-",
                    )
            except Exception:
                logger.exception("A WhatsApp webhook event (%s) could not be processed", field)


def _webhook_summary(payload) -> tuple[str, bool]:
    """A one-line description of a webhook body that contains none of its data, and whether its shape was recognised.

    Webhook bodies carry employees' phone numbers and the text of the messages they send, so the body itself must never
    reach the logs. Only things from a fixed vocabulary are printed: the event field names, how many statuses / messages
    it holds, the message types (text, button ...) and the delivery statuses. An unrecognised body is described by the
    names of its top-level keys, never their values."""
    fields, counts, types, statuses = set(), {}, set(), set()
    entries = payload.get("entry") if isinstance(payload, dict) else None
    for entry in entries if isinstance(entries, list) else []:
        for change in (entry.get("changes") if isinstance(entry, dict) else None) or []:
            if not isinstance(change, dict):
                continue
            field = change.get("field")
            if isinstance(field, str) and _SAFE_WORD.match(field):
                fields.add(field)
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            for kind in ("statuses", "messages"):
                items = value.get(kind)
                if not isinstance(items, list):
                    continue
                counts[kind] = counts.get(kind, 0) + len(items)
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    word = item.get("status") if kind == "statuses" else item.get("type")
                    if isinstance(word, str) and _SAFE_WORD.match(word):
                        (statuses if kind == "statuses" else types).add(word.lower())
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


@csrf_exempt
def whatsapp_webhook(request) -> HttpResponse:
    """Meta's webhook (see the module docstring). Public: no login, no JWT; the verify token (GET) and the signature
    (POST) are the only credentials."""
    if request.method == "GET":
        q = request.GET
        if q.get("hub.mode") == "subscribe" and whatsapp_cloud.verify_token_matches(q.get("hub.verify_token")):
            return HttpResponse(q.get("hub.challenge", ""), content_type="text/plain")
        return HttpResponse("Forbidden", status=403, content_type="text/plain")
    if request.method != "POST":
        return HttpResponse(status=405)
    raw = request.body  # the RAW bytes: the signature is over exactly these
    if not whatsapp_cloud.verify_signature(raw, request.headers.get("X-Hub-Signature-256")):
        logger.warning("WhatsApp webhook: refused a POST without a valid signature")
        return HttpResponse("Forbidden", status=403, content_type="text/plain")
    try:
        WhatsAppSettings.get()
        WhatsAppSettings.objects.filter(pk=1).update(last_webhook_at=timezone.now())
    except Exception:
        logger.exception("WhatsApp webhook: could not record when it was last received")
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        logger.warning("WhatsApp webhook: a signed body that is not JSON")
        return HttpResponse(status=200)
    summary, recognised = _webhook_summary(payload)
    if recognised:
        logger.info("WhatsApp webhook: %s", summary)
    else:
        logger.warning("WhatsApp webhook in an unrecognised shape: %s", summary)
    try:
        _process(payload)
    except Exception:
        logger.exception("WhatsApp webhook event could not be processed")
    return HttpResponse(status=200)
