"""Phone push delivery: every Notification row is pushed to its employee's phones once, AFTER the transaction that made it
has committed, on a background thread, in batches.

    any HRMS module -> Notification row -> (signals.py, post_save) schedule(id) -> on commit -> push queue -> Expo -> FCM / APNs
                                                                                     ^ sweep(), every minute: anything still
                                                                                       waiting (a restart lost the queue)

Why (owner 2026-11-17, "manual send works, automatic and chat do not"): the push used to run INSIDE the post_save, i.e. inside
the transaction that made the notification. Every automatic notification is made in one (push_messages.announce, the approval
workflows), so a single failed query in the push code (the employee-mute table before its migration ran, a dropped
connection) aborted that transaction and the notification itself was rolled back: no record, no push. The manual send made its
row outside a transaction, so it survived. Now nothing the push does can touch the work that made the notification, a push is
never sent for a notification that was rolled back, and a request never waits for Expo.

Exactly once: a row is CLAIMED before it is pushed (push_status "" -> "sending" under a row lock, skip_locked), so the queue
and the sweep can never push the same row twice. A row stuck in "sending" (the process stopped mid-send) is marked failed after
STUCK_AFTER and HR can push it again from Phone Notify Control.

Batches: Expo takes up to 100 messages per request, so a chat message to a few hundred phones is a handful of requests. Under
the test runner everything runs INLINE (a thread's own connection cannot see a TestCase's rows), inside a savepoint so a failure
in here can still never undo the caller's work.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
from datetime import timedelta

import requests
from django.conf import settings
from django.db import close_old_connections, connections, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
APP_TITLE = "UKTextiles"
EXPO_BATCH = 100  # Expo's limit of messages per request
CLAIM_BATCH = 500  # rows claimed and pushed in one go by the worker
SENDING = "sending"
# A row still waiting this long after it was made is pushed by the sweep, as long as it is younger than SWEEP_WINDOW
# (an older one would arrive stale: a punch reminder an hour late is noise).
SWEEP_AFTER = timedelta(seconds=45)
SWEEP_WINDOW = timedelta(minutes=30)
STUCK_AFTER = timedelta(minutes=10)
INTERRUPTED = "The server stopped while this push was being sent. Use Push again to send it."


def inline_mode() -> bool:
    """True under the test runner (or when PUSH_INLINE is set in the Django settings)."""
    flag = getattr(settings, "PUSH_INLINE", None)
    if flag is not None:
        return bool(flag)
    return len(sys.argv) > 1 and sys.argv[1] == "test"


# ── scheduling ───────────────────────────────────────────────────────────────


def schedule(ids) -> None:
    """Push these notifications once the current transaction commits (at once when there is none). Never raises."""
    ids = [i for i in ids if i]
    if not ids:
        return
    if inline_mode():
        _push_inline(ids)
        return
    transaction.on_commit(lambda: _enqueue(ids), robust=True)


def _push_inline(ids) -> None:
    try:
        with transaction.atomic():  # a savepoint: whatever fails in here is undone alone, never the caller's work
            push(ids)
    except Exception:
        logger.exception("Could not push notifications %s", ids[:5])


_queue: queue.SimpleQueue = queue.SimpleQueue()
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def _enqueue(ids) -> None:
    for i in ids:
        _queue.put(i)
    _ensure_worker()


def _ensure_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_work, name="phone-push", daemon=True)
        _worker.start()


def _work() -> None:
    while True:
        batch = [_queue.get()]  # waits for the next notification
        while len(batch) < CLAIM_BATCH:
            try:
                batch.append(_queue.get_nowait())
            except queue.Empty:
                break
        try:
            close_old_connections()
            push(batch)
        except Exception:
            logger.exception("A phone push batch failed; the minute sweep sends whatever is still waiting")
        finally:
            connections.close_all()  # this thread's own connection only


# ── the push itself ──────────────────────────────────────────────────────────


def _claim(ids) -> list[int]:
    """The rows of `ids` still waiting for their push, now marked "sending" (pushed_at = the claim time, so a stuck one can be
    told apart). Rows another worker holds or already pushed are left out."""
    from .models import Notification

    with transaction.atomic():
        got = list(
            Notification.objects.select_for_update(skip_locked=True)
            .filter(pk__in=list(ids), push_status="")
            .values_list("pk", flat=True)
        )
        if got:
            Notification.objects.filter(pk__in=got).update(push_status=SENDING, pushed_at=timezone.now())
    return got


def _record(pk: int, status: str, error: str = "", tickets: str = "") -> None:
    from .models import Notification

    Notification.objects.filter(pk=pk).update(
        push_status=status,
        push_error=(error or "")[:500],
        push_tickets=tickets,
        pushed_at=timezone.now() if status in ("sent", "failed") else None,
    )


def _push_data(n, context: dict) -> dict:
    """What a tap on the push hands the app: the type and the row, plus where its View button leads (notification_targets.py)
    as {kind, id, category} only, to keep the payload small. No `target` key when there is nothing to open."""
    from . import notification_targets

    data = {"type": n.type, "notificationId": n.id}
    target = notification_targets.target_for(n, context)  # never raises
    if target:
        data["target"] = {"kind": target["kind"], "id": target["id"], "category": target["category"]}
    return data


def _target_context(rows) -> dict:
    from . import notification_targets

    try:
        with transaction.atomic():
            return notification_targets.build_context(rows)
    except Exception:
        logger.warning("Could not look up the View targets of a push batch", exc_info=True)
        return {"reminders": {}, "slips": {}}


def push(ids) -> dict[int, str]:
    """Claim and push these notifications; returns {id: push_status} for the rows this call pushed. Expo answers each message
    with a ticket: "ok" means Expo took it (push_receipts.py later reads whether Google / Apple accepted it)."""
    from . import mobile_messages, push_receipts
    from .models import Notification, PushToken

    out: dict[int, str] = {}
    for start in range(0, len(ids), CLAIM_BATCH):
        claimed = _claim(ids[start : start + CLAIM_BATCH])
        if not claimed:
            continue
        rows = list(Notification.objects.filter(pk__in=claimed).order_by("id"))
        blocked = mobile_messages.push_blocks(rows)
        tokens: dict[int, list[str]] = {}
        for emp_id, token in PushToken.objects.filter(employee_id__in={n.employee_id for n in rows}).values_list(
            "employee_id", "token"
        ):
            tokens.setdefault(emp_id, []).append(token)
        context = _target_context(rows)

        outbox: list[tuple[int, str, dict]] = []  # (notification id, token, Expo message)
        for n in rows:
            if n.pk in blocked:
                _record(n.pk, "off", blocked[n.pk])
                out[n.pk] = "off"
                continue
            phones = tokens.get(n.employee_id) or []
            if not phones:
                _record(n.pk, "no_device")
                out[n.pk] = "no_device"
                continue
            # A notification made from a WhatsApp message has its own headline ("Request Approved"); the older one-liners
            # keep the app name. High priority + the default sound so it shows on the lock screen and rings like a message.
            message = {
                "title": n.title or APP_TITLE,
                "body": n.message,
                "sound": "default",
                "priority": "high",
                "channelId": "default",
                "data": _push_data(n, context),
            }
            outbox.extend((n.pk, token, {**message, "to": token}) for token in phones)

        sent: dict[int, list] = {}  # id -> [(token, ticket)]
        problems: dict[int, str] = {}
        dead: list[str] = []
        for i in range(0, len(outbox), EXPO_BATCH):
            chunk = outbox[i : i + EXPO_BATCH]
            try:
                resp = requests.post(EXPO_PUSH_URL, json=[m for _, _, m in chunk], timeout=(5, 15))
                tickets = resp.json().get("data") if resp.ok else None
                if not resp.ok or not isinstance(tickets, list):
                    for pk, _, _ in chunk:
                        problems.setdefault(pk, f"Expo answered {resp.status_code}")
                    continue
                for (pk, token, _), ticket in zip(chunk, tickets):
                    sent.setdefault(pk, []).append((token, ticket))
                    if (
                        isinstance(ticket, dict)
                        and ticket.get("status") == "error"
                        and (ticket.get("details") or {}).get("error") == "DeviceNotRegistered"
                    ):
                        dead.append(token)
            except Exception as exc:
                logger.warning("Phone push request to Expo failed", exc_info=True)
                for pk, _, _ in chunk:
                    problems.setdefault(pk, f"{type(exc).__name__}: {exc}")

        for pk in dict.fromkeys(pk for pk, _, _ in outbox):
            answers = sent.get(pk, [])
            good = [(t, r) for t, r in answers if isinstance(r, dict) and r.get("status") == "ok"]
            if good:
                _record(pk, "sent", tickets=push_receipts.pack([t for t, _ in good], [r for _, r in good]))
                out[pk] = "sent"
            elif answers:
                first = answers[0][1] if isinstance(answers[0][1], dict) else {}
                _record(pk, "failed", str(first.get("message") or first.get("details") or "Expo refused it"))
                out[pk] = "failed"
            else:
                _record(pk, "failed", problems.get(pk) or "The push could not be sent")
                out[pk] = "failed"
        if dead:
            # an uninstalled app / reset notifications: that token never works again, so drop it instead of retrying it forever
            PushToken.objects.filter(token__in=dead).delete()
    return out


def push_again(pk: int) -> str | None:
    """Push one notification again now (Phone Notify Control): back to waiting, then pushed in this request."""
    from .models import Notification

    Notification.objects.filter(pk=pk).exclude(push_status=SENDING).update(
        push_status="", push_error="", push_tickets="", pushed_at=None
    )
    return push([pk]).get(pk)


# ── the minute sweep ─────────────────────────────────────────────────────────


def sweep(now=None) -> dict:
    """Push whatever is still waiting (the queue was lost to a restart, or a thread died), and close rows stuck in "sending".
    Called every minute by push_delivery_scheduler; returns what it did."""
    from .models import Notification

    now = now or timezone.now()
    stuck = Notification.objects.filter(
        push_status=SENDING, pushed_at__lt=now - STUCK_AFTER, created_at__gte=now - timedelta(days=2)
    ).update(push_status="failed", push_error=INTERRUPTED, pushed_at=now)
    waiting = list(
        Notification.objects.filter(
            push_status="", created_at__gte=now - SWEEP_WINDOW, created_at__lt=now - SWEEP_AFTER
        )
        .order_by("id")
        .values_list("pk", flat=True)[:5000]
    )
    pushed = push(waiting) if waiting else {}
    return {"stuck": stuck, "waiting": len(waiting), "pushed": len(pushed)}
