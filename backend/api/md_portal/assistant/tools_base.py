"""How an analytics module offers its figures to the AI assistant.

The assistant never reads the database on its own: it calls *tools*, and every tool is an existing analytics function
(the same one the MD's page uses), so a number the assistant quotes is the number on the page. A module ends with

    TOOLS = [
        tool(
            "attendance_summary",
            "Attendance for a period: attendance %, absenteeism %, late arrivals, overtime. Use for 'how was attendance'.",
            attendance_summary,                 # fn(scope=..., period=..., **extra) -> envelope dict
            page="attendance",
            period="last_30_days",              # the default period; None = the tool takes no period
        ),
        tool(
            "attendance_worst_departments",
            "The departments with the lowest attendance in a period.",
            worst_departments,
            page="attendance",
            extra={"limit": integer_param("How many departments (default 5)", minimum=1, maximum=20)},
            defaults={"limit": 5},
        ),
    ]

Rules for a tool's result (the engine enforces a size limit and the privacy layer, but design for them):
  * return the module's ``envelope(...)`` dict, with ``provenance`` entries filled in (what the figure means, the
    formula, how many rows stand behind it): the assistant's "how I got this" is built from them;
  * keep lists short (a ``limit`` parameter, default 5-10, hard maximum 25) and aggregate first: a total and a top-N,
    not every employee;
  * put people's names in the fields listed in ``person_fields`` (plus the standard ``name`` / ``employeeName`` /
    ``fullName`` keys), so the privacy layer can pseudonymise them before anything is sent to Gemini;
  * be read-only: tools run inside ``common.read_only_db()`` and the database rejects writes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..common import MdParamError, resolve_period, resolve_scope

# ─── parameter schemas (the OpenAPI-3.0 subset that Gemini function declarations accept) ─────────────────────


def string_param(description: str, *, enum: list[str] | None = None) -> dict:
    out: dict = {"type": "string", "description": description}
    if enum:
        out["enum"] = list(enum)
    return out


def integer_param(description: str, *, minimum: int | None = None, maximum: int | None = None) -> dict:
    out: dict = {"type": "integer", "description": description}
    if minimum is not None:
        out["minimum"] = minimum
    if maximum is not None:
        out["maximum"] = maximum
    return out


def number_param(description: str, *, minimum: float | None = None, maximum: float | None = None) -> dict:
    out: dict = {"type": "number", "description": description}
    if minimum is not None:
        out["minimum"] = minimum
    if maximum is not None:
        out["maximum"] = maximum
    return out


def boolean_param(description: str) -> dict:
    return {"type": "boolean", "description": description}


# These are repeated in EVERY tool declaration, so they are kept to a few words each: the long explanation (which
# periods exist, what a unit/department is) is in the system prompt once (prompts.COMMON_PARAMETERS), and a wrong value
# is answered with a corrective error the model can act on. At ~50 tools the long form cost ~12k tokens per request.
PERIOD_PROPERTIES: dict[str, dict] = {
    "period": {"type": "string", "description": "named period"},
    "from": {"type": "string", "description": "YYYY-MM-DD"},
    "to": {"type": "string", "description": "YYYY-MM-DD"},
    "month": {"type": "string", "description": "YYYY-MM"},
}

SCOPE_PROPERTIES: dict[str, dict] = {
    "branch": {"type": "string", "description": "unit name or id"},
    "department": {"type": "string", "description": "department name or id"},
    "type": {"type": "string", "enum": ["staff", "production"]},
}

NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,59}$")

# Standard keys the privacy layer treats as a person's name wherever they appear in a tool result.
STANDARD_PERSON_FIELDS = ("name", "employeeName", "fullName", "userName", "visitorName", "managerName")


# ─── coercion: the model sends strings for numbers and booleans more often than it should ────────────────────


def coerce(name: str, schema: dict, value: Any) -> Any:
    kind = schema.get("type", "string")
    try:
        if kind == "integer":
            number = int(float(value))
            lo, hi = schema.get("minimum"), schema.get("maximum")
            if lo is not None:
                number = max(lo, number)
            if hi is not None:
                number = min(hi, number)
            return number
        if kind == "number":
            return float(value)
        if kind == "boolean":
            if isinstance(value, str):
                return value.strip().lower() in ("true", "yes", "1")
            return bool(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a {kind}, got '{value}'.") from None
    text = str(value).strip()
    enum = schema.get("enum")
    if enum and text not in enum:
        lowered = {e.lower(): e for e in enum}
        if text.lower() in lowered:
            return lowered[text.lower()]
        raise MdParamError(f"'{name}' must be one of: {', '.join(enum)}.")
    return text


# ─── the tool ────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    properties: dict
    required: tuple[str, ...]
    run: Callable[[dict], dict]
    page: str
    person_fields: tuple[str, ...] = ()
    #: ``None`` when the tool takes no period (a "right now" figure).
    default_period: str | None = None
    uses_scope: bool = True
    extra: dict = field(default_factory=dict)
    #: Arguments a test can call the tool with (required for a tool that has required parameters).
    example: dict = field(default_factory=dict)

    def declaration(self) -> dict:
        """The Gemini ``functionDeclaration`` for this tool."""
        parameters: dict = {"type": "object", "properties": self.properties}
        if self.required:
            parameters["required"] = list(self.required)
        return {"name": self.name, "description": self.description, "parameters": parameters}


def tool(
    name: str,
    description: str,
    fn: Callable[..., dict],
    *,
    page: str,
    period: str | None = None,
    scope: bool = True,
    extra: dict[str, dict] | None = None,
    required: tuple[str, ...] = (),
    defaults: dict[str, Any] | None = None,
    person_fields: tuple[str, ...] = (),
    example: dict[str, Any] | None = None,
) -> ToolSpec:
    """Offer ``fn`` to the assistant. ``fn`` is called with keyword arguments only: ``period=`` (a Period, when
    ``period`` is given), ``scope=`` (a Scope, when ``scope`` is true) and one per ``extra`` parameter the model
    supplied (or its ``defaults`` value). ``period`` is the DEFAULT period (a preset name) for when the model gives none.
    """
    extra = extra or {}
    defaults = defaults or {}
    properties: dict[str, dict] = {}
    if period:
        properties.update(PERIOD_PROPERTIES)
    if scope:
        properties.update(SCOPE_PROPERTIES)
    overlap = set(extra) & set(properties)
    if overlap:
        raise ValueError(f"tool {name}: extra parameters {sorted(overlap)} clash with the period/scope ones")
    properties.update(extra)
    unknown_required = set(required) - set(properties)
    if unknown_required:
        raise ValueError(f"tool {name}: required {sorted(unknown_required)} is not a parameter")

    def run(args: dict) -> dict:
        args = {k: v for k, v in (args or {}).items() if v not in (None, "")}
        kwargs: dict[str, Any] = {}
        if period:
            kwargs["period"] = resolve_period(args, default=period)
        if scope:
            kwargs["scope"] = resolve_scope(args)
        for key, schema in extra.items():
            if key in args:
                kwargs[key] = coerce(key, schema, args[key])
            elif key in defaults:
                kwargs[key] = defaults[key]
            elif key in required:
                raise MdParamError(f"'{key}' is required.")
        return fn(**kwargs)

    return ToolSpec(
        name=name,
        description=description,
        properties=properties,
        required=tuple(required),
        run=run,
        page=page,
        person_fields=tuple(person_fields),
        default_period=period,
        uses_scope=scope,
        extra=extra,
        example=dict(example or {}),
    )
