"""
Shared plumbing of the payroll_core report group (salary slips, registers, wage statements, bank advice,
deduction summary, department cost, month comparison, annual statement, salary master, employer cost).

Nothing here registers a report. What lives here is the ONE place that decides

* how a SalarySlip is classified (staff / production / legacy weekly),
* how the stored slip columns are turned into report figures (total earnings, late deduction, paid days ...),
* how a slip is joined to its Payroll row (payment status),
* how the financial-year window is resolved,

so every payroll report in the Report Center agrees with the others to the paisa and with the printed slip.

Rules this module encodes (see the payroll survey brief):

* Money is read from the STORED slip columns. Nothing is re-derived from attendance; the payroll engine stays
  the single source of truth. Only display splits (fixed vs earned heads, employer estimate) are computed.
* A slip is PRODUCTION when it has a pay period (period_start) or is a legacy weekly slip (week_number); it is STAFF
  otherwise. ``Employee.employment_type`` is deliberately not used for the slip's type: an employee who changed type
  legitimately owns both kinds of slip.
* Legacy weekly production slips (week_number set, no period) are stale rows from before period-based payroll and are
  hidden unless the report offers - and the user ticks - ``includeLegacyWeekly``.
* Late deduction = ``breakdown.deductions.lateShiftPenalty`` (production slips do not store it in other_deductions),
  falling back to total deductions less PF, ESI and advance when the slip carries no breakdown snapshot.
"""

from __future__ import annotations

import dataclasses
import re
from datetime import date, datetime
from decimal import Decimal

from django.db.models import Case, CharField, DecimalField, ExpressionWrapper, F, Q, Value, When
from django.db.models.fields.json import KT
from django.db.models.functions import Cast, Coalesce

from api.growth_views import _fy_label_for_date, _fy_month_years
from api.models import Payroll, PayrollSettings, SalarySlip
from api.payroll_views import _d2

from ..common import with_subtotals
from ..filters import boolean, select
from ..formatting import MONTH_ABBR, display_date, month_bounds, r2
from ..runner import KIND_SUBTOTAL
from ..types import FilterSpec

ZERO = Decimal("0")

# Permission modules that own payroll data. A role holding only "production_payroll" is limited to production slips
# (see slip_filter); "payroll" / "salary_slip" grant everything.
STAFF_AND_PRODUCTION_MODULES = ("payroll", "production_payroll")

LEGACY_KEY = "includeLegacyWeekly"
PAYMENT_KEY = "paymentStatus"
FY_KEY = "financialYear"

# Statutory employer rates used ONLY for the cost estimates of department-salary-cost. Payroll does not store employer
# contributions, so these are report-layer constants, labelled as such wherever they are used.
EMPLOYER_PF_RATE = Decimal("12")  # EPF employer share (EPS 8.33% + EPF 3.67%) on PF wages (the slip's basic)
EMPLOYER_ESI_RATE = Decimal("3.25")  # ESI employer share on ESI wages (the slip's gross)

STATUS_PAID = "Paid"
STATUS_PENDING = "Pending"
STATUS_SLIP_ONLY = "Slip only"


# ── filters ─────────────────────────────────────────────────────────────────


def legacy_filter() -> FilterSpec:
    return boolean(
        LEGACY_KEY,
        "Include legacy weekly slips",
        help="Old week-number based production slips from before period-based payroll. Hidden by default.",
    )


def payment_filter(default: str | None = None) -> FilterSpec:
    return select(
        PAYMENT_KEY,
        "Payment status",
        [("paid", "Paid"), ("pending", "Pending")],
        default=default,
        help="Paid = the payroll row was marked paid. Anything else (or no payroll row) counts as pending.",
    )


def fy_labels(first: int = 2018, last: int = 2040) -> list[tuple[str, str]]:
    return [(f"{y}-{str(y + 1)[-2:]}", f"FY {y}-{str(y + 1)[-2:]}") for y in range(first, last + 1)]


def financial_year_filter(help: str | None = None, placeholder: str = "Current financial year") -> FilterSpec:
    return select(FY_KEY, "Financial year", fy_labels(), default=None, placeholder=placeholder, help=help)


# ── small helpers ───────────────────────────────────────────────────────────


_NAT = re.compile(r"(\d+)")


def nat_key(code: str | None) -> list:
    """'30005' > '73' > '9': employee codes are numeric-looking text, so ORDER BY gives 1, 10, 100, 2."""
    out = []
    for token in _NAT.split(code or ""):
        if token.isdigit():
            out.append((0, int(token), ""))
        elif token:
            out.append((1, 0, token.lower()))
    return out


def _isnum(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def dept_name(emp) -> str:
    return emp.department.name if emp.department_id else "Unassigned"


def is_production(s) -> bool:
    return s.period_start is not None or s.week_number is not None


def is_legacy_weekly(s) -> bool:
    return s.period_start is None and s.week_number is not None


def type_label(s) -> str:
    return "Production" if is_production(s) else "Staff"


def period_label(s) -> str:
    if s.period_start is not None and s.period_end is not None:
        return f"{display_date(s.period_start)} to {display_date(s.period_end)}"
    if s.week_number is not None:
        return f"{MONTH_ABBR[s.month - 1]} {s.year} - week {s.week_number}"
    return f"{MONTH_ABBR[s.month - 1]} {s.year}"


def month_text(year: int, month: int) -> str:
    return f"{MONTH_ABBR[month - 1]} {year}"


def computed_date(s, payroll_row: dict | None = None) -> date | None:
    """The (IST) day the slip's figures were last computed, as far as stored data can tell.

    ``SalarySlip.generated_at`` is auto_now_add - it is the FIRST generation - while regenerating payroll upserts the
    Payroll row (``updated_at`` is auto_now), so the later of the two is the best stored evidence of the last run."""
    stamps = [getattr(s, "generated_at", None), (payroll_row or {}).get("updated_at")]
    stamps = [x for x in stamps if isinstance(x, datetime)]
    if not stamps:
        return None
    latest = max(stamps)
    if latest.tzinfo is not None:
        from api.clock import FACTORY_TZ

        latest = latest.astimezone(FACTORY_TZ)
    return latest.date()


def is_provisional(s, today: date, computed_on: date | None = None) -> bool:
    """A staff slip computed before its month ended counts the days still to come as absent.

    That is true while the month is running AND for a slip that was generated mid-month and never regenerated
    (``computed_on`` = the day of its last known computation): viewed months later it is still understated."""
    if is_production(s):
        return False
    month_end = month_bounds(s.year, s.month)[1]
    if month_end >= today:
        return True
    return computed_on is not None and computed_on <= month_end


def amount_in_words(amount) -> str:
    """'Rs. TWELVE THOUSAND FIVE HUNDRED AND FIFTY PAISE ONLY' - the existing helper drops paise, so add them."""
    from api.document_pdf import num_to_words

    total = Decimal(str(amount)).quantize(Decimal("0.01"))
    rupees, paise = divmod(int(total * 100), 100)
    text = num_to_words(rupees)
    if paise:
        text += f" AND {num_to_words(paise)[4:]} PAISE"
    return f"{text} ONLY"


def subtotals(rows, group_by, sum_keys, *, label_key: str = "employeeName", label=lambda g: f"{g} total") -> list[dict]:
    """common.with_subtotals, except that a subtotal over values that are ALL unknown stays unknown (a dash) instead
    of turning into 0 - a production sheet whose late deduction was switched off must not print 0.00 in its subtotal."""
    keys = list(sum_keys)
    out = with_subtotals(rows, group_by, keys, label_key=label_key, label=label)
    run: list[dict] = []
    for r in out:
        if r.get("_kind") == KIND_SUBTOTAL:
            for k in keys:
                if run and all(x.get(k) is None for x in run):
                    r[k] = None
            run = []
        else:
            run.append(r)
    return out


# ── employee scope + slip classification ────────────────────────────────────


def scope_q(ctx, prefix: str = "employee__") -> Q:
    """The framework's employee scope (branch isolation + department/designation/employee/status filters) WITHOUT its
    employment-type clause: slips are typed by their own structure, not by the employee's current type."""
    params = {k: v for k, v in ctx.params.items() if k != "employment_type"}
    return dataclasses.replace(ctx, params=params).emp_q(prefix)


STAFF_Q = Q(period_start__isnull=True, week_number__isnull=True)
PERIOD_PRODUCTION_Q = Q(period_start__isnull=False)
ANY_PRODUCTION_Q = Q(period_start__isnull=False) | Q(week_number__isnull=False)

_PROD_ONLY_NOTE = "Your role can view production payroll only, so staff slips are not included."


def has_module(ctx, module: str) -> bool:
    """True when the requesting HR user may view ``module`` (a super admin may view everything)."""
    if ctx.is_super_admin:
        return True
    from ..access import permission_level

    return permission_level(ctx.request, module) in ("view", "edit")


def production_only_role(ctx, full_modules: tuple[str, ...] = ("payroll",)) -> bool:
    """True for a (non super-admin) user whose only payroll grant is Production Payroll.

    ``full_modules`` are the permission modules that open EVERY slip type (Payroll; Salary Slip for the slip listing);
    a user holding none of them but holding Production Payroll is limited to production slips."""
    if ctx.is_super_admin:
        return False
    return not any(has_module(ctx, m) for m in full_modules) and has_module(ctx, "production_payroll")


def slip_filter(
    ctx,
    *,
    full_modules: tuple[str, ...] = ("payroll",),
    legacy_key: str | None = LEGACY_KEY,
    force_kind: str | None = None,
) -> tuple[Q, list[str]]:
    """(Q on SalarySlip without the period, notes). Applies branch isolation, the employee filters, the slip-type
    filter and the legacy-weekly exclusion. ``force_kind`` pins the slip type for reports that are staff-only or
    production-only by nature."""
    q = scope_q(ctx, "employee__")
    notes: list[str] = []
    kind = force_kind or ctx.params.get("employment_type")
    if not force_kind and production_only_role(ctx, full_modules):
        if kind == "staff":
            # asking for staff slips must not quietly turn into production slips: the role may not see staff payroll
            q &= Q(pk__in=[])
        kind = "production"
        notes.append(_PROD_ONLY_NOTE)
    legacy = bool(legacy_key and ctx.params.get(legacy_key))
    if kind == "staff":
        q &= STAFF_Q
    elif kind == "production":
        q &= ANY_PRODUCTION_Q if legacy else PERIOD_PRODUCTION_Q
    elif not legacy:
        q &= Q(week_number__isnull=True)
    if not legacy:
        notes.append(
            "Legacy weekly production slips (week-number based, before period-based payroll) are not included."
        )
    return q, notes


def month_q(year: int, month: int) -> Q:
    return Q(year=year, month=month)


def pairs_q(pairs) -> Q:
    q = Q()
    for y, m in pairs:
        q |= Q(year=y, month=m)
    return q


# ── financial year ──────────────────────────────────────────────────────────


def fy_start_month() -> int:
    """The Bonus financial-year start month (April by default). A plain read: PayrollSettings.get() would create the
    singleton row on a brand-new install, and a report must never write."""
    value = PayrollSettings.objects.filter(pk=1).values_list("bonus_fy_start_month", flat=True).first()
    return int(value or 4)


def fy_pairs(label: str, start_month: int | None = None) -> list[tuple[int, int]]:
    """Chronological (year, month) pairs of a financial year label such as '2025-26'."""
    sm = start_month if start_month is not None else fy_start_month()
    return sorted(_fy_month_years(label, sm))


def current_fy(today: date, start_month: int | None = None) -> str:
    return _fy_label_for_date(today, start_month if start_month is not None else fy_start_month())


def resolve_window(ctx) -> tuple[list[tuple[int, int]], str, str | None]:
    """(pairs, label, fy) for reports that take a month OR a financial year (the FY wins when chosen)."""
    fy = ctx.params.get(FY_KEY)
    if fy:
        return fy_pairs(fy), f"FY {fy}", fy
    y, m = ctx.period
    return [(y, m)], month_text(y, m), None


# ── breakdown snapshot (JSON) ───────────────────────────────────────────────


def with_breakdown_parts(qs):
    """Attach only the small parts of breakdown_details a report needs (summary / earnings / deductions / rate) and
    leave out the 31-entry ``days`` array, so a 1,000-slip month does not pull megabytes of JSON."""
    return qs.defer("breakdown_details").annotate(
        bd_summary=F("breakdown_details__summary"),
        bd_earn=F("breakdown_details__earnings"),
        bd_ded=F("breakdown_details__deductions"),
        bd_rate=F("breakdown_details__salaryPerShift"),
    )


def _parts(s) -> tuple[dict, dict, dict, object]:
    d = s.__dict__
    if "bd_summary" in d or "bd_earn" in d or "bd_ded" in d:
        return d.get("bd_summary") or {}, d.get("bd_earn") or {}, d.get("bd_ded") or {}, d.get("bd_rate")
    bd = d.get("breakdown_details") if "breakdown_details" in d else None
    if isinstance(bd, dict):
        return bd.get("summary") or {}, bd.get("earnings") or {}, bd.get("deductions") or {}, bd.get("salaryPerShift")
    return {}, {}, {}, None


# SQL twin of the late-deduction rule in derive(): snapshot value, else total deductions less PF/ESI/advance.
_DEC = DecimalField(max_digits=14, decimal_places=2)
LATE_SQL = Coalesce(
    Cast(KT("breakdown_details__deductions__lateShiftPenalty"), _DEC),
    ExpressionWrapper(
        F("total_deductions") - F("pf_deduction") - F("esi_deduction") - F("advance_deduction"), output_field=_DEC
    ),
    output_field=_DEC,
)
SLIP_TYPE_SQL = Case(
    When(period_start__isnull=False, then=Value("production")),
    When(week_number__isnull=False, then=Value("production")),
    default=Value("staff"),
    output_field=CharField(),
)


def derive(s, today: date, payroll_row: dict | None = None) -> dict:
    """Every figure the payroll reports print for one slip, from the stored columns + breakdown snapshot.

    Money values are floats rounded to paise; ``None`` = not stored / not applicable (rendered as a dash).
    ``payroll_row`` (the slip's Payroll fields) only feeds the "when was this last computed" evidence."""
    summary, earn, ded, rate = _parts(s)
    production = is_production(s)
    has_ded_snapshot = bool(ded)

    other_allowances = s.allowances + s.incentives + s.bonuses
    total_earnings = s.gross_salary + s.ot_amount
    residual = s.total_deductions - s.pf_deduction - s.esi_deduction - s.advance_deduction

    raw_late = ded.get("lateShiftPenalty")
    if _isnum(raw_late):
        late: Decimal | None = _d2(raw_late)
    elif production and has_ded_snapshot:
        late = None  # production late detection was off when the slip was generated
    else:
        late = max(residual, ZERO)  # no snapshot: staff other_deductions IS the late penalty
    other = residual - (late or ZERO)

    if production:
        shifts = summary.get("totalShifts")
        if not _isnum(shifts):
            shifts = earn.get("totalShifts")
        paid_days = float(shifts) if _isnum(shifts) else None
        if paid_days is None:
            paid_days = float(s.present_days)
        rate_value = rate if _isnum(rate) else earn.get("salaryPerShift")
        monthly_rate = float(rate_value) if _isnum(rate_value) else None
    else:
        eff = summary.get("effectivePaidDays")
        paid_days = float(eff) if _isnum(eff) else float(s.present_days + s.paid_leave_days)
        monthly = earn.get("monthlySalary")
        monthly_rate = float(monthly) if _isnum(monthly) else None

    lop = None
    if not production and monthly_rate is not None:
        lop = max(Decimal(str(monthly_rate)) - s.gross_salary, ZERO)

    return {
        "type": type_label(s),
        "production": production,
        "legacy": is_legacy_weekly(s),
        "period": period_label(s),
        "provisional": is_provisional(s, today, computed_date(s, payroll_row)),
        "has_snapshot": bool(summary or earn or ded),
        "basic": r2(s.basic),
        "hra": r2(s.hra),
        "other_allowances": r2(other_allowances),
        "allowances_only": r2(s.allowances),
        "incentives_bonus": r2(s.incentives + s.bonuses),
        "ot": r2(s.ot_amount),
        "gross": r2(s.gross_salary),
        "total_earnings": r2(total_earnings),
        "pf": r2(s.pf_deduction),
        "esi": r2(s.esi_deduction),
        "advance": r2(s.advance_deduction),
        "late": r2(late) if late is not None else None,
        "other": r2(other),
        "residual": r2(residual),
        "total_deductions": r2(s.total_deductions),
        "net": r2(s.net_salary),
        "working_days": s.working_days,
        "paid_days": paid_days,
        "absent_days": float(s.absent_days),
        "late_days": s.late_days,
        "monthly_rate": monthly_rate,
        "lop": r2(lop) if lop is not None else None,
        "summary": summary,
        "earn": earn,
        "ded": ded,
    }


# ── payroll rows (payment status) ───────────────────────────────────────────


def payroll_key(employee_id, period_start, period_end, week_number, year, month) -> tuple:
    if period_start is not None:
        return (employee_id, "p", period_start, period_end)
    return (employee_id, "m", year, month, week_number)


def slip_key(s) -> tuple:
    return payroll_key(s.employee_id, s.period_start, s.period_end, s.week_number, s.year, s.month)


def payroll_index(ctx, years) -> dict[tuple, dict]:
    """{slip identity: Payroll fields}: ONE query for all the slips of the report (never per row).
    Duplicate rows (NULL columns defeat the unique constraints) resolve to the most recently updated."""
    rows = (
        Payroll.objects.filter(scope_q(ctx, "employee__"), year__in=sorted(set(years)))
        .order_by("updated_at", "id")
        .values(
            "employee_id",
            "month",
            "year",
            "week_number",
            "period_start",
            "period_end",
            "status",
            "final_salary",
            "updated_at",
        )
    )
    out: dict[tuple, dict] = {}
    for p in rows:
        out[
            payroll_key(p["employee_id"], p["period_start"], p["period_end"], p["week_number"], p["year"], p["month"])
        ] = p
    return out


def is_paid(payroll_row: dict | None) -> bool:
    """Payroll.status is free text (PATCH accepts anything): only the word 'paid' counts."""
    return bool(payroll_row) and (payroll_row.get("status") or "").strip().lower() == "paid"


def status_text(payroll_row: dict | None, *, orphan_label: str = STATUS_PENDING) -> str:
    if payroll_row is None:
        return orphan_label
    return STATUS_PAID if is_paid(payroll_row) else STATUS_PENDING


# ── loading slips for row-level reports ─────────────────────────────────────


@dataclasses.dataclass
class SlipRow:
    slip: SalarySlip
    d: dict
    payroll: dict | None

    @property
    def paid(self) -> bool:
        return is_paid(self.payroll)


def load_slips(
    ctx,
    *,
    full_modules: tuple[str, ...] = ("payroll",),
    legacy_key: str | None = LEGACY_KEY,
    force_kind: str | None = None,
    full_breakdown: bool = False,
    order: str = "code",
    extra_q: Q | None = None,
    month_filter: bool = True,
) -> tuple[list[SlipRow], list[str]]:
    """Slips for the report's month, with derived figures and Payroll status.

    order: "code" = natural employee code then period; "dept" = department, code, period.
    month_filter=False lets a report bring its own window through ``extra_q`` (production wage sheet)."""
    q, notes = slip_filter(ctx, full_modules=full_modules, legacy_key=legacy_key, force_kind=force_kind)
    qs = SalarySlip.objects.select_related(
        "employee", "employee__department", "employee__designation", "employee__branch"
    ).filter(q)
    if extra_q is not None:
        qs = qs.filter(extra_q)
    if month_filter and ctx.period:
        qs = qs.filter(month_q(*ctx.period))
    if not full_breakdown:
        qs = with_breakdown_parts(qs)
    slips = list(qs.order_by("employee__employee_code", "period_start", "id")[: ctx.row_limit])

    years = {s.year for s in slips}
    index = payroll_index(ctx, years) if years else {}
    wanted = ctx.params.get(PAYMENT_KEY)
    today = ctx.today
    out: list[SlipRow] = []
    for s in slips:
        pay = index.get(slip_key(s))
        row = SlipRow(s, derive(s, today, pay), pay)
        if wanted == "paid" and not row.paid:
            continue
        if wanted == "pending" and row.paid:
            continue
        out.append(row)
    out.sort(key=lambda r: _order_key(r, order))
    return out, notes


def _order_key(r: SlipRow, order: str):
    s = r.slip
    tail = (nat_key(s.employee.employee_code), s.period_start or date.min, s.year, s.month, s.week_number or 0, s.id)
    if order == "dept":
        return (dept_name(s.employee).lower(),) + tail
    return tail


def provisional_note(rows: list[SlipRow]) -> str | None:
    n = sum(1 for r in rows if r.d["provisional"])
    if not n:
        return None
    return (
        f"{n} staff slip(s) are PROVISIONAL: generated before the month ended, so days not yet worked were counted as "
        "absent. Regenerate payroll after month end before acting on these figures."
    )
