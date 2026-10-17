"""
Per-IP throttling of the public function views (api/throttles.py).

The bug this pins down: DRF's ScopedRateThrottle reads the scope from the VIEW, but these views used to set
`request.throttle_scope` inside their body, after the throttles had already been checked, so NO per-IP throttle ever fired
(40 otp/request and 150 employee-login from one address all passed). `@throttle("scope")` now sits under @api_view, where
@throttle_classes goes.

The clock is frozen and the throttle cache cleared for every test, so nothing here depends on how fast the machine is and
no test can leak a counter into another one.
"""

import os
import re
import runpy
from pathlib import Path
from unittest import mock

from django.conf import settings as dj_settings
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.decorators import api_view
from rest_framework.throttling import SimpleRateThrottle

from . import throttles

# The rates config/settings.py ships (without THROTTLE_RELAXED). The behaviour tests pin them here so they hold on a machine
# whose environment happens to set THROTTLE_RELAXED too.
FACTORY_RATES = {
    "login": "30/min",
    "employee_login": "300/min",
    "otp_request": "300/min",
    "otp_verify": "600/min",
    "gate_submit": "120/min",
}
BASE = Path(dj_settings.BASE_DIR)

# every throttled function view: (url, scope)
ENDPOINTS = (
    ("/api/auth/hr-login", "login"),
    ("/api/auth/employee-login", "employee_login"),
    ("/api/auth/set-password", "employee_login"),
    ("/api/auth/otp/request", "otp_request"),
    ("/api/auth/otp/login", "otp_verify"),
    ("/api/auth/otp/reset-password", "otp_verify"),
    ("/api/auth/otp/activate", "otp_verify"),
    ("/api/gate-devices/login", "login"),
    ("/api/reception-devices/login", "login"),
    ("/api/outpass/gate/no-such-token/submit", "gate_submit"),
    ("/api/visitor/gate/no-such-token/check-phone", "gate_submit"),
    ("/api/visitor/gate/no-such-token/check-employee-phone", "gate_submit"),
    ("/api/visitor/gate/no-such-token/new", "gate_submit"),
    ("/api/visitor/gate/no-such-token/repeat", "gate_submit"),
)


class Clock:
    """A hand-wound clock for the throttle (DRF reads `timer` once per request)."""

    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


# WhatsApp configured (as in tests_otp.py): an unknown employee code is then a plain 404, not "OTP isn't available"
@override_settings(WACLIENT_INSTANCE_ID="INST1234", WACLIENT_ACCESS_TOKEN="tok", WHATSAPP_DEFAULT_COUNTRY_CODE="91")
class ThrottleCase(TestCase):
    """Frozen clock, empty throttle cache, rates as shipped (or as the test sets them)."""

    def setUp(self):
        super().setUp()
        self.clock = Clock()
        patcher = mock.patch.object(SimpleRateThrottle, "timer", staticmethod(self.clock))
        patcher.start()
        self.addCleanup(patcher.stop)
        rates = mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, FACTORY_RATES)
        rates.start()
        self.addCleanup(rates.stop)
        cache.clear()
        self.addCleanup(cache.clear)

    def rates(self, **rates):
        """Change some rates for this test (e.g. otp_request="3/min"); cleaned up with the test."""
        patcher = mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, rates)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, url, body=None, ip="10.0.0.1", **extra):
        return self.client.post(
            url, body if body is not None else {}, content_type="application/json", REMOTE_ADDR=ip, **extra
        )

    def otp_request(self, ip="10.0.0.1", **extra):
        # an unknown employee code: a cheap 404 that still counts as a request
        return self.post("/api/auth/otp/request", {"employeeCode": "NOBODY"}, ip=ip, **extra)


# ── the decorator ───────────────────────────────────────────────────────────


class DecoratorTests(SimpleTestCase):
    def test_a_scope_without_a_rate_fails_when_the_module_is_imported_not_silently(self):
        with self.assertRaises(ImproperlyConfigured):
            throttles.throttle("a_typo_in_the_scope")

    def test_every_scope_the_views_use_has_a_rate(self):
        for scope in {scope for _url, scope in ENDPOINTS}:
            self.assertIn(scope, SimpleRateThrottle.THROTTLE_RATES)
            throttles.throttle(scope)  # does not raise

    def test_it_sets_throttle_classes_where_api_view_reads_them(self):
        @api_view(["POST"])
        @throttles.throttle("login")
        def view(request):  # pragma: no cover - never called
            raise AssertionError

        (cls,) = view.cls.throttle_classes
        self.assertTrue(issubclass(cls, throttles.IpRateThrottle))
        self.assertEqual(cls.scope, "login")

    def test_no_view_sets_a_throttle_scope_on_the_request_any_more(self):
        """The shape of the old bug: `request.throttle_scope = ...` in a function body does nothing."""
        offenders = []
        for path in sorted((BASE / "api").glob("*.py")):
            if path.name.startswith("tests_") or path.name == "throttles.py":
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"\.throttle_scope\s*=", text) or "ScopedRateThrottle]" in text:
                offenders.append(path.name)
        self.assertEqual(offenders, [])


# ── the settings ────────────────────────────────────────────────────────────


class SettingsTests(SimpleTestCase):
    def test_the_shipped_rates_are_the_factory_friendly_ones(self):
        if os.environ.get("THROTTLE_RELAXED", "").strip().lower() in ("1", "true", "yes"):
            self.skipTest("THROTTLE_RELAXED is set in this environment")
        rates = dj_settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        self.assertEqual({scope: rates[scope] for scope in FACTORY_RATES}, FACTORY_RATES)

    def test_throttle_relaxed_lifts_every_rate_for_the_isolated_e2e_stack(self):
        with mock.patch.dict(os.environ, {"THROTTLE_RELAXED": "true"}):
            relaxed = runpy.run_path(str(BASE / "config" / "settings.py"))["REST_FRAMEWORK"]["DEFAULT_THROTTLE_RATES"]
        self.assertEqual(set(relaxed), set(FACTORY_RATES))
        self.assertEqual(set(relaxed.values()), {"100000/min"})
        with mock.patch.dict(os.environ, {"THROTTLE_RELAXED": "false"}):
            normal = runpy.run_path(str(BASE / "config" / "settings.py"))["REST_FRAMEWORK"]["DEFAULT_THROTTLE_RATES"]
        self.assertEqual({scope: normal[scope] for scope in FACTORY_RATES}, FACTORY_RATES)

    def test_the_number_of_proxies_comes_from_the_environment_and_defaults_to_one(self):
        env = {k: v for k, v in os.environ.items() if k != "NUM_PROXIES"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(runpy.run_path(str(BASE / "config" / "settings.py"))["REST_FRAMEWORK"]["NUM_PROXIES"], 1)
        with mock.patch.dict(os.environ, {"NUM_PROXIES": "2"}):
            self.assertEqual(runpy.run_path(str(BASE / "config" / "settings.py"))["REST_FRAMEWORK"]["NUM_PROXIES"], 2)

    def test_the_exception_handler_is_ours(self):
        self.assertEqual(dj_settings.REST_FRAMEWORK["EXCEPTION_HANDLER"], "api.throttles.exception_handler")


# ── the behaviour ───────────────────────────────────────────────────────────


class OneAddressTests(ThrottleCase):
    def test_the_301st_otp_request_from_one_address_is_a_429_with_retry_after_and_the_json_shape(self):
        for n in range(300):
            self.assertEqual(self.otp_request().status_code, 404, f"request {n + 1} must pass the throttle")
        r = self.otp_request()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r["Retry-After"], "60")
        self.assertEqual(
            r.json(),
            {
                "error": "Too many attempts from this network. Please wait 60 seconds and try again.",
                "retryAfterSeconds": 60,
            },
        )
        # ... and it stays blocked until the minute is over, then works again
        self.clock.now += 30
        r = self.otp_request()
        self.assertEqual((r.status_code, r.json()["retryAfterSeconds"]), (429, 30))
        self.clock.now += 31
        self.assertEqual(self.otp_request().status_code, 404)

    def test_the_blocked_request_never_reaches_the_view(self):
        self.rates(otp_request="2/min")
        self.otp_request()
        self.otp_request()
        with mock.patch("api.otp_service.request_otp") as request_otp:
            self.assertEqual(self.otp_request().status_code, 429)
        request_otp.assert_not_called()

    def test_another_address_and_the_other_scopes_are_not_affected(self):
        self.rates(otp_request="3/min")
        for _ in range(3):
            self.assertEqual(self.otp_request("10.0.0.1").status_code, 404)
        self.assertEqual(self.otp_request("10.0.0.1").status_code, 429)
        self.assertEqual(self.otp_request("10.0.0.2").status_code, 404)  # another address
        # the same address on the other scopes
        self.assertEqual(self.post("/api/auth/otp/login", {"employeeCode": "X", "otp": "123456"}).status_code, 400)
        self.assertEqual(self.post("/api/auth/employee-login", {"identifier": "X", "password": "y"}).status_code, 401)
        self.assertEqual(self.post("/api/auth/hr-login", {"username": "x", "password": "y"}).status_code, 401)

    def test_a_legitimate_shop_floor_burst_passes(self):
        """About 250 employees sit behind one NAT address at shift start: each asks for a code / signs in once."""
        for n in range(250):
            self.assertEqual(self.otp_request().status_code, 404, f"otp/request {n + 1}")
        for n in range(250):
            r = self.post("/api/auth/employee-login", {"identifier": f"E{n}", "password": "whatever1"})
            self.assertEqual(r.status_code, 401, f"employee-login {n + 1}")
        for n in range(250):
            r = self.post("/api/auth/otp/login", {"employeeCode": f"E{n}", "otp": "123456"})
            self.assertEqual(r.status_code, 400, f"otp/login {n + 1}")

    def test_the_hr_login_rate_is_a_flood_guard_not_a_lockout_of_the_office(self):
        for n in range(30):
            self.assertEqual(self.post("/api/auth/hr-login", {"username": f"u{n}", "password": "x"}).status_code, 401)
        self.assertEqual(self.post("/api/auth/hr-login", {"username": "u31", "password": "x"}).status_code, 429)

    def test_a_throttled_answer_is_json_in_this_apis_shape_for_every_scope(self):
        for url, scope in ENDPOINTS:
            with self.subTest(url=url):
                cache.clear()
                self.rates(**{scope: "1/min"})
                self.post(url)
                r = self.post(url)
                self.assertEqual(r.status_code, 429)
                self.assertEqual(set(r.json()), {"error", "retryAfterSeconds"})
                self.assertTrue(r["Retry-After"].isdigit())

    def test_other_errors_keep_the_standard_shape(self):
        r = self.client.post("/api/auth/otp/login", "{not json", content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("detail", r.json())


class EveryViewIsWiredTests(ThrottleCase):
    def test_each_throttled_view_counts_against_its_own_scope_and_only_that_one(self):
        """Two calls pass and the third is a 429 for the scope's own rate; the other scopes are wide open, so a view
        wired to the wrong scope would never reach the third call's 429."""
        for url, scope in ENDPOINTS:
            with self.subTest(url=url, scope=scope):
                cache.clear()
                self.rates(**{**dict.fromkeys(FACTORY_RATES, "100000/min"), scope: "2/min"})
                statuses = [self.post(url).status_code for _ in range(3)]
                self.assertNotIn(429, statuses[:2], statuses)
                self.assertEqual(statuses[2], 429, statuses)


class WhoTheClientIsTests(ThrottleCase):
    """REST_FRAMEWORK["NUM_PROXIES"] = 1 (Railway's proxy): the client is the LAST X-Forwarded-For hop, the one that
    proxy appended. The first hop is whatever the caller chose to write."""

    def setUp(self):
        super().setUp()
        self.rates(otp_request="3/min")

    def forwarded(self, first_hop, last_hop="198.51.100.7"):
        # REMOTE_ADDR is the proxy itself: the same for everybody
        return self.otp_request(ip="100.64.0.1", HTTP_X_FORWARDED_FOR=f"{first_hop}, {last_hop}")

    def test_rotating_the_first_hop_does_not_evade_the_limit(self):
        for n in range(3):
            self.assertEqual(self.forwarded(f"203.0.113.{n}").status_code, 404)
        for n in range(3, 40):
            self.assertEqual(self.forwarded(f"203.0.113.{n}").status_code, 429, n)
        # nor does leaving it out or writing garbage
        self.assertEqual(self.otp_request(ip="100.64.0.1", HTTP_X_FORWARDED_FOR="198.51.100.7").status_code, 429)
        self.assertEqual(self.forwarded("not an address").status_code, 429)

    def test_different_clients_behind_the_proxy_are_counted_separately(self):
        for _ in range(3):
            self.forwarded("203.0.113.9", "198.51.100.7")
        self.assertEqual(self.forwarded("203.0.113.9", "198.51.100.7").status_code, 429)
        self.assertEqual(self.forwarded("203.0.113.9", "198.51.100.8").status_code, 404)

    def test_with_no_proxy_in_front_the_socket_address_is_the_client_and_the_header_is_ignored(self):
        config = {**dj_settings.REST_FRAMEWORK, "NUM_PROXIES": 0}
        with override_settings(REST_FRAMEWORK=config):
            for n in range(3):
                self.assertEqual(
                    self.otp_request(ip="100.64.0.1", HTTP_X_FORWARDED_FOR=f"203.0.113.{n}, 198.51.100.7").status_code,
                    404,
                )
            r = self.otp_request(ip="100.64.0.1", HTTP_X_FORWARDED_FOR="203.0.113.77, 198.51.100.99")
            self.assertEqual(r.status_code, 429)
