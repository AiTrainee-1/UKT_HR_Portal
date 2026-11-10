"""
The mobile app's Salary and Compensation pages (mobile_pay_views.py):

    GET /api/my/salary-insights?year=YYYY
    GET /api/my/salary-slips/<id>/breakdown
    GET /api/my/compensation-history?year=YYYY

Payrolls are made by the REAL engine from manual day records (the worlds of tests_payroll_insights.py: February 2026,
24 working days, a salary of 24,000 = exactly 1,000 a day), so every figure is checked against what payroll STORED on the
SalarySlip / its breakdown / the Payroll row. Also pinned: employee token only, own data only, nothing written.

Run via: python manage.py test api.tests_mobile_pay -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    CompensationLedger,
    Employee,
    HolidayWorkClaim,
    HRUser,
    OvertimeRecord,
    Payroll,
    PayrollSettings,
    SalarySlip,
)
from .payroll_views import _generate_staff_payroll
from .tests_payroll_insights import MONTH, YEAR, _configure, _staff, production_world, staff_world

INSIGHTS = "/api/my/salary-insights"
HISTORY = "/api/my/compensation-history"
TODAY = date(2026, 10, 14)

_FROZEN = [
    patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31)),
    patch("api.mobile_pay_views.ist_today", return_value=TODAY),
]


def setUpModule():
    for p in _FROZEN:
        p.start()


def tearDownModule():
    for p in _FROZEN:
        p.stop()


def _as(emp) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _hr() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="pay_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _d(value) -> Decimal:
    return Decimal(str(value))


def _slip_of(payroll: Payroll) -> SalarySlip:
    if payroll.period_start:
        return SalarySlip.objects.get(
            employee=payroll.employee, period_start=payroll.period_start, period_end=payroll.period_end
        )
    return SalarySlip.objects.get(employee=payroll.employee, month=payroll.month, year=payroll.year, week_number=None)


class _Base(TestCase):
    def setUp(self):
        _holiday_dates_for_month.cache_clear()
        self.addCleanup(_holiday_dates_for_month.cache_clear)

    def get(self, url, headers, expect=200):
        res = self.client.get(url, **headers)
        self.assertEqual(res.status_code, expect, res.content[:400])
        return res.json()

    def assert_matches_stored(self, period: dict, slip: SalarySlip, payroll: Payroll | None):
        """Every money figure of a period equals what payroll stored."""
        bd = slip.breakdown_details or {}
        e, d = bd.get("earnings") or {}, bd.get("deductions") or {}
        self.assertEqual(period["slipId"], slip.id)
        self.assertEqual(_d(period["earnedGross"]), slip.gross_salary)
        self.assertEqual(_d(period["netPayable"]), slip.net_salary)
        self.assertEqual(_d(period["totalDeductions"]), slip.total_deductions)
        self.assertEqual(_d(period["otPay"]), slip.ot_amount)
        self.assertEqual(_d(period["pf"]), slip.pf_deduction)
        self.assertEqual(_d(period["esi"]), slip.esi_deduction)
        self.assertEqual(_d(period["tds"]), slip.tds_deduction)
        self.assertEqual(_d(period["advance"]), slip.advance_deduction)
        if period["kind"] == "staff" and e:
            self.assertEqual(_d(period["allocated"]), _d(e["monthlySalary"]))
            self.assertEqual(_d(period["absentLoss"]), _d(e["monthlySalary"]) - slip.gross_salary)
            self.assertEqual(_d(period["lateDeduction"]), _d(d["lateShiftPenalty"]))
            self.assertEqual(_d(period["permissionDeduction"]), _d(d["permissionPenalty"]))
            self.assertEqual(
                _d(period["lateDeduction"]) + _d(period["permissionDeduction"]) + _d(period["otherDeductions"]),
                slip.other_deductions,
            )
            self.assertEqual(period["counts"]["workingDays"], bd["summary"]["totalWorkingDays"])
            self.assertEqual(_d(period["counts"]["paidDays"]), _d(bd["summary"]["effectivePaidDays"]))
            self.assertEqual(_d(period["counts"]["dailyRate"]), _d(e["dailyRate"]))
        # the waterfall ends at the slip's own net pay and adds up to it
        self.assertEqual(period["steps"][-1]["key"], "net")
        self.assertEqual(_d(period["steps"][-1]["amount"]), slip.net_salary)
        self.assertTrue(period["reconciles"])
        if payroll is not None:
            self.assertEqual(period["payroll"]["status"], payroll.status)
            self.assertEqual(_d(period["payroll"]["net"]), payroll.final_salary)
            self.assertEqual(_d(period["payroll"]["bonus"]), payroll.bonus)


class StaffInsightsTests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.w = staff_world()
        cls.slip = _slip_of(cls.w.meena_payroll)

    def test_meena_every_figure_is_the_stored_one(self):
        data = self.get(f"{INSIGHTS}?year={YEAR}", _as(self.w.meena))
        self.assertEqual(data["year"], YEAR)
        self.assertEqual(data["years"], [YEAR])
        self.assertEqual(data["employmentType"], "staff")
        self.assertEqual(len(data["periods"]), 1)
        p = data["periods"][0]
        self.assert_matches_stored(p, self.slip, self.w.meena_payroll)
        # the world's documented figures: 21.25 days x 1,000 = 21,250 earned of 24,000, minus a 500 late deduction
        self.assertEqual(p["kind"], "staff")
        self.assertEqual(p["allocated"], 24000.0)
        self.assertEqual(p["earnedGross"], 21250.0)
        self.assertEqual(p["absentLoss"], 2750.0)
        self.assertEqual(p["lateDeduction"], 500.0)
        self.assertEqual(p["permissionDeduction"], 0.0)
        self.assertEqual(p["attendanceLoss"], 3250.0)
        self.assertEqual(p["netPayable"], 20750.0)
        self.assertEqual(p["period"]["label"], "February 2026")
        self.assertEqual(p["period"]["shortLabel"], "Feb")
        self.assertEqual(p["counts"]["workingDays"], 24)
        self.assertEqual(p["counts"]["paidDays"], 21.25)
        self.assertEqual(p["payroll"]["statusLabel"], "Not paid yet")
        self.assertTrue(p["payroll"]["matchesSlip"])
        keys = [s["key"] for s in p["steps"]]
        self.assertEqual(keys[:3], ["allocated", "absent_loss", "earned"])
        self.assertIn("late", keys)
        self.assertIn("permission", keys)
        absent = next(s for s in p["steps"] if s["key"] == "absent_loss")
        self.assertIn("21.25 of 24 days", absent["note"])
        perm = next(s for s in p["steps"] if s["key"] == "permission")
        self.assertIn("not charged separately", perm["note"])
        # the year summary is the sum of its periods
        s = data["summary"]
        self.assertEqual(s["periods"], 1)
        self.assertEqual(s["allocated"], 24000.0)
        self.assertEqual(s["netPayable"], 20750.0)
        self.assertEqual(s["attendanceLoss"], 3250.0)

    def test_breakdown_is_the_same_period(self):
        p = self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        self.assert_matches_stored(p, self.slip, self.w.meena_payroll)

    def test_full_attendance_loses_nothing(self):
        slip = _slip_of(self.w.anand_payroll)
        p = self.get(f"/api/my/salary-slips/{slip.id}/breakdown", _as(self.w.anand))
        self.assert_matches_stored(p, slip, self.w.anand_payroll)
        self.assertEqual(p["absentLoss"], 0.0)
        self.assertEqual(p["netPayable"], 24000.0)
        self.assertIn("all 24 days", p["steps"][1]["note"])

    def test_hr_change_after_the_slip_is_shown_not_merged(self):
        payroll = self.w.meena_payroll
        Payroll.objects.filter(pk=payroll.pk).update(bonus=Decimal("1000.00"), final_salary=Decimal("21750.00"))
        payroll.refresh_from_db()
        p = self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        self.assertEqual(p["netPayable"], 20750.0)  # the slip's own net pay
        self.assertEqual(p["payroll"]["bonus"], 1000.0)
        self.assertEqual(p["payroll"]["net"], 21750.0)
        self.assertFalse(p["payroll"]["matchesSlip"])
        self.assertTrue(p["payroll"]["hrChanged"])
        # only marked Cleared (and the saved net drifted): not an HR change the phone shows, and NOT paid either (owner
        # 2026-11-10: Cleared is HR's own check; the employee sees Paid only once the month was marked paid)
        Payroll.objects.filter(pk=payroll.pk).update(
            bonus=Decimal("0"), status="paid", final_salary=Decimal("20000.00")
        )
        p = self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        self.assertEqual((p["payroll"]["status"], p["payroll"]["statusLabel"]), ("pending", "Not paid yet"))
        self.assertFalse(p["payroll"]["hrChanged"])
        # Payroll > Mark as Paid (payroll_month_workflow.mark_paid) sets the payment status: now it is Paid
        Payroll.objects.filter(pk=payroll.pk).update(payment_status=Payroll.PAYMENT_PAID)
        p = self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        self.assertEqual((p["payroll"]["status"], p["payroll"]["statusLabel"]), ("paid", "Paid"))

    def test_read_only(self):
        before = (SalarySlip.objects.count(), Payroll.objects.count(), PayrollSettings.objects.count())
        with CaptureQueriesContext(connection) as ctx:
            self.get(f"{INSIGHTS}?year={YEAR}", _as(self.w.meena))
            self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        writes = [
            q["sql"]
            for q in ctx.captured_queries
            if q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        ]
        self.assertEqual(writes, [])
        self.assertEqual(before, (SalarySlip.objects.count(), Payroll.objects.count(), PayrollSettings.objects.count()))

    def test_access(self):
        # someone else's slip is not found, an HR token is refused, no token is refused, a bad year is a 400
        self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.anand), expect=404)
        self.get(f"{INSIGHTS}?year={YEAR}", _hr(), expect=403)
        self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _hr(), expect=403)
        res = self.client.get(f"{INSIGHTS}?year={YEAR}")
        self.assertIn(res.status_code, (401, 403))
        self.get(f"{INSIGHTS}?year=20x6", _as(self.w.meena), expect=400)
        # another employee's insights never include Meena's slip
        data = self.get(f"{INSIGHTS}?year={YEAR}", _as(self.w.anand))
        self.assertNotIn(self.slip.id, [p["slipId"] for p in data["periods"]])

    def test_default_year_is_the_latest_with_slips_and_empty_year_is_empty(self):
        data = self.get(INSIGHTS, _as(self.w.meena))
        self.assertEqual(data["year"], YEAR)
        empty = self.get(f"{INSIGHTS}?year=2025", _as(self.w.meena))
        self.assertEqual(empty["periods"], [])
        self.assertEqual(empty["summary"]["periods"], 0)
        self.assertIsNone(empty["summary"]["allocated"])


class PermissionPricingTests(_Base):
    """With Permission Deduction Slabs ON the permission deduction is its own stored figure and its own line."""

    @classmethod
    def setUpTestData(cls):
        cls.w = staff_world()
        _configure(
            permission_monthly_cap=0,
            permission_pricing_enabled=True,
            permission_free_allowance=0,
            permission_deduction_slabs=[{"fromPermissions": 1, "deductionShifts": 0.25}],
        )
        cls.payroll = _generate_staff_payroll(cls.w.meena, MONTH, YEAR)["payroll"]
        cls.slip = _slip_of(cls.payroll)

    def test_permission_deduction_is_the_stored_one(self):
        stored = _d(self.slip.breakdown_details["deductions"]["permissionPenalty"])
        self.assertGreater(stored, 0)
        p = self.get(f"/api/my/salary-slips/{self.slip.id}/breakdown", _as(self.w.meena))
        self.assert_matches_stored(p, self.slip, self.payroll)
        self.assertEqual(_d(p["permissionDeduction"]), stored)
        perm = next(s for s in p["steps"] if s["key"] == "permission")
        self.assertIn("charged", perm["note"])
        self.assertGreater(p["counts"]["permissionsCharged"], 0)


class ProductionInsightsTests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.w = production_world()
        cls.slip = _slip_of(cls.w.raja_payroll)

    def test_raja_weekly_period(self):
        data = self.get(f"{INSIGHTS}?year={YEAR}", _as(self.w.raja))
        self.assertEqual(data["employmentType"], "production")
        self.assertTrue(data["notes"])
        p = data["periods"][0]
        self.assert_matches_stored(p, self.slip, self.w.raja_payroll)
        self.assertEqual(p["kind"], "production")
        self.assertEqual(p["period"]["label"], "2 Feb - 8 Feb 2026")
        self.assertEqual(p["period"]["shortLabel"], "2-8 Feb")
        self.assertEqual(p["period"]["cycle"], "weekly")
        self.assertEqual(p["period"]["cycleLabel"], "Weekly")
        # no allocated salary, no loss for absent days, no permission deduction: null with a reason, never guessed
        for key in ("allocated", "absentLoss", "permissionDeduction"):
            self.assertIsNone(p[key])
        for key in ("allocated", "absentLoss", "permission"):
            self.assertTrue(p["notes"][key])
        self.assertEqual(p["earnedGross"], 3000.0)
        self.assertEqual(_d(p["lateDeduction"]), _d(self.slip.breakdown_details["deductions"]["lateShiftPenalty"]))
        self.assertEqual(p["lateDeduction"], 250.0)
        self.assertEqual(p["netPayable"], 2750.0)
        self.assertEqual(p["counts"]["totalShifts"], 6.0)
        self.assertEqual(p["counts"]["ratePerShift"], 500.0)
        self.assertEqual(p["steps"][0]["key"], "earned")
        self.assertIn("6 shifts", p["steps"][0]["note"])
        self.assertIsNone(data["summary"]["allocated"])
        self.assertEqual(data["summary"]["netPayable"], 2750.0)

    def test_late_detection_off_is_null_with_a_reason(self):
        _configure(prod_late_detection_enabled=False)
        from .payroll_views import _generate_production_payroll

        payroll = _generate_production_payroll(self.w.lakshmi, date(2026, 2, 9), date(2026, 2, 15), pay_cycle="weekly")[
            "payroll"
        ]
        slip = _slip_of(payroll)
        p = self.get(f"/api/my/salary-slips/{slip.id}/breakdown", _as(self.w.lakshmi))
        self.assertIsNone(p["lateDeduction"])
        self.assertIn("switched off", p["notes"]["late"])
        self.assertTrue(p["reconciles"])


class OlderSlipTests(_Base):
    """A slip from before the engine stored a breakdown: the columns only, late / permission not split out."""

    def test_no_breakdown(self):
        emp = _staff("S900", first="Old")
        slip = SalarySlip.objects.create(
            employee=emp,
            month=3,
            year=2025,
            slip_number="SS/S900/2025/03",
            basic=Decimal("10000"),
            gross_salary=Decimal("20000"),
            pf_deduction=Decimal("1200"),
            other_deductions=Decimal("300"),
            total_deductions=Decimal("1500"),
            net_salary=Decimal("18500"),
            working_days=26,
            present_days=Decimal("24"),
            absent_days=Decimal("2"),
        )
        p = self.get(f"/api/my/salary-slips/{slip.id}/breakdown", _as(emp))
        self.assertFalse(p["hasDetails"])
        self.assertIsNone(p["allocated"])
        self.assertIsNone(p["lateDeduction"])
        self.assertIsNone(p["permissionDeduction"])
        self.assertEqual(p["otherDeductions"], 300.0)
        self.assertEqual(p["netPayable"], 18500.0)
        self.assertTrue(p["notes"]["allocated"])
        self.assertTrue(p["notes"]["late"])
        self.assertTrue(p["reconciles"])
        self.assertIsNone(p["payroll"])


class CompensationHistoryTests(_Base):
    @classmethod
    def setUpTestData(cls):
        _configure(compensation_feature_enabled=True)
        cls.emp = _staff("S500", first="Kavya")
        cls.other = _staff("S501", first="Other")
        cls.prod = Employee.objects.create(
            employee_code="P500", first_name="Prod", last_name="X", employment_type="production", status="active"
        )
        e = cls.emp
        cls.allowance = OvertimeRecord.objects.create(
            employee=e,
            date=date(2026, 3, 2),
            last_punch_out=time(19, 0),
            ot_minutes=60,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        cls.pay = OvertimeRecord.objects.create(
            employee=e,
            date=date(2026, 3, 10),
            last_punch_out=time(23, 0),
            ot_minutes=300,
            status="announced",
            ot_type="shift",
            compensation_type="pay",
            shifts=Decimal("0.50"),
            suggested_shifts=Decimal("0.50"),
        )
        cls.relax = OvertimeRecord.objects.create(
            employee=e,
            date=date(2026, 4, 7),
            last_punch_out=time(23, 30),
            ot_minutes=330,
            status="announced",
            ot_type="shift",
            compensation_type="relaxation",
            shifts=Decimal("0.75"),
        )
        CompensationLedger.objects.create(
            employee=e,
            entry_type="credit",
            shifts=Decimal("0.75"),
            date=date(2026, 4, 7),
            source="ot_shift",
            overtime_record=cls.relax,
        )
        claim = HolidayWorkClaim.objects.create(
            employee=e, work_date=date(2026, 5, 3), shifts=Decimal("1.00"), status="approved", reviewed_by="Head"
        )
        CompensationLedger.objects.create(
            employee=e,
            entry_type="credit",
            shifts=Decimal("1.00"),
            date=date(2026, 5, 3),
            source="holiday_work",
            claim=claim,
        )
        CompensationLedger.objects.create(
            employee=e, entry_type="debit", shifts=Decimal("0.50"), date=date(2026, 6, 12), source="redemption"
        )
        legacy = OvertimeRecord.objects.create(
            employee=e,
            date=date(2026, 1, 20),
            last_punch_out=time(21, 0),
            ot_minutes=180,
            status="announced",
            ot_type="legacy",
            compensation_type="relaxation",
        )
        CompensationLeaveCredit.objects.create(employee=e, source_overtime_record=legacy)
        CompensationDayAnnouncement.objects.create(
            date=date(2026, 8, 15), leave_until_time=time(13, 0), reason="Festival", announced_by="HR"
        )
        # an old year's record: never listed under 2026
        OvertimeRecord.objects.create(
            employee=e,
            date=date(2025, 12, 1),
            last_punch_out=time(23, 0),
            ot_minutes=300,
            status="announced",
            ot_type="shift",
            compensation_type="pay",
            shifts=Decimal("1.00"),
        )
        cls.slip = SalarySlip.objects.create(
            employee=e,
            month=3,
            year=2026,
            slip_number="SS/S500/2026/03",
            gross_salary=Decimal("20000"),
            ot_amount=Decimal("384.62"),
            net_salary=Decimal("20384.62"),
            breakdown_details={"type": "staff", "earnings": {"otShifts": 0.5, "dailyRate": 769.23}},
        )

    def test_every_kind_with_who_gave_it(self):
        data = self.get(f"{HISTORY}?year=2026", _as(self.emp))
        self.assertTrue(data["isStaff"])
        self.assertIn(2025, data["years"])
        self.assertIn(2026, data["years"])
        by_kind = {}
        for item in data["items"]:
            by_kind.setdefault(item["kind"], []).append(item)
            self.assertTrue(item["date"].startswith("2026-"))
            self.assertEqual(item["month"], item["date"][:7])
        for kind in (
            "ot_allowance",
            "ot_shift_pay",
            "ot_shift_relaxation",
            "holiday_work",
            "redemption",
            "balance_credit",
            "alternative_day",
            "compensation_day",
        ):
            self.assertIn(kind, by_kind, kind)
        self.assertEqual(by_kind["ot_allowance"][0]["source"], "automatic")
        self.assertFalse(by_kind["ot_allowance"][0]["givenByHr"])
        for kind in ("ot_shift_pay", "ot_shift_relaxation", "holiday_work", "balance_credit", "alternative_day"):
            self.assertEqual(by_kind[kind][0]["sourceLabel"], "Given by HR", kind)
            self.assertTrue(by_kind[kind][0]["givenByHr"])
        self.assertEqual(by_kind["compensation_day"][0]["source"], "company")
        self.assertEqual(by_kind["compensation_day"][0]["time"], "13:00")
        self.assertEqual(by_kind["alternative_day"][0]["statusLabel"], "Available")
        # the holiday-work credit is the claim itself, not listed twice
        self.assertEqual(len(by_kind["balance_credit"]), 1)
        # the OT pay March's slip paid, as stored
        self.assertEqual(
            data["otPayByMonth"],
            [{"month": "2026-03", "label": "March 2026", "amount": 384.62, "shifts": 0.5, "slipId": self.slip.id}],
        )
        self.assertEqual(data["totals"]["otPay"], 384.62)
        # the balance: 0.75 + 1.00 credited, 0.50 taken, plus one available alternative day
        self.assertEqual(data["balance"]["creditedThisYear"], 1.75)
        self.assertEqual(data["balance"]["takenThisYear"], 0.5)
        self.assertEqual(data["balance"]["alternativeDaysAvailable"], 1)
        self.assertEqual(data["balance"]["shifts"], 2.25)
        # 0.50 pay + 0.75 relaxation + 1.00 holiday work + the earlier (legacy) relaxation, which counts one shift; the
        # balance credits / alternative day those created are listed but not counted again
        self.assertEqual(data["totals"]["shiftsGivenByHr"], 3.25)

    def test_other_years_and_people(self):
        old = self.get(f"{HISTORY}?year=2025", _as(self.emp))
        self.assertEqual([i["kind"] for i in old["items"]], ["ot_shift_pay"])
        self.assertEqual(self.get(f"{HISTORY}?year=2026", _as(self.other))["items"][0]["kind"], "compensation_day")

    def test_production_and_hr_and_read_only(self):
        prod = self.get(f"{HISTORY}?year=2026", _as(self.prod))
        self.assertFalse(prod["isStaff"])
        self.assertEqual(prod["items"], [])
        self.assertTrue(prod["message"])
        self.get(HISTORY, _hr(), expect=403)
        self.get(f"{HISTORY}?year=abc", _as(self.emp), expect=400)
        with CaptureQueriesContext(connection) as ctx:
            self.get(f"{HISTORY}?year=2026", _as(self.emp))
        writes = [
            q["sql"]
            for q in ctx.captured_queries
            if q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        ]
        # CompensationConfig.get() may create its singleton row on a fresh database; nothing else is ever written
        self.assertTrue(all("compensation_config" in sql for sql in writes), writes)


class DaysNoteTests(TestCase):
    """The sentence under "What you lost" (owner 2026-11-04: a staff month is out of the company month, holidays paid)."""

    def test_a_new_payroll_counts_the_company_month_and_names_the_paid_holidays(self):
        from .mobile_pay import _days_note

        new = {"workingDays": 27, "holidayDays": 2, "paidDays": 25, "absentDays": 2, "dailyRate": 1000.0}
        self.assertEqual(
            _days_note(new),
            "You were paid for 25 of 27 days (2 absent days, 2 holidays paid). One day is worth ₹1,000.",
        )
        self.assertEqual(
            _days_note({**new, "paidDays": 27, "absentDays": 0}), "You were paid for all 27 days: nothing was lost."
        )
        # an older payroll keeps its own words
        old = {"workingDays": 25, "holidayDays": None, "paidDays": 23, "absentDays": 2, "dailyRate": 1080.0}
        self.assertEqual(
            _days_note(old), "You were paid for 23 of 25 working days (2 absent days). One day is worth ₹1,080."
        )
