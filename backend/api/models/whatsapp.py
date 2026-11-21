"""WhatsApp (Meta Cloud API) send log, settings, Meta templates, message wording and media assets."""

import datetime

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

    `status` moves (2026-11-06 queue, see whatsapp_dispatcher.py):
      queued -> sending -> sent -> delivered -> read     the normal life of a message
      queued -> expired                                  too late to be useful (older than its freshness, or
                                                         from an earlier day): never sent, never retried
      queued -> skipped                                  quiet hours, opted out, the employee's daily limit,
                                                         a duplicate, switched off, or cleared by HR
      sending -> failed                                  the provider refused it (a temporary failure goes
                                                         back to queued ONCE, a minute later)
    A one-time code never queues: pending -> sent / failed while the employee waits.
    "pending" is also what rows written before the queue existed carry.
    """

    # Every message type lives in whatsapp_catalog.py; nothing here needs editing (or a
    # migration) when a new one is added. Kept as attributes so older callers still work.
    DOCUMENT_TYPES = whatsapp_catalog.choices()
    CATEGORIES = whatsapp_catalog.categories()

    STATUS_PENDING = "pending"
    STATUS_QUEUED = "queued"
    STATUS_SENDING = "sending"
    STATUS_SENT = "sent"
    STATUS_DELIVERED = "delivered"
    STATUS_READ = "read"
    STATUS_FAILED = "failed"
    STATUS_EXPIRED = "expired"
    STATUS_SKIPPED = "skipped"
    STATUSES = (
        STATUS_PENDING, STATUS_QUEUED, STATUS_SENDING, STATUS_SENT, STATUS_DELIVERED, STATUS_READ,
        STATUS_FAILED, STATUS_EXPIRED, STATUS_SKIPPED,
    )

    # What kind of message it is (whatsapp_catalog.MessageType.kind): decides the queue's rules for it.
    KIND_CODE = "code"  # a one-time code the employee is waiting for: sent at once, never queued
    KIND_REQUESTED = "requested"  # about the employee's own request (approved / rejected)
    KIND_AUTOMATIC = "automatic"  # the system decided it (alerts, reminders, gate, visitors): capped per employee
    KIND_DOCUMENT = "document"  # a file HR sends

    # Null for a message to someone who is not an employee (Attendance Notify sends reports to numbers HR types in and
    # to WhatsApp groups, 2026-11-17): `recipient_label` then says who it went to. Everything else (the queue, its
    # pacing and caps, the history) is the same for both.
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="whatsapp_messages", null=True, blank=True,
    )
    recipient_label = models.TextField(blank=True, default="", db_default="", db_column="recipient_label")
    document_type = models.TextField(db_column="document_type")
    # Which HRMS workflow raised it when one message type serves several (the shared Approved /
    # Rejected wording: "leave", "permission", ...). Empty for types that belong to one module.
    related_module = models.TextField(blank=True, default="", db_column="related_module")
    # e.g. SalarySlip.id / EmployeeDocument.id, when the document is a
    # specific existing record rather than generated fresh (ID Card).
    document_ref_id = models.IntegerField(null=True, blank=True, db_column="document_ref_id")
    phone_number = models.TextField(db_column="phone_number")
    status = models.TextField(default="sent", db_column="status")  # one of STATUSES above
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
    # ── the queue (migration 0143). Every column has a database default, so a backend still running the previous
    # release during a rolling deploy keeps inserting rows without knowing these columns.
    kind = models.TextField(blank=True, default="", db_default="", db_column="kind")  # code|requested|automatic|document
    # Lower goes first: code 0, document 3, requested 4, automatic 5 (a bulk batch 6, behind everything time-critical).
    priority = models.SmallIntegerField(default=5, db_default=5, db_column="priority")
    # Not before this moment (a temporary failure is retried once, a minute later).
    send_after = models.DateTimeField(null=True, blank=True, db_column="send_after")
    # Never after this moment: min(created + the type's freshness, the end of that day in IST).
    expires_at = models.DateTimeField(null=True, blank=True, db_column="expires_at")
    # When the provider accepted it. The pacing (gap, per hour, per day) is measured on this.
    sent_at = models.DateTimeField(null=True, blank=True, db_column="sent_at")
    attempts = models.SmallIntegerField(default=0, db_default=0, db_column="attempts")
    # What the dispatcher needs to send it later: a document's media link (or how to build it), a contact card to follow,
    # an on-sent hook, the bulk batch it belongs to. Never a secret.
    payload = models.JSONField(default=dict, blank=True, db_default={}, db_column="payload")
    # Meta Cloud API (2026-11-20): the approved template the message went out as, and what Meta's webhook reported
    # back: when it was delivered / read, and how Meta prices it (pricing.category: authentication | utility |
    # marketing | service; pricing.billable). Blank / null until the webhook says so.
    template_name = models.TextField(blank=True, default="", db_default="", db_column="template_name")
    pricing_category = models.TextField(blank=True, default="", db_default="", db_column="pricing_category")
    billable = models.BooleanField(null=True, blank=True, db_column="billable")
    delivered_at = models.DateTimeField(null=True, blank=True, db_column="delivered_at")
    read_at = models.DateTimeField(null=True, blank=True, db_column="read_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_message_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["employee", "document_type"]),
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["document_type", "-created_at"]),
            # the dispatcher's "next queued row" and the pacing's "last sent" look-ups
            models.Index(fields=["status", "priority", "send_after"], name="whatsapp_log_queue_idx"),
            models.Index(fields=["sent_at"], name="whatsapp_log_sent_at_idx"),
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
    # Department Head notifications (2026-11-17): the section's master switch, and the new "a request is waiting for your
    # approval" message, which starts OFF (HR switches it on: every head gets one message per request).
    hod_notifications_enabled = models.BooleanField(default=True, db_default=True, db_column="hod_notifications_enabled")
    hod_request_waiting_enabled = models.BooleanField(
        default=False, db_default=False, db_column="hod_request_waiting_enabled"
    )
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
    # On-Duty tracking alerts (2026-11-21, geo_tracking/alerts.py): one switch per alert kind, each covering the message to
    # the employee and the one to their Department Head. All start OFF: each needs its Meta templates approved first.
    geo_location_off_enabled = models.BooleanField(default=False, db_default=False, db_column="geo_location_off_enabled")
    geo_permission_restricted_enabled = models.BooleanField(
        default=False, db_default=False, db_column="geo_permission_restricted_enabled"
    )
    geo_background_restricted_enabled = models.BooleanField(
        default=False, db_default=False, db_column="geo_background_restricted_enabled"
    )
    geo_missing_punch_enabled = models.BooleanField(default=False, db_default=False, db_column="geo_missing_punch_enabled")
    geo_punch_reminder_enabled = models.BooleanField(default=False, db_default=False, db_column="geo_punch_reminder_enabled")
    geo_tracking_failure_enabled = models.BooleanField(
        default=False, db_default=False, db_column="geo_tracking_failure_enabled"
    )

    # Attendance alert timing (whatsapp_alerts.py). Extra minutes to wait after the punctuality window
    # before an Absent alert; how many minutes BEFORE a punch is expected its friendly reminder goes
    # out; and how many minutes AFTER a punch was expected, with it still missing, the Missing Punch
    # alert goes out.
    absent_extra_minutes = models.IntegerField(default=0, db_column="absent_extra_minutes")
    four_punch_lead_minutes = models.IntegerField(default=15, db_column="four_punch_lead_minutes")
    missing_punch_after_minutes = models.IntegerField(default=20, db_column="missing_punch_after_minutes")

    # ── the sending engine (migration 0143, whatsapp_dispatcher.py) ──
    # Master switch for EVERY WhatsApp message, one-time codes included (off: the apps treat WhatsApp as unavailable,
    # so password sign-in and SMS keep working and nobody is locked out of activation).
    engine_enabled = models.BooleanField(default=True, db_default=True, db_column="engine_enabled")
    # Message types HR switched off one by one (whatsapp_catalog keys), for the types without a boolean above.
    disabled_message_types = models.JSONField(default=list, blank=True, db_default=[], db_column="disabled_message_types")
    # "Careful" pacing (owner, 2026-11-06): what keeps a linked WhatsApp number from being restricted.
    min_gap_seconds = models.IntegerField(default=30, db_default=30, db_column="min_gap_seconds")
    max_per_hour = models.IntegerField(default=60, db_default=60, db_column="max_per_hour")
    max_per_day = models.IntegerField(default=200, db_default=200, db_column="max_per_day")
    # AUTOMATIC messages (alerts, reminders, gate, visitors) one employee may get in a day.
    max_per_employee_per_day = models.IntegerField(default=3, db_default=3, db_column="max_per_employee_per_day")
    # No message but a one-time code leaves between quiet_start and quiet_end (IST; the span may cross midnight).
    quiet_hours_enabled = models.BooleanField(default=True, db_default=True, db_column="quiet_hours_enabled")
    quiet_start = models.TimeField(default=datetime.time(21, 0), db_default=datetime.time(21, 0), db_column="quiet_start")
    quiet_end = models.TimeField(default=datetime.time(7, 0), db_default=datetime.time(7, 0), db_column="quiet_end")
    # One-time codes by WhatsApp (2026-11-20): WhatsApp's own OTP switch, independent of SMS Control. Either channel
    # alone is enough for code sign-in; when both are on the apps let the employee choose.
    otp_enabled = models.BooleanField(default=True, db_default=True, db_column="otp_enabled")
    # {catalog type key: Meta template name} where HR picked a template other than the default `hrms_<key>`.
    template_overrides = models.JSONField(default=dict, blank=True, db_default={}, db_column="template_overrides")
    # {pricing category: rupees per message} HR set for the cost estimate; a missing key uses the code default.
    price_rates = models.JSONField(default=dict, blank=True, db_default={}, db_column="price_rates")
    monthly_budget = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, db_column="monthly_budget"
    )
    # When Meta's webhook last reached this server (shows HR whether the webhook is set up).
    last_webhook_at = models.DateTimeField(null=True, blank=True, db_column="last_webhook_at")

    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_settings"

    @classmethod
    def get(cls) -> "WhatsAppSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class WhatsAppOptOut(models.Model):
    """An employee who must not get WhatsApp notifications or documents (they asked, or the number belongs to someone
    else). A one-time code the employee asks for themselves still goes. Set from WhatsApp Control -> Employees."""

    employee = models.OneToOneField(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="whatsapp_opt_out",
    )
    reason = models.TextField(blank=True, default="", db_column="reason")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    # Who set it (the HR user's name), for the history.
    created_by = models.TextField(blank=True, default="", db_column="created_by")

    class Meta:
        db_table = "whatsapp_opt_out"


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
    #: digits in this code: 4 when it was sent by SMS, 6 when by WhatsApp (every row from before the SMS channel: 6).
    #: Stored so a code issued before HR switches the channel still verifies with the length it was issued with.
    code_length = models.SmallIntegerField(default=6, db_default=6, db_column="code_length")
    #: "whatsapp" | "sms": the channel the code went out on ("" for rows from before 2026-11-20).
    channel = models.TextField(blank=True, default="", db_default="", db_column="channel")
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
    RETIRED (2026-11-20): per-document-type free-form wording HR used to edit (the old Settings -> WhatsApp and
    Message Text editors), from the days of a linked WhatsApp Web session. With the Meta WhatsApp Cloud API the
    wording IS the approved Meta template (WhatsAppTemplate), so nothing sends this text any more and is_enabled no
    longer switches a type off (WhatsApp Control -> Message Controls does). Kept, unread, so no migration is needed.
    """
    document_type = models.TextField(unique=True, db_column="document_type")
    message_body = models.TextField(blank=True, default="", db_column="message_body")
    is_enabled = models.BooleanField(default=True, db_column="is_enabled")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_message_template"


class WhatsAppMediaAsset(models.Model):
    """
    Short-lived, token-addressed blob store: the file of a queued document / ID card WhatsApp message waits here until
    the send queue's turn, when whatsapp_dispatcher uploads it to Meta (whatsapp_cloud.upload_media) and sends it in
    the template's header (whatsapp_service.send_document / queue_to_recipient). Nothing serves it publicly any more.
    Pruned lazily (expired rows deleted whenever a new one is created); a queued message never outlives its day.
    """
    token = models.CharField(max_length=64, unique=True, db_column="token")
    content = models.BinaryField(db_column="content")
    filename = models.TextField(db_column="filename")
    mime_type = models.TextField(db_column="mime_type")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    expires_at = models.DateTimeField(db_column="expires_at")

    class Meta:
        db_table = "whatsapp_media_asset"


class WhatsAppTemplate(models.Model):
    """A Meta WhatsApp message template (Cloud API), mirrored locally: created from WhatsApp Control -> Templates (or
    found by a sync with Meta), with Meta's review status. Meta is the source of truth for the wording and the status;
    this row is what the HRMS last saw. Every business-started message must be sent as an APPROVED template."""

    name = models.TextField(db_column="name")
    language = models.TextField(default="en", db_column="language")
    category = models.TextField(default="UTILITY", db_column="category")  # UTILITY | AUTHENTICATION | MARKETING
    # DRAFT (not submitted yet) | PENDING | APPROVED | REJECTED | PAUSED | DISABLED | IN_APPEAL | ... as Meta says
    status = models.TextField(default="DRAFT", db_column="status")
    meta_id = models.TextField(blank=True, default="", db_column="meta_id")
    parameter_format = models.TextField(default="named", db_column="parameter_format")
    components = models.JSONField(default=list, blank=True, db_column="components")
    rejected_reason = models.TextField(blank=True, default="", db_column="rejected_reason")
    quality_score = models.TextField(blank=True, default="", db_column="quality_score")
    # the HRMS message type it was made for (whatsapp_catalog key), "" for one made by hand
    message_type = models.TextField(blank=True, default="", db_column="message_type")
    last_synced_at = models.DateTimeField(null=True, blank=True, db_column="last_synced_at")
    created_by = models.ForeignKey(
        HRUser,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        db_column="created_by_id",
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_meta_template"
        ordering = ["name", "language"]
        constraints = [
            models.UniqueConstraint(fields=["name", "language"], name="whatsapp_meta_template_name_language"),
        ]
