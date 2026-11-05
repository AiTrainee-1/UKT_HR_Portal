"""
Run the MD auto attendance now (the same job the scheduler runs every day at 8 PM).

    python manage.py md_auto_attendance --dry-run        # what it would add, nothing written
    python manage.py md_auto_attendance                  # fill everything since the start date (1 Jan 2026) up to now
    python manage.py md_auto_attendance --month 2026-10  # fill a whole past month (only when HR asks for it)
"""

import calendar
from datetime import date, datetime, time

from django.core.management.base import BaseCommand, CommandError

from api import md_auto_attendance


class Command(BaseCommand):
    help = "Generate the listed MD employees' Full-Day Present punches (since the start date up to now, or --month)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Show what would be added; write nothing.")
        parser.add_argument("--month", help="A past month to fill completely, as YYYY-MM.")

    def handle(self, *args, **options):
        now, first = None, None
        if options.get("month"):
            try:
                year, month = (int(part) for part in options["month"].split("-"))
                first = date(year, month, 1)
            except (ValueError, TypeError) as exc:
                raise CommandError("--month must be YYYY-MM") from exc
            from api.clock import ist_now

            last = date(year, month, calendar.monthrange(year, month)[1])
            if last >= ist_now().date():
                raise CommandError("--month is for a past month; the current month is filled without it")
            now = datetime.combine(last, time(23, 59, 59))
        summary = md_auto_attendance.run(now=now, first=first, dry_run=options["dry_run"])
        for code, days in summary["employees"].items():
            self.stdout.write(f"{code}: {len(days)} day(s) {', '.join(days) if days else ''}")
        verb = "would add" if options["dry_run"] else "added"
        self.stdout.write(self.style.SUCCESS(f"{verb} {summary['punches']} punch(es)"))
