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
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

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
