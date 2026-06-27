from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0007_payroll_settings"),
    ]

    operations = [
        migrations.AddField(
            model_name="payrollsettings",
            name="prod_pf_rate",
            field=models.DecimalField(db_column="prod_pf_rate", decimal_places=2, default=0, max_digits=5),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="prod_esi_rate",
            field=models.DecimalField(db_column="prod_esi_rate", decimal_places=2, default=0, max_digits=5),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="prod_esi_applicable_below",
            field=models.DecimalField(db_column="prod_esi_applicable_below", decimal_places=2, default=21000, max_digits=10),
        ),
    ]
