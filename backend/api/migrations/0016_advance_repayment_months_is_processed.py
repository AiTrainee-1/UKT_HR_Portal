from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0015_resignation_3stage_workflow"),
    ]

    operations = [
        migrations.AddField(
            model_name="advance",
            name="repayment_months",
            field=models.IntegerField(blank=True, db_column="repayment_months", null=True),
        ),
        migrations.AddField(
            model_name="advancerepayment",
            name="is_processed",
            field=models.BooleanField(default=False, db_column="is_processed"),
        ),
    ]
