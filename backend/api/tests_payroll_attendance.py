"""
Money-adjacent attendance/payroll logic that previously had no dedicated
coverage: the month/range attendance engine's aggregation and bulk-prefetch
behaviour, the legacy salary-record calculator, the holiday cache, the
Attendance Sheet endpoint's half-day period, and the auth on session-configs.

Run via: python manage.py test api.tests_payroll_attendance -v 2
"""
from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIRequestFactory

from .attendance_final import (
    _compensation_day_for, _compensation_days_by_date, _holiday_dates_for_month,
    compute_month_records, compute_range_records, month_summary_from_records,
)
from .attendance_views import attendance_report_log_sheet
from .jwt_utils import sign_token
from .leave_views import holiday_detail, holidays
from .models import (
    Attendance, AttendanceLog, CompensationDayAnnouncement, Department, Employee,
    EmployeeShiftAssignment, Holiday, PayrollSettings, SalaryRecord, ShiftTemplate,
)
from .payroll_views import session_configs
from .views import _month_attendance_counts, calculate_salary_records


def _hr_headers():
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': 1})}"}


class MonthSummaryFromRecordsTests(TestCase):
    def _rec(self, status, late=False, half=False, shifts="1.00"):
        return SimpleNamespace(
            status=status, is_late=late, is_half_shift=half, shifts_earned=Decimal(shifts),
        )

    def test_counts_and_effective_days(self):
        records = [
            self._rec("present"), self._rec("present", late=True),
            self._rec("half_shift", half=True, shifts="0.50"),
            self._rec("absent", shifts="0"), self._rec("on_leave", shifts="0"),
            self._rec("holiday", shifts="0"),
        ]
        s = month_summary_from_records(records)
        self.assertEqual(s["totalDays"], 6)
        self.assertEqual(s["workingDays"], 5)  # holiday excluded
        self.assertEqual(s["present"], 2)
        self.assertEqual(s["halfShift"], 1)
        self.assertEqual(s["absent"], 1)
        self.assertEqual(s["onLeave"], 1)
        self.assertEqual(s["holidays"], 1)
        self.assertEqual(s["late"], 1)
        self.assertEqual(Decimal(s["totalShifts"]), Decimal("2.50"))
        # Effective attendance = full presents + 0.5 x halves
        self.assertEqual(Decimal(s["effectiveDays"]), Decimal("2.5"))

    def test_empty_month(self):
        s = month_summary_from_records([])
        self.assertEqual(s["totalDays"], 0)
        self.assertEqual(Decimal(s["effectiveDays"]), Decimal("0"))


class SalaryRecordCalculationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.monthly = Employee.objects.create(
            employee_code="PAYTEST_M", first_name="Monthly", last_name="Emp",
            employment_type="staff", status="active",
            salary_type="monthly", salary_amount=Decimal("26000.00"),
        )
        cls.weekly = Employee.objects.create(
            employee_code="PAYTEST_W", first_name="Weekly", last_name="Emp",
            employment_type="production", status="active",
            salary_type="weekly", salary_amount=Decimal("6000.00"),
        )
        cls.no_attendance = Employee.objects.create(
            employee_code="PAYTEST_N", first_name="No", last_name="Attendance",
            employment_type="staff", status="active",
            salary_type="monthly", salary_amount=Decimal("30000.00"),
        )
        for d, present in (("2026-01-01", True), ("2026-01-02", True), ("2026-01-03", False)):
            Attendance.objects.create(employee=cls.monthly, date=d, present=present)
        Attendance.objects.create(employee=cls.weekly, date="2026-01-05", present=True)
        # A different month must never leak into January's counts.
        Attendance.objects.create(employee=cls.monthly, date="2026-02-01", present=True)

    def test_counts_are_grouped_per_employee_and_month(self):
        counts = _month_attendance_counts("2026-01")
        self.assertEqual(counts[self.monthly.id], (2, 3))
        self.assertEqual(counts[self.weekly.id], (1, 1))
        self.assertNotIn(self.no_attendance.id, counts)

    def test_counts_use_one_query_regardless_of_employee_count(self):
        with CaptureQueriesContext(connection) as ctx:
            _month_attendance_counts("2026-01")
        attendance_queries = [q for q in ctx.captured_queries if 'FROM "attendance"' in q["sql"]]
        self.assertEqual(len(attendance_queries), 1)

    def _calculate(self):
        req = APIRequestFactory().post(
            "/api/salary/calculate", {"month": 1, "year": 2026}, format="json", **_hr_headers(),
        )
        return calculate_salary_records(req)

    def test_monthly_amount_is_26_day_rate_times_present_days(self):
        self.assertEqual(self._calculate().status_code, 200)
        rec = SalaryRecord.objects.get(employee=self.monthly, month=1, year=2026)
        self.assertEqual(rec.amount, Decimal("2000.00"))  # 26000 / 26 * 2 present

    def test_weekly_amount_is_6_day_rate_times_present_days(self):
        self._calculate()
        rec = SalaryRecord.objects.get(employee=self.weekly, month=1, year=2026)
        self.assertEqual(rec.amount, Decimal("1000.00"))  # 6000 / 6 * 1 present

    def test_employee_without_attendance_is_skipped(self):
        self._calculate()
        self.assertFalse(SalaryRecord.objects.filter(employee=self.no_attendance).exists())

    def test_rerun_updates_instead_of_duplicating(self):
        self._calculate()
        Attendance.objects.filter(employee=self.monthly, date="2026-01-03").update(present=True)
        self._calculate()
        self.assertEqual(SalaryRecord.objects.filter(employee=self.monthly, month=1, year=2026).count(), 1)
        rec = SalaryRecord.objects.get(employee=self.monthly, month=1, year=2026)
        self.assertEqual(rec.amount, Decimal("3000.00"))  # 3 present now


class _EngineFixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        settings = PayrollSettings.get()
        settings.attendance_mode = "simple"
        settings.save()
        cls.shift = ShiftTemplate.objects.create(
            name="Engine Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=15,
        )
        cls.emp = Employee.objects.create(
            employee_code="ENGTEST_1", first_name="Engine", last_name="Tester",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1),
        )

    def _punch(self, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")


class RangeVersusMonthEngineTests(_EngineFixture):
    def test_range_records_match_month_records(self):
        self._punch(date(2026, 1, 5), time(9, 0), time(18, 0))   # full day
        self._punch(date(2026, 1, 6), time(9, 10))                # single punch -> half shift
        Holiday.objects.create(name="Test Holiday", date=date(2026, 1, 14))
        _holiday_dates_for_month.cache_clear()

        month = compute_month_records(self.emp, 2026, 1)
        rng = compute_range_records(self.emp, date(2026, 1, 1), date(2026, 1, 31))

        def key(r):
            return (r.date, r.status, r.is_late, r.is_half_shift, r.shifts_earned)

        self.assertEqual([key(r) for r in month], [key(r) for r in rng])
        by_date = {r.date: r for r in rng}
        self.assertEqual(by_date[date(2026, 1, 5)].status, "present")
        self.assertEqual(by_date[date(2026, 1, 6)].status, "half_shift")
        self.assertEqual(by_date[date(2026, 1, 14)].status, "holiday")

    def test_range_query_count_does_not_grow_with_days(self):
        """Regression: compute_range_records once prefetched only punch logs,
        so every extra day cost extra queries, and looping the whole roster
        (Attendance Sheet) produced thousands of them."""
        self._punch(date(2026, 1, 5), time(9, 0), time(18, 0))
        # Warm up so the AttendanceDayRecord rows exist and nothing changes,
        # leaving only the read queries to compare.
        compute_range_records(self.emp, date(2026, 1, 1), date(2026, 1, 25))

        with CaptureQueriesContext(connection) as short:
            compute_range_records(self.emp, date(2026, 1, 5), date(2026, 1, 7))
        with CaptureQueriesContext(connection) as long:
            compute_range_records(self.emp, date(2026, 1, 1), date(2026, 1, 25))
        from collections import Counter
        extra = Counter(q["sql"][:110] for q in long.captured_queries)
        extra.subtract(Counter(q["sql"][:110] for q in short.captured_queries))
        self.assertEqual(
            len(short), len(long),
            msg=f"queries that scale with days: { {k: v for k, v in extra.items() if v > 0} }",
        )


class CompensationDayLookupTests(TestCase):
    """_compensation_day_for must resolve identically whether it queries
    per call or is handed the range prefetch the bulk engines use."""

    @classmethod
    def setUpTestData(cls):
        cls.settings = PayrollSettings.get()
        cls.settings.compensation_feature_enabled = True
        cls.settings.save()
        cls.cutting = Department.objects.create(name="Cutting")
        cls.sewing = Department.objects.create(name="Sewing")
        cls.in_cutting = Employee.objects.create(
            employee_code="COMP_CUT", first_name="A", last_name="B", status="active",
            employment_type="staff", department=cls.cutting,
        )
        cls.in_sewing = Employee.objects.create(
            employee_code="COMP_SEW", first_name="C", last_name="D", status="active",
            employment_type="staff", department=cls.sewing,
        )
        cls.day = date(2026, 1, 10)
        cls.ann = CompensationDayAnnouncement.objects.create(date=cls.day, department=cls.cutting)

    def _both(self, emp, d):
        prefetched = _compensation_days_by_date(d, d, self.settings)
        fresh = _compensation_day_for(emp, d, settings=self.settings)
        pre = _compensation_day_for(emp, d, settings=self.settings, prefetched=prefetched)
        self.assertEqual(getattr(fresh, "pk", None), getattr(pre, "pk", None))
        return fresh

    def test_department_scope_matches_only_that_department(self):
        self.assertEqual(self._both(self.in_cutting, self.day), self.ann)
        self.assertIsNone(self._both(self.in_sewing, self.day))

    def test_other_dates_do_not_match(self):
        self.assertIsNone(self._both(self.in_cutting, date(2026, 1, 11)))

    def test_explicit_employee_list_overrides_department_scope(self):
        self.ann.employees.add(self.in_sewing)
        self.assertEqual(self._both(self.in_sewing, self.day), self.ann)
        # With an explicit list, the department no longer applies to others.
        self.assertIsNone(self._both(self.in_cutting, self.day))

    def test_master_switch_off_disables_it(self):
        self.settings.compensation_feature_enabled = False
        self.settings.save()
        self.assertIsNone(_compensation_day_for(self.in_cutting, self.day, settings=self.settings))
        self.assertEqual(_compensation_days_by_date(self.day, self.day, self.settings), {})


class HolidayCacheTests(TestCase):
    def setUp(self):
        _holiday_dates_for_month.cache_clear()
        self.factory = APIRequestFactory()

    def test_create_and_delete_invalidate_the_cache(self):
        self.assertEqual(_holiday_dates_for_month(2026, 3), set())  # primes the cache

        create = self.factory.post(
            "/api/holidays", {"name": "Cache Day", "date": "2026-03-10"}, format="json", **_hr_headers(),
        )
        resp = holidays(create)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(_holiday_dates_for_month(2026, 3), {date(2026, 3, 10)})

        delete = self.factory.delete(f"/api/holidays/{resp.data['id']}", **_hr_headers())
        self.assertEqual(holiday_detail(delete, resp.data["id"]).status_code, 204)
        self.assertEqual(_holiday_dates_for_month(2026, 3), set())


class AttendanceSheetHalfDayPeriodTests(_EngineFixture):
    def _sheet(self):
        req = APIRequestFactory().get(
            "/api/attendance/report-log/sheet",
            {"dateFrom": "2026-01-05", "dateTo": "2026-01-06", "search": self.emp.employee_code},
            **_hr_headers(),
        )
        return attendance_report_log_sheet(req)

    def test_morning_and_afternoon_half_days_are_told_apart(self):
        self._punch(date(2026, 1, 5), time(9, 10))    # arrived before 14:30 -> morning half
        self._punch(date(2026, 1, 6), time(15, 0))    # arrived after 14:30 -> afternoon half
        resp = self._sheet()
        self.assertEqual(resp.status_code, 200)
        row = resp.data["employees"][0]
        by_date = {c["date"]: c for c in row["days"]}
        self.assertEqual(by_date["2026-01-05"]["status"], "half_shift")
        self.assertEqual(by_date["2026-01-05"]["halfDayPeriod"], "morning")
        self.assertEqual(by_date["2026-01-06"]["status"], "half_shift")
        self.assertEqual(by_date["2026-01-06"]["halfDayPeriod"], "afternoon")

    def test_strength_counts_present_and_half_shift_only(self):
        self._punch(date(2026, 1, 5), time(9, 0), time(18, 0))   # present
        resp = self._sheet()
        self.assertEqual(resp.data["strength"][0], 1)
        self.assertEqual(resp.data["strength"][1], 0)             # no punches -> absent

    def test_range_over_31_days_is_rejected(self):
        req = APIRequestFactory().get(
            "/api/attendance/report-log/sheet",
            {"dateFrom": "2026-01-01", "dateTo": "2026-03-01"}, **_hr_headers(),
        )
        self.assertEqual(attendance_report_log_sheet(req).status_code, 400)


class SessionConfigsAuthTests(TestCase):
    """Regression: the GET used to sit outside require_hr and returned every
    SessionConfig row to anyone."""

    def setUp(self):
        self.factory = APIRequestFactory()

    def test_anonymous_request_is_rejected(self):
        self.assertEqual(session_configs(self.factory.get("/api/session-configs")).status_code, 401)

    def test_non_hr_token_is_rejected(self):
        token = sign_token({"role": "employee", "employeeId": 1})
        req = self.factory.get("/api/session-configs", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(session_configs(req).status_code, 403)

    def test_hr_token_is_allowed(self):
        req = self.factory.get("/api/session-configs", **_hr_headers())
        self.assertEqual(session_configs(req).status_code, 200)
