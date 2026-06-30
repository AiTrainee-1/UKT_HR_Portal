from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0011_payroll_settings_smtp"),
    ]

    operations = [
        migrations.CreateModel(
            name="DepartmentManager",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("can_approve_leaves", models.BooleanField(default=True, db_column="can_approve_leaves")),
                ("can_approve_permissions", models.BooleanField(default=True, db_column="can_approve_permissions")),
                ("is_active", models.BooleanField(default=True, db_column="is_active")),
                ("notes", models.TextField(null=True, blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                (
                    "employee",
                    models.OneToOneField(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="manager_profile",
                        to="api.employee",
                    ),
                ),
            ],
            options={"db_table": "department_managers"},
        ),
        migrations.CreateModel(
            name="ManagerDepartmentAssignment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                (
                    "manager",
                    models.ForeignKey(
                        db_column="manager_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="department_assignments",
                        to="api.departmentmanager",
                    ),
                ),
                (
                    "department",
                    models.ForeignKey(
                        db_column="department_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="manager_assignments",
                        to="api.department",
                    ),
                ),
            ],
            options={
                "db_table": "manager_department_assignments",
                "unique_together": {("manager", "department")},
            },
        ),
        migrations.CreateModel(
            name="ManagerEmployeeAssignment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                (
                    "manager",
                    models.ForeignKey(
                        db_column="manager_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="employee_assignments",
                        to="api.departmentmanager",
                    ),
                ),
                (
                    "employee",
                    models.ForeignKey(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="direct_manager_assignments",
                        to="api.employee",
                    ),
                ),
            ],
            options={
                "db_table": "manager_employee_assignments",
                "unique_together": {("manager", "employee")},
            },
        ),
    ]
