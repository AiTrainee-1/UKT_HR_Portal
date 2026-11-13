"""
Attendance refresh scheduler: one interval job, every 5 minutes (2026-11-13).

Same shape as overtime_scheduler.py (module-singleton BackgroundScheduler on its own thread). The job
(attendance_refresh.refresh_stale) re-judges every stored attendance day, staff and production, from the 1st of the
previous month to today, whose punches arrived after it was last worked out, so a late punch (a device catching up, a
fetch, the connector) never leaves a day Absent / Half Day / without its Late mark on the screens that read the stored
day. Nothing stale costs two queries. No switch: attendance is never optional. apps.py starts this once at boot via
start_scheduler_if_needed(); never under the test runner.
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "attendance_refresh"
_INTERVAL_MINUTES = 5


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

    from . import attendance_refresh

    close_old_connections()
    try:
        refreshed = attendance_refresh.refresh_stale()
        if refreshed:
            logger.info("Attendance refresh: re-judged the late-punched days of %s employee(s)", refreshed)
    except Exception:
        logger.exception("Attendance refresh job failed")
    finally:
        close_old_connections()


def start_scheduler_if_needed() -> None:
    if not is_available():
        return

    scheduler = get_scheduler()
    # max_instances=1 + coalesce: a slow pass never overlaps the next one, and missed runs collapse into one.
    scheduler.add_job(
        _run,
        "interval",
        minutes=_INTERVAL_MINUTES,
        id=_JOB_ID,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Attendance refresh scheduler started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start attendance refresh scheduler: %s", e)
