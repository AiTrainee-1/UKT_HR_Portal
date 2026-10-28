"""Endpoint Sharing: every API key carries a data category (staff | production).

One additive column. Existing keys get '' (no category = the key keeps behaving exactly as before: it sees both kinds of
data), new keys are always created with 'staff' or 'production' by the management API. db_default keeps the previous
release, which does not know the column, able to insert keys while the new one rolls out. Reversing it drops the column.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0130_whatsapp_strip_portal_link"),
    ]

    operations = [
        migrations.AddField(
            model_name="sharedendpointkey",
            name="category",
            field=models.CharField(blank=True, db_default="", default="", max_length=12),
        ),
    ]
