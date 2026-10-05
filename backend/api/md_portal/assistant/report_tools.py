"""A tool that lets the assistant answer "which report shows X?": it searches the Report Center's catalog.

The assistant never runs a report (that is the MD's own action on the Reports page); it finds the right one and says
where it is, so "Which report shows overtime by department?" gets an answer that points at something real.
"""

from __future__ import annotations

import re

from rapidfuzz import fuzz

from ..common import envelope, prov
from .tools_base import integer_param, string_param, tool

_STOP = {
    "a",
    "an",
    "the",
    "of",
    "by",
    "for",
    "in",
    "on",
    "to",
    "show",
    "shows",
    "me",
    "my",
    "report",
    "reports",
    "which",
    "what",
    "is",
    "are",
    "and",
    "or",
    "with",
    "get",
    "give",
    "list",
}


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if w not in _STOP and len(w) > 1}


def _score(query_words: set[str], spec, category_label: str) -> float:
    title, tags, description = _words(spec.title), _words(" ".join(spec.tags)), _words(spec.description)
    category = _words(category_label)
    score = 0.0
    for word in query_words:
        if word in title:
            score += 3
        elif any(fuzz.ratio(word, t) >= 85 for t in title):
            score += 2  # a small typo ("overtme")
        if word in tags:
            score += 2
        if word in description:
            score += 1
        if word in category:
            score += 1
    return score


def find_reports(*, query: str, limit: int = 6) -> dict:
    from ...reporting.registry import all_specs
    from ...reporting.types import CATEGORIES

    labels = {c[0]: c[1] for c in CATEGORIES}
    specs = all_specs()
    words = _words(query)
    ranked = sorted(
        ((_score(words, s, labels.get(s.category, s.category)), s) for s in specs),
        key=lambda pair: (-pair[0], pair[1].title),
    )
    matches = [pair for pair in ranked if pair[0] > 0][:limit]
    return envelope(
        {
            "query": query,
            "reports": [
                {
                    "id": s.id,
                    "title": s.title,
                    "category": labels.get(s.category, s.category),
                    "description": s.description,
                    "executive": s.md_only,
                    "where": f"Reports page, then open '{s.title}' (/md/reports?report={s.id})",
                }
                for _, s in matches
            ],
            "matches": len(matches),
        },
        provenance=[
            prov(
                "report-catalog",
                "Report Center catalog",
                dataset="The built-in report definitions",
                definition="Reports ranked by how well their title, tags, description and category match the words asked for.",
                rows=len(specs),
                caveats=["This only finds reports; it does not run them. Open the report to see the numbers."],
            )
        ],
    )


FIND_REPORTS = tool(
    "find_reports",
    "Find which built-in report answers a question such as 'which report shows overtime by department?'. Returns the best "
    "matching reports with where to open them. It does not run the report or return its numbers.",
    find_reports,
    page="reports",
    scope=False,
    extra={
        "query": string_param("What the MD wants to see, in a few words (for example 'overtime by department')."),
        "limit": integer_param("How many reports to return (default 6)", minimum=1, maximum=10),
    },
    required=("query",),
    defaults={"limit": 6},
    example={"query": "overtime"},
)

GENERIC_TOOLS = (FIND_REPORTS,)
