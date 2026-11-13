# Penalty Early Out (owner 2026-11-13): leaving more than N minutes (75) before the shift end takes a part of a shift (0.25)
# off the day, separately from the late pool.
#
# Additive only: five PayrollSettings columns and four AttendanceDayRecord columns, every one with a database default (or
# NULL), so a backend still running the previous release keeps inserting rows without naming them. The switch is OFF
# by default: nothing anybody sees changes until HR turns it on in Settings -> Attendance -> Staff. No data is touched.

from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0146_hr_account_categories"),
    ]

    operations = [
        migrations.AddField(
            model_name="payrollsettings",
            name="early_out_penalty_enabled",
            field=models.BooleanField(
                db_column="early_out_penalty_enabled",
                db_default=False,
                default=False,
                help_text="Staff only. Leaving more than the penalty minutes before the shift end deducts a part of the day.",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="early_out_penalty_minutes",
            field=models.IntegerField(
                db_column="early_out_penalty_minutes",
                db_default=75,
                default=75,
                help_text="Staff only. Leaving MORE than this many minutes before the shift end is a Penalty Early Out (1-720).",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="early_out_penalty_deduction",
            field=models.DecimalField(
                db_column="early_out_penalty_deduction",
                db_default=Decimal("0.25"),
                decimal_places=2,
                default=Decimal("0.25"),
                help_text="Staff only. Shift taken off the day for each Penalty Early Out (0.01-1).",
                max_digits=3,
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="early_out_penalty_from",
            field=models.CharField(
                db_column="early_out_penalty_from",
                db_default="shift_end",
                default="shift_end",
                help_text="Staff only. 'shift_end' = minutes before the shift end; 'deadline' = before shift end minus grace.",
                max_length=12,
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="early_out_penalty_in_late_pool",
            field=models.BooleanField(
                db_column="early_out_penalty_in_late_pool",
                db_default=False,
                default=False,
                help_text="Staff only. Also count a Penalty Early Out as one Early-Out mark in the late pool. Off by default.",
            ),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="penalty_early_out",
            field=models.BooleanField(db_column="penalty_early_out", db_default=False, default=False),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="penalty_deduction",
            field=models.DecimalField(
                db_column="penalty_deduction",
                db_default=Decimal("0"),
                decimal_places=2,
                default=Decimal("0"),
                max_digits=3,
            ),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="early_out_minutes",
            field=models.IntegerField(db_column="early_out_minutes", db_default=0, default=0),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="provisional_until",
            field=models.DateTimeField(blank=True, db_column="provisional_until", null=True),
        ),
    ]
