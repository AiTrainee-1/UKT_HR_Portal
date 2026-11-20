"""WhatsApp messages for gate movement (Outpass IN / OUT) and visitors. Meta's Graph API is always faked (FakeMeta):
each goes out as its approved template (hrms_gate_out, hrms_gate_in, hrms_visitor_at_reception)."""

from datetime import timedelta
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIRequestFactory

from .gate_scanner_views import resolve_gate_scan
from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    Employee,
    GateDevice,
    GateQRCode,
    OutpassRecord,
    OutpassRequest,
    VisitorVisit,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .outpass_visitor_views import outpass_gate_submit, visitor_gate_new
from .tests_whatsapp_caller_support import assert_template_variables, sent_texts
from .tests_whatsapp_support import META, FakeMeta, approve_templates


class WhatsAppBase(TestCase):
    def start_meta(self):
        self.meta = FakeMeta.install(self)  # Meta's Graph API, faked: nothing leaves the machine
        approve_templates("outpass_gate_out", "outpass_gate_in", "visitor_notification")

    def texts(self):
        return sent_texts(self.meta)

    def assert_texts_are_plain(self):
        """Every message that went out is an approved template with its variables only: no free text, no preview card,
        no address, no portal link, every variable on one line."""
        self.assertTrue(self.meta.sent)
        for record in self.meta.sent:
            self.assertEqual(record["body"]["type"], "template")
            self.assertNotIn("text", record["body"])
            assert_template_variables(self, record)
        for text in self.texts():
            for banned in ("http", "portal", "View request", "🔗"):
                self.assertNotIn(banned, text)


@override_settings(**META)
class GateMovementTests(WhatsAppBase):
    def setUp(self):
        self.start_meta()
        self.branch = Branch.objects.create(name="Main Unit")
        self.gate = GateDevice.objects.create(
            name="Gate 1", branch=self.branch, username="g1", password_hash="x", login_token="t1"
        )
        self.gate2 = GateDevice.objects.create(
            name="Gate 2", branch=self.branch, username="g2", password_hash="x", login_token="t2"
        )
        self.emp = Employee.objects.create(
            employee_code="GE1",
            first_name="Asha",
            last_name="Kumar",
            phone="8220015110",
            status="active",
            branch=self.branch,
        )
        self.req = OutpassRequest.objects.create(
            employee=self.emp,
            destination="Bank",
            reason="Deposit cheque",
            pass_type="official",
            status=OutpassRequest.STATUS_APPROVED,
            approved_at=timezone.now(),
            approver_role="hr",
            approved_by="Meena",
        )

    def exit_qr(self):
        return sign_token({"role": "outpass_pass", "requestId": self.req.id}, expires_in=timedelta(minutes=60))

    def return_qr(self):
        self.req.refresh_from_db()
        self.req.return_qr_generated_at = timezone.now()
        self.req.save(update_fields=["return_qr_generated_at"])
        return sign_token(
            {
                "role": "outpass_return",
                "requestId": self.req.id,
                "generatedAt": self.req.return_qr_generated_at.isoformat(),
            },
            expires_in=timedelta(minutes=30),
        )

    def test_the_employee_is_told_when_the_gate_records_them_going_out(self):
        body, status = resolve_gate_scan(self.gate, self.exit_qr())
        self.assertEqual(status, 200)
        text = self.texts()[0]
        for expected in (
            "Gate Exit Recorded",
            "Dear Asha Kumar",
            "Official / Mill Duty",
            "Gate out:",
            "Destination: Bank",
            "Reason: Deposit cheque",
            "Gate: Gate 1",
            "Status: Verified",
            "scan your Return QR",
            "- UK Textiles HR",
        ):
            self.assertIn(expected, text)
        self.assertNotIn("Gate in:", text)  # nothing to say about coming back yet
        log = WhatsAppMessageLog.objects.get()
        self.assertEqual((log.document_type, log.related_module, log.status), ("outpass_gate_out", "outpass", "sent"))
        self.assertEqual(log.dedupe_key, f"gate:out:{self.req.id}")
        self.assertEqual((self.meta.last()["to"], self.meta.last()["template"]), ("918220015110", "hrms_gate_out"))
        self.assertEqual(log.template_name, "hrms_gate_out")
        self.assert_texts_are_plain()

    def test_and_again_with_both_times_and_how_long_they_were_out_when_they_return(self):
        resolve_gate_scan(self.gate, self.exit_qr())
        # Pretend they left 75 minutes ago.
        OutpassRequest.objects.filter(pk=self.req.pk).update(exited_at=timezone.now() - timedelta(minutes=75))
        body, status = resolve_gate_scan(self.gate2, self.return_qr())
        self.assertEqual(status, 200)
        text = self.texts()[1]
        for expected in (
            "Gate Return Recorded",
            "Welcome back",
            "Gate out:",
            "Gate in:",
            "Time out: 1 hr 15 min",
            "Gate: Gate 2",
            "Verified",
        ):
            self.assertIn(expected, text)
        self.assertEqual(WhatsAppMessageLog.objects.filter(document_type="outpass_gate_in").count(), 1)
        self.assertEqual(self.meta.templates_sent, ["hrms_gate_out", "hrms_gate_in"])
        self.assert_texts_are_plain()

    def test_a_denied_scan_sends_nothing(self):
        resolve_gate_scan(self.gate, self.exit_qr())
        body, status = resolve_gate_scan(self.gate2, self.exit_qr())  # already used
        self.assertEqual(status, 409)
        self.assertEqual(len(self.meta.sent), 1)
        self.assertEqual(WhatsAppMessageLog.objects.count(), 1)

    def test_the_switch_stops_the_message_but_not_the_scan(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"outpass_notifications_enabled": False})
        body, status = resolve_gate_scan(self.gate, self.exit_qr())
        self.assertEqual(status, 200)
        self.assertEqual(self.meta.sent, [])
        self.req.refresh_from_db()
        self.assertIsNotNone(self.req.exited_at)

    def test_a_whatsapp_outage_never_blocks_the_gate(self):
        self.meta.fail(131026, "Message undeliverable")
        body, status = resolve_gate_scan(self.gate, self.exit_qr())
        self.assertEqual((status, body["result"]), (200, "success"))
        self.assertEqual(WhatsAppMessageLog.objects.get().status, "failed")

    def test_a_crash_in_the_messaging_code_never_blocks_the_gate(self):
        with mock.patch("api.whatsapp_service.send_notification", side_effect=RuntimeError("boom")):
            body, status = resolve_gate_scan(self.gate, self.exit_qr())
        self.assertEqual((status, body["result"]), (200, "success"))

    def test_the_gate_qr_form_confirms_an_entry_recorded_in_their_name_as_unverified(self):
        qr = GateQRCode.get_or_create_for(self.branch, GateQRCode.KIND_OUTPASS)
        request = APIRequestFactory().post(
            f"/api/outpass/gate/{qr.token}",
            {"name": "Asha K", "employeeCode": "ge1", "destination": "Market"},
            format="json",
        )
        self.assertEqual(outpass_gate_submit(request, qr.token).status_code, 201)
        text = self.texts()[0]
        for expected in (
            "Gate Exit Recorded",
            "Gate QR form",
            "Destination: Market",
            "Gate: Main Unit",
            "not scanned by a guard",
            "wasn't you",
        ):
            self.assertIn(expected, text)
        self.assertEqual(WhatsAppMessageLog.objects.get().dedupe_key, f"gate:record:{OutpassRecord.objects.get().id}")

    def test_an_unknown_employee_code_on_the_gate_form_messages_nobody(self):
        qr = GateQRCode.get_or_create_for(self.branch, GateQRCode.KIND_OUTPASS)
        request = APIRequestFactory().post(
            f"/api/outpass/gate/{qr.token}",
            {"name": "Who", "employeeCode": "NOPE", "destination": "Market"},
            format="json",
        )
        self.assertEqual(outpass_gate_submit(request, qr.token).status_code, 201)
        self.assertEqual(self.meta.sent, [])


@override_settings(**META)
class VisitorMessageTests(WhatsAppBase):
    def setUp(self):
        self.start_meta()
        self.branch = Branch.objects.create(name="Tirupur")
        self.dept = Department.objects.create(name="Weaving")
        self.qr = GateQRCode.get_or_create_for(self.branch, GateQRCode.KIND_VISITOR)
        self.host = Employee.objects.create(
            employee_code="V1",
            first_name="Meeting",
            last_name="Target",
            phone="91234 56789",
            status="active",
            department=self.dept,
            branch=self.branch,
        )
        self.factory = APIRequestFactory()

    def check_in(self, **extra):
        body = {
            "name": "Vishal Visitor",
            "phone": "70000 00001",
            "whomToMeet": "Meeting Target",
            "purpose": "Machine service",
            "meetingEmployeeId": self.host.id,
            "whyCame": "Vendor",
            **extra,
        }
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", body, format="json")
        return visitor_gate_new(request, self.qr.token)

    def test_the_employee_gets_everything_they_need_to_know_about_the_visitor(self):
        self.assertEqual(self.check_in().status_code, 201)
        first = self.meta.sent[0]
        text = self.texts()[0]
        for expected in (
            "Visitor at Reception",
            "Dear Meeting Target",
            "Visitor: Vishal Visitor",
            "Contact: +91 70000 00001",
            "Purpose: Machine service",
            "Here to meet: Meeting Target",
            "Department: Weaving",
            "Branch: Tirupur",
            "Date:",
            "Time:",
            "- UK Textiles HR",
        ):
            self.assertIn(expected, text)
        self.assertIn("Company: -", text)  # nothing recorded: a template can't drop the line, so a dash
        self.assertEqual((first["to"], first["template"]), ("919123456789", "hrms_visitor_at_reception"))
        self.assert_texts_are_plain()

    def test_the_visitors_number_is_a_line_of_the_message_and_no_contact_card_follows(self):
        self.check_in()
        self.assertEqual(len(self.meta.sent), 1)  # Meta's templates carry no contact card
        self.assertEqual(self.meta.last()["params"]["visitor_phone"], "+91 70000 00001")
        types = list(WhatsAppMessageLog.objects.order_by("id").values_list("document_type", "status"))
        self.assertEqual(types, [("visitor_notification", "sent")])
        self.assertFalse(WhatsAppMessageLog.objects.filter(document_type="visitor_contact").exists())

    def test_reception_sees_the_host_was_notified_once_it_really_was(self):
        self.check_in()
        self.assertIsNotNone(VisitorVisit.objects.get().notified_whatsapp_at)

    def test_a_refused_message_leaves_reception_not_notified(self):
        self.meta.fail(131026, "Message undeliverable")
        self.assertEqual(self.check_in().status_code, 201)
        self.assertEqual(WhatsAppMessageLog.objects.get(document_type="visitor_notification").status, "failed")
        self.assertIsNone(VisitorVisit.objects.get().notified_whatsapp_at)
        self.assertFalse(WhatsAppMessageLog.objects.filter(document_type="visitor_contact").exists())

    def test_without_an_approved_template_the_check_in_works_and_the_log_says_why(self):
        approve_templates("visitor_notification", status="PAUSED")
        self.assertEqual(self.check_in().status_code, 201)
        log = WhatsAppMessageLog.objects.get()
        self.assertEqual(log.status, "skipped")
        self.assertIn("hrms_visitor_at_reception", log.error_message)
        self.assertEqual(self.meta.sent, [])
        self.assertIsNone(VisitorVisit.objects.get().notified_whatsapp_at)

    def test_the_visitor_switch_turns_it_off_but_check_in_still_works(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"visitor_notification_enabled": False})
        self.assertEqual(self.check_in().status_code, 201)
        self.assertEqual(self.meta.sent, [])
        self.assertIsNone(VisitorVisit.objects.get().notified_whatsapp_at)

    def test_a_host_with_no_phone_is_logged_and_check_in_still_works(self):
        Employee.objects.filter(pk=self.host.pk).update(phone="")
        # (the form matches the host by phone in real life; here the id is sent directly)
        self.assertEqual(self.check_in().status_code, 201)
        self.assertIn("No phone number", WhatsAppMessageLog.objects.get().error_message)

    def test_a_crash_in_the_messaging_code_never_blocks_check_in(self):
        with mock.patch("api.whatsapp_service.send_notification", side_effect=RuntimeError("boom")):
            self.assertEqual(self.check_in().status_code, 201)
        self.assertEqual(VisitorVisit.objects.count(), 1)
