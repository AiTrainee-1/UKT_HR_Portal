"""WhatsApp (WAClient) send log, message wording and media assets."""

from django.db import models

from .. import whatsapp_catalog
from .accounts import HRUser
from .core import Employee


class WhatsAppMessageLog(models.Model):
    """
    One row per WhatsApp send attempt -documents (single or bulk), OTPs,
    attendance alerts and approval confirmations- success or failure. Shared
    across every message type instead of adding a parallel whatsapp_sent_at
    column to SalarySlip/Employee/etc., so any list view can look up "was this
    ever sent via WhatsApp" with one join, bulk sends can report exactly who
    failed and why, and the WhatsApp Control page can show one history.

    `status` moves: pending -> sent -> delivered -> read, or -> failed at any
    point. "pending" is the brief window between reserving the row (which is
    what makes an automatic alert exactly-once, see dedupe_key) and the
    provider accepting the message.
    """

    # Every message type lives in whatsapp_catalog.py; nothing here needs editing (or a
    # migration) when a new one is added. Kept as attributes so older callers still work.
    DOCUMENT_TYPES = whatsapp_catalog.choices()
    CATEGORIES = whatsapp_catalog.categories()

    STATUS_PENDING = "pending"
    STATUS_SENT = "sent"
    STATUS_DELIVERED = "delivered"
    STATUS_READ = "read"
    STATUS_FAILED = "failed"

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="whatsapp_messages",
    )
    document_type = models.TextField(db_column="document_type")
    # Which HRMS workflow raised it when one message type serves several (the shared Approved /
    # Rejected wording: "leave", "permission", ...). Empty for types that belong to one module.
    related_module = models.TextField(blank=True, default="", db_column="related_module")
    # e.g. SalarySlip.id / EmployeeDocument.id, when the document is a
    # specific existing record rather than generated fresh (ID Card).
    document_ref_id = models.IntegerField(null=True, blank=True, db_column="document_ref_id")
    phone_number = models.TextField(db_column="phone_number")
    status = models.TextField(default="sent", db_column="status")  # pending|sent|delivered|read|failed
    # WhatsApp's own id for the message; delivery/read webhooks refer to it.
    provider_message_id = models.TextField(blank=True, default="", db_column="provider_message_id")
    error_message = models.TextField(blank=True, default="", db_column="error_message")
    # What was sent, for the history view. One-time codes are stored redacted.
    message_text = models.TextField(blank=True, default="", db_column="message_text")
    # Exactly-once key for automatic messages, e.g. "absent:2026-09-25:42". Empty
    # for manual sends. Unique when set, so two overlapping scheduler runs can
    # never both send the same alert (see the constraint below).
    dedupe_key = models.TextField(blank=True, default="", db_column="dedupe_key")
    sent_by = models.ForeignKey(
        HRUser, null=True, blank=True, on_delete=models.SET_NULL,
        db_column="sent_by_id", related_name="whatsapp_messages_sent",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_message_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["employee", "document_type"]),
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["document_type", "-created_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["dedupe_key"], condition=~models.Q(dedupe_key=""), name="whatsapp_log_unique_dedupe_key",
            ),
        ]


class WhatsAppSettings(models.Model):
    """
    Singleton (pk=1) holding the on/off switches and timing for every WhatsApp
    feature, edited from the WhatsApp Control page. Credentials are NOT here
    -they stay .env-only. Per-document wording lives in WhatsAppMessageTemplate.

    Sign-in features default ON (they only ever run when an employee asks for
    them, and password login stays available). The automatic broadcasts default
    OFF: turning them on messages real employees, so that is a deliberate act.
    """

    otp_login_enabled = models.BooleanField(default=True, db_column="otp_login_enabled")
    otp_reset_enabled = models.BooleanField(default=True, db_column="otp_reset_enabled")
    # First-time "set my password" needs a WhatsApp code first (see otp_service.activation_required).
    otp_activate_enabled = models.BooleanField(default=True, db_column="otp_activate_enabled")

    # Module-wide switches. Each message type can also have its own switch (above/below);
    # a message is sent only when both are on. They default ON because these messages were
    # already being sent (documents, visitors) or go to one employee about their own request.
    document_notifications_enabled = models.BooleanField(default=True, db_column="document_notifications_enabled")
    visitor_notification_enabled = models.BooleanField(default=True, db_column="visitor_notification_enabled")
    approval_notifications_enabled = models.BooleanField(default=True, db_column="approval_notifications_enabled")
    outpass_notifications_enabled = models.BooleanField(default=True, db_column="outpass_notifications_enabled")
    # Master switch for the four attendance alerts and the punch reminders. The individual
    # attendance switches below stay OFF until HR turns them on.
    attendance_alerts_enabled = models.BooleanField(default=True, db_column="attendance_alerts_enabled")
    # Approval workflows HR has switched off (keys of whatsapp_catalog.APPROVAL_MODULES).
    disabled_approval_modules = models.JSONField(default=list, blank=True, db_column="disabled_approval_modules")
    password_login_enabled = models.BooleanField(default=True, db_column="password_login_enabled")
    otp_expiry_minutes = models.IntegerField(default=5, db_column="otp_expiry_minutes")

    absent_alert_enabled = models.BooleanField(default=False, db_column="absent_alert_enabled")
    late_alert_enabled = models.BooleanField(default=False, db_column="late_alert_enabled")
    four_punch_alert_enabled = models.BooleanField(default=False, db_column="four_punch_alert_enabled")
    missing_punch_alert_enabled = models.BooleanField(default=False, db_column="missing_punch_alert_enabled")
    geo_approval_enabled = models.BooleanField(default=False, db_column="geo_approval_enabled")

    # Extra minutes to wait after the shift's own grace before calling someone
    # absent / a lunch punch missing, and how long after the shift ends before
    # the end-of-day missing-punch message goes out.
    absent_extra_minutes = models.IntegerField(default=0, db_column="absent_extra_minutes")
    four_punch_wait_minutes = models.IntegerField(default=10, db_column="four_punch_wait_minutes")
    missing_punch_after_minutes = models.IntegerField(default=30, db_column="missing_punch_after_minutes")

    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_settings"

    @classmethod
    def get(cls) -> "WhatsAppSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class EmployeeOtp(models.Model):
    """
    A one-time passcode sent to an employee's WhatsApp for signing in
    (purpose="login") or resetting their password (purpose="reset").

    The code itself is never stored -only an HMAC of it (see otp_service.py)-
    so a database read or backup can't be turned into a login. Each row is
    single-use, expires, and dies after too many wrong guesses.
    """

    PURPOSE_LOGIN = "login"
    PURPOSE_RESET = "reset"
    PURPOSE_ACTIVATE = "activate"
    PURPOSES = (
        (PURPOSE_LOGIN, "Login"),
        (PURPOSE_RESET, "Password reset"),
        (PURPOSE_ACTIVATE, "Account activation"),
    )

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="otps",
    )
    purpose = models.TextField(choices=PURPOSES, db_column="purpose")
    code_hash = models.TextField(db_column="code_hash")
    phone_number = models.TextField(db_column="phone_number")
    attempts = models.IntegerField(default=0, db_column="attempts")
    expires_at = models.DateTimeField(db_column="expires_at")
    consumed_at = models.DateTimeField(null=True, blank=True, db_column="consumed_at")
    requested_ip = models.TextField(blank=True, default="", db_column="requested_ip")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "employee_otp"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["employee", "purpose", "-created_at"])]


class WhatsAppMessageTemplate(models.Model):
    """
    Per-document-type message wording, editable from Settings -> WhatsApp.
    This is business configuration, not a secret (the API credentials stay
    .env-only, see settings.WACLIENT_*). WAClient's Web API sends over a
    linked WhatsApp session, so there are no Meta templates to approve: the
    text is free-form, with {{1}}, {{2}} ... placeholders filled in order
    from what each send endpoint passes (see whatsapp_service.PLACEHOLDER_HELP).
    A document type with no row, or a blank message_body, sends the built-in
    default wording (whatsapp_service.DEFAULT_MESSAGES); is_enabled=False is
    HR's per-type off switch.
    """
    document_type = models.TextField(unique=True, db_column="document_type")
    message_body = models.TextField(blank=True, default="", db_column="message_body")
    is_enabled = models.BooleanField(default=True, db_column="is_enabled")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_message_template"


class WhatsAppMediaAsset(models.Model):
    """
    Short-lived, token-addressed blob store so a document/image WhatsApp
    message can be sent via WAClient. WAClient's /send only accepts a
    *public URL* it fetches the file from (no direct upload) -see
    whatsapp_service.send_document. Every generated PDF/PNG is written here
    just before sending, exposed read-only at GET /api/whatsapp/media/<token>
    (whatsapp_views.whatsapp_media, no auth -WAClient's servers fetch it),
    and pruned lazily (expired rows deleted whenever a new one is created --
    no separate scheduled job needed given the low daily volume of sends).
    """
    token = models.CharField(max_length=64, unique=True, db_column="token")
    content = models.BinaryField(db_column="content")
    filename = models.TextField(db_column="filename")
    mime_type = models.TextField(db_column="mime_type")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    expires_at = models.DateTimeField(db_column="expires_at")

    class Meta:
        db_table = "whatsapp_media_asset"
