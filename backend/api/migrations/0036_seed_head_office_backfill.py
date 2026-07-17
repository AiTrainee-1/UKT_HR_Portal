"""
One-time cutover for multi-branch data isolation: every Employee, Department
and Holiday row predates the Branch concept being enforced anywhere, so they
all have a null branch_id today. This migration:

  1. Designates exactly one Branch as Head Office (is_head_office=True) —
     promotes the oldest existing branch if any already exist (e.g. seeded
     via the Manage Branch UI), otherwise creates one named "Head Office".
     No-ops if a Head Office branch already exists (idempotent / safe to
     re-run).
  2. Backfills every Employee/Department/Holiday with a null branch_id to
     that Head Office branch, so nothing is left unassigned.

HRUser.branch_id is deliberately left untouched (still null) — null means
"unscoped, sees every branch" (see permission_middleware.py), which is
exactly how every existing HR/MD/Director login already behaves today. Only
Employees/Departments/Holidays (physical entities tied to a location) get
backfilled; forcing existing portal logins onto a specific branch would be a
regression, not a no-op.
"""
from django.db import migrations


def seed_and_backfill(apps, schema_editor):
    Branch = apps.get_model("api", "Branch")
    Employee = apps.get_model("api", "Employee")
    Department = apps.get_model("api", "Department")
    Holiday = apps.get_model("api", "Holiday")

    head_office = Branch.objects.filter(is_head_office=True).first()
    if head_office is None:
        head_office = Branch.objects.order_by("id").first()
        if head_office is None:
            head_office = Branch.objects.create(name="Head Office", code="HO", is_active=True)
        head_office.is_head_office = True
        if not head_office.code:
            head_office.code = "HO"
        head_office.save(update_fields=["is_head_office", "code"])

    Employee.objects.filter(branch_id__isnull=True).update(branch_id=head_office.id)
    Department.objects.filter(branch_id__isnull=True).update(branch_id=head_office.id)
    Holiday.objects.filter(branch_id__isnull=True).update(branch_id=head_office.id)


def noop_reverse(apps, schema_editor):
    # Deliberately not reversible — un-assigning branch_id back to null would
    # discard real information (which branch an employee was moved into
    # in the meantime) with no way to tell which rows were touched by this
    # migration versus assigned normally afterward.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0035_branch_code_head_office"),
    ]

    operations = [
        migrations.RunPython(seed_and_backfill, noop_reverse),
    ]
