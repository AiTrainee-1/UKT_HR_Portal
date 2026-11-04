# Casual Leave Carry Forward, round 2 (2026-11-04): the log also keeps the rounds where HR turned an employee's absent dates
# into Casual Leave. Additive only (a column with a database default and a nullable one), so an older backend still running
# during a rolling deploy keeps inserting rows without knowing them.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0141_casual_leave_adjustments'),
    ]

    operations = [
        migrations.AddField(
            model_name='casualleaveadjustment',
            name='kind',
            field=models.TextField(db_column='kind', db_default='balance', default='balance'),
        ),
        migrations.AddField(
            model_name='casualleaveadjustment',
            name='dates',
            field=models.JSONField(blank=True, db_column='dates', null=True),
        ),
    ]
