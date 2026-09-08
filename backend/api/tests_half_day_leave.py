"""
Half-Day Leave -verifies the attendance-engine hook that must exist ONLY for
this feature (unlike Outpass/Visitors, which never touch attendance):
approving a Morning/Afternoon half-day leave should turn a natural Half
Shift result into an annotated "is_half_day_leave" day with the same 0.50
shifts_earned Half Shift already pays, suppress the "late" flag for a
Morning slot's necessarily-late-looking afternoon arrival (but NOT for an
Afternoon slot's morning arrival -the leave doesn't excuse being late for
the half still owed), and never turn a genuine no-show into anything other
than ordinary Absent.

Run via: python manage.py test api.tests_half_day_leave -v 2
"""
from datetime import date, time
from decimal import Decimal

from django.test import TestCase

from .models import Employee, LeaveRequest, PayrollSettings, ShiftTemplate, EmployeeShiftAssignment
from .attendance_final import compute_day_record
from .views import _leave_requests_create


class _FakeRequest:
    """Minimal duck-typed stand-in -_leave_requests_create only ever reads
    request.data, so a full DRF Request isn't needed to exercise it directly."""
    def __init__(self, data):
        self.data = data


class HalfDayLeaveSubmitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.emp = Employee.objects.create(
            employee_code="HDLTEST_EMP1", first_name="HalfDay", last_name="Tester",
            employment_type="staff", status="active",
        )

    def test_half_day_must_be_single_day(self):
        resp = _leave_requests_create(_FakeRequest({
            "employeeId": self.emp.id, "startDate": "2026-01-05", "endDate": "2026-01-06",
            "isHalfDay": True, "halfDaySlot": "morning", "reason": "test",
        }))
        self.assertEqual(resp.status_code, 400)

    def test_half_day_requires_valid_slot(self):
        resp = _leave_requests_create(_FakeRequest({
            "employeeId": self.emp.id, "startDate": "2026-01-05", "endDate": "2026-01-05",
            "isHalfDay": True, "halfDaySlot": "evening", "reason": "test",
        }))
        self.assertEqual(resp.status_code, 400)

    def test_half_day_sets_total_days_half(self):
        resp = _leave_requests_create(_FakeRequest({
            "employeeId": self.emp.id, "startDate": "2026-01-05", "endDate": "2026-01-05",
            "isHalfDay": True, "halfDaySlot": "afternoon", "reason": "test",
        }))
        self.assertEqual(resp.status_code, 201)
        record = LeaveRequest.objects.get(employee=self.emp)
        self.assertEqual(record.total_days, Decimal("0.5"))
        self.assertTrue(record.is_half_day)
        self.assertEqual(record.half_day_slot, "afternoon")

    def test_full_day_leave_unaffected(self):
        resp = _leave_requests_create(_FakeRequest({
            "employeeId": self.emp.id, "startDate": "2026-01-05", "endDate": "2026-01-07",
            "reason": "test",
        }))
        self.assertEqual(resp.status_code, 201)
        record = LeaveRequest.objects.get(employee=self.emp)
        self.assertFalse(record.is_half_day)
        self.assertIsNone(record.half_day_slot)
        self.assertEqual(record.total_days, Decimal("3"))


class HalfDayLeaveAttendanceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.settings = PayrollSettings.get()
        cls.settings.attendance_mode = "simple"
        cls.settings.save()

        cls.shift = ShiftTemplate.objects.create(
            name="Half-Day Leave Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=15,
        )
        cls.emp = Employee.objects.create(
            employee_code="HDLTEST_EMP2", first_name="HalfDay", last_name="AttnTester",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, d, *times):
        from .models import AttendanceLog
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def _record(self, d, half_day_leave_dates=None):
        return compute_day_record(
            self.emp, d, settings=PayrollSettings.get(),
            leave_dates=set(), holiday_dates=set(),
            half_day_leave_dates=half_day_leave_dates,
        )

    def test_morning_slot_afternoon_arrival_counts_as_half_day_not_late(self):
        d = date(2026, 1, 5)  # Monday
        # 15:00 is after the default half_shift_late_reference_time (14:30) -
        # without the half-day-leave override this single punch would be
        # flagged "Late (Half Shift)" by the engine's own existing logic.
        self._punch(d, time(15, 0))
        r = self._record(d, half_day_leave_dates={d: LeaveRequest.HALF_DAY_MORNING})
        self.assertEqual(r.status, "half_shift")
        self.assertTrue(r.is_half_day_leave)
        self.assertEqual(r.shifts_earned, Decimal("0.50"))
        self.assertFalse(r.is_late)
        self.assertIsNone(r.late_reason)

    def test_afternoon_slot_ontime_morning_arrival_counts_as_half_day(self):
        d = date(2026, 1, 6)
        self._punch(d, time(9, 10))  # well before the 14:30 half-shift reference
        r = self._record(d, half_day_leave_dates={d: LeaveRequest.HALF_DAY_AFTERNOON})
        self.assertEqual(r.status, "half_shift")
        self.assertTrue(r.is_half_day_leave)
        self.assertEqual(r.shifts_earned, Decimal("0.50"))
        self.assertFalse(r.is_late)

    def test_afternoon_slot_does_not_suppress_engine_lateness(self):
        """The leave only excuses the afternoon absence, not a late arrival
        for the morning half the employee still owes -so a punch late enough
        to trip the engine's own existing half-shift lateness check must
        still come through as late, unlike the Morning-slot case above."""
        d = date(2026, 1, 7)
        self._punch(d, time(15, 0))  # after the 14:30 half-shift reference
        r = self._record(d, half_day_leave_dates={d: LeaveRequest.HALF_DAY_AFTERNOON})
        self.assertEqual(r.status, "half_shift")
        self.assertTrue(r.is_half_day_leave)
        self.assertTrue(r.is_late)

    def test_no_show_falls_through_to_absent_not_leave(self):
        d = date(2026, 1, 8)
        r = self._record(d, half_day_leave_dates={d: LeaveRequest.HALF_DAY_MORNING})
        self.assertEqual(r.status, "absent")
        self.assertEqual(r.shifts_earned, Decimal("0"))
        self.assertFalse(r.is_half_day_leave)

    def test_full_day_worked_anyway_wins_over_half_day_leave(self):
        """Punches always win -see the pre-existing on_leave convention this
        mirrors. Working the full day despite a half-day leave request
        should not be capped at half."""
        d = date(2026, 1, 9)
        self._punch(d, time(9, 5), time(18, 0))
        r = self._record(d, half_day_leave_dates={d: LeaveRequest.HALF_DAY_AFTERNOON})
        self.assertEqual(r.status, "present")
        self.assertFalse(r.is_half_day_leave)
        self.assertEqual(r.shifts_earned, Decimal("1.00"))

    def test_ordinary_day_without_half_day_leave_unaffected(self):
        d = date(2026, 1, 12)
        self._punch(d, time(9, 5), time(18, 0))
        r = self._record(d, half_day_leave_dates=None)
        self.assertEqual(r.status, "present")
        self.assertFalse(r.is_half_day_leave)
