"""Device Control: the device client against a fake terminal, the snapshot of each device's users, who they are in the
HRMS, and adding, changing and deleting users on devices."""

import base64
import os
import struct
import threading
from datetime import date, datetime
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase, TestCase, override_settings

from fake_zk_device import FakeDevice, FakeServer, record28, record72

from . import device_client as dc
from . import device_directory as dd
from .jwt_utils import sign_token
from .models import (
    AuditLog,
    BiometricDevice,
    BiometricDeviceUser,
    Branch,
    Department,
    Employee,
    HRUser,
    Role,
)

BASE = "/api/attendance/device-control"
HOST = "127.0.0.1"


# ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────


class WithDevices(TestCase):
    """A test case that can stand up fake terminals and register them as BiometricDevice rows."""

    def add_device(self, name="A", fake=None, **fields):
        fake = fake or FakeDevice(serial=f"SN-{name}")
        server = FakeServer(fake).start()
        self.addCleanup(server.stop)
        row = BiometricDevice.objects.create(
            name=name,
            host=HOST,
            port=server.port,
            serial_number=fake.serial,
            connection_config={"password": 0},
            **fields,
        )
        fake.server = server
        return row, fake

    def employee(self, code, first="Test", last="Person", **fields):
        return Employee.objects.create(employee_code=code, first_name=first, last_name=last, **fields)

    def request(self, hr_user=None, scope=None):
        user = {"hrUserId": hr_user.pk if hr_user else None, "name": "Tester", "role": "hr"}
        return SimpleNamespace(hr_branch_id=scope, jwt_user=user, META={"REMOTE_ADDR": "10.0.0.1"})


def hr_headers(super_admin=True, permissions=None, username="dc_user", branch=None):
    role = Role.objects.create(name=f"role-{username}", permissions=permissions) if permissions is not None else None
    user = HRUser.objects.create(
        username=username, password_hash="x", is_super_admin=super_admin, role=role, branch=branch
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}, user


# ─── the records the devices hold ─────────────────────────────────────────────────────────────────────────────────────


class RecordTests(SimpleTestCase):
    def test_a_72_byte_record_is_read_into_its_fields(self):
        rec = record72(7, "1234", "Asha K", privilege=14, card=4048590, password="4321")
        u = dc.parse_record(rec)
        self.assertEqual(
            (u.uid, u.user_id, u.name, u.privilege, u.card, u.password, u.group),
            (7, "1234", "Asha K", 14, 4048590, "4321", ""),
        )
        self.assertTrue(u.has_password)
        self.assertEqual(u.raw, rec)

    def test_a_28_byte_record_is_read_into_its_fields(self):
        u = dc.parse_record(record28(3, "42", "Ravi", privilege=0, card=11, password="12"))
        self.assertEqual((u.uid, u.user_id, u.name, u.card, u.password), (3, "42", "Ravi", 11, "12"))

    def test_a_record_of_an_unknown_size_is_refused_with_a_reason(self):
        with self.assertRaises(dc.DeviceUnavailable) as caught:
            dc.parse_record(bytes(30))
        self.assertEqual(caught.exception.code, "protocol")

    def test_sending_a_record_back_with_nothing_changed_changes_nothing(self):
        for rec, size in ((record72(7, "1234", "Asha", 14, 99, "55"), 72), (record28(3, "42", "Ravi", 0, 5), 28)):
            u = dc.parse_record(rec)
            self.assertEqual(dc.build_record(size, uid=u.uid, user_id=u.user_id, base=rec), rec)

    def test_an_edit_touches_only_the_bytes_of_the_field_that_changed(self):
        rec = bytearray(record72(7, "1234", "Asha", 14, 99))
        rec[41] = 7  # a byte this portal knows nothing about must survive the edit
        out = dc.build_record(72, uid=7, user_id="1234", name="Asha Kumar", base=bytes(rec))
        changed = [i for i in range(72) if out[i] != rec[i]]
        self.assertTrue(changed and min(changed) >= 11 and max(changed) < 35, changed)
        self.assertEqual(out[41], 7)
        self.assertEqual(dc.parse_record(out).privilege, 14)

    def test_a_new_user_starts_the_way_a_terminal_writes_one(self):
        out = dc.build_record(72, uid=5, user_id="77", name="New", privilege=0, password="", card=0)
        self.assertEqual(out[39], 1, "the group byte is 1 on every real terminal; pyzk's set_user writes 0")
        self.assertEqual(dc.parse_record(out).user_id, "77")
        old = dc.build_record(28, uid=5, user_id="77", name="New")
        self.assertEqual(dc.parse_record(old).user_id, "77")

    def test_the_limits_of_each_field_are_enforced_in_bytes(self):
        too_long = "A" * 25
        for kwargs in (
            {"name": too_long},
            {"name": "é" * 13},  # 26 bytes in UTF-8
            {"password": "123456789"},
            {"card": 2**32},
            {"card": -1},
            {"group": "12345678"},
        ):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                dc.build_record(72, uid=1, user_id="1", **kwargs)
        with self.assertRaises(ValueError):
            dc.build_record(28, uid=1, user_id="1", name="123456789")
        with self.assertRaises(ValueError):
            dc.build_record(28, uid=1, user_id="ABC", name="x")
        with self.assertRaises(ValueError):
            dc.build_record(72, uid=1, user_id="1" * 25, name="x")

    def test_fit_bytes_never_cuts_a_character_in_half(self):
        self.assertEqual(dd.fit_bytes("abcdef", 4), "abcd")
        self.assertEqual(dd.fit_bytes("ééé", 5), "éé")
        self.assertEqual(dd.fit_bytes("ab", 24), "ab")

    def test_the_terminals_clock_round_trips_and_a_date_that_cannot_exist_is_refused(self):
        moment = datetime(2026, 10, 6, 13, 40, 25)
        self.assertEqual(dc.decode_time(dc.encode_time(moment)), moment)
        impossible = struct.pack("<I", (((26 * 12 + 3) * 31) + 30) * 86400)  # 31 April
        with self.assertRaises(ValueError):
            dc.decode_time(impossible)

    def test_the_library_call_this_module_relies_on_is_still_there(self):
        from zk import ZK

        self.assertTrue(hasattr(ZK, "_ZK__send_command"), "pyzk changed: device_client._send needs updating")


# ─── a session with a device ────────────────────────────────────────────────────────────────────────────────────────


class ClientTests(WithDevices):
    def fake(self, **kw):
        fake = FakeDevice(**kw)
        server = FakeServer(fake).start()
        self.addCleanup(server.stop)
        return fake, server.port

    def test_a_device_that_answers_is_connected_and_says_what_it_is(self):
        fake, port = self.fake()
        fake.add_user(1, "1001", "Asha")
        fake.faces = 1
        result = dc.timed_probe(HOST, port, 0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["capacity"]["users"], 1)
        self.assertEqual(result["capacity"]["usersCap"], 3000)
        self.assertEqual(result["capacity"]["faces"], 1)
        self.assertEqual(result["capacity"]["serial"], fake.serial)
        self.assertEqual(result["capacity"]["pinWidth"], 9)
        self.assertGreater(result["latencyMs"], 0)
        self.assertTrue(result["deviceTime"])

    def test_a_closed_port_a_wrong_comm_key_and_a_silent_device_are_told_apart(self):
        self.assertEqual(dc.timed_probe(HOST, 1, 0)["code"], "refused")
        fake, port = self.fake(password=123)
        self.assertEqual(dc.timed_probe(HOST, port, 0)["code"], "auth")
        self.assertTrue(dc.timed_probe(HOST, port, 123)["ok"])
        silent, silent_port = self.fake()
        silent.mute = True
        with mock.patch.object(dc, "ZK_IO_TIMEOUT_SECONDS", 1):
            result = dc.timed_probe(HOST, silent_port, 0)
        self.assertEqual(result["code"], "timeout")
        self.assertFalse(result["ok"])

    def test_the_cloud_server_does_not_even_try_a_private_address(self):
        with mock.patch.dict(os.environ, {"RAILWAY_ENVIRONMENT": "production"}):
            with mock.patch("socket.create_connection") as dial:
                result = dc.timed_probe("192.168.0.59", 4370, 0)
            self.assertEqual(result["code"], "cloud")
            self.assertIn("cloud", result["error"])
            dial.assert_not_called()
            # a public address (a forwarded port) is still tried
            with mock.patch("socket.create_connection", side_effect=ConnectionRefusedError()) as dial:
                self.assertEqual(dc.timed_probe("8.8.8.8", 4370, 0)["code"], "refused")
            dial.assert_called_once()

    def test_a_device_in_use_is_reported_busy_not_hung_on(self):
        fake, port = self.fake()
        held = dc._lock_for(HOST, port)
        held.acquire()
        try:
            with mock.patch.object(dc, "READ_LOCK_WAIT_SECONDS", 0.2):
                result = dc.timed_probe(HOST, port, 0)
        finally:
            held.release()
        self.assertEqual(result["code"], "busy")
        self.assertTrue(result["ok"], "a busy device is still a connected one")

    def test_users_are_read_in_either_record_layout(self):
        for size in (72, 28):
            fake, port = self.fake(record_size=size)
            fake.add_user(1, "1001", "Asha", privilege=14)
            fake.add_user(2, "1002", "Ravi", card=7)
            with dc.open_session(HOST, port, 0) as s:
                users = s.read_users()
                self.assertEqual(s.record_size, size)
            self.assertEqual(
                [(u.uid, u.user_id, u.name, u.privilege, u.card) for u in users],
                [(1, "1001", "Asha", 14, 0), (2, "1002", "Ravi", 0, 7)],
            )

    def test_the_attendance_log_is_read_with_a_date_range_and_bad_dates_are_counted(self):
        fake, port = self.fake()
        fake.add_user(1, "1001", "Asha")
        fake.add_punch("1001", datetime(2026, 10, 4, 9, 0, 0), 0)
        fake.add_punch("1001", datetime(2026, 10, 5, 9, 0, 0), 0)
        fake.add_punch("1001", datetime(2026, 10, 5, 18, 0, 0), 1)
        fake.add_punch("1001", datetime(2026, 10, 6, 9, 0, 0), 0)
        fake.invalid_punch_dates = 2
        with dc.open_session(HOST, port, 0) as s:
            everything, bad, valid = s.read_attendance()
            window, _bad, _valid = s.read_attendance(date(2026, 10, 5), date(2026, 10, 5))
        self.assertEqual((len(everything), bad, valid), (4, 2, 4))
        self.assertEqual([(p.at.hour, p.status) for p in window], [(9, 0), (18, 1)])

    def test_a_write_holds_the_device_disabled_and_always_enables_it_again(self):
        fake, port = self.fake()
        with dc.open_session(HOST, port, 0, write=True):
            self.assertFalse(fake.enabled)
        self.assertTrue(fake.enabled)
        with self.assertRaises(RuntimeError):
            with dc.open_session(HOST, port, 0, write=True):
                raise RuntimeError("a bug in the caller")
        self.assertTrue(fake.enabled, "the device must not be left locked when the caller fails")
        self.assertEqual(fake.commands[:2], [1000, 1003])

    def test_a_bug_in_the_caller_is_not_reported_as_a_device_problem(self):
        fake, port = self.fake()
        with self.assertRaises(ValueError):
            with dc.open_session(HOST, port, 0):
                raise ValueError("a bad value")

    def test_a_device_that_refuses_a_user_write_says_so(self):
        fake, port = self.fake()
        fake.refuse_writes = True
        with self.assertRaises(dc.DeviceUnavailable) as caught:
            with dc.open_session(HOST, port, 0, write=True) as s:
                s.write_record(dc.build_record(72, uid=1, user_id="1", name="x"))
        self.assertIn("refused", caught.exception.message)
        self.assertTrue(fake.enabled)


# ─── the snapshot of each device's users ───────────────────────────────────────────────────────────────────────────────


class SnapshotTests(WithDevices):
    def test_reading_a_device_stores_its_users_and_what_it_reported_about_itself(self):
        row, fake = self.add_device("A")
        fake.add_user(1, "1001", "Asha K", privilege=14, card=99, password="123")
        fake.add_user(2, "1002", "Ravi")
        out = dd.refresh_users()
        self.assertEqual([(r["deviceName"], r["ok"], r["count"]) for r in out], [("A", True, 2)])
        rows = {r.user_id: r for r in BiometricDeviceUser.objects.filter(device=row)}
        self.assertEqual((rows["1001"].name, rows["1001"].privilege, rows["1001"].card), ("Asha K", 14, 99))
        self.assertTrue(rows["1001"].has_password)
        self.assertFalse(rows["1002"].has_password)
        self.assertFalse(hasattr(rows["1001"], "password"), "the device password is never stored")
        row.refresh_from_db()
        self.assertIsNotNone(row.users_read_at)
        self.assertEqual(row.users_read_error, "")
        self.assertEqual(
            (row.capacity["users"], row.capacity["usersCap"], row.capacity["serial"]), (2, 3000, fake.serial)
        )
        self.assertIsNotNone(row.last_reachable_at)

    def test_a_second_read_follows_the_device_adds_changes_and_removals(self):
        row, fake = self.add_device("A")
        fake.add_user(1, "1001", "Asha")
        fake.add_user(2, "1002", "Ravi")
        dd.refresh_users()
        fake.users.pop(2)
        fake.add_user(1, "1001", "Asha Kumar", privilege=14)
        fake.add_user(3, "1003", "Meena")
        dd.refresh_users()
        got = {r.user_id: (r.name, r.privilege) for r in BiometricDeviceUser.objects.filter(device=row)}
        self.assertEqual(got, {"1001": ("Asha Kumar", 14), "1003": ("Meena", 0)})

    def test_a_device_that_cannot_be_read_keeps_its_last_snapshot_and_says_why(self):
        row, fake = self.add_device("A")
        fake.add_user(1, "1001", "Asha")
        dd.refresh_users()
        fake.server.stop()
        out = dd.refresh_users()
        self.assertFalse(out[0]["ok"])
        self.assertEqual(out[0]["code"], "refused")
        self.assertEqual(BiometricDeviceUser.objects.filter(device=row).count(), 1)
        row.refresh_from_db()
        self.assertIn("refused", row.users_read_error)

    def test_one_device_down_does_not_stop_the_others_and_a_bad_comm_key_is_a_configuration_error(self):
        a, fake_a = self.add_device("A")
        fake_a.add_user(1, "1001", "Asha")
        b, fake_b = self.add_device("B")
        fake_b.server.stop()
        c = BiometricDevice.objects.create(name="C", host=HOST, port=1, connection_config={"password": "abc"})
        out = {r["deviceName"]: r for r in dd.refresh_users()}
        self.assertTrue(out["A"]["ok"])
        self.assertEqual(out["B"]["code"], "refused")
        self.assertEqual(out["C"]["code"], "config")
        self.assertEqual(c.pk and BiometricDeviceUser.objects.filter(device=c).count(), 0)

    def test_only_enabled_devices_are_read_unless_one_is_named(self):
        a, fake_a = self.add_device("A")
        off, fake_off = self.add_device("Off", is_active=False)
        fake_a.add_user(1, "1", "x")
        fake_off.add_user(1, "2", "y")
        self.assertEqual([r["deviceName"] for r in dd.refresh_users()], ["A"])
        self.assertEqual([r["deviceName"] for r in dd.refresh_users([off.pk])], ["Off"])


# ─── who is who ────────────────────────────────────────────────────────────────────────────────────────────────────────


class PeopleTests(WithDevices):
    def setUp(self):
        self.branch = Branch.objects.create(name="Test Head Office", code="DC1")
        self.other_branch = Branch.objects.create(name="Test Unit 2", code="DC2")
        self.dept = Department.objects.create(name="Stitching", branch=self.branch)
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        self.fa.add_user(1, "1001", "Asha K", privilege=14, card=555)
        self.fa.add_user(2, "1002", "Ravi S")
        self.fa.add_user(3, "9001", "Stranger")
        self.fb.add_user(1, "1001", "ASHA K")
        self.fb.add_user(2, "1003", "Meena")
        self.asha = self.employee(
            "1001", "Asha", "Kumar", branch=self.branch, department=self.dept, employment_type="staff"
        )
        self.ravi = self.employee("1002", "Ravi", "S", branch=self.branch, employment_type="production")
        self.meena = self.employee("1003", "Meena", "P", status="inactive", branch=self.branch)
        self.kumar = self.employee("1004", "Kumar", "V", branch=self.branch, department=self.dept)
        self.gone = self.employee("1005", "Gone", "Away", status="inactive")
        dd.refresh_users()

    def people(self, **filters):
        return dd.list_people(self.request(), dd.PeopleFilter(**filters), page_size=200)

    def codes(self, **filters):
        return {i["userId"] for i in self.people(**filters)["items"]}

    def test_every_kind_of_person_is_told_apart(self):
        by_code = {i["userId"]: i for i in self.people()["items"]}
        self.assertEqual(
            {c: i["link"] for c, i in by_code.items()},
            {
                "1001": "linked",
                "1002": "linked",
                "1003": "inactive_on_device",
                "1004": "hrms_only",
                "9001": "device_only",
            },
        )
        self.assertNotIn("1005", by_code, "an Inactive employee on no device is not worth listing")
        self.assertEqual(by_code["1001"]["employee"]["name"], "Asha Kumar")
        self.assertEqual(by_code["1001"]["employee"]["department"], "Stitching")
        self.assertIsNone(by_code["9001"]["employee"])
        self.assertEqual(by_code["9001"]["name"], "Stranger")

    def test_the_counts_for_the_filter_buttons(self):
        f = self.people()["facets"]
        self.assertEqual(
            {k: v for k, v in f.items() if k != "perDevice"},
            {
                "total": 5,
                "onDevices": 4,
                "linked": 2,
                "deviceOnly": 1,
                "hrmsOnly": 1,
                "inactiveOnDevice": 1,
                "restricted": 0,
                "multipleDevices": 1,
                "singleDevice": 3,
                "admins": 1,
                "differs": 1,
            },
        )
        self.assertEqual(f["perDevice"], {str(self.a.pk): 3, str(self.b.pk): 2})

    def test_which_device_a_person_is_on(self):
        self.assertEqual(self.codes(device_ids=(self.a.pk,)), {"1001", "1002", "9001"})
        self.assertEqual(self.codes(device_ids=(self.b.pk,)), {"1001", "1003"})
        self.assertEqual(self.codes(device_ids=(self.a.pk, self.b.pk), device_mode="all"), {"1001"})
        self.assertEqual(
            self.codes(device_ids=(self.a.pk, self.b.pk), device_mode="any"), {"1001", "1002", "1003", "9001"}
        )

    def test_who_is_missing_from_a_device(self):
        self.assertEqual(self.codes(device_ids=(self.b.pk,), device_mode="none"), {"1002", "9001", "1004"})
        self.assertEqual(self.codes(device_ids=(self.a.pk,), device_mode="none", link="linked"), set())
        self.assertEqual(self.codes(device_ids=(self.a.pk,), device_mode="none", link="hrms_only"), {"1004"})

    def test_people_on_several_devices_or_just_one(self):
        self.assertEqual(self.codes(count="multiple"), {"1001"})
        self.assertEqual(self.codes(count="single"), {"1002", "1003", "9001"})

    def test_in_the_device_but_not_in_the_hrms_and_the_other_way_round(self):
        self.assertEqual(self.codes(link="device_only"), {"9001"})
        self.assertEqual(self.codes(link="hrms_only"), {"1004"})
        self.assertEqual(self.codes(link="inactive_on_device"), {"1003"})
        self.assertEqual(self.codes(link="linked"), {"1001", "1002"})

    def test_details_that_differ_between_devices_are_flagged(self):
        item = next(i for i in self.people()["items"] if i["userId"] == "1001")
        self.assertEqual(
            item["differs"], ["role"], "same name apart from case, but admin on one device and user on the other"
        )
        self.assertEqual(self.codes(differs=True), {"1001"})

    def test_role_filters(self):
        self.assertEqual(self.codes(role="admin"), {"1001"})
        self.assertEqual(self.codes(role="user"), {"1002", "1003", "9001"})

    def test_search_finds_a_person_by_name_code_card_or_department(self):
        self.assertEqual(self.codes(search="asha"), {"1001"})
        self.assertEqual(self.codes(search="900"), {"9001"})
        self.assertEqual(self.codes(search="555"), {"1001"})
        self.assertEqual(self.codes(search="stitching"), {"1001", "1004"})
        self.assertEqual(self.codes(search="ravi s"), {"1002"})
        self.assertEqual(self.codes(search="nobody at all"), set())

    def test_hrms_filters_leave_out_people_who_are_not_employees(self):
        self.assertEqual(self.codes(employment_type="production"), {"1002"})
        self.assertEqual(self.codes(department_id=self.dept.pk), {"1001", "1004"})
        self.assertEqual(self.codes(branch_id=self.other_branch.pk), set())

    def test_sorting_and_paging(self):
        names = [i["userId"] for i in dd.list_people(self.request(), dd.PeopleFilter(), sort="code")["items"]]
        self.assertEqual(names, ["1001", "1002", "1003", "1004", "9001"])
        desc = [i["userId"] for i in dd.list_people(self.request(), dd.PeopleFilter(), sort="code", desc=True)["items"]]
        self.assertEqual(desc, list(reversed(names)))
        most_first = dd.list_people(self.request(), dd.PeopleFilter(), sort="devices", desc=True)["items"]
        self.assertEqual(most_first[0]["userId"], "1001", "descending: the person on the most devices first")
        fewest_first = dd.list_people(self.request(), dd.PeopleFilter(), sort="devices")["items"]
        self.assertEqual(fewest_first[0]["deviceCount"], 0, "ascending: the people on no device first")
        self.assertEqual(fewest_first[-1]["userId"], "1001")
        page = dd.list_people(self.request(), dd.PeopleFilter(), sort="code", page=2, page_size=2)
        self.assertEqual((page["total"], page["pages"], page["page"]), (5, 3, 2))
        self.assertEqual([i["userId"] for i in page["items"]], ["1003", "1004"])
        clamped = dd.list_people(self.request(), dd.PeopleFilter(), page=99, page_size=2)
        self.assertEqual(clamped["page"], 3)

    def test_ids_sort_as_numbers_not_as_text(self):
        self.fa.add_user(10, "10", "Ten")
        self.fa.add_user(11, "9", "Nine")
        dd.refresh_users()
        order = [i["userId"] for i in dd.list_people(self.request(), dd.PeopleFilter(), sort="code")["items"]][:3]
        self.assertEqual(order, ["9", "10", "1001"])

    def test_an_employee_of_another_branch_is_not_shown_to_a_branch_limited_caller(self):
        self.ravi.branch = self.other_branch
        self.ravi.save()
        scoped = self.request(scope=self.branch.pk)
        items = {i["userId"]: i for i in dd.list_people(scoped, dd.PeopleFilter(), page_size=200)["items"]}
        self.assertEqual(items["1002"]["link"], "restricted")
        self.assertIsNone(items["1002"]["employee"])
        self.assertEqual(items["1002"]["name"], "Another branch", "not even the device's name for them is shown")
        self.assertEqual([x["name"] for x in items["1002"]["presence"]], [""])
        by_device_name = dd.list_people(scoped, dd.PeopleFilter(search="ravi"), page_size=200)["items"]
        self.assertNotIn("1002", {i["userId"] for i in by_device_name}, "and it cannot be found by that name")
        self.assertEqual(items["1001"]["link"], "linked")
        self.assertEqual(dd.list_people(scoped, dd.PeopleFilter())["facets"]["restricted"], 1)
        # the same list for an unrestricted caller is unchanged
        self.assertEqual(self.people()["total"], 5)


# ─── adding and changing users on devices ─────────────────────────────────────────────────────────────────────────────


class ChangeTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        self.fa.add_user(1, "1001", "Asha K", privilege=14, card=555)
        self.fa.add_user(2, "1002", "Ravi S")
        dd.refresh_users()
        self.req = self.request()

    def push(self, device_ids, users, mode="create"):
        return dd.apply_users(self.req, device_ids, users, mode)

    def test_a_user_is_added_to_the_devices_chosen_and_read_back(self):
        out = self.push([self.a.pk, self.b.pk], [{"userId": "2001", "name": "New Person", "card": 777}])
        self.assertEqual(out["summary"], {"added": 2, "updated": 0, "failed": 0})
        for fake in (self.fa, self.fb):
            user = fake.user("2001")
            self.assertEqual((user["name"], user["card"], user["privilege"], user["flag"]), ("New Person", 777, 0, 1))
        self.assertEqual(BiometricDeviceUser.objects.filter(user_id="2001").count(), 2, "the snapshot follows")
        self.assertTrue(self.fa.enabled and self.fb.enabled)
        self.assertEqual(AuditLog.objects.filter(action="create", module="attendance").count(), 1)

    def test_a_new_user_takes_the_lowest_free_slot_on_the_device(self):
        self.fa.users.pop(1)
        self.push([self.a.pk], [{"userId": "2001", "name": "N"}])
        self.assertEqual(self.fa.user("2001")["uid"], 1)

    def test_an_older_device_never_gives_a_freed_slot_to_someone_new(self):
        """Its punch log names people by slot number, so a reused slot would hand the old person's punches to the new one."""
        old_device, fake_old = self.add_device("Old", FakeDevice(record_size=28))
        fake_old.add_user(1, "11", "one")
        fake_old.add_user(3, "33", "three")
        self.push([old_device.pk], [{"userId": "44", "name": "four"}])
        self.assertEqual(fake_old.user("44")["uid"], 4, "after the highest slot in use, not the free slot 2")
        # the newer terminals fill the lowest free slot, as the terminal itself does
        self.fa.users.pop(1)
        self.push([self.a.pk], [{"userId": "2001", "name": "N"}])
        self.assertEqual(self.fa.user("2001")["uid"], 1)

    def test_a_user_the_device_already_has_is_left_alone(self):
        out = self.push([self.a.pk], [{"userId": "1002", "name": "Someone Else"}])
        self.assertEqual(out["results"][0]["skipped"][0]["userId"], "1002")
        self.assertEqual(self.fa.user("1002")["name"], "Ravi S")
        self.assertEqual(out["summary"]["added"], 0)

    def test_the_name_comes_from_the_employee_when_none_is_given_and_is_cut_to_what_fits(self):
        emp = self.employee("2002", "Venkataramanan", "Subramaniapillai")
        self.push([self.a.pk], [{"userId": "2002", "employeeId": emp.pk}])
        self.assertEqual(self.fa.user("2002")["name"], "Venkataramanan Subramani")

    def test_bad_input_is_refused_per_user_without_stopping_the_good_ones(self):
        out = self.push(
            [self.a.pk],
            [
                {"userId": "bad id!", "name": "x"},
                {"userId": "2003"},
                {"userId": "2004", "name": "x", "privilege": 5},
                {"userId": "2005", "name": "x", "password": "12ab"},
                {"userId": "2006", "name": "x", "card": "abc"},
                {"userId": "2007", "name": "Good"},
                {"userId": "2007", "name": "Good again"},
            ],
        )
        refused = {r["userId"]: r["error"] for r in out["rejected"]}
        self.assertEqual(set(refused), {"bad id!", "2003", "2004", "2005", "2006", "2007"})
        self.assertEqual(refused["2003"], "A name is needed.")
        self.assertEqual(refused["2007"], "Listed twice.")
        self.assertEqual(self.fa.user("2007")["name"], "Good")

    def test_nothing_chosen_is_an_error_not_a_silent_success(self):
        with self.assertRaises(ValueError):
            self.push([self.a.pk], [])
        with self.assertRaises(ValueError):
            self.push([], [{"userId": "1", "name": "x"}])
        with self.assertRaises(ValueError):
            self.push([self.a.pk], [{"userId": str(i), "name": "x"} for i in range(dd.MAX_USERS_PER_CHANGE + 1)])
        with self.assertRaises(ValueError):
            dd.apply_users(self.req, [self.a.pk], [{"userId": "1", "name": "x"}], "other")

    def test_a_full_device_and_a_too_long_id_are_reported_not_forced(self):
        small, fake_small = self.add_device("Small", FakeDevice(users_cap=1, pin_width=4))
        fake_small.add_user(1, "1", "one")
        out = self.push([small.pk], [{"userId": "55555", "name": "Long"}, {"userId": "2", "name": "Two"}])
        errors = {f["userId"]: f["error"] for f in out["results"][0]["failed"]}
        self.assertIn("at most 4 characters", errors["55555"])
        self.assertIn("full", errors["2"])
        self.assertEqual(fake_small.user_ids(), ["1"])

    def test_one_device_down_or_refusing_does_not_undo_the_others(self):
        down, fake_down = self.add_device("Down")
        fake_down.server.stop()
        refusing, fake_refusing = self.add_device("Refusing")
        fake_refusing.refuse_writes = True
        out = self.push([self.a.pk, down.pk, refusing.pk], [{"userId": "2001", "name": "N"}])
        by_name = {r["deviceName"]: r for r in out["results"]}
        self.assertEqual(by_name["A"]["added"], ["2001"])
        self.assertFalse(by_name["Down"]["ok"])
        self.assertEqual(by_name["Down"]["code"], "refused")
        self.assertEqual(by_name["Refusing"]["failed"][0]["userId"], "2001")
        self.assertIsNone(fake_refusing.user("2001"))
        self.assertTrue(fake_refusing.enabled, "a refused write must not leave the device locked")
        self.assertEqual(out["summary"]["added"], 1)
        self.assertEqual(out["summary"]["failed"], 2)

    def test_changing_a_user_changes_only_what_was_asked_and_keeps_the_rest_of_the_record(self):
        before = self.fa.user("1001")["raw"]
        out = self.push([self.a.pk], [{"userId": "1001", "name": "Asha Kumar"}], mode="update")
        self.assertEqual(out["results"][0]["updated"], ["1001"])
        after = self.fa.user("1001")
        self.assertEqual((after["name"], after["privilege"], after["card"], after["flag"]), ("Asha Kumar", 14, 555, 1))
        changed = [i for i in range(72) if after["raw"][i] != before[i]]
        self.assertTrue(min(changed) >= 11 and max(changed) < 35, "only the name bytes moved")

    def test_role_card_and_password_can_be_changed_and_cleared(self):
        self.push([self.a.pk], [{"userId": "1002", "privilege": 14, "card": 9, "password": "4455"}], mode="update")
        user = self.fa.user("1002")
        self.assertEqual((user["privilege"], user["card"], user["password"]), (14, 9, "4455"))
        self.assertTrue(BiometricDeviceUser.objects.get(device=self.a, user_id="1002").has_password)
        self.push([self.a.pk], [{"userId": "1002", "privilege": 0, "card": "", "password": ""}], mode="update")
        user = self.fa.user("1002")
        self.assertEqual((user["privilege"], user["card"], user["password"]), (0, 0, ""))
        self.assertFalse(BiometricDeviceUser.objects.get(device=self.a, user_id="1002").has_password)

    def test_changing_a_user_the_device_does_not_have_is_skipped_and_the_id_cannot_be_changed(self):
        out = self.push([self.b.pk], [{"userId": "1001", "name": "X"}], mode="update")
        self.assertEqual(out["results"][0]["skipped"][0]["reason"], "Not on this device.")
        self.assertEqual(self.fb.user_ids(), [])

    def test_a_change_is_audited(self):
        self.push([self.a.pk], [{"userId": "1001", "name": "Asha Kumar"}], mode="update")
        entry = AuditLog.objects.get(action="update", module="attendance")
        self.assertIn("1001", entry.record_description)
        self.assertEqual(entry.user_name, "Tester")

    def test_a_branch_limited_caller_cannot_change_a_person_of_another_branch(self):
        mine = Branch.objects.create(name="Mine", code="M")
        theirs = Branch.objects.create(name="Theirs", code="T")
        self.employee("1002", "Ravi", "S", branch=theirs)
        out = dd.apply_users(self.request(scope=mine.pk), [self.a.pk], [{"userId": "1002", "name": "Hacked"}], "update")
        self.assertEqual(out["rejected"][0]["error"], "This person belongs to another branch.")
        self.assertEqual(self.fa.user("1002")["name"], "Ravi S")


# ─── deleting ───────────────────────────────────────────────────────────────────────────────────────────────────────────


class DeleteTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        for fake in (self.fa, self.fb):
            fake.add_user(1, "1001", "Asha K")
        self.fa.add_user(2, "1002", "Ravi S")
        self.fa.add_user(3, "9001", "Stranger")
        self.asha = self.employee("1001", "Asha", "Kumar")
        self.ravi = self.employee("1002", "Ravi", "S")
        dd.refresh_users()
        self.admin_headers, self.admin = hr_headers(username="admin1")
        self.req = self.request(self.admin)

    def test_deleting_removes_the_user_from_every_device_they_are_on_and_the_employee_becomes_inactive_not_deleted(
        self,
    ):
        out = dd.delete_users(self.req, ["1001"], None, mark_inactive=True)
        self.assertEqual(out["summary"], {"deleted": 2, "failed": 0, "madeInactive": 1})
        self.assertIsNone(self.fa.user("1001"))
        self.assertIsNone(self.fb.user("1001"))
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.status, "inactive")
        self.assertTrue(Employee.objects.filter(pk=self.asha.pk).exists(), "the HRMS record is kept")
        self.assertFalse(BiometricDeviceUser.objects.filter(user_id="1001").exists(), "the snapshot follows")
        self.assertEqual(out["inactive"][0]["changed"], True)
        self.assertEqual(AuditLog.objects.filter(action="delete", module="attendance").count(), 1)
        self.assertEqual(
            AuditLog.objects.filter(action="update", module="employees", record_id=self.asha.pk).count(), 1
        )
        self.assertTrue(self.fa.enabled and self.fb.enabled)

    def test_the_employee_is_only_made_inactive_when_asked(self):
        dd.delete_users(self.req, ["1002"], None, mark_inactive=False)
        self.assertIsNone(self.fa.user("1002"))
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "active")

    def test_deleting_from_one_device_leaves_the_user_on_the_others(self):
        dd.delete_users(self.req, ["1001"], [self.a.pk], mark_inactive=False)
        self.assertIsNone(self.fa.user("1001"))
        self.assertIsNotNone(self.fb.user("1001"))

    def test_a_person_who_is_not_an_employee_is_just_removed_from_the_device(self):
        out = dd.delete_users(self.req, ["9001"], None, mark_inactive=True)
        self.assertIsNone(self.fa.user("9001"))
        self.assertEqual(
            out["inactive"],
            [
                {
                    "userId": "9001",
                    "employeeId": None,
                    "name": "",
                    "changed": False,
                    "reason": "Not an employee in the HRMS.",
                }
            ],
        )

    def test_an_employee_stays_active_when_no_device_really_removed_them(self):
        self.fa.refuse_writes = True
        self.fb.refuse_writes = True
        out = dd.delete_users(self.req, ["1001"], None, mark_inactive=True)
        self.assertEqual(out["summary"]["deleted"], 0)
        self.assertEqual(out["inactive"], [])
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.status, "active")
        self.assertFalse(AuditLog.objects.filter(module="employees").exists())

    def test_removed_from_one_device_and_failed_on_another_still_makes_them_inactive(self):
        self.fb.refuse_writes = True
        out = dd.delete_users(self.req, ["1001"], None, mark_inactive=True)
        self.assertEqual(out["summary"], {"deleted": 1, "failed": 1, "madeInactive": 1})
        self.assertIsNotNone(self.fb.user("1001"), "still on B: the page lists them as Inactive but on a device")
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.status, "inactive")

    def test_a_role_that_cannot_edit_employees_deletes_from_the_devices_but_leaves_the_employee(self):
        _h, editor = hr_headers(
            super_admin=False, permissions={"attendance": "edit", "employees": "view"}, username="ed"
        )
        out = dd.delete_users(self.request(editor), ["1002"], None, mark_inactive=True)
        self.assertIsNone(self.fa.user("1002"))
        self.assertIn("cannot edit employees", out["inactive"][0]["reason"])
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "active")

    def test_an_employee_already_inactive_is_reported_not_changed_again(self):
        Employee.objects.filter(pk=self.ravi.pk).update(status="inactive")
        out = dd.delete_users(self.req, ["1002"], None, mark_inactive=True)
        self.assertEqual(out["inactive"][0]["reason"], "Already Inactive.")
        self.assertFalse(AuditLog.objects.filter(module="employees").exists())

    def test_a_branch_limited_caller_cannot_delete_a_person_of_another_branch(self):
        mine = Branch.objects.create(name="Mine", code="M")
        theirs = Branch.objects.create(name="Theirs", code="T")
        Employee.objects.filter(pk=self.ravi.pk).update(branch=theirs)
        Employee.objects.filter(pk=self.asha.pk).update(branch=mine)
        out = dd.delete_users(self.request(self.admin, scope=mine.pk), ["1002", "1001"], None, mark_inactive=True)
        self.assertEqual([r["userId"] for r in out["rejected"]], ["1002"])
        self.assertIsNotNone(self.fa.user("1002"))
        self.assertIsNone(self.fa.user("1001"))
        only_theirs = dd.delete_users(self.request(self.admin, scope=mine.pk), ["1002"], None, mark_inactive=True)
        self.assertEqual(only_theirs["summary"], {"deleted": 0, "failed": 1, "madeInactive": 0})

    def test_nothing_chosen_or_too_many_is_an_error(self):
        with self.assertRaises(ValueError):
            dd.delete_users(self.req, [], None)
        with self.assertRaises(ValueError):
            dd.delete_users(self.req, [str(i) for i in range(dd.MAX_USERS_PER_CHANGE + 1)], None)

    def test_a_user_the_snapshot_does_not_know_is_not_chased_across_every_device(self):
        out = dd.delete_users(self.req, ["7777"], None, mark_inactive=True)
        self.assertEqual(out["results"], [])
        self.assertEqual(out["summary"]["deleted"], 0)


# ─── the photo ─────────────────────────────────────────────────────────────────────────────────────────────────────────

JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0" + b"0" * 200).decode()


class PhotoTests(WithDevices):
    def setUp(self):
        self.emp = self.employee("1001", "Asha", "Kumar")
        _h, self.admin = hr_headers(username="photo_admin")
        self.req = self.request(self.admin)

    def test_a_photo_becomes_the_employees_profile_photo_and_is_audited(self):
        out = dd.save_employee_photo(self.req, self.emp.pk, JPEG)
        self.assertEqual(out["photoUrl"], f"/api/employees/{self.emp.pk}/photo")
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.photo_url, JPEG)
        self.assertEqual(AuditLog.objects.filter(action="update", module="employees", record_id=self.emp.pk).count(), 1)

    def test_only_a_real_small_image_is_accepted(self):
        with self.assertRaises(ValueError):
            dd.save_employee_photo(self.req, self.emp.pk, "data:text/html;base64,PGI+")
        with self.assertRaises(ValueError):
            dd.save_employee_photo(self.req, self.emp.pk, "https://example.com/a.jpg")
        with self.assertRaises(ValueError):  # not an image although it says so
            dd.save_employee_photo(
                self.req, self.emp.pk, "data:image/jpeg;base64," + base64.b64encode(b"<html>").decode()
            )
        big = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff" + b"0" * dd.MAX_PHOTO_BYTES).decode()
        with self.assertRaises(ValueError):
            dd.save_employee_photo(self.req, self.emp.pk, big)
        self.emp.refresh_from_db()
        self.assertFalse(self.emp.photo_url)

    def test_it_needs_edit_access_to_employees_and_the_employee_in_scope(self):
        _h, viewer = hr_headers(
            super_admin=False, permissions={"attendance": "edit", "employees": "view"}, username="pv"
        )
        with self.assertRaises(PermissionError):
            dd.save_employee_photo(self.request(viewer), self.emp.pk, JPEG)
        branch = Branch.objects.create(name="Mine", code="M")
        with self.assertRaises(LookupError):
            dd.save_employee_photo(self.request(self.admin, scope=branch.pk), self.emp.pk, JPEG)
        with self.assertRaises(LookupError):
            dd.save_employee_photo(self.req, 999999, JPEG)


# ─── the endpoints ──────────────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class EndpointTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        self.fa.add_user(1, "1001", "Asha K", privilege=14)
        self.fb.add_user(1, "1001", "Asha K")
        self.employee("1001", "Asha", "Kumar")
        self.employee("1004", "Kumar", "V")
        self.admin, _ = hr_headers(username="ep_admin")
        dd.clear_probe_cache()

    def get(self, path, headers=None, **params):
        return self.client.get(f"{BASE}{path}", params, **(headers or self.admin))

    def post(self, path, body, headers=None):
        return self.client.post(f"{BASE}{path}", body, content_type="application/json", **(headers or self.admin))

    def test_the_overview_counts_the_devices_this_server_can_open_a_session_with(self):
        self.fb.server.stop()
        BiometricDevice.objects.create(name="Off", host=HOST, port=1, is_active=False)
        r = self.get("/overview", fresh="1")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            {k: body["summary"][k] for k in ("configured", "enabled", "connected", "disconnected", "disabled")},
            {"configured": 3, "enabled": 2, "connected": 1, "disconnected": 1, "disabled": 1},
        )
        by_name = {d["name"]: d for d in body["devices"]}
        self.assertEqual(by_name["A"]["connection"]["state"], "connected")
        self.assertEqual(by_name["A"]["capacity"]["usersCap"], 3000)
        self.assertEqual(by_name["B"]["connection"]["state"], "disconnected")
        self.assertEqual(by_name["B"]["connection"]["code"], "refused")
        self.assertEqual(by_name["Off"]["connection"]["state"], "disabled")
        self.assertEqual(body["server"]["deployment"], "local")

    def test_the_overview_keeps_what_a_device_reported_about_itself(self):
        self.get("/overview", fresh="1")
        self.a.refresh_from_db()
        self.assertEqual(self.a.capacity["serial"], self.fa.serial)
        self.assertIsNotNone(self.a.last_reachable_at)

    def test_the_overview_on_the_cloud_explains_instead_of_timing_out(self):
        BiometricDevice.objects.create(name="Lan", host="192.168.0.59", port=4370)
        with mock.patch.dict(os.environ, {"RAILWAY_ENVIRONMENT": "production"}):
            with mock.patch("socket.create_connection") as dial:
                body = self.get("/overview", fresh="1").json()
            dial.assert_not_called()  # every address here (the fakes are on loopback) is private: nothing is dialled
        self.assertEqual({d["connection"]["code"] for d in body["devices"]}, {"cloud"})
        self.assertIn("cloud", next(d for d in body["devices"] if d["name"] == "Lan")["connection"]["reason"])
        self.assertEqual(body["server"]["deployment"], "railway")
        self.assertEqual(body["summary"]["connected"], 0)
        self.assertEqual(body["summary"]["disconnected"], 3)

    def test_people_lists_with_the_facets_and_takes_filters_from_the_query_string(self):
        self.client.post(f"{BASE}/users/refresh", {}, content_type="application/json", **self.admin)
        body = self.get("/people").json()
        self.assertEqual(body["total"], 2)
        self.assertEqual({i["userId"] for i in body["items"]}, {"1001", "1004"})
        multi = self.get("/people", count="multiple", devices=f"{self.a.pk},{self.b.pk}", deviceMode="all").json()
        self.assertEqual([i["userId"] for i in multi["items"]], ["1001"])
        missing = self.get("/people", devices=str(self.a.pk), deviceMode="none").json()
        self.assertEqual([i["userId"] for i in missing["items"]], ["1004"])
        self.assertEqual(self.get("/people", devices="a,b").status_code, 400)
        # junk values fall back to "no filter" instead of erroring
        self.assertEqual(
            self.get("/people", link="nonsense", count="x", role="y", page="-4", pageSize="abc").status_code, 200
        )

    def test_refresh_push_update_and_delete_work_through_the_api(self):
        r = self.post("/users/refresh", {"deviceIds": [self.a.pk]})
        self.assertEqual(r.json()["results"][0]["count"], 1)
        r = self.post("/users/push", {"deviceIds": [self.a.pk], "users": [{"userId": "2001", "name": "Via Api"}]})
        self.assertEqual(r.json()["summary"]["added"], 1)
        self.assertEqual(self.fa.user("2001")["name"], "Via Api")
        r = self.post("/users/update", {"deviceIds": [self.a.pk], "users": [{"userId": "2001", "name": "Renamed"}]})
        self.assertEqual(r.json()["summary"]["updated"], 1)
        r = self.post("/users/delete", {"userIds": ["2001"], "deviceIds": [self.a.pk], "markInactive": False})
        self.assertEqual(r.json()["summary"]["deleted"], 1)
        self.assertIsNone(self.fa.user("2001"))

    def test_a_delete_through_the_api_makes_the_employee_inactive(self):
        self.post("/users/refresh", {})
        r = self.post("/users/delete", {"userIds": ["1001"], "markInactive": True})
        self.assertEqual(r.json()["summary"], {"deleted": 2, "failed": 0, "madeInactive": 1})
        self.assertEqual(Employee.objects.get(employee_code="1001").status, "inactive")

    def test_bad_requests_are_400_with_a_reason(self):
        self.assertEqual(self.post("/users/push", {"deviceIds": "x", "users": []}).status_code, 400)
        r = self.post("/users/push", {"deviceIds": [self.a.pk], "users": []})
        self.assertEqual((r.status_code, r.json()["error"]), (400, "Choose at least one user."))
        self.assertEqual(self.post("/users/delete", {"userIds": "1001"}).status_code, 400)
        self.assertEqual(self.post("/users/refresh", {"deviceIds": ["x"]}).status_code, 400)

    def test_the_photo_endpoint_saves_and_refuses(self):
        emp = Employee.objects.get(employee_code="1001")
        r = self.post(f"/employees/{emp.pk}/photo", {"photo": JPEG})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.post(f"/employees/{emp.pk}/photo", {"photo": "nope"}).status_code, 400)
        self.assertEqual(self.post("/employees/999999/photo", {"photo": JPEG}).status_code, 404)

    def test_who_may_do_what(self):
        self.assertEqual(self.client.get(f"{BASE}/overview").status_code, 401)
        employee = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': 1})}"}
        self.assertEqual(self.client.get(f"{BASE}/people", **employee).status_code, 403)
        viewer, _ = hr_headers(super_admin=False, permissions={"attendance": "view"}, username="ep_viewer")
        self.assertEqual(self.get("/people", headers=viewer).status_code, 200)
        self.assertEqual(self.get("/overview", headers=viewer).status_code, 200)
        for path, body in (
            ("/users/refresh", {}),
            ("/users/push", {"deviceIds": [self.a.pk], "users": [{"userId": "9", "name": "x"}]}),
            ("/users/update", {"deviceIds": [self.a.pk], "users": [{"userId": "1001", "name": "x"}]}),
            ("/users/delete", {"userIds": ["1001"]}),
            ("/fetch/start", {"deviceIds": [self.a.pk], "range": {"preset": "today"}}),
            ("/employees/1/photo", {"photo": JPEG}),
        ):
            self.assertEqual(self.post(path, body, headers=viewer).status_code, 403, path)
        self.assertIsNone(self.fa.user("9"))
        nobody, _ = hr_headers(super_admin=False, permissions={"leave": "edit"}, username="ep_nobody")
        self.assertEqual(self.get("/people", headers=nobody).status_code, 403)

    def test_a_branch_limited_role_gets_the_restricted_view(self):
        mine = Branch.objects.create(name="Mine", code="M")
        theirs = Branch.objects.create(name="Theirs", code="T")
        Employee.objects.filter(employee_code="1001").update(branch=theirs)
        limited, _ = hr_headers(
            super_admin=False,
            permissions={"attendance": "edit", "employees": "edit"},
            username="ep_scoped",
            branch=mine,
        )
        self.post("/users/refresh", {}, headers=limited)
        items = {i["userId"]: i for i in self.get("/people", headers=limited).json()["items"]}
        self.assertEqual(items["1001"]["link"], "restricted")
        r = self.post("/users/delete", {"userIds": ["1001"], "markInactive": True}, headers=limited)
        self.assertEqual(r.json()["summary"]["deleted"], 0)
        self.assertIsNotNone(self.fa.user("1001"))


class ThreadSafetyTests(WithDevices):
    def test_two_changes_to_the_same_device_at_once_take_turns(self):
        row, fake = self.add_device("A")
        fake.add_user(1, "1001", "Asha")
        dd.refresh_users()
        # the database half of apply_users runs on the calling thread, so drive the device half from two threads
        results = []
        threads = [
            threading.Thread(
                target=lambda uid=uid: results.append(
                    dd._apply_on_device(HOST, row.port, 0, [dd.UserSpec(uid, uid)], "create")
                )
            )
            for uid in ("2001", "2002")
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual(fake.user_ids(), ["1001", "2001", "2002"])
        uids = sorted(fake._parse(r)["uid"] for r in fake.users.values())
        self.assertEqual(uids, [1, 2, 3], "each got its own slot because the sessions did not overlap")


# ─── what an independent review found ───────────────────────────────────────────────────────────────────────────────────


class ReviewRecordTests(SimpleTestCase):
    def test_a_slot_or_id_the_record_cannot_hold_is_refused_not_a_struct_error(self):
        for kwargs in ({"uid": 70000, "user_id": "1"}, {"uid": 0, "user_id": "1"}):
            with self.assertRaises(ValueError):
                dc.build_record(72, name="x", **kwargs)
        with self.assertRaises(ValueError):
            dc.build_record(28, uid=1, user_id="4294967296", name="x")
        with self.assertRaises(ValueError):
            dc.build_record(28, uid=1, user_id="²", name="x")  # a digit that is not 0-9

    def test_an_id_or_password_with_a_trailing_line_break_is_refused(self):
        self.assertIsNone(dd.clean_spec({"userId": "1\n2", "name": "x"})[0])
        self.assertEqual(dd.clean_spec({"userId": " 12\n", "name": "x"})[0].user_id, "12", "the edges are trimmed")
        self.assertIsNone(dd.clean_spec({"userId": "12", "name": "x", "password": "1234\n"})[0])
        self.assertIsNotNone(dd.clean_spec({"userId": "12", "name": "x", "password": "1234"})[0])


class ReviewClientTests(WithDevices):
    def test_a_download_cut_short_ends_at_the_deadline_instead_of_hanging_the_device_for_ever(self):
        fake = FakeDevice()
        fake.add_user(1, "1001", "Asha")
        for minute in range(300):
            fake.add_punch("1001", datetime(2026, 10, 5, 9, minute % 60, 0), 0)
        fake.truncate_reads = True
        server = FakeServer(fake).start()
        self.addCleanup(server.stop)
        outcome = {}

        def read():
            try:
                with dc.open_session(HOST, server.port, 0, deadline=1) as s:
                    s.read_attendance()
                outcome["error"] = None
            except dc.DeviceUnavailable as exc:
                outcome["error"] = exc

        worker = threading.Thread(target=read, daemon=True)
        worker.start()
        worker.join(20)
        self.assertFalse(worker.is_alive(), "pyzk spun for ever on the half-closed connection")
        self.assertEqual(outcome["error"].code, "timeout")
        self.assertIn("did not finish within 1 seconds", outcome["error"].message)
        # and the device is free for the next person
        fake.truncate_reads = False
        self.assertTrue(dc.timed_probe(HOST, server.port, 0)["ok"])

    def test_a_device_that_says_it_has_no_users_while_its_counters_say_otherwise_is_not_believed(self):
        fake = FakeDevice()
        fake.add_user(1, "1001", "Asha")
        fake.report_zero_users = True
        server = FakeServer(fake).start()
        self.addCleanup(server.stop)
        with self.assertRaises(dc.DeviceUnavailable) as caught:
            with dc.open_session(HOST, server.port, 0) as s:
                s.read_users()
        self.assertEqual(caught.exception.code, "protocol")


class ReviewChangeTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        for fake in (self.fa, self.fb):
            fake.add_user(1, "1001", "Asha K")
        self.fa.add_user(2, "1002", "Ravi S")
        dd.refresh_users()
        self.req = self.request()

    def test_a_connection_lost_part_way_still_accounts_for_what_the_device_acknowledged(self):
        self.fa.drop_after_writes = 1
        out = dd.apply_users(
            self.req,
            [self.a.pk],
            [{"userId": "2001", "name": "One"}, {"userId": "2002", "name": "Two"}, {"userId": "2003", "name": "Three"}],
            "create",
        )
        entry = out["results"][0]
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["code"], "lost")
        errors = {f["userId"]: f["error"] for f in entry["failed"]}
        self.assertEqual(set(errors), {"2001", "2002", "2003"})
        self.assertIn("could be confirmed", errors["2001"], "acknowledged, so it IS on the device, but unconfirmed")
        self.assertIn("lost", errors["2002"])
        self.assertEqual(errors["2003"], "Not attempted: the connection to the device was lost.")
        self.assertIsNotNone(self.fa.user("2001"), "the first write really went through")
        self.assertEqual(out["summary"]["added"], 0)
        self.a.refresh_from_db()
        self.assertIn("lost", self.a.users_read_error)

    def test_every_field_that_was_asked_for_is_checked_on_the_read_back(self):
        self.fa.ignore_privilege = True  # a firmware that acknowledges a role change and keeps the old one
        out = dd.apply_users(self.req, [self.a.pk], [{"userId": "1002", "privilege": 14}], "update")
        self.assertEqual(out["results"][0]["updated"], [])
        self.assertEqual(out["results"][0]["failed"][0]["error"], "The device did not keep the change.")
        added = dd.apply_users(self.req, [self.a.pk], [{"userId": "2001", "name": "N", "privilege": 14}], "create")
        self.assertEqual(added["results"][0]["added"], [])
        self.assertEqual(added["summary"]["failed"], 1)

    def test_a_card_or_password_that_did_not_stick_is_not_called_done(self):
        out = dd.apply_users(self.req, [self.a.pk], [{"userId": "1002", "card": 99, "password": "55"}], "update")
        self.assertEqual(out["results"][0]["updated"], ["1002"])
        self.assertEqual(self.fa.user("1002")["card"], 99)

    def test_an_employee_id_of_another_branch_is_not_a_way_to_read_their_name(self):
        mine = Branch.objects.create(name="Mine", code="M1")
        theirs = Branch.objects.create(name="Theirs", code="T1")
        outsider = self.employee("5001", "Secret", "Person", branch=theirs)
        out = dd.apply_users(
            self.request(scope=mine.pk), [self.a.pk], [{"userId": "9999", "employeeId": outsider.pk}], "create"
        )
        self.assertEqual(out["rejected"][0]["error"], "That employee is not this user ID's employee.")
        self.assertIsNone(self.fa.user("9999"))

    def test_an_employee_id_must_belong_to_the_user_id_it_comes_with(self):
        emp = self.employee("5002", "Real", "Owner")
        out = dd.apply_users(self.req, [self.a.pk], [{"userId": "2001", "employeeId": emp.pk}], "create")
        self.assertEqual(out["rejected"][0]["error"], "That employee is not this user ID's employee.")
        good = dd.apply_users(self.req, [self.a.pk], [{"userId": "5002", "employeeId": emp.pk}], "create")
        self.assertEqual(good["results"][0]["added"], ["5002"])
        self.assertEqual(self.fa.user("5002")["name"], "Real Owner")

    def test_something_that_is_not_a_list_of_users_is_a_clear_error(self):
        with self.assertRaises(ValueError):
            dd.apply_users(self.req, [self.a.pk], ["1001", {"userId": "1"}], "create")

    def test_a_device_that_does_not_report_its_capacity_is_not_written_to(self):
        blind, fake_blind = self.add_device("Blind", FakeDevice(users_cap=0))
        out = dd.apply_users(self.req, [blind.pk], [{"userId": "2001", "name": "N"}], "create")
        self.assertEqual((out["results"][0]["ok"], out["results"][0]["code"]), (False, "protocol"))
        self.assertEqual(fake_blind.user_ids(), [])

    def test_nothing_is_written_while_a_sync_from_the_attendance_page_is_running(self):
        with mock.patch("api.sync_progress.is_running", return_value=True):
            with self.assertRaises(dd.SyncRunning):
                dd.apply_users(self.req, [self.a.pk], [{"userId": "2001", "name": "N"}], "create")
            with self.assertRaises(dd.SyncRunning):
                dd.delete_users(self.req, ["1002"], None)
        self.assertIsNone(self.fa.user("2001"))
        self.assertIsNotNone(self.fa.user("1002"))

    def test_the_audit_names_only_the_devices_that_really_changed(self):
        self.fb.refuse_writes = True
        dd.apply_users(self.req, [self.a.pk, self.b.pk], [{"userId": "2001", "name": "N"}], "create")
        entry = AuditLog.objects.get(action="create", module="attendance")
        self.assertIn("device(s) A:", entry.record_description)
        self.assertNotIn("B", entry.record_description.split(":")[0])

    def test_a_snapshot_stored_for_a_device_deleted_meanwhile_does_nothing(self):
        gone, _fake = self.add_device("Gone")
        users = []
        BiometricDevice.objects.filter(pk=gone.pk).delete()
        dd.store_snapshot(gone, users, None)  # must not raise
        self.assertFalse(BiometricDeviceUser.objects.filter(device_id=gone.pk).exists())


class ReviewDeleteTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.b, self.fb = self.add_device("B")
        self.fa.add_user(1, "1001", "Asha K")
        self.fa.add_user(2, "1002", "Ravi S")
        self.fb.add_user(1, "1003", "Meena")
        self.asha = self.employee("1001", "Asha", "K")
        self.ravi = self.employee("1002", "Ravi", "S")
        dd.refresh_users()
        _h, self.admin = hr_headers(username="rev_admin")
        self.req = self.request(self.admin)

    def test_a_delete_that_loses_the_connection_part_way_does_not_forget_what_went_through(self):
        self.fa.drop_after_writes = 1
        out = dd.delete_users(self.req, ["1001", "1002"], [self.a.pk], mark_inactive=True)
        entry = out["results"][0]
        self.assertFalse(entry["ok"])
        failed = {f["userId"]: f["error"] for f in entry["failed"]}
        self.assertIn("could be confirmed", failed["1001"])
        self.assertIsNone(self.fa.user("1001"), "the first delete really happened")
        self.assertEqual(out["inactive"], [], "nothing was confirmed, so no employee is changed")
        # try again once the connection is back: 1001 is already gone there, which is what was asked for
        self.fa.drop_after_writes = None
        again = dd.delete_users(self.req, ["1001", "1002"], [self.a.pk], mark_inactive=True)
        self.assertEqual(again["summary"]["deleted"], 1)
        self.assertEqual({i["userId"]: i["changed"] for i in again["inactive"]}, {"1001": True, "1002": True})
        self.asha.refresh_from_db()
        self.ravi.refresh_from_db()
        self.assertEqual((self.asha.status, self.ravi.status), ("inactive", "inactive"))

    def test_someone_the_list_had_on_the_device_but_who_was_removed_at_the_device_counts_as_gone(self):
        self.fa.users.pop(1)  # removed at the terminal itself since the list was read
        out = dd.delete_users(self.req, ["1001"], None, mark_inactive=True)
        self.assertEqual(out["summary"]["deleted"], 0)
        self.assertTrue(out["inactive"][0]["changed"])
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.status, "inactive")

    def test_someone_who_was_never_on_the_chosen_device_does_not_become_inactive(self):
        out = dd.delete_users(self.req, ["1002"], [self.b.pk], mark_inactive=True)
        self.assertEqual(out["inactive"], [])
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "active")


@override_settings(ALLOWED_HOSTS=["*"])
class ReviewEndpointTests(WithDevices):
    def setUp(self):
        self.a, self.fa = self.add_device("A")
        self.fa.add_user(1, "1001", "Asha K")
        self.emp = self.employee("1001", "Asha", "K")
        self.admin, _ = hr_headers(username="rev_ep_admin")
        dd.refresh_users()

    def post(self, path, body):
        return self.client.post(f"{BASE}{path}", body, content_type="application/json", **self.admin)

    def test_the_word_false_is_false(self):
        r = self.post("/users/delete", {"userIds": ["1001"], "markInactive": "false"})
        self.assertEqual(r.json()["summary"]["deleted"], 1)
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "active", '"false" must not make anyone Inactive')

    def test_a_sync_in_progress_is_a_409_not_a_silent_failure(self):
        with mock.patch("api.sync_progress.is_running", return_value=True):
            self.assertEqual(
                self.post(
                    "/users/push", {"deviceIds": [self.a.pk], "users": [{"userId": "9", "name": "x"}]}
                ).status_code,
                409,
            )
            self.assertEqual(self.post("/users/delete", {"userIds": ["1001"]}).status_code, 409)
        self.assertIsNotNone(self.fa.user("1001"))

    def test_a_list_with_something_that_is_not_a_user_is_a_400(self):
        r = self.post("/users/push", {"deviceIds": [self.a.pk], "users": ["1001"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("object", r.json()["error"])
