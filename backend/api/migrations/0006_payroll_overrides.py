from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0005_employee_permission"),
    ]

    operations = [
        # ── EmployeeShiftAssignment: per-employee schedule overrides ───────────
        migrations.AddField(
            model_name="employeeshiftassignment",
            name="custom_start_time",
            field=models.TimeField(blank=True, null=True, db_column="custom_start_time"),
        ),
        migrations.AddField(
            model_name="employeeshiftassignment",
            name="custom_end_time",
            field=models.TimeField(blank=True, null=True, db_column="custom_end_time"),
        ),
        migrations.AddField(
            model_name="employeeshiftassignment",
            name="saturday_off",
            field=models.BooleanField(default=False, db_column="saturday_off"),
        ),
        # ── SessionConfig: minimum checkout time for session completion ─────────
        migrations.AddField(
            model_name="sessionconfig",
            name="minimum_checkout_time",
            field=models.TimeField(blank=True, null=True, db_column="minimum_checkout_time"),
        ),
        # ── SalarySlip: detailed breakdown fields ─────────────────────────────
        migrations.AddField(
            model_name="salaryslip",
            name="paid_leave_days",
            field=models.DecimalField(decimal_places=1, default=0, max_digits=4, db_column="paid_leave_days"),
        ),
        migrations.AddField(
            model_name="salaryslip",
            name="unpaid_leave_days",
            field=models.DecimalField(decimal_places=1, default=0, max_digits=4, db_column="unpaid_leave_days"),
        ),
        migrations.AddField(
            model_name="salaryslip",
            name="late_days",
            field=models.IntegerField(default=0, db_column="late_days"),
        ),
        migrations.AddField(
            model_name="salaryslip",
            name="completed_sessions",
            field=models.IntegerField(default=0, db_column="completed_sessions"),
        ),
        migrations.AddField(
            model_name="salaryslip",
            name="breakdown_details",
            field=models.JSONField(blank=True, null=True, db_column="breakdown_details"),
        ),
    ]
