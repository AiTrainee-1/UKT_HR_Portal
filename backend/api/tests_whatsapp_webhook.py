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


class WebhookLoggingTests(TestCase):
    """The webhook body holds employees' phone numbers and the text of messages sent to them.
    None of it may reach the logs, only a description of what arrived."""

    LOGGER = "api.whatsapp_views"
    # The shape of a real WhatsApp message echo, with made-up people.
    ECHO = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "1770760234235498",
                "changes": [
                    {
                        "field": "smb_message_echoes",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {"display_phone_number": "918000000001", "phone_number_id": "1366514856543744"},
                            "message_echoes": [
                                {
                                    "from": "918000000001",
                                    "to": "917000000002",
                                    "id": "wamid.HBgTSU4uMjYzMzkzMzUxMDM3NjU0",
                                    "timestamp": "1790394553",
                                    "type": "text",
                                    "text": {"body": "Punch Reminder. Hello ASHA KUMAR, please punch now."},
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }
    PRIVATE = ("918000000001", "917000000002", "ASHA", "KUMAR", "Punch Reminder", "wamid", "1366514856543744")

    def _post(self, body):
        return self.client.post("/api/whatsapp/webhook/", body, content_type="application/json")

    def _logged(self, body, level="INFO"):
        with self.assertLogs(self.LOGGER, level=level) as captured:
            self.assertEqual(self._post(body).status_code, 200)
        return "\n".join(captured.output)

    def test_a_message_echo_is_described_without_any_of_its_data(self):
        text = self._logged(self.ECHO)
        self.assertIn("fields=smb_message_echoes", text)
        self.assertIn("message_echoes=1", text)
        self.assertIn("types=text", text)
        for private in self.PRIVATE:
            self.assertNotIn(private, text)
        self.assertNotIn("webhook body", text)

    def test_delivery_statuses_are_named(self):
        text = self._logged({"data": [{"key": {"id": "ABC123"}, "update": {"status": 3}}]})
        self.assertIn("statuses=delivered", text)
        summary = next(line for line in text.splitlines() if "WhatsApp webhook:" in line)
        self.assertNotIn("ABC123", summary)  # the message id is not part of the summary

    def test_a_recognised_event_is_quiet_by_default(self):
        # Recognised events are INFO, which production does not print: nothing at WARNING.
        with self.assertNoLogs(self.LOGGER, level="WARNING"):
            self._post(self.ECHO)

    def test_an_unrecognised_body_warns_with_key_names_only(self):
        body = {"customer_phone": "918000000001", "note": "salary is 50000", "nested": {"secret": "hunter2"}}
        text = self._logged(body, level="WARNING")
        self.assertIn("unrecognised shape", text)
        self.assertIn("customer_phone", text)  # the key names say what WAClient started sending
        self.assertIn("note", text)
        for private in ("918000000001", "salary is 50000", "hunter2", "secret"):
            self.assertNotIn(private, text)

    def test_odd_keys_and_odd_bodies_are_not_printed(self):
        text = self._logged({"hello world, my phone is 918000000001": 1, "ok_key": 2}, level="WARNING")
        self.assertIn("ok_key", text)
        self.assertNotIn("918000000001", text)
        text = self._logged([{"a": "918000000001"}, "918000000001"], level="WARNING")
        self.assertIn("body_type=list", text)
        self.assertNotIn("918000000001", text)

    def test_a_form_encoded_body_is_never_printed_either(self):
        with self.assertLogs(self.LOGGER, level="WARNING") as captured:
            self.client.post("/api/whatsapp/webhook/", {"phone": "918000000001", "message": "hello"})
        text = "\n".join(captured.output)
        self.assertNotIn("918000000001", text)
        self.assertNotIn("hello", text)
