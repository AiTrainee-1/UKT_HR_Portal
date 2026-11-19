"""Dated histories of two attendance-changing switches (compensation claims review, 19 Nov 2026).

Additive only:
  * payroll_settings.staff_next_morning_history  [{"from", "enabled", "cutoff"}]  (db_default [])
  * compensation_config.ot_quarter_rule_history  [{"from", "on"}]                  (db_default [])

Changing the staff next-morning switch / cut-off or the Type 2 quarters rule used to re-judge every day already decided
by the rule the next time it was recomputed. From now on every change in Settings appends an entry dated that day, and a
day follows the entry in force on it (api/settings_history.py); an empty history follows the live fields as before.

Data step: one entry seeded from the CURRENT values on the rows that exist, dated from the rule's own start
(staff_next_morning_from / claims_from, both set by 0166): so nothing that has been judged changes. Rows that already have
a history are left alone (re-running is a no-op). Reversing the data step is a no-op; reversing the schema drops the
columns.
"""

from django.db import migrations, models


def seed_histories(apps, schema_editor):
    PayrollSettings = apps.get_model("api", "PayrollSettings")
    CompensationConfig = apps.get_model("api", "CompensationConfig")
    for ps in PayrollSettings.objects.all():
        if ps.staff_next_morning_history:
            continue
        cutoff = ps.staff_next_morning_cutoff
        ps.staff_next_morning_history = [
            {
                "from": ps.staff_next_morning_from.isoformat() if ps.staff_next_morning_from else None,
                "enabled": bool(ps.staff_next_morning_enabled),
                "cutoff": cutoff.strftime("%H:%M") if cutoff else "06:00",
            }
        ]
        ps.save(update_fields=["staff_next_morning_history"])
    for config in CompensationConfig.objects.all():
        if config.ot_quarter_rule_history:
            continue
        config.ot_quarter_rule_history = [
            {
                "from": config.claims_from.isoformat() if config.claims_from else None,
                "on": bool(config.ot_quarter_rule),
            }
        ]
        config.save(update_fields=["ot_quarter_rule_history"])


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0166_compensation_claims"),
    ]

    operations = [
        migrations.AddField(
            model_name="payrollsettings",
            name="staff_next_morning_history",
            field=models.JSONField(
                blank=True, db_column="staff_next_morning_history", db_default=[], default=list
            ),
        ),
        migrations.AddField(
            model_name="compensationconfig",
            name="ot_quarter_rule_history",
            field=models.JSONField(blank=True, db_column="ot_quarter_rule_history", db_default=[], default=list),
        ),
        migrations.RunPython(seed_histories, migrations.RunPython.noop),
    ]
