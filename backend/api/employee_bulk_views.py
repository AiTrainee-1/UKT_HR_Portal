"""Bulk employee upload (create) and bulk update from an Excel template.

Two kinds of employee have their own sheet layout (Staff: monthly salary + the 50/50 split; Production: pay per shift),
and every upload can be CHECKED first (`mode=preview`: the whole file is processed inside a transaction that is rolled
back, so the report is exactly what an import would do, with nothing written). Every response carries a per-row report
(`rows`) and tallies (`counts`) next to the older summary fields (`created`, `failed`, `errors`, ...).

Updating the existing employees of one kind (`category` + `employeeStatus`) can also deal with the people who are NOT in
the uploaded file: they are listed (`missing`), and each one is left alone, made Inactive, or deleted with all their
data, only as the caller explicitly says. Nothing is ever removed on its own.
"""

import io
import json
import logging

from django.db import transaction
from django.db.models import Count

from . import salary_split
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .employee_views import _assign_unit_code, _create_employee_from_data, _employee_queryset
from .models import Department
from .serializers import parse_decimal
from .view_common import _error
from datetime import date, datetime
from decimal import Decimal
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

logger = logging.getLogger(__name__)


# --- Sheet layouts ---
#
# Column order/text is the enforced contract with the downloaded templates: keep this in sync with
# frontend/src/pages/hr/bulk-upload/config.ts if either ever changes.
#
# The eight salary-split columns (Basic ... CA) come after Salary Amount. The COMBINED layout (both kinds in one sheet,
# with an Employment Type column) is what the page used to download: it is still accepted, and so is the one from before
# the split columns existed, whose rows get the automatic 50% + 50% split like any row that leaves the split blank.
LEGACY_UPLOAD_HEADERS = [
    "Employee Code",
    "First Name",
    "Last Name",
    "Email",
    "Phone",
    "Gender",
    "Date of Birth",
    "Employment Type",
    "Department",
    "Designation",
    "Branch",
    "Salary Type",
    "Salary Amount",
    "Salary Per Shift",
    "Join Date",
    "Bank Name",
    "Bank Account",
    "Bank IFSC",
    "PF Number",
    "ESI Number",
    "Address",
    "ID Proof",
    "Father's Name",
    "Mother's Name",
    "Biometric Device ID",
    "Blood Group",
    "Emergency Contact",
]
# Column header -> salary_split component, in the order they appear in the sheet.
SPLIT_COLUMNS = {salary_split.LABELS[c]: c for c in salary_split.COMPONENTS}
SPLIT_HEADERS = list(SPLIT_COLUMNS)
EMPLOYEE_UPLOAD_HEADERS = LEGACY_UPLOAD_HEADERS + SPLIT_HEADERS

STATUS_HEADER = "Status"
_COMMON_HEAD = [
    "Employee Code",
    "First Name",
    "Last Name",
    "Email",
    "Phone",
    "Gender",
    "Date of Birth",
    "Department",
    "Designation",
    "Branch",
    "Join Date",
]
_COMMON_TAIL = [
    "Bank Name",
    "Bank Account",
    "Bank IFSC",
    "PF Number",
    "ESI Number",
    "Address",
    "ID Proof",
    "Father's Name",
    "Mother's Name",
    "Biometric Device ID",
    "Blood Group",
    "Emergency Contact",
]
STAFF_UPLOAD_HEADERS = _COMMON_HEAD + ["Salary Type", "Salary Amount"] + SPLIT_HEADERS + _COMMON_TAIL
PRODUCTION_UPLOAD_HEADERS = _COMMON_HEAD + ["Salary Per Shift"] + _COMMON_TAIL

# layout name -> header row. The "*_export" layouts are what "Download current employees" writes: the same columns plus
# a trailing Status (Active / Inactive) so an employee can be made Inactive, or active again, from the sheet.
_LAYOUTS: dict[str, list[str]] = {
    "staff": STAFF_UPLOAD_HEADERS,
    "production": PRODUCTION_UPLOAD_HEADERS,
    "staff_export": STAFF_UPLOAD_HEADERS + [STATUS_HEADER],
    "production_export": PRODUCTION_UPLOAD_HEADERS + [STATUS_HEADER],
    "legacy": EMPLOYEE_UPLOAD_HEADERS,
    "legacy_old": LEGACY_UPLOAD_HEADERS,
}
_ACCEPTED_HEADER_ROWS = (EMPLOYEE_UPLOAD_HEADERS, LEGACY_UPLOAD_HEADERS)  # kept for callers that imported it

CATEGORIES = ("staff", "production")
CATEGORY_LABEL = {"staff": "Staff", "production": "Production"}

_VALID_EMPLOYMENT_TYPES = {"staff", "production"}
_VALID_SALARY_TYPES = {"monthly", "weekly"}
_VALID_GENDERS = {"male", "female", "other"}
_VALID_STATUSES = {"active", "inactive"}

# Row outcomes, in the order the page lists them.
ROW_STATUSES = ("created", "updated", "unchanged", "duplicate", "invalid", "failed", "skipped", "not_found")


def _text(value) -> str:
    """A cell as the text it shows. Excel turns a code or a phone number into a NUMBER when it is converted or retyped
    (2950 -> 2950.0 once it has gone through a float), and a whole number must read the same either way."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _parse_date_cell(value):
    if value is None or str(value).strip() == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raw = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return raw  # unparseable -let Django's own validation reject it with its own message


def _split_cell(value) -> str:
    """One salary-split cell as text for salary_split.parse_breakup: blank is 0, and a spreadsheet number (or a
    formula result such as 2083.3333333333335) is rounded to the paisa."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return "0"
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float, Decimal)):
        return str(Decimal(str(value)).quantize(Decimal("0.01")))
    return str(value).strip()


def _split_from_row(row: dict) -> dict | None:
    """The salary split typed into a sheet row ({basic, da, ...} as parse_breakup expects), or None when all eight
    cells are blank (the split is then worked out automatically). Blank cells in a partly filled split count as 0."""
    if all(row.get(h) is None or str(row.get(h)).strip() == "" for h in SPLIT_HEADERS):
        return None
    return {salary_split.JSON_KEYS[c]: _split_cell(row.get(h)) for h, c in SPLIT_COLUMNS.items()}


def _employee_row_to_data(row: dict, category: str | None = None) -> tuple[dict, str | None]:
    """Normalize one raw Excel row (header -> cell value) into the camelCase
    dict _create_employee_from_data expects. Returns (data, error) -error is
    set when a restricted-choice column (Employment Type/Salary Type/Gender)
    holds something other than one of its known values or blank. With a
    `category` the employee is of that kind whatever the sheet says (a sheet
    that still has an Employment Type column must agree with it)."""

    def cell(key: str) -> str:
        v = row.get(key)
        return _text(v)

    def num_cell(key: str):
        v = row.get(key)
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return None
        return v

    emp_type = cell("Employment Type").lower()
    if emp_type and emp_type not in _VALID_EMPLOYMENT_TYPES:
        return {}, f"Employment Type must be Staff or Production, got '{cell('Employment Type')}'"
    if category and emp_type and emp_type != category:
        return {}, (
            f"This row is a {CATEGORY_LABEL[emp_type]} employee but you are uploading {CATEGORY_LABEL[category]} "
            f"employees. Put it in the {CATEGORY_LABEL[emp_type]} section instead"
        )

    salary_type = cell("Salary Type").lower()
    if salary_type and salary_type not in _VALID_SALARY_TYPES:
        return {}, f"Salary Type must be Monthly or Weekly, got '{cell('Salary Type')}'"

    gender = cell("Gender").lower()
    if gender and gender not in _VALID_GENDERS:
        return {}, f"Gender must be Male, Female or Other, got '{cell('Gender')}'"

    return {
        "employeeCode": cell("Employee Code"),
        "firstName": cell("First Name"),
        "lastName": cell("Last Name"),
        "email": cell("Email") or None,
        "phone": cell("Phone"),
        "gender": gender or None,
        "dateOfBirth": _parse_date_cell(row.get("Date of Birth")),
        "employmentType": category or emp_type or None,
        "department": cell("Department") or None,
        "designation": cell("Designation") or None,
        "branch": cell("Branch") or None,
        "salaryType": salary_type or None,
        "salaryAmount": num_cell("Salary Amount"),
        "salaryBreakup": _split_from_row(row),
        "salaryPerShift": num_cell("Salary Per Shift"),
        "joinDate": _parse_date_cell(row.get("Join Date")),
        "bankName": cell("Bank Name") or None,
        "bankAccount": cell("Bank Account") or None,
        "bankIfsc": cell("Bank IFSC") or None,
        "pfNumber": cell("PF Number") or None,
        "esiNumber": cell("ESI Number") or None,
        "address": cell("Address") or None,
        "idProof": cell("ID Proof") or None,
        "fatherName": cell("Father's Name") or None,
        "motherName": cell("Mother's Name") or None,
        "biometricDeviceId": cell("Biometric Device ID") or None,
        "bloodGroup": cell("Blood Group") or None,
        "emergencyContact": cell("Emergency Contact") or None,
    }, None


# --- shared plumbing ---


def _normalize_header(c) -> str:
    # The downloaded template marks required columns as "Employee Code *"
    # for the user's benefit -strip that trailing marker back off before
    # comparing, so an unmodified official template always validates.
    h = str(c).strip() if c is not None else ""
    return h[:-1].rstrip() if h.endswith("*") else h


def _read_sheet(request: Request):
    """(rows, header_row, layout, error_response): the first sheet of the uploaded workbook, its normalized header, and
    which of the known layouts that header is (None when it is none of them)."""
    file = request.FILES.get("file")
    if not file:
        return None, None, None, _error("No file uploaded. Send as multipart/form-data with key 'file'.")
    try:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(file.read()), data_only=True)
        rows = list(wb.active.iter_rows(values_only=True))
    except Exception as e:
        return None, None, None, _error(f"Failed to read the Excel file: {e}")
    if not rows:
        return None, None, None, _error("The uploaded file is empty.")
    header_row = [_normalize_header(c) for c in rows[0]]
    while header_row and header_row[-1] == "":
        header_row.pop()
    layout = next((name for name, headers in _LAYOUTS.items() if header_row == headers), None)
    return rows, header_row, layout, None


def _invalid_template(message: str) -> Response:
    return Response({"error": "invalid_template", "message": message}, status=400)


def _layout_problem(layout: str | None, category: str | None, default_message: str) -> str | None:
    """Why this sheet cannot be used for `category` (None when it can)."""
    if layout is None:
        return default_message
    if category is None or layout.startswith("legacy"):
        return None
    if layout.startswith(category):
        return None
    other = "production" if category == "staff" else "staff"
    return (
        f"This is the {CATEGORY_LABEL[other]} sheet, but you are uploading {CATEGORY_LABEL[category]} employees. "
        f"Switch to {CATEGORY_LABEL[other]}, or download the {CATEGORY_LABEL[category]} template."
    )


def _option(request: Request, name: str, allowed: tuple | set, default=None):
    """A form option restricted to `allowed` values, or the default when it is not sent. Raises ValueError when wrong."""
    value = request.data.get(name)
    if value in (None, ""):
        return default
    value = str(value).strip().lower()
    if value not in allowed:
        raise ValueError(f"'{name}' must be one of: {', '.join(sorted(allowed))}")
    return value


def _is_blank(raw_row) -> bool:
    return not raw_row or all(c is None or str(c).strip() == "" for c in raw_row)


def _row_report(row_no: int, code: str, name: str, status: str, messages=None, warnings=None, changes=None) -> dict:
    return {
        "row": row_no,
        "code": code,
        "name": name,
        "status": status,
        "messages": messages or [],
        "warnings": warnings or [],
        "changes": changes or [],
    }


def _name_of(row: dict) -> str:
    def cell(key):
        v = row.get(key)
        return _text(v)

    return f"{cell('First Name')} {cell('Last Name')}".strip()


def _counts(reports: list[dict], **extra) -> dict:
    out = {s: 0 for s in ROW_STATUSES}
    for r in reports:
        out[r["status"]] += 1
    out["notFound"] = out.pop("not_found")
    out.update(extra)
    return out


def _scope_text(category: str | None, employee_status: str | None) -> str:
    if not category:
        return ""
    return f"{CATEGORY_LABEL[category]} {'inactive' if employee_status == 'inactive' else 'active'} employees"


# --- Bulk employee upload ---


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def bulk_upload_employees(request: Request) -> Response:
    """Create employees from a sheet. Options (multipart fields next to `file`): `category` = staff | production (the
    kind of employee in the sheet; without it the sheet is the older combined one), `mode` = preview | apply (preview
    processes everything and writes nothing)."""
    try:
        category = _option(request, "category", CATEGORIES)
        mode = _option(request, "mode", {"preview", "apply"}, "apply")
    except ValueError as exc:
        return _error(str(exc))

    rows, header_row, layout, failure = _read_sheet(request)
    if failure:
        return failure
    problem = _layout_problem(
        layout,
        category,
        "Invalid template. Please upload the employee data using the official template provided by the system.",
    )
    if problem:
        return _invalid_template(problem)

    preview = mode == "preview"
    reports: list[dict] = []
    seen: dict[str, int] = {}
    visible = scope_to_branch(_employee_queryset(), request)

    with transaction.atomic():
        for idx, raw_row in enumerate(rows[1:], start=2):
            if _is_blank(raw_row):
                continue  # fully blank rows are not records
            code = _text(raw_row[0])
            row = dict(zip(header_row, raw_row))
            name = _name_of(row)
            if code.upper().startswith("SAMPLE"):
                # Reference rows shipped in the downloaded template -never imported,
                # even if the user forgets to delete them before uploading.
                reports.append(
                    _row_report(idx, code, name, "skipped", ["Sample row from the template: never imported"])
                )
                continue
            if code and code in seen:
                reports.append(
                    _row_report(
                        idx, code, name, "duplicate", [f"Employee code '{code}' is repeated: first on row {seen[code]}"]
                    )
                )
                continue
            if code:
                seen[code] = idx

            data, row_error = _employee_row_to_data(row, category)
            if row_error:
                reports.append(_row_report(idx, code, name, "invalid", [row_error]))
                continue

            existing = visible.filter(employee_code=code).first() if code else None
            if existing is not None:
                where = f"{existing.employment_type.title()}, {'Active' if existing.status == 'active' else 'Inactive'}"
                reports.append(
                    _row_report(
                        idx,
                        code,
                        name,
                        "duplicate",
                        [
                            f"Employee code '{code}' already exists ({existing.first_name} {existing.last_name}, {where})"
                        ],
                    )
                )
                continue

            try:
                with transaction.atomic():
                    emp, error, row_warnings = _create_employee_from_data(data, request, strict=False)
            except Exception:
                logger.exception("Bulk upload: row %s (%s) failed unexpectedly", idx, code)
                reports.append(
                    _row_report(
                        idx,
                        code,
                        name,
                        "failed",
                        ["Unexpected error while saving this row. Nothing was created for it"],
                    )
                )
                continue
            if error:
                status = "duplicate" if "already exists" in error else "invalid"
                reports.append(_row_report(idx, code, name, status, [error]))
                continue

            warnings = list(row_warnings)
            kind = data.get("employmentType") or "staff"
            if kind == "production" and not data.get("salaryPerShift"):
                warnings.append("Salary Per Shift is blank: payroll skips this employee until it is set")
            if kind == "staff" and not data.get("salaryAmount"):
                warnings.append("Salary Amount is blank: payroll skips this employee until it is set")
            reports.append(
                _row_report(
                    idx, emp.employee_code, f"{emp.first_name} {emp.last_name}".strip(), "created", warnings=warnings
                )
            )
            log_action(
                request,
                "create",
                "employees",
                record_id=emp.id,
                description=f"Bulk-imported employee {emp.employee_code} -{emp.first_name} {emp.last_name}",
            )

        if preview:
            transaction.set_rollback(True)

    counts = _counts(reports)
    created = counts["created"]
    problems = [r for r in reports if r["status"] in ("duplicate", "invalid", "failed")]
    errors = [f"Row {r['row']}: {r['messages'][0]}" for r in problems]
    warnings = [f"Row {r['row']}: {w}" for r in reports for w in r["warnings"]]
    if preview:
        message = f"Checked the file: {created} employee(s) can be imported." + (
            f" {len(problems)} row(s) need attention." if problems else ""
        )
    else:
        message = f"Imported {created} employee(s)." + (f" {len(problems)} row(s) failed." if problems else "")

    return Response(
        {
            "message": message,
            "preview": preview,
            "category": category,
            "created": created,
            "failed": len(problems),
            "sampleRowsSkipped": counts["skipped"],
            "errors": errors,
            "warnings": warnings,
            "counts": counts,
            "rows": reports,
        },
        status=200 if preview else 201,
    )


# --- Bulk employee update (existing employees, matched by Employee Code) ---

# Fields the Excel updater may change, as (header, model attr) pairs. Employee
# Code is deliberately absent -it's the match key, so this flow can never
# rename it. Department/Designation/Branch are handled separately (FK
# resolution), as are the choice-validated columns.
_UPDATE_TEXT_FIELDS = {
    "First Name": "first_name",
    "Last Name": "last_name",
    "Email": "email",
    "Phone": "phone",
    "Bank Name": "bank_name",
    "Bank Account": "bank_account",
    "Bank IFSC": "bank_ifsc",
    "PF Number": "pf_number",
    "ESI Number": "esi_number",
    "Address": "address",
    "ID Proof": "id_proof",
    "Father's Name": "father_name",
    "Mother's Name": "mother_name",
    "Biometric Device ID": "biometric_device_id",
    "Blood Group": "blood_group",
    "Emergency Contact": "emergency_contact",
}


def _apply_row_updates(emp, row: dict, request: Request) -> tuple[list[str], list[str], str | None]:
    """
    Apply one Excel row's non-blank cells onto an existing Employee, writing
    only values that actually differ. Blank cells always mean "leave as is" —
    this flow exists to fill gaps and fix mistakes, so an empty cell must
    never wipe stored data. Returns (changed_field_labels, warnings, error).
    Nothing is saved here; the caller saves when changes is non-empty.
    """
    from .models import Branch, Designation as _Desig

    changed: list[str] = []
    warnings: list[str] = []

    def cell(key: str) -> str:
        v = row.get(key)
        return _text(v)

    # Choice-validated columns -a bad value fails the whole row rather than
    # silently skipping, so typos get fixed instead of ignored.
    gender = cell("Gender").lower()
    if gender and gender not in _VALID_GENDERS:
        return [], [], f"Gender must be Male, Female or Other, got '{cell('Gender')}'"
    emp_type = cell("Employment Type").lower()
    if emp_type and emp_type not in _VALID_EMPLOYMENT_TYPES:
        return [], [], f"Employment Type must be Staff or Production, got '{cell('Employment Type')}'"
    salary_type = cell("Salary Type").lower()
    if salary_type and salary_type not in _VALID_SALARY_TYPES:
        return [], [], f"Salary Type must be Monthly or Weekly, got '{cell('Salary Type')}'"
    status = cell(STATUS_HEADER).lower()
    if status and status not in _VALID_STATUSES:
        return [], [], f"Status must be Active or Inactive, got '{cell(STATUS_HEADER)}'"

    for header, attr in _UPDATE_TEXT_FIELDS.items():
        value = cell(header)
        if value and value != str(getattr(emp, attr) or ""):
            setattr(emp, attr, value)
            changed.append(header)

    for value, attr, header in [
        (gender, "gender", "Gender"),
        (emp_type, "employment_type", "Employment Type"),
        (salary_type, "salary_type", "Salary Type"),
        (status, "status", STATUS_HEADER),
    ]:
        if value and value != (getattr(emp, attr) or ""):
            setattr(emp, attr, value)
            changed.append(header)

    for header, attr in [("Date of Birth", "date_of_birth"), ("Join Date", "join_date")]:
        if cell(header):
            parsed = _parse_date_cell(row.get(header))
            if parsed and parsed != str(getattr(emp, attr) or ""):
                setattr(emp, attr, parsed)
                changed.append(header)

    for header, attr in [("Salary Amount", "salary_amount"), ("Salary Per Shift", "salary_per_shift")]:
        if cell(header):
            parsed = parse_decimal(row.get(header))
            current = getattr(emp, attr)
            if parsed is not None and (current is None or Decimal(str(current)) != Decimal(str(parsed))):
                setattr(emp, attr, parsed)
                changed.append(header)

    # The 50% + 50% salary split follows the salary. Cells typed in the sheet win (and must be a valid split); a new
    # salary with no split typed re-scales the stored one; an untouched salary leaves it alone. A file exported before
    # the salary was edited still carries the OLD split next to the NEW amount -identical to what is stored means
    # "not edited", so it is re-scaled rather than rejected.
    stored_split = salary_split.breakup_of(emp)
    salary_changed = "Salary Amount" in changed
    submitted_split = _split_from_row(row)
    if submitted_split is not None and stored_split is not None:
        typed, _typed_error = salary_split.parse_breakup(submitted_split)
        if typed is not None and typed == stored_split:
            submitted_split = None
    if submitted_split is not None or salary_changed:
        parts, split_error = salary_split.resolve(
            emp.salary_amount, submitted_split, stored_split, total_changed=salary_changed
        )
        if split_error:
            return [], [], split_error
        if parts != stored_split:
            salary_split.apply_to_employee(emp, parts)
            changed.append("Salary Split")

    dept_name = cell("Department")
    if dept_name and dept_name.lower() != (emp.department.name.lower() if emp.department_id and emp.department else ""):
        dept = Department.objects.filter(name__iexact=dept_name).first()
        if dept is None:
            dept, _ = Department.objects.get_or_create(name=dept_name)
        emp.department = dept
        changed.append("Department")

    desig_title = cell("Designation")
    if desig_title and desig_title.lower() != (
        emp.designation.title.lower() if emp.designation_id and emp.designation else ""
    ):
        desig_qs = _Desig.objects.filter(title__iexact=desig_title)
        desig = (desig_qs.filter(department=emp.department).first() if emp.department_id else None) or desig_qs.first()
        if desig is None:
            warnings.append(f"Designation '{desig_title}' not found -kept the current one")
        else:
            emp.designation = desig
            changed.append("Designation")

    # Branch: a branch-scoped HR user can't move employees between branches
    # (same rule as the Edit Employee form) -their rows silently keep the
    # current branch. Unscoped users match by name; unknown names warn.
    branch_name = cell("Branch")
    if branch_name and get_branch_scope(request) is None:
        current_branch_name = emp.branch.name if emp.branch_id and emp.branch else ""
        if branch_name.lower() != current_branch_name.lower():
            b = Branch.objects.filter(name__iexact=branch_name).first()
            if b is None:
                warnings.append(f"Branch '{branch_name}' not found -kept the current one")
            else:
                emp.branch_id = b.id
                # Old Unit Code described the old branch -mint a fresh one.
                emp.unit_code = _assign_unit_code(b.id)
                changed.append("Branch")

    return changed, warnings, None


def _in_scope(qs, category: str, employee_status: str):
    qs = qs.filter(employment_type=category)
    return qs.filter(status="active") if employee_status == "active" else qs.exclude(status="active")


def _data_counts(ids: list[int]) -> dict[int, dict]:
    """What would go with each employee if they were deleted: attendance days, payroll records, leave requests."""
    from .models import AttendanceDayRecord, LeaveRequest, Payroll

    out = {i: {"attendance": 0, "payroll": 0, "leaves": 0} for i in ids}
    for key, model in (("attendance", AttendanceDayRecord), ("payroll", Payroll), ("leaves", LeaveRequest)):
        for row in model.objects.filter(employee_id__in=ids).values("employee_id").annotate(n=Count("id")):
            out[row["employee_id"]][key] = row["n"]
    return out


def _missing_list(qs) -> list[dict]:
    people = list(qs.order_by("employee_code"))
    data = _data_counts([e.id for e in people])
    return [
        {
            "id": e.id,
            "code": e.employee_code,
            "name": f"{e.first_name} {e.last_name}".strip(),
            "department": e.department.name if e.department_id and e.department else None,
            "designation": e.designation.title if e.designation_id and e.designation else None,
            "branch": e.branch.name if e.branch_id and e.branch else None,
            "joinDate": str(e.join_date) if e.join_date else None,
            "dataCounts": data[e.id],
            "action": None,
            "result": None,
        }
        for e in people
    ]


def _parse_decisions(request: Request, missing: list[dict], employee_status: str):
    """{code: "keep" | "inactive" | "delete"} for every missing employee, from `missingAction` (the default) and
    `missingDecisions` (a JSON object of per-code overrides). Raises ValueError with a message for a wrong request."""
    allowed = {"keep", "delete"} | ({"inactive"} if employee_status == "active" else set())
    default = str(request.data.get("missingAction") or "keep").strip().lower()
    if default not in allowed:
        raise ValueError(f"'missingAction' must be one of: {', '.join(sorted(allowed))}")
    overrides = {}
    raw = request.data.get("missingDecisions")
    if raw:
        try:
            overrides = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except (ValueError, TypeError):
            raise ValueError("'missingDecisions' must be a JSON object of employee code -> action")
    decisions = {}
    for item in missing:
        action = str(overrides.get(item["code"], default)).strip().lower()
        if action not in allowed:
            raise ValueError(f"'{action}' is not a choice for {item['code']}")
        decisions[item["code"]] = action
    if "delete" in decisions.values() and str(request.data.get("confirmDelete") or "").lower() != "true":
        raise ValueError("Deleting employees needs confirmDelete=true: nothing is deleted without confirmation.")
    return decisions


def _apply_removal(request: Request, emp, action: str) -> tuple[bool, str]:
    label = f"{emp.employee_code} -{emp.first_name} {emp.last_name}"
    try:
        with transaction.atomic():
            if action == "inactive":
                emp.status = "inactive"
                emp.save(update_fields=["status", "updated_at"])
                log_action(
                    request,
                    "update",
                    "employees",
                    record_id=emp.id,
                    description=f"Made {label} Inactive (not in the bulk-update file)",
                )
                return True, "Made Inactive"
            emp_id = emp.id
            emp.delete()
            log_action(
                request,
                "delete",
                "employees",
                record_id=emp_id,
                description=f"Deleted employee {label} (not in the bulk-update file)",
            )
            return True, "Deleted with all their data"
    except Exception:
        logger.exception("Bulk update: could not %s %s", action, label)
        return False, "Could not be changed: nothing was done for this employee"


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def bulk_update_employees(request: Request) -> Response:
    """
    Companion to bulk_upload_employees for EXISTING employees: HR downloads
    the current-employees export, fills in missing/corrected cells, and
    re-uploads it here. Rows match by Employee Code; codes not in the system
    are reported (never created -that's what bulk upload is for); blank
    cells never overwrite stored data; only genuinely changed fields are
    written, and the response lists exactly what changed per employee.

    Options (multipart fields next to `file`): `category` = staff | production and `employeeStatus` = active | inactive
    say WHICH employees the file is the list of; with them, the people of that kind who are missing from the file are
    returned as `missing` and are dealt with as `missingAction` / `missingDecisions` say (default: left alone; deleting
    needs `confirmDelete=true`). `mode` = preview | apply (preview writes nothing at all).
    """
    try:
        category = _option(request, "category", CATEGORIES)
        employee_status = _option(request, "employeeStatus", _VALID_STATUSES, "active")
        mode = _option(request, "mode", {"preview", "apply"}, "apply")
    except ValueError as exc:
        return _error(str(exc))

    rows, header_row, layout, failure = _read_sheet(request)
    if failure:
        return failure
    problem = _layout_problem(
        layout,
        category,
        "Invalid file. Please upload the Excel downloaded from Download current employees (or the official template) without changing its columns.",
    )
    if problem:
        return _invalid_template(problem)

    preview = mode == "preview"
    scoped_qs = scope_to_branch(_employee_queryset(), request)

    # Who is in the file, before anything is touched: the people missing from it are everyone else of this kind.
    codes_in_file = set()
    for raw_row in rows[1:]:
        code = _text(raw_row[0]) if raw_row else ""
        if code and not code.upper().startswith("SAMPLE"):
            codes_in_file.add(code)
    scope_total = _in_scope(scoped_qs, category, employee_status).count() if category else 0
    missing = (
        _missing_list(_in_scope(scoped_qs, category, employee_status).exclude(employee_code__in=codes_in_file))
        if category and codes_in_file
        else []
    )
    decisions: dict[str, str] = {}
    if missing and not preview:
        try:
            decisions = _parse_decisions(request, missing, employee_status)
        except ValueError as exc:
            return _error(str(exc))

    reports: list[dict] = []
    seen: dict[str, int] = {}
    legacy_not_found: list[str] = []

    with transaction.atomic():
        for idx, raw_row in enumerate(rows[1:], start=2):
            if _is_blank(raw_row):
                continue
            first_cell = _text(raw_row[0])
            row = dict(zip(header_row, raw_row))
            name = _name_of(row)
            if first_cell.upper().startswith("SAMPLE"):
                reports.append(
                    _row_report(idx, first_cell, name, "skipped", ["Sample row from the template: never imported"])
                )
                continue
            if not first_cell:
                reports.append(
                    _row_report(idx, "", name, "invalid", ["Employee Code is required to match an existing employee"])
                )
                continue
            if first_cell in seen:
                reports.append(
                    _row_report(
                        idx,
                        first_cell,
                        name,
                        "duplicate",
                        [f"Employee code '{first_cell}' is repeated: first on row {seen[first_cell]}"],
                    )
                )
                continue
            seen[first_cell] = idx

            emp = scoped_qs.filter(employee_code=first_cell).first()
            if emp is None:
                message = f"No employee with code '{first_cell}'. Use Add new employees to create new ones"
                legacy_not_found.append(
                    f"Row {idx}: no employee with code '{first_cell}' -use Bulk Upload to add new employees"
                )
                reports.append(_row_report(idx, first_cell, name, "not_found", [message]))
                continue
            display = f"{emp.first_name} {emp.last_name}".strip()

            if category:
                right_kind = emp.employment_type == category
                right_state = (emp.status == "active") == (employee_status == "active")
                if not (right_kind and right_state):
                    where = f"{CATEGORY_LABEL.get(emp.employment_type, emp.employment_type)} {'active' if emp.status == 'active' else 'inactive'}"
                    reports.append(
                        _row_report(
                            idx,
                            first_cell,
                            display,
                            "invalid",
                            [
                                f"{first_cell} is in {where} employees, not {_scope_text(category, employee_status)}. Upload it from that section"
                            ],
                        )
                    )
                    continue

            try:
                with transaction.atomic():
                    changed, row_warnings, row_error = _apply_row_updates(emp, row, request)
                    if category and "Employment Type" in changed:
                        raise ValueError("Employment Type cannot be changed here")  # the section decides the kind
                    if not row_error and changed:
                        emp.save()
                        if "Employment Type" in changed and emp.employment_type == "production":
                            from .shift_views import auto_assign_production_shift

                            auto_assign_production_shift(emp)
                        log_action(
                            request,
                            "update",
                            "employees",
                            record_id=emp.id,
                            description=f"Bulk-updated employee {emp.employee_code} -changed {', '.join(changed)}",
                        )
            except ValueError as exc:
                reports.append(_row_report(idx, first_cell, display, "invalid", [str(exc)]))
                continue
            except Exception:
                logger.exception("Bulk update: row %s (%s) failed unexpectedly", idx, first_cell)
                reports.append(
                    _row_report(
                        idx,
                        first_cell,
                        display,
                        "failed",
                        ["Unexpected error while saving this row. Nothing was changed for it"],
                    )
                )
                continue
            if row_error:
                reports.append(_row_report(idx, first_cell, display, "invalid", [row_error], row_warnings))
            elif not changed:
                reports.append(
                    _row_report(idx, first_cell, display, "unchanged", ["Already matches the system"], row_warnings)
                )
            else:
                reports.append(_row_report(idx, first_cell, display, "updated", warnings=row_warnings, changes=changed))

        # The people missing from the file: only ever as the caller said, one decision for each.
        removed = {"inactive": 0, "delete": 0, "keep": 0, "failed": 0}
        if not preview:
            by_code = (
                {
                    e.employee_code: e
                    for e in _in_scope(scoped_qs, category, employee_status).filter(
                        employee_code__in=[m["code"] for m in missing]
                    )
                }
                if missing
                else {}
            )
            for item in missing:
                action = decisions[item["code"]]
                item["action"] = action
                if action == "keep":
                    item["result"] = "Left unchanged"
                    removed["keep"] += 1
                    continue
                ok, text = _apply_removal(request, by_code[item["code"]], action)
                item["result"] = text
                removed[action if ok else "failed"] += 1

        if preview:
            transaction.set_rollback(True)

    problems = [r for r in reports if r["status"] in ("invalid", "failed", "duplicate")]
    errors = [
        f"Row {r['row']} ({r['code']}): {r['messages'][0]}" if r["code"] else f"Row {r['row']}: {r['messages'][0]}"
        for r in problems
    ]
    warnings = [f"Row {r['row']} ({r['code']}): {w}" for r in reports for w in r["warnings"]]
    changes = [f"{r['code']} -{r['name']}: {', '.join(r['changes'])}" for r in reports if r["status"] == "updated"]
    counts = _counts(
        reports,
        madeInactive=removed["inactive"],
        deleted=removed["delete"],
        kept=removed["keep"],
        removalFailed=removed["failed"],
        missing=len(missing),
    )

    base = f"Updated {counts['updated']} employee(s), {counts['unchanged']} already up to date."
    if preview:
        base = f"Checked the file: {counts['updated']} employee(s) would be updated, {counts['unchanged']} already up to date."
    message = (
        base
        + (f" {counts['notFound']} code(s) not found." if counts["notFound"] else "")
        + (f" {len(problems)} row(s) failed." if problems else "")
        + (f" {len(missing)} employee(s) are not in the file." if missing and preview else "")
    )

    return Response(
        {
            "message": message,
            "preview": preview,
            "category": category,
            "employeeStatus": employee_status if category else None,
            "updated": counts["updated"],
            "unchanged": counts["unchanged"],
            "notFound": legacy_not_found,
            "failed": len(problems),
            "sampleRowsSkipped": counts["skipped"],
            "errors": errors,
            "warnings": warnings,
            "changes": changes,
            "counts": counts,
            "rows": reports,
            "missing": missing,
            "scope": {
                "category": category,
                "employeeStatus": employee_status if category else None,
                "total": scope_total,
                "inFile": scope_total - len(missing) if category else None,
            },
        }
    )
