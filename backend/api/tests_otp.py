"""
One-time codes by WhatsApp: sign-in, password reset, activation, and the rules shared by both channels.

No WhatsApp provider is involved: WhatsAppOtpMixin makes WhatsApp able to deliver codes (configured, master switch on, the
AUTHENTICATION template -`hrms_otp`- APPROVED) and fakes the ONE call that sends a code (otp_service._send_whatsapp_code),
recording what it was given. How that call reaches Meta is whatsapp_service's business (its own tests). The SMS channel:
tests_sms_otp.py; both channels together: tests_otp_channels.py.
"""

from datetime import timedelta
from unittest import mock

import bcrypt
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone

from . import otp_service
from .jwt_utils import verify_token
from .models import Employee, EmployeeOtp, SmsSettings, WhatsAppSettings, WhatsAppTemplate


def set_whatsapp_template(status="APPROVED", purpose=None):
    """The Meta template(s) WhatsApp codes go out as (for one purpose, or all three: the catalog names one shared
    template), with this review status (None: no template)."""
    purposes = [purpose] if purpose else ["login", "reset", "activate"]
    names = sorted({otp_service.whatsapp_template_name(p) for p in purposes})
    for name in names:
        if status is None:
            WhatsAppTemplate.objects.filter(name=name).delete()
        else:
            WhatsAppTemplate.objects.update_or_create(
                name=name, language="en", defaults={"status": status, "category": "AUTHENTICATION"}
            )
    return names


def whatsapp_settings(**values):
    WhatsAppSettings.get()
    WhatsAppSettings.objects.filter(pk=1).update(**values)


def sms_settings(**values):
    SmsSettings.get()
    SmsSettings.objects.filter(pk=1).update(**values)


class WhatsAppOtpMixin:
    """WhatsApp can deliver codes (configured, master switch on, template approved) and the one send call is faked:
    self.whatsapp_sent lists what it was given; self.whatsapp_ok decides whether WhatsApp "accepted" it."""

    def setUp(self):
        super().setUp()
        self.whatsapp_sent = []
        self.whatsapp_ok = True
        self.whatsapp_configured = True
        for target, kwargs in (
            ("api.whatsapp_service.is_configured", {"side_effect": lambda: self.whatsapp_configured}),
            ("api.otp_service._send_whatsapp_code", {"side_effect": self._fake_whatsapp_send}),
        ):
            patcher = mock.patch(target, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        set_whatsapp_template("APPROVED")

    def _fake_whatsapp_send(self, employee, purpose, code, minutes, phone):
        self.whatsapp_sent.append(
            {"employee": employee.employee_code, "purpose": purpose, "code": code, "minutes": minutes, "phone": phone}
        )
        return self.whatsapp_ok


class OtpBase(WhatsAppOtpMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()  # the per-IP throttles count in the cache: no test may inherit another's requests
        self.addCleanup(cache.clear)
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="Kumar", phone="82200 15110", status="active"
        )

    def post(self, path, body):
        return self.client.post(f"/api/auth/{path}", body, content_type="application/json")

    def request_code(self, code="E100", purpose="login", ok=True, channel=None):
        """Ask for a code and return (response, the code that was WhatsApped or None)."""
        self.whatsapp_ok = ok
        before = len(self.whatsapp_sent)
        body = {"employeeCode": code, "purpose": purpose}
        if channel is not None:
            body["channel"] = channel
        r = self.post("otp/request", body)
        sent = self.whatsapp_sent[before:]
        return r, (sent[-1]["code"] if sent else None)

    def age_last_otp(self, seconds):
        """Pretend the newest OTP was created `seconds` ago (to get past the resend cooldown)."""
        EmployeeOtp.objects.filter(pk=EmployeeOtp.objects.order_by("-created_at").first().pk).update(
            created_at=timezone.now() - timedelta(seconds=seconds)
        )

    def options(self):
        return self.client.get("/api/auth/login-options").json()


class LoginOptionsTests(OtpBase):
    def test_reports_what_is_switched_on(self):
        r = self.client.get("/api/auth/login-options")
        self.assertEqual(r["Cache-Control"], "no-store")  # a switch flipped by HR reaches the apps at once
        self.assertEqual(
            r.json(),
            {
                "otpLogin": True,
                "otpReset": True,
                "otpActivate": True,
                "passwordLogin": True,
                "otpChannel": "whatsapp",
                "codeLength": 6,
                "otpChannels": {"login": ["whatsapp"], "reset": ["whatsapp"], "activate": ["whatsapp"]},
                "channels": {"whatsapp": {"name": "WhatsApp", "codeLength": 6}},
            },
        )

    def test_otp_is_not_advertised_when_whatsapp_cannot_deliver(self):
        for why, undo in (
            ("not configured", lambda on: setattr(self, "whatsapp_configured", on)),
            ("master switch off", lambda on: whatsapp_settings(engine_enabled=on)),
            ("WhatsApp codes off", lambda on: whatsapp_settings(otp_enabled=on)),
        ):
            with self.subTest(why):
                undo(False)
                body = self.options()
                self.assertEqual((body["otpLogin"], body["otpReset"], body["otpActivate"]), (False, False, False))
                self.assertEqual((body["otpChannel"], body["codeLength"], body["channels"]), (None, 6, {}))
                self.assertTrue(body["passwordLogin"])
                undo(True)
                self.assertTrue(self.options()["otpLogin"])

    def test_the_authentication_template_must_be_approved_by_meta(self):
        for status in ("PENDING", "REJECTED", "PAUSED", "DRAFT", None):
            with self.subTest(status=status):
                set_whatsapp_template(status)
                self.assertEqual(self.options()["otpChannels"]["login"], [])
        set_whatsapp_template("approved")  # Meta's spelling of the status is not trusted to be upper case
        self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp"])

    def test_the_template_is_the_catalogs_unless_hr_picked_another_one(self):
        from . import whatsapp_catalog

        self.assertEqual(otp_service.WHATSAPP_OTP_TEMPLATE, "hrms_otp")
        for purpose, key in (("login", "otp_login"), ("reset", "otp_reset"), ("activate", "otp_activate")):
            # the same name whatsapp_service sends the code as (the catalog names `hrms_otp` for all three)
            self.assertEqual(
                otp_service.whatsapp_template_name(purpose), whatsapp_catalog.get(key).default_template_name
            )
        whatsapp_settings(template_overrides={"otp_login": "my_login_code"})
        self.assertEqual(otp_service.whatsapp_template_name("login"), "my_login_code")
        self.assertEqual(self.options()["otpChannels"]["login"], [])  # the chosen one is not approved
        self.assertEqual(self.options()["otpChannels"]["reset"], ["whatsapp"])
        WhatsAppTemplate.objects.create(name="my_login_code", language="en_US", status="APPROVED")
        self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp"])
        self.assertEqual(otp_service.whatsapp_template("login").language, "en_US")

    def test_password_login_can_be_switched_off_only_while_otp_really_works(self):
        whatsapp_settings(password_login_enabled=False)
        self.assertFalse(self.options()["passwordLogin"])
        # OTP unavailable -> never lock everyone out.
        self.whatsapp_configured = False
        self.assertTrue(self.options()["passwordLogin"])

    def test_switching_off_otp_hides_it(self):
        whatsapp_settings(otp_login_enabled=False)
        body = self.options()
        self.assertFalse(body["otpLogin"])
        self.assertEqual(body["otpChannels"], {"login": [], "reset": ["whatsapp"], "activate": ["whatsapp"]})
        self.assertEqual(body["otpChannel"], "whatsapp")  # older apps: the first channel of any purpose


class RequestOtpTests(OtpBase):
    def test_sends_a_six_digit_code_to_the_registered_number_and_masks_it(self):
        r, code = self.request_code()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {
                "message": "We've sent a code to your WhatsApp.",
                "maskedPhone": "•" * 8 + "5110",
                "expiresInSeconds": 300,
                "resendAfterSeconds": 60,
                "channel": "whatsapp",
                "codeLength": 6,
                "otherChannels": [],
            },
        )
        self.assertRegex(code, r"^\d{6}$")
        self.assertEqual(
            self.whatsapp_sent,
            [{"employee": "E100", "purpose": "login", "code": code, "minutes": 5, "phone": "918220015110"}],
        )
        self.assertNotIn("8220015110", r.content.decode())
        self.assertNotIn(code, r.content.decode())
        self.assertEqual(EmployeeOtp.objects.get().channel, "whatsapp")

    def test_employee_code_is_case_insensitive(self):
        self.assertEqual(self.request_code("e100")[0].status_code, 200)

    def test_the_code_is_never_stored_only_a_hash(self):
        _, code = self.request_code()
        row = EmployeeOtp.objects.get()
        self.assertNotIn(code, row.code_hash)
        self.assertNotEqual(row.code_hash, code)
        self.assertIn("$", row.code_hash)

    def test_unknown_inactive_and_phoneless_employees_are_refused_without_sending(self):
        Employee.objects.create(
            employee_code="E200", first_name="Gone", last_name="X", phone="9000000000", status="resigned"
        )
        Employee.objects.create(employee_code="E300", first_name="No", last_name="Phone", phone="", status="active")
        for code, status in (("NOPE", 404), ("E200", 403), ("E300", 400), ("", 400)):
            r, sent = self.request_code(code)
            self.assertEqual(r.status_code, status, code)
            self.assertIsNone(sent)
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_refused_when_the_feature_is_off_or_whatsapp_cannot_deliver(self):
        whatsapp_settings(otp_login_enabled=False)
        r, _ = self.request_code()
        self.assertEqual((r.status_code, r.json()["code"]), (403, "otp_off"))
        self.assertEqual(r.json()["error"], "One-time codes are turned off. Please use your password or contact HR.")
        whatsapp_settings(otp_login_enabled=True)
        self.whatsapp_configured = False
        r, _ = self.request_code()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"], "WhatsApp OTP isn't available right now. Please contact HR.")
        self.assertEqual(self.whatsapp_sent, [])

    def test_reset_and_login_switches_are_independent(self):
        whatsapp_settings(otp_reset_enabled=False)
        self.assertEqual(self.request_code(purpose="reset")[0].status_code, 403)
        self.assertEqual(self.request_code(purpose="login")[0].status_code, 200)

    def test_unknown_purpose_is_rejected(self):
        self.assertEqual(self.request_code(purpose="admin")[0].status_code, 400)

    def test_a_send_failure_invalidates_the_code_and_does_not_use_up_the_allowance(self):
        r, _ = self.request_code(ok=False)
        self.assertEqual(r.status_code, 502)
        self.assertEqual(
            r.json()["error"], "We couldn't send the code on WhatsApp. Please try again in a moment or contact HR."
        )
        self.assertFalse(EmployeeOtp.objects.exists())
        # ...so they can try again straight away
        self.assertEqual(self.request_code()[0].status_code, 200)

    def test_a_failed_send_leaves_the_previous_valid_code_alone(self):
        """The old code used to be consumed BEFORE the send, so a failed send killed a valid code. Now the new row is
        created first, the old codes are consumed only after the send succeeded, and a failure deletes the new row."""
        _, old = self.request_code()
        self.age_last_otp(61)
        r, _ = self.request_code(ok=False)
        self.assertEqual(r.status_code, 502)
        self.assertEqual(EmployeeOtp.objects.count(), 1)
        self.assertIsNone(EmployeeOtp.objects.get().consumed_at)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": old}).status_code, 200)

    def test_the_previous_code_is_consumed_only_after_the_send_succeeded(self):
        _, first = self.request_code()
        self.age_last_otp(61)
        seen = {}
        real_send = self._fake_whatsapp_send

        def during_send(*args, **kwargs):
            seen["unconsumed"] = EmployeeOtp.objects.filter(consumed_at__isnull=True).count()
            return real_send(*args, **kwargs)

        with mock.patch("api.otp_service._send_whatsapp_code", side_effect=during_send):
            r, second = self.request_code()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(seen["unconsumed"], 2)  # in flight: the old code is untouched
        self.assertEqual(EmployeeOtp.objects.filter(consumed_at__isnull=True).count(), 1)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": first}).status_code, 400)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": second}).status_code, 200)

    def test_resend_cooldown(self):
        self.assertEqual(self.request_code()[0].status_code, 200)
        r, _ = self.request_code()
        self.assertEqual(r.status_code, 429)
        self.assertIn("retryAfterSeconds", r.json())
        self.age_last_otp(61)
        self.assertEqual(self.request_code()[0].status_code, 200)

    def test_hourly_cap(self):
        for _ in range(5):
            self.assertEqual(self.request_code()[0].status_code, 200)
            self.age_last_otp(120)
        r, _ = self.request_code()
        self.assertEqual(r.status_code, 429)
        self.assertNotIn("retryAfterSeconds", r.json())

    def test_a_new_request_kills_the_previous_code(self):
        _, first = self.request_code()
        self.age_last_otp(61)
        _, second = self.request_code()
        self.assertNotEqual(first, second)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": first}).status_code, 400)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": second}).status_code, 200)

    def test_the_expiry_is_whatsapps_own_setting(self):
        whatsapp_settings(otp_expiry_minutes=9)
        sms_settings(otp_expiry_minutes=2)  # the SMS Control value is not WhatsApp's business
        r, _ = self.request_code()
        self.assertEqual(r.json()["expiresInSeconds"], 540)
        self.assertEqual(self.whatsapp_sent[-1]["minutes"], 9)


class OtpLoginTests(OtpBase):
    def test_the_right_code_signs_in_and_the_token_works(self):
        _, code = self.request_code()
        r = self.post("otp/login", {"employeeCode": "E100", "otp": code})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["role"], body["employeeId"], body["name"]), ("employee", self.emp.id, "Asha Kumar"))
        claims = verify_token(body["token"])
        self.assertEqual((claims["role"], claims["employeeId"]), ("employee", self.emp.id))
        me = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {body['token']}")
        self.assertEqual(me.status_code, 200)
        self.emp.refresh_from_db()
        self.assertIsNotNone(self.emp.last_mobile_login_at)

    def test_works_for_an_employee_who_never_set_a_password(self):
        self.assertFalse(self.emp.password_hash)
        _, code = self.request_code()
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 200)

    def test_a_code_works_once(self):
        _, code = self.request_code()
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 200)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)

    def test_an_expired_code_is_rejected(self):
        _, code = self.request_code()
        EmployeeOtp.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        r = self.post("otp/login", {"employeeCode": "E100", "otp": code})
        self.assertEqual(r.status_code, 400)
        self.assertIn("expired", r.json()["error"])

    def test_expiry_follows_the_setting(self):
        whatsapp_settings(otp_expiry_minutes=10)
        r, _ = self.request_code()
        self.assertEqual(r.json()["expiresInSeconds"], 600)
        delta = EmployeeOtp.objects.get().expires_at - timezone.now()
        self.assertAlmostEqual(delta.total_seconds(), 600, delta=5)

    def test_wrong_codes_are_rejected_with_one_generic_message(self):
        _, code = self.request_code()
        wrong = "000000" if code != "000000" else "111111"
        for body in ({"employeeCode": "E100", "otp": wrong}, {"employeeCode": "NOBODY", "otp": wrong}):
            r = self.post("otp/login", body)
            self.assertEqual(r.status_code, 400)
            self.assertIn("incorrect or has expired", r.json()["error"])

    def test_malformed_codes_are_rejected_before_any_lookup(self):
        self.request_code()
        for otp in ("", "12345", "1234567", "abcdef", None):
            r = self.post("otp/login", {"employeeCode": "E100", "otp": otp})
            self.assertEqual(r.status_code, 400, otp)
            self.assertEqual(r.json()["error"], "Enter the 6-digit code.", otp)  # only WhatsApp is available
        self.assertEqual(EmployeeOtp.objects.get().attempts, 0)

    def test_five_wrong_guesses_lock_the_code_even_against_the_right_one(self):
        _, code = self.request_code()
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": wrong}).status_code, 400)
        # The counter must have been *saved* (regression: raising inside the transaction rolled it back).
        self.assertEqual(EmployeeOtp.objects.get().attempts, 5)
        r = self.post("otp/login", {"employeeCode": "E100", "otp": code})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)

    def test_a_reset_code_cannot_sign_in_and_a_login_code_cannot_reset(self):
        _, reset_code = self.request_code(purpose="reset")
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": reset_code}).status_code, 400)
        self.age_last_otp(61)
        EmployeeOtp.objects.all().delete()
        _, login_code = self.request_code(purpose="login")
        r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": login_code, "password": "new-password-1"})
        self.assertEqual(r.status_code, 400)

    def test_one_employees_code_does_not_work_for_another(self):
        Employee.objects.create(
            employee_code="E101", first_name="B", last_name="C", phone="9000000001", status="active"
        )
        _, code = self.request_code("E100")
        self.assertEqual(self.post("otp/login", {"employeeCode": "E101", "otp": code}).status_code, 400)

    def test_inactive_employees_cannot_sign_in_even_with_a_valid_code(self):
        _, code = self.request_code()
        Employee.objects.filter(pk=self.emp.pk).update(status="resigned")
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)

    def test_a_used_code_counts_as_verified_and_a_dead_one_does_not(self):
        _, first = self.request_code()
        self.age_last_otp(61)
        _, second = self.request_code()  # kills the first: consumed AND expired at once
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": second}).status_code, 200)
        verified = otp_service.verified_codes("whatsapp")
        self.assertEqual(list(verified.values_list("pk", flat=True)), [EmployeeOtp.objects.order_by("-pk").first().pk])
        self.assertEqual(otp_service.verified_codes("sms").count(), 0)
        dead = EmployeeOtp.objects.order_by("pk").first()
        self.assertEqual(dead.consumed_at, dead.expires_at)
        self.assertNotEqual(first, second)


class OtpResetPasswordTests(OtpBase):
    def test_reset_sets_the_password_and_it_then_works(self):
        _, code = self.request_code(purpose="reset")
        r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "brand-new-pass"})
        self.assertEqual(r.status_code, 200)
        self.emp.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"brand-new-pass", self.emp.password_hash.encode()))
        self.assertIsNotNone(self.emp.password_updated_at)
        login = self.post("employee-login", {"identifier": "E100", "password": "brand-new-pass"})
        self.assertEqual(login.status_code, 200)

    def test_reset_replaces_an_existing_password(self):
        self.emp.password_hash = bcrypt.hashpw(b"old-password-1", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()
        _, code = self.request_code(purpose="reset")
        self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "brand-new-pass"})
        self.assertEqual(
            self.post("employee-login", {"identifier": "E100", "password": "old-password-1"}).status_code, 401
        )
        self.assertEqual(
            self.post("employee-login", {"identifier": "E100", "password": "brand-new-pass"}).status_code, 200
        )

    def test_a_short_password_is_rejected_and_keeps_the_code_usable(self):
        _, code = self.request_code(purpose="reset")
        self.assertEqual(
            self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "short"}).status_code, 400
        )
        self.assertEqual(
            self.post(
                "otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "long-enough-1"}
            ).status_code,
            200,
        )

    def test_a_wrong_code_changes_nothing(self):
        self.request_code(purpose="reset")
        r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": "000000", "password": "brand-new-pass"})
        self.assertEqual(r.status_code, 400)
        self.emp.refresh_from_db()
        self.assertFalse(self.emp.password_hash)

    def test_resetting_kills_any_other_unused_code(self):
        _, code = self.request_code(purpose="reset")
        self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "brand-new-pass"})
        self.assertFalse(EmployeeOtp.objects.filter(consumed_at__isnull=True).exists())


class PasswordLoginSwitchTests(OtpBase):
    def setUp(self):
        super().setUp()
        self.emp.password_hash = bcrypt.hashpw(b"correct-horse", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()

    def test_password_login_works_by_default(self):
        self.assertEqual(
            self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
        )

    def test_it_is_refused_when_switched_off_and_otp_is_available(self):
        whatsapp_settings(password_login_enabled=False)
        r = self.post("employee-login", {"identifier": "E100", "password": "correct-horse"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "Password sign-in is turned off. Please sign in with a WhatsApp code.")

    def test_it_keeps_working_when_otp_cannot_(self):
        whatsapp_settings(password_login_enabled=False)
        for why, flip in (
            ("not configured", lambda on: setattr(self, "whatsapp_configured", on)),
            ("WhatsApp codes off", lambda on: whatsapp_settings(otp_enabled=on)),
            ("sign-in codes off", lambda on: whatsapp_settings(otp_login_enabled=on)),
            ("template not approved", lambda on: set_whatsapp_template("APPROVED" if on else "PENDING")),
        ):
            with self.subTest(why):
                flip(False)
                self.assertEqual(
                    self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
                )
                flip(True)


class ActivationTests(OtpBase):
    """A new employee (no password yet) confirms a WhatsApp code before choosing a password."""

    def activate(self, code, password="brand-new-pass", employee="E100"):
        return self.post("otp/activate", {"employeeCode": employee, "otp": code, "password": password})

    def test_a_new_employee_activates_with_the_code_and_can_then_sign_in(self):
        r, code = self.request_code(purpose="activate")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.whatsapp_sent[-1]["purpose"], "activate")  # the activation wording is the WhatsApp side's
        self.assertEqual(self.activate(code).status_code, 200)
        self.emp.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"brand-new-pass", self.emp.password_hash.encode()))
        self.assertIsNotNone(self.emp.password_updated_at)
        login = self.post("employee-login", {"identifier": "E100", "password": "brand-new-pass"})
        self.assertEqual(login.status_code, 200)

    def test_a_wrong_code_sets_nothing(self):
        self.request_code(purpose="activate")
        r = self.activate("000000")
        self.assertEqual(r.status_code, 400)
        self.emp.refresh_from_db()
        self.assertFalse(self.emp.password_hash)

    def test_a_short_password_is_refused_and_the_code_stays_usable(self):
        _, code = self.request_code(purpose="activate")
        self.assertEqual(self.activate(code, password="short").status_code, 400)
        self.assertEqual(self.activate(code).status_code, 200)

    def test_the_code_works_once(self):
        _, code = self.request_code(purpose="activate")
        self.assertEqual(self.activate(code).status_code, 200)
        self.assertEqual(self.activate(code, password="another-pass-1").status_code, 400)

    def test_an_account_that_already_has_a_password_cannot_ask_for_an_activation_code(self):
        self.emp.password_hash = bcrypt.hashpw(b"original-pass", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()
        r, sent = self.request_code(purpose="activate")
        self.assertEqual(r.status_code, 409)
        self.assertIsNone(sent)

    def test_a_password_set_while_the_code_was_pending_is_not_overwritten(self):
        _, code = self.request_code(purpose="activate")
        mine = bcrypt.hashpw(b"original-pass", bcrypt.gensalt(rounds=4)).decode()
        Employee.objects.filter(pk=self.emp.pk).update(password_hash=mine)
        self.assertEqual(self.activate(code).status_code, 409)
        self.assertEqual(Employee.objects.get(pk=self.emp.pk).password_hash, mine)

    def test_codes_for_other_purposes_cannot_activate_and_an_activation_code_cannot_do_anything_else(self):
        _, login_code = self.request_code(purpose="login")
        self.assertEqual(self.activate(login_code).status_code, 400)
        EmployeeOtp.objects.all().delete()
        _, code = self.request_code(purpose="activate")
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)
        r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "new-password-1"})
        self.assertEqual(r.status_code, 400)

    def test_one_employees_code_cannot_activate_someone_else(self):
        Employee.objects.create(
            employee_code="E101", first_name="B", last_name="C", phone="9000000001", status="active"
        )
        _, code = self.request_code(purpose="activate")
        self.assertEqual(self.activate(code, employee="E101").status_code, 400)
        self.assertFalse(Employee.objects.get(employee_code="E101").password_hash)

    def test_it_can_be_switched_off_and_is_then_not_advertised(self):
        whatsapp_settings(otp_activate_enabled=False)
        self.assertEqual(self.request_code(purpose="activate")[0].status_code, 403)
        self.assertFalse(self.options()["otpActivate"])

    def test_not_advertised_when_whatsapp_is_not_configured(self):
        self.whatsapp_configured = False
        self.assertFalse(self.options()["otpActivate"])

    def test_wrong_guesses_lock_the_code(self):
        _, code = self.request_code(purpose="activate")
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.activate(wrong).status_code, 400)
        self.assertEqual(self.activate(code).status_code, 429)
        self.assertFalse(Employee.objects.get(pk=self.emp.pk).password_hash)


class DirectSetPasswordWithActivationTests(OtpBase):
    """auth/set-password must not let a stranger set a first password once activation needs a code."""

    def set_password(self, password="attacker-pass", **headers):
        return self.client.post(
            "/api/auth/set-password",
            {"identifier": "E100", "password": password},
            content_type="application/json",
            **headers,
        )

    def test_a_stranger_is_refused_while_activation_needs_a_code(self):
        r = self.set_password()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            r.json()["error"],
            "Please confirm the code we send to your registered WhatsApp number to set your password.",
        )
        self.assertFalse(Employee.objects.get(pk=self.emp.pk).password_hash)

    def test_it_stays_open_when_activation_cannot_work_so_nobody_is_locked_out(self):
        whatsapp_settings(otp_activate_enabled=False)
        self.assertEqual(self.set_password().status_code, 200)
        Employee.objects.filter(pk=self.emp.pk).update(password_hash="")
        whatsapp_settings(otp_activate_enabled=True)
        self.whatsapp_configured = False
        self.assertEqual(self.set_password().status_code, 200)

    def test_a_signed_in_employee_without_a_password_can_still_set_one_from_the_app(self):
        # They came in with a WhatsApp code, so they are already verified.
        from .jwt_utils import sign_token

        token = sign_token({"role": "employee", "employeeId": self.emp.id, "name": "Asha"})
        r = self.set_password("my-own-password", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(bcrypt.checkpw(b"my-own-password", Employee.objects.get(pk=self.emp.pk).password_hash.encode()))

    def test_another_employees_token_is_still_a_stranger(self):
        from .jwt_utils import sign_token

        other = Employee.objects.create(
            employee_code="E102", first_name="C", last_name="D", phone="9000000002", status="active"
        )
        token = sign_token({"role": "employee", "employeeId": other.id, "name": "C"})
        self.assertEqual(self.set_password(HTTP_AUTHORIZATION=f"Bearer {token}").status_code, 403)


class HostileInputTests(OtpBase):
    """Input nobody legitimate sends must be a clean 400 (never a 500) and must never use up a real code."""

    OTP_PATHS = ("otp/request", "otp/login", "otp/reset-password", "otp/activate")

    def test_a_code_that_is_not_text_is_a_400_and_costs_nobody_an_attempt(self):
        self.request_code()
        bodies = (
            ("otp/login", {}),
            ("otp/reset-password", {"password": "long-enough-1"}),
            ("otp/activate", {"password": "long-enough-1"}),
        )
        for path, extra in bodies:
            for otp in (123456, 12.5, True, False, [1, 2, 3, 4, 5, 6], ["123456"], {"code": "123456"}, [], {}):
                with self.subTest(path=path, otp=otp):
                    r = self.post(path, {"employeeCode": "E100", "otp": otp, **extra})
                    self.assertEqual(r.status_code, 400)
                    self.assertEqual(set(r.json()), {"error"})
        self.assertEqual(EmployeeOtp.objects.get().attempts, 0)

    def test_a_nul_byte_in_the_employee_code_is_a_400_everywhere(self):
        for key in ("employeeCode", "identifier"):
            for path in self.OTP_PATHS:
                with self.subTest(path=path, key=key):
                    body = {key: "E100\x00", "otp": "123456", "password": "long-enough-1", "purpose": "login"}
                    self.assertEqual(self.post(path, body).status_code, 400)
        for path in ("employee-login", "set-password"):
            with self.subTest(path=path):
                body = {"identifier": "E100\x00", "password": "long-enough-1"}
                self.assertEqual(self.post(path, body).status_code, 400)
        r = self.post("hr-login", {"username": "admin\x00", "password": "x"})
        self.assertEqual(r.status_code, 401)

    def test_a_channel_that_is_not_text_is_a_clean_400(self):
        for channel in (["sms"], {"a": 1}, 7, True, "telegram", "SMS"):
            with self.subTest(channel=channel):
                r = self.post("otp/request", {"employeeCode": "E100", "purpose": "login", "channel": channel})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json()["code"], "channel_unavailable")
                self.assertEqual(r.json()["availableChannels"], ["whatsapp"])
        self.assertEqual(self.whatsapp_sent, [])

    def test_a_password_that_is_not_text_is_refused_before_the_code_is_used(self):
        for path, purpose in (("otp/reset-password", "reset"), ("otp/activate", "activate")):
            with self.subTest(path=path):
                EmployeeOtp.objects.all().delete()  # (no resend cooldown between the two rounds)
                Employee.objects.filter(pk=self.emp.pk).update(password_hash="")  # (the first round set one)
                _, code = self.request_code(purpose=purpose)
                hostile = (
                    ["long-enough-1"],
                    list("12345678"),
                    {"password": "long-enough-1"},
                    12345678,
                    True,
                    "long-enough\x00-1",
                )
                for password in hostile:
                    r = self.post(path, {"employeeCode": "E100", "otp": code, "password": password})
                    self.assertEqual(r.status_code, 400, password)
                    self.assertEqual(set(r.json()), {"error"})
                row = EmployeeOtp.objects.get()
                self.assertEqual((row.attempts, row.consumed_at), (0, None))  # the code was not touched
                good = self.post(path, {"employeeCode": "E100", "otp": code, "password": "long-enough-1"})
                self.assertEqual(good.status_code, 200)

    def test_a_short_or_missing_password_never_uses_the_code_up_either(self):
        _, code = self.request_code(purpose="reset")
        for password in ("", "short", None, "1234567"):
            r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": password})
            self.assertEqual(r.status_code, 400, password)
        self.assertEqual(EmployeeOtp.objects.get().attempts, 0)

    def test_a_body_that_is_not_a_json_object_is_a_400_not_a_500(self):
        for path in (*self.OTP_PATHS, "employee-login", "set-password", "hr-login"):
            for raw in ("[]", "[1, 2]", '"text"', "123", "null", "true"):
                with self.subTest(path=path, raw=raw):
                    r = self.client.post(f"/api/auth/{path}", raw, content_type="application/json")
                    self.assertEqual(r.status_code, 400)
                    self.assertIn("error", r.json())

    def test_values_of_the_wrong_type_in_the_sign_in_forms_are_400s(self):
        for body in (
            {"identifier": ["E100"], "password": "long-enough-1"},
            {"identifier": "E100", "password": ["long-enough-1"]},
            {"identifier": 100, "password": "long-enough-1"},
            {"identifier": {"a": 1}, "password": "long-enough-1"},
            {"identifier": "E100", "password": 12345678},
        ):
            for path in ("employee-login", "set-password"):
                with self.subTest(path=path, body=body):
                    self.assertEqual(self.post(path, body).status_code, 400)
        for body in ({"username": ["a"], "password": "x"}, {"username": "a", "password": ["x"]}, {"username": 5}):
            with self.subTest(body=body):
                self.assertEqual(self.post("hr-login", body).status_code, 401)

    def test_ordinary_requests_are_unchanged(self):
        self.assertEqual(self.post("employee-login", {"identifier": "E100"}).status_code, 400)  # no password
        self.assertEqual(self.post("employee-login", {}).status_code, 400)
        self.assertEqual(self.post("hr-login", {}).status_code, 401)
