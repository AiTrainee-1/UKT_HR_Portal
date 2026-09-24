"""Shifts, leave, holidays and employee requests."""

from django.db import models

from .core import Branch, Department, Employee


# ──────────────────────────────────────────────
#  Shift Management
# ──────────────────────────────────────────────

class ShiftTemplate(models.Model):
    SHIFT_TYPE_PRODUCTION = "production"
    SHIFT_TYPE_STAFF = "staff"
    SHIFT_TYPES = [(SHIFT_TYPE_PRODUCTION, "Production"), (SHIFT_TYPE_STAFF, "Staff")]
    GENDER_RULE_ALL = "all"
    GENDER_RULE_MALE = "male"
    GENDER_RULE_FEMALE = "female"
    GENDER_RULES = [
        (GENDER_RULE_ALL, "All"),
        (GENDER_RULE_MALE, "Male Only"),
        (GENDER_RULE_FEMALE, "Female Only"),
    ]

    name = models.TextField()
    # Each branch runs its own shifts -timings differ by unit, so a shared
    # template list meant one branch's edit silently changed another's
    # attendance. Nullable: templates that predate this column belong to no
    # branch and are visible to unscoped admins only.
    branch = models.ForeignKey(
        "Branch", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="shift_templates",
    )
    shift_type = models.TextField(choices=SHIFT_TYPES, default=SHIFT_TYPE_STAFF, db_column="shift_type")
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    gender_rule = models.TextField(choices=GENDER_RULES, default=GENDER_RULE_ALL, db_column="gender_rule")
    grace_period_minutes = models.IntegerField(default=15, db_column="grace_period_minutes")
    # Staff-only: 4-punch day structure (null on production shifts)
    first_half_end = models.TimeField(null=True, blank=True, db_column="first_half_end")
    lunch_duration_minutes = models.IntegerField(default=60, db_column="lunch_duration_minutes")
    lunch_grace_minutes = models.IntegerField(default=10, db_column="lunch_grace_minutes")
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="shifts"
    )
    is_default = models.BooleanField(default=False, db_column="is_default")
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "shift_templates"


class EmployeeShiftAssignment(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="shift_assignments"
    )
    shift = models.ForeignKey(
        ShiftTemplate, on_delete=models.CASCADE, db_column="shift_id", related_name="assignments"
    )
    effective_from = models.DateField(db_column="effective_from")
    effective_to = models.DateField(null=True, blank=True, db_column="effective_to")
    assigned_by = models.TextField(null=True, blank=True, db_column="assigned_by")
    notes = models.TextField(null=True, blank=True)
    # Per-employee schedule overrides (only set when individual differs from shift template)
    custom_start_time = models.TimeField(null=True, blank=True, db_column="custom_start_time")
    custom_end_time = models.TimeField(null=True, blank=True, db_column="custom_end_time")
    saturday_off = models.BooleanField(default=False, db_column="saturday_off")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "employee_shift_assignments"


# ──────────────────────────────────────────────
#  Leave & Holiday
# ──────────────────────────────────────────────

class LeaveType(models.Model):
    name = models.TextField()
    code = models.TextField(unique=True)  # CL, SL, EL, ML, PL
    max_days_per_year = models.IntegerField(default=12, db_column="max_days_per_year")
    carry_forward = models.BooleanField(default=False, db_column="carry_forward")
    max_carry_forward_days = models.IntegerField(default=0, db_column="max_carry_forward_days")
    is_paid = models.BooleanField(default=True, db_column="is_paid")
    applicable_gender = models.TextField(default="all", db_column="applicable_gender")  # all/male/female
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "leave_types"


class LeaveBalance(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="leave_balances"
    )
    leave_type = models.ForeignKey(
        LeaveType, on_delete=models.CASCADE, db_column="leave_type_id", related_name="balances"
    )
    year = models.IntegerField()
    allocated = models.DecimalField(max_digits=5, decimal_places=1, default=0)
    used = models.DecimalField(max_digits=5, decimal_places=1, default=0)
    remaining = models.DecimalField(max_digits=5, decimal_places=1, default=0)
    carried_forward = models.DecimalField(max_digits=5, decimal_places=1, default=0, db_column="carried_forward")

    class Meta:
        db_table = "leave_balances"
        unique_together = [("employee", "leave_type", "year")]


class Holiday(models.Model):
    HOLIDAY_TYPE_NATIONAL = "national"
    HOLIDAY_TYPE_REGIONAL = "regional"
    HOLIDAY_TYPE_COMPANY = "company"
    HOLIDAY_TYPES = [
        (HOLIDAY_TYPE_NATIONAL, "National"),
        (HOLIDAY_TYPE_REGIONAL, "Regional"),
        (HOLIDAY_TYPE_COMPANY, "Company"),
    ]

    name = models.TextField()
    date = models.DateField()
    holiday_type = models.TextField(choices=HOLIDAY_TYPES, default=HOLIDAY_TYPE_NATIONAL, db_column="holiday_type")
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="holidays"
    )
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="holidays"
    )
    is_recurring = models.BooleanField(default=False, db_column="is_recurring")
    description = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "holidays"


# ──────────────────────────────────────────────
#  Leave Requests (enhanced)
# ──────────────────────────────────────────────

class LeaveRequest(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="leave_requests"
    )
    leave_type_ref = models.ForeignKey(
        LeaveType, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="leave_type_ref_id", related_name="requests"
    )
    type = models.TextField(default="casual")
    start_date = models.TextField(db_column="start_date")
    end_date = models.TextField(db_column="end_date")
    total_days = models.DecimalField(max_digits=4, decimal_places=1, default=1, db_column="total_days")
    # Half-Day Leave -start_date == end_date whenever this is set (enforced in
    # views.py::_leave_requests_create), total_days is always 0.5. Otherwise
    # this is a normal (possibly multi-day) leave request, unaffected.
    is_half_day = models.BooleanField(default=False, db_column="is_half_day")
    HALF_DAY_MORNING = "morning"
    HALF_DAY_AFTERNOON = "afternoon"
    HALF_DAY_CHOICES = [
        (HALF_DAY_MORNING, "Morning (First Half)"), (HALF_DAY_AFTERNOON, "Afternoon (Second Half)"),
    ]
    half_day_slot = models.TextField(choices=HALF_DAY_CHOICES, null=True, blank=True, db_column="half_day_slot")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(default="pending")  # pending/approved/rejected
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approver_role = models.TextField(null=True, blank=True, db_column="approver_role")  # "hr" | "dept_head"
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "leave_requests"


# ──────────────────────────────────────────────
#  Employee Requests (from mobile app)
# ──────────────────────────────────────────────

class EmployeeRequest(models.Model):
    REQUEST_TYPES = [
        ("leave", "Leave Request"),
        ("salary_enquiry", "Salary Enquiry"),
        ("shift_correction", "Shift Correction"),
        ("advance", "Advance Request"),
        ("permission", "Permission Request"),
        ("general", "General Query"),
    ]
    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("in_review", "In Review"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
        ("more_info", "More Info Needed"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="requests"
    )
    request_type = models.TextField(choices=REQUEST_TYPES, db_column="request_type")
    subject = models.TextField()
    description = models.TextField()
    status = models.TextField(choices=STATUS_CHOICES, default="pending")
    hr_notes = models.TextField(null=True, blank=True, db_column="hr_notes")
    handled_by = models.TextField(null=True, blank=True, db_column="handled_by")
    handled_at = models.DateTimeField(null=True, blank=True, db_column="handled_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employee_requests"


# ──────────────────────────────────────────────
#  Employee Permissions
# ──────────────────────────────────────────────

class EmployeePermission(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    TYPE_EARLY_OUT = "Early Out"
    TYPE_LATE_IN = "Late In"
    TYPE_SHORT_LEAVE = "Short Leave"
    TYPE_CHOICES = [
        (TYPE_EARLY_OUT, "Early Out"),
        (TYPE_LATE_IN, "Late In"),
        (TYPE_SHORT_LEAVE, "Short Leave"),
    ]

    DURATION_CHOICES = [(30, "30 minutes"), (45, "45 minutes"), (60, "60 minutes"), (90, "90 minutes")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE,
        db_column="employee_id", related_name="permissions"
    )
    date = models.DateField()
    permission_time = models.TimeField(null=True, blank=True, db_column="permission_time")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    # What kind of permission this is (arriving late / leaving early / a
    # short leave mid-shift) and how long the employee expects to be away —
    # both purely descriptive, shown on the request and its approval card.
    # Neither ever gates the monthly/daily/weekly count limits, which are
    # counted per-request regardless of type or duration.
    type = models.TextField(choices=TYPE_CHOICES, null=True, blank=True, db_column="type")
    duration_minutes = models.IntegerField(choices=DURATION_CHOICES, null=True, blank=True, db_column="duration_minutes")
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approver_role = models.TextField(null=True, blank=True, db_column="approver_role")  # "hr" | "dept_head"
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employee_permissions"


# ──────────────────────────────────────────────
#  Casual Leave (CL) -paid, staff-only, 1/month
# ──────────────────────────────────────────────

class CasualLeaveRequest(models.Model):
    """
    Casual Leave -completely independent of LeaveRequest / permissions.

    Rules enforced in the views:
      • staff employees only
      • eligible only after 6 months of service
      • one CL per calendar month (pending or approved blocks another)
      • approved  → attendance for that date = Present (full paid day)
      • rejected  → attendance for that date = Leave
    """
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="casual_leaves",
    )
    date = models.DateField(help_text="The single day of casual leave.")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    reviewed_by = models.TextField(null=True, blank=True, db_column="reviewed_by")
    reviewer_role = models.TextField(null=True, blank=True, db_column="reviewer_role")  # hr | dept_head
    review_comment = models.TextField(null=True, blank=True, db_column="review_comment")
    reviewed_at = models.DateTimeField(null=True, blank=True, db_column="reviewed_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "casual_leave_requests"
        ordering = ["-created_at"]
