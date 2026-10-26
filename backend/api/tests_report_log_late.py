"""
Report Log's Daily Late Report (and the unit blocks of the Daily Leave Report) read GET /api/attendance/report-log?date=
These tests pin the additive row fields (firstPunch, branchId, branchName, unitLabel), that the engine's own late flag
is what the late tab reads, that production workers never appear, and that a branch-scoped login only sees its branch.

Run via: DB_NAME=uktex_fix_rlog python manage.py test api.tests_report_log_late --noinput
"""

from datetime import date, time

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_views import _unit_label
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    Branch,
    Employee,
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
