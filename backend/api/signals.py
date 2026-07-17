"""
Sends an Expo push notification whenever a Notification row is created,
regardless of which of the ~15 call sites across the codebase created it
(leave approval, salary slip ready, chat message, etc.) — hooking in here via
a signal means none of those call sites needed to change.

Employees with no registered device (PushToken row) are silently skipped —
this only ever augments the existing in-app notification list, never
replaces it, so nothing is lost if a push can't be delivered.
"""
import logging

import requests
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Notification

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
APP_TITLE = "UKTextiles"


@receiver(post_save, sender=Notification)
def send_push_on_notification(sender, instance: Notification, created: bool, **kwargs) -> None:
    if not created:
        return

    tokens = list(instance.employee.push_tokens.values_list("token", flat=True))
    if not tokens:
        return

    messages = [
        {"to": token, "title": APP_TITLE, "body": instance.message, "data": {"type": instance.type}}
        for token in tokens
    ]
    try:
        requests.post(EXPO_PUSH_URL, json=messages, timeout=5)
    except Exception:
        # Push delivery is best-effort — the in-app notification (already
        # saved) is the source of truth regardless of whether this succeeds.
        logger.warning("Failed to send push notification for notification id=%s", instance.id, exc_info=True)
