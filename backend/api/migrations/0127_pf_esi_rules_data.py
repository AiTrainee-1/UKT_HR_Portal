"""Data migration: convert the retired PF / ESI methods into the new rule lists, so no configured value is silently lost.

Before 2026-10-24 PF and ESI were configured as flat rates + an ESI ceiling per class (staff / production), behind the
"payroll rules" master switches, plus production salary-range bands behind their own switch. They are replaced by four rule
lists (PayrollSettings.staff_pf_rules / staff_esi_rules / prod_pf_rules / prod_esi_rules; see api/pf_esi.py). Whatever was
ENABLED is carried over as rules on the "total" basis (the old methods tested the full salary / monthly-equivalent earnings,
so the thresholds keep meaning exactly what they meant):

  staff   switch on, PF rate > 0                       -> PF rule  0 .. no limit, pf_rate
          switch on, ESI rate > 0 and ceiling > 0      -> ESI rule 0 .. ceiling, esi_rate
  prod    bands switch on                              -> one PF rule per band with pfRate > 0, one ESI rule per band
                                                          with efRate > 0 (first matching band won in the old engine, so
                                                          a later band is cut back to what the earlier ones left free)
          flat switch on                               -> the flat PF / ESI rule over whatever the bands do not cover

Nothing is invented where nothing was enabled (a switch off, a rate of 0, a ceiling of 0 = ESI never applied). Done for the
universal row and for every branch override that sets any of the retired keys (a branch whose converted lists equal the global
ones simply keeps following the global rules). The retired columns and override keys are left in place (additive-only schema
policy); nothing reads them any more. Reversing is a no-op.

Known, deliberate difference from the old engine, not from this conversion: PF and ESI are now taken from the first 50%
portion of pay and only for employees whose Co Emp switch is on (see the owner's rules in pf_esi.py).
"""

from decimal import Decimal, InvalidOperation

from django.db import migrations

CENT = Decimal("0.01")
OLD_KEYS = (
    "pf_rate",
    "esi_rate",
    "esi_applicable_below",
    "prod_pf_rate",
    "prod_esi_rate",
    "prod_esi_applicable_below",
    "prod_pf_ef_enabled",
    "prod_pf_ef_rules",
    "staff_payroll_rules_enabled",
    "prod_payroll_rules_enabled",
)
NEW_FIELDS = ("staff_pf_rules", "staff_esi_rules", "prod_pf_rules", "prod_esi_rules")


def _dec(value, default="0") -> Decimal:
    try:
        number = Decimal(str(value))
        return number.quantize(CENT) if number.is_finite() else Decimal(default)
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(default)


def _band_amount(value):
    """A band's Min / Max salary the way the old engine read it (blank = 0); None when it was not a number (the old engine
    skipped such a band, so it never matched anybody)."""
    try:
        number = Decimal(str(value or 0))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return number.quantize(CENT) if number.is_finite() else None


def _flag(value) -> bool:
    return bool(value) and str(value).strip().lower() not in ("0", "false", "none", "")


def _num(value: Decimal):
    return int(value) if value == value.to_integral_value() else float(value)


def _subtract(low: Decimal, high, covered: list) -> list:
    """The parts of [low, high] (high None = no upper limit) that no interval of `covered` already holds. All amounts are
    whole paise, so the neighbour of an edge is one paisa away."""
    pieces = [(low, high)]
    for c_low, c_high in covered:
        remaining = []
        for lo, hi in pieces:
            if (c_high is not None and lo > c_high) or (hi is not None and c_low > hi):
                remaining.append((lo, hi))
                continue
            if lo < c_low:
                remaining.append((lo, c_low - CENT))
            if c_high is not None and (hi is None or hi > c_high):
                remaining.append((c_high + CENT, hi))
        pieces = remaining
    return pieces


def _rule(counter: list, label: str, low: Decimal, high, rate: Decimal) -> dict:
    counter[0] += 1
    return {
        "id": f"migrated-{counter[0]}",
        "label": label[:80],
        "basis": "total",
        "minAmount": _num(low),
        "maxAmount": 0 if high is None else _num(high),
        "ratePercent": _num(rate),
    }


def convert_settings(values: dict) -> dict:
    """The four new rule lists for one set of OLD settings values (keys as in OLD_KEYS; missing keys = their defaults)."""
    staff_pf, staff_esi, prod_pf, prod_esi = [], [], [], []
    counter = [0]

    if _flag(values.get("staff_payroll_rules_enabled")):
        pf = _dec(values.get("pf_rate"))
        esi = _dec(values.get("esi_rate"))
        ceiling = _dec(values.get("esi_applicable_below"), "21000")
        if 0 < pf <= 100:
            staff_pf.append(_rule(counter, "Migrated flat PF", Decimal("0"), None, pf))
        if 0 < esi <= 100 and ceiling > 0:
            staff_esi.append(_rule(counter, f"Migrated flat ESI (salary up to {_num(ceiling):,})", Decimal("0"), ceiling, esi))

    covered: list = []
    bands = values.get("prod_pf_ef_rules")
    if _flag(values.get("prod_pf_ef_enabled")) and isinstance(bands, list):
        for position, band in enumerate(bands, start=1):
            if not isinstance(band, dict):
                continue
            low = _band_amount(band.get("minSalary"))
            high_raw = _band_amount(band.get("maxSalary"))
            if low is None or high_raw is None:
                continue
            high = None if high_raw <= 0 else high_raw  # maxSalary 0 meant "no upper limit"
            if high is not None and high < low:
                continue  # such a band could never match
            name = str(band.get("label") or f"Band {position}")
            pf_rate, ef_rate = _dec(band.get("pfRate")), _dec(band.get("efRate"))
            for piece_low, piece_high in _subtract(low, high, covered):
                if 0 < pf_rate <= 100:
                    prod_pf.append(_rule(counter, f"{name} (PF)", piece_low, piece_high, pf_rate))
                if 0 < ef_rate <= 100:
                    prod_esi.append(_rule(counter, f"{name} (ESI)", piece_low, piece_high, ef_rate))
            covered.append((low, high))  # a matched band took precedence over the flat rates, even at 0%

    if _flag(values.get("prod_payroll_rules_enabled")):
        pf = _dec(values.get("prod_pf_rate"))
        esi = _dec(values.get("prod_esi_rate"))
        ceiling = _dec(values.get("prod_esi_applicable_below"), "21000")
        if 0 < pf <= 100:
            for piece_low, piece_high in _subtract(Decimal("0"), None, covered):
                prod_pf.append(_rule(counter, "Migrated flat PF", piece_low, piece_high, pf))
        if 0 < esi <= 100 and ceiling > 0:
            for piece_low, piece_high in _subtract(Decimal("0"), ceiling, covered):
                prod_esi.append(
                    _rule(counter, f"Migrated flat ESI (monthly earnings up to {_num(ceiling):,})", piece_low, piece_high, esi)
                )

    return {
        "staff_pf_rules": staff_pf,
        "staff_esi_rules": staff_esi,
        "prod_pf_rules": prod_pf,
        "prod_esi_rules": prod_esi,
    }


def forwards(apps, schema_editor):
    PayrollSettings = apps.get_model("api", "PayrollSettings")
    BranchSettingsOverride = apps.get_model("api", "BranchSettingsOverride")

    universal = PayrollSettings.objects.filter(pk=1).first()
    if universal is None:
        return  # a fresh install: nothing was ever configured
    old_values = {key: getattr(universal, key) for key in OLD_KEYS}
    converted = convert_settings(old_values)
    changed = [field for field in NEW_FIELDS if converted[field] and not getattr(universal, field)]
    for field in changed:
        setattr(universal, field, converted[field])
    if changed:
        universal.save(update_fields=changed)
    universal_lists = {field: getattr(universal, field) or [] for field in NEW_FIELDS}

    for row in BranchSettingsOverride.objects.all():
        overrides = dict(row.overrides or {})
        if not any(key in overrides for key in OLD_KEYS) or any(field in overrides for field in NEW_FIELDS):
            continue
        effective = {key: overrides.get(key, old_values[key]) for key in OLD_KEYS}
        branch_lists = convert_settings(effective)
        if branch_lists == universal_lists:
            continue
        overrides.update(branch_lists)
        row.overrides = overrides
        row.save(update_fields=["overrides", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0126_pf_esi_tds_schema"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
