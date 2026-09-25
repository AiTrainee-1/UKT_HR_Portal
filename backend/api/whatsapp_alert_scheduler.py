"""
WhatsApp attendance alert scheduler -one interval job, every 5 minutes.

Same shape as on_duty_day_end_scheduler.py (module-singleton BackgroundScheduler
on its own thread). Unlike that job it has HR-facing on/off switches, but they are
checked inside whatsapp_alerts.run_attendance_alerts on every run -so flipping a
toggle on the WhatsApp Control page takes effect within five minutes with no
restart, and the job itself is always registered.

apps.py starts this once at boot via start_scheduler_if_needed().
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "whatsapp_attendance_alerts"
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
    from . import whatsapp_alerts, whatsapp_service

    try:
        whatsapp_service.expire_stale_pending()
    except Exception as e:
        logger.error("WhatsApp stale-message sweep failed: %s", e)
    try:
        whatsapp_alerts.run_attendance_alerts()
    except Exception as e:
        logger.error("WhatsApp attendance alert job failed: %s", e)


def start_scheduler_if_needed() -> None:
    if not is_available():
        return

    scheduler = get_scheduler()
    # max_instances=1 + coalesce: a slow run (many messages, each paced) never
    # overlaps the next one, and missed runs collapse into one.
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
            logger.info("WhatsApp attendance alert scheduler started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start WhatsApp attendance alert scheduler: %s", e)
