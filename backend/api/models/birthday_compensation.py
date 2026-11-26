"""Birthday Compensation on a chosen date (owner brief 2026-11-25, migration 0186).

A birthday a staff member WORKED (present or half day, under the new birthday rule) gives them 1.00 day of Birthday
Compensation to place on dates of the BIRTHDAY MONTH that they (or HR for them) choose: a full day, or a first / second half
(two halves may go on two different dates). Each placement is one BirthdayCompensationUse row, decided by the employee's
Department Head and then HR (approval workflow ``birthday_compensation``, a fixed pipeline). Once approved, the attendance
engine pays that day (or half) like a Casual Leave pays (compensation_engine.CompContext.birthday_uses ->
attendance_final.compute_day_record). The rules live in birthday_compensation.py, the writes in
birthday_compensation_service.py.

A waiting (pending) or approved use holds its part of the 1.00; a rejected or withdrawn one frees it. Unused compensation
lapses when the birthday month ends. The database refuses two open (pending / approved) uses of the same half of one date
for one employee (a full day covers both halves): uniq_bday_use_first_half / uniq_bday_use_second_half.
"""

from decimal import Decimal

from django.db import models

from .core import Employee

OPEN_STATUSES = ("pending", "approved")


class BirthdayCompensationUse(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_WITHDRAWN = "withdrawn"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_WITHDRAWN, "Withdrawn"),
    ]
    OPEN_STATUSES = OPEN_STATUSES

    PORTION_FULL = "full"
    PORTION_FIRST_HALF = "first_half"
    PORTION_SECOND_HALF = "second_half"
    PORTION_CHOICES = [
        (PORTION_FULL, "Full day"),
        (PORTION_FIRST_HALF, "First half"),
        (PORTION_SECOND_HALF, "Second half"),
    ]
    PORTION_DAYS = {
        PORTION_FULL: Decimal("1.00"),
        PORTION_FIRST_HALF: Decimal("0.50"),
        PORTION_SECOND_HALF: Decimal("0.50"),
    }

    RAISED_BY_EMPLOYEE = "employee"
    RAISED_BY_HR = "hr"
    RAISED_BY_CHOICES = [(RAISED_BY_EMPLOYEE, "Employee"), (RAISED_BY_HR, "HR")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="birthday_compensation_uses"
    )
    birthday = models.DateField(db_column="birthday")  # the birthday (celebrated date) the compensation comes from
    use_date = models.DateField(db_column="use_date")  # the day it is placed on (always in the birthday's month)
    portion = models.TextField(choices=PORTION_CHOICES, default=PORTION_FULL)
    days = models.DecimalField(max_digits=3, decimal_places=2)  # 1.00 for a full day, 0.50 for a half
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    reason = models.TextField(blank=True, default="")
    raised_by_role = models.TextField(choices=RAISED_BY_CHOICES, default=RAISED_BY_EMPLOYEE)
    requested_by = models.TextField(blank=True, default="")  # the name of whoever raised it (employee or HR user)
    # The approval pipeline's progress (approval_workflow.py): [{role, decision, by, at, comment, skipped}].
    approval_trail = models.JSONField(null=True, blank=True)
    hod_reviewed_by = models.TextField(null=True, blank=True)
    hod_reviewed_at = models.DateTimeField(null=True, blank=True)
    hod_review_comment = models.TextField(null=True, blank=True)
    hr_reviewed_by = models.TextField(null=True, blank=True)
    hr_reviewed_at = models.DateTimeField(null=True, blank=True)
    hr_review_comment = models.TextField(null=True, blank=True)
    withdrawn_by = models.TextField(null=True, blank=True)
    withdrawn_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "birthday_compensation_uses"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["employee", "birthday"], name="bday_use_emp_birthday"),
            models.Index(fields=["use_date", "status"], name="bday_use_date_status"),
        ]
        constraints = [
            # one open use of each half of a date per employee: a full day covers both halves, so it conflicts with any
            # other open use of that date, and two halves of one date (first + second) are allowed
            models.UniqueConstraint(
                fields=["employee", "use_date"],
                condition=models.Q(status__in=OPEN_STATUSES, portion__in=["full", "first_half"]),
                name="uniq_bday_use_first_half",
            ),
            models.UniqueConstraint(
                fields=["employee", "use_date"],
                condition=models.Q(status__in=OPEN_STATUSES, portion__in=["full", "second_half"]),
                name="uniq_bday_use_second_half",
            ),
            models.CheckConstraint(
                condition=models.Q(days__in=[Decimal("1.00"), Decimal("0.50")]), name="bday_use_days_full_or_half"
            ),
        ]

    def __str__(self) -> str:
        return f"Birthday compensation {self.employee_id} {self.use_date} {self.portion} ({self.status})"
