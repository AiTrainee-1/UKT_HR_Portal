"""MD portal: employees routes (mounted at /api/md/employees/). Views are thin: every one is an @md_get
function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/employees.py and returns its envelope.

    GET summary        headcount, joiners, leavers, attrition, tenure, early attrition (period)
    GET composition    who works here today: type, unit, department, designation, gender, age, tenure, planned vs actual
    GET movement       joiners / leavers / headcount over time (period)
    GET attrition      by department / unit, hot-spots, tenure at exit, reasons, early leavers (period)
    GET milestones     work anniversaries, birthdays, probation (look-ahead)
    GET insights       "Needs your attention" for the chosen period and scope
    GET directory      the searchable, paged people list (no salary)
    GET employee/<id>  one person's read-only profile (no salary)
"""

from django.urls import path
from rest_framework.exceptions import NotFound

from ..analytics import employees as analytics
from ..common import MdParamError, md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_12_months"


def _int(params: dict, name: str, default: int, *, minimum: int = 1, maximum: int | None = None) -> int:
    """An integer query parameter, clamped to its range; text that is not a whole number is a 400, not a guess."""
    raw = params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.") from None
    value = max(minimum, value)
    return min(value, maximum) if maximum is not None else value


@md_get
def summary(request):
    params = request_params(request)
    return analytics.summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def composition(request):
    params = request_params(request)
    return analytics.composition(resolve_scope(params), limit=_int(params, "limit", 8, maximum=analytics.MAX_LIMIT))


@md_get
def movement(request):
    params = request_params(request)
    return analytics.movement(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def attrition(request):
    params = request_params(request)
    return analytics.attrition(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=_int(params, "limit", analytics.DEFAULT_LIMIT, maximum=analytics.MAX_LIMIT),
    )


@md_get
def milestones(request):
    params = request_params(request)
    return analytics.milestones(
        resolve_scope(params),
        days=_int(params, "days", 30, maximum=90),
        birthday_days=_int(params, "birthdayDays", 7, maximum=30),
        limit=_int(params, "limit", analytics.DEFAULT_LIMIT, maximum=analytics.MAX_LIMIT),
    )


@md_get
def insights(request):
    params = request_params(request)
    return analytics.exceptions(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def directory(request):
    params = request_params(request)
    return analytics.directory(
        resolve_scope(params),
        query=params.get("q"),
        status=params.get("status") or "active",
        designation=params.get("designation"),
        sort=params.get("sort") or "name",
        descending=(params.get("dir") or "asc").lower() == "desc",
        page=_int(params, "page", 1),
        page_size=_int(params, "pageSize", 25, maximum=100),
    )


@md_get
def employee(request, employee_id: int):
    body = analytics.employee_profile(employee_id=employee_id, detail=True)
    if not body["found"]:
        raise NotFound({"error": "There is no employee with that id."})  # {"error": ...} like every other MD error
    return body


urlpatterns = [
    path("summary", summary),
    path("composition", composition),
    path("movement", movement),
    path("attrition", attrition),
    path("milestones", milestones),
    path("insights", insights),
    path("directory", directory),
    path("employee/<int:employee_id>", employee),
]
