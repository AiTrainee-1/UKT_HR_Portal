"""
Phone Notify Control -> Settings (owner 2026-11-17): who receives phone notifications at all. Staff only, production only,
or selected employees; every automatic sender leaves the others out before it makes anything (no row, no push, no Expo
request), and the push itself refuses them once more. HR's own messages still go to whoever HR picks.

Run via: python manage.py test api.tests_push_recipients --keepdb
"""

from datetime import date
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import chat_push, push_delivery, push_messages, push_recipients
from .jwt_utils import sign_token
from .models import (
    ChatChannel,
    ChatMessage,
    Employee,
    HRUser,
    MobileMessageSettings,
    Notification,
    PushRecipient,
    PushToken,
)
from .tests_push_delivery import EXPO, ok
from .tests_whatsapp_alerts import WED, AlertBase, at

BASE = "/api/mobile-app/messages"


def set_mode(mode: str) -> None:
    MobileMessageSettings.objects.update_or_create(pk=1, defaults={"recipient_mode": mode})


class World(TestCase):
    def setUp(self):
        super().setUp()
        self.admin = HRUser.objects.create(username="pr_admin", password_hash="x", is_super_admin=True)
        self.h = {
            "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.admin.id, 'name': 'pr_admin'})}"
        }
        self.staff = self.person("PRS1", "staff")
        self.staff2 = self.person("PRS2", "staff", phone=False)
        self.prod = self.person("PRP1", "production")
        self.expo = mock.patch(EXPO).start()
        self.addCleanup(mock.patch.stopall)
        ok(self.expo)

    def person(self, code, kind, phone=True, **kw):
        e = Employee.objects.create(
            employee_code=code, first_name=code, last_name="E", employment_type=kind, status="active", **kw
        )
        if phone:
            PushToken.objects.create(employee=e, token=f"ExponentPushToken[{code}]")
        return e

    def codes(self, **kw):
        return set(Notification.objects.filter(**kw).values_list("employee__employee_code", flat=True))


class RuleTests(World):
    def test_each_mode_keeps_its_people(self):
        ids = {self.staff.pk, self.staff2.pk, self.prod.pk}
        self.assertEqual(push_recipients.keep(ids), ids)  # all, the default
        set_mode("staff")
        self.assertEqual(push_recipients.keep(ids), {self.staff.pk, self.staff2.pk})
        self.assertFalse(push_recipients.allows(self.prod))
        self.assertFalse(push_recipients.allows(self.prod.pk))
        set_mode("production")
        self.assertEqual(push_recipients.keep(ids), {self.prod.pk})
        set_mode("selected")
        self.assertEqual(push_recipients.keep(ids), set())
        PushRecipient.objects.create(employee=self.staff2)
        self.assertEqual(push_recipients.keep(ids), {self.staff2.pk})
        self.assertEqual(
            set(push_recipients.narrow(Employee.objects.filter(pk__in=ids)).values_list("id", flat=True)),
            {self.staff2.pk},
        )


class SendersLeaveOthersOutTests(World):
    def test_a_whatsapp_message_is_not_announced_to_an_outsider(self):
        set_mode("staff")
        self.assertIsNone(push_messages.announce(self.prod, "approval_approved", params={}, dedupe_key="x1"))
        self.assertIsNotNone(push_messages.announce(self.staff, "approval_approved", params={}, dedupe_key="x2"))
        self.assertEqual(self.codes(), {"PRS1"})

    def test_a_stage_notice_is_not_made_for_an_outsider(self):
        set_mode("production")
        outcome = approval.Outcome(kind="advanced", role=approval.HOD, decision="approved", waiting=(approval.HR,))
        self.assertIsNone(approval.stage_notice(self.staff, "leave", "Now with HR.", outcome))
        self.assertIsNotNone(approval.stage_notice(self.prod, "leave", "Now with HR.", outcome))

    def test_chat_reaches_recipients_only(self):
        set_mode("production")
        channel = ChatChannel.get_company_channel(None)
        msg = ChatMessage.objects.create(channel=channel, sender_label="HR", text="Hello")
        chat_push.message_posted(msg.pk)
        self.assertEqual(self.codes(type="chat"), {"PRP1"})

    def test_salary_paid_only_processes_recipients(self):
        from . import payroll_month_workflow as pmw
        from .models import Payroll

        set_mode("selected")
        PushRecipient.objects.create(employee=self.staff)
        rows = [
            Payroll.objects.create(employee=e, month=10, year=2026, base_salary=0, gross_salary=0, final_salary=0)
            for e in (self.staff, self.prod)
        ]
        self.assertEqual(pmw.notify_salary_paid([p.pk for p in rows]), 1)
        self.assertEqual(self.codes(source="salary_paid"), {"PRS1"})

    def test_a_compensation_announcement_reaches_covered_recipients_only(self):
        from . import compensation_notices
        from .models import CompensationDayAnnouncement

        set_mode("selected")
        PushRecipient.objects.create(employee=self.staff2)
        ann = CompensationDayAnnouncement.objects.create(date=date(2026, 11, 21))
        compensation_notices.announcement_made(ann)
        self.assertEqual(self.codes(source="compensation_announcement"), {"PRS2"})
        compensation_notices.announcement_made(ann, [self.staff.pk, self.staff2.pk])  # the windows path
        self.assertEqual(self.codes(source="compensation_announcement"), {"PRS2"})


class SafetyNetTests(World):
    def test_a_sender_that_forgot_is_stopped_at_the_push_and_says_why(self):
        set_mode("staff")
        n = Notification.objects.create(employee=self.prod, message="from a forgetful sender", source="late_alert")
        n.refresh_from_db()
        self.assertEqual((n.push_status, n.push_error), ("off", push_recipients.NOT_RECIPIENT))
        self.expo.assert_not_called()

    def test_hr_can_still_write_to_anyone(self):
        set_mode("staff")
        res = self.client.post(
            f"{BASE}/send",
            {"employeeId": self.prod.pk, "title": "Hello", "message": "Please see HR"},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["pushStatus"], "sent")


class AlertsTests(AlertBase):
    """The phone attendance alert job (phone_alerts.py) only looks at the recipients."""

    def setUp(self):
        super().setUp()
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[alert-r]")
        # AlertBase fakes Meta's Graph API (self.meta) and Expo (self.expo) on the one requests.post, routed by address
        self.expo.side_effect = lambda *a, **kw: mock.Mock(
            ok=True, status_code=200, json=lambda: {"data": [{"status": "ok", "id": "t"}]}
        )

    def absent(self):
        return Notification.objects.filter(employee=self.emp, source="absent_alert")

    def phone(self, h, m=0):
        from . import phone_alerts

        return phone_alerts.run_phone_alerts(now=at(WED, h, m))

    def test_production_only_skips_the_staff_entirely(self):
        from . import whatsapp_alerts

        set_mode("production")
        with mock.patch("api.phone_alerts.evaluate", wraps=whatsapp_alerts.evaluate) as ev:
            self.phone(10, 0)
        ev.assert_not_called()  # nobody was even looked at
        self.assertFalse(self.absent().exists())

    def test_a_selected_employee_gets_the_alert_and_the_others_are_not_looked_at(self):
        other = self.make_employee("A2", "Ravi", "Kumar")
        set_mode("selected")
        PushRecipient.objects.create(employee=self.emp)
        from . import whatsapp_alerts

        with mock.patch("api.phone_alerts.evaluate", wraps=whatsapp_alerts.evaluate) as ev:
            self.phone(10, 0)
        self.assertEqual({c.args[0].pk for c in ev.call_args_list}, {self.emp.pk})
        self.assertEqual(self.absent().count(), 1)
        self.assertFalse(Notification.objects.filter(employee=other).exists())

    def test_whatsapp_still_reaches_everybody_while_the_phone_follows_the_setting(self):
        set_mode("production")  # the staff member is not a phone recipient
        self.assertEqual(self.run_at(WED, 10, 0).get("absent_alert"), 1)  # WhatsApp is its own channel
        self.phone(10, 0)
        self.assertFalse(self.absent().exists())


class ApiTests(World):
    def summary(self):
        res = self.client.get(f"{BASE}/recipients", **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_the_summary_counts_each_option(self):
        body = self.summary()
        modes = {m["key"]: (m["employees"], m["withPhone"]) for m in body["modes"]}
        self.assertEqual(body["mode"], "all")
        self.assertGreaterEqual(modes["all"][0], 3)
        self.assertEqual(modes["selected"], (0, 0))
        self.assertEqual(modes["staff"][0] - modes["staff"][1], 1)  # PRS2 has no phone

    def test_choosing_selected_needs_a_list(self):
        res = self.client.put(f"{BASE}/recipients", {"mode": "selected"}, content_type="application/json", **self.h)
        self.assertEqual(res.status_code, 400)
        res = self.client.post(
            f"{BASE}/recipients/employees", {"add": [self.prod.pk]}, content_type="application/json", **self.h
        )
        self.assertEqual((res.status_code, res.json()["changed"], res.json()["selected"]), (200, 1, 1))
        res = self.client.put(f"{BASE}/recipients", {"mode": "selected"}, content_type="application/json", **self.h)
        self.assertEqual((res.status_code, res.json()["mode"], res.json()["receiving"]), (200, "selected", 1))
        # emptying the list while it is in use is refused, and nothing is removed
        res = self.client.post(
            f"{BASE}/recipients/employees", {"clear": True}, content_type="application/json", **self.h
        )
        self.assertEqual(res.status_code, 400)
        self.assertTrue(PushRecipient.objects.filter(employee=self.prod).exists())

    def test_bad_requests(self):
        for body in ({"mode": "everyone"}, {}):
            self.assertEqual(
                self.client.put(f"{BASE}/recipients", body, content_type="application/json", **self.h).status_code, 400
            )
        for body in ({"add": "1"}, {"add": [1], "remove": [2]}, {"clear": "yes"}, {"addMatching": []}):
            res = self.client.post(f"{BASE}/recipients/employees", body, content_type="application/json", **self.h)
            self.assertEqual(res.status_code, 400, body)

    def test_matching_adds_and_removes_by_filter(self):
        res = self.client.post(
            f"{BASE}/recipients/employees",
            {"addMatching": {"type": "staff", "search": "PRS"}},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(res.json()["changed"], 2)
        self.assertEqual(set(PushRecipient.objects.values_list("employee__employee_code", flat=True)), {"PRS1", "PRS2"})
        res = self.client.post(
            f"{BASE}/recipients/employees",
            {"removeMatching": {"search": "PRS2"}},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(res.json()["changed"], 1)
        listed = self.client.get(
            f"{BASE}/recipients/employees?page=1&pageSize=10&search=PR&selected=1", **self.h
        ).json()
        self.assertEqual([r["code"] for r in listed["items"]], ["PRS1"])
        self.assertEqual(listed["items"][0]["selected"], True)
        self.assertEqual(listed["items"][0]["hasPhone"], True)
        listed = self.client.get(f"{BASE}/recipients/employees?page=1&search=PR&type=production", **self.h).json()
        self.assertEqual([(r["code"], r["selected"]) for r in listed["items"]], [("PRP1", False)])

    def test_the_overview_and_employees_tab_say_who_receives(self):
        set_mode("staff")
        overview = self.client.get(f"{BASE}/overview", **self.h).json()
        rec = overview["recipients"]
        self.assertEqual((rec["mode"], rec["modeLabel"]), ("staff", "Staff only"))
        # the phone figures count the recipients, not every employee
        staff = Employee.objects.filter(status="active", employment_type="staff")
        self.assertEqual(overview["devices"]["employees"], staff.count())
        self.assertEqual(overview["devices"]["withDevice"], staff.filter(push_tokens__isnull=False).distinct().count())
        rows = self.client.get(f"{BASE}/devices?page=1&search=PR", **self.h).json()["items"]
        self.assertEqual(
            {r["employeeCode"]: r["isRecipient"] for r in rows}, {"PRS1": True, "PRS2": True, "PRP1": False}
        )


class RemindersPushInPlaceTests(World):
    """Two senders report the push result at once, so they push in place even on the real (queued) path."""

    def setUp(self):
        super().setUp()
        p = mock.patch("api.push_delivery.inline_mode", return_value=False)
        p.start()

    def test_the_hod_reminder_run_sees_its_push_result(self):
        from . import hod_reminders
        from .models import HodReminderDelivery as D

        run, d = SimpleNamespace(pk=7), SimpleNamespace(pk=8, manager_id=9, text="3 requests wait for you")
        self.assertEqual(hod_reminders._send_push(run, d, self.staff, None), (D.STATUS_SENT, ""))
        set_mode("production")
        self.assertEqual(
            hod_reminders._send_push(SimpleNamespace(pk=70), d, self.staff, None),
            (D.STATUS_SKIPPED, push_recipients.NOT_RECIPIENT),
        )

    def test_push_delivery_skips_what_was_pushed_in_place(self):
        n = Notification.objects.create(employee=self.staff, message="x")  # queued for after the commit (never here)
        self.assertEqual(push_delivery.push([n.pk]), {n.pk: "sent"})
        self.assertEqual(push_delivery.push([n.pk]), {})
