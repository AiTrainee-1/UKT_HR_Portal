# The WhatsApp sending engine (2026-11-06): a database outbox drained by one paced dispatcher (whatsapp_dispatcher.py), so
# the company's linked WhatsApp number stops getting restricted for automated, bursty sending.
#
# Additive only: every new column has a database default (or is nullable), so a backend still running the previous release
# during a rolling deploy keeps inserting log rows and reading the settings row without knowing them.
#
# One data step (owner decision, 2026-11-06): the punch reminders (four_punch_alert / on_duty_punch_reminder) are switched
# OFF on the existing settings row. They were the most repetitive messages (up to four a day per person, identical text to
# a whole shift at once). HR can still turn them back on from WhatsApp Control.

import datetime

from django.db import migrations, models
import django.db.models.deletion


def punch_reminders_off(apps, schema_editor):
    WhatsAppSettings = apps.get_model("api", "WhatsAppSettings")
    WhatsAppSettings.objects.update(four_punch_alert_enabled=False)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0142_cl_adjustment_assign"),
    ]

    operations = [
        # ── WhatsAppSettings: master switch, per-type switches, pacing, quiet hours ──
        migrations.AddField(
            model_name="whatsappsettings",
            name="engine_enabled",
            field=models.BooleanField(db_column="engine_enabled", db_default=True, default=True),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="disabled_message_types",
            field=models.JSONField(blank=True, db_column="disabled_message_types", db_default=[], default=list),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="min_gap_seconds",
            field=models.IntegerField(db_column="min_gap_seconds", db_default=30, default=30),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="max_per_hour",
            field=models.IntegerField(db_column="max_per_hour", db_default=60, default=60),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="max_per_day",
            field=models.IntegerField(db_column="max_per_day", db_default=200, default=200),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="max_per_employee_per_day",
            field=models.IntegerField(db_column="max_per_employee_per_day", db_default=3, default=3),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="quiet_hours_enabled",
            field=models.BooleanField(db_column="quiet_hours_enabled", db_default=True, default=True),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="quiet_start",
            field=models.TimeField(
                db_column="quiet_start", db_default=datetime.time(21, 0), default=datetime.time(21, 0)
            ),
        ),
        migrations.AddField(
            model_name="whatsappsettings",
            name="quiet_end",
            field=models.TimeField(db_column="quiet_end", db_default=datetime.time(7, 0), default=datetime.time(7, 0)),
        ),
        # ── WhatsAppMessageLog: the queue columns ──
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="kind",
            field=models.TextField(blank=True, db_column="kind", db_default="", default=""),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="priority",
            field=models.SmallIntegerField(db_column="priority", db_default=5, default=5),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="send_after",
            field=models.DateTimeField(blank=True, db_column="send_after", null=True),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="expires_at",
            field=models.DateTimeField(blank=True, db_column="expires_at", null=True),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="sent_at",
            field=models.DateTimeField(blank=True, db_column="sent_at", null=True),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="attempts",
            field=models.SmallIntegerField(db_column="attempts", db_default=0, default=0),
        ),
        migrations.AddField(
            model_name="whatsappmessagelog",
            name="payload",
            field=models.JSONField(blank=True, db_column="payload", db_default={}, default=dict),
        ),
        migrations.AddIndex(
            model_name="whatsappmessagelog",
            index=models.Index(fields=["status", "priority", "send_after"], name="whatsapp_log_queue_idx"),
        ),
        migrations.AddIndex(
            model_name="whatsappmessagelog",
            index=models.Index(fields=["sent_at"], name="whatsapp_log_sent_at_idx"),
        ),
        # ── employees who must not get WhatsApp notifications or documents ──
        migrations.CreateModel(
            name="WhatsAppOptOut",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("reason", models.TextField(blank=True, db_column="reason", default="")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("created_by", models.TextField(blank=True, db_column="created_by", default="")),
                (
                    "employee",
                    models.OneToOneField(
                        db_column="employee_id",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="whatsapp_opt_out",
                        to="api.employee",
                    ),
                ),
            ],
            options={
                "db_table": "whatsapp_opt_out",
            },
        ),
        # ── owner decision: punch reminders off ──
        migrations.RunPython(punch_reminders_off, migrations.RunPython.noop),
    ]
