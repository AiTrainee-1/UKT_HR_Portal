import os

from django.conf import settings as dj_settings
from django.http import JsonResponse

_MAINTENANCE_MARKER = os.path.join(str(dj_settings.BASE_DIR), "maintenance.lock")

# Paths that must keep working even while a restore is in progress -the
# Settings page's own status poll (so it can show real progress), and the
# generic health check.
_EXEMPT_PATHS = {"/api/healthz", "/api/backup/restore/status"}


class MaintenanceModeMiddleware:
    """
    Returns the same 503 shape DatabaseHealthMiddleware already uses for
    "database unavailable" (the frontend's ConnectivityOverlay already
    treats that exact response as "show the reconnecting screen, poll until
    it clears") -so a restore-in-progress gets the same graceful full-app
    takeover with zero new frontend wiring. Runs before
    DatabaseHealthMiddleware so it takes precedence during the window before
    the database is actually dropped (file copies, subprocess startup),
    where the DB itself may still be transiently reachable.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path in _EXEMPT_PATHS or request.path.startswith("/static/"):
            return self.get_response(request)

        if os.path.exists(_MAINTENANCE_MARKER):
            return JsonResponse(
                {
                    "error": "database_unavailable",
                    "message": (
                        "The application is restoring from a backup and will be back "
                        "shortly. This page will reconnect automatically."
                    ),
                    "code": 503,
                },
                status=503,
            )

        return self.get_response(request)
