"""Employee list/detail/create/update/delete, photo, status and location tracking."""

from .audit_utils import log_action
from .auth import get_token_employee_id, is_hr, require_auth, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Department, Employee
from .serializers import employee_json, parse_decimal
from .view_common import _error
from django.db.models import Q, TextField, Value
from django.db.models.functions import Concat
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Employees ---


def _employee_queryset():
    return Employee.objects.select_related(
        "department", "designation", "branch", "reporting_manager", "reporting_manager__designation"
    )


def _serialize_employee(emp: Employee) -> dict:
    dept_name = emp.department.name if emp.department_id and emp.department else None
    return employee_json(emp, dept_name)


def _serialize_employee_for_list(emp: Employee) -> dict:
    """Same as _serialize_employee, except a photo stored as an embedded
    base64 data: URI is replaced with a lightweight link to /photo.

    This is the actual fix for "opening Employees fetches every photo at
    once": one employee's photo alone was ~43KB of base64 sitting inline in
    every single row of the list response, downloaded whether or not that
    row was ever scrolled into view. A normal external URL (the common case
    -most employees have none, and this field also accepts a plain link) is
    left untouched, since it's already a cheap string with nothing to fetch
    eagerly.

    Deliberately NOT applied to _serialize_employee / the single-employee
    detail endpoint: EditEmployee.tsx loads a record via that endpoint,
    keeps whatever `photoUrl` it received in form state, and resubmits it
    unchanged on save if the user doesn't touch the photo. Substituting the
    value there would mean an unrelated edit silently overwriting the stored
    photo with an API link instead of the original picture.
    """
    row = _serialize_employee(emp)
    photo = row.get("photoUrl")
    if isinstance(photo, str) and photo.startswith("data:"):
        row["photoUrl"] = f"/api/employees/{emp.id}/photo"
    return row


@api_view(["GET"])
@require_auth
def employee_photo(request: Request, pk: int) -> Response:
    """GET /api/employees/<id>/photo -the lazy-loaded counterpart to the
    data: URI _serialize_employee_for_list replaces in list responses.

    @require_auth (not @require_hr) because an employee token must reach
    this too, to view their own photo -it only rejects requests with no
    valid token at all, and populates request.jwt_user so the manual checks
    below (which _employee_get uses the same way) have something to read.

    Same access rule as _employee_get: an employee token may fetch only its
    own photo; HR must be branch-scoped to the employee. Only ever has
    something to serve when photo_url is a data: URI -a plain external URL
    employee record has nothing here to stream, since the browser already
    loads it directly from wherever it actually lives.
    """
    token_emp_id = get_token_employee_id(request)
    if token_emp_id is not None and token_emp_id != pk:
        return _error("Not found", 404)
    if token_emp_id is None and not is_hr(request):
        return _error("Authentication required", 401)

    emp = scope_to_branch(Employee.objects, request).filter(pk=pk).first()
    if not emp or not emp.photo_url or not emp.photo_url.startswith("data:"):
        return _error("Not found", 404)

    import base64

    try:
        header, encoded = emp.photo_url.split(",", 1)
        # "data:image/jpeg;base64" -> "image/jpeg"
        content_type = header.split(":", 1)[1].split(";", 1)[0] or "application/octet-stream"
        raw = base64.b64decode(encoded)
    except Exception:
        return _error("Stored photo is corrupted", 500)

    from django.http import HttpResponse

    response = HttpResponse(raw, content_type=content_type)
    # Employee photos change rarely; this only shaves repeat page-loads for
    # the same browser session, it never affects what a fresh fetch sees.
    response["Cache-Control"] = "private, max-age=3600"
    return response


@api_view(["GET", "POST"])
def employees(request: Request) -> Response:
    if request.method == "GET":
        # HR only. This returns the full staff directory -43 fields per
        # person including salaryAmount, bankAccount, pfNumber and phone -so
        # require_auth was far too weak: ANY signed-in employee could pull
        # every colleague's pay and bank details from the mobile app. No
        # employee-facing client calls this endpoint; they use
        # /api/employees/<id> for their own record instead.
        return require_hr(_employees_list)(request)
    return require_hr(_employees_create)(request)


def _employees_list(request: Request) -> Response:
    qs = _employee_queryset()
    qs = scope_to_branch(qs, request)
    dept_id = request.query_params.get("departmentId")
    desig_id = request.query_params.get("designationId")
    branch_id = request.query_params.get("branchId")
    emp_status = request.query_params.get("status")
    salary_type = request.query_params.get("salaryType")
    employment_type = request.query_params.get("employmentType")
    search = request.query_params.get("search", "").strip()
    if dept_id:
        qs = qs.filter(department_id=int(dept_id))
    if desig_id:
        qs = qs.filter(designation_id=int(desig_id))
    if branch_id:
        qs = qs.filter(branch_id=int(branch_id))
    if emp_status:
        qs = qs.filter(status=emp_status)
    if salary_type:
        qs = qs.filter(salary_type=salary_type)
    if employment_type:
        qs = qs.filter(employment_type=employment_type)
    if search:
        # Name was missing here, so "search by name or employee code" -which is
        # what every caller's placeholder promises -returned nothing for a
        # name. full_name is annotated rather than OR-ing first/last, so
        # "john smith" matches across the space; searching either part alone
        # still works via the individual fields.
        qs = qs.annotate(
            # output_field is required: first_name is a CharField and
            # last_name a TextField, and Concat refuses to guess across
            # mixed types (FieldError at query time, not import time).
            full_name=Concat("first_name", Value(" "), "last_name", output_field=TextField())
        ).filter(
            Q(employee_code__icontains=search)
            | Q(phone__icontains=search)
            | Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(full_name__icontains=search)
        )

    # countOnly=1 -just a number (e.g. the "Inactive" badge), never the rows.
    # The old behavior fetched every inactive employee's full record,
    # photo included, purely to read `.length` off the result -this replaces
    # that with a single COUNT query.
    if request.query_params.get("countOnly") in ("1", "true"):
        return Response({"count": qs.count()})

    page = request.query_params.get("page")
    if page is None:
        # No `page` param: identical to every response this endpoint has
        # ever returned -a bare array. Existing callers that don't yet know
        # about pagination are completely unaffected.
        return Response([_serialize_employee(e) for e in qs])

    try:
        page_num = max(1, int(page))
        page_size = max(1, min(200, int(request.query_params.get("pageSize", 20))))
    except (TypeError, ValueError):
        return _error("page and pageSize must be numbers")

    # Aggregate counts describe the FULL filtered set (before pagination
    # slices it), so the staff/production tally badges stay accurate however
    # many pages exist -matching what the client-side .filter() used to
    # compute over the whole fetched array.
    total = qs.count()
    staff_count = qs.filter(employment_type="staff").count()
    production_count = qs.filter(employment_type="production").count()

    start = (page_num - 1) * page_size
    page_qs = qs.order_by("id")[start:start + page_size]
    return Response({
        "results": [_serialize_employee_for_list(e) for e in page_qs],
        "count": total,
        "staffCount": staff_count,
        "productionCount": production_count,
        "page": page_num,
        "pageSize": page_size,
    })


def _assign_unit_code(branch_id: int | None) -> str | None:
    """
    Next "<branch code>-<n>" identifier for a branch, e.g. HO-1, HO-2,
    Unit1-1 -atomically incremented (select_for_update, inside a
    transaction) so two concurrent requests can never be handed the same
    number, and a number is never reused even after the employee holding it
    is later deleted or moved to a different branch. None if the employee
    has no branch, or that branch has no code set yet.
    """
    if branch_id is None:
        return None

    from django.db import transaction
    from .models import Branch

    with transaction.atomic():
        branch = Branch.objects.select_for_update().filter(pk=branch_id).first()
        if branch is None or not branch.code:
            return None
        branch.next_employee_seq += 1
        branch.save(update_fields=["next_employee_seq"])
        return f"{branch.code}-{branch.next_employee_seq}"


def _resolve_employee_relations(data: dict, request: Request) -> tuple[dict, list[str]]:
    """
    Resolve department/designation/branch from either an <field>Id (int FK —
    what the Add Employee dropdowns send) or a plain <field> name string
    (what the bulk-upload Excel importer sends). Returns (kwargs, warnings)
    where kwargs has department/designation/branch_id ready for
    Employee.objects.create(), and warnings are non-fatal notes about names
    that couldn't be matched (the row/request still succeeds).
    """
    from .models import Branch, Designation as _Desig

    warnings: list[str] = []

    # Branch is resolved FIRST because the department lookup depends on it:
    # department names are unique per branch, not globally, so "CUTTING"
    # means a different row in each unit.
    scoped_branch_id = get_branch_scope(request)
    if scoped_branch_id is not None:
        branch_id = scoped_branch_id
    elif data.get("branchId"):
        branch_id = int(data["branchId"])
    elif str(data.get("branch") or "").strip():
        branch_name = str(data["branch"]).strip()
        b = Branch.objects.filter(name__iexact=branch_name).first()
        branch_id = b.id if b else None
        if b is None:
            warnings.append(f"Branch '{branch_name}' not found -left unassigned")
    else:
        branch_id = None

    dept = None
    if data.get("departmentId"):
        dept = Department.objects.filter(pk=int(data["departmentId"])).first()
    elif str(data.get("department") or "").strip():
        dept_name = str(data["department"]).strip()
        # Prefer the department in THIS employee's branch. Falling back to a
        # name match in any branch keeps older single-branch imports working.
        dept = (
            Department.objects.filter(name__iexact=dept_name, branch_id=branch_id).first()
            if branch_id else None
        ) or Department.objects.filter(name__iexact=dept_name).first()
        if dept is None:
            # Created IN the employee's branch. Creating it branch-less
            # would hide the department, its designations and this employee
            # from every branch login.
            dept = Department.objects.create(name=dept_name, branch_id=branch_id)

    # A row that named no branch can still inherit one from the department
    # it landed in -that is a fact about the data, not a guess.
    if branch_id is None and dept is not None and dept.branch_id is not None:
        branch_id = dept.branch_id

    desig = None
    if data.get("designationId"):
        desig = _Desig.objects.filter(pk=int(data["designationId"])).first()
    elif str(data.get("designation") or "").strip():
        desig_title = str(data["designation"]).strip()
        desig_qs = _Desig.objects.filter(title__iexact=desig_title)
        desig = (desig_qs.filter(department=dept).first() if dept else None) or desig_qs.first()
        if desig is None:
            warnings.append(f"Designation '{desig_title}' not found -left blank")

    # branch_id was resolved above, before the department lookup.
    return {"department": dept, "designation": desig, "branch_id": branch_id}, warnings


def _create_employee_from_data(
    data: dict, request: Request, strict: bool = True,
) -> tuple[Employee | None, str | None, list[str]]:
    """
    Create one Employee from a plain camelCase dict -the shape shared by
    both the single Add Employee JSON body and one row of a bulk-upload
    Excel import. Returns (employee, error, warnings): error is a hard-fail
    reason (nothing created); warnings are non-fatal notes about fields that
    were skipped (e.g. an unmatched department/branch name).

    `strict` gates Last Name / Phone as required -on for the single Add
    Employee form, off for bulk upload (where only Employee Code and First
    Name are mandatory; Last Name and Phone may be filled in later).
    """
    employee_code = str(data.get("employeeCode") or "").strip()
    first_name = str(data.get("firstName") or "").strip()
    last_name = str(data.get("lastName") or "").strip()
    phone = str(data.get("phone") or "").strip()

    if not employee_code:
        return None, "Employee code is required", []
    if not first_name:
        return None, "First name is required", []
    if strict and not last_name:
        return None, "Last name is required", []
    if strict and not phone:
        return None, "Phone is required", []
    if Employee.objects.filter(employee_code=employee_code).exists():
        return None, f"Employee code '{employee_code}' already exists", []

    relations, warnings = _resolve_employee_relations(data, request)

    # An employee with no branch is invisible to EVERY branch login, and so
    # is every biometric punch they generate -it looks exactly like the
    # device has stopped syncing. A branch-scoped user always gets their own
    # branch here, so this only ever fires for an unscoped admin who left
    # the dropdown empty. Refusing is far kinder than the silent
    # disappearance it prevents.
    if relations["branch_id"] is None:
        return None, "Select a branch -an employee with no branch is hidden from every branch login", []

    unit_code = _assign_unit_code(relations["branch_id"])

    emp = Employee.objects.create(
        employee_code=employee_code,
        first_name=first_name,
        last_name=last_name,
        gender=data.get("gender") or None,
        date_of_birth=data.get("dateOfBirth") or None,
        email=data.get("email") or None,
        phone=phone,
        role=data.get("role") or None,
        employment_type=data.get("employmentType") or "staff",
        department=relations["department"],
        designation=relations["designation"],
        branch_id=relations["branch_id"],
        unit_code=unit_code,
        salary_type=data.get("salaryType") or "monthly",
        salary_amount=parse_decimal(data.get("salaryAmount")),
        salary_per_shift=parse_decimal(data.get("salaryPerShift")),
        bank_name=data.get("bankName") or None,
        bank_account=data.get("bankAccount") or None,
        bank_ifsc=data.get("bankIfsc") or None,
        pf_number=data.get("pfNumber") or None,
        esi_number=data.get("esiNumber") or None,
        id_proof=data.get("idProof") or None,
        address=data.get("address") or None,
        join_date=data.get("joinDate") or None,
        father_name=data.get("fatherName") or None,
        mother_name=data.get("motherName") or None,
        biometric_device_id=data.get("biometricDeviceId") or None,
        photo_url=data.get("photoUrl") or None,
        blood_group=data.get("bloodGroup") or None,
        emergency_contact=data.get("emergencyContact") or None,
    )
    from .shift_views import auto_assign_production_shift
    auto_assign_production_shift(emp)
    return emp, None, warnings


def _employees_create(request: Request) -> Response:
    emp, error, _warnings = _create_employee_from_data(request.data, request)
    if error:
        return _error(error)

    emp = _employee_queryset().get(pk=emp.pk)
    log_action(request, "create", "employees", record_id=emp.id,
               description=f"Created employee {emp.employee_code} -{emp.first_name} {emp.last_name}")
    return Response(_serialize_employee(emp), status=201)


@api_view(["GET", "PATCH", "DELETE"])
def employee_detail(request: Request, pk: int) -> Response:
    if request.method == "GET":
        return require_auth(_employee_get)(request, pk)
    if request.method == "PATCH":
        return require_hr(_employee_update)(request, pk)
    return require_hr(_employee_delete)(request, pk)


def _employee_get(request: Request, pk: int) -> Response:
    # An employee token may read ONE record: its own. The mobile app fetches
    # /api/employees/<own id> for the profile screen, which is the only
    # employee-facing use of this endpoint. Without this check any employee
    # could walk the id range and collect every colleague's salary, phone and
    # bank details one row at a time -the list endpoint being locked down
    # would have achieved nothing on its own.
    token_emp_id = get_token_employee_id(request)
    if token_emp_id is not None and token_emp_id != pk:
        # Same 404 as a genuinely missing row, so this cannot be used to
        # probe which employee ids exist.
        return _error("Employee not found", 404)

    emp = scope_to_branch(_employee_queryset(), request).filter(pk=pk).first()
    if not emp:
        return _error("Employee not found", 404)
    return Response(_serialize_employee(emp))


def _employee_update(request: Request, pk: int) -> Response:
    emp = scope_to_branch(_employee_queryset(), request).filter(pk=pk).first()
    if not emp:
        return _error("Employee not found", 404)

    original_branch_id = emp.branch_id

    # Handle department: prefer departmentId (int FK), fall back to name string
    if "departmentId" in request.data:
        raw = request.data.get("departmentId")
        emp.department_id = int(raw) if raw else None
    elif "department" in request.data:
        dept_name = request.data.get("department", "").strip()
        if dept_name:
            dept, _ = Department.objects.get_or_create(name=dept_name)
            emp.department = dept

    # Handle designation
    if "designationId" in request.data:
        raw = request.data.get("designationId")
        emp.designation_id = int(raw) if raw else None

    # Handle branch: a branch-scoped HR user can't move an employee to
    # another branch (their own branch_id wins regardless of payload).
    scoped_branch_id = get_branch_scope(request)
    if scoped_branch_id is not None:
        emp.branch_id = scoped_branch_id
    elif "branchId" in request.data:
        raw = request.data.get("branchId")
        emp.branch_id = int(raw) if raw else None
    if emp.branch_id is None:
        # Same reasoning as create -clearing a branch would hide the
        # employee and their punches from the unit that works with them.
        return _error("Select a branch -an employee with no branch is hidden from every branch login")

    if emp.branch_id != original_branch_id:
        # Moved to a different branch (or removed from one) -the old Unit
        # Code no longer describes them, so retire it and mint a fresh one
        # for the new branch (never touches the old branch's counter).
        emp.unit_code = _assign_unit_code(emp.branch_id)

    if "employeeCode" in request.data:
        new_code = (request.data["employeeCode"] or "").strip()
        if not new_code:
            return _error("Employee code is required")
        if Employee.objects.filter(employee_code=new_code).exclude(pk=pk).exists():
            return _error("Employee code already exists")
        emp.employee_code = new_code

    field_map = {
        "firstName": "first_name",
        "lastName": "last_name",
        "gender": "gender",
        "dateOfBirth": "date_of_birth",
        "email": "email",
        "phone": "phone",
        "role": "role",
        "employmentType": "employment_type",
        "salaryType": "salary_type",
        "salaryAmount": "salary_amount",
        "salaryPerShift": "salary_per_shift",
        "status": "status",
        "bankName": "bank_name",
        "bankAccount": "bank_account",
        "bankIfsc": "bank_ifsc",
        "idProof": "id_proof",
        "pfNumber": "pf_number",
        "esiNumber": "esi_number",
        "address": "address",
        "joinDate": "join_date",
        "fatherName": "father_name",
        "motherName": "mother_name",
        "biometricDeviceId": "biometric_device_id",
        "photoUrl": "photo_url",
        "bloodGroup": "blood_group",
        "emergencyContact": "emergency_contact",
        "locationTrackingEnabled": "location_tracking_enabled",
        "coEmpEnabled": "co_emp_enabled",
    }
    if "employmentType" in request.data:
        emp_type = request.data.get("employmentType")
        if emp_type not in (Employee.EMPLOYMENT_TYPE_STAFF, Employee.EMPLOYMENT_TYPE_PRODUCTION):
            return _error("employmentType must be 'staff' or 'production'")

    for json_key, model_key in field_map.items():
        if json_key in request.data:
            value = request.data[json_key]
            if model_key in ("salary_amount", "salary_per_shift"):
                value = parse_decimal(value)
            elif model_key == "date_of_birth":
                value = value or None
            setattr(emp, model_key, value)
    emp.save()
    # If employee type was changed to production, try to auto-assign a production shift
    if request.data.get("employmentType") == "production":
        from .shift_views import auto_assign_production_shift
        emp_fresh = Employee.objects.get(pk=pk)
        auto_assign_production_shift(emp_fresh)

    emp = _employee_queryset().get(pk=pk)
    log_action(request, "update", "employees", record_id=pk,
               description=f"Updated employee {emp.employee_code} -{emp.first_name} {emp.last_name}")
    return Response(_serialize_employee(emp))


def _employee_delete(request: Request, pk: int) -> Response:
    emp = scope_to_branch(Employee.objects, request).filter(id=pk).first()
    if not emp:
        return _error("Employee not found", 404)
    name = f"{emp.employee_code} -{emp.first_name} {emp.last_name}"
    emp.delete()
    log_action(request, "delete", "employees", record_id=pk, description=f"Deleted employee {name}")
    return Response({"message": "Employee deleted"})


@api_view(["PATCH"])
@require_hr
def employee_status(request: Request, pk: int) -> Response:
    emp = scope_to_branch(_employee_queryset(), request).filter(pk=pk).first()
    if not emp:
        return _error("Employee not found", 404)
    emp.status = request.data.get("status")
    emp.save(update_fields=["status", "updated_at"])
    return Response(_serialize_employee(emp))


@api_view(["PATCH"])
@require_hr
def bulk_location_tracking(request: Request) -> Response:
    """
    PATCH /api/employees/location-tracking/bulk
    Body: { enabled: bool, employeeIds?: number[] }
    Turns live location tracking on/off for many employees at once -powers
    the "Enable All" / "Disable All" buttons on the Tracking Settings tab.
    Without employeeIds, applies to every active employee in the caller's
    branch scope; with it, applies only to the given ids (still branch-scoped).
    """
    if "enabled" not in request.data:
        return _error("enabled is required")
    enabled = bool(request.data.get("enabled"))

    qs = scope_to_branch(Employee.objects, request).filter(status="active")
    employee_ids = request.data.get("employeeIds")
    if employee_ids:
        qs = qs.filter(pk__in=employee_ids)

    updated = qs.update(location_tracking_enabled=enabled)
    log_action(
        request, "update", "employees",
        description=f"Bulk {'enabled' if enabled else 'disabled'} live location tracking for {updated} employee(s)",
    )
    return Response({"updated": updated, "enabled": enabled})
