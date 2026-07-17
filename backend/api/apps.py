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
        from . import signals  # noqa: F401 — registers the push-notification signal receiver

        self._bootstrap_admin_account()
        self._start_scheduler()

    def _bootstrap_admin_account(self):
        """
        Ensure exactly one super-admin HRUser exists, sourced from
        ADMIN_USERNAME/ADMIN_PASSWORD in .env. Idempotent — only inserts when
        no super-admin row exists yet, so editing the admin's password later
        is done from Account Management, not by touching .env again.
        Wrapped defensively: this runs on every app load, including before
        the hr_users table exists (e.g. during the very first `migrate`).
        """
        from django.conf import settings

        username = getattr(settings, "ADMIN_USERNAME", "")
        password = getattr(settings, "ADMIN_PASSWORD", "")
        if not username or not password:
            return

        try:
            import bcrypt
            from .models import HRUser

            if HRUser.objects.filter(is_super_admin=True).exists():
                return

            pwd_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
            existing = HRUser.objects.filter(username__iexact=username).first()
            if existing:
                existing.password_hash = pwd_hash
                existing.is_super_admin = True
                existing.is_active = True
                existing.save(update_fields=["password_hash", "is_super_admin", "is_active"])
            else:
                HRUser.objects.create(
                    username=username,
                    full_name="Administrator",
                    password_hash=pwd_hash,
                    is_super_admin=True,
                )
            logger.info("Admin account bootstrapped from ADMIN_USERNAME/.env: %s", username)
        except Exception as e:
            # DB not migrated yet, or unavailable at boot — safe to skip,
            # this is retried on every subsequent process start.
            logger.warning("Admin account bootstrap skipped: %s", e)

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
