"""Meta's WhatsApp webhook: the verification handshake, the signature on every POST, delivery statuses with pricing,
STOP replies, template status / quality updates, last-received time, and no personal data in the logs.

Run via: python manage.py test api.tests_whatsapp_webhook --noinput
"""

import hashlib
import hmac
import json
from datetime import datetime, timezone as dt_timezone

from django.test import TestCase, override_settings

from . import otp_service, whatsapp_service
from .models import Employee, WhatsAppMessageLog, WhatsAppOptOut, WhatsAppSettings, WhatsAppTemplate
from .tests_whatsapp_support import APP_SECRET, META, VERIFY_TOKEN, FakeMeta, approve_templates

URL = "/api/whatsapp/webhook/"
TS = "1795113000"  # 20 Nov 2026 00:00 IST


def sign(raw: bytes, secret: str = APP_SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def envelope(field: str, value: dict, account: str | None = "205550002222") -> dict:
    entry = {"changes": [{"field": field, "value": value}]}
    if account is not None:
        entry["id"] = account
    return {"object": "whatsapp_business_account", "entry": [entry]}


def template_event(event: str, name: str, account: str | None = "205550002222", **extra) -> dict:
    value = {"event": event, "message_template_name": name, "message_template_language": "en", **extra}
    return envelope("message_template_status_update", value, account)


def statuses(*items) -> dict:
    return envelope(
        "messages",
        {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": "919800000000", "phone_number_id": "105550001111"},
            "statuses": list(items),
        },
    )


@override_settings(**META)
class Base(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(employee_code="WH1", first_name="W", last_name="H", phone="9876543210")
        self.log = WhatsAppMessageLog.objects.create(
            employee=self.emp,
            document_type="salary_slip",
            phone_number="919876543210",
            provider_message_id="wamid.ABC",
            status="sent",
        )

    def post(self, body, signature: str | None = "auto", path: str = URL, raw: bytes | None = None):
        raw = raw if raw is not None else json.dumps(body).encode()
        headers = {}
        if signature == "auto":
            headers["HTTP_X_HUB_SIGNATURE_256"] = sign(raw)
        elif signature is not None:
            headers["HTTP_X_HUB_SIGNATURE_256"] = signature
        return self.client.post(path, raw, content_type="application/json", **headers)

    def reload(self):
        self.log.refresh_from_db()
        return self.log


class VerificationTests(Base):
    def test_metas_handshake_returns_the_challenge_as_plain_text(self):
        for path in (URL, URL.rstrip("/")):
            r = self.client.get(
                path, {"hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444"}
            )
            self.assertEqual((r.status_code, r.content, r["Content-Type"]), (200, b"1158201444", "text/plain"))

    def test_a_wrong_or_missing_token_or_mode_is_403(self):
        for params in (
            {"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1"},
            {"hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1"},
            {"hub.challenge": "1"},
            {},
        ):
            r = self.client.get(URL, params)
            self.assertEqual(r.status_code, 403, params)
            self.assertNotIn(b"1", r.content.replace(b"Forbidden", b""))

    @override_settings(WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN="")
    def test_no_verify_token_configured_refuses_every_handshake(self):
        r = self.client.get(URL, {"hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1"})
        self.assertEqual(r.status_code, 403)

    def test_no_login_is_needed(self):
        r = self.client.get(URL, {"hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "7"})
        self.assertEqual(r.status_code, 200)  # no Authorization header at all


class SignatureTests(Base):
    def test_an_unsigned_or_badly_signed_post_is_403_and_never_processed(self):
        body = statuses({"id": "wamid.ABC", "status": "read", "timestamp": TS})
        for signature in (None, "", "sha256=deadbeef", sign(b"something else"), sign(json.dumps(body).encode(), "x")):
            r = self.post(body, signature=signature)
            self.assertEqual(r.status_code, 403, signature)
        self.assertEqual(self.reload().status, "sent")
        self.assertIsNone(WhatsAppSettings.get().last_webhook_at)

    @override_settings(WHATSAPP_CLOUD_APP_SECRET="")
    def test_no_app_secret_configured_refuses_every_post(self):
        raw = json.dumps(statuses({"id": "wamid.ABC", "status": "read"})).encode()
        r = self.post(None, signature=sign(raw), raw=raw)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.reload().status, "sent")

    def test_a_signed_post_is_always_200_and_stamps_last_received(self):
        self.assertEqual(self.post({}).status_code, 200)
        self.assertIsNotNone(WhatsAppSettings.get().last_webhook_at)
        self.assertEqual(self.post(None, raw=b"{not json").status_code, 200)
        self.assertEqual(self.post([1, 2, "x"]).status_code, 200)
        self.assertEqual(self.post({"entry": "nope"}).status_code, 200)
        self.assertEqual(self.post({"entry": [{"changes": [{"field": "messages", "value": "x"}]}]}).status_code, 200)

    def test_other_methods(self):
        self.assertEqual(self.client.put(URL).status_code, 405)


class StatusTests(Base):
    def test_delivered_then_read_with_times_and_pricing(self):
        pricing = {"billable": True, "pricing_model": "PMP", "category": "utility", "type": "regular"}
        self.post(statuses({"id": "wamid.ABC", "status": "delivered", "timestamp": TS, "pricing": pricing}))
        log = self.reload()
        self.assertEqual((log.status, log.pricing_category, log.billable), ("delivered", "utility", True))
        self.assertEqual(log.delivered_at, datetime(2026, 11, 19, 18, 30, tzinfo=dt_timezone.utc))
        self.post(statuses({"id": "wamid.ABC", "status": "read", "timestamp": str(int(TS) + 60)}))
        log = self.reload()
        self.assertEqual(log.status, "read")
        self.assertEqual((log.read_at - log.delivered_at).total_seconds(), 60)

    def test_read_alone_also_fills_delivered(self):
        self.post(statuses({"id": "wamid.ABC", "status": "read", "timestamp": TS}))
        log = self.reload()
        self.assertEqual((log.status, log.delivered_at, log.read_at), ("read", log.read_at, log.read_at))
        self.assertIsNotNone(log.read_at)

    def test_late_or_duplicate_events_never_go_backwards(self):
        self.post(statuses({"id": "wamid.ABC", "status": "read", "timestamp": TS}))
        self.post(statuses({"id": "wamid.ABC", "status": "delivered", "timestamp": TS}))
        self.post(statuses({"id": "wamid.ABC", "status": "sent", "timestamp": TS}))
        self.assertEqual(self.reload().status, "read")

    def test_a_free_service_message_is_recorded_not_billable(self):
        pricing = {"billable": False, "category": "service", "pricing_model": "PMP"}
        self.post(statuses({"id": "wamid.ABC", "status": "sent", "timestamp": TS, "pricing": pricing}))
        log = self.reload()
        self.assertEqual((log.billable, log.pricing_category), (False, "service"))

    def test_a_failure_with_metas_error_in_plain_words(self):
        self.post(
            statuses(
                {
                    "id": "wamid.ABC",
                    "status": "failed",
                    "timestamp": TS,
                    "errors": [
                        {
                            "code": 131026,
                            "title": "Message undeliverable.",
                            "error_data": {"details": "Message Undeliverable."},
                        }
                    ],
                }
            )
        )
        log = self.reload()
        self.assertEqual(log.status, "failed")
        self.assertTrue(log.error_message.startswith("Refused by WhatsApp: "))
        self.assertTrue(log.error_message.endswith("(code 131026)"))
        self.post(statuses({"id": "wamid.ABC", "status": "delivered", "timestamp": TS}))
        self.assertEqual(self.reload().status, "failed")  # a failure is final

    def test_an_account_level_failure_reads_as_a_provider_failure(self):
        self.post(
            statuses({"id": "wamid.ABC", "status": "failed", "errors": [{"code": 131042, "title": "Payment issue"}]})
        )
        self.assertTrue(self.reload().error_message.startswith("Send failed: "))

    def test_unknown_ids_and_unknown_statuses_are_ignored(self):
        self.assertEqual(self.post(statuses({"id": "wamid.NOPE", "status": "read"})).status_code, 200)
        self.post(statuses({"id": "wamid.ABC", "status": "deleted"}, {"status": "read"}, "x"))
        self.assertEqual(self.reload().status, "sent")

    def test_several_statuses_in_one_body(self):
        other = WhatsAppMessageLog.objects.create(
            employee=self.emp, document_type="late_alert", phone_number="919876543210", provider_message_id="wamid.DEF"
        )
        self.post(
            statuses(
                {"id": "wamid.ABC", "status": "delivered", "timestamp": TS},
                {"id": "wamid.DEF", "status": "read", "timestamp": TS},
            )
        )
        other.refresh_from_db()
        self.assertEqual((self.reload().status, other.status), ("delivered", "read"))


class StopTests(Base):
    def inbound(self, text: str, sender: str = "919876543210", kind: str = "text"):
        message = {"from": sender, "id": "wamid.IN1", "timestamp": TS, "type": kind}
        if kind == "text":
            message["text"] = {"body": text}
        return self.post(
            envelope(
                "messages",
                {
                    "messaging_product": "whatsapp",
                    "contacts": [{"profile": {"name": "W H"}, "wa_id": sender}],
                    "messages": [message],
                },
            )
        )

    def test_an_employee_who_replies_stop_is_opted_out(self):
        for text in ("STOP", " stop "):
            self.assertEqual(self.inbound(text).status_code, 200)
        opt = WhatsAppOptOut.objects.get(employee=self.emp)
        self.assertEqual(opt.reason, "Replied STOP")
        self.assertEqual(WhatsAppOptOut.objects.count(), 1)

    def test_other_replies_and_strangers_change_nothing(self):
        self.inbound("Please stop the reminders after 6")
        self.inbound("STOP", sender="919000000000")  # not an employee's number
        self.inbound("", kind="image")
        self.assertFalse(WhatsAppOptOut.objects.exists())

    def test_a_number_saved_with_spaces_or_a_plus_still_matches(self):
        Employee.objects.filter(pk=self.emp.pk).update(phone="+91 98765 43210")
        self.inbound("Stop")
        self.assertTrue(WhatsAppOptOut.objects.filter(employee=self.emp).exists())

    def test_a_stop_from_a_shared_number_opts_out_every_record_on_it(self):
        twin = Employee.objects.create(employee_code="WH2", first_name="T", last_name="W", phone="09876543210")
        other = Employee.objects.create(employee_code="WH3", first_name="O", last_name="X", phone="9123456789")
        self.inbound("STOP")
        self.assertEqual(set(WhatsAppOptOut.objects.values_list("employee__employee_code", flat=True)), {"WH1", "WH2"})
        self.assertTrue(whatsapp_service.opted_out(twin))
        self.assertFalse(whatsapp_service.opted_out(other))


class TemplateEventTests(Base):
    def test_approval_rejection_and_pause_update_the_template(self):
        WhatsAppTemplate.objects.create(name="hrms_late_alert", language="en", status="PENDING", meta_id="111")
        status = "message_template_status_update"
        self.post(envelope(status, {"event": "APPROVED", "message_template_id": 111, "message_template_name": "hrms_late_alert", "message_template_language": "en", "reason": "NONE"}))  # fmt: skip
        row = WhatsAppTemplate.objects.get(name="hrms_late_alert")
        self.assertEqual((row.status, row.rejected_reason), ("APPROVED", ""))
        self.post(envelope(status, {"event": "REJECTED", "message_template_id": 111, "message_template_name": "hrms_late_alert", "message_template_language": "en", "reason": "INVALID_FORMAT"}))  # fmt: skip
        row.refresh_from_db()
        self.assertEqual((row.status, row.rejected_reason), ("REJECTED", "INVALID_FORMAT"))
        self.post(envelope(status, {"event": "PAUSED", "message_template_name": "hrms_late_alert", "message_template_language": "en"}))  # fmt: skip
        row.refresh_from_db()
        self.assertEqual((row.status, row.rejected_reason), ("PAUSED", ""))

    def test_a_template_this_server_did_not_know_is_added(self):
        self.post(
            envelope(
                "message_template_status_update",
                {
                    "event": "APPROVED",
                    "message_template_id": 222,
                    "message_template_name": "hrms_new",
                    "message_template_language": "en_US",
                },
            )
        )
        row = WhatsAppTemplate.objects.get(name="hrms_new")
        self.assertEqual((row.language, row.status, row.meta_id), ("en_US", "APPROVED", "222"))

    def test_reinstated_makes_a_paused_template_usable_again(self):
        approve_templates("otp_login", status="PAUSED")
        self.assertEqual(otp_service.whatsapp_template_status("login"), "PAUSED")
        self.post(template_event("REINSTATED", "hrms_otp", message_template_id="meta-hrms_otp", reason="NONE"))
        row = WhatsAppTemplate.objects.get(name="hrms_otp")
        self.assertEqual(row.status, "APPROVED")
        self.assertIsNone(whatsapp_service.template_problem("otp_login"))
        self.assertEqual(otp_service.whatsapp_template_status("login"), "APPROVED")

    def test_flagged_and_locked_leave_an_approved_template_sendable(self):
        (row,) = approve_templates("approval_approved")
        for event in ("FLAGGED", "LOCKED", "UNLOCKED"):
            with self.subTest(event):
                self.post(template_event(event, row.name, message_template_id=row.meta_id))
                row.refresh_from_db()
                self.assertEqual(row.status, "APPROVED")
                self.assertIsNone(whatsapp_service.template_problem("approval_approved"))
        self.assertEqual(row.quality_score, "RED")  # a flag shows as low quality (WhatsApp Control alerts on it)

    def test_unarchived_brings_back_an_archived_template_but_not_a_rejected_one(self):
        (row,) = approve_templates("late_alert")
        self.post(template_event("ARCHIVED", row.name))
        row.refresh_from_db()
        self.assertEqual(row.status, "ARCHIVED")
        self.assertIsNotNone(whatsapp_service.template_problem("late_alert"))
        self.post(template_event("UNARCHIVED", row.name))
        row.refresh_from_db()
        self.assertEqual(row.status, "APPROVED")
        # one that was archived after Meta rejected it comes back rejected
        self.post(template_event("REJECTED", row.name, reason="INVALID_FORMAT"))
        self.post(template_event("ARCHIVED", row.name))
        self.post(template_event("UNARCHIVED", row.name))
        row.refresh_from_db()
        self.assertEqual((row.status, row.rejected_reason), ("REJECTED", "INVALID_FORMAT"))
        # UNARCHIVED never touches a template that was not archived
        self.post(template_event("APPROVED", row.name))
        self.post(template_event("UNARCHIVED", row.name))
        row.refresh_from_db()
        self.assertEqual(row.status, "APPROVED")

    def test_an_event_this_server_does_not_know_changes_nothing(self):
        (row,) = approve_templates("late_alert")
        with self.assertLogs("api.whatsapp_views", level="WARNING") as logs:
            self.post(template_event("SOMETHING_NEW", row.name))
        row.refresh_from_db()
        self.assertEqual(row.status, "APPROVED")
        self.assertIn("SOMETHING_NEW", "\n".join(logs.output))
        self.post(template_event("FLAGGED", "hrms_never_seen"))  # a note about an unknown template adds nothing
        self.assertFalse(WhatsAppTemplate.objects.filter(name="hrms_never_seen").exists())

    def test_a_code_template_first_seen_in_an_event_is_an_authentication_template(self):
        # HR made hrms_otp in WhatsApp Manager (the documented fallback); Meta's approval arrives before any Sync now
        meta = FakeMeta.install(self)
        self.post(template_event("APPROVED", "hrms_otp", message_template_id="123123", reason="NONE"))
        row = WhatsAppTemplate.objects.get(name="hrms_otp")
        self.assertEqual((row.category, row.status, row.components), ("AUTHENTICATION", "APPROVED", []))
        self.assertEqual(otp_service.whatsapp_template_status("login"), "APPROVED")
        whatsapp_service.deliver_code("919876543210", "otp_login", "123456", minutes=5)
        sent = meta.last()
        self.assertEqual(sent["params"], {"1": "123456"})  # the copy-code shape Meta wants
        self.assertEqual(sent["button"], "123456")
        # a template no HRMS type is sent as: Utility; Meta's own word wins when the event carries it
        self.post(template_event("APPROVED", "hrms_hand_made"))
        self.post(template_event("APPROVED", "hrms_promo", message_template_category="MARKETING"))
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_hand_made").category, "UTILITY")
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_promo").category, "MARKETING")

    def test_a_row_without_components_is_sent_by_its_types_category(self):
        # a row an older server added from an event, filed as Utility: the code still goes out the copy-code way
        meta = FakeMeta.install(self)
        WhatsAppTemplate.objects.create(name="hrms_otp", language="en", status="APPROVED", category="UTILITY")
        self.assertEqual(whatsapp_service.template_for("otp_login").category, "AUTHENTICATION")
        whatsapp_service.deliver_code("919876543210", "otp_login", "654321", minutes=5)
        self.assertEqual(meta.last()["button"], "654321")

    def test_a_category_change_at_meta_is_recorded(self):
        (row,) = approve_templates("late_alert")
        self.post(
            envelope(
                "template_category_update",
                {
                    "message_template_id": row.meta_id,
                    "message_template_name": row.name,
                    "message_template_language": "en",
                    "previous_category": "UTILITY",
                    "new_category": "MARKETING",
                },
            )
        )
        row.refresh_from_db()
        self.assertEqual(row.category, "MARKETING")

    def test_an_approval_moves_the_type_it_was_made_for_onto_it(self):
        from . import whatsapp_templates

        approve_templates("approval_approved")
        WhatsAppTemplate.objects.create(
            name="hrms_approval_approved_v2", language="en", status="PENDING", message_type="approval_approved"
        )
        self.assertEqual(whatsapp_service.template_name_for("approval_approved"), "hrms_approval_approved")
        self.post(template_event("APPROVED", "hrms_approval_approved_v2"))
        self.assertEqual(whatsapp_service.template_name_for("approval_approved"), "hrms_approval_approved_v2")
        # a rejection leaves the type where it is
        WhatsAppTemplate.objects.create(
            name="hrms_approval_approved_v3", language="en", status="PENDING", message_type="approval_approved"
        )
        self.post(template_event("REJECTED", "hrms_approval_approved_v3", reason="INVALID_FORMAT"))
        self.assertEqual(whatsapp_service.template_name_for("approval_approved"), "hrms_approval_approved_v2")
        # HR points the type back to the first one: a later pause / reinstatement of v2 does not take it back
        s = WhatsAppSettings.get()
        whatsapp_templates._point_type_at("approval_approved", "hrms_approval_approved", s)
        self.post(template_event("PAUSED", "hrms_approval_approved_v2"))
        self.post(template_event("REINSTATED", "hrms_approval_approved_v2"))
        self.assertEqual(whatsapp_service.template_name_for("approval_approved"), "hrms_approval_approved")

    def test_quality_updates(self):
        WhatsAppTemplate.objects.create(name="hrms_late_alert", language="en", status="APPROVED", meta_id="111")
        self.post(
            envelope(
                "message_template_quality_update",
                {
                    "previous_quality_score": "GREEN",
                    "new_quality_score": "YELLOW",
                    "message_template_id": 111,
                    "message_template_name": "hrms_late_alert",
                    "message_template_language": "en",
                },
            )
        )
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_late_alert").quality_score, "YELLOW")

    def test_account_events_are_only_noted(self):
        with self.assertLogs("api.whatsapp_views", level="WARNING") as logs:
            r = self.post(envelope("phone_number_quality_update", {"event": "FLAGGED", "current_limit": "TIER_250"}))
        self.assertEqual(r.status_code, 200)
        self.assertIn("phone_number_quality_update FLAGGED", "\n".join(logs.output))


class AccountScopeTests(Base):
    """One Meta app can be subscribed to several WhatsApp Business Accounts (a test account next to the real one): only
    this server's account and number count."""

    def test_a_template_event_of_another_account_changes_nothing(self):
        approve_templates("otp_login")
        self.post(template_event("REJECTED", "hrms_otp", account="999999999999", message_template_id="777000777"))
        row = WhatsAppTemplate.objects.get(name="hrms_otp")
        self.assertEqual((row.status, row.meta_id, row.rejected_reason), ("APPROVED", "meta-hrms_otp", ""))
        self.assertEqual(otp_service.whatsapp_template_status("login"), "APPROVED")
        # ours, or one that does not say which account it is about, is applied
        self.post(template_event("PAUSED", "hrms_otp", account=None))
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_otp").status, "PAUSED")
        self.post(template_event("REINSTATED", "hrms_otp"))
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_otp").status, "APPROVED")

    def test_a_stop_sent_to_another_number_opts_nobody_out(self):
        def stop(phone_number_id):
            value = {
                "messaging_product": "whatsapp",
                "metadata": {"display_phone_number": "919800000001", "phone_number_id": phone_number_id},
                "messages": [{"from": "919876543210", "id": "wamid.IN9", "type": "text", "text": {"body": "STOP"}}],
            }
            return self.post(envelope("messages", value))

        self.assertEqual(stop("100099990000").status_code, 200)
        self.assertFalse(WhatsAppOptOut.objects.exists())
        stop("105550001111")
        self.assertTrue(WhatsAppOptOut.objects.filter(employee=self.emp).exists())

    @override_settings(WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID="")
    def test_a_server_without_the_account_id_takes_every_event(self):
        approve_templates("late_alert")
        self.post(template_event("PAUSED", "hrms_late_alert", account="999999999999"))
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_late_alert").status, "PAUSED")


class WebhookLoggingTests(Base):
    """The body holds employees' phone numbers and the text they send. None of it may reach the logs."""

    LOGGER = "api.whatsapp_views"
    PRIVATE = ("919876543210", "Please call me", "W H", "wamid", "105550001111", "919800000000")

    def test_an_inbound_message_and_statuses_are_described_without_their_data(self):
        body = envelope(
            "messages",
            {
                "metadata": {"display_phone_number": "919800000000", "phone_number_id": "105550001111"},
                "contacts": [{"profile": {"name": "W H"}, "wa_id": "919876543210"}],
                "messages": [
                    {"from": "919876543210", "id": "wamid.X", "type": "text", "text": {"body": "Please call me"}}
                ],
                "statuses": [{"id": "wamid.ABC", "status": "delivered", "recipient_id": "919876543210"}],
            },
        )
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertEqual(self.post(body).status_code, 200)
        text = "\n".join(captured.output)
        for expected in ("fields=messages", "messages=1", "statuses=1", "types=text", "statuses=delivered"):
            self.assertIn(expected, text)
        for private in self.PRIVATE:
            self.assertNotIn(private, text)

    def test_a_recognised_event_is_quiet_by_default(self):
        with self.assertNoLogs(self.LOGGER, level="WARNING"):
            self.post(statuses({"id": "wamid.ABC", "status": "read"}))

    def test_an_unrecognised_body_warns_with_key_names_only(self):
        body = {"customer_phone": "918000000001", "note": "salary is 50000", "nested": {"secret": "hunter2"}}
        with self.assertLogs(self.LOGGER, level="WARNING") as captured:
            self.post(body)
        text = "\n".join(captured.output)
        self.assertIn("unrecognised shape", text)
        self.assertIn("customer_phone", text)
        for private in ("918000000001", "salary is 50000", "hunter2"):
            self.assertNotIn(private, text)

    def test_a_refused_post_logs_no_body(self):
        with self.assertLogs(self.LOGGER, level="WARNING") as captured:
            self.post({"phone": "918000000001"}, signature="sha256=00")
        self.assertNotIn("918000000001", "\n".join(captured.output))
