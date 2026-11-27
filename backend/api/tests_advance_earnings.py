"""Salary Advance / Term Loan business rules of 2026-11-26 (advance_earnings.py, mobile_settlement_views.py,
settlement_views.py, mobile_withdraw_views.py):

  * the limit is 50 % of the salary EARNED in the 1st-20th, priced exactly like the staff payroll (checked here against the
    payroll engine itself over a whole month);
  * a Term Loan needs 6 completed months of service (like the Casual Leave service rule);
  * an employee may delete their own application only while it waits for HR; HR's Delete is pending-only too;
  * HR may record a Salary Advance above the limit with a remark; GET /api/advances/earnings for the New dialog;
  * the 1st-20th figures are kept on the advance and served in the list (the Settlement report's columns).

Calendar: February 2026 starts on a Sunday, so it has 24 Mon-Sat days; a salary of 24,000 is exactly 1,000 a day.

Run via: python manage.py test api.tests_advance_earnings -v 2
"""

from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase

from . import advance_earnings, approval_workflow as approval
from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import Advance, AttendanceDayRecord, Employee, Holiday, HRUser, PayrollSettings
from .payroll_views import _generate_staff_payroll


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _staff(code="ADV_E", salary="24000.00", join_date="2020-01-01", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name=code, last_name="Staff", employment_type="staff", status="active",
        salary_type="monthly", salary_amount=Decimal(salary), join_date=join_date, **kw,
    )  # fmt: skip


def _day(emp, d, status="present", shifts="1.00"):
    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status=status, shifts_earned=Decimal(shifts), is_half_shift=(status == "half_shift"),
        source="manual",
    )  # fmt: skip


def _configure():
    ps = PayrollSettings.get()
    ps.staff_pf_rules = []
    ps.staff_esi_rules = []
    ps.late_free_allowance = 3
    ps.late_deduction_slabs = []
    ps.permission_monthly_cap = 3
    ps.attendance_mode = "simple"
    ps.save()


class CalculatorTests(TestCase):
    """The 1st-20th salary is the payroll's own arithmetic, just stopped at the 20th."""

    def setUp(self):
        _configure()
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        self.emp = _staff()

    def _february(self):
        """2-7 Feb present, 9 Feb half day, 10 Feb HR-marked holiday, 11 Feb a declared holiday, 12-14 absent, 16-20
        present (a quarter cut on the 16th), 21-28 present."""
        Holiday.objects.create(name="Festival", date=date(2026, 2, 11))
        _holiday_dates_for_month.cache_clear()
        for n in range(2, 8):
            _day(self.emp, date(2026, 2, n))
        _day(self.emp, date(2026, 2, 9), "half_shift", "0.50")
        _day(self.emp, date(2026, 2, 10), "holiday", "0")
        _day(self.emp, date(2026, 2, 16), "present", "0.75")
        for n in (17, 18, 19, 20):
            _day(self.emp, date(2026, 2, n))
        for n in (21, 23, 24, 25, 26, 27, 28):
            _day(self.emp, date(2026, 2, n))

    def test_the_first_20_days(self):
        self._february()
        e = advance_earnings.earned_in_month(self.emp, 2, 2026)
        # present: 6 + 0.5 + 0.75 + 4 = 11.25; paid: + the HR holiday + the declared holiday = 13.25 days of 1,000
        self.assertEqual((e.company_days, e.through), (24, date(2026, 2, 20)))
        self.assertEqual((e.working_days, e.paid_days), (Decimal("11.25"), Decimal("13.25")))
        self.assertEqual((e.earned, e.limit, e.fixed_salary), (Decimal("13250.00"), Decimal("6625"), Decimal("24000")))

    def test_over_the_whole_month_it_is_exactly_what_payroll_pays(self):
        self._february()
        whole = advance_earnings.earned_in_month(self.emp, 2, 2026, through_day=31)
        payroll = _generate_staff_payroll(self.emp, 2, 2026)["payroll"]
        self.assertEqual(whole.earned, payroll.gross_salary)

    def test_the_limit_is_whole_rupees_rounded_down(self):
        _day(self.emp, date(2026, 2, 2), "half_shift", "0.50")  # 500 earned -> 250
        _day(self.emp, date(2026, 2, 3), "present", "0.75")  # +750 -> 1,250 earned -> 625
        self.assertEqual(advance_earnings.earned_in_month(self.emp, 2, 2026).limit, Decimal("625"))
        emp = _staff("ADV_ODD", salary="25000.00")  # 25,000 / 24 a day
        _day(emp, date(2026, 2, 2))
        e = advance_earnings.earned_in_month(emp, 2, 2026)
        self.assertEqual((e.earned, e.limit), (Decimal("1041.67"), Decimal("520")))

    def test_a_production_employee_has_no_figures(self):
        emp = Employee.objects.create(
            employee_code="ADV_P", first_name="P", last_name="Prod", employment_type="production", status="active",
            salary_per_shift=Decimal("500"),
        )  # fmt: skip
        self.assertIsNone(advance_earnings.earned_in_month(emp, 2, 2026))


class TermLoanServiceTests(TestCase):
    def test_six_completed_months_from_the_joining_date(self):
        emp = _staff(join_date="2026-05-31")
        # 31 May + 6 months: 30 November is not yet 6 COMPLETED months (the Casual Leave count), 1 December is
        before = advance_earnings.term_loan_service(emp, date(2026, 11, 30))
        self.assertFalse(before["eligible"])
        self.assertEqual((before["serviceMonths"], before["eligibleFrom"]), (5, "2026-12-01"))
        self.assertIn("6 months of service", before["reason"])
        self.assertIn("1 December 2026", before["reason"])
        self.assertTrue(advance_earnings.term_loan_service(emp, date(2026, 12, 1))["eligible"])

    def test_no_joining_date(self):
        emp = _staff(join_date=None)
        s = advance_earnings.term_loan_service(emp, date(2026, 11, 30))
        self.assertFalse(s["eligible"])
        self.assertIn("joining date is not recorded", s["reason"])


class _AppBase(TestCase):
    DAY = date(2026, 2, 21)

    def setUp(self):
        _configure()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        admin, _ = HRUser.objects.get_or_create(
            username="adv_rules_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = _bearer({"role": "hr", "hrUserId": admin.id, "name": "Meena HR"})
        self.emp = _staff()
        for n in range(2, 8):  # 6 days of 1,000 earned -> limit 3,000
            _day(self.emp, date(2026, 2, n))
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})

    def at(self, day):
        for target in ("api.mobile_settlement_views.ist_today", "api.settlement_views.ist_today"):
            p = patch(target, return_value=day)
            p.start()
            self.addCleanup(p.stop)

    def apply(self, body, day=None):
        self.at(day or self.DAY)
        r = self.client.post("/api/my/advances", body, content_type="application/json", **self.me)
        if r.status_code == 201:
            d = day or self.DAY
            Advance.objects.filter(pk=r.json()["id"]).update(
                created_at=datetime(d.year, d.month, d.day, 6, 30, tzinfo=dt_timezone.utc)
            )
        return r


class EmployeeApplicationTests(_AppBase):
    def test_the_limit_is_half_of_what_was_earned_by_the_20th(self):
        r = self.apply({"advanceType": "general", "amount": 3001, "purpose": "School fees"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "over_limit"))
        self.assertIn("₹3,000", r.json()["error"])
        self.assertIn("₹6,000", r.json()["error"])
        r = self.apply({"advanceType": "general", "amount": 3000, "purpose": "School fees"})
        self.assertEqual(r.status_code, 201, r.content)
        e = r.json()["earnings"]
        self.assertEqual(
            (e["month"], e["fixedSalary"], e["workingDays"], e["workingSalary"], e["earnedAmount"], e["limit"]),
            (2, 24000.0, 6.0, 6000.0, 6000.0, 3000.0),
        )
        body = self.client.get("/api/my/advances/eligibility", **self.me).json()["salaryAdvance"]
        self.assertEqual(
            (body["limit"], body["earned"]["earnedAmount"], body["earned"]["final"]), (3000.0, 6000.0, True)
        )

    def test_a_term_loan_needs_six_months_of_service(self):
        self.emp.join_date = "2025-09-01"
        self.emp.save()
        r = self.apply({"advanceType": "term", "amount": 5000, "repaymentMonths": 5, "purpose": "Repairs"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "service"))
        self.assertIn("1 March 2026", r.json()["error"])
        term = self.client.get("/api/my/advances/eligibility", **self.me).json()["termLoan"]
        self.assertFalse(term["canApply"])
        self.assertEqual((term["service"]["serviceMonths"], term["service"]["requiredMonths"]), (5, 6))
        r = self.apply(
            {"advanceType": "term", "amount": 5000, "repaymentMonths": 5, "purpose": "Repairs"}, day=date(2026, 3, 1)
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_withdraw_only_while_it_waits_for_hr(self):
        pk = self.apply({"advanceType": "general", "amount": 1000, "purpose": "Medical"}).json()["id"]
        other = _staff("ADV_O")
        them = _bearer({"role": "employee", "employeeId": other.id})
        self.assertEqual(self.client.post(f"/api/my/requests/advance/{pk}/withdraw", **them).status_code, 404)
        r = self.client.post(f"/api/my/requests/advance/{pk}/withdraw", **self.me)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("Salary Advance application", r.json()["message"])
        self.assertFalse(Advance.objects.filter(pk=pk).exists())
        # decided: stays
        pk = self.apply({"advanceType": "general", "amount": 1000, "purpose": "Medical"}).json()["id"]
        put = self.client.put(f"/api/advances/{pk}", {"status": "approved"}, content_type="application/json", **self.hr)
        self.assertEqual(put.status_code, 200, put.content)
        r = self.client.post(f"/api/my/requests/advances/{pk}/withdraw", **self.me)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "not_pending"))
        self.assertTrue(Advance.objects.filter(pk=pk).exists())


class HrTests(_AppBase):
    def test_hr_delete_is_for_pending_advances_only(self):
        pending = Advance.objects.create(employee=self.emp, advance_type="term", amount=Decimal("1000"),
                                         outstanding=Decimal("1000"))  # fmt: skip
        for status in ("approved", "rejected", "closed"):
            a = Advance.objects.create(employee=self.emp, advance_type="general", amount=Decimal("100"),
                                       outstanding=Decimal("100"), status=status)  # fmt: skip
            r = self.client.delete(f"/api/advances/{a.id}", **self.hr)
            self.assertEqual((r.status_code, r.json()["code"]), (409, "not_pending"), status)
        self.assertEqual(self.client.delete(f"/api/advances/{pending.id}", **self.hr).status_code, 204)
        self.assertEqual(Advance.objects.count(), 3)

    def test_hr_raises_a_request_by_the_employee_rules(self):
        """Owner 2026-11-27: HR's manual request on an employee's behalf follows exactly the employee rules - the 50 %
        limit (no going over it), the 21st-22nd window, one a month, the Term Loan's service - and the same workflow."""
        self.at(self.DAY)
        body = {"employeeId": self.emp.id, "amount": 4000, "advanceType": "general", "purpose": "Hospital bill"}
        r = self.client.post("/api/advances", body, content_type="application/json", **self.hr)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "over_limit"))
        r = self.client.post("/api/advances", {**body, "amount": 3000}, content_type="application/json", **self.hr)
        self.assertEqual(r.status_code, 201, r.content)
        made = r.json()
        self.assertEqual(
            (made["appliedBy"], made["status"], made["typeLabel"], made["earnings"]["limit"], made["limitRemark"]),
            ("hr", "pending", "Salary Advance", 3000.0, ""),
        )
        self.assertEqual(
            (made["repaymentStartMonth"], made["repaymentStartYear"]), (2, 2026)
        )  # this month, as an employee's
        # one a month, however it was raised
        again = self.client.post("/api/advances", {**body, "amount": 100}, content_type="application/json", **self.hr)
        self.assertEqual((again.status_code, again.json()["code"]), (409, "duplicate"))
        # the window: not on the 20th
        self.at(date(2026, 2, 20))
        other = _staff("ADV_W")
        early = self.client.post(
            "/api/advances", {**body, "employeeId": other.id, "amount": 100}, content_type="application/json", **self.hr
        )
        self.assertEqual((early.status_code, early.json()["code"]), (400, "window_closed"))
        # a Term Loan: months, the minimum and the service
        loan = {
            "employeeId": self.emp.id,
            "advanceType": "term",
            "amount": 20000,
            "repaymentMonths": 5,
            "purpose": "House",
        }
        self.assertEqual(
            self.client.post("/api/advances", loan, content_type="application/json", **self.hr).status_code, 201
        )
        new = _staff("ADV_N", join_date="2026-01-10")
        refused = self.client.post(
            "/api/advances", {**loan, "employeeId": new.id}, content_type="application/json", **self.hr
        )
        self.assertEqual((refused.status_code, refused.json()["code"]), (403, "service"))
        bad = self.client.post(
            "/api/advances", {**body, "advanceType": "loan"}, content_type="application/json", **self.hr
        )
        self.assertEqual(bad.status_code, 400)

    def test_the_new_request_dialog_gets_the_employees_eligibility(self):
        self.at(self.DAY)
        r = self.client.get(f"/api/advances/eligibility?employeeId={self.emp.id}", **self.hr)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["employee"]["code"], body["salaryAdvance"]["limit"]), ("ADV_E", 3000.0))
        self.assertTrue(body["salaryAdvance"]["canApply"])
        self.assertTrue(body["termLoan"]["service"]["eligible"])
        self.assertEqual(self.client.get("/api/advances/eligibility?employeeId=0", **self.hr).status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/advances/eligibility?employeeId={self.emp.id}", **self.me).status_code, 403
        )

    def test_the_new_dialogs_figures(self):
        self.at(self.DAY)
        r = self.client.get(f"/api/advances/earnings?employeeId={self.emp.id}", **self.hr)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["month"], body["year"], body["percent"], body["throughDay"]), (2, 2026, 50, 20))
        self.assertEqual((body["earnings"]["earnedAmount"], body["earnings"]["limit"]), (6000.0, 3000.0))
        self.assertTrue(body["termLoanService"]["eligible"])
        self.assertEqual(self.client.get("/api/advances/earnings?employeeId=0", **self.hr).status_code, 404)
        me = self.client.get(f"/api/advances/earnings?employeeId={self.emp.id}", **self.me)
        self.assertEqual(me.status_code, 403)

    def test_the_list_carries_the_figures_and_fills_older_advances(self):
        old = Advance.objects.create(employee=self.emp, advance_type="term", amount=Decimal("2000"),
                                     outstanding=Decimal("2000"))  # fmt: skip
        Advance.objects.filter(pk=old.pk).update(created_at=datetime(2026, 2, 21, 6, 0, tzinfo=dt_timezone.utc))
        self.at(date(2026, 2, 25))
        rows = self.client.get("/api/advances", **self.hr).json()
        e = rows[0]["earnings"]
        self.assertEqual((e["month"], e["workingDays"], e["earnedAmount"], e["fixedSalary"]), (2, 6.0, 6000.0, 24000.0))
        self.assertEqual(rows[0]["typeLabel"], "Term Loan")
        old.refresh_from_db()
        self.assertEqual(old.earned_amount, Decimal("6000.00"))

    def test_deciding_works_the_figures_out_again(self):
        pk = self.apply({"advanceType": "general", "amount": 1000, "purpose": "Medical"}).json()["id"]
        AttendanceDayRecord.objects.update_or_create(  # an HR correction after the request: one more day earned
            employee=self.emp, date=date(2026, 2, 9),
            defaults={"status": "present", "shifts_earned": Decimal("1.00"), "source": "manual"},
        )  # fmt: skip
        r = self.client.put(f"/api/advances/{pk}", {"status": "approved"}, content_type="application/json", **self.hr)
        self.assertEqual(r.json()["earnings"]["earnedAmount"], 7000.0)


class ReviewFixTests(_AppBase):
    """Fixes from the 2026-11-26 review."""

    def test_an_advance_hr_recorded_cannot_be_withdrawn_by_the_employee(self):
        hr_made = Advance.objects.create(employee=self.emp, advance_type="general", amount=Decimal("500"),
                                         outstanding=Decimal("500"))  # fmt: skip
        r = self.client.post(f"/api/my/requests/advance/{hr_made.id}/withdraw", **self.me)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "recorded_by_hr"))
        self.assertTrue(Advance.objects.filter(pk=hr_made.pk).exists())

    def test_a_declared_holiday_still_to_come_is_not_earned_yet(self):
        Holiday.objects.create(name="Festival", date=date(2026, 2, 16))
        _holiday_dates_for_month.cache_clear()
        before = advance_earnings.earned_in_month(self.emp, 2, 2026, today=date(2026, 2, 10))
        after = advance_earnings.earned_in_month(self.emp, 2, 2026, today=date(2026, 2, 21))
        self.assertEqual((before.paid_days, after.paid_days), (Decimal("6"), Decimal("7")))

    def test_an_older_advance_is_priced_at_the_salary_of_its_own_month(self):
        old = Advance.objects.create(employee=self.emp, advance_type="term", amount=Decimal("2000"),
                                     outstanding=Decimal("2000"), salary_at_request=Decimal("12000"))  # fmt: skip
        Advance.objects.filter(pk=old.pk).update(created_at=datetime(2026, 2, 21, 6, 0, tzinfo=dt_timezone.utc))
        old.refresh_from_db()
        advance_earnings.refresh(old)
        # 6 days at 12,000 / 24 = 500, not at today's 24,000
        self.assertEqual((old.earned_amount, old.salary_at_request), (Decimal("3000.00"), Decimal("12000")))

    def test_the_backfill_command(self):
        from io import StringIO

        from django.core.management import call_command

        Advance.objects.create(
            employee=self.emp, advance_type="term", amount=Decimal("2000"), outstanding=Decimal("2000")
        )
        out = StringIO()
        call_command("fill_advance_earnings", "--dry-run", stdout=out)
        self.assertIn("1 advance(s)", out.getvalue())
        call_command("fill_advance_earnings", stdout=out)
        self.assertFalse(Advance.objects.filter(earned_on__isnull=True).exists())


class BankDetailsTests(_AppBase):
    """The Settlement page's Export Bank File reads the bank details from HR's list (2026-11-26); employees never get
    them in the list."""

    def test_hr_list_carries_bank_details_employee_list_does_not(self):
        Employee.objects.filter(pk=self.emp.pk).update(
            bank_account="123456789", bank_ifsc="HDFC0001234", bank_name="HDFC"
        )
        Advance.objects.create(
            employee=self.emp, advance_type="general", amount=Decimal("500"), outstanding=Decimal("500")
        )
        hr_row = self.client.get("/api/advances", **self.hr).json()[0]
        self.assertEqual(
            (hr_row["bankAccount"], hr_row["bankIfsc"], hr_row["bankName"]), ("123456789", "HDFC0001234", "HDFC")
        )
        mine = self.client.get("/api/advances", **self.me).json()[0]
        self.assertNotIn("bankAccount", mine)


class CompanyHolidaysTests(_AppBase):
    """Owner 2026-11-26: the company holidays of the 1st-20th are paid working days - in Working Days, in the Earned
    Salary and so in the 50 % Limit (exactly what payroll pays for them; payroll itself is unchanged)."""

    def test_holidays_in_the_first_20_days_are_working_days_earned_and_raise_the_limit(self):
        before = advance_earnings.earned_in_month(self.emp, 2, 2026)  # 6 days worked: 6,000 earned, limit 3,000
        Holiday.objects.create(name="Festival", date=date(2026, 2, 10), holiday_type="national")
        Holiday.objects.create(name="Company day", date=date(2026, 2, 16), holiday_type="company")
        Holiday.objects.create(name="After the 20th", date=date(2026, 2, 24), holiday_type="national")
        Holiday.objects.create(name="On a Sunday", date=date(2026, 2, 15), holiday_type="national")
        _holiday_dates_for_month.cache_clear()
        after = advance_earnings.earned_in_month(self.emp, 2, 2026)
        self.assertEqual(
            (before.paid_days, before.earned, before.limit), (Decimal("6"), Decimal("6000.00"), Decimal("3000"))
        )
        # +2 (10th and 16th); the 24th is after the 20th and the 15th is a Sunday (not a company day), as in payroll
        self.assertEqual(
            (after.paid_days, after.earned, after.limit), (Decimal("8"), Decimal("8000.00"), Decimal("4000"))
        )
        j = after.to_json()
        self.assertEqual((j["workingDays"], j["presentShifts"], j["holidayDays"]), (8.0, 6.0, 2.0))

        r = self.apply({"advanceType": "general", "amount": 4000, "purpose": "Festival"})
        self.assertEqual(r.status_code, 201, r.content)
        e = r.json()["earnings"]
        self.assertEqual(
            (e["workingDays"], e["presentShifts"], e["holidayDays"], e["earnedAmount"], e["limit"]),
            (8.0, 6.0, 2.0, 8000.0, 4000.0),
        )
        listed = self.client.get("/api/advances", **self.hr).json()[0]["earnings"]
        self.assertEqual((listed["workingDays"], listed["earnedAmount"], listed["limit"]), (8.0, 8000.0, 4000.0))

    def test_a_holiday_before_joining_is_not_paid(self):
        self.emp.join_date = "2026-02-12"
        self.emp.save()
        Holiday.objects.create(name="Festival", date=date(2026, 2, 10), holiday_type="national")
        _holiday_dates_for_month.cache_clear()
        e = advance_earnings.earned_in_month(self.emp, 2, 2026)
        self.assertEqual(e.paid_days - e.working_days, Decimal("0"))
