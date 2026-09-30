"""Email (Gmail / SMTP) send log, feature switches and wording."""

from django.db import models

from .. import email_catalog
from .accounts import HRUser
from .core import Employee


class EmailMessageLog(models.Model):
    """
    One row per email the HRMS tried to send -salary slips, letters, ID cards, visitor
    notices, recruitment mail, the test message- whether it went out or not. Shared across
    every email type instead of a parallel *_emailed_at column on each table, so the Gmail
    Control page shows one history, and a bulk send can report exactly who failed and why.

    `status`: "sent" (the mail server accepted it), "failed" (an attempt that could not
    complete: no address on file, the server refused it, wrong password ...), or "blocked"
    (deliberately not attempted: HR switched it off, a development machine, over the daily
    limit, SMTP not set up). SMTP has no delivery receipt, so "sent" means accepted by Gmail.

    `employee` is empty for recipients who are not employees (a resume-screening candidate).
    """

    EMAIL_TYPES = email_catalog.choices()
    CATEGORIES = email_catalog.categories()

    STATUS_SENT = "sent"
    STATUS_FAILED = "failed"
    STATUS_BLOCKED = "blocked"

    employee = models.ForeignKey(
        Employee,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column="employee_id",
        related_name="email_messages",
    )
    recipient_name = models.TextField(blank=True, default="", db_column="recipient_name")
    recipient_email = models.TextField(blank=True, default="", db_column="recipient_email")
    email_type = models.TextField(db_column="email_type")
    # Which workflow raised it when one type serves several. Empty for types that belong to one module.
    related_module = models.TextField(blank=True, default="", db_column="related_module")
    # The record the email is about (SalarySlip.id, ScreeningCandidate.id ...), when there is one.
    ref_id = models.IntegerField(null=True, blank=True, db_column="ref_id")
    subject = models.TextField(blank=True, default="", db_column="subject")
    # The wording that went out, as plain text, for the history view.
    message_text = models.TextField(blank=True, default="", db_column="message_text")
    attachment_name = models.TextField(blank=True, default="", db_column="attachment_name")
    status = models.TextField(default="sent", db_column="status")  # sent|failed|blocked
    error_message = models.TextField(blank=True, default="", db_column="error_message")
    sent_by = models.ForeignKey(
        HRUser,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        db_column="sent_by_id",
        related_name="emails_sent",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "email_message_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["employee", "email_type"]),
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["email_type", "-created_at"]),
        ]


class EmailSettings(models.Model):
    """
    Singleton (pk=1) holding the on/off switches for every email feature, edited from the Gmail
    Control page. The Gmail account itself (host, user, app password) is NOT here -it stays in
    Settings -> SMTP. Per-email wording lives in EmailMessageTemplate.

    Everything defaults ON: these emails were already being sent before the page existed, so
    nothing changes until HR turns something off.
    """

    # Master switch: nothing at all is emailed while it is off.
    emails_enabled = models.BooleanField(default=True, db_column="emails_enabled")
    # Module switches (email_catalog.MODULE_SWITCHES). An email goes out only when its own switch
    # (Message Text tab), its module's switch and the master switch are all on.
    document_emails_enabled = models.BooleanField(default=True, db_column="document_emails_enabled")
    visitor_emails_enabled = models.BooleanField(default=True, db_column="visitor_emails_enabled")
    recruitment_emails_enabled = models.BooleanField(default=True, db_column="recruitment_emails_enabled")
    # Most emails one calendar day (IST) may send; the rest are held back as "blocked". Gmail stops a
    # regular account at about 500 a day and Google Workspace at about 2,000, and a stopped account also
    # stops every other mail from it. 0 = no limit.
    daily_send_limit = models.IntegerField(default=0, db_column="daily_send_limit")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "email_settings"

    @classmethod
    def get(cls) -> "EmailSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class EmailMessageTemplate(models.Model):
    """
    Per-email-type subject and wording, editable from Gmail Control -> Message Text. Business
    configuration, not a secret. A type with no row, or a blank field, sends the built-in
    default (email_catalog.EmailType); is_enabled=False is HR's per-type off switch.
    """

    email_type = models.TextField(unique=True, db_column="email_type")
    subject = models.TextField(blank=True, default="", db_column="subject")
    message_body = models.TextField(blank=True, default="", db_column="message_body")
    is_enabled = models.BooleanField(default=True, db_column="is_enabled")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "email_message_template"
