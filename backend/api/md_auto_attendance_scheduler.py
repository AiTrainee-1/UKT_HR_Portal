"""
MD auto attendance scheduler: one cron job, every day at 8:00 PM IST (owner 2026-11-05).

Same shape as overtime_scheduler.py (module-singleton BackgroundScheduler on its own thread). The job
(md_auto_attendance.run) fills the listed MD employees' working days since the start date (1 Jan 2026) that have no
attendance yet, so nobody has to act. apps.py starts this once at boot via start_scheduler_if_needed(); never under the
test runner. A run missed while the server was down is caught up within three hours of 8 PM (misfire grace), and any day still missed is
filled by the next evening's run (it always covers everything since the start date).
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
JOB_ID = "md_auto_attendance"
RUN_HOUR, RUN_MINUTE = 20, 0  # 8:00 PM, Asia/Kolkata


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

    from . import md_auto_attendance

    close_old_connections()
    try:
        summary = md_auto_attendance.run()
        if summary.get("punches"):
            logger.info("MD auto attendance: %s", summary)
    except Exception:
        logger.exception("MD auto attendance job failed")
    finally:
        close_old_connections()


def add_job(scheduler) -> None:
    """The daily 8 PM job on `scheduler` (max_instances=1 + coalesce: missed runs collapse into one)."""
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
        misfire_grace_time=3 * 3600,
    )


def start_scheduler_if_needed() -> None:
    if not is_available():
        return
    scheduler = get_scheduler()
    add_job(scheduler)
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("MD auto attendance scheduler started (daily %02d:%02d IST)", RUN_HOUR, RUN_MINUTE)
        except Exception as e:
            logger.error("Failed to start MD auto attendance scheduler: %s", e)
