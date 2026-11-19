"""OutpassGateScan.scan_type gains the choice "tea" ("Tea break"): a tea-break code refused by a gate that does not
take tea breaks is logged as a denied tea scan, not as an exit (19 Nov 2026). Choices only: no column changes."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0163_reception_desk_sessions"),
    ]

    operations = [
        migrations.AlterField(
            model_name="outpassgatescan",
            name="scan_type",
            field=models.TextField(
                choices=[("exit", "Exit"), ("entry", "Entry"), ("tea", "Tea break")],
                db_column="scan_type",
                default="exit",
            ),
        ),
    ]
