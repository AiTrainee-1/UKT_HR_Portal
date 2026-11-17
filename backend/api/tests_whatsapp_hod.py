"""
WhatsApp Control -> Department Head notifications (owner 2026-11-17: "HOD notifications are not working, and there is no
option to enable or configure them"): the section's master switch, the "New request waiting for approval" message (off
until HR switches it on), the scheduled reminder moved into the section, and the message reaching the head wherever a
request reaches their step. WhatsApp is independent of the head's phone notification.

Run via: python manage.py test api.tests_whatsapp_hod --keepdb
"""

from datetime import date
from unittest import mock

from django.test import TestCase, override_settings

from . import approval_workflow as approval
from . import whatsapp_hod, whatsapp_service
from . import whatsapp_catalog as catalog
from .jwt_utils import sign_token
from .models import (
    Department,
    DepartmentManager,
    Employee,
    HRUser,
    LeaveRequest,
    ManagerDepartmentAssignment,
    MobileMessageSettings,
    WhatsAppMessageLog,
    WhatsAppSettings,
)

LIVE = dict(WACLIENT_INSTANCE_ID="I1", WACLIENT_ACCESS_TOKEN="tok", WHATSAPP_ALLOW_SENDING=True)


def ok_answer(*args, **kwargs):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WA1"}}}
    return r


@override_settings(**LIVE)
class World(TestCase):
    def setUp(self):
        super().setUp()
        self.sewing = Department.objects.create(name="Sewing")
        self.head = Employee.objects.create(
            employee_code="H1", first_name="Suresh", last_name="R", status="active", phone="9876543210"
        )
        self.asha = Employee.objects.create(
            employee_code="E1", first_name="Asha", last_name="K", status="active", phone="9123456780",
            department=self.sewing,
        )  # fmt: skip
        m = DepartmentManager.objects.create(employee=self.head)
        ManagerDepartmentAssignment.objects.create(manager=m, department=self.sewing)
        self.leave = LeaveRequest.objects.create(
            employee=self.asha,
            type="sick",
            start_date=date(2026, 11, 20),
            end_date=date(2026, 11, 21),
            total_days=2,
            reason="Fever",
        )
        self.post = mock.patch("api.whatsapp_service.requests.post", side_effect=ok_answer).start()
        self.addCleanup(mock.patch.stopall)

    def waiting(self):
        return WhatsAppMessageLog.objects.filter(document_type="hod_request_waiting")

    def switch(self, **kw):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults=kw)


class SectionTests(World):
    def test_the_section_and_its_switches_are_on_whatsapp_control(self):
        admin = HRUser.objects.create(username="hod_admin", password_hash="x", is_super_admin=True)
        h = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id, 'name': 'a'})}"}
        body = self.client.get("/api/whatsapp-control/settings", **h).json()
        self.assertIn("hod", [g["key"] for g in body["groups"]])
        hod = {f["key"]: f for f in body["features"] if f["group"] == "hod"}
        self.assertEqual(
            {k: v["enabled"] for k, v in hod.items()},
            {
                "hodNotificationsEnabled": True,
                "hodRequestWaitingEnabled": False,  # a new message to every head starts off
                "type:hod_pending_reminder": True,
            },
        )
        res = self.client.put(
            "/api/whatsapp-control/settings", {"hodRequestWaitingEnabled": True}, content_type="application/json", **h
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(WhatsAppSettings.get().hod_request_waiting_enabled)

    def test_the_reminder_belongs_to_the_section_not_to_approvals(self):
        self.assertEqual(catalog.TYPES["hod_pending_reminder"].module, "hod")
        self.switch(approval_notifications_enabled=False)  # the employees' approval messages: not the heads'
        self.assertIsNone(whatsapp_service.switch_off_reason("hod_pending_reminder"))
        self.switch(hod_notifications_enabled=False)
        self.assertIn("Department Heads", whatsapp_service.switch_off_reason("hod_pending_reminder"))


class RequestWaitingTests(World):
    def test_off_until_hr_switches_it_on(self):
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        self.assertFalse(self.waiting().exists())

    def test_the_head_gets_one_message_with_the_requests_details(self):
        self.switch(hod_request_waiting_enabled=True)
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)  # told again: still one
        row = self.waiting().get()
        self.assertEqual((row.employee, row.phone_number, row.status), (self.head, "919876543210", "sent"))
        for needle in ("Dear Suresh R", "Asha K (E1)", "20 Nov 2026", "Fever", "Approvals"):
            self.assertIn(needle, row.message_text)

    def test_the_whatsapp_does_not_follow_the_phone_settings(self):
        self.switch(hod_request_waiting_enabled=True)
        MobileMessageSettings.objects.update_or_create(
            pk=1, defaults={"push_enabled": False, "recipient_mode": "production"}
        )
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        self.assertEqual(self.waiting().count(), 1)

    def test_the_section_master_switch_stops_it(self):
        self.switch(hod_request_waiting_enabled=True, hod_notifications_enabled=False)
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        self.assertFalse(self.waiting().exists())

    def test_a_request_without_a_summary_builder_uses_what_the_caller_gives(self):
        self.switch(hod_request_waiting_enabled=True)
        whatsapp_hod.request_waiting(
            self.head, "on_duty", self.asha, "On-Duty request", None, request_type="On-Duty", details="At Erode mill"
        )
        row = self.waiting().get()
        self.assertIn("*On-Duty* request waiting", row.message_text)
        self.assertIn("At Erode mill", row.message_text)
