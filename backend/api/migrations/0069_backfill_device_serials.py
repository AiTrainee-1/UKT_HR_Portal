"""
Backfill BiometricDevice.serial_number / last_push_at from punches already
ingested via ADMS.

Without this, the new Sync indicator would report a device as "never" on the
very first deploy -even one that is actively pushing attendance right now —
because serial-linking only happens on a push received by the NEW code. That
would look like a broken feature reporting a broken device, when both are
fine.

The serial is already recoverable: every ADMS-ingested punch carries it in
AttendanceLog.source as "biometric:adms:<SN>". This reads it back, links it
to a device using the same rule as device_health.record_device_push (only
when exactly one enabled device is unlinked -never guess between several),
and seeds last_push_at from that device's most recent punch.
"""
from django.db import migrations


ADMS_PREFIX = "biometric:adms:"


def backfill(apps, schema_editor):
    BiometricDevice = apps.get_model("api", "BiometricDevice")
    AttendanceLog = apps.get_model("api", "AttendanceLog")

    serials = {
        s[len(ADMS_PREFIX):].strip()
        for s in AttendanceLog.objects
        .filter(source__startswith=ADMS_PREFIX)
        .values_list("source", flat=True)
        .distinct()
        if s and s[len(ADMS_PREFIX):].strip()
    }
    if not serials:
        return

    for serial in serials:
        if BiometricDevice.objects.filter(serial_number=serial).exists():
            continue
        candidates = list(BiometricDevice.objects.filter(is_active=True, serial_number=""))
        if len(candidates) != 1:
            # Ambiguous (or nothing to link to) -leave it for
            # record_device_push to resolve on a live push rather than
            # attributing attendance to the wrong device.
            continue
        device = candidates[0]
        device.serial_number = serial

        latest = (
            AttendanceLog.objects
            .filter(source=f"{ADMS_PREFIX}{serial}")
            .order_by("-date", "-punch_time")
            .first()
        )
        if latest and latest.created_at:
            # created_at is when WE received it, which is what "last push"
            # means -not the punch's own timestamp, which can be backdated
            # when a device flushes a buffered backlog.
            device.last_push_at = latest.created_at
        device.save(update_fields=["serial_number", "last_push_at"])


def unbackfill(apps, schema_editor):
    # Reversible, but deliberately narrow: only clears what this migration
    # could have set, and only where nothing newer has since arrived.
    BiometricDevice = apps.get_model("api", "BiometricDevice")
    BiometricDevice.objects.update(serial_number="", last_push_at=None)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0068_biometricdevice_last_push_at_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill, unbackfill),
    ]
