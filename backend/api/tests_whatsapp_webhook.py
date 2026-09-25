"""WAClient webhook: must always answer 200 and fold delivery events into the log."""

from django.test import TestCase, override_settings

from .models import Employee, WhatsAppMessageLog


class WebhookTests(TestCase):
    def setUp(self):
        emp = Employee.objects.create(employee_code="WH1", first_name="W", last_name="H")
        self.log = WhatsAppMessageLog.objects.create(
            employee=emp, document_type="salary_slip", phone_number="919999999999", provider_message_id="ABC123"
        )

    def _post(self, body, path="/api/whatsapp/webhook/", **kw):
        return self.client.post(path, body, content_type="application/json", **kw)

    def _status(self):
        self.log.refresh_from_db()
        return self.log.status

    def test_probes_get_200_without_auth(self):
        for path in ("/api/whatsapp/webhook/", "/api/whatsapp/webhook"):
            self.assertEqual(self.client.get(path).json(), {"status": "ok"})
            self.assertEqual(self._post({}, path).status_code, 200)
            self.assertEqual(self.client.head(path).status_code, 200)

    def test_empty_form_and_malformed_bodies_still_get_200(self):
        self.assertEqual(self.client.post("/api/whatsapp/webhook/").status_code, 200)
        self.assertEqual(self.client.post("/api/whatsapp/webhook/", "a=b", content_type="text/plain").status_code, 200)
        self.assertEqual(
            self.client.post("/api/whatsapp/webhook/", "{bad", content_type="application/json").status_code, 200
        )
        self.assertEqual(self._post([1, 2, "x", None]).status_code, 200)
        self.assertEqual(self._post({"key": "not-a-dict", "status": {"a": 1}}).status_code, 200)

    def test_baileys_style_update_advances_the_status(self):
        # {"key": {"id"}, "update": {"status": N}}: 3 = delivered, 4 = read
        self._post({"event": "messages.update", "data": [{"key": {"id": "ABC123"}, "update": {"status": 3}}]})
        self.assertEqual(self._status(), "delivered")
        self._post({"data": [{"key": {"id": "ABC123"}, "update": {"status": 4}}]})
        self.assertEqual(self._status(), "read")

    def test_named_statuses_and_flat_payloads(self):
        self._post({"id": "ABC123", "status": "DELIVERY_ACK"})
        self.assertEqual(self._status(), "delivered")
        self._post({"message_id": "ABC123", "status": "read"})
        self.assertEqual(self._status(), "read")

    def test_late_or_duplicate_events_never_go_backwards(self):
        self._post({"key": {"id": "ABC123"}, "status": "READ"})
        self._post({"key": {"id": "ABC123"}, "status": "DELIVERY_ACK"})
        self._post({"key": {"id": "ABC123"}, "status": "SERVER_ACK"})
        self.assertEqual(self._status(), "read")

    def test_error_status_marks_the_message_failed(self):
        self._post({"key": {"id": "ABC123"}, "update": {"status": 0}})
        self.log.refresh_from_db()
        self.assertEqual((self.log.status, self.log.error_message), ("failed", "Delivery failed"))

    def test_unknown_ids_and_other_events_are_ignored(self):
        self.assertEqual(self._post({"key": {"id": "nope"}, "status": "READ"}).status_code, 200)
        self._post({"event": "messages.upsert", "data": {"key": {"id": "ABC123"}, "message": {"conversation": "hi"}}})
        self.assertEqual(self._status(), "sent")

    def test_form_encoded_bodies_are_accepted(self):
        r = self.client.post("/api/whatsapp/webhook/", {"id": "ABC123", "status": "delivered"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._status(), "delivered")

    @override_settings(WHATSAPP_WEBHOOK_TOKEN="s3cret")
    def test_optional_token_gate(self):
        body = {"key": {"id": "ABC123"}, "status": "READ"}
        self.assertEqual(self._post(body).status_code, 403)
        self.assertEqual(self._status(), "sent")
        self.assertEqual(self._post(body, "/api/whatsapp/webhook/?token=wrong").status_code, 403)
        self.assertEqual(self._post(body, "/api/whatsapp/webhook/?token=s3cret").status_code, 200)
        self.assertEqual(self._status(), "read")
