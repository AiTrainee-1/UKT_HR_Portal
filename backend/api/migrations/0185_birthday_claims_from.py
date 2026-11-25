# Birthday claims from 1 November 2026 (owner 2026-11-25).
"""The birthday claim rules start on their own date: compensation_config.birthday_claims_from.

Until now a birthday before claims_from (19 Nov 2026 in production) followed the old automatic rule: a paid full day
whatever the punches, with nothing to claim. The owner wants the November 2026 birthdays to follow the claim rules too:
worked = one 1.00 credit the employee claims by hand (to the Department Head like every claim), absent / on leave = paid
birthday leave. OT, holiday work and the late-in allowance keep claims_from: nothing else moves.

Additive only: one nullable column (null = birthdays follow claims_from, exactly as before). Data step: the existing
compensation_config row gets 2026-11-01 when its claims_from is AFTER that day (production: 19 Nov), never a later date
than it had and never on a row whose claims already started by then. Reversing the data step is a no-op; reversing the
schema step drops the column.
"""

import datetime

from django.db import migrations, models

BIRTHDAY_CLAIMS_FROM = datetime.date(2026, 11, 1)


def set_birthday_claims_from(apps, schema_editor):
    CompensationConfig = apps.get_model("api", "CompensationConfig")
    CompensationConfig.objects.filter(
        birthday_claims_from__isnull=True, claims_from__gt=BIRTHDAY_CLAIMS_FROM
    ).update(birthday_claims_from=BIRTHDAY_CLAIMS_FROM)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0184_chat_media"),
    ]

    operations = [
        migrations.AddField(
            model_name="compensationconfig",
            name="birthday_claims_from",
            field=models.DateField(blank=True, db_column="birthday_claims_from", null=True),
        ),
        migrations.RunPython(set_birthday_claims_from, migrations.RunPython.noop),
    ]
