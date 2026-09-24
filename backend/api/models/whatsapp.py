"""WhatsApp (Gupshup) send log, templates and media assets."""

from django.db import models

from .accounts import HRUser
from .core import Employee


class WhatsAppMessageLog(models.Model):
    """
    One row per WhatsApp document send attempt (single or bulk), success or
    failure -shared across every document type instead of adding a parallel
    whatsapp_sent_at column to SalarySlip/Employee/etc., mirroring how
    emailed_at is shown per-document today but centralized so any list view
    can look up "was this ever sent via WhatsApp" with one join, and bulk
    sends can report exactly who failed and why.
    """
    DOCUMENT_TYPES = (
        ("salary_slip", "Salary Slip"),
        ("id_card", "ID Card"),
        ("offer_letter", "Offer Letter"),
        ("experience_letter", "Experience Letter"),
        ("resignation_letter", "Resignation Letter"),
        ("other", "Other Document"),
        # Not a document at all -a plain text "you have a visitor" alert (see
        # whatsapp_service.send_text / outpass_visitor_views.py::
        # _notify_visitor_whatsapp). Reuses this table's existing
        # per-purpose template config + send-audit mechanism rather than
        # building a parallel one just because it has no attachment.
        ("visitor_notification", "Visitor Notification"),
    )

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="whatsapp_messages",
    )
    document_type = models.TextField(choices=DOCUMENT_TYPES, db_column="document_type")
    # e.g. SalarySlip.id / EmployeeDocument.id, when the document is a
    # specific existing record rather than generated fresh (ID Card).
    document_ref_id = models.IntegerField(null=True, blank=True, db_column="document_ref_id")
    phone_number = models.TextField(db_column="phone_number")
    status = models.TextField(default="sent", db_column="status")  # "sent" | "failed"
    gupshup_message_id = models.TextField(blank=True, default="", db_column="gupshup_message_id")
    error_message = models.TextField(blank=True, default="", db_column="error_message")
    sent_by = models.ForeignKey(
        HRUser, null=True, blank=True, on_delete=models.SET_NULL,
        db_column="sent_by_id", related_name="whatsapp_messages_sent",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "whatsapp_message_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["employee", "document_type"]),
        ]


class WhatsAppMessageTemplate(models.Model):
    """
    Per-document-type Gupshup message template configuration, editable from
    Settings -> WhatsApp. This is business configuration, not a secret (the
    actual API credentials stay .env-only, see settings.GUPSHUP_*) -it just
    records which pre-approved Gupshup template ID to use for each document
    type, since WhatsApp requires every business-initiated message to use a
    template that has already been reviewed and approved -the template's
    wording itself can't be freely edited here, only which approved template
    gets used and a human-readable note on what its {{n}} variables mean,
    for HR's reference. No language field: unlike Meta's Cloud API (one
    template name shared across language variants, language picked at send
    time), a Gupshup template ID already refers to one specific approved
    language variant.
    """
    document_type = models.TextField(unique=True, db_column="document_type")
    gupshup_template_id = models.TextField(blank=True, default="", db_column="gupshup_template_id")
    variable_note = models.TextField(
        blank=True, default="", db_column="variable_note",
        help_text="Human-readable note on what each {{n}} in the template maps to, e.g. '{{1}}=employee name, {{2}}=month/year'.",
    )
    is_enabled = models.BooleanField(default=False, db_column="is_enabled")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "whatsapp_message_template"


class WhatsAppMediaAsset(models.Model):
    """
    Short-lived, token-addressed blob store so a document/image WhatsApp
    template message can be sent via Gupshup. Unlike Meta's Cloud API (which
    accepts a direct media upload and hands back a media_id), Gupshup's
    Access API only accepts a *public URL* it fetches the file from -see
    whatsapp_service.send_document. Every generated PDF/PNG is written here
    just before sending, exposed read-only at GET /api/whatsapp/media/<token>
    (whatsapp_views.whatsapp_media, no auth -Gupshup's servers fetch it),
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
