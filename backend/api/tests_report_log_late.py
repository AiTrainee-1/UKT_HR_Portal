"""
Report Log's Daily Late Report (and the unit blocks of the Daily Leave Report) read GET /api/attendance/report-log?date=
These tests pin the additive row fields (firstPunch, branchId, branchName, unitLabel and the late timing: shiftStart,
graceMinutes, lateDeadline, minutesAfterStart, minutesLate), that the engine's own late flag is what the late tab reads, that
production workers never appear, and that a branch-scoped login only sees its branch.

Run via: DB_NAME=uktex_fix_rlog python manage.py test api.tests_report_log_late --noinput
"""

from datetime import date, time

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_views import _unit_label
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    PayrollSettings,
    Role,
    ShiftTemplate,
)

DAY = date(2026, 8, 3)  # a Monday
URL = "/api/attendance/report-log"


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class ReportLogDailyRowsTests(TestCase):
    def setUp(self):
        settings = PayrollSettings.get()
        settings.morning_late_in_enabled = True
        settings.save()
        self.admin = HRUser.objects.create(username="rl_admin", password_hash="x", is_super_admin=True)
        self.ho = Branch.objects.create(name="RL Head Office", code="RLHO", is_head_office=True)
        self.u1 = Branch.objects.create(name="RL Unit One", code="Unit91")
        self.shift = ShiftTemplate.objects.create(
            name="RL Staff Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.late_ho = self._emp("RL001", self.ho, punch=time(9, 40))
        self.ontime_ho = self._emp("RL002", self.ho, punch=time(9, 5))
        self.late_u1 = self._emp("RL003", self.u1, punch=time(9, 31))
        self.late_nobranch = self._emp("RL004", None, punch=time(9, 50))
        self.absent_u1 = self._emp("RL005", self.u1, punch=None)
        self.late_production = self._emp("RL006", self.ho, punch=time(9, 45), kind="production")

    def _emp(self, code, branch, punch, kind="staff"):
        emp = Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Test",
            employment_type=kind,
            status="active",
            branch=branch,
        )
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2020, 1, 1))
        if punch is not None:
            AttendanceLog.objects.create(employee=emp, date=DAY, punch_time=punch, punch_type="IN", source="test")
            AttendanceLog.objects.create(employee=emp, date=DAY, punch_time=time(18, 0), punch_type="IN", source="test")
        return emp

    def rows(self, user=None, **params):
        resp = self.client.get(URL, {"date": DAY.isoformat(), **params}, **_bearer(user or self.admin))
        self.assertEqual(resp.status_code, 200, resp.content)
        return {r["employeeCode"]: r for r in resp.json()["rows"]}

    def test_late_row_carries_first_punch_and_unit(self):
        row = self.rows()["RL001"]
        self.assertTrue(row["isLate"])
        self.assertEqual(row["firstPunch"], "09:40")
        self.assertEqual(row["branchId"], self.ho.id)
        self.assertEqual(row["branchName"], "RL Head Office")
        self.assertEqual(row["unitLabel"], "HO")

    def test_on_time_row_is_not_late_but_still_has_a_first_punch(self):
        row = self.rows()["RL002"]
        self.assertFalse(row["isLate"])
        self.assertEqual(row["firstPunch"], "09:05")

    def test_unit_codes_become_short_block_labels(self):
        rows = self.rows()
        self.assertEqual(rows["RL003"]["unitLabel"], "U-91")
        self.assertEqual(rows["RL003"]["firstPunch"], "09:31")
        self.assertTrue(rows["RL003"]["isLate"])

    def test_employee_without_a_branch_has_null_unit_fields(self):
        row = self.rows()["RL004"]
        self.assertIsNone(row["branchId"])
        self.assertIsNone(row["branchName"])
        self.assertIsNone(row["unitLabel"])
        self.assertTrue(row["isLate"])

    def test_no_punch_means_null_first_punch_and_not_late(self):
        row = self.rows()["RL005"]
        self.assertIsNone(row["firstPunch"])
        self.assertFalse(row["isLate"])
        self.assertEqual(row["status"], "absent")
        self.assertEqual(row["unitLabel"], "U-91")

    def test_production_workers_are_never_listed(self):
        self.assertNotIn("RL006", self.rows())

    def test_old_fields_are_unchanged(self):
        row = self.rows()["RL001"]
        for key in (
            "employeeId",
            "employeeCode",
            "employeeName",
            "department",
            "designation",
            "status",
            "isLate",
            "isEarlyOut",
            "lateReason",
            "arrivalZone",
            "lateAfternoon",
            "permissionAfternoon",
            "isCompensationDay",
            "isHalfDayLeave",
            "isInformed",
        ):
            self.assertIn(key, row)
        self.assertEqual(row["employeeName"], "RL001 Test")
        self.assertEqual(row["status"], "present")

    def test_department_and_search_filters_still_narrow_the_rows(self):
        self.assertEqual(set(self.rows(search="RL003")), {"RL003"})

    def test_branch_scoped_login_only_sees_its_own_branch(self):
        role = Role.objects.create(name="RL Attendance", permissions={"attendance": "view"})
        scoped = HRUser.objects.create(username="rl_scoped", password_hash="x", role=role, branch=self.u1)
        self.assertEqual(set(self.rows(scoped)), {"RL003", "RL005"})

    def test_branch_is_joined_not_fetched_per_employee(self):
        for i in range(10):
            self._emp(f"RLX{i:02d}", self.ho if i % 2 else self.u1, punch=time(9, 30))
        with CaptureQueriesContext(connection) as ctx:
            rows = self.rows()
        self.assertEqual(len(rows), 15)
        branch_reads = [q for q in ctx.captured_queries if 'FROM "branches"' in q["sql"]]
        self.assertEqual(branch_reads, [])  # the join is inside the employee query: no separate read, no N+1


class UnitLabelTests(TestCase):
    def test_labels(self):
        self.assertIsNone(_unit_label(None))
        self.assertEqual(_unit_label(Branch(name="Main", code="X1", is_head_office=True)), "HO")
        self.assertEqual(_unit_label(Branch(name="U", code="Unit1")), "U-1")
        self.assertEqual(_unit_label(Branch(name="U", code="unit 12")), "U-12")
        self.assertEqual(_unit_label(Branch(name="U", code="UNIT-2")), "U-2")
        self.assertEqual(_unit_label(Branch(name="Weaving Block", code="WB")), "WB")
        self.assertEqual(_unit_label(Branch(name="Weaving Block", code=None)), "Weaving Block")
        self.assertEqual(_unit_label(Branch(name="Weaving Block", code="  ")), "Weaving Block")


class LateTimingTests(TestCase):
    """minutesLate = first punch minus the deadline the engine judged it against (shift start + grace, after any company
    window), minutesAfterStart = first punch minus the shift start. Whole minutes, like every arrival check."""

    def setUp(self):
        settings = PayrollSettings.get()
        settings.morning_late_in_enabled = True
        settings.permission_monthly_cap = 1
        settings.save()
        self.admin = HRUser.objects.create(username="rt_admin", password_hash="x", is_super_admin=True)
        self.general = self._shift("RT General", time(9, 0), 15)
        self.early = self._shift("RT Early", time(8, 30), 5)

    def _shift(self, name, start, grace):
        return ShiftTemplate.objects.create(
            name=name,
            shift_type="staff",
            start_time=start,
            end_time=time(18, 0),
            grace_period_minutes=grace,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )

    def _emp(self, code, shift, punch, day=DAY, seconds=0):
        emp = Employee.objects.create(
            employee_code=code, first_name=code, last_name="Timing", employment_type="staff", status="active"
        )
        if shift is not None:
            EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=date(2020, 1, 1))
        if punch is not None:
            AttendanceLog.objects.create(
                employee=emp, date=day, punch_time=punch.replace(second=seconds), punch_type="IN", source="test"
            )
            AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(18, 0), punch_type="IN", source="test")
        return emp

    def row(self, code, day=DAY):
        resp = self.client.get(URL, {"date": day.isoformat(), "search": code}, **_bearer(self.admin))
        self.assertEqual(resp.status_code, 200, resp.content)
        rows = [r for r in resp.json()["rows"] if r["employeeCode"] == code]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def timing(self, row):
        return {k: row[k] for k in ("shiftStart", "graceMinutes", "lateDeadline", "minutesAfterStart", "minutesLate")}

    def test_late_after_grace(self):
        self._emp("RT01", self.general, time(9, 40))
        row = self.row("RT01")
        self.assertTrue(row["isLate"])
        self.assertEqual(
            self.timing(row),
            {
                "shiftStart": "09:00",
                "graceMinutes": 15,
                "lateDeadline": "09:15",
                "minutesAfterStart": 40,
                "minutesLate": 25,
            },
        )

    def test_exactly_at_the_deadline_is_not_late_and_the_next_minute_is_one_minute_late(self):
        self._emp("RT02", self.general, time(9, 15))
        self._emp("RT03", self.general, time(9, 16))
        on_time = self.row("RT02")
        self.assertFalse(on_time["isLate"])
        self.assertEqual((on_time["minutesAfterStart"], on_time["minutesLate"]), (None, None))
        self.assertEqual((on_time["shiftStart"], on_time["lateDeadline"]), ("09:00", "09:15"))
        late = self.row("RT03")
        self.assertTrue(late["isLate"])
        self.assertEqual((late["minutesAfterStart"], late["minutesLate"]), (16, 1))

    def test_a_punch_counts_as_the_minute_it_was_made_in(self):
        self._emp("RT04", self.general, time(9, 15), seconds=59)  # 09:15:59 is still a 09:15 punch
        self._emp("RT05", self.general, time(9, 16), seconds=1)
        self.assertFalse(self.row("RT04")["isLate"])
        self.assertEqual(self.row("RT05")["minutesLate"], 1)

    def test_each_shift_uses_its_own_start_and_grace(self):
        self._emp("RT06", self.early, time(8, 50))
        row = self.row("RT06")
        self.assertEqual(
            self.timing(row),
            {
                "shiftStart": "08:30",
                "graceMinutes": 5,
                "lateDeadline": "08:35",
                "minutesAfterStart": 20,
                "minutesLate": 15,
            },
        )

    def test_an_employee_with_no_shift_has_nulls(self):
        self._emp("RT07", None, time(9, 50))
        row = self.row("RT07")
        self.assertFalse(row["isLate"])
        self.assertEqual(
            self.timing(row),
            {
                "shiftStart": None,
                "graceMinutes": None,
                "lateDeadline": None,
                "minutesAfterStart": None,
                "minutesLate": None,
            },
        )

    def test_no_punch_has_no_minutes_but_still_shows_the_shift(self):
        self._emp("RT08", self.general, None)
        row = self.row("RT08")
        self.assertEqual((row["minutesAfterStart"], row["minutesLate"]), (None, None))
        self.assertEqual((row["shiftStart"], row["graceMinutes"], row["lateDeadline"]), ("09:00", 15, "09:15"))

    def test_an_in_cap_late_in_permission_excuses_the_arrival_so_there_are_no_late_minutes(self):
        emp = self._emp("RT09", self.general, time(9, 40))
        EmployeePermission.objects.create(
            employee=emp, date=DAY, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        row = self.row("RT09")
        self.assertFalse(row["isLate"])
        self.assertEqual(row["arrivalZone"], "excused")
        self.assertEqual((row["minutesAfterStart"], row["minutesLate"]), (None, None))

    def test_an_excess_late_in_permission_does_not_move_the_deadline(self):
        emp = self._emp("RT10", self.general, time(9, 40))
        # the monthly cap is 1: the earlier permission uses it, this day's is excess and is judged on the plain shift
        EmployeePermission.objects.create(
            employee=emp, date=date(2026, 8, 1), type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        EmployeePermission.objects.create(
            employee=emp, date=DAY, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        row = self.row("RT10")
        self.assertTrue(row["isLate"])
        self.assertEqual((row["lateDeadline"], row["minutesAfterStart"], row["minutesLate"]), ("09:15", 40, 25))

    def test_a_company_announced_late_in_moves_the_deadline_the_minutes_are_counted_from(self):
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(pk=1, defaults={"windows_enabled": True})
        CompensationDayAnnouncement.objects.create(date=DAY, kind="late_in", allowed_time=time(9, 45), reason="Rain")
        self._emp("RT11", self.general, time(10, 5))
        row = self.row("RT11")
        self.assertTrue(row["isLate"])
        self.assertEqual(
            self.timing(row),
            {
                "shiftStart": "09:00",
                "graceMinutes": 15,
                "lateDeadline": "09:45",
                "minutesAfterStart": 65,
                "minutesLate": 20,
            },
        )

    def test_an_hr_marked_late_day_counts_at_least_one_minute(self):
        emp = self._emp("RT12", self.general, None)
        AttendanceDayRecord.objects.create(
            employee=emp,
            date=DAY,
            status="present",
            is_late=True,
            source="manual",
            first_punch=time(9, 10),
            shifts_earned="1.00",
        )
        row = self.row("RT12")
        self.assertTrue(row["isLate"])
        self.assertEqual((row["minutesAfterStart"], row["minutesLate"]), (10, 1))

    def test_every_late_row_has_at_least_one_minute_and_every_other_row_has_none(self):
        punches = [time(8, 55), time(9, 5), time(9, 15), time(9, 16), time(9, 30), time(10, 30), time(11, 45)]
        for i, punch in enumerate(punches):
            self._emp(f"RTX{i:02d}", self.general if i % 2 == 0 else self.early, punch)
        self._emp("RTNOSHIFT", None, time(10, 0))
        self._emp("RTNOPUNCH", self.general, None)
        resp = self.client.get(URL, {"date": DAY.isoformat(), "search": "RT"}, **_bearer(self.admin))
        rows = resp.json()["rows"]
        self.assertGreaterEqual(len(rows), 9)
        for row in rows:
            if row["isLate"]:
                self.assertGreaterEqual(row["minutesLate"], 1, row["employeeCode"])
                self.assertGreaterEqual(row["minutesAfterStart"], row["minutesLate"], row["employeeCode"])
            else:
                self.assertIsNone(row["minutesLate"], row["employeeCode"])
                self.assertIsNone(row["minutesAfterStart"], row["employeeCode"])
        self.assertTrue(any(r["isLate"] for r in rows))

    def test_shift_timing_adds_no_per_employee_query(self):
        for i in range(8):
            self._emp(f"RTQ{i:02d}", self.general, time(9, 30))
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(URL, {"date": DAY.isoformat(), "search": "RTQ"}, **_bearer(self.admin))
        reads = [q for q in ctx.captured_queries if 'FROM "employee_shift_assignments"' in q["sql"]]
        # the one roster-wide prefetch: the shift of each row comes from it
        self.assertEqual(len(reads), 1)
