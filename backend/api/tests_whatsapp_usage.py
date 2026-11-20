"""WhatsApp Control -> Overview and Usage & Cost (whatsapp_usage.py): counts, Meta pricing categories, billable, cost so
far / projected / GST / budget, Meta's own figures (cached), the connection summary and the alerts. No test reaches Meta
(FakeMeta)."""

from datetime import date, datetime, timedelta
from decimal import Decimal

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from . import whatsapp_catalog as catalog
from . import whatsapp_service
from . import whatsapp_usage as wa_usage
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import Branch, Employee, EmployeeOtp, HRUser, Role, WhatsAppMessageLog, WhatsAppSettings
from .tests_whatsapp_support import META, NO_META, TOKEN, FakeMeta, approve_templates, make_template

BASE = "/api/whatsapp-control"
NOW = datetime(2026, 11, 15, 12, 0, tzinfo=FACTORY_TZ)
NOV = date(2026, 11, 1)


def _hr(username="usage_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


@override_settings(**META)
class UsageBase(TestCase):
    def setUp(self):
        cache.clear()
        self.meta = FakeMeta.install(self)
        self.hr = _hr()
        self.asha = Employee.objects.create(
            employee_code="U1", first_name="Asha", last_name="Kumar", phone="9000000011", status="active"
        )

    def log(self, doc_type, status="sent", when=None, **kw):
        row = WhatsAppMessageLog.objects.create(
            employee=kw.pop("employee", self.asha),
            document_type=doc_type,
            phone_number=kw.pop("phone_number", "919000000011"),
            status=status,
            **kw,
        )
        if when is not None:
            WhatsAppMessageLog.objects.filter(pk=row.pk).update(created_at=when)
        return row

    def on(self, day, month=11, year=2026, hour=10):
        return datetime(year, month, day, hour, 0, tzinfo=FACTORY_TZ)

    def november(self):
        """A month of messages (see the expected figures in the tests)."""
        for status in ("sent", "delivered", "read"):
            self.log("salary_slip", status, self.on(2), template_name="hrms_salary_slip")
        self.log("otp_login", "sent", self.on(3), template_name="hrms_otp")
        self.log("otp_login", "sent", self.on(3), template_name="hrms_otp")
        self.log("late_alert", "failed", self.on(4))
        self.log("absent_alert", "skipped", self.on(4))
        self.log("approval_approved", "delivered", self.on(5), pricing_category="service", billable=False)
        self.log("approval_rejected", "sent", self.on(5), pricing_category="utility", billable=False)
        self.log("visitor_notification", "read", self.on(6), pricing_category="marketing", billable=True)
        self.log("outpass_gate_out", "queued", self.on(15, hour=9))
        self.log("salary_slip", "sent", self.on(31, month=10))  # October: not counted

    def usage(self, month=NOV, now=NOW, **kw):
        return wa_usage.usage(WhatsAppMessageLog.objects.all(), month, now=now, **kw)


class CategoryTests(UsageBase):
    def test_metas_receipt_wins_then_codes_then_template_then_catalog(self):
        self.assertEqual(wa_usage.category_of("salary_slip", "MARKETING", "", {}), "marketing")
        self.assertEqual(wa_usage.category_of("otp_login", "", "", {}), "authentication")
        self.assertEqual(wa_usage.category_of("late_alert", "", "hrms_x", {"hrms_x": "MARKETING"}), "marketing")
        self.assertEqual(wa_usage.category_of("late_alert", "", "", {}), "utility")
        self.assertEqual(wa_usage.category_of("bogus_type", "", "", {}), "utility")

    def test_metas_finer_categories_fold_into_the_four(self):
        self.assertEqual(wa_usage.normalise_category("authentication_international"), "authentication")
        self.assertEqual(wa_usage.normalise_category("marketing_lite"), "marketing")
        self.assertEqual(wa_usage.normalise_category("referral_conversion"), "service")
        self.assertIsNone(wa_usage.normalise_category(""))

    def test_months(self):
        self.assertEqual(wa_usage.parse_month("2026-02"), date(2026, 2, 1))
        self.assertEqual(wa_usage.parse_month("", now=NOW), NOV)
        for bad in ("2026-13", "26-11", "2026/11", "november", "1999-01"):
            with self.assertRaises(ValueError):
                wa_usage.parse_month(bad)


class UsageTests(UsageBase):
    def test_counts_billable_and_cost_by_category(self):
        self.november()
        u = self.usage(with_meta=False)
        self.assertEqual(u["month"], "2026-11")
        totals = u["totals"]
        self.assertEqual(
            {k: totals[k] for k in ("sent", "delivered", "read", "failed", "skipped", "queued", "billable")},
            {"sent": 8, "delivered": 2, "read": 2, "failed": 1, "skipped": 1, "queued": 1, "billable": 6},
        )
        self.assertEqual((totals["deliveryRate"], totals["readRate"]), (0.5, 0.25))
        self.assertEqual(
            u["byCategory"],
            {
                "authentication": {"messages": 2, "billable": 2, "rate": 0.115, "cost": 0.23},
                "utility": {"messages": 4, "billable": 3, "rate": 0.115, "cost": 0.35},
                "marketing": {"messages": 1, "billable": 1, "rate": 0.8631, "cost": 0.86},
                "service": {"messages": 1, "billable": 0, "rate": 0.0, "cost": 0.0},
            },
        )
        self.assertEqual(u["rates"], {"authentication": 0.115, "utility": 0.115, "marketing": 0.8631, "service": 0.0})

    def test_cost_so_far_projection_and_gst(self):
        self.november()
        cost = self.usage(with_meta=False)["cost"]
        # 3 x 0.115 + 2 x 0.115 + 0.8631 = 1.4381 in 15 of 30 days
        self.assertEqual((cost["soFar"], cost["soFarWithGst"]), (1.44, 1.70))
        self.assertEqual((cost["projected"], cost["projectedWithGst"]), (2.88, 3.39))
        self.assertEqual((cost["gstRate"], cost["currency"], cost["isCurrentMonth"]), (0.18, "INR", True))
        self.assertEqual((cost["daysElapsed"], cost["daysInMonth"]), (15, 30))
        self.assertIsNone(cost["budget"])
        self.assertIsNone(cost["budgetUsedPct"])

    def test_the_budget(self):
        self.november()
        s = WhatsAppSettings.get()
        s.monthly_budget = Decimal("2.00")
        s.save()
        cost = self.usage(with_meta=False)["cost"]
        self.assertEqual((cost["budget"], cost["budgetUsedPct"], cost["projectedBudgetPct"]), (2.0, 71.9, 143.8))
        self.assertFalse(cost["budgetIncludesGst"])

    def test_hrs_rates_are_used(self):
        self.november()
        s = WhatsAppSettings.get()
        s.price_rates = {"utility": 0.2, "bogus": 5, "marketing": -1}
        s.save()
        u = self.usage(with_meta=False)
        self.assertEqual(u["rates"]["utility"], 0.2)
        self.assertEqual(u["rates"]["marketing"], 0.8631)  # a negative rate is ignored
        self.assertEqual(u["byCategory"]["utility"]["cost"], 0.6)
        self.assertEqual(u["cost"]["soFar"], 1.69)

    def test_every_day_of_the_month_so_far_with_its_categories(self):
        self.november()
        days = self.usage(with_meta=False)["days"]
        self.assertEqual([d["date"] for d in days], [f"2026-11-{i:02d}" for i in range(1, 16)])
        day2 = days[1]
        self.assertEqual((day2["sent"], day2["delivered"], day2["read"], day2["billable"]), (3, 1, 1, 3))
        self.assertEqual(day2["byCategory"], {"authentication": 0, "utility": 3, "marketing": 0, "service": 0})
        self.assertEqual(days[2]["byCategory"]["authentication"], 2)
        self.assertEqual(days[14]["queued"], 1)
        self.assertEqual(days[0]["sent"], 0)

    def test_a_message_from_before_meta_is_counted_but_never_charged(self):
        self.log("salary_slip", "sent", self.on(2))  # no template: sent through WAClient before the switch
        self.log("salary_slip", "sent", self.on(2), template_name="hrms_salary_slip")
        self.log("salary_slip", "delivered", self.on(2), pricing_category="utility")  # Meta priced it, billable unknown
        u = self.usage(with_meta=False)
        self.assertEqual((u["totals"]["sent"], u["totals"]["billable"]), (3, 2))
        self.assertEqual(u["byCategory"]["utility"]["cost"], 0.23)

    def test_by_type(self):
        self.november()
        by_type = {t["type"]: t for t in self.usage(with_meta=False)["byType"]}
        slip = by_type["salary_slip"]
        self.assertEqual((slip["messages"], slip["billable"], slip["cost"], slip["module"]), (3, 3, 0.35, "documents"))
        self.assertEqual(slip["label"], catalog.label("salary_slip"))
        self.assertEqual((by_type["otp_login"]["messages"], by_type["otp_login"]["cost"]), (2, 0.23))
        self.assertEqual(by_type["late_alert"]["failed"], 1)
        self.assertEqual(self.usage(with_meta=False)["byType"][0]["type"], "salary_slip")  # most used first

    def test_a_past_month_is_its_actual_total_and_a_future_one_is_empty(self):
        self.november()
        october = self.usage(date(2026, 10, 1), with_meta=False)
        self.assertEqual(len(october["days"]), 31)
        self.assertFalse(october["cost"]["isCurrentMonth"])
        self.assertEqual(october["cost"]["projected"], october["cost"]["soFar"])
        self.assertEqual(october["totals"]["sent"], 1)
        december = self.usage(date(2026, 12, 1))
        self.assertEqual((december["days"], december["cost"]["projected"]), ([], 0.0))
        self.assertFalse(december["meta"]["available"])
        self.assertEqual(self.meta.calls, [])


class MetaFiguresTests(UsageBase):
    def points(self):
        start = int(datetime(2026, 11, 2, tzinfo=FACTORY_TZ).timestamp())
        return [
            {"start": start, "end": start + 86400, "volume": 3, "cost": 0.345, "pricing_category": "UTILITY"},
            {"start": start, "end": start + 86400, "volume": 2, "cost": 0.23, "pricing_category": "AUTHENTICATION"},
        ]

    def pricing_calls(self):
        return [c for c in self.meta.calls if "pricing_analytics" in str((c.get("params") or {}).get("fields"))]

    def test_metas_own_figures_and_the_ten_minute_cache(self):
        self.meta.pricing = self.points()
        meta = self.usage()["meta"]
        self.assertTrue(meta["available"])
        self.assertEqual((meta["cost"], meta["volume"]), (0.58, 5))
        self.assertEqual(meta["byCategory"]["utility"], {"volume": 3, "cost": 0.35})
        self.assertTrue(meta["lastSyncedAt"])
        self.assertIsNone(meta["error"])
        self.usage()
        self.assertEqual(len(self.pricing_calls()), 1)

    def test_when_meta_cannot_say(self):
        self.meta.fail(100, "Unsupported get request")
        meta = self.usage()["meta"]
        self.assertFalse(meta["available"])
        self.assertTrue(meta["error"].startswith("Meta figures unavailable"))
        self.assertNotIn(TOKEN, str(meta))

    @override_settings(**NO_META)
    def test_not_configured(self):
        meta = self.usage()["meta"]
        self.assertFalse(meta["available"])
        self.assertIn("not configured", meta["error"])
        self.assertEqual(self.meta.calls, [])


class UsageEndpointTests(UsageBase):
    def test_the_endpoint_answers_a_month(self):
        today = timezone.now().astimezone(FACTORY_TZ).date()
        last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        self.log("salary_slip", "delivered", datetime.combine(last_month, datetime.min.time(), tzinfo=FACTORY_TZ))
        r = self.client.get(f"{BASE}/usage", {"month": f"{last_month:%Y-%m}"}, **self.hr)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["month"], body["totals"]["sent"]), (f"{last_month:%Y-%m}", 1))
        for key in ("days", "byCategory", "byType", "cost", "rates", "meta"):
            self.assertIn(key, body)
        self.assertEqual(self.client.get(f"{BASE}/usage", **self.hr).json()["month"], f"{today:%Y-%m}")

    def test_a_bad_month_is_a_400(self):
        r = self.client.get(f"{BASE}/usage", {"month": "2026-13"}, **self.hr)
        self.assertEqual(r.status_code, 400)
        self.assertIn("YYYY-MM", r.json()["error"])

    def test_a_branch_scoped_login_counts_its_own_branch(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.asha.pk).update(branch=north)
        ravi = Employee.objects.create(
            employee_code="U2", first_name="Ravi", last_name="Nair", phone="9000000012", status="active", branch=south
        )
        self.log("salary_slip", "sent")
        self.log("salary_slip", "sent", employee=ravi)
        role = Role.objects.create(name="North HR", permissions={"whatsapp_control": "edit"})
        scoped = _hr("north_usage", super_admin=False, role=role, branch=north)
        self.assertEqual(self.client.get(f"{BASE}/usage", **scoped).json()["totals"]["sent"], 1)
        self.assertEqual(self.client.get(f"{BASE}/overview", **scoped).json()["month"]["sent"], 1)
        self.assertEqual(self.client.get(f"{BASE}/usage", **self.hr).json()["totals"]["sent"], 2)


class OverviewTests(UsageBase):
    def overview(self, headers=None):
        r = self.client.get(f"{BASE}/overview", **(headers or self.hr))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def codes(self, body):
        return [a["code"] for a in body["alerts"]]

    def test_the_contract(self):
        self.log("salary_slip", "delivered", template_name="hrms_salary_slip")
        self.log("salary_slip", "read", template_name="hrms_salary_slip")
        self.log("late_alert", "failed")
        self.log("absent_alert", "queued")
        body = self.overview()
        for key in ("connection", "month", "cost", "templates", "otp", "queue", "alerts"):
            self.assertIn(key, body)
        c = body["connection"]
        self.assertEqual(
            (c["configured"], c["sendingAllowed"], c["displayNumber"], c["verifiedName"], c["status"]),
            (True, True, "+91 98765 43210", "UK Textiles", "CONNECTED"),
        )
        self.assertEqual((c["qualityRating"], c["messagingLimitTier"], c["tierLimit"]), ("GREEN", "TIER_1K", 1000))
        self.assertIsNone(c["lastWebhookAt"])
        m = body["month"]
        self.assertEqual((m["sent"], m["delivered"], m["read"], m["failed"], m["queued"]), (2, 1, 1, 1, 1))
        self.assertEqual((m["deliveryRate"], m["readRate"]), (1.0, 0.5))
        self.assertEqual(body["cost"]["soFar"], 0.23)
        self.assertEqual(body["cost"]["currency"], "INR")
        self.assertIn("queued", body["queue"])
        self.assertNotIn(TOKEN, str(body))
        # the older page's keys are still there
        for key in ("config", "today", "thisMonth", "recentFailures", "stalePending"):
            self.assertIn(key, body)

    def test_templates_and_what_is_missing(self):
        approve_templates("approval_approved")
        approve_templates("approval_rejected", status="PENDING")
        make_template("hrms_rejected_one", status="REJECTED")
        t = self.overview()["templates"]
        self.assertEqual((t["approved"], t["pending"], t["rejected"]), (1, 1, 1))
        missing = {m["type"]: m for m in t["missingForEnabledTypes"]}
        self.assertNotIn("approval_approved", missing)
        self.assertNotIn("approval_rejected", missing)  # pending at Meta: not missing
        self.assertNotIn("absent_alert", missing)  # switched off
        self.assertEqual(missing["salary_slip"]["status"], "MISSING")
        self.assertEqual(missing["salary_slip"]["templateName"], catalog.get("salary_slip").default_template_name)
        self.assertEqual(missing["salary_slip"]["label"], catalog.label("salary_slip"))

    def test_alerts_for_a_fresh_set_up(self):
        codes = self.codes(self.overview())
        self.assertIn("templates_missing", codes)
        self.assertIn("otp_template", codes)
        self.assertIn("webhook_never", codes)
        self.assertNotIn("not_configured", codes)

    def test_everything_approved_and_the_webhook_seen_is_quiet(self):
        approve_templates()
        s = WhatsAppSettings.get()
        s.last_webhook_at = timezone.now()
        s.save()
        body = self.overview()
        self.assertEqual(body["alerts"], [])
        self.assertTrue(body["otp"]["available"])
        self.assertEqual(body["otp"]["templateStatus"], "APPROVED")

    @override_settings(**NO_META)
    def test_not_configured(self):
        body = self.overview()
        self.assertFalse(body["connection"]["configured"])
        self.assertEqual(body["alerts"][0]["level"], "error")
        self.assertEqual(body["alerts"][0]["code"], "not_configured")
        self.assertIn("WHATSAPP_CLOUD_ACCESS_TOKEN", body["alerts"][0]["message"])
        self.assertTrue(body["connection"]["blockReasons"])
        self.assertFalse(body["otp"]["available"])
        self.assertEqual(self.meta.calls, [])

    def test_a_rejected_template_of_a_switched_on_type(self):
        name = catalog.get("approval_approved").default_template_name
        row = make_template(name, status="REJECTED")
        row.rejected_reason = "INVALID_FORMAT"
        row.save()
        alert = next(a for a in self.overview()["alerts"] if a["code"] == "template_rejected")
        self.assertEqual(alert["level"], "error")
        self.assertIn("INVALID_FORMAT", alert["message"])
        self.assertIn(catalog.label("approval_approved"), alert["message"])

    def test_quality_and_number_status(self):
        self.meta.phone.update(quality_rating="YELLOW", status="FLAGGED")
        codes = self.codes(self.overview())
        self.assertIn("quality_yellow", codes)
        self.assertIn("number_status", codes)
        cache.clear()
        self.meta.phone.update(quality_rating="RED")
        alert = next(a for a in self.overview()["alerts"] if a["code"] == "quality_red")
        self.assertEqual(alert["level"], "error")

    def test_a_token_meta_refuses(self):
        self.meta.fail(190, "Error validating access token", status=401)
        body = self.overview()
        self.assertFalse(body["connection"]["tokenOk"])
        self.assertIn("token_invalid", self.codes(body))
        self.assertTrue(body["connection"]["blockReasons"])

    def test_budget_alerts(self):
        self.log("salary_slip", "delivered", template_name="hrms_salary_slip")
        s = WhatsAppSettings.get()
        s.monthly_budget = Decimal("0.10")
        s.save()
        alert = next(a for a in self.overview()["alerts"] if a["code"] == "budget_exceeded")
        self.assertEqual(alert["level"], "error")
        self.assertIn("₹", alert["message"])
        s.monthly_budget = Decimal("1000")
        s.save()
        self.assertFalse({"budget_exceeded", "budget_near"} & set(self.codes(self.overview())))

    def test_the_budget_levels(self):
        s = WhatsAppSettings.get()
        connection = {"configured": True, "status": "CONNECTED", "qualityRating": "GREEN"}
        month = {"sent": 10, "failed": 0}
        templates = {"pending": 0, "missingForEnabledTypes": []}
        otp = {"enabled": False}

        def codes(so_far, projected, budget=100.0, current=True):
            cost = {
                "soFar": so_far,
                "projected": projected,
                "budget": budget,
                "budgetUsedPct": so_far / budget * 100 if budget else None,
                "isCurrentMonth": current,
            }
            found = wa_usage.alerts(s, connection, month, cost, templates, otp, {}, now=timezone.now())
            return {a["code"]: a["level"] for a in found if a["code"].startswith("budget")}

        self.assertEqual(codes(120, 150), {"budget_exceeded": "error"})
        self.assertEqual(codes(50, 130), {"budget_projected_over": "warning"})
        self.assertEqual(codes(85, 95), {"budget_near": "info"})
        self.assertEqual(codes(30, 60), {})
        self.assertEqual(codes(30, 60, budget=None), {})

    def test_the_code_template_expiry_must_match_the_settings(self):
        name = whatsapp_service.template_name_for("otp_login")
        make_template(
            name,
            category="AUTHENTICATION",
            components=[
                {"type": "BODY", "add_security_recommendation": True},
                {"type": "FOOTER", "code_expiration_minutes": 5},
            ],
        )
        s = WhatsAppSettings.get()
        s.otp_expiry_minutes = 10
        s.save()
        body = self.overview()
        self.assertEqual((body["otp"]["templateExpiryMinutes"], body["otp"]["expiryMinutes"]), (5, 10))
        self.assertIn("otp_expiry_mismatch", self.codes(body))

    def test_this_months_whatsapp_codes(self):
        self.log("otp_login", "delivered")
        self.log("otp_reset", "sent")
        self.log("otp_login", "failed")
        now = timezone.now()
        EmployeeOtp.objects.create(
            employee=self.asha,
            purpose="login",
            code_hash="x",
            phone_number="919000000011",
            channel="whatsapp",
            expires_at=now + timedelta(minutes=5),
            consumed_at=now,
        )
        EmployeeOtp.objects.create(  # an SMS code is not WhatsApp's
            employee=self.asha,
            purpose="login",
            code_hash="y",
            phone_number="919000000011",
            channel="sms",
            code_length=4,
            expires_at=now + timedelta(minutes=5),
            consumed_at=now,
        )
        otp = self.overview()["otp"]
        self.assertEqual(otp["month"], {"sent": 2, "delivered": 1, "failed": 1, "verified": 1})
        self.assertTrue(otp["enabled"])
        self.assertEqual(otp["templateName"], whatsapp_service.template_name_for("otp_login"))

    def test_the_messaging_limit(self):
        self.meta.phone["messaging_limit_tier"] = "TIER_50"
        now = timezone.now()
        WhatsAppMessageLog.objects.bulk_create(
            WhatsAppMessageLog(document_type="late_alert", phone_number=f"91900000{i:04d}", status="sent", sent_at=now)
            for i in range(41)
        )
        body = self.overview()
        self.assertEqual((body["connection"]["uniqueRecipients24h"], body["connection"]["tierLimit"]), (41, 50))
        self.assertIn("tier_near_limit", self.codes(body))

    def test_a_webhook_gone_quiet(self):
        s = WhatsAppSettings.get()
        s.last_webhook_at = timezone.now() - timedelta(days=3)
        s.save()
        self.log("salary_slip", "sent", sent_at=timezone.now())
        self.assertIn("webhook_stale", self.codes(self.overview()))

    def test_errors_come_first(self):
        s = WhatsAppSettings.get()
        s.engine_enabled = False
        s.save()
        levels = [a["level"] for a in self.overview()["alerts"]]
        self.assertEqual(levels, sorted(levels, key=["error", "warning", "info"].index))
        self.assertIn("engine_off", self.codes(self.overview()))

    def test_the_overview_asks_meta_about_the_number_at_most_every_five_minutes(self):
        self.overview()
        self.overview()
        phone_calls = [
            c for c in self.meta.calls if c["method"] == "GET" and c["path"] == META["WHATSAPP_CLOUD_PHONE_NUMBER_ID"]
        ]
        self.assertEqual(len(phone_calls), 1)
        self.assertFalse([c for c in self.meta.calls if c["method"] == "POST"])  # nothing is ever sent
