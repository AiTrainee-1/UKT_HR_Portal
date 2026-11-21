"""MD portal: leave requests, balances, permissions and the holiday calendar (mounted at /api/md/leave/). Thin @md_get
views over analytics/leave.py: each parses ?period= (or ?month=YYYY-MM, or ?from=&to=) &branch=&department=&type= with
common.resolve_period / resolve_scope, calls one analytics function and returns its envelope. The MD only looks at leave
(MD_VIEW_ONLY): nothing here decides a request.

  GET summary      leave days, people, rate, per employee, requests applied / rejected / short notice, waiting now
  GET briefing     four to six plain sentences written from the same figures (no AI)
  GET trend        leave days by type over time, the previous period beside it, rising or falling
  GET groups       by leave type, department, unit or the reason picked (?by=type|department|unit|reason&limit=)
  GET today        who is on leave on a day and that week (?day=today|tomorrow|yesterday|YYYY-MM-DD&limit=)
  GET balances     the yearly allocation against what was taken, and Casual Leave's own 12-day year (?year=&limit=)
  GET permissions  permissions by type and department against the monthly cap (?limit=)
  GET patterns     Monday / Friday leave, long unplanned leave, leave before a resignation, frequent leave (?limit=)
  GET holidays     the holiday calendar against leave, and the next holidays (?limit=)
  GET approvals    what became of the requests of the period, rejection reasons, what waits now (?limit=)
  GET attention    "needs your attention" for the selected period and selection
  GET list         the rows behind a figure (?what=requests|days|out|cl|permissions&status=&leaveType=&dept=&unitName=
                   &reason=&notice=short&day=&filter=&year=&page=&pageSize=)
"""

from django.urls import path

from ..analytics import leave as L
from ..common import Period, Scope, md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


def _args(request) -> tuple[dict, Scope, Period]:
    params = request_params(request)
    return params, resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD)


@md_get
def summary(request):
    _params, scope, period = _args(request)
    return L.leave_summary(scope, period)


@md_get
def briefing(request):
    _params, scope, period = _args(request)
    return L.leave_briefing(scope, period)


@md_get
def trend(request):
    _params, scope, period = _args(request)
    return L.leave_trend(scope, period)


@md_get
def groups(request):
    params, scope, period = _args(request)
    return L.leave_groups(scope, period, by=params.get("by") or "type", limit=params.get("limit"))


@md_get
def today(request):
    params = request_params(request)
    return L.leave_today(resolve_scope(params), day=params.get("day") or "today", limit=params.get("limit"))


@md_get
def balances(request):
    params = request_params(request)
    return L.leave_balances(resolve_scope(params), year=params.get("year"), limit=params.get("limit"))


@md_get
def permissions(request):
    params, scope, period = _args(request)
    return L.leave_permissions(scope, period, limit=params.get("limit"))


@md_get
def patterns(request):
    params, scope, period = _args(request)
    return L.leave_patterns(scope, period, limit=params.get("limit"))


@md_get
def holidays(request):
    params, scope, period = _args(request)
    return L.leave_holidays(scope, period, limit=params.get("limit"))


@md_get
def approvals(request):
    params, scope, period = _args(request)
    return L.leave_approvals(scope, period, limit=params.get("limit"))


@md_get
def attention(request):
    _params, scope, period = _args(request)
    return L.leave_attention(scope, period)


@md_get
def listing(request):
    params, scope, period = _args(request)
    # the group a figure stands for has its own names (leaveType / dept / unitName): ?type= and ?department= are the scope
    return L.leave_list(
        scope,
        period,
        what=params.get("what") or "requests",
        status=params.get("status") or None,
        type=params.get("leaveType") or None,
        department=params.get("dept") or None,
        unit=params.get("unitName") or None,
        reason=params.get("reason") or None,
        notice=params.get("notice") or None,
        day=params.get("day") or None,
        filter=params.get("filter") or None,
        year=params.get("year") or None,
        page=params.get("page"),
        page_size=params.get("pageSize"),
    )


urlpatterns = [
    path("summary", summary),
    path("briefing", briefing),
    path("trend", trend),
    path("groups", groups),
    path("today", today),
    path("balances", balances),
    path("permissions", permissions),
    path("patterns", patterns),
    path("holidays", holidays),
    path("approvals", approvals),
    path("attention", attention),
    path("list", listing),
]
