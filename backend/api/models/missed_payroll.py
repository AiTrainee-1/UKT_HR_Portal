"""HR -> Payroll -> Missed Payroll (owner 2026-11-23): payroll for the employees the regular Staff / Production Payroll
missed for a month, worked out and managed on a page of its own (api/missed_payroll/).

    MissedPayroll   one employee's missed payroll for one calendar month (staff: the month; production: the days of the
                    month no other payroll paid). `figures` is what the EXISTING payroll engine would write for them,
                    worked out in a transaction that is always rolled back (missed_payroll/engine.py), so the figures are
                    exactly the regular payroll's. Status: generated -> cleared (verified, figures frozen) -> done (the
                    figures are written into the month's Payroll + SalarySlip, `payroll`) -> paid.

Nothing here touches Payroll / SalarySlip until Done. A held salary or a parked new joiner already has a payroll row that
was kept out (`replaces`): Done replaces its figures and releases it into the month (owner decision 2026-11-23).
"""

from django.db import models

from .core import Employee
from .payroll import Payroll


class MissedPayroll(models.Model):
    KIND_STAFF = "staff"
    KIND_PRODUCTION = "production"

    STATUS_GENERATED = "generated"
    STATUS_CLEARED = "cleared"
    STATUS_DONE = "done"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [
        (STATUS_GENERATED, "Generated"),
        (STATUS_CLEARED, "Cleared"),
        (STATUS_DONE, "Done"),
        (STATUS_PAID, "Paid"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="missed_payrolls"
    )
    kind = models.TextField(default=KIND_STAFF)
    month = models.PositiveSmallIntegerField()
    year = models.PositiveSmallIntegerField()
    # why the regular payroll missed them when this was generated: not_generated | no_salary | on_hold | new_joiner |
    # not_cleared | inactive (missed_payroll/lists.py)
    category = models.TextField(blank=True, default="", db_default="")
    # the held / parked payroll row this one releases on Done (NULL: a new row is made)
    replaces = models.ForeignKey(
        Payroll, on_delete=models.SET_NULL, null=True, blank=True, db_column="replaces_payroll_id", related_name="+"
    )
    # the month's Payroll row written on Done
    payroll = models.ForeignKey(
        Payroll,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column="payroll_id",
        related_name="missed_payroll_entries",
    )
    # {"payroll": {...}, "slip": {...}, "advanceDetails": [...], "payRanges": [...], "notes": [...]} (engine.py)
    figures = models.JSONField(default=dict)
    gross = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    deductions = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    net = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_GENERATED, db_default=STATUS_GENERATED)
    generated_at = models.DateTimeField(auto_now_add=True)
    generated_by = models.TextField(blank=True, default="")
    regenerated_at = models.DateTimeField(null=True, blank=True)
    cleared_at = models.DateTimeField(null=True, blank=True)
    cleared_by = models.TextField(blank=True, default="")
    done_at = models.DateTimeField(null=True, blank=True)
    done_by = models.TextField(blank=True, default="")
    paid_at = models.DateTimeField(null=True, blank=True)
    paid_by = models.TextField(blank=True, default="")
    paid_on = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "missed_payrolls"
        constraints = [
            models.UniqueConstraint(fields=["employee", "kind", "month", "year"], name="uniq_missed_payroll_month"),
        ]
        indexes = [models.Index(fields=["kind", "year", "month"], name="missed_payroll_month_idx")]

    def __str__(self) -> str:
        return f"Missed payroll {self.employee_id} {self.year}-{self.month:02d} ({self.status})"
