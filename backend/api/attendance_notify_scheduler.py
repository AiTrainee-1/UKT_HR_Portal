"""
Attendance Notify scheduler - one interval job, every minute (Attendance -> Attendance Notify).

Same shape as hod_reminder_scheduler.py (a module-singleton BackgroundScheduler on its own thread). Every automation's
times, days and on/off are read on each run by attendance_notify.run_scheduled, so a change on the page takes effect
within a minute with no restart. The same run retries failed email / chat deliveries, takes over a run whose processor
stopped, and brings queued WhatsApp deliveries up to date.

apps.py starts this once at boot via start_scheduler_if_needed() (never under `manage.py test`).
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "attendance_notify"
_INTERVAL_MINUTES = 1


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

    from . import attendance_notify

    close_old_connections()
    try:
        attendance_notify.run_scheduled()
    except Exception as e:
        logger.error("Attendance Notify job failed: %s", e)
    finally:
        close_old_connections()


def start_scheduler_if_needed() -> None:
    if not is_available():
        return

    scheduler = get_scheduler()
    # max_instances=1 + coalesce: a long run (a month's report, many recipients) never overlaps the next one, and
    # missed runs collapse into one.
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
            logger.info("Attendance Notify scheduler started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start the Attendance Notify scheduler: %s", e)
