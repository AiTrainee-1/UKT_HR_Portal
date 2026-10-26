"""
PF, ESI and TDS: who they apply to, what the rules are, and the arithmetic. ONE place, so the payroll engines, the
Compensation page's employer cost, the coverage report and the settings API can never disagree.

Categories (an employee is in exactly one):

    Co Emp   Employee.co_emp_enabled         PF and ESI apply (rules below). Also visible in the CoPortal.
    TDS      Employee.tds_enabled            TDS only (tds_percent % of the period's earned gross); never PF or ESI.
                                             Also visible in the CoPortal.
    neither                                  nothing is deducted, ever.

Co Emp and TDS are mutually exclusive: the TDS endpoints and the Co Emp toggle swap one for the other in one transaction
(tds_views.py, employee_views.py). If bad data ever carries both flags, TDS wins here.

Rules (PayrollSettings.staff_pf_rules / staff_esi_rules / prod_pf_rules / prod_esi_rules, or a branch's own copy of all
four in BranchSettingsOverride.overrides): a rule is

    {"id": str, "label": str, "basis": "basic" | "first_portion" | "total",
     "minAmount": number >= 0, "maxAmount": number (0 = no upper limit), "ratePercent": number 0..100}

It matches an employee when  minAmount <= amount <= maxAmount  (inclusive both ends), `amount` being the employee's FULL
MONTHLY amount of the chosen basis - never attendance-prorated, so a part month cannot flip eligibility:

    basic          the Basic component of the 50% + 50% salary split (salary_split.py)
    first_portion  Basic + DA + Retaining Allowance
    total          the whole monthly salary; for production the monthly-equivalent earnings (period gross x 4 weekly /
                   2 biweekly / 1 monthly, production_cycles.MONTHLY_EQUIVALENT_FACTOR)

The first matching rule in list order wins; no match means no deduction of that kind. Ranges of one list never overlap
(clean_rule_list enforces it for rules of the same basis).

Amount = ratePercent x the FIRST portion (Basic + DA + Retaining Allowance) of the period, prorated by attendance the way
payroll prorates `basic`. ESI uses the same base as PF. For production the first portion is its share (0.50 by the
mandatory split) of the period's earned gross. All money is Decimal rounded to 2 places, half up.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db.models import Q

from . import salary_split

ZERO = Decimal("0.00")
_CENT = Decimal("0.01")
_HUNDRED = Decimal("100")

BASIS_BASIC = "basic"
BASIS_FIRST_PORTION = "first_portion"
BASIS_TOTAL = "total"
BASES = (BASIS_BASIC, BASIS_FIRST_PORTION, BASIS_TOTAL)
BASIS_OPTIONS = [
    {
        "value": BASIS_BASIC,
        "label": "Basic salary",
        "description": "The Basic component of the employee's salary split. The usual choice: 'PF below 25,000 Basic'.",
    },
    {
        "value": BASIS_FIRST_PORTION,
        "label": "Basic + DA + Retaining Allowance",
        "description": "The whole first 50% portion of the salary split (Basic, DA and Retaining Allowance together).",
    },
    {
        "value": BASIS_TOTAL,
        "label": "Full monthly salary",
        "description": (
            "The employee's whole monthly salary. For production workers: the earnings of the pay period scaled to a "
            "month (weekly x4, bi-weekly x2, monthly x1)."
        ),
    },
]

CLASS_STAFF = "staff"
CLASS_PRODUCTION = "production"
CLASSES = (CLASS_STAFF, CLASS_PRODUCTION)
KIND_PF = "pf"
KIND_ESI = "esi"
KINDS = (KIND_PF, KIND_ESI)

# (class, kind) -> the PayrollSettings column that holds the list, and the dotted name the API uses for it.
RULE_FIELDS = {
    (CLASS_STAFF, KIND_PF): "staff_pf_rules",
    (CLASS_STAFF, KIND_ESI): "staff_esi_rules",
    (CLASS_PRODUCTION, KIND_PF): "prod_pf_rules",
    (CLASS_PRODUCTION, KIND_ESI): "prod_esi_rules",
}
RULE_FIELD_NAMES = tuple(RULE_FIELDS.values())
LIST_KEYS = {
    (CLASS_STAFF, KIND_PF): "staff.pfRules",
    (CLASS_STAFF, KIND_ESI): "staff.esiRules",
    (CLASS_PRODUCTION, KIND_PF): "production.pfRules",
    (CLASS_PRODUCTION, KIND_ESI): "production.esiRules",
}
_TITLES = {
    (CLASS_STAFF, KIND_PF): "Staff PF",
    (CLASS_STAFF, KIND_ESI): "Staff ESI",
    (CLASS_PRODUCTION, KIND_PF): "Production PF",
    (CLASS_PRODUCTION, KIND_ESI): "Production ESI",
}

MAX_RULES_PER_LIST = 50
MAX_AMOUNT = Decimal("99999999.99")
MAX_RATE_PERCENT = Decimal("100")
MAX_LABEL_LENGTH = 80
MAX_ID_LENGTH = 40

#: Employees the CoPortal may see: the Co Emp ones and the TDS ones (TDS employees stay visible there).
COPORTAL_Q = Q(co_emp_enabled=True) | Q(tds_enabled=True)
#: The same scope on a model that reaches the employee through a foreign key (`employee__...`).
COPORTAL_Q_VIA_EMPLOYEE = Q(employee__co_emp_enabled=True) | Q(employee__tds_enabled=True)


def d2(value) -> Decimal:
    """Round to 2 decimal places (half up), the way payroll rounds every amount."""
    return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)


# ─────────────────────────────────────────────────────────────────────────────
#  Categories
# ─────────────────────────────────────────────────────────────────────────────

CATEGORY_CO_EMP = "co_emp"
CATEGORY_TDS = "tds"
CATEGORY_NONE = "none"


def category_of(emp) -> str:
    """Which category the employee is in. A TDS employee never gets PF/ESI, even if bad data also set Co Emp."""
    if getattr(emp, "tds_enabled", False):
        return CATEGORY_TDS
    if getattr(emp, "co_emp_enabled", False):
        return CATEGORY_CO_EMP
    return CATEGORY_NONE


def employee_class(emp) -> str:
    return CLASS_PRODUCTION if getattr(emp, "employment_type", None) == "production" else CLASS_STAFF


# ─────────────────────────────────────────────────────────────────────────────
#  Rules: parsing what is stored (lenient) and validating what is submitted (strict)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rule:
    id: str
    label: str
    basis: str
    min_amount: Decimal
    max_amount: Decimal  # 0 = no upper limit
    rate_percent: Decimal

    def matches(self, amount: Decimal) -> bool:
        return amount >= self.min_amount and (self.max_amount <= 0 or amount <= self.max_amount)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "basis": self.basis,
            "minAmount": _num(self.min_amount),
            "maxAmount": _num(self.max_amount),
            "ratePercent": _num(self.rate_percent),
        }


def _num(value: Decimal) -> int | float:
    """A stored/returned number: a whole number as an int, anything else as a float (two decimals at most)."""
    return int(value) if value == value.to_integral_value() else float(value)


def parse_rules(raw) -> list[Rule]:
    """The rules of a stored list. Lenient on purpose: payroll must never fall over on a malformed stored row, so a row
    that cannot be read is skipped (the API never stores one: clean_rule_list)."""
    rules: list[Rule] = []
    if not isinstance(raw, list):
        return rules
    for row in raw:
        if not isinstance(row, dict):
            continue
        try:
            basis = row.get("basis") or BASIS_BASIC
            if basis not in BASES:
                continue
            rules.append(
                Rule(
                    id=str(row.get("id") or ""),
                    label=str(row.get("label") or ""),
                    basis=basis,
                    min_amount=Decimal(str(row.get("minAmount") or 0)),
                    max_amount=Decimal(str(row.get("maxAmount") or 0)),
                    rate_percent=Decimal(str(row.get("ratePercent") or 0)),
                )
            )
        except (InvalidOperation, ValueError, TypeError):
            continue
    return rules


def rules_for(ps, emp_class: str, kind: str) -> list[Rule]:
    """The rules `ps` (the universal PayrollSettings row, or a branch overlay of it) carries for one class and kind."""
    return parse_rules(getattr(ps, RULE_FIELDS[(emp_class, kind)], None))


def rules_json(ps) -> dict[tuple[str, str], list[dict]]:
    """All four lists of `ps` as JSON-ready rule dicts (normalised), keyed by (class, kind)."""
    return {key: [r.to_json() for r in rules_for(ps, *key)] for key in RULE_FIELDS}


def rules_scope(ps) -> tuple[str, int | None]:
    """('branch', branch id) when `ps` is a branch overlay carrying its own rule lists, else ('global', None)."""
    overrides = getattr(ps, "overrides", None)
    if isinstance(overrides, dict) and any(name in overrides for name in RULE_FIELD_NAMES):
        return "branch", getattr(ps, "branch_id", None)
    return "global", None


def version_of(lists: dict[tuple[str, str], list[dict]]) -> str:
    """The stale-edit guard: a short hash of the four lists. Whoever saves must name the version they started from."""
    payload = {LIST_KEYS[key]: lists[key] for key in RULE_FIELDS}
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class RulesInvalid(ValueError):
    """A submitted rule list that cannot be stored. `payload()` is the 400 body."""

    def __init__(
        self,
        message: str,
        list_key: str,
        index: int | None = None,
        field: str | None = None,
        other_index: int | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.list_key = list_key
        self.index = index
        self.field = field
        self.other_index = other_index

    def payload(self) -> dict:
        body = {"error": self.message, "list": self.list_key, "ruleIndex": self.index, "field": self.field}
        if self.other_index is not None:
            body["otherRuleIndex"] = self.other_index
        return body


def _amount_text(value: Decimal) -> str:
    return f"{value:,.2f}".rstrip("0").rstrip(".") if value != value.to_integral_value() else f"{int(value):,}"


def _range_text(rule: dict) -> str:
    low, high = Decimal(str(rule["minAmount"])), Decimal(str(rule["maxAmount"]))
    if high <= 0:
        return f"{_amount_text(low)} and above"
    return f"{_amount_text(low)}–{_amount_text(high)}"


def _read_number(value, *, blank_is_zero: bool):
    """(Decimal | None, problem) for a submitted number: a JSON number or numeric text, at most two decimals."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return (ZERO, None) if blank_is_zero else (None, "is required")
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        return None, "must be a number"
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        return None, "must be a number"
    if not number.is_finite():
        return None, "must be a number"
    try:
        rounded = number.quantize(_CENT)
    except InvalidOperation:  # an exponent so large that two decimals do not even fit the decimal context
        return None, "is too large"
    if number != rounded:
        return None, "can have at most two decimal places"
    return rounded, None


def clean_rule_list(raw, emp_class: str, kind: str) -> list[dict]:
    """A submitted list -> the list to store (normalised dicts, ids filled in), or raises RulesInvalid with the first
    problem in plain words. Nothing is stored here."""
    list_key = LIST_KEYS[(emp_class, kind)]
    title = _TITLES[(emp_class, kind)]
    if not isinstance(raw, list):
        raise RulesInvalid(f"{title} rules must be a list.", list_key, None, "list")
    if len(raw) > MAX_RULES_PER_LIST:
        raise RulesInvalid(f"{title} can have at most {MAX_RULES_PER_LIST} rules.", list_key, None, "list")

    cleaned: list[dict] = []
    seen_ids: set[str] = set()
    for index, row in enumerate(raw):
        position = index + 1

        def problem(message: str, field: str, _index=index, _position=position, _row=row):
            name = _row.get("label") if isinstance(_row, dict) and _row.get("label") else None
            who = f"{title} rule {_position}" + (f' ("{name}")' if isinstance(name, str) and name.strip() else "")
            return RulesInvalid(f"{who}: {message}", list_key, _index, field)

        if not isinstance(row, dict):
            raise problem("each rule needs a basis, minimum, maximum and percentage.", "list")

        label = row.get("label")
        if label is not None and not isinstance(label, str):
            raise problem("the label must be text.", "label")
        label = (label or "").strip() or f"Rule {position}"
        if len(label) > MAX_LABEL_LENGTH:
            raise problem(f"the label can be at most {MAX_LABEL_LENGTH} characters.", "label")

        basis = row.get("basis")
        if basis in (None, ""):
            basis = BASIS_BASIC
        if basis not in BASES:
            raise problem("the basis must be basic, first_portion or total.", "basis")

        low, low_problem = _read_number(row.get("minAmount"), blank_is_zero=True)
        if low_problem:
            raise problem(f"Minimum amount {low_problem}.", "minAmount")
        if low < 0 or low > MAX_AMOUNT:
            raise problem(f"Minimum amount must be between 0 and {_amount_text(MAX_AMOUNT)}.", "minAmount")

        high, high_problem = _read_number(row.get("maxAmount"), blank_is_zero=True)
        if high_problem:
            raise problem(f"Maximum amount {high_problem}.", "maxAmount")
        if high < 0 or high > MAX_AMOUNT:
            raise problem(
                f"Maximum amount must be 0 (no upper limit) or between the minimum and {_amount_text(MAX_AMOUNT)}.",
                "maxAmount",
            )
        if 0 < high < low:
            raise problem("Maximum amount must be 0 (no upper limit) or at least the minimum amount.", "maxAmount")

        rate, rate_problem = _read_number(row.get("ratePercent"), blank_is_zero=False)
        if rate_problem:
            raise problem(f"Percentage {rate_problem}.", "ratePercent")
        if rate < 0 or rate > MAX_RATE_PERCENT:
            raise problem("Percentage must be between 0 and 100.", "ratePercent")

        rule_id = row.get("id")
        if rule_id is not None and (isinstance(rule_id, bool) or not isinstance(rule_id, (str, int))):
            raise problem("the id must be text.", "id")
        rule_id = str(rule_id).strip() if rule_id not in (None, "") else ""
        if len(rule_id) > MAX_ID_LENGTH:
            raise problem(f"the id can be at most {MAX_ID_LENGTH} characters.", "id")
        if not rule_id:
            rule_id = uuid.uuid4().hex[:8]
            while rule_id in seen_ids:
                rule_id = uuid.uuid4().hex[:8]
        if rule_id in seen_ids:
            raise problem("another rule in this list has the same id.", "id")
        seen_ids.add(rule_id)

        cleaned.append(
            {
                "id": rule_id,
                "label": label,
                "basis": basis,
                "minAmount": _num(low),
                "maxAmount": _num(high),
                "ratePercent": _num(rate),
            }
        )

    # Ranges of one list must not overlap. Only rules on the same basis are comparable (a Basic range and a total-salary
    # range measure different amounts); for the rest, list order decides, as it does for every match.
    for later in range(len(cleaned)):
        for earlier in range(later):
            a, b = cleaned[earlier], cleaned[later]
            if a["basis"] != b["basis"]:
                continue
            a_low, a_high = Decimal(str(a["minAmount"])), Decimal(str(a["maxAmount"]))
            b_low, b_high = Decimal(str(b["minAmount"])), Decimal(str(b["maxAmount"]))
            a_top = None if a_high <= 0 else a_high
            b_top = None if b_high <= 0 else b_high
            if (a_top is None or b_low <= a_top) and (b_top is None or a_low <= b_top):
                raise RulesInvalid(
                    f'{title} rules {earlier + 1} ("{a["label"]}") and {later + 1} ("{b["label"]}") overlap '
                    f"({_range_text(a)} and {_range_text(b)}). Ranges in one list must not overlap.",
                    list_key,
                    later,
                    "minAmount",
                    other_index=earlier,
                )
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
#  Amounts an employee is judged on
# ─────────────────────────────────────────────────────────────────────────────


def monthly_amounts(emp) -> dict[str, Decimal] | None:
    """The employee's full MONTHLY amount on each basis, from the recorded salary split (the automatic split of the
    salary when none is recorded). None when the employee has no salary amount (nothing to judge)."""
    parts, _recorded = salary_split.effective_split(emp)
    if parts is None:
        return None
    first = sum((parts[c] for c in salary_split.FIRST_PORTION), ZERO)
    return {BASIS_BASIC: d2(parts["basic"]), BASIS_FIRST_PORTION: d2(first), BASIS_TOTAL: d2(emp.salary_amount)}


def split_shares(emp) -> tuple[Decimal, Decimal]:
    """(Basic share, first-portion share) of an employee's pay, as fractions of the whole: from the recorded split when
    the employee has a salary, else the automatic split (first portion 50%, shared equally by its three components)."""
    parts, _recorded = salary_split.effective_split(emp)
    if parts is not None:
        total = sum(parts.values(), ZERO)
        if total > 0:
            first = sum((parts[c] for c in salary_split.FIRST_PORTION), ZERO)
            return parts["basic"] / total, first / total
    return Decimal(1) / Decimal(6), Decimal("0.5")


def production_amounts(emp, monthly_equivalent: Decimal) -> dict[str, Decimal]:
    """A production employee's judged amounts: the monthly-equivalent earnings, and the shares of them that are Basic
    and the first portion (their split shares)."""
    basic_share, first_share = split_shares(emp)
    return {
        BASIS_BASIC: d2(monthly_equivalent * basic_share),
        BASIS_FIRST_PORTION: d2(monthly_equivalent * first_share),
        BASIS_TOTAL: d2(monthly_equivalent),
    }


def match_rule(rules: list[Rule], amounts: dict[str, Decimal] | None) -> tuple[Rule | None, Decimal | None]:
    """(first matching rule, the amount it was tested on), or (None, None)."""
    if not amounts:
        return None, None
    for rule in rules:
        amount = amounts.get(rule.basis)
        if amount is not None and rule.matches(amount):
            return rule, amount
    return None, None


# ─────────────────────────────────────────────────────────────────────────────
#  The result of judging one employee for one pay period
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Statutory:
    category: str
    pf: Decimal = ZERO
    esi: Decimal = ZERO
    pf_rule: Rule | None = None
    esi_rule: Rule | None = None
    pf_tested: Decimal | None = None
    esi_tested: Decimal | None = None
    wages: Decimal = ZERO  # what PF / ESI were taken from: the period's first portion
    first_portion_monthly: Decimal | None = None
    eligibility: dict[str, Decimal] | None = None
    tds: Decimal = ZERO
    tds_percent: Decimal | None = None
    tds_base: Decimal = ZERO
    reason: str | None = None
    rules_scope: str = "global"
    branch_id: int | None = None

    @property
    def pf_rate(self) -> Decimal:
        return self.pf_rule.rate_percent if self.pf_rule else ZERO

    @property
    def esi_rate(self) -> Decimal:
        return self.esi_rule.rate_percent if self.esi_rule else ZERO

    def _rule_json(self, rule: Rule | None, tested: Decimal | None) -> dict | None:
        if rule is None:
            return None
        return {**rule.to_json(), "amountTested": float(tested) if tested is not None else None}

    def breakdown(self) -> dict:
        """The `statutory` block of a slip's breakdown_details.deductions (API contract section 5)."""
        eligibility = self.eligibility or {}
        return {
            "category": self.category,
            "pfWages": float(self.wages),
            "firstPortionMonthly": float(self.first_portion_monthly)
            if self.first_portion_monthly is not None
            else None,
            "pfRule": self._rule_json(self.pf_rule, self.pf_tested),
            "esiRule": self._rule_json(self.esi_rule, self.esi_tested),
            "eligibility": {
                "basic": float(eligibility[BASIS_BASIC]) if BASIS_BASIC in eligibility else None,
                "firstPortion": float(eligibility[BASIS_FIRST_PORTION]) if BASIS_FIRST_PORTION in eligibility else None,
                "total": float(eligibility[BASIS_TOTAL]) if BASIS_TOTAL in eligibility else None,
            },
            "rulesScope": self.rules_scope,
            "branchId": self.branch_id,
            "tds": (
                {"percent": float(self.tds_percent), "base": float(self.tds_base), "amount": float(self.tds)}
                if self.category == CATEGORY_TDS and self.tds_percent is not None
                else None
            ),
            "reason": self.reason,
        }


def _tds_for(emp, earned_gross: Decimal) -> tuple[Decimal, Decimal | None]:
    """(TDS amount, the percentage used) for an employee in the TDS category: percent x earned gross, 2 places."""
    percent = getattr(emp, "tds_percent", None)
    if percent is None or Decimal(str(percent)) <= 0:
        return ZERO, None
    percent = Decimal(str(percent))
    return d2(earned_gross * percent / _HUNDRED), percent


def _statutory(emp, ps, *, amounts, wages: Decimal, first_monthly, earned_gross: Decimal, emp_class: str) -> Statutory:
    category = category_of(emp)
    scope, branch_id = rules_scope(ps)
    result = Statutory(
        category=category,
        rules_scope=scope,
        branch_id=branch_id,
        eligibility=amounts,
        first_portion_monthly=first_monthly,
    )
    if category == CATEGORY_TDS:
        result.tds, result.tds_percent = _tds_for(emp, earned_gross)
        result.tds_base = earned_gross
        result.reason = "TDS employee: tax deducted at source, no PF/ESI"
        return result
    if category == CATEGORY_NONE:
        result.reason = "Not a Co Emp employee: no PF/ESI"
        return result
    result.wages = wages
    result.pf_rule, result.pf_tested = match_rule(rules_for(ps, emp_class, KIND_PF), amounts)
    result.esi_rule, result.esi_tested = match_rule(rules_for(ps, emp_class, KIND_ESI), amounts)
    if result.pf_rule is not None:
        result.pf = d2(wages * result.pf_rule.rate_percent / _HUNDRED)
    if result.esi_rule is not None:
        result.esi = d2(wages * result.esi_rule.rate_percent / _HUNDRED)
    if result.pf_rule is None and result.esi_rule is None:
        result.reason = "Co Emp employee, but no PF or ESI rule covers this salary"
    return result


def staff_statutory(emp, ps, *, prorate_factor: Decimal, earned_gross: Decimal) -> Statutory:
    """PF / ESI / TDS of one staff payroll month. `ps` = the employee's branch settings (settings_for_employee);
    `prorate_factor` = paid days / working days (the factor payroll prorates `basic` with); `earned_gross` = the month's
    earned pay including OT pay (the TDS base)."""
    amounts = monthly_amounts(emp)
    first_monthly = amounts[BASIS_FIRST_PORTION] if amounts else None
    wages = d2(first_monthly * prorate_factor) if first_monthly is not None else ZERO
    return _statutory(
        emp,
        ps,
        amounts=amounts,
        wages=wages,
        first_monthly=first_monthly,
        earned_gross=earned_gross,
        emp_class=CLASS_STAFF,
    )


def production_statutory(emp, ps, *, period_gross: Decimal, monthly_factor: int | Decimal) -> Statutory:
    """PF / ESI / TDS of one production pay period. Eligibility is judged on the monthly-equivalent earnings
    (period gross x `monthly_factor`); PF / ESI are taken from the period's first-portion share of the gross."""
    monthly_equivalent = d2(period_gross * Decimal(monthly_factor))
    amounts = production_amounts(emp, monthly_equivalent)
    _basic_share, first_share = split_shares(emp)
    wages = d2(period_gross * first_share)
    return _statutory(
        emp,
        ps,
        amounts=amounts,
        wages=wages,
        first_monthly=amounts[BASIS_FIRST_PORTION],
        earned_gross=period_gross,
        emp_class=CLASS_PRODUCTION,
    )


def employer_contributions(emp, ps) -> tuple[Decimal, Decimal]:
    """(employer PF, employer ESI) of one MONTH at full attendance, for the CTC figures: the matched rule's percentage of
    the monthly first portion. Nothing for an employee who is not Co Emp (or is in TDS), or has no salary."""
    if category_of(emp) != CATEGORY_CO_EMP:
        return ZERO, ZERO
    amounts = monthly_amounts(emp)
    if amounts is None:
        return ZERO, ZERO
    emp_class = employee_class(emp)
    first = amounts[BASIS_FIRST_PORTION]
    pf_rule, _ = match_rule(rules_for(ps, emp_class, KIND_PF), amounts)
    esi_rule, _ = match_rule(rules_for(ps, emp_class, KIND_ESI), amounts)
    return (
        d2(first * pf_rule.rate_percent / _HUNDRED) if pf_rule else ZERO,
        d2(first * esi_rule.rate_percent / _HUNDRED) if esi_rule else ZERO,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Coverage: how many employees have PF / ESI deductions, and how many do not
# ─────────────────────────────────────────────────────────────────────────────

STATUS_PF_ESI = "pf_esi"
STATUS_PF_ONLY = "pf_only"
STATUS_ESI_ONLY = "esi_only"
STATUS_NEITHER = "neither"
STATUS_NOT_EVALUATED = "not_evaluated"
STATUS_TDS = "tds"
STATUS_NOT_CO_EMP = "not_co_emp"


def _latest_production_gross(employee_ids: list[int]) -> dict[int, tuple[Decimal, str | None]]:
    """employee id -> (gross, pay cycle) of that production employee's latest generated period slip."""
    from .models import SalarySlip

    latest: dict[int, tuple[Decimal, str | None]] = {}
    rows = (
        SalarySlip.objects.filter(employee_id__in=employee_ids, period_start__isnull=False)
        .order_by("employee_id", "-period_end", "-id")
        .distinct("employee_id")
        .values_list("employee_id", "gross_salary", "pay_cycle")
    )
    for employee_id, gross, cycle in rows:
        latest[employee_id] = (Decimal(str(gross)), cycle)
    return latest


def coverage_rows(employees) -> list[dict]:
    """One row per employee (an iterable of Employee with branch / department selected) saying which category they are
    in and, for Co Emp employees, whether the current rules give them PF and ESI.

    Staff are judged on their CURRENT salary split (what the next payroll would do). Production pay varies by period, so
    they are judged on the monthly-equivalent of their LATEST generated slip; with no slip yet the status is
    `not_evaluated`. Settings are resolved per employee branch (a branch override beats the global rules)."""
    from .production_cycles import DEFAULT_MONTHLY_EQUIVALENT_FACTOR, MONTHLY_EQUIVALENT_FACTOR
    from .user_settings import settings_for_employee

    employees = list(employees)
    production_ids = [
        e.id for e in employees if employee_class(e) == CLASS_PRODUCTION and category_of(e) == CATEGORY_CO_EMP
    ]
    latest = _latest_production_gross(production_ids) if production_ids else {}
    settings_by_branch: dict = {}

    def settings_of(emp):
        key = emp.branch_id
        if key not in settings_by_branch:
            settings_by_branch[key] = settings_for_employee(emp)
        return settings_by_branch[key]

    rows = []
    for emp in employees:
        category = category_of(emp)
        emp_class = employee_class(emp)
        row = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}".strip(),
            "employmentType": emp.employment_type,
            "departmentName": emp.department.name if emp.department_id and emp.department else None,
            "branchId": emp.branch_id,
            "branchName": emp.branch.name if emp.branch_id and emp.branch else None,
            "category": category,
            "pf": None,
            "esi": None,
            "pfRatePercent": None,
            "esiRatePercent": None,
            "status": STATUS_TDS if category == CATEGORY_TDS else STATUS_NOT_CO_EMP,
            "tdsPercent": float(emp.tds_percent) if category == CATEGORY_TDS and emp.tds_percent is not None else None,
        }
        if category == CATEGORY_CO_EMP:
            ps = settings_of(emp)
            amounts = None
            pending = False
            if emp_class == CLASS_STAFF:
                amounts = monthly_amounts(emp)
            elif emp.id in latest:
                gross, cycle = latest[emp.id]
                factor = MONTHLY_EQUIVALENT_FACTOR.get(cycle, DEFAULT_MONTHLY_EQUIVALENT_FACTOR)
                amounts = production_amounts(emp, d2(gross * factor))
            else:
                pending = True
            if pending:
                row["status"] = STATUS_NOT_EVALUATED
            else:
                pf_rule, _ = match_rule(rules_for(ps, emp_class, KIND_PF), amounts)
                esi_rule, _ = match_rule(rules_for(ps, emp_class, KIND_ESI), amounts)
                row["pf"], row["esi"] = pf_rule is not None, esi_rule is not None
                row["pfRatePercent"] = _num(pf_rule.rate_percent) if pf_rule else None
                row["esiRatePercent"] = _num(esi_rule.rate_percent) if esi_rule else None
                row["status"] = (
                    STATUS_PF_ESI
                    if pf_rule and esi_rule
                    else STATUS_PF_ONLY
                    if pf_rule
                    else STATUS_ESI_ONLY
                    if esi_rule
                    else STATUS_NEITHER
                )
        rows.append(row)
    return rows


def coverage_counts(rows: list[dict], emp_class: str) -> dict:
    """The coverage numbers of one class from coverage_rows() output."""
    mine = [r for r in rows if (CLASS_PRODUCTION if r["employmentType"] == "production" else CLASS_STAFF) == emp_class]
    co_emp = [r for r in mine if r["category"] == CATEGORY_CO_EMP]
    with_pf = sum(1 for r in co_emp if r["pf"])
    with_esi = sum(1 for r in co_emp if r["esi"])
    with_both = sum(1 for r in co_emp if r["pf"] and r["esi"])
    return {
        "total": len(mine),
        "coEmp": len(co_emp),
        "tds": sum(1 for r in mine if r["category"] == CATEGORY_TDS),
        "notCoEmp": sum(1 for r in mine if r["category"] == CATEGORY_NONE),
        "withPf": with_pf,
        "withEsi": with_esi,
        "withBoth": with_both,
        "withAny": with_pf + with_esi - with_both,
        "withNeither": sum(1 for r in co_emp if r["status"] == STATUS_NEITHER),
        "notEvaluated": sum(1 for r in co_emp if r["status"] == STATUS_NOT_EVALUATED),
    }
