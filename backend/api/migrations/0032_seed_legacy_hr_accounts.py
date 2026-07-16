"""
One-time cutover: the HR Portal used to authenticate MD/Director accounts
straight from .env (MD_USERNAME/PASSWORD, DIRECTOR1/2_USERNAME/PASSWORD) —
see the removed settings.HR_ACCOUNTS. Now that login goes through the HRUser
table (Account Management), this migration seeds matching HRUser rows from
those env vars — if they're still present in .env at migrate time — so MD and
Directors don't lose access on cutover day. A "Full Access" Role (every
module = edit) is created to mirror their previous unrestricted access;
Admin can rename accounts / dial back permissions afterward from the portal.

No-op if the env vars are absent (e.g. running this on a fresh install, or
after .env has already been cleaned up).
"""
import os

import bcrypt
from django.db import migrations


LEGACY_ACCOUNTS = [
    ("MD_USERNAME", "MD_PASSWORD", "Managing Director"),
    ("DIRECTOR1_USERNAME", "DIRECTOR1_PASSWORD", "Director"),
    ("DIRECTOR2_USERNAME", "DIRECTOR2_PASSWORD", "Director"),
]


def seed_legacy_accounts(apps, schema_editor):
    Role = apps.get_model("api", "Role")
    HRUser = apps.get_model("api", "HRUser")

    to_create = []
    for user_env, password_env, label in LEGACY_ACCOUNTS:
        username = os.environ.get(user_env, "").strip()
        password = os.environ.get(password_env, "").strip()
        if username and password:
            to_create.append((username, password, label))

    if not to_create:
        return

    full_access_role, _ = Role.objects.get_or_create(
        name="Full Access",
        defaults={
            "description": "Every module editable — mirrors pre-cutover MD/Director access.",
            "permissions": {},  # filled in below once the module list is known at runtime
            "is_system": True,
        },
    )
    # Populate permissions here (rather than a hardcoded literal) so this
    # migration doesn't need to be kept in sync with the module list by hand.
    from api.permission_registry import all_module_keys
    full_access_role.permissions = {key: "edit" for key in all_module_keys()}
    full_access_role.save()

    for username, password, label in to_create:
        if HRUser.objects.filter(username__iexact=username).exists():
            continue
        pwd_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
        HRUser.objects.create(
            username=username,
            full_name=label,
            password_hash=pwd_hash,
            role=full_access_role,
            is_active=True,
            is_super_admin=False,
        )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0031_monthlyshiftsummary_permission_overage_count"),
    ]

    operations = [
        migrations.RunPython(seed_legacy_accounts, noop_reverse),
    ]
