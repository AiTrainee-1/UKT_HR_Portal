"""WhatsApp Control page API (Meta WhatsApp Cloud API, 2026-11-20): access, history, employees, the settings (switches,
OTP master, template overrides, prices, budget), the retired wording endpoints. The Overview / Usage figures are in
tests_whatsapp_usage.py and the Meta templates in tests_whatsapp_templates.py."""

from datetime import timedelta
from decimal import Decimal

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from . import whatsapp_catalog as catalog
from . import whatsapp_service
from .jwt_utils import sign_token
from .models import Branch, Employee, HRUser, Role, WhatsAppMessageLog, WhatsAppSettings
from .tests_whatsapp_support import META, NO_META, TOKEN, FakeMeta, approve_templates, make_template

CONFIG = dict(META, BACKEND_PUBLIC_URL="https://api.example.test")
BASE = "/api/whatsapp-control"


def _hr(username="wc_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


@override_settings(**CONFIG)
class ControlBase(TestCase):
    def setUp(self):
        cache.clear()
        self.meta = FakeMeta.install(self)
        self.hr = _hr()
        self.asha = Employee.objects.create(
            employee_code="A1", first_name="Asha", last_name="Kumar", phone="9000000001", status="active"
        )
        self.ravi = Employee.objects.create(
            employee_code="R1", first_name="Ravi", last_name="Nair", phone="9000000002", status="active"
        )

    def msg(self, emp, doc_type="salary_slip", status="sent", **kw):
        return WhatsAppMessageLog.objects.create(
            employee=emp,
            document_type=doc_type,
            phone_number=kw.pop("phone_number", "91" + emp.phone),
            status=status,
            **kw,
        )

    def get(self, path, **params):
        return self.client.get(f"{BASE}/{path}", params, **self.hr)

    def put(self, path, body, headers=None):
        return self.client.put(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def patch(self, path, body, headers=None):
        return self.client.patch(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))


class AccessTests(ControlBase):
    def test_every_endpoint_needs_an_hr_login(self):
        emp_token = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.asha.id})}"}
        for method, path in (
            ("get", "overview"),
            ("get", "usage"),
            ("get", "messages"),
            ("get", "employees"),
            ("get", "settings"),
            ("patch", "settings"),
            ("put", "settings"),
            ("get", "queue"),
            ("get", "meta-templates"),
            ("get", "meta-templates/draft/late_alert"),
            ("post", "meta-templates/sync"),
            ("post", "meta-templates/create-missing"),
            ("delete", "meta-templates/1"),
        ):
            self.assertEqual(getattr(self.client, method)(f"{BASE}/{path}").status_code, 401, path)
            r = getattr(self.client, method)(f"{BASE}/{path}", **emp_token)
            self.assertEqual(r.status_code, 403, path)
        self.assertEqual(self.meta.calls, [])

    def test_role_permission_view_reads_but_cannot_change(self):
        role = Role.objects.create(name="Viewer", permissions={"whatsapp_control": "view"})
        viewer = _hr("viewer", super_admin=False, role=role)
        for path in ("overview", "usage", "settings", "meta-templates"):
            self.assertEqual(self.client.get(f"{BASE}/{path}", **viewer).status_code, 200, path)
        self.assertEqual(self.patch("settings", {"absentAlertEnabled": True}, viewer).status_code, 403)
        self.assertEqual(self.put("settings", {"absentAlertEnabled": True}, viewer).status_code, 403)
        self.assertFalse(WhatsAppSettings.get().absent_alert_enabled)

    def test_role_permission_edit_can_change(self):
        role = Role.objects.create(name="Editor", permissions={"whatsapp_control": "edit"})
        editor = _hr("editor", super_admin=False, role=role)
        self.assertEqual(self.patch("settings", {"absentAlertEnabled": True}, editor).status_code, 200)
        self.assertTrue(WhatsAppSettings.get().absent_alert_enabled)

    def test_a_role_without_the_module_is_locked_out(self):
        role = Role.objects.create(name="Other", permissions={"payroll": "edit"})
        other = _hr("other", super_admin=False, role=role)
        for path in ("overview", "usage", "messages", "settings", "meta-templates"):
            self.assertEqual(self.client.get(f"{BASE}/{path}", **other).status_code, 403, path)

    def test_the_old_message_text_endpoints_are_gone(self):
        for path in (
            f"{BASE}/templates",
            f"{BASE}/templates/salary_slip",
            f"{BASE}/templates/salary_slip/preview",
            "/api/whatsapp/templates",
            "/api/whatsapp/templates/salary_slip",
        ):
            self.assertEqual(self.client.get(path, **self.hr).status_code, 404, path)
            self.assertEqual(
                self.client.put(path, {"messageBody": "x"}, content_type="application/json", **self.hr).status_code,
                404,
                path,
            )


class OverviewTests(ControlBase):
    def test_todays_and_this_months_counts_and_recent_failures(self):
        self.msg(self.asha, "salary_slip", "delivered")
        self.msg(self.ravi, "geo_rejection", "failed", error_message="Refused by WhatsApp: not on WhatsApp")
        old = self.msg(self.ravi, "salary_slip", "sent")
        WhatsAppMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=45))
        body = self.get("overview").json()
        self.assertEqual((body["today"]["total"], body["today"]["failed"], body["today"]["delivered"]), (2, 1, 1))
        failure = body["recentFailures"][0]
        self.assertEqual(
            (failure["employeeName"], failure["error"]), ("Ravi Nair", "Refused by WhatsApp: not on WhatsApp")
        )
        self.assertIn({"key": "approvals", "label": "Approvals"}, body["categories"])
        self.assertIn({"key": "on_duty", "label": "On-Duty request"}, body["relatedModules"])

    def test_stale_pending_messages_are_flagged(self):
        stuck = self.msg(self.asha, "absent_alert", "pending")
        WhatsAppMessageLog.objects.filter(pk=stuck.pk).update(created_at=timezone.now() - timedelta(minutes=30))
        self.msg(self.asha, "late_alert", "pending")
        self.assertEqual(self.get("overview").json()["stalePending"], 1)

    def test_config_is_shown_but_no_secret_ever_is(self):
        body = self.get("overview").json()
        config = body["config"]
        self.assertTrue(config["configured"])
        self.assertEqual(config["provider"], "Meta WhatsApp Cloud API")
        self.assertEqual(config["webhookUrl"], "https://api.example.test/api/whatsapp/webhook/")
        self.assertTrue(config["webhookVerifyTokenSet"])
        self.assertNotIn(TOKEN, str(body))
        self.assertNotIn(META["WHATSAPP_CLOUD_APP_SECRET"], str(body))
        self.assertNotIn(META["WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN"], str(body))
        self.assertNotIn("waclient", str(body).lower())

    @override_settings(**NO_META)
    def test_unconfigured_is_reported(self):
        body = self.get("overview").json()
        self.assertFalse(body["config"]["configured"])
        self.assertFalse(body["connection"]["configured"])


class MessageHistoryTests(ControlBase):
    def setUp(self):
        super().setUp()
        self.m1 = self.msg(
            self.asha,
            "salary_slip",
            "read",
            message_text="Slip for August",
            provider_message_id="wamid.P1",
            template_name="hrms_salary_slip",
            pricing_category="utility",
            billable=True,
            delivered_at=timezone.now(),
            read_at=timezone.now(),
        )
        self.m2 = self.msg(self.ravi, "otp_login", "sent", message_text="•••••• is your code", template_name="hrms_otp")
        self.m3 = self.msg(self.ravi, "absent_alert", "failed", error_message="boom", dedupe_key="absent:2026-09-23:2")
        self.m4 = self.msg(self.asha, "geo_approval", "delivered")

    def ids(self, **params):
        body = self.get("messages", **params).json()
        rows = body["items"] if isinstance(body, dict) else body
        return {r["id"] for r in rows}

    def test_newest_first_with_full_detail(self):
        rows = self.get("messages").json()
        self.assertEqual([r["id"] for r in rows], [self.m4.id, self.m3.id, self.m2.id, self.m1.id])
        first = {r["id"]: r for r in rows}[self.m1.id]
        self.assertEqual(
            (first["employeeName"], first["employeeCode"], first["typeLabel"], first["category"], first["phone"]),
            ("Asha Kumar", "A1", "Salary Slip", "documents", "919000000001"),
        )
        self.assertEqual(
            (first["messageText"], first["providerMessageId"], first["automatic"]),
            ("Slip for August", "wamid.P1", False),
        )

    def test_meta_fields(self):
        rows = {r["id"]: r for r in self.get("messages").json()}
        slip = rows[self.m1.id]
        self.assertEqual(
            (slip["templateName"], slip["pricingCategory"], slip["billable"]), ("hrms_salary_slip", "utility", True)
        )
        self.assertTrue(slip["pricingCategoryFromMeta"])
        self.assertTrue(slip["deliveredAt"] and slip["readAt"])
        code = rows[self.m2.id]
        self.assertEqual(
            (code["pricingCategory"], code["billable"], code["deliveredAt"]), ("authentication", None, None)
        )
        self.assertFalse(code["pricingCategoryFromMeta"])
        self.assertEqual(rows[self.m4.id]["pricingCategory"], "utility")

    def test_the_template_category_is_used_when_meta_has_not_said(self):
        make_template("hrms_geo_custom", category="MARKETING")
        self.msg(self.asha, "geo_approval", "sent", template_name="hrms_geo_custom")
        rows = self.get("messages", template="hrms_geo_custom").json()
        self.assertEqual([r["pricingCategory"] for r in rows], ["marketing"])

    def test_automatic_flag_covers_alerts_and_otps(self):
        rows = {r["id"]: r for r in self.get("messages").json()}
        self.assertTrue(rows[self.m3.id]["automatic"])  # has a dedupe key
        self.assertTrue(rows[self.m2.id]["automatic"])  # OTP
        self.assertFalse(rows[self.m4.id]["automatic"])

    def test_filters(self):
        self.assertEqual(self.ids(status="failed"), {self.m3.id})
        self.assertEqual(self.ids(status="read"), {self.m1.id})
        self.assertEqual(self.ids(category="otp"), {self.m2.id})
        self.assertEqual(self.ids(category="attendance"), {self.m3.id})
        self.assertEqual(self.ids(type="geo_approval"), {self.m4.id})
        self.assertEqual(self.ids(template="hrms_otp"), {self.m2.id})
        self.assertEqual(self.ids(employeeId=self.ravi.id), {self.m2.id, self.m3.id})
        self.assertEqual(self.ids(status="sent", employeeId=self.ravi.id), {self.m2.id})

    def test_search_by_name_code_or_phone(self):
        self.assertEqual(self.ids(search="asha"), {self.m1.id, self.m4.id})
        self.assertEqual(self.ids(search="R1"), {self.m2.id, self.m3.id})
        self.assertEqual(self.ids(search="9000000002"), {self.m2.id, self.m3.id})
        self.assertEqual(self.ids(search="nobody"), set())

    def test_date_range_is_inclusive_and_uses_the_factory_day(self):
        WhatsAppMessageLog.objects.filter(pk=self.m1.pk).update(created_at=timezone.now() - timedelta(days=10))
        day = (
            (timezone.now() - timedelta(days=10)).astimezone(__import__("api.clock", fromlist=["x"]).FACTORY_TZ).date()
        )
        self.assertEqual(self.ids(dateFrom=day.isoformat(), dateTo=day.isoformat()), {self.m1.id})
        self.assertEqual(self.ids(dateTo=(day - timedelta(days=1)).isoformat()), set())

    def test_pagination_envelope(self):
        body = self.get("messages", page=1, pageSize=3).json()
        self.assertEqual((body["total"], body["page"], body["pageSize"], len(body["items"])), (4, 1, 3, 3))
        self.assertEqual(len(self.get("messages", page=2, pageSize=3).json()["items"]), 1)
        self.assertIn("pricingCategory", body["items"][0])

    def test_bad_filters_are_400s(self):
        for params in (
            {"status": "weird"},
            {"category": "weird"},
            {"employeeId": "x"},
            {"dateFrom": "yesterday"},
            {"page": "x"},
        ):
            self.assertEqual(self.get("messages", **params).status_code, 400, params)


class BranchScopeTests(ControlBase):
    def test_a_branch_scoped_login_only_sees_its_own_branch(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.asha.pk).update(branch=north)
        Employee.objects.filter(pk=self.ravi.pk).update(branch=south)
        n, s = self.msg(self.asha), self.msg(self.ravi)
        role = Role.objects.create(name="North HR", permissions={"whatsapp_control": "edit"})
        scoped = _hr("north_hr", super_admin=False, role=role, branch=north)
        rows = self.client.get(f"{BASE}/messages", **scoped).json()
        self.assertEqual({r["id"] for r in rows}, {n.id})
        self.assertEqual(self.client.get(f"{BASE}/overview", **scoped).json()["today"]["total"], 1)
        emp_rows = self.client.get(f"{BASE}/employees", **scoped).json()
        self.assertEqual([r["employeeId"] for r in emp_rows], [self.asha.id])
        self.assertEqual({r["id"] for r in self.get("messages").json()}, {n.id, s.id})


class EmployeeWiseTests(ControlBase):
    def test_counts_per_employee_most_recent_first(self):
        self.msg(self.asha, "salary_slip", "sent")
        self.msg(self.ravi, "absent_alert", "failed")
        self.msg(self.ravi, "late_alert", "sent")
        rows = self.get("employees").json()
        self.assertEqual([r["employeeCode"] for r in rows], ["R1", "A1"])
        ravi = rows[0]
        self.assertEqual((ravi["total"], ravi["failed"], ravi["phone"]), (2, 1, "919000000002"))
        self.assertTrue(ravi["lastMessageAt"])

    def test_employees_never_messaged_are_left_out_and_search_works(self):
        Employee.objects.create(employee_code="Q1", first_name="Quiet", last_name="One", phone="9")
        self.msg(self.asha)
        self.assertEqual([r["employeeCode"] for r in self.get("employees").json()], ["A1"])
        self.assertEqual(self.get("employees", search="zzz").json(), [])
        self.assertEqual(len(self.get("employees", search="asha").json()), 1)

    def test_opting_out_and_back_in(self):
        r = self.patch(f"employees/{self.asha.id}/opt-out", {"optOut": True, "reason": "Not my number"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["optOut"], r.json()["optOutReason"]), (True, "Not my number"))
        self.assertTrue(whatsapp_service.opted_out(self.asha))
        self.assertFalse(self.patch(f"employees/{self.asha.id}/opt-out", {"optOut": False}).json()["optOut"])
        self.assertEqual(self.patch(f"employees/{self.asha.id}/opt-out", {"optOut": "yes"}).status_code, 400)
        self.assertEqual(self.patch("employees/999999/opt-out", {"optOut": True}).status_code, 404)


class SettingsTests(ControlBase):
    def by_key(self, body, section):
        return {row["key"]: row for row in body[section]}

    def test_defaults_are_safe(self):
        body = self.get("settings").json()
        features = self.by_key(body, "features")
        for key in ("otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled", "passwordLoginEnabled"):
            self.assertTrue(features[key]["enabled"], key)
        for key in (
            "absentAlertEnabled",
            "lateAlertEnabled",
            "fourPunchAlertEnabled",
            "missingPunchAlertEnabled",
            "geoApprovalEnabled",
        ):
            self.assertFalse(features[key]["enabled"], key)
        self.assertEqual(self.by_key(body, "timings")["otpExpiryMinutes"]["value"], 5)
        self.assertTrue(body["config"]["configured"])
        self.assertTrue(body["otpEnabled"])
        self.assertEqual(body["templateOverrides"], {})
        self.assertEqual(
            body["priceRates"], {"authentication": 0.115, "utility": 0.115, "marketing": 0.8631, "service": 0.0}
        )
        self.assertEqual(body["defaultPriceRates"], body["priceRates"])
        self.assertIsNone(body["monthlyBudget"])
        self.assertEqual((body["gstRate"], body["currency"]), (0.18, "INR"))

    def test_patch_and_put_both_save(self):
        self.assertEqual(self.patch("settings", {"lateAlertEnabled": True}).status_code, 200)
        self.assertEqual(self.put("settings", {"absentAlertEnabled": True}).status_code, 200)
        s = WhatsAppSettings.get()
        self.assertEqual((s.late_alert_enabled, s.absent_alert_enabled), (True, True))

    def test_every_toggle_can_be_flipped_independently(self):
        for key in (
            "absentAlertEnabled",
            "missingPunchAlertEnabled",
            "lateAlertEnabled",
            "fourPunchAlertEnabled",
            "geoApprovalEnabled",
            "otpLoginEnabled",
            "otpResetEnabled",
            "otpActivateEnabled",
            "passwordLoginEnabled",
        ):
            before = self.by_key(self.get("settings").json(), "features")
            new = not before[key]["enabled"]
            after = self.by_key(self.patch("settings", {key: new}).json(), "features")
            self.assertEqual(after[key]["enabled"], new, key)
            for other in before:
                if other != key:
                    self.assertEqual(after[other]["enabled"], before[other]["enabled"], f"{key} changed {other}")
            self.patch("settings", {key: not new})

    def test_the_whatsapp_otp_master(self):
        self.assertFalse(self.patch("settings", {"otpEnabled": False}).json()["otpEnabled"])
        self.assertFalse(WhatsAppSettings.get().otp_enabled)
        self.assertEqual(self.patch("settings", {"otpEnabled": "no"}).status_code, 400)
        self.assertTrue(self.patch("settings", {"otpEnabled": True}).json()["otpEnabled"])

    def test_timings_are_validated_and_saved(self):
        r = self.patch("settings", {"otpExpiryMinutes": 10, "absentExtraMinutes": "20"})
        self.assertEqual(r.status_code, 200)
        s = WhatsAppSettings.get()
        self.assertEqual((s.otp_expiry_minutes, s.absent_extra_minutes), (10, 20))

    def test_bad_values_are_rejected_and_change_nothing(self):
        for body in (
            {"otpExpiryMinutes": 0},
            {"otpExpiryMinutes": 999},
            {"absentExtraMinutes": "abc"},
            {"absentAlertEnabled": "yes"},
            {"lateAlertEnabled": 1},
            {"lateAlertEnabled": True, "monthlyBudget": -1},  # one refusal saves nothing at all
        ):
            self.assertEqual(self.patch("settings", body).status_code, 400, body)
        s = WhatsAppSettings.get()
        self.assertEqual((s.otp_expiry_minutes, s.absent_alert_enabled, s.late_alert_enabled), (5, False, False))

    def test_template_overrides(self):
        r = self.patch(
            "settings", {"templateOverrides": {"late_alert": "hrms_late_v2", "absent_alert": "hrms_absent_v2"}}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json()["templateOverrides"], {"late_alert": "hrms_late_v2", "absent_alert": "hrms_absent_v2"}
        )
        self.assertEqual(whatsapp_service.template_name_for("late_alert"), "hrms_late_v2")
        # merged: a blank name (or the default) puts one type back, the others stay
        default = catalog.get("absent_alert").default_template_name
        r = self.patch("settings", {"templateOverrides": {"late_alert": "", "absent_alert": default}})
        self.assertEqual(r.json()["templateOverrides"], {})
        for bad in (
            {"bogus_type": "hrms_x"},
            {"late_alert": "Hrms Late"},
            {"late_alert": 5},
            "hrms_x",
        ):
            self.assertEqual(self.patch("settings", {"templateOverrides": bad}).status_code, 400, bad)
        self.assertEqual(WhatsAppSettings.get().template_overrides, {})

    def test_a_type_not_sent_through_meta_takes_no_template(self):
        from unittest import mock

        spec = catalog.MessageType(key="no_meta", label="No Meta", module="visitors", body="x", meta_template="-")
        with mock.patch.dict(catalog.TYPES, {"no_meta": spec}):
            r = self.patch("settings", {"templateOverrides": {"no_meta": "hrms_x"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("not sent through WhatsApp Cloud API", r.json()["error"])

    def test_price_rates(self):
        r = self.patch("settings", {"priceRates": {"utility": 0.2, "marketing": "0.9"}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["priceRates"]["utility"], r.json()["priceRates"]["marketing"]), (0.2, 0.9))
        self.assertEqual(r.json()["priceRates"]["authentication"], 0.115)
        r = self.patch("settings", {"priceRates": {"utility": None}})  # back to the default
        self.assertEqual(r.json()["priceRates"]["utility"], 0.115)
        self.assertEqual(r.json()["priceRates"]["marketing"], 0.9)
        for bad in ({"utility": -0.1}, {"utility": 101}, {"utility": True}, {"utility": "abc"}, {"promo": 1}, [1]):
            self.assertEqual(self.patch("settings", {"priceRates": bad}).status_code, 400, bad)

    def test_monthly_budget(self):
        r = self.patch("settings", {"monthlyBudget": 1500.5})
        self.assertEqual(r.json()["monthlyBudget"], 1500.5)
        self.assertEqual(WhatsAppSettings.get().monthly_budget, Decimal("1500.50"))
        self.assertEqual(self.patch("settings", {"monthlyBudget": "0"}).json()["monthlyBudget"], 0.0)
        self.assertIsNone(self.patch("settings", {"monthlyBudget": None}).json()["monthlyBudget"])
        for bad in (-1, "lots", True, 10**12):
            self.assertEqual(self.patch("settings", {"monthlyBudget": bad}).status_code, 400, bad)

    def test_unknown_keys_are_ignored_and_credentials_cannot_be_set_here(self):
        r = self.patch("settings", {"accessToken": "HACK", "WHATSAPP_CLOUD_ACCESS_TOKEN": "HACK", "bogus": 1})
        self.assertEqual(r.status_code, 200)
        from django.conf import settings

        self.assertEqual(settings.WHATSAPP_CLOUD_ACCESS_TOKEN, TOKEN)
        self.assertNotIn("HACK", str(r.json()))
        self.assertNotIn(TOKEN, str(r.json()))

    def test_the_switches_really_drive_the_apps_sign_in(self):
        approve_templates("otp_login", "otp_reset", "otp_activate")

        def login_channels():
            return self.client.get("/api/auth/login-options").json()["otpChannels"]["login"]

        self.assertIn("whatsapp", login_channels())
        self.patch("settings", {"otpLoginEnabled": False})
        self.assertNotIn("whatsapp", login_channels())
        self.patch("settings", {"otpLoginEnabled": True, "otpEnabled": False})
        options = self.client.get("/api/auth/login-options").json()
        self.assertNotIn("whatsapp", options["otpChannels"]["login"] + options["otpChannels"]["reset"])
        self.patch("settings", {"otpEnabled": True})
        self.assertIn("whatsapp", login_channels())

    def test_a_change_is_audited(self):
        from .models import AuditLog

        self.patch("settings", {"lateAlertEnabled": True, "monthlyBudget": 100})
        entry = AuditLog.objects.filter(module="whatsapp_control").order_by("-id").first()
        self.assertIsNotNone(entry)
        self.assertIn("late_alert_enabled", entry.record_description)
        self.assertEqual(entry.new_values["monthly_budget"], "100.00")


class CentralControlTests(ControlBase):
    """Module switches, per-workflow switches and the per-type switches."""

    def features(self):
        return {f["key"]: f for f in self.get("settings").json()["features"]}

    def test_settings_list_groups_and_a_switch_for_every_module_and_approval_workflow(self):
        body = self.get("settings").json()
        self.assertEqual(
            [g["key"] for g in body["groups"]],
            # "other" = Attendance Notify's reports, "hod" = Department Head notifications (2026-11-17)
            ["signin", "documents", "attendance", "approvals", "hod", "geo", "visitors", "outpass", "other"],
        )
        features = self.features()
        for key in (
            "documentNotificationsEnabled",
            "attendanceAlertsEnabled",
            "approvalNotificationsEnabled",
            "visitorNotificationEnabled",
            "outpassNotificationsEnabled",
            "approvalLeaveEnabled",
            "approvalPermissionEnabled",
            "approvalCasualLeaveEnabled",
            "approvalMissingPunchEnabled",
            "approvalOutpassEnabled",
            "approvalAttendanceCorrectionEnabled",
            "approvalHolidayWorkEnabled",
            "approvalResignationEnabled",
            "approvalAdvanceEnabled",
            "approvalRequestEnabled",
        ):
            self.assertIn(key, features, key)
        # every type with a switch of its own is listed; one never sent through Meta (the retired visitor contact card)
        # keeps its switch so older pages can still send it, and it has no template
        for key in catalog.individually_switched():
            self.assertIn(f"type:{key}", features, key)
        not_via_meta = [k for k, t in catalog.TYPES.items() if t.default_template_name is None]
        self.assertEqual(self.patch("settings", {f"type:{k}": False for k in not_via_meta}).status_code, 200)
        overrides = {k: "hrms_x" for k in not_via_meta}
        if overrides:
            self.assertEqual(self.patch("settings", {"templateOverrides": overrides}).status_code, 400)

    def test_module_switches_default_on_and_the_broadcast_alerts_stay_off(self):
        features = self.features()
        for key in (
            "documentNotificationsEnabled",
            "attendanceAlertsEnabled",
            "approvalNotificationsEnabled",
            "visitorNotificationEnabled",
            "outpassNotificationsEnabled",
            "approvalLeaveEnabled",
        ):
            self.assertTrue(features[key]["enabled"], key)
        for key in ("absentAlertEnabled", "lateAlertEnabled", "fourPunchAlertEnabled", "missingPunchAlertEnabled"):
            self.assertFalse(features[key]["enabled"], key)

    def test_each_approval_workflow_can_be_switched_off_on_its_own(self):
        self.patch("settings", {"approvalLeaveEnabled": False, "approvalAdvanceEnabled": False})
        self.assertEqual(sorted(WhatsAppSettings.get().disabled_approval_modules), ["advance", "leave"])
        features = self.features()
        self.assertFalse(features["approvalLeaveEnabled"]["enabled"])
        self.assertTrue(features["approvalPermissionEnabled"]["enabled"])
        self.patch("settings", {"approvalLeaveEnabled": True})
        self.assertEqual(WhatsAppSettings.get().disabled_approval_modules, ["advance"])
        self.assertEqual(self.patch("settings", {"approvalLeaveEnabled": "yes"}).status_code, 400)

    def test_a_type_switch_turns_one_message_type_off(self):
        from . import whatsapp_control_views as views

        key, doc_type = next(iter(views.TYPE_SWITCHES.items()))
        self.assertTrue(self.features()[key]["enabled"])
        self.patch("settings", {key: False})
        self.assertIn(doc_type, WhatsAppSettings.get().disabled_message_types)
        self.assertFalse(self.features()[key]["enabled"])
        self.assertIsNotNone(whatsapp_service.switch_off_reason(doc_type))
        self.assertEqual(self.patch("settings", {"type:bogus": False}).status_code, 400)

    def test_a_message_row_says_which_module_and_workflow_raised_it(self):
        self.msg(
            self.asha, "approval_rejected", "failed", related_module="leave", error_message="Refused by WhatsApp: x"
        )
        self.msg(self.ravi, "outpass_gate_out", "sent")
        rows = {r["documentType"]: r for r in self.get("messages", page=1, pageSize=50).json()["items"]}
        leave = rows["approval_rejected"]
        self.assertEqual(
            (leave["category"], leave["categoryLabel"], leave["relatedModule"], leave["relatedLabel"]),
            ("approvals", "Approvals", "leave", "Approvals - Leave"),
        )
        self.assertEqual(rows["outpass_gate_out"]["relatedLabel"], "Outpass & Gate")

    def test_messages_can_be_filtered_by_workflow_and_module(self):
        self.msg(self.asha, "approval_approved", "sent", related_module="leave")
        self.msg(self.asha, "approval_approved", "sent", related_module="permission")
        self.msg(self.asha, "visitor_notification", "sent")
        page = self.get("messages", related="leave", page=1, pageSize=10).json()
        self.assertEqual([m["relatedModule"] for m in page["items"]], ["leave"])
        page = self.get("messages", category="approvals", page=1, pageSize=10).json()
        self.assertEqual(page["total"], 2)
        page = self.get("messages", category="visitors", page=1, pageSize=10).json()
        self.assertEqual(page["total"], 1)
