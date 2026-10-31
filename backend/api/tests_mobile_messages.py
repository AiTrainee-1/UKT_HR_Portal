"""Mobile Messages (Mobile App Login -> Mobile Messages): the switches over what is pushed to phones, what happens to each push
(sent / no phone / switched off / failed), and the HR endpoints (overview, controls, log, devices, send)."""

import json
from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from . import mobile_messages, push_messages, push_receipts
from .jwt_utils import sign_token
from .models import AuditLog, Employee, HRUser, MobileMessageSettings, Notification, PushToken

BASE = "/api/mobile-app/messages"
EXPO = "api.signals.requests.post"


def _hr():
    user, _ = HRUser.objects.get_or_create(
        username="mm_admin", defaults={"password_hash": "x", "is_super_admin": True, "role": None}
    )
    token = sign_token({"role": "hr", "hrUserId": user.id, "name": "mm_admin"})
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def _employee(code="M1", phone="9000000001", first="Asha") -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name=first, last_name="Kumar", employment_type="staff", status="active", phone=phone
    )


def _ok(post):
    post.return_value = mock.Mock(ok=True, status_code=200, json=lambda: {"data": [{"status": "ok"}]})


class PushSwitchesTests(TestCase):
    def setUp(self):
        self.emp = _employee()
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[abc]")

    def announce(self, doc="late_alert", module="", key=""):
        return push_messages.announce(
            self.emp, doc, "⏰ *Late Attendance*\n\nHi.", related_module=module, dedupe_key=key
        )

    def status(self, n) -> str:
        n.refresh_from_db()
        return n.push_status

    def test_a_push_is_sent_to_the_phone_and_the_row_says_so(self):
        with mock.patch(EXPO) as post:
            _ok(post)
            n = self.announce()
        self.assertEqual((post.call_count, self.status(n)), (1, "sent"))
        self.assertIsNotNone(Notification.objects.get(pk=n.pk).pushed_at)
        self.assertEqual((n.source, n.related_module), ("late_alert", ""))

    def test_an_employee_with_no_phone_registered_is_recorded_as_such(self):
        PushToken.objects.all().delete()
        with mock.patch(EXPO) as post:
            n = self.announce()
        self.assertEqual((post.call_count, self.status(n)), (0, "no_device"))

    def test_expo_refusing_or_the_network_failing_is_recorded_as_failed_with_the_reason(self):
        with mock.patch(EXPO, side_effect=OSError("no route")):
            n = self.announce()
        n.refresh_from_db()
        self.assertEqual(n.push_status, "failed")
        self.assertIn("no route", n.push_error)
        with mock.patch(EXPO) as post:
            post.return_value = mock.Mock(ok=False, status_code=500, json=lambda: {})
            n2 = self.announce(key="b")
        n2.refresh_from_db()
        self.assertEqual((n2.push_status, n2.push_error), ("failed", "Expo answered 500"))

    def test_the_master_switch_stops_every_push_but_the_in_app_record_is_still_saved(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"push_enabled": False})
        with mock.patch(EXPO) as post:
            n = self.announce()
        self.assertEqual((post.call_count, self.status(n)), (0, "off"))
        self.assertTrue(Notification.objects.filter(pk=n.pk).exists())

    def test_one_kind_of_message_can_be_switched_off_alone(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["late_alert"]})
        with mock.patch(EXPO) as post:
            _ok(post)
            late = self.announce("late_alert")
            absent = self.announce("absent_alert", key="x")
        self.assertEqual((self.status(late), self.status(absent)), ("off", "sent"))
        self.assertEqual(post.call_count, 1)

    def test_an_approval_workflow_can_be_switched_off_without_the_others(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["approval:leave"]})
        with mock.patch(EXPO) as post:
            _ok(post)
            leave = self.announce("approval_approved", "leave", "a")
            permission = self.announce("approval_approved", "permission", "b")
        self.assertEqual((self.status(leave), self.status(permission)), ("off", "sent"))

    def test_a_message_from_hr_and_an_older_notice_obey_only_the_master_switch(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["late_alert"]})
        self.assertTrue(mobile_messages.push_allowed(mobile_messages.MANUAL))
        self.assertTrue(mobile_messages.push_allowed(""))
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"push_enabled": False})
        self.assertFalse(mobile_messages.push_allowed(mobile_messages.MANUAL))
        self.assertFalse(mobile_messages.push_allowed(""))

    def test_the_controls_never_list_a_one_time_code(self):
        keys = {row["key"] for row in mobile_messages.controls()}
        self.assertFalse(keys & push_messages.EXCLUDED_TYPES)
        for needed in ("late_alert", "approval_approved", "salary_slip", "visitor_notification", "approval:leave"):
            self.assertIn(needed, keys)


class ControlsEndpointTests(TestCase):
    def test_get_lists_every_switch_on_by_default(self):
        r = self.client.get(f"{BASE}/controls", **_hr())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["pushEnabled"])
        self.assertTrue(all(row["enabled"] for row in body["controls"]))
        self.assertEqual({row["kind"] for row in body["controls"]}, {"message", "workflow"})

    def test_put_changes_the_master_and_single_switches_and_is_audited(self):
        r = self.client.put(
            f"{BASE}/controls",
            {"pushEnabled": False, "types": {"late_alert": False, "approval:leave": False}},
            content_type="application/json",
            **_hr(),
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["pushEnabled"])
        off = {row["key"] for row in body["controls"] if not row["enabled"]}
        self.assertEqual(off, {"late_alert", "approval:leave"})
        self.assertEqual(body["updatedBy"], "mm_admin")
        self.assertEqual(AuditLog.objects.filter(module="mobile_app_login", action="update").count(), 1)
        # switching one back on
        r = self.client.put(
            f"{BASE}/controls", {"types": {"late_alert": True}}, content_type="application/json", **_hr()
        )
        self.assertEqual({row["key"] for row in r.json()["controls"] if not row["enabled"]}, {"approval:leave"})

    def test_bad_input_is_refused_and_nothing_changes(self):
        for body in (
            {},
            {"pushEnabled": "yes"},
            {"types": []},
            {"types": {"nonsense": True}},
            {"types": {"otp_login": False}},
            {"types": {"late_alert": "no"}},
        ):
            r = self.client.put(f"{BASE}/controls", body, content_type="application/json", **_hr())
            self.assertEqual(r.status_code, 400, body)
        self.assertEqual(MobileMessageSettings.get().disabled_types, [])

    def test_an_employee_token_is_refused(self):
        emp = _employee()
        token = sign_token({"role": "employee", "employeeId": emp.id})
        for method, path in (("get", "controls"), ("get", "overview"), ("get", "log"), ("get", "devices")):
            r = getattr(self.client, method)(f"{BASE}/{path}", HTTP_AUTHORIZATION=f"Bearer {token}")
            self.assertEqual(r.status_code, 403, path)


class LogOverviewDevicesSendTests(TestCase):
    def setUp(self):
        self.asha = _employee("M1", "9000000001", "Asha")
        self.ravi = _employee("M2", "9000000002", "Ravi")
        PushToken.objects.create(employee=self.asha, token="ExponentPushToken[a]")
        with mock.patch(EXPO) as post:
            _ok(post)
            push_messages.announce(self.asha, "late_alert", "⏰ *Late Attendance*\n\nHi Asha.", dedupe_key="l1")
            push_messages.announce(
                self.ravi,
                "approval_rejected",
                "❌ *Request Rejected*\n\nSorry.",
                related_module="leave",
                dedupe_key="r1",
            )

            Notification.objects.create(
                employee=self.asha, type="leave", message="Your leave request was approved by your Department Head."
            )

    def log(self, **q):
        r = self.client.get(f"{BASE}/log", q, **_hr())
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_the_log_shows_every_notification_with_what_happened_to_its_push(self):
        rows = self.log()
        self.assertEqual(len(rows), 3)
        by_name = {(r["employeeName"], r["kind"]): r for r in rows}
        late = by_name[("Asha Kumar", "Late Attendance Alert")]
        self.assertEqual((late["title"], late["pushStatus"], late["isRead"]), ("⏰ Late Attendance", "sent", False))
        rejected = by_name[("Ravi Kumar", "Approval - Rejected: Leave")]
        self.assertEqual(rejected["pushStatus"], "no_device")
        older = by_name[("Asha Kumar", "In-app notice")]
        self.assertEqual(
            (older["pushStatus"], older["pushStatusLabel"]), ("sent", "Sent (waiting for the push service)")
        )

    def test_the_log_filters(self):
        self.assertEqual(len(self.log(status="no_device")), 1)
        self.assertEqual(len(self.log(kind="late_alert")), 1)
        self.assertEqual(len(self.log(kind="older")), 1)
        self.assertEqual(len(self.log(search="ravi")), 1)
        self.assertEqual(len(self.log(search="sorry")), 1)
        Notification.objects.filter(employee=self.ravi).update(is_read=True)
        self.assertEqual(len(self.log(read="read")), 1)
        self.assertEqual(len(self.log(read="unread")), 2)
        r = self.client.get(f"{BASE}/log", {"status": "bogus"}, **_hr())
        self.assertEqual(r.status_code, 400)
        paged = self.log(page=1, pageSize=2)
        self.assertEqual((paged["total"], len(paged["items"])), (3, 2))

    def test_the_overview_counts_devices_and_pushes(self):
        r = self.client.get(f"{BASE}/overview", **_hr())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            body["devices"], {**body["devices"], "employees": 2, "withDevice": 1, "withoutDevice": 1, "tokens": 1}
        )
        self.assertEqual(body["today"]["total"], 3)
        self.assertEqual((body["today"]["sent"], body["today"]["noDevice"]), (2, 1))
        self.assertEqual(len(body["byDay"]), 14)
        self.assertEqual(body["byDay"][-1]["total"], 3)
        self.assertEqual(
            {k["label"] for k in body["byKind"]},
            {"Late Attendance Alert", "Approval - Rejected: Leave", "In-app notice"},
        )
        self.assertTrue(body["pushEnabled"])

    def test_the_devices_list_says_who_can_receive_a_push(self):
        r = self.client.get(f"{BASE}/devices", {"has": "without"}, **_hr())
        self.assertEqual([e["employeeCode"] for e in r.json()], ["M2"])
        r = self.client.get(f"{BASE}/devices", {"has": "with"}, **_hr())
        self.assertEqual([(e["employeeCode"], e["devices"]) for e in r.json()], [("M1", 1)])
        self.assertEqual(len(self.client.get(f"{BASE}/devices", {"search": "9000000002"}, **_hr()).json()), 1)

    def test_hr_can_send_one_message_to_one_employee_and_the_push_result_comes_back(self):
        with mock.patch(EXPO) as post:
            _ok(post)
            r = self.client.post(
                f"{BASE}/send",
                {"employeeId": self.asha.id, "title": "Test", "message": "Does this reach your phone?"},
                content_type="application/json",
                **_hr(),
            )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["title"], body["kind"], body["pushStatus"]), ("Test", "Message from HR", "sent"))
        sent = post.call_args.kwargs["json"][0]
        self.assertEqual((sent["title"], sent["body"]), ("Test", "Does this reach your phone?"))
        self.assertEqual(AuditLog.objects.filter(module="mobile_app_login", action="create").count(), 1)

    def test_a_bad_send_is_refused(self):
        for body, status in (
            ({"employeeId": 99999, "title": "a", "message": "b"}, 404),
            ({"title": "a", "message": "b"}, 404),
            ({"employeeId": self.asha.id, "title": "", "message": "b"}, 400),
            ({"employeeId": self.asha.id, "title": "a", "message": ""}, 400),
            ({"employeeId": self.asha.id, "title": "x" * 61, "message": "b"}, 400),
            ({"employeeId": self.asha.id, "title": "a", "message": "y" * 501}, 400),
        ):
            r = self.client.post(f"{BASE}/send", body, content_type="application/json", **_hr())
            self.assertEqual(r.status_code, status, body)
        self.assertEqual(Notification.objects.filter(source="manual").count(), 0)


class ReceiptTests(TestCase):
    """Expo's receipts say whether Google / Apple accepted a push: a "sent" that was refused becomes "failed" with the reason."""

    def setUp(self):
        self.emp = _employee()
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[abc]")

    def push(self, key="k1"):
        with mock.patch(EXPO) as post:
            post.return_value = mock.Mock(
                ok=True, status_code=200, json=lambda: {"data": [{"status": "ok", "id": "T-1"}]}
            )
            n = push_messages.announce(self.emp, "late_alert", "\u23f0 *Late Attendance*\n\nHi.", dedupe_key=key)
        n.refresh_from_db()
        return n

    def age(self, n):
        Notification.objects.filter(pk=n.pk).update(pushed_at=timezone.now() - timedelta(minutes=5))

    def receipts(self, data):
        return mock.patch(
            "api.push_receipts.requests.post",
            return_value=mock.Mock(ok=True, json=lambda: {"data": data}),
        )

    def test_the_ticket_is_kept_with_its_token(self):
        n = self.push()
        self.assertEqual((n.push_status, json.loads(n.push_tickets)), ("sent", [["ExponentPushToken[abc]", "T-1"]]))

    def test_nothing_is_asked_for_a_minute_after_the_send(self):
        self.push()
        with self.receipts({}) as post:
            self.assertEqual(push_receipts.check_pending(), 0)
        post.assert_not_called()

    def test_an_accepted_push_becomes_delivered(self):
        n = self.push()
        self.age(n)
        with self.receipts({"T-1": {"status": "ok"}}) as post:
            self.assertEqual(push_receipts.check_pending(), 1)
        self.assertEqual(post.call_args.kwargs["json"], {"ids": ["T-1"]})
        n.refresh_from_db()
        self.assertEqual((n.push_status, n.push_error, n.push_tickets), ("delivered", "", ""))

    def test_a_push_google_refused_becomes_failed_with_the_reason_the_firebase_key_is_missing(self):
        n = self.push()
        self.age(n)
        refusal = {
            "status": "error",
            "message": "Unable to retrieve the FCM server key",
            "details": {"error": "InvalidCredentials"},
        }
        with self.receipts({"T-1": refusal}):
            push_receipts.check_pending()
        n.refresh_from_db()
        self.assertEqual(n.push_status, "failed")
        self.assertIn("Firebase", n.push_error)
        self.assertTrue(
            PushToken.objects.filter(token="ExponentPushToken[abc]").exists()
        )  # a credentials problem is not the phone's

    def test_a_phone_that_removed_the_app_loses_its_token(self):
        n = self.push()
        self.age(n)
        gone = {"status": "error", "message": "not registered", "details": {"error": "DeviceNotRegistered"}}
        with self.receipts({"T-1": gone}):
            push_receipts.check_pending()
        self.assertFalse(PushToken.objects.filter(token="ExponentPushToken[abc]").exists())
        n.refresh_from_db()
        self.assertEqual(n.push_status, "failed")

    def test_a_receipt_that_is_not_ready_is_asked_for_again_later(self):
        n = self.push()
        self.age(n)
        with self.receipts({}):
            self.assertEqual(push_receipts.check_pending(), 0)
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")
        with self.receipts({"T-1": {"status": "ok"}}):
            self.assertEqual(push_receipts.check_pending(), 1)

    def test_expo_being_down_changes_nothing_and_raises_nothing(self):
        n = self.push()
        self.age(n)
        with mock.patch("api.push_receipts.requests.post", side_effect=OSError("down")):
            self.assertEqual(push_receipts.check_pending(), 0)
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")

    def test_the_overview_and_log_read_the_receipts_when_hr_looks(self):
        n = self.push()
        self.age(n)
        with self.receipts({"T-1": {"status": "ok"}}):
            body = self.client.get(f"{BASE}/overview", **_hr()).json()
        self.assertEqual((body["today"]["sent"], body["today"]["delivered"]), (1, 1))
        rows = self.client.get(f"{BASE}/log", **_hr()).json()
        self.assertEqual((rows[0]["pushStatus"], rows[0]["pushStatusLabel"]), ("delivered", "Delivered to the phone"))
