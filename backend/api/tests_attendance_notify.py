"""
Attendance Notify (owner 2026-11-17): the report (from the Report Log's own day engine), validation, the schedule and its
exactly-once slots, sending through WhatsApp (numbers and groups, the paced queue), Gmail (To / CC / BCC, photos, PDF)
and the internal chat, retries, and the API.

Run via: python manage.py test api.tests_attendance_notify --keepdb
"""

from datetime import date, datetime, time, timedelta
from unittest import mock

from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone

from . import attendance_notify as notify
from . import attendance_notify_report as rpt
from . import whatsapp_service as wa
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    AttendanceNotifyAutomation,
    AttendanceNotifyRun,
    AttendanceNotifySettings,
    Branch,
    CasualLeaveRequest,
    ChatChannel,
    ChatMessage,
    EmailMessageLog,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    LeaveRequest,
    PayrollSettings,
    ShiftTemplate,
    WhatsAppMessageLog,
)

DAY = date(2026, 11, 10)  # a Tuesday
NEXT_MORNING = datetime(2026, 11, 11, 9, 31)  # naive IST
ALL = list(rpt.CATEGORIES)

SENDING = dict(
    WACLIENT_INSTANCE_ID="INST1",
    WACLIENT_ACCESS_TOKEN="tok",
    WHATSAPP_ALLOW_SENDING=True,
    EMAIL_ALLOW_SENDING=True,
    WHATSAPP_SEND_DELAY_SECONDS=0,
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    BACKEND_PUBLIC_URL="https://api.example.com",
)
SMTP = "api.email_service.smtplib.SMTP"


def _wa_ok():
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WAID"}}}
    return r


def bearer(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': 'Tester'})}"}


def custom(**kw) -> dict:
    return {"name": "T", "reportType": "custom", "dateFrom": DAY, "dateTo": DAY, "categories": ALL, **kw}


class World(TestCase):
    """Staff: Asha (no punch: Absent), Bala (punched, approved permission), Chitra (approved full-day CL), Dev (approved
    sick leave), Esha (no punch, but On-Duty HR approved: On Duty, never Absent). Production: Prabu (no punch: Absent)."""

    def setUp(self):
        super().setUp()
        shift = ShiftTemplate.objects.create(
            name="AN Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )

        def emp(code, first, kind="staff"):
            e = Employee.objects.create(
                employee_code=code, first_name=first, last_name="Test", employment_type=kind, status="active"
            )
            if kind == "staff":
                EmployeeShiftAssignment.objects.create(employee=e, shift=shift, effective_from=date(2020, 1, 1))
            return e

        self.asha = emp("AN01", "Asha")
        self.bala = emp("AN02", "Bala")
        self.chitra = emp("AN03", "Chitra")
        self.dev = emp("AN04", "Dev")
        self.prabu = emp("AN05", "Prabu", "production")
        self.esha = emp("AN06", "Esha")
        from .clock import FACTORY_TZ
        from .models import OnDutySession

        OnDutySession.objects.create(
            employee=self.esha,
            destination="Client visit, Tirupur",
            status=OnDutySession.STATUS_COMPLETED,
            started_at=datetime(2026, 11, 10, 9, 15, tzinfo=FACTORY_TZ),
            employee_ended_at=datetime(2026, 11, 10, 17, 0, tzinfo=FACTORY_TZ),
        )
        for t, kind in ((time(9, 2), "IN"), (time(18, 5), "OUT")):
            AttendanceLog.objects.create(
                employee=self.bala, date=DAY, punch_time=t, punch_type=kind, source="biometric"
            )
        EmployeePermission.objects.create(
            employee=self.bala,
            date=DAY,
            type="morning_late_in",
            permission_time=time(10, 0),
            status="approved",
            reason="Bank",
        )
        CasualLeaveRequest.objects.create(
            employee=self.chitra, date=DAY, portion="full", status="approved", reason="Home"
        )
        LeaveRequest.objects.create(
            employee=self.dev, type="sick", start_date=str(DAY), end_date=str(DAY), status="approved", approval_trail=[]
        )
        self.admin = HRUser.objects.create(username="an_admin", password_hash="x", is_super_admin=True)
        self.h = bearer(self.admin)


class ReportTests(World):
    def codes(self, report, cat):
        return sorted(r.person.code for r in report.rows if r.category == cat)

    def test_every_category_comes_from_the_day_engine(self):
        report = rpt.build(custom(employeeType="all"), now=NEXT_MORNING)
        self.assertEqual(self.codes(report, "absent"), ["AN01", "AN05"])
        self.assertEqual(self.codes(report, "cl"), ["AN03"])
        self.assertEqual(self.codes(report, "on_leave"), ["AN04"])
        self.assertEqual(self.codes(report, "permission"), ["AN02"])
        self.assertEqual(self.codes(report, "on_duty"), ["AN06"])  # no punch, but On Duty: not Absent
        self.assertEqual(
            report.counts, {"absent": 2, "cl": 1, "on_leave": 1, "on_duty": 1, "permission": 1, "compensation": 0}
        )
        od = next(r for r in report.rows if r.category == "on_duty")
        self.assertEqual(od.detail, "Client visit, Tirupur · On-Duty approved; no punches yet")
        perm = next(r for r in report.rows if r.category == "permission")
        self.assertEqual(perm.detail, "Morning Late-In · 10:00 · Bank")
        self.assertEqual(next(r for r in report.rows if r.category == "cl").detail, "Full day · Home")

    def test_staff_or_production_only_and_chosen_categories(self):
        staff = rpt.build(custom(employeeType="staff"), now=NEXT_MORNING)
        self.assertEqual(self.codes(staff, "absent"), ["AN01"])
        prod = rpt.build(custom(employeeType="production", categories=["absent"]), now=NEXT_MORNING)
        self.assertEqual([r.person.code for r in prod.rows], ["AN05"])
        self.assertEqual(prod.counts, {"absent": 1})

    def test_a_report_about_today_counts_absence_as_no_punch_yet(self):
        now = datetime(2026, 11, 10, 9, 30)
        report = rpt.build(
            {"name": "T", "reportType": "daily", "reportDay": "today", "categories": ["absent"]}, now=now
        )
        self.assertEqual(report.as_of, "09:30")
        asha = next(r for r in report.rows if r.person.code == "AN01")
        self.assertEqual(asha.detail, "No punch yet (as of 09:30)")

    def test_yesterday_and_ranges(self):
        self.assertEqual(rpt.resolve_days({"reportDay": "yesterday"}, date(2026, 11, 11)), [DAY])
        days = rpt.resolve_days({"reportType": "custom", "dateFrom": "2026-11-01", "dateTo": "2026-12-31"}, DAY)
        self.assertEqual(len(days), rpt.MAX_RANGE_DAYS)

    def test_texts_pdf_email_and_chat(self):
        report = rpt.build(custom(employeeType="all"), now=NEXT_MORNING)
        parts = rpt.message_parts(report, "both")
        self.assertEqual(len(parts), 2)
        self.assertIn("Absent: *2*", parts[0])
        self.assertIn("1. Asha Test (AN01)", parts[1])
        self.assertTrue(rpt.pdf_bytes(report, with_photos=True).startswith(b"%PDF"))
        html = rpt.email_html(report, "both", {})
        self.assertIn("Asha Test", html)
        payload = rpt.chat_payload(report)
        self.assertEqual(payload["counts"]["absent"], 2)
        self.assertEqual(len(payload["rows"]), 6)

    def test_long_lists_are_split_and_names_escaped(self):
        report = rpt.Report(
            name="<b>X</b>", days=[DAY], employee_type="staff", categories=["absent"], total_employees=500
        )
        person = rpt.Person(1, "C1", "Name <script>", "Dept", "Role", "staff", "")
        report.rows = [rpt.Row(DAY, "absent", person, "No punch") for _ in range(300)]
        report.counts = {"absent": 300}
        parts = rpt.message_parts(report, "detailed")
        self.assertTrue(all(len(p) <= rpt.TEXT_PART_LIMIT for p in parts))
        self.assertIn(f"…and {300 - rpt.MAX_TEXT_ROWS} more", parts[-1])
        html = rpt.email_html(report, "detailed", None)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)


class ValidationTests(World):
    def ok(self, **kw):
        base = {
            "name": "Morning",
            "channel": "whatsapp",
            "categories": ["absent"],
            "times": ["9:30", "13:00"],
            "recipients": {"numbers": [{"value": "98765 43210", "label": "HR"}]},
        }
        return notify.clean({**base, **kw})

    def bad(self, field, **kw):
        with self.assertRaises(notify.Invalid, msg=str(kw)) as ctx:
            self.ok(**kw)
        self.assertEqual(ctx.exception.field, field, str(ctx.exception))

    def test_a_good_automation(self):
        f = self.ok()
        self.assertEqual(f["times"], ["09:30", "13:00"])
        self.assertEqual(f["recipients"]["numbers"], [{"value": "919876543210", "label": "HR"}])
        self.assertEqual(f["days"], [0, 1, 2, 3, 4, 5, 6])

    def test_what_is_refused(self):
        self.bad("name", name=" ")
        self.bad("times", times=["25:00"])
        self.bad("times", times=["09:30", "9:30"])
        self.bad("categories", categories=[])
        self.bad("categories", categories=["late"])
        self.bad("dateFrom", reportType="custom")
        self.bad("dateTo", reportType="custom", dateFrom="2026-11-01", dateTo="2026-12-15")
        self.bad("runOn", frequency="once")
        self.bad("days", frequency="weekly", days=[])
        self.bad("recipients", recipients={"numbers": [{"value": "12"}]})
        self.bad("recipients", recipients={"groups": [{"id": "abc@g.us"}]})
        self.bad("recipients", recipients={})
        self.bad("recipients", channel="email", recipients={"to": ["not-an-address"]})
        self.bad("recipients", channel="email", recipients={"cc": ["a@b.in"]})
        self.bad("recipients", channel="chat", recipients={"channelIds": [999999]})

    def test_groups_email_and_chat(self):
        f = self.ok(recipients={"groups": [{"id": "120363001@g.us", "name": "HO"}]})
        self.assertEqual(f["recipients"]["groups"], [{"id": "120363001@g.us", "name": "HO"}])
        f = self.ok(channel="email", recipients={"to": ["a@b.in", "A@b.in"], "cc": ["c@d.in"], "bcc": ["e@f.in"]})
        self.assertEqual((f["recipients"]["to"], f["recipients"]["cc"]), (["a@b.in"], ["c@d.in"]))
        ch = ChatChannel.get_company_channel(None)
        self.assertEqual(
            self.ok(channel="chat", recipients={"channelIds": [ch.pk]})["recipients"], {"channelIds": [ch.pk]}
        )


class ScheduleTests(World):
    def make(self, **kw):
        fields = {
            "name": "Daily",
            "channel": "chat",
            "categories": ["absent"],
            "times": ["09:30"],
            "frequency": "daily",
            "recipients": {"channelIds": [ChatChannel.get_company_channel(None).pk]},
            **kw,
        }
        return AttendanceNotifyAutomation.objects.create(**notify.clean(fields))

    def test_a_slot_runs_once_whatever_happens(self):
        a = self.make()
        self.assertEqual(len(notify.run_scheduled(now=NEXT_MORNING)), 1)
        self.assertEqual(notify.run_scheduled(now=NEXT_MORNING + timedelta(minutes=2)), [])
        with self.assertRaises(IntegrityError):
            notify.create_run(a, trigger="schedule", run_date=NEXT_MORNING.date(), slot="09:30")
        run = AttendanceNotifyRun.objects.get()
        self.assertEqual((run.status, run.slot, run.report_from), ("done", "09:30", NEXT_MORNING.date()))
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_outside_the_window_weekdays_once_and_off(self):
        self.make()
        self.assertEqual(notify.run_scheduled(now=datetime(2026, 11, 11, 9, 41)), [])
        AttendanceNotifyAutomation.objects.all().delete()
        self.make(frequency="weekly", days=[0])  # Mondays only; 11 Nov is a Wednesday
        self.assertEqual(notify.run_scheduled(now=NEXT_MORNING), [])
        a = self.make(frequency="once", runOn="2026-11-11", name="Once")
        self.assertEqual(len(notify.run_scheduled(now=NEXT_MORNING)), 1)
        a.is_active = False
        a.save()
        self.assertIsNone(notify.next_run_for(a, NEXT_MORNING))

    def test_next_run(self):
        a = self.make(times=["09:30", "13:00"])
        self.assertEqual(notify.next_run_for(a, datetime(2026, 11, 11, 10, 0)), datetime(2026, 11, 11, 13, 0))
        b = self.make(frequency="once", runOn="2026-11-01", name="Past")
        self.assertIsNone(notify.next_run_for(b, NEXT_MORNING))


@override_settings(**SENDING)
class SendTests(World):
    def setUp(self):
        super().setUp()
        self.post = mock.patch("requests.post", return_value=_wa_ok())
        self.wa = self.post.start()
        self.addCleanup(self.post.stop)
        smtp = mock.patch(SMTP)
        self.smtp = smtp.start()
        self.addCleanup(smtp.stop)
        ps = PayrollSettings.get()
        ps.smtp_host, ps.smtp_port, ps.smtp_username, ps.smtp_password = "smtp.example.test", 587, "hr@x.test", "pw"
        ps.save()

    def automation(self, channel, recipients, **kw):
        fields = notify.clean(
            {
                "name": "Absentees",
                "channel": channel,
                "reportType": "custom",
                "dateFrom": str(DAY),
                "categories": ALL,
                "times": ["09:30"],
                "recipients": recipients,
                **kw,
            }
        )
        return AttendanceNotifyAutomation.objects.create(**fields)

    def go(self, a):
        run = notify.create_run(a, trigger="manual", run_date=NEXT_MORNING.date(), requested_by="Tester")
        status = notify.process_run(run.pk)
        return run, status

    def test_whatsapp_numbers_and_groups_through_the_queue(self):
        a = self.automation(
            "whatsapp",
            {"numbers": [{"value": "9876543210", "label": "HR"}], "groups": [{"id": "120363001@g.us", "name": "HO"}]},
        )
        run, status = self.go(a)
        self.assertEqual(status, "done", list(run.deliveries.values_list("status", "note")))
        bodies = [c.kwargs["json"] for c in self.wa.call_args_list]
        self.assertEqual({b.get("number") for b in bodies if "number" in b}, {"919876543210"})
        self.assertEqual({b.get("chat_id") for b in bodies if "chat_id" in b}, {"120363001@g.us"})
        logs = WhatsAppMessageLog.objects.filter(document_ref_id=run.pk)
        self.assertEqual(logs.count(), 4)  # summary + list, to each
        self.assertTrue(all(log.employee_id is None for log in logs))
        self.assertEqual(set(logs.values_list("recipient_label", flat=True)), {"HR", "HO"})
        self.assertEqual(set(run.deliveries.values_list("status", flat=True)), {"sent"})
        # exactly once: the same key again queues nothing new
        d = run.deliveries.first()
        again = wa.queue_to_recipient(
            d.recipient, "x", recipient_label="HR", dedupe_key=notify.dedupe_key(run, d, 0), document_ref_id=run.pk
        )
        self.assertEqual(again.pk, logs.order_by("id").first().pk)
        self.assertEqual(WhatsAppMessageLog.objects.filter(document_ref_id=run.pk).count(), 4)

    def test_whatsapp_photos_go_as_one_pdf_and_the_connected_number(self):
        AttendanceNotifySettings.objects.update_or_create(pk=1, defaults={"connected_number": "9000000001"})
        a = self.automation("whatsapp", {"connected": True}, includePhotos=True, content="detailed")
        run, status = self.go(a)
        self.assertEqual(status, "done")
        kinds = [c.kwargs["json"]["type"] for c in self.wa.call_args_list]
        self.assertEqual(kinds, ["text", "document"])
        doc = self.wa.call_args_list[-1].kwargs["json"]
        self.assertTrue(doc["media_url"].startswith("https://api.example.com/api/whatsapp/media/"))
        self.assertEqual(run.deliveries.get().kind, "connected")

    def test_connected_number_not_set_is_skipped(self):
        a = self.automation("whatsapp", {"connected": True, "numbers": [{"value": "9876543210"}]})
        run, status = self.go(a)
        self.assertEqual(status, "partial")
        skipped = run.deliveries.get(kind="connected")
        self.assertEqual(skipped.status, "skipped")
        self.assertIn("connected WhatsApp number", skipped.note)

    def test_gmail_to_cc_bcc_photos_and_pdf(self):
        a = self.automation(
            "email",
            {"to": ["hr@uk.in", "md@uk.in"], "cc": ["head@uk.in"], "bcc": ["audit@uk.in"]},
            attachPdf=True,
            includePhotos=True,
        )
        run, status = self.go(a)
        self.assertEqual(status, "done")
        server = self.smtp.return_value.__enter__.return_value
        msg = server.send_message.call_args.args[0]
        self.assertEqual(
            sorted(server.send_message.call_args.kwargs["to_addrs"]),
            ["audit@uk.in", "head@uk.in", "hr@uk.in", "md@uk.in"],
        )
        self.assertEqual(msg["To"], "hr@uk.in, md@uk.in")
        self.assertEqual(msg["Cc"], "head@uk.in")
        self.assertIsNone(msg["Bcc"])
        self.assertIn("Absentees", msg["Subject"])
        names = [p.get_filename() for p in msg.iter_attachments()]
        self.assertTrue(any(n and n.endswith(".pdf") for n in names))
        log = EmailMessageLog.objects.get()
        self.assertEqual((log.status, log.email_type), ("sent", "attendance_report"))
        self.assertEqual(run.deliveries.get().email_log_id, log.pk)

    def test_a_failed_email_is_tried_again_later(self):
        a = self.automation("email", {"to": ["hr@uk.in"]})
        import smtplib

        server = self.smtp.return_value.__enter__.return_value
        server.send_message.side_effect = smtplib.SMTPServerDisconnected("gone")
        run, status = self.go(a)
        self.assertEqual(status, "failed")
        d = run.deliveries.get()
        self.assertEqual((d.status, d.attempts), ("failed", 1))
        self.assertIsNotNone(d.retry_at)
        server.send_message.side_effect = None
        self.assertEqual(notify.retry_due(now=timezone.now()), 0)  # not yet
        self.assertEqual(notify.retry_due(now=timezone.now() + notify.RETRY_AFTER), 1)
        d.refresh_from_db()
        run.refresh_from_db()
        self.assertEqual((d.status, d.attempts, run.status), ("sent", 2, "done"))

    def test_chat_card_appears_in_the_chat(self):
        ch = ChatChannel.get_company_channel(None)
        a = self.automation("chat", {"channelIds": [ch.pk]}, includePhotos=True)
        run, status = self.go(a)
        self.assertEqual(status, "done")
        msg = ChatMessage.objects.get()
        self.assertEqual((msg.sender_id, msg.sender_label), (None, "Attendance Notify"))
        self.assertIn("Asha Test (AN01)", msg.text)
        res = self.client.get(f"/api/chat/channels/{ch.pk}/messages", **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        report = res.json()[-1]["report"]
        self.assertEqual(report["counts"]["absent"], 2)
        self.assertIn("photoUrl", report["rows"][0])

    def test_skip_when_empty_and_never_twice_after_a_stop(self):
        a = self.automation(
            "chat",
            {"channelIds": [ChatChannel.get_company_channel(None).pk]},
            categories=["compensation"],
            skipWhenEmpty=True,
        )
        run, status = self.go(a)
        self.assertEqual(status, "skipped")
        self.assertFalse(ChatMessage.objects.exists())
        # a delivery a stopped holder left "sending" is never sent again
        b = self.automation("chat", {"channelIds": [ChatChannel.get_company_channel(None).pk]})
        run = notify.create_run(b, trigger="manual", run_date=NEXT_MORNING.date())
        run.deliveries.update(status="sending")
        notify.process_run(run.pk)
        self.assertEqual(run.deliveries.get().status, "failed")
        self.assertFalse(ChatMessage.objects.exists())


class ApiTests(World):
    URL = "/api/attendance/notify"

    def body(self, **kw):
        return {
            "name": "Morning absentees",
            "channel": "chat",
            "categories": ["absent", "cl"],
            "employeeType": "staff",
            "times": ["09:30"],
            "frequency": "weekly",
            "days": [0, 1, 2, 3, 4, 5],
            "recipients": {"channelIds": [ChatChannel.get_company_channel(None).pk]},
            **kw,
        }

    def test_create_list_edit_toggle_run_and_delete(self):
        res = self.client.post(f"{self.URL}/automations", self.body(), content_type="application/json", **self.h)
        self.assertEqual(res.status_code, 201, res.content)
        a = res.json()
        self.assertEqual((a["channel"], a["times"], a["recipientSummary"]), ("chat", ["09:30"], "1 channel"))
        self.assertIsNotNone(a["nextRunAt"])
        bad = self.client.post(
            f"{self.URL}/automations", self.body(times=[]), content_type="application/json", **self.h
        )
        self.assertEqual((bad.status_code, bad.json()["field"]), (400, "times"))
        res = self.client.put(
            f"{self.URL}/automations/{a['id']}",
            self.body(name="Renamed", channel="email"),
            content_type="application/json",
            **self.h,
        )
        self.assertEqual((res.status_code, res.json()["name"], res.json()["channel"]), (200, "Renamed", "chat"))
        res = self.client.post(
            f"{self.URL}/automations/{a['id']}/toggle", {"isActive": False}, content_type="application/json", **self.h
        )
        self.assertEqual((res.json()["isActive"], res.json()["nextRunAt"]), (False, None))
        with mock.patch("api.attendance_notify.launch") as launch:
            res = self.client.post(f"{self.URL}/automations/{a['id']}/run", **self.h)
        self.assertEqual(res.status_code, 202, res.content)
        run = res.json()["run"]
        launch.assert_called_once_with(run["id"])
        self.assertEqual((run["status"], run["trigger"], run["recipients"]), ("running", "manual", 1))
        busy = self.client.post(f"{self.URL}/automations/{a['id']}/run", **self.h)
        self.assertEqual(busy.status_code, 409)
        notify.process_run(run["id"])
        runs = self.client.get(f"{self.URL}/runs", {"automation": a["id"]}, **self.h).json()
        self.assertEqual((runs["total"], runs["items"][0]["status"]), (1, "done"))
        self.assertEqual(self.client.delete(f"{self.URL}/automations/{a['id']}", **self.h).status_code, 204)
        kept = AttendanceNotifyRun.objects.get()
        self.assertEqual((kept.automation_id, kept.automation_name), (None, "Renamed"))

    def test_preview_snapshot_lists_settings_and_channels(self):
        res = self.client.post(
            f"{self.URL}/preview",
            self.body(reportType="custom", dateFrom=str(DAY), recipients={}),
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["counts"], {"absent": 1, "cl": 1})  # Esha is On Duty, not Absent
        self.assertTrue(body["messages"][0]["text"].startswith("Attendance report"))
        self.assertTrue(any("company channel" in w for w in body["warnings"]))
        pdf = self.client.post(
            f"{self.URL}/preview-pdf",
            self.body(reportType="custom", dateFrom=str(DAY)),
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        snap = self.client.get(
            f"{self.URL}/snapshot", {"date": str(DAY), "employeeType": "production"}, **self.h
        ).json()
        self.assertEqual(snap["counts"]["absent"], 1)
        lst = self.client.post(
            f"{self.URL}/recipient-lists",
            {"name": "Heads", "channel": "email", "items": {"to": ["a@b.in"], "cc": [], "bcc": []}},
            content_type="application/json",
            **self.h,
        )
        self.assertEqual(lst.status_code, 201, lst.content)
        self.assertEqual(
            len(self.client.get(f"{self.URL}/recipient-lists", {"channel": "email"}, **self.h).json()["items"]), 1
        )
        s = self.client.put(
            f"{self.URL}/settings", {"connectedNumber": "98765 43210"}, content_type="application/json", **self.h
        )
        self.assertEqual(s.json()["connectedNumber"], "919876543210")
        names = [c["name"] for c in self.client.get(f"{self.URL}/chat-channels", **self.h).json()["items"]]
        self.assertIn("Company (no branch)", names)
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            groups = self.client.get(f"{self.URL}/whatsapp-groups", {"refresh": "1"}, **self.h).json()
        self.assertFalse(groups["supported"])

    def test_a_branch_login_sees_its_own_automations(self):
        from .models import Role

        north = Branch.objects.create(name="North", code="ANN")
        AttendanceNotifyAutomation.objects.create(**notify.clean(self.body(name="Company-wide")), branch=None)
        role = Role.objects.create(name="an role", permissions={"attendance": "edit"})
        user = HRUser.objects.create(username="an_branch", password_hash="x", role=role, branch=north)
        items = self.client.get(f"{self.URL}/automations", **bearer(user)).json()["items"]
        self.assertEqual(items, [])

    @override_settings(**SENDING)
    def test_whatsapp_control_lists_a_message_to_a_group(self):
        with mock.patch("requests.post", return_value=_wa_ok()):
            wa.queue_to_recipient("120363001@g.us", "hello", recipient_label="HO group", dedupe_key="t:1")
        res = self.client.get("/api/whatsapp-control/messages", **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        items = body if isinstance(body, list) else (body.get("items") or body.get("messages") or body.get("results"))
        row = next(m for m in items if m["phone"] == "120363001@g.us")
        self.assertEqual((row["employeeName"], row["employeeCode"], row["employeeId"]), ("HO group", "", None))


class ChatAccessTests(World):
    """HR chat (2026-11-17): an admin not limited to a branch lists and opens every branch's company channel (where
    Attendance Notify posts each branch's report); a branch login keeps its own; department channels stay private."""

    def setUp(self):
        super().setUp()
        from .models import Department, Role

        self.north = Branch.objects.create(name="North", code="ANN")
        self.south = Branch.objects.create(name="South", code="ANS")
        self.dept = Department.objects.create(name="AN Sewing", branch=self.north)
        role = Role.objects.create(name="an chat role", permissions={"attendance": "edit", "chat": "edit"})
        self.branch_hr = HRUser.objects.create(username="an_north", password_hash="x", role=role, branch=self.north)

    def test_an_admin_lists_and_opens_every_branch_company_channel(self):
        body = self.client.get("/api/chat/channels", **self.h).json()
        names = [c["name"] for c in body]
        self.assertEqual(names[0], "Company (no branch)")  # first, as before
        self.assertIn("Company – North", names)
        self.assertIn("Company – South", names)
        north = ChatChannel.get_company_channel(self.north.pk)
        ChatMessage.objects.create(channel=north, sender=None, sender_label="Attendance Notify", text="report")
        res = self.client.get(f"/api/chat/channels/{north.pk}/messages", **self.h)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()[-1]["text"], "report")
        dept = ChatChannel.get_department_channel(self.dept)
        self.assertEqual(self.client.get(f"/api/chat/channels/{dept.pk}/messages", **self.h).status_code, 404)

    def test_a_branch_login_keeps_its_own_channel_only(self):
        body = self.client.get("/api/chat/channels", **bearer(self.branch_hr)).json()
        self.assertEqual([c["name"] for c in body], ["Company – North"])
        south = ChatChannel.get_company_channel(self.south.pk)
        res = self.client.get(f"/api/chat/channels/{south.pk}/messages", **bearer(self.branch_hr))
        self.assertEqual(res.status_code, 404)
