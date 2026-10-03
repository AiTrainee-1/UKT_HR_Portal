"""Correct two component names of the salary split: RHA -> HRA and Retention Allowance -> Retaining Allowance.

State only. Both fields keep their database columns (`salary_rha`, `salary_retention_allowance`, pinned by `db_column`
on the model), so this runs no SQL and moves no data, and the previous release - which still reads those columns under
the old attribute names - keeps working while this one rolls out. A physical column rename can follow in a later release
once nothing reads the old names.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0109_hod_employee_exclusions"),
    ]

    operations = [
        migrations.RenameField(
            model_name="employee",
            old_name="salary_retention_allowance",
            new_name="salary_retaining_allowance",
        ),
        migrations.RenameField(
            model_name="employee",
            old_name="salary_rha",
            new_name="salary_hra",
        ),
    ]
