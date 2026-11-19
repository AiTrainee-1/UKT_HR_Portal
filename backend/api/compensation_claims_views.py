"""
The compensation claim endpoints (2026-11-19 spec, "API contract"). JSON is camelCase; every claim is a HolidayWorkClaim
(compensation_claims.py does the work: create_claim / eligibility / decide / claim_json; ClaimError -> {error, code}).

Employee (employee token, staff only; HR tokens get 403; production staff are refused with code not_staff). The mobile
app sends request bodies in snake_case (overtime_record_id ...), the Employee Web App in camelCase: both are read.

    GET    /api/employee/compensation/claims?status=&kind=      {items, total, isStaff, message}: own claims, newest first
    POST   /api/employee/compensation/claims                    {kind, date, overtimeRecordId?, shifts?, reason} -> 201
                                                                (birthday: shifts fixed at 1.00; holiday_work: 1.00 when
                                                                omitted; ot_shift: the quarters credit when omitted)
    DELETE /api/employee/compensation/claims/<id>               withdraw an own claim (raised by the employee) still pending
    POST   /api/employee/compensation/use                       {date, shifts, reason} -> 201 (kind use_balance); the date
                                                                must be in the request window (request_window.py)

HR (require_hr; permission keys in permission_tree.py under compensation.leave.holiday_work; changes are refused while
the OT / Compensation master switch is off, like every compensation change):

    GET    /api/compensation/claims?kind=&status=&month=&year=&anyMonth=&employeeId=&departmentId=&branchId=&q=&raisedBy=
           &page=&pageSize=                                     {items, total, page, pageSize, month, year, summary
                                                                {byStatus, byKind, pendingShifts, approvedShifts,
                                                                creditedShifts, pendingCreditShifts, pendingUseShifts},
                                                                enabled}
    POST   /api/compensation/claims                             {kind, date, reason, items: [{employeeId, shifts?,
                                                                overtimeRecordId?}]} on behalf, all-or-nothing ->
                                                                201 {created, claims, warnings}
    GET    /api/compensation/claims/<id>                        one claim (the drawer)
    DELETE /api/compensation/claims/<id>                        withdraw a pending claim -> 204
    POST   /api/compensation/use                                {employeeId, date, shifts, reason}: to the HOD like the app
    GET    /api/compensation/balance?departmentId=&branchId=&q=&page=&pageSize=  |  ?employeeId=
    GET    /api/compensation/ledger?entryType=&source=&month=&year=&employeeId=&departmentId=&branchId=&q=&page=&pageSize=
    GET    /api/compensation/holiday-work/month?month=&year=&departmentId=&branchId=

The HOD decides through the existing manager endpoints (PATCH /api/manager/holiday-work/<id>/status), any kind.
POST /api/compensation/holiday-work and POST /api/compensation/balance/redeem keep working where they are.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q, Sum
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import compensation_claims as claims
from . import request_window
from .audit_utils import log_action
from .auth import get_hr_display_name, require_auth, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import (
    date_text,
    day_kind,
    employee_json,
    full_name,
    holiday_names,
    parse_date,
    parse_id,
    parse_int,
    switches,
)
from .compensation_views import require_compensation_features_for_changes
from .models import (
    CompensationLeaveCredit,
    CompensationLedger,
    Employee,
    HolidayWorkClaim,
    OvertimeRecord,
)

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
MAX_ITEMS = 200
STATUSES = ("all", "pending", "waiting", "approved", "rejected")


def _employee_or_refusal(request: Request):
    """(employee, None) for an employee token, else (None, the 403 / 404 refusal): the same check as GET
    /api/employee/compensation."""
    from .employee_compensation_views import _employee_only

    return _employee_only(request)


def _bad(message: str, status: int = 400, code: str = "invalid", **extra) -> Response:
    return Response({"error": message, "code": code, **extra}, status=status)


def _refused(exc: claims.ClaimError) -> Response:
    return Response(exc.as_json(), status=exc.status)


def _body(data, *names):
    """The first of `names` the body carries (each given in camelCase is also read in snake_case: the mobile app's
    client converts every key)."""
    if not isinstance(data, dict):
        return None
    for name in names:
        snake = "".join(f"_{c.lower()}" if c.isupper() else c for c in name)
        for key in (name, snake):
            if key in data and data[key] not in (None, ""):
                return data[key]
    return None


def _page(q) -> tuple[int, int] | None:
    page = parse_int(q.get("page")) if q.get("page") not in (None, "") else 1
    size = parse_int(q.get("pageSize") or q.get("page_size")) if (q.get("pageSize") or q.get("page_size")) else None
    if page is None or page < 1:
        return None
    size = DEFAULT_PAGE_SIZE if size is None else size
    return page, max(1, min(size, MAX_PAGE_SIZE))


def _ids(q, *names) -> tuple[dict, str | None]:
    out = {}
    for name in names:
        raw = q.get(name)
        if raw in (None, ""):
            out[name] = None
            continue
        value = parse_id(raw)
        if value is None:
            return {}, f"{name} must be a number."
        out[name] = value
    return out, None


def _month_year(q, *, default_current: bool) -> tuple[int | None, int | None, str | None]:
    month = parse_int(q.get("month"))
    year = parse_int(q.get("year"))
    if (q.get("month") not in (None, "") and month is None) or (q.get("year") not in (None, "") and year is None):
        return None, None, "month and year must be numbers."
    if month is not None and not 1 <= month <= 12:
        return None, None, "month must be 1 to 12."
    today = ist_today()
    if month is None and year is None:
        if default_current:
            return today.month, today.year, None
        return None, None, None
    if year is None:
        year = today.year
    return month, year, None


# ───────────────────────────── employee (mobile app / Employee Web App) ─────────────────────────────


def _own_claims(emp, q) -> Response:
    if emp.employment_type != "staff":
        return Response(
            {"items": [], "total": 0, "isStaff": False, "message": "Compensation is for staff employees only."}
        )
    qs = claims.claim_queryset().filter(employee=emp)
    status = (q.get("status") or "all").lower()
    if status not in STATUSES:
        return _bad("status must be all, pending, approved or rejected.")
    if status != "all":
        qs = qs.filter(status=HolidayWorkClaim.STATUS_PENDING if status == "waiting" else status)
    kinds = [k for k in (q.get("kind") or "").split(",") if k and k != "all"]
    if any(k not in claims.ALL_KINDS for k in kinds):
        return _bad("kind must be holiday_work, ot_allowance, ot_shift, birthday or use_balance.")
    if kinds:
        qs = qs.filter(kind__in=kinds)
    rows = list(qs.order_by("-created_at", "-id")[:500])
    return Response(
        {"items": claims.claims_json(rows, for_role="employee"), "total": len(rows), "isStaff": True, "message": None}
    )


@api_view(["GET", "POST"])
@require_auth
def employee_compensation_claims(request: Request) -> Response:
    """GET: the employee's own claims (?status=&kind=), newest first. POST: raise a claim (holiday_work, ot_allowance,
    ot_shift, birthday) -> 201 with the claim; 400/403/409 {error, code} when refused."""
    emp, refusal = _employee_or_refusal(request)
    if refusal is not None:
        return refusal
    if request.method == "GET":
        return _own_claims(emp, request.query_params)

    data = request.data if isinstance(request.data, dict) else {}
    kind = str(_body(data, "kind") or "").strip()
    if kind not in claims.EMPLOYEE_CLAIM_KINDS:
        if kind == HolidayWorkClaim.KIND_USE_BALANCE:
            return _bad("To use your balance, send the request to /api/employee/compensation/use.")
        return _bad("kind must be holiday_work, ot_allowance, ot_shift or birthday.")
    record, error = _record_from(data, emp)
    if error:
        return error
    day = parse_date(_body(data, "date", "workDate"))
    if day is None and record is not None:
        day = record.date
    if day is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    shifts = None if kind == HolidayWorkClaim.KIND_BIRTHDAY else _body(data, "shifts")
    try:
        claim = claims.create_claim(
            employee=emp,
            kind=kind,
            date=day,
            shifts=shifts,
            overtime_record=record,
            reason=_body(data, "reason") or "",
            raised_by_role=HolidayWorkClaim.RAISED_BY_EMPLOYEE,
            raised_by_name=full_name(emp),
            request=request,
        )
    except claims.ClaimError as exc:
        return _refused(exc)
    return Response(claims.claims_json([_reload(claim.pk)], for_role="employee")[0], status=201)


def _record_from(data, emp) -> tuple[OvertimeRecord | None, Response | None]:
    raw = _body(data, "overtimeRecordId")
    if raw is None:
        return None, None
    record_id = parse_id(raw)
    if record_id is None:
        return None, _bad("overtimeRecordId must be a number.")
    record = OvertimeRecord.objects.filter(pk=record_id, employee=emp).first()
    if record is None:
        return None, _bad("No detected overtime was found for that day.", 404, "not_found")
    return record, None


def _reload(pk: int) -> HolidayWorkClaim:
    return claims.claim_queryset().get(pk=pk)


@api_view(["DELETE"])
@require_auth
def employee_compensation_claim_detail(request: Request, pk: int) -> Response:
    """DELETE: withdraw the employee's own claim while it is pending (only one the employee raised: a claim HR raised for
    them is HR's to withdraw)."""
    emp, refusal = _employee_or_refusal(request)
    if refusal is not None:
        return refusal
    claim = HolidayWorkClaim.objects.filter(pk=pk, employee=emp).first()
    if claim is None:
        return _bad("Claim not found.", 404, "not_found")
    if claim.raised_by_role != HolidayWorkClaim.RAISED_BY_EMPLOYEE:
        return _bad("HR raised this claim for you, so only HR can withdraw it. Please contact HR.", 403, "not_yours")
    try:
        snapshot = claims.withdraw(claim.pk)
    except claims.ClaimError as exc:
        return _refused(exc)
    log_action(
        request,
        "delete",
        "compensation",
        record_id=pk,
        description=f"{snapshot['employeeCode']} withdrew their {snapshot['kind']} claim for {snapshot['date']}",
        old_values=snapshot,
    )
    return Response(status=204)


@api_view(["POST"])
@require_auth
def employee_compensation_use(request: Request) -> Response:
    """POST {date, shifts, reason}: ask the HOD to use `shifts` of the balance on `date` -> 201 (kind use_balance)."""
    emp, refusal = _employee_or_refusal(request)
    if refusal is not None:
        return refusal
    data = request.data if isinstance(request.data, dict) else {}
    raw_date = _body(data, "date", "useDate")
    if emp.employment_type == "staff":
        closed = request_window.enforce_employee_date(request, raw_date)
        if closed is not None:
            return closed
    day = parse_date(raw_date)
    if day is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    try:
        claim = claims.create_claim(
            employee=emp,
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            date=day,
            shifts=_body(data, "shifts"),
            reason=_body(data, "reason") or "",
            raised_by_role=HolidayWorkClaim.RAISED_BY_EMPLOYEE,
            raised_by_name=full_name(emp),
            request=request,
        )
    except claims.ClaimError as exc:
        return _refused(exc)
    return Response(claims.claims_json([_reload(claim.pk)], for_role="employee")[0], status=201)


# ───────────────────────────── HR portal: claims ─────────────────────────────


def _enabled_block() -> dict:
    from .holiday_work_views import _enabled_block as holiday_block

    block = holiday_block()
    flags = switches()
    workflow = block["workflow"]
    block.update(
        {
            "allowance": flags["allowance"],
            "shift": flags["shift"],
            "birthday": flags["birthday"],
            "canClaim": bool(flags["master"] and workflow),
        }
    )
    return block


def _list_claims(request: Request) -> Response:
    q = request.query_params
    status = (q.get("status") or "all").lower()
    if status not in STATUSES:
        return _bad("status must be all, pending, approved or rejected.")
    kinds = [k for k in (q.get("kind") or "").split(",") if k and k != "all"]
    if any(k not in claims.ALL_KINDS for k in kinds):
        return _bad("kind must be holiday_work, ot_allowance, ot_shift, birthday or use_balance.")
    any_month = (q.get("anyMonth") or "").strip().lower() in ("1", "true", "yes")
    month, year, error = _month_year(q, default_current=not any_month)
    if error:
        return _bad(error)
    ids, error = _ids(q, "employeeId", "departmentId", "branchId")
    if error:
        return _bad(error)
    paging = _page(q)
    if paging is None:
        return _bad("page and pageSize must be positive numbers.")
    raised_by = (q.get("raisedBy") or "").strip().lower()
    if raised_by and raised_by not in ("hr", "employee"):
        return _bad("raisedBy must be hr or employee.")

    base = scope_to_branch(HolidayWorkClaim.objects.all(), request, field="employee__branch_id")
    if year is not None:
        base = base.filter(work_date__year=year)
    if month is not None:
        base = base.filter(work_date__month=month)
    if ids["employeeId"] is not None:
        base = base.filter(employee_id=ids["employeeId"])
    if ids["departmentId"] is not None:
        base = base.filter(employee__department_id=ids["departmentId"])
    if ids["branchId"] is not None:
        base = base.filter(employee__branch_id=ids["branchId"])
    if raised_by:
        base = base.filter(raised_by_role=raised_by)
    text = (q.get("q") or "").strip()
    if text:
        base = base.filter(claims.employee_search_q(text) | Q(reason__icontains=text))
    status_filter = HolidayWorkClaim.STATUS_PENDING if status == "waiting" else status
    qs = base.filter(kind__in=kinds) if kinds else base
    if status != "all":
        qs = qs.filter(status=status_filter)

    # the summary ignores the status and kind filters: the tiles ARE those filters
    status_rows = {
        r["status"]: r for r in base.order_by().values("status").annotate(n=Count("id"), total=Sum("shifts"))
    }
    by_kind = {r["kind"]: r["n"] for r in base.order_by().values("kind").annotate(n=Count("id"))}
    # approved shifts that went INTO the balance (credit kinds only; an approved use request takes shifts out)
    credited = (
        base.filter(status=HolidayWorkClaim.STATUS_APPROVED, kind__in=HolidayWorkClaim.CREDIT_KINDS)
        .order_by()
        .aggregate(total=Sum("shifts"))["total"]
    )
    # what waits for the HOD, split: shifts that would go INTO the balance (credit kinds) and shifts asked OUT of it (use
    # requests); pendingShifts adds the two (kept for older screens)
    pending_by_side = (
        base.filter(status=HolidayWorkClaim.STATUS_PENDING)
        .order_by()
        .aggregate(
            credit=Sum("shifts", filter=Q(kind__in=HolidayWorkClaim.CREDIT_KINDS)),
            use=Sum("shifts", filter=Q(kind=HolidayWorkClaim.KIND_USE_BALANCE)),
        )
    )
    total = qs.count()
    page, size = paging
    rows = list(
        claims.claim_queryset()
        .filter(pk__in=qs.values("pk"))
        .order_by("-work_date", "-id")[(page - 1) * size : page * size]
    )
    return Response(
        {
            "items": claims.claims_json(rows, for_role="hr"),
            "total": total,
            "page": page,
            "pageSize": size,
            "month": month,
            "year": year,
            "summary": {
                "byStatus": {s: status_rows.get(s, {}).get("n", 0) for s in ("pending", "approved", "rejected")},
                "byKind": {k: by_kind.get(k, 0) for k in claims.ALL_KINDS},
                "pendingShifts": float(status_rows.get("pending", {}).get("total") or 0),
                "approvedShifts": float(status_rows.get("approved", {}).get("total") or 0),
                # added in the integration pass: approvedShifts counts approved use requests too
                "creditedShifts": float(credited or 0),
                # added in the review fix: the "Waiting for HOD" tile shows these apart (credits in, days off out)
                "pendingCreditShifts": float(pending_by_side["credit"] or 0),
                "pendingUseShifts": float(pending_by_side["use"] or 0),
            },
            "enabled": _enabled_block(),
        }
    )


def _raise_on_behalf(request: Request) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    kind = str(data.get("kind") or "").strip()
    if kind == HolidayWorkClaim.KIND_USE_BALANCE:
        return _bad("To use an employee's balance, send the request to /api/compensation/use.")
    if kind not in claims.EMPLOYEE_CLAIM_KINDS:
        return _bad("kind must be holiday_work, ot_allowance, ot_shift or birthday.")
    day = parse_date(data.get("date") or data.get("workDate"))
    if day is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    raw_items = data.get("items")
    if raw_items is None and data.get("employeeId") not in (None, ""):
        raw_items = [
            {
                "employeeId": data.get("employeeId"),
                "shifts": data.get("shifts"),
                "overtimeRecordId": data.get("overtimeRecordId"),
            }
        ]
    if not isinstance(raw_items, list) or not raw_items or not all(isinstance(i, dict) for i in raw_items):
        return _bad("items must be a list of {employeeId, shifts?, overtimeRecordId?} entries.")
    if len(raw_items) > MAX_ITEMS:
        return _bad(f"A request can cover at most {MAX_ITEMS} employees.")
    items: list[tuple[int, object, int | None]] = []
    seen = set()
    for item in raw_items:
        emp_id = parse_id(item.get("employeeId"))
        if emp_id is None:
            return _bad("Every item needs an employeeId.")
        record_raw = item.get("overtimeRecordId")
        record_id = parse_id(record_raw) if record_raw not in (None, "") else None
        if record_raw not in (None, "") and record_id is None:
            return _bad("overtimeRecordId must be a number.")
        if emp_id in seen:
            continue
        seen.add(emp_id)
        shifts = item.get("shifts", data.get("shifts"))
        items.append((emp_id, None if kind == HolidayWorkClaim.KIND_BIRTHDAY else shifts, record_id))
    # create_claim locks each employee row in turn inside ONE transaction: always in id order, so two overlapping batches
    # can never wait on each other (a deadlock; security review 2026-11-19)
    items.sort(key=lambda item: item[0])

    hr_name = get_hr_display_name(request)
    reason = data.get("reason") or ""
    ctx = claims.context()
    employees = {
        e.id: e
        for e in scope_to_branch(
            Employee.objects.select_related("department", "designation", "branch"), request
        ).filter(pk__in=[i[0] for i in items])
    }
    problems: list[dict] = []
    created: list[int] = []
    with transaction.atomic():
        for emp_id, shifts, record_id in items:
            emp = employees.get(emp_id)
            if emp is None:
                problems.append(
                    {"employeeId": emp_id, "error": "Employee not found.", "code": "not_found", "status": 404}
                )
                continue
            record = None
            if record_id is not None:
                record = OvertimeRecord.objects.filter(pk=record_id, employee_id=emp_id).first()
                if record is None:
                    problems.append(
                        {
                            "employeeId": emp_id,
                            "error": f"{full_name(emp)}: no detected overtime was found for that day.",
                            "code": "not_found",
                            "status": 404,
                        }
                    )
                    continue
            try:
                claim = claims.create_claim(
                    employee=emp,
                    kind=kind,
                    date=day,
                    shifts=shifts,
                    overtime_record=record,
                    reason=reason,
                    raised_by_role=HolidayWorkClaim.RAISED_BY_HR,
                    raised_by_name=hr_name,
                    request=request,
                    ctx=ctx,
                )
                created.append(claim.id)
            except claims.ClaimError as exc:
                problems.append({"employeeId": emp_id, "error": exc.message, "code": exc.code, "status": exc.status})
        if problems:
            transaction.set_rollback(True)  # all or nothing: nothing of this request is kept
    if problems:
        first = problems[0]
        statuses = {p["status"] for p in problems}
        out = [{k: v for k, v in p.items() if k != "status"} for p in problems]
        if len(items) == 1:
            return _bad(first["error"], first["status"], first["code"], problems=out)
        return _bad(
            f"{len(problems)} of {len(items)} employees cannot be claimed for. Nothing was raised: "
            + " ".join(p["error"] for p in problems[:3])
            + (" ..." if len(problems) > 3 else ""),
            statuses.pop() if len(statuses) == 1 else 400,
            first["code"],
            problems=out,
        )
    rows = list(claims.claim_queryset().filter(pk__in=created).order_by("id"))
    return Response(
        {"created": len(rows), "claims": claims.claims_json(rows, for_role="hr"), "warnings": []}, status=201
    )


@api_view(["GET", "POST"])
@require_hr
@require_compensation_features_for_changes
def compensation_claims(request: Request) -> Response:
    """GET: every claim of every kind, filtered and paged, with a summary. POST: HR raises claims on employees' behalf
    (all-or-nothing) -> {created, claims, warnings}."""
    if request.method == "POST":
        return _raise_on_behalf(request)
    return _list_claims(request)


@api_view(["GET", "DELETE"])
@require_hr
@require_compensation_features_for_changes
def compensation_claim_detail(request: Request, pk: int) -> Response:
    """GET: one claim with its approval trail and the ledger entry it produced. DELETE: withdraw it while pending."""
    claim = scope_to_branch(claims.claim_queryset(), request, field="employee__branch_id").filter(pk=pk).first()
    if claim is None:
        return _bad("Claim not found.", 404, "not_found")
    if request.method == "GET":
        return Response(claims.claims_json([claim], for_role="hr")[0])
    try:
        snapshot = claims.withdraw(claim.pk)
    except claims.ClaimError as exc:
        return _refused(exc)
    log_action(
        request,
        "delete",
        "compensation",
        record_id=pk,
        description=f"Withdrew {snapshot['kind']} claim for {snapshot['employeeCode']} on {snapshot['date']}",
        old_values=snapshot,
    )
    return Response(status=204)


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def compensation_use(request: Request) -> Response:
    """POST {employeeId, date, shifts, reason}: HR asks, on the employee's behalf, to use the balance on a date; it goes
    to the HOD like the employee's own request (HR's direct balance/redeem stays as it is)."""
    data = request.data if isinstance(request.data, dict) else {}
    emp_id = parse_id(data.get("employeeId"))
    if emp_id is None:
        return _bad("employeeId must be a number.")
    emp = (
        scope_to_branch(Employee.objects.select_related("department", "designation", "branch"), request)
        .filter(pk=emp_id)
        .first()
    )
    if emp is None:
        return _bad("Employee not found.", 404, "not_found")
    day = parse_date(data.get("date"))
    if day is None:
        return _bad("date must be a date (YYYY-MM-DD).")
    try:
        claim = claims.create_claim(
            employee=emp,
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            date=day,
            shifts=data.get("shifts"),
            reason=data.get("reason") or "",
            raised_by_role=HolidayWorkClaim.RAISED_BY_HR,
            raised_by_name=get_hr_display_name(request),
            request=request,
        )
    except claims.ClaimError as exc:
        return _refused(exc)
    return Response(claims.claims_json([_reload(claim.pk)], for_role="hr")[0], status=201)


# ───────────────────────────── HR portal: balance and ledger ─────────────────────────────


def _entry_json(e: CompensationLedger) -> dict:
    """A ledger row: the keys the old balance drawer reads (id, type, shifts, date, source, note, createdBy, createdAt,
    counted) plus entryType, sourceLabel, the claim it came from and the OT record behind it."""
    claim = e.claim
    return {
        "id": e.id,
        "type": e.entry_type,
        "entryType": e.entry_type,
        "shifts": float(e.shifts),
        "date": e.date.isoformat(),
        "source": e.source,
        "sourceLabel": claims.SOURCE_LABELS.get(e.source, e.source),
        "note": e.note,
        "createdBy": e.created_by,
        "createdAt": e.created_at.isoformat() if e.created_at else None,
        # a debit that only mirrors a legacy credit being used is not subtracted a second time
        "counted": not (
            e.entry_type == CompensationLedger.ENTRY_DEBIT and e.source == CompensationLedger.SOURCE_LEGACY_CREDIT
        ),
        "claim": (
            {
                "id": claim.id,
                "kind": claim.kind,
                "kindLabel": claims.KIND_LABELS.get(claim.kind),
                "status": claim.status,
            }
            if claim is not None
            else None
        ),
        "overtimeRecordId": e.overtime_record_id,
        "overtime": claims.overtime_json(e.overtime_record) if e.overtime_record_id else None,
    }


def _employee_balance(request: Request, emp_id: int) -> Response:
    emp = (
        scope_to_branch(Employee.objects.filter(employment_type="staff"), request)
        .select_related("department", "designation", "branch")
        .filter(id=emp_id)
        .first()
    )
    if emp is None:
        return Response({"error": "Employee not found"}, status=404)
    entries = [
        _entry_json(e)
        for e in CompensationLedger.objects.filter(employee=emp)
        .select_related("claim", "overtime_record")
        .order_by("-date", "-id")
    ]
    for credit in CompensationLeaveCredit.objects.filter(
        employee=emp, status=CompensationLeaveCredit.STATUS_AVAILABLE
    ).select_related("source_overtime_record"):
        source = credit.source_overtime_record
        entries.append(
            {
                "id": None,
                "type": "credit",
                "entryType": "credit",
                "shifts": 1.0,
                "date": str(source.date) if source else str(credit.created_at.date()),
                "source": "legacy_credit",
                "sourceLabel": claims.SOURCE_LABELS["legacy_credit"],
                "note": "Alternative Day credit from an earlier overtime announcement",
                "createdBy": None,
                "createdAt": credit.created_at.isoformat() if credit.created_at else None,
                "counted": True,
                "legacyCreditId": credit.id,
                "claim": None,
                "overtimeRecordId": source.id if source else None,
                "overtime": claims.overtime_json(source) if source else None,
            }
        )
    figures = claims.figures_json(claims.balance_figures([emp.id]).get(emp.id))
    pending = list(
        claims.claim_queryset()
        .filter(employee=emp, kind=HolidayWorkClaim.KIND_USE_BALANCE, status=HolidayWorkClaim.STATUS_PENDING)
        .order_by("work_date", "id")
    )
    return Response(
        {
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "employee": employee_json(emp),
            "balance": figures["balance"],
            "earned": figures["earned"],
            "used": figures["used"],
            "pending": figures["pending"],
            "available": figures["available"],
            "entries": entries,
            "pendingUses": claims.claims_json(pending, for_role="hr"),
        }
    )


@api_view(["GET"])
@require_hr
def compensation_balance_overview(request: Request) -> Response:
    """GET: per employee earned / used / pending / available (+ summary), filters and paging; ?employeeId= -> that
    employee's balance and every ledger entry (claim and OT links, legacy credits). Staff only, branch-scoped."""
    q = request.query_params
    if q.get("employeeId") not in (None, ""):
        emp_id = parse_id(q.get("employeeId"))
        if emp_id is None:
            return Response({"error": "employeeId must be a number"}, status=400)
        return _employee_balance(request, emp_id)
    ids, error = _ids(q, "departmentId", "branchId")
    if error:
        return _bad(error)
    paging = _page(q)
    if paging is None:
        return _bad("page and pageSize must be positive numbers.")

    with_entries = (
        set(CompensationLedger.objects.values_list("employee_id", flat=True).distinct())
        | set(CompensationLeaveCredit.objects.values_list("employee_id", flat=True).distinct())
        | set(
            HolidayWorkClaim.objects.filter(
                kind=HolidayWorkClaim.KIND_USE_BALANCE, status=HolidayWorkClaim.STATUS_PENDING
            ).values_list("employee_id", flat=True)
        )
    )
    scope = scope_to_branch(Employee.objects.filter(employment_type="staff", id__in=with_entries), request)
    if ids["departmentId"] is not None:
        scope = scope.filter(department_id=ids["departmentId"])
    if ids["branchId"] is not None:
        scope = scope.filter(branch_id=ids["branchId"])
    text = (q.get("q") or "").strip()
    if text:
        scope = scope.filter(claims.employee_search_q(text, prefix=""))
    employees = list(
        scope.select_related("department", "designation", "branch").order_by("first_name", "last_name", "employee_code")
    )
    figures = claims.balance_figures([e.id for e in employees])
    totals = {key: Decimal("0") for key in ("earned", "used", "pending", "available")}
    for f in figures.values():
        for key in totals:
            totals[key] += f[key]
    page, size = paging
    shown = employees[(page - 1) * size : page * size]
    activity = claims.last_activity([e.id for e in shown])
    rows = []
    for e in shown:
        f = claims.figures_json(figures.get(e.id))
        rows.append({**employee_json(e), **f, "lastActivity": activity.get(e.id)})
    return Response(
        {
            "items": rows,
            "results": rows,
            "total": len(employees),
            "count": len(employees),
            "page": page,
            "pageSize": size,
            "summary": {
                "employees": len(employees),
                # the employees with something left to use (employees also counts those with entries and nothing left)
                "withBalance": sum(1 for f in figures.values() if f["available"] > 0),
                **{key: float(value.quantize(Decimal("0.01"))) for key, value in totals.items()},
            },
        }
    )


@api_view(["GET"])
@require_hr
def compensation_ledger(request: Request) -> Response:
    """GET: ledger rows (credits and debits) with their claim / OT links, filtered and paged (the Credits tab)."""
    q = request.query_params
    entry_type = (q.get("entryType") or "").strip().lower()
    if entry_type and entry_type not in (CompensationLedger.ENTRY_CREDIT, CompensationLedger.ENTRY_DEBIT):
        return _bad("entryType must be credit or debit.")
    month, year, error = _month_year(q, default_current=False)
    if error:
        return _bad(error)
    ids, error = _ids(q, "employeeId", "departmentId", "branchId")
    if error:
        return _bad(error)
    paging = _page(q)
    if paging is None:
        return _bad("page and pageSize must be positive numbers.")
    qs = scope_to_branch(CompensationLedger.objects.all(), request, field="employee__branch_id")
    if entry_type:
        qs = qs.filter(entry_type=entry_type)
    sources = [s for s in (q.get("source") or "").split(",") if s and s != "all"]
    if sources:
        qs = qs.filter(source__in=sources)
    if year is not None:
        qs = qs.filter(date__year=year)
    if month is not None:
        qs = qs.filter(date__month=month)
    if ids["employeeId"] is not None:
        qs = qs.filter(employee_id=ids["employeeId"])
    if ids["departmentId"] is not None:
        qs = qs.filter(employee__department_id=ids["departmentId"])
    if ids["branchId"] is not None:
        qs = qs.filter(employee__branch_id=ids["branchId"])
    text = (q.get("q") or "").strip()
    if text:
        qs = qs.filter(claims.employee_search_q(text) | Q(note__icontains=text))
    sums = {r["entry_type"]: r for r in qs.order_by().values("entry_type").annotate(n=Count("id"), total=Sum("shifts"))}
    # the debits that lower the balance (a debit that only mirrors a legacy credit being used is not counted twice)
    counted_debits = (
        qs.filter(entry_type=CompensationLedger.ENTRY_DEBIT)
        .exclude(source=CompensationLedger.SOURCE_LEGACY_CREDIT)
        .order_by()
        .aggregate(total=Sum("shifts"))["total"]
    )
    total = qs.count()
    page, size = paging
    rows = list(
        qs.select_related(
            "employee__department", "employee__designation", "employee__branch", "claim", "overtime_record"
        ).order_by("-date", "-id")[(page - 1) * size : page * size]
    )
    return Response(
        {
            "items": [{**employee_json(e.employee), **_entry_json(e)} for e in rows],
            "total": total,
            "page": page,
            "pageSize": size,
            "month": month,
            "year": year,
            "summary": {
                "credits": sums.get("credit", {}).get("n", 0),
                "debits": sums.get("debit", {}).get("n", 0),
                "creditShifts": float(sums.get("credit", {}).get("total") or 0),
                "debitShifts": float(sums.get("debit", {}).get("total") or 0),
                "countedDebitShifts": float(counted_debits or 0),
            },
        }
    )


# ───────────────────────────── HR portal: the Raise strip ─────────────────────────────


def previous_sunday(today: date) -> date:
    """The latest Sunday strictly before `today` (a Sunday's own previous Sunday is a week back)."""
    return today - timedelta(days=((today.weekday() + 1) % 7) or 7)


@api_view(["GET"])
@require_hr
def holiday_work_month(request: Request) -> Response:
    """GET ?month=&year=&departmentId=&branchId=: the month's Sundays and holidays with who worked / is eligible / is
    claimed, the default date (the latest past Sunday) and maxAgeDays."""
    from .holiday_work_views import MAX_CLAIM_AGE_DAYS, _enabled_block as holiday_block, date_problem, worked_ids

    q = request.query_params
    month, year, error = _month_year(q, default_current=True)
    if error:
        return _bad(error)
    if month is None:
        month = ist_today().month
    ids, error = _ids(q, "departmentId", "branchId")
    if error:
        return _bad(error)
    today = ist_today()
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    holidays = holiday_names(first, last)
    staff = scope_to_branch(Employee.objects.filter(employment_type="staff", status="active"), request)
    if ids["departmentId"] is not None:
        staff = staff.filter(department_id=ids["departmentId"])
    if ids["branchId"] is not None:
        staff = staff.filter(branch_id=ids["branchId"])
    staff_ids = list(staff.values_list("id", flat=True))
    claimed = {}
    for row in HolidayWorkClaim.objects.filter(
        kind=HolidayWorkClaim.KIND_HOLIDAY_WORK,
        work_date__gte=first,
        work_date__lte=last,
        employee_id__in=staff_ids,
        status__in=HolidayWorkClaim.OPEN_STATUSES,
    ).values("work_date", "status", "employee_id"):
        claimed.setdefault(row["work_date"], {"pending": set(), "approved": set()})[row["status"]].add(
            row["employee_id"]
        )
    days = []
    cursor = first
    while cursor <= last:
        kind = day_kind(cursor, holidays)
        if kind is not None:
            worked = worked_ids(cursor, staff_ids) if cursor <= today else set()
            taken = claimed.get(cursor, {"pending": set(), "approved": set()})
            problem = date_problem(cursor, today)
            eligible = 0 if problem else len(worked - taken["pending"] - taken["approved"])
            days.append(
                {
                    "date": cursor.isoformat(),
                    "kind": kind,
                    "holidayName": holidays.get(cursor),
                    "weekLabel": f"Week {(cursor.day - 1) // 7 + 1}",
                    "label": date_text(cursor),
                    "worked": len(worked),
                    "eligible": eligible,
                    "claimable": problem is None,
                    "message": problem,
                    "claimed": {"pending": len(taken["pending"]), "approved": len(taken["approved"])},
                }
            )
        cursor += timedelta(days=1)
    return Response(
        {
            "month": month,
            "year": year,
            "days": days,
            "defaultDate": previous_sunday(today).isoformat(),
            "maxAgeDays": MAX_CLAIM_AGE_DAYS,
            "earliestDate": (today - timedelta(days=MAX_CLAIM_AGE_DAYS)).isoformat(),
            "today": today.isoformat(),
            "enabled": holiday_block(),
        }
    )
