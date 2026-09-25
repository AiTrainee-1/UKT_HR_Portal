"""WhatsApp messages for approval decisions across every HRMS workflow. WAClient is always mocked."""

from datetime import date, time
from unittest import mock

from django.test import TestCase, override_settings

from . import whatsapp_approvals, whatsapp_catalog as catalog, whatsapp_service
from .jwt_utils import sign_token
from .missing_punch_views import resolve_missing_punch_hod
from .models import (
    Advance,
    CasualLeaveRequest,
    DepartmentManager,
    Employee,
    EmployeePermission,
    EmployeeRequest,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    OutpassRequest,
    ResignationRequest,
    WhatsAppMessageLog,
    WhatsAppMessageTemplate,
    WhatsAppSettings,
)

CONFIG = dict(
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    EMPLOYEE_PORTAL_URL="https://portal.test",
    WHATSAPP_LINK_PREVIEW=True,
)
THU = date(2026, 9, 24)


def _ok(msg_id="WAID"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": msg_id}}}
    return r


def _error(text="Instance not connected"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "error", "message": text}
    return r


@override_settings(**CONFIG)
class ApprovalBase(TestCase):
    def setUp(self):
        hr = HRUser.objects.create(username="wa_hr", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': hr.id, 'name': 'Meena'})}"}
        self.emp = Employee.objects.create(
            employee_code="E1", first_name="Asha", last_name="Kumar", phone="8220015110", status="active"
        )
        patcher = mock.patch("api.whatsapp_service.requests.post", return_value=_ok())
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, method, path, body):
        return getattr(self.client, method)(path, body, content_type="application/json", **self.hr)

    def payloads(self):
        return [c.kwargs["json"] for c in self.post.call_args_list]

    def texts(self):
        return [p["message"] for p in self.payloads()]

    def one(self, doc_type):
        return WhatsAppMessageLog.objects.get(document_type=doc_type)


class EveryWorkflowTests(ApprovalBase):
    """Each approval workflow tells the employee, on WhatsApp, what was decided."""

    def check_approved(self, module, text, *expected):
        for piece in ("✅", "Request Approved", "Hello Asha Kumar", "Approved by: Meena (HR)", *expected):
            self.assertIn(piece, text)
        log = self.one("approval_approved")
        self.assertEqual((log.related_module, log.status, log.employee_id), (module, "sent", self.emp.id))
        self.assertEqual(self.payloads()[0]["number"], "918220015110")

    def check_rejected(self, module, text, *expected):
        for piece in ("❌", "Request Rejected", "Hello Asha Kumar", "Rejected by: Meena (HR)", *expected):
            self.assertIn(piece, text)
        self.assertEqual(self.one("approval_rejected").related_module, module)

    def test_leave_approved_and_rejected(self):
        leave = LeaveRequest.objects.create(
            employee=self.emp, type="sick", start_date="2026-09-26", end_date="2026-09-27", total_days=2, reason="Fever"
        )
        r = self.call(
            "patch", f"/api/leave-requests/{leave.id}/status", {"status": "approved", "hrComment": "Get well soon"}
        )
        self.assertEqual(r.status_code, 200)
        self.check_approved(
            "leave",
            self.texts()[0],
            "*Leave*",
            "26 Sep 2026 to 27 Sep 2026",
            "Sick (2 days)",
            "Fever",
            "Get well soon",
            "https://portal.test/employee/leave",
        )
        self.assertEqual(self.payloads()[0]["type"], "link")
        self.assertEqual(self.payloads()[0]["url"], "https://portal.test/employee/leave")
        # HR changes their mind: the employee is told about that too.
        self.call(
            "patch", f"/api/leave-requests/{leave.id}/status", {"status": "rejected", "hrComment": "Clash with audit"}
        )
        self.check_rejected("leave", self.texts()[1], "*Leave*", "Reason: Clash with audit")

    def test_permission(self):
        perm = EmployeePermission.objects.create(
            employee=self.emp,
            date=THU,
            permission_time=time(10, 30),
            type="Early Out",
            duration_minutes=30,
            reason="Doctor",
        )
        self.call("put", f"/api/permissions/{perm.id}", {"status": "rejected", "hrComment": "Too many this month"})
        self.check_rejected(
            "permission",
            self.texts()[0],
            "*Permission*",
            "24 Sep 2026",
            "10:30 AM",
            "Early Out - 30 min - Doctor",
            "Too many this month",
        )

    def test_casual_leave(self):
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, reason="Family function")
        with mock.patch("api.casual_leave_views._write_attendance_for_cl"):
            self.call("patch", f"/api/casual-leaves/{cl.id}", {"status": "approved", "comment": "Enjoy"})
        self.check_approved(
            "casual_leave", self.texts()[0], "*Casual Leave*", "24 Sep 2026", "Family function", "Enjoy"
        )

    def test_outpass_request_says_what_happens_next_when_approved(self):
        req = OutpassRequest.objects.create(
            employee=self.emp, destination="Bank", reason="Deposit cheque", pass_type="official"
        )
        self.call("put", f"/api/outpass-requests/{req.id}/hr-status", {"status": "approved"})
        self.check_approved(
            "outpass",
            self.texts()[0],
            "*Gate Outpass*",
            "Official / Mill Duty",
            "Bank",
            "Deposit cheque",
            "Show your pass QR at the gate within 60 minutes",
        )

    def test_missing_punch_final_hr_decision(self):
        req = MissingPunchRequest.objects.create(
            employee=self.emp,
            date=THU,
            punch_time=time(9, 5),
            punch_type="IN",
            punch_slot="morning_in",
            reason="Machine was down",
            status=MissingPunchRequest.STATUS_PENDING_HR,
        )
        self.call("patch", f"/api/missing-punch-requests/{req.id}/status", {"status": "approved", "comment": "Added"})
        self.check_approved(
            "missing_punch",
            self.texts()[0],
            "*Missing Punch*",
            "24 Sep 2026",
            "9:05 AM",
            "Morning Check-In",
            "Machine was down",
        )

    def test_resignation(self):
        r = ResignationRequest.objects.create(
            employee=self.emp, reason="Better offer", last_working_date=date(2026, 10, 31), status="dept_approved"
        )
        self.call(
            "patch", f"/api/recruitment/resignations/{r.id}/action", {"action": "approve", "hrComment": "Best wishes"}
        )
        self.check_approved(
            "resignation", self.texts()[0], "*Resignation*", "Last working day: 31 Oct 2026", "Best wishes"
        )

    def test_advance(self):
        adv = Advance.objects.create(employee=self.emp, advance_type="general", amount=5000, purpose="Medical")
        self.call("put", f"/api/advances/{adv.id}", {"status": "approved", "approvedBy": "Meena"})
        self.check_approved("advance", self.texts()[0], "*Advance*", "General Advance - Rs 5,000.00 - Medical")

    def test_advance_rejection(self):
        adv = Advance.objects.create(employee=self.emp, advance_type="term", amount=20000, purpose="House")
        self.call("put", f"/api/advances/{adv.id}", {"status": "rejected", "notes": "Over the limit"})
        self.check_rejected("advance", self.texts()[0], "Term Advance (Loan)", "Over the limit")

    def test_other_employee_requests(self):
        er = EmployeeRequest.objects.create(
            employee=self.emp, request_type="salary_enquiry", subject="Deduction query", description="Why?"
        )
        self.call(
            "put", f"/api/employee-requests/{er.id}/action", {"status": "approved", "hrNotes": "Explained by phone"}
        )
        self.check_approved("request", self.texts()[0], "*Salary Enquiry*", "Deduction query", "Explained by phone")

    def test_a_status_that_is_neither_approved_nor_rejected_sends_nothing(self):
        er = EmployeeRequest.objects.create(employee=self.emp, request_type="general", subject="Hi", description="x")
        self.call("put", f"/api/employee-requests/{er.id}/action", {"status": "in_review"})
        self.post.assert_not_called()

    def test_every_workflow_in_the_catalog_has_a_builder_and_vice_versa(self):
        self.assertEqual(set(whatsapp_approvals._BUILDERS), set(catalog.APPROVAL_MODULES))


class DepartmentHeadDecisionTests(ApprovalBase):
    """A Department Head deciding on a team member's request."""

    def setUp(self):
        super().setUp()
        self.hod = Employee.objects.create(
            employee_code="H1", first_name="Suresh", last_name="Raj", phone="9000000009", status="active"
        )
        manager = DepartmentManager.objects.create(employee=self.hod)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.emp)
        token = sign_token({"role": "employee", "employeeId": self.hod.id, "name": "Suresh Raj"})
        self.hod_auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def hod_patch(self, path, body):
        return self.client.patch(path, body, content_type="application/json", **self.hod_auth)

    def test_leave_decided_by_the_department_head_names_them(self):
        leave = LeaveRequest.objects.create(
            employee=self.emp, type="casual", start_date="2026-09-25", end_date="2026-09-25", total_days=1
        )
        r = self.hod_patch(f"/api/manager/leave-requests/{leave.id}/status", {"status": "approved", "comment": "Fine"})
        self.assertEqual(r.status_code, 200)
        text = self.texts()[0]
        self.assertIn("Approved by: Suresh Raj (Department Head)", text)
        self.assertIn("Fine", text)

    def test_permission_rejected_by_the_department_head(self):
        perm = EmployeePermission.objects.create(employee=self.emp, date=THU, reason="Errand")
        self.hod_patch(f"/api/manager/permissions/{perm.id}/status", {"status": "rejected", "comment": "Busy day"})
        text = self.texts()[0]
        self.assertIn("Rejected by: Suresh Raj (Department Head)", text)
        self.assertIn("Busy day", text)

    def test_missing_punch_hod_approval_is_only_a_hand_over_but_a_rejection_is_final(self):
        req = MissingPunchRequest.objects.create(
            employee=self.emp, date=THU, punch_time=time(9, 5), punch_type="IN", reason="Forgot"
        )
        resolve_missing_punch_hod(req, "approved", "Suresh Raj", None)
        self.post.assert_not_called()  # HR still has to decide
        req2 = MissingPunchRequest.objects.create(
            employee=self.emp, date=date(2026, 9, 25), punch_time=time(9, 5), punch_type="IN", reason="Forgot"
        )
        resolve_missing_punch_hod(req2, "rejected", "Suresh Raj", "Not credible")
        self.assertIn("Rejected by: Suresh Raj (Department Head)", self.texts()[0])
        self.assertIn("Not credible", self.texts()[0])

    def test_resignation_hod_approval_waits_for_hr_but_rejection_is_sent(self):
        r = ResignationRequest.objects.create(employee=self.emp, reason="Moving", status="pending")
        self.client.patch(
            f"/api/manager/resignations/{r.id}/action",
            {"action": "approve"},
            content_type="application/json",
            **self.hod_auth,
        )
        self.post.assert_not_called()
        r2 = ResignationRequest.objects.create(employee=self.emp, reason="Moving", status="pending")
        self.client.patch(
            f"/api/manager/resignations/{r2.id}/action",
            {"action": "reject", "comment": "Let's talk first"},
            content_type="application/json",
            **self.hod_auth,
        )
        self.assertIn("Let's talk first", self.texts()[0])


class SwitchesAndSafetyTests(ApprovalBase):
    def leave(self):
        return LeaveRequest.objects.create(
            employee=self.emp, type="casual", start_date="2026-09-25", end_date="2026-09-25", total_days=1
        )

    def approve(self, leave):
        return self.call("patch", f"/api/leave-requests/{leave.id}/status", {"status": "approved"})

    def test_the_approval_master_switch_turns_every_workflow_off(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"approval_notifications_enabled": False})
        self.assertEqual(self.approve(self.leave()).status_code, 200)
        self.post.assert_not_called()
        self.assertFalse(WhatsAppMessageLog.objects.exists())

    def test_one_workflow_can_be_switched_off_without_touching_the_others(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"disabled_approval_modules": ["leave"]})
        self.approve(self.leave())
        self.post.assert_not_called()
        perm = EmployeePermission.objects.create(employee=self.emp, date=THU)
        self.call("put", f"/api/permissions/{perm.id}", {"status": "approved"})
        self.assertEqual(len(self.texts()), 1)
        self.assertEqual(self.one("approval_approved").related_module, "permission")

    def test_each_wording_can_be_switched_off_or_reworded(self):
        WhatsAppMessageTemplate.objects.create(
            document_type="approval_approved", message_body="Hi {{employee_name}}: {{request_type}} OK"
        )
        self.approve(self.leave())
        self.assertEqual(self.texts(), ["Hi Asha Kumar: Leave OK"])
        WhatsAppMessageTemplate.objects.filter(document_type="approval_approved").update(is_enabled=False)
        self.approve(self.leave())
        self.assertEqual(len(self.texts()), 1)

    def test_the_same_decision_is_announced_once(self):
        leave = self.leave()
        self.approve(leave)
        self.approve(leave)  # e.g. a double click, or HR saving the card again
        self.assertEqual(len(self.texts()), 1)
        self.assertEqual(self.one("approval_approved").dedupe_key, f"approval:leave:{leave.id}:approved")

    def test_without_a_portal_address_there_is_no_link_and_it_is_plain_text(self):
        with override_settings(EMPLOYEE_PORTAL_URL=""):
            self.approve(self.leave())
        self.assertEqual(self.payloads()[0]["type"], "text")
        self.assertNotIn("View request", self.texts()[0])

    def test_a_refused_link_message_is_sent_as_plain_text_instead(self):
        self.post.side_effect = [_error("link type not supported"), _ok("WA2")]
        self.approve(self.leave())
        self.assertEqual([p["type"] for p in self.payloads()], ["link", "text"])
        self.assertEqual(self.one("approval_approved").provider_message_id, "WA2")

    def test_a_whatsapp_outage_is_logged_and_the_approval_still_happens(self):
        self.post.return_value = _error("Instance not connected")
        leave = self.leave()
        self.assertEqual(self.approve(leave).status_code, 200)
        leave.refresh_from_db()
        self.assertEqual(leave.status, "approved")
        log = self.one("approval_approved")
        self.assertEqual(log.status, "failed")
        self.assertIn("Instance not connected", log.error_message)

    def test_a_crash_in_the_messaging_code_never_breaks_the_approval(self):
        leave = self.leave()
        with mock.patch("api.whatsapp_service.send_notification", side_effect=RuntimeError("boom")):
            self.assertEqual(self.approve(leave).status_code, 200)
        leave.refresh_from_db()
        self.assertEqual(leave.status, "approved")

    def test_an_employee_with_no_phone_gets_a_failed_row_and_the_approval_still_happens(self):
        Employee.objects.filter(pk=self.emp.pk).update(phone="")
        leave = self.leave()
        self.assertEqual(self.approve(leave).status_code, 200)
        self.assertIn("No phone number", self.one("approval_approved").error_message)
        self.post.assert_not_called()

    @override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN="")
    def test_nothing_is_attempted_when_whatsapp_is_not_configured(self):
        self.assertEqual(self.approve(self.leave()).status_code, 200)
        self.assertFalse(WhatsAppMessageLog.objects.exists())


class BackgroundDeliveryTests(ApprovalBase):
    """System messages are handed to a background worker so nobody waits on WhatsApp."""

    def emp_leave(self):
        return LeaveRequest.objects.create(
            employee=self.emp, type="casual", start_date="2026-09-25", end_date="2026-09-25", total_days=1
        )

    @override_settings(WHATSAPP_ASYNC_SEND=True)
    def test_the_caller_gets_a_pending_row_at_once_and_the_send_happens_later(self):
        with mock.patch("api.whatsapp_service._run_in_background") as background:
            log = whatsapp_approvals.notify_decision("leave", self.emp_leave(), "approved", approver="Meena", role="hr")
        self.assertEqual(log.status, "pending")
        self.post.assert_not_called()
        background.call_args.args[0]()  # the worker runs the job
        log.refresh_from_db()
        self.assertEqual((log.status, log.provider_message_id), ("sent", "WAID"))

    @override_settings(WHATSAPP_ASYNC_SEND=True)
    def test_codes_and_the_alert_job_ask_for_immediate_delivery(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"absent_alert_enabled": True})
        with mock.patch("api.whatsapp_service._run_in_background") as background:
            log = whatsapp_service.send_notification(self.emp, "absent_alert", ["A", "d", "t"], asynchronous=False)
        background.assert_not_called()
        self.assertEqual(log.status, "sent")

    @override_settings(WHATSAPP_ASYNC_SEND=True)
    def test_the_worker_runs_after_commit_and_a_broken_job_cannot_kill_it(self):
        ran = []

        class Inline:
            def submit(self, fn):
                fn()

        with (
            mock.patch("api.whatsapp_service._executor", Inline()),
            mock.patch("api.whatsapp_service.connections"),
            self.captureOnCommitCallbacks(execute=True),
        ):
            whatsapp_service._run_in_background(lambda: ran.append("ok"))
            whatsapp_service._run_in_background(lambda: 1 / 0)
            whatsapp_service._run_in_background(lambda: ran.append("still running"))
        self.assertEqual(ran, ["ok", "still running"])

    def test_a_message_left_pending_by_a_restart_is_marked_failed(self):
        from datetime import timedelta

        from django.utils import timezone

        old = WhatsAppMessageLog.objects.create(
            employee=self.emp, document_type="approval_approved", phone_number="x", status="pending"
        )
        fresh = WhatsAppMessageLog.objects.create(
            employee=self.emp, document_type="approval_approved", phone_number="x", status="pending"
        )
        WhatsAppMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(minutes=30))
        self.assertEqual(whatsapp_service.expire_stale_pending(), 1)
        old.refresh_from_db()
        fresh.refresh_from_db()
        self.assertEqual(old.status, "failed")
        self.assertIn("never sent", old.error_message)
        self.assertEqual(fresh.status, "pending")


class ApproverLabelTests(TestCase):
    def test_who_decided_reads_naturally(self):
        label = whatsapp_approvals.approver_label
        self.assertEqual(label("Meena", "hr"), "Meena (HR)")
        self.assertEqual(label("Suresh Raj", "dept_head"), "Suresh Raj (Department Head)")
        self.assertEqual(label("HR Manager", "hr"), "HR Manager")  # already says HR
        self.assertEqual(label("", "hr"), "HR")
        self.assertEqual(label("Meena", ""), "Meena")
