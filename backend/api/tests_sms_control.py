"""
SMS Control page API (/api/sms-control/*): overview, settings (validation, stale guard, audit), messages, test send,
permissions and branch scoping. 2Factor is never contacted (see tests_sms_otp.py for the mocking rules).
"""

import json
from datetime import timedelta
from unittest import mock

import requests
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import permission_registry
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import activity as md_activity
from .models import AuditLog, Branch, Employee, HRUser, Role, SmsMessageLog, SmsSettings, WhatsAppSettings
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


@override_settings(**SMS_CONFIG)
class ControlBase(NoNetworkMixin, TestCase):
    def setUp(self):
        super().setUp()
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

    def post(self, path, body, headers=None):
        return self.client.post(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def audits(self, action=None):
        qs = AuditLog.objects.filter(module="sms_control")
        return qs.filter(action=action) if action else qs


class AccessTests(ControlBase):
    ENDPOINTS = (("get", "overview"), ("get", "messages"), ("get", "settings"), ("put", "settings"), ("post", "test"))

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
        for path in ("overview", "messages", "settings"):
            self.assertEqual(self.get(path, viewer).status_code, 200, path)
        self.assertEqual(self.put("settings", {"otpChannel": "sms"}, viewer).status_code, 403)
        self.assertEqual(SmsSettings.get().otp_channel, "whatsapp")
        with mock.patch(GET) as post:
            self.assertEqual(self.post("test", {"phone": "9876543210"}, viewer).status_code, 403)
        post.assert_not_called()

    def test_a_role_with_edit_can_change_and_send(self):
        role = Role.objects.create(name="Editor", permissions={"sms_control": "edit"})
        editor = _hr("sms_editor", super_admin=False, role=role)
        self.assertEqual(self.put("settings", {"otpChannel": "sms"}, editor).status_code, 200)
        self.assertEqual(SmsSettings.get().otp_channel, "sms")
        with mock.patch(GET, return_value=provider_ok()):
            r = self.post("test", {"phone": "9876543210"}, editor)
        self.assertEqual((r.status_code, r.json()["ok"]), (200, True))

    def test_a_role_without_the_module_is_locked_out_of_everything(self):
        role = Role.objects.create(name="Other", permissions={"payroll": "edit", "whatsapp_control": "edit"})
        other = _hr("sms_other", super_admin=False, role=role)
        for method, path in self.ENDPOINTS:
            self.assertEqual(self.call(method, path, other).status_code, 403, f"{method} {path}")

    def test_a_super_admin_always_has_access(self):
        for path in ("overview", "messages", "settings"):
            self.assertEqual(self.get(path).status_code, 200)

    def test_the_module_is_registered_like_whatsapp_control(self):
        self.assertIn("sms_control", permission_registry.all_module_keys())
        labels = {node["key"]: node["label"] for node in permission_registry.MODULE_TREE}
        self.assertEqual(labels["sms_control"], "SMS Control")
        for path in ("sms-control/overview", "sms-control/settings", "sms-control/messages", "sms-control/test"):
            self.assertEqual(permission_registry.resolve_module(path), "sms_control", path)
        self.assertEqual(permission_registry.resolve_module("whatsapp-control/overview"), "whatsapp_control")

    def test_a_branch_login_can_read_but_not_change_company_settings_or_send_a_test(self):
        north = Branch.objects.create(name="North")
        role = Role.objects.create(name="North HR", permissions={"sms_control": "edit"})
        scoped = _hr("north_sms", super_admin=False, role=role, branch=north)
        self.assertEqual(self.get("settings", scoped).status_code, 200)
        r = self.put("settings", {"otpChannel": "sms"}, scoped)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "company_wide_settings"))
        self.assertEqual(SmsSettings.get().otp_channel, "whatsapp")
        with mock.patch(GET) as post:
            r = self.post("test", {"phone": "9876543210"}, scoped)
        self.assertEqual((r.status_code, r.json()["code"], r.json()["ok"]), (403, "company_wide_settings", False))
        post.assert_not_called()


class SettingsTests(ControlBase):
    KEYS = {
        "otpChannel", "otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled", "otpExpiryMinutes",
        "resendCooldownSeconds", "maxRequestsPerHour", "maxAttemptsPerCode", "maxPerPhonePerHour", "hourlyCap",
        "dailyCap", "version", "updatedAt", "updatedBy", "warnings",
    }  # fmt: skip

    def test_the_defaults_and_the_exact_shape(self):
        body = self.get("settings").json()
        self.assertEqual(set(body), self.KEYS)
        self.assertEqual(
            {k: body[k] for k in self.KEYS - {"version", "warnings"}},
            {
                "otpChannel": "whatsapp", "otpLoginEnabled": True, "otpResetEnabled": True, "otpActivateEnabled": True,
                "otpExpiryMinutes": 5, "resendCooldownSeconds": 60, "maxRequestsPerHour": 5, "maxAttemptsPerCode": 5,
                "maxPerPhonePerHour": 5, "hourlyCap": 300, "dailyCap": 1500, "updatedAt": None, "updatedBy": None,
            },
        )  # fmt: skip
        self.assertRegex(body["version"], r"^[0-9a-f]{16}$")
        self.assertEqual(body["warnings"], [])  # WhatsApp selected: nothing to warn about

    def test_a_valid_put_saves_everything_and_reports_who_and_when(self):
        r = self.put(
            "settings",
            {
                "otpChannel": "sms", "otpLoginEnabled": False, "otpResetEnabled": True, "otpActivateEnabled": False,
                "otpExpiryMinutes": 10, "resendCooldownSeconds": 90, "maxRequestsPerHour": 8, "maxAttemptsPerCode": 4,
                "maxPerPhonePerHour": 3, "hourlyCap": 50, "dailyCap": 200,
            },
        )  # fmt: skip
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["otpChannel"], body["otpLoginEnabled"], body["otpActivateEnabled"]), ("sms", False, False)
        )
        self.assertEqual((body["otpExpiryMinutes"], body["resendCooldownSeconds"], body["hourlyCap"]), (10, 90, 50))
        self.assertEqual(body["updatedBy"], "Sms Admin")
        self.assertTrue(body["updatedAt"])
        self.assertEqual(self.get("settings").json()["version"], body["version"])
        s = SmsSettings.get()
        self.assertEqual(
            (s.otp_channel, s.max_per_phone_per_hour, s.daily_cap, s.max_attempts_per_code), ("sms", 3, 200, 4)
        )

    def test_omitted_keys_are_left_alone_and_the_get_body_can_be_sent_back(self):
        self.put("settings", {"hourlyCap": 40})
        self.assertEqual(SmsSettings.get().daily_cap, 1500)
        body = self.get("settings").json()
        r = self.put("settings", body)  # version / updatedAt / updatedBy / warnings are ignored
        self.assertEqual(r.status_code, 200)
        self.assertEqual(SmsSettings.get().hourly_cap, 40)

    def test_every_bad_value_is_a_one_sentence_400_and_saves_nothing(self):
        bad = (
            {"otpChannel": "telegram"}, {"otpChannel": None}, {"otpChannel": 1},
            {"otpLoginEnabled": "yes"}, {"otpResetEnabled": 1}, {"otpActivateEnabled": None},
            {"otpExpiryMinutes": 0}, {"otpExpiryMinutes": 16}, {"otpExpiryMinutes": "5"}, {"otpExpiryMinutes": 5.5},
            {"otpExpiryMinutes": True}, {"otpExpiryMinutes": None},
            {"resendCooldownSeconds": 29}, {"resendCooldownSeconds": 601},
            {"maxRequestsPerHour": 0}, {"maxRequestsPerHour": 21},
            {"maxAttemptsPerCode": 2}, {"maxAttemptsPerCode": 11},
            {"maxPerPhonePerHour": 0}, {"maxPerPhonePerHour": 21},
            {"hourlyCap": 0}, {"hourlyCap": -1}, {"hourlyCap": 10001},
            {"dailyCap": 0}, {"dailyCap": 10001}, {"dailyCap": float("nan")},
            {"hourlyCap": 600, "dailyCap": 500},  # the hour cannot allow more than the day
            {"dailyCap": 50},  # ... also against the saved hourly cap (300)
        )  # fmt: skip
        before = self.get("settings").json()
        for body in bad:
            payload = json.dumps(body).encode()  # NaN is sent as the bare token like a browser could
            r = self.client.put(f"{BASE}/settings", payload, content_type="application/json", **self.hr)
            self.assertEqual(r.status_code, 400, body)
            self.assertEqual(set(r.json()), {"error"}, body)
            self.assertTrue(r.json()["error"].endswith("."), body)
        self.assertEqual(self.get("settings").json(), before)
        self.assertFalse(self.audits().exists())

    def test_all_or_nothing_one_bad_value_blocks_the_good_ones(self):
        r = self.put("settings", {"otpChannel": "sms", "otpLoginEnabled": False, "hourlyCap": 0})
        self.assertEqual(r.status_code, 400)
        s = SmsSettings.get()
        self.assertEqual((s.otp_channel, s.otp_login_enabled, s.hourly_cap), ("whatsapp", True, 300))

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

    def test_the_settings_row_is_locked_for_the_whole_save(self):
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(self.put("settings", {"hourlyCap": 90}).status_code, 200)
        self.assertTrue(any("FOR UPDATE" in q["sql"] and "sms_settings" in q["sql"] for q in queries.captured_queries))

    def test_a_save_writes_an_audit_row_with_what_changed_and_never_a_secret(self):
        self.put("settings", {"otpChannel": "sms", "hourlyCap": 80, "otpResetEnabled": False})
        log = self.audits("update").get()
        self.assertEqual((log.user_name, log.module), ("Sms Admin", "sms_control"))
        self.assertEqual(log.old_values, {"otpChannel": "whatsapp", "hourlyCap": 300, "otpResetEnabled": True})
        self.assertEqual(log.new_values, {"otpChannel": "sms", "hourlyCap": 80, "otpResetEnabled": False})
        self.assertIn("delivery channel", log.record_description)
        self.assertNotIn(TF_KEY, json.dumps([log.record_description, log.old_values, log.new_values]))

    def test_a_save_that_changes_nothing_writes_nothing(self):
        self.assertEqual(self.put("settings", {"hourlyCap": 300, "otpChannel": "whatsapp"}).status_code, 200)
        self.assertEqual(self.put("settings", {}).status_code, 200)
        self.assertFalse(self.audits().exists())
        self.assertIsNone(self.get("settings").json()["updatedAt"])

    def test_warnings_say_what_will_not_work(self):
        self.put("settings", {"otpChannel": "sms"})
        self.assertEqual(self.get("settings").json()["warnings"], [])  # configured and allowed
        with override_settings(TWOFACTOR_API_KEY="your_2factor_api_key_here"):
            warnings = self.get("settings").json()["warnings"]
        self.assertEqual(
            warnings,
            [
                "SMS is selected but 2Factor is not configured: employees will not be able to receive codes (password login stays)."
            ],
        )
        with override_settings(SMS_ALLOW_SENDING=False):
            self.assertIn("not allowed to send SMS", self.get("settings").json()["warnings"][0])
        self.put("settings", {"otpLoginEnabled": False, "otpResetEnabled": False, "otpActivateEnabled": False})
        self.assertIn("employees can only use their password", self.get("settings").json()["warnings"][0])

    def test_sms_cannot_be_selected_while_2factor_is_not_configured(self):
        """Selecting SMS while 2Factor is missing used to be allowed (and warned about). It also reopened the open
        first-time password setup (set-password answers 200 for any employee who has no password yet while no code can be
        sent), so it is refused now, whatever else the same request carries."""
        for key in ("", "your_2factor_api_key_here"):
            with self.subTest(key=key), override_settings(TWOFACTOR_API_KEY=key):
                r = self.put("settings", {"otpChannel": "sms", "otpLoginEnabled": False, "hourlyCap": 80})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(set(r.json()), {"error"})
                self.assertTrue(
                    r.json()["error"].startswith(
                        "SMS cannot be selected until 2Factor is configured on the server: missing: "
                    ),
                    r.json()["error"],
                )
                self.assertIn("TWOFACTOR_API_KEY", r.json()["error"])
                self.assertNotIn(TF_KEY, r.json()["error"])
                self.assertTrue(r.json()["error"].endswith("."))
        with override_settings(TWOFACTOR_TEMPLATE_NAME=""):
            r = self.put("settings", {"otpChannel": "sms"})
            self.assertEqual(r.status_code, 400)
            self.assertIn("TWOFACTOR_TEMPLATE_NAME", r.json()["error"])
        with override_settings(TWOFACTOR_API_BASE="http://2factor.in/API/V1"):
            self.assertEqual(self.put("settings", {"otpChannel": "sms"}).status_code, 400)
        s = SmsSettings.get()  # nothing of the refused requests was saved (all or nothing)
        self.assertEqual((s.otp_channel, s.otp_login_enabled, s.hourly_cap), ("whatsapp", True, 300))
        self.assertFalse(self.audits().exists())
        # a server that cannot send only because it is a development machine is not a configuration problem
        with override_settings(SMS_ALLOW_SENDING=False):
            self.assertEqual(self.put("settings", {"otpChannel": "sms"}).status_code, 200)

    def test_switching_back_to_whatsapp_and_editing_limits_is_always_allowed(self):
        self.put("settings", {"otpChannel": "sms"})
        with override_settings(TWOFACTOR_API_KEY=""):
            # the page sends its whole document back: the channel is still sms, which is not a switch
            body = self.get("settings").json()
            body["hourlyCap"] = 90
            r = self.put("settings", body)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertTrue(any("not configured" in w for w in r.json()["warnings"]))  # configured once, since removed
            options = self.client.get("/api/auth/login-options").json()
            self.assertEqual(
                (options["otpLogin"], options["passwordLogin"], options["otpChannel"]), (False, True, "sms")
            )
            self.assertEqual(self.put("settings", {"otpChannel": "whatsapp"}).status_code, 200)
            self.assertEqual(SmsSettings.get().otp_channel, "whatsapp")
            self.assertEqual(self.put("settings", {"otpChannel": "sms"}).status_code, 400)  # and back again: refused

    def test_keeping_password_login_on_is_advised_while_sms_is_the_channel(self):
        self.put("settings", {"otpChannel": "sms"})
        self.assertEqual(self.get("settings").json()["warnings"], [])
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"password_login_enabled": False})
        warnings = self.get("settings").json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("Password sign-in is switched off", warnings[0])
        self.assertIn("keep it on", warnings[0])
        self.put("settings", {"otpChannel": "whatsapp"})  # the advice is about SMS only
        self.assertEqual(self.get("settings").json()["warnings"], [])

    def test_a_paused_circuit_is_warned_about(self):
        self.put("settings", {"otpChannel": "sms"})
        for _ in range(3):
            self.row(status="failed", error_code="timeout")
        self.assertTrue(any("paused" in w for w in self.get("settings").json()["warnings"]))

    def test_the_channel_switch_takes_effect_in_login_options_at_once(self):
        self.assertEqual(self.client.get("/api/auth/login-options").json()["otpChannel"], "whatsapp")
        self.put("settings", {"otpChannel": "sms"})
        self.assertEqual(self.client.get("/api/auth/login-options").json()["otpChannel"], "sms")


class OverviewTests(ControlBase):
    KEYS = {
        "provider", "channel", "configured", "sendingAllowed", "sendingNote", "env", "balance", "today",
        "last7Days", "lastSentAt", "limits", "circuit",
    }  # fmt: skip

    def test_the_shape_when_nothing_has_happened(self):
        body = self.get("overview").json()
        self.assertEqual(set(body), self.KEYS)
        self.assertEqual((body["provider"], body["channel"]), ("twofactor", "whatsapp"))
        self.assertEqual(body["today"], {"sent": 0, "failed": 0, "blocked": 0})
        self.assertIsNone(body["lastSentAt"])
        self.assertEqual(body["limits"], {"hourlyCap": 300, "dailyCap": 1500, "hourUsed": 0, "dayUsed": 0})
        self.assertEqual(body["circuit"], {"paused": False, "until": None})
        self.assertEqual(set(body["balance"]), {"available", "checkedAt", "error"})
        self.assertIsNone(body["balance"]["available"])
        self.assertTrue(body["balance"]["error"])
        self.assertEqual(len(body["last7Days"]), 7)
        self.assertEqual({tuple(sorted(d)) for d in body["last7Days"]}, {("date", "failed", "sent")})
        dates = [d["date"] for d in body["last7Days"]]
        self.assertEqual(dates, sorted(dates))
        self.assertTrue(all(d["sent"] == d["failed"] == 0 for d in body["last7Days"]))

    def test_configured_and_the_env_flags_never_carry_a_value(self):
        body = self.get("overview").json()
        self.assertTrue(body["configured"])
        self.assertTrue(body["sendingAllowed"])
        self.assertEqual(
            body["env"],
            {"authKey": True, "senderId": "UKTHRM", "templateName": TEMPLATE_NAME, "apiBase": TF_BASE},
        )
        self.assertNotIn(TF_KEY, json.dumps(body))
        self.assertIn("2Factor", body["balance"]["error"])

    def test_not_configured_and_not_allowed_are_explained(self):
        with override_settings(TWOFACTOR_API_KEY="your_2factor_api_key_here", TWOFACTOR_TEMPLATE_NAME=""):
            body = self.get("overview").json()
        self.assertFalse(body["configured"])
        self.assertEqual(
            (body["env"]["authKey"], body["env"]["templateName"]), (False, "")
        )  # a placeholder is not "set"
        self.assertIn("TWOFACTOR_API_KEY", body["sendingNote"])
        self.assertNotIn("your_2factor", json.dumps(body))
        with override_settings(SMS_ALLOW_SENDING=False):
            body = self.get("overview").json()
        self.assertTrue(body["configured"])
        self.assertFalse(body["sendingAllowed"])
        self.assertIn("development setup", body["sendingNote"])

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
        for _ in range(3):
            self.row(status="failed", error_code="timeout")
        circuit = self.get("overview").json()["circuit"]
        self.assertTrue(circuit["paused"])
        self.assertTrue(circuit["until"])

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
        self.assertEqual(self.get("overview").json()["today"]["sent"], 4)


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
        SmsSettings.objects.update_or_create(pk=1, defaults={"otp_channel": "sms"})
        with mock.patch(GET, return_value=provider_ok()) as post:
            r = self.client.post(
                "/api/auth/otp/request", {"employeeCode": "A1", "purpose": "login"}, content_type="application/json"
            )
        self.assertEqual(r.status_code, 200)
        code = code_in(post.call_args)
        text = self.get("messages").content.decode() + self.get("overview").content.decode()
        self.assertNotIn(code, text)
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
        self.assertEqual(post.call_args.args, (f"{TF_BASE}/{TF_KEY}/SMS/+919876543210/123456/{TEMPLATE_NAME}",))
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
        self.assertNotIn("123456", log.record_description or "")

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
            r, _ = self.send(response=provider_error(f"Invalid API Key {TF_KEY} for 919876543210 code 123456"))
        text = (
            r.content.decode()
            + "\n".join(lines)
            + json.dumps(list(SmsMessageLog.objects.values("error", "phone_masked")))
        )
        for secret in (TF_KEY, "9876543210", "123456"):
            self.assertNotIn(secret, text)


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
