"""The MD portal's AI assistant: its settings, the conversations it holds and what it has used today.

None of this is company data. The assistant READS company data through read-only tools (md_portal/assistant); what is
stored here is only its own bookkeeping: how it is configured, the MD's questions and its answers (so a conversation
survives a page change or a reload and the answer's explanation can be shown again), and a per-day request counter so
the free Gemini quota can be watched. The Gemini API key is NEVER stored here (it lives in the server's environment).
"""

from django.db import models

from .accounts import HRUser


class MdAssistantSettings(models.Model):
    """One row (pk=1): how the assistant behaves. Edited by the super administrator in Account Management."""

    enabled = models.BooleanField(default=True, db_default=True)
    # Model ids drift (Google retires and renames them), so they are settings, not code. The fallbacks are tried in
    # order when the first model is unavailable or its daily quota is used up.
    model = models.TextField(default="gemini-3.5-flash-lite", db_default="gemini-3.5-flash-lite")
    fallback_models = models.TextField(
        default="gemini-3.1-flash-lite,gemini-3.8-flash",
        db_default="gemini-3.1-flash-lite,gemini-3.8-flash",
        blank=True,
        db_column="fallback_models",
    )
    thinking_level = models.TextField(default="low", db_default="low", db_column="thinking_level")
    # Replace employee names with tokens before anything is sent to Gemini (and put the names back for the MD).
    privacy_mode = models.BooleanField(default=True, db_default=True, db_column="privacy_mode")
    max_tool_rounds = models.IntegerField(default=5, db_default=5, db_column="max_tool_rounds")
    requests_per_minute = models.IntegerField(default=8, db_default=8, db_column="requests_per_minute")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")
    updated_by = models.TextField(null=True, blank=True, db_column="updated_by")

    class Meta:
        db_table = "md_assistant_settings"

    @classmethod
    def load(cls) -> "MdAssistantSettings":
        """The settings row, created with the defaults on first use."""
        row, _ = cls.objects.get_or_create(pk=1)
        return row


class MdConversation(models.Model):
    user = models.ForeignKey(HRUser, on_delete=models.CASCADE, db_column="user_id", related_name="md_conversations")
    title = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "md_conversations"
        indexes = [models.Index(fields=["user", "-updated_at"])]


class MdMessage(models.Model):
    ROLE_USER = "user"
    ROLE_ASSISTANT = "assistant"
    STATUS_PENDING = "pending"
    STATUS_RUNNING = "running"
    STATUS_DONE = "done"
    STATUS_ERROR = "error"

    conversation = models.ForeignKey(
        MdConversation, on_delete=models.CASCADE, db_column="conversation_id", related_name="messages"
    )
    role = models.TextField()
    # An assistant message is created `pending` when the question arrives and is the "job": a background thread works
    # on it (running), fills `content` and `payload` and ends it `done` (or `error`). The browser polls it.
    status = models.TextField(default=STATUS_DONE, db_default=STATUS_DONE)
    content = models.TextField(blank=True, default="")
    # Everything beyond the text: spoken summary, the steps and data behind the answer, assumptions, confidence, page
    # suggestions, follow-ups, live progress while running.
    payload = models.JSONField(default=dict, blank=True)
    input_mode = models.TextField(default="text", db_default="text", db_column="input_mode")  # text | voice
    language = models.TextField(null=True, blank=True)
    page_context = models.JSONField(null=True, blank=True, db_column="page_context")
    model_used = models.TextField(null=True, blank=True, db_column="model_used")
    error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    started_at = models.DateTimeField(null=True, blank=True, db_column="started_at")
    finished_at = models.DateTimeField(null=True, blank=True, db_column="finished_at")

    class Meta:
        db_table = "md_messages"
        ordering = ["id"]
        indexes = [models.Index(fields=["conversation", "id"])]


class MdAssistantUsage(models.Model):
    """Gemini requests made per model per day. The day is the PACIFIC date, because that is when Google resets the
    free-tier daily quota, so "requests today" here matches what Google counts."""

    day = models.DateField()
    model = models.TextField()
    requests = models.IntegerField(default=0, db_default=0)
    prompt_tokens = models.BigIntegerField(default=0, db_default=0, db_column="prompt_tokens")
    output_tokens = models.BigIntegerField(default=0, db_default=0, db_column="output_tokens")
    rate_limited = models.IntegerField(default=0, db_default=0, db_column="rate_limited")
    daily_limit_hit = models.BooleanField(default=False, db_default=False, db_column="daily_limit_hit")

    class Meta:
        db_table = "md_assistant_usage"
        constraints = [models.UniqueConstraint(fields=["day", "model"], name="uniq_md_usage_day_model")]
