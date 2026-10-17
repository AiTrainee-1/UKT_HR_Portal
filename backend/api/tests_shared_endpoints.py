"""
Endpoint Sharing: the public call (/api/shared/<slug>) and the management API (/api/shared-endpoints...).

What is pinned here
-------------------
PUBLIC CALL (shared_endpoint_views.py)
* every check in its order: unknown / disabled / malformed slug, bad / revoked / expired / other-endpoint / malformed key
  (one identical 401), origin allowed / not / missing (allow_no_origin both ways), preflight allowed / denied, 405, rate limit
  (+ Retry-After, per key, cache-less fallback from the access log), unknown / repeated / locked / missing / hostile
  parameters, the date-range limits, the pageSize cap and the page bounds;
* ONLY the selected fields leave (canary columns never appear), constant query count for 1 row vs 200;
* the headers: no-store, nosniff, Vary: Origin, CORS only for an allow-listed origin and never "*" / credentials, header
  injection through Origin, global CORS switched off for this route and unchanged for every other route;
* key checks (constant-time compare, the dummy compare, brute-force shapes, the failed-key limiter, 10 keys, equal prefixes);
* the access log (rows, no row for an unknown slug, a failing write changes nothing, retention purge, failure budget), a
  generic 500 for any exception, an HR token sent as the key is not looked at.
MANAGEMENT API (shared_endpoint_admin_views.py)
* super administrator only on EVERY route (administrator, HR role with every permission, branch login, branch-tied super
  administrator, employee token, QR token, disabled account, no token);
* create / replace / delete rules, the sensitive-field confirmation, limits (100 endpoints, 20 origins, 10 live keys), the
  origin validation table, all-or-nothing PUT, the stale guard, no-op PUT, hostile bodies;
* keys: shown once, stored only as SHA-256 (the plaintext is in no table and no audit row), revoke is immediate and
  idempotent, expiry rules; preview, activity, guide, list counts with constant queries;
* audit rows (old / new values, never a key) and the vocabulary of the activity pages; concurrent revoke / create.

Run via: python manage.py test api.tests_shared_endpoints
"""

import hashlib
import json
import logging
import random
import re
import threading
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.conf import settings
from django.core.cache import cache
from django.db import DatabaseError, connection, connections
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import shared_datasets as sd
from . import shared_endpoint_views as pub
from .jwt_utils import sign_token
from .md_portal.analytics import activity as activity_rules
from .models import (
    AttendanceDayRecord,
    AuditLog,
    Branch,
    Department,
    Employee,
    HRUser,
    Role,
    SharedEndpoint,
    SharedEndpointAccessLog,
    SharedEndpointKey,
    SharedEndpointOrigin,
)
from .permission_registry import all_module_keys
from .reporting.definitions.employees_admin_audit import AUDIT_ACTIONS, AUDIT_MODULES
from .shared_endpoint_admin_views import normalize_origin

APP = "https://app.example.com"
KEY_FORMAT = re.compile(r"^uks_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$")
INVALID_KEY = {"error": "invalid_key", "message": "The API key is missing or not valid for this endpoint."}

_counter = {"n": 0}


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def admin_headers() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="se_admin", defaults={"password_hash": "x", "is_super_admin": True, "full_name": "Asha Admin"}
    )
    return bearer({"role": "hr", "hrUserId": user.id, "name": "Asha Admin"})


def role_headers(permissions=None, branch=None, super_admin=False, active=True) -> dict:
    _counter["n"] += 1
    role = Role.objects.create(
        name=f"se-role-{_counter['n']}", permissions=permissions or {k: "edit" for k in all_module_keys()}
    )
    user = HRUser.objects.create(
        username=f"se-user-{_counter['n']}",
        password_hash="x",
        role=role,
        branch=branch,
        is_super_admin=super_admin,
        is_active=active,
    )
    return bearer({"role": "hr", "hrUserId": user.id, "name": "Someone"})


def make_endpoint(slug="hr-people", dataset="employees", fields=None, origins=(), **kw) -> SharedEndpoint:
    ep = SharedEndpoint.objects.create(
        slug=slug,
        name=kw.pop("name", "HR people"),
        dataset=dataset,
        fields=fields if fields is not None else ["employeeCode", "firstName", "lastName"],
        **kw,
    )
    SharedEndpointOrigin.objects.bulk_create([SharedEndpointOrigin(endpoint=ep, origin=o) for o in origins])
    return ep


def make_key(ep, label="Website", **kw) -> tuple[str, SharedEndpointKey]:
    plaintext, prefix, digest = pub.generate_key()
    row = SharedEndpointKey.objects.create(endpoint=ep, label=label, prefix=prefix, key_hash=digest, **kw)
    return plaintext, row


def key_headers(key: str, origin: str | None = None) -> dict:
    headers = {"HTTP_AUTHORIZATION": f"Bearer {key}"}
    if origin is not None:
        headers["HTTP_ORIGIN"] = origin
    return headers


def make_employees(n: int, prefix="E") -> list[Employee]:
    Employee.objects.bulk_create(
        [
            Employee(employee_code=f"{prefix}{i:04d}", first_name=f"F{i}", last_name=f"L{i}", status="active")
            for i in range(n)
        ]
    )
    return list(Employee.objects.filter(employee_code__startswith=prefix))


class PublicBase(TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.ep = make_endpoint(origins=[APP])
        self.key, self.key_row = make_key(self.ep)
        self.emp = Employee.objects.create(
            employee_code="UK001",
            first_name="Asha",
            last_name="Kumar",
            status="active",
            employment_type="staff",
            phone="9876543210",
            salary_amount=Decimal("25000"),
            password_hash="CANARY-PASSWORD-HASH",
            bank_account="CANARY-BANK-ACCOUNT",
            id_proof="CANARY-AADHAAR-1234",
            pf_number="CANARY-PF",
            uan_number="CANARY-UAN",
            photo_url="CANARY-PHOTO",
        )

    URL = "/api/shared/hr-people"

    def get(self, url=None, key=None, origin=None, **extra):
        headers = key_headers(self.key if key is None else key, origin)
        headers.update(extra)
        return self.client.get(url or self.URL, **headers)

    def body(self, response):
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()


# ═══ the public call ══════════════════════════════════════════════════════════════════════════════════════════


class EndpointLookupTests(PublicBase):
    def test_a_known_endpoint_answers_with_the_documented_shape(self):
        r = self.get()
        body = self.body(r)
        self.assertEqual(set(body), {"data", "meta"})
        self.assertEqual(
            set(body["meta"]),
            {"endpoint", "dataset", "fields", "page", "pageSize", "total", "hasMore", "generatedAt"},
        )
        self.assertEqual(body["meta"]["endpoint"], "hr-people")
        self.assertEqual(body["meta"]["dataset"], "employees")
        self.assertEqual(body["meta"]["fields"], ["employeeCode", "firstName", "lastName"])
        self.assertEqual((body["meta"]["page"], body["meta"]["pageSize"], body["meta"]["total"]), (1, 50, 1))
        self.assertFalse(body["meta"]["hasMore"])
        self.assertRegex(body["meta"]["generatedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")
        self.assertEqual(body["data"], [{"employeeCode": "UK001", "firstName": "Asha", "lastName": "Kumar"}])
        self.assertEqual(r["Content-Type"], "application/json")

    def test_every_response_carries_the_security_headers(self):
        for response in (
            self.get(),
            self.get(key="nope"),
            self.get(url="/api/shared/missing"),
            self.get(url=self.URL + "?bogus=1"),
            self.client.post(self.URL),
        ):
            with self.subTest(status=response.status_code):
                self.assertEqual(response["Cache-Control"], "no-store")
                self.assertEqual(response["X-Content-Type-Options"], "nosniff")
                self.assertIn("Origin", response["Vary"])
                self.assertEqual(response["Content-Type"], "application/json")

    def test_unknown_and_disabled_endpoints_look_the_same(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(enabled=False)
        disabled = self.get()
        unknown = self.get(url="/api/shared/never-existed")
        self.assertEqual((disabled.status_code, unknown.status_code), (404, 404))
        self.assertEqual(disabled.json(), unknown.json())
        self.assertEqual(disabled.json()["error"], "not_found")
        self.assertNotIn("Access-Control-Allow-Origin", self.get(origin=APP))

    def test_malformed_slugs_are_404_without_touching_the_database(self):
        for slug in (
            "HR-PEOPLE",
            "hr_people",
            "ab",
            "a" * 61,
            "hr people",
            "hr.people",
            "%E2%82%AC-euro",
            "hr-people%00",
            "hr-people%0a",
        ):
            with self.subTest(slug=slug):
                with CaptureQueriesContext(connection) as ctx:
                    r = self.get(url=f"/api/shared/{slug}")
                self.assertEqual(r.status_code, 404)
                self.assertEqual(r.json()["error"], "not_found")
                self.assertFalse([q for q in ctx.captured_queries if "shared_endpoints" in q["sql"]])

    def test_unknown_endpoints_write_no_log_row(self):
        before = SharedEndpointAccessLog.objects.count()
        for _ in range(5):
            self.get(url="/api/shared/never-existed")
        self.assertEqual(SharedEndpointAccessLog.objects.count(), before)

    def test_only_get_and_options_are_supported(self):
        for method in ("post", "put", "patch", "delete", "head", "trace"):
            with self.subTest(method=method):
                r = getattr(self.client, method)(self.URL, **key_headers(self.key))
                self.assertEqual(r.status_code, 405)
                self.assertEqual(r["Allow"], "GET, OPTIONS")
                if method != "head":
                    self.assertEqual(r.json()["error"], "method_not_allowed")
        self.assertEqual(self.emp.__class__.objects.count(), 1)  # nothing was written
        self.assertEqual(SharedEndpointAccessLog.objects.filter(endpoint=self.ep).exclude(error="").count(), 0)


class KeyCheckTests(PublicBase):
    def test_a_valid_key_works_as_bearer_and_as_x_api_key(self):
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(self.client.get(self.URL, HTTP_X_API_KEY=self.key).status_code, 200)
        self.assertEqual(self.client.get(self.URL, HTTP_AUTHORIZATION=f"bearer {self.key}").status_code, 200)
        self.assertEqual(self.client.get(self.URL, HTTP_AUTHORIZATION=f"Bearer   {self.key}  ").status_code, 200)

    def test_every_kind_of_bad_key_gets_the_identical_401(self):
        other_ep = make_endpoint(slug="other-one")
        other_key, _ = make_key(other_ep)
        revoked, row = make_key(self.ep, "Old")
        SharedEndpointKey.objects.filter(pk=row.pk).update(revoked_at=timezone.now())
        expired, _ = make_key(self.ep, "Late", expires_at=timezone.now() - timedelta(seconds=1))
        prefix = self.key[4:12]
        attempts = {
            "none": {},
            "empty bearer": {"HTTP_AUTHORIZATION": "Bearer "},
            "bearer without space": {"HTTP_AUTHORIZATION": "Bearer"},
            "basic scheme": {"HTTP_AUTHORIZATION": "Basic YWJjOmRlZg=="},
            "random": key_headers("uks_abcdefgh_" + "A" * 43),
            "same prefix wrong secret": key_headers(f"uks_{prefix}_" + "B" * 43),
            "truncated": key_headers(self.key[:-1]),
            "extended": key_headers(self.key + "x"),
            "upper-cased": key_headers(self.key.upper()),
            "other endpoint's key": key_headers(other_key),
            "revoked": key_headers(revoked),
            "expired": key_headers(expired),
            "a JWT": bearer({"role": "hr", "hrUserId": 1}),
            "unicode": key_headers("uks_" + "é" * 8 + "_" + "ü" * 43),
            "huge": key_headers("uks_" + "a" * 10_000),
            "spaces": key_headers(self.key.replace("_", " ")),
            "x-api-key wrong": {"HTTP_X_API_KEY": "uks_abcdefgh_" + "C" * 43},
            "x-api-key empty": {"HTTP_X_API_KEY": ""},
            "in the query string": {},
        }
        for name, headers in attempts.items():
            with self.subTest(attempt=name):
                url = self.URL + (f"?key={self.key}&apiKey={self.key}" if name == "in the query string" else "")
                r = self.client.get(url, **headers)
                self.assertEqual(r.status_code, 401)
                self.assertEqual(r.json(), INVALID_KEY)
                self.assertEqual(r["Cache-Control"], "no-store")

    def test_a_key_in_a_cookie_is_not_a_key(self):
        self.client.cookies["Authorization"] = f"Bearer {self.key}"
        self.client.cookies["key"] = self.key
        self.assertEqual(self.client.get(self.URL).status_code, 401)

    def test_the_comparison_is_constant_time_and_a_dummy_one_runs_when_nothing_matches(self):
        with mock.patch.object(pub.hmac, "compare_digest", wraps=pub.hmac.compare_digest) as spy:
            self.assertEqual(self.get().status_code, 200)
            self.assertGreaterEqual(spy.call_count, 1)
            spy.reset_mock()
            self.get(key="uks_zzzzzzzz_" + "Z" * 43)  # no candidate with that prefix
            self.assertEqual(spy.call_count, 1)
            spy.reset_mock()
            self.get(key=f"uks_{self.key[4:12]}_" + "Y" * 43)  # a candidate, wrong secret
            self.assertGreaterEqual(spy.call_count, 1)
            spy.reset_mock()
            self.client.get(self.URL)  # no key at all
            self.assertEqual(spy.call_count, 1)

    def test_revoked_and_expired_keys_stop_at_once(self):
        self.assertEqual(self.get().status_code, 200)
        SharedEndpointKey.objects.filter(pk=self.key_row.pk).update(revoked_at=timezone.now())
        self.assertEqual(self.get().status_code, 401)
        key2, row2 = make_key(self.ep, "Short", expires_at=timezone.now() + timedelta(hours=1))
        self.assertEqual(self.get(key=key2).status_code, 200)
        SharedEndpointKey.objects.filter(pk=row2.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.get(key=key2).status_code, 401)

    def test_a_key_works_on_its_own_endpoint_only(self):
        other = make_endpoint(slug="other-one", fields=["employeeCode"])
        other_key, _ = make_key(other)
        self.assertEqual(self.get(url="/api/shared/other-one", key=other_key).status_code, 200)
        self.assertEqual(self.get(url="/api/shared/other-one").status_code, 401)  # this endpoint's key
        self.assertEqual(self.get(key=other_key).status_code, 401)

    def test_several_keys_and_equal_prefixes_all_work(self):
        keys = [make_key(self.ep, f"K{i}")[0] for i in range(9)]
        for key in keys:
            self.assertEqual(self.get(key=key).status_code, 200)
        # two keys that happen to share a prefix (possible: 36^8) both validate
        _plain, prefix, digest = pub.generate_key()
        a = f"uks_{prefix}_" + "A" * 43
        b = f"uks_{prefix}_" + "B" * 43
        for key in (a, b):
            SharedEndpointKey.objects.create(endpoint=self.ep, label="dup", prefix=prefix, key_hash=pub.hash_key(key))
        self.assertEqual(self.get(key=a).status_code, 200)
        self.assertEqual(self.get(key=b).status_code, 200)
        self.assertEqual(self.get(key=f"uks_{prefix}_" + "C" * 43).status_code, 401)

    def test_brute_force_shapes_all_get_the_same_answer(self):
        rng = random.Random(7)
        alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
        secret_alphabet = alphabet + "ABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
        bodies = set()
        with mock.patch.object(pub, "FAILED_KEY_LIMIT", 10_000):
            for _ in range(120):
                prefix = "".join(rng.choice(alphabet) for _ in range(8))
                secret = "".join(rng.choice(secret_alphabet) for _ in range(43))
                r = self.get(key=f"uks_{prefix}_{secret}")
                self.assertEqual(r.status_code, 401)
                bodies.add(r.content)
            for _ in range(40):  # right prefix, random secret
                secret = "".join(rng.choice(secret_alphabet) for _ in range(43))
                bodies.add(self.get(key=f"uks_{self.key[4:12]}_{secret}").content)
        self.assertEqual(len(bodies), 1)

    def test_the_failed_key_limiter_slows_guessing_but_never_blocks_a_valid_key(self):
        with mock.patch.object(pub, "FAILED_KEY_LIMIT", 3):
            statuses = [self.get(key="uks_abcdefgh_" + "A" * 43).status_code for _ in range(6)]
            self.assertEqual(statuses[:3], [401, 401, 401])
            self.assertEqual(set(statuses[3:]), {429})
            blocked = self.get(key="uks_abcdefgh_" + "A" * 43)
            self.assertEqual(blocked.json()["error"], "rate_limited")
            self.assertTrue(1 <= int(blocked["Retry-After"]) <= 60)
            self.assertEqual(self.get().status_code, 200)  # the right key, same IP: unaffected

    def test_rotating_the_first_forwarded_hop_does_not_evade_the_failed_key_limiter(self):
        # the caller writes the first hop; only the last one (the platform's proxy) says where the request really came from
        bad = "uks_abcdefgh_" + "A" * 43
        with mock.patch.object(pub, "FAILED_KEY_LIMIT", 3):
            statuses = [
                self.get(key=bad, HTTP_X_FORWARDED_FOR=f"10.1.{i}.{i}, 198.51.100.9").status_code for i in range(6)
            ]
            self.assertEqual(statuses, [401, 401, 401, 429, 429, 429])
            # another real client is counted on its own
            self.assertEqual(self.get(key=bad, HTTP_X_FORWARDED_FOR="10.1.1.1, 198.51.100.10").status_code, 401)
            # and the right key is never limited, whatever the first hop says
            self.assertEqual(self.get(HTTP_X_FORWARDED_FOR="9.9.9.9, 198.51.100.9").status_code, 200)

    def test_no_key_value_is_ever_logged_or_echoed(self):
        secret = "uks_abcdefgh_" + "S" * 43
        with self.assertLogs(level="DEBUG") as logs:
            logging.getLogger("api.shared_endpoints").debug("probe")  # makes assertLogs usable when nothing else logs
            r = self.get(key=secret)
            self.get()
            self.get(url=self.URL + "?bogus=1")
        self.assertNotIn(secret, r.content.decode())
        self.assertNotIn(secret, "\n".join(logs.output))
        self.assertNotIn(self.key, "\n".join(logs.output))
        for row in SharedEndpointAccessLog.objects.all():
            blob = json.dumps({f.name: str(getattr(row, f.name)) for f in row._meta.fields})
            self.assertNotIn(secret, blob)
            self.assertNotIn(self.key, blob)
            self.assertNotIn(self.key[13:], blob)


class OriginAndCorsTests(PublicBase):
    def test_an_allowed_origin_gets_its_own_origin_back_never_a_wildcard(self):
        r = self.get(origin=APP)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)
        self.assertEqual(r["Access-Control-Allow-Headers"], "Authorization, X-API-Key, Content-Type")
        self.assertEqual(r["Access-Control-Allow-Methods"], "GET, OPTIONS")
        self.assertNotIn("Access-Control-Allow-Credentials", r)
        self.assertIn("Origin", r["Vary"])
        self.assertNotEqual(r["Access-Control-Allow-Origin"], "*")

    def test_cors_headers_ride_on_every_response_to_an_allowed_origin_errors_included(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(rate_limit_per_minute=2)
        cases = {
            "401": lambda: self.get(key="uks_abcdefgh_" + "A" * 43, origin=APP),
            "400": lambda: self.get(url=self.URL + "?bogus=1", origin=APP),
            "200": lambda: self.get(origin=APP),
            "429": lambda: self.get(origin=APP),
        }
        for status, call in cases.items():
            r = call()
            with self.subTest(status=status):
                self.assertEqual(str(r.status_code), status)
                self.assertEqual(r["Access-Control-Allow-Origin"], APP)
                self.assertNotIn("Access-Control-Allow-Credentials", r)

    def test_a_429_exposes_retry_after_to_the_browser(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(rate_limit_per_minute=1)
        self.get(origin=APP)
        r = self.get(origin=APP)
        self.assertEqual(r.status_code, 429)
        self.assertIn("Retry-After", r["Access-Control-Expose-Headers"])
        self.assertTrue(r["Retry-After"].isdigit())

    def test_a_disallowed_origin_is_403_without_any_cors_header(self):
        for origin in (
            "https://evil.example.com",
            "http://app.example.com",
            "https://app.example.com:8443",
            "null",
            "https://app.example.com/",
            "https://sub.app.example.com",
            "*",
        ):
            with self.subTest(origin=origin):
                r = self.get(origin=origin)
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.json()["error"], "origin_not_allowed")
                self.assertNotIn("Access-Control-Allow-Origin", r)
                self.assertNotIn("Access-Control-Allow-Credentials", r)

    def test_origin_is_checked_before_the_key(self):
        r = self.get(key="wrong", origin="https://evil.example.com")
        self.assertEqual((r.status_code, r.json()["error"]), (403, "origin_not_allowed"))

    def test_an_origin_with_an_empty_allow_list_is_refused(self):
        SharedEndpointOrigin.objects.filter(endpoint=self.ep).delete()
        r = self.get(origin=APP)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "origin_not_allowed"))
        self.assertEqual(self.get().status_code, 200)  # no Origin header: a server call, allowed by default

    def test_allow_no_origin_both_ways(self):
        self.assertEqual(self.get().status_code, 200)
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(allow_no_origin=False)
        r = self.get()
        self.assertEqual((r.status_code, r.json()["error"]), (403, "origin_required"))
        self.assertNotIn("Access-Control-Allow-Origin", r)
        self.assertEqual(self.get(origin=APP).status_code, 200)  # a listed browser origin still works

    def test_the_origin_match_is_exact_but_case_insensitive(self):
        r = self.get(origin="HTTPS://APP.EXAMPLE.COM")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)

    def test_header_injection_through_origin_is_refused_and_never_echoed(self):
        for origin in (
            APP + "\r\nX-Injected: yes",
            APP + "\nSet-Cookie: a=b",
            APP + ", https://evil.example.com",
            APP + " ",
            " " + APP,
            "https://app.example.com\x00",
            "https://app.exämple.com",
            "",
        ):
            with self.subTest(origin=origin):
                r = self.get(origin=origin)
                self.assertEqual(r.status_code, 403)
                self.assertNotIn("X-Injected", r)
                self.assertNotIn("Set-Cookie", r)
                self.assertNotIn("Access-Control-Allow-Origin", r)
        for row in SharedEndpointAccessLog.objects.exclude(origin=""):
            self.assertTrue(all(32 <= ord(ch) < 127 for ch in row.origin), repr(row.origin))
            self.assertLessEqual(len(row.origin), 255)

    def test_a_huge_origin_header_is_refused_without_a_query(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.get(origin="https://" + "a" * 5000 + ".com")
        self.assertEqual(r.status_code, 403)
        self.assertFalse([q for q in ctx.captured_queries if "shared_endpoint_origins" in q["sql"]])
        self.assertLessEqual(len(SharedEndpointAccessLog.objects.latest("id").origin), 255)

    def test_preflight_from_an_allowed_origin_is_204_without_a_key(self):
        r = self.client.options(
            self.URL,
            HTTP_ORIGIN=APP,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization",
        )
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.content, b"")
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)
        self.assertEqual(r["Access-Control-Allow-Headers"], "Authorization, X-API-Key, Content-Type")
        self.assertEqual(r["Access-Control-Allow-Methods"], "GET, OPTIONS")
        self.assertEqual(r["Access-Control-Max-Age"], "600")
        self.assertNotIn("Access-Control-Allow-Credentials", r)
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertIn("Origin", r["Vary"])

    def test_a_preflight_for_a_disallowed_origin_is_403_without_cors_headers(self):
        r = self.client.options(
            self.URL, HTTP_ORIGIN="https://evil.example.com", HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET"
        )
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", r)
        self.assertNotIn("Access-Control-Max-Age", r)

    def test_a_preflight_works_for_an_endpoint_that_has_no_keys_and_ignores_allow_no_origin(self):
        SharedEndpointKey.objects.all().delete()
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(allow_no_origin=False)
        r = self.client.options(self.URL, HTTP_ORIGIN=APP, HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET")
        self.assertEqual(r.status_code, 204)

    def test_a_preflight_for_unknown_or_disabled_endpoints_is_404(self):
        self.assertEqual(self.client.options("/api/shared/never-existed", HTTP_ORIGIN=APP).status_code, 404)
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(enabled=False)
        r = self.client.options(self.URL, HTTP_ORIGIN=APP)
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("Access-Control-Allow-Origin", r)

    def test_options_without_an_origin_grants_nothing_and_a_granted_preflight_is_not_logged(self):
        r = self.client.options(self.URL)
        self.assertEqual(r.status_code, 204)
        self.assertNotIn("Access-Control-Allow-Origin", r)
        self.client.options(self.URL, HTTP_ORIGIN=APP, HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET")
        self.assertEqual(SharedEndpointAccessLog.objects.count(), 0)
        self.client.options(self.URL, HTTP_ORIGIN="https://evil.example.com")
        self.assertEqual(SharedEndpointAccessLog.objects.filter(status=403, error="origin_not_allowed").count(), 1)


@override_settings(CORS_ALLOWED_ORIGINS=["http://localhost:5173", APP], CORS_ALLOW_CREDENTIALS=True)
class GlobalCorsTests(PublicBase):
    """django-cors-headers must neither decorate nor answer this route, and must still serve every other one."""

    def test_the_global_allow_list_does_not_leak_into_the_shared_route(self):
        r = self.client.options(self.URL, HTTP_ORIGIN="http://localhost:5173", HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET")
        self.assertEqual(r.status_code, 403)  # not this endpoint's origin, whatever the global list says
        self.assertNotIn("Access-Control-Allow-Origin", r)
        self.assertNotIn("Access-Control-Allow-Credentials", r)
        r = self.get(origin="http://localhost:5173")
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", r)

    def test_an_allowed_origin_that_is_also_global_gets_one_header_and_no_credentials(self):
        r = self.get(origin=APP)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)
        self.assertNotIn("Access-Control-Allow-Credentials", r)
        r = self.client.options(self.URL, HTTP_ORIGIN=APP, HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET")
        self.assertEqual(r.status_code, 204)
        self.assertNotIn("Access-Control-Allow-Credentials", r)
        self.assertEqual(r["Access-Control-Max-Age"], "600")

    def test_other_routes_keep_their_global_cors_behaviour(self):
        r = self.client.get("/api/support-contact", HTTP_ORIGIN="http://localhost:5173")
        self.assertEqual(r["Access-Control-Allow-Origin"], "http://localhost:5173")
        self.assertEqual(r["Access-Control-Allow-Credentials"], "true")
        r = self.client.options(
            "/api/shared-endpoints", HTTP_ORIGIN="http://localhost:5173", HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET"
        )
        self.assertEqual(r["Access-Control-Allow-Origin"], "http://localhost:5173")
        r = self.client.get("/api/mobile-app/latest-version", HTTP_ORIGIN="http://localhost:5173")
        self.assertEqual(r["Access-Control-Allow-Origin"], "http://localhost:5173")

    def test_the_url_regex_excludes_only_the_public_route(self):
        regex = settings.CORS_URLS_REGEX
        self.assertIsNone(re.match(regex, "/api/shared/anything"))
        self.assertIsNone(re.match(regex, "/api/shared/"))
        for path in (
            "/api/shared-endpoints",
            "/api/shared-endpoints/3/keys",
            "/api/support-contact",
            "/api/employees",
            "/api/auth/login",
            "/api/shared",
            "/",
            "/iclock/cdata",
        ):
            self.assertTrue(re.match(regex, path), path)


class ParameterTests(PublicBase):
    def error(self, query, expected_param=None, url=None):
        r = self.get(url=(url or self.URL) + query)
        self.assertEqual(r.status_code, 400, r.content[:200])
        body = r.json()
        self.assertEqual(body["error"], "invalid_parameter")
        self.assertTrue(body["message"].endswith("."))
        if expected_param is not None:
            self.assertEqual(body["parameter"], expected_param)
        return body

    def test_unknown_and_repeated_parameters_are_400(self):
        self.assertIn("statuss", self.error("?statuss=active", "statuss")["message"])
        self.error("?employeeCode=UK001&employeeCode=UK002", "employeeCode")
        self.error("?page=1&page=2", "page")
        self.error("?" + "&".join(f"p{i}=1" for i in range(30)))
        self.error("?x%00y=1")
        self.error("?%3Cscript%3E=1")

    def test_more_than_a_thousand_parameters_is_a_400_not_a_500(self):
        # Django refuses to parse more than DATA_UPLOAD_MAX_NUMBER_FIELDS (1000) names: that used to surface as a 500
        self.assertEqual(settings.DATA_UPLOAD_MAX_NUMBER_FIELDS, 1000)
        for count in (1001, 1500):
            with self.subTest(count=count):
                body = self.error("?" + "&".join("a" for _ in range(count)), "query")
                self.assertEqual(body["message"], "Too many parameters.")
        r = self.get(url=self.URL + "?" + "&".join("a" for _ in range(1500)), origin=APP)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)  # an error to an allowed origin still carries CORS
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").error, "invalid_parameter")
        self.assertEqual(self.get(url=self.URL + "?" + "&".join(f"p{i}=1" for i in range(25))).status_code, 400)

    def test_an_over_long_query_string_is_a_400_before_it_is_parsed(self):
        body = self.error("?employeeCode=" + "a" * 9000, "query")
        self.assertEqual(body["message"], "The query string is too long.")
        self.error("?" + "&".join(f"p{i}=1" for i in range(2000)), "query")
        self.assertEqual(self.get(url=self.URL + "?employeeCode=" + "a" * 30).status_code, 200)  # near the cap, fine
        self.assertEqual(self.get(url=self.URL + "?employeeCode=UK001").status_code, 200)

    def test_a_huge_query_string_is_not_parsed_before_the_key_is_checked(self):
        r = self.get(key="nope", url=self.URL + "?" + "&".join("a" for _ in range(1500)))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), INVALID_KEY)

    def test_the_external_flag_filter_narrows_the_employees_and_can_be_locked(self):
        # every matching employee is shared by default (the flag is ignored); visibleToExternal=true shares only the opted-in
        Employee.objects.create(
            employee_code="UK-EXT", first_name="Out", last_name="Ward", status="active", co_emp_enabled=True
        )
        self.assertEqual(self.body(self.get())["meta"]["total"], 2)
        self.assertEqual(self.body(self.get(url=self.URL + "?visibleToExternal=false"))["meta"]["total"], 2)
        only = self.body(self.get(url=self.URL + "?visibleToExternal=true"))
        self.assertEqual([r["employeeCode"] for r in only["data"]], ["UK-EXT"])
        for bad in ("yes", "1", "TRUE", ""):
            with self.subTest(value=bad):
                self.error("?visibleToExternal=" + bad, "visibleToExternal")
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(locked_filters={"visibleToExternal": "true"})
        locked = self.body(self.get())
        self.assertEqual([r["employeeCode"] for r in locked["data"]], ["UK-EXT"])
        self.assertIn("fixed", self.error("?visibleToExternal=false", "visibleToExternal")["message"])
        self.assertNotIn("coEmpEnabled", json.dumps(locked))

    def test_a_locked_filter_cannot_be_overridden_and_is_applied(self):
        Employee.objects.create(employee_code="UK-OLD", first_name="Old", last_name="Timer", status="inactive")
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(locked_filters={"status": "inactive"})
        body = self.body(self.get())
        self.assertEqual([r["employeeCode"] for r in body["data"]], ["UK-OLD"])
        e = self.error("?status=all", "status")
        self.assertIn("fixed", e["message"])
        self.error("?status=active", "status")

    def test_filters_are_validated_with_sql_looking_and_unicode_values(self):
        for query in (
            "?employeeCode=x'%20OR%20'1'='1",
            "?employeeCode=UK001';DROP%20TABLE%20employees;--",
            "?employeeCode=%E2%82%AC",
            "?employeeCode=%00",
            "?employeeCode=" + "a" * 41,
            "?employeeCode=",
            "?departmentId=1%20OR%201=1",
            "?departmentId=%D9%A3",
            "?departmentId=0",
            "?departmentId=-1",
            "?departmentId=2147483648",
            "?departmentId=99999999999999999999",
            "?departmentId=1.0",
            "?branchId=abc",
            "?status=ACTIVE",
            "?status=%25",
            "?employmentType=Staff",
        ):
            with self.subTest(query=query):
                self.error(query)
        self.assertEqual(Employee.objects.count(), 1)  # nothing was dropped

    def test_a_valid_filter_narrows_the_rows(self):
        Employee.objects.create(
            employee_code="UK002", first_name="B", last_name="C", status="active", employment_type="production"
        )
        self.assertEqual(self.body(self.get(url=self.URL + "?employeeCode=UK002"))["meta"]["total"], 1)
        self.assertEqual(self.body(self.get(url=self.URL + "?employmentType=production"))["meta"]["total"], 1)
        self.assertEqual(self.body(self.get(url=self.URL + "?employmentType=staff"))["meta"]["total"], 1)
        self.assertEqual(self.body(self.get(url=self.URL + "?employeeCode=nobody"))["data"], [])

    def test_paging_bounds(self):
        make_employees(12, "P")
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(page_size_max=5, page_size_default=3)
        body = self.body(self.get())
        self.assertEqual((body["meta"]["page"], body["meta"]["pageSize"], len(body["data"])), (1, 3, 3))
        self.assertTrue(body["meta"]["hasMore"])
        body = self.body(self.get(url=self.URL + "?pageSize=500"))  # capped, not refused
        self.assertEqual((body["meta"]["pageSize"], len(body["data"])), (5, 5))
        for bad in (
            "pageSize=0",
            "pageSize=-1",
            "pageSize=abc",
            "pageSize=1.5",
            "pageSize=",
            "pageSize=%D9%A3",
            "pageSize=99999999",
            "page=0",
            "page=-1",
            "page=abc",
            "page=",
            "page=99999999",
            "page=1000000",
        ):
            with self.subTest(param=bad):
                self.error("?" + bad)
        far = self.body(self.get(url=self.URL + "?page=500"))  # beyond the end: empty, not an error
        self.assertEqual((far["data"], far["meta"]["hasMore"], far["meta"]["total"]), ([], False, 13))

    def test_pages_cover_every_row_once_in_a_stable_order(self):
        make_employees(23, "Q")
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(page_size_default=10, page_size_max=10)
        seen = []
        page = 1
        while True:
            body = self.body(self.get(url=self.URL + f"?page={page}"))
            seen += [r["employeeCode"] for r in body["data"]]
            if not body["meta"]["hasMore"]:
                break
            page += 1
        self.assertEqual(len(seen), 24)
        self.assertEqual(len(set(seen)), 24)
        self.assertEqual(seen, sorted(seen))
        self.assertEqual(page, 3)

    def test_the_dataset_cap_overrides_a_larger_saved_page_size(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(page_size_max=100000, page_size_default=100000)
        self.assertEqual(self.body(self.get())["meta"]["pageSize"], sd.EMPLOYEES.max_page_size)

    def test_deep_offsets_are_refused(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(page_size_max=500)
        self.error("?pageSize=500&page=900", "page")  # (900-1)*500 > 200 000
        self.assertEqual(self.get(url=self.URL + "?pageSize=500&page=400").status_code, 200)


class DateRangeDatasetTests(PublicBase):
    def setUp(self):
        super().setUp()
        self.days = make_endpoint(
            slug="attendance",
            dataset="attendance-days",
            fields=["employeeCode", "date", "status"],
        )
        self.days_key, _ = make_key(self.days)
        AttendanceDayRecord.objects.create(employee=self.emp, date=date(2026, 10, 14), status="present")
        AttendanceDayRecord.objects.create(employee=self.emp, date=date(2026, 9, 1), status="absent")

    def call(self, query, **kw):
        return self.client.get("/api/shared/attendance" + query, **key_headers(self.days_key), **kw)

    def test_the_date_range_is_required(self):
        for query in ("", "?dateFrom=2026-10-01", "?dateTo=2026-10-31"):
            with self.subTest(query=query):
                r = self.call(query)
                self.assertEqual((r.status_code, r.json()["error"]), (400, "invalid_parameter"))
        body = self.call("?dateFrom=2026-10-01&dateTo=2026-10-31").json()
        self.assertEqual([r["date"] for r in body["data"]], ["2026-10-14"])

    def test_the_range_is_at_most_31_days(self):
        self.assertEqual(self.call("?dateFrom=2026-10-01&dateTo=2026-10-31").status_code, 200)
        r = self.call("?dateFrom=2026-10-01&dateTo=2026-11-01")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["parameter"], "dateTo")
        self.assertEqual(self.call("?dateFrom=2026-10-05&dateTo=2026-10-04").status_code, 400)
        self.assertEqual(self.call("?dateFrom=2000-01-01&dateTo=2100-12-31").status_code, 400)

    def test_the_punch_range_is_at_most_7_days(self):
        punches = make_endpoint(
            slug="punches", dataset="attendance-punches", fields=["employeeCode", "date", "time", "source"]
        )
        key, _ = make_key(punches)
        url = "/api/shared/punches"
        self.assertEqual(
            self.client.get(url + "?dateFrom=2026-10-01&dateTo=2026-10-07", **key_headers(key)).status_code, 200
        )
        self.assertEqual(
            self.client.get(url + "?dateFrom=2026-10-01&dateTo=2026-10-08", **key_headers(key)).status_code, 400
        )
        self.assertEqual(self.client.get(url, **key_headers(key)).status_code, 400)

    def test_locked_dates_satisfy_the_required_filters_and_cannot_be_moved(self):
        SharedEndpoint.objects.filter(pk=self.days.pk).update(
            locked_filters={"dateFrom": "2026-10-01", "dateTo": "2026-10-31"}
        )
        self.assertEqual(self.call("").json()["meta"]["total"], 1)
        self.assertEqual(self.call("?dateTo=2026-12-31").status_code, 400)

    def test_payroll_needs_a_month(self):
        pay = make_endpoint(slug="payroll", dataset="payroll-summary", fields=["employeeCode", "grossPay", "netPay"])
        key, _ = make_key(pay)
        self.assertEqual(self.client.get("/api/shared/payroll", **key_headers(key)).status_code, 400)
        self.assertEqual(self.client.get("/api/shared/payroll?month=2026-13", **key_headers(key)).status_code, 400)
        self.assertEqual(self.client.get("/api/shared/payroll?month=2026-09", **key_headers(key)).status_code, 200)


class SelectedFieldsOnlyTests(PublicBase):
    def test_only_the_selected_fields_are_returned_and_no_canary_leaks(self):
        r = self.get()
        raw = r.content.decode()
        for canary in ("CANARY", "9876543210", "25000", "phone", "salary", "password", "bank"):
            self.assertNotIn(canary, raw)
        self.assertEqual(set(r.json()["data"][0]), {"employeeCode", "firstName", "lastName"})

    def test_every_field_selected_still_never_leaks_a_hard_excluded_column(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(fields=[f.key for f in sd.EMPLOYEES.fields])
        r = self.get()
        raw = r.content.decode()
        self.assertNotIn("CANARY", raw)
        row = r.json()["data"][0]
        self.assertEqual(list(row), [f.key for f in sd.EMPLOYEES.fields])
        self.assertEqual(row["phone"], "9876543210")
        self.assertEqual(row["salaryAmount"], 25000.0)

    def test_the_saved_order_is_the_response_order_and_unknown_saved_keys_are_ignored(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(
            fields=["lastName", "bank_account", "employeeCode", "passwordHash", 7]
        )
        body = self.body(self.get())
        self.assertEqual(body["meta"]["fields"], ["lastName", "employeeCode"])
        self.assertEqual(list(body["data"][0]), ["lastName", "employeeCode"])

    def test_the_query_never_selects_unshared_columns(self):
        with CaptureQueriesContext(connection) as ctx:
            self.get()
        sql = " ".join(q["sql"] for q in ctx.captured_queries if '"employees"' in q["sql"] and "SELECT" in q["sql"])
        for column in (
            "password_hash",
            "bank_account",
            "id_proof",
            "pf_number",
            "uan_number",
            "photo_url",
            "salary_amount",
            "phone",
        ):
            self.assertNotIn(column, sql)

    def test_a_row_attribute_added_to_the_model_object_never_appears(self):
        """A canary 'field' glued onto every row object (as a new model column would be) is not in the output."""
        original = sd.shape_rows

        def spying(dataset, field_keys, objects):
            objects = list(objects)
            for obj in objects:
                obj.sneaky_new_column = "CANARY-NEW-COLUMN"
            return original(dataset, field_keys, objects)

        with mock.patch.object(sd, "shape_rows", spying):
            raw = self.get().content.decode()
        self.assertNotIn("CANARY-NEW-COLUMN", raw)

    def test_a_page_costs_the_same_number_of_queries_for_one_row_and_for_two_hundred(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(
            fields=[f.key for f in sd.EMPLOYEES.fields], page_size_max=200, page_size_default=200
        )
        self.get()  # warm: the first call also stamps the key's last_used
        with CaptureQueriesContext(connection) as one:
            self.assertEqual(len(self.body(self.get())["data"]), 1)
        make_employees(199, "Z")
        with CaptureQueriesContext(connection) as many:
            self.assertEqual(len(self.body(self.get())["data"]), 200)
        self.assertEqual(len(one), len(many))
        self.assertLessEqual(len(many), 12)


class RateLimitTests(PublicBase):
    def limited(self, limit):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(rate_limit_per_minute=limit)

    def test_the_limit_is_per_key_and_answers_429_with_retry_after(self):
        self.limited(3)
        for _ in range(3):
            self.assertEqual(self.get().status_code, 200)
        r = self.get()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["error"], "rate_limited")
        self.assertTrue(1 <= int(r["Retry-After"]) <= 60)
        other, _ = make_key(self.ep, "Other")
        self.assertEqual(self.get(key=other).status_code, 200)  # another key has its own minute

    def test_the_limit_holds_even_when_the_cache_is_empty_or_per_process(self):
        """A second worker has its own empty cache: the access log (shared) still enforces the minute."""
        self.limited(3)
        for _ in range(3):
            self.assertEqual(self.get().status_code, 200)
            cache.clear()  # what a different worker process would see
        r = self.get()
        self.assertEqual(r.status_code, 429)
        self.assertTrue(1 <= int(r["Retry-After"]) <= 60)

    def test_the_limit_holds_when_the_cache_is_broken(self):
        self.limited(2)
        with (
            mock.patch.object(pub.cache, "add", side_effect=RuntimeError("cache down")),
            mock.patch.object(pub.cache, "incr", side_effect=RuntimeError("cache down")),
        ):
            self.assertEqual(self.get().status_code, 200)
            self.assertEqual(self.get().status_code, 200)
            self.assertEqual(self.get().status_code, 429)

    def test_calls_older_than_a_minute_do_not_count(self):
        self.limited(2)
        for _ in range(2):
            self.get()
        SharedEndpointAccessLog.objects.update(at=timezone.now() - timedelta(seconds=90))
        cache.clear()
        self.assertEqual(self.get().status_code, 200)

    def test_rejected_calls_do_not_extend_the_block(self):
        self.limited(1)
        self.get()
        for _ in range(3):
            self.assertEqual(self.get().status_code, 429)
        self.assertEqual(SharedEndpointAccessLog.objects.filter(key=self.key_row).exclude(status=429).count(), 1)

    def test_a_bad_parameter_still_uses_the_minute(self):
        self.limited(2)
        self.get(url=self.URL + "?bogus=1")
        self.get(url=self.URL + "?bogus=1")
        self.assertEqual(self.get().status_code, 429)


class AccessLogTests(PublicBase):
    def test_successful_and_failed_calls_are_logged_without_any_key(self):
        # the LAST hop is the one the platform's own proxy added; the first is whatever the caller wrote
        self.get(origin=APP, HTTP_X_FORWARDED_FOR="10.0.0.1, 203.0.113.7")
        self.get(key="uks_abcdefgh_" + "A" * 43)
        self.get(url=self.URL + "?bogus=1")
        self.get(origin="https://evil.example.com")
        rows = list(SharedEndpointAccessLog.objects.order_by("id"))
        self.assertEqual([r.status for r in rows], [200, 401, 400, 403])
        ok, bad_key, bad_param, bad_origin = rows
        self.assertEqual(
            (ok.endpoint_id, ok.endpoint_slug, ok.key_id, ok.rows), (self.ep.id, "hr-people", self.key_row.id, 1)
        )
        self.assertEqual((ok.origin, ok.ip, ok.error), (APP, "203.0.113.7", ""))
        self.assertGreaterEqual(ok.duration_ms, 0)
        self.assertEqual((bad_key.error, bad_key.key_id, bad_key.rows), ("invalid_key", None, 0))
        self.assertEqual(bad_param.error, "invalid_parameter")
        self.assertEqual((bad_origin.error, bad_origin.origin), ("origin_not_allowed", "https://evil.example.com"))

    def test_the_ip_is_validated_before_it_is_stored(self):
        self.get(HTTP_X_FORWARDED_FOR="not an ip; DROP TABLE")
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").ip, "")

    def test_the_client_address_is_the_last_forwarded_hop_not_the_first(self):
        # the first hop is written by the caller (it can be anything); the last one is added by the platform's proxy
        self.get(HTTP_X_FORWARDED_FOR="6.6.6.6, 7.7.7.7, 198.51.100.4")
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").ip, "198.51.100.4")
        self.key_row.refresh_from_db()
        self.assertEqual(self.key_row.last_used_ip, "198.51.100.4")
        self.get(HTTP_X_FORWARDED_FOR="198.51.100.4,    198.51.100.77  ")  # spacing is ignored
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").ip, "198.51.100.77")
        self.get()  # no header at all: the connection's own address
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").ip, "127.0.0.1")
        self.get(HTTP_X_FORWARDED_FOR="198.51.100.4, not-an-ip")  # an unreadable last hop is not stored
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").ip, "")

    def test_an_ipv6_address_is_stored_in_its_canonical_form_without_a_scope_id(self):
        cases = {
            "::1": "::1",
            "2001:DB8:0:0:0:0:0:1": "2001:db8::1",
            "fe80::1%eth0": "fe80::1",
            "::1%" + "a" * 60: "::1",
            "::ffff:203.0.113.7": "203.0.113.7",  # an IPv4 client seen through a dual-stack socket
            "::1%": "",  # a scope id with nothing in it is not an address
            "1.2.3.4%eth0": "",  # a scope id on an IPv4 address is not an address
            "[::1]": "",
            "1.2.3.4:8080": "",
            "x" * 300: "",
        }
        factory = RequestFactory()
        for raw, expected in cases.items():
            with self.subTest(forwarded=raw[:40]):
                found = pub._client_ip(factory.get(self.URL, HTTP_X_FORWARDED_FOR=raw))
                self.assertEqual(found, expected)
                self.assertLessEqual(len(found), 45)

    def test_a_scope_id_address_does_not_stop_the_call_being_logged(self):
        # 60 characters after "::1%" used to make the stored address longer than the varchar(45) column: the insert failed,
        # the call was never logged and the database rate limit never saw it
        r = self.get(HTTP_X_FORWARDED_FOR="::1%" + "a" * 60)
        self.assertEqual(r.status_code, 200)
        row = SharedEndpointAccessLog.objects.latest("id")
        self.assertEqual((row.status, row.key_id, row.ip), (200, self.key_row.id, "::1"))
        self.key_row.refresh_from_db()
        self.assertEqual(self.key_row.last_used_ip, "::1")

    def test_a_call_is_still_logged_when_the_insert_fails_once_it_is_retried_without_the_address(self):
        real_create = SharedEndpointAccessLog.objects.create
        calls = []

        def flaky(**kwargs):
            calls.append(kwargs["ip"])
            if len(calls) == 1:
                raise DatabaseError("value too long for type character varying(45)")
            return real_create(**kwargs)

        with (
            mock.patch.object(SharedEndpointAccessLog.objects, "create", side_effect=flaky),
            self.assertNoLogs("api.shared_endpoints", level="ERROR"),
        ):
            r = self.get(HTTP_X_FORWARDED_FOR="203.0.113.9")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(calls, ["203.0.113.9", ""])
        row = SharedEndpointAccessLog.objects.latest("id")
        self.assertEqual((row.status, row.key_id, row.ip), (200, self.key_row.id, ""))

    def test_an_address_longer_than_the_column_can_never_unlog_a_call(self):
        with mock.patch.object(pub, "_client_ip", return_value="x" * 80):  # a regression of the normaliser
            r = self.get()
        self.assertEqual(r.status_code, 200)
        row = SharedEndpointAccessLog.objects.latest("id")
        self.assertEqual((row.status, row.key_id), (200, self.key_row.id))
        self.assertLessEqual(len(row.ip), 45)

    def test_a_log_write_that_keeps_failing_logs_one_line_never_a_traceback(self):
        with (
            mock.patch.object(SharedEndpointAccessLog, "save", side_effect=DatabaseError("disk full")),
            self.assertLogs("api.shared_endpoints", level="WARNING") as logs,
        ):
            self.assertEqual(self.get().status_code, 200)
            self.assertEqual(self.get(key="nope").status_code, 401)
        self.assertTrue(logs.records)
        for record in logs.records:
            self.assertIsNone(record.exc_info, "a per-call traceback would flood the server log")
            self.assertNotIn("Traceback", record.getMessage())
            self.assertEqual(len(record.getMessage().splitlines()), 1)

    def test_the_database_rate_limit_still_sees_calls_with_an_oversized_forwarded_address(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(rate_limit_per_minute=2)
        scoped = "::1%" + "z" * 60
        with (
            mock.patch.object(pub.cache, "add", side_effect=RuntimeError("cache down")),
            mock.patch.object(pub.cache, "incr", side_effect=RuntimeError("cache down")),
        ):
            statuses = [self.get(HTTP_X_FORWARDED_FOR=scoped).status_code for _ in range(3)]
        self.assertEqual(statuses, [200, 200, 429])
        self.assertEqual(SharedEndpointAccessLog.objects.filter(key=self.key_row, status=200).count(), 2)

    def test_a_revoked_key_is_attached_to_its_row_but_answers_like_any_bad_key(self):
        SharedEndpointKey.objects.filter(pk=self.key_row.pk).update(revoked_at=timezone.now())
        r = self.get()
        self.assertEqual(r.json(), INVALID_KEY)
        row = SharedEndpointAccessLog.objects.latest("id")
        self.assertEqual((row.error, row.key_id), ("key_revoked", self.key_row.id))

    def test_last_used_is_stamped_at_most_once_a_minute(self):
        self.get(HTTP_X_FORWARDED_FOR="198.51.100.4")
        self.key_row.refresh_from_db()
        first = self.key_row.last_used_at
        self.assertIsNotNone(first)
        self.assertEqual(self.key_row.last_used_ip, "198.51.100.4")
        self.get(HTTP_X_FORWARDED_FOR="198.51.100.5")
        self.key_row.refresh_from_db()
        self.assertEqual(self.key_row.last_used_at, first)

    def test_a_failing_log_write_never_changes_the_answer(self):
        with (
            mock.patch.object(SharedEndpointAccessLog, "save", side_effect=DatabaseError("disk full")),
            self.assertLogs("api.shared_endpoints", level="ERROR"),
        ):
            r = self.get()
            bad = self.get(key="nope")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"][0]["employeeCode"], "UK001")
        self.assertEqual(bad.status_code, 401)
        self.assertEqual(SharedEndpointAccessLog.objects.count(), 0)

    def test_a_flood_of_failures_stops_adding_rows(self):
        with mock.patch.object(pub, "FAILURE_LOG_BUDGET", 3), mock.patch.object(pub, "FAILED_KEY_LIMIT", 10_000):
            for _ in range(10):
                self.get(key="uks_abcdefgh_" + "A" * 43)
        self.assertEqual(SharedEndpointAccessLog.objects.filter(status=401).count(), 3)
        self.assertEqual(self.get().status_code, 200)  # successes are always logged
        self.assertEqual(SharedEndpointAccessLog.objects.filter(status=200).count(), 1)

    def test_old_rows_are_purged_at_most_once_an_hour(self):
        old = timezone.now() - timedelta(days=91)
        SharedEndpointAccessLog.objects.create(endpoint=self.ep, endpoint_slug="hr-people", status=200, at=old)
        recent = SharedEndpointAccessLog.objects.create(
            endpoint=self.ep, endpoint_slug="hr-people", status=200, at=timezone.now() - timedelta(days=89)
        )
        self.get()  # the first write of the hour purges
        self.assertFalse(SharedEndpointAccessLog.objects.filter(at__lt=timezone.now() - timedelta(days=90)).exists())
        self.assertTrue(SharedEndpointAccessLog.objects.filter(pk=recent.pk).exists())
        SharedEndpointAccessLog.objects.create(endpoint=self.ep, endpoint_slug="hr-people", status=200, at=old)
        self.get()  # within the same hour: no purge
        self.assertTrue(SharedEndpointAccessLog.objects.filter(at__lt=timezone.now() - timedelta(days=90)).exists())
        cache.clear()  # "an hour later"
        self.get()
        self.assertFalse(SharedEndpointAccessLog.objects.filter(at__lt=timezone.now() - timedelta(days=90)).exists())

    def test_purge_old_logs_function(self):
        for days in (95, 91, 89, 1):
            SharedEndpointAccessLog.objects.create(status=200, at=timezone.now() - timedelta(days=days))
        self.assertEqual(pub.purge_old_logs(force=True), 2)
        self.assertEqual(SharedEndpointAccessLog.objects.count(), 2)

    def test_logs_outlive_a_deleted_endpoint(self):
        self.get()
        slug_rows = SharedEndpointAccessLog.objects.count()
        self.ep.delete()
        self.assertEqual(SharedEndpointAccessLog.objects.count(), slug_rows)
        row = SharedEndpointAccessLog.objects.latest("id")
        self.assertIsNone(row.endpoint_id)
        self.assertEqual(row.endpoint_slug, "hr-people")
        self.assertIsNone(row.key_id)


class RobustnessTests(PublicBase):
    def test_any_unexpected_exception_is_a_generic_500_and_is_logged_server_side(self):
        with (
            mock.patch.object(sd, "build_queryset", side_effect=RuntimeError("SELECT password_hash FROM secrets")),
            self.assertLogs("api.shared_endpoints", level="ERROR") as logs,
        ):
            r = self.get(origin=APP)
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json(), {"error": "server_error", "message": "The server could not complete the request."})
        self.assertNotIn("password_hash", r.content.decode())
        self.assertNotIn("Traceback", r.content.decode())
        self.assertIn("RuntimeError", "\n".join(logs.output))
        self.assertEqual(r["Access-Control-Allow-Origin"], APP)
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertEqual(SharedEndpointAccessLog.objects.latest("id").error, "server_error")

    def test_an_endpoint_that_names_a_missing_dataset_is_a_500_not_a_leak(self):
        SharedEndpoint.objects.filter(pk=self.ep.pk).update(dataset="gone")
        with self.assertLogs("api.shared_endpoints", level="ERROR"):
            r = self.get()
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["error"], "server_error")

    def test_a_failing_bookkeeping_step_still_returns_the_answer(self):
        with (
            mock.patch.object(pub, "_record", side_effect=RuntimeError("boom")),
            self.assertLogs("api.shared_endpoints", level="ERROR"),
        ):
            self.assertEqual(self.get().status_code, 200)

    def test_an_hr_token_sent_as_the_key_is_not_looked_at_by_the_hr_middleware(self):
        user = HRUser.objects.create(username="disabled-hr", password_hash="x", is_active=False)
        token = bearer({"role": "hr", "hrUserId": user.id})
        r = self.client.get(self.URL, **token)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), INVALID_KEY)  # not the middleware's account_disabled
        admin = self.client.get(self.URL, **admin_headers())
        self.assertEqual(admin.json(), INVALID_KEY)

    def test_the_public_route_needs_no_hr_login_but_other_routes_still_do(self):
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(self.client.get("/api/shared-endpoints").status_code, 401)
        self.assertEqual(self.client.get("/api/employees").status_code, 401)

    def test_nothing_is_written_by_a_public_call_except_its_log_and_last_used(self):
        tables = {
            "employees": Employee.objects.count(),
            "audit": AuditLog.objects.count(),
            "endpoints": SharedEndpoint.objects.count(),
            "origins": SharedEndpointOrigin.objects.count(),
            "keys": SharedEndpointKey.objects.count(),
        }
        for _ in range(3):
            self.get(origin=APP)
            self.get(url=self.URL + "?x=1")
        self.assertEqual(
            tables,
            {
                "employees": Employee.objects.count(),
                "audit": AuditLog.objects.count(),
                "endpoints": SharedEndpoint.objects.count(),
                "origins": SharedEndpointOrigin.objects.count(),
                "keys": SharedEndpointKey.objects.count(),
            },
        )
        self.assertEqual(Employee.objects.get(pk=self.emp.pk).phone, "9876543210")


# ═══ management ═══════════════════════════════════════════════════════════════════════════════════════════════


class ManageBase(TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.admin = admin_headers()

    def call(self, method, path, body=None, headers=None, raw=None, content_type="application/json"):
        data = raw if raw is not None else (json.dumps(body) if body is not None else "")
        return self.client.generic(
            method, path, data, content_type=content_type, **(self.admin if headers is None else headers)
        )

    def create(self, **over):
        body = {
            "slug": "hr-people",
            "name": "HR people",
            "dataset": "employees",
            "fields": ["employeeCode", "firstName"],
        }
        body.update(over)
        return self.call("POST", "/api/shared-endpoints", body)

    def make(self, **over):
        r = self.create(**over)
        self.assertEqual(r.status_code, 201, r.content[:300])
        return r.json()

    def put(self, ep, **over):
        return self.call("PUT", f"/api/shared-endpoints/{ep['id']}", over)

    def audits(self, action=None):
        qs = AuditLog.objects.filter(module="shared_endpoints")
        return qs.filter(action=action) if action else qs


ALL_ROUTES = (
    ("GET", "/api/shared-endpoints/catalog", None),
    ("GET", "/api/shared-endpoints", None),
    (
        "POST",
        "/api/shared-endpoints",
        {"slug": "intruder", "name": "x", "dataset": "employees", "fields": ["employeeCode"]},
    ),
    ("GET", "/api/shared-endpoints/{id}", None),
    ("PUT", "/api/shared-endpoints/{id}", {"name": "hacked"}),
    ("DELETE", "/api/shared-endpoints/{id}", None),
    ("GET", "/api/shared-endpoints/{id}/keys", None),
    ("POST", "/api/shared-endpoints/{id}/keys", {"label": "intruder"}),
    ("DELETE", "/api/shared-endpoints/{id}/keys/{kid}", None),
    ("POST", "/api/shared-endpoints/{id}/preview", {}),
    ("GET", "/api/shared-endpoints/{id}/activity", None),
    ("GET", "/api/shared-endpoints/activity", None),
    ("GET", "/api/shared-endpoints/{id}/guide", None),
)


class PermissionTests(ManageBase):
    def test_every_route_is_for_the_super_administrator_alone(self):
        ep = self.make()
        key, row = make_key(SharedEndpoint.objects.get(pk=ep["id"]))
        branch = Branch.objects.create(name="Perm Branch", code="PB1")
        emp = Employee.objects.create(employee_code="PERM1", first_name="P", last_name="Q")
        actors = {
            "HR role with every permission": (role_headers(), 403),
            "branch login with every permission": (role_headers(branch=branch), 403),
            "branch-tied super administrator": (role_headers(super_admin=True, branch=branch), 403),
            "employee token": (bearer({"role": "employee", "employeeId": emp.id}), 403),
            "tea break QR token": (bearer({"role": "tea_break", "employeeId": emp.id}), 403),
            "gate device token": (bearer({"role": "gate_device", "deviceId": 1}), 403),
            "no token": ({}, 401),
            "garbage token": ({"HTTP_AUTHORIZATION": "Bearer not.a.token"}, 401),
        }
        before = (
            SharedEndpoint.objects.count(),
            SharedEndpointKey.objects.count(),
            self.audits().count(),
            SharedEndpoint.objects.get(pk=ep["id"]).name,
        )
        for actor, (headers, expected) in actors.items():
            for method, path, body in ALL_ROUTES:
                url = path.format(id=ep["id"], kid=row.id)
                with self.subTest(actor=actor, route=f"{method} {url}"):
                    r = self.call(method, url, body, headers=headers)
                    self.assertEqual(r.status_code, expected, r.content[:200])
                    self.assertNotIn(key, r.content.decode())
        self.assertEqual(
            before,
            (
                SharedEndpoint.objects.count(),
                SharedEndpointKey.objects.count(),
                self.audits().count(),
                SharedEndpoint.objects.get(pk=ep["id"]).name,
            ),
        )
        self.assertIsNone(SharedEndpointKey.objects.get(pk=row.pk).revoked_at)

    def test_options_without_a_token_does_not_describe_the_management_routes(self):
        # DRF answers OPTIONS with the view's name, docstring and parsers: nothing of that is for a stranger
        ep = self.make()
        _key, row = make_key(SharedEndpoint.objects.get(pk=ep["id"]))
        branch = Branch.objects.create(name="Perm Branch 3", code="PB3")
        strangers = {
            "no token": ({}, 401),
            "garbage token": ({"HTTP_AUTHORIZATION": "Bearer not.a.token"}, 401),
            "HR role with every permission": (role_headers(), 403),
            "branch-tied super administrator": (role_headers(super_admin=True, branch=branch), 403),
        }
        for actor, (headers, expected) in strangers.items():
            for _method, path, _body in ALL_ROUTES:
                url = path.format(id=ep["id"], kid=row.id)
                with self.subTest(actor=actor, route=url):
                    r = self.client.options(url, **headers)
                    self.assertEqual(r.status_code, expected, r.content[:200])
                    body = r.json()
                    self.assertIn("error", body)
                    self.assertTrue(set(body) <= {"error", "code"}, body)  # no name / description / parsers / renderers

    def test_options_for_the_super_administrator_is_a_bodyless_204_with_the_allowed_methods(self):
        ep = self.make()
        r = self.client.options(f"/api/shared-endpoints/{ep['id']}", **self.admin)
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.content, b"")
        self.assertEqual(set(r["Allow"].replace(" ", "").split(",")), {"GET", "PUT", "DELETE", "OPTIONS"})
        self.assertEqual(SharedEndpoint.objects.count(), 1)  # OPTIONS changed nothing

    def test_a_disabled_super_administrator_is_refused(self):
        headers = role_headers(super_admin=True, active=False)
        for method, path, body in ALL_ROUTES[:2]:
            r = self.call(method, path, body, headers=headers)
            self.assertIn(r.status_code, (401, 403))

    def test_a_super_administrator_whose_flag_was_removed_loses_access_at_once(self):
        user = HRUser.objects.get(username="se_admin")
        self.assertEqual(self.call("GET", "/api/shared-endpoints").status_code, 200)
        HRUser.objects.filter(pk=user.pk).update(is_super_admin=False)
        self.assertEqual(self.call("GET", "/api/shared-endpoints").status_code, 403)

    def test_the_branch_message_says_it_is_company_wide(self):
        branch = Branch.objects.create(name="Perm Branch 2", code="PB2")
        r = self.call("GET", "/api/shared-endpoints", headers=role_headers(super_admin=True, branch=branch))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["code"], "company_wide_settings")

    def test_there_is_no_permission_module_for_the_feature(self):
        from .permission_registry import resolve_module

        self.assertIsNone(resolve_module("shared-endpoints"))
        self.assertIsNone(resolve_module("shared-endpoints/3/keys"))
        self.assertIsNone(resolve_module("shared/hr-people"))


class CatalogApiTests(ManageBase):
    def test_the_catalog(self):
        body = self.call("GET", "/api/shared-endpoints/catalog").json()
        self.assertEqual({d["key"] for d in body["datasets"]}, set(sd.DATASETS))
        self.assertTrue(body["hardExcluded"])
        self.assertEqual(body["limits"]["maxEndpoints"], 100)
        self.assertEqual(body["limits"]["maxLiveKeysPerEndpoint"], 10)
        self.assertEqual(body["limits"]["maxOriginsPerEndpoint"], 20)
        emp = next(d for d in body["datasets"] if d["key"] == "employees")
        self.assertEqual(emp["maxPageSize"], 500)
        salary = next(f for f in emp["fields"] if f["key"] == "salaryAmount")
        self.assertEqual(salary["sensitivity"], "financial")
        raw = json.dumps(body).lower()
        for word in ("password_hash", "bank_account", "aadhaar_number", "photo_url"):
            self.assertNotIn(word, raw)
        for dataset in body["datasets"]:
            for field in dataset["fields"]:
                self.assertFalse(sd.name_words(field["key"]) & sd.EXCLUDED_WORDS, field["key"])


class OriginValidationTests(TestCase):
    VALID = {
        "https://app.example.com": "https://app.example.com",
        "HTTPS://App.Example.COM": "https://app.example.com",
        "  https://app.example.com  ": "https://app.example.com",
        "https://app.example.com:8443": "https://app.example.com:8443",
        "https://app.example.com:443": "https://app.example.com",
        "http://localhost": "http://localhost",
        "http://localhost:5173": "http://localhost:5173",
        "http://127.0.0.1:3000": "http://127.0.0.1:3000",
        "http://[::1]:3000": "http://[::1]:3000",
        "http://localhost:80": "http://localhost",
        "https://192.168.1.10:8443": "https://192.168.1.10:8443",
        "https://sub.domain-1.example.co.in": "https://sub.domain-1.example.co.in",
        "https://xn--bcher-kva.example": "https://xn--bcher-kva.example",
        "https://[2001:DB8::1]": "https://[2001:db8::1]",  # browsers write an IPv6 host compressed and lower-case
        "https://[2001:db8:0:0:0:0:0:1]:8443": "https://[2001:db8::1]:8443",
        "http://[0:0:0:0:0:0:0:1]:3000": "http://[::1]:3000",
        "https://example.com:8080": "https://example.com:8080",
        "https://example.com:65535": "https://example.com:65535",
        "https://example.com:1": "https://example.com:1",
    }
    INVALID = (
        "*",
        "null",
        "NULL",
        "",
        "   ",
        "https://*.example.com",
        "*.example.com",
        "https://example.com/",
        "https://example.com/path",
        "https://example.com?x=1",
        "https://example.com#frag",
        "https://user:pw@example.com",
        "https://user@example.com",
        "ftp://example.com",
        "example.com",
        "//example.com",
        "javascript:alert(1)",
        "http://example.com",
        "http://localhost.evil.com",
        "http://127.0.0.1.evil.com",
        "https://exa mple.com",
        "https://exämple.com",
        "https://example.com:0",
        "https://example.com:65536",
        "https://example.com:abc",
        "https://example.com:80808",
        "https://-bad.example.com",
        "https://bad-.example.com",
        "https://a..b.com",
        "https://.example.com",
        "https://example.com.",
        "https://999.999.999.999",
        "https://1.2.3",
        "https://example.com\r\nX-Injected: 1",
        "https://example.com\x00",
        "https://" + "a" * 300 + ".com",
        "https://" + ("a" * 63 + ".") * 5 + "com",
        "https://a_b.example.com",
        "https://[::1",
        "https://[zz::1]",
        "https://[:::]",  # looks like an IPv6 host to a loose pattern, is not one
        "https://[::::::::]",
        "https://[....]",
        "https://[]",
        "https://[1:2:3]",
        "https://[1::2::3]",
        "https://[12345::1]",
        "https://[::ffff:999.1.1.1]",
        "https://[::1]x",
        "https://[::1]:0",
        "https://[::1]:65536",
        "https://:443",
        "https://example.com:",
        "https://example.com:00443",  # a port is written without leading zeros
        "https://example.com:0443",
        "https://example.com:08080",
        "https://example.com:00",
        "https://[::1]:00443",
        "http://localhost:0080",
        "https://example.com:+443",
        "https://example.com:44 3",
        "https://example.com:١٢٣",
        "https:// ",
        "https://",
        "HTTP://LOCALHOST:99999",
        12345,
        None,
        ["https://a.com"],
        {"origin": "https://a.com"},
        True,
    )

    def test_valid_origins_are_normalised(self):
        for raw, expected in self.VALID.items():
            with self.subTest(origin=raw):
                self.assertEqual(normalize_origin(raw), expected)

    def test_invalid_origins_are_refused_with_one_plain_sentence(self):
        from .shared_endpoint_admin_views import ManageError

        for raw in self.INVALID:
            with self.subTest(origin=raw):
                with self.assertRaises(ManageError) as ctx:
                    normalize_origin(raw)
                message = str(ctx.exception)
                self.assertTrue(message.endswith("."))
                self.assertNotIn("\r", message)
                self.assertNotIn("\x00", message)
                self.assertLess(len(message), 220)

    def test_star_and_null_have_their_own_sentences(self):
        from .shared_endpoint_admin_views import ManageError

        for raw, word in (("*", "'*'"), ("null", "'null'"), ("https://*.example.com", "wildcard")):
            with self.assertRaises(ManageError) as ctx:
                normalize_origin(raw)
            self.assertIn(word, str(ctx.exception))


class CreateAndUpdateTests(ManageBase):
    def test_create_returns_the_endpoint_with_defaults_and_audits_it(self):
        r = self.create(origins=[APP], description="  for the intranet  ")
        self.assertEqual(r.status_code, 201)
        ep = r.json()
        self.assertEqual(ep["slug"], "hr-people")
        self.assertEqual(ep["url"], "/api/shared/hr-people")
        self.assertEqual(ep["fields"], ["employeeCode", "firstName"])
        self.assertEqual(ep["origins"], [APP])
        self.assertEqual(ep["description"], "for the intranet")
        self.assertEqual(
            (ep["enabled"], ep["allowNoOrigin"], ep["pageSizeDefault"], ep["pageSizeMax"], ep["rateLimitPerMinute"]),
            (True, True, 50, 200, 60),
        )
        self.assertEqual(
            (ep["liveKeys"], ep["calls24h"], ep["lastCallAt"], ep["createdBy"]), (0, 0, None, "Asha Admin")
        )
        self.assertEqual(ep["lockedFilters"], {})
        self.assertEqual(ep["datasetLabel"], "Employees")
        self.assertRegex(ep["version"], r"^[0-9a-f]{16}$")
        log = self.audits("create").get()
        self.assertEqual(log.record_id, ep["id"])
        self.assertEqual(log.new_values["slug"], "hr-people")
        self.assertEqual(log.new_values["fields"], ["employeeCode", "firstName"])
        self.assertEqual(log.new_values["origins"], [APP])
        self.assertNotIn("sensitiveFieldsAdded", log.new_values)

    def test_a_new_endpoint_exposes_nothing_until_a_key_exists(self):
        self.make()
        self.assertEqual(self.client.get("/api/shared/hr-people").status_code, 401)
        self.assertEqual(
            self.client.get("/api/shared/hr-people", **key_headers("uks_abcdefgh_" + "A" * 43)).status_code, 401
        )

    def test_slug_rules(self):
        for slug in ("hr-people", "abc", "a" * 60, "a-b-c", "123", "---"):
            with self.subTest(good=slug):
                self.assertEqual(self.create(slug=slug).status_code, 201)
        for slug in (
            "ab",
            "a" * 61,
            "HR-people",
            "hr_people",
            "hr people",
            "hr.people",
            "hr/people",
            "é-é-é",
            "",
            None,
            123,
            "hr-people\n",
            "../x",
        ):
            with self.subTest(bad=slug):
                r = self.create(slug=slug)
                self.assertEqual(r.status_code, 400)
                self.assertTrue(r.json()["error"].endswith("."))
        r = self.create(slug="hr-people")
        self.assertEqual(r.status_code, 400)
        self.assertIn("already used", r.json()["error"])

    def test_required_and_invalid_fields_of_the_body(self):
        cases = [
            ({"name": ""}, "name"),
            ({"name": "   "}, "name"),
            ({"name": 5}, "name"),
            ({"name": "x" * 101}, "name"),
            ({"name": "a\x00b"}, "characters"),
            ({"name": "a\ud800b"}, "characters"),
            ({"description": "x" * 501}, "description"),
            ({"description": 5}, "description"),
            ({"dataset": "nope"}, "data set"),
            ({"dataset": None}, "data set"),
            ({"dataset": ["employees"]}, "data set"),
            ({"fields": []}, "at least one"),
            ({"fields": "employeeCode"}, "at least one"),
            ({"fields": None}, "at least one"),
            ({"fields": ["nope"]}, "not a field"),
            ({"fields": ["employeeCode", "employeeCode"]}, "twice"),
            ({"fields": ["password_hash"]}, "not a field"),
            ({"fields": ["bankAccount"]}, "not a field"),
            ({"fields": [5]}, "not a field"),
            ({"fields": [None]}, "not a field"),
            ({"lockedFilters": []}, "object"),
            ({"lockedFilters": {"nope": "1"}}, "not a filter"),
            ({"lockedFilters": {"status": "gone"}}, "Locked filter"),
            ({"lockedFilters": {"departmentId": "x' OR 1=1"}}, "Locked filter"),
            ({"lockedFilters": {"departmentId": True}}, "text or a number"),
            ({"lockedFilters": {"departmentId": [1]}}, "text or a number"),
            ({"lockedFilters": {"visibleToExternal": "yes"}}, "true or false"),
            ({"lockedFilters": {"visibleToExternal": "TRUE"}}, "true or false"),
            ({"lockedFilters": {"visibleToExternal": True}}, "text or a number"),
            ({"allowNoOrigin": "yes"}, "true or false"),
            ({"allowNoOrigin": 1}, "true or false"),
            ({"enabled": "true"}, "true or false"),
            ({"rateLimitPerMinute": 0}, "rate limit"),
            ({"rateLimitPerMinute": 6001}, "rate limit"),
            ({"rateLimitPerMinute": True}, "rate limit"),
            ({"rateLimitPerMinute": "60"}, "rate limit"),
            ({"rateLimitPerMinute": 1.5}, "rate limit"),
            ({"pageSizeMax": 0}, "page size"),
            ({"pageSizeMax": 501}, "page size"),
            ({"pageSizeDefault": 501}, "page size"),
            ({"pageSizeMax": 10, "pageSizeDefault": 11}, "cannot be larger"),
            ({"origins": "https://a.com"}, "list"),
            ({"origins": ["*"]}, "'*'"),
            ({"origins": ["https://a.com", "null"]}, "'null'"),
            ({"origins": [f"https://a{i}.example.com" for i in range(21)]}, "At most 20"),
        ]
        before = SharedEndpoint.objects.count()
        for over, word in cases:
            with self.subTest(over=str(over)[:80]):
                r = self.create(**over)
                self.assertEqual(r.status_code, 400, r.content[:200])
                self.assertIn(word.lower(), r.json()["error"].lower())
                self.assertTrue(r.json()["error"].endswith("."))
        self.assertEqual(SharedEndpoint.objects.count(), before)
        self.assertEqual(self.audits().count(), 0)

    def test_missing_required_keys(self):
        for missing in ("slug", "name", "dataset", "fields"):
            body = {"slug": "hr-people", "name": "HR", "dataset": "employees", "fields": ["employeeCode"]}
            del body[missing]
            r = self.call("POST", "/api/shared-endpoints", body)
            self.assertEqual(r.status_code, 400, missing)
        self.assertEqual(SharedEndpoint.objects.count(), 0)

    def test_duplicate_origins_collapse_and_are_stored_normalised(self):
        ep = self.make(origins=[APP, "HTTPS://APP.EXAMPLE.COM", "https://app.example.com:443", "http://localhost:5173"])
        self.assertEqual(ep["origins"], ["http://localhost:5173", APP])  # stored normalised, listed alphabetically
        self.assertEqual(SharedEndpointOrigin.objects.filter(endpoint_id=ep["id"]).count(), 2)
        many = [f"https://a{i % 5}.example.com" for i in range(50)]  # 50 entries, 5 distinct: fine
        self.assertEqual(len(self.put(ep, origins=many).json()["origins"]), 5)

    def test_twenty_origins_are_the_limit(self):
        ep = self.make(origins=[f"https://a{i}.example.com" for i in range(20)])
        self.assertEqual(len(ep["origins"]), 20)
        r = self.put(ep, origins=[f"https://b{i}.example.com" for i in range(21)])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(SharedEndpointOrigin.objects.filter(endpoint_id=ep["id"]).count(), 20)

    def test_a_hundred_endpoints_are_the_limit(self):
        SharedEndpoint.objects.bulk_create(
            [SharedEndpoint(slug=f"bulk-{i:03d}", name="b", dataset="holidays", fields=["date"]) for i in range(100)]
        )
        r = self.create(slug="one-too-many")
        self.assertEqual(r.status_code, 400)
        self.assertIn("100", r.json()["error"])
        SharedEndpoint.objects.filter(slug="bulk-000").delete()
        self.assertEqual(self.create(slug="one-too-many").status_code, 201)

    def test_page_size_defaults_follow_the_dataset(self):
        ep = self.make(slug="small-set", dataset="holidays", fields=["date", "name"], pageSizeMax=20)
        self.assertEqual((ep["pageSizeMax"], ep["pageSizeDefault"]), (20, 20))
        ep = self.make(slug="big-set", dataset="attendance-days", fields=["date"], pageSizeMax=1000)
        self.assertEqual(ep["pageSizeMax"], 1000)

    def test_sensitive_fields_need_a_confirmation(self):
        r = self.create(fields=["employeeCode", "phone", "salaryAmount"])
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertEqual(body["code"], "sensitive_confirmation_required")
        self.assertEqual(body["fields"], ["phone", "salaryAmount"])
        self.assertIn("phone", body["error"])
        self.assertEqual(SharedEndpoint.objects.count(), 0)
        for falsy in (False, "true", 1, None):
            self.assertEqual(self.create(fields=["phone"], acknowledgeSensitive=falsy).status_code, 400)
        ok = self.create(fields=["employeeCode", "phone", "salaryAmount"], acknowledgeSensitive=True)
        self.assertEqual(ok.status_code, 201)
        self.assertEqual(ok.json()["sensitiveFields"], ["phone", "salaryAmount"])
        log = self.audits("create").get()
        self.assertEqual(log.new_values["sensitiveFieldsAdded"], ["phone", "salaryAmount"])
        self.assertIn("phone", log.record_description)
        self.assertNotIn("acknowledgeSensitive", log.new_values)

    def test_only_newly_selected_sensitive_fields_need_the_confirmation(self):
        ep = self.make(fields=["employeeCode", "phone"], acknowledgeSensitive=True)
        # name change with a sensitive field already shared: no confirmation
        self.assertEqual(self.put(ep, name="Renamed").status_code, 200)
        # keeping the sensitive field while adding a basic one: none
        self.assertEqual(self.put(ep, fields=["employeeCode", "phone", "firstName"]).status_code, 200)
        # adding another sensitive one: needed
        r = self.put(ep, fields=["employeeCode", "phone", "firstName", "email"])
        self.assertEqual((r.status_code, r.json()["fields"]), (400, ["email"]))
        ok = self.put(ep, fields=["employeeCode", "phone", "firstName", "email"], acknowledgeSensitive=True)
        self.assertEqual(ok.status_code, 200)
        update = self.audits("update").order_by("-id").first()
        self.assertEqual(update.new_values["sensitiveFieldsAdded"], ["email"])
        self.assertEqual(update.new_values["fieldsAdded"], ["email"])
        self.assertEqual(update.new_values["fieldsRemoved"], [])
        # removing sensitive fields never needs one
        self.assertEqual(self.put(ep, fields=["employeeCode"]).status_code, 200)

    def test_put_replaces_settings_and_audits_old_and_new_values(self):
        ep = self.make(origins=[APP])
        r = self.put(
            ep,
            name="HR people v2",
            description="new",
            fields=["firstName", "employeeCode"],
            lockedFilters={"status": "all", "departmentId": 4},
            origins=["https://other.example.com"],
            allowNoOrigin=False,
            pageSizeDefault=25,
            pageSizeMax=100,
            rateLimitPerMinute=120,
            enabled=False,
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        body = r.json()
        self.assertEqual(
            (body["name"], body["description"], body["fields"], body["origins"], body["allowNoOrigin"]),
            ("HR people v2", "new", ["firstName", "employeeCode"], ["https://other.example.com"], False),
        )
        self.assertEqual(body["lockedFilters"], {"status": "all", "departmentId": "4"})
        self.assertEqual(
            (body["pageSizeDefault"], body["pageSizeMax"], body["rateLimitPerMinute"], body["enabled"]),
            (25, 100, 120, False),
        )
        self.assertNotEqual(body["version"], ep["version"])
        self.assertEqual(
            set(SharedEndpointOrigin.objects.filter(endpoint_id=ep["id"]).values_list("origin", flat=True)),
            {"https://other.example.com"},
        )
        log = self.audits("update").get()
        self.assertEqual(log.old_values["origins"], [APP])
        self.assertEqual(log.new_values["origins"], ["https://other.example.com"])
        self.assertEqual(log.old_values["rateLimitPerMinute"], 60)
        self.assertEqual(log.new_values["rateLimitPerMinute"], 120)
        self.assertEqual(log.old_values["enabled"], True)
        self.assertEqual(log.new_values["enabled"], False)
        self.assertEqual(log.new_values["fieldsAdded"], [])
        self.assertEqual(log.new_values["fieldsRemoved"], [])

    def test_an_omitted_key_of_a_put_keeps_its_stored_value(self):
        ep = self.make(origins=[APP], rateLimitPerMinute=77, lockedFilters={"status": "all"})
        body = self.put(ep, description="only this").json()
        self.assertEqual(
            (body["rateLimitPerMinute"], body["origins"], body["lockedFilters"]), (77, [APP], {"status": "all"})
        )

    def test_a_put_that_changes_nothing_writes_nothing(self):
        ep = self.make(origins=[APP])
        before = SharedEndpoint.objects.get(pk=ep["id"]).updated_at
        r = self.put(ep, name=ep["name"], fields=ep["fields"], origins=ep["origins"], enabled=True)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], ep["version"])
        self.assertEqual(SharedEndpoint.objects.get(pk=ep["id"]).updated_at, before)
        self.assertEqual(self.audits("update").count(), 0)
        # the GET body sent back as it is (read-only keys included) is also a no-op
        self.assertEqual(self.call("PUT", f"/api/shared-endpoints/{ep['id']}", ep).status_code, 200)
        self.assertEqual(self.audits("update").count(), 0)

    def test_the_put_is_all_or_nothing(self):
        ep = self.make(origins=[APP])
        r = self.put(ep, name="Changed", origins=["https://good.example.com", "*"])
        self.assertEqual(r.status_code, 400)
        r = self.put(ep, name="Changed", rateLimitPerMinute=0)
        self.assertEqual(r.status_code, 400)
        r = self.put(ep, name="Changed", fields=["employeeCode", "salaryAmount"])  # unconfirmed sensitive
        self.assertEqual(r.status_code, 400)
        stored = SharedEndpoint.objects.get(pk=ep["id"])
        self.assertEqual(
            (stored.name, stored.rate_limit_per_minute, stored.fields), ("HR people", 60, ["employeeCode", "firstName"])
        )
        self.assertEqual(list(stored.origins.values_list("origin", flat=True)), [APP])
        self.assertEqual(self.audits("update").count(), 0)

    def test_slug_and_dataset_cannot_change(self):
        ep = self.make()
        r = self.put(ep, slug="renamed")
        self.assertEqual(r.status_code, 400)
        self.assertIn("address", r.json()["error"])
        r = self.put(ep, dataset="holidays", fields=["date"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("data set", r.json()["error"])
        self.assertEqual(self.put(ep, slug="hr-people", dataset="employees", name="same ids").status_code, 200)
        self.assertEqual(SharedEndpoint.objects.get(pk=ep["id"]).dataset, "employees")

    def test_fields_must_belong_to_the_endpoints_dataset(self):
        ep = self.make()
        r = self.put(ep, fields=["date"])  # a holidays field
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.put(ep, fields=[]).status_code, 400)

    def test_the_stale_guard(self):
        ep = self.make()
        self.assertEqual(self.put(ep, name="First change", expectedVersion=ep["version"]).status_code, 200)
        r = self.put(ep, name="Second change", expectedVersion=ep["version"])  # the page still holds the old version
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "stale_settings")
        self.assertEqual(SharedEndpoint.objects.get(pk=ep["id"]).name, "First change")
        fresh = self.call("GET", f"/api/shared-endpoints/{ep['id']}").json()
        self.assertEqual(self.put(ep, name="Third", expectedVersion=fresh["version"]).status_code, 200)
        self.assertEqual(self.put(ep, name="No guard").status_code, 200)  # no expectedVersion: no check

    def test_the_version_changes_with_origins_and_fields(self):
        ep = self.make()
        v1 = ep["version"]
        v2 = self.put(ep, origins=[APP]).json()["version"]
        v3 = self.put(ep, fields=["employeeCode"]).json()["version"]
        self.assertEqual(len({v1, v2, v3}), 3)

    def test_unknown_endpoints_are_404(self):
        for method, path in (
            ("GET", "/api/shared-endpoints/999999"),
            ("PUT", "/api/shared-endpoints/999999"),
            ("DELETE", "/api/shared-endpoints/999999"),
            ("GET", "/api/shared-endpoints/999999/keys"),
            ("POST", "/api/shared-endpoints/999999/keys"),
            ("POST", "/api/shared-endpoints/999999/preview"),
            ("GET", "/api/shared-endpoints/999999/activity"),
            ("GET", "/api/shared-endpoints/999999/guide"),
        ):
            with self.subTest(route=f"{method} {path}"):
                body = {"label": "x"} if path.endswith("/keys") else {}
                self.assertEqual(self.call(method, path, body).status_code, 404)

    def test_absurd_ids_are_404_not_a_server_error(self):
        ep = self.make()
        huge = "99999999999999999999999"
        for method, path in (
            ("GET", f"/api/shared-endpoints/{huge}"),
            ("PUT", f"/api/shared-endpoints/{huge}"),
            ("DELETE", f"/api/shared-endpoints/{huge}"),
            ("GET", f"/api/shared-endpoints/{huge}/keys"),
            ("DELETE", f"/api/shared-endpoints/{ep['id']}/keys/{huge}"),
            ("POST", f"/api/shared-endpoints/{huge}/preview"),
            ("GET", f"/api/shared-endpoints/{huge}/activity"),
            ("GET", f"/api/shared-endpoints/{huge}/guide"),
            ("GET", "/api/shared-endpoints/activity?endpointId=999999999"),
        ):
            with self.subTest(route=f"{method} {path}"):
                r = self.call(method, path, {} if method in ("PUT", "POST") else None)
                self.assertIn(r.status_code, (200, 404), r.content[:200])

    def test_hostile_bodies(self):
        ep = self.make()
        url = f"/api/shared-endpoints/{ep['id']}"
        self.assertEqual(self.call("PUT", url, raw="not json at all").status_code, 400)
        self.assertEqual(self.call("PUT", url, raw="[]").status_code, 400)
        self.assertEqual(self.call("PUT", url, raw='"text"').status_code, 400)
        self.assertEqual(self.call("PUT", url, raw="{}").status_code, 200)
        self.assertEqual(self.call("PUT", url, raw='{"name": "x"}', content_type="text/plain").status_code, 415)
        self.assertEqual(self.call("PUT", url, raw="[" * 100_000 + "]" * 100_000).status_code, 400)
        self.assertEqual(self.call("POST", "/api/shared-endpoints", raw="{").status_code, 400)
        self.assertEqual(
            self.call("POST", "/api/shared-endpoints", raw='{"slug": "x", "name": "\\ud800"}').status_code, 400
        )
        self.assertEqual(SharedEndpoint.objects.get(pk=ep["id"]).name, "HR people")

    def test_disabling_takes_effect_on_the_public_route_at_once(self):
        ep = self.make()
        key = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()["key"]
        self.assertEqual(self.client.get("/api/shared/hr-people", **key_headers(key)).status_code, 200)
        self.put(ep, enabled=False)
        self.assertEqual(self.client.get("/api/shared/hr-people", **key_headers(key)).status_code, 404)
        self.put(ep, enabled=True)
        self.assertEqual(self.client.get("/api/shared/hr-people", **key_headers(key)).status_code, 200)

    def test_deleting_removes_keys_and_origins_but_keeps_the_log(self):
        ep = self.make(origins=[APP])
        key = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()["key"]
        self.client.get("/api/shared/hr-people", **key_headers(key))
        r = self.call("DELETE", f"/api/shared-endpoints/{ep['id']}")
        self.assertEqual(r.json(), {"deleted": True, "id": ep["id"]})
        self.assertFalse(SharedEndpoint.objects.filter(pk=ep["id"]).exists())
        self.assertEqual(SharedEndpointKey.objects.count(), 0)
        self.assertEqual(SharedEndpointOrigin.objects.count(), 0)
        self.assertEqual(self.client.get("/api/shared/hr-people", **key_headers(key)).status_code, 404)
        log = SharedEndpointAccessLog.objects.filter(status=200).get()
        self.assertEqual((log.endpoint_id, log.endpoint_slug), (None, "hr-people"))
        audit = self.audits("delete").get()
        self.assertEqual(audit.old_values["slug"], "hr-people")
        self.assertEqual(audit.record_id, ep["id"])
        self.assertEqual(self.call("DELETE", f"/api/shared-endpoints/{ep['id']}").status_code, 404)
        self.assertEqual(self.create(slug="hr-people").status_code, 201)  # the address is free again


class KeyApiTests(ManageBase):
    def setUp(self):
        super().setUp()
        self.ep = self.make()
        self.keys_url = f"/api/shared-endpoints/{self.ep['id']}/keys"

    def new_key(self, label="Website", **extra):
        r = self.call("POST", self.keys_url, {"label": label, **extra})
        self.assertEqual(r.status_code, 201, r.content[:300])
        return r.json()

    def test_the_plaintext_is_returned_once_and_stored_only_as_a_hash(self):
        r = self.call("POST", self.keys_url, {"label": "  Intranet   site "})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r["Cache-Control"], "no-store")
        body = r.json()
        key = body["key"]
        self.assertRegex(key, KEY_FORMAT)
        self.assertEqual(body["prefix"], key[4:12])
        self.assertEqual(body["label"], "Intranet site")
        self.assertEqual(
            (body["status"], body["revokedAt"], body["expiresAt"], body["lastUsedAt"]), ("active", None, None, None)
        )
        row = SharedEndpointKey.objects.get(pk=body["id"])
        self.assertEqual(row.key_hash, hashlib.sha256(key.encode()).hexdigest())
        self.assertEqual(row.prefix, key[4:12])
        # the plaintext is in no column of any shared table and in no audit row
        for model in (SharedEndpoint, SharedEndpointKey, SharedEndpointOrigin, SharedEndpointAccessLog):
            for obj in model.objects.all():
                blob = json.dumps({f.name: str(getattr(obj, f.name)) for f in obj._meta.fields})
                self.assertNotIn(key, blob)
                self.assertNotIn(key[13:], blob)
        for audit in AuditLog.objects.all():
            blob = json.dumps([audit.record_description, audit.old_values, audit.new_values], default=str)
            self.assertNotIn(key, blob)
            self.assertNotIn(key[13:], blob)
            self.assertNotIn(row.key_hash, blob)
        # never again
        listing = self.call("GET", self.keys_url).json()
        self.assertNotIn(key, json.dumps(listing))
        self.assertNotIn(row.key_hash, json.dumps(listing))
        self.assertNotIn("key", listing["keys"][0])
        self.assertNotIn("keyHash", listing["keys"][0])
        self.assertNotIn(key, self.call("GET", f"/api/shared-endpoints/{self.ep['id']}").content.decode())
        self.assertNotIn(key, self.call("GET", f"/api/shared-endpoints/{self.ep['id']}/guide").content.decode())
        self.assertNotIn(key, self.call("GET", f"/api/shared-endpoints/{self.ep['id']}/activity").content.decode())

    def test_the_audit_names_the_key_by_label_and_prefix_only(self):
        body = self.new_key("Intranet")
        log = self.audits("key_create").get()
        self.assertEqual(log.new_values["label"], "Intranet")
        self.assertEqual(log.new_values["prefix"], body["prefix"])
        self.assertEqual(log.new_values["endpoint"], "hr-people")
        self.assertEqual(log.record_id, self.ep["id"])
        self.assertIn(body["prefix"], log.record_description)
        self.assertNotIn(body["key"], log.record_description)

    def test_keys_are_unique_and_well_formed_across_many_creations(self):
        made = [self.new_key(f"K{i}")["key"] for i in range(10)]
        self.assertEqual(len(set(made)), 10)
        for key in made:
            self.assertRegex(key, KEY_FORMAT)
        self.assertEqual(len({k[4:12] for k in made}), 10)  # (36^8 prefixes: no collision in 10 draws)

    def test_a_created_key_works_and_a_revoked_one_stops_at_once(self):
        body = self.new_key()
        url = "/api/shared/hr-people"
        self.assertEqual(self.client.get(url, **key_headers(body["key"])).status_code, 200)
        r = self.call("DELETE", f"{self.keys_url}/{body['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "revoked")
        self.assertIsNotNone(r.json()["revokedAt"])
        self.assertEqual(self.client.get(url, **key_headers(body["key"])).json(), INVALID_KEY)
        listing = self.call("GET", self.keys_url).json()["keys"]
        self.assertEqual(listing[0]["status"], "revoked")
        self.assertEqual(listing[0]["lastUsedAt"] is not None, True)

    def test_revoking_twice_is_a_no_op_with_one_audit_row(self):
        body = self.new_key()
        first = self.call("DELETE", f"{self.keys_url}/{body['id']}").json()
        second = self.call("DELETE", f"{self.keys_url}/{body['id']}").json()
        self.assertEqual(first["revokedAt"], second["revokedAt"])
        self.assertEqual(self.audits("key_revoke").count(), 1)
        log = self.audits("key_revoke").get()
        self.assertEqual(log.old_values["prefix"], body["prefix"])
        self.assertNotIn(body["key"], json.dumps([log.record_description, log.old_values, log.new_values]))

    def test_a_key_of_another_endpoint_cannot_be_revoked_through_this_one(self):
        other = self.make(slug="other-one")
        other_key = self.call("POST", f"/api/shared-endpoints/{other['id']}/keys", {"label": "x"}).json()
        r = self.call("DELETE", f"{self.keys_url}/{other_key['id']}")
        self.assertEqual(r.status_code, 404)
        self.assertIsNone(SharedEndpointKey.objects.get(pk=other_key["id"]).revoked_at)
        self.assertEqual(self.call("DELETE", f"{self.keys_url}/999999").status_code, 404)

    def test_the_label_is_required_and_bounded(self):
        for label in (None, "", "   ", 5, "x" * 101, "a\x00b"):
            with self.subTest(label=label):
                self.assertEqual(self.call("POST", self.keys_url, {"label": label}).status_code, 400)
        self.assertEqual(self.call("POST", self.keys_url, {}).status_code, 400)
        self.assertEqual(SharedEndpointKey.objects.count(), 0)

    def test_the_expiry_rules(self):
        tomorrow = (timezone.now() + timedelta(days=30)).date().isoformat()
        body = self.new_key("Dated", expiresAt=tomorrow)
        self.assertTrue(body["expiresAt"].endswith("23:59:59+05:30"), body["expiresAt"])
        body = self.new_key("Timed", expiresAt=(timezone.now() + timedelta(hours=2)).isoformat())
        self.assertEqual(body["status"], "active")
        self.new_key("Zulu", expiresAt=(timezone.now() + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.new_key("Blank", expiresAt="")
        self.new_key("Null", expiresAt=None)
        for bad in (
            "2020-01-01",
            (timezone.now() - timedelta(minutes=1)).isoformat(),
            "tomorrow",
            "2026-13-45",
            12345,
            "31/12/2030",
            (timezone.now() + timedelta(days=4000)).date().isoformat(),
            "٢٠٣٠-٠١-٠١",
        ):
            with self.subTest(expires=bad):
                r = self.call("POST", self.keys_url, {"label": "bad", "expiresAt": bad})
                self.assertEqual(r.status_code, 400, r.content[:200])
                self.assertTrue(r.json()["error"].endswith("."))

    def test_an_expired_key_shows_as_expired_and_is_refused(self):
        body = self.new_key("Short", expiresAt=(timezone.now() + timedelta(hours=1)).isoformat())
        SharedEndpointKey.objects.filter(pk=body["id"]).update(expires_at=timezone.now() - timedelta(seconds=5))
        self.assertEqual(self.client.get("/api/shared/hr-people", **key_headers(body["key"])).status_code, 401)
        self.assertEqual(self.call("GET", self.keys_url).json()["keys"][0]["status"], "expired")

    def test_ten_live_keys_are_the_limit_and_revoked_or_expired_ones_do_not_count(self):
        bodies = [self.new_key(f"K{i}") for i in range(10)]
        r = self.call("POST", self.keys_url, {"label": "eleventh"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("10", r.json()["error"])
        self.assertEqual(SharedEndpointKey.objects.count(), 10)
        self.call("DELETE", f"{self.keys_url}/{bodies[0]['id']}")
        self.new_key("replacement")
        SharedEndpointKey.objects.filter(pk=bodies[1]["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.new_key("another")
        self.assertEqual(self.call("POST", self.keys_url, {"label": "again"}).status_code, 400)
        other = self.make(slug="other-one")
        self.assertEqual(
            self.call("POST", f"/api/shared-endpoints/{other['id']}/keys", {"label": "x"}).status_code, 201
        )

    def test_the_list_is_newest_first_with_status_and_never_a_secret(self):
        a = self.new_key("A")
        self.new_key("B")
        rows = self.call("GET", self.keys_url).json()
        self.assertEqual([k["label"] for k in rows["keys"]], ["B", "A"])
        self.assertEqual(rows["maxLiveKeys"], 10)
        self.assertEqual(
            set(rows["keys"][0]),
            {
                "id",
                "label",
                "prefix",
                "createdBy",
                "createdAt",
                "expiresAt",
                "revokedAt",
                "lastUsedAt",
                "lastUsedIp",
                "status",
            },
        )
        self.assertEqual(a["createdBy"], "Asha Admin")


class PreviewApiTests(ManageBase):
    def setUp(self):
        super().setUp()
        self.emp = Employee.objects.create(
            employee_code="UK001",
            first_name="Asha",
            last_name="Kumar",
            status="active",
            phone="9876543210",
            password_hash="CANARY-HASH",
            bank_account="CANARY-BANK",
        )
        Employee.objects.create(employee_code="UK-OLD", first_name="Old", last_name="Timer", status="inactive")
        self.ep = self.make(origins=[APP])
        self.url = f"/api/shared-endpoints/{self.ep['id']}/preview"

    def test_the_preview_shapes_rows_exactly_like_the_public_call(self):
        r = self.call("POST", self.url, {})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["data"], [{"employeeCode": "UK001", "firstName": "Asha"}])
        self.assertEqual(body["meta"]["fields"], ["employeeCode", "firstName"])
        self.assertTrue(body["meta"]["preview"])
        self.assertEqual(body["meta"]["total"], 1)
        self.assertNotIn("CANARY", r.content.decode())
        key = self.call("POST", f"/api/shared-endpoints/{self.ep['id']}/keys", {"label": "k"}).json()["key"]
        public = self.client.get("/api/shared/hr-people", **key_headers(key)).json()
        self.assertEqual(public["data"], body["data"])

    def test_locked_filters_apply_and_cannot_be_overridden_in_a_preview(self):
        self.put(self.ep, lockedFilters={"status": "inactive"})
        self.assertEqual([r["employeeCode"] for r in self.call("POST", self.url, {}).json()["data"]], ["UK-OLD"])
        self.assertEqual(self.call("POST", self.url, {"filters": {"status": "all"}}).status_code, 400)

    def test_filters_limit_and_hostile_input(self):
        make_employees(9, "PV")
        self.assertEqual(len(self.call("POST", self.url, {"limit": 3}).json()["data"]), 3)
        self.assertEqual(len(self.call("POST", self.url, {}).json()["data"]), 5)  # the default is the maximum of 5
        for bad in (
            {"limit": 6},
            {"limit": 0},
            {"limit": -1},
            {"limit": "5"},
            {"limit": True},
            {"filters": []},
            {"filters": {"nope": "1"}},
            {"filters": {"employeeCode": "x' OR '1"}},
            {"filters": {"departmentId": [1]}},
            {"filters": {"departmentId": True}},
        ):
            with self.subTest(body=bad):
                r = self.call("POST", self.url, bad)
                self.assertEqual(r.status_code, 400)
                self.assertTrue(r.json()["error"].endswith("."))
        self.assertEqual(self.call("POST", self.url, {"filters": {"employeeCode": "UK001"}}).json()["meta"]["total"], 1)

    def test_required_filters_are_filled_with_a_recent_window(self):
        days = self.make(slug="days-ep", dataset="attendance-days", fields=["employeeCode", "date"])
        AttendanceDayRecord.objects.create(employee=self.emp, date=timezone.localdate(), status="present")
        r = self.call("POST", f"/api/shared-endpoints/{days['id']}/preview", {})
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(set(r.json()["meta"]["filters"]), {"dateFrom", "dateTo"})
        pay = self.make(
            slug="pay-ep", dataset="payroll-summary", fields=["employeeCode", "netPay"], acknowledgeSensitive=True
        )
        r = self.call("POST", f"/api/shared-endpoints/{pay['id']}/preview", {})
        self.assertEqual(r.status_code, 200)
        self.assertRegex(r.json()["meta"]["filters"]["month"], r"^\d{4}-\d{2}$")
        too_long = self.call(
            "POST",
            f"/api/shared-endpoints/{days['id']}/preview",
            {"filters": {"dateFrom": "2026-01-01", "dateTo": "2026-12-31"}},
        )
        self.assertEqual(too_long.status_code, 400)

    def test_a_preview_needs_no_key_writes_no_log_and_has_no_cors(self):
        r = self.client.generic("POST", self.url, "{}", content_type="application/json", **self.admin, HTTP_ORIGIN=APP)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(SharedEndpointAccessLog.objects.count(), 0)
        self.assertNotIn("Access-Control-Allow-Origin", r)
        self.assertEqual(SharedEndpointKey.objects.count(), 0)

    def test_a_disabled_endpoint_can_still_be_previewed(self):
        self.put(self.ep, enabled=False)
        self.assertEqual(self.call("POST", self.url, {}).status_code, 200)


class ActivityApiTests(ManageBase):
    def setUp(self):
        super().setUp()
        self.ep = self.make(origins=[APP])
        self.other = self.make(slug="other-one", fields=["employeeCode"])
        body = self.call("POST", f"/api/shared-endpoints/{self.ep['id']}/keys", {"label": "Site"}).json()
        self.key, self.prefix = body["key"], body["prefix"]
        okey = self.call("POST", f"/api/shared-endpoints/{self.other['id']}/keys", {"label": "Other"}).json()["key"]
        self.client.get("/api/shared/hr-people", **key_headers(self.key, APP))
        self.client.get("/api/shared/hr-people", **key_headers("uks_abcdefgh_" + "A" * 43))
        self.client.get("/api/shared/hr-people?bogus=1", **key_headers(self.key))
        self.client.get("/api/shared/other-one", **key_headers(okey))

    def test_rows_of_one_endpoint(self):
        body = self.call("GET", f"/api/shared-endpoints/{self.ep['id']}/activity").json()
        self.assertEqual((body["page"], body["pageSize"], body["total"], body["hasMore"]), (1, 50, 3, False))
        self.assertEqual([r["status"] for r in body["items"]], [400, 401, 200])  # newest first
        newest = body["items"][2]
        self.assertEqual(
            set(newest),
            {
                "id",
                "at",
                "endpointId",
                "endpointSlug",
                "keyLabel",
                "keyPrefix",
                "status",
                "rows",
                "origin",
                "ip",
                "durationMs",
                "error",
            },
        )
        self.assertEqual(
            (newest["keyLabel"], newest["keyPrefix"], newest["origin"], newest["rows"]), ("Site", self.prefix, APP, 0)
        )
        self.assertEqual(body["items"][1]["keyLabel"], None)
        self.assertEqual(body["items"][1]["error"], "invalid_key")
        self.assertNotIn(self.key, json.dumps(body))

    def test_filters_and_paging(self):
        url = f"/api/shared-endpoints/{self.ep['id']}/activity"
        self.assertEqual(self.call("GET", url + "?status=401").json()["total"], 1)
        self.assertEqual(self.call("GET", url + "?status=error").json()["total"], 2)
        self.assertEqual(self.call("GET", url + "?status=ok").json()["total"], 1)
        page = self.call("GET", url + "?pageSize=2&page=2").json()
        self.assertEqual((len(page["items"]), page["hasMore"], page["total"]), (1, False, 3))
        self.assertEqual(self.call("GET", url + "?pageSize=1").json()["hasMore"], True)
        self.assertEqual(self.call("GET", url + "?pageSize=100000").json()["pageSize"], 200)
        for bad in ("?page=0", "?page=x", "?pageSize=0", "?status=abc", "?status=99", "?status=4xx"):
            with self.subTest(query=bad):
                self.assertEqual(self.call("GET", url + bad).status_code, 400)

    def test_across_endpoints(self):
        body = self.call("GET", "/api/shared-endpoints/activity").json()
        self.assertEqual(body["total"], 4)
        self.assertEqual({r["endpointSlug"] for r in body["items"]}, {"hr-people", "other-one"})
        only = self.call("GET", f"/api/shared-endpoints/activity?endpointId={self.other['id']}").json()
        self.assertEqual(only["total"], 1)
        self.assertEqual(self.call("GET", "/api/shared-endpoints/activity?endpointId=abc").status_code, 400)

    def test_constant_queries(self):
        url = f"/api/shared-endpoints/{self.ep['id']}/activity"
        with CaptureQueriesContext(connection) as few:
            self.call("GET", url)
        for _ in range(30):
            self.client.get("/api/shared/hr-people", **key_headers("uks_abcdefgh_" + "A" * 43))
        with CaptureQueriesContext(connection) as many:
            self.call("GET", url)
        self.assertEqual(len(few), len(many))


class GuideApiTests(ManageBase):
    def test_the_generated_guide(self):
        ep = self.make(
            fields=["employeeCode", "phone", "firstName"],
            lockedFilters={"status": "all"},
            origins=[APP],
            acknowledgeSensitive=True,
        )
        key = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()["key"]
        r = self.call("GET", f"/api/shared-endpoints/{ep['id']}/guide")
        self.assertEqual(r.status_code, 200)
        g = r.json()
        self.assertEqual(g["baseUrl"], "http://testserver")
        self.assertEqual(g["url"], "http://testserver/api/shared/hr-people")
        self.assertEqual(g["method"], "GET")
        self.assertEqual([h["name"] for h in g["headers"]], ["Authorization", "X-API-Key", "Accept"])
        self.assertTrue(g["headers"][0]["required"])
        names = [p["name"] for p in g["parameters"]]
        self.assertNotIn("status", names)  # locked
        self.assertEqual(g["lockedFilters"], [{"name": "status", "value": "all"}])
        for name in ("employmentType", "departmentId", "branchId", "employeeCode", "page", "pageSize"):
            self.assertIn(name, names)
        page_size = next(p for p in g["parameters"] if p["name"] == "pageSize")
        self.assertEqual(page_size["default"], "50")
        self.assertIn("200", page_size["description"])
        self.assertEqual(g["pagination"], {"defaultPageSize": 50, "maxPageSize": 200, "rateLimitPerMinute": 60})
        self.assertEqual([f["name"] for f in g["response"]["fields"]], ["employeeCode", "phone", "firstName"])
        self.assertEqual(g["response"]["fields"][1]["sensitivity"], "personal")
        self.assertEqual(g["response"]["sample"]["data"][0]["employeeCode"], "UK0123")
        self.assertEqual(g["response"]["sample"]["meta"]["fields"], ["employeeCode", "phone", "firstName"])
        self.assertEqual({e["status"] for e in g["errors"]}, {400, 401, 403, 404, 405, 429, 500})
        self.assertEqual(set(g["examples"]), {"curl", "javascript", "python", "php", "csharp", "node"})
        for name, code in g["examples"].items():
            self.assertIn("YOUR_API_KEY" if name != "node" else "UKTEX_API_KEY", code, name)
            self.assertIn("/api/shared/hr-people", code, name)
            self.assertNotIn(key, code)
        self.assertEqual(g["access"]["origins"], [APP])
        self.assertTrue(any("any Origin" in n for n in g["access"]["notes"]))
        self.assertNotIn(key, r.content.decode())

    def test_the_external_flag_filter_is_documented_as_a_true_or_false_parameter(self):
        ep = self.make(fields=["employeeCode"])
        g = self.call("GET", f"/api/shared-endpoints/{ep['id']}/guide").json()
        flag = next(p for p in g["parameters"] if p["name"] == "visibleToExternal")
        self.assertEqual(
            (flag["type"], flag["values"], flag["example"], flag["required"]),
            ("boolean", ["true", "false"], "true", False),
        )
        self.assertIn("visible to external", flag["description"].lower())
        locked = self.put(ep, lockedFilters={"visibleToExternal": "true"})
        self.assertEqual(locked.status_code, 200, locked.content[:300])
        self.assertEqual(locked.json()["lockedFilters"], {"visibleToExternal": "true"})
        g = self.call("GET", f"/api/shared-endpoints/{ep['id']}/guide").json()
        self.assertNotIn("visibleToExternal", [p["name"] for p in g["parameters"]])
        self.assertEqual(g["lockedFilters"], [{"name": "visibleToExternal", "value": "true"}])
        catalog = self.call("GET", "/api/shared-endpoints/catalog").json()
        employees = next(d for d in catalog["datasets"] if d["key"] == "employees")
        self.assertIn("visible to external", employees["description"].lower())

    def test_required_parameters_appear_in_the_examples(self):
        ep = self.make(slug="days-ep", dataset="attendance-days", fields=["employeeCode", "date"])
        g = self.call("GET", f"/api/shared-endpoints/{ep['id']}/guide").json()
        required = [p["name"] for p in g["parameters"] if p["required"]]
        self.assertEqual(required, ["dateFrom", "dateTo"])
        self.assertIn("dateFrom=", g["examples"]["curl"])
        self.assertIn("dateTo=", g["examples"]["javascript"])
        # the example the guide gives is itself a valid call
        key = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()["key"]
        url = re.search(r'"(http://testserver[^"]+)"', g["examples"]["curl"]).group(1)
        r = self.client.get(url.replace("http://testserver", ""), **key_headers(key))
        self.assertEqual(r.status_code, 200, r.content[:200])

    def test_the_base_url_follows_the_request_host(self):
        ep = self.make()
        g = self.client.generic(
            "GET", f"/api/shared-endpoints/{ep['id']}/guide", **self.admin, HTTP_HOST="localhost:8000"
        ).json()
        self.assertEqual(g["baseUrl"], "http://localhost:8000")


class ListAndAuditTests(ManageBase):
    def test_the_list_carries_counts(self):
        a = self.make(origins=[APP, "http://localhost:5173"])
        b = self.make(slug="other-one", fields=["employeeCode"])
        key = self.call("POST", f"/api/shared-endpoints/{a['id']}/keys", {"label": "k"}).json()
        self.call("POST", f"/api/shared-endpoints/{a['id']}/keys", {"label": "k2"})
        self.call("DELETE", f"/api/shared-endpoints/{a['id']}/keys/{key['id']}")
        k3 = self.call("POST", f"/api/shared-endpoints/{a['id']}/keys", {"label": "k3"}).json()["key"]
        self.client.get("/api/shared/hr-people", **key_headers(k3))
        self.client.get("/api/shared/hr-people", **key_headers(k3))
        body = self.call("GET", "/api/shared-endpoints").json()
        self.assertEqual(body["limits"]["maxEndpoints"], 100)
        rows = {r["slug"]: r for r in body["endpoints"]}
        self.assertEqual((rows["hr-people"]["liveKeys"], rows["hr-people"]["calls24h"]), (2, 2))
        self.assertIsNotNone(rows["hr-people"]["lastCallAt"])
        self.assertEqual(rows["hr-people"]["origins"], ["http://localhost:5173", APP])
        self.assertEqual(
            (rows["other-one"]["liveKeys"], rows["other-one"]["calls24h"], rows["other-one"]["lastCallAt"]),
            (0, 0, None),
        )
        SharedEndpointAccessLog.objects.update(at=timezone.now() - timedelta(hours=25))
        rows = {r["slug"]: r for r in self.call("GET", "/api/shared-endpoints").json()["endpoints"]}
        self.assertEqual(rows["hr-people"]["calls24h"], 0)
        self.assertIsNotNone(rows["hr-people"]["lastCallAt"])
        self.assertEqual(b["slug"], "other-one")

    def test_the_list_costs_the_same_queries_for_one_endpoint_and_for_fifteen(self):
        self.make(origins=[APP])
        with CaptureQueriesContext(connection) as few:
            self.call("GET", "/api/shared-endpoints")
        for i in range(14):
            ep = self.make(slug=f"bulk-{i:02d}", fields=["employeeCode"], origins=[APP])
            self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"})
        with CaptureQueriesContext(connection) as many:
            self.assertEqual(len(self.call("GET", "/api/shared-endpoints").json()["endpoints"]), 15)
        self.assertEqual(len(few), len(many))

    def test_the_audit_vocabulary_is_registered_for_the_activity_pages(self):
        self.assertIn("shared_endpoints", dict(AUDIT_MODULES))
        for action in ("create", "update", "delete", "key_create", "key_revoke"):
            self.assertIn(action, dict(AUDIT_ACTIONS))
        ep = self.make()
        k = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()
        self.put(ep, name="Renamed")
        self.call("DELETE", f"/api/shared-endpoints/{ep['id']}/keys/{k['id']}")
        self.call("DELETE", f"/api/shared-endpoints/{ep['id']}")
        self.assertEqual(
            list(self.audits().order_by("id").values_list("action", flat=True)),
            ["create", "key_create", "update", "key_revoke", "delete"],
        )
        for log in self.audits():
            rule = activity_rules.classify(log.action, log.module, log.record_description)
            self.assertIsNotNone(rule, log.action)
            self.assertEqual(rule.id, "endpoint-key-created" if log.action == "key_create" else "endpoint-sharing")
            self.assertEqual(log.user_name, "Asha Admin")
            self.assertEqual(log.user_type, "hr")

    def test_audit_rows_never_contain_a_key_or_a_hash(self):
        ep = self.make(origins=[APP])
        k = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "k"}).json()
        self.call("DELETE", f"/api/shared-endpoints/{ep['id']}/keys/{k['id']}")
        digest = hashlib.sha256(k["key"].encode()).hexdigest()
        for log in self.audits():
            blob = json.dumps([log.record_description, log.old_values, log.new_values], default=str)
            self.assertNotIn(k["key"], blob)
            self.assertNotIn(k["key"][13:], blob)
            self.assertNotIn(digest, blob)
            self.assertNotIn("uks_", blob.replace(k["prefix"], ""))


class EndToEndTests(ManageBase):
    def test_create_select_origin_key_call_revoke_call(self):
        Employee.objects.create(
            employee_code="UK001", first_name="Asha", last_name="Kumar", phone="9876543210", status="active"
        )
        dept = Department.objects.create(name="E2E Dept")
        ep = self.make(
            slug="people-feed",
            name="People feed",
            fields=["employeeCode", "fullName", "phone"],
            origins=["https://intranet.example.com"],
            acknowledgeSensitive=True,
            pageSizeDefault=10,
        )
        key = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", {"label": "Intranet"}).json()
        url = "/api/shared/people-feed"
        self.assertEqual(self.client.get(url).status_code, 401)  # no key
        r = self.client.get(url, **key_headers(key["key"], "https://intranet.example.com"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"], [{"employeeCode": "UK001", "fullName": "Asha Kumar", "phone": "9876543210"}])
        self.assertEqual(r["Access-Control-Allow-Origin"], "https://intranet.example.com")
        self.assertEqual(self.client.get(url, **key_headers(key["key"], "https://evil.example.com")).status_code, 403)
        self.assertEqual(self.call("DELETE", f"/api/shared-endpoints/{ep['id']}/keys/{key['id']}").status_code, 200)
        self.assertEqual(
            self.client.get(url, **key_headers(key["key"], "https://intranet.example.com")).status_code, 401
        )
        activity = self.call("GET", f"/api/shared-endpoints/{ep['id']}/activity").json()
        self.assertEqual([i["status"] for i in activity["items"]], [401, 403, 200, 401])
        self.assertEqual(dept.name, "E2E Dept")


class ConcurrencyTests(TransactionTestCase):
    """Real threads on real connections: the row locks of the management API serialise the races."""

    def setUp(self):
        super().setUp()
        cache.clear()
        user = HRUser.objects.create(
            username="se_conc_admin", password_hash="x", is_super_admin=True, full_name="Conc Admin"
        )
        self.admin = bearer({"role": "hr", "hrUserId": user.id, "name": "Conc Admin"})
        self.ep = make_endpoint(slug="conc-ep")

    def run_threads(self, calls):
        results = [None] * len(calls)
        barrier = threading.Barrier(len(calls))

        def worker(i, call):
            try:
                barrier.wait(timeout=10)
                results[i] = call()
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker, args=(i, c)) for i, c in enumerate(calls)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        return results

    def test_concurrent_revokes_of_one_key_both_succeed_with_one_audit_row(self):
        _plain, row = make_key(self.ep)
        url = f"/api/shared-endpoints/{self.ep.id}/keys/{row.id}"
        results = self.run_threads([lambda: Client().delete(url, **self.admin).status_code for _ in range(4)])
        self.assertEqual(results, [200, 200, 200, 200])
        self.assertIsNotNone(SharedEndpointKey.objects.get(pk=row.pk).revoked_at)
        self.assertEqual(AuditLog.objects.filter(module="shared_endpoints", action="key_revoke").count(), 1)

    def test_concurrent_key_creation_never_passes_ten_live_keys(self):
        for i in range(8):
            make_key(self.ep, f"K{i}")
        url = f"/api/shared-endpoints/{self.ep.id}/keys"
        body = json.dumps({"label": "race"})
        results = self.run_threads(
            [
                lambda: Client().post(url, body, content_type="application/json", **self.admin).status_code
                for _ in range(6)
            ]
        )
        self.assertEqual(sorted(results), [201, 201, 400, 400, 400, 400])
        self.assertEqual(SharedEndpointKey.objects.filter(endpoint=self.ep).count(), 10)

    def test_concurrent_creates_of_one_address_make_exactly_one_endpoint(self):
        body = json.dumps({"slug": "same-addr", "name": "x", "dataset": "holidays", "fields": ["date"]})
        results = self.run_threads(
            [
                lambda: (
                    Client()
                    .post("/api/shared-endpoints", body, content_type="application/json", **self.admin)
                    .status_code
                )
                for _ in range(4)
            ]
        )
        self.assertEqual(sorted(results), [201, 400, 400, 400])
        self.assertEqual(SharedEndpoint.objects.filter(slug="same-addr").count(), 1)

    def test_concurrent_puts_serialise_and_the_stale_guard_lets_only_one_through(self):
        ep = Client().get(f"/api/shared-endpoints/{self.ep.id}", **self.admin).json()
        url = f"/api/shared-endpoints/{self.ep.id}"
        calls = [
            (
                lambda n=n: (
                    Client()
                    .put(
                        url,
                        json.dumps({"name": f"Writer {n}", "expectedVersion": ep["version"]}),
                        content_type="application/json",
                        **self.admin,
                    )
                    .status_code
                )
            )
            for n in range(4)
        ]
        results = self.run_threads(calls)
        self.assertEqual(sorted(results), [200, 400, 400, 400])
        self.assertTrue(SharedEndpoint.objects.get(pk=self.ep.pk).name.startswith("Writer"))
        self.assertEqual(AuditLog.objects.filter(module="shared_endpoints", action="update").count(), 1)
