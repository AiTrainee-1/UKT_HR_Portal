"""Production shift rules: the owner's shift table, breaks and grace as editable data (2026-10-14).

ADDITIVE ONLY: eight new columns on production_shift_config (every one with a database default, so a backend instance
of the previous release that is still running during a rolling deploy can keep inserting rows) and three new tables.
Nothing is renamed, dropped or rewritten, and no AttendanceDayRecord / payroll / salary-slip row is touched.

The legacy calculation (the punch1..4 times, the 10-minute grace and the production_shift_segments) is left exactly as
it is: every day BEFORE `rules_effective_from` keeps being judged by it, so nothing already paid is re-judged. The seed
below sets `rules_effective_from` to the day this migration runs (IST today); HR can move it in Settings.

The seed is idempotent: groups are only created when there are none, breaks only when there are none, and an
already-chosen effective date is never overwritten. Reverse = nothing to undo for the data (the tables are dropped by
the schema reversal, the config columns with them).
"""

from datetime import datetime, time
from zoneinfo import ZoneInfo

import django.db.models.deletion
from decimal import Decimal
from django.db import migrations, models

# label, out time, next day, shift value
DAY_RULES = [
    ("Leaves at morning tea", time(10, 30), False, "0.25"),
    ("Leaves at lunch", time(12, 45), False, "0.50"),
    ("Leaves at afternoon tea", time(15, 30), False, "0.75"),
    ("One full shift (evening tea)", time(17, 45), False, "1.00"),
    ("Main departure (1 shift + 0.5 OT)", time(20, 0), False, "1.50"),
    ("Works until 22:30 (1 shift + 1 OT)", time(22, 30), False, "2.00"),
    ("Works until 00:30 (1 shift + 1.5 OT)", time(0, 30), True, "2.50"),
    ("Works until 05:30 (1 shift + 2 OT)", time(5, 30), True, "3.00"),
]
NIGHT_RULES = [
    ("Leaves at midnight", time(0, 0), True, "0.50"),
    ("Full night shift", time(5, 30), True, "1.50"),
]
SUNDAY_RULES = [
    ("Sunday shift", time(17, 0), False, "1.00"),
]
BREAKS = [
    ("Morning tea", time(10, 30), time(10, 45)),
    ("Lunch", time(12, 45), time(13, 30)),
    ("Afternoon tea", time(15, 30), time(15, 45)),
    ("Evening tea", time(17, 45), time(18, 0)),
    ("Night dinner", time(20, 0), time(21, 0)),
]


def seed(apps, schema_editor):
    Config = apps.get_model("api", "ProductionShiftConfig")
    Group = apps.get_model("api", "ProductionShiftGroup")
    Rule = apps.get_model("api", "ProductionShiftRule")
    Break = apps.get_model("api", "ProductionBreak")

    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    config = Config.objects.filter(pk=1).first()
    if config is None:
        Config.objects.create(pk=1, rules_effective_from=today)
    elif config.rules_effective_from is None:
        Config.objects.filter(pk=1).update(rules_effective_from=today)

    if not Group.objects.exists():
        groups = [
            ("Day shift", "day", "mon_sat", time(8, 30), time(4, 0), time(16, 59, 59), time(20, 0), False, DAY_RULES),
            ("Night shift", "night", "all", time(21, 0), time(17, 0), time(23, 59, 59), time(5, 30), True, NIGHT_RULES),
            ("Sunday shift", "sunday", "sunday", time(8, 30), time(4, 0), time(16, 59, 59), time(17, 0), False, SUNDAY_RULES),
        ]
        for order, (label, kind, applies_on, start, f_from, f_to, main_out, next_day, rules) in enumerate(groups, start=1):
            group = Group.objects.create(
                label=label, kind=kind, applies_on=applies_on, start_time=start,
                first_punch_from=f_from, first_punch_to=f_to,
                main_out_time=main_out, main_out_next_day=next_day, enabled=True, order=order,
            )
            for rule_order, (rule_label, out, out_next, value) in enumerate(rules, start=1):
                Rule.objects.create(
                    group=group, label=rule_label, out_time=out, out_next_day=out_next,
                    shift_value=Decimal(value), enabled=True, order=rule_order,
                )

    if not Break.objects.exists():
        for order, (label, start, end) in enumerate(BREAKS, start=1):
            Break.objects.create(label=label, start_time=start, end_time=end, enabled=True, order=order)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0120_compensation_exactly_once_constraints'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductionBreak',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('label', models.TextField(blank=True, default='')),
                ('start_time', models.TimeField(db_column='start_time')),
                ('end_time', models.TimeField(db_column='end_time')),
                ('enabled', models.BooleanField(default=True)),
                ('order', models.IntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_column='created_at')),
                ('updated_at', models.DateTimeField(auto_now=True, db_column='updated_at')),
            ],
            options={
                'db_table': 'production_breaks',
                'ordering': ['order', 'id'],
            },
        ),
        migrations.CreateModel(
            name='ProductionShiftGroup',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('label', models.TextField()),
                ('kind', models.TextField(choices=[('day', 'Day'), ('night', 'Night'), ('sunday', 'Sunday'), ('custom', 'Custom')], default='custom')),
                ('applies_on', models.TextField(choices=[('mon_sat', 'Monday to Saturday'), ('sunday', 'Sunday'), ('all', 'Every day')], db_column='applies_on', default='mon_sat')),
                ('start_time', models.TimeField(db_column='start_time')),
                ('first_punch_from', models.TimeField(db_column='first_punch_from')),
                ('first_punch_to', models.TimeField(db_column='first_punch_to')),
                ('main_out_time', models.TimeField(blank=True, db_column='main_out_time', null=True)),
                ('main_out_next_day', models.BooleanField(db_column='main_out_next_day', default=False)),
                ('enabled', models.BooleanField(default=True)),
                ('order', models.IntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_column='created_at')),
                ('updated_at', models.DateTimeField(auto_now=True, db_column='updated_at')),
            ],
            options={
                'db_table': 'production_shift_groups',
                'ordering': ['order', 'id'],
            },
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_effective_from',
            field=models.DateField(blank=True, db_column='rules_effective_from', null=True),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_enabled',
            field=models.BooleanField(db_column='rules_enabled', db_default=True, default=True),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_full_day_value',
            field=models.DecimalField(db_column='rules_full_day_value', db_default=Decimal('1.00'), decimal_places=2, default=Decimal('1.00'), max_digits=4),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_grace_minutes',
            field=models.IntegerField(db_column='rules_grace_minutes', db_default=5, default=5),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_min_credit',
            field=models.DecimalField(db_column='rules_min_credit', db_default=Decimal('0.00'), decimal_places=2, default=Decimal('0.00'), max_digits=4),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_night_session_hours',
            field=models.IntegerField(db_column='rules_night_session_hours', db_default=18, default=18),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_rounding_mode',
            field=models.TextField(db_column='rules_rounding_mode', db_default='nearest', default='nearest'),
        ),
        migrations.AddField(
            model_name='productionshiftconfig',
            name='rules_rounding_step',
            field=models.DecimalField(db_column='rules_rounding_step', db_default=Decimal('0.01'), decimal_places=2, default=Decimal('0.01'), max_digits=4),
        ),
        migrations.CreateModel(
            name='ProductionShiftRule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('label', models.TextField(blank=True, default='')),
                ('out_time', models.TimeField(db_column='out_time')),
                ('out_next_day', models.BooleanField(db_column='out_next_day', default=False)),
                ('shift_value', models.DecimalField(db_column='shift_value', decimal_places=2, max_digits=4)),
                ('enabled', models.BooleanField(default=True)),
                ('order', models.IntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_column='created_at')),
                ('updated_at', models.DateTimeField(auto_now=True, db_column='updated_at')),
                ('group', models.ForeignKey(db_column='group_id', on_delete=django.db.models.deletion.CASCADE, related_name='rules', to='api.productionshiftgroup')),
            ],
            options={
                'db_table': 'production_shift_rules',
                'ordering': ['order', 'id'],
            },
        ),
        migrations.RunPython(seed, noop),
    ]
