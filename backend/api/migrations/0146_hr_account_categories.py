# HR Manager / HR Assistant account categories (owner 2026-11-10, api/hr_access.py).
#
# Additive only. New columns with database defaults: hr_users.category ("admin" for every existing account, the Super
# Admin and the MD included), hr_users.permission_overrides (empty), roles.approvals (NULL = the role keeps the old rule,
# approve = edit on the module), roles.category ("" = for any account) and audit_logs.hr_user_id (NULL on every older row).
# A backend still running the previous release keeps working: it never names these columns.
#
# Data: two NEW editable starter roles, "HR Manager - default" and "HR Assistant - default", each created only when no role
# of that name exists yet. No existing role or account is read or changed. Reversing the migration removes the two roles
# only if no account uses them.

from django.db import migrations, models

ALL_TOP_LEVEL = (
    "dashboard",
    "employees",
    "attendance",
    "shifts",
    "leave",
    "casual_leave",
    "missing_punch",
    "requests",
    "promotion",
    "increment",
    "bonus",
    "id_cards",
    "recruitment",
    "payroll",
    "production_payroll",
    "compensation",
    "salary",
    "salary_slip",
    "settlement",
    "reports",
    "user_management",
    "login_devices",
    "mobile_app_login",
    "whatsapp_control",
    "sms_control",
    "gmail_control",
    "chat",
    "notifications",
    "geo_attendance",
    "outpass_visitors",
    "settings",
)

APPROVAL_KEYS = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "attendance_correction",
    "on_duty",
    "on_duty_punch",
    "outpass",
    "request",
    "resignation",
    "advance",
)


def _levels(edit=(), view=(), extra=None):
    out = {key: "hidden" for key in ALL_TOP_LEVEL}
    out.update({key: "view" for key in view})
    out.update({key: "edit" for key in edit})
    out.update(extra or {})
    return out


STARTER_ROLES = (
    {
        "name": "HR Manager - default",
        "category": "hr_manager",
        "description": (
            "Starter role for HR Managers: works across the HR operations pages and approves every kind of request. "
            "No Settings, User Management or system administration pages. Edit it to suit."
        ),
        "permissions": _levels(
            edit=(
                "dashboard",
                "employees",
                "attendance",
                "shifts",
                "leave",
                "casual_leave",
                "missing_punch",
                "requests",
                "promotion",
                "increment",
                "bonus",
                "id_cards",
                "recruitment",
                "payroll",
                "production_payroll",
                "compensation",
                "salary",
                "salary_slip",
                "settlement",
                "reports",
                "geo_attendance",
                "outpass_visitors",
                "notifications",
                "chat",
            ),
            # branches are company structure: a manager sees them but does not add or remove them
            extra={"employees.branches": "view"},
        ),
        "approvals": {key: True for key in APPROVAL_KEYS},
    },
    {
        "name": "HR Assistant - default",
        "category": "hr_assistant",
        "description": (
            "Starter role for HR Assistants: permissions, leave, compensation, payroll and attendance editing. Approves "
            "leave and permission requests only; missing punches and attendance edits always go to an HR Manager."
        ),
        "permissions": _levels(
            edit=(
                "requests",
                "leave",
                "casual_leave",
                "compensation",
                "payroll",
                "production_payroll",
                "attendance",
            ),
            view=("dashboard", "employees", "shifts", "missing_punch", "salary", "salary_slip"),
        ),
        "approvals": {key: key in ("leave", "permission") for key in APPROVAL_KEYS},
    },
)


def add_starter_roles(apps, schema_editor):
    Role = apps.get_model("api", "Role")
    for spec in STARTER_ROLES:
        if Role.objects.filter(name__iexact=spec["name"]).exists():
            continue  # never touch a role that is already there
        Role.objects.create(
            name=spec["name"],
            description=spec["description"],
            permissions=spec["permissions"],
            approvals=spec["approvals"],
            category=spec["category"],
        )


def remove_starter_roles(apps, schema_editor):
    Role = apps.get_model("api", "Role")
    for spec in STARTER_ROLES:
        Role.objects.filter(name=spec["name"], category=spec["category"], users__isnull=True).delete()


class Migration(migrations.Migration):
    # Not one transaction: undoing it deletes the starter roles and then drops the roles columns, and Postgres refuses
    # an ALTER TABLE on "roles" while that delete's foreign-key checks are still pending in the same transaction. The
    # data step stays atomic on its own (RunPython atomic=True); the column changes are single statements.
    atomic = False

    dependencies = [
        ("api", "0145_payroll_month_workflow"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="approvals",
            field=models.JSONField(blank=True, db_column="approvals", default=None, null=True),
        ),
        migrations.AddField(
            model_name="role",
            name="category",
            field=models.CharField(blank=True, db_column="category", db_default="", default="", max_length=20),
        ),
        migrations.AddField(
            model_name="hruser",
            name="category",
            field=models.CharField(db_column="category", db_default="admin", default="admin", max_length=20),
        ),
        migrations.AddField(
            model_name="hruser",
            name="permission_overrides",
            field=models.JSONField(blank=True, db_column="permission_overrides", default=dict, null=True),
        ),
        migrations.AddField(
            model_name="auditlog",
            name="hr_user_id",
            field=models.IntegerField(blank=True, db_column="hr_user_id", db_index=True, null=True),
        ),
        migrations.RunPython(add_starter_roles, remove_starter_roles, atomic=True),
    ]
