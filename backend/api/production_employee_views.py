"""
Employees -> Production Employees: who is on which production pay cycle.

Every active production employee is paid on exactly one cycle -Weekly, BiWeekly or Monthly (four weeks), see
production_cycles.py- and the Production Payroll page of a cycle only ever generates payroll for the people assigned
to it. Until HR assigns an employee here they are in no cycle's payroll at all.

    GET  /api/employees/production          the production employees, with the cycle each is on, plus the tab counts
    POST /api/employees/production/assign   put employees on a cycle (or take them off it)

Production employees only: a staff employee cannot be assigned. Both endpoints honour the caller's branch scope.
"""

from django.db.models import Count, Q, TextField, Value
from django.db.models.functions import Concat
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Employee, Payroll
from .production_cycles import CYCLE_LABELS, CYCLES, normalize_cycle
from .view_common import _error

UNASSIGNED = "unassigned"


def _production(request: Request):
    return scope_to_branch(Employee.objects, request).filter(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)


def _name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _counts(qs) -> dict:
    """The tab counts of a set of production employees: all, each cycle, and the ones not assigned to any."""
    by_cycle = dict(
        qs.exclude(production_pay_cycle__isnull=True).values_list("production_pay_cycle").annotate(n=Count("id"))
    )
    out = {cycle: by_cycle.get(cycle, 0) for cycle in CYCLES}
    out["unassigned"] = qs.filter(production_pay_cycle__isnull=True).count()
    out["total"] = sum(out[c] for c in CYCLES) + out["unassigned"]
    return out


@api_view(["GET"])
@require_hr
def production_employees(request: Request) -> Response:
    """GET /api/employees/production?cycle=all|unassigned|weekly|biweekly|monthly&status=active|inactive|all
    &search=&departmentId=&branchId=
    The production employees (active ones unless `status` says otherwise). `counts` ignores `cycle`, so the tabs
    always show every cycle's total for the same search, department and status."""
    params = request.query_params
    qs = _production(request).select_related("department", "designation", "branch")

    status = params.get("status", "active")
    if status in ("active", "inactive"):
        qs = qs.filter(status=status)
    elif status != "all":
        return _error("status must be active, inactive or all")
    try:
        if params.get("departmentId"):
            qs = qs.filter(department_id=int(params["departmentId"]))
        if params.get("branchId"):
            qs = qs.filter(branch_id=int(params["branchId"]))
    except ValueError:
        return _error("departmentId and branchId must be numbers")
    search = params.get("search", "").strip()
    if search:
        qs = qs.annotate(full_name=Concat("first_name", Value(" "), "last_name", output_field=TextField())).filter(
            Q(employee_code__icontains=search)
            | Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(full_name__icontains=search)
        )

    counts = _counts(qs)

    wanted = (params.get("cycle") or "all").strip().lower()
    if wanted == UNASSIGNED:
        qs = qs.filter(production_pay_cycle__isnull=True)
    elif wanted != "all":
        cycle = normalize_cycle(wanted)
        if cycle is None:
            return _error("cycle must be all, unassigned, weekly, biweekly or monthly")
        qs = qs.filter(production_pay_cycle=cycle)

    employees = list(qs.order_by("first_name", "last_name", "employee_code"))

    # the latest period-based payslip of each person: what the "last payroll" column shows
    latest = {
        row["employee_id"]: row
        for row in Payroll.objects.filter(
            employee_id__in=[e.id for e in employees], salary_mode="shift", period_start__isnull=False
        )
        .order_by("employee_id", "-period_end", "-id")
        .distinct("employee_id")
        .values("employee_id", "period_start", "period_end", "status", "pay_cycle")
    }

    rows = []
    for emp in employees:
        last = latest.get(emp.id)
        rows.append(
            {
                "id": emp.id,
                "employeeCode": emp.employee_code,
                "name": _name(emp),
                "status": emp.status,
                "departmentId": emp.department_id,
                "departmentName": emp.department.name if emp.department_id else None,
                "designationTitle": emp.designation.title if emp.designation_id else None,
                "branchId": emp.branch_id,
                "branchName": emp.branch.name if emp.branch_id else None,
                "joinDate": emp.join_date,
                "salaryPerShift": float(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
                "payCycle": emp.production_pay_cycle,
                "lastPayroll": {
                    "periodStart": last["period_start"].isoformat(),
                    "periodEnd": last["period_end"].isoformat(),
                    "status": last["status"],
                    "payCycle": last["pay_cycle"],
                }
                if last
                else None,
            }
        )
    return Response({"counts": counts, "employees": rows})


@api_view(["POST"])
@require_hr
def assign_production_pay_cycle(request: Request) -> Response:
    """POST /api/employees/production/assign
    Body: { employeeIds: [1, 2, 3], cycle: "weekly" | "biweekly" | "monthly" | null }
    A null / empty cycle takes the employees off their cycle. Payroll already generated keeps the cycle it was
    generated on; from now on only the new cycle's page generates payroll for these employees."""
    data = request.data
    ids = data.get("employeeIds")
    if not isinstance(ids, list) or not ids:
        return _error("employeeIds must be a non-empty list")
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return _error("employeeIds must be whole numbers")
    raw = data.get("cycle")
    cycle = None
    if raw not in (None, "", UNASSIGNED, "none"):
        cycle = normalize_cycle(raw)
        if cycle is None:
            return _error("cycle must be weekly, biweekly, monthly or null (to take employees off their cycle)")

    found = {e.id: e for e in _production(request).filter(id__in=ids)}
    skipped = [
        {"employeeId": i, "reason": "Not a production employee in your scope."}
        for i in dict.fromkeys(ids)
        if i not in found
    ]
    changing = [e for e in found.values() if e.production_pay_cycle != cycle]
    unchanged = len(found) - len(changing)

    # unpaid payroll an employee already has on another cycle stays on that cycle's page: tell the caller
    carrying = 0
    if changing:
        carrying = (
            Payroll.objects.filter(
                employee_id__in=[e.id for e in changing],
                salary_mode="shift",
                period_start__isnull=False,
                status=Payroll.STATUS_PENDING,
                pay_cycle__isnull=False,
            )
            .exclude(pay_cycle=cycle)
            .values("employee_id")
            .distinct()
            .count()
        )
        Employee.objects.filter(id__in=[e.id for e in changing]).update(
            production_pay_cycle=cycle, updated_at=timezone.now()
        )
        target = f"the {CYCLE_LABELS[cycle]} pay cycle" if cycle else "no pay cycle"
        sample = ", ".join(e.employee_code for e in changing[:5])
        more = f" and {len(changing) - 5} more" if len(changing) > 5 else ""
        log_action(
            request,
            "update",
            "employees",
            description=f"Assigned {len(changing)} production employee(s) to {target} ({sample}{more})",
        )

    return Response(
        {
            "updated": len(changing),
            "unchanged": unchanged,
            "skipped": skipped,
            "pendingOnOtherCycle": carrying,
            "counts": _counts(_production(request).filter(status="active")),
        }
    )
