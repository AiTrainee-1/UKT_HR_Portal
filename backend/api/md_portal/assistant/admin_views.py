"""The super administrator's controls for the MD assistant (Account Management > MD profile), under
/api/hr-users/md-assistant. The Gemini API key is NOT editable here and is never returned: it lives in the server's
environment (GEMINI_API_KEY), so a database leak or a screenshot of this page can never expose it."""

from __future__ import annotations

import os
import re
import time

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ...audit_utils import log_action
from ...auth import require_super_admin
from ...models import HRUser, MdAssistantSettings
from . import engine
from .gemini import GeminiError

MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{1,79}$")
THINKING_LEVELS = ("minimal", "low", "medium", "high")


def settings_json(s: MdAssistantSettings) -> dict:
    return {
        "enabled": s.enabled,
        "model": s.model,
        "fallbackModels": [m.strip() for m in (s.fallback_models or "").split(",") if m.strip()],
        "thinkingLevel": s.thinking_level,
        "privacyMode": s.privacy_mode,
        "maxToolRounds": s.max_tool_rounds,
        "requestsPerMinute": s.requests_per_minute,
        "keyConfigured": bool(os.environ.get("GEMINI_API_KEY")),
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
        "updatedBy": s.updated_by,
        "usage": engine.usage_today(),
    }


def _bounded_int(value, name: str, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a whole number.") from None
    if not low <= number <= high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return number


@api_view(["GET", "PUT"])
@require_super_admin
def assistant_settings(request: Request) -> Response:
    s = MdAssistantSettings.load()
    if request.method == "GET":
        return Response(settings_json(s))

    body = request.data if isinstance(request.data, dict) else {}
    changed: list[str] = []
    try:
        if "enabled" in body:
            s.enabled = bool(body["enabled"])
            changed.append("enabled" if s.enabled else "disabled")
        if "privacyMode" in body:
            s.privacy_mode = bool(body["privacyMode"])
            changed.append(f"privacy mode {'on' if s.privacy_mode else 'off'}")
        if "model" in body:
            model = str(body["model"]).strip()
            if not MODEL_ID.match(model):
                raise ValueError("That is not a valid model id (for example gemini-3.5-flash-lite).")
            s.model = model
            changed.append(f"model {model}")
        if "fallbackModels" in body:
            raw = body["fallbackModels"]
            models = [m.strip() for m in (raw.split(",") if isinstance(raw, str) else raw) if str(m).strip()]
            for m in models:
                if not MODEL_ID.match(str(m)):
                    raise ValueError(f"'{m}' is not a valid model id.")
            s.fallback_models = ",".join(models)
            changed.append("fallback models")
        if "thinkingLevel" in body:
            level = str(body["thinkingLevel"]).lower()
            if level not in THINKING_LEVELS:
                raise ValueError(f"Thinking level must be one of: {', '.join(THINKING_LEVELS)}.")
            s.thinking_level = level
            changed.append(f"thinking {level}")
        if "maxToolRounds" in body:
            s.max_tool_rounds = _bounded_int(body["maxToolRounds"], "Lookup rounds", 1, 8)
            changed.append("lookup rounds")
        if "requestsPerMinute" in body:
            s.requests_per_minute = _bounded_int(body["requestsPerMinute"], "Requests per minute", 1, 60)
            changed.append("requests per minute")
    except ValueError as exc:
        return Response({"error": str(exc)}, status=400)

    s.updated_by = HRUser.objects.filter(pk=request.jwt_user.get("hrUserId")).values_list("username", flat=True).first()
    s.save()
    if changed:
        log_action(
            request,
            "update",
            "md_assistant",
            record_id=s.id,
            description="MD assistant settings: " + ", ".join(changed),
        )
    return Response(settings_json(s))


@api_view(["POST"])
@require_super_admin
def assistant_test(request: Request) -> Response:
    """One tiny request to the configured model (costs one request of the day's allowance) plus the list of models the
    key can use, so the administrator can see that the key works and pick a current model."""
    s = MdAssistantSettings.load()
    client = engine.build_client(s)
    if not client.configured():
        return Response({"ok": False, "kind": "not_configured", "error": engine.FRIENDLY["not_configured"]})
    started = time.monotonic()
    try:
        reply = client.generate(
            system="Reply with the single word OK.",
            contents=[{"role": "user", "parts": [{"text": "Say OK."}]}],
            max_output_tokens=64,
            thinking=False,
        )
    except GeminiError as exc:
        return Response({"ok": False, "kind": exc.kind, "error": engine.friendly_error(exc)})
    result = {
        "ok": True,
        "model": reply.model,
        "ms": int((time.monotonic() - started) * 1000),
        "reply": reply.text()[:40],
    }
    try:
        result["availableModels"] = client.list_models()
    except GeminiError:
        result["availableModels"] = []
    return Response(result)
