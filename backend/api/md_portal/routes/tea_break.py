"""MD portal: tea break routes (mounted at /api/md/tea-break/). Views are thin: every one is an @md_get
function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/tea_break.py and returns its envelope.

  GET summary     breaks, people, average, overruns, minutes lost, compliance, coverage (each vs the previous period)
  GET trend       overrun % and minutes lost by day or week, 7-day average, better-or-worse verdict
  GET departments ranking by department / unit / staff-vs-production (?by=department|unit|type&limit=)
  GET shifts      the same ranking by shift (?limit=)
  GET heatmap     half-hour slots by weekday
  GET offenders   repeat overrunners (?limit=&min=)
  GET rule        what counts as an overrun, in plain words (no period or scope)
  GET attention   "needs your attention" for the selected period and scope
  GET story       the Insights tab's summary: a few plain sentences written from the figures above (no AI)
"""

from django.urls import path

from ..analytics import tea_break as tea
from ..common import md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


@md_get
def summary(request):
    params = request_params(request)
    return tea.tea_summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def trend(request):
    params = request_params(request)
    return tea.tea_trend(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def departments(request):
    params = request_params(request)
    return tea.tea_departments(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        by=params.get("by") or "department",
        limit=params.get("limit"),
    )


@md_get
def shifts(request):
    params = request_params(request)
    return tea.tea_shifts(
        resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD), limit=params.get("limit")
    )


@md_get
def heatmap(request):
    params = request_params(request)
    return tea.tea_heatmap(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def offenders(request):
    params = request_params(request)
    return tea.tea_offenders(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=params.get("limit"),
        min_overruns=params.get("min"),
    )


@md_get
def rule(request):
    return tea.tea_rule()


@md_get
def attention(request):
    params = request_params(request)
    return tea.tea_attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def story(request):
    params = request_params(request)
    return tea.tea_story(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("trend", trend),
    path("departments", departments),
    path("shifts", shifts),
    path("heatmap", heatmap),
    path("offenders", offenders),
    path("rule", rule),
    path("attention", attention),
    path("story", story),
]
