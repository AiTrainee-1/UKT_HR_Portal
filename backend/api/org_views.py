from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import org_category
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Branch, Designation, Department


def branch_json(b):
    return {
        "id": b.id,
        "name": b.name,
        "code": b.code,
        "location": b.location,
        "address": b.address,
        "managerName": b.manager_name,
        "phone": b.phone,
        "isHeadOffice": b.is_head_office,
        "isActive": b.is_active,
        "geofenceLat": float(b.geofence_lat) if b.geofence_lat is not None else None,
        "geofenceLng": float(b.geofence_lng) if b.geofence_lng is not None else None,
        "geofenceRadiusM": b.geofence_radius_m,
        "createdAt": b.created_at.isoformat() if b.created_at else None,
    }


def designation_json(d, employee_count: int | None = None):
    data = {
        "id": d.id,
        "title": d.title,
        "departmentId": d.department_id,
        "departmentName": d.department.name if d.department else None,
        "level": d.level,
        # Staff or Production (org_category.py): its department's, or its own when it has none.
        "category": d.category,
        "branchId": d.department.branch_id if d.department else None,
        "createdAt": d.created_at.isoformat() if d.created_at else None,
    }
    if employee_count is not None:
        data["employeeCount"] = employee_count
    return data


# ── Branches ──────────────────────────────────────────────────────────────────

def _clean_branch_code(value):
    """A branch code is unique, so a blank one is stored as NULL (two "" codes would collide)."""
    value = (value or "").strip() if isinstance(value, str) or value is None else str(value).strip()
    return value or None


@api_view(["GET", "POST"])
@require_hr
def branches(request: Request) -> Response:
    if request.method == "GET":
        qs = Branch.objects.filter(is_active=True).order_by("name")
        return Response([branch_json(b) for b in qs])

    data = request.data
    if not data.get("name"):
        return Response({"error": "name is required"}, status=400)

    code = _clean_branch_code(data.get("code"))
    if code and Branch.objects.filter(code=code).exists():
        return Response({"error": f"Branch code {code} is already used (a deleted branch keeps its code)"}, status=400)

    is_head_office = bool(data.get("isHeadOffice"))
    if is_head_office:
        Branch.objects.filter(is_head_office=True).update(is_head_office=False)

    b = Branch.objects.create(
        name=data["name"],
        code=code,
        location=data.get("location"),
        address=data.get("address"),
        manager_name=data.get("managerName"),
        phone=data.get("phone"),
        is_head_office=is_head_office,
        geofence_lat=data.get("geofenceLat") or None,
        geofence_lng=data.get("geofenceLng") or None,
        geofence_radius_m=data.get("geofenceRadiusM") or 200,
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
        if "code" in data:
            code = _clean_branch_code(data.get("code"))
            if code and Branch.objects.filter(code=code).exclude(pk=b.pk).exists():
                return Response(
                    {"error": f"Branch code {code} is already used (a deleted branch keeps its code)"}, status=400
                )
        if data.get("isHeadOffice"):
            Branch.objects.filter(is_head_office=True).exclude(pk=b.pk).update(is_head_office=False)
        for field, attr in [
            ("name", "name"), ("code", "code"), ("location", "location"), ("address", "address"),
            ("managerName", "manager_name"), ("phone", "phone"),
            ("isHeadOffice", "is_head_office"), ("isActive", "is_active"),
            ("geofenceLat", "geofence_lat"), ("geofenceLng", "geofence_lng"),
            ("geofenceRadiusM", "geofence_radius_m"),
        ]:
            if field in data:
                setattr(b, attr, _clean_branch_code(data[field]) if field == "code" else data[field])
        b.save()
        return Response(branch_json(b))

    b.is_active = False
    b.save()
    return Response(status=204)


# ── Designations ──────────────────────────────────────────────────────────────


def _clean_title(value) -> str:
    """A designation title with surrounding and repeated spaces removed (" Sr.  Tailor " is "Sr. Tailor")."""
    return " ".join(str(value if value is not None else "").split())


def _department_for(request: Request, raw):
    """The department a designation is filed under, from a body's departmentId: (department or None, error response).

    Scoped to the requester's branch (a branch login can only use its own departments); a value that is not a number
    or names no department the requester can see is a plain 404, never a 500."""
    if raw in (None, ""):
        return None, None
    try:
        dept_id = int(raw)
    except (TypeError, ValueError):
        return None, Response({"error": "Department not found"}, status=404)
    dept = scope_to_branch(Department.objects, request).filter(pk=dept_id).first()
    if dept is None:
        return None, Response({"error": "Department not found"}, status=404)
    return dept, None


def _title_taken(title: str, dept, category: str, exclude_pk=None) -> bool:
    """Another designation of the same department (or, with none, of no department and the same kind) has the title."""
    qs = Designation.objects.filter(title__iexact=title)
    qs = qs.filter(department_id=dept.id) if dept is not None else qs.filter(department__isnull=True, category=category)
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.exists()


def _title_taken_message(title: str, dept, category: str) -> str:
    where = f'in "{dept.name}"' if dept is not None else f"among {org_category.label(category)} designations"
    return f'A designation called "{title}" already exists {where}'


@api_view(["GET", "POST"])
@require_hr
def designations(request: Request) -> Response:
    if request.method == "GET":
        dept_id = request.query_params.get("departmentId")
        category, problem = org_category.query_category(request.query_params)
        if problem:
            return Response({"error": problem}, status=400)
        qs = Designation.objects.select_related("department").annotate(
            employee_count=Count("employees", filter=Q(employees__status="active"))
        ).order_by("title")
        # Designation has no branch of its own -it inherits one from its
        # department. A designation with no department therefore belongs to
        # no branch and is admin-only, which is the strict-isolation rule
        # applied consistently rather than a special case for this page.
        qs = scope_to_branch(qs, request, field="department__branch_id")
        if dept_id:
            try:
                qs = qs.filter(department_id=int(dept_id))
            except (TypeError, ValueError):
                return Response({"error": "departmentId must be a number"}, status=400)
        if category:
            qs = qs.filter(category=category)
        return Response([designation_json(d, d.employee_count) for d in qs])

    data = request.data
    title = _clean_title(data.get("title"))
    if not title:
        return Response({"error": "title is required"}, status=400)

    dept, refused = _department_for(request, data.get("departmentId"))
    if refused:
        return refused
    # A branch user may only file a designation under one of their own
    # departments -otherwise they could plant a row in another branch that
    # they then cannot see, and that branch never asked for.
    if dept is None and get_branch_scope(request) is not None:
        return Response({"error": "Select a department -a designation must belong to one"}, status=400)

    # Staff or Production: always its department's; one with no department takes what was sent (Staff for an older
    # client that sends nothing).
    requested, problem = org_category.body_category(data, default=org_category.STAFF)
    if problem:
        return Response({"error": problem}, status=400)
    category = dept.category if dept is not None else requested
    if _title_taken(title, dept, category):
        return Response({"error": _title_taken_message(title, dept, category)}, status=400)

    d = Designation.objects.create(
        title=title,
        department=dept,
        level=data.get("level") or "staff",
        category=category,
    )
    return Response(designation_json(d), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def designation_detail(request: Request, pk: int) -> Response:
    try:
        d = scope_to_branch(
            Designation.objects.select_related("department"),
            request, field="department__branch_id",
        ).get(pk=pk)
    except Designation.DoesNotExist:
        # Scoped out and genuinely missing are the same 404 on purpose -a
        # different message would confirm the row exists in another branch.
        return Response({"error": "Designation not found"}, status=404)

    if request.method == "GET":
        emp_count = d.employees.filter(status="active").count()
        return Response(designation_json(d, emp_count))

    if request.method == "PUT":
        data = request.data
        title = d.title
        if "title" in data:
            title = _clean_title(data.get("title"))
            if not title:
                return Response({"error": "title is required"}, status=400)
        dept = d.department
        if "departmentId" in data:
            dept, refused = _department_for(request, data.get("departmentId"))
            if refused:
                return refused
            # Same rule as create: a branch user may only keep a designation under one of their own departments.
            if dept is None and get_branch_scope(request) is not None:
                return Response({"error": "Select a department -a designation must belong to one"}, status=400)
        requested, problem = org_category.body_category(data, default=d.category)
        if problem:
            return Response({"error": problem}, status=400)
        category = dept.category if dept is not None else requested
        problem = org_category.designation_change_problem(d, category)
        if problem:
            return Response({"error": problem}, status=400)
        if _title_taken(title, dept, category, exclude_pk=d.pk):
            return Response({"error": _title_taken_message(title, dept, category)}, status=400)
        d.title = title
        d.department = dept
        d.category = category
        if "level" in data:
            d.level = data.get("level") or "staff"
        d.save()
        emp_count = d.employees.filter(status="active").count()
        return Response(designation_json(d, emp_count))

    d.delete()
    return Response(status=204)
