"""
Phone push delivery (owner 2026-11-17: "manual send works, automatic and chat do not").

Root cause: the push ran INSIDE the post_save of the Notification, i.e. inside the transaction that made it. Every automatic
notification is made in a transaction (push_messages.announce, the approval workflows), so one failed query in the push code
(the employee-mute table before its migration ran, a lost connection, ...) poisoned that transaction and the notification
itself was rolled back: no record, no push. The manual send made its row outside a transaction, so it survived.

Also here: the internal chat reaching phones (chat_push.py) and the attendance alerts reaching phones when WhatsApp does not
send them (whatsapp_alerts.Channels).

Run via: python manage.py test api.tests_push_delivery --keepdb
"""

from datetime import timedelta
from unittest import mock

from django.db import connection, transaction
from django.test import TestCase, override_settings
from django.utils import timezone

from . import chat_push, push_delivery, push_messages
from .jwt_utils import sign_token
from .models import (
    Branch,
    ChatChannel,
    ChatMessage,
    Department,
    Employee,
    HRUser,
    MobileMessageSettings,
    Notification,
    PushOptOut,
    PushToken,
    WhatsAppMessageLog,
)
from .tests_whatsapp_alerts import WED, AlertBase, _switches, at

EXPO = "api.signals.requests.post"


def ok(post):
    post.side_effect = expo_ok


def expo_ok(*args, **kwargs):
    count = len(kwargs.get("json") or [])
    return mock.Mock(
        ok=True, status_code=200, json=lambda: {"data": [{"status": "ok", "id": f"tk{i}"} for i in range(count)]}
    )


def broken_read(*args, **kwargs):
    """What a missing table (migration not applied yet) does to the push code: a database error that aborts the transaction."""
    with connection.cursor() as cur:
        cur.execute("SELECT 1 FROM table_that_is_not_there")


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class World(TestCase):
    def setUp(self):
        super().setUp()
        self.emp = Employee.objects.create(
            employee_code="PD1", first_name="Asha", last_name="Kumar", employment_type="staff", status="active"
        )
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[pd1]")


class AutomaticNotificationSurvivesPushErrors(World):
    def test_a_database_error_in_the_push_code_never_loses_the_notification(self):
        with (
            mock.patch.object(PushOptOut.objects, "filter", side_effect=broken_read),
            mock.patch(EXPO) as post,
            self.captureOnCommitCallbacks(execute=True),
        ):
            ok(post)
            n = push_messages.announce(
                self.emp, "approval_approved", params={"request_type": "Leave"}, dedupe_key="pd-1"
            )
        self.assertIsNotNone(n)
        self.assertTrue(Notification.objects.filter(pk=n.pk).exists())
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")
        post.assert_called_once()

    def test_unreadable_switches_push_as_usual(self):
        with (
            mock.patch.object(MobileMessageSettings, "get", side_effect=broken_read),
            mock.patch(EXPO) as post,
        ):
            ok(post)
            with transaction.atomic():
                n = Notification.objects.create(employee=self.emp, title="Hi", message="There")
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")


class PushAfterCommitTests(World):
    """The real (threaded) path, with the queue run in place of its thread."""

    def setUp(self):
        super().setUp()
        for p in (
            mock.patch("api.push_delivery.inline_mode", return_value=False),
            mock.patch("api.push_delivery._enqueue", side_effect=push_delivery.push),
        ):
            p.start()
            self.addCleanup(p.stop)

    def test_the_push_waits_for_the_commit(self):
        with mock.patch(EXPO) as post:
            ok(post)
            with self.captureOnCommitCallbacks(execute=True):
                n = Notification.objects.create(employee=self.emp, title="Leave approved", message="Enjoy")
                post.assert_not_called()
                n.refresh_from_db()
                self.assertEqual(n.push_status, "")
            post.assert_called_once()
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")
        self.assertEqual(post.call_args.kwargs["json"][0]["title"], "Leave approved")

    def test_a_notification_that_was_rolled_back_is_never_pushed(self):
        with mock.patch(EXPO) as post:
            ok(post)
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                try:
                    with transaction.atomic():
                        Notification.objects.create(employee=self.emp, message="Never happened")
                        raise RuntimeError("the approval failed")
                except RuntimeError:
                    pass
            post.assert_not_called()
        self.assertEqual(callbacks, [])


class BatchAndOnceTests(World):
    def make(self, emp=None, **kw):
        # bulk_create sends no post_save: these wait until push() is called
        return Notification.objects.bulk_create([Notification(employee=emp or self.emp, message="m", **kw)])[0]

    def test_expo_gets_at_most_a_hundred_messages_per_request(self):
        rows = []
        for i in range(120):
            e = Employee.objects.create(employee_code=f"PB{i}", first_name="E", last_name=str(i), status="active")
            PushToken.objects.create(employee=e, token=f"ExponentPushToken[pb{i}]")
            rows.append(Notification(employee=e, title="Hello", message="All"))
        ids = [n.pk for n in Notification.objects.bulk_create(rows)]
        with mock.patch(EXPO) as post:
            ok(post)
            out = push_delivery.push(ids)
        self.assertEqual([len(c.kwargs["json"]) for c in post.call_args_list], [100, 20])
        self.assertEqual(set(out.values()), {"sent"})
        self.assertEqual(Notification.objects.filter(pk__in=ids, push_status="sent").count(), 120)

    def test_a_notification_is_pushed_once_however_often_it_is_asked(self):
        n = self.make()
        with mock.patch(EXPO) as post:
            ok(post)
            self.assertEqual(push_delivery.push([n.pk]), {n.pk: "sent"})
            self.assertEqual(push_delivery.push([n.pk]), {})
        post.assert_called_once()

    def test_one_good_phone_is_enough_and_a_dead_one_is_forgotten(self):
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[dead]")
        n = self.make()

        def answer(*args, **kwargs):
            tickets = [
                {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}}
                if m["to"].endswith("[dead]")
                else {"status": "ok", "id": "tk-ok"}
                for m in kwargs["json"]
            ]
            return mock.Mock(ok=True, status_code=200, json=lambda: {"data": tickets})

        with mock.patch(EXPO, side_effect=answer):
            push_delivery.push([n.pk])
        n.refresh_from_db()
        self.assertEqual(n.push_status, "sent")
        self.assertFalse(PushToken.objects.filter(token="ExponentPushToken[dead]").exists())

    def test_expo_refusing_the_request_is_a_failed_push_with_the_reason(self):
        n = self.make()
        with mock.patch(EXPO, return_value=mock.Mock(ok=False, status_code=500, json=lambda: {})):
            push_delivery.push([n.pk])
        n.refresh_from_db()
        self.assertEqual((n.push_status, n.push_error), ("failed", "Expo answered 500"))

    def test_no_phone_and_switched_off_are_recorded(self):
        other = Employee.objects.create(employee_code="PD2", first_name="No", last_name="Phone", status="active")
        a, b = self.make(emp=other), self.make(source="salary_paid")
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["salary_paid"]})
        with mock.patch(EXPO) as post:
            ok(post)
            out = push_delivery.push([a.pk, b.pk])
        self.assertEqual(out, {a.pk: "no_device", b.pk: "off"})
        post.assert_not_called()

    def test_push_again_resends_a_failed_one(self):
        n = self.make(push_status="failed", push_error="x")
        with mock.patch(EXPO) as post:
            ok(post)
            self.assertEqual(push_delivery.push_again(n.pk), "sent")


class SweepTests(World):
    def test_the_sweep_sends_what_waits_and_closes_what_is_stuck(self):
        now = timezone.now()
        waiting, stale, stuck = Notification.objects.bulk_create(
            [Notification(employee=self.emp, message=m) for m in ("waiting", "stale", "stuck")]
        )
        Notification.objects.filter(pk=waiting.pk).update(created_at=now - timedelta(minutes=2))
        Notification.objects.filter(pk=stale.pk).update(created_at=now - timedelta(minutes=45))
        Notification.objects.filter(pk=stuck.pk).update(
            created_at=now - timedelta(minutes=20), push_status="sending", pushed_at=now - timedelta(minutes=15)
        )
        with mock.patch(EXPO) as post:
            ok(post)
            done = push_delivery.sweep(now)
        self.assertEqual(done, {"stuck": 1, "waiting": 1, "pushed": 1})
        for n, status in ((waiting, "sent"), (stale, ""), (stuck, "failed")):
            n.refresh_from_db()
            self.assertEqual(n.push_status, status, n.message)
        self.assertEqual(stuck.push_error, push_delivery.INTERRUPTED)


class ChatPushTests(TestCase):
    def setUp(self):
        super().setUp()
        self.b1 = Branch.objects.create(name="Unit A")
        self.b2 = Branch.objects.create(name="Unit B")
        self.cutting = Department.objects.create(name="Cutting", branch=self.b1)
        self.admin = HRUser.objects.create(username="chat_admin", password_hash="x", is_super_admin=True)
        self.hr = bearer({"role": "hr", "hrUserId": self.admin.id, "name": "UK Textiles HR"})

        def emp(code, branch, dept=None, phone=True):
            e = Employee.objects.create(
                employee_code=code, first_name=code, last_name="K", status="active", branch=branch, department=dept
            )
            if phone:
                PushToken.objects.create(employee=e, token=f"ExponentPushToken[{code}]")
            return e

        self.ravi = emp("RAVI", self.b1, self.cutting)
        self.meena = emp("MEENA", self.b1)
        self.nophone = emp("NOPH", self.b1, phone=False)
        self.other_unit = emp("OTHR", self.b2)
        self.no_branch = emp("NOBR", None)
        self.cutter = emp("CUTR", self.b1, self.cutting)
        self.post = mock.patch(EXPO).start()
        self.addCleanup(mock.patch.stopall)
        ok(self.post)

    def notes(self, **kw):
        return Notification.objects.filter(type="chat", **kw)

    def send(self, channel, text, auth, **extra):
        return self.client.post(
            f"/api/chat/channels/{channel.pk}/messages",
            {"text": text, **extra},
            content_type="application/json",
            **auth,
        )

    def test_an_hr_message_reaches_every_phone_of_the_branch(self):
        res = self.send(ChatChannel.get_company_channel(self.b1.pk), "Holiday on Friday", self.hr)
        self.assertEqual(res.status_code, 201, res.content)
        got = {n.employee.employee_code: n for n in self.notes()}
        self.assertEqual(set(got), {"RAVI", "MEENA", "CUTR"})
        n = got["MEENA"]
        self.assertEqual(
            (n.source, n.title, n.message, n.push_status),
            ("chat_announcement", "UK Textiles HR in Company chat", "Holiday on Friday", "sent"),
        )
        self.assertEqual(sum(len(c.kwargs["json"]) for c in self.post.call_args_list), 3)

    def test_an_employee_message_reaches_the_others_but_not_the_writer(self):
        res = self.send(
            ChatChannel.get_company_channel(self.b1.pk),
            "Lunch at 1",
            bearer({"role": "employee", "employeeId": self.ravi.pk}),
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(set(self.notes().values_list("employee__employee_code", flat=True)), {"MEENA", "CUTR"})
        self.assertEqual(set(self.notes().values_list("source", flat=True)), {"chat_message"})

    def test_a_reply_tells_the_person_replied_to(self):
        channel = ChatChannel.get_company_channel(self.b1.pk)
        first = ChatMessage.objects.create(channel=channel, sender=self.ravi, text="Who has the key?")
        res = self.send(
            channel, "I do", bearer({"role": "employee", "employeeId": self.meena.pk}), reply_to_id=first.pk
        )
        self.assertEqual(res.status_code, 201, res.content)
        ravi = self.notes().get(employee=self.ravi)
        self.assertEqual((ravi.source, ravi.title), ("chat_reply", "MEENA K replied to you"))
        self.assertEqual(self.notes().get(employee=self.cutter).source, "chat_message")

    def test_a_department_message_stays_in_the_department(self):
        channel = ChatChannel.get_department_channel(self.cutting)
        res = self.send(channel, "Machine 4 is down", bearer({"role": "employee", "employeeId": self.ravi.pk}))
        self.assertEqual(res.status_code, 201, res.content)
        n = self.notes().get()
        self.assertEqual((n.employee, n.source, n.title), (self.cutter, "chat_department", "RAVI K in Cutting chat"))

    def test_switches_and_mutes_are_respected(self):
        channel = ChatChannel.get_company_channel(self.b1.pk)
        PushOptOut.objects.create(employee=self.meena)
        self.send(channel, "One", self.hr)
        self.assertEqual(set(self.notes().values_list("employee__employee_code", flat=True)), {"RAVI", "CUTR"})
        Notification.objects.all().delete()
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["chat_announcement"]})
        self.send(channel, "Two", self.hr)
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": [], "push_enabled": False})
        self.send(channel, "Three", self.hr)
        self.assertFalse(self.notes().exists())
        self.assertEqual(ChatMessage.objects.filter(channel=channel).count(), 3)  # the chat itself is untouched

    def test_send_to_all_branches_reaches_every_employee_once(self):
        legacy = ChatChannel.get_company_channel(None)
        res = self.send(legacy, "Pay day is the 7th", self.hr, allBranches=True)
        self.assertEqual(res.status_code, 201, res.content)
        # every company channel: the unbranched one + one per active branch (the test database has a seeded one too)
        others = Branch.objects.filter(is_active=True).count()
        self.assertEqual(res.json()["alsoPostedIn"], others)
        self.assertEqual(ChatMessage.objects.filter(text="Pay day is the 7th").count(), others + 1)
        codes = list(self.notes().values_list("employee__employee_code", flat=True))
        self.assertEqual(sorted(codes), ["CUTR", "MEENA", "NOBR", "OTHR", "RAVI"])

    def test_only_an_unscoped_hr_account_can_send_to_all_branches(self):
        res = self.send(
            ChatChannel.get_company_channel(self.b1.pk),
            "x",
            bearer({"role": "employee", "employeeId": self.ravi.pk}),
            allBranches=True,
        )
        self.assertEqual(res.status_code, 400)
        self.assertFalse(ChatMessage.objects.exists())

    def test_an_attendance_notify_report_is_its_own_kind(self):
        channel = ChatChannel.get_company_channel(self.b1.pk)
        msg = ChatMessage.objects.create(
            channel=channel,
            sender_label="Attendance Notify",
            text="Attendance report - daily absent\n17 Nov 2026 - Staff\n\nAbsent: 3\nCL: 0",
            payload={"kind": "attendance_report", "rows": []},
        )
        chat_push.message_posted(msg.pk)
        n = self.notes().get(employee=self.meena)
        self.assertEqual((n.source, n.title), ("chat_report", "Attendance report - daily absent"))
        self.assertEqual(n.message, "17 Nov 2026 - Staff\nAbsent: 3\nCL: 0")

    def test_the_same_message_never_notifies_twice(self):
        msg = ChatMessage.objects.create(
            channel=ChatChannel.get_company_channel(self.b1.pk), sender_label="HR", text="Hi"
        )
        chat_push.announce(msg.pk)
        chat_push.announce(msg.pk)
        self.assertEqual(self.notes().count(), 3)


class PhoneAlertJobTests(AlertBase):
    """The phone attendance alerts are Phone Notify Control's own job (phone_alerts.py): its switches, its timing, never
    WhatsApp Control's, and the WhatsApp job makes no phone notification (the modules are independent, 2026-11-17)."""

    def setUp(self):
        super().setUp()
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[alert]")
        # AlertBase patched requests.post for WhatsApp; the same function carries the Expo pushes, so answer each its own way
        whatsapp_answer = self.post.return_value

        def route(*args, **kwargs):
            url = args[0] if args else kwargs.get("url", "")
            return expo_ok(**kwargs) if "exp.host" in url else whatsapp_answer

        self.post.side_effect = route

    def phone(self, h, m=0):
        from . import phone_alerts

        return phone_alerts.run_phone_alerts(now=at(WED, h, m))

    def whatsapp_calls(self):
        return [
            c for c in self.post.call_args_list if "exp.host" not in (c.args[0] if c.args else c.kwargs.get("url", ""))
        ]

    def absent_notes(self):
        return Notification.objects.filter(employee=self.emp, source="absent_alert")

    @override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN="")
    def test_the_phone_gets_the_alert_once_with_whatsapp_not_configured(self):
        self.assertEqual(self.phone(10, 0).get("absent_alert"), 1)
        self.assertFalse(WhatsAppMessageLog.objects.exists())
        n = self.absent_notes().get()
        self.assertEqual((n.push_status, n.title), ("sent", "No punch yet today"))
        self.assertIn("If you are at work, please punch in.", n.message)
        self.phone(10, 1)
        self.assertEqual(self.absent_notes().count(), 1)

    def test_whatsapp_alert_switches_do_not_touch_the_phone(self):
        _switches(
            absent_alert_enabled=False,
            late_alert_enabled=False,
            four_punch_alert_enabled=False,
            missing_punch_alert_enabled=False,
            attendance_alerts_enabled=False,
        )
        self.assertEqual(self.run_at(WED, 10, 0), {})  # WhatsApp: nothing
        self.assertEqual(self.phone(10, 0).get("absent_alert"), 1)  # the phone: its own switches
        self.assertEqual(self.whatsapp_calls(), [])

    def test_the_phone_switch_off_stops_the_phone_only(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["absent_alert"]})
        self.assertNotIn("absent_alert", self.phone(10, 0))
        self.assertFalse(self.absent_notes().exists())
        self.assertEqual(self.run_at(WED, 10, 0).get("absent_alert"), 1)  # WhatsApp unaffected

    def test_the_whatsapp_job_makes_no_phone_notification(self):
        self.assertEqual(self.run_at(WED, 10, 0).get("absent_alert"), 1)
        self.assertEqual(WhatsAppMessageLog.objects.filter(document_type="absent_alert").count(), 1)
        self.assertFalse(Notification.objects.exists())
        self.phone(10, 1)
        self.assertEqual(self.absent_notes().count(), 1)

    def test_each_module_has_its_own_timing(self):
        # WhatsApp reminds 5 minutes before a punch (AlertBase), the phone 15 minutes before (its own default)
        self.assertNotIn("four_punch_alert", self.run_at(WED, 8, 46))
        self.assertEqual(self.phone(8, 46).get("four_punch_alert"), 1)

    def test_the_phone_timing_is_set_on_phone_notify_control(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"alert_reminder_lead_minutes": 3})
        self.assertNotIn("four_punch_alert", self.phone(8, 50))  # check-in at 9:00 is 10 minutes away, 3 asked
        self.assertEqual(self.phone(8, 57).get("four_punch_alert"), 1)

    def test_a_failing_whatsapp_provider_does_not_matter_to_the_phone(self):
        with mock.patch("api.whatsapp_alerts.provider_is_failing", return_value=True):
            self.assertEqual(self.run_at(WED, 10, 0), {})
            self.assertEqual(self.phone(10, 0).get("absent_alert"), 1)


class CategoryTests(TestCase):
    def test_every_switch_has_a_category_and_every_category_has_switches(self):
        from . import mobile_messages as mm

        rows = mm.categorized_controls()
        self.assertTrue(all(r["category"] in mm.CATEGORIES for r in rows))
        self.assertEqual({r["category"] for r in rows}, set(mm.CATEGORIES))
        by_key = {r["key"]: r["category"] for r in rows}
        for key, category in (
            ("approval:leave", "leave"),
            ("approval:casual_leave", "leave"),
            ("approval:permission", "permission"),
            ("absent_alert", "attendance"),
            ("ot_compensation", "compensation"),
            ("salary_paid", "payroll"),
            ("chat_announcement", "chat"),
            ("approval_waiting", "approvers"),
            ("hod_pending_reminder", "approvers"),
        ):
            self.assertEqual(by_key[key], category, key)

    def test_a_notification_counts_in_one_category(self):
        from .mobile_messages import category_of_notification as cat

        self.assertEqual(cat("approval_approved", "leave"), "leave")
        self.assertEqual(cat("approval_rejected", "permission"), "permission")
        self.assertEqual(cat("approval_waiting", "leave"), "approvers")
        self.assertEqual(cat("approval_approved", "holiday_work"), "compensation")
        self.assertEqual(cat("late_alert", ""), "attendance")
        self.assertEqual(cat("chat_reply", ""), "chat")
        self.assertEqual(cat("manual", ""), "employee")
        self.assertEqual(cat("", ""), "employee")

    def test_the_overview_lists_the_categories_with_their_month(self):
        admin = HRUser.objects.create(username="cat_admin", password_hash="x", is_super_admin=True)
        emp = Employee.objects.create(employee_code="CT1", first_name="A", last_name="B", status="active")
        with mock.patch(EXPO) as post:
            ok(post)
            Notification.objects.create(employee=emp, message="m", source="approval_approved", related_module="leave")
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["approval:casual_leave"]})
        res = self.client.get(
            "/api/mobile-app/messages/overview", **bearer({"role": "hr", "hrUserId": admin.id, "name": "cat_admin"})
        )
        self.assertEqual(res.status_code, 200, res.content)
        leave = next(c for c in res.json()["categories"] if c["key"] == "leave")
        self.assertEqual((leave["on"], leave["total"], leave["month"]["total"]), (1, 2, 1))
        self.assertIn("approval:leave", leave["keys"])
        self.assertEqual(res.json()["failedRecent"], [])

    def test_a_chat_notification_opens_the_chat(self):
        from . import notification_targets

        emp = Employee.objects.create(employee_code="CT2", first_name="A", last_name="B", status="active")
        n = Notification.objects.bulk_create(
            [Notification(employee=emp, type="chat", source="chat_message", message="x")]
        )[0]
        self.assertEqual(notification_targets.target_for(n)["kind"], "chat")


class CompensationNoticeTests(TestCase):
    def setUp(self):
        from .models import CompensationDayAnnouncement, OvertimeRecord

        self.A, self.OT = CompensationDayAnnouncement, OvertimeRecord
        self.b1 = Branch.objects.create(name="Unit C")
        self.dept = Department.objects.create(name="Stitching", branch=self.b1)
        mk = lambda code, **kw: Employee.objects.create(  # noqa: E731
            employee_code=code, first_name=code, last_name="S", status="active", employment_type="staff", **kw
        )
        self.a = mk("CN1", branch=self.b1, department=self.dept)
        self.b = mk("CN2", branch=self.b1)
        self.c = mk("CN3")
        Employee.objects.create(
            employee_code="CN4",
            first_name="P",
            last_name="W",
            status="active",
            employment_type="production",
            branch=self.b1,
        )
        self.post = mock.patch(EXPO).start()
        self.addCleanup(mock.patch.stopall)
        ok(self.post)

    def record(self, **kw):
        from datetime import date, time

        return self.OT.objects.create(
            employee=self.a, date=date(2026, 11, 12), last_punch_out=time(20, 0), ot_minutes=120, **kw
        )

    def test_the_overtime_wording(self):
        from datetime import date
        from decimal import Decimal

        from .compensation_notices import overtime_text

        rec = self.record(shifts=Decimal("0.50"))
        self.assertEqual(
            overtime_text(rec, "pay"),
            (
                "Overtime approved: payment",
                "Your extra work on 12 Nov 2026 will be paid (0.5 shifts) with your salary for November 2026.",
            ),
        )
        rec.claim_date = date(2026, 11, 20)
        self.assertIn("time off (0.5 shifts), granted on 20 Nov 2026", overtime_text(rec, "relaxation")[1])
        rec.claim_date = None
        self.assertIn("added to your compensation balance", overtime_text(rec, "relaxation")[1])
        self.assertEqual(overtime_text(rec, "rejected")[0], "Overtime not compensated")

    def test_a_decision_notifies_once(self):
        from .compensation_notices import SOURCE_OT, overtime_decided

        rec = self.record()
        overtime_decided(rec, "rejected")
        overtime_decided(rec, "rejected")
        n = Notification.objects.get(source=SOURCE_OT)
        self.assertEqual((n.employee, n.type), (self.a, "compensation"))

    def test_an_announcement_reaches_the_staff_it_covers(self):
        from datetime import date, time

        from .compensation_notices import SOURCE_ANNOUNCEMENT, announcement_made

        def made(**kw):
            Notification.objects.all().delete()
            ann = self.A.objects.create(date=date(2026, 11, 21), **kw)
            announcement_made(ann)
            return set(
                Notification.objects.filter(source=SOURCE_ANNOUNCEMENT).values_list(
                    "employee__employee_code", flat=True
                )
            )

        self.assertEqual(made(department=self.dept), {"CN1"})
        self.assertEqual(made(branch=self.b1), {"CN1", "CN2"})
        everyone = made()
        self.assertTrue({"CN1", "CN2", "CN3"} <= everyone)
        self.assertNotIn("CN4", everyone)  # production workers are not covered
        ann = self.A.objects.create(date=date(2026, 11, 22), kind="late_in", allowed_time=time(10, 0), branch=self.b1)
        announcement_made(ann)
        n = Notification.objects.filter(dedupe_key=f"compday:{ann.pk}", employee=self.a).get()
        self.assertEqual(
            (n.title, n.message),
            ("Late arrival allowed", "On 22 Nov 2026 you may arrive up to 10:00 AM without a late mark."),
        )
