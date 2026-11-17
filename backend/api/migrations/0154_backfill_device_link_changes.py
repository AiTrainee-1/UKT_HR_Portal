"""Link / Unlink -> Modified (owner 2026-11-17): the history starts with the changes made before it existed. Every earlier
change was written to the audit log by set_employee_device_links, with the unlinked devices before and after (by name):
one history row per device that changed, at the audit entry's time and by its user. Only adds rows; nothing else is
touched, and running it again adds nothing (an entry already turned into rows is skipped)."""

from django.db import migrations


def backfill(apps, schema_editor):
    AuditLog = apps.get_model("api", "AuditLog")
    Employee = apps.get_model("api", "Employee")
    BiometricDevice = apps.get_model("api", "BiometricDevice")
    Change = apps.get_model("api", "EmployeeDeviceLinkChange")
    if Change.objects.exists():
        return  # the history has begun: an earlier run (or real changes) already wrote it
    devices = {name: pk for pk, name in BiometricDevice.objects.values_list("pk", "name")}
    employees = set(Employee.objects.values_list("pk", flat=True))
    entries = AuditLog.objects.filter(record_description__startswith="Device links of").order_by("created_at", "id")
    for entry in entries:
        if entry.record_id not in employees:
            continue
        before = set((entry.old_values or {}).get("unlinked") or [])
        after = set((entry.new_values or {}).get("unlinked") or [])
        rows = [(name, "unlink") for name in sorted(after - before)] + [(name, "link") for name in sorted(before - after)]
        for name, action in rows:
            row = Change.objects.create(
                employee_id=entry.record_id,
                device_id=devices.get(name),
                device_name=name,
                action=action,
                changed_by=entry.user_name or "",
            )
            Change.objects.filter(pk=row.pk).update(created_at=entry.created_at)


class Migration(migrations.Migration):
    dependencies = [("api", "0153_device_control_history")]

    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
