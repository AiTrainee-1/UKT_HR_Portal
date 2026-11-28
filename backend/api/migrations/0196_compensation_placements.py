# Compensation placed on a chosen date (owner 2026-11-28).
"""HR chooses, on a calendar, the date a Shift / OT / Sunday / Holiday Work compensation is taken on; the Department Head
then HR approve it (compensation_placement.py).

Additive only: four nullable / defaulted columns on holiday_work_claims (hr_step, use_date, use_shifts, source_claim_id).
Every existing row reads hr_step = false and nulls, i.e. exactly what it was; reversing drops the columns.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0195_settlement_rounded_amount"),
    ]

    operations = [
        migrations.AddField(
            model_name="holidayworkclaim",
            name="hr_step",
            field=models.BooleanField(db_column="hr_step", db_default=False, default=False),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="use_date",
            field=models.DateField(blank=True, db_column="use_date", null=True),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="use_shifts",
            field=models.DecimalField(blank=True, db_column="use_shifts", decimal_places=2, max_digits=3, null=True),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="source_claim",
            field=models.ForeignKey(
                blank=True,
                db_column="source_claim_id",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="placements",
                to="api.holidayworkclaim",
            ),
        ),
    ]
