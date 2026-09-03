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


def _pg_env(db: dict) -> dict:
    """Env for pg_dump/psql subprocess calls. PGSSLMODE defaults to "prefer"
    -uses SSL when the server offers it (satisfies managed/cloud Postgres
    providers that require SSL) and degrades gracefully for a local
    Postgres with no SSL configured at all. Override via DB_SSLMODE in
    .env if a specific mode (e.g. "require", "verify-full") is needed."""
    return {
        **os.environ,
        "PGPASSWORD": db["PASSWORD"],
        "PGSSLMODE": os.environ.get("DB_SSLMODE", "prefer"),
    }


def _dump_database(out_sql_path: str) -> None:
    pg_dump = find_pg_dump()
    if not pg_dump:
        raise BackupServiceError(
            "pg_dump was not found on this server. Install the PostgreSQL client "
            "tools or add PostgreSQL's bin folder to PATH."
        )
    db = _db_config()
    env = _pg_env(db)
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
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise BackupServiceError("Database dump timed out after 30 minutes.")
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

    # A few headline row counts, captured at backup time -lets a later
    # restore's validation step warn "this backup has fewer employees/
    # payroll records than what's live right now" without needing to parse
    # db.sql itself. Wrapped defensively so a models-import hiccup never
    # breaks the backup itself; older backups simply won't have this key,
    # and staleness comparison degrades gracefully for those (see
    # compute_staleness()).
    try:
        from .models import Employee, Payroll, SalarySlip
        row_counts = {
            "employees": Employee.objects.count(),
            "payrollRecords": Payroll.objects.count(),
            "salarySlips": SalarySlip.objects.count(),
        }
    except Exception:
        row_counts = None

    import django
    return {
        "createdAt": datetime.now().isoformat(),
        "dbName": _db_config()["NAME"],
        "djangoVersion": ".".join(str(p) for p in django.VERSION[:3]),
        "appliedMigrations": applied,
        "mediaFileCount": media_file_count,
        "rowCounts": row_counts,
    }


def compute_staleness(manifest: dict) -> dict | None:
    """
    Compares a candidate restore backup's manifest against the *live*
    database right now, so the UI can warn before a full-replace restore
    silently discards anything created after the backup was taken -see
    restore_from_zip()'s docstring: restore is a full DROP SCHEMA + reload,
    never a merge, so this is the safety net instead of attempting one.

    Returns None if the manifest predates rowCounts (older-format backup)
    -staleness simply can't be computed for those, the UI falls back to a
    generic "can't compare, review carefully" note rather than a wrong one.
    """
    backup_counts = (manifest or {}).get("rowCounts")
    if not backup_counts:
        return None

    try:
        from .models import Employee, Payroll, SalarySlip
        current_counts = {
            "employees": Employee.objects.count(),
            "payrollRecords": Payroll.objects.count(),
            "salarySlips": SalarySlip.objects.count(),
        }
    except Exception:
        return None

    is_older = any(
        current_counts[key] > backup_counts.get(key, 0)
        for key in current_counts
    )
    return {
        "backupCreatedAt": manifest.get("createdAt"),
        "backupCounts": backup_counts,
        "currentCounts": current_counts,
        "isOlderThanCurrentData": is_older,
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

    # Persisted into Postgres so "Download" can fetch this backup regardless
    # of whether the container's local disk (where out_path physically sits)
    # survives to the next request -Railway's filesystem is ephemeral and a
    # redeploy can wipe it. The zip stays on local disk too, unchanged from
    # before; the database copy is what makes download reliable, not a
    # replacement for the on-disk one. Best-effort: a backup that succeeded
    # on disk must not be reported as failed just because the DB copy
    # couldn't be made -recorded in the manifest instead of raised.
    try:
        _persist_backup_to_db(filename, out_path)
        manifest["persistedToDatabase"] = True
    except Exception as exc:
        manifest["persistedToDatabase"] = False
        manifest["persistError"] = str(exc)

    return {"ok": True, "file": filename, "path": out_path, "sizeBytes": size, "manifest": manifest}


def _backup_blob_name(filename: str) -> str:
    return f"backups/{filename}"


def _persist_backup_to_db(filename: str, out_path: str) -> None:
    """Copies one backup zip's bytes into the file_blobs table.

    Deliberately not routed through FileField/HybridFileStorage: a backup
    isn't an upload attached to a model row the way a resume or photo is,
    it's an independent named artifact, so this writes directly to FileBlob.
    """
    from .models import FileBlob

    with open(out_path, "rb") as f:
        data = f.read()
    FileBlob.objects.update_or_create(
        name=_backup_blob_name(filename),
        defaults={"content": data, "content_type": "application/zip", "size": len(data)},
    )


def get_backup_bytes(filename: str) -> bytes:
    """A backup's zip bytes, from the database if present, else local disk.

    The fallback exists for the same reason HybridFileStorage has one:
    backups created before this shipped were never copied into Postgres, and
    "the file still exists on this container's disk right now" -true only
    until the next redeploy- must not stop working just because it hasn't
    been superseded by a fresh backup yet.
    """
    from .models import FileBlob

    row = FileBlob.objects.filter(name=_backup_blob_name(filename)).only("content").first()
    if row is not None:
        return bytes(row.content)

    # basename() strips any path components a caller might pass -filename
    # ultimately comes from a URL path segment, so this is the one place a
    # directory-traversal attempt ("../../etc/passwd") gets neutralized
    # before it ever reaches the filesystem.
    safe_name = os.path.basename(filename)
    directory = get_backup_directory()
    candidate = os.path.join(directory, safe_name) if directory else None
    if candidate and os.path.isfile(candidate):
        with open(candidate, "rb") as f:
            return f.read()

    raise BackupServiceError(
        "This backup no longer exists -it isn't in the database and isn't on local "
        "disk either. It may predate database backups and have been lost when the "
        "server last restarted."
    )


def get_backup_directory() -> str | None:
    """The configured backup directory, without importing PayrollSettings at
    module load time (avoids a circular import with models.py)."""
    from .models import PayrollSettings

    ps = PayrollSettings.get()
    return (ps.backup_directory or "").strip() or None


def list_backups(directory: str) -> list[dict]:
    """Every backup that can still be downloaded, local disk and database
    both. Deliberately does NOT bail out just because `directory` doesn't
    exist right now (a redeploy leaves an empty disk with an unmodified
    backup_directory setting) -database-only entries must still show up in
    that case, or "Download" would have nothing to offer after every
    restart even though the backups themselves are safe in Postgres.
    """
    entries: dict[str, dict] = {}

    if directory and os.path.isdir(directory):
        for path in glob.glob(os.path.join(directory, f"{_BACKUP_PREFIX}*.zip")):
            try:
                stat = os.stat(path)
                name = os.path.basename(path)
                entries[name] = {
                    "file": name,
                    "sizeBytes": stat.st_size,
                    "createdAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "inDatabase": False,
                }
            except OSError:
                continue

    from .models import FileBlob

    prefix = _backup_blob_name("")
    for row in FileBlob.objects.filter(name__startswith=prefix).only(
        "name", "size", "created_at"
    ):
        name = row.name[len(prefix):]
        if name in entries:
            entries[name]["inDatabase"] = True
        else:
            entries[name] = {
                "file": name,
                "sizeBytes": row.size,
                "createdAt": row.created_at.isoformat(),
                "inDatabase": True,
            }

    ordered = sorted(entries.values(), key=lambda e: e["createdAt"], reverse=True)
    return ordered[:20]


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
            # namelist()/read("manifest.json") above only prove the central
            # directory parses -they don't touch db.sql's actual compressed
            # bytes, so a zip with an intact file list but a corrupted
            # db.sql entry (bit rot from a manual copy/download, an
            # interrupted write, etc.) would otherwise pass validation and
            # only fail later, mid-restore, after the schema has already
            # been dropped. testzip() decompresses and CRC-checks every
            # entry, so corruption is caught here instead.
            bad_entry = zf.testzip()
            if bad_entry is not None:
                raise BackupServiceError(
                    f"This backup file is corrupted (entry '{bad_entry}' failed integrity check) -it cannot be "
                    "safely restored. Get a fresh copy of this backup (re-download it if it came from Google "
                    "Drive or another external copy) and try again."
                )
    except zipfile.BadZipFile:
        raise BackupServiceError("This file isn't a valid zip archive.")

    return {
        "ok": True,
        "manifest": manifest,
        "mediaFileCount": media_count,
        "sizeBytes": os.stat(path).st_size,
        "warnings": warnings,
        "staleness": compute_staleness(manifest),
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
set PGSSLMODE={os.environ.get("DB_SSLMODE", "prefer")}
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
        env = _pg_env(db)
        base_cmd = [
            psql, "-h", db["HOST"] or "localhost", "-p", str(db["PORT"] or "5432"),
            "-U", db["USER"], "-d", db["NAME"], "--no-password",
        ]
        try:
            drop_result = subprocess.run(
                base_cmd + ["-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"],
                env=env, capture_output=True, text=True, timeout=300,
            )
        except subprocess.TimeoutExpired:
            raise BackupServiceError("Resetting the database schema timed out after 5 minutes.")
        if drop_result.returncode != 0:
            stderr = drop_result.stderr.strip()
            if "permission denied" in stderr.lower() or "must be owner" in stderr.lower():
                raise BackupServiceError(
                    "Failed to reset schema: the database user doesn't have owner privileges on the "
                    "'public' schema. This is a one-time grant your Postgres provider's console/support "
                    f"can make (needed for any managed/cloud Postgres, not just this one). Raw error: {stderr}"
                )
            raise BackupServiceError(f"Failed to reset schema: {stderr}")

        try:
            load_result = subprocess.run(
                base_cmd + ["-f", sql_path],
                env=env, capture_output=True, text=True, timeout=3600,
            )
        except subprocess.TimeoutExpired:
            raise BackupServiceError("Loading the database dump timed out after 1 hour.")
        if load_result.returncode != 0:
            raise BackupServiceError(f"Failed to load database dump: {load_result.stderr.strip()}")

    report("done", "Restore complete")
    return {"ok": True}
