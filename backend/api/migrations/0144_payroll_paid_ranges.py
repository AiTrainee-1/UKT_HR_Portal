# Production pay-cycle changes (2026-11-06): Payroll.paid_ranges records the days a production period row actually pays
# when an employee moved between Weekly / BiWeekly / Monthly, so the same working day is never paid twice
# (production_coverage.py).
#
# Additive only: one nullable column and no data step. NULL means "the whole period", which is what every existing row
# paid, so nothing already generated changes and a backend still running the previous release keeps working.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0143_whatsapp_send_queue"),
    ]

    operations = [
        migrations.AddField(
            model_name="payroll",
            name="paid_ranges",
            field=models.JSONField(blank=True, db_column="paid_ranges", null=True),
        ),
    ]
