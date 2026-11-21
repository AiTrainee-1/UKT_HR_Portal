"""MD portal: Communication usage & cost (/api/md/comms/*, md_portal/analytics/comms.py).

The figures must be the HR Control pages' own: every test that checks a count or a cost also asks WhatsApp Control, SMS
Control or Gmail Control for the same month and compares. The clock is fixed at 15 Nov 2026, 12:00 IST (timezone.now,
the clock the Control modules read), Meta and 2Factor are never contacted (their reads are patched).

    DB_TEST_NAME=test_uktex_comms python manage.py test api.tests_md_comms --noinput
"""

import json
from datetime import datetime
from decimal import Decimal
from unittest import mock

from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import comms
from .md_portal.common import read_only_db
from .models import (
    EmailMessageLog,
    EmailSettings,
    Employee,
    HRUser,
    SmsMessageLog,
    SmsSettings,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .tests_md_support import MdApiTestCase

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=FACTORY_TZ)
BASE = "/api/md/comms"
META_OFF = {"available": False, "cost": None, "volume": None, "byCategory": {}, "lastSyncedAt": None, "error": None}


def on(day, month=11, year=2026, hour=10):
    return datetime(year, month, day, hour, 0, tzinfo=FACTORY_TZ)


def hr_admin() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="comms_admin", defaults={"password_hash": "x", "is_super_admin": True, "full_name": "Comms Admin"}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class CommsBase(MdApiTestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.addCleanup(cache.clear)
        for target, kwargs in (
            ("django.utils.timezone.now", {"return_value": NOW}),
            ("api.whatsapp_usage.meta_pricing", {"return_value": META_OFF}),
            ("api.sms_service.balance", {"return_value": {"credits": 500, "checkedAt": None, "error": None}}),
        ):
            patcher = mock.patch(target, **kwargs)
            setattr(self, target.rsplit(".", 1)[-1] + "_mock", patcher.start())
            self.addCleanup(patcher.stop)
        self.asha = Employee.objects.create(
            employee_code="C1", first_name="Asha", last_name="Kumar", phone="9000000011", status="active"
        )
        self.ravi = Employee.objects.create(
            employee_code="C2", first_name="Ravi", last_name="Nair", phone="9000000022", status="active"
        )

    # ── fixtures ──

    def wa(self, doc_type, status="sent", when=None, **kw):
        row = WhatsAppMessageLog.objects.create(
            employee=kw.pop("employee", self.asha),
            document_type=doc_type,
            phone_number=kw.pop("phone_number", "919000000011"),
            status=status,
            **kw,
        )
        WhatsAppMessageLog.objects.filter(pk=row.pk).update(created_at=when or on(2))
        return row

    def sms(self, status="sent", purpose="login", when=None, emp=None):
        return SmsMessageLog.objects.create(
            employee=emp or self.asha,
            status=status,
            purpose=purpose,
            phone_masked="••••••0011",
            created_at=when or on(3),
        )

    def mail(self, email_type="salary_slip", status="sent", when=None, **kw):
        row = EmailMessageLog.objects.create(
            employee=kw.pop("employee", self.asha),
            recipient_email=kw.pop("recipient_email", "asha.kumar@example.com"),
            email_type=email_type,
            status=status,
            **kw,
        )
        EmailMessageLog.objects.filter(pk=row.pk).update(created_at=when or on(4))
        return row

    def company(self):
        """November (and a little of October). Expected figures:
        WhatsApp Nov: sent 8 (delivered 2 + read 2 -> delivered 4), failed 1, skipped 1, queued 1, billable 6,
                      cost 3 x 0.115 (slips) + 2 x 0.115 (codes) + 0.8631 (marketing) = 1.4381 -> 1.44; Oct: 0.115 -> 0.12
        SMS Nov at 0.25 each: sent 3 (login 2, reset 1), failed 1, blocked 1 -> 0.75; Oct: 4 sent -> 1.00
        Email Nov: sent 5, failed 1, blocked 2; Oct: 2 sent"""
        for status in ("sent", "delivered", "read"):
            self.wa("salary_slip", status, on(2), template_name="hrms_salary_slip", message_text="Your slip, Asha")
        self.wa("otp_login", "sent", on(3), template_name="hrms_otp")
        self.wa("otp_login", "sent", on(3, hour=11), template_name="hrms_otp")
        self.wa("late_alert", "failed", on(4), error_message="Meta refused it")
        self.wa("absent_alert", "skipped", on(4))
        self.wa("approval_approved", "delivered", on(5), pricing_category="service", billable=False)
        self.wa("approval_rejected", "sent", on(5), pricing_category="utility", billable=False)
        self.wa("visitor_notification", "read", on(6), pricing_category="marketing", billable=True)
        self.wa("outpass_gate_out", "queued", on(15, hour=9))
        self.wa("salary_slip", "sent", on(31, month=10), template_name="hrms_salary_slip")

        SmsSettings.objects.create(pk=1, price_per_sms=Decimal("0.25"))
        self.sms("sent", "login", on(3))
        self.sms("sent", "login", on(7), emp=self.ravi)
        self.sms("sent", "reset", on(8))
        self.sms("failed", "login", on(9))
        self.sms("blocked", "login", on(9, hour=11))
        for day in (1, 2, 3, 4):
            self.sms("sent", "login", on(day, month=10))

        for day in (4, 4, 5, 6, 7):
            self.mail("salary_slip", "sent", on(day))
        self.mail("offer_letter", "failed", on(8), error_message="Recipient refused")
        self.mail("visitor_arrival", "blocked", on(9))
        self.mail("visitor_arrival", "blocked", on(9, hour=12))
        self.mail("salary_slip", "sent", on(10, month=10))
        self.mail("salary_slip", "sent", on(11, month=10))

    def ok(self, path, **params):
        r = self.get(f"{BASE}/{path}", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    @staticmethod
    def channel(body, name):
        return next(c for c in body["channels"] if c["channel"] == name)


class AccessTests(CommsBase):
    ROUTES = ("overview", "month", "history", "sms-balance")

    def test_only_the_md_gets_in(self):
        admin = hr_admin()
        for route in self.ROUTES:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(f"{BASE}/{route}", **admin).status_code, 403)
                self.assertEqual(self.get(f"{BASE}/{route}").status_code, 200)

    def test_an_empty_company_answers_zeros_not_errors(self):
        body = self.ok("overview")
        self.assertEqual(body["month"], "2026-11")
        self.assertEqual(body["totals"]["messages"], 0)
        self.assertEqual(body["totals"]["cost"], 0.0)
        self.assertIsNone(body["totals"]["change"]["cost"]["pct"])  # nothing last month: no percentage
        self.assertEqual(len(body["series"]), 12)
        self.assertEqual(body["insights"], [])
        history = self.ok("history")
        self.assertEqual((history["total"], history["items"], history["pages"]), (0, [], 1))

    def test_missing_settings_rows_are_read_as_the_defaults_and_never_created(self):
        self.sms("sent", "login", on(3))
        self.assertFalse(WhatsAppSettings.objects.exists() or SmsSettings.objects.exists())
        body = self.ok("overview")
        self.assertEqual(self.channel(body, "sms")["cost"], 0.2)  # sms_service.DEFAULT_PRICE_PER_SMS
        self.assertEqual(self.channel(body, "whatsapp")["rates"]["utility"], 0.115)
        self.ok("history")
        self.ok("month")
        self.assertFalse(
            WhatsAppSettings.objects.exists() or SmsSettings.objects.exists() or EmailSettings.objects.exists()
        )

    def test_bad_parameters_are_400_with_a_reason(self):
        for path, params, words in (
            ("overview", {"month": "2026-12"}, "has not started"),
            ("overview", {"month": "november"}, "is not a month"),
            ("overview", {"months": "lots"}, "whole number"),
            ("month", {"channel": "fax"}, "'channel' must be one of"),
            ("history", {"status": "lost"}, "'status' must be one of"),
            ("history", {"purpose": "otp"}, "Choose a channel"),
            ("history", {"channel": "sms", "purpose": "nope"}, "'purpose' for SMS"),
            ("history", {"from": "2026-11-10"}, "both"),
        ):
            with self.subTest(path=path, params=params):
                r = self.get(f"{BASE}/{path}", **params)
                self.assertEqual(r.status_code, 400)
                self.assertIn(words, r.json()["error"])


class OverviewTests(CommsBase):
    def test_counts_and_costs_are_the_control_pages_own(self):
        self.company()
        body = self.ok("overview")
        wa, sms, email = (self.channel(body, c) for c in ("whatsapp", "sms", "email"))

        admin = hr_admin()
        wa_control = self.client.get("/api/whatsapp-control/usage", {"month": "2026-11"}, **admin).json()
        sms_control = self.client.get("/api/sms-control/usage", {"month": "2026-11"}, **admin).json()
        gmail_control = self.client.get("/api/gmail-control/overview", **admin).json()

        self.assertEqual(wa["messages"], wa_control["totals"]["sent"])
        self.assertEqual(wa["failed"], wa_control["totals"]["failed"])
        self.assertEqual(wa["billable"], wa_control["totals"]["billable"])
        self.assertEqual(wa["cost"], wa_control["cost"]["soFar"])
        self.assertEqual(wa["projectedCost"], wa_control["cost"]["projected"])
        self.assertEqual(wa["costWithGst"], wa_control["cost"]["soFarWithGst"])
        self.assertEqual(sms["messages"], sms_control["totals"]["sent"])
        self.assertEqual(sms["attempts"], sms_control["totals"]["requested"])
        self.assertEqual(sms["cost"], sms_control["cost"]["soFar"])
        self.assertEqual(sms["projectedCost"], sms_control["cost"]["projected"])
        self.assertEqual(email["messages"], gmail_control["thisMonth"]["sent"])
        self.assertEqual(email["failed"], gmail_control["thisMonth"]["failed"])
        self.assertEqual(email["skipped"], gmail_control["thisMonth"]["blocked"])

        # and by hand, from the fixture
        self.assertEqual(
            {
                k: wa[k]
                for k in ("messages", "attempts", "delivered", "read", "failed", "skipped", "waiting", "billable")
            },
            {
                "messages": 8,
                "attempts": 11,
                "delivered": 4,
                "read": 2,
                "failed": 1,
                "skipped": 1,
                "waiting": 1,
                "billable": 6,
            },
        )
        self.assertEqual((wa["cost"], wa["projectedCost"], wa["costWithGst"]), (1.44, 2.88, 1.70))
        self.assertEqual((wa["deliveryRate"], wa["readRate"]), (50.0, 25.0))  # Control's 0.5 / 0.25 as percentages
        self.assertEqual(wa["costBasis"], "estimate")
        self.assertIn("before 18% GST", wa["costNote"])
        self.assertEqual((sms["messages"], sms["failed"], sms["skipped"], sms["cost"]), (3, 1, 1, 0.75))
        self.assertEqual(sms["projectedCost"], 1.5)
        self.assertIn("₹0.25 per SMS", sms["costNote"])
        self.assertEqual((email["messages"], email["failed"], email["skipped"], email["attempts"]), (5, 1, 2, 8))

    def test_gmail_has_no_charge(self):
        self.company()
        email = self.channel(self.ok("overview"), "email")
        self.assertEqual((email["cost"], email["projectedCost"], email["costBasis"]), (0.0, 0.0, "free"))
        self.assertIsNone(email["budget"])
        self.assertIn("no per-email charge", email["costNote"])
        self.assertEqual(email["peakDay"], {"date": "2026-11-04", "sent": 2})
        self.assertEqual(email["dailyLimit"]["value"], 500)  # no limit set: Gmail's own ceiling
        EmailSettings.objects.create(pk=1, daily_send_limit=40)
        self.assertEqual(self.channel(self.ok("overview"), "email")["dailyLimit"]["value"], 40)

    def test_totals_projection_and_the_change_against_last_month(self):
        self.company()
        body = self.ok("overview")
        t = body["totals"]
        self.assertTrue(t["isCurrentMonth"])
        self.assertEqual(t["daysElapsed"], 15)
        self.assertEqual((t["messages"], t["attempts"], t["failed"]), (16, 24, 3))
        self.assertEqual((t["cost"], t["projectedCost"]), (2.19, 4.38))
        # projected messages: WhatsApp 8/15x30 = 16, SMS 3/15x30 = 6, email 5/15x30 = 10
        self.assertEqual(t["projectedMessages"], 32)
        self.assertEqual(t["previous"], {"month": "2026-10", "label": "Oct 2026", "messages": 7, "cost": 1.12})
        self.assertEqual(t["changeBasis"], "projected")
        self.assertEqual(t["change"]["messages"], {"abs": 25.0, "pct": 357.1})
        self.assertEqual(t["change"]["cost"], {"abs": 3.26, "pct": 291.1})
        sms = self.channel(body, "sms")
        self.assertEqual(sms["previous"]["cost"], 1.0)
        self.assertEqual(sms["change"]["cost"], {"abs": 0.5, "pct": 50.0})  # 1.50 projected against 1.00

    def test_a_past_month_compares_actual_figures(self):
        self.company()
        body = self.ok("overview", month="2026-10")
        t = body["totals"]
        self.assertFalse(t["isCurrentMonth"])
        self.assertEqual((t["messages"], t["cost"], t["projectedCost"], t["changeBasis"]), (7, 1.12, 1.12, "actual"))
        self.assertEqual(t["previous"]["messages"], 0)
        self.assertEqual(body["series"][-1]["month"], "2026-10")

    def test_the_series_runs_twelve_months_to_the_chosen_one(self):
        self.company()
        series = self.ok("overview")["series"]
        self.assertEqual([p["month"] for p in series[:2]], ["2025-12", "2026-01"])
        oct_, nov = series[-2], series[-1]
        self.assertEqual(
            (oct_["whatsapp"]["messages"], oct_["sms"]["messages"], oct_["email"]["messages"], oct_["cost"]),
            (1, 4, 2, 1.12),
        )
        self.assertEqual((nov["messages"], nov["cost"], nov["isCurrentMonth"]), (16, 2.19, True))
        self.assertEqual(len(self.ok("overview", months=3)["series"]), 3)
        self.assertEqual(len(self.ok("overview", months=99)["series"]), comms.MONTHS_MAX)

    def test_budgets_and_the_insights_they_raise(self):
        self.company()
        WhatsAppSettings.objects.create(pk=1, monthly_budget=Decimal("2.00"))
        SmsSettings.objects.filter(pk=1).update(monthly_budget=Decimal("0.50"))
        body = self.ok("overview")
        wa, sms = self.channel(body, "whatsapp"), self.channel(body, "sms")
        self.assertEqual((wa["budget"], wa["budgetUsedPct"], wa["projectedBudgetPct"]), (2.0, 71.9, 143.8))
        self.assertEqual((sms["budget"], sms["budgetUsedPct"]), (0.5, 150.0))
        t = body["totals"]
        self.assertEqual((t["budget"], t["budgetCost"], t["budgetUsedPct"]), (2.5, 2.19, 87.6))
        self.assertEqual(t["budgetChannels"], ["whatsapp", "sms"])
        ids = [i["id"] for i in body["insights"]]
        self.assertEqual(ids[0], "comms.sms-over-budget")  # critical first
        self.assertIn("comms.whatsapp-projected-over", ids)
        first = body["insights"][0]
        self.assertEqual(first["severity"], "critical")
        self.assertIn("₹0.75", first["title"])

    def test_the_insights_name_the_costliest_whatsapp_type_and_the_failures(self):
        self.company()
        for _ in range(5):
            self.wa("late_alert", "failed", on(10))
        insights = {i["id"]: i for i in self.ok("overview")["insights"]}
        top = insights["comms.whatsapp-top-type"]
        self.assertIn("Visitor", top["title"])  # the marketing message: 0.86 of 1.44
        self.assertIn("₹0.86", top["title"])
        failures = insights["comms.whatsapp-failures"]
        self.assertIn("6 WhatsApp messages failed", failures["title"])
        self.assertNotIn("comms.cost-swing", insights)  # a few rupees either way is not news

    def test_the_summary_is_made_from_the_same_figures(self):
        self.company()
        summary = self.ok("overview")["summary"]
        self.assertIn("16 messages: 8 on WhatsApp, 3 SMS and 5 emails", summary)
        self.assertIn("₹2.19 before GST", summary)
        self.assertIn("₹4.38", summary)

    def test_a_webhook_that_never_reported_is_noted(self):
        self.company()
        WhatsAppSettings.objects.create(pk=1)
        self.assertTrue(any("webhook" in n for n in self.ok("overview")["notes"]))

    def test_the_overview_needs_the_same_number_of_queries_however_much_was_sent(self):
        self.company()
        with CaptureQueriesContext(connection) as small:
            self.ok("overview")
        for day in range(1, 15):
            self.wa("salary_slip", "read", on(day), template_name="hrms_salary_slip", employee=self.ravi)
            self.sms("sent", "reset", on(day))
            self.mail("id_card", "sent", on(day))
        with CaptureQueriesContext(connection) as big:
            self.ok("overview")
        self.assertEqual(len(big), len(small))


class MonthTests(CommsBase):
    def test_breakdowns_by_type_purpose_category_and_day(self):
        self.company()
        body = self.ok("month", month="2026-11")
        self.assertEqual((body["channel"], body["channelsShown"]), ("all", ["whatsapp", "sms", "email"]))
        types = {(t["channel"], t["key"]): t for t in body["byType"]}
        slip = types[("whatsapp", "salary_slip")]
        self.assertEqual((slip["messages"], slip["billable"], slip["cost"]), (3, 3, 0.35))
        self.assertEqual(types[("whatsapp", "absent_alert")]["skipped"], 1)
        self.assertEqual(types[("sms", "login")]["messages"], 2)
        self.assertEqual(types[("sms", "login")]["cost"], 0.5)
        self.assertEqual(
            (types[("email", "visitor_arrival")]["skipped"], types[("email", "salary_slip")]["cost"]), (2, 0)
        )

        purposes = {(p["channel"], p["key"]): p for p in body["byPurpose"]}
        self.assertEqual(purposes[("whatsapp", "otp")]["messages"], 2)
        self.assertEqual(purposes[("whatsapp", "otp")]["cost"], 0.23)
        self.assertEqual(purposes[("email", "documents")]["messages"], 5)
        self.assertEqual(body["byPurpose"][0]["key"], "visitors")  # the costliest purpose first (0.86)

        categories = {c["key"]: c for c in body["byCategory"]}
        self.assertEqual(
            categories["marketing"],
            {"key": "marketing", "label": "Marketing", "messages": 1, "billable": 1, "rate": 0.8631, "cost": 0.86},
        )

        days = {d["date"]: d for d in body["days"]}
        self.assertEqual(len(days), 15)  # 1-15 Nov: no day after today
        self.assertEqual(days["2026-11-02"]["whatsapp"], 3)
        self.assertEqual(days["2026-11-04"]["email"], 2)
        self.assertEqual(days["2026-11-04"]["failed"], 1)
        self.assertEqual(days["2026-11-09"]["failed"], 1)  # the SMS that failed
        self.assertEqual(days["2026-11-03"]["total"], 3)  # 2 WhatsApp codes + 1 SMS
        self.assertEqual(body["meta"]["available"], False)
        self.meta_pricing_mock.assert_called()

    def test_one_channel(self):
        self.company()
        body = self.ok("month", channel="sms")
        self.assertEqual(body["channelsShown"], ["sms"])
        self.assertEqual({t["channel"] for t in body["byType"]}, {"sms"})
        self.assertNotIn("whatsapp", body["days"][0])
        self.assertIsNone(body["meta"])
        self.assertEqual(self.ok("month", channel="gmail")["channelsShown"], ["email"])

    def test_meta_figure_is_given_when_meta_answers(self):
        self.company()
        self.meta_pricing_mock.return_value = {**META_OFF, "available": True, "cost": 1.52, "volume": 7}
        meta = self.ok("month", month="2026-11", channel="whatsapp")["meta"]
        self.assertEqual((meta["available"], meta["cost"], meta["volume"]), (True, 1.52, 7))


class HistoryTests(CommsBase):
    def test_status_groups_counted_across_the_channels(self):
        self.company()
        body = self.ok("history", month="2026-11", pageSize=100)
        self.assertEqual(
            body["statusCounts"],
            {"sent": 16, "delivered": 4, "failed": 3, "skipped": 4, "waiting": 1, "total": 24},
        )
        self.assertEqual(body["total"], 24)
        self.assertEqual(len(body["items"]), 24)
        stamps = [i["at"] for i in body["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))  # newest first
        self.assertEqual(body["items"][0]["status"], "queued")  # 15 Nov 09:00, the newest
        self.assertEqual(body["period"]["start"], "2026-11-01")

    def test_paging_across_channels_keeps_the_order(self):
        self.company()
        full = [i["id"] for i in self.ok("history", month="2026-11", pageSize=100)["items"]]
        paged = []
        for page in (1, 2, 3, 4, 5):
            body = self.ok("history", month="2026-11", pageSize=5, page=page)
            paged += [i["id"] for i in body["items"]]
            self.assertEqual(body["pages"], 5)
        self.assertEqual(paged, full)

    def test_filters(self):
        self.company()
        failed = self.ok("history", month="2026-11", status="failed")
        self.assertEqual(failed["total"], 3)
        self.assertEqual({i["channel"] for i in failed["items"]}, {"whatsapp", "sms", "email"})
        self.assertEqual(failed["statusCounts"]["total"], 24)  # the counts ignore the status filter
        waiting = self.ok("history", month="2026-11", status="waiting")
        self.assertEqual([i["channel"] for i in waiting["items"]], ["whatsapp"])
        codes = self.ok("history", month="2026-11", channel="whatsapp", purpose="otp")
        self.assertEqual(codes["total"], 2)
        sms = self.ok("history", month="2026-11", channel="sms", status="delivered")
        self.assertEqual((sms["total"], sms["statusCounts"]["delivered"]), (0, None))  # SMS has no receipt
        ravi = self.ok("history", month="2026-11", q="ravi")
        self.assertEqual([(i["channel"], i["recipientCode"]) for i in ravi["items"]], [("sms", "C2")])
        october = self.ok("history", **{"from": "2026-10-01", "to": "2026-10-31"})
        self.assertEqual(october["total"], 7)
        self.assertEqual(october["period"]["label"], "01 Oct – 31 Oct 2026")

    def test_contacts_are_masked_and_no_text_is_returned(self):
        self.company()
        r = self.get(f"{BASE}/history", month="2026-11", pageSize=100)
        text = r.content.decode()
        self.assertNotIn("9000000011", text)
        self.assertNotIn("asha.kumar@", text)
        self.assertNotIn("Your slip, Asha", text)  # WhatsApp message text stays on WhatsApp Control
        items = r.json()["items"]
        wa = next(i for i in items if i["channel"] == "whatsapp")
        self.assertEqual(wa["contact"], "••••••••0011")
        email = next(i for i in items if i["channel"] == "email")
        self.assertEqual(email["contact"], "as•••@example.com")
        self.assertNotIn("subject", email)

    def test_each_row_carries_its_estimated_cost(self):
        self.company()
        items = self.ok("history", month="2026-11", pageSize=100)["items"]
        slip = next(
            i for i in items if i["channel"] == "whatsapp" and i["status"] == "read" and "lip" in i["typeLabel"]
        )
        self.assertEqual((slip["pricingCategory"], slip["estimatedCost"]), ("utility", 0.115))
        service = next(i for i in items if i["channel"] == "whatsapp" and i["pricingCategory"] == "service")
        self.assertEqual(service["estimatedCost"], 0.0)
        sms_sent = next(i for i in items if i["channel"] == "sms" and i["status"] == "sent")
        sms_failed = next(i for i in items if i["channel"] == "sms" and i["status"] == "failed")
        self.assertEqual((sms_sent["estimatedCost"], sms_failed["estimatedCost"]), (0.25, 0.0))
        self.assertTrue(all(i["estimatedCost"] == 0 for i in items if i["channel"] == "email"))
        wa_total = sum(i["estimatedCost"] for i in items if i["channel"] == "whatsapp")
        self.assertAlmostEqual(wa_total, 1.4381, places=4)  # the month's cost before rounding

    def test_history_queries_do_not_grow_with_the_rows(self):
        self.company()
        with CaptureQueriesContext(connection) as small:
            self.ok("history", month="2026-11", pageSize=100)
        for day in range(1, 15):  # 42 more rows on the same page: one query per channel still fetches them
            self.wa("salary_slip", "read", on(day), template_name="hrms_salary_slip", employee=self.ravi)
            self.sms("sent", "reset", on(day), emp=self.ravi)
            self.mail("id_card", "sent", on(day), employee=self.ravi)
        with CaptureQueriesContext(connection) as big:
            body = self.ok("history", month="2026-11", pageSize=100)
        self.assertEqual(len(body["items"]), 66)
        self.assertEqual(len(big), len(small))


class BalanceAndToolTests(CommsBase):
    def test_sms_balance(self):
        body = self.ok("sms-balance")
        self.assertEqual((body["credits"], body["isLow"]), (500, False))
        self.balance_mock.return_value = {"credits": 40, "checkedAt": "2026-11-15T06:30:00+00:00", "error": None}
        body = self.ok("sms-balance")
        self.assertEqual((body["credits"], body["isLow"], body["lowCredits"]), (40, True, 100))

    def test_tools_run_read_only_and_explain_themselves(self):
        self.company()
        for spec in comms.TOOLS:
            with self.subTest(tool=spec.name):
                with read_only_db():
                    result = spec.run(dict(spec.example))
                json.dumps(result)
                self.assertTrue(result["provenance"])
                self.assertEqual(spec.page, "communications")
        with read_only_db():
            month = comms.TOOLS[1].run({"month": "2026-11", "channel": "whatsapp"})
        self.assertEqual(month["channels"][0]["cost"], 1.44)
