"""
Investigation Auto Trigger scheduler: one cron job, every night at 01:00 IST (owner 2026-11-23).

Same shape as md_auto_attendance_scheduler.py (module-singleton BackgroundScheduler on its own thread). The job
(investigation.service.auto_run) marks inactive every active employee away MORE than 30 days in a row who is not kept
active, not on approved leave for the whole time and has attendance recorded at some point (engine.py). The switch on the
Auto Trigger tab turns it off. apps.py starts this once at boot; never under the test runner. A run missed while the server
was down is caught up within six hours (misfire grace); otherwise the next night's run covers it (it always looks at today).
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
JOB_ID = "investigation_auto_trigger"
RUN_HOUR, RUN_MINUTE = 1, 0  # 01:00, Asia/Kolkata


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
        summary = service.auto_run()
        if summary.get("inactivated"):
            logger.info("Investigation Auto Trigger: %s", summary)
    except Exception:
        logger.exception("Investigation Auto Trigger job failed")
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
            logger.info("Investigation Auto Trigger scheduler started (daily %02d:%02d IST)", RUN_HOUR, RUN_MINUTE)
        except Exception as e:
            logger.error("Failed to start the Investigation Auto Trigger scheduler: %s", e)
