"""MD portal: geo attendance routes (mounted at /api/md/geo/). Views are thin: every one is an @md_get function that
parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/geo.py and returns its envelope.

  GET summary       sessions, people out, punches, verified / rejected / waiting, verification time, unusual counts
  GET briefing      three to five plain sentences built from the same figures (no AI)
  GET trend         sessions, punches by status and office geo punches by day or week, rising-or-falling verdict
  GET verification  where requests and punches stand, how long HR takes, what is waiting now
  GET departments   who goes out by department / unit / staff-vs-production (?by=department|unit|type&limit=)
  GET people        who goes out most and how often (?limit=&min=)
  GET reach         how far from their unit on-duty punches were taken
  GET unusual       sessions that look unusual with their reasons, and people with repeated rejections (?limit=)
  GET live          who is on duty right now (no period)
  GET attention     "needs your attention" for the selected period and scope
"""

from django.urls import path

from ..analytics import geo
from ..common import md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


@md_get
def summary(request):
    params = request_params(request)
    return geo.geo_summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def briefing(request):
    params = request_params(request)
    return geo.geo_briefing(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def trend(request):
    params = request_params(request)
    return geo.geo_trend(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def verification(request):
    params = request_params(request)
    return geo.geo_verification(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def departments(request):
    params = request_params(request)
    return geo.geo_breakdown(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        by=params.get("by") or "department",
        limit=params.get("limit"),
    )


@md_get
def people(request):
    params = request_params(request)
    return geo.geo_people(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=params.get("limit"),
        min_sessions=params.get("min"),
    )


@md_get
def reach(request):
    params = request_params(request)
    return geo.geo_reach(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def unusual(request):
    params = request_params(request)
    return geo.geo_unusual(
        resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD), limit=params.get("limit")
    )


@md_get
def live(request):
    return geo.geo_live(resolve_scope(request_params(request)))


@md_get
def attention(request):
    params = request_params(request)
    return geo.geo_attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("briefing", briefing),
    path("trend", trend),
    path("verification", verification),
    path("departments", departments),
    path("people", people),
    path("reach", reach),
    path("unusual", unusual),
    path("live", live),
    path("attention", attention),
]
