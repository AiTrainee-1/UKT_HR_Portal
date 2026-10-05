"""MD portal: dashboard routes (mounted at /api/md/dashboard/). Views are thin: every one is an @md_get function that
reads the optional ?branch= scope and returns a function of analytics/dashboard.py.

  GET overview   the first screen: up to 8 cards, the merged exceptions, the briefing, today by unit, which pages answered
  GET trends     the three charts (attendance 30 days, payroll 12 months with people paid, joiners against leavers),
                 separate so the page can paint the overview first
  GET briefing   the briefing, the top exceptions and the cards in one answer (what "brief me" needs); ?limit= exceptions

The Dashboard has no period of its own: each figure keeps the window its page uses (see the provenance). ``branch``
narrows the trends and today's count by unit; the cards, exceptions and briefing stay company-wide and the response
says so in ``notes``.
"""

from django.urls import path

from ..analytics import dashboard as dashboard_analytics
from ..common import MdParamError, md_get, request_params, resolve_scope


def _scope(params: dict):
    """The unit asked for (id or name, small typos forgiven); department and type are not Dashboard filters."""
    return resolve_scope({k: params[k] for k in ("branch", "branchId") if params.get(k)})


def _limit(params: dict, default: int = 5) -> int:
    raw = params.get("limit")
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw))
    except ValueError:
        raise MdParamError(f"'limit' must be a whole number, got '{raw}'.") from None
    return max(1, min(dashboard_analytics.MAX_INSIGHTS, value))


@md_get
def overview(request):
    return dashboard_analytics.overview(scope=_scope(request_params(request)))


@md_get
def trends(request):
    return dashboard_analytics.trends(scope=_scope(request_params(request)))


@md_get
def briefing(request):
    params = request_params(request)
    return dashboard_analytics.briefing(scope=_scope(params), limit=_limit(params))


urlpatterns = [
    path("overview", overview),
    path("trends", trends),
    path("briefing", briefing),
]
