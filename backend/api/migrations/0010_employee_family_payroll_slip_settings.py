from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0009_advance_repayment_payment_method"),
    ]

    operations = [
        # Employee — family fields
        migrations.AddField(
            model_name="employee",
            name="father_name",
            field=models.TextField(null=True, blank=True, db_column="father_name"),
        ),
        migrations.AddField(
            model_name="employee",
            name="mother_name",
            field=models.TextField(null=True, blank=True, db_column="mother_name"),
        ),
        # PayrollSettings — slip header + signature
        migrations.AddField(
            model_name="payrollsettings",
            name="slip_company_name",
            field=models.TextField(default="UK TEXTILES - H.O", db_column="slip_company_name"),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="slip_company_address",
            field=models.TextField(default="TIRUPUR", db_column="slip_company_address"),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="min_wage_rate",
            field=models.DecimalField(
                max_digits=10, decimal_places=2, default=0, db_column="min_wage_rate"
            ),
        ),
        migrations.AddField(
            model_name="payrollsettings",
            name="signature_image",
            field=models.TextField(null=True, blank=True, db_column="signature_image"),
        ),
    ]
