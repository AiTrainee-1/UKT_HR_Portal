"""
WhatsApp (Meta Cloud API): the development-machine recipient lock, the test message and the connection check.

A development machine allowed to send (WHATSAPP_ALLOW_SENDING=true) sends ONLY to the employees named in
WHATSAPP_ONLY_TO_EMPLOYEES, checked where every message reaches Meta (whatsapp_service._guard) and before the queue sends a
row (whatsapp_dispatcher); with none named it sends nothing. A real server is unchanged. A local fake Graph API (the e2e
stack) needs no list.

Run via: python manage.py test api.tests_whatsapp_test_send --noinput
"""

import json
from unittest import mock

from django.core.cache import cache
from django.test import TestCase, override_settings

from . import whatsapp_dispatcher, whatsapp_service
from .jwt_utils import sign_token
from .models import Employee, HRUser, WhatsAppMessageLog, WhatsAppSettings
from .tests_whatsapp_support import APP_SECRET, META, NO_META, PHONE_NUMBER_ID, TOKEN, VERIFY_TOKEN, WABA_ID
from .tests_whatsapp_support import FakeMeta, make_template

DEV = "api.whatsapp_service.local_dev_server"  # True = this is `manage.py runserver` on a laptop
LATE_BODY = "Dear {{employee_name}}, you were late on {{date}} by {{late_by}}."


class World(TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.meta = FakeMeta.install(self)
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
        self.late = make_template(whatsapp_service.template_name_for("late_alert"), LATE_BODY)

    def send(self, to: str):
        return whatsapp_service.deliver_template(
            to, "late_alert", {"employee_name": "X", "date": "1 Nov", "late_by": "5m"}
        )


@override_settings(**META, WHATSAPP_ONLY_TO_EMPLOYEES=[])
class NobodyNamedTests(World):
    def test_a_development_machine_with_no_list_sends_nothing(self):
        self.assertIn("WHATSAPP_ONLY_TO_EMPLOYEES", whatsapp_service.sending_block_reason())
        with self.assertRaises(whatsapp_service.WhatsAppServiceError):
            self.send("919876543210")
        self.assertEqual(self.meta.calls, [])

    @override_settings(WHATSAPP_CLOUD_API_BASE="http://127.0.0.1:8190")
    def test_a_local_fake_provider_needs_no_list(self):
        self.assertTrue(whatsapp_service.provider_is_local())
        self.assertIsNone(whatsapp_service.sending_block_reason())
        self.assertIsNone(whatsapp_service.recipient_block_reason("919123456780"))

    def test_a_real_server_is_unchanged(self):
        with mock.patch(DEV, return_value=False):
            self.assertIsNone(whatsapp_service.sending_block_reason())
            self.assertIsNone(whatsapp_service.recipient_block_reason("919123456780"))

    @override_settings(WHATSAPP_ONLY_TO_EMPLOYEES=["T1"])
    def test_production_ignores_the_list_even_when_it_is_set_by_mistake(self):
        with mock.patch(DEV, return_value=False):
            self.assertEqual(whatsapp_service.recipient_codes(), [])
            self.assertIsNone(whatsapp_service.allowed_numbers())
            self.send("919123456780")  # T2's number: sent
            self.assertEqual(len(self.meta.sent), 1)
            body = self.client.get("/api/whatsapp-control/test-message", **self.h).json()
            self.assertIsNone(body["limitedTo"])


@override_settings(**META, WHATSAPP_ONLY_TO_EMPLOYEES=["30020", "T1"], DEBUG=True)
class ProductionIsNeverLimitedTests(TestCase):
    """Production (gunicorn / Railway): the lock never applies, even with the variable set and DEBUG on (2026-11-18: the
    variable reached production through Railway and every HoD reminder was skipped)."""

    def setUp(self):
        super().setUp()
        self.meta = FakeMeta.install(self)
        Employee.objects.create(employee_code="T1", first_name="S", last_name="M", status="active", phone="9876543210")
        make_template(whatsapp_service.template_name_for("late_alert"), LATE_BODY)

    def test_not_runserver_means_no_limit_whatever_the_settings(self):
        self.assertFalse(whatsapp_service.local_dev_server())  # the test runner, like gunicorn, is not runserver
        self.assertEqual(whatsapp_service.recipient_codes(), [])
        self.assertIsNone(whatsapp_service.allowed_numbers())
        self.assertIsNone(whatsapp_service.recipient_block_reason("918667516410"))
        whatsapp_service.deliver_template("918667516410", "late_alert", {"employee_name": "A Department Head"})
        self.assertEqual(self.meta.last()["to"], "918667516410")

    def test_railway_is_never_the_local_server_even_under_runserver(self):
        with (
            mock.patch("api.whatsapp_service.sys.argv", ["manage.py", "runserver"]),
            mock.patch.dict("os.environ", {"RAILWAY_ENVIRONMENT": "production"}),
        ):
            self.assertFalse(whatsapp_service.local_dev_server())
            self.assertIsNone(whatsapp_service.recipient_block_reason("918667516410"))
        with mock.patch("api.whatsapp_service.sys.argv", ["manage.py", "runserver"]):
            self.assertTrue(whatsapp_service.local_dev_server())  # a laptop: the lock applies there


@override_settings(**META, WHATSAPP_ONLY_TO_EMPLOYEES=["T1"])
class OnlyTheNamedEmployeeTests(World):
    def test_only_the_named_employees_number_reaches_meta(self):
        self.assertIsNone(whatsapp_service.sending_block_reason())
        self.send("919876543210")
        self.assertEqual(len(self.meta.sent), 1)
        for to in ("919123456780", "120363000000000000@g.us"):
            with self.assertRaises(whatsapp_service.WhatsAppServiceError) as caught:
                self.send(to)
            self.assertFalse(str(caught.exception).startswith(("Send failed", "Could not reach", "Temporary")))
        self.assertEqual(len(self.meta.sent), 1)  # nobody else was ever sent to
        with self.assertRaises(whatsapp_service.WhatsAppServiceError) as caught:
            whatsapp_service.deliver_code("919123456780", "otp_login", "123456")
        self.assertTrue(str(caught.exception).startswith(whatsapp_service.DEV_SAFETY))

    def test_nothing_is_uploaded_for_a_refused_recipient(self):
        make_template(whatsapp_service.template_name_for("salary_slip"), "Dear {{employee_name}}.", header="document")
        with self.assertRaises(whatsapp_service.WhatsAppServiceError):
            whatsapp_service.deliver_template(
                "919123456780", "salary_slip", {"employee_name": "R"}, media=(b"%PDF", "s.pdf", "application/pdf")
            )
        self.assertEqual(self.meta.uploads, [])

    def test_the_queue_skips_anybody_else_without_pausing(self):
        rows = [
            WhatsAppMessageLog.objects.create(
                employee=self.other,
                document_type="late_alert",
                phone_number="919123456780",
                status="queued",
                kind="automatic",
                payload={"params": {}},
            )
            for _ in range(3)
        ]
        s = whatsapp_dispatcher._settings()
        for row in rows:
            reason = whatsapp_dispatcher._skip_reason(row, s, row.created_at, limits=False)
            self.assertTrue(reason.startswith(whatsapp_service.DEV_SAFETY))
            whatsapp_dispatcher._finish(row, WhatsAppMessageLog.STATUS_SKIPPED, reason)
        self.assertFalse(whatsapp_dispatcher.pause_state()[0])  # a refusal here is not a provider failure

    def test_the_test_message_page_offers_only_the_named_employee_and_each_types_template(self):
        body = self.client.get("/api/whatsapp-control/test-message", **self.h).json()
        self.assertEqual([r["code"] for r in body["recipients"]], ["T1"])
        self.assertEqual(body["limitedTo"], ["T1"])
        late = next(t for t in body["types"] if t["documentType"] == "late_alert")
        self.assertEqual(
            (late["template"]["name"], late["template"]["status"], late["template"]["approved"]),
            (self.late.name, "APPROVED", True),
        )
        absent = next(t for t in body["types"] if t["documentType"] == "absent_alert")
        self.assertEqual((absent["template"]["status"], absent["template"]["approved"]), ("MISSING", False))

    def post(self, **body):
        return self.client.post("/api/whatsapp-control/test-message", body, content_type="application/json", **self.h)

    def test_preview_then_send_and_metas_answer(self):
        res = self.post(
            documentType="late_alert", employeeId=self.me.pk, dryRun=True, params={"late_by": "7 min"}
        ).json()
        self.assertEqual((res["status"], res["to"], res["blockReason"]), ("preview", "••••3210", None))
        self.assertEqual(res["template"]["name"], self.late.name)
        self.assertEqual(res["params"]["employee_name"], "Surya M")
        self.assertEqual(res["params"]["late_by"], "7 min")
        self.assertIn("Dear Surya M, you were late", res["text"])
        self.assertEqual(self.meta.calls, [])
        res = self.post(documentType="late_alert", employeeId=self.me.pk, params={"late_by": "7 min"}).json()
        self.assertEqual((res["status"], res["providerMessageId"]), ("sent", "wamid.TEST0001"))
        sent = self.meta.last()
        self.assertEqual((sent["to"], sent["template"]), ("919876543210", self.late.name))
        self.assertEqual(sent["params"]["late_by"], "7 min")
        log = WhatsAppMessageLog.objects.get(pk=res["logId"])
        self.assertEqual(
            (log.status, log.provider_message_id, log.payload, log.template_name),
            ("sent", "wamid.TEST0001", {"test": True}, self.late.name),
        )

    def test_free_text_is_refused(self):
        r = self.post(documentType="late_alert", employeeId=self.me.pk, text="Hello from the HRMS")
        self.assertEqual(r.status_code, 400)
        self.assertIn("approved templates only", r.json()["error"])

    def test_a_refusal_shows_metas_code_and_words_without_the_token(self):
        self.meta.fail(132001, f"(#132001) Template name does not exist in the translation {TOKEN}")
        res = self.post(documentType="late_alert", employeeId=self.me.pk).json()
        self.assertEqual((res["status"], res["code"], res["httpStatus"]), ("failed", 132001, 400))
        self.assertTrue(res["error"].endswith("(code 132001)"))
        self.assertIn("Template name does not exist", res["metaMessage"])
        self.assertNotIn(TOKEN, json.dumps(res))
        self.assertEqual(WhatsAppMessageLog.objects.get(pk=res["logId"]).status, "failed")

    def test_a_template_that_is_not_approved_blocks_the_test(self):
        make_template(self.late.name, LATE_BODY, status="PENDING")
        res = self.post(documentType="late_alert", employeeId=self.me.pk).json()
        self.assertEqual(res["status"], "blocked")
        self.assertIn("PENDING", res["error"])
        self.assertEqual(self.meta.calls, [])

    def test_a_document_template_is_tried_with_a_sample_file(self):
        slip = make_template(
            whatsapp_service.template_name_for("salary_slip"),
            "Dear {{employee_name}}, your slip for {{month_year}}.",
            header="document",
        )
        res = self.post(documentType="salary_slip", employeeId=self.me.pk).json()
        self.assertEqual(res["status"], "sent")
        upload = self.meta.uploads[0]
        self.assertEqual((upload["mime"], upload["filename"]), ("application/pdf", "UK-Textiles-HRMS-test.pdf"))
        self.assertGreater(upload["size"], 200)
        self.assertEqual(self.meta.last()["template"], slip.name)
        self.assertEqual(self.meta.last()["header"]["type"], "document")

    def test_a_code_type_sends_a_random_test_code(self):
        make_template(whatsapp_service.template_name_for("otp_login"), category="AUTHENTICATION")
        res = self.post(documentType="otp_login", employeeId=self.me.pk).json()
        self.assertEqual(res["status"], "sent")
        self.assertRegex(res["testCode"], r"^\d{6}$")
        self.assertEqual(self.meta.last()["button"], res["testCode"])
        log = WhatsAppMessageLog.objects.get(pk=res["logId"])
        self.assertNotIn(res["testCode"], log.message_text)

    def test_another_employee_is_blocked_and_nothing_is_sent(self):
        res = self.post(documentType="late_alert", employeeId=self.other.pk).json()
        self.assertEqual(res["status"], "blocked")
        self.assertTrue(res["error"].startswith(whatsapp_service.DEV_SAFETY))
        self.assertEqual(self.meta.calls, [])
        self.assertFalse(WhatsAppMessageLog.objects.exists())

    def test_bad_requests(self):
        self.assertEqual(self.post(documentType="nope", employeeId=self.me.pk).status_code, 400)
        self.assertEqual(self.post(documentType="late_alert", employeeId=99999).status_code, 404)
        self.assertEqual(self.post(documentType="late_alert", employeeId=self.me.pk, params="x").status_code, 400)
        self.assertEqual(
            self.post(documentType="late_alert", employeeId=self.me.pk, params={"late_by": "x" * 301}).status_code, 400
        )


@override_settings(**META, WHATSAPP_ONLY_TO_EMPLOYEES=["T1"], BACKEND_PUBLIC_URL="https://api.example.test")
class ConnectionTests(World):
    def get(self):
        return self.client.get("/api/whatsapp-control/connection", **self.h).json()

    def test_the_checklist_names_every_variable_and_never_a_value(self):
        body = self.get()
        self.assertEqual(
            [(e["name"], e["set"]) for e in body["env"] if e["required"]],
            [
                ("WHATSAPP_CLOUD_PHONE_NUMBER_ID", True),
                ("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", True),
                ("WHATSAPP_CLOUD_ACCESS_TOKEN", True),
                ("WHATSAPP_CLOUD_APP_SECRET", True),
                ("WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", True),
            ],
        )
        text = json.dumps(body)
        for secret in (TOKEN, APP_SECRET, VERIFY_TOKEN, PHONE_NUMBER_ID, WABA_ID):
            self.assertNotIn(secret, text)
        self.assertEqual((body["configured"], body["sendingAllowed"], body["tokenOk"]), (True, True, True))
        self.assertEqual(body["phone"]["qualityRating"], "GREEN")
        self.assertEqual(body["phone"]["messagingLimitTier"], "TIER_1K")
        self.assertEqual(body["apiVersion"], "v23.0")
        self.assertEqual(
            body["webhook"],
            {
                "url": "https://api.example.test/api/whatsapp/webhook/",
                "verifyTokenSet": True,
                "appSecretSet": True,
                "lastWebhookAt": None,
            },
        )
        self.assertEqual(body["devLock"], {"onlyToEmployees": ["T1"]})
        self.assertEqual(body["blockReasons"], [])
        self.assertTrue(any("never reached this server" in w for w in body["warnings"]))
        self.assertEqual(body["templates"], {"approved": 1, "total": 1})

    def test_a_refused_token_and_the_master_switch(self):
        self.meta.fail(190, "Session has expired", status=401)
        WhatsAppSettings.get()
        WhatsAppSettings.objects.filter(pk=1).update(engine_enabled=False)
        body = self.get()
        self.assertFalse(body["ok"])
        self.assertIs(body["tokenOk"], False)
        self.assertIsNone(body["phone"])
        self.assertEqual(body["errorCode"], 190)
        self.assertTrue(any("refused the access token" in r for r in body["blockReasons"]))
        self.assertTrue(any("master switch is OFF" in r for r in body["blockReasons"]))

    @override_settings(**NO_META)
    def test_not_configured(self):
        body = self.get()
        self.assertFalse(body["configured"])
        self.assertIsNone(body["phone"])
        self.assertIn("WHATSAPP_CLOUD_ACCESS_TOKEN", body["blockReasons"][0])
        self.assertEqual(self.meta.calls, [])
        self.assertEqual(body["webhook"]["verifyTokenSet"], False)

    def test_hr_only(self):
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.me.id})}"}
        self.assertEqual(self.client.get("/api/whatsapp-control/connection", **emp).status_code, 403)
        self.assertEqual(self.client.get("/api/whatsapp-control/connection").status_code, 401)
