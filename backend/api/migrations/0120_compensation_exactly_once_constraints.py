"""Compensation overhaul, review fixes: the database itself refuses the duplicates the application locks are meant to prevent.

Additive only (three partial unique indexes, no column added, nothing renamed or dropped):

  * holiday_work_claims: one PENDING-or-APPROVED claim per (employee, work_date); a rejected claim can be raised again.
  * compensation_ledger: an approved claim is credited exactly once (one credit per claim), and an OT record announced to
    the balance is credited exactly once (one `ot_shift` entry per overtime record).

Safe on existing rows: both tables were created by 0118 in this same release and are written only by the compensation
code, whose row locks already keep these invariants, so a database that ever applied 0118 holds no violation. To be certain,
the first operation counts violating rows and, if there are any, stops with a message naming them BEFORE any index is
built (Postgres DDL is transactional, so nothing is left half-applied). It never deletes or changes a row: if it ever
stops, decide by hand which duplicate to keep, then migrate again.
"""

from django.db import migrations, models
from django.db.models import Count, Q


def refuse_if_duplicates(apps, schema_editor):
    Claim = apps.get_model("api", "HolidayWorkClaim")
    Ledger = apps.get_model("api", "CompensationLedger")
    problems = []
    open_claims = (
        Claim.objects.filter(status__in=["pending", "approved"])
        .values("employee_id", "work_date")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
    )
    for row in open_claims[:10]:
        problems.append(f"employee {row['employee_id']} has {row['n']} open holiday-work claims for {row['work_date']}")
    credits = (
        Ledger.objects.filter(entry_type="credit", claim__isnull=False)
        .values("claim_id")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
    )
    for row in credits[:10]:
        problems.append(f"holiday-work claim {row['claim_id']} has {row['n']} ledger credits")
    ot_credits = (
        Ledger.objects.filter(source="ot_shift", overtime_record__isnull=False)
        .values("overtime_record_id")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
    )
    for row in ot_credits[:10]:
        problems.append(f"overtime record {row['overtime_record_id']} has {row['n']} ledger credits")
    if problems:
        raise RuntimeError(
            "Migration 0120 was not applied because existing compensation rows would break its unique rules: "
            + "; ".join(problems)
            + ". Nothing was changed: remove the duplicates you do not want to keep, then migrate again."
        )


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0119_compensation_engine"),
    ]

    operations = [
        migrations.RunPython(refuse_if_duplicates, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="holidayworkclaim",
            constraint=models.UniqueConstraint(
                condition=Q(("status__in", ["pending", "approved"])),
                fields=("employee", "work_date"),
                name="uniq_open_holiday_work_claim",
            ),
        ),
        migrations.AddConstraint(
            model_name="compensationledger",
            constraint=models.UniqueConstraint(
                condition=Q(("claim__isnull", False), ("entry_type", "credit")),
                fields=("claim",),
                name="uniq_ledger_credit_per_claim",
            ),
        ),
        migrations.AddConstraint(
            model_name="compensationledger",
            constraint=models.UniqueConstraint(
                condition=Q(("overtime_record__isnull", False), ("source", "ot_shift")),
                fields=("overtime_record",),
                name="uniq_ledger_ot_credit_per_record",
            ),
        ),
    ]
