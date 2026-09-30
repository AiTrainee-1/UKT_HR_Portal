"""
Boundary-verification tests for the Late Detection / Permission / Half-Day
Detection rewrite: the fixed Half-Day cutoffs (13:30/14:30 by default), the
two independent Morning Late-In / Evening Early-Out checks, and the
Permission boundary-shift + monthly-cap mechanism. Also covers the
Compensation Day and OT/Compensation-feature interactions with all of the
above.
"""
from datetime import date, time
from decimal import Decimal

from django.test import TestCase

from .models import (
    Employee, ShiftTemplate, EmployeeShiftAssignment, AttendanceLog,
    PayrollSettings, EmployeePermission, CompensationDayAnnouncement,
    OvertimeRecord, CompensationLeaveCredit,
)
from .attendance_final import compute_day_record
from .overtime import detect_overtime_for_month
from .compensation_views import _compensation_summary_data


class ZoneBoundaryTests(TestCase):
    """Shift 09:00-18:00, 15min grace, lunch out 13:30 for 60min. Half-Day
    cutoffs at their defaults: First-Half-End 13:30, Second-Half-Start
    14:30."""

    @classmethod
    def setUpTestData(cls):
        cls.settings = PayrollSettings.get()
        cls.settings.attendance_mode = "strict"
        cls.settings.morning_late_in_enabled = True
        cls.settings.evening_early_out_enabled = True
        cls.settings.afternoon_late_window_minutes = 60
        cls.settings.afternoon_permission_window_minutes = 60
        cls.settings.permission_monthly_cap = 3
        cls.settings.save()

        cls.shift = ShiftTemplate.objects.create(
            name="Zone Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        cls.emp = Employee.objects.create(
            employee_code="ZONETEST01", first_name="Zone", last_name="Test",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, emp, d, *times):
        AttendanceLog.objects.filter(employee=emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type="IN", source="test")

    def _record(self, d, emp=None):
        return compute_day_record(emp or self.emp, d, settings=PayrollSettings.get())

    # ── Half-Day Detection: the shift's own first-half limit (09:00 + 15 grace + 60 + 60 + 20 = 11:35) and the
    #    fixed Second Half Start (14:30) ──
    def test_both_halves_attended_is_full_day_when_the_first_punch_beats_the_first_half_limit(self):
        d = date(2026, 1, 5)  # Monday
        self._punch(self.emp, d, time(10, 0), time(18, 0))  # inside the Late window: a Full Day AND Late
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertEqual(r.shifts_earned, Decimal("1.00"))
        self.assertTrue(r.is_late)  # Late Detection still fires -orthogonal to Half-Day status

    def test_a_first_punch_after_the_first_half_limit_is_a_second_half_arrival_not_a_full_day(self):
        d = date(2026, 1, 12)
        self._punch(self.emp, d, time(13, 0), time(18, 0))  # 1pm: after 11:35, so the first half was missed
        r = self._record(d)
        self.assertEqual((r.status, r.shifts_earned), ("half_shift", Decimal("0.50")))
        self.assertFalse(r.is_late)  # one cause, one consequence: not ALSO Late
        self.assertEqual(r.arrival_zone, "second_half")

    def test_missing_the_morning_half_is_half_day(self):
        d = date(2026, 1, 6)
        self._punch(self.emp, d, time(14, 0), time(18, 0))  # first punch at/after 13:30: morning missed
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")
        self.assertEqual(r.shifts_earned, Decimal("0.50"))

    def test_missing_the_evening_half_is_half_day(self):
        d = date(2026, 1, 7)
        self._punch(self.emp, d, time(9, 0), time(14, 0))  # leaves before 14:30: evening missed
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")

    def test_a_lone_punch_inside_the_gap_attends_neither_half(self):
        d = date(2026, 1, 8)
        self._punch(self.emp, d, time(14, 0))  # 13:30-14:30 gap, no other punch
        r = self._record(d)
        self.assertEqual(r.status, "absent")

    def test_exactly_at_the_first_half_end_no_longer_counts_as_morning(self):
        d = date(2026, 1, 9)
        self._punch(self.emp, d, time(13, 30), time(18, 0))  # at, not before, the cutoff
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")  # only evening attended

    def test_exactly_at_the_second_half_start_counts_as_evening(self):
        d = date(2026, 1, 12)
        self._punch(self.emp, d, time(9, 0), time(14, 30))
        r = self._record(d)
        self.assertEqual(r.status, "present")

    # ── Late Detection: Morning Late-In / Evening Early-Out ──
    def test_morning_on_time_at_grace_boundary(self):
        d = date(2026, 1, 13)
        self._punch(self.emp, d, time(9, 15), time(18, 0))
        r = self._record(d)
        self.assertFalse(r.is_late)

    def test_morning_late_one_minute_past_grace(self):
        d = date(2026, 1, 14)
        self._punch(self.emp, d, time(9, 16), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_late)

    def test_evening_early_out_one_minute_before_grace(self):
        d = date(2026, 1, 15)
        self._punch(self.emp, d, time(9, 0), time(17, 44))  # end 18:00 - 15 grace = 17:45 deadline
        r = self._record(d)
        self.assertTrue(r.early_leave)

    def test_evening_early_out_disabled_by_default_setting(self):
        self.settings.evening_early_out_enabled = False
        self.settings.save()
        try:
            d = date(2026, 1, 16)
            self._punch(self.emp, d, time(9, 0), time(17, 0))  # an hour early
            r = self._record(d)
            self.assertFalse(r.early_leave)
        finally:
            self.settings.evening_early_out_enabled = True
            self.settings.save()

    # ── Afternoon (Night Late) lunch-return axis: untouched, never demotes ──
    def test_afternoon_late_zone_never_demotes_the_day(self):
        d = date(2026, 1, 19)
        # arrive 09:00, lunch out 12:30, expected return 13:30, actual 15:31 (deep into the old zone)
        self._punch(self.emp, d, time(9, 0), time(12, 30), time(15, 31), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")  # both Half-Day halves still attended
        self.assertTrue(r.late_afternoon)

    # ── Permission: boundary shift, in-cap vs excess, cap counted per calendar month ──
    def test_in_cap_morning_late_in_permission_shifts_the_effective_start(self):
        d = date(2026, 2, 2)  # Monday, fresh month
        EmployeePermission.objects.create(
            employee=self.emp, date=d, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved",
        )
        self._punch(self.emp, d, time(10, 10), time(18, 0))  # 70 min late against the real 9:00 start
        r = self._record(d)
        self.assertFalse(r.is_late)  # covered: effective start becomes 10:00 + 15 grace = 10:15
        self.assertTrue(r.morning_permission_applied)
        self.assertFalse(r.morning_permission_excess)
        self.assertEqual(r.status, "present")  # Half-Day boundary itself never moves

    def test_in_cap_evening_early_out_permission_shifts_the_effective_end(self):
        d = date(2026, 2, 3)
        EmployeePermission.objects.create(
            employee=self.emp, date=d, type=EmployeePermission.TYPE_EVENING_EARLY_OUT, status="approved",
        )
        self._punch(self.emp, d, time(9, 0), time(17, 10))  # 50 min early against the real 18:00 end
        r = self._record(d)
        self.assertFalse(r.early_leave)  # covered: effective end becomes 17:00 - 15 grace = 16:45
        self.assertTrue(r.evening_permission_applied)

    def test_middle_permission_never_shifts_any_boundary(self):
        d = date(2026, 2, 4)
        EmployeePermission.objects.create(
            employee=self.emp, date=d, type=EmployeePermission.TYPE_MIDDLE_PERMISSION, status="approved",
        )
        self._punch(self.emp, d, time(10, 10), time(18, 0))  # still 70 min late
        r = self._record(d)
        self.assertTrue(r.is_late)  # not covered -middle permission doesn't touch morning/evening at all
        self.assertFalse(r.morning_permission_applied)
        self.assertTrue(r.middle_permission_today)

    def test_a_pending_permission_never_shifts_the_boundary(self):
        d = date(2026, 2, 5)
        EmployeePermission.objects.create(
            employee=self.emp, date=d, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="pending",
        )
        self._punch(self.emp, d, time(10, 10), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_late)
        self.assertFalse(r.morning_permission_applied)

    def test_the_fourth_approved_permission_that_month_is_excess(self):
        month_days = [date(2026, 3, d) for d in (2, 3, 4, 5)]  # cap is 3
        for d in month_days:
            EmployeePermission.objects.create(
                employee=self.emp, date=d, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved",
            )
        results = []
        for d in month_days:
            self._punch(self.emp, d, time(10, 10), time(18, 0))
            results.append(self._record(d))
        applied = [r.morning_permission_applied for r in results]
        excess = [r.morning_permission_excess for r in results]
        self.assertEqual(applied, [True, True, True, False])
        self.assertEqual(excess, [False, False, False, True])
        self.assertTrue(results[3].is_late)  # the 4th day's lateness is judged against the real start


class CompensationDayTests(TestCase):
    """Compensation-Leave: a day HR declares exempt from Late/Permission
    penalties, but Full vs Half is still judged from real punches -never
    auto-granted. The user's own example: an employee who only comes in the
    afternoon must still show Half Shift, not Full Day, just because it's a
    compensation day."""

    @classmethod
    def setUpTestData(cls):
        cls.settings = PayrollSettings.get()
        cls.settings.attendance_mode = "strict"
        cls.settings.save()

        cls.shift = ShiftTemplate.objects.create(
            name="Comp Day Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        cls.emp = Employee.objects.create(
            employee_code="COMPDAYTEST01", first_name="Comp", last_name="Test",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, d, *times):
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def _record(self, d):
        return compute_day_record(self.emp, d, settings=PayrollSettings.get())

    def test_normal_day_would_be_half_shift_and_flagged(self):
        # Sanity baseline: without an announcement, missing the whole morning half is Half Shift.
        d = date(2026, 3, 2)
        self._punch(d, time(14, 0), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")
        self.assertFalse(r.is_compensation_day)

    def test_full_day_exemption_suppresses_flags_but_not_half_shift(self):
        d = date(2026, 3, 3)
        CompensationDayAnnouncement.objects.create(date=d, reason="Festival").employees.add(self.emp)
        # Only afternoon attendance -still genuinely a Half Shift day.
        self._punch(d, time(14, 0), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_compensation_day)
        self.assertEqual(r.status, "half_shift")  # never auto-granted Full Day
        self.assertFalse(r.is_late)
        self.assertFalse(r.morning_permission_applied)

    def test_leave_until_time_full_day_when_present_through_it(self):
        d = date(2026, 3, 4)
        ann = CompensationDayAnnouncement.objects.create(date=d, leave_until_time=time(15, 0), reason="Half day")
        ann.employees.add(self.emp)
        # Normal arrival, leaves right at the announced 15:00 cutoff -Full Day.
        self._punch(d, time(9, 0), time(15, 0))
        r = self._record(d)
        self.assertTrue(r.is_compensation_day)
        self.assertEqual(r.status, "present")
        self.assertFalse(r.is_late)

    def test_leave_before_announced_cutoff_is_half_shift(self):
        d = date(2026, 3, 5)
        ann = CompensationDayAnnouncement.objects.create(date=d, leave_until_time=time(15, 0), reason="Half day")
        ann.employees.add(self.emp)
        # Left more than 2 hours before the announced 15:00 cutoff -the release isn't a blanket exemption.
        self._punch(d, time(9, 0), time(12, 30))
        r = self._record(d)
        self.assertTrue(r.is_compensation_day)
        self.assertEqual(r.status, "half_shift")
        self.assertFalse(r.is_late)  # still no penalty flags

    def test_unscoped_employee_not_covered(self):
        other = Employee.objects.create(
            employee_code="COMPDAYTEST02", first_name="Other", last_name="Emp",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=other, shift=self.shift, effective_from=date(2020, 1, 1),
        )
        d = date(2026, 3, 6)
        CompensationDayAnnouncement.objects.create(date=d, reason="Festival").employees.add(self.emp)
        AttendanceLog.objects.create(employee=other, date=d, punch_time=time(13, 0), punch_type="IN", source="test")
        AttendanceLog.objects.create(employee=other, date=d, punch_time=time(18, 0), punch_type="IN", source="test")
        r = compute_day_record(other, d, settings=PayrollSettings.get())
        self.assertFalse(r.is_compensation_day)


class OvertimeDetectionTests(TestCase):
    def setUp(self):
        self.settings = PayrollSettings.get()
        self.settings.ot_detection_enabled = True
        self.settings.ot_threshold_minutes = 60
        self.settings.save()

        self.shift = ShiftTemplate.objects.create(
            name="OT Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        self.emp = Employee.objects.create(
            employee_code="OTTEST01", first_name="OT", last_name="Test",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=self.emp, shift=self.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def test_below_threshold_not_detected(self):
        d = date(2026, 4, 6)
        self._punch(d, time(9, 0), time(18, 59))  # 59 min OT -below 60min threshold
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 4, settings=self.settings)
        self.assertFalse(OvertimeRecord.objects.filter(employee=self.emp, date=d).exists())

    def test_at_threshold_detected(self):
        d = date(2026, 4, 7)
        self._punch(d, time(9, 0), time(19, 0))  # exactly 60 min OT
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 4, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual(rec.status, OvertimeRecord.STATUS_DETECTED)
        self.assertEqual(rec.ot_minutes, 60)

    def test_disabled_setting_detects_nothing(self):
        self.settings.ot_detection_enabled = False
        self.settings.save()
        d = date(2026, 4, 8)
        self._punch(d, time(9, 0), time(21, 0))
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 4, settings=self.settings)
        self.assertFalse(OvertimeRecord.objects.filter(employee=self.emp, date=d).exists())

    def test_reannounced_record_not_overwritten_by_rerun(self):
        d = date(2026, 4, 9)
        self._punch(d, time(9, 0), time(20, 0))
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 4, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp, date=d)
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_PAY
        rec.save()
        detect_overtime_for_month(2026, 4, settings=self.settings)
        rec.refresh_from_db()
        self.assertEqual(rec.status, OvertimeRecord.STATUS_ANNOUNCED)
        self.assertEqual(rec.compensation_type, OvertimeRecord.TYPE_PAY)

    def test_ot_amount_appears_in_payroll_only_after_announcement(self):
        from .payroll_views import _generate_staff_payroll

        self.emp.salary_amount = Decimal("26000")
        self.emp.save()

        d = date(2026, 5, 6)  # a Wednesday, safely mid-month
        self._punch(d, time(9, 0), time(20, 0))  # 2 hours OT
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 5, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual(rec.status, OvertimeRecord.STATUS_DETECTED)

        # Detected but not yet announced -no OT pay in this month's payroll.
        result = _generate_staff_payroll(self.emp, 5, 2026, settings=self.settings)
        self.assertEqual(result["slip"].ot_amount, Decimal("0.00"))

        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_PAY
        rec.save()

        result = _generate_staff_payroll(self.emp, 5, 2026, settings=self.settings)
        self.assertGreater(result["slip"].ot_amount, Decimal("0.00"))
        self.assertEqual(result["payroll"].ot_amount, result["slip"].ot_amount)


class CompensationSummaryTests(TestCase):
    """Cost + benefit/non-benefit breakdown (Compensation -> History & Reports)."""

    def setUp(self):
        self.settings = PayrollSettings.get()
        self.settings.ot_detection_enabled = True
        self.settings.ot_threshold_minutes = 60
        self.settings.save()

        self.shift = ShiftTemplate.objects.create(
            name="Summary Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        self.emp_pay = Employee.objects.create(
            employee_code="SUMTEST01", first_name="Paid", last_name="Emp",
            employment_type="staff", status="active", salary_amount=Decimal("30000"),
        )
        self.emp_relax = Employee.objects.create(
            employee_code="SUMTEST02", first_name="Relax", last_name="Emp",
            employment_type="staff", status="active", salary_amount=Decimal("30000"),
        )
        for emp in (self.emp_pay, self.emp_relax):
            EmployeeShiftAssignment.objects.create(
                employee=emp, shift=self.shift, effective_from=date(2020, 1, 1),
            )

    def _punch(self, emp, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type="IN", source="test")

    def test_unpaid_pay_record_is_pending_and_not_benefiting(self):
        d = date(2026, 6, 3)
        self._punch(self.emp_pay, d, time(9, 0), time(20, 0))
        compute_day_record(self.emp_pay, d, settings=self.settings)
        detect_overtime_for_month(2026, 6, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp_pay, date=d)
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_PAY
        rec.save()

        summary = _compensation_summary_data({self.emp_pay.id, self.emp_relax.id}, 6, 2026)
        self.assertEqual(summary["paidCost"], 0.0)
        self.assertGreater(summary["pendingCostEstimate"], 0.0)
        self.assertEqual(len(summary["benefiting"]), 0)
        self.assertEqual(len(summary["notBenefiting"]), 1)
        self.assertEqual(summary["notBenefiting"][0]["employeeId"], self.emp_pay.id)

    def test_paid_record_after_payroll_generation_is_benefiting(self):
        from .payroll_views import _generate_staff_payroll

        d = date(2026, 6, 4)
        self._punch(self.emp_pay, d, time(9, 0), time(20, 0))
        compute_day_record(self.emp_pay, d, settings=self.settings)
        detect_overtime_for_month(2026, 6, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp_pay, date=d)
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_PAY
        rec.save()

        result = _generate_staff_payroll(self.emp_pay, 6, 2026, settings=self.settings)
        self.assertGreater(result["slip"].ot_amount, Decimal("0.00"))

        summary = _compensation_summary_data({self.emp_pay.id, self.emp_relax.id}, 6, 2026)
        self.assertEqual(summary["paidCost"], float(result["slip"].ot_amount))
        self.assertEqual(summary["pendingCostEstimate"], 0.0)
        self.assertEqual(len(summary["benefiting"]), 1)
        self.assertEqual(summary["benefiting"][0]["employeeId"], self.emp_pay.id)

    def test_relaxation_credit_redeemed_vs_unredeemed(self):
        d = date(2026, 6, 5)
        self._punch(self.emp_relax, d, time(9, 0), time(20, 0))
        compute_day_record(self.emp_relax, d, settings=self.settings)
        detect_overtime_for_month(2026, 6, settings=self.settings)
        rec = OvertimeRecord.objects.get(employee=self.emp_relax, date=d)
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = OvertimeRecord.TYPE_RELAXATION
        rec.save()
        credit = CompensationLeaveCredit.objects.create(employee=self.emp_relax, source_overtime_record=rec)

        summary = _compensation_summary_data({self.emp_pay.id, self.emp_relax.id}, 6, 2026)
        self.assertEqual(len(summary["notBenefiting"]), 1)
        self.assertEqual(len(summary["benefiting"]), 0)

        credit.status = CompensationLeaveCredit.STATUS_USED
        credit.used_date = date(2026, 6, 10)
        credit.save()

        summary = _compensation_summary_data({self.emp_pay.id, self.emp_relax.id}, 6, 2026)
        self.assertEqual(len(summary["benefiting"]), 1)
        self.assertEqual(len(summary["notBenefiting"]), 0)


class CompensationMasterSwitchTests(TestCase):
    """PayrollSettings.compensation_feature_enabled -a single choke point
    that must genuinely disable OT detection, the compensation-day
    exemption, and OT pay in payroll when off, not just hide a nav item
    (the exact bug night_shift_enabled was fixed for previously)."""

    def setUp(self):
        self.settings = PayrollSettings.get()
        self.settings.compensation_feature_enabled = False
        self.settings.ot_detection_enabled = True
        self.settings.ot_threshold_minutes = 60
        self.settings.attendance_mode = "strict"
        self.settings.save()

        self.shift = ShiftTemplate.objects.create(
            name="Master Switch Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        self.emp = Employee.objects.create(
            employee_code="MASTERSWITCH01", first_name="Switch", last_name="Test",
            employment_type="staff", status="active", salary_amount=Decimal("30000"),
        )
        EmployeeShiftAssignment.objects.create(
            employee=self.emp, shift=self.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, d, *times):
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def test_ot_not_detected_when_feature_disabled(self):
        d = date(2026, 7, 6)
        self._punch(d, time(9, 0), time(20, 0))  # 2 hours OT -would normally be detected
        compute_day_record(self.emp, d, settings=self.settings)
        detect_overtime_for_month(2026, 7, settings=self.settings)
        self.assertFalse(OvertimeRecord.objects.filter(employee=self.emp, date=d).exists())

    def test_compensation_day_exemption_does_not_apply_when_disabled(self):
        d = date(2026, 7, 7)
        CompensationDayAnnouncement.objects.create(date=d, reason="Festival").employees.add(self.emp)
        self._punch(d, time(14, 0), time(18, 0))  # afternoon-only arrival: Half Day either way
        record = compute_day_record(self.emp, d, settings=self.settings)
        self.assertFalse(record.is_compensation_day)
        self.assertEqual(record.status, "half_shift")

    def test_ot_pay_excluded_from_payroll_when_disabled(self):
        from .payroll_views import _generate_staff_payroll

        d = date(2026, 7, 8)
        self._punch(d, time(9, 0), time(20, 0))
        compute_day_record(self.emp, d, settings=self.settings)
        # Directly create an already-announced Pay record (simulating one
        # that was announced before the feature was switched off).
        OvertimeRecord.objects.create(
            employee=self.emp, date=d, shift_end_time=time(18, 0), last_punch_out=time(20, 0),
            ot_minutes=120, status=OvertimeRecord.STATUS_ANNOUNCED, compensation_type=OvertimeRecord.TYPE_PAY,
        )
        result = _generate_staff_payroll(self.emp, 7, 2026, settings=self.settings)
        self.assertEqual(result["slip"].ot_amount, Decimal("0.00"))
