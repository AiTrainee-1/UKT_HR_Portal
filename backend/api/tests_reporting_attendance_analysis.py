"""
Attendance-analysis reports of the Report Center: the late-coming family, early-out, half-day,
absenteeism, worked hours, weekly-off / holiday work, department strength, shift roster / gaps /
shift-wise attendance, production shift register, device sync health, perfect attendance and the
Form 12 style register.

Run via: python manage.py test api.tests_reporting_attendance_analysis

Every figure asserted below is derived by hand from the fixture in ``_Base``. The fixture is built
through the real attendance engine (compute_range_records over real punches, Simple mode) for
March 2026, a month long past, so nothing depends on today:

    Sundays 1, 8, 15, 22, 29      Holiday: Thu 19 (Ugadi)
    shift General 09:00-18:00, 15 min grace, first half ends 13:30, lunch 60 min
    Half-Day cut-offs 13:30 / 14:30; permission cap 3; free late allowance 3;
    default slabs (3 billable = 0.25 shift, 6 = 0.5 ...); Early-Out detection ON.

    AA001 staff CUT  26000  late / half-day / cross-midnight employee (working days = 25 -> daily 1040)
    AA002 staff CUT  13000  permissions (4th is in excess), early-out, half-day leave
    AA003 staff SEW  20800  Saturday off; absences; a manual half day; worked a Saturday off
    AA004 staff PACK 26000  (Unit 2) one late
    AA005 prod  SEW  400 / shift  days worth 1.5 / 1.0 / 0.5 / 1.25 shifts; worked Sunday + holiday
    AA006 prod  PACK 350 / shift  (Unit 2)
    AA007 staff CUT  no salary, no shift assignment, one punch
    AA008 staff CUT  26000  inactive, last working day Fri 6 March
"""

import io
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from openpyxl import load_workbook

from .attendance_final import compute_range_records
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AutoSyncRule,
    BiometricDevice,
    Branch,
    DailyShiftLog,
    Department,
    Designation,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveRequest,
    MonthlyShiftSummary,
    OvertimeRecord,
    PayrollSettings,
    ProductionShiftSegment,
    ResignationRequest,
    Role,
    ShiftTemplate,
    UnmatchedPunch,
)
from .payroll_views import _d2, _generate_staff_payroll, staff_working_days
from .reporting import registry
from .shift_engine import compute_monthly_shift_summary

MAR = date(2026, 3, 1)
MONTH = "2026-03"
MONTH_RANGE = {"dateFrom": "2026-03-01", "dateTo": "2026-03-31"}
WEEK2 = {"dateFrom": "2026-03-02", "dateTo": "2026-03-14"}


def d(day: int) -> date:
    return date(2026, 3, day)


def iso(day: int) -> str:
    return f"2026-03-{day:02d}"


def t(h: int, m: int = 0) -> time:
    return time(h, m)


def _hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


FAMILY = ("late-coming-detail", "late-summary-counts", "late-penalty-breakdown")
REPORT_IDS = (
    *FAMILY,
    "early-out",
    "half-day",
    "absenteeism",
    "worked-hours-shortfall",
    "shift-roster",
    "shift-wise-attendance",
    "department-strength",
    "weekly-off-holiday-work",
    "device-sync-health",
    "shift-assignment-gaps",
    "production-shift-register",
    "perfect-attendance",
    "form12-adult-workers-register",
)
# Explicit parameters so every run is about March 2026 whatever today is.
PARAMS = {
    "late-coming-detail": MONTH_RANGE,
    "late-summary-counts": {"period": MONTH},
    "late-penalty-breakdown": {"period": MONTH},
    "early-out": MONTH_RANGE,
    "half-day": MONTH_RANGE,
    "absenteeism": WEEK2,
    "worked-hours-shortfall": {"dateFrom": "2026-03-09", "dateTo": "2026-03-13"},
    "shift-roster": {"dateFrom": "2026-03-09", "dateTo": "2026-03-09"},
    "shift-wise-attendance": {"dateFrom": "2026-03-09", "dateTo": "2026-03-09"},
    "department-strength": {"dateFrom": "2026-03-09", "dateTo": "2026-03-09"},
    "weekly-off-holiday-work": MONTH_RANGE,
    "device-sync-health": MONTH_RANGE,
    "shift-assignment-gaps": {"dateFrom": "2026-03-09", "dateTo": "2026-03-09"},
    "production-shift-register": {"dateFrom": "2026-03-02", "dateTo": "2026-03-08"},
    "perfect-attendance": {"period": MONTH},
    "form12-adult-workers-register": {"period": MONTH},
}
# Every module key a report may declare must be real (the framework test asserts it too).
MODULES_NEEDED = {
    "production-shift-register": ("production_payroll", "payroll"),
}


class _World:
    """Builds the March 2026 fixture. Subclasses call ``build_world()`` from setUpTestData and may
    add their own employees afterwards."""

    @classmethod
    def build_world(cls):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.permission_monthly_cap = 3
        ps.late_free_allowance = 3
        ps.save()

        ProductionShiftSegment.objects.all().delete()
        for i, (a, b, v) in enumerate(
            [(t(8, 30), t(10, 45), "0.25"), (t(10, 45), t(12, 45), "0.25"), (t(13, 30), t(15, 30), "0.25"),
             (t(15, 30), t(17, 30), "0.25"), (t(17, 30), t(20, 0), "0.50")], start=1,
        ):
            ProductionShiftSegment.objects.create(label=f"S{i}", start_time=a, end_time=b, shift_value=Decimal(v), order=i)

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.cut = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.sew = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.pack = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.empty_dept = Department.objects.create(name="EMPTY", branch=cls.b1)
        cls.des = Designation.objects.create(title="Operator", department=cls.cut)

        cls.gen = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=t(9), end_time=t(18), grace_period_minutes=15,
            first_half_end=t(13, 30), lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        cls.prod_shift = ShiftTemplate.objects.create(
            name="Production A", shift_type="production", start_time=t(8, 30), end_time=t(20), grace_period_minutes=10,
            lunch_duration_minutes=45,
        )
        Holiday.objects.create(name="Ugadi (test)", date=d(19))

        def mk(code, first, dept, branch, etype="staff", **kw):
            kw.setdefault("join_date", "2025-01-01")
            kw.setdefault("gender", "male")
            kw.setdefault("father_name", "Father " + first)
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="T", department=dept, branch=branch,
                employment_type=etype, **kw,
            )

        cls.e1 = mk("AA001", "Asha", cls.cut, cls.b1, salary_amount=Decimal("26000"), designation=cls.des,
                    date_of_birth=date(1990, 5, 5))
        cls.e2 = mk("AA002", "Bala", cls.cut, cls.b1, salary_amount=Decimal("13000"))
        cls.e3 = mk("AA003", "Chitra", cls.sew, cls.b1, salary_amount=Decimal("20800"), father_name=None)
        cls.e4 = mk("AA004", "Dev", cls.pack, cls.b2, salary_amount=Decimal("26000"))
        cls.e5 = mk("AA005", "Esha", cls.sew, cls.b1, "production", salary_per_shift=Decimal("400"))
        cls.e6 = mk("AA006", "Farid", cls.pack, cls.b2, "production", salary_per_shift=Decimal("350"))
        cls.e7 = mk("AA007", "Gita", cls.cut, cls.b1)
        cls.e8 = mk("AA008", "Hari", cls.cut, cls.b1, salary_amount=Decimal("26000"), status="inactive")
        cls.staff = [cls.e1, cls.e2, cls.e3, cls.e4, cls.e7, cls.e8]
        cls.everyone = [cls.e1, cls.e2, cls.e3, cls.e4, cls.e5, cls.e6, cls.e7, cls.e8]
        ResignationRequest.objects.create(employee=cls.e8, status="approved", last_working_date=d(6))

        for e in (cls.e1, cls.e2, cls.e3, cls.e4, cls.e8):
            EmployeeShiftAssignment.objects.create(
                employee=e, shift=cls.gen, effective_from=date(2026, 1, 1), saturday_off=(e is cls.e3), assigned_by="HR Test",
            )
        for e in (cls.e5, cls.e6):
            EmployeeShiftAssignment.objects.create(employee=e, shift=cls.prod_shift, effective_from=date(2026, 1, 1))

        # approved permissions
        def perm(emp, day, kind):
            return EmployeePermission.objects.create(employee=emp, date=d(day), type=kind, status="approved")

        perm(cls.e1, 5, "morning_late_in")
        perm(cls.e1, 6, "morning_late_in")
        perm(cls.e2, 2, "morning_late_in")
        perm(cls.e2, 3, "middle_permission")
        perm(cls.e2, 4, "evening_early_out")
        perm(cls.e2, 9, "morning_late_in")  # the 4th of the month: over the cap of 3 -> excess
        LeaveRequest.objects.create(
            employee=cls.e2, start_date="2026-03-16", end_date="2026-03-16", total_days=Decimal("0.5"),
            is_half_day=True, half_day_slot="morning", status="approved", type="casual",
        )

        def punch(emp, day, *times, source="biometric:test"):
            for tm in times:
                AttendanceLog.objects.create(employee=emp, date=d(day), punch_time=tm, punch_type="IN", source=source)

        # AA001
        for day, times in {
            2: (t(9, 20), t(18)), 3: (t(9, 16), t(18)), 4: (t(9, 10), t(18)), 5: (t(9, 40), t(18, 5)),
            6: (t(10, 20), t(18)), 7: (t(9, 45), t(18)), 8: (t(9, 50), t(18)), 9: (t(8, 55), t(13)),
            10: (t(14, 35), t(18)), 11: (t(9),), 12: (t(9),), 13: (t(1), t(9), t(18)), 14: (t(9), t(18)),
            19: (t(9), t(18)),
        }.items():
            punch(cls.e1, day, *times)
        # AA002
        for day, times in {
            2: (t(9, 50), t(18)), 3: (t(9), t(18)), 4: (t(9), t(16, 50)), 9: (t(9, 40), t(18)),
            12: (t(9), t(13), t(14), t(18)), 13: (t(9), t(13), t(14, 30), t(17)), 15: (t(9), t(18)),
            16: (t(14, 40), t(18)),
        }.items():
            punch(cls.e2, day, *times)
        # AA003 (day 6 is a manual half day, created below before the engine runs)
        for day in (2, 3, 4, 5, 12):
            punch(cls.e3, day, t(9), t(18))
        punch(cls.e3, 21, t(9), t(17))  # a Saturday off
        punch(cls.e4, 2, t(9, 30), t(18))
        # AA005 (production): A = 4 punches 1.5, B = 1.0, C = 0.5, D = 1.25 (late)
        a_day = (t(8, 30), t(12, 45), t(13, 30), t(20))
        punch(cls.e5, 2, *a_day)
        punch(cls.e5, 3, t(8, 30), t(17, 30))
        punch(cls.e5, 4, t(8, 30), t(12, 45))
        punch(cls.e5, 5, t(9), t(20))
        punch(cls.e5, 8, *a_day)
        punch(cls.e5, 19, *a_day)
        punch(cls.e6, 2, *a_day)
        punch(cls.e7, 2, t(10, 30), t(18))
        punch(cls.e8, 2, t(9), t(18))
        punch(cls.e8, 3, t(9, 30), t(18))
        for day in (4, 5, 6):
            punch(cls.e8, day, t(9), t(18))

        AttendanceDayRecord.objects.create(
            employee=cls.e3, date=d(6), status="half_shift", is_half_shift=True, shifts_earned=Decimal("0.50"),
            source="manual", override_by="HR Test", override_note="Approved half day", computed_mode="simple",
        )
        settings = PayrollSettings.get()
        for e in cls.everyone:
            compute_range_records(e, MAR, date(2026, 3, 31), settings)
        AttendanceDayRecord.objects.filter(employee=cls.e3, date=d(10)).update(is_informed=True)

        OvertimeRecord.objects.create(
            employee=cls.e1, date=d(8), last_punch_out=t(18), ot_minutes=95, status="announced", compensation_type="pay",
        )
        OvertimeRecord.objects.create(
            employee=cls.e1, date=d(14), last_punch_out=t(18), ot_minutes=40, status="rejected",
        )

        # people who can (and cannot) open the reports
        every_module = {
            "reports": "view", "attendance": "view", "shifts": "view", "payroll": "view", "production_payroll": "view",
            "employees": "view", "settings": "view",
        }
        cls.admin = HRUser.objects.create(username="aa_admin", password_hash="x", is_super_admin=True)
        cls.b1_user = HRUser.objects.create(
            username="aa_b1", password_hash="x", branch=cls.b1,
            role=Role.objects.create(name="aa_b1_all", permissions=every_module),
        )
        cls.att_user = HRUser.objects.create(
            username="aa_att", password_hash="x",
            role=Role.objects.create(name="aa_att_only", permissions={"reports": "view", "attendance": "view"}),
        )
        cls.plain_user = HRUser.objects.create(
            username="aa_plain", password_hash="x",
            role=Role.objects.create(name="aa_plain", permissions={"reports": "view"}),
        )


class _Base(_World, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.build_world()

    # ── request helpers ──
    def call(self, path, user=None, **params):
        return self.client.get(path, params, **_hdr(user or self.admin))

    def run_report(self, rid, user=None, **params) -> dict:
        r = self.call(f"/api/reports/run/{rid}", user, **params)
        self.assertEqual(r.status_code, 200, r.content[:600])
        return r.json()

    @staticmethod
    def data(body) -> list:
        return [r for r in body["rows"] if "_kind" not in r]

    @staticmethod
    def subtotals(body) -> list:
        return [r for r in body["rows"] if r.get("_kind") == "subtotal"]

    @staticmethod
    def card(body, label):
        return next(s["value"] for s in body["summary"] if s["label"] == label)

    def keyed(self, body, *keys):
        """{(values of keys): row} of the data rows."""
        return {tuple(r[k] for k in keys): r for r in self.data(body)}

    def note_text(self, body):
        return " ".join(body["notes"])


# ═════════════════════════════════════════════════════════════════════════════
#  the fixture itself agrees with the engine (guards every expectation below)
# ═════════════════════════════════════════════════════════════════════════════


class FixtureTests(_Base):
    def rec(self, emp, day):
        return AttendanceDayRecord.objects.get(employee=emp, date=d(day))

    def test_engine_verdicts_the_hand_derived_numbers_rely_on(self):
        r = self.rec(self.e1, 2)
        self.assertEqual((r.status, r.is_late, r.first_punch), ("present", True, t(9, 20)))
        r5, r6 = self.rec(self.e1, 5), self.rec(self.e1, 6)
        self.assertEqual((r5.is_late, r5.morning_permission_applied), (False, True))
        self.assertEqual((r6.is_late, r6.morning_permission_applied), (True, True))
        r9, r10, r11 = self.rec(self.e1, 9), self.rec(self.e1, 10), self.rec(self.e1, 11)
        self.assertEqual((r9.status, r9.early_leave, r9.is_late), ("half_shift", True, False))
        self.assertEqual((r10.status, r10.is_late), ("half_shift", True))
        self.assertEqual((r11.status, r11.last_punch, r11.total_punches), ("half_shift", None, 1))
        r12 = self.rec(self.e1, 12)  # 01:00 next date claimed as this day's exit
        self.assertEqual((r12.status, r12.first_punch, r12.last_punch), ("present", t(9), t(1)))
        self.assertEqual(self.rec(self.e1, 13).first_punch, t(9))
        e2_9 = self.rec(self.e2, 9)
        self.assertEqual((e2_9.is_late, e2_9.morning_permission_excess, e2_9.morning_permission_applied), (True, True, False))
        self.assertTrue(self.rec(self.e2, 13).early_leave)
        self.assertFalse(self.rec(self.e2, 4).early_leave)
        e2_16 = self.rec(self.e2, 16)
        self.assertEqual((e2_16.status, e2_16.is_half_day_leave, e2_16.is_late), ("half_shift", True, False))
        self.assertEqual(self.rec(self.e3, 7).status, "absent")  # the engine has no Saturday-off concept
        self.assertEqual(self.rec(self.e3, 8).status, "holiday")
        for day, credit in {2: "1.50", 3: "1.00", 4: "0.50", 5: "1.25"}.items():
            self.assertEqual(self.rec(self.e5, day).shifts_earned, Decimal(credit))
        self.assertEqual(self.rec(self.e5, 4).status, "half_shift")
        self.assertTrue(self.rec(self.e5, 5).is_late)

    def test_ids_and_metadata(self):
        for rid in REPORT_IDS:
            spec = registry.get_spec(rid)
            self.assertIsNotNone(spec, rid)
            self.assertEqual(spec.category, "attendance", rid)
            self.assertTrue(spec.modules, rid)
        fam = {rid: registry.get_spec(rid) for rid in FAMILY}
        self.assertEqual({s.family for s in fam.values()}, {"late-coming"})
        self.assertEqual({s.variant for s in fam.values()}, {"Detail", "Counts", "Penalty"})
        self.assertEqual(registry.LOAD_ERRORS, {})


# ═════════════════════════════════════════════════════════════════════════════
#  late-coming family + early-out
# ═════════════════════════════════════════════════════════════════════════════


class LateDetailTests(_Base):
    P = {**WEEK2, "employmentType": "staff"}

    def test_golden_rows(self):
        body = self.run_report("late-coming-detail", **self.P)
        rows = self.data(body)
        self.assertEqual(
            [(r["employeeCode"], r["date"]) for r in rows],
            [("AA001", iso(2)), ("AA001", iso(3)), ("AA001", iso(6)), ("AA001", iso(7)), ("AA001", iso(8)),
             ("AA001", iso(10)), ("AA002", iso(9)), ("AA008", iso(3)), ("AA004", iso(2))],
        )
        by = self.keyed(body, "employeeCode", "date")
        r = by[("AA001", iso(2))]
        self.assertEqual(
            (r["department"], r["shift"], r["shiftStart"], r["graceMinutes"], r["deadline"], r["firstPunch"],
             r["lateMinutes"], r["beyondGrace"], r["permission"], r["poolStatus"], r["status"], r["day"]),
            ("CUTTING", "General", "09:00", 15, "09:15", "09:20", 20, 5, None, "Counted", "Present", "Mon"),
        )
        self.assertIn("Morning Late-In", r["reason"])
        self.assertEqual((by[("AA001", iso(3))]["lateMinutes"], by[("AA001", iso(3))]["beyondGrace"]), (16, 1))  # 09:16 is the first late minute
        # in-cap Morning Late-In permission moves the start to 10:00: 10:20 is 20 late / 5 past the 10:15 deadline
        r6 = by[("AA001", iso(6))]
        self.assertEqual((r6["shiftStart"], r6["deadline"], r6["lateMinutes"], r6["beyondGrace"], r6["permission"]),
                         ("10:00", "10:15", 20, 5, "Applied"))
        self.assertEqual((by[("AA001", iso(7))]["lateMinutes"], by[("AA001", iso(7))]["poolStatus"]), (45, "Counted"))  # working Saturday
        sunday = by[("AA001", iso(8))]
        self.assertEqual((sunday["lateMinutes"], sunday["poolStatus"], sunday["day"]), (50, "Non-working day", "Sun"))
        half = by[("AA001", iso(10))]
        self.assertEqual((half["lateMinutes"], half["beyondGrace"], half["status"], half["poolStatus"]),
                         (335, 320, "Half day", "Counted"))
        excess = by[("AA002", iso(9))]
        self.assertEqual((excess["lateMinutes"], excess["beyondGrace"], excess["permission"], excess["poolStatus"]),
                         (40, 25, "Excess", "Merged with excess permission"))
        self.assertEqual(by[("AA008", iso(3))]["lateMinutes"], 30)  # an employee who has since left still appears
        self.assertEqual(by[("AA004", iso(2))]["department"], "PACKING")
        # the permission-protected 5th is not a late day at all
        self.assertNotIn(("AA001", iso(5)), by)
        # Mar 4 (09:10) and Mar 9 (08:55) are on time
        self.assertNotIn(("AA001", iso(4)), by)

    def test_summary_totals_and_subtotals(self):
        body = self.run_report("late-coming-detail", **self.P)
        self.assertEqual(self.card(body, "Late occurrences"), 9)
        self.assertEqual(self.card(body, "Employees affected"), 4)
        self.assertEqual(self.card(body, "Average late (min)"), 65.1)  # 586 / 9
        self.assertEqual(self.card(body, "Longest late (min)"), 335)
        self.assertEqual(self.card(body, "Counted in late pool"), 7)
        self.assertEqual(body["totals"]["lateMinutes"], 20 + 16 + 20 + 45 + 50 + 335 + 40 + 30 + 30)
        self.assertEqual(body["totals"]["beyondGrace"], 5 + 1 + 5 + 30 + 35 + 320 + 25 + 15 + 15)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["lateMinutes"], 486 + 40 + 30)
        self.assertEqual(subs["PACKING total"]["lateMinutes"], 30)
        self.assertEqual(self.note_text(body).count("Data freshness"), 0)

    def test_every_filter_narrows(self):
        def keys(**kw):
            return sorted((r["employeeCode"], r["date"]) for r in self.data(self.run_report("late-coming-detail", **{**self.P, **kw})))

        self.assertEqual(keys(minLate="60"), [("AA001", iso(10))])
        self.assertEqual(keys(permissionEffect="excess"), [("AA002", iso(9))])
        self.assertEqual(keys(permissionEffect="applied"), [("AA001", iso(6))])
        self.assertEqual(len(keys(permissionEffect="none")), 7)
        self.assertEqual(len(keys(poolFilter="counted")), 7)
        self.assertEqual(keys(poolFilter="not_counted"), [("AA001", iso(8)), ("AA002", iso(9))])
        self.assertEqual(len(keys(shift="gener")), 9)
        self.assertEqual(keys(shift="night"), [])
        self.assertEqual(keys(employeeIds=str(self.e2.id)), [("AA002", iso(9))])
        self.assertEqual(keys(departmentIds=str(self.pack.id)), [("AA004", iso(2))])
        self.assertEqual(keys(departmentIds=str(self.empty_dept.id)), [])
        self.assertEqual(keys(branchIds=str(self.b2.id)), [("AA004", iso(2))])
        self.assertEqual(keys(dateFrom="2026-03-03", dateTo="2026-03-03"), [("AA001", iso(3)), ("AA008", iso(3))])

    def test_production_lateness_uses_the_production_reference_times(self):
        body = self.run_report("late-coming-detail", **{**MONTH_RANGE, "employmentType": "production"})
        (r,) = self.data(body)
        self.assertEqual(
            (r["employeeCode"], r["date"], r["shift"], r["shiftStart"], r["deadline"], r["firstPunch"], r["lateMinutes"],
             r["beyondGrace"], r["poolStatus"]),
            ("AA005", iso(5), "Production (fixed times)", "08:30", "08:40", "09:00", 30, 20, "Production (separate)"),
        )

    def test_branch_scoped_user_sees_only_own_branch_and_cannot_widen(self):
        body = self.run_report("late-coming-detail", self.b1_user, **self.P)
        self.assertEqual({r["employeeCode"] for r in self.data(body)}, {"AA001", "AA002", "AA008"})
        self.assertEqual(len(self.data(body)), 8)
        body = self.run_report("late-coming-detail", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])
        body = self.run_report("late-coming-detail", self.b1_user, **self.P, employeeIds=str(self.e4.id))
        self.assertEqual(self.data(body), [])

    def test_edited_shift_does_not_invent_minutes(self):
        # HR moves the shift start to 08:00 after the day was computed: 09:20 is still flagged, minutes stay honest
        self.gen.start_time = t(8)
        self.gen.save()
        body = self.run_report("late-coming-detail", **{**self.P, "employeeIds": str(self.e2.id)})
        (r,) = self.data(body)
        self.assertEqual(r["lateMinutes"], 100)  # 09:40 - 08:00; permission excess so plain start
        self.gen.start_time = t(9, 45)  # now 09:40 is NOT late under the current shift
        self.gen.save()
        body = self.run_report("late-coming-detail", **{**self.P, "employeeIds": str(self.e2.id)})
        (r,) = self.data(body)
        self.assertIsNone(r["lateMinutes"])
        self.assertIsNone(r["beyondGrace"])
        self.assertIn("no minutes", self.note_text(body))

    def test_switched_off_detection_is_stated(self):
        PayrollSettings.objects.filter(pk=1).update(morning_late_in_enabled=False)
        body = self.run_report("late-coming-detail", **self.P)
        self.assertIn("switched off", self.note_text(body))
        self.assertEqual(len(self.data(body)), 9)  # what was flagged earlier is not erased

    def test_missing_records_are_reported_not_hidden(self):
        AttendanceDayRecord.objects.filter(employee=self.e1, date__in=[d(11), d(12)]).delete()
        body = self.run_report("late-coming-detail", **self.P)
        self.assertIn("Data freshness: 2 employee-day(s)", self.note_text(body))


class LateCountsTests(_Base):
    P = {"period": MONTH, "employmentType": "staff"}

    def test_golden_pool_rows(self):
        body = self.run_report("late-summary-counts", **self.P)
        by = self.keyed(body, "employeeCode")
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA001", "AA002", "AA007", "AA008", "AA004", "AA003"])
        a = by[("AA001",)]
        self.assertEqual(
            (a["shift"], a["workingDays"], a["lateDays"], a["lateIn"], a["earlyOut"], a["excessPermissions"], a["poolTotal"],
             a["freeUsed"], a["billable"], a["minutesTotal"], a["minutesAvg"], a["minutesMax"], a["approvedPermissions"],
             a["nightLate"], a["halfDays"]),
            ("General", 25, 6, 5, 1, 0, 6, 3, 3, 486, 81, 335, 2, 0, 3),
        )
        b = by[("AA002",)]
        self.assertEqual(
            (b["lateDays"], b["lateIn"], b["earlyOut"], b["excessPermissions"], b["poolTotal"], b["freeUsed"], b["billable"],
             b["minutesTotal"], b["approvedPermissions"], b["halfDays"]),
            (1, 0, 1, 1, 2, 2, 0, 40, 4, 1),
        )
        c = by[("AA003",)]  # Saturday off: 21 working days; the early-out on a Saturday off is not a pool occurrence
        self.assertEqual((c["workingDays"], c["earlyOut"], c["poolTotal"], c["halfDays"]), (21, 0, 0, 1))
        self.assertEqual((by[("AA004",)]["lateIn"], by[("AA004",)]["poolTotal"], by[("AA004",)]["minutesTotal"]), (1, 1, 30))
        g = by[("AA007",)]
        self.assertEqual((g["shift"], g["poolTotal"], g["minutesAvg"], g["minutesMax"]), ("No shift assigned", 0, None, None))
        self.assertEqual((by[("AA008",)]["lateIn"], by[("AA008",)]["minutesTotal"]), (1, 30))

    def test_summary_totals_subtotals_and_notes(self):
        body = self.run_report("late-summary-counts", **self.P)
        self.assertEqual(self.card(body, "Employees with lates"), 4)
        self.assertEqual(self.card(body, "Over the free allowance"), 1)
        self.assertEqual(self.card(body, "Pool occurrences"), 10)
        self.assertEqual(self.card(body, "Late minutes"), 586)
        self.assertEqual(self.card(body, "Free allowance / month"), 3)
        self.assertEqual(self.card(body, "Permission cap / month"), 3)
        self.assertEqual(body["totals"]["poolTotal"], 10)
        self.assertEqual(body["totals"]["lateDays"], 9)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["poolTotal"], 6 + 2 + 0 + 1)
        self.assertEqual(subs["SEWING total"]["poolTotal"], 0)
        text = self.note_text(body)
        self.assertIn("1 staff employee(s) have no shift assignment", text)
        self.assertNotIn("Data freshness", text)

    def test_filters(self):
        def codes(**kw):
            return [r["employeeCode"] for r in self.data(self.run_report("late-summary-counts", **{**self.P, **kw}))]

        self.assertEqual(codes(minPool="1"), ["AA001", "AA002", "AA008", "AA004"])
        self.assertEqual(codes(minPool="4"), ["AA001"])
        self.assertEqual(codes(minPool="6"), ["AA001"])
        self.assertEqual(codes(onlyBillable="true"), ["AA001"])
        self.assertEqual(codes(departmentIds=str(self.sew.id)), ["AA003"])
        self.assertEqual(codes(employeeIds=f"{self.e1.id},{self.e4.id}"), ["AA001", "AA004"])
        self.assertEqual(codes(employmentType="production"), ["AA005", "AA006"])
        self.assertEqual(codes(departmentIds=str(self.empty_dept.id)), [])

    def test_production_has_no_pool(self):
        body = self.run_report("late-summary-counts", period=MONTH, employmentType="production")
        by = self.keyed(body, "employeeCode")
        self.assertEqual((by[("AA005",)]["lateDays"], by[("AA005",)]["poolTotal"], by[("AA005",)]["workingDays"]), (1, None, None))
        self.assertEqual(by[("AA005",)]["minutesTotal"], 30)

    def test_early_out_column_hidden_when_detection_is_off_and_nothing_flagged(self):
        keys = lambda body: [c["key"] for c in body["columns"]]  # noqa: E731
        body = self.run_report("late-summary-counts", **self.P)
        self.assertIn("earlyOut", keys(body))
        PayrollSettings.objects.filter(pk=1).update(evening_early_out_enabled=False)
        body = self.run_report("late-summary-counts", **{**self.P, "employeeIds": str(self.e4.id)})
        self.assertNotIn("earlyOut", keys(body))
        self.assertIn("Early-Out detection is switched off", self.note_text(body))
        # ... but stays visible while flagged days exist
        self.assertIn("earlyOut", keys(self.run_report("late-summary-counts", **self.P)))

    def test_branch_isolation(self):
        body = self.run_report("late-summary-counts", self.b1_user, **self.P)
        self.assertNotIn("AA004", {r["employeeCode"] for r in self.data(body)})
        self.assertEqual(self.card(body, "Pool occurrences"), 9)
        body = self.run_report("late-summary-counts", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])


class LatePenaltyTests(_Base):
    P = {"period": MONTH}

    def test_golden_rows_and_money(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        by = self.keyed(body, "employeeCode")
        self.assertEqual(sorted(by), [("AA001",), ("AA002",), ("AA003",), ("AA004",), ("AA007",), ("AA008",)])  # staff only
        a = by[("AA001",)]
        self.assertEqual(
            (a["workingDays"], a["lateInEarlyOut"], a["excessPermissions"], a["poolTotal"], a["freeUsed"], a["billable"],
             a["shiftDeductions"], a["salaryDeduction"]),
            (25, 6, 0, 6, 3, 3, 0.25, 260.0),  # 0.25 shift x 26000 / 25 working days
        )
        b = by[("AA002",)]
        self.assertEqual(
            (b["lateInEarlyOut"], b["excessPermissions"], b["poolTotal"], b["freeUsed"], b["billable"], b["shiftDeductions"],
             b["salaryDeduction"]),
            (1, 1, 2, 2, 0, 0.0, 0.0),
        )
        self.assertEqual((by[("AA003",)]["workingDays"], by[("AA003",)]["salaryDeduction"]), (21, 0.0))
        self.assertEqual((by[("AA004",)]["poolTotal"], by[("AA004",)]["salaryDeduction"]), (1, 0.0))
        self.assertIsNone(by[("AA007",)]["salaryDeduction"])  # no salary configured: payroll skips them

    def test_summary_totals_and_subtotals(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        self.assertEqual(self.card(body, "Employees with a deduction"), 1)
        self.assertEqual(self.card(body, "Pool occurrences"), 10)
        self.assertEqual(self.card(body, "Billable occurrences"), 3)
        self.assertEqual(self.card(body, "Shifts deducted"), 0.25)
        self.assertEqual(self.card(body, "Salary deduction"), 260.0)
        self.assertEqual(body["totals"]["salaryDeduction"], 260.0)
        self.assertEqual(body["totals"]["billable"], 3)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["salaryDeduction"], 260.0)
        self.assertEqual(subs["CUTTING total"]["poolTotal"], 9)
        text = self.note_text(body)
        self.assertIn("Free allowance: 3 per month", text)
        self.assertIn("3+ billable = 0.25 shift", text)

    def test_reproduces_payroll_and_the_report_log_screen(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        by = self.keyed(body, "employeeCode")
        # (1) the payslip the real payroll path generates
        slip = _generate_staff_payroll(self.e1, 3, 2026)["slip"]
        self.assertEqual(slip.other_deductions, Decimal("260.00"))
        self.assertEqual(float(slip.other_deductions), by[("AA001",)]["salaryDeduction"])
        self.assertEqual(slip.breakdown_details["deductions"]["lateSummary"]["billableLateCount"], by[("AA001",)]["billable"])
        # (2) the saved snapshot behind the Report Log 'Late-Penalty Breakdown' (refreshed the way strict payroll does)
        for emp, code in ((self.e1, "AA001"), (self.e2, "AA002")):
            days = staff_working_days(emp, 3, 2026)
            compute_monthly_shift_summary(
                emp, 2026, 3, daily_rate=_d2(emp.salary_amount / len(days)), counted_dates=set(days),
            )
        legacy = {r["employeeCode"]: r for r in self.call("/api/attendance/late-summary", month=3, year=2026).json()["employees"]}
        for code in ("AA001", "AA002"):
            row, old = by[(code,)], legacy[code]
            self.assertEqual(row["lateInEarlyOut"], old["totalLateCount"], code)
            self.assertEqual(row["excessPermissions"], old["permissionOverageCount"], code)
            self.assertEqual(row["freeUsed"], old["permissionsUsed"], code)
            self.assertEqual(row["billable"], old["billableLateCount"], code)
            self.assertEqual(row["shiftDeductions"], float(old["shiftDeductions"]), code)
            self.assertEqual(row["salaryDeduction"], float(old["salaryDeductionAmount"]), code)

    def test_filters_and_scoping(self):
        body = self.run_report("late-penalty-breakdown", **self.P, onlyAffected="true")
        self.assertEqual({r["employeeCode"] for r in self.data(body)}, {"AA001", "AA002", "AA004", "AA008"})
        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA001"])
        body = self.run_report("late-penalty-breakdown", self.b1_user, **self.P)
        self.assertNotIn("AA004", {r["employeeCode"] for r in self.data(body)})
        body = self.run_report("late-penalty-breakdown", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])

    def test_slab_edit_flows_through(self):
        PayrollSettings.objects.filter(pk=1).update(late_deduction_slabs=[{"fromLates": 3, "deductionShifts": 1}])
        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        (a,) = self.data(body)
        self.assertEqual((a["shiftDeductions"], a["salaryDeduction"]), (1.0, 1040.0))
        PayrollSettings.objects.filter(pk=1).update(late_deduction_slabs=[])
        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        (a,) = self.data(body)
        self.assertEqual((a["shiftDeductions"], a["salaryDeduction"]), (0.0, 0.0))
        self.assertIn("no deduction slabs", self.note_text(body))


class EarlyOutTests(_Base):
    def test_golden_rows(self):
        body = self.run_report("early-out", **{**WEEK2, "employmentType": "staff"})
        by = self.keyed(body, "employeeCode", "date")
        self.assertEqual(sorted(by), [("AA001", iso(9)), ("AA002", iso(13))])
        a = by[("AA001", iso(9))]
        self.assertEqual(
            (a["shift"], a["shiftEnd"], a["deadline"], a["lastPunch"], a["earlyMinutes"], a["permission"], a["poolStatus"], a["status"]),
            ("General", "18:00", "17:45", "13:00", 300, None, "Counted", "Half day"),
        )
        b = by[("AA002", iso(13))]
        self.assertEqual((b["lastPunch"], b["earlyMinutes"], b["poolStatus"]), ("17:00", 60, "Counted"))
        self.assertEqual(self.card(body, "Early-out occurrences"), 2)
        self.assertEqual(self.card(body, "Employees affected"), 2)
        self.assertEqual(self.card(body, "Average early (min)"), 180.0)
        self.assertEqual(self.card(body, "Longest early (min)"), 300)
        self.assertEqual(body["totals"]["earlyMinutes"], 360)
        self.assertEqual(self.subtotals(body)[0]["earlyMinutes"], 360)

    def test_a_permission_protected_leave_and_a_weekly_off_are_handled(self):
        # the whole month adds AA003's early leave on a Saturday off: listed, but not a pool occurrence
        body = self.run_report("early-out", **MONTH_RANGE)
        by = self.keyed(body, "employeeCode", "date")
        sat = by[("AA003", iso(21))]
        self.assertEqual((sat["day"], sat["earlyMinutes"], sat["poolStatus"]), ("Sat", 60, "Non-working day"))
        # AA002's 4th of March: an in-cap Evening Early-Out permission covered 16:50, so it is not a row at all
        self.assertNotIn(("AA002", iso(4)), by)

    def test_filters_and_scoping(self):
        def keys(user=None, **kw):
            return sorted(self.keyed(self.run_report("early-out", user, **{**MONTH_RANGE, **kw}), "employeeCode", "date"))

        self.assertEqual(keys(employeeIds=str(self.e2.id)), [("AA002", iso(13))])
        self.assertEqual(keys(permissionEffect="applied"), [])
        self.assertEqual(len(keys(permissionEffect="none")), 3)
        self.assertEqual(keys(departmentIds=str(self.sew.id)), [("AA003", iso(21))])
        self.assertEqual(keys(self.b1_user, branchIds=str(self.b2.id)), [])
        self.assertEqual(keys(dateFrom="2026-03-13", dateTo="2026-03-13"), [("AA002", iso(13))])

    def test_switched_off_detection_is_stated(self):
        PayrollSettings.objects.filter(pk=1).update(evening_early_out_enabled=False)
        body = self.run_report("early-out", **MONTH_RANGE)
        self.assertIn("switched off", self.note_text(body))
        self.assertEqual(len(self.data(body)), 3)
