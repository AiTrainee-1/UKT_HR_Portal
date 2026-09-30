"""HR / software-support contacts: Settings -> HR Contact, and the public endpoint the employee apps read."""

from django.test import TestCase, override_settings

from .jwt_utils import sign_token
from .models import Branch, HRUser, PayrollSettings, Role
from .permission_registry import MODULE_TREE
from .support_contact_views import FIELDS

PUBLIC = "/api/support-contact"
SETTINGS = "/api/payroll-settings"

FULL = {
    "hrContactName": "People Team",
    "hrContactPhone": "0421 430 0800",
    "hrContactWhatsapp": "98765 43210",
    "hrContactEmail": "hr@uktex.net",
    "hrContactHours": "Mon-Sat, 9:00 AM - 6:00 PM",
    "supportContactName": "IT Desk",
    "supportContactPhone": "+91 99999 11111",
    "supportContactWhatsapp": "",
    "supportContactEmail": "it@uktex.net",
    "supportContactHours": "Every day, 8 AM - 10 PM",
    "contactNote": "HR office: first floor, admin block.",
}


def _hr(username="sc_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class ContactBase(TestCase):
    def setUp(self):
        self.admin = _hr()

    def put(self, body, headers=None):
        return self.client.put(SETTINGS, body, content_type="application/json", **(headers or self.admin))

    def save(self, **overrides):
        r = self.put({**FULL, **overrides})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def public(self, **headers):
        return self.client.get(PUBLIC, **headers)

    def row(self):
        return PayrollSettings.get()


class PublicEndpointTests(ContactBase):
    def test_it_needs_no_login_and_ignores_a_bad_token(self):
        self.assertEqual(self.public().status_code, 200)
        # The apps sign out on any 401, so a stale token must never turn this into one.
        self.assertEqual(self.public(HTTP_AUTHORIZATION="Bearer not.a.real.token").status_code, 200)
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': 1})}"}
        self.assertEqual(self.public(**emp).status_code, 200)

    def test_it_is_read_only(self):
        for method in ("post", "put", "patch", "delete"):
            r = getattr(self.client, method)(PUBLIC, {"hrContactPhone": "9876543210"}, content_type="application/json")
            self.assertEqual(r.status_code, 405, method)
        self.assertEqual(self.row().hr_contact_phone, "")

    def test_nothing_set_yet_is_reported_as_not_configured(self):
        body = self.public().json()
        self.assertFalse(body["configured"])
        self.assertEqual(body["hr"]["label"], "HR Department")
        self.assertEqual(body["support"]["label"], "Software Support")
        self.assertFalse(body["hr"]["hasContact"] or body["support"]["hasContact"])
        self.assertEqual(body["note"], "")

    def test_it_answers_with_fresh_data_every_time(self):
        self.assertEqual(self.public()["Cache-Control"], "no-store")

    def test_saved_details_come_back_with_ready_to_use_link_fields(self):
        self.save()
        body = self.public().json()
        self.assertTrue(body["configured"])
        hr = body["hr"]
        self.assertEqual(
            (hr["label"], hr["phone"], hr["phoneDial"], hr["email"], hr["hours"], hr["hasContact"]),
            ("People Team", "0421 430 0800", "04214300800", "hr@uktex.net", "Mon-Sat, 9:00 AM - 6:00 PM", True),
        )
        # wa.me needs the international number: the country code is added to a local one.
        self.assertEqual((hr["whatsapp"], hr["whatsappNumber"]), ("98765 43210", "919876543210"))
        support = body["support"]
        self.assertEqual(
            (support["label"], support["phone"], support["phoneDial"]), ("IT Desk", "+91 99999 11111", "+919999911111")
        )
        self.assertEqual((support["whatsapp"], support["whatsappNumber"]), ("", ""))
        self.assertFalse(support["usesHrFallback"])
        self.assertEqual(body["note"], "HR office: first floor, admin block.")
        self.assertEqual(body["companyName"], PayrollSettings.get().company_name)

    @override_settings(WHATSAPP_DEFAULT_COUNTRY_CODE="44")
    def test_the_whatsapp_country_code_follows_the_server_setting(self):
        self.save(hrContactWhatsapp="7911 123456")
        self.assertEqual(self.public().json()["hr"]["whatsappNumber"], "447911123456")

    def test_a_number_that_already_has_its_country_code_is_not_prefixed_twice(self):
        self.save(hrContactWhatsapp="+91 98765 43210")
        self.assertEqual(self.public().json()["hr"]["whatsappNumber"], "919876543210")

    def test_software_support_falls_back_to_hr_when_it_has_nothing_of_its_own(self):
        self.save(
            supportContactName="IT Desk",
            supportContactPhone="",
            supportContactWhatsapp="",
            supportContactEmail="",
            supportContactHours="",
        )
        support = self.public().json()["support"]
        self.assertTrue(support["usesHrFallback"])
        self.assertEqual(
            (support["label"], support["phone"], support["email"]), ("People Team", "0421 430 0800", "hr@uktex.net")
        )

    def test_a_support_contact_with_only_an_email_is_still_its_own_contact(self):
        self.save(supportContactPhone="", supportContactEmail="it@uktex.net")
        support = self.public().json()["support"]
        self.assertFalse(support["usesHrFallback"])
        self.assertEqual((support["label"], support["email"], support["phoneDial"]), ("IT Desk", "it@uktex.net", ""))

    def test_no_contact_at_all_gives_no_fallback_to_show(self):
        self.save(**{k: "" for k in FIELDS if k not in ("hrContactName", "supportContactName")})
        body = self.public().json()
        self.assertFalse(body["configured"])
        self.assertFalse(body["support"]["hasContact"] or body["support"]["usesHrFallback"])

    def test_a_blank_name_shows_the_default_label(self):
        self.save(hrContactName="   ", supportContactName="")
        body = self.public().json()
        self.assertEqual((body["hr"]["label"], body["support"]["label"]), ("HR Department", "Software Support"))

    def test_nothing_else_from_settings_is_published(self):
        self.save()
        PayrollSettings.objects.filter(pk=1).update(smtp_password="app-password-1234", smtp_username="hr@gmail.com")
        raw = self.public().content.decode()
        self.assertNotIn("app-password-1234", raw)
        self.assertNotIn("smtp", raw.lower())
        body = self.public().json()
        self.assertEqual(set(body), {"hr", "support", "note", "companyName", "configured", "updatedAt"})
        self.assertEqual(
            set(body["hr"]),
            {
                "label",
                "phone",
                "phoneDial",
                "whatsapp",
                "whatsappNumber",
                "email",
                "hours",
                "hasContact",
                "usesHrFallback",
            },
        )


class SavingTests(ContactBase):
    def test_all_eleven_fields_save_and_come_back_from_the_settings_api(self):
        body = self.save()
        for key, value in FULL.items():
            self.assertEqual(body[key], value, key)
        self.assertEqual(self.client.get(SETTINGS, **self.admin).json()["hrContactEmail"], "hr@uktex.net")
        self.assertEqual(len(FIELDS), 11)

    def test_the_new_columns_start_out_blank_with_friendly_default_names(self):
        body = self.client.get(SETTINGS, **self.admin).json()
        self.assertEqual((body["hrContactName"], body["supportContactName"]), ("HR Department", "Software Support"))
        for key in FIELDS:
            if key not in ("hrContactName", "supportContactName"):
                self.assertEqual(body[key], "", key)

    def test_saving_contacts_leaves_every_other_setting_alone(self):
        ps = self.row()
        ps.company_name, ps.smtp_host = "Acme Mills", "smtp.example.test"
        ps.save()
        self.save()
        ps = self.row()
        self.assertEqual((ps.company_name, ps.smtp_host), ("Acme Mills", "smtp.example.test"))

    def test_saving_other_settings_leaves_the_contacts_alone(self):
        self.save()
        self.assertEqual(self.put({"companyTagline": "Fine cloth"}).status_code, 200)
        self.assertEqual(self.row().hr_contact_phone, "0421 430 0800")

    def test_blank_and_null_clear_a_field(self):
        self.save()
        self.save(hrContactPhone="", hrContactEmail=None, contactNote="   ")
        ps = self.row()
        self.assertEqual((ps.hr_contact_phone, ps.hr_contact_email, ps.contact_note), ("", "", ""))

    def test_text_is_tidied_but_never_changed_in_meaning(self):
        self.save(
            hrContactName="  People \t Team  ", hrContactHours="Mon-Sat\n9 to 6", contactNote="  Line one\nLine two  "
        )
        ps = self.row()
        self.assertEqual(ps.hr_contact_name, "People Team")
        self.assertEqual(ps.hr_contact_hours, "Mon-Sat 9 to 6")
        self.assertEqual(ps.contact_note, "Line one\nLine two")  # the note keeps its line breaks

    def test_valid_phone_formats(self):
        for phone in (
            "0421 430 0800",
            "+91 98765 43210",
            "(0421) 430-0800",
            "98765.43210",
            "9876543210",
            "+44 20 7946 0958",
        ):
            self.assertEqual(self.put({"hrContactPhone": phone}).status_code, 200, phone)
            self.assertEqual(self.row().hr_contact_phone, phone)

    def test_invalid_phone_numbers_are_refused(self):
        for phone in (
            "12345",
            "abcdefghij",
            "98765 43210 / 98765 43211",
            "9876543210, 9876543211",
            "98+76543210",
            "+91 98765 43210 12345",
            "call me",
            "<script>",
        ):
            r = self.put({"hrContactPhone": phone})
            self.assertEqual(r.status_code, 400, phone)
            self.assertIn("HR phone number must be one phone number", r.json()["error"])
        self.assertEqual(self.row().hr_contact_phone, "")

    def test_the_whatsapp_and_support_numbers_are_checked_too(self):
        for key, label in (
            ("hrContactWhatsapp", "HR WhatsApp number"),
            ("supportContactPhone", "Software support phone number"),
            ("supportContactWhatsapp", "Software support WhatsApp number"),
        ):
            r = self.put({key: "not a number"})
            self.assertEqual(r.status_code, 400, key)
            self.assertIn(label, r.json()["error"])

    def test_invalid_emails_are_refused(self):
        for email in (
            "hr",
            "hr@",
            "hr@uktex",
            "@uktex.net",
            "hr uktex@x.net",
            "a@b.co, c@d.co",
            "<hr@uktex.net>",
            "hr@uktex.net\nBcc: x@y.co",
        ):
            r = self.put({"hrContactEmail": email})
            self.assertEqual(r.status_code, 400, repr(email))
            self.assertIn("valid email", r.json()["error"])
        self.assertEqual(self.put({"supportContactEmail": "nope"}).status_code, 400)

    def test_length_limits(self):
        cases = (
            ("hrContactName", 80, "x" * 80),
            ("hrContactPhone", 30, "-" * 15 + "1" * 15),  # 30 characters, 15 digits: valid, and one more is too long
            ("hrContactEmail", 120, "a@" + "b" * 114 + ".com"),
            ("supportContactHours", 120, "x" * 120),
            ("contactNote", 500, "x" * 500),
        )
        for key, limit, value in cases:
            self.assertEqual(len(value), limit, key)
            self.assertEqual(self.put({key: value}).status_code, 200, key)
            r = self.put({key: value + ("1" if "Phone" in key else "x")})
            self.assertEqual(r.status_code, 400, key)
            self.assertIn(f"at most {limit}", r.json()["error"])

    def test_only_text_is_accepted(self):
        for value in (5, 1.5, True, ["a"], {"a": 1}):
            r = self.put({"hrContactName": value})
            self.assertEqual(r.status_code, 400, repr(value))
            self.assertIn("must be text", r.json()["error"])

    def test_control_characters_are_refused(self):
        r = self.put({"hrContactName": "Bad\x00Name"})
        self.assertEqual(r.status_code, 400)

    def test_a_bad_field_saves_nothing_from_the_same_request(self):
        r = self.put({"hrContactName": "Should Not Stick", "hrContactPhone": "0421 430 0800", "hrContactEmail": "nope"})
        self.assertEqual(r.status_code, 400)
        ps = self.row()
        self.assertEqual((ps.hr_contact_name, ps.hr_contact_phone), ("HR Department", ""))

    def test_a_save_is_written_to_the_activity_log(self):
        from .models import AuditLog

        self.save()
        self.assertTrue(
            AuditLog.objects.filter(module="settings", record_description__icontains="settings updated").exists()
        )


class PermissionTests(ContactBase):
    def login(self, name, permissions, branch=None):
        role = Role.objects.create(name=name, permissions=permissions)
        return _hr(name.lower().replace(" ", "_"), super_admin=False, role=role, branch=branch)

    def test_hr_contact_is_its_own_settings_section_in_the_permission_list(self):
        settings_node = next(n for n in MODULE_TREE if n["key"] == "settings")
        keys = [c["key"] for c in settings_node["children"]]
        self.assertIn("settings.hr_contact", keys)
        self.assertEqual(keys.index("settings.hr_contact"), keys.index("settings.company") + 1)

    def test_edit_on_hr_contact_alone_can_change_the_contacts(self):
        who = self.login("Contacts Editor", {"settings.hr_contact": "edit"})
        self.assertEqual(self.put({"hrContactPhone": "0421 430 0800"}, who).status_code, 200)
        self.assertEqual(self.row().hr_contact_phone, "0421 430 0800")

    def test_edit_on_the_whole_settings_module_covers_it_too(self):
        who = self.login("Settings Editor", {"settings": "edit"})
        self.assertEqual(self.put({"hrContactPhone": "0421 430 0800"}, who).status_code, 200)

    def test_company_edit_alone_does_not_reach_the_contacts(self):
        who = self.login("Company Editor", {"settings.company": "edit"})
        r = self.put({"hrContactPhone": "0421 430 0800"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "permission_denied")
        self.assertEqual(r.json()["fields"], ["hrContactPhone"])
        self.assertEqual(self.row().hr_contact_phone, "")
        # ...and the other way round: HR Contact edit does not open the Company tab.
        contacts_only = self.login("Contacts Only", {"settings.hr_contact": "edit"})
        self.assertEqual(self.put({"companyName": "Hijacked"}, contacts_only).status_code, 403)

    def test_view_only_can_read_but_not_write(self):
        who = self.login("Contacts Viewer", {"settings.hr_contact": "view"})
        self.save()
        self.assertEqual(self.client.get(SETTINGS, **who).json()["hrContactPhone"], "0421 430 0800")
        self.assertEqual(self.put({"hrContactPhone": "9999999999"}, who).status_code, 403)
        self.assertEqual(self.row().hr_contact_phone, "0421 430 0800")

    def test_a_branch_login_can_see_the_contacts_but_they_stay_company_wide(self):
        north = Branch.objects.create(name="North")
        who = self.login("North HR", {"settings.hr_contact": "edit"}, branch=north)
        self.save()
        seen = self.client.get(SETTINGS, **who).json()
        self.assertEqual(seen["hrContactPhone"], "0421 430 0800")
        self.assertFalse(seen["companyWideRulesEditable"])
        r = self.put({"hrContactPhone": "9999999999"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "company_wide_contact")
        self.assertEqual(r.json()["fields"], ["hrContactPhone"])
        # Nothing landed in a private branch copy either: what employees see is unchanged.
        self.assertEqual(self.public().json()["hr"]["phone"], "0421 430 0800")
        self.assertEqual(self.client.get(SETTINGS, **who).json()["hrContactPhone"], "0421 430 0800")

    def test_a_branch_login_can_still_save_other_settings_it_is_allowed_to(self):
        north = Branch.objects.create(name="North")
        who = self.login("North Company", {"settings.company": "edit"}, branch=north)
        self.assertEqual(self.put({"companyTagline": "North branch"}, who).status_code, 200)

    def test_a_branch_login_sending_contacts_alongside_other_fields_saves_none_of_them(self):
        north = Branch.objects.create(name="North")
        who = self.login("North All", {"settings": "edit"}, branch=north)
        r = self.put({"companyTagline": "North branch", "hrContactPhone": "9999999999"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertNotEqual(PayrollSettings.get().company_tagline, "North branch")

    def test_the_settings_api_still_needs_a_login_to_write(self):
        r = self.client.put(SETTINGS, {"hrContactPhone": "0421 430 0800"}, content_type="application/json")
        self.assertEqual(r.status_code, 401)
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': 1})}"}
        r = self.client.put(SETTINGS, {"hrContactPhone": "0421 430 0800"}, content_type="application/json", **emp)
        self.assertEqual(r.status_code, 403)
