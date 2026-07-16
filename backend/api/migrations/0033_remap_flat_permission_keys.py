"""
One-time cutover: Employees' sub-pages (Departments, Designations, Manage
Branch) used to be independent top-level permission keys. They're now
submodules nested under "employees" (dotted keys: "employees.departments",
etc.) so they can inherit the parent's level via resolve_permission()'s
cascading — see permission_registry.py.

Any Role saved before this change has the *old* flat keys sitting in its
permissions JSON, which are now dead: resolve_permission() only looks for
"employees.departments", not "departments". Left alone, those roles would
silently start inheriting Departments/Designations/Manage Branch from
whatever "employees" is set to, discarding whatever the admin had explicitly
configured for those three pages specifically.

This copies each old flat key's value onto its new dotted key (only when the
dotted key isn't already explicitly set — an admin who already re-saved a
role through the new tree UI wins) and drops the old flat key.
"""
from django.db import migrations

OLD_TO_NEW = {
    "departments": "employees.departments",
    "designations": "employees.designations",
    "branches": "employees.branches",
}


def remap_keys(apps, schema_editor):
    Role = apps.get_model("api", "Role")
    for role in Role.objects.all():
        permissions = role.permissions or {}
        changed = False
        for old_key, new_key in OLD_TO_NEW.items():
            if old_key in permissions:
                if new_key not in permissions:
                    permissions[new_key] = permissions[old_key]
                del permissions[old_key]
                changed = True
        if changed:
            role.permissions = permissions
            role.save(update_fields=["permissions"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0032_seed_legacy_hr_accounts"),
    ]

    operations = [
        migrations.RunPython(remap_keys, noop_reverse),
    ]
