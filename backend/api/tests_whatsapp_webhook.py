"""Gupshup webhook: must always answer 200 (URL validation) and fold delivery events into the log."""

from django.test import TestCase, override_settings

from .models import Employee, WhatsAppMessageLog


def _event(kind, gs_id="GS-1", **detail):
    return {"app": "x", "type": "message-event", "payload": {"gsId": gs_id, "id": "wa-1", "type": kind, "payload": detail}}


class WebhookTests(TestCase):
    def setUp(self):
        emp = Employee.objects.create(employee_code="WH1", first_name="W", last_name="H")
        self.log = WhatsAppMessageLog.objects.create(
            employee=emp, document_type="salary_slip", phone_number="919999999999", gupshup_message_id="GS-1"
        )

    def _post(self, body, path="/api/whatsapp/webhook/", **kw):
        return self.client.post(path, body, content_type="application/json", **kw)

    def _status(self):
        self.log.refresh_from_db()
        return self.log.status

    def test_validation_probes_get_200_without_auth(self):
        for path in ("/api/whatsapp/webhook/", "/api/whatsapp/webhook"):
            self.assertEqual(self.client.get(path).json(), {"status": "ok"})
            self.assertEqual(self._post({}, path).status_code, 200)
            self.assertEqual(self.client.head(path).status_code, 200)

    def test_empty_and_non_json_bodies_still_get_200(self):
        self.assertEqual(self.client.post("/api/whatsapp/webhook/").status_code, 200)
        self.assertEqual(self.client.post("/api/whatsapp/webhook/", "a=b", content_type="text/plain").status_code, 200)
        self.assertEqual(self.client.post("/api/whatsapp/webhook/", "{bad", content_type="application/json").status_code, 200)
        self.assertEqual(self._post({"payload": "not-a-dict", "type": "message-event"}).status_code, 200)

    def test_delivered_then_read_advance_the_status(self):
        self._post(_event("delivered"))
        self.assertEqual(self._status(), "delivered")
        self._post(_event("read"))
        self.assertEqual(self._status(), "read")

    def test_late_or_duplicate_events_never_go_backwards(self):
        self._post(_event("read"))
        self._post(_event("delivered"))
        self._post(_event("sent"))
        self.assertEqual(self._status(), "read")

    def test_failed_records_the_reason(self):
        self._post(_event("failed", code=131026, reason="Message undeliverable"))
        self.log.refresh_from_db()
        self.assertEqual((self.log.status, self.log.error_message), ("failed", "Message undeliverable"))

    def test_unknown_message_ids_are_ignored(self):
        self.assertEqual(self._post(_event("delivered", gs_id="nope")).status_code, 200)
        self.assertEqual(self._status(), "sent")

    def test_non_message_events_are_ignored(self):
        self._post({"type": "user-event", "payload": {"gsId": "GS-1", "type": "delivered"}})
        self.assertEqual(self._status(), "sent")

    @override_settings(WHATSAPP_WEBHOOK_TOKEN="s3cret")
    def test_optional_token_gate(self):
        self.assertEqual(self._post(_event("delivered")).status_code, 403)
        self.assertEqual(self._status(), "sent")
        self.assertEqual(self._post(_event("delivered"), "/api/whatsapp/webhook/?token=wrong").status_code, 403)
        self.assertEqual(self._post(_event("delivered"), "/api/whatsapp/webhook/?token=s3cret").status_code, 200)
        self.assertEqual(self._status(), "delivered")


def _meta_event(status, gs_id="GS-1", **extra):
    st = {"id": "wamid.ABC", "gs_id": gs_id, "status": status, "recipient_id": "919999999999", **extra}
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {"statuses": [st]}}]}]}


class MetaFormatV3Tests(WebhookTests):
    """Gupshup's console defaults to the Meta (v3) payload format."""

    def test_v3_delivered_then_read(self):
        self._post(_meta_event("delivered"))
        self.assertEqual(self._status(), "delivered")
        self._post(_meta_event("read"))
        self.assertEqual(self._status(), "read")
        self._post(_meta_event("delivered"))
        self.assertEqual(self._status(), "read")

    def test_v3_failed_records_the_error(self):
        self._post(_meta_event("failed", errors=[{"code": 131026, "title": "Undeliverable", "message": "Message undeliverable"}]))
        self.log.refresh_from_db()
        self.assertEqual((self.log.status, self.log.error_message), ("failed", "Message undeliverable"))

    def test_v3_matches_on_the_whatsapp_id_too(self):
        self.log.gupshup_message_id = "wamid.ABC"
        self.log.save()
        self._post(_meta_event("delivered", gs_id="other"))
        self.assertEqual(self._status(), "delivered")

    def test_v3_inbound_messages_without_statuses_are_ignored(self):
        body = {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": {"messages": [{"id": "x"}]}}]}]}
        self.assertEqual(self._post(body).status_code, 200)
        self.assertEqual(self._status(), "sent")
