"""
Device Control additions (owner 2026-11-17): Data Fetch for staff / production / one employee with a progress that counts
the records as the device's log arrives; Link / Unlink Home (summary) and Modified (history); the history of user changes
on the devices, written for a direct device and for one behind a Site Connector alike.

Run via: python manage.py test api.tests_device_control_extras --keepdb
"""

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from fake_zk_device import FakeDevice, FakeServer

from . import device_fetch as fetch
from .device_client import _counting_reads
from .device_control_extras import record_user_change
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    BiometricDevice,
    BiometricDeviceUser,
    BiometricFetchRun,
    BiometricUserChange,
    Branch,
    Employee,
    EmployeeDeviceLinkChange,
    HRUser,
)

BASE = "/api/attendance/device-control"
TODAY = date(2026, 10, 6)


def at(day, hour=9, minute=0, second=0):
    return datetime(2026, 10, day, hour, minute, second)


def bearer(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': 'Tester'})}"}


class Base(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="dcx_admin", password_hash="x", is_super_admin=True)
        self.h = bearer(self.admin)
        self.fake = FakeDevice(serial="SN-X")
        server = FakeServer(self.fake).start()
        self.addCleanup(server.stop)
        self.dev = BiometricDevice.objects.create(
            name="Gate A", host="127.0.0.1", port=server.port, connection_config={"password": 0}
        )
        self.staff = Employee.objects.create(
            employee_code="2001", first_name="Sara", last_name="Staff", employment_type="staff"
        )
        self.worker = Employee.objects.create(
            employee_code="3001", first_name="Kavi", last_name="Worker", employment_type="production"
        )
        self.worker2 = Employee.objects.create(
            employee_code="3002", first_name="Mani", last_name="Worker", employment_type="production"
        )
        for uid, code in enumerate(("2001", "3001", "3002", "9999"), start=1):
            self.fake.add_user(uid, code, code)
        for code in ("2001", "3001", "3002", "9999"):
            self.fake.add_punch(code, at(6, 9), 0)
            self.fake.add_punch(code, at(6, 18), 1)

    def run_fetch(self, scope=None, mode="update"):
        run = BiometricFetchRun.objects.create(
            mode=mode,
            status="running",
            started_by="Tester",
            range_label="Last 7 days",
            date_from=TODAY - timedelta(days=6),
            date_to=TODAY,
            device_ids=[self.dev.pk],
            scope=scope,
            results=[
                {"deviceId": self.dev.pk, "deviceName": self.dev.name, "status": "reading", "stage": "connecting"}
            ],
        )
        fetch.execute_run(run.pk)
        run.refresh_from_db()
        return run, run.results[0]


class FetchScopeTests(Base):
    def test_everyone_is_unchanged(self):
        run, r = self.run_fetch()
        self.assertEqual(r["created"], 6)
        self.assertEqual(r["outOfScope"], 0)
        self.assertEqual(r["unmatchedIds"], 1)  # 9999: no employee, reported as before

    def test_production_only(self):
        run, r = self.run_fetch(scope={"employmentType": "production"})
        self.assertEqual(r["created"], 4)
        self.assertEqual(r["outOfScope"], 4)  # the staff member's two and the unknown ID's two: only counted
        self.assertEqual(r["unmatchedIds"], 0)
        self.assertFalse(AttendanceLog.objects.filter(employee=self.staff).exists())
        self.assertEqual(run.summary["outOfScope"], 4)

    def test_one_employee(self):
        run, r = self.run_fetch(scope={"employeeIds": [self.worker.pk]})
        self.assertEqual(r["created"], 2)
        self.assertEqual(r["outOfScope"], 6)
        self.assertEqual(set(AttendanceLog.objects.values_list("employee_id", flat=True)), {self.worker.pk})

    def test_the_progress_counts_the_records_as_they_arrive(self):
        # a log big enough for the terminal to send it in 64 KB blocks, as a real one does
        self.fake.chunk_reads = True
        for i in range(2000):
            self.fake.add_punch("9999", at(1, 6) + timedelta(minutes=i), 0)
        seen = []
        real = fetch._save_results

        def spy(run_id, results):
            seen.append(dict(results[0]))
            real(run_id, results)

        with mock.patch.object(fetch, "_save_results", spy), mock.patch.object(fetch, "PROGRESS_SECONDS", 0.001):
            run, r = self.run_fetch(scope={"employeeIds": [self.worker.pk]}, mode="preview")
        self.assertEqual(r["stage"], "done")
        self.assertEqual(r["recordsRead"], 2008)
        self.assertEqual(r["recordsTotal"], 2008)
        self.assertEqual(r["new"], 2)
        reading = [s for s in seen if s.get("stage") == "reading" and s.get("recordsTotal")]
        self.assertTrue(reading, "the run published its reading progress")
        self.assertTrue(all(0 <= s["recordsRead"] <= s["recordsTotal"] for s in reading))

    def test_scope_is_checked_when_the_run_starts(self):
        r = self.client.post(
            f"{BASE}/fetch/start",
            {"deviceIds": [self.dev.pk], "range": {"preset": "today"}, "scope": {"employmentType": "contract"}},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(r.status_code, 400)
        Employee.objects.filter(pk=self.worker2.pk).update(status="inactive")
        r = self.client.post(
            f"{BASE}/fetch/start",
            {"deviceIds": [self.dev.pk], "range": {"preset": "today"}, "scope": {"employeeIds": [self.worker2.pk]}},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("not active", r.json()["error"])

    def test_a_started_run_carries_its_scope_and_progress_fields(self):
        with mock.patch("api.device_fetch.threading.Thread") as thread:
            r = self.client.post(
                f"{BASE}/fetch/start",
                {"deviceIds": [self.dev.pk], "range": {"preset": "today"}, "scope": {"employeeIds": [self.worker.pk]}},
                content_type="application/json",
                **self.h,
            )
        self.assertEqual(r.status_code, 202, r.content)
        thread.return_value.start.assert_called_once()
        body = r.json()
        self.assertEqual(body["scopeLabel"], "3001 Kavi Worker")
        self.assertEqual(body["scope"]["employeeIds"], [self.worker.pk])
        self.assertEqual(body["results"][0]["stage"], "connecting")
        self.assertEqual(body["results"][0]["via"], "direct")

    def test_the_employee_picker(self):
        r = self.client.get(f"{BASE}/fetch/employees", {"search": "worker", "employmentType": "production"}, **self.h)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([i["code"] for i in r.json()["items"]], ["3001", "3002"])


class CountingReadsTests(TestCase):
    def test_counts_blocks_into_records_and_leaves_the_bytes_alone(self):
        calls = []
        total = 4 + 40 * 100  # the size word + 100 records of 40 bytes
        buffer = total.to_bytes(4, "little")[:4]
        payload = (total - 4).to_bytes(4, "little") + b"x" * (total - 4)
        conn = SimpleNamespace(_ZK__read_chunk=lambda start, size: payload[start : start + size])
        with _counting_reads(conn, 100, lambda read, of: calls.append((read, of))):
            first = conn._ZK__read_chunk(0, 2004)
            second = conn._ZK__read_chunk(2004, 2000)
        self.assertEqual(first + second, payload)
        self.assertEqual(calls, [(50, 100), (100, 100)])
        self.assertNotIn("_ZK__read_chunk", {k for k in conn.__dict__ if k != "_ZK__read_chunk"})
        del buffer


class LinkTests(Base):
    def setUp(self):
        super().setUp()
        self.dev2 = BiometricDevice.objects.create(name="Gate B", host="127.0.0.2", connection_config={"password": 0})
        for uid, (code, device) in enumerate(
            (("2001", self.dev), ("3001", self.dev), ("3001", self.dev2), ("3002", self.dev2)), start=1
        ):
            BiometricDeviceUser.objects.create(device=device, uid=uid, user_id=code, name=code, read_at=timezone.now())

    def test_summary(self):
        r = self.client.get(f"{BASE}/links/summary", **self.h)
        self.assertEqual(r.status_code, 200, r.content)
        s = r.json()["summary"]
        self.assertEqual((s["employees"], s["onAnyDevice"], s["onMultipleDevices"]), (3, 3, 1))
        self.assertEqual(s["linkedToMultipleDevices"], 1)
        rows = {d["deviceName"]: d for d in r.json()["devices"]}
        self.assertEqual((rows["Gate A"]["staff"], rows["Gate A"]["production"]), (1, 1))
        self.assertEqual(rows["Gate B"]["alsoOnOtherDevices"], 1)
        # unlinking Gate B from Kavi: still on two devices, linked to one
        self.client.post(
            f"{BASE}/employees/{self.worker.pk}/links",
            {"unlinkedDeviceIds": [self.dev2.pk]},
            content_type="application/json",
            **self.h,
        )
        s = self.client.get(f"{BASE}/links/summary", **self.h).json()["summary"]
        self.assertEqual((s["onMultipleDevices"], s["linkedToMultipleDevices"], s["withUnlinkedDevices"]), (1, 0, 1))
        prod = self.client.get(f"{BASE}/links/summary", {"employmentType": "production"}, **self.h).json()
        self.assertEqual(prod["summary"]["employees"], 2)

    def test_every_change_is_in_the_history(self):
        url = f"{BASE}/employees/{self.worker.pk}/links"
        self.client.post(
            url, {"unlinkedDeviceIds": [self.dev.pk, self.dev2.pk]}, content_type="application/json", **self.h
        )
        self.client.post(url, {"unlinkedDeviceIds": [self.dev2.pk]}, content_type="application/json", **self.h)
        self.client.post(
            url, {"unlinkedDeviceIds": [self.dev2.pk]}, content_type="application/json", **self.h
        )  # no change
        rows = list(EmployeeDeviceLinkChange.objects.order_by("id").values_list("device_name", "action", "changed_by"))
        self.assertEqual(
            rows, [("Gate A", "unlink", "Tester"), ("Gate B", "unlink", "Tester"), ("Gate A", "link", "Tester")]
        )
        body = self.client.get(f"{BASE}/links/history", {"action": "link"}, **self.h).json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["rows"][0]["employee"]["code"], "3001")
        self.assertEqual(body["current"][0]["unlinkedDevices"], ["Gate B"])
        self.assertEqual(
            self.client.get(f"{BASE}/links/history", {"employmentType": "staff"}, **self.h).json()["total"], 0
        )

    def test_active_employees_missing_from_a_device(self):
        # Data Push -> Add Users lists the active employees a chosen device does not have yet
        Employee.objects.create(employee_code="2002", first_name="Nila", last_name="New", employment_type="staff")
        gone = Employee.objects.create(
            employee_code="2003", first_name="Old", last_name="Hand", employment_type="staff", status="inactive"
        )
        BiometricDeviceUser.objects.create(
            device=self.dev, uid=9, user_id=gone.employee_code, name="Old", read_at=timezone.now()
        )
        q = {"link": "active", "devices": str(self.dev2.pk), "deviceMode": "none"}
        body = self.client.get(f"{BASE}/people", q, **self.h).json()
        self.assertEqual(sorted(p["userId"] for p in body["items"]), ["2001", "2002"])
        staff = self.client.get(f"{BASE}/people", {**q, "employmentType": "production"}, **self.h).json()
        self.assertEqual(staff["items"], [])
        # missing from at least one of two devices: Kavi is on both, the rest are not
        both = {"link": "active", "devices": f"{self.dev.pk},{self.dev2.pk}", "deviceMode": "missing"}
        body = self.client.get(f"{BASE}/people", both, **self.h).json()
        self.assertEqual(sorted(p["userId"] for p in body["items"]), ["2001", "2002", "3002"])

    def test_a_branch_login_sees_its_own_branch_only(self):
        branch = Branch.objects.create(name="Unit 9", code="U9")
        Employee.objects.filter(pk=self.staff.pk).update(branch=branch)
        from .models import Role

        role = Role.objects.create(name="dcx role", permissions={"biometric_connectors": "edit", "attendance": "edit"})
        user = HRUser.objects.create(username="dcx_branch", password_hash="x", role=role, branch=branch)
        s = self.client.get(f"{BASE}/links/summary", **bearer(user)).json()["summary"]
        self.assertEqual(s["employees"], 1)


class UserHistoryTests(Base):
    def test_an_add_and_a_delete_on_a_direct_device_are_in_the_history(self):
        r = self.client.post(
            f"{BASE}/users/push",
            {"deviceIds": [self.dev.pk], "users": [{"userId": "4001", "name": "New Person"}], "context": "add"},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("4001", self.fake.user_ids())
        r = self.client.post(
            f"{BASE}/users/delete",
            {"deviceIds": [self.dev.pk], "userIds": ["4001"], "context": "delete"},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(r.status_code, 200, r.content)
        hist = self.client.get(f"{BASE}/users/history", **self.h).json()
        self.assertEqual(
            [(h["kind"], h["context"], h["status"]) for h in hist["rows"]],
            [
                ("delete", "delete", "done"),
                ("create", "add", "done"),
            ],
        )
        self.assertEqual(hist["rows"][1]["userNames"], {"4001": "New Person"})
        self.assertEqual(hist["rows"][0]["results"][0]["deleted"], 1)
        only = self.client.get(f"{BASE}/users/history", {"kind": "create"}, **self.h).json()
        self.assertEqual(only["total"], 1)

    def test_a_device_that_cannot_be_reached_is_a_failed_change(self):
        dead = BiometricDevice.objects.create(name="Off", host="127.0.0.1", port=1, connection_config={"password": 0})
        r = self.client.post(
            f"{BASE}/users/push",
            {"deviceIds": [dead.pk], "users": [{"userId": "4002", "name": "X"}], "context": "add"},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(BiometricUserChange.objects.get().status, "failed")

    def test_a_connector_change_is_recorded_when_it_finishes(self):
        # the finisher a Site Connector operation ends with is the same: it writes the row then
        from .device_directory import finish_apply

        request = SimpleNamespace(jwt_user={"name": "Remote HR"})
        devices = [self.dev]
        with mock.patch("api.device_directory.log_action"):
            finish_apply(
                request,
                "update",
                devices,
                {self.dev.pk: {"ok": True, "updated": ["2001"], "users": None}},
                [],
                context="make_same",
                user_names={"2001": "Sara Staff"},
            )
        row = BiometricUserChange.objects.get()
        self.assertEqual(
            (row.kind, row.context, row.requested_by, row.status), ("update", "make_same", "Remote HR", "done")
        )

    def test_the_history_by_reason(self):
        dev = SimpleNamespace(pk=1, name="D", connector_id=None)
        req = SimpleNamespace(jwt_user={})
        for kind, context in (("update", "edit"), ("create", "copy"), ("delete", "transfer"), ("create", "add")):
            record_user_change(req, kind, [dev], [{"ok": True}], [], context=context)
        body = self.client.get(f"{BASE}/users/history", {"context": "edit,copy,transfer,bogus"}, **self.h).json()
        self.assertEqual(sorted(r["context"] for r in body["rows"]), ["copy", "edit", "transfer"])
        moves = self.client.get(f"{BASE}/users/history", {"kind": "delete", "context": "transfer"}, **self.h).json()
        self.assertEqual(moves["total"], 1)

    def test_the_history_never_stops_a_change(self):
        with mock.patch("api.device_control_extras.BiometricUserChange.objects.create", side_effect=RuntimeError("db")):
            r = self.client.post(
                f"{BASE}/users/push",
                {"deviceIds": [self.dev.pk], "users": [{"userId": "4003", "name": "Y"}]},
                content_type="application/json",
                **self.h,
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("4003", self.fake.user_ids())

    def test_record_user_change_status(self):
        dev = SimpleNamespace(pk=1, name="D", connector_id=None)
        req = SimpleNamespace(jwt_user={})
        record_user_change(req, "create", [dev], [{"ok": True, "added": ["1"], "failed": [{"userId": "2"}]}], [])
        self.assertEqual(BiometricUserChange.objects.get().status, "partial")
