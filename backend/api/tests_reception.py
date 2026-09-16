"""
Reception -per-desk login onto Visitor data, plus the visitor-gate-form
extension that resolves "whom you're meeting" to a real Employee by phone
number and notifies them. Mirrors tests_gate_scanner.py's conventions:
call the (already-decorated) view functions directly via APIRequestFactory
rather than exercising them through urls.py, and test the pure helper
functions (here, _find_employee_by_phone) directly.

Run via: python manage.py test api.tests_reception -v 2
"""
from django.test import TestCase
from rest_framework.test import APIRequestFactory

from .auth import require_reception_device
from .jwt_utils import sign_token
from .models import Branch, Department, Employee, GateQRCode, ReceptionDevice, Visitor, VisitorVisit
from .outpass_visitor_views import (
    _find_employee_by_phone, visitor_check_employee_phone, visitor_gate_new, visitor_gate_repeat,
)
from .reception_views import reception_summary, reception_visits


class FindEmployeeByPhoneTests(TestCase):
    def setUp(self):
        self.dept = Department.objects.create(name="Reception QA Dept")
        self.emp = Employee.objects.create(
            employee_code="RECTEST_EMP1", first_name="Host", last_name="Employee",
            employment_type="staff", status="active", department=self.dept, phone="98765 43210",
        )

    def test_exact_match(self):
        found = _find_employee_by_phone("98765 43210")
        self.assertEqual(found.id, self.emp.id)

    def test_digits_only_match_ignores_formatting(self):
        found = _find_employee_by_phone("+91-9876543210")
        self.assertEqual(found.id, self.emp.id)

    def test_no_match_returns_none(self):
        self.assertIsNone(_find_employee_by_phone("00000 00000"))

    def test_blank_phone_returns_none(self):
        self.assertIsNone(_find_employee_by_phone(""))

    def test_short_digit_string_does_not_false_positive(self):
        # A too-short input must never fall through to a tail-match against
        # a real number that happens to share a few trailing digits.
        self.assertIsNone(_find_employee_by_phone("10"))


class VisitorGateEmployeeLinkTests(TestCase):
    """visitor_gate_new / visitor_gate_repeat with a resolved meetingEmployeeId
    -verifies the VisitorVisit.meeting_employee FK gets set, and that
    notification attempts (SMTP/WhatsApp unconfigured in tests) fail
    silently rather than blocking check-in."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Reception QA Branch")
        self.qr = GateQRCode.get_or_create_for(self.branch, GateQRCode.KIND_VISITOR)
        self.dept = Department.objects.create(name="Reception QA Dept 2")
        self.emp = Employee.objects.create(
            employee_code="RECTEST_EMP2", first_name="Meeting", last_name="Target",
            employment_type="staff", status="active", department=self.dept,
            phone="91234 56789", email="target@example.com",
        )
        self.factory = APIRequestFactory()

    def test_check_employee_phone_resolves_match(self):
        request = self.factory.post(
            f"/api/visitor/gate/{self.qr.token}/check-employee-phone", {"phone": "9123456789"}, format="json",
        )
        response = visitor_check_employee_phone(request, self.qr.token)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["found"])
        self.assertEqual(response.data["employee"]["id"], self.emp.id)
        self.assertEqual(response.data["employee"]["department"], "Reception QA Dept 2")

    def test_check_employee_phone_no_match(self):
        request = self.factory.post(
            f"/api/visitor/gate/{self.qr.token}/check-employee-phone", {"phone": "00000000"}, format="json",
        )
        response = visitor_check_employee_phone(request, self.qr.token)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["found"])

    def test_new_visitor_links_meeting_employee_and_does_not_crash_on_notify(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "Vishal Visitor", "phone": "70000 00001", "whomToMeet": "Meeting Target",
            "purpose": "Delivery", "meetingEmployeeId": self.emp.id,
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)

        visit = VisitorVisit.objects.get(visitor__phone="70000 00001")
        self.assertEqual(visit.meeting_employee_id, self.emp.id)
        # No SMTP/WhatsApp configured in the test environment -both sends
        # must fail silently rather than raising, and never mark "notified".
        self.assertIsNone(visit.notified_email_at)
        self.assertIsNone(visit.notified_whatsapp_at)

    def test_new_visitor_without_employee_id_leaves_fk_null(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "No Link Visitor", "phone": "70000 00002", "whomToMeet": "General enquiry",
            "purpose": "Walk-in",
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.get(visitor__phone="70000 00002")
        self.assertIsNone(visit.meeting_employee_id)

    def test_repeat_visitor_links_meeting_employee(self):
        visitor = Visitor.objects.create(name="Returning Person", phone="70000 00003")
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/repeat", {
            "phone": "70000 00003", "whomToMeet": "Meeting Target", "purpose": "Follow-up",
            "meetingEmployeeId": self.emp.id,
        }, format="json")
        response = visitor_gate_repeat(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.filter(visitor=visitor).latest("visited_at")
        self.assertEqual(visit.meeting_employee_id, self.emp.id)

    def test_new_visitor_with_bogus_employee_id_is_ignored_not_errored(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "Bogus Link Visitor", "phone": "70000 00004", "whomToMeet": "Someone",
            "purpose": "Walk-in", "meetingEmployeeId": 999999,
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.get(visitor__phone="70000 00004")
        self.assertIsNone(visit.meeting_employee_id)


class ReceptionDeviceRevocationTests(TestCase):
    """Mirrors tests_gate_scanner.py::GateDeviceRevocationTests exactly, for
    ReceptionDevice/require_reception_device instead of GateDevice."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Reception QA Branch 2")
        self.device = ReceptionDevice.objects.create(
            name="Front Desk", branch=self.branch, username="reception1",
            password_hash="x", login_token="rtok1",
        )

    def test_require_reception_device_rejects_deactivated_desk(self):
        token = sign_token({"role": "reception_device", "deviceId": self.device.id, "deskName": self.device.name})
        self.device.is_active = False
        self.device.save(update_fields=["is_active"])

        seen = {}

        @require_reception_device
        def view(request):
            seen["called"] = True
            return "ok"

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        result = view(FakeRequest())
        self.assertNotIn("called", seen)
        self.assertEqual(result.status_code, 403)

    def test_require_reception_device_accepts_active_desk(self):
        token = sign_token({"role": "reception_device", "deviceId": self.device.id, "deskName": self.device.name})

        @require_reception_device
        def view(request):
            return request.reception_device.name

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        self.assertEqual(view(FakeRequest()), "Front Desk")


class ReceptionDashboardScopingTests(TestCase):
    """reception_summary / reception_visits must only ever show the
    authenticated desk's own branch -mirrors the same reasoning as
    tests_gate_scanner.py's per-gate scoping of gate_scan_log."""

    def setUp(self):
        self.branch_a = Branch.objects.create(name="Reception QA Branch A")
        self.branch_b = Branch.objects.create(name="Reception QA Branch B")
        self.device_a = ReceptionDevice.objects.create(
            name="Desk A", branch=self.branch_a, username="reception_a",
            password_hash="x", login_token="rtok_a",
        )
        visitor_a = Visitor.objects.create(name="Visitor A", phone="80000 00001")
        visitor_b = Visitor.objects.create(name="Visitor B", phone="80000 00002")
        VisitorVisit.objects.create(visitor=visitor_a, branch=self.branch_a, whom_to_meet="Someone", purpose="Test")
        VisitorVisit.objects.create(visitor=visitor_b, branch=self.branch_b, whom_to_meet="Someone", purpose="Test")

        self.factory = APIRequestFactory()

    def _auth_request(self, path: str):
        token = sign_token({"role": "reception_device", "deviceId": self.device_a.id, "deskName": self.device_a.name})
        return self.factory.get(path, HTTP_AUTHORIZATION=f"Bearer {token}")

    def test_summary_only_counts_own_branch(self):
        response = reception_summary(self._auth_request("/api/reception-devices/summary"))
        self.assertEqual(response.data["today"], 1)

    def test_visits_only_lists_own_branch(self):
        response = reception_visits(self._auth_request("/api/reception-devices/visits?range=month"))
        self.assertEqual(response.data["total"], 1)
        self.assertEqual(response.data["items"][0]["name"], "Visitor A")
