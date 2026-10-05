"""Making a tool result small enough to send to the model.

Every Gemini round trip pays for the whole conversation again, and the free tier counts requests, not just tokens, so a
tool result must be compact: the figures and the top of any list, never a table dump. The explanation of HOW a figure
is made (provenance) is kept out of the model's context (the server keeps it for the "how I got this" view) and only
its ids and caveats are passed along, so the model can mention a caveat it must not hide.
"""

from __future__ import annotations

import json
from typing import Any

MAX_CHARS = 6000
LIST_STEPS = (15, 10, 6, 3)  # progressively shorter lists until the result fits
STRING_LIMIT = 300
DROP_KEYS = {"tookMs", "generatedAt", "provenance"}


def _round(value: Any) -> Any:
    return round(value, 2) if isinstance(value, float) else value


def _trim(node: Any, list_limit: int, truncated: list[int]) -> Any:
    if isinstance(node, dict):
        return {k: _trim(v, list_limit, truncated) for k, v in node.items() if k not in DROP_KEYS and v is not None}
    if isinstance(node, list):
        if len(node) > list_limit:
            truncated.append(len(node) - list_limit)
        return [_trim(x, list_limit, truncated) for x in node[:list_limit]]
    if isinstance(node, str):
        return node if len(node) <= STRING_LIMIT else node[: STRING_LIMIT - 1] + "…"
    return _round(node)


def compact(result: dict) -> dict:
    """The result as the model sees it: no provenance bodies, no nulls, floats rounded, lists capped to fit. When lists
    had to be cut, ``_truncated`` says how many rows were left out (so the answer can say "top 10 of 40")."""
    caveats = sorted(
        {c for p in result.get("provenance", []) if isinstance(p, dict) for c in p.get("caveats", []) if c}
    )
    for limit in LIST_STEPS:
        truncated: list[int] = []
        trimmed = _trim(result, limit, truncated)
        if caveats:
            trimmed["caveats"] = caveats
        if truncated:
            trimmed["_truncated"] = f"{sum(truncated)} more rows were left out; say the list is partial."
        if len(json.dumps(trimmed, default=str)) <= MAX_CHARS:
            return trimmed
    return trimmed  # still large after the shortest lists: send it, the model copes, and the engine logs it
