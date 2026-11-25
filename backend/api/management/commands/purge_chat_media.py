"""
Chat media expiry (CLI / manual / ops-cron), owner 2026-11-25
=============================================================
Deletes the files of GIFs and voice messages whose expiry time has passed (Chat media expiry, set by HR on the HR chat
page, 7 days by default). Same function the scheduled job (chat_media_scheduler.py) runs every 30 minutes.

Usage:
  python manage.py purge_chat_media
"""

from django.core.management.base import BaseCommand

from api.chat_media import sweep_expired


class Command(BaseCommand):
    help = "Delete the files of chat GIFs and voice messages that have expired"

    def handle(self, *args, **options):
        result = sweep_expired()
        if result["deleted"]:
            self.stdout.write(self.style.SUCCESS(f"Deleted {result['deleted']} expired chat file(s)."))
        else:
            self.stdout.write("No expired chat files to delete.")
