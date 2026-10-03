"""
Salary split: the mandatory 50% + 50% breakdown of an employee's salary.

    First portion  (50% of the salary)   Basic + DA + Retaining Allowance
    Second portion (50% of the salary)   Other Allowance + Petrol Allowance + HRA + Special Allowance + CA

It applies to whatever the employee's Salary Amount is, Monthly or Weekly alike (`salary_type` only says how
often that amount is paid). The eight amounts are filled in automatically from the salary (`default_split`),
can be edited one by one, and must always add up to the rule: each portion is exactly half of the salary and
the two portions add up to the salary (`validate`).

The split is descriptive. Payroll, attendance and every other calculation still run on `Employee.salary_amount`
exactly as before and never read these columns, so a split can be added, edited or missing without changing a
single payslip. An employee with no salary amount has no split, and one created before this existed has none
until their salary is next saved or changed.

All money arithmetic is in whole paise, so the parts always add up to the total exactly (no float drift, no
stray paisa). The frontend has the same rules in `frontend/src/lib/salary-split.ts`; both are tested against
the same worked examples, so a form and the server can never disagree about what a valid split is.
"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

FIRST_PORTION = ("basic", "da", "retaining_allowance")
SECOND_PORTION = ("other_allowance", "petrol_allowance", "hra", "special_allowance", "ca")
COMPONENTS = FIRST_PORTION + SECOND_PORTION

LABELS = {
    "basic": "Basic",
    "da": "DA",
    "retaining_allowance": "Retaining Allowance",
    "other_allowance": "Other Allowance",
    "petrol_allowance": "Petrol Allowance",
    "hra": "HRA",
    "special_allowance": "Special Allowance",
    "ca": "CA",
}

# API / JSON names (camelCase), and the Employee columns they are stored in.
JSON_KEYS = {
    "basic": "basic",
    "da": "da",
    "retaining_allowance": "retainingAllowance",
    "other_allowance": "otherAllowance",
    "petrol_allowance": "petrolAllowance",
    "hra": "hra",
    "special_allowance": "specialAllowance",
    "ca": "ca",
}
COLUMNS = {c: f"salary_{c}" for c in COMPONENTS}  # Employee attribute names; the database columns are in models/core.py
COLUMN_NAMES = tuple(COLUMNS.values())

# What two of the components were called before their names were corrected (RHA -> HRA, Retention -> Retaining).
# Still understood wherever a split or a sheet is SUBMITTED, so an older client, a script, or a template downloaded
# before the correction keeps working; never produced.
LEGACY_JSON_KEYS = {"retentionAllowance": "retainingAllowance", "rha": "hra"}
LEGACY_LABELS = {"Retention Allowance": "Retaining Allowance", "RHA": "HRA"}

FIRST_LABEL = "First portion (Basic + DA + Retaining Allowance)"
SECOND_LABEL = "Second portion (Other + Petrol + HRA + Special Allowance + CA)"

_TWO_PLACES = Decimal("0.01")


def to_paise(value) -> int:
    return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def from_paise(paise: int) -> Decimal:
    return (Decimal(paise) / 100).quantize(_TWO_PLACES)


def rupees(value) -> str:
    return f"₹{Decimal(str(value)).quantize(_TWO_PLACES):,.2f}"


def halves(total) -> tuple[int, int]:
    """(first, second) in paise: 50% each, the odd paisa (if any) going to the first portion."""
    t = to_paise(total)
    first = (t + 1) // 2
    return first, t - first


def _share(amount: int, parts: int) -> list[int]:
    """`amount` paise in `parts` equal shares; the leftover paise go one each to the earliest shares."""
    base, extra = divmod(amount, parts)
    return [base + (1 if i < extra else 0) for i in range(parts)]


def default_split(total) -> dict[str, Decimal]:
    """The automatic split of a salary: each portion is half of it, shared equally by its components."""
    first, second = halves(total)
    values = _share(first, len(FIRST_PORTION)) + _share(second, len(SECOND_PORTION))
    return {c: from_paise(v) for c, v in zip(COMPONENTS, values)}


def _rescale_portion(old: list[int], target: int) -> list[int]:
    """Spread `target` paise over the components in the same proportions as `old` (largest remainder), or equally
    when `old` is empty / all zero."""
    total = sum(old)
    if not old or total <= 0:
        return _share(target, len(old) or 1)
    quotas = [target * o // total for o in old]
    remainders = [(target * o) % total for o in old]
    leftover = target - sum(quotas)
    for i in sorted(range(len(old)), key=lambda i: (-remainders[i], i))[:leftover]:
        quotas[i] += 1
    return quotas


def rescale(existing: dict | None, total) -> dict[str, Decimal]:
    """A new salary total with the same shape: each portion is 50% of the new total, and inside it the components
    keep the proportions they had (a portion that was all zero is shared equally). No stored split: the default."""
    if not existing:
        return default_split(total)
    # A split nobody has edited is still the automatic one: it stays the automatic one for the new salary, instead
    # of drifting by a paisa in the shares.
    if existing == default_split(sum(existing.values())):
        return default_split(total)
    first, second = halves(total)
    first_old = [to_paise(existing[c]) for c in FIRST_PORTION]
    second_old = [to_paise(existing[c]) for c in SECOND_PORTION]
    values = _rescale_portion(first_old, first) + _rescale_portion(second_old, second)
    return {c: from_paise(v) for c, v in zip(COMPONENTS, values)}


def validate(total, parts: dict) -> str | None:
    """None when `parts` is a valid split of `total`, else the first problem in plain words."""
    t = to_paise(total)
    lo, hi = t // 2, (t + 1) // 2  # the two whole-paise amounts nearest to exactly half
    for c in COMPONENTS:
        if to_paise(parts[c]) < 0:
            return f"{LABELS[c]} cannot be negative."
    first = sum(to_paise(parts[c]) for c in FIRST_PORTION)
    second = sum(to_paise(parts[c]) for c in SECOND_PORTION)
    half = rupees(from_paise(hi))  # what the first portion is set to by default (the odd paisa, if any, goes there)
    if first not in (lo, hi):
        return f"{FIRST_LABEL} is {rupees(from_paise(first))}; it must be 50% of the salary ({half})."
    if second not in (lo, hi):
        return f"{SECOND_LABEL} is {rupees(from_paise(second))}; it must be 50% of the salary ({half})."
    if first + second != t:
        return (
            f"The two portions add up to {rupees(from_paise(first + second))} but the salary is "
            f"{rupees(from_paise(t))}; together they must equal the salary exactly."
        )
    return None


def parse_breakup(raw) -> tuple[dict[str, Decimal] | None, str | None]:
    """A submitted split (JSON object with the eight camelCase keys) -> ({component: Decimal}, None), or
    (None, message). Every component is required, a plain non-negative amount with at most two decimals."""
    if not isinstance(raw, dict):
        return None, "salaryBreakup must be an object with the eight salary components."
    raw = {**raw, **{new: raw[old] for old, new in LEGACY_JSON_KEYS.items() if old in raw and new not in raw}}
    missing = [LABELS[c] for c in COMPONENTS if JSON_KEYS[c] not in raw]
    if missing:
        return None, f"The salary split is missing: {', '.join(missing)}."
    parts: dict[str, Decimal] = {}
    for c in COMPONENTS:
        value = raw[JSON_KEYS[c]]
        if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
            return None, f"{LABELS[c]} must be an amount (enter 0 if there is none)."
        try:
            amount = Decimal(str(value).strip())
        except InvalidOperation:
            return None, f"{LABELS[c]} must be a number, got '{value}'."
        if not amount.is_finite():
            return None, f"{LABELS[c]} must be a number, got '{value}'."
        if amount < 0:
            return None, f"{LABELS[c]} cannot be negative."
        if amount != amount.quantize(_TWO_PLACES):
            return None, f"{LABELS[c]} can have at most two decimal places."
        if amount >= Decimal("100000000"):
            return None, f"{LABELS[c]} is too large."
        parts[c] = amount.quantize(_TWO_PLACES)
    return parts, None


def resolve(total, submitted, stored, *, total_changed: bool) -> tuple[dict[str, Decimal] | None, str | None]:
    """The split to save for an employee whose salary amount is `total`: (parts, error).

    * a submitted split is validated against `total` and used as given;
    * otherwise, when the total changed (or there is no stored split), it is derived: the stored split re-scaled
      to the new total, or the default split when there is none;
    * otherwise the stored split stays;
    * no salary amount means no split (parts None); submitting one without a salary is an error.
    """
    if total is None or Decimal(str(total)) <= 0:
        if submitted is not None:
            return None, "A salary split needs a salary amount."
        return None, None
    if submitted is not None:
        parts, error = parse_breakup(submitted)
        if error:
            return None, error
        error = validate(total, parts)
        return (None, error) if error else (parts, None)
    if stored and not total_changed:
        return stored, None
    return (rescale(stored, total) if stored else default_split(total)), None


def breakup_of(emp) -> dict[str, Decimal] | None:
    """The split stored on an employee, or None when none is recorded."""
    values = {c: getattr(emp, COLUMNS[c]) for c in COMPONENTS}
    if any(v is None for v in values.values()):
        return None
    return {c: Decimal(str(v)) for c, v in values.items()}


def apply_to_employee(emp, parts: dict | None) -> None:
    """Set (or clear, with None) the eight columns on an Employee instance. The caller saves."""
    for c in COMPONENTS:
        setattr(emp, COLUMNS[c], parts[c] if parts else None)


def json_of(emp) -> dict | None:
    """The stored split as the API returns it ({basic, da, retainingAllowance, ...}), or None."""
    parts = breakup_of(emp)
    if parts is None:
        return None
    return {JSON_KEYS[c]: float(parts[c]) for c in COMPONENTS}


def effective_split(emp) -> tuple[dict[str, Decimal] | None, bool]:
    """
    The split to SHOW for an employee, and whether it is a recorded one: (parts, recorded).

    - a stored split that still adds up to the salary  -> (stored, True)
    - a salary but no usable stored split (an employee created before the split existed, or a stored split the salary
      has since moved away from by some route that did not re-scale it) -> (the automatic split of the salary, False)
    - no salary amount (e.g. paid per shift)            -> (None, False)

    Read-only reports (the Compensation page, the CTC statement) use this so every employee with a salary always shows
    eight components that add up to it, without writing anything.
    """
    total = getattr(emp, "salary_amount", None)
    if not total or total <= 0:
        return None, False
    stored = breakup_of(emp)
    if stored is not None and validate(total, stored) is None:
        return stored, True
    return default_split(total), False
