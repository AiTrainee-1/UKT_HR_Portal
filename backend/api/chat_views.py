"""
Staff Chat (mobile app)
=======================
Two channel types: one company-wide channel everyone can post/read in, and
one channel per Department that only members of that department can access.

Access control is enforced server-side on every read AND write to a
department channel: employee.department_id must equal channel.department_id,
or the request gets 403. This is the one rule that actually keeps one
department's conversation private from another.

No WebSockets -the mobile app polls GET .../messages every ~4s, which is
plenty responsive at this company's scale and needs no extra infrastructure.

Every message also reaches the phones of the people who can read the channel
(chat_push.py, 2026-11-17). An unscoped HR admin can tick "Send to all
branches": the message is then posted in every company channel (each branch's
and the unbranched one), so every employee reads it in their own channel and
gets one phone notification.

GIFs and voice messages (owner 2026-11-25, chat_media.py): POST
chat/channels/<id>/media uploads one, GET chat/messages/<id>/media serves it to
members of the channel only (never a public link) until it expires after
ChatSettings.media_expiry_days (HR sets it: GET/PUT chat/settings). Each
reaction now also says who reacted (`people`), so the app can show who reacted
with what; GET chat/messages/<id>/reactions returns the same list on its own.
"""

from datetime import timedelta

from django.db import transaction
from django.db.models import Prefetch
from django.http import FileResponse
from django.utils import timezone
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from . import chat_media
from .auth import get_hr_display_name, get_token_employee_id, is_hr, require_auth, require_hr
from .branch_scope import get_branch_scope
from .models import ChatChannel, ChatMessage, ChatReaction, ChatSettings, Employee


def _current_employee(request: Request) -> Employee | None:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None
    return Employee.objects.filter(id=emp_id).select_related("department").first()


def _hr_label(request: Request) -> str:
    """Display name for an HR Portal user (HR Admin / Managing Director / Director)."""
    user = getattr(request, "jwt_user", {}) or {}
    return user.get("name") or "HR"


def _channel_json(c: ChatChannel, media_expiry_days: int | None = None) -> dict:
    branch = c.branch.name if c.branch_id and c.branch else None
    if c.channel_type == ChatChannel.CHANNEL_DEPARTMENT:
        name = c.department.name if c.department_id and c.department else "Department"
    else:
        name = f"Company – {branch}" if branch else "Company (no branch)"
    body = {
        "id": c.id,
        "type": c.channel_type,
        "departmentId": c.department_id,
        "departmentName": c.department.name if c.department_id and c.department else None,
        # additive (2026-11-17): the HR chat page names the channels it can switch between
        "name": name,
        "branchId": c.branch_id,
        "branchName": branch,
    }
    if media_expiry_days is not None:
        # additive (2026-11-25): how many days GIFs and voice messages stay, so the app can say so
        body["mediaExpiryDays"] = media_expiry_days
    return body


def _sender_name(m: ChatMessage) -> str:
    if m.sender_id and m.sender:
        return f"{m.sender.first_name} {m.sender.last_name}"
    return m.sender_label or "HR"


def _person_name(emp: Employee | None) -> str:
    if emp is None:
        return "A colleague"
    return f"{emp.first_name} {emp.last_name}".strip() or "A colleague"


def _reactions_json(reactions, viewer_id: int | None) -> list[dict]:
    """Reactions grouped by emoji, in the order they were first used, each with who reacted (owner 2026-11-25: people
    can check who reacted with what). `count` and `reactedByMe` are as before, so older apps read them unchanged."""
    by_emoji: dict[str, dict] = {}
    for r in sorted(reactions, key=lambda x: (x.created_at or timezone.now(), x.pk or 0)):
        entry = by_emoji.setdefault(r.emoji, {"emoji": r.emoji, "count": 0, "reactedByMe": False, "people": []})
        entry["count"] += 1
        mine = viewer_id is not None and r.employee_id == viewer_id
        if mine:
            entry["reactedByMe"] = True
        entry["people"].append({"employeeId": r.employee_id, "name": _person_name(r.employee), "isMe": mine})
    for entry in by_emoji.values():
        entry["people"].sort(key=lambda p: (not p["isMe"],))  # you first, then in the order they reacted
    return list(by_emoji.values())


def _message_json(m: ChatMessage, viewer_id: int | None, now=None) -> dict:
    reply = None
    if m.reply_to_id and m.reply_to:
        reply = {
            "id": m.reply_to_id,
            "senderName": _sender_name(m.reply_to),
            "text": chat_media.preview_text(m.reply_to),
            # additive (2026-11-25): "text" / "gif" / "voice", so the quote can show an icon
            "kind": m.reply_to.kind or ChatMessage.KIND_TEXT,
        }
    return {
        "id": m.id,
        "senderId": m.sender_id,
        "senderName": _sender_name(m),
        # Lets clients style HR/management messages differently
        "isHr": m.sender_id is None,
        "text": m.text,
        "replyTo": reply,
        "reactions": _reactions_json(m.reactions.all(), viewer_id),
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        # Attendance Notify's report card (2026-11-17): null for a typed message. The photos are signed links made now.
        "report": _report_json(m.payload),
        # GIFs and voice messages (2026-11-25): "text" for every typed message; `media` is null for those
        "kind": m.kind or ChatMessage.KIND_TEXT,
        "media": chat_media.media_json(m, now),
    }


def _messages_qs():
    """Messages with everything _message_json reads, in a fixed number of queries."""
    reactions = ChatReaction.objects.select_related("employee").only(
        "id", "message_id", "emoji", "created_at", "employee_id", "employee__first_name", "employee__last_name"
    )
    return ChatMessage.objects.select_related("sender", "reply_to__sender").prefetch_related(
        Prefetch("reactions", queryset=reactions)
    )


def _report_json(payload) -> dict | None:
    if not isinstance(payload, dict) or payload.get("kind") != "attendance_report":
        return None
    from .employee_photo import photo_links

    rows = payload.get("rows") or []
    links = photo_links([r.get("employeeId") for r in rows]) if payload.get("includePhotos") else {}
    return {**payload, "rows": [{**r, "photoUrl": links.get(r.get("employeeId"))} for r in rows]}


def _check_department_access(channel: ChatChannel, emp: Employee) -> bool:
    """A department channel is only visible/writable to members of that department."""
    if channel.channel_type != ChatChannel.CHANNEL_DEPARTMENT:
        return True
    return bool(emp.department_id) and emp.department_id == channel.department_id


def _channel_denial(request: Request, channel: ChatChannel, emp: Employee | None, hr_user: bool) -> Response | None:
    """None when the caller may read (and write in) this channel; otherwise the answer to send. The one rule every chat
    endpoint uses, so a message, a reaction list and a GIF / voice file are guarded alike."""
    # Reading a channel by id must respect the same branch boundary the
    # channel list does, or the isolation is only skin-deep: guessing an id
    # would expose another unit's conversation. An unscoped admin (viewer
    # branch None) is limited to unbranched channels, which is what they see
    # in the list too.
    viewer_branch = emp.branch_id if emp else get_branch_scope(request)
    # an unscoped HR admin may open every branch's company channel (they are listed for them, see chat_channels)
    admin_company = hr_user and viewer_branch is None and channel.channel_type == ChatChannel.CHANNEL_COMPANY
    if channel.branch_id != viewer_branch and not admin_company:
        return Response({"error": "Channel not found"}, status=404)
    if hr_user:
        # HR Portal users participate in the company-wide channel only —
        # department channels stay private to that department's employees.
        if channel.channel_type != ChatChannel.CHANNEL_COMPANY:
            return Response({"error": "HR can only use the company channel"}, status=403)
    elif not _check_department_access(channel, emp):
        return Response({"error": "You are not a member of this department"}, status=403)
    return None


@api_view(["GET"])
@require_auth
def chat_channels(request: Request) -> Response:
    """
    Company channel + the caller's own department channel. HR Portal users
    (no Employee row) get the company channel only.
    """
    days = ChatSettings.get().media_expiry_days
    emp = _current_employee(request)
    if not emp:
        if is_hr(request):
            # An HR user's company channel is their branch's. An unscoped
            # admin gets the original unbranched channel, which is where
            # every pre-branch message still lives -first, so a client that
            # takes the first company channel opens it as before- and then
            # (2026-11-17) every branch's company channel, which is where the
            # employees of that branch talk and where Attendance Notify posts
            # its reports for them.
            branch_id = get_branch_scope(request)
            channels = [ChatChannel.get_company_channel(branch_id)]
            if branch_id is None:
                from .models import Branch

                for b in Branch.objects.filter(is_active=True).order_by("name"):
                    channels.append(ChatChannel.get_company_channel(b.pk))
            return Response([_channel_json(c, days) for c in channels])
        return Response({"error": "Employee access required"}, status=403)

    # For an employee the branch comes from their own record, not the
    # request -employees are never branch-scoped by middleware.
    channels = [ChatChannel.get_company_channel(emp.branch_id)]
    if emp.department_id:
        channels.append(ChatChannel.get_department_channel(emp.department))
    return Response([_channel_json(c, days) for c in channels])


def _reply_target(request: Request, channel: ChatChannel):
    """(message replied to or None, error Response or None) from reply_to_id / replyToId."""
    reply_to_id = request.data.get("reply_to_id") or request.data.get("replyToId")
    if not reply_to_id:
        return None, None
    try:
        reply_pk = int(reply_to_id)
    except (TypeError, ValueError):
        reply_pk = None
    reply_to = ChatMessage.objects.filter(pk=reply_pk, channel=channel).first() if reply_pk else None
    if not reply_to:
        return None, Response({"error": "reply_to_id is not a message in this channel"}, status=400)
    return reply_to, None


@api_view(["GET", "POST"])
@require_auth
def chat_messages(request: Request, pk: int) -> Response:
    emp = _current_employee(request)
    hr_user = emp is None and is_hr(request)
    if not emp and not hr_user:
        return Response({"error": "Employee access required"}, status=403)

    channel = ChatChannel.objects.select_related("department", "branch").filter(pk=pk).first()
    if not channel:
        return Response({"error": "Channel not found"}, status=404)
    denial = _channel_denial(request, channel, emp, hr_user)
    if denial is not None:
        return denial
    viewer_branch = emp.branch_id if emp else get_branch_scope(request)

    if request.method == "POST":
        text = (request.data.get("text") or "").strip()
        if not text:
            return Response({"error": "text is required"}, status=400)
        reply_to, bad = _reply_target(request, channel)
        if bad is not None:
            return bad
        all_branches = request.data.get("allBranches") is True
        if all_branches and not (
            hr_user and viewer_branch is None and channel.channel_type == ChatChannel.CHANNEL_COMPANY
        ):
            return Response(
                {"error": "Only an HR account that sees every branch can send a message to all branches."}, status=400
            )
        from . import chat_push

        label = _hr_label(request) if hr_user else ""
        msg = ChatMessage.objects.create(
            channel=channel,
            sender=emp,
            sender_label=label,
            text=text,
            reply_to=reply_to,
        )
        chat_push.message_posted(msg.pk)  # the readers' phones, after the commit
        also = 0
        if all_branches:
            from .models import Branch

            others = [ChatChannel.get_company_channel(None)] + [
                ChatChannel.get_company_channel(b.pk) for b in Branch.objects.filter(is_active=True).order_by("name")
            ]
            for other in others:
                if other.pk == channel.pk:
                    continue
                copy = ChatMessage.objects.create(channel=other, sender=None, sender_label=label, text=text)
                chat_push.message_posted(copy.pk)
                also += 1
        msg = _messages_qs().get(pk=msg.pk)
        body = _message_json(msg, emp.id if emp else None)
        if all_branches:
            body["alsoPostedIn"] = also  # additive: how many other company channels got the same message
        return Response(body, status=201)

    try:
        limit = min(int(request.query_params.get("limit", 50)), 200)
    except (TypeError, ValueError):
        limit = 50
    qs = _messages_qs().filter(channel=channel).order_by("-created_at")
    if before := request.query_params.get("before"):
        qs = qs.filter(pk__lt=before)
    now = timezone.now()
    if after := request.query_params.get("after"):
        qs = qs.filter(pk__gt=after).order_by("created_at")
        return Response([_message_json(m, emp.id if emp else None, now) for m in qs])

    messages = list(qs[:limit])
    messages.reverse()
    return Response([_message_json(m, emp.id if emp else None, now) for m in messages])


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_auth
def chat_media_upload(request: Request, pk: int) -> Response:
    """
    POST chat/channels/<id>/media (multipart) -a GIF from the phone's gallery or a voice message recorded in the app.
      kind        "gif" | "voice"
      file        the GIF (image/gif, at most 8 MB) or the recording (.m4a / AAC from the phone, WebM / Ogg Opus from
                  a browser; at most 2 minutes)
      durationMs  the recording's length as the phone measured it (the file's own length wins when it states one)
      waveform    optional: up to 64 loudness bars 0-100, as JSON ("[3,40,…]") or "3,40,…"
      replyToId   optional, as for a text message
    201 with the message (kind, media {url, mime, size, durationMs, width, height, waveform, expiresAt, expired}).
    400 {error, code} for a file the chat does not take. Employees only: the HR page posts text.
    """
    emp = _current_employee(request)
    if not emp:
        return Response({"error": "Employee access required"}, status=403)
    channel = ChatChannel.objects.select_related("department", "branch").filter(pk=pk).first()
    if not channel:
        return Response({"error": "Channel not found"}, status=404)
    denial = _channel_denial(request, channel, emp, False)
    if denial is not None:
        return denial

    data = request.data
    try:
        info = chat_media.read_upload(
            data.get("kind"),
            request.FILES.get("file"),
            data.get("durationMs") or data.get("duration_ms"),
            data.get("waveform"),
        )
    except chat_media.MediaError as e:
        return Response({"error": e.message, "code": e.code}, status=400)
    reply_to, bad = _reply_target(request, channel)
    if bad is not None:
        return bad

    from django.core.files.base import ContentFile

    from . import chat_push

    now = timezone.now()
    with transaction.atomic():
        msg = ChatMessage(
            channel=channel,
            sender=emp,
            text=info["text"],
            reply_to=reply_to,
            kind=info["kind"],
            media_size=info["size"],
            media_duration_ms=info["durationMs"],
            media_width=info["width"],
            media_height=info["height"],
            media_waveform=info["waveform"],
            expires_at=now + timedelta(days=chat_media.expiry_days()),
        )
        msg.media.save(chat_media.file_name(info), ContentFile(info["data"]), save=False)
        msg.media_mime = chat_media.stored_mime(info, msg.media.name)
        msg.save()
        chat_push.message_posted(msg.pk)  # "🎤 Voice message" / "🖼️ GIF" on the readers' phones, after the commit
    msg = _messages_qs().get(pk=msg.pk)
    return Response(_message_json(msg, emp.id, now), status=201)


@api_view(["GET"])
@require_auth
def chat_message_media(request: Request, pk: int):
    """
    GET chat/messages/<id>/media -the GIF / voice file, to members of the message's channel only (the same rule as
    reading the channel). 410 {code: MEDIA_EXPIRED} once it has expired (the file is deleted then, if the sweep has not
    done it yet); 404 for a text message or one the caller cannot read.
    """
    emp = _current_employee(request)
    hr_user = emp is None and is_hr(request)
    if not emp and not hr_user:
        return Response({"error": "Employee access required"}, status=403)
    msg = ChatMessage.objects.select_related("channel__department", "channel__branch").filter(pk=pk).first()
    if not msg:
        return Response({"error": "Message not found"}, status=404)
    denial = _channel_denial(request, msg.channel, emp, hr_user)
    if denial is not None:
        return denial
    if not chat_media.is_media(msg):
        return Response({"error": "This message has no file"}, status=404)
    now = timezone.now()
    if chat_media.is_expired(msg, now):
        if msg.media_deleted_at is None or msg.media:
            chat_media.delete_media(msg, now)  # lazy enforcement: an expired file never outlives its first request
        return Response({"error": "This has expired and is no longer available.", "code": "MEDIA_EXPIRED"}, status=410)
    try:
        handle = msg.media.open("rb")
    except (FileNotFoundError, OSError):
        chat_media.delete_media(msg, now)
        return Response({"error": "This is no longer available.", "code": "MEDIA_EXPIRED"}, status=410)
    ext = (msg.media.name.rsplit(".", 1)[-1] if "." in msg.media.name else "bin").lower()
    response = FileResponse(handle, content_type=msg.media_mime or "application/octet-stream")
    response["Content-Disposition"] = f'inline; filename="{msg.kind}-{msg.pk}.{ext}"'
    # it disappears at expiry: no shared or long-lived copies along the way
    response["Cache-Control"] = "private, no-store"
    if msg.expires_at:
        response["X-Expires-At"] = msg.expires_at.isoformat()
    return response


@api_view(["GET", "POST", "DELETE"])
@require_auth
def chat_message_reactions(request: Request, pk: int) -> Response:
    emp = _current_employee(request)
    if request.method == "GET":
        # who reacted with what (owner 2026-11-25): anybody who can read the channel
        hr_user = emp is None and is_hr(request)
        if not emp and not hr_user:
            return Response({"error": "Employee access required"}, status=403)
        msg = ChatMessage.objects.select_related("channel__department", "channel__branch").filter(pk=pk).first()
        if not msg:
            return Response({"error": "Message not found"}, status=404)
        denial = _channel_denial(request, msg.channel, emp, hr_user)
        if denial is not None:
            return denial
        msg = _messages_qs().get(pk=pk)
        return Response({"messageId": msg.pk, "reactions": _reactions_json(msg.reactions.all(), emp.id if emp else None)})

    if not emp:
        return Response({"error": "Employee access required"}, status=403)

    msg = ChatMessage.objects.select_related("channel__department").filter(pk=pk).first()
    if not msg:
        return Response({"error": "Message not found"}, status=404)
    if msg.channel.branch_id != emp.branch_id:
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

    msg = _messages_qs().get(pk=pk)
    return Response(_message_json(msg, emp.id))


def _settings_json(s: ChatSettings) -> dict:
    return {
        "mediaExpiryDays": s.media_expiry_days,
        "minDays": ChatSettings.MEDIA_EXPIRY_MIN,
        "maxDays": ChatSettings.MEDIA_EXPIRY_MAX,
        "defaultDays": ChatSettings.MEDIA_EXPIRY_DEFAULT,
        "updatedBy": s.updated_by or None,
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_hr
def chat_settings(request: Request) -> Response:
    """
    GET/PUT chat/settings (HR; the "chat" permission: view to read, edit to change) -how many days GIFs and voice
    messages stay in the chat (owner 2026-11-25: 7 by default, HR can choose 1-90). A change applies to every GIF /
    voice message still on the server too: each now expires that many days after it was sent, and any that are already
    past it are deleted straight away.
    PUT {mediaExpiryDays: 1-90} -> the settings; 400 {error} for anything else.
    """
    s = ChatSettings.get()
    if request.method == "PUT":
        raw = request.data.get("mediaExpiryDays", request.data.get("media_expiry_days"))
        days = None
        if not isinstance(raw, bool):
            try:
                as_float = float(raw)
                if as_float == int(as_float):
                    days = int(as_float)
            except (TypeError, ValueError, OverflowError):
                days = None
        lo, hi = ChatSettings.MEDIA_EXPIRY_MIN, ChatSettings.MEDIA_EXPIRY_MAX
        if days is None or not lo <= days <= hi:
            return Response({"error": f"Choose a whole number of days from {lo} to {hi}."}, status=400)
        if days != s.media_expiry_days:
            s.media_expiry_days = days
            s.updated_by = get_hr_display_name(request)
            s.save()
            chat_media.apply_expiry_days(days)
            chat_media.sweep_expired()
    return Response(_settings_json(s))
