"""Departments and Designations pages: the aggregated figures and the people behind them.

Read-only endpoints that answer, in one request each, what the two pages used to assemble from many:

  GET /api/departments/overview           every department with its active headcount split into staff and production
  GET /api/departments/<id>/employees     the people of one department (for the page's detail drawer)
  GET /api/designations/tree              every designation and department with branch, level and headcount, so the
                                          page can draw Branch -> Department -> Designation
  GET /api/designations/<id>/employees    the people holding one designation

They sit under the existing "departments" / "designations" URL prefixes, so permission_registry.URL_MODULE_MAP already
gates them exactly like the list and write endpoints (module employees.departments / employees.designations: view is
enough to read). Branch isolation follows the Employees list, not the department: a branch-scoped HR login counts the
employees whose OWN branch is theirs (scope_to_branch(Employee)), and only sees the departments / designations of
that branch. Active means status == "active"; every other status counts as inactive and is reported apart.
"""

from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Branch, Department, Designation, Employee, ManagerDepartmentAssignment
from .view_common import _error

_ACTIVE = Q(status="active")


def _employee_counts(request: Request, fk: str) -> dict[int, dict]:
    """Per department (fk="department_id") or designation (fk="designation_id"): the employees the requester may see.

    activeStaff / activeProduction / activeOther are the active employees by employment type (other: a type that is
    neither, which the form does not offer but an old import could have left); inactive is everyone not active."""
    # One GROUP BY with a COUNT(*) FILTER per figure, not a query (or a join) per figure.
    rows = (
        scope_to_branch(Employee.objects, request)
        .filter(**{f"{fk}__isnull": False})
        .order_by()
        .values(fk)
        .annotate(
            staff=Count("id", filter=_ACTIVE & Q(employment_type="staff")),
            production=Count("id", filter=_ACTIVE & Q(employment_type="production")),
            active=Count("id", filter=_ACTIVE),
            inactive=Count("id", filter=~_ACTIVE),
        )
    )
    out: dict[int, dict] = {}
    for r in rows:
        out[r[fk]] = {
            "activeStaff": r["staff"],
            "activeProduction": r["production"],
            "activeOther": r["active"] - r["staff"] - r["production"],
            "active": r["active"],
            "inactive": r["inactive"],
        }
    return out


_NO_EMPLOYEES = {"activeStaff": 0, "activeProduction": 0, "activeOther": 0, "active": 0, "inactive": 0}


def _unassigned_totals(request: Request, fk: str) -> dict:
    """Active employees (by type) that have no department / designation at all (fk is "department" or "designation"),
    for the stat cards."""
    row = (
        scope_to_branch(Employee.objects, request)
        .filter(**{f"{fk}__isnull": True})
        .aggregate(
            staff=Count("id", filter=_ACTIVE & Q(employment_type="staff")),
            production=Count("id", filter=_ACTIVE & Q(employment_type="production")),
            active=Count("id", filter=_ACTIVE),
        )
    )
    return {"active": row["active"], "staff": row["staff"], "production": row["production"]}


def _person(e: Employee) -> dict:
    return {
        "id": e.id,
        "employeeCode": e.employee_code,
        "name": f"{e.first_name} {e.last_name}".strip(),
        "designationId": e.designation_id,
        "designationTitle": e.designation.title if e.designation_id else None,
        "departmentId": e.department_id,
        "departmentName": e.department.name if e.department_id else None,
        "employmentType": e.employment_type,
        "status": e.status,
    }


def _people_response(request: Request, qs, head: dict) -> Response:
    """The employees of one department / designation: light rows (no pay, no photo), every status, active first."""
    people = list(
        scope_to_branch(qs, request)
        .select_related("department", "designation")
        .order_by("first_name", "last_name", "id")
    )
    people.sort(key=lambda e: e.status != "active")  # stable: active first, names within each group
    return Response({**head, "employees": [_person(e) for e in people]})


@api_view(["GET"])
@require_hr
def departments_overview(request: Request) -> Response:
    depts = list(scope_to_branch(Department.objects, request).select_related("branch").order_by("name", "id"))
    counts = _employee_counts(request, "department_id")
    ids = [d.id for d in depts]
    designations = {
        r["department_id"]: r["n"]
        for r in Designation.objects.filter(department_id__in=ids)
        .order_by()
        .values("department_id")
        .annotate(n=Count("id"))
    }
    # Active heads of department: the delete warning says how many HOD assignments go with the department.
    heads = {
        r["department_id"]: r["n"]
        for r in ManagerDepartmentAssignment.objects.filter(department_id__in=ids, manager__is_active=True)
        .order_by()
        .values("department_id")
        .annotate(n=Count("manager_id", distinct=True))
    }

    rows = []
    for d in depts:
        c = counts.get(d.id, _NO_EMPLOYEES)
        rows.append(
            {
                "id": d.id,
                "name": d.name,
                "description": d.description,
                "branchId": d.branch_id,
                "branchName": d.branch.name if d.branch_id else None,
                "designationCount": designations.get(d.id, 0),
                "hodCount": heads.get(d.id, 0),
                "createdAt": d.created_at.isoformat() if d.created_at else None,
                **c,
            }
        )

    branch_ids = {d.branch_id for d in depts if d.branch_id}
    branches = Branch.objects.filter(Q(is_active=True) | Q(pk__in=branch_ids))
    branches = scope_to_branch(branches, request, field="id").order_by("name")
    return Response(
        {
            "departments": rows,
            "branches": [{"id": b.id, "name": b.name} for b in branches],
            "unassigned": _unassigned_totals(request, "department"),
        }
    )


@api_view(["GET"])
@require_hr
def department_employees(request: Request, pk: int) -> Response:
    try:
        dept = scope_to_branch(Department.objects, request).select_related("branch").get(pk=pk)
    except Department.DoesNotExist:
        return _error("Department not found", 404)
    head = {
        "department": {
            "id": dept.id,
            "name": dept.name,
            "branchId": dept.branch_id,
            "branchName": dept.branch.name if dept.branch_id else None,
        }
    }
    return _people_response(request, Employee.objects.filter(department_id=dept.id), head)


@api_view(["GET"])
@require_hr
def designations_tree(request: Request) -> Response:
    depts = list(scope_to_branch(Department.objects, request).select_related("branch").order_by("name", "id"))
    desigs = list(
        scope_to_branch(
            Designation.objects.select_related("department", "department__branch"),
            request,
            field="department__branch_id",
        ).order_by("title", "id")
    )
    counts = _employee_counts(request, "designation_id")
    dept_counts = _employee_counts(request, "department_id")

    designation_rows = []
    for d in desigs:
        c = counts.get(d.id, _NO_EMPLOYEES)
        dept = d.department
        designation_rows.append(
            {
                "id": d.id,
                "title": d.title,
                "level": d.level,
                "departmentId": d.department_id,
                "departmentName": dept.name if dept else None,
                "branchId": dept.branch_id if dept else None,
                "branchName": dept.branch.name if dept and dept.branch_id else None,
                "createdAt": d.created_at.isoformat() if d.created_at else None,
                **c,
            }
        )

    department_rows = []
    for d in depts:
        c = dept_counts.get(d.id, _NO_EMPLOYEES)
        department_rows.append(
            {
                "id": d.id,
                "name": d.name,
                "branchId": d.branch_id,
                "branchName": d.branch.name if d.branch_id else None,
                "active": c["active"],
            }
        )

    branch_ids = {d.branch_id for d in depts if d.branch_id}
    branches = Branch.objects.filter(Q(is_active=True) | Q(pk__in=branch_ids))
    branches = scope_to_branch(branches, request, field="id").order_by("name")
    return Response(
        {
            "designations": designation_rows,
            "departments": department_rows,
            "branches": [{"id": b.id, "name": b.name} for b in branches],
            "unassigned": _unassigned_totals(request, "designation"),
        }
    )


@api_view(["GET"])
@require_hr
def designation_employees(request: Request, pk: int) -> Response:
    try:
        desig = scope_to_branch(
            Designation.objects.select_related("department", "department__branch"),
            request,
            field="department__branch_id",
        ).get(pk=pk)
    except Designation.DoesNotExist:
        return _error("Designation not found", 404)
    dept = desig.department
    head = {
        "designation": {
            "id": desig.id,
            "title": desig.title,
            "level": desig.level,
            "departmentId": desig.department_id,
            "departmentName": dept.name if dept else None,
            "branchName": dept.branch.name if dept and dept.branch_id else None,
        }
    }
    return _people_response(request, Employee.objects.filter(designation_id=desig.id), head)
