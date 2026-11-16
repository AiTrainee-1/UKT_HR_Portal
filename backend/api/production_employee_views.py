"""
Employees -> Production Employees: who is on which production pay cycle.

Every active production employee is paid on exactly one cycle -Weekly, BiWeekly or Monthly (four weeks), see
production_cycles.py- and the Production Payroll page of a cycle only ever generates payroll for the people assigned
to it. Until HR assigns an employee here they are in no cycle's payroll at all.

    GET  /api/employees/production          the production employees, with the cycle each is on, their latest move and
                                            the tab counts
    POST /api/employees/production/assign   put employees on a cycle (or take them off it)
    GET  /api/employees/production/cycle-change-preview
                                            what a move would mean for each employee's pay, shown before the move
    GET  /api/employees/production/<id>/transfers
                                            every move of one worker, newest first

A move is never casual (owner 2026-11-16, production_transfers.py): a worker who already has payroll can change cycle only
when the request says it was confirmed and gives a short reason (409 with the facts of what was already paid otherwise),
and every move writes a ProductionCycleTransfer. Production employees only: a staff employee cannot be assigned. Every
endpoint honours the caller's branch scope.
"""

from django.db import transaction
from django.db.models import Count, Q, TextField, Value
from django.db.models.functions import Concat
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .models import Employee, HRUser, Payroll
from .production_coverage import spans_for_employees
from .production_cycles import CYCLE_LABELS, CYCLES, normalize_cycle
from .production_period_workflow import move_json
from .production_transfers import (
    REASON_MAX,
    clean_reason,
    facts_for,
    latest_moves,
    move_counts,
    record_moves,
    transfers_json,
)
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
    always show every cycle's total for the same search, department and status. Each row carries the worker's latest
    move between cycles (`lastMove`) and how many moves they have (`moveCount`)."""
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
    ids = [e.id for e in employees]

    # the latest period-based payslip of each person: what the "last payroll" column shows
    latest = {
        row["employee_id"]: row
        for row in Payroll.objects.filter(employee_id__in=ids, salary_mode="shift", period_start__isnull=False)
        .order_by("employee_id", "-period_end", "-id")
        .distinct("employee_id")
        .values("employee_id", "period_start", "period_end", "status", "pay_cycle", "payment_status")
    }
    moves = latest_moves(ids)
    moved = move_counts(ids)

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
                    "paymentStatus": last["payment_status"] or Payroll.PAYMENT_NOT_PAID,
                }
                if last
                else None,
                # the worker's latest move between cycles (assigning from Unassigned and taking off a cycle included)
                "lastMove": move_json(moves.get(emp.id)),
                "moveCount": moved.get(emp.id, 0),
            }
        )
    return Response({"counts": counts, "employees": rows})


def _target_of(raw) -> tuple[str | None, str | None]:
    """(cycle or None for 'off the cycle', None) or (None, why the value cannot be read)."""
    if raw in (None, "", UNASSIGNED, "none"):
        return None, None
    cycle = normalize_cycle(raw)
    if cycle is None:
        return None, "cycle must be weekly, biweekly, monthly or null (to take employees off their cycle)"
    return cycle, None


CONFIRM_NEEDED = (
    "Some of these workers have already received salary on their current pay cycle. Moving them is allowed only on "
    "purpose: confirm the move and give a short reason. The salary already paid for that time will not be paid again."
)


@api_view(["POST"])
@require_hr
def assign_production_pay_cycle(request: Request) -> Response:
    """POST /api/employees/production/assign
    Body: { employeeIds: [1, 2, 3], cycle: "weekly" | "biweekly" | "monthly" | null, confirm?: true, reason?: "..." }
    A null / empty cycle takes the employees off their cycle. Payroll already generated keeps the cycle it was
    generated on; from now on only the new cycle's page generates payroll for these employees.

    A worker who already has payroll changes cycle only with `confirm: true` and a `reason` (owner 2026-11-16): without
    them nothing is changed and the answer is a 409 whose `employees` carry the facts of what each was already paid (the
    same as the preview). Every worker who really changes cycle gets a ProductionCycleTransfer (who, when, why, what the
    old cycle had paid them, from which day the new one pays)."""
    data = request.data
    ids = data.get("employeeIds")
    if not isinstance(ids, list) or not ids:
        return _error("employeeIds must be a non-empty list")
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return _error("employeeIds must be whole numbers")
    cycle, problem = _target_of(data.get("cycle"))
    if problem:
        return _error(problem)
    confirmed = data.get("confirm") is True
    reason = clean_reason(data.get("reason"))
    if len(str(data.get("reason") or "").strip()) > REASON_MAX:
        return _error(f"Keep the reason under {REASON_MAX} characters.")

    found = {e.id: e for e in _production(request).filter(id__in=ids)}
    skipped = [
        {"employeeId": i, "reason": "Not a production employee in your scope."}
        for i in dict.fromkeys(ids)
        if i not in found
    ]
    changing = [e for e in found.values() if e.production_pay_cycle != cycle]
    unchanged = len(found) - len(changing)

    facts = facts_for(changing, cycle, settings_for(request), get_branch_scope(request)) if changing else {}
    needing = [f for f in facts.values() if f.needs_confirmation]
    if needing and not (confirmed and reason):
        missing = "a reason" if confirmed else "a confirmation and a reason"
        return Response(
            {
                "error": f"{CONFIRM_NEEDED} (missing: {missing})",
                "code": "confirm_cycle_change",
                "needsReason": True,
                "employees": [f.json() for f in needing],
            },
            status=409,
        )

    carrying = 0
    moves = []
    if changing:
        # unpaid payroll an employee already has on another cycle stays on that cycle's page: tell the caller
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
        actor = get_hr_display_name(request)
        with transaction.atomic():
            Employee.objects.filter(id__in=[e.id for e in changing]).update(
                production_pay_cycle=cycle, updated_at=timezone.now()
            )
            moves = record_moves([facts[e.id] for e in changing], actor, reason)
        target = f"the {CYCLE_LABELS[cycle]} pay cycle" if cycle else "no pay cycle"
        sample = ", ".join(e.employee_code for e in changing[:5])
        more = f" and {len(changing) - 5} more" if len(changing) > 5 else ""
        paid_before = f"; {len(needing)} already had payroll" if needing else ""
        log_action(
            request,
            "update",
            "employees",
            description=(
                f"Assigned {len(changing)} production employee(s) to {target} ({sample}{more}){paid_before}"
                + (f". Reason: {reason}" if reason else "")
            ),
            new_values={"cycle": cycle, "employeeIds": [e.id for e in changing], "reason": reason or None},
        )

    return Response(
        {
            "updated": len(changing),
            "unchanged": unchanged,
            "skipped": skipped,
            "pendingOnOtherCycle": carrying,
            "moves": [move_json(m) for m in moves],
            "counts": _counts(_production(request).filter(status="active")),
        }
    )


# ── what a move would mean for pay (shown before the move) ─────────────────────


def _can_assign(request: Request) -> bool:
    """The assign endpoint's own permission: Employees -> Production Employees at edit level (it follows Employees until a
    role sets it on its own; a Super Admin always)."""
    from .permission_registry import effective_permissions, resolve_permission

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return False
    return (
        hr.is_super_admin or resolve_permission(effective_permissions(hr), "employees.production_employees") == "edit"
    )


def _period_json(nxt) -> dict | None:
    return {"start": nxt[0].isoformat(), "end": nxt[1].isoformat()} if nxt is not None else None


@api_view(["GET"])
@require_hr
def production_cycle_change_preview(request: Request) -> Response:
    """GET /api/employees/production/cycle-change-preview?ids=1,2&cycle=monthly|unassigned
    What moving these employees to `cycle` (unassigned / none = off their cycle) would mean for their pay, for the
    confirmation shown BEFORE the move. Writes nothing. Per employee (production_transfers.MoveFacts.json):

        warn / needsConfirmation  true only when the employee really changes cycle AND already has payroll: the move then
                                  needs confirm + reason (no needless warnings)
        paidThrough, oldCycle     up to which day they were paid, and how many pay periods / how much the old cycle paid
        paysFrom, firstPeriod     from which day, and in which period, the new cycle pays
        payRanges / alreadyPaid / catchUp   which days of that period would be paid, which are already paid and by which
                                  payroll, and the catch-up days added because of the move (production_coverage.py)
        message                   the owner's warning with the real cycles, dates and amounts (null when warn is false)
        lastPayroll               their latest payroll row (production period or staff month), or null

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
    cycle, problem = _target_of(params.get("cycle"))
    if problem:
        return _error("cycle must be weekly, biweekly, monthly or unassigned")

    found = {e.id: e for e in _production(request).filter(id__in=ids)}
    spans = spans_for_employees(list(found))
    facts = facts_for(list(found.values()), cycle, settings_for(request), get_branch_scope(request), spans)
    nxt = next(iter(facts.values())).first_period if facts else None
    config_problem = next(iter(facts.values())).config_problem if facts else None
    rows, skipped = [], []
    for emp_id in dict.fromkeys(ids):
        emp = found.get(emp_id)
        if emp is None:
            skipped.append({"employeeId": emp_id, "reason": "Not a production employee in your scope."})
            continue
        own = spans[emp.id]
        last = max(own, key=lambda s: (s.end, s.row.period_end, s.row.payroll_id)).row if own else None
        f = facts[emp.id]
        rows.append(
            {
                **f.json(),
                "warn": f.needs_confirmation,
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
                "nextPeriod": _period_json(f.first_period),
            }
        )
    return Response(
        {
            "cycle": cycle,
            "label": CYCLE_LABELS.get(cycle or "", "No pay cycle"),
            "nextPeriod": _period_json(nxt),
            "configError": config_problem,
            "warnCount": sum(1 for r in rows if r["warn"]),
            # the move needs `confirm: true` and a reason (some of these workers already have payroll)
            "needsReason": any(r["warn"] for r in rows),
            "reasonMax": REASON_MAX,
            "employees": rows,
            "skipped": skipped,
        }
    )


@api_view(["GET"])
@require_hr
def production_employee_transfers(request: Request, pk: int) -> Response:
    """GET /api/employees/production/<id>/transfers: every move of one production worker between pay cycles, newest
    first (who, when, why, what the old cycle had paid, from which day the new one pays). Branch-scoped."""
    emp = _production(request).filter(pk=pk).first()
    if emp is None:
        return _error("Not found", 404)
    return Response(
        {
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "name": _name(emp),
            "payCycle": emp.production_pay_cycle,
            "moves": transfers_json(emp.id),
        }
    )
