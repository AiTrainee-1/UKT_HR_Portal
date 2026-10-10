"""Manage Branch: the figures shown beside each branch (headcount, departments, unit-code counter).

One read-only endpoint, so the page does not have to download every employee record just to count them. It is gated
like the rest of /api/branches (module employees.branches, longest-prefix match in permission_registry), and an HR
login tied to one branch sees only that branch's row: the other branches are left out rather than shown as empty.
"""

from django.db.models import Count
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope
from .models import Branch, Department, Employee


def summarize_branches(branch_scope: int | None = None) -> dict:
    """{"branches": [one row per branch], "unassignedActive": active employees with no branch}.

    Each row: branchId, staffActive, productionActive, inactive, nextEmployeeSeq and the departments of the branch
    with their active headcount. Only active branches are listed (a deleted branch is only switched off)."""
    branches = Branch.objects.filter(is_active=True).order_by("name")
    employees = Employee.objects.all()
    departments = Department.objects.all()
    if branch_scope is not None:
        branches = branches.filter(pk=branch_scope)
        employees = employees.filter(branch_id=branch_scope)
        departments = departments.filter(branch_id=branch_scope)

    people: dict[int | None, dict[str, int]] = {}
    for row in employees.values("branch_id", "employment_type", "status").annotate(n=Count("id")):
        bucket = people.setdefault(row["branch_id"], {"staffActive": 0, "productionActive": 0, "inactive": 0})
        if row["status"] != "active":
            bucket["inactive"] += row["n"]
        elif row["employment_type"] == Employee.EMPLOYMENT_TYPE_PRODUCTION:
            bucket["productionActive"] += row["n"]
        else:
            bucket["staffActive"] += row["n"]

    active_in_department = {
        row["department_id"]: row["n"]
        for row in employees.filter(status="active", department_id__isnull=False)
        .values("department_id")
        .annotate(n=Count("id"))
    }
    by_branch: dict[int | None, list[dict]] = {}
    for d in departments.order_by("name"):
        by_branch.setdefault(d.branch_id, []).append(
            {"id": d.id, "name": d.name, "activeCount": active_in_department.get(d.id, 0)}
        )

    rows = []
    for b in branches:
        counts = people.get(b.id, {"staffActive": 0, "productionActive": 0, "inactive": 0})
        rows.append(
            {
                "branchId": b.id,
                **counts,
                "nextEmployeeSeq": b.next_employee_seq or 0,
                "departments": by_branch.get(b.id, []),
            }
        )
    unassigned = people.get(None, {}).get("staffActive", 0) + people.get(None, {}).get("productionActive", 0)
    return {"branches": rows, "unassignedActive": unassigned}


@api_view(["GET"])
@require_hr
def branches_summary(request: Request) -> Response:
    return Response(summarize_branches(get_branch_scope(request)))
