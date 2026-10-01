"""
Process start-up (api/apps.py): ``ready()`` must not touch the database.

Django warns "Accessing the database during app initialization is discouraged" on every start (the migrate step and each
gunicorn worker) when ``ready()`` queries. The work that needs the database (the admin account, the scheduled jobs) now
waits until the app registry is ready. These tests pin that, and the admin bootstrap itself.

Run via: python manage.py test api.tests_app_startup -v 2
"""

import sys
import threading
import time
from unittest import mock

from django.apps import apps
from django.test import TestCase, override_settings

from .apps import run_after_apps_ready
from .models import HRUser


class ReadyTouchesNoDatabaseTests(TestCase):
    def test_ready_itself_runs_no_queries_and_hands_both_jobs_to_the_deferred_runner(self):
        config = apps.get_app_config("api")
        with (
            mock.patch("api.apps.run_after_apps_ready") as deferred,
            mock.patch("api.approval_workflow._connect_cache_invalidation"),
            self.assertNumQueries(0),
        ):
            config.ready()
        (name, *jobs), _ = deferred.call_args
        self.assertEqual(name, "api-startup")
        self.assertEqual(jobs, [config._bootstrap_admin_account, config._start_scheduler])


class DeferredRunnerTests(TestCase):
    def test_jobs_run_in_order_on_another_thread_and_one_failing_does_not_stop_the_next(self):
        where, order = [], []

        def first():
            where.append(threading.current_thread())
            order.append("first")
            raise RuntimeError("boom")

        def second():
            order.append("second")

        with self.assertLogs("api.apps", level="ERROR"):
            thread = run_after_apps_ready("test-startup", first, second)
            thread.join(5)
        self.assertEqual(order, ["first", "second"])
        self.assertIsNot(where[0], threading.current_thread())
        self.assertTrue(thread.daemon)
        self.assertFalse(thread.is_alive())

    def test_nothing_runs_until_the_app_registry_is_ready(self):
        ran = []
        gate = threading.Event()  # an event that is not set yet, as during start-up
        with mock.patch.object(apps, "ready_event", gate):
            thread = run_after_apps_ready("test-startup", lambda: ran.append(1))
            time.sleep(0.3)
            self.assertEqual(ran, [], "the job must wait for the registry")
            gate.set()
            thread.join(5)
        self.assertEqual(ran, [1])


@override_settings(ADMIN_USERNAME="boot_admin", ADMIN_PASSWORD="Boot-Strap-1!")
class AdminBootstrapTests(TestCase):
    def config(self):
        return apps.get_app_config("api")

    def test_not_run_under_the_test_runner(self):
        with mock.patch.object(sys, "argv", ["manage.py", "test", "api"]):
            self.config()._bootstrap_admin_account()
        self.assertFalse(HRUser.objects.exists())

    def test_creates_the_one_super_admin_and_is_idempotent(self):
        with mock.patch.object(sys, "argv", ["manage.py", "runserver"]):
            self.config()._bootstrap_admin_account()
            self.config()._bootstrap_admin_account()
        admins = HRUser.objects.filter(is_super_admin=True)
        self.assertEqual(admins.count(), 1)
        admin = admins.get()
        self.assertEqual((admin.username, admin.is_active), ("boot_admin", True))
        self.assertNotEqual(admin.password_hash, "Boot-Strap-1!")  # stored hashed

    def test_nothing_without_credentials(self):
        with (
            mock.patch.object(sys, "argv", ["manage.py", "runserver"]),
            override_settings(ADMIN_USERNAME="", ADMIN_PASSWORD=""),
        ):
            self.config()._bootstrap_admin_account()
        self.assertFalse(HRUser.objects.exists())

    def test_an_existing_super_admin_is_left_alone(self):
        HRUser.objects.create(username="someone", password_hash="x", is_super_admin=True)
        with mock.patch.object(sys, "argv", ["manage.py", "runserver"]):
            self.config()._bootstrap_admin_account()
        self.assertEqual(list(HRUser.objects.values_list("username", flat=True)), ["someone"])
