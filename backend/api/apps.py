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
        Keep the Super Admin's login equal to ADMIN_USERNAME / ADMIN_PASSWORD from the backend .env (the Railway
        Variables in production): the .env is the single source of truth for it (owner 2026-11-10). On every process
        start the Super Admin in hr_users is compared with the .env values and updated when they differ; when they
        already match nothing is written. With no Super Admin yet one is made from the .env, as before. Only the Super
        Admin is ever touched, and blank .env values change nothing. See api/super_admin_sync.py.
        Wrapped defensively: this runs on every app load, including before the hr_users table exists (e.g. during the
        very first `migrate`).
        """
        from django.conf import settings

        # Not under the test runner: it would act on whichever database is configured at that instant (the runner
        # swaps in the test database a moment later), and no test wants an account created behind its back.
        if len(sys.argv) > 1 and sys.argv[1] == "test":
            return

        try:
            from .super_admin_sync import sync_super_admin

            sync_super_admin(getattr(settings, "ADMIN_USERNAME", ""), getattr(settings, "ADMIN_PASSWORD", ""))
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
            geo_tracking_scheduler,
            hod_reminder_scheduler,
            md_auto_attendance_scheduler,
            attendance_refresh_scheduler,
            on_duty_day_end_scheduler,
            overtime_scheduler,
            screening_cleanup_scheduler,
            whatsapp_alert_scheduler,
            whatsapp_dispatcher,
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
            geo_tracking_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Geo-tracking scheduler bootstrap skipped: %s", e)

        try:
            whatsapp_alert_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("WhatsApp attendance alert scheduler bootstrap skipped: %s", e)

        try:
            # the WhatsApp send queue's one paced sender (every 10 s): nothing but a one-time code leaves without it
            whatsapp_dispatcher.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("WhatsApp dispatcher bootstrap skipped: %s", e)

        try:
            overtime_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("OT detection scheduler bootstrap skipped: %s", e)

        try:
            # every stored attendance day follows its punches: a late punch is re-judged within 5 minutes
            attendance_refresh_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Attendance refresh scheduler bootstrap skipped: %s", e)

        try:
            hod_reminder_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("Department Head reminder scheduler bootstrap skipped: %s", e)

        try:
            md_auto_attendance_scheduler.start_scheduler_if_needed()
        except Exception as e:
            logger.warning("MD auto attendance scheduler bootstrap skipped: %s", e)
