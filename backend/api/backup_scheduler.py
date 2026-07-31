"""
Backup Scheduler — configurable background full backups
===========================================================
Mirrors auto_sync.py's structure exactly (one APScheduler CronTrigger job,
live-applied on schedule save, module-singleton BackgroundScheduler). A
separate BackgroundScheduler instance from auto_sync.py's — this app is
small enough that two lightweight scheduler threads is simpler and safer
than sharing one across unrelated job types.

apps.py starts this scheduler once at boot and loads the schedule (if
enabled) via load_schedule_into_scheduler(); backup_views.py calls
apply_schedule_to_scheduler() on every save so a change takes effect
immediately, no process restart needed.
"""

import logging
import os

from django.utils import timezone

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "backup_schedule"


def is_available() -> bool:
    try:
        import apscheduler  # noqa: F401
    except ImportError:
        return False
    return True


def get_scheduler():
    global _scheduler
    if _scheduler is None:
        from apscheduler.schedulers.background import BackgroundScheduler
        _scheduler = BackgroundScheduler(timezone="Asia/Kolkata")
    return _scheduler


def _run_scheduled_backup() -> None:
    """Executed by APScheduler in a worker thread. Re-fetches the schedule
    fresh from the DB so edits/disables made after the job was scheduled
    are always honored."""
    from . import backup_service, google_drive
    from .models import BackupDriveConfig, BackupSchedule, PayrollSettings

    schedule = BackupSchedule.objects.filter(pk=1, is_enabled=True).first()
    if not schedule:
        return

    logger.info("Scheduled backup starting")
    directory = PayrollSettings.get().backup_directory or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backups"
    )

    try:
        result = backup_service.build_full_backup(directory)
        schedule.last_run_status = "success"
        schedule.last_run_summary = f"{result['file']} ({result['sizeBytes']} bytes)"
        logger.info("Scheduled backup complete — %s", result["file"])

        if schedule.retention_count:
            backup_service.prune_old_backups(directory, schedule.retention_count)

        drive = BackupDriveConfig.get()
        if drive.is_enabled and drive.folder_id and drive.service_account_json:
            try:
                upload = google_drive.upload_to_drive(result["path"], drive.folder_id, drive.service_account_json)
                drive.last_upload_at = timezone.now()
                drive.last_upload_status = "success"
                drive.last_upload_summary = f"Uploaded {result['file']}"
                drive.save(update_fields=["last_upload_at", "last_upload_status", "last_upload_summary"])
            except google_drive.DriveError as exc:
                drive.last_upload_at = timezone.now()
                drive.last_upload_status = "failed"
                drive.last_upload_summary = str(exc)
                drive.save(update_fields=["last_upload_at", "last_upload_status", "last_upload_summary"])
                logger.error("Scheduled backup: Drive upload failed: %s", exc)
    except backup_service.BackupServiceError as exc:
        schedule.last_run_status = "failed"
        schedule.last_run_summary = str(exc)
        logger.error("Scheduled backup failed: %s", exc)

    schedule.last_run_at = timezone.now()
    schedule.save(update_fields=["last_run_at", "last_run_status", "last_run_summary"])


def apply_schedule_to_scheduler(schedule) -> None:
    """Add/replace the backup job, or remove it if disabled. Call after
    every save so the change takes effect immediately."""
    if not is_available():
        return
    if not schedule.is_enabled:
        remove_schedule_from_scheduler()
        return

    from apscheduler.triggers.cron import CronTrigger

    trigger = CronTrigger(
        hour=schedule.time.hour, minute=schedule.time.minute,
        day_of_week=schedule.days_of_week or "*", timezone="Asia/Kolkata",
    )
    get_scheduler().add_job(
        _run_scheduled_backup, trigger, id=_JOB_ID,
        replace_existing=True, misfire_grace_time=3600,
    )


def remove_schedule_from_scheduler() -> None:
    if not is_available():
        return
    try:
        get_scheduler().remove_job(_JOB_ID)
    except Exception:
        pass  # wasn't scheduled — fine (e.g. already disabled)


def load_schedule_into_scheduler() -> None:
    """Called once at process boot — schedules the backup job if enabled."""
    from .models import BackupSchedule
    schedule = BackupSchedule.objects.filter(pk=1).first()
    if schedule:
        apply_schedule_to_scheduler(schedule)


def start_scheduler_if_needed() -> None:
    scheduler = get_scheduler()
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Backup scheduler started")
        except Exception as e:
            logger.error("Failed to start Backup scheduler: %s", e)
