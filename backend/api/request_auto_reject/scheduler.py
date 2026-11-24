"""Auto-Reject Requests scheduler: one cron job, every night at 01:30 India time (owner 2026-11-24).

Same shape as investigation/scheduler.py (a module-singleton BackgroundScheduler on its own thread), half an hour after the
Investigation Auto Trigger so the two nightly jobs never overlap. The job (service.nightly) rejects every request nobody
decided within the saved number of days of being submitted (never a resignation); the switch on Settings -> Auto-Reject
Requests turns it off. apps.py starts this once at boot, never under the test runner. A run missed while the server was down
is caught up within six hours (misfire grace); otherwise the next night's run covers it (it always looks at today).
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
JOB_ID = "request_auto_reject"
RUN_HOUR, RUN_MINUTE = 1, 30  # 01:30, Asia/Kolkata
RUN_AT = f"{RUN_HOUR:02d}:{RUN_MINUTE:02d}"


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


def _run() -> None:
    from django.db import close_old_connections

    from . import service

    close_old_connections()
    try:
        summary = service.nightly()
        if summary.get("rejected"):
            logger.info("Auto-Reject Requests: %s", summary)
    except Exception:
        logger.exception("Auto-Reject Requests job failed")
    finally:
        close_old_connections()


def add_job(scheduler) -> None:
    scheduler.add_job(
        _run,
        "cron",
        hour=RUN_HOUR,
        minute=RUN_MINUTE,
        timezone="Asia/Kolkata",
        id=JOB_ID,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=6 * 3600,
    )


def start_scheduler_if_needed() -> None:
    if not is_available():
        return
    scheduler = get_scheduler()
    add_job(scheduler)
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Auto-Reject Requests scheduler started (daily %s IST)", RUN_AT)
        except Exception as e:
            logger.error("Failed to start the Auto-Reject Requests scheduler: %s", e)
