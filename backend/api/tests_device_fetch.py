"""Device Control → Data Fetch: choosing a range, previewing without changing anything, updating through the same write
path as Sync Biometric, and running on a background thread with a history."""

import threading
from datetime import date, datetime, timedelta
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from fake_zk_device import FakeDevice, FakeServer

from . import device_fetch as fetch
from .jwt_utils import sign_token
from .models import (
    Attendance,
    AttendanceLog,
    AuditLog,
    BiometricDevice,
    BiometricDeviceUser,
    BiometricFetchRun,
    Branch,
    Employee,
    HRUser,
    Role,
    UnmatchedPunch,
)

BASE = "/api/attendance/device-control"
TODAY = date(2026, 10, 6)  # a Tuesday


def at(day, hour=9, minute=0, second=0):
    return datetime(2026, 10, day, hour, minute, second)


class FetchBase(TestCase):
    def setUp(self):
        self.fake = FakeDevice(serial="SN-A")
        server = FakeServer(self.fake).start()
        self.addCleanup(server.stop)
        self.a = BiometricDevice.objects.create(
            name="A", host="127.0.0.1", port=server.port, connection_config={"password": 0}
        )
        self.asha = Employee.objects.create(employee_code="1001", first_name="Asha", last_name="K")
        self.ravi = Employee.objects.create(employee_code="1002", first_name="Ravi", last_name="S")
        Employee.objects.create(employee_code="1003", first_name="Meena", last_name="P", status="inactive")
        for uid, code in enumerate(("1001", "1002", "1003", "9001"), start=1):
            self.fake.add_user(uid, code, code)
        self.fake.add_punch("1001", at(6, 9), 0)
        self.fake.add_punch("1001", at(6, 18), 1)
        self.fake.add_punch("1001", at(5, 9), 0)
        self.fake.add_punch("1001", at(5, 18), 1)
        self.fake.add_punch("1002", at(6, 9, 5), 0)
        self.fake.add_punch("9001", at(6, 9, 10), 0)
        self.fake.add_punch("9001", at(6, 18, 10), 1)
        self.fake.add_punch("1003", at(6, 9, 15), 0)

    def make_run(self, mode="update", start=TODAY - timedelta(days=6), end=TODAY, devices=None, label="Last 7 days"):
        devices = devices or [self.a]
        return BiometricFetchRun.objects.create(
            mode=mode,
            status="running",
            started_by="Tester",
            range_label=label,
            date_from=start,
            date_to=end,
            device_ids=[d.pk for d in devices],
            results=[{"deviceId": d.pk, "deviceName": d.name, "status": "reading"} for d in devices],
        )

    def fetch_now(self, **kw):
        run = self.make_run(**kw)
        fetch.execute_run(run.pk)
        run.refresh_from_db()
        return run, {r["deviceId"]: r for r in run.results}


class RangeTests(TestCase):
    def test_every_preset_means_what_it_says(self):
        r = lambda preset: fetch.resolve_range(preset, today=TODAY)[:2]  # noqa: E731
        self.assertEqual(r("today"), (TODAY, TODAY))
        self.assertEqual(r("yesterday"), (date(2026, 10, 5), date(2026, 10, 5)))
        self.assertEqual(r("last7"), (date(2026, 9, 30), TODAY))
        self.assertEqual(r("this_month"), (date(2026, 10, 1), TODAY))
        self.assertEqual(r("last_month"), (date(2026, 9, 1), date(2026, 9, 30)))
        self.assertEqual(r("all"), (None, None))

    def test_last_month_across_a_year_end_and_in_february(self):
        self.assertEqual(
            fetch.resolve_range("last_month", today=date(2026, 1, 15))[:2], (date(2025, 12, 1), date(2025, 12, 31))
        )
        self.assertEqual(
            fetch.resolve_range("last_month", today=date(2026, 3, 1))[:2], (date(2026, 2, 1), date(2026, 2, 28))
        )

    def test_a_custom_range_is_checked(self):
        start, end, label = fetch.resolve_range("custom", "2026-10-01", "2026-10-05")
        self.assertEqual((start, end), (date(2026, 10, 1), date(2026, 10, 5)))
        self.assertIn("01 Oct 2026", label)
        self.assertEqual(fetch.resolve_range("custom", "2026-10-05", "2026-10-05")[2], "05 Oct 2026")
        for bad in (("2026-10-05", "2026-10-01"), ("nope", "2026-10-01"), (None, None)):
            with self.assertRaises(ValueError):
                fetch.resolve_range("custom", *bad)
        with self.assertRaises(ValueError):
            fetch.resolve_range("fortnight")


class PreviewTests(FetchBase):
    def test_a_preview_reports_what_an_update_would_do_and_changes_nothing(self):
        run, results = self.fetch_now(mode="preview")
        r = results[self.a.pk]
        self.assertEqual(run.status, "done")
        self.assertEqual(
            (r["status"], r["onDevice"], r["inRange"], r["matched"], r["new"], r["created"]), ("done", 8, 8, 5, 5, 0)
        )
        self.assertEqual((r["unmatchedPunches"], r["unmatchedIds"]), (3, 2))
        self.assertEqual(AttendanceLog.objects.count(), 0)
        self.assertEqual(Attendance.objects.count(), 0)
        self.assertEqual(UnmatchedPunch.objects.count(), 0)
        self.a.refresh_from_db()
        self.assertIsNone(self.a.last_synced_at, "a preview is not a sync")
        self.assertEqual(run.summary["new"], 5)
        self.assertEqual(len(r["samples"]), 5)
        self.assertEqual(r["samples"][0]["name"], "Asha K")

    def test_only_the_chosen_dates_count(self):
        _run, results = self.fetch_now(mode="preview", start=date(2026, 10, 5), end=date(2026, 10, 5))
        r = results[self.a.pk]
        self.assertEqual((r["onDevice"], r["inRange"], r["new"]), (8, 2, 2))
        _run, results = self.fetch_now(mode="preview", start=None, end=None, label="All")
        self.assertEqual(results[self.a.pk]["inRange"], 8)

    def test_records_with_an_impossible_date_are_counted_not_fatal(self):
        self.fake.invalid_punch_dates = 3
        run, results = self.fetch_now(mode="preview")
        self.assertEqual(results[self.a.pk]["invalidRecords"], 3)
        self.assertEqual(run.status, "done")


class UpdateTests(FetchBase):
    def test_an_update_writes_new_punches_the_way_sync_biometric_does(self):
        run, results = self.fetch_now()
        r = results[self.a.pk]
        self.assertEqual((r["new"], r["created"], r["alreadyInHrms"]), (5, 5, 0))
        logs = AttendanceLog.objects.order_by("date", "punch_time")
        self.assertEqual(logs.count(), 5)
        self.assertEqual({log.source for log in logs}, {"biometric:A"})
        first = logs.first()
        self.assertEqual(
            (first.employee_id, str(first.date), str(first.punch_time), first.punch_type),
            (self.asha.pk, "2026-10-05", "09:00:00", "IN"),
        )
        self.assertTrue(Attendance.objects.filter(employee=self.asha, date="2026-10-06", present=True).exists())
        self.a.refresh_from_db()
        self.assertIsNotNone(self.a.last_synced_at)
        self.assertEqual(self.a.last_sync_error, "")

    def test_running_it_again_adds_nothing_and_says_the_hrms_already_has_them(self):
        self.fetch_now()
        run, results = self.fetch_now()
        r = results[self.a.pk]
        self.assertEqual((r["new"], r["created"], r["alreadyInHrms"]), (0, 0, 5))
        self.assertEqual(AttendanceLog.objects.count(), 5)

    def test_a_punch_the_hrms_already_has_from_elsewhere_is_not_doubled(self):
        AttendanceLog.objects.create(
            employee=self.asha,
            date=date(2026, 10, 6),
            punch_time=datetime(2026, 10, 6, 9).time(),
            punch_type="IN",
            source="biometric:adms",
        )
        _run, results = self.fetch_now()
        self.assertEqual((results[self.a.pk]["new"], results[self.a.pk]["alreadyInHrms"]), (4, 1))
        self.assertEqual(AttendanceLog.objects.count(), 5)

    def test_the_same_punch_twice_on_the_device_is_one_punch(self):
        self.fake.add_punch("1001", at(6, 9), 0)
        _run, results = self.fetch_now()
        self.assertEqual((results[self.a.pk]["new"], results[self.a.pk]["alreadyInHrms"]), (5, 1))

    def test_the_device_status_codes_mean_what_they_mean_in_sync_biometric(self):
        for hour, status in ((10, 4), (11, 5), (12, 255), (13, 1), (14, 0)):
            self.fake.add_punch("1002", at(6, hour), status)
        self.fetch_now()
        types = {str(log.punch_time): log.punch_type for log in AttendanceLog.objects.filter(employee=self.ravi)}
        self.assertEqual(types["10:00:00"], "IN")
        self.assertEqual(types["11:00:00"], "OUT")
        self.assertEqual(types["12:00:00"], "IN", "an undefined status is an In, as in Sync Biometric")
        self.assertEqual(types["13:00:00"], "OUT")
        self.assertEqual(types["14:00:00"], "IN")

    def test_ids_with_no_active_employee_are_reported_and_not_added_to_the_skipped_list(self):
        BiometricDeviceUser.objects.create(
            device=self.a, uid=4, user_id="9001", name="Stranger", read_at=timezone.now()
        )
        run, results = self.fetch_now()
        r = results[self.a.pk]
        self.assertEqual(
            {(u["userId"], u["punches"]) for u in r["unmatched"]},
            {("9001", 2), ("1003", 1)},
            "an Inactive employee's punches have no active employee",
        )
        self.assertEqual(
            UnmatchedPunch.objects.count(), 0, "reading a range twice must not count its punches twice there"
        )
        merged = {u["userId"]: u for u in run.summary["unmatched"]}
        self.assertEqual(merged["9001"]["deviceName"], "Stranger")
        self.assertEqual(run.summary["unmatchedPunches"], 3)

    def test_six_or_more_punches_in_a_day_are_flagged_as_the_sync_flags_them(self):
        for minute in range(2, 8):
            self.fake.add_punch("1002", at(6, 10, minute), 0)
        run, _results = self.fetch_now()
        days = run.summary["suspiciousDays"]
        self.assertEqual([(d["employeeName"], d["date"], d["punches"]) for d in days], [("Ravi S", "2026-10-06", 7)])

    def test_one_device_failing_does_not_stop_the_others_and_is_remembered_for_an_update(self):
        down_fake = FakeDevice()
        server = FakeServer(down_fake).start()
        down = BiometricDevice.objects.create(
            name="Down", host="127.0.0.1", port=server.port, connection_config={"password": 0}
        )
        server.stop()
        run, results = self.fetch_now(devices=[self.a, down])
        self.assertEqual(run.status, "done")
        self.assertEqual((results[self.a.pk]["status"], results[down.pk]["status"]), ("done", "failed"))
        self.assertEqual(results[down.pk]["code"], "refused")
        self.assertEqual((run.summary["devicesDone"], run.summary["devicesFailed"]), (1, 1))
        down.refresh_from_db()
        self.assertIn("refused", down.last_sync_error)

    def test_a_preview_does_not_record_a_failure_as_a_sync_failure(self):
        server = FakeServer(FakeDevice()).start()
        down = BiometricDevice.objects.create(
            name="Down", host="127.0.0.1", port=server.port, connection_config={"password": 0}
        )
        server.stop()
        self.fetch_now(mode="preview", devices=[down])
        down.refresh_from_db()
        self.assertEqual(down.last_sync_error, "")

    def test_when_no_device_can_be_read_the_run_failed(self):
        server = FakeServer(FakeDevice()).start()
        down = BiometricDevice.objects.create(
            name="Down", host="127.0.0.1", port=server.port, connection_config={"password": 0}
        )
        server.stop()
        run, _results = self.fetch_now(devices=[down])
        self.assertEqual((run.status, run.error), ("failed", "No device could be read."))

    def test_a_bad_comm_key_in_settings_is_a_configuration_error_for_that_device(self):
        bad = BiometricDevice.objects.create(
            name="Bad", host="127.0.0.1", port=1, connection_config={"password": "abc"}
        )
        _run, results = self.fetch_now(devices=[self.a, bad])
        self.assertEqual(results[bad.pk]["code"], "config")
        self.assertEqual(results[self.a.pk]["status"], "done")


class StartTests(FetchBase):
    def starter(self, **kw):
        user = {"name": "Tester", "role": "hr"}
        request = mock.Mock(jwt_user=user, META={"REMOTE_ADDR": "10.0.0.1"}, hr_branch_id=None)
        defaults = dict(device_ids=[self.a.pk], preset="today", date_from=None, date_to=None, apply=False)
        defaults.update(kw)
        with (
            mock.patch.object(fetch.threading, "Thread") as thread,
            mock.patch.object(fetch, "ist_today", return_value=TODAY),
        ):
            run = fetch.start_run(request, **defaults)
        return run, thread

    def test_starting_a_run_creates_it_and_hands_it_to_a_background_thread(self):
        run, thread = self.starter(apply=True, preset="last7")
        self.assertEqual((run.status, run.mode, run.range_label), ("running", "update", "Last 7 days"))
        self.assertEqual((run.date_from, run.date_to), (date(2026, 9, 30), TODAY))
        self.assertEqual(run.results[0]["status"], "reading")
        thread.return_value.start.assert_called_once()
        self.assertEqual(AuditLog.objects.filter(action="update", module="attendance", record_id=run.pk).count(), 1)

    def test_the_thread_runs_the_fetch_to_the_end(self):
        run, thread = self.starter(apply=True, preset="all")
        self.assertEqual(thread.call_args.kwargs["target"], fetch._background)
        self.assertEqual(thread.call_args.kwargs["args"], (run.pk,))
        with mock.patch.object(fetch, "connection") as thread_connection:
            fetch._background(run.pk)
        thread_connection.close.assert_called()  # the thread's own connection, and its heartbeat's
        run.refresh_from_db()
        self.assertEqual((run.status, run.summary["created"]), ("done", 5))

    def test_a_crash_in_the_thread_is_recorded_on_the_run_not_lost(self):
        run, _thread = self.starter()
        with (
            mock.patch.object(fetch, "execute_run", side_effect=RuntimeError("boom")),
            mock.patch.object(fetch, "connection"),
        ):
            fetch._background(run.pk)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("boom", run.error)
        self.assertIsNotNone(run.finished_at)

    def test_only_one_run_at_a_time(self):
        self.starter()
        with self.assertRaises(fetch.FetchConflict):
            self.starter()

    def test_a_run_that_never_finished_is_expired_so_it_cannot_block_forever(self):
        stuck, _ = self.starter()
        BiometricFetchRun.objects.filter(pk=stuck.pk).update(
            updated_at=timezone.now() - timedelta(minutes=fetch.STALE_RUN_MINUTES + 1)
        )
        fresh, _ = self.starter()
        stuck.refresh_from_db()
        self.assertEqual(stuck.status, "failed")
        self.assertIn("without finishing", stuck.error)
        self.assertEqual(fresh.status, "running")

    def test_it_waits_for_the_sync_button_on_the_attendance_page(self):
        with mock.patch("api.sync_progress.is_running", return_value=True):
            with self.assertRaises(fetch.FetchConflict) as caught:
                self.starter()
        self.assertIn("Attendance page", str(caught.exception))

    def test_devices_must_be_chosen_and_switched_on(self):
        with self.assertRaises(ValueError):
            self.starter(device_ids=[])
        BiometricDevice.objects.filter(pk=self.a.pk).update(is_active=False)
        with self.assertRaises(ValueError):
            self.starter()
        with self.assertRaises(ValueError):
            self.starter(device_ids=[self.a.pk], preset="nonsense")

    def test_old_runs_are_pruned(self):
        for _ in range(105):
            BiometricFetchRun.objects.create(status="done")
        self.starter()
        self.assertLessEqual(BiometricFetchRun.objects.count(), 102)

    def test_the_history_lists_newest_first_with_how_long_each_took(self):
        first, _ = self.starter()
        BiometricFetchRun.objects.filter(pk=first.pk).update(status="done", finished_at=timezone.now())
        second, _ = self.starter(preset="yesterday")
        runs = fetch.list_runs()
        self.assertEqual([r["id"] for r in runs], [second.pk, first.pk])
        self.assertEqual(runs[0]["rangeLabel"], "Yesterday")
        self.assertGreaterEqual(runs[1]["elapsedSeconds"], 0)


@override_settings(ALLOWED_HOSTS=["*"])
class FetchEndpointTests(FetchBase):
    def setUp(self):
        super().setUp()
        self.admin = self.headers(username="fe_admin")

    def headers(self, super_admin=True, permissions=None, username="fe_user"):
        role = (
            Role.objects.create(name=f"role-{username}", permissions=permissions) if permissions is not None else None
        )
        user = HRUser.objects.create(username=username, password_hash="x", is_super_admin=super_admin, role=role)
        return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}

    def start(self, body, headers=None):
        with mock.patch.object(fetch.threading, "Thread"):
            return self.client.post(
                f"{BASE}/fetch/start", body, content_type="application/json", **(headers or self.admin)
            )

    def test_starting_returns_the_run_to_poll(self):
        r = self.start({"deviceIds": [self.a.pk], "range": {"preset": "today"}, "apply": False})
        self.assertEqual(r.status_code, 202)
        body = r.json()
        self.assertEqual((body["status"], body["mode"], body["rangeLabel"]), ("running", "preview", "Today"))
        polled = self.client.get(f"{BASE}/fetch/runs/{body['id']}", **self.admin).json()
        self.assertEqual(polled["id"], body["id"])
        listed = self.client.get(f"{BASE}/fetch/runs", **self.admin).json()["runs"]
        self.assertEqual([r["id"] for r in listed], [body["id"]])

    def test_a_custom_range_and_an_update_through_the_api(self):
        r = self.start(
            {
                "deviceIds": [self.a.pk],
                "range": {"preset": "custom", "from": "2026-10-01", "to": "2026-10-05"},
                "apply": True,
            }
        )
        self.assertEqual(
            (r.json()["mode"], r.json()["dateFrom"], r.json()["dateTo"]), ("update", "2026-10-01", "2026-10-05")
        )

    def test_bad_requests_and_a_busy_system_are_told_plainly(self):
        self.assertEqual(self.start({"deviceIds": "x", "range": {}}).status_code, 400)
        self.assertEqual(
            self.start({"deviceIds": [self.a.pk], "range": {"preset": "custom", "from": "x", "to": "y"}}).status_code,
            400,
        )
        self.assertEqual(self.start({"deviceIds": [], "range": {"preset": "today"}}).status_code, 400)
        self.assertEqual(self.start({"deviceIds": [self.a.pk], "range": "today"}).status_code, 400)
        self.assertEqual(self.start({"deviceIds": [self.a.pk], "range": {"preset": "today"}}).status_code, 202)
        busy = self.start({"deviceIds": [self.a.pk], "range": {"preset": "today"}})
        self.assertEqual(busy.status_code, 409)
        self.assertIn("already running", busy.json()["error"])
        self.assertEqual(self.client.get(f"{BASE}/fetch/runs/99999", **self.admin).status_code, 404)

    def test_a_role_that_may_only_view_attendance_can_read_the_history_but_not_start_a_run(self):
        viewer = self.headers(super_admin=False, permissions={"attendance": "view"}, username="fe_viewer")
        self.assertEqual(self.client.get(f"{BASE}/fetch/runs", **viewer).status_code, 200)
        self.assertEqual(self.start({"deviceIds": [self.a.pk], "range": {"preset": "today"}}, viewer).status_code, 403)
        self.assertEqual(BiometricFetchRun.objects.count(), 0)


# ─── what an independent review found ───────────────────────────────────────────────────────────────────────────────────


class ReviewFetchTests(FetchBase):
    def test_a_punch_the_hrms_has_is_recognised_whatever_its_in_out_byte_said(self):
        """A pull reads the device's verify byte, a push its In/Out state: the same punch must not be made twice."""
        AttendanceLog.objects.create(
            employee=self.asha,
            date=date(2026, 10, 6),
            punch_time=datetime(2026, 10, 6, 9).time(),
            punch_type="OUT",
            source="biometric:adms",
        )
        _run, results = self.fetch_now()
        self.assertEqual(results[self.a.pk]["alreadyInHrms"], 1)
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha, date=date(2026, 10, 6)).count(), 2)

    def test_a_device_that_blows_up_unexpectedly_fails_by_itself(self):
        with mock.patch.object(fetch, "open_session", side_effect=RuntimeError("kaboom")):
            run, results = self.fetch_now(mode="preview")
        self.assertEqual(results[self.a.pk]["status"], "failed")
        self.assertIn("kaboom", results[self.a.pk]["error"])
        self.assertEqual(run.status, "failed")

    def test_the_run_reads_logs_with_the_long_deadline(self):
        with mock.patch.object(fetch, "open_session", wraps=fetch.open_session) as opened:
            self.fetch_now(mode="preview")
        self.assertEqual(opened.call_args.kwargs["deadline"], fetch.LOG_READ_DEADLINE_SECONDS)

    def test_a_running_run_keeps_beating_so_it_is_not_mistaken_for_a_dead_one(self):
        run = self.make_run()
        BiometricFetchRun.objects.filter(pk=run.pk).update(updated_at=timezone.now() - timedelta(minutes=30))
        stop = threading.Event()
        threading.Timer(0.15, stop.set).start()
        with mock.patch.object(fetch, "HEARTBEAT_SECONDS", 0.02), mock.patch.object(fetch, "connection"):
            fetch._heartbeat(run.pk, stop)
        run.refresh_from_db()
        self.assertLess((timezone.now() - run.updated_at).total_seconds(), 60)
        # and a run that stopped beating is expired, so it cannot block the next one
        BiometricFetchRun.objects.filter(pk=run.pk).update(
            updated_at=timezone.now() - timedelta(minutes=fetch.STALE_RUN_MINUTES + 1)
        )
        fetch.list_runs()
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")


@override_settings(ALLOWED_HOSTS=["*"])
class ReviewFetchEndpointTests(FetchBase):
    def setUp(self):
        super().setUp()
        self.admin = self.headers(username="rev_fe_admin")

    def headers(self, super_admin=True, permissions=None, username="rev_fe", branch=None):
        role = (
            Role.objects.create(name=f"role-{username}", permissions=permissions) if permissions is not None else None
        )
        user = HRUser.objects.create(
            username=username, password_hash="x", is_super_admin=super_admin, role=role, branch=branch
        )
        return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}

    def test_the_word_false_starts_a_preview_not_an_update(self):
        with mock.patch.object(fetch.threading, "Thread"):
            r = self.client.post(
                f"{BASE}/fetch/start",
                {"deviceIds": [self.a.pk], "range": {"preset": "today"}, "apply": "false"},
                content_type="application/json",
                **self.admin,
            )
        self.assertEqual((r.status_code, r.json()["mode"]), (202, "preview"))

    def test_a_branch_limited_caller_sees_the_counts_but_not_the_names(self):
        BiometricDeviceUser.objects.create(
            device=self.a, uid=4, user_id="9001", name="Stranger", read_at=timezone.now()
        )
        run, _results = self.fetch_now(mode="preview")
        branch = Branch.objects.create(name="Mine", code="MB")
        scoped = self.headers(
            super_admin=False, permissions={"attendance": "view"}, username="rev_fe_scoped", branch=branch
        )
        shown = self.client.get(f"{BASE}/fetch/runs/{run.pk}", **scoped).json()
        device = shown["results"][0]
        self.assertTrue(device["samples"], "the punches are still listed")
        self.assertEqual({p["name"] for p in device["samples"]}, {""})
        self.assertEqual({u["deviceName"] for u in shown["summary"]["unmatched"]}, {""})
        self.assertIn("9001", {u["userId"] for u in shown["summary"]["unmatched"]})
        listed = self.client.get(f"{BASE}/fetch/runs", **scoped).json()["runs"][0]
        self.assertEqual({p["name"] for p in listed["results"][0]["samples"]}, {""})
        # an unrestricted caller still sees everything
        full = self.client.get(f"{BASE}/fetch/runs/{run.pk}", **self.admin).json()
        self.assertIn("Asha K", {p["name"] for p in full["results"][0]["samples"]})
