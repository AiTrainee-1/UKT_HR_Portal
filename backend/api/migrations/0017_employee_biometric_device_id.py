from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0016_advance_repayment_months_is_processed"),
    ]

    operations = [
        migrations.AddField(
            model_name="employee",
            name="biometric_device_id",
            field=models.TextField(blank=True, db_column="biometric_device_id", null=True),
        ),
    ]
