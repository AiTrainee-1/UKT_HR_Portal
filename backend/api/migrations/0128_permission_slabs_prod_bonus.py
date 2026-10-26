# Schema for the Settings split (2026-10-24): the separate PRODUCTION Bonus and the Permission Deduction Slabs.
# Additive only, and every column has a database default, so an older backend instance that is still running during a
# rolling deploy (or after a rollback) keeps inserting payroll_settings rows without knowing these columns exist.

from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0127_pf_esi_rules_data'),
    ]

    operations = [
        migrations.AddField(
            model_name='payrollsettings',
            name='permission_deduction_slabs',
            field=models.JSONField(blank=True, db_column='permission_deduction_slabs', db_default=[], default=list, help_text='Staff only. Rows {fromPermissions, deductionShifts}: once the billable excess permissions reach fromPermissions, deductionShifts shifts are cut. Highest matching row wins; the last row holds beyond it; empty = no deduction.'),
        ),
        migrations.AddField(
            model_name='payrollsettings',
            name='permission_free_allowance',
            field=models.IntegerField(db_column='permission_free_allowance', db_default=0, default=0, help_text='Staff only. Excess permissions per month that cost nothing before the permission slabs start (0-999).'),
        ),
        migrations.AddField(
            model_name='payrollsettings',
            name='permission_pricing_enabled',
            field=models.BooleanField(db_column='permission_pricing_enabled', db_default=False, default=False, help_text='Staff only. Off: excess permissions are marks in the late pool. On: they are priced by their own slabs.'),
        ),
        migrations.AddField(
            model_name='payrollsettings',
            name='prod_bonus_eligibility_ceiling',
            field=models.DecimalField(db_column='prod_bonus_eligibility_ceiling', db_default=21000, decimal_places=2, default=21000, help_text='Production only. Employees earning at or below this monthly wage are bonus-eligible.', max_digits=10),
        ),
        migrations.AddField(
            model_name='payrollsettings',
            name='prod_bonus_percent',
            field=models.DecimalField(db_column='prod_bonus_percent', db_default=Decimal('8.33'), decimal_places=2, default=Decimal('8.33'), help_text='Production only. Statutory bonus % applied to eligible wages (Act range: 8.33 min, 20 max).', max_digits=5),
        ),
        migrations.AddField(
            model_name='payrollsettings',
            name='prod_bonus_wage_ceiling',
            field=models.DecimalField(db_column='prod_bonus_wage_ceiling', db_default=7000, decimal_places=2, default=7000, help_text='Production only. Monthly wage ceiling used in the bonus calculation base -min(basic, this) per record.', max_digits=10),
        ),
    ]
