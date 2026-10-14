"""
Payroll insights endpoints: one payroll's details, the issues of a month / period, and the rules. READ-ONLY.

    GET /api/payroll/<id>/details                      GET /api/payroll/production/<id>/details
    GET /api/payroll/issues?month=&year=               GET /api/payroll/production/issues?cycle=&periodStart=&periodEnd=
    GET /api/payroll/rules?month=&year=                GET /api/payroll/production/rules?cycle=&periodStart=&periodEnd=

(the Salary Statement lives in payroll_statement_views.py). Staff is under /api/payroll (permission module `payroll`),
production under /api/payroll/production (`production_payroll`): the module comes from the URL, so a role that only has
production payroll can reach only the production endpoints and the other way round; a staff id sent to the production
endpoint (or the reverse) is a 404. Branch-scoped logins only ever see their own branch's payroll.

Everything here explains what payroll already stored (the Payroll row, its SalarySlip breakdown, the profile and the live
settings); nothing is recomputed and nothing is written, so these can be called as often as the pages need. The shapes are
the TypeScript types in frontend/src/lib/api-client/custom-hooks/payroll-insights.ts. The helpers are in
payroll_insights.py and payroll_insights_rules.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Payroll
from .payroll_insights import (
    KIND_LEGACY,
    KIND_PRODUCTION,
    KIND_STAFF,
    MONTH_NAMES,
    SettingsResolver,
    assignments_on,
    breakdown_of,
    detect_issues,
    employee_json,
    holiday_dates_of,
    hr_note_of,
    iso_dt,
    issue_counts,
    kind_of,
    money,
    money_lines,
    normalized_days,
    period_label,
    period_of_payroll,
    production_period,
    slip_key,
    slips_for,
    sort_issues,
    staff_period,
    summarize_issues,
)
from .payroll_insights_rules import (
    ProductionRuleInput,
    StaffRuleInput,
    employee_rules_entry,
    production_chips,
    production_flags,
    production_rule_groups,
    production_settings_groups,
    staff_chips,
    staff_flags,
    staff_rule_groups,
    staff_settings_groups,
)
from .production_cycles import CYCLE_LABELS, normalize_cycle
from .view_common import error_response as _error

# ─────────────────────────────────────────────────────────────────────────────
#  The slice of payroll a request is about
# ─────────────────────────────────────────────────────────────────────────────


class ScopeError(ValueError):
    """A request whose month / period / filters cannot be read: answered as a 400 with this message."""


@dataclass
class Scope:
    kind: str  # staff | production
    month: int | None = None
    year: int | None = None
    cycle: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    department_id: int | None = None
    employee_id: int | None = None
    branch_id: int | None = None
    status: str | None = None

    def period_info(self) -> dict:
        if self.kind == KIND_STAFF:
            return staff_period(self.month, self.year)
        return production_period(self.period_start, self.period_end, self.cycle)


def _whole(params, name: str) -> int | None:
    raw = params.get(name)
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ScopeError(f"{name} must be a whole number") from None


def _day(params, name: str) -> date:
    raw = params.get(name)
    try:
        return date.fromisoformat(str(raw))
    except (TypeError, ValueError):
        raise ScopeError(f"{name} is required and must be a date (YYYY-MM-DD)") from None


def parse_scope(request: Request, kind: str) -> Scope:
    """The month (staff) or cycle period (production) a request asks about, plus the optional narrowing every list
    endpoint accepts: departmentId, employeeId, branchId and status (paid | pending). Raises ScopeError."""
    params = request.query_params
    scope = Scope(
        kind=kind,
        department_id=_whole(params, "departmentId"),
        employee_id=_whole(params, "employeeId"),
        branch_id=_whole(params, "branchId"),
    )
    status = params.get("status")
    if status:
        if status not in (Payroll.STATUS_PENDING, Payroll.STATUS_PAID):
            raise ScopeError("status must be pending or paid")
        scope.status = status
    if kind == KIND_STAFF:
        try:
            scope.month, scope.year = int(params.get("month")), int(params.get("year"))
        except (TypeError, ValueError):
            raise ScopeError("month and year are required") from None
        if not 1 <= scope.month <= 12 or not 2000 <= scope.year <= 2100:
            raise ScopeError("month must be 1 to 12 and year a four-digit year")
    else:
        scope.cycle = normalize_cycle(params.get("cycle"))
        if scope.cycle is None:
            raise ScopeError("cycle is required: weekly, biweekly or monthly")
        scope.period_start, scope.period_end = _day(params, "periodStart"), _day(params, "periodEnd")
        if scope.period_end < scope.period_start:
            raise ScopeError("periodEnd cannot be before periodStart")
    return scope


_PAYROLL_RELATIONS = ("employee", "employee__department", "employee__designation", "employee__branch")


def scope_payrolls(request: Request, scope: Scope):
    """The payroll rows of a scope in the caller's branch scope, with the employee, department, designation and branch
    loaded (so a page of hundreds of rows never goes back to the database per employee), ordered by employee name.

    A production period is judged by its exact dates, never against today's period rules: a period generated under an
    earlier Settings value is still a period that exists. The rows are those generated on the cycle plus older rows
    (no cycle stamped) whose employee is assigned to it now, as the production list does."""
    qs = Payroll.objects.select_related(*_PAYROLL_RELATIONS)
    if scope.kind == KIND_STAFF:
        qs = qs.filter(salary_mode=Payroll.SALARY_MODE_MONTHLY, month=scope.month, year=scope.year)
    else:
        qs = qs.filter(
            salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=scope.period_start, period_end=scope.period_end
        ).filter(Q(pay_cycle=scope.cycle) | Q(pay_cycle__isnull=True, employee__production_pay_cycle=scope.cycle))
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    if scope.department_id is not None:
        qs = qs.filter(employee__department_id=scope.department_id)
    if scope.employee_id is not None:
        qs = qs.filter(employee_id=scope.employee_id)
    if scope.branch_id is not None:
        qs = qs.filter(employee__branch_id=scope.branch_id)
    if scope.status:
        qs = qs.filter(status=scope.status)
    return qs.order_by("employee__first_name", "employee__last_name", "id")


def _bad_request(exc: ScopeError) -> Response:
    return _error(str(exc), 400)


# ─────────────────────────────────────────────────────────────────────────────
#  Issues
# ─────────────────────────────────────────────────────────────────────────────


def _issues_response(request: Request, kind: str) -> Response:
    try:
        scope = parse_scope(request, kind)
    except ScopeError as exc:
        return _bad_request(exc)
    payrolls = list(scope_payrolls(request, scope))
    slips = slips_for(payrolls)
    issues: list[dict] = []
    for payroll in payrolls:
        issues.extend(detect_issues(payroll, slips.get(slip_key(payroll))))
    issues = sort_issues(issues)
    newest = max((p.updated_at for p in payrolls), default=None)
    return Response(
        {
            "scope": scope.period_info(),
            "detectedAt": iso_dt(newest),
            "summary": summarize_issues(issues, payrolls, kind),
            "issues": issues,
        }
    )


@api_view(["GET"])
@require_hr
def staff_payroll_issues(request: Request) -> Response:
    """GET /api/payroll/issues?month=&year=[&departmentId=&employeeId=&branchId=&status=]
    Every issue payroll detected for one month of staff payroll, built from the stored breakdowns: each with the day it
    was detected on, a specific detail, what it cost and the rule behind it, plus counts by severity / code / department."""
    return _issues_response(request, KIND_STAFF)


@api_view(["GET"])
@require_hr
def production_payroll_issues(request: Request) -> Response:
    """GET /api/payroll/production/issues?cycle=&periodStart=&periodEnd=[&departmentId=&employeeId=&branchId=&status=]
    The same for one period of one production pay cycle."""
    return _issues_response(request, KIND_PRODUCTION)


# ─────────────────────────────────────────────────────────────────────────────
#  Rules
# ─────────────────────────────────────────────────────────────────────────────


def _rules_response(request: Request, kind: str) -> Response:
    try:
        scope = parse_scope(request, kind)
    except ScopeError as exc:
        return _bad_request(exc)
    payrolls = list(scope_payrolls(request, scope))
    employees = [p.employee for p in payrolls]
    resolver = SettingsResolver({e.branch_id for e in employees} | {get_branch_scope(request)})
    # The Settings page as the caller sees it: a branch login sees its branch's values, everyone else the company's.
    caller = resolver.for_branch(get_branch_scope(request))
    entries = []
    if kind == KIND_STAFF:
        assigned = assignments_on(
            [e.id for e in employees], date(scope.year, scope.month, 15)
        )  # the engine's reference day
        holidays = holiday_dates_of(scope.year, scope.month)
        settings_groups = staff_settings_groups(resolver.base, caller)
        for payroll in payrolls:
            emp = payroll.employee
            inp = StaffRuleInput(
                emp=emp,
                month=scope.month,
                year=scope.year,
                base=resolver.base,
                ps=resolver.for_employee(emp),
                assignment=assigned.get(emp.id),
                holidays=holidays,
            )
            entries.append(
                employee_rules_entry(
                    emp,
                    payroll.id,
                    staff_rule_groups(inp, company=False),
                    staff_chips(emp, inp.ps, inp),
                    staff_flags(emp, inp),
                )
            )
    else:
        assigned = assignments_on([e.id for e in employees], scope.period_end)
        settings_groups = production_settings_groups(caller, scope.cycle)
        for payroll in payrolls:
            emp = payroll.employee
            inp = ProductionRuleInput(
                emp=emp,
                cycle=scope.cycle,
                period_start=scope.period_start,
                period_end=scope.period_end,
                ps=resolver.for_employee(emp),
                assignment=assigned.get(emp.id),
            )
            entries.append(
                employee_rules_entry(
                    emp,
                    payroll.id,
                    production_rule_groups(inp, company=False),
                    production_chips(emp, inp.ps, inp),
                    production_flags(emp, inp),
                )
            )
    return Response({"scope": scope.period_info(), "settings": settings_groups, "employees": entries})


@api_view(["GET"])
@require_hr
def staff_payroll_rules(request: Request) -> Response:
    """GET /api/payroll/rules?month=&year=[&departmentId=&employeeId=&branchId=&status=]
    The Settings page rules staff payroll runs on (grouped, each linked to its Settings block) and, for every staff payroll
    of the month, the rules in force for that employee now: shift, Saturday off, salary basis, PF / ESI."""
    return _rules_response(request, KIND_STAFF)


@api_view(["GET"])
@require_hr
def production_payroll_rules(request: Request) -> Response:
    """GET /api/payroll/production/rules?cycle=&periodStart=&periodEnd=[&departmentId=&employeeId=&branchId=&status=]
    The same for production: the pay cycle, late and PF / ESI rules, and each worker's cycle, rate and production shift."""
    return _rules_response(request, KIND_PRODUCTION)


# ─────────────────────────────────────────────────────────────────────────────
#  One payroll's details
# ─────────────────────────────────────────────────────────────────────────────


def _numeric_summary(bd: dict | None, payroll: Payroll) -> dict:
    """The breakdown's own day / shift counts (same keys); a payroll with no breakdown gives what its row records."""
    if bd is not None:
        return {
            key: (money(value) if isinstance(value, float) else value)
            for key, value in (bd.get("summary") or {}).items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
    return {
        "totalWorkingDays": payroll.total_working_days,
        "presentDays": money(payroll.present_days),
        "absentDays": money(payroll.absent_days),
    }


def _rule_groups_of(payroll: Payroll, kind: str, bd: dict | None, resolver: SettingsResolver) -> list[dict]:
    """The rules that governed this payroll as it was generated, with the current value of each and whether it changed."""
    emp = payroll.employee
    if kind == KIND_STAFF:
        assigned = assignments_on([emp.id], date(payroll.year, payroll.month, 15))
        inp = StaffRuleInput(
            emp=emp,
            month=payroll.month,
            year=payroll.year,
            base=resolver.base,
            ps=resolver.for_employee(emp),
            assignment=assigned.get(emp.id),
            holidays=holiday_dates_of(payroll.year, payroll.month),
            bd=bd or {},
        )
        return staff_rule_groups(inp, company=True)
    if kind == KIND_PRODUCTION:
        assigned = assignments_on([emp.id], payroll.period_end)
        inp = ProductionRuleInput(
            emp=emp,
            cycle=(bd or {}).get("payCycle") or payroll.pay_cycle,
            period_start=payroll.period_start,
            period_end=payroll.period_end,
            ps=resolver.for_employee(emp),
            assignment=assigned.get(emp.id),
            bd=bd or {},
        )
        return production_rule_groups(inp, company=True)
    return []


def _history(payroll: Payroll, kind: str) -> list[dict]:
    """The employee's last six OTHER payrolls of the same kind, newest first, each with how many issues it raised."""
    others = Payroll.objects.filter(employee_id=payroll.employee_id).exclude(pk=payroll.pk)
    if kind == KIND_STAFF:
        others = others.filter(salary_mode=Payroll.SALARY_MODE_MONTHLY).order_by("-year", "-month", "-id")
    else:
        others = others.filter(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False).order_by(
            "-period_start", "-id"
        )
    rows = list(others[:6])
    for row in rows:
        row.employee = payroll.employee  # already loaded: the issue detection reads the profile from it
    slips = slips_for(rows)
    out = []
    for row in rows:
        label = (
            f"{MONTH_NAMES[row.month - 1]} {row.year}"
            if kind == KIND_STAFF
            else period_label(row.period_start, row.period_end)
        )
        out.append(
            {
                "payrollId": row.id,
                "label": label,
                "net": money(row.final_salary),
                "status": row.status,
                "issues": len(detect_issues(row, slips.get(slip_key(row)))),
            }
        )
    return out


def _neighbours(request: Request, payroll: Payroll, kind: str) -> dict:
    """Previous / next payroll of the same month or period (by employee first name, then id) and where this one stands."""
    qs = scope_to_branch(Payroll.objects.all(), request, field="employee__branch_id")
    if kind == KIND_STAFF:
        qs = qs.filter(salary_mode=Payroll.SALARY_MODE_MONTHLY, month=payroll.month, year=payroll.year)
    else:
        qs = qs.filter(
            salary_mode=Payroll.SALARY_MODE_SHIFT, period_start=payroll.period_start, period_end=payroll.period_end
        )
    ids = list(qs.order_by("employee__first_name", "id").values_list("id", flat=True))
    index = ids.index(payroll.id) if payroll.id in ids else -1
    return {
        "previousId": ids[index - 1] if index > 0 else None,
        "nextId": ids[index + 1] if 0 <= index < len(ids) - 1 else None,
        "position": index + 1 if index >= 0 else 0,
        "total": len(ids),
    }


def _advances_of(bd: dict | None) -> list[dict]:
    lines = ((bd or {}).get("deductions") or {}).get("advanceDetails") or []
    return [
        {
            "advanceId": line.get("advanceId"),
            "repaymentId": line.get("repaymentId"),
            "amount": money(line.get("amount")),
            "notes": line.get("notes") or None,
        }
        for line in lines
        if isinstance(line, dict)
    ]


def _details_response(request: Request, pk: int, wanted: str) -> Response:
    modes = (
        [Payroll.SALARY_MODE_MONTHLY]
        if wanted == KIND_STAFF
        else [Payroll.SALARY_MODE_SHIFT, Payroll.SALARY_MODE_SESSION]
    )
    payroll = (
        scope_to_branch(Payroll.objects.select_related(*_PAYROLL_RELATIONS), request, field="employee__branch_id")
        .filter(pk=pk, salary_mode__in=modes)
        .first()
    )
    if payroll is None:
        return _error("Not found", 404)

    kind = kind_of(payroll)
    emp = payroll.employee
    slip = slips_for([payroll]).get(slip_key(payroll))
    bd = breakdown_of(slip)
    issues = sort_issues(detect_issues(payroll, slip))
    earnings, deductions = money_lines(payroll, slip, bd) if kind != KIND_LEGACY else ([], [])
    resolver = SettingsResolver({emp.branch_id})

    # What the page may tell the reader about the payroll itself, ahead of anything HR typed.
    notes = []
    note = hr_note_of(payroll)
    if note:
        notes.append(note)
    if kind == KIND_LEGACY:
        notes.append(
            "This payroll was calculated by the older session-based production engine: its day-by-day detail, rules and "
            "issues are not available here."
        )
    elif bd is None:
        notes.append(
            "No day-by-day breakdown is stored for this payroll (it has no salary slip), so the days, rules and issues "
            "that come from it are not available."
        )

    staff = kind == KIND_STAFF
    earn = (bd or {}).get("earnings") or {}
    # A production row generated before cycles were stamped is shown with the cycle its employee is assigned to now (as
    # the lists do), so the page can find its way back to the right cycle's list.
    cycle = None if staff else payroll.pay_cycle or (bd or {}).get("payCycle") or emp.production_pay_cycle
    context_kind = KIND_PRODUCTION if wanted == KIND_PRODUCTION else KIND_STAFF
    return Response(
        {
            "payrollId": payroll.id,
            "kind": kind,
            "slipId": slip.id if slip is not None else None,
            "slipNumber": slip.slip_number if slip is not None else None,
            "status": payroll.status,
            "generatedAt": iso_dt(payroll.updated_at),
            "firstGeneratedAt": iso_dt(payroll.created_at),
            "period": period_of_payroll(payroll, cycle),
            "employee": employee_json(emp),
            "money": {
                "gross": money(payroll.gross_salary),
                "deductions": money(payroll.deductions),
                "bonus": money(payroll.bonus),
                "otAmount": money(payroll.ot_amount),
                "net": money(payroll.final_salary),
                "monthlySalary": money(earn.get("monthlySalary") or payroll.base_salary) if staff else None,
                "dailyRate": money(earn["dailyRate"]) if staff and "dailyRate" in earn else None,
            },
            "summary": _numeric_summary(bd, payroll),
            "earnings": earnings,
            "deductions": deductions,
            "rules": _rule_groups_of(payroll, kind, bd, resolver),
            "issues": issues,
            "issueCounts": issue_counts(issues),
            "days": normalized_days(bd, issues),
            "advances": _advances_of(bd),
            "notes": "\n".join(notes) or None,
            "history": _history(payroll, kind) if kind != KIND_LEGACY else [],
            "neighbours": _neighbours(request, payroll, kind)
            if kind != KIND_LEGACY
            else {"previousId": None, "nextId": None, "position": 1, "total": 1},
            "context": {
                "kind": context_kind,
                "month": payroll.month,
                "year": payroll.year,
                "cycle": cycle if cycle in CYCLE_LABELS else None,
                "periodStart": payroll.period_start.isoformat() if payroll.period_start else None,
                "periodEnd": payroll.period_end.isoformat() if payroll.period_end else None,
            },
        }
    )


@api_view(["GET"])
@require_hr
def staff_payroll_details(request: Request, pk: int) -> Response:
    """GET /api/payroll/<id>/details
    Everything on one STAFF payroll for its details page: the employee (bank account masked, never the photo, password,
    ID proof or address), the money, ordered earnings and deductions with how each was worked out, the rules it was
    generated under (and which have changed since), its issues, the day-by-day list, history and Previous / Next. A
    production payroll id is a 404 here."""
    return _details_response(request, pk, KIND_STAFF)


@api_view(["GET"])
@require_hr
def production_payroll_details(request: Request, pk: int) -> Response:
    """GET /api/payroll/production/<id>/details
    The same for one PRODUCTION payroll (a staff payroll id is a 404). Older session-based rows answer with
    kind `legacy_session` and no day detail."""
    return _details_response(request, pk, KIND_PRODUCTION)
