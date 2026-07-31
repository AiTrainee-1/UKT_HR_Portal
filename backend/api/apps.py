import logging
import os

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
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
        # runserver's autoreloader calls ready() in both the watcher process
        # and the actual reloaded worker (RUN_MAIN=true in the worker only) —
        # without this guard the scheduler would start twice in dev, firing
        # every job twice. Any other entrypoint (--noreload, gunicorn/waitress
        # in production, where RUN_MAIN is never set at all) starts normally.
        import sys
        watcher_process = "runserver" in sys.argv and "--noreload" not in sys.argv and os.environ.get("RUN_MAIN") != "true"
        if watcher_process:
            return

        from . import auto_sync, backup_scheduler

        if not auto_sync.is_available():
            logger.warning("APScheduler not installed — Auto Sync disabled. Run: pip install apscheduler")
            return

        try:
            auto_sync.load_all_rules_into_scheduler()
            auto_sync.start_scheduler_if_needed()
        except Exception as e:
            # DB not migrated yet, or unavailable at boot — safe to skip,
            # retried on every subsequent process start.
            logger.warning("Auto Sync scheduler bootstrap skipped: %s", e)

        try:
            backup_scheduler.load_schedule_into_scheduler()
            backup_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Backup scheduler bootstrap skipped: %s", e)
