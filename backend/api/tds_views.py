"""TDS membership (Employees -> Co Emp -> TDS): who has tax deducted at source, and at what percentage.

An employee is in exactly one of Co Emp (PF / ESI apply), TDS (TDS only) or neither (pf_esi.py). Adding an employee to TDS
takes them out of Co Emp in the same transaction; removing them from TDS leaves them in neither. Turning Co Emp on for a TDS
employee (employee_views.py) takes them out of TDS the same way. Every change locks the employee row first, so two people
acting on one employee at once can never leave both flags set, and every change is audit-logged.

    GET    /api/tds/employees?type=staff|production|all&search=&status=active|all&branchId=
    POST   /api/tds/employees            {employeeCode, percent}
    PATCH  /api/tds/employees/<id>       {percent}
    DELETE /api/tds/employees/<id>

Permission: the `employees` module (same as the Co Emp toggle). Branch-scoped logins only reach their own branch.
"""

from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Q, TextField, Value
from django.db.models.functions import Concat
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Employee
from .view_common import error_response

PERCENT_MESSAGE = "Percentage must be greater than 0 and at most 100 (2 decimals)."


def parse_percent(raw) -> Decimal | None:
    """A submitted TDS percentage as a Decimal (0 < p <= 100, at most 2 decimals), or None when it is not one."""
    if raw is None or isinstance(raw, bool) or not isinstance(raw, (int, float, str, Decimal)):
        return None
    try:
        number = Decimal(str(raw).strip())
    except InvalidOperation:
        return None
    if not number.is_finite() or number <= 0 or number > 100:
        return None
    if number != number.quantize(Decimal("0.01")):
        return None
    return number.quantize(Decimal("0.01"))


def _row(emp: Employee) -> dict:
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}".strip(),
        "departmentName": emp.department.name if emp.department_id and emp.department else None,
        "designationTitle": emp.designation.title if emp.designation_id and emp.designation else None,
        "branchId": emp.branch_id,
        "branchName": emp.branch.name if emp.branch_id and emp.branch else None,
        "employmentType": emp.employment_type,
        "status": emp.status,
        "tdsPercent": float(emp.tds_percent) if emp.tds_percent is not None else None,
    }


def _pct(value) -> str:
    """10.00 -> '10', 12.50 -> '12.5' (for messages)."""
    return format(Decimal(str(value)).normalize(), "f")


def _label(emp: Employee) -> str:
    return f"{emp.employee_code} -{emp.first_name} {emp.last_name}".rstrip()


def _locked(request: Request, **filters):
    """The (branch-scoped) employees matching `filters`, rows locked for the rest of the transaction."""
    qs = Employee.objects.select_related("department", "designation", "branch").select_for_update(of=("self",))
    return scope_to_branch(qs, request).filter(**filters)


@api_view(["GET", "POST"])
@require_hr
def tds_employees(request: Request) -> Response:
    if request.method == "POST":
        return _add(request)
    return _list(request)


def _list(request: Request) -> Response:
    base = scope_to_branch(
        Employee.objects.filter(tds_enabled=True).select_related("department", "designation", "branch"), request
    )
    counts = {
        "all": base.count(),
        "staff": base.filter(employment_type=Employee.EMPLOYMENT_TYPE_STAFF).count(),
        "production": base.filter(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION).count(),
    }
    qs = base
    kind = request.query_params.get("type", "all")
    if kind in (Employee.EMPLOYMENT_TYPE_STAFF, Employee.EMPLOYMENT_TYPE_PRODUCTION):
        qs = qs.filter(employment_type=kind)
    elif kind != "all":
        return error_response("type must be staff, production or all")
    status = request.query_params.get("status", "all")
    if status == "active":
        qs = qs.filter(status="active")
    elif status != "all":
        return error_response("status must be active or all")
    branch_id = request.query_params.get("branchId")
    if branch_id:
        try:
            qs = qs.filter(branch_id=int(branch_id))
        except ValueError:
            return error_response("branchId must be a number")
    search = (request.query_params.get("search") or "").strip()
    if search:
        full_name = Concat("first_name", Value(" "), "last_name", output_field=TextField())
        qs = qs.annotate(full_name_text=full_name).filter(
            Q(employee_code__icontains=search) | Q(full_name_text__icontains=search)
        )
    return Response({"employees": [_row(e) for e in qs.order_by("first_name", "last_name", "id")], "counts": counts})


def _add(request: Request) -> Response:
    code = str(request.data.get("employeeCode") or "").strip()
    if not code:
        return error_response("employeeCode is required")
    percent = parse_percent(request.data.get("percent"))
    if percent is None:
        return error_response(PERCENT_MESSAGE)

    with transaction.atomic():
        emp = _locked(request, employee_code=code).first()
        if emp is None:
            matches = list(_locked(request, employee_code__iexact=code)[:2])
            emp = matches[0] if len(matches) == 1 else None
        if emp is None:
            body = {"error": f"No employee with code '{code}'.", "code": "employee_not_found"}
            return Response(body, status=404)
        if emp.status != "active":
            body = {"error": f"{_label(emp)} is not active, so cannot be added to TDS.", "code": "employee_inactive"}
            return Response(body, status=400)
        if emp.tds_enabled:
            current = f"{_pct(emp.tds_percent)}%" if emp.tds_percent is not None else "no percentage set"
            body = {
                "error": f"{emp.employee_code} is already in TDS ({current}). Edit the percentage instead.",
                "code": "already_in_tds",
            }
            return Response(body, status=409)

        moved = emp.co_emp_enabled
        emp.co_emp_enabled = False
        emp.tds_enabled = True
        emp.tds_percent = percent
        emp.save(update_fields=["co_emp_enabled", "tds_enabled", "tds_percent", "updated_at"])
        log_action(
            request,
            "update",
            "employees",
            record_id=emp.id,
            description=(
                f"Added {_label(emp)} to TDS at {_pct(percent)}%"
                + (" (taken out of Co Emp: PF/ESI no longer apply)" if moved else "")
            ),
            old_values={"coEmpEnabled": moved, "tdsEnabled": False, "tdsPercent": None},
            new_values={"coEmpEnabled": False, "tdsEnabled": True, "tdsPercent": float(percent)},
        )
    return Response({"employee": _row(emp), "movedFromPfEsi": moved}, status=201)


def _not_in_tds(emp: Employee | None) -> Response:
    who = emp.employee_code if emp is not None else "This employee"
    return Response({"error": f"{who} is not in TDS.", "code": "not_in_tds"}, status=404)


@api_view(["PATCH", "DELETE"])
@require_hr
def tds_employee_detail(request: Request, pk: int) -> Response:
    if request.method == "DELETE":
        return _remove(request, pk)
    return _change_percent(request, pk)


def _change_percent(request: Request, pk: int) -> Response:
    percent = parse_percent(request.data.get("percent"))
    if percent is None:
        return error_response(PERCENT_MESSAGE)
    with transaction.atomic():
        emp = _locked(request, pk=pk).first()
        if emp is None or not emp.tds_enabled:
            return _not_in_tds(emp)
        before = emp.tds_percent
        emp.tds_percent = percent
        emp.save(update_fields=["tds_percent", "updated_at"])
        log_action(
            request,
            "update",
            "employees",
            record_id=emp.id,
            description=f"Changed TDS percentage of {_label(emp)} from {_pct(before)}% to {_pct(percent)}%"
            if before is not None
            else f"Set TDS percentage of {_label(emp)} to {_pct(percent)}%",
            old_values={"tdsPercent": float(before) if before is not None else None},
            new_values={"tdsPercent": float(percent)},
        )
    return Response({"employee": _row(emp)})


def _remove(request: Request, pk: int) -> Response:
    with transaction.atomic():
        emp = _locked(request, pk=pk).first()
        if emp is None or not emp.tds_enabled:
            return _not_in_tds(emp)
        before = emp.tds_percent
        emp.tds_enabled = False
        emp.tds_percent = None
        emp.save(update_fields=["tds_enabled", "tds_percent", "updated_at"])
        log_action(
            request,
            "update",
            "employees",
            record_id=emp.id,
            description=f"Removed {_label(emp)} from TDS (now in no PF/ESI/TDS category)",
            old_values={"tdsEnabled": True, "tdsPercent": float(before) if before is not None else None},
            new_values={"tdsEnabled": False, "tdsPercent": None},
        )
    return Response({"employee": _row(emp), "removed": True})
