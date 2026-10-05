"""MD portal: activity routes (mounted at /api/md/activity/). Views are thin: every one is an @md_get
function that parses ?period=&from=&to=&month= with common.resolve_period, calls a function in
analytics/activity.py and returns its envelope. Scope (unit / department / type) does not apply to the audit trail,
so ``branch`` / ``department`` / ``type`` are not read.

    GET summary      headline figures with the previous period
    GET trend        actions per day (week for long periods) with sensitive / after-hours / sign-ins alongside
    GET modules      actions by area of the system
    GET users        actions by person (?limit=)
    GET heatmap      weekday x hour
    GET sensitive    paged sensitive actions (?page=&pageSize=&q=&category=&user=)
    GET sign-ins     sign-ins, devices, sessions, failed attempts, dormant accounts (?limit=)
    GET feed         paged recent activity (?page=&pageSize=&q=&user=)
    GET after-hours  who works outside normal hours (?limit=)
    GET attention    what stands out in the last 7 days (the same checks the dashboard shows)
"""

from django.urls import path

from ..analytics import activity as A
from ..common import MdParamError, Period, md_get, request_params, resolve_period

DEFAULT_PERIOD = "last_30_days"


def _period(params: dict) -> Period:
    return resolve_period(params, default=DEFAULT_PERIOD)


def _whole(params: dict, name: str) -> int | None:
    """A whole-number query parameter, None when absent; anything else is a 400 the caller can read."""
    raw = params.get(name)
    if raw in (None, ""):
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.") from None


@md_get
def summary(request):
    return A.activity_summary(_period(request_params(request)))


@md_get
def trend(request):
    return A.activity_trend(_period(request_params(request)))


@md_get
def modules(request):
    return A.activity_by_area(_period(request_params(request)))


@md_get
def users(request):
    params = request_params(request)
    return A.activity_users(_period(params), limit=_whole(params, "limit"))


@md_get
def heatmap(request):
    return A.activity_heatmap(_period(request_params(request)))


@md_get
def sensitive(request):
    params = request_params(request)
    return A.activity_sensitive(
        _period(params),
        page=_whole(params, "page"),
        page_size=_whole(params, "pageSize"),
        q=params.get("q"),
        category=params.get("category"),
        user=params.get("user"),
    )


@md_get
def sign_ins(request):
    params = request_params(request)
    return A.activity_sign_ins(_period(params), limit=_whole(params, "limit"))


@md_get
def feed(request):
    params = request_params(request)
    return A.activity_feed(
        _period(params),
        page=_whole(params, "page"),
        page_size=_whole(params, "pageSize"),
        q=params.get("q"),
        user=params.get("user"),
    )


@md_get
def after_hours(request):
    params = request_params(request)
    return A.activity_after_hours(_period(params), limit=_whole(params, "limit"))


@md_get
def attention(request):
    return A.activity_attention()


urlpatterns = [
    path("summary", summary),
    path("trend", trend),
    path("modules", modules),
    path("users", users),
    path("heatmap", heatmap),
    path("sensitive", sensitive),
    path("sign-ins", sign_ins),
    path("feed", feed),
    path("after-hours", after_hours),
    path("attention", attention),
]
