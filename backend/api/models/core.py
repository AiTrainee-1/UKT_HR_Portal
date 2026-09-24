"""Organisation: branches, departments, designations, employees, HOD (department manager) assignments."""

from django.db import models


# ──────────────────────────────────────────────
#  Organisation Structure
# ──────────────────────────────────────────────

class Branch(models.Model):
    name = models.TextField()
    code = models.TextField(null=True, blank=True, unique=True, db_column="code")
    location = models.TextField(null=True, blank=True)
    address = models.TextField(null=True, blank=True)
    manager_name = models.TextField(null=True, blank=True, db_column="manager_name")
    phone = models.TextField(null=True, blank=True)
    is_head_office = models.BooleanField(default=False, db_column="is_head_office")
    is_active = models.BooleanField(default=True, db_column="is_active")
    # Counter behind the auto-generated per-branch employee "Unit Code"
    # (HO-1, HO-2, ... / Unit1-1, Unit1-2, ...) -see Employee.unit_code and
    # views.py::_assign_unit_code. Only ever incremented, never reused, even
    # if an employee with an earlier number is later deleted or moved out.
    next_employee_seq = models.IntegerField(default=0, db_column="next_employee_seq")
    # Geofence center for location-based attendance (Geo Attendance feature).
    # All three are null until HR sets a location on this branch -geo-punch
    # is simply unavailable for employees here until then (see
    # geo_attendance_views.py::_branch_geofence).
    geofence_lat = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True, db_column="geofence_lat"
    )
    geofence_lng = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True, db_column="geofence_lng"
    )
    geofence_radius_m = models.IntegerField(
        null=True, blank=True, default=200, db_column="geofence_radius_m"
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "branches"


class Department(models.Model):
    # Unique per BRANCH, not globally: two branches each legitimately run
    # their own ADMIN / CUTTING / PRODUCTION department, and under branch
    # isolation they are separate rows with separate staff. A global unique
    # name would force one branch to rename its department to something
    # nobody calls it.
    name = models.TextField()
    description = models.TextField(null=True, blank=True)
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="departments"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "departments"
        constraints = [
            models.UniqueConstraint(
                fields=["name", "branch"], name="uniq_department_name_per_branch",
            ),
        ]


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
    # Auto-generated from Branch.code + Branch.next_employee_seq at creation
    # time (and regenerated if the employee moves to a different branch) —
    # see views.py::_assign_unit_code. Not user-editable.
    unit_code = models.TextField(null=True, blank=True, unique=True, db_column="unit_code")
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
        help_text="Salary at time of joining -baseline for increment tracking."
    )
    # bcrypt hash of the employee's mobile/self-service password. One-way by
    # design -it can be replaced but never read back, which is why the HR
    # portal's Mobile App Login page offers "reset" rather than "view".
    # NULL/empty means the employee has never completed Set Password, so they
    # have no way into the mobile app yet.
    password_hash = models.TextField(null=True, blank=True, db_column="password_hash")
    # Stamped by employee_login() on every successful mobile/self-service
    # sign-in. NULL means "no sign-in recorded" -note that for employees who
    # set their password before this field existed it stays NULL until their
    # next login, so the Mobile App Login page treats password_hash as the
    # historical "has access" signal and this as "last seen".
    last_mobile_login_at = models.DateTimeField(
        null=True, blank=True, db_column="last_mobile_login_at"
    )
    # Live location tracking (Geo Attendance feature) is opt-in per employee,
    # toggled by HR -never on by default. The mobile/web app only ever
    # starts sending location pings when it sees this true on the employee's
    # own profile (GET /employees/<id> -see _serialize_employee).
    location_tracking_enabled = models.BooleanField(
        default=False, db_column="location_tracking_enabled"
    )
    # "Co Emp" toggle (HR portal: Employees -> Co Emp tab). Marks an employee
    # as visible to an external application consuming this HRMS's API -off
    # by default, so nothing is exposed externally until HR explicitly opts
    # an employee in. Purely a visibility flag; it has no effect on anything
    # inside this application.
    co_emp_enabled = models.BooleanField(
        default=False, db_column="co_emp_enabled"
    )
    # Profile-detail fields (HR-managed, no self-service edit yet) — surfaced
    # on the mobile Employee Profile screen's header tags / detail cards.
    nationality = models.TextField(null=True, blank=True, db_column="nationality")
    workstation = models.TextField(null=True, blank=True, db_column="workstation")
    zone = models.TextField(null=True, blank=True, db_column="zone")
    staff_tier = models.TextField(null=True, blank=True, db_column="staff_tier")
    # Stamped whenever the employee's password_hash is replaced (Set Password
    # or Change Password) — powers the "Last updated N days ago" line under
    # Change Portal Password. NULL means never set.
    password_updated_at = models.DateTimeField(
        null=True, blank=True, db_column="password_updated_at"
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "employees"


# ──────────────────────────────────────────────
#  Family & Dependents
# ──────────────────────────────────────────────

class FamilyDependent(models.Model):
    RELATION_SPOUSE = "spouse"
    RELATION_CHILD = "child"
    RELATION_FATHER = "father"
    RELATION_MOTHER = "mother"
    RELATION_SIBLING = "sibling"
    RELATION_OTHER = "other"
    RELATION_CHOICES = [
        (RELATION_SPOUSE, "Spouse"),
        (RELATION_CHILD, "Child"),
        (RELATION_FATHER, "Father"),
        (RELATION_MOTHER, "Mother"),
        (RELATION_SIBLING, "Sibling"),
        (RELATION_OTHER, "Other"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="dependents"
    )
    name = models.TextField()
    relation = models.TextField(choices=RELATION_CHOICES)
    date_of_birth = models.DateField(null=True, blank=True, db_column="date_of_birth")
    is_insurance_nominee = models.BooleanField(default=False, db_column="is_insurance_nominee")
    covered_under_health_scheme = models.BooleanField(
        default=False, db_column="covered_under_health_scheme"
    )
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "family_dependents"


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
    can_approve_on_duty = models.BooleanField(default=True, db_column="can_approve_on_duty")
    can_approve_missing_punch = models.BooleanField(default=True, db_column="can_approve_missing_punch")
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
