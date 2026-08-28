"""
On-Duty Day End Scheduler -fixed daily job at 23:00 IST
========================================================
Mirrors screening_cleanup_scheduler.py exactly (module-singleton
BackgroundScheduler on its own thread, deliberately separate from the
auto_sync/backup/screening schedulers -same rationale as there).

Like the screening job and unlike Auto Sync / Backup, this has no HR-facing
enable/disable UI: an On-Duty session covers one day by definition, so
closing it at day end is part of the model rather than a preference.

apps.py starts this once at boot via start_scheduler_if_needed().
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "on_duty_day_end"

# 23:00 IST -late enough for a full off-site day including evening travel,
# early enough to close the day before midnight rolls the date over and the
# session would otherwise carry into tomorrow.
_HOUR = 23
_MINUTE = 0


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


def _run_day_end() -> None:
    from . import on_duty_day_end

    try:
        on_duty_day_end.end_stale_on_duty_sessions()
    except Exception as e:
        logger.error("On-Duty day-end job failed: %s", e)


def start_scheduler_if_needed() -> None:
    """Called once at process boot -registers the fixed daily job
    (23:00 Asia/Kolkata) and starts the scheduler thread if not running."""
    if not is_available():
        return

    from apscheduler.triggers.cron import CronTrigger

    scheduler = get_scheduler()
    scheduler.add_job(
        _run_day_end, CronTrigger(hour=_HOUR, minute=_MINUTE, timezone="Asia/Kolkata"),
        id=_JOB_ID, replace_existing=True, misfire_grace_time=3600,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("On-Duty day-end scheduler started (23:00 IST daily)")
        except Exception as e:
            logger.error("Failed to start On-Duty day-end scheduler: %s", e)
