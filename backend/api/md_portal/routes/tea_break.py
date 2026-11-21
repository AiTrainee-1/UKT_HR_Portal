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
  GET records     drill-down: the breaks behind a figure (?status=within|overrun|long|no_return|in_progress|refused,
                  by=department|unit|type|gate&group=<row key>, employee=<id>, page=, pageSize=)
"""

from django.urls import path

from ..analytics import tea_break as tea
from ..common import MdParamError, md_get, request_params, resolve_period, resolve_scope

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


def _whole(params: dict, name: str, default: int, low: int, high: int) -> int:
    raw = params.get(name)
    if raw in (None, ""):
        return default
    if not str(raw).strip().isdigit():
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.")
    return max(low, min(high, int(str(raw).strip())))


@md_get
def records(request):
    params = request_params(request)
    return tea.tea_records(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        status=(params.get("status") or "").strip() or None,
        group_by=(params.get("by") or "").strip() or None,
        group=" ".join(str(params.get("group") or "").split())[:120] or None,
        employee=_whole(params, "employee", 0, 0, 10**9) or None,
        page=_whole(params, "page", 1, 1, 10_000),
        page_size=_whole(params, "pageSize", 25, 1, 100),
    )


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
    path("records", records),
]
