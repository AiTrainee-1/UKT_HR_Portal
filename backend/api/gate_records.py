"""
Gate records: everything that happened at the gates, as one list (Manage Gates -> "Records from this gate" / all gates,
and the gate monitor's own list and export). Shared, read-only; nothing here writes.

One row per event, from three sources merged in SQL (values() + UNION ALL, ordered by `at` newest first, paginated):

    OutpassGateScan                      every gate-pass scan, allowed or denied: exit -> "exit", entry -> "return";
                                         a refused tea-break code (scan_type "tea") -> "tea_out", denied
    TeaBreakLog (out_gate, out_at)       a tea break starting                    -> "tea_out" (always allowed)
    TeaBreakLog (in_gate,  in_at)        a tea break ending                      -> "tea_in"  (always allowed)

Row (camelCase, the API contract): {id: "scan-<pk>" | "teaout-<pk>" | "teain-<pk>", at, type, result: "allowed" |
"denied", reason (the scan's result code when denied, else null), reasonLabel, message, gateId, gateName, employee:
{id, employeeCode, name, department, photoUrl} | null, destination, passId, minutes (tea_in only)}.

* Days are IST days (gate_visitor_tea_common.ist_bounds), never `__date`: a scan at 00:10 IST belongs to that day.
* Branch: a branch-scoped HR user sees the gates of their branch (the GATE's branch, not the employee's); an unscoped
  user may narrow with branch_id. Rows of a deleted gate (gate NULL) only reach unscoped users with no branch filter.
* Photos are signed links (employee_photo.photo_links): no photo column is ever read.
* A refused tea-break code (a gate that does not take tea breaks) is a denied "tea_out" row: the tea types include it,
  "exit" never does (a refused break cannot be told out from in, and "out" is the usual one).
* An "already scanned" message is written from the pass's own time in India time (already_scanned_message): rows
  stored before 19 Nov 2026 carry a UTC clock time in their text.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable

from django.db.models import Case, Count, F, IntegerField, Max, Q, TextField, Value, When
from django.db.models.functions import Cast

from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ, ist_today
from .employee_photo import photo_links
from .models import Employee, GateDevice, OutpassGateScan, OutpassRequest, TeaBreakLog
from .reporting.definitions.gate_visitor_tea_common import WholeMinutes, ist_bounds
from .reporting.formatting import display_date, fmt_dt

TYPE_EXIT = "exit"
TYPE_RETURN = "return"
TYPE_TEA_OUT = "tea_out"
TYPE_TEA_IN = "tea_in"
TYPES = (TYPE_EXIT, TYPE_RETURN, TYPE_TEA_OUT, TYPE_TEA_IN)
TYPE_LABELS = {
    TYPE_EXIT: "Exit",
    TYPE_RETURN: "Return",
    TYPE_TEA_OUT: "Tea break out",
    TYPE_TEA_IN: "Tea break in",
}

RESULT_ALLOWED = "allowed"
RESULT_DENIED = "denied"
RESULT_LABELS = {RESULT_ALLOWED: "Allowed", RESULT_DENIED: "Denied"}
# why a scan was denied (OutpassGateScan.result codes other than success), in plain words
REASON_LABELS = {
    OutpassGateScan.RESULT_ALREADY_SCANNED: "Already scanned",
    OutpassGateScan.RESULT_EXPIRED: "Pass expired",
    OutpassGateScan.RESULT_NOT_APPROVED: "Not approved",
    OutpassGateScan.RESULT_INVALID_QR: "QR not recognised",
    OutpassGateScan.RESULT_NOT_EXITED: "Not gone out yet",
    OutpassGateScan.RESULT_NOT_ALLOWED_HERE: "Not allowed at this gate",
}
REMOVED_GATE = "Removed gate"

DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
# records_for_export reads at most this many rows: one more than the Excel limit, so gate_exports.file_response can
# tell "too many" without reading a whole table
EXPORT_FETCH_LIMIT = 30_001

# The export columns of a gate record (gate_exports.file_response `columns`).
EXPORT_COLUMNS: list[dict] = [
    {"key": "at", "label": "Date and time", "type": "datetime"},
    {"key": "gate", "label": "Gate", "type": "text"},
    {"key": "type", "label": "Type", "type": "text"},
    {"key": "result", "label": "Result", "type": "text"},
    {"key": "reason", "label": "Reason", "type": "text"},
    {"key": "employeeCode", "label": "Employee code", "type": "text"},
    {"key": "employeeName", "label": "Employee", "type": "text"},
    {"key": "department", "label": "Department", "type": "text"},
    {"key": "destination", "label": "Destination", "type": "text"},
    {"key": "minutes", "label": "Break minutes", "type": "minutes"},
    {"key": "message", "label": "Message", "type": "text"},
]

_ALIASES = (
    "r_kind",
    "r_pk",
    "r_at",
    "r_type",
    "r_result",
    "r_reason",
    "r_message",
    "r_gate",
    "r_emp",
    "r_pass",
    "r_dest",
    "r_minutes",
)
_KIND_PREFIX = {"scan": "scan", "teaout": "teaout", "teain": "teain"}


class BadParam(ValueError):
    """A query parameter the records endpoints cannot use; str(e) is the message for a 400 {"error": ...}."""


# ── filters ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Filters:
    gate_ids: tuple[int, ...] | None
    branch_id: int | None
    lo: datetime | None
    hi: datetime | None
    terms: tuple[str, ...]


def _scope_branch(request_or_scope) -> int | None:
    """A request (its HR branch scope; None = unscoped, also for a gate-device request) or a branch id / None."""
    if request_or_scope is None or isinstance(request_or_scope, int):
        return request_or_scope
    return get_branch_scope(request_or_scope)


def _as_date(value, name: str) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        raise BadParam(f"{name} must be a date like 2026-11-18") from None


def _as_ids(value, name: str = "gateId") -> tuple[int, ...] | None:
    """None (no filter), an int, a "1,2" string or an iterable of ints -> a tuple of ids."""
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return (value,)
    items = str(value).split(",") if isinstance(value, str) else list(value)
    out = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        if not text.isdigit():
            raise BadParam(f"{name} must be a number or a comma list of numbers")
        out.append(int(text))
    return tuple(out)


def _as_types(value) -> tuple[str, ...]:
    if value is None or value == "":
        return TYPES
    items = value.split(",") if isinstance(value, str) else list(value)
    out = tuple(t.strip() for t in items if t and t.strip())
    bad = [t for t in out if t not in TYPES]
    if bad:
        raise BadParam("type must be exit, return, tea_out or tea_in")
    return out or TYPES


def _as_result(value) -> str | None:
    if value is None or value == "":
        return None
    value = str(value).strip()
    if value in (RESULT_ALLOWED, RESULT_DENIED) or value in REASON_LABELS:
        return value
    raise BadParam("result must be allowed, denied or a reason code")


def _make_filters(request_or_scope, gate_ids, date_from, date_to, q, branch_id) -> _Filters:
    d_from, d_to = _as_date(date_from, "from"), _as_date(date_to, "to")
    if d_from and d_to and d_from > d_to:
        raise BadParam("from must be on or before to")
    lo, hi = ist_bounds(d_from, d_to)
    scope = _scope_branch(request_or_scope)
    branch = scope if scope is not None else (_as_ids(branch_id, "branchId") or (None,))[0]
    terms = tuple(t for t in (q or "").split()[:4] if t)
    return _Filters(gate_ids=_as_ids(gate_ids), branch_id=branch, lo=lo, hi=hi, terms=terms)


def params_from_query(query_params, *, allow_gate: bool = True, allow_branch: bool = True) -> dict:
    """The records endpoints' query string -> keyword arguments of records_page / records_for_export:
    gateId (one or a comma list), from, to (YYYY-MM-DD, IST, inclusive), type (one or a comma list), result, q,
    branchId, page, pageSize. allow_gate=False drops gateId (the gate monitor: always its own gate); allow_branch=False
    drops branchId. Raises BadParam."""
    get = query_params.get
    out = {
        "date_from": _as_date(get("from"), "from"),
        "date_to": _as_date(get("to"), "to"),
        "type": _as_types(get("type")) if get("type") else None,
        "result": _as_result(get("result")),
        "q": (get("q") or "").strip() or None,
        "page": _as_int(get("page"), 1),
        "page_size": _as_int(get("pageSize"), DEFAULT_PAGE_SIZE),
    }
    if allow_gate:
        out["gate_ids"] = _as_ids(get("gateId"))
    if allow_branch:
        ids = _as_ids(get("branchId"), "branchId")
        out["branch_id"] = ids[0] if ids else None
    return out


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ── the three sources ────────────────────────────────────────────────────────


def already_scanned_message(entry: bool, when, gate_name: str | None) -> str:
    """The text of an already-scanned pass, "Already exited at 03:45 PM via Gate 1" / "Already returned at ...", with
    the time in India time. The gate scanner writes it, and the records rebuild it from the pass for a stored row
    (older rows have the UTC clock in their text)."""
    clock = when.astimezone(FACTORY_TZ).strftime("%I:%M %p")
    message = f"Already returned at {clock}" if entry else f"Already exited at {clock}"
    return message + (f" via {gate_name}" if gate_name else "")


def _employee_q(prefix: str, term: str) -> Q:
    return (
        Q(**{f"{prefix}employee_code__icontains": term})
        | Q(**{f"{prefix}first_name__icontains": term})
        | Q(**{f"{prefix}last_name__icontains": term})
    )


def _scan_base(f: _Filters):
    qs = OutpassGateScan.objects.order_by()
    if f.gate_ids is not None:
        qs = qs.filter(gate_id__in=f.gate_ids)
    if f.branch_id is not None:
        qs = qs.filter(gate__branch_id=f.branch_id)
    if f.lo is not None:
        qs = qs.filter(scanned_at__gte=f.lo)
    if f.hi is not None:
        qs = qs.filter(scanned_at__lt=f.hi)
    for term in f.terms:
        qs = qs.filter(_employee_q("employee__", term) | Q(outpass_request__destination__icontains=term))
    return qs


def _tea_base(f: _Filters, leg: str):
    """leg "out": breaks that started in the range at these gates; "in": breaks that ended in the range at these gates."""
    gate_field, at_field = ("out_gate", "out_at") if leg == "out" else ("in_gate", "in_at")
    qs = TeaBreakLog.objects.order_by()
    if leg == "in":
        qs = qs.filter(in_at__isnull=False)
    if f.gate_ids is not None:
        qs = qs.filter(**{f"{gate_field}_id__in": f.gate_ids})
    if f.branch_id is not None:
        qs = qs.filter(**{f"{gate_field}__branch_id": f.branch_id})
    if f.lo is not None:
        qs = qs.filter(**{f"{at_field}__gte": f.lo})
    if f.hi is not None:
        qs = qs.filter(**{f"{at_field}__lt": f.hi})
    for term in f.terms:
        qs = qs.filter(_employee_q("employee__", term))
    return qs


def _text(value):
    """A text constant; None is a TYPED null (NULL::text): Postgres resolves a UNION column whose leading branches are
    all untyped NULLs as text, which then clashes with a later integer branch."""
    if value is None:
        return Cast(Value(None), output_field=TextField())
    return Value(value, output_field=TextField())


def _no_int():
    return Cast(Value(None), output_field=IntegerField())


def _parts(f: _Filters, types: Iterable[str], result: str | None) -> list:
    """The values() querysets (same columns, same order) whose UNION ALL is the record list."""
    types = set(types)
    parts = []
    # a refused tea-break code is a denied scan of type "tea", listed as "tea_out" (never under "exit")
    scan_types = {
        TYPE_EXIT: OutpassGateScan.SCAN_TYPE_EXIT,
        TYPE_RETURN: OutpassGateScan.SCAN_TYPE_ENTRY,
        TYPE_TEA_OUT: OutpassGateScan.SCAN_TYPE_TEA,
    }
    wanted_scans = [scan_types[t] for t in (TYPE_EXIT, TYPE_RETURN, TYPE_TEA_OUT) if t in types]
    if wanted_scans:
        qs = _scan_base(f)
        if len(wanted_scans) < len(scan_types):
            qs = qs.filter(scan_type__in=wanted_scans)
        if result == RESULT_ALLOWED:
            qs = qs.filter(result=OutpassGateScan.RESULT_SUCCESS)
        elif result == RESULT_DENIED:
            qs = qs.exclude(result=OutpassGateScan.RESULT_SUCCESS)
        elif result:
            qs = qs.filter(result=result)
        success = Q(result=OutpassGateScan.RESULT_SUCCESS)
        parts.append(
            qs.annotate(
                r_kind=_text("scan"),
                r_pk=F("id"),
                r_at=F("scanned_at"),
                r_type=Case(
                    When(scan_type=OutpassGateScan.SCAN_TYPE_ENTRY, then=_text(TYPE_RETURN)),
                    When(scan_type=OutpassGateScan.SCAN_TYPE_TEA, then=_text(TYPE_TEA_OUT)),
                    default=_text(TYPE_EXIT),
                    output_field=TextField(),
                ),
                r_result=Case(
                    When(success, then=_text(RESULT_ALLOWED)), default=_text(RESULT_DENIED), output_field=TextField()
                ),
                r_reason=Case(When(success, then=_text(None)), default=F("result"), output_field=TextField()),
                r_message=F("message"),
                r_gate=F("gate_id"),
                r_emp=F("employee_id"),
                r_pass=F("outpass_request_id"),
                r_dest=F("outpass_request__destination"),
                r_minutes=_no_int(),
            ).values(*_ALIASES)
        )
    tea_allowed = result in (None, RESULT_ALLOWED)
    if TYPE_TEA_OUT in types and tea_allowed:
        parts.append(
            _tea_base(f, "out")
            .annotate(
                r_kind=_text("teaout"),
                r_pk=F("id"),
                r_at=F("out_at"),
                r_type=_text(TYPE_TEA_OUT),
                r_result=_text(RESULT_ALLOWED),
                r_reason=_text(None),
                r_message=_text(None),
                r_gate=F("out_gate_id"),
                r_emp=F("employee_id"),
                r_pass=_no_int(),
                r_dest=_text(None),
                r_minutes=_no_int(),
            )
            .values(*_ALIASES)
        )
    if TYPE_TEA_IN in types and tea_allowed:
        parts.append(
            _tea_base(f, "in")
            .annotate(
                r_kind=_text("teain"),
                r_pk=F("id"),
                r_at=F("in_at"),
                r_type=_text(TYPE_TEA_IN),
                r_result=_text(RESULT_ALLOWED),
                r_reason=_text(None),
                r_message=_text(None),
                r_gate=F("in_gate_id"),
                r_emp=F("employee_id"),
                r_pass=_no_int(),
                r_dest=_text(None),
                r_minutes=WholeMinutes(F("in_at") - F("out_at")),
            )
            .values(*_ALIASES)
        )
    return parts


def _union(parts: list):
    """The merged, ordered queryset (newest first); None when no source applies."""
    if not parts:
        return None
    qs = parts[0] if len(parts) == 1 else parts[0].union(*parts[1:], all=True)
    return qs.order_by("-r_at", "r_kind", "-r_pk")


def _empty_counts() -> dict:
    return {"exits": 0, "returns": 0, "teaOut": 0, "teaIn": 0, "denied": 0, "total": 0}


def _counts(f: _Filters) -> dict:
    if f.gate_ids == ():
        return _empty_counts()
    success = Q(result=OutpassGateScan.RESULT_SUCCESS)
    scans = _scan_base(f).aggregate(
        exits=Count("id", filter=success & Q(scan_type=OutpassGateScan.SCAN_TYPE_EXIT)),
        returns=Count("id", filter=success & Q(scan_type=OutpassGateScan.SCAN_TYPE_ENTRY)),
        denied=Count("id", filter=~success),
    )
    out = {
        "exits": scans["exits"],
        "returns": scans["returns"],
        "teaOut": _tea_base(f, "out").count(),
        "teaIn": _tea_base(f, "in").count(),
        "denied": scans["denied"],
    }
    out["total"] = sum(out.values())
    return out


# ── rows ─────────────────────────────────────────────────────────────────────


def _lookups(rows: list[dict], with_photos: bool) -> tuple[dict, dict, dict]:
    emp_ids = {r["r_emp"] for r in rows if r["r_emp"] is not None}
    gate_ids = {r["r_gate"] for r in rows if r["r_gate"] is not None}
    emps = {
        e["id"]: e
        for e in Employee.objects.filter(pk__in=emp_ids).values(
            "id", "employee_code", "first_name", "last_name", "department__name"
        )
    }
    gates = dict(GateDevice.objects.filter(pk__in=gate_ids).values_list("id", "name"))
    photos = photo_links(emp_ids) if with_photos else {}
    return emps, gates, photos


def _pass_times(rows: list[dict]) -> dict:
    """{pass id: its exit / return times and gates} for the page's "already scanned" rows (one query, none when there
    are none): their text is written again from these, in India time."""
    ids = {r["r_pass"] for r in rows if r["r_reason"] == OutpassGateScan.RESULT_ALREADY_SCANNED and r["r_pass"]}
    if not ids:
        return {}
    return {
        p["id"]: p
        for p in OutpassRequest.objects.filter(pk__in=ids).values(
            "id", "exited_at", "entered_at", "exit_gate__name", "entry_gate__name"
        )
    }


def _message(r: dict, passes: dict | None = None) -> str:
    if r["r_kind"] == "scan":
        if r["r_reason"] == OutpassGateScan.RESULT_ALREADY_SCANNED:
            p = (passes or {}).get(r["r_pass"])
            entry = r["r_type"] == TYPE_RETURN
            when = p and (p["entered_at"] if entry else p["exited_at"])
            if when:
                return already_scanned_message(entry, when, p["entry_gate__name"] if entry else p["exit_gate__name"])
        return r["r_message"] or ""
    if r["r_type"] == TYPE_TEA_OUT:
        return "Tea break started"
    if r["r_type"] == TYPE_TEA_IN:
        minutes = r["r_minutes"]
        return f"Tea break ended after {minutes} min" if minutes is not None else "Tea break ended"
    return r["r_message"] or ""


def _row_json(r: dict, emps: dict, gates: dict, photos: dict, passes: dict | None = None) -> dict:
    emp = emps.get(r["r_emp"])
    employee = None
    if emp is not None:
        employee = {
            "id": emp["id"],
            "employeeCode": emp["employee_code"],
            "name": f"{emp['first_name'] or ''} {emp['last_name'] or ''}".strip(),
            "department": emp["department__name"],
            "photoUrl": photos.get(emp["id"]),
        }
    reason = r["r_reason"]
    return {
        "id": f"{_KIND_PREFIX[r['r_kind']]}-{r['r_pk']}",
        "at": r["r_at"].isoformat() if r["r_at"] else None,
        "type": r["r_type"],
        "result": r["r_result"],
        "reason": reason,
        "reasonLabel": REASON_LABELS.get(reason) if reason else None,
        "message": _message(r, passes),
        "gateId": r["r_gate"],
        "gateName": gates.get(r["r_gate"]) if r["r_gate"] is not None else None,
        "employee": employee,
        "destination": r["r_dest"],
        "passId": r["r_pass"],
        "minutes": r["r_minutes"],
    }


def records_page(
    request_or_scope,
    *,
    gate_ids=None,
    date_from=None,
    date_to=None,
    type=None,
    result=None,
    q=None,
    branch_id=None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    """One page of gate records, newest first: {items, total, page, pageSize, counts}.

    request_or_scope: the request (HR branch scope applied; a gate-device request is unscoped) or a branch id / None.
    gate_ids: None = every gate in scope; an id, "1,2", or ids. date_from / date_to: dates or "YYYY-MM-DD" (IST days,
    inclusive). type: one of TYPES or several (comma string or iterable). result: "allowed" | "denied" | a reason code.
    q: employee name / code or pass destination (up to 4 words, each must match). branch_id: unscoped callers only
    (a scoped request ignores it). counts = {exits, returns, teaOut, teaIn, denied, total} for the same gates, dates,
    search and branch but EVERY type and result (the numbers beside the type / result chips); `total` is the filtered
    count. Raises BadParam for an unusable value."""
    f = _make_filters(request_or_scope, gate_ids, date_from, date_to, q, branch_id)
    types, result = _as_types(type), _as_result(result)
    page = max(1, _as_int(page, 1))
    page_size = max(1, min(_as_int(page_size, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    empty = {"items": [], "total": 0, "page": page, "pageSize": page_size, "counts": _empty_counts()}
    if f.gate_ids == ():
        return empty
    union = _union(_parts(f, types, result))
    counts = _counts(f)
    if union is None:
        return {**empty, "counts": counts}
    total = union.count()
    offset = (page - 1) * page_size
    rows = list(union[offset : offset + page_size])
    emps, gates, photos = _lookups(rows, with_photos=True)
    passes = _pass_times(rows)
    return {
        "items": [_row_json(r, emps, gates, photos, passes) for r in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "counts": counts,
    }


def record_counts(request_or_scope, *, gate_ids=None, date_from=None, date_to=None, q=None, branch_id=None) -> dict:
    """{exits, returns, teaOut, teaIn, denied, total} for these filters (every type and result)."""
    return _counts(_make_filters(request_or_scope, gate_ids, date_from, date_to, q, branch_id))


def records_for_export(
    request_or_scope,
    *,
    gate_ids=None,
    date_from=None,
    date_to=None,
    type=None,
    result=None,
    q=None,
    branch_id=None,
    limit: int = EXPORT_FETCH_LIMIT,
    **_ignored,
) -> list[dict]:
    """The same records as records_page (same filters, newest first), as flat rows keyed by EXPORT_COLUMNS: at (IST
    "YYYY-MM-DD HH:MM"), gate, type, result, reason, employeeCode, employeeName, department, destination, minutes,
    message. At most `limit` rows (default one more than the Excel limit, so the caller can refuse "too many").
    Accepts and ignores page / page_size so params_from_query's output can be passed straight in."""
    f = _make_filters(request_or_scope, gate_ids, date_from, date_to, q, branch_id)
    if f.gate_ids == ():
        return []
    union = _union(_parts(f, _as_types(type), _as_result(result)))
    if union is None:
        return []
    rows = list(union[:limit])
    emps, gates, _photos = _lookups(rows, with_photos=False)
    passes = _pass_times(rows)
    out = []
    for r in rows:
        item = _row_json(r, emps, gates, {}, passes)
        emp = item["employee"] or {}
        out.append(
            {
                "at": fmt_dt(r["r_at"]),
                "gate": item["gateName"] or REMOVED_GATE,
                "type": TYPE_LABELS[item["type"]],
                "result": RESULT_LABELS[item["result"]],
                "reason": item["reasonLabel"],
                "employeeCode": emp.get("employeeCode"),
                "employeeName": emp.get("name"),
                "department": emp.get("department"),
                "destination": item["destination"],
                "minutes": item["minutes"],
                "message": item["message"],
            }
        )
    return out


def counts_summary(counts: dict) -> list[dict]:
    """counts -> the summary figures of an export file (gate_exports.file_response `summary`)."""
    return [
        {"label": "Exits", "value": counts.get("exits", 0)},
        {"label": "Returns", "value": counts.get("returns", 0)},
        {"label": "Tea break out", "value": counts.get("teaOut", 0)},
        {"label": "Tea break in", "value": counts.get("teaIn", 0)},
        {"label": "Denied", "value": counts.get("denied", 0)},
    ]


def describe_filters(
    *, gate_names=None, date_from=None, date_to=None, type=None, result=None, q=None, branch_name=None, **_ignored
) -> list[tuple[str, str]]:
    """The filters line of an export file, as (label, value) pairs (gate_exports.file_response `filters_text`).
    gate_names: the names of the chosen gates (None / empty = every gate). Accepts params_from_query's output."""
    out: list[tuple[str, str]] = []
    names = [n for n in (gate_names or []) if n]
    out.append(("Gate", ", ".join(names) if names else "All gates"))
    if branch_name:
        out.append(("Branch", branch_name))
    d_from, d_to = _as_date(date_from, "from"), _as_date(date_to, "to")
    if d_from or d_to:
        if d_from == d_to:
            out.append(("Date", display_date(d_from)))
        else:
            out.append(("Dates", f"{display_date(d_from) or 'start'} to {display_date(d_to) or 'today'}"))
    types = _as_types(type)
    if set(types) != set(TYPES):
        out.append(("Type", ", ".join(TYPE_LABELS[t] for t in types)))
    result = _as_result(result)
    if result:
        out.append(("Result", RESULT_LABELS.get(result) or REASON_LABELS.get(result, result)))
    if q:
        out.append(("Search", str(q)))
    return out


# ── per gate (Manage Gates cards, the gate monitor's today) ──────────────────


def gate_counts(gate_ids=None, date_from=None, date_to=None) -> dict:
    """{gate id: {exits, returns, teaOut, teaIn, denied, total}} for these gates (None = all, the key None then holds
    a removed gate's rows) in this IST date range (None = no bound). Every requested id is present, zeros included.
    Three grouped queries. The caller scopes the gate ids to the user's branch."""
    f = _Filters(
        gate_ids=_as_ids(gate_ids),
        branch_id=None,
        lo=ist_bounds(_as_date(date_from, "from"), None)[0],
        hi=ist_bounds(None, _as_date(date_to, "to"))[1],
        terms=(),
    )
    out: dict = defaultdict(_empty_counts)
    for gid in f.gate_ids or ():
        out[gid] = _empty_counts()
    if f.gate_ids == ():
        return dict(out)
    success = Q(result=OutpassGateScan.RESULT_SUCCESS)
    for row in (
        _scan_base(f)
        .values("gate_id")
        .annotate(
            exits=Count("id", filter=success & Q(scan_type=OutpassGateScan.SCAN_TYPE_EXIT)),
            returns=Count("id", filter=success & Q(scan_type=OutpassGateScan.SCAN_TYPE_ENTRY)),
            denied=Count("id", filter=~success),
        )
    ):
        c = out[row["gate_id"]]
        c["exits"], c["returns"], c["denied"] = row["exits"], row["returns"], row["denied"]
    for leg, key, field in (("out", "teaOut", "out_gate_id"), ("in", "teaIn", "in_gate_id")):
        for row in _tea_base(f, leg).values(field).annotate(n=Count("id")):
            out[row[field]][key] = row["n"]
    for c in out.values():
        c["total"] = c["exits"] + c["returns"] + c["teaOut"] + c["teaIn"] + c["denied"]
    return dict(out)


def gate_last_activity(gate_ids) -> dict:
    """{gate id: the newest scan / tea break start / tea break end at that gate (aware datetime)}; gates with nothing
    are absent. Three grouped queries."""
    ids = list(_as_ids(gate_ids) or ())
    if not ids:
        return {}
    out: dict = {}
    sources = (
        (OutpassGateScan.objects.filter(gate_id__in=ids), "gate_id", "scanned_at"),
        (TeaBreakLog.objects.filter(out_gate_id__in=ids), "out_gate_id", "out_at"),
        (TeaBreakLog.objects.filter(in_gate_id__in=ids, in_at__isnull=False), "in_gate_id", "in_at"),
    )
    for qs, gate_field, at_field in sources:
        for row in qs.order_by().values(gate_field).annotate(last=Max(at_field)):
            gid, last = row[gate_field], row["last"]
            if last is not None and (gid not in out or last > out[gid]):
                out[gid] = last
    return out


def gate_summary(gate_ids=None, date_from=None, date_to=None) -> dict:
    """What happened at these gates (None = all) in the range, TODAY (IST) when both dates are None:
    {exits, returns, teaOut, teaIn, denied, total, passesOutNow, teaOutNow, outNow}. passesOutNow = passes that went
    out through these gates in the range and have not come back, early-dismissal passes left out (they are not expected
    back: In/Out's "Still out" leaves them out too); teaOutNow = tea breaks started at these gates in the range and not
    ended; outNow = both. The gate monitor's "today at this gate" uses gate_ids=[its gate]."""
    if date_from is None and date_to is None:
        date_from = date_to = ist_today()
    ids = _as_ids(gate_ids)
    f = _Filters(
        gate_ids=ids,
        branch_id=None,
        lo=ist_bounds(_as_date(date_from, "from"), None)[0],
        hi=ist_bounds(None, _as_date(date_to, "to"))[1],
        terms=(),
    )
    out = _counts(f)
    if ids == ():
        out.update(passesOutNow=0, teaOutNow=0, outNow=0)
        return out
    passes = (
        OutpassRequest.objects.order_by()
        .filter(exited_at__isnull=False, entered_at__isnull=True)
        .exclude(pass_type=OutpassRequest.PASS_TYPE_EARLY_DISMISSAL)
    )
    teas = TeaBreakLog.objects.order_by().filter(in_at__isnull=True)
    if ids is not None:
        passes = passes.filter(exit_gate_id__in=ids)
        teas = teas.filter(out_gate_id__in=ids)
    if f.lo is not None:
        passes, teas = passes.filter(exited_at__gte=f.lo), teas.filter(out_at__gte=f.lo)
    if f.hi is not None:
        passes, teas = passes.filter(exited_at__lt=f.hi), teas.filter(out_at__lt=f.hi)
    out["passesOutNow"] = passes.count()
    out["teaOutNow"] = teas.count()
    out["outNow"] = out["passesOutNow"] + out["teaOutNow"]
    return out
