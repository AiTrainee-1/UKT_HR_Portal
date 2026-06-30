import logging
import os

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # Guard against double-invocation by Django's auto-reloader
        if os.environ.get("RUN_MAIN") != "true" and os.environ.get("DJANGO_SETTINGS_MODULE"):
            # In production (gunicorn/waitress) RUN_MAIN isn't set — allow once
            pass
        self._start_scheduler()

    def _start_scheduler(self):
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            from apscheduler.triggers.cron import CronTrigger
        except ImportError:
            logger.warning("APScheduler not installed — biometric auto-sync disabled. Run: pip install apscheduler")
            return

        from .attendance_views import run_biometric_sync

        def _scheduled_sync():
            logger.info("Scheduled biometric sync started")
            result = run_biometric_sync(mode="today")
            if result["ok"]:
                logger.info("Scheduled biometric sync complete — %d new records", result.get("created", 0))
            else:
                logger.error("Scheduled biometric sync failed: %s", result.get("error"))

        scheduler = BackgroundScheduler(timezone="Asia/Kolkata")
        scheduler.add_job(_scheduled_sync, CronTrigger(hour=7,  minute=30), id="bio_sync_morning", replace_existing=True)
        scheduler.add_job(_scheduled_sync, CronTrigger(hour=20, minute=30), id="bio_sync_evening", replace_existing=True)

        try:
            scheduler.start()
            logger.info("Biometric scheduler started — jobs: 07:30 and 20:30 IST daily")
        except Exception as e:
            logger.error("Failed to start biometric scheduler: %s", e)
