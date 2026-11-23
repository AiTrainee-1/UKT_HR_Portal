"""Casual Leave policy (owner 2026-11-21): eligibility (months or days of service), monthly or yearly allocation, carry
forward, year end, half days - set on Settings -> Casual Leave instead of being hardcoded. Additive: a new one-row table
with database defaults."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0176_tea_break_scan_cooldown"),
    ]

    operations = [
        migrations.CreateModel(
            name="CasualLeavePolicy",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("eligibility_basis", models.CharField(db_default="months", default="months", max_length=10)),
                ("eligibility_value", models.IntegerField(db_default=6, default=6)),
                ("allocation", models.CharField(db_default="monthly", default="monthly", max_length=10)),
                (
                    "monthly_allocation",
                    models.DecimalField(db_default=1, decimal_places=1, default=1, max_digits=4),
                ),
                (
                    "yearly_allocation",
                    models.DecimalField(db_default=12, decimal_places=1, default=12, max_digits=5),
                ),
                ("carry_forward", models.BooleanField(db_default=True, default=True)),
                ("year_end_carry", models.BooleanField(db_default=False, default=False)),
                (
                    "year_end_carry_max",
                    models.DecimalField(blank=True, decimal_places=1, max_digits=5, null=True),
                ),
                ("half_day_allowed", models.BooleanField(db_default=True, default=True)),
                ("updated_by", models.CharField(blank=True, db_default="", default="", max_length=150)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "casual_leave_policy"},
        ),
    ]
