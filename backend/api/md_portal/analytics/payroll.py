"""MD portal: payroll analytics. What the workforce costs, what changed since last month and why, who is an outlier and
what is still owed. Read-only: every function only reads, and every REST view and assistant tool runs inside
``common.read_only_db()``.

THE MONEY COMES FROM THE SALARY SLIPS (what each person was paid), never from ``Payroll.final_salary`` (marking a payroll
row paid recomputes that figure without overtime). The definitions are the Report Center's, so a figure here matches
the report of the same name to the paisa:

* gross pay        = ``gross_salary`` + ``ot_amount``    the report's "Total earnings" (its "Gross pay" column is the part
                                                         before overtime, called "salary earned" here)
* net pay          = ``net_salary``                      what the employee takes home
* employer cost    = gross pay + employer PF + employer ESI, the two being ESTIMATES with the Report Center's rates
                     (``payroll_core_common.EMPLOYER_PF_RATE`` / ``EMPLOYER_ESI_RATE``): the system stores no employer
                     contribution. Summed department by department, exactly as ``department-salary-cost`` does.
* people paid      = distinct employees with a slip in the month (a production worker with two period slips counts once)
* slip type        = decided by the slip itself (production = it has a pay period), never by the employee's CURRENT
                     type, so a person who changed type owns slips of both kinds
* legacy weekly production slips (week number, no period) are stale rows and are left out, as in the Report Center
* a staff slip belongs to its month; a production slip to the month its pay period ENDS in
* "provisional" = a staff slip computed before its month ended (the days still to come count as absent), until payroll
  is regenerated: ``payroll_statutory_common.provisional_slip_ids`` reproduced in SQL
* "paid" = the slip's Payroll row carries the status word "paid" (``payroll_core_common.is_paid``)

There is no "finalised" switch in the system: a month is considered closed when it has ended and has slips, and its
payment state (paid / part paid / generated) comes from the Payroll rows. ``status`` shows that for every month.
"""

from __future__ import annotations

import copy
import dataclasses
from collections import defaultdict
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from statistics import median
from typing import Any, Iterable, Sequence

from django.db.models import (
    BooleanField,
    Case,
    Count,
    DecimalField,
    Exists,
    ExpressionWrapper,
    F,
    Max,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Sum,
    Value,
    When,
)
from django.db.models.fields.json import KT
from django.db.models.functions import Cast, Coalesce, ExtractMonth, ExtractYear, Greatest, Lower, Trim
from django.utils import timezone

from ...clock import FACTORY_TZ, ist_today
from ...models import Advance, AdvanceRepayment, Bonus, Payroll, PayrollSettings, SalarySlip
from ...reporting.definitions.finance_common import ist_range_q
from ...reporting.definitions.payroll_core_common import EMPLOYER_ESI_RATE, EMPLOYER_PF_RATE, LATE_SQL, SLIP_TYPE_SQL
from ...reporting.formatting import parse_date
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import (
    MdParamError,
    Scope,
    add_months,
    cached,
    change,
    envelope,
    fy_start_month,
    month_bounds,
    month_label,
    money,
    parse_month,
    pct,
    prov,
)

# ─── thresholds (named, so the screen can show the rule that flagged something) ────────────────────────────────
VARIANCE_PCT = 25.0  # an employee's gross pay moved by this much against last month (either way)
VARIANCE_MIN_RUPEES = 1000.0  # ...and by at least this much (a swing on a tiny amount is noise)
OUTLIER_MULTIPLE = 3.0  # a gross pay above this many times the median of the person's department and type
OUTLIER_MIN_PEERS = 5  # the department needs at least this many people of that type for a median to mean something
COST_JUMP_WARN_PCT = 8.0  # payroll cost rose by this much against last month: worth reading
COST_JUMP_CRITICAL_PCT = 15.0  # ...and this much: act
COST_DROP_WARN_PCT = 10.0  # payroll cost FELL by this much: check nobody was left off payroll
OT_SHARE_WARN_PCT = 3.0  # overtime is at least this share of gross pay and rising...
OT_SHARE_RISE_PTS = 1.0  # ...by at least this many percentage points against last month
OT_SHARE_HIGH_PCT = 10.0  # overtime this large a share of gross pay is called out even when flat
COST_PER_HEAD_FALL_PCT = 2.0  # cost per head fell by this much: good news worth a line
ADVANCE_GROWTH_PCT = 10.0  # advances outstanding grew this much in the month
PAY_DAY_CRITICAL_DAYS = 7  # payroll still unpaid this many days after the salary day: critical
DEFAULT_PAY_DAY = 5  # PayrollSettings.pay_day when it was never set

# upper edges of the net-pay bands (rupees); the first band is "nil or negative", the last is open-ended
NET_BANDS: tuple[int, ...] = (10_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 75_000, 100_000)
# advance ageing: (upper bound in days, label); the last bucket is open-ended
AGEING_BUCKETS: tuple[tuple[int | None, str], ...] = (
    (30, "Up to 30 days"),
    (90, "31 to 90 days"),
    (180, "91 to 180 days"),
    (365, "181 days to a year"),
    (None, "Over a year"),
)

ZERO = Decimal("0")
CENT = Decimal("0.01")
DEC = DecimalField(max_digits=16, decimal_places=2)
DAYS = DecimalField(max_digits=10, decimal_places=2)

NO_PAYROLL_NOTE = (
    "No payroll has been processed yet: there are no salary slips for this selection. Figures appear here once HR "
    "generates a month's payroll."
)

STATE_LABELS = {
    "paid": "Paid",
    "part_paid": "Part paid",
    "generated": "Generated, not marked paid",
    "in_progress": "In progress (provisional)",
    "not_generated": "Not generated",
    "not_started": "Not started",
    "no_data": "No payroll",
}


# ─── small numeric helpers ──────────────────────────────────────────────────────────────────────────────────────


def _dec(value: Any) -> Decimal:
    if value is None:
        return ZERO
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _d2(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _today() -> date:
    """The factory's date; one place so a test can pin it."""
    return ist_today()


# ─── months ─────────────────────────────────────────────────────────────────────────────────────────────────────

Ym = tuple[int, int]


def _key(ym: Ym) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def _label(ym: Ym) -> str:
    return month_label(*ym)


def _end(ym: Ym) -> date:
    return month_bounds(*ym)[1]


def _shift(ym: Ym, n: int) -> Ym:
    return add_months(ym[0], ym[1], n)


def _wall(value: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if value is None:
        return None
    return timezone.localtime(value, FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


# ─── the slips: scope, expressions, one grouped query ───────────────────────────────────────────────────────────


def _slip_scope_q(scope: Scope) -> Q:
    """Which slips the scope covers. Unit and department follow the employee (their CURRENT ones: slips keep no
    snapshot); staff / production follows the SLIP (a production slip has a pay period), as the Report Center does, so a
    person who changed type is not counted under the wrong kind. Legacy weekly production slips are left out. The same
    Q works on Payroll rows (same column names)."""
    q = dataclasses.replace(scope, employment_type=None).employee_q("employee__") & Q(week_number__isnull=True)
    if scope.employment_type == "staff":
        q &= Q(period_start__isnull=True)
    elif scope.employment_type == "production":
        q &= Q(period_start__isnull=False)
    return q


def _pairs_q(pairs: Iterable[Ym]) -> Q:
    q = Q()
    empty = True
    for y, m in pairs:
        q |= Q(year=y, month=m)
        empty = False
    return Q(pk__in=[]) if empty else q


def _slips(scope: Scope, pairs: Iterable[Ym] | None = None) -> QuerySet:
    qs = SalarySlip.objects.filter(_slip_scope_q(scope))
    return qs if pairs is None else qs.filter(_pairs_q(pairs))


# Snapshot of the engine's calculation on every generated slip (payroll_views._generate_*_payroll): the contract salary,
# the days it paid for and the shifts it counted. A slip without a snapshot (imported, very old) reads NULL here.
_MONTHLY_SALARY = Cast(KT("breakdown_details__earnings__monthlySalary"), DAYS)
_EFFECTIVE_DAYS = Cast(KT("breakdown_details__summary__effectivePaidDays"), DAYS)
_TOTAL_SHIFTS = Cast(KT("breakdown_details__summary__totalShifts"), DAYS)
# loss-of-pay days of a STAFF slip (production has none): working days less the days paid for, as the PF statement does,
# falling back to the slip's absent days when the snapshot is missing
_LOP_DAYS = Case(
    When(period_start__isnull=False, then=Value(None, output_field=DAYS)),
    When(
        eff_days__isnull=False,
        then=Greatest(
            ExpressionWrapper(F("working_days") - F("eff_days"), output_field=DAYS), Value(ZERO, output_field=DAYS)
        ),
    ),
    default=F("absent_days"),
    output_field=DAYS,
)


def _sum(expr: Any) -> Sum:
    return Sum(expr, output_field=DEC)


def _annotated(qs: QuerySet) -> QuerySet:
    """The per-slip expressions the grouped queries sum over."""
    return qs.annotate(stype=SLIP_TYPE_SQL, late_amt=LATE_SQL, eff_days=_EFFECTIVE_DAYS).annotate(lop_days=_LOP_DAYS)


def _aggs() -> dict[str, Any]:
    zero = Value(ZERO, output_field=DEC)
    return {
        "slips": Count("id"),
        "heads": Count("employee_id", distinct=True),
        "staff_slips": Count("id", filter=Q(period_start__isnull=True)),
        "salary": _sum("gross_salary"),
        "ot": _sum("ot_amount"),
        "oneoff": _sum(F("incentives") + F("bonuses")),
        # not "basic" / "hra": an alias with a field's name would make F("basic") below mean the aggregate
        "basic_amt": _sum("basic"),
        "hra_amt": _sum("hra"),
        "allow": _sum("allowances"),
        "pf": _sum("pf_deduction"),
        "esi": _sum("esi_deduction"),
        "adv": _sum("advance_deduction"),
        "late": _sum("late_amt"),
        "ded": _sum("total_deductions"),
        "net": _sum("net_salary"),
        "lop_days": _sum("lop_days"),
        "pf_base": _sum(Case(When(pf_deduction__gt=0, then=F("basic")), default=zero, output_field=DEC)),
        "esi_base": _sum(Case(When(esi_deduction__gt=0, then=F("gross_salary")), default=zero, output_field=DEC)),
    }


_GROUP_FIELDS: dict[str, tuple[str, ...]] = {
    "dept": ("employee__department_id", "employee__department__name", "employee__department__branch__name"),
    "branch": ("employee__branch_id", "employee__branch__name"),
    "type": ("stype",),
}


def _agg_rows(scope: Scope, pairs: Iterable[Ym], by: Sequence[str] = ()) -> list[dict]:
    """ONE grouped query: the sums of the slips of the given months, per month and per ``by`` (dept | branch | type)."""
    fields = ["year", "month"]
    for key in by:
        fields.extend(_GROUP_FIELDS[key])
    return list(_annotated(_slips(scope, pairs)).order_by().values(*fields).annotate(**_aggs()))


_SUM_KEYS = (
    "slips",
    "heads",
    "staff_slips",
    "salary",
    "ot",
    "oneoff",
    "basic",
    "hra",
    "allow",
    "pf",
    "esi",
    "adv",
    "late",
    "ded",
    "net",
    "lop_days",
)
_EMPLOYER_KEYS = ("employer_pf", "employer_esi")
_ALIAS = {"basic": "basic_amt", "hra": "hra_amt"}  # the aggregate aliases that differ from their key (see _aggs)


def _raw(row: dict) -> dict[str, Decimal]:
    """A grouped row as Decimals, with the employer estimate worked out for THIS group (as the Report Center's
    department-salary-cost does: the rate on the group's base, rounded to the paisa)."""
    out = {k: _dec(row.get(_ALIAS.get(k, k))) for k in _SUM_KEYS}
    out["employer_pf"] = _d2(_dec(row.get("pf_base")) * EMPLOYER_PF_RATE / 100)
    out["employer_esi"] = _d2(_dec(row.get("esi_base")) * EMPLOYER_ESI_RATE / 100)
    return out


def _sum_raw(items: Iterable[dict[str, Decimal]]) -> dict[str, Decimal]:
    out = {k: ZERO for k in _SUM_KEYS + _EMPLOYER_KEYS}
    for item in items:
        for k in out:
            out[k] += item[k]
    return out


def _figures(t: dict[str, Decimal]) -> dict:
    """The headline figures of a group of slips, as plain JSON numbers (money 2 places, shares 1 place)."""
    gross = t["salary"] + t["ot"]
    heads = int(t["heads"])
    employer = t["employer_pf"] + t["employer_esi"]
    cost = gross + employer
    return {
        "grossPay": money(gross),
        "salaryEarned": money(t["salary"]),
        "overtimePay": money(t["ot"]),
        "bonusAndOneOffs": money(t["oneoff"]),
        "totalDeductions": money(t["ded"]),
        "netPay": money(t["net"]),
        "employerStatutory": money(employer),
        "employerCost": money(cost),
        "headcount": heads,
        "slips": int(t["slips"]),
        "costPerHead": money(gross / heads) if heads else None,
        "employerCostPerHead": money(cost / heads) if heads else None,
        "overtimeSharePct": pct(float(t["ot"]), float(gross)),
        "lopDays": round(float(t["lop_days"]), 1) if t["staff_slips"] else None,
    }


def _month_raw(scope: Scope, pairs: Iterable[Ym]) -> dict[Ym, dict[str, Decimal]]:
    """The summed sums of each month: grouped by department first and added up, so the company figure is exactly the
    sum of the department rows (an employee has ONE department, so headcounts add up too)."""
    by_month: dict[Ym, list[dict[str, Decimal]]] = defaultdict(list)
    for row in _agg_rows(scope, pairs, ("dept",)):
        by_month[(row["year"], row["month"])].append(_raw(row))
    return {ym: _sum_raw(items) for ym, items in by_month.items()}


_CHANGE_KEYS = (
    "grossPay",
    "salaryEarned",
    "overtimePay",
    "totalDeductions",
    "netPay",
    "employerCost",
    "headcount",
    "costPerHead",
    "employerCostPerHead",
    "overtimeSharePct",
)


def _changes(cur: dict | None, prev: dict | None) -> dict | None:
    if cur is None or prev is None:
        return None
    return {k: change(cur.get(k), prev.get(k)) for k in _CHANGE_KEYS}


# ─── which month, and what state is it in ───────────────────────────────────────────────────────────────────────


def _available_months(scope: Scope) -> list[Ym]:
    """Every month that has at least one slip in the scope, newest first."""
    rows = _slips(scope).order_by().values_list("year", "month").distinct()
    return sorted({(int(y), int(m)) for y, m in rows}, reverse=True)


@dataclasses.dataclass
class _Ctx:
    """What a request is about: the scope, the factory's date and the month the figures describe."""

    scope: Scope
    today: date
    ym: Ym | None  # None: no payroll has been processed at all
    available: list[Ym]  # months with slips, newest first
    requested: bool  # the caller named the month (otherwise it is the latest closed month)

    @property
    def ended(self) -> bool:
        return self.ym is not None and _end(self.ym) < self.today


def _context(scope: Scope, month: str | None, today: date | None = None) -> _Ctx:
    """Resolve the month. Default: the latest month that has ENDED and has slips (a month still running is provisional:
    its staff slips count the days to come as absent), else the latest month with slips, else none."""
    today = today or _today()
    available = _available_months(scope)
    if month:
        ym: Ym | None = parse_month(month)
    elif available:
        ended = [x for x in available if _end(x) < today]
        ym = ended[0] if ended else available[0]
    else:
        ym = None
    return _Ctx(scope, today, ym, available, bool(month))


def _paid_case() -> Case:
    """Is this slip's Payroll row marked paid? (Payroll.status is free text: only the word 'paid' counts.) A staff slip
    pairs with the month's staff row; a production slip with the row of its pay period."""
    paid = Payroll.objects.annotate(status_norm=Lower(Trim("status"))).filter(status_norm="paid")
    staff = paid.filter(
        employee_id=OuterRef("employee_id"),
        year=OuterRef("year"),
        month=OuterRef("month"),
        period_start__isnull=True,
        week_number__isnull=True,
    )
    production = paid.filter(
        employee_id=OuterRef("employee_id"), period_start=OuterRef("period_start"), period_end=OuterRef("period_end")
    )
    return Case(
        When(period_start__isnull=True, then=Exists(staff)), default=Exists(production), output_field=BooleanField()
    )


def _last_computed() -> Greatest:
    """When a staff slip was last computed, as far as stored data tells: generated_at is the FIRST generation, the
    Payroll row's updated_at moves on every regeneration, so the later one is the best evidence (payroll_core_common.
    computed_date)."""
    touched = (
        Payroll.objects.filter(
            employee_id=OuterRef("employee_id"),
            year=OuterRef("year"),
            month=OuterRef("month"),
            period_start__isnull=True,
            week_number__isnull=True,
        )
        .order_by("-updated_at")
        .values("updated_at")[:1]
    )
    return Greatest(F("generated_at"), Subquery(touched))


def _state_of(slips: int, paid: int, ended: bool, payroll_started: bool) -> str:
    if slips == 0:
        if not payroll_started:
            return "no_data"
        return "not_generated" if ended else "not_started"
    if paid >= slips:
        return "paid"
    if not ended:
        return "in_progress"
    return "part_paid" if paid else "generated"


def _month_states(scope: Scope, pairs: Sequence[Ym], today: date, available: Sequence[Ym]) -> dict[Ym, dict]:
    """The payment state of each month: slips, how many are marked paid, how many staff slips are provisional, the net
    pay still to be marked paid, and when it was generated / paid. Two queries however many months."""
    first = min(available) if available else None
    rows: dict[Ym, dict] = {}
    if pairs:
        computed = _last_computed()
        qs = _slips(scope, pairs).annotate(
            is_paid=_paid_case(),
            c_ym=ExtractYear(computed, tzinfo=FACTORY_TZ) * 12 + ExtractMonth(computed, tzinfo=FACTORY_TZ),
            s_ym=F("year") * 12 + F("month"),
        )
        grouped = (
            qs.order_by()
            .values("year", "month")
            .annotate(
                slips=Count("id"),
                heads=Count("employee_id", distinct=True),
                paid=Count("id", filter=Q(is_paid=True)),
                provisional=Count("id", filter=Q(period_start__isnull=True, c_ym__lte=F("s_ym"))),
                unpaid_net=_sum(
                    Case(
                        When(is_paid=False, then=F("net_salary")),
                        default=Value(ZERO, output_field=DEC),
                        output_field=DEC,
                    )
                ),
                periods=Count("period_end", distinct=True, filter=Q(period_start__isnull=False)),
                generated=Max("generated_at"),
            )
        )
        rows = {(r["year"], r["month"]): r for r in grouped}
        paid_at = {
            (r["year"], r["month"]): r["last"]
            for r in Payroll.objects.annotate(status_norm=Lower(Trim("status")))
            .filter(_slip_scope_q(scope), _pairs_q(pairs), status_norm="paid")
            .order_by()
            .values("year", "month")
            .annotate(last=Max("updated_at"))
        }
    else:
        paid_at = {}
    out: dict[Ym, dict] = {}
    for ym in pairs:
        r = rows.get(ym)
        slips = int(r["slips"]) if r else 0
        paid = int(r["paid"]) if r else 0
        ended = _end(ym) < today
        state = _state_of(slips, paid, ended, first is not None and ym >= first)
        provisional = int(r["provisional"]) if r else 0
        out[ym] = {
            "month": _key(ym),
            "label": _label(ym),
            "state": state,
            "stateLabel": STATE_LABELS[state],
            "monthEnded": ended,
            "slips": slips,
            "headcount": int(r["heads"]) if r else 0,
            "paidSlips": paid,
            "unpaidSlips": slips - paid,
            "unpaidNet": money(r["unpaid_net"]) if r else 0.0,
            "provisionalSlips": provisional,
            "final": state == "paid" and provisional == 0 and ended,
            "productionPeriods": int(r["periods"]) if r else 0,
            "generatedAt": _wall(r["generated"]) if r else None,
            "paidAt": _wall(paid_at.get(ym)) if state in ("paid", "part_paid") else None,
        }
    return out


def _pay_day() -> int:
    """The salary day HR configured (PayrollSettings.pay_day); a plain read, never PayrollSettings.get() (it writes)."""
    value = PayrollSettings.objects.filter(pk=1).values_list("pay_day", flat=True).first()
    return _clamp(int(value or DEFAULT_PAY_DAY), 1, 28)


# ─── provenance ─────────────────────────────────────────────────────────────────────────────────────────────────


def _p_source(rows: int | None = None) -> dict:
    return prov(
        "payroll-source",
        "Where the payroll figures come from",
        dataset="Salary slips",
        definition=(
            "Every money figure is read from the salary slips HR generates each month: what each person was actually "
            "paid. The payroll rows are never added up, because marking a row paid recomputes its final pay without "
            "overtime."
        ),
        rows=rows,
        filters=[
            "Legacy weekly production slips are left out",
            "A staff slip belongs to its month; a production slip to the month its pay period ends in",
            "People who have since left are included for the months they were paid",
        ],
        caveats=[
            "Department and unit are each person's CURRENT ones: a slip does not record them.",
            "Income tax (TDS) and arrears are not recorded in this system, so they cannot be shown.",
        ],
    )


def _p_gross() -> dict:
    return prov(
        "gross-pay",
        "Gross pay",
        dataset="Salary slips",
        definition=(
            "Salary earned plus overtime, before any deduction: the Report Center's 'Total earnings'. (Its 'Gross pay' "
            "column is the part before overtime, which is called 'salary earned' here.)"
        ),
        formula="gross pay = salary earned + overtime pay",
    )


def _p_net() -> dict:
    return prov(
        "net-pay",
        "Net pay",
        dataset="Salary slips",
        definition="What employees take home: gross pay less everything deducted, as printed on the slip.",
        formula="net pay = gross pay - PF - ESI - advance recovery - late deduction - other deductions",
    )


def _p_deductions() -> dict:
    return prov(
        "deductions",
        "Deductions",
        dataset="Salary slips",
        definition=(
            "PF and ESI deducted from the employee, advance instalments recovered through payroll and late-arrival "
            "penalties, all as stored on the slip. Late deduction is the slip's own late-detection figure (the Report "
            "Center's rule); anything else deducted shows as 'Other deductions'."
        ),
        caveats=["Income tax (TDS) is not recorded in this system."],
    )


def _p_employer() -> dict:
    return prov(
        "employer-cost",
        "Employer cost (estimate)",
        dataset="Salary slips + statutory rates",
        definition=(
            "Gross pay plus an ESTIMATE of what the company adds on top: employer PF and employer ESI. The system does "
            "not store employer contributions, so this uses the Report Center's rates on the slips where the "
            "deduction was made. It is added up department by department, like the report 'Department-wise Salary Cost'."
        ),
        formula=(
            f"employer PF = {EMPLOYER_PF_RATE}% of basic pay where PF was deducted; employer ESI = {EMPLOYER_ESI_RATE}% "
            "of salary earned where ESI was deducted"
        ),
        caveats=[
            "No PF wage cap, EDLI or administration charges are included: treat it as an indication, not a filing."
        ],
    )


def _p_people() -> dict:
    return prov(
        "headcount",
        "People paid",
        dataset="Salary slips",
        definition=(
            "Employees with at least one salary slip in the month, each counted once (a production worker with two "
            "period slips is one person). A person with a zero-pay slip is still counted: the exceptions list shows them."
        ),
    )


def _p_cost_per_head() -> dict:
    return prov(
        "cost-per-head",
        "Cost per head",
        dataset="Salary slips",
        definition=(
            "Gross pay divided by the people paid. The Report Center's 'Cost per head' divides the employer cost "
            "instead; that employer-inclusive figure is shown beside this one."
        ),
        formula="cost per head = gross pay / people paid",
    )


def _p_overtime() -> dict:
    return prov(
        "overtime",
        "Overtime",
        dataset="Salary slips",
        definition=(
            "Overtime pay on the slips: one day's salary for each announced pay-type overtime day, added outside gross "
            "salary, PF and ESI. Staff only; production extra shifts are already inside their gross pay. The share is "
            "overtime divided by gross pay."
        ),
        formula="overtime share = overtime pay / gross pay x 100",
    )


def _p_lop() -> dict:
    return prov(
        "loss-of-pay",
        "Loss-of-pay days",
        dataset="Salary slips",
        definition=(
            "Staff only: working days in the month less the days the slip paid for (a half day counts 0.5), the rule "
            "of the PF statement. Production pay is per shift, so it has no loss-of-pay days."
        ),
        formula="loss-of-pay days = working days - paid days",
    )


def _p_provisional() -> dict:
    return prov(
        "provisional",
        "Provisional slips",
        dataset="Salary slips + payroll rows",
        definition=(
            "A staff slip computed before its month ended counts the days still to come as absent, so it understates "
            "pay until payroll is regenerated after the month closes. 'Provisional' means the last stored computation "
            "of the slip happened on or before the last day of its month."
        ),
        caveats=["An edit of the payroll row after month end cannot be told from a regeneration, so it counts as one."],
    )


def _p_status() -> dict:
    return prov(
        "payroll-status",
        "Payroll status of a month",
        dataset="Salary slips + payroll rows",
        definition=(
            "There is no 'finalised' switch in the system. A month with slips is Paid when every slip's payroll row is "
            "marked paid, Part paid when some are, Generated when none are (and the month has ended) and In progress "
            "while the month is still running. A month with no slips after payroll began is Not generated."
        ),
        caveats=[
            "'Paid' is a status HR sets by hand; it does not prove the bank transfer happened.",
            "Generated and paid times are the slip's first generation and the payroll row's last update.",
        ],
    )


def _p_trend() -> dict:
    return prov(
        "trend",
        "Twelve-month trend",
        dataset="Salary slips",
        definition=(
            "The same figures month by month. A month with no slips shows a gap, not zero. Production slips count in the "
            "month their pay period ends in, so a month where an extra production period ends looks higher without any "
            "rate change."
        ),
    )


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────


def _empty_notes(ctx: _Ctx) -> list[str]:
    if ctx.ym is None:
        return [NO_PAYROLL_NOTE]
    return [f"No salary slips exist for {_label(ctx.ym)} in this selection: payroll has not been generated for it."]


def _summary(ctx: _Ctx) -> dict:
    scope, today = ctx.scope, ctx.today
    if ctx.ym is None:
        return envelope(
            {"month": None, "monthLabel": None, "hasData": False, "monthEnded": False, "totals": None, "byType": {}},
            scope=scope,
            provenance=[_p_source(0), _p_gross(), _p_net()],
            notes=[NO_PAYROLL_NOTE],
        )
    ym = ctx.ym
    prev, last_year = _shift(ym, -1), _shift(ym, -12)
    raw = _month_raw(scope, [ym, prev, last_year])
    figures = {k: _figures(v) for k, v in raw.items()}
    cur = figures.get(ym)
    states = _month_states(scope, [ym, prev], today, ctx.available)
    status = states[ym]
    previous = figures.get(prev)
    year_ago = figures.get(last_year)

    by_type: dict[str, dict] = {}
    gaps: list[dict] = []
    if cur is not None:
        type_rows = _agg_rows(scope, [ym, prev], ("type",))
        by_type = {r["stype"]: _figures(_raw(r)) for r in type_rows if (r["year"], r["month"]) == ym}
        if ctx.ended:
            gaps = _type_gaps(type_rows, ym)

    def block(ym_: Ym, fig: dict | None) -> dict | None:
        return {"month": _key(ym_), "label": _label(ym_), "totals": fig} if fig is not None else None

    payable = (
        {"slips": status["unpaidSlips"], "netPay": status["unpaidNet"]} if cur is not None and status["slips"] else None
    )
    notes: list[str] = []
    if cur is None:
        notes.extend(_empty_notes(ctx))
    else:
        if status["provisionalSlips"]:
            notes.append(_provisional_note(status["provisionalSlips"], ym, ctx.ended))
        notes.extend(_type_gap_note(g, ym) for g in gaps)
        prod_now, prod_prev = states[ym]["productionPeriods"], states[prev]["productionPeriods"]
        if prod_now and prod_prev and prod_now != prod_prev:
            notes.append(
                f"{_plural(prod_now, 'production pay period')} ended in {_label(ym)} against {prod_prev} in {_label(prev)}: "
                "production pay moves with the number of periods, so compare production month on month with care."
            )
    return envelope(
        {
            "month": _key(ym),
            "monthLabel": _label(ym),
            "hasData": cur is not None,
            "monthEnded": ctx.ended,
            "requested": ctx.requested,
            "status": status,
            "totals": cur,
            "byType": by_type,
            "typeGaps": gaps,
            "previous": block(prev, previous),
            "lastYear": block(last_year, year_ago),
            "change": _changes(cur, previous),
            "changeLastYear": _changes(cur, year_ago),
            "payable": payable,
        },
        scope=scope,
        provenance=[
            _p_source(cur["slips"] if cur else 0),
            _p_gross(),
            _p_net(),
            _p_deductions(),
            _p_employer(),
            _p_people(),
            _p_cost_per_head(),
            _p_overtime(),
            _p_lop(),
            _p_provisional(),
            _p_status(),
        ],
        notes=notes,
    )


def _provisional_note(n: int, ym: Ym, ended: bool) -> str:
    one = n == 1
    if not ended:
        return (
            f"{_label(ym)} has not ended: its {_plural(n, 'staff slip')} {'counts' if one else 'count'} the remaining "
            "working days as absent, so pay is understated until payroll is regenerated after the month closes."
        )
    return (
        f"{_plural(n, 'staff slip')} for {_label(ym)} {'was' if one else 'were'} generated before the month ended and "
        f"not regenerated since, so {'it understates' if one else 'they understate'} pay. Regenerate payroll to "
        f"correct {'it' if one else 'them'}."
    )


def _type_gaps(rows: list[dict], ym: Ym) -> list[dict]:
    """Kinds of payroll (staff / production) paid last month that have no slip at all this month. Staff and production
    payroll are generated separately, so such a kind has probably not been generated yet: the month's cost is understated
    and the people appear as "left payroll" in the bridge. ``rows`` are the type-grouped sums of both months."""
    now = {r["stype"] for r in rows if (r["year"], r["month"]) == ym}
    out = []
    for r in rows:
        if (r["year"], r["month"]) != ym and r["stype"] not in now:
            raw = _raw(r)
            out.append(
                {"type": r["stype"], "headcount": int(raw["heads"]), "grossPay": money(raw["salary"] + raw["ot"])}
            )
    return out


def _type_gap_note(gap: dict, ym: Ym) -> str:
    return (
        f"No {gap['type']} slips exist for {_label(ym)}, although {_label(_shift(ym, -1))} had {gap['headcount']} people "
        f"on {gap['type']} payroll ({_inr_compact(gap['grossPay'])}): that payroll has probably not been generated yet, so "
        "the cost is understated."
    )


@cached()
def payroll_summary(scope: Scope, month: str | None = None) -> dict:
    """The month's payroll cost with its comparison against the previous month and the same month last year."""
    return _summary(_context(scope, month))


# ─── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _trend(ctx: _Ctx, months: int) -> dict:
    scope = ctx.scope
    if ctx.ym is None:
        return envelope(
            {"hasData": False, "months": [], "average": None},
            scope=scope,
            provenance=[_p_trend(), _p_source(0)],
            notes=[NO_PAYROLL_NOTE],
        )
    window = [_shift(ctx.ym, -i) for i in range(months - 1, -1, -1)]
    raw = _month_raw(scope, window)
    states = _month_states(scope, window, ctx.today, ctx.available)
    rows = []
    for ym in window:
        fig = _figures(raw[ym]) if ym in raw else None
        st = states[ym]
        rows.append(
            {
                "month": _key(ym),
                "label": _label(ym),
                "hasData": fig is not None,
                "state": st["state"],
                "provisionalSlips": st["provisionalSlips"],
                "grossPay": fig["grossPay"] if fig else None,
                "netPay": fig["netPay"] if fig else None,
                "headcount": fig["headcount"] if fig else None,
                "costPerHead": fig["costPerHead"] if fig else None,
                "overtimePay": fig["overtimePay"] if fig else None,
                "overtimeSharePct": fig["overtimeSharePct"] if fig else None,
            }
        )
    with_data = [r for r in rows if r["hasData"]]
    average = round(sum(r["grossPay"] for r in with_data) / len(with_data), 2) if with_data else None
    highest = max(with_data, key=lambda r: r["grossPay"], default=None)
    lowest = min(with_data, key=lambda r: r["grossPay"], default=None)
    notes = []
    if any(r["provisionalSlips"] for r in rows):
        notes.append(
            "Months marked provisional include staff slips generated before the month ended: they understate pay."
        )
    return envelope(
        {
            "hasData": bool(with_data),
            "month": _key(ctx.ym),
            "months": rows,
            "average": average,
            "highest": {"month": highest["month"], "label": highest["label"], "grossPay": highest["grossPay"]}
            if highest
            else None,
            "lowest": {"month": lowest["month"], "label": lowest["label"], "grossPay": lowest["grossPay"]}
            if lowest
            else None,
        },
        scope=scope,
        provenance=[_p_trend(), _p_gross(), _p_people(), _p_cost_per_head(), _p_overtime(), _p_provisional()],
        notes=notes,
    )


@cached()
def payroll_trend(scope: Scope, month: str | None = None, months: int = 12) -> dict:
    """Gross pay, net pay, people paid, cost per head and overtime for the last ``months`` months ending at ``month``."""
    return _trend(_context(scope, month), _clamp(months, 2, 36))


# ─── bridge: last month's gross pay to this month's, step by step ───────────────────────────────────────────────

BRIDGE_STEPS: tuple[tuple[str, str], ...] = (
    ("joined", "Joined payroll"),
    ("left", "Left payroll"),
    ("rate", "Pay rate changes"),
    ("overtime", "Overtime"),
    ("attendance", "Loss of pay / attendance"),
    ("oneoffs", "Bonus and one-offs"),
    ("other", "Other"),
)


def _bridge_rows(scope: Scope, ym: Ym) -> list[dict]:
    qs = _slips(scope, [ym]).annotate(stype=SLIP_TYPE_SQL, monthly=_MONTHLY_SALARY, tot_shifts=_TOTAL_SHIFTS)
    return list(
        qs.order_by().values(
            "employee_id",
            "stype",
            "gross_salary",
            "ot_amount",
            "incentives",
            "bonuses",
            "monthly",
            "tot_shifts",
            "present_days",
        )
    )


def _entities(rows: Iterable[dict]) -> dict[int, dict]:
    """One entry per employee for the month: what they were paid and the facts the split needs. ``core`` is the salary
    earned before overtime and one-offs; a staff person's ``monthly`` is the contract salary on the slip(s)
    (``monthly_ok`` False when a slip has no snapshot); a production person's ``shifts`` are the shifts paid for."""
    out: dict[int, dict] = {}
    for r in rows:
        e = out.setdefault(
            r["employee_id"],
            {
                "types": set(),
                "gross": ZERO,
                "ot": ZERO,
                "oneoff": ZERO,
                "core": ZERO,
                "monthly": ZERO,
                "ok": True,
                "shifts": ZERO,
            },
        )
        oneoff = r["incentives"] + r["bonuses"]
        e["types"].add(r["stype"])
        e["gross"] += r["gross_salary"] + r["ot_amount"]
        e["ot"] += r["ot_amount"]
        e["oneoff"] += oneoff
        e["core"] += r["gross_salary"] - oneoff
        if r["stype"] == "staff":
            if r["monthly"] is None:
                e["ok"] = False
            else:
                e["monthly"] += r["monthly"]
        else:
            e["shifts"] += r["tot_shifts"] if r["tot_shifts"] is not None else r["present_days"]
    return out


def _bridge_amounts(before: dict[int, dict], after: dict[int, dict]) -> tuple[dict[str, Decimal], dict[str, int]]:
    """The decomposition. Every person falls in exactly one place, so the steps add up to the total change exactly:

    1. in ``after`` only            -> Joined payroll: their whole gross pay (salary, overtime and one-offs)
    2. in ``before`` only           -> Left payroll:   minus their whole gross pay
    3. in both months, per person:
       a. overtime         = change in overtime pay
       b. bonus / one-offs = change in slip incentives + bonuses
       c. the rest is the change in salary earned (``core``) and is split in two:
          - staff:      pay rate = change in the contract salary on the slip;
                        attendance = what is left (the change in loss of pay: core = salary - loss of pay)
          - production: attendance = change in shifts paid for x last month's average rate per shift;
                        pay rate = what is left (the rate per shift moved)
          - a slip with no snapshot, or a person who changed between staff and production: all of it is Other
    Rounding: the production split is rounded to the paisa and its partner takes the remainder, so nothing is lost."""
    amount = {k: ZERO for k, _ in BRIDGE_STEPS}
    people = {k: 0 for k, _ in BRIDGE_STEPS}
    for emp, now in after.items():
        was = before.get(emp)
        if was is None:
            amount["joined"] += now["gross"]
            people["joined"] += 1
            continue
        d_ot, d_one, d_core = now["ot"] - was["ot"], now["oneoff"] - was["oneoff"], now["core"] - was["core"]
        amount["overtime"] += d_ot
        amount["oneoffs"] += d_one
        people["overtime"] += d_ot != 0
        people["oneoffs"] += d_one != 0
        rate = attendance = unsplit = ZERO
        if was["types"] == now["types"] == {"staff"} and was["ok"] and now["ok"]:
            rate = now["monthly"] - was["monthly"]
            attendance = d_core - rate
        elif was["types"] == now["types"] == {"production"}:
            if was["shifts"] > 0:
                attendance = _d2((now["shifts"] - was["shifts"]) * was["core"] / was["shifts"])
            else:
                attendance = d_core
            rate = d_core - attendance
        else:
            unsplit = d_core
        amount["rate"] += rate
        amount["attendance"] += attendance
        amount["other"] += unsplit
        people["rate"] += rate != 0
        people["attendance"] += attendance != 0
        people["other"] += unsplit != 0
    for emp, was in before.items():
        if emp not in after:
            amount["left"] -= was["gross"]
            people["left"] += 1
    return amount, people


_BRIDGE_DETAIL = {
    "joined": "People paid this month who were not paid last month (new joiners, and anyone left off last month's payroll).",
    "left": "People paid last month who are not on this month's payroll (leavers, and anyone missed this month).",
    "rate": "Change in contract salary (staff) or rate per shift (production) for people paid in both months: increments and promotions.",
    "overtime": "Change in overtime pay for people paid in both months.",
    "attendance": "Change in pay lost to absence (staff) or in shifts worked (production) for people paid in both months.",
    "oneoffs": "Change in incentives and bonuses on the slips of people paid in both months.",
    "other": "What could not be assigned: slips with no saved calculation breakdown, people who moved between staff and production, and rounding.",
}


def _p_bridge() -> list[dict]:
    return [
        prov(
            "bridge",
            "Cost bridge: what changed since last month",
            dataset="Salary slips",
            definition=(
                "Last month's gross pay is walked to this month's in fixed steps, and the steps add up to the change "
                "to the paisa. Every person lands in exactly one place: joined payroll, left payroll, or, for people "
                "paid in both months, overtime, bonus and one-offs, pay rate and attendance."
            ),
            formula="this month's gross - last month's gross = joined + left + pay rate + overtime + attendance + one-offs + other",
        ),
        prov(
            "bridge-split",
            "How pay rate and attendance are told apart",
            dataset="Salary slips (the calculation saved with each slip)",
            definition=(
                "Staff: pay rate is the change in the contract salary recorded on the slip; attendance is what is left "
                "of the change in salary earned (the change in pay lost to absence). Production: attendance is the "
                "change in shifts worked at last month's average rate per shift; pay rate is what is left. A person "
                "whose slip has no saved calculation, or who moved between staff and production, goes to Other."
            ),
            formula="staff: rate = contract salary now - then; attendance = change in salary earned - rate",
            caveats=[
                "Other is the residual: the steps are computed so that they always add up to the total change.",
                "Production pay counts the pay periods that END in the month, so a month with an extra period shows "
                "more shifts without any rate change.",
                "An increment appears in the month the slip is generated with the new salary, not the month it was "
                "effective from.",
            ],
        ),
    ]


def _bridge(ctx: _Ctx) -> dict:
    scope = ctx.scope
    base = {"available": False, "month": None, "previousMonth": None, "steps": []}
    if ctx.ym is None:
        return envelope(base, scope=scope, provenance=_p_bridge(), notes=[NO_PAYROLL_NOTE])
    ym, prev = ctx.ym, _shift(ctx.ym, -1)
    base.update(month=_key(ym), monthLabel=_label(ym), previousMonth=_key(prev), previousLabel=_label(prev))
    now_rows, was_rows = _bridge_rows(scope, ym), _bridge_rows(scope, prev)
    if not now_rows or not was_rows:
        missing = _label(ym) if not now_rows else _label(prev)
        base["reason"] = f"There is no payroll for {missing} in this selection, so there is nothing to compare."
        return envelope(base, scope=scope, provenance=_p_bridge(), notes=[base["reason"]])
    before, after = _entities(was_rows), _entities(now_rows)
    amounts, people = _bridge_amounts(before, after)
    start = sum((e["gross"] for e in before.values()), ZERO)
    end = sum((e["gross"] for e in after.values()), ZERO)
    total = end - start
    # the guard that makes the bridge exact whatever the data: Other is whatever the named steps leave over
    named = sum((v for k, v in amounts.items() if k != "other"), ZERO)
    amounts["other"] = total - named
    steps = [
        {
            "id": key,
            "label": label,
            "amount": money(amounts[key]),
            "people": people[key],
            "detail": _BRIDGE_DETAIL[key],
        }
        for key, label in BRIDGE_STEPS
    ]
    driver = max((s for s in steps if s["amount"]), key=lambda s: abs(s["amount"]), default=None)
    unsplit = sum(1 for e in after.values() if e["types"] == {"staff"} and not e["ok"])
    states = _month_states(scope, [ym, prev], ctx.today, ctx.available)
    notes = []
    if states[ym]["provisionalSlips"]:
        notes.append(_provisional_note(states[ym]["provisionalSlips"], ym, ctx.ended))
    now_periods, was_periods = states[ym]["productionPeriods"], states[prev]["productionPeriods"]
    if now_periods and was_periods and now_periods != was_periods:
        notes.append(
            f"{_plural(now_periods, 'production pay period')} ended in {_label(ym)} against {was_periods} in {_label(prev)}; "
            "production pay moves with the number of periods, which shows up under attendance."
        )
    if ctx.ended:
        notes.extend(_type_gap_note(g, ym) for g in _type_gaps(_agg_rows(scope, [ym, prev], ("type",)), ym))
    if unsplit:
        notes.append(
            f"{_plural(unsplit, 'staff slip')} for {_label(ym)} {'has' if unsplit == 1 else 'have'} no saved "
            f"calculation breakdown, so {'its' if unsplit == 1 else 'their'} change cannot be split into pay rate and "
            "attendance and sits under Other."
        )
    return envelope(
        {
            **base,
            "available": True,
            "start": {"label": f"{_label(prev)} gross pay", "amount": money(start)},
            "end": {"label": f"{_label(ym)} gross pay", "amount": money(end)},
            "change": change(money(end), money(start)),
            "steps": steps,
            "sumOfSteps": money(sum((amounts[k] for k, _ in BRIDGE_STEPS), ZERO)),
            "mainDriver": {"id": driver["id"], "label": driver["label"], "amount": driver["amount"]}
            if driver
            else None,
            "productionPeriods": {"previous": was_periods, "current": now_periods},
            "provisionalSlips": states[ym]["provisionalSlips"],
        },
        scope=scope,
        provenance=[*_p_bridge(), _p_gross(), _p_provisional()],
        notes=notes,
    )


@cached()
def payroll_bridge(scope: Scope, month: str | None = None) -> dict:
    """Walk last month's gross pay to this month's: joiners, leavers, pay-rate changes, overtime, attendance, one-offs."""
    return _bridge(_context(scope, month))


# ─── departments, units, staff vs production ────────────────────────────────────────────────────────────────────


def _compare(rows: list[dict], cur: Ym, prev: Ym, ident: Sequence[str]) -> list[dict]:
    """Group the rows of two months by ``ident`` into {"row": a sample row, "cur": raw sums, "prev": raw sums}."""
    groups: dict[tuple, dict] = {}
    for r in rows:
        ym = (r["year"], r["month"])
        g = groups.setdefault(tuple(r[f] for f in ident), {"row": r, "cur": None, "prev": None})
        g["cur" if ym == cur else "prev"] = _raw(r)
    return list(groups.values())


def _group_line(g: dict, total_gross: Decimal) -> dict | None:
    if g["cur"] is None:
        return None
    cur = _figures(g["cur"])
    prev = _figures(g["prev"]) if g["prev"] is not None else None
    return {
        **{
            k: cur[k]
            for k in (
                "headcount",
                "grossPay",
                "netPay",
                "overtimePay",
                "overtimeSharePct",
                "costPerHead",
                "lopDays",
                "employerCost",
            )
        },
        "sharePct": pct(float(g["cur"]["salary"] + g["cur"]["ot"]), float(total_gross)),
        "previous": {k: prev[k] for k in ("headcount", "grossPay", "costPerHead")} if prev else None,
        "change": {
            "grossPay": change(cur["grossPay"], prev["grossPay"]),
            "costPerHead": change(cur["costPerHead"], prev["costPerHead"]),
            "headcount": change(cur["headcount"], prev["headcount"]),
        }
        if prev
        else None,
    }


def _p_departments() -> list[dict]:
    return [
        prov(
            "departments",
            "Cost by department, unit and type",
            dataset="Salary slips",
            definition=(
                "The month's slips grouped by the employee's department, unit, or by staff / production (decided by the "
                "slip). Cost per head is gross pay divided by the people paid in that group; overtime % is overtime "
                "divided by gross pay; the change compares with the previous month."
            ),
            formula="cost per head = gross pay / people paid; overtime % = overtime / gross pay x 100",
            caveats=[
                "Department and unit are each person's CURRENT ones: a transferred employee is counted wholly where "
                "they belong today.",
                "People with no department appear as 'Unassigned'.",
            ],
        ),
        _p_lop(),
    ]


def _departments(ctx: _Ctx, limit: int) -> dict:
    scope = ctx.scope
    empty = {"hasData": False, "month": None, "departments": [], "departmentsTotal": 0, "units": [], "types": []}
    if ctx.ym is None:
        return envelope(empty, scope=scope, provenance=_p_departments(), notes=[NO_PAYROLL_NOTE])
    ym, prev = ctx.ym, _shift(ctx.ym, -1)
    pairs = [ym, prev]
    dept_rows = _agg_rows(scope, pairs, ("dept",))
    unit_rows = _agg_rows(scope, pairs, ("branch",))
    type_rows = _agg_rows(scope, pairs, ("type",))
    total = _sum_raw(_raw(r) for r in dept_rows if (r["year"], r["month"]) == ym)
    total_gross = total["salary"] + total["ot"]

    departments = []
    for g in _compare(dept_rows, ym, prev, ("employee__department_id",)):
        line = _group_line(g, total_gross)
        if line is None:
            continue
        r = g["row"]
        departments.append(
            {
                "id": r["employee__department_id"],
                "name": r["employee__department__name"] or "Unassigned",
                "unit": r["employee__department__branch__name"],
                **line,
            }
        )
    departments.sort(key=lambda d: (-d["grossPay"], d["name"]))
    units = []
    for g in _compare(unit_rows, ym, prev, ("employee__branch_id",)):
        line = _group_line(g, total_gross)
        if line is not None:
            units.append(
                {"id": g["row"]["employee__branch_id"], "name": g["row"]["employee__branch__name"] or "No unit", **line}
            )
    units.sort(key=lambda u: (-u["grossPay"], u["name"]))
    types = []
    for g in _compare(type_rows, ym, prev, ("stype",)):
        line = _group_line(g, total_gross)
        if line is not None:
            types.append(
                {
                    "id": g["row"]["stype"],
                    "name": "Production" if g["row"]["stype"] == "production" else "Staff",
                    **line,
                }
            )
    types.sort(key=lambda t: (-t["grossPay"], t["name"]))

    notes = []
    if not departments:
        notes.extend(_empty_notes(ctx))
    elif len(departments) > limit:
        notes.append(f"The {limit} highest-cost of {len(departments)} departments are shown.")
    return envelope(
        {
            "hasData": bool(departments),
            "month": _key(ym),
            "monthLabel": _label(ym),
            "total": _figures(total) if departments else None,
            "departments": departments[:limit],
            "departmentsTotal": len(departments),
            "units": units,
            "types": types,
        },
        scope=scope,
        provenance=[*_p_departments(), _p_gross()],
        notes=notes,
    )


@cached()
def payroll_departments(scope: Scope, month: str | None = None, limit: int = 25) -> dict:
    """Cost, people paid, cost per head, overtime % and change vs last month by department, unit and staff/production."""
    return _departments(_context(scope, month), _clamp(limit, 1, 25))


# ─── distribution of pay ────────────────────────────────────────────────────────────────────────────────────────


def _k(n: int) -> str:
    return f"{n / 100_000:g} L" if n >= 100_000 else f"{n / 1_000:g}k"


def _band_label(index: int) -> str:
    if index == 0:
        return "Nil or negative"
    if index == 1:
        return f"Under ₹{_k(NET_BANDS[0])}"
    if index > len(NET_BANDS):
        return f"₹{_k(NET_BANDS[-1])}+"
    return f"₹{_k(NET_BANDS[index - 2])}–{_k(NET_BANDS[index - 1])}"


def _band_of(net: Decimal) -> int:
    if net <= 0:
        return 0
    for i, edge in enumerate(NET_BANDS):
        if net < edge:
            return i + 1
    return len(NET_BANDS) + 1


def _p_distribution() -> dict:
    return prov(
        "distribution",
        "How take-home pay is spread",
        dataset="Salary slips",
        definition=(
            "Each person's net pay for the month (their slips added together) placed in a band. Only counts are shown, "
            "never a person. The designation ranking adds up gross pay by the employee's current designation."
        ),
        formula="bands: " + ", ".join(f"under {_k(e)}" for e in NET_BANDS[:3]) + ", ... (upper edges in the response)",
        caveats=[
            "Production pay depends on the pay periods that end in the month and on shifts worked, so it is lower and more variable than staff pay.",
        ],
    )


def _distribution(ctx: _Ctx, limit: int) -> dict:
    scope = ctx.scope
    empty = {"hasData": False, "month": None, "bands": [], "stats": None, "byDesignation": [], "designationsTotal": 0}
    if ctx.ym is None:
        return envelope(empty, scope=scope, provenance=[_p_distribution()], notes=[NO_PAYROLL_NOTE])
    ym = ctx.ym
    qs = _slips(scope, [ym]).annotate(stype=SLIP_TYPE_SQL).order_by()
    per = list(qs.values("employee_id", "stype").annotate(net=_sum("net_salary")))
    if not per:
        return envelope(
            {**empty, "month": _key(ym), "monthLabel": _label(ym)},
            scope=scope,
            provenance=[_p_distribution()],
            notes=_empty_notes(ctx),
        )
    company: dict[int, Decimal] = defaultdict(lambda: ZERO)
    for r in per:
        company[r["employee_id"]] += _dec(r["net"])
    counts = [{"staff": 0, "production": 0, "all": 0} for _ in range(len(NET_BANDS) + 2)]
    for r in per:
        counts[_band_of(_dec(r["net"]))][r["stype"]] += 1
    for net in company.values():
        counts[_band_of(net)]["all"] += 1
    bands = []
    for i, c in enumerate(counts):
        lo = None if i == 0 else (0 if i == 1 else NET_BANDS[i - 2])
        hi = None if i > len(NET_BANDS) else (0 if i == 0 else NET_BANDS[i - 1])
        bands.append(
            {
                "id": f"b{i}",
                "label": _band_label(i),
                "from": lo,
                "to": hi,
                "count": c["all"],
                "staff": c["staff"],
                "production": c["production"],
            }
        )
    nets = sorted(company.values())
    stats = {
        "people": len(nets),
        "average": money(sum(nets, ZERO) / len(nets)),
        "median": money(median(nets)),
        "lowest": money(nets[0]),
        "highest": money(nets[-1]),
        "belowTenThousand": sum(1 for n in nets if n < 10_000),
    }
    desig = list(
        _slips(scope, [ym])
        .order_by()
        .values("employee__designation_id", "employee__designation__title")
        .annotate(heads=Count("employee_id", distinct=True), salary=_sum("gross_salary"), ot=_sum("ot_amount"))
    )
    # By title, as the Employees page does: each department keeps its own "Machine Operator" record, and the MD means
    # the role. An employee has one designation, so adding the per-record head counts never counts anyone twice.
    by_title: dict[str, dict] = {}
    for d in desig:
        title = (d["employee__designation__title"] or "").strip() or "No designation"
        row = by_title.setdefault(title.lower(), {"designation": title, "heads": 0, "gross": ZERO})
        row["heads"] += int(d["heads"])
        row["gross"] += _dec(d["salary"]) + _dec(d["ot"])
    ranked = sorted(
        (
            {
                "designation": r["designation"],
                "headcount": r["heads"],
                "grossPay": money(r["gross"]),
                "averageGrossPay": money(r["gross"] / r["heads"]) if r["heads"] else None,
            }
            for r in by_title.values()
        ),
        key=lambda d: (-d["grossPay"], d["designation"]),
    )
    return envelope(
        {
            "hasData": True,
            "month": _key(ym),
            "monthLabel": _label(ym),
            "bands": bands,
            "stats": stats,
            "byDesignation": ranked[:limit],
            "designationsTotal": len(ranked),
        },
        scope=scope,
        provenance=[_p_distribution(), _p_net(), _p_gross()],
        notes=[],
    )


@cached()
def payroll_distribution(scope: Scope, month: str | None = None, limit: int = 10) -> dict:
    """How take-home pay is spread (bands, counts only) and gross pay by designation."""
    return _distribution(_context(scope, month), _clamp(limit, 1, 25))


# ─── components: what the money is made of ──────────────────────────────────────────────────────────────────────


def _line(key: str, label: str, cur: Decimal, prev: Decimal | None, total: Decimal, total_prev: Decimal | None) -> dict:
    return {
        "id": key,
        "label": label,
        "amount": money(cur),
        "previous": money(prev) if prev is not None else None,
        "change": change(money(cur), money(prev)) if prev is not None else None,
        "sharePct": pct(float(cur), float(total)),
    }


def _lines(spec: Sequence[tuple[str, str, str]], cur: dict, prev: dict | None, total_key: str) -> list[dict]:
    """``spec`` is (id, label, key in the raw sums or '=residual'); a line that is zero in both months is left out."""
    out = []
    for key, label, source in spec:
        c = cur[source]
        p = prev[source] if prev is not None else None
        if c == 0 and not p:
            continue
        total = cur[total_key]
        out.append(_line(key, label, c, p, total, prev[total_key] if prev is not None else None))
    return out


def _with_derived(t: dict[str, Decimal]) -> dict[str, Decimal]:
    """The raw sums plus the totals and residuals the component lines need."""
    gross = t["salary"] + t["ot"]
    other_earn = t["salary"] - t["basic"] - t["hra"] - t["allow"] - t["oneoff"]
    other_ded = t["ded"] - t["pf"] - t["esi"] - t["adv"] - t["late"]
    return {
        **t,
        "gross": gross,
        "other_earn": other_earn,
        "other_ded": other_ded,
        "net_calc": gross - t["ded"],
        "statutory_due": t["pf"] + t["esi"] + t["employer_pf"] + t["employer_esi"],
    }


def _bonus_block(scope: Scope, ym: Ym) -> dict | None:
    """The statutory bonus of the financial year the month falls in (Bonus table). It is NOT on the monthly slips."""
    start_month = fy_start_month()
    start_year = ym[0] if ym[1] >= start_month else ym[0] - 1
    label = f"{start_year}-{str(start_year + 1)[-2:]}"
    rows = (
        Bonus.objects.filter(scope.employee_q("employee__"), financial_year=label)
        .order_by()
        .values("status")
        .annotate(total=Sum("bonus_amount"), people=Count("employee_id", distinct=True))
    )
    by = {r["status"]: r for r in rows}
    if not by:
        return None

    def part(status: str) -> dict:
        r = by.get(status)
        return {"amount": money(r["total"]) if r else 0.0, "people": int(r["people"]) if r else 0}

    calculated, approved, paid = part("calculated"), part("approved"), part("paid")
    return {
        "financialYear": label,
        "calculated": calculated,
        "approved": approved,
        "paid": paid,
        "total": money(sum(_dec(r["total"]) for r in by.values())),
        "notPaid": money(_dec(by.get("calculated", {}).get("total")) + _dec(by.get("approved", {}).get("total"))),
    }


def _p_components() -> list[dict]:
    return [
        prov(
            "components",
            "What gross pay and deductions are made of",
            dataset="Salary slips",
            definition=(
                "Earnings: basic, HRA, allowances, incentives and bonuses, and overtime, as stored on the slips; "
                "anything the slip does not itemise shows as 'Not itemised'. Deductions: PF, ESI, advance recovery, "
                "late deduction and anything else. Each line shows the previous month and its share of the total."
            ),
            caveats=[
                "Production slips store the whole period wage under Basic (there is no HRA or allowance split), so a "
                "company with production staff shows their wages in Basic.",
                "Income tax (TDS) and arrears are not recorded in this system.",
            ],
        ),
        _p_deductions(),
        _p_employer(),
        prov(
            "statutory-due",
            "Statutory dues (estimate)",
            dataset="Salary slips + statutory rates",
            definition=(
                "What is due to the PF and ESI authorities for the month: the amounts deducted from employees plus the "
                "employer's estimated share."
            ),
            formula="statutory dues = employee PF + employee ESI + employer PF (est.) + employer ESI (est.)",
            caveats=["The employer shares are estimates: no PF wage cap, EDLI or administration charges."],
        ),
        prov(
            "statutory-bonus",
            "Statutory bonus",
            dataset="Bonus register",
            definition=(
                "The statutory bonus worked out for the financial year the month falls in. It is paid outside the "
                "monthly slips, and 'Paid' is a flag HR sets by hand."
            ),
        ),
    ]


_EARNING_SPEC = (
    ("basic", "Basic pay", "basic"),
    ("hra", "HRA", "hra"),
    ("allowances", "Allowances", "allow"),
    ("oneoffs", "Incentives and bonuses", "oneoff"),
    ("other-earnings", "Not itemised on the slip", "other_earn"),
    ("overtime", "Overtime", "ot"),
)
_DEDUCTION_SPEC = (
    ("pf", "Provident fund (PF)", "pf"),
    ("esi", "ESI", "esi"),
    ("advance", "Advance recovery", "adv"),
    ("late", "Late-arrival deduction", "late"),
    ("other-deductions", "Other deductions", "other_ded"),
)
_EMPLOYER_SPEC = (
    ("employer-pf", "Employer PF (estimate)", "employer_pf"),
    ("employer-esi", "Employer ESI (estimate)", "employer_esi"),
)


def _components(ctx: _Ctx) -> dict:
    scope = ctx.scope
    empty = {"hasData": False, "month": None, "earnings": [], "deductions": [], "employer": []}
    if ctx.ym is None:
        return envelope(empty, scope=scope, provenance=_p_components(), notes=[NO_PAYROLL_NOTE])
    ym, prev = ctx.ym, _shift(ctx.ym, -1)
    raw = _month_raw(scope, [ym, prev])
    if ym not in raw:
        return envelope(
            {**empty, "month": _key(ym), "monthLabel": _label(ym)},
            scope=scope,
            provenance=_p_components(),
            notes=_empty_notes(ctx),
        )
    cur = _with_derived(raw[ym])
    was = _with_derived(raw[prev]) if prev in raw else None
    states = _month_states(scope, [ym], ctx.today, ctx.available)[ym]
    net_gap = cur["gross"] - cur["ded"] - cur["net"]
    notes = []
    if states["provisionalSlips"]:
        notes.append(_provisional_note(states["provisionalSlips"], ym, ctx.ended))
    if abs(net_gap) >= 1:
        notes.append(
            f"Net pay on the slips differs from gross pay less deductions by ₹{abs(net_gap):,.2f}: see the Report "
            "Center's 'Payroll vs Slip Reconciliation'."
        )
    return envelope(
        {
            "hasData": True,
            "month": _key(ym),
            "monthLabel": _label(ym),
            "previousMonth": _key(prev) if was is not None else None,
            "previousLabel": _label(prev) if was is not None else None,
            "earnings": _lines(_EARNING_SPEC, cur, was, "gross"),
            "grossPay": _line("gross", "Gross pay", cur["gross"], was["gross"] if was else None, cur["gross"], None),
            "deductions": _lines(_DEDUCTION_SPEC, cur, was, "ded"),
            "totalDeductions": _line(
                "deductions", "Total deductions", cur["ded"], was["ded"] if was else None, cur["gross"], None
            ),
            "netPay": _line("net", "Net pay", cur["net"], was["net"] if was else None, cur["gross"], None),
            "employer": [
                _line(k, label, cur[src], was[src] if was else None, cur["gross"], None)
                for k, label, src in _EMPLOYER_SPEC
            ],
            "employerCost": _line(
                "employer-cost",
                "Employer cost (estimate)",
                cur["gross"] + cur["employer_pf"] + cur["employer_esi"],
                (was["gross"] + was["employer_pf"] + was["employer_esi"]) if was else None,
                cur["gross"],
                None,
            ),
            "statutoryDue": money(cur["statutory_due"]),
            "payable": {"slips": states["unpaidSlips"], "netPay": states["unpaidNet"]},
            "statutoryBonus": _bonus_block(scope, ym),
            "netGap": money(net_gap),
        },
        scope=scope,
        provenance=[*_p_components(), _p_gross(), _p_net()],
        notes=notes,
    )


@cached()
def payroll_components(scope: Scope, month: str | None = None) -> dict:
    """Earnings and deductions by head (basic, HRA, overtime, PF, ESI, advances...) with the previous month."""
    return _components(_context(scope, month))


# ─── advances: money lent to employees and not yet recovered ────────────────────────────────────────────────────


def _inr(value: float | Decimal, places: int = 0) -> str:
    """₹ with Indian grouping (12,34,567), for the sentences the screen and the assistant read out."""
    v = round(float(value), places)
    sign = "-" if v < 0 else ""
    whole, _, frac = f"{abs(v):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join([*parts, tail])
    return f"{sign}₹{whole}{'.' + frac if places else ''}"


def _inr_compact(value: float | Decimal) -> str:
    """₹45,200 · ₹12.4 L · ₹1.25 Cr (the same shortening as the screen's inrCompact)."""
    v = float(value)
    sign = "-" if v < 0 else ""
    a = abs(v)
    if a >= 1e7:
        return f"{sign}₹{round(a / 1e7, 2):g} Cr"
    if a >= 1e5:
        return f"{sign}₹{round(a / 1e5, 1):g} L"
    return _inr(v)


def _p_advances() -> list[dict]:
    return [
        prov(
            "advances-outstanding",
            "Advances outstanding",
            dataset="Advances and their instalments",
            definition=(
                "Approved advances and term loans still to be recovered: the sanctioned amount less the instalments "
                "payroll has actually deducted (the Report Center's rule; the balance stored on the advance is not "
                "used because it is never updated for pending requests). Closed advances carry no balance."
            ),
            formula="outstanding = sanctioned amount - instalments deducted",
            caveats=["The system records no disbursement date: the sanction date is used for 'new' and for ageing."],
        ),
        prov(
            "advances-month",
            "Advances given and recovered in the month",
            dataset="Advances and their instalments",
            definition=(
                "New = advances sanctioned in the month. Recovered = instalments marked deducted for the month. The "
                "advance recovery shown on the slips is a cross-check: when payroll was regenerated after an instalment "
                "was processed, the slip can miss the deduction (a known defect), and the two figures differ."
            ),
        ),
        prov(
            "advances-ageing",
            "Advance ageing",
            dataset="Advances and their instalments",
            definition=(
                "Outstanding balances grouped by how long ago the advance was sanctioned. Overdue instalments are those "
                "scheduled for an earlier month than this one and not deducted; balances with employees who have left "
                "must be recovered in their final settlement."
            ),
        ),
    ]


def _count_amount(agg: dict, people_key: str = "people") -> dict:
    return {
        "amount": money(agg.get("amount")),
        "count": int(agg.get("n") or 0),
        "people": int(agg.get(people_key) or 0),
    }


def _advances(ctx: _Ctx) -> dict:
    scope, today = ctx.scope, ctx.today
    ym = ctx.ym or (today.year, today.month)
    emp_q = scope.employee_q("employee__")
    open_rows = list(
        Advance.objects.filter(emp_q, status="approved")
        .annotate(
            repaid=Coalesce(
                Sum("repayments__amount", filter=Q(repayments__is_processed=True), output_field=DEC),
                Value(ZERO, output_field=DEC),
            )
        )
        .order_by()
        .values(
            "id", "employee_id", "employee__status", "advance_type", "amount", "repaid", "approved_at", "created_at"
        )
    )
    outstanding = ZERO
    borrowers: set[int] = set()
    by_type: dict[str, dict] = {"general": {"amount": ZERO, "n": 0}, "term": {"amount": ZERO, "n": 0}}
    left_amount, left_people = ZERO, set()
    ageing = [{"label": label, "amount": ZERO, "advances": 0} for _, label in AGEING_BUCKETS]
    for r in open_rows:
        balance = max(ZERO, _dec(r["amount"]) - _dec(r["repaid"]))
        if balance <= 0:
            continue
        outstanding += balance
        borrowers.add(r["employee_id"])
        slot = by_type.setdefault(r["advance_type"], {"amount": ZERO, "n": 0})
        slot["amount"] += balance
        slot["n"] += 1
        if (r["employee__status"] or "").lower() != "active":
            left_amount += balance
            left_people.add(r["employee_id"])
        since = r["approved_at"] or r["created_at"]
        age = max(0, (today - timezone.localtime(since, FACTORY_TZ).date()).days) if since else 0
        for i, (limit, _) in enumerate(AGEING_BUCKETS):
            if limit is None or age <= limit:
                ageing[i]["amount"] += balance
                ageing[i]["advances"] += 1
                break
    n_open = sum(v["n"] for v in by_type.values())

    first, last = month_bounds(*ym)
    new = (
        Advance.objects.filter(emp_q, status__in=("approved", "closed"))
        .filter(ist_range_q("approved_at", first, last))
        .aggregate(amount=Sum("amount"), n=Count("id"), people=Count("employee_id", distinct=True))
    )
    repay_q = scope.employee_q("advance__employee__")
    recovered = AdvanceRepayment.objects.filter(repay_q, is_processed=True, year=ym[0], month=ym[1]).aggregate(
        amount=Sum("amount"), n=Count("id"), people=Count("advance__employee_id", distinct=True)
    )
    overdue = (
        AdvanceRepayment.objects.filter(repay_q, advance__status="approved", is_processed=False)
        .filter(Q(year__lt=today.year) | Q(year=today.year, month__lt=today.month))
        .aggregate(amount=Sum("amount"), n=Count("id"), people=Count("advance__employee_id", distinct=True))
    )
    on_slips = _slips(scope, [ym]).aggregate(total=Sum("advance_deduction"))["total"]
    new_amount, recovered_amount = _dec(new["amount"]), _dec(recovered["amount"])
    gap = _dec(on_slips) - recovered_amount
    notes = []
    if abs(gap) >= 1:
        notes.append(
            f"The slips of {_label(ym)} deducted {_inr(_dec(on_slips), 2)} for advances but the instalments marked "
            f"recovered add up to {_inr(recovered_amount, 2)}: payroll was probably regenerated after an instalment "
            "was processed. See the Report Center's 'Payroll vs Slip Reconciliation'."
        )
    has_data = bool(open_rows) or new_amount > 0 or recovered_amount > 0
    if not has_data:
        notes.append("No advances or loans are outstanding or moved in this selection.")
    return envelope(
        {
            "asOf": today.isoformat(),
            "month": _key(ym),
            "monthLabel": _label(ym),
            "hasData": has_data,
            "outstanding": {
                "amount": money(outstanding),
                "advances": n_open,
                "borrowers": len(borrowers),
                "average": money(outstanding / len(borrowers)) if borrowers else None,
                "general": {"amount": money(by_type["general"]["amount"]), "advances": by_type["general"]["n"]},
                "term": {"amount": money(by_type["term"]["amount"]), "advances": by_type["term"]["n"]},
            },
            "newThisMonth": _count_amount(new),
            "recoveredThisMonth": _count_amount(recovered),
            "netMovement": money(new_amount - recovered_amount),
            "deductedOnSlips": money(on_slips),
            "recoveryGap": money(gap),
            "overdue": _count_amount(overdue),
            "exEmployees": {"amount": money(left_amount), "borrowers": len(left_people)},
            "ageing": [{"label": a["label"], "amount": money(a["amount"]), "advances": a["advances"]} for a in ageing],
        },
        scope=scope,
        provenance=_p_advances(),
        notes=notes,
    )


@cached()
def payroll_advances(scope: Scope, month: str | None = None) -> dict:
    """Advances outstanding today (total, borrowers, ageing, overdue, with ex-employees) and the month's new and recovered."""
    return _advances(_context(scope, month))


# ─── exceptions: the rows an MD should look at ──────────────────────────────────────────────────────────────────

EXCEPTION_KINDS: dict[str, tuple[str, str]] = {
    "negative-net": ("Negative net pay", "critical"),
    "duplicate-slip": ("Duplicate slips", "critical"),
    "zero-net": ("Zero net pay", "warning"),
    "paid-zero-days": ("Paid for zero days", "warning"),
    "no-slip": ("No salary slip", "warning"),
    "pay-outlier": ("Far above department median", "warning"),
    "pay-swing": ("Large change on last month", "info"),
}
_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}
_KIND_RANK = {k: i for i, k in enumerate(EXCEPTION_KINDS)}
# The kinds as the tail of "<count> ..." in a sentence ("2 with no salary slip"), where the table label ("No salary
# slip") would read as a heading.
_KIND_PHRASE = {
    "negative-net": "with negative net pay",
    "duplicate-slip": "with duplicate slips",
    "zero-net": "with zero net pay",
    "paid-zero-days": "paid for zero days",
    "no-slip": "with no salary slip",
    "pay-outlier": "far above their department median",
    "pay-swing": "with a large change on last month",
}


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one}" if n == 1 else f"{n:,} {many or one + 's'}"


def _ordinal(n: int) -> str:
    """1st, 2nd, 3rd, 4th, 11th, 21st: the salary day is read aloud as well as shown."""
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _thresholds() -> dict:
    return {
        "variancePct": VARIANCE_PCT,
        "varianceMinRupees": VARIANCE_MIN_RUPEES,
        "outlierMultiple": OUTLIER_MULTIPLE,
        "outlierMinPeers": OUTLIER_MIN_PEERS,
    }


def _p_exceptions() -> dict:
    return prov(
        "exceptions",
        "Payroll exceptions",
        dataset="Salary slips, employees",
        definition=(
            "Rows worth a second look in the month. Negative or zero net pay; two staff slips for one person in the "
            "month; pay for zero days worked; an active employee with a salary on file but no slip in a month that has "
            f"ended; gross pay more than {OUTLIER_MULTIPLE:g} times the median of the person's department and type "
            f"(needs {OUTLIER_MIN_PEERS}+ people); gross pay {VARIANCE_PCT:g}% or more above or below last month's "
            f"(by at least {_inr(VARIANCE_MIN_RUPEES)})."
        ),
        filters=[
            f"Thresholds: change {VARIANCE_PCT:g}%, outlier {OUTLIER_MULTIPLE:g}x median, {OUTLIER_MIN_PEERS}+ peers",
            "'No slip' counts only types of payroll that were generated for the month, and only once it has ended",
        ],
        caveats=[
            "A finding is a prompt to check, not proof of an error. Production pay is compared with last month only "
            "when the same number of pay periods ended in both months.",
            "Employees with no salary on file are skipped by payroll and are not listed as 'No slip'.",
        ],
    )


def _person(r: dict) -> dict:
    """The person columns of a slip row (see _exception_slips)."""
    first, last = r.get("employee__first_name") or "", r.get("employee__last_name") or ""
    return {
        "employeeId": r["employee_id"],
        "name": f"{first} {last}".strip(),
        "code": r.get("employee__employee_code"),
        "department": r.get("employee__department__name") or "Unassigned",
    }


def _exception_slips(scope: Scope, ym: Ym) -> list[dict]:
    qs = _slips(scope, [ym]).annotate(stype=SLIP_TYPE_SQL, eff_days=_EFFECTIVE_DAYS, tot_shifts=_TOTAL_SHIFTS)
    return list(
        qs.order_by("employee__employee_code", "id").values(
            "id",
            "employee_id",
            "employee__employee_code",
            "employee__first_name",
            "employee__last_name",
            "employee__department__name",
            "stype",
            "gross_salary",
            "ot_amount",
            "net_salary",
            "total_deductions",
            "present_days",
            "paid_leave_days",
            "eff_days",
            "tot_shifts",
        )
    )


def _exceptions(ctx: _Ctx, limit: int, kind: str | None) -> dict:
    scope = ctx.scope
    base = {
        "hasData": False,
        "month": None,
        "total": 0,
        "counts": {},
        "kinds": [],
        "rows": [],
        "thresholds": _thresholds(),
    }
    if kind and kind not in EXCEPTION_KINDS:
        raise MdParamError(f"'{kind}' is not a kind of exception. Use one of: {', '.join(EXCEPTION_KINDS)}.")
    if ctx.ym is None:
        return envelope(base, scope=scope, provenance=[_p_exceptions()], notes=[NO_PAYROLL_NOTE])
    ym, prev = ctx.ym, _shift(ctx.ym, -1)
    slips = _exception_slips(scope, ym)
    base.update(month=_key(ym), monthLabel=_label(ym))
    if not slips and not ctx.ended:
        return envelope(base, scope=scope, provenance=[_p_exceptions()], notes=_empty_notes(ctx))

    found: list[dict] = []

    def add(
        kind_: str, person: dict, type_: str, detail: str, gross=None, net=None, compare=None, change_pct=None
    ) -> None:
        label, severity = EXCEPTION_KINDS[kind_]
        found.append(
            {
                **person,
                "type": "Production" if type_ == "production" else "Staff",
                "kind": kind_,
                "kindLabel": label,
                "severity": severity,
                "detail": detail,
                "grossPay": money(gross) if gross is not None else None,
                "netPay": money(net) if net is not None else None,
                "compare": compare,
                "changePct": change_pct,
            }
        )

    by_emp: dict[int, dict] = {}
    for r in slips:
        gross_total = _dec(r["gross_salary"]) + _dec(r["ot_amount"])
        net, person = _dec(r["net_salary"]), _person(r)
        e = by_emp.setdefault(
            r["employee_id"], {"person": person, "types": set(), "gross": ZERO, "net": ZERO, "staff_slips": 0}
        )
        e["types"].add(r["stype"])
        e["gross"] += gross_total
        e["net"] += net
        e["staff_slips"] += r["stype"] == "staff"
        if net < 0:
            add(
                "negative-net",
                person,
                r["stype"],
                f"Deductions of {_inr(_dec(r['total_deductions']), 2)} exceed gross pay of {_inr(gross_total, 2)}.",
                gross_total,
                net,
            )
        elif net == 0:
            add(
                "zero-net",
                person,
                r["stype"],
                f"Net pay is zero (gross pay {_inr(gross_total, 2)}, deductions {_inr(_dec(r['total_deductions']), 2)}).",
                gross_total,
                net,
            )
        paid_days = (
            (r["tot_shifts"] if r["tot_shifts"] is not None else _dec(r["present_days"]))
            if r["stype"] == "production"
            else (r["eff_days"] if r["eff_days"] is not None else _dec(r["present_days"]) + _dec(r["paid_leave_days"]))
        )
        if _dec(r["gross_salary"]) > 0 and paid_days == 0:
            add(
                "paid-zero-days",
                person,
                r["stype"],
                f"Gross pay of {_inr(gross_total, 2)} on a slip that counts no days or shifts worked.",
                gross_total,
                net,
            )

    for e in by_emp.values():
        if e["staff_slips"] > 1:
            add(
                "duplicate-slip",
                e["person"],
                "staff",
                f"{e['staff_slips']} staff slips for the same month: this person's pay is counted {e['staff_slips']} times in the totals.",
                e["gross"],
                e["net"],
            )

    # pay far above the department's median (needs enough peers of the same type for a median to mean something)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in by_emp.values():
        if len(e["types"]) == 1:
            groups[(e["person"]["department"], next(iter(e["types"])))].append(e)
    for (dept, type_), members in groups.items():
        if len(members) < OUTLIER_MIN_PEERS:
            continue
        mid = median(m["gross"] for m in members)
        if mid <= 0:
            continue
        for m in members:
            if m["gross"] > Decimal(str(OUTLIER_MULTIPLE)) * mid:
                add(
                    "pay-outlier",
                    m["person"],
                    type_,
                    f"Gross pay {_inr(m['gross'])} is {float(m['gross'] / mid):.1f} times the {type_} median of "
                    f"{_inr(mid)} in {dept}.",
                    m["gross"],
                    m["net"],
                    compare={"label": "Department median", "amount": money(mid)},
                )

    # month-on-month swings per person
    states = _month_states(scope, [ym, prev], ctx.today, ctx.available)
    periods_differ = states[ym]["productionPeriods"] != states[prev]["productionPeriods"]
    before: dict[int, dict] = {}
    for r in (
        _slips(scope, [prev])
        .annotate(stype=SLIP_TYPE_SQL)
        .order_by()
        .values("employee_id", "stype")
        .annotate(salary=_sum("gross_salary"), ot=_sum("ot_amount"))
    ):
        slot = before.setdefault(r["employee_id"], {"types": set(), "gross": ZERO})
        slot["types"].add(r["stype"])
        slot["gross"] += _dec(r["salary"]) + _dec(r["ot"])
    skipped_production = 0
    for emp_id, e in by_emp.items():
        was = before.get(emp_id)
        if was is None or was["types"] != e["types"] or len(e["types"]) != 1 or was["gross"] <= 0:
            continue
        type_ = next(iter(e["types"]))
        if type_ == "production" and periods_differ:
            skipped_production += 1
            continue
        delta = e["gross"] - was["gross"]
        change_pct = pct(float(delta), float(was["gross"]))
        if change_pct is not None and abs(change_pct) >= VARIANCE_PCT and abs(float(delta)) >= VARIANCE_MIN_RUPEES:
            add(
                "pay-swing",
                e["person"],
                type_,
                f"Gross pay {'up' if delta > 0 else 'down'} {abs(change_pct):.0f}%: {_inr(was['gross'])} last month, "
                f"{_inr(e['gross'])} this month.",
                e["gross"],
                e["net"],
                compare={"label": f"{_label(prev)} gross pay", "amount": money(was["gross"])},
                change_pct=change_pct,
            )

    # active employees with a salary on file and no slip in a month that has ended
    no_salary = types_missing = 0
    if ctx.ended:
        company_types = set(
            SalarySlip.objects.filter(year=ym[0], month=ym[1], week_number__isnull=True)
            .annotate(stype=SLIP_TYPE_SQL)
            .order_by()
            .values_list("stype", flat=True)
            .distinct()
        )
        have_slip = SalarySlip.objects.filter(year=ym[0], month=ym[1], week_number__isnull=True).values("employee_id")
        month_end = _end(ym)
        for e in (
            scope.employees(active=True)
            .exclude(pk__in=have_slip)
            .select_related("department")
            .order_by("employee_code")
            .only(
                "id",
                "employee_code",
                "first_name",
                "last_name",
                "department__name",
                "employment_type",
                "salary_amount",
                "salary_per_shift",
                "join_date",
            )
        ):
            type_ = "production" if e.employment_type == "production" else "staff"
            rate = e.salary_per_shift if type_ == "production" else e.salary_amount
            if not rate or rate <= 0:
                no_salary += 1
                continue
            if type_ not in company_types:
                types_missing += 1
                continue
            joined = parse_date(e.join_date)
            if joined is not None and joined > month_end:
                continue
            add(
                "no-slip",
                {
                    "employeeId": e.id,
                    "name": f"{e.first_name or ''} {e.last_name or ''}".strip(),
                    "code": e.employee_code,
                    "department": e.department.name if e.department_id else "Unassigned",
                },
                type_,
                f"Active employee with a salary on file and no salary slip for {_label(ym)}.",
            )

    found.sort(
        key=lambda f: (
            _SEVERITY_RANK[f["severity"]],
            _KIND_RANK[f["kind"]],
            -(f["grossPay"] or 0),
            f["code"] or "",
        )
    )
    counts = {k: 0 for k in EXCEPTION_KINDS}
    for f in found:
        counts[f["kind"]] += 1
    shown = [f for f in found if not kind or f["kind"] == kind]
    notes = []
    if not ctx.ended:
        notes.append(f"{_label(ym)} has not ended: employees without a slip are checked only once the month is over.")
    if skipped_production:
        notes.append(
            f"Production pay of {skipped_production} people was not compared with last month: a different number of "
            "pay periods ended in the two months."
        )
    if types_missing:
        notes.append(
            f"{_plural(types_missing, 'active employee')} {'belongs' if types_missing == 1 else 'belong'} to a kind "
            f"of payroll (staff or production) that has not been generated for {_label(ym)} at all: that is a status "
            "matter, not a missing slip per person."
        )
    if no_salary:
        notes.append(
            f"{_plural(no_salary, 'active employee')} {'has' if no_salary == 1 else 'have'} no salary on file, so "
            "payroll skips them."
        )
    return envelope(
        {
            **base,
            "hasData": bool(slips) or bool(found),
            "total": len(found),
            "people": len({f["employeeId"] for f in found}),
            "shown": min(len(shown), limit),
            "matching": len(shown),
            "counts": counts,
            "kinds": [
                {"id": k, "label": label, "severity": sev, "count": counts[k]}
                for k, (label, sev) in EXCEPTION_KINDS.items()
            ],
            "rows": shown[:limit],
        },
        scope=scope,
        provenance=[_p_exceptions(), _p_provisional()],
        notes=notes,
    )


@cached()
def payroll_exceptions(scope: Scope, month: str | None = None, limit: int = 10, kind: str | None = None) -> dict:
    """The month's payroll exceptions: zero/negative pay, duplicates, paid-for-zero-days, no slip, outliers, big swings."""
    return _exceptions(_context(scope, month), _clamp(limit, 1, 100), kind)


# ─── status: which months are paid, pending or still provisional ────────────────────────────────────────────────


def _status(ctx: _Ctx, months: int) -> dict:
    scope, today = ctx.scope, ctx.today
    current = (today.year, today.month)
    window = [_shift(current, -i) for i in range(months - 1, -1, -1)]
    states = _month_states(scope, window, today, ctx.available)
    closed = [x for x in ctx.available if _end(x) < today]
    return envelope(
        {
            "today": today.isoformat(),
            "currentMonth": _key(current),
            "defaultMonth": _key(ctx.ym) if ctx.ym else None,
            "latestClosedMonth": _key(closed[0]) if closed else None,
            "payDay": _pay_day(),
            "hasData": bool(ctx.available),
            "months": [states[ym] for ym in window],
            "available": [_key(x) for x in ctx.available],
        },
        scope=scope,
        provenance=[_p_status(), _p_provisional()],
        notes=[] if ctx.available else [NO_PAYROLL_NOTE],
    )


@cached()
def payroll_status(scope: Scope, months: int = 12) -> dict:
    """Which months have payroll, and whether each is paid, part paid, generated, in progress or provisional."""
    return _status(_context(scope, None), _clamp(months, 1, 36))


# ─── what needs the MD's attention ──────────────────────────────────────────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"payroll.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": "payroll",
        "ask": ask,
    }


def _due_status_items(ctx: _Ctx) -> list[dict]:
    """Salary day has passed and the month is not generated or not marked paid. Looks at the month before this one (the
    salary that is due now) and at the month being shown, when that is a different one."""
    today = ctx.today
    last_ended = _shift((today.year, today.month), -1)
    wanted = [last_ended] + ([ctx.ym] if ctx.ym and ctx.ym != last_ended and _end(ctx.ym) < today else [])
    states = _month_states(ctx.scope, wanted, today, ctx.available)
    pay_day = _pay_day()
    out = []
    for ym in wanted:
        st = states[ym]
        due = date(*_shift(ym, 1), pay_day)
        late = (today - due).days
        if late <= 0:
            continue
        severity = "critical" if late > PAY_DAY_CRITICAL_DAYS else "warning"
        label = _label(ym)
        if st["state"] == "not_generated":
            out.append(
                _item(
                    f"not-generated-{_key(ym)}",
                    severity,
                    f"Payroll for {label} has not been generated",
                    f"Salary day is the {_ordinal(pay_day)}; it is {_plural(late, 'day')} past.",
                    f"{late} days late",
                    f"Payroll for {label} has no salary slips. Which months have payroll and what is pending?",
                )
            )
        elif st["state"] in ("generated", "part_paid"):
            out.append(
                _item(
                    f"unpaid-{_key(ym)}",
                    severity,
                    f"{st['unpaidSlips']} of {st['slips']} slips for {label} are not marked paid",
                    f"Salary day was the {_ordinal(pay_day)}, {_plural(late, 'day')} ago. {_inr(st['unpaidNet'])} net pay is not "
                    "yet marked paid.",
                    _inr_compact(st["unpaidNet"]),
                    f"Which {label} salary slips are still not marked paid, and for how much?",
                )
            )
        if st["provisionalSlips"] and st["state"] != "in_progress":
            out.append(
                _item(
                    f"provisional-{_key(ym)}",
                    "warning",
                    f"{st['provisionalSlips']} staff slips for {label} were generated before the month ended",
                    "They count the days still to come as absent, so they understate pay. Regenerate payroll for the month.",
                    f"{st['provisionalSlips']} slips",
                    f"Why are some {label} staff slips provisional and how much pay do they understate?",
                )
            )
    return out


def _attention(ctx: _Ctx) -> list[dict]:
    """The findings of a month, most severe first. Used by the page's 'Needs your attention' (any scope and month) and,
    company-wide for the latest closed month, by the Dashboard's insights()."""
    if ctx.ym is None:
        return []
    items = _due_status_items(ctx)
    summary = _summary(ctx)
    cur, ch = summary.get("totals"), summary.get("change")
    ym = ctx.ym
    label, prev_label = _label(ym), _label(_shift(ym, -1))
    for gap in summary.get("typeGaps") or []:
        items.append(
            _item(
                f"incomplete-{gap['type']}",
                "warning",
                f"{gap['type'].title()} payroll for {label} has not been generated",
                f"{prev_label} had {gap['headcount']} {gap['type']} people ({_inr_compact(gap['grossPay'])}): they are "
                "missing from this month's cost until it is generated.",
                f"{gap['headcount']} people",
                f"Why is there no {gap['type']} payroll for {label}, and how much is missing?",
            )
        )
    if cur and ch and ch["grossPay"] and ch["grossPay"]["pct"] is not None:
        move = ch["grossPay"]["pct"]

        def why() -> str:
            """The bridge's biggest step, named: only worked out when there is a jump or a drop to explain."""
            driver = _bridge(ctx).get("mainDriver")
            if not driver:
                return "See the cost bridge for the reasons."
            sign = "+" if driver["amount"] > 0 else "-"
            return f"Mainly {driver['label'].lower()} ({sign}{_inr_compact(abs(driver['amount']))})."

        if move >= COST_JUMP_WARN_PCT:
            items.append(
                _item(
                    "cost-jump",
                    "critical" if move >= COST_JUMP_CRITICAL_PCT else "warning",
                    f"Payroll cost rose {move:.1f}% to {_inr_compact(cur['grossPay'])} in {label}",
                    f"Up {_inr_compact(ch['grossPay']['abs'])} on {prev_label}. {why()}",
                    f"+{move:.1f}%",
                    f"Why did payroll cost rise in {label} compared with {prev_label}?",
                )
            )
        elif move <= -COST_DROP_WARN_PCT:
            items.append(
                _item(
                    "cost-drop",
                    "warning",
                    f"Payroll cost fell {abs(move):.1f}% to {_inr_compact(cur['grossPay'])} in {label}",
                    f"Down {_inr_compact(abs(ch['grossPay']['abs']))} on {prev_label}. {why()} Check nobody was left off payroll.",
                    f"{move:.1f}%",
                    f"Why did payroll cost fall in {label} compared with {prev_label}? Was anyone left off?",
                )
            )
    if cur and cur["overtimeSharePct"] is not None:
        share = cur["overtimeSharePct"]
        before = summary["previous"]["totals"]["overtimeSharePct"] if summary.get("previous") else None
        rising = before is not None and share - before >= OT_SHARE_RISE_PTS and share >= OT_SHARE_WARN_PCT
        if rising or share >= OT_SHARE_HIGH_PCT:
            items.append(
                _item(
                    "overtime",
                    "warning",
                    f"Overtime is {share:.1f}% of payroll in {label} ({_inr_compact(cur['overtimePay'])})",
                    (f"Up from {before:.1f}% in {prev_label}." if before is not None else "")
                    + " Overtime is paid outside salary, PF and ESI.",
                    f"{share:.1f}%",
                    f"Why is overtime {share:.1f}% of payroll in {label}, and which departments drive it?",
                )
            )
    exc = _exceptions(ctx, 0, None)
    if exc["total"]:
        critical = sum(c for k, c in exc["counts"].items() if EXCEPTION_KINDS[k][1] == "critical")
        warned = sum(c for k, c in exc["counts"].items() if EXCEPTION_KINDS[k][1] == "warning")
        parts = [f"{c:,} {_KIND_PHRASE[k]}" for k, c in exc["counts"].items() if c]
        items.append(
            _item(
                "exceptions",
                "critical"
                if critical
                else "warning"
                if warned
                else "info",  # a month of only big swings is not an alarm
                f"{_plural(exc['total'], 'payroll exception')} in {label}",
                ", ".join(parts[:4]) + ".",
                _plural(exc["people"], "person", "people"),
                f"What are the payroll exceptions in {label} and which people are involved?",
            )
        )
    adv = _advances(ctx)
    growth = adv["netMovement"]
    held = adv["outstanding"]["amount"]
    if growth > 0 and held and growth / held * 100 >= ADVANCE_GROWTH_PCT:
        items.append(
            _item(
                "advances",
                "warning",
                f"Advances outstanding grew {_inr_compact(growth)} in {label}",
                f"{_inr_compact(adv['newThisMonth']['amount'])} given, {_inr_compact(adv['recoveredThisMonth']['amount'])} recovered; "
                f"{_inr_compact(held)} is now outstanding with {adv['outstanding']['borrowers']} people.",
                _inr_compact(held),
                f"Why did advances outstanding grow in {label} and who holds them?",
            )
        )
    if adv["exEmployees"]["amount"] > 0:
        items.append(
            _item(
                "advances-ex-employees",
                "warning",
                f"{_inr_compact(adv['exEmployees']['amount'])} of advances is held by people who have left",
                f"{_plural(adv['exEmployees']['borrowers'], 'former employee')} still "
                f"{'owes' if adv['exEmployees']['borrowers'] == 1 else 'owe'} money: recover it in their final settlement.",
                _inr_compact(adv["exEmployees"]["amount"]),
                "Which former employees still hold advances and how much?",
            )
        )
    per_head = ch["costPerHead"] if ch else None
    if cur and per_head and per_head["pct"] is not None and per_head["pct"] <= -COST_PER_HEAD_FALL_PCT:
        items.append(
            _item(
                "cost-per-head",
                "good",
                f"Cost per head fell {abs(per_head['pct']):.1f}% to {_inr_compact(cur['costPerHead'])}",
                f"{label} against {prev_label}, with {cur['headcount']} people paid.",
                f"{per_head['pct']:.1f}%",
                f"Why did cost per head fall in {label}?",
            )
        )
    return sorted(items, key=lambda i: {"critical": 0, "warning": 1, "info": 2, "good": 3}[i["severity"]])


@cached()
def payroll_attention(scope: Scope, month: str | None = None) -> dict:
    """The page's 'Needs your attention': status, cost jump, overtime, exceptions, advances, cost-per-head news."""
    ctx = _context(scope, month)
    return envelope(
        {"month": _key(ctx.ym) if ctx.ym else None, "items": _attention(ctx)},
        scope=scope,
        provenance=[_p_status(), _p_exceptions(), *_p_bridge()[:1], _p_overtime(), *_p_advances()[:1]],
        notes=[] if ctx.ym else [NO_PAYROLL_NOTE],
    )


# ─── what the Dashboard and the assistant use ───────────────────────────────────────────────────────────────────


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide payroll exceptions for the Dashboard: at most 5, most severe first."""
    ctx = _context(Scope(), None, today)
    return _attention(ctx)[:5]


def headline(*, today: date | None = None) -> dict:
    """What the Dashboard's strip shows for payroll: the latest closed month's cost, cost per head and overtime."""
    ctx = _context(Scope(), None, today)
    notes_prov = [_p_gross(), _p_cost_per_head(), _p_overtime(), _p_status()]
    if ctx.ym is None:
        kpis = [
            {
                "id": "payroll-gross",
                "label": "Payroll cost",
                "value": None,
                "format": "inr_compact",
                "sub": "No payroll processed yet",
                "delta": None,
                "spark": [],
                "page": "payroll",
            },
        ]
        return {"kpis": kpis, "provenance": notes_prov}
    ym = ctx.ym
    window = [_shift(ym, -i) for i in range(11, -1, -1)]
    raw = _month_raw(ctx.scope, window)
    fig = {k: _figures(v) for k, v in raw.items()}
    cur, prev = fig.get(ym), fig.get(_shift(ym, -1))

    def delta(key: str) -> dict | None:
        if cur is None or prev is None:
            return None
        c = change(cur[key], prev[key])
        return {**c, "good": "down"} if c else None

    def spark(key: str) -> list:
        return [fig[m][key] if m in fig else None for m in window]

    sub = f"{_label(ym)}" + (f" · {cur['headcount']} people paid" if cur else "")
    kpis = [
        {
            "id": "payroll-gross",
            "label": "Payroll cost",
            "value": cur["grossPay"] if cur else None,
            "format": "inr_compact",
            "sub": sub,
            "delta": delta("grossPay"),
            "spark": spark("grossPay"),
            "page": "payroll",
        },
        {
            "id": "payroll-cost-per-head",
            "label": "Cost per head",
            "value": cur["costPerHead"] if cur else None,
            "format": "inr_compact",
            "sub": f"{_label(ym)} gross pay per person",
            "delta": delta("costPerHead"),
            "spark": spark("costPerHead"),
            "page": "payroll",
        },
        {
            "id": "payroll-overtime",
            "label": "Overtime cost",
            "value": cur["overtimePay"] if cur else None,
            "format": "inr_compact",
            "sub": f"{cur['overtimeSharePct']}% of payroll"
            if cur and cur["overtimeSharePct"] is not None
            else _label(ym),
            "delta": delta("overtimePay"),
            "spark": spark("overtimePay"),
            "page": "payroll",
        },
    ]
    return {"kpis": kpis, "provenance": notes_prov}


# ─── assistant tools ────────────────────────────────────────────────────────────────────────────────────────────

_MONTH = string_param(
    "The payroll month as YYYY-MM (for example 2026-09). Omit it for the latest CLOSED month: the most recent month "
    "that has ended and has salary slips."
)


def _limit(default: int) -> dict:
    return integer_param(f"How many rows to return (default {default}, at most 25)", minimum=1, maximum=25)


def _fresh(result: dict) -> dict:
    """A private copy for the assistant. The functions above are cached and hand the SAME dict to every caller, while the
    assistant's privacy layer rewrites names inside a result in place: a copy keeps its edits out of the cache (and so
    out of the next page load)."""
    return copy.deepcopy(result)


def _tool_summary(*, scope: Scope, month: str | None = None) -> dict:
    return _fresh(payroll_summary(scope, month))


def _tool_trend(*, scope: Scope, month: str | None = None, months: int = 12) -> dict:
    return _fresh(payroll_trend(scope, month, months))


def _tool_bridge(*, scope: Scope, month: str | None = None) -> dict:
    return _fresh(payroll_bridge(scope, month))


def _tool_departments(*, scope: Scope, month: str | None = None, limit: int = 8) -> dict:
    return _fresh(payroll_departments(scope, month, limit))


def _tool_components(*, scope: Scope, month: str | None = None) -> dict:
    return _fresh(payroll_components(scope, month))


def _tool_advances(*, scope: Scope, month: str | None = None) -> dict:
    return _fresh(payroll_advances(scope, month))


def _tool_exceptions(*, scope: Scope, month: str | None = None, limit: int = 5, kind: str | None = None) -> dict:
    return _fresh(payroll_exceptions(scope, month, limit, kind))


def _tool_status(*, scope: Scope, months: int = 6) -> dict:
    return _fresh(payroll_status(scope, months))


TOOLS = [
    tool(
        "payroll_summary",
        "What the workforce costs for ONE payroll month: gross pay (salary earned plus overtime, before deductions), net "
        "pay (take-home), total deductions, overtime pay and its share, an estimate of employer cost (gross plus employer "
        "PF/ESI), people paid, cost per head and loss-of-pay days, each compared with the previous month and the same "
        "month last year, split staff vs production, with the month's payment status (paid / not paid / provisional). All "
        "money is in rupees. Use for 'what did payroll cost last month', 'how many people were paid', 'cost per head'. "
        "The result says which month it describes.",
        _tool_summary,
        page="payroll",
        period=None,
        extra={"month": _MONTH},
        example={},
    ),
    tool(
        "payroll_trend",
        "Month-by-month payroll for up to 36 months (default the last 12) ending at the chosen month: gross pay, net pay, "
        "people paid, cost per head, overtime pay and overtime share. A month with no payroll has null figures, not zero. "
        "Use for 'is payroll rising', 'how has overtime moved this year', 'what was the highest month'.",
        _tool_trend,
        page="payroll",
        extra={
            "month": _MONTH,
            "months": integer_param("How many months to return (default 12)", minimum=2, maximum=36),
        },
        defaults={"months": 12},
        example={},
    ),
    tool(
        "payroll_bridge",
        "WHY gross pay changed since last month, as steps that add up exactly to the change: people who joined payroll, "
        "people who left it, pay-rate changes (increments), overtime, loss of pay / attendance, bonus and one-offs, and "
        "other. Each step has its rupee amount and how many people it covers; 'mainDriver' names the biggest. Use for "
        "'why did payroll rise/fall this month', 'how much did joiners add', 'what did overtime add'. If last month has "
        "no payroll it says so.",
        _tool_bridge,
        page="payroll",
        period=None,
        extra={"month": _MONTH},
        example={},
    ),
    tool(
        "payroll_by_department",
        "Payroll cost ranking for one month by department, plus by unit and by staff vs production: gross pay, people "
        "paid, cost per head, overtime %, loss-of-pay days (staff), share of total and the change against the previous "
        "month. Use for 'which department costs the most', 'where did cost go up', 'cost per head by unit'.",
        _tool_departments,
        page="payroll",
        extra={"month": _MONTH, "limit": _limit(8)},
        defaults={"limit": 8},
        example={},
    ),
    tool(
        "payroll_components",
        "What gross pay and deductions are made of for one month, with the previous month: basic, HRA, allowances, "
        "incentives, overtime; PF, ESI, advance recovery, late deductions; employer PF/ESI estimates; statutory dues; "
        "net pay payable (slips not yet marked paid) and the year's statutory bonus status. Use for 'how much PF/ESI', "
        "'how much was deducted for advances', 'what is bonus accrued'. Income tax (TDS) is not recorded in this system.",
        _tool_components,
        page="payroll",
        period=None,
        extra={"month": _MONTH},
        example={},
    ),
    tool(
        "payroll_advances",
        "Salary advances and loans: total outstanding today (people, general vs term loan), ageing, overdue instalments, "
        "the amount held by people who have left, and the chosen month's new advances and recoveries. Use for 'how much "
        "do employees owe us', 'are advances growing', 'who left with an advance'.",
        _tool_advances,
        page="payroll",
        period=None,
        extra={"month": _MONTH},
        example={},
    ),
    tool(
        "payroll_exceptions",
        "Payroll rows worth checking in one month: negative or zero net pay, duplicate slips, pay for zero days worked, "
        "active employees with no salary slip, gross pay far above the department median, and big month-on-month swings. "
        "Returns counts of every kind plus the first people (name, code, department, amounts). Use for 'any payroll "
        "errors', 'who was paid a negative amount', 'who has no slip'.",
        _tool_exceptions,
        page="payroll",
        period=None,
        extra={
            "month": _MONTH,
            "limit": _limit(5),
            "kind": string_param("Only one kind of exception.", enum=list(EXCEPTION_KINDS)),
        },
        defaults={"limit": 5},
        person_fields=("name",),
        example={},
    ),
    tool(
        "payroll_status",
        "Which payroll months exist and what state each is in (paid, part paid, generated but not marked paid, in "
        "progress / provisional, not generated), with slips, people, net pay still unpaid, provisional slips, when it "
        "was generated and paid, and the salary day. There is no 'finalised' switch: paid means every slip's payroll row "
        "is marked paid. Use for 'has payroll been done for September', 'is the last month paid', 'which months are pending'.",
        _tool_status,
        page="payroll",
        period=None,
        extra={"months": integer_param("How many months back to list (default 6)", minimum=1, maximum=36)},
        defaults={"months": 6},
        example={},
    ),
]
