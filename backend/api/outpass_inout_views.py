"""
Gate Pass -> In/Out (HR portal): the passes that went out through a gate and whether they came back, under
/api/outpass/in-out (permission key outpass_visitors.outpass.in_out; view for every GET). Before 2026-11-18 the tab read
the Requests module's /api/outpass-requests, so a role without Requests could not open it; these endpoints are its own.

    GET /api/outpass/in-out            one page of rows (newest exit first)
    GET /api/outpass/in-out/summary    the headline figures for the same filters (no paging)
    GET /api/outpass/in-out/<id>       one pass: the row + its approval trail + every gate scan of it, denied ones too
    GET /api/outpass/in-out/export     the rows as Excel / PDF (gate_exports.file_response, Report Center look)
    GET /api/outpass/in-out/options    the gates and departments the filters offer (the user's branch only)

Filters (query string): from / to (IST days, inclusive, on the EXIT scan; neither = today), gateId (the exit OR the return
gate), employeeId, departmentId, status, q (every word must match the employee's name or code, the destination or the
reason; up to 4 words), branchId (an HR account bound to no branch only), page / pageSize (25, at most 100). A branch-
bound account sees the passes of its branch's employees only.

Status, from the Report Center's pass_state (reporting/definitions/gate_outpass_common.py, never re-implemented):
    back            scanned back in
    out             scanned out today, not back, still within the expected return time (or none was given)
    overdue         scanned out today, not back, past the expected return time
    not_returned    scanned out on an earlier IST day and never scanned back
    early_dismissal an early-shift-dismissal pass that has left (not expected back)
The status FILTER "out" means everyone still out today, overdue ones included (the "Still out" figure); the other four
match their own status. The list and the summary narrow in SQL with the same rules (_status_q), so the figures are
those of the Report Center's "Gate In / Out Register" for the same data (tests_outpass_inout checks the parity).

A pass's codes (qrToken / returnQrToken) are never sent, not even to HR: none of these payloads carries them.
Read-only: nothing here writes, apart from the export's audit row.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time
from types import SimpleNamespace

from django.db.models import Count, F, Func, IntegerField, Max, Q, Sum
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ
from .employee_photo import photo_links
from .gate_exports import bad_format_response, export_format, file_response
from .gate_records import EXPORT_FETCH_LIMIT, REASON_LABELS, REMOVED_GATE, BadParam, already_scanned_message
from .models import Branch, Department, Employee, GateDevice, OutpassGateScan, OutpassRequest
from .reporting.definitions import gate_outpass_common as C
from .reporting.formatting import display_date, full_name

WORKFLOW = "outpass"  # the approval pipeline of an outpass (approval_workflow.py), as outpass_request_views uses it

BACK = "back"
OUT = "out"
OVERDUE = "overdue"
NOT_RETURNED = "not_returned"
EARLY = "early_dismissal"
STATUSES = (BACK, OUT, OVERDUE, NOT_RETURNED, EARLY)
STATUS_LABELS = {
    BACK: "Back",
    OUT: "Out",
    OVERDUE: "Overdue",
    NOT_RETURNED: "Not returned",
    EARLY: "Left for the day",
}
# what the status filter is called in a file's filters line ("out" there means everyone still out, overdue included)
STATUS_FILTER_LABELS = {**STATUS_LABELS, OUT: "Still out"}

DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
MAX_TERMS = 4

_SELECT = ("employee__department", "employee__designation", "exit_gate", "entry_gate")


class HalfUpMinutes(Func):
    """Whole minutes of an interval, halves rounded up and never below 0: in SQL what C.half_up_minutes does to a
    duration in Python (the Report Center's "Time outside"), so a Sum / Max of it equals the report's figures."""

    template = "GREATEST(0, CAST(FLOOR(CAST(EXTRACT(EPOCH FROM (%(expressions)s)) AS NUMERIC) / 60 + 0.5) AS INTEGER))"
    output_field = IntegerField()


# ── filters ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Filters:
    date_from: date | None
    date_to: date | None
    gate_id: int | None
    employee_id: int | None
    department_id: int | None
    status: str | None
    terms: tuple[str, ...]
    branch_id: int | None  # the scope of a branch-bound account, else the chosen branch (None = every branch)
    page: int
    page_size: int
    q: str


def _as_date(value, name: str) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise BadParam(f"{name} must be a date like 2026-11-18") from None


def _as_id(value, name: str) -> int | None:
    text = (value or "").strip()
    if not text:
        return None
    if not text.isdigit():
        raise BadParam(f"{name} must be a number")
    return int(text)


def _as_count(value, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _filters(request: Request) -> _Filters:
    """The query string -> _Filters. Raises BadParam (400) for a bad date, id or status."""
    qp = request.query_params
    d_from, d_to = _as_date(qp.get("from"), "from"), _as_date(qp.get("to"), "to")
    if d_from is None and d_to is None:
        d_from = d_to = C.ist_date(C.now())
    if d_from and d_to and d_from > d_to:
        raise BadParam("from must be on or before to")
    status = (qp.get("status") or "").strip() or None
    if status is not None and status not in STATUSES:
        raise BadParam("status must be back, out, overdue, not_returned or early_dismissal")
    scope = get_branch_scope(request)
    chosen = _as_id(qp.get("branchId"), "branchId")
    q = " ".join((qp.get("q") or "").split())
    return _Filters(
        date_from=d_from,
        date_to=d_to,
        gate_id=_as_id(qp.get("gateId"), "gateId"),
        employee_id=_as_id(qp.get("employeeId"), "employeeId"),
        department_id=_as_id(qp.get("departmentId"), "departmentId"),
        status=status,
        terms=tuple(q.split()[:MAX_TERMS]),
        branch_id=scope if scope is not None else chosen,
        page=_as_count(qp.get("page"), 1),
        page_size=min(MAX_PAGE_SIZE, _as_count(qp.get("pageSize"), DEFAULT_PAGE_SIZE)),
        q=q,
    )


def _bad(e: BadParam) -> Response:
    return Response({"error": str(e)}, status=400)


# ── the query ────────────────────────────────────────────────────────────────


def _clock() -> tuple[datetime, datetime]:
    """(now, today's IST midnight), both aware, read through the Report Center's clock seam."""
    now_dt = C.now()
    return now_dt, datetime.combine(C.ist_date(now_dt), time.min, tzinfo=FACTORY_TZ)


def _status_q(status: str | None, now_dt: datetime, today_start: datetime) -> Q:
    """The rows of a status, in SQL. Exactly pass_state's rules for a pass that has gone out: entered -> completed
    ("back"); not entered + early-dismissal pass -> "early_dismissal"; not entered and out on an earlier IST day ->
    "not_returned"; else outside now ("out", "overdue" once the expected return time has passed)."""
    if not status:
        return Q()
    if status == BACK:
        return Q(entered_at__isnull=False)
    open_q = Q(entered_at__isnull=True)
    early = Q(pass_type="early_dismissal")
    if status == EARLY:
        return open_q & early
    if status == NOT_RETURNED:
        return open_q & ~early & Q(exited_at__lt=today_start)
    outside = open_q & ~early & Q(exited_at__gte=today_start)
    if status == OVERDUE:
        return outside & Q(expected_return_at__lt=now_dt)
    return outside  # OUT: everyone still out, overdue included


def _queryset(f: _Filters):
    """The passes that went out in the range, with every filter but the status (unordered)."""
    qs = OutpassRequest.objects.filter(exited_at__isnull=False).filter(
        C.in_range("exited_at", SimpleNamespace(date_from=f.date_from, date_to=f.date_to))
    )
    if f.branch_id is not None:
        qs = qs.filter(employee__branch_id=f.branch_id)
    if f.gate_id is not None:
        qs = qs.filter(Q(exit_gate_id=f.gate_id) | Q(entry_gate_id=f.gate_id))
    if f.employee_id is not None:
        qs = qs.filter(employee_id=f.employee_id)
    if f.department_id is not None:
        qs = qs.filter(employee__department_id=f.department_id)
    for term in f.terms:
        qs = qs.filter(
            Q(employee__first_name__icontains=term)
            | Q(employee__last_name__icontains=term)
            | Q(employee__employee_code__icontains=term)
            | Q(destination__icontains=term)
            | Q(reason__icontains=term)
        )
    return qs.order_by()


def _rows_qs(f: _Filters, now_dt: datetime, today_start: datetime):
    """The listed rows: every filter, newest exit first, with what a row prints (never a photo column)."""
    return (
        _queryset(f)
        .filter(_status_q(f.status, now_dt, today_start))
        .select_related(*_SELECT)
        .defer(*C.EMP_DEFER)
        .order_by("-exited_at", "-id")
    )


def _summary(qs, now_dt: datetime, today_start: datetime) -> dict:
    """The headline figures of a queryset of passes that went out (one query)."""
    back = Q(entered_at__isnull=False)
    minutes = HalfUpMinutes(F("entered_at") - F("exited_at"))
    agg = qs.aggregate(
        wentOut=Count("id"),
        cameBack=Count("id", filter=back),
        stillOut=Count("id", filter=_status_q(OUT, now_dt, today_start)),
        overdue=Count("id", filter=_status_q(OVERDUE, now_dt, today_start)),
        notReturned=Count("id", filter=_status_q(NOT_RETURNED, now_dt, today_start)),
        earlyDismissal=Count("id", filter=_status_q(EARLY, now_dt, today_start)),
        totalMinutesOut=Sum(minutes, filter=back),
        longestMinutesOut=Max(minutes, filter=back),
    )
    n, total = agg["cameBack"], agg["totalMinutesOut"]
    # C.mean_minutes over the door-to-door minutes of the passes that came back (the report's "Avg time outside")
    agg["avgMinutesOut"] = math.floor(total / n + 0.5) if n and total is not None else None
    return agg


# ── rows ─────────────────────────────────────────────────────────────────────


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _status_of(req: OutpassRequest, now_dt: datetime) -> tuple[str, str]:
    """(pass_state, In/Out status) of a pass that went out."""
    state = C.pass_state(req, now_dt, C.ist_date(now_dt))
    if state == "completed":
        return state, BACK
    if state == "early_dismissal":
        return state, EARLY
    if state == "not_returned":
        return state, NOT_RETURNED
    late = req.expected_return_at is not None and now_dt > req.expected_return_at
    return state, OVERDUE if late else OUT


def _employee_json(emp: Employee, photos: dict | None) -> dict:
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": full_name(emp),
        "department": emp.department.name if emp.department_id else None,
        "designation": emp.designation.title if emp.designation_id else None,
        "photoUrl": (photos or {}).get(emp.id),
    }


def _row_json(req: OutpassRequest, now_dt: datetime, photos: dict | None = None) -> dict:
    state, status = _status_of(req, now_dt)
    if status == BACK:
        minutes_out = C.minutes_between(req.exited_at, req.entered_at)
    elif status in (OUT, OVERDUE):
        minutes_out = C.minutes_between(req.exited_at, now_dt)  # running: out until now
    else:
        minutes_out = None  # an old open row or an early dismissal has no meaningful time out (as on the report)
    allowed = (
        C.minutes_between(req.exited_at, req.expected_return_at)
        if req.expected_return_at and req.expected_return_at > req.exited_at
        else None
    )
    over = C.overrun_minutes(req, state, now_dt)
    return {
        "id": req.id,
        "employee": _employee_json(req.employee, photos),
        "passType": req.pass_type or None,
        "passTypeLabel": C.pass_type_label(req.pass_type) if req.pass_type else None,
        "destination": req.destination,
        "reason": req.reason,
        "source": req.source,
        "sourceLabel": C.source_label(req.source),
        "approvedBy": C.reviewer_text(req.approver_role, req.approved_by),
        "approvedAt": _iso(req.approved_at),
        "expectedReturnAt": _iso(req.expected_return_at),
        "exitGateId": req.exit_gate_id,
        "exitGateName": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": _iso(req.exited_at),
        "entryGateId": req.entry_gate_id,
        "entryGateName": req.entry_gate.name if req.entry_gate_id else None,
        "enteredAt": _iso(req.entered_at),
        "minutesOut": minutes_out,
        "allowedMinutes": allowed,
        "overMinutes": over if over else None,
        # past the expected return time: still out after it, or came back after it
        "overdue": status == OVERDUE or (status == BACK and C.is_late(over)),
        "status": status,
        "statusLabel": STATUS_LABELS[status],
    }


def _scan_json(scan: OutpassGateScan, req: OutpassRequest | None = None) -> dict:
    """One gate scan of a pass. An "already scanned" text is written again from the pass's own time in India time
    (gate_records.already_scanned_message): rows stored before 19 Nov 2026 carry a UTC clock time."""
    allowed = scan.result == OutpassGateScan.RESULT_SUCCESS
    entry = scan.scan_type == OutpassGateScan.SCAN_TYPE_ENTRY
    message = C.clean(scan.message)
    if req is not None and scan.result == OutpassGateScan.RESULT_ALREADY_SCANNED:
        when = req.entered_at if entry else req.exited_at
        gate = req.entry_gate if entry else req.exit_gate
        if when:
            message = already_scanned_message(entry, when, gate.name if gate else None)
    return {
        "id": scan.id,
        "at": _iso(scan.scanned_at),
        "type": "return" if entry else "exit",
        "result": "allowed" if allowed else "denied",
        "reason": None if allowed else scan.result,
        "reasonLabel": None if allowed else REASON_LABELS.get(scan.result, scan.get_result_display()),
        "gateName": scan.gate.name if scan.gate_id else REMOVED_GATE,
        "message": message,
    }


# ── the endpoints ────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def outpass_in_out(request: Request) -> Response:
    """One page of the passes that went out: {items, total, page, pageSize}."""
    try:
        f = _filters(request)
    except BadParam as e:
        return _bad(e)
    now_dt, today_start = _clock()
    qs = _rows_qs(f, now_dt, today_start)
    total = qs.count()
    start = (f.page - 1) * f.page_size
    rows = list(qs[start : start + f.page_size])
    photos = photo_links(r.employee_id for r in rows)
    return Response(
        {
            "items": [_row_json(r, now_dt, photos) for r in rows],
            "total": total,
            "page": f.page,
            "pageSize": f.page_size,
        }
    )


@api_view(["GET"])
@require_hr
def outpass_in_out_summary(request: Request) -> Response:
    """{wentOut, cameBack, stillOut (overdue included), overdue, notReturned, earlyDismissal, avgMinutesOut,
    longestMinutesOut, totalMinutesOut} for the filters (status included when sent; the page sends none for its tiles).
    The minutes are door to door, over the passes that came back."""
    try:
        f = _filters(request)
    except BadParam as e:
        return _bad(e)
    now_dt, today_start = _clock()
    qs = _queryset(f).filter(_status_q(f.status, now_dt, today_start))
    return Response(_summary(qs, now_dt, today_start))


@api_view(["GET"])
@require_hr
def outpass_in_out_detail(request: Request, pk: int) -> Response:
    """One pass that went out: the row, how it was approved (approvalTrail: the same block the requests list sends,
    None for an On-Duty pass, which has no pipeline), when it was asked for, and every scan of it at a gate."""
    qs = OutpassRequest.objects.filter(pk=pk, exited_at__isnull=False).select_related(*_SELECT).defer(*C.EMP_DEFER)
    scope = get_branch_scope(request)
    if scope is not None:
        qs = qs.filter(employee__branch_id=scope)
    req = qs.first()
    if req is None:
        return Response({"error": "This gate pass was not found, or it has not gone out yet."}, status=404)
    now_dt, _ = _clock()
    data = _row_json(req, now_dt, photo_links([req.employee_id]))
    scans = (
        OutpassGateScan.objects.filter(outpass_request_id=req.id).select_related("gate").order_by("scanned_at", "id")
    )
    data.update(
        {
            "requestedAt": _iso(req.created_at),
            "reviewComment": req.review_comment or None,
            "approvalTrail": (approval.progress(WORKFLOW, req) if req.source == OutpassRequest.SOURCE_MANUAL else None),
            "scans": [_scan_json(s, req) for s in scans],
        }
    )
    return Response(data)


EXPORT_COLUMNS: list[dict] = [
    {"key": "date", "label": "Date", "type": "date", "width": 1.2},
    {"key": "employeeCode", "label": "Emp code", "type": "text", "width": 1.0},
    {"key": "employeeName", "label": "Employee", "type": "text", "width": 2.0},
    {"key": "department", "label": "Department", "type": "text", "width": 1.4},
    {"key": "passType", "label": "Pass type", "type": "text", "width": 1.1},
    {"key": "destination", "label": "Destination", "type": "text", "width": 1.6},
    {"key": "reason", "label": "Reason", "type": "text", "width": 1.6},
    {"key": "exitGate", "label": "Exit gate", "type": "text", "width": 1.0},
    {"key": "exitedAt", "label": "Out", "type": "datetime", "width": 1.4},
    {"key": "entryGate", "label": "Return gate", "type": "text", "width": 1.0},
    {"key": "enteredAt", "label": "Back", "type": "datetime", "width": 1.4},
    {"key": "expectedReturnAt", "label": "Expected back", "type": "datetime", "width": 1.4},
    {"key": "minutesOut", "label": "Time out", "type": "minutes", "width": 1.0},
    {"key": "overMinutes", "label": "Over expected", "type": "minutes", "width": 1.1},
    {"key": "approvedBy", "label": "Approved by", "type": "text", "width": 1.6},
    {"key": "status", "label": "Status", "type": "text", "width": 1.1},
]


def _export_row(req: OutpassRequest, now_dt: datetime) -> dict:
    row = _row_json(req, now_dt)
    return {
        "date": C.ist_date(req.exited_at),
        "employeeCode": row["employee"]["employeeCode"],
        "employeeName": row["employee"]["name"],
        "department": row["employee"]["department"],
        "passType": row["passTypeLabel"],
        "destination": C.clean(req.destination),
        "reason": C.clean(req.reason),
        "exitGate": row["exitGateName"],
        "exitedAt": req.exited_at,
        "entryGate": row["entryGateName"],
        "enteredAt": req.entered_at,
        "expectedReturnAt": req.expected_return_at,
        "minutesOut": row["minutesOut"],
        "overMinutes": row["overMinutes"],
        "approvedBy": row["approvedBy"],
        "status": row["statusLabel"],
    }


def _describe(f: _Filters) -> list[tuple[str, str]]:
    """The file's filters line, in the words of the page."""
    out: list[tuple[str, str]] = []
    if f.date_from == f.date_to:
        out.append(("Date", display_date(f.date_from)))
    else:
        out.append(("Dates", f"{display_date(f.date_from) or 'start'} to {display_date(f.date_to) or 'today'}"))
    if f.gate_id is not None:
        name = GateDevice.objects.filter(pk=f.gate_id).values_list("name", flat=True).first()
        out.append(("Gate", name or f"Gate {f.gate_id}"))
    if f.department_id is not None:
        name = Department.objects.filter(pk=f.department_id).values_list("name", flat=True).first()
        out.append(("Department", name or f"Department {f.department_id}"))
    if f.employee_id is not None:
        emp = Employee.objects.filter(pk=f.employee_id).only("employee_code", "first_name", "last_name").first()
        out.append(("Employee", f"{full_name(emp)} ({emp.employee_code})" if emp else f"Employee {f.employee_id}"))
    if f.status:
        out.append(("Status", STATUS_FILTER_LABELS[f.status]))
    if f.q:
        out.append(("Search", f.q))
    if f.branch_id is not None:
        name = Branch.objects.filter(pk=f.branch_id).values_list("name", flat=True).first()
        out.append(("Branch", name or f"Branch {f.branch_id}"))
    return out


@api_view(["GET"])
@require_hr
def outpass_in_out_export(request: Request) -> Response:
    """The filtered rows (every page) as ?fmt=xlsx or pdf, with the headline figures of those rows on top."""
    fmt = export_format(request.query_params.get("fmt"))
    if fmt is None:
        return bad_format_response()
    try:
        f = _filters(request)
    except BadParam as e:
        return _bad(e)
    now_dt, today_start = _clock()
    qs = _rows_qs(f, now_dt, today_start)
    # one more row than Excel takes, so file_response can say "too many" without reading a whole table
    rows = [_export_row(r, now_dt) for r in qs[:EXPORT_FETCH_LIMIT].iterator(chunk_size=1000)]
    s = _summary(_queryset(f).filter(_status_q(f.status, now_dt, today_start)), now_dt, today_start)
    summary = [
        {"label": "Went out", "value": s["wentOut"]},
        {"label": "Came back", "value": s["cameBack"]},
        {"label": "Still out", "value": s["stillOut"]},
        {"label": "Overdue", "value": s["overdue"]},
        {"label": "Not returned", "value": s["notReturned"]},
        {"label": "Average time out", "value": s["avgMinutesOut"], "format": "minutes"},
        {"label": "Longest time out", "value": s["longestMinutesOut"], "format": "minutes"},
    ]
    return file_response(
        request,
        slug="gate_pass_in_out",
        title="Gate pass in / out",
        columns=EXPORT_COLUMNS,
        rows=rows,
        fmt=fmt,
        filters_text=_describe(f),
        summary=summary,
        notes=[
            "All times are India time (IST). The date is the day of the exit scan.",
            "Time out runs from the exit scan to the return scan (until now for a pass still out today).",
            "Still out counts the overdue passes too. Not returned: out on an earlier day, never scanned back.",
        ],
    )


@api_view(["GET"])
@require_hr
def outpass_in_out_options(request: Request) -> Response:
    """{gates: [{id, name, isActive, branchName}], departments: [{id, name, category, branchName}]} for the filter
    selects: the user's branch only when the account is bound to one (its departments include the ones with no branch).
    A name that appears twice is told apart by its branch / category in `name`."""
    scope = get_branch_scope(request)
    gates = GateDevice.objects.select_related("branch").order_by("name", "id")
    departments = Department.objects.select_related("branch").order_by("name", "id")
    if scope is not None:
        gates = gates.filter(branch_id=scope)
        departments = departments.filter(Q(branch_id=scope) | Q(branch__isnull=True))
    gate_rows = [
        {"id": g.id, "name": g.name, "isActive": g.is_active, "branchName": g.branch.name if g.branch_id else None}
        for g in gates
    ]
    dept_rows = [
        {
            "id": d.id,
            "name": d.name,
            "category": d.category,
            "branchName": d.branch.name if d.branch_id else None,
        }
        for d in departments
    ]
    _tell_apart(gate_rows, lambda r: [r["branchName"]])
    _tell_apart(
        dept_rows,
        lambda r: [r["branchName"], "Production" if r["category"] == Department.CATEGORY_PRODUCTION else "Staff"],
    )
    return Response({"gates": gate_rows, "departments": dept_rows})


def _tell_apart(rows: list[dict], facts) -> None:
    """Adds " (Unit 1, Production)" to the names that appear more than once, so a select never offers two equal labels."""
    seen: dict[str, int] = {}
    for r in rows:
        seen[r["name"].casefold()] = seen.get(r["name"].casefold(), 0) + 1
    for r in rows:
        if seen[r["name"].casefold()] > 1:
            extra = ", ".join(x for x in facts(r) if x)
            if extra:
                r["name"] = f"{r['name']} ({extra})"
