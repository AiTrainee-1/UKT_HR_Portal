"""Department list/create/delete."""

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Department
from .serializers import department_json
from .view_common import _error
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Departments ---


@api_view(["GET", "POST"])
@require_hr
def departments(request: Request) -> Response:
    if request.method == "GET":
        rows = (
            scope_to_branch(Department.objects, request)
            .annotate(
                employee_count=Count("employees", filter=Q(employees__status="active"))
            )
            .order_by("id")
            .values("id", "name", "description", "employee_count")
        )
        return Response(
            [
                department_json(
                    Department(id=r["id"], name=r["name"], description=r["description"]),
                    r["employee_count"],
                )
                for r in rows
            ]
        )
    wrapped = require_hr(_departments_create)
    return wrapped(request)


def _departments_create(request: Request) -> Response:
    # A branch-scoped HR user's own branch always wins, same convention used
    # for employee create/update -otherwise a department they create would
    # be invisible to them the moment the list is branch-scoped. Unscoped
    # users (super admin, branch-less roles) may pick one explicitly.
    scoped_branch_id = get_branch_scope(request)
    if scoped_branch_id is not None:
        branch_id = scoped_branch_id
    else:
        branch_id = request.data.get("branchId")
    # A branch-less department is invisible to every branch login, and it
    # then hides its designations and any employee filed under it.
    if branch_id is None:
        return Response(
            {"error": "Select a branch -a department with no branch is hidden from every branch login"},
            status=400,
        )
    dept = Department.objects.create(
        name=request.data.get("name"),
        description=request.data.get("description"),
        branch_id=branch_id,
    )
    return Response(department_json(dept, 0), status=201)


@api_view(["GET", "DELETE"])
@require_hr
def delete_department(request: Request, pk: int) -> Response:
    try:
        dept = scope_to_branch(Department.objects, request).get(pk=pk)
    except Department.DoesNotExist:
        return _error("Department not found", 404)

    if request.method == "GET":
        emp_count = dept.employees.filter(status="active").count()
        return Response(department_json(dept, emp_count))

    dept.delete()
    return Response({"message": "Department deleted"})
