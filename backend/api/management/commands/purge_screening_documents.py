"""
Screening Document Retention (CLI / manual / ops-cron)
=========================================================
Purges resume files for candidates who are older than the 10-day retention
window and were neither selected nor rejected. Same underlying function the
scheduled job (screening_cleanup_scheduler.py) calls automatically once a
day -this command exists for manual runs and external cron use.

Usage:
  python manage.py purge_screening_documents
"""

from django.core.management.base import BaseCommand

from api.screening_cleanup import purge_expired_screening_documents


class Command(BaseCommand):
    help = "Delete resume files for non-selected, non-rejected screening candidates older than 10 days"

    def handle(self, *args, **options):
        result = purge_expired_screening_documents()
        if result["purged"]:
            self.stdout.write(self.style.SUCCESS(f"Purged {result['purged']} expired resume file(s)."))
        else:
            self.stdout.write("No expired resume files to purge.")
