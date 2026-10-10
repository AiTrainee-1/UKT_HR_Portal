"""MD portal: the attendance report log routes (mounted at /api/md/reportlog/). Views are thin: every one is an
@md_get function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a
function in analytics/reportlog.py and returns its envelope.

  GET summary      absences and how many were followed up (Informed / Not informed / not marked), gap days, exports
  GET briefing     two to four plain sentences built from the same figures (no AI)
  GET trend        absences by how they were marked, and attendance report exports, by day or week
  GET gaps         the gap calendar and the days nobody made the call
  GET departments  follow-up by department / unit / staff-vs-production (?by=department|unit|type&limit=)
  GET exports      who exports attendance reports and how often (whole company; period only; ?limit=)
  GET attention    "needs your attention" for the selected period and scope
"""

from django.urls import path

from ..analytics import reportlog as rl
from ..common import md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


@md_get
def summary(request):
    params = request_params(request)
    return rl.reportlog_summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def briefing(request):
    params = request_params(request)
    return rl.reportlog_briefing(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def trend(request):
    params = request_params(request)
    return rl.reportlog_trend(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def gaps(request):
    params = request_params(request)
    return rl.reportlog_gaps(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def departments(request):
    params = request_params(request)
    return rl.reportlog_breakdown(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        by=params.get("by") or "department",
        limit=params.get("limit"),
    )


@md_get
def exports(request):
    params = request_params(request)
    return rl.reportlog_exports(resolve_period(params, default=DEFAULT_PERIOD), limit=params.get("limit"))


@md_get
def attention(request):
    params = request_params(request)
    return rl.reportlog_attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("briefing", briefing),
    path("trend", trend),
    path("gaps", gaps),
    path("departments", departments),
    path("exports", exports),
    path("attention", attention),
]
