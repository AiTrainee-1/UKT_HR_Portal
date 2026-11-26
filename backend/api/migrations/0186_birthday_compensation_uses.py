# Birthday Compensation on a chosen date (owner 2026-11-25).
"""A worked birthday gives 1.00 day of Birthday Compensation the employee (or HR) places on dates of the birthday month.

Additive only: one new table, birthday_compensation_uses (one row per placement: a full day or a half, decided by the
Department Head then HR). Nothing existing is changed; reversing drops the table.
"""

import django.db.models.deletion
from decimal import Decimal
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0185_birthday_claims_from"),
    ]

    operations = [
        migrations.CreateModel(
            name="BirthdayCompensationUse",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("birthday", models.DateField(db_column="birthday")),
                ("use_date", models.DateField(db_column="use_date")),
                (
                    "portion",
                    models.TextField(
                        choices=[("full", "Full day"), ("first_half", "First half"), ("second_half", "Second half")],
                        default="full",
                    ),
                ),
                ("days", models.DecimalField(decimal_places=2, max_digits=3)),
                (
                    "status",
                    models.TextField(
                        choices=[
                            ("pending", "Pending"),
                            ("approved", "Approved"),
                            ("rejected", "Rejected"),
                            ("withdrawn", "Withdrawn"),
                        ],
                        default="pending",
                    ),
                ),
                ("reason", models.TextField(blank=True, default="")),
                (
                    "raised_by_role",
                    models.TextField(choices=[("employee", "Employee"), ("hr", "HR")], default="employee"),
                ),
                ("requested_by", models.TextField(blank=True, default="")),
                ("approval_trail", models.JSONField(blank=True, null=True)),
                ("hod_reviewed_by", models.TextField(blank=True, null=True)),
                ("hod_reviewed_at", models.DateTimeField(blank=True, null=True)),
                ("hod_review_comment", models.TextField(blank=True, null=True)),
                ("hr_reviewed_by", models.TextField(blank=True, null=True)),
                ("hr_reviewed_at", models.DateTimeField(blank=True, null=True)),
                ("hr_review_comment", models.TextField(blank=True, null=True)),
                ("withdrawn_by", models.TextField(blank=True, null=True)),
                ("withdrawn_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "employee",
                    models.ForeignKey(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="birthday_compensation_uses",
                        to="api.employee",
                    ),
                ),
            ],
            options={
                "db_table": "birthday_compensation_uses",
                "ordering": ["-created_at", "-id"],
                "indexes": [
                    models.Index(fields=["employee", "birthday"], name="bday_use_emp_birthday"),
                    models.Index(fields=["use_date", "status"], name="bday_use_date_status"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(
                            ("portion__in", ["full", "first_half"]), ("status__in", ("pending", "approved"))
                        ),
                        fields=("employee", "use_date"),
                        name="uniq_bday_use_first_half",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(
                            ("portion__in", ["full", "second_half"]), ("status__in", ("pending", "approved"))
                        ),
                        fields=("employee", "use_date"),
                        name="uniq_bday_use_second_half",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("days__in", [Decimal("1.00"), Decimal("0.50")])),
                        name="bday_use_days_full_or_half",
                    ),
                ],
            },
        ),
    ]
