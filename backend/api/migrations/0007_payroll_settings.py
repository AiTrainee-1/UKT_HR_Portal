from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0006_payroll_overrides"),
    ]

    operations = [
        migrations.CreateModel(
            name="PayrollSettings",
            fields=[
                ("id", models.AutoField(primary_key=True, serialize=False)),
                ("pf_rate", models.DecimalField(db_column="pf_rate", decimal_places=2, default=0, max_digits=5)),
                ("esi_rate", models.DecimalField(db_column="esi_rate", decimal_places=2, default=0, max_digits=5)),
                ("esi_applicable_below", models.DecimalField(db_column="esi_applicable_below", decimal_places=2, default=21000, max_digits=10)),
                ("pay_day", models.IntegerField(db_column="pay_day", default=5)),
                ("production_pay_type", models.TextField(db_column="production_pay_type", default="biweekly")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
            ],
            options={"db_table": "payroll_settings"},
        ),
    ]
