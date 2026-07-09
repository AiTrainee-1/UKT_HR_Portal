"""
Biometric Attendance Sync (CLI / cron)
=======================================
Pulls attendance punch records from biometric device(s) and writes them to
attendance_logs + attendance tables. Device connection logic lives in
api.biometric_sync so the HR "Sync Biometric" API uses the exact same path.

Device sources (both fully supported, merged together):
  • backend/.env  — BIOMETRIC_DEVICE_IP / PORT / PASSWORD (legacy, still works)
  • Settings → Devices — any number of BiometricDevice rows added from the UI

Usage:
  python manage.py sync_biometric                    # last 3 days, ALL sources (.env + enabled Settings devices)
  python manage.py sync_biometric --device-id 2      # one specific Settings device (BiometricDevice.pk)
  python manage.py sync_biometric --device-id env    # only the .env-configured device
  python manage.py sync_biometric --days 7           # last 7 days
  python manage.py sync_biometric --today             # today only
  python manage.py sync_biometric --all               # ALL records (first-time import)
"""

from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from api.biometric_sync import BiometricSyncError, get_sync_targets, pull_from_device


class Command(BaseCommand):
    help = "Pull attendance records from biometric device(s) via ZK protocol"

    def add_arguments(self, parser):
        parser.add_argument(
            "--device-id", type=str, default=None,
            help="Settings device pk, or 'env' for the .env device. Default: all sources merged.",
        )
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--days", type=int, default=3, help="Sync records from the last N days (default: 3)")
        group.add_argument("--today", action="store_true", help="Sync today's records only")
        group.add_argument("--all", dest="sync_all", action="store_true", help="Sync ALL records on device")

    def handle(self, *args, **options):
        if options["today"]:
            date_from = date.today()
        elif options["sync_all"]:
            date_from = None
        else:
            date_from = date.today() - timedelta(days=options["days"])

        try:
            targets = get_sync_targets(options["device_id"])
        except BiometricSyncError as exc:
            raise CommandError(str(exc))

        total_created = 0
        total_skipped = 0
        not_found: set[str] = set()
        suspicious_days: list[dict] = []
        failures: list[str] = []

        for t in targets:
            if t.get("config_error"):
                failures.append(f"{t['label']}: {t['config_error']}")
                self.stdout.write(self.style.ERROR(f"\n{t['label']}: {t['config_error']}"))
                continue
            self.stdout.write(self.style.MIGRATE_HEADING(f"\nConnecting to {t['label']} at {t['host']}:{t['port']} ..."))
            try:
                result = pull_from_device(t["host"], t["port"], t["password"], date_from, device_label=t["label"])
            except BiometricSyncError as exc:
                failures.append(f"{t['label']}: {exc}")
                self.stdout.write(self.style.ERROR(f"  ✗ {exc}"))
                continue

            if t["device"] is not None:
                t["device"].last_synced_at = timezone.now()
                t["device"].save(update_fields=["last_synced_at"])

            total_created += result["created"]
            total_skipped += result["skipped"]
            not_found |= result["notFound"]
            suspicious_days.extend(result.get("suspiciousDays", []))
            self.stdout.write(f"  Device returned {result['total']} total records.")
            self.stdout.write(self.style.SUCCESS(f"  New records created : {result['created']}"))
            self.stdout.write(f"  Skipped (duplicate or out of range) : {result['skipped']}")

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"  New records created : {total_created}"))
        self.stdout.write(f"  Skipped (duplicate or out of range) : {total_skipped}")

        if not_found:
            self.stdout.write(
                self.style.WARNING(
                    f"\n  {len(not_found)} device User ID(s) had no matching employee:\n"
                    + "\n".join(f"    - '{uid}'" for uid in sorted(not_found))
                    + "\n\n  Fix: make sure the Person ID on the device matches the"
                    + "\n  employee_code in the HR Portal (e.g. EMP042)."
                )
            )

        if suspicious_days:
            from api.models import Employee
            emp_ids = {d["employeeId"] for d in suspicious_days}
            names = {
                e.id: f"{e.first_name} {e.last_name}".strip()
                for e in Employee.objects.filter(id__in=emp_ids)
            }
            self.stdout.write(
                self.style.WARNING(
                    f"\n  {len(suspicious_days)} suspicious day(s) with 6+ punches "
                    "(likely two people sharing one Device User ID — check enrollment on the device):"
                )
            )
            for d in sorted(suspicious_days, key=lambda x: x["date"]):
                name = names.get(d["employeeId"], f"id={d['employeeId']}")
                self.stdout.write(f"    - {d['date']}: {name} — {d['punches']} punches")

        if failures and total_created == 0 and len(failures) == len(targets):
            raise CommandError("All devices failed: " + "; ".join(failures))
        self.stdout.write("")
