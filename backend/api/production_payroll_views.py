"""
Production Payroll -one page per pay cycle: Weekly, BiWeekly and Monthly (four weeks).

Each production employee is assigned to ONE cycle (Employee.production_pay_cycle, set on Employees -> Production
Employees; see production_cycles.py). Every endpoint here works on one cycle and only ever touches the active
production employees assigned to it, so the payroll generated on a cycle's page can only land on that cycle's people.

The periods come from Settings -> Production Payroll (PayrollSettings.prod_cycles, one rule per cycle, see
production_period.py): a caller never sends a month, year or week number, only a cycle and -optionally- one of that
cycle's own periods. Without a period the next due one is used.

Generating never silently overwrites what is already there:
  * an employee who already has payroll for the period is left alone and counted as "already generated";
  * a payslip already marked paid is never recomputed;
  * a period that overlaps days already paid in another payslip of the same employee is refused for that employee;
  * only an explicit one-employee request with regenerate=true recomputes a payslip that is still pending.
"""

from datetime import date

from django.db import transaction
from django.db.models import Count, Q, Sum
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .models import Employee, Payroll, ProductionShiftConfig
from .payroll_views import (
    PayrollSkip,
    _DryRunAbort,
    _error,
    _generate_production_payroll,
    _payroll_json,
)
from .production_cycles import CYCLE_DAYS, CYCLE_LABELS, CYCLES, cycle_config, normalize_cycle
from .production_period import (
    InvalidPeriodConfig,
    is_cycle_period,
    next_cycle_period,
    recent_cycle_periods,
    resolve_cycle_period,
)
from .user_settings import settings_for

NO_RATE = "No Salary Per Shift set on this employee's profile"


# ── request parsing ────────────────────────────────────────────────────────────


def _cycle_of(data) -> str:
    cycle = normalize_cycle(data.get("cycle"))
    if cycle is None:
        raise ValueError("Choose a pay cycle: weekly, biweekly or monthly.")
    return cycle


def _period_of(data, ps, cycle: str, branch_id: int | None = None) -> tuple[date, date, bool]:
    """(period_start, period_end, was_explicit). An explicit period must be exactly one of the cycle's periods."""
    start_raw, end_raw = data.get("periodStart"), data.get("periodEnd")
    if start_raw or end_raw:
        if not start_raw or not end_raw:
            raise ValueError("periodStart and periodEnd must both be provided together")
        start, end = date.fromisoformat(start_raw), date.fromisoformat(end_raw)
        if not is_cycle_period(start, end, ps, cycle):
            label = CYCLE_LABELS[cycle]
            found_start, found_end = resolve_cycle_period(start, ps, cycle)
            raise ValueError(
                f"{start.isoformat()} to {end.isoformat()} is not a {label} period under the current settings. "
                f"The {label} period containing {start.isoformat()} is {found_start.isoformat()} to {found_end.isoformat()}."
            )
        return start, end, True
    start, end = next_cycle_period(ps, cycle, branch_id=branch_id)
    return start, end, False


def _ids_of(raw) -> list[int] | None:
    """A list of employee ids from the request (a JSON list or a comma-separated query value); None when absent."""
    if raw in (None, ""):
        return None
    items = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    ids = []
    for item in items:
        try:
            ids.append(int(item))
        except (TypeError, ValueError):
            raise ValueError("employeeIds must be whole numbers")
    return ids


def _flag(value) -> bool:
    return value is True or str(value).strip().lower() in ("1", "true", "yes")


# ── querysets ──────────────────────────────────────────────────────────────────


def _production_employees(request: Request):
    return scope_to_branch(Employee.objects, request).filter(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)


def _roster(request: Request, cycle: str):
    """The active production employees assigned to `cycle`, in the caller's branch scope."""
    return (
        _production_employees(request)
        .filter(status="active", production_pay_cycle=cycle)
        .select_related("department")
        .order_by("first_name", "last_name", "employee_code")
    )


def _cycle_payrolls(request: Request, cycle: str):
    """Period-based production payroll rows of one cycle: those generated on it, plus rows generated before the
    cycles existed (no cycle stamped) whose employee is assigned to it now."""
    qs = Payroll.objects.select_related("employee", "employee__department").filter(
        salary_mode="shift", period_start__isnull=False
    )
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    return qs.filter(Q(pay_cycle=cycle) | Q(pay_cycle__isnull=True, employee__production_pay_cycle=cycle))


def _name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


# ── what would happen to one employee ──────────────────────────────────────────


def _classify(emp: Employee, start: date, end: date, regenerate: bool) -> tuple[str, str | None]:
    """('run', None) generate; ('existing', None) already has payroll for the period; ('blocked', why) refused."""
    existing = Payroll.objects.filter(employee=emp, period_start=start, period_end=end).first()
    if existing is not None:
        if existing.status == Payroll.STATUS_PAID:
            return "blocked", "Already paid for this period."
        if not regenerate:
            return "existing", None
    clash = (
        Payroll.objects.filter(employee=emp, period_start__isnull=False, period_start__lte=end, period_end__gte=start)
        .exclude(period_start=start, period_end=end)
        .order_by("period_start")
        .first()
    )
    if clash is not None:
        return "blocked", (
            f"Overlaps the payroll already generated for {clash.period_start.isoformat()} to "
            f"{clash.period_end.isoformat()}."
        )
    return "run", None


def _plan(employees, start: date, end: date, regenerate: bool):
    """Sorts a roster into (to_run, already_generated, blocked) for one period."""
    to_run, existing, blocked = [], [], []
    for emp in employees:
        verdict, why = _classify(emp, start, end, regenerate)
        if verdict == "run":
            to_run.append(emp)
        elif verdict == "existing":
            existing.append(emp)
        else:
            blocked.append({"employeeId": emp.id, "employeeCode": emp.employee_code, "name": _name(emp), "reason": why})
    return to_run, existing, blocked


def _select(request: Request, cycle: str, ids: list[int] | None):
    """The employees a request is about -the cycle's roster, or only `ids` of it- and the ids that are not in it."""
    roster = list(_roster(request, cycle))
    if ids is None:
        return roster, []
    by_id = {emp.id: emp for emp in roster}
    chosen = [by_id[i] for i in dict.fromkeys(ids) if i in by_id]
    outside = []
    if len(chosen) < len(set(ids)):
        known = {e.id: e for e in _production_employees(request).filter(id__in=set(ids) - set(by_id))}
        label = CYCLE_LABELS[cycle]
        for missing in dict.fromkeys(i for i in ids if i not in by_id):
            emp = known.get(missing)
            if emp is None:
                outside.append(
                    {
                        "employeeId": missing,
                        "employeeCode": "",
                        "name": f"Employee {missing}",
                        "reason": "Not a production employee in your scope.",
                    }
                )
            elif emp.status != "active":
                outside.append(
                    {
                        "employeeId": emp.id,
                        "employeeCode": emp.employee_code,
                        "name": _name(emp),
                        "reason": "Not an active employee.",
                    }
                )
            else:
                assigned = CYCLE_LABELS.get(emp.production_pay_cycle or "", "no pay cycle")
                outside.append(
                    {
                        "employeeId": emp.id,
                        "employeeCode": emp.employee_code,
                        "name": _name(emp),
                        "reason": f"Not assigned to the {label} cycle (assigned to {assigned}).",
                    }
                )
    return chosen, outside


# ── cycle overview ─────────────────────────────────────────────────────────────


def _next_info(ps, cycle: str, branch_id: int | None = None) -> tuple[dict | None, str | None]:
    try:
        start, end = next_cycle_period(ps, cycle, branch_id=branch_id)
    except InvalidPeriodConfig as exc:
        return None, str(exc)
    return {"periodStart": start.isoformat(), "periodEnd": end.isoformat(), "periodEnded": end <= ist_today()}, None


@api_view(["GET"])
@require_hr
def production_cycles_summary(request: Request) -> Response:
    """GET /api/payroll/production/cycles
    One card per cycle: how many active employees are assigned, whether its period is set up, the next period to
    generate and what is still unpaid; plus how many active production employees are not assigned to any cycle."""
    ps = settings_for(request)
    people = _production_employees(request).filter(status="active")
    assigned_counts = dict(
        people.exclude(production_pay_cycle__isnull=True).values_list("production_pay_cycle").annotate(n=Count("id"))
    )
    cycles = []
    for cycle in CYCLES:
        nxt, problem = _next_info(ps, cycle, get_branch_scope(request))
        cfg = cycle_config(ps, cycle)
        pending = _cycle_payrolls(request, cycle).filter(status=Payroll.STATUS_PENDING)
        totals = pending.aggregate(
            records=Count("id"), people=Count("employee_id", distinct=True), amount=Sum("final_salary")
        )
        cycles.append(
            {
                "cycle": cycle,
                "label": CYCLE_LABELS[cycle],
                "days": CYCLE_DAYS[cycle],
                "assigned": assigned_counts.get(cycle, 0),
                "configured": problem is None,
                "configError": problem,
                "weekStart": cfg.week_start,
                "anchorDate": cfg.anchor_date.isoformat() if cfg.anchor_date else None,
                "next": nxt,
                "pending": {
                    "records": totals["records"] or 0,
                    "employees": totals["people"] or 0,
                    "amount": float(totals["amount"] or 0),
                },
            }
        )
    return Response(
        {
            "cycles": cycles,
            "totalProduction": people.count(),
            "unassigned": people.filter(production_pay_cycle__isnull=True).count(),
        }
    )


@api_view(["GET"])
@require_hr
def production_next_period(request: Request) -> Response:
    """GET /api/payroll/production/next-period?cycle=weekly
    The period that would be generated next on this cycle if Generate were clicked now, computed live from the
    current Settings -does not write anything."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.query_params)
        start, end = next_cycle_period(ps, cycle, branch_id=get_branch_scope(request))
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    return Response(
        {
            "cycle": cycle,
            "label": CYCLE_LABELS[cycle],
            "days": CYCLE_DAYS[cycle],
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "periodEnded": end <= ist_today(),
        }
    )


@api_view(["GET"])
@require_hr
def production_periods(request: Request) -> Response:
    """GET /api/payroll/production/periods?cycle=weekly[&back=8][&around=2026-02-04]
    The periods worth choosing from, newest first -the next one to generate and the ones around it- each with how
    many payslips of this cycle exist for it, so a half-done period is easy to spot. `around` is any date: the period
    that holds it is added to the list (this is how an older period is opened, e.g. to fill it in)."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.query_params)
        back = max(1, min(26, int(request.query_params.get("back", 8))))
        branch = get_branch_scope(request)
        periods = recent_cycle_periods(ps, cycle, back=back, branch_id=branch)
        upcoming = next_cycle_period(ps, cycle, branch_id=branch)
        around = request.query_params.get("around")
        if around:
            held = resolve_cycle_period(date.fromisoformat(around), ps, cycle)
            if held not in periods:
                periods = sorted([*periods, held], reverse=True)
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    first, last = periods[-1][0], periods[0][1]
    rows = (
        _cycle_payrolls(request, cycle)
        .filter(period_start__gte=first, period_end__lte=last)
        .values("period_start", "period_end")
        .annotate(total=Count("id"), paid=Count("id", filter=Q(status=Payroll.STATUS_PAID)))
    )
    counted = {(r["period_start"], r["period_end"]): r for r in rows}
    roster = _roster(request, cycle).count()
    today = ist_today()
    out = []
    for start, end in periods:
        row = counted.get((start, end))
        out.append(
            {
                "periodStart": start.isoformat(),
                "periodEnd": end.isoformat(),
                "periodEnded": end <= today,
                "isNext": (start, end) == upcoming,
                "generated": row["total"] if row else 0,
                "paid": row["paid"] if row else 0,
            }
        )
    return Response(
        {"cycle": cycle, "label": CYCLE_LABELS[cycle], "days": CYCLE_DAYS[cycle], "roster": roster, "periods": out}
    )


@api_view(["GET"])
@require_hr
def production_period_status(request: Request) -> Response:
    """GET /api/payroll/production/period-status?cycle=weekly[&periodStart=&periodEnd=]
    The cycle's roster for one period: every assigned employee with the payslip they already have for it (or why one
    cannot be generated). Defaults to the next due period."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.query_params)
        start, end, _explicit = _period_of(request.query_params, ps, cycle, get_branch_scope(request))
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))

    roster = list(_roster(request, cycle))
    existing = {
        p.employee_id: p
        for p in Payroll.objects.filter(employee_id__in=[e.id for e in roster], period_start=start, period_end=end)
    }
    clashes = {}
    for clash in Payroll.objects.filter(
        employee_id__in=[e.id for e in roster], period_start__isnull=False, period_start__lte=end, period_end__gte=start
    ).exclude(period_start=start, period_end=end):
        clashes.setdefault(clash.employee_id, clash)

    employees = []
    counts = {"generated": 0, "paid": 0, "ready": 0, "blocked": 0}
    for emp in roster:
        payroll = existing.get(emp.id)
        blocked = None
        if payroll is None:
            if not emp.salary_per_shift or emp.salary_per_shift <= 0:
                blocked = NO_RATE
            elif emp.id in clashes:
                c = clashes[emp.id]
                blocked = f"Overlaps the payroll already generated for {c.period_start.isoformat()} to {c.period_end.isoformat()}."
        if payroll is not None:
            counts["paid" if payroll.status == Payroll.STATUS_PAID else "generated"] += 1
        elif blocked:
            counts["blocked"] += 1
        else:
            counts["ready"] += 1
        employees.append(
            {
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "name": _name(emp),
                "departmentName": emp.department.name if emp.department_id else None,
                "salaryPerShift": float(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
                "payroll": _payroll_json(payroll, _name(emp)) if payroll is not None else None,
                "blockedReason": blocked,
            }
        )
    return Response(
        {
            "cycle": cycle,
            "label": CYCLE_LABELS[cycle],
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "periodEnded": end <= ist_today(),
            "counts": counts,
            "employees": employees,
        }
    )


# ── skip check (dry run) ───────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def production_skip_check(request: Request) -> Response:
    """GET /api/payroll/production/skip-check?cycle=&periodStart=&periodEnd=[&employeeIds=1,2][&regenerate=1]
    Read-only dry run: who Generate would skip for this cycle and period, and why. Each employee runs the exact
    engine inside a savepoint that is always rolled back, so nothing is written."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.query_params)
        start, end, _explicit = _period_of(request.query_params, ps, cycle, get_branch_scope(request))
        ids = _ids_of(request.query_params.get("employeeIds"))
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    regenerate = _flag(request.query_params.get("regenerate"))

    employees, outside = _select(request, cycle, ids)
    to_run, already, skipped = _plan(employees, start, end, regenerate)
    skipped = outside + skipped
    prod_config = ProductionShiftConfig.get()  # one config object for the whole loop: the shift rules load once
    for emp in to_run:
        try:
            with transaction.atomic():
                _generate_production_payroll(emp, start, end, pay_cycle=cycle, prod_config=prod_config)
                raise _DryRunAbort()
        except _DryRunAbort:
            continue
        except PayrollSkip as exc:
            reason = str(exc)
        except Exception as exc:  # the engine's own failure reads as the reason, as in a real run
            reason = str(exc)
        skipped.append({"employeeId": emp.id, "employeeCode": emp.employee_code, "name": _name(emp), "reason": reason})

    return Response(
        {
            "cycle": cycle,
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "totalChecked": len(employees) + len(outside),
            "alreadyGenerated": len(already),
            "skippedCount": len(skipped),
            "skipped": skipped,
        }
    )


# ── generate ───────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_hr
def production_generate_payroll(request: Request) -> Response:
    """POST /api/payroll/production/generate
    Body: { cycle, periodStart?, periodEnd?, employeeIds?, regenerate? }

    cycle         weekly | biweekly | monthly -required; only that cycle's assigned employees are ever paid.
    periodStart/End  one of the cycle's own periods; omit both for the next due one. It must already have ended.
    employeeIds   generate only for these (they must be on the cycle's roster); omit for the whole roster.
    regenerate    recompute a payslip that is still pending (never a paid one). Without it an employee who already
                  has payroll for the period is left alone."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.data)
        start, end, _explicit = _period_of(request.data, ps, cycle, get_branch_scope(request))
        ids = _ids_of(request.data.get("employeeIds"))
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    regenerate = _flag(request.data.get("regenerate"))
    label = CYCLE_LABELS[cycle]

    if end > ist_today():
        return _error(f"Period {start.isoformat()} to {end.isoformat()} has not ended yet.")

    employees, outside = _select(request, cycle, ids)
    to_run, already, blocked = _plan(employees, start, end, regenerate)

    from . import payroll_progress

    generated, skipped = [], list(outside) + blocked
    payroll_progress.start(len(to_run))
    prod_config = ProductionShiftConfig.get()  # one config object for the whole loop: the shift rules load once
    for emp in to_run:
        emp_name = _name(emp)
        before = len(generated)
        try:
            result = _generate_production_payroll(emp, start, end, pay_cycle=cycle, prod_config=prod_config)
            generated.append(_payroll_json(result["payroll"], emp_name))
        except PayrollSkip as exc:
            skipped.append(
                {"employeeId": emp.id, "employeeCode": emp.employee_code, "name": emp_name, "reason": str(exc)}
            )
        except Exception as exc:
            skipped.append(
                {"employeeId": emp.id, "employeeCode": emp.employee_code, "name": emp_name, "reason": str(exc)}
            )
        payroll_progress.step(emp_name, len(generated) > before)
    payroll_progress.finish()

    from .audit_utils import log_action as _log

    scope = f"{len(employees)} {label} employee(s)" if ids is None else f"{len(ids)} selected {label} employee(s)"
    _log(
        request,
        "create",
        "payroll",
        description=(
            f"Generated {label} production payroll {start.isoformat()}–{end.isoformat()} for {scope} -"
            f"{len(generated)} generated, {len(already)} already had payroll, {len(skipped)} skipped"
        ),
    )
    return Response(
        {
            "message": (
                f"{label} production payroll for {start.isoformat()} to {end.isoformat()}: "
                f"{len(generated)} computed, {len(already)} already generated, {len(skipped)} skipped."
            ),
            "cycle": cycle,
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "generated": len(generated),
            "alreadyGenerated": len(already),
            "alreadyGeneratedDetails": [
                {"employeeId": e.id, "employeeCode": e.employee_code, "name": _name(e)} for e in already
            ],
            "skipped": len(skipped),
            "skippedDetails": skipped,
        },
        status=201,
    )


# ── list ───────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def production_payroll_list(request: Request) -> Response:
    """GET /api/payroll/production?cycle=&employeeId=&status=&periodStart=&periodEnd=&limit=
    Period-based production rows (legacy week_number rows still show up on the old Payroll/Salary pages, unaffected
    by this endpoint). With `cycle` only that cycle's rows -those generated on it, plus earlier rows whose employee is
    assigned to it now. No month/year filter -periods aren't month-bound; the frontend filters client-side."""
    params = request.query_params
    try:
        if params.get("cycle"):
            cycle = normalize_cycle(params.get("cycle"))
            if cycle is None:
                return _error("cycle must be weekly, biweekly or monthly")
            qs = _cycle_payrolls(request, cycle)
        else:
            qs = scope_to_branch(
                Payroll.objects.select_related("employee", "employee__department").filter(
                    salary_mode="shift", period_start__isnull=False
                ),
                request,
                field="employee__branch_id",
            )
        qs = qs.order_by("-period_start", "employee__first_name")
        if params.get("employeeId"):
            qs = qs.filter(employee_id=int(params["employeeId"]))
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        if params.get("periodStart") and params.get("periodEnd"):
            qs = qs.filter(
                period_start=date.fromisoformat(params["periodStart"]),
                period_end=date.fromisoformat(params["periodEnd"]),
            )
        limit = int(params.get("limit", 200))
    except ValueError:
        return _error("employeeId and limit must be numbers and periodStart / periodEnd must be dates (YYYY-MM-DD)")

    result = []
    for p in qs[:limit]:
        emp = p.employee
        row = _payroll_json(p, _name(emp))
        row["employeeCode"] = emp.employee_code
        row["bankAccount"] = emp.bank_account or ""
        row["bankIfsc"] = emp.bank_ifsc or ""
        row["bankName"] = emp.bank_name or ""
        row["email"] = emp.email or ""
        row["departmentId"] = emp.department_id
        row["departmentName"] = emp.department.name if emp.department else None
        row["employeePayCycle"] = emp.production_pay_cycle
        result.append(row)
    return Response(result)
