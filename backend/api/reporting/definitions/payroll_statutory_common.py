"""
Shared helpers for the statutory / deductions / overtime payroll reports (group G2).

Nothing in here writes to the database, and nothing re-derives a figure the payroll engine has
already decided: reports read the stored ``SalarySlip`` / ``Payroll`` / ``OvertimeRecord`` rows (and
small JSON sub-objects of ``SalarySlip.breakdown_details``) and only format, group and reconcile them.

Statutory constants live here, in the report layer, because the system stores no employer rates.
Every report that uses one prints it in its notes.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import F, Q

from ..access import permission_level
from ..common import with_subtotals
from ..formatting import display_date, month_label
from ..runner import KIND_SUBTOTAL

# -- statutory constants (report layer only; the app stores no employer rates) ----------------------
EPF_RATE = Decimal("12")  # employee AND employer share, % of EPF wages
EPS_RATE = Decimal("8.33")  # employer pension share, % of EPS wages
EPS_WAGE_CEILING = Decimal("15000")  # statutory monthly wage ceiling for EPS / the default EPF wage cap
EDLI_RATE = Decimal("0.5")  # employer insurance charge, % of EDLI wages (wages capped like EPS)
EPF_ADMIN_RATE = Decimal("0.5")  # employer administration charge, % of EPF wages
ESI_EMPLOYER_RATE = Decimal("3.25")  # employer share, % of ESI wages

STAFF = "staff"
PRODUCTION = "production"
TYPE_LABEL = {STAFF: "Staff", PRODUCTION: "Production"}

# A role may run a slip-based report when it can open any of these; ``visible_types`` then narrows the
# rows to the kind of payroll (staff / production) that the role can actually open elsewhere.
PAYROLL_MODULES = ("payroll", "production_payroll", "salary_slip")

_ZERO = Decimal("0")
_TWO = Decimal("0.01")


# -- numbers ------------------------------------------------------------------------------------------
def dec(value) -> Decimal:
    """Any stored number (Decimal column, JSON float/int, str, None) -> Decimal; None/garbage -> 0."""
    if value is None or value == "":
        return _ZERO
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001 - a corrupt JSON value must never take a report down
        return _ZERO


def dec_or_none(value) -> Decimal | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001
        return None


def money(value: Decimal | None) -> float | None:
    """Decimal rupees -> float rounded half-up to paise (the way payroll rounds); None stays None."""
    if value is None:
        return None
    return float(value.quantize(_TWO, rounding=ROUND_HALF_UP))


def whole_rupee(value: Decimal) -> Decimal:
    """Statutory contribution rounding: nearest whole rupee, halves up."""
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def pct(part: Decimal | None, whole: Decimal | None) -> float | None:
    """part / whole * 100, 2 places; None when the base is missing or zero."""
    if part is None or not whole:
        return None
    return float((part * 100 / whole).quantize(_TWO, rounding=ROUND_HALF_UP))


def natural_key(text) -> list:
    """Employee codes are numeric-looking text ('2', '10', '100'): sort them the way people read them."""
    parts = [p for p in re.split(r"(\d+)", str(text or "")) if p != ""]
    return [(0, int(p), "") if p.isdigit() else (1, 0, p.lower()) for p in parts]


# -- settings (read-only) -----------------------------------------------------------------------------
def read_settings():
    """The singleton PayrollSettings row, WITHOUT ``PayrollSettings.get()``'s get_or_create (a GET must not
    write). Only the small fields the reports need are loaded (the row also carries base64 logos)."""
    from api.models import PayrollSettings

    row = (
        PayrollSettings.objects.filter(pk=1)
        .only(
            "compensation_feature_enabled",
            "ot_detection_enabled",
            "ot_threshold_minutes",
            "ot_compensation_type",
            "min_wage_rate",
            "staff_payroll_rules_enabled",
            "prod_payroll_rules_enabled",
            "prod_pf_ef_enabled",
        )
        .first()
    )
    return row or PayrollSettings()


# -- who may see which kind of payroll -----------------------------------------------------------------
def visible_types(ctx) -> set[str]:
    """Kinds of payroll ('staff' / 'production') the requesting role can open elsewhere in the app.

    Staff payroll lives under the Payroll module, production under Production Payroll and the Salary Slip
    page shows both, so a role that only has Production Payroll must not read staff statutory figures
    through a report that happens to mix both kinds."""
    if ctx.is_super_admin:
        return {STAFF, PRODUCTION}

    def can(module: str) -> bool:
        return permission_level(ctx.request, module) in ("view", "edit")

    if can("salary_slip"):
        return {STAFF, PRODUCTION}
    out: set[str] = set()
    if can("payroll"):
        out.add(STAFF)
    if can("production_payroll"):
        out.add(PRODUCTION)
    return out


def slip_type_q(types: set[str]) -> Q:
    """Q on a SalarySlip / Payroll row for the wanted payroll kinds.

    A staff slip has neither period_start nor week_number; every production slip (period-based or legacy
    weekly) has one of them. This is the structural rule the engine writes, so it cannot be fooled by an
    employee who changed type after a slip was generated."""
    if STAFF in types and PRODUCTION in types:
        return Q()
    if types == {STAFF}:
        return Q(period_start__isnull=True, week_number__isnull=True)
    if types == {PRODUCTION}:
        return Q(period_start__isnull=False) | Q(week_number__isnull=False)
    return Q(pk__in=[])


def employee_type_q(types: set[str], prefix: str = "") -> Q:
    if STAFF in types and PRODUCTION in types:
        return Q()
    return Q(**{f"{prefix}employment_type__in": sorted(types)})


def slip_type(slip) -> str:
    return PRODUCTION if (slip.period_start is not None or slip.week_number is not None) else STAFF


# -- slip breakdown sub-objects --------------------------------------------------------------------------
# breakdown_details holds a 31-entry per-day array in every slip; reports only need a few small
# sub-objects, so they are pulled out server-side (JSON key transforms) and the blob itself is deferred.
BD = {
    "bd_summary": "breakdown_details__summary",
    "bd_earn": "breakdown_details__earnings",
    "bd_late": "breakdown_details__deductions__lateSummary",
    "bd_penalty": "breakdown_details__deductions__lateShiftPenalty",
    "bd_esi_limit": "breakdown_details__deductions__esiApplicableBelow",
    "bd_month_eq": "breakdown_details__deductions__monthlyEquivalent",
    "bd_rate": "breakdown_details__salaryPerShift",
}


def with_breakdown(qs, *names: str):
    """Defer the breakdown blob and annotate only the named sub-objects (see ``BD``)."""
    return qs.defer("breakdown_details").annotate(**{n: F(BD[n]) for n in names})


def as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def period_text(slip) -> str:
    """'Feb 2026' for a staff slip, '02-Feb-2026 to 11-Feb-2026' for a production period."""
    if slip.period_start is not None and slip.period_end is not None:
        return f"{display_date(slip.period_start)} to {display_date(slip.period_end)}"
    label = month_label(slip.year, slip.month)
    if slip.week_number is not None:
        return f"{label} - week {slip.week_number}"
    return label


def month_end(year: int, month: int) -> date:
    nxt = date(year + (month == 12), (month % 12) + 1, 1)
    return nxt - timedelta(days=1)


def provisional_slip_ids(slips, year: int, month: int, today: date) -> set[int]:
    """Ids of the STAFF slips whose figures were computed before their month ended.

    Such a slip counts the days still to come as absent, so its PF / ESI / late / loss-of-pay figures understate
    pay until payroll is regenerated after the month closes - and it stays understated for as long as nobody does.
    While the month is running every staff slip is provisional. Afterwards a slip is provisional when the last
    stored evidence of a computation is on or before the last day of the month: ``SalarySlip.generated_at`` is
    auto_now_add (the FIRST generation) while regenerating upserts the Payroll row, whose ``updated_at`` is
    auto_now, so the later of the two is the best stored evidence (an edit of the payroll row after month end
    cannot be told from a regeneration, so it counts as one). Production slips are never provisional.
    One indexed query for the payroll rows, only when the month has ended."""
    staff = [s for s in slips if slip_type(s) == STAFF]
    if not staff:
        return set()
    last_day = month_end(year, month)
    if last_day >= today:
        return {s.id for s in staff}
    from api.clock import FACTORY_TZ
    from api.models import Payroll

    touched = dict(
        Payroll.objects.filter(
            employee_id__in={s.employee_id for s in staff},
            year=year,
            month=month,
            period_start__isnull=True,
            week_number__isnull=True,
        ).values_list("employee_id", "updated_at")
    )
    out: set[int] = set()
    for s in staff:
        stamps = [x for x in (s.generated_at, touched.get(s.employee_id)) if x is not None]
        if stamps and max(stamps).astimezone(FACTORY_TZ).date() <= last_day:
            out.add(s.id)
    return out


def provisional_note(n_provisional: int, year: int, month: int, today: date) -> str | None:
    """The warning printed under a statement that contains provisional staff slips (None when there are none)."""
    if not n_provisional:
        return None
    if month_end(year, month) >= today:
        return (
            f"PROVISIONAL: {month_label(year, month)} has not ended, so its staff slips count the remaining working "
            "days as absent. PF / ESI / late / loss-of-pay figures will change when payroll is regenerated after the "
            "month closes."
        )
    return (
        f"PROVISIONAL: {n_provisional} staff slip(s) for {month_label(year, month)} were generated before the month "
        "ended and not regenerated since, so they count the remaining working days as absent and understate pay. "
        "Regenerate payroll to correct them."
    )


def dept_name(emp) -> str:
    return emp.department.name if emp.department_id else "Unassigned"


def blank(value) -> bool:
    return value is None or not str(value).strip()


# -- grouping ---------------------------------------------------------------------------------------------
def dept_subtotals(rows: list[dict], keys: list[str], label_key: str = "employeeName") -> list[dict]:
    """``with_subtotals`` by department that keeps a dash (None) - not a zero - for a group in which no row
    has a value for a column. Rows must already be sorted by department."""
    out = with_subtotals(rows, lambda r: r.get("department") or "Unassigned", keys, label_key)
    group: list[dict] = []
    for r in out:
        if r.get("_kind") == KIND_SUBTOTAL:
            for k in keys:
                if all(g.get(k) is None for g in group):
                    r[k] = None
            group = []
        else:
            group.append(r)
    return out


def sort_key_dept_code(row: dict):
    return ((row.get("department") or "Unassigned").lower(), natural_key(row.get("employeeCode")))


def no_slips_note(year: int, month: int) -> str:
    """Why a slip-based report is empty because payroll simply has not been generated (not because all is well)."""
    return (
        f"No salary slips exist for {month_label(year, month)} (within your access and filters). Slips are created by "
        "Generate Payroll - a month that has not been generated yet shows nothing here."
    )


def feature_off_result_notes(settings, *, need_detection: bool = False) -> list[str]:
    """Notes explaining why a compensation / overtime report is empty (or partial) because of a Settings switch."""
    notes: list[str] = []
    if not settings.compensation_feature_enabled:
        notes.append(
            "The Compensation feature is switched off in Settings > Payroll, so overtime and compensation "
            "credits are not detected, announced or paid. Switch it on to use this report."
        )
    elif need_detection and not settings.ot_detection_enabled:
        notes.append(
            "Overtime detection is switched off in Settings > Payroll. Records already detected while it was "
            "on (and announced ones that were paid) are still listed; no new overtime is being detected."
        )
    return notes
