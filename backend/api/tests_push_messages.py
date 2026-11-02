"""Every WhatsApp message is also a phone notification and an in-app record (push_messages.py): the text, the title, the type, the
one-time-code exclusion, exactly-once, the Expo payload, and that a final decision is announced once (not twice)."""

from datetime import date
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import push_messages, whatsapp_approvals, whatsapp_notifications, whatsapp_service
from .models import (
    Employee,
    LeaveRequest,
    Notification,
    OnDutySession,
    PushToken,
    WhatsAppSettings,
)

EXPO = "api.signals.requests.post"


def _employee(code="P1", phone="9000000001") -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name="Asha", last_name="Kumar", employment_type="staff", status="active", phone=phone
    )


class SplitMessageTests(TestCase):
    def test_the_bold_first_line_is_the_title_and_the_sign_off_is_dropped(self):
        text = "✅ *Request Approved*\n\nHello Asha,\n\nYour *Leave* request has been approved.\n\n📅 Date: 5 Oct 2026\n\nThank you,\nUK Textiles HRMS"
        title, body = push_messages.split_message(text, "Approval - Approved")
        self.assertEqual(title, "✅ Request Approved")
        self.assertEqual(body, "Hello Asha,\n\nYour Leave request has been approved.\n\n📅 Date: 5 Oct 2026")

    def test_a_message_without_a_bold_header_takes_the_catalog_label(self):
        title, body = push_messages.split_message(
            "Good morning, Asha 🌟\n\nPlease punch in.\n\nUK Textiles HRMS", "Punch Reminder"
        )
        self.assertEqual(title, "Punch Reminder")
        self.assertEqual(body, "Good morning, Asha 🌟\n\nPlease punch in.")

    def test_a_message_that_is_only_a_title_still_has_a_body(self):
        self.assertEqual(push_messages.split_message("*Hello*", "x"), ("Hello", "Hello"))


class AnnounceTests(TestCase):
    def setUp(self):
        self.emp = _employee()

    def test_a_message_becomes_a_notification_with_its_title_type_and_text(self):
        n = push_messages.announce(
            self.emp, "approval_approved", "✅ *Request Approved*\n\nHello.\n\nUK Textiles HRMS", related_module="leave"
        )
        self.assertEqual(
            (n.employee_id, n.type, n.title, n.message, n.is_read),
            (self.emp.id, "leave", "✅ Request Approved", "Hello.", False),
        )

    def test_the_type_is_what_the_mobile_list_groups_by(self):
        for doc, module, expected in (
            ("approval_approved", "attendance_correction", "attendance"),
            ("approval_rejected", "holiday_work", "compensation"),
            ("approval_approved", "request", "employee_request"),
            ("geo_approval", "on_duty", "on_duty"),
            ("late_alert", "", "attendance"),
            ("outpass_gate_out", "outpass", "outpass"),
            ("visitor_notification", "", "visitors"),
            ("salary_slip", "", "salary_slip"),
        ):
            self.assertEqual(push_messages.notification_type(doc, module), expected, (doc, module))

    def test_a_one_time_code_is_never_a_notification(self):
        for doc in ("otp_login", "otp_reset", "otp_activate"):
            self.assertIsNone(push_messages.announce(self.emp, doc, "123456 is your login code."))
        self.assertEqual(Notification.objects.count(), 0)

    def test_the_same_dedupe_key_is_announced_once_per_employee(self):
        other = _employee("P2", "9000000002")
        for _ in range(3):
            push_messages.announce(
                self.emp, "late_alert", "⏰ *Late Attendance*\n\nHi.", dedupe_key="late_alert:2026-10-05:1"
            )
        push_messages.announce(other, "late_alert", "⏰ *Late Attendance*\n\nHi.", dedupe_key="late_alert:2026-10-05:1")
        self.assertEqual(Notification.objects.filter(employee=self.emp).count(), 1)
        self.assertEqual(Notification.objects.filter(employee=other).count(), 1)

    def test_something_that_is_not_an_employee_or_has_no_text_is_skipped_without_raising(self):
        self.assertIsNone(push_messages.announce(object(), "late_alert", "*x*\n\nbody"))
        self.assertIsNone(push_messages.announce(self.emp, "late_alert", "   "))
        self.assertEqual(Notification.objects.count(), 0)


class PushPayloadTests(TestCase):
    def test_the_phone_gets_the_title_the_text_a_sound_and_the_notification_id(self):
        emp = _employee()
        PushToken.objects.create(employee=emp, token="ExponentPushToken[abc]")
        with mock.patch(EXPO) as post:
            post.return_value = mock.Mock(ok=True, json=lambda: {"data": [{"status": "ok"}]})
            n = push_messages.announce(
                emp, "approval_rejected", "❌ *Request Rejected*\n\nSorry.\n\nUK Textiles HRMS", related_module="leave"
            )
        messages = post.call_args.kwargs["json"]
        self.assertEqual(len(messages), 1)
        sent = messages[0]
        self.assertEqual(
            (sent["to"], sent["title"], sent["body"], sent["sound"], sent["priority"]),
            ("ExponentPushToken[abc]", "❌ Request Rejected", "Sorry.", "default", "high"),
        )
        # + where the app's View button leads (notification_targets.py), kept to kind / id / category
        self.assertEqual(
            sent["data"],
            {"type": "leave", "notificationId": n.id, "target": {"kind": "leave", "id": None, "category": None}},
        )

    def test_an_older_one_line_notification_still_pushes_with_the_app_name(self):
        emp = _employee()
        PushToken.objects.create(employee=emp, token="ExponentPushToken[abc]")
        with mock.patch(EXPO) as post:
            post.return_value = mock.Mock(ok=True, json=lambda: {"data": []})
            Notification.objects.create(
                employee=emp, type="leave", message="Your leave request was approved by your Department Head."
            )
        self.assertEqual(post.call_args.kwargs["json"][0]["title"], "UKTextiles")


class WhatsAppMessagesAreAnnouncedTests(TestCase):
    """The hook in whatsapp_service: every message type except the codes, with WhatsApp not configured at all."""

    def setUp(self):
        self.emp = _employee()

    def test_a_system_message_is_announced_even_when_whatsapp_is_not_configured(self):
        self.assertFalse(whatsapp_service.is_configured())
        whatsapp_service.send_notification(
            self.emp,
            "late_alert",
            {
                "employee_name": "Asha",
                "date": "5 Oct 2026",
                "shift_start": "9:00 AM",
                "first_punch": "9:25 AM",
                "late_by": "15 minutes",
                "status": "Late",
            },
            dedupe_key="late_alert:2026-10-05:1",
        )
        n = Notification.objects.get(employee=self.emp)
        self.assertEqual((n.type, n.title), ("attendance", "⏰ Late Attendance"))
        self.assertIn("9:25 AM", n.message)
        self.assertNotIn("*", n.message)

    def test_it_also_goes_out_when_hr_switched_the_whatsapp_message_off(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"outpass_notifications_enabled": False})
        whatsapp_service.send_notification(
            self.emp,
            "outpass_gate_out",
            {"employee_name": "Asha", "gate_out_time": "10:00 AM"},
            dedupe_key="gate:out:5",
            related_module="outpass",
        )
        self.assertEqual(Notification.objects.filter(employee=self.emp, type="outpass").count(), 1)

    def test_a_login_code_message_is_not_announced(self):
        whatsapp_service.send_notification(
            self.emp, "otp_login", ["123456", "5"], log_params=["******", "5"], asynchronous=False
        )
        self.assertEqual(Notification.objects.count(), 0)

    def test_a_document_is_announced_with_its_caption(self):
        whatsapp_service.send_document(
            None, self.emp, "salary_slip", b"%PDF", "slip.pdf", ["Asha Kumar", "October 2026"]
        )
        n = Notification.objects.get(employee=self.emp)
        self.assertEqual((n.type, n.title), ("salary_slip", "💰 Salary Slip"))
        self.assertIn("October 2026", n.message)

    def test_the_geo_and_gate_and_visitor_messages_are_announced(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="Erode mill", status="active")
        whatsapp_notifications.notify_geo_session_approved(session, "Meena")
        whatsapp_notifications.notify_geo_session_rejected(session, "Meena")
        types = list(Notification.objects.filter(employee=self.emp).order_by("id").values_list("type", "title"))
        self.assertEqual([t for t, _ in types], ["on_duty", "on_duty"])
        self.assertIn("Approved", types[0][1])
        self.assertIn("Rejected", types[1][1])


class DecisionsAreAnnouncedOnceTests(TestCase):
    def setUp(self):
        self.emp = _employee()
        self.leave = LeaveRequest.objects.create(
            employee=self.emp,
            type="casual",
            start_date=date(2026, 10, 12),
            end_date=date(2026, 10, 12),
            total_days=1,
            reason="Family function",
        )

    def test_a_final_decision_is_the_whatsapp_text_as_one_notification(self):
        whatsapp_approvals.notify_decision(
            "leave", self.leave, "approved", approver="Meena", role="hr", comment="Enjoy"
        )
        n = Notification.objects.get(employee=self.emp)
        self.assertEqual((n.type, n.title), ("leave", "✅ Request Approved"))
        for needle in ("Leave", "12 Oct 2026", "Meena (HR)", "Enjoy"):
            self.assertIn(needle, n.message)
        # deciding it again does not announce it again
        whatsapp_approvals.notify_decision("leave", self.leave, "approved", approver="Meena", role="hr")
        self.assertEqual(Notification.objects.filter(employee=self.emp).count(), 1)

    def test_a_rejection_is_announced_with_the_reason(self):
        whatsapp_approvals.notify_decision(
            "leave", self.leave, "rejected", approver="Meena", role="hr", comment="Peak season"
        )
        n = Notification.objects.get(employee=self.emp)
        self.assertEqual(n.title, "❌ Request Rejected")
        self.assertIn("Peak season", n.message)

    def test_a_stage_notice_is_made_only_for_a_decision_that_passes_the_request_on(self):
        advanced = approval.Outcome(
            kind="advanced", role=approval.HOD, decision="approved", status="pending", waiting=(approval.HR,)
        )
        final = approval.Outcome(kind="approved", role=approval.HR, decision="approved", status="approved")
        rejected = approval.Outcome(kind="rejected", role=approval.HR, decision="rejected", status="rejected")
        self.assertIsNotNone(
            approval.stage_notice(
                self.emp, "leave", "approved by your Department Head and is now awaiting HR", advanced
            )
        )
        self.assertIsNone(approval.stage_notice(self.emp, "leave", "approved", final))
        self.assertIsNone(approval.stage_notice(self.emp, "leave", "rejected", rejected))
        self.assertEqual(Notification.objects.filter(employee=self.emp).count(), 1)
