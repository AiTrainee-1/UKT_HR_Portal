"""Every WhatsApp message the HRMS sends is also a phone notification and an in-app record.

    HRMS module -> whatsapp_service.send_notification / send_document -> push_messages.announce -> Notification row
                                                                       -> (signals.py) Expo push to the employee's phones

`announce` takes the very text the WhatsApp message carries (HR's saved wording, else the default, with the same variables) and
saves it as a Notification: the row IS the notification page of the mobile app, and creating it is what sends the push
(signals.send_push_on_notification). So the phone shows what WhatsApp shows, and nothing has to be told twice.

    * One-time codes (login, password reset, activation) are NEVER announced: they are secrets, and a lock-screen
      notification or a stored history row would leak them.
    * It does not depend on WhatsApp being configured, connected or switched on for that message on the WhatsApp Control page:
      those switches are about the WhatsApp channel. (The attendance alert job still only runs while WhatsApp alerts are on:
      that job is what decides an alert is due.)
    * It is exactly-once per employee when the caller gives the same `dedupe_key` the WhatsApp message uses.
    * It never raises: a notification that cannot be saved must not stop the approval, the gate scan or the document it is about.

A decision that only passes a request on to the next approver has no WhatsApp message; its short in-app notice is still made
where the decision is taken (approval_workflow.stage_notice). Only final approvals and rejections use this module, so an
employee never gets the same event twice.
"""

from __future__ import annotations

import logging
import re

from django.db import IntegrityError, transaction

from . import whatsapp_catalog as catalog

logger = logging.getLogger(__name__)

# The WhatsApp messages that carry a secret: never a notification.
EXCLUDED_TYPES = frozenset({"otp_login", "otp_reset", "otp_activate"})

# The `type` the mobile list uses for its icon and colour, where it differs from the workflow's own key.
_APPROVAL_TYPE = {"attendance_correction": "attendance", "holiday_work": "compensation", "request": "employee_request"}

# The sign-off lines of the WhatsApp wording: a phone notification does not need them. ("- UK Textiles HR" is the
# sign-off of the default wordings since 2026-11-06; the others are HR's older saved wording.)
_SIGN_OFFS = ("uk textiles hrms", "uk textile hrms", "- uk textiles hr", "thank you,", "regards,")

_BOLD = re.compile(r"(?<!\w)\*([^*\n]+)\*(?!\w)")
_HEADER = re.compile(r"^\W*\*([^*\n]+)\*")


def notification_type(document_type: str, related_module: str = "") -> str:
    """The Notification.type of a message: what the mobile app's list groups and styles it by."""
    t = catalog.get(document_type)
    module = t.module if t else "other"
    if module == "approvals":
        return _APPROVAL_TYPE.get(related_module, related_module or "approval")
    if module == "geo":
        return "on_duty"
    if module == "documents":
        return document_type
    return module


def _plain(line: str) -> str:
    """WhatsApp's *bold* marks removed: a notification does not render them."""
    return _BOLD.sub(r"\1", line)


def split_message(text: str, fallback_title: str) -> tuple[str, str]:
    """(title, body) of a WhatsApp text. The title is the bold first line ("✅ Request Approved"); a message that does not open
    with one (a punch reminder opens with a greeting) takes `fallback_title`. The sign-off is dropped; the bold marks too."""
    lines = [line.rstrip() for line in (text or "").splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    # "Thank you,\nUK Textiles HRMS": drop the sign-off from the bottom, one line at a time
    while lines and (not lines[-1].strip() or lines[-1].strip().lower() in _SIGN_OFFS):
        lines.pop()
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    title = fallback_title
    if first is not None and _HEADER.match(lines[first].strip()):
        title = _plain(lines[first]).strip()
        lines = lines[first + 1 :]
    body = re.sub(r"\n{3,}", "\n\n", _plain("\n".join(lines))).strip()
    return title, body or title


def announce(employee, document_type: str, text: str, *, related_module: str = "", dedupe_key: str = ""):
    """Save the notification for a WhatsApp message (which sends the push). Returns the Notification, or None when it was not
    made: a one-time code, no text, not an employee, or already announced under this `dedupe_key`."""
    try:
        if document_type in EXCLUDED_TYPES or not (text or "").strip():
            return None
        from .models import Employee, Notification

        if not isinstance(employee, Employee):
            return None
        t = catalog.get(document_type)
        title, body = split_message(text, t.label if t else "UKTextiles")
        try:
            with transaction.atomic():
                return Notification.objects.create(
                    employee=employee,
                    type=notification_type(document_type, related_module),
                    title=title,
                    message=body,
                    source=document_type,
                    related_module=related_module,
                    dedupe_key=f"wa:{dedupe_key}"[:160] if dedupe_key else "",
                )
        except IntegrityError:
            return None  # already announced
    except Exception:
        logger.exception("Could not announce the %s message as a notification", document_type)
        return None
