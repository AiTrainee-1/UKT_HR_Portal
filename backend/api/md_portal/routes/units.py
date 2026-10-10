"""MD portal: branches routes (mounted at /api/md/units/). Views are thin: every one is an @md_get function that parses
?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in analytics/units.py and
returns its envelope.

  GET summary    the units side by side: every figure with the company's figure, the difference and the rank, the best and
                 weakest unit on each, and a plain-English summary
  GET rank       the units ranked on one figure (?metric=&limit=)
  GET trend      one figure by unit over time, with the company's line (?metric=)
  GET profile    one unit against the company and its departments against the unit (?branch=<unit name or id>)
  GET attention  "needs your attention" for the selected period and scope
"""

from django.urls import path

from ..analytics import units
from ..common import md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = units.DEFAULT_PERIOD


@md_get
def summary(request):
    params = request_params(request)
    return units.units_summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def rank(request):
    params = request_params(request)
    return units.units_rank(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        metric=params.get("metric") or "attendancePct",
        limit=params.get("limit"),
    )


@md_get
def trend(request):
    params = request_params(request)
    return units.units_trend(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        metric=params.get("metric") or "attendancePct",
    )


@md_get
def profile(request):
    params = request_params(request)
    return units.unit_profile(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def attention(request):
    params = request_params(request)
    return units.units_attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("rank", rank),
    path("trend", trend),
    path("profile", profile),
    path("attention", attention),
]
