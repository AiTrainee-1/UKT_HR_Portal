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
    GET people       drill-down: the employees behind a figure (?metric=absent|late|half|leave|quarter|penalty|worked|
                     workedOff, &day=YYYY-MM-DD, &page=, &pageSize=)
    GET employee/<id>  drill-down: one employee's days in the period
    GET today-people drill-down: the people on one of today's six cards (?state=present|onDuty|onLeave|cl|leaveApplied|
                     absent, &limit=)

Every period route takes ?month=YYYY-MM as well as ?period= or ?from=&to= (common.resolve_period).
"""

from django.urls import path

from ..analytics import attendance as A
from ..common import MdParamError, md_get, parse_day, request_params, resolve_period, resolve_scope


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


@md_get
def people(request):
    scope, period, params = _args(request)
    day = params.get("day")
    return A.attendance_people(
        scope,
        period,
        metric=str(params.get("metric") or "absent"),
        day=parse_day(day, "day") if day else None,
        page=_limit(params | {"limit": params.get("page")}, 1, 10_000),
        page_size=_limit(params | {"limit": params.get("pageSize")}, 25, A.PEOPLE_PAGE_MAX),
    )


@md_get
def employee(request, employee_id: int):
    params = request_params(request)
    return A.attendance_employee(employee_id, resolve_period(params, default="this_month"))


@md_get
def today_people(request):
    params = request_params(request)
    return A.attendance_today_people(
        resolve_scope(params), str(params.get("state") or "absent"), _limit(params, 50, 200)
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
    path("people", people),
    path("employee/<int:employee_id>", employee),
    path("today-people", today_people),
]
