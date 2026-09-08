"""
Gate Scanner -verifies the QR-verification/exit-recording decision
(resolve_gate_scan) against every state an approved Outpass can be in, and
that the GateDevice revocation switch (is_active) actually blocks a device.

Run via: python manage.py test api.tests_gate_scanner -v 2
"""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from .auth import require_gate_device
from .gate_scanner_views import resolve_gate_scan
from .jwt_utils import sign_token
from .models import Branch, Employee, GateDevice, OutpassGateScan, OutpassRequest


def _qr_for(req: OutpassRequest, expires_in: timedelta = timedelta(minutes=60)) -> str:
    return sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=expires_in)


class ResolveGateScanTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="gate1",
            password_hash="x", login_token="tok1",
        )
        self.other_gate = GateDevice.objects.create(
            name="Gate 2", branch=self.branch, username="gate2",
            password_hash="x", login_token="tok2",
        )
        self.emp = Employee.objects.create(
            employee_code="GATETEST_EMP1", first_name="Gate", last_name="Tester",
            employment_type="staff", status="active",
        )

    def _approved_request(self, **overrides):
        defaults = dict(
            employee=self.emp, destination="Bank", reason="Cash withdrawal",
            status=OutpassRequest.STATUS_APPROVED, approved_at=timezone.now(),
            approver_role="hr", approved_by="HR Person",
        )
        defaults.update(overrides)
        return OutpassRequest.objects.create(**defaults)

    def test_valid_scan_records_exit_and_logs_success(self):
        req = self._approved_request()
        body, status = resolve_gate_scan(self.gate, _qr_for(req))

        self.assertEqual(status, 200)
        self.assertEqual(body["result"], "success")
        self.assertEqual(body["employee"]["employeeCode"], "GATETEST_EMP1")

        req.refresh_from_db()
        self.assertIsNotNone(req.exited_at)
        self.assertEqual(req.exit_gate_id, self.gate.id)
        scan = OutpassGateScan.objects.get(outpass_request=req)
        self.assertEqual(scan.result, OutpassGateScan.RESULT_SUCCESS)
        self.assertEqual(scan.gate_id, self.gate.id)

    def test_second_scan_of_same_pass_is_denied_as_already_scanned(self):
        req = self._approved_request()
        qr = _qr_for(req)
        resolve_gate_scan(self.gate, qr)

        body, status = resolve_gate_scan(self.other_gate, qr)
        self.assertEqual(status, 409)
        self.assertEqual(body["result"], "already_scanned")
        self.assertIn("Gate 1", body["message"])

        # The second (denied) attempt must not overwrite the original exit gate.
        req.refresh_from_db()
        self.assertEqual(req.exit_gate_id, self.gate.id)
        self.assertEqual(
            OutpassGateScan.objects.filter(outpass_request=req).count(), 2,
        )

    def test_pending_request_is_denied_as_not_approved(self):
        req = OutpassRequest.objects.create(employee=self.emp, destination="Market", reason="Errand")
        # A pending request has no approved_at, so there's nothing valid to
        # sign a real pass token from -simulate a forged/guessed requestId.
        qr = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=60))

        body, status = resolve_gate_scan(self.gate, qr)
        self.assertEqual(status, 403)
        self.assertEqual(body["result"], "not_approved")
        self.assertEqual(OutpassGateScan.objects.get(outpass_request=req).result, OutpassGateScan.RESULT_NOT_APPROVED)

    def test_rejected_request_is_denied_as_not_approved(self):
        req = OutpassRequest.objects.create(
            employee=self.emp, destination="Market", reason="Errand",
            status=OutpassRequest.STATUS_REJECTED, approved_by="HR Person",
        )
        qr = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=60))

        body, status = resolve_gate_scan(self.gate, qr)
        self.assertEqual(status, 403)
        self.assertEqual(body["result"], "not_approved")

    def test_expired_pass_is_denied(self):
        req = self._approved_request(approved_at=timezone.now() - timedelta(minutes=90))
        # The signed token itself would already be expired too (jwt.decode
        # raises on exp) -so this exercises the live re-check path by signing
        # a token that is itself still valid but whose request has aged out.
        qr = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=5))

        body, status = resolve_gate_scan(self.gate, qr)
        self.assertEqual(status, 410)
        self.assertEqual(body["result"], "expired")
        self.assertIsNone(req.exited_at)

    def test_garbage_qr_token_is_invalid(self):
        body, status = resolve_gate_scan(self.gate, "not-a-real-token")
        self.assertEqual(status, 400)
        self.assertEqual(body["result"], "invalid_qr")
        self.assertEqual(OutpassGateScan.objects.filter(gate=self.gate).count(), 1)

    def test_wrong_role_token_is_invalid(self):
        # A valid, correctly-signed JWT -but not one meant to be a pass (e.g.
        # a stray employee/HR token) must not be accepted as one.
        qr = sign_token({"role": "employee", "employeeId": self.emp.id})
        body, status = resolve_gate_scan(self.gate, qr)
        self.assertEqual(status, 400)
        self.assertEqual(body["result"], "invalid_qr")

    def test_missing_request_is_invalid(self):
        qr = sign_token({"role": "outpass_pass", "requestId": 999999})
        body, status = resolve_gate_scan(self.gate, qr)
        self.assertEqual(status, 404)
        self.assertEqual(body["result"], "invalid_qr")


class GateDeviceRevocationTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="gate1",
            password_hash="x", login_token="tok1",
        )

    def test_require_gate_device_rejects_deactivated_gate(self):
        token = sign_token({"role": "gate_device", "deviceId": self.gate.id, "gateName": self.gate.name})
        self.gate.is_active = False
        self.gate.save(update_fields=["is_active"])

        seen = {}

        @require_gate_device
        def view(request):
            seen["called"] = True
            return "ok"

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        result = view(FakeRequest())
        self.assertNotIn("called", seen)
        self.assertEqual(result.status_code, 403)

    def test_require_gate_device_accepts_active_gate(self):
        token = sign_token({"role": "gate_device", "deviceId": self.gate.id, "gateName": self.gate.name})

        @require_gate_device
        def view(request):
            return request.gate_device.name

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        self.assertEqual(view(FakeRequest()), "Gate 1")
