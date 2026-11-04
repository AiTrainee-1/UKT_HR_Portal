"""
Department Head reminder scheduler - one interval job, every minute (HR Requests page -> Notify).

Same shape as whatsapp_alert_scheduler.py (a module-singleton BackgroundScheduler on its own thread). The schedule HR sets
(on/off, times, weekdays) is read on every run by hod_reminders.run_scheduled, so a change on the Notify tab takes effect
within a minute with no restart, and the job itself is always registered. The same run also takes over a reminder round
whose processor stopped (a worker restart in the middle of a "Send now"), see hod_reminders.resume_stale.

apps.py starts this once at boot via start_scheduler_if_needed() (never under `manage.py test`).
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "hod_pending_reminders"
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

    from . import hod_reminders

    close_old_connections()
    try:
        hod_reminders.run_scheduled()
    except Exception as e:
        logger.error("Department Head reminder job failed: %s", e)
    finally:
        close_old_connections()


def start_scheduler_if_needed() -> None:
    if not is_available():
        return

    scheduler = get_scheduler()
    # max_instances=1 + coalesce: a slow round (WhatsApp messages are paced) never overlaps the next run, and missed
    # runs collapse into one.
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
            logger.info("Department Head reminder scheduler started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start the Department Head reminder scheduler: %s", e)
