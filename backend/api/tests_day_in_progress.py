"""TODAY's unfinished day shows "In progress" (owner 2026-11-26, day_progress.py).

While a staff day's shift is still running the engine stores it as provisional (provisional_until = shift end + grace
+ 1 min). Every endpoint that serves the day says so (inProgress / provisionalUntil, the moment the shift is over),
no total counts it, and no payroll pays it; once the shift is over the background refresh gives the normal result.
"""

from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase

from . import attendance_refresh
from .attendance_final import compute_day_record, month_summary_from_records
from .clock import FACTORY_TZ
from .day_progress import (
    IN_PROGRESS_PAYROLL_NOTE,
    earned_shifts,
    is_in_progress,
    progress_fields,
    shift_over_at,
)
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    PayrollSettings,
    ShiftTemplate,
)

TODAY = date(2026, 11, 13)  # a Friday
YESTERDAY = date(2026, 11, 12)
OVER_AT = "2026-11-13T18:10:00+05:30"  # 18:00 + 10 min grace: the API's provisionalUntil
STORED = datetime(2026, 11, 13, 18, 11, tzinfo=FACTORY_TZ)  # what the engine stores (+1 minute)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class HelperTests(TestCase):
    def test_in_progress_only_before_the_stored_moment(self):
        self.assertFalse(is_in_progress(None))
        self.assertTrue(is_in_progress(STORED, now=datetime(2026, 11, 13, 18, 10)))
        self.assertFalse(is_in_progress(STORED, now=datetime(2026, 11, 13, 18, 11)))
        self.assertFalse(is_in_progress(STORED, now=datetime(2026, 11, 13, 19, 0)))

    def test_the_clock_decides_when_no_moment_is_given(self):
        with mock.patch("api.clock.ist_now", return_value=datetime(2026, 11, 13, 11, 0)):
            self.assertTrue(is_in_progress(STORED))
            # a UTC-aware stored value (what the database gives back) compares the same
            self.assertTrue(is_in_progress(STORED.astimezone(dt_timezone.utc)))
        with mock.patch("api.clock.ist_now", return_value=datetime(2026, 11, 13, 18, 30)):
            self.assertFalse(is_in_progress(STORED))

    def test_the_api_moment_is_the_end_of_the_shift(self):
        self.assertEqual(shift_over_at(STORED), OVER_AT)
        self.assertIsNone(shift_over_at(None))
        rec = SimpleNamespace(provisional_until=STORED, shifts_earned=Decimal("1.00"))
        with mock.patch("api.clock.ist_now", return_value=datetime(2026, 11, 13, 11, 0)):
            self.assertEqual(progress_fields(rec), {"inProgress": True, "provisionalUntil": OVER_AT})
            self.assertEqual(progress_fields(None), {"inProgress": False, "provisionalUntil": None})
            self.assertEqual(progress_fields({"provisional_until": STORED})["inProgress"], True)
            self.assertEqual(earned_shifts(rec), Decimal("0"))
        with mock.patch("api.clock.ist_now", return_value=datetime(2026, 11, 13, 19, 0)):
            self.assertEqual(earned_shifts(rec), Decimal("1.00"))


class Base(TestCase):
    def setUp(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.compensation_feature_enabled = False
        ps.save()
        self.shift = ShiftTemplate.objects.create(
            name="Day Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.emp = Employee.objects.create(
            employee_code="IP1",
            first_name="Inp",
            last_name="Rogress",
            employment_type="staff",
            status="active",
            salary_amount=Decimal("27000"),
            join_date="2025-01-01",
        )
        EmployeeShiftAssignment.objects.create(employee=self.emp, shift=self.shift, effective_from=date(2026, 1, 1))
        self.admin, _ = HRUser.objects.get_or_create(
            username="inprog_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = _bearer({"role": "hr", "hrUserId": self.admin.id})
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.punch(YESTERDAY, time(9, 0), time(18, 5))
        self.punch(TODAY, time(9, 6))
        self.at(11, 0)

    def at(self, hh, mm):
        """Pin the factory clock (every ist_today / ist_now) and Django's clock to TODAY hh:mm."""
        moment = datetime(2026, 11, 13, hh, mm)
        for target, value in (
            ("api.clock.ist_now", moment),
            ("api.attendance_final.ist_now", moment),
            ("django.utils.timezone.now", moment.replace(tzinfo=FACTORY_TZ)),
        ):
            patch = mock.patch(target, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)

    def punch(self, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def judge_today(self):
        return compute_day_record(self.emp, TODAY, settings=PayrollSettings.get())

    def get(self, url, who=None):
        r = self.client.get(url, **(who or self.hr))
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()


class EngineTests(Base):
    def test_a_morning_only_day_is_provisional_and_left_out_of_the_month_totals(self):
        rec = self.judge_today()
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.provisional_until), ("half_shift", Decimal("0.50"), STORED)
        )
        y = compute_day_record(self.emp, YESTERDAY, settings=PayrollSettings.get())
        s = month_summary_from_records([y, rec])
        self.assertEqual((s["present"], s["totalShifts"], s["inProgressDays"], s["totalDays"]), (1, "1.00", 1, 2))

    def test_after_the_shift_the_background_refresh_gives_the_normal_result(self):
        self.judge_today()
        self.at(19, 0)
        self.assertEqual(attendance_refresh.refresh_provisional(), 1)
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=TODAY)
        self.assertEqual((rec.status, rec.shifts_earned, rec.provisional_until), ("half_shift", Decimal("0.50"), None))
        day = self.get(f"/api/attendance/edit-context?employeeId={self.emp.id}&date={TODAY}")["day"]
        self.assertEqual((day["inProgress"], day["provisionalUntil"], day["status"]), (False, None, "half_shift"))


class EndpointTests(Base):
    """Every endpoint that serves the day carries inProgress / provisionalUntil."""

    def assert_running(self, day, msg=""):
        self.assertEqual((day["inProgress"], day["provisionalUntil"]), (True, OVER_AT), msg)

    def test_employee_monthly_attendance_and_edit_context(self):
        body = self.get(f"/api/attendance/employee-monthly?employeeId={self.emp.id}&month=11&year=2026")
        days = {d["date"]: d for w in body["weeks"] for d in w["days"]}
        self.assert_running(days[str(TODAY)])
        self.assertEqual((days[str(YESTERDAY)]["inProgress"], days[str(YESTERDAY)]["provisionalUntil"]), (False, None))
        self.assertEqual(body["summary"]["inProgressDays"], 1)
        self.assertEqual(body["summary"]["present"], 1, "only yesterday is counted")
        self.assert_running(self.get(f"/api/attendance/edit-context?employeeId={self.emp.id}&date={TODAY}")["day"])

    def test_employee_history_of_the_apps(self):
        body = self.get(f"/api/attendance/employee/{self.emp.id}?month=11&year=2026", self.me)
        days = {d["date"]: d for d in body["records"]}
        self.assert_running(days[str(TODAY)])
        self.assertFalse(days[str(YESTERDAY)]["inProgress"])
        self.assertEqual((body["summary"]["present"], body["totalPresent"]), (1, 1))

    def test_my_shift_stats_and_totals(self):
        body = self.get("/api/attendance/employee-shift-stats?month=11&year=2026", self.me)
        days = {d["date"]: d for d in body["dailyLogs"]}
        self.assert_running(days[str(TODAY)])
        self.assertFalse(days[str(YESTERDAY)]["inProgress"])
        self.assertEqual((body["presentDays"], body["halfShiftDays"]), (1, 0))
        self.assertEqual(Decimal(body["totalEffectiveShifts"]), Decimal("1"))

    def test_hr_daily_list(self):
        self.judge_today()  # the daily list reads the stored day
        rows = {r["employeeId"]: r for r in self.get(f"/api/attendance/daily?date={TODAY}&employmentType=staff")}
        self.assert_running(rows[self.emp.id])
        rows = {r["employeeId"]: r for r in self.get(f"/api/attendance/daily?date={YESTERDAY}&employmentType=staff")}
        self.assertEqual((rows[self.emp.id]["inProgress"], rows[self.emp.id]["provisionalUntil"]), (False, None))

    def test_report_log_sheet_detail_daily_and_day_card(self):
        sheet = self.get(f"/api/attendance/report-log/sheet?dateFrom={YESTERDAY}&dateTo={TODAY}")
        row = next(e for e in sheet["employees"] if e["employeeId"] == self.emp.id)
        cells = {c["date"]: c for c in row["days"]}
        self.assert_running(cells[str(TODAY)])
        self.assertNotIn("inProgress", cells[str(YESTERDAY)], "a settled cell stays light")
        self.assertEqual(row["summary"]["present"], 1)

        detail = self.get(f"/api/attendance/report-log?month=11&year=2026&employeeId={self.emp.id}")
        days = {d["date"]: d for d in detail["days"]}
        self.assert_running(days[str(TODAY)])

        summary = self.get("/api/attendance/report-log?month=11&year=2026")
        mine = next(e for e in summary["employees"] if e["employeeId"] == self.emp.id)
        self.assertEqual((mine["presentDays"], mine["totalShifts"]), (1, "1.00"))

        daily = self.get(f"/api/attendance/report-log?date={TODAY}")
        self.assert_running(next(r for r in daily["rows"] if r["employeeId"] == self.emp.id))

        card = self.get(f"/api/attendance/report-log/day-punches?employeeId={self.emp.id}&date={TODAY}")
        self.assert_running(card)

    def test_search_range(self):
        body = self.get(f"/api/attendance/search/range?employeeId={self.emp.id}&startDate={YESTERDAY}&endDate={TODAY}")
        days = {d["date"]: d for d in body["days"]}
        self.assert_running(days[str(TODAY)])
        self.assertFalse(days[str(YESTERDAY)]["inProgress"])

    def test_monthly_summary_leaves_it_out(self):
        body = self.get("/api/attendance/monthly-summary?year=2026&month=11&employmentType=staff")
        mine = next(r for r in body["rows"] if r["employeeId"] == self.emp.id)
        self.assertEqual((mine["present"], mine["totalShifts"]), (1, 1.0))

    def test_my_insights_leave_it_out(self):
        self.judge_today()
        compute_day_record(self.emp, YESTERDAY, settings=PayrollSettings.get())
        month = self.get("/api/my/analytics?months=1", self.me)["periods"][-1]
        self.assertEqual(month["days"]["present"], 1, month["days"])
        self.assertEqual(month["punctuality"]["arrivals"], 1)

    def test_payroll_calendar_sync(self):
        from .payroll_calendar import calendar_extras

        listed = [{"date": str(d), "status": "absent", "shifts": 0.0} for d in (YESTERDAY, TODAY)]
        days, _off, sync = calendar_extras(self.emp, YESTERDAY, TODAY, listed, live=True)
        by = {d["date"]: d for d in days}
        self.assert_running(by[str(TODAY)])
        self.assertEqual((by[str(TODAY)]["status"], by[str(TODAY)]["shifts"]), ("present", 0.0))
        self.assertFalse(by[str(YESTERDAY)]["inProgress"])
        self.assertEqual(by[str(YESTERDAY)]["shifts"], 1.0)


class PayrollTests(Base):
    def test_staff_payroll_does_not_pay_a_running_day(self):
        from .payroll_views import _generate_staff_payroll

        bd = _generate_staff_payroll(self.emp, 11, 2026)["slip"].breakdown_details
        days = {d["date"]: d for d in bd["days"]}
        today = days[str(TODAY)]
        self.assertEqual(
            (today["status"], today["shiftsCompleted"], today["inProgress"], today["note"], today["firstIn"]),
            ("absent", 0.0, True, IN_PROGRESS_PAYROLL_NOTE, "09:06"),
        )
        self.assertEqual((days[str(YESTERDAY)]["shiftsCompleted"], days[str(YESTERDAY)]["inProgress"]), (1.0, False))

        # the Payroll Details page shows the note on that day
        from .payroll_insights import normalized_days

        shown = {d["date"]: d for d in normalized_days(bd, [])}
        self.assertEqual(shown[str(TODAY)]["note"], IN_PROGRESS_PAYROLL_NOTE)

        # generated again after the shift: the normal result (Half Day)
        self.at(19, 0)
        attendance_refresh.refresh_provisional()
        bd = _generate_staff_payroll(self.emp, 11, 2026)["slip"].breakdown_details
        today = {d["date"]: d for d in bd["days"]}[str(TODAY)]
        self.assertEqual((today["status"], today["shiftsCompleted"], today["inProgress"]), ("present", 0.5, False))
        self.assertIsNone(today["note"])

    def test_production_payroll_does_not_pay_a_running_day(self):
        from . import attendance_final
        from .payroll_views import _generate_production_payroll

        worker = Employee.objects.create(
            employee_code="IP2",
            first_name="Prod",
            last_name="Worker",
            employment_type="production",
            status="active",
            salary_per_shift=Decimal("600"),
            join_date="2025-01-01",
        )
        real = attendance_final.compute_range_records

        def running_today(emp, start, end, *a, **kw):
            records = real(emp, start, end, *a, **kw)
            for r in records:
                r.shifts_earned = Decimal("1.00")
                r.status = "present"
                r.provisional_until = STORED if r.date == TODAY else None
            return records

        with mock.patch("api.attendance_final.compute_range_records", side_effect=running_today):
            result = _generate_production_payroll(worker, TODAY - timedelta(days=1), TODAY)
        bd = result["slip"].breakdown_details
        days = {d["date"]: d for d in bd["days"]}
        self.assertEqual(
            (days[str(TODAY)]["shiftsEarned"], days[str(TODAY)]["inProgress"], days[str(TODAY)]["note"]),
            (0.0, True, IN_PROGRESS_PAYROLL_NOTE),
        )
        self.assertEqual(days[str(YESTERDAY)]["shiftsEarned"], 1.0)
        self.assertEqual(result["payroll"].gross_salary, Decimal("600.00"), "one shift paid, not two")

    def test_salary_slip_page_does_not_pay_a_running_day(self):
        from .salary_slip_center.engine import calculate

        slip = calculate(self.emp, 11, 2026, today=TODAY)
        rows = {r["date"]: r for r in slip["calendar"]}
        self.assertEqual(
            (rows[str(TODAY)]["status"], rows[str(TODAY)]["shifts"], rows[str(TODAY)]["note"]),
            ("future", 0.0, IN_PROGRESS_PAYROLL_NOTE),
        )
        self.assertTrue(rows[str(TODAY)]["inProgress"])
        self.assertEqual(rows[str(YESTERDAY)]["status"], "present")
