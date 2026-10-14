"""
OT detection scheduler: one interval job, every 15 minutes.

Same shape as whatsapp_alert_scheduler.py (module-singleton BackgroundScheduler on its own thread). The job
(overtime.run_detection_job) re-derives the stored attendance day of anybody whose punches arrived after it was last
computed and then syncs the OT rows (Type 1 allowance rows, Type 2 candidates) of the current month, so the rows exist
without anybody opening Compensation > OT Detection: the employee apps and the History & Reports read them.

There is no HR-facing switch for the job itself: the master switch and the two OT features in Settings are checked inside
run_detection_job on every run (all off: it returns after two queries), so flipping a switch takes effect on the next run
with no restart. apps.py starts this once at boot via start_scheduler_if_needed(); never under the test runner.
"""

import logging

logger = logging.getLogger(__name__)

_scheduler = None
_JOB_ID = "overtime_detection"
_INTERVAL_MINUTES = 15


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

    from . import overtime

    close_old_connections()
    try:
        summary = overtime.run_detection_job()
        if summary.get("created") or summary.get("updated") or summary.get("deleted") or summary.get("recomputed"):
            logger.info("OT detection pass: %s", summary)
    except Exception:
        logger.exception("OT detection job failed")
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
            logger.info("OT detection scheduler started (every %s min)", _INTERVAL_MINUTES)
        except Exception as e:
            logger.error("Failed to start OT detection scheduler: %s", e)
