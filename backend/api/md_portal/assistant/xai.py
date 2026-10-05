"""Explainable answers: what the assistant did, which data it used, what it assumed and how sure it is.

The explanation is built by the SERVER from the tool calls that were really made and the provenance those tools
returned: not from what the model says it did. The model contributes only the plain-language reasoning steps and its own
assumptions, which are shown separately and labelled as such.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}


def humanize(name: str) -> str:
    return name.replace("_", " ").strip().capitalize()


@dataclass
class Step:
    """One tool call the assistant made."""

    tool: str
    args: dict
    ok: bool = True
    error: str | None = None
    ms: int = 0
    title: str = ""
    period: str | None = None
    scope: str | None = None
    rows: int | None = None
    provenance: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    defaulted: list[str] = field(default_factory=list)  # what the tool filled in because the model gave nothing
    generic: bool = False  # a free-form data query rather than a curated tool
    detail: str | None = None  # for a free-form query: the query in words

    def summary(self) -> str:
        bits = [self.title or humanize(self.tool)]
        if self.period:
            bits.append(self.period)
        if self.scope and self.scope != "All units · all departments · staff and production":
            bits.append(self.scope)
        return " · ".join(bits)

    def to_json(self) -> dict:
        return {
            "tool": self.tool,
            "title": self.title or humanize(self.tool),
            "summary": self.summary(),
            "ok": self.ok,
            "error": self.error,
            "ms": self.ms,
            "rows": self.rows,
            "period": self.period,
            "scope": self.scope,
            "args": self.args,
            "detail": self.detail,
        }


def step_from_result(tool: str, title: str, args: dict, result: dict, ms: int, *, generic: bool = False) -> Step:
    period = result.get("period") if isinstance(result.get("period"), dict) else None
    scope = result.get("scope") if isinstance(result.get("scope"), dict) else None
    provenance = [p for p in result.get("provenance", []) if isinstance(p, dict)]
    rows = sum(int(p.get("rows") or 0) for p in provenance) or None
    return Step(
        tool=tool,
        args=args,
        ms=ms,
        title=title,
        period=period.get("label") if period else None,
        scope=scope.get("description") if scope else None,
        rows=rows,
        provenance=provenance,
        notes=[str(n) for n in result.get("notes", []) if n],
        generic=generic,
        detail=str(result.get("query")) if generic and result.get("query") else None,
    )


def data_used(steps: list[Step]) -> list[dict]:
    """The datasets, rules and caveats behind the answer, one entry per figure family (deduplicated)."""
    seen: set[tuple] = set()
    out: list[dict] = []
    for step in steps:
        if not step.ok:
            continue
        for p in step.provenance:
            key = (p.get("id"), step.period, step.scope)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": p.get("title"),
                    "dataset": p.get("dataset"),
                    "definition": p.get("definition"),
                    "formula": p.get("formula"),
                    "rows": p.get("rows"),
                    "filters": p.get("filters") or [],
                    "caveats": p.get("caveats") or [],
                    "period": step.period,
                    "scope": step.scope,
                    "from": step.title or humanize(step.tool),
                }
            )
    return out


def system_assumptions(steps: list[Step]) -> list[str]:
    """What the server itself had to assume: a defaulted period, a fuzzy-matched name."""
    out: list[str] = []
    for step in steps:
        if not step.ok:
            continue
        for d in step.defaulted:
            out.append(f"{step.title or humanize(step.tool)}: {d}")
        out.extend(n for n in step.notes if n.lower().startswith("matched "))
    return list(dict.fromkeys(out))


def confidence(steps: list[Step], *, model_says: str | None, answer_type: str) -> tuple[str, str]:
    """(level, why). High only when the answer rests on successful curated tools with no caveats; the model's own
    rating can lower it but never raise it above what the evidence supports."""
    good = [s for s in steps if s.ok]
    caveats = sorted({c for s in good for p in s.provenance for c in (p.get("caveats") or [])})
    failures = [s for s in steps if not s.ok]
    reasons: list[str] = []
    if answer_type in ("cannot_answer", "clarification"):
        level = "low"
        reasons.append("The question could not be answered from the data directly.")
    elif not good:
        level = "low"
        reasons.append("No data was looked up for this answer.")
    else:
        level = "high"
        reasons.append(f"Based on {len(good)} lookup{'s' if len(good) != 1 else ''} of the company's own records.")
        if any(s.generic for s in good):
            level = "medium"
            reasons.append("Part of it used a free-form data query rather than a built-in report.")
        if caveats:
            level = "medium"
            reasons.append("Some figures carry caveats (see Data used).")
        if failures:
            level = "medium"
            reasons.append(
                f"{len(failures)} lookup{'s' if len(failures) != 1 else ''} failed and had to be worked around."
            )
    if model_says in CONFIDENCE_ORDER and CONFIDENCE_ORDER[model_says] < CONFIDENCE_ORDER[level]:
        level = model_says
        reasons.append("The assistant itself rated its confidence lower.")
    return level, " ".join(reasons)


def build_payload(
    *,
    steps: list[Step],
    model_steps: list[str],
    model_assumptions: list[str],
    model_confidence: str | None,
    answer_type: str,
) -> dict[str, Any]:
    level, why = confidence(steps, model_says=model_confidence, answer_type=answer_type)
    return {
        "steps": [s.to_json() for s in steps],
        "reasoning": [str(x) for x in model_steps if x][:8],
        "dataUsed": data_used(steps),
        "assumptions": list(dict.fromkeys([*system_assumptions(steps), *[str(a) for a in model_assumptions if a]]))[:8],
        "confidence": level,
        "confidenceReason": why,
    }
