"""
Birthday Compensation on a chosen date (owner brief 2026-11-25): the endpoints. The rules are in birthday_compensation.py,
the writes in birthday_compensation_service.py; the full contract (every body and reply, with examples) is in
api-database-reference.md ("Compensation - Birthday Compensation on a chosen date").

Employee (employee token; an HR token is refused; staff only):
    GET    /api/employee/compensation/birthday?year=YYYY            my entitlement (this year's birthday by default): the
                                                                    days, the uses, every day of the birthday month with
                                                                    the portions it can take
    GET    /api/employee/compensation/birthday/uses?status=         my uses (every birthday), newest first
    POST   /api/employee/compensation/birthday/uses                 {useDate, portion, reason?} -> 201 the use
    DELETE /api/employee/compensation/birthday/uses/<id>            withdraw a pending use I raised -> 200 the use

HR (require_hr, branch-scoped; permission key compensation.leave.birthdays: View reads, Edit raises / withdraws; HR's
decision needs Edit there AND the approval right "birthday_compensation" (hr_access: an extra right on top of Edit; a role
that never set it keeps "edit = approve")):
    GET    /api/compensation/birthday-compensation?employeeId=&year=   one employee's entitlement + eligible dates
                                                                       ("Choose date for employee")
    GET    /api/compensation/birthday-compensation/uses?status=&month=&year=&employeeId=&departmentId=&branchId=&q=
           &raisedBy=&page=&pageSize=                                  the uses, newest first, with a summary
    POST   /api/compensation/birthday-compensation/uses                {employeeId, useDate, portion, reason?} -> 201
    GET    /api/compensation/birthday-compensation/uses/<id>           one use
    DELETE /api/compensation/birthday-compensation/uses/<id>           withdraw a pending use HR raised -> 200
    PATCH  /api/compensation/birthday-compensation/uses/<id>/decision  {status: approved|rejected, comment} HR's step

Department Head (employee token of an active head; also the MD portal's HOD approvals):
    PATCH  /api/manager/birthday-compensation/<id>/status              {status: approved|rejected, comment}
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from . import birthday_compensation as rules
from . import birthday_compensation_service as service
from . import hr_access
from .audit_utils import log_action
from .auth import get_hr_display_name, require_auth, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import full_name, parse_date, parse_id, parse_int, switches
from .models import BirthdayCompensationUse, Employee

PERMISSION_KEY = "compensation.leave.birthdays"
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
LIST_STATUSES = ("all", "pending", "waiting_hod", "waiting_hr", "approved", "rejected", "withdrawn")


def _bad(message: str, status: int = 400, code: str = "invalid") -> Response:
    return Response({"error": message, "code": code}, status=status)


def _refused(exc: service.UseError) -> Response:
    return Response(exc.as_json(), status=exc.status)


def _body(data, *names):
    """The first of `names` the body carries, camelCase or snake_case (the mobile client converts every key)."""
    if not isinstance(data, dict):
        return None
    for name in names:
        snake = "".join(f"_{c.lower()}" if c.isupper() else c for c in name)
        for key in (name, snake):
            if key in data and data[key] not in (None, ""):
                return data[key]
    return None


def _year(q, today: dt.date) -> tuple[int | None, Response | None]:
    raw = q.get("year")
    if raw in (None, ""):
        return today.year, None
    year = parse_int(raw)
    if year is None or not 2000 <= year <= 2100:
        return None, _bad("year must be a year (e.g. 2026).")
    return year, None


def _enabled() -> dict:
    flags = switches()
    cfg = approval.get_config(rules.WORKFLOW)
    return {
        "master": flags["master"],
        "birthday": flags["birthday"],
        "workflow": cfg.enabled,
        "canPlace": bool(flags["master"] and flags["birthday"] and cfg.enabled),
    }


# ───────────────────────────── employee (mobile app / Employee Web App) ─────────────────────────────


def _employee(request: Request):
    from .employee_compensation_views import _employee_only

    return _employee_only(request)


def _not_staff(year: int | None = None) -> Response:
    return Response(
        {
            "isStaff": False,
            "message": "Birthday Compensation is for staff employees only.",
            "state": rules.STATE_NOT_ELIGIBLE,
            "uses": [],
            "eligibleDates": [],
            "canPlace": False,
            "enabled": _enabled(),
        }
    )


@api_view(["GET"])
@require_auth
def employee_birthday_compensation(request: Request) -> Response:
    """GET ?year=YYYY: the signed-in employee's Birthday Compensation for their birthday of that year (default: this
    year's). The month's past days are worked out first (never a finalized month)."""
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    today = ist_today()
    year, error = _year(request.query_params, today)
    if error:
        return error
    if emp.employment_type != "staff":
        return _not_staff(year)
    birthday = rules.birthday_for(emp, year)
    ent = rules.entitlement(emp, birthday, today, for_employee=True, refresh=birthday is not None and birthday <= today)
    body = rules.entitlement_json(ent, for_role="employee")
    body.update({"isStaff": True, "enabled": _enabled(), "today": today.isoformat()})
    return Response(body)


@api_view(["GET", "POST"])
@require_auth
def employee_birthday_compensation_uses(request: Request) -> Response:
    """GET ?status=: my uses, newest first. POST {useDate, portion, reason?}: place Birthday Compensation -> 201."""
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    if request.method == "GET":
        if emp.employment_type != "staff":
            return Response({"items": [], "total": 0, "isStaff": False})
        qs = service._select().filter(employee=emp)
        status = (request.query_params.get("status") or "all").lower()
        if status not in ("all", "pending", "approved", "rejected", "withdrawn"):
            return _bad("status must be all, pending, approved, rejected or withdrawn.")
        if status != "all":
            qs = qs.filter(status=status)
        cfg = approval.get_config(rules.WORKFLOW)
        rows = list(qs.order_by("-created_at", "-id")[:500])
        return Response(
            {
                "items": [rules.use_json(u, for_role="employee", cfg=cfg) for u in rows],
                "total": len(rows),
                "isStaff": True,
            }
        )
    data = request.data if isinstance(request.data, dict) else {}
    use_date = parse_date(_body(data, "useDate", "date"))
    if use_date is None:
        return _bad("useDate must be a date (YYYY-MM-DD).")
    try:
        use = service.raise_use(
            employee=emp,
            use_date=use_date,
            portion=str(_body(data, "portion") or "").strip(),
            reason=_body(data, "reason") or "",
            raised_by_role=BirthdayCompensationUse.RAISED_BY_EMPLOYEE,
            raised_by_name=full_name(emp),
            request=request,
        )
    except service.UseError as exc:
        return _refused(exc)
    return Response(rules.use_json(service.reload(use.pk), for_role="employee"), status=201)


@api_view(["DELETE"])
@require_auth
def employee_birthday_compensation_use_detail(request: Request, pk: int) -> Response:
    """DELETE: withdraw my pending use (only one I raised)."""
    emp, refusal = _employee(request)
    if refusal is not None:
        return refusal
    try:
        use = service.withdraw_use(
            pk, by_role=BirthdayCompensationUse.RAISED_BY_EMPLOYEE, by_name=full_name(emp), employee=emp
        )
    except service.UseError as exc:
        return _refused(exc)
    log_action(
        request,
        "update",
        "compensation",
        record_id=pk,
        description=f"{emp.employee_code} withdrew their Birthday Compensation for {use.use_date.isoformat()}",
    )
    return Response(rules.use_json(service.reload(pk), for_role="employee"))


# ───────────────────────────── HR portal ─────────────────────────────


def _scoped_employee(request: Request, raw):
    emp_id = parse_id(raw)
    if emp_id is None:
        return None, _bad("employeeId must be a number.")
    emp = (
        scope_to_branch(Employee.objects.select_related("department", "designation", "branch"), request)
        .filter(pk=emp_id)
        .first()
    )
    if emp is None:
        return None, _bad("Employee not found.", 404, "not_found")
    return emp, None


def _scoped_uses(request: Request):
    return scope_to_branch(service._select(), request, field="employee__branch_id")


@api_view(["GET"])
@require_hr
def hr_birthday_compensation(request: Request) -> Response:
    """GET ?employeeId=&year=: one employee's Birthday Compensation (the "Choose date for employee" dialog)."""
    from .compensation_views import can_edit_compensation

    q = request.query_params
    if q.get("employeeId") in (None, ""):
        return _bad("employeeId is required.")
    emp, error = _scoped_employee(request, q.get("employeeId"))
    if error:
        return error
    today = ist_today()
    year, error = _year(q, today)
    if error:
        return error
    if emp.employment_type != "staff":
        body = _not_staff(year).data
        body["message"] = f"{full_name(emp)} is a production employee: Birthday Compensation is for staff only."
        return Response(body)
    birthday = rules.birthday_for(emp, year)
    # only a login that may change Compensation works the month out first (a view-only read never writes attendance)
    refresh = birthday is not None and birthday <= today and can_edit_compensation(request, PERMISSION_KEY)
    ent = rules.entitlement(emp, birthday, today, refresh=refresh)
    body = rules.entitlement_json(ent, for_role="hr")
    body.update({"isStaff": True, "enabled": _enabled(), "today": today.isoformat()})
    return Response(body)


def _list(request: Request) -> Response:
    q = request.query_params
    status = (q.get("status") or "all").lower()
    if status not in LIST_STATUSES:
        return _bad(f"status must be one of: {', '.join(LIST_STATUSES)}.")
    qs = _scoped_uses(request)
    for name, field in (("employeeId", "employee_id"), ("departmentId", "employee__department_id")):
        if q.get(name) not in (None, ""):
            value = parse_id(q.get(name))
            if value is None:
                return _bad(f"{name} must be a number.")
            qs = qs.filter(**{field: value})
    if q.get("branchId") not in (None, ""):
        value = parse_id(q.get("branchId"))
        if value is None:
            return _bad("branchId must be a number.")
        qs = qs.filter(employee__branch_id=value)
    month, year = parse_int(q.get("month")), parse_int(q.get("year"))
    if (q.get("month") not in (None, "") and (month is None or not 1 <= month <= 12)) or (
        q.get("year") not in (None, "") and year is None
    ):
        return _bad("month must be 1 to 12 and year a number.")
    if month is not None:
        qs = qs.filter(use_date__month=month, use_date__year=year or ist_today().year)
    elif year is not None:
        qs = qs.filter(use_date__year=year)
    raised = (q.get("raisedBy") or "").lower()
    if raised:
        if raised not in ("hr", "employee"):
            return _bad("raisedBy must be hr or employee.")
        qs = qs.filter(raised_by_role=raised)
    for word in str(q.get("q") or "").split()[:5]:
        qs = qs.filter(
            Q(employee__first_name__icontains=word)
            | Q(employee__last_name__icontains=word)
            | Q(employee__employee_code__icontains=word)
            | Q(reason__icontains=word)
        )
    # the summary is of the filtered rows whatever the status filter (the tiles are that filter)
    summary = {
        "byStatus": {s: 0 for s in ("pending", "waiting_hod", "waiting_hr", "approved", "rejected", "withdrawn")}
    }
    pending_days = approved_days = Decimal("0")
    rows = list(qs.order_by("-created_at", "-id"))
    for u in rows:
        summary["byStatus"][u.status] = summary["byStatus"].get(u.status, 0) + 1
        if u.status == "pending":
            key = "waiting_hr" if rules.status_key(u) == "pending_hr" else "waiting_hod"
            summary["byStatus"][key] += 1
            pending_days += Decimal(u.days)
        elif u.status == "approved":
            approved_days += Decimal(u.days)
    summary["pendingDays"] = rules.number(pending_days)
    summary["approvedDays"] = rules.number(approved_days)
    if status == "waiting_hod":
        rows = [u for u in rows if u.status == "pending" and rules.status_key(u) == "pending"]
    elif status == "waiting_hr":
        rows = [u for u in rows if rules.status_key(u) == "pending_hr"]
    elif status != "all":
        rows = [u for u in rows if u.status == status]
    page = parse_int(q.get("page")) or 1
    size = parse_int(q.get("pageSize") or q.get("page_size")) or DEFAULT_PAGE_SIZE
    if page < 1:
        return _bad("page must be 1 or more.")
    size = max(1, min(size, MAX_PAGE_SIZE))
    cfg = approval.get_config(rules.WORKFLOW)
    chunk = rows[(page - 1) * size : page * size]
    return Response(
        {
            "items": [rules.use_json(u, for_role="hr", cfg=cfg) for u in chunk],
            "total": len(rows),
            "page": page,
            "pageSize": size,
            "summary": summary,
            "enabled": _enabled(),
        }
    )


@api_view(["GET", "POST"])
@require_hr
def hr_birthday_compensation_uses(request: Request) -> Response:
    """GET: the uses (filters in the module docstring). POST {employeeId, useDate, portion, reason?}: HR places Birthday
    Compensation for an employee -> 201 (it goes to the Department Head, then HR, like the employee's own)."""
    if request.method == "GET":
        return _list(request)
    data = request.data if isinstance(request.data, dict) else {}
    emp, error = _scoped_employee(request, _body(data, "employeeId"))
    if error:
        return error
    use_date = parse_date(_body(data, "useDate", "date"))
    if use_date is None:
        return _bad("useDate must be a date (YYYY-MM-DD).")
    try:
        use = service.raise_use(
            employee=emp,
            use_date=use_date,
            portion=str(_body(data, "portion") or "").strip(),
            reason=_body(data, "reason") or "",
            raised_by_role=BirthdayCompensationUse.RAISED_BY_HR,
            raised_by_name=get_hr_display_name(request),
            request=request,
        )
    except service.UseError as exc:
        return _refused(exc)
    return Response(rules.use_json(service.reload(use.pk), for_role="hr"), status=201)


@api_view(["GET", "DELETE"])
@require_hr
def hr_birthday_compensation_use_detail(request: Request, pk: int) -> Response:
    """GET: one use. DELETE: withdraw a pending use HR raised."""
    use = _scoped_uses(request).filter(pk=pk).first()
    if use is None:
        return _bad("Birthday Compensation request not found.", 404, "not_found")
    if request.method == "GET":
        return Response(rules.use_json(use, for_role="hr"))
    try:
        service.withdraw_use(pk, by_role=BirthdayCompensationUse.RAISED_BY_HR, by_name=get_hr_display_name(request))
    except service.UseError as exc:
        return _refused(exc)
    log_action(
        request,
        "update",
        "compensation",
        record_id=pk,
        description=(
            f"Withdrew the Birthday Compensation of {use.employee.employee_code} for {use.use_date.isoformat()}"
        ),
    )
    return Response(rules.use_json(service.reload(pk), for_role="hr"))


@api_view(["PATCH"])
@require_hr
def hr_birthday_compensation_decision(request: Request, pk: int) -> Response:
    """PATCH {status: approved|rejected, comment}: HR's decision, the second step after the Department Head's. The final
    approval is what pays the day; a rejection needs its reason."""
    if refused := hr_access.approval_refusal(request, rules.WORKFLOW):
        return refused
    use = _scoped_uses(request).filter(pk=pk).first()
    if use is None:
        return _bad("Birthday Compensation request not found.", 404, "not_found")
    data = request.data if isinstance(request.data, dict) else {}
    decision = data.get("status")
    if decision not in ("approved", "rejected"):
        return _bad("status must be 'approved' or 'rejected'.")
    if refusal := approval.reject_remark_refusal(decision, data.get("comment")):
        return refusal
    actor = get_hr_display_name(request)
    try:
        use, outcome = service.decide_use(pk, approval.HR, decision, actor, data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    except BirthdayCompensationUse.DoesNotExist:
        return _bad("Birthday Compensation request not found.", 404, "not_found")
    hr_access.log_decision(
        request,
        rules.WORKFLOW,
        use,
        decision,
        what=(
            f"Birthday Compensation of {full_name(use.employee)} ({use.employee.employee_code}) for "
            f"{use.use_date.isoformat()} ({rules.PORTION_PHRASE[use.portion]})"
        ),
    )
    return Response(rules.use_json(service.reload(pk), for_role="hr"))


# ───────────────────────────── the Department Head ─────────────────────────────


def hod_decide_birthday_compensation(m, pk: int, data, actor: str, request: Request) -> Response:
    """The Department Head's decision on a Birthday Compensation use of an employee they oversee (the first step; HR
    decides next). Needs the head's `can_approve_compensation` switch. Body {"status": "approved" | "rejected",
    "comment"?} (a rejection needs its reason). Reply: the use. Also the MD portal's HOD approvals (md_portal)."""
    from .manager_views import hod_emp_filter

    if not m.can_approve_compensation:
        return Response(
            {
                "error": "Approve-compensation access is disabled for your account. Ask HR to enable it.",
                "code": "APPROVE_COMPENSATION_DISABLED",
            },
            status=403,
        )
    use = BirthdayCompensationUse.objects.filter(hod_emp_filter(m)).filter(pk=pk).first()
    if use is None:
        if BirthdayCompensationUse.objects.filter(pk=pk).exists():
            return Response({"error": "This request is not in your approval scope"}, status=403)
        return Response({"error": "Birthday Compensation request not found.", "code": "not_found"}, status=404)
    data = data if isinstance(data, dict) else {}
    decision = data.get("status")
    if decision not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)
    try:
        use, outcome = service.decide_use(pk, approval.HOD, decision, actor, data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    except BirthdayCompensationUse.DoesNotExist:
        return Response({"error": "Birthday Compensation request not found.", "code": "not_found"}, status=404)
    log_action(
        request,
        "approve" if decision == "approved" else "reject",
        "compensation",
        record_id=use.id,
        description=(
            f"{actor} (Department Head) {decision} the {rules.what_text(use)} of {use.employee.employee_code}"
            + (" (now waiting for HR)" if outcome.kind == "advanced" else "")
        ),
        new_values={
            "useId": use.id,
            "employeeId": use.employee_id,
            "useDate": use.use_date.isoformat(),
            "portion": use.portion,
            "status": use.status,
        },
    )
    return Response(rules.use_json(service.reload(pk), for_role="hod"))


@api_view(["PATCH"])
@require_auth
def manager_update_birthday_compensation_status(request: Request, pk: int) -> Response:
    """The Department Head's own decision, from their employee login: see hod_decide_birthday_compensation."""
    from .manager_views import hod_display_name, manager_from_token

    m, refused = manager_from_token(request)
    if refused is not None:
        return refused
    return hod_decide_birthday_compensation(m, pk, request.data, hod_display_name(m), request)
