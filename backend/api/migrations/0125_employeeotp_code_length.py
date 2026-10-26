"""EmployeeOtp.code_length: how many digits the code was issued with (4 for SMS, 6 for WhatsApp).

Additive: one new column with a DATABASE default of 6 (db_default: Django would otherwise drop it after adding the column), so every existing row (all of them WhatsApp codes of 6
digits, long expired or consumed) reads 6 and a running older server that does not know the column keeps working
(the database fills it on insert).
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0124_sms_default_caps"),
    ]

    operations = [
        migrations.AddField(
            model_name="employeeotp",
            name="code_length",
            field=models.SmallIntegerField(db_column="code_length", db_default=6, default=6),
        ),
    ]
