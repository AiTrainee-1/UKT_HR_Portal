"""
Sends the phone push whenever a Notification row is created, regardless of which of the call sites across the codebase
created it (leave approval, salary slip ready, chat message, etc.) - hooking in here via a signal means none of those call
sites needed to change.

The push itself lives in push_delivery.py: it runs AFTER the transaction that made the notification commits, on a background
thread, so nothing it does (a failed query, Expo being slow or down) can ever undo or delay the work that made the notification.
Employees with no registered device (PushToken row) are skipped and the row says so - the push only ever augments the in-app
notification list, never replaces it.

A batch made with bulk_create (the chat messages, chat_push.py) sends no post_save: it calls push_delivery.schedule itself.
"""

import logging

import requests  # noqa: F401  (push_delivery calls requests.post; tests patch it as api.signals.requests.post)
from django.db.models.signals import post_save
from django.dispatch import receiver

from . import push_delivery
from .models import Notification

logger = logging.getLogger(__name__)

# kept for older imports
EXPO_PUSH_URL = push_delivery.EXPO_PUSH_URL
APP_TITLE = push_delivery.APP_TITLE


@receiver(post_save, sender=Notification)
def send_push_on_notification(sender, instance: Notification, created: bool, **kwargs) -> None:
    if not created:
        return
    push_delivery.schedule([instance.pk])


def push_notification(instance: Notification) -> str | None:
    """Push one saved notification now and record what happened on the row (Phone Notify Control's "Push again").
    Returns the new push_status."""
    return push_delivery.push_again(instance.pk)
