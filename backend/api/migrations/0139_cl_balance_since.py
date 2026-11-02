# Casual Leave yearly balance (2026-11-02): the day the 12-days-a-year balance started.
# Additive only (a new column with a database default), so an older backend still running during a rolling deploy keeps
# inserting / reading payroll_settings rows without knowing it.

import datetime

import api.models.payroll
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0138_mobile_pages_round'),
    ]

    operations = [
        migrations.AddField(
            model_name='payrollsettings',
            name='cl_balance_since',
            field=models.DateField(db_column='cl_balance_since', db_default=datetime.date(2026, 11, 2), default=api.models.payroll.cl_balance_default_since),
        ),
    ]
