import json
from django.db import connection, OperationalError
from django.http import JsonResponse


class DatabaseHealthMiddleware:
    """Return a professional maintenance response when the database is offline."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Skip DB check for static files and health endpoint
        if request.path.startswith("/static/") or request.path == "/api/healthz":
            return self.get_response(request)

        try:
            connection.ensure_connection()
        except OperationalError:
            return JsonResponse(
                {
                    "error": "database_unavailable",
                    "message": (
                        "Database server is currently unavailable. "
                        "Data cannot be retrieved at the moment. "
                        "Please contact the system administration team and refresh "
                        "the application once the database server is available."
                    ),
                    "code": 503,
                },
                status=503,
            )

        return self.get_response(request)
