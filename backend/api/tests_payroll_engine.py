"""
Payroll engine and endpoints -the highest-stakes code in the system.

Attendance is fed in as manual AttendanceDayRecord rows (authoritative, see
attendance_final.compute_day_record) so every expected figure below is plain
arithmetic rather than a re-run of the punch classifier.

Calendar used throughout: February 2026 -it starts on a Sunday, so it has
exactly 24 Mon-Sat working days. A salary of 24,000 therefore has a daily
rate of exactly 1,000, and every figure can be checked by hand.

Two tests are marked expectedFailure. They pin real defects found while
writing this suite (see the comments on each); they turn into "unexpected
success" the day the defect is fixed, which is the cue to drop the marker.

Run via: python manage.py test api.tests_payroll_engine -v 2
"""

import unittest
from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase

from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Branch,
    Employee,
    EmployeePermission,
    Holiday,
    HRUser,
    OvertimeRecord,
    Payroll,
    PayrollSettings,
    Role,
    SalarySlip,
)
from .payroll_views import (
    PayrollSkip,
    _build_working_days,
    _compute_hours,
    _d2,
    _generate_production_payroll,
    _generate_staff_payroll,
    _session_completed,
    late_shift_deduction,
)

MONTH, YEAR = 2, 2026
WORKING_DAYS = _build_working_days(MONTH, YEAR, False, set())


def _hr(branch=None, super_admin=True):
    if super_admin:
        admin, _ = HRUser.objects.get_or_create(
            username="pay_admin",
            defaults={"password_hash": "x", "is_super_admin": True},
        )
    else:
        role, _ = Role.objects.get_or_create(name="Payroll Officer", defaults={"permissions": {"payroll": "edit"}})
        admin, _ = HRUser.objects.get_or_create(
            username=f"pay_officer_{branch.id}",
            defaults={"password_hash": "x", "role": role, "branch": branch},
        )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}


def _configure(**fields) -> PayrollSettings:
    ps = PayrollSettings.get()
    for k, v in fields.items():
        setattr(ps, k, v)
    ps.save()
    return ps


def _staff(code="PAY_S", salary="24000.00", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        salary_type="monthly",
        salary_amount=Decimal(salary),
        **kw,
    )


def _production(code="PAY_P", per_shift="500.00", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Prod",
        employment_type="production",
        status="active",
        salary_per_shift=Decimal(per_shift),
        **kw,
    )


def _day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"),
        source="manual",
        **kw,
    )


def _present_all(emp, days=None, **kw):
    for d in days if days is not None else WORKING_DAYS:
        _day(emp, d, **kw)


def _breakdown(emp):
    return SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR).breakdown_details


# ─────────────────────────────────────────────────────────────────────────────
#  Pure helpers
# ─────────────────────────────────────────────────────────────────────────────


class RoundingAndHoursTests(TestCase):
    def test_d2_rounds_half_up_not_bankers(self):
        self.assertEqual(_d2("2.675"), Decimal("2.68"))
        self.assertEqual(_d2("2.665"), Decimal("2.67"))
        self.assertEqual(_d2(0.125), Decimal("0.13"))
        self.assertEqual(_d2(10), Decimal("10.00"))

    def test_compute_hours_same_day(self):
        self.assertEqual(_compute_hours(time(9, 0), time(17, 30)), Decimal("8.50"))

    def test_compute_hours_crosses_midnight(self):
        self.assertEqual(_compute_hours(time(22, 0), time(6, 0)), Decimal("8.00"))

    def test_session_completed_needs_to_span_the_cutoff(self):
        cutoff = time(12, 40)
        self.assertTrue(_session_completed(time(9, 0), time(13, 0), cutoff))
        self.assertTrue(_session_completed(time(12, 40), time(12, 40), cutoff))  # boundaries count
        self.assertFalse(_session_completed(time(12, 41), time(15, 0), cutoff))  # arrived after
        self.assertFalse(_session_completed(time(9, 0), time(12, 39), cutoff))  # left before
        self.assertFalse(_session_completed(time(9, 0), None, cutoff))  # never punched out


class WorkingDayCalendarTests(TestCase):
    def test_sundays_are_never_working_days(self):
        days = _build_working_days(MONTH, YEAR, False, set())
        self.assertEqual(len(days), 24)
        self.assertNotIn(6, {d.weekday() for d in days})

    def test_saturday_off_removes_every_saturday(self):
        days = _build_working_days(MONTH, YEAR, True, set())
        self.assertEqual(len(days), 20)  # Feb 2026 has 4 Saturdays
        self.assertNotIn(5, {d.weekday() for d in days})

    def test_holidays_are_removed_but_a_sunday_holiday_costs_nothing_extra(self):
        days = _build_working_days(MONTH, YEAR, False, {date(2026, 2, 10), date(2026, 2, 8)})
        self.assertEqual(len(days), 23)  # Feb 8 is a Sunday, already excluded
        self.assertNotIn(date(2026, 2, 10), days)

    def test_leap_february(self):
        self.assertEqual(len(_build_working_days(2, 2028, False, set())), 25)


class LateDeductionSlabTests(TestCase):
    def _s(self, rows, field="late_deduction_slabs"):
        return SimpleNamespace(**{field: rows})

    def test_empty_table_means_no_deduction(self):
        self.assertEqual(late_shift_deduction(50, self._s([])), Decimal("0"))
        self.assertEqual(late_shift_deduction(50, self._s(None)), Decimal("0"))

    def test_below_first_threshold_is_free(self):
        s = self._s([{"fromLates": 3, "deductionShifts": 0.25}])
        self.assertEqual(late_shift_deduction(2, s), Decimal("0"))

    def test_threshold_is_inclusive_and_highest_match_wins(self):
        s = self._s(
            [
                {"fromLates": 1, "deductionShifts": 0.5},
                {"fromLates": 4, "deductionShifts": 1},
                {"fromLates": 8, "deductionShifts": 2},
            ]
        )
        self.assertEqual(late_shift_deduction(1, s), Decimal("0.5"))
        self.assertEqual(late_shift_deduction(3, s), Decimal("0.5"))
        self.assertEqual(late_shift_deduction(4, s), Decimal("1"))
        self.assertEqual(late_shift_deduction(7, s), Decimal("1"))
        self.assertEqual(late_shift_deduction(8, s), Decimal("2"))

    def test_last_row_holds_beyond_the_table(self):
        s = self._s([{"fromLates": 1, "deductionShifts": 1}])
        self.assertEqual(late_shift_deduction(500, s), Decimal("1"))

    def test_rows_may_be_stored_unsorted(self):
        s = self._s([{"fromLates": 8, "deductionShifts": 2}, {"fromLates": 1, "deductionShifts": 0.5}])
        self.assertEqual(late_shift_deduction(5, s), Decimal("0.5"))
        self.assertEqual(late_shift_deduction(9, s), Decimal("2"))

    def test_malformed_rows_are_skipped_not_fatal(self):
        s = self._s(
            [
                "garbage",
                {"fromLates": "x", "deductionShifts": 1},
                {"deductionShifts": 1},
                {"fromLates": 2, "deductionShifts": "bad"},
                {"fromLates": 2, "deductionShifts": 0.5},
            ]
        )
        self.assertEqual(late_shift_deduction(2, s), Decimal("0.5"))

    def test_slabs_field_selects_the_pool(self):
        s = SimpleNamespace(
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 1}],
            without_permission_deduction_slabs=[{"fromLates": 1, "deductionShifts": 3}],
        )
        self.assertEqual(late_shift_deduction(1, s), Decimal("1"))
        self.assertEqual(late_shift_deduction(1, s, slabs_field="without_permission_deduction_slabs"), Decimal("3"))

    def test_shipped_default_is_a_quarter_shift_per_three_lates(self):
        ps = PayrollSettings.get()
        self.assertEqual(late_shift_deduction(2, ps), Decimal("0"))
        self.assertEqual(late_shift_deduction(3, ps), Decimal("0.25"))
        self.assertEqual(late_shift_deduction(5, ps), Decimal("0.25"))
        self.assertEqual(late_shift_deduction(6, ps), Decimal("0.5"))


# ─────────────────────────────────────────────────────────────────────────────
#  Staff engine
# ─────────────────────────────────────────────────────────────────────────────


class StaffPayrollTests(TestCase):
    def setUp(self):
        # Rules off, no lates penalised, unless a test opts in.
        _configure(
            staff_payroll_rules_enabled=False,
            pf_rate=Decimal("12"),
            esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"),
            late_free_allowance=3,
            late_deduction_slabs=[],
            without_permission_free_allowance=0,
            without_permission_deduction_slabs=[],
            attendance_mode="simple",
            compensation_feature_enabled=True,
        )

    def _run(self, emp):
        return _generate_staff_payroll(emp, MONTH, YEAR)

    # ── eligibility ────────────────────────────────────────────────────────
    def test_skipped_without_a_salary(self):
        emp = _staff(salary="0")
        with self.assertRaisesMessage(PayrollSkip, "No Salary Amount"):
            self._run(emp)
        self.assertFalse(Payroll.objects.exists())

    # ── pro-rata ───────────────────────────────────────────────────────────
    def test_full_attendance_pays_exactly_the_salary(self):
        emp = _staff()
        _present_all(emp)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.total_working_days, 24)
        self.assertEqual(p.gross_salary, Decimal("24000.00"))
        self.assertEqual(p.deductions, Decimal("0.00"))
        self.assertEqual(p.final_salary, Decimal("24000.00"))
        self.assertEqual(p.salary_mode, "monthly")
        self.assertEqual(p.status, "pending")

    def test_odd_working_day_count_does_not_lose_paise(self):
        # 8000 / 26 = 307.6923...: rounding the daily rate first used to make
        # a fully present employee's gross 7999.94.
        Holiday.objects.create(name="H1", date=date(2026, 2, 3))
        Holiday.objects.create(name="H2", date=date(2026, 2, 4))
        _holiday_dates_for_month.cache_clear()
        emp = _staff(salary="23000.00")
        days = _build_working_days(MONTH, YEAR, False, {date(2026, 2, 3), date(2026, 2, 4)})
        _present_all(emp, days)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.total_working_days, 22)
        self.assertEqual(p.gross_salary, Decimal("23000.00"))

    def test_partial_attendance_is_prorated_by_working_days(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:18])
        for d in WORKING_DAYS[18:]:
            _day(emp, d, "absent", "0")
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("18000.00"))
        self.assertEqual(p.final_salary, Decimal("18000.00"))
        self.assertEqual(p.absent_days, Decimal("6.0"))

    def test_days_with_no_record_count_as_absent(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:12])
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("12000.00"))

    def test_half_shift_days_pay_half(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:22])
        for d in WORKING_DAYS[22:]:
            _day(emp, d, "half_shift", "0.50")
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("23000.00"))
        summary = _breakdown(emp)["summary"]
        self.assertEqual((summary["fullShiftDays"], summary["halfShiftDays"]), (22, 2))
        self.assertEqual(summary["effectivePaidDays"], 23.0)

    def test_leave_request_days_are_unpaid_but_labelled_as_leave(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:20])
        for d in WORKING_DAYS[20:]:
            _day(emp, d, "on_leave", "0")
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("20000.00"))
        summary = _breakdown(emp)["summary"]
        self.assertEqual((summary["unpaidLeaveDays"], summary["absentDays"]), (4, 0))

    def test_holiday_status_days_are_paid(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:22])
        for d in WORKING_DAYS[22:]:
            _day(emp, d, "holiday", "0")
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("24000.00"))
        self.assertEqual(_breakdown(emp)["summary"]["paidLeaveDays"], 2)

    def test_public_holiday_shrinks_the_month_and_raises_the_daily_rate(self):
        Holiday.objects.create(name="Founders Day", date=date(2026, 2, 10))
        _holiday_dates_for_month.cache_clear()
        emp = _staff(salary="23000.00")
        days = _build_working_days(MONTH, YEAR, False, {date(2026, 2, 10)})
        _present_all(emp, days[:11])  # half of 23 working days = 11.5, so use 11
        p = self._run(emp)["payroll"]
        self.assertEqual(p.total_working_days, 23)
        self.assertEqual(p.gross_salary, Decimal("11000.00"))  # 11 x (23000/23)

    # ── PF / ESI ───────────────────────────────────────────────────────────
    def test_no_statutory_deductions_while_the_master_toggle_is_off(self):
        _configure(staff_payroll_rules_enabled=False)
        emp = _staff(salary="20400.00")
        _present_all(emp)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("0.00"))
        self.assertEqual(p.final_salary, Decimal("20400.00"))

    def test_pf_is_a_percentage_of_basic_and_esi_of_gross_when_under_the_ceiling(self):
        _configure(staff_payroll_rules_enabled=True)
        emp = _staff(salary="20400.00")
        _present_all(emp)
        p = self._run(emp)["payroll"]
        # basic = 50% of 20400 = 10200 -> PF 12% = 1224.00; ESI 0.75% of 20400 = 153.00
        slip = SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)
        self.assertEqual(slip.basic, Decimal("10200.00"))
        self.assertEqual(slip.pf_deduction, Decimal("1224.00"))
        self.assertEqual(slip.esi_deduction, Decimal("153.00"))
        self.assertEqual(p.deductions, Decimal("1377.00"))
        self.assertEqual(p.final_salary, Decimal("19023.00"))

    def test_esi_does_not_apply_above_the_ceiling_but_pf_still_does(self):
        _configure(staff_payroll_rules_enabled=True)
        emp = _staff(salary="24000.00")
        _present_all(emp)
        self._run(emp)
        slip = SalarySlip.objects.get(employee=emp)
        self.assertEqual(slip.esi_deduction, Decimal("0.00"))
        self.assertEqual(slip.pf_deduction, Decimal("1440.00"))  # 12% of 12000

    def test_esi_ceiling_is_inclusive(self):
        # The field's help text says "below", the code uses <=. Pinned as-is:
        # an employee on exactly the ceiling IS charged ESI.
        _configure(staff_payroll_rules_enabled=True, esi_applicable_below=Decimal("24000"))
        emp = _staff(salary="24000.00")
        _present_all(emp)
        self._run(emp)
        self.assertEqual(SalarySlip.objects.get(employee=emp).esi_deduction, Decimal("180.00"))

    def test_esi_eligibility_uses_full_salary_not_the_prorated_amount(self):
        # 30000 salary, half the month worked: prorated gross 15000 is under the
        # 21000 ceiling, but the employee's salary is not, so no ESI.
        _configure(staff_payroll_rules_enabled=True)
        emp = _staff(salary="30000.00")
        _present_all(emp, WORKING_DAYS[:12])
        self._run(emp)
        self.assertEqual(SalarySlip.objects.get(employee=emp).esi_deduction, Decimal("0.00"))

    def test_pf_is_prorated_with_attendance(self):
        _configure(staff_payroll_rules_enabled=True)
        emp = _staff(salary="24000.00")
        _present_all(emp, WORKING_DAYS[:12])
        self._run(emp)
        slip = SalarySlip.objects.get(employee=emp)
        self.assertEqual(slip.basic, Decimal("6000.00"))
        self.assertEqual(slip.pf_deduction, Decimal("720.00"))

    def test_zero_rates_deduct_nothing_even_with_rules_on(self):
        _configure(staff_payroll_rules_enabled=True, pf_rate=Decimal("0"), esi_rate=Decimal("0"))
        emp = _staff(salary="20000.00")
        _present_all(emp)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("0.00"))

    # ── late penalties ─────────────────────────────────────────────────────
    def _late_days(self, emp, n):
        for d in WORKING_DAYS[:n]:
            _day(emp, d, is_late=True)
        for d in WORKING_DAYS[n:]:
            _day(emp, d)

    def test_lates_within_the_free_allowance_cost_nothing(self):
        _configure(late_free_allowance=3, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 1}])
        emp = _staff()
        self._late_days(emp, 3)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("0.00"))

    def test_billable_lates_map_through_the_slab_table_to_shifts_of_pay(self):
        _configure(
            late_free_allowance=3,
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}, {"fromLates": 4, "deductionShifts": 1}],
        )
        emp = _staff()
        self._late_days(emp, 5)  # 2 billable -> 0.5 shift -> 500
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("500.00"))
        self.assertEqual(p.final_salary, Decimal("23500.00"))
        lateness = _breakdown(emp)["deductions"]["lateSummary"]
        self.assertEqual((lateness["totalLateCount"], lateness["billableLateCount"]), (5, 2))

    def test_approved_permissions_join_the_same_late_pool(self):
        _configure(late_free_allowance=3, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}])
        emp = _staff()
        self._late_days(emp, 2)
        for day in (2, 3, 4):
            EmployeePermission.objects.create(employee=emp, date=date(2026, 2, day), status="approved")
        # A pending and a rejected permission must not count.
        EmployeePermission.objects.create(employee=emp, date=date(2026, 2, 5), status="pending")
        EmployeePermission.objects.create(employee=emp, date=date(2026, 2, 6), status="rejected")
        p = self._run(emp)["payroll"]
        # 2 lates + 3 permissions = 5, minus 3 free = 2 billable -> 0.5 shift
        self.assertEqual(p.deductions, Decimal("500.00"))

    def test_empty_slab_table_switches_the_penalty_off(self):
        _configure(late_free_allowance=0, late_deduction_slabs=[])
        emp = _staff()
        self._late_days(emp, 10)
        self.assertEqual(self._run(emp)["payroll"].deductions, Decimal("0.00"))

    def test_without_permission_is_a_separate_pool(self):
        _configure(
            late_free_allowance=3,
            late_deduction_slabs=[],
            without_permission_free_allowance=0,
            without_permission_deduction_slabs=[{"fromLates": 2, "deductionShifts": 1}],
        )
        emp = _staff()
        for d in WORKING_DAYS[:2]:
            _day(emp, d, is_late=True, late_in_without_permission=True)
        for d in WORKING_DAYS[2:]:
            _day(emp, d)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("1000.00"))
        self.assertEqual(_breakdown(emp)["deductions"]["withoutPermissionPenalty"], 1000.0)

    # ── advances ───────────────────────────────────────────────────────────
    def _advance(self, emp, amount, repayments):
        adv = Advance.objects.create(
            employee=emp,
            advance_type="salary",
            amount=Decimal(amount),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal(amount),
        )
        for m, amt in repayments:
            AdvanceRepayment.objects.create(advance=adv, month=m, year=YEAR, amount=Decimal(amt))
        return adv

    def test_this_months_advance_repayment_is_deducted(self):
        emp = _staff()
        _present_all(emp)
        self._advance(emp, "5000.00", [(2, "2000.00"), (3, "3000.00")])
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("2000.00"))  # March's instalment is left alone
        self.assertEqual(p.final_salary, Decimal("22000.00"))

    def test_deducted_repayment_is_marked_processed_and_the_advance_updated(self):
        emp = _staff()
        _present_all(emp)
        adv = self._advance(emp, "5000.00", [(2, "2000.00"), (3, "3000.00")])
        self._run(emp)
        adv.refresh_from_db()
        self.assertEqual(adv.total_repaid, Decimal("2000.00"))
        self.assertEqual(adv.outstanding, Decimal("3000.00"))
        self.assertEqual(adv.status, "approved")
        self.assertTrue(AdvanceRepayment.objects.get(advance=adv, month=2).is_processed)
        self.assertFalse(AdvanceRepayment.objects.get(advance=adv, month=3).is_processed)

    def test_final_repayment_closes_the_advance(self):
        emp = _staff()
        _present_all(emp)
        adv = self._advance(emp, "2000.00", [(2, "2000.00")])
        self._run(emp)
        adv.refresh_from_db()
        self.assertEqual((adv.outstanding, adv.status), (Decimal("0.00"), "closed"))

    def test_someone_elses_advance_is_never_deducted(self):
        emp, other = _staff(), _staff("PAY_S2")
        _present_all(emp)
        self._advance(other, "5000.00", [(2, "2000.00")])
        self.assertEqual(self._run(emp)["payroll"].deductions, Decimal("0.00"))

    # ── overtime ───────────────────────────────────────────────────────────
    def _ot(self, emp, day, **kw):
        defaults = dict(
            last_punch_out=time(20, 0),
            ot_minutes=120,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_PAY,
        )
        defaults.update(kw)
        return OvertimeRecord.objects.create(employee=emp, date=day, **defaults)

    def test_announced_pay_ot_adds_a_days_salary_each(self):
        emp = _staff()
        _present_all(emp)
        self._ot(emp, date(2026, 2, 2))
        self._ot(emp, date(2026, 2, 3))
        p = self._run(emp)["payroll"]
        self.assertEqual(p.ot_amount, Decimal("2000.00"))
        self.assertEqual(p.gross_salary, Decimal("24000.00"))  # OT is kept out of gross
        self.assertEqual(p.final_salary, Decimal("26000.00"))

    def test_only_announced_pay_ot_in_this_month_counts(self):
        emp = _staff()
        _present_all(emp)
        self._ot(emp, date(2026, 2, 2), status=OvertimeRecord.STATUS_DETECTED)
        self._ot(emp, date(2026, 2, 3), compensation_type=OvertimeRecord.TYPE_RELAXATION)
        self._ot(emp, date(2026, 2, 4), status=OvertimeRecord.STATUS_REJECTED)
        self._ot(emp, date(2026, 3, 2))
        self.assertEqual(self._run(emp)["payroll"].ot_amount, Decimal("0.00"))

    def test_ot_is_ignored_when_the_compensation_feature_is_off(self):
        _configure(compensation_feature_enabled=False)
        emp = _staff()
        _present_all(emp)
        self._ot(emp, date(2026, 2, 2))
        p = self._run(emp)["payroll"]
        self.assertEqual((p.ot_amount, p.final_salary), (Decimal("0.00"), Decimal("24000.00")))

    # ── regeneration ───────────────────────────────────────────────────────
    def test_regenerating_updates_in_place_rather_than_duplicating(self):
        emp = _staff()
        _present_all(emp, WORKING_DAYS[:12])
        self._run(emp)
        # The first run stored auto rows for the empty days; HR now corrects them.
        AttendanceDayRecord.objects.filter(employee=emp, date__in=WORKING_DAYS[12:]).update(
            status="present",
            shifts_earned=Decimal("1.00"),
            source="manual",
        )
        self._run(emp)
        self.assertEqual(Payroll.objects.filter(employee=emp).count(), 1)
        self.assertEqual(SalarySlip.objects.filter(employee=emp).count(), 1)
        self.assertEqual(Payroll.objects.get(employee=emp).gross_salary, Decimal("24000.00"))

    def test_slip_number_and_breakdown_are_stored(self):
        emp = _staff()
        _present_all(emp)
        self._run(emp)
        slip = SalarySlip.objects.get(employee=emp)
        self.assertEqual(slip.slip_number, "SS/PAY_S/2026/02")
        b = slip.breakdown_details
        self.assertEqual(b["type"], "staff")
        self.assertEqual(len(b["days"]), 24)
        self.assertEqual(b["earnings"]["grossSalary"], 24000.0)
        self.assertEqual(b["netSalary"], 24000.0)

    @unittest.expectedFailure
    def test_regeneration_keeps_the_advance_deduction(self):
        # KNOWN DEFECT. Generation marks the month's repayments processed, and
        # the lookup only takes unprocessed ones, so re-running the same month
        # (e.g. after correcting an attendance record) finds nothing to deduct:
        # the slip's advance deduction silently drops to 0 and net pay goes up
        # by the instalment. Expected: the second run still deducts 2000.
        emp = _staff()
        _present_all(emp)
        self._advance(emp, "5000.00", [(2, "2000.00")])
        self._run(emp)
        again = self._run(emp)["payroll"]
        self.assertEqual(again.deductions, Decimal("2000.00"))


# ─────────────────────────────────────────────────────────────────────────────
#  Production engine
# ─────────────────────────────────────────────────────────────────────────────


class ProductionPayrollTests(TestCase):
    START, END = date(2026, 2, 2), date(2026, 2, 11)  # 10 days, Mon-Wed of the next week

    def setUp(self):
        _configure(
            prod_payroll_rules_enabled=False,
            prod_pf_rate=Decimal("12"),
            prod_esi_rate=Decimal("0.75"),
            prod_esi_applicable_below=Decimal("21000"),
            prod_pf_ef_enabled=False,
            prod_pf_ef_rules=[],
            prod_late_detection_enabled=False,
        )

    def _run(self, emp):
        return _generate_production_payroll(emp, self.START, self.END)

    def _work(self, emp, full=5, one_and_half=5):
        d = self.START
        from datetime import timedelta

        for _ in range(one_and_half):
            _day(emp, d, shifts="1.50")
            d += timedelta(days=1)
        for _ in range(full):
            _day(emp, d, shifts="1.00")
            d += timedelta(days=1)

    def test_skipped_without_a_rate_per_shift(self):
        emp = _production(per_shift="0")
        with self.assertRaisesMessage(PayrollSkip, "No Salary Per Shift"):
            self._run(emp)

    def test_pay_is_total_shifts_times_rate(self):
        emp = _production()
        self._work(emp)  # 5 x 1.5 + 5 x 1.0 = 12.5 shifts
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("6250.00"))
        self.assertEqual(p.final_salary, Decimal("6250.00"))
        self.assertEqual(p.salary_mode, "shift")
        self.assertEqual((p.period_start, p.period_end), (self.START, self.END))
        self.assertEqual(p.present_days, Decimal("12.5"))

    def test_absent_days_earn_nothing(self):
        emp = _production()
        self._work(emp, full=3, one_and_half=0)
        p = self._run(emp)["payroll"]
        self.assertEqual(p.gross_salary, Decimal("1500.00"))
        self.assertEqual(p.absent_days, Decimal("7.0"))

    def test_no_deductions_while_the_master_toggle_is_off(self):
        emp = _production()
        self._work(emp)
        self.assertEqual(self._run(emp)["payroll"].deductions, Decimal("0.00"))

    def test_flat_rates_apply_when_the_master_toggle_is_on(self):
        _configure(prod_payroll_rules_enabled=True)
        emp = _production()
        self._work(emp)  # gross 6250 -> monthly equivalent 12500, under the 21000 ceiling
        p = self._run(emp)["payroll"]
        slip = SalarySlip.objects.get(employee=emp)
        self.assertEqual(slip.pf_deduction, Decimal("750.00"))
        self.assertEqual(slip.esi_deduction, Decimal("46.88"))  # 46.875 rounds half up
        self.assertEqual(p.final_salary, Decimal("5453.12"))

    def test_flat_esi_is_skipped_above_the_ceiling_using_the_monthly_equivalent(self):
        _configure(prod_payroll_rules_enabled=True)
        emp = _production(per_shift="1000.00")
        self._work(emp)  # 12.5 shifts = 12500 -> monthly equivalent 25000 > 21000
        self._run(emp)
        slip = SalarySlip.objects.get(employee=emp)
        self.assertEqual(slip.esi_deduction, Decimal("0.00"))
        self.assertEqual(slip.pf_deduction, Decimal("1500.00"))

    def _rules(self):
        return [
            {"label": "Low", "minSalary": 0, "maxSalary": 10000, "pfRate": 0, "efRate": 0},
            {"label": "Mid", "minSalary": 10001, "maxSalary": 20000, "pfRate": 12, "efRate": 1},
            {"label": "Top", "minSalary": 20001, "maxSalary": 0, "pfRate": 12, "efRate": 0},
        ]

    def test_salary_range_rule_is_chosen_by_monthly_equivalent(self):
        _configure(prod_pf_ef_enabled=True, prod_pf_ef_rules=self._rules())
        emp = _production()
        self._work(emp)  # equivalent 12500 -> "Mid"
        self._run(emp)
        b = _breakdown(emp)["deductions"]
        self.assertEqual(b["pfEfRule"]["label"], "Mid")
        self.assertEqual((b["pf"], b["esi"]), (750.0, 62.5))

    def test_a_zero_max_salary_means_no_upper_limit(self):
        _configure(prod_pf_ef_enabled=True, prod_pf_ef_rules=self._rules())
        emp = _production(per_shift="1000.00")
        self._work(emp)  # 12.5 x 1000 = 12500 -> equivalent 25000 -> "Top"
        self._run(emp)
        self.assertEqual(_breakdown(emp)["deductions"]["pfEfRule"]["label"], "Top")

    def test_a_matching_rule_overrides_the_flat_rates(self):
        _configure(prod_payroll_rules_enabled=True, prod_pf_ef_enabled=True, prod_pf_ef_rules=self._rules())
        emp = _production()
        self._work(emp, full=2, one_and_half=0)  # 1000 -> equivalent 2000 -> "Low": no deductions
        self._run(emp)
        b = _breakdown(emp)["deductions"]
        self.assertEqual((b["pf"], b["esi"], b["total"]), (0.0, 0.0, 0.0))
        self.assertEqual(b["pfEfRule"]["label"], "Low")

    def test_no_matching_rule_falls_back_to_flat_rates(self):
        _configure(
            prod_payroll_rules_enabled=True,
            prod_pf_ef_enabled=True,
            prod_pf_ef_rules=[{"label": "Only high", "minSalary": 90000, "maxSalary": 0, "pfRate": 5, "efRate": 5}],
        )
        emp = _production()
        self._work(emp)
        self._run(emp)
        b = _breakdown_for_period(emp)["deductions"]
        self.assertIsNone(b["pfEfRule"])
        self.assertEqual(b["pf"], 750.0)

    def test_advance_is_attributed_to_the_month_the_period_ends_in(self):
        emp = _production()
        self._work(emp)
        adv = Advance.objects.create(
            employee=emp,
            advance_type="salary",
            amount=Decimal("1000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("1000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=2, year=YEAR, amount=Decimal("1000"))
        AdvanceRepayment.objects.create(advance=adv, month=1, year=YEAR, amount=Decimal("999"))
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("1000.00"))

    def test_regenerating_a_period_updates_in_place(self):
        emp = _production()
        self._work(emp, full=2, one_and_half=0)
        self._run(emp)
        self._run(emp)
        self.assertEqual(Payroll.objects.filter(employee=emp).count(), 1)
        self.assertEqual(SalarySlip.objects.filter(employee=emp).count(), 1)

    def test_late_detection_with_no_assigned_shift_never_penalises(self):
        _configure(
            prod_late_detection_enabled=True,
            prod_late_free_allowance=0,
            prod_late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 1}],
        )
        emp = _production()
        for d in (self.START,):
            _day(emp, d, shifts="1.00", first_punch=time(23, 0))
        p = self._run(emp)["payroll"]
        self.assertEqual(p.deductions, Decimal("0.00"))


def _breakdown_for_period(emp):
    return SalarySlip.objects.get(employee=emp).breakdown_details


# ─────────────────────────────────────────────────────────────────────────────
#  Endpoints
# ─────────────────────────────────────────────────────────────────────────────


class PayrollEndpointTests(TestCase):
    def setUp(self):
        _configure(
            staff_payroll_rules_enabled=False,
            late_deduction_slabs=[],
            attendance_mode="simple",
            compensation_feature_enabled=True,
        )
        self.emp = _staff("EP_A")
        _present_all(self.emp)

    def _generate(self, body=None, **headers):
        return self.client.post(
            "/api/payroll/generate",
            body if body is not None else {"month": MONTH, "year": YEAR},
            content_type="application/json",
            **(headers or _hr()),
        )

    # ── auth ───────────────────────────────────────────────────────────────
    def test_every_payroll_endpoint_rejects_anonymous_callers(self):
        p = Payroll.objects.create(
            employee=self.emp,
            salary_mode="monthly",
            month=MONTH,
            year=YEAR,
            base_salary=1,
            gross_salary=1,
            final_salary=1,
        )
        for method, url in (
            ("get", "/api/payroll"),
            ("get", "/api/payroll/skip-check?month=2&year=2026"),
            ("post", "/api/payroll/generate"),
            ("get", f"/api/payroll/{p.id}/breakdown"),
            ("patch", f"/api/payroll/{p.id}"),
        ):
            self.assertEqual(getattr(self.client, method)(url).status_code, 401, url)

    def test_employee_tokens_cannot_touch_payroll(self):
        emp_token = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.emp.id})}"}
        p = Payroll.objects.create(
            employee=self.emp,
            salary_mode="monthly",
            month=MONTH,
            year=YEAR,
            base_salary=1,
            gross_salary=1,
            final_salary=1,
        )
        self.assertEqual(self.client.get("/api/payroll", **emp_token).status_code, 403)
        self.assertEqual(self._generate(**emp_token).status_code, 403)
        self.assertEqual(self.client.get(f"/api/payroll/{p.id}/breakdown", **emp_token).status_code, 403)
        self.assertEqual(
            self.client.patch(
                f"/api/payroll/{p.id}", {"status": "paid"}, content_type="application/json", **emp_token
            ).status_code,
            403,
        )
        p.refresh_from_db()
        self.assertEqual(p.status, "pending")

    # ── generate ───────────────────────────────────────────────────────────
    def test_generate_requires_month_and_year(self):
        self.assertEqual(self._generate({"month": 2}).status_code, 400)
        self.assertEqual(self._generate({}).status_code, 400)
        self.assertEqual(self._generate({"month": "feb", "year": 2026}).status_code, 400)

    def test_generate_creates_payroll_for_active_staff_only(self):
        _staff("EP_NOSAL", salary="0")
        inactive = _staff("EP_GONE")
        inactive.status = "resigned"
        inactive.save()
        prod = _production("EP_PROD")
        r = self._generate()
        self.assertEqual(r.status_code, 201)
        body = r.json()
        self.assertEqual(body["generated"], 1)
        self.assertEqual(body["skipped"], 1)
        self.assertIn("No Salary Amount", body["skippedDetails"][0]["reason"])
        self.assertEqual(body["skippedDetails"][0]["name"], "EP_NOSAL Staff")
        self.assertEqual(set(Payroll.objects.values_list("employee_id", flat=True)), {self.emp.id})
        self.assertFalse(Payroll.objects.filter(employee__in=[inactive, prod]).exists())

    def test_generating_twice_does_not_duplicate(self):
        self._generate()
        self._generate()
        self.assertEqual(Payroll.objects.filter(employee=self.emp).count(), 1)

    # ── skip-check ─────────────────────────────────────────────────────────
    def test_skip_check_lists_reasons_and_writes_nothing(self):
        _staff("EP_NOSAL", salary="0")
        adv = Advance.objects.create(
            employee=self.emp,
            advance_type="salary",
            amount=Decimal("1000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("1000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=MONTH, year=YEAR, amount=Decimal("1000"))
        r = self.client.get(f"/api/payroll/skip-check?month={MONTH}&year={YEAR}", **_hr())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["totalChecked"], body["skippedCount"]), (2, 1))
        self.assertEqual(body["skipped"][0]["employeeCode"], "EP_NOSAL")
        # Nothing persisted: no payroll, no slip, and the repayment is still pending.
        self.assertFalse(Payroll.objects.exists())
        self.assertFalse(SalarySlip.objects.exists())
        self.assertFalse(AdvanceRepayment.objects.get(advance=adv).is_processed)

    def test_skip_check_validates_its_query(self):
        self.assertEqual(self.client.get("/api/payroll/skip-check", **_hr()).status_code, 400)
        self.assertEqual(self.client.get("/api/payroll/skip-check?month=a&year=b", **_hr()).status_code, 400)

    # ── list ───────────────────────────────────────────────────────────────
    def test_list_filters(self):
        other = _staff("EP_B")
        _present_all(other, WORKING_DAYS[:12])
        self._generate()
        Payroll.objects.filter(employee=other).update(status="paid")

        def ids(qs):
            return {row["employeeId"] for row in self.client.get(f"/api/payroll?{qs}", **_hr()).json()}

        self.assertEqual(ids(""), {self.emp.id, other.id})
        self.assertEqual(ids(f"employeeId={other.id}"), {other.id})
        self.assertEqual(ids("status=paid"), {other.id})
        self.assertEqual(ids("status=pending"), {self.emp.id})
        self.assertEqual(ids(f"month={MONTH}&year={YEAR}"), {self.emp.id, other.id})
        self.assertEqual(ids("month=3&year=2026"), set())

    def test_list_rows_carry_the_export_fields(self):
        self.emp.bank_account, self.emp.bank_ifsc, self.emp.bank_name = "123", "IFSC0", "Bank"
        self.emp.save()
        self._generate()
        row = self.client.get("/api/payroll", **_hr()).json()[0]
        self.assertEqual((row["employeeCode"], row["bankAccount"], row["bankIfsc"]), ("EP_A", "123", "IFSC0"))

    def test_branch_scoped_hr_only_sees_their_own_branch(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        n, s = _staff("EP_N", branch=north), _staff("EP_S", branch=south)
        for e in (n, s):
            _present_all(e)
        self._generate()
        rows = self.client.get("/api/payroll", **_hr(branch=north, super_admin=False)).json()
        self.assertEqual({r["employeeId"] for r in rows}, {n.id})
        rows = self.client.get("/api/payroll", **_hr()).json()
        self.assertEqual({r["employeeId"] for r in rows}, {n.id, s.id, self.emp.id})

    def test_branch_scoped_hr_cannot_open_or_edit_another_branchs_payroll_by_id(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        s = _staff("EP_S", branch=south)
        _present_all(s)
        self._generate()
        target = Payroll.objects.get(employee=s)
        hr_north = _hr(branch=north, super_admin=False)
        self.assertEqual(self.client.get(f"/api/payroll/{target.id}/breakdown", **hr_north).status_code, 404)
        r = self.client.patch(
            f"/api/payroll/{target.id}", {"bonus": 99999}, content_type="application/json", **hr_north
        )
        self.assertEqual(r.status_code, 404)
        target.refresh_from_db()
        self.assertEqual(target.bonus, Decimal("0.00"))

    # ── detail / breakdown ─────────────────────────────────────────────────
    def test_patch_recomputes_final_salary_from_bonus_and_deductions(self):
        self._generate()
        p = Payroll.objects.get(employee=self.emp)
        r = self.client.patch(
            f"/api/payroll/{p.id}",
            {"bonus": 1500, "deductions": 500, "status": "paid"},
            content_type="application/json",
            **_hr(),
        )
        self.assertEqual(r.status_code, 200)
        p.refresh_from_db()
        self.assertEqual((p.status, p.bonus, p.deductions), ("paid", Decimal("1500.00"), Decimal("500.00")))
        self.assertEqual(p.final_salary, Decimal("25000.00"))  # 24000 + 1500 - 500

    def test_patch_unknown_payroll_is_404(self):
        r = self.client.patch("/api/payroll/999999", {"status": "paid"}, content_type="application/json", **_hr())
        self.assertEqual(r.status_code, 404)

    @unittest.expectedFailure
    def test_marking_paid_must_not_change_the_net_when_there_is_ot(self):
        # KNOWN DEFECT. The engine's net is gross + OT - deductions, but PATCH
        # always recomputes final_salary as gross + bonus - deductions, leaving
        # OT out. So merely marking a payroll "paid" (no other field) silently
        # removes the employee's overtime pay from what they are owed.
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=date(2026, 2, 2),
            last_punch_out=time(20, 0),
            ot_minutes=120,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_PAY,
        )
        self._generate()
        p = Payroll.objects.get(employee=self.emp)
        self.assertEqual(p.final_salary, Decimal("25000.00"))
        self.client.patch(f"/api/payroll/{p.id}", {"status": "paid"}, content_type="application/json", **_hr())
        p.refresh_from_db()
        self.assertEqual(p.final_salary, Decimal("25000.00"))

    def test_breakdown_returns_the_stored_day_by_day_slip(self):
        self._generate()
        p = Payroll.objects.get(employee=self.emp)
        r = self.client.get(f"/api/payroll/{p.id}/breakdown", **_hr())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["employee"]["code"], "EP_A")
        self.assertEqual(body["summary"]["netSalary"], 24000.0)
        self.assertEqual(len(body["breakdown"]["days"]), 24)

    def test_breakdown_unknown_payroll_is_404(self):
        self.assertEqual(self.client.get("/api/payroll/999999/breakdown", **_hr()).status_code, 404)
