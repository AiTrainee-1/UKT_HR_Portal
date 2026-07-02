"""
Biometric Attendance Sync — eSSL e2008
=======================================
Connects to the eSSL device over LAN (ZKTeco protocol, port 4370),
pulls attendance punch records, and writes them to attendance_logs +
attendance tables.

Usage:
  python manage.py sync_biometric              # last 3 days (default / cron use)
  python manage.py sync_biometric --days 7     # last 7 days
  python manage.py sync_biometric --today      # today only
  python manage.py sync_biometric --all        # ALL records (first-time full import)

Environment variables (backend/.env):
  BIOMETRIC_DEVICE_IP       IP address of the eSSL device (required)
  BIOMETRIC_DEVICE_PORT     TCP port — default 4370
  BIOMETRIC_DEVICE_PASSWORD Device comm password — default 0
"""

import os
from datetime import date, datetime, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from api.models import Attendance, AttendanceLog, Employee


# Status codes sent by eSSL e2008
# 0 = Check-In,  1 = Check-Out,  255 = undefined (treat as Check-In)
_STATUS_MAP = {
    0: AttendanceLog.PUNCH_IN,
    1: AttendanceLog.PUNCH_OUT,
    4: AttendanceLog.PUNCH_IN,   # Overtime-In → treat as IN
    5: AttendanceLog.PUNCH_OUT,  # Overtime-Out → treat as OUT
}


class Command(BaseCommand):
    help = "Pull attendance records from eSSL e2008 biometric device via ZK protocol"

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group()
        group.add_argument(
            "--days", type=int, default=3,
            help="Sync records from the last N days (default: 3)",
        )
        group.add_argument(
            "--today", action="store_true",
            help="Sync today's records only",
        )
        group.add_argument(
            "--all", dest="sync_all", action="store_true",
            help="Sync ALL records stored on device (use for first-time import)",
        )

    def handle(self, *args, **options):
        device_ip   = os.environ.get("BIOMETRIC_DEVICE_IP", "").strip()
        device_port = int(os.environ.get("BIOMETRIC_DEVICE_PORT", "4370"))
        device_pass = int(os.environ.get("BIOMETRIC_DEVICE_PASSWORD", "0"))

        if not device_ip:
            raise CommandError(
                "BIOMETRIC_DEVICE_IP is not set in backend/.env\n"
                "Find your device IP on the device: Main Menu → COMM. → Ethernet → IP Address"
            )

        # Determine date filter
        if options["today"]:
            date_from = date.today()
        elif options["sync_all"]:
            date_from = None
        else:
            date_from = date.today() - timedelta(days=options["days"])

        self.stdout.write(
            self.style.MIGRATE_HEADING(
                f"\nConnecting to eSSL e2008 at {device_ip}:{device_port} ..."
            )
        )

        try:
            from zk import ZK
        except ImportError:
            raise CommandError(
                "pyzk is not installed.\n"
                "Run: pip install pyzk"
            )

        zk = ZK(device_ip, port=device_port, timeout=10, password=device_pass, force_udp=False)
        conn = None

        try:
            conn = zk.connect()
            conn.disable_device()  # pause device during pull to avoid partial reads

            self.stdout.write("  Connected. Pulling attendance records...")
            raw_records = conn.get_attendance()
            self.stdout.write(f"  Device returned {len(raw_records)} total records.")

        except Exception as exc:
            raise CommandError(
                f"Could not connect to device at {device_ip}:{device_port}\n"
                f"Error: {exc}\n\n"
                "Check:\n"
                "  1. BIOMETRIC_DEVICE_IP is correct in .env\n"
                "  2. Both server and device are on the same LAN\n"
                "  3. Port 4370 is not blocked by any firewall\n"
                "  4. Device is powered on and network cable is connected"
            )
        finally:
            if conn:
                conn.enable_device()
                conn.disconnect()

        # Build employee lookup: user_id (string) → Employee
        # Match priority:
        #   1. biometric_device_id (explicit HR-to-device mapping)
        #   2. employee_code exact match
        #   3. numeric PK exact match (str)
        #   4. numeric PK after stripping leading zeros ("001" → 1)
        active_employees = list(Employee.objects.filter(status="active"))

        all_employees_by_device_id = {
            str(e.biometric_device_id).strip(): e
            for e in active_employees
            if e.biometric_device_id
        }
        all_employees = {
            str(e.employee_code): e
            for e in active_employees
        }
        all_employees_by_id = {
            str(e.id): e
            for e in active_employees
        }

        created   = 0
        skipped   = 0
        not_found = set()

        for rec in raw_records:
            # rec.user_id  : string — what was entered on device as Person ID
            # rec.timestamp: datetime
            # rec.status   : int (0=IN, 1=OUT, 255=unknown)

            # Skip if outside our date window
            if date_from and rec.timestamp.date() < date_from:
                skipped += 1
                continue

            uid = str(rec.user_id).strip()
            emp = (
                all_employees_by_device_id.get(uid)
                or all_employees.get(uid)
                or all_employees_by_id.get(uid)
            )
            # Numeric fallback: "001" → try matching employee pk=1
            if not emp and uid.isdigit():
                emp = all_employees_by_id.get(str(int(uid)))

            if not emp:
                not_found.add(uid)
                skipped += 1
                continue

            punch_date = rec.timestamp.date()
            punch_time = rec.timestamp.time().replace(microsecond=0)
            punch_type = _STATUS_MAP.get(rec.status, AttendanceLog.PUNCH_IN)

            # Avoid creating duplicate log for exact same punch
            _, was_created = AttendanceLog.objects.get_or_create(
                employee   = emp,
                date       = punch_date,
                punch_time = punch_time,
                punch_type = punch_type,
                defaults   = {"source": f"biometric:essl:{device_ip}"},
            )

            if was_created:
                created += 1
                # Keep the daily summary table in sync
                Attendance.objects.update_or_create(
                    employee = emp,
                    date     = str(punch_date),
                    defaults = {"present": True},
                )
            else:
                skipped += 1

        # Report
        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"  ✓ New records created : {created}"))
        self.stdout.write(f"  — Skipped (duplicate or out of range) : {skipped}")

        if not_found:
            self.stdout.write(
                self.style.WARNING(
                    f"\n  ⚠ {len(not_found)} device User ID(s) had no matching employee:\n"
                    + "\n".join(f"    - '{uid}'" for uid in sorted(not_found))
                    + "\n\n  Fix: make sure the Person ID on the device matches the"
                    + "\n  employee_code in the HR Portal (e.g. EMP042)."
                )
            )

        self.stdout.write("")
