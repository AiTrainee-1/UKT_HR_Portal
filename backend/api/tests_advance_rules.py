"""Salary Advance and Term Loan rules from Settings -> Loan & Advance (owner 2026-11-27; api/advance_rules.py): every rule
is HR's setting, the defaults are the owner's, and a change applies at once to the apps, HR's New request and approval.

Run via: python manage.py test api.tests_advance_rules -v 2
"""

from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase

from . import approval_workflow as approval
from .models import Advance, AdvanceRepayment, Department, Employee, HRUser, SettlementSettings
from .tests_mobile_settlement import _bearer, fake_earned, on

DAY = date(2026, 10, 21)


class _RulesBase(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        earned = patch("api.advance_earnings.earned_in_month", side_effect=fake_earned)  # 24,000 earned
        earned.start()
        self.addCleanup(earned.stop)
        admin, _ = HRUser.objects.get_or_create(
            username="rules_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = _bearer({"role": "hr", "hrUserId": admin.id, "name": "Meena HR"})
        dept = Department.objects.create(name="Stores")
        self.emp = Employee.objects.create(
            employee_code="RL1", first_name="Kavya", last_name="R", status="active", employment_type="staff",
            department=dept, join_date="2020-01-01", salary_amount=Decimal("30000"),
        )  # fmt: skip
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})

    def settings(self, **fields):
        row = SettlementSettings.objects.order_by("id").first() or SettlementSettings.objects.create()
        for k, v in fields.items():
            setattr(row, k, v)
        row.save()

    def apply(self, body: dict, day: date = DAY):
        with on(day):
            r = self.client.post("/api/my/advances", body, content_type="application/json", **self.me)
        if r.status_code == 201:
            Advance.objects.filter(pk=r.json()["id"]).update(
                created_at=datetime(day.year, day.month, day.day, 6, 30, tzinfo=dt_timezone.utc)
            )
        return r

    def general(self, amount=1000, day=DAY):
        return self.apply({"advanceType": "general", "amount": amount, "purpose": "School fees"}, day)

    def term(self, amount=10000, months=3, day=DAY):
        return self.apply(
            {"advanceType": "term", "amount": amount, "repaymentMonths": months, "purpose": "House repair"}, day
        )

    def eligibility(self, day=DAY):
        with on(day):
            return self.client.get("/api/my/advances/eligibility", **self.me).json()

    def put_settings(self, body):
        return self.client.put("/api/settlement-settings", body, content_type="application/json", **self.hr)


class SettingsApiTests(_RulesBase):
    def test_the_defaults_and_their_validation(self):
        body = self.client.get("/api/settlement-settings", **self.hr).json()
        sa, tl = body["salaryAdvanceRules"], body["termLoanRules"]
        self.assertEqual(
            (sa["percent"], sa["windowFromDay"], sa["windowToDay"], sa["earnedThroughDay"], sa["perMonth"]),
            (50, 21, 22, 20, 1),
        )
        self.assertEqual(
            (tl["limitPercent"], tl["allowAboveSalary"], tl["maxMonths"], tl["perYear"], tl["minServiceMonths"]),
            (100, False, 6, 1, 6),
        )
        self.assertTrue(tl["staffOnly"] and tl["oneOpenAtATime"] and tl["reapplyNextMonth"])
        for bad, field in (
            ({"salaryAdvanceRules": {"windowFromDay": 23, "windowToDay": 22}}, "sa_window_to"),
            ({"salaryAdvanceRules": {"earnedThroughDay": 21}}, "sa_earned_through"),
            ({"termLoanRules": {"limitPercent": 150}}, "tl_limit_percent"),
            ({"termLoanRules": {"maxMonths": 13}}, "tl_max_months"),
            ({"termLoanRules": {"allowAboveSalary": "yes"}}, "tl_allow_above_salary"),
        ):
            r = self.put_settings(bad)
            self.assertEqual((r.status_code, r.json()["code"], r.json()["field"]), (400, "rules", field), bad)
        ok = self.put_settings({"termLoanRules": {"allowAboveSalary": True, "limitPercent": 200, "maxMonths": 12}})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(
            (ok.json()["termLoanRules"]["effectivePercent"], ok.json()["termLoanRules"]["maxMonths"]), (200, 12)
        )


class SalaryAdvanceRuleTests(_RulesBase):
    def test_the_window_and_percent_follow_settings(self):
        self.settings(sa_percent=40, sa_window_from=23, sa_window_to=24, sa_earned_through=22)
        r = self.general(day=date(2026, 10, 21))
        self.assertEqual((r.status_code, r.json()["code"]), (400, "window_closed"))
        self.assertIn("23rd and 24th", r.json()["error"])
        body = self.eligibility(date(2026, 10, 23))["salaryAdvance"]
        self.assertEqual(
            (body["percent"], body["limit"], body["rules"]["windowText"]),
            (40, 9600.0, "the 23rd and 24th of each month"),
        )
        over = self.general(9601, day=date(2026, 10, 23))
        self.assertEqual((over.status_code, over.json()["code"]), (400, "over_limit"))
        self.assertEqual(self.general(9600, day=date(2026, 10, 23)).status_code, 201)

    def test_how_many_a_month_and_whether_a_rejected_one_counts(self):
        self.settings(sa_per_month=2)
        self.assertEqual(self.general(1000).status_code, 201)
        self.assertEqual(self.general(1000).status_code, 201)
        r = self.general(1000)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "duplicate"))
        Advance.objects.filter(employee=self.emp).update(status="rejected")
        self.assertEqual(self.general(1000).status_code, 201)  # rejected ones do not count by default
        self.settings(sa_per_month=1, sa_rejected_allows_reapply=False)
        Advance.objects.filter(employee=self.emp, status="pending").delete()
        r = self.general(1000)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "duplicate"))  # now the rejected ones count


class TermLoanRuleTests(_RulesBase):
    def test_the_limit_is_a_percent_of_the_monthly_salary(self):
        self.settings(tl_limit_percent=50)
        r = self.term(15001)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "over_limit"))
        self.assertEqual(self.term(15000).status_code, 201)
        a = Advance.objects.get(employee=self.emp)
        self.assertEqual((a.term_limit, a.salary_at_request), (Decimal("15000.00"), Decimal("30000")))
        self.assertEqual(self.client.get("/api/advances", **self.hr).json()[0]["termLimit"], 15000.0)

    def test_above_the_salary_only_when_allowed(self):
        self.assertEqual(self.term(30001).json()["code"], "over_limit")
        self.settings(tl_allow_above_salary=True, tl_limit_percent=200)
        self.assertEqual(self.term(60000).status_code, 201)

    def test_the_most_months_follow_settings(self):
        self.settings(tl_max_months=3)
        self.assertEqual(self.term(months=4).json()["field"], "repaymentMonths")
        self.assertEqual(self.eligibility()["termLoan"]["maxMonths"], 3)
        self.assertEqual(self.term(months=3).status_code, 201)

    def test_once_a_calendar_year(self):
        pk = self.term().json()["id"]
        Advance.objects.filter(pk=pk).update(
            status="closed", outstanding=0, approved_at=datetime(2026, 10, 22, 6, 0, tzinfo=dt_timezone.utc)
        )
        r = self.term(day=date(2026, 12, 5))
        self.assertEqual((r.status_code, r.json()["code"]), (409, "yearly"))
        self.assertIn("1 January 2027", r.json()["error"])
        self.assertEqual(self.term(day=date(2027, 1, 4)).status_code, 201)

    def test_a_rejection_waits_for_the_next_month(self):
        pk = self.term().json()["id"]
        Advance.objects.filter(pk=pk).update(
            status="rejected", decided_at=datetime(2026, 10, 22, 6, 0, tzinfo=dt_timezone.utc)
        )
        r = self.term(day=date(2026, 10, 28))
        self.assertEqual((r.status_code, r.json()["code"]), (409, "rejected_this_month"))
        self.assertEqual(self.eligibility(date(2026, 10, 28))["termLoan"]["nextEligibleOn"], "2026-11-01")
        self.assertEqual(self.term(day=date(2026, 11, 2)).status_code, 201)
        self.settings(tl_reapply_next_month=False)  # switched off: a rejection does not hold the month

    def test_one_open_at_a_time_and_the_service(self):
        self.term()
        r = self.term()
        self.assertEqual((r.status_code, r.json()["code"]), (409, "duplicate"))  # still waiting (older apps' code)
        self.settings(tl_one_open=False, tl_per_year=2)
        self.assertEqual(self.term().status_code, 201)
        newcomer = Employee.objects.create(
            employee_code="RL2", first_name="New", last_name="Joiner", status="active", employment_type="staff",
            join_date="2026-09-01", salary_amount=Decimal("20000"),
        )  # fmt: skip
        self.me = _bearer({"role": "employee", "employeeId": newcomer.id})
        self.assertEqual(self.term(5000).json()["code"], "service")
        self.settings(tl_min_service_months=0)
        self.assertEqual(self.term(5000).status_code, 201)

    def test_hr_sets_the_months_at_approval_and_the_emi_follows(self):
        pk = self.term(12000, 6).json()["id"]
        r = self.client.put(
            f"/api/advances/{pk}",
            {"status": "approved", "amount": 9000, "repaymentMonths": 3, "decisionRemark": "Shorter"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 200, r.content)
        a = Advance.objects.get(pk=pk)
        self.assertEqual((a.repayment_months, a.emi_amount), (3, Decimal("3000.00")))
        self.assertEqual(AdvanceRepayment.objects.filter(advance=a).count(), 3)
        bad = Advance.objects.create(
            employee=self.emp, advance_type="term", amount=Decimal("6000"), requested_amount=Decimal("6000"),
            outstanding=Decimal("6000"), applied_by="employee", repayment_months=3,
        )  # fmt: skip
        r = self.client.put(
            f"/api/advances/{bad.id}",
            {"status": "approved", "repaymentMonths": 7},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("1 to 6 months", r.json()["error"])
