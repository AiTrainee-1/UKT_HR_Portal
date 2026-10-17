"""SMS one-time codes (2Factor): the settings row and the send log.

Two tables (both new, nothing existing is touched):
  SmsSettings    singleton (pk=1): which channel delivers the one-time codes (WhatsApp or SMS), and every SMS limit
  SmsMessageLog  one row per SMS attempt (sent, failed, or blocked by a cap / the circuit breaker). It NEVER holds the
                 code, the text, the API key or a full phone number: only the masked number and an HMAC of the number
                 (so the per-number limit can count by number across workers).

The behaviour lives in api/sms_service.py (the send pipeline), api/twofactor_client.py (the HTTP
call), api/otp_service.py (the channel switch) and api/sms_control_views.py (the HR page's API).
"""

from django.db import models
from django.utils import timezone

from .accounts import HRUser
from .core import Employee


class SmsSettings(models.Model):
    """The SMS Control page's settings. `otp_channel` decides who delivers codes; while it is 'whatsapp' the three OTP
    switches below do nothing (the WhatsApp Control switches keep ruling) and WhatsApp behaves exactly as before."""

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
