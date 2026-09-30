"""Lateness is judged in whole minutes: seconds don't count.

Shift 9:00 with a 10-minute grace: a punch through 9:10:59 is on time and the first late minute is 9:11. The same
goes for the lunch return deadline. Before this, a punch at 9:10:20 was late because it was compared to the second.

Morning Late-In is also fully decoupled from Half-Day status now: however late a punch is, it never by itself
caps the day below Full Day -only missing an entire Half-Day window (see tests_zone_boundary.py) does that.
"""

from datetime import date, time
from decimal import Decimal

from django.test import TestCase

from .attendance_final import compute_day_record
from .attendance_views import _late_count
from .models import (
    AttendanceLog,
    Employee,
    EmployeeShiftAssignment,
    PayrollSettings,
    ShiftTemplate,
)

MON = date(2026, 1, 5)


class _Base(TestCase):
    mode = "strict"

    @classmethod
    def setUpTestData(cls):
        settings = PayrollSettings.get()
        settings.attendance_mode = cls.mode
        settings.morning_late_in_enabled = True
        settings.afternoon_late_window_minutes = 60
        settings.afternoon_permission_window_minutes = 60
        settings.save()
        cls.shift = ShiftTemplate.objects.create(
            name="Nine",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        cls.emp = Employee.objects.create(
            employee_code="LM1", first_name="Late", last_name="Minute", employment_type="staff", status="active"
        )
        EmployeeShiftAssignment.objects.create(employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1))

    def record(self, d, *punches):
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in punches:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")
        return compute_day_record(self.emp, d, settings=PayrollSettings.get())


class MorningGraceTests(_Base):
    def test_a_punch_within_the_grace_minute_is_on_time_whatever_the_seconds(self):
        for punch in (time(9, 0), time(9, 10, 0), time(9, 10, 1), time(9, 10, 20), time(9, 10, 59)):
            r = self.record(MON, punch, time(18, 0))
            self.assertEqual(r.status, "present", punch)
            self.assertFalse(r.is_late, punch)
            self.assertFalse(r.morning_permission_applied, punch)

    def test_the_first_late_minute_is_one_past_the_grace(self):
        for punch in (time(9, 11, 0), time(9, 11, 1), time(9, 11, 40), time(9, 30)):
            r = self.record(MON, punch, time(18, 0))
            self.assertTrue(r.is_late, punch)

    def test_the_reason_names_the_deadline(self):
        r = self.record(MON, time(9, 11, 5), time(18, 0))
        self.assertIn("deadline 09:10", r.late_reason)

    def test_the_late_window_is_full_day_and_late_then_the_quarter_shift_rule_takes_over(self):
        """Late for the Late window after the grace (09:10 -> 10:10 here), a Full Day and a late mark. After it
        the arrival is a quarter-shift day (0.75, and not ALSO late) until the first-half limit (11:30), and only
        beyond that is the morning half missed (see tests_late_permission_rules.py for the whole timeline)."""
        for punch in (time(9, 30), time(10, 0), time(10, 10)):
            r = self.record(MON, punch, time(18, 0))
            self.assertEqual(r.status, "present", punch)
            self.assertEqual(r.shifts_earned, 1, punch)
            self.assertTrue(r.is_late, punch)
        for punch in (time(10, 11), time(11, 0), time(11, 30)):
            r = self.record(MON, punch, time(18, 0))
            self.assertEqual((r.status, r.shifts_earned, r.is_late), ("present", Decimal("0.75"), False), punch)
        r = self.record(MON, time(11, 31), time(18, 0))
        self.assertEqual((r.status, r.shifts_earned, r.is_late), ("half_shift", Decimal("0.50"), False))

    def test_an_early_bird_is_unaffected(self):
        r = self.record(MON, time(8, 59, 59), time(18, 0))
        self.assertEqual(r.status, "present")
        self.assertFalse(r.is_late)


class LunchReturnTests(_Base):
    def test_the_return_from_lunch_is_judged_in_minutes(self):
        # out 12:30:40, an hour for lunch: back by 13:30 (the seconds of the out punch don't move the deadline)
        for back, late in ((time(13, 30, 0), False), (time(13, 30, 59), False), (time(13, 31, 0), True)):
            r = self.record(MON, time(9, 0), time(12, 30, 40), back, time(18, 0))
            self.assertEqual(r.late_afternoon, late, back)


class SimpleModeTests(MorningGraceTests):
    """The same rule in simple attendance mode (two punches)."""

    mode = "simple"

    def test_lunch_punches_dont_exist_in_simple_mode(self):
        r = self.record(MON, time(9, 10, 30), time(18, 0))
        self.assertFalse(r.is_late)


class SummaryCountTests(_Base):
    def test_the_days_late_count_agrees(self):
        other = Employee.objects.create(
            employee_code="LM2", first_name="Late", last_name="Two", employment_type="staff", status="active"
        )
        EmployeeShiftAssignment.objects.create(employee=other, shift=self.shift, effective_from=date(2020, 1, 1))
        for emp, punch in ((self.emp, time(9, 10, 40)), (other, time(9, 11, 0))):
            AttendanceLog.objects.create(
                employee=emp, date=MON, punch_time=punch, punch_type=AttendanceLog.PUNCH_IN, source="test"
            )
        self.assertEqual(_late_count(MON), 1)  # only the 9:11 punch
