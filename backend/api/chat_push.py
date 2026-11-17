"""Internal chat -> phone notifications (owner 2026-11-17: every public chat message reaches the employees' phones).

    HR chat page / mobile app / Attendance Notify -> ChatMessage -> message_posted(id) -> on commit, background thread
        -> one Notification per reader with a registered phone (bulk) -> push_delivery.push -> Expo -> FCM

Who is told: the people who can read the channel, exactly as chat_views lets them read it.
  * a branch's company channel: every active employee of that branch;
  * the unbranched company channel (an unscoped HR admin's first channel, and the pre-branch history): the active employees
    with no branch, the only employees whose app shows it. HR reaches everybody with "Send to all branches" on the HR chat page,
    which posts the message in every branch's company channel too (chat_views);
  * a department channel: the active employees of that department.
The writer is never told about their own message. Someone whose own message was replied to gets "X replied to you" instead of
the plain message (KIND_REPLY), when that switch is on.

Only readers with a registered phone get a row: the chat itself is the in-app record, so a row for an employee who cannot
receive the push would only fill their notification list. A muted employee (PushOptOut) and a switched-off kind make no row
either. Each reader gets each message once: the row's dedupe key is "chat:<message id>" (unique per employee).
"""

from __future__ import annotations

import logging
import threading

from django.db import close_old_connections, connections, transaction

from . import mobile_messages, push_delivery

logger = logging.getLogger(__name__)

KIND_ANNOUNCEMENT = "chat_announcement"  # HR / MD / Director (an HR Portal user) in a company channel
KIND_MESSAGE = "chat_message"  # an employee in a company channel
KIND_DEPARTMENT = "chat_department"  # anybody in a department channel
KIND_REPLY = "chat_reply"  # somebody replied to your message
KIND_REPORT = "chat_report"  # Attendance Notify's report card
KINDS = (KIND_ANNOUNCEMENT, KIND_MESSAGE, KIND_DEPARTMENT, KIND_REPLY, KIND_REPORT)
NOTIFICATION_TYPE = "chat"  # notification_targets: opens the chat
MAX_BODY = 240


def dedupe_key(message_id: int) -> str:
    return f"chat:{message_id}"


def kind_of(msg) -> str:
    from .models import ChatChannel

    if isinstance(msg.payload, dict) and msg.payload.get("kind") == "attendance_report":
        return KIND_REPORT
    if msg.channel.channel_type == ChatChannel.CHANNEL_DEPARTMENT:
        return KIND_DEPARTMENT
    return KIND_ANNOUNCEMENT if msg.sender_id is None else KIND_MESSAGE


def readers(channel):
    """The active employees who can read this channel (chat_views' rules)."""
    from .models import ChatChannel, Employee

    qs = Employee.objects.filter(status="active")
    qs = qs.filter(branch_id=channel.branch_id) if channel.branch_id else qs.filter(branch__isnull=True)
    if channel.channel_type == ChatChannel.CHANNEL_DEPARTMENT:
        qs = qs.filter(department_id=channel.department_id)
    return qs


def _sender_name(msg) -> str:
    if msg.sender_id and msg.sender:
        return f"{msg.sender.first_name} {msg.sender.last_name}".strip() or "A colleague"
    return msg.sender_label or "HR"


def _where(msg) -> str:
    from .models import ChatChannel

    if msg.channel.channel_type == ChatChannel.CHANNEL_DEPARTMENT and msg.channel.department_id:
        return f"{msg.channel.department.name} chat"
    return "Company chat"


def _clip(text: str) -> str:
    text = (text or "").strip()
    return text if len(text) <= MAX_BODY else text[: MAX_BODY - 1].rstrip() + "…"


def content(msg, kind: str) -> tuple[str, str]:
    """(title, body) of the phone notification for this message."""
    if kind == KIND_REPORT:
        lines = [line.strip() for line in (msg.text or "").splitlines() if line.strip()]
        title = lines[0] if lines else "Attendance report"
        return title[:120], _clip("\n".join(lines[1:7]))
    name = _sender_name(msg)
    title = f"{name} replied to you" if kind == KIND_REPLY else f"{name} in {_where(msg)}"
    return title[:120], _clip(msg.text)


def announce(message_id: int) -> list[int]:
    """Make the phone notifications of one chat message and push them; returns the notification ids. Safe to call twice."""
    from .models import ChatMessage, Notification

    msg = ChatMessage.objects.select_related("channel__department", "sender", "reply_to").filter(pk=message_id).first()
    if msg is None:
        return []
    master, off = mobile_messages.switches()
    if not master:
        return []
    kind = kind_of(msg)
    people = set(readers(msg.channel).filter(push_tokens__isnull=False).values_list("id", flat=True).distinct())
    people.discard(msg.sender_id)
    people -= mobile_messages.muted_employee_ids(people)
    if not people:
        return []

    replied_to = msg.reply_to.sender_id if msg.reply_to_id and msg.reply_to else None
    reply_goes = replied_to in people and KIND_REPLY not in off
    key = dedupe_key(msg.pk)
    rows = []
    for emp_id in sorted(people):
        this_kind = KIND_REPLY if reply_goes and emp_id == replied_to else kind
        if this_kind in off:
            continue
        title, body = content(msg, this_kind)
        rows.append(
            Notification(
                employee_id=emp_id,
                type=NOTIFICATION_TYPE,
                title=title,
                message=body,
                source=this_kind,
                dedupe_key=key,
            )
        )
    if not rows:
        return []
    # bulk_create sends no post_save, so the push is started here, once for the whole batch
    Notification.objects.bulk_create(rows, batch_size=500, ignore_conflicts=True)
    ids = list(
        Notification.objects.filter(dedupe_key=key, employee_id__in=[r.employee_id for r in rows], push_status="")
        .order_by("id")
        .values_list("pk", flat=True)
    )
    push_delivery.push(ids)
    return ids


def message_posted(message_id: int) -> None:
    """Called where a chat message is saved: its phone notifications are made and pushed once the transaction commits, on a
    background thread (a message to a whole branch must not hold up the person who wrote it). Inline under the test runner.
    Never raises."""
    if push_delivery.inline_mode():
        try:
            with transaction.atomic():
                announce(message_id)
        except Exception:
            logger.exception("Could not notify phones about chat message %s", message_id)
        return

    def runner() -> None:
        try:
            close_old_connections()
            announce(message_id)
        except Exception:
            logger.exception("Could not notify phones about chat message %s", message_id)
        finally:
            connections.close_all()

    transaction.on_commit(
        lambda: threading.Thread(target=runner, name=f"chat-push-{message_id}", daemon=True).start(), robust=True
    )
