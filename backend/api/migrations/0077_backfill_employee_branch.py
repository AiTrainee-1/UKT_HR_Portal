"""Give branch-less employees a branch, inferred from their department.

Migration 0076 gave every department a branch, but said nothing about
employees created AFTER it ran. An unscoped admin creating an employee
without picking a branch stores NULL, and under strict isolation NULL is
invisible to every branch login -so the employee, and every biometric punch
they generate, silently disappears from their unit's Attendance page while
still arriving correctly from the device.

That failure is silent and looks exactly like "biometric sync is broken",
which is why it is repaired here rather than left to be noticed.

An employee's department already belongs to exactly one branch, so it is the
honest source: an employee working in a Head Office department works at Head
Office. Employees whose department ALSO has no branch are left alone -there
is nothing to infer from, and guessing which unit a person works at would be
worse than leaving them for an admin to set.

Employee.department_id is never modified; only branch_id, and only where it
was NULL. Idempotent -re-running finds nothing.

The recurrence is prevented separately: the employee and department create
endpoints now refuse to store a NULL branch (see views.py).
"""

from django.db import migrations


def backfill(apps, schema_editor):
    Employee = apps.get_model("api", "Employee")

    # One UPDATE per branch rather than per employee: set branch_id from the
    # department's branch wherever the employee has none and the department
    # has one.
    Department = apps.get_model("api", "Department")
    for dept_id, branch_id in Department.objects.filter(
        branch__isnull=False
    ).values_list("id", "branch_id"):
        Employee.objects.filter(
            branch__isnull=True, department_id=dept_id
        ).update(branch_id=branch_id)


def noop_reverse(apps, schema_editor):
    """Deliberately does nothing.

    Clearing these branches again would re-hide the employees and their
    punches from their own unit -restoring a bug, not a prior state.
    """


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0076_backfill_department_branch"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
