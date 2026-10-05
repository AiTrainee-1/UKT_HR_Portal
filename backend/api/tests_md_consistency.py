"""The same question must get the same answer on every MD page and in the assistant. These tests put one company in front of
two modules that both report the same measure and require them to agree: a number the MD sees on one page and hears
quoted from another can never differ."""

from datetime import timedelta

from django.test import TestCase

from .clock import ist_today
from .md_portal.analytics import employees as E
from .md_portal.analytics import recruitment as R
from .md_portal.common import resolve_period, resolve_scope
from .models import Branch, Department, Employee, ResignationRequest


class WorkforceFiguresAgree(TestCase):
    @classmethod
    def setUpTestData(cls):
        today = ist_today()
        branch = Branch.objects.create(name="Consistency Unit", code="CU1")
        dept = Department.objects.create(name="Consistency Dept", branch=branch)

        def make(code, join, **kw):
            return Employee.objects.create(
                employee_code=code, first_name=code, last_name="Z", department=dept, branch=branch, join_date=join, **kw
            )

        make("CA", "2024-01-10")
        make("CB", "2025-06-01")
        make("CC", (today - timedelta(days=15)).isoformat())  # joined inside the period
        resigned = make("CD", "2023-03-01", status="inactive")
        ResignationRequest.objects.create(
            employee=resigned,
            reason="Better opportunity",
            status="approved",
            last_working_date=today - timedelta(days=10),
        )
        make(
            "CE", (today - timedelta(days=40)).isoformat(), status="inactive"
        )  # deactivated, no resignation: early leaver

    def both(self, preset="last_30_days"):
        period = resolve_period({"period": preset})
        scope = resolve_scope({"branch": "Consistency Unit"})
        return E.summary(scope, period), R.summary(scope, period)["current"]

    def test_joiners_leavers_and_net_are_the_same_on_both_pages(self):
        employees, recruitment = self.both()
        self.assertEqual(employees["joiners"]["count"], recruitment["joiners"])
        self.assertEqual(employees["leavers"]["count"], recruitment["leavers"])
        self.assertEqual(employees["net"]["count"], recruitment["net"])
        self.assertEqual((recruitment["joiners"], recruitment["leavers"]), (1, 2))  # not just equal: right

    def test_attrition_and_the_headcount_it_is_divided_by_are_the_same(self):
        employees, recruitment = self.both()
        self.assertEqual(employees["attrition"]["pct"], recruitment["attritionPct"])
        self.assertEqual(employees["attrition"]["annualisedPct"], recruitment["attritionAnnualisedPct"])
        self.assertEqual(employees["attrition"]["averageHeadcount"], recruitment["averageHeadcount"])
        self.assertIsNotNone(recruitment["attritionPct"])

    def test_early_leavers_are_counted_the_same_way(self):
        employees, recruitment = self.both()
        self.assertEqual(employees["earlyAttrition"]["count"], recruitment["earlyLeavers"])
        self.assertEqual(recruitment["earlyLeavers"], 1)  # the one who left within 90 days of joining

    def test_they_agree_over_other_periods_too(self):
        for preset in ("last_7_days", "last_90_days", "this_month", "last_12_months", "this_year"):
            with self.subTest(period=preset):
                employees, recruitment = self.both(preset)
                self.assertEqual(employees["joiners"]["count"], recruitment["joiners"])
                self.assertEqual(employees["leavers"]["count"], recruitment["leavers"])
                self.assertEqual(employees["attrition"]["pct"], recruitment["attritionPct"])
