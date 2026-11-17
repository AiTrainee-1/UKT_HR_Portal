"""
Phone Notify Control (owner 2026-11-17, /hr/phone-notify-control): every phone notification the HRMS sends has a kind with
its own switch (also the ones that never go by WhatsApp), an employee can be muted, a failed push can be pushed again, a
phone can be removed, and the page shows how delivery is doing. The permission key takes Mobile App Login's level when
nothing is set on it.

Run via: python manage.py test api.tests_phone_notify_control --keepdb
"""

from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import mobile_messages
from .jwt_utils import sign_token
from .models import (
    Branch,
    Employee,
    HRUser,
    MobileMessageSettings,
    Notification,
    PushOptOut,
    PushToken,
    Role,
)

BASE = "/api/mobile-app/messages"
EXPO = "api.signals.requests.post"


def bearer(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"}


def ok(post):
    post.return_value = mock.Mock(ok=True, status_code=200, json=lambda: {"data": [{"status": "ok"}]})


class World(TestCase):
    def setUp(self):
        super().setUp()
        self.admin = HRUser.objects.create(username="pn_admin", password_hash="x", is_super_admin=True)
        self.h = bearer(self.admin)
        self.emp = Employee.objects.create(
            employee_code="PN1", first_name="Asha", last_name="Kumar", employment_type="staff", status="active"
        )
        self.phone = PushToken.objects.create(employee=self.emp, token="ExponentPushToken[pn1]")

    def notify(self, **kw):
        with mock.patch(EXPO) as post:
            ok(post)
            n = Notification.objects.create(employee=self.emp, message="Hello", **kw)
        n.refresh_from_db()
        return n, post


class EverySenderHasAKindTests(World):
    def test_approval_progress_and_waiting_carry_their_kind_and_workflow(self):
        outcome = approval.Outcome(kind="advanced", role=approval.HOD, decision="approved", waiting=(approval.HR,))
        with mock.patch(EXPO) as post:
            ok(post)
            n = approval.stage_notice(self.emp, "leave", "Approved by your Department Head; now with HR.", outcome)
        self.assertEqual((n.source, n.related_module), ("approval_progress", "leave"))
        with mock.patch(EXPO) as post:
            ok(post)
            n = approval.stage_notice(self.emp, "compensation", "x", outcome)
        self.assertEqual((n.source, n.related_module), ("approval_progress", "holiday_work"))
        self.assertEqual(mobile_messages.workflow_module("on_duty"), "")
        self.assertEqual(mobile_messages.workflow_module("attendance"), "attendance_correction")

    def test_an_hr_notice_through_the_api_is_its_own_kind(self):
        with mock.patch(EXPO) as post:
            ok(post)
            res = self.client.post(
                "/api/notifications",
                {"employeeId": self.emp.pk, "message": "Bring your ID card", "type": "general"},
                content_type="application/json",
                **self.h,
            )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(Notification.objects.get().source, "hr_notice")

    def test_the_controls_list_every_kind_with_where_it_comes_from_and_its_numbers(self):
        self.notify(source="approval_waiting", related_module="leave")
        body = self.client.get(f"{BASE}/controls", **self.h).json()
        rows = {r["key"]: r for r in body["controls"]}
        for key in (
            "approval_waiting",
            "approval_progress",
            "request_update",
            "on_duty_auto_end",
            "hr_notice",
            "salary_paid",
            "approval_reminder",
            "late_alert",
            "approval:leave",
        ):
            self.assertIn(key, rows, key)
        waiting = rows["approval_waiting"]
        self.assertEqual((waiting["audience"], waiting["group"]), ("approver", "approvals"))
        self.assertNotIn("origin", waiting)  # Phone Notify Control's own list: no WhatsApp origin (2026-11-17)
        keys = {r["key"] for r in body["controls"]}
        self.assertFalse({"attendance_report", "visitor_contact"} & keys)  # WhatsApp-only messages are not phone kinds
        self.assertTrue(waiting["sentFrom"])
        self.assertEqual((waiting["stats"]["total"], waiting["stats"]["sent"]), (1, 1))
        self.assertEqual(rows["approval:leave"]["stats"]["total"], 1)


class SwitchesAndMuteTests(World):
    def test_a_kind_and_a_workflow_switched_off_stop_the_push_with_the_reason(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["approval_waiting"]})
        n, post = self.notify(source="approval_waiting")
        self.assertEqual((n.push_status, post.call_count), ("off", 0))
        self.assertIn("switched off", n.push_error)
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["approval:leave"]})
        n, _post = self.notify(source="approval_progress", related_module="leave")
        self.assertEqual(n.push_status, "off")
        self.assertIn("workflow", n.push_error)

    def test_a_muted_employee_gets_no_push_but_keeps_the_in_app_record(self):
        res = self.client.put(
            f"{BASE}/devices/{self.emp.pk}/mute", {"muted": True}, content_type="application/json", **self.h
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["muted"], res.json()["mutedBy"]), (True, "pn_admin"))
        n, post = self.notify(source="late_alert")
        self.assertEqual((n.push_status, post.call_count), ("off", 0))
        self.assertIn("muted", n.push_error)
        listed = self.client.get(f"{BASE}/devices", {"muted": "1"}, **self.h).json()
        items = listed["items"] if isinstance(listed, dict) else listed
        self.assertEqual([r["id"] for r in items], [self.emp.pk])
        self.assertEqual(items[0]["phones"][0]["id"], self.phone.pk)
        self.client.put(
            f"{BASE}/devices/{self.emp.pk}/mute", {"muted": False}, content_type="application/json", **self.h
        )
        self.assertFalse(PushOptOut.objects.exists())
        n, post = self.notify(source="late_alert")
        self.assertEqual(n.push_status, "sent")


class PushAgainPhonesConfigTests(World):
    def test_push_again_after_a_failure_and_what_it_refuses(self):
        with mock.patch(EXPO, side_effect=OSError("down")):
            n = Notification.objects.create(employee=self.emp, message="Hello", source="late_alert")
        n.refresh_from_db()
        self.assertEqual(n.push_status, "failed")
        log = self.client.get(f"{BASE}/log", {"page": 1}, **self.h).json()
        self.assertTrue(log["items"][0]["canPushAgain"])
        with mock.patch(EXPO) as post:
            ok(post)
            res = self.client.post(f"{BASE}/log/{n.pk}/push-again", **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["pushStatus"], res.json()["canPushAgain"]), ("sent", False))
        again = self.client.post(f"{BASE}/log/{n.pk}/push-again", **self.h)
        self.assertEqual(again.status_code, 400)  # already sent
        Notification.objects.filter(pk=n.pk).update(push_status="no_device")
        PushToken.objects.all().delete()
        res = self.client.post(f"{BASE}/log/{n.pk}/push-again", **self.h)
        self.assertEqual(res.status_code, 400)
        self.assertIn("no phone", res.json()["error"])

    def test_remove_a_phone(self):
        res = self.client.delete(f"{BASE}/devices/phones/{self.phone.pk}", **self.h)
        self.assertEqual(res.status_code, 204)
        self.assertFalse(PushToken.objects.exists())
        self.assertEqual(self.client.delete(f"{BASE}/devices/phones/{self.phone.pk}", **self.h).status_code, 404)

    def test_config_health_names_the_firebase_problem(self):
        body = self.client.get(f"{BASE}/config", **self.h).json()
        self.assertEqual(body["health"]["state"], "unknown")
        self.assertEqual(body["service"]["transport"], "Firebase Cloud Messaging (Android)")
        Notification.objects.bulk_create(
            [
                Notification(
                    employee=self.emp,
                    message="x",
                    push_status="failed",
                    push_error="InvalidCredentials: Expo has no Firebase (FCM) key for this app",
                )
            ]
        )
        body = self.client.get(f"{BASE}/config", **self.h).json()
        self.assertEqual(body["health"]["state"], "problem")
        self.assertEqual(body["health"]["failureReasons"][0]["reason"], "InvalidCredentials")
        self.assertEqual(body["phones"]["employeesWithPhone"], 1)


class PermissionTests(World):
    def role_user(self, permissions, name):
        role = Role.objects.create(name=f"pn {name}", permissions=permissions)
        return HRUser.objects.create(username=f"pn_{name}", password_hash="x", role=role)

    def test_it_follows_mobile_app_login_until_set_and_its_own_key_wins(self):
        viewer = self.role_user({"mobile_app_login": "view"}, "viewer")
        self.assertEqual(self.client.get(f"{BASE}/overview", **bearer(viewer)).status_code, 200)
        res = self.client.put(
            f"{BASE}/controls", {"pushEnabled": False}, content_type="application/json", **bearer(viewer)
        )
        self.assertEqual(res.status_code, 403)
        hidden = self.role_user({"mobile_app_login": "edit", "phone_notify_control": "hidden"}, "hidden")
        self.assertEqual(self.client.get(f"{BASE}/overview", **bearer(hidden)).status_code, 403)
        editor = self.role_user({"phone_notify_control": "edit"}, "editor")
        res = self.client.put(
            f"{BASE}/controls", {"pushEnabled": False}, content_type="application/json", **bearer(editor)
        )
        self.assertEqual(res.status_code, 200, res.content)

    def test_a_branch_login_only_reaches_its_branch(self):
        north = Branch.objects.create(name="North", code="PNN")
        user = self.role_user({"phone_notify_control": "edit"}, "branch")
        user.branch = north
        user.save()
        res = self.client.put(
            f"{BASE}/devices/{self.emp.pk}/mute", {"muted": True}, content_type="application/json", **bearer(user)
        )
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.client.delete(f"{BASE}/devices/phones/{self.phone.pk}", **bearer(user)).status_code, 404)
