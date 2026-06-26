from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0003_enterprise_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="salaryslip",
            name="week_number",
            field=models.IntegerField(blank=True, db_column="week_number", null=True),
        ),
        migrations.AlterUniqueTogether(
            name="salaryslip",
            unique_together={("employee", "month", "year", "week_number")},
        ),
    ]
