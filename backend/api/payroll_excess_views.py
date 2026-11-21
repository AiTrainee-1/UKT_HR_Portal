"""Staff Payroll page, owner brief 2026-11-20 (frontend: pages/hr/StaffPayroll.tsx):

Excess tab (permission key `salary`, API prefix payroll-excess/; payroll_excess.py has the rules)
    GET   payroll-excess/month?month=&year=          the month's department-wise breakdown, summary, employee picker
    POST  payroll-excess/entries                      add an Excess / Detection for one or more employees (edit)
    PATCH payroll-excess/entries/<id>                 change an entry's amount, with the reason (edit)
    POST  payroll-excess/remove                       remove entries, with the reason (edit)
    GET   payroll-excess/history?month=&year=&departmentId=&employeeId=&kind=&action=&page=&pageSize=

Payroll tab -> Not included (permission key `payroll.not_included`)
    GET   payroll/not-included?month=&year=          every employee who is not in the month's staff payroll, and why

Payslip tab (permission key `salary_slip`, API prefix payslips/)
    GET   payslips/staff?month=&year=                the month's payroll (the Records list) with each payslip's lines
    GET   payslips/staff/pdf?month=&year=&ids=&layout=single|double

Production Payroll, one pay cycle's period (?cycle=&periodStart=&periodEnd=), owner 2026-11-20 "the same in production":
    production-payroll-excess/{period,entries,entries/<id>,remove,history}   key production_payroll.salary (Excess tab)
    payroll/production/not-included                                          key production_payroll.payroll.not_included
    payslips/production, payslips/production/pdf                             key production_payroll.payslip

Everything is branch-scoped. Nothing here changes how payroll is worked out: the Excess entries are applied by
payroll_excess.apply_to_payroll / the engine's bonus, and the other two only read.
"""

from __future__ import annotations

import io
from decimal import Decimal

from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import payroll_excess as px
from . import payroll_month_workflow as month_workflow
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import parse_join_date
from .models import Employee, HRUser, Payroll, PayrollExcessEntry, PayrollExcessHistory, SalarySlip
from .unit_labels import unit_label

ZERO = Decimal("0")
AUDIT_MODULE = "Payroll Excess"


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _month_year(params) -> tuple[int, int]:
    today = ist_today()
    try:
        month = int(params.get("month") or today.month)
        year = int(params.get("year") or today.year)
    except (TypeError, ValueError):
        raise px.ExcessError("Pick a month and a year.") from None
    if not (1 <= month <= 12) or not (2000 <= year <= 2100):
        raise px.ExcessError("Pick a month and a year.")
    return month, year


def _ids(raw, what: str = "employee") -> list[int]:
    if isinstance(raw, str):
        raw = [part for part in raw.split(",") if part.strip()]
    if not isinstance(raw, (list, tuple)) or not raw:
        raise px.ExcessError(f"Select at least one {what}.")
    try:
        return list(dict.fromkeys(int(v) for v in raw))
    except (TypeError, ValueError):
        raise px.ExcessError(f"Select at least one {what}.") from None


def _actor(request):
    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    return HRUser.objects.filter(pk=user_id).first() if user_id else None


def _can_edit(request, module: str) -> bool:
    from .permission_registry import effective_permissions, resolve_permission

    hr = getattr(request, "hr_actor", None) or _actor(request)
    if hr is None:
        return False
    return bool(hr.is_super_admin) or resolve_permission(effective_permissions(hr), module) == "edit"


def _handle(fn):
    def wrapper(request, *args, **kwargs):
        try:
            return fn(request, *args, **kwargs)
        except px.ExcessError as exc:
            return _error(str(exc), exc.status)

    wrapper.__name__, wrapper.__doc__ = fn.__name__, fn.__doc__
    return wrapper


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _dept(emp) -> str:
    return emp.department.name if emp.department_id and emp.department else ""


def _desig(emp) -> str:
    return emp.designation.title if emp.designation_id and emp.designation else ""


def _unit(emp) -> str:
    return (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else ""


def _employees(request):
    return (
        scope_to_branch(Employee.objects, request)
        .select_related("department", "designation", "branch")
        .defer("photo_url", "password_hash", "address")
    )


def _staff_payrolls(request, month: int, year: int, employee_ids=None) -> dict[int, Payroll]:
    qs = scope_to_branch(
        Payroll.objects.filter(
            salary_mode=Payroll.SALARY_MODE_MONTHLY,
            month=month,
            year=year,
            week_number=None,
            period_start__isnull=True,
        ),  # fmt: skip
        request,
        field="employee__branch_id",
    )
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=list(employee_ids))
    return {p.employee_id: p for p in qs.order_by("id")}


def _in_main_payroll(p: Payroll | None, emp) -> bool:
    return bool(
        p is not None
        and (emp.status or "").lower() == "active"
        and not p.on_hold
        and not p.new_joiner_parked
        and p.released_from is None
    )


def _money(value) -> float | None:
    return float(value) if value is not None else None


# ───────────────────────────── Excess ─────────────────────────────
# One implementation for the Staff Payroll (a month, key `salary`) and each Production Payroll cycle (a pay period, key
# `production_payroll.salary`); the URL prefix decides which (payroll-excess/ or production-payroll-excess/).

EDIT_KEY = {px.STAFF: "salary", px.PRODUCTION: "production_payroll.salary"}


def _production_scope(request, params) -> px.Scope:
    from .branch_scope import get_branch_scope
    from .production_payroll_views import _cycle_of, _period_of
    from .user_settings import settings_for

    try:
        cycle = _cycle_of(params)
        if not (params.get("periodStart") and params.get("periodEnd")):
            raise ValueError("Pick a pay period.")
        start, end, _explicit = _period_of(params, settings_for(request), cycle, get_branch_scope(request))
    except ValueError as exc:
        raise px.ExcessError(str(exc)) from None
    return px.Scope.production(cycle, start, end)


def _scope(request, params, kind: str) -> px.Scope:
    if kind == px.PRODUCTION:
        return _production_scope(request, params)
    month, year = _month_year(params)
    return px.Scope.staff(month, year)


def _payrolls_of(request, scope: px.Scope, employee_ids=None) -> dict[int, Payroll]:
    qs = scope_to_branch(Payroll.objects.filter(scope.payroll_q()), request, field="employee__branch_id")
    if employee_ids is not None:
        qs = qs.filter(employee_id__in=list(employee_ids))
    return {p.employee_id: p for p in qs.order_by("id")}


def _in_payroll(p: Payroll | None, emp, scope: px.Scope) -> bool:
    if scope.is_production:
        return bool(p is not None and (emp.status or "").lower() == "active" and not p.new_joiner_parked)
    return _in_main_payroll(p, emp)


def _any_payroll(request, scope: px.Scope) -> bool:
    if scope.is_production:
        from .production_period_workflow import period_rows

        rows = period_rows(scope.cycle, scope.start, scope.end)
    else:
        rows = month_workflow.staff_month(scope.month, scope.year)
    return scope_to_branch(rows, request, field="employee__branch_id").exists()


def _scope_keys(scope: px.Scope) -> dict:
    keys = {"month": scope.month, "year": scope.year, "periodLabel": scope.label}
    if scope.is_production:
        keys.update(cycle=scope.cycle, periodStart=scope.start.isoformat(), periodEnd=scope.end.isoformat())
    return keys


def _overview(request, scope: px.Scope) -> Response:
    emp_type = Employee.EMPLOYMENT_TYPE_PRODUCTION if scope.is_production else Employee.EMPLOYMENT_TYPE_STAFF
    people = list(_employees(request).filter(employment_type=emp_type).order_by("employee_code"))
    by_id = {e.id: e for e in people}
    entries = list(
        PayrollExcessEntry.objects.filter(scope.entry_q())
        .filter(employee_id__in=list(by_id), status=PayrollExcessEntry.STATUS_ACTIVE)
        .order_by("-created_at", "-id")
    )
    per_emp: dict[int, list] = {}
    for e in entries:
        per_emp.setdefault(e.employee_id, []).append(e)
    payrolls = _payrolls_of(request, scope)
    departments: dict[tuple, dict] = {}
    totals = {"excess": ZERO, "detection": ZERO}
    for emp_id, rows in per_emp.items():
        emp = by_id[emp_id]
        excess = sum((r.amount for r in rows if r.kind == PayrollExcessEntry.KIND_EXCESS), ZERO)
        detection = sum((r.amount for r in rows if r.kind == PayrollExcessEntry.KIND_DETECTION), ZERO)
        totals["excess"] += excess
        totals["detection"] += detection
        p = payrolls.get(emp_id)
        earned = (p.gross_salary or ZERO) + (p.ot_amount or ZERO) if p else None
        key = (_dept(emp) or "No department", _unit(emp))
        dept = departments.setdefault(key, {
            "departmentId": emp.department_id, "department": key[0], "unit": key[1], "employees": 0,
            "excessTotal": ZERO, "detectionTotal": ZERO, "rows": [],
        })  # fmt: skip
        dept["employees"] += 1
        dept["excessTotal"] += excess
        dept["detectionTotal"] += detection
        dept["rows"].append({
            "employeeId": emp.id,
            "code": emp.employee_code,
            "name": _name(emp),
            "designation": _desig(emp),
            "department": _dept(emp),
            "excess": float(excess),
            "detection": float(detection),
            "net": float(excess - detection),
            "payrollId": p.id if p else None,
            "inPayroll": _in_payroll(p, emp, scope),
            "earnedSalary": _money(earned),
            "earnedWithExcess": _money(earned + (p.bonus or ZERO)) if p else None,
            "netPay": _money(p.final_salary) if p else None,
            "entries": [px.entry_json(r) for r in rows],
        })  # fmt: skip
    out_departments = []
    for key in sorted(departments):
        d = departments[key]
        d["rows"].sort(key=lambda r: r["code"])
        out_departments.append({
            **{k: v for k, v in d.items() if k not in ("excessTotal", "detectionTotal")},
            "excessTotal": float(d["excessTotal"]),
            "detectionTotal": float(d["detectionTotal"]),
            "net": float(d["excessTotal"] - d["detectionTotal"]),
        })  # fmt: skip
    locked = scope.locked()
    return Response({
        **_scope_keys(scope),
        "locked": locked,
        "lockedMessage": scope.locked_message() if locked else None,
        "payrollGenerated": _any_payroll(request, scope),
        "canEdit": _can_edit(request, EDIT_KEY[scope.kind]),
        "summary": {
            "employees": len(per_emp),
            "entries": len(entries),
            "excessTotal": float(totals["excess"]),
            "detectionTotal": float(totals["detection"]),
            "net": float(totals["excess"] - totals["detection"]),
        },
        "departments": out_departments,
        "employeeOptions": [
            {
                "id": e.id, "code": e.employee_code, "name": _name(e), "department": _dept(e),
                "designation": _desig(e), "eligible": (reason := px.ineligible_reason(e, scope)) is None,
                "reason": reason,
            }
            for e in people
        ],
    })  # fmt: skip


def _add(request, kind: str) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    scope = _scope(request, data, kind)
    ids = _ids(data.get("employeeIds"))
    found = {e.id: e for e in _employees(request).filter(id__in=ids)}
    missing = [i for i in ids if i not in found]
    out = px.add_entries(
        [found[i] for i in ids if i in found], scope, data.get("kind"), data.get("amount"), data.get("remark"),
        _actor(request), get_hr_display_name(request),
    )  # fmt: skip
    refused = out["refused"] + [
        {"employeeId": i, "code": "", "name": "", "reason": "Not an employee of your list"} for i in missing
    ]
    if out["created"]:
        first = out["created"][0]
        log_action(
            request, "create", AUDIT_MODULE,
            description=(
                f"{px.KIND_LABELS[first.kind]} of {first.amount:,.2f} added for {len(out['created'])} employee(s), "
                f"{scope.label}: {first.remark}"
            ),
            new_values={**_scope_keys(scope), "kind": first.kind, "amount": float(first.amount),
                        "entryIds": [e.id for e in out["created"]]},
        )  # fmt: skip
    return Response({
        "created": [px.entry_json(e) for e in out["created"]],
        "refused": refused,
        "payrollUpdated": out["payrollUpdated"],
    })  # fmt: skip


def _kind_q(kind: str) -> dict:
    return {"period_start__isnull": kind != px.PRODUCTION}


def _change(request, pk: int, kind: str) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    entry = PayrollExcessEntry.objects.filter(pk=pk, employee__in=_employees(request), **_kind_q(kind)).first()
    if entry is None:
        return _error("Entry not found.", 404)
    before = entry.amount
    entry, updated = px.change_entry(entry, data.get("amount"), data.get("remark"), _actor(request),
                                     get_hr_display_name(request))  # fmt: skip
    log_action(
        request, "update", AUDIT_MODULE, record_id=entry.id,
        description=f"{px.KIND_LABELS[entry.kind]} changed from {before:,.2f} to {entry.amount:,.2f} "
                    f"({px.Scope.of_entry(entry).label})",
        old_values={"amount": float(before)}, new_values={"amount": float(entry.amount)},
    )  # fmt: skip
    return Response({"entry": px.entry_json(entry), "payrollUpdated": updated})


def _remove(request, kind: str) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    ids = _ids(data.get("entryIds"), "entry")
    entries = list(PayrollExcessEntry.objects.filter(pk__in=ids, employee__in=_employees(request), **_kind_q(kind)))
    if not entries:
        return _error("Entry not found.", 404)
    out = px.remove_entries(entries, data.get("remark"), _actor(request), get_hr_display_name(request))
    log_action(
        request, "delete", AUDIT_MODULE,
        description=f"Removed {out['removed']} excess / detection entr{'y' if out['removed'] == 1 else 'ies'}",
        old_values={"entryIds": [e.id for e in entries]},
    )  # fmt: skip
    return Response(out)


def _history(request, kind: str) -> Response:
    params = request.query_params
    qs = (
        PayrollExcessHistory.objects.filter(employee__in=_employees(request))
        .filter(px.history_q(params, kind))
        .select_related("employee", "employee__department")
        .order_by("-at", "-id")
    )
    try:
        page = max(1, int(params.get("page") or 1))
        size = min(200, max(1, int(params.get("pageSize") or 50)))
    except (TypeError, ValueError):
        page, size = 1, 50
    total = qs.count()
    items = [px.history_json(h) for h in qs[(page - 1) * size : page * size]]
    return Response({"items": items, "total": total, "page": page, "pageSize": size})


@api_view(["GET"])
@require_hr
@_handle
def excess_month(request: Request) -> Response:
    return _overview(request, _scope(request, request.query_params, px.STAFF))


@api_view(["GET"])
@require_hr
@_handle
def production_excess_period(request: Request) -> Response:
    return _overview(request, _scope(request, request.query_params, px.PRODUCTION))


@api_view(["POST"])
@require_hr
@_handle
def excess_add(request: Request) -> Response:
    return _add(request, px.STAFF)


@api_view(["POST"])
@require_hr
@_handle
def production_excess_add(request: Request) -> Response:
    return _add(request, px.PRODUCTION)


@api_view(["PATCH"])
@require_hr
@_handle
def excess_change(request: Request, pk: int) -> Response:
    return _change(request, pk, px.STAFF)


@api_view(["PATCH"])
@require_hr
@_handle
def production_excess_change(request: Request, pk: int) -> Response:
    return _change(request, pk, px.PRODUCTION)


@api_view(["POST"])
@require_hr
@_handle
def excess_remove(request: Request) -> Response:
    return _remove(request, px.STAFF)


@api_view(["POST"])
@require_hr
@_handle
def production_excess_remove(request: Request) -> Response:
    return _remove(request, px.PRODUCTION)


@api_view(["GET"])
@require_hr
@_handle
def excess_history(request: Request) -> Response:
    return _history(request, px.STAFF)


@api_view(["GET"])
@require_hr
@_handle
def production_excess_history(request: Request) -> Response:
    return _history(request, px.PRODUCTION)


# ───────────────────────────── Not included ─────────────────────────────

DRY_RUN_LIMIT = 40


def _engine_reason(emp, month: int, year: int) -> str | None:
    """What the staff engine would say about this employee (a rolled-back dry run; None = it would be paid)."""
    from .payroll_views import _dry_run_skip_reason, _generate_staff_payroll

    return _dry_run_skip_reason(lambda e: _generate_staff_payroll(e, month, year, allow_locked=True), emp)


@api_view(["GET"])
@require_hr
@_handle
def not_included(request: Request) -> Response:
    from .production_cycles import CYCLE_LABELS

    month, year = _month_year(request.query_params)
    label = f"{px.MONTHS[month]} {year}"
    end = px.month_end(month, year)
    employees = list(_employees(request).order_by("employee_code"))
    payrolls = _staff_payrolls(request, month, year)
    generated = any(
        (emp_id in payrolls) for emp_id in (e.id for e in employees if (e.status or "").lower() == "active")
    )
    rows, waiting, dry_runs = [], 0, 0
    for emp in employees:
        status = (emp.status or "active").lower()
        p = payrolls.get(emp.id)
        if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION:
            cycle = CYCLE_LABELS.get(emp.production_pay_cycle or "", None)
            code, reason = "production", "Production employee: paid on the Production Payroll, not the Staff Payroll."
            detail = (
                f"{cycle} cycle."
                if cycle
                else "No production pay cycle assigned yet (Employees -> Production Employees)."
            )
        elif _in_main_payroll(p, emp):
            continue
        elif status != "active":
            code, reason = "inactive", "Inactive employee: inactive employees are left out of the payroll."
            detail = f"A payroll was generated for {label} before the employee was made inactive." if p else None
        elif p is not None and p.on_hold:
            code, reason = "on_hold", "Salary on hold for this month (Hold on the payroll's details page)."
            detail = f"Held by {p.hold_changed_by}." if getattr(p, "hold_changed_by", None) else None
        elif p is not None and p.new_joiner_parked:
            code, reason = "new_joiner", "New joiner waiting to be added to the payroll (Skipped -> New joiners)."
            detail = None
        elif p is not None and p.released_from:
            code, reason = "paid_separately", "Paid separately after the month was finalized."
            paid = getattr(p, "payment_paid_at", None)
            detail = f"Paid on {paid:%d %b %Y}." if paid else None
        else:
            joined = parse_join_date(emp.join_date)
            if joined and joined > end:
                code, reason, detail = "joined_after", f"Joined on {joined:%d %b %Y}, after {label}.", None
            elif not emp.salary_amount or emp.salary_amount <= 0:
                code, reason = "no_salary", "No monthly salary on the profile."
                detail = "Add the salary on the employee's profile, then generate the payroll again."
            elif not generated:
                waiting += 1
                continue
            elif dry_runs < DRY_RUN_LIMIT:
                dry_runs += 1
                engine_says = _engine_reason(emp, month, year)
                if engine_says:
                    code, reason, detail = "skipped", f"Skipped by the payroll: {engine_says}", None
                else:
                    code, reason = "not_generated", "Not generated yet for this employee."
                    detail = "Generate the payroll again: this employee would be included."
            else:
                code, reason = "not_generated", "Not in the payroll for this month."
                detail = "Generate the payroll again to see the reason."
        rows.append(
            {
                "id": emp.id,
                "code": emp.employee_code,
                "name": _name(emp),
                "category": "production" if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION else "staff",
                "status": status,
                "departmentId": emp.department_id,
                "department": _dept(emp),
                "designationId": emp.designation_id,
                "designation": _desig(emp),
                "branchId": emp.branch_id,
                "unit": _unit(emp),
                "joinDate": (j := parse_join_date(emp.join_date)) and j.isoformat(),
                "reasonCode": code,
                "reason": reason,
                "detail": detail,
                "payrollId": p.id if p is not None and code != "production" else None,
            }
        )
    by_reason: dict[str, int] = {}
    for r in rows:
        by_reason[r["reasonCode"]] = by_reason.get(r["reasonCode"], 0) + 1
    departments = {(r["departmentId"], r["department"]) for r in rows if r["departmentId"]}
    designations = {(r["designationId"], r["designation"]) for r in rows if r["designationId"]}
    return Response(
        {
            "month": month,
            "year": year,
            "periodLabel": label,
            "generated": generated,
            "notGeneratedCount": waiting,
            "summary": {
                "total": len(rows),
                "staff": sum(1 for r in rows if r["category"] == "staff"),
                "production": sum(1 for r in rows if r["category"] == "production"),
                "byReason": by_reason,
            },
            "employees": rows,
            "departments": [{"id": i, "name": n} for i, n in sorted(departments, key=lambda x: x[1])],
            "designations": [{"id": i, "title": t} for i, t in sorted(designations, key=lambda x: x[1])],
        }
    )


# ───────────────────────────── Payslips ─────────────────────────────


def _main_payroll(request, month: int, year: int) -> list[Payroll]:
    qs = scope_to_branch(month_workflow.staff_month(month, year), request, field="employee__branch_id")
    return list(
        qs.filter(month_workflow.MAIN_PAYROLL_Q)
        .filter(employee__employment_type=Employee.EMPLOYMENT_TYPE_STAFF)
        .select_related("employee", "employee__department", "employee__designation", "employee__branch")
        .defer("employee__photo_url")
        .order_by("employee__employee_code")
    )


def _slips_of(payrolls: list[Payroll]) -> dict[int, SalarySlip]:
    if not payrolls:
        return {}
    month, year = payrolls[0].month, payrolls[0].year
    slips = SalarySlip.objects.filter(
        employee_id__in=[p.employee_id for p in payrolls], month=month, year=year, week_number=None,
        period_start__isnull=True,
    ).select_related("employee", "employee__department", "employee__designation")  # fmt: skip
    return {s.employee_id: s for s in slips.order_by("id")}


@api_view(["GET"])
@require_hr
@_handle
def staff_payslips(request: Request) -> Response:
    from .salary_slip_center.engine import mask_account
    from .payroll_insights import KIND_STAFF, staff_period
    from .payroll_statement_views import statement_rows
    from .salary_slip_figures import _from_row

    month, year = _month_year(request.query_params)
    payrolls = _main_payroll(request, month, year)
    slips = _slips_of(payrolls)
    values, _no_slip, _mismatched = (
        statement_rows(payrolls, KIND_STAFF, staff_period(month, year)) if payrolls else ({}, 0, 0)
    )
    rows = []
    sums = {"earned": ZERO, "excess": ZERO, "detection": ZERO, "deductions": ZERO, "net": ZERO}
    for p in payrolls:
        emp, v, slip = p.employee, values.get(p.id) or {}, slips.get(p.employee_id)
        block = ((slip.breakdown_details or {}).get("excess") if slip else None) or {}
        excess, detection = Decimal(str(block.get("excess") or 0)), Decimal(str(block.get("detection") or 0))
        if excess - detection != (p.bonus or ZERO):  # an older bonus with no entries behind it
            excess, detection = (p.bonus, ZERO) if (p.bonus or ZERO) >= 0 else (ZERO, -p.bonus)
        fig = _from_row(slip, p, v, KIND_STAFF) if (slip is not None and v) else None
        earned = (p.gross_salary or ZERO) + (p.ot_amount or ZERO)
        sums["earned"] += earned
        sums["excess"] += excess
        sums["detection"] += detection
        sums["deductions"] += p.deductions or ZERO
        sums["net"] += p.final_salary or ZERO
        rows.append(
            {
                "payrollId": p.id,
                "slipId": slip.id if slip else None,
                "hasSlip": slip is not None,
                "employeeId": emp.id,
                "code": emp.employee_code,
                "name": _name(emp),
                "department": _dept(emp),
                "designation": _desig(emp),
                "unit": _unit(emp),
                "joinDate": (j := parse_join_date(emp.join_date)) and j.isoformat(),
                "bankAccountMasked": mask_account(emp.bank_account),
                "pfNumber": emp.pf_number or None,
                "esiNumber": emp.esi_number or None,
                "status": p.status,
                "paymentStatus": getattr(p, "payment_status", None) or "unpaid",
                "fixedSalary": _money(p.base_salary),
                "companyDays": int(p.total_working_days or 0),
                "paidDays": v.get("totalDays"),
                "present": v.get("present"),
                "cl": v.get("cl"),
                "hd": v.get("hd"),
                "lop": v.get("lop"),
                "earned": float(p.gross_salary or ZERO),
                "ot": float(p.ot_amount or ZERO),
                "excess": float(excess),
                "detection": float(detection),
                "eSalary": float(earned + (p.bonus or ZERO)),
                "pf": v.get("pf", 0.0),
                "esi": v.get("esi", 0.0),
                "tds": v.get("tds", 0.0),
                "advance": v.get("advance", 0.0),
                "others": v.get("others", 0.0),
                "totalDeduction": float(p.deductions or ZERO),
                "net": float(p.final_salary or ZERO),
                "earnings": [{"label": label, "amount": float(a)} for label, a in (fig.earnings if fig else [])],
                "deductions": [{"label": label, "amount": float(a)} for label, a in (fig.deductions if fig else [])],
            }
        )
    return Response(
        {
            "month": month,
            "year": year,
            "periodLabel": f"{px.MONTHS[month]} {year}",
            "locked": month_workflow.is_locked(month, year),
            "summary": {"employees": len(rows), **{k: float(v) for k, v in sums.items()}},
            "rows": rows,
        }
    )


@api_view(["GET"])
@require_hr
@_handle
def staff_payslips_pdf(request: Request):
    from .company_documents_views import build_salary_slip_pdf, salary_slip_story
    from .document_pdf import PremiumPageDecorator, new_premium_document
    from .models import CompanyDocumentSettings, PayrollSettings
    from .salary_slip_bulk_pdf import build_bulk_salary_slip_pdf
    from .salary_slip_figures import figures_for, leave_lines_for

    month, year = _month_year(request.query_params)
    wanted = set(_ids(request.query_params.get("ids"), "payslip"))
    payrolls = [p for p in _main_payroll(request, month, year) if p.id in wanted]
    slips_by_emp = _slips_of(payrolls)
    slips = [slips_by_emp[p.employee_id] for p in payrolls if p.employee_id in slips_by_emp]
    if not slips:
        return _error("None of these employees has a payslip in this month's payroll.", 404)
    layout = request.query_params.get("layout") or "single"
    name = px.MONTHS[month]
    if layout == "double":
        content = build_bulk_salary_slip_pdf(slips)
    elif len(slips) == 1:
        content = build_salary_slip_pdf(slips[0])
    else:
        ps = PayrollSettings.get()
        ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP)
        figs, leaves = figures_for(slips), leave_lines_for(slips)
        from reportlab.platypus import PageBreak

        buffer = io.BytesIO()
        doc = new_premium_document(buffer, PremiumPageDecorator(ds, ps, footer_note="System-generated payslips"))
        story: list = []
        for i, s in enumerate(slips):
            if i:
                story.append(PageBreak())
            story.extend(salary_slip_story(s, ps, ds, figs[id(s)], leaves[id(s)]))
        doc.build(story)
        content = buffer.getvalue()
    filename = (
        f"Payslip-{slips[0].employee.employee_code}-{name}-{year}.pdf"
        if len(slips) == 1
        else f"Payslips-{name}-{year}.pdf"
    )
    response = HttpResponse(content, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"
    return response


# ───────────────────────────── Production: Not included and Payslips ─────────────────────────────

PRODUCTION_DRY_RUN_LIMIT = 15


def _production_engine_reason(emp, scope: px.Scope) -> str | None:
    """What the production engine would say about this worker for the period (a rolled-back dry run; None = paid)."""
    from .payroll_views import _dry_run_skip_reason, _generate_production_payroll

    return _dry_run_skip_reason(
        lambda e: _generate_production_payroll(e, scope.start, scope.end, pay_cycle=scope.cycle), emp
    )


@api_view(["GET"])
@require_hr
@_handle
def production_not_included(request: Request) -> Response:
    from .production_cycles import CYCLE_LABELS

    scope = _production_scope(request, request.query_params)
    employees = list(_employees(request).order_by("employee_code"))
    payrolls = _payrolls_of(request, scope)
    production = Employee.EMPLOYMENT_TYPE_PRODUCTION
    generated = any(
        e.id in payrolls for e in employees if e.employment_type == production and (e.status or "").lower() == "active"
    )
    ended = scope.end < ist_today()
    locked = scope.locked()
    rows, waiting, dry_runs = [], 0, 0
    for emp in employees:
        status = (emp.status or "active").lower()
        p = payrolls.get(emp.id)
        detail = None
        if emp.employment_type != production:
            code, reason = "staff", "Staff employee: paid on the Staff Payroll, not the Production Payroll."
        elif _in_payroll(p, emp, scope):
            continue
        elif status != "active":
            code, reason = "inactive", "Inactive employee: inactive workers are left out of the payroll."
            detail = f"A payroll was generated for {scope.label} before the worker was made inactive." if p else None
        elif p is not None and p.new_joiner_parked:
            code, reason = "new_joiner", "New joiner waiting to be added to the period's payroll (New Joiners)."
        else:
            joined = parse_join_date(emp.join_date)
            other = CYCLE_LABELS.get(emp.production_pay_cycle or "")
            if joined and joined > scope.end:
                code, reason = "joined_after", f"Joined on {joined:%d %b %Y}, after this pay period."
            elif not emp.salary_per_shift or emp.salary_per_shift <= 0:
                code, reason = "no_salary", "No salary per shift on the profile."
                detail = "Add the salary per shift on the worker's profile, then generate the period again."
            elif emp.production_pay_cycle != scope.cycle:
                if other:
                    code, reason = "other_cycle", f"Paid on the {other} cycle, not this one."
                    detail = f"{other} cycle."
                else:
                    code, reason = "no_cycle", "Not assigned to any pay cycle (Employees > Production Employees)."
            elif not generated or not ended:
                waiting += 1
                continue
            elif locked:
                code, reason = "not_generated", "Not generated before the period was finalized (Payroll Done)."
            elif dry_runs < PRODUCTION_DRY_RUN_LIMIT:
                dry_runs += 1
                engine_says = _production_engine_reason(emp, scope)
                if engine_says:
                    code, reason = "skipped", f"Skipped by the payroll: {engine_says}"
                else:
                    code, reason = "not_generated", "Not generated yet for this worker."
                    detail = "Generate the period again: this worker would be included."
            else:
                code, reason = "not_generated", "Not in the payroll for this period."
                detail = "Generate the period again to see the reason."
        rows.append({
            "id": emp.id,
            "code": emp.employee_code,
            "name": _name(emp),
            "category": "production" if emp.employment_type == production else "staff",
            "status": status,
            "departmentId": emp.department_id,
            "department": _dept(emp),
            "designationId": emp.designation_id,
            "designation": _desig(emp),
            "branchId": emp.branch_id,
            "unit": _unit(emp),
            "joinDate": (j := parse_join_date(emp.join_date)) and j.isoformat(),
            "reasonCode": code,
            "reason": reason,
            "detail": detail,
            "payrollId": p.id if p is not None and code != "staff" else None,
        })  # fmt: skip
    by_reason: dict[str, int] = {}
    for r in rows:
        by_reason[r["reasonCode"]] = by_reason.get(r["reasonCode"], 0) + 1
    departments = {(r["departmentId"], r["department"]) for r in rows if r["departmentId"]}
    designations = {(r["designationId"], r["designation"]) for r in rows if r["designationId"]}
    return Response({
        **_scope_keys(scope),
        "generated": generated,
        "notGeneratedCount": waiting,
        "summary": {
            "total": len(rows),
            "staff": sum(1 for r in rows if r["category"] == "staff"),
            "production": sum(1 for r in rows if r["category"] == "production"),
            "byReason": by_reason,
        },
        "employees": rows,
        "departments": [{"id": i, "name": n} for i, n in sorted(departments, key=lambda x: x[1])],
        "designations": [{"id": i, "title": t} for i, t in sorted(designations, key=lambda x: x[1])],
    })  # fmt: skip


def _production_main(request, scope: px.Scope) -> list[Payroll]:
    from .production_period_workflow import MAIN_Q, period_rows

    qs = scope_to_branch(period_rows(scope.cycle, scope.start, scope.end), request, field="employee__branch_id")
    return list(
        qs.filter(MAIN_Q)
        .filter(employee__employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
        .select_related("employee", "employee__department", "employee__designation", "employee__branch")
        .defer("employee__photo_url")
        .order_by("employee__employee_code")
    )


def _production_slips(payrolls: list[Payroll], scope: px.Scope) -> dict[int, SalarySlip]:
    if not payrolls:
        return {}
    slips = SalarySlip.objects.filter(
        employee_id__in=[p.employee_id for p in payrolls], period_start=scope.start, period_end=scope.end
    ).select_related("employee", "employee__department", "employee__designation")
    return {s.employee_id: s for s in slips.order_by("id")}


def _excess_split(slip, p: Payroll) -> tuple[Decimal, Decimal]:
    block = ((slip.breakdown_details or {}).get("excess") if slip else None) or {}
    excess, detection = Decimal(str(block.get("excess") or 0)), Decimal(str(block.get("detection") or 0))
    bonus = p.bonus or ZERO
    if excess - detection != bonus:  # an older bonus with no entries behind it
        excess, detection = (bonus, ZERO) if bonus >= 0 else (ZERO, -bonus)
    return excess, detection


@api_view(["GET"])
@require_hr
@_handle
def production_payslips(request: Request) -> Response:
    from .payroll_insights import KIND_PRODUCTION, production_period
    from .payroll_statement_views import statement_rows
    from .salary_slip_center.engine import mask_account
    from .salary_slip_figures import _from_row

    scope = _production_scope(request, request.query_params)
    payrolls = _production_main(request, scope)
    slips = _production_slips(payrolls, scope)
    values = (
        statement_rows(payrolls, KIND_PRODUCTION, production_period(scope.start, scope.end, scope.cycle))[0]
        if payrolls
        else {}
    )
    rows = []
    sums = {"earned": ZERO, "excess": ZERO, "detection": ZERO, "deductions": ZERO, "net": ZERO}
    for p in payrolls:
        emp, v, slip = p.employee, values.get(p.id) or {}, slips.get(p.employee_id)
        excess, detection = _excess_split(slip, p)
        fig = _from_row(slip, p, v, KIND_PRODUCTION) if (slip is not None and v) else None
        gross = p.gross_salary or ZERO
        sums["earned"] += gross
        sums["excess"] += excess
        sums["detection"] += detection
        sums["deductions"] += p.deductions or ZERO
        sums["net"] += p.final_salary or ZERO
        rows.append({
            "payrollId": p.id,
            "slipId": slip.id if slip else None,
            "hasSlip": slip is not None,
            "employeeId": emp.id,
            "code": emp.employee_code,
            "name": _name(emp),
            "department": _dept(emp),
            "designation": _desig(emp),
            "unit": _unit(emp),
            "joinDate": (j := parse_join_date(emp.join_date)) and j.isoformat(),
            "bankAccountMasked": mask_account(emp.bank_account),
            "pfNumber": emp.pf_number or None,
            "esiNumber": emp.esi_number or None,
            "status": p.status,
            "paymentStatus": getattr(p, "payment_status", None) or "unpaid",
            "salaryPerShift": _money(emp.salary_per_shift),
            "shifts": v.get("shifts"),
            "daysWorked": v.get("worked"),
            "absent": v.get("absent"),
            "earned": float(gross),
            "ot": float(p.ot_amount or ZERO),
            "excess": float(excess),
            "detection": float(detection),
            "eSalary": float(gross + (p.ot_amount or ZERO) + (p.bonus or ZERO)),
            "pf": v.get("pf", 0.0),
            "esi": v.get("esi", 0.0),
            "tds": v.get("tds", 0.0),
            "advance": v.get("advance", 0.0),
            "others": v.get("others", 0.0),
            "totalDeduction": float(p.deductions or ZERO),
            "net": float(p.final_salary or ZERO),
            "earnings": [{"label": label, "amount": float(a)} for label, a in (fig.earnings if fig else [])],
            "deductions": [{"label": label, "amount": float(a)} for label, a in (fig.deductions if fig else [])],
        })  # fmt: skip
    return Response({
        **_scope_keys(scope),
        "locked": scope.locked(),
        "summary": {"employees": len(rows), **{k: float(v) for k, v in sums.items()}},
        "rows": rows,
    })  # fmt: skip


def _slips_pdf(slips: list, layout: str, filename: str) -> HttpResponse:
    from .company_documents_views import build_salary_slip_pdf, salary_slip_story
    from .document_pdf import PremiumPageDecorator, new_premium_document
    from .models import CompanyDocumentSettings, PayrollSettings
    from .salary_slip_bulk_pdf import build_bulk_salary_slip_pdf
    from .salary_slip_figures import figures_for, leave_lines_for

    if layout == "double":
        content = build_bulk_salary_slip_pdf(slips)
    elif len(slips) == 1:
        content = build_salary_slip_pdf(slips[0])
    else:
        from reportlab.platypus import PageBreak

        ps = PayrollSettings.get()
        ds = CompanyDocumentSettings.get(CompanyDocumentSettings.DOC_TYPE_SALARY_SLIP)
        figs, leaves = figures_for(slips), leave_lines_for(slips)
        buffer = io.BytesIO()
        doc = new_premium_document(buffer, PremiumPageDecorator(ds, ps, footer_note="System-generated payslips"))
        story: list = []
        for i, s in enumerate(slips):
            if i:
                story.append(PageBreak())
            story.extend(salary_slip_story(s, ps, ds, figs[id(s)], leaves[id(s)]))
        doc.build(story)
        content = buffer.getvalue()
    response = HttpResponse(content, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"
    return response


@api_view(["GET"])
@require_hr
@_handle
def production_payslips_pdf(request: Request):
    scope = _production_scope(request, request.query_params)
    wanted = set(_ids(request.query_params.get("ids"), "payslip"))
    payrolls = [p for p in _production_main(request, scope) if p.id in wanted]
    by_emp = _production_slips(payrolls, scope)
    slips = [by_emp[p.employee_id] for p in payrolls if p.employee_id in by_emp]
    if not slips:
        return _error("None of these workers has a payslip in this period's payroll.", 404)
    tag = f"{scope.cycle.title()}-{scope.start:%d%b}-{scope.end:%d%b%Y}"
    filename = f"Payslip-{slips[0].employee.employee_code}-{tag}.pdf" if len(slips) == 1 else f"Payslips-{tag}.pdf"
    return _slips_pdf(slips, request.query_params.get("layout") or "single", filename)
