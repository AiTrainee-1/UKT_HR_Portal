"""Tea Break scan cooldown (owner 2026-11-21): after a successful tea-break scan, the same employee's next scan within
this many minutes creates no record. Additive, with a database default, so running code and old rows are unaffected."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0175_geo_tracking_alerts"),
    ]

    operations = [
        migrations.AddField(
            model_name="teabreakrule",
            name="scan_cooldown_minutes",
            field=models.IntegerField(db_column="scan_cooldown_minutes", db_default=5, default=5),
        ),
    ]
