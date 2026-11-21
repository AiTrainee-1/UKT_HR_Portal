"""MD portal: Attendance Search insights, how punches arrive and where records are missing (mounted at /api/md/punches/).

Thin @md_get views over analytics/punches.py. Every route takes ?period= | ?month=YYYY-MM | ?from=&to= and the scope
(?branch=&department=&type=), see common.resolve_period / resolve_scope.

    GET summary        headline figures, families of sources, devices, missing punches, coverage and the briefing
    GET sources        punches per day (per week beyond 62 days) by how they arrived, with the hand-entered share
    GET devices        punches per biometric device and whether one is silent (?limit=)
    GET missing        days with a missing punch: by department, the repeat cases, the requests (?limit=)
    GET manual         hand-entered punches: who typed them, for whom, by department (?limit=)
    GET anomalies      double taps, many punches a day, night punches (?limit=)
    GET unmatched      device IDs that match no employee (?limit=)
    GET coverage       punch-days that already have an attendance day record
    GET attention      the exceptions (needs your attention)
    GET employee/<id>  drill-down: one employee's punches day by day
"""

from django.urls import path

from ..analytics import punches as P
from ..common import MdParamError, md_get, request_params, resolve_period, resolve_scope


def _limit(params: dict, default: int = P.LIST_DEFAULT, maximum: int = P.LIST_MAX) -> int:
    raw = params.get("limit")
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise MdParamError(f"'limit' must be a whole number, got '{raw}'.") from None
    return max(1, min(value, maximum))


def _args(request) -> tuple:
    params = request_params(request)
    return resolve_scope(params), resolve_period(params, default="last_30_days"), params


@md_get
def summary(request):
    scope, period, _ = _args(request)
    return P.punch_summary(scope, period)


@md_get
def sources(request):
    scope, period, _ = _args(request)
    return P.punch_sources(scope, period)


@md_get
def devices(request):
    scope, period, params = _args(request)
    return P.punch_devices(scope, period, _limit(params, P.LIST_MAX))


@md_get
def missing(request):
    scope, period, params = _args(request)
    return P.punch_missing(scope, period, _limit(params))


@md_get
def manual(request):
    scope, period, params = _args(request)
    return P.punch_manual(scope, period, _limit(params))


@md_get
def anomalies(request):
    scope, period, params = _args(request)
    return P.punch_anomalies(scope, period, _limit(params))


@md_get
def unmatched(request):
    scope, period, params = _args(request)
    return P.punch_unmatched(scope, period, _limit(params))


@md_get
def coverage(request):
    scope, period, _ = _args(request)
    return P.punch_coverage(scope, period)


@md_get
def attention(request):
    scope, period, _ = _args(request)
    return P.punch_attention(scope, period)


@md_get
def employee(request, employee_id: int):
    params = request_params(request)
    return P.punch_employee(employee_id, resolve_period(params, default="this_month", max_days=P.EMPLOYEE_MAX_DAYS))


urlpatterns = [
    path("summary", summary),
    path("sources", sources),
    path("devices", devices),
    path("missing", missing),
    path("manual", manual),
    path("anomalies", anomalies),
    path("unmatched", unmatched),
    path("coverage", coverage),
    path("attention", attention),
    path("employee/<int:employee_id>", employee),
]
