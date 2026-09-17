"""
Tea Break -verifies the OUT/IN toggle decision (resolve_tea_break_scan),
its dispatch from the shared gate_scanner_views.py::resolve_gate_scan, the
remark computation (_log_json), and the HR-facing rule/records endpoints'
branch scoping and filters.

Run via: python manage.py test api.tests_tea_break -v 2
"""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIRequestFactory

from .gate_scanner_views import resolve_gate_scan
from .jwt_utils import sign_token
from .models import Branch, Employee, GateDevice, TeaBreakLog, TeaBreakRule
from .tea_break_views import (
    _log_json, resolve_tea_break_scan, tea_break_my_status, tea_break_qr_token,
    tea_break_records, tea_break_rule, tea_break_summary,
)


def _tea_break_qr(employee_id: int) -> str:
    return sign_token({"role": "tea_break", "employeeId": employee_id}, expires_in=timedelta(days=3650))


class ResolveTeaBreakScanTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Tea Break QA Branch")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="teabreak_gate1",
            password_hash="x", login_token="tbtok1",
        )
        self.other_gate = GateDevice.objects.create(
            name="Gate 2", branch=self.branch, username="teabreak_gate2",
            password_hash="x", login_token="tbtok2",
        )
        self.emp = Employee.objects.create(
            employee_code="TEABREAK_EMP1", first_name="Break", last_name="Tester",
            employment_type="staff", status="active",
        )

    def test_first_scan_starts_an_open_out_row(self):
        body, status = resolve_tea_break_scan(self.gate, self.emp)
        self.assertEqual(status, 200)
        self.assertEqual(body["action"], "out")

        log = TeaBreakLog.objects.get(employee=self.emp)
        self.assertEqual(log.out_gate_id, self.gate.id)
        self.assertIsNotNone(log.out_at)
        self.assertIsNone(log.in_at)

    def test_second_scan_closes_the_open_row_as_in(self):
        resolve_tea_break_scan(self.gate, self.emp)
        body, status = resolve_tea_break_scan(self.other_gate, self.emp)
        self.assertEqual(status, 200)
        self.assertEqual(body["action"], "in")
        self.assertIn("takenMinutes", body)

        log = TeaBreakLog.objects.get(employee=self.emp)
        self.assertEqual(log.in_gate_id, self.other_gate.id)
        self.assertIsNotNone(log.in_at)
        # Still exactly one row -the second scan closed the same row, it
        # didn't create a new one.
        self.assertEqual(TeaBreakLog.objects.filter(employee=self.emp).count(), 1)

    def test_third_scan_after_a_completed_cycle_starts_a_fresh_out_row(self):
        resolve_tea_break_scan(self.gate, self.emp)
        resolve_tea_break_scan(self.gate, self.emp)
        body, status = resolve_tea_break_scan(self.gate, self.emp)
        self.assertEqual(body["action"], "out")
        self.assertEqual(TeaBreakLog.objects.filter(employee=self.emp).count(), 2)

    def test_stale_open_row_is_not_closed_by_a_much_later_scan(self):
        stale = TeaBreakLog.objects.create(
            employee=self.emp, out_gate=self.gate, out_at=timezone.now() - timedelta(hours=20),
        )
        body, status = resolve_tea_break_scan(self.gate, self.emp)
        self.assertEqual(body["action"], "out")

        stale.refresh_from_db()
        self.assertIsNone(stale.in_at)  # the old row is untouched
        self.assertEqual(TeaBreakLog.objects.filter(employee=self.emp).count(), 2)

    def test_dispatch_via_resolve_gate_scan_role_claim(self):
        """The single shared scan endpoint (gate_scanner_views.py::
        resolve_gate_scan) must route a tea_break-role token here, exactly
        like it routes outpass_pass/outpass_return tokens to their own
        resolvers -this is the "same gate logins" integration point."""
        body, status = resolve_gate_scan(self.gate, _tea_break_qr(self.emp.id))
        self.assertEqual(status, 200)
        self.assertEqual(body["result"], "success")
        self.assertEqual(body["action"], "out")
        self.assertTrue(TeaBreakLog.objects.filter(employee=self.emp).exists())

    def test_dispatch_with_unknown_employee_id_is_invalid(self):
        body, status = resolve_gate_scan(self.gate, _tea_break_qr(999999))
        self.assertEqual(status, 404)
        self.assertEqual(body["result"], "invalid_qr")


class TeaBreakRemarkTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Tea Break QA Branch 2")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="teabreak_remark_gate",
            password_hash="x", login_token="tbrtok1",
        )
        self.emp = Employee.objects.create(
            employee_code="TEABREAK_EMP2", first_name="Remark", last_name="Tester",
            employment_type="staff", status="active",
        )

    def test_completed_within_allowance_is_on_time(self):
        now = timezone.now()
        log = TeaBreakLog.objects.create(
            employee=self.emp, out_gate=self.gate, out_at=now - timedelta(minutes=10),
            in_gate=self.gate, in_at=now,
        )
        data = _log_json(log, allowed_minutes=15, now=now)
        self.assertEqual(data["remark"], "on_time")
        self.assertEqual(data["takenMinutes"], 10)

    def test_completed_beyond_allowance_is_overtime(self):
        now = timezone.now()
        log = TeaBreakLog.objects.create(
            employee=self.emp, out_gate=self.gate, out_at=now - timedelta(minutes=25),
            in_gate=self.gate, in_at=now,
        )
        data = _log_json(log, allowed_minutes=15, now=now)
        self.assertEqual(data["remark"], "overtime")
        self.assertEqual(data["takenMinutes"], 25)

    def test_open_within_60_minutes_is_in_progress(self):
        now = timezone.now()
        log = TeaBreakLog.objects.create(employee=self.emp, out_gate=self.gate, out_at=now - timedelta(minutes=30))
        data = _log_json(log, allowed_minutes=15, now=now)
        self.assertEqual(data["remark"], "in_progress")

    def test_open_beyond_60_minutes_is_not_returned(self):
        now = timezone.now()
        log = TeaBreakLog.objects.create(employee=self.emp, out_gate=self.gate, out_at=now - timedelta(minutes=61))
        data = _log_json(log, allowed_minutes=15, now=now)
        self.assertEqual(data["remark"], "not_returned")


class TeaBreakHrEndpointsTests(TestCase):
    def setUp(self):
        self.branch_a = Branch.objects.create(name="Tea Break QA Branch A")
        self.branch_b = Branch.objects.create(name="Tea Break QA Branch B")
        self.gate_a = GateDevice.objects.create(
            name="Gate A", branch=self.branch_a, username="teabreak_hr_gate_a",
            password_hash="x", login_token="tbhrtok_a",
        )
        self.emp_a = Employee.objects.create(
            employee_code="TEABREAK_HR_EMP_A", first_name="Alpha", last_name="A",
            employment_type="staff", status="active", branch=self.branch_a,
        )
        self.emp_b = Employee.objects.create(
            employee_code="TEABREAK_HR_EMP_B", first_name="Beta", last_name="B",
            employment_type="staff", status="active", branch=self.branch_b,
        )
        now = timezone.now()
        # Branch A: one overtime (completed, 30 min vs a 15 min rule) and one not-returned.
        TeaBreakLog.objects.create(
            employee=self.emp_a, out_gate=self.gate_a, out_at=now - timedelta(minutes=30),
            in_gate=self.gate_a, in_at=now,
        )
        TeaBreakLog.objects.create(employee=self.emp_a, out_gate=self.gate_a, out_at=now - timedelta(minutes=90))
        # Branch B: one on-time break -must never show up in an HR-A-scoped query.
        TeaBreakLog.objects.create(
            employee=self.emp_b, out_gate=None, out_at=now - timedelta(minutes=5),
            in_gate=None, in_at=now,
        )
        self.factory = APIRequestFactory()

    def _hr_request(self, path: str, branch_id: int | None):
        payload = {"role": "hr", "hrUserId": 1}
        token = sign_token(payload)
        request = self.factory.get(path, HTTP_AUTHORIZATION=f"Bearer {token}")
        if branch_id is not None:
            request.hr_branch_id = branch_id
        return request

    def test_rule_get_defaults_to_15_and_put_updates_it(self):
        get_response = tea_break_rule(self._hr_request("/api/tea-break/rule", branch_id=None))
        self.assertEqual(get_response.data["allowedMinutes"], 15)

        put_request = self.factory.put(
            "/api/tea-break/rule", {"allowedMinutes": 20}, format="json",
            HTTP_AUTHORIZATION=f"Bearer {sign_token({'role': 'hr', 'hrUserId': 1})}",
        )
        put_response = tea_break_rule(put_request)
        self.assertEqual(put_response.data["allowedMinutes"], 20)
        self.assertEqual(TeaBreakRule.get().allowed_minutes, 20)

    def test_rule_put_rejects_non_positive_value(self):
        request = self.factory.put(
            "/api/tea-break/rule", {"allowedMinutes": 0}, format="json",
            HTTP_AUTHORIZATION=f"Bearer {sign_token({'role': 'hr', 'hrUserId': 1})}",
        )
        response = tea_break_rule(request)
        self.assertEqual(response.status_code, 400)

    def test_records_scoped_to_branch_a_excludes_branch_b(self):
        request = self._hr_request("/api/tea-break/records?range=today", branch_id=self.branch_a.id)
        response = tea_break_records(request)
        self.assertEqual(response.data["total"], 2)
        names = {row["employee"]["name"] for row in response.data["items"]}
        self.assertEqual(names, {"Alpha A"})

    def test_records_overtime_filter(self):
        request = self._hr_request("/api/tea-break/records?range=today&filter=overtime", branch_id=self.branch_a.id)
        response = tea_break_records(request)
        self.assertEqual(response.data["total"], 1)
        self.assertEqual(response.data["items"][0]["remark"], "overtime")

    def test_records_not_returned_filter(self):
        request = self._hr_request("/api/tea-break/records?range=today&filter=not_returned", branch_id=self.branch_a.id)
        response = tea_break_records(request)
        self.assertEqual(response.data["total"], 1)
        self.assertEqual(response.data["items"][0]["remark"], "not_returned")

    def test_summary_scoped_to_branch_a(self):
        request = self._hr_request("/api/tea-break/summary", branch_id=self.branch_a.id)
        response = tea_break_summary(request)
        self.assertEqual(response.data["today"], 2)


class TeaBreakEmployeeEndpointsTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Tea Break QA Branch 3")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="teabreak_emp_gate",
            password_hash="x", login_token="tbemptok1",
        )
        self.emp = Employee.objects.create(
            employee_code="TEABREAK_EMP3", first_name="My", last_name="Status",
            employment_type="staff", status="active",
        )
        self.factory = APIRequestFactory()

    def _emp_request(self, path: str):
        token = sign_token({"role": "employee", "employeeId": self.emp.id})
        return self.factory.get(path, HTTP_AUTHORIZATION=f"Bearer {token}")

    def test_qr_token_encodes_this_employee_and_tea_break_role(self):
        from .jwt_utils import verify_token

        response = tea_break_qr_token(self._emp_request("/api/tea-break/qr-token"))
        payload = verify_token(response.data["qrToken"])
        self.assertEqual(payload["role"], "tea_break")
        self.assertEqual(payload["employeeId"], self.emp.id)

    def test_my_status_reflects_an_open_break(self):
        resolve_tea_break_scan(self.gate, self.emp)
        response = tea_break_my_status(self._emp_request("/api/tea-break/my-status"))
        self.assertTrue(response.data["onBreak"])
        self.assertIsNotNone(response.data["outAt"])
        self.assertEqual(len(response.data["recent"]), 1)

    def test_my_status_when_no_breaks_yet(self):
        response = tea_break_my_status(self._emp_request("/api/tea-break/my-status"))
        self.assertFalse(response.data["onBreak"])
        self.assertEqual(response.data["recent"], [])
