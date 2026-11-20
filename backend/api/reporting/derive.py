"""Derived reports: a new catalog entry that reuses an existing report's logic with some filters fixed.

The 2026-11-19 Report Center layout (layout.py) names reports such as "Staff Time Card Report" and "Production
Attendance Log Report" that are an existing report run for one kind of employee. Instead of copying the logic,
``derive()`` registers a new ReportSpec whose run() pins those parameters and then calls the base report's run():

    derive(
        "time-card",                       # the base report id (its module must be imported first)
        id="staff-time-card-report",
        title="Staff Time Card Report",
        description="...",
        category="attendance",
        pin={"employment_type": "staff"},  # PARSED params (filters.parse_params keys) forced before the base runs
        drop=("employmentType",),          # filter keys hidden from this entry (normally the pinned ones)
        defaults={"employeeStatus": "active"},  # optional: other default values for kept filters
    )

``pin`` uses the parsed parameter names (employment_type, employee_status, the select/boolean filter keys ...), so a
pinned value can never be overridden from the query string: the pinned filter is not declared on the derived spec, so
parse_params ignores the query value, and run() writes the pinned value last. Anything else (columns, notes, builders,
limits, modules) is inherited unless given.
"""

from __future__ import annotations

import dataclasses
from typing import Any

from .filters import ReportContext
from .registry import get_spec, register
from .types import ReportResult, ReportSpec

_UNSET = object()


def base_spec(report_id: str) -> ReportSpec:
    spec = get_spec(report_id)
    if spec is None:
        raise LookupError(f"derive: base report {report_id!r} is not registered (import its module first)")
    return spec


def derive(
    base_id: str,
    *,
    id: str,
    title: str,
    description: str,
    category: str,
    pin: dict[str, Any] | None = None,
    drop: tuple[str, ...] = (),
    defaults: dict[str, Any] | None = None,
    **overrides: Any,
) -> ReportSpec:
    base = base_spec(base_id)
    pinned = dict(pin or {})
    new_defaults = dict(defaults or {})
    filters = []
    for f in base.filters:
        if f.key in drop:
            continue
        if f.key in new_defaults:
            f = dataclasses.replace(f, default=new_defaults[f.key])
        filters.append(f)

    base_run = base.run

    def run(ctx: ReportContext) -> ReportResult:
        ctx.params.update(pinned)
        return base_run(ctx)

    fields = {
        "id": id,
        "title": title,
        "description": description,
        "category": category,
        "filters": tuple(filters),
        "run": run,
        # a derived entry is a single report unless the caller builds a family on purpose
        "family": None,
        "variant": None,
    }
    fields.update(overrides)
    spec = dataclasses.replace(base, **fields)
    return register(spec)
