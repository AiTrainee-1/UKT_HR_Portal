"""Late Detection / Permission / Half-Day rewrite -ADDITIVE ("expand") half only.

Why this migration never drops, renames or rewrites anything that already exists
---------------------------------------------------------------------------------
Railway deploys the code and the schema separately, and for a while the OLD backend, the NEW
backend and the already-installed employee apps all run against the same database (a rolling
deploy, or a rollback after a bad release). A column rename or drop in the same release as the
code that stops using it makes one of those generations crash the moment it touches the table
-exactly what happened on 2026-09-26 with migration 0102. So this release only:

  * ADDS the new columns, each with a database-level default (`db_default`), so an old backend
    instance that has never heard of them can still INSERT rows;
  * takes the retired fields OUT OF DJANGO'S MODEL STATE but leaves their columns physically in
    place (SeparateDatabaseAndState), and gives every retired NOT NULL column a database-level
    default so the new code -which no longer supplies a value for them- can still INSERT;
  * changes only metadata (choices / defaults / help_text) on the columns it keeps;
  * relabels no data: EmployeePermission.type keeps whatever spelling each row was saved with
    ("Late In" ... or "morning_late_in" ...) and every reader normalizes it (see
    EmployeePermission.normalize_type).

The retired columns are physically dropped by a later "contract" migration, only once every
backend instance and every installed client has moved off them.

Environments where an earlier draft of this migration already ran (a developer database): the
draft had physically dropped/renamed the same columns. That is harmless -the model state here is
identical either way, the retired columns simply are not there to take a default, which the
guarded SQL below skips.
"""

import datetime

from django.db import migrations, models

# (table, column, SQL literal used as the database-level default)
_LEGACY_PAYROLL_SETTINGS = [
    ("payroll_settings", "shift_punctuality_window_minutes", "60"),
    ("payroll_settings", "permission_window_minutes", "60"),
    ("payroll_settings", "max_permissions_per_day", "1"),
    ("payroll_settings", "max_permissions_per_week", "2"),
    ("payroll_settings", "half_shift_late_reference_time", "'14:30'"),
    ("payroll_settings", "without_permission_free_allowance", "0"),
    ("payroll_settings", "without_permission_deduction_slabs", "'[]'::jsonb"),
    ("payroll_settings", "afternoon_late_can_cause_half_shift", "true"),
]
_LEGACY_DAY_RECORD = [
    ("attendance_day_records", "late_in_without_permission", "false"),
    ("attendance_day_records", "early_out_without_permission", "false"),
    ("attendance_day_records", "permission_morning", "false"),
    ("attendance_day_records", "permission_morning_with_request", "false"),
    ("attendance_day_records", "permission_departure", "false"),
    ("attendance_day_records", "permission_departure_with_request", "false"),
    ("attendance_day_records", "permission_zone_count", "0"),
    ("attendance_day_records", "permission_escalated_to_half_shift", "false"),
]


def _guarded(table, column, action):
    """ALTER COLUMN statement that is a no-op when the column does not exist in this database."""
    return (
        "DO $$ BEGIN "
        "IF EXISTS (SELECT 1 FROM information_schema.columns "
        f"WHERE table_schema = current_schema() AND table_name = '{table}' AND column_name = '{column}') THEN "
        f'ALTER TABLE "{table}" ALTER COLUMN "{column}" {action}; '
        "END IF; END $$;"
    )


def _keep_columns_with_default(columns):
    return migrations.RunSQL(
        sql=[_guarded(t, c, f"SET DEFAULT {lit}") for t, c, lit in columns],
        reverse_sql=[_guarded(t, c, "DROP DEFAULT") for t, c, _ in columns],
    )


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0102_whatsapp_alert_timing"),
    ]

    operations = [
        # ── PayrollSettings: new Late Detection / Half-Day Detection / Permission policy columns ──
        migrations.AddField(
            model_name="payrollsettings",
            name="morning_late_in_enabled",
            field=models.BooleanField(
                default=True,
                db_default=True,
                db_column="morning_late_in_enabled",
                help_text="Staff only. Flag a punch after (shift start + grace) as Morning Late-In.",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="evening_early_out_enabled",
            field=models.BooleanField(
                default=False,
                db_default=False,
                db_column="evening_early_out_enabled",
                help_text="Staff only. Flag a punch before (shift end - grace) as Evening Early-Out. Off by default.",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="half_day_first_half_end_time",
            field=models.TimeField(
                default="13:30",
                db_default=datetime.time(13, 30),
                db_column="half_day_first_half_end_time",
                help_text="Staff only. A punch before this time counts as the Morning Half attended.",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="half_day_second_half_start_time",
            field=models.TimeField(
                default="14:30",
                db_default=datetime.time(14, 30),
                db_column="half_day_second_half_start_time",
                help_text="Staff only. A punch at or after this time counts as the Evening Half attended.",
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="permission_monthly_cap",
            field=models.IntegerField(
                default=3,
                db_default=3,
                db_column="permission_monthly_cap",
                help_text="Staff only. Approved permissions per employee per calendar month that actually protect that day.",
            ),
        ),
        # Metadata only (help_text) -no SQL is emitted for these.
        migrations.AlterField(
            model_name="payrollsettings",
            name="late_free_allowance",
            field=models.IntegerField(
                default=3,
                db_column="late_free_allowance",
                help_text=(
                    "Free lates/early-outs/excess-permissions allowed per employee "
                    "per month before any shift deduction applies. All three draw "
                    "on this same shared pool."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="payrollsettings",
            name="afternoon_late_window_minutes",
            field=models.IntegerField(
                default=60,
                db_column="afternoon_late_window_minutes",
                help_text=(
                    "Strict mode only. Minutes past the lunch-return deadline "
                    "(punch2 + lunch_duration_minutes) during which a late return "
                    "is flagged Night Late. Informational only -see Half-Day "
                    "Detection above for what actually decides shift value."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="payrollsettings",
            name="afternoon_permission_window_minutes",
            field=models.IntegerField(
                default=60,
                db_column="afternoon_permission_window_minutes",
                help_text=(
                    "Strict mode only. Extra minutes past afternoon_late_window_"
                    "minutes during which a late lunch return is still just flagged "
                    "Night Late (kept for the deadline math; no longer changes "
                    "shift value at any point)."
                ),
            ),
        ),
        # Superseded by the fixed Half-Day rule / single permission_monthly_cap above. Out of the
        # model state now; the columns stay (with a database default) until the contract migration.
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name="payrollsettings", name=name)
                for name in (
                    "shift_punctuality_window_minutes",
                    "permission_window_minutes",
                    "max_permissions_per_day",
                    "max_permissions_per_week",
                    "half_shift_late_reference_time",
                    "without_permission_free_allowance",
                    "without_permission_deduction_slabs",
                    "afternoon_late_can_cause_half_shift",
                )
            ],
            database_operations=[_keep_columns_with_default(_LEGACY_PAYROLL_SETTINGS)],
        ),
        # ── EmployeePermission: 3 canonical types, fixed 60-minute duration (metadata only) ──
        migrations.AlterField(
            model_name="employeepermission",
            name="type",
            field=models.TextField(
                choices=[
                    ("morning_late_in", "Morning Late-In"),
                    ("evening_early_out", "Evening Early-Out"),
                    ("middle_permission", "Middle One-Hour Permission"),
                ],
                null=True,
                blank=True,
                db_column="type",
            ),
        ),
        migrations.AlterField(
            model_name="employeepermission",
            name="duration_minutes",
            field=models.IntegerField(
                choices=[(30, "30 minutes"), (45, "45 minutes"), (60, "60 minutes"), (90, "90 minutes")],
                null=True,
                blank=True,
                default=60,
                db_column="duration_minutes",
            ),
        ),
        # ── AttendanceDayRecord: new Late Detection / Permission columns ──
        migrations.AddField(
            model_name="attendancedayrecord",
            name="morning_permission_applied",
            field=models.BooleanField(default=False, db_default=False, db_column="morning_permission_applied"),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="evening_permission_applied",
            field=models.BooleanField(default=False, db_default=False, db_column="evening_permission_applied"),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="morning_permission_excess",
            field=models.BooleanField(default=False, db_default=False, db_column="morning_permission_excess"),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="evening_permission_excess",
            field=models.BooleanField(default=False, db_default=False, db_column="evening_permission_excess"),
        ),
        migrations.AddField(
            model_name="attendancedayrecord",
            name="middle_permission_today",
            field=models.BooleanField(default=False, db_default=False, db_column="middle_permission_today"),
        ),
        # The old auto-detected-zone / without-permission / daily+weekly-cap flags are retired.
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name="attendancedayrecord", name=name)
                for name in (
                    "late_in_without_permission",
                    "early_out_without_permission",
                    "permission_morning",
                    "permission_morning_with_request",
                    "permission_departure",
                    "permission_departure_with_request",
                    "permission_zone_count",
                    "permission_escalated_to_half_shift",
                )
            ],
            database_operations=[_keep_columns_with_default(_LEGACY_DAY_RECORD)],
        ),
    ]
