"""Owner 2026-11-10: the payroll engine itself rounds the employee's ESI and the NET pay UP to the next whole rupee (so the
Salary Statement, the bank file and the payroll page show the same rupees), and every payroll list shows active employees
only (a payroll generated before someone was deactivated stays stored, but is not listed, exported or paid from there).

Run via: python manage.py test api.tests_payroll_rounding_active
"""

import json
from datetime import date
from decimal import ROUND_CEILING, Decimal

from django.test import TestCase

from .attendance_final import _holiday_dates_for_month
from .models import Payroll, SalarySlip
from .payroll_views import _generate_production_payroll, _generate_staff_payroll
from .pf_esi import net_follows, round_up_rupee
from .tests_payroll_engine import (
    MONTH,
    WORKING_DAYS,
    YEAR,
    _configure,
    _day,
    _hr,
    _present_all,
    _production,
    _rule,
    _staff,
)


def _ceil(value: Decimal) -> Decimal:
    return value.to_integral_value(rounding=ROUND_CEILING).quantize(Decimal("0.01"))


class RoundUpRupeeTests(TestCase):
    def test_paise_go_up_to_the_next_rupee_and_a_whole_rupee_stays(self):
        self.assertEqual(round_up_rupee(Decimal("89.11")), Decimal("90.00"))
        self.assertEqual(round_up_rupee(Decimal("89.66")), Decimal("90.00"))
        self.assertEqual(round_up_rupee(Decimal("13489.76")), Decimal("13490.00"))
        self.assertEqual(round_up_rupee(Decimal("89.00")), Decimal("89.00"))

    def test_noise_below_a_paisa_never_adds_a_rupee(self):
        self.assertEqual(round_up_rupee(Decimal("89.0000001")), Decimal("89.00"))
        self.assertEqual(round_up_rupee(8000.0000000002), Decimal("8000.00"))

    def test_a_negative_net_goes_towards_zero(self):
        self.assertEqual(round_up_rupee(Decimal("-12.50")), Decimal("-12.00"))

    def test_a_saved_net_follows_whether_rounded_up_or_to_the_paisa_and_nothing_else(self):
        # the checks that flag a hand-edited payroll accept the new whole-rupee NET and an older one to the paisa
        self.assertTrue(net_follows(Decimal("13490.00"), Decimal("13489.11")))
        self.assertTrue(net_follows(Decimal("13489.11"), Decimal("13489.11")))
        self.assertFalse(net_follows(Decimal("13491.00"), Decimal("13489.11")))
        self.assertFalse(net_follows(Decimal("13489.00"), Decimal("13489.11")))


class StaffEngineRoundingTests(TestCase):
    def setUp(self):
        _configure(
            staff_pf_rules=[],
            staff_esi_rules=[],
            late_free_allowance=3,
            late_deduction_slabs=[],
            permission_monthly_cap=3,
            attendance_mode="simple",
            compensation_feature_enabled=True,
        )
        self.addCleanup(_holiday_dates_for_month.cache_clear)

    def test_esi_is_a_whole_rupee_and_the_net_adds_up_with_it(self):
        _configure(
            staff_pf_rules=[_rule("pf1", 0, 25000, 12)],
            staff_esi_rules=[_rule("esi1", 0, 30000, "0.75")],
        )
        emp = _staff(code="RND_ESI", salary="20400.00", co_emp_enabled=True)
        _present_all(emp)
        p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
        slip = SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)
        # ESI 0.75% of the 10,200 first portion = 76.50 -> 77.00; PF 12% = 1,224.00
        self.assertEqual((slip.pf_deduction, slip.esi_deduction), (Decimal("1224.00"), Decimal("77.00")))
        self.assertEqual(p.deductions, Decimal("1301.00"))
        self.assertEqual(p.final_salary, Decimal("19099.00"))
        self.assertEqual(slip.net_salary, p.final_salary)
        self.assertEqual(slip.breakdown_details["deductions"]["esi"], 77.0)

    def test_a_net_with_paise_is_rounded_up_and_stored_that_way(self):
        emp = _staff(code="RND_NET", salary="20000.00")
        _present_all(emp, WORKING_DAYS[:-1])  # one working day absent: the pay has paise
        p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
        exact = p.gross_salary + p.ot_amount - p.deductions
        self.assertNotEqual(exact, _ceil(exact), "the example must have paise to prove anything")
        self.assertEqual(p.final_salary, _ceil(exact))
        slip = SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)
        self.assertEqual(slip.net_salary, p.final_salary)
        self.assertEqual(Decimal(str(slip.breakdown_details["netSalary"])), p.final_salary)

    def test_hr_adjusting_the_bonus_keeps_the_net_a_whole_rupee(self):
        emp = _staff(code="RND_ADJ", salary="24000.00")
        _present_all(emp)
        p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
        r = self.client.patch(
            f"/api/payroll/{p.id}", data=json.dumps({"bonus": 100.40}), content_type="application/json", **_hr()
        )
        self.assertEqual(r.status_code, 200)
        p.refresh_from_db()
        self.assertEqual(p.final_salary, Decimal("24101.00"))  # 24,000 + 100.40 -> 24,101


class ProductionEngineRoundingTests(TestCase):
    START, END = date(2026, 2, 2), date(2026, 2, 8)

    def setUp(self):
        _configure(prod_pf_rules=[], prod_esi_rules=[], prod_late_detection_enabled=False)

    def test_a_net_with_paise_is_rounded_up(self):
        emp = _production(code="RND_P", per_shift="333.33")
        _day(emp, self.START, shifts="1.00")
        p = _generate_production_payroll(emp, self.START, self.END)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("333.33"))
        self.assertEqual(p.final_salary, Decimal("334.00"))
        slip = SalarySlip.objects.get(employee=emp, period_start=self.START, period_end=self.END)
        self.assertEqual(slip.net_salary, Decimal("334.00"))

    def test_production_esi_is_a_whole_rupee(self):
        _configure(prod_esi_rules=[_rule("pesi", 0, 0, "0.75", "total")])
        emp = _production(code="RND_PE", per_shift="500.00", co_emp_enabled=True)
        for offset in range(7):
            _day(emp, date(2026, 2, 2 + offset), shifts="1.00")
        _generate_production_payroll(emp, self.START, self.END, pay_cycle="weekly")
        slip = SalarySlip.objects.get(employee=emp, period_start=self.START, period_end=self.END)
        self.assertGreater(slip.esi_deduction, Decimal("0"))
        self.assertEqual(slip.esi_deduction, _ceil(slip.esi_deduction))
        self.assertEqual(slip.net_salary, _ceil(slip.gross_salary - slip.total_deductions))


class ActiveEmployeesOnlyTests(TestCase):
    """A payroll generated while someone was active stays stored after they are deactivated, but no payroll list, export
    source or slip list shows it any more. One employee's own history (employeeId) still lists it."""

    START, END = date(2026, 2, 2), date(2026, 2, 8)

    def setUp(self):
        _configure(
            staff_pf_rules=[],
            staff_esi_rules=[],
            prod_pf_rules=[],
            prod_esi_rules=[],
            prod_late_detection_enabled=False,
            attendance_mode="simple",
        )
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        self.headers = _hr()
        self.active = _staff(code="ACT_S")
        self.left = _staff(code="LEFT_S")
        for emp in (self.active, self.left):
            _present_all(emp)
            _generate_staff_payroll(emp, MONTH, YEAR)
        self.prod_active = _production(code="ACT_P", production_pay_cycle="weekly")
        self.prod_left = _production(code="LEFT_P", production_pay_cycle="weekly")
        for emp in (self.prod_active, self.prod_left):
            _day(emp, self.START)
            _generate_production_payroll(emp, self.START, self.END, pay_cycle="weekly")
        # both leave after their payroll was generated
        for emp in (self.left, self.prod_left):
            emp.status = "inactive"
            emp.save(update_fields=["status"])

    def _get(self, url):
        r = self.client.get(url, **self.headers)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return json.dumps(r.json())

    def test_the_rows_are_kept(self):
        self.assertTrue(Payroll.objects.filter(employee=self.left).exists())
        self.assertTrue(Payroll.objects.filter(employee=self.prod_left).exists())

    def test_the_staff_payroll_list_and_so_the_bank_file_skip_an_inactive_employee(self):
        body = self._get(f"/api/payroll?month={MONTH}&year={YEAR}")
        self.assertIn("ACT_S", body)
        self.assertNotIn("LEFT_S", body)
        # their own history still lists it
        self.assertIn("LEFT_S", self._get(f"/api/payroll?employeeId={self.left.id}"))

    def test_the_staff_salary_statement_and_issues_skip_an_inactive_employee(self):
        for url in (
            f"/api/payroll/salary-statement?month={MONTH}&year={YEAR}",
            f"/api/payroll/issues?month={MONTH}&year={YEAR}",
        ):
            body = self._get(url)
            self.assertIn("ACT_S", body, url)
            self.assertNotIn("LEFT_S", body, url)

    def test_the_production_lists_skip_an_inactive_employee(self):
        for url in (
            "/api/payroll/production?cycle=weekly",
            "/api/payroll/production",
            f"/api/payroll/production/salary-statement?cycle=weekly&periodStart={self.START}&periodEnd={self.END}",
        ):
            body = self._get(url)
            self.assertIn("ACT_P", body, url)
            self.assertNotIn("LEFT_P", body, url)
        self.assertIn("LEFT_P", self._get(f"/api/payroll/production?employeeId={self.prod_left.id}"))

    def test_the_salary_slip_lists_skip_an_inactive_employee(self):
        body = self._get(f"/api/salary-slips?month={MONTH}&year={YEAR}&employmentType=staff")
        self.assertIn("ACT_S", body)
        self.assertNotIn("LEFT_S", body)
        self.assertIn("LEFT_S", self._get(f"/api/salary-slips?employeeId={self.left.id}"))
