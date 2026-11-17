"""Attendance Notify (owner 2026-11-17, /hr/attendance/attendance-notify): attendance reports sent on a schedule.

    AttendanceNotifySettings       one row (pk=1): the number the HRMS's WhatsApp is linked to ("the connected number")
    AttendanceNotifyAutomation     one automation: which report, for whom, through which channel, to whom, and when
    AttendanceNotifyRecipientList  a saved list of WhatsApp numbers or email addresses, reused by automations
    AttendanceNotifyRun            one execution of an automation (a scheduled slot, "Run now" or a retry)
    AttendanceNotifyDelivery       one recipient of a run and what happened to it

The report, the schedule and the sending are in api/attendance_notify.py and api/attendance_notify_report.py.
"""

from django.db import models
from django.db.models import Q


def default_times() -> list[str]:
    return ["09:30"]


def default_days() -> list[int]:
    return [0, 1, 2, 3, 4, 5]  # Monday to Saturday


def default_categories() -> list[str]:
    return ["absent", "cl", "on_leave", "on_duty", "permission", "compensation"]


def default_recipients() -> dict:
    return {}


class AttendanceNotifySettings(models.Model):
    """Singleton (pk=1). `connected_number` is the company number the HRMS's WhatsApp is linked to (WAClient does not
    tell it): an automation can send its report there too ("Send to the connected number")."""

    connected_number = models.TextField(blank=True, default="", db_column="connected_number")
    updated_by = models.TextField(blank=True, default="", db_column="updated_by")
    updated_at = models.DateTimeField(null=True, blank=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_notify_settings"

    @classmethod
    def get(cls) -> "AttendanceNotifySettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class AttendanceNotifyAutomation(models.Model):
    CHANNEL_WHATSAPP = "whatsapp"
    CHANNEL_EMAIL = "email"
    CHANNEL_CHAT = "chat"
    CHANNELS = (CHANNEL_WHATSAPP, CHANNEL_EMAIL, CHANNEL_CHAT)

    name = models.TextField(db_column="name")
    channel = models.TextField(db_column="channel")
    is_active = models.BooleanField(default=True, db_column="is_active")
    # the report: daily ("today" / "yesterday", relative to the sending day) or a custom fixed date / date range
    report_type = models.TextField(default="daily", db_column="report_type")
    report_day = models.TextField(default="today", db_column="report_day")
    date_from = models.DateField(null=True, blank=True, db_column="date_from")
    date_to = models.DateField(null=True, blank=True, db_column="date_to")
    categories = models.JSONField(default=default_categories, db_column="categories")
    employee_type = models.TextField(default="all", db_column="employee_type")  # all | staff | production
    # when: at each of `times` (IST "HH:MM") every day, on `days` (0 = Monday) or once on `run_on`
    frequency = models.TextField(default="daily", db_column="frequency")
    days = models.JSONField(default=default_days, db_column="days")
    run_on = models.DateField(null=True, blank=True, db_column="run_on")
    times = models.JSONField(default=default_times, db_column="times")
    # what: summary counts, the detailed employee list, or both; photos in the detailed report
    content = models.TextField(default="both", db_column="content")
    include_photos = models.BooleanField(default=False, db_column="include_photos")
    email_format = models.TextField(default="html", db_column="email_format")  # text | html
    attach_pdf = models.BooleanField(default=False, db_column="attach_pdf")
    subject = models.TextField(blank=True, default="", db_column="subject")
    skip_when_empty = models.BooleanField(default=False, db_column="skip_when_empty")
    recipients = models.JSONField(default=default_recipients, db_column="recipients")
    # the creator's branch scope: the report covers that branch only (null = the whole company)
    branch = models.ForeignKey(
        "Branch", on_delete=models.SET_NULL, null=True, blank=True, db_column="branch_id", related_name="+"
    )
    created_by = models.TextField(blank=True, default="", db_column="created_by")
    updated_by = models.TextField(blank=True, default="", db_column="updated_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_notify_automations"
        ordering = ["name", "id"]


class AttendanceNotifyRecipientList(models.Model):
    """A saved list: WhatsApp `items` = [{"value": "+91…", "label": "…"}]; email `items` = {"to": [], "cc": [], "bcc": []}."""

    name = models.TextField(db_column="name")
    channel = models.TextField(db_column="channel")  # whatsapp | email
    items = models.JSONField(default=list, db_column="items")
    branch = models.ForeignKey(
        "Branch", on_delete=models.SET_NULL, null=True, blank=True, db_column="branch_id", related_name="+"
    )
    created_by = models.TextField(blank=True, default="", db_column="created_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_notify_recipient_lists"
        ordering = ["name", "id"]


class AttendanceNotifyRun(models.Model):
    """
    One execution. A scheduled one is unique per (automation, run_date, slot) in the database, so two workers or a
    restart inside the sending window can never send the same slot twice. Processed off the request by whoever holds
    `claim_token` (beating `heartbeat_at`); the 1-minute job takes over a run whose holder stopped. The automation's
    name and channel are copied in, so the history survives the automation being deleted.
    """

    TRIGGER_SCHEDULE = "schedule"
    TRIGGER_MANUAL = "manual"
    TRIGGER_RETRY = "retry"

    STATUS_RUNNING = "running"
    STATUS_DONE = "done"
    STATUS_PARTIAL = "partial"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"

    automation = models.ForeignKey(
        AttendanceNotifyAutomation,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column="automation_id",
        related_name="runs",
    )
    automation_name = models.TextField(blank=True, default="", db_column="automation_name")
    channel = models.TextField(db_column="channel")
    trigger = models.TextField(default=TRIGGER_SCHEDULE, db_column="trigger")
    slot = models.TextField(null=True, blank=True, db_column="slot")  # "HH:MM" of a scheduled run
    run_date = models.DateField(db_column="run_date")  # the IST date it was due / started
    report_from = models.DateField(null=True, blank=True, db_column="report_from")
    report_to = models.DateField(null=True, blank=True, db_column="report_to")
    status = models.TextField(default=STATUS_RUNNING, db_column="status")
    employees = models.IntegerField(default=0, db_column="employees")
    counts = models.JSONField(default=dict, db_column="counts")
    config = models.JSONField(default=dict, db_column="config")  # the automation as it was when the run started
    error = models.TextField(blank=True, default="", db_column="error")
    requested_by = models.TextField(blank=True, default="", db_column="requested_by")
    retry_of = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, db_column="retry_of_id", related_name="retries"
    )
    claim_token = models.TextField(blank=True, default="", db_column="claim_token")
    heartbeat_at = models.DateTimeField(null=True, blank=True, db_column="heartbeat_at")
    started_at = models.DateTimeField(auto_now_add=True, db_column="started_at")
    finished_at = models.DateTimeField(null=True, blank=True, db_column="finished_at")

    class Meta:
        db_table = "attendance_notify_runs"
        ordering = ["-started_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["automation", "run_date", "slot"],
                condition=Q(trigger="schedule"),
                name="attendance_notify_run_unique_slot",
            )
        ]
        indexes = [models.Index(fields=["status"], name="attn_notify_run_status")]


class AttendanceNotifyDelivery(models.Model):
    """One recipient of a run. WhatsApp messages leave through the shared paced queue, so a delivery can be "queued"
    until the queue sends it (its log rows are in `whatsapp_log_ids`); email and chat are "sent" or "failed" at once.
    A failed email / chat delivery is tried again a few minutes later (`retry_at`, at most MAX_ATTEMPTS)."""

    STATUS_PENDING = "pending"
    STATUS_SENDING = "sending"
    STATUS_QUEUED = "queued"
    STATUS_SENT = "sent"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"

    run = models.ForeignKey(
        AttendanceNotifyRun, on_delete=models.CASCADE, db_column="run_id", related_name="deliveries"
    )
    kind = models.TextField(db_column="kind")  # connected | number | group | email | chat
    recipient = models.TextField(db_column="recipient")  # phone / group id / "to" addresses / chat channel id
    label = models.TextField(blank=True, default="", db_column="label")
    status = models.TextField(default=STATUS_PENDING, db_column="status")
    note = models.TextField(blank=True, default="", db_column="note")
    attempts = models.IntegerField(default=0, db_column="attempts")
    retry_at = models.DateTimeField(null=True, blank=True, db_column="retry_at")
    whatsapp_log_ids = models.JSONField(default=list, db_column="whatsapp_log_ids")
    email_log_id = models.IntegerField(null=True, blank=True, db_column="email_log_id")
    chat_message_id = models.IntegerField(null=True, blank=True, db_column="chat_message_id")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_notify_deliveries"
        ordering = ["id"]
