"""
2Factor.in, the SMS provider: the HTTP client (request, answers, failures), the guarantee that the API key (which 2Factor
wants IN THE URL PATH) never reaches a log line, an exception, a log row, an audit row or an answer, and the OTP flow's
failure handling around it (the limits, the breaker and the login-options matrix: tests_sms_otp.py). 2Factor is NEVER
contacted: every test mocks the one HTTP call (`requests.get` as seen by api.twofactor_client) and a guard turns any real
network connection into a failure.
"""

import json
import logging
from unittest import mock

import requests
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings

from . import twofactor_client
from .models import AuditLog, Employee, EmployeeOtp, SmsMessageLog, SmsSettings
from .tests_sms_otp import (
    BASE,
    GET,
    SESSION,
    SMS_CONFIG,
    TF_KEY,
    FakeResponse,
    NoNetworkMixin,
    captured_logs,
    code_in,
)


def tf_ok(session=SESSION):
    return FakeResponse(200, {"Status": "Success", "Details": session})


def tf_error(details, status=400):
    return FakeResponse(status, {"Status": "Error", "Details": details})


class ClientTests(NoNetworkMixin, SimpleTestCase):
    def args(self, **kw):
        base = dict(api_key=TF_KEY, template_name="UKT_HRMS_OTP", mobile="919876543210", code="482913", base_url=BASE)
        return {**base, **kw}

    def send(self, response=None, **kw):
        with mock.patch(GET, return_value=response or tf_ok()) as get:
            return twofactor_client.send_otp(**self.args(**kw)), get

    def fail(self, response=None, side_effect=None, **kw):
        with mock.patch(GET, return_value=response, side_effect=side_effect) as get:
            with self.assertRaises(twofactor_client.TwoFactorError) as ctx:
                twofactor_client.send_otp(**self.args(**kw))
        return ctx.exception, get

    def test_the_request_is_exactly_the_documented_custom_otp_call(self):
        session, get = self.send()
        self.assertEqual(session, SESSION)
        get.assert_called_once()
        args, kwargs = get.call_args
        self.assertEqual(args, (f"{BASE}/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP",))
        self.assertEqual(kwargs["timeout"], (5, 10))
        self.assertIs(kwargs["allow_redirects"], False)
        self.assertIs(kwargs["stream"], True)
        self.assertNotIn("params", kwargs)

    def test_a_loopback_http_base_is_used_for_a_fake_server(self):
        _, get = self.send(base_url="http://127.0.0.1:8193/API/V1/")
        self.assertEqual(
            get.call_args.args, (f"http://127.0.0.1:8193/API/V1/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP",)
        )

    def test_http_to_a_real_host_a_query_or_a_junk_base_is_refused_before_any_request(self):
        for base in (
            "http://2factor.in/API/V1",
            "ftp://127.0.0.1/x",
            "2factor.in/API/V1",
            "",
            "https://2factor.in/API/V1?x=1",
        ):
            with self.subTest(base=base):
                error, get = self.fail(tf_ok(), base_url=base)
                self.assertEqual(error.kind, "config")
                get.assert_not_called()
                self.assertIsNotNone(twofactor_client.base_url_problem(base))

    def test_missing_or_malformed_pieces_are_refused_before_any_request(self):
        cases = (
            dict(api_key=""),
            dict(template_name=""),
            dict(mobile=""),
            dict(code=""),
            dict(api_key="short"),  # a key is 8..100 characters
            dict(api_key=TF_KEY + "/x"),  # nothing may add a path segment ...
            dict(api_key=TF_KEY + "?a=b"),  # ... or a query
            dict(api_key=TF_KEY + " "),
            dict(template_name="UKT/../x"),
            dict(template_name="UKT HRMS"),
            dict(mobile="+919876543210"),
            dict(mobile="9198765432a0"),
            dict(code="123"),  # 2Factor accepts 4 to 6 characters ...
            dict(code="1234567"),  # ... (we always send 6 digits)
            dict(code="12 456"),
            dict(code="12345a"),
        )
        for override in cases:
            with self.subTest(override=list(override)):
                error, get = self.fail(tf_ok(), **override)
                self.assertEqual(error.kind, "config")
                get.assert_not_called()
                self.assertNotIn(TF_KEY, error.message)

    def test_a_success_without_a_usable_session_id_is_still_a_success(self):
        for body in ({"Status": "Success", "Details": "has spaces, not an id"}, {"Status": "Success"}):
            session, _ = self.send(FakeResponse(200, body))
            self.assertEqual(session, "")

    def test_what_is_not_exactly_a_success_is_a_failure(self):
        cases = (
            (tf_error("Invalid API Key"), "auth"),
            (FakeResponse(403, {"Status": "Error", "Details": "Forbidden"}), "auth"),
            (tf_error("Invalid Phone Number - Length Mismatch(Expected: 10)"), "number"),
            (tf_error("Invalid OTP Code - Length Mismatch(Expected: 4-6)"), "rejected"),
            (tf_error("Template Name is not approved"), "template"),
            (FakeResponse(200, {"Status": "Error", "Details": "Insufficient balance"}), "balance"),
            (FakeResponse(429, {"Status": "Error", "Details": "Too many requests"}), "rate"),
            (FakeResponse(503, text="<html>Service Unavailable</html>"), "http"),
            (FakeResponse(502, {"Status": "Error", "Details": "Bad gateway"}), "http"),
            (FakeResponse(200, text="not json at all"), "bad_response"),
            (FakeResponse(200, text=""), "bad_response"),
            (FakeResponse(200, text="[1, 2]"), "bad_response"),
            (FakeResponse(200, {"Status": "weird", "Details": "?"}), "rejected"),
            (FakeResponse(200, {"foo": "bar"}), "rejected"),
            (FakeResponse(400, {"Status": "Success", "Details": SESSION}), "rejected"),  # success needs a 2xx too
            (FakeResponse(500, {"Status": "Success", "Details": SESSION}), "http"),
        )
        for response, kind in cases:
            with self.subTest(status=response.status_code, text=response.text[:60]):
                error, get = self.fail(response)
                self.assertEqual(error.kind, kind)
                get.assert_called_once()  # never retried
                self.assertTrue(response.closed)

    def test_network_failures_are_mapped_and_never_retried(self):
        cases = (
            (requests.exceptions.ConnectTimeout("connect timed out"), "timeout", "no SMS was sent"),
            (requests.exceptions.ReadTimeout("read timed out"), "timeout", "may still arrive"),
            (requests.exceptions.SSLError("bad certificate"), "connection", "secure connection"),
            (requests.exceptions.ConnectionError("refused"), "connection", "could not connect"),
            (requests.exceptions.ChunkedEncodingError("broken"), "connection", "could not connect"),
            (OSError("boom"), "connection", "could not connect"),
            (ValueError("odd"), "connection", "could not connect"),
            (RuntimeError("anything else"), "connection", "could not connect"),
        )
        for exc, kind, words in cases:
            with self.subTest(exc=type(exc).__name__):
                error, get = self.fail(side_effect=exc)
                self.assertEqual(error.kind, kind)
                self.assertIn(words, error.message)
                get.assert_called_once()

    def test_a_failure_while_reading_the_answer_is_mapped(self):
        class Breaks(FakeResponse):
            def __init__(self, exc):
                super().__init__(200, {"Status": "Success", "Details": "x"})
                self.exc = exc

            def iter_content(self, chunk_size=1, decode_unicode=False):
                raise self.exc

        for exc, kind in (
            (requests.exceptions.ReadTimeout(f"slow {TF_KEY}"), "timeout"),
            (requests.exceptions.ChunkedEncodingError(f"cut {TF_KEY}"), "connection"),
        ):
            broken = Breaks(exc)
            error, _ = self.fail(broken)
            self.assertEqual(error.kind, kind)
            self.assertIn("may still arrive", error.message)
            self.assertTrue(broken.closed)
            self.assertNotIn(TF_KEY, error.message)

    def test_a_good_reply_is_closed_too(self):
        ok = tf_ok()
        self.send(ok)
        self.assertTrue(ok.closed)

    def test_a_huge_or_deeply_nested_reply_is_read_only_up_to_a_limit(self):
        huge = FakeResponse(200, text="x" * 5_000_000)
        error, _ = self.fail(huge)
        self.assertEqual(error.kind, "bad_response")
        self.assertLessEqual(huge.bytes_read, 20_000 + 8192)
        self.assertTrue(huge.closed)
        for text in ("[" * 15_000, '{"a":' * 4_000):
            error, _ = self.fail(FakeResponse(200, text=text))
            self.assertEqual(error.kind, "bad_response")


class KeyNeverLeaksTests(NoNetworkMixin, SimpleTestCase):
    """2Factor's API carries the key in the URL path: every place a URL can travel must stay clean."""

    URL = f"{BASE}/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP"

    def fail(self, response=None, side_effect=None):
        with mock.patch(GET, return_value=response, side_effect=side_effect):
            with self.assertRaises(twofactor_client.TwoFactorError) as ctx:
                twofactor_client.send_otp(
                    api_key=TF_KEY, template_name="UKT_HRMS_OTP", mobile="919876543210", code="482913", base_url=BASE
                )
        return ctx.exception

    def assert_clean(self, error, suppressed=False):
        for text in (error.message, str(error), repr(error), str(error.args), repr(error.__dict__)):
            for secret in (TF_KEY, TF_KEY.upper(), "482913", "9876543210"):
                self.assertNotIn(secret, text)
            self.assertNotIn("/API/V1/3f", text)
        self.assertIsNone(error.__cause__)  # the original exception (which quotes the URL) is not chained ...
        if suppressed:
            self.assertTrue(error.__suppress_context__)  # ... nor shown as context

    def test_exceptions_from_requests_that_quote_the_url_are_replaced_by_our_sentence(self):
        quoting = (
            requests.exceptions.ConnectionError(
                f"HTTPSConnectionPool(host='2factor.in', port=443): Max retries exceeded with url: "
                f"/API/V1/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP (Caused by NameResolutionError)"
            ),
            requests.exceptions.ReadTimeout(f"Read timed out. (read timeout=10) for {self.URL}"),
            requests.exceptions.ConnectTimeout(f"timeout for {self.URL}"),
            requests.exceptions.SSLError(f"certificate verify failed for {self.URL}"),
            requests.exceptions.TooManyRedirects(f"Exceeded 30 redirects for {self.URL}"),
            requests.exceptions.InvalidURL(f"Invalid URL {self.URL}"),
            OSError(f"[Errno 111] Connection refused: {self.URL}"),
            RuntimeError(f"bug with {self.URL}"),
        )
        for exc in quoting:
            with self.subTest(exc=type(exc).__name__):
                self.assert_clean(self.fail(side_effect=exc), suppressed=True)

    def test_2factors_own_wording_is_cleaned_of_the_key_in_any_letter_case_and_of_url_paths(self):
        echoes = (
            f"Invalid API Key {TF_KEY}",
            f"Sender not mapped for {TF_KEY.upper()}",
            f"Odd answer at /API/V1/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP",
            f"Odd answer at /api/v1/{TF_KEY.upper()}/SMS/x",
            f"mixed {TF_KEY.swapcase()} and {TF_KEY.title()}",
        )
        for details in echoes:
            with self.subTest(details=details[:30]):
                self.assert_clean(self.fail(tf_error(details)))

    def test_redact_removes_the_key_and_the_key_path_segment(self):
        cases = (
            (f"GET /API/V1/{TF_KEY}/SMS/+919876543210/482913/T 200", "GET /API/V1/…/SMS/+919876543210/482913/T 200"),
            (f"key={TF_KEY.upper()}", "key=…"),
            ("/api/v1/abc/def", "/api/v1/…/def"),
            ("nothing to hide", "nothing to hide"),
            ("", ""),
            (None, ""),
        )
        for text, expected in cases:
            self.assertEqual(twofactor_client.redact(text, TF_KEY), expected)
        self.assertEqual(twofactor_client.redact(f"x {TF_KEY} y", TF_KEY, ""), "x … y")

    def test_urllib3_debug_logging_of_the_request_path_is_redacted(self):
        """urllib3 logs `"GET /API/V1/<key>/SMS/... HTTP/1.1" 200 80` at DEBUG: the filter installed by twofactor_client
        rewrites it before any handler sees it."""
        with captured_logs() as lines:
            logger = logging.getLogger("urllib3.connectionpool")
            logger.debug(
                '%s://%s:%s "%s %s %s" %s %s',
                "https",
                "2factor.in",
                443,
                "GET",
                f"/API/V1/{TF_KEY}/SMS/+919876543210/482913/UKT_HRMS_OTP",
                "HTTP/1.1",
                200,
                80,
            )
            logging.getLogger("urllib3.util.retry").debug("Incremented Retry for (url='/API/V1/%s/SMS/x')", TF_KEY)
            logging.getLogger("requests").warning("failed: %s", self.URL)
        text = "\n".join(lines)
        self.assertIn("GET /API/V1/…/SMS/", text)  # the line is there, redacted
        self.assertNotIn(TF_KEY, text)
        self.assertNotIn(TF_KEY.upper(), text)

    def test_the_filter_is_installed_on_the_loggers_urllib3_uses(self):
        for name in ("urllib3", "urllib3.connectionpool", "urllib3.util.retry", "requests"):
            self.assertTrue(
                any(isinstance(f, twofactor_client._RedactingFilter) for f in logging.getLogger(name).filters), name
            )
        twofactor_client._install_log_redaction()  # a second call adds nothing
        self.assertEqual(sum(f is twofactor_client._filter for f in logging.getLogger("urllib3").filters), 1)


# ── the OTP flow with 2Factor as the provider ───────────────────────────────


@override_settings(**SMS_CONFIG)
class TwoFactorBase(NoNetworkMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
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
        """Ask for a code: (HTTP response, the code in the SMS or None, the mocked requests.get)."""
        with mock.patch(
            GET, return_value=None if side_effect else (response or tf_ok()), side_effect=side_effect
        ) as get:
            r = self.post("otp/request", {"employeeCode": code, "purpose": purpose})
        return r, (code_in(get.call_args) if get.called else None), get

    def age_last_otp(self, seconds):
        from datetime import timedelta

        from django.utils import timezone

        EmployeeOtp.objects.filter(pk=EmployeeOtp.objects.first().pk).update(
            created_at=timezone.now() - timedelta(seconds=seconds)
        )


class RequestOtpTests(TwoFactorBase):
    def test_the_code_goes_through_2factor_and_the_answer_names_sms(self):
        with mock.patch("api.whatsapp_service.send_notification") as whatsapp:
            r, code, get = self.request_code()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {
                "message": "We've sent a code by SMS to " + "•" * 8 + "5110.",
                "maskedPhone": "•" * 8 + "5110",
                "expiresInSeconds": 300,
                "resendAfterSeconds": 60,
                "channel": "sms",
            },
        )
        whatsapp.assert_not_called()
        get.assert_called_once()
        self.assertEqual(get.call_args.args[0], f"{BASE}/{TF_KEY}/SMS/+918220015110/{code}/UKT_HRMS_OTP")
        self.assertRegex(code, r"^\d{6}$")
        self.assertNotIn(code, r.content.decode())
        self.assertNotIn(TF_KEY, r.content.decode())
        # the code verifies like any other
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": code}).status_code, 200)

    def test_the_log_row_holds_no_key_code_or_number(self):
        _, code, _ = self.request_code()
        log = SmsMessageLog.objects.get()
        self.assertEqual(
            (log.status, log.purpose, log.provider, log.phone_masked, log.employee_id, log.error, log.error_code),
            ("sent", "login", "twofactor", "•" * 8 + "5110", self.emp.id, "", ""),
        )
        self.assertEqual(log.provider_message_id, SESSION)
        dump = " ".join(str(getattr(log, f.attname)) for f in log._meta.concrete_fields)
        for secret in (TF_KEY, code, "8220015110", "UKT_HRMS_OTP"):
            self.assertNotIn(secret, dump)

    def test_every_failure_discards_the_code_logs_a_clean_row_and_never_shows_the_key(self):
        quoting = f"HTTPSConnectionPool: Max retries exceeded with url: /API/V1/{TF_KEY}/SMS/+918220015110/000000/UKT_HRMS_OTP"
        cases = (
            (tf_error("Invalid API Key"), None, "auth"),
            (tf_error(f"Odd {TF_KEY} thing"), None, "rejected"),
            (None, requests.exceptions.ConnectionError(quoting), "connection"),
            (None, requests.exceptions.ReadTimeout(quoting), "timeout"),
            (FakeResponse(200, text="<html>oops</html>"), None, "bad_response"),
        )
        for response, side_effect, kind in cases:
            with self.subTest(kind=kind):
                SmsMessageLog.objects.all().delete()
                with captured_logs() as lines:
                    r, code, _ = self.request_code(response=response, side_effect=side_effect)
                self.assertEqual(r.status_code, 502)
                self.assertEqual(
                    r.json()["error"], "We couldn't send the code by SMS. Please try again in a moment or contact HR."
                )
                row = SmsMessageLog.objects.get()
                self.assertEqual((row.status, row.provider, row.error_code), ("failed", "twofactor", kind))
                audit = json.dumps(
                    list(AuditLog.objects.values("record_description", "old_values", "new_values")), default=str
                )
                everything = "\n".join([r.content.decode(), row.error, audit, *lines])
                for secret in (TF_KEY, TF_KEY.upper(), code or "-", "8220015110"):
                    self.assertNotIn(secret, everything)
                self.assertFalse(EmployeeOtp.objects.exists())

    def test_a_failed_send_leaves_the_previous_code_valid(self):
        _, old, _ = self.request_code()
        self.age_last_otp(61)
        self.assertEqual(self.request_code(response=tf_error("Insufficient balance"))[0].status_code, 502)
        self.assertEqual(self.post("otp/login", {"employeeCode": "E100", "otp": old}).status_code, 200)

    def test_not_configured_means_no_request_and_the_plain_sentence(self):
        for override in (
            dict(TWOFACTOR_API_KEY=""),
            dict(TWOFACTOR_API_KEY="your_2factor_api_key_here"),
            dict(TWOFACTOR_TEMPLATE_NAME=""),
            dict(TWOFACTOR_API_BASE="http://2factor.in/API/V1"),
            dict(SMS_ALLOW_SENDING=False),
        ):
            with self.subTest(override), override_settings(**override):
                r, _, get = self.request_code()
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.json()["error"], "SMS OTP isn't available right now. Please contact HR.")
            get.assert_not_called()
        self.assertFalse(SmsMessageLog.objects.exists())
