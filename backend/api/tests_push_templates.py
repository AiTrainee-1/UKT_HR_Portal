"""
Phone Notify Control -> Message Text (owner 2026-11-17): HR writes the title and wording of every kind of phone
notification, with placeholders and a preview, like WhatsApp Control -> Message Text. A kind with no wording keeps its
built-in text.

Run via: python manage.py test api.tests_push_templates --keepdb
"""

from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import chat_push, push_messages, push_templates
from .jwt_utils import sign_token
from .models import ChatChannel, ChatMessage, Employee, HRUser, Notification, PushTemplate, PushToken
from .tests_push_delivery import EXPO, ok

BASE = "/api/mobile-app/messages/templates"


class World(TestCase):
    def setUp(self):
        super().setUp()
        self.admin = HRUser.objects.create(username="pt_admin", password_hash="x", is_super_admin=True)
        self.h = {
            "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.admin.id, 'name': 'pt_admin'})}"
        }
        self.emp = Employee.objects.create(
            employee_code="PT1", first_name="Asha", last_name="Kumar", employment_type="staff", status="active"
        )
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[pt1]")
        self.expo = mock.patch(EXPO).start()
        self.addCleanup(mock.patch.stopall)
        ok(self.expo)

    def save(self, key, title="", body=""):
        return self.client.put(
            f"{BASE}/{key}", {"title": title, "body": body}, content_type="application/json", **self.h
        )


class ListTests(World):
    def test_every_kind_with_wording_is_listed_with_its_placeholders(self):
        res = self.client.get(BASE, **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        rows = {r["key"]: r for r in res.json()}
        self.assertEqual(list(rows), push_templates.keys())
        for absent in ("otp_login", "hr_notice", "attendance_report", "visitor_contact"):
            self.assertNotIn(absent, rows)
        late = rows["late_alert"]
        self.assertNotIn("origin", late)
        self.assertEqual((late["customised"], late["title"], late["defaultTitle"]), (False, "", "Marked late today"))
        self.assertIn("{{first_punch}}", late["defaultBody"])
        self.assertIn("first_punch", [v["name"] for v in late["variables"]])
        self.assertIn("9:25 AM", late["preview"]["body"])
        waiting = rows["approval_waiting"]
        self.assertEqual(waiting["defaultBody"], "{{message}}")
        self.assertEqual({"headline", "message", "request"} - {v["name"] for v in waiting["variables"]}, set())


class SaveTests(World):
    def test_save_check_preview_and_reset(self):
        res = self.save("salary_paid", "Pay day", "Hi {{employee_name}}, your {{month}} salary is in.")
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["customised"], body["preview"]["title"]), (True, "Pay day"))
        self.assertEqual(body["preview"]["body"], "Hi Asha Kumar, your October 2026 salary is in.")
        self.assertEqual(self.save("salary_paid", "", "Hi {{nmae}}").status_code, 400)  # a typo
        self.assertEqual(self.save("salary_paid", "x" * 101, "").status_code, 400)
        self.assertEqual(self.save("salary_paid", "two\nlines", "").status_code, 400)
        self.assertEqual(self.save("hr_notice", "x", "y").status_code, 404)
        preview = self.client.post(
            f"{BASE}/salary_paid/preview",
            {"title": "", "body": "{{month}} done"},
            content_type="application/json",
            **self.h,
        ).json()
        self.assertEqual(
            (preview["title"], preview["body"], preview["error"]), ("Salary Paid", "October 2026 done", None)
        )
        res = self.save("salary_paid")  # both blank: back to the built-in wording
        self.assertEqual(res.json()["customised"], False)
        self.assertFalse(PushTemplate.objects.filter(key="salary_paid").exists())


class SendersUseTheWordingTests(World):
    def test_an_event_takes_the_saved_wording_with_its_details(self):
        self.save("late_alert", "Late today ({{late_by}})", "{{employee_name}}, you punched at {{first_punch}}.")
        push_messages.announce(
            self.emp,
            "late_alert",
            params={"employee_name": "Asha Kumar", "first_punch": "9:25 AM", "late_by": "15 minutes"},
            dedupe_key="late:t1",
        )
        n = Notification.objects.get(source="late_alert")
        self.assertEqual((n.title, n.message), ("Late today (15 minutes)", "Asha Kumar, you punched at 9:25 AM."))
        self.assertEqual(self.expo.call_args.kwargs["json"][0]["title"], "Late today (15 minutes)")

    def test_without_saved_wording_the_phones_built_in_wording_is_used_never_whatsapps(self):
        from .models import WhatsAppMessageTemplate

        WhatsAppMessageTemplate.objects.create(document_type="late_alert", message_body="*WA*\nDear {{employee_name}}")
        push_messages.announce(
            self.emp,
            "late_alert",
            params={"first_punch": "9:25 AM", "late_by": "15 minutes", "shift_start": "9:00 AM"},
            dedupe_key="late:t2",
        )
        n = Notification.objects.get(source="late_alert")
        self.assertEqual(
            (n.title, n.message),
            (
                "Marked late today",
                "Your first punch was at 9:25 AM, 15 minutes after the allowed time (shift start 9:00 AM).",
            ),
        )

    def test_salary_paid(self):
        from . import payroll_month_workflow as pmw
        from .models import Payroll

        self.save("salary_paid", "", "Hi {{employee_name}}, {{month}} is paid.")
        p = Payroll.objects.create(
            employee=self.emp, month=10, year=2026, base_salary=0, gross_salary=0, final_salary=0
        )
        pmw.notify_salary_paid([p.pk])
        n = Notification.objects.get(source="salary_paid")
        self.assertEqual((n.title, n.message), ("Salary Paid", "Hi Asha Kumar, October 2026 is paid."))

    def test_the_built_in_sentence_can_be_wrapped(self):
        self.save("approval_progress", "Request update", "{{message}} Next: {{next_approver}}.")
        outcome = approval.Outcome(kind="advanced", role=approval.HOD, decision="approved", waiting=(approval.HR,))
        n = approval.stage_notice(self.emp, "leave", "Approved by your Department Head; now with HR.", outcome)
        self.assertEqual(
            (n.title, n.message), ("Request update", "Approved by your Department Head; now with HR. Next: HR.")
        )

    def test_chat(self):
        self.save("chat_announcement", "{{sender_name}} says", "{{message}}")
        other = Employee.objects.create(employee_code="PT2", first_name="R", last_name="K", status="active")
        PushToken.objects.create(employee=other, token="ExponentPushToken[pt2]")
        msg = ChatMessage.objects.create(channel=ChatChannel.get_company_channel(None), sender_label="HR", text="Hello")
        chat_push.message_posted(msg.pk)
        n = Notification.objects.filter(type="chat").first()
        self.assertEqual((n.title, n.message), ("HR says", "Hello"))
