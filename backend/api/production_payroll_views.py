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
  * only an explicit request with regenerate=true ("Generate again") recomputes an existing payslip; one marked Cleared
    is recomputed too and STAYS Cleared (owner 2026-11-06, as on Staff Payroll);
  * no working day is paid twice (production_coverage.py, 2026-11-06): when the employee moved between cycles, the
    days of the period another payroll already paid are left out and only the rest is paid; days that no cycle paid
    because of the move are added to the first payroll on the new cycle as catch-up days. An employee with nothing
    left to pay in the period is refused, naming the payroll(s) that already paid it.

The period workflow (owner 2026-11-16, production_period_workflow.py): a period can be generated only once it has ENDED
(from the day after its last day: a night shift of the last day is not complete before that); a worker who joined during
the period, or moved here from another cycle, is parked in its New Joiners until HR adds them; Payroll Done locks the
period for good (no generate, regenerate, adjust or Cleared on it); Mark as Paid records the day it was paid.
"""

from datetime import date

from django.db import transaction
from django.db.models import Count, Q, Sum
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import production_period_workflow as workflow
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
    breakdown_response,
    patch_production_payroll,
)
from .production_coverage import (
    PeriodPlan,
    draft_json,
    fmt_day,
    fmt_ranges,
    plan_period,
    plans_for_employees,
    spans_for_employees,
)
from .production_cycles import CYCLE_DAYS, CYCLE_LABELS, CYCLES, cycle_config, normalize_cycle
from .production_period import (
    InvalidPeriodConfig,
    is_cycle_period,
    next_cycle_period,
    period_ended,
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


def _cycle_payrolls(request: Request, cycle: str, include_parked: bool = False):
    """Period-based production payroll rows of one cycle: those generated on it, plus rows generated before the
    cycles existed (no cycle stamped) whose employee is assigned to it now. The period's MAIN payroll only: a worker
    parked in New Joiners (joined during the period, or moved here from another cycle) is left out until HR adds them
    (owner 2026-11-16), unless `include_parked`."""
    qs = Payroll.objects.select_related("employee", "employee__department").filter(
        salary_mode="shift", period_start__isnull=False
    )
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    # active employees only (owner 2026-11-10), as on Staff Payroll: a deactivated employee's payroll stays stored but is
    # not listed, counted or put in the bank file. (Coverage - which days are already paid - still reads every row.)
    qs = qs.filter(employee__status="active")
    if not include_parked:
        qs = qs.filter(workflow.MAIN_Q)
    return qs.filter(Q(pay_cycle=cycle) | Q(pay_cycle__isnull=True, employee__production_pay_cycle=cycle))


def _name(emp: Employee) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


# ── what would happen to one employee ──────────────────────────────────────────


def _who(emp: Employee) -> dict:
    return {"employeeId": emp.id, "employeeCode": emp.employee_code, "name": _name(emp)}


PAID_NOT_AGAIN = "This salary is already marked Paid: a paid salary is never worked out again."


def _classify(
    plan: PeriodPlan, has_payroll: bool, regenerate: bool, paid: bool = False, replace_drafts: bool = False
) -> tuple[str, str | None]:
    """('run', None) generate the days `plan` pays; ('existing', None) the employee already has payroll for the period
    and nobody asked to generate it again (pending or Cleared, it is left alone); ('blocked', why) refused: every day
    of the period is already paid by a FINAL payroll, the salary is already marked Paid, or draft payslips of other
    periods share its days and the run was not told to replace them (owner 2026-11-16)."""
    if has_payroll and not regenerate:
        return "existing", None
    if has_payroll and paid:
        return "blocked", PAID_NOT_AGAIN
    if plan.refused:
        return "blocked", plan.refusal_reason()
    if plan.drafts and not replace_drafts:
        return "blocked", plan.drafts_reason()
    return "run", None


def _plan(employees, start: date, end: date, regenerate: bool, cycle: str, replace_drafts: bool = False):
    """Sorts a roster into (to_run, already_generated, blocked) for one period. `to_run` holds (employee, plan) pairs:
    the plan says which days to pay (production_coverage.py) and which draft payslips of other periods it replaces.
    Three queries for the whole roster."""
    ids = [e.id for e in employees]
    has_payroll, paid = set(), set()
    for emp_id, payment in Payroll.objects.filter(employee_id__in=ids, period_start=start, period_end=end).values_list(
        "employee_id", "payment_status"
    ):
        has_payroll.add(emp_id)
        if payment == Payroll.PAYMENT_PAID:
            paid.add(emp_id)
    spans = spans_for_employees(ids)
    to_run, existing, blocked = [], [], []
    for emp in employees:
        plan = plan_period(spans[emp.id], start, end, cycle)
        verdict, why = _classify(plan, emp.id in has_payroll, regenerate, emp.id in paid, replace_drafts)
        if verdict == "run":
            to_run.append((emp, plan))
        elif verdict == "existing":
            existing.append(emp)
        else:
            blocked.append({**_who(emp), "reason": why, "coverage": plan.json()})
    return to_run, existing, blocked


def _partial(to_run) -> list[dict]:
    """The employees of a run who are paid for part of the period only, or get catch-up days, with exactly which days."""
    return [{**_who(emp), "coverage": plan.json()} for emp, plan in to_run if not plan.is_plain]


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
    states = workflow.period_states(cycle, [(start, end)])
    return {
        "periodStart": start.isoformat(),
        "periodEnd": end.isoformat(),
        "periodEnded": period_ended(end),
        "state": states[(start, end)]["state"],
    }, None


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
        parked = _cycle_payrolls(request, cycle, include_parked=True).filter(workflow.PARKED_Q).count()
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
                # workers waiting in New Joiners (any period of the cycle), not in any payroll until added
                "parked": parked,
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
            "periodEnded": period_ended(end),
        }
    )


def _periods_between(ps, cycle: str, span_from, span_to) -> list[tuple[date, date]]:
    """Every period of the cycle that touches [from, to], newest first. Raises ValueError for unreadable or too wide
    dates."""
    from datetime import timedelta

    if not span_from or not span_to:
        raise ValueError("from and to must both be given (YYYY-MM-DD)")
    first, last = date.fromisoformat(str(span_from)[:10]), date.fromisoformat(str(span_to)[:10])
    if last < first:
        raise ValueError("to cannot be before from")
    if (last - first).days > 400:
        raise ValueError("from and to can be at most 400 days apart")
    out = []
    period = resolve_cycle_period(first, ps, cycle)
    while period[0] <= last:
        out.append(period)
        period = resolve_cycle_period(period[1] + timedelta(days=1), ps, cycle)
    return sorted(out, reverse=True)


@api_view(["GET"])
@require_hr
def production_periods(request: Request) -> Response:
    """GET /api/payroll/production/periods?cycle=weekly[&back=8][&around=2026-02-04]
    The periods worth choosing from, newest first -the next one to generate and the ones around it- each with how
    many payslips of this cycle exist for it, so a half-done period is easy to spot. `around` is any date: the period
    that holds it is added to the list (this is how an older period is opened, e.g. to fill it in). `from` + `to`
    (dates, at most 400 days apart) instead list every period of the cycle that touches [from, to], newest first (a
    calendar month in one call)."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.query_params)
        back = max(1, min(26, int(request.query_params.get("back", 8))))
        branch = get_branch_scope(request)
        upcoming = next_cycle_period(ps, cycle, branch_id=branch)
        span_from, span_to = request.query_params.get("from"), request.query_params.get("to")
        if span_from or span_to:
            periods = _periods_between(ps, cycle, span_from, span_to)
        else:
            periods = recent_cycle_periods(ps, cycle, back=back, branch_id=branch)
        around = request.query_params.get("around")
        if around:
            held = resolve_cycle_period(date.fromisoformat(around), ps, cycle)
            if held not in periods:
                periods = sorted([*periods, held], reverse=True)
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    first, last = periods[-1][0], periods[0][1]
    rows = (
        _cycle_payrolls(request, cycle, include_parked=True)
        .filter(period_start__gte=first, period_end__lte=last)
        .values("period_start", "period_end")
        .annotate(total=Count("id"), paid=Count("id", filter=Q(status=Payroll.STATUS_PAID)))
    )
    counted = {(r["period_start"], r["period_end"]): r for r in rows}
    # where each period stands in the workflow (Not generated / Generated / Payroll Done / Paid) and who is parked
    states = workflow.period_states(cycle, periods, request)
    roster = _roster(request, cycle).count()
    today = ist_today()
    out = []
    for start, end in periods:
        row = counted.get((start, end))
        state = states[(start, end)]
        out.append(
            {
                "periodStart": start.isoformat(),
                "periodEnd": end.isoformat(),
                "periodEnded": period_ended(end, today),
                "isNext": (start, end) == upcoming,
                # payslips of the period (New Joiners included) and how many of them are Cleared
                "generated": row["total"] if row else 0,
                "paid": row["paid"] if row else 0,
                "state": state["state"],
                "stateLabel": workflow.STATE_LABELS[state["state"]],
                "parked": state["parked"],
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
    ids = [e.id for e in roster]
    existing = {
        p.employee_id: p for p in Payroll.objects.filter(employee_id__in=ids, period_start=start, period_end=end)
    }
    # which days of the period each employee's payroll pays (or would pay): days other payroll already paid are left
    # out, catch-up days after a cycle change are added (production_coverage.py)
    plans = plans_for_employees(ids, start, end, cycle)
    moved = _moved_in(roster, cycle, existing)
    close = workflow.period_close(cycle, start, end)

    employees = []
    counts = {
        "generated": 0,
        "paid": 0,
        "ready": 0,
        "blocked": 0,
        "parked": 0,
        "movedIn": 0,
        "newJoiners": 0,
        # workers with draft payslips of other periods sharing this period's days (replaced when generated with the flag)
        "drafts": 0,
        "draftRows": 0,
    }
    for emp in roster:
        payroll = existing.get(emp.id)
        plan = plans[emp.id]
        blocked = None
        if payroll is None:
            if close is not None:
                blocked = workflow.locked_message(cycle, start, end)
            elif not emp.salary_per_shift or emp.salary_per_shift <= 0:
                blocked = NO_RATE
            elif plan.refused:
                blocked = plan.refusal_reason()
        if payroll is not None:
            counts["paid" if payroll.status == Payroll.STATUS_PAID else "generated"] += 1
            if payroll.new_joiner_parked:
                counts["parked"] += 1
        elif blocked:
            counts["blocked"] += 1
        else:
            counts["ready"] += 1
        move = moved.get(emp.id)
        joined = workflow.joined_in(emp, start, end)
        counts["movedIn"] += 1 if move else 0
        counts["newJoiners"] += 1 if joined else 0
        # draft payslips of other periods in the way: never a block (FINAL coverage only blocks), replaced on request
        drafts = (
            [] if blocked or (payroll is not None and payroll.payment_status == Payroll.PAYMENT_PAID) else plan.drafts
        )
        if drafts:
            counts["drafts"] += 1
            counts["draftRows"] += len(drafts)
        employees.append(
            {
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "name": _name(emp),
                "departmentName": emp.department.name if emp.department_id else None,
                "salaryPerShift": float(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
                "payroll": _payroll_json(payroll, _name(emp)) if payroll is not None else None,
                "blockedReason": blocked,
                # the days the payslip pays (or would pay), the days of the period another payroll already paid, and any
                # catch-up days after a pay-cycle change; `partial` false = the whole period, as usual
                "coverage": plan.json(),
                # moved here from another cycle and this is (or will be) their first period here: previous and new cycle
                "movedIn": move,
                # joined during the period (their payroll is parked in New Joiners until HR adds them)
                "joinedOn": joined.isoformat() if joined else None,
                # DRAFT payslips of other periods that share this period's days: generating with replaceDrafts deletes
                # them first, so these days are paid once, by this period
                "drafts": [draft_json(d) for d in drafts],
            }
        )
    return Response(
        {
            "cycle": cycle,
            "label": CYCLE_LABELS[cycle],
            "periodStart": start.isoformat(),
            "periodEnd": end.isoformat(),
            "periodEnded": period_ended(end),
            "locked": close is not None,
            "state": workflow.state_of(close, len(existing)),
            "counts": counts,
            "employees": employees,
        }
    )


def _moved_in(employees, cycle: str, existing: dict | None = None) -> dict[int, dict]:
    """employee id -> {previous and new cycle, when, by whom, why} for the workers whose latest move into this cycle came
    from ANOTHER cycle and whose first period here this is (no payroll on the cycle since the move, or the payroll of this
    period is the one generated since)."""
    moves = workflow.moves_in([e.id for e in employees], cycle)
    out = {}
    for emp in employees:
        found = moves.get(emp.id)
        if found is None:
            continue
        move, previous, none_since = found
        payroll = (existing or {}).get(emp.id)
        first = none_since or (payroll is not None and workflow.is_first_after_move(payroll, cycle, move))
        if first:
            out[emp.id] = workflow.move_json(move, previous)
    return out


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
    replace = _flag(request.query_params.get("replaceDrafts"))
    if workflow.is_locked(cycle, start, end):
        return _error(workflow.locked_message(cycle, start, end), 409)

    employees, outside = _select(request, cycle, ids)
    to_run, already, skipped = _plan(employees, start, end, regenerate, cycle, replace)
    skipped = outside + skipped
    prod_config = ProductionShiftConfig.get()  # one config object for the whole loop: the shift rules load once
    for emp, plan in to_run:
        try:
            with transaction.atomic():
                _generate_production_payroll(
                    emp, start, end, pay_cycle=cycle, prod_config=prod_config, pay_ranges=plan, replace_drafts=replace
                )
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
            "periodEnded": period_ended(end),
            "totalChecked": len(employees) + len(outside),
            "alreadyGenerated": len(already),
            "skippedCount": len(skipped),
            "skipped": skipped,
            # who would be paid for part of the period only (days already paid on another cycle) or get catch-up days
            "partial": _partial(to_run),
            # whose draft payslips of other periods the run would replace (replaceDrafts)
            "drafts": [
                {**_who(emp), "drafts": [draft_json(d) for d in plan.drafts]} for emp, plan in to_run if plan.drafts
            ],
            # who moved here from another cycle / joined during the period: calculated, then parked in New Joiners
            **_arrivals(
                [emp for emp, _plan_ in to_run],
                cycle,
                start,
                end,
                dict(to_run_plans(to_run)),
                {
                    p.employee_id: p
                    for p in Payroll.objects.filter(
                        employee_id__in=[emp.id for emp, _p in to_run], period_start=start, period_end=end
                    )
                },
            ),
        }
    )


def to_run_plans(to_run):
    return ((emp.id, plan) for emp, plan in to_run)


def _arrivals(employees, cycle: str, start: date, end: date, plans: dict, existing: dict | None = None) -> dict:
    """The workers a run is about who arrive in this cycle's payroll through New Joiners: moved here from another cycle
    (previous and new cycle, the days they are paid for, the days left out because another cycle already paid them, any
    catch-up days) and those who joined during the period. `existing`: {employee id: their payroll of the period}."""
    moved = _moved_in(employees, cycle, existing)
    moved_in, joiners = [], []
    for emp in employees:
        plan = plans.get(emp.id)
        if emp.id in moved:
            moved_in.append({**_who(emp), "move": moved[emp.id], "coverage": plan.json() if plan is not None else None})
            continue
        joined = workflow.joined_in(emp, start, end)
        if joined is not None:
            joiners.append({**_who(emp), "joinedOn": joined.isoformat()})
    return {"movedIn": moved_in, "newJoiners": joiners}


# ── generate ───────────────────────────────────────────────────────────────────


@api_view(["POST"])
@require_hr
def production_generate_payroll(request: Request) -> Response:
    """POST /api/payroll/production/generate
    Body: { cycle, periodStart?, periodEnd?, employeeIds?, regenerate? }

    cycle         weekly | biweekly | monthly -required; only that cycle's assigned employees are ever paid.
    periodStart/End  one of the cycle's own periods; omit both for the next due one. It must have ENDED: a period can be
                  generated from the day after its last day (a night shift of the last day is not complete before that).
                  A period finalized with Payroll Done is locked: 409.
    employeeIds   generate only for these (they must be on the cycle's roster); omit for the whole roster.
    regenerate    recompute the payslip the employee already has for the period ("Generate again"); one marked Cleared
                  stays Cleared, one marked Paid is never recomputed. Without it an employee who already has payroll for
                  the period is left alone.

    Each employee is paid only the days no other payroll paid (production_coverage.py); `partialDetails` lists who was
    paid for part of the period or got catch-up days, and someone with nothing left to pay is skipped with the reason.
    `movedInDetails` / `newJoinerDetails`: who arrived through New Joiners (parked until HR adds them)."""
    ps = settings_for(request)
    try:
        cycle = _cycle_of(request.data)
        start, end, _explicit = _period_of(request.data, ps, cycle, get_branch_scope(request))
        ids = _ids_of(request.data.get("employeeIds"))
    except (ValueError, InvalidPeriodConfig) as exc:
        return _error(str(exc))
    regenerate = _flag(request.data.get("regenerate"))
    replace = _flag(request.data.get("replaceDrafts"))
    label = CYCLE_LABELS[cycle]

    if not period_ended(end):
        return _error(
            f"Period {start.isoformat()} to {end.isoformat()} has not ended yet: it can be generated from "
            f"{fmt_day(workflow.end_plus_one(end))}, once every shift of its last day is complete."
        )
    if workflow.is_locked(cycle, start, end):
        return _error(workflow.locked_message(cycle, start, end), 409)

    employees, outside = _select(request, cycle, ids)
    to_run, already, blocked = _plan(employees, start, end, regenerate, cycle, replace)

    from . import payroll_progress

    generated, skipped, partial, replaced_rows = [], list(outside) + blocked, [], []
    if not payroll_progress.try_begin_run():
        return _error("A payroll run is already in progress. Wait for it to finish, then try again.", 409)
    # Payroll Done also takes the run slot, so a period can never be locked half way through a run: checked again here.
    if workflow.is_locked(cycle, start, end):
        payroll_progress.end_run()
        return _error(workflow.locked_message(cycle, start, end), 409)
    try:
        payroll_progress.start(len(to_run))
        prod_config = ProductionShiftConfig.get()  # one config object for the whole loop: the shift rules load once
        for emp, plan in to_run:
            emp_name = _name(emp)
            before = len(generated)
            try:
                # one worker at a time, all or nothing: a draft is deleted only together with its replacement
                with transaction.atomic():
                    result = _generate_production_payroll(
                        emp,
                        start,
                        end,
                        pay_cycle=cycle,
                        prod_config=prod_config,
                        pay_ranges=plan,
                        replace_drafts=replace,
                    )
                generated.append(_payroll_json(result["payroll"], emp_name))
                if not plan.is_plain:
                    partial.append({**_who(emp), "coverage": plan.json()})
                if result["replaced"]["rows"]:
                    from .production_drafts import left_unpaid

                    waiting = left_unpaid(emp.id, result["replaced"]["days"], (start, end))
                    replaced_rows.append(
                        {
                            **_who(emp),
                            "drafts": result["replaced"]["rows"],
                            # days of the replaced drafts outside this period that no payroll pays now: they wait for
                            # their own period to be generated
                            "waiting": [{"from": a.isoformat(), "to": b.isoformat()} for a, b in waiting],
                            "waitingText": fmt_ranges(waiting) if waiting else None,
                        }
                    )
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
    finally:
        payroll_progress.end_run()

    from .audit_utils import log_action as _log

    if replaced_rows:
        # who replaced which draft payslips, and why (owner 2026-11-16): one log line for the run, every row in its values
        count = sum(len(r["drafts"]) for r in replaced_rows)
        sample = ", ".join(f"{r['employeeCode']} ({len(r['drafts'])})" for r in replaced_rows[:8])
        more = f" and {len(replaced_rows) - 8} more" if len(replaced_rows) > 8 else ""
        from .audit_utils import log_action as _log_replace

        _log_replace(
            request,
            "delete",
            "payroll",
            description=(
                f"Replaced {count} draft production payslip(s) of {len(replaced_rows)} worker(s) ({sample}{more}) while "
                f"generating {label} {start.isoformat()}–{end.isoformat()}: they shared days with this period and were "
                "not finalized or paid"
            ),
            old_values={
                "replacedDrafts": [
                    {"employeeCode": r["employeeCode"], "drafts": r["drafts"], "waiting": r["waiting"]}
                    for r in replaced_rows
                ]
            },
        )

    made = {row["employeeId"] for row in generated}
    rows_made = {
        p.employee_id: p for p in Payroll.objects.filter(employee_id__in=made, period_start=start, period_end=end)
    }
    arrivals = _arrivals(
        [emp for emp, _p in to_run if emp.id in made], cycle, start, end, dict(to_run_plans(to_run)), rows_made
    )
    parked = sum(1 for row in generated if row.get("newJoinerParked"))
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
                + (f" {len(partial)} paid only the days no other payroll paid (pay-cycle change)." if partial else "")
                + (f" {parked} waiting in New Joiners: add them to the payroll before Payroll Done." if parked else "")
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
            "partialDetails": partial,
            # parked in New Joiners: moved here from another cycle (with the previous and the new cycle and the days paid)
            # or joined during the period
            "movedInDetails": arrivals["movedIn"],
            "newJoinerDetails": arrivals["newJoiners"],
            "parked": parked,
            # draft payslips of other periods replaced by this run, per worker, and the days that now wait for their own
            # period
            "replacedDetails": replaced_rows,
            "replaced": sum(len(r["drafts"]) for r in replaced_rows),
        },
        status=201,
    )


# ── list ───────────────────────────────────────────────────────────────────────


LIST_CAP = 5000


@api_view(["GET"])
@require_hr
def production_payroll_list(request: Request) -> Response:
    """GET /api/payroll/production?cycle=&employeeId=&status=&periodStart=&periodEnd=&limit=&includeParked=
    Period-based production rows (legacy week_number rows still show up on the old Payroll/Salary pages, unaffected
    by this endpoint). With `cycle` only that cycle's rows -those generated on it, plus earlier rows whose employee is
    assigned to it now. No month/year filter -periods aren't month-bound; the frontend filters client-side.

    The MAIN payroll only (owner 2026-11-16): a worker parked in New Joiners is left out of the records, their totals and
    the bank file until HR adds them (includeParked=1, or one employee's own history, lists them too). One period
    (periodStart + periodEnd) answers every row of it (up to 5000; `X-Truncated: true` beyond); otherwise `limit`
    rows (200 unless given, at most 5000)."""
    params = request.query_params
    one_employee = bool(params.get("employeeId"))
    include_parked = _flag(params.get("includeParked")) or one_employee
    try:
        if params.get("cycle"):
            cycle = normalize_cycle(params.get("cycle"))
            if cycle is None:
                return _error("cycle must be weekly, biweekly or monthly")
            qs = _cycle_payrolls(request, cycle, include_parked=include_parked)
        else:
            qs = scope_to_branch(
                Payroll.objects.select_related("employee", "employee__department").filter(
                    salary_mode="shift", period_start__isnull=False
                ),
                request,
                field="employee__branch_id",
            )
            if not include_parked:
                qs = qs.filter(workflow.MAIN_Q)
        qs = qs.order_by("-period_start", "employee__first_name", "id")
        if params.get("employeeId"):
            qs = qs.filter(employee_id=int(params["employeeId"]))
        else:
            # a payroll list is active employees only (owner 2026-11-10); one employee's own history lists every row
            qs = qs.filter(employee__status="active")
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        one_period = bool(params.get("periodStart") and params.get("periodEnd"))
        if one_period:
            qs = qs.filter(
                period_start=date.fromisoformat(params["periodStart"]),
                period_end=date.fromisoformat(params["periodEnd"]),
            )
        limit = int(params.get("limit") or (LIST_CAP if one_period else 200))
        limit = max(1, min(LIST_CAP, limit))
    except ValueError:
        return _error("employeeId and limit must be numbers and periodStart / periodEnd must be dates (YYYY-MM-DD)")

    window = list(qs.defer("employee__photo_url")[: limit + 1])
    response = Response([list_row(p) for p in window[:limit]])
    if len(window) > limit:
        response["X-Truncated"] = "true"
    return response


def list_row(p: Payroll) -> dict:
    """One production payroll as the cycle pages list it: the payroll with the worker's code, department and bank
    details (the bank file is built from these rows)."""
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
    row["joinDate"] = emp.join_date or None
    return row


# ── one production payroll: change it, its breakdown, the run's progress ───────


def _production_row(request: Request, pk: int) -> Payroll | None:
    """One production period payroll in the caller's branch scope (a staff row is not on these routes: None)."""
    p = (
        scope_to_branch(Payroll.objects.select_related("employee"), request, field="employee__branch_id")
        .filter(pk=pk)
        .first()
    )
    if p is None or p.period_start is None or p.salary_mode != Payroll.SALARY_MODE_SHIFT:
        return None
    return p


@api_view(["PATCH"])
@require_hr
def production_payroll_detail(request: Request, pk: int) -> Response:
    """PATCH /api/payroll/production/<id>  { status?: "paid" | "pending", bonus?, deductions?, notes? }
    Mark as Cleared / Adjust one production payroll, under the Production Payroll rights (payroll_views.
    patch_production_payroll): never in a finalized period, never a salary marked Paid."""
    p = _production_row(request, pk)
    if p is None:
        return _error("Not found", 404)
    return patch_production_payroll(request, p)


@api_view(["GET"])
@require_hr
def production_payroll_breakdown(request: Request, pk: int) -> Response:
    """GET /api/payroll/production/<id>/breakdown: the day-by-day breakdown stored with one production payroll."""
    p = _production_row(request, pk)
    if p is None:
        return _error("Not found", 404)
    return breakdown_response(p)


@api_view(["GET"])
@require_hr
def production_generate_progress(request: Request) -> Response:
    """GET /api/payroll/production/generate-progress: the live progress of the payroll run (one run at a time, staff or
    production), for the pipeline shown while a cycle is generated."""
    from . import payroll_progress

    return Response(payroll_progress.snapshot())
