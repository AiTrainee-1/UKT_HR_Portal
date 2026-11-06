"""
The WhatsApp send queue's one paced sender (2026-11-06).

    send_notification / send_document / bulk sends -> WhatsAppMessageLog row, status "queued"
    tick() every 10 s (the APScheduler job below, started by apps.py) -> at most ONE message per tick -> WAClient

Why: WAClient is an unofficial WhatsApp Web link, and WhatsApp restricts a number for automated,
high-volume, repetitive messaging (the same text to many people within minutes, several messages a
day to one person, recipients who never reply). The cure is fewer messages, fewer per person, a
steady pace, quiet nights and no catch-up bursts. There is deliberately no random jitter: it would
only disguise the pattern, not change it.

What one tick does, in order:

  1. Expire. A queued row past its `expires_at`, or raised on an earlier day (IST), becomes
     "expired" ("Too late to be useful: not sent"). It is never sent and never retried.
  2. Nothing is sent while the master switch is off, WhatsApp isn't configured on this machine,
     or it is quiet hours (WhatsAppSettings.quiet_start..quiet_end, IST).
  3. Circuit breaker: 3 provider failures within 30 minutes (a disconnected or restricted number,
     an outage) pause sending until 15 minutes after the last failure; then one message is tried,
     and a failure pauses again. A missing phone number or a switch is not a provider failure.
  4. Pacing, measured in the database (so it holds across processes and restarts): fewer than
     `max_per_hour` sent in the last 60 minutes, fewer than `max_per_day` sent today, and at least
     `min_gap_seconds` since the last message of ANY kind (a one-time code counts too).
  5. The next row (lowest priority value, then the oldest `send_after` <= now) is taken under a row
     lock. Per row: switched off since it was queued, or the employee opted out -> skipped; an
     AUTOMATIC message for an employee who already got `max_per_employee_per_day` automatic
     messages today -> skipped ("Daily limit for this employee"); the same employee got the same
     type with the same text in the last 24 hours -> skipped ("Duplicate"). Otherwise it is marked
     "sending", sent, and becomes "sent" (or "failed"). A temporary failure (network error,
     timeout, HTTP 5xx / 429) goes back to "queued" ONCE, a minute later, if it is still fresh and
     still today; nothing else is ever retried.

Two processes running tick() at once are safe: the settings row is locked for the decision (one
process decides at a time, the other skips its tick), and a row being sent is "sending", which the
pacing counts as "a message is going out right now".

Under `manage.py test` (settings.WHATSAPP_ASYNC_SEND False) whatsapp_service hands a newly queued
row to deliver_now() instead: the switches, opt-out and kinds still apply, the pacing, caps and
quiet hours do not. The dispatcher itself is tested by calling tick(now=...) directly.
"""

import logging
from datetime import datetime, time as time_type, timedelta

from django.db import transaction
from django.db.models import Count, Max, Min, Q
from django.utils import timezone

from . import whatsapp_catalog as catalog
from . import whatsapp_service as svc
from .clock import FACTORY_TZ
from .scheduler_db import fresh_db_connection

logger = logging.getLogger(__name__)

TICK_SECONDS = 10
# A temporary failure is retried once, this long after it happened.
RETRY_AFTER = timedelta(seconds=60)
MAX_ATTEMPTS = 2
# The circuit breaker (generalised from the attendance-alert job's pause, 2026-09).
BREAKER_FAILURES = 3
BREAKER_WINDOW = timedelta(minutes=30)
BREAKER_PAUSE = timedelta(minutes=15)
DUPLICATE_WINDOW = timedelta(hours=24)
# Rows skipped in one tick before it gives up for this tick (a long run of opted-out / capped rows).
MAX_SKIPS_PER_TICK = 50
# A row "sending" for longer than this is from a process that stopped (expire_stale_pending fails it).
STUCK_SENDING = timedelta(minutes=10)

REASON_EXPIRED = "Too late to be useful: not sent"
REASON_EMPLOYEE_LIMIT = "Daily limit for this employee"
REASON_DUPLICATE = "Duplicate"
REASON_CLEARED = "Cleared by HR"
REASON_QUIET = svc.REASON_QUIET
REASON_OPTED_OUT = svc.REASON_OPTED_OUT
# The error texts the provider (or the way to it) produced: what the circuit breaker counts.
PROVIDER_ERROR_PREFIXES = ("Send failed", "Could not reach WAClient", "Temporary failure")
TEMPORARY_PREFIX = "Temporary failure (one retry in a minute): "

_SENT_STATUSES = ("sent", "delivered", "read")


def _model():
    from .models import WhatsAppMessageLog

    return WhatsAppMessageLog


def _settings():
    from .models import WhatsAppSettings

    return WhatsAppSettings.get()


# ── the day, quiet hours and freshness ──────────────────────────────────────────────


def day_start(now: datetime | None = None) -> datetime:
    """Midnight (IST) of the day `now` falls on, as an aware datetime."""
    local = (now or timezone.now()).astimezone(FACTORY_TZ)
    return datetime.combine(local.date(), time_type(0, 0), tzinfo=FACTORY_TZ)


def day_end(now: datetime | None = None) -> datetime:
    """The next midnight (IST): nothing raised today is ever sent after it."""
    return day_start(now) + timedelta(days=1)


def in_quiet_hours(s=None, now: datetime | None = None) -> bool:
    """Is it quiet hours now (IST)? The span may cross midnight (21:00 -> 07:00); equal start and end means none."""
    s = s or _settings()
    if not s.quiet_hours_enabled or s.quiet_start == s.quiet_end:
        return False
    t = (now or timezone.now()).astimezone(FACTORY_TZ).time()
    if s.quiet_start < s.quiet_end:
        return s.quiet_start <= t < s.quiet_end
    return t >= s.quiet_start or t < s.quiet_end


def quiet_hours_end(s, now: datetime) -> datetime:
    """When the quiet hours that `now` falls in end (aware). Only meaningful while in_quiet_hours."""
    local = now.astimezone(FACTORY_TZ)
    end = datetime.combine(local.date(), s.quiet_end, tzinfo=FACTORY_TZ)
    if end <= now:
        end += timedelta(days=1)
    return end


def freshness_minutes(document_type: str, s) -> int | None:
    """How long after it was raised a message of this type is still worth sending (None: until the end of the day)."""
    t = catalog.get(document_type)
    if t is None:
        return None
    if t.fresh_setting:
        return max(1, int(getattr(s, t.fresh_setting) or 0))
    return t.fresh_minutes


def expiry_for(document_type: str, s, now: datetime, until: datetime | None = None) -> datetime:
    """min(now + the type's freshness, `until` if the caller knows better, the end of today IST)."""
    candidates = [day_end(now)]
    minutes = freshness_minutes(document_type, s)
    if minutes:
        candidates.append(now + timedelta(minutes=minutes))
    if until is not None:
        candidates.append(until)
    return min(candidates)


# ── the circuit breaker and the pacing ──────────────────────────────────────────────


def _provider_failures(now: datetime):
    M = _model()
    provider = Q()
    for prefix in PROVIDER_ERROR_PREFIXES:
        provider |= Q(error_message__startswith=prefix)
    return M.objects.filter(provider, updated_at__gte=now - BREAKER_WINDOW).filter(
        Q(status=M.STATUS_FAILED) | Q(status=M.STATUS_QUEUED, attempts__gte=1)
    )


# Answers from WAClient that mean the whole account cannot send (not one message): nothing will go until HR acts, so
# sending stops at the first one instead of after three. Live log 2026-11-06: 1,229 messages were tried against an
# "inactive" instance and 193 against an expired plan, because nothing stopped the queue. One probe every
# ACCOUNT_PAUSE after that (a relinked number or a renewed plan starts sending again by itself).
ACCOUNT_PAUSE = timedelta(minutes=30)
ACCOUNT_ERRORS = (
    (
        ("instance id is inactive", "relogin to your whatsapp"),
        "WhatsApp is disconnected: the number is logged out of WAClient (WhatsApp may have restricted it). Relink it "
        "in the WAClient dashboard by scanning the QR code.",
    ),
    (
        ("plan has expired", "extend your plan"),
        "The WAClient plan has expired: renew it in the WAClient dashboard.",
    ),
)


def _account_pause(now: datetime) -> tuple[bool, str | None, datetime | None]:
    """Paused when the last provider failure says the account cannot send and nothing was sent after it."""
    M = _model()
    provider = Q()
    for prefix in PROVIDER_ERROR_PREFIXES:
        provider |= Q(error_message__startswith=prefix)
    last = (
        M.objects.filter(provider, updated_at__gte=now - timedelta(days=1))
        .filter(Q(status=M.STATUS_FAILED) | Q(status=M.STATUS_QUEUED, attempts__gte=1))
        .order_by("-updated_at")
        .values("error_message", "updated_at")
        .first()
    )
    if last is None:
        return False, None, None
    error = (last["error_message"] or "").lower()
    why = next((text for markers, text in ACCOUNT_ERRORS if any(m in error for m in markers)), None)
    if why is None or M.objects.filter(sent_at__gt=last["updated_at"]).exists():
        return False, None, None
    until = last["updated_at"] + ACCOUNT_PAUSE
    if now >= until:
        return False, None, None  # time for one probe
    at = until.astimezone(FACTORY_TZ).strftime("%I:%M %p").lstrip("0")
    return True, f"Paused: {why} Sending tries again at {at}.", until


def pause_state(now: datetime | None = None) -> tuple[bool, str | None, datetime | None]:
    """(paused, why, until): the circuit breaker. Paused at once when WAClient says the account itself cannot send
    (disconnected number, expired plan), and while BREAKER_FAILURES provider failures happened within BREAKER_WINDOW
    and the last one is less than BREAKER_PAUSE ago."""
    now = now or timezone.now()
    account = _account_pause(now)
    if account[0]:
        return account
    agg = _provider_failures(now).aggregate(n=Count("id"), last=Max("updated_at"))
    if agg["n"] >= BREAKER_FAILURES and agg["last"] is not None:
        until = agg["last"] + BREAKER_PAUSE
        if now < until:
            at = until.astimezone(FACTORY_TZ).strftime("%I:%M %p").lstrip("0")
            return (
                True,
                f"Paused: {agg['n']} messages failed at WhatsApp in the last {BREAKER_WINDOW.seconds // 60} minutes "
                f"(a disconnected or restricted number?). Sending tries again at {at}.",
                until,
            )
    return False, None, None


def provider_is_failing(now: datetime | None = None) -> bool:
    return pause_state(now)[0]


def _sent():
    return _model().objects.filter(sent_at__isnull=False)


def sent_counts(now: datetime | None = None) -> tuple[int, int]:
    """(messages sent in the last 60 minutes, messages sent today), every kind counted."""
    now = now or timezone.now()
    agg = _sent().aggregate(
        hour=Count("id", filter=Q(sent_at__gt=now - timedelta(hours=1))),
        day=Count("id", filter=Q(sent_at__gte=day_start(now))),
    )
    return agg["hour"], agg["day"]


def wait_state(s, now: datetime) -> tuple[str | None, datetime | None]:
    """(why nothing may be sent right now, the earliest moment that changes) from the pacing alone; (None, None) when a
    message may go now. Measured in the database, so it holds across processes and restarts."""
    M = _model()
    if M.objects.filter(status=M.STATUS_SENDING, updated_at__gte=now - STUCK_SENDING).exists():
        return "A message is being sent right now.", now + timedelta(seconds=TICK_SECONDS)
    hour, day = sent_counts(now)
    if day >= s.max_per_day:
        return f"Today's limit of {s.max_per_day} messages is used up.", None
    if hour >= s.max_per_hour:
        oldest = (
            _sent().filter(sent_at__gt=now - timedelta(hours=1)).order_by("sent_at").values_list("sent_at", flat=True)
        )
        release = oldest[hour - s.max_per_hour] + timedelta(hours=1) if hour - s.max_per_hour < len(oldest) else None
        return f"The limit of {s.max_per_hour} messages an hour is reached.", release
    last = _sent().aggregate(last=Max("sent_at"))["last"]
    if last is not None:
        next_at = last + timedelta(seconds=max(0, s.min_gap_seconds))
        if now < next_at:
            return f"Waiting {s.min_gap_seconds} s between messages.", next_at
    return None, None


# ── one row ─────────────────────────────────────────────────────────────────────────


def _is_expired(row, now: datetime) -> bool:
    return (row.expires_at is not None and row.expires_at <= now) or row.created_at < day_start(now)


def _skip_reason(row, s, now: datetime, *, limits: bool) -> str | None:
    """Why this queued row must not be sent after all, or None. `limits` adds the per-employee cap and the duplicate
    check (the dispatcher's own rules; inline delivery under tests leaves them out)."""
    off = svc.switch_off_reason(row.document_type, row.related_module, s)
    if off:
        return f"Switched off before it was sent: {off}"
    if row.kind != catalog.KIND_CODE and svc.opted_out(row.employee_id):  # by id: never load the employee's photo
        return REASON_OPTED_OUT
    if not limits:
        return None
    M = _model()
    if row.kind == catalog.KIND_AUTOMATIC:
        today = (
            M.objects.filter(employee_id=row.employee_id, kind=catalog.KIND_AUTOMATIC, sent_at__gte=day_start(now))
            .exclude(document_type="visitor_contact")  # the card is part of the visitor message
            .count()
        )
        if today >= s.max_per_employee_per_day:
            return REASON_EMPLOYEE_LIMIT
    if row.message_text:
        same = M.objects.filter(
            employee_id=row.employee_id,
            document_type=row.document_type,
            message_text=row.message_text,
            sent_at__gte=now - DUPLICATE_WINDOW,
        ).exclude(pk=row.pk)
        if row.kind == catalog.KIND_DOCUMENT:
            same = same.filter(document_ref_id=row.document_ref_id)  # the same caption on a different file is no repeat
        if same.exists():
            return REASON_DUPLICATE
    return None


def _finish(row, status: str, reason: str) -> None:
    row.status = status
    row.error_message = reason
    row.save(update_fields=["status", "error_message", "updated_at"])


def _send_document_row(row):
    payload = dict(row.payload or {})
    url = payload.get("media_url")
    filename = payload.get("filename") or "document.pdf"
    mime_type = payload.get("mime_type") or "application/pdf"
    if not url:
        if not payload.get("build"):
            raise svc.WhatsAppServiceError("The document of this message is missing.")
        try:
            content = svc.build_document(payload["build"], payload.get("build_args") or {})
        except Exception as exc:
            logger.exception("Building the %s document of WhatsApp message %s failed", payload["build"], row.pk)
            raise svc.WhatsAppServiceError(f"The document could not be prepared: {exc}")
        token = svc._store_media(content, filename, mime_type)
        url = svc.media_url_for_base(payload.get("base_url") or "", token)
        payload["media_url"] = url  # a retry sends the same file instead of building it again
        row.payload = payload
    return svc.send_document_message(row.phone_number, url, filename, row.message_text, mime_type)


def _mark_visitor_notified(log) -> None:
    """Reception's "notified on WhatsApp" time, once the visitor message has really been sent."""
    from .models import VisitorVisit

    if log.document_ref_id:
        VisitorVisit.objects.filter(pk=log.document_ref_id).update(notified_whatsapp_at=log.sent_at or timezone.now())


# Run after a message is really sent, named in its payload ("on_sent"): a queued row can't carry a function.
ON_SENT_HOOKS = {"visitor_notified": _mark_visitor_notified}


def _send_contact_card(row, contact: dict, now: datetime) -> None:
    """The visitor's contact card, right after the visitor message (it is part of it), logged as its own row."""
    M = _model()
    name = f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip()
    doc_type = contact.get("document_type", "visitor_contact")
    off = svc.switch_off_reason(doc_type, row.related_module)
    card = M.objects.create(
        employee_id=row.employee_id,
        document_type=doc_type,
        document_ref_id=row.document_ref_id,
        phone_number=row.phone_number,
        status=M.STATUS_SKIPPED if off else M.STATUS_SENDING,
        error_message=off or "",
        message_text=f"Contact card: {name} ({contact.get('phone', '')})",
        related_module=contact.get("related_module", ""),
        kind=catalog.kind_of(doc_type),
        priority=row.priority,
        attempts=0 if off else 1,
        payload={"follow_up_of": row.pk},
    )
    if off:
        return
    try:
        result = svc.send_contact_message(
            row.phone_number, contact.get("first_name", ""), contact.get("last_name", ""), contact.get("phone", "")
        )
    except svc.WhatsAppServiceError as exc:
        card.status, card.error_message = M.STATUS_FAILED, str(exc)
    except Exception as exc:
        logger.exception("Unexpected error sending WhatsApp contact card")
        card.status, card.error_message = M.STATUS_FAILED, f"Unexpected error: {exc}"
    else:
        card.status = M.STATUS_SENT
        card.provider_message_id = svc._provider_message_id(result)
        card.sent_at = now
    card.save(update_fields=["status", "error_message", "provider_message_id", "sent_at", "updated_at"])


def _send(row, *, fixed_now: datetime | None, allow_retry: bool):
    """Send a row already marked "sending" and record the outcome. `fixed_now` stamps the times (tests freeze it);
    None = the real clock after the send."""
    M = _model()
    try:
        if (
            row.kind == catalog.KIND_DOCUMENT
            or (row.payload or {}).get("media_url")
            or (row.payload or {}).get("build")
        ):
            result = _send_document_row(row)
        else:
            result = svc.send_text_message(row.phone_number, (row.payload or {}).get("text") or row.message_text)
    except svc.WhatsAppServiceError as exc:
        now = fixed_now or timezone.now()
        retry_at = now + RETRY_AFTER
        fresh = (row.expires_at is None or row.expires_at > retry_at) and retry_at < day_end(now)
        if allow_retry and exc.temporary and row.attempts < MAX_ATTEMPTS and fresh:
            row.status, row.send_after, row.error_message = M.STATUS_QUEUED, retry_at, f"{TEMPORARY_PREFIX}{exc}"
        else:
            row.status, row.error_message = M.STATUS_FAILED, str(exc)
    except Exception as exc:  # never leave a row "sending" because of a bug in a helper
        logger.exception("Unexpected error sending WhatsApp message %s", row.pk)
        row.status, row.error_message = M.STATUS_FAILED, f"Unexpected error: {exc}"
    else:
        row.status = M.STATUS_SENT
        row.sent_at = fixed_now or timezone.now()
        row.provider_message_id = svc._provider_message_id(result)
        row.error_message = ""
    row.save(
        update_fields=[
            "status",
            "error_message",
            "provider_message_id",
            "sent_at",
            "send_after",
            "payload",
            "updated_at",
        ]
    )
    if row.status == M.STATUS_SENT:
        payload = row.payload or {}
        if payload.get("contact"):
            _send_contact_card(row, payload["contact"], row.sent_at)
        hook = ON_SENT_HOOKS.get(payload.get("on_sent") or "")
        if hook is not None:
            try:
                hook(row)
            except Exception:
                logger.exception("WhatsApp on_sent hook %s failed for message %s", payload.get("on_sent"), row.pk)
    return row


def deliver_now(row):
    """Inline delivery (settings.WHATSAPP_ASYNC_SEND False: tests). The switches and the opt-out still apply; the pacing,
    the caps, the duplicate check and quiet hours do not, and a temporary failure is not retried."""
    M = _model()
    try:
        skip = _skip_reason(row, _settings(), timezone.now(), limits=False)
        if skip:
            _finish(row, M.STATUS_SKIPPED, skip)
            return row
        row.status = M.STATUS_SENDING
        row.attempts += 1
        row.save(update_fields=["status", "attempts", "updated_at"])
        return _send(row, fixed_now=None, allow_retry=False)
    except Exception:
        logger.exception("Inline WhatsApp delivery of message %s failed", row.pk)
        return row


# ── the tick ────────────────────────────────────────────────────────────────────────


def expire_due(now: datetime | None = None) -> int:
    """Queued rows that are too late to be useful: past their expiry, or raised on an earlier day."""
    M = _model()
    now = now or timezone.now()
    return (
        M.objects.filter(status=M.STATUS_QUEUED)
        .filter(Q(expires_at__lte=now) | Q(created_at__lt=day_start(now)))
        .update(status=M.STATUS_EXPIRED, error_message=REASON_EXPIRED, updated_at=timezone.now())
    )


def tick(now: datetime | None = None) -> dict:
    """One dispatcher run: expire what is too late, then send at most one message if everything allows it. Returns
    {expired, skipped, sent, failed, retry, state} for logs and tests. `now` freezes the clock (tests)."""
    M = _model()
    fixed_now = now
    now = now or timezone.now()
    out = {"expired": expire_due(now), "skipped": 0, "sent": 0, "failed": 0, "retry": 0, "state": ""}
    s = _settings()
    if not s.engine_enabled:
        out["state"] = "engine off"
        return out
    if not svc.is_configured():
        out["state"] = "not configured"
        return out
    if in_quiet_hours(s, now):
        out["state"] = "quiet hours"
        return out
    if pause_state(now)[0]:
        out["state"] = "paused"
        return out

    row = None
    with transaction.atomic():
        from .models import WhatsAppSettings

        # One process decides at a time; another one running the same tick right now skips its turn.
        locked = WhatsAppSettings.objects.select_for_update(skip_locked=True).filter(pk=1).first()
        if locked is None:
            out["state"] = "busy"
            return out
        why, _ = wait_state(locked, now)
        if why:
            out["state"] = why
            return out
        for _ in range(MAX_SKIPS_PER_TICK):
            candidate = (
                M.objects.select_for_update(skip_locked=True)
                .filter(status=M.STATUS_QUEUED)
                .filter(Q(send_after__isnull=True) | Q(send_after__lte=now))
                .order_by("priority", "send_after", "id")
                .first()
            )
            if candidate is None:
                break
            if _is_expired(candidate, now):
                _finish(candidate, M.STATUS_EXPIRED, REASON_EXPIRED)
                out["expired"] += 1
                continue
            skip = _skip_reason(candidate, locked, now, limits=True)
            if skip:
                _finish(candidate, M.STATUS_SKIPPED, skip)
                out["skipped"] += 1
                continue
            candidate.status = M.STATUS_SENDING
            candidate.attempts += 1
            candidate.save(update_fields=["status", "attempts", "updated_at"])
            row = candidate
            break
    if row is None:
        out["state"] = out["state"] or "nothing to send"
        return out
    row = _send(row, fixed_now=fixed_now, allow_retry=True)
    key = {M.STATUS_SENT: "sent", M.STATUS_FAILED: "failed", M.STATUS_QUEUED: "retry"}.get(row.status)
    if key:
        out[key] += 1
    out["state"] = f"{row.status} {row.document_type} #{row.pk}"
    return out


@fresh_db_connection
def run_tick() -> None:
    """The scheduler job: never raises."""
    try:
        svc.expire_stale_pending()
    except Exception:
        logger.exception("WhatsApp stale-message sweep failed")
    try:
        result = tick()
        if result["sent"] or result["failed"] or result["expired"] or result["skipped"]:
            logger.info("WhatsApp dispatcher: %s", result)
    except Exception:
        logger.exception("WhatsApp dispatcher tick failed")


# ── what the WhatsApp Control page shows and does ───────────────────────────────────


def queue_status(now: datetime | None = None) -> dict:
    """GET /api/whatsapp-control/queue."""
    M = _model()
    now = now or timezone.now()
    s = _settings()
    start = day_start(now)
    paused, paused_reason, paused_until = pause_state(now)
    quiet = in_quiet_hours(s, now)
    hour, day = sent_counts(now)
    agg = M.objects.aggregate(
        queued=Count("id", filter=Q(status=M.STATUS_QUEUED)),
        failed=Count("id", filter=Q(status=M.STATUS_FAILED, updated_at__gte=start)),
        expired=Count("id", filter=Q(status=M.STATUS_EXPIRED, updated_at__gte=start)),
        skipped=Count("id", filter=Q(status=M.STATUS_SKIPPED, updated_at__gte=start)),
        first_due=Min("send_after", filter=Q(status=M.STATUS_QUEUED)),
    )
    next_at = None
    if agg["queued"] and s.engine_enabled and svc.is_configured():
        candidates = [now]
        if agg["first_due"] is not None:
            candidates.append(agg["first_due"])
        if quiet:
            candidates.append(quiet_hours_end(s, now))
        if paused and paused_until is not None:
            candidates.append(paused_until)
        why, release = wait_state(s, now)
        if why and release is None:
            candidates = []  # today's limit is used up: nothing more goes today (and the queue expires at midnight)
        elif release is not None:
            candidates.append(release)
        if candidates:
            next_at = max(candidates)
            if next_at >= day_end(now):
                next_at = None
    return {
        "engineEnabled": bool(s.engine_enabled),
        "paused": paused,
        "pausedReason": paused_reason,
        "inQuietHours": quiet,
        "queued": agg["queued"],
        "sentToday": day,
        "sentLastHour": hour,
        "failedToday": agg["failed"],
        "expiredToday": agg["expired"],
        "skippedToday": agg["skipped"],
        "nextSendAt": next_at.isoformat() if next_at else None,
        "limits": {
            "minGapSeconds": s.min_gap_seconds,
            "maxPerHour": s.max_per_hour,
            "maxPerDay": s.max_per_day,
            "maxPerEmployeePerDay": s.max_per_employee_per_day,
        },
    }


def clear_queue() -> int:
    """POST /api/whatsapp-control/queue/clear: every queued row becomes skipped ("Cleared by HR")."""
    M = _model()
    return M.objects.filter(status=M.STATUS_QUEUED).update(
        status=M.STATUS_SKIPPED, error_message=REASON_CLEARED, updated_at=timezone.now()
    )


def capacity_today(now: datetime | None = None) -> int:
    """About how many more messages can still go out today at the current limits (before quiet hours start and within
    the daily cap), whatever is already queued. A bulk send uses it to say how much of a batch can go today."""
    now = now or timezone.now()
    s = _settings()
    if not s.engine_enabled:
        return 0
    _, day = sent_counts(now)
    left_today = max(0, s.max_per_day - day)
    stop = day_end(now)
    if s.quiet_hours_enabled and s.quiet_start != s.quiet_end:
        if in_quiet_hours(s, now):
            return 0
        local = now.astimezone(FACTORY_TZ)
        quiet_from = datetime.combine(local.date(), s.quiet_start, tzinfo=FACTORY_TZ)
        if now < quiet_from < stop:
            stop = quiet_from
    seconds = max(0.0, (stop - now).total_seconds())
    by_gap = int(seconds // max(1, s.min_gap_seconds))
    by_hour = int((seconds / 3600.0 + 1) * s.max_per_hour)
    return min(left_today, by_gap, by_hour)


# ── the scheduler job ───────────────────────────────────────────────────────────────

_JOB_ID = "whatsapp_dispatcher"


def start_scheduler_if_needed() -> None:
    """Register the 10-second dispatcher job (apps.py, at boot; never under the test runner). It shares the WhatsApp
    alert job's BackgroundScheduler (its own pool thread). max_instances=1 + coalesce: a slow send never overlaps the
    next tick, and missed ticks collapse into one instead of catching up in a burst."""
    from . import whatsapp_alert_scheduler as host

    if not host.is_available():
        return
    scheduler = host.get_scheduler()
    scheduler.add_job(
        run_tick,
        "interval",
        seconds=TICK_SECONDS,
        id=_JOB_ID,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=30,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("WhatsApp dispatcher started (every %s s)", TICK_SECONDS)
        except Exception as e:
            logger.error("Failed to start the WhatsApp dispatcher: %s", e)
