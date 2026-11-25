"""
"My Insights" on the mobile Home page (owner 2026-11-25). Employee token only, the signed-in employee's own data only,
READ-ONLY.

    GET /api/my/analytics?months=6     the last N calendar months (1-12, default 6), oldest first

What each figure is and where it is stored: mobile_analytics.py.
"""

from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, require_auth
from .clock import ist_today
from .mobile_analytics import DEFAULT_MONTHS, MAX_MONTHS, analytics_for
from .models import Employee


@api_view(["GET"])
@require_auth
def my_analytics(request: Request) -> Response:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return Response({"error": "Please sign in as an employee to see this."}, status=403)
    # The photo (a data URL, sometimes MBs) is never needed here.
    emp = Employee.objects.defer("photo_url").filter(pk=emp_id).first()
    if emp is None:
        return Response({"error": "Employee not found"}, status=404)
    raw = (request.query_params.get("months") or "").strip()
    months = DEFAULT_MONTHS
    if raw:
        if not raw.isdigit() or not (1 <= int(raw) <= MAX_MONTHS):
            return Response({"error": f"months must be a whole number from 1 to {MAX_MONTHS}"}, status=400)
        months = int(raw)
    return Response(analytics_for(emp, months, ist_today()))
