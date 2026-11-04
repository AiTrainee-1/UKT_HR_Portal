"""Reminders to Department Heads about the requests waiting for their approval (HR Requests page -> Notify).

    HodReminderSettings  one row (pk=1): the schedule, the channels and the wording HR set on the Notify tab
    HodReminderRun       one reminder round: a scheduled slot ("10:00" on a date) or a "Send now" from HR
    HodReminderDelivery  one Department Head in a round: the message they got and what each channel did with it

The sending, the schedule and the wording rules are in api/hod_reminders.py.
"""

from django.db import models
from django.db.models import Q

from .core import DepartmentManager, Employee


def default_reminder_times() -> list[str]:
    return ["10:00", "16:00"]


def default_reminder_days() -> list[int]:
    return [0, 1, 2, 3, 4, 5]  # Monday to Saturday (0 = Monday)


class HodReminderSettings(models.Model):
    """
    Singleton (pk=1). Company-wide: one schedule for every branch, changed only by a login that is not limited to one
    branch. OFF by default - switching it on messages real Department Heads, so it is a deliberate HR act.

    `template` is the wording with {{name}}, {{pendingList}}, {{total}} and {{date}}; blank = the built-in default
    (hod_reminders.DEFAULT_TEMPLATE), so a later change of the default reaches everyone who never edited it.
    """

    enabled = models.BooleanField(default=False, db_column="enabled")
    times = models.JSONField(default=default_reminder_times, db_column="times")  # ["HH:MM", ...] IST, ascending
    days = models.JSONField(default=default_reminder_days, db_column="days")  # weekdays, 0 = Monday
    channel_whatsapp = models.BooleanField(default=True, db_column="channel_whatsapp")
    channel_email = models.BooleanField(default=True, db_column="channel_email")
    channel_push = models.BooleanField(default=True, db_column="channel_push")
    template = models.TextField(blank=True, default="", db_column="template")
    updated_by = models.TextField(blank=True, default="", db_column="updated_by")
    updated_at = models.DateTimeField(null=True, blank=True, db_column="updated_at")

    class Meta:
        db_table = "hod_reminder_settings"

    @classmethod
    def get(cls) -> "HodReminderSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class HodReminderRun(models.Model):
    """
    One reminder round. A scheduled round is unique per (run_date, slot) at the database level, so two workers (or a
    restart inside the 10-minute window) can never send the same slot twice. A manual round ("Send now") has no slot.

    The round is processed off the request (Railway has one sync worker with a 30 s limit): the scheduler thread runs a
    scheduled slot, a background thread a manual one, and the 1-minute job picks up a round whose processor stopped
    (`heartbeat_at` too old). `claim_token` names the processor that owns it right now.
    """

    TRIGGER_SCHEDULE = "schedule"
    TRIGGER_MANUAL = "manual"
    STATUS_RUNNING = "running"
    STATUS_DONE = "done"
    STATUS_FAILED = "failed"

    trigger = models.TextField(db_column="trigger")
    slot = models.TextField(blank=True, default="", db_column="slot")  # "HH:MM" of a scheduled round
    run_date = models.DateField(db_column="run_date")  # the IST date the round belongs to
    status = models.TextField(default=STATUS_RUNNING, db_column="status")
    sent_by = models.TextField(blank=True, default="", db_column="sent_by")  # HR's name for a manual round
    sent_by_user_id = models.IntegerField(null=True, blank=True, db_column="sent_by_user_id")
    # {"whatsapp": bool, "email": bool, "push": bool}: the channels this round uses
    channels = models.JSONField(default=dict, db_column="channels")
    # The Department Heads a manual round was limited to (null = every head with a pending request)
    manager_ids = models.JSONField(null=True, blank=True, db_column="manager_ids")
    template = models.TextField(blank=True, default="", db_column="template")  # the wording used
    prepared = models.BooleanField(default=False, db_column="prepared")  # deliveries built
    hods = models.IntegerField(default=0, db_column="hods")
    error = models.TextField(blank=True, default="", db_column="error")
    claim_token = models.TextField(blank=True, default="", db_column="claim_token")
    heartbeat_at = models.DateTimeField(null=True, blank=True, db_column="heartbeat_at")
    started_at = models.DateTimeField(auto_now_add=True, db_column="started_at")
    finished_at = models.DateTimeField(null=True, blank=True, db_column="finished_at")

    class Meta:
        db_table = "hod_reminder_runs"
        ordering = ["-started_at", "-id"]
        indexes = [models.Index(fields=["status", "started_at"], name="hod_reminder_run_status_idx")]
        constraints = [
            models.UniqueConstraint(
                fields=["run_date", "slot"],
                condition=Q(trigger="schedule"),
                name="hod_reminder_run_unique_slot",
            ),
        ]


class HodReminderDelivery(models.Model):
    """
    One Department Head in one round: their pending figures when the round started, the exact text they were sent, and
    per channel what happened: "pending" (not tried yet), "sending", "sent", "failed", "skipped" (the channel was on but
    could not be used for this head: no phone, not set up, switched off ... - `*_note` says why) or "off" (the channel
    was not used in this round).
    """

    STATUS_PENDING = "pending"
    STATUS_SENDING = "sending"
    STATUS_SENT = "sent"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"
    STATUS_OFF = "off"

    run = models.ForeignKey(HodReminderRun, on_delete=models.CASCADE, related_name="deliveries", db_column="run_id")
    manager = models.ForeignKey(
        DepartmentManager,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reminder_deliveries",
        db_column="manager_id",
    )
    employee = models.ForeignKey(
        Employee,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="hod_reminder_deliveries",
        db_column="employee_id",
    )
    name = models.TextField(db_column="name")
    pending = models.IntegerField(default=0, db_column="pending")
    by_category = models.JSONField(default=dict, db_column="by_category")
    text = models.TextField(db_column="text")
    whatsapp_status = models.CharField(max_length=12, default=STATUS_PENDING, db_column="whatsapp_status")
    whatsapp_note = models.TextField(blank=True, default="", db_column="whatsapp_note")
    email_status = models.CharField(max_length=12, default=STATUS_PENDING, db_column="email_status")
    email_note = models.TextField(blank=True, default="", db_column="email_note")
    push_status = models.CharField(max_length=12, default=STATUS_PENDING, db_column="push_status")
    push_note = models.TextField(blank=True, default="", db_column="push_note")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "hod_reminder_deliveries"
        ordering = ["id"]
        constraints = [
            models.UniqueConstraint(fields=["run", "manager"], name="hod_reminder_delivery_unique_head"),
        ]
