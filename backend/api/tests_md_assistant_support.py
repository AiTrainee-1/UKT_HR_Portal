"""Shared fakes for the assistant's tests: a scripted Gemini client, reply builders and a sample tool."""

from __future__ import annotations

import copy

from .md_portal.assistant.gemini import GeminiReply
from .md_portal.assistant.tools_base import tool
from .md_portal.common import envelope, prov
from .models import HRUser, MdConversation, MdMessage


def call_reply(*calls: tuple[str, dict], model: str = "gemini-test") -> GeminiReply:
    """A model turn that calls tools: call_reply(("attendance_summary", {...}), ("other", {}))."""
    parts = []
    for i, (name, args) in enumerate(calls):
        part: dict = {"functionCall": {"id": f"c{i}", "name": name, "args": args}}
        if i == 0:
            part["thoughtSignature"] = "sig-abc"
        parts.append(part)
    return GeminiReply(
        model=model, parts=parts, finish_reason="STOP", usage={"promptTokenCount": 100, "candidatesTokenCount": 10}
    )


def submit_reply(model: str = "gemini-test", **fields) -> GeminiReply:
    args = {
        "answer_type": "answer",
        "answer": "**91.8%** attendance.",
        "spoken_summary": "Attendance was ninety one point eight percent.",
        "explanation": ["I looked at attendance."],
    }
    args.update(fields)
    return call_reply(("submit_answer", args), model=model)


def text_reply(text: str, model: str = "gemini-test") -> GeminiReply:
    return GeminiReply(model=model, parts=[{"text": text}], finish_reason="STOP")


class ScriptedClient:
    """Stands in for GeminiClient: each generate() pops the next scripted reply (or raises it, if it is an exception)."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []
        self.requests_made = 0

    def generate(self, **request):
        self.calls.append(copy.deepcopy(request))  # the engine keeps appending to the same lists: snapshot each request
        self.requests_made += 1
        if not self.replies:
            raise AssertionError("the assistant asked Gemini more often than the test scripted")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply(request) if callable(reply) else reply


def sample_tool(name: str = "attendance_summary", *, with_person: bool = False):
    def fn(*, scope, period):
        data: dict = {"attendancePct": 91.8, "absentDays": 412}
        if with_person:
            data["worst"] = [
                {
                    "employeeId": 7,
                    "name": "Ravi Kumar",
                    "code": "E-007",
                    "department": "Stitching",
                    "phone": "98400 11111",
                },
            ]
        return envelope(
            data,
            period=period,
            scope=scope,
            provenance=[
                prov(
                    "attendance-pct",
                    "Attendance %",
                    dataset="Attendance day records",
                    definition="Days present out of scheduled days.",
                    formula="present ÷ scheduled",
                    rows=1200,
                    caveats=["Today is provisional."],
                )
            ],
        )

    return tool(
        name,
        "Attendance for a period: attendance %, absent days. Use for how was attendance.",
        fn,
        page="attendance",
        period="last_30_days",
        person_fields=("name",) if with_person else (),
    )


def make_conversation(md: HRUser, question: str = "How was attendance?", **message_fields):
    """A conversation with the MD's question and a pending assistant message (the job)."""
    conversation = MdConversation.objects.create(user=md, title=question[:60])
    MdMessage.objects.create(conversation=conversation, role=MdMessage.ROLE_USER, content=question)
    pending = MdMessage.objects.create(
        conversation=conversation, role=MdMessage.ROLE_ASSISTANT, status=MdMessage.STATUS_PENDING, **message_fields
    )
    return conversation, pending
