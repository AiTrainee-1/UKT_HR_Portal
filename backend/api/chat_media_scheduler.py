"""
Chat media expiry sweep (owner 2026-11-25): every 30 minutes, the files of GIFs and voice messages whose time is up
(ChatSettings.media_expiry_days, 7 unless HR changes it) are deleted from the server (chat_media.sweep_expired). The
download refuses an expired file on access as well, so this job only keeps the database from holding them.

Same shape as push_delivery_scheduler.py (module-singleton BackgroundScheduler on its own thread); apps.py starts it once
at boot via start_scheduler_if_needed(). `python manage.py purge_chat_media` runs the same sweep by hand.
"""

import logging

from .scheduler_db import fresh_db_connection

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "chat_media_expiry_sweep"
_INTERVAL_MINUTES = 30


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


@fresh_db_connection
def _run() -> None:
    from . import chat_media

    try:
        done = chat_media.sweep_expired()
        if done["deleted"]:
            logger.info("Chat media sweep: %s", done)
    except Exception as e:
        logger.error("Chat media sweep failed: %s", e)


def start_scheduler_if_needed() -> None:
    if not is_available():
        return
    scheduler = get_scheduler()
    scheduler.add_job(
        _run,
        "interval",
        minutes=_INTERVAL_MINUTES,
        id=_JOB_ID,
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=600,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Chat media expiry sweep started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start the chat media expiry sweep: %s", e)
