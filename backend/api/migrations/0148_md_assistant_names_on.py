# The MD's AI assistant answers by employee name and code (owner 2026-11-13: "remove the employee name restrictions").
#
# Privacy mode (names replaced by tokens before a question goes to Gemini, and employee codes left out) is switched OFF:
# the column default becomes False and the one settings row is set to False. Phone numbers, e-mail, addresses, dates of
# birth, bank and government ids are still never sent (md_portal/assistant/privacy.py PII_KEYS). A Super Admin can turn
# privacy mode back on in Account Management -> MD profile. Additive: a backend still running the previous release reads
# and writes the same column.

from django.db import migrations, models


def names_on(apps, schema_editor):
    apps.get_model("api", "MdAssistantSettings").objects.filter(pk=1).update(privacy_mode=False)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0147_penalty_early_out"),
    ]

    operations = [
        migrations.AlterField(
            model_name="mdassistantsettings",
            name="privacy_mode",
            field=models.BooleanField(db_column="privacy_mode", db_default=False, default=False),
        ),
        migrations.RunPython(names_on, migrations.RunPython.noop),
    ]
