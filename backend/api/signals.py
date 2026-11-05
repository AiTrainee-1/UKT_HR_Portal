"""
Sends an Expo push notification whenever a Notification row is created,
regardless of which of the ~15 call sites across the codebase created it
(leave approval, salary slip ready, chat message, etc.) -hooking in here via
a signal means none of those call sites needed to change.

Employees with no registered device (PushToken row) are silently skipped —
this only ever augments the existing in-app notification list, never
replaces it, so nothing is lost if a push can't be delivered.
"""

import logging

import requests
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone

from . import mobile_messages, notification_targets, push_receipts
from .models import Notification, PushToken

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
APP_TITLE = "UKTextiles"


def _record(instance: Notification, status: str, error: str = "", tickets: str = "") -> None:
    """What happened to the phone push, kept on the row for the Mobile Messages page. An update, so it never fires this signal.
    `tickets` are Expo's ticket ids: their receipts (push_receipts.py) say later whether Google / Apple accepted the push."""
    Notification.objects.filter(pk=instance.pk).update(
        push_status=status,
        push_error=error[:500],
        push_tickets=tickets,
        pushed_at=timezone.now() if status in ("sent", "failed") else None,
    )


@receiver(post_save, sender=Notification)
def send_push_on_notification(sender, instance: Notification, created: bool, **kwargs) -> None:
    if not created:
        return

    # HR can switch the push off (all of it, or one kind of message) on Mobile App Login -> Mobile Messages; the in-app record stays.
    try:
        if not mobile_messages.push_allowed(instance.source, instance.related_module):
            _record(instance, "off")
            return
    except Exception:
        logger.warning("Could not read the Mobile Messages switches; pushing as usual", exc_info=True)

    tokens = list(instance.employee.push_tokens.values_list("token", flat=True))
    if not tokens:
        _record(instance, "no_device")
        return

    # A notification made from a WhatsApp message has its own headline ("Request Approved"); the older one-liners keep the app name.
    # High priority + the default sound so it shows on the lock screen and rings like a message, not silently in the tray.
    data = _push_data(instance)
    messages = [
        {
            "to": token,
            "title": instance.title or APP_TITLE,
            "body": instance.message,
            "sound": "default",
            "priority": "high",
            "channelId": "default",
            "data": data,
        }
        for token in tokens
    ]
    try:
        resp = requests.post(EXPO_PUSH_URL, json=messages, timeout=(3, 5))  # (connect, read)
        receipts = resp.json().get("data") if resp.ok else None
        _prune_dead_tokens(tokens, receipts)
        errors = [r for r in (receipts or []) if r.get("status") == "error"]
        if not resp.ok:
            _record(instance, "failed", f"Expo answered {resp.status_code}")
        elif receipts and len(errors) == len(receipts):
            _record(instance, "failed", str(errors[0].get("message") or errors[0].get("details") or "Expo refused it"))
        else:
            _record(instance, "sent", tickets=push_receipts.pack(tokens, receipts))
    except Exception as exc:
        # Push delivery is best-effort -the in-app notification (already
        # saved) is the source of truth regardless of whether this succeeds.
        logger.warning("Failed to send push notification for notification id=%s", instance.id, exc_info=True)
        _record(instance, "failed", f"{type(exc).__name__}: {exc}")


def _push_data(instance: Notification) -> dict:
    """What a tap on the push hands the app: the type and the row, plus where its View button leads (notification_targets.py)
    as {kind, id, category} only, to keep the payload small. No `target` key when there is nothing to open."""
    data = {"type": instance.type, "notificationId": instance.id}
    target = notification_targets.target_for(instance)  # never raises
    if target:
        data["target"] = {"kind": target["kind"], "id": target["id"], "category": target["category"]}
    return data


def _prune_dead_tokens(tokens: list[str], receipts) -> None:
    """Expo answers each message in `messages` with a same-index receipt;
    a uninstalled/unregistered device comes back as DeviceNotRegistered —
    that token will never succeed again, so drop it instead of retrying it
    on every future notification indefinitely."""
    if not receipts:
        return
    dead = [
        tokens[i]
        for i, r in enumerate(receipts)
        if i < len(tokens) and r.get("status") == "error" and r.get("details", {}).get("error") == "DeviceNotRegistered"
    ]
    if dead:
        PushToken.objects.filter(token__in=dead).delete()
