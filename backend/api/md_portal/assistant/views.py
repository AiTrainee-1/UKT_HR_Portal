"""REST API of the assistant, mounted at /api/md/assistant/. Every view is behind @require_md.

These views write only the assistant's own bookkeeping (its conversations and messages); company data is only ever read,
and only through the read-only tools in engine.py.
"""

from __future__ import annotations

import os

from django.db import transaction
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from ...auth import require_md
from ...clock import FACTORY_TZ
from ...models import MdAssistantSettings, MdConversation, MdMessage
from . import engine, jobs
from .gemini import GeminiError

QUESTION_MAX = engine.QUESTION_LIMIT
MAX_AUDIO_BYTES = 8 * 1024 * 1024
CONTEXT_TEXT_MAX = 200
CONVERSATION_LIST_LIMIT = 30
MESSAGE_LIMIT = 60


def iso(dt) -> str | None:
    if dt is None:
        return None
    from django.utils import timezone

    return timezone.localtime(dt, FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def message_json(m: MdMessage) -> dict:
    return {
        "id": m.id,
        "conversationId": m.conversation_id,
        "role": m.role,
        "status": m.status,
        "content": m.content,
        "payload": m.payload or {},
        "error": m.error,
        "inputMode": m.input_mode,
        "language": m.language,
        "createdAt": iso(m.created_at),
        "finishedAt": iso(m.finished_at),
    }


def conversation_json(c: MdConversation, count: int | None = None) -> dict:
    out = {
        "id": c.id,
        "title": c.title or "New conversation",
        "updatedAt": iso(c.updated_at),
        "createdAt": iso(c.created_at),
    }
    if count is not None:
        out["messages"] = count
    return out


VOICE_LANGUAGES = ("en-IN", "ta-IN", "hi-IN", "other")
VOICE_ENGINES = ("browser", "server")


def _clean_voice(raw) -> dict:
    """What the browser says about a spoken question (how it was heard): small and fixed in shape, shown under the
    question ("Heard in English, 93% sure")."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    if raw.get("language") in VOICE_LANGUAGES:
        out["language"] = raw["language"]
    if raw.get("engine") in VOICE_ENGINES:
        out["engine"] = raw["engine"]
    confidence = raw.get("confidence")
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and 0 <= confidence <= 1:
        out["confidence"] = round(float(confidence), 2)
    return out


def _clean_context(raw) -> dict | None:
    """The page context the browser sends (what the MD is looking at): small, plain values only."""
    if not isinstance(raw, dict):
        return None

    def scalars(value, limit):
        if not isinstance(value, dict):
            return {}
        return {
            str(k)[:60]: (v if isinstance(v, (int, float)) else str(v)[:CONTEXT_TEXT_MAX])
            for k, v in list(value.items())[:limit]
            if v is not None
        }

    return {
        "page": str(raw.get("page") or "")[:40],
        "title": str(raw.get("title") or "")[:80],
        "filters": scalars(raw.get("filters"), 12),
        "summary": scalars(raw.get("summary"), 16),
    }


@api_view(["GET"])
@require_md
def status(request: Request) -> Response:
    """Is the assistant usable, how is it set up, and how much of today's free allowance is gone."""
    settings = MdAssistantSettings.load()
    configured = bool(os.environ.get("GEMINI_API_KEY"))
    return Response(
        {
            "enabled": settings.enabled,
            "configured": configured,
            "ready": settings.enabled and configured,
            "model": settings.model,
            "privacyMode": settings.privacy_mode,
            "usage": engine.usage_today(),
            "voice": {"serverTranscription": configured and settings.enabled},
            "limits": {"questionChars": QUESTION_MAX},
        }
    )


@api_view(["GET", "DELETE"])
@require_md
def conversations(request: Request) -> Response:
    md = request.md_user
    if request.method == "DELETE":
        MdConversation.objects.filter(user=md).delete()
        return Response(status=204)
    rows = MdConversation.objects.filter(user=md).order_by("-updated_at")[:CONVERSATION_LIST_LIMIT]
    return Response({"conversations": [conversation_json(c) for c in rows]})


@api_view(["GET", "DELETE"])
@require_md
def conversation_detail(request: Request, pk: int) -> Response:
    conversation = MdConversation.objects.filter(pk=pk, user=request.md_user).first()
    if conversation is None:
        return Response({"error": "No such conversation."}, status=404)
    if request.method == "DELETE":
        conversation.delete()
        return Response(status=204)
    messages = [engine.expire_if_stale(m) for m in conversation.messages.order_by("-id")[:MESSAGE_LIMIT]][::-1]
    return Response({**conversation_json(conversation), "messages": [message_json(m) for m in messages]})


@api_view(["POST"])
@require_md
def ask(request: Request) -> Response:
    """Take a question and start answering it in the background. The reply (202) carries the ids to poll."""
    md = request.md_user
    body = request.data if isinstance(request.data, dict) else {}
    question = str(body.get("question") or "").strip()
    if not question:
        return Response({"error": "Type or say a question first."}, status=400)
    if len(question) > QUESTION_MAX:
        return Response({"error": f"Please keep the question under {QUESTION_MAX} characters."}, status=400)

    settings = MdAssistantSettings.load()
    if not settings.enabled:
        return Response({"error": engine.FRIENDLY["disabled"], "kind": "disabled"}, status=503)
    if not os.environ.get("GEMINI_API_KEY"):
        return Response({"error": engine.FRIENDLY["not_configured"], "kind": "not_configured"}, status=503)

    busy = MdMessage.objects.filter(
        conversation__user=md,
        role=MdMessage.ROLE_ASSISTANT,
        status__in=[MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING],
    )
    for stuck in busy:
        engine.expire_if_stale(stuck)
    if MdMessage.objects.filter(
        conversation__user=md,
        role=MdMessage.ROLE_ASSISTANT,
        status__in=[MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING],
    ).exists():
        return Response({"error": "I am still working on your previous question."}, status=409)

    input_mode = "voice" if body.get("inputMode") == "voice" else "text"
    language = str(body.get("language") or "")[:12] or None
    context = _clean_context(body.get("pageContext"))

    with transaction.atomic():
        conversation = None
        if body.get("conversationId"):
            conversation = MdConversation.objects.filter(pk=body.get("conversationId"), user=md).first()
            if conversation is None:
                return Response({"error": "No such conversation."}, status=404)
        if conversation is None:
            conversation = MdConversation.objects.create(user=md, title=question[:60])
        else:
            conversation.save(update_fields=["updated_at"])
        user_message = MdMessage.objects.create(
            conversation=conversation,
            role=MdMessage.ROLE_USER,
            content=question,
            payload={"voice": _clean_voice(body.get("voice"))} if input_mode == "voice" else {},
            input_mode=input_mode,
            language=language,
            page_context=context,
        )
        assistant_message = MdMessage.objects.create(
            conversation=conversation,
            role=MdMessage.ROLE_ASSISTANT,
            status=MdMessage.STATUS_PENDING,
            input_mode=input_mode,
            language=language,
            page_context=context,
        )
        transaction.on_commit(lambda: jobs.start(assistant_message.id))
    return Response(
        {
            "conversationId": conversation.id,
            "userMessageId": user_message.id,
            "messageId": assistant_message.id,
        },
        status=202,
    )


@api_view(["GET"])
@require_md
def message_detail(request: Request, pk: int) -> Response:
    message = MdMessage.objects.filter(pk=pk, conversation__user=request.md_user).first()
    if message is None:
        return Response({"error": "No such message."}, status=404)
    return Response(message_json(engine.expire_if_stale(message)))


@api_view(["POST"])
@require_md
def cancel_message(request: Request, pk: int) -> Response:
    """Stop an answer that is still being prepared."""
    message = MdMessage.objects.filter(pk=pk, conversation__user=request.md_user, role=MdMessage.ROLE_ASSISTANT).first()
    if message is None:
        return Response({"error": "No such message."}, status=404)
    stopped = engine.cancel(message)
    message.refresh_from_db()
    return Response({**message_json(message), "stopped": stopped})


@api_view(["POST"])
@require_md
@parser_classes([MultiPartParser, FormParser])
def transcribe(request: Request) -> Response:
    """Speech to text with Gemini: the fallback when the browser cannot recognise speech itself."""
    upload = request.FILES.get("audio")
    if upload is None:
        return Response({"error": "No audio was sent."}, status=400)
    if upload.size > MAX_AUDIO_BYTES:
        return Response({"error": "That recording is too long. Please keep it under a minute."}, status=413)
    settings = MdAssistantSettings.load()
    if not settings.enabled or not os.environ.get("GEMINI_API_KEY"):
        return Response({"error": engine.FRIENDLY["not_configured"], "kind": "not_configured"}, status=503)
    client = engine.build_client(settings)
    try:
        result = client.transcribe(
            upload.read(),
            upload.content_type or "audio/webm",
            language_hint=str(request.data.get("language") or "") or None,
        )
    except GeminiError as exc:
        return Response(
            {"error": engine.friendly_error(exc), "kind": exc.kind}, status=429 if exc.kind == "daily_quota" else 503
        )
    return Response(result)
