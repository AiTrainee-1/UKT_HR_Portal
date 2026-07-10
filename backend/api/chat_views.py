"""
Staff Chat (mobile app)
=======================
Two channel types: one company-wide channel everyone can post/read in, and
one channel per Department that only members of that department can access.

Access control is enforced server-side on every read AND write to a
department channel: employee.department_id must equal channel.department_id,
or the request gets 403. This is the one rule that actually keeps one
department's conversation private from another.

No WebSockets — the mobile app polls GET .../messages every ~4s, which is
plenty responsive at this company's scale and needs no extra infrastructure.
"""

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_auth, get_token_employee_id, is_hr
from .models import ChatChannel, ChatMessage, ChatReaction, Employee


def _current_employee(request: Request) -> Employee | None:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None
    return Employee.objects.filter(id=emp_id).select_related("department").first()


def _hr_label(request: Request) -> str:
    """Display name for an HR Portal user (HR Admin / Managing Director / Director)."""
    user = getattr(request, "jwt_user", {}) or {}
    return user.get("name") or "HR"


def _channel_json(c: ChatChannel) -> dict:
    return {
        "id": c.id,
        "type": c.channel_type,
        "departmentId": c.department_id,
        "departmentName": c.department.name if c.department_id and c.department else None,
    }


def _sender_name(m: ChatMessage) -> str:
    if m.sender_id and m.sender:
        return f"{m.sender.first_name} {m.sender.last_name}"
    return m.sender_label or "HR"


def _message_json(m: ChatMessage, viewer_id: int | None) -> dict:
    reply = None
    if m.reply_to_id and m.reply_to:
        reply = {
            "id": m.reply_to_id,
            "senderName": _sender_name(m.reply_to),
            "text": m.reply_to.text,
        }
    reactions_by_emoji: dict[str, dict] = {}
    for r in m.reactions.all():
        entry = reactions_by_emoji.setdefault(r.emoji, {"emoji": r.emoji, "count": 0, "reactedByMe": False})
        entry["count"] += 1
        if viewer_id is not None and r.employee_id == viewer_id:
            entry["reactedByMe"] = True
    return {
        "id": m.id,
        "senderId": m.sender_id,
        "senderName": _sender_name(m),
        # Lets clients style HR/management messages differently
        "isHr": m.sender_id is None,
        "text": m.text,
        "replyTo": reply,
        "reactions": list(reactions_by_emoji.values()),
        "createdAt": m.created_at.isoformat() if m.created_at else None,
    }


def _check_department_access(channel: ChatChannel, emp: Employee) -> bool:
    """A department channel is only visible/writable to members of that department."""
    if channel.channel_type != ChatChannel.CHANNEL_DEPARTMENT:
        return True
    return bool(emp.department_id) and emp.department_id == channel.department_id


@api_view(["GET"])
@require_auth
def chat_channels(request: Request) -> Response:
    """
    Company channel + the caller's own department channel. HR Portal users
    (no Employee row) get the company channel only.
    """
    emp = _current_employee(request)
    if not emp:
        if is_hr(request):
            return Response([_channel_json(ChatChannel.get_company_channel())])
        return Response({"error": "Employee access required"}, status=403)

    channels = [ChatChannel.get_company_channel()]
    if emp.department_id:
        channels.append(ChatChannel.get_department_channel(emp.department))
    return Response([_channel_json(c) for c in channels])


@api_view(["GET", "POST"])
@require_auth
def chat_messages(request: Request, pk: int) -> Response:
    emp = _current_employee(request)
    hr_user = emp is None and is_hr(request)
    if not emp and not hr_user:
        return Response({"error": "Employee access required"}, status=403)

    channel = ChatChannel.objects.select_related("department").filter(pk=pk).first()
    if not channel:
        return Response({"error": "Channel not found"}, status=404)
    if hr_user:
        # HR Portal users participate in the company-wide channel only —
        # department channels stay private to that department's employees.
        if channel.channel_type != ChatChannel.CHANNEL_COMPANY:
            return Response({"error": "HR can only use the company channel"}, status=403)
    elif not _check_department_access(channel, emp):
        return Response({"error": "You are not a member of this department"}, status=403)

    if request.method == "POST":
        text = (request.data.get("text") or "").strip()
        if not text:
            return Response({"error": "text is required"}, status=400)
        reply_to_id = request.data.get("reply_to_id") or request.data.get("replyToId")
        reply_to = None
        if reply_to_id:
            reply_to = ChatMessage.objects.filter(pk=reply_to_id, channel=channel).first()
            if not reply_to:
                return Response({"error": "reply_to_id is not a message in this channel"}, status=400)
        msg = ChatMessage.objects.create(
            channel=channel,
            sender=emp,
            sender_label=_hr_label(request) if hr_user else "",
            text=text,
            reply_to=reply_to,
        )
        msg = ChatMessage.objects.select_related("sender", "reply_to__sender").prefetch_related("reactions").get(pk=msg.pk)
        return Response(_message_json(msg, emp.id if emp else None), status=201)

    try:
        limit = min(int(request.query_params.get("limit", 50)), 200)
    except (TypeError, ValueError):
        limit = 50
    qs = (
        ChatMessage.objects.filter(channel=channel)
        .select_related("sender", "reply_to__sender")
        .prefetch_related("reactions")
        .order_by("-created_at")
    )
    if before := request.query_params.get("before"):
        qs = qs.filter(pk__lt=before)
    if after := request.query_params.get("after"):
        qs = qs.filter(pk__gt=after).order_by("created_at")
        return Response([_message_json(m, emp.id if emp else None) for m in qs])

    messages = list(qs[:limit])
    messages.reverse()
    return Response([_message_json(m, emp.id if emp else None) for m in messages])


@api_view(["POST", "DELETE"])
@require_auth
def chat_message_reactions(request: Request, pk: int) -> Response:
    emp = _current_employee(request)
    if not emp:
        return Response({"error": "Employee access required"}, status=403)

    msg = ChatMessage.objects.select_related("channel__department").filter(pk=pk).first()
    if not msg:
        return Response({"error": "Message not found"}, status=404)
    if not _check_department_access(msg.channel, emp):
        return Response({"error": "You are not a member of this department"}, status=403)

    emoji = (request.data.get("emoji") or "").strip()
    if not emoji:
        return Response({"error": "emoji is required"}, status=400)

    if request.method == "DELETE":
        ChatReaction.objects.filter(message=msg, employee=emp, emoji=emoji).delete()
    else:
        ChatReaction.objects.get_or_create(message=msg, employee=emp, emoji=emoji)

    msg = ChatMessage.objects.select_related("sender", "reply_to__sender").prefetch_related("reactions").get(pk=pk)
    return Response(_message_json(msg, emp.id))
