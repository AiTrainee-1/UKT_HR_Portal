"""
On-Duty Day End Scheduler -the daily close, at the Geo-Tracking settings' day-end time (23:50 IST by default)
================================================================================================================
Mirrors screening_cleanup_scheduler.py (module-singleton BackgroundScheduler on its own thread, deliberately separate from
the auto_sync/backup/screening schedulers -same rationale as there).

Like the screening job and unlike Auto Sync / Backup, this has no enable/disable switch: an On-Duty session covers one day
by definition, so closing it at day end is part of the model rather than a preference. The TIME is HR's to set
(Geo Attendance -> Tracking Settings -> Geo-tracking rules -> Day-end time; GeoTrackingSettings.day_end_time, default 23:50).

A fixed cron time could not follow that setting without a restart, so this registers a light job that runs every minute and
closes the day ONCE per IST date, the first time the clock is at or past the day-end time. It re-reads the setting on every
tick (one single-row query), so a changed time takes effect within a minute with no restart; a server that was down at the
day-end time closes the day as soon as it is back up (the close is idempotent).

Closing a session also ends its geo-tracking (geo_attendance_views._end_on_duty_session -> geo_tracking.sessions.end_track).

apps.py starts this once at boot via start_scheduler_if_needed().
"""

import logging
from datetime import date, datetime, time

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "on_duty_day_end"
_TICK_MINUTES = 1

#: the day-end time when the setting cannot be read (a database that is not migrated yet): 23:50 IST. Late enough for a full
#: off-site day including evening travel, early enough to close the day before midnight rolls the date over and the session
#: would otherwise carry into tomorrow.
DEFAULT_DAY_END = time(23, 50)

#: the IST date the daily close last ran to completion in THIS process (None after a restart: a restart past the day-end
#: time closes the day again, which is harmless).
_last_run_date: date | None = None


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


def day_end_time() -> time:
    """The close time from GeoTrackingSettings (DEFAULT_DAY_END if it cannot be read)."""
    try:
        from .models import GeoTrackingSettings

        return GeoTrackingSettings.get().day_end_time
    except Exception as e:
        logger.warning("Could not read the day-end time, using %s: %s", DEFAULT_DAY_END, e)
        return DEFAULT_DAY_END


def is_due(now_ist: datetime, day_end: time, last_run: date | None) -> bool:
    """Is the day's close due? True once the (naive IST) clock is at or past ``day_end`` and it has not run today."""
    return last_run != now_ist.date() and now_ist.time() >= day_end


def _run_day_end() -> None:
    from . import on_duty_day_end

    on_duty_day_end.end_stale_on_duty_sessions()


def _tick() -> None:
    """The every-minute job: run the daily close when it is due."""
    global _last_run_date
    from django.db import close_old_connections

    from .clock import ist_now

    now = ist_now()
    close_old_connections()  # this thread lives for months: a connection the database dropped must be replaced, not retried
    try:
        if not is_due(now, day_end_time(), _last_run_date):
            return
        _run_day_end()
        _last_run_date = now.date()
    except Exception as e:
        # _last_run_date stays unset, so the next tick tries again
        logger.error("On-Duty day-end job failed: %s", e)


def start_scheduler_if_needed() -> None:
    """Called once at process boot -registers the every-minute check and starts the scheduler thread if not running."""
    if not is_available():
        return

    scheduler = get_scheduler()
    scheduler.add_job(
        _tick,
        "interval",
        minutes=_TICK_MINUTES,
        id=_JOB_ID,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info(
                "On-Duty day-end scheduler started (closes the day at the Geo-Tracking day-end time, 23:50 IST by default)"
            )
        except Exception as e:
            logger.error("Failed to start On-Duty day-end scheduler: %s", e)
