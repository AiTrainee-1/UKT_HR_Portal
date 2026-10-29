"""Geo-Tracking scheduler -the watchdog (every 2 minutes) and the retention purge (daily).

Same shape as on_duty_day_end_scheduler.py / whatsapp_alert_scheduler.py (a module-singleton BackgroundScheduler on its own
thread, deliberately separate from the other schedulers so a slow job here never delays theirs). apps.py starts it once at
boot via start_scheduler_if_needed(), and never under the test runner (tests call the jobs in api/geo_tracking/watchdog.py
directly).

  watchdog   every 2 min   end orphan tracks; one SIGNAL_LOST interval event for each recording track silent for
                           signal_lost_seconds; refresh every recording track's state; the reverse-geocode worker (a no-op
                           while the provider is 'off')
  purge      daily 03:30   delete raw points/events older than retention_days (segments and summaries stay)

The automatic CLOSE of On-Duty sessions (and so of their tracks) at 23:50 IST lives in on_duty_day_end_scheduler.py, which
reads GeoTrackingSettings.day_end_time.
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_WATCHDOG = "geo_tracking_watchdog"
_JOB_PURGE = "geo_tracking_purge"
_WATCHDOG_MINUTES = 2
_PURGE_HOUR = 3
_PURGE_MINUTE = 30


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


def _run_watchdog() -> None:
    from django.db import close_old_connections

    from .geo_tracking import watchdog

    close_old_connections()  # a connection this thread holds and the database dropped is replaced here, not failed on for ever
    try:
        watchdog.run_watchdog()
    except Exception as e:
        logger.error("Geo-tracking watchdog failed: %s", e)


def _run_purge() -> None:
    from django.db import close_old_connections

    from .geo_tracking import watchdog

    close_old_connections()
    try:
        result = watchdog.purge_old()
        logger.info("Geo-tracking retention purge: %s", result)
    except Exception as e:
        logger.error("Geo-tracking retention purge failed: %s", e)


def start_scheduler_if_needed() -> None:
    """Called once at process boot: registers both jobs and starts the scheduler thread if it is not running."""
    if not is_available():
        return

    from apscheduler.triggers.cron import CronTrigger

    scheduler = get_scheduler()
    # max_instances=1 + coalesce: a slow run never overlaps the next one, and missed runs collapse into one.
    scheduler.add_job(
        _run_watchdog,
        "interval",
        minutes=_WATCHDOG_MINUTES,
        id=_JOB_WATCHDOG,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=120,
    )
    scheduler.add_job(
        _run_purge,
        CronTrigger(hour=_PURGE_HOUR, minute=_PURGE_MINUTE, timezone="Asia/Kolkata"),
        id=_JOB_PURGE,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info(
                "Geo-tracking scheduler started (watchdog every %s min, purge daily %02d:%02d IST)",
                _WATCHDOG_MINUTES,
                _PURGE_HOUR,
                _PURGE_MINUTE,
            )
        except Exception as e:
            logger.error("Failed to start the Geo-tracking scheduler: %s", e)
