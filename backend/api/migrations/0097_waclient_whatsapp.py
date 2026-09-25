from django.db import migrations, models


def enable_existing_rows(apps, schema_editor):
    # Under Gupshup a document type stayed switched off until a template ID was
    # saved, so existing rows are mostly "disabled" only because that never
    # happened. Sending now works out of the box with built-in wording, so start
    # every existing row enabled; HR can switch a type off again in Settings.
    apps.get_model("api", "WhatsAppMessageTemplate").objects.update(is_enabled=True)


class Migration(migrations.Migration):
    """Gupshup -> WAClient. Templates no longer exist (free-text wording
    instead), and the message log's provider id column is provider-neutral."""

    dependencies = [
        ("api", "0096_gupshup_whatsapp"),
    ]

    operations = [
        migrations.RenameField(
            model_name="whatsappmessagelog",
            old_name="gupshup_message_id",
            new_name="provider_message_id",
        ),
        migrations.AlterField(
            model_name="whatsappmessagelog",
            name="provider_message_id",
            field=models.TextField(blank=True, db_column="provider_message_id", default=""),
        ),
        migrations.RemoveField(model_name="whatsappmessagetemplate", name="gupshup_template_id"),
        migrations.RemoveField(model_name="whatsappmessagetemplate", name="variable_note"),
        migrations.AddField(
            model_name="whatsappmessagetemplate",
            name="message_body",
            field=models.TextField(blank=True, db_column="message_body", default=""),
        ),
        migrations.AlterField(
            model_name="whatsappmessagetemplate",
            name="is_enabled",
            field=models.BooleanField(db_column="is_enabled", default=True),
        ),
        migrations.RunPython(enable_existing_rows, migrations.RunPython.noop),
    ]
