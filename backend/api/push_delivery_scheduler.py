"""
Phone push sweep -one interval job, every minute (push_delivery.py).

Pushes every notification still waiting for its push (the in-memory queue was lost to a restart, or its thread died), marks a
push stuck in "sending" as failed so HR can push it again, and reads Expo's delivery receipts so Phone Notify Control shows
"Delivered" / "Push failed" without anyone opening the page. Costs a single small query when there is nothing to do.

Same shape as whatsapp_alert_scheduler.py (module-singleton BackgroundScheduler on its own thread); apps.py starts it once at
boot via start_scheduler_if_needed().
"""

import logging

from .scheduler_db import fresh_db_connection

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "phone_push_sweep"
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


@fresh_db_connection
def _run() -> None:
    from . import push_delivery, push_receipts

    try:
        done = push_delivery.sweep()
        if done["pushed"] or done["stuck"]:
            logger.warning("Phone push sweep: %s", done)
    except Exception as e:
        logger.error("Phone push sweep failed: %s", e)
    try:
        push_receipts.check_pending()
    except Exception as e:
        logger.error("Phone push receipt check failed: %s", e)


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
        misfire_grace_time=120,
    )
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Phone push sweep started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start the phone push sweep: %s", e)
