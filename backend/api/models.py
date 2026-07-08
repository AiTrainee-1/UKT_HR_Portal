from django.db import models


# ──────────────────────────────────────────────
#  Organisation Structure
# ──────────────────────────────────────────────

class Branch(models.Model):
    name = models.TextField()
    location = models.TextField(null=True, blank=True)
    address = models.TextField(null=True, blank=True)
    manager_name = models.TextField(null=True, blank=True, db_column="manager_name")
    phone = models.TextField(null=True, blank=True)
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "branches"


class Department(models.Model):
    name = models.TextField(unique=True)
    description = models.TextField(null=True, blank=True)
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="departments"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "departments"


class Designation(models.Model):
    title = models.TextField()
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="designations"
    )
    level = models.TextField(default="staff")  # junior/mid/senior/manager/executive
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "designations"


# ──────────────────────────────────────────────
#  Employees
# ──────────────────────────────────────────────

class Employee(models.Model):
    EMPLOYMENT_TYPE_PRODUCTION = "production"
    EMPLOYMENT_TYPE_STAFF = "staff"
    EMPLOYMENT_TYPES = [
        (EMPLOYMENT_TYPE_PRODUCTION, "Production"),
        (EMPLOYMENT_TYPE_STAFF, "Staff"),
    ]
    GENDER_CHOICES = [("male", "Male"), ("female", "Female"), ("other", "Other")]

    employee_code = models.TextField(unique=True, db_column="employee_code")
    first_name = models.TextField(db_column="first_name")
    last_name = models.TextField(db_column="last_name")
    gender = models.TextField(choices=GENDER_CHOICES, null=True, blank=True)
    date_of_birth = models.DateField(null=True, blank=True, db_column="date_of_birth")
    email = models.TextField(null=True, blank=True)
    phone = models.TextField(null=True, blank=True)
    emergency_contact = models.TextField(null=True, blank=True, db_column="emergency_contact")
    photo_url = models.TextField(null=True, blank=True, db_column="photo_url")
    role = models.TextField(null=True, blank=True)
    employment_type = models.TextField(
        choices=EMPLOYMENT_TYPES, default=EMPLOYMENT_TYPE_STAFF, db_column="employment_type"
    )
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="employees",
    )
    designation = models.ForeignKey(
        Designation, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="designation_id", related_name="employees",
    )
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="employees",
    )
    reporting_manager = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="reporting_manager_id", related_name="subordinates",
    )
    salary_type = models.TextField(default="monthly", db_column="salary_type")
    salary_amount = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True, db_column="salary_amount"
    )
    # Production employees only: fixed pay per shift. Payroll = total_shifts * salary_per_shift.
    salary_per_shift = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True, db_column="salary_per_shift"
    )
    status = models.TextField(default="active")
    bank_name = models.TextField(null=True, blank=True, db_column="bank_name")
    bank_account = models.TextField(null=True, blank=True, db_column="bank_account")
    bank_ifsc = models.TextField(null=True, blank=True, db_column="bank_ifsc")
    id_proof = models.TextField(null=True, blank=True, db_column="id_proof")
    pf_number = models.TextField(null=True, blank=True, db_column="pf_number")
    esi_number = models.TextField(null=True, blank=True, db_column="esi_number")
    uan_number = models.TextField(null=True, blank=True, db_column="uan_number")
    address = models.TextField(null=True, blank=True)
    join_date = models.TextField(null=True, blank=True, db_column="join_date")
    father_name = models.TextField(null=True, blank=True, db_column="father_name")
    mother_name = models.TextField(null=True, blank=True, db_column="mother_name")
    probation_end_date = models.DateField(null=True, blank=True, db_column="probation_end_date")
    confirmation_date = models.DateField(null=True, blank=True, db_column="confirmation_date")
    biometric_device_id = models.TextField(null=True, blank=True, db_column="biometric_device_id")
    blood_group = models.TextField(null=True, blank=True, db_column="blood_group")
    initial_salary = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True, db_column="initial_salary",
        help_text="Salary at time of joining — baseline for increment tracking."
    )
    password_hash = models.TextField(null=True, blank=True, db_column="password_hash")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employees"


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
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(default="pending")  # pending/approved/rejected
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
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
#  Payroll (Enterprise)
# ──────────────────────────────────────────────

class PayrollRun(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_PROCESSING = "processing"
    STATUS_APPROVED = "approved"
    STATUS_LOCKED = "locked"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_LOCKED, "Locked"),
    ]
    RUN_TYPE_MONTHLY = "monthly"
    RUN_TYPE_BIWEEKLY = "biweekly"
    RUN_TYPES = [(RUN_TYPE_MONTHLY, "Monthly"), (RUN_TYPE_BIWEEKLY, "Bi-Weekly")]

    run_code = models.TextField(unique=True, db_column="run_code")
    month = models.IntegerField()
    year = models.IntegerField()
    run_type = models.TextField(choices=RUN_TYPES, default=RUN_TYPE_MONTHLY, db_column="run_type")
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_DRAFT)
    total_employees = models.IntegerField(default=0, db_column="total_employees")
    total_gross = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_gross")
    total_deductions = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_deductions")
    total_net = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_net")
    processed_by = models.TextField(null=True, blank=True, db_column="processed_by")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    locked_at = models.DateTimeField(null=True, blank=True, db_column="locked_at")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payroll_runs"


class EarningItem(models.Model):
    ITEM_TYPES = [
        ("basic", "Basic Salary"),
        ("hra", "HRA"),
        ("allowance", "Allowance"),
        ("incentive", "Incentive"),
        ("bonus", "Bonus"),
        ("ot", "Overtime"),
        ("session", "Session Pay"),
    ]

    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.CASCADE, db_column="payroll_run_id", related_name="earnings"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="earnings"
    )
    item_type = models.TextField(choices=ITEM_TYPES, db_column="item_type")
    label = models.TextField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "earning_items"


class DeductionItem(models.Model):
    ITEM_TYPES = [
        ("pf", "Provident Fund"),
        ("esi", "ESI"),
        ("advance", "Advance Recovery"),
        ("loan", "Loan Recovery"),
        ("penalty", "Penalty"),
        ("other", "Other Deduction"),
    ]

    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.CASCADE, db_column="payroll_run_id", related_name="deductions"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="deductions"
    )
    item_type = models.TextField(choices=ITEM_TYPES, db_column="item_type")
    label = models.TextField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "deduction_items"


# ──────────────────────────────────────────────
#  Settlement (Advances & Loans)
# ──────────────────────────────────────────────

class Advance(models.Model):
    ADVANCE_TYPE_GENERAL = "general"
    ADVANCE_TYPE_TERM = "term"
    ADVANCE_TYPES = [
        (ADVANCE_TYPE_GENERAL, "General Advance"),
        (ADVANCE_TYPE_TERM, "Term Advance (Loan)"),
    ]
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CLOSED = "closed"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_CLOSED, "Closed"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="advances"
    )
    advance_type = models.TextField(choices=ADVANCE_TYPES, db_column="advance_type")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    purpose = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    disbursed_at = models.DateTimeField(null=True, blank=True, db_column="disbursed_at")
    repayment_start_month = models.IntegerField(null=True, blank=True, db_column="repayment_start_month")
    repayment_start_year = models.IntegerField(null=True, blank=True, db_column="repayment_start_year")
    repayment_months = models.IntegerField(null=True, blank=True, db_column="repayment_months")
    emi_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="emi_amount")
    total_repaid = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="total_repaid")
    outstanding = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "advances"


class AdvanceRepayment(models.Model):
    PAYMENT_CASH = "cash"
    PAYMENT_GPAY = "gpay"
    PAYMENT_PAYROLL = "payroll"
    PAYMENT_METHODS = [
        (PAYMENT_CASH, "Hand Cash"),
        (PAYMENT_GPAY, "GPay"),
        (PAYMENT_PAYROLL, "Payroll Deduction"),
    ]

    advance = models.ForeignKey(
        Advance, on_delete=models.CASCADE, db_column="advance_id", related_name="repayments"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    payment_method = models.TextField(
        choices=PAYMENT_METHODS, default=PAYMENT_PAYROLL, db_column="payment_method"
    )
    is_processed = models.BooleanField(default=False, db_column="is_processed")
    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="payroll_run_id", related_name="advance_repayments"
    )
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "advance_repayments"


# ──────────────────────────────────────────────
#  Salary Slips
# ──────────────────────────────────────────────

class SalarySlip(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="salary_slips"
    )
    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="payroll_run_id", related_name="salary_slips"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    slip_number = models.TextField(unique=True, db_column="slip_number")
    basic = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    hra = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    allowances = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    incentives = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    bonuses = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    ot_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="ot_amount")
    gross_salary = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="gross_salary")
    pf_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="pf_deduction")
    esi_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="esi_deduction")
    advance_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="advance_deduction")
    other_deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="other_deductions")
    total_deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="total_deductions")
    net_salary = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="net_salary")
    working_days = models.IntegerField(default=0, db_column="working_days")
    present_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="present_days")
    absent_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="absent_days")
    paid_leave_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="paid_leave_days")
    unpaid_leave_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="unpaid_leave_days")
    late_days = models.IntegerField(default=0, db_column="late_days")
    completed_sessions = models.IntegerField(default=0, db_column="completed_sessions")
    # Full day-by-day breakdown for traceability — stored as JSON
    breakdown_details = models.JSONField(null=True, blank=True, db_column="breakdown_details")
    generated_at = models.DateTimeField(auto_now_add=True, db_column="generated_at")
    emailed_at = models.DateTimeField(null=True, blank=True, db_column="emailed_at")

    class Meta:
        db_table = "salary_slips"
        unique_together = [("employee", "month", "year", "week_number")]


# ──────────────────────────────────────────────
#  User Management & RBAC
# ──────────────────────────────────────────────

class Role(models.Model):
    name = models.TextField(unique=True)  # HR Admin, HR Executive, Payroll Officer, etc.
    description = models.TextField(null=True, blank=True)
    permissions = models.JSONField(default=dict)  # {module: {view, create, edit, delete, approve}}
    is_system = models.BooleanField(default=False, db_column="is_system")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "roles"


class HRUser(models.Model):
    username = models.TextField(unique=True)
    email = models.TextField(null=True, blank=True)
    full_name = models.TextField(null=True, blank=True, db_column="full_name")
    password_hash = models.TextField(db_column="password_hash")
    role = models.ForeignKey(
        Role, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="role_id", related_name="users"
    )
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="hr_users"
    )
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="hr_users"
    )
    is_active = models.BooleanField(default=True, db_column="is_active")
    is_super_admin = models.BooleanField(default=False, db_column="is_super_admin")
    last_login = models.DateTimeField(null=True, blank=True, db_column="last_login")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "hr_users"


# ──────────────────────────────────────────────
#  Audit Logs
# ──────────────────────────────────────────────

class AuditLog(models.Model):
    ACTION_CHOICES = [
        ("login", "Login"),
        ("logout", "Logout"),
        ("create", "Create"),
        ("update", "Update"),
        ("delete", "Delete"),
        ("approve", "Approve"),
        ("reject", "Reject"),
        ("export", "Export"),
        ("lock", "Lock"),
    ]

    user_type = models.TextField(default="hr", db_column="user_type")  # hr/employee/erp
    user_id = models.IntegerField(null=True, blank=True, db_column="user_id")
    user_name = models.TextField(db_column="user_name")
    action = models.TextField(choices=ACTION_CHOICES)
    module = models.TextField()  # employees, payroll, leave, etc.
    record_id = models.IntegerField(null=True, blank=True, db_column="record_id")
    record_description = models.TextField(null=True, blank=True, db_column="record_description")
    old_values = models.JSONField(null=True, blank=True, db_column="old_values")
    new_values = models.JSONField(null=True, blank=True, db_column="new_values")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "audit_logs"
        ordering = ["-created_at"]


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

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE,
        db_column="employee_id", related_name="permissions"
    )
    date = models.DateField()
    permission_time = models.TimeField(null=True, blank=True, db_column="permission_time")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employee_permissions"


# ──────────────────────────────────────────────
#  Notifications
# ──────────────────────────────────────────────

class Notification(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="notifications"
    )
    type = models.TextField(default="general")
    message = models.TextField()
    is_read = models.BooleanField(default=False, db_column="is_read")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "notifications"


# ──────────────────────────────────────────────
#  Recruitment
# ──────────────────────────────────────────────

class Job(models.Model):
    title = models.TextField()
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="jobs",
    )
    description = models.TextField(null=True, blank=True)
    requirements = models.TextField(null=True, blank=True)
    salary_range = models.TextField(null=True, blank=True, db_column="salary_range")
    status = models.TextField(default="open")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "jobs"


class Applicant(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, db_column="job_id", related_name="applicants")
    name = models.TextField()
    email = models.TextField()
    phone = models.TextField()
    cover_letter = models.TextField(null=True, blank=True, db_column="cover_letter")
    experience = models.TextField(null=True, blank=True)
    status = models.TextField(default="applied")
    interview_date = models.TextField(null=True, blank=True, db_column="interview_date")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "applicants"


# ──────────────────────────────────────────────
#  Resignation Requests
# ──────────────────────────────────────────────

class ResignationRequest(models.Model):
    # Status flow: pending → dept_approved → approved
    #              pending → rejected (by dept head)
    #              dept_approved → rejected (by HR)
    STATUS_PENDING = "pending"
    STATUS_DEPT_APPROVED = "dept_approved"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="resignation_requests",
    )
    reason = models.TextField(null=True, blank=True)
    last_working_date = models.DateField(null=True, blank=True, db_column="last_working_date")
    survey_q1_answer = models.TextField(null=True, blank=True, db_column="survey_q1_answer")
    survey_q2_answer = models.TextField(null=True, blank=True, db_column="survey_q2_answer")
    survey_q3_answer = models.TextField(null=True, blank=True, db_column="survey_q3_answer")
    status = models.TextField(default=STATUS_PENDING)
    # Dept head stage
    dept_head = models.ForeignKey(
        Employee, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="dept_head_id", related_name="resignation_reviews",
    )
    dept_head_status = models.TextField(null=True, blank=True, db_column="dept_head_status")
    dept_head_comment = models.TextField(null=True, blank=True, db_column="dept_head_comment")
    dept_head_approved_at = models.DateTimeField(null=True, blank=True, db_column="dept_head_approved_at")
    # HR stage
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    # Track which stage rejected
    rejected_by = models.TextField(null=True, blank=True, db_column="rejected_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "resignation_requests"


# ──────────────────────────────────────────────
#  Department Headcount (Required Staffing)
# ──────────────────────────────────────────────

class DepartmentHeadcount(models.Model):
    department = models.OneToOneField(
        Department, on_delete=models.CASCADE, db_column="department_id",
        related_name="headcount",
    )
    required_count = models.IntegerField(default=0, db_column="required_count")
    notes = models.TextField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "department_headcounts"


# ──────────────────────────────────────────────
#  Attendance
# ──────────────────────────────────────────────

class Attendance(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="attendance_records"
    )
    date = models.TextField()
    present = models.BooleanField(default=True)
    hours_worked = models.DecimalField(
        max_digits=4, decimal_places=2, null=True, blank=True, db_column="hours_worked"
    )
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance"


class AttendanceLog(models.Model):
    PUNCH_IN = "IN"
    PUNCH_OUT = "OUT"
    PUNCH_CHOICES = [(PUNCH_IN, "In"), (PUNCH_OUT, "Out")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="attendance_logs",
    )
    date = models.DateField()
    punch_time = models.TimeField(db_column="punch_time")
    punch_type = models.TextField(choices=PUNCH_CHOICES, db_column="punch_type")
    source = models.TextField(default="manual")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance_logs"
        ordering = ["date", "punch_time"]


class DailyShiftLog(models.Model):
    """Computed 4-punch result per staff employee per day."""
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="daily_shift_logs"
    )
    date = models.DateField()
    shift = models.ForeignKey(
        ShiftTemplate, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="shift_id", related_name="daily_logs"
    )
    punch1 = models.TimeField(null=True, blank=True)   # morning IN
    punch2 = models.TimeField(null=True, blank=True)   # lunch OUT
    punch3 = models.TimeField(null=True, blank=True)   # lunch IN (return)
    punch4 = models.TimeField(null=True, blank=True)   # evening OUT
    total_punches = models.IntegerField(default=0)
    first_half = models.BooleanField(default=False)
    second_half = models.BooleanField(default=False)
    shifts_completed = models.DecimalField(max_digits=3, decimal_places=2, default=0)
    late_morning = models.BooleanField(default=False)
    late_return = models.BooleanField(default=False)
    late_reason = models.TextField(null=True, blank=True)
    computed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "daily_shift_logs"
        unique_together = [["employee", "date"]]


class MonthlyShiftSummary(models.Model):
    """Aggregated late + shift summary per employee per month, used by payroll."""
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="monthly_shift_summaries"
    )
    year = models.IntegerField()
    month = models.IntegerField()
    total_shifts = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    total_late_count = models.IntegerField(default=0)
    permissions_used = models.IntegerField(default=0)       # of 3 free
    billable_late_count = models.IntegerField(default=0)    # after 3 free
    shift_deductions = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    salary_deduction_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "monthly_shift_summaries"
        unique_together = [["employee", "year", "month"]]


class SessionConfig(models.Model):
    name = models.TextField()
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    # Minimum checkout time for the session to be counted as completed.
    # Morning session: 12:40 (must leave after morning ends).
    # Afternoon session: 17:30 (must stay until at least 5:30 PM).
    minimum_checkout_time = models.TimeField(null=True, blank=True, db_column="minimum_checkout_time")
    pay_amount = models.DecimalField(max_digits=8, decimal_places=2, db_column="pay_amount")
    is_overtime = models.BooleanField(default=False, db_column="is_overtime")
    order = models.IntegerField(default=0)

    class Meta:
        db_table = "session_configs"
        ordering = ["order"]


class WorkSession(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="work_sessions",
    )
    date = models.DateField()
    session_config = models.ForeignKey(
        SessionConfig, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="session_config_id", related_name="work_sessions",
    )
    session_name = models.TextField(db_column="session_name")
    check_in = models.TimeField(db_column="check_in")
    check_out = models.TimeField(db_column="check_out")
    hours_worked = models.DecimalField(max_digits=5, decimal_places=2, db_column="hours_worked")
    session_amount = models.DecimalField(max_digits=8, decimal_places=2, db_column="session_amount")
    is_overtime = models.BooleanField(default=False, db_column="is_overtime")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "work_sessions"
        ordering = ["date", "check_in"]


class Payroll(models.Model):
    SALARY_MODE_MONTHLY = "monthly"
    SALARY_MODE_SESSION = "session"
    SALARY_MODE_SHIFT = "shift"
    MODE_CHOICES = [
        (SALARY_MODE_MONTHLY, "Monthly"),
        (SALARY_MODE_SESSION, "Session-based"),
        (SALARY_MODE_SHIFT, "Shift-based (Production)"),
    ]
    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_PAID, "Paid")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="payrolls",
    )
    salary_mode = models.TextField(choices=MODE_CHOICES, db_column="salary_mode")
    month = models.IntegerField()
    year = models.IntegerField()
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    total_working_days = models.IntegerField(default=0, db_column="total_working_days")
    present_days = models.DecimalField(max_digits=5, decimal_places=1, default=0, db_column="present_days")
    absent_days = models.DecimalField(max_digits=5, decimal_places=1, default=0, db_column="absent_days")
    completed_sessions = models.IntegerField(default=0, db_column="completed_sessions")
    ot_hours = models.DecimalField(max_digits=5, decimal_places=2, default=0, db_column="ot_hours")
    ot_amount = models.DecimalField(max_digits=8, decimal_places=2, default=0, db_column="ot_amount")
    base_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="base_salary")
    gross_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="gross_salary")
    deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    bonus = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    final_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="final_salary")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payrolls"
        unique_together = [("employee", "month", "year", "week_number")]


class PayrollSettings(models.Model):
    """Singleton — always fetch/update the row with pk=1."""
    # 0 means "do not deduct" — default off so HR explicitly enables

    # ── Company profile (drives branding across the whole portal) ─────────
    company_name = models.TextField(default="UKTextiles", db_column="company_name")
    company_tagline = models.TextField(default="Garments Manufacturing Excellence", db_column="company_tagline")
    company_phone = models.TextField(blank=True, default="", db_column="company_phone")
    company_email = models.TextField(blank=True, default="", db_column="company_email")
    company_website = models.TextField(blank=True, default="", db_column="company_website")
    company_gstin = models.TextField(blank=True, default="", db_column="company_gstin")
    company_pan = models.TextField(blank=True, default="", db_column="company_pan")
    company_address = models.TextField(blank=True, default="", db_column="company_address")
    company_registration = models.TextField(blank=True, default="", db_column="company_registration")

    # ── Staff deductions ──────────────────────────────────────────────────
    pf_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="pf_rate", help_text="Staff employee PF % (e.g. 12). 0 = disabled."
    )
    esi_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="esi_rate", help_text="Staff employee ESI % (e.g. 0.75). 0 = disabled."
    )
    esi_applicable_below = models.DecimalField(
        max_digits=10, decimal_places=2, default=21000,
        db_column="esi_applicable_below",
        help_text="Staff: ESI applies only when full monthly salary is below this amount."
    )

    # ── Production deductions ─────────────────────────────────────────────
    prod_pf_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="prod_pf_rate", help_text="Production employee PF % (e.g. 12). 0 = disabled."
    )
    prod_esi_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="prod_esi_rate", help_text="Production employee ESI % (e.g. 0.75). 0 = disabled."
    )
    prod_esi_applicable_below = models.DecimalField(
        max_digits=10, decimal_places=2, default=21000,
        db_column="prod_esi_applicable_below",
        help_text="Production: ESI applies only when monthly-equivalent earnings are below this amount."
    )

    # ── General ───────────────────────────────────────────────────────────
    pay_day = models.IntegerField(
        default=5, db_column="pay_day",
        help_text="Day of month when salaries are disbursed."
    )
    production_pay_type = models.TextField(
        default="biweekly", db_column="production_pay_type",
        help_text="biweekly or monthly"
    )
    default_salary_per_shift = models.DecimalField(
        max_digits=8, decimal_places=2, default=0, db_column="default_salary_per_shift",
        help_text="Pre-filled Salary Per Shift for new production employees. 0 = no default.",
    )
    slip_company_name = models.TextField(default="UK TEXTILES - H.O", db_column="slip_company_name")
    slip_company_address = models.TextField(default="TIRUPUR", db_column="slip_company_address")
    min_wage_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="min_wage_rate")
    signature_image = models.TextField(null=True, blank=True, db_column="signature_image")
    company_logo = models.TextField(null=True, blank=True, db_column="company_logo")
    authorized_signature = models.TextField(null=True, blank=True, db_column="authorized_signature")

    # ── Attendance calculation mode ───────────────────────────────────────
    # strict = existing 4-punch engine (lunch delays, return-late detection)
    # simple = morning punch + evening punch only; first punch after the
    #          half-shift cutoff = half shift; no lunch tracking
    attendance_mode = models.TextField(default="strict", db_column="attendance_mode")
    simple_half_shift_cutoff = models.TimeField(
        default="13:30", db_column="simple_half_shift_cutoff",
        help_text="Simple mode: first punch after this time = half shift."
    )
    simple_grace_minutes = models.IntegerField(
        default=15, db_column="simple_grace_minutes",
        help_text="Simple mode fallback grace when employee has no shift assigned."
    )

    # ── Production attendance windows (1.5-shift day) ─────────────────────
    prod_first_half_start = models.TimeField(default="08:30", db_column="prod_first_half_start")
    prod_first_half_end   = models.TimeField(default="12:30", db_column="prod_first_half_end")
    prod_second_half_start = models.TimeField(default="13:30", db_column="prod_second_half_start")
    prod_second_half_end   = models.TimeField(default="17:30", db_column="prod_second_half_end")
    prod_extra_start = models.TimeField(default="17:50", db_column="prod_extra_start")
    prod_extra_end   = models.TimeField(default="20:00", db_column="prod_extra_end")

    # ── Production PF/EF salary-range rules ────────────────────────────────
    # list of {"label": str, "minSalary": num, "maxSalary": num, "pfRate": num, "efRate": num}
    # When enabled, the rule matching the employee's monthly-equivalent earnings
    # takes precedence over the flat prod_pf_rate / prod_esi_rate.
    prod_pf_ef_enabled = models.BooleanField(default=False, db_column="prod_pf_ef_enabled")
    prod_pf_ef_rules = models.JSONField(default=list, blank=True, db_column="prod_pf_ef_rules")

    # ── SMTP / Email ──────────────────────────────────────────────────────
    smtp_host = models.TextField(default="smtp.gmail.com", db_column="smtp_host")
    smtp_port = models.IntegerField(default=587, db_column="smtp_port")
    smtp_username = models.TextField(blank=True, default="", db_column="smtp_username")
    smtp_password = models.TextField(blank=True, default="", db_column="smtp_password")
    smtp_from_email = models.TextField(blank=True, default="", db_column="smtp_from_email")
    smtp_from_name = models.TextField(default="UKTextiles HR", db_column="smtp_from_name")

    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payroll_settings"

    @classmethod
    def get(cls) -> "PayrollSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class SalaryRecord(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="salary_records"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    type = models.TextField(default="monthly")
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    status = models.TextField(default="pending")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "salary_records"


# ──────────────────────────────────────────────
#  Department Managers (User Management)
# ──────────────────────────────────────────────

class DepartmentManager(models.Model):
    """An employee designated as a department-level approver via User Management."""
    employee = models.OneToOneField(
        Employee, on_delete=models.CASCADE,
        related_name="manager_profile", db_column="employee_id",
    )
    can_approve_leaves = models.BooleanField(default=True, db_column="can_approve_leaves")
    can_approve_permissions = models.BooleanField(default=True, db_column="can_approve_permissions")
    can_approve_resignations = models.BooleanField(default=True, db_column="can_approve_resignations")
    can_approve_attendance = models.BooleanField(default=True, db_column="can_approve_attendance")
    can_approve_casual_leave = models.BooleanField(default=True, db_column="can_approve_casual_leave")
    is_active = models.BooleanField(default=True, db_column="is_active")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "department_managers"


class ManagerDepartmentAssignment(models.Model):
    manager = models.ForeignKey(
        DepartmentManager, on_delete=models.CASCADE,
        related_name="department_assignments", db_column="manager_id",
    )
    department = models.ForeignKey(
        Department, on_delete=models.CASCADE,
        related_name="manager_assignments", db_column="department_id",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "manager_department_assignments"
        unique_together = [["manager", "department"]]


class ManagerEmployeeAssignment(models.Model):
    manager = models.ForeignKey(
        DepartmentManager, on_delete=models.CASCADE,
        related_name="employee_assignments", db_column="manager_id",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE,
        related_name="direct_manager_assignments", db_column="employee_id",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "manager_employee_assignments"
        unique_together = [["manager", "employee"]]


# ──────────────────────────────────────────────
#  Final Attendance (auto-computed + HR override)
# ──────────────────────────────────────────────

class AttendanceDayRecord(models.Model):
    """
    The FINAL per-day attendance verdict for one employee.

    Auto-computed from punches (using the mode selected in settings), then
    optionally overridden by HR. When source == "manual" the values here are
    authoritative — payroll and salary always read from this table first.
    """
    STATUS_PRESENT = "present"
    STATUS_ABSENT = "absent"
    STATUS_HALF = "half_shift"
    STATUS_LEAVE = "on_leave"
    STATUS_HOLIDAY = "holiday"
    STATUS_CHOICES = [
        (STATUS_PRESENT, "Present"),
        (STATUS_ABSENT, "Absent"),
        (STATUS_HALF, "Half Shift"),
        (STATUS_LEAVE, "On Leave"),
        (STATUS_HOLIDAY, "Holiday"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="attendance_day_records",
    )
    date = models.DateField()
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_ABSENT)
    is_late = models.BooleanField(default=False, db_column="is_late")
    is_half_shift = models.BooleanField(default=False, db_column="is_half_shift")
    early_leave = models.BooleanField(default=False, db_column="early_leave")
    shifts_earned = models.DecimalField(
        max_digits=3, decimal_places=2, default=0, db_column="shifts_earned",
        help_text="0.50 per half. Staff max 1.00, production max 1.50."
    )
    first_punch = models.TimeField(null=True, blank=True, db_column="first_punch")
    last_punch = models.TimeField(null=True, blank=True, db_column="last_punch")
    total_punches = models.IntegerField(default=0, db_column="total_punches")
    computed_mode = models.TextField(null=True, blank=True, db_column="computed_mode")  # strict/simple
    source = models.TextField(default="auto")  # auto | manual
    override_by = models.TextField(null=True, blank=True, db_column="override_by")
    override_note = models.TextField(null=True, blank=True, db_column="override_note")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_day_records"
        unique_together = [["employee", "date"]]
        ordering = ["date"]


# ──────────────────────────────────────────────
#  Promotion & Increment
# ──────────────────────────────────────────────

class Promotion(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="promotions"
    )
    previous_department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="previous_department_id", related_name="+",
    )
    previous_designation = models.ForeignKey(
        Designation, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="previous_designation_id", related_name="+",
    )
    new_department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="new_department_id", related_name="+",
    )
    new_designation = models.ForeignKey(
        Designation, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="new_designation_id", related_name="+",
    )
    effective_date = models.DateField(db_column="effective_date")
    notes = models.TextField(null=True, blank=True)
    promoted_by = models.TextField(null=True, blank=True, db_column="promoted_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "promotions"
        ordering = ["-effective_date", "-created_at"]


class SalaryIncrement(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="increments"
    )
    previous_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="previous_salary")
    new_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="new_salary")
    percent = models.DecimalField(
        max_digits=6, decimal_places=2, db_column="percent",
        help_text="Increment percentage applied (e.g. 10.00)."
    )
    effective_date = models.DateField(db_column="effective_date")
    notes = models.TextField(null=True, blank=True)
    added_by = models.TextField(null=True, blank=True, db_column="added_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "salary_increments"
        ordering = ["-effective_date", "-created_at"]


# ──────────────────────────────────────────────
#  Attendance Override Requests (two-level approval)
# ──────────────────────────────────────────────

class AttendanceOverrideRequest(models.Model):
    """
    HR proposes a manual attendance change; a Department Head must approve it
    before the AttendanceDayRecord is actually overwritten. Prevents HR from
    silently editing attendance without accountability.
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
        related_name="attendance_override_requests",
    )
    date = models.DateField()
    # Snapshot of the record before the change, and the change requested — both JSON
    previous_values = models.JSONField(default=dict, db_column="previous_values")
    requested_values = models.JSONField(default=dict, db_column="requested_values")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    requested_by = models.TextField(null=True, blank=True, db_column="requested_by")
    reviewed_by = models.TextField(null=True, blank=True, db_column="reviewed_by")
    review_comment = models.TextField(null=True, blank=True, db_column="review_comment")
    reviewed_at = models.DateTimeField(null=True, blank=True, db_column="reviewed_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance_override_requests"
        ordering = ["-created_at"]


# ──────────────────────────────────────────────
#  Biometric / Punching Device Configuration
# ──────────────────────────────────────────────

class BiometricDevice(models.Model):
    DEVICE_TYPE_CHOICES = [
        ("aiface_mars", "AiFace-Mars"),
        ("zkteco", "ZKTeco"),
        ("essl", "eSSL"),
        ("generic_http", "Generic HTTP API"),
        ("other", "Other"),
    ]

    name = models.TextField()
    device_type = models.TextField(choices=DEVICE_TYPE_CHOICES, default="aiface_mars", db_column="device_type")
    host = models.TextField(blank=True, default="", help_text="IP address or hostname")
    port = models.IntegerField(null=True, blank=True)
    api_key = models.TextField(blank=True, default="", db_column="api_key")
    # Free-form extra config (auth headers, polling interval, model-specific options)
    connection_config = models.JSONField(default=dict, blank=True, db_column="connection_config")
    is_active = models.BooleanField(default=True, db_column="is_active")
    is_default = models.BooleanField(default=False, db_column="is_default")
    last_synced_at = models.DateTimeField(null=True, blank=True, db_column="last_synced_at")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "biometric_devices"
        ordering = ["-is_default", "name"]


# ──────────────────────────────────────────────
#  Employee ID Card Template Settings
# ──────────────────────────────────────────────

class IdCardSettings(models.Model):
    """Singleton — always fetch/update the row with pk=1."""

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
#  Casual Leave (CL) — paid, staff-only, 1/month
# ──────────────────────────────────────────────

class CasualLeaveRequest(models.Model):
    """
    Casual Leave — completely independent of LeaveRequest / permissions.

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


# ──────────────────────────────────────────────
#  Night Shift Relaxation
# ──────────────────────────────────────────────

class NightShiftRule(models.Model):
    """
    DB-driven relaxation rule: if the employee's last punch-out of the night
    is at or before `worked_until` (with `crosses_midnight` marking early-
    morning times as belonging to the previous night), the next morning they
    may punch in as late as `allowed_first_punch` without late/half-shift.

    Rules are matched in ascending `worked_until` order — the first rule whose
    threshold is >= the actual punch-out time wins.
    """
    name = models.TextField()
    worked_until = models.TimeField(
        db_column="worked_until",
        help_text="Latest punch-out this rule covers (e.g. 22:30, or 02:30 next day).",
    )
    crosses_midnight = models.BooleanField(
        default=False, db_column="crosses_midnight",
        help_text="True when worked_until is an early-morning time of the NEXT day.",
    )
    allowed_first_punch = models.TimeField(
        db_column="allowed_first_punch",
        help_text="Next-day first punch allowed up to this time without penalty.",
    )
    order = models.IntegerField(default=0)
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "night_shift_rules"
        ordering = ["order", "id"]


class NightShiftRelaxation(models.Model):
    """
    One row per employee per night worked late. Detected automatically from
    AttendanceLog punches. `relaxation_date` (= night_date + 1) is the day the
    late-arrival allowance applies to; attendance/payroll consult this table
    when classifying that day.
    """
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="night_relaxations",
    )
    night_date = models.DateField(db_column="night_date", help_text="The day the night shift started.")
    relaxation_date = models.DateField(db_column="relaxation_date", help_text="Next day — allowance applies here.")
    last_punch_out = models.TimeField(db_column="last_punch_out")
    crossed_midnight = models.BooleanField(default=False, db_column="crossed_midnight")
    allowed_until = models.TimeField(db_column="allowed_until")
    rule = models.ForeignKey(
        NightShiftRule, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="rule_id", related_name="relaxations",
    )
    # Filled in once the employee punches in the next day
    reported_at = models.TimeField(null=True, blank=True, db_column="reported_at")
    within_allowance = models.BooleanField(null=True, blank=True, db_column="within_allowance")
    computed_at = models.DateTimeField(auto_now=True, db_column="computed_at")

    class Meta:
        db_table = "night_shift_relaxations"
        unique_together = [["employee", "relaxation_date"]]
        ordering = ["-relaxation_date"]


# ──────────────────────────────────────────────
#  Production Shift Workflow (separate from staff)
# ──────────────────────────────────────────────

class ProductionShiftConfig(models.Model):
    """
    Singleton. Reference punch times for the production 4-punch day and the
    grace window used when checking segment coverage. Gender-agnostic — a
    single config applies to every production employee.
    """
    punch1_time = models.TimeField(default="08:30", db_column="punch1_time", help_text="Arrival")
    punch2_time = models.TimeField(default="12:45", db_column="punch2_time", help_text="Lunch out")
    punch3_time = models.TimeField(default="13:30", db_column="punch3_time", help_text="Lunch return")
    punch4_time = models.TimeField(default="20:00", db_column="punch4_time", help_text="Departure")
    grace_minutes = models.IntegerField(default=10, db_column="grace_minutes")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "production_shift_config"

    @classmethod
    def get(cls) -> "ProductionShiftConfig":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class ProductionShiftSegment(models.Model):
    """
    Ordered, dynamic list of shift-value segments for production attendance.
    Default (1.50-shift day): 4 x 0.25 covering 8:30-12:45 & 13:30-17:30,
    plus 0.50 for 17:30-20:00. Fully editable from Settings / Shift Management.
    """
    label = models.TextField()
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    shift_value = models.DecimalField(max_digits=4, decimal_places=2, db_column="shift_value")
    order = models.IntegerField(default=0)
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "production_shift_segments"
        ordering = ["order", "id"]
