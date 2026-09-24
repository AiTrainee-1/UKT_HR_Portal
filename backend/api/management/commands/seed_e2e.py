"""Deterministic fixtures for the Playwright end-to-end suite (frontend/e2e).

Never runs against a real database: it refuses unless the configured database
name ends in "_e2e". Idempotent, so it is safe to re-run.

Calendar: February 2026 starts on a Sunday, so it has exactly 24 Mon-Sat
working days. Asha (salary 24,000) is present every one of them and must be
paid exactly 24,000; Ravi (salary 30,000) is present for the first 12 and must
be paid exactly 15,000. Meena has no salary and must be reported as skipped.
"""

import bcrypt
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from api.models import AttendanceDayRecord, Branch, Department, Employee, HRUser

HR_USERNAME = "e2e_admin"
HR_PASSWORD = "E2e-Passw0rd!"
MONTH_START = "2026-02-01"


def _working_days():
    from datetime import date, timedelta

    d, out = date(2026, 2, 1), []
    while d.month == 2:
        if d.weekday() != 6:
            out.append(d)
        d += timedelta(days=1)
    return out


class Command(BaseCommand):
    help = "Seed the fixtures the Playwright e2e suite depends on (database name must end in _e2e)."

    def handle(self, *args, **options):
        db_name = settings.DATABASES["default"]["NAME"]
        if not str(db_name).endswith("_e2e"):
            raise CommandError(f"Refusing to seed '{db_name}': the e2e database name must end in _e2e.")

        HRUser.objects.update_or_create(
            username=HR_USERNAME,
            defaults={
                "full_name": "E2E Admin",
                "password_hash": bcrypt.hashpw(HR_PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode(),
                "is_super_admin": True,
                "is_active": True,
            },
        )

        branch, _ = Branch.objects.get_or_create(
            name="E2E Head Office", defaults={"code": "E2E", "is_head_office": True}
        )
        dept, _ = Department.objects.get_or_create(name="Stitching", branch=branch)

        def employee(code, first, last, salary):
            emp, _ = Employee.objects.update_or_create(
                employee_code=code,
                defaults={
                    "first_name": first,
                    "last_name": last,
                    "employment_type": "staff",
                    "status": "active",
                    "salary_type": "monthly",
                    "salary_amount": salary,
                    "department": dept,
                    "branch": branch,
                },
            )
            return emp

        asha = employee("E2E001", "Asha", "Kumar", "24000.00")
        ravi = employee("E2E002", "Ravi", "Nair", "30000.00")
        employee("E2E003", "Meena", "Nosalary", None)

        days = _working_days()
        for emp, present in ((asha, days), (ravi, days[:12])):
            for d in present:
                AttendanceDayRecord.objects.update_or_create(
                    employee=emp,
                    date=d,
                    defaults={"status": "present", "shifts_earned": "1.00", "source": "manual"},
                )

        self.stdout.write(self.style.SUCCESS(f"Seeded e2e fixtures into {db_name}"))
