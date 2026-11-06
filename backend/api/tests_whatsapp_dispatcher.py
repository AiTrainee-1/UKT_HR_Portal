"""The WhatsApp send queue (2026-11-06): queueing, the paced dispatcher, its limits and the WhatsApp Control API for it.

Every test freezes the clock (django.utils.timezone.now, which auto_now fields use too) at a fixed IST moment and drives
the dispatcher by calling tick(now=...) directly, so nothing depends on the time of day the suite runs. WAClient is
mocked; credentials are test values.
"""

from datetime import datetime, time, timedelta
from importlib import import_module
from unittest import mock

import requests
from django.apps import apps as django_apps
from django.test import TestCase, override_settings

from . import otp_service
from . import whatsapp_bulk_progress as progress
from . import whatsapp_catalog as catalog
from . import whatsapp_dispatcher as disp
from . import whatsapp_service as svc
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    Employee,
    HRUser,
    SalarySlip,
    WhatsAppMessageLog,
    WhatsAppOptOut,
    WhatsAppSettings,
)

CONFIG = dict(
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok-test",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    WHATSAPP_ALLOW_SENDING=True,
    WHATSAPP_ASYNC_SEND=True,  # rows stay queued: the dispatcher is what these tests drive
    BACKEND_PUBLIC_URL="https://api.example.test",
)
NOON = datetime(2026, 11, 6, 12, 0, tzinfo=FACTORY_TZ)  # a Friday
M = WhatsAppMessageLog


def _at(iso: str | None):
    """An ISO timestamp from the API as a datetime (the database hands times back in UTC)."""
    return datetime.fromisoformat(iso) if iso else None


def _ok(msg_id="WAID1"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": msg_id}}}
    return r


def _resp(status_code, body):
    r = mock.Mock(status_code=status_code, content=b"x", text=str(body))
    r.json.return_value = body
    return r


@override_settings(**CONFIG)
class QueueBase(TestCase):
    def setUp(self):
        self.clock = NOON
        clock = mock.patch("django.utils.timezone.now", side_effect=lambda: self.clock)
        clock.start()
        self.addCleanup(clock.stop)
        post = mock.patch("api.whatsapp_service.requests.post", return_value=_ok())
        self.post = post.start()
        self.addCleanup(post.stop)
        self.emp = Employee.objects.create(
            employee_code="D1", first_name="Asha", last_name="Kumar", phone="8220015110", status="active"
        )
        self.other = Employee.objects.create(
            employee_code="D2", first_name="Ravi", last_name="Nair", phone="8220015111", status="active"
        )
        self.n = 0

    def at(self, **delta):
        self.clock = NOON + timedelta(**delta)
        return self.clock

    def settings(self, **fields):
        WhatsAppSettings.get()
        WhatsAppSettings.objects.filter(pk=1).update(**fields)

    def gate(self, emp=None, **kw):
        """An AUTOMATIC message (gate exit, fresh for 30 minutes), each with its own text."""
        self.n += 1
        return svc.send_notification(
            emp or self.emp,
            "outpass_gate_out",
            {"employee_name": "Asha", "pass_type": "Official", "destination": f"Bank {self.n}", "date": "6 Nov"},
            **kw,
        )

    def approval(self, emp=None, **kw):
        """A REQUESTED message (an approval, fresh until the end of the day), each with its own text."""
        self.n += 1
        return svc.send_notification(
            emp or self.emp,
            "approval_approved",
            {"employee_name": "Asha", "request_type": "Leave", "details": f"Casual leave #{self.n}"},
            related_module="leave",
            dedupe_key=f"approval:leave:{self.n}:approved",
            **kw,
        )

    def code(self, emp=None):
        return svc.send_notification(emp or self.emp, "otp_login", ["123456", "5"], log_params=["******", "5"])

    def tick(self):
        return disp.tick(now=self.clock)

    def reload(self, log):
        log.refresh_from_db()
        return log


class QueueingTests(QueueBase):
    def test_a_message_is_queued_with_its_kind_priority_and_expiry_and_the_tick_sends_it(self):
        log = self.gate()
        self.assertEqual((log.status, log.kind, log.priority), ("queued", "automatic", 5))
        self.assertEqual(log.expires_at, NOON + timedelta(minutes=30))  # gate messages: fresh for 30 minutes
        self.post.assert_not_called()
        result = self.tick()
        self.assertEqual(result["sent"], 1)
        log = self.reload(log)
        self.assertEqual((log.status, log.sent_at, log.provider_message_id, log.attempts), ("sent", NOON, "WAID1", 1))

    def test_kinds_priorities_and_freshness_come_from_the_catalog(self):
        self.assertEqual((catalog.kind_of("otp_login"), catalog.get("otp_login").priority), ("code", 0))
        self.assertEqual((catalog.kind_of("salary_slip"), catalog.get("salary_slip").priority), ("document", 3))
        self.assertEqual(
            (catalog.kind_of("approval_approved"), catalog.get("approval_approved").priority), ("requested", 4)
        )
        self.assertEqual((catalog.kind_of("geo_rejection"), catalog.get("geo_rejection").priority), ("requested", 4))
        for automatic in ("absent_alert", "visitor_notification", "outpass_gate_in", "hod_pending_reminder"):
            self.assertEqual(catalog.kind_of(automatic), "automatic", automatic)
        s = WhatsAppSettings.get()
        self.assertEqual(disp.freshness_minutes("absent_alert", s), 60)
        self.assertEqual(disp.freshness_minutes("late_alert", s), 30)
        self.assertEqual(disp.freshness_minutes("missing_punch_alert", s), 60)
        self.assertEqual(disp.freshness_minutes("four_punch_alert", s), s.four_punch_lead_minutes)
        self.assertEqual(disp.freshness_minutes("geo_approval", s), 120)
        self.assertIsNone(disp.freshness_minutes("approval_rejected", s))  # until the end of the day
        self.assertIsNone(disp.freshness_minutes("hod_pending_reminder", s))
        # expiry never runs past the end of the day, whatever the freshness
        late_evening = datetime(2026, 11, 6, 23, 30, tzinfo=FACTORY_TZ)
        self.assertEqual(
            disp.expiry_for("absent_alert", s, late_evening), datetime(2026, 11, 7, 0, 0, tzinfo=FACTORY_TZ)
        )

    def test_one_message_per_tick_and_at_least_the_gap_between_two(self):
        first, second = self.gate(), self.gate()
        self.assertEqual(self.tick()["sent"], 1)
        self.at(seconds=10)
        self.assertEqual(self.tick()["sent"], 0)  # the 30 s gap
        self.at(seconds=29)
        self.assertEqual(self.tick()["sent"], 0)
        self.at(seconds=30)
        self.assertEqual(self.tick()["sent"], 1)
        self.assertEqual([self.reload(first).status, self.reload(second).status], ["sent", "sent"])
        self.assertEqual(self.reload(second).sent_at - self.reload(first).sent_at, timedelta(seconds=30))

    def test_lower_priority_value_goes_first_then_the_oldest(self):
        gate = self.gate()
        self.at(seconds=1)
        approval = self.approval()
        self.tick()
        self.assertEqual((self.reload(approval).status, self.reload(gate).status), ("sent", "queued"))

    def test_the_hourly_cap(self):
        self.settings(max_per_hour=2, min_gap_seconds=5)
        rows = [self.approval() for _ in range(3)]
        for seconds in (0, 5, 10, 15):
            self.at(seconds=seconds)
            self.tick()
        self.assertEqual([self.reload(r).status for r in rows], ["sent", "sent", "queued"])
        self.assertEqual(_at(disp.queue_status(self.clock)["nextSendAt"]), NOON + timedelta(hours=1))
        self.at(hours=1)
        self.tick()
        self.assertEqual(self.reload(rows[2]).status, "sent")

    def test_the_daily_cap_counts_every_kind_including_codes(self):
        self.settings(max_per_day=2, min_gap_seconds=5)
        self.assertEqual(self.code().status, "sent")  # one of today's two
        rows = [self.approval() for _ in range(2)]
        for seconds in (5, 10, 15):
            self.at(seconds=seconds)
            self.tick()
        self.assertEqual([self.reload(r).status for r in rows], ["sent", "queued"])
        status = disp.queue_status(self.clock)
        self.assertEqual((status["sentToday"], status["queued"], status["nextSendAt"]), (2, 1, None))

    def test_a_code_is_sent_at_once_and_counts_as_the_last_message_for_the_gap(self):
        approval = self.approval()
        code = self.code()
        self.assertEqual((code.status, code.kind, code.priority, code.sent_at), ("sent", "code", 0, NOON))
        self.assertNotIn("123456", code.message_text)
        self.at(seconds=20)
        self.tick()
        self.assertEqual(self.reload(approval).status, "queued")  # 20 s after the code: still inside the gap
        self.at(seconds=30)
        self.tick()
        self.assertEqual(self.reload(approval).status, "sent")


class QuietHoursTests(QueueBase):
    def test_a_message_raised_during_quiet_hours_is_skipped_but_a_code_still_goes(self):
        self.at(hours=10)  # 22:00 IST
        log = self.gate()
        self.assertEqual((log.status, log.error_message), ("skipped", "Quiet hours: not sent"))
        self.assertEqual(self.code().status, "sent")
        self.at(hours=19, minutes=30)  # 07:30 next day: nothing comes back
        self.tick()
        self.assertEqual(self.reload(log).status, "skipped")

    def test_nothing_queued_leaves_during_quiet_hours(self):
        self.at(hours=8, minutes=59)  # 20:59
        log = self.approval()
        self.at(hours=9)  # 21:00
        self.assertEqual(self.tick()["state"], "quiet hours")
        self.post.assert_not_called()
        self.assertEqual(self.reload(log).status, "queued")
        self.assertTrue(disp.queue_status(self.clock)["inQuietHours"])

    def test_quiet_hours_can_be_moved_or_switched_off(self):
        s = WhatsAppSettings.get()
        self.assertTrue(disp.in_quiet_hours(s, datetime(2026, 11, 6, 6, 59, tzinfo=FACTORY_TZ)))
        self.assertFalse(disp.in_quiet_hours(s, datetime(2026, 11, 6, 7, 0, tzinfo=FACTORY_TZ)))
        s.quiet_start, s.quiet_end = time(13, 0), time(14, 0)  # a span inside one day
        self.assertTrue(disp.in_quiet_hours(s, datetime(2026, 11, 6, 13, 30, tzinfo=FACTORY_TZ)))
        self.assertFalse(disp.in_quiet_hours(s, datetime(2026, 11, 6, 22, 0, tzinfo=FACTORY_TZ)))
        s.quiet_hours_enabled = False
        self.assertFalse(disp.in_quiet_hours(s, datetime(2026, 11, 6, 13, 30, tzinfo=FACTORY_TZ)))


class ExpiryTests(QueueBase):
    def test_a_message_older_than_its_freshness_expires_and_is_never_sent(self):
        log = self.gate()
        self.at(minutes=31)
        result = self.tick()
        self.assertEqual(result["expired"], 1)
        log = self.reload(log)
        self.assertEqual((log.status, log.error_message), ("expired", "Too late to be useful: not sent"))
        self.post.assert_not_called()

    def test_only_todays_messages_are_ever_sent(self):
        log = self.approval()  # fresh until the end of today
        self.at(hours=20)  # 08:00 tomorrow: after quiet hours, a new day
        self.tick()
        self.assertEqual(self.reload(log).status, "expired")
        self.post.assert_not_called()

    def test_a_row_raised_yesterday_expires_even_without_an_expiry(self):
        log = self.approval()
        M.objects.filter(pk=log.pk).update(expires_at=None)
        self.at(days=1)
        self.tick()
        self.assertEqual(self.reload(log).status, "expired")


class FailureTests(QueueBase):
    def test_a_temporary_failure_is_retried_once_a_minute_later(self):
        log = self.approval()
        self.post.side_effect = requests.ConnectionError("network down")
        self.assertEqual(self.tick()["retry"], 1)
        log = self.reload(log)
        self.assertEqual((log.status, log.attempts, log.send_after), ("queued", 1, NOON + timedelta(seconds=60)))
        self.assertTrue(log.error_message.startswith("Temporary failure"))
        self.at(seconds=30)
        self.tick()
        self.assertEqual(self.post.call_count, 1)  # not before its minute is up
        self.at(seconds=60)
        self.tick()
        log = self.reload(log)
        self.assertEqual((log.status, log.attempts), ("failed", 2))  # the one retry failed too: never again
        self.at(minutes=5)
        self.tick()
        self.assertEqual(self.post.call_count, 2)

    def test_the_retry_can_succeed(self):
        log = self.approval()
        self.post.side_effect = [_resp(503, {"status": "error", "message": "busy"}), _ok("WAID9")]
        self.tick()
        self.assertEqual(self.reload(log).status, "queued")
        self.at(seconds=60)
        self.tick()
        log = self.reload(log)
        self.assertEqual((log.status, log.provider_message_id, log.error_message), ("sent", "WAID9", ""))

    def test_rate_limited_is_temporary(self):
        log = self.approval()
        self.post.return_value = _resp(429, {"status": "error", "message": "slow down"})
        self.tick()
        self.assertEqual(self.reload(log).status, "queued")

    def test_a_rejection_is_never_retried(self):
        for response in (
            _resp(400, {"status": "error", "message": "Invalid number"}),
            _resp(200, {"status": "error", "message": "Instance disconnected"}),
        ):
            with self.subTest(response=response.status_code):
                self.post.reset_mock()
                self.post.return_value = response
                log = self.approval()
                self.at(minutes=self.n * 2)
                self.tick()
                log = self.reload(log)
                self.assertEqual((log.status, log.attempts), ("failed", 1))
                self.assertTrue(log.error_message.startswith("Send failed"))

    def test_no_retry_when_the_message_would_be_stale_by_then(self):
        log = self.gate()  # expires at 12:30
        self.at(minutes=29, seconds=30)
        self.post.side_effect = requests.Timeout("slow")
        self.tick()
        self.assertEqual(self.reload(log).status, "failed")

    def test_a_row_stuck_sending_after_a_restart_is_marked_failed_not_retried(self):
        log = self.approval()
        M.objects.filter(pk=log.pk).update(status="sending")
        self.at(minutes=5)
        self.assertEqual(self.tick()["sent"], 0)  # a message is "going out": nothing else leaves meanwhile
        self.at(minutes=11)
        self.assertEqual(svc.expire_stale_pending(), 1)
        log = self.reload(log)
        self.assertEqual(log.status, "failed")
        self.assertIn("never sent", log.error_message)


class PerEmployeeAndDuplicateTests(QueueBase):
    def test_at_most_three_automatic_messages_per_employee_per_day(self):
        self.settings(min_gap_seconds=5)
        rows = [self.gate() for _ in range(4)]
        approval = self.approval()  # a decision on their own request is not capped
        other = self.gate(emp=self.other)
        for i in range(8):
            self.at(seconds=5 * i)
            self.tick()
        statuses = [self.reload(r).status for r in rows]
        self.assertEqual(statuses.count("sent"), 3)
        skipped = next(self.reload(r) for r in rows if r.status == "skipped")
        self.assertEqual(skipped.error_message, "Daily limit for this employee")
        self.assertEqual((self.reload(approval).status, self.reload(other).status), ("sent", "sent"))

    def test_the_same_text_to_the_same_employee_within_24_hours_is_skipped(self):
        self.settings(min_gap_seconds=5)
        params = {"employee_name": "Asha", "request_type": "Leave", "details": "Casual leave"}
        first = svc.send_notification(self.emp, "approval_approved", params, related_module="leave", dedupe_key="a:1")
        second = svc.send_notification(self.emp, "approval_approved", params, related_module="leave", dedupe_key="a:2")
        self.tick()
        self.at(seconds=5)
        self.tick()
        self.assertEqual(self.reload(first).status, "sent")
        second = self.reload(second)
        self.assertEqual((second.status, second.error_message), ("skipped", "Duplicate"))


class CircuitBreakerTests(QueueBase):
    def failure(self, minutes_ago, error="Send failed: instance disconnected"):
        row = M.objects.create(
            employee=self.emp, document_type="approval_approved", phone_number="x", status="failed", error_message=error
        )
        M.objects.filter(pk=row.pk).update(updated_at=NOON - timedelta(minutes=minutes_ago))

    def test_three_provider_failures_in_30_minutes_pause_sending_until_15_minutes_after_the_last(self):
        for minutes_ago in (20, 10, 5):
            self.failure(minutes_ago)
        log = self.approval()
        self.assertEqual(self.tick()["state"], "paused")
        status = disp.queue_status(self.clock)
        self.assertTrue(status["paused"])
        self.assertIn("failed at WhatsApp", status["pausedReason"])
        self.assertEqual(_at(status["nextSendAt"]), NOON + timedelta(minutes=10))
        self.at(minutes=10)  # 15 minutes after the last failure
        self.tick()
        self.assertEqual(self.reload(log).status, "sent")

    def test_a_disconnected_number_pauses_at_the_first_failure_with_what_to_do(self):
        # live log 2026-11-06: 1,229 messages were tried against an "inactive" WAClient instance
        self.failure(2, error="Send failed: This instance ID is inactive. Please relogin to your WhatsApp account.")
        log = self.approval()
        self.assertEqual(self.tick()["state"], "paused")
        status = disp.queue_status(self.clock)
        self.assertIn("WhatsApp is disconnected", status["pausedReason"])
        self.assertIn("scanning the QR code", status["pausedReason"])
        self.assertEqual(_at(status["nextSendAt"]), NOON + timedelta(minutes=28))
        self.post.assert_not_called()
        self.at(minutes=28)  # 30 minutes after the failure: one probe
        self.tick()
        self.assertEqual(self.reload(log).status, "sent")

    def test_an_expired_plan_pauses_at_once_and_a_later_success_clears_it(self):
        self.failure(1, error="Send failed: Your plan has expired. Please upgrade or extend your plan.")
        self.assertIn("WAClient plan has expired", disp.queue_status(self.clock)["pausedReason"])
        M.objects.create(
            employee=self.emp, document_type="otp_login", phone_number="x", status="sent", sent_at=NOON
        )  # a code went out after the failure (plan renewed): no longer paused
        self.assertFalse(disp.queue_status(self.clock)["paused"])

    def test_an_employee_without_a_phone_is_not_a_provider_failure(self):
        for minutes_ago in (20, 10, 5):
            self.failure(minutes_ago, error="No phone number on file for this employee.")
        log = self.approval()
        self.tick()
        self.assertEqual(self.reload(log).status, "sent")
        self.assertFalse(disp.queue_status(self.clock)["paused"])


class SwitchTests(QueueBase):
    def test_the_master_switch_stops_everything_including_codes(self):
        queued = self.approval()
        self.settings(engine_enabled=False)
        self.assertIsNone(self.code())
        self.assertIsNone(self.gate())
        self.assertEqual(self.tick()["state"], "engine off")
        self.assertEqual(self.reload(queued).status, "queued")  # waits (and expires at midnight if never switched on)
        self.post.assert_not_called()

    def test_with_the_master_switch_off_the_apps_treat_whatsapp_as_unavailable(self):
        self.settings(engine_enabled=False)
        options = otp_service.login_options()
        self.assertEqual((options["otpLogin"], options["otpActivate"], options["passwordLogin"]), (False, False, True))
        self.assertFalse(otp_service.activation_required())  # nobody is locked out of the first-time setup
        r = self.client.post(
            "/api/auth/otp/request", {"employeeCode": "D1", "purpose": "login"}, content_type="application/json"
        )
        self.assertEqual(r.status_code, 503)
        self.post.assert_not_called()
        self.settings(engine_enabled=True)
        self.assertTrue(otp_service.login_options()["otpLogin"])

    def test_every_type_can_be_switched_off_on_its_own(self):
        self.settings(disabled_message_types=["outpass_gate_out"])
        self.assertIsNone(self.gate())
        self.assertEqual(self.approval().status, "queued")
        self.assertIn("switched off", svc.switch_off_reason("outpass_gate_out"))
        # a type that shares its boolean with another (the four Geo decisions) can be switched off alone
        self.assertIn("geo_punch_rejection", catalog.individually_switched())
        self.assertNotIn("absent_alert", catalog.individually_switched())  # has its own boolean

    def test_a_message_switched_off_after_it_was_queued_is_skipped(self):
        log = self.gate()
        self.settings(outpass_notifications_enabled=False)
        self.tick()
        log = self.reload(log)
        self.assertEqual(log.status, "skipped")
        self.assertIn("Switched off before it was sent", log.error_message)


class OptOutTests(QueueBase):
    def test_an_opted_out_employee_gets_no_notifications_or_documents_but_still_gets_codes(self):
        WhatsAppOptOut.objects.create(employee=self.emp, reason="Shared phone")
        log = self.gate()
        self.assertEqual((log.status, log.error_message), ("skipped", svc.REASON_OPTED_OUT))
        doc = svc.send_document(None, self.emp, "salary_slip", b"%PDF", "s.pdf", ["Asha", "Oct 2026"])
        self.assertEqual(doc.status, "skipped")
        self.assertEqual(self.code().status, "sent")

    def test_an_opt_out_after_queueing_stops_the_message(self):
        log = self.gate()
        WhatsAppOptOut.objects.create(employee=self.emp)
        self.tick()
        self.assertEqual(self.reload(log).status, "skipped")


class DocumentAndVisitorTests(QueueBase):
    def test_a_document_is_queued_with_its_media_link_and_sent_as_a_document(self):
        log = svc.send_document(None, self.emp, "salary_slip", b"%PDF", "s.pdf", ["Asha", "October 2026"])
        self.assertEqual((log.status, log.kind, log.priority), ("queued", "document", 3))
        self.assertTrue(log.payload["media_url"].startswith("https://api.example.test/api/whatsapp/media/"))
        self.tick()
        body = self.post.call_args.kwargs["json"]
        self.assertEqual(
            (body["type"], body["filename"], body["media_url"]), ("document", "s.pdf", log.payload["media_url"])
        )
        self.assertEqual(self.reload(log).status, "sent")

    def test_the_visitor_contact_card_follows_the_message_and_reception_is_stamped(self):
        from .models import VisitorVisit

        visit = mock.Mock(id=0)
        with mock.patch.object(VisitorVisit.objects, "filter") as stamp:
            log = svc.send_notification(
                self.emp,
                "visitor_notification",
                {"employee_name": "Asha", "visitor_name": "Vishal"},
                document_ref_id=77,
                contact={"document_type": "visitor_contact", "first_name": "Vishal", "last_name": "", "phone": "9876"},
                on_sent="visitor_notified",
            )
            self.assertEqual(log.status, "queued")
            self.tick()
        self.assertEqual(self.reload(log).status, "sent")
        card = M.objects.get(document_type="visitor_contact")
        self.assertEqual((card.status, card.payload["follow_up_of"]), ("sent", log.pk))
        stamp.assert_called_once_with(pk=77)
        self.assertEqual(self.post.call_count, 2)
        del visit


class BulkTests(QueueBase):
    def setUp(self):
        super().setUp()
        admin = HRUser.objects.create(username="bulk_admin", password_hash="x", is_super_admin=True)
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}
        nophone = Employee.objects.create(employee_code="D3", first_name="No", last_name="Phone", status="active")
        for i, emp in enumerate((self.emp, self.other, nophone)):
            SalarySlip.objects.create(employee=emp, month=10, year=2026, slip_number=f"SS-10-{i}")

    def test_a_bulk_send_queues_one_document_per_employee_and_reports_progress_from_the_rows(self):
        with mock.patch("api.salary_slip_views.whatsapp_slip_pdf", return_value=b"%PDF-slip") as build:
            r = self.client.post(
                "/api/salary-slips/bulk-whatsapp",
                {"month": 10, "year": 2026},
                content_type="application/json",
                **self.hr,
            )
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertEqual((body["total"], body["queued"], body["sent"], body["failed"]), (3, 2, 0, 1))
            self.assertIn("end of today", body["message"])
            self.assertIn("No phone", body["failures"][0]["error"])
            build.assert_not_called()  # the PDF is built when the row's turn comes
            rows = M.objects.filter(payload__batch=body["batchId"])
            self.assertEqual(sorted(rows.values_list("priority", flat=True)), [6, 6, 6])  # behind time-critical ones

            snap = self.client.get("/api/salary-slips/bulk-whatsapp-progress", **self.hr).json()
            self.assertEqual(
                (snap["stage"], snap["total"], snap["completed"], snap["succeeded"], snap["failed"], snap["queued"]),
                ("running", 3, 1, 0, 1, 2),
            )
            self.tick()
            self.at(seconds=30)
            self.tick()
            self.assertEqual(build.call_count, 2)
        snap = self.client.get("/api/salary-slips/bulk-whatsapp-progress", **self.hr).json()
        self.assertEqual((snap["stage"], snap["succeeded"], snap["failed"]), ("completed", 2, 1))
        self.assertEqual(self.post.call_args.kwargs["json"]["type"], "document")

    def test_what_is_left_at_midnight_expires_and_counts_as_not_sent(self):
        with mock.patch("api.salary_slip_views.whatsapp_slip_pdf", return_value=b"%PDF"):
            body = self.client.post(
                "/api/salary-slips/bulk-whatsapp",
                {"month": 10, "year": 2026},
                content_type="application/json",
                **self.hr,
            ).json()
        self.at(hours=20)
        self.tick()
        snap = progress.snapshot(body["batchId"])
        self.assertEqual((snap["stage"], snap["expired"], snap["failed"]), ("completed", 2, 3))

    def test_the_message_says_how_much_can_go_today(self):
        self.settings(max_per_day=1)
        self.assertIn("only about 1 can go out today", progress.queued_message(5, NOON))

    def test_the_master_switch_refuses_a_bulk_send_up_front(self):
        self.settings(engine_enabled=False)
        r = self.client.post(
            "/api/salary-slips/bulk-whatsapp", {"month": 10, "year": 2026}, content_type="application/json", **self.hr
        )
        self.assertEqual(r.status_code, 400)
        self.assertFalse(M.objects.exists())


class InlineDeliveryTests(QueueBase):
    """Under `manage.py test` defaults (WHATSAPP_ASYNC_SEND False) a queued row is delivered at once."""

    @override_settings(WHATSAPP_ASYNC_SEND=False)
    def test_inline_mode_ignores_quiet_hours_and_caps_but_keeps_switches_and_opt_out(self):
        self.at(hours=10)  # 22:00
        self.assertEqual(self.gate().status, "sent")
        WhatsAppOptOut.objects.create(employee=self.other)
        self.assertEqual(self.gate(emp=self.other).status, "skipped")


@override_settings(**CONFIG)
class ControlApiTests(QueueBase):
    BASE = "/api/whatsapp-control"

    def setUp(self):
        super().setUp()
        admin = HRUser.objects.create(username="wa_q_admin", full_name="Meena", password_hash="x", is_super_admin=True)
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}

    def put(self, body):
        return self.client.put(f"{self.BASE}/settings", body, content_type="application/json", **self.hr)

    def test_settings_show_the_master_switch_type_switches_queue_limits_and_quiet_hours(self):
        body = self.client.get(f"{self.BASE}/settings", **self.hr).json()
        self.assertIs(body["engineEnabled"], True)
        self.assertEqual(
            [(q["key"], q["value"], q["min"], q["max"], q["unit"]) for q in body["queueLimits"]],
            [
                ("minGapSeconds", 30, 5, 600, "seconds"),
                ("maxPerHour", 60, 1, 1000, "messages"),
                ("maxPerDay", 200, 1, 5000, "messages"),
                ("maxPerEmployeePerDay", 3, 1, 20, "messages"),
            ],
        )
        self.assertEqual(body["quietHours"], {"enabled": True, "start": "21:00", "end": "07:00"})
        keys = {f["key"]: f for f in body["features"]}
        for doc_type in catalog.individually_switched():
            entry = keys[f"type:{doc_type}"]
            self.assertEqual(
                (entry["group"], entry["label"], entry["enabled"]),
                (catalog.get(doc_type).module, catalog.label(doc_type), True),
            )
        group_keys = {g["key"] for g in body["groups"]}
        self.assertTrue({f["group"] for f in body["features"]} <= group_keys)
        self.assertIn("otpLoginEnabled", keys)  # the existing entries stay

    def test_put_changes_them_and_refuses_bad_values(self):
        r = self.put(
            {
                "engineEnabled": False,
                "type:salary_slip": False,
                "minGapSeconds": 45,
                "maxPerHour": "40",
                "quietHours": {"start": "22:30"},
            }
        )
        self.assertEqual(r.status_code, 200, r.content)
        s = WhatsAppSettings.get()
        self.assertEqual(
            (s.engine_enabled, s.disabled_message_types, s.min_gap_seconds, s.max_per_hour, s.quiet_start, s.quiet_end),
            (False, ["salary_slip"], 45, 40, time(22, 30), time(7, 0)),
        )
        self.assertEqual(r.json()["quietHours"]["start"], "22:30")
        self.assertEqual(self.put({"type:salary_slip": True}).json()["engineEnabled"], False)
        self.assertEqual(WhatsAppSettings.get().disabled_message_types, [])
        for bad in (
            {"engineEnabled": "no"},
            {"minGapSeconds": 4},
            {"maxPerDay": 5001},
            {"maxPerEmployeePerDay": True},
            {"maxPerHour": 1.5},
            {"quietHours": {"end": "25:00"}},
            {"quietHours": "21-07"},
            {"type:absent_alert": False},  # has its own switch
            {"type:nonsense": False},
        ):
            with self.subTest(bad=bad):
                r = self.put(bad)
                self.assertEqual(r.status_code, 400)
                self.assertTrue(r.json()["error"])

    def test_queue_status_and_clear(self):
        self.approval()
        self.gate()
        body = self.client.get(f"{self.BASE}/queue", **self.hr).json()
        self.assertEqual(
            set(body),
            {
                "engineEnabled",
                "paused",
                "pausedReason",
                "inQuietHours",
                "queued",
                "sentToday",
                "sentLastHour",
                "failedToday",
                "expiredToday",
                "skippedToday",
                "nextSendAt",
                "limits",
            },
        )
        self.assertEqual((body["queued"], _at(body["nextSendAt"])), (2, NOON))
        self.assertEqual(
            body["limits"], {"minGapSeconds": 30, "maxPerHour": 60, "maxPerDay": 200, "maxPerEmployeePerDay": 3}
        )
        r = self.client.post(f"{self.BASE}/queue/clear", **self.hr)
        self.assertEqual(r.json(), {"cleared": 2})
        self.assertEqual(set(M.objects.values_list("status", "error_message")), {("skipped", "Cleared by HR")})
        body = self.client.get(f"{self.BASE}/queue", **self.hr).json()
        self.assertEqual((body["queued"], body["skippedToday"], body["nextSendAt"]), (0, 2, None))

    def test_employees_show_and_change_the_opt_out(self):
        self.gate()
        rows = self.client.get(f"{self.BASE}/employees", **self.hr).json()
        self.assertEqual([(r["employeeCode"], r["optOut"]) for r in rows], [("D1", False)])
        r = self.client.patch(
            f"{self.BASE}/employees/{self.other.id}/opt-out",
            {"optOut": True, "reason": "Asked to stop"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            (r.json()["optOut"], r.json()["optOutReason"], r.json()["optOutBy"]), (True, "Asked to stop", "Meena")
        )
        codes = {
            row["employeeCode"]: row["optOut"] for row in self.client.get(f"{self.BASE}/employees", **self.hr).json()
        }
        self.assertEqual(codes, {"D1": False, "D2": True})  # an opted-out employee is listed even without messages
        everyone = self.client.get(f"{self.BASE}/employees", {"all": "1", "optOut": "false"}, **self.hr).json()
        self.assertEqual([row["employeeCode"] for row in everyone], ["D1"])
        r = self.client.patch(
            f"{self.BASE}/employees/{self.other.id}/opt-out",
            {"optOut": False},
            content_type="application/json",
            **self.hr,
        )
        self.assertIs(r.json()["optOut"], False)
        self.assertFalse(WhatsAppOptOut.objects.exists())
        for bad in ({}, {"optOut": "yes"}, {"optOut": True, "reason": 5}):
            r = self.client.patch(
                f"{self.BASE}/employees/{self.other.id}/opt-out", bad, content_type="application/json", **self.hr
            )
            self.assertEqual(r.status_code, 400)
        r = self.client.patch(
            f"{self.BASE}/employees/999999/opt-out", {"optOut": True}, content_type="application/json", **self.hr
        )
        self.assertEqual(r.status_code, 404)

    def test_messages_filter_by_the_new_statuses_and_show_the_queue_fields(self):
        self.gate()
        rows = self.client.get(f"{self.BASE}/messages", {"status": "queued"}, **self.hr).json()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            (row["kind"], row["sentAt"], _at(row["expiresAt"]), row["attempts"]),
            ("automatic", None, NOON + timedelta(minutes=30), 0),
        )
        for status in ("sending", "expired", "skipped"):
            self.assertEqual(self.client.get(f"{self.BASE}/messages", {"status": status}, **self.hr).status_code, 200)
        overview = self.client.get(f"{self.BASE}/overview", **self.hr).json()
        self.assertEqual(overview["today"]["queued"], 1)

    def test_only_hr_can_use_the_queue_endpoints(self):
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.emp.id})}"}
        self.assertEqual(self.client.get(f"{self.BASE}/queue", **emp).status_code, 403)
        self.assertEqual(self.client.post(f"{self.BASE}/queue/clear", **emp).status_code, 403)
        self.assertEqual(
            self.client.patch(
                f"{self.BASE}/employees/{self.emp.id}/opt-out", {"optOut": True}, content_type="application/json", **emp
            ).status_code,
            403,
        )


class MigrationTests(TestCase):
    def test_the_data_step_switches_the_punch_reminders_off(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"four_punch_alert_enabled": True})
        import_module("api.migrations.0143_whatsapp_send_queue").punch_reminders_off(django_apps, None)
        self.assertFalse(WhatsAppSettings.get().four_punch_alert_enabled)

    def test_the_careful_defaults(self):
        s = WhatsAppSettings.get()
        self.assertEqual(
            (
                s.engine_enabled,
                s.min_gap_seconds,
                s.max_per_hour,
                s.max_per_day,
                s.max_per_employee_per_day,
                s.quiet_hours_enabled,
                s.quiet_start,
                s.quiet_end,
                s.four_punch_alert_enabled,
            ),
            (True, 30, 60, 200, 3, True, time(21, 0), time(7, 0), False),
        )


class DefaultWordingTests(TestCase):
    def test_default_wordings_are_plain_signed_and_carry_no_emoji_or_link_in_automatic_messages(self):
        import re

        emoji = re.compile("[\U0001f300-\U0001faff☀-➿]")
        for key, spec in catalog.TYPES.items():
            if not spec.has_wording or spec.kind == "code" or key == "hod_pending_reminder":
                continue
            with self.subTest(key=key):
                self.assertFalse(emoji.search(spec.body), key)
                self.assertTrue(spec.body.rstrip().endswith(catalog.SIGN), key)
                if spec.kind == "automatic":
                    text = svc.render_message(spec.body, catalog.sample_params(key), spec.variable_names)
                    self.assertNotRegex(text, r"https?://")
