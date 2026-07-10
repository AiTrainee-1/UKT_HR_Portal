"""
Database Backup (Settings → Backup)
===================================
Runs a real PostgreSQL dump via pg_dump into the HR-chosen directory, with
the date and time in the filename. Plain-SQL format so a backup can be
restored with nothing more than `psql -f <file>`.

The directory is persisted on PayrollSettings (backup_directory) via the
normal payroll-settings endpoint; this module only runs/list backups.
"""

import glob
import os
import shutil
import subprocess
from datetime import datetime

from django.conf import settings as dj_settings
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .audit_utils import log_action
from .models import PayrollSettings

_BACKUP_PREFIX = "UKTex_DB_backup_"


def _find_pg_dump() -> str | None:
    """pg_dump from PATH, or the newest PostgreSQL install on Windows."""
    found = shutil.which("pg_dump")
    if found:
        return found
    candidates = sorted(
        glob.glob(r"C:\Program Files\PostgreSQL\*\bin\pg_dump.exe"),
        reverse=True,  # highest version first
    )
    return candidates[0] if candidates else None


def _list_backups(directory: str) -> list[dict]:
    if not directory or not os.path.isdir(directory):
        return []
    entries = []
    for path in glob.glob(os.path.join(directory, f"{_BACKUP_PREFIX}*.sql")):
        try:
            stat = os.stat(path)
            entries.append({
                "file": os.path.basename(path),
                "sizeBytes": stat.st_size,
                "createdAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
        except OSError:
            continue
    entries.sort(key=lambda e: e["createdAt"], reverse=True)
    return entries[:20]


@api_view(["GET"])
@require_hr
def backup_status(request: Request) -> Response:
    """Saved backup directory + the most recent backups found in it."""
    ps = PayrollSettings.get()
    return Response({
        "backupDirectory": ps.backup_directory,
        "pgDumpAvailable": _find_pg_dump() is not None,
        "backups": _list_backups(ps.backup_directory),
    })


@api_view(["POST"])
@require_hr
def run_backup(request: Request) -> Response:
    """
    Body: { "directory"?: str } — falls back to the saved backup_directory.
    Creates <dir>/UKTex_DB_backup_YYYY-MM-DD_HH-MM-SS.sql via pg_dump.
    """
    ps = PayrollSettings.get()
    directory = str(request.data.get("directory") or ps.backup_directory or "").strip()
    if not directory:
        return Response({"error": "No backup directory configured. Set one and save first."}, status=400)

    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as exc:
        return Response({"error": f"Cannot create backup directory: {exc}"}, status=400)

    pg_dump = _find_pg_dump()
    if not pg_dump:
        return Response({
            "error": "pg_dump was not found on this server. Install the PostgreSQL "
                     "client tools or add PostgreSQL's bin folder to PATH.",
        }, status=500)

    db = dj_settings.DATABASES["default"]
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"{_BACKUP_PREFIX}{timestamp}.sql"
    out_path = os.path.join(directory, filename)

    env = {**os.environ, "PGPASSWORD": db["PASSWORD"]}
    cmd = [
        pg_dump,
        "-h", db["HOST"] or "localhost",
        "-p", str(db["PORT"] or "5432"),
        "-U", db["USER"],
        "-d", db["NAME"],
        "--no-password",
        "-f", out_path,
    ]

    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return Response({"error": "Backup timed out after 10 minutes."}, status=500)
    except OSError as exc:
        return Response({"error": f"Could not run pg_dump: {exc}"}, status=500)

    if result.returncode != 0:
        # Don't leave a half-written file behind on failure
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass
        detail = (result.stderr or "").strip().splitlines()
        return Response({
            "error": "pg_dump failed: " + (detail[-1] if detail else f"exit code {result.returncode}"),
        }, status=500)

    # Remember the directory for next time when it came from the request body
    if directory != ps.backup_directory:
        ps.backup_directory = directory
        ps.save(update_fields=["backup_directory", "updated_at"])

    size = os.stat(out_path).st_size
    log_action(request, "backup", "settings", description=f"Database backup created: {filename} ({size} bytes)")
    return Response({
        "ok": True,
        "file": filename,
        "path": out_path,
        "sizeBytes": size,
        "backups": _list_backups(directory),
    })
