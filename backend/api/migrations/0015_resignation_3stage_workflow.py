from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0014_resignation_request_department_headcount"),
    ]

    operations = [
        # ResignationRequest — add dept-head and rejection tracking fields
        migrations.AddField(
            model_name="resignationrequest",
            name="dept_head",
            field=models.ForeignKey(
                blank=True, db_column="dept_head_id", null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="resignation_reviews", to="api.employee",
            ),
        ),
        migrations.AddField(
            model_name="resignationrequest",
            name="dept_head_status",
            field=models.TextField(blank=True, db_column="dept_head_status", null=True),
        ),
        migrations.AddField(
            model_name="resignationrequest",
            name="dept_head_comment",
            field=models.TextField(blank=True, db_column="dept_head_comment", null=True),
        ),
        migrations.AddField(
            model_name="resignationrequest",
            name="dept_head_approved_at",
            field=models.DateTimeField(blank=True, db_column="dept_head_approved_at", null=True),
        ),
        migrations.AddField(
            model_name="resignationrequest",
            name="rejected_by",
            field=models.TextField(blank=True, db_column="rejected_by", null=True),
        ),
        # DepartmentManager — add resignation approval flag
        migrations.AddField(
            model_name="departmentmanager",
            name="can_approve_resignations",
            field=models.BooleanField(db_column="can_approve_resignations", default=True),
        ),
        # PayrollSettings — add company logo + authorized signature
        migrations.AddField(
            model_name="payrollsettings",
            name="company_logo",
            field=models.TextField(blank=True, db_column="company_logo", null=True),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="authorized_signature",
            field=models.TextField(blank=True, db_column="authorized_signature", null=True),
        ),
    ]
