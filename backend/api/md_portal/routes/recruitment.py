"""MD portal: recruitment routes (mounted at /api/md/recruitment/). Views are thin: every one is an @md_get
function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/recruitment.py and returns its envelope.

  GET summary       the scorecard: positions, pipeline, interviews, joiners, leavers, resignations, attrition
  GET attention     "needs your attention": exceptions for the chosen period and scope
  GET funnel        applied -> screened -> shortlisted -> interviewed -> offered -> joined, by pipeline and department
  GET positions     open positions with age and stage mix, and the headcount gap by department (no period)
  GET resignations  waiting for a decision, serving notice, outlook, reasons, by department
  GET joiners       who joined, by department and unit, and early attrition
  GET trend         joiners against leavers for the last 12 months and the gap to the plan (no period)
  GET sources       which pipeline candidates entered through
"""

from django.urls import path

from ..analytics import recruitment as recruitment_analytics
from ..common import MdParamError, md_get, request_params, resolve_period, resolve_scope

# Hiring is slow and lumpy (a month can have two joiners), so the default window is a quarter, not a month.
DEFAULT_PERIOD = "last_90_days"


def _limit(params: dict, default: int, maximum: int) -> int:
    raw = params.get("limit")
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw))
    except ValueError:
        raise MdParamError(f"'limit' must be a whole number, got '{raw}'.") from None
    return max(1, min(maximum, value))


@md_get
def summary(request):
    params = request_params(request)
    return recruitment_analytics.summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def attention(request):
    params = request_params(request)
    return recruitment_analytics.attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def funnel(request):
    params = request_params(request)
    return recruitment_analytics.funnel(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def positions(request):
    params = request_params(request)
    return recruitment_analytics.positions(resolve_scope(params), limit=_limit(params, 50, 100))


@md_get
def resignations(request):
    params = request_params(request)
    return recruitment_analytics.resignations(
        resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD), limit=_limit(params, 10, 25)
    )


@md_get
def joiners(request):
    params = request_params(request)
    return recruitment_analytics.joiners(
        resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD), limit=_limit(params, 10, 25)
    )


@md_get
def trend(request):
    return recruitment_analytics.trend(resolve_scope(request_params(request)))


@md_get
def sources(request):
    params = request_params(request)
    return recruitment_analytics.sources(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("attention", attention),
    path("funnel", funnel),
    path("positions", positions),
    path("resignations", resignations),
    path("joiners", joiners),
    path("trend", trend),
    path("sources", sources),
]
