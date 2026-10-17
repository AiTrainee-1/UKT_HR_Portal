"""The SMS Control page's global caps default to 300 an hour / 1500 a day (they were 100 / 500).

A factory whose shift start has a few hundred employees asking for a code inside one hour would hit 100 at once, which
turns every code request into a "temporarily unavailable" answer. The per-employee cooldown and the per-number cap are
the real abuse guards, so the global caps are only a cost ceiling.

Only the Python-side defaults change: no SQL runs and no row is touched. A settings row saved before this migration keeps
the numbers it has (HR can raise them on the SMS Control page); a database where nobody ever opened the page gets the new
defaults when the row is first created.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0123_sms_otp_channel"),
    ]

    operations = [
        migrations.AlterField(
            model_name="smssettings",
            name="hourly_cap",
            field=models.PositiveIntegerField(default=300),
        ),
        migrations.AlterField(
            model_name="smssettings",
            name="daily_cap",
            field=models.PositiveIntegerField(default=1500),
        ),
    ]
