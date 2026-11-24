"""Settings -> Auto-Reject Requests (owner 2026-11-24): requests nobody decided within N days of being submitted are rejected
automatically every night (api/request_auto_reject/). Resignations are never rejected automatically.

RequestAutoRejectSettings   one row: the switch (on by default), the number of days (45 by default) and what the last run did.
AutoRejectedRequest         every request the automatic rejection rejected: which request, whose, what was asked, when it
                            was submitted and how long it had waited, the remark the employee read, who ran it (the nightly
                            run, or the HR user who pressed Run now) and what else the rejection did (punches voided, an
                            attendance write skipped because the day's payroll is finalized ...).
"""

from django.db import models

from .core import Employee


class RequestAutoRejectSettings(models.Model):
    DAYS_DEFAULT = 45
    DAYS_MIN = 7
    DAYS_MAX = 365

    enabled = models.BooleanField(default=True, db_default=True)
    # a request is rejected once MORE than this many days have passed since the India day it was submitted
    days = models.PositiveSmallIntegerField(default=DAYS_DEFAULT, db_default=DAYS_DEFAULT)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_run_by = models.TextField(blank=True, default="", db_default="")  # "" = the nightly run
    last_run_result = models.JSONField(default=dict, blank=True)
    updated_by = models.TextField(blank=True, default="", db_default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "request_auto_reject_settings"

    @classmethod
    def get(cls) -> "RequestAutoRejectSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class AutoRejectedRequest(models.Model):
    TRIGGER_NIGHTLY = "nightly"
    TRIGGER_RUN_NOW = "run_now"
    TRIGGER_CHOICES = [(TRIGGER_NIGHTLY, "Nightly run"), (TRIGGER_RUN_NOW, "Run now")]

    kind = models.TextField()  # the approval workflow key: leave, permission, casual_leave, ... (never resignation)
    request_id = models.IntegerField()
    employee = models.ForeignKey(
        Employee,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column="employee_id",
        related_name="auto_rejected_requests",
    )
    # as they were when the request was rejected (the employee row may change or go later)
    employee_code = models.TextField(blank=True, default="")
    employee_name = models.TextField(blank=True, default="")
    # the branch the request is listed under (the Requests hub's scope: the employee's, an On-Duty request's own)
    branch_id = models.IntegerField(null=True, blank=True)
    what = models.TextField(blank=True, default="")  # "Casual Leave", "Missing Punch · Check-in" ...
    summary = models.TextField(blank=True, default="")  # "2026-10-03", "2026-10-03 at 09:05 · Check-in" ...
    submitted_at = models.DateTimeField()
    days_waited = models.PositiveIntegerField(default=0)
    days_setting = models.PositiveSmallIntegerField(default=RequestAutoRejectSettings.DAYS_DEFAULT)
    remark = models.TextField(blank=True, default="")
    trigger = models.TextField(choices=TRIGGER_CHOICES, default=TRIGGER_NIGHTLY)
    run_by = models.TextField(blank=True, default="")  # the HR user who pressed Run now; "" for the nightly run
    rejected_at = models.DateTimeField(auto_now_add=True)
    effects = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "auto_rejected_requests"
        ordering = ["-rejected_at", "-id"]
        indexes = [
            models.Index(fields=["-rejected_at"], name="auto_rejected_at_idx"),
            models.Index(fields=["kind", "request_id"], name="auto_rejected_kind_req_idx"),
        ]
