"""The Meta WhatsApp Cloud API client (whatsapp_cloud.py): request shapes, variable cleaning, errors, the token never
leaking, the webhook signature and verify token, templates, the number and pricing. HTTP is mocked; nothing reaches Meta.

Run via: python manage.py test api.tests_whatsapp_cloud --noinput
"""

import hashlib
import hmac
import json
import logging
from datetime import date
from unittest import mock

import requests
from django.conf import settings
from django.test import SimpleTestCase, override_settings

from . import whatsapp_cloud as cloud
from .tests_whatsapp_support import (
    APP_SECRET,
    META,
    NO_META,
    PHONE_NUMBER_ID,
    TOKEN,
    WABA_ID,
    FakeMeta,
    Resp,
    meta_error,
)

BASE = f"https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}"


@override_settings(**META)
class SendShapeTests(SimpleTestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)

    def test_a_named_template_goes_to_the_number_with_named_body_parameters(self):
        wamid = cloud.send_template(
            "919876543210", "hrms_hod_request_waiting", "en", {"hod_name": "Suresh", "employee_name": "Asha Kumar"}
        )
        self.assertEqual(wamid, "wamid.TEST0001")
        call = self.meta.calls[0]
        self.assertEqual((call["method"], call["path"]), ("POST", f"{PHONE_NUMBER_ID}/messages"))
        self.assertEqual(call["headers"], {"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual(call["timeout"], cloud.SEND_TIMEOUT)
        self.assertEqual(
            call["json"],
            {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": "919876543210",
                "type": "template",
                "template": {
                    "name": "hrms_hod_request_waiting",
                    "language": {"code": "en"},
                    "components": [
                        {
                            "type": "body",
                            "parameters": [
                                {"type": "text", "parameter_name": "hod_name", "text": "Suresh"},
                                {"type": "text", "parameter_name": "employee_name", "text": "Asha Kumar"},
                            ],
                        }
                    ],
                },
            },
        )

    def test_the_url_uses_the_configured_version_and_never_carries_the_token(self):
        cloud.send_template("919876543210", "t", "en", {"a": "b"})
        with override_settings(WHATSAPP_CLOUD_API_VERSION="v24.0"):
            cloud.send_template("919876543210", "t", "en", {"a": "b"})
        self.assertEqual(
            [c["url"] for c in self.meta.calls],
            [f"{BASE}/messages", f"https://graph.facebook.com/v24.0/{PHONE_NUMBER_ID}/messages"],
        )
        self.assertTrue(all(TOKEN not in c["url"] and "params" not in c for c in self.meta.calls))

    def test_positional_parameters_when_every_key_is_a_number(self):
        cloud.send_template("919876543210", "t", "en", {"2": "second", "1": "first"})
        params = self.meta.last()["body"]["template"]["components"][0]["parameters"]
        self.assertEqual(params, [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}])

    def test_document_and_image_headers(self):
        document = {"type": "document", "id": "M1", "filename": "slip.pdf"}
        cloud.send_template("+91 98765-43210", "hrms_salary_slip", "en", {"employee_name": "A"}, document)
        cloud.send_template("919876543210", "hrms_id_card", "en", {"employee_name": "A"}, {"type": "image", "id": "M2"})
        doc, img = self.meta.sent
        self.assertEqual(doc["header"], {"type": "document", "document": {"id": "M1", "filename": "slip.pdf"}})
        self.assertEqual(img["header"], {"type": "image", "image": {"id": "M2"}})
        self.assertEqual(doc["body"]["template"]["components"][0]["type"], "header")
        self.assertEqual(doc["to"], "919876543210")  # digits only
        with self.assertRaises(ValueError):
            cloud.send_template("91", "t", "en", {}, {"type": "sticker", "id": "1"})

    def test_a_template_without_variables_has_no_components(self):
        cloud.send_template("919876543210", "hello_world", "en_US", {})
        self.assertNotIn("components", self.meta.last()["body"]["template"])

    def test_an_authentication_code_is_the_body_parameter_and_the_copy_button(self):
        cloud.send_auth_code("919876543210", "hrms_otp", "en", "482913")
        self.assertEqual(
            self.meta.last()["body"]["template"]["components"],
            [
                {"type": "body", "parameters": [{"type": "text", "text": "482913"}]},
                {"type": "button", "sub_type": "url", "index": "0", "parameters": [{"type": "text", "text": "482913"}]},
            ],
        )

    def test_media_upload_is_multipart_with_the_product_and_type(self):
        media_id = cloud.upload_media(b"%PDF-1", "application/pdf", "slip.pdf")
        self.assertEqual(media_id, "MEDIA0001")
        call = self.meta.calls[0]
        self.assertEqual(call["path"], f"{PHONE_NUMBER_ID}/media")
        self.assertEqual(call["data"], {"messaging_product": "whatsapp", "type": "application/pdf"})
        self.assertEqual(call["files"], {"file": ("slip.pdf", b"%PDF-1", "application/pdf")})
        self.assertEqual(call["timeout"], cloud.UPLOAD_TIMEOUT)

    def test_an_answer_without_a_message_id_is_an_error(self):
        self.meta.answer(Resp(200, {"messaging_product": "whatsapp"}))
        with self.assertRaises(cloud.MetaApiError) as caught:
            cloud.send_template("919876543210", "t", "en", {})
        self.assertIsNone(caught.exception.code)


class SanitizeTests(SimpleTestCase):
    def test_one_line_no_tabs_no_runs_of_spaces_never_empty(self):
        self.assertEqual(cloud.sanitize_param("Leave 2\nPermission\t1"), "Leave 2 Permission 1")
        self.assertEqual(cloud.sanitize_param("a     b"), "a b")
        self.assertEqual(cloud.sanitize_param("  "), "-")
        self.assertEqual(cloud.sanitize_param(None), "-")
        self.assertEqual(cloud.sanitize_param(42), "42")

    def test_long_values_are_cut(self):
        text = cloud.sanitize_param("x" * 1000)
        self.assertEqual(len(text), cloud.MAX_PARAM_LENGTH)
        self.assertTrue(text.endswith("…"))

    @override_settings(**META)
    def test_every_value_sent_is_cleaned(self):
        meta = FakeMeta.install(self)
        cloud.send_template("919876543210", "t", "en", {"pending_list": "Leave 2\n\nPermission 1", "note": ""})
        self.assertEqual(meta.last()["params"], {"pending_list": "Leave 2 Permission 1", "note": "-"})


@override_settings(**META)
class ErrorTests(SimpleTestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)

    def send(self):
        return cloud.send_template("919876543210", "t", "en", {"a": "b"})

    def caught(self) -> cloud.MetaApiError:
        with self.assertRaises(cloud.MetaApiError) as ctx:
            self.send()
        return ctx.exception

    def test_an_expired_token_is_final_and_account_level(self):
        self.meta.answer(meta_error(190, "Error validating access token: Session has expired", status=401))
        exc = self.caught()
        self.assertEqual((exc.code, exc.temporary, exc.http_status, exc.account_level), (190, False, 401, True))
        self.assertIn("access token is invalid or has expired", str(exc))
        self.assertTrue(str(exc).endswith("(code 190)"))
        self.assertIn("Session has expired", exc.message)

    def test_rate_limits_and_server_errors_are_temporary(self):
        for resp in (meta_error(130429, "Rate limit hit"), meta_error(131056, "pair rate"), Resp(503, None, "busy")):
            self.meta.answer(resp)
            self.assertTrue(self.caught().temporary)
        self.meta.answer(Resp(429, {"error": {"message": "slow"}}))
        self.assertTrue(self.caught().temporary)

    def test_a_message_level_refusal(self):
        self.meta.answer(meta_error(131026, "Message undeliverable", details="Recipient is not a WhatsApp user"))
        exc = self.caught()
        self.assertTrue(exc.message_level)
        self.assertFalse(exc.temporary or exc.account_level)
        self.assertEqual(exc.message, "Recipient is not a WhatsApp user")  # the most specific words Meta gave
        self.assertIn("not be on WhatsApp", exc.friendly)

    def test_network_problems_and_timeouts_are_temporary_without_a_code(self):
        self.meta.network_error()
        exc = self.caught()
        self.assertEqual((exc.code, exc.temporary), (None, True))
        self.assertIn("Could not reach Meta", str(exc))
        self.meta.network_error(exc=requests.Timeout("slow"))
        self.assertIn("timed out", str(self.caught()))

    def test_a_non_json_answer_never_crashes(self):
        self.meta.answer(Resp(502, None, "<html>Bad gateway</html>"))
        exc = self.caught()
        self.assertEqual((exc.http_status, exc.temporary), (502, True))
        self.assertIn("Bad gateway", exc.message)

    def test_unknown_codes_still_read_plainly(self):
        self.assertIn("error 999999", cloud.friendly_error(999999))
        self.assertEqual(cloud.friendly_error(None, "fallback"), "fallback")
        self.assertIn("template does not exist", cloud.friendly_error("132001"))


@override_settings(**META)
class TokenNeverLeaksTests(SimpleTestCase):
    def test_the_token_and_secret_are_scrubbed_from_errors_answers_and_logs(self):
        meta = FakeMeta.install(self)
        meta.answer(
            Resp(
                400,
                {
                    "error": {
                        "message": f"Invalid token {TOKEN}",
                        "code": 190,
                        "error_data": {"details": f"secret {APP_SECRET} here"},
                        "access_token": TOKEN,
                    }
                },
            )
        )
        with self.assertLogs("api.whatsapp_cloud", level="DEBUG") as logs:
            logging.getLogger("api.whatsapp_cloud").debug("start")
            with self.assertRaises(cloud.MetaApiError) as caught:
                cloud.send_template("919876543210", "t", "en", {})
        exc = caught.exception
        everything = " ".join([str(exc), exc.message, json.dumps(exc.response), "\n".join(logs.output), repr(exc.args)])
        self.assertNotIn(TOKEN, everything)
        self.assertNotIn(APP_SECRET, everything)
        self.assertEqual(exc.response["access_token"], "***")

    def test_a_network_error_never_carries_the_request(self):
        meta = FakeMeta.install(self)
        meta.network_error(exc=requests.ConnectionError(f"failed with headers Bearer {TOKEN}"))
        with self.assertRaises(cloud.MetaApiError) as caught:
            cloud.send_template("919876543210", "t", "en", {})
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)


class ConfigurationTests(SimpleTestCase):
    @override_settings(**NO_META)
    def test_not_configured_names_the_missing_variables_and_refuses_to_call(self):
        self.assertFalse(cloud.is_configured())
        self.assertEqual(
            cloud.missing_env(),
            [
                "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
                "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID",
                "WHATSAPP_CLOUD_ACCESS_TOKEN",
                "WHATSAPP_CLOUD_APP_SECRET",
                "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN",
            ],
        )
        with mock.patch("api.whatsapp_cloud.requests.post") as post, self.assertRaises(cloud.MetaApiError) as caught:
            cloud.send_template("919876543210", "t", "en", {})
        post.assert_not_called()
        self.assertIn("WHATSAPP_CLOUD_PHONE_NUMBER_ID", str(caught.exception))

    @override_settings(**META)
    def test_the_checklist_has_names_and_flags_never_values(self):
        rows = cloud.env_status()
        self.assertEqual([r["name"] for r in rows], [name for name, _secret, _required in cloud.ENV_VARS])
        self.assertEqual(cloud.missing_env(), [])
        self.assertTrue(all(r["set"] for r in rows if r["required"]))
        self.assertEqual(
            {r["name"] for r in rows if r["secret"]},
            {"WHATSAPP_CLOUD_ACCESS_TOKEN", "WHATSAPP_CLOUD_APP_SECRET", "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN"},
        )
        self.assertEqual(set(rows[0]), {"name", "set", "secret", "required"})
        self.assertNotIn(TOKEN, json.dumps(rows))
        self.assertNotIn(PHONE_NUMBER_ID, json.dumps(rows))

    @override_settings(**{**META, "WHATSAPP_CLOUD_API_BASE": "http://graph.example.com"})
    def test_plain_http_is_refused_unless_local(self):
        with mock.patch("api.whatsapp_cloud.requests.post") as post, self.assertRaises(cloud.MetaApiError) as caught:
            cloud.send_template("919876543210", "t", "en", {})
        post.assert_not_called()
        self.assertIn("https", str(caught.exception))
        with override_settings(WHATSAPP_CLOUD_API_BASE="http://127.0.0.1:8190/"):
            self.assertTrue(cloud.base_is_local())
            with mock.patch(
                "api.whatsapp_cloud.requests.post", return_value=Resp(200, {"messages": [{"id": "w1"}]})
            ) as p:
                self.assertEqual(cloud.send_template("919876543210", "t", "en", {}), "w1")
            self.assertEqual(p.call_args.args[0], f"http://127.0.0.1:8190/v23.0/{PHONE_NUMBER_ID}/messages")

    def test_tests_never_load_a_live_token(self):
        self.assertEqual(settings.WHATSAPP_CLOUD_ACCESS_TOKEN, "")
        self.assertEqual(settings.WHATSAPP_CLOUD_APP_SECRET, "")
        self.assertEqual(settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN, "")
        self.assertFalse(hasattr(settings, "WHATSAPP_WEBHOOK_TOKEN"))


@override_settings(**META)
class TemplateApiTests(SimpleTestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)

    def test_list_follows_the_paging_cursor_on_the_configured_host(self):
        page1 = Resp(
            200,
            {
                "data": [{"name": "a", "status": "APPROVED"}],
                "paging": {"cursors": {"after": "CUR1"}, "next": "https://evil.example/steal"},
            },
        )
        page2 = Resp(200, {"data": [{"name": "b", "status": "PENDING"}], "paging": {"cursors": {"after": "CUR2"}}})
        self.meta.answer(page1)
        self.meta.answer(page2)
        found = cloud.list_templates()
        self.assertEqual([t["name"] for t in found], ["a", "b"])
        first, second = self.meta.calls
        self.assertEqual(first["path"], f"{WABA_ID}/message_templates")
        self.assertEqual(first["params"]["fields"], cloud.TEMPLATE_FIELDS)
        self.assertEqual(first["params"]["limit"], 100)
        self.assertEqual(second["params"]["after"], "CUR1")
        self.assertTrue(all("evil" not in c["path"] for c in self.meta.calls))

    def test_create_and_delete(self):
        answer = cloud.create_template({"name": "hrms_x", "language": "en", "category": "UTILITY", "components": []})
        self.assertEqual(answer["status"], "PENDING")
        self.assertEqual(self.meta.created[0]["name"], "hrms_x")
        cloud.delete_template("hrms_x", meta_id="123")
        cloud.delete_template("hrms_y")
        self.assertEqual(self.meta.deleted, [{"name": "hrms_x", "hsm_id": "123"}, {"name": "hrms_y"}])
        self.assertEqual(self.meta.calls[1]["method"], "DELETE")

    def test_a_create_refusal_carries_metas_readable_words(self):
        self.meta.answer(
            Resp(
                400,
                {
                    "error": {
                        "message": "Invalid parameter",
                        "code": 100,
                        "error_user_msg": "Variables can't be at the start or end of the template.",
                    }
                },
            )
        )
        with self.assertRaises(cloud.MetaApiError) as caught:
            cloud.create_template({"name": "bad"})
        self.assertEqual(caught.exception.message, "Variables can't be at the start or end of the template.")


@override_settings(**META)
class PhoneAndPricingTests(SimpleTestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)

    def test_phone_number_info(self):
        info = cloud.phone_number_info()
        self.assertEqual((info["quality_rating"], info["messaging_limit_tier"]), ("GREEN", "TIER_1K"))
        self.assertNotIn("id", info)
        self.assertEqual(self.meta.calls[0]["params"], {"fields": cloud.PHONE_FIELDS})

    def test_a_field_meta_does_not_know_falls_back_to_the_basic_ones(self):
        self.meta.answer(meta_error(100, "(#100) Tried accessing nonexisting field (messaging_limit_tier)"))
        info = cloud.phone_number_info()
        self.assertEqual(info["verified_name"], "UK Textiles")
        self.assertEqual(self.meta.calls[1]["params"], {"fields": cloud.PHONE_FIELDS_BASIC})
        self.meta.answer(meta_error(190, "expired", status=401))
        with self.assertRaises(cloud.MetaApiError):
            cloud.phone_number_info()

    def test_pricing_analytics_query_and_parsing(self):
        self.meta.pricing = [
            {
                "start": 1795113000,
                "end": 1795199400,
                "volume": 12,
                "cost": 1.38,
                "pricing_category": "UTILITY",
                "pricing_type": "REGULAR",
            },
            {
                "start": 1795113000,
                "end": 1795199400,
                "volume": "3",
                "cost": None,
                "pricing_category": "AUTHENTICATION",
                "pricing_type": "REGULAR",
            },
        ]
        points = cloud.pricing_analytics(date(2026, 11, 20), date(2026, 11, 1))  # given backwards: swapped
        call = self.meta.calls[0]
        self.assertEqual(call["path"], WABA_ID)
        fields = call["params"]["fields"]
        start = int(fields.split("start(")[1].split(")")[0])
        end = int(fields.split("end(")[1].split(")")[0])
        self.assertEqual(end - start, 20 * 86400)  # 1 Nov 00:00 IST .. 21 Nov 00:00 IST
        self.assertIn('dimensions(["PRICING_CATEGORY","PRICING_TYPE"])', fields)
        self.assertIn("granularity(DAILY)", fields)
        self.assertEqual(
            [(p["pricing_category"], p["volume"], p["cost"], p["date"]) for p in points],
            [("utility", 12, 1.38, "2026-11-20"), ("authentication", 3, 0.0, "2026-11-20")],
        )


@override_settings(**META)
class WebhookSecurityTests(SimpleTestCase):
    def sign(self, body: bytes, secret: str = APP_SECRET) -> str:
        return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    def test_the_signature_is_checked_over_the_raw_body(self):
        body = b'{"object":"whatsapp_business_account"}'
        self.assertTrue(cloud.verify_signature(body, self.sign(body)))
        self.assertTrue(cloud.verify_signature(body, self.sign(body).upper().replace("SHA256=", "sha256=")))
        self.assertFalse(cloud.verify_signature(body + b" ", self.sign(body)))
        self.assertFalse(cloud.verify_signature(body, self.sign(body, "another-secret")))
        for bad in (None, "", "sha256=", "sha1=abc", self.sign(body)[7:], "sha256=zz" + "0" * 62):
            self.assertFalse(cloud.verify_signature(body, bad), bad)

    def test_no_app_secret_means_no_signature_is_valid(self):
        body = b"{}"
        with override_settings(WHATSAPP_CLOUD_APP_SECRET=""):
            self.assertFalse(cloud.verify_signature(body, self.sign(body)))
            self.assertFalse(cloud.verify_signature(body, "sha256=" + hmac.new(b"", body, hashlib.sha256).hexdigest()))

    def test_the_comparison_is_constant_time(self):
        body = b"{}"
        with mock.patch("api.whatsapp_cloud.hmac.compare_digest", wraps=hmac.compare_digest) as compare:
            cloud.verify_signature(body, self.sign(body))
            cloud.verify_token_matches("test-verify-token")
        self.assertEqual(compare.call_count, 2)

    def test_the_verify_token(self):
        self.assertTrue(cloud.verify_token_matches("test-verify-token"))
        for bad in ("wrong", "", None, 5):
            self.assertFalse(cloud.verify_token_matches(bad))
        with override_settings(WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=""):
            self.assertFalse(cloud.verify_token_matches(""))
