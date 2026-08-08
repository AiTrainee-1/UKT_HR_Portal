"""
Full Application Backup / Restore -shared service module
===========================================================
Builds and restores a full backup archive (database + every uploaded file
under MEDIA_ROOT). Used by both the HR-facing views (backup_views.py) for
manual/scheduled backups and the guided-restore script, and the
`restore_backup` management command for the fully-automated restore path
(which must run as a separate OS process, never inside the web request that
triggered it -the request's own DB connection can't survive the drop it's
asking for).

Archive layout (a plain zip, no external `zip`/`tar` binary required):
    UKTex_Full_backup_<timestamp>.zip
      ├── db.sql          -pg_dump plain-SQL output
      ├── manifest.json    -timestamp, DB name, migration state, media file count
      └── media/           -full recursive copy of MEDIA_ROOT
"""

import glob
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime

from django.conf import settings as dj_settings

_BACKUP_PREFIX = "UKTex_Full_backup_"


class BackupServiceError(Exception):
    pass


def find_pg_dump() -> str | None:
    """pg_dump from PATH, or the newest PostgreSQL install on Windows."""
    found = shutil.which("pg_dump")
    if found:
        return found
    candidates = sorted(
        glob.glob(r"C:\Program Files\PostgreSQL\*\bin\pg_dump.exe"),
        reverse=True,  # highest version first
    )
    return candidates[0] if candidates else None


def find_psql() -> str | None:
    found = shutil.which("psql")
    if found:
        return found
    candidates = sorted(
        glob.glob(r"C:\Program Files\PostgreSQL\*\bin\psql.exe"),
        reverse=True,
    )
    return candidates[0] if candidates else None


def _db_config() -> dict:
    return dj_settings.DATABASES["default"]


def _dump_database(out_sql_path: str) -> None:
    pg_dump = find_pg_dump()
    if not pg_dump:
        raise BackupServiceError(
            "pg_dump was not found on this server. Install the PostgreSQL client "
            "tools or add PostgreSQL's bin folder to PATH."
        )
    db = _db_config()
    env = {**os.environ, "PGPASSWORD": db["PASSWORD"]}
    cmd = [
        pg_dump,
        "-h", db["HOST"] or "localhost",
        "-p", str(db["PORT"] or "5432"),
        "-U", db["USER"],
        "-d", db["NAME"],
        "--no-password",
        "-f", out_sql_path,
    ]
    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise BackupServiceError("Database dump timed out after 10 minutes.")
    except OSError as exc:
        raise BackupServiceError(f"Could not run pg_dump: {exc}")
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        raise BackupServiceError("pg_dump failed: " + (detail[-1] if detail else f"exit code {result.returncode}"))


def _build_manifest() -> dict:
    media_root = str(dj_settings.MEDIA_ROOT)
    media_file_count = 0
    if os.path.isdir(media_root):
        for _root, _dirs, files in os.walk(media_root):
            media_file_count += len(files)

    from django.db.migrations.recorder import MigrationRecorder
    try:
        applied = MigrationRecorder.Migration.objects.count()
    except Exception:
        applied = None

    import django
    return {
        "createdAt": datetime.now().isoformat(),
        "dbName": _db_config()["NAME"],
        "djangoVersion": ".".join(str(p) for p in django.VERSION[:3]),
        "appliedMigrations": applied,
        "mediaFileCount": media_file_count,
    }


def build_full_backup(directory: str) -> dict:
    """
    Creates <directory>/UKTex_Full_backup_YYYY-MM-DD_HH-MM-SS.zip containing
    db.sql + manifest.json + a full copy of MEDIA_ROOT under media/.
    Returns {ok, file, path, sizeBytes, manifest} or raises BackupServiceError.
    """
    if not directory or not directory.strip():
        raise BackupServiceError("No backup directory configured. Set one and save first.")
    directory = directory.strip()
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as exc:
        raise BackupServiceError(f"Cannot create backup directory: {exc}")

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"{_BACKUP_PREFIX}{timestamp}.zip"
    out_path = os.path.join(directory, filename)

    with tempfile.TemporaryDirectory(prefix="uktex_backup_") as tmp_dir:
        sql_path = os.path.join(tmp_dir, "db.sql")
        _dump_database(sql_path)

        manifest = _build_manifest()

        tmp_zip_path = out_path + ".partial"
        try:
            with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(sql_path, arcname="db.sql")
                zf.writestr("manifest.json", json.dumps(manifest, indent=2))

                media_root = str(dj_settings.MEDIA_ROOT)
                if os.path.isdir(media_root):
                    for root, _dirs, files in os.walk(media_root):
                        for fname in files:
                            fpath = os.path.join(root, fname)
                            arcname = os.path.join("media", os.path.relpath(fpath, media_root))
                            zf.write(fpath, arcname=arcname)
            os.replace(tmp_zip_path, out_path)
        except Exception:
            if os.path.exists(tmp_zip_path):
                try:
                    os.remove(tmp_zip_path)
                except OSError:
                    pass
            raise

    size = os.stat(out_path).st_size
    return {"ok": True, "file": filename, "path": out_path, "sizeBytes": size, "manifest": manifest}


def list_backups(directory: str) -> list[dict]:
    if not directory or not os.path.isdir(directory):
        return []
    entries = []
    for path in glob.glob(os.path.join(directory, f"{_BACKUP_PREFIX}*.zip")):
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


def prune_old_backups(directory: str, retention_count: int) -> int:
    """Deletes the oldest local backups beyond retention_count. Returns how many were deleted."""
    if retention_count <= 0 or not directory or not os.path.isdir(directory):
        return 0
    all_backups = sorted(
        glob.glob(os.path.join(directory, f"{_BACKUP_PREFIX}*.zip")),
        key=lambda p: os.stat(p).st_mtime,
        reverse=True,
    )
    to_delete = all_backups[retention_count:]
    deleted = 0
    for path in to_delete:
        try:
            os.remove(path)
            deleted += 1
        except OSError:
            continue
    return deleted


def validate_backup_zip(path: str) -> dict:
    """Opens a backup zip and confirms it's structurally sound without touching anything live."""
    if not os.path.isfile(path):
        raise BackupServiceError("Backup file not found.")
    warnings: list[str] = []
    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = zf.namelist()
            if "db.sql" not in names:
                raise BackupServiceError("This file doesn't look like a UKTextiles backup -no db.sql found inside.")
            manifest = {}
            if "manifest.json" in names:
                manifest = json.loads(zf.read("manifest.json"))
            else:
                warnings.append("No manifest.json found -this may be an older-format backup.")
            media_count = sum(1 for n in names if n.startswith("media/") and not n.endswith("/"))
            if media_count == 0:
                warnings.append("No files under media/ -this backup may be database-only.")
    except zipfile.BadZipFile:
        raise BackupServiceError("This file isn't a valid zip archive.")

    return {
        "ok": True,
        "manifest": manifest,
        "mediaFileCount": media_count,
        "sizeBytes": os.stat(path).st_size,
        "warnings": warnings,
    }


def stage_backup(uploaded_file) -> dict:
    """Saves an uploaded restore file to a temp staging dir (outside MEDIA_ROOT) and validates it."""
    staging_dir = os.path.join(str(dj_settings.BASE_DIR), "backup_staging")
    os.makedirs(staging_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    safe_name = os.path.basename(uploaded_file.name or "restore.zip")
    staged_path = os.path.join(staging_dir, f"{timestamp}_{safe_name}")

    with open(staged_path, "wb") as out:
        for chunk in uploaded_file.chunks():
            out.write(chunk)

    try:
        info = validate_backup_zip(staged_path)
    except BackupServiceError:
        try:
            os.remove(staged_path)
        except OSError:
            pass
        raise

    info["stagedPath"] = staged_path
    return info


def build_guided_restore_script(staged_path: str, manifest: dict) -> str:
    """A Windows .bat script the HR admin can run manually with the app stopped."""
    db = _db_config()
    psql = find_psql() or "psql"
    media_root = str(dj_settings.MEDIA_ROOT)
    extract_dir = staged_path + "_extracted"
    return f"""@echo off
REM UKTextiles -Guided Restore Script
REM Generated {datetime.now().isoformat()}
REM Backup file: {staged_path}
REM
REM BEFORE RUNNING: stop the UKTextiles application server (waitress / the
REM Windows service). This script will not do that for you.

echo Extracting backup...
powershell -Command "Expand-Archive -LiteralPath '{staged_path}' -DestinationPath '{extract_dir}' -Force"

echo Restoring database (this will DROP and recreate the public schema)...
set PGPASSWORD={db["PASSWORD"]}
"{psql}" -h {db["HOST"] or "localhost"} -p {db["PORT"] or "5432"} -U {db["USER"]} -d {db["NAME"]} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
"{psql}" -h {db["HOST"] or "localhost"} -p {db["PORT"] or "5432"} -U {db["USER"]} -d {db["NAME"]} -f "{extract_dir}\\db.sql"

echo Replacing uploaded files...
if exist "{media_root}_pre_restore" rmdir /s /q "{media_root}_pre_restore"
if exist "{media_root}" ren "{media_root}" media_pre_restore
robocopy "{extract_dir}\\media" "{media_root}" /E

echo Done. Restart the UKTextiles application server now.
pause
"""


def restore_from_zip(zip_path: str, status_callback=None) -> dict:
    """
    The actual restore. Must be called from a standalone process (the
    restore_backup management command), never from inside a live web
    request -dropping the schema the request's own connection depends on
    is not safe to do in-process.

    Renames the current MEDIA_ROOT aside (never deletes it) before
    replacing it, so a failed restore always has an undo path.
    """
    def report(step: str, detail: str = "") -> None:
        if status_callback:
            status_callback(step, detail)

    if not os.path.isfile(zip_path):
        raise BackupServiceError(f"Backup file not found: {zip_path}")

    psql = find_psql()
    if not psql:
        raise BackupServiceError("psql was not found on this server.")

    report("extracting", "Extracting backup archive")
    with tempfile.TemporaryDirectory(prefix="uktex_restore_") as tmp_dir:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_dir)

        sql_path = os.path.join(tmp_dir, "db.sql")
        if not os.path.isfile(sql_path):
            raise BackupServiceError("db.sql not found inside the backup archive.")

        media_src = os.path.join(tmp_dir, "media")
        media_root = str(dj_settings.MEDIA_ROOT)

        report("media", "Replacing uploaded files")
        if os.path.isdir(media_src):
            if os.path.isdir(media_root):
                backup_aside = f"{media_root}_pre_restore_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                os.rename(media_root, backup_aside)
            shutil.copytree(media_src, media_root)

        report("database", "Restoring database (this will drop and recreate the schema)")
        db = _db_config()
        env = {**os.environ, "PGPASSWORD": db["PASSWORD"]}
        base_cmd = [
            psql, "-h", db["HOST"] or "localhost", "-p", str(db["PORT"] or "5432"),
            "-U", db["USER"], "-d", db["NAME"], "--no-password",
        ]
        drop_result = subprocess.run(
            base_cmd + ["-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"],
            env=env, capture_output=True, text=True, timeout=120,
        )
        if drop_result.returncode != 0:
            raise BackupServiceError(f"Failed to reset schema: {drop_result.stderr.strip()}")

        load_result = subprocess.run(
            base_cmd + ["-f", sql_path],
            env=env, capture_output=True, text=True, timeout=1800,
        )
        if load_result.returncode != 0:
            raise BackupServiceError(f"Failed to load database dump: {load_result.stderr.strip()}")

    report("done", "Restore complete")
    return {"ok": True}
