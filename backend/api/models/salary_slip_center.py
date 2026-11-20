"""HR -> Payroll -> Salary Slip: the standalone salary slips (api/salary_slip_center/).

    StandaloneSalarySlip    one employee's slip for one calendar month, worked out from the employee's details, their
                            attendance and their salary details ONLY and saved when HR clicks Generate. `figures` holds
                            everything the slip, the statement and the bank file print, so a download never works the
                            month out again. Generating again replaces it.
    StandaloneSalaryHold    the page's own Hold switch, per employee per month: a held employee still gets a slip and is on
                            the statement (Remarks HOLD) but is left out of the bank file.

Owner 2026-11-20: completely independent of Staff Payroll, Production Payroll and Settlements - nothing here reads or
writes Payroll / SalarySlip rows, and nothing in payroll reads these tables.
"""

from django.db import models

from .accounts import HRUser
from .core import Employee


class StandaloneSalarySlip(models.Model):
    KIND_STAFF = "staff"
    KIND_PRODUCTION = "production"

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="+")
    month = models.PositiveSmallIntegerField()
    year = models.PositiveSmallIntegerField()
    kind = models.TextField(default=KIND_STAFF)
    slip_number = models.TextField(db_column="slip_number")
    # the whole worked-out slip (salary_slip_center/engine.py SlipResult): days, earnings, deductions, net, statement
    # columns, day-by-day calendar and notes, exactly as it was when generated
    figures = models.JSONField(default=dict)
    gross = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    deductions = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    net = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    # {"statutory": bool, "lateDeductions": bool, "advances": bool}: what HR chose to deduct when generating
    options = models.JSONField(default=dict)
    # the last day the attendance was counted to (today while the month is still running)
    counted_to = models.DateField(null=True, blank=True)
    generated_at = models.DateTimeField(auto_now=True)
    generated_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="generated_by_id", related_name="+"
    )
    generated_by_name = models.TextField(blank=True, default="")

    class Meta:
        db_table = "standalone_salary_slips"
        ordering = ["year", "month", "employee_id"]
        constraints = [
            models.UniqueConstraint(fields=["employee", "month", "year"], name="standalone_slip_employee_month"),
        ]
        indexes = [models.Index(fields=["year", "month"], name="standalone_slip_month_idx")]

    def __str__(self) -> str:
        return f"{self.slip_number} ({self.month}/{self.year})"


class StandaloneSalaryHold(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="+")
    month = models.PositiveSmallIntegerField()
    year = models.PositiveSmallIntegerField()
    reason = models.TextField(blank=True, default="")
    held_at = models.DateTimeField(auto_now=True)
    held_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="held_by_id", related_name="+"
    )
    held_by_name = models.TextField(blank=True, default="")

    class Meta:
        db_table = "standalone_salary_holds"
        ordering = ["year", "month", "employee_id"]
        constraints = [
            models.UniqueConstraint(fields=["employee", "month", "year"], name="standalone_hold_employee_month"),
        ]

    def __str__(self) -> str:
        return f"hold {self.employee_id} {self.month}/{self.year}"
