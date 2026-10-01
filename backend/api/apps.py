import logging
import os
import sys
import threading

from django.apps import AppConfig, apps

logger = logging.getLogger(__name__)


def run_after_apps_ready(name: str, *jobs) -> threading.Thread:
    """Run ``jobs`` (in order, each isolated from the others' failures) once Django has finished loading every app.

    Django refuses queries while the app registry is still loading and warns "Accessing the database during app
    initialization is discouraged" on every process start (the migrate step and each gunicorn worker). The work that
    needs the database (creating the admin account, loading the scheduled jobs) therefore waits on a short-lived
    thread until ``apps.ready_event`` is set, which Django does after the last ``ready()`` has returned. The thread
    closes its own database connection when it is done. A daemon thread, so it never holds a process open."""

    def runner() -> None:
        apps.ready_event.wait()
        try:
            for job in jobs:
                try:
                    job()
                except Exception:
                    logger.exception("Startup task %s failed", getattr(job, "__name__", job))
        finally:
            from django.db import connections

            connections.close_all()

    thread = threading.Thread(target=runner, name=name, daemon=True)
    thread.start()
    return thread


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        from . import signals  # noqa: F401 -registers the push-notification signal receiver
        from . import approval_workflow

        approval_workflow._connect_cache_invalidation()

        # Both of these read or write the database, which is not allowed while apps are loading: see run_after_apps_ready.
        run_after_apps_ready("api-startup", self._bootstrap_admin_account, self._start_scheduler)

    def _bootstrap_admin_account(self):
        """
        Ensure exactly one super-admin HRUser exists, sourced from
        ADMIN_USERNAME/ADMIN_PASSWORD in .env. Idempotent -only inserts when
        no super-admin row exists yet, so editing the admin's password later
        is done from Account Management, not by touching .env again.
        Wrapped defensively: this runs on every app load, including before
        the hr_users table exists (e.g. during the very first `migrate`).
        """
        from django.conf import settings

        # Not under the test runner: it would act on whichever database is configured at that instant (the runner
        # swaps in the test database a moment later), and no test wants an account created behind its back.
        if len(sys.argv) > 1 and sys.argv[1] == "test":
            return

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
            # DB not migrated yet, or unavailable at boot -safe to skip,
            # this is retried on every subsequent process start.
            logger.warning("Admin account bootstrap skipped: %s", e)

    def _start_scheduler(self):
        # runserver's autoreloader calls ready() in both the watcher process
        # and the actual reloaded worker (RUN_MAIN=true in the worker only) —
        # without this guard the scheduler would start twice in dev, firing
        # every job twice. Any other entrypoint (--noreload, gunicorn/waitress
        # in production, where RUN_MAIN is never set at all) starts normally.
        # Never under the test runner: a job that fires mid-test (the WhatsApp alert job runs every
        # minute) would act on the test database while tests hold global mocks and settings overrides,
        # and its open connection would block dropping the test database afterwards.
        if len(sys.argv) > 1 and sys.argv[1] == "test":
            return
        watcher_process = (
            "runserver" in sys.argv and "--noreload" not in sys.argv and os.environ.get("RUN_MAIN") != "true"
        )
        if watcher_process:
            return

        from . import (
            auto_sync,
            backup_scheduler,
            on_duty_day_end_scheduler,
            screening_cleanup_scheduler,
            whatsapp_alert_scheduler,
        )

        if not auto_sync.is_available():
            logger.warning("APScheduler not installed -Auto Sync disabled. Run: pip install apscheduler")
            return

        try:
            auto_sync.load_all_rules_into_scheduler()
            auto_sync.start_scheduler_if_needed()
        except Exception as e:
            # DB not migrated yet, or unavailable at boot -safe to skip,
            # retried on every subsequent process start.
            logger.warning("Auto Sync scheduler bootstrap skipped: %s", e)

        try:
            backup_scheduler.load_schedule_into_scheduler()
            backup_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Backup scheduler bootstrap skipped: %s", e)

        try:
            screening_cleanup_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Screening document retention scheduler bootstrap skipped: %s", e)

        try:
            on_duty_day_end_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("On-Duty day-end scheduler bootstrap skipped: %s", e)

        try:
            whatsapp_alert_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("WhatsApp attendance alert scheduler bootstrap skipped: %s", e)
