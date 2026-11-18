"""
WhatsApp: the development-machine recipient lock, the test message and the connection check (owner 2026-11-17).

A development machine allowed to send (WHATSAPP_ALLOW_SENDING=true) sends ONLY to the employees named in
WHATSAPP_ONLY_TO_EMPLOYEES, checked where every message reaches WAClient (whatsapp_service._post_send) and before the queue
sends a row (whatsapp_dispatcher); with none named it sends nothing. A real server is unchanged. A local fake WAClient (the
e2e stack) needs no list.

Run via: python manage.py test api.tests_whatsapp_test_send --keepdb
"""

from unittest import mock

from django.test import TestCase, override_settings

from . import whatsapp_dispatcher, whatsapp_service
from .jwt_utils import sign_token
from .models import Employee, HRUser, WhatsAppMessageLog

LIVE = dict(
    WACLIENT_INSTANCE_ID="INST0000C042",
    WACLIENT_ACCESS_TOKEN="secret-token",
    WACLIENT_API_URL="https://api.waclient.com/send",
    WHATSAPP_ALLOW_SENDING=True,
)
POST = "api.whatsapp_service.requests.post"
GET = "api.whatsapp_service.requests.get"
DEV = "api.whatsapp_service.development_machine"


def ok_answer(msg_id="WAID1"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message": "Success", "message_payload": {"key": {"id": msg_id}}}
    return r


class World(TestCase):
    def setUp(self):
        super().setUp()
        self.me = Employee.objects.create(
            employee_code="T1", first_name="Surya", last_name="M", status="active", phone="9876543210"
        )
        self.other = Employee.objects.create(
            employee_code="T2", first_name="Ravi", last_name="K", status="active", phone="9123456780"
        )
        self.admin = HRUser.objects.create(username="wa_admin", password_hash="x", is_super_admin=True)
        self.h = {
            "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.admin.id, 'name': 'wa_admin'})}"
        }
        p = mock.patch(DEV, return_value=True)
        p.start()
        self.addCleanup(p.stop)


@override_settings(**LIVE, WHATSAPP_ONLY_TO_EMPLOYEES=[])
class NobodyNamedTests(World):
    def test_a_development_machine_with_no_list_sends_nothing(self):
        self.assertIn("WHATSAPP_ONLY_TO_EMPLOYEES", whatsapp_service.sending_block_reason())
        with mock.patch(POST) as post, self.assertRaises(whatsapp_service.WhatsAppServiceError):
            whatsapp_service.send_text_message("919876543210", "hi")
        post.assert_not_called()

    @override_settings(WACLIENT_API_URL="http://127.0.0.1:8190/send")
    def test_a_local_fake_provider_needs_no_list(self):
        self.assertIsNone(whatsapp_service.sending_block_reason())
        self.assertIsNone(whatsapp_service.recipient_block_reason("919123456780"))

    def test_a_real_server_is_unchanged(self):
        with mock.patch(DEV, return_value=False):
            self.assertIsNone(whatsapp_service.sending_block_reason())
            self.assertIsNone(whatsapp_service.recipient_block_reason("919123456780"))

    @override_settings(WHATSAPP_ONLY_TO_EMPLOYEES=["T1"])
    def test_production_ignores_the_list_even_when_it_is_set_by_mistake(self):
        with mock.patch(DEV, return_value=False), mock.patch(POST, return_value=ok_answer()) as post:
            self.assertEqual(whatsapp_service.recipient_codes(), [])
            self.assertIsNone(whatsapp_service.allowed_numbers())
            whatsapp_service.send_text_message("919123456780", "to anyone eligible")  # T2's number: sent
            post.assert_called_once()
            body = self.client.get("/api/whatsapp-control/test-message", **self.h).json()
            self.assertIsNone(body["limitedTo"])


@override_settings(**LIVE, WHATSAPP_ONLY_TO_EMPLOYEES=["T1"])
class OnlyTheNamedEmployeeTests(World):
    def test_only_the_named_employees_number_reaches_waclient(self):
        self.assertIsNone(whatsapp_service.sending_block_reason())
        with mock.patch(POST, return_value=ok_answer()) as post:
            whatsapp_service.send_text_message("919876543210", "hi me")
            self.assertEqual(post.call_count, 1)
            for to in ("919123456780", "120363000000000000@g.us"):
                with self.assertRaises(whatsapp_service.WhatsAppServiceError) as caught:
                    whatsapp_service.send_text_message(to, "hi other")
                self.assertTrue(str(caught.exception).startswith(whatsapp_service.DEV_SAFETY))
            self.assertEqual(post.call_count, 1)  # nobody else was ever sent to

    def test_the_queue_skips_anybody_else_without_pausing(self):
        rows = [
            WhatsAppMessageLog.objects.create(
                employee=e, document_type="late_alert", phone_number=phone, status="queued", kind="automatic"
            )
            for e, phone in ((self.other, "919123456780"), (self.other, "919123456780"), (self.other, "919123456780"))
        ]
        s = whatsapp_dispatcher._settings()
        for row in rows:
            reason = whatsapp_dispatcher._skip_reason(row, s, row.created_at, limits=False)
            self.assertTrue(reason.startswith(whatsapp_service.DEV_SAFETY))
            whatsapp_dispatcher._finish(row, WhatsAppMessageLog.STATUS_SKIPPED, reason)
        self.assertFalse(whatsapp_dispatcher.pause_state()[0])  # a refusal here is not a provider failure

    def test_the_test_message_page_offers_only_the_named_employee(self):
        body = self.client.get("/api/whatsapp-control/test-message", **self.h).json()
        self.assertEqual([r["code"] for r in body["recipients"]], ["T1"])
        self.assertEqual(body["limitedTo"], ["T1"])
        self.assertTrue(any(t["documentType"] == "late_alert" for t in body["types"]))
        self.assertFalse(any(t["documentType"] == "visitor_contact" for t in body["types"]))

    def post(self, **body):
        return self.client.post("/api/whatsapp-control/test-message", body, content_type="application/json", **self.h)

    def test_preview_then_send_and_the_real_answer(self):
        res = self.post(documentType="late_alert", employeeId=self.me.pk, dryRun=True).json()
        self.assertEqual((res["status"], res["to"], res["blockReason"]), ("preview", "••••3210", None))
        self.assertIn("Surya M", res["text"])
        with mock.patch(POST, return_value=ok_answer("WA-77")) as post:
            res = self.post(documentType="late_alert", employeeId=self.me.pk, text="Test from the HRMS").json()
        self.assertEqual((res["status"], res["providerMessageId"]), ("sent", "WA-77"))
        sent = post.call_args.kwargs["json"]
        self.assertEqual(
            (sent["number"], sent["message"], sent["type"]), ("919876543210", "Test from the HRMS", "text")
        )
        log = WhatsAppMessageLog.objects.get(pk=res["logId"])
        self.assertEqual((log.status, log.provider_message_id, log.payload), ("sent", "WA-77", {"test": True}))

    def test_a_refusal_shows_waclients_own_error_without_the_credentials(self):
        bad = mock.Mock(status_code=401, content=b"x", text="")
        bad.json.return_value = {"status": "error", "message": "Invalid access token", "access_token": "secret-token"}
        with mock.patch(POST, return_value=bad):
            res = self.post(documentType="late_alert", employeeId=self.me.pk).json()
        self.assertEqual((res["status"], res["httpStatus"]), ("failed", 401))
        self.assertEqual(res["error"], "Send failed: Invalid access token")
        self.assertNotIn("secret-token", str(res))
        self.assertEqual(WhatsAppMessageLog.objects.get(pk=res["logId"]).status, "failed")

    def test_another_employee_is_blocked_and_nothing_is_sent(self):
        with mock.patch(POST) as post:
            res = self.post(documentType="late_alert", employeeId=self.other.pk).json()
        self.assertEqual(res["status"], "blocked")
        self.assertTrue(res["error"].startswith(whatsapp_service.DEV_SAFETY))
        post.assert_not_called()
        self.assertFalse(WhatsAppMessageLog.objects.exists())

    def test_bad_requests(self):
        self.assertEqual(self.post(documentType="nope", employeeId=self.me.pk).status_code, 400)
        self.assertEqual(self.post(documentType="late_alert", employeeId=99999).status_code, 404)
        self.assertEqual(self.post(documentType="late_alert", employeeId=self.me.pk, text="  ").status_code, 400)

    def test_the_connection_check(self):
        status = mock.Mock(status_code=200, content=b"x", text="")
        status.json.return_value = {
            "status": "success",
            "data": {"instance_id": "INST0000C042", "connection_state": "connected", "socket_loaded": True},
        }
        with mock.patch(GET, return_value=status):
            body = self.client.get("/api/whatsapp-control/connection", **self.h).json()
        self.assertEqual((body["provider"]["state"], body["instance"]), ("connected", "…C042"))
        self.assertEqual(body["machine"]["limitedTo"], ["T1"])
        self.assertNotIn("INST0000C042", str(body))
        self.assertNotIn("secret-token", str(body))
        status.json.return_value = {"status": "success", "data": {"connection_state": "logged_out"}}
        with mock.patch(GET, return_value=status):
            body = self.client.get("/api/whatsapp-control/connection", **self.h).json()
        self.assertFalse(body["ok"])
        self.assertIn("logged_out", body["problems"][0])
