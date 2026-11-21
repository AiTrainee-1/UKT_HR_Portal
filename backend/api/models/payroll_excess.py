"""Staff Payroll -> Excess tab (api/payroll_excess.py): amounts HR adds to or takes off one employee's earned salary for
one payroll month (staff) or one pay period (production), with a mandatory remark and a full history.

    PayrollExcessEntry    one amount: kind "excess" (added to the earned salary) or "detection" (taken off it). Never
                          deleted: a removed entry keeps its row with status "removed".
    PayrollExcessHistory  every add / change / remove: who, when, the previous and the new amount, the remark, and the
                          payroll NET before and after when a generated payroll was updated.

The month's active entries are what the staff payroll's `bonus` holds (excess - detection): the engine reads them on
every Generate / Generate again, and every change here updates an already generated payroll at once (owner 2026-11-20:
before, Generate again reset the bonus to 0 and HR's amounts disappeared).
"""

from django.db import models

from .accounts import HRUser
from .core import Employee


class PayrollExcessEntry(models.Model):
    KIND_EXCESS = "excess"
    KIND_DETECTION = "detection"
    KINDS = [(KIND_EXCESS, "Excess"), (KIND_DETECTION, "Detection")]

    SOURCE_MANUAL = "manual"
    SOURCE_BULK = "bulk"
    SOURCE_MIGRATED = "migrated"

    STATUS_ACTIVE = "active"
    STATUS_REMOVED = "removed"

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="+")
    # Staff: the payroll month. Production: the month the pay period ENDS in (for month filters), and the period itself
    # below (one pay cycle's period, 2026-11-20); the period fields are NULL on a staff entry.
    month = models.PositiveSmallIntegerField()
    year = models.PositiveSmallIntegerField()
    pay_cycle = models.TextField(null=True, blank=True)
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    kind = models.TextField(choices=KINDS)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    remark = models.TextField()
    source = models.TextField(default=SOURCE_MANUAL)
    status = models.TextField(default=STATUS_ACTIVE)
    created_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="created_by_id", related_name="+"
    )
    created_by_name = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="updated_by_id", related_name="+"
    )
    updated_by_name = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "payroll_excess_entries"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["year", "month", "status"], name="payroll_excess_month_idx"),
            models.Index(fields=["employee", "year", "month"], name="payroll_excess_emp_idx"),
            models.Index(fields=["period_start", "period_end"], name="payroll_excess_period_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.amount} emp {self.employee_id} {self.month}/{self.year}"


class PayrollExcessHistory(models.Model):
    ACTION_ADDED = "added"
    ACTION_CHANGED = "changed"
    ACTION_REMOVED = "removed"

    entry = models.ForeignKey(
        PayrollExcessEntry, on_delete=models.CASCADE, db_column="entry_id", related_name="history"
    )
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="+")
    month = models.PositiveSmallIntegerField()
    year = models.PositiveSmallIntegerField()
    pay_cycle = models.TextField(null=True, blank=True)
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    kind = models.TextField()
    action = models.TextField()
    previous_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    new_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    remark = models.TextField()
    source = models.TextField(default=PayrollExcessEntry.SOURCE_MANUAL)
    actor = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="actor_id", related_name="+"
    )
    actor_name = models.TextField(blank=True, default="")
    at = models.DateTimeField(auto_now_add=True)
    # the month's staff payroll NET before and after this action (null: no generated payroll was touched)
    payroll_net_before = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    payroll_net_after = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)

    class Meta:
        db_table = "payroll_excess_history"
        ordering = ["-at", "-id"]
        indexes = [models.Index(fields=["year", "month"], name="payroll_excess_hist_month_idx")]

    def __str__(self) -> str:
        return f"{self.action} {self.kind} emp {self.employee_id} {self.month}/{self.year}"
