"""The table of every tool the assistant may call: each analytics module's ``TOOLS`` plus the generic ones."""

from __future__ import annotations

import importlib
from functools import lru_cache

from .tools_base import NAME_PATTERN, ToolSpec

#: The analytics modules that offer tools, in the order the model sees them.
TOOL_MODULES = (
    "dashboard",
    "attendance",
    "employees",
    "visitors",
    "tea_break",
    "payroll",
    "recruitment",
    "activity",
)


def _module_tools(module: str) -> list[ToolSpec]:
    path = f"api.md_portal.analytics.{module}"
    try:
        mod = importlib.import_module(path)
    except ModuleNotFoundError as exc:
        if exc.name == path:  # the module is not written yet: no tools from it. A real import error is not hidden.
            return []
        raise
    return list(getattr(mod, "TOOLS", []))


@lru_cache(maxsize=1)
def collect_tools() -> dict[str, ToolSpec]:
    """name -> ToolSpec for every analytics tool. Raises on a duplicate or malformed name so a mistake is found at
    start-up (tests_md_tools_contract walks this table), not when the MD asks a question."""
    tools: dict[str, ToolSpec] = {}
    for module in TOOL_MODULES:
        for spec in _module_tools(module):
            if not NAME_PATTERN.match(spec.name):
                raise ValueError(f"tool name '{spec.name}' ({module}) must be snake_case, 3-60 characters")
            if spec.name in tools:
                raise ValueError(f"tool '{spec.name}' is defined twice")
            tools[spec.name] = spec
    return tools


def all_tools() -> dict[str, ToolSpec]:
    """Every tool the assistant may call, except the query language (which has its own declaration): the analytics
    modules' tools plus the generic ones (finding a report)."""
    from .report_tools import GENERIC_TOOLS

    tools = dict(collect_tools())
    for spec in GENERIC_TOOLS:
        if spec.name in tools:
            raise ValueError(f"tool '{spec.name}' is defined twice")
        tools[spec.name] = spec
    return tools


def clear_cache() -> None:
    collect_tools.cache_clear()
