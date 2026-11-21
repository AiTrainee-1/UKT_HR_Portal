"""
Nobody is ever locked out, also when a channel is set up but cannot send (review of 2026-11-20):

  * a provider ACCOUNT that refuses to send (WhatsApp: an expired token, a blocked number, a payment problem; SMS: a
    refused key, no balance, a refused template) takes the channel out of "code sign-in works": password sign-in and the
    open first-password setup come back, and stay back until a message really goes out again (not only for the few
    minutes of a breaker);
  * WhatsApp codes cost money, so they have limits of their own like SMS (per employee and purpose a day, per number an
    hour, and every WhatsApp code an hour / a day); a global limit used up puts WhatsApp codes ON HOLD: the request gets a
    plain sentence, password sign-in reopens, but the open first-password setup does NOT (anybody can use a limit up);
  * a request that names no channel (an older app) is never sent to a channel on hold while the other one works, and
    login-options names that other channel for it.

WhatsApp goes through the real code path to a fake of Meta's Graph API (tests_whatsapp_support.FakeMeta); 2Factor's HTTP
call is mocked; a real network connection fails the test.
"""

from datetime import timedelta
from unittest import mock

import bcrypt
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from . import otp_service, sms_service, whatsapp_dispatcher
from .models import Employee, EmployeeOtp, SmsMessageLog, WhatsAppMessageLog
from .tests_otp import sms_settings, whatsapp_settings
from .tests_sms_otp import GET, SMS_CONFIG, NoNetworkMixin, provider_error, provider_ok
from .tests_whatsapp_support import META, FakeMeta, approve_templates

SETTINGS = {**META, **SMS_CONFIG}
PASSWORD = b"correct-horse"


def hashed() -> str:
    return bcrypt.hashpw(PASSWORD, bcrypt.gensalt(rounds=4)).decode()


@override_settings(**SETTINGS)
class Base(NoNetworkMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.addCleanup(cache.clear)
        approve_templates("otp_login", "otp_reset", "otp_activate")
        whatsapp_settings(otp_enabled=True, password_login_enabled=False)
        sms_settings(otp_enabled=False)
        self.meta = FakeMeta.install(self)
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="K", phone="9876543210", status="active"
        )
        self.emp.password_hash = hashed()
        self.emp.save()
        self.new_hire = Employee.objects.create(
            employee_code="E900", first_name="New", last_name="Hire", phone="9876500900", status="active"
        )

    def post(self, path, body):
        return self.client.post(f"/api/auth/{path}", body, content_type="application/json")

    def ask(self, code="E100", purpose="login", channel=None):
        body = {"employeeCode": code, "purpose": purpose}
        if channel:
            body["channel"] = channel
        with mock.patch(GET, return_value=provider_ok()) as get:
            r = self.post("otp/request", body)
        return r, get.called

    def options(self):
        return self.client.get("/api/auth/login-options").json()

    def password_login(self):
        return self.post("employee-login", {"identifier": "E100", "password": PASSWORD.decode()})

    def stranger_sets_password(self):
        return self.post("set-password", {"identifier": "E900", "password": "attacker-pass-1"})

    def age(self, model, minutes, **filters):
        model.objects.filter(**filters).update(
            **{
                "updated_at" if model is WhatsAppMessageLog else "created_at": timezone.now()
                - timedelta(minutes=minutes)
            }
        )


class WhatsAppAccountFailureTests(Base):
    def break_the_token(self):
        self.meta.fail(190, "Error validating access token: Session has expired", status=401)
        r, _ = self.ask()
        self.assertEqual(r.status_code, 502)

    def test_an_expired_token_reopens_password_sign_in_and_the_first_time_setup(self):
        # codes work: HR's "password sign-in off" holds, and a first password needs a code
        self.assertFalse(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 403)
        self.assertTrue(otp_service.activation_required())

        self.break_the_token()
        self.assertTrue(whatsapp_dispatcher.pause_state()[0])
        body = self.options()
        self.assertTrue(body["passwordLogin"])
        self.assertEqual(body["otpChannels"]["login"], ["whatsapp"])  # still set up: the apps get the plain sentence
        self.assertEqual(self.password_login().status_code, 200)
        self.assertIsNone(otp_service.password_login_block_message())
        self.assertFalse(otp_service.activation_required())
        self.assertEqual(self.stranger_sets_password().status_code, 200)  # nobody new is locked out either

        status = otp_service.channel_status("whatsapp")
        self.assertTrue(status["paused"])
        self.assertIn("access token", status["pauseReason"])

    def test_while_paused_a_code_is_refused_without_calling_meta(self):
        self.break_the_token()
        calls = len(self.meta.calls)
        r, _ = self.ask()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(
            r.json()["error"], "WhatsApp codes can't be sent right now. Please use your password or contact HR."
        )
        self.assertEqual(len(self.meta.calls), calls)
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_password_stays_open_through_the_probe_until_a_message_really_goes_out(self):
        self.break_the_token()
        # half an hour later one probe is allowed (the pause lifts) but the account is still known to be broken
        self.age(WhatsAppMessageLog, 31)
        self.assertFalse(whatsapp_dispatcher.pause_state()[0])
        self.assertIsNotNone(whatsapp_dispatcher.account_problem())
        self.assertTrue(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 200)
        # the probe works (a new token was set): codes are back, and so is HR's "password sign-in off"
        r, _ = self.ask()
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(whatsapp_dispatcher.account_problem())
        self.assertFalse(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 403)
        self.assertTrue(otp_service.activation_required())

    def test_a_request_without_a_channel_goes_to_sms_while_whatsapp_is_paused(self):
        sms_settings(otp_enabled=True)
        self.break_the_token()
        body = self.options()
        # an older app reads otpChannel / codeLength and sends no channel: both must point at SMS now
        self.assertEqual((body["otpChannel"], body["codeLength"]), ("sms", 4))
        self.assertEqual(body["otpChannels"]["login"], ["whatsapp", "sms"])
        self.assertFalse(body["passwordLogin"])  # SMS really works, so HR's choice holds
        self.assertEqual(
            self.password_login().json()["error"], "Password sign-in is turned off. Please sign in with an SMS code."
        )
        r, sms_called = self.ask()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(sms_called)
        self.assertEqual((r.json()["channel"], r.json()["codeLength"]), ("sms", 4))
        # asking for WhatsApp by name is answered plainly, pointing at SMS
        r, _ = self.ask(purpose="reset", channel="whatsapp")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["otherChannels"], ["sms"])
        self.assertIn("Please choose SMS instead", r.json()["error"])

    def test_a_message_level_refusal_never_pauses_anything(self):
        self.meta.fail(131026, "Message undeliverable", times=1)
        r, _ = self.ask()
        self.assertEqual(r.status_code, 502)
        self.assertIsNone(otp_service.pause_reason("whatsapp"))
        self.assertIsNone(otp_service.account_problem("whatsapp"))
        self.assertFalse(self.options()["passwordLogin"])


class WhatsAppCodeLimitTests(Base):
    def employees(self, n):
        return [
            Employee.objects.create(
                employee_code=f"C{i}", first_name="C", last_name=str(i), phone=f"98765{i:05d}", status="active"
            )
            for i in range(n)
        ]

    @override_settings(WHATSAPP_OTP_HOURLY_CAP=2)
    def test_the_hourly_limit_on_all_whatsapp_codes_holds_them_and_reopens_password_sign_in(self):
        people = self.employees(3)
        for e in people[:2]:
            self.assertEqual(self.ask(code=e.employee_code)[0].status_code, 200)
        r, _ = self.ask(code=people[2].employee_code)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(len(self.meta.sent), 2)
        self.assertEqual(otp_service.pause_reason("whatsapp"), "The hourly limit of 2 WhatsApp codes is used up.")
        self.assertTrue(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 200)
        # anybody can use a limit up: it never reopens the open first-password setup to strangers
        self.assertTrue(otp_service.activation_required())
        self.assertEqual(self.stranger_sets_password().status_code, 403)
        # the hour rolls over: codes and HR's choice are back
        self.age(EmployeeOtp, 61)
        self.assertIsNone(otp_service.pause_reason("whatsapp"))
        self.assertFalse(self.options()["passwordLogin"])

    @override_settings(WHATSAPP_OTP_DAILY_CAP=2)
    def test_the_daily_limit_on_all_whatsapp_codes(self):
        people = self.employees(3)
        for e in people[:2]:
            self.assertEqual(self.ask(code=e.employee_code)[0].status_code, 200)
        self.assertEqual(self.ask(code=people[2].employee_code)[0].status_code, 503)
        self.assertIn("daily limit of 2 WhatsApp codes", otp_service.pause_reason("whatsapp"))
        self.assertEqual(otp_service.channel_status("whatsapp")["limits"]["dayUsed"], 2)

    @override_settings(WHATSAPP_OTP_MAX_PER_NUMBER_PER_HOUR=2)
    def test_two_records_sharing_a_number_cannot_multiply_the_allowance(self):
        twin = Employee.objects.create(
            employee_code="E101", first_name="Twin", last_name="K", phone="09876543210", status="active"
        )
        self.assertEqual(self.ask()[0].status_code, 200)
        self.assertEqual(self.ask(code=twin.employee_code)[0].status_code, 200)
        r, _ = self.ask(purpose="reset")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["error"], otp_service.MSG_NUMBER_CAP)
        self.assertEqual(len(self.meta.sent), 2)
        self.assertIsNone(otp_service.pause_reason("whatsapp"))  # one number's limit pauses nobody else

    @override_settings(WHATSAPP_OTP_MAX_PER_DAY=2)
    def test_one_employee_gets_a_few_codes_a_day(self):
        for _ in range(2):
            self.assertEqual(self.ask()[0].status_code, 200)
            self.age(EmployeeOtp, 2)  # past the resend cooldown
        r, _ = self.ask()
        self.assertEqual(r.status_code, 429)
        self.assertIn("today", r.json()["error"])
        self.assertEqual(self.ask(purpose="reset")[0].status_code, 200)  # per purpose

    def test_a_failed_send_does_not_count_against_a_limit(self):
        self.meta.fail(131026, "Message undeliverable", times=3)
        for _ in range(3):
            self.assertEqual(self.ask()[0].status_code, 502)
        self.assertEqual(otp_service.whatsapp_code_usage(), {"hourUsed": 0, "dayUsed": 0})

    def test_the_defaults(self):
        self.assertEqual(
            otp_service.whatsapp_limits(),
            {"perEmployeePerDay": 10, "perNumberPerHour": 10, "hourlyCap": 300, "dailyCap": 1500},
        )


class SmsAccountFailureTests(Base):
    def setUp(self):
        super().setUp()
        whatsapp_settings(otp_enabled=False)
        sms_settings(otp_enabled=True)

    def ask_sms(self, answer):
        with mock.patch(GET, return_value=answer):
            return self.post("otp/request", {"employeeCode": "E100", "purpose": "login"})

    def test_a_refused_key_keeps_password_sign_in_open_beyond_the_breaker(self):
        self.assertFalse(self.options()["passwordLogin"])
        self.assertEqual(self.ask_sms(provider_error("Invalid API Key", 401)).status_code, 502)
        self.assertEqual(SmsMessageLog.objects.get().error_code, "auth")
        self.assertTrue(self.options()["passwordLogin"])
        self.assertFalse(otp_service.activation_required())
        # long after a breaker would have let go: still open, because nothing has been sent since
        self.age(SmsMessageLog, 60)
        self.assertFalse(sms_service.circuit()[0])
        self.assertIn("API key", sms_service.account_problem())
        self.assertTrue(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 200)
        # the next send works (the key was fixed): HR's "password sign-in off" holds again
        self.assertEqual(self.ask_sms(provider_ok()).status_code, 200)
        self.assertIsNone(sms_service.account_problem())
        self.assertFalse(self.options()["passwordLogin"])
        self.assertTrue(otp_service.activation_required())

    def test_an_empty_balance_and_a_refused_template_count_too_but_a_bad_number_does_not(self):
        for details, kind, account in (
            ("Insufficient balance", "balance", True),
            ("Template name is not approved", "template", True),
            ("Invalid phone number", "number", False),
        ):
            with self.subTest(kind):
                SmsMessageLog.objects.all().delete()
                self.ask_sms(provider_error(details))
                self.assertEqual(SmsMessageLog.objects.get().error_code, kind)
                self.assertEqual(sms_service.account_problem() is not None, account)
                self.assertEqual(self.options()["passwordLogin"], account)
