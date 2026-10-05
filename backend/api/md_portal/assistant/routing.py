"""Choosing how much of the tool list to describe in full.

About fifty tools is a lot for a model to read on every request (twelve thousand tokens), and Google itself advises keeping
the active tool list short for accuracy. So the tools of the areas a question is about (the page the MD is on, the words of
the question) are declared in FULL, and every other tool is still declared, but as a one-line summary with bare
parameters. Nothing becomes uncallable; the model simply is not made to read forty long descriptions to answer a question
about payroll.
"""

from __future__ import annotations

import re

from ..pages import PAGE_IDS
from .tools_base import ToolSpec

#: words that point at an area. Plain lists, matched on word stems, so "absentees" finds attendance.
DOMAIN_HINTS: dict[str, str] = {
    "attendance": "attendance absent absence absentee absenteeism late lateness present punch shift overtime leave permission biometric muster half",
    "employees": "employee headcount workforce staff people attrition tenure joiner leaver joined left age gender designation composition birthday anniversary milestone directory profile",
    "visitors": "visitor outpass gate guest entry exit pass visit",
    "tea-break": "tea break overrun",
    "payroll": "payroll salary pay paid cost gross net deduction advance bonus slip wage ctc statutory pf esi",
    "recruitment": "recruitment hiring hire vacancy position applicant candidate interview resign resignation notice funnel opening joinee",
    "activity": "activity audit log login signin user sensitive action device logged",
    "dashboard": "briefing brief overview summary company attention insight overall everything",
    "reports": "report",
}

#: always described in full: the cheap, broad ones
ALWAYS = frozenset({"dashboard", "reports"})
MAX_MATCHED_AREAS = 3
SUMMARY_CHARS = 110


def stem(word: str) -> str:
    word = word.lower()
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("sses") and len(word) > 5:
        return word[:-2]  # passes -> pass
    if word.endswith("ing") and len(word) > 5:
        return word[:-3]
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


_STEMMED = {area: {stem(w) for w in hints.split()} for area, hints in DOMAIN_HINTS.items()}


def select_areas(text: str, current_page: str | None = None) -> set[str]:
    """The areas to describe in full: the best-matching ones (up to three), the page the MD is on and the broad ones."""
    words = {stem(w) for w in re.findall(r"[A-Za-z]+", text)}
    scored = sorted(
        ((len(words & hints), area) for area, hints in _STEMMED.items() if area not in ALWAYS), reverse=True
    )
    selected = {area for score, area in scored[:MAX_MATCHED_AREAS] if score > 0}
    selected |= ALWAYS
    if current_page in PAGE_IDS:
        selected.add(current_page)
    return selected


def first_sentence(text: str, limit: int = SUMMARY_CHARS) -> str:
    sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
    return sentence if len(sentence) <= limit else sentence[: limit - 1].rstrip() + "…"


def compact_declaration(spec: ToolSpec) -> dict:
    """One line of description and the parameters without their explanations: enough to call it correctly."""
    properties = {}
    for name, schema in spec.properties.items():
        slim = {"type": schema.get("type", "string")}
        if "enum" in schema:
            slim["enum"] = schema["enum"]
        if slim["type"] == "array" and "items" in schema:
            slim["items"] = {"type": schema["items"].get("type", "string")}
        properties[name] = slim
    parameters: dict = {"type": "object", "properties": properties}
    if spec.required:
        parameters["required"] = list(spec.required)
    return {"name": spec.name, "description": first_sentence(spec.description), "parameters": parameters}


def declarations_for(tools: dict[str, ToolSpec], areas: set[str]) -> list[dict]:
    """Full declarations for the selected areas first, then a compact one for every other tool."""
    full = [t.declaration() for t in tools.values() if t.page in areas]
    rest = [compact_declaration(t) for t in tools.values() if t.page not in areas]
    return full + rest
