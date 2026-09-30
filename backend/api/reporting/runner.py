"""Run a ReportSpec against the database and normalise the outcome for the UI and the exporters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from api.branch_scope import get_branch_scope
from api.clock import ist_now

from .filters import ReportContext, describe_params, parse_params
from .formatting import json_safe
from .types import ColumnSpec, ReportSpec

# Measured on a dev laptop: ~1 ms/row for PDF, ~0.25 ms/row for Excel (12 columns). Railway runs gunicorn with
# a 30 s worker timeout and is slower, so these keep the worst export comfortably inside it.
SCREEN_ROW_LIMIT = 10_000
XLSX_ROW_LIMIT = 30_000
PDF_ROW_LIMIT = 5_000

# Rows a definition may emit to mark structure; the UI and exports style them.
KIND_SUBTOTAL = "subtotal"
KIND_TOTAL = "total"
_STRUCTURAL = (KIND_SUBTOTAL, KIND_TOTAL)


@dataclass
class RunOutput:
    spec: ReportSpec
    ctx: ReportContext
    columns: list[ColumnSpec]
    rows: list[dict]
    totals: dict[str, Any] | None
    summary: list[dict]
    notes: list[str]
    filters: list[tuple[str, str]]
    generated_at: str
    generated_by: str
    truncated: bool = False
    limit: int = 0
    row_count: int = 0

    def payload(self) -> dict:
        return {
            "id": self.spec.id,
            "title": self.spec.title,
            "category": self.spec.category,
            "generatedAt": self.generated_at,
            "generatedBy": self.generated_by,
            "filters": [{"label": k, "value": v} for k, v in self.filters],
            "columns": [column_json(c) for c in self.columns],
            "rows": self.rows,
            "totals": self.totals,
            "summary": self.summary,
            "notes": self.notes,
            "rowCount": self.row_count,
            "truncated": self.truncated,
            "limit": self.limit,
        }


def column_json(c: ColumnSpec) -> dict:
    return {"key": c.key, "label": c.label, "type": c.type, "width": c.width, "total": c.total, "align": c.align}


def limit_for(spec: ReportSpec, purpose: str) -> int:
    if purpose == "xlsx":
        return XLSX_ROW_LIMIT
    if purpose == "pdf":
        return spec.pdf_max_rows or PDF_ROW_LIMIT
    return spec.screen_limit or SCREEN_ROW_LIMIT


def normalise_rows(columns: list[ColumnSpec], rows: list[dict]) -> list[dict]:
    """Keep only declared columns (a definition can never leak an extra field), make every
    value JSON-safe, and keep the structural ``_kind`` marker."""
    keys = [c.key for c in columns]
    out: list[dict] = []
    for r in rows:
        clean = {k: json_safe(r.get(k)) for k in keys}
        kind = r.get("_kind")
        if kind in _STRUCTURAL:
            clean["_kind"] = kind
        out.append(clean)
    return out


def compute_totals(columns: list[ColumnSpec], rows: list[dict]) -> dict[str, Any] | None:
    wanted = [c for c in columns if c.total]
    if not wanted:
        return None
    data_rows = [r for r in rows if r.get("_kind") not in _STRUCTURAL]
    totals: dict[str, Any] = {}
    for c in wanted:
        vals = [
            r[c.key] for r in data_rows if isinstance(r.get(c.key), (int, float)) and not isinstance(r.get(c.key), bool)
        ]
        if c.total == "count":
            totals[c.key] = len([r for r in data_rows if r.get(c.key) not in (None, "")])
        elif not vals:
            totals[c.key] = None
        elif c.total == "avg":
            totals[c.key] = round(sum(vals) / len(vals), 2)
        else:
            s = sum(vals)
            totals[c.key] = int(s) if c.type in ("integer", "minutes", "duration") else round(s, 2)
    return totals


def run_report(request, spec: ReportSpec, query, purpose: str = "screen") -> RunOutput:
    """Parse + validate filters, run the report, normalise. Raises ReportParamError on bad input."""
    from .access import hr_display_name

    params = parse_params(spec, query)
    limit = limit_for(spec, purpose)
    ctx = ReportContext(request=request, spec=spec, params=params, row_limit=limit + 1, purpose=purpose)
    result = spec.run(ctx)

    columns = list(result.columns) if result.columns else list(spec.columns)
    rows = normalise_rows(columns, result.rows)
    # The limit counts DATA rows: subtotal/total lines are furniture and must not push a complete list over it.
    data_rows = sum(1 for r in rows if r.get("_kind") not in _STRUCTURAL)
    truncated = data_rows > limit
    if truncated:
        kept, n = [], 0
        for r in rows:
            if r.get("_kind") not in _STRUCTURAL:
                if n >= limit:
                    break
                n += 1
            kept.append(r)
        rows = kept
    has_data = any(r.get("_kind") not in _STRUCTURAL for r in rows)
    if not has_data:
        totals = None  # a lone TOTAL row of dashes under "no records" is noise
    elif result.totals is not None:
        totals = result.totals
    elif truncated:
        totals = None  # a sum over a cut-off list would silently under-state the real figure
    else:
        totals = compute_totals(columns, rows)
    if totals is not None:
        totals = {k: json_safe(v) for k, v in totals.items()}
    summary = [
        {"label": str(s["label"]), "value": json_safe(s.get("value")), "format": s.get("format", "integer")}
        for s in (result.summary or [])
    ]
    now: datetime = ist_now()
    return RunOutput(
        spec=spec,
        ctx=ctx,
        columns=columns,
        rows=rows,
        totals=totals,
        summary=summary,
        notes=list(result.notes or []),
        filters=describe_params(spec, params, get_branch_scope(request)),
        generated_at=now.strftime("%Y-%m-%d %H:%M"),
        generated_by=hr_display_name(request),
        truncated=truncated,
        limit=limit,
        row_count=len(rows),
    )
