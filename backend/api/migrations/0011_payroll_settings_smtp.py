from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("api", "0010_employee_family_payroll_slip_settings")]

    operations = [
        migrations.AddField(model_name="payrollsettings", name="smtp_host",       field=models.TextField(default="smtp.gmail.com", db_column="smtp_host")),
        migrations.AddField(model_name="payrollsettings", name="smtp_port",       field=models.IntegerField(default=587, db_column="smtp_port")),
        migrations.AddField(model_name="payrollsettings", name="smtp_username",   field=models.TextField(blank=True, default="", db_column="smtp_username")),
        migrations.AddField(model_name="payrollsettings", name="smtp_password",   field=models.TextField(blank=True, default="", db_column="smtp_password")),
        migrations.AddField(model_name="payrollsettings", name="smtp_from_email", field=models.TextField(blank=True, default="", db_column="smtp_from_email")),
        migrations.AddField(model_name="payrollsettings", name="smtp_from_name",  field=models.TextField(default="UKTextiles HR", db_column="smtp_from_name")),
    ]
