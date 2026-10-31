"""Did the phone push really leave? Expo's receipts.

Sending a push to Expo answers with a TICKET per phone ("ok" only means Expo took the message). A little later the RECEIPT of each
ticket says whether Google (Android) or Apple accepted it for delivery, or why not. The usual reason on Android is that the app was
built without Firebase (FCM) credentials: Expo then answers "InvalidCredentials" in the receipt and nothing ever reaches the
phone, although the ticket was "ok". This reads those receipts, so the Mobile Messages page shows "Delivered to the phone" or "Push
failed" with the reason, instead of a "sent" that never arrived.

`check_pending()` is called when HR opens the Mobile Messages overview or message log (so it costs nothing while nobody looks) and
by the housekeeping sweep; it never raises.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta

import requests
from django.utils import timezone

from .models import Notification, PushToken

logger = logging.getLogger(__name__)

EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
# Expo keeps receipts for 24 hours and asks for a wait of a few minutes after sending; one minute is enough for them to be ready
# in practice and a still-missing receipt is simply asked for again next time.
MIN_AGE = timedelta(minutes=1)
MAX_AGE = timedelta(hours=23)
BATCH = 300
HINTS = {
    "InvalidCredentials": (
        "Expo has no Firebase (FCM) key for this app, so Google refuses the push. Add the Firebase service-account key to the "
        "app's Expo credentials and publish a build made with google-services.json."
    ),
    "DeviceNotRegistered": "The app was uninstalled or its notifications were reset on that phone.",
    "MessageTooBig": "The message is too large for a push.",
    "MessageRateExceeded": "Too many pushes to that phone in a short time.",
    "MismatchSenderId": "The Firebase project of the build does not match the key uploaded to Expo.",
}


def pack(tokens: list[str], receipts) -> str:
    """The [[token, ticket id], ...] to keep on the row, from Expo's answer to the send (same order as the tokens)."""
    pairs = []
    for token, ticket in zip(tokens, receipts or []):
        if isinstance(ticket, dict) and ticket.get("status") == "ok" and ticket.get("id"):
            pairs.append([token, ticket["id"]])
    return json.dumps(pairs) if pairs else ""


def _reason(entry: dict) -> str:
    code = (entry.get("details") or {}).get("error") or ""
    message = str(entry.get("message") or code or "Expo refused it")
    hint = HINTS.get(code)
    return f"{code}: {hint}" if code and hint else message[:300]


def check_pending(limit: int = BATCH) -> int:
    """Read the receipts of pushes sent a minute or more ago and not read yet; returns how many notifications were updated."""
    try:
        now = timezone.now()
        rows = list(
            Notification.objects.filter(
                push_status="sent", pushed_at__lte=now - MIN_AGE, pushed_at__gte=now - MAX_AGE
            ).exclude(push_tickets="")[:limit]
        )
        if not rows:
            return 0
        ticket_of: dict[str, tuple[Notification, str]] = {}
        for n in rows:
            for token, ticket in json.loads(n.push_tickets or "[]"):
                ticket_of[ticket] = (n, token)
        if not ticket_of:
            return 0
        resp = requests.post(EXPO_RECEIPTS_URL, json={"ids": list(ticket_of)}, timeout=5)
        if not resp.ok:
            return 0
        receipts = (resp.json() or {}).get("data") or {}
        outcome: dict[int, dict] = {n.pk: {"ready": 0, "total": 0, "errors": []} for n in rows}
        dead_tokens: list[str] = []
        for ticket, (n, token) in ticket_of.items():
            out = outcome[n.pk]
            out["total"] += 1
            entry = receipts.get(ticket)
            if not isinstance(entry, dict):
                continue  # not ready yet: asked for again next time
            out["ready"] += 1
            if entry.get("status") == "error":
                out["errors"].append(entry)
                if (entry.get("details") or {}).get("error") == "DeviceNotRegistered":
                    dead_tokens.append(token)
        updated = 0
        for n in rows:
            out = outcome[n.pk]
            if out["ready"] < out["total"]:
                continue
            if out["errors"] and len(out["errors"]) == out["total"]:
                Notification.objects.filter(pk=n.pk).update(
                    push_status="failed", push_error=_reason(out["errors"][0])[:500], push_tickets=""
                )
            else:
                Notification.objects.filter(pk=n.pk).update(push_status="delivered", push_error="", push_tickets="")
            updated += 1
        if dead_tokens:
            PushToken.objects.filter(token__in=dead_tokens).delete()
        return updated
    except Exception:
        logger.warning("Could not read the Expo push receipts", exc_info=True)
        return 0
