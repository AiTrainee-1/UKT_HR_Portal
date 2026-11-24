"""Employee enquiries (owner 2026-11-24): questions an employee raises from the mobile app, handled by HR as a to-do list."""

from django.db import models

from .core import Employee


class Enquiry(models.Model):
    """
    A question / concern an employee raised from the mobile app ("Enquiries", which replaced "Ask HR"). HR works through
    them on the HR portal's Enquiries page like a to-do list: Pending -> On Hold -> Done, with a reply the employee reads.

    Not an approval request: nothing is approved or rejected and no workflow runs. Every status change or reply is kept in
    `history` and pushed to the employee's phone (enquiry_views.update_enquiry).
    """

    STATUS_PENDING = "pending"
    STATUS_ON_HOLD = "on_hold"
    STATUS_DONE = "done"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_ON_HOLD, "On Hold"), (STATUS_DONE, "Done")]

    CATEGORY_CHOICES = [
        ("general", "General question"),
        ("salary", "Salary & deductions"),
        ("attendance", "Attendance & shift"),
        ("leave", "Leave & holidays"),
        ("documents", "Documents & letters"),
        ("other", "Something else"),
    ]

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="enquiries")
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, default="general", db_column="category")
    subject = models.CharField(max_length=200, db_column="subject")
    message = models.TextField(blank=True, default="", db_column="message")
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_PENDING, db_column="status")
    # HR's latest reply (what the employee reads), who last changed it and when.
    hr_reply = models.TextField(blank=True, default="", db_column="hr_reply")
    handled_by = models.TextField(blank=True, default="", db_column="handled_by")
    handled_at = models.DateTimeField(null=True, blank=True, db_column="handled_at")
    done_at = models.DateTimeField(null=True, blank=True, db_column="done_at")
    # [{at, by, status, reply}] every change HR made, oldest first.
    history = models.JSONField(default=list, blank=True, db_column="history")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employee_enquiries"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "created_at"]), models.Index(fields=["employee", "created_at"])]
