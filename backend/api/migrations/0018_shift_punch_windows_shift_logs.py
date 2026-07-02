from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0017_employee_biometric_device_id"),
    ]

    operations = [
        # ── 3 new fields on shift_templates ─────────────────────────────────
        migrations.AddField(
            model_name="shifttemplate",
            name="first_half_end",
            field=models.TimeField(blank=True, db_column="first_half_end", null=True),
        ),
        migrations.AddField(
            model_name="shifttemplate",
            name="lunch_duration_minutes",
            field=models.IntegerField(db_column="lunch_duration_minutes", default=60),
        ),
        migrations.AddField(
            model_name="shifttemplate",
            name="lunch_grace_minutes",
            field=models.IntegerField(db_column="lunch_grace_minutes", default=10),
        ),
        # ── DailyShiftLog table ──────────────────────────────────────────────
        migrations.CreateModel(
            name="DailyShiftLog",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False)),
                ("date", models.DateField()),
                ("punch1", models.TimeField(blank=True, null=True)),
                ("punch2", models.TimeField(blank=True, null=True)),
                ("punch3", models.TimeField(blank=True, null=True)),
                ("punch4", models.TimeField(blank=True, null=True)),
                ("total_punches", models.IntegerField(default=0)),
                ("first_half", models.BooleanField(default=False)),
                ("second_half", models.BooleanField(default=False)),
                ("shifts_completed", models.DecimalField(decimal_places=2, default=0, max_digits=3)),
                ("late_morning", models.BooleanField(default=False)),
                ("late_return", models.BooleanField(default=False)),
                ("late_reason", models.TextField(blank=True, null=True)),
                ("computed_at", models.DateTimeField(auto_now=True)),
                (
                    "employee",
                    models.ForeignKey(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="daily_shift_logs",
                        to="api.employee",
                    ),
                ),
                (
                    "shift",
                    models.ForeignKey(
                        blank=True,
                        db_column="shift_id",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="daily_logs",
                        to="api.shifttemplate",
                    ),
                ),
            ],
            options={"db_table": "daily_shift_logs"},
        ),
        migrations.AlterUniqueTogether(
            name="dailyshiftlog",
            unique_together={("employee", "date")},
        ),
        # ── MonthlyShiftSummary table ────────────────────────────────────────
        migrations.CreateModel(
            name="MonthlyShiftSummary",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False)),
                ("year", models.IntegerField()),
                ("month", models.IntegerField()),
                ("total_shifts", models.DecimalField(decimal_places=2, default=0, max_digits=5)),
                ("total_late_count", models.IntegerField(default=0)),
                ("permissions_used", models.IntegerField(default=0)),
                ("billable_late_count", models.IntegerField(default=0)),
                ("shift_deductions", models.DecimalField(decimal_places=2, default=0, max_digits=5)),
                ("salary_deduction_amount", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "employee",
                    models.ForeignKey(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="monthly_shift_summaries",
                        to="api.employee",
                    ),
                ),
            ],
            options={"db_table": "monthly_shift_summaries"},
        ),
        migrations.AlterUniqueTogether(
            name="monthlyshiftsummary",
            unique_together={("employee", "year", "month")},
        ),
    ]
