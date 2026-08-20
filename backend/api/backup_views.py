"""
Full Application Backup (Settings → Backup)
=============================================
Manual + scheduled full backups (database + all uploaded files), Google
Drive offsite copy, and Restore (guided script + fully-automated). The
actual archive building/validation/restore logic lives in
backup_service.py so this file stays request-handling only.

Restore is split into two requests on purpose:
  1. POST backup/restore/validate -upload + validate + stage the file,
     return its manifest and a guided-restore script. Safe, read-only
     w.r.t. the live app. @require_hr.
  2. POST backup/restore/run -take an already-staged path and actually
     run it, fully automated. This is the destructive one, so it's gated
     behind @require_super_admin on top of the normal settings.backup
     permission, and it never runs in-process -it spawns the
     `restore_backup` management command as a detached OS process, since
     the request's own DB connection can't survive the schema drop it's
     asking for.
"""

import json
import os
import subprocess
import sys
from datetime import datetime

from django.conf import settings as dj_settings
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from . import backup_service
from .auth import require_hr, require_super_admin
from .audit_utils import log_action
from .backup_scheduler import apply_schedule_to_scheduler
from .google_drive import test_drive_connection
from .models import BackupDriveConfig, BackupSchedule, PayrollSettings

_STATUS_FILE = os.path.join(str(dj_settings.BASE_DIR), "restore_status.json")
_MAINTENANCE_MARKER = os.path.join(str(dj_settings.BASE_DIR), "maintenance.lock")


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


# ── Status + manual backup ──────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def backup_status(request: Request) -> Response:
    ps = PayrollSettings.get()
    schedule = BackupSchedule.get()
    drive = BackupDriveConfig.get()
    return Response({
        "backupDirectory": ps.backup_directory,
        "pgDumpAvailable": backup_service.find_pg_dump() is not None,
        "backups": backup_service.list_backups(ps.backup_directory),
        "schedule": {
            "isEnabled": schedule.is_enabled,
            "time": schedule.time.strftime("%H:%M") if schedule.time else None,
            "daysOfWeek": schedule.days_of_week,
            "retentionCount": schedule.retention_count,
            "lastRunAt": schedule.last_run_at,
            "lastRunStatus": schedule.last_run_status,
            "lastRunSummary": schedule.last_run_summary,
        },
        "driveConfigured": bool(drive.is_enabled and drive.folder_id and drive.service_account_json),
    })


@api_view(["POST"])
@require_hr
def run_backup(request: Request) -> Response:
    """Body: { "directory"?: str } -falls back to the saved backup_directory."""
    ps = PayrollSettings.get()
    directory = str(request.data.get("directory") or ps.backup_directory or "").strip()

    try:
        result = backup_service.build_full_backup(directory)
    except backup_service.BackupServiceError as exc:
        return _error(str(exc), 500)

    if directory != ps.backup_directory:
        ps.backup_directory = directory
        ps.save(update_fields=["backup_directory", "updated_at"])

    schedule = BackupSchedule.get()
    if schedule.retention_count:
        backup_service.prune_old_backups(directory, schedule.retention_count)

    log_action(request, "backup", "settings", description=f"Full backup created: {result['file']} ({result['sizeBytes']} bytes)")
    return Response({
        "ok": True,
        "file": result["file"],
        "path": result["path"],
        "sizeBytes": result["sizeBytes"],
        "backups": backup_service.list_backups(directory),
    })


# ── Schedule ─────────────────────────────────────────────────────────────────

@api_view(["GET", "PUT"])
@require_hr
def backup_schedule_view(request: Request) -> Response:
    schedule = BackupSchedule.get()

    if request.method == "PUT":
        data = request.data
        if "isEnabled" in data:
            schedule.is_enabled = bool(data["isEnabled"])
        if "time" in data and data["time"]:
            try:
                schedule.time = datetime.strptime(data["time"], "%H:%M").time()
            except ValueError:
                return _error("time must be in HH:MM 24-hour format.")
        if "daysOfWeek" in data:
            schedule.days_of_week = str(data["daysOfWeek"] or "*")
        if "retentionCount" in data:
            try:
                schedule.retention_count = max(0, int(data["retentionCount"]))
            except (TypeError, ValueError):
                return _error("retentionCount must be a number.")
        schedule.save()
        apply_schedule_to_scheduler(schedule)
        log_action(request, "update", "settings", description="Backup schedule updated")

    return Response({
        "isEnabled": schedule.is_enabled,
        "time": schedule.time.strftime("%H:%M") if schedule.time else None,
        "daysOfWeek": schedule.days_of_week,
        "retentionCount": schedule.retention_count,
        "lastRunAt": schedule.last_run_at,
        "lastRunStatus": schedule.last_run_status,
        "lastRunSummary": schedule.last_run_summary,
    })


# ── Google Drive ─────────────────────────────────────────────────────────────

@api_view(["GET", "PUT"])
@require_hr
def backup_drive_view(request: Request) -> Response:
    drive = BackupDriveConfig.get()

    if request.method == "PUT":
        data = request.data
        if "isEnabled" in data:
            drive.is_enabled = bool(data["isEnabled"])
        if "folderId" in data:
            drive.folder_id = str(data["folderId"] or "").strip()
        # Only overwrite the stored key if a new one was actually pasted in —
        # the GET response never echoes it back, so an empty/unset field here
        # means "leave the existing key alone", not "clear it".
        if data.get("serviceAccountJson"):
            drive.service_account_json = str(data["serviceAccountJson"])
        drive.save()
        log_action(request, "update", "settings", description="Backup Google Drive config updated")

    return Response({
        "isEnabled": drive.is_enabled,
        "folderId": drive.folder_id,
        "hasServiceAccountKey": bool(drive.service_account_json),
        "lastUploadAt": drive.last_upload_at,
        "lastUploadStatus": drive.last_upload_status,
        "lastUploadSummary": drive.last_upload_summary,
    })


@api_view(["POST"])
@require_hr
def backup_drive_test(request: Request) -> Response:
    """Body: { "folderId"?: str, "serviceAccountJson"?: str } -falls back to the saved config."""
    drive = BackupDriveConfig.get()
    folder_id = str(request.data.get("folderId") or drive.folder_id or "").strip()
    service_account_json = str(request.data.get("serviceAccountJson") or drive.service_account_json or "")

    if not folder_id or not service_account_json:
        return _error("Folder ID and service account key are both required to test the connection.")

    result = test_drive_connection(folder_id, service_account_json)
    if not result.get("ok"):
        return _error(result.get("error") or "Connection test failed.", 400)
    return Response(result)


# ── Restore ──────────────────────────────────────────────────────────────────

@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def backup_restore_validate(request: Request) -> Response:
    """Upload + validate a backup file. Read-only w.r.t. the live app -stages
    the file and returns its manifest + a guided-restore script."""
    file = request.FILES.get("file")
    if not file:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")

    try:
        info = backup_service.stage_backup(file)
    except backup_service.BackupServiceError as exc:
        return _error(str(exc))

    script = backup_service.build_guided_restore_script(info["stagedPath"], info["manifest"])
    log_action(request, "upload", "settings", description=f"Restore backup uploaded + validated: {file.name}")

    return Response({
        "ok": True,
        "stagedPath": info["stagedPath"],
        "manifest": info["manifest"],
        "mediaFileCount": info["mediaFileCount"],
        "sizeBytes": info["sizeBytes"],
        "warnings": info["warnings"],
        "staleness": info["staleness"],
        "guidedScript": script,
    })


@api_view(["POST"])
@require_super_admin
def backup_restore_run(request: Request) -> Response:
    """
    Body: { "stagedPath": str } -from a prior restore/validate call.
    Kicks off the fully-automated restore as a detached process and returns
    immediately. Poll backup/restore/status for progress.
    """
    staged_path = str(request.data.get("stagedPath") or "")
    if not staged_path or not os.path.isfile(staged_path):
        return _error("stagedPath is missing or no longer exists. Upload the backup file again.")

    # Safety net: back up the current state before touching anything, so a
    # bad restore is itself always undoable from local backups.
    ps = PayrollSettings.get()
    try:
        backup_service.build_full_backup(ps.backup_directory or os.path.join(str(dj_settings.BASE_DIR), "backups"))
    except backup_service.BackupServiceError as exc:
        return _error(f"Could not take a pre-restore safety backup, aborting: {exc}", 500)

    with open(_STATUS_FILE, "w") as f:
        json.dump({"step": "starting", "detail": "Restore starting", "ok": None, "updatedAt": datetime.now().isoformat()}, f)
    with open(_MAINTENANCE_MARKER, "w") as f:
        f.write(datetime.now().isoformat())

    log_action(request, "restore", "settings", description=f"Automated restore started from {staged_path}")

    manage_py = os.path.join(str(dj_settings.BASE_DIR), "manage.py")
    subprocess.Popen(
        [sys.executable, manage_py, "restore_backup", "--file", staged_path],
        cwd=str(dj_settings.BASE_DIR),
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )

    return Response({"ok": True, "message": "Restore started. The application will be briefly unavailable."})


@api_view(["GET"])
def backup_restore_status(request: Request) -> Response:
    """Deliberately not @require_hr -during a restore the DB (and therefore
    the auth check) may be briefly unreachable, and this needs to keep
    working through that window so the UI can show real progress."""
    if not os.path.isfile(_STATUS_FILE):
        return Response({"active": False})
    try:
        with open(_STATUS_FILE) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return Response({"active": False})
    data["active"] = data.get("ok") is None
    return Response(data)
