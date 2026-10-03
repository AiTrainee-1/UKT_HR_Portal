"""
The employee attendance calendar (mobile app) colours a Sunday, a declared holiday and an approved Casual Leave
apart from a normal day. Both employee endpoints say which kind of day it is, for past AND future days:

    GET /api/attendance/employee/<id>?month=&year=       records[]
    GET /api/attendance/employee-shift-stats?month=&year=   dailyLogs[]

Keys (additive): dayKind ("holiday" | "weekly_off" | null), holidayName, holidayType, isCasualLeave.

Run via: python manage.py test api.tests_attendance_day_kinds -v 2

Pinned: October 2026. 1-Oct is a Thursday, 2-Oct (Gandhi Jayanti) a declared holiday, 4-Oct a Sunday, 11-Oct a Sunday that is
ALSO a declared holiday (the holiday wins), 15-Oct an approved Casual Leave, 16-Oct a pending one.
"""

from datetime import date
from unittest.mock import patch

from django.test import TestCase

from .jwt_utils import sign_token
from .models import CasualLeaveRequest, Employee, Holiday

TODAY = date(2026, 10, 6)  # a Tuesday; 15-Oct is in the future, 1-Oct in the past


def _token(emp_id: int) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp_id})}"}


class DayKindTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = Employee.objects.create(
            employee_code="DK1", first_name="Sita", last_name="Staff", employment_type="staff", join_date="2025-01-01"
        )
        cls.prod = Employee.objects.create(
            employee_code="DK2",
            first_name="Prem",
            last_name="Prod",
            employment_type="production",
            join_date="2025-01-01",
        )
        Holiday.objects.create(name="Gandhi Jayanti", date=date(2026, 10, 2), holiday_type="national")
        Holiday.objects.create(name="Founders Day", date=date(2026, 10, 11), holiday_type="company")  # a Sunday
        Holiday.objects.create(name="September holiday", date=date(2026, 9, 14), holiday_type="regional")
        CasualLeaveRequest.objects.create(employee=cls.staff, date=date(2026, 10, 15), status="approved")
        CasualLeaveRequest.objects.create(employee=cls.staff, date=date(2026, 10, 16), status="pending")
        CasualLeaveRequest.objects.create(employee=cls.staff, date=date(2026, 10, 19), status="rejected")

    def setUp(self):
        for target in ("api.clock.ist_today", "api.attendance_views.ist_today", "api.attendance_final.ist_today"):
            p = patch(target, return_value=TODAY)
            p.start()
            self.addCleanup(p.stop)

    def history(self, emp, month=10) -> dict:
        r = self.client.get(f"/api/attendance/employee/{emp.id}?month={month}&year=2026", **_token(emp.id))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {x["date"]: x for x in r.json()["records"]}

    def stats(self, emp, month=10) -> dict:
        r = self.client.get(f"/api/attendance/employee-shift-stats?month={month}&year=2026", **_token(emp.id))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {x["date"]: x for x in r.json()["dailyLogs"]}

    def kinds(self, days: dict, *dates) -> list:
        return [days[d]["dayKind"] for d in dates]

    def test_a_declared_holiday_carries_its_name_and_type_past_and_future(self):
        for days in (self.history(self.staff), self.stats(self.staff)):
            d = days["2026-10-02"]
            self.assertEqual(
                (d["dayKind"], d["holidayName"], d["holidayType"]), ("holiday", "Gandhi Jayanti", "national")
            )
        # a holiday that has not happened yet is still described
        Holiday.objects.create(name="Diwali", date=date(2026, 10, 29), holiday_type="national")
        from .attendance_final import _holiday_dates_for_month

        _holiday_dates_for_month.cache_clear()
        for days in (self.history(self.staff), self.stats(self.staff)):
            self.assertEqual((days["2026-10-29"]["dayKind"], days["2026-10-29"]["holidayName"]), ("holiday", "Diwali"))

    def test_a_sunday_is_weekly_off_for_staff_but_a_working_day_for_production(self):
        for days in (self.history(self.staff), self.stats(self.staff)):
            self.assertEqual(
                self.kinds(days, "2026-10-04", "2026-10-18", "2026-10-25"), ["weekly_off"] * 3
            )  # incl. future
            self.assertIsNone(days["2026-10-04"]["holidayName"])
        for days in (self.history(self.prod), self.stats(self.prod)):
            self.assertEqual(self.kinds(days, "2026-10-04", "2026-10-18"), [None, None])

    def test_a_holiday_on_a_sunday_is_the_holiday(self):
        for emp in (self.staff, self.prod):
            for days in (self.history(emp), self.stats(emp)):
                d = days["2026-10-11"]
                self.assertEqual(
                    (d["dayKind"], d["holidayName"], d["holidayType"]), ("holiday", "Founders Day", "company")
                )

    def test_an_ordinary_weekday_has_no_kind(self):
        for days in (self.history(self.staff), self.stats(self.staff)):
            d = days["2026-10-01"]
            self.assertEqual(
                (d["dayKind"], d["holidayName"], d["holidayType"], d["isCasualLeave"]), (None, None, None, False)
            )

    def test_only_an_approved_casual_leave_is_flagged(self):
        for days in (self.history(self.staff), self.stats(self.staff)):
            self.assertTrue(days["2026-10-15"]["isCasualLeave"])
            self.assertFalse(days["2026-10-16"]["isCasualLeave"])  # pending
            self.assertFalse(days["2026-10-19"]["isCasualLeave"])  # rejected
        for days in (self.history(self.prod), self.stats(self.prod)):
            self.assertFalse(days["2026-10-15"]["isCasualLeave"])  # another employee's day

    def test_holidays_of_other_months_are_not_mixed_in(self):
        for days in (self.history(self.staff), self.stats(self.staff)):
            self.assertNotIn("2026-09-14", days)
        sept = self.history(self.staff, month=9)
        self.assertEqual(
            (sept["2026-09-14"]["dayKind"], sept["2026-09-14"]["holidayName"]), ("holiday", "September holiday")
        )

    def test_the_existing_keys_are_untouched(self):
        d = self.history(self.staff)["2026-10-04"]
        for key in ("date", "status", "isLate", "isEarlyOut", "isHalfShift", "firstPunch", "lastPunch", "present"):
            self.assertIn(key, d)
        self.assertEqual(d["status"], "holiday")  # the engine's verdict for a Sunday is unchanged

    def test_the_extra_lookups_are_two_queries_whatever_the_number_of_holidays(self):
        from .attendance_final import day_calendar_facts, day_kind_json

        with self.assertNumQueries(2):
            holidays, casual = day_calendar_facts(self.staff, 2026, 10)
        for day in (6, 7, 8, 9, 12, 13, 14):
            Holiday.objects.create(name=f"H{day}", date=date(2026, 10, day), holiday_type="company")
        with self.assertNumQueries(2):
            holidays, casual = day_calendar_facts(self.staff, 2026, 10)
        self.assertEqual(len(holidays), 9)  # the 2 existing + 7 new
        with self.assertNumQueries(0):  # classifying a day never queries
            for day in range(1, 32):
                day_kind_json(self.staff, date(2026, 10, day), holidays, casual)
