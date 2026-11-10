# Staff Payroll month workflow (owner 2026-11-10, api/payroll_month_workflow.py): Hold / Unhold, new joiners parked until
# "Add to payroll", the payment status the employee apps show (Paid only after "Mark as Paid"), and one row per finalized
# month ("Payroll Done" locks the month for good).
#
# Additive only: new columns with database defaults (False / "not_paid" / NULL) and one new table, no data step. Every
# existing payroll keeps its figures and its status (Cleared stays Cleared), is not on hold, not parked and not paid as the
# employee apps see it; no month is finalized. A backend still running the previous release keeps working.

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0144_payroll_paid_ranges"),
    ]

    operations = [
        migrations.AddField(
            model_name="payroll",
            name="on_hold",
            field=models.BooleanField(db_column="on_hold", db_default=False, default=False),
        ),
        migrations.AddField(
            model_name="payroll",
            name="hold_changed_at",
            field=models.DateTimeField(blank=True, db_column="hold_changed_at", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="hold_changed_by",
            field=models.TextField(blank=True, db_column="hold_changed_by", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="new_joiner_parked",
            field=models.BooleanField(db_column="new_joiner_parked", db_default=False, default=False),
        ),
        migrations.AddField(
            model_name="payroll",
            name="added_to_payroll_at",
            field=models.DateTimeField(blank=True, db_column="added_to_payroll_at", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="added_to_payroll_by",
            field=models.TextField(blank=True, db_column="added_to_payroll_by", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="payment_status",
            field=models.TextField(
                choices=[("not_paid", "Not paid"), ("paid", "Paid")],
                db_column="payment_status",
                db_default="not_paid",
                default="not_paid",
            ),
        ),
        migrations.AddField(
            model_name="payroll",
            name="payment_paid_at",
            field=models.DateTimeField(blank=True, db_column="payment_paid_at", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="payment_paid_by",
            field=models.TextField(blank=True, db_column="payment_paid_by", null=True),
        ),
        migrations.AddField(
            model_name="payroll",
            name="released_from",
            field=models.TextField(blank=True, db_column="released_from", null=True),
        ),
        migrations.CreateModel(
            name="PayrollMonthClose",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("month", models.IntegerField()),
                ("year", models.IntegerField()),
                ("finalized_at", models.DateTimeField(db_column="finalized_at")),
                ("finalized_by", models.TextField(blank=True, db_column="finalized_by", default="")),
                ("paid_at", models.DateTimeField(blank=True, db_column="paid_at", null=True)),
                ("paid_by", models.TextField(blank=True, db_column="paid_by", default="")),
                ("first_generated_at", models.DateTimeField(blank=True, db_column="first_generated_at", null=True)),
                ("last_computed_at", models.DateTimeField(blank=True, db_column="last_computed_at", null=True)),
                ("snapshot", models.JSONField(blank=True, db_column="snapshot", default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
            ],
            options={
                "db_table": "payroll_month_closes",
                "constraints": [models.UniqueConstraint(fields=("month", "year"), name="uniq_payroll_month_close")],
            },
        ),
    ]
