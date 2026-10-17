"""SMS one-time codes through 2Factor: the settings row (SmsSettings) and the send log (SmsMessageLog).

Two new tables, nothing existing is touched (additive: the previous release keeps working against this schema).
No data is seeded: the settings row is created on first use with the defaults (channel 'whatsapp'), so every existing
installation keeps delivering codes by WhatsApp until HR picks SMS on the SMS Control page.
"""

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0122_shared_endpoints"),
    ]

    operations = [
        migrations.CreateModel(
            name="SmsSettings",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "otp_channel",
                    models.CharField(choices=[("whatsapp", "WhatsApp"), ("sms", "SMS")], default="whatsapp", max_length=10),
                ),
                ("otp_login_enabled", models.BooleanField(default=True)),
                ("otp_reset_enabled", models.BooleanField(default=True)),
                ("otp_activate_enabled", models.BooleanField(default=True)),
                ("otp_expiry_minutes", models.PositiveSmallIntegerField(default=5)),
                ("resend_cooldown_seconds", models.PositiveSmallIntegerField(default=60)),
                ("max_requests_per_hour", models.PositiveSmallIntegerField(default=5)),
                ("max_attempts_per_code", models.PositiveSmallIntegerField(default=5)),
                ("max_per_phone_per_hour", models.PositiveSmallIntegerField(default=5)),
                ("hourly_cap", models.PositiveIntegerField(default=100)),
                ("daily_cap", models.PositiveIntegerField(default=500)),
                ("updated_at", models.DateTimeField(blank=True, null=True)),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.hruser",
                    ),
                ),
            ],
            options={
                "db_table": "sms_settings",
            },
        ),
        migrations.CreateModel(
            name="SmsMessageLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("phone_masked", models.CharField(blank=True, default="", max_length=40)),
                ("phone_hash", models.CharField(blank=True, default="", max_length=64)),
                (
                    "purpose",
                    models.CharField(
                        choices=[
                            ("login", "Login"),
                            ("reset", "Password reset"),
                            ("activate", "Account activation"),
                            ("test", "Test"),
                        ],
                        max_length=10,
                    ),
                ),
                ("provider", models.CharField(default="twofactor", max_length=20)),
                (
                    "status",
                    models.CharField(
                        choices=[("sent", "Sent"), ("failed", "Failed"), ("blocked", "Blocked")], max_length=10
                    ),
                ),
                ("provider_message_id", models.CharField(blank=True, default="", max_length=100)),
                ("error", models.CharField(blank=True, default="", max_length=300)),
                ("error_code", models.CharField(blank=True, default="", max_length=20)),
                ("requested_ip", models.CharField(blank=True, default="", max_length=64)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                (
                    "employee",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="sms_messages",
                        to="api.employee",
                    ),
                ),
                (
                    "sent_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.hruser",
                    ),
                ),
            ],
            options={
                "db_table": "sms_message_log",
                "ordering": ["-created_at", "-id"],
                "indexes": [
                    models.Index(fields=["status", "created_at"], name="sms_log_status_at"),
                    models.Index(fields=["phone_hash", "created_at"], name="sms_log_phone_at"),
                    models.Index(fields=["created_at"], name="sms_log_at"),
                ],
            },
        ),
    ]
