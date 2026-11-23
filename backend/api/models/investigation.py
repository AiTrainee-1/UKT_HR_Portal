"""Employees -> Investigation (owner 2026-11-23): employees who keep not coming to the company (api/investigation/).

InvestigationSettings   one row: the nightly Auto Trigger switch (on by default) and what its last run did.
EmployeeInvestigation   every decision about an employee's absence: marked inactive from the 15 / 30 Days lists,
                        inactivated by the Auto Trigger, kept active (with the reason HR gave), or made active again.
                        `spell_start` is the first day of the absence the decision is about: a Keep active holds only
                        for that absence - once the employee attends again, a later absence starts fresh.
"""

from django.db import models

from .core import Employee


class InvestigationSettings(models.Model):
    auto_enabled = models.BooleanField(default=True, db_default=True)
    # the Auto Trigger inactivates after MORE than this many days away (owner brief: "more than 30 days")
    auto_days = models.PositiveSmallIntegerField(default=30, db_default=30)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_run_summary = models.JSONField(default=dict, blank=True)
    updated_by = models.TextField(blank=True, default="", db_default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "employee_investigation_settings"

    @classmethod
    def get(cls) -> "InvestigationSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class EmployeeInvestigation(models.Model):
    ACTION_INACTIVATED = "inactivated"
    ACTION_AUTO = "auto_inactivated"
    ACTION_KEPT = "kept_active"
    ACTION_REACTIVATED = "reactivated"
    ACTION_CHOICES = [
        (ACTION_INACTIVATED, "Marked inactive"),
        (ACTION_AUTO, "Inactivated by the Auto Trigger"),
        (ACTION_KEPT, "Kept active"),
        (ACTION_REACTIVATED, "Made active again"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="investigations"
    )
    action = models.TextField(choices=ACTION_CHOICES)
    spell_start = models.DateField(null=True, blank=True)  # the first day away of the absence this is about
    last_attended = models.DateField(null=True, blank=True)
    absent_days = models.PositiveIntegerField(default=0)  # days away counted (no-data days of the unit left out)
    calendar_days = models.PositiveIntegerField(default=0)  # every day since the last attended day
    bucket = models.TextField(blank=True, default="")  # "15" | "30" | "auto": where it was decided
    reason = models.TextField(blank=True, default="")
    by = models.TextField(blank=True, default="")
    at = models.DateTimeField(auto_now_add=True)
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "employee_investigations"
        indexes = [models.Index(fields=["employee", "-at"], name="emp_investigation_emp_at_idx")]
        ordering = ["-at", "-id"]
