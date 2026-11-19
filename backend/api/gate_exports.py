"""
Excel / PDF files of the Gate Pass, Visitors, Tea Break and gate monitor pages, made by the Report Center's own writers
(reporting/export_xlsx.build_xlsx, reporting/export_pdf.build_pdf, letterhead from reporting/branding) so they look
exactly like Report Center files. A page builds its rows itself (its own filters, its own permission key) and hands
them here; this module never queries anything but the letterhead.

    file_response(request, slug=..., title=..., columns=[{"key", "label", "type"}], rows=[{key: value}], fmt=...)

Column types: "text" | "int" | "datetime" | "date" | "minutes" (also "time", "duration", "number", "badge").
Values: datetime = an aware datetime (shown in IST) or an IST "YYYY-MM-DD HH:MM" string; date = a date or "YYYY-MM-DD";
None = a dash. Limits as in the Report Center: 30,000 rows for Excel, 5,000 for PDF; above that the answer is 413
{"error": "too_many_rows", "message", "limit"} and no file. Every file is audit-logged (log_action "export").
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime

from django.http import HttpResponse
from rest_framework.response import Response

from .audit_utils import log_action
from .clock import ist_now
from .reporting.export_pdf import build_pdf
from .reporting.export_xlsx import build_xlsx
from .reporting.filters import ReportContext
from .reporting.formatting import fmt_dt
from .reporting.runner import PDF_ROW_LIMIT, XLSX_ROW_LIMIT, RunOutput, normalise_rows
from .reporting.types import (
    BADGE,
    DATE,
    DATETIME,
    DURATION,
    INTEGER,
    MINUTES,
    NUMBER,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)

logger = logging.getLogger(__name__)

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF_MIME = "application/pdf"
FORMATS = ("xlsx", "pdf")
ROW_LIMITS = {"xlsx": XLSX_ROW_LIMIT, "pdf": PDF_ROW_LIMIT}
TOO_MANY_ROWS_MESSAGE = "Too many rows for one file. Narrow the dates."

_TYPES = {
    "text": TEXT,
    "int": INTEGER,
    "integer": INTEGER,
    "number": NUMBER,
    "datetime": DATETIME,
    "date": DATE,
    "time": TIME,
    "minutes": MINUTES,
    "duration": DURATION,
    "badge": BADGE,
}
_SLUG = re.compile(r"[^a-z0-9]+")


def export_format(value) -> str | None:
    """The format of a ?fmt= value: "xlsx" or "pdf" (any case), None when it is neither."""
    fmt = str(value or "").strip().lower()
    return fmt if fmt in FORMATS else None


def bad_format_response() -> Response:
    return Response({"error": "invalid_format", "message": "Choose Excel (xlsx) or PDF."}, status=400)


def too_many_rows_response(limit: int) -> Response:
    return Response({"error": "too_many_rows", "message": TOO_MANY_ROWS_MESSAGE, "limit": limit}, status=413)


def _column(c: dict) -> ColumnSpec:
    kind = _TYPES.get(str(c.get("type") or "text").lower())
    if kind is None:
        raise ValueError(f"column {c.get('key')!r}: unknown type {c.get('type')!r}")
    return ColumnSpec(str(c["key"]), str(c["label"]), kind, float(c.get("width") or 1.0))


def _cell(kind: str, value):
    """A value in the shape the Report Center writers expect for its column type."""
    if value is None or value == "":
        return None
    if kind == DATETIME and isinstance(value, datetime):
        return fmt_dt(value)
    if kind == DATE and isinstance(value, datetime):
        return value.date().isoformat()
    if kind == DATE and isinstance(value, date):
        return value.isoformat()
    return value


def _filters(filters_text) -> list[tuple[str, str]]:
    """(label, value) pairs for the file's filters line, from pairs or a "Label: value | Label: value" string."""
    if not filters_text:
        return []
    if isinstance(filters_text, str):
        segments = [s.strip() for s in filters_text.split("|") if s.strip()]
        if segments and all(": " in s for s in segments):
            return [tuple(s.split(": ", 1)) for s in segments]
        return [("Filters", filters_text.strip())]
    return [(str(k), "" if v is None else str(v)) for k, v in filters_text]


def _summary(summary) -> list[dict]:
    if not summary:
        return []
    items = summary.items() if isinstance(summary, dict) else None
    if items is not None:
        return [{"label": str(k), "value": v, "format": INTEGER} for k, v in items]
    out = []
    for s in summary:
        fmt = _TYPES.get(str(s.get("format") or "int").lower(), INTEGER)
        out.append({"label": str(s["label"]), "value": s.get("value"), "format": fmt})
    return out


def _generated_by(request) -> str:
    user = getattr(request, "jwt_user", None) or {}
    if user.get("role") == "gate_device":
        gate = getattr(request, "gate_device", None)
        return f"Gate monitor - {gate.name if gate is not None else user.get('gateName') or 'gate'}"
    if user.get("role") == "reception_device":
        desk = getattr(request, "reception_device", None)
        return f"Reception desk - {desk.name if desk is not None else user.get('deskName') or 'desk'}"
    from .reporting.access import hr_display_name

    return hr_display_name(request)


def build_file(
    *,
    title: str,
    columns: list[dict],
    rows: list[dict],
    fmt: str,
    filters_text="",
    summary=None,
    notes=None,
    generated_by: str = "HR",
    request=None,
) -> bytes:
    """The file's bytes (no HTTP, no limit check, no audit row): for a caller that attaches or stores the file."""
    cols = [_column(c) for c in columns]
    spec = ReportSpec(
        id="gate-export",
        title=title,
        description="",
        category="gate",
        filters=(),
        columns=tuple(cols),
        run=lambda ctx: ReportResult(rows=[]),
        landscape=True,
    )
    kinds = {c.key: c.type for c in cols}
    data = [{k: _cell(kinds[k], r.get(k)) for k in kinds} for r in rows]
    limit = ROW_LIMITS.get(fmt, XLSX_ROW_LIMIT)
    out = RunOutput(
        spec=spec,
        ctx=ReportContext(request=request, spec=spec, params={}, row_limit=limit, purpose=fmt),
        columns=cols,
        rows=normalise_rows(cols, data),
        totals=None,
        summary=_summary(summary),
        notes=[str(n) for n in (notes or [])],
        filters=_filters(filters_text),
        generated_at=ist_now().strftime("%Y-%m-%d %H:%M"),
        generated_by=generated_by,
        truncated=False,
        limit=limit,
        row_count=len(data),
    )
    return build_xlsx(out) if fmt == "xlsx" else build_pdf(out)


def file_response(
    request,
    *,
    slug: str,
    title: str,
    columns: list[dict],
    rows: list[dict],
    fmt,
    filters_text="",
    summary=None,
    log_module: str = "outpass_visitors",
    log_description: str | None = None,
    notes=None,
):
    """The Excel / PDF download of `rows`, or a 400 (fmt is not xlsx / pdf) / 413 (too many rows) / 500 JSON answer.

    slug: the file name's start (made safe; "<slug>_<YYYYmmdd_HHMM>.<ext>", IST). title: the file's heading.
    filters_text: (label, value) pairs or a "Label: value | Label: value" string, shown under the title. summary: the
    headline figures ([{"label", "value", "format"?}] or {label: value}), shown above the PDF table. notes: footnotes.
    Pass at most one more row than the limit (gate_records.EXPORT_FETCH_LIMIT) so a huge table is never read whole.
    Audit: log_action(request, "export", log_module, description=log_description or "<title> - XLSX - <n> rows - ...")."""
    fmt = export_format(fmt)
    if fmt is None:
        return bad_format_response()
    limit = ROW_LIMITS[fmt]
    if len(rows) > limit:
        return too_many_rows_response(limit)
    try:
        content = build_file(
            title=title,
            columns=columns,
            rows=rows,
            fmt=fmt,
            filters_text=filters_text,
            summary=summary,
            notes=notes,
            generated_by=_generated_by(request),
            request=request,
        )
    except Exception:
        logger.exception("gate export %s (%s) failed", slug, fmt)
        return Response(
            {"error": "export_failed", "message": "The file could not be made. Please try again."}, status=500
        )

    pairs = _filters(filters_text)
    described = "; ".join(f"{k}: {v}" for k, v in pairs) or "no filters"
    log_action(
        request,
        "export",
        log_module,
        description=(log_description or f"{title} - {fmt.upper()} - {len(rows)} rows - {described}")[:480],
    )
    safe = _SLUG.sub("_", str(slug).lower()).strip("_") or "export"
    stamp = ist_now().strftime("%Y%m%d_%H%M")
    resp = HttpResponse(content, content_type=XLSX_MIME if fmt == "xlsx" else PDF_MIME)
    resp["Content-Disposition"] = f'attachment; filename="{safe}_{stamp}.{fmt}"'
    resp["Cache-Control"] = "no-store"
    return resp
