"""WAClient sending service: wording, phone handling, request shape, failure paths, settings endpoints."""

from unittest import mock

from django.test import RequestFactory, TestCase, override_settings

from . import whatsapp_service as svc
from .jwt_utils import sign_token
from .models import Employee, HRUser, WhatsAppMediaAsset, WhatsAppMessageLog, WhatsAppMessageTemplate

CONFIG = dict(WACLIENT_INSTANCE_ID="INST1234", WACLIENT_ACCESS_TOKEN="tok-secret", WHATSAPP_DEFAULT_COUNTRY_CODE="91")


def _ok(msg_id="WAID1"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message": "Success", "message_payload": {"key": {"id": msg_id}}}
    return r


def _resp(status_code, body):
    r = mock.Mock(status_code=status_code, content=b"x", text=str(body))
    r.json.return_value = body
    return r


class PhoneAndWordingTests(TestCase):
    @override_settings(**CONFIG)
    def test_phone_normalisation(self):
        for raw in ("+918220015110", "918220015110", "8220015110", "82200 15110", "+91-82200-15110"):
            self.assertEqual(svc.normalize_phone(raw), "918220015110", raw)
        self.assertIsNone(svc.normalize_phone(""))
        self.assertIsNone(svc.normalize_phone(None))
        self.assertIsNone(svc.normalize_phone("n/a"))

    def test_placeholders_fill_in_order_and_missing_ones_render_empty(self):
        self.assertEqual(svc.render_message("Hi {{1}}, {{2}}!", ["Asha", "welcome"]), "Hi Asha, welcome!")
        self.assertEqual(svc.render_message("Hi {{ 1 }}{{3}}.", ["Asha"]), "Hi Asha.")

    def test_every_document_type_has_default_wording_and_help(self):
        for doc_type, _ in WhatsAppMessageLog.DOCUMENT_TYPES:
            self.assertTrue(svc.DEFAULT_MESSAGES[doc_type], doc_type)
            self.assertTrue(svc.PLACEHOLDER_HELP[doc_type], doc_type)

    def test_custom_wording_wins_and_disabled_types_are_refused(self):
        self.assertEqual(
            svc._message_for("id_card", ["Asha"])[0],
            "Hello Asha,\n\nYour employee ID card is attached.\n\nRegards,\nUK Textiles HR",
        )
        WhatsAppMessageTemplate.objects.create(document_type="id_card", message_body="ID for {{1}}")
        self.assertEqual(svc._message_for("id_card", ["Asha"]), ("ID for Asha", None))
        WhatsAppMessageTemplate.objects.filter(document_type="id_card").update(is_enabled=False)
        text, reason = svc._message_for("id_card", ["Asha"])
        self.assertIsNone(text)
        self.assertIn("turned off", reason)


@override_settings(**CONFIG, BACKEND_PUBLIC_URL="https://api.example.test")
class SendTests(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(employee_code="S1", first_name="Asha", last_name="Kumar", phone="8220015110")
        self.request = RequestFactory().get("/")

    def _send_doc(self, **kw):
        return svc.send_document(
            self.request, self.emp, "salary_slip", b"%PDF-1.4 x", "slip.pdf", ["Asha Kumar", "August 2026"], **kw
        )

    def test_document_request_shape_and_success_log(self):
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok("WAID9")) as post:
            log = self._send_doc(document_ref_id=7)
        (url,), kwargs = post.call_args
        self.assertEqual(url, "https://api.waclient.com/send")
        body = kwargs["json"]
        self.assertEqual(
            {k: body[k] for k in ("number", "type", "filename", "message", "instance_id", "access_token")},
            {
                "number": "918220015110",
                "type": "document",
                "filename": "slip.pdf",
                "message": "Hello Asha Kumar,\n\nYour salary slip for August 2026 is attached.\n\nRegards,\nUK Textiles HR",
                "instance_id": "INST1234",
                "access_token": "tok-secret",
            },
        )
        token = body["media_url"].rsplit("/", 1)[1]
        self.assertTrue(body["media_url"].startswith("https://api.example.test/api/whatsapp/media/"))
        self.assertEqual(bytes(WhatsAppMediaAsset.objects.get(token=token).content), b"%PDF-1.4 x")
        self.assertEqual((log.status, log.provider_message_id, log.document_ref_id), ("sent", "WAID9", 7))
        self.assertEqual(log.phone_number, "918220015110")

    def test_image_documents_are_sent_as_images(self):
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            svc.send_document(self.request, self.emp, "id_card", b"png", "card.png", ["Asha"], mime_type="image/png")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["type"], "image")
        self.assertNotIn("filename", body)

    def test_text_message(self):
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            log = svc.send_text(self.emp, "visitor_notification", ["Asha", "Ravi", "9000000000", "Meeting"])
        body = post.call_args.kwargs["json"]
        self.assertEqual((body["type"], body["number"]), ("text", "918220015110"))
        self.assertIn("Ravi (9000000000)", body["message"])
        self.assertEqual(log.status, "sent")

    def test_api_errors_become_a_failed_log_with_the_reason(self):
        for resp in (
            _resp(200, {"status": "error", "message": "Instance not connected"}),
            _resp(401, {"message": "Invalid token"}),
        ):
            with mock.patch("api.whatsapp_service.requests.post", return_value=resp):
                log = self._send_doc()
            self.assertEqual(log.status, "failed")
            self.assertRegex(log.error_message, r"Send failed: (Instance not connected|Invalid token)")

    def test_network_errors_never_raise(self):
        import requests

        with mock.patch("api.whatsapp_service.requests.post", side_effect=requests.ConnectionError("down")):
            log = self._send_doc()
        self.assertEqual(log.status, "failed")
        self.assertIn("Could not reach WAClient", log.error_message)

    def test_non_json_responses_never_raise(self):
        r = mock.Mock(status_code=502, content=b"<html>", text="<html>Bad gateway</html>")
        r.json.side_effect = ValueError("no json")
        with mock.patch("api.whatsapp_service.requests.post", return_value=r):
            self.assertEqual(self._send_doc().status, "failed")

    def test_no_phone_is_a_failed_log_without_calling_the_api(self):
        self.emp.phone = ""
        with mock.patch("api.whatsapp_service.requests.post") as post:
            log = self._send_doc()
        post.assert_not_called()
        self.assertEqual((log.status, log.error_message), ("failed", "No phone number on file for this employee."))

    def test_disabled_type_is_a_failed_log_without_calling_the_api(self):
        WhatsAppMessageTemplate.objects.create(document_type="salary_slip", is_enabled=False)
        with mock.patch("api.whatsapp_service.requests.post") as post:
            log = self._send_doc()
        post.assert_not_called()
        self.assertIn("turned off", log.error_message)

    @override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN="")
    def test_unconfigured_is_a_failed_log_naming_the_variables(self):
        self.assertFalse(svc.is_configured())
        with mock.patch("api.whatsapp_service.requests.post") as post:
            log = self._send_doc()
        post.assert_not_called()
        self.assertIn("WACLIENT_INSTANCE_ID", log.error_message)

    @override_settings(WHATSAPP_SEND_DELAY_SECONDS=1.5)
    def test_pace_sleeps_only_when_a_delay_is_set(self):
        with mock.patch("api.whatsapp_service.time.sleep") as sleep:
            svc.pace()
        sleep.assert_called_once_with(1.5)
        with override_settings(WHATSAPP_SEND_DELAY_SECONDS=0), mock.patch("api.whatsapp_service.time.sleep") as sleep:
            svc.pace()
        sleep.assert_not_called()


@override_settings(**CONFIG)
class SettingsEndpointTests(TestCase):
    def setUp(self):
        admin = HRUser.objects.create(username="wa_admin", password_hash="x", is_super_admin=True)
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}

    def test_status_reports_configuration_without_leaking_the_token(self):
        body = self.client.get("/api/whatsapp/status", **self.hr).json()
        self.assertEqual(body, {"configured": True, "instanceId": "…1234"})
        self.assertNotIn("tok-secret", str(body))

    def test_templates_list_every_type_with_defaults_and_is_hr_only(self):
        rows = self.client.get("/api/whatsapp/templates", **self.hr).json()
        self.assertEqual({r["documentType"] for r in rows}, {k for k, _ in WhatsAppMessageLog.DOCUMENT_TYPES})
        salary = next(r for r in rows if r["documentType"] == "salary_slip")
        self.assertEqual((salary["messageBody"], salary["isEnabled"]), ("", True))
        self.assertIn("{{2}}", salary["defaultMessage"])
        self.assertEqual(self.client.get("/api/whatsapp/templates").status_code, 401)

    def test_update_saves_wording_and_the_off_switch(self):
        r = self.client.put(
            "/api/whatsapp/templates/salary_slip",
            {"messageBody": "  Slip for {{2}}  ", "isEnabled": False},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["messageBody"], r.json()["isEnabled"]), ("Slip for {{2}}", False))
        row = WhatsAppMessageTemplate.objects.get(document_type="salary_slip")
        self.assertEqual((row.message_body, row.is_enabled), ("Slip for {{2}}", False))

    def test_unknown_document_type_is_rejected(self):
        r = self.client.put("/api/whatsapp/templates/bogus", {}, content_type="application/json", **self.hr)
        self.assertEqual(r.status_code, 400)

    def test_media_link_serves_a_stored_file_publicly_and_404s_when_unknown(self):
        token = svc._store_media(b"hello", "a.pdf", "application/pdf")
        r = self.client.get(f"/api/whatsapp/media/{token}")
        self.assertEqual((r.status_code, r.content), (200, b"hello"))
        self.assertEqual(self.client.get("/api/whatsapp/media/nope").status_code, 404)


class PublicUrlGuardTests(TestCase):
    """A document link WAClient cannot reach must fail fast with a clear reason."""

    def setUp(self):
        self.emp = Employee.objects.create(employee_code="G1", first_name="Asha", last_name="Kumar", phone="8220015110")

    def _send(self, host):
        request = RequestFactory().get("/", HTTP_HOST=host)
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            log = svc.send_document(request, self.emp, "salary_slip", b"x", "s.pdf", ["A", "B"])
        return log, post

    @override_settings(**CONFIG, BACKEND_PUBLIC_URL="", ALLOWED_HOSTS=["*"])
    def test_local_and_private_hosts_are_refused_without_calling_the_api(self):
        for host in (
            "localhost:8000",
            "127.0.0.1:8000",
            "192.168.0.10:8000",
            "10.0.0.5",
            "myserver.local",
            "[::1]:8000",
        ):
            log, post = self._send(host)
            post.assert_not_called()
            self.assertEqual(log.status, "failed", host)
            self.assertIn("BACKEND_PUBLIC_URL", log.error_message)
            self.assertFalse(WhatsAppMediaAsset.objects.exists(), host)

    @override_settings(**CONFIG, BACKEND_PUBLIC_URL="", ALLOWED_HOSTS=["*"])
    def test_a_public_host_is_accepted(self):
        log, post = self._send("api.uktextiles.in")
        post.assert_called_once()
        self.assertEqual(log.status, "sent")

    @override_settings(**CONFIG, BACKEND_PUBLIC_URL="https://abc123.tunnel.example", ALLOWED_HOSTS=["*"])
    def test_the_override_wins_even_when_the_request_came_from_localhost(self):
        log, post = self._send("localhost:8000")
        self.assertEqual(log.status, "sent")
        self.assertTrue(post.call_args.kwargs["json"]["media_url"].startswith("https://abc123.tunnel.example/"))


class TestRunSafetyTests(TestCase):
    def test_live_credentials_are_never_loaded_under_manage_py_test(self):
        # A developer's .env has real WAClient credentials; the suite must not use them.
        from django.conf import settings

        self.assertEqual(settings.WACLIENT_INSTANCE_ID, "")
        self.assertEqual(settings.WACLIENT_ACCESS_TOKEN, "")
        self.assertFalse(svc.is_configured())

    def test_no_test_can_reach_the_real_api_by_accident(self):
        with mock.patch("api.whatsapp_service.requests.post") as post:
            emp = Employee.objects.create(employee_code="SAFE1", first_name="A", last_name="B", phone="9123456789")
            log = svc.send_text(emp, "visitor_notification", ["A", "V", "1", "x"])
        post.assert_not_called()
        self.assertEqual(log.status, "failed")
