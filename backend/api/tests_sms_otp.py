"""
SMS one-time codes through 2Factor: configuration, the send pipeline (caps, per-number cap, circuit breaker) and the
whole OTP flow with the SMS channel active (the HTTP client itself: tests_twofactor.py). 2Factor is NEVER contacted: every
test mocks the one HTTP call (`requests.get` as seen by api.twofactor_client) and a guard turns any real network connection into a failure.

The WhatsApp channel's behaviour is pinned by tests_otp.py (unchanged apart from the additive `otpChannel` key).
"""

import logging
import re
import sys
import threading
import time as time_module
from contextlib import contextmanager
from datetime import datetime, time, timedelta
from unittest import mock

import bcrypt
import requests
from django.conf import settings as dj_settings
from django.core.cache import cache
from django.db import connections
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from . import otp_service, sms_service, twofactor_client
from .clock import FACTORY_TZ
from .models import Employee, EmployeeOtp, SmsMessageLog, SmsSettings, WhatsAppSettings

TF_KEY = "3f2a91c0-7b6e-11ef-8b3d-0200cd936042"
TEMPLATE_NAME = "UKT_HRMS_OTP"
SESSION = "ab88279e-0105-415f-912e-2f24162b8cbb"
BASE = "https://2factor.in/API/V1"
SMS_CONFIG = dict(
    TWOFACTOR_API_KEY=TF_KEY,
    TWOFACTOR_TEMPLATE_NAME=TEMPLATE_NAME,
    TWOFACTOR_SENDER_ID="UKTHRM",
    TWOFACTOR_API_BASE=BASE,
    SMS_COUNTRY_CODE="91",
    SMS_ALLOW_SENDING=True,
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok",
)
GET = "api.twofactor_client.requests.get"


class FakeResponse:
    """What requests.get returns, as far as twofactor_client reads it."""

    def __init__(self, status_code=200, body=None, text=None):
        import json

        self.status_code = status_code
        self.text = text if text is not None else json.dumps(body)
        self.encoding = "utf-8"
        self.closed = False
        self.bytes_read = 0

    def iter_content(self, chunk_size=1, decode_unicode=False):
        """The body in chunks, like a streamed response (twofactor_client reads at most its own limit from it)."""
        data = self.text.encode("utf-8")
        for start in range(0, len(data), chunk_size):
            chunk = data[start : start + chunk_size]
            self.bytes_read += len(chunk)
            yield chunk

    def close(self):
        self.closed = True


def provider_ok(session=SESSION):
    """2Factor accepted the code: HTTP 200 {"Status": "Success", "Details": "<session id>"}."""
    return FakeResponse(200, {"Status": "Success", "Details": session})


def provider_error(details, status=400):
    """2Factor refused: HTTP 400 {"Status": "Error", "Details": "..."}."""
    return FakeResponse(status, {"Status": "Error", "Details": details})


def code_in(call) -> str:
    """The one-time code in a mocked `requests.get(url, ...)` call (the 4-to-6 digit path segment before the template)."""
    return re.search(r"/SMS/\+\d+/(\d{6})/", call.args[0]).group(1)


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


@contextmanager
def captured_logs():
    """Everything logged (root logger, every level), formatted with any traceback, as a list of strings."""
    handler, root = _Capture(), logging.getLogger()
    previous = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield handler.lines
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


class NoNetworkMixin:
    """A real connection attempt (anything that would reach 2Factor) fails the test."""

    def setUp(self):
        super().setUp()
        guard = mock.patch("socket.socket.connect", side_effect=AssertionError("a real network connection was made"))
        guard.start()
        self.addCleanup(guard.stop)


# ── configuration ───────────────────────────────────────────────────────────


class ConfigurationTests(SimpleTestCase):
    def test_the_env_example_placeholders_never_count_as_configured(self):
        placeholders = dict(
            TWOFACTOR_API_KEY="your_2factor_api_key_here", TWOFACTOR_TEMPLATE_NAME="your_2factor_template_name_here"
        )
        with override_settings(**{**SMS_CONFIG, **placeholders}):
            self.assertFalse(sms_service.is_configured())
            self.assertFalse(sms_service.is_available())
            self.assertIn("TWOFACTOR_API_KEY", sms_service.sending_block_reason())

    def test_every_placeholder_shape_is_refused(self):
        for bad in (
            "",
            "  ",
            "your_key",
            "YOUR_KEY",
            "demo-key-123",
            "Demo",
            "xxxxxxxx",
            "XXX",
            "changeme",
            "ChangeMe1",
            "put-it-here",
            # the wider table (B11)
            "your-key",
            "yourkey",
            "YourKey123",
            "your_2factor_api_key_here",
            "replace_me",
            "REPLACE_ME",
            "replace-me",
            "<your key>",
            "<auth-key>",
            "todo",
            "TODO",
            "xxx",
            "abcxxxdef",
            "key_here",
            "paste_key_here",
            "here_goes_the_key",
            "paste...here",
        ):
            with self.subTest(auth_key=bad), override_settings(**{**SMS_CONFIG, "TWOFACTOR_API_KEY": bad}):
                self.assertFalse(sms_service.is_configured())
                self.assertTrue(sms_service.looks_like_placeholder(bad))
            with self.subTest(template=bad), override_settings(**{**SMS_CONFIG, "TWOFACTOR_TEMPLATE_NAME": bad}):
                self.assertFalse(sms_service.is_configured())

    def test_a_real_value_that_merely_contains_the_letters_here_is_not_a_placeholder(self):
        """'here' used to mark any value as a placeholder: a real key with 'there' / 'where' in it was refused and SMS
        silently never worked. Only the whole-token shapes (_here, -here, here_, ...here) count now."""
        for real in (
            "k-live-7f3a9c2e1b5d",
            "3f2a91c0-7b6e-11ef-8b3d-0200cd936042",
            "thereKey1234567890",
            "authWhere9x8y7z6w",
            "Where2GoABC123def456",
            "adheres0123456789ab",
            "ThereIsASecret42",
            "yourself-is-fine-1234",
            "templateOtherX99",
        ):
            with self.subTest(real=real):
                self.assertFalse(sms_service.looks_like_placeholder(real))
                with override_settings(**{**SMS_CONFIG, "TWOFACTOR_API_KEY": real, "TWOFACTOR_TEMPLATE_NAME": real}):
                    self.assertTrue(sms_service.is_configured())

    def test_real_looking_values_are_configured(self):
        with override_settings(**SMS_CONFIG):
            self.assertTrue(sms_service.is_configured())
            self.assertEqual(sms_service.config_problems(), [])
            self.assertEqual(sms_service.template_name(), TEMPLATE_NAME)
            self.assertEqual(sms_service.sender_id(), "UKTHRM")
            self.assertEqual(sms_service.api_base(), BASE)

    def test_the_test_runner_blanks_the_real_credentials_so_no_test_can_send(self):
        # not overridden here: this is what `manage.py test` gives every test that does not opt in
        self.assertEqual(dj_settings.TWOFACTOR_API_KEY, "")
        self.assertEqual(dj_settings.TWOFACTOR_TEMPLATE_NAME, "")
        self.assertIs(dj_settings.SMS_ALLOW_SENDING, False)
        self.assertFalse(sms_service.is_configured())
        self.assertFalse(sms_service.is_available())

    def test_a_missing_template_name_or_a_key_that_cannot_go_in_a_url_is_not_configured(self):
        with override_settings(**{**SMS_CONFIG, "TWOFACTOR_TEMPLATE_NAME": ""}):
            self.assertEqual(
                sms_service.config_problems(), ["TWOFACTOR_TEMPLATE_NAME is empty or still the placeholder value"]
            )
        with override_settings(**{**SMS_CONFIG, "TWOFACTOR_TEMPLATE_NAME": "UKT/HRMS"}):
            self.assertEqual(len(sms_service.config_problems()), 1)
            self.assertFalse(sms_service.is_configured())
        weird = "bad/key?with=query&and spaces"
        with override_settings(**{**SMS_CONFIG, "TWOFACTOR_API_KEY": weird}):
            problems = sms_service.config_problems()
        self.assertEqual(len(problems), 1)
        self.assertNotIn(weird, problems[0])  # a problem never quotes a value

    def test_sending_follows_the_whatsapp_rule(self):
        configured = dict(SMS_CONFIG)
        with override_settings(**{**configured, "SMS_ALLOW_SENDING": True, "DEBUG": True}):
            self.assertTrue(sms_service.sending_allowed())  # forced on
        with override_settings(**{**configured, "SMS_ALLOW_SENDING": False, "DEBUG": False}):
            self.assertFalse(sms_service.sending_allowed())  # forced off
            self.assertFalse(sms_service.is_available())
            self.assertTrue(sms_service.is_configured())
            self.assertIn("SMS_ALLOW_SENDING", sms_service.sending_block_reason())
        with override_settings(**{**configured, "SMS_ALLOW_SENDING": None, "DEBUG": False}):
            with mock.patch.object(sys, "argv", ["manage.py", "runserver"]):
                self.assertFalse(sms_service.sending_allowed())  # a development machine never sends
            with mock.patch.object(sys, "argv", ["gunicorn"]):
                self.assertTrue(sms_service.sending_allowed())  # a real server does
        with override_settings(**{**configured, "SMS_ALLOW_SENDING": None, "DEBUG": True}):
            with mock.patch.object(sys, "argv", ["gunicorn"]):
                self.assertFalse(sms_service.sending_allowed())

    def test_the_api_base_must_be_https_or_a_localhost_address(self):
        good = (
            "https://2factor.in/API/V1",
            "http://127.0.0.1:8193/API/V1",
            "http://localhost:8193/API/V1",
            "http://[::1]:8193/x",
        )
        bad = (
            "http://2factor.in/API/V1",
            "http://localhost.evil.example/API/V1",
            "http://127.0.0.1.evil.example/API/V1",
            "ftp://127.0.0.1/api",
            "2factor.in/API/V1",
            "",
        )
        for base in good:
            self.assertIsNone(twofactor_client.base_url_problem(base), base)
        for base in bad:
            self.assertIsNotNone(twofactor_client.base_url_problem(base), base)
            with override_settings(**{**SMS_CONFIG, "TWOFACTOR_API_BASE": base}):
                self.assertFalse(sms_service.is_configured(), base)

    def test_phone_numbers_are_cleaned_and_garbage_is_refused(self):
        with override_settings(**SMS_CONFIG):
            for raw in ("82200 15110", "+91 82200 15110", "918220015110", "08220015110", "0091-82200-15110"):
                self.assertEqual(sms_service.normalize_phone(raw), "918220015110", raw)
            for raw in (None, "", "n/a", "12345", "5551234567", "044-24351234", "98765432101", "+971501234567", "abc"):
                self.assertIsNone(sms_service.normalize_phone(raw), raw)
            self.assertTrue(sms_service.is_valid_number("919876543210"))
            self.assertFalse(sms_service.is_valid_number("91987654321"))
            self.assertFalse(sms_service.is_valid_number("٩١٩٨٧٦٥٤٣٢١٠"))  # non-ASCII digits

    def test_the_mask_never_shows_the_number(self):
        self.assertEqual(sms_service.mask_phone("918220015110"), "•" * 8 + "5110")
        self.assertEqual(sms_service.mask_phone(""), "")
        with override_settings(**SMS_CONFIG):
            hashed = sms_service.phone_hash("918220015110")
        self.assertNotIn("8220015110", hashed)
        self.assertEqual(len(hashed), 64)


# ── the OTP flow with the SMS channel ───────────────────────────────────────


@override_settings(**SMS_CONFIG)
class SmsBase(NoNetworkMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()  # the per-IP throttles count in the cache: no test may inherit another's requests
        self.addCleanup(cache.clear)
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="Kumar", phone="82200 15110", status="active"
        )
        self.configure(otp_channel="sms")

    def configure(self, **values):
        SmsSettings.objects.update_or_create(pk=1, defaults=values)

    def post(self, path, body):
        return self.client.post(f"/api/auth/{path}", body, content_type="application/json")

    def request_code(self, code="E100", purpose="login", response=None, side_effect=None):
        """Ask for a code; returns (HTTP response, the code in the SMS or None, the mocked requests.get)."""
        with mock.patch(
            GET, return_value=None if side_effect else (response or provider_ok()), side_effect=side_effect
        ) as get:
            r = self.post("otp/request", {"employeeCode": code, "purpose": purpose})
        return r, (code_in(get.call_args) if get.called else None), get

    def age_last_otp(self, seconds):
        EmployeeOtp.objects.filter(pk=EmployeeOtp.objects.first().pk).update(
            created_at=timezone.now() - timedelta(seconds=seconds)
        )

    def age_logs(self, seconds, **filters):
        SmsMessageLog.objects.filter(**filters).update(created_at=timezone.now() - timedelta(seconds=seconds))

    def options(self):
        return self.client.get("/api/auth/login-options").json()


class LoginOptionsMatrixTests(SmsBase):
    def test_sms_channel_advertises_otp_when_configured_and_names_the_channel(self):
        self.assertEqual(
            self.options(),
            {"otpLogin": True, "otpReset": True, "otpActivate": True, "passwordLogin": True, "otpChannel": "sms"},
        )

    def test_whatsapp_channel_is_the_default_and_says_so(self):
        self.configure(otp_channel="whatsapp")
        body = self.options()
        self.assertEqual(body["otpChannel"], "whatsapp")
        self.assertEqual((body["otpLogin"], body["otpReset"], body["otpActivate"]), (True, True, True))

    def test_nothing_is_advertised_while_the_active_channel_cannot_send(self):
        for override in (
            dict(TWOFACTOR_API_KEY=""),
            dict(TWOFACTOR_API_KEY="your_2factor_api_key_here"),
            dict(TWOFACTOR_TEMPLATE_NAME=""),
            dict(SMS_ALLOW_SENDING=False),
            dict(TWOFACTOR_API_BASE="http://2factor.in/API/V1"),
        ):
            with self.subTest(override), override_settings(**override):
                body = self.options()
                self.assertEqual((body["otpLogin"], body["otpReset"], body["otpActivate"]), (False, False, False))
                self.assertTrue(body["passwordLogin"])  # nobody is locked out
                self.assertEqual(body["otpChannel"], "sms")

    def test_the_active_channel_decides_not_the_other_one(self):
        # SMS selected, WhatsApp configured but 2Factor not: no OTP
        with override_settings(TWOFACTOR_API_KEY=""):
            self.assertFalse(self.options()["otpLogin"])
        # WhatsApp selected, 2Factor configured but WhatsApp not: no OTP
        self.configure(otp_channel="whatsapp")
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            self.assertFalse(self.options()["otpLogin"])
        # ... and 2Factor being unconfigured does not hurt WhatsApp
        with override_settings(TWOFACTOR_API_KEY=""):
            self.assertTrue(self.options()["otpLogin"])

    def test_each_sms_switch_is_independent(self):
        for field, key in (
            ("otp_login_enabled", "otpLogin"),
            ("otp_reset_enabled", "otpReset"),
            ("otp_activate_enabled", "otpActivate"),
        ):
            self.configure(**{field: False})
            body = self.options()
            self.assertFalse(body[key], key)
            self.assertEqual(sum(body[k] for k in ("otpLogin", "otpReset", "otpActivate")), 2)
            self.configure(**{field: True})

    def test_the_sms_switches_rule_while_sms_is_active_and_the_whatsapp_ones_while_whatsapp_is(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_login_enabled": False})
        self.assertTrue(self.options()["otpLogin"])  # SMS active: the WhatsApp switch is irrelevant
        self.configure(otp_channel="whatsapp", otp_login_enabled=False)
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_login_enabled": True})
        self.assertTrue(self.options()["otpLogin"])  # WhatsApp active: the SMS switch is irrelevant

    def test_password_login_can_be_off_only_while_sms_codes_really_work(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        self.assertFalse(self.options()["passwordLogin"])
        with override_settings(TWOFACTOR_API_KEY=""):
            self.assertTrue(self.options()["passwordLogin"])
        self.configure(otp_login_enabled=False)
        self.assertTrue(self.options()["passwordLogin"])

    def test_password_sign_in_refusal_and_activation_text_name_the_active_channel(self):
        self.emp.password_hash = bcrypt.hashpw(b"correct-horse", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        r = self.post("employee-login", {"identifier": "E100", "password": "correct-horse"})
        self.assertEqual(r.status_code, 403)
        self.assertIn("SMS", r.json()["error"])
        self.assertNotIn("WhatsApp", r.json()["error"])
        with override_settings(TWOFACTOR_API_KEY=""):
            self.assertEqual(
                self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
            )
        self.configure(otp_channel="whatsapp")
        r = self.post("employee-login", {"identifier": "E100", "password": "correct-horse"})
        self.assertEqual(r.status_code, 403)
        self.assertIn("WhatsApp", r.json()["error"])

    def test_a_stranger_cannot_set_a_first_password_while_sms_activation_is_on(self):
        r = self.post("set-password", {"identifier": "E100", "password": "attacker-pass"})
        self.assertEqual(r.status_code, 403)
        self.assertIn("SMS", r.json()["error"])
        self.assertFalse(Employee.objects.get(pk=self.emp.pk).password_hash)
        # not configured -> the old open setup stays, nobody is locked out
        with override_settings(TWOFACTOR_API_KEY=""):
            self.assertEqual(
                self.post("set-password", {"identifier": "E100", "password": "my-own-pass1"}).status_code, 200
            )


class RequestOtpBySmsTests(SmsBase):
    def test_the_code_goes_by_sms_to_the_registered_number_and_the_answer_names_the_channel(self):
        with mock.patch("api.whatsapp_service.send_notification") as whatsapp:
            r, code, post = self.request_code()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            body,
            {
                "message": "We've sent a code by SMS to " + "•" * 8 + "5110.",
                "maskedPhone": "•" * 8 + "5110",
                "expiresInSeconds": 300,
                "resendAfterSeconds": 60,
                "channel": "sms",
            },
        )
        whatsapp.assert_not_called()
        post.assert_called_once()
        self.assertEqual(post.call_args.args, (f"{BASE}/{TF_KEY}/SMS/+918220015110/{code}/{TEMPLATE_NAME}",))
        self.assertRegex(code, r"^\d{6}$")
        self.assertNotIn("8220015110", str(body))
        self.assertNotIn(code, r.content.decode())

    def test_the_whatsapp_channel_still_uses_whatsapp_and_never_calls_2factor(self):
        self.configure(otp_channel="whatsapp")
        ok = mock.Mock(status_code=200, content=b"x", text="")
        ok.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WAID"}}}
        with (
            mock.patch("api.twofactor_client.send_otp") as twofactor,
            mock.patch("api.whatsapp_service.requests.post", return_value=ok) as whatsapp,
        ):
            r = self.post("otp/request", {"employeeCode": "E100"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["message"], "We've sent a code to your WhatsApp.")
        self.assertEqual(r.json()["channel"], "whatsapp")
        twofactor.assert_not_called()
        whatsapp.assert_called_once()
        self.assertFalse(SmsMessageLog.objects.exists())

    def test_the_code_signs_in_and_nothing_stores_it(self):
        r, code, _ = self.request_code()
        row = EmployeeOtp.objects.get()
        self.assertNotIn(code, row.code_hash)
        login = self.post("otp/login", {"employeeCode": "E100", "otp": code})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.json()["role"], "employee")
        # the code is in no SMS log field, whichever field you look at
        for log in SmsMessageLog.objects.all():
            for field in log._meta.concrete_fields:
                self.assertNotIn(code, str(getattr(log, field.attname)), field.name)

    def test_the_log_row_has_what_hr_needs_and_no_number_text_or_code(self):
        _, code, _ = self.request_code()
        log = SmsMessageLog.objects.get()
        self.assertEqual(
            (log.status, log.purpose, log.provider, log.phone_masked, log.employee_id, log.error, log.error_code),
            ("sent", "login", "twofactor", "•" * 8 + "5110", self.emp.id, "", ""),
        )
        self.assertEqual(log.provider_message_id, SESSION)
        self.assertEqual(log.requested_ip, "127.0.0.1")
        self.assertEqual(len(log.phone_hash), 64)
        dump = " ".join(str(getattr(log, f.attname)) for f in log._meta.concrete_fields)
        self.assertNotIn("8220015110", dump)
        self.assertNotIn(TF_KEY, dump)
        self.assertNotIn(code, dump)

    def test_the_code_and_the_key_are_never_logged_anywhere(self):
        with captured_logs() as lines:
            _, code, _ = self.request_code()
            self.request_code(response=provider_error(f"Invalid API Key {TF_KEY}"), code="E100")  # cooldown 429
            self.age_last_otp(120)
            _, failed_code, _ = self.request_code(side_effect=requests.exceptions.ConnectionError(f"x {TF_KEY}"))
            _, odd_code, _ = self.request_code(response=provider_error(f"boom {TF_KEY}", 200))
            self.post("otp/login", {"employeeCode": "E100", "otp": code})
        text = "\n".join(lines)
        for secret in (TF_KEY, code, failed_code or "", odd_code or "", "8220015110"):
            if secret:
                self.assertNotIn(secret, text)

    def test_a_provider_failure_discards_the_code_and_does_not_use_up_the_allowance(self):
        r, code, post = self.request_code(response=provider_error("Template Name is not approved"))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(
            r.json()["error"], "We couldn't send the code by SMS. Please try again in a moment or contact HR."
        )
        self.assertFalse(EmployeeOtp.objects.exists())
        log = SmsMessageLog.objects.get()
        self.assertEqual((log.status, log.error_code), ("failed", "template"))
        self.assertIn("template", log.error.lower())
        self.assertNotIn(TF_KEY, str(r.json()))
        self.assertNotIn(code, r.content.decode())
        # the old code cannot be used, and they can try again straight away
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)
        self.assertEqual(self.request_code()[0].status_code, 200)

    def test_timeouts_and_malformed_replies_are_a_502_with_a_log_row(self):
        for side_effect, response, kind in (
            (requests.exceptions.ReadTimeout("slow"), None, "timeout"),
            (requests.exceptions.ConnectionError("down"), None, "connection"),
            (None, FakeResponse(200, text="<html>oops</html>"), "bad_response"),
            (None, FakeResponse(200, {"unexpected": True}), "rejected"),
            (None, FakeResponse(500, text="boom"), "http"),
        ):
            with self.subTest(kind=kind):
                SmsMessageLog.objects.all().delete()  # keep the breaker out of this
                r, _, post = self.request_code(response=response, side_effect=side_effect)
                self.assertEqual(r.status_code, 502)
                post.assert_called_once()
                self.assertEqual(SmsMessageLog.objects.get().error_code, kind)
                self.assertFalse(EmployeeOtp.objects.exists())

    def test_an_unexpected_bug_in_the_client_is_a_502_not_a_500_and_leaks_nothing(self):
        with captured_logs() as lines:
            with mock.patch("api.twofactor_client.send_otp", side_effect=RuntimeError(f"bug with {TF_KEY} and 482913")):
                r = self.post("otp/request", {"employeeCode": "E100", "purpose": "login"})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(SmsMessageLog.objects.get().error_code, "unexpected")
        self.assertTrue(any("crashed unexpectedly (RuntimeError)" in line for line in lines))  # the capture works
        self.assertNotIn(TF_KEY, "\n".join(lines) + r.content.decode() + SmsMessageLog.objects.get().error)
        self.assertNotIn("482913", "\n".join(lines))
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_the_send_is_recorded_before_the_call_and_corrected_after(self):
        seen = {}

        def during_call(*args, **kwargs):
            log = SmsMessageLog.objects.get()
            seen["during"] = (log.status, log.provider_message_id)
            return provider_ok("REQ1234ID")

        r, _, _ = self.request_code(side_effect=during_call)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(seen["during"], ("sent", ""))  # counted by the caps while the call is in flight
        self.assertEqual(SmsMessageLog.objects.get().provider_message_id, "REQ1234ID")

        SmsMessageLog.objects.all().delete()
        EmployeeOtp.objects.all().delete()
        r, _, _ = self.request_code(side_effect=requests.exceptions.ReadTimeout("slow"))
        self.assertEqual(SmsMessageLog.objects.get().status, "failed")  # ... and no longer counted once it failed

    def test_refused_without_any_request_when_off_unconfigured_or_not_allowed(self):
        self.configure(otp_login_enabled=False)
        r, _, post = self.request_code()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "SMS OTP is turned off. Please use your password or contact HR.")
        post.assert_not_called()
        self.configure(otp_login_enabled=True)
        for override in (
            dict(TWOFACTOR_API_KEY=""),
            dict(TWOFACTOR_TEMPLATE_NAME="your_2factor_template_name_here"),
            dict(SMS_ALLOW_SENDING=False),
        ):
            with override_settings(**override):
                r, _, post = self.request_code()
            self.assertEqual(r.status_code, 503, override)
            self.assertEqual(r.json()["error"], "SMS OTP isn't available right now. Please contact HR.")
            post.assert_not_called()
        self.assertFalse(SmsMessageLog.objects.exists())
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_a_bad_number_is_refused_before_anything_is_created_or_sent(self):
        for phone in ("12345", "044-24351234", "5551234567"):
            Employee.objects.filter(pk=self.emp.pk).update(phone=phone)
            r, _, post = self.request_code()
            self.assertEqual(r.status_code, 400, phone)
            self.assertIn("valid mobile number", r.json()["error"])
            post.assert_not_called()
        self.assertFalse(EmployeeOtp.objects.exists())
        self.assertFalse(SmsMessageLog.objects.exists())

    def test_unknown_inactive_and_phoneless_employees_are_refused_without_sending(self):
        Employee.objects.create(
            employee_code="E200", first_name="Gone", last_name="X", phone="9000000000", status="resigned"
        )
        Employee.objects.create(employee_code="E300", first_name="No", last_name="Phone", phone="", status="active")
        for code, status in (("NOPE", 404), ("E200", 403), ("E300", 400), ("", 400)):
            r, _, post = self.request_code(code)
            self.assertEqual(r.status_code, status, code)
            post.assert_not_called()

    def test_the_sms_settings_rule_expiry_cooldown_and_the_hourly_allowance(self):
        self.configure(otp_expiry_minutes=7, resend_cooldown_seconds=120, max_requests_per_hour=2)
        r, _, post = self.request_code()
        self.assertEqual((r.json()["expiresInSeconds"], r.json()["resendAfterSeconds"]), (420, 120))
        delta = EmployeeOtp.objects.get().expires_at - timezone.now()
        self.assertAlmostEqual(delta.total_seconds(), 420, delta=5)
        r, _, _ = self.request_code()
        self.assertEqual(r.status_code, 429)
        self.assertIn("retryAfterSeconds", r.json())
        self.assertLessEqual(r.json()["retryAfterSeconds"], 120)
        self.age_last_otp(61)  # past the old 60 s cooldown, still inside the configured 120 s
        self.assertEqual(self.request_code()[0].status_code, 429)
        self.age_last_otp(121)
        self.assertEqual(self.request_code()[0].status_code, 200)
        self.age_last_otp(200)
        r, _, _ = self.request_code()  # a third code in the hour with max 2
        self.assertEqual(r.status_code, 429)
        self.assertNotIn("retryAfterSeconds", r.json())

    def test_a_new_request_kills_the_previous_code(self):
        _, first, _ = self.request_code()
        self.age_last_otp(61)
        _, second, _ = self.request_code()
        self.assertNotEqual(first, second)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": first}).status_code, 400)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": second}).status_code, 200)

    def test_a_failed_or_blocked_send_leaves_the_previous_valid_code_alone(self):
        """The old code used to be consumed BEFORE the send: anyone able to make a send fail (a cap, the breaker, a
        provider hiccup) killed a victim's valid code. Now the new row is created first and the old codes are consumed
        only after the send succeeded; on any failure the new row is deleted and the old code still works."""
        _, old, _ = self.request_code()
        for response, side_effect, status in (
            (provider_error("Insufficient balance"), None, 502),
            (None, requests.exceptions.ReadTimeout("slow"), 502),
            (None, requests.exceptions.ConnectionError("down"), 502),
        ):
            with self.subTest(status=status, effect=side_effect):
                SmsMessageLog.objects.filter(status="failed").delete()  # keep the breaker out of this
                self.age_last_otp(61)
                r, _, _ = self.request_code(response=response, side_effect=side_effect)
                self.assertEqual(r.status_code, status)
                self.assertEqual(EmployeeOtp.objects.count(), 1)  # the new row is gone again
                self.assertIsNone(EmployeeOtp.objects.get().consumed_at)  # ... and the old one was not consumed
        # blocked by a cap: same
        self.configure(hourly_cap=1)
        SmsMessageLog.objects.filter(status="failed").delete()
        self.age_last_otp(61)
        r, _, post = self.request_code()
        self.assertEqual(r.status_code, 503)
        post.assert_not_called()
        self.assertEqual(EmployeeOtp.objects.count(), 1)
        self.configure(hourly_cap=300)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": old}).status_code, 200)

    def test_the_previous_code_is_consumed_only_after_the_send_succeeded(self):
        _, first, _ = self.request_code()
        self.age_last_otp(61)
        seen = {}

        def during_call(*args, **kwargs):
            seen["rows"] = [(row.consumed_at is None) for row in EmployeeOtp.objects.order_by("created_at")]
            return provider_ok()

        r, second, _ = self.request_code(side_effect=during_call)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(seen["rows"], [True, True])  # in flight: the old code is not touched yet
        self.assertEqual(EmployeeOtp.objects.filter(consumed_at__isnull=True).count(), 1)  # now only the newest lives
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": first}).status_code, 400)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": second}).status_code, 200)


class VerifyOtpBySmsTests(SmsBase):
    def test_wrong_codes_get_one_generic_message_and_the_attempt_limit_follows_the_setting(self):
        self.configure(max_attempts_per_code=3)
        _, code, _ = self.request_code()
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(3):
            r = self.post("otp/login", {"employeeCode": "E100", "otp": wrong})
            self.assertEqual(r.status_code, 400)
            self.assertIn("incorrect or has expired", r.json()["error"])
        self.assertEqual(EmployeeOtp.objects.get().attempts, 3)
        self.assertEqual(
            self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 429
        )  # locked even for the right one
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)

    def test_single_use_expiry_and_purpose_binding_are_shared_with_the_whatsapp_channel(self):
        _, code, _ = self.request_code()
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 200)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 400)  # once
        EmployeeOtp.objects.all().delete()
        _, code, _ = self.request_code()
        EmployeeOtp.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        r = self.post("otp/login", {"employeeCode": "E100", "otp": code})
        self.assertEqual(r.status_code, 400)
        self.assertIn("expired", r.json()["error"])
        EmployeeOtp.objects.all().delete()
        _, reset_code, _ = self.request_code(purpose="reset")
        self.assertEqual(
            self.post("otp/login", {"employeeCode": "E100", "otp": reset_code}).status_code, 400
        )  # purpose-bound
        self.assertEqual(
            self.post(
                "otp/reset-password", {"employeeCode": "E100", "otp": reset_code, "password": "brand-new-pass"}
            ).status_code,
            200,
        )

    def test_activation_by_sms_sets_the_first_password(self):
        r, code, post = self.request_code(purpose="activate")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(SmsMessageLog.objects.get().purpose, "activate")
        activate = self.post("otp/activate", {"employeeCode": "E100", "otp": code, "password": "brand-new-pass"})
        self.assertEqual(activate.status_code, 200)
        self.emp.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"brand-new-pass", self.emp.password_hash.encode()))
        self.assertEqual(self.request_code(purpose="activate")[0].status_code, 409)  # already has a password


# ── limits: per number, global caps, circuit breaker ────────────────────────


class LimitsTests(SmsBase):
    def setUp(self):
        super().setUp()
        # a second employee record that shares the number (typed differently)
        self.twin = Employee.objects.create(
            employee_code="E101", first_name="Twin", last_name="Kumar", phone="+91 8220015110", status="active"
        )

    def test_the_per_number_cap_counts_by_number_across_employee_records_and_formats(self):
        self.configure(max_per_phone_per_hour=2)
        self.assertEqual(self.request_code("E100")[0].status_code, 200)
        self.assertEqual(self.request_code("E101")[0].status_code, 200)
        r, code, post = self.request_code("E100", purpose="reset")  # a different employee/purpose: same NUMBER
        self.assertEqual(r.status_code, 429)
        self.assertEqual(
            r.json()["error"], "Too many codes were sent to this number. Please try again in an hour, or contact HR."
        )
        post.assert_not_called()
        blocked = SmsMessageLog.objects.get(status="blocked")
        self.assertEqual(
            (blocked.error_code, blocked.purpose, blocked.employee_id), ("phone_cap", "reset", self.emp.id)
        )
        self.assertIn("limit 2", blocked.error)
        self.assertFalse(EmployeeOtp.objects.filter(purpose="reset").exists())  # the code was discarded
        # an hour later it is allowed again
        self.age_logs(3601, status="sent")
        self.assertEqual(self.request_code("E100", purpose="reset")[0].status_code, 200)

    def test_another_number_is_not_affected_by_the_cap(self):
        self.configure(max_per_phone_per_hour=1)
        other = Employee.objects.create(
            employee_code="E102", first_name="O", last_name="K", phone="9876543210", status="active"
        )
        self.assertEqual(self.request_code("E100")[0].status_code, 200)
        self.assertEqual(self.request_code("E102")[0].status_code, 200)
        self.assertEqual(other.employee_code, "E102")

    def test_failed_and_blocked_attempts_do_not_count_toward_the_caps(self):
        self.configure(max_per_phone_per_hour=1, hourly_cap=1)
        self.assertEqual(
            self.request_code("E100", side_effect=requests.exceptions.ReadTimeout("slow"))[0].status_code, 502
        )
        self.assertEqual(self.request_code("E100")[0].status_code, 200)  # the failure did not use the cap
        self.assertEqual(self.request_code("E101")[0].status_code, 503)  # now it is used up (and this one is "blocked")
        self.age_logs(7200, status="sent")
        self.assertEqual(self.request_code("E101")[0].status_code, 200)  # the blocked row did not count

    def test_the_global_hourly_cap_blocks_with_a_plain_error_and_a_log_row(self):
        self.configure(hourly_cap=2)
        for code in ("E100", "E101"):
            self.assertEqual(self.request_code(code)[0].status_code, 200)
        r, _, post = self.request_code("E100", purpose="reset")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"], "SMS is temporarily unavailable. Please use your password or contact HR.")
        post.assert_not_called()
        blocked = SmsMessageLog.objects.get(status="blocked")
        self.assertEqual(blocked.error_code, "hourly_cap")
        self.assertIn("hourly limit of 2", blocked.error)
        self.assertFalse(EmployeeOtp.objects.filter(purpose="reset").exists())
        # the hour is a rolling one
        self.age_logs(3601, status="sent")
        self.assertEqual(self.request_code("E100", purpose="reset")[0].status_code, 200)

    def test_the_global_daily_cap_is_per_ist_day(self):
        self.configure(daily_cap=2, hourly_cap=100)
        self.assertEqual(self.request_code("E100")[0].status_code, 200)
        self.assertEqual(self.request_code("E101")[0].status_code, 200)
        r, _, post = self.request_code("E100", purpose="reset")
        self.assertEqual(r.status_code, 503)
        post.assert_not_called()
        self.assertEqual(SmsMessageLog.objects.get(status="blocked").error_code, "daily_cap")
        # the two sends move to the previous IST day: the cap is fresh
        midnight = timezone.now().astimezone(FACTORY_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        SmsMessageLog.objects.filter(status="sent").update(created_at=midnight - timedelta(minutes=1))
        self.assertEqual(self.request_code("E100", purpose="reset")[0].status_code, 200)

    def test_the_circuit_breaker_pauses_sms_after_three_failures_in_ten_minutes(self):
        broken = requests.exceptions.ConnectionError("down")
        for _ in range(3):
            self.assertEqual(self.request_code(side_effect=broken)[0].status_code, 502)
        paused, until = sms_service.circuit()
        self.assertTrue(paused)
        self.assertGreater(until, timezone.now())
        r, _, post = self.request_code()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"], "SMS is temporarily unavailable. Please use your password or contact HR.")
        post.assert_not_called()
        blocked = SmsMessageLog.objects.get(status="blocked")
        self.assertEqual(blocked.error_code, "paused")
        self.assertIn("paused until", blocked.error)
        # the apps still hear that SMS is configured (password login stays); only the sends are paused
        self.assertEqual(self.options()["passwordLogin"], True)
        # ten minutes after the last failure SMS is back
        self.age_logs(601, status="failed")
        self.assertFalse(sms_service.circuit()[0])
        self.assertEqual(self.request_code()[0].status_code, 200)

    def test_a_bad_recipient_cannot_pause_sms_for_everybody(self):
        """Only failures that say something about the PROVIDER count: a refused number or an unrecognised refusal of one
        message ('number' / 'rejected') is one employee's problem."""
        for _ in range(5):
            self.assertEqual(self.request_code(response=provider_error("Invalid mobile"))[0].status_code, 502)
        self.assertEqual(self.request_code(response=provider_error("Sender id not mapped"))[0].status_code, 502)
        self.assertEqual(
            sorted(set(SmsMessageLog.objects.values_list("error_code", flat=True))), ["number", "rejected"]
        )
        self.assertEqual(SmsMessageLog.objects.filter(status="failed").count(), 6)
        self.assertEqual(sms_service.circuit(), (False, None))
        self.assertEqual(self.request_code()[0].status_code, 200)  # SMS was never paused

    def test_provider_failures_still_pause_even_among_per_recipient_ones(self):
        now = timezone.now()
        for code in ("number", "rejected", "timeout", "number", "auth", "rejected", "http"):
            SmsMessageLog.objects.create(purpose="login", status="failed", error_code=code, created_at=now)
        self.assertTrue(sms_service.circuit(now)[0])  # timeout + auth + http = three provider-side failures
        SmsMessageLog.objects.filter(error_code="http").delete()
        self.assertFalse(sms_service.circuit(now)[0])  # two are not enough, whatever else failed
        for code in ("balance", "template", "ip", "rate", "connection", "bad_response", "unexpected", "config"):
            SmsMessageLog.objects.all().delete()
            for _ in range(3):
                SmsMessageLog.objects.create(purpose="login", status="failed", error_code=code, created_at=now)
            self.assertTrue(sms_service.circuit(now)[0], code)

    def test_two_failures_or_old_failures_do_not_pause(self):
        broken = requests.exceptions.ConnectionError("down")
        for _ in range(2):
            self.request_code(side_effect=broken)
        self.assertFalse(sms_service.circuit()[0])
        self.age_logs(601, status="failed")
        self.request_code(side_effect=broken)
        self.assertFalse(sms_service.circuit()[0])  # one new failure + two old ones
        self.assertEqual(self.request_code()[0].status_code, 200)

    def test_the_breaker_and_caps_live_in_the_database_so_every_worker_agrees(self):
        # a failure written by "another worker" (just a row) is seen by this one
        now = timezone.now()
        for _ in range(3):
            SmsMessageLog.objects.create(purpose="login", status="failed", error_code="timeout", created_at=now)
        self.assertTrue(sms_service.circuit(now)[0])
        SmsMessageLog.objects.all().delete()
        self.configure(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        self.assertEqual(self.request_code()[0].status_code, 503)


class BlockedRowsAreBoundedTests(SmsBase):
    """A blocked request writes a log row for HR, but one caller must not be able to fill the table: at most one
    'blocked' row per employee per reason per minute (the employee-less test sends: one per reason per minute)."""

    def setUp(self):
        super().setUp()
        self.configure(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=timezone.now())
        self.other = Employee.objects.create(
            employee_code="E102", first_name="O", last_name="K", phone="9876543210", status="active"
        )

    def blocked(self, **filters):
        return SmsMessageLog.objects.filter(status="blocked", **filters)

    def test_one_blocked_row_per_employee_per_reason_per_minute(self):
        for _ in range(8):
            r, _, post = self.request_code("E100")
            self.assertEqual(r.status_code, 503)  # every request is still refused with the plain sentence
            post.assert_not_called()
        self.assertEqual(self.blocked().count(), 1)
        self.assertEqual(self.blocked().get().employee_id, self.emp.id)
        # another employee is another row
        self.assertEqual(self.request_code("E102")[0].status_code, 503)
        self.assertEqual(self.request_code("E102")[0].status_code, 503)
        self.assertEqual(self.blocked().count(), 2)
        # a minute later the first employee is recorded again
        self.age_logs(61, status="blocked")
        self.request_code("E100")
        self.request_code("E100")
        self.assertEqual(self.blocked(employee=self.emp).count(), 2)  # the old one + one new

    def test_a_different_reason_is_its_own_row(self):
        self.request_code("E100")  # hourly cap
        self.configure(hourly_cap=300, daily_cap=1)
        self.request_code("E100")
        self.request_code("E100")
        self.assertEqual(sorted(self.blocked().values_list("error_code", flat=True)), ["daily_cap", "hourly_cap"])

    def test_employee_less_test_sends_are_bounded_per_reason_too(self):
        for _ in range(6):
            result = sms_service.send_test("98765 43210", None, "10.0.0.5")
            self.assertEqual((result.ok, result.status, result.kind), (False, "blocked", "hourly_cap"))
        self.assertEqual(self.blocked(employee=None).count(), 1)

    def test_a_blocked_request_never_sends_and_never_counts_toward_a_cap(self):
        for _ in range(5):
            self.request_code("E100")
        self.assertEqual(SmsMessageLog.objects.filter(status="sent").count(), 1)
        self.assertEqual(sms_service.usage()["hourUsed"], 1)


class TemporarilyUnavailableTests(SmsBase):
    def test_it_is_false_while_nothing_stops_sending(self):
        self.assertFalse(sms_service.temporarily_unavailable())

    def test_it_is_true_while_the_breaker_is_paused_or_either_cap_is_used_up(self):
        now = timezone.now()
        for _ in range(3):
            SmsMessageLog.objects.create(purpose="login", status="failed", error_code="timeout", created_at=now)
        self.assertTrue(sms_service.temporarily_unavailable())
        SmsMessageLog.objects.all().delete()
        self.configure(hourly_cap=2, daily_cap=100)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        self.assertFalse(sms_service.temporarily_unavailable())
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        self.assertTrue(sms_service.temporarily_unavailable())  # hour used = cap
        SmsMessageLog.objects.all().delete()
        self.configure(hourly_cap=100, daily_cap=2)
        for _ in range(2):
            SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        self.assertTrue(sms_service.temporarily_unavailable())  # day used = cap

    def test_failed_and_blocked_rows_do_not_use_the_caps_up(self):
        self.configure(hourly_cap=1, daily_cap=1)
        for status in ("failed", "blocked", "blocked", "failed"):
            SmsMessageLog.objects.create(purpose="login", status=status, error_code="number", created_at=timezone.now())
        self.assertFalse(sms_service.temporarily_unavailable())

    def test_a_recovered_state_is_false_again(self):
        self.configure(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=timezone.now())
        self.assertTrue(sms_service.temporarily_unavailable())
        self.age_logs(3601, status="sent")
        self.assertFalse(sms_service.temporarily_unavailable())

    def test_the_default_caps_are_300_an_hour_and_1500_a_day(self):
        SmsSettings.objects.all().delete()
        fresh = SmsSettings.get()
        self.assertEqual((fresh.hourly_cap, fresh.daily_cap), (300, 1500))
        self.assertEqual(SmsSettings._meta.get_field("hourly_cap").default, 300)
        self.assertEqual(SmsSettings._meta.get_field("daily_cap").default, 1500)


class CapAndBreakerNeverLockEverybodyOutTests(SmsBase):
    """The 'never lock everybody out' rule must hold under the cap and breaker states too: an anonymous caller can use up
    the GLOBAL cap (one request per employee code), and that must never turn password sign-in off."""

    STATES = ("hour cap", "day cap", "breaker")

    def put_in_state(self, state):
        SmsMessageLog.objects.all().delete()
        now = timezone.now()
        if state == "hour cap":
            self.configure(hourly_cap=2, daily_cap=1500)
            for _ in range(2):
                SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        elif state == "day cap":
            self.configure(hourly_cap=100, daily_cap=2)
            for _ in range(2):
                SmsMessageLog.objects.create(purpose="login", status="sent", created_at=now)
        else:
            self.configure(hourly_cap=300, daily_cap=1500)
            for _ in range(3):
                SmsMessageLog.objects.create(purpose="login", status="failed", error_code="timeout", created_at=now)
        self.assertTrue(sms_service.temporarily_unavailable(), state)

    def setUp(self):
        super().setUp()
        self.emp.password_hash = bcrypt.hashpw(b"correct-horse", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})

    def test_password_sign_in_is_never_refused_while_the_active_sms_channel_cannot_send(self):
        for state in self.STATES:
            with self.subTest(state=state):
                self.configure(hourly_cap=300, daily_cap=1500)
                SmsMessageLog.objects.all().delete()
                # codes work: password sign-in is refused (HR switched it off) ...
                self.assertFalse(self.options()["passwordLogin"])
                self.assertEqual(
                    self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 403
                )
                # ... until they cannot be sent: then password sign-in is open again, and advertised
                self.put_in_state(state)
                body = self.options()
                self.assertTrue(body["passwordLogin"])
                self.assertEqual(body["otpChannel"], "sms")
                self.assertTrue(body["otpLogin"])  # still configured: the apps get the plain 503 sentence if they try
                self.assertEqual(
                    self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
                )
                self.assertIsNone(otp_service.password_login_block_message())

    def test_the_rule_follows_the_cap_state_as_it_changes(self):
        self.put_in_state("hour cap")
        self.assertTrue(self.options()["passwordLogin"])
        self.age_logs(3601, status="sent")  # the hour rolls over: codes work again
        self.assertFalse(self.options()["passwordLogin"])
        self.assertIsNotNone(otp_service.password_login_block_message())

    def test_an_anonymous_flood_of_code_requests_cannot_lock_everybody_out(self):
        """The attack itself: 'hourly cap' different employee codes, each asking for a code."""
        self.configure(hourly_cap=3)
        for n in range(3):
            Employee.objects.create(
                employee_code=f"F{n}", first_name="F", last_name="L", phone=f"90000000{n:02d}", status="active"
            )
            self.assertEqual(self.request_code(f"F{n}")[0].status_code, 200)
        self.assertEqual(self.request_code("E100")[0].status_code, 503)  # the cap is used up: nobody gets a code ...
        self.assertTrue(self.options()["passwordLogin"])  # ... but everybody can still sign in
        self.assertEqual(
            self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 200
        )

    def test_activation_stays_required_so_the_open_first_time_setup_is_not_reopened(self):
        self.put_in_state("hour cap")
        r = self.post("set-password", {"identifier": "E100", "password": "attacker-pass"})
        self.assertEqual(r.status_code, 403)  # E100 has a password: only their own signed-in session may change it
        stored = Employee.objects.get(pk=self.emp.pk).password_hash
        self.assertTrue(bcrypt.checkpw(b"correct-horse", stored.encode()))
        fresh = Employee.objects.create(
            employee_code="E900", first_name="New", last_name="Hire", phone="9000000900", status="active"
        )
        r = self.post("set-password", {"identifier": "E900", "password": "attacker-pass"})
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Employee.objects.get(pk=fresh.pk).password_hash)

    def test_the_whatsapp_channel_ignores_the_sms_caps(self):
        self.put_in_state("hour cap")
        self.configure(otp_channel="whatsapp")
        self.assertFalse(self.options()["passwordLogin"])  # WhatsApp codes work: the SMS cap is irrelevant
        self.assertEqual(
            self.post("employee-login", {"identifier": "E100", "password": "correct-horse"}).status_code, 403
        )

    def test_password_login_on_is_unchanged_by_the_cap_state(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": True})
        for state in self.STATES:
            self.put_in_state(state)
            self.assertTrue(self.options()["passwordLogin"], state)


@override_settings(**SMS_CONFIG)
class ConcurrentRequestsTests(NoNetworkMixin, TransactionTestCase):
    """The cooldown / hourly check and the creation of the new code happen under a lock on the employee row, so a burst
    of simultaneous requests sends ONE SMS (the others see the new code's cooldown)."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="Kumar", phone="82200 15110", status="active"
        )
        SmsSettings.objects.update_or_create(pk=1, defaults={"otp_channel": "sms"})

    def burst(self, threads=12):
        results, barrier = [], threading.Barrier(threads)

        def worker():
            try:
                barrier.wait(timeout=20)
                try:
                    otp_service.request_otp("E100", "login", "10.1.1.1")
                    results.append("ok")
                except otp_service.OtpError as exc:
                    results.append(exc.status)
                except Exception as exc:  # pragma: no cover - the test fails on it below
                    results.append(repr(exc))
            finally:
                connections.close_all()

        # Widen the window between "the check passed" and "the new code exists": without the lock on the employee row
        # every thread passes the check inside it.
        real_create = EmployeeOtp.objects.create

        def slow_create(*args, **kwargs):
            time_module.sleep(0.3)
            return real_create(*args, **kwargs)

        pool = [threading.Thread(target=worker) for _ in range(threads)]
        with mock.patch.object(EmployeeOtp.objects, "create", side_effect=slow_create):
            for thread in pool:
                thread.start()
            for thread in pool:
                thread.join(timeout=60)
        return results

    def test_twelve_simultaneous_requests_send_one_sms(self):
        sent, lock = [], threading.Lock()

        def slow_send(**kwargs):
            with lock:
                sent.append(kwargs["mobile"])
            time_module.sleep(0.4)  # a slow provider widens the window for a second sender
            return "REQ1234ID"

        with mock.patch("api.twofactor_client.send_otp", side_effect=slow_send):
            results = self.burst()
        self.assertEqual(sorted(results, key=str), [429] * 11 + ["ok"], results)
        self.assertEqual(len(sent), 1)
        self.assertEqual(EmployeeOtp.objects.count(), 1)
        self.assertEqual(SmsMessageLog.objects.filter(status="sent").count(), 1)

    def test_twelve_simultaneous_requests_send_one_whatsapp_message_too(self):
        SmsSettings.objects.update_or_create(pk=1, defaults={"otp_channel": "whatsapp"})
        sent, lock = [], threading.Lock()

        def slow_send(*args, **kwargs):
            with lock:
                sent.append(1)
            time_module.sleep(0.4)
            return mock.Mock(status="sent")

        with mock.patch("api.whatsapp_service.send_notification", side_effect=slow_send):
            results = self.burst()
        self.assertEqual(sorted(results, key=str), [429] * 11 + ["ok"], results)
        self.assertEqual(len(sent), 1)
        self.assertEqual(EmployeeOtp.objects.count(), 1)


class OverviewHelpersTests(SmsBase):
    def test_usage_counts_only_sent_rows(self):
        # a fixed "now" (3 p.m. IST) so the test cannot straddle IST midnight
        now = datetime.combine(timezone.now().astimezone(FACTORY_TZ).date(), time(15, 0), tzinfo=FACTORY_TZ)
        for status, age in (("sent", 60), ("sent", 7200), ("failed", 60), ("blocked", 60)):
            SmsMessageLog.objects.create(purpose="login", status=status, created_at=now - timedelta(seconds=age))
        used = sms_service.usage(now)
        self.assertEqual(used["hourUsed"], 1)
        self.assertEqual(used["dayUsed"], 2)

    def test_the_balance_card_never_calls_2factor_and_says_where_to_look(self):
        with mock.patch(GET) as post:
            card = sms_service.balance()
        post.assert_not_called()
        self.assertEqual((card["available"], card["checkedAt"]), (None, None))
        self.assertIn("2Factor panel", card["error"])
        SmsMessageLog.objects.create(purpose="login", status="failed", error_code="balance", error="x")
        self.assertIn("no balance", sms_service.balance()["error"])


class TestMessageTests(SmsBase):
    def test_send_test_uses_the_real_template_the_dummy_code_and_masks_the_number(self):
        with mock.patch(GET, return_value=provider_ok()) as post:
            result = sms_service.send_test("98765 43210", None, "10.0.0.5")
        self.assertTrue(result.ok)
        self.assertEqual(post.call_args.args, (f"{BASE}/{TF_KEY}/SMS/+919876543210/123456/{TEMPLATE_NAME}",))
        log = SmsMessageLog.objects.get()
        self.assertEqual(
            (log.purpose, log.phone_masked, log.employee_id, log.requested_ip),
            ("test", "•" * 8 + "3210", None, "10.0.0.5"),
        )

    def test_send_test_refuses_garbage_and_an_unconfigured_server_without_a_request(self):
        with mock.patch(GET) as post:
            self.assertEqual(sms_service.send_test("12345", None).kind, "invalid_number")
            with override_settings(TWOFACTOR_API_KEY=""):
                result = sms_service.send_test("9876543210", None)
        post.assert_not_called()
        self.assertEqual(result.kind, "not_configured")
        self.assertIn("TWOFACTOR_API_KEY", result.detail)
        self.assertFalse(SmsMessageLog.objects.exists())
