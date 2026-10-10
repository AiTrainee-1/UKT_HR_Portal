"""MD portal: shifts and who is assigned to them (mounted at /api/md/shifts/). Views are thin: every one is an @md_get
function that parses ?period=&branch=&department=&type= with common.resolve_period / resolve_scope, calls a function in
analytics/shifts.py and returns its envelope.

  GET summary     employees on a shift / without one, shifts in use, shift changes, assignments to watch, balance
  GET briefing    the plain-English summary (fixed rules, no AI), built from the same figures
  GET coverage    people per shift today, the shift x department grid, shifts nobody is on, staffing balance (no period)
  GET unassigned  employees with no shift today, longest uncovered first (?limit=; no period)
  GET watch       assignments ending soon with nothing after, overlapping, starting later (?days=&limit=; no period)
  GET changes     shift changes by day or week: moves, first assignments, renewals; each shift's people in and out
  GET attendance  attendance, absenteeism and late % per shift, against the previous period and the overall rate
  GET attention   "needs your attention" for the selected period and scope
"""

from django.urls import path

from ..analytics import shifts as shifts_analytics
from ..common import md_get, request_params, resolve_period, resolve_scope

DEFAULT_PERIOD = "last_30_days"


@md_get
def summary(request):
    params = request_params(request)
    return shifts_analytics.shifts_summary(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def briefing(request):
    params = request_params(request)
    return shifts_analytics.shifts_briefing(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def coverage(request):
    return shifts_analytics.shifts_coverage(resolve_scope(request_params(request)))


@md_get
def unassigned(request):
    params = request_params(request)
    return shifts_analytics.shifts_unassigned(resolve_scope(params), limit=params.get("limit"))


@md_get
def watch(request):
    params = request_params(request)
    return shifts_analytics.shifts_watch(resolve_scope(params), days=params.get("days"), limit=params.get("limit"))


@md_get
def changes(request):
    params = request_params(request)
    return shifts_analytics.shifts_changes(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def attendance(request):
    params = request_params(request)
    return shifts_analytics.shifts_attendance(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


@md_get
def attention(request):
    params = request_params(request)
    return shifts_analytics.shifts_attention(resolve_scope(params), resolve_period(params, default=DEFAULT_PERIOD))


urlpatterns = [
    path("summary", summary),
    path("briefing", briefing),
    path("coverage", coverage),
    path("unassigned", unassigned),
    path("watch", watch),
    path("changes", changes),
    path("attendance", attendance),
    path("attention", attention),
]
