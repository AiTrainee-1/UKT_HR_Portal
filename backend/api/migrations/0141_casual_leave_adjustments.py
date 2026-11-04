# Casual Leave Carry Forward (2026-11-04): HR's own additions to / deductions from an employee's yearly Casual Leave
# balance. Additive only (one new table), so an older backend still running during a rolling deploy never touches it.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0140_hod_reminders'),
    ]

    operations = [
        migrations.CreateModel(
            name='CasualLeaveAdjustment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('year', models.PositiveSmallIntegerField(db_column='year')),
                ('days', models.DecimalField(db_column='days', decimal_places=1, max_digits=5)),
                ('reason', models.TextField(db_column='reason')),
                ('balance_before', models.DecimalField(db_column='balance_before', decimal_places=1, max_digits=6)),
                ('balance_after', models.DecimalField(db_column='balance_after', decimal_places=1, max_digits=6)),
                ('created_by', models.TextField(blank=True, db_column='created_by', null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_column='created_at')),
                ('employee', models.ForeignKey(db_column='employee_id', on_delete=django.db.models.deletion.CASCADE, related_name='casual_leave_adjustments', to='api.employee')),
            ],
            options={
                'db_table': 'casual_leave_adjustments',
                'ordering': ['-created_at', '-id'],
                'indexes': [models.Index(fields=['employee', 'year'], name='cl_adjust_emp_year_idx')],
            },
        ),
    ]
