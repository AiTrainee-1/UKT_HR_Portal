"""Data migration: the separate PRODUCTION Bonus starts out with exactly the values production was already paid under.

Until 2026-10-24 there was one bonus rate, one wage ceiling and one eligibility limit for everybody (PayrollSettings
bonus_percent / bonus_wage_ceiling / bonus_eligibility_ceiling). Staff keep those three; production now has its own
prod_bonus_* twins (migration 0128). To make sure no bonus changes until HR edits a production value, each current value is
COPIED into its twin:

  * the universal row: a twin still at the value the column was created with (it was never edited) takes the staff value;
  * every branch override (BranchSettingsOverride.overrides) that sets bonus_percent / bonus_wage_ceiling /
    bonus_eligibility_ceiling gets the same value under the prod_ key, unless it already sets that prod_ key.

Nothing is invented: a branch that overrides one of the three gets only that twin, everything else keeps following the
universal production value; a value that was never set anywhere is not written. The copy is idempotent (running it again
changes nothing: an already-edited or already-copied twin is left alone) and reversing it is a no-op (the columns stay,
nothing reads them in an older release).
"""

from decimal import Decimal

from django.db import migrations

# staff field -> its production twin, and the value the twin's column was created with (migration 0128)
PAIRS = (
    ("bonus_percent", "prod_bonus_percent", Decimal("8.33")),
    ("bonus_wage_ceiling", "prod_bonus_wage_ceiling", Decimal("7000")),
    ("bonus_eligibility_ceiling", "prod_bonus_eligibility_ceiling", Decimal("21000")),
)


def copy_universal(row) -> list[str]:
    """Copy the staff values of the universal row into the production twins that were never edited. Returns the names of
    the fields changed (the caller saves them)."""
    changed = []
    for staff_field, prod_field, created_with in PAIRS:
        current = Decimal(str(getattr(row, prod_field)))
        staff_value = getattr(row, staff_field)
        if current == created_with and Decimal(str(staff_value)) != current:
            setattr(row, prod_field, staff_value)
            changed.append(prod_field)
    return changed


def copy_override(overrides: dict) -> dict:
    """The override map of one branch with every bonus_* key mirrored under its prod_ key (an existing prod_ key wins).
    Returns a new dict; the input is not changed."""
    out = dict(overrides or {})
    for staff_field, prod_field, _created_with in PAIRS:
        if staff_field in out and prod_field not in out:
            out[prod_field] = out[staff_field]
    return out


def forwards(apps, schema_editor):
    PayrollSettings = apps.get_model("api", "PayrollSettings")
    BranchSettingsOverride = apps.get_model("api", "BranchSettingsOverride")

    universal = PayrollSettings.objects.filter(pk=1).first()
    if universal is not None:
        changed = copy_universal(universal)
        if changed:
            universal.save(update_fields=changed)

    for row in BranchSettingsOverride.objects.all():
        mirrored = copy_override(row.overrides)
        if mirrored != (row.overrides or {}):
            row.overrides = mirrored
            row.save(update_fields=["overrides", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0128_permission_slabs_prod_bonus"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
