"""MD portal: attendance routes (mounted at /api/md/attendance/). Views are thin: every one is an @md_get
function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/attendance.py and returns its envelope.

    GET summary      headline figures with the previous period and the change (plus today's live count)
    GET trend        daily (weekly for long periods) attendance, absence and lateness
    GET departments  ranking by department, unit, and staff against production (?limit=)
    GET weekday      average by weekday and a weekday x week heatmap
    GET heatmap      department x day attendance %
    GET exceptions   chronic absentees, late-comers, long absences, missing punches, patterns (?limit=)
    GET overtime     hours by department, top people, trend, decisions (?limit=)
    GET leave        leave days by type, pending approvals, permissions
    GET day          one day's snapshot (?date=YYYY-MM-DD | today | yesterday)
"""

from django.urls import path

from ..analytics import attendance as A
from ..common import MdParamError, md_get, request_params, resolve_period, resolve_scope


def _limit(params: dict, default: int, maximum: int) -> int:
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
    return A.attendance_summary(scope, period)


@md_get
def trend(request):
    scope, period, _ = _args(request)
    return A.attendance_trend(scope, period)


@md_get
def departments(request):
    scope, period, params = _args(request)
    return A.attendance_by_department(scope, period, _limit(params, A.DEPARTMENT_LIMIT_DEFAULT, A.DEPARTMENT_LIMIT_MAX))


@md_get
def weekday(request):
    scope, period, _ = _args(request)
    return A.attendance_weekday(scope, period)


@md_get
def heatmap(request):
    scope, period, _ = _args(request)
    return A.attendance_heatmap(scope, period)


@md_get
def exceptions(request):
    scope, period, params = _args(request)
    return A.attendance_exceptions(scope, period, _limit(params, A.LIST_LIMIT_DEFAULT, A.LIST_LIMIT_MAX))


@md_get
def overtime(request):
    scope, period, params = _args(request)
    return A.attendance_overtime(scope, period, _limit(params, A.LIST_LIMIT_DEFAULT, A.LIST_LIMIT_MAX))


@md_get
def leave(request):
    scope, period, _ = _args(request)
    return A.attendance_leave(scope, period)


@md_get
def day(request):
    params = request_params(request)
    return A.attendance_on_date(
        resolve_scope(params),
        A.parse_day_param(params.get("date")),
        _limit(params, A.DEPARTMENT_LIMIT_DEFAULT, A.DEPARTMENT_LIMIT_MAX),
    )


urlpatterns = [
    path("summary", summary),
    path("trend", trend),
    path("departments", departments),
    path("weekday", weekday),
    path("heatmap", heatmap),
    path("exceptions", exceptions),
    path("overtime", overtime),
    path("leave", leave),
    path("day", day),
]
