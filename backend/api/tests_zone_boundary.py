"""
Throwaway boundary-verification tests for the attendance zone-chain redesign
(Morning/Night Late, auto-Permission zone, daily/weekly caps). Not meant to
be a permanent part of the test suite -run once via:
    python manage.py test api.tests_zone_boundary -v 2
then delete this file (or keep it if the team wants ongoing regression
coverage; not decided here).
"""
from datetime import date, time, timedelta
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
    @classmethod
    def setUpTestData(cls):
        cls.settings = PayrollSettings.get()
        cls.settings.attendance_mode = "strict"
        cls.settings.shift_punctuality_window_minutes = 60
        cls.settings.permission_window_minutes = 60
        cls.settings.afternoon_late_window_minutes = 60
        cls.settings.afternoon_permission_window_minutes = 60
        cls.settings.afternoon_late_can_cause_half_shift = True
        cls.settings.max_permissions_per_day = 1
        cls.settings.max_permissions_per_week = 2
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

    def _record(self, d):
        return compute_day_record(self.emp, d, settings=PayrollSettings.get())

    # ── Morning arrival edge: 09:00 start, 15min grace, 60min window, 60min permission ──
    def test_morning_on_time_at_grace_boundary(self):
        d = date(2026, 1, 5)  # Monday
        self._punch(self.emp, d, time(9, 15), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertFalse(r.is_late)
        self.assertFalse(r.permission_morning)

    def test_morning_late_one_minute_into_late_zone(self):
        d = date(2026, 1, 6)
        self._punch(self.emp, d, time(9, 16), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.is_late)
        self.assertFalse(r.permission_morning)

    def test_morning_late_at_window_boundary_still_late(self):
        d = date(2026, 1, 7)
        self._punch(self.emp, d, time(10, 0), time(18, 0))  # exactly +60min
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.is_late)
        self.assertFalse(r.permission_morning)

    def test_morning_permission_one_minute_past_window(self):
        d = date(2026, 1, 8)
        self._punch(self.emp, d, time(10, 1), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.permission_morning)
        self.assertTrue(r.late_in_without_permission)  # no submitted request

    def test_morning_permission_at_outer_boundary(self):
        d = date(2026, 1, 9)
        self._punch(self.emp, d, time(11, 0), time(18, 0))  # +120min exactly
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.permission_morning)

    def test_morning_half_shift_one_minute_past_permission_zone(self):
        d = date(2026, 1, 12)
        self._punch(self.emp, d, time(11, 1), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")
        self.assertFalse(r.permission_morning)

    def test_morning_permission_with_request_when_covered(self):
        d = date(2026, 1, 13)
        EmployeePermission.objects.create(
            employee=self.emp, date=d, permission_time=time(9, 30), status="approved",
        )
        self._punch(self.emp, d, time(10, 30), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.permission_morning)
        self.assertTrue(r.permission_morning_with_request)
        self.assertFalse(r.late_in_without_permission)

    # ── Departure edge: symmetric to arrival ──
    def test_departure_permission_zone(self):
        d = date(2026, 1, 14)
        self._punch(self.emp, d, time(9, 0), time(16, 30))  # 90 min early
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.permission_departure)

    def test_departure_half_shift_beyond_permission_zone(self):
        d = date(2026, 1, 15)
        self._punch(self.emp, d, time(9, 0), time(15, 59))  # 121 min early
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")

    # ── Afternoon (Night Late) edge: lunch out 12:30, back late ──
    def test_afternoon_late_zone_no_half_shift_impact(self):
        d = date(2026, 1, 16)
        # arrive 09:00, lunch out 12:30, expected return 13:30, actual 14:00 (+30min late)
        self._punch(self.emp, d, time(9, 0), time(12, 30), time(14, 0), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.late_afternoon)
        self.assertFalse(r.permission_afternoon)

    def test_afternoon_permission_zone(self):
        d = date(2026, 1, 19)
        # expected return 13:30 (+60 late window) -> permission zone starts 14:30, ends 15:30
        self._punch(self.emp, d, time(9, 0), time(12, 30), time(15, 0), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertTrue(r.permission_afternoon)

    def test_afternoon_half_shift_when_enabled(self):
        d = date(2026, 1, 20)
        # beyond 13:30 + 60 (late) + 60 (permission) = 15:30 -> half shift
        self._punch(self.emp, d, time(9, 0), time(12, 30), time(15, 31), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")
        self.assertTrue(r.late_afternoon)

    def test_afternoon_toggle_off_never_causes_half_shift(self):
        self.settings.afternoon_late_can_cause_half_shift = False
        self.settings.save()
        try:
            d = date(2026, 1, 21)
            self._punch(self.emp, d, time(9, 0), time(12, 30), time(15, 31), time(18, 0))
            r = self._record(d)
            self.assertEqual(r.status, "present")
            self.assertTrue(r.late_afternoon)
        finally:
            self.settings.afternoon_late_can_cause_half_shift = True
            self.settings.save()

    # ── Daily cap: max_permissions_per_day = 1 ──
    def test_daily_cap_escalates_second_edge_to_half_shift(self):
        d = date(2026, 1, 26)  # Monday, fresh week
        # Morning permission zone (+90min) AND departure permission zone (90 min early)
        self._punch(self.emp, d, time(10, 30), time(16, 30))
        r = self._record(d)
        self.assertTrue(r.permission_morning)
        self.assertFalse(r.permission_departure)  # escalated -daily cap = 1, morning wins priority
        self.assertTrue(r.permission_escalated_to_half_shift)
        self.assertEqual(r.status, "half_shift")
        self.assertEqual(r.permission_zone_count, 1)

    # ── Weekly cap: max_permissions_per_week = 2 ──
    def test_weekly_cap_escalates_third_permission_day(self):
        monday = date(2026, 2, 2)
        # Day 1: morning permission (uses 1 of week budget 2)
        self._punch(self.emp, monday, time(10, 30), time(18, 0))
        r1 = self._record(monday)
        self.assertTrue(r1.permission_morning)
        self.assertFalse(r1.permission_escalated_to_half_shift)

        tuesday = monday + timedelta(days=1)
        self._punch(self.emp, tuesday, time(10, 30), time(18, 0))
        r2 = self._record(tuesday)
        self.assertTrue(r2.permission_morning)
        self.assertFalse(r2.permission_escalated_to_half_shift)

        wednesday = monday + timedelta(days=2)
        self._punch(self.emp, wednesday, time(10, 30), time(18, 0))
        r3 = self._record(wednesday)
        self.assertFalse(r3.permission_morning)  # weekly budget exhausted
        self.assertTrue(r3.permission_escalated_to_half_shift)
        self.assertEqual(r3.status, "half_shift")


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
        cls.settings.shift_punctuality_window_minutes = 60
        cls.settings.permission_window_minutes = 60
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
        # Sanity baseline: without an announcement, arriving hours late is
        # Half Shift (and, closer in, would carry Late/Permission flags).
        d = date(2026, 3, 2)
        self._punch(d, time(13, 0), time(18, 0))
        r = self._record(d)
        self.assertEqual(r.status, "half_shift")
        self.assertFalse(r.is_compensation_day)

    def test_full_day_exemption_suppresses_flags_but_not_half_shift(self):
        d = date(2026, 3, 3)
        CompensationDayAnnouncement.objects.create(date=d, reason="Festival").employees.add(self.emp)
        # Only afternoon attendance -still genuinely a Half Shift day.
        self._punch(d, time(13, 0), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_compensation_day)
        self.assertEqual(r.status, "half_shift")  # never auto-granted Full Day
        self.assertFalse(r.is_late)
        self.assertFalse(r.permission_morning)

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
        # Left more than 2 hours before the announced 15:00 cutoff.
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
        self._punch(d, time(13, 0), time(18, 0))  # afternoon-only arrival
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
