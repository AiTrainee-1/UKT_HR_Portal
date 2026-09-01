"""
Department → Branch backfill (one-off, per environment)
=======================================================
Branch isolation reads `Department.branch_id`. Before this change every
department was NULL, which is invisible to a branch-scoped login -so on a
database that has not been backfilled, every branch user sees ZERO
departments while an unscoped admin sees them all.

Migrations cannot do this: which branch a department belongs to is inferred
from where its staff actually work, and that differs per environment. Run
this ONCE per database, immediately after `migrate`, before letting branch
users back in.

What it does, per department that has no branch:
  • staff in exactly one branch  -> assign it to that branch
  • staff in several branches    -> the branch with the most staff keeps the
                                   original row; a copy is created for each
                                   other branch, and only THAT branch's
                                   employees are repointed to the copy
  • no active staff              -> left alone and reported (nothing to infer
                                   from; assign it by hand in the UI)

`Employee.branch_id` is never modified. The only employee change is
`department_id`, and only for employees on the minority side of a split.

Usage:
  python manage.py backfill_department_branch            # dry run, changes nothing
  python manage.py backfill_department_branch --apply    # commit

Always read the dry run first -it prints every assignment and split.
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import F


class Command(BaseCommand):
    help = "Give every Department a branch, inferred from where its staff work."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="Commit the changes. Without this the transaction is rolled back.",
        )

    def handle(self, *args, **options):
        from api.models import Branch, Department, Employee

        apply = options["apply"]
        out, ok, warn = self.stdout, self.style.SUCCESS, self.style.WARNING

        def branch_name(bid):
            b = Branch.objects.filter(id=bid).first()
            return b.name if b else f"<{bid}>"

        assigned, split, skipped = [], [], []

        with transaction.atomic():
            for d in Department.objects.filter(branch__isnull=True).order_by("name"):
                counts = {}
                for bid in Employee.objects.filter(
                    department_id=d.id, status="active"
                ).values_list("branch_id", flat=True):
                    counts[bid] = counts.get(bid, 0) + 1
                counts.pop(None, None)

                if not counts:
                    skipped.append(d.name)
                    continue

                if len(counts) == 1:
                    bid = next(iter(counts))
                    d.branch_id = bid
                    d.save(update_fields=["branch"])
                    assigned.append((d.name, branch_name(bid), counts[bid]))
                    continue

                ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
                keep_bid, keep_n = ordered[0]
                d.branch_id = keep_bid
                d.save(update_fields=["branch"])

                for other_bid, other_n in ordered[1:]:
                    copy = Department.objects.create(
                        name=d.name, description=d.description, branch_id=other_bid,
                    )
                    moved = Employee.objects.filter(
                        department_id=d.id, branch_id=other_bid
                    ).update(department_id=copy.id)
                    split.append((d.name, branch_name(keep_bid), keep_n,
                                  branch_name(other_bid), other_n, copy.id, moved))

            out.write(ok(f"\nASSIGNED ({len(assigned)}) -single-branch departments"))
            for n, b, cnt in assigned:
                out.write(f"   {n:20} -> {b:14} ({cnt} staff)")

            out.write(ok(f"\nSPLIT ({len(split)}) -shared departments copied per branch"))
            for n, kb, kn, ob, on, cid, moved in split:
                out.write(f"   {n:20} {kb} keeps original ({kn} staff) | "
                          f"{ob} gets new id={cid} ({on} staff, {moved} repointed)")

            if skipped:
                out.write(warn(f"\nSKIPPED ({len(skipped)}) -no active staff, branch "
                               f"cannot be inferred; assign these by hand"))
                for n in skipped:
                    out.write(f"   {n}")

            remaining = Department.objects.filter(branch__isnull=True).count()
            out.write(f"\nDepartments still without a branch: {remaining}")

            out.write("\nPer-branch department counts:")
            for b in Branch.objects.all().order_by("id"):
                out.write(f"   {b.name:16} {Department.objects.filter(branch_id=b.id).count()}")

            # Invariants. If either of these is wrong the run is unsafe -
            # employees must not move between branches, and no active
            # employee should end up in another branch's department.
            per_branch = {}
            for bid in Employee.objects.values_list("branch_id", flat=True):
                per_branch[bid] = per_branch.get(bid, 0) + 1
            out.write(f"\nEmployees per branch (must be unchanged): {per_branch}")

            mismatched = Employee.objects.filter(
                department__isnull=False, status="active",
            ).exclude(department__branch_id=None).exclude(
                department__branch_id=F("branch_id")
            ).count()
            out.write(f"Active employees whose department is in a DIFFERENT branch: {mismatched}")
            if mismatched:
                out.write(warn("   ^ expected 0 -investigate before applying"))

            if not apply:
                out.write(warn("\n*** DRY RUN -rolling back. Re-run with --apply to commit. ***"))
                transaction.set_rollback(True)
            else:
                out.write(ok("\n*** COMMITTED ***"))
