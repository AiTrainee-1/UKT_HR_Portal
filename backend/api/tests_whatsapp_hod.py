"""
WhatsApp Control -> Department Head notifications (owner 2026-11-17: "HOD notifications are not working, and there is no
option to enable or configure them"): the section's master switch, the "New request waiting for approval" message (off
until HR switches it on), the scheduled reminder moved into the section, and the message reaching the head wherever a
request reaches their step. WhatsApp is independent of the head's phone notification.

Run via: python manage.py test api.tests_whatsapp_hod --keepdb
"""

from datetime import date

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
from .tests_whatsapp_support import META, FakeMeta, approve_templates


@override_settings(**META)
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
        self.meta = FakeMeta.install(self)  # Meta's Graph API, faked: nothing leaves the machine
        approve_templates("hod_request_waiting", "hod_pending_reminder")

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
        # what went to Meta: the approved template and its named variables, one line each
        sent = self.meta.last()
        self.assertEqual((sent["to"], sent["template"]), ("919876543210", "hrms_hod_request_waiting"))
        self.assertEqual(row.template_name, "hrms_hod_request_waiting")
        self.assertEqual(
            {k: sent["params"][k] for k in ("hod_name", "employee_name", "employee_code", "request_type", "reason")},
            {
                "hod_name": "Suresh R",
                "employee_name": "Asha K",
                "employee_code": "E1",
                "request_type": "Leave",
                "reason": "Fever",
            },
        )
        self.assertLessEqual(set(sent["params"]), set(catalog.get("hod_request_waiting").variable_names))

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
        self.assertEqual(self.meta.last()["params"]["details"], "At Erode mill")
        self.assertEqual(self.meta.last()["params"]["time"], "-")  # a template can't drop a line: "-" for nothing


class MetaTemplateTests(World):
    def test_a_reason_typed_over_several_lines_goes_on_one_line(self):
        self.switch(hod_request_waiting_enabled=True)
        self.leave.reason = "Fever\n\tand   a cold"
        self.leave.save()
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        self.assertEqual(self.meta.last()["params"]["reason"], "Fever and a cold")
        for value in self.meta.last()["params"].values():
            self.assertNotIn("\n", value)

    def test_without_an_approved_template_nothing_reaches_meta_and_the_log_says_why(self):
        self.switch(hod_request_waiting_enabled=True)
        approve_templates("hod_request_waiting", status="PENDING")
        approval.notify_hod_of_request("leave", self.asha, "leave request", self.leave)
        row = self.waiting().get()
        self.assertEqual(row.status, "skipped")
        self.assertIn("hrms_hod_request_waiting", row.error_message)
        self.assertIn("PENDING", row.error_message)
        self.assertEqual(self.meta.sent, [])
