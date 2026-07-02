from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0013_alter_payrollsettings_esi_applicable_below_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="ResignationRequest",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="resignation_requests", to="api.employee")),
                ("reason", models.TextField(blank=True, null=True)),
                ("last_working_date", models.DateField(blank=True, db_column="last_working_date", null=True)),
                ("survey_q1_answer", models.TextField(blank=True, db_column="survey_q1_answer", null=True)),
                ("survey_q2_answer", models.TextField(blank=True, db_column="survey_q2_answer", null=True)),
                ("survey_q3_answer", models.TextField(blank=True, db_column="survey_q3_answer", null=True)),
                ("status", models.TextField(default="pending")),
                ("hr_comment", models.TextField(blank=True, db_column="hr_comment", null=True)),
                ("approved_by", models.TextField(blank=True, db_column="approved_by", null=True)),
                ("approved_at", models.DateTimeField(blank=True, db_column="approved_at", null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
            ],
            options={"db_table": "resignation_requests"},
        ),
        migrations.CreateModel(
            name="DepartmentHeadcount",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("department", models.OneToOneField(db_column="department_id", on_delete=django.db.models.deletion.CASCADE, related_name="headcount", to="api.department")),
                ("required_count", models.IntegerField(db_column="required_count", default=0)),
                ("notes", models.TextField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
            ],
            options={"db_table": "department_headcounts"},
        ),
    ]
