"""GET /api/tracking/live/alerts: the log of the automatic On-Duty tracking alerts (geo_tracking/alerts.py) for HR.

  query   status = open | all (default all)   days = 1..31 (default 7, ignored for open)   kind = one alert kind
          employee = an employee id            page / pageSize (at most 100)
  answer  {results: [alerts.alert_json], total, page, pageSize, open, openByKind: {kind: n}, kinds: [{key, label}],
           settings: {alertsEnabled, debounceMinutes, hodEnabled, hodGraceMinutes, cooldownMinutes}}

Branch-scoped like the Live Map (the track's branch). The URL sits under tracking/live, so it is the Live Map tab's
(permission_tree.py: geo_attendance.live_map) - the tab where HR follows who is on duty now.
"""

from __future__ import annotations

from datetime import timedelta

from django.db.models import Count
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..auth import require_hr
from ..branch_scope import scope_to_branch
from ..models import GeoTrackingAlert
from ..view_common import error_response as _error
from . import alerts
from . import settings as geo_settings
from .parsing import parse_int

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 25


@api_view(["GET"])
@require_hr
def tracking_alerts(request: Request) -> Response:
    q = request.query_params
    s = geo_settings.get()
    base = scope_to_branch(GeoTrackingAlert.objects.all(), request, field="track__branch_id")
    status = (q.get("status") or "all").strip().lower()
    if status not in ("open", "all"):
        return _error("status must be open or all")
    qs = base
    if status == "open":
        qs = qs.filter(resolved_at__isnull=True)
    else:
        days = parse_int(q.get("days"), lo=1, hi=31) or 7
        qs = qs.filter(detected_at__gte=timezone.now() - timedelta(days=days))
    kind = (q.get("kind") or "").strip()
    if kind:
        if kind not in alerts.KIND_LABELS:
            return _error("Unknown alert kind")
        qs = qs.filter(kind=kind)
    employee = parse_int(q.get("employee"), lo=1)
    if q.get("employee") and employee is None:
        return _error("employee must be an employee id")
    if employee:
        qs = qs.filter(employee_id=employee)
    page = parse_int(q.get("page"), lo=1) or 1
    size = min(parse_int(q.get("pageSize") or q.get("page_size"), lo=1) or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    total = qs.count()
    rows = list(
        qs.select_related(
            "employee__department",
            "track__session",
            "hod",
            "employee_notification",
            "employee_whatsapp_log",
            "hod_notification",
            "hod_whatsapp_log",
        )
        # never the employees' photos (base64 data URLs): no row shows them
        .defer("employee__photo_url", "hod__photo_url")
        .order_by("-detected_at", "-id")[(page - 1) * size : page * size]
    )
    open_by_kind = dict(
        base.filter(resolved_at__isnull=True).values_list("kind").annotate(n=Count("id")).values_list("kind", "n")
    )
    return Response(
        {
            "results": [alerts.alert_json(a, s) for a in rows],
            "total": total,
            "page": page,
            "pageSize": size,
            "open": sum(open_by_kind.values()),
            "openByKind": open_by_kind,
            "kinds": [{"key": k, "label": label} for k, label in GeoTrackingAlert.KIND_CHOICES],
            "settings": {
                "alertsEnabled": s.alerts_enabled,
                "debounceMinutes": s.alert_debounce_minutes,
                "hodEnabled": s.alert_hod_enabled,
                "hodGraceMinutes": s.alert_hod_grace_minutes,
                "cooldownMinutes": s.alert_cooldown_minutes,
            },
        }
    )
