"""MD portal: activity routes (mounted at /api/md/activity/). Views are thin: every one is an @md_get
function that parses ?period=&from=&to=&month= with common.resolve_period, calls a function in
analytics/activity.py and returns its envelope. Scope (unit / department / type) does not apply to the audit trail,
so ``branch`` / ``department`` / ``type`` are not read; instead ``area`` (an area key from ``options``) and ``actor``
(a person as the audit trail names them) narrow every figure (2026-11-21, analytics/activity.py ``Focus``).

    GET options      what the Area and Person filters offer for the period (with counts)
    GET summary      headline figures with the previous period
    GET trend        actions per day (week for long periods) with sensitive / after-hours / sign-ins alongside
    GET modules      actions by area of the system (follows the person)
    GET users        actions by person (?limit=; follows the area)
    GET heatmap      weekday x hour
    GET sensitive    paged sensitive actions (?page=&pageSize=&q=&category=&user=)
    GET sign-ins     sign-ins, devices, sessions, failed attempts, dormant accounts (?limit=; follows the person)
    GET feed         paged recent activity (?page=&pageSize=&q=&user=)
    GET after-hours  who works outside normal hours (?limit=)
    GET attention    what stands out in the last 7 days (the same checks the dashboard shows; never narrowed)
    GET entries/<id> one audit entry in full (never its old / new values)
"""

from django.urls import path
from rest_framework.exceptions import NotFound

from ..analytics import activity as A
from ..common import MdParamError, Period, md_get, request_params, resolve_period

DEFAULT_PERIOD = "last_30_days"


def _period(params: dict) -> Period:
    return resolve_period(params, default=DEFAULT_PERIOD)


def _focus(params: dict) -> A.Focus:
    return A.Focus.of(area=params.get("area"), actor=params.get("actor"))


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
def options(request):
    return A.activity_options(_period(request_params(request)))


@md_get
def summary(request):
    params = request_params(request)
    return A.activity_summary(_period(params), focus=_focus(params))


@md_get
def trend(request):
    params = request_params(request)
    return A.activity_trend(_period(params), focus=_focus(params))


@md_get
def modules(request):
    params = request_params(request)
    return A.activity_by_area(_period(params), focus=_focus(params))


@md_get
def users(request):
    params = request_params(request)
    return A.activity_users(_period(params), limit=_whole(params, "limit"), focus=_focus(params))


@md_get
def heatmap(request):
    params = request_params(request)
    return A.activity_heatmap(_period(params), focus=_focus(params))


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
        focus=_focus(params),
    )


@md_get
def sign_ins(request):
    params = request_params(request)
    return A.activity_sign_ins(_period(params), limit=_whole(params, "limit"), focus=_focus(params))


@md_get
def feed(request):
    params = request_params(request)
    return A.activity_feed(
        _period(params),
        page=_whole(params, "page"),
        page_size=_whole(params, "pageSize"),
        q=params.get("q"),
        user=params.get("user"),
        focus=_focus(params),
    )


@md_get
def after_hours(request):
    params = request_params(request)
    return A.activity_after_hours(_period(params), limit=_whole(params, "limit"), focus=_focus(params))


@md_get
def attention(request):
    return A.activity_attention()


@md_get
def entry(request, entry_id: int):
    found = A.activity_entry(entry_id)
    if found is None:
        # {"error": ...} like every other MD error
        raise NotFound(
            {"error": "There is no such entry in the activity log (or it is a sign-in, shown under Sign-ins)."}
        )
    return found


urlpatterns = [
    path("options", options),
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
    path("entries/<int:entry_id>", entry),
]
