from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0008_payroll_settings_production"),
    ]

    operations = [
        migrations.AddField(
            model_name="advancerepayment",
            name="payment_method",
            field=models.TextField(
                choices=[("cash", "Hand Cash"), ("gpay", "GPay")],
                db_column="payment_method",
                default="cash",
            ),
        ),
    ]
