"""
Screening Document Retention Scheduler -fixed daily housekeeping job
======================================================================
Mirrors backup_scheduler.py's structure (module-singleton
BackgroundScheduler, own thread -deliberately separate from
auto_sync.py/backup_scheduler.py's schedulers, same rationale: small app,
independent lightweight scheduler threads are simpler and safer than
sharing one across unrelated job types).

Unlike Auto Sync / Backup Schedule, this job has no HR-facing enable/disable
UI or configurable time -it's plain housekeeping (purge_expired_screening_
documents in screening_cleanup.py), always on, fixed to run once a day.

apps.py starts this scheduler once at boot via start_scheduler_if_needed().
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "screening_document_retention"


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


def _run_purge() -> None:
    from . import screening_cleanup

    try:
        result = screening_cleanup.purge_expired_screening_documents()
        logger.info("Screening document retention job ran: %s", result)
    except Exception as e:
        logger.error("Screening document retention job failed: %s", e)


def start_scheduler_if_needed() -> None:
    """Called once at process boot -registers the fixed daily job (01:00
    Asia/Kolkata) and starts the scheduler thread if not already running."""
    if not is_available():
        return

    from apscheduler.triggers.cron import CronTrigger

    scheduler = get_scheduler()
    scheduler.add_job(
        _run_purge, CronTrigger(hour=1, minute=0, timezone="Asia/Kolkata"),
        id=_JOB_ID, replace_existing=True, misfire_grace_time=3600,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Screening document retention scheduler started")
        except Exception as e:
            logger.error("Failed to start screening document retention scheduler: %s", e)
