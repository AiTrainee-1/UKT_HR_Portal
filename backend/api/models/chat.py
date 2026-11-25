"""Chat channels, messages and reactions."""

from django.db import models
from django.db.models import Q

from .core import Department, Employee


# ──────────────────────────────────────────────
#  Staff Chat (mobile app) -Company + Department channels
# ──────────────────────────────────────────────

class ChatChannel(models.Model):
    """
    One row for the single company-wide channel (department=None), plus one
    row per Department for department-scoped channels. Rows are created
    lazily on first access rather than pre-seeded for every department.
    """
    CHANNEL_COMPANY = "company"
    CHANNEL_DEPARTMENT = "department"
    CHANNEL_TYPES = [(CHANNEL_COMPANY, "Company"), (CHANNEL_DEPARTMENT, "Department")]

    channel_type = models.TextField(choices=CHANNEL_TYPES, db_column="channel_type")
    department = models.ForeignKey(
        Department, on_delete=models.CASCADE, null=True, blank=True,
        db_column="department_id", related_name="chat_channels",
    )
    # A department channel could reach a branch through its department, but a
    # COMPANY channel has no department at all -so the branch lives here, on
    # the channel, and one column answers it for both kinds. Each branch gets
    # its own company-wide channel; staff in one unit do not read another's.
    branch = models.ForeignKey(
        "Branch", on_delete=models.CASCADE, null=True, blank=True,
        db_column="branch_id", related_name="chat_channels",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "chat_channels"
        constraints = [
            models.UniqueConstraint(
                fields=["department"], condition=Q(channel_type="department"),
                name="unique_department_chat_channel",
            ),
            # One company channel PER BRANCH. Postgres treats NULLs as
            # distinct in a unique index, so the pre-branch channel
            # (branch=None) is covered by the second constraint below.
            models.UniqueConstraint(
                fields=["branch"], condition=Q(channel_type="company"),
                name="unique_company_chat_channel_per_branch",
            ),
            models.UniqueConstraint(
                fields=["channel_type"],
                condition=Q(channel_type="company", branch__isnull=True),
                name="unique_legacy_company_chat_channel",
            ),
        ]

    @classmethod
    def get_company_channel(cls, branch_id=None) -> "ChatChannel":
        """The company-wide channel for one branch.

        branch_id=None returns the pre-branch channel, which is what an
        unscoped admin sees and where every message written before branch
        isolation still lives.
        """
        obj, _ = cls.objects.get_or_create(
            channel_type=cls.CHANNEL_COMPANY, department=None, branch_id=branch_id,
        )
        return obj

    @classmethod
    def get_department_channel(cls, department: "Department") -> "ChatChannel":
        """A department's channel, stamped with that department's branch.

        The branch is derived rather than passed: a department belongs to
        exactly one branch, so its channel cannot belong to another. Kept in
        sync on every call so a department moved between branches takes its
        channel with it.
        """
        obj, created = cls.objects.get_or_create(
            channel_type=cls.CHANNEL_DEPARTMENT, department=department,
            defaults={"branch_id": department.branch_id},
        )
        if not created and obj.branch_id != department.branch_id:
            obj.branch_id = department.branch_id
            obj.save(update_fields=["branch"])
        return obj


class ChatMessage(models.Model):
    channel = models.ForeignKey(ChatChannel, on_delete=models.CASCADE, db_column="channel_id", related_name="messages")
    # Null sender = an HR Portal user (HR/MD/Director), who has no Employee
    # row -their display name is stored in sender_label instead.
    sender = models.ForeignKey(
        Employee, on_delete=models.CASCADE, null=True, blank=True,
        db_column="sender_id", related_name="chat_messages",
    )
    sender_label = models.TextField(blank=True, default="", db_column="sender_label")
    text = models.TextField()
    reply_to = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="reply_to_id", related_name="replies",
    )
    # A structured attachment the HR chat page draws as a card (Attendance Notify's report: counts and the employees,
    # 2026-11-17); `text` always carries the plain version, which is all the mobile app shows. Null for a typed message.
    payload = models.JSONField(null=True, blank=True, db_column="payload")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    # ── GIFs and voice messages (owner 2026-11-25) ──────────────────────────
    # A GIF (picked from the phone's gallery) or a voice message recorded in the app. `text` then carries a readable
    # stand-in ("🎤 Voice message" / "🖼️ GIF") so an older app, the HR page and the phone notification still say
    # something sensible. The file is only ever served to members of the channel (chat_views.chat_message_media) and is
    # deleted from the server once `expires_at` passes (chat_media.sweep_expired, and on access); the row stays, so the
    # conversation keeps its shape and the app shows "Voice message expired".
    KIND_TEXT = "text"
    KIND_GIF = "gif"
    KIND_VOICE = "voice"
    KIND_CHOICES = [(KIND_TEXT, "Text"), (KIND_GIF, "GIF"), (KIND_VOICE, "Voice message")]

    kind = models.TextField(choices=KIND_CHOICES, default=KIND_TEXT, db_default=KIND_TEXT, db_column="kind")
    media = models.FileField(upload_to="chat_media/%Y/%m/", blank=True, default="", db_default="", db_column="media")
    media_mime = models.TextField(blank=True, default="", db_default="", db_column="media_mime")
    media_size = models.PositiveIntegerField(null=True, blank=True, db_column="media_size")
    media_duration_ms = models.PositiveIntegerField(null=True, blank=True, db_column="media_duration_ms")
    media_width = models.PositiveIntegerField(null=True, blank=True, db_column="media_width")
    media_height = models.PositiveIntegerField(null=True, blank=True, db_column="media_height")
    # a voice message's loudness bars as the phone recorded them: up to 64 numbers 0-100
    media_waveform = models.JSONField(null=True, blank=True, db_column="media_waveform")
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True, db_column="expires_at")
    media_deleted_at = models.DateTimeField(null=True, blank=True, db_column="media_deleted_at")

    class Meta:
        db_table = "chat_messages"
        ordering = ["created_at"]


class ChatReaction(models.Model):
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE, db_column="message_id", related_name="reactions")
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="chat_reactions")
    emoji = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "chat_reactions"
        unique_together = [["message", "employee", "emoji"]]


class ChatSettings(models.Model):
    """One row (owner 2026-11-25): how many days GIFs and voice messages stay in the chat before their files are
    deleted. HR changes it on the HR chat page; 7 days unless HR says otherwise."""

    MEDIA_EXPIRY_DEFAULT = 7
    MEDIA_EXPIRY_MIN = 1
    MEDIA_EXPIRY_MAX = 90

    media_expiry_days = models.PositiveSmallIntegerField(
        default=MEDIA_EXPIRY_DEFAULT, db_default=MEDIA_EXPIRY_DEFAULT, db_column="media_expiry_days"
    )
    updated_by = models.TextField(blank=True, default="", db_default="", db_column="updated_by")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "chat_settings"

    @classmethod
    def get(cls) -> "ChatSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
