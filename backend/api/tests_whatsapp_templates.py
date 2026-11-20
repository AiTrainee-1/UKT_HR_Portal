"""WhatsApp Control -> Templates: drafts from the catalog, Meta's template rules, create / resubmit / create-missing,
sync, delete and the list (whatsapp_templates.py + the meta-templates endpoints). No test reaches Meta (FakeMeta)."""

from dataclasses import replace
from unittest import mock

from django.core.cache import cache
from django.test import TestCase, override_settings

from . import whatsapp_catalog as catalog
from . import whatsapp_service
from . import whatsapp_templates as templates
from .jwt_utils import sign_token
from .models import HRUser, Role, WhatsAppSettings, WhatsAppTemplate
from .tests_whatsapp_support import META, NO_META, TOKEN, FakeMeta, Resp, approve_templates, make_template, meta_error

BASE = "/api/whatsapp-control/meta-templates"
META_TYPES = [k for k, t in catalog.TYPES.items() if t.default_template_name is not None]


def _hr(username="tpl_admin", super_admin=True, role=None):
    user, _ = HRUser.objects.get_or_create(
        username=username, defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role}
    )
    return user, {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _fake_type(key="fake_notice", **kw):
    """A catalog entry for one test (the real catalog is edited by other work: these tests pin their own wording)."""
    base = dict(
        key=key,
        label="Fake Notice",
        module="approvals",
        body="Dear {{employee_name}},\nYour {{thing}} is ready.\n\n- UK Textiles HR",
        variables=(catalog.V("employee_name", "Name", "Asha Kumar"), catalog.V("thing", "What", "uniform")),
        kind=catalog.KIND_REQUESTED,
        priority=4,
    )
    base.update(kw)
    return catalog.MessageType(**base)


def _otp_spec():
    return replace(catalog.get("otp_login"), meta_template="hrms_otp", meta_category="AUTHENTICATION")


def utility(**kw):
    data = {
        "name": "hrms_fake_notice",
        "language": "en",
        "category": "UTILITY",
        "header": "",
        "body": "Dear {{employee_name}},\nYour {{thing}} is ready to collect.",
        "footer": "UK Textiles HR",
        "examples": {"employee_name": "Asha Kumar", "thing": "uniform"},
    }
    data.update(kw)
    return data


@override_settings(**META)
class TemplateBase(TestCase):
    def setUp(self):
        cache.clear()
        self.meta = FakeMeta.install(self)
        self.user, self.hr = _hr()

    def post(self, path="", body=None, headers=None):
        url = f"{BASE}/{path}" if path else BASE
        return self.client.post(url, body or {}, content_type="application/json", **(headers or self.hr))

    def get(self, path="", headers=None):
        url = f"{BASE}/{path}" if path else BASE
        return self.client.get(url, **(headers or self.hr))

    def delete(self, pk, headers=None):
        return self.client.delete(f"{BASE}/{pk}", **(headers or self.hr))


class DraftTests(TemplateBase):
    def test_every_type_sent_through_meta_gets_a_draft_meta_accepts(self):
        for key in META_TYPES:
            spec = catalog.get(key)
            d = templates.draft_for(key)
            self.assertEqual(d["errors"], {}, key)
            self.assertEqual(d["name"], spec.default_template_name, key)
            self.assertEqual(d["messageType"], key)
            if d["category"] == "AUTHENTICATION":
                self.assertEqual(d["body"], "", key)
                continue
            body = d["body"]
            self.assertFalse(body.startswith("{{"), key)
            self.assertFalse(body.endswith("}}"), key)
            self.assertNotIn(catalog.SIGN, body, key)  # the footer signs it
            self.assertEqual(d["footer"], "UK Textiles HR", key)
            self.assertEqual(d["header"], spec.meta_header, key)
            self.assertEqual(set(d["examples"]), set(d["variables"]), key)
            self.assertTrue(set(d["variables"]) <= set(spec.variable_names), key)
            for name, example in d["examples"].items():
                self.assertTrue(example.strip(), (key, name))
                self.assertNotIn("\n", example, (key, name))
            self.assertNotIn("{{", d["preview"], key)
            self.assertNotRegex(body, r"\}\}[ \t]*\{\{", key)

    def test_numbered_wording_is_renamed_and_a_title_and_closing_line_are_added(self):
        spec = _fake_type(body="{{1}} came for {{2}}\n\n- UK Textiles HR")
        with mock.patch.dict(catalog.TYPES, {spec.key: spec}):
            d = templates.draft_for(spec.key)
        self.assertEqual(
            d["body"],
            "*Fake Notice*\n\n{{employee_name}} came for {{thing}}\n\n" + templates.CLOSING_LINE,
        )
        self.assertEqual(d["variables"], ["employee_name", "thing"])
        self.assertEqual(d["examples"], {"employee_name": "Asha Kumar", "thing": "uniform"})
        self.assertTrue(any("title" in w for w in d["warnings"]))
        self.assertTrue(any("closing line" in w for w in d["warnings"]))
        self.assertEqual(d["errors"], {})
        self.assertEqual(d["name"], "hrms_fake_notice")

    def test_an_optional_line_of_only_a_variable_is_flattened_into_a_labelled_line(self):
        spec = _fake_type(
            body="Dear {{employee_name}},\nReason: {{thing}}\n{{extra}}\n\nThanks.",
            variables=(
                catalog.V("employee_name", "Name", "Asha"),
                catalog.V("thing", "What", "x"),
                catalog.V("extra", "Optional", ""),
            ),
        )
        with mock.patch.dict(catalog.TYPES, {spec.key: spec}):
            d = templates.draft_for(spec.key)
        self.assertIn("Reason: {{thing}}\nNote: {{extra}}\n", d["body"])
        self.assertEqual(d["examples"]["extra"], "-")  # an empty sample is sent as "-", like an empty value
        self.assertEqual(d["errors"], {})

    def test_the_code_draft_has_metas_authentication_shape(self):
        s = WhatsAppSettings.get()
        s.otp_expiry_minutes = 7
        s.save()
        with mock.patch.dict(catalog.TYPES, {"otp_login": _otp_spec()}):
            d = templates.draft_for("otp_login")
            checked = templates.validate(d)
        self.assertEqual((d["name"], d["category"], d["codeExpirationMinutes"]), ("hrms_otp", "AUTHENTICATION", 7))
        self.assertEqual((d["body"], d["footer"], d["header"], d["examples"]), ("", "", "", {}))
        self.assertIn("expires in 7 minutes", d["preview"])
        self.assertTrue(checked.ok)
        self.assertEqual(
            templates.payload_for(checked.clean),
            {
                "name": "hrms_otp",
                "language": "en",
                "category": "AUTHENTICATION",
                "components": [
                    {"type": "BODY", "add_security_recommendation": True},
                    {"type": "FOOTER", "code_expiration_minutes": 7},
                    {"type": "BUTTONS", "buttons": [{"type": "OTP", "otp_type": "COPY_CODE", "text": "Copy code"}]},
                ],
            },
        )

    def test_the_draft_follows_hrs_choice_of_template(self):
        s = WhatsAppSettings.get()
        s.template_overrides = {"late_alert": "hrms_late_v2"}
        s.save()
        self.assertEqual(self.get("draft/late_alert").json()["name"], "hrms_late_v2")

    def test_the_draft_reports_the_current_template_status(self):
        make_template(catalog.get("late_alert").default_template_name, status="REJECTED")
        d = self.get("draft/late_alert").json()
        self.assertEqual(d["currentStatus"], "REJECTED")
        self.assertIn("rejected", d["currentProblem"].lower())

    def test_unknown_and_not_via_meta_types(self):
        self.assertEqual(self.get("draft/bogus").status_code, 404)
        spec = _fake_type(meta_template="-")
        with mock.patch.dict(catalog.TYPES, {spec.key: spec}):
            r = self.get(f"draft/{spec.key}")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not sent through WhatsApp Cloud API", r.json()["error"])


class ValidationTests(TemplateBase):
    def errors(self, **kw):
        return templates.validate(utility(**kw)).errors

    def test_a_good_template_passes(self):
        checked = templates.validate(utility())
        self.assertEqual(checked.errors, {})
        self.assertEqual(checked.clean["variables"], ["employee_name", "thing"])

    def test_names(self):
        for bad in ("", "Hrms_Late", "hrms late", "hrms-late", "x" * 513):
            self.assertIn("name", self.errors(name=bad), bad)
        self.assertNotIn("name", self.errors(name="hrms_late_alert_2"))

    def test_language_and_category(self):
        self.assertIn("language", self.errors(language="english"))
        self.assertNotIn("language", self.errors(language="en_US"))
        self.assertIn("Marketing", self.errors(category="MARKETING")["category"])
        self.assertIn("category", self.errors(category="PROMO"))

    def test_metas_body_rules(self):
        cases = {
            "{{employee_name}}, your uniform is ready.": "starts with a variable",
            "Dear Asha, your {{thing}}": "ends with a variable",
            "Dear {{employee_name}} {{thing}} is ready.": "side by side",
            "Dear {{Employee}}, ready.": "not allowed",
            "Dear {{1}}, ready.": "not allowed",
            "Dear {{employee_name, ready.": "not closed",
            "": "Write the message text",
        }
        for body, words in cases.items():
            examples = {"employee_name": "A", "thing": "B", "Employee": "C", "1": "D"}
            self.assertIn(words, self.errors(body=body, examples=examples).get("body", ""), body)
        self.assertIn("1024", self.errors(body="Dear {{employee_name}}, " + "x" * 1100 + ".")["body"])

    def test_two_variables_on_separate_lines_is_only_a_warning(self):
        checked = templates.validate(utility(body="Dear Asha,\nfor {{employee_name}}\n{{thing}}\nis ready."))
        self.assertEqual(checked.errors, {})
        self.assertTrue(any("line break" in w for w in checked.warnings))

    def test_every_variable_needs_an_example(self):
        errors = self.errors(examples={"employee_name": "Asha", "thing": "  "})
        self.assertIn("{{thing}}", errors["examples"])
        self.assertIn("examples", self.errors(examples="nope"))

    def test_examples_are_one_short_line(self):
        checked = templates.validate(utility(examples={"employee_name": "Asha\n  Kumar\t", "thing": "x" * 500}))
        self.assertEqual(checked.clean["examples"]["employee_name"], "Asha Kumar")
        self.assertLessEqual(len(checked.clean["examples"]["thing"]), templates.MAX_EXAMPLE)

    def test_footer_and_header(self):
        self.assertIn("60", self.errors(footer="x" * 61)["footer"])
        self.assertIn("variable", self.errors(footer="Hi {{employee_name}}")["footer"])
        self.assertIn("header", self.errors(header="video"))
        self.assertIn("headerText", self.errors(header="text"))
        self.assertIn("headerText", self.errors(header="text", headerText="Hi {{employee_name}}"))
        self.assertEqual(self.errors(header="text", headerText="Uniform ready"), {})

    def test_code_templates(self):
        auth = {"name": "hrms_otp", "category": "AUTHENTICATION", "codeExpirationMinutes": 0}
        self.assertIn("codeExpirationMinutes", templates.validate(auth).errors)
        auth["codeExpirationMinutes"] = 91
        self.assertIn("codeExpirationMinutes", templates.validate(auth).errors)
        auth["codeExpirationMinutes"] = "10"
        checked = templates.validate(auth)
        self.assertEqual((checked.errors, checked.clean["codeExpirationMinutes"]), ({}, 10))
        del auth["codeExpirationMinutes"]  # the settings' expiry
        self.assertEqual(
            templates.validate(auth).clean["codeExpirationMinutes"], WhatsAppSettings.get().otp_expiry_minutes
        )

    def test_message_type_must_be_known_and_sent_through_meta(self):
        self.assertIn("messageType", self.errors(messageType="bogus"))
        self.assertNotIn("messageType", self.errors(messageType="late_alert"))
        checked = templates.validate(utility(messageType="salary_slip"))
        self.assertTrue(any("document" in w for w in checked.warnings))  # a slip without its file header

    def test_payload_of_a_named_utility_template_with_a_document_header(self):
        checked = templates.validate(utility(header="document"))
        self.assertEqual(
            templates.payload_for(checked.clean, "HANDLE-1"),
            {
                "name": "hrms_fake_notice",
                "language": "en",
                "category": "UTILITY",
                "parameter_format": "named",
                "components": [
                    {"type": "HEADER", "format": "DOCUMENT", "example": {"header_handle": ["HANDLE-1"]}},
                    {
                        "type": "BODY",
                        "text": "Dear {{employee_name}},\nYour {{thing}} is ready to collect.",
                        "example": {
                            "body_text_named_params": [
                                {"param_name": "employee_name", "example": "Asha Kumar"},
                                {"param_name": "thing", "example": "uniform"},
                            ]
                        },
                    },
                    {"type": "FOOTER", "text": "UK Textiles HR"},
                ],
            },
        )


class CreateTests(TemplateBase):
    def test_a_template_is_submitted_to_meta_and_saved(self):
        r = self.post(body=utility(messageType="approval_approved"))
        self.assertEqual(r.status_code, 201, r.content)
        sent = self.meta.created[0]
        self.assertEqual(
            sent, templates.payload_for(templates.validate(utility(messageType="approval_approved")).clean)
        )
        row = WhatsAppTemplate.objects.get(name="hrms_fake_notice", language="en")
        self.assertEqual((row.status, row.category, row.message_type), ("PENDING", "UTILITY", "approval_approved"))
        self.assertTrue(row.meta_id)
        self.assertEqual(row.created_by, self.user)
        body = r.json()
        self.assertEqual(body["template"]["name"], "hrms_fake_notice")
        self.assertEqual(body["template"]["status"], "PENDING")
        self.assertIn("approval", body["message"])
        self.assertNotIn(TOKEN, r.content.decode())

    def test_made_for_a_type_under_another_name_points_the_type_at_it(self):
        self.post(body=utility(messageType="approval_approved"))
        self.assertEqual(WhatsAppSettings.get().template_overrides, {"approval_approved": "hrms_fake_notice"})
        self.assertEqual(whatsapp_service.template_name_for("approval_approved"), "hrms_fake_notice")
        # under the catalog's own name: no override is kept
        default = catalog.get("approval_rejected").default_template_name
        self.post(body=utility(name=default, messageType="approval_rejected"))
        self.assertNotIn("approval_rejected", WhatsAppSettings.get().template_overrides)

    def test_a_template_that_breaks_metas_rules_never_reaches_meta(self):
        r = self.post(body=utility(body="{{employee_name}} is late"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("body", r.json()["fields"])
        self.assertTrue(r.json()["error"])
        self.assertEqual(self.meta.calls, [])
        self.assertFalse(WhatsAppTemplate.objects.exists())

    def test_metas_refusal_comes_back_readable(self):
        self.meta.answer(meta_error(100, "Invalid parameter", details="The body has too many variables for its length"))
        r = self.post(body=utility())
        self.assertEqual(r.status_code, 400)
        self.assertIn("too many variables for its length", r.json()["error"])
        self.assertEqual(r.json()["code"], 100)
        self.assertFalse(WhatsAppTemplate.objects.exists())

    def test_meta_out_of_reach_is_a_502(self):
        self.meta.network_error()
        r = self.post(body=utility())
        self.assertEqual(r.status_code, 502)
        self.assertIn("Could not reach Meta", r.json()["error"])

    @override_settings(**NO_META)
    def test_not_configured(self):
        r = self.post(body=utility())
        self.assertEqual(r.status_code, 400)
        self.assertIn("WHATSAPP_CLOUD_ACCESS_TOKEN", r.json()["error"])
        self.assertEqual(self.meta.calls, [])

    def test_a_name_already_taken_in_that_language_is_refused(self):
        make_template("hrms_fake_notice", status="APPROVED")
        r = self.post(body=utility())
        self.assertEqual(r.status_code, 409)
        self.assertIn("name", r.json()["fields"])
        self.assertEqual(self.meta.calls, [])

    def test_a_rejected_template_is_edited_and_resubmitted_under_its_meta_id(self):
        row = make_template("hrms_fake_notice", status="REJECTED")
        row.rejected_reason = "INVALID_FORMAT"
        row.save()
        self.meta.answer(Resp(200, {"success": True}))
        r = self.post(body=utility())
        self.assertEqual(r.status_code, 201, r.content)
        call = self.meta.calls[0]
        self.assertEqual((call["method"], call["path"]), ("POST", row.meta_id))
        self.assertEqual(call["json"]["category"], "UTILITY")
        self.assertEqual(call["json"]["components"][0]["type"], "BODY")
        self.assertEqual(self.meta.created, [])
        row.refresh_from_db()
        self.assertEqual((row.status, row.rejected_reason), ("PENDING", ""))
        self.assertIn("Resubmitted", r.json()["message"])

    def _script_upload(self):
        self.meta.answer(Resp(200, {"id": "4455667788"}))
        self.meta.answer(Resp(200, {"id": "upload:MTphdHRhY2htZW50?sig=ARZ123"}))
        self.meta.answer(Resp(200, {"h": "4::aGVhZGVyLWhhbmRsZQ=="}))

    def test_a_document_template_uploads_a_sample_pdf_as_its_header_example(self):
        self._script_upload()
        r = self.post(body=utility(name="hrms_salary_slip", header="document", messageType="salary_slip"))
        self.assertEqual(r.status_code, 201, r.content)
        app, session, upload = self.meta.calls[:3]
        self.assertEqual((app["method"], app["path"]), ("GET", "app"))
        self.assertEqual((session["method"], session["path"]), ("POST", "4455667788/uploads"))
        self.assertEqual(session["params"]["file_type"], "application/pdf")
        self.assertTrue(upload["url"].endswith("/upload:MTphdHRhY2htZW50?sig=ARZ123"))
        self.assertEqual(upload["headers"], {"Authorization": f"OAuth {TOKEN}", "file_offset": "0"})
        self.assertTrue(upload["data"].startswith(b"%PDF"))
        self.assertEqual(session["params"]["file_length"], len(upload["data"]))
        header = self.meta.created[0]["components"][0]
        self.assertEqual(
            header, {"type": "HEADER", "format": "DOCUMENT", "example": {"header_handle": ["4::aGVhZGVyLWhhbmRsZQ=="]}}
        )
        self.assertNotIn(TOKEN, r.content.decode())

    @override_settings(WHATSAPP_CLOUD_APP_ID="99887766")
    def test_a_configured_app_id_skips_the_app_lookup(self):
        self.meta.answer(Resp(200, {"id": "upload:XYZ"}))
        self.meta.answer(Resp(200, {"h": "H1"}))
        r = self.post(body=utility(header="document"))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.meta.calls[0]["path"], "99887766/uploads")

    def test_an_image_template_uploads_a_sample_picture(self):
        self._script_upload()
        r = self.post(body=utility(name="hrms_id_card", header="image", messageType="id_card"))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.meta.calls[1]["params"]["file_type"], "image/png")
        self.assertTrue(self.meta.calls[2]["data"].startswith(b"\x89PNG"))
        self.assertEqual(self.meta.created[0]["components"][0]["format"], "IMAGE")

    def test_when_the_sample_cannot_be_uploaded_hr_is_told_to_use_whatsapp_manager(self):
        self.meta.fail(10, "Application does not have permission for this action", status=403)
        r = self.post(body=utility(header="document"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("WhatsApp Manager", r.json()["error"])
        self.assertEqual(self.meta.created, [])
        self.assertNotIn(TOKEN, r.content.decode())

    def test_an_upload_session_meta_did_not_open_is_never_followed(self):
        self.meta.answer(Resp(200, {"id": "4455667788"}))
        self.meta.answer(Resp(200, {"id": "https://evil.example/upload"}))
        r = self.post(body=utility(header="document"))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(len(self.meta.calls), 2)

    def test_the_code_template(self):
        self.meta.answer(Resp(200, {"id": "7788", "status": "APPROVED", "category": "AUTHENTICATION"}))
        with mock.patch.dict(catalog.TYPES, {"otp_login": _otp_spec()}):
            r = self.post(
                body={
                    "name": "hrms_otp",
                    "category": "AUTHENTICATION",
                    "codeExpirationMinutes": 5,
                    "messageType": "otp_login",
                }
            )
            self.assertEqual(r.status_code, 201, r.content)
            self.assertTrue(whatsapp_service.template_approved("otp_login"))
        sent = self.meta.calls[0]["json"]
        self.assertNotIn("parameter_format", sent)
        self.assertEqual(sent["category"], "AUTHENTICATION")
        self.assertEqual(sent["components"][1], {"type": "FOOTER", "code_expiration_minutes": 5})
        self.assertIn("Approved", r.json()["message"])
        self.assertEqual(r.json()["template"]["codeExpirationMinutes"], 5)

    def test_meta_reclassifying_the_category_is_reported(self):
        self.meta.answer(Resp(200, {"id": "1", "status": "PENDING", "category": "MARKETING"}))
        r = self.post(body=utility())
        self.assertIn("Marketing", r.json()["message"])
        self.assertEqual(WhatsAppTemplate.objects.get().category, "MARKETING")


@mock.patch("api.whatsapp_templates.upload_header_example", return_value="HANDLE")
class CreateMissingTests(TemplateBase):
    def results(self):
        r = self.post("create-missing")
        self.assertEqual(r.status_code, 200, r.content)
        return {row["type"]: row for row in r.json()["results"]}, r.json()

    def test_every_switched_on_type_without_a_template_is_submitted_once_per_name(self, _upload):
        results, body = self.results()
        s = WhatsAppSettings.get()
        on = [k for k in META_TYPES if templates.type_switched_on(k, s)]
        self.assertEqual(set(results), set(on))
        self.assertTrue(all(r["ok"] for r in results.values()), results)
        names = [p["name"] for p in self.meta.created]
        self.assertEqual(len(names), len(set(names)))  # a shared template (the codes') goes once
        self.assertEqual(set(names), {whatsapp_service.template_name_for(k) for k in on})
        self.assertEqual(body["created"], len(names))
        self.assertNotIn("absent_alert", results)  # switched off by default: not asked for
        self.assertTrue(WhatsAppTemplate.objects.filter(status="PENDING").count() >= len(names))

    def test_approved_and_pending_templates_are_left_alone(self, _upload):
        approve_templates("approval_approved")
        approve_templates("approval_rejected", status="PENDING")
        results, _ = self.results()
        self.assertNotIn("approval_approved", results)
        self.assertNotIn("approval_rejected", results)

    def test_a_rejected_template_is_reported_not_resubmitted_unchanged(self, _upload):
        name = catalog.get("approval_approved").default_template_name
        row = make_template(name, status="REJECTED")
        row.rejected_reason = "INVALID_FORMAT"
        row.save()
        results, _ = self.results()
        self.assertFalse(results["approval_approved"]["ok"])
        self.assertIn("INVALID_FORMAT", results["approval_approved"]["error"])
        self.assertIn("Edit it on Templates", results["approval_approved"]["error"])
        self.assertNotIn(name, [p["name"] for p in self.meta.created])

    def test_one_refusal_does_not_stop_the_others(self, _upload):
        self.meta.fail(100, "Invalid parameter")
        results, body = self.results()
        failed = [r for r in results.values() if not r["ok"]]
        self.assertEqual(len({r["name"] for r in failed}), 1)
        self.assertIn("Invalid parameter", failed[0]["error"])
        self.assertTrue(any(r["ok"] for r in results.values()))
        self.assertEqual(body["failed"], 1)

    def test_switching_a_type_off_leaves_it_out(self, _upload):
        s = WhatsAppSettings.get()
        s.document_notifications_enabled = False
        s.otp_enabled = False
        s.save()
        results, _ = self.results()
        self.assertFalse(set(results) & set(catalog.types_in("documents")))
        self.assertFalse(set(results) & set(catalog.types_in("otp")))

    @override_settings(**NO_META)
    def test_not_configured(self, _upload):
        r = self.post("create-missing")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.meta.calls, [])


class SyncTests(TemplateBase):
    def test_metas_templates_are_mirrored_and_what_meta_dropped_is_marked_deleted(self):
        late = catalog.get("late_alert").default_template_name
        make_template(late, status="PENDING")
        make_template("hrms_old_one", status="APPROVED")
        make_template("hrms_never_sent", status="DRAFT")
        self.meta.templates = [
            {
                "id": "111",
                "name": late,
                "language": "en",
                "status": "APPROVED",
                "category": "UTILITY",
                "components": [{"type": "BODY", "text": "Dear {{employee_name}}, you were late."}],
                "quality_score": {"score": "GREEN", "date": 1763600000},
                "rejected_reason": "NONE",
                "parameter_format": "NAMED",
            },
            {
                "id": "222",
                "name": "hrms_made_in_manager",
                "language": "en_US",
                "status": "REJECTED",
                "category": "MARKETING",
                "components": [],
                "rejected_reason": "PROMOTIONAL",
            },
        ]
        r = self.post("sync")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["synced"], body["created"], body["updated"], body["deleted"]), (2, 1, 1, 1))
        self.assertIn("2 templates read from Meta", body["message"])
        row = WhatsAppTemplate.objects.get(name=late)
        self.assertEqual(
            (row.status, row.meta_id, row.quality_score, row.rejected_reason), ("APPROVED", "111", "GREEN", "")
        )
        self.assertEqual(row.components[0]["text"], "Dear {{employee_name}}, you were late.")
        new = WhatsAppTemplate.objects.get(name="hrms_made_in_manager")
        self.assertEqual((new.language, new.status, new.rejected_reason), ("en_US", "REJECTED", "PROMOTIONAL"))
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_old_one").status, "DELETED")
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_never_sent").status, "DRAFT")
        self.assertTrue(whatsapp_service.template_approved("late_alert"))
        listed = {t["name"]: t for t in body["templates"]}
        self.assertEqual(listed[late]["messageTypes"], ["late_alert"])
        self.assertTrue(body["lastSyncedAt"])

    def test_a_new_template_learns_which_type_it_serves(self):
        name = catalog.get("absent_alert").default_template_name
        self.meta.templates = [{"id": "1", "name": name, "language": "en", "status": "PENDING", "category": "UTILITY"}]
        self.post("sync")
        self.assertEqual(WhatsAppTemplate.objects.get(name=name).message_type, "absent_alert")

    def test_metas_refusal_changes_nothing(self):
        make_template("hrms_kept", status="APPROVED")
        self.meta.fail(190, "Error validating access token", status=401)
        r = self.post("sync")
        self.assertEqual(r.status_code, 400)
        self.assertIn("access token", r.json()["error"])
        self.assertEqual(WhatsAppTemplate.objects.get(name="hrms_kept").status, "APPROVED")

    @override_settings(**NO_META)
    def test_not_configured(self):
        self.assertEqual(self.post("sync").status_code, 400)
        self.assertEqual(self.meta.calls, [])


class DeleteTests(TemplateBase):
    def test_deleted_at_meta_by_its_id_and_here(self):
        name = catalog.get("late_alert").default_template_name
        row = make_template(name, status="APPROVED")
        r = self.delete(row.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.meta.deleted, [{"name": name, "hsm_id": row.meta_id}])
        self.assertFalse(WhatsAppTemplate.objects.filter(pk=row.pk).exists())
        body = r.json()
        self.assertEqual(body["messageTypes"], ["late_alert"])
        self.assertIn("skipped", body["message"])

    def test_a_template_meta_never_had_is_removed_here_only(self):
        for status in ("DRAFT", "DELETED"):
            row = make_template(f"hrms_{status.lower()}", status=status)
            self.assertEqual(self.delete(row.id).status_code, 200)
        self.assertEqual(self.meta.calls, [])
        self.assertFalse(WhatsAppTemplate.objects.exists())

    def test_already_gone_at_meta_is_fine(self):
        row = make_template("hrms_gone", status="APPROVED")
        self.meta.fail(100, "Message template not found", status=404)
        self.assertEqual(self.delete(row.id).status_code, 200)
        self.assertFalse(WhatsAppTemplate.objects.exists())

    def test_metas_refusal_keeps_the_row(self):
        row = make_template("hrms_kept", status="APPROVED")
        self.meta.fail(200, "Permissions error", status=403)
        r = self.delete(row.id)
        self.assertEqual(r.status_code, 400)
        self.assertTrue(WhatsAppTemplate.objects.filter(pk=row.pk).exists())

    def test_without_metas_id_a_name_in_two_languages_is_not_deleted_blindly(self):
        row = make_template("hrms_two", status="APPROVED")
        make_template("hrms_two", status="APPROVED", language="ta")
        WhatsAppTemplate.objects.filter(pk=row.pk).update(meta_id="")
        r = self.delete(row.id)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Sync now", r.json()["error"])
        self.assertEqual(self.meta.calls, [])

    def test_unknown_id(self):
        self.assertEqual(self.delete(999999).status_code, 404)


class ListTests(TemplateBase):
    def test_lists_templates_with_the_types_using_them(self):
        late = catalog.get("late_alert").default_template_name
        make_template(late, status="APPROVED", components=[{"type": "BODY", "text": "Hi {{employee_name}}, late."}])
        make_template("hrms_custom", status="PENDING")
        s = WhatsAppSettings.get()
        s.template_overrides = {"absent_alert": "hrms_custom"}
        s.save()
        body = self.get().json()
        rows = {t["name"]: t for t in body["templates"]}
        self.assertEqual(rows[late]["messageTypes"], ["late_alert"])
        self.assertEqual(rows["hrms_custom"]["messageTypes"], ["absent_alert"])
        self.assertEqual(rows[late]["variables"], ["employee_name"])
        self.assertEqual(rows[late]["body"], "Hi {{employee_name}}, late.")
        self.assertTrue(body["configured"])
        self.assertEqual(body["language"], "en")
        self.assertNotIn(TOKEN, str(body))


class AccessTests(TemplateBase):
    def test_hr_only(self):
        self.assertEqual(self.client.get(BASE).status_code, 401)
        self.assertEqual(self.client.post(f"{BASE}/sync").status_code, 401)

    def test_a_view_role_reads_but_cannot_submit_sync_or_delete(self):
        role = Role.objects.create(name="Viewer", permissions={"whatsapp_control": "view"})
        _user, viewer = _hr("tpl_viewer", super_admin=False, role=role)
        row = make_template("hrms_x", status="APPROVED")
        self.assertEqual(self.get(headers=viewer).status_code, 200)
        self.assertEqual(self.get("draft/late_alert", headers=viewer).status_code, 200)
        self.assertEqual(self.post(body=utility(), headers=viewer).status_code, 403)
        self.assertEqual(self.post("sync", headers=viewer).status_code, 403)
        self.assertEqual(self.post("create-missing", headers=viewer).status_code, 403)
        self.assertEqual(self.delete(row.id, headers=viewer).status_code, 403)
        self.assertEqual(self.meta.calls, [])

    def test_an_edit_role_can(self):
        role = Role.objects.create(name="Editor", permissions={"whatsapp_control": "edit"})
        _user, editor = _hr("tpl_editor", super_admin=False, role=role)
        self.assertEqual(self.post(body=utility(), headers=editor).status_code, 201)
