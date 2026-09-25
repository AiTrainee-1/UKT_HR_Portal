"""Document/ID-card settings, stored files and backups."""

from datetime import time
from django.db import models


class FileBlob(models.Model):
    """Backing store for api.db_file_storage.HybridFileStorage.

    Every FileField in this app (geo-punch selfies, recruitment resumes,
    employee documents) is unmodified -it still calls .save()/.open()/
    .read()/.delete() exactly as before. Only the storage backend those calls
    resolve to has changed: new uploads now write here, in Postgres, instead
    of the local disk Railway wipes on every redeploy. `name` is the exact
    value Django's FileField already used as a relative path
    (e.g. "resumes/2026/09/resume_ab12c3.pdf"), so it lines up 1:1 with what
    each FileField's `.name` stores -nothing about that naming changed either.

    Files that existed on local disk before this shipped are deliberately
    NOT migrated here -HybridFileStorage falls back to reading them from
    disk, so they keep working exactly as they did. This table only ever
    gains rows for files uploaded from now on.
    """

    name = models.TextField(unique=True, db_column="name")
    content = models.BinaryField(db_column="content")
    content_type = models.TextField(blank=True, default="", db_column="content_type")
    size = models.BigIntegerField(default=0, db_column="size")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "file_blobs"

    def __str__(self):
        return f"{self.name} ({self.size} bytes)"


# ──────────────────────────────────────────────
#  Employee ID Card Template Settings
# ──────────────────────────────────────────────

class IdCardSettings(models.Model):
    """Singleton -always fetch/update the row with pk=1."""

    primary_color = models.TextField(default="#006496", db_column="primary_color")
    secondary_color = models.TextField(default="#4FB8F0", db_column="secondary_color")
    text_color = models.TextField(default="#0f172a", db_column="text_color")
    font_family = models.TextField(default="Hanken Grotesk", db_column="font_family")
    background_style = models.TextField(default="gradient", db_column="background_style")  # gradient | solid | pattern
    logo_position = models.TextField(default="left", db_column="logo_position")  # left | center
    corner_style = models.TextField(default="rounded", db_column="corner_style")  # rounded | sharp
    show_qr_on_back = models.BooleanField(default=True, db_column="show_qr_on_back")
    footer_text = models.TextField(blank=True, default="", db_column="footer_text")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "idcard_settings"

    @classmethod
    def get(cls) -> "IdCardSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


# ──────────────────────────────────────────────
#  Company Documents (Offer Letter / Experience Letter / Salary Slip)
# ──────────────────────────────────────────────

class CompanyDocumentSettings(models.Model):
    """One row per document type -fetch/update via `.get(doc_type)`."""

    DOC_TYPE_OFFER_LETTER = "offer_letter"
    DOC_TYPE_EXPERIENCE_LETTER = "experience_letter"
    DOC_TYPE_SALARY_SLIP = "salary_slip"
    DOC_TYPE_RESIGNATION_LETTER = "resignation_letter"
    DOC_TYPES = [
        (DOC_TYPE_OFFER_LETTER, "Offer Letter"),
        (DOC_TYPE_EXPERIENCE_LETTER, "Experience Letter"),
        (DOC_TYPE_SALARY_SLIP, "Salary Slip"),
        (DOC_TYPE_RESIGNATION_LETTER, "Resignation Letter"),
    ]

    doc_type = models.TextField(unique=True, choices=DOC_TYPES, db_column="doc_type")
    primary_color = models.TextField(default="#0E4B3A", db_column="primary_color")   # emerald
    accent_color = models.TextField(default="#C9A227", db_column="accent_color")     # gold
    heading_style = models.TextField(default="serif", db_column="heading_style")     # serif | sans
    show_watermark = models.BooleanField(default=True, db_column="show_watermark")
    footer_tagline = models.TextField(blank=True, default="Weaving Quality. Building Trust.", db_column="footer_tagline")
    # Optional override -falls back to PayrollSettings.company_logo when blank.
    logo_override = models.TextField(null=True, blank=True, db_column="logo_override")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "company_document_settings"

    @classmethod
    def get(cls, doc_type: str) -> "CompanyDocumentSettings":
        obj, _ = cls.objects.get_or_create(doc_type=doc_type)
        return obj


# ──────────────────────────────────────────────
#  Full application backup -scheduling + optional Google Drive offsite copy
# ──────────────────────────────────────────────

class BackupSchedule(models.Model):
    """Singleton -always fetch/update the row with pk=1. Mirrors
    AutoSyncRule's shape (see auto_sync.py) for the scheduler."""

    is_enabled = models.BooleanField(default=False)
    # A real time object, not the string "02:00" -on the very first
    # get_or_create() for this singleton (e.g. right after a fresh migrate or
    # a `manage.py flush`), Django assigns the field default to the in-memory
    # instance without a DB round-trip, so a string default would stay a
    # string on that first call, crashing the first backup_status request
    # with "'str' object has no attribute 'strftime'".
    time = models.TimeField(default=time(2, 0), help_text="Time of day (Asia/Kolkata) this fires")
    # Cron-compatible day-of-week string, e.g. "*" (every day) or "mon,tue,wed,thu,fri".
    days_of_week = models.TextField(default="*")
    # Oldest local backups beyond this count are pruned after a successful run.
    retention_count = models.IntegerField(default=14)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_run_status = models.TextField(null=True, blank=True)
    last_run_summary = models.TextField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "backup_schedule"

    @classmethod
    def get(cls) -> "BackupSchedule":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class BackupDriveConfig(models.Model):
    """Singleton -optional Google Drive upload destination for backups.
    Local storage is always the primary/default copy; this is purely an
    extra offsite copy of the same backup file, uploaded after it's already
    written locally."""

    is_enabled = models.BooleanField(default=False)
    folder_id = models.TextField(blank=True, default="")
    # Plaintext service-account JSON key -same convention as
    # PayrollSettings.smtp_password already used in this codebase.
    service_account_json = models.TextField(blank=True, default="")
    last_upload_at = models.DateTimeField(null=True, blank=True)
    last_upload_status = models.TextField(null=True, blank=True)
    last_upload_summary = models.TextField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "backup_drive_config"

    @classmethod
    def get(cls) -> "BackupDriveConfig":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class MobileAppVersion(models.Model):
    """One released build of the employee mobile app, published by HR.

    HR exports the APK, uploads it somewhere it can be downloaded from (a Google
    Drive share link is the usual choice) and records the version and link here.
    The app asks GET /api/mobile-app/latest-version on start-up and whenever it
    returns to the foreground, and shows a "New Version Available" prompt when
    the newest active version here is higher than the build it is running.

    The APK itself is deliberately NOT stored in this database: builds are tens
    of megabytes, the API host can have a disk that is wiped on every deploy,
    and a plain link works with whatever HR already uses to share files.

    `version` is a dotted number ("3.0.0"), compared numerically -see
    api.mobile_app_version_views.parse_version. `is_mandatory` makes the prompt
    impossible to dismiss; `is_active` is HR's way to withdraw a build without
    deleting its record.
    """

    platform = models.TextField(default="android", db_column="platform")
    version = models.TextField(db_column="version")
    download_url = models.TextField(db_column="download_url")
    release_notes = models.TextField(blank=True, default="", db_column="release_notes")
    is_mandatory = models.BooleanField(default=True, db_column="is_mandatory")
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_by = models.TextField(null=True, blank=True, db_column="created_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "mobile_app_versions"
        constraints = [
            models.UniqueConstraint(fields=["platform", "version"], name="uniq_mobile_app_version_per_platform"),
        ]
