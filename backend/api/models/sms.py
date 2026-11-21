"""SMS one-time codes (2Factor): the settings row and the send log.

Two tables (both new, nothing existing is touched):
  SmsSettings    singleton (pk=1): SMS codes on or off (`otp_enabled`, independent of WhatsApp codes since 2026-11-20),
                 what they may be used for, every SMS limit, and the price / budget of the cost estimate
  SmsMessageLog  one row per SMS attempt (sent, failed, or blocked by a cap / the circuit breaker). It NEVER holds the
                 code, the text, the API key or a full phone number: only the masked number and an HMAC of the number
                 (so the per-number limit can count by number across workers).

The behaviour lives in api/sms_service.py (the send pipeline), api/twofactor_client.py (the HTTP
call), api/otp_service.py (which channels are available for each purpose) and api/sms_control_views.py (the HR
page's API). SMS carries one-time codes only.
"""

from django.db import models
from django.utils import timezone

from .accounts import HRUser
from .core import Employee


class SmsSettings(models.Model):
    """The SMS Control page's settings. `otp_enabled` is the SMS codes master switch and the three OTP switches say what
    SMS codes may be used for; WhatsApp codes have their own switches (WhatsAppSettings), and either channel alone is
    enough. `otp_channel` is DEPRECATED (2026-11-20, migration 0169 copied it into `otp_enabled`): never read, kept only
    so no migration drops a column."""

    CHANNEL_WHATSAPP = "whatsapp"
    CHANNEL_SMS = "sms"
    CHANNELS = ((CHANNEL_WHATSAPP, "WhatsApp"), (CHANNEL_SMS, "SMS"))

    otp_channel = models.CharField(max_length=10, choices=CHANNELS, default=CHANNEL_WHATSAPP)
    otp_login_enabled = models.BooleanField(default=True)
    otp_reset_enabled = models.BooleanField(default=True)
    otp_activate_enabled = models.BooleanField(default=True)
    otp_expiry_minutes = models.PositiveSmallIntegerField(default=5)
    resend_cooldown_seconds = models.PositiveSmallIntegerField(default=60)
    #: codes one employee may ask for per hour
    max_requests_per_hour = models.PositiveSmallIntegerField(default=5)
    max_attempts_per_code = models.PositiveSmallIntegerField(default=5)
    #: SMS one mobile NUMBER may receive per hour (two employee records sharing a number cannot multiply it)
    max_per_phone_per_hour = models.PositiveSmallIntegerField(default=5)
    #: total SMS the whole system sends per rolling hour / per IST day (cost and abuse protection; never 0). 300 / 1500
    #: fit a factory whose shift start has a few hundred employees asking for a code within the hour: the per-employee
    #: cooldown and the per-number cap are the real abuse guards. (Migration 0124 changed the defaults; rows saved
    #: before it keep the numbers they have.)
    hourly_cap = models.PositiveIntegerField(default=300)
    daily_cap = models.PositiveIntegerField(default=1500)
    #: SMS one-time codes on/off (2026-11-20): the SMS channel's own switch, independent of WhatsApp. Either channel
    #: alone is enough for code sign-in. (otp_channel above is no longer read; migration 0169 turned it into this.)
    otp_enabled = models.BooleanField(default=False, db_default=False)
    #: rupees per SMS for the cost estimate (null = the code default) and the monthly budget HR wants to stay under
    price_per_sms = models.DecimalField(max_digits=8, decimal_places=4, null=True, blank=True)
    monthly_budget = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    #: set by the SMS Control page's save only (null until somebody has saved)
    updated_at = models.DateTimeField(null=True, blank=True)
    updated_by = models.ForeignKey(HRUser, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        db_table = "sms_settings"

    @classmethod
    def get(cls) -> "SmsSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class SmsMessageLog(models.Model):
    PURPOSE_LOGIN = "login"
    PURPOSE_RESET = "reset"
    PURPOSE_ACTIVATE = "activate"
    PURPOSE_TEST = "test"
    PURPOSES = (
        (PURPOSE_LOGIN, "Login"),
        (PURPOSE_RESET, "Password reset"),
        (PURPOSE_ACTIVATE, "Account activation"),
        (PURPOSE_TEST, "Test"),
    )

    STATUS_SENT = "sent"  # accepted by 2Factor (a send is recorded as "sent" before the call so caps count it at once)
    STATUS_FAILED = "failed"  # 2Factor or the network refused it: nothing reached the employee
    STATUS_BLOCKED = "blocked"  # stopped here: a cap or the circuit breaker; nothing was sent
    STATUSES = ((STATUS_SENT, "Sent"), (STATUS_FAILED, "Failed"), (STATUS_BLOCKED, "Blocked"))

    employee = models.ForeignKey(
        Employee, null=True, blank=True, on_delete=models.SET_NULL, related_name="sms_messages"
    )
    #: the HR user who sent a test message (null for employee codes)
    sent_by = models.ForeignKey(HRUser, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    #: never the full number: "••••••1234"
    phone_masked = models.CharField(max_length=40, blank=True, default="")
    #: HMAC-SHA256 (keyed with the server secret) of the normalised number: lets the per-number cap count by number
    phone_hash = models.CharField(max_length=64, blank=True, default="")
    purpose = models.CharField(max_length=10, choices=PURPOSES)
    provider = models.CharField(max_length=20, default="twofactor")
    status = models.CharField(max_length=10, choices=STATUSES)
    provider_message_id = models.CharField(max_length=100, blank=True, default="")
    #: one plain sentence for HR: no secret, no code, no phone number
    error = models.CharField(max_length=300, blank=True, default="")
    #: machine-readable reason behind `error` ("timeout", "auth", "balance", "hourly_cap", ...): not shown to the apps
    error_code = models.CharField(max_length=20, blank=True, default="")
    requested_ip = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "sms_message_log"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["status", "created_at"], name="sms_log_status_at"),
            models.Index(fields=["phone_hash", "created_at"], name="sms_log_phone_at"),
            models.Index(fields=["created_at"], name="sms_log_at"),
        ]
