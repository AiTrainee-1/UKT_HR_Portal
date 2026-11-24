# Settings -> Auto-Reject Requests (owner 2026-11-24): two new tables, nothing else changes (additive).

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0179_employee_investigation"),
    ]

    operations = [
        migrations.CreateModel(
            name="RequestAutoRejectSettings",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("enabled", models.BooleanField(db_default=True, default=True)),
                ("days", models.PositiveSmallIntegerField(db_default=45, default=45)),
                ("last_run_at", models.DateTimeField(blank=True, null=True)),
                ("last_run_by", models.TextField(blank=True, db_default="", default="")),
                ("last_run_result", models.JSONField(blank=True, default=dict)),
                ("updated_by", models.TextField(blank=True, db_default="", default="")),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "request_auto_reject_settings",
            },
        ),
        migrations.CreateModel(
            name="AutoRejectedRequest",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("kind", models.TextField()),
                ("request_id", models.IntegerField()),
                ("employee_code", models.TextField(blank=True, default="")),
                ("employee_name", models.TextField(blank=True, default="")),
                ("branch_id", models.IntegerField(blank=True, null=True)),
                ("what", models.TextField(blank=True, default="")),
                ("summary", models.TextField(blank=True, default="")),
                ("submitted_at", models.DateTimeField()),
                ("days_waited", models.PositiveIntegerField(default=0)),
                ("days_setting", models.PositiveSmallIntegerField(default=45)),
                ("remark", models.TextField(blank=True, default="")),
                (
                    "trigger",
                    models.TextField(
                        choices=[("nightly", "Nightly run"), ("run_now", "Run now")],
                        default="nightly",
                    ),
                ),
                ("run_by", models.TextField(blank=True, default="")),
                ("rejected_at", models.DateTimeField(auto_now_add=True)),
                ("effects", models.JSONField(blank=True, default=dict)),
                (
                    "employee",
                    models.ForeignKey(
                        blank=True,
                        db_column="employee_id",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="auto_rejected_requests",
                        to="api.employee",
                    ),
                ),
            ],
            options={
                "db_table": "auto_rejected_requests",
                "ordering": ["-rejected_at", "-id"],
                "indexes": [
                    models.Index(fields=["-rejected_at"], name="auto_rejected_at_idx"),
                    models.Index(fields=["kind", "request_id"], name="auto_rejected_kind_req_idx"),
                ],
            },
        ),
    ]
