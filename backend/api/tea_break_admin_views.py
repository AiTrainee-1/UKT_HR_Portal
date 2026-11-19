"""
Tea Break (HR portal): the records list's filters, its summary, one break's detail, the employee-wise view, the filter
options and the Excel / PDF export, under /api/tea-break/records/* (permission key outpass_visitors.tea_break.records:
view for every GET; the rule is tea_break_views.tea_break_rule under .rule).

The list itself is still the URL of tea_break_views.tea_break_records (the mobile app, the Employee Web App, the reports
and the MD parity tests know that module); its body is `records_page` below. Every row is still `_log_json` (same
signature, same four remark strings) plus added keys.

Filters (query string, every endpoint here takes the same ones):
    from, to        YYYY-MM-DD, inclusive IST days of the break's START (out_at); a break that crosses midnight belongs to
                    the day it started. Without them the old `range` = today | week | month (default today) applies.
    departmentId    the employee's department (one id or a comma list)
    employeeId      one employee
    gateId          the gate the break started OR ended at (one id or a comma list)
    status          on_break | on_time | overtime | not_returned   (the old `filter` = overtime | not_returned still works)
    q               employee code or name, up to 4 words, every word must match
    branchId        the employee's branch, for an HR account that is not bound to a branch (a bound one always gets its
                    own branch, whatever it sends)

Numbers come from reporting/definitions/gate_visitor_tea_common (tea_measures, remark_q, WholeMinutes, read-only
tea_rule), so the page, the Report Center (tea-break-register) and the MD portal can never disagree. Nothing here writes
to the database except the audit row of an export.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from django.db.models import Count, F, FloatField, IntegerField, Q, Value
from django.db.models.functions import Cast, Coalesce, NullIf
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import gate_exports
from .auth import require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ
from .employee_photo import photo_links
from .models import Branch, Department, Employee, GateDevice, TeaBreakLog
from .outpass_visitor_views import _paginate_params
from .reporting.definitions import gate_visitor_tea_common as C
from .tea_break_views import _employee_json, _log_json

# ── vocabulary ───────────────────────────────────────────────────────────────

# The page's status words -> the remark the API has always sent (the mobile and web apps read the remark strings).
STATUS_REMARK = {
    "on_break": "in_progress",
    "on_time": "on_time",
    "overtime": "overtime",
    "not_returned": "not_returned",
}
REMARK_STATUS = {remark: status for status, remark in STATUS_REMARK.items()}
STATUS_LABEL = {
    "on_break": "On break",
    "on_time": "On time",
    "overtime": "Overtime",
    "not_returned": "Not returned",
}
FLAG_CODE = {C.FLAG_LONG: "long", C.FLAG_OPEN: "left_open"}
FLAG_LABEL = {"long": "Long break", "left_open": "Left open"}

RANGES = ("today", "week", "month")
MAX_TERMS = 4
RECENT_COUNT = 10
EXPORT_VIEWS = ("breaks", "employees")
# one more row than the Excel limit, so gate_exports can say "too many" without reading a whole table
EXPORT_FETCH_LIMIT = gate_exports.ROW_LIMITS["xlsx"] + 1

# employees view: ?sort=<key> (ascending) or -<key> (descending)
EMPLOYEE_SORTS = {
    "name": ("employee__first_name", "employee__last_name"),
    "code": ("employee__employee_code",),
    "breaks": ("breaks",),
    "total": ("total_min",),
    "avg": ("avg_min",),
    "longest": ("max_min",),
    "overtime": ("overtime",),
    "notReturned": ("not_returned",),
    "over": ("over_min",),
}
DEFAULT_EMPLOYEE_SORT = "-breaks"

_RECORD_RELATED = ("employee__department", "employee__designation", "employee__branch", "out_gate", "in_gate")


class BadParam(ValueError):
    """A query parameter these endpoints cannot use; str(e) is the 400's {"error": ...}."""


def _bad(e: BadParam) -> Response:
    return Response({"error": str(e)}, status=400)


# ── filters ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TeaFilters:
    d_from: date | None
    d_to: date | None
    department_ids: tuple[int, ...] | None
    employee_id: int | None
    gate_ids: tuple[int, ...] | None
    status: str | None
    legacy_filter: str | None
    terms: tuple[str, ...]
    q: str
    branch_id: int | None
    branch_scoped: bool

    @property
    def bounds(self) -> tuple[datetime | None, datetime | None]:
        return C.ist_bounds(self.d_from, self.d_to)


def _day(value: str | None, name: str) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise BadParam(f"{name} must be a date like 2026-11-18") from None


def _ids(value: str | None, name: str) -> tuple[int, ...] | None:
    text = (value or "").strip()
    if not text:
        return None
    out = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            raise BadParam(f"{name} must be a number or a comma list of numbers")
        out.append(int(part))
    return tuple(out) or None


def _one_id(value: str | None, name: str) -> int | None:
    text = (value or "").strip()
    if not text:
        return None
    if not text.isdigit():
        raise BadParam(f"{name} must be a number")
    return int(text)


def _range_days(range_key: str | None, now: datetime) -> tuple[date, date]:
    """The old `range` (today | week | month; anything else is today) as inclusive IST days ending today."""
    today = now.astimezone(FACTORY_TZ).date()
    if range_key == "week":
        return today - timedelta(days=today.weekday()), today
    if range_key == "month":
        return today.replace(day=1), today
    return today, today


def parse_filters(request: Request, now: datetime) -> TeaFilters:
    """The query string -> TeaFilters. Raises BadParam (a 400) for anything it cannot use."""
    get = request.query_params.get
    d_from, d_to = _day(get("from"), "from"), _day(get("to"), "to")
    if d_from is None and d_to is None:
        d_from, d_to = _range_days((get("range") or "today").strip(), now)
    if d_from and d_to and d_from > d_to:
        raise BadParam("from must be on or before to")

    status = (get("status") or "").strip() or None
    if status == "in_progress":  # the remark's own word, accepted quietly
        status = "on_break"
    if status is not None and status not in STATUS_REMARK:
        raise BadParam("status must be on_break, on_time, overtime or not_returned")
    legacy = (get("filter") or "").strip()
    legacy_filter = legacy if legacy in ("overtime", "not_returned") else None  # the old filter ignored anything else

    q = " ".join((get("q") or "").split())
    scope = get_branch_scope(request)
    branch_id = scope if scope is not None else _one_id(get("branchId"), "branchId")
    return TeaFilters(
        d_from=d_from,
        d_to=d_to,
        department_ids=_ids(get("departmentId"), "departmentId"),
        employee_id=_one_id(get("employeeId"), "employeeId"),
        gate_ids=_ids(get("gateId"), "gateId"),
        status=status,
        legacy_filter=legacy_filter,
        terms=tuple(q.split()[:MAX_TERMS]),
        q=q,
        branch_id=branch_id,
        branch_scoped=scope is not None,
    )


def filtered_logs(f: TeaFilters, *, allowed: int, now: datetime, with_status: bool = True):
    """TeaBreakLog rows for these filters (no ordering, no related rows): the base of every endpoint here."""
    qs = TeaBreakLog.objects.order_by()
    if f.branch_id is not None:
        qs = qs.filter(employee__branch_id=f.branch_id)
    lo, hi = f.bounds
    if lo is not None:
        qs = qs.filter(out_at__gte=lo)
    if hi is not None:
        qs = qs.filter(out_at__lt=hi)
    if f.department_ids:
        qs = qs.filter(employee__department_id__in=f.department_ids)
    if f.employee_id is not None:
        qs = qs.filter(employee_id=f.employee_id)
    if f.gate_ids:
        qs = qs.filter(Q(out_gate_id__in=f.gate_ids) | Q(in_gate_id__in=f.gate_ids))
    for term in f.terms:
        qs = qs.filter(
            Q(employee__employee_code__icontains=term)
            | Q(employee__first_name__icontains=term)
            | Q(employee__last_name__icontains=term)
        )
    if with_status and f.status:
        qs = qs.filter(C.remark_q(STATUS_REMARK[f.status], allowed, now))
    if with_status and f.legacy_filter:
        qs = qs.filter(C.remark_q(f.legacy_filter, allowed, now))
    return qs


def _context(request: Request):
    """(now, allowed minutes, rule changed at, filters) for a request; raises BadParam."""
    now = C.now_utc()
    allowed, rule_at = C.tea_rule()  # read-only: TeaBreakRule.get() would INSERT on a GET
    return now, allowed, rule_at, parse_filters(request, now)


# ── one break ────────────────────────────────────────────────────────────────


def record_json(log: TeaBreakLog, allowed: int, now: datetime, photos: dict | None = None) -> dict:
    """`_log_json` (unchanged: the apps and the parity tests read it) plus the page's added keys."""
    body = _log_json(log, allowed, now, photos)
    done = log.in_at is not None
    taken = body["takenMinutes"]
    flag = FLAG_CODE.get(C.tea_flag(log.out_at, log.in_at, taken, now))
    status = REMARK_STATUS[body["remark"]]
    emp = log.employee
    body.update(
        {
            "designation": emp.designation.title if emp.designation_id else None,
            "branchName": emp.branch.name if emp.branch_id else None,
            "overMinutes": max(0, taken - allowed) if done else None,
            "flag": flag,
            "flagLabel": FLAG_LABEL.get(flag) if flag else None,
            "allowedMinutes": allowed,
            "status": status,
            "statusLabel": STATUS_LABEL[status],
            "outGateId": log.out_gate_id,
            "inGateId": log.in_gate_id,
        }
    )
    return body


def _with_related(qs):
    # a month is thousands of rows: only the page's photo links are looked up (photo_links), no photo column is read
    return qs.select_related(*_RECORD_RELATED).defer("employee__photo_url")


def records_page(request: Request) -> Response:
    """GET /api/tea-break/records (tea_break_views.tea_break_records): one page of breaks, newest first."""
    try:
        now, allowed, _rule_at, f = _context(request)
    except BadParam as e:
        return _bad(e)
    page, page_size = _paginate_params(request)
    qs = filtered_logs(f, allowed=allowed, now=now)
    total = qs.count()
    offset = (page - 1) * page_size
    logs = list(_with_related(qs).order_by("-out_at", "-id")[offset : offset + page_size])
    photos = photo_links(log.employee_id for log in logs)
    return Response(
        {
            "items": [record_json(log, allowed, now, photos) for log in logs],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "allowedMinutes": allowed,
        }
    )


# ── summary ──────────────────────────────────────────────────────────────────


def measures(qs, allowed: int, now: datetime) -> dict:
    """The page's headline numbers for a TeaBreakLog queryset, from the shared tea_measures (Report Center parity)."""
    agg = qs.aggregate(**C.tea_measures(allowed, now), people=Count("employee_id", distinct=True))
    return {
        "breaks": agg["breaks"],
        "onBreakNow": agg["in_progress"],
        "onTime": agg["on_time"],
        "overtime": agg["overtime"],
        "notReturned": agg["not_returned"],
        "avgMinutes": C.avg(agg["total_min"], agg["completed"]),
        "longestMinutes": agg["max_min"],
        "employees": agg["people"],
        "overMinutesTotal": C.over_minutes(agg["over_sum"], agg["overtime"], allowed),
        "allowedMinutes": allowed,
        "completed": agg["completed"],
        "totalMinutes": int(agg["total_min"] or 0),
        "longOrOpen": agg["long_breaks"],
    }


@api_view(["GET"])
@require_hr
def tea_break_records_summary(request: Request) -> Response:
    """GET /api/tea-break/records/summary?<filters>: the numbers of every break the filters match (status included; the
    page leaves status out so its tiles stay the period's overview)."""
    try:
        now, allowed, _rule_at, f = _context(request)
    except BadParam as e:
        return _bad(e)
    body = measures(filtered_logs(f, allowed=allowed, now=now), allowed, now)
    body["from"] = f.d_from.isoformat() if f.d_from else None
    body["to"] = f.d_to.isoformat() if f.d_to else None
    return Response(body)


# ── one break's detail ───────────────────────────────────────────────────────


def _month_days(day: date) -> tuple[date, date]:
    first = day.replace(day=1)
    nxt = first.replace(year=first.year + 1, month=1) if first.month == 12 else first.replace(month=first.month + 1)
    return first, nxt - timedelta(days=1)


@api_view(["GET"])
@require_hr
def tea_break_record_detail(request: Request, pk: int) -> Response:
    """GET /api/tea-break/records/<id>: the break, that employee's numbers for the IST month the break started in, and
    their latest 10 breaks (this one included)."""
    now = C.now_utc()
    allowed, _rule_at = C.tea_rule()
    qs = TeaBreakLog.objects.all()
    scope = get_branch_scope(request)
    if scope is not None:
        qs = qs.filter(employee__branch_id=scope)
    log = _with_related(qs).filter(pk=pk).first()
    if log is None:
        return Response({"error": "This tea break was not found."}, status=404)

    photos = photo_links([log.employee_id])
    body = record_json(log, allowed, now, photos)
    first, last = _month_days(log.out_at.astimezone(FACTORY_TZ).date())
    lo, hi = C.ist_bounds(first, last)
    month = measures(
        TeaBreakLog.objects.order_by().filter(employee_id=log.employee_id, out_at__gte=lo, out_at__lt=hi), allowed, now
    )
    body["employeeMonth"] = {
        "month": first.strftime("%Y-%m"),
        "label": first.strftime("%B %Y"),
        "breaks": month["breaks"],
        "onTime": month["onTime"],
        "overtime": month["overtime"],
        "notReturned": month["notReturned"],
        "avgMinutes": month["avgMinutes"],
        "totalMinutes": month["totalMinutes"],
        "overMinutesTotal": month["overMinutesTotal"],
    }
    recent = _with_related(TeaBreakLog.objects.filter(employee_id=log.employee_id)).order_by("-out_at", "-id")
    body["recent"] = [record_json(r, allowed, now, photos) for r in recent[:RECENT_COUNT]]
    return Response(body)


# ── employee-wise ────────────────────────────────────────────────────────────


def _employee_groups(qs, allowed: int, now: datetime, *extra_fields: str):
    """One row per employee with the shared measures, plus avg_min / over_min to sort on."""
    return (
        qs.values(
            "employee_id", "employee__employee_code", "employee__first_name", "employee__last_name", *extra_fields
        )
        .annotate(**C.tea_measures(allowed, now))
        .annotate(
            avg_min=Cast(F("total_min"), FloatField()) / Cast(NullIf(F("completed"), Value(0)), FloatField()),
            over_min=Coalesce(F("over_sum"), Value(0), output_field=IntegerField()) - Value(allowed) * F("overtime"),
        )
    )


def _employee_order(sort: str | None) -> list:
    sort = (sort or "").strip() or DEFAULT_EMPLOYEE_SORT
    desc = sort.startswith("-")
    key = sort[1:] if desc else sort
    if key not in EMPLOYEE_SORTS:
        raise BadParam("sort must be one of " + ", ".join(EMPLOYEE_SORTS) + " (a leading - sorts high to low)")
    fields = [F(name).desc(nulls_last=True) if desc else F(name).asc(nulls_last=True) for name in EMPLOYEE_SORTS[key]]
    return [*fields, "employee__employee_code", "employee_id"]


def _employee_row_numbers(g: dict) -> dict:
    return {
        "breaks": g["breaks"],
        "completed": g["completed"],
        "onTime": g["on_time"],
        "overtime": g["overtime"],
        "notReturned": g["not_returned"],
        "onBreak": g["in_progress"],
        "onBreakNow": g["in_progress"] > 0,
        "totalMinutes": int(g["total_min"] or 0),
        "avgMinutes": C.avg(g["total_min"], g["completed"]),
        "longestMinutes": g["max_min"],
        "overMinutesTotal": int(g["over_min"] or 0),
    }


@api_view(["GET"])
@require_hr
def tea_break_records_employees(request: Request) -> Response:
    """GET /api/tea-break/records/employees?<filters>&sort&page&pageSize: one row per employee who took a matching break,
    aggregated in SQL. sort: name | code | breaks | total | avg | longest | overtime | notReturned | over, "-" first for
    high to low (default -breaks)."""
    try:
        now, allowed, _rule_at, f = _context(request)
        order = _employee_order(request.query_params.get("sort"))
    except BadParam as e:
        return _bad(e)
    page, page_size = _paginate_params(request)
    groups = _employee_groups(filtered_logs(f, allowed=allowed, now=now), allowed, now)
    total = groups.count()
    offset = (page - 1) * page_size
    rows = list(groups.order_by(*order)[offset : offset + page_size])
    ids = [g["employee_id"] for g in rows]
    people = {
        e.id: e
        for e in Employee.objects.filter(pk__in=ids)
        .select_related("department", "designation", "branch")
        .defer("photo_url")
    }
    photos = photo_links(ids)
    items = []
    for g in rows:
        emp = people.get(g["employee_id"])
        if emp is None:  # deleted between the two queries
            continue
        person = _employee_json(emp, photos)
        person["designation"] = emp.designation.title if emp.designation_id else None
        person["branchName"] = emp.branch.name if emp.branch_id else None
        items.append({"employee": person, **_employee_row_numbers(g)})
    return Response({"items": items, "total": total, "page": page, "pageSize": page_size, "allowedMinutes": allowed})


# ── options ──────────────────────────────────────────────────────────────────


def _labelled(rows: list[tuple[int, str, str | None, str | None]]) -> list[dict]:
    """[(id, name, branch name, category)] -> [{id, name}], naming the branch (then the kind) of a repeated name."""
    by_name: dict[str, int] = {}
    for _id, name, _branch, _cat in rows:
        by_name[name.casefold()] = by_name.get(name.casefold(), 0) + 1
    labels = []
    for pk, name, branch, cat in rows:
        label = name
        if by_name[name.casefold()] > 1:
            label = f"{name} · {branch or 'No branch'}"
        labels.append((pk, label, cat))
    seen: dict[str, int] = {}
    for _pk, label, _cat in labels:
        seen[label.casefold()] = seen.get(label.casefold(), 0) + 1
    out = []
    for pk, label, cat in labels:
        if seen[label.casefold()] > 1 and cat:
            label = f"{label} · {'Production' if cat == Department.CATEGORY_PRODUCTION else 'Staff'}"
        out.append({"id": pk, "name": label})
    return out


@api_view(["GET"])
@require_hr
def tea_break_records_options(request: Request) -> Response:
    """GET /api/tea-break/records/options: the department and gate choices of the filter bar (in the user's branch, or in
    ?branchId= for an account not bound to one), the branches an unbound account may pick, and the allowed minutes."""
    scope = get_branch_scope(request)
    try:
        branch_id = scope if scope is not None else _one_id(request.query_params.get("branchId"), "branchId")
    except BadParam as e:
        return _bad(e)
    departments = Department.objects.all()
    gates = GateDevice.objects.all()
    if branch_id is not None:
        departments = departments.filter(branch_id=branch_id)
        gates = gates.filter(branch_id=branch_id)
    dept_rows = list(
        departments.order_by("name", "branch__name", "category", "id").values_list(
            "id", "name", "branch__name", "category"
        )
    )
    gate_list = [
        {"id": g["id"], "name": g["name"] if g["is_active"] else f"{g['name']} (switched off)"}
        for g in gates.order_by("name", "id").values("id", "name", "is_active")
    ]
    branches = (
        []
        if scope is not None
        else [{"id": b["id"], "name": b["name"]} for b in Branch.objects.order_by("name", "id").values("id", "name")]
    )
    allowed, rule_at = C.tea_rule()
    return Response(
        {
            "departments": _labelled(dept_rows),
            "gates": gate_list,
            "branches": branches,
            "branchScoped": scope is not None,
            "allowedMinutes": allowed,
            "ruleUpdatedAt": rule_at.isoformat() if rule_at else None,
        }
    )


# ── export ───────────────────────────────────────────────────────────────────

BREAK_COLUMNS = [
    {"key": "date", "label": "Date", "type": "date", "width": 1.2},
    {"key": "employeeCode", "label": "Emp code", "type": "text", "width": 0.95},
    {"key": "employeeName", "label": "Employee", "type": "text", "width": 1.9},
    {"key": "department", "label": "Department", "type": "text", "width": 1.4},
    {"key": "designation", "label": "Designation", "type": "text", "width": 1.3},
    {"key": "outAt", "label": "Out", "type": "time", "width": 0.8},
    {"key": "outGate", "label": "Out gate", "type": "text", "width": 1.0},
    {"key": "inAt", "label": "Back", "type": "text", "width": 1.0},
    {"key": "inGate", "label": "Back gate", "type": "text", "width": 1.0},
    {"key": "takenMinutes", "label": "Minutes", "type": "minutes", "width": 0.85},
    {"key": "allowedMinutes", "label": "Allowed", "type": "minutes", "width": 0.85},
    {"key": "overMinutes", "label": "Over by", "type": "minutes", "width": 0.85},
    {"key": "status", "label": "Status", "type": "badge", "width": 1.1},
    {"key": "flag", "label": "Check", "type": "badge", "width": 1.0},
]

EMPLOYEE_COLUMNS = [
    {"key": "employeeCode", "label": "Emp code", "type": "text", "width": 0.95},
    {"key": "employeeName", "label": "Employee", "type": "text", "width": 1.9},
    {"key": "department", "label": "Department", "type": "text", "width": 1.5},
    {"key": "designation", "label": "Designation", "type": "text", "width": 1.3},
    {"key": "breaks", "label": "Breaks", "type": "int", "width": 0.8},
    {"key": "totalMinutes", "label": "Total time", "type": "duration", "width": 1.0},
    {"key": "avgMinutes", "label": "Average (min)", "type": "number", "width": 1.0},
    {"key": "longestMinutes", "label": "Longest (min)", "type": "minutes", "width": 1.0},
    {"key": "overtime", "label": "Overtime", "type": "int", "width": 0.9},
    {"key": "overMinutesTotal", "label": "Over allowance", "type": "duration", "width": 1.1},
    {"key": "notReturned", "label": "Not returned", "type": "int", "width": 1.0},
    {"key": "onBreak", "label": "On break now", "type": "int", "width": 1.0},
]


def _fmt_day(d: date) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


def describe_filters(f: TeaFilters, allowed: int) -> list[tuple[str, str]]:
    """(label, value) pairs for the file's filters line."""
    if f.d_from and f.d_to:
        dates = _fmt_day(f.d_from) if f.d_from == f.d_to else f"{_fmt_day(f.d_from)} - {_fmt_day(f.d_to)}"
    elif f.d_from:
        dates = f"From {_fmt_day(f.d_from)}"
    elif f.d_to:
        dates = f"Up to {_fmt_day(f.d_to)}"
    else:
        dates = "All dates"
    pairs = [("Dates", dates)]
    if f.branch_id is not None:
        name = Branch.objects.filter(pk=f.branch_id).values_list("name", flat=True).first()
        pairs.append(("Branch", name or f"#{f.branch_id}"))
    if f.department_ids:
        names = list(Department.objects.filter(pk__in=f.department_ids).order_by("name").values_list("name", flat=True))
        pairs.append(("Department", ", ".join(names) or "-"))
    if f.employee_id is not None:
        emp = Employee.objects.filter(pk=f.employee_id).values("employee_code", "first_name", "last_name").first()
        pairs.append(
            (
                "Employee",
                f"{emp['employee_code']} {C.person_name(emp['first_name'], emp['last_name'])}" if emp else "-",
            )
        )
    if f.gate_ids:
        names = list(GateDevice.objects.filter(pk__in=f.gate_ids).order_by("name").values_list("name", flat=True))
        pairs.append(("Gate", ", ".join(names) or "-"))
    if f.status:
        pairs.append(("Status", STATUS_LABEL[f.status]))
    elif f.legacy_filter:
        pairs.append(("Status", STATUS_LABEL[REMARK_STATUS[f.legacy_filter]]))
    if f.q:
        pairs.append(("Search", f.q))
    pairs.append(("Allowed", f"{allowed} min"))
    return pairs


def _summary_lines(numbers: dict, allowed: int) -> list[dict]:
    return [
        {"label": "Allowed minutes", "value": allowed, "format": "minutes"},
        {"label": "Breaks", "value": numbers["breaks"], "format": "int"},
        {"label": "On break now", "value": numbers["onBreakNow"], "format": "int"},
        {"label": f"Over {allowed} min", "value": numbers["overtime"], "format": "int"},
        {"label": "Not returned", "value": numbers["notReturned"], "format": "int"},
        {"label": "Average break (min)", "value": numbers["avgMinutes"], "format": "number"},
        {"label": "Longest break (min)", "value": numbers["longestMinutes"], "format": "minutes"},
        {"label": "Employees", "value": numbers["employees"], "format": "int"},
        {"label": "Minutes over allowance", "value": numbers["overMinutesTotal"], "format": "minutes"},
    ]


def _break_rows(qs, allowed: int, now: datetime) -> list[dict]:
    fetched = qs.values(
        "out_at",
        "in_at",
        "out_gate__name",
        "in_gate__name",
        *C.emp_value_fields(),
    ).order_by("-out_at", "-id")[:EXPORT_FETCH_LIMIT]
    rows = []
    for r in fetched:
        taken, remark = C.tea_metrics(r["out_at"], r["in_at"], allowed, now)
        done = r["in_at"] is not None
        day = C.to_ist(r["out_at"]).date()
        flag = FLAG_CODE.get(C.tea_flag(r["out_at"], r["in_at"], taken, now))
        cells = C.emp_cells_from_values(r)
        rows.append(
            {
                "date": day,
                **cells,
                "outAt": C.hhmm(r["out_at"]),
                "outGate": r["out_gate__name"],
                "inAt": C.hhmm_relative(r["in_at"], day),
                "inGate": r["in_gate__name"],
                "takenMinutes": taken if done else None,
                "allowedMinutes": allowed,
                "overMinutes": max(0, taken - allowed) if done else None,
                "status": STATUS_LABEL[REMARK_STATUS[remark]],
                "flag": FLAG_LABEL.get(flag) if flag else None,
            }
        )
    return rows


def _employee_rows(qs, allowed: int, now: datetime, sort: str | None) -> list[dict]:
    groups = _employee_groups(qs, allowed, now, "employee__department__name", "employee__designation__title")
    rows = []
    for g in groups.order_by(*_employee_order(sort))[:EXPORT_FETCH_LIMIT]:
        numbers = _employee_row_numbers(g)
        rows.append(
            {
                "employeeCode": g["employee__employee_code"],
                "employeeName": C.person_name(g["employee__first_name"], g["employee__last_name"]),
                "department": g["employee__department__name"] or "Unassigned",
                "designation": g["employee__designation__title"],
                **numbers,
            }
        )
    return rows


@api_view(["GET"])
@require_hr
def tea_break_records_export(request: Request) -> Response:
    """GET /api/tea-break/records/export?fmt=xlsx|pdf&view=breaks|employees&<filters>(&sort for employees): every matching
    row (no paging) as a Report Center style file, with the filters line and the headline numbers."""
    view = (request.query_params.get("view") or "breaks").strip()
    if view not in EXPORT_VIEWS:
        return Response({"error": "view must be breaks or employees"}, status=400)
    fmt = gate_exports.export_format(request.query_params.get("fmt"))
    if fmt is None:
        return gate_exports.bad_format_response()
    try:
        now, allowed, rule_at, f = _context(request)
        sort = request.query_params.get("sort")
        if view == "employees":
            _employee_order(sort)  # a bad sort is a 400 before anything is read
    except BadParam as e:
        return _bad(e)
    qs = filtered_logs(f, allowed=allowed, now=now)
    numbers = measures(qs, allowed, now)
    notes = [
        C.rule_note(allowed, rule_at),
        "Times are India time; a break belongs to the day it started. Open breaks have no duration: more than "
        "60 minutes open is 'Not returned'. 'Long break' = a finished break over 60 minutes and 'Left open' = never "
        "scanned back in for over 12 hours; both usually mean a missed scan.",
    ]
    if view == "employees":
        rows, columns = _employee_rows(qs, allowed, now, sort), EMPLOYEE_COLUMNS
        slug, title = "tea_breaks_by_employee", "Tea breaks by employee"
    else:
        rows, columns = _break_rows(qs, allowed, now), BREAK_COLUMNS
        slug, title = "tea_breaks", "Tea breaks"
    return gate_exports.file_response(
        request,
        slug=slug,
        title=title,
        columns=columns,
        rows=rows,
        fmt=fmt,
        filters_text=describe_filters(f, allowed),
        summary=_summary_lines(numbers, allowed),
        notes=notes,
    )
