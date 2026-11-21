"""Deterministic fixtures for the Playwright end-to-end suite (frontend/e2e).

Never runs against a real database: it refuses unless the configured database
name ends in "_e2e". Idempotent, so it is safe to re-run.

Calendar: February 2026 starts on a Sunday, so it has exactly 24 Mon-Sat
working days. Asha (salary 24,000) is present every one of them and must be
paid exactly 24,000; Ravi (salary 30,000) is present for the first 12 and must
be paid exactly 15,000. Meena has no salary and must be reported as skipped.

WhatsApp: every message type's Meta template is submitted to the local fake of Meta's WhatsApp Cloud API
(frontend/e2e/fake-meta.mjs, which approves at once) through the real create path, so the stack sends WhatsApp the way a
live server with approved templates does (codes included). Skipped when WhatsApp is not configured or the API address is
not this machine: nothing here ever reaches Meta.
"""

import bcrypt
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from api.models import AttendanceDayRecord, Branch, Department, Employee, HRUser

HR_USERNAME = "e2e_admin"
HR_PASSWORD = "E2e-Passw0rd!"
MONTH_START = "2026-02-01"


def _whatsapp_templates() -> str:
    """Submit each catalog type's draft template to the local fake Meta (see the module docstring). Returns a summary."""
    from api import whatsapp_catalog as catalog
    from api import whatsapp_cloud as cloud
    from api import whatsapp_templates as templates
    from api.models import WhatsAppTemplate

    if not (cloud.is_configured() and cloud.base_is_local()):
        return "WhatsApp templates: skipped (the WhatsApp Cloud API is not configured, or not a local fake)"
    done: dict[str, str] = {}
    for key, spec in catalog.TYPES.items():
        name = spec.default_template_name
        if not name or name in done:
            continue
        if WhatsAppTemplate.objects.filter(name=name, status=templates.APPROVED).exists():
            done[name] = templates.APPROVED
            continue
        checked = templates.validate(templates.draft_for(key))
        if not checked.ok:
            done[name] = f"draft refused: {checked.first_error()}"
            continue
        try:
            row, _message = templates.create(checked.clean)
            done[name] = row.status
        except templates.TemplateError as exc:
            done[name] = f"not created: {exc.message}"
    problems = {name: state for name, state in done.items() if state != templates.APPROVED}
    summary = f"WhatsApp templates: {len(done) - len(problems)} of {len(done)} approved at the local fake"
    return summary + "".join(f"\n  {name}: {state}" for name, state in sorted(problems.items()))


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

        def employee(code, first, last, salary, phone):
            emp, _ = Employee.objects.update_or_create(
                employee_code=code,
                defaults={
                    "first_name": first,
                    "last_name": last,
                    "employment_type": "staff",
                    "phone": phone,
                    "status": "active",
                    "salary_type": "monthly",
                    "salary_amount": salary,
                    "department": dept,
                    "branch": branch,
                },
            )
            return emp

        asha = employee("E2E001", "Asha", "Kumar", "24000.00", "9000000001")
        ravi = employee("E2E002", "Ravi", "Nair", "30000.00", "9000000002")
        employee("E2E003", "Meena", "Nosalary", None, "9000000003")

        days = _working_days()
        for emp, present in ((asha, days), (ravi, days[:12])):
            for d in present:
                AttendanceDayRecord.objects.update_or_create(
                    employee=emp,
                    date=d,
                    defaults={"status": "present", "shifts_earned": "1.00", "source": "manual"},
                )

        self.stdout.write(_whatsapp_templates())
        self.stdout.write(self.style.SUCCESS(f"Seeded e2e fixtures into {db_name}"))
