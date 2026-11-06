"""
Employees -> Production Employees: who is on which production pay cycle.

Every active production employee is paid on exactly one cycle -Weekly, BiWeekly or Monthly (four weeks), see
production_cycles.py- and the Production Payroll page of a cycle only ever generates payroll for the people assigned
to it. Until HR assigns an employee here they are in no cycle's payroll at all.

    GET  /api/employees/production          the production employees, with the cycle each is on, plus the tab counts
    POST /api/employees/production/assign   put employees on a cycle (or take them off it)
    GET  /api/employees/production/cycle-change-preview
                                            what a move would mean for each employee's pay, shown before the move

Production employees only: a staff employee cannot be assigned. Every endpoint honours the caller's branch scope.
"""

from django.db.models import Count, Q, TextField, Value
from django.db.models.functions import Concat
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Employee, HRUser, Payroll
from .production_coverage import (
    MONTH_NAMES,
    PayrollRef,
    PeriodPlan,
    fmt_range,
    fmt_ranges,
    plan_period,
    ranges_json,
    spans_for_employees,
)
from .production_cycles import CYCLE_LABELS, CYCLES, normalize_cycle
from .production_period import InvalidPeriodConfig, next_cycle_period
from .user_settings import settings_for
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


# ── what a move would mean for pay (shown before the move) ─────────────────────


def _can_assign(request: Request) -> bool:
    """The assign endpoint's own permission: Employees at edit level (a Super Admin always)."""
    from .permission_registry import effective_permissions, resolve_permission

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return False
    return hr.is_super_admin or resolve_permission(effective_permissions(hr), "employees") == "edit"


def _previous_label(emp: Employee, last: PayrollRef) -> str:
    """'This employee was previously assigned to Weekly Payroll' and its variants."""
    if emp.production_pay_cycle:
        return f"This employee was previously assigned to {CYCLE_LABELS[emp.production_pay_cycle]} Payroll"
    if last.staff:
        return "This employee was previously paid on Staff Payroll"
    return f"This employee was previously paid on {last.label} Payroll"


def _row_period_text(row: PayrollRef) -> str:
    if row.staff:
        return f"{MONTH_NAMES[row.period_start.month - 1]} {row.period_start.year}"
    return fmt_range(row.period_start, row.period_end)


def _plural_days(start, end) -> tuple[int, dict]:
    days = (end - start).days + 1
    one = days == 1
    return days, {
        "was": "was" if one else "were",
        "falls": "falls" if one else "fall",
        "it": "it is" if one else "they are",
        "day": "day" if one else "days",
    }


def _change_message(
    emp: Employee,
    last: PayrollRef,
    cycle: str | None,
    nxt: tuple | None,
    plan: PeriodPlan | None,
    config_problem: str | None,
) -> str:
    """The owner's warning (2026-11-06), with the real cycles and dates."""
    parts = [
        f"{_previous_label(emp, last)}, and payroll has already been generated for the previous period "
        f"({_row_period_text(last)})."
    ]
    if cycle is None:
        parts.append(
            "If you take this employee off their pay cycle, no payroll will include them until they are assigned "
            "again; then the system will calculate salary only for the remaining unpaid days."
        )
    else:
        label = CYCLE_LABELS[cycle]
        if plan is None:
            parts.append(
                f"If you change the payroll category to {label}, the system will calculate salary only for the "
                "remaining unpaid days."
            )
        elif plan.refused:
            parts.append(
                f"If you change the payroll category to {label}, every day of the next {label} period "
                f"({fmt_range(*nxt)}) is already paid, so nothing is calculated for it; the system will calculate "
                "salary only for the remaining unpaid days after it."
            )
        else:
            parts.append(
                f"If you change the payroll category to {label}, the system will calculate salary only for the "
                f"remaining unpaid days ({fmt_ranges(plan.pay_ranges)})."
            )
    parts.append("Previously generated salary will not be calculated or paid again.")
    if plan is not None and cycle is not None:
        label = CYCLE_LABELS[cycle]
        for c in plan.catch_up:
            _days, w = _plural_days(c.start, c.end)
            parts.append(
                f"{fmt_range(c.start, c.end)} {w['was']} not paid on {c.row.label} and {w['falls']} before the first "
                f"{label} period ({fmt_range(*nxt)}), so {w['it']} added to that first {label} payroll as catch-up "
                f"{w['day']}."
            )
        if plan.legacy_gap is not None:
            g = plan.legacy_gap
            parts.append(
                f"{fmt_range(g.start, g.end)} were not paid by any payroll; the payroll before them was generated "
                "before pay cycles existed, so they are not added automatically."
            )
    if config_problem:
        parts.append(f"Note: {config_problem}")
    return " ".join(parts)


def _period_json(nxt) -> dict | None:
    return {"start": nxt[0].isoformat(), "end": nxt[1].isoformat()} if nxt is not None else None


@api_view(["GET"])
@require_hr
def production_cycle_change_preview(request: Request) -> Response:
    """GET /api/employees/production/cycle-change-preview?ids=1,2&cycle=monthly|unassigned
    What moving these employees to `cycle` (unassigned / none = off their cycle) would mean for their pay, for the
    confirmation shown BEFORE the move. Writes nothing. Per employee:

        warn          true only when the employee really changes cycle AND has payroll history (no needless warnings)
        lastPayroll   their latest payroll row (production period or staff month), or null
        nextPeriod    the target cycle's next due period (null when off a cycle or the cycle is not set up yet)
        payRanges / alreadyPaid / catchUp   which days of that period would be paid, which are already paid and by
                      which payroll, and the catch-up days added because of the move (production_coverage.py)
        message       the owner's sentence with the real cycles and dates (null when warn is false)

    Same permission as the assign endpoint (Employees at edit level); branch-scoped."""
    if not _can_assign(request):
        return _error("You do not have access to this section.", 403)
    params = request.query_params
    try:
        ids = [int(i) for i in str(params.get("ids") or "").split(",") if i.strip()]
    except ValueError:
        return _error("ids must be whole numbers")
    if not ids:
        return _error("ids must list at least one employee")
    if len(ids) > 2000:
        return _error("Preview at most 2000 employees at a time")
    raw = params.get("cycle")
    cycle = None
    if raw not in (None, "", UNASSIGNED, "none"):
        cycle = normalize_cycle(raw)
        if cycle is None:
            return _error("cycle must be weekly, biweekly, monthly or unassigned")

    nxt, config_problem = None, None
    if cycle is not None:
        try:
            nxt = next_cycle_period(settings_for(request), cycle, branch_id=get_branch_scope(request))
        except InvalidPeriodConfig as exc:
            config_problem = str(exc)

    found = {e.id: e for e in _production(request).filter(id__in=ids)}
    spans = spans_for_employees(list(found))
    rows, skipped = [], []
    for emp_id in dict.fromkeys(ids):
        emp = found.get(emp_id)
        if emp is None:
            skipped.append({"employeeId": emp_id, "reason": "Not a production employee in your scope."})
            continue
        own = spans[emp.id]
        last = max(own, key=lambda s: (s.end, s.row.period_end, s.row.payroll_id)).row if own else None
        plan = plan_period(own, nxt[0], nxt[1], cycle) if nxt is not None else None
        changes = emp.production_pay_cycle != cycle
        warn = changes and last is not None
        rows.append(
            {
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "name": _name(emp),
                "fromCycle": emp.production_pay_cycle,
                "toCycle": cycle,
                "changes": changes,
                "warn": warn,
                "lastPayroll": {
                    "payrollId": last.payroll_id,
                    "cycle": last.cycle,
                    "kind": "staff" if last.staff else "production",
                    "label": last.label,
                    "periodStart": last.period_start.isoformat(),
                    "periodEnd": last.period_end.isoformat(),
                    "status": last.status,
                }
                if last is not None
                else None,
                "nextPeriod": _period_json(nxt),
                "payRanges": ranges_json(plan.pay_ranges) if plan is not None else [],
                "alreadyPaid": [p.json() for p in plan.already_paid] if plan is not None else [],
                "catchUp": [c.json() for c in plan.catch_up] if plan is not None else [],
                "legacyGap": plan.legacy_gap.json() if plan is not None and plan.legacy_gap is not None else None,
                "refused": bool(plan is not None and plan.refused),
                "message": _change_message(emp, last, cycle, nxt, plan, config_problem) if warn else None,
            }
        )
    return Response(
        {
            "cycle": cycle,
            "label": CYCLE_LABELS.get(cycle or "", "No pay cycle"),
            "nextPeriod": _period_json(nxt),
            "configError": config_problem,
            "warnCount": sum(1 for r in rows if r["warn"]),
            "employees": rows,
            "skipped": skipped,
        }
    )
