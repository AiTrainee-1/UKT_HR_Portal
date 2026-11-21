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
  * messages / messages[]       an employee's reply. A text "STOP" from an employee's registered number opts out every
                                employee record on that number (WhatsAppOptOut, reason "Replied STOP"). Nothing else is
                                stored: the text is never logged.
  * message_template_status_update   the template's row (WhatsAppTemplate) takes Meta's new status (APPROVED,
                                REJECTED with the reason, PAUSED, DISABLED ...). REINSTATED (a pause / disable lifted)
                                makes it APPROVED again, UNARCHIVED brings back an archived one; FLAGGED and LOCKED change
                                no status (a flag shows as low quality). A template this server did not know is added,
                                with the category of the message type sent as it (a later Sync fills in its text). A
                                template HR made for a message type whose review ends APPROVED takes over that type
                                (whatsapp_templates.adopt_if_approved).
  * message_template_quality_update  the template's quality score.
  * template_category_update    the template's new category.
  * phone_number_quality_update, account_update, others   only noted in the log (a summary without personal data).
A change about another WhatsApp Business Account (entry id) or another phone number (metadata.phone_number_id) than
this server's is ignored: one Meta app may be subscribed to a test account too. Every signed POST stamps
WhatsAppSettings.last_webhook_at (WhatsApp Control shows whether the webhook is set up).

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

from . import whatsapp_catalog, whatsapp_cloud, whatsapp_service, whatsapp_templates
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


def _employees_by_number(number: str) -> list[int]:
    """Every employee whose registered phone is this WhatsApp number (digits with the country code). Two records may
    share a number (a re-joined employee, a family phone): the person behind it is all of them."""
    digits = "".join(ch for ch in str(number or "") if ch.isdigit())
    if len(digits) < 10:
        return []
    tail = digits[-10:]
    out = []
    for emp_id, phone in Employee.objects.filter(phone__isnull=False).exclude(phone="").values_list("id", "phone"):
        cleaned = "".join(ch for ch in str(phone or "") if ch.isdigit())
        if cleaned.endswith(tail) and whatsapp_service.normalize_phone(phone) == digits:
            out.append(emp_id)
    return out


def _employee_wrote(message: dict) -> None:
    """An inbound message. Only a STOP is acted on (an opt-out of every employee record on that number); its text is
    never stored or logged."""
    if str(message.get("type") or "") != "text":
        return
    body = str(((message.get("text") or {}) if isinstance(message.get("text"), dict) else {}).get("body") or "")
    if body.strip().lower() not in _STOP_WORDS:
        return
    for emp_id in _employees_by_number(message.get("from")):
        _, created = WhatsAppOptOut.objects.get_or_create(
            employee_id=emp_id, defaults={"reason": REASON_STOP, "created_by": "WhatsApp (employee replied STOP)"}
        )
        if created:
            logger.info("WhatsApp: employee %s opted out by replying STOP", emp_id)


# Meta's template events (webhooks reference, message_template_status_update -> event). These are a status of the
# template and are stored as it:
_STATUS_EVENTS = frozenset(
    {
        "APPROVED",
        "REJECTED",
        "PENDING",
        "IN_APPEAL",
        "PAUSED",
        "DISABLED",
        "DELETED",
        "PENDING_DELETION",
        "LIMIT_EXCEEDED",
        "ARCHIVED",
    }
)
# REINSTATED: Meta lifted a pause / disable, "it can be sent in template messages again" -> APPROVED. UNARCHIVED: the
# template is back from the archive -> APPROVED, unless it went there rejected (its rejection reason is kept).
_REINSTATED = "REINSTATED"
_UNARCHIVED = "UNARCHIVED"
# Events about a template whose status does NOT change: FLAGGED (people reacted badly, Meta may pause it: it is still
# sent, and shows as low quality), LOCKED / UNLOCKED (whether it can still be edited).
_FLAGGED = "FLAGGED"
_NOTE_EVENTS = frozenset({_FLAGGED, "LOCKED", "UNLOCKED"})
_CATEGORIES = ("UTILITY", "AUTHENTICATION", "MARKETING")


def _category_for(name: str, value: dict) -> str:
    """The category of a template this server learns about from an event: Meta's own word when the event carries one,
    else the category of the HRMS message type sent as it (hrms_otp -> AUTHENTICATION), else Utility."""
    stated = str(value.get("message_template_category") or "").strip().upper()
    if stated in _CATEGORIES:
        return stated
    uses = whatsapp_templates.used_by(name)
    spec = whatsapp_catalog.get(uses[0]) if uses else None
    return spec.meta_category if spec is not None else "UTILITY"


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
    if event in _NOTE_EVENTS:
        if row is not None and event == _FLAGGED and row.quality_score != "RED":
            row.quality_score = "RED"  # Meta flags a template whose quality dropped to low
            row.save(update_fields=["quality_score", "updated_at"])
        return
    if event not in _STATUS_EVENTS and event not in (_REINSTATED, _UNARCHIVED):
        logger.warning(
            "WhatsApp webhook: a template event this server does not know (%s): nothing changed",
            event if _SAFE_WORD.match(event) else "-",
        )
        return
    before = str(row.status or "").upper() if row is not None else ""
    if row is None:
        category = _category_for(name, value)
        row = WhatsAppTemplate(
            name=name,
            language=language,
            meta_id=meta_id,
            category=category,
            parameter_format="positional" if category == "AUTHENTICATION" else "named",
            components=[],  # its text comes with the next Sync now
        )
    if event == _REINSTATED:
        row.status = whatsapp_templates.APPROVED
        row.rejected_reason = ""
    elif event == _UNARCHIVED:
        if before in ("", "ARCHIVED"):
            row.status = "REJECTED" if row.rejected_reason else whatsapp_templates.APPROVED
    else:
        row.status = event
        if event in ("REJECTED", "DISABLED"):
            row.rejected_reason = reason if reason and reason.upper() != "NONE" else ""
        elif event != "ARCHIVED":  # an archived template keeps why it was rejected (see UNARCHIVED)
            row.rejected_reason = ""
    if meta_id:
        row.meta_id = meta_id
    row.save()
    whatsapp_templates.adopt_if_approved(row, before)


def _template_category(value: dict) -> None:
    """Meta moved a template to another category (template_category_update): its price and how a code is sent follow."""
    category = str(value.get("new_category") or value.get("correct_category") or "").strip().upper()
    if category not in _CATEGORIES:
        return
    meta_id = str(value.get("message_template_id") or "").strip()
    name = str(value.get("message_template_name") or "").strip()
    rows = WhatsAppTemplate.objects.filter(meta_id=meta_id) if meta_id else WhatsAppTemplate.objects.none()
    if not rows.exists() and name:
        language = str(value.get("message_template_language") or "").strip()
        rows = WhatsAppTemplate.objects.filter(name=name, **({"language": language} if language else {}))
    rows.update(category=category, updated_at=timezone.now())


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


_TEMPLATE_FIELDS = ("message_template_status_update", "message_template_quality_update", "template_category_update")


def _ours(entry: dict, field, value: dict) -> bool:
    """Is this change about OUR WhatsApp Business Account and number? One Meta app can be subscribed to several accounts
    (a test account next to the real one): a template event of another account must not overwrite our template of the
    same name, and a STOP sent to another number must not opt our employee out. A change that does not say which
    account / number it is about, or a server without the id set, is taken as ours."""
    if field in _TEMPLATE_FIELDS:
        ours, theirs = whatsapp_cloud.business_account_id(), str(entry.get("id") or "").strip()
    elif field == "messages":
        metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
        ours, theirs = whatsapp_cloud.phone_number_id(), str(metadata.get("phone_number_id") or "").strip()
    else:
        return True
    return not (ours and theirs and ours != theirs)


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
            if not _ours(entry, field, value):
                logger.info(
                    "WhatsApp webhook: a %s change for another WhatsApp Business Account or number was ignored",
                    field if isinstance(field, str) and _SAFE_WORD.match(field) else "-",
                )
                continue
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
                elif field == "template_category_update":
                    _template_category(value)
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
