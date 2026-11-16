"""Department list/create/edit/delete, and setting an employee's department / designation from the two org pages."""

from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import org_category
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Branch, Department, Designation, Employee
from .serializers import department_json
from .view_common import _error


# --- Departments ---


def _name_taken(name: str, branch_id, category: str, exclude_pk=None) -> bool:
    """Another department of this branch and kind already carries the name (ignoring case: "Cutting" is "CUTTING")."""
    qs = Department.objects.filter(branch_id=branch_id, category=category, name__iexact=name)
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.exists()


def _taken_message(name: str, category: str) -> str:
    return f'A {org_category.label(category)} department called "{name}" already exists in this branch'


@api_view(["GET", "POST"])
@require_hr
def departments(request: Request) -> Response:
    if request.method == "GET":
        category, problem = org_category.query_category(request.query_params)
        if problem:
            return _error(problem)
        qs = scope_to_branch(Department.objects, request)
        if category:
            qs = qs.filter(category=category)
        rows = (
            qs.annotate(employee_count=Count("employees", filter=Q(employees__status="active")))
            .order_by("id")
            .values("id", "name", "description", "category", "branch_id", "branch__name", "employee_count")
        )
        return Response(
            [
                department_json(
                    Department(
                        id=r["id"],
                        name=r["name"],
                        description=r["description"],
                        category=r["category"],
                        branch_id=r["branch_id"],
                    ),
                    r["employee_count"],
                    branch_name=r["branch__name"],
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
    if branch_id in (None, ""):
        return Response(
            {"error": "Select a branch -a department with no branch is hidden from every branch login"},
            status=400,
        )
    try:
        branch_id = int(branch_id)
    except (TypeError, ValueError):
        return Response({"error": "Branch not found"}, status=400)
    name = " ".join(str(request.data.get("name") or "").split())
    if not name:
        return Response({"error": "Department name is required"}, status=400)
    # Staff or Production: the pages always send it; an older client that does not gets a Staff department, which is
    # what every department was before the two were separated.
    category, problem = org_category.body_category(request.data, default=org_category.STAFF)
    if problem:
        return Response({"error": problem}, status=400)
    if not Branch.objects.filter(pk=branch_id).exists():
        return Response({"error": "Branch not found"}, status=400)
    # The (name, branch, kind) triple is unique: say so, instead of letting the database constraint answer with a 500.
    if _name_taken(name, branch_id, category):
        return Response({"error": _taken_message(name, category)}, status=400)
    dept = Department.objects.create(
        name=name,
        description=(request.data.get("description") or "").strip() or None,
        branch_id=branch_id,
        category=category,
    )
    return Response(department_json(dept, 0), status=201)


@api_view(["GET", "PUT", "PATCH", "DELETE"])
@require_hr
def delete_department(request: Request, pk: int) -> Response:
    try:
        dept = scope_to_branch(Department.objects, request).get(pk=pk)
    except Department.DoesNotExist:
        return _error("Department not found", 404)

    if request.method == "GET":
        emp_count = dept.employees.filter(status="active").count()
        return Response(department_json(dept, emp_count))

    if request.method in ("PUT", "PATCH"):
        # Name, description and (while it is empty) Staff / Production: moving a department to another branch would
        # silently re-home its designations and change which branch logins can see it.
        data = request.data
        name = dept.name
        if "name" in data:
            name = " ".join(str(data.get("name") or "").split())
            if not name:
                return Response({"error": "Department name is required"}, status=400)
        category, problem = org_category.body_category(data, default=dept.category)
        if problem:
            return Response({"error": problem}, status=400)
        problem = org_category.department_change_problem(dept, category)
        if problem:
            return Response({"error": problem}, status=400)
        if (name.lower() != dept.name.lower() or category != dept.category) and _name_taken(
            name, dept.branch_id, category, exclude_pk=dept.pk
        ):
            return Response({"error": _taken_message(name, category)}, status=400)
        with transaction.atomic():
            if category != dept.category:
                # Its designations (nobody holds any: department_change_problem) are of its kind, so they go along.
                Designation.objects.filter(department_id=dept.id).update(category=category)
            dept.name = name
            dept.category = category
            if "description" in data:
                dept.description = (data.get("description") or "").strip() or None
            dept.save()
        return Response(department_json(dept, dept.employees.filter(status="active").count()))

    dept.delete()
    return Response({"message": "Department deleted"})


# --- Assigning people from the Departments / Designations pages ---


def _target_id(raw):
    """An id from a request body: an int, None for "none", or False when it is not a number."""
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return False


@api_view(["POST"])
@require_hr
def assign_department(request: Request) -> Response:
    """POST /api/departments/assign {employeeId, departmentId|null}: set (or clear) one employee's department.

    The Departments page's Assign / Remove and its Find & assign tab. Lives under "departments" so the page's own
    permission (employees.departments, edit) is what it takes, not the whole Employees module, and it changes nothing
    but the department (the designation stays, as it always did). The department must be of the employee's kind
    (org_category.py)."""
    emp_id = _target_id(request.data.get("employeeId"))
    dept_id = _target_id(request.data.get("departmentId"))
    if not emp_id or dept_id is False:
        return _error("employeeId and departmentId must be numbers")
    emp = scope_to_branch(Employee.objects, request).filter(pk=emp_id).first()
    if emp is None:
        return _error("Employee not found", 404)
    dept = None
    if dept_id is not None:
        dept = scope_to_branch(Department.objects, request).filter(pk=dept_id).first()
        if dept is None:
            return _error("Department not found", 404)
        problem = org_category.department_mismatch(dept, emp.employment_type)
        if problem:
            return _error(problem)
    emp.department = dept
    emp.save(update_fields=["department", "updated_at"])
    name = f"{emp.first_name} {emp.last_name}".strip()
    what = f"to {dept.name} ({org_category.label(dept.category)})" if dept else "out of their department"
    log_action(request, "update", "employees", record_id=emp.id, description=f"Moved {emp.employee_code} -{name} {what}")
    return Response({"id": emp.id, "departmentId": emp.department_id, "departmentName": dept.name if dept else None})


@api_view(["POST"])
@require_hr
def assign_designation(request: Request) -> Response:
    """POST /api/designations/assign {employeeId, designationId|null}: set (or clear) one employee's designation.

    The Designations page's counterpart of assign_department (permission employees.designations, edit). The designation
    must be of the employee's kind; it does not move the employee to the designation's department."""
    emp_id = _target_id(request.data.get("employeeId"))
    desig_id = _target_id(request.data.get("designationId"))
    if not emp_id or desig_id is False:
        return _error("employeeId and designationId must be numbers")
    emp = scope_to_branch(Employee.objects, request).filter(pk=emp_id).first()
    if emp is None:
        return _error("Employee not found", 404)
    desig = None
    if desig_id is not None:
        desig = (
            scope_to_branch(Designation.objects.select_related("department"), request, field="department__branch_id")
            .filter(pk=desig_id)
            .first()
        )
        if desig is None:
            return _error("Designation not found", 404)
        problem = org_category.designation_mismatch(desig, emp.employment_type)
        if problem:
            return _error(problem)
    emp.designation = desig
    emp.save(update_fields=["designation", "updated_at"])
    name = f"{emp.first_name} {emp.last_name}".strip()
    log_action(
        request,
        "update",
        "employees",
        record_id=emp.id,
        description=f"Set designation of {emp.employee_code} -{name} to {desig.title}"
        if desig
        else f"Cleared the designation of {emp.employee_code} -{name}",
    )
    return Response(
        {
            "id": emp.id,
            "designationId": emp.designation_id,
            "designationTitle": desig.title if desig else None,
            "departmentId": emp.department_id,
        }
    )
