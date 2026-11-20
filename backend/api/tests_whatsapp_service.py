"""The WhatsApp sending service with the Meta Cloud API: phone handling, wording, which template a type is sent as and
whether it may go, the one send path (template parameters, document upload in the header, one-time codes), the failure
paths, groups and contact cards, and the test-run safety. Meta is faked (tests_whatsapp_support.FakeMeta).

Run via: python manage.py test api.tests_whatsapp_service --noinput
"""

import dataclasses
from unittest import mock

from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings

from . import whatsapp_catalog as catalog
from . import whatsapp_service as svc
from .models import (
    Employee,
    WhatsAppMediaAsset,
    WhatsAppMessageLog,
    WhatsAppMessageTemplate,
    WhatsAppOptOut,
    WhatsAppSettings,
)
from .tests_whatsapp_support import META, NO_META, TOKEN, FakeMeta, approve_templates, make_template

SLIP_BODY = "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached."


class PhoneAndWordingTests(TestCase):
    @override_settings(**META)
    def test_phone_normalisation(self):
        for raw in (
            "+918220015110",
            "918220015110",
            "8220015110",
            "82200 15110",
            "+91-82200-15110",
            "08220015110",
            "0091 82200 15110",
        ):
            self.assertEqual(svc.normalize_phone(raw), "918220015110", raw)

    @override_settings(**META)
    def test_local_numbers_that_happen_to_start_with_the_country_code_get_it_added(self):
        for raw, expected in (
            ("9123456789", "919123456789"),
            ("91234 56789", "919123456789"),
            ("9111111111", "919111111111"),
            ("919123456789", "919123456789"),
            ("+91 91234 56789", "919123456789"),
        ):
            self.assertEqual(svc.normalize_phone(raw), expected, raw)
        self.assertIsNone(svc.normalize_phone(""))
        self.assertIsNone(svc.normalize_phone(None))
        self.assertIsNone(svc.normalize_phone("n/a"))

    def test_placeholders_fill_in_order_and_missing_ones_render_empty(self):
        self.assertEqual(svc.render_message("Hi {{1}}, {{2}}!", ["Asha", "welcome"]), "Hi Asha, welcome!")
        self.assertEqual(svc.render_message("Hi {{ 1 }}{{3}}.", ["Asha"]), "Hi Asha.")

    def test_named_placeholders_and_numbered_ones_mean_the_same_thing(self):
        order = ["employee_name", "month_year"]
        by_name = {"employee_name": "Asha", "month_year": "August"}
        self.assertEqual(svc.render_message("{{employee_name}} / {{month_year}}", by_name, order), "Asha / August")
        self.assertEqual(svc.render_message("{{1}} / {{2}}", by_name, order), "Asha / August")
        self.assertEqual(svc.render_message("{{employee_name}} / {{2}}", ["Asha", "August"], order), "Asha / August")

    def test_a_line_with_nothing_to_say_is_dropped_rather_than_left_empty(self):
        body = "Hello {{name}},\n\nDate: {{date}}\nTime: {{time}}\nNote: {{note}}\n\nThanks"
        text = svc.render_message(body, {"name": "Asha", "date": "25 Sep", "time": "", "note": "  "})
        self.assertEqual(text, "Hello Asha,\n\nDate: 25 Sep\n\nThanks")
        self.assertEqual(svc.render_message("Approved by: {{a}}{{b}}", {"a": "HR", "b": ""}), "Approved by: HR")

    def test_every_message_type_has_default_wording_and_help(self):
        for doc_type, spec in catalog.TYPES.items():
            if not spec.has_wording:
                continue
            self.assertTrue(svc.DEFAULT_MESSAGES[doc_type], doc_type)
            self.assertTrue(svc.PLACEHOLDER_HELP[doc_type], doc_type)
            used = set(svc._PLACEHOLDER.findall(spec.body))
            self.assertTrue(used <= set(spec.variable_names) | {str(i) for i in range(1, 13)}, doc_type)
            rendered = svc.render_message(spec.body, catalog.sample_params(doc_type), spec.variable_names)
            self.assertNotIn("{{", rendered, doc_type)

    def test_old_saved_wording_is_no_longer_sent(self):
        # With Meta the wording IS the approved template: what HR once saved on the old editor is never used.
        WhatsAppMessageTemplate.objects.create(document_type="id_card", message_body="ID for {{1}}", is_enabled=False)
        self.assertEqual(svc._template_body("id_card"), catalog.get("id_card").body)


@override_settings(**META)
class TemplateChoiceTests(TestCase):
    def test_the_default_name_an_override_and_a_type_never_sent_through_meta(self):
        name = catalog.get("late_alert").default_template_name
        self.assertEqual(svc.template_name_for("late_alert"), name)
        s = WhatsAppSettings.get()
        s.template_overrides = {"late_alert": "my_late_v2"}
        s.save()
        self.assertEqual(svc.template_name_for("late_alert"), "my_late_v2")
        self.assertIsNone(svc.template_name_for("no_such_type"))
        choice = svc.template_for("no_such_type")
        self.assertEqual(choice.status, "NONE")
        self.assertIn("not sent through the WhatsApp Cloud API", choice.problem)
        # "-" in the catalog: never sent through Meta, whatever HR chose
        dropped = dataclasses.replace(catalog.get("late_alert"), meta_template="-")
        with mock.patch.dict(catalog.TYPES, {"late_alert": dropped}):
            self.assertIsNone(svc.template_name_for("late_alert"))
            self.assertIn("has no Meta template", svc.template_problem("late_alert"))

    def test_missing_pending_rejected_and_approved(self):
        name = svc.template_name_for("late_alert")
        choice = svc.template_for("late_alert")
        self.assertEqual(choice.status, "MISSING")
        self.assertIn(f"'{name}'", choice.problem)
        self.assertIn("WhatsApp Control -> Templates", choice.problem)
        self.assertFalse(choice.problem.startswith(("Send failed", "Could not reach", "Temporary failure")))
        make_template(name, "Hi {{employee_name}}", status="PENDING")
        self.assertIn("PENDING", svc.template_problem("late_alert"))
        row = make_template(name, "Hi {{employee_name}}", status="REJECTED")
        row.rejected_reason = "INVALID_FORMAT"
        row.save()
        self.assertIn("rejected by Meta (INVALID_FORMAT)", svc.template_problem("late_alert"))
        self.assertFalse(svc.template_approved("late_alert"))
        make_template(name, "Hi {{employee_name}}")
        choice = svc.template_for("late_alert")
        self.assertTrue(choice.approved)
        self.assertEqual((choice.status, choice.language, choice.category), ("APPROVED", "en", "UTILITY"))

    def test_an_approved_row_in_another_language_is_used_when_the_configured_one_is_not_approved(self):
        name = svc.template_name_for("late_alert")
        make_template(name, "Hi {{employee_name}}", status="PENDING", language="en")
        make_template(name, "Hi {{employee_name}}", language="en_US")
        choice = svc.template_for("late_alert")
        self.assertEqual((choice.approved, choice.language), (True, "en_US"))

    def test_variables_header_and_text_come_from_the_approved_template(self):
        name = svc.template_name_for("salary_slip")
        make_template(name, SLIP_BODY, header="document")
        choice = svc.template_for("salary_slip")
        self.assertEqual(choice.variable_names, ["employee_name", "month_year"])
        self.assertEqual(choice.header, "document")
        text = svc.render_template_text(choice, {"employee_name": "Asha\nKumar", "month_year": "Oct 2026"})
        self.assertEqual(text, "Dear Asha Kumar,\nYour salary slip for Oct 2026 is attached.")
        # without the template's text here, the catalog's wording and header stand in
        bare = svc.TemplateChoice("salary_slip", name, "en", "APPROVED", "UTILITY", None, None)
        self.assertEqual(bare.variable_names, catalog.get("salary_slip").variable_names)
        self.assertEqual(bare.header, catalog.get("salary_slip").meta_header)


@override_settings(**META)
class SendTests(TestCase):
    def setUp(self):
        cache.clear()
        self.meta = FakeMeta.install(self)
        self.emp = Employee.objects.create(employee_code="S1", first_name="Asha", last_name="Kumar", phone="8220015110")
        self.request = RequestFactory().get("/")
        self.slip = make_template(svc.template_name_for("salary_slip"), SLIP_BODY, header="document")

    def _send_doc(self, **kw):
        return svc.send_document(
            self.request, self.emp, "salary_slip", b"%PDF-1.4 x", "slip.pdf", ["Asha Kumar", "August 2026"], **kw
        )

    def test_a_document_is_uploaded_and_sent_in_the_templates_header(self):
        log = self._send_doc(document_ref_id=7)
        self.assertEqual(self.meta.uploads[0]["filename"], "slip.pdf")
        self.assertEqual(self.meta.uploads[0]["mime"], "application/pdf")
        sent = self.meta.last()
        self.assertEqual((sent["to"], sent["template"], sent["language"]), ("918220015110", self.slip.name, "en"))
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar", "month_year": "August 2026"})
        self.assertEqual(sent["header"], {"type": "document", "document": {"id": "MEDIA0001", "filename": "slip.pdf"}})
        log.refresh_from_db()
        self.assertEqual((log.status, log.provider_message_id, log.document_ref_id), ("sent", "wamid.TEST0002", 7))
        self.assertEqual(log.template_name, self.slip.name)
        self.assertEqual(log.message_text, "Dear Asha Kumar,\nYour salary slip for August 2026 is attached.")
        self.assertEqual(log.payload["media_id"], "MEDIA0001")
        self.assertNotIn("media_url", log.payload)

    def test_no_public_address_is_needed_for_documents_any_more(self):
        local = RequestFactory().get("/", HTTP_HOST="localhost:8000")
        with override_settings(BACKEND_PUBLIC_URL="", ALLOWED_HOSTS=["*"]):
            log = svc.send_document(local, self.emp, "salary_slip", b"x", "s.pdf", ["A", "B"])
        self.assertEqual(log.status, "sent")
        self.assertIsNone(svc.public_base_problem("http://localhost:8000"))

    def test_an_image_template(self):
        make_template(svc.template_name_for("id_card"), "Dear {{employee_name}}, your ID card.", header="image")
        log = svc.send_document(self.request, self.emp, "id_card", b"png", "card.png", ["Asha"], mime_type="image/png")
        self.assertEqual(log.status, "sent")
        self.assertEqual(self.meta.last()["header"], {"type": "image", "image": {"id": "MEDIA0001"}})
        self.assertEqual(self.meta.uploads[0]["mime"], "image/png")

    def test_a_file_for_a_template_without_a_media_header_is_refused_clearly(self):
        make_template(self.slip.name, SLIP_BODY, header="")
        log = self._send_doc()
        self.assertEqual(log.status, "failed")
        self.assertIn("has no document or image header", log.error_message)
        self.assertEqual(self.meta.sent, [])

    def test_a_text_message_sends_exactly_the_templates_variables(self):
        name = svc.template_name_for("visitor_notification")
        make_template(
            name, "Dear {{employee_name}}, {{visitor_name}} is waiting at reception. Contact: {{visitor_phone}}."
        )
        log = svc.send_text(
            self.emp, "visitor_notification", {"employee_name": "Asha", "visitor_name": "Ravi", "visitor_phone": "9000"}
        )
        self.assertEqual(log.status, "sent")
        self.assertEqual(
            self.meta.last()["params"], {"employee_name": "Asha", "visitor_name": "Ravi", "visitor_phone": "9000"}
        )
        self.assertIn("Ravi is waiting at reception", log.message_text)

    def test_a_missing_variable_is_sent_as_a_dash(self):
        name = svc.template_name_for("visitor_notification")
        make_template(name, "Dear {{employee_name}}, {{visitor_name}} ({{company}}) is here.")
        svc.send_text(self.emp, "visitor_notification", {"employee_name": "Asha", "visitor_name": "Ravi"})
        self.assertEqual(self.meta.last()["params"]["company"], "-")

    def test_a_template_that_is_not_approved_is_skipped_without_calling_meta(self):
        make_template(self.slip.name, SLIP_BODY, header="document", status="PENDING")
        log = self._send_doc()
        self.assertEqual(log.status, "skipped")
        self.assertIn("PENDING", log.error_message)
        self.assertEqual(self.meta.calls, [])
        self.assertFalse(WhatsAppMediaAsset.objects.exists())

    def test_meta_errors_become_a_failed_log_with_plain_words_and_the_code(self):
        self.meta.answer(self.meta_upload_ok())
        self.meta.fail(132001, "Template name does not exist in the translation")
        log = self._send_doc()
        self.assertEqual(log.status, "failed")
        self.assertTrue(log.error_message.startswith(svc.REFUSED_PREFIX))
        self.assertTrue(log.error_message.endswith("(code 132001)"))
        self.meta.fail(190, "expired", status=401)
        log = self._send_doc()
        self.assertTrue(log.error_message.startswith(svc.SEND_FAILED_PREFIX))
        self.assertIn("access token", log.error_message)
        self.assertNotIn(TOKEN, log.error_message)

    def meta_upload_ok(self):
        from .tests_whatsapp_support import Resp

        return Resp(200, {"id": "MEDIA-X"})

    def test_network_errors_never_raise(self):
        self.meta.network_error()
        log = self._send_doc()
        self.assertEqual(log.status, "failed")
        self.assertTrue(log.error_message.startswith(svc.UNREACHABLE_PREFIX))

    def test_no_phone_is_a_failed_log_without_calling_the_api(self):
        self.emp.phone = ""
        log = self._send_doc()
        self.assertEqual(self.meta.calls, [])
        self.assertEqual((log.status, log.error_message), ("failed", "No phone number on file for this employee."))

    def test_an_opted_out_employee_is_skipped(self):
        WhatsAppOptOut.objects.create(employee=self.emp)
        self.assertEqual(self._send_doc().status, "skipped")
        self.assertEqual(self.meta.calls, [])

    @override_settings(**NO_META)
    def test_unconfigured_is_a_failed_log_naming_the_variables(self):
        self.assertFalse(svc.is_configured())
        log = self._send_doc()
        self.assertEqual(self.meta.calls, [])
        self.assertIn("WHATSAPP_CLOUD_PHONE_NUMBER_ID", log.error_message)
        self.assertIn("WHATSAPP_CLOUD_ACCESS_TOKEN", log.error_message)

    def test_no_sender_sleeps_between_messages_any_more(self):
        self.assertFalse(hasattr(svc, "pace"))

    def test_the_free_text_and_link_paths_are_gone(self):
        for gone in (
            "send_text_message",
            "send_document_message",
            "send_contact_message",
            "instance_status",
            "_post_send",
            "media_url_for_base",
        ):
            self.assertFalse(hasattr(svc, gone), gone)


@override_settings(**META)
class CodeTests(TestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)
        self.emp = Employee.objects.create(employee_code="C1", first_name="Asha", last_name="K", phone="8220015110")

    def code(self):
        return svc.send_notification(self.emp, "otp_login", ["482913", "5"], log_params=["••••••", "5"])

    def auth_template(self):
        """The copy-code AUTHENTICATION template (whatever category the catalog gives the type)."""
        return make_template(svc.template_name_for("otp_login"), category="AUTHENTICATION")

    def test_a_code_goes_at_once_as_the_authentication_template_and_is_never_stored(self):
        self.auth_template()
        log = self.code()
        sent = self.meta.last()
        self.assertEqual(sent["template"], svc.template_name_for("otp_login"))
        self.assertEqual((sent["params"], sent["button"]), ({"1": "482913"}, "482913"))
        self.assertEqual((log.status, log.kind, log.provider_message_id), ("sent", "code", "wamid.TEST0001"))
        self.assertNotIn("482913", log.message_text)
        self.assertIn("is your verification code", log.message_text)
        self.assertEqual(log.template_name, sent["template"])

    def test_no_approved_template_fails_the_code_clearly(self):
        log = self.code()
        self.assertEqual(log.status, "failed")
        self.assertIn("not on this server yet", log.error_message)
        self.assertEqual(self.meta.calls, [])

    def test_a_code_type_pointed_at_a_utility_template_sends_its_variables(self):
        s = WhatsAppSettings.get()
        s.template_overrides = {"otp_login": "hrms_login_code_text"}
        s.save()
        make_template("hrms_login_code_text", "Your sign-in code is {{code}}. It expires in {{minutes}} minutes.")
        log = self.code()
        self.assertEqual(log.status, "sent")
        self.assertEqual(self.meta.last()["params"], {"code": "482913", "minutes": "5"})
        self.assertNotIn("482913", log.message_text)

    def test_metas_refusal_of_a_code(self):
        self.auth_template()
        self.meta.fail(131026, "undeliverable")
        log = self.code()
        self.assertEqual(log.status, "failed")
        self.assertIn("(code 131026)", log.error_message)


@override_settings(**META)
class GroupsAndContactCardTests(TestCase):
    def setUp(self):
        self.meta = FakeMeta.install(self)

    def test_groups_are_refused(self):
        with self.assertRaises(svc.WhatsAppServiceError) as caught:
            svc.fetch_groups()
        self.assertIn("groups", str(caught.exception))
        approve_templates("attendance_report")
        log = svc.queue_to_recipient(
            "120363000000000000@g.us",
            "Report",
            recipient_label="Group",
            dedupe_key="g1",
            document_type="attendance_report",
        )
        self.assertEqual((log.status, log.error_message), ("skipped", svc.REASON_NO_GROUPS))
        with self.assertRaises(svc.WhatsAppServiceError):
            svc.deliver_template("120363000000000000@g.us", "attendance_report", {})
        self.assertEqual(self.meta.calls, [])

    def test_a_number_gets_the_report_template_with_its_text_flattened(self):
        approve_templates("attendance_report")
        first = catalog.get("attendance_report").variable_names[0]
        log = svc.queue_to_recipient(
            "919876500000",
            "Absent: 4\nCL: 2",
            recipient_label="Owner",
            dedupe_key="n1",
            document_type="attendance_report",
        )
        self.assertEqual(log.status, "sent")
        self.assertEqual(self.meta.last()["params"][first], "Absent: 4 CL: 2")
        again = svc.queue_to_recipient(
            "919876500000", "Absent: 4", recipient_label="Owner", dedupe_key="n1", document_type="attendance_report"
        )
        self.assertEqual(again.pk, log.pk)  # exactly once

    def test_the_visitor_contact_card_is_never_sent(self):
        emp = Employee.objects.create(employee_code="V1", first_name="Asha", last_name="K", phone="8220015110")
        approve_templates("visitor_notification")
        log = svc.send_notification(
            emp,
            "visitor_notification",
            {"employee_name": "Asha", "visitor_name": "Vishal"},
            contact={"document_type": "visitor_contact", "first_name": "Vishal", "phone": "9876"},
        )
        self.assertEqual(log.status, "sent")
        self.assertEqual(len(self.meta.sent), 1)
        self.assertFalse(WhatsAppMessageLog.objects.filter(document_type="visitor_contact").exists())


@override_settings(**META)
class PhoneStatusTests(TestCase):
    def setUp(self):
        cache.clear()
        self.meta = FakeMeta.install(self)

    def test_metas_view_of_the_number_in_camel_case_and_cached(self):
        first = svc.phone_status()
        self.assertEqual(
            first["phone"],
            {
                "displayPhoneNumber": "+91 98765 43210",
                "verifiedName": "UK Textiles",
                "qualityRating": "GREEN",
                "messagingLimitTier": "TIER_1K",
                "status": "CONNECTED",
                "nameStatus": "APPROVED",
                "codeVerificationStatus": "VERIFIED",
                "throughput": "STANDARD",
                "platformType": "CLOUD_API",
            },
        )
        self.assertTrue(first["tokenOk"])
        svc.phone_status()
        self.assertEqual(len(self.meta.calls), 1)  # cached
        svc.phone_status(refresh=True)
        self.assertEqual(len(self.meta.calls), 2)

    def test_a_refused_token(self):
        self.meta.fail(190, "expired", status=401)
        status = svc.phone_status(refresh=True)
        self.assertEqual((status["ok"], status["tokenOk"], status["code"]), (False, False, 190))
        self.assertNotIn(TOKEN, str(status))

    @override_settings(**NO_META)
    def test_not_configured(self):
        status = svc.phone_status()
        self.assertEqual((status["ok"], status["tokenOk"]), (False, None))
        self.assertEqual(self.meta.calls, [])


class TestRunSafetyTests(TestCase):
    def test_live_credentials_are_never_loaded_under_manage_py_test(self):
        from django.conf import settings

        self.assertEqual(settings.WHATSAPP_CLOUD_ACCESS_TOKEN, "")
        self.assertFalse(svc.is_configured())

    def test_no_test_can_reach_the_real_api_by_accident(self):
        with (
            mock.patch("api.whatsapp_cloud.requests.post") as post,
            mock.patch("api.whatsapp_cloud.requests.get") as get,
        ):
            emp = Employee.objects.create(employee_code="SAFE1", first_name="A", last_name="B", phone="9123456789")
            approve_templates("visitor_notification")
            log = svc.send_text(emp, "visitor_notification", ["A", "V", "1", "x"])
        post.assert_not_called()
        get.assert_not_called()
        self.assertEqual(log.status, "failed")
