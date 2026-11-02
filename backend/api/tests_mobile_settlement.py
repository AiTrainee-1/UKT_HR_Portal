"""Employee self-service Salary Advance and Term Loan (mobile_settlement_views.py) and HR approving a smaller amount
(settlement_views.advance_detail).

Run via: python manage.py test api.tests_mobile_settlement -v 2
"""

from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase

from . import approval_workflow as approval
from .jwt_utils import sign_token
from .mobile_settlement_views import schedule_plan, window
from .models import Advance, AdvanceRepayment, Department, Employee, HRUser
from .payroll_views import _pending_advance_repayments
from .settlement_views import whole_rupee_emi


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def on(day: date):
    """Pretend the factory date is `day`."""
    return patch("api.mobile_settlement_views.ist_today", return_value=day)


class _Base(TestCase):
    def setUp(self):
        approval.clear_cache()
        admin, _ = HRUser.objects.get_or_create(
            username="settle_mobile_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = _bearer({"role": "hr", "hrUserId": admin.id, "name": "Meena HR"})
        dept = Department.objects.create(name="Accounts")
        self.emp = Employee.objects.create(
            employee_code="AD1", first_name="Ravi", last_name="Kumar", status="active", employment_type="staff",
            department=dept, join_date="2020-01-01", salary_amount=Decimal("30000"),
        )  # fmt: skip
        self.other = Employee.objects.create(
            employee_code="AD2", first_name="Lata", last_name="Devi", status="active", employment_type="staff",
            department=dept, join_date="2021-01-01", salary_amount=Decimal("20000"),
        )  # fmt: skip
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.them = _bearer({"role": "employee", "employeeId": self.other.id})

    def tearDown(self):
        approval.clear_cache()

    def apply(self, body: dict, day: date = date(2026, 10, 25), auth=None):
        with on(day):
            r = self.client.post("/api/my/advances", body, content_type="application/json", **(auth or self.me))
        if r.status_code == 201:
            # created_at comes from the real clock; stamp the pretend day so "applied this month" rules see the same
            # month the test is pretending (otherwise the tests break once the real calendar moves past October 2026).
            Advance.objects.filter(pk=r.json()["id"]).update(
                created_at=datetime(day.year, day.month, day.day, 6, 30, tzinfo=dt_timezone.utc)
            )
        return r

    def general(self, amount=10000, day: date = date(2026, 10, 25), auth=None):
        return self.apply({"advanceType": "general", "amount": amount, "purpose": "School fees"}, day, auth)

    def term(self, amount=10000, months=3, day: date = date(2026, 10, 25), auth=None):
        return self.apply(
            {"advanceType": "term", "amount": amount, "repaymentMonths": months, "purpose": "House repair"}, day, auth
        )

    def hr_put(self, pk: int, body: dict):
        return self.client.put(f"/api/advances/{pk}", body, content_type="application/json", **self.hr)

    def schedule(self, pk: int):
        return list(
            AdvanceRepayment.objects.filter(advance_id=pk)
            .order_by("year", "month")
            .values_list("month", "year", "amount")
        )


class WindowTests(_Base):
    def test_the_19th_is_refused_with_the_opening_date(self):
        r = self.general(day=date(2026, 11, 19))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "window_closed")
        self.assertIn("20 November", r.json()["error"])
        self.assertFalse(Advance.objects.exists())

    def test_the_20th_and_the_last_day_are_open(self):
        self.assertEqual(self.term(day=date(2026, 11, 20)).status_code, 201)
        self.assertEqual(self.general(day=date(2026, 11, 30)).status_code, 201)

    def test_the_first_of_the_month_is_closed_for_both_forms(self):
        self.assertEqual(self.term(day=date(2026, 12, 1)).json()["code"], "window_closed")
        self.assertEqual(self.general(day=date(2026, 12, 1)).json()["code"], "window_closed")

    def test_the_window_follows_the_factory_date_not_utc(self):
        class FakeDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                moment = datetime(2026, 11, 19, 19, 0, tzinfo=dt_timezone.utc)  # 00:30 on the 20th in Tirupur
                return moment.astimezone(tz) if tz else moment.replace(tzinfo=None)

        with patch("api.clock.datetime", FakeDateTime):
            r = self.client.post(
                "/api/my/advances",
                {"advanceType": "general", "amount": 1000, "purpose": "Medical"},
                content_type="application/json",
                **self.me,
            )
        self.assertEqual(r.status_code, 201, r.content)

    def test_eligibility_says_when_it_opens(self):
        with on(date(2026, 11, 5)):
            body = self.client.get("/api/my/advances/eligibility", **self.me).json()
        w = body["window"]
        self.assertEqual(
            (w["isOpen"], w["opensOn"], w["closesOn"], w["daysUntilOpen"]), (False, "2026-11-20", "2026-11-30", 15)
        )
        self.assertFalse(body["salaryAdvance"]["canApply"])
        self.assertIn("20 November", body["salaryAdvance"]["reason"])
        self.assertFalse(body["termLoan"]["canApply"])

    def test_window_rules(self):
        self.assertTrue(window(date(2027, 2, 28))["isOpen"])
        self.assertEqual(window(date(2027, 2, 28))["daysLeft"], 1)
        self.assertEqual(window(date(2026, 12, 25))["nextOpensOn"], "2027-01-20")


class SalaryAdvanceTests(_Base):
    def test_up_to_60_percent_of_the_monthly_salary(self):
        r = self.general(18001)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "over_limit")
        self.assertIn("₹18,000", r.json()["error"])
        self.assertIn("₹30,000", r.json()["error"])
        r = self.general(18000)
        self.assertEqual(r.status_code, 201, r.content)
        a = Advance.objects.get()
        self.assertEqual(
            (a.amount, a.requested_amount, a.salary_at_request, a.applied_by, a.status),
            (Decimal("18000"), Decimal("18000"), Decimal("30000"), "employee", "pending"),
        )

    def test_deducted_in_full_from_the_month_it_is_applied_in(self):
        r = self.general(5000, day=date(2026, 12, 22))
        a = Advance.objects.get(pk=r.json()["id"])
        self.assertEqual((a.repayment_start_month, a.repayment_start_year), (12, 2026))
        self.assertEqual(r.json()["deductionLabel"], "December 2026")
        self.assertEqual(
            [(s["month"], s["year"], s["amount"], s["state"]) for s in r.json()["schedule"]],
            [(12, 2026, 5000.0, "planned")],
        )
        self.assertEqual(self.hr_put(a.id, {"status": "approved"}).status_code, 200)
        self.assertEqual(self.schedule(a.id), [(12, 2026, Decimal("5000.00"))])

    def test_no_salary_on_record_cannot_apply(self):
        self.emp.salary_amount = None
        self.emp.save()
        r = self.general(1000)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "no_salary"))
        with on(date(2026, 10, 25)):
            body = self.client.get("/api/my/advances/eligibility", **self.me).json()
        self.assertIsNone(body["monthlySalary"])
        self.assertFalse(body["salaryAdvance"]["canApply"])
        self.assertIn("not recorded", body["salaryAdvance"]["reason"])
        self.assertTrue(body["termLoan"]["canApply"])  # a Term Loan has no salary limit

    def test_production_staff_paid_per_shift_have_no_monthly_salary(self):
        self.emp.employment_type = "production"
        self.emp.salary_per_shift = Decimal("600")
        self.emp.save()
        self.assertEqual(self.general(1000).json()["code"], "no_salary")
        self.assertEqual(self.term().status_code, 201)

    def test_whole_rupees_and_a_purpose_are_required(self):
        self.assertEqual(self.general("1500.50").json()["field"], "amount")
        self.assertEqual(self.general(0).json()["field"], "amount")
        self.assertEqual(self.general("abc").json()["field"], "amount")
        r = self.apply({"advanceType": "general", "amount": 1000, "purpose": " "})
        self.assertEqual(r.json()["field"], "purpose")
        r = self.apply({"advanceType": "loan", "amount": 1000, "purpose": "x" * 10})
        self.assertEqual(r.json()["field"], "advanceType")
        self.assertEqual(self.general("1,500").status_code, 201)


class TermLoanTests(_Base):
    def test_months_must_be_1_to_12(self):
        for months in (0, 13, "abc", None, 2.5):
            r = self.term(months=months)
            self.assertEqual(r.status_code, 400, months)
            self.assertEqual(r.json()["field"], "repaymentMonths")
        self.assertEqual(self.term(months=1).status_code, 201)
        Advance.objects.all().delete()
        self.assertEqual(self.term(months=12).status_code, 201)

    def test_the_mobile_apps_snake_case_body_is_read(self):
        r = self.apply({"advance_type": "term", "amount": 5000, "repayment_months": 5, "purpose": "Bike repair"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["repaymentMonths"], r.json()["emiAmount"]), (5, 1000.0))

    def test_any_amount_from_1000_even_above_the_salary_limit(self):
        self.assertEqual(self.term(amount=999).json()["field"], "amount")
        self.assertEqual(self.term(amount=150000, months=12).status_code, 201)

    def test_emi_in_whole_rupees_last_one_absorbs_the_rest_starting_next_month(self):
        r = self.term(10000, 3, day=date(2026, 12, 21))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["emiAmount"], 3334.0)
        self.assertEqual((body["repaymentStartMonth"], body["repaymentStartYear"]), (1, 2027))
        self.assertEqual([s["amount"] for s in body["schedule"]], [3334.0, 3334.0, 3332.0])
        self.assertEqual(body["deductionLabel"], "January 2027 to March 2027")
        self.assertEqual(self.hr_put(body["id"], {"status": "approved"}).status_code, 200)
        self.assertEqual(
            self.schedule(body["id"]),
            [(1, 2027, Decimal("3334.00")), (2, 2027, Decimal("3334.00")), (3, 2027, Decimal("3332.00"))],
        )

    def test_rule_helpers(self):
        self.assertEqual(whole_rupee_emi(Decimal("12000"), 12), Decimal("1000"))
        self.assertEqual(whole_rupee_emi(Decimal("1000"), 12), Decimal("84"))
        plan = schedule_plan("term", Decimal("1000"), 12, 11, 2026)
        self.assertEqual(len(plan), 12)
        self.assertEqual(sum(p[2] for p in plan), Decimal("1000"))
        self.assertEqual(plan[-1], (10, 2027, Decimal("76")))


class HrDecisionTests(_Base):
    def test_hr_approves_a_smaller_amount_and_the_schedule_follows_it(self):
        pk = self.term(10000, 3).json()["id"]
        r = self.hr_put(pk, {"status": "approved", "amount": 6000})
        self.assertEqual(r.status_code, 200, r.content)
        a = Advance.objects.get(pk=pk)
        self.assertEqual(
            (a.amount, a.requested_amount, a.emi_amount, a.outstanding),
            (Decimal("6000"), Decimal("10000"), Decimal("2000"), Decimal("6000")),
        )
        self.assertEqual(a.approved_by, "Meena HR")
        self.assertEqual(
            self.schedule(pk),
            [(11, 2026, Decimal("2000.00")), (12, 2026, Decimal("2000.00")), (1, 2027, Decimal("2000.00"))],
        )
        self.assertEqual((r.json()["requestedAmount"], r.json()["amount"]), (10000.0, 6000.0))
        with on(date(2026, 10, 26)):
            mine = self.client.get(f"/api/my/advances/{pk}", **self.me).json()
        self.assertEqual(
            (mine["requestedAmount"], mine["approvedAmount"], mine["approvedLess"]), (10000.0, 6000.0, True)
        )
        self.assertIn("Approved ₹6,000 of the ₹10,000", mine["timeline"][1]["text"])

    def test_hr_cannot_approve_more_than_was_asked(self):
        pk = self.general(5000).json()["id"]
        r = self.hr_put(pk, {"status": "approved", "amount": 5001})
        self.assertEqual(r.status_code, 400)
        self.assertIn("₹5,000", r.json()["error"])
        a = Advance.objects.get(pk=pk)
        self.assertEqual((a.status, a.amount), ("pending", Decimal("5000")))
        self.assertFalse(AdvanceRepayment.objects.exists())

    def test_the_amount_is_fixed_once_approved(self):
        pk = self.general(5000).json()["id"]
        self.hr_put(pk, {"status": "approved"})
        self.assertEqual(self.hr_put(pk, {"amount": 4000}).status_code, 400)
        self.assertEqual(self.hr_put(pk, {"amount": 5000}).status_code, 200)  # unchanged = fine

    def test_hr_moves_the_first_deduction_month(self):
        pk = self.term(3000, 3).json()["id"]
        r = self.hr_put(pk, {"status": "approved", "repaymentStartMonth": 1, "repaymentStartYear": 2027})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([(m, y) for m, y, _ in self.schedule(pk)], [(1, 2027), (2, 2027), (3, 2027)])
        pk2 = self.general(1000).json()["id"]
        self.assertEqual(self.hr_put(pk2, {"status": "approved", "repaymentStartMonth": 13}).status_code, 400)

    def test_rejection_deducts_nothing_and_the_employee_sees_why(self):
        pk = self.general(5000).json()["id"]
        self.assertEqual(self.hr_put(pk, {"status": "rejected", "notes": "Already took one"}).status_code, 200)
        with on(date(2026, 10, 26)):
            mine = self.client.get(f"/api/my/advances/{pk}", **self.me).json()
        self.assertEqual((mine["status"], mine["balanceDue"], mine["schedule"]), ("rejected", 0.0, []))
        self.assertEqual(mine["timeline"][-1]["comment"], "Already took one")
        self.assertFalse(AdvanceRepayment.objects.exists())

    def test_payroll_finds_the_approved_deduction_as_before(self):
        pk = self.general(4000).json()["id"]
        self.hr_put(pk, {"status": "approved", "amount": 3000})
        total, details = _pending_advance_repayments(self.emp, 10, 2026)  # read-only lookup payroll uses
        self.assertEqual((total, len(details)), (Decimal("3000.00"), 1))

    def test_hr_list_marks_employee_applications(self):
        self.general(5000)
        Advance.objects.create(
            employee=self.other, advance_type="general", amount=Decimal("100"), outstanding=Decimal("100")
        )
        rows = {r["employeeCode"]: r for r in self.client.get("/api/advances", **self.hr).json()}
        self.assertEqual(
            (rows["AD1"]["appliedBy"], rows["AD1"]["requestedAmount"], rows["AD1"]["salaryAtRequest"]),
            ("employee", 5000.0, 30000.0),
        )
        self.assertEqual((rows["AD2"]["appliedBy"], rows["AD2"]["requestedAmount"]), ("hr", None))
        self.assertEqual(rows["AD1"]["approval"]["waitingFor"], ["hr"])


class DuplicateTests(_Base):
    def test_one_salary_advance_per_month_unless_rejected(self):
        first = self.general(1000).json()["id"]
        r = self.general(1000)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "duplicate"))
        self.hr_put(first, {"status": "rejected"})
        self.assertEqual(self.general(1000).status_code, 201)
        # next month's window is a new month
        self.assertEqual(self.general(1000, day=date(2026, 11, 21)).status_code, 201)

    def test_an_hr_recorded_salary_advance_for_this_month_counts(self):
        Advance.objects.create(
            employee=self.emp, advance_type="general", amount=Decimal("500"), outstanding=Decimal("500"),
            repayment_start_month=10, repayment_start_year=2026, status="approved",
        )  # fmt: skip
        self.assertEqual(self.general(1000).status_code, 409)

    def test_no_new_term_loan_while_one_waits(self):
        first = self.term().json()["id"]
        self.assertEqual(self.term().status_code, 409)
        self.assertEqual(self.general(1000).status_code, 201)  # the other form is independent
        self.hr_put(first, {"status": "approved"})
        self.assertEqual(self.term().status_code, 201)
        with on(date(2026, 10, 25)):
            body = self.client.get("/api/my/advances/eligibility", **self.me).json()
        self.assertFalse(body["termLoan"]["canApply"])
        self.assertEqual(body["termLoan"]["activeCount"], 1)
        self.assertIsNotNone(body["salaryAdvance"]["existing"])


class IsolationTests(_Base):
    def test_an_employee_sees_and_applies_only_for_themselves(self):
        theirs = self.general(1000, auth=self.them).json()["id"]
        r = self.apply({"advanceType": "general", "amount": 1000, "purpose": "Fees", "employeeId": self.other.id})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(Advance.objects.get(pk=r.json()["id"]).employee_id, self.emp.id)
        with on(date(2026, 10, 25)):
            mine = self.client.get("/api/my/advances", **self.me).json()
            self.assertEqual(self.client.get(f"/api/my/advances/{theirs}", **self.me).status_code, 404)
        self.assertEqual([a["employeeId"] for a in mine], [self.emp.id])
        listed = self.client.get(f"/api/advances?employeeId={self.other.id}", **self.me).json()
        self.assertEqual({a["employeeId"] for a in listed}, {self.emp.id})

    def test_hr_tokens_and_anonymous_calls_are_refused(self):
        self.assertEqual(self.client.get("/api/my/advances", **self.hr).status_code, 403)
        self.assertEqual(self.client.get("/api/my/advances/eligibility", **self.hr).status_code, 403)
        self.assertEqual(self.client.get("/api/my/advances").status_code, 401)

    def test_an_employee_cannot_decide(self):
        pk = self.general(1000).json()["id"]
        r = self.client.put(f"/api/advances/{pk}", {"status": "approved"}, content_type="application/json", **self.me)
        self.assertEqual(r.status_code, 403)

    def test_inactive_employees_cannot_apply(self):
        self.emp.status = "inactive"
        self.emp.save()
        self.assertEqual(self.general(1000).status_code, 403)


class WorkflowOffTests(_Base):
    def test_switched_off_refuses_new_applications_but_hr_still_decides(self):
        pk = self.general(1000).json()["id"]
        approval.save_config("advance", enabled=False, actor="test")
        approval.clear_cache()
        r = self.term()
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        with on(date(2026, 10, 25)):
            body = self.client.get("/api/my/advances/eligibility", **self.me).json()
        self.assertFalse(body["workflowEnabled"])
        self.assertFalse(body["termLoan"]["canApply"])
        self.assertIn("switched off", body["termLoan"]["reason"])
        self.assertEqual(self.hr_put(pk, {"status": "approved"}).status_code, 200)


class RecordsTests(_Base):
    def test_records_show_deductions_and_what_is_left(self):
        pk = self.term(9000, 3).json()["id"]
        self.hr_put(pk, {"status": "approved"})
        first = AdvanceRepayment.objects.filter(advance_id=pk).order_by("year", "month").first()
        first.is_processed = True
        first.save()
        Advance.objects.filter(pk=pk).update(total_repaid=Decimal("3000"), outstanding=Decimal("6000"))
        with on(date(2026, 12, 25)):
            rows = self.client.get("/api/my/advances", **self.me).json()
        a = rows[0]
        self.assertEqual([s["state"] for s in a["schedule"]], ["deducted", "due", "upcoming"])
        self.assertEqual((a["deductedTotal"], a["balanceDue"]), (3000.0, 6000.0))
        self.assertEqual(a["nextDeduction"]["label"], "Dec 2026")
        self.assertEqual([e["kind"] for e in a["timeline"]], ["applied", "approved", "deducted"])
        self.assertEqual((a["typeLabel"], a["statusLabel"]), ("Term Loan", "Approved"))

    def test_eligibility_numbers(self):
        with on(date(2026, 12, 20)):
            body = self.client.get("/api/my/advances/eligibility", **self.me).json()
        self.assertEqual(body["monthlySalary"], 30000.0)
        self.assertEqual(
            (body["salaryAdvance"]["limit"], body["salaryAdvance"]["deductionLabel"]), (18000.0, "December 2026")
        )
        self.assertEqual(body["termLoan"]["firstDeductionLabel"], "January 2027")
        self.assertTrue(body["salaryAdvance"]["canApply"] and body["termLoan"]["canApply"])
        self.assertEqual(len(body["rules"]), 5)
