"""
Outpass Approval System -verifies the new single-stage "either HOD or HR"
resolution helper, its OutpassRecord side-effect (the actual integration
point with the existing gate-facing Outpass page), and the On-Duty auto-
generation hook that must only fire on final On-Duty approval, never at
submission or at the HOD stage.

Run via: python manage.py test api.tests_outpass_requests -v 2
"""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from .models import Branch, Employee, GateDevice, Notification, OnDutySession, OutpassRecord, OutpassRequest
from .outpass_request_views import _outpass_request_json, _outpass_scan_status, resolve_outpass_request
from .geo_attendance_views import (
    _create_outpass_from_on_duty, resolve_on_duty_session_hod, resolve_on_duty_session_hr,
)


class OutpassRequestResolutionTests(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(
            employee_code="OPTEST_EMP1", first_name="Outpass", last_name="Tester",
            employment_type="staff", status="active",
        )

    def test_hr_approval_creates_outpass_record(self):
        req = OutpassRequest.objects.create(employee=self.emp, destination="Bank", reason="Cash withdrawal")
        resolve_outpass_request(req, "approved", "HR Person", "hr", None)

        req.refresh_from_db()
        self.assertEqual(req.status, "approved")
        self.assertEqual(req.approver_role, "hr")
        self.assertIsNotNone(req.approved_at)
        self.assertIsNotNone(req.outpass_record_id)

        record = OutpassRecord.objects.get(pk=req.outpass_record_id)
        self.assertEqual(record.employee_id, self.emp.id)
        self.assertEqual(record.destination, "Bank")
        self.assertEqual(record.source, "request")

        note = Notification.objects.filter(employee=self.emp, type="outpass").latest("created_at")
        self.assertIn("Approved", note.message)

    def test_hod_approval_also_creates_outpass_record(self):
        req = OutpassRequest.objects.create(employee=self.emp, destination="Post Office", reason="Courier")
        resolve_outpass_request(req, "approved", "Dept Head", "dept_head", "Go ahead")

        req.refresh_from_db()
        self.assertEqual(req.status, "approved")
        self.assertEqual(req.approver_role, "dept_head")
        self.assertEqual(req.review_comment, "Go ahead")
        self.assertTrue(OutpassRecord.objects.filter(pk=req.outpass_record_id).exists())

    def test_rejection_creates_no_outpass_record(self):
        req = OutpassRequest.objects.create(employee=self.emp, destination="Market", reason="Personal errand")
        resolve_outpass_request(req, "rejected", "HR Person", "hr", None)

        req.refresh_from_db()
        self.assertEqual(req.status, "rejected")
        self.assertIsNone(req.approved_at)
        self.assertIsNone(req.outpass_record_id)
        self.assertEqual(OutpassRecord.objects.filter(employee=self.emp).count(), 0)

        note = Notification.objects.filter(employee=self.emp, type="outpass").latest("created_at")
        self.assertIn("Not Approved", note.message)


class OnDutyOutpassHookTests(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(
            employee_code="OPTEST_EMP2", first_name="OnDuty", last_name="Tester",
            employment_type="staff", status="active",
        )
        self.session = OnDutySession.objects.create(employee=self.emp, destination="Client site visit")

    def test_hod_stage_alone_does_not_generate_outpass(self):
        resolve_on_duty_session_hod(self.session, "approved", "Dept Head", None)
        self.assertEqual(OutpassRequest.objects.filter(employee=self.emp).count(), 0)

    def test_hr_final_approval_generates_approved_outpass(self):
        resolve_on_duty_session_hod(self.session, "approved", "Dept Head", None)
        self.session.refresh_from_db()
        resolve_on_duty_session_hr(self.session, "approved", "HR Person", None)

        req = OutpassRequest.objects.get(employee=self.emp, source=OutpassRequest.SOURCE_ON_DUTY)
        self.assertEqual(req.status, "approved")
        self.assertEqual(req.destination, "Client site visit")
        self.assertEqual(req.approver_role, "system")
        self.assertIsNotNone(req.outpass_record_id)
        record = OutpassRecord.objects.get(pk=req.outpass_record_id)
        self.assertEqual(record.destination, "Client site visit")
        self.assertEqual(record.source, "request")

    def test_hr_rejection_generates_no_outpass(self):
        resolve_on_duty_session_hr(self.session, "rejected", "HR Person", None)
        self.assertEqual(OutpassRequest.objects.filter(employee=self.emp).count(), 0)

    def test_direct_helper_is_idempotent_free_of_side_effects_on_session(self):
        """_create_outpass_from_on_duty must never touch the On-Duty session's
        own fields -it only ever adds new, separate rows."""
        before = (self.session.status, self.session.destination)
        _create_outpass_from_on_duty(self.session, "HR Person")
        self.session.refresh_from_db()
        self.assertEqual((self.session.status, self.session.destination), before)


class ReturnQrScanStatusAndSerializerTests(TestCase):
    """The return/in-time leg's read-side: _outpass_scan_status's new states
    and _outpass_request_json's returnQrToken/entered fields. The write side
    (resolve_gate_scan's "outpass_return" branch) is covered in
    tests_gate_scanner.py::ResolveGateScanReturnTests."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="serializer_gate1",
            password_hash="x", login_token="stok1",
        )
        self.emp = Employee.objects.create(
            employee_code="OPTEST_RET1", first_name="Return", last_name="Serializer",
            employment_type="staff", status="active",
        )

    def _base(self, **overrides):
        defaults = dict(
            employee=self.emp, destination="Bank", reason="Cash withdrawal",
            status=OutpassRequest.STATUS_APPROVED, approved_at=timezone.now(),
            approver_role="hr", approved_by="HR Person",
        )
        defaults.update(overrides)
        return OutpassRequest.objects.create(**defaults)

    def test_exited_without_return_qr_is_status_exited_with_no_return_token(self):
        req = self._base(exit_gate=self.gate, exited_at=timezone.now())
        data = _outpass_request_json(req)
        self.assertEqual(data["scanStatus"], "exited")
        self.assertIsNone(data["returnQrToken"])
        self.assertTrue(data["canGenerateReturnQr"])
        self.assertIsNone(data["qrToken"])  # exit QR must not reappear post-exit

    def test_generated_return_qr_is_pending_return_with_a_token(self):
        req = self._base(exit_gate=self.gate, exited_at=timezone.now(), return_qr_generated_at=timezone.now())
        data = _outpass_request_json(req)
        self.assertEqual(data["scanStatus"], "pending_return")
        self.assertIsNotNone(data["returnQrToken"])
        self.assertTrue(data["canGenerateReturnQr"])

    def test_expired_return_qr_is_return_expired_with_no_token(self):
        req = self._base(
            exit_gate=self.gate, exited_at=timezone.now() - timedelta(minutes=90),
            return_qr_generated_at=timezone.now() - timedelta(minutes=90),
        )
        data = _outpass_request_json(req)
        self.assertEqual(data["scanStatus"], "return_expired")
        self.assertIsNone(data["returnQrToken"])
        self.assertTrue(data["canGenerateReturnQr"])  # re-generating is allowed

    def test_returned_is_completed_with_no_qr_and_cannot_regenerate(self):
        req = self._base(
            exit_gate=self.gate, exited_at=timezone.now() - timedelta(minutes=30),
            entry_gate=self.gate, entered_at=timezone.now(),
        )
        data = _outpass_request_json(req)
        self.assertEqual(data["scanStatus"], "completed")
        self.assertIsNone(data["returnQrToken"])
        self.assertFalse(data["canGenerateReturnQr"])
        self.assertIsNotNone(data["enteredAt"])
        self.assertEqual(data["entryGateName"], "Gate 1")

    def test_not_yet_exited_cannot_generate_return_qr(self):
        req = self._base()
        data = _outpass_request_json(req)
        self.assertEqual(data["scanStatus"], "pending_exit")
        self.assertFalse(data["canGenerateReturnQr"])
        self.assertIsNotNone(data["qrToken"])
