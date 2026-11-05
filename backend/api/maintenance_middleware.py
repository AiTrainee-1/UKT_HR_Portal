import os

from django.conf import settings as dj_settings
from django.http import JsonResponse

_MAINTENANCE_MARKER = os.path.join(str(dj_settings.BASE_DIR), "maintenance.lock")

# Paths that must keep working even while a restore is in progress -the
# Settings page's own status poll (so it can show real progress), and the
# generic health check.
_EXEMPT_PATHS = {"/api/healthz", "/api/backup/restore/status"}


# A restore takes minutes. A marker older than this was left behind by a restore process that was killed before it
# could clean up (out of memory, a container stop): it is removed, so the application comes back by itself instead of
# answering "restoring" forever while the health check stays green (app health audit, 2026-11-05).
STALE_MARKER_SECONDS = 4 * 60 * 60


def _stale_marker() -> bool:
    import time

    try:
        age = time.time() - os.path.getmtime(_MAINTENANCE_MARKER)
    except OSError:
        return True  # removed in the meantime
    if age <= STALE_MARKER_SECONDS:
        return False
    try:
        os.remove(_MAINTENANCE_MARKER)
    except OSError:
        pass
    return True


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

        if os.path.exists(_MAINTENANCE_MARKER) and not _stale_marker():
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
