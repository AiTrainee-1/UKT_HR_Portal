"""
Restore Backup (CLI, spawned by backup_views.py::backup_restore_run)
========================================================================
Runs the actual full-application restore. Deliberately a separate OS
process from the Django app that triggered it — the web request's own DB
connection cannot survive the schema drop this performs, and Postgres DDL
against a schema other connections are actively using is not something
that's safe to attempt from inside the request/response cycle.

Writes progress to restore_status.json (next to manage.py) at each step so
GET /api/backup/restore/status can report real progress even while the
database itself is mid-restore and briefly unreachable. Always removes the
maintenance-mode marker on exit, success or failure, so a crash here can
never leave the whole app permanently unavailable.

Usage:
  python manage.py restore_backup --file <staged_zip_path>
"""

import json
import os
from datetime import datetime

from django.conf import settings as dj_settings
from django.core.management.base import BaseCommand, CommandError

from api import backup_service

_STATUS_FILE = os.path.join(str(dj_settings.BASE_DIR), "restore_status.json")
_MAINTENANCE_MARKER = os.path.join(str(dj_settings.BASE_DIR), "maintenance.lock")


class Command(BaseCommand):
    help = "Restore the application (database + all uploaded files) from a full backup zip"

    def add_arguments(self, parser):
        parser.add_argument("--file", type=str, required=True, help="Path to the staged backup zip")

    def _write_status(self, step: str, detail: str, ok: bool | None) -> None:
        with open(_STATUS_FILE, "w") as f:
            json.dump({"step": step, "detail": detail, "ok": ok, "updatedAt": datetime.now().isoformat()}, f)

    def handle(self, *args, **options):
        zip_path = options["file"]
        self.stdout.write(self.style.MIGRATE_HEADING(f"Restoring from {zip_path}"))

        def report(step: str, detail: str) -> None:
            self.stdout.write(f"  {step}: {detail}")
            self._write_status(step, detail, ok=None)

        try:
            backup_service.restore_from_zip(zip_path, status_callback=report)
            self._write_status("done", "Restore complete", ok=True)
            self.stdout.write(self.style.SUCCESS("Restore complete."))
        except backup_service.BackupServiceError as exc:
            self._write_status("failed", str(exc), ok=False)
            self.stdout.write(self.style.ERROR(f"Restore failed: {exc}"))
            raise CommandError(str(exc))
        except Exception as exc:
            self._write_status("failed", f"Unexpected error: {exc}", ok=False)
            self.stdout.write(self.style.ERROR(f"Restore failed unexpectedly: {exc}"))
            raise CommandError(str(exc))
        finally:
            if os.path.exists(_MAINTENANCE_MARKER):
                try:
                    os.remove(_MAINTENANCE_MARKER)
                except OSError:
                    pass
