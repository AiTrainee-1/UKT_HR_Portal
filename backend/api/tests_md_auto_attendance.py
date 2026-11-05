"""
MD auto attendance (owner 2026-11-05): employees 2671 and 1 of the MD department get Full-Day Present IN / OUT punches,
randomised inside their own shift, for every working day of the month, by a job that runs every day at 8 PM.

Calendar: February 2026 (it starts on a Sunday: 24 Mon-Sat days). Shift 09:00-20:00 with 11 minutes' grace, like the real
MD shift. Run via:
    DATABASE_URL= DB_TEST_NAME=uktex_test_mdauto python manage.py test api.tests_md_auto_attendance
"""

import os
import random
from datetime import date, datetime, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import md_auto_attendance as M
from . import md_auto_attendance_scheduler as scheduler_module
from .geo_attendance_views import source_label
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    LeaveRequest,
    PayrollSettings,
    ShiftTemplate,
)
from .payroll_views import _generate_staff_payroll

FEB = [date(2026, 2, d) for d in range(1, 29)]
WORKING = [d for d in FEB if d.weekday() != 6]  # 24 days
END_OF_FEB = datetime(2026, 2, 28, 23, 59, 59)


def _secs(t: time) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


class Base(TestCase):
    def setUp(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.save()
        self.branch = Branch.objects.create(name="MD Test Unit", code="MDT")
        self.md = Department.objects.create(name="MD", branch=self.branch)
        self.admin_d = Department.objects.create(name="ADMIN", branch=self.branch)
        self.shift = ShiftTemplate.objects.create(
            name="Regular Shift males", shift_type="staff", start_time=time(9, 0), end_time=time(20, 0),
            grace_period_minutes=11, first_half_end=time(14, 0), lunch_duration_minutes=60,
        )  # fmt: skip
        self.karan = self.staff("1", "KARAN", self.md)
        self.sandhya = self.staff("2671", "SANDHYA", self.md)
        self.other = self.staff("2316", "MEENATCHI", self.admin_d)

    def staff(self, code, first, dept, **kw):
        emp = Employee.objects.create(
            employee_code=code, first_name=first, last_name="T", employment_type="staff", status="active",
            salary_type="monthly", salary_amount=Decimal("27000"), department=dept, branch=self.branch,
            join_date="2020-01-01", **kw,
        )  # fmt: skip
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2020, 1, 1))
        return emp

    def run_feb(self, **kw):
        return M.run(now=kw.pop("now", END_OF_FEB), first=date(2026, 2, 1), **kw)

    def days(self, emp) -> list[date]:
        return sorted(set(AttendanceLog.objects.filter(employee=emp, source=M.SOURCE).values_list("date", flat=True)))


class FillTests(Base):
    def test_every_working_day_gets_one_in_and_one_out_inside_the_shift(self):
        summary = self.run_feb()
        self.assertEqual(summary["punches"], 2 * 24 * 2)
        for emp in (self.karan, self.sandhya):
            self.assertEqual(self.days(emp), WORKING)  # Sundays left alone
            for d in WORKING:
                logs = list(AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time"))
                self.assertEqual(
                    [(log.punch_type, log.source) for log in logs], [("IN", "auto:md"), ("OUT", "auto:md")]
                )
                first, last = (_secs(log.punch_time) for log in logs)
                self.assertTrue(_secs(time(8, 45)) <= first <= _secs(time(9, 10, 59)), (d, logs[0].punch_time))
                self.assertTrue(_secs(time(19, 49)) <= last <= _secs(time(20, 10)), (d, logs[1].punch_time))

    def test_the_days_read_full_day_present_never_late_or_early(self):
        self.run_feb()
        records = AttendanceDayRecord.objects.filter(employee=self.karan, date__in=WORKING)
        self.assertEqual(records.count(), 24)
        for r in records:
            self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")), r.date)
            self.assertFalse(r.is_late or r.early_leave or r.is_half_shift, r.date)

    def test_the_times_look_natural_not_identical(self):
        self.run_feb()
        ins = set(
            AttendanceLog.objects.filter(employee=self.karan, punch_type="IN").values_list("punch_time", flat=True)
        )
        self.assertGreater(len(ins), 15)  # 24 days, different times

    def test_nobody_else_is_touched(self):
        self.run_feb()
        self.assertFalse(AttendanceLog.objects.filter(employee=self.other).exists())
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.other).exists())

    def test_running_again_adds_nothing(self):
        self.run_feb()
        before = list(AttendanceLog.objects.order_by("id").values_list("id", "punch_time"))
        self.assertEqual(self.run_feb()["punches"], 0)
        self.assertEqual(list(AttendanceLog.objects.order_by("id").values_list("id", "punch_time")), before)

    def test_a_full_month_pays_as_present_every_working_day(self):
        self.run_feb()
        payroll = _generate_staff_payroll(self.karan, 2, 2026)["payroll"]
        self.assertEqual(payroll.present_days, Decimal("24"))
        self.assertEqual((payroll.deductions, payroll.final_salary), (Decimal("0.00"), Decimal("27000.00")))


class SkipTests(Base):
    def test_holidays_and_saturdays_off_are_left_alone(self):
        Holiday.objects.create(name="Company day", date=date(2026, 2, 16), holiday_type="company")
        EmployeeShiftAssignment.objects.filter(employee=self.sandhya).update(saturday_off=True)
        self.run_feb()
        self.assertNotIn(date(2026, 2, 16), self.days(self.karan))
        self.assertEqual(len(self.days(self.karan)), 23)
        self.assertFalse([d for d in self.days(self.sandhya) if d.weekday() == 5])
        self.assertEqual(len(self.days(self.sandhya)), 19)  # 24 - 4 Saturdays - the holiday

    def test_a_day_with_its_own_attendance_is_never_touched(self):
        k = self.karan
        AttendanceLog.objects.create(employee=k, date=date(2026, 2, 2), punch_time=time(9, 30), punch_type="IN",
                                     source="biometric")  # fmt: skip
        AttendanceDayRecord.objects.create(employee=k, date=date(2026, 2, 3), status="absent", source="manual")
        Attendance.objects.create(employee=k, date="2026-02-04", present=True)
        LeaveRequest.objects.create(employee=k, type="sick", start_date="2026-02-05", end_date="2026-02-06",
                                    status="approved", reason="x")  # fmt: skip
        LeaveRequest.objects.create(employee=k, type="sick", start_date="2026-02-07", end_date="2026-02-07",
                                    status="approved", reason="x", is_half_day=True, half_day_slot="morning")  # fmt: skip
        CasualLeaveRequest.objects.create(employee=k, date=date(2026, 2, 9), status="approved")
        self.run_feb()
        untouched = {date(2026, 2, d) for d in (2, 3, 4, 5, 6, 7, 9)}
        self.assertFalse(untouched & set(self.days(k)))
        self.assertEqual(len(self.days(k)), 24 - 7)
        self.assertEqual(
            AttendanceLog.objects.filter(employee=k, date=date(2026, 2, 2)).count(), 1
        )  # the real punch only

    def test_days_before_joining_are_left_alone(self):
        Employee.objects.filter(pk=self.sandhya.pk).update(join_date="2026-02-16")
        self.run_feb()
        self.assertEqual(self.days(self.sandhya)[0], date(2026, 2, 16))

    def test_only_active_md_staff_on_the_list(self):
        Employee.objects.filter(pk=self.sandhya.pk).update(department=self.admin_d)  # moved out of MD
        Employee.objects.filter(pk=self.karan.pk).update(status="inactive")
        self.assertEqual(self.run_feb()["punches"], 0)
        self.assertFalse(AttendanceLog.objects.exists())

    def test_the_list_can_be_changed_without_a_code_change(self):
        self.staff("9001", "NEW MD", self.md)
        with mock.patch.dict(os.environ, {"MD_AUTO_ATTENDANCE_CODES": "9001"}):
            summary = self.run_feb()
        self.assertEqual(list(summary["employees"]), ["9001"])
        self.assertFalse(AttendanceLog.objects.filter(employee__in=(self.karan, self.sandhya)).exists())

    def test_a_dry_run_writes_nothing(self):
        summary = self.run_feb(dry_run=True)
        self.assertEqual(summary["punches"], 96)
        self.assertFalse(AttendanceLog.objects.exists())


class TodayTests(Base):
    def test_today_is_filled_only_after_the_shift_and_never_a_future_day(self):
        noon = datetime(2026, 2, 18, 12, 0)
        self.run_feb(now=noon)
        self.assertEqual(self.days(self.karan)[-1], date(2026, 2, 17))  # the 18th is not over; the 19th has not come
        at_eight = datetime(2026, 2, 18, 20, 0, 5)
        self.run_feb(now=at_eight)
        self.assertEqual(self.days(self.karan)[-1], date(2026, 2, 18))
        out = AttendanceLog.objects.get(employee=self.karan, date=date(2026, 2, 18), punch_type="OUT").punch_time
        self.assertLess(out, time(20, 0, 5))  # never a punch after the run itself
        self.assertGreaterEqual(out, time(19, 49))  # still not an Early-Out

    def test_punch_pair_respects_the_late_early_and_overtime_limits(self):
        shift = ShiftTemplate(start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=0)
        for seed in range(200):
            pair = M.punch_pair(shift, date(2026, 2, 2), END_OF_FEB, random.Random(seed), ot_threshold_minutes=5)
            first, last = pair
            self.assertLessEqual(first.replace(second=0), time(9, 0))  # 0 grace: on time means by 09:00
            self.assertTrue(time(18, 0) <= last <= time(18, 4), last)  # no early-out, under a 5-minute OT threshold
        self.assertIsNone(M.punch_pair(ShiftTemplate(start_time=time(20, 0), end_time=time(6, 0)), date(2026, 2, 2),
                                       END_OF_FEB, random.Random(1)))  # fmt: skip


class ScheduleTests(TestCase):
    def test_the_job_runs_every_day_at_8_pm_ist(self):
        added = {}

        class FakeScheduler:
            def add_job(self, func, trigger, **kw):
                added.update(func=func, trigger=trigger, **kw)

        scheduler_module.add_job(FakeScheduler())
        self.assertEqual((added["trigger"], added["hour"], added["minute"]), ("cron", 20, 0))
        self.assertEqual(added["timezone"], "Asia/Kolkata")
        self.assertEqual(added["id"], "md_auto_attendance")
        self.assertEqual((added["max_instances"], added["coalesce"]), (1, True))

    def test_the_punches_read_auto_attendance_everywhere(self):
        self.assertEqual(source_label("auto:md"), "Auto Attendance")


class StartDateTests(Base):
    """Owner 2026-11-05: count the attendance from 1 January 2026."""

    def test_attendance_is_filled_from_1_january_2026(self):
        self.assertEqual(M.start_date(), date(2026, 1, 1))
        M.run(now=END_OF_FEB)  # no `first`: from the start date
        days = self.days(self.sandhya)
        january = [date(2026, 1, d) for d in range(1, 32) if date(2026, 1, d).weekday() != 6]
        self.assertEqual(days, january + WORKING)
        self.assertEqual(days[0], date(2026, 1, 1))
        self.assertFalse(AttendanceLog.objects.filter(date__lt=date(2026, 1, 1)).exists())
        self.assertEqual(M.run(now=END_OF_FEB)["punches"], 0)  # later runs only add the new day

    def test_the_start_date_can_be_changed_without_a_code_change(self):
        with mock.patch.dict(os.environ, {"MD_AUTO_ATTENDANCE_START": "2026-02-16"}):
            self.assertEqual(M.start_date(), date(2026, 2, 16))
            M.run(now=END_OF_FEB)
        self.assertEqual(self.days(self.karan)[0], date(2026, 2, 16))
        with mock.patch.dict(os.environ, {"MD_AUTO_ATTENDANCE_START": "16/02/2026"}):
            self.assertEqual(M.start_date(), date(2026, 1, 1))  # unreadable: the default

    def test_a_day_before_the_first_shift_assignment_is_timed_by_that_shift(self):
        # Karan's shift is only assigned from 16 Feb (like the real one, from 1 Oct 2026): the days before still count
        EmployeeShiftAssignment.objects.filter(employee=self.karan).update(effective_from=date(2026, 2, 16))
        self.run_feb()
        self.assertEqual(self.days(self.karan), WORKING)
        first = AttendanceLog.objects.get(employee=self.karan, date=date(2026, 2, 2), punch_type="IN").punch_time
        last = AttendanceLog.objects.get(employee=self.karan, date=date(2026, 2, 2), punch_type="OUT").punch_time
        self.assertTrue(time(8, 45) <= first <= time(9, 10, 59) and time(19, 49) <= last <= time(20, 10), (first, last))
        record = AttendanceDayRecord.objects.get(employee=self.karan, date=date(2026, 2, 2))
        self.assertEqual((record.status, record.shifts_earned), ("present", Decimal("1.00")))

    def test_an_employee_with_no_shift_at_all_is_skipped(self):
        EmployeeShiftAssignment.objects.filter(employee=self.karan).delete()
        self.run_feb()
        self.assertEqual(self.days(self.karan), [])
        self.assertEqual(self.days(self.sandhya), WORKING)
