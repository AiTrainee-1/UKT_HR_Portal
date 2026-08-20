"""
One-time cutover (already completed long ago): the HR Portal used to
authenticate MD/Director accounts straight from .env (MD_USERNAME/PASSWORD,
DIRECTOR1/2_USERNAME/PASSWORD) -see the removed settings.HR_ACCOUNTS. This
migration used to seed matching HRUser rows from those env vars on cutover
day so MD/Directors wouldn't lose access.

That cutover is long finished, and the project standard now is: the ONLY
account ever created automatically (via ApiConfig._bootstrap_admin_account
in apps.py, from ADMIN_USERNAME/ADMIN_PASSWORD) is the single admin account.
No other user/employee/demo data may be created automatically by a migration
or app-startup path -see the incident where this migration's legacy env-var
seeding produced unexpected extra login accounts on a fresh setup. This
function is intentionally left a permanent no-op so `manage.py migrate`
never creates login accounts again, on this or any future database. Kept in
the migration graph (rather than deleted) per Django convention -don't
remove/renumber an already-applied migration.
"""
from django.db import migrations


def seed_legacy_accounts(apps, schema_editor):
    return  # permanent no-op -see module docstring


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0031_monthlyshiftsummary_permission_overage_count"),
    ]

    operations = [
        migrations.RunPython(seed_legacy_accounts, noop_reverse),
    ]
