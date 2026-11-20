"""From a builder choice (data source + fields + filters + sort) to a ReportSpec the Report Center runs and exports.

Used by the preview endpoint (id ``custom-preview``, 200 rows) and by every saved report (``custom-<id>``): the rows come
from the data source's loader, the columns are the chosen fields in the chosen order, the filters are the data source's
(their defaults are the saved values for a saved report), and the standard runner / Excel / PDF writers do the rest.

Field access: a field whose modules the user cannot view is never offered (``dataset_json``), is refused with
``field_forbidden`` in preview / save, and is dropped with a note when a saved report that has it is opened.
"""

from __future__ import annotations

import dataclasses
import threading
from dataclasses import dataclass
from datetime import date
from typing import Any

from .. import filters as report_filters
from ..access import permission_level
from ..export_pdf import build_pdf
from ..filters import ReportParamError, parse_params, resolve_default
from ..formatting import parse_date, parse_period
from ..runner import XLSX_ROW_LIMIT
from ..types import (
    F_BOOLEAN,
    F_BRANCH,
    F_DATE_RANGE,
    F_DEPARTMENT,
    F_DESIGNATION,
    F_EMPLOYEE,
    F_EMPLOYEE_STATUS,
    F_EMPLOYMENT_TYPE,
    F_NUMBER,
    F_PERIOD,
    F_SELECT,
    F_TEXT,
    F_YEAR,
    FilterSpec,
    ReportResult,
    ReportSpec,
)
from .fields import Dataset, Field

CUSTOM_PREFIX = "custom-"
PREVIEW_ID = "custom-preview"
PREVIEW_ROWS = 200
MAX_FIELDS = 100
MAX_SORT_KEYS = 3
# A sorted report sorts the whole list before it is cut to the screen / file ceiling: the loader may return up to this
# many rows (the Excel ceiling) for a saved report, fewer for the preview so it stays quick.
SORT_CEILING = XLSX_ROW_LIMIT + 1
PREVIEW_SORT_CEILING = 5_000
# PDF: landscape always; A3 from this many columns (the framework switches at 18)
A3_FROM_COLUMNS = 13

ID_PARAMS = {
    F_DEPARTMENT: "departmentIds",
    F_DESIGNATION: "designationIds",
    F_BRANCH: "branchIds",
    F_EMPLOYEE: "employeeIds",
}
PERIOD_TOKENS = ("thisMonth", "lastMonth")
RANGE_TOKENS = ("thisMonth", "lastMonth", "today", "yesterday", "last7", "thisWeek")


class CustomError(Exception):
    """A builder request the server refuses: becomes {"error": code, "message", "field"} with the status."""

    def __init__(self, code: str, message: str, field: str | None = None, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.field, self.status = code, message, field, status


# ── access ──────────────────────────────────────────────────────────────────


def can_view(request, modules: tuple[str, ...]) -> bool:
    """View or edit on at least one of ``modules`` (none = no extra requirement); super admin and the MD always."""
    if not modules:
        return True
    return any(permission_level(request, m) in ("view", "edit") for m in modules)


def dataset_open(request, ds: Dataset) -> bool:
    return can_view(request, ds.modules)


def field_open(request, f: Field) -> bool:
    return can_view(request, f.modules)


def visible_fields(request, ds: Dataset) -> list[Field]:
    return [f for f in ds.fields if field_open(request, f)]


def dataset_json(request, ds: Dataset, today: date, branch_scoped: bool) -> dict:
    """The builder's description of a data source, with only the fields this user may use."""
    from ..views import _filter_json  # the catalog's own filter shape (views imports this package: import here)

    fields = visible_fields(request, ds)
    keys = {f.key for f in fields}
    sections = []
    for sid, label in ds.sections:
        items = [f.to_json() for f in fields if f.section == sid]
        if items:
            sections.append({"id": sid, "label": label, "fields": items})
    return {
        "id": ds.id,
        "label": ds.label,
        "description": ds.description,
        "grain": ds.grain,
        "filters": [j for f in ds.filters if (j := _filter_json(f, today, branch_scoped))],
        "sections": sections,
        "defaultFields": [k for k in ds.default_fields if k in keys],
    }


# ── fields and sort ─────────────────────────────────────────────────────────


def parse_fields(raw: Any) -> list[str]:
    """A comma-separated string or a list of field keys -> the keys (order kept)."""
    if isinstance(raw, str):
        keys = [k.strip() for k in raw.split(",") if k.strip()]
    elif isinstance(raw, (list, tuple)):
        if not all(isinstance(k, str) for k in raw):
            raise CustomError("invalid_field", "Fields must be a list of field keys.", "fields")
        keys = [k.strip() for k in raw if k.strip()]
    else:
        raise CustomError("invalid_field", "Choose at least one field.", "fields")
    if not keys:
        raise CustomError("invalid_field", "Choose at least one field.", "fields")
    if len(keys) > MAX_FIELDS:
        raise CustomError("invalid_field", f"A report can have at most {MAX_FIELDS} fields.", "fields")
    if len(set(keys)) != len(keys):
        raise CustomError("invalid_field", "A field is chosen twice.", "fields")
    return keys


def check_fields(request, ds: Dataset, keys: list[str]) -> list[Field]:
    """The Field of every key, or CustomError: invalid_field (not in this data source) / field_forbidden."""
    out = []
    for k in keys:
        f = ds.field(k)
        if f is None:
            raise CustomError("invalid_field", f"'{k[:60]}' is not a field of {ds.label}.", "fields")
        if not field_open(request, f):
            raise CustomError(
                "field_forbidden", f"Your role does not have access to the data of the field '{f.label}'.", "fields"
            )
        out.append(f)
    return out


def parse_sort(raw: Any, keys: list[str]) -> list[dict]:
    """'key:asc,key2:desc' or [{"key", "dir"}] -> [{"key", "dir"}]; every key must be one of the chosen fields."""
    items: list[tuple[str, str]] = []
    if raw in (None, "", []):
        return []
    if isinstance(raw, str):
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            key, _sep, direction = part.partition(":")
            items.append((key.strip(), (direction or "asc").strip().lower()))
    elif isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                raise CustomError("invalid_sort", "Sort must be a list of {key, dir}.", "sort")
            items.append((str(entry.get("key") or "").strip(), str(entry.get("dir") or "asc").strip().lower()))
    else:
        raise CustomError("invalid_sort", "Sort must be a list of {key, dir}.", "sort")
    if len(items) > MAX_SORT_KEYS:
        raise CustomError("invalid_sort", f"Sort by at most {MAX_SORT_KEYS} fields.", "sort")
    out, seen = [], set()
    for key, direction in items:
        if key not in keys:
            raise CustomError("invalid_sort", "Sort only by fields that are in the report.", "sort")
        if direction not in ("asc", "desc"):
            raise CustomError("invalid_sort", "Sort direction must be asc or desc.", "sort")
        if key in seen:
            raise CustomError("invalid_sort", "A field is sorted twice.", "sort")
        seen.add(key)
        out.append({"key": key, "dir": direction})
    return out


def _sort_value(v):
    if isinstance(v, bool):
        return (0, int(v))
    if isinstance(v, (int, float)):
        return (0, v)
    return (1, str(v).casefold())


def apply_sort(rows: list[dict], sort: list[dict]) -> list[dict]:
    """Stable multi-key sort; blanks always last, whatever the direction."""
    for item in reversed(sort):
        key, desc = item["key"], item["dir"] == "desc"
        filled = [r for r in rows if r.get(key) not in (None, "")]
        blank = [r for r in rows if r.get(key) in (None, "")]
        filled.sort(key=lambda r: _sort_value(r[key]), reverse=desc)
        rows = filled + blank
    return rows


# ── filters ─────────────────────────────────────────────────────────────────


def normalise_filters(ds: Dataset, raw: Any) -> dict[str, str]:
    """Saved filter values in the query-parameter format, checked against the data source's filters (ReportParamError
    on a bad value). Only the parameters the data source understands are kept; a relative period / range may be saved
    as a token (period "thisMonth" | "lastMonth"; "dateRange": "thisMonth" | "lastMonth" | "today" | ...).

    Also understood, so the form's own values can be sent as they are: a filter's key instead of its parameter name
    ("department": [1, 2] for departmentIds) and "dateRange": {"dateFrom", "dateTo"}."""
    if raw in (None, ""):
        raw = {}
    if not isinstance(raw, dict):
        raise ReportParamError("Filters must be an object of filter values.", "filters")
    out: dict[str, str] = {}

    def text_of(value) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (list, tuple)):
            return ",".join(str(v).strip() for v in value if str(v).strip())
        return "" if value is None else str(value).strip()

    for f in ds.filters:
        if f.kind == F_DATE_RANGE:
            given = raw.get(f.key) if isinstance(raw.get(f.key), dict) else raw
            a, b = text_of(given.get("dateFrom")), text_of(given.get("dateTo"))
            token = "" if given is not raw else text_of(raw.get(f.key))
            if a or b:
                out["dateFrom"], out["dateTo"] = a, b
            elif token:
                if token not in RANGE_TOKENS:
                    raise ReportParamError("Date range is not valid", "dateFrom")
                out["dateRange"] = token
        elif f.kind == F_PERIOD:
            v = text_of(raw.get("period"))
            if v:
                out["period"] = v
        elif f.kind in ID_PARAMS:
            name = ID_PARAMS[f.kind]
            v = text_of(raw.get(name) if name in raw else raw.get(f.key))
            if v:
                out[ID_PARAMS[f.kind]] = v
        else:
            name = f.kind if f.kind in (F_YEAR, F_EMPLOYMENT_TYPE, F_EMPLOYEE_STATUS) else f.key
            v = text_of(raw.get(name) if name in raw else raw.get(f.key))
            if v:
                out[name] = v
    # validate exactly as a run would (tokens resolved first)
    query = dict(out)
    if query.get("period") in PERIOD_TOKENS:
        query.pop("period")
    query.pop("dateRange", None)
    spec = ReportSpec(
        id=PREVIEW_ID,
        title="check",
        description="",
        category="customise",
        filters=ds.filters,
        columns=(),
        run=lambda ctx: ReportResult(rows=[]),
    )
    parse_params(spec, query)
    return out


def saved_filters(ds: Dataset, saved: dict) -> tuple[FilterSpec, ...]:
    """The data source's filters with the SAVED values as their defaults (what the catalog shows and a run without that
    parameter uses). A value that no longer fits (an option that was removed) keeps the filter's own default."""
    saved = saved or {}
    out = []
    for f in ds.filters:
        default = f.default
        if f.kind == F_PERIOD:
            v = str(saved.get("period") or "")
            if v in PERIOD_TOKENS or parse_period(v):
                default = v
        elif f.kind == F_YEAR:
            v = str(saved.get("year") or "")
            if v.isdigit():
                default = int(v)
        elif f.kind == F_DATE_RANGE:
            a, b = parse_date(saved.get("dateFrom")), parse_date(saved.get("dateTo"))
            if a and b:
                default = {"dateFrom": a.isoformat(), "dateTo": b.isoformat()}
            elif saved.get("dateRange") in RANGE_TOKENS:
                default = saved["dateRange"]
        elif f.kind in ID_PARAMS:
            ids = [int(p) for p in str(saved.get(ID_PARAMS[f.kind]) or "").split(",") if p.strip().isdigit()]
            default = ids
        elif f.kind in (F_EMPLOYMENT_TYPE, F_EMPLOYEE_STATUS):
            v = str(saved.get(f.kind) or "")
            if v and (not f.options or v in {o for o, _l in f.options}):
                default = v
            elif f.kind == F_EMPLOYMENT_TYPE:
                default = None
        elif f.kind == F_SELECT:
            allowed = {o for o, _l in (f.options or ())}
            values = [p.strip() for p in str(saved.get(f.key) or "").split(",") if p.strip() in allowed]
            if values:
                # a multi select's default travels as "a,b" (filters.parse_params splits the text)
                default = ",".join(values) if f.multi else values[0]
        elif f.kind == F_BOOLEAN and f.key in saved:
            default = str(saved.get(f.key)).lower() in ("1", "true", "yes", "on")
        elif f.kind == F_NUMBER and str(saved.get(f.key) or "").lstrip("-").isdigit():
            default = int(saved[f.key])
        elif f.kind == F_TEXT and saved.get(f.key):
            default = str(saved[f.key])[:100]
        out.append(dataclasses.replace(f, default=default) if default != f.default else f)
    return tuple(out)


def _clearable(f: FilterSpec) -> bool:
    """A filter a saved report's viewer may widen to "all" by sending it empty: the id lists, the employee type and an
    optional select (a period, a date range or the employee status always has a value of its own)."""
    return f.kind in ID_PARAMS or f.kind == F_EMPLOYMENT_TYPE or (f.kind == F_SELECT and not f.required)


def _saved_params(f: FilterSpec, today: date) -> dict[str, str]:
    """The query parameters a run uses for ``f`` when the request leaves it out: its default (a saved report's saved
    value, see saved_filters), relative tokens worked out for today."""
    d = resolve_default(f, today)
    kind = f.kind
    if kind == F_DATE_RANGE:
        return {"dateFrom": d["dateFrom"], "dateTo": d["dateTo"]} if d and d.get("dateFrom") and d.get("dateTo") else {}
    if kind in ID_PARAMS:
        return {ID_PARAMS[kind]: ",".join(str(i) for i in d)} if d else {}
    if kind == F_BOOLEAN:
        return {f.key: "true" if d else "false"}
    name = kind if kind in (F_PERIOD, F_YEAR, F_EMPLOYMENT_TYPE, F_EMPLOYEE_STATUS) else f.key
    return {name: str(d)} if d not in (None, "") else {}


@dataclass(frozen=True)
class SavedReportSpec(ReportSpec):
    """A saved report as the Report Center runs it. ``filters`` carry the SAVED values as their defaults (the catalog
    shows them, so the workspace opens with them); ``run_filters`` are the data source's own. A run (``run_inputs``,
    called by runner.run_report) first gives every filter parameter the request leaves OUT its saved value, then reads
    the request with the data source's filters. So:

    * a parameter left out = the saved value: a direct API call or a file export with no filters keeps the saved scope
      (department, designation, unit, employee, employee type, selects, dates ...);
    * a parameter sent EMPTY (``departmentIds=``, ``employmentType=``, ``requestStatus=``) = no filter, "all", whatever
      was saved: the workspace sends that when one of those saved filters is cleared (the catalog marks them
      ``clearable``)."""

    run_filters: tuple[FilterSpec, ...] = ()

    @property
    def clearable_keys(self) -> frozenset[str]:
        return frozenset(f.key for f in self.filters if _clearable(f))

    def run_inputs(self, query, request=None) -> tuple[ReportSpec, dict[str, Any]]:
        from api.branch_scope import get_branch_scope

        today = report_filters.ist_today()
        # a viewer confined to one unit is never offered the unit filter: their unit is the scope, not the saved one
        scoped = request is not None and get_branch_scope(request) is not None
        q: dict[str, Any] = {k: query.get(k) for k in query.keys()}
        for f in self.filters:
            if f.kind == F_BRANCH and scoped:
                continue
            saved = _saved_params(f, today)
            if f.kind == F_DATE_RANGE and ("dateFrom" in q or "dateTo" in q):
                continue  # a range is one choice: either end sent = the request's own range
            for name, value in saved.items():
                q.setdefault(name, value)
        # a plain ReportSpec with the data source's filters: parsed (and echoed) as the request now reads
        spec = ReportSpec(**{f.name: getattr(self, f.name) for f in dataclasses.fields(ReportSpec)})
        return dataclasses.replace(spec, filters=self.run_filters), q


# ── the spec ────────────────────────────────────────────────────────────────

_PDF_LOCK = threading.Lock()


def build_custom_pdf(ctx, out) -> bytes:
    """The standard table PDF (landscape), on A3 from A3_FROM_COLUMNS columns. The framework picks A3 only past 18
    columns, so for the build the page-size choice is swapped for one that also does it for a custom report from 13
    (every other report keeps the framework's own choice even if it builds at the same moment)."""
    from reportlab.lib.pagesizes import A3, landscape

    from .. import export_pdf

    if len(out.columns) < A3_FROM_COLUMNS:
        return build_pdf(out)
    with _PDF_LOCK:
        original = export_pdf._page_size

        def page_size(spec, n_cols):
            if spec.id.startswith(CUSTOM_PREFIX) and n_cols >= A3_FROM_COLUMNS:
                return landscape(A3)
            return original(spec, n_cols)

        export_pdf._page_size = page_size
        try:
            return export_pdf.build_pdf(out)
        finally:
            export_pdf._page_size = original


def build_spec(
    ds: Dataset,
    fields: list[Field],
    sort: list[dict],
    *,
    report_id: str,
    title: str,
    description: str,
    filters: tuple[FilterSpec, ...] | None = None,
    screen_limit: int | None = None,
    sort_ceiling: int = SORT_CEILING,
    extra_notes: tuple[str, ...] = (),
    saved: bool = False,
) -> ReportSpec:
    """The ReportSpec of a builder choice. ``saved``: a saved report (``filters`` = its saved values as defaults), run
    through SavedReportSpec so a parameter left out of a request takes the saved value and an empty one means "all"."""
    keys = [f.key for f in fields]

    def run(ctx) -> ReportResult:
        ceiling = max(ctx.row_limit, sort_ceiling) if sort else ctx.row_limit
        loaded = ds.load(ctx, keys, ceiling)
        rows = loaded.rows
        notes = [*ds.notes, *loaded.notes, *extra_notes]
        if sort:
            rows = apply_sort(rows, sort)[: ctx.row_limit]
            if loaded.capped:
                notes.append(
                    f"The sort covers the first {len(loaded.rows):,} rows of the data source's own order: narrow the "
                    "filters to sort the whole list."
                )
        return ReportResult(rows=rows, notes=notes)

    common = dict(
        id=report_id,
        title=title,
        description=description,
        category="customise",
        filters=filters if filters is not None else ds.filters,
        columns=tuple(f.column() for f in fields),
        run=run,
        icon="SlidersHorizontal",
        tags=("custom", ds.label.lower()),
        landscape=True,
        modules=ds.modules,
        pdf_builder=build_custom_pdf,
        screen_limit=screen_limit,
    )
    if not saved:
        return ReportSpec(**common)
    # an optional select of the data source reads "empty" as "all" (never as a default of its own)
    run_filters = tuple(
        dataclasses.replace(f, default=None) if f.kind == F_SELECT and not f.required else f for f in ds.filters
    )
    return SavedReportSpec(**common, run_filters=run_filters)


def preview_spec(ds: Dataset, fields: list[Field], sort: list[dict]) -> ReportSpec:
    return build_spec(
        ds,
        fields,
        sort,
        report_id=PREVIEW_ID,
        title="Preview",
        description=ds.description,
        screen_limit=PREVIEW_ROWS,
        sort_ceiling=PREVIEW_SORT_CEILING,
    )
