"""Helpers shared across the view modules (error responses, employee-name lookup)."""

from django.db.models import QuerySet
from rest_framework.response import Response

from .models import Employee
from .serializers import employee_full_name


def error_response(message: str, code: int = 400) -> Response:
    """The API's one error shape: {"error": "..."} plus a status code."""
    return Response({"error": message}, status=code)


_error = error_response


# ---------------------------------------------------------------------------
#  List pagination
# ---------------------------------------------------------------------------

# A list endpoint called with no paging params keeps returning the bare array
# every existing client (HR portal, mobile app, Employee Web App) already
# expects -but never more than DEFAULT_LIST_CAP rows of it, so a table that
# grows without bound can't turn one GET into a full-table dump. When the cap
# bites, the response carries `X-Truncated: true`.
DEFAULT_LIST_CAP = 2000
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500


def paginate(request, rows, serialize, *, cap: int = DEFAULT_LIST_CAP) -> Response:
    """Serialize `rows` (an ORDERED queryset or list) with default pagination.

    - no `page` param  -> bare array of at most `cap` items (legacy shape).
    - `?page=N&pageSize=M` -> {"items", "total", "page", "pageSize"}, the shape
      the outpass/reception/tea-break lists already use. pageSize defaults to
      DEFAULT_PAGE_SIZE and is clamped to MAX_PAGE_SIZE.
    """
    page = request.query_params.get("page")
    if page is None:
        window = list(rows[: cap + 1])
        response = Response([serialize(r) for r in window[:cap]])
        if len(window) > cap:
            response["X-Truncated"] = "true"
        return response

    try:
        page_num = max(1, int(page))
        page_size = max(1, min(MAX_PAGE_SIZE, int(request.query_params.get("pageSize", DEFAULT_PAGE_SIZE))))
    except TypeError, ValueError:
        return error_response("page and pageSize must be numbers")

    total = rows.count() if isinstance(rows, QuerySet) else len(rows)
    start = (page_num - 1) * page_size
    return Response(
        {
            "items": [serialize(r) for r in rows[start : start + page_size]],
            "total": total,
            "page": page_num,
            "pageSize": page_size,
        }
    )


def _employee_name(emp_id: int) -> str | None:
    emp = Employee.objects.filter(id=emp_id).first()
    return employee_full_name(emp) if emp else None
