"""
Production Payroll -configurable-period generation, listing, and dry-run
skip-check, completely separate from the Staff payroll engine (see
payroll_views.py::generate_payroll for that; it no longer touches
Production at all).

Periods are driven entirely by Settings → Payroll → Production
(PayrollSettings.prod_period_*) via production_period.py -there is no
month/year/week_number input from the caller anymore; every endpoint here
either resolves "the next period" automatically or accepts an explicit
period_start/period_end for backfilling a past period.
"""

from datetime import date

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
from .user_settings import settings_for
from .models import Employee, Payroll, PayrollSettings
from .payroll_views import (
    PayrollSkip, _DryRunAbort, _error, _generate_production_payroll, _payroll_json,
)
from .production_period import (
    InvalidPeriodConfig, get_next_production_period, resolve_production_period,
)


def _parse_period(data) -> tuple[date, date] | None:
    """Returns (period_start, period_end) from explicit request data, or
    None if neither was supplied (caller should fall back to the next
    due period)."""
    ps_raw, pe_raw = data.get("periodStart"), data.get("periodEnd")
    if not ps_raw and not pe_raw:
        return None
    if not ps_raw or not pe_raw:
        raise ValueError("periodStart and periodEnd must both be provided together")
    return date.fromisoformat(ps_raw), date.fromisoformat(pe_raw)


@api_view(["GET"])
@require_hr
def production_next_period(request: Request) -> Response:
    """GET /api/payroll/production/next-period
    The period that would be generated next if Generate were clicked now,
    computed live from current Settings -does not write anything."""
    ps = settings_for(request)
    try:
        period_start, period_end = get_next_production_period(ps)
    except InvalidPeriodConfig as e:
        return _error(str(e))
    return Response({
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "periodEnded": period_end <= date.today(),
        "frequency": ps.prod_period_frequency,
        "style": ps.prod_period_style,
    })


@api_view(["GET"])
@require_hr
def production_skip_check(request: Request) -> Response:
    """GET /api/payroll/production/skip-check?periodStart=&periodEnd=
    Read-only dry run -mirrors payroll_views.py::payroll_skip_check's
    savepoint-and-rollback pattern. Defaults to the next due period when no
    explicit period is given."""
    ps = settings_for(request)
    try:
        explicit = _parse_period(request.query_params)
    except ValueError as e:
        return _error(str(e))
    try:
        period_start, period_end = explicit or get_next_production_period(ps)
    except InvalidPeriodConfig as e:
        return _error(str(e))

    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
        .order_by("first_name", "last_name")
    )
    skipped = []
    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}".strip()
        try:
            with transaction.atomic():
                _generate_production_payroll(emp, period_start, period_end)
                raise _DryRunAbort()
        except _DryRunAbort:
            reason = None
        except PayrollSkip as e:
            reason = str(e)
        except Exception as e:
            reason = str(e)
        if reason:
            skipped.append({
                "employeeId": emp.id, "employeeCode": emp.employee_code,
                "name": emp_name, "reason": reason,
            })

    return Response({
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "totalChecked": len(employees),
        "skippedCount": len(skipped),
        "skipped": skipped,
    })


@api_view(["POST"])
@require_hr
def production_generate_payroll(request: Request) -> Response:
    """POST /api/payroll/production/generate
    Body (optional): { periodStart: "YYYY-MM-DD", periodEnd: "YYYY-MM-DD" }
    Omit both to generate the next due period automatically. Rejects a
    period that hasn't ended yet -attendance for days still in progress
    isn't final."""
    ps = settings_for(request)
    try:
        explicit = _parse_period(request.data)
    except ValueError as e:
        return _error(str(e))
    try:
        period_start, period_end = explicit or get_next_production_period(ps)
    except InvalidPeriodConfig as e:
        return _error(str(e))

    if period_end > date.today():
        return _error(f"Period {period_start.isoformat()}–{period_end.isoformat()} has not ended yet.")

    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
    )
    generated, skipped = [], []

    from . import payroll_progress
    payroll_progress.start(len(employees))

    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}"
        before_count = len(generated)
        try:
            result = _generate_production_payroll(emp, period_start, period_end)
            generated.append(_payroll_json(result["payroll"], emp_name))
        except PayrollSkip as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        except Exception as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        payroll_progress.step(emp_name, len(generated) > before_count)

    payroll_progress.finish()

    from .audit_utils import log_action as _log
    _log(request, "create", "payroll", description=(
        f"Generated production payroll {period_start.isoformat()}–{period_end.isoformat()} -"
        f"{len(generated)} generated, {len(skipped)} skipped"
    ))
    return Response({
        "message": (
            f"Production payroll generated for {period_start.isoformat()}–{period_end.isoformat()}. "
            f"{len(generated)} records computed, {len(skipped)} skipped."
        ),
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "generated": len(generated),
        "skipped": len(skipped),
        "skippedDetails": skipped,
    }, status=201)


@api_view(["GET"])
@require_hr
def production_payroll_list(request: Request) -> Response:
    """GET /api/payroll/production?employeeId=&status=&limit=
    Period-based (new-style) rows only -legacy week_number-based production
    rows still show up on the old Payroll/Salary pages, unaffected by this
    endpoint. No month/year filter -periods aren't month-bound; the
    frontend does client-side search/filtering the same way the existing
    pages already do."""
    qs = (
        Payroll.objects.select_related("employee", "employee__department")
        .filter(salary_mode="shift", period_start__isnull=False)
        .order_by("-period_start", "employee__first_name")
    )
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    if request.query_params.get("employeeId"):
        try:
            qs = qs.filter(employee_id=int(request.query_params["employeeId"]))
        except ValueError:
            return _error("employeeId must be an integer")
    if request.query_params.get("status"):
        qs = qs.filter(status=request.query_params["status"])
    try:
        limit = int(request.query_params.get("limit", 200))
    except ValueError:
        limit = 200

    result = []
    for p in qs[:limit]:
        emp = p.employee
        row = _payroll_json(p, f"{emp.first_name} {emp.last_name}")
        row["employeeCode"] = emp.employee_code
        row["bankAccount"] = emp.bank_account or ""
        row["bankIfsc"] = emp.bank_ifsc or ""
        row["bankName"] = emp.bank_name or ""
        row["email"] = emp.email or ""
        row["departmentId"] = emp.department_id
        row["departmentName"] = emp.department.name if emp.department else None
        result.append(row)
    return Response(result)
