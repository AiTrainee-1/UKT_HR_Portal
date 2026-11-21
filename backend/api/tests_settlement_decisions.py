"""Settlement page, owner brief 2026-11-20: partial approval with a mandatory remark, rejection with a mandatory remark,
the requested amount kept for audit, the decision history, and only the APPROVED amount reaching payroll.

Run via: python manage.py test api.tests_settlement_decisions
"""

from decimal import Decimal

from django.test import TestCase

from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import Advance, AdvanceDecision, AdvanceRepayment, HRUser, SalarySlip
from .payroll_views import _generate_staff_payroll
from .tests_payroll_engine import MONTH, YEAR, _configure, _present_all, _staff

URL = "/api/advances"


def _token(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"}


class AdvanceDecisionTests(TestCase):
    def setUp(self):
        _configure(staff_pf_rules=[], staff_esi_rules=[], attendance_mode="simple")
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        _holiday_dates_for_month.cache_clear()
        self.admin = HRUser.objects.create(username="adv_admin", password_hash="x", is_super_admin=True)
        self.auth = _token(self.admin)
        self.emp = _staff(code="ADV1", salary="24000.00")

    def ask(self, amount="1000", kind="general", **extra) -> Advance:
        return Advance.objects.create(
            employee=self.emp, advance_type=kind, amount=Decimal(amount), requested_amount=Decimal(amount),
            outstanding=Decimal(amount), applied_by=Advance.APPLIED_BY_EMPLOYEE, **extra,
        )  # fmt: skip

    def put(self, adv, body):
        return self.client.put(f"{URL}/{adv.id}", body, content_type="application/json", **self.auth)

    def test_partial_approval_needs_a_remark_and_only_the_approved_amount_is_deducted(self):
        adv = self.ask("1000")
        body = {"status": "approved", "amount": 700, "repaymentStartMonth": MONTH, "repaymentStartYear": YEAR}
        res = self.put(adv, body)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "remark"))
        adv.refresh_from_db()
        self.assertEqual((adv.status, adv.amount), ("pending", Decimal("1000.00")))
        res = self.put(adv, {**body, "decisionRemark": "Budget limit this month"})
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertEqual((data["amount"], data["requestedAmount"]), (700.0, 1000.0))
        self.assertEqual(data["decisionRemark"], "Budget limit this month")
        self.assertEqual(data["scheduleMonths"], [f"{YEAR:04d}-{MONTH:02d}"])
        self.assertEqual(
            list(AdvanceRepayment.objects.filter(advance=adv).values_list("amount", flat=True)), [Decimal("700.00")]
        )
        history = data["history"]
        self.assertEqual(len(history), 1)
        self.assertEqual(
            (history[0]["action"], history[0]["requestedAmount"], history[0]["approvedAmount"], history[0]["remark"]),
            ("approved", 1000.0, 700.0, "Budget limit this month"),
        )
        # payroll deducts the approved 700 in the chosen month, never the 1,000 asked for
        _present_all(self.emp)
        _generate_staff_payroll(self.emp, MONTH, YEAR)
        slip = SalarySlip.objects.get(employee=self.emp, month=MONTH, year=YEAR)
        self.assertEqual(slip.advance_deduction, Decimal("700.00"))

    def test_full_approval_needs_no_remark(self):
        adv = self.ask("1000")
        res = self.put(adv, {"status": "approved", "repaymentStartMonth": MONTH, "repaymentStartYear": YEAR})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["history"][0]["remark"], "")

    def test_never_more_than_was_asked_for_even_when_hr_recorded_it(self):
        res = self.client.post(URL, {"employeeId": self.emp.id, "amount": 1500, "advanceType": "general"},
                               content_type="application/json", **self.auth)  # fmt: skip
        self.assertEqual(res.status_code, 201, res.content)
        adv = Advance.objects.get(pk=res.json()["id"])
        self.assertEqual(adv.requested_amount, Decimal("1500.00"))
        res = self.put(adv, {"status": "approved", "amount": 2000, "decisionRemark": "More"})
        self.assertEqual(res.status_code, 400)
        # an older HR-recorded advance (no requested amount stored) keeps its amount as the ceiling
        old = Advance.objects.create(employee=self.emp, advance_type="general", amount=Decimal("800"),
                                     outstanding=Decimal("800"))  # fmt: skip
        self.assertEqual(
            self.put(old, {"status": "approved", "amount": 900, "decisionRemark": "x" * 5}).status_code, 400
        )
        res = self.put(old, {"status": "approved", "amount": 600, "decisionRemark": "Part of it"})
        self.assertEqual(res.status_code, 200, res.content)
        old.refresh_from_db()
        self.assertEqual((old.requested_amount, old.amount), (Decimal("800.00"), Decimal("600.00")))

    def test_rejection_needs_a_remark_and_the_employee_sees_it(self):
        adv = self.ask("2000", kind="term", repayment_months=4)
        res = self.put(adv, {"status": "rejected"})
        self.assertEqual((res.status_code, res.json()["code"]), (400, "remark"))
        res = self.put(adv, {"status": "rejected", "decisionRemark": "Earlier loan still open"})
        self.assertEqual(res.status_code, 200, res.content)
        adv.refresh_from_db()
        self.assertEqual((adv.status, adv.decision_remark), ("rejected", "Earlier loan still open"))
        self.assertIsNotNone(adv.decided_at)
        self.assertFalse(AdvanceRepayment.objects.filter(advance=adv).exists())
        decision = AdvanceDecision.objects.get(advance=adv)
        self.assertEqual((decision.action, decision.remark), ("rejected", "Earlier loan still open"))
        from .mobile_settlement_views import timeline

        events = timeline(adv, adv.requested_amount, [])
        rejected = next(e for e in events if e["kind"] == "rejected")
        self.assertEqual(rejected["comment"], "Earlier loan still open")

    def test_term_loan_partial_approval_spreads_only_the_approved_amount(self):
        adv = self.ask("3000", kind="term", repayment_months=3)
        res = self.put(adv, {"status": "approved", "amount": 1500, "repaymentStartMonth": MONTH,
                             "repaymentStartYear": YEAR, "decisionRemark": "Half now"})  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        amounts = list(
            AdvanceRepayment.objects.filter(advance=adv).order_by("year", "month").values_list("amount", flat=True)
        )
        self.assertEqual(sum(amounts), Decimal("1500.00"))
        self.assertEqual(len(amounts), 3)
        listed = self.client.get(URL, **self.auth).json()
        row = next(r for r in listed if r["id"] == adv.id)
        self.assertEqual((row["amount"], row["requestedAmount"], row["decisionRemark"]), (1500.0, 3000.0, "Half now"))
        self.assertEqual(len(row["scheduleMonths"]), 3)
