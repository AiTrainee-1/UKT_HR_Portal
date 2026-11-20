"""
The HRMS modules that RAISE WhatsApp messages, on the Meta WhatsApp Cloud API (2026-11-20, slice "wa-callers").

Pinned here:
  * the catalog's Meta values follow whatsappintegrationsetup.md §7.2: each type's template name, its header (documents
    "document", the ID card "image"), its category (the three one-time codes share ONE AUTHENTICATION template hrms_otp),
    the retired visitor contact card is never sent; every default wording can become a template (it never starts or
    ends with a variable, its placeholders are its variables, every variable has a one-line example);
  * the document senders (salary slip, offer / experience / resignation letter, ID card, any other employee document):
    the file is uploaded to Meta and travels in the header of the type's approved template, with the type's variables;
    a picture of a document goes as a one-page PDF; without an approved template nothing reaches Meta and HR is told
    why (a bulk salary slip send is refused up front instead of writing one skipped row per slip);
  * a one-time code goes as the copy-code AUTHENTICATION template (the code is the body parameter and the button's) and
    never sits in the log;
  * no caller still passes a contact card or reads WhatsApp groups.

Meta's Graph API is faked (tests_whatsapp_support.FakeMeta): nothing leaves the machine.

Run: DATABASE_URL= DB_TEST_NAME=test_uktex_msg_s2 py -3 manage.py test api.tests_whatsapp_callers --noinput
"""

import io
import re
from datetime import date
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, TestCase, override_settings

from . import whatsapp_catalog as catalog
from . import whatsapp_service
from .jwt_utils import sign_token
from .models import (
    Designation,
    Employee,
    EmployeeDocument,
    FileBlob,
    HRUser,
    ResignationRequest,
    SalarySlip,
    WhatsAppMessageLog,
)
from .tests_whatsapp_caller_support import assert_template_variables, sent_text
from .tests_whatsapp_support import META, FakeMeta, approve_templates

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")

# whatsappintegrationsetup.md §7.2: catalog key -> (template, header, category)
GUIDE = {
    "hod_request_waiting": ("hrms_hod_request_waiting", "", "UTILITY"),
    "hod_pending_reminder": ("hrms_hod_pending_reminder", "", "UTILITY"),
    "approval_approved": ("hrms_approval_approved", "", "UTILITY"),
    "approval_rejected": ("hrms_approval_rejected", "", "UTILITY"),
    "absent_alert": ("hrms_absent_alert", "", "UTILITY"),
    "late_alert": ("hrms_late_alert", "", "UTILITY"),
    "four_punch_alert": ("hrms_punch_reminder", "", "UTILITY"),
    "on_duty_punch_reminder": ("hrms_on_duty_punch_reminder", "", "UTILITY"),
    "missing_punch_alert": ("hrms_missing_punch_alert", "", "UTILITY"),
    "geo_approval": ("hrms_geo_approval", "", "UTILITY"),
    "geo_rejection": ("hrms_geo_rejection", "", "UTILITY"),
    "geo_punch_approval": ("hrms_geo_punch_approval", "", "UTILITY"),
    "geo_punch_rejection": ("hrms_geo_punch_rejection", "", "UTILITY"),
    "visitor_notification": ("hrms_visitor_at_reception", "", "UTILITY"),
    "outpass_gate_out": ("hrms_gate_out", "", "UTILITY"),
    "outpass_gate_in": ("hrms_gate_in", "", "UTILITY"),
    "salary_slip": ("hrms_salary_slip", "document", "UTILITY"),
    "id_card": ("hrms_id_card", "image", "UTILITY"),
    "offer_letter": ("hrms_offer_letter", "document", "UTILITY"),
    "experience_letter": ("hrms_experience_letter", "document", "UTILITY"),
    "resignation_letter": ("hrms_resignation_letter", "document", "UTILITY"),
    "other": ("hrms_document", "document", "UTILITY"),
    "attendance_report": ("hrms_attendance_report", "", "UTILITY"),
    "otp_login": ("hrms_otp", "", "AUTHENTICATION"),
    "otp_reset": ("hrms_otp", "", "AUTHENTICATION"),
    "otp_activate": ("hrms_otp", "", "AUTHENTICATION"),
    "visitor_contact": (None, "", "UTILITY"),
}

# The modules that raise WhatsApp messages (whatsapp_service itself and the views of WhatsApp Control are not callers).
CALLERS = (
    "whatsapp_approvals.py",
    "whatsapp_notifications.py",
    "whatsapp_alerts.py",
    "whatsapp_hod.py",
    "hod_reminders.py",
    "hod_reminders_views.py",
    "attendance_notify.py",
    "attendance_notify_views.py",
    "salary_slip_views.py",
    "company_documents_views.py",
    "employee_documents_views.py",
    "growth_views.py",
    "recruitment_views.py",
    "outpass_visitor_views.py",
    "otp_service.py",
)


class CatalogMetaTests(SimpleTestCase):
    def test_every_type_follows_the_guides_template_list(self):
        self.assertEqual(set(GUIDE), set(catalog.TYPES), "a catalog type is missing from the guide's list (or back)")
        for key, (name, header, category) in GUIDE.items():
            spec = catalog.get(key)
            with self.subTest(key=key):
                self.assertEqual(
                    (spec.default_template_name, spec.meta_header, spec.meta_category), (name, header, category)
                )

    def test_the_three_one_time_codes_share_one_authentication_template(self):
        codes = [k for k, t in catalog.TYPES.items() if t.kind == catalog.KIND_CODE]
        self.assertEqual(sorted(codes), ["otp_activate", "otp_login", "otp_reset"])
        self.assertEqual({catalog.get(k).default_template_name for k in codes}, {catalog.OTP_TEMPLATE})
        self.assertEqual(catalog.OTP_TEMPLATE, "hrms_otp")
        # the authentication purposes keep their {code, minutes} variables in that order (otp_service passes a list)
        for key in codes:
            self.assertEqual(catalog.get(key).variable_names, ["code", "minutes"])

    def test_the_visitor_contact_card_is_never_sent_and_says_why(self):
        spec = catalog.get("visitor_contact")
        self.assertIsNone(spec.default_template_name)
        self.assertIn("contact card", spec.description)
        self.assertIn("Visitor Notification", spec.description)
        self.assertIn("visitor_phone", catalog.get("visitor_notification").variable_names)

    def test_every_default_wording_can_become_a_meta_template(self):
        for key, spec in catalog.TYPES.items():
            if spec.default_template_name is None or spec.meta_category == "AUTHENTICATION":
                continue
            with self.subTest(key=key):
                body = spec.body.strip()
                used = _PLACEHOLDER.findall(body)
                self.assertTrue(used, "a template without variables")
                self.assertLessEqual(set(used), set(spec.variable_names))
                self.assertFalse(_PLACEHOLDER.match(body), "starts with a variable")
                self.assertFalse(re.search(r"\{\{[^}]*\}\}\s*$", body), "ends with a variable")
                fixed = _PLACEHOLDER.sub("", body)
                self.assertGreater(len(fixed.split()), 2 * len(set(used)), "too little fixed text around the variables")
                self.assertTrue(body.endswith(catalog.SIGN))  # the sign-off becomes the template's footer

    def test_every_variable_has_a_one_line_example(self):
        for key, spec in catalog.TYPES.items():
            for v in spec.variables:
                with self.subTest(key=key, variable=v.name):
                    self.assertTrue(v.sample.strip(), "Meta needs an example for every variable")
                    self.assertNotRegex(v.sample, r"[\n\t]")
                    self.assertNotIn("     ", v.sample)
                    self.assertRegex(v.name, r"^[a-z][a-z0-9_]*$")

    def test_the_two_messages_that_were_free_text_now_have_template_variables(self):
        self.assertEqual(
            catalog.get("hod_pending_reminder").variable_names, ["hod_name", "total", "pending_list", "date"]
        )
        self.assertEqual(catalog.get("attendance_report").variable_names, ["report_title", "date", "summary"])
        for key in ("hod_pending_reminder", "attendance_report"):
            self.assertTrue(catalog.get(key).has_wording)
            self.assertNotIn("{{message}}", catalog.get(key).body)

    def test_no_caller_passes_a_contact_card_or_reads_groups_any_more(self):
        api = Path(__file__).resolve().parent
        for name in CALLERS:
            source = (api / name).read_text(encoding="utf-8")
            with self.subTest(module=name):
                self.assertNotIn("fetch_groups(", source)
                self.assertNotRegex(source, r"contact\s*=\s*\{")
                self.assertNotIn("send_text_message", source)
                self.assertNotIn("send_contact_message", source)


@override_settings(**META)
class DocumentSenderTests(TestCase):
    """Each HR document endpoint: the file goes to Meta (upload) and travels in the header of the type's template."""

    def setUp(self):
        self.meta = FakeMeta.install(self)
        approve_templates("salary_slip", "offer_letter", "experience_letter", "resignation_letter", "id_card", "other")
        admin = HRUser.objects.create(username="wa_docs", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id, 'name': 'Meena'})}"}
        self.emp = Employee.objects.create(
            employee_code="D1",
            first_name="Asha",
            last_name="Kumar",
            phone="8220015110",
            status="active",
            designation=Designation.objects.create(title="Line Supervisor"),
        )

    def post(self, path, body=None):
        return self.client.post(f"/api/{path}", body or {}, content_type="application/json", **self.hr)

    def assert_document_sent(self, template, header_kind="document", filename_suffix=".pdf"):
        self.assertEqual(len(self.meta.uploads), 1)
        upload = self.meta.uploads[0]
        sent = self.meta.last()
        self.assertEqual((sent["to"], sent["template"]), ("918220015110", template))
        self.assertEqual(sent["header"]["type"], header_kind)
        self.assertTrue(sent["header"][header_kind]["id"].startswith("MEDIA"))
        if header_kind == "document":
            self.assertTrue(sent["header"]["document"]["filename"].endswith(filename_suffix))
        self.assertTrue(upload["filename"].endswith(filename_suffix))
        assert_template_variables(self, sent)
        log = WhatsAppMessageLog.objects.get()
        self.assertEqual((log.status, log.template_name), ("sent", template))
        self.assertEqual(log.message_text, sent_text(sent))
        return sent

    def slip(self):
        return SalarySlip.objects.create(
            employee=self.emp,
            month=10,
            year=2026,
            slip_number="SS/1/2026/10",
            basic=1000,
            gross_salary=1000,
            net_salary=24500,
            working_days=26,
            present_days=26,
        )

    def test_a_salary_slip(self):
        slip = self.slip()
        res = self.post(f"salary-slips/{slip.id}/whatsapp")
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_salary_slip")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar", "month_year": "October 2026"})
        self.assertEqual(self.meta.uploads[0]["mime"], "application/pdf")

    def test_a_salary_slip_without_an_approved_template_tells_hr_why(self):
        approve_templates("salary_slip", status="REJECTED")
        res = self.post(f"salary-slips/{self.slip().id}/whatsapp")
        self.assertEqual(res.status_code, 400)
        self.assertIn("hrms_salary_slip", res.json()["error"])
        self.assertEqual(self.meta.calls, [])  # not even the upload

    def test_a_bulk_salary_slip_send_is_refused_up_front_without_an_approved_template(self):
        self.slip()
        approve_templates("salary_slip", status="PENDING")
        res = self.post("salary-slips/bulk-whatsapp", {"month": 10, "year": 2026})
        self.assertEqual(res.status_code, 400)
        self.assertIn("hrms_salary_slip", res.json()["error"])
        self.assertFalse(WhatsAppMessageLog.objects.exists())  # not one skipped row per slip
        self.assertEqual(self.meta.calls, [])

    def test_a_bulk_send_switched_off_for_slips_is_refused_up_front(self):
        from .models import WhatsAppSettings

        self.slip()
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"disabled_message_types": ["salary_slip"]})
        res = self.post("salary-slips/bulk-whatsapp", {"month": 10, "year": 2026})
        self.assertEqual(res.status_code, 400)
        self.assertIn("Salary Slip", res.json()["error"])
        self.assertFalse(WhatsAppMessageLog.objects.exists())

    def test_an_offer_letter(self):
        res = self.post(f"employees/{self.emp.id}/offer-letter/whatsapp")
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_offer_letter")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar", "designation": "Line Supervisor"})

    def test_an_experience_letter(self):
        res = self.post(f"employees/{self.emp.id}/experience-letter/whatsapp", {"lastWorkingDate": "2026-10-31"})
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_experience_letter")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar"})

    def test_a_resignation_letter(self):
        r = ResignationRequest.objects.create(
            employee=self.emp, reason="Moving", status="approved", last_working_date=date(2026, 12, 31)
        )
        res = self.post(f"recruitment/resignations/{r.id}/whatsapp")
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_resignation_letter")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar", "last_working_day": "31 December 2026"})

    def test_an_id_card_goes_in_an_image_header(self):
        res = self.post("idcard/whatsapp", {"employeeId": self.emp.id})
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_id_card", header_kind="image", filename_suffix=".png")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar"})
        self.assertEqual(self.meta.uploads[0]["mime"], "image/png")
        self.assertNotIn("filename", sent["header"]["image"])  # an image header carries the picture only

    def employee_document(self, name, content, content_type, original):
        FileBlob.objects.create(name=name, content=content, content_type=content_type, size=len(content))
        return EmployeeDocument.objects.create(
            employee=self.emp, category=EmployeeDocument.CATEGORY_AADHAAR, file=name, original_filename=original
        )

    def test_an_uploaded_pdf_document_goes_as_it_is(self):
        doc = self.employee_document("employee_documents/2026/11/pan.pdf", b"%PDF-1.4 x", "application/pdf", "pan.pdf")
        res = self.post(f"employee-documents/{doc.id}/whatsapp")
        self.assertEqual(res.status_code, 200, res.content)
        sent = self.assert_document_sent("hrms_document")
        self.assertEqual(sent["params"], {"employee_name": "Asha Kumar", "document_category": "Aadhaar Card"})
        self.assertEqual(self.meta.uploads[0]["size"], len(b"%PDF-1.4 x"))

    def test_a_photo_of_a_document_goes_as_a_one_page_pdf(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (40, 30), "white").save(buf, format="PNG")
        doc = self.employee_document(
            "employee_documents/2026/11/aadhaar.png", buf.getvalue(), "image/png", "aadhaar.png"
        )
        res = self.post(f"employee-documents/{doc.id}/whatsapp")
        self.assertEqual(res.status_code, 200, res.content)
        self.assert_document_sent("hrms_document")
        upload = self.meta.uploads[0]
        self.assertEqual((upload["mime"], upload["filename"]), ("application/pdf", "aadhaar.pdf"))
        self.assertEqual(self.meta.last()["header"]["document"]["filename"], "aadhaar.pdf")

    def test_an_unreadable_picture_is_refused_with_a_plain_reason(self):
        doc = self.employee_document("employee_documents/2026/11/bad.jpg", b"not a jpeg", "image/jpeg", "bad.jpg")
        res = self.post(f"employee-documents/{doc.id}/whatsapp")
        self.assertEqual(res.status_code, 400)
        self.assertIn("could not be read", res.json()["error"])
        self.assertEqual(self.meta.calls, [])


@override_settings(**META)
class OneTimeCodeTests(TestCase):
    """otp_service sends a WhatsApp code with ONE call: send_notification(employee, <purpose's type>, [code, minutes],
    log_params=[hidden, minutes]). It goes as the copy-code AUTHENTICATION template hrms_otp."""

    def setUp(self):
        self.meta = FakeMeta.install(self)
        approve_templates("otp_login")  # one row: hrms_otp serves all three purposes
        self.emp = Employee.objects.create(
            employee_code="C1", first_name="Asha", last_name="Kumar", phone="8220015110", status="active"
        )

    def test_each_purpose_sends_the_code_as_the_authentication_template(self):
        for i, key in enumerate(("otp_login", "otp_reset", "otp_activate"), start=1):
            code = f"{i}{i}{i}456"
            log = whatsapp_service.send_notification(self.emp, key, [code, "5"], log_params=["••••••", "5"])
            with self.subTest(key=key):
                self.assertEqual((log.status, log.template_name), ("sent", "hrms_otp"))
                sent = self.meta.last()
                self.assertEqual((sent["template"], sent["language"]), ("hrms_otp", "en"))
                self.assertEqual(sent["params"], {"1": code})  # the body parameter
                self.assertEqual(sent["button"], code)  # and the copy-code button's
                self.assertNotIn(code, log.message_text)  # never in the history
                self.assertIn("is your verification code", log.message_text)

    def test_without_the_approved_template_the_code_fails_at_once_with_the_reason(self):
        approve_templates("otp_login", status="PENDING")
        log = whatsapp_service.send_notification(self.emp, "otp_login", ["123456", "5"], log_params=["••••••", "5"])
        self.assertEqual(log.status, "failed")  # otp_service treats only failed / None as "not sent"
        self.assertIn("hrms_otp", log.error_message)
        self.assertEqual(self.meta.sent, [])

    def test_the_whatsapp_master_switch_stops_codes_too(self):
        from .models import WhatsAppSettings

        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"engine_enabled": False})
        self.assertIsNone(whatsapp_service.send_notification(self.emp, "otp_login", ["123456", "5"]))
        self.assertEqual(self.meta.sent, [])


class WhatsAppFormatTests(SimpleTestCase):
    def test_one_line_and_flat(self):
        from .whatsapp_format import flat, one_line

        self.assertEqual(one_line("Fever\n\tand      a  cold "), "Fever and a cold")
        self.assertEqual(one_line(None), "")
        self.assertEqual(flat({"a": "x\ny", "b": 4, "c": None}), {"a": "x y", "b": "4", "c": ""})

    def test_the_hod_pending_list_is_one_line_in_the_approvals_order(self):
        from . import hod_reminders as rem

        self.assertEqual(rem.pending_line({"permission": 1, "leave": 2, "casual_leave": 0}), "Leave 2, Permission 1")
        params = rem.whatsapp_params(name="Suresh", by_category={"leave": 3}, day=date(2026, 11, 4))
        self.assertEqual(params, {"hod_name": "Suresh", "total": "3", "pending_list": "Leave 3", "date": "04 Nov 2026"})
        self.assertEqual(set(params), set(catalog.get("hod_pending_reminder").variable_names))

    def test_the_attendance_report_summary_is_one_line(self):
        from . import attendance_notify as notify
        from . import attendance_notify_report as rpt

        report = rpt.Report(
            name="Morning absentees",
            days=[date(2026, 11, 17)],
            employee_type="staff",
            categories=["absent", "cl", "on_leave"],
            counts={"absent": 4, "cl": 2},
            total_employees=250,
            as_of="09:30",
            branch="Tirupur",
        )
        with mock.patch.object(rpt.Report, "employees", new_callable=mock.PropertyMock, return_value=6):
            params = notify.whatsapp_params(report)
        self.assertEqual(
            params,
            {
                "report_title": "Morning absentees (Staff, Tirupur)",
                "date": "17 Nov 2026, as of 09:30",
                "summary": "Absent 4, CL 2, On Leave 0 (6 of 250 employees)",
            },
        )
        self.assertEqual(set(params), set(catalog.get("attendance_report").variable_names))
