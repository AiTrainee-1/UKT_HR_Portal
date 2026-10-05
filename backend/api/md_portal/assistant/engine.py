"""Answering one question: the read-only, explainable tool loop.

    question ─► system prompt + history ─► Gemini ─► tool calls ─► (read-only) analytics ─► results back to Gemini ─► …
                                                                                         └► submit_answer ─► the answer

What makes it safe and trustworthy:
  * READ-ONLY: the only things Gemini can call are analytics functions (and the query language), each run inside
    ``common.read_only_db()`` where the database itself refuses a write. There is no tool that changes anything.
  * EXPLAINABLE: the "how I got this" shown to the MD (steps, data used, caveats, confidence) is built here from the tool
    calls that really happened and the provenance they returned (see xai.py): never from the model's own claims.
  * PRIVATE: employee names are swapped for tokens before anything is sent and swapped back for the MD (privacy.py).
  * BOUNDED: at most ``max_tool_rounds`` lookups rounds, results are compacted (shaping.py), Gemini retries and model
    fallbacks live in gemini.py, and every Gemini request is counted for the day's budget.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.db import DatabaseError
from django.db.models import F
from django.utils import timezone

from ...clock import FACTORY_TZ, ist_now
from ...models import MdAssistantSettings, MdAssistantUsage, MdMessage, PayrollSettings
from ..common import MdParamError, read_only_db
from ..pages import PAGE_BY_ID
from . import prompts, query_dsl, registry, routing, xai
from .gemini import GeminiClient, GeminiError, GeminiReply, function_response_part
from .privacy import Pseudonymizer
from .shaping import compact
from .tools_base import ToolSpec

log = logging.getLogger(__name__)


class Cancelled(Exception):
    """The MD pressed Stop: the job ends quietly (its message was already closed by the cancel request)."""


SUBMIT = prompts.SUBMIT_TOOL
HISTORY_MESSAGES = 8
HISTORY_CHARS = 1500
QUESTION_LIMIT = 2000
PACIFIC = ZoneInfo("America/Los_Angeles")
STALE_AFTER = timedelta(minutes=3)

_PSEUDO_CALL = re.compile(r"<call:|default_api:")


# ─── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────


def pacific_day():
    return datetime.now(PACIFIC).date()


def quota_reset_text() -> str:
    """When Google's daily free quota resets, in the factory's time ("12:30 PM IST")."""
    now = datetime.now(PACIFIC)
    reset = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    local = reset.astimezone(FACTORY_TZ)
    return local.strftime("%I:%M %p").lstrip("0") + " IST"


FRIENDLY = {
    "not_configured": "The AI assistant is not set up yet: the Gemini API key is missing on the server. Ask your "
    "administrator to add GEMINI_API_KEY to the server settings.",
    "bad_key": "Gemini rejected the server's API key. Ask your administrator to check GEMINI_API_KEY.",
    "region": "Gemini says the free tier is not available for this Google project or region. Ask your administrator "
    "to check the Google AI Studio project (billing may need to be enabled).",
    "not_found": "None of the configured Gemini models is available to this API key. Ask your administrator to pick a "
    "current model in Account Management > MD profile.",
    "overloaded": "Gemini is very busy right now. Please try again in a minute.",
    "rate_limited": "Gemini is receiving too many requests at the moment. Please try again in a minute.",
    "server": "Gemini had a problem answering. Please try again in a minute.",
    "timeout": "Gemini took too long to answer. Please try again.",
    "network": "The server could not reach Gemini. Check the internet connection of the server and try again.",
    "blocked": "Gemini declined to answer that (its safety filter). Try asking in a different way.",
    "empty": "Gemini did not return an answer. Please try again.",
    "disabled": "The AI assistant has been switched off by the administrator.",
}


def friendly_error(exc: GeminiError) -> str:
    if exc.kind == "daily_quota":
        return (
            "The assistant has used today's free Gemini allowance. It resets at about "
            f"{quota_reset_text()}. Everything else in the portal works as usual, and an administrator can lift the "
            "limit by enabling billing on the Google AI Studio project."
        )
    if exc.kind == "bad_request":
        return f"Gemini rejected the request: {str(exc)[:200]}"
    return FRIENDLY.get(exc.kind, "The assistant could not answer right now. Please try again.")


# ─── usage ──────────────────────────────────────────────────────────────────────────────────────────────────────


def record_usage(model: str, reply: GeminiReply | None, error: GeminiError | None) -> None:
    """Count a Gemini request against today's (Pacific) budget. Never raises: bookkeeping must not fail an answer."""
    try:
        row, _ = MdAssistantUsage.objects.get_or_create(day=pacific_day(), model=model)
        fields: dict[str, Any] = {"requests": F("requests") + 1}
        if reply is not None:
            prompt, output = reply.tokens()
            fields["prompt_tokens"] = F("prompt_tokens") + prompt
            fields["output_tokens"] = F("output_tokens") + output
        if error is not None and error.kind == "rate_limited":
            fields["rate_limited"] = F("rate_limited") + 1
        if error is not None and error.kind == "daily_quota":
            fields["daily_limit_hit"] = True
        elif reply is not None:
            fields["daily_limit_hit"] = False  # it answered: whatever blocked it earlier is over
        MdAssistantUsage.objects.filter(pk=row.pk).update(**fields)
    except Exception:  # noqa: BLE001
        log.exception("could not record assistant usage")


def usage_today() -> dict:
    """Today's Gemini requests, and whether the free allowance is gone: only when EVERY model the assistant may use
    has hit its daily limit (one that is still answering means the assistant still works)."""
    rows = list(MdAssistantUsage.objects.filter(day=pacific_day()).values("model", "requests", "daily_limit_hit"))
    exhausted = {r["model"] for r in rows if r["daily_limit_hit"]}
    chain = model_chain(MdAssistantSettings.load())
    return {
        "requests": sum(r["requests"] for r in rows),
        "models": rows,
        "limitHit": bool(chain) and all(m in exhausted for m in chain),
        "resetsAt": quota_reset_text(),
    }


# ─── building the client ───────────────────────────────────────────────────────────────────────────────────────


def model_chain(settings: MdAssistantSettings) -> list[str]:
    chain = [settings.model.strip()]
    chain += [m.strip() for m in (settings.fallback_models or "").split(",")]
    return [m for i, m in enumerate(chain) if m and m not in chain[:i]]


def build_client(settings: MdAssistantSettings) -> GeminiClient:
    return GeminiClient(
        models=model_chain(settings),
        thinking_level=settings.thinking_level,
        requests_per_minute=settings.requests_per_minute,
        on_request=record_usage,
    )


# ─── tools ──────────────────────────────────────────────────────────────────────────────────────────────────────


def all_tools() -> dict[str, ToolSpec]:
    return registry.all_tools()


QUERY_TOOL_NAME = "query_data"


def declarations(tools: dict[str, ToolSpec]) -> list[dict]:
    return [*(t.declaration() for t in tools.values()), query_dsl.query_declaration(), prompts.submit_declaration()]


@dataclass
class Job:
    message: MdMessage
    settings: MdAssistantSettings
    privacy: Pseudonymizer
    client: GeminiClient
    tools: dict[str, ToolSpec]
    steps: list[xai.Step] = field(default_factory=list)
    progress: list[dict] = field(default_factory=list)
    cache: dict[str, tuple[dict, xai.Step]] = field(default_factory=dict)
    prompt_tokens: int = 0
    output_tokens: int = 0
    last_model: str = ""
    question_id: int = 0

    def push(self, label: str, state: str = "done") -> int:
        self.progress.append({"label": label, "state": state})
        self._flush()
        return len(self.progress) - 1

    def finish_progress(self, index: int, state: str = "done") -> None:
        self.progress[index]["state"] = state
        self._flush()

    def _flush(self) -> None:
        # Only while the answer is still being prepared: a stopped one keeps what the stop wrote.
        MdMessage.objects.filter(
            pk=self.message.pk, status__in=[MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING]
        ).update(payload={**(self.message.payload or {}), "progress": self.progress})


def execute_call(job: Job, call: dict) -> dict:
    """Run one tool call read-only and return the ``functionResponse.response`` object for the model."""
    name = call["name"]
    args = job.privacy.reveal_args(call.get("args") or {})
    key = f"{name}:{json.dumps(args, sort_keys=True, default=str)}"
    if key in job.cache:
        result, _ = job.cache[key]
        return {"result": result, "note": "Same lookup as before: reused."}

    generic = name == QUERY_TOOL_NAME
    spec = job.tools.get(name)
    runner = query_dsl.run_query_tool if generic else (spec.run if spec else None)
    person_fields = ("user_name",) if generic else (spec.person_fields if spec else ())
    title = "Custom data query" if generic else xai.humanize(name)

    if runner is None:
        job.steps.append(xai.Step(tool=name, args=args, ok=False, error="unknown tool", title=title))
        return {"error": f"There is no tool called '{name}'. Use one of the tools you were given."}

    index = job.push(f"Looking at {title.lower()}…", "running")
    started = time.monotonic()
    try:
        with read_only_db():
            result = runner(args)
    except MdParamError as exc:
        step = xai.Step(tool=name, args=args, ok=False, error=str(exc), title=title)
        job.steps.append(step)
        job.finish_progress(index, "error")
        return {"error": str(exc)}
    except DatabaseError:
        log.exception("assistant tool %s failed in the database", name)
        job.steps.append(xai.Step(tool=name, args=args, ok=False, error="database error", title=title))
        job.finish_progress(index, "error")
        return {"error": "That lookup failed (it may have been too heavy). Try a narrower period or fewer groups."}
    except Exception:  # noqa: BLE001
        log.exception("assistant tool %s crashed", name)
        job.steps.append(xai.Step(tool=name, args=args, ok=False, error="unexpected error", title=title))
        job.finish_progress(index, "error")
        return {"error": "That lookup failed unexpectedly."}

    ms = int((time.monotonic() - started) * 1000)
    step = xai.step_from_result(name, title, args, result, ms, generic=generic)
    step.defaulted = list(result.get("defaulted") or [])
    if not generic and spec and spec.default_period and not any(k in args for k in ("period", "from", "to", "month")):
        if step.period:
            step.defaulted.append(f"no period was given, so {step.period} was used")
    job.steps.append(step)
    job.finish_progress(index, "done")

    shaped = job.privacy.protect(compact(result), person_fields)
    shaped.pop("defaulted", None)
    job.cache[key] = (shaped, step)
    return {"result": shaped}


# ─── history ────────────────────────────────────────────────────────────────────────────────────────────────────


def history_contents(job: Job) -> list[dict]:
    """The earlier turns of this conversation as the model sees them: the question and the final answer only (never
    the raw tool results), with names turned back into tokens."""
    earlier = list(
        MdMessage.objects.filter(conversation=job.message.conversation, id__lt=job.question_id, status="done").order_by(
            "-id"
        )[:HISTORY_MESSAGES]
    )
    contents: list[dict] = []
    for m in reversed(earlier):
        text = job.privacy.protect_text((m.content or "")[:HISTORY_CHARS])
        if not text:
            continue
        role = "user" if m.role == MdMessage.ROLE_USER else "model"
        if contents and contents[-1]["role"] == role:  # roles must alternate
            contents[-1]["parts"][0]["text"] += "\n" + text
        else:
            contents.append({"role": role, "parts": [{"text": text}]})
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    if contents and contents[-1]["role"] == "user":
        contents.pop()  # the new question follows: do not end the history on a user turn
    return contents


# ─── the loop ───────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Outcome:
    answer: str
    answer_type: str
    spoken: str
    explanation: list[str]
    assumptions: list[str]
    pages: list[dict]
    follow_ups: list[str]
    confidence: str | None
    model: str


_LEADING_NUMBER = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+")


def _clean_list(value: Any, limit: int, size: int) -> list[str]:
    """Short plain lines from the model's list: bullets and "1." numbering stripped (the panel adds its own)."""
    if not isinstance(value, list):
        return []
    lines = (_LEADING_NUMBER.sub("", str(x)).strip()[:size] for x in value)
    return [line for line in lines if line][:limit]


def outcome_from_submit(args: dict, model: str) -> Outcome:
    answer = str(args.get("answer") or "").strip()
    answer_type = str(args.get("answer_type") or "answer")
    if answer_type not in ("answer", "clarification", "cannot_answer"):
        answer_type = "answer"
    if not answer:
        answer = "I could not put an answer together from the data."
        answer_type = "cannot_answer"
    pages: list[dict] = []
    for item in args.get("suggested_pages") or []:
        page_id = item.get("page") if isinstance(item, dict) else item
        if page_id in PAGE_BY_ID and all(p["id"] != page_id for p in pages):
            meta = PAGE_BY_ID[page_id]
            pages.append(
                {
                    "id": page_id,
                    "title": meta["title"],
                    "path": meta["path"],
                    "reason": str((item.get("reason") if isinstance(item, dict) else "") or meta["summary"])[:200],
                }
            )
    spoken = str(args.get("spoken_summary") or "").strip() or plain_first_sentences(answer)
    confidence = args.get("confidence") if args.get("confidence") in ("high", "medium", "low") else None
    return Outcome(
        answer=answer,
        answer_type=answer_type,
        spoken=spoken,
        explanation=_clean_list(args.get("explanation"), 8, 300),
        assumptions=_clean_list(args.get("assumptions"), 8, 300),
        pages=pages[:2],
        follow_ups=_clean_list(args.get("follow_ups"), 3, 140),
        confidence=confidence,
        model=model,
    )


def plain_first_sentences(markdown: str, limit: int = 2) -> str:
    """A speakable version of an answer when the model gave none: markdown stripped, first sentences kept."""
    text = re.sub(r"[*_`#>|]", "", markdown)
    text = re.sub(r"^\s*[-•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(sentences[:limit])[:400]


def run_loop(job: Job, question: str, page_context: dict | None) -> Outcome:
    company = (PayrollSettings.objects.filter(pk=1).values_list("company_name", flat=True).first()) or "UK Textiles"
    system = (
        prompts.build_system_prompt(company=company, now=ist_now(), page_context=page_context)
        + "\nDATASETS for query_data:\n"
        + query_dsl.catalog_text()
        + "\n"
    )
    contents = history_contents(job)
    contents.append({"role": "user", "parts": [{"text": job.privacy.protect_text(question)}]})
    # Describe in full the tools of the areas this question is about (its words, the earlier questions of the
    # conversation, the page the MD is on); every other tool is still declared, in one line (routing.py).
    asked = " ".join(c["parts"][0].get("text", "") for c in contents if c["role"] == "user")
    page = page_context.get("page") if isinstance(page_context, dict) else None
    areas = routing.select_areas(asked, page)
    decls = [*routing.declarations_for(job.tools, areas), query_dsl.query_declaration(), prompts.submit_declaration()]

    max_rounds = max(1, min(8, job.settings.max_tool_rounds))
    mode = "ANY"
    function_role = "user"  # the role Google documents for a function's result; "function" is the legacy spelling
    retried_empty = False
    rounds = 0  # rounds that looked something up (a retry of a broken reply does not use one up)
    attempts = 0  # every request made for this question: a hard stop against a model that never finishes
    job.push("Reading your question")
    while attempts < max_rounds + 4:
        attempts += 1
        if MdMessage.objects.filter(pk=job.message.pk, status=MdMessage.STATUS_ERROR).exists():
            raise Cancelled  # stopped by the MD between two steps
        last = rounds >= max_rounds
        wait = job.push("Thinking it through…" if rounds == 0 else "Working out the answer…", "running")
        try:
            reply = job.client.generate(
                system=system, contents=contents, tools=decls, mode=mode, allowed=[SUBMIT] if last else None
            )
        except GeminiError as exc:
            # Forced function calling is the one setting some model versions dislike: try once without it.
            if mode == "ANY" and exc.kind in ("bad_request", "server") and attempts == 1:
                mode = "AUTO"
                job.finish_progress(wait, "done")
                continue
            # A server that wants a different role for the function results than the one we send: try the other spelling.
            if exc.kind == "bad_request" and rounds > 0 and function_role == "user" and "role" in str(exc).lower():
                function_role = "function"
                contents[-1]["role"] = function_role
                job.finish_progress(wait, "done")
                continue
            job.finish_progress(wait, "error")
            raise
        job.finish_progress(wait, "done")
        prompt_tokens, output_tokens = reply.tokens()
        job.prompt_tokens += prompt_tokens
        job.output_tokens += output_tokens
        job.last_model = reply.model

        if reply.block_reason or reply.finish_reason in (
            "SAFETY",
            "SPII",
            "PROHIBITED_CONTENT",
            "BLOCKLIST",
            "RECITATION",
        ):
            raise GeminiError("blocked", "blocked")
        calls = reply.function_calls()
        if not calls:
            text = reply.text()
            if (not text or _PSEUDO_CALL.search(text)) and not retried_empty:
                retried_empty = True  # an empty or half-formed reply: ask once more
                continue
            if not text or _PSEUDO_CALL.search(text):
                raise GeminiError("empty", "empty")
            return Outcome(
                answer=job.privacy.restore(text),
                answer_type="answer",
                spoken=plain_first_sentences(job.privacy.restore(text)),
                explanation=[],
                assumptions=["The assistant answered in free text rather than in its structured format."],
                pages=[],
                follow_ups=[],
                confidence="low",
                model=reply.model,
            )

        contents.append(reply.content())
        data_calls = [c for c in calls if c["name"] != SUBMIT]
        submit_call = next((c for c in calls if c["name"] == SUBMIT), None)
        if submit_call and not data_calls:
            return outcome_from_submit(submit_call["args"], reply.model)

        responses = [function_response_part(c, execute_call(job, c)) for c in data_calls]
        if submit_call:  # answered before the lookups came back: every call still needs its response
            responses.append(
                function_response_part(submit_call, {"error": f"Call {SUBMIT} alone, after the lookups have returned."})
            )
        contents.append({"role": function_role, "parts": responses})
        rounds += 1

    raise GeminiError("empty", "no final answer")


# ─── finishing ──────────────────────────────────────────────────────────────────────────────────────────────────


def finish(job: Job, out: Outcome) -> None:
    p = job.privacy
    payload = xai.build_payload(
        steps=job.steps,
        model_steps=out.explanation,
        model_assumptions=out.assumptions,
        model_confidence=out.confidence,
        answer_type=out.answer_type,
    )
    payload = p.restore_deep(payload)
    payload.update(
        {
            "spokenSummary": p.restore(out.spoken),
            "suggestedPages": out.pages,
            "followUps": [p.restore(x) for x in out.follow_ups],
            "answerType": out.answer_type,
            "model": job.last_model or out.model,
            "privacy": {"enabled": p.enabled, "tokens": p.tokens_issued},
            "usage": {
                "requests": job.client.requests_made,
                "promptTokens": job.prompt_tokens,
                "outputTokens": job.output_tokens,
            },
            "progress": job.progress,
        }
    )
    # Only a job that is still running may finish: one the MD stopped meanwhile stays stopped.
    MdMessage.objects.filter(pk=job.message.pk, status__in=[MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING]).update(
        status=MdMessage.STATUS_DONE,
        content=p.restore(out.answer),
        payload=payload,
        model_used=job.last_model or out.model,
        finished_at=timezone.now(),
        error=None,
    )


def fail(message_id: int, text: str, kind: str) -> None:
    msg = MdMessage.objects.filter(pk=message_id).first()
    payload = dict((msg.payload if msg else None) or {})
    payload["errorKind"] = kind
    MdMessage.objects.filter(pk=message_id).update(
        status=MdMessage.STATUS_ERROR, error=text, payload=payload, finished_at=timezone.now()
    )


def cancel(message: MdMessage) -> bool:
    """Stop an answer in progress. The running job notices before its next step and does not overwrite this."""
    if message.status not in (MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING):
        return False
    fail(message.id, "Stopped.", "cancelled")
    return True


def answer_message(
    message_id: int, *, client: GeminiClient | None = None, tools: dict[str, ToolSpec] | None = None
) -> None:
    """Work on one pending assistant message to the end (done or error). Safe to call from a background thread."""
    message = MdMessage.objects.select_related("conversation").filter(pk=message_id).first()
    if message is None or message.status not in (MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING):
        return
    settings = MdAssistantSettings.load()
    MdMessage.objects.filter(pk=message_id).update(status=MdMessage.STATUS_RUNNING, started_at=timezone.now())
    message.status = MdMessage.STATUS_RUNNING
    if not settings.enabled:
        fail(message_id, FRIENDLY["disabled"], "disabled")
        return
    question_row = (
        MdMessage.objects.filter(conversation=message.conversation, role=MdMessage.ROLE_USER, id__lt=message.id)
        .order_by("-id")
        .first()
    )
    if question_row is None:
        fail(message_id, "There was no question to answer.", "internal")
        return
    job = Job(
        message=message,
        settings=settings,
        privacy=Pseudonymizer(enabled=settings.privacy_mode),
        client=client or build_client(settings),
        tools=tools if tools is not None else all_tools(),
        question_id=question_row.id,
    )
    try:
        out = run_loop(job, question_row.content[:QUESTION_LIMIT], message.page_context)
        finish(job, out)
    except Cancelled:
        return
    except GeminiError as exc:
        log.warning("assistant: gemini error %s: %s", exc.kind, exc)
        fail(message_id, friendly_error(exc), exc.kind)
    except Exception:  # noqa: BLE001
        log.exception("assistant: unexpected failure answering message %s", message_id)
        fail(message_id, "Something went wrong while preparing the answer. Please try again.", "internal")


def expire_if_stale(message: MdMessage) -> MdMessage:
    """A job whose worker died (a server restart) would stay "running" for ever: end it with a clear message."""
    if message.status in (MdMessage.STATUS_PENDING, MdMessage.STATUS_RUNNING):
        started = message.started_at or message.created_at
        if timezone.now() - started > STALE_AFTER:
            fail(
                message.id,
                "The assistant stopped before it finished (the server may have restarted). Please ask again.",
                "interrupted",
            )
            message.refresh_from_db()
    return message
