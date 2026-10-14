"""Compensation overhaul, step 1 (engine): one more day-record column, the new OT status, and the seed data.

Schema (additive only, db_default on the new non-null column so a rolling deploy cannot break):
  * AttendanceDayRecord.ot_extra_minutes - whole minutes the day's last punch was past the real shift end, measured from
    the engine's own seconds-since-this-day's-midnight punch list (a punch after midnight is correctly past a 17:30
    end; the old clock-time subtraction made it negative). 0 until a day is next computed.
  * OvertimeRecord.status gains the "auto" choice (Type 1 rows are never decided by HR). No database change.

Data (idempotent, reversible as a no-op): the CompensationConfig row (pk=1) and the default Settings rule rows, carrying
the OLD behaviour over for an installation that already used OT, with ONE deliberate exception (the default threshold):

  shift_enabled       = the old PayrollSettings.ot_detection_enabled (OT detection was the only thing that existed).
  relaxation_enabled / pay_enabled  = both True when OT detection was on (HR could pick either per batch, so both are
                        needed to keep every announce they could do), else the model defaults (relaxation on, pay off).
  shift_min_extra_minutes = 150, the owner's "more than 2 h 30" default, UNLESS OT detection was on and the old
                        PayrollSettings.ot_threshold_minutes had been customised away from its default of 60: then the
                        customised value is carried over (an installation that raised the bar to 240 minutes keeps it).
                        The comparison changed meaning: the old detector flagged a day with AT LEAST the threshold
                        minutes (>= T), the new Type 2 starts at MORE THAN the threshold (> T). A customised value T is
                        therefore carried over as T - 1, so the day with exactly T extra minutes is still detected.
  THE EXCEPTION: the old default of 60 is NOT carried over; it becomes the owner's 150. An installation that ran with the
                        default had every day with 60 or more extra minutes detected and announced as pay or a credit;
                        after this migration only days with MORE THAN 150 minutes are Type 2 candidates. The days of
                        60 to 150 minutes are what the new Type 1 allowance covers - and Type 1 is OFF until HR
                        switches it on in Settings -> Compensation - so until then those days are not detected.
  Every other feature is OFF (allowance, announced windows, holiday work, birthday) with no effective-from date: they
  are new, and switching one on in Settings stamps today's date, so nothing is ever applied to a past day.

Existing rows are never touched: a config row that exists is kept as it is, and a rule kind that already has rows is not
seeded again (so an edited table is never reset by re-running this).
"""

from django.db import migrations, models

# The owner's confirmed defaults (labels are what the Settings page shows).
ALLOWANCE_DEFAULTS = [
    # label, min_extra_minutes, allowance_minutes
    ("1 hour", 60, 30),
    ("1 hour 30 minutes", 90, 30),
    ("2 hours", 120, 60),
    ("2 hours 30 minutes", 150, 60),
]
SHIFT_DEFAULTS = [
    # label, until_minutes (minutes after the OT day's midnight; None = no limit), shifts
    ("Up to 9:00 PM", 1260, "0.25"),
    ("9:00 PM up to 12:00 AM", 1440, "0.50"),
    ("12:00 AM up to 2:00 AM", 1560, "0.75"),
    ("2:00 AM and later", None, "1.00"),
]
OLD_DEFAULT_THRESHOLD = 60
OWNER_SHIFT_MIN_EXTRA = 150


def seed_compensation(apps, schema_editor):
    Config = apps.get_model("api", "CompensationConfig")
    Rule = apps.get_model("api", "CompensationRule")
    Settings = apps.get_model("api", "PayrollSettings")

    if not Config.objects.filter(pk=1).exists():
        old = Settings.objects.filter(pk=1).first()
        ot_was_on = bool(old is not None and old.ot_detection_enabled)
        threshold = OWNER_SHIFT_MIN_EXTRA
        if ot_was_on and old.ot_threshold_minutes and old.ot_threshold_minutes != OLD_DEFAULT_THRESHOLD:
            # the old detector flagged a day with >= T extra minutes, the new Type 2 needs MORE THAN the threshold
            threshold = max(1, int(old.ot_threshold_minutes) - 1)
        fields = {"shift_enabled": ot_was_on, "shift_min_extra_minutes": threshold}
        if ot_was_on:
            fields.update({"relaxation_enabled": True, "pay_enabled": True})
        Config.objects.create(pk=1, **fields)

    if not Rule.objects.filter(kind="allowance").exists():
        for order, (label, floor, minutes) in enumerate(ALLOWANCE_DEFAULTS, start=1):
            Rule.objects.create(
                kind="allowance", label=label, enabled=True, sort_order=order,
                min_extra_minutes=floor, allowance_minutes=minutes,
            )
    if not Rule.objects.filter(kind="shift").exists():
        for order, (label, until, shifts) in enumerate(SHIFT_DEFAULTS, start=1):
            Rule.objects.create(
                kind="shift", label=label, enabled=True, sort_order=order, until_minutes=until, shifts=shifts,
            )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0118_compensation_overhaul'),
    ]

    operations = [
        migrations.AddField(
            model_name='attendancedayrecord',
            name='ot_extra_minutes',
            field=models.IntegerField(db_column='ot_extra_minutes', db_default=0, default=0),
        ),
        migrations.AlterField(
            model_name='overtimerecord',
            name='status',
            field=models.TextField(choices=[('detected', 'Detected'), ('announced', 'Announced'), ('rejected', 'Rejected'), ('auto', 'Automatic')], default='detected'),
        ),
        migrations.RunPython(seed_compensation, migrations.RunPython.noop),
    ]
