from django.db.models import Count
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import Branch, Designation, Department


def branch_json(b):
    return {
        "id": b.id,
        "name": b.name,
        "location": b.location,
        "address": b.address,
        "managerName": b.manager_name,
        "phone": b.phone,
        "isActive": b.is_active,
        "createdAt": b.created_at.isoformat() if b.created_at else None,
    }


def designation_json(d, employee_count: int | None = None):
    data = {
        "id": d.id,
        "title": d.title,
        "departmentId": d.department_id,
        "departmentName": d.department.name if d.department else None,
        "level": d.level,
        "createdAt": d.created_at.isoformat() if d.created_at else None,
    }
    if employee_count is not None:
        data["employeeCount"] = employee_count
    return data


# ── Branches ──────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def branches(request: Request) -> Response:
    if request.method == "GET":
        qs = Branch.objects.filter(is_active=True).order_by("name")
        return Response([branch_json(b) for b in qs])

    data = request.data
    if not data.get("name"):
        return Response({"error": "name is required"}, status=400)

    b = Branch.objects.create(
        name=data["name"],
        location=data.get("location"),
        address=data.get("address"),
        manager_name=data.get("managerName"),
        phone=data.get("phone"),
    )
    return Response(branch_json(b), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def branch_detail(request: Request, pk: int) -> Response:
    try:
        b = Branch.objects.get(pk=pk)
    except Branch.DoesNotExist:
        return Response({"error": "Branch not found"}, status=404)

    if request.method == "GET":
        return Response(branch_json(b))

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("location", "location"), ("address", "address"),
            ("managerName", "manager_name"), ("phone", "phone"), ("isActive", "is_active"),
        ]:
            if field in data:
                setattr(b, attr, data[field])
        b.save()
        return Response(branch_json(b))

    b.is_active = False
    b.save()
    return Response(status=204)


# ── Designations ──────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def designations(request: Request) -> Response:
    if request.method == "GET":
        dept_id = request.query_params.get("departmentId")
        qs = Designation.objects.select_related("department").annotate(
            employee_count=Count("employees")
        ).order_by("title")
        if dept_id:
            qs = qs.filter(department_id=dept_id)
        return Response([designation_json(d, d.employee_count) for d in qs])

    data = request.data
    if not data.get("title"):
        return Response({"error": "title is required"}, status=400)

    d = Designation.objects.create(
        title=data["title"],
        department_id=data.get("departmentId"),
        level=data.get("level", "staff"),
    )
    return Response(designation_json(d), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def designation_detail(request: Request, pk: int) -> Response:
    try:
        d = Designation.objects.select_related("department").get(pk=pk)
    except Designation.DoesNotExist:
        return Response({"error": "Designation not found"}, status=404)

    if request.method == "GET":
        emp_count = d.employees.count()
        return Response(designation_json(d, emp_count))

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("title", "title"), ("departmentId", "department_id"), ("level", "level"),
        ]:
            if field in data:
                setattr(d, attr, data[field])
        d.save()
        emp_count = d.employees.count()
        return Response(designation_json(d, emp_count))

    d.delete()
    return Response(status=204)
