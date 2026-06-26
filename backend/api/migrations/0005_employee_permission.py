from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0004_salaryslip_week_number"),
    ]

    operations = [
        migrations.CreateModel(
            name="EmployeePermission",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("employee", models.ForeignKey(
                    db_column="employee_id",
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="permissions",
                    to="api.employee",
                )),
                ("date", models.DateField()),
                ("permission_time", models.TimeField(blank=True, db_column="permission_time", null=True)),
                ("reason", models.TextField(blank=True, null=True)),
                ("status", models.TextField(
                    choices=[("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected")],
                    default="pending",
                )),
                ("hr_comment", models.TextField(blank=True, db_column="hr_comment", null=True)),
                ("approved_by", models.TextField(blank=True, db_column="approved_by", null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
            ],
            options={"db_table": "employee_permissions"},
        ),
    ]
