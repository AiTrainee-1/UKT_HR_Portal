"""
Device Control: limiting an employee's punches to chosen devices.

Two people can share an Employee Code on devices of different units. An employee limited to some devices has a punch with
their code from any OTHER device ignored (never written); everybody else, and everything already recorded, is unchanged.

Run via: python manage.py test api.tests_device_punch_rules -v 2
"""

from datetime import date, datetime

from django.test import TestCase

from .device_punch_rules import NOT_A_DEVICE, accepts, device_id_for_serial, device_rules
from .jwt_utils import sign_token
from .models import (
    Attendance,
    AttendanceLog,
    AuditLog,
    BiometricDevice,
    BiometricFetchRun,
    Branch,
    Employee,
    HRUser,
    Role,
    UnmatchedPunch,
)

BASE = "/api/attendance/device-control"


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class RulesBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.ho = BiometricDevice.objects.create(name="HO", host="10.0.0.1", serial_number="SN-HO")
        cls.u1 = BiometricDevice.objects.create(name="unit1", host="10.0.1.1", serial_number="SN-U1")
        cls.b1 = Branch.objects.create(name="Unit A", code="UA")
        cls.b2 = Branch.objects.create(name="Unit B", code="UB")
        cls.murugan = Employee.objects.create(employee_code="188", first_name="Murugan", last_name="P", branch=cls.b1)
        cls.kumar = Employee.objects.create(employee_code="189", first_name="Kumar", last_name="S", branch=cls.b1)
        cls.other = Employee.objects.create(employee_code="900", first_name="Other", last_name="U", branch=cls.b2)
        cls.admin = HRUser.objects.create(username="hr_admin", password_hash="x", is_super_admin=True)
        role = Role.objects.create(name="att", permissions={"attendance": "edit", "employees": "view"})
        cls.unit_a = HRUser.objects.create(username="hr_a", password_hash="x", role=role, branch=cls.b1)
        cls.murugan.punch_devices.set([cls.ho])  # Murugan takes punches from the Head Office device only

    def push(self, serial, *lines):
        body = "".join(f"{code}\t{when}\t255\t15\n" for code, when in lines)
        r = self.client.post(f"/iclock/cdata?SN={serial}&table=ATTLOG", body, content_type="text/plain")
        self.assertEqual(r.status_code, 200)

    def logs(self, emp):
        return list(AttendanceLog.objects.filter(employee=emp).values_list("date", "punch_time", "source"))


class RuleHelperTests(RulesBase):
    def test_only_limited_employees_are_listed_and_the_default_is_any_device(self):
        rules = device_rules()
        self.assertEqual(rules, {self.murugan.pk: frozenset({self.ho.pk})})
        self.assertTrue(accepts(rules, self.kumar.pk, self.u1.pk))  # not limited: any device
        self.assertTrue(accepts(rules, self.murugan.pk, self.ho.pk))
        self.assertFalse(accepts(rules, self.murugan.pk, self.u1.pk))
        self.assertFalse(accepts(rules, self.murugan.pk, None))  # a device the HRMS cannot name
        self.assertTrue(accepts(rules, self.murugan.pk, NOT_A_DEVICE))  # Excel import, geo: no device rule

    def test_a_serial_finds_its_device(self):
        self.assertEqual(device_id_for_serial("SN-U1"), self.u1.pk)
        self.assertIsNone(device_id_for_serial("SN-UNKNOWN"))
        self.assertIsNone(device_id_for_serial(""))
        self.assertIsNone(device_id_for_serial(None))


class AdmsPushTests(RulesBase):
    def test_the_allowed_device_is_recorded_and_another_unit_with_the_same_code_is_ignored(self):
        self.push("SN-HO", ("188", "2026-10-06 09:00:00"))
        self.push("SN-U1", ("188", "2026-10-06 09:05:00"))  # the other unit's "188"
        self.assertEqual([t for _d, t, _s in self.logs(self.murugan)], [datetime(2026, 10, 6, 9).time()])
        self.assertEqual(UnmatchedPunch.objects.count(), 0, "an ignored punch is not an unknown person")

    def test_an_unlimited_employee_takes_punches_from_every_device(self):
        self.push("SN-HO", ("189", "2026-10-06 09:00:00"))
        self.push("SN-U1", ("189", "2026-10-06 18:00:00"))
        self.assertEqual(len(self.logs(self.kumar)), 2)

    def test_a_device_the_hrms_does_not_know_cannot_give_a_limited_employee_punches(self):
        self.push("SN-NEW", ("188", "2026-10-06 09:00:00"), ("189", "2026-10-06 09:01:00"))
        self.assertEqual(self.logs(self.murugan), [])
        self.assertEqual(len(self.logs(self.kumar)), 1)

    def test_a_mixed_push_keeps_what_belongs_and_drops_the_rest(self):
        self.push(
            "SN-U1", ("188", "2026-10-06 09:00:00"), ("189", "2026-10-06 09:01:00"), ("188", "2026-10-06 17:00:00")
        )
        self.assertEqual(self.logs(self.murugan), [])
        self.assertEqual(len(self.logs(self.kumar)), 1)
        self.assertFalse(Attendance.objects.filter(employee=self.murugan).exists())

    def test_the_rule_changes_nothing_already_recorded(self):
        AttendanceLog.objects.create(
            employee=self.murugan,
            date=date(2026, 10, 1),
            punch_time=datetime(2026, 10, 1, 9).time(),
            punch_type="IN",
            source="x",
        )
        self.push("SN-U1", ("188", "2026-10-06 09:05:00"))
        self.assertEqual(AttendanceLog.objects.filter(employee=self.murugan).count(), 1)

    def test_clearing_the_rule_takes_punches_from_any_device_again(self):
        self.murugan.punch_devices.clear()
        self.push("SN-U1", ("188", "2026-10-06 09:05:00"))
        self.assertEqual(len(self.logs(self.murugan)), 1)


class SharedWritePathTests(RulesBase):
    def test_punches_that_are_not_from_a_device_are_never_limited(self):
        from .biometric_sync import _ingest_punches

        row = [("188", date(2026, 10, 6), datetime(2026, 10, 6, 9).time(), "IN")]
        out = _ingest_punches(row, None, "biometric:excel-import")
        self.assertEqual((out["created"], out["restricted"]), (1, 0))

    def test_a_device_pull_ignores_a_limited_employee_from_another_device(self):
        from .biometric_sync import _ingest_punches

        row = [
            ("188", date(2026, 10, 6), datetime(2026, 10, 6, 9).time(), "IN"),
            ("189", date(2026, 10, 6), datetime(2026, 10, 6, 9).time(), "IN"),
        ]
        out = _ingest_punches(row, None, "biometric:unit1", device_id=self.u1.pk)
        self.assertEqual((out["created"], out["restricted"], out["skipped"]), (1, 1, 1))
        self.assertEqual(out["notFound"], set())
        out = _ingest_punches(row, None, "biometric:HO", device_id=self.ho.pk)
        self.assertEqual((out["created"], out["restricted"]), (1, 0))  # Murugan's, from HO; Kumar's was already there


class DataFetchTests(RulesBase):
    def test_a_fetch_counts_the_ignored_punches_apart(self):
        from . import device_fetch as fetch
        from .device_fetch import Punch

        run = BiometricFetchRun.objects.create(
            mode="update", status="running", started_by="t", range_label="x", date_from=None, date_to=None,
            device_ids=[self.u1.pk], results=[],
        )  # fmt: skip
        data = {
            "punches": [
                Punch("188", datetime(2026, 10, 6, 9, 0), 0),
                Punch("189", datetime(2026, 10, 6, 9, 1), 0),
                Punch("777", datetime(2026, 10, 6, 9, 2), 0),
            ],
            "invalid": 0,
            "total": 3,
            "ms": 0,
        }
        by_code = {e.employee_code: e for e in Employee.objects.all()}
        result = fetch._process_device(run, self.u1, data, by_code)
        self.assertEqual((result["restricted"], result["matched"], result["new"], result["created"]), (1, 1, 1, 1))
        self.assertEqual(result["unmatchedPunches"], 1)  # 777 is unknown; 188 is not "unknown", it is somebody else's
        self.assertEqual(AttendanceLog.objects.filter(employee=self.murugan).count(), 0)
        self.assertEqual(AttendanceLog.objects.filter(employee=self.kumar).count(), 1)


class HttpPushTests(RulesBase):
    def test_the_generic_http_push_ignores_a_limited_employee_from_another_device(self):
        from django.test import override_settings

        with override_settings(BIOMETRIC_API_KEY="k"):
            body = {"personId": "188", "time": "2026-10-06T09:00:00", "devSN": "SN-U1"}
            r = self.client.post("/api/biometric/punch", body, content_type="application/json", HTTP_X_DEVICE_KEY="k")
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()["ignored"], "device_not_allowed_for_employee")
            self.assertEqual(self.logs(self.murugan), [])
            r = self.client.post(
                "/api/biometric/punch",
                {**body, "devSN": "SN-HO"},
                content_type="application/json",
                HTTP_X_DEVICE_KEY="k",
            )
            self.assertEqual(r.status_code, 201, r.content)


class EndpointTests(RulesBase):
    def post(self, emp, ids, user=None):
        return self.client.post(
            f"{BASE}/employees/{emp.pk}/punch-devices", {"deviceIds": ids}, content_type="application/json",
            **hdr(user or self.admin),
        )  # fmt: skip

    def test_choosing_devices_limits_the_employee_and_an_empty_list_frees_them(self):
        r = self.post(self.kumar, [self.u1.pk, self.ho.pk])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["punchDevices"], sorted([self.u1.pk, self.ho.pk]))
        self.assertEqual(set(self.kumar.punch_devices.values_list("pk", flat=True)), {self.u1.pk, self.ho.pk})
        entry = AuditLog.objects.filter(module="attendance", action="update").latest("id")
        self.assertIn("only from", entry.record_description)
        self.assertEqual(self.post(self.kumar, []).status_code, 200)
        self.assertEqual(self.kumar.punch_devices.count(), 0)
        self.assertIn("from any device", AuditLog.objects.latest("id").record_description)

    def test_saving_the_same_choice_again_writes_no_audit_row(self):
        self.post(self.kumar, [self.ho.pk])
        count = AuditLog.objects.count()
        self.post(self.kumar, [self.ho.pk])
        self.assertEqual(AuditLog.objects.count(), count)

    def test_an_unknown_device_or_employee_or_a_bad_list_is_refused(self):
        self.assertEqual(self.post(self.kumar, [99999]).status_code, 400)
        r = self.client.post(
            f"{BASE}/employees/99999/punch-devices",
            {"deviceIds": []},
            content_type="application/json",
            **hdr(self.admin),
        )
        self.assertEqual(r.status_code, 404)
        r = self.client.post(
            f"{BASE}/employees/{self.kumar.pk}/punch-devices",
            {"deviceIds": ["x"]},
            content_type="application/json",
            **hdr(self.admin),
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.kumar.punch_devices.count(), 0)

    def test_a_branch_login_cannot_change_another_branchs_employee(self):
        self.assertEqual(self.post(self.other, [self.ho.pk], user=self.unit_a).status_code, 404)
        self.assertEqual(self.other.punch_devices.count(), 0)
        self.assertEqual(self.post(self.kumar, [self.ho.pk], user=self.unit_a).status_code, 200)

    def test_a_view_only_attendance_role_may_not_change_it(self):
        role = Role.objects.create(name="viewer", permissions={"attendance": "view"})
        viewer = HRUser.objects.create(username="viewer", password_hash="x", role=role)
        self.assertEqual(self.post(self.kumar, [self.ho.pk], user=viewer).status_code, 403)

    def test_the_people_list_says_which_devices_each_employee_is_limited_to(self):
        r = self.client.get(f"{BASE}/people", {"search": "188"}, **hdr(self.admin))
        self.assertEqual(r.status_code, 200, r.content)
        mine = next(p for p in r.json()["items"] if p["userId"] == "188")
        self.assertEqual(mine["employee"]["punchDevices"], [self.ho.pk])
        r = self.client.get(f"{BASE}/people", {"search": "189"}, **hdr(self.admin))
        self.assertEqual(next(p for p in r.json()["items"] if p["userId"] == "189")["employee"]["punchDevices"], [])
