"""Compensation claims (19 Nov 2026): one claim workflow for every kind (employee or HR raises -> the HOD approves).

Additive only:
  * holiday_work_claims becomes THE claim table: `kind` (db_default holiday_work, so every existing row and every row an
    older release inserts during a rolling deploy reads as the holiday-work claim it is), `overtime_record` (ot_* kinds),
    `minutes` (ot_allowance) and `raised_by_role` (db_default hr: every claim so far was raised by HR).
  * The open-claim constraint is now per (employee, kind, work_date) instead of (employee, work_date), plus one open claim
    per OT record. Safe on existing data: every existing row is kind holiday_work, so the old uniqueness implies the new
    one, and no row has an OT record yet. The new constraints are created before the old one is dropped.
  * compensation_ledger: one debit per claim (an approved use_balance claim), next to the one credit per claim.
  * compensation_config: `claims_from` (the effective date of the claim rules) and `ot_quarter_rule` (db_default true).
  * payroll_settings: the staff next-morning cut-off (`staff_next_morning_enabled` true, `staff_next_morning_cutoff`
    06:00, `staff_next_morning_from`).

Data step: `claims_from` and `staff_next_morning_from` are set to TODAY in India (Asia/Kolkata) on the rows that exist
(the compensation_config row, every payroll_settings row), so no day before the migration ran changes when it is
recomputed. A row created later has no date (= the new rules for every day: a fresh install has no history). Reversing
the data step is a no-op; reversing the schema steps drops the columns and restores the old constraint.
"""

import datetime

import django.db.models.deletion
from django.db import migrations, models

OPEN = models.Q(("status__in", ["pending", "approved"]))


def set_effective_dates(apps, schema_editor):
    """Today's date in India on the existing settings rows that have no effective date yet (re-running never moves one)."""
    from zoneinfo import ZoneInfo

    today = datetime.datetime.now(ZoneInfo("Asia/Kolkata")).date()
    CompensationConfig = apps.get_model("api", "CompensationConfig")
    PayrollSettings = apps.get_model("api", "PayrollSettings")
    CompensationConfig.objects.filter(claims_from__isnull=True).update(claims_from=today)
    PayrollSettings.objects.filter(staff_next_morning_from__isnull=True).update(staff_next_morning_from=today)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0165_visitor_visit_identity"),
    ]

    operations = [
        # ── the claim table: every kind ──
        migrations.AddField(
            model_name="holidayworkclaim",
            name="kind",
            field=models.TextField(
                choices=[
                    ("holiday_work", "Sunday / holiday work"),
                    ("ot_allowance", "OT late-in allowance"),
                    ("ot_shift", "OT shift credit"),
                    ("birthday", "Birthday credit"),
                    ("use_balance", "Use balance"),
                ],
                db_column="kind",
                db_default="holiday_work",
                default="holiday_work",
            ),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="overtime_record",
            field=models.ForeignKey(
                blank=True,
                db_column="overtime_record_id",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="claims",
                to="api.overtimerecord",
            ),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="minutes",
            field=models.IntegerField(blank=True, db_column="minutes", null=True),
        ),
        migrations.AddField(
            model_name="holidayworkclaim",
            name="raised_by_role",
            field=models.TextField(
                choices=[("hr", "HR"), ("employee", "Employee")],
                db_column="raised_by_role",
                db_default="hr",
                default="hr",
            ),
        ),
        migrations.AddConstraint(
            model_name="holidayworkclaim",
            constraint=models.UniqueConstraint(
                condition=OPEN,
                fields=("employee", "kind", "work_date"),
                name="uniq_open_comp_claim",
            ),
        ),
        migrations.AddConstraint(
            model_name="holidayworkclaim",
            constraint=models.UniqueConstraint(
                condition=models.Q(("overtime_record__isnull", False), ("status__in", ["pending", "approved"])),
                fields=("overtime_record",),
                name="uniq_open_comp_claim_per_ot",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="holidayworkclaim",
            name="uniq_open_holiday_work_claim",
        ),
        # ── the ledger: one debit per claim ──
        migrations.AddConstraint(
            model_name="compensationledger",
            constraint=models.UniqueConstraint(
                condition=models.Q(("claim__isnull", False), ("entry_type", "debit")),
                fields=("claim",),
                name="uniq_ledger_debit_per_claim",
            ),
        ),
        # ── settings ──
        migrations.AddField(
            model_name="compensationconfig",
            name="claims_from",
            field=models.DateField(blank=True, db_column="claims_from", null=True),
        ),
        migrations.AddField(
            model_name="compensationconfig",
            name="ot_quarter_rule",
            field=models.BooleanField(db_column="ot_quarter_rule", db_default=True, default=True),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="staff_next_morning_enabled",
            field=models.BooleanField(db_column="staff_next_morning_enabled", db_default=True, default=True),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="staff_next_morning_cutoff",
            field=models.TimeField(
                db_column="staff_next_morning_cutoff",
                db_default=datetime.time(6, 0),
                default=datetime.time(6, 0),
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="staff_next_morning_from",
            field=models.DateField(blank=True, db_column="staff_next_morning_from", null=True),
        ),
        migrations.RunPython(set_effective_dates, migrations.RunPython.noop),
    ]
