"""Report Center -> Customise (2026-11-19): the saved custom reports (api/models/report_center.py).

Additive only: one new table, saved_custom_reports. Nothing existing changes; reversing drops the table.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0167_settings_rule_history"),
    ]

    operations = [
        migrations.CreateModel(
            name="SavedCustomReport",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                ("description", models.TextField(blank=True, default="")),
                ("dataset", models.CharField(max_length=40)),
                ("fields", models.JSONField(default=list)),
                ("filters", models.JSONField(blank=True, default=dict)),
                ("sort", models.JSONField(blank=True, default=list)),
                ("created_by_name", models.TextField(blank=True, db_column="created_by_name", default="")),
                ("updated_by_name", models.TextField(blank=True, db_column="updated_by_name", default="")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        db_column="created_by_id",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.hruser",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        db_column="updated_by_id",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.hruser",
                    ),
                ),
            ],
            options={
                "db_table": "saved_custom_reports",
                "ordering": ["name", "id"],
            },
        ),
    ]
