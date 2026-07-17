"""
One-time backfill for the per-branch "Unit Code" identifier (HO-1, HO-2,
Unit1-1, ...) introduced alongside Branch.next_employee_seq /
Employee.unit_code in 0037. Existing employees predate the feature, so this
assigns each of them the next number in their branch (ordered by id, i.e.
creation order) and leaves each Branch's counter pointing at the last number
handed out — so the very next employee created for that branch continues
the sequence correctly rather than colliding with a backfilled one.

Employees with no branch, or whose branch has no code set, are left with a
null unit_code — there's nothing meaningful to generate for them.
"""
from django.db import migrations


def backfill(apps, schema_editor):
    Branch = apps.get_model("api", "Branch")
    Employee = apps.get_model("api", "Employee")

    for branch in Branch.objects.filter(code__isnull=False).exclude(code=""):
        seq = branch.next_employee_seq
        employees = Employee.objects.filter(branch_id=branch.id, unit_code__isnull=True).order_by("id")
        for emp in employees:
            seq += 1
            emp.unit_code = f"{branch.code}-{seq}"
            emp.save(update_fields=["unit_code"])
        if seq != branch.next_employee_seq:
            branch.next_employee_seq = seq
            branch.save(update_fields=["next_employee_seq"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0037_unit_code"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
