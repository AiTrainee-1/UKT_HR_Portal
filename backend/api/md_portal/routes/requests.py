"""MD portal: requests (mounted at /api/md/requests/). Thin @md_get views over analytics/requests.py: each parses
?period= (or ?month=YYYY-MM, or ?from=&to=) &branch=&department=&type= with common.resolve_period / resolve_scope, and
&kind= (all | one kind | a comma-separated list), calls one analytics function and returns its envelope. The MD only looks
at requests (MD_VIEW_ONLY): nothing here, or anywhere under /api/md/, decides one.

  GET summary      waiting now (by age and who it waits on), submitted, decided, approval / rejection rates, time to decide
  GET waiting      everything waiting now, by kind and by who it waits on, with the oldest requests
  GET turnaround   how fast requests are decided, overall and by kind, and the decision-time bands
  GET breakdown    by kind, department, unit or staff / production (?by=kind|department|unit|type&limit=)
  GET trend        submitted (by kind, with the previous period) and decided per day or week
  GET bottlenecks  who requests wait on, the departments with the most waiting, approvers ranked by speed (?limit=)
  GET unusual      people with many requests, repeated rejections, large and partly approved advances (?limit=)
  GET rejections   rejections in the period with the approvers' reasons (?limit=)
  GET attention    "needs your attention" for the selected period, selection and kind
  GET list         the requests behind a figure, a page at a time (?status=waiting|submitted|decided|approved|rejected
                   &holder=hr|hod|either&dept=<group department>&employee=&approver=&band=&reason=&page=&pageSize=)
"""

from django.urls import path

from ..analytics import requests as R
from ..common import Period, Scope, md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


def _args(request) -> tuple[dict, Scope, Period]:
    params = request_params(request)
    return params, resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD)


@md_get
def summary(request):
    params, scope, period = _args(request)
    return R.requests_summary(scope, period, kind=params.get("kind") or "all")


@md_get
def waiting(request):
    params = request_params(request)
    return R.requests_waiting(resolve_scope(params), kind=params.get("kind") or "all", limit=params.get("limit"))


@md_get
def turnaround(request):
    params, scope, period = _args(request)
    return R.requests_turnaround(scope, period, kind=params.get("kind") or "all")


@md_get
def breakdown(request):
    params, scope, period = _args(request)
    return R.requests_breakdown(
        scope, period, kind=params.get("kind") or "all", by=params.get("by") or "kind", limit=params.get("limit")
    )


@md_get
def trend(request):
    params, scope, period = _args(request)
    return R.requests_trend(scope, period, kind=params.get("kind") or "all")


@md_get
def bottlenecks(request):
    params, scope, period = _args(request)
    return R.requests_bottlenecks(scope, period, kind=params.get("kind") or "all", limit=params.get("limit"))


@md_get
def unusual(request):
    params, scope, period = _args(request)
    return R.requests_unusual(scope, period, kind=params.get("kind") or "all", limit=params.get("limit"))


@md_get
def rejections(request):
    params, scope, period = _args(request)
    return R.requests_rejections(scope, period, kind=params.get("kind") or "all", limit=params.get("limit"))


@md_get
def attention(request):
    params, scope, period = _args(request)
    return R.requests_attention(scope, period, kind=params.get("kind") or "all")


@md_get
def listing(request):
    params, scope, period = _args(request)
    return R.requests_list(
        scope,
        period,
        kind=params.get("kind") or "all",
        status=params.get("status") or "waiting",
        holder=params.get("holder") or None,
        department=params.get("dept") or None,
        employee=params.get("employee") or None,
        approver=params.get("approver") or None,
        band=params.get("band") or None,
        reason=params.get("reason") or None,
        page=params.get("page"),
        page_size=params.get("pageSize"),
    )


urlpatterns = [
    path("summary", summary),
    path("waiting", waiting),
    path("turnaround", turnaround),
    path("breakdown", breakdown),
    path("trend", trend),
    path("bottlenecks", bottlenecks),
    path("unusual", unusual),
    path("rejections", rejections),
    path("attention", attention),
    path("list", listing),
]
