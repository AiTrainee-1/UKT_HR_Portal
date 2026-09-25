"""WhatsApp OTP sign-in and password reset. WAClient is always mocked."""

import re
from datetime import timedelta
from unittest import mock

import bcrypt
from django.test import TestCase, override_settings
from django.utils import timezone

from .jwt_utils import verify_token
from .models import Employee, EmployeeOtp, WhatsAppMessageLog, WhatsAppSettings

CONFIG = dict(WACLIENT_INSTANCE_ID="INST1234", WACLIENT_ACCESS_TOKEN="tok", WHATSAPP_DEFAULT_COUNTRY_CODE="91")


def _ok():
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WAID"}}}
    return r


def _fail():
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "error", "message": "Instance not connected"}
    return r


@override_settings(**CONFIG)
class OtpBase(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="Kumar", phone="82200 15110", status="active"
        )

    def post(self, path, body):
        return self.client.post(f"/api/auth/{path}", body, content_type="application/json")

    def request_code(self, code="E100", purpose="login", ok=True):
        """Ask for a code and return (response, the code that was WhatsApped)."""
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok() if ok else _fail()) as post:
            r = self.post("otp/request", {"employeeCode": code, "purpose": purpose})
        sent = None
        if post.called:
            match = re.search(r"\b(\d{6})\b", post.call_args.kwargs["json"]["message"])
            sent = match.group(1) if match else None
        return r, sent

    def age_last_otp(self, seconds):
        """Pretend the newest OTP was created `seconds` ago (to get past the resend cooldown)."""
        EmployeeOtp.objects.filter(pk=EmployeeOtp.objects.first().pk).update(
            created_at=timezone.now() - timedelta(seconds=seconds)
        )


class LoginOptionsTests(OtpBase):
    def test_reports_what_is_switched_on(self):
        body = self.client.get("/api/auth/login-options").json()
        self.assertEqual(body, {"otpLogin": True, "otpReset": True, "otpActivate": True, "passwordLogin": True})

    def test_otp_is_not_advertised_when_whatsapp_is_not_configured(self):
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            body = self.client.get("/api/auth/login-options").json()
        self.assertEqual((body["otpLogin"], body["otpReset"], body["otpActivate"]), (False, False, False))

    def test_password_login_can_be_switched_off_only_while_otp_really_works(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        self.assertFalse(self.client.get("/api/auth/login-options").json()["passwordLogin"])
        # OTP unavailable -> never lock everyone out.
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            self.assertTrue(self.client.get("/api/auth/login-options").json()["passwordLogin"])

    def test_switching_off_otp_hides_it(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_login_enabled": False})
        self.assertFalse(self.client.get("/api/auth/login-options").json()["otpLogin"])


class RequestOtpTests(OtpBase):
    def test_sends_a_six_digit_code_to_the_registered_number_and_masks_it(self):
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            r = self.post("otp/request", {"employeeCode": "E100"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["maskedPhone"], "•" * 8 + "5110")
        self.assertEqual((body["expiresInSeconds"], body["resendAfterSeconds"]), (300, 60))
        sent = post.call_args.kwargs["json"]
        self.assertEqual((sent["number"], sent["type"]), ("918220015110", "text"))
        self.assertRegex(sent["message"], r"\b\d{6}\b")
        self.assertNotIn("8220015110", str(body))

    def test_employee_code_is_case_insensitive(self):
        self.assertEqual(self.request_code("e100")[0].status_code, 200)

    def test_the_code_is_never_stored_only_a_hash(self):
        _, code = self.request_code()
        row = EmployeeOtp.objects.get()
        self.assertNotIn(code, row.code_hash)
        self.assertNotEqual(row.code_hash, code)
        self.assertIn("$", row.code_hash)

    def test_history_keeps_the_message_but_redacts_the_code(self):
        _, code = self.request_code()
        log = WhatsAppMessageLog.objects.get(document_type="otp_login")
        self.assertEqual((log.status, log.provider_message_id), ("sent", "WAID"))
        self.assertNotIn(code, log.message_text)
        self.assertIn("••••••", log.message_text)

    def test_unknown_inactive_and_phoneless_employees_are_refused_without_sending(self):
        Employee.objects.create(
            employee_code="E200", first_name="Gone", last_name="X", phone="9000000000", status="resigned"
        )
        Employee.objects.create(employee_code="E300", first_name="No", last_name="Phone", phone="", status="active")
        for code, status in (("NOPE", 404), ("E200", 403), ("E300", 400), ("", 400)):
            with mock.patch("api.whatsapp_service.requests.post") as post:
                r = self.post("otp/request", {"employeeCode": code})
            self.assertEqual(r.status_code, status, code)
            post.assert_not_called()
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_refused_when_the_feature_is_off_or_whatsapp_is_not_configured(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_login_enabled": False})
        self.assertEqual(self.request_code()[0].status_code, 403)
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_login_enabled": True})
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            self.assertEqual(self.request_code()[0].status_code, 503)

    def test_reset_and_login_switches_are_independent(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_reset_enabled": False})
        self.assertEqual(self.request_code(purpose="reset")[0].status_code, 403)
        self.assertEqual(self.request_code(purpose="login")[0].status_code, 200)

    def test_unknown_purpose_is_rejected(self):
        self.assertEqual(self.request_code(purpose="admin")[0].status_code, 400)

    def test_a_send_failure_invalidates_the_code_and_does_not_use_up_the_allowance(self):
        r, _ = self.request_code(ok=False)
        self.assertEqual(r.status_code, 502)
        self.assertFalse(EmployeeOtp.objects.exists())
        # ...so they can try again straight away
        self.assertEqual(self.request_code()[0].status_code, 200)
        self.assertEqual(WhatsAppMessageLog.objects.filter(status="failed").count(), 1)

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
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_expiry_minutes": 10})
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
            self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": otp}).status_code, 400, otp)

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
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        r = self.post("employee-login", {"identifier": "E100", "password": "correct-horse"})
        self.assertEqual(r.status_code, 403)
        self.assertIn("WhatsApp", r.json()["error"])

    def test_it_keeps_working_when_otp_cannot_(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            self.assertEqual(
                self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
            )


class ActivationTests(OtpBase):
    """A new employee (no password yet) confirms a WhatsApp code before choosing a password."""

    def activate(self, code, password="brand-new-pass", employee="E100"):
        return self.post("otp/activate", {"employeeCode": employee, "otp": code, "password": password})

    def test_a_new_employee_activates_with_the_code_and_can_then_sign_in(self):
        r, code = self.request_code(purpose="activate")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.activate(code).status_code, 200)
        self.emp.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"brand-new-pass", self.emp.password_hash.encode()))
        self.assertIsNotNone(self.emp.password_updated_at)
        login = self.post("employee-login", {"identifier": "E100", "password": "brand-new-pass"})
        self.assertEqual(login.status_code, 200)

    def test_the_code_message_is_the_activation_wording_and_is_redacted_in_history(self):
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            self.post("otp/request", {"employeeCode": "E100", "purpose": "activate"})
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["number"], "918220015110")
        self.assertIn("activation code", sent["message"])
        code = re.search(r"\b(\d{6})\b", sent["message"]).group(1)
        log = WhatsAppMessageLog.objects.get(document_type="otp_activate")
        self.assertNotIn(code, log.message_text)
        self.assertIn("••••••", log.message_text)

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
        with mock.patch("api.whatsapp_service.requests.post") as post:
            r = self.post("otp/request", {"employeeCode": "E100", "purpose": "activate"})
        self.assertEqual(r.status_code, 409)
        post.assert_not_called()

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
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_activate_enabled": False})
        self.assertEqual(self.request_code(purpose="activate")[0].status_code, 403)
        self.assertFalse(self.client.get("/api/auth/login-options").json()["otpActivate"])

    def test_not_advertised_when_whatsapp_is_not_configured(self):
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            self.assertFalse(self.client.get("/api/auth/login-options").json()["otpActivate"])

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
        self.assertIn("WhatsApp", r.json()["error"])
        self.assertFalse(Employee.objects.get(pk=self.emp.pk).password_hash)

    def test_it_stays_open_when_activation_cannot_work_so_nobody_is_locked_out(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_activate_enabled": False})
        self.assertEqual(self.set_password().status_code, 200)
        Employee.objects.filter(pk=self.emp.pk).update(password_hash="")
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_activate_enabled": True})
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
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
