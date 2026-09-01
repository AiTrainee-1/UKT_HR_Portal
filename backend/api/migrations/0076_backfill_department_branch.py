"""Give every Department a branch, inferred from where its staff work.

Branch isolation reads Department.branch_id, and before this release every
department was NULL -which is invisible to a branch-scoped login. Without
this step a deployed database serves ZERO departments to every branch user
while an unscoped admin sees them all, and nothing announces that.

It runs here rather than as a separate command because the two must not be
separable: the moment the schema and code land, the data has to be correct.
A manual follow-up step is a step someone eventually forgets, and the failure
is silent.

Rules, per department that has no branch:
  * staff in exactly one branch -> assign it to that branch
  * staff in several branches   -> the branch with the most staff keeps the
                                   original row; a copy is made for each other
                                   branch and only THAT branch's employees are
                                   repointed to it
  * no active staff             -> left alone (nothing to infer from)

Employee.branch_id is never modified. The only employee change is
department_id, and only on the minority side of a split.

Idempotent: it only ever looks at departments where branch_id IS NULL, so
re-running finds nothing to do. Reversing is a no-op -unsetting the branches
again would just recreate the bug, and the split copies cannot be safely
un-merged automatically.
"""

from django.db import migrations


def backfill(apps, schema_editor):
    Department = apps.get_model("api", "Department")
    Employee = apps.get_model("api", "Employee")

    for d in Department.objects.filter(branch__isnull=True).order_by("name"):
        counts = {}
        for bid in Employee.objects.filter(
            department_id=d.id, status="active"
        ).values_list("branch_id", flat=True):
            counts[bid] = counts.get(bid, 0) + 1
        counts.pop(None, None)

        if not counts:
            # No active staff -no basis to guess. Left for an admin to set
            # by hand rather than assigned arbitrarily.
            continue

        ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        keep_bid = ordered[0][0]
        d.branch_id = keep_bid
        d.save(update_fields=["branch"])

        for other_bid, _ in ordered[1:]:
            copy = Department.objects.create(
                name=d.name, description=d.description, branch_id=other_bid,
            )
            Employee.objects.filter(
                department_id=d.id, branch_id=other_bid
            ).update(department_id=copy.id)


def noop_reverse(apps, schema_editor):
    """Deliberately does nothing.

    Clearing branch_id again would restore the "every branch sees zero
    departments" bug, and the per-branch copies this created cannot be merged
    back automatically without guessing which employees came from where.
    Rolling this back is a restore-from-backup operation, not a migration.
    """


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0075_branchsettingsoverride"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
