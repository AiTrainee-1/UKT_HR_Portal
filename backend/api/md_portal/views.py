"""REST views of the MD portal. Every view is behind @require_md (the account flagged HRUser.is_md) and READ-ONLY:
nothing here writes company data."""

from django.db.models import Count
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..auth import require_md
from ..clock import ist_now
from ..models import Branch, Department, Employee
from .common import cached, md_get
from .pages import MD_PAGES


@api_view(["GET"])
@require_md
def md_me(request: Request) -> Response:
    """Who the MD is, the portal's pages and the server's clock (the greeting uses the factory's time, not the browser's)."""
    u = request.md_user
    return Response(
        {
            "id": u.id,
            "username": u.username,
            "name": u.full_name or u.username,
            "assignedAt": u.md_assigned_at.isoformat() if u.md_assigned_at else None,
            "serverTime": ist_now().isoformat(),
            "pages": MD_PAGES,
        }
    )


@cached(120)
def org_structure() -> dict:
    """Units and departments with their ACTIVE headcount: what the filter bars offer. A department name that exists in
    several units is listed once per unit (the filters group them by name)."""
    headcount = dict(
        Employee.objects.filter(status="active", department_id__isnull=False)
        .values_list("department_id")
        .annotate(n=Count("id"))
    )
    branches = [
        {"id": b.id, "name": b.name, "isHeadOffice": b.is_head_office, "isActive": b.is_active}
        for b in Branch.objects.order_by("-is_head_office", "name")
    ]
    departments = [
        {
            "id": d.id,
            "name": d.name,
            "branchId": d.branch_id,
            "branchName": d.branch.name if d.branch_id else None,
            "employees": headcount.get(d.id, 0),
        }
        for d in Department.objects.select_related("branch").order_by("name", "branch__name")
    ]
    return {"branches": branches, "departments": departments}


@md_get
def md_org(request: Request) -> dict:
    return org_structure()
