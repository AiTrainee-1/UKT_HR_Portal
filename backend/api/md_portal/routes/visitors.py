"""MD portal: Outpass & Visitors routes (mounted at /api/md/visitors/), behind the MD's Outpass and Visitors pages. Every
view is an @md_get function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope,
calls a function in analytics/visitors.py and returns its envelope. Nothing here computes a figure.

    GET summary      headline figures with the previous period beside each
    GET trend        visits and outpasses per day (per week for long periods)
    GET units        the same measures unit by unit
    GET visitors     purposes, host departments, most visited people, repeat visitors, busiest times
    GET outpass      funnel, hours out by department, reasons, durations, approvals queue, gate refusals
    GET exceptions   what needs attention, with the people and records behind it
    GET activity     the newest visits / outpasses / gate-form exits, paged (?page=&pageSize=&q=&kind=)
    GET day          one day's snapshot (?date=YYYY-MM-DD): "who visited yesterday?"
    GET story        a page's summary in plain sentences (?focus=outpass|visitors), written from the figures above
    GET time-lost    outpass time out beside tea-break minutes lost: by day, in total, by department (?limit=)
    GET visit-list   drill-down: the visits behind a figure (?status=inside|checked_out|not_checked_out, purpose=,
                     source=qr|hr|reception, desk=<id>, host=<employee id>, company=, afterHours=1, page=, pageSize=)
    GET pass-list    drill-down: the gate passes behind a figure (?outcome=, departmentName=<a row's department name;
                     `department` stays the scope filter>, reason=, gate=<name>, employee=<id>, page=, pageSize=)
"""

from django.urls import path

from ..analytics import visitors as A
from ..common import MdParamError, md_get, parse_day, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


@md_get
def summary_view(request):
    params = request_params(request)
    return A.summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def trend_view(request):
    params = request_params(request)
    return A.trend(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def units_view(request):
    params = request_params(request)
    return A.units(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def visitors_view(request):
    params = request_params(request)
    return A.visitors_breakdown(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=A.int_param(params, "limit", 10, 1, A.MAX_LIST),
    )


@md_get
def outpass_view(request):
    params = request_params(request)
    return A.outpass_breakdown(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=A.int_param(params, "limit", 10, 1, A.MAX_LIST),
    )


@md_get
def exceptions_view(request):
    params = request_params(request)
    return A.exceptions(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=A.int_param(params, "limit", 10, 1, A.MAX_LIST),
    )


@md_get
def activity_view(request):
    params = request_params(request)
    return A.activity(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        page=A.int_param(params, "page", 1, 1, 10_000),
        page_size=A.int_param(params, "pageSize", 25, 1, 100),
        q=params.get("q", ""),
        kind=params.get("kind") or "all",
    )


@md_get
def day_view(request):
    params = request_params(request)
    raw = params.get("date") or params.get("day")
    if not raw:
        raise MdParamError("Give a date: ?date=YYYY-MM-DD, for example 2026-10-04.")
    return A.day_snapshot(resolve_scope(params), parse_day(raw, "date"), limit=A.int_param(params, "limit", 15, 1, 50))


@md_get
def story_view(request):
    params = request_params(request)
    return A.story(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        focus=str(params.get("focus") or A.PAGE_OUTPASS).strip().lower(),
    )


@md_get
def time_lost_view(request):
    params = request_params(request)
    return A.time_lost(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        limit=A.int_param(params, "limit", 10, 1, A.MAX_LIST),
    )


def _opt_int(params: dict, name: str) -> int | None:
    raw = params.get(name)
    if raw in (None, ""):
        return None
    if not str(raw).strip().isdigit():
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.")
    return int(str(raw).strip())


def _opt_text(params: dict, name: str) -> str | None:
    value = " ".join(str(params.get(name) or "").split())
    return value[:120] or None


@md_get
def visit_list_view(request):
    params = request_params(request)
    return A.visit_list(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        status=_opt_text(params, "status"),
        purpose=_opt_text(params, "purpose"),
        source=_opt_text(params, "source"),
        desk=_opt_int(params, "desk"),
        host=_opt_int(params, "host"),
        company=_opt_text(params, "company"),
        after_hours=str(params.get("afterHours") or "").lower() in ("1", "true", "yes"),
        page=A.int_param(params, "page", 1, 1, 10_000),
        page_size=A.int_param(params, "pageSize", 25, 1, 100),
    )


@md_get
def pass_list_view(request):
    params = request_params(request)
    return A.pass_list(
        resolve_scope(params),
        resolve_period(params, default=DEFAULT_PERIOD),
        outcome=_opt_text(params, "outcome"),
        department=_opt_text(params, "departmentName"),
        reason=_opt_text(params, "reason"),
        gate=_opt_text(params, "gate"),
        employee=_opt_int(params, "employee"),
        page=A.int_param(params, "page", 1, 1, 10_000),
        page_size=A.int_param(params, "pageSize", 25, 1, 100),
    )


urlpatterns = [
    path("summary", summary_view),
    path("trend", trend_view),
    path("units", units_view),
    path("visitors", visitors_view),
    path("outpass", outpass_view),
    path("exceptions", exceptions_view),
    path("activity", activity_view),
    path("day", day_view),
    path("story", story_view),
    path("time-lost", time_lost_view),
    path("visit-list", visit_list_view),
    path("pass-list", pass_list_view),
]
