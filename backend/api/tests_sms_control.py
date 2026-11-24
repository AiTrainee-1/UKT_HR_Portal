"""
SMS Control page API (/api/sms-control/*): overview (status, balance, month, cost, alerts), usage (one month), settings
(the SMS codes switch, validation, cost settings, stale guard, audit), messages, test send (a code through the OTP template,
to an employee or a number), permissions and branch scoping. 2Factor is never contacted (see tests_sms_otp.py for the
mocking rules; the balance read is mocked in every test here).
"""

import calendar
import json
import os
import sys
from datetime import datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from unittest import mock

import requests
from django.core.cache import cache
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import permission_registry, twofactor_client
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import activity as md_activity
from .models import (
    AuditLog,
    Branch,
    Employee,
    EmployeeOtp,
    HRUser,
    Role,
    SmsMessageLog,
    SmsSettings,
    WhatsAppSettings,
)
from .reporting.definitions.employees_admin_audit import AUDIT_ACTIONS, AUDIT_MODULES
from .tests_sms_otp import (
    BASE as TF_BASE,
    GET,
    SMS_CONFIG,
    TEMPLATE_NAME,
    TF_KEY,
    NoNetworkMixin,
    captured_logs,
    code_in,
    provider_error,
    provider_ok,
)

BASE = "/api/sms-control"
BALANCE = "api.twofactor_client.balance"


def _hr(username="sms_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={
            "password_hash": "x",
            "is_super_admin": super_admin,
            "role": role,
            "branch": branch,
            "full_name": username.replace("_", " ").title(),
        },
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.full_name})}"}


def _money(value) -> float:
    return float(Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


@override_settings(**SMS_CONFIG)
class ControlBase(NoNetworkMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()  # the balance is cached: no test may see another's
        self.addCleanup(cache.clear)
        self.balance = mock.patch(BALANCE, return_value=500)
        self.balance_read = self.balance.start()
        self.addCleanup(self.balance.stop)
        SmsSettings.get()  # the row the tests update in place
        self.hr = _hr()
        self.asha = Employee.objects.create(
            employee_code="A1", first_name="Asha", last_name="Kumar", phone="9000000001", status="active"
        )
        self.ravi = Employee.objects.create(
            employee_code="R1", first_name="Ravi", last_name="Nair", phone="9000000002", status="active"
        )

    def row(self, emp=None, status="sent", purpose="login", **kw):
        masked = kw.pop("phone_masked", "•" * 8 + "0001")
        return SmsMessageLog.objects.create(employee=emp, status=status, purpose=purpose, phone_masked=masked, **kw)

    def get(self, path, headers=None, **params):
        return self.client.get(f"{BASE}/{path}", params, **(headers or self.hr))

    def put(self, path, body, headers=None):
        return self.client.put(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def patch(self, path, body, headers=None):
        return self.client.patch(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def post(self, path, body, headers=None):
        return self.client.post(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def audits(self, action=None):
        qs = AuditLog.objects.filter(module="sms_control")
        return qs.filter(action=action) if action else qs

    def sms_codes_on(self):
        SmsSettings.objects.update_or_create(pk=1, defaults={"otp_enabled": True})


class AccessTests(ControlBase):
    ENDPOINTS = (
        ("get", "overview"),
        ("get", "usage"),
        ("get", "messages"),
        ("get", "settings"),
        ("put", "settings"),
        ("patch", "settings"),
        ("post", "test"),
    )

    def call(self, method, path, headers=None):
        if method == "get":
            return self.client.get(f"{BASE}/{path}", **(headers or {}))
        return getattr(self.client, method)(f"{BASE}/{path}", {}, content_type="application/json", **(headers or {}))

    def test_no_token_and_employee_tokens_are_refused(self):
        employee = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.asha.id})}"}
        for method, path in self.ENDPOINTS:
            self.assertEqual(self.call(method, path).status_code, 401, path)
            self.assertEqual(self.call(method, path, employee).status_code, 403, path)

    def test_a_role_with_view_reads_but_cannot_change_or_send(self):
        role = Role.objects.create(name="Viewer", permissions={"sms_control": "view"})
        viewer = _hr("sms_viewer", super_admin=False, role=role)
        for path in ("overview", "usage", "messages", "settings"):
            self.assertEqual(self.get(path, viewer).status_code, 200, path)
        self.assertEqual(self.put("settings", {"otpEnabled": True}, viewer).status_code, 403)
        self.assertEqual(self.patch("settings", {"otpEnabled": True}, viewer).status_code, 403)
        self.assertFalse(SmsSettings.get().otp_enabled)
        with mock.patch(GET) as post:
            self.assertEqual(self.post("test", {"phone": "9876543210"}, viewer).status_code, 403)
        post.assert_not_called()

    def test_a_role_with_edit_can_change_and_send(self):
        role = Role.objects.create(name="Editor", permissions={"sms_control": "edit"})
        editor = _hr("sms_editor", super_admin=False, role=role)
        self.assertEqual(self.put("settings", {"otpEnabled": True}, editor).status_code, 200)
        self.assertTrue(SmsSettings.get().otp_enabled)
        with mock.patch(GET, return_value=provider_ok()):
            r = self.post("test", {"phone": "9876543210"}, editor)
        self.assertEqual((r.status_code, r.json()["ok"]), (200, True))

    def test_each_value_needs_edit_on_its_settings_sub_tab(self):
        role = Role.objects.create(
            name="Limits only",
            permissions={
                "sms_control": "edit",
                "sms_control.settings.switches": "view",
                "sms_control.settings.cost": "hidden",
            },
        )
        clerk = _hr("sms_clerk", super_admin=False, role=role)
        for body, subtab in (
            ({"otpEnabled": True}, "sms_control.settings.switches"),
            ({"otpLoginEnabled": False}, "sms_control.settings.switches"),
            ({"pricePerSms": 0.5}, "sms_control.settings.cost"),
            ({"monthlyBudget": 100}, "sms_control.settings.cost"),
            ({"hourlyCap": 50, "otpEnabled": True}, "sms_control.settings.switches"),  # all or nothing
        ):
            r = self.patch("settings", body, clerk)
            self.assertEqual(
                (r.status_code, r.json()["code"], r.json()["subtabs"]), (403, "permission_denied", [subtab])
            )
            self.assertIn("SMS Control -> Settings", r.json()["error"])
        s = SmsSettings.get()
        self.assertEqual((s.otp_enabled, s.otp_login_enabled, s.hourly_cap, s.price_per_sms), (False, True, 300, None))
        # its own sub-tab saves, also when the page sends the whole section back with the other values unchanged
        doc = self.get("settings").json()
        r = self.put("settings", {**doc, "hourlyCap": 50}, clerk)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(SmsSettings.get().hourly_cap, 50)

    def test_a_role_without_the_module_is_locked_out_of_everything(self):
        role = Role.objects.create(name="Other", permissions={"payroll": "edit", "whatsapp_control": "edit"})
        other = _hr("sms_other", super_admin=False, role=role)
        for method, path in self.ENDPOINTS:
            self.assertEqual(self.call(method, path, other).status_code, 403, f"{method} {path}")

    def test_a_super_admin_always_has_access(self):
        for path in ("overview", "usage", "messages", "settings"):
            self.assertEqual(self.get(path).status_code, 200)

    def test_the_module_is_registered_like_whatsapp_control(self):
        self.assertIn("sms_control", permission_registry.all_module_keys())
        labels = {node["key"]: node["label"] for node in permission_registry.MODULE_TREE}
        self.assertEqual(labels["sms_control"], "SMS Control")
        # its tabs have keys of their own since 2026-11-11, each following "sms_control" until a role sets it
        for path in (
            "sms-control/overview",
            "sms-control/usage",
            "sms-control/settings",
            "sms-control/messages",
            "sms-control/test",
        ):
            key = permission_registry.resolve_module(path)
            self.assertTrue(key == "sms_control" or key.startswith("sms_control."), path)
            self.assertEqual(permission_registry.resolve_permission({"sms_control": "view"}, key), "view", path)
        # ... and WhatsApp Control is a module of its own (its tabs have their own keys too)
        self.assertTrue(permission_registry.resolve_module("whatsapp-control/overview").startswith("whatsapp_control"))

    def test_a_branch_login_can_read_but_not_change_company_settings_or_send_a_test(self):
        north = Branch.objects.create(name="North")
        role = Role.objects.create(name="North HR", permissions={"sms_control": "edit"})
        scoped = _hr("north_sms", super_admin=False, role=role, branch=north)
        self.assertEqual(self.get("settings", scoped).status_code, 200)
        r = self.put("settings", {"otpEnabled": True}, scoped)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "company_wide_settings"))
        self.assertFalse(SmsSettings.get().otp_enabled)
        with mock.patch(GET) as post:
            r = self.post("test", {"phone": "9876543210"}, scoped)
        self.assertEqual((r.status_code, r.json()["code"], r.json()["ok"]), (403, "company_wide_settings", False))
        post.assert_not_called()


class SettingsTests(ControlBase):
    KEYS = {
        "otpEnabled", "otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled", "otpExpiryMinutes",
        "resendCooldownSeconds", "maxRequestsPerHour", "maxAttemptsPerCode", "maxPerPhonePerHour", "hourlyCap",
        "dailyCap", "pricePerSms", "monthlyBudget", "pricePerSmsDefault", "version", "updatedAt", "updatedBy",
        "warnings",
    }  # fmt: skip

    def test_the_defaults_and_the_exact_shape(self):
        body = self.get("settings").json()
        self.assertEqual(set(body), self.KEYS)
        self.assertNotIn("otpChannel", body)
        self.assertEqual(
            {k: body[k] for k in self.KEYS - {"version", "warnings"}},
            {
                "otpEnabled": False, "otpLoginEnabled": True, "otpResetEnabled": True, "otpActivateEnabled": True,
                "otpExpiryMinutes": 5, "resendCooldownSeconds": 60, "maxRequestsPerHour": 5, "maxAttemptsPerCode": 5,
                "maxPerPhonePerHour": 5, "hourlyCap": 300, "dailyCap": 1500, "pricePerSms": 0.2,
                "monthlyBudget": None, "pricePerSmsDefault": 0.2, "updatedAt": None, "updatedBy": None,
            },
        )  # fmt: skip
        self.assertRegex(body["version"], r"^[0-9a-f]{16}$")
        self.assertEqual(body["warnings"], [])  # SMS codes off: nothing to warn about

    def test_a_valid_put_saves_everything_and_reports_who_and_when(self):
        r = self.put(
            "settings",
            {
                "otpEnabled": True, "otpLoginEnabled": False, "otpResetEnabled": True, "otpActivateEnabled": False,
                "otpExpiryMinutes": 10, "resendCooldownSeconds": 90, "maxRequestsPerHour": 8, "maxAttemptsPerCode": 4,
                "maxPerPhonePerHour": 3, "hourlyCap": 50, "dailyCap": 200, "pricePerSms": 0.175, "monthlyBudget": 500,
            },
        )  # fmt: skip
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["otpEnabled"], body["otpLoginEnabled"], body["otpActivateEnabled"]), (True, False, False)
        )
        self.assertEqual((body["otpExpiryMinutes"], body["resendCooldownSeconds"], body["hourlyCap"]), (10, 90, 50))
        self.assertEqual((body["pricePerSms"], body["monthlyBudget"]), (0.175, 500.0))
        self.assertEqual(body["updatedBy"], "Sms Admin")
        self.assertTrue(body["updatedAt"])
        self.assertEqual(self.get("settings").json()["version"], body["version"])
        s = SmsSettings.get()
        self.assertEqual(
            (s.otp_enabled, s.max_per_phone_per_hour, s.daily_cap, s.max_attempts_per_code), (True, 3, 200, 4)
        )
        self.assertEqual((str(s.price_per_sms), str(s.monthly_budget)), ("0.1750", "500.00"))

    def test_patch_is_the_same_save(self):
        r = self.patch("settings", {"hourlyCap": 70, "monthlyBudget": 1234.5})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["hourlyCap"], r.json()["monthlyBudget"]), (70, 1234.5))

    def test_null_puts_the_price_back_to_the_default_and_removes_the_budget(self):
        self.put("settings", {"pricePerSms": 0.3, "monthlyBudget": 900})
        r = self.put("settings", {"pricePerSms": None, "monthlyBudget": None})
        self.assertEqual((r.json()["pricePerSms"], r.json()["monthlyBudget"]), (0.2, None))
        s = SmsSettings.get()
        self.assertEqual((s.price_per_sms, s.monthly_budget), (Decimal("0.2000"), None))

    def test_omitted_keys_are_left_alone_and_the_get_body_can_be_sent_back(self):
        self.put("settings", {"hourlyCap": 40})
        self.assertEqual(SmsSettings.get().daily_cap, 1500)
        body = self.get("settings").json()
        r = self.put("settings", body)  # version / updatedAt / updatedBy / warnings / pricePerSmsDefault are ignored
        self.assertEqual(r.status_code, 200)
        self.assertEqual(SmsSettings.get().hourly_cap, 40)

    def test_the_old_channel_key_is_refused_with_a_sentence(self):
        for value in ("sms", "whatsapp", None):
            with self.subTest(value=value):
                r = self.put("settings", {"otpChannel": value, "hourlyCap": 90})
                self.assertEqual(r.status_code, 400)
                self.assertTrue(r.json()["error"].startswith("SMS and WhatsApp codes are now switched on separately"))
        self.assertEqual(SmsSettings.get().hourly_cap, 300)

    def test_every_bad_value_is_a_one_sentence_400_and_saves_nothing(self):
        bad = (
            {"otpChannel": "sms"}, {"otpEnabled": "yes"}, {"otpEnabled": None}, {"otpEnabled": 1},
            {"otpLoginEnabled": "yes"}, {"otpResetEnabled": 1}, {"otpActivateEnabled": None},
            {"otpExpiryMinutes": 0}, {"otpExpiryMinutes": 16}, {"otpExpiryMinutes": "5"}, {"otpExpiryMinutes": 5.5},
            {"otpExpiryMinutes": True}, {"otpExpiryMinutes": None},
            {"resendCooldownSeconds": 29}, {"resendCooldownSeconds": 601},
            {"maxRequestsPerHour": 0}, {"maxRequestsPerHour": 21},
            {"maxAttemptsPerCode": 2}, {"maxAttemptsPerCode": 6},
            {"maxPerPhonePerHour": 0}, {"maxPerPhonePerHour": 21},
            {"hourlyCap": 0}, {"hourlyCap": -1}, {"hourlyCap": 10001},
            {"dailyCap": 0}, {"dailyCap": 10001}, {"dailyCap": float("nan")},
            {"hourlyCap": 600, "dailyCap": 500},  # the hour cannot allow more than the day
            {"dailyCap": 50},  # ... also against the saved hourly cap (300)
            {"pricePerSms": -0.01}, {"pricePerSms": 100.5}, {"pricePerSms": "0.2"}, {"pricePerSms": True},
            {"pricePerSms": float("inf")},
            {"monthlyBudget": -1}, {"monthlyBudget": 10_000_001}, {"monthlyBudget": "500"}, {"monthlyBudget": False},
        )  # fmt: skip
        before = self.get("settings").json()
        for body in bad:
            payload = json.dumps(body).encode()  # NaN / Infinity are sent as the bare tokens like a browser could
            r = self.client.put(f"{BASE}/settings", payload, content_type="application/json", **self.hr)
            self.assertEqual(r.status_code, 400, body)
            self.assertEqual(set(r.json()), {"error"}, body)
            self.assertTrue(r.json()["error"].endswith("."), body)
        self.assertEqual(self.get("settings").json(), before)
        self.assertFalse(self.audits().exists())

    def test_all_or_nothing_one_bad_value_blocks_the_good_ones(self):
        r = self.put("settings", {"otpEnabled": True, "otpLoginEnabled": False, "hourlyCap": 0})
        self.assertEqual(r.status_code, 400)
        s = SmsSettings.get()
        self.assertEqual((s.otp_enabled, s.otp_login_enabled, s.hourly_cap), (False, True, 300))

    def test_whole_numbers_sent_as_5_point_0_are_accepted(self):
        self.assertEqual(self.put("settings", {"otpExpiryMinutes": 6.0}).status_code, 200)
        self.assertEqual(SmsSettings.get().otp_expiry_minutes, 6)

    def test_not_json_and_not_an_object_are_refused(self):
        r = self.client.put(f"{BASE}/settings", "channel=sms", content_type="text/plain", **self.hr)
        self.assertIn(r.status_code, (400, 415))
        self.assertIn("error", r.json())
        r = self.client.put(f"{BASE}/settings", "{not json", content_type="application/json", **self.hr)
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())
        r = self.put("settings", [1, 2])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"error": "The body must be a JSON object."})

    def test_the_stale_guard(self):
        v1 = self.get("settings").json()["version"]
        r = self.put("settings", {"hourlyCap": 90, "expectedVersion": v1})
        self.assertEqual(r.status_code, 200)
        v2 = r.json()["version"]
        self.assertNotEqual(v1, v2)
        stale = self.put("settings", {"hourlyCap": 80, "expectedVersion": v1})
        self.assertEqual(stale.status_code, 400)
        self.assertEqual(stale.json()["code"], "stale_settings")
        self.assertIn("reload", stale.json()["error"])
        self.assertEqual(SmsSettings.get().hourly_cap, 90)
        self.assertEqual(self.put("settings", {"hourlyCap": 80, "expectedVersion": v2}).status_code, 200)
        # a body without expectedVersion skips the check; a non-text one is refused
        self.assertEqual(self.put("settings", {"hourlyCap": 70}).status_code, 200)
        self.assertEqual(self.put("settings", {"hourlyCap": 60, "expectedVersion": 5}).status_code, 400)
        # the cost settings are part of the version too
        v3 = self.get("settings").json()["version"]
        self.put("settings", {"pricePerSms": 0.25})
        self.assertNotEqual(self.get("settings").json()["version"], v3)

    def test_the_settings_row_is_locked_for_the_whole_save(self):
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(self.put("settings", {"hourlyCap": 90}).status_code, 200)
        self.assertTrue(any("FOR UPDATE" in q["sql"] and "sms_settings" in q["sql"] for q in queries.captured_queries))

    def test_a_save_writes_an_audit_row_with_what_changed_and_never_a_secret(self):
        self.put("settings", {"otpEnabled": True, "hourlyCap": 80, "otpResetEnabled": False, "pricePerSms": 0.18})
        log = self.audits("update").get()
        self.assertEqual((log.user_name, log.module), ("Sms Admin", "sms_control"))
        self.assertEqual(
            log.old_values, {"otpEnabled": False, "hourlyCap": 300, "otpResetEnabled": True, "pricePerSms": 0.2}
        )
        self.assertEqual(
            log.new_values, {"otpEnabled": True, "hourlyCap": 80, "otpResetEnabled": False, "pricePerSms": 0.18}
        )
        self.assertIn("SMS codes switch", log.record_description)
        self.assertIn("price per SMS", log.record_description)
        self.assertNotIn(TF_KEY, json.dumps([log.record_description, log.old_values, log.new_values]))

    def test_a_save_that_changes_nothing_writes_nothing(self):
        self.assertEqual(
            self.put("settings", {"hourlyCap": 300, "otpEnabled": False, "pricePerSms": 0.2}).status_code, 200
        )
        self.assertEqual(self.put("settings", {}).status_code, 200)
        self.assertFalse(self.audits().exists())
        self.assertIsNone(self.get("settings").json()["updatedAt"])

    def test_warnings_say_what_will_not_work(self):
        self.put("settings", {"otpEnabled": True})
        self.assertEqual(self.get("settings").json()["warnings"], [])  # configured and allowed
        with override_settings(TWOFACTOR_API_KEY="your_2factor_api_key_here"):
            warnings = self.get("settings").json()["warnings"]
        self.assertEqual(
            warnings,
            [
                "SMS codes are switched on but 2Factor is not configured: employees will not get codes by SMS "
                "(password login stays)."
            ],
        )
        with override_settings(SMS_ALLOW_SENDING=False):
            self.assertIn("cannot send them", self.get("settings").json()["warnings"][0])
        self.put("settings", {"otpLoginEnabled": False, "otpResetEnabled": False, "otpActivateEnabled": False})
        self.assertIn("all three code switches are off", self.get("settings").json()["warnings"][0])

    def test_sms_codes_cannot_be_switched_on_while_2factor_is_not_configured(self):
        for key in ("", "your_2factor_api_key_here"):
            with self.subTest(key=key), override_settings(TWOFACTOR_API_KEY=key):
                r = self.put("settings", {"otpEnabled": True, "otpLoginEnabled": False, "hourlyCap": 80})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(set(r.json()), {"error"})
                self.assertTrue(
                    r.json()["error"].startswith(
                        "SMS codes cannot be switched on until 2Factor is configured on the server: missing: "
                    ),
                    r.json()["error"],
                )
                self.assertIn("TWOFACTOR_API_KEY", r.json()["error"])
                self.assertNotIn(TF_KEY, r.json()["error"])
                self.assertTrue(r.json()["error"].endswith("."))
        with override_settings(TWOFACTOR_TEMPLATE_NAME=""):
            r = self.put("settings", {"otpEnabled": True})
            self.assertEqual(r.status_code, 400)
            self.assertIn("TWOFACTOR_TEMPLATE_NAME", r.json()["error"])
        with override_settings(TWOFACTOR_API_BASE="http://2factor.in/API/V1"):
            self.assertEqual(self.put("settings", {"otpEnabled": True}).status_code, 400)
        s = SmsSettings.get()  # nothing of the refused requests was saved (all or nothing)
        self.assertEqual((s.otp_enabled, s.otp_login_enabled, s.hourly_cap), (False, True, 300))
        self.assertFalse(self.audits().exists())
        # a server that cannot send only because it is a development machine is not a configuration problem
        with override_settings(SMS_ALLOW_SENDING=False):
            self.assertEqual(self.put("settings", {"otpEnabled": True}).status_code, 200)

    def test_switching_off_and_editing_limits_is_always_allowed(self):
        self.put("settings", {"otpEnabled": True})
        with override_settings(TWOFACTOR_API_KEY=""):
            # the page sends its whole document back: SMS codes stay on, which is not a switch
            body = self.get("settings").json()
            body["hourlyCap"] = 90
            r = self.put("settings", body)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertTrue(any("not configured" in w for w in r.json()["warnings"]))  # configured once, since removed
            options = self.client.get("/api/auth/login-options").json()
            self.assertEqual(
                (options["otpLogin"], options["passwordLogin"], options["otpChannel"]), (False, True, None)
            )
            self.assertEqual(self.put("settings", {"otpEnabled": False}).status_code, 200)
            self.assertFalse(SmsSettings.get().otp_enabled)
            self.assertEqual(self.put("settings", {"otpEnabled": True}).status_code, 400)  # and back again: refused

    def test_no_password_warning_since_password_sign_in_is_always_on(self):
        self.put("settings", {"otpEnabled": True})
        self.assertEqual(self.get("settings").json()["warnings"], [])
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        self.assertEqual(self.get("settings").json()["warnings"], [])  # password sign-in is always on since 2026-11-24
        self.put("settings", {"otpEnabled": False})  # the advice is about SMS codes only
        self.assertEqual(self.get("settings").json()["warnings"], [])

    def test_a_paused_circuit_is_warned_about(self):
        self.put("settings", {"otpEnabled": True})
        for _ in range(3):
            self.row(status="failed", error_code="timeout")
        self.assertTrue(any("paused" in w for w in self.get("settings").json()["warnings"]))

    def test_the_sms_codes_switch_takes_effect_in_login_options_at_once(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_enabled": False})
        self.assertEqual(self.client.get("/api/auth/login-options").json()["otpChannels"]["login"], [])
        self.put("settings", {"otpEnabled": True})
        options = self.client.get("/api/auth/login-options")
        self.assertEqual(options["Cache-Control"], "no-store")
        self.assertEqual(options.json()["otpChannels"], {"login": ["sms"], "reset": ["sms"], "activate": ["sms"]})
        self.put("settings", {"otpLoginEnabled": False})
        self.assertEqual(self.client.get("/api/auth/login-options").json()["otpChannels"]["login"], [])


class OverviewTests(ControlBase):
    KEYS = {
        "provider", "configured", "sendingAllowed", "sendingNote", "otpEnabled", "status", "env", "balance", "today",
        "last7Days", "lastSentAt", "limits", "circuit", "month", "cost", "alerts",
    }  # fmt: skip

    def test_the_shape_when_nothing_has_happened(self):
        body = self.get("overview").json()
        self.assertEqual(set(body), self.KEYS)
        self.assertNotIn("channel", body)
        self.assertEqual((body["provider"], body["otpEnabled"]), ("twofactor", False))
        self.assertEqual(body["today"], {"sent": 0, "failed": 0, "blocked": 0})
        self.assertIsNone(body["lastSentAt"])
        self.assertEqual(body["limits"], {"hourlyCap": 300, "dailyCap": 1500, "hourUsed": 0, "dayUsed": 0})
        self.assertEqual(body["circuit"], {"paused": False, "until": None})
        self.assertEqual(set(body["balance"]), {"credits", "available", "checkedAt", "error"})
        self.assertEqual(
            (body["balance"]["credits"], body["balance"]["available"], body["balance"]["error"]), (500, 500, None)
        )
        self.assertEqual(len(body["last7Days"]), 7)
        self.assertEqual({tuple(sorted(d)) for d in body["last7Days"]}, {("date", "failed", "sent")})
        dates = [d["date"] for d in body["last7Days"]]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(
            body["status"],
            {
                "configured": True,
                "sendingAllowed": True,
                "sendingAllowedNow": True,
                "otpEnabled": False,
                "available": False,
                "purposes": {"login": False, "reset": False, "activate": False},
                "paused": False,
                "pauseReason": None,
                "accountProblem": None,
                "devLock": {"active": False, "onlyToEmployees": []},
            },
        )
        self.assertEqual(
            {k: body["month"][k] for k in ("requested", "sent", "failed", "blocked", "verified")},
            {"requested": 0, "sent": 0, "failed": 0, "blocked": 0, "verified": 0},
        )
        self.assertEqual((body["month"]["deliveryRate"], body["month"]["verifiedRate"]), (None, None))
        self.assertEqual(
            {k: body["cost"][k] for k in ("perSms", "soFar", "projected", "budget", "budgetUsedPct", "currency")},
            {"perSms": 0.2, "soFar": 0.0, "projected": 0.0, "budget": None, "budgetUsedPct": None, "currency": "INR"},
        )
        self.assertEqual([a["code"] for a in body["alerts"]], ["otp_off"])

    def test_sms_codes_on_shows_available_purposes(self):
        self.sms_codes_on()
        status = self.get("overview").json()["status"]
        self.assertEqual((status["otpEnabled"], status["available"]), (True, True))
        self.assertEqual(status["purposes"], {"login": True, "reset": True, "activate": True})
        self.assertEqual(self.get("overview").json()["alerts"], [])

    def test_configured_and_the_env_flags_never_carry_a_value(self):
        body = self.get("overview").json()
        self.assertTrue(body["configured"])
        self.assertTrue(body["sendingAllowed"])
        self.assertEqual(
            body["env"],
            {"authKey": True, "senderId": "UKTHRM", "templateName": TEMPLATE_NAME, "apiBase": TF_BASE},
        )
        self.assertNotIn(TF_KEY, json.dumps(body))
        self.balance_read.assert_called_once_with(api_key=TF_KEY, base_url=TF_BASE)

    def test_not_configured_and_not_allowed_are_explained(self):
        self.sms_codes_on()
        with override_settings(TWOFACTOR_API_KEY="your_2factor_api_key_here", TWOFACTOR_TEMPLATE_NAME=""):
            body = self.get("overview").json()
        self.assertFalse(body["configured"])
        self.assertEqual(
            (body["env"]["authKey"], body["env"]["templateName"]), (False, "")
        )  # a placeholder is not "set"
        self.assertIn("TWOFACTOR_API_KEY", body["sendingNote"])
        self.assertNotIn("your_2factor", json.dumps(body))
        self.assertEqual(
            body["balance"]["error"], "2Factor is not set up on this server, so the balance cannot be checked."
        )
        self.assertEqual((body["alerts"][0]["level"], body["alerts"][0]["code"]), ("error", "not_configured"))
        self.assertFalse(body["status"]["available"])
        with override_settings(SMS_ALLOW_SENDING=False):
            body = self.get("overview").json()
        self.assertTrue(body["configured"])
        self.assertFalse(body["sendingAllowed"])
        self.assertIn("development setup", body["sendingNote"])
        self.assertIn("sending_blocked", [a["code"] for a in body["alerts"]])

    def test_todays_counts_the_seven_days_and_the_usage_against_the_caps(self):
        now = timezone.now()
        self.row(self.asha, "sent")
        self.row(self.asha, "sent")
        self.row(self.ravi, "failed", error="2Factor did not answer in time.", error_code="timeout")
        self.row(None, "blocked", error="Blocked: the hourly limit of 300 SMS was reached.", error_code="hourly_cap")
        old = self.row(self.asha, "sent")
        SmsMessageLog.objects.filter(pk=old.pk).update(created_at=now - timedelta(days=3, hours=1))
        ancient = self.row(self.asha, "sent")
        SmsMessageLog.objects.filter(pk=ancient.pk).update(created_at=now - timedelta(days=30))
        body = self.get("overview").json()
        self.assertEqual(body["today"], {"sent": 2, "failed": 1, "blocked": 1})
        week = {d["date"]: d for d in body["last7Days"]}
        self.assertEqual(
            sum(d["sent"] for d in week.values()), 3
        )  # today's 2 + the one 3 days ago, not the 30-day-old one
        self.assertEqual(sum(d["failed"] for d in week.values()), 1)
        self.assertEqual(body["limits"]["hourUsed"], 2)
        self.assertEqual(body["limits"]["dayUsed"], 2)
        self.assertTrue(body["lastSentAt"])

    def test_the_circuit_state_is_reported(self):
        self.sms_codes_on()
        for _ in range(3):
            self.row(status="failed", error_code="timeout")
        body = self.get("overview").json()
        self.assertTrue(body["circuit"]["paused"])
        self.assertTrue(body["circuit"]["until"])
        self.assertTrue(body["status"]["paused"])
        self.assertIn("paused until", body["status"]["pauseReason"])
        self.assertTrue(body["status"]["available"])  # a pause is temporary: SMS stays offered
        self.assertEqual(body["alerts"][0]["code"], "paused")

    def test_a_branch_login_counts_only_its_own_branch(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.asha.pk).update(branch=north)
        Employee.objects.filter(pk=self.ravi.pk).update(branch=south)
        self.row(self.asha)
        self.row(self.ravi)
        self.row(self.ravi)
        self.row(None, "sent", purpose="test")
        role = Role.objects.create(name="North HR", permissions={"sms_control": "view"})
        scoped = _hr("north_sms", super_admin=False, role=role, branch=north)
        self.assertEqual(self.get("overview", scoped).json()["today"]["sent"], 1)
        self.assertEqual(self.get("overview", scoped).json()["month"]["sent"], 1)
        self.assertEqual(self.get("overview").json()["today"]["sent"], 4)

    def test_alerts_for_caps_balance_budget_and_failures(self):
        self.sms_codes_on()
        SmsSettings.objects.filter(pk=1).update(hourly_cap=10, daily_cap=100, monthly_budget=Decimal("0.50"))
        for _ in range(8):
            self.row(self.asha, "sent")
        for _ in range(3):
            self.row(self.ravi, "failed", error_code="number")
        self.balance_read.return_value = 40
        codes = {a["code"]: a for a in self.get("overview").json()["alerts"]}
        self.assertEqual(codes["hourly_cap_near"]["level"], "warning")
        self.assertEqual(
            codes["balance_low"]["message"], "Only 40 SMS credits are left on the 2Factor account: top it up soon."
        )
        self.assertEqual(codes["budget_exceeded"]["level"], "error")  # 8 x 0.20 = 1.60 > 0.50
        self.assertEqual(codes["failures"]["level"], "warning")  # 8 of 11 accepted
        cache.clear()
        self.balance_read.return_value = 0
        self.assertIn("balance_empty", [a["code"] for a in self.get("overview").json()["alerts"]])
        cache.clear()
        self.balance_read.side_effect = twofactor_client.TwoFactorError("auth", "2Factor did not accept the API key.")
        alerts = {a["code"]: a for a in self.get("overview").json()["alerts"]}
        self.assertIn("2Factor did not accept the API key.", alerts["balance_unknown"]["message"])

    def test_an_account_that_refuses_is_an_alert_until_an_sms_goes_out_again(self):
        self.sms_codes_on()
        self.row(self.asha, "failed", error_code="auth")
        body = self.get("overview").json()
        self.assertIn("API key", body["status"]["accountProblem"])
        alert = next(a for a in body["alerts"] if a["code"] == "account_problem")
        self.assertEqual(alert["level"], "error")
        self.assertIn("password", alert["message"])
        self.row(self.asha, "sent")
        body = self.get("overview").json()
        self.assertIsNone(body["status"]["accountProblem"])
        self.assertNotIn("account_problem", [a["code"] for a in body["alerts"]])

    def test_a_projected_overspend_is_warned_about_before_it_happens(self):
        today = timezone.now().astimezone(FACTORY_TZ).date()
        days = calendar.monthrange(today.year, today.month)[1]
        if today.day == days:
            self.skipTest("on the last day of a month the projection is the month's total")
        self.sms_codes_on()
        for _ in range(5):
            self.row(self.asha, "sent")  # 1.00 so far
        projected = Decimal("1.00") / today.day * days
        SmsSettings.objects.filter(pk=1).update(monthly_budget=Decimal("1.01"))
        body = self.get("overview").json()
        self.assertEqual(body["cost"]["projected"], _money(projected))
        codes = [a["code"] for a in body["alerts"]]
        self.assertIn("budget_projected", codes)
        self.assertNotIn("budget_exceeded", codes)

    @override_settings(SMS_ONLY_TO_EMPLOYEES=["A1"])
    def test_the_development_lock_is_shown(self):
        with mock.patch.object(sys, "argv", ["manage.py", "runserver"]), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAILWAY_ENVIRONMENT", None)
            os.environ.pop("RAILWAY_ENVIRONMENT_NAME", None)
            body = self.get("overview").json()
        self.assertEqual(body["status"]["devLock"], {"active": True, "onlyToEmployees": ["A1"]})
        self.assertIn("dev_lock", [a["code"] for a in body["alerts"]])


class UsageTests(ControlBase):
    def setUp(self):
        super().setUp()
        self.today = timezone.now().astimezone(FACTORY_TZ).date()
        self.month = self.today.replace(day=1)
        self.days_in_month = calendar.monthrange(self.today.year, self.today.month)[1]

    def otp_row(self, emp, purpose="login", channel="sms", verified=True, at=None):
        at = at or timezone.now()
        return EmployeeOtp.objects.create(
            employee=emp,
            purpose=purpose,
            code_hash="x$y",
            phone_number="919000000001",
            code_length=4 if channel == "sms" else 6,
            channel=channel,
            expires_at=at + timedelta(minutes=5) if verified else at,
            consumed_at=at,
        )

    def test_this_month_by_day_by_purpose_and_the_cost(self):
        SmsSettings.objects.filter(pk=1).update(price_per_sms=Decimal("0.25"), monthly_budget=Decimal("10"))
        for _ in range(3):
            self.row(self.asha, "sent", "login")
        self.row(self.ravi, "sent", "reset")
        self.row(self.ravi, "failed", "reset", error_code="timeout")
        self.row(self.asha, "blocked", "activate", error_code="phone_cap")
        self.row(None, "sent", "test")
        self.otp_row(self.asha)  # used in time: verified
        self.otp_row(self.asha, verified=False)  # replaced / locked: consumed and expired at once
        self.otp_row(self.ravi, purpose="reset")
        self.otp_row(self.ravi, channel="whatsapp")  # a WhatsApp code is not SMS's business
        body = self.get("usage").json()
        self.assertEqual(body["month"], self.month.strftime("%Y-%m"))
        self.assertEqual(len(body["days"]), self.today.day)  # the current month: up to today
        self.assertEqual((body["daysInMonth"], body["elapsedDays"]), (self.days_in_month, self.today.day))
        today = body["days"][-1]
        self.assertEqual(today, {"date": self.today.isoformat(), "sent": 5, "failed": 1, "blocked": 1, "verified": 2})
        self.assertEqual(
            body["totals"],
            {
                "requested": 7,
                "sent": 5,
                "failed": 1,
                "blocked": 1,
                "verified": 2,
                "deliveryRate": round(5 * 100 / 6, 1),
                "verifiedRate": 50.0,  # 2 used of the 4 codes sent to employees (the test is not a code)
            },
        )
        self.assertEqual(body["byPurpose"]["login"], {"sent": 3, "failed": 0, "blocked": 0, "verified": 1})
        self.assertEqual(body["byPurpose"]["reset"], {"sent": 1, "failed": 1, "blocked": 0, "verified": 1})
        self.assertEqual(body["byPurpose"]["activate"], {"sent": 0, "failed": 0, "blocked": 1, "verified": 0})
        self.assertEqual(body["byPurpose"]["test"], {"sent": 1, "failed": 0, "blocked": 0, "verified": 0})
        so_far = Decimal("0.25") * 5
        projected = so_far / self.today.day * self.days_in_month
        self.assertEqual(
            body["cost"],
            {
                "perSms": 0.25,
                "soFar": 1.25,
                "projected": _money(projected),
                "budget": 10.0,
                "budgetUsedPct": 12.5,
                "projectedBudgetPct": round(float(projected) * 100 / 10, 1),
                "currency": "INR",
                "isCurrentMonth": True,
            },
        )
        self.assertEqual(body["balance"]["credits"], 500)

    def test_a_past_month_is_its_actual_total(self):
        last_month_day = self.month - timedelta(days=10)
        at = datetime.combine(last_month_day, time(12, 0), tzinfo=FACTORY_TZ)
        for _ in range(4):
            SmsMessageLog.objects.filter(pk=self.row(self.asha).pk).update(created_at=at)
        self.otp_row(self.asha, at=at)
        self.row(self.asha)  # this month: not counted
        body = self.get("usage", month=last_month_day.strftime("%Y-%m")).json()
        first = last_month_day.replace(day=1)
        self.assertEqual(len(body["days"]), calendar.monthrange(first.year, first.month)[1])
        self.assertEqual(body["days"][0]["date"], first.isoformat())
        day = next(d for d in body["days"] if d["date"] == last_month_day.isoformat())
        self.assertEqual((day["sent"], day["verified"]), (4, 1))
        self.assertEqual((body["totals"]["sent"], body["totals"]["verified"]), (4, 1))
        self.assertEqual(
            (body["cost"]["soFar"], body["cost"]["projected"], body["cost"]["isCurrentMonth"]), (0.8, 0.8, False)
        )

    def test_an_ist_month_boundary(self):
        midnight = datetime.combine(self.month, time(0, 0), tzinfo=FACTORY_TZ)
        before, after = self.row(self.asha), self.row(self.asha)
        SmsMessageLog.objects.filter(pk=before.pk).update(created_at=midnight - timedelta(minutes=1))
        SmsMessageLog.objects.filter(pk=after.pk).update(created_at=midnight + timedelta(minutes=1))
        self.assertEqual(self.get("usage").json()["totals"]["sent"], 1)

    def test_a_future_month_is_empty_and_a_bad_month_is_a_400(self):
        future = (self.month + timedelta(days=40)).strftime("%Y-%m")
        body = self.get("usage", month=future).json()
        self.assertEqual((body["days"], body["cost"]["projected"], body["elapsedDays"]), ([], 0.0, 0))
        for bad in ("2026-13", "november", "2026/11", "1999-01", "2026-1-1"):
            with self.subTest(bad=bad):
                r = self.get("usage", month=bad)
                self.assertEqual(r.status_code, 400)
                self.assertIn("YYYY-MM", r.json()["error"])

    def test_a_branch_login_counts_only_its_own_branch(self):
        north = Branch.objects.create(name="North")
        Employee.objects.filter(pk=self.asha.pk).update(branch=north)
        self.row(self.asha)
        self.row(self.ravi)
        self.otp_row(self.asha)
        self.otp_row(self.ravi)
        role = Role.objects.create(name="North HR", permissions={"sms_control": "view"})
        scoped = _hr("north_sms", super_admin=False, role=role, branch=north)
        totals = self.get("usage", scoped).json()["totals"]
        self.assertEqual((totals["sent"], totals["verified"]), (1, 1))
        totals = self.get("usage").json()["totals"]
        self.assertEqual((totals["sent"], totals["verified"]), (2, 2))

    def test_the_numbers_follow_a_real_code_flow(self):
        self.sms_codes_on()
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"otp_enabled": False})
        with mock.patch(GET, return_value=provider_ok()) as get:
            r = self.client.post(
                "/api/auth/otp/request", {"employeeCode": "A1", "purpose": "login"}, content_type="application/json"
            )
        self.assertEqual(r.status_code, 200)
        r = self.client.post(
            "/api/auth/otp/login",
            {"employeeCode": "A1", "otp": code_in(get.call_args)},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        totals = self.get("usage").json()["totals"]
        self.assertEqual((totals["sent"], totals["verified"], totals["verifiedRate"]), (1, 1, 100.0))


class MessagesTests(ControlBase):
    KEYS = {"id", "at", "employeeId", "employeeName", "employeeCode", "maskedPhone", "purpose", "status", "error", "providerMessageId", "ip"}  # fmt: skip

    def test_the_shape_and_newest_first(self):
        first = self.row(
            self.asha, "sent", provider_message_id="REQ1", requested_ip="10.1.1.1", phone_masked="•" * 8 + "0001"
        )
        second = self.row(
            self.ravi, "failed", purpose="reset", error="2Factor did not answer in time.", error_code="timeout"
        )
        SmsMessageLog.objects.filter(pk=first.pk).update(created_at=timezone.now() - timedelta(minutes=5))
        body = self.get("messages").json()
        self.assertEqual(set(body), {"items", "total", "page", "pageSize", "statusCounts"})
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (2, 1, 50))
        self.assertEqual(body["statusCounts"], {"sent": 1, "failed": 1, "blocked": 0})
        self.assertEqual([i["id"] for i in body["items"]], [second.id, first.id])
        item = body["items"][1]
        self.assertEqual(set(item), self.KEYS)
        self.assertEqual(
            {k: item[k] for k in item if k != "at"},
            {
                "id": first.id, "employeeId": self.asha.id, "employeeName": "Asha Kumar", "employeeCode": "A1",
                "maskedPhone": "•" * 8 + "0001", "purpose": "login", "status": "sent", "error": "",
                "providerMessageId": "REQ1", "ip": "10.1.1.1",
            },
        )  # fmt: skip
        self.assertTrue(item["at"])
        self.assertEqual(body["items"][0]["error"], "2Factor did not answer in time.")

    def test_a_test_message_has_no_employee(self):
        self.row(None, "sent", purpose="test")
        item = self.get("messages").json()["items"][0]
        self.assertEqual(
            (item["employeeId"], item["employeeName"], item["employeeCode"], item["purpose"]),
            (None, "Test message", "", "test"),
        )

    def test_filters(self):
        a = self.row(self.asha, "sent", "login")
        b = self.row(self.ravi, "failed", "reset")
        c = self.row(self.ravi, "blocked", "activate")
        t = self.row(None, "sent", "test", phone_masked="•" * 8 + "9999")

        def ids(**params):
            return {i["id"] for i in self.get("messages", **params).json()["items"]}

        self.assertEqual(ids(status="sent"), {a.id, t.id})
        self.assertEqual(ids(status="failed"), {b.id})
        self.assertEqual(ids(purpose="reset"), {b.id})
        self.assertEqual(ids(purpose="test"), {t.id})
        self.assertEqual(ids(search="asha"), {a.id})
        self.assertEqual(ids(search="R1"), {b.id, c.id})
        self.assertEqual(ids(search="nair"), {b.id, c.id})
        self.assertEqual(ids(search="9999"), {t.id})
        self.assertEqual(ids(search="nobody"), set())
        self.assertEqual(ids(status="sent", purpose="login"), {a.id})

    def test_status_counts_ignore_the_status_filter_but_follow_the_others(self):
        self.row(self.asha, "sent", "login")
        self.row(self.asha, "failed", "login")
        self.row(self.ravi, "blocked", "reset")
        body = self.get("messages", status="failed").json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["statusCounts"], {"sent": 1, "failed": 1, "blocked": 1})
        body = self.get("messages", purpose="login", status="sent").json()
        self.assertEqual(body["statusCounts"], {"sent": 1, "failed": 1, "blocked": 0})

    def test_date_filters_are_ist_days(self):
        old = self.row(self.asha, "sent")
        SmsMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=10))
        new = self.row(self.asha, "sent")
        today = timezone.now().astimezone(FACTORY_TZ).date()
        self.assertEqual({i["id"] for i in self.get("messages", dateFrom=today.isoformat()).json()["items"]}, {new.id})
        before = (today - timedelta(days=5)).isoformat()
        self.assertEqual({i["id"] for i in self.get("messages", dateTo=before).json()["items"]}, {old.id})
        self.assertEqual(self.get("messages", dateFrom="2026-13-40").status_code, 400)
        self.assertEqual(self.get("messages", dateTo="yesterday").status_code, 400)

    def test_pagination(self):
        for _ in range(7):
            self.row(self.asha)
        body = self.get("messages", page=2, pageSize=3).json()
        self.assertEqual((body["total"], body["page"], body["pageSize"], len(body["items"])), (7, 2, 3, 3))
        self.assertEqual(len(self.get("messages", page=3, pageSize=3).json()["items"]), 1)
        self.assertEqual(self.get("messages", page=9, pageSize=3).json()["items"], [])
        self.assertEqual(self.get("messages", pageSize=100000).json()["pageSize"], 200)
        self.assertEqual(self.get("messages", page="x").status_code, 400)
        self.assertEqual(self.get("messages", pageSize="x").status_code, 400)

    def test_bad_filters_are_400s(self):
        self.assertEqual(self.get("messages", status="pending").status_code, 400)
        self.assertEqual(self.get("messages", purpose="admin").status_code, 400)

    def test_a_branch_login_sees_only_its_own_branch_and_no_test_messages(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.asha.pk).update(branch=north)
        Employee.objects.filter(pk=self.ravi.pk).update(branch=south)
        n, s = self.row(self.asha), self.row(self.ravi)
        t = self.row(None, "sent", "test")
        role = Role.objects.create(name="North HR", permissions={"sms_control": "view"})
        scoped = _hr("north_sms", super_admin=False, role=role, branch=north)
        body = self.get("messages", scoped).json()
        self.assertEqual({i["id"] for i in body["items"]}, {n.id})
        self.assertEqual(body["statusCounts"]["sent"], 1)
        self.assertEqual({i["id"] for i in self.get("messages").json()["items"]}, {n.id, s.id, t.id})

    def test_no_code_text_or_full_number_can_be_in_the_answer(self):
        self.sms_codes_on()
        with mock.patch(GET, return_value=provider_ok()) as post:
            r = self.client.post(
                "/api/auth/otp/request", {"employeeCode": "A1", "purpose": "login"}, content_type="application/json"
            )
        self.assertEqual(r.status_code, 200)
        code = code_in(post.call_args)
        text = self.get("messages").content.decode() + self.get("overview").content.decode()
        # a 4-digit code is only 10 000 numbers: look for it as a text of its own inside a JSON string, not inside the
        # ids, timestamps and hashes the pages carry
        self.assertNotRegex(text, rf'"[^"]*(?<![0-9A-Za-z]){code}(?![0-9A-Za-z])[^"]*"')
        self.assertNotIn("9000000001", text)
        self.assertNotIn(TF_KEY, text)


class TestSendTests(ControlBase):
    def send(self, phone="98765 43210", headers=None, response=None, **kw):
        with mock.patch(GET, return_value=response or provider_ok(), **kw) as post:
            r = self.post("test", {"phone": phone}, headers)
        return r, post

    def test_a_test_goes_through_the_real_template_with_the_dummy_code(self):
        r, post = self.send()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(set(body), {"ok", "message"})
        self.assertTrue(body["ok"])
        self.assertIn("•" * 8 + "3210", body["message"])
        self.assertNotIn("9876543210", body["message"])
        self.assertEqual(post.call_args.args, (f"{TF_BASE}/{TF_KEY}/SMS/+919876543210/1234/{TEMPLATE_NAME}",))
        log = SmsMessageLog.objects.get()
        self.assertEqual(
            (log.purpose, log.status, log.employee_id, log.phone_masked), ("test", "sent", None, "•" * 8 + "3210")
        )
        self.assertEqual(log.sent_by.username, "sms_admin")
        self.assertNotIn("9876543210", json.dumps(self.get("messages").json()))

    def test_a_test_is_audited_with_the_masked_number_only(self):
        self.send()
        log = self.audits("test").get()
        self.assertEqual((log.user_name, log.module), ("Sms Admin", "sms_control"))
        self.assertIn("•" * 8 + "3210", log.record_description)
        self.assertNotIn("9876543210", json.dumps([log.record_description, log.old_values, log.new_values]))
        self.assertNotIn("1234", log.record_description or "")

    def test_the_number_is_checked_before_anything_else(self):
        for body in (
            {},
            {"phone": ""},
            {"phone": None},
            {"phone": 9876543210},
            {"phone": "x" * 80},
            {"phone": "12345"},
            {"phone": "5551234567"},
        ):
            with mock.patch(GET) as post:
                r = self.post("test", body)
            self.assertEqual(r.status_code, 400, body)
            self.assertEqual(set(r.json()), {"ok", "message", "error"}, body)
            self.assertFalse(r.json()["ok"])
            post.assert_not_called()
        self.assertFalse(SmsMessageLog.objects.exists())

    def test_refused_with_a_plain_sentence_when_not_configured_or_not_allowed(self):
        for override, expected in (
            (dict(TWOFACTOR_API_KEY=""), "TWOFACTOR_API_KEY"),
            (dict(TWOFACTOR_TEMPLATE_NAME="your_2factor_template_name_here"), "TWOFACTOR_TEMPLATE_NAME"),
            (dict(SMS_ALLOW_SENDING=False), "development setup"),
        ):
            with override_settings(**override):
                r, post = self.send()
            self.assertEqual(r.status_code, 200, override)
            self.assertFalse(r.json()["ok"])
            self.assertIn(expected, r.json()["message"])
            post.assert_not_called()
        self.assertFalse(SmsMessageLog.objects.exists())
        self.assertFalse(self.audits("test").exists())

    def test_a_provider_refusal_is_reported_and_logged(self):
        r, _ = self.send(response=provider_error("Template Name is not approved"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["ok"])
        self.assertIn("template name", r.json()["message"])
        log = SmsMessageLog.objects.get()
        self.assertEqual((log.status, log.error_code, log.purpose), ("failed", "template", "test"))
        self.assertIn("(2Factor refused it)", self.audits("test").get().record_description)

    def test_a_network_failure_is_reported_not_raised(self):
        r, _ = self.send(side_effect=requests.exceptions.ReadTimeout("slow"))
        self.assertEqual(r.status_code, 200)
        # a read timeout: 2Factor had the request, so the wording says the message may still arrive
        self.assertEqual(
            r.json(),
            {
                "ok": False,
                "message": "The test SMS was not sent. 2Factor did not answer in time: the SMS may still arrive.",
            },
        )

    def test_three_tests_an_hour_per_hr_user(self):
        for _ in range(3):
            self.assertTrue(self.send()[0].json()["ok"])
        r, post = self.send()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(set(r.json()), {"ok", "message", "error"})
        self.assertIn("3 test messages per hour", r.json()["message"])
        post.assert_not_called()
        # another HR user has their own allowance
        other = _hr("sms_second_admin")
        self.assertTrue(self.send(headers=other)[0].json()["ok"])
        # and an hour later the first one is free again
        SmsMessageLog.objects.update(created_at=timezone.now() - timedelta(minutes=61))
        self.assertTrue(self.send()[0].json()["ok"])

    def test_a_test_counts_against_the_caps_and_is_stopped_by_them(self):
        SmsSettings.objects.update_or_create(pk=1, defaults={"hourly_cap": 1})
        self.assertTrue(self.send()[0].json()["ok"])
        r, post = self.send(phone="9123456780")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["ok"])
        self.assertIn("hourly limit of 1", r.json()["message"])
        post.assert_not_called()
        self.assertEqual(SmsMessageLog.objects.filter(status="blocked", purpose="test").count(), 1)
        self.assertIn("stopped by a limit", self.audits("test").order_by("-id").first().record_description)

    def test_the_per_number_cap_also_covers_tests(self):
        SmsSettings.objects.update_or_create(pk=1, defaults={"max_per_phone_per_hour": 1})
        self.assertTrue(self.send("9876543210")[0].json()["ok"])
        r, post = self.send("+91 98765 43210")  # the same number, typed differently
        self.assertFalse(r.json()["ok"])
        self.assertIn("already received", r.json()["message"])
        post.assert_not_called()

    def test_a_test_is_a_post_only_action(self):
        self.assertEqual(self.client.get(f"{BASE}/test", **self.hr).status_code, 405)

    def test_nothing_secret_is_in_the_answer_or_the_logs(self):
        with captured_logs() as lines:
            r, _ = self.send(response=provider_error(f"Invalid API Key {TF_KEY} for 919876543210 code 1234"))
        text = (
            r.content.decode()
            + "\n".join(lines)
            + json.dumps(list(SmsMessageLog.objects.values("error", "phone_masked")))
        )
        for secret in (TF_KEY, "9876543210", "1234"):
            self.assertNotIn(secret, text)


class TestToAnEmployeeTests(ControlBase):
    """The page picks an employee: the test code goes to their registered number (still only a code, through the OTP
    template), and the development lock holds it like any other SMS."""

    def send(self, body, response=None):
        with mock.patch(GET, return_value=response or provider_ok()) as get:
            r = self.post("test", body)
        return r, get

    def test_by_employee_code_or_id(self):
        for body in ({"employeeCode": "a1"}, {"employeeId": self.asha.id}, {"employeeId": str(self.asha.id)}):
            with self.subTest(body=body):
                SmsMessageLog.objects.all().delete()
                r, get = self.send(body)
                self.assertEqual((r.status_code, r.json()["ok"]), (200, True), r.content)
                self.assertEqual(get.call_args.args, (f"{TF_BASE}/{TF_KEY}/SMS/+919000000001/1234/{TEMPLATE_NAME}",))
                log = SmsMessageLog.objects.get()
                self.assertEqual(
                    (log.purpose, log.employee_id, log.sent_by.username), ("test", self.asha.id, "sms_admin")
                )
        self.assertIn("A1 on ", self.audits("test").first().record_description)
        item = self.get("messages").json()["items"][0]
        self.assertEqual((item["employeeName"], item["purpose"]), ("Asha Kumar", "test"))

    def test_an_unknown_employee_or_one_without_a_mobile_number_is_a_400(self):
        Employee.objects.create(employee_code="L1", first_name="Land", last_name="Line", phone="044-24351234")
        for body in (
            {"employeeCode": "NOPE"},
            {"employeeId": 999999},
            {"employeeCode": ["A1"]},
            {"employeeCode": "L1"},
        ):
            with self.subTest(body=body):
                r, get = self.send(body)
                self.assertEqual(r.status_code, 400)
                self.assertFalse(r.json()["ok"])
                get.assert_not_called()
        self.assertFalse(SmsMessageLog.objects.exists())

    @override_settings(SMS_ONLY_TO_EMPLOYEES=["A1"])
    def test_a_development_machine_texts_only_the_named_employees(self):
        with mock.patch.object(sys, "argv", ["manage.py", "runserver"]), mock.patch.dict(os.environ, {}):
            os.environ.pop("RAILWAY_ENVIRONMENT", None)
            os.environ.pop("RAILWAY_ENVIRONMENT_NAME", None)
            refused, get = self.send({"employeeCode": "R1"})
            self.assertEqual(refused.status_code, 200)
            self.assertFalse(refused.json()["ok"])
            self.assertIn("development safety", refused.json()["message"])
            self.assertIn("SMS_ONLY_TO_EMPLOYEES", refused.json()["message"])
            get.assert_not_called()
            allowed, get = self.send({"employeeCode": "A1"})
            self.assertTrue(allowed.json()["ok"])
        self.assertEqual(SmsMessageLog.objects.get(status="blocked").error_code, "dev_lock")


class TwoFactorOverviewTests(ControlBase):
    def test_the_overview_env_describes_2factor_and_never_carries_the_key(self):
        body = self.get("overview").json()
        self.assertEqual(body["provider"], "twofactor")
        self.assertEqual(set(body["env"]), {"authKey", "senderId", "templateName", "apiBase"})
        self.assertIs(body["env"]["authKey"], True)
        with override_settings(TWOFACTOR_SENDER_ID="your_sender_id_here"):
            self.assertEqual(self.get("overview").json()["env"]["senderId"], "")  # a placeholder is not a value
        self.assertNotIn(TF_KEY, self.get("overview").content.decode())
        self.assertNotIn(TF_KEY, self.get("settings").content.decode())

    def test_the_settings_have_no_provider_choice_any_more(self):
        self.assertNotIn("smsProvider", self.get("settings").json())
        self.assertNotIn("providers", self.get("overview").json())
        r = self.put("settings", {"smsProvider": "other"})  # an unknown key is ignored, like every unknown key
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("smsProvider", r.json())


class VocabularyTests(SimpleTestCase):
    def test_the_audit_vocabulary_knows_the_module_and_the_actions(self):
        self.assertEqual(dict(AUDIT_MODULES)["sms_control"], "SMS control")
        for action in ("update", "test"):
            self.assertIn(action, dict(AUDIT_ACTIONS))

    def test_the_md_activity_view_classifies_and_places_it(self):
        rule = md_activity.classify("update", "sms_control", "Changed SMS settings: delivery channel")
        self.assertEqual(rule.id, "sms-control")
        self.assertIsNone(md_activity.classify("test", "sms_control", "Sent a test SMS to ••••••••3210"))
        self.assertEqual(md_activity.area_of("sms_control"), ("settings", "Settings"))
