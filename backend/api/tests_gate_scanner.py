"""
Gate Scanner -verifies the QR-verification/exit-recording decision
(resolve_gate_scan) against every state an approved Outpass can be in, and
that the GateDevice revocation switch (is_active) actually blocks a device.

Run via: python manage.py test api.tests_gate_scanner -v 2
"""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIRequestFactory

from .auth import require_gate_device
from .gate_credentials import gate_token, new_gate_session
from .gate_scanner_views import gate_scan_log, resolve_gate_scan
from .jwt_utils import sign_token
from .models import Branch, Employee, GateDevice, OutpassGateScan, OutpassRequest


class _Req:
    META = {"HTTP_USER_AGENT": "test", "REMOTE_ADDR": "10.0.0.1"}


def _session_token(gate) -> str:
    """A gate monitor token with its own session (a token without gsid is refused since 19 Nov 2026)."""
    return gate_token(gate, new_gate_session(gate, _Req()))


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


def _return_qr_for(req: OutpassRequest, expires_in: timedelta = timedelta(minutes=60)) -> str:
    return sign_token(
        {"role": "outpass_return", "requestId": req.id, "generatedAt": req.return_qr_generated_at.isoformat()},
        expires_in=expires_in,
    )


class ResolveGateScanReturnTests(TestCase):
    """The return/re-entry leg -resolve_gate_scan branching on the
    "outpass_return" token role. Mirrors ResolveGateScanTests above but for
    entry_gate/entered_at instead of exit_gate/exited_at."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="ret_gate1",
            password_hash="x", login_token="rtok1",
        )
        self.other_gate = GateDevice.objects.create(
            name="Gate 2", branch=self.branch, username="ret_gate2",
            password_hash="x", login_token="rtok2",
        )
        self.emp = Employee.objects.create(
            employee_code="GATETEST_RET1", first_name="Return", last_name="Tester",
            employment_type="staff", status="active",
        )

    def _exited_request(self, **overrides):
        defaults = dict(
            employee=self.emp, destination="Bank", reason="Cash withdrawal",
            status=OutpassRequest.STATUS_APPROVED, approved_at=timezone.now(),
            approver_role="hr", approved_by="HR Person",
            exit_gate=self.gate, exited_at=timezone.now(),
            return_qr_generated_at=timezone.now(),
        )
        defaults.update(overrides)
        return OutpassRequest.objects.create(**defaults)

    def test_valid_return_scan_records_entry_and_logs_success(self):
        req = self._exited_request()
        body, status = resolve_gate_scan(self.gate, _return_qr_for(req))

        self.assertEqual(status, 200)
        self.assertEqual(body["result"], "success")
        self.assertEqual(body["scanType"], "entry")

        req.refresh_from_db()
        self.assertIsNotNone(req.entered_at)
        self.assertEqual(req.entry_gate_id, self.gate.id)
        scan = OutpassGateScan.objects.get(outpass_request=req, scan_type=OutpassGateScan.SCAN_TYPE_ENTRY)
        self.assertEqual(scan.result, OutpassGateScan.RESULT_SUCCESS)

        # The original exit fields must be untouched by the return scan.
        self.assertEqual(req.exit_gate_id, self.gate.id)
        self.assertIsNotNone(req.exited_at)

    def test_return_scan_before_exit_is_denied_as_not_exited(self):
        req = OutpassRequest.objects.create(
            employee=self.emp, destination="Bank", reason="Cash withdrawal",
            status=OutpassRequest.STATUS_APPROVED, approved_at=timezone.now(),
            approver_role="hr", approved_by="HR Person",
            return_qr_generated_at=timezone.now(),
        )
        body, status = resolve_gate_scan(self.gate, _return_qr_for(req))
        self.assertEqual(status, 403)
        self.assertEqual(body["result"], "not_exited")
        self.assertIsNone(req.entered_at)

    def test_second_return_scan_is_denied_as_already_scanned(self):
        req = self._exited_request()
        qr = _return_qr_for(req)
        resolve_gate_scan(self.gate, qr)

        body, status = resolve_gate_scan(self.other_gate, qr)
        self.assertEqual(status, 409)
        self.assertEqual(body["result"], "already_scanned")
        self.assertIn("Gate 1", body["message"])

        req.refresh_from_db()
        self.assertEqual(req.entry_gate_id, self.gate.id)

    def test_stale_return_qr_after_regeneration_is_rejected(self):
        req = self._exited_request()
        old_qr = _return_qr_for(req)

        # Employee re-clicks "Generate Return QR" -this bumps the live
        # timestamp, so the previously issued token's embedded claim no
        # longer matches even though it's still a validly signed, unexpired JWT.
        req.return_qr_generated_at = timezone.now() + timedelta(seconds=5)
        req.save(update_fields=["return_qr_generated_at"])

        body, status = resolve_gate_scan(self.gate, old_qr)
        self.assertEqual(status, 400)
        self.assertEqual(body["result"], "invalid_qr")
        req.refresh_from_db()
        self.assertIsNone(req.entered_at)

    def test_exit_qr_and_return_qr_are_independent_token_roles(self):
        # A stray exit-role token must not be accepted as a return scan, and
        # vice versa -resolve_gate_scan must route on the role claim, not
        # just decode-and-trust the requestId.
        req = self._exited_request()
        exit_qr = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=60))
        body, status = resolve_gate_scan(self.gate, exit_qr)
        # exit-role token against an already-exited request -treated as an
        # exit attempt, correctly denied as already_scanned (not "success").
        self.assertEqual(status, 409)
        self.assertEqual(body["result"], "already_scanned")


class GateScanLogExitOnlyTests(TestCase):
    """Today's Gate-Out Report (gate_scan_log) must stay exit-only -a
    successful RETURN scan logs its own OutpassGateScan row too (scan_type=
    "entry"), and without filtering on scan_type it would leak into this
    report and look like a second, mislabelled exit for the same employee."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="log_gate1",
            password_hash="x", login_token="ltok1",
        )
        self.emp = Employee.objects.create(
            employee_code="GATETEST_LOG1", first_name="Log", last_name="Tester",
            employment_type="staff", status="active",
        )

    def test_return_scan_success_does_not_appear_in_exit_log(self):
        req = OutpassRequest.objects.create(
            employee=self.emp, destination="Bank", reason="Cash withdrawal",
            status=OutpassRequest.STATUS_APPROVED, approved_at=timezone.now(),
            approver_role="hr", approved_by="HR Person",
            exit_gate=self.gate, exited_at=timezone.now(),
            return_qr_generated_at=timezone.now(),
        )
        resolve_gate_scan(self.gate, _return_qr_for(req))
        req.refresh_from_db()
        self.assertIsNotNone(req.entered_at)

        token = _session_token(self.gate)
        request = APIRequestFactory().get("/api/gate-devices/scan-log", HTTP_AUTHORIZATION=f"Bearer {token}")

        response = gate_scan_log(request)
        self.assertEqual(response.data["total"], 0)
        self.assertEqual(response.data["items"], [])


class GateDeviceRevocationTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="gate1",
            password_hash="x", login_token="tok1",
        )

    def test_require_gate_device_rejects_deactivated_gate(self):
        token = _session_token(self.gate)
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
        token = _session_token(self.gate)

        @require_gate_device
        def view(request):
            return request.gate_device.name

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        self.assertEqual(view(FakeRequest()), "Gate 1")


class RefusedTeaAndIndiaTimeTests(TestCase):
    """C1 / C3 (19 Nov 2026): a refused tea-break code is logged as a "tea" scan; the already-scanned text is in India
    time."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Scan Fix Unit")
        self.gate = GateDevice.objects.create(
            name="Fix Gate", branch=self.branch, username="fix_gate", password_hash="x", login_token="fix-tok"
        )
        self.emp = Employee.objects.create(
            employee_code="SFX1", first_name="Mani", last_name="K", status="active", employment_type="staff",
            branch=self.branch,
        )

    def test_a_refused_tea_break_code_is_a_tea_scan_not_an_exit(self):
        self.gate.allow_tea_break = False
        self.gate.save(update_fields=["allow_tea_break"])
        token = sign_token({"role": "tea_break", "employeeId": self.emp.id})
        body, status = resolve_gate_scan(self.gate, token)
        self.assertEqual((status, body["result"], body["kind"]), (403, "not_allowed_here", "tea_break"))
        row = OutpassGateScan.objects.get()
        self.assertEqual((row.scan_type, row.result), ("tea", "not_allowed_here"))
        self.assertEqual(row.get_scan_type_display(), "Tea break")
        # an unreadable code keeps the type it always had
        resolve_gate_scan(self.gate, "not-a-code")
        self.assertEqual(OutpassGateScan.objects.get(result="invalid_qr").scan_type, "exit")

    def test_already_exited_says_the_india_time(self):
        from datetime import datetime
        from datetime import timezone as dt_timezone

        exited = datetime(2026, 11, 18, 10, 15, tzinfo=dt_timezone.utc)  # 15:45 in India
        req = OutpassRequest.objects.create(
            employee=self.emp, destination="Bank", reason="cash", status=OutpassRequest.STATUS_APPROVED,
            approved_at=exited, approver_role="hr", approved_by="HR", exit_gate=self.gate, exited_at=exited,
        )
        body, status = resolve_gate_scan(self.gate, _qr_for(req))
        self.assertEqual(status, 409)
        self.assertEqual(body["message"], "Already exited at 03:45 PM via Fix Gate")
        self.assertEqual(OutpassGateScan.objects.get().message, "Already exited at 03:45 PM via Fix Gate")
