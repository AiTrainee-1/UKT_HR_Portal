"""WhatsApp Control page API: monitoring, history, feature switches, wording, permissions."""

from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone

from .jwt_utils import sign_token
from .models import Branch, Employee, HRUser, Role, WhatsAppMessageLog, WhatsAppMessageTemplate, WhatsAppSettings

CONFIG = dict(
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok-very-secret",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    BACKEND_PUBLIC_URL="https://api.example.test",
)
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


class AccessTests(ControlBase):
    def test_every_endpoint_needs_an_hr_login(self):
        emp_token = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.asha.id})}"}
        for method, path in (
            ("get", "overview"),
            ("get", "messages"),
            ("get", "employees"),
            ("get", "settings"),
            ("put", "settings"),
            ("get", "templates"),
            ("put", "templates/salary_slip"),
        ):
            self.assertEqual(getattr(self.client, method)(f"{BASE}/{path}").status_code, 401, path)
            r = getattr(self.client, method)(f"{BASE}/{path}", **emp_token)
            self.assertEqual(r.status_code, 403, path)

    def test_role_permission_view_reads_but_cannot_change(self):
        role = Role.objects.create(name="Viewer", permissions={"whatsapp_control": "view"})
        viewer = _hr("viewer", super_admin=False, role=role)
        self.assertEqual(self.client.get(f"{BASE}/overview", **viewer).status_code, 200)
        self.assertEqual(self.put("settings", {"absentAlertEnabled": True}, viewer).status_code, 403)
        self.assertFalse(WhatsAppSettings.get().absent_alert_enabled)

    def test_role_permission_edit_can_change(self):
        role = Role.objects.create(name="Editor", permissions={"whatsapp_control": "edit"})
        editor = _hr("editor", super_admin=False, role=role)
        self.assertEqual(self.put("settings", {"absentAlertEnabled": True}, editor).status_code, 200)
        self.assertTrue(WhatsAppSettings.get().absent_alert_enabled)

    def test_a_role_without_the_module_is_locked_out(self):
        role = Role.objects.create(name="Other", permissions={"payroll": "edit"})
        other = _hr("other", super_admin=False, role=role)
        for path in ("overview", "messages", "settings", "templates"):
            self.assertEqual(self.client.get(f"{BASE}/{path}", **other).status_code, 403, path)


class OverviewTests(ControlBase):
    def test_counts_by_status_category_and_type(self):
        self.msg(self.asha, "salary_slip", "delivered")
        self.msg(self.asha, "salary_slip", "read")
        self.msg(self.ravi, "otp_login", "sent")
        self.msg(self.ravi, "absent_alert", "failed", error_message="No phone number on file for this employee.")
        self.msg(self.ravi, "geo_approval", "pending")
        body = self.get("overview").json()
        self.assertEqual(
            body["totals"],
            {"pending": 1, "sent": 1, "delivered": 1, "read": 1, "failed": 1, "total": 5, "accepted": 3},
        )
        self.assertEqual(body["byCategory"]["documents"]["total"], 2)
        self.assertEqual(body["byCategory"]["otp"]["sent"], 1)
        self.assertEqual(body["byCategory"]["attendance"]["failed"], 1)
        self.assertEqual(body["byCategory"]["geo"]["pending"], 1)
        by_type = {r["documentType"]: r for r in body["byType"]}
        self.assertEqual((by_type["salary_slip"]["total"], by_type["absent_alert"]["failed"]), (2, 1))
        self.assertEqual(body["byType"][0]["documentType"], "salary_slip")  # most used first

    def test_recent_failures_carry_the_reason(self):
        self.msg(self.ravi, "late_alert", "failed", error_message="Send failed: Instance not connected")
        failure = self.get("overview").json()["recentFailures"][0]
        self.assertEqual(
            (failure["employeeName"], failure["error"]), ("Ravi Nair", "Send failed: Instance not connected")
        )

    def test_window_and_daily_series(self):
        old = self.msg(self.asha, "salary_slip", "sent")
        WhatsAppMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=40))
        self.msg(self.asha, "salary_slip", "sent")
        self.assertEqual(self.get("overview").json()["totals"]["total"], 1)
        self.assertEqual(self.get("overview", days=60).json()["totals"]["total"], 2)
        daily = self.get("overview", days=60).json()["daily"]
        self.assertEqual([d["total"] for d in daily], [1, 1])
        self.assertEqual(self.get("overview", days="x").status_code, 400)

    def test_stale_pending_messages_are_flagged(self):
        stuck = self.msg(self.asha, "absent_alert", "pending")
        WhatsAppMessageLog.objects.filter(pk=stuck.pk).update(created_at=timezone.now() - timedelta(minutes=30))
        self.msg(self.asha, "late_alert", "pending")
        self.assertEqual(self.get("overview").json()["stalePending"], 1)

    def test_config_is_shown_but_no_secret_ever_is(self):
        body = self.get("overview").json()
        config = body["config"]
        self.assertTrue(config["configured"])
        self.assertEqual(config["instanceId"], "…1234")
        self.assertEqual(config["webhookUrl"], "https://api.example.test/api/whatsapp/webhook/")
        self.assertNotIn("tok-very-secret", str(body))
        self.assertNotIn("INST1234", str(body))

    @override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN="")
    def test_unconfigured_is_reported(self):
        self.assertFalse(self.get("overview").json()["config"]["configured"])


class MessageHistoryTests(ControlBase):
    def setUp(self):
        super().setUp()
        self.m1 = self.msg(self.asha, "salary_slip", "sent", message_text="Slip for August", provider_message_id="P1")
        self.m2 = self.msg(self.ravi, "otp_login", "sent", message_text="•••••• is your code")
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
            (first["messageText"], first["providerMessageId"], first["automatic"]), ("Slip for August", "P1", False)
        )

    def test_automatic_flag_covers_alerts_and_otps(self):
        rows = {r["id"]: r for r in self.get("messages").json()}
        self.assertTrue(rows[self.m3.id]["automatic"])  # has a dedupe key
        self.assertTrue(rows[self.m2.id]["automatic"])  # OTP
        self.assertFalse(rows[self.m4.id]["automatic"])

    def test_filters(self):
        self.assertEqual(self.ids(status="failed"), {self.m3.id})
        self.assertEqual(self.ids(category="otp"), {self.m2.id})
        self.assertEqual(self.ids(category="attendance"), {self.m3.id})
        self.assertEqual(self.ids(type="geo_approval"), {self.m4.id})
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
        self.assertEqual(self.client.get(f"{BASE}/overview", **scoped).json()["totals"]["total"], 1)
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
            after = self.by_key(self.put("settings", {key: new}).json(), "features")
            self.assertEqual(after[key]["enabled"], new, key)
            for other in before:
                if other != key:
                    self.assertEqual(after[other]["enabled"], before[other]["enabled"], f"{key} changed {other}")
            self.put("settings", {key: not new})

    def test_timings_are_validated_and_saved(self):
        r = self.put("settings", {"otpExpiryMinutes": 10, "absentExtraMinutes": "20"})
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
        ):
            self.assertEqual(self.put("settings", body).status_code, 400, body)
        s = WhatsAppSettings.get()
        self.assertEqual((s.otp_expiry_minutes, s.absent_alert_enabled, s.late_alert_enabled), (5, False, False))

    def test_unknown_keys_are_ignored_and_credentials_cannot_be_set_here(self):
        r = self.put("settings", {"instanceId": "HACK", "accessToken": "HACK", "bogus": 1})
        self.assertEqual(r.status_code, 200)
        from django.conf import settings

        self.assertEqual(settings.WACLIENT_INSTANCE_ID, "INST1234")
        self.assertNotIn("HACK", str(r.json()))

    def test_the_switches_really_drive_behaviour(self):
        self.put("settings", {"otpLoginEnabled": False})
        self.assertFalse(self.client.get("/api/auth/login-options").json()["otpLogin"])
        self.put("settings", {"otpLoginEnabled": True})
        self.assertTrue(self.client.get("/api/auth/login-options").json()["otpLogin"])


class TemplateTests(ControlBase):
    def test_lists_every_message_type_with_usage(self):
        self.msg(self.asha, "salary_slip", "sent")
        self.msg(self.asha, "salary_slip", "failed")
        from . import whatsapp_catalog as catalog

        rows = {r["documentType"]: r for r in self.get("templates").json()}
        self.assertEqual(set(rows), set(catalog.TYPES))
        slip = rows["salary_slip"]
        self.assertEqual((slip["total"], slip["failed"], slip["customised"], slip["isEnabled"]), (2, 1, False, True))
        self.assertIn("{{month_year}}", slip["defaultMessage"])
        self.assertIsNone(slip["featureEnabled"])  # a document has no switch of its own...
        self.assertTrue(slip["moduleEnabled"])  # ...but its module (Documents) does
        self.assertFalse(rows["absent_alert"]["featureEnabled"])
        self.assertTrue(rows["otp_login"]["featureEnabled"])
        self.assertEqual(rows["absent_alert"]["category"], "attendance")

    def test_wording_and_the_per_type_switch_can_be_changed(self):
        r = self.put("templates/absent_alert", {"messageBody": "  {{1}}, punch please  ", "isEnabled": False})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            (body["messageBody"], body["isEnabled"], body["customised"]), ("{{1}}, punch please", False, True)
        )
        row = WhatsAppMessageTemplate.objects.get(document_type="absent_alert")
        self.assertEqual((row.message_body, row.is_enabled), ("{{1}}, punch please", False))

    def test_a_code_message_must_keep_the_code_placeholder(self):
        self.assertEqual(self.put("templates/otp_login", {"messageBody": "Your code is coming"}).status_code, 400)
        self.assertEqual(self.put("templates/otp_login", {"messageBody": "Code: {{code}}"}).status_code, 200)
        self.assertEqual(self.put("templates/otp_reset", {"messageBody": "Reset code {{1}}"}).status_code, 200)
        self.assertEqual(self.put("templates/otp_activate", {"messageBody": "Welcome"}).status_code, 400)
        self.assertEqual(self.put("templates/otp_activate", {"messageBody": "Code {{1}}"}).status_code, 200)
        self.assertEqual(self.put("templates/otp_login", {"messageBody": ""}).status_code, 200)  # blank = default

    def test_unknown_type_is_rejected(self):
        self.assertEqual(self.put("templates/bogus", {"messageBody": "x"}).status_code, 400)


class CentralControlTests(ControlBase):
    """The pieces the centralised layer added: module switches, per-workflow switches, dashboard, variables, preview."""

    def features(self):
        return {f["key"]: f for f in self.get("settings").json()["features"]}

    def test_settings_list_groups_and_a_switch_for_every_module_and_approval_workflow(self):
        body = self.get("settings").json()
        self.assertEqual(
            [g["key"] for g in body["groups"]],
            ["signin", "documents", "attendance", "approvals", "geo", "visitors", "outpass"],
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
            "approvalResignationEnabled",
            "approvalAdvanceEnabled",
            "approvalRequestEnabled",
        ):
            self.assertIn(key, features, key)
        groups = {g["key"] for g in body["groups"]}
        self.assertTrue({f["group"] for f in features.values()} <= groups)

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
        self.put("settings", {"approvalLeaveEnabled": False, "approvalAdvanceEnabled": False})
        self.assertEqual(sorted(WhatsAppSettings.get().disabled_approval_modules), ["advance", "leave"])
        features = self.features()
        self.assertFalse(features["approvalLeaveEnabled"]["enabled"])
        self.assertTrue(features["approvalPermissionEnabled"]["enabled"])
        self.put("settings", {"approvalLeaveEnabled": True})
        self.assertEqual(WhatsAppSettings.get().disabled_approval_modules, ["advance"])
        self.assertEqual(self.put("settings", {"approvalLeaveEnabled": "yes"}).status_code, 400)

    def test_overview_reports_today_this_month_and_the_modules(self):
        self.msg(self.asha, "salary_slip", "delivered")
        self.msg(self.asha, "approval_approved", "sent", related_module="leave")
        self.msg(self.ravi, "geo_rejection", "failed", error_message="Instance not connected")
        old = self.msg(self.ravi, "salary_slip", "sent")
        WhatsAppMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=45))
        body = self.get("overview", days=90).json()
        self.assertEqual((body["today"]["total"], body["today"]["failed"], body["today"]["delivered"]), (3, 1, 1))
        self.assertGreaterEqual(body["thisMonth"]["total"], 3)
        self.assertEqual(body["totals"]["total"], 4)
        self.assertIn({"key": "approvals", "label": "Approvals"}, body["categories"])
        self.assertIn({"key": "leave", "label": "Leave"}, body["relatedModules"])
        self.assertIn({"key": "on_duty", "label": "On-Duty request"}, body["relatedModules"])
        self.assertEqual(body["byCategory"]["approvals"]["total"], 1)
        self.assertEqual(body["byCategory"]["geo"]["failed"], 1)

    def test_a_message_row_says_which_module_and_workflow_raised_it(self):
        self.msg(
            self.asha, "approval_rejected", "failed", related_module="leave", error_message="Instance not connected"
        )
        self.msg(self.ravi, "outpass_gate_out", "sent")
        rows = {r["documentType"]: r for r in self.get("messages", page=1, pageSize=50).json()["items"]}
        leave = rows["approval_rejected"]
        self.assertEqual(
            (leave["category"], leave["categoryLabel"], leave["relatedModule"], leave["relatedLabel"]),
            ("approvals", "Approvals", "leave", "Approvals - Leave"),
        )
        self.assertEqual((leave["phone"], leave["error"]), ("919000000001", "Instance not connected"))
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

    def test_template_rows_carry_variables_a_preview_and_flag_what_has_no_wording(self):
        rows = {r["documentType"]: r for r in self.get("templates").json()}
        approved = rows["approval_approved"]
        self.assertEqual(approved["category"], "approvals")
        self.assertIn("request_type", [v["name"] for v in approved["variables"]])
        self.assertIn("Approved by: Meena (HR)", approved["preview"])
        self.assertNotIn("{{", approved["preview"])
        self.assertTrue(approved["hasWording"])
        self.assertTrue(approved["moduleEnabled"])
        card = rows["visitor_contact"]
        self.assertFalse(card["hasWording"])
        self.assertEqual(rows["geo_rejection"]["featureEnabled"], False)  # the geo switch defaults off

    def test_wording_with_a_placeholder_the_type_does_not_have_is_refused(self):
        r = self.put("templates/approval_approved", {"messageBody": "Hi {{employe_name}}"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("employe_name", r.json()["error"])
        self.assertEqual(
            self.put("templates/approval_approved", {"messageBody": "Hi {{employee_name}}"}).status_code, 200
        )
        # Old numbered wording is fine as long as the number exists.
        self.assertEqual(self.put("templates/geo_approval", {"messageBody": "{{1}} {{6}}"}).status_code, 200)
        self.assertEqual(self.put("templates/geo_approval", {"messageBody": "{{1}} {{9}}"}).status_code, 400)

    def test_preview_renders_unsaved_wording_with_sample_values(self):
        r = self.client.post(
            f"{BASE}/templates/late_alert/preview",
            {"messageBody": "{{employee_name}} was late by {{late_by}}"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.json(), {"preview": "Asha Kumar was late by 35 minutes", "error": None})
        self.assertFalse(WhatsAppMessageTemplate.objects.filter(document_type="late_alert").exists())
        bad = self.client.post(
            f"{BASE}/templates/late_alert/preview",
            {"messageBody": "{{nope}}"},
            content_type="application/json",
            **self.hr,
        )
        self.assertIn("nope", bad.json()["error"])
        self.assertEqual(
            self.client.post(
                f"{BASE}/templates/bogus/preview", {}, content_type="application/json", **self.hr
            ).status_code,
            400,
        )
