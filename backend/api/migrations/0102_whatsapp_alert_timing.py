from django.db import migrations, models


def carry_over_untouched_defaults(apps, schema_editor):
    """The reminder used to go out 10 minutes AFTER a punch was due and now goes out 15 minutes BEFORE
    it; the Missing Punch wait used to run from the shift's end (30) and now runs from each expected
    punch (20). A value HR never changed (the old default) moves to the new default; a value HR chose
    is kept, since it is theirs."""
    WhatsAppSettings = apps.get_model("api", "WhatsAppSettings")
    WhatsAppSettings.objects.filter(four_punch_lead_minutes=10).update(four_punch_lead_minutes=15)
    WhatsAppSettings.objects.filter(missing_punch_after_minutes=30).update(missing_punch_after_minutes=20)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0101_mobile_app_versions"),
    ]

    operations = [
        migrations.RenameField(
            model_name="whatsappsettings",
            old_name="four_punch_wait_minutes",
            new_name="four_punch_lead_minutes",
        ),
        migrations.AlterField(
            model_name="whatsappsettings",
            name="four_punch_lead_minutes",
            field=models.IntegerField(db_column="four_punch_lead_minutes", default=15),
        ),
        migrations.AlterField(
            model_name="whatsappsettings",
            name="missing_punch_after_minutes",
            field=models.IntegerField(db_column="missing_punch_after_minutes", default=20),
        ),
        migrations.RunPython(carry_over_untouched_defaults, migrations.RunPython.noop),
    ]
