"""MD portal: payroll routes (mounted at /api/md/payroll/). Views are thin: every one is an @md_get function that parses
?month=YYYY-MM&branch=&department=&type= with common.resolve_scope, calls a function in analytics/payroll.py and returns
its envelope. Payroll is monthly, so there is no free-form period: ``month`` is the payroll month (default: the latest
closed month, i.e. the most recent month that has ended and has salary slips).

The employee-focused Payroll page (owner 2026-11-14; analytics/payroll_people.py, contract
frontend/src/pages/md/payroll-dashboard/types.ts) adds monthly, department-breakdown, people and people/<id>; their
default month is the latest month WITH slips, and an unknown employee is a 404."""

from django.urls import path
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ...auth import require_md
from ..analytics import payroll as analytics
from ..analytics import payroll_people as people_analytics
from ..common import MdParamError, md_get, parse_month, read_only_db, request_params, resolve_scope

NO_SUCH_EMPLOYEE = "There is no employee with this id."


def _month(params: dict) -> str | None:
    """The requested payroll month normalised to YYYY-MM, or None for the default. A bad value is a 400."""
    value = str(params.get("month") or "").strip()
    if not value:
        return None
    year, month = parse_month(value)
    return f"{year:04d}-{month:02d}"


def _int(params: dict, name: str, default: int, low: int, high: int) -> int:
    raw = params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.") from None
    return max(low, min(high, value))


@md_get
def summary(request):
    params = request_params(request)
    return analytics.payroll_summary(resolve_scope(params), _month(params))


@md_get
def trend(request):
    params = request_params(request)
    return analytics.payroll_trend(resolve_scope(params), _month(params), _int(params, "months", 12, 2, 36))


@md_get
def bridge(request):
    params = request_params(request)
    return analytics.payroll_bridge(resolve_scope(params), _month(params))


@md_get
def departments(request):
    params = request_params(request)
    return analytics.payroll_departments(resolve_scope(params), _month(params), _int(params, "limit", 25, 1, 25))


@md_get
def distribution(request):
    params = request_params(request)
    return analytics.payroll_distribution(resolve_scope(params), _month(params), _int(params, "limit", 10, 1, 25))


@md_get
def components(request):
    params = request_params(request)
    return analytics.payroll_components(resolve_scope(params), _month(params))


@md_get
def advances(request):
    params = request_params(request)
    return analytics.payroll_advances(resolve_scope(params), _month(params))


@md_get
def exceptions(request):
    params = request_params(request)
    kind = str(params.get("kind") or "").strip() or None
    return analytics.payroll_exceptions(resolve_scope(params), _month(params), _int(params, "limit", 10, 1, 100), kind)


@md_get
def status(request):
    params = request_params(request)
    return analytics.payroll_status(resolve_scope(params), _int(params, "months", 12, 1, 36))


@md_get
def attention(request):
    params = request_params(request)
    return analytics.payroll_attention(resolve_scope(params), _month(params))


# ─── the employee-focused Payroll page (owner 2026-11-14): analytics/payroll_people.py, contract
# frontend/src/pages/md/payroll-dashboard/types.ts ────────────────────────────────────────────────────────────


@md_get
def monthly(request):
    params = request_params(request)
    return people_analytics.payroll_monthly(
        resolve_scope(params),
        _month(params),
        _int(params, "months", people_analytics.MONTHS_DEFAULT, 1, people_analytics.MONTHS_MAX),
    )


@md_get
def department_breakdown(request):
    params = request_params(request)
    return people_analytics.payroll_department_breakdown(resolve_scope(params), _month(params))


@md_get
def people(request):
    params = request_params(request)
    sort = str(params.get("sort") or "name").strip()
    direction = str(params.get("dir") or "asc").strip().lower()
    q = str(params.get("q") or "").strip()[:100] or None
    return people_analytics.payroll_people(
        resolve_scope(params),
        _month(params),
        q,
        sort,
        direction,
        _int(params, "page", 1, 1, 100_000),
        _int(params, "pageSize", people_analytics.PAGE_SIZE_DEFAULT, 1, people_analytics.PAGE_SIZE_MAX),
    )


@api_view(["GET"])
@require_md
def person(request: Request, employee_id: int) -> Response:
    """Read-only like an @md_get view, but an employee who does not exist is a 404."""
    params = request_params(request)
    try:
        months = _int(params, "months", people_analytics.PERSON_MONTHS_DEFAULT, 1, people_analytics.PERSON_MONTHS_MAX)
        with read_only_db():
            body = people_analytics.payroll_person(employee_id, months)
    except MdParamError as exc:
        return Response({"error": str(exc)}, status=400)
    if body is None:
        return Response({"error": NO_SUCH_EMPLOYEE, "code": "no_such_employee"}, status=404)
    return Response(body)


urlpatterns = [
    path("summary", summary),
    path("trend", trend),
    path("bridge", bridge),
    path("departments", departments),
    path("distribution", distribution),
    path("components", components),
    path("advances", advances),
    path("exceptions", exceptions),
    path("status", status),
    path("attention", attention),
    path("monthly", monthly),
    path("department-breakdown", department_breakdown),
    path("people", people),
    path("people/<int:employee_id>", person),
]
