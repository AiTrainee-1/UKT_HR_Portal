"""HR-portal logins, roles/permissions, sessions, audit log, notifications and push tokens."""

from django.db import models

from .core import Branch, Department, Employee


# ──────────────────────────────────────────────
#  User Management & RBAC
# ──────────────────────────────────────────────

class Role(models.Model):
    name = models.TextField(unique=True)  # HR Admin, HR Executive, Payroll Officer, etc.
    description = models.TextField(null=True, blank=True)
    # {module_key: "hidden" | "view" | "edit"} -one entry per sidebar module.
    # See api/permission_middleware.py MODULE_REGISTRY for the canonical module_key list
    # and how each is enforced against incoming requests.
    permissions = models.JSONField(default=dict)
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

    # ── Master-page controls (Account Management → Master) ────────────────
    # Presentation only. NOTHING in authentication, permissions or branch
    # scoping may ever read these -a hidden account logs in, carries its
    # role, and is audited exactly like a visible one. Hiding removes an
    # account from the Account Management list, nothing more.
    is_hidden = models.BooleanField(
        default=False, db_column="is_hidden",
        help_text="Hide from the Account Management list. Does NOT disable the account.",
    )
    #: Per-account capability grants, {feature_key: bool} -e.g. {"co": true}.
    #: Grant-only by design: these may ADD a capability the user's Role does
    #: not give, never remove one it does, so Role.permissions stays the
    #: single place that explains why something is unavailable.
    master_features = models.JSONField(
        default=dict, blank=True, db_column="master_features",
    )

    last_login = models.DateTimeField(null=True, blank=True, db_column="last_login")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "hr_users"


class LoginSession(models.Model):
    """
    One row per HR-portal login -the JWT itself is stateless (see
    jwt_utils.py), so this is what makes a login a revocable, listable
    "session": each token carries a `jti` claim matching one row here, and
    require_auth (auth.py) rejects any request whose jti is missing or
    revoked, regardless of the JWT's own expiry. Powers the Login Devices
    page and the POST /api/logout endpoint.
    """
    hr_user = models.ForeignKey(
        HRUser, on_delete=models.CASCADE, db_column="hr_user_id", related_name="login_sessions"
    )
    jti = models.TextField(unique=True, db_index=True)
    device_label = models.TextField(blank=True, default="")
    user_agent = models.TextField(blank=True, default="")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    last_seen_at = models.DateTimeField(auto_now_add=True, db_column="last_seen_at")
    revoked_at = models.DateTimeField(null=True, blank=True, db_column="revoked_at")

    class Meta:
        db_table = "login_sessions"
        indexes = [models.Index(fields=["hr_user", "revoked_at"])]


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
    # Stamped from the acting user's branch at write time. AuditLog has no
    # other foreign key -user_id is a bare integer -so there is no way to
    # derive the branch later. Rows written before this column stay null and
    # are visible to unscoped admins only; they cannot be attributed
    # honestly after the fact, and guessing would corrupt an audit trail.
    branch = models.ForeignKey(
        "Branch", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="audit_logs",
    )
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


class PushToken(models.Model):
    """
    An Expo push token for one of an employee's devices (mobile app only —
    the web app has no equivalent). An employee can have several, one per
    device they've logged in from; registering the same token again just
    reassigns it, covering the "different employee logs in on this phone"
    case. See api/signals.py for what actually sends the push.
    """
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="push_tokens"
    )
    token = models.TextField(unique=True)
    platform = models.TextField(default="expo")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "push_tokens"


# ──────────────────────────────────────────────
#  HR Portal login security (brute-force lockout + audit trail)
# ──────────────────────────────────────────────

class HrLoginAttempt(models.Model):
    """
    One row per HR Portal login attempt (success or failure), used to enforce
    a per-username lockout after repeated failures. Kept separate from the
    general AuditLog so lockout queries stay fast and simple.
    """
    username = models.TextField(db_index=True)
    ip_address = models.TextField(null=True, blank=True)
    success = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "hr_login_attempts"
        indexes = [models.Index(fields=["username", "created_at"])]
