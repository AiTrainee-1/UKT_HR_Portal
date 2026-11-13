"""Every stored attendance day follows its punches (attendance_refresh.py, 2026-11-13): a punch that arrives after its day
was judged gets that day judged again - right away on the paths that save punches for HR, and by the background pass
for anything else (a device's own push), staff and production, whatever the OT switches say.

Run via: python manage.py test api.tests_attendance_refresh
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import attendance_refresh
from .attendance_final import compute_day_record
from .biometric_sync import _ingest_punches
from .device_fetch import _bulk_writer
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeeShiftAssignment,
    PayrollSettings,
    ShiftTemplate,
)

TODAY = date(2026, 11, 5)
DAY = date(2026, 10, 20)  # a Tuesday inside the window (1 Oct to 5 Nov)
OLD_DAY = date(2026, 9, 15)  # before the window
FULL_DAY = (time(9, 5), time(13, 0), time(14, 0), time(18, 5))


class RefreshBase(TestCase):
    def setUp(self):
        patch = mock.patch("api.attendance_refresh.ist_today", return_value=TODAY)
        patch.start()
        self.addCleanup(patch.stop)
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.compensation_feature_enabled = False  # the refresh never depends on the OT / Compensation switches
        ps.save()
        self.shift = ShiftTemplate.objects.create(
            name="Refresh Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.emp = self.staff("RF1")

    def staff(self, code):
        emp = Employee.objects.create(
            employee_code=code,
            first_name="Ref",
            last_name=code,
            employment_type="staff",
            status="active",
            salary_amount=Decimal("26000"),
        )
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2026, 1, 1))
        return emp

    def punch(self, d, *times, emp=None):
        for t in times:
            AttendanceLog.objects.create(employee=emp or self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def judged_without_punches(self, d, emp=None):
        """The day as a screen stored it before any punch had arrived: Absent."""
        rec = compute_day_record(emp or self.emp, d, settings=PayrollSettings.get())
        self.assertEqual(rec.status, "absent")
        return rec

    def stored(self, d, emp=None):
        return AttendanceDayRecord.objects.get(employee=emp or self.emp, date=d)


class BackgroundPassTests(RefreshBase):
    def test_a_day_judged_before_its_punches_arrived_is_judged_again(self):
        self.judged_without_punches(DAY)
        self.punch(DAY, *FULL_DAY)
        self.assertEqual(self.stored(DAY).status, "absent", "nothing re-judged it yet: the bug")

        self.assertEqual(attendance_refresh.refresh_stale(), 1)

        rec = self.stored(DAY)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.arrival_zone, rec.is_late),
            ("present", Decimal("1.00"), "on_time", False),
        )

    def test_a_late_arrival_gets_its_late_mark_and_a_quarter_arrival_its_quarter(self):
        late, quarter = self.emp, self.staff("RF2")
        for emp in (late, quarter):
            self.judged_without_punches(DAY, emp)
        self.punch(DAY, time(9, 40), time(13, 0), time(14, 0), time(18, 5), emp=late)
        self.punch(DAY, time(10, 40), time(13, 0), time(14, 0), time(18, 5), emp=quarter)

        self.assertEqual(attendance_refresh.refresh_stale(), 2)

        rec = self.stored(DAY, late)
        self.assertEqual((rec.arrival_zone, rec.is_late, rec.shifts_earned), ("late", True, Decimal("1.00")))
        rec = self.stored(DAY, quarter)
        self.assertEqual((rec.arrival_zone, rec.is_late, rec.shifts_earned), ("quarter", False, Decimal("0.75")))

    def test_a_half_day_becomes_a_full_day_when_the_exit_punch_arrives_later(self):
        self.punch(DAY, time(9, 5))
        self.assertEqual(compute_day_record(self.emp, DAY, settings=PayrollSettings.get()).status, "half_shift")
        self.punch(DAY, time(18, 5))
        attendance_refresh.refresh_stale()
        self.assertEqual((self.stored(DAY).status, self.stored(DAY).shifts_earned), ("present", Decimal("1.00")))

    def test_a_day_nothing_new_arrived_for_is_not_touched(self):
        self.punch(DAY, *FULL_DAY)
        compute_day_record(self.emp, DAY, settings=PayrollSettings.get())
        # the first pass also stores the day before (a punch can be that day's exit made after midnight) ...
        attendance_refresh.refresh_stale()
        rec = self.stored(DAY)
        # ... after which a pass with nothing new touches nothing at all
        self.assertEqual(attendance_refresh.refresh_stale(), 0)
        self.assertEqual(self.stored(DAY).updated_at, rec.updated_at)

    def test_a_day_hr_set_by_hand_is_never_recomputed(self):
        self.judged_without_punches(DAY)
        AttendanceDayRecord.objects.filter(employee=self.emp, date=DAY).update(source="manual", status="absent")
        self.punch(DAY, *FULL_DAY)
        attendance_refresh.refresh_stale()
        self.assertEqual((self.stored(DAY).source, self.stored(DAY).status), ("manual", "absent"))

    def test_the_window_is_the_previous_month_to_today(self):
        self.assertEqual(attendance_refresh.window(date(2026, 11, 13)), (date(2026, 10, 1), date(2026, 11, 13)))
        self.assertEqual(attendance_refresh.window(date(2026, 1, 3)), (date(2025, 12, 1), date(2026, 1, 3)))
        self.judged_without_punches(OLD_DAY)
        self.punch(OLD_DAY, *FULL_DAY)
        attendance_refresh.refresh_stale()
        self.assertEqual(self.stored(OLD_DAY).status, "absent", "older than the window: left for a screen to re-judge")

    def test_production_days_are_kept_in_line_too(self):
        prod = Employee.objects.create(
            employee_code="RFP",
            first_name="Ref",
            last_name="Prod",
            employment_type="production",
            status="active",
        )
        compute_day_record(prod, DAY, settings=PayrollSettings.get())
        before = AttendanceDayRecord.objects.get(employee=prod, date=DAY)
        self.punch(DAY, time(8, 30), time(12, 30), time(13, 30), time(17, 30), emp=prod)
        self.assertEqual(attendance_refresh.refresh_stale(), 1)
        after = AttendanceDayRecord.objects.get(employee=prod, date=DAY)
        self.assertGreater(after.updated_at, before.updated_at)
        self.assertEqual(after.total_punches, 4)
        self.assertNotEqual(after.status, "absent")


class SavedPunchesTests(RefreshBase):
    def test_punches_written_by_sync_or_fetch_judge_their_day_at_once(self):
        self.judged_without_punches(DAY)
        result = _ingest_punches([("RF1", DAY, t, "IN") for t in FULL_DAY], None, "biometric:test")
        self.assertEqual(result["created"], 4)
        self.assertEqual((self.stored(DAY).status, self.stored(DAY).arrival_zone), ("present", "on_time"))

    def test_a_device_catch_up_stays_quick_and_the_background_pass_judges_its_days(self):
        self.judged_without_punches(DAY)
        write = _bulk_writer({"RF1": self.emp})
        result = write([("RF1", DAY, time(9, 40), "IN"), ("RF1", DAY, time(18, 5), "IN")], None, "biometric:fetch")
        self.assertEqual(result["created"], 2)
        self.assertEqual(self.stored(DAY).status, "absent", "the catch-up request itself re-judges nothing")
        self.assertEqual(attendance_refresh.refresh_stale(), 1)
        rec = self.stored(DAY)
        self.assertEqual((rec.status, rec.arrival_zone, rec.is_late), ("present", "late", True))

    def test_a_big_batch_is_left_to_the_background_pass(self):
        others = [self.staff(f"RB{i}") for i in range(attendance_refresh.INLINE_MAX_EMPLOYEES)]
        pairs = [(e.pk, DAY) for e in [self.emp, *others]]
        with self.assertLogs("api.attendance_refresh", level="INFO") as logs:
            self.assertEqual(attendance_refresh.refresh_after_punches(pairs), 0)
        self.assertIn("left to the background attendance refresh", logs.output[0])
        self.assertEqual(attendance_refresh.refresh_after_punches(pairs[:3]), 3, "a small batch is re-judged at once")

    def test_a_punch_after_midnight_judges_the_day_before_as_well(self):
        self.punch(DAY, time(9, 5), time(13, 0), time(14, 0))  # the exit was never punched that evening
        compute_day_record(self.emp, DAY, settings=PayrollSettings.get())
        self.assertEqual(self.stored(DAY).last_punch, time(14, 0))
        next_day = date(2026, 10, 21)
        self.punch(next_day, time(0, 40))  # the forgotten exit, made after midnight

        attendance_refresh.refresh_after_punches([(self.emp.pk, next_day)])

        self.assertEqual(self.stored(DAY).last_punch, time(0, 40))

    def test_future_dates_are_left_and_a_failure_never_raises(self):
        self.assertEqual(attendance_refresh.refresh_after_punches([(self.emp.pk, date(2026, 11, 6))]), 0)
        self.punch(DAY, *FULL_DAY)
        with mock.patch("api.attendance_final.compute_range_records", side_effect=RuntimeError("boom")):
            with self.assertLogs("api.attendance_refresh", level="ERROR"):
                self.assertEqual(attendance_refresh.refresh_after_punches([(self.emp.pk, DAY)]), 0)

    def test_dates_given_as_text_are_understood(self):
        self.judged_without_punches(DAY)
        self.punch(DAY, *FULL_DAY)
        self.assertEqual(attendance_refresh.refresh_after_punches([(self.emp.pk, DAY.isoformat())]), 1)
        self.assertEqual(self.stored(DAY).status, "present")


class TodayInProgressTests(RefreshBase):
    """Today, while the shift is still running, a morning arrival with no exit punch yet is at work, not a Half Day."""

    TODAY_REAL = date(2026, 11, 13)  # a Friday

    def at(self, hh, mm):
        from datetime import datetime

        for target, value in (
            ("api.attendance_final.ist_today", self.TODAY_REAL),
            ("api.attendance_final.ist_now", datetime(2026, 11, 13, hh, mm)),
        ):
            patch = mock.patch(target, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)

    def judge(self, d=None, **kwargs):
        return compute_day_record(self.emp, d or self.TODAY_REAL, settings=PayrollSettings.get(), **kwargs)

    def test_at_half_past_ten_someone_who_came_on_time_is_present_not_half_day(self):
        self.at(10, 30)
        self.punch(self.TODAY_REAL, time(9, 5))
        rec = self.judge()
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.is_half_shift, rec.arrival_zone, rec.is_late),
            ("present", Decimal("1.00"), False, "on_time", False),
        )

    def test_a_late_and_a_quarter_arrival_keep_their_marks_while_at_work(self):
        self.at(11, 0)
        self.punch(self.TODAY_REAL, time(9, 40))
        rec = self.judge()
        self.assertEqual(
            (rec.status, rec.arrival_zone, rec.is_late, rec.shifts_earned), ("present", "late", True, Decimal("1.00"))
        )
        quarter = self.staff("RFQ")
        self.punch(self.TODAY_REAL, time(10, 40), emp=quarter)
        rec = compute_day_record(quarter, self.TODAY_REAL, settings=PayrollSettings.get())
        self.assertEqual((rec.status, rec.arrival_zone, rec.shifts_earned), ("present", "quarter", Decimal("0.75")))

    def test_lunch_punches_do_not_end_it_but_the_end_of_the_shift_does(self):
        self.at(16, 0)
        self.punch(self.TODAY_REAL, time(9, 5), time(13, 0), time(14, 0))
        self.assertEqual(self.judge().status, "present")
        mock.patch.stopall()
        self.at(18, 10)  # 18:00 end + 10 min grace: still inside
        self.assertEqual(self.judge().status, "present")
        mock.patch.stopall()
        self.at(18, 11)  # past it, and still no exit punch: a Half Day, as before
        rec = self.judge()
        self.assertEqual((rec.status, rec.shifts_earned, rec.is_half_shift), ("half_shift", Decimal("0.50"), True))

    def test_another_day_is_never_in_progress(self):
        self.at(10, 30)
        yesterday = date(2026, 11, 12)
        self.punch(yesterday, time(9, 5))
        self.assertEqual(self.judge(yesterday).status, "half_shift")

    def test_a_second_half_arrival_is_still_a_half_day(self):
        self.at(15, 30)
        self.punch(self.TODAY_REAL, time(15, 0))
        rec = self.judge()
        self.assertEqual((rec.status, rec.arrival_zone), ("half_shift", "second_half"))

    def test_an_afternoon_half_day_leave_stays_a_half_day(self):
        from .models import LeaveRequest

        self.at(10, 30)
        self.punch(self.TODAY_REAL, time(9, 5))
        rec = self.judge(half_day_leave_dates={self.TODAY_REAL: LeaveRequest.HALF_DAY_AFTERNOON})
        self.assertEqual((rec.status, rec.is_half_day_leave), ("half_shift", True))
