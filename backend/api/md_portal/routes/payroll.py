"""MD portal: payroll routes (mounted at /api/md/payroll/). Views are thin: every one is an @md_get function that parses
?month=YYYY-MM&branch=&department=&type= with common.resolve_scope, calls a function in analytics/payroll.py and returns
its envelope. Payroll is monthly, so there is no free-form period: ``month`` is the payroll month (default: the latest
closed month, i.e. the most recent month that has ended and has salary slips)."""

from django.urls import path

from ..analytics import payroll as analytics
from ..common import MdParamError, md_get, parse_month, request_params, resolve_scope


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
]
