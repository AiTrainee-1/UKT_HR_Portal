"""Lateness is judged in whole minutes: seconds don't count.

Shift 9:00 with a 10-minute grace: a punch through 9:10:59 is on time and the first late minute is 9:11. The same
goes for the other whole-minute limits (the punctuality window, the permission window, the lunch return). Before this,
a punch at 9:10:20 was late because it was compared to the second.
"""

from datetime import date, time

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
        settings.shift_punctuality_window_minutes = 60
        settings.permission_window_minutes = 60
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
            self.assertFalse(r.permission_morning, punch)

    def test_the_first_late_minute_is_one_past_the_grace(self):
        for punch in (time(9, 11, 0), time(9, 11, 1), time(9, 11, 40), time(9, 30)):
            r = self.record(MON, punch, time(18, 0))
            self.assertTrue(r.is_late, punch)

    def test_the_reason_names_the_deadline(self):
        r = self.record(MON, time(9, 11, 5), time(18, 0))
        self.assertIn("deadline 09:10", r.late_reason)

    def test_the_punctuality_window_is_judged_in_minutes_too(self):
        # 9:00 + 10 grace... the Late zone runs to 9:00 + 60 minutes = 10:00, permission from 10:01
        for punch, permission in ((time(10, 0, 59), False), (time(10, 1, 0), True)):
            r = self.record(MON, punch, time(18, 0))
            self.assertEqual(r.status, "present", punch)
            self.assertEqual(r.permission_morning, permission, punch)
            self.assertEqual(r.is_late, not permission, punch)

    def test_the_permission_window_is_judged_in_minutes_too(self):
        # the permission zone ends at 9:00 + 60 + 60 = 11:00; one minute later the day is a Half Shift
        r = self.record(MON, time(11, 0, 59), time(18, 0))
        self.assertEqual(r.status, "present")
        self.assertTrue(r.permission_morning)
        r = self.record(MON, time(11, 1, 0), time(18, 0))
        self.assertEqual(r.status, "half_shift")

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
