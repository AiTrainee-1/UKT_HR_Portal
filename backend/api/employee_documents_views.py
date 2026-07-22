"""
Employee Document Collection
=============================
Per-employee uploaded documents — PAN/Aadhaar/Educational Certificates/
Voter ID or Birth Certificate/Bank Passbook, plus scanned copies of Offer/
Experience/Resignation/Staff letters and Production Employee Documents.

Same conventions as the rest of this codebase: plain @api_view + @require_hr
(or @require_auth for the employee-facing routes) functions, no serializers/
viewsets, hand-built response dicts. File storage/serving mirrors the Resume
Screening feature's ScreeningCandidate.resume_file exactly — a plain
FileField, always served through an authenticated view (FileResponse +
Content-Disposition), never Django's raw MEDIA_URL. PAN/Aadhaar/Bank
Passbook are far more sensitive than a resume, so access is checked on
every single download: HR (branch-scoped) or the owning employee only.
"""
from django.core.files.base import ContentFile
from django.http import FileResponse
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, is_hr, require_auth, require_hr
from .branch_scope import scope_to_branch
from .models import Employee, EmployeeDocument

ALLOWED_EXTENSIONS = {"pdf", "jpg", "jpeg", "png"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10MB
VALID_CATEGORIES = {key for key, _ in EmployeeDocument.CATEGORY_CHOICES}

# "Required" documents for completion tracking — the 5 personal-ID categories
# every employee needs, plus one employment-type-specific letter category.
# Offer/Experience/Resignation Letter are excluded: those are auto-generated
# on demand elsewhere, never something HR uploads here.
_REQUIRED_COMMON = [
    EmployeeDocument.CATEGORY_PAN,
    EmployeeDocument.CATEGORY_AADHAAR,
    EmployeeDocument.CATEGORY_EDUCATION,
    EmployeeDocument.CATEGORY_VOTER_BIRTH,
    EmployeeDocument.CATEGORY_BANK_PASSBOOK,
]


def _required_categories(employment_type: str) -> list:
    extra = (
        EmployeeDocument.CATEGORY_PRODUCTION_DOCS
        if employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION
        else EmployeeDocument.CATEGORY_STAFF_LETTER
    )
    return _REQUIRED_COMMON + [extra]


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


def _document_json(doc: EmployeeDocument) -> dict:
    return {
        "id": doc.id,
        "employeeId": doc.employee_id,
        "category": doc.category,
        "categoryLabel": dict(EmployeeDocument.CATEGORY_CHOICES).get(doc.category, doc.category),
        "originalFilename": doc.original_filename,
        "uploadedBy": doc.uploaded_by,
        "uploadedAt": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
        "fileUrl": f"/api/employee-documents/{doc.id}/file",
    }


@api_view(["GET"])
@require_hr
def employee_documents(request: Request, employee_id: int) -> Response:
    """GET /api/recruitment/employee-documents/<employee_id> — every document for one employee."""
    emp = scope_to_branch(Employee.objects, request).filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)
    docs = EmployeeDocument.objects.filter(employee=emp)
    return Response([_document_json(d) for d in docs])


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def upload_employee_document(request: Request, employee_id: int) -> Response:
    """POST /api/recruitment/employee-documents/<employee_id>/upload — multipart, keys: file, category."""
    emp = scope_to_branch(Employee.objects, request).filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)

    file = request.FILES.get("file")
    category = request.data.get("category")
    if not file:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")
    if category not in VALID_CATEGORIES:
        return _error("Invalid or missing 'category'.")

    ext = file.name.rsplit(".", 1)[-1].lower() if "." in file.name else ""
    if ext not in ALLOWED_EXTENSIONS:
        return _error(f"Unsupported file type '.{ext}' — only PDF, JPG, and PNG are accepted.")
    if file.size > MAX_UPLOAD_BYTES:
        return _error(f"File is too large ({file.size / 1024 / 1024:.1f}MB) — the limit is 10MB.")

    uploaded_by = request.jwt_user.get("name") or request.jwt_user.get("username")
    doc = EmployeeDocument(employee=emp, category=category, original_filename=file.name, uploaded_by=uploaded_by)
    doc.file.save(file.name, ContentFile(file.read()), save=False)
    doc.save()
    return Response(_document_json(doc), status=201)


@api_view(["DELETE"])
@require_hr
def delete_employee_document(request: Request, pk: int) -> Response:
    """DELETE /api/employee-documents/<pk>"""
    doc = EmployeeDocument.objects.select_related("employee").filter(pk=pk).first()
    if not doc:
        return _error("Document not found", 404)
    if not scope_to_branch(Employee.objects, request).filter(pk=doc.employee_id).exists():
        return _error("Document not found", 404)
    doc.file.delete(save=False)
    doc.delete()
    return Response({"ok": True})


@api_view(["GET"])
@require_auth
def employee_document_file(request: Request, pk: int) -> Response:
    """
    GET /api/employee-documents/<pk>/file[?download=1]
    Accessible to: HR (branch-scoped to the document's employee) or the
    employee the document belongs to. Everyone else gets a 403 — this is
    the one check that matters most in this whole feature, given what
    these files usually contain (PAN/Aadhaar/bank details).
    """
    doc = EmployeeDocument.objects.select_related("employee").filter(pk=pk).first()
    if not doc or not doc.file:
        return _error("Document not found", 404)

    owner_employee_id = get_token_employee_id(request)
    if owner_employee_id == doc.employee_id:
        pass  # the employee viewing their own document
    elif is_hr(request):
        if not scope_to_branch(Employee.objects, request).filter(pk=doc.employee_id).exists():
            return _error("Access denied", 403)
    else:
        return _error("Access denied", 403)

    disposition = "attachment" if request.query_params.get("download") else "inline"
    response = FileResponse(doc.file.open("rb"))
    response["Content-Disposition"] = f'{disposition}; filename="{doc.original_filename}"'
    return response


@api_view(["GET"])
@require_hr
def document_completion_stats(request: Request) -> Response:
    """
    GET /api/recruitment/employee-documents/completion-stats?employmentType=staff|production
    Counts active employees (branch-scoped) as "uploaded" once they have at
    least one file in every required category for their employment type, or
    "pending" with the list of what's missing — powers the Documents page's
    dashboard cards and the Pending drill-down list.
    """
    employment_type = request.query_params.get("employmentType")
    if employment_type not in (Employee.EMPLOYMENT_TYPE_STAFF, Employee.EMPLOYMENT_TYPE_PRODUCTION):
        return _error("employmentType must be 'staff' or 'production'.")

    required = _required_categories(employment_type)
    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(employment_type=employment_type, status="active")
        .select_related("department")
        .order_by("first_name", "last_name")
    )

    docs_by_employee = {}
    doc_rows = EmployeeDocument.objects.filter(
        employee__in=employees, category__in=required
    ).values_list("employee_id", "category")
    for emp_id, category in doc_rows:
        docs_by_employee.setdefault(emp_id, set()).add(category)

    required_labels = dict(EmployeeDocument.CATEGORY_CHOICES)
    pending = []
    uploaded = []
    for emp in employees:
        present = docs_by_employee.get(emp.id, set())
        missing = [c for c in required if c not in present]
        base = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}".strip(),
            "departmentName": emp.department.name if emp.department_id else None,
        }
        if missing:
            pending.append({**base, "missingCategories": [{"value": c, "label": required_labels.get(c, c)} for c in missing]})
        else:
            uploaded.append(base)

    return Response({
        "totalCount": len(employees),
        "uploadedCount": len(uploaded),
        "pendingCount": len(pending),
        "uploadedEmployees": uploaded,
        "pendingEmployees": pending,
    })


@api_view(["GET"])
@require_auth
def my_documents(request: Request) -> Response:
    """GET /api/my/documents — the logged-in employee's own uploaded documents."""
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return _error("Employee access required", 403)
    docs = EmployeeDocument.objects.filter(employee_id=emp_id)
    return Response([_document_json(d) for d in docs])
