"""The attendance calendar of the payroll details page beyond the stored breakdown (payroll_calendar.py): holiday names, Casual
Leave, Sunday work, Late In / Early Out, the compensation type, where an On-Duty request stands, the Sync (live) read, and the
whole-salary split-up. Everything is read; nothing is written."""

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from django.test import TestCase

from .attendance_final import compute_day_record
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    Holiday,
    HolidayWorkClaim,
    OnDutyPunchVerification,
    OnDutySession,
    Payroll,
)
from .payroll_calendar import calendar_extras
from .payroll_insights import salary_breakup

IST = timezone(timedelta(hours=5, minutes=30))
START, END = date(2026, 2, 1), date(2026, 2, 28)


def _employee(code: str, salary="24000.00") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        salary_type="monthly",
        salary_amount=Decimal(salary),
    )


def _stored(day: date, status="absent", shifts=0.0) -> dict:
    return {
        "date": day.isoformat(),
        "day": day.strftime("%A"),
        "status": status,
        "firstIn": None,
        "lastOut": None,
        "shifts": shifts,
        "flags": [],
        "note": None,
        "marks": [],
    }


def _record(emp, day: date, status="present", shifts="1.00", **fields):
    return AttendanceDayRecord.objects.create(
        employee=emp, date=day, status=status, shifts_earned=Decimal(shifts), source="manual", **fields
    )


def _session(emp, status, day: date, **extra):
    started = datetime.combine(day, time(9, 0), tzinfo=IST)
    return OnDutySession.objects.create(
        employee=emp,
        destination="Buyer visit",
        status=status,
        started_at=started if status in ("active", "completed") else None,
        completed_at=datetime.combine(day, time(18, 0), tzinfo=IST) if status == "completed" else None,
        **extra,
    )


class CalendarExtrasTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.emp = _employee("C1")
        Holiday.objects.create(name="Republic Day", date=date(2026, 2, 3))

    def extras(self, days, live=False, emp=None):
        return calendar_extras(emp or self.emp, START, END, days, live=live)

    def test_a_holiday_carries_its_own_name_and_a_sunday_is_the_weekly_off(self):
        _days, off, _sync = self.extras([_stored(date(2026, 2, 2), "present", 1.0)])
        by_date = {o["date"]: o for o in off}
        self.assertEqual((by_date["2026-02-03"]["kind"], by_date["2026-02-03"]["name"]), ("holiday", "Republic Day"))
        self.assertEqual(by_date["2026-02-01"]["kind"], "weekly_off")  # 1 Feb 2026 is a Sunday
        self.assertIsNone(by_date["2026-02-01"]["attendance"])
        self.assertNotIn("2026-02-02", by_date)  # a listed day is not an off day

    def test_a_sunday_that_was_worked_shows_the_real_attendance_not_a_holiday(self):
        _record(self.emp, date(2026, 2, 8), is_late=True)  # a Sunday
        _days, off, _sync = self.extras([])
        sunday = next(o for o in off if o["date"] == "2026-02-08")
        self.assertEqual(sunday["kind"], "weekly_off")
        attendance = sunday["attendance"]
        self.assertEqual(attendance["status"], "present")
        self.assertTrue(attendance["workedOffDay"])
        self.assertTrue(attendance["isLate"])
        self.assertEqual(attendance["shifts"], 1.0)

    def test_an_approved_casual_leave_day_is_flagged_and_a_pending_one_is_not(self):
        CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 2, 4), status="approved", reason="x")
        CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 2, 5), status="pending", reason="x")
        days, _off, _sync = self.extras([_stored(date(2026, 2, 4), "present", 1.0), _stored(date(2026, 2, 5))])
        self.assertEqual([d["casualLeave"] for d in days], [True, False])

    def test_late_in_and_early_out_are_separate_flags(self):
        _record(self.emp, date(2026, 2, 4), is_late=True)
        _record(self.emp, date(2026, 2, 5), early_leave=True)
        days, _off, _sync = self.extras(
            [_stored(date(2026, 2, 4), "present", 1.0), _stored(date(2026, 2, 5), "present", 1.0)]
        )
        self.assertEqual([(d["isLate"], d["isEarlyOut"]) for d in days], [(True, False), (False, True)])

    def test_the_compensation_behind_a_day_is_one_of_the_three_types(self):
        _record(
            self.emp,
            date(2026, 2, 4),
            compensation_kind="relaxation",
            compensation_note="Sunday Compensation (0.50 shift) approved",
        )
        _record(
            self.emp,
            date(2026, 2, 5),
            compensation_kind="relaxation",
            compensation_note="OT Compensation (1.00 shift) approved",
        )
        _record(
            self.emp,
            date(2026, 2, 6),
            compensation_kind="relaxation",
            compensation_note="Compensation (0.25 shift) approved",
        )
        HolidayWorkClaim.objects.create(
            employee=self.emp, work_date=date(2026, 2, 9), shifts=Decimal("1.00"), status="approved"
        )
        days = [_stored(date(2026, 2, d), "present", 1.0) for d in (4, 5, 6, 9, 10)]
        for d in days:
            d["compensationKind"] = None
            d["compensationNote"] = None
        got, _off, _sync = self.extras(days)
        self.assertEqual(
            [d["compensationType"] for d in got],
            ["sunday_compensation", "ot_compensation", "compensation", "sunday_compensation", None],
        )


class OnDutyStatesTests(TestCase):
    """An On-Duty request counts as worked only when HR approved it AND the punches are there."""

    @classmethod
    def setUpTestData(cls):
        cls.emp = _employee("O1")

    def state(self, day: date):
        days, off, _sync = calendar_extras(self.emp, START, END, [_stored(day)], live=False)
        return days[0]["onDuty"]

    def test_a_request_still_awaiting_approval_is_not_a_worked_day(self):
        _session(self.emp, "pending_hod", date(2026, 2, 10))
        _session(self.emp, "pending_hr", date(2026, 2, 11))
        # created_at is now: pin it to the days
        OnDutySession.objects.filter(status="pending_hod").update(created_at=datetime(2026, 2, 10, 9, tzinfo=IST))
        OnDutySession.objects.filter(status="pending_hr").update(created_at=datetime(2026, 2, 11, 9, tzinfo=IST))
        self.assertEqual(self.state(date(2026, 2, 10))["state"], "pending")
        self.assertEqual(self.state(date(2026, 2, 11))["state"], "pending")

    def test_a_rejected_request_says_so(self):
        _session(self.emp, "rejected", date(2026, 2, 12))
        OnDutySession.objects.filter(status="rejected").update(created_at=datetime(2026, 2, 12, 9, tzinfo=IST))
        self.assertEqual(self.state(date(2026, 2, 12))["state"], "rejected")

    def test_approved_without_punches_is_not_verified_and_the_day_is_not_present(self):
        _session(self.emp, "completed", date(2026, 2, 13))
        self.assertEqual(self.state(date(2026, 2, 13))["state"], "no_punches")
        # the attendance engine itself never makes a day present from the request alone
        record = compute_day_record(self.emp, date(2026, 2, 13))
        self.assertEqual(record.status, "absent")

    def test_approved_with_punches_waiting_for_hr_is_not_verified_yet(self):
        session = _session(self.emp, "completed", date(2026, 2, 16))
        OnDutyPunchVerification.objects.create(
            session=session,
            employee=self.emp,
            punch_date=date(2026, 2, 16),
            punch_time=time(9, 30),
            punch_type="IN",
            punch_number=1,
            latitude=11.0,
            longitude=77.0,
            status="pending",
        )
        self.assertEqual(self.state(date(2026, 2, 16))["state"], "punches_pending")
        self.assertEqual(compute_day_record(self.emp, date(2026, 2, 16)).status, "absent")

    def test_approved_with_an_approved_punch_is_verified(self):
        _session(self.emp, "completed", date(2026, 2, 17))
        AttendanceLog.objects.create(
            employee=self.emp,
            date=date(2026, 2, 17),
            punch_time=time(9, 30),
            punch_type="IN",
            source="on_duty:approved",
        )
        self.assertEqual(self.state(date(2026, 2, 17))["state"], "verified")


class LiveSyncTests(TestCase):
    """Sync re-reads the listed days from the attendance records as they stand now; nothing is written."""

    @classmethod
    def setUpTestData(cls):
        cls.emp = _employee("L1")

    def test_a_day_approved_after_the_payroll_was_generated_shows_after_sync_and_counts_as_changed(self):
        day = date(2026, 2, 4)
        # the payroll counted the day as absent; HR / HOD approval since made it a present day
        _record(self.emp, day, status="present", shifts="1.00")
        payrolls = Payroll.objects.count()
        stored, _off, sync = calendar_extras(self.emp, START, END, [_stored(day)], live=False)
        self.assertEqual((stored[0]["status"], sync["live"]), ("absent", False))
        live, _off, sync = calendar_extras(self.emp, START, END, [_stored(day)], live=True)
        self.assertEqual((live[0]["status"], live[0]["shifts"]), ("present", 1.0))
        self.assertEqual((sync["live"], sync["changedDays"]), (True, 1))
        self.assertIsNotNone(sync["syncedAt"])
        self.assertEqual(Payroll.objects.count(), payrolls)  # the payroll is never written

    def test_a_day_that_did_not_change_is_not_counted(self):
        day = date(2026, 2, 4)
        _record(self.emp, day, status="present", shifts="1.00")
        _days, _off, sync = calendar_extras(self.emp, START, END, [_stored(day, "present", 1.0)], live=True)
        self.assertEqual(sync["changedDays"], 0)


class SalaryBreakupTests(TestCase):
    def test_the_whole_salary_and_the_earned_salary_each_add_up_exactly(self):
        emp = _employee("S1", "15000.00")
        payroll = Payroll(
            employee=emp, gross_salary=Decimal("13557.69"), ot_amount=Decimal("0"), base_salary=Decimal("15000")
        )
        out = salary_breakup(emp, payroll, {"earnings": {"grossSalary": 13557.69}})
        self.assertEqual(out["monthly"], 15000.0)
        self.assertAlmostEqual(sum(c["full"] for c in out["components"]), 15000.0, places=2)
        self.assertAlmostEqual(sum(c["earned"] for c in out["components"]), 13557.69, places=2)
        self.assertAlmostEqual(out["firstPortion"]["full"] + out["secondPortion"]["full"], 15000.0, places=2)
        self.assertAlmostEqual(out["firstPortion"]["earned"] + out["secondPortion"]["earned"], 13557.69, places=2)
        self.assertEqual(len(out["components"]), 8)
        self.assertFalse(out["recorded"])  # no split recorded: the automatic one

    def test_production_staff_and_unsalaried_employees_have_none(self):
        prod = _employee("S2")
        prod.employment_type = "production"
        self.assertIsNone(salary_breakup(prod, Payroll(employee=prod), None))
        none = _employee("S3")
        none.salary_amount = None
        self.assertIsNone(salary_breakup(none, Payroll(employee=none), None))
