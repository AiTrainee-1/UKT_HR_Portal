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
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from openpyxl import load_workbook

from .attendance_final import _holiday_dates_for_month, compute_range_records
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
    ProductionShiftConfig,
    ProductionShiftSegment,
    ResignationRequest,
    Role,
    ShiftTemplate,
    UnmatchedPunch,
)
from .payroll_views import _d2, _generate_staff_payroll, staff_working_days
from .reporting import registry
from .reporting.runner import run_report
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
# Reports an attendance-only role must NOT open: they carry money (production gross) or employee-master
# particulars (father's name, date of birth).
NOT_FOR_ATTENDANCE_ONLY = ("production-shift-register", "form12-adult-workers-register")


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
            [
                (t(8, 30), t(10, 45), "0.25"),
                (t(10, 45), t(12, 45), "0.25"),
                (t(13, 30), t(15, 30), "0.25"),
                (t(15, 30), t(17, 30), "0.25"),
                (t(17, 30), t(20, 0), "0.50"),
            ],
            start=1,
        ):
            ProductionShiftSegment.objects.create(
                label=f"S{i}", start_time=a, end_time=b, shift_value=Decimal(v), order=i
            )

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.cut = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.sew = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.pack = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.empty_dept = Department.objects.create(name="EMPTY", branch=cls.b1)
        cls.des = Designation.objects.create(title="Operator", department=cls.cut)

        cls.gen = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=t(9),
            end_time=t(18),
            grace_period_minutes=15,
            first_half_end=t(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        cls.prod_shift = ShiftTemplate.objects.create(
            name="Production A",
            shift_type="production",
            start_time=t(8, 30),
            end_time=t(20),
            grace_period_minutes=10,
            lunch_duration_minutes=45,
        )
        Holiday.objects.create(name="Ugadi (test)", date=d(19))
        # the engine caches holiday dates per (year, month) for the whole process: start clean and leave clean
        _holiday_dates_for_month.cache_clear()
        cls.addClassCleanup(_holiday_dates_for_month.cache_clear)

        def mk(code, first, dept, branch, etype="staff", **kw):
            kw.setdefault("join_date", "2025-01-01")
            kw.setdefault("gender", "male")
            kw.setdefault("father_name", "Father " + first)
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="T",
                department=dept,
                branch=branch,
                employment_type=etype,
                **kw,
            )

        cls.e1 = mk(
            "AA001",
            "Asha",
            cls.cut,
            cls.b1,
            salary_amount=Decimal("26000"),
            designation=cls.des,
            date_of_birth=date(1990, 5, 5),
        )
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
                employee=e,
                shift=cls.gen,
                effective_from=date(2026, 1, 1),
                saturday_off=(e is cls.e3),
                assigned_by="HR Test",
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
            employee=cls.e2,
            start_date="2026-03-16",
            end_date="2026-03-16",
            total_days=Decimal("0.5"),
            is_half_day=True,
            half_day_slot="morning",
            status="approved",
            type="casual",
        )

        def punch(emp, day, *times, source="biometric:test"):
            for tm in times:
                AttendanceLog.objects.create(employee=emp, date=d(day), punch_time=tm, punch_type="IN", source=source)

        # AA001
        for day, times in {
            2: (t(9, 20), t(18)),
            3: (t(9, 16), t(18)),
            4: (t(9, 10), t(18)),
            5: (t(9, 40), t(18, 5)),
            6: (t(10, 20), t(18)),
            7: (t(9, 45), t(18)),
            8: (t(9, 50), t(18)),
            9: (t(8, 55), t(13)),
            10: (t(14, 35), t(18)),
            11: (t(9),),
            12: (t(9),),
            13: (t(1), t(9), t(18)),
            14: (t(9), t(18)),
            19: (t(9), t(18)),
        }.items():
            punch(cls.e1, day, *times)
        # AA002
        for day, times in {
            2: (t(9, 50), t(18)),
            3: (t(9), t(18)),
            4: (t(9), t(16, 50)),
            9: (t(9, 40), t(18)),
            12: (t(9), t(13), t(14), t(18)),
            13: (t(9), t(13), t(14, 30), t(17)),
            15: (t(9), t(18)),
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
            employee=cls.e3,
            date=d(6),
            status="half_shift",
            is_half_shift=True,
            shifts_earned=Decimal("0.50"),
            source="manual",
            override_by="HR Test",
            override_note="Approved half day",
            computed_mode="simple",
        )
        settings = PayrollSettings.get()
        for e in cls.everyone:
            compute_range_records(e, MAR, date(2026, 3, 31), settings)
        AttendanceDayRecord.objects.filter(employee=cls.e3, date=d(10)).update(is_informed=True)

        OvertimeRecord.objects.create(
            employee=cls.e1,
            date=d(8),
            last_punch_out=t(18),
            ot_minutes=95,
            status="announced",
            compensation_type="pay",
        )
        OvertimeRecord.objects.create(
            employee=cls.e1,
            date=d(14),
            last_punch_out=t(18),
            ot_minutes=40,
            status="rejected",
        )

        # people who can (and cannot) open the reports
        every_module = {
            "reports": "view",
            "attendance": "view",
            "shifts": "view",
            "payroll": "view",
            "production_payroll": "view",
            "employees": "view",
            "settings": "view",
        }
        cls.admin = HRUser.objects.create(username="aa_admin", password_hash="x", is_super_admin=True)
        cls.b1_user = HRUser.objects.create(
            username="aa_b1",
            password_hash="x",
            branch=cls.b1,
            role=Role.objects.create(name="aa_b1_all", permissions=every_module),
        )
        cls.att_user = HRUser.objects.create(
            username="aa_att",
            password_hash="x",
            role=Role.objects.create(name="aa_att_only", permissions={"reports": "view", "attendance": "view"}),
        )
        cls.plain_user = HRUser.objects.create(
            username="aa_plain",
            password_hash="x",
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
        # 10:20 with an approved Late-In permission: inside the permission window (to 11:15), so excused, not late
        self.assertEqual((r6.is_late, r6.morning_permission_applied, r6.arrival_zone), (False, True, "excused"))
        r9, r10, r11 = self.rec(self.e1, 9), self.rec(self.e1, 10), self.rec(self.e1, 11)
        self.assertEqual((r9.status, r9.early_leave, r9.is_late), ("half_shift", True, False))
        # 14:35 is after the 13:30 Morning Half cutoff: a Half Day arrival, which is not ALSO a Late-In
        self.assertEqual((r10.status, r10.is_late), ("half_shift", False))
        self.assertEqual((r11.status, r11.last_punch, r11.total_punches), ("half_shift", None, 1))
        r12 = self.rec(self.e1, 12)  # 01:00 next date claimed as this day's exit
        self.assertEqual((r12.status, r12.first_punch, r12.last_punch), ("present", t(9), t(1)))
        self.assertEqual(self.rec(self.e1, 13).first_punch, t(9))
        e2_9 = self.rec(self.e2, 9)
        self.assertEqual(
            (e2_9.is_late, e2_9.morning_permission_excess, e2_9.morning_permission_applied), (True, True, False)
        )
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
        # only this group's modules: another group's half-written file must not fail this suite
        self.assertEqual({k: v for k, v in registry.LOAD_ERRORS.items() if ".attendance_analysis" in k}, {})


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
            [
                ("AA001", iso(2)),
                ("AA001", iso(3)),
                ("AA001", iso(7)),
                ("AA001", iso(8)),
                ("AA002", iso(9)),
                ("AA008", iso(3)),
                ("AA004", iso(2)),
            ],
        )  # Mar 10 (14:35) is a second-half arrival, and Mar 6 (10:20 with an approved permission) is excused: neither is late
        by = self.keyed(body, "employeeCode", "date")
        r = by[("AA001", iso(2))]
        self.assertEqual(
            (
                r["department"],
                r["shift"],
                r["shiftStart"],
                r["graceMinutes"],
                r["deadline"],
                r["firstPunch"],
                r["lateMinutes"],
                r["beyondGrace"],
                r["permission"],
                r["poolStatus"],
                r["status"],
                r["day"],
            ),
            ("CUTTING", "General", "09:00", 15, "09:15", "09:20", 20, 5, None, "Counted", "Present", "Mon"),
        )
        self.assertIn("Morning Late-In", r["reason"])
        self.assertEqual(
            (by[("AA001", iso(3))]["lateMinutes"], by[("AA001", iso(3))]["beyondGrace"]), (16, 1)
        )  # 09:16 is the first late minute
        # 10:20 with an in-cap Morning Late-In permission is inside the permission window (to 11:15): excused, not late
        self.assertNotIn(("AA001", iso(6)), by)
        self.assertEqual(
            (by[("AA001", iso(7))]["lateMinutes"], by[("AA001", iso(7))]["poolStatus"]), (45, "Counted")
        )  # working Saturday
        sunday = by[("AA001", iso(8))]
        self.assertEqual((sunday["lateMinutes"], sunday["poolStatus"], sunday["day"]), (50, "Non-working day", "Sun"))
        # 14:35 on the 10th is a Half Day arrival (after the Morning Half cutoff): it is not a late day at all
        self.assertNotIn(("AA001", iso(10)), by)
        excess = by[("AA002", iso(9))]
        self.assertEqual(
            (excess["lateMinutes"], excess["beyondGrace"], excess["permission"], excess["poolStatus"]),
            (40, 25, "Excess", "Merged with excess permission"),
        )
        self.assertEqual(by[("AA008", iso(3))]["lateMinutes"], 30)  # an employee who has since left still appears
        self.assertEqual(by[("AA004", iso(2))]["department"], "PACKING")
        # the permission-protected 5th is not a late day at all
        self.assertNotIn(("AA001", iso(5)), by)
        # Mar 4 (09:10) and Mar 9 (08:55) are on time
        self.assertNotIn(("AA001", iso(4)), by)

    def test_summary_totals_and_subtotals(self):
        body = self.run_report("late-coming-detail", **self.P)
        self.assertEqual(self.card(body, "Late occurrences"), 7)
        self.assertEqual(self.card(body, "Employees affected"), 4)
        self.assertEqual(self.card(body, "Average late (min)"), 33.0)  # 231 / 7
        self.assertEqual(self.card(body, "Longest late (min)"), 50)
        self.assertEqual(self.card(body, "Counted in late pool"), 5)
        self.assertEqual(body["totals"]["lateMinutes"], 20 + 16 + 45 + 50 + 40 + 30 + 30)
        self.assertEqual(body["totals"]["beyondGrace"], 5 + 1 + 30 + 35 + 25 + 15 + 15)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["lateMinutes"], 131 + 40 + 30)
        self.assertEqual(subs["PACKING total"]["lateMinutes"], 30)
        self.assertEqual(self.note_text(body).count("Data freshness"), 0)

    def test_every_filter_narrows(self):
        def keys(**kw):
            return sorted(
                (r["employeeCode"], r["date"])
                for r in self.data(self.run_report("late-coming-detail", **{**self.P, **kw}))
            )

        self.assertEqual(
            keys(minLate="30"),
            [("AA001", iso(7)), ("AA001", iso(8)), ("AA002", iso(9)), ("AA004", iso(2)), ("AA008", iso(3))],
        )
        self.assertEqual(keys(minLate="60"), [])  # the 335-minute half-day arrival is no longer a late
        self.assertEqual(keys(permissionEffect="excess"), [("AA002", iso(9))])
        # a day an approved permission covers is never flagged late any more, so no late row can say "Applied"
        self.assertEqual(keys(permissionEffect="applied"), [])
        self.assertEqual(len(keys(permissionEffect="none")), 6)
        self.assertEqual(len(keys(poolFilter="counted")), 5)
        self.assertEqual(keys(poolFilter="not_counted"), [("AA001", iso(8)), ("AA002", iso(9))])
        self.assertEqual(len(keys(shift="gener")), 7)
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
            (
                r["employeeCode"],
                r["date"],
                r["shift"],
                r["shiftStart"],
                r["deadline"],
                r["firstPunch"],
                r["lateMinutes"],
                r["beyondGrace"],
                r["poolStatus"],
            ),
            ("AA005", iso(5), "Production (fixed times)", "08:30", "08:40", "09:00", 30, 20, "Production (separate)"),
        )

    def test_production_lateness_is_to_the_second_and_a_zero_grace_means_the_engines_default(self):
        def punch(day, *times):
            for tm in times:
                AttendanceLog.objects.create(
                    employee=self.e6, date=d(day), punch_time=tm, punch_type="IN", source="biometric:test"
                )

        punch(3, time(8, 40, 30), t(20))  # 30 seconds past 08:30 + 10 min grace: the engine flags it
        punch(4, time(8, 40, 0), t(20))  # exactly on the deadline: on time
        settings = PayrollSettings.get()
        compute_range_records(self.e6, d(3), d(4), settings)
        self.assertEqual(
            [
                r.is_late
                for r in AttendanceDayRecord.objects.filter(employee=self.e6, date__in=[d(3), d(4)]).order_by("date")
            ],
            [True, False],
        )
        params = {**MONTH_RANGE, "employmentType": "production", "employeeIds": str(self.e6.id)}
        (r,) = self.data(self.run_report("late-coming-detail", **params))
        self.assertEqual(
            (r["date"], r["shiftStart"], r["deadline"], r["firstPunch"], r["lateMinutes"], r["beyondGrace"]),
            (iso(3), "08:30", "08:40", "08:40", 11, 1),  # rounded up: a flagged day never reads "0 minutes"
        )
        # grace configured as 0 is read by the engine as the 10-minute default
        ProductionShiftConfig.objects.update_or_create(pk=1, defaults={"grace_minutes": 0})
        punch(5, t(8, 45), t(20))
        compute_range_records(self.e6, d(5), d(5), settings)
        rows = self.keyed(self.run_report("late-coming-detail", **params), "date")
        self.assertEqual(
            (rows[(iso(5),)]["deadline"], rows[(iso(5),)]["lateMinutes"], rows[(iso(5),)]["beyondGrace"]),
            ("08:40", 15, 5),
        )
        self.assertEqual(rows[(iso(3),)]["beyondGrace"], 1)

    def test_branch_scoped_user_sees_only_own_branch_and_cannot_widen(self):
        body = self.run_report("late-coming-detail", self.b1_user, **self.P)
        self.assertEqual({r["employeeCode"] for r in self.data(body)}, {"AA001", "AA002", "AA008"})
        self.assertEqual(len(self.data(body)), 6)
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
        self.assertEqual(len(self.data(body)), 7)  # what was flagged earlier is not erased

    def test_missing_records_are_reported_not_hidden(self):
        AttendanceDayRecord.objects.filter(employee=self.e1, date__in=[d(11), d(12)]).delete()
        body = self.run_report("late-coming-detail", **self.P)
        self.assertIn("Data freshness: 2 employee-day(s)", self.note_text(body))


class LateCountsTests(_Base):
    P = {"period": MONTH, "employmentType": "staff"}

    def test_golden_pool_rows(self):
        body = self.run_report("late-summary-counts", **self.P)
        by = self.keyed(body, "employeeCode")
        self.assertEqual(
            [r["employeeCode"] for r in self.data(body)], ["AA001", "AA002", "AA007", "AA008", "AA004", "AA003"]
        )
        a = by[("AA001",)]
        self.assertEqual(
            (
                a["shift"],
                a["workingDays"],
                a["lateDays"],
                a["lateIn"],
                a["earlyOut"],
                a["excessPermissions"],
                a["poolTotal"],
                a["freeUsed"],
                a["billable"],
                a["minutesTotal"],
                a["minutesAvg"],
                a["minutesMax"],
                a["approvedPermissions"],
                a["halfDays"],
            ),
            (
                "General",
                25,
                4,
                3,
                1,
                0,
                4,
                3,
                1,
                131,
                33,
                50,
                2,
                3,
            ),  # 14:35 (second half) and 10:20 (excused) are no late
        )
        self.assertNotIn("nightLate", a)  # Simple mode: the strict-mode lunch-return flag has no column
        b = by[("AA002",)]
        self.assertEqual(
            (
                b["lateDays"],
                b["lateIn"],
                b["earlyOut"],
                b["excessPermissions"],
                b["poolTotal"],
                b["freeUsed"],
                b["billable"],
                b["minutesTotal"],
                b["approvedPermissions"],
                b["halfDays"],
            ),
            (1, 0, 1, 1, 2, 2, 0, 40, 4, 1),
        )
        c = by[("AA003",)]  # Saturday off: 21 working days; the early-out on a Saturday off is not a pool occurrence
        self.assertEqual((c["workingDays"], c["earlyOut"], c["poolTotal"], c["halfDays"]), (21, 0, 0, 1))
        self.assertEqual(
            (by[("AA004",)]["lateIn"], by[("AA004",)]["poolTotal"], by[("AA004",)]["minutesTotal"]), (1, 1, 30)
        )
        g = by[("AA007",)]
        self.assertEqual(
            (g["shift"], g["poolTotal"], g["minutesAvg"], g["minutesMax"]), ("No shift assigned", 0, None, None)
        )
        self.assertEqual((by[("AA008",)]["lateIn"], by[("AA008",)]["minutesTotal"]), (1, 30))

    def test_summary_totals_subtotals_and_notes(self):
        body = self.run_report("late-summary-counts", **self.P)
        self.assertEqual(self.card(body, "Employees with lates"), 4)
        self.assertEqual(self.card(body, "Over the free allowance"), 1)
        self.assertEqual(self.card(body, "Pool occurrences"), 8)
        self.assertEqual(self.card(body, "Late minutes"), 231)
        self.assertEqual(self.card(body, "Free allowance / month"), 3)
        self.assertEqual(self.card(body, "Permission cap / month"), 3)
        self.assertEqual(body["totals"]["poolTotal"], 8)
        self.assertEqual(body["totals"]["lateDays"], 7)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["poolTotal"], 4 + 2 + 0 + 1)
        self.assertEqual(subs["SEWING total"]["poolTotal"], 0)
        text = self.note_text(body)
        self.assertIn("1 staff employee(s) have no shift assignment", text)
        self.assertNotIn("Data freshness", text)

    def test_filters(self):
        def codes(**kw):
            return [r["employeeCode"] for r in self.data(self.run_report("late-summary-counts", **{**self.P, **kw}))]

        self.assertEqual(codes(minPool="1"), ["AA001", "AA002", "AA008", "AA004"])
        self.assertEqual(codes(minPool="4"), ["AA001"])
        self.assertEqual(codes(minPool="6"), [])  # AA001 has 5 now: the half-day arrival is no late
        self.assertEqual(codes(onlyBillable="true"), ["AA001"])
        self.assertEqual(codes(departmentIds=str(self.sew.id)), ["AA003"])
        self.assertEqual(codes(employeeIds=f"{self.e1.id},{self.e4.id}"), ["AA001", "AA004"])
        self.assertEqual(
            codes(employmentType="production"), ["AA006", "AA005"]
        )  # register order: department, then code
        self.assertEqual(codes(departmentIds=str(self.empty_dept.id)), [])

    def test_production_has_no_pool(self):
        body = self.run_report("late-summary-counts", period=MONTH, employmentType="production")
        by = self.keyed(body, "employeeCode")
        self.assertEqual(
            (by[("AA005",)]["lateDays"], by[("AA005",)]["poolTotal"], by[("AA005",)]["workingDays"]), (1, None, None)
        )
        self.assertEqual(by[("AA005",)]["minutesTotal"], 30)

    def test_night_late_shows_in_strict_mode_or_when_a_day_carries_it(self):
        keys = lambda body: [c["key"] for c in body["columns"]]  # noqa: E731
        self.assertNotIn("nightLate", keys(self.run_report("late-summary-counts", **self.P)))
        self.assertIn("Simple mode", self.note_text(self.run_report("late-summary-counts", **self.P)))
        AttendanceDayRecord.objects.filter(employee=self.e1, date=d(10)).update(late_afternoon=True)
        body = self.run_report("late-summary-counts", **self.P, employeeIds=str(self.e1.id))
        self.assertIn("nightLate", keys(body))
        (a,) = self.data(body)
        self.assertEqual(a["nightLate"], 1)
        self.assertIn("never priced", self.note_text(body))
        AttendanceDayRecord.objects.filter(employee=self.e1, date=d(10)).update(late_afternoon=False)
        PayrollSettings.objects.filter(pk=1).update(attendance_mode="strict")
        body = self.run_report("late-summary-counts", **self.P, employeeIds=str(self.e1.id))
        self.assertIn("nightLate", keys(body))
        self.assertEqual(self.data(body)[0]["nightLate"], 0)

    def test_flagged_days_whose_minutes_cannot_be_derived_are_unknown_not_zero(self):
        self.gen.start_time = t(9, 45)  # 09:40 is no longer late under the shift as edited after the day was computed
        self.gen.save()
        row = self.keyed(self.run_report("late-summary-counts", **self.P, employeeIds=str(self.e2.id)), "employeeCode")[
            ("AA002",)
        ]
        self.assertEqual(
            (row["lateDays"], row["minutesTotal"], row["minutesAvg"], row["minutesMax"], row["worstDay"]),
            (1, None, None, None, None),
        )
        self.assertEqual(row["poolTotal"], 2)  # the pool still follows the stored flags, like payroll

    def test_worst_day_is_the_date_of_the_longest_late(self):
        by = self.keyed(self.run_report("late-summary-counts", **self.P), "employeeCode")
        self.assertEqual(
            (by[("AA001",)]["minutesMax"], by[("AA001",)]["worstDay"]), (50, iso(8))
        )  # not the 14:35 half-day arrival on the 10th: that one is no late
        self.assertEqual((by[("AA002",)]["minutesMax"], by[("AA002",)]["worstDay"]), (40, iso(9)))
        self.assertEqual((by[("AA004",)]["minutesMax"], by[("AA004",)]["worstDay"]), (30, iso(2)))
        self.assertEqual((by[("AA003",)]["minutesMax"], by[("AA003",)]["worstDay"]), (None, None))
        # a tie goes to the earlier day
        AttendanceDayRecord.objects.filter(employee=self.e4, date=d(3)).update(
            is_late=True, first_punch=t(9, 30), status="present", shifts_earned=Decimal("1.00")
        )
        row = self.keyed(self.run_report("late-summary-counts", **self.P, employeeIds=str(self.e4.id)), "employeeCode")[
            ("AA004",)
        ]
        self.assertEqual((row["lateDays"], row["minutesMax"], row["worstDay"]), (2, 30, iso(2)))

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
        self.assertEqual(self.card(body, "Pool occurrences"), 7)
        body = self.run_report("late-summary-counts", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])


class LatePenaltyTests(_Base):
    P = {"period": MONTH}

    def setUp(self):
        super().setUp()
        # AA001 has 4 pool occurrences now that its 14:35 second-half arrival and its permission-excused 10:20 are no
        # longer Late-Ins. A free allowance of 1 keeps the money maths exercised: 3 billable = the
        # "3+ billable = 0.25 shift" slab.
        PayrollSettings.objects.filter(pk=1).update(late_free_allowance=1)

    def test_golden_rows_and_money(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        by = self.keyed(body, "employeeCode")
        self.assertEqual(
            sorted(by), [("AA001",), ("AA002",), ("AA003",), ("AA004",), ("AA007",), ("AA008",)]
        )  # staff only
        a = by[("AA001",)]
        self.assertEqual(
            (
                a["workingDays"],
                a["lateInEarlyOut"],
                a["excessPermissions"],
                a["poolTotal"],
                a["freeUsed"],
                a["billable"],
                a["shiftDeductions"],
                a["salaryDeduction"],
            ),
            (25, 4, 0, 4, 1, 3, 0.25, 260.0),  # 0.25 shift x 26000 / 25 working days
        )
        b = by[("AA002",)]
        self.assertEqual(
            (
                b["lateInEarlyOut"],
                b["excessPermissions"],
                b["poolTotal"],
                b["freeUsed"],
                b["billable"],
                b["shiftDeductions"],
                b["salaryDeduction"],
            ),
            (1, 1, 2, 1, 1, 0.0, 0.0),
        )
        self.assertEqual((by[("AA003",)]["workingDays"], by[("AA003",)]["salaryDeduction"]), (21, 0.0))
        self.assertEqual((by[("AA004",)]["poolTotal"], by[("AA004",)]["salaryDeduction"]), (1, 0.0))
        self.assertIsNone(by[("AA007",)]["salaryDeduction"])  # no salary configured: payroll skips them

    def test_summary_totals_and_subtotals(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        self.assertEqual(self.card(body, "Employees with a deduction"), 1)
        self.assertEqual(self.card(body, "Pool occurrences"), 8)
        self.assertEqual(self.card(body, "Billable occurrences"), 4)
        self.assertEqual(self.card(body, "Shifts deducted"), 0.25)
        self.assertEqual(self.card(body, "Salary deduction"), 260.0)
        self.assertEqual(body["totals"]["salaryDeduction"], 260.0)
        self.assertEqual(body["totals"]["billable"], 4)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["salaryDeduction"], 260.0)
        self.assertEqual(subs["CUTTING total"]["poolTotal"], 7)
        text = self.note_text(body)
        self.assertIn("Free allowance: 1 per month", text)
        self.assertIn("3+ billable = 0.25 shift", text)

    def test_reproduces_payroll_and_the_report_log_screen(self):
        body = self.run_report("late-penalty-breakdown", **self.P)
        by = self.keyed(body, "employeeCode")
        # (1) the payslip the real payroll path generates
        slip = _generate_staff_payroll(self.e1, 3, 2026)["slip"]
        self.assertEqual(slip.other_deductions, Decimal("260.00"))
        self.assertEqual(float(slip.other_deductions), by[("AA001",)]["salaryDeduction"])
        self.assertEqual(
            slip.breakdown_details["deductions"]["lateSummary"]["billableLateCount"], by[("AA001",)]["billable"]
        )
        # (2) the saved snapshot behind the Report Log 'Late-Penalty Breakdown' (refreshed the way strict payroll does)
        for emp, code in ((self.e1, "AA001"), (self.e2, "AA002")):
            days = staff_working_days(emp, 3, 2026)
            compute_monthly_shift_summary(
                emp,
                2026,
                3,
                daily_rate=_d2(emp.salary_amount / len(days)),
                counted_dates=set(days),
            )
        legacy = {
            r["employeeCode"]: r
            for r in self.call("/api/attendance/late-summary", month=3, year=2026).json()["employees"]
        }
        for code in ("AA001", "AA002"):
            row, old = by[(code,)], legacy[code]
            self.assertEqual(row["lateInEarlyOut"], old["totalLateCount"], code)
            self.assertEqual(row["excessPermissions"], old["permissionOverageCount"], code)
            self.assertEqual(row["freeUsed"], old["permissionsUsed"], code)
            self.assertEqual(row["billable"], old["billableLateCount"], code)
            self.assertEqual(row["shiftDeductions"], float(old["shiftDeductions"]), code)
            self.assertEqual(row["salaryDeduction"], float(old["salaryDeductionAmount"]), code)

    def test_every_staff_row_agrees_with_the_payslip_the_real_payroll_path_builds(self):
        by = self.keyed(self.run_report("late-penalty-breakdown", **self.P), "employeeCode")
        for emp in (self.e1, self.e2, self.e3, self.e4):
            with self.subTest(emp.employee_code):
                slip = _generate_staff_payroll(emp, 3, 2026)["slip"]
                paid = slip.breakdown_details["deductions"]["lateSummary"]
                row = by[(emp.employee_code,)]
                self.assertEqual(row["lateInEarlyOut"], paid["lateInCount"] + paid["earlyOutCount"])
                self.assertEqual(row["excessPermissions"], paid["excessPermissionCount"])
                self.assertEqual(row["poolTotal"], paid["totalLateCount"])
                self.assertEqual(row["freeUsed"], paid["freeAllowanceUsed"])
                self.assertEqual(row["billable"], paid["billableLateCount"])
                self.assertEqual(row["shiftDeductions"], paid["shiftDeductions"])
                self.assertEqual(row["salaryDeduction"], float(slip.other_deductions))

    def test_filters_and_scoping(self):
        body = self.run_report("late-penalty-breakdown", **self.P, onlyAffected="true")
        self.assertEqual({r["employeeCode"] for r in self.data(body)}, {"AA001", "AA002", "AA004", "AA008"})
        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA001"])
        body = self.run_report("late-penalty-breakdown", self.b1_user, **self.P)
        self.assertNotIn("AA004", {r["employeeCode"] for r in self.data(body)})
        body = self.run_report("late-penalty-breakdown", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])

    def test_the_free_column_is_headed_with_the_allowance_like_the_report_log_screen(self):
        def free_header(body):
            return next(c["label"] for c in body["columns"] if c["key"] == "freeUsed")

        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        self.assertEqual(free_header(body), "Free (1)")
        PayrollSettings.objects.filter(pk=1).update(late_free_allowance=5)
        body = self.run_report("late-penalty-breakdown", **self.P, employeeIds=str(self.e1.id))
        self.assertEqual(free_header(body), "Free (5)")
        (a,) = self.data(body)
        self.assertEqual(
            (a["poolTotal"], a["freeUsed"], a["billable"], a["shiftDeductions"], a["salaryDeduction"]),
            (4, 4, 0, 0.0, 0.0),
        )
        # the file carries the same header
        r = self.call("/api/reports/export/late-penalty-breakdown", fmt="xlsx", **self.P, employeeIds=str(self.e1.id))
        header = [c.value for c in load_workbook(io.BytesIO(r.content)).active[7]]
        self.assertIn("Free (5)", header)

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
            (
                a["shift"],
                a["shiftEnd"],
                a["deadline"],
                a["lastPunch"],
                a["earlyMinutes"],
                a["permission"],
                a["poolStatus"],
                a["status"],
            ),
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
            params = {**MONTH_RANGE, "employmentType": "staff", **kw}
            return sorted(self.keyed(self.run_report("early-out", user, **params), "employeeCode", "date"))

        self.assertEqual(keys(employeeIds=str(self.e2.id)), [("AA002", iso(13))])
        self.assertEqual(keys(permissionEffect="applied"), [])
        self.assertEqual(len(keys(permissionEffect="none")), 3)
        self.assertEqual(keys(departmentIds=str(self.sew.id)), [("AA003", iso(21))])
        self.assertEqual(keys(self.b1_user, branchIds=str(self.b2.id)), [])
        self.assertEqual(keys(dateFrom="2026-03-13", dateTo="2026-03-13"), [("AA002", iso(13))])

    def test_production_uses_the_production_reference_times(self):
        body = self.run_report("early-out", **{**MONTH_RANGE, "employmentType": "production"})
        by = self.keyed(body, "employeeCode", "date")
        self.assertEqual(sorted(by), [("AA005", iso(3)), ("AA005", iso(4))])
        r = by[("AA005", iso(3))]
        self.assertEqual(
            (r["shift"], r["shiftEnd"], r["deadline"], r["lastPunch"], r["earlyMinutes"], r["poolStatus"]),
            ("Production (fixed times)", "20:00", "19:50", "17:30", 150, "Production (separate)"),
        )

    def test_switched_off_detection_is_stated(self):
        PayrollSettings.objects.filter(pk=1).update(evening_early_out_enabled=False)
        body = self.run_report("early-out", **{**MONTH_RANGE, "employmentType": "staff"})
        self.assertIn("switched off", self.note_text(body))
        self.assertEqual(len(self.data(body)), 3)  # what was flagged earlier is not erased


# ═════════════════════════════════════════════════════════════════════════════
#  half-day
# ═════════════════════════════════════════════════════════════════════════════


class HalfDayTests(_Base):
    def test_golden_detail_rows(self):
        body = self.run_report("half-day", **MONTH_RANGE)
        self.assertEqual(
            [(r["employeeCode"], r["date"]) for r in self.data(body)],
            [
                ("AA001", iso(9)),
                ("AA001", iso(10)),
                ("AA001", iso(11)),
                ("AA002", iso(16)),
                ("AA003", iso(6)),
                ("AA005", iso(4)),
            ],
        )
        by = self.keyed(body, "employeeCode", "date")
        a = by[("AA001", iso(9))]
        self.assertEqual(
            (
                a["halfWorked"],
                a["cause"],
                a["firstPunch"],
                a["lastPunch"],
                a["punchCount"],
                a["leaveSlot"],
                a["shiftsEarned"],
                a["shiftsLost"],
                a["late"],
                a["source"],
                a["note"],
                a["day"],
            ),
            ("Morning", "Left early", "08:55", "13:00", 2, None, 0.5, 0.5, None, "Biometric", None, "Mon"),
        )
        b = by[("AA001", iso(10))]
        # arrived after the Morning Half was over: the cause is the half-day arrival, and it is not also "Late"
        self.assertEqual((b["halfWorked"], b["cause"], b["late"]), ("Evening", "Arrived late", None))
        c = by[("AA001", iso(11))]  # a lone punch is a half day by rule: a probable missing punch
        self.assertEqual(
            (c["halfWorked"], c["cause"], c["lastPunch"], c["punchCount"]), ("Morning", "Single punch", None, 1)
        )
        e = by[("AA002", iso(16))]
        self.assertEqual(
            (e["halfWorked"], e["cause"], e["leaveSlot"], e["late"]), ("Evening", "Half-day leave", "Morning", None)
        )
        m = by[("AA003", iso(6))]
        self.assertEqual(
            (m["halfWorked"], m["cause"], m["firstPunch"], m["punchCount"], m["source"], m["note"]),
            (None, "HR override", None, 0, "HR override", "Approved half day"),
        )
        p = by[("AA005", iso(4))]
        self.assertEqual(
            (p["halfWorked"], p["cause"], p["shiftsEarned"], p["shiftsLost"]), (None, "Short production day", 0.5, None)
        )

    def test_summary_and_totals(self):
        body = self.run_report("half-day", **MONTH_RANGE)
        self.assertEqual(self.card(body, "Half days"), 6)
        self.assertEqual(self.card(body, "Employees affected"), 4)
        self.assertEqual(
            self.card(body, "Shift equivalents lost"), 2.5
        )  # 5 staff half days x 0.5; production is not scaled
        self.assertEqual(self.card(body, "Morning half worked"), 2)
        self.assertEqual(self.card(body, "Evening half worked"), 2)
        self.assertEqual(self.card(body, "Single-punch days"), 1)
        self.assertEqual(body["totals"]["shiftsLost"], 2.5)
        self.assertEqual(body["totals"]["shiftsEarned"], 3.0)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual((subs["CUTTING total"]["shiftsEarned"], subs["CUTTING total"]["shiftsLost"]), (2.0, 2.0))
        self.assertEqual(
            (subs["SEWING total"]["shiftsEarned"], subs["SEWING total"]["shiftsLost"]), (1.0, 0.5)
        )  # production has no "lost"

    def test_filters(self):
        def keys(**kw):
            return sorted(
                (r["employeeCode"], r["date"]) for r in self.data(self.run_report("half-day", **{**MONTH_RANGE, **kw}))
            )

        self.assertEqual(len(keys(employmentType="staff")), 5)
        self.assertEqual(keys(employmentType="production"), [("AA005", iso(4))])
        self.assertEqual(keys(halfWorked="morning"), [("AA001", iso(9)), ("AA001", iso(11))])
        self.assertEqual(keys(halfWorked="evening"), sorted([("AA001", iso(10)), ("AA002", iso(16))]))
        self.assertEqual(keys(halfWorked="unknown"), sorted([("AA003", iso(6)), ("AA005", iso(4))]))
        self.assertEqual(keys(cause="single_punch"), [("AA001", iso(11))])
        self.assertEqual(keys(cause="left_early"), [("AA001", iso(9))])
        self.assertEqual(keys(cause="arrived_late"), [("AA001", iso(10))])
        self.assertEqual(keys(cause="half_day_leave"), [("AA002", iso(16))])
        self.assertEqual(keys(cause="hr_override"), [("AA003", iso(6))])
        self.assertEqual(keys(cause="production_short_day"), [("AA005", iso(4))])
        self.assertEqual(keys(employeeIds=str(self.e2.id)), [("AA002", iso(16))])
        self.assertEqual(keys(departmentIds=str(self.sew.id)), [("AA003", iso(6)), ("AA005", iso(4))])
        self.assertEqual(
            keys(dateFrom="2026-03-10", dateTo="2026-03-11", employmentType="staff"),
            [("AA001", iso(10)), ("AA001", iso(11))],
        )
        self.assertEqual(keys(departmentIds=str(self.empty_dept.id)), [])

    def test_summary_view_counts_per_employee(self):
        body = self.run_report("half-day", **MONTH_RANGE, employmentType="staff", view="summary")
        by = self.keyed(body, "employeeCode")
        a = by[("AA001",)]
        self.assertEqual(
            (
                a["halfDays"],
                a["morning"],
                a["evening"],
                a["unknown"],
                a["singlePunch"],
                a["leftEarly"],
                a["arrivedLate"],
                a["halfDayLeave"],
                a["hrOverride"],
                a["shiftsLost"],
            ),
            (3, 2, 1, 0, 1, 1, 1, 0, 0, 1.5),
        )
        b = by[("AA002",)]
        self.assertEqual((b["halfDays"], b["evening"], b["halfDayLeave"], b["shiftsLost"]), (1, 1, 1, 0.5))
        c = by[("AA003",)]
        self.assertEqual((c["halfDays"], c["unknown"], c["hrOverride"]), (1, 1, 1))
        self.assertEqual(body["totals"]["halfDays"], 5)
        self.assertEqual(self.subtotals(body)[0]["halfDays"], 4)  # CUTTING: AA001 x3 + AA002
        self.assertNotIn("date", [c["key"] for c in body["columns"]])

    def test_branch_isolation(self):
        body = self.run_report("half-day", self.b1_user, **MONTH_RANGE)
        self.assertEqual(len(self.data(body)), 6)  # none of the fixture's half days belong to Unit 2
        # give Unit 2 a half day: the Unit 1 user must not see it, even when asking for it
        AttendanceDayRecord.objects.filter(employee=self.e4, date=d(3)).update(
            status="half_shift", is_half_shift=True, shifts_earned=Decimal("0.50")
        )
        admin = self.run_report("half-day", **MONTH_RANGE)
        self.assertIn("AA004", {r["employeeCode"] for r in self.data(admin)})
        scoped = self.run_report("half-day", self.b1_user, **MONTH_RANGE, employeeIds=str(self.e4.id))
        self.assertEqual(self.data(scoped), [])
        scoped = self.run_report("half-day", self.b1_user, **MONTH_RANGE, branchIds=str(self.b2.id))
        self.assertEqual(self.data(scoped), [])

    def test_the_rule_in_the_notes_comes_from_settings(self):
        PayrollSettings.objects.filter(pk=1).update(
            arrival_late_window_minutes=30,
            arrival_permission_window_minutes=0,
            arrival_extra_minutes=5,
            half_day_second_half_start_time=t(15, 0),
        )
        body = self.run_report("half-day", **MONTH_RANGE, employmentType="staff", employeeIds=str(self.e1.id))
        by = self.keyed(body, "date")
        # which half was worked is the stored day's own verdict: 08:55 made the first half, 14:35 arrived after it
        self.assertEqual(by[(iso(9),)]["halfWorked"], "Morning")
        self.assertEqual(by[(iso(10),)]["halfWorked"], "Evening")
        text = self.note_text(body)
        self.assertIn("30 min Late window", text)
        self.assertIn("0 min permission window", text)
        self.assertIn("5 min extra", text)
        self.assertIn("(15:00)", text)

    def test_a_compensation_day_is_labelled(self):
        AttendanceDayRecord.objects.filter(employee=self.e1, date=d(9)).update(is_compensation_day=True)
        body = self.run_report("half-day", **MONTH_RANGE, employeeIds=str(self.e1.id))
        self.assertIn("Compensation day", self.keyed(body, "date")[(iso(9),)]["note"])


# ═════════════════════════════════════════════════════════════════════════════
#  absenteeism
# ═════════════════════════════════════════════════════════════════════════════


class AbsenteeismTests(_Base):
    def ids(self, *emps):
        return ",".join(str(e.id) for e in emps)

    def test_golden_rows(self):
        body = self.run_report(
            "absenteeism",
            **WEEK2,
            employeeIds=self.ids(self.e2, self.e3, self.e7, self.e8),
            includeNoAbsence="true",
        )
        by = self.keyed(body, "employeeCode")
        a = by[("AA002",)]
        self.assertEqual(
            (
                a["workingDays"],
                a["absentDays"],
                a["informedDays"],
                a["unauthorisedDays"],
                a["absentPct"],
                a["maxConsecutive"],
                a["streakFrom"],
                a["streakTo"],
                a["currentStreak"],
                a["lastPresent"],
                a["risk"],
            ),
            (12, 6, 0, 6, 50.0, 3, iso(5), iso(7), 1, iso(13), "High"),
        )
        c = by[("AA003",)]  # Saturday off: Saturdays are weekly off, not absences; one absence was marked Informed
        self.assertEqual(
            (
                c["workingDays"],
                c["absentDays"],
                c["informedDays"],
                c["unauthorisedDays"],
                c["absentPct"],
                c["maxConsecutive"],
                c["streakFrom"],
                c["streakTo"],
                c["currentStreak"],
                c["lastPresent"],
            ),
            (10, 4, 1, 3, 40.0, 3, iso(9), iso(11), 1, iso(12)),
        )
        g = by[("AA007",)]  # the Sunday between two absent runs is bridged by the sandwich rule
        self.assertEqual(
            (
                g["workingDays"],
                g["absentDays"],
                g["maxConsecutive"],
                g["streakFrom"],
                g["streakTo"],
                g["currentStreak"],
                g["lastPresent"],
            ),
            (12, 11, 11, iso(3), iso(14), 11, iso(2)),
        )
        h = by[("AA008",)]  # absent records after the approved last working day (6 March) are not absences
        self.assertEqual(
            (h["workingDays"], h["absentDays"], h["maxConsecutive"], h["streakFrom"], h["risk"]), (5, 0, 0, None, "Low")
        )

    def test_bridging_option(self):
        body = self.run_report("absenteeism", **WEEK2, employeeIds=str(self.e7.id), bridgeWeeklyOffs="false")
        (g,) = self.data(body)
        self.assertEqual(
            (g["maxConsecutive"], g["streakFrom"], g["streakTo"], g["currentStreak"]), (6, iso(9), iso(14), 6)
        )
        self.assertIn("breaks the streak", self.note_text(body))

    def test_approved_leave_has_its_own_column_and_breaks_a_streak(self):
        LeaveRequest.objects.create(
            employee=self.e7,
            start_date="2026-03-10",
            end_date="2026-03-11",
            total_days=Decimal("2"),
            status="approved",
            type="casual",
        )
        compute_range_records(self.e7, MAR, date(2026, 3, 31), PayrollSettings.get())
        body = self.run_report("absenteeism", **WEEK2, employeeIds=str(self.e7.id))
        (g,) = self.data(body)
        self.assertEqual(
            (
                g["workingDays"],
                g["absentDays"],
                g["leaveDays"],
                g["absentPct"],
                g["maxConsecutive"],
                g["streakFrom"],
                g["streakTo"],
                g["currentStreak"],
            ),
            (
                12,
                9,
                2,
                75.0,
                6,
                iso(3),
                iso(9),
                3,
            ),  # 3rd-7th, the bridged Sunday and the 9th; leave on the 10th-11th; then 12th-14th
        )
        self.assertEqual(body["totals"]["leaveDays"], 2)
        self.assertIn("On leave column", self.note_text(body))

    def test_summary_totals_subtotals(self):
        body = self.run_report(
            "absenteeism",
            **WEEK2,
            employeeIds=self.ids(self.e2, self.e3, self.e7, self.e8),
            includeNoAbsence="true",
        )
        self.assertEqual(self.card(body, "Employees with absence"), 3)
        self.assertEqual(self.card(body, "Absent days"), 21)
        self.assertEqual(self.card(body, "Absenteeism %"), 53.8)  # 21 / (12 + 10 + 12 + 5)
        self.assertEqual(self.card(body, "Unauthorised days"), 20)
        self.assertEqual(self.card(body, "Streak of 3+ days"), 3)
        self.assertEqual(body["totals"]["absentDays"], 21)
        self.assertEqual(body["totals"]["workingDays"], 39)
        self.assertEqual(body["totals"]["absentPct"], 53.8)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual((subs["CUTTING total"]["absentDays"], subs["CUTTING total"]["workingDays"]), (17, 29))
        self.assertEqual(subs["CUTTING total"]["absentPct"], 58.6)
        self.assertEqual((subs["SEWING total"]["absentDays"], subs["SEWING total"]["workingDays"]), (4, 10))

    def test_filters(self):
        def codes(**kw):
            return [
                r["employeeCode"]
                for r in self.data(self.run_report("absenteeism", **{**WEEK2, "employmentType": "staff", **kw}))
            ]

        self.assertEqual(codes(), ["AA002", "AA007", "AA004", "AA003"])  # AA004 has one punch day and 11 absences
        self.assertEqual(codes(minConsecutive="5"), ["AA007", "AA004"])
        self.assertEqual(codes(minConsecutive="10"), ["AA007", "AA004"])
        self.assertEqual(codes(departmentIds=str(self.sew.id)), ["AA003"])
        self.assertEqual(codes(employeeIds=str(self.e3.id)), ["AA003"])
        self.assertEqual(codes(departmentIds=str(self.empty_dept.id)), [])
        self.assertIn("AA001", codes(includeNoAbsence="true"))

    def test_production_sunday_option(self):
        p = dict(dateFrom="2026-03-02", dateTo="2026-03-08", employeeIds=str(self.e5.id))
        (on,) = self.data(self.run_report("absenteeism", **p))
        self.assertEqual(
            (on["workingDays"], on["absentDays"], on["absentPct"]), (6, 2, 33.3)
        )  # Sunday 8th (worked) is not a scheduled day
        (off,) = self.data(self.run_report("absenteeism", **p, productionSundayOff="false"))
        self.assertEqual((off["workingDays"], off["absentDays"], off["absentPct"]), (7, 2, 28.6))
        q = dict(dateFrom="2026-03-14", dateTo="2026-03-15", employeeIds=str(self.e5.id))
        (on,) = self.data(self.run_report("absenteeism", **q))
        self.assertEqual((on["workingDays"], on["absentDays"], on["maxConsecutive"]), (1, 1, 1))
        (off,) = self.data(self.run_report("absenteeism", **q, productionSundayOff="false"))
        self.assertEqual((off["workingDays"], off["absentDays"], off["maxConsecutive"]), (2, 2, 2))

    def test_today_is_still_running(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=d(9)):
            body = self.run_report(
                "absenteeism", dateFrom="2026-03-02", dateTo="2026-03-09", employeeIds=str(self.e7.id)
            )
        (g,) = self.data(body)
        # Mar 3-7 and Mar 9 would be 11 with the 9th; today (the 9th) is provisional and skipped
        self.assertEqual((g["absentDays"], g["workingDays"], g["currentStreak"]), (5, 6, 5))

    def test_branch_isolation(self):
        body = self.run_report("absenteeism", self.b1_user, **WEEK2)
        self.assertNotIn("AA004", {r["employeeCode"] for r in self.data(body)})
        body = self.run_report("absenteeism", self.b1_user, **WEEK2, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])
        body = self.run_report("absenteeism", self.b1_user, **WEEK2, employeeIds=str(self.e4.id))
        self.assertEqual(self.data(body), [])


# ═════════════════════════════════════════════════════════════════════════════
#  worked hours vs schedule
# ═════════════════════════════════════════════════════════════════════════════


class WorkedHoursTests(_Base):
    P = {"dateFrom": "2026-03-09", "dateTo": "2026-03-13"}

    def both(self):
        return {"employeeIds": f"{self.e1.id},{self.e2.id}"}

    def test_daily_golden(self):
        body = self.run_report("worked-hours-shortfall", **self.P, **self.both(), view="daily")
        by = self.keyed(body, "employeeCode", "date")
        self.assertEqual(len(by), 8)
        cases = {
            ("AA001", iso(9)): (4.0, 4.08, 0.0, 0.08, "Span"),  # 08:55-13:00, no lunch inside the span
            ("AA001", iso(10)): (4.0, 3.42, 0.58, 0.0, "Span"),  # 14:35-18:00
            ("AA001", iso(11)): (4.0, None, None, None, "Single punch"),
            ("AA001", iso(12)): (8.0, 15.0, 0.0, 7.0, "Span"),  # 09:00 to 01:00 next day, less lunch
            ("AA001", iso(13)): (8.0, 8.0, 0.0, 0.0, "Span"),  # its own 01:00 punch belongs to the 12th
            ("AA002", iso(9)): (8.0, 7.33, 0.67, 0.0, "Span"),
            ("AA002", iso(12)): (8.0, 8.0, 0.0, 0.0, "Paired"),
            ("AA002", iso(13)): (8.0, 6.5, 1.5, 0.0, "Paired"),
        }
        for key, (sched, worked, short, excess, basis) in cases.items():
            r = by[key]
            self.assertEqual(
                (r["scheduledHours"], r["workedHours"], r["shortfallHours"], r["excessHours"], r["basis"]),
                (sched, worked, short, excess, basis),
                key,
            )

    def test_summary_golden_and_totals(self):
        body = self.run_report("worked-hours-shortfall", **self.P, **self.both())
        by = self.keyed(body, "employeeCode")
        a = by[("AA001",)]
        self.assertEqual((a["daysWorked"], a["daysUnknown"], a["scheduledHours"]), (4, 1, 24.0))
        self.assertAlmostEqual(a["workedHours"], 30.5, delta=0.011)
        self.assertAlmostEqual(a["shortfallHours"], 0.58, delta=0.011)
        self.assertAlmostEqual(a["excessHours"], 7.08, delta=0.011)
        self.assertAlmostEqual(a["avgHours"], 7.63, delta=0.011)
        b = by[("AA002",)]
        self.assertEqual((b["daysWorked"], b["daysUnknown"], b["scheduledHours"]), (3, 0, 24.0))
        self.assertAlmostEqual(b["workedHours"], 21.83, delta=0.011)
        self.assertAlmostEqual(b["shortfallHours"], 2.17, delta=0.011)
        self.assertEqual(b["excessHours"], 0.0)
        self.assertEqual(body["totals"]["daysWorked"], 7)
        self.assertAlmostEqual(body["totals"]["scheduledHours"], 48.0, delta=0.011)
        self.assertEqual(self.card(body, "Employees"), 2)
        self.assertAlmostEqual(self.card(body, "Worked hours"), 52.33, delta=0.011)
        self.assertEqual(self.subtotals(body)[0]["daysWorked"], 7)

    def test_filters_and_options(self):
        def daily(**kw):
            params = {**self.P, **self.both(), "view": "daily", **kw}
            body = self.run_report("worked-hours-shortfall", **params)
            return sorted((r["employeeCode"], r["date"]) for r in self.data(body))

        self.assertEqual(daily(minShortfall="60"), [("AA002", iso(13))])
        self.assertEqual(daily(minShortfall="30"), sorted([("AA001", iso(10)), ("AA002", iso(9)), ("AA002", iso(13))]))
        self.assertEqual(
            daily(employeeIds=str(self.e2.id)), [("AA002", iso(9)), ("AA002", iso(12)), ("AA002", iso(13))]
        )
        # no lunch deduction: the two-punch 13th is 9 hours
        body = self.run_report(
            "worked-hours-shortfall",
            dateFrom="2026-03-13",
            dateTo="2026-03-13",
            employeeIds=str(self.e1.id),
            view="daily",
            deductLunch="false",
        )
        (r,) = self.data(body)
        self.assertEqual((r["workedHours"], r["excessHours"]), (9.0, 1.0))

    def test_double_taps_are_collapsed(self):
        for tm in (t(9, 2), t(18, 3)):
            AttendanceLog.objects.create(
                employee=self.e2, date=d(3), punch_time=tm, punch_type="IN", source="biometric:test"
            )
        body = self.run_report(
            "worked-hours-shortfall",
            dateFrom="2026-03-03",
            dateTo="2026-03-03",
            employeeIds=str(self.e2.id),
            view="daily",
        )
        (r,) = self.data(body)
        # four raw punches, two real ones: 09:00-18:00 less lunch = 8h (pairing the taps would give 0h05m)
        self.assertEqual((r["workedHours"], r["basis"]), (8.0, "Span"))

    def test_staff_only_and_scoping(self):
        body = self.run_report("worked-hours-shortfall", **self.P, view="daily")
        self.assertEqual({"AA005", "AA006"} & {r["employeeCode"] for r in self.data(body)}, set())
        scoped = self.run_report(
            "worked-hours-shortfall", self.b1_user, **self.P, view="daily", employeeIds=str(self.e4.id)
        )
        self.assertEqual(self.data(scoped), [])

    def test_days_without_a_shift_have_no_schedule(self):
        body = self.run_report(
            "worked-hours-shortfall",
            dateFrom="2026-03-02",
            dateTo="2026-03-02",
            employeeIds=str(self.e7.id),
            view="daily",
        )
        (r,) = self.data(body)
        self.assertEqual(
            (r["shift"], r["workedHours"], r["scheduledHours"], r["shortfallHours"]),
            ("No shift assigned", 7.5, None, None),
        )
        self.assertIn("without a shift assignment", self.note_text(body))


# ═════════════════════════════════════════════════════════════════════════════
#  weekly-off / holiday work
# ═════════════════════════════════════════════════════════════════════════════


class OffDayWorkTests(_Base):
    def test_golden_rows(self):
        body = self.run_report("weekly-off-holiday-work", **MONTH_RANGE)
        self.assertEqual(
            [(r["employeeCode"], r["date"]) for r in self.data(body)],
            [("AA001", iso(8)), ("AA001", iso(19)), ("AA002", iso(15)), ("AA003", iso(21)), ("AA005", iso(19))],
        )
        by = self.keyed(body, "employeeCode", "date")
        a = by[("AA001", iso(8))]
        self.assertEqual(
            (
                a["dayType"],
                a["holidayName"],
                a["firstIn"],
                a["lastOut"],
                a["workedHours"],
                a["status"],
                a["compDay"],
                a["compensation"],
            ),
            ("Sunday", None, "09:50", "18:00", 7.17, "Present", None, "Pay announced"),
        )
        h = by[("AA001", iso(19))]
        self.assertEqual(
            (h["dayType"], h["holidayName"], h["workedHours"], h["compensation"]),
            ("Holiday", "Ugadi (test)", 8.0, "None announced"),
        )
        self.assertEqual((by[("AA002", iso(15))]["dayType"], by[("AA002", iso(15))]["workedHours"]), ("Sunday", 8.0))
        s = by[("AA003", iso(21))]
        self.assertEqual((s["dayType"], s["day"], s["workedHours"]), ("Saturday off", "Sat", 7.0))
        p = by[("AA005", iso(19))]  # production: only the Holiday counts (their Sunday the 8th is a normal working day)
        self.assertEqual(
            (p["dayType"], p["firstIn"], p["lastOut"], p["workedHours"]), ("Holiday", "08:30", "20:00", 11.5)
        )
        self.assertNotIn(("AA005", iso(8)), by)
        self.assertNotIn(("AA001", iso(7)), by)  # an ordinary (working) Saturday

    def test_summary_totals_subtotals(self):
        body = self.run_report("weekly-off-holiday-work", **MONTH_RANGE)
        self.assertEqual(self.card(body, "Off-day workings"), 5)
        self.assertEqual(self.card(body, "Employees"), 4)
        self.assertEqual(self.card(body, "Hours worked"), 41.67)
        self.assertEqual(self.card(body, "Staff days with no OT / comp decision"), 3)
        self.assertEqual(body["totals"]["workedHours"], 41.67)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["CUTTING total"]["workedHours"], 23.17)
        self.assertEqual(subs["SEWING total"]["workedHours"], 18.5)

    def test_filters_and_scoping(self):
        def keys(user=None, **kw):
            return sorted(
                (r["employeeCode"], r["date"])
                for r in self.data(self.run_report("weekly-off-holiday-work", user, **{**MONTH_RANGE, **kw}))
            )

        self.assertEqual(keys(dayType="sunday"), [("AA001", iso(8)), ("AA002", iso(15))])
        self.assertEqual(keys(dayType="saturday_off"), [("AA003", iso(21))])
        self.assertEqual(keys(dayType="holiday"), [("AA001", iso(19)), ("AA005", iso(19))])
        self.assertEqual(keys(employmentType="production"), [("AA005", iso(19))])
        self.assertEqual(len(keys(employmentType="staff")), 4)
        self.assertEqual(keys(departmentIds=str(self.sew.id)), [("AA003", iso(21)), ("AA005", iso(19))])
        self.assertEqual(keys(dateFrom="2026-03-10", dateTo="2026-03-16"), [("AA002", iso(15))])
        self.assertEqual(keys(self.b1_user, branchIds=str(self.b2.id)), [])

    def test_a_relaxation_decision_is_shown(self):
        OvertimeRecord.objects.create(
            employee=self.e2,
            date=d(15),
            last_punch_out=t(18),
            ot_minutes=0,
            status="announced",
            compensation_type="relaxation",
        )
        body = self.run_report("weekly-off-holiday-work", **MONTH_RANGE, employeeIds=str(self.e2.id))
        (r,) = self.data(body)
        self.assertEqual(r["compensation"], "Relaxation announced")


# ═════════════════════════════════════════════════════════════════════════════
#  department strength
# ═════════════════════════════════════════════════════════════════════════════


class StrengthTests(_Base):
    def test_golden_day(self):
        body = self.run_report("department-strength", dateFrom="2026-03-09", dateTo="2026-03-09")
        rows = self.data(body)
        self.assertEqual([r["department"] for r in rows], ["CUTTING", "PACKING", "SEWING"])
        by = {r["department"]: r for r in rows}
        keys = (
            "onRoll",
            "present",
            "halfDay",
            "absent",
            "onLeave",
            "weeklyOffHoliday",
            "notComputed",
            "late",
            "strengthPct",
            "shiftCredit",
        )
        # CUTTING: AA001 half, AA002 present (late), AA007 absent; AA008 left on the 6th and is not on roll
        self.assertEqual(tuple(by["CUTTING"][k] for k in keys), (3, 1, 1, 1, 0, 0, 0, 1, 66.7, 1.5))
        self.assertEqual(tuple(by["PACKING"][k] for k in keys), (2, 0, 0, 2, 0, 0, 0, 0, 0.0, 0.0))
        self.assertEqual(tuple(by["SEWING"][k] for k in keys), (2, 0, 0, 2, 0, 0, 0, 0, 0.0, 0.0))
        (sub,) = self.subtotals(body)
        self.assertEqual(sub["department"], "09-Mar-2026 total")
        self.assertEqual(
            (sub["onRoll"], sub["present"], sub["halfDay"], sub["absent"], sub["strengthPct"]), (7, 1, 1, 5, 28.6)
        )
        self.assertEqual(body["totals"]["onRoll"], 7)
        self.assertEqual(body["totals"]["strengthPct"], 28.6)
        self.assertEqual(self.card(body, "Average strength %"), 28.6)
        self.assertEqual(self.card(body, "Present man-days"), 2)
        self.assertEqual(self.card(body, "Absent man-days"), 5)
        self.assertEqual(self.card(body, "Late man-days"), 1)

    def test_on_duty_is_counted_inside_present_and_never_added_to_the_strength(self):
        def on_duty(emp, day, tm):
            AttendanceLog.objects.create(
                employee=emp, date=d(day), punch_time=tm, punch_type="IN", source="on_duty:approved"
            )

        on_duty(self.e2, 9, t(12))  # AA002 is present on the 9th
        on_duty(self.e2, 9, t(13))  # two punches, still one person
        on_duty(self.e1, 9, t(12))  # AA001 is a half day on the 9th
        on_duty(self.e7, 9, t(12))  # AA007 is absent: an on-duty punch that never made the day present is not counted
        on_duty(self.e4, 9, t(12))  # Unit 2
        AttendanceLog.objects.create(
            employee=self.e3, date=d(9), punch_time=t(12), punch_type="IN", source="biometric:test"
        )
        body = self.run_report("department-strength", dateFrom="2026-03-09", dateTo="2026-03-09")
        by = {r["department"]: r for r in self.data(body)}
        self.assertEqual(
            (by["CUTTING"]["onDuty"], by["CUTTING"]["present"], by["CUTTING"]["halfDay"], by["CUTTING"]["absent"]),
            (2, 1, 1, 1),
        )
        self.assertEqual(
            (by["PACKING"]["onDuty"], by["SEWING"]["onDuty"]), (0, 0)
        )  # AA004 is absent; a biometric punch is not on duty
        self.assertEqual(body["totals"]["onDuty"], 2)
        (sub,) = self.subtotals(body)
        self.assertEqual((sub["onDuty"], sub["strengthPct"]), (2, 28.6))  # unchanged by the on-duty people
        self.assertIn("On duty", " ".join(c["label"] for c in body["columns"]))
        scoped = self.run_report("department-strength", self.b1_user, dateFrom="2026-03-09", dateTo="2026-03-09")
        self.assertEqual(scoped["totals"]["onDuty"], 2)
        self.assertEqual(
            self.run_report(
                "department-strength",
                self.b1_user,
                dateFrom="2026-03-09",
                dateTo="2026-03-09",
                branchIds=str(self.b2.id),
            )["rows"],
            [],
        )

    def test_weekly_off_leaves_the_denominator(self):
        body = self.run_report("department-strength", dateFrom="2026-03-08", dateTo="2026-03-08")
        by = {r["department"]: r for r in self.data(body)}
        # Sunday: staff are on weekly off; only the people who worked (AA001, AA005) or were absent (AA006) count
        self.assertEqual(
            (
                by["CUTTING"]["onRoll"],
                by["CUTTING"]["present"],
                by["CUTTING"]["weeklyOffHoliday"],
                by["CUTTING"]["strengthPct"],
            ),
            (3, 1, 2, 100.0),
        )
        self.assertEqual(
            (
                by["SEWING"]["onRoll"],
                by["SEWING"]["present"],
                by["SEWING"]["weeklyOffHoliday"],
                by["SEWING"]["strengthPct"],
            ),
            (2, 1, 1, 100.0),
        )
        self.assertEqual(
            (by["PACKING"]["absent"], by["PACKING"]["weeklyOffHoliday"], by["PACKING"]["strengthPct"]), (1, 1, 0.0)
        )

    def test_saturday_off_is_weekly_off_not_absent(self):
        body = self.run_report(
            "department-strength", dateFrom="2026-03-07", dateTo="2026-03-07", departmentIds=str(self.sew.id)
        )
        (r,) = self.data(body)
        # AA003 (Saturday off) -> off; AA005 production -> absent
        self.assertEqual((r["onRoll"], r["weeklyOffHoliday"], r["absent"]), (2, 1, 1))

    def test_group_by_department(self):
        body = self.run_report("department-strength", dateFrom="2026-03-08", dateTo="2026-03-09", groupBy="department")
        labels = [r.get("department") for r in body["rows"]]
        self.assertEqual(
            labels,
            [
                "CUTTING",
                "CUTTING",
                "CUTTING total",
                "PACKING",
                "PACKING",
                "PACKING total",
                "SEWING",
                "SEWING",
                "SEWING total",
            ],
        )
        cutting = self.subtotals(body)[0]
        self.assertEqual(
            (cutting["onRoll"], cutting["present"], cutting["halfDay"], cutting["weeklyOffHoliday"]), (6, 2, 1, 2)
        )

    def test_days_nobody_has_opened_are_shown_not_guessed(self):
        AttendanceDayRecord.objects.filter(employee=self.e2, date=d(9)).delete()
        body = self.run_report(
            "department-strength", dateFrom="2026-03-09", dateTo="2026-03-09", departmentIds=str(self.cut.id)
        )
        (r,) = self.data(body)
        self.assertEqual((r["onRoll"], r["notComputed"], r["present"], r["halfDay"], r["absent"]), (3, 1, 0, 1, 1))
        self.assertEqual(r["strengthPct"], 33.3)  # 1 of 3 expected

    def test_inactive_status_filter_and_scoping(self):
        body = self.run_report(
            "department-strength", dateFrom="2026-03-04", dateTo="2026-03-04", employeeStatus="active"
        )
        cutting = next(r for r in self.data(body) if r["department"] == "CUTTING")
        self.assertEqual(cutting["onRoll"], 3)  # AA008 excluded by the status filter
        body = self.run_report("department-strength", dateFrom="2026-03-04", dateTo="2026-03-04")
        cutting = next(r for r in self.data(body) if r["department"] == "CUTTING")
        self.assertEqual(cutting["onRoll"], 4)  # AA008 was still employed on the 4th
        scoped = self.run_report("department-strength", self.b1_user, dateFrom="2026-03-04", dateTo="2026-03-04")
        self.assertNotIn("PACKING", [r["department"] for r in self.data(scoped)])
        scoped = self.run_report(
            "department-strength", self.b1_user, dateFrom="2026-03-04", dateTo="2026-03-04", branchIds=str(self.b2.id)
        )
        self.assertEqual(self.data(scoped), [])

    def test_future_dates_have_no_rows(self):
        body = self.run_report("department-strength", dateFrom="2090-01-01", dateTo="2090-01-03")
        self.assertEqual(body["rows"], [])
        self.assertIn("future", self.note_text(body))


# ═════════════════════════════════════════════════════════════════════════════
#  shifts: roster, gaps, shift-wise, production register
# ═════════════════════════════════════════════════════════════════════════════


class ShiftRosterTests(_Base):
    P = {"dateFrom": "2026-03-09", "dateTo": "2026-03-09"}

    def test_golden_rows(self):
        body = self.run_report("shift-roster", **self.P)
        self.assertEqual(
            [(r["shiftName"], r["employeeCode"]) for r in self.data(body)],
            [
                ("General", "AA001"),
                ("General", "AA002"),
                ("General", "AA004"),
                ("General", "AA003"),
                ("Production A", "AA006"),
                ("Production A", "AA005"),
            ],
        )
        by = self.keyed(body, "employeeCode")
        a = by[("AA001",)]
        self.assertEqual(
            (
                a["shiftType"],
                a["startTime"],
                a["endTime"],
                a["graceMinutes"],
                a["customTimes"],
                a["saturdayOff"],
                a["effectiveFrom"],
                a["effectiveTo"],
                a["assignedBy"],
                a["warning"],
                a["department"],
                a["designation"],
            ),
            ("Staff", "09:00", "18:00", 15, None, "No", "2026-01-01", None, "HR Test", None, "CUTTING", "Operator"),
        )
        self.assertEqual(by[("AA003",)]["saturdayOff"], "Yes")
        p = by[("AA005",)]
        self.assertEqual(
            (p["shiftType"], p["startTime"], p["endTime"], p["graceMinutes"]), ("Production", "08:30", "20:00", 10)
        )
        self.assertEqual(self.card(body, "Assignments"), 6)
        self.assertEqual(self.card(body, "Employees"), 6)
        self.assertEqual(self.card(body, "Saturday off"), 1)
        self.assertEqual(self.card(body, "Overnight shifts"), 0)
        self.assertEqual(self.card(body, "Overlapping assignments"), 0)
        self.assertIn("Employees per shift: General 4, Production A 2.", self.note_text(body))

    def test_filters(self):
        def codes(user=None, **kw):
            return [r["employeeCode"] for r in self.data(self.run_report("shift-roster", user, **{**self.P, **kw}))]

        self.assertEqual(codes(shiftType="production"), ["AA006", "AA005"])
        self.assertEqual(codes(saturdayOff="yes"), ["AA003"])
        self.assertEqual(len(codes(saturdayOff="no")), 5)
        self.assertEqual(codes(shift="prod"), ["AA006", "AA005"])
        self.assertEqual(len(codes(employeeStatus="all")), 7)  # AA008 is inactive
        self.assertIn("AA008", codes(employeeStatus="inactive"))
        self.assertEqual(codes(departmentIds=str(self.sew.id)), ["AA003", "AA005"])
        self.assertEqual(codes(employeeIds=str(self.e2.id)), ["AA002"])
        self.assertEqual(codes(departmentIds=str(self.empty_dept.id)), [])
        self.assertEqual(codes(self.b1_user), ["AA001", "AA002", "AA003", "AA005"])
        self.assertEqual(codes(self.b1_user, branchIds=str(self.b2.id)), [])

    def test_custom_timings_override_the_template(self):
        EmployeeShiftAssignment.objects.filter(employee=self.e2).update(
            custom_start_time=t(8), custom_end_time=t(16, 30)
        )
        body = self.run_report("shift-roster", **self.P, employeeIds=str(self.e2.id))
        (r,) = self.data(body)
        self.assertEqual((r["startTime"], r["endTime"], r["customTimes"]), ("08:00", "16:30", "08:00 to 16:30"))

    def test_date_window_uses_assignment_overlap(self):
        EmployeeShiftAssignment.objects.filter(employee=self.e2).update(effective_to=date(2026, 3, 5))
        self.assertNotIn("AA002", [r["employeeCode"] for r in self.data(self.run_report("shift-roster", **self.P))])
        rows = self.data(
            self.run_report("shift-roster", dateFrom="2026-03-01", dateTo="2026-03-09", employeeIds=str(self.e2.id))
        )
        self.assertEqual([(r["effectiveFrom"], r["effectiveTo"]) for r in rows], [("2026-01-01", "2026-03-05")])


class ShiftGapTests(_Base):
    P = {"dateFrom": "2026-03-09", "dateTo": "2026-03-13"}

    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        night = ShiftTemplate.objects.create(
            name="Night", shift_type="staff", start_time=t(20), end_time=t(6), grace_period_minutes=10
        )
        old = ShiftTemplate.objects.create(
            name="Old Shift", shift_type="staff", start_time=t(9), end_time=t(18), is_active=False
        )
        other = ShiftTemplate.objects.create(
            name="Unit2 Shift", shift_type="staff", start_time=t(9), end_time=t(18), branch=cls.b2
        )

        def mk(code, etype="staff", **kw):
            kw.setdefault("join_date", "2025-01-01")
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="G",
                department=cls.cut,
                branch=cls.b1,
                employment_type=etype,
                **kw,
            )

        def assign(emp, shift, frm=date(2026, 1, 1)):
            EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=frm)

        mk("GP001")  # never assigned
        assign(mk("GP002"), night)
        x3 = mk("GP003")
        assign(x3, cls.gen)
        assign(x3, cls.gen, date(2026, 3, 11))
        assign(mk("GP004"), old)
        assign(mk("GP005"), other)
        assign(mk("GP006", "production"), cls.gen)  # a production employee on a staff shift
        assign(mk("GP007"), cls.gen, date(2026, 3, 11))  # starts part-way through the period
        mk("GP008", join_date="2026-03-11")  # joined part-way: earlier days are not gaps

    def test_golden_rows(self):
        body = self.run_report("shift-assignment-gaps", **self.P)
        self.assertEqual(
            [(r["employeeCode"], r["issue"]) for r in self.data(body)],
            [
                ("AA007", "No shift assigned"),
                ("GP001", "No shift assigned"),
                ("GP002", "Overnight shift"),
                ("GP003", "Overlapping assignments"),
                ("GP004", "Inactive shift template"),
                ("GP005", "Shift of another branch"),
                ("GP006", "Shift type differs from employee type"),
                ("GP007", "No shift assigned"),
                ("GP008", "No shift assigned"),
            ],
        )
        by = self.keyed(body, "employeeCode")
        self.assertEqual(by[("AA007",)]["detail"], "No shift on 5 of 5 day(s), first on 09-Mar-2026.")
        self.assertEqual(by[("AA007",)]["currentShift"], "No shift assigned")
        self.assertEqual(by[("GP007",)]["detail"], "No shift on 2 of 5 day(s), first on 09-Mar-2026.")
        self.assertEqual(by[("GP007",)]["currentShift"], "General")
        self.assertEqual(by[("GP008",)]["detail"], "No shift on 3 of 3 day(s), first on 11-Mar-2026.")
        self.assertIn("Night runs 20:00-06:00", by[("GP002",)]["detail"])
        self.assertIn("'General' from 01-Jan-2026 overlaps 'General' from 11-Mar-2026", by[("GP003",)]["detail"])
        self.assertIn("'Old Shift'", by[("GP004",)]["detail"])
        self.assertIn("'Unit2 Shift' belongs to a different branch", by[("GP005",)]["detail"])
        self.assertIn("is a staff shift but the employee is production", by[("GP006",)]["detail"])
        self.assertEqual(by[("GP006",)]["employmentType"], "Production")
        self.assertEqual(self.card(body, "Employees with an issue"), 9)
        self.assertEqual(self.card(body, "No shift"), 4)
        self.assertEqual(self.card(body, "Overnight"), 1)
        self.assertEqual(self.card(body, "Overlapping"), 1)

    def test_issue_filter_and_scoping(self):
        def codes(user=None, **kw):
            return [
                r["employeeCode"] for r in self.data(self.run_report("shift-assignment-gaps", user, **{**self.P, **kw}))
            ]

        self.assertEqual(codes(issue="no_shift"), ["AA007", "GP001", "GP007", "GP008"])
        self.assertEqual(codes(issue="overnight"), ["GP002"])
        self.assertEqual(codes(issue="overlap"), ["GP003"])
        self.assertEqual(codes(issue="inactive_shift"), ["GP004"])
        self.assertEqual(codes(issue="branch_mismatch"), ["GP005"])
        self.assertEqual(codes(issue="type_mismatch"), ["GP006"])
        self.assertEqual(codes(departmentIds=str(self.sew.id)), [])
        self.assertEqual(codes(employmentType="production"), ["GP006"])
        self.assertEqual(codes(self.b1_user, issue="no_shift", branchIds=str(self.b2.id)), [])

    def test_roster_warnings_for_the_same_data(self):
        body = self.run_report("shift-roster", **self.P, employeeStatus="all")
        by = {(r["employeeCode"], r["shiftName"], r["effectiveFrom"]): r["warning"] for r in self.data(body)}
        self.assertIn("Overnight", by[("GP002", "Night", "2026-01-01")])
        self.assertEqual(by[("GP003", "General", "2026-01-01")], "Overlaps another assignment")
        self.assertEqual(by[("GP003", "General", "2026-03-11")], "Overlaps another assignment")
        self.assertEqual(by[("GP004", "Old Shift", "2026-01-01")], "Shift template is inactive")
        self.assertEqual(by[("GP005", "Unit2 Shift", "2026-01-01")], "Shift belongs to another branch")
        self.assertEqual(by[("GP006", "General", "2026-01-01")], "Staff shift for a production employee")
        self.assertEqual(self.card(body, "Overnight shifts"), 1)
        self.assertEqual(self.card(body, "Overlapping assignments"), 2)


class ShiftWiseTests(_Base):
    def test_golden_day(self):
        body = self.run_report("shift-wise-attendance", dateFrom="2026-03-09", dateTo="2026-03-09")
        by = {r["shiftName"]: r for r in self.data(body)}
        self.assertEqual(list(by), ["General", "Production A", "Unassigned"])
        keys = ("headcount", "present", "halfDay", "absent", "onLeave", "late", "strengthPct", "shiftCredit")
        self.assertEqual(tuple(by["General"][k] for k in keys), (4, 1, 1, 2, 0, 1, 50.0, 1.5))
        self.assertEqual(tuple(by["Production A"][k] for k in keys), (2, 0, 0, 2, 0, 0, 0.0, 0.0))
        self.assertEqual(tuple(by["Unassigned"][k] for k in keys), (1, 0, 0, 1, 0, 0, 0.0, 0.0))
        self.assertEqual(body["totals"]["headcount"], 7)  # AA008 left on the 6th
        self.assertEqual(body["totals"]["strengthPct"], 28.6)
        subs = {s["shiftName"]: s for s in self.subtotals(body)}
        self.assertEqual((subs["General total"]["headcount"], subs["General total"]["strengthPct"]), (4, 50.0))
        self.assertEqual(self.card(body, "Present man-days"), 2)
        self.assertEqual(self.card(body, "Absent man-days"), 5)
        self.assertEqual(self.card(body, "Strength %"), 28.6)
        self.assertEqual(self.card(body, "Late %"), 50.0)

    def test_weekly_off_is_not_headcount(self):
        body = self.run_report("shift-wise-attendance", dateFrom="2026-03-08", dateTo="2026-03-08")
        by = {r["shiftName"]: r for r in self.data(body)}
        self.assertEqual(list(by), ["General", "Production A"])  # AA007's Sunday is a weekly off: no Unassigned row
        self.assertEqual(
            (by["General"]["headcount"], by["General"]["present"], by["General"]["late"], by["General"]["strengthPct"]),
            (1, 1, 1, 100.0),
        )
        self.assertEqual(
            (
                by["Production A"]["headcount"],
                by["Production A"]["present"],
                by["Production A"]["absent"],
                by["Production A"]["shiftCredit"],
            ),
            (2, 1, 1, 1.5),
        )

    def test_assignment_change_moves_people_between_shifts_by_day(self):
        EmployeeShiftAssignment.objects.create(employee=self.e2, shift=self.prod_shift, effective_from=d(10))
        body = self.run_report("shift-wise-attendance", dateFrom="2026-03-09", dateTo="2026-03-10")
        by = self.keyed(body, "shiftName", "date")
        self.assertEqual(by[("General", iso(9))]["headcount"], 4)
        self.assertEqual(by[("General", iso(10))]["headcount"], 3)
        self.assertEqual(by[("Production A", iso(10))]["headcount"], 3)

    def test_filters_and_scoping(self):
        body = self.run_report("shift-wise-attendance", dateFrom="2026-03-09", dateTo="2026-03-09", shift="prod")
        self.assertEqual([r["shiftName"] for r in self.data(body)], ["Production A"])
        body = self.run_report(
            "shift-wise-attendance", dateFrom="2026-03-09", dateTo="2026-03-09", departmentIds=str(self.sew.id)
        )
        self.assertEqual({r["shiftName"]: r["headcount"] for r in self.data(body)}, {"General": 1, "Production A": 1})
        scoped = self.run_report("shift-wise-attendance", self.b1_user, dateFrom="2026-03-09", dateTo="2026-03-09")
        self.assertEqual(scoped["totals"]["headcount"], 5)  # AA004 and AA006 (Unit 2) are not visible
        scoped = self.run_report(
            "shift-wise-attendance", self.b1_user, dateFrom="2026-03-09", dateTo="2026-03-09", branchIds=str(self.b2.id)
        )
        self.assertEqual(self.data(scoped), [])


class ProductionRegisterTests(_Base):
    P = {"dateFrom": "2026-03-02", "dateTo": "2026-03-08"}

    def test_golden_rows_columns_and_totals(self):
        body = self.run_report("production-shift-register", **self.P)
        keys = [c["key"] for c in body["columns"]]
        self.assertEqual(keys[3], "day_2026-03-02")
        self.assertEqual(keys[9], "day_2026-03-08")
        self.assertEqual([c["label"] for c in body["columns"]][3:10], ["02", "03", "04", "05", "06", "07", "08"])
        by = self.keyed(body, "employeeCode")
        self.assertEqual(sorted(by), [("AA005",), ("AA006",)])  # production only; register order: PACKING before SEWING
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA006", "AA005"])
        a = by[("AA005",)]
        days = [a[f"day_2026-03-0{i}"] for i in range(2, 9)]
        self.assertEqual(days, [1.5, 1.0, 0.5, 1.25, 0.0, 0.0, 1.5])  # absent = 0
        self.assertEqual(
            (
                a["daysWorked"],
                a["totalShifts"],
                a["extraShifts"],
                a["lateDays"],
                a["salaryPerShift"],
                a["estimatedGross"],
            ),
            (5, 5.75, 1.25, 1, 400.0, 2300.0),
        )
        f = by[("AA006",)]
        self.assertEqual(
            (
                f["day_2026-03-02"],
                f["day_2026-03-08"],
                f["daysWorked"],
                f["totalShifts"],
                f["extraShifts"],
                f["estimatedGross"],
            ),
            (1.5, 0.0, 1, 1.5, 0.5, 525.0),
        )
        self.assertEqual(body["totals"]["day_2026-03-02"], 3.0)
        self.assertEqual(body["totals"]["totalShifts"], 7.25)
        self.assertEqual(body["totals"]["estimatedGross"], 2825.0)
        self.assertEqual(self.card(body, "Employees"), 2)
        self.assertEqual(self.card(body, "Total shifts"), 7.25)
        self.assertEqual(self.card(body, "Extra shifts (over 1.00)"), 1.75)
        self.assertEqual(self.card(body, "Late days"), 1)
        self.assertEqual(self.card(body, "Gross (shifts x rate)"), 2825.0)
        subs = {s["employeeName"]: s for s in self.subtotals(body)}
        self.assertEqual(subs["SEWING total"]["estimatedGross"], 2300.0)

    def test_holiday_is_a_dash_not_zero(self):
        body = self.run_report("production-shift-register", dateFrom="2026-03-18", dateTo="2026-03-20")
        by = self.keyed(body, "employeeCode")
        self.assertEqual((by[("AA005",)]["day_2026-03-18"], by[("AA005",)]["day_2026-03-19"]), (0.0, 1.5))
        self.assertEqual(
            (by[("AA006",)]["day_2026-03-18"], by[("AA006",)]["day_2026-03-19"]), (0.0, None)
        )  # holiday, no punch

    def test_filters_scoping_and_access(self):
        body = self.run_report("production-shift-register", **self.P, employeeIds=str(self.e6.id))
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA006"])
        body = self.run_report("production-shift-register", self.b1_user, **self.P)
        self.assertEqual([r["employeeCode"] for r in self.data(body)], ["AA005"])
        body = self.run_report("production-shift-register", self.b1_user, **self.P, branchIds=str(self.b2.id))
        self.assertEqual(self.data(body), [])
        body = self.run_report("production-shift-register", **self.P, departmentIds=str(self.empty_dept.id))
        self.assertEqual(self.data(body), [])
        r = self.call("/api/reports/run/production-shift-register", self.att_user, **self.P)
        self.assertEqual(
            (r.status_code, r.json()["error"]), (403, "report_forbidden")
        )  # money columns need a payroll module

    def test_a_missing_rate_leaves_the_amount_blank(self):
        Employee.objects.filter(pk=self.e5.pk).update(salary_per_shift=None)
        body = self.run_report("production-shift-register", **self.P, employeeIds=str(self.e5.id))
        (a,) = self.data(body)
        self.assertEqual((a["totalShifts"], a["salaryPerShift"], a["estimatedGross"]), (5.75, None, None))


# ═════════════════════════════════════════════════════════════════════════════
#  device sync health
# ═════════════════════════════════════════════════════════════════════════════


class DeviceHealthTests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        now = timezone.now()
        cls.dev_a = BiometricDevice.objects.create(
            name="Gate A", host="10.0.0.1", serial_number="SN-A", last_push_at=now - timedelta(hours=1)
        )
        cls.dev_b = BiometricDevice.objects.create(
            name="Gate B",
            host="10.0.0.2",
            serial_number="SN-B",
            last_push_at=now - timedelta(hours=10),
            last_synced_at=datetime(2026, 3, 20, 3, 30, tzinfo=dt_timezone.utc),
        )
        cls.dev_c = BiometricDevice.objects.create(name="Gate C", host="10.0.0.3")
        cls.dev_d = BiometricDevice.objects.create(name="Gate D", host="10.0.0.4", is_active=False)

        def logs(emp, day, source, times):
            for tm in times:
                AttendanceLog.objects.create(employee=emp, date=d(day), punch_time=tm, punch_type="IN", source=source)

        logs(cls.e1, 20, "biometric:adms:SN-A", [t(9), t(9, 10), t(9, 20)])
        logs(cls.e2, 20, "biometric:Gate B", [t(9), t(18)])
        logs(cls.e4, 24, "biometric:adms:SN-A", [t(8, i) for i in range(6)])  # six punches in a day: a shared device id
        AutoSyncRule.objects.create(
            name="daily",
            time=t(8),
            device_selection=[],
            is_enabled=True,
            last_run_status="success",
            last_run_summary="Synced 42 punches",
            last_run_at=datetime(2026, 3, 20, 2, 30, tzinfo=dt_timezone.utc),
        )
        AutoSyncRule.objects.create(
            name="gate b only",
            time=t(10),
            device_selection=[cls.dev_b.id],
            is_enabled=True,
            last_run_status="failed",
            last_run_summary="timeout",
            last_run_at=datetime(2026, 3, 21, 4, 30, tzinfo=dt_timezone.utc),
        )
        AutoSyncRule.objects.create(
            name="off",
            time=t(11),
            device_selection=[],
            is_enabled=False,
            last_run_status="success",
            last_run_summary="never counted",
            last_run_at=datetime(2026, 3, 25, 4, 30, tzinfo=dt_timezone.utc),
        )
        UnmatchedPunch.objects.create(device_user_id="901", device_serial="SN-A", punch_count=4)
        UnmatchedPunch.objects.create(device_user_id="902", device_serial="SN-A", punch_count=1, resolved=True)

    def test_golden_rows(self):
        body = self.run_report("device-sync-health", **MONTH_RANGE)
        by = {r["deviceName"]: r for r in self.data(body)}
        self.assertEqual(list(by), ["Gate A", "Gate B", "Gate C", "Gate D"])
        a = by["Gate A"]
        self.assertEqual(
            (
                a["host"],
                a["serialNumber"],
                a["status"],
                a["punchesInPeriod"],
                a["lastRuleRun"],
                a["lastRuleStatus"],
                a["lastRuleSummary"],
            ),
            (
                "10.0.0.1",
                "SN-A",
                "Live",
                9,
                "2026-03-20 08:00",
                "Success",
                "Synced 42 punches",
            ),  # 02:30 UTC is 08:00 IST
        )
        b = by["Gate B"]
        self.assertEqual(
            (
                b["status"],
                b["punchesInPeriod"],
                b["lastSyncedAt"],
                b["lastRuleRun"],
                b["lastRuleStatus"],
                b["lastRuleSummary"],
            ),
            ("Silent", 2, "2026-03-20 09:00", "2026-03-21 10:00", "Failed", "timeout"),
        )
        c = by["Gate C"]
        self.assertEqual(
            (c["status"], c["punchesInPeriod"], c["lastPushAt"], c["serialNumber"], c["lastRuleRun"]),
            ("No push yet", 0, None, None, "2026-03-20 08:00"),
        )
        dd = by["Gate D"]
        self.assertEqual(
            (dd["status"], dd["lastRuleRun"]), ("Disabled", None)
        )  # an "all enabled devices" rule does not cover it
        self.assertEqual(body["totals"]["punchesInPeriod"], 11)
        self.assertEqual(self.card(body, "Devices"), 4)
        self.assertEqual(self.card(body, "Live"), 1)
        self.assertEqual(self.card(body, "Silent or never synced"), 2)
        self.assertEqual(self.card(body, "Unresolved unmatched IDs"), 1)
        self.assertEqual(self.card(body, "Employee-days with 6+ punches"), 1)
        self.assertIn("6 hours", self.note_text(body))
        self.assertIn(
            "pulled on a schedule", self.note_text(body)
        )  # a pull-only device is "No push yet", not "never synced"

    def test_filters(self):
        def names(**kw):
            return [r["deviceName"] for r in self.data(self.run_report("device-sync-health", **{**MONTH_RANGE, **kw}))]

        self.assertEqual(names(deviceStatus="live"), ["Gate A"])
        self.assertEqual(names(deviceStatus="silent"), ["Gate B"])
        self.assertEqual(names(deviceStatus="never"), ["Gate C"])
        self.assertEqual(names(deviceStatus="disabled"), ["Gate D"])
        body = self.run_report("device-sync-health", dateFrom="2026-03-21", dateTo="2026-03-31")
        by = {r["deviceName"]: r["punchesInPeriod"] for r in self.data(body)}
        self.assertEqual((by["Gate A"], by["Gate B"]), (6, 0))

    def test_devices_are_company_wide_so_branch_users_see_none(self):
        body = self.run_report("device-sync-health", self.b1_user, **MONTH_RANGE)
        self.assertEqual(body["rows"], [])
        self.assertIn("company-wide", self.note_text(body))

    def test_query_count_does_not_grow_with_devices(self):
        def queries():
            with CaptureQueriesContext(connection) as q:
                self.run_report("device-sync-health", **MONTH_RANGE)
            return len(q)

        few = queries()
        for i in range(10):
            BiometricDevice.objects.create(
                name=f"Extra {i}", host=f"10.1.0.{i}", serial_number=f"SN-X{i}", last_push_at=timezone.now()
            )
        self.assertLessEqual(abs(queries() - few), 1)


# ═════════════════════════════════════════════════════════════════════════════
#  perfect attendance + Form 12 register
# ═════════════════════════════════════════════════════════════════════════════

WORKING_MARCH = [
    2,
    3,
    4,
    5,
    6,
    7,
    9,
    10,
    11,
    12,
    13,
    14,
    16,
    17,
    18,
    20,
    21,
    23,
    24,
    25,
    26,
    27,
    28,
    30,
    31,
]  # Sundays and the 19th excluded


class PerfectAndForm12Tests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.build_world()

        def mk(code, **kw):
            kw.setdefault("join_date", "2025-01-01")
            kw.setdefault("father_name", "Father")
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="P",
                department=cls.sew,
                branch=cls.b1,
                employment_type="staff",
                salary_amount=Decimal("20000"),
                **kw,
            )

        def present(emp, days, first=t(9), last=t(18), special=None):
            for day in days:
                start = (special or {}).get(day, first)
                for tm in (start, last):
                    AttendanceLog.objects.create(
                        employee=emp, date=d(day), punch_time=tm, punch_type="IN", source="biometric:test"
                    )
            EmployeeShiftAssignment.objects.create(employee=emp, shift=cls.gen, effective_from=date(2026, 1, 1))

        cls.pa1 = mk("PA001")
        present(cls.pa1, WORKING_MARCH)
        cls.pa2 = mk("PA002")
        present(cls.pa2, WORKING_MARCH, special={3: t(9, 30), 10: t(9, 30)})  # two lates
        cls.pa3 = mk("PA003")
        present(cls.pa3, WORKING_MARCH, special={4: t(9, 40)})  # an approved permission covers the 09:40 arrival
        EmployeePermission.objects.create(employee=cls.pa3, date=d(4), type="morning_late_in", status="approved")
        cls.pa4 = mk("PA004", join_date="2026-03-10")
        present(cls.pa4, [x for x in WORKING_MARCH if x >= 10])
        cls.pa5 = mk("PA005", date_of_birth=date(2010, 6, 1), father_name=None)
        settings = PayrollSettings.get()
        for emp in (cls.pa1, cls.pa2, cls.pa3, cls.pa4):
            compute_range_records(emp, MAR, date(2026, 3, 31), settings)
        compute_range_records(cls.pa5, MAR, date(2026, 3, 31), settings)

    # ── perfect attendance ──
    def perfect(self, user=None, **kw):
        return self.run_report("perfect-attendance", user, period=MONTH, **kw)

    def test_golden_rows(self):
        body = self.perfect()
        by = self.keyed(body, "employeeCode")
        self.assertEqual(
            sorted(c for (c,) in by),
            ["AA001", "AA002", "AA003", "AA004", "AA007", "PA001", "PA002", "PA003", "PA004", "PA005"],
        )
        a = by[("PA001",)]
        self.assertEqual(
            (a["workingDays"], a["presentDays"], a["absentDays"], a["lateCount"], a["eligible"], a["reasonNot"]),
            (25, 25, 0, 0, "Eligible", None),
        )
        e1 = by[("AA001",)]
        self.assertEqual(
            (e1["presentDays"], e1["halfDays"], e1["absentDays"], e1["lateCount"], e1["eligible"]),
            (9, 3, 13, 4, "Not eligible"),
        )
        self.assertEqual(e1["reasonNot"], "13 absent; 3 half day; 4 late/early-out (allowed 0)")
        e2 = by[("AA002",)]
        self.assertEqual((e2["halfDays"], e2["absentDays"], e2["lateCount"], e2["permissions"]), (1, 18, 2, 4))
        self.assertEqual(e2["reasonNot"], "18 absent; 1 half day; 2 late/early-out (allowed 0)")
        self.assertEqual(by[("PA002",)]["reasonNot"], "2 late/early-out (allowed 0)")
        self.assertEqual(by[("PA003",)]["eligible"], "Eligible")  # the permission covered the arrival: not late
        self.assertEqual(by[("PA003",)]["permissions"], 1)
        p4 = by[("PA004",)]
        self.assertEqual(
            (p4["presentDays"], p4["absentDays"], p4["eligible"], p4["reasonNot"]),
            (18, 0, "Not eligible", "joined 10-Mar-2026 (mid-month)"),
        )
        self.assertEqual(by[("PA005",)]["eligible"], "Not eligible")  # never came: every working day absent
        self.assertNotIn(("AA008",), by)  # inactive employees are not in the default (active) roster
        self.assertEqual(self.card(body, "Employees checked"), 10)
        self.assertEqual(self.card(body, "Eligible"), 2)
        self.assertEqual(self.card(body, "Not eligible"), 8)
        self.assertEqual(self.card(body, "Eligible %"), 20.0)

    def test_options(self):
        by = self.keyed(self.perfect(allowLate="2"), "employeeCode")
        self.assertEqual(by[("PA002",)]["eligible"], "Eligible")
        by = self.keyed(self.perfect(allowLate="1"), "employeeCode")
        self.assertEqual(by[("PA002",)]["reasonNot"], "2 late/early-out (allowed 1)")
        by = self.keyed(self.perfect(allowPermission="false"), "employeeCode")
        self.assertEqual((by[("PA003",)]["eligible"], by[("PA003",)]["reasonNot"]), ("Not eligible", "1 permission(s)"))
        self.assertEqual([r["employeeCode"] for r in self.data(self.perfect(employeeStatus="inactive"))], ["AA008"])

    def test_a_running_month_is_only_on_track(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=d(20)):
            body = self.perfect()
        by = self.keyed(body, "employeeCode")
        self.assertEqual(by[("PA001",)]["eligible"], "On track")
        self.assertEqual(by[("AA001",)]["eligible"], "Not eligible")
        self.assertIn("still running", self.note_text(body))
        self.assertEqual(self.card(body, "On track"), 2)

    def test_filters_and_scoping(self):
        self.assertEqual([r["employeeCode"] for r in self.data(self.perfect(employeeIds=str(self.pa1.id)))], ["PA001"])
        self.assertEqual(self.data(self.perfect(departmentIds=str(self.empty_dept.id))), [])
        scoped = self.perfect(self.b1_user)
        self.assertNotIn("AA004", {r["employeeCode"] for r in self.data(scoped)})
        self.assertEqual(self.data(self.perfect(self.b1_user, branchIds=str(self.b2.id))), [])

    def test_missing_records_are_not_eligible(self):
        AttendanceDayRecord.objects.filter(employee=self.pa1, date__in=[d(2), d(3)]).delete()
        by = self.keyed(self.perfect(), "employeeCode")
        self.assertEqual(by[("PA001",)]["reasonNot"], "2 day(s) not computed yet")

    # ── Form 12 ──
    def form12(self, user=None, **kw):
        return self.run_report("form12-adult-workers-register", user, period=MONTH, **kw)

    def test_form12_golden(self):
        body = self.form12()
        by = self.keyed(body, "employeeCode")
        a = by[("AA001",)]
        self.assertEqual(
            (
                a["employeeName"],
                a["fatherName"],
                a["gender"],
                a["dob"],
                a["designation"],
                a["joinDate"],
                a["shift"],
                a["weeklyOffDay"],
                a["daysWorked"],
                a["totalHours"],
                a["otHours"],
                a["remarks"],
            ),
            (
                "Asha T",
                "Father Asha",
                "Male",
                "1990-05-05",
                "Operator",
                "2025-01-01",
                "General (09:00-18:00)",
                "Sunday",
                14,
                98.23,
                1.58,
                None,
            ),
        )
        c = by[("AA003",)]  # Saturday off; the manual half day has no punches (no hours), 8 x 5 + 7
        self.assertEqual(
            (c["weeklyOffDay"], c["daysWorked"], c["totalHours"], c["otHours"]), ("Sunday + Saturday", 7, 47.0, None)
        )
        self.assertEqual(c["remarks"], "father's name not recorded; date of birth not recorded")
        p = by[("AA005",)]
        self.assertEqual(
            (p["shift"], p["weeklyOffDay"], p["daysWorked"], p["totalHours"]),
            ("Production A (08:30-20:00)", None, 6, 58.75),
        )
        self.assertEqual(by[("PA004",)]["remarks"], "date of birth not recorded; joined this month")
        self.assertEqual(
            by[("PA005",)]["remarks"], "father's name not recorded; under 18: check adult-worker eligibility"
        )
        self.assertEqual((by[("PA005",)]["daysWorked"], by[("PA005",)]["totalHours"]), (0, None))
        snos = [r["sno"] for r in self.data(body)]
        self.assertEqual(snos, list(range(1, len(snos) + 1)))
        self.assertEqual(body["totals"]["daysWorked"], sum(r["daysWorked"] for r in self.data(body)))
        self.assertEqual(self.card(body, "Workers"), len(snos))
        self.assertAlmostEqual(
            self.card(body, "Overtime hours"), 1.58, places=2
        )  # the rejected 40 minutes are excluded

    def test_form12_scoping_and_filters(self):
        codes = lambda body: [r["employeeCode"] for r in self.data(body)]  # noqa: E731
        self.assertEqual(codes(self.form12(employeeIds=str(self.e1.id))), ["AA001"])
        self.assertEqual(codes(self.form12(employmentType="production")), ["AA006", "AA005"])
        scoped = self.form12(self.b1_user)
        self.assertNotIn("AA004", codes(scoped))
        self.assertNotIn("AA006", codes(scoped))
        self.assertEqual(codes(self.form12(self.b1_user, branchIds=str(self.b2.id))), [])
        self.assertIn("AA008", codes(self.form12(employeeStatus="all")))


# ═════════════════════════════════════════════════════════════════════════════
#  edge cases: unassigned department / branch, garbage dates
# ═════════════════════════════════════════════════════════════════════════════


class EdgeCaseTests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        cls.ghost = Employee.objects.create(
            employee_code="ED001",
            first_name="Ghost",
            last_name="G",
            employment_type="staff",
            salary_amount=Decimal("10000"),
            join_date="not a date",
            status="active",  # no department, designation or branch
        )
        EmployeeShiftAssignment.objects.create(employee=cls.ghost, shift=cls.gen, effective_from=date(2026, 1, 1))
        for tm in (t(9, 50), t(18)):
            AttendanceLog.objects.create(
                employee=cls.ghost, date=d(2), punch_time=tm, punch_type="IN", source="biometric:test"
            )
        compute_range_records(cls.ghost, MAR, date(2026, 3, 31), PayrollSettings.get())

    def test_every_report_copes_with_unassigned_people_and_garbage_dates(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                self.run_report(rid, **PARAMS[rid])
                if rid in (
                    "perfect-attendance",
                    "shift-roster",
                    "shift-assignment-gaps",
                    "form12-adult-workers-register",
                ):
                    self.run_report(rid, **PARAMS[rid], employeeStatus="all")

    def test_unassigned_department_is_labelled_and_listed_last(self):
        body = self.run_report("late-coming-detail", **WEEK2, employmentType="staff")
        rows = self.data(body)
        self.assertEqual(rows[-1]["employeeCode"], "ED001")
        self.assertEqual((rows[-1]["department"], rows[-1]["lateMinutes"]), ("Unassigned", 50))
        self.assertEqual(self.subtotals(body)[-1]["employeeName"], "Unassigned total")
        body = self.run_report("late-summary-counts", period=MONTH, employmentType="staff")
        self.assertEqual(self.data(body)[-1]["employeeCode"], "ED001")
        body = self.run_report("department-strength", dateFrom="2026-03-09", dateTo="2026-03-09")
        rows = self.data(body)
        self.assertEqual(rows[-1]["department"], "Unassigned")
        self.assertEqual(
            (rows[-1]["onRoll"], rows[-1]["absent"]), (1, 1)
        )  # an unparseable joining date is treated as "already joined"

    def test_branchless_people_are_invisible_to_branch_users(self):
        for rid in (
            "late-coming-detail",
            "absenteeism",
            "shift-roster",
            "form12-adult-workers-register",
            "perfect-attendance",
        ):
            body = self.run_report(rid, self.b1_user, **PARAMS[rid])
            self.assertNotIn("ED001", {r.get("employeeCode") for r in self.data(body)}, rid)
        body = self.run_report("department-strength", self.b1_user, dateFrom="2026-03-09", dateTo="2026-03-09")
        self.assertNotIn("Unassigned", [r["department"] for r in self.data(body)])

    def test_shift_gap_ignores_days_before_an_unparseable_join_date_gracefully(self):
        EmployeeShiftAssignment.objects.filter(employee=self.ghost).delete()
        body = self.run_report("shift-assignment-gaps", dateFrom="2026-03-09", dateTo="2026-03-10")
        by = self.keyed(body, "employeeCode")
        self.assertEqual(by[("ED001",)]["detail"], "No shift on 2 of 2 day(s), first on 09-Mar-2026.")
        self.assertEqual(by[("ED001",)]["department"], "Unassigned")


# ═════════════════════════════════════════════════════════════════════════════
#  every report: exports, empty results, access, isolation, sums, no writes, no N+1
# ═════════════════════════════════════════════════════════════════════════════


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


class ContractTests(_Base):
    def export(self, rid, fmt, user=None, **extra):
        return self.call(f"/api/reports/export/{rid}", user, fmt=fmt, **{**PARAMS[rid], **extra})

    def test_xlsx_round_trip_and_pdf_signature(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                body = self.run_report(rid, **PARAMS[rid])
                r = self.export(rid, "xlsx")
                self.assertEqual(r.status_code, 200, r.content[:300])
                self.assertEqual(r.content[:2], b"PK")
                ws = load_workbook(io.BytesIO(r.content)).active
                header = [c.value for c in ws[7]]
                self.assertEqual(header[: len(body["columns"])], [c["label"] for c in body["columns"]])
                first = self.data(body)[:1]
                if first and "employeeCode" in first[0]:
                    col = [c["key"] for c in body["columns"]].index("employeeCode") + 1
                    self.assertEqual(ws.cell(row=8, column=col).value, first[0]["employeeCode"])
                elif first:
                    self.assertIsNotNone(ws.cell(row=8, column=1).value)
                p = self.export(rid, "pdf")
                self.assertEqual(p.status_code, 200, p.content[:300])
                self.assertEqual(p.content[:4], b"%PDF")

    def test_empty_results_render_on_screen_and_in_both_exports(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                empty = (
                    {"deviceStatus": "live"}
                    if rid == "device-sync-health"
                    else {"departmentIds": str(self.empty_dept.id)}
                )
                body = self.run_report(rid, **PARAMS[rid], **empty)
                self.assertEqual(body["rows"], [], rid)
                for fmt in ("xlsx", "pdf"):
                    r = self.export(rid, fmt, **empty)
                    self.assertEqual(r.status_code, 200, (rid, fmt, r.content[:300]))

    def test_defaults_work_without_any_parameter(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                self.run_report(rid)

    def test_bad_filters_are_400(self):
        cases = [
            ("late-coming-detail", {"dateFrom": "2026-03-10", "dateTo": "2026-03-01"}),
            ("late-coming-detail", {**MONTH_RANGE, "minLate": "7"}),
            ("late-summary-counts", {"period": "2026-13"}),
            ("half-day", {**MONTH_RANGE, "view": "zzz"}),
            ("absenteeism", {**WEEK2, "employmentType": "contractor"}),
            ("worked-hours-shortfall", {"dateFrom": "2026-01-01", "dateTo": "2026-03-31"}),  # wider than 31 days
            ("shift-assignment-gaps", {**PARAMS["shift-assignment-gaps"], "issue": "nope"}),
        ]
        for rid, params in cases:
            with self.subTest(rid, params=params):
                self.assertEqual(self.call(f"/api/reports/run/{rid}", **params).status_code, 400)

    def test_access_follows_the_owning_modules(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                for kind in ("run", "export"):
                    extra = {"fmt": "xlsx"} if kind == "export" else {}
                    r = self.call(f"/api/reports/{kind}/{rid}", self.plain_user, **PARAMS[rid], **extra)
                    self.assertEqual(r.status_code, 403)
                    self.assertEqual(r.json()["error"], "report_forbidden")
                want = 403 if rid in NOT_FOR_ATTENDANCE_ONLY else 200
                self.assertEqual(self.call(f"/api/reports/run/{rid}", self.att_user, **PARAMS[rid]).status_code, want)
                self.assertEqual(self.call(f"/api/reports/run/{rid}", self.b1_user, **PARAMS[rid]).status_code, 200)
        ids = {x["id"] for x in self.call("/api/reports/catalog", self.plain_user).json()["reports"]}
        self.assertFalse(ids & set(REPORT_IDS))
        ids = {x["id"] for x in self.call("/api/reports/catalog", self.att_user).json()["reports"]}
        self.assertEqual(ids & set(REPORT_IDS), set(REPORT_IDS) - set(NOT_FOR_ATTENDANCE_ONLY))
        # the owning payroll / employee modules open them (the b1 role holds every module)
        for rid in NOT_FOR_ATTENDANCE_ONLY:
            self.assertEqual(
                self.call(f"/api/reports/export/{rid}", self.b1_user, fmt="pdf", **PARAMS[rid]).status_code, 200, rid
            )

    def test_a_branch_user_never_sees_the_other_branch(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                params = PARAMS[rid]
                for widened in ({}, {"branchIds": str(self.b2.id)}, {"employeeIds": f"{self.e4.id},{self.e6.id}"}):
                    body = self.run_report(rid, self.b1_user, **params, **widened)
                    text = str(body["rows"])
                    for needle in ("AA004", "AA006", "PACKING", "Dev T", "Farid T"):
                        self.assertNotIn(needle, text, (rid, widened))
                self.assertEqual(
                    self.data(self.run_report(rid, self.b1_user, **params, branchIds=str(self.b2.id))), [], rid
                )

    def test_totals_and_subtotals_equal_the_rows(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                body = self.run_report(rid, **PARAMS[rid])
                sums = [c["key"] for c in body["columns"] if c["total"] == "sum"]
                data = self.data(body)
                for key in sums:
                    vals = [_num(r.get(key)) for r in data if _num(r.get(key)) is not None]
                    if not vals:
                        continue
                    self.assertAlmostEqual(body["totals"][key], sum(vals), places=1, msg=(rid, key))
                group = []
                for row in body["rows"]:
                    if row.get("_kind") == "subtotal":
                        for key in sums:
                            if _num(row.get(key)) is not None:
                                self.assertAlmostEqual(
                                    row[key], sum(_num(r.get(key)) or 0 for r in group), places=1, msg=(rid, key)
                                )
                        group = []
                    else:
                        group.append(row)

    def test_a_brand_new_install_without_a_settings_row_still_works_and_nothing_is_created(self):
        PayrollSettings.objects.all().delete()
        ProductionShiftConfig.objects.all().delete()
        for rid in REPORT_IDS:
            with self.subTest(rid):
                body = self.run_report(rid, **PARAMS[rid])
                self.assertIsInstance(body["rows"], list)
                self.run_report(rid)  # and with the default filters
        half = self.run_report("half-day", **MONTH_RANGE)
        self.assertIn("60 min Late window", self.note_text(half))  # the model defaults, read without saving them
        self.assertIn("(14:30)", self.note_text(half))
        self.assertEqual(PayrollSettings.objects.count(), 0)
        self.assertEqual(ProductionShiftConfig.objects.count(), 0)

    def test_the_row_limit_is_applied_and_an_export_over_it_is_refused(self):
        with mock.patch("api.reporting.runner.SCREEN_ROW_LIMIT", 3):
            body = self.run_report("late-coming-detail", **MONTH_RANGE, employmentType="staff")
        self.assertTrue(body["truncated"])
        self.assertEqual((len(body["rows"]), body["limit"]), (3, 3))
        self.assertNotIn("_kind", str(body["rows"]))  # no department subtotals over a cut-off list
        self.assertIsNone(body["totals"])
        self.assertIn("cut off", self.note_text(body))
        with mock.patch("api.reporting.runner.XLSX_ROW_LIMIT", 3):
            r = self.export("late-coming-detail", "xlsx", **MONTH_RANGE, employmentType="staff")
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"], "too_many_rows")

    def test_a_long_production_register_exports_with_one_column_per_day(self):
        params = {"dateFrom": "2026-03-01", "dateTo": "2026-03-31"}
        body = self.run_report("production-shift-register", **params)
        self.assertEqual(len(body["columns"]), 3 + 31 + 6)
        r = self.export("production-shift-register", "xlsx", **params)
        self.assertEqual(r.status_code, 200)
        ws = load_workbook(io.BytesIO(r.content)).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[: len(body["columns"])], [c["label"] for c in body["columns"]])
        p = self.export("production-shift-register", "pdf", **params)
        self.assertEqual((p.status_code, p.content[:4]), (200, b"%PDF"))

        # A page cannot hold 31 day columns legibly: the PDF keeps the totals, the screen and Excel keep the days.
        def columns(purpose, date_to):
            request = RequestFactory().get("/")
            request.jwt_user = {"hrUserId": self.admin.id}
            out = run_report(
                request,
                registry.get_spec("production-shift-register"),
                {"dateFrom": "2026-03-01", "dateTo": date_to},
                purpose,
            )
            return out

        long_pdf = columns("pdf", "2026-03-31")
        self.assertEqual(
            [c.key for c in long_pdf.columns][:4], ["employeeCode", "employeeName", "department", "daysWorked"]
        )
        self.assertEqual(len(long_pdf.columns), 3 + 6)
        self.assertIn("left out of this PDF", " ".join(long_pdf.notes))
        self.assertEqual(len(columns("pdf", "2026-03-21").columns), 3 + 21 + 6)  # 21 days still fit
        self.assertEqual(len(columns("screen", "2026-03-31").columns), 3 + 31 + 6)
        self.assertEqual(len(columns("xlsx", "2026-03-31").columns), 3 + 31 + 6)
        # the PDF totals still add up: the gross is the same number as on screen
        self.assertEqual(long_pdf.totals["estimatedGross"], body["totals"]["estimatedGross"])
        # 45 days is the widest range offered; 46 is refused
        self.assertEqual(
            self.call(
                "/api/reports/run/production-shift-register", dateFrom="2026-02-01", dateTo="2026-03-17"
            ).status_code,
            200,
        )
        self.assertEqual(
            self.call(
                "/api/reports/run/production-shift-register", dateFrom="2026-02-01", dateTo="2026-03-18"
            ).status_code,
            400,
        )

    def test_running_the_reports_never_writes(self):
        def snapshot():
            latest = AttendanceDayRecord.objects.order_by("-updated_at").values_list("updated_at", flat=True).first()
            return (
                AttendanceDayRecord.objects.count(),
                latest,
                MonthlyShiftSummary.objects.count(),
                DailyShiftLog.objects.count(),
                OvertimeRecord.objects.count(),
                EmployeeShiftAssignment.objects.count(),
                PayrollSettings.objects.count(),
                AttendanceLog.objects.count(),
                BiometricDevice.objects.count(),
                UnmatchedPunch.objects.count(),
            )

        before = snapshot()
        for rid in REPORT_IDS:
            self.run_report(rid, **PARAMS[rid])
            self.run_report(rid)
        self.assertEqual(snapshot(), before)


class QueryCountTests(_Base):
    """The number of queries must not grow with the number of employees (no N+1)."""

    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        cls.q3 = Department.objects.create(name="Q3", branch=cls.b1)
        cls.q15 = Department.objects.create(name="Q15", branch=cls.b1)
        settings = PayrollSettings.get()

        def bulk(dept, n, tag):
            for i in range(n):
                prod = i % 3 == 2
                emp = Employee.objects.create(
                    employee_code=f"{tag}{i:02d}",
                    first_name=f"{tag}{i}",
                    last_name="Q",
                    department=dept,
                    branch=cls.b1,
                    employment_type="production" if prod else "staff",
                    join_date="2025-01-01",
                    salary_amount=None if prod else Decimal("18000"),
                    salary_per_shift=Decimal("300") if prod else None,
                    designation=cls.des if i % 2 else None,
                )
                if i % 7 != 6:  # every seventh person has no shift: a gap for the gap report
                    EmployeeShiftAssignment.objects.create(
                        employee=emp,
                        shift=cls.prod_shift if prod else cls.gen,
                        effective_from=date(2026, 1, 1),
                        saturday_off=(i % 5 == 0),
                    )
                for day in (2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13):
                    if (i + day) % 4 == 0:
                        continue  # some absences
                    first = t(9, 20) if (i + day) % 3 == 0 else t(9)
                    times = (
                        (t(8, 30), t(12, 45), t(13, 30), t(20))
                        if prod
                        else (first, t(13), t(14), t(17, 30) if i % 2 else t(18))
                    )
                    if day == 12 and i % 4 == 1 and not prod:
                        times = (t(9), t(13))  # a morning-only day: half day
                    for tm in times:
                        AttendanceLog.objects.create(
                            employee=emp, date=d(day), punch_time=tm, punch_type="IN", source="biometric:test"
                        )
                compute_range_records(emp, MAR, date(2026, 3, 31), settings)

        bulk(cls.q3, 3, "QA")
        bulk(cls.q15, 15, "QB")

    def test_query_count_is_flat(self):
        for rid in REPORT_IDS:
            if rid == "device-sync-health":
                continue  # not employee-scoped (covered in DeviceHealthTests)
            with self.subTest(rid):
                counts = {}
                rows = {}
                for name, dept in (("few", self.q3), ("many", self.q15)):
                    with CaptureQueriesContext(connection) as q:
                        body = self.run_report(rid, **PARAMS[rid], departmentIds=str(dept.id))
                    counts[name] = len(q)
                    rows[name] = len(self.data(body))
                self.assertGreater(rows["many"], 0, rid)
                self.assertLessEqual(abs(counts["many"] - counts["few"]), 3, (rid, counts, rows))


# ═════════════════════════════════════════════════════════════════════════════
#  ADVERSARIAL REVIEW: scenarios written to break the reports above. A failing test here is a
#  demonstrated defect (see the review report), not a fixture problem.
# ═════════════════════════════════════════════════════════════════════════════


class AdversarialReviewTests(_Base):
    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        # a person who has not joined yet in March: joins 10 April 2026, active, staff
        cls.future = Employee.objects.create(
            employee_code="ZF001",
            first_name="Future",
            last_name="Joiner",
            department=cls.sew,
            branch=cls.b1,
            employment_type="staff",
            salary_amount=Decimal("20000"),
            join_date="2026-04-10",
            father_name="Father",
            date_of_birth=date(1995, 1, 1),
        )
        EmployeeShiftAssignment.objects.create(employee=cls.future, shift=cls.gen, effective_from=date(2026, 1, 1))

    # ── who is in a month's register ──
    def test_perfect_attendance_does_not_list_people_who_joined_after_the_month(self):
        body = self.run_report("perfect-attendance", period=MONTH)
        codes = {r["employeeCode"] for r in self.data(body)}
        self.assertNotIn("ZF001", codes)
        by = self.keyed(body, "employeeCode")
        self.assertEqual(self.card(body, "Employees checked"), len(by))

    def test_form12_does_not_list_people_who_joined_after_the_month_and_keeps_leavers(self):
        body = self.run_report("form12-adult-workers-register", period=MONTH)
        codes = {r["employeeCode"] for r in self.data(body)}
        self.assertNotIn("ZF001", codes)  # not employed in March
        self.assertIn("AA008", codes)  # worked 2-6 March, left on the 6th: a March register must show them

    # ── aggregates that must not depend on a display filter ──
    def test_min_shortfall_filter_does_not_change_the_per_employee_averages(self):
        params = {"dateFrom": "2026-03-09", "dateTo": "2026-03-13", "employeeIds": str(self.e2.id)}
        plain = self.data(self.run_report("worked-hours-shortfall", **params))[0]
        filtered = self.data(self.run_report("worked-hours-shortfall", **params, minShortfall="15"))[0]
        self.assertEqual(plain["daysWorked"], 3)
        self.assertEqual((filtered["daysWorked"], filtered["avgHours"]), (plain["daysWorked"], plain["avgHours"]))

    # ── weekly-off / holiday work ──
    def test_a_detected_but_undecided_overtime_day_is_still_unpaid(self):
        base = self.run_report("weekly-off-holiday-work", **MONTH_RANGE)
        before = self.card(base, "Staff days with no OT / comp decision")
        OvertimeRecord.objects.create(
            employee=self.e2, date=d(15), last_punch_out=t(18), ot_minutes=120, status="detected"
        )
        after = self.card(
            self.run_report("weekly-off-holiday-work", **MONTH_RANGE), "Staff days with no OT / comp decision"
        )
        self.assertEqual(after, before)

    def test_off_day_work_says_so_when_the_compensation_feature_is_switched_off(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.ot_detection_enabled = False
        ps.save()
        body = self.run_report("weekly-off-holiday-work", **MONTH_RANGE)
        text = self.note_text(body).lower()
        self.assertTrue("switched off" in text or "disabled" in text, body["notes"])

    # ── shift-wise: same-named templates of different branches ──
    def test_shift_wise_keeps_same_named_shifts_of_two_branches_apart(self):
        other = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=t(8),
            end_time=t(17),
            grace_period_minutes=10,
            first_half_end=t(12, 30),
            branch=self.b2,
        )
        EmployeeShiftAssignment.objects.create(employee=self.e4, shift=other, effective_from=date(2026, 2, 1))
        body = self.run_report(
            "shift-wise-attendance", dateFrom="2026-03-02", dateTo="2026-03-02", employmentType="staff"
        )
        general = [r for r in self.data(body) if r["shiftName"].startswith("General")]
        self.assertEqual(len(general), 2, general)

    # ── limits ──
    def test_subtotal_rows_do_not_push_a_complete_list_over_the_row_limit(self):
        params = {**WEEK2, "employmentType": "staff"}
        n = len(self.data(self.run_report("late-coming-detail", **params)))
        self.assertGreater(n, 2)
        with mock.patch("api.reporting.runner.SCREEN_ROW_LIMIT", n):
            body = self.run_report("late-coming-detail", **params)
        self.assertFalse(body["truncated"], (n, len(body["rows"])))
        self.assertEqual(len(self.data(body)), n)
        self.assertIn("subtotals are omitted", self.note_text(body))  # said, not silently dropped

    # ── people who left ──
    def test_a_mid_month_leaver_is_never_perfect_and_says_why(self):
        body = self.run_report("perfect-attendance", period=MONTH, employeeStatus="all")
        row = self.keyed(body, "employeeCode")[("AA008",)]
        self.assertEqual(row["eligible"], "Not eligible")
        self.assertIn("left 06-Mar-2026 (mid-month)", row["reasonNot"])

    def test_form12_marks_a_leaver_and_skips_people_gone_before_the_month(self):
        body = self.run_report("form12-adult-workers-register", period=MONTH)
        self.assertIn("left 06-Mar-2026", self.keyed(body, "employeeCode")[("AA008",)]["remarks"])
        gone = Employee.objects.create(
            employee_code="ZG001",
            first_name="Gone",
            last_name="Earlier",
            department=self.cut,
            branch=self.b1,
            employment_type="staff",
            join_date="2024-01-01",
            status="inactive",
            father_name="Father",
            date_of_birth=date(1990, 1, 1),
        )
        ResignationRequest.objects.create(employee=gone, status="approved", last_working_date=date(2026, 2, 20))
        Employee.objects.create(  # inactive, no leaving date on file and no attendance in March: cannot be shown as employed
            employee_code="ZG002",
            first_name="Vanished",
            last_name="V",
            department=self.cut,
            branch=self.b1,
            employment_type="staff",
            join_date="2024-01-01",
            status="inactive",
            father_name="Father",
            date_of_birth=date(1990, 1, 1),
        )
        codes = {r["employeeCode"] for r in self.data(self.run_report("form12-adult-workers-register", period=MONTH))}
        self.assertNotIn("ZG001", codes)
        self.assertNotIn("ZG002", codes)
        self.assertIn("AA008", codes)

    # ── the display filter of the hours report ──
    def test_min_shortfall_lists_only_flagged_employees_but_keeps_all_their_days(self):
        params = {"dateFrom": "2026-03-09", "dateTo": "2026-03-13"}
        plain = self.keyed(self.run_report("worked-hours-shortfall", **params), "employeeCode")
        body = self.run_report("worked-hours-shortfall", **params, minShortfall="60")
        by = self.keyed(body, "employeeCode")
        self.assertTrue(set(by) < set(plain))  # employees without a 60-minute day are left out ...
        for key, row in by.items():  # ... and the others keep every figure
            self.assertEqual(row["daysWorked"], plain[key]["daysWorked"])
            self.assertEqual(row["workedHours"], plain[key]["workedHours"])
        self.assertIn("still cover every day", self.note_text(body))

    def test_a_detected_overtime_day_is_counted_like_one_with_no_record_at_all(self):
        OvertimeRecord.objects.create(
            employee=self.e2, date=d(15), last_punch_out=t(18), ot_minutes=120, status="detected"
        )
        body = self.run_report("weekly-off-holiday-work", **MONTH_RANGE, employeeIds=str(self.e2.id))
        (r,) = self.data(body)
        self.assertEqual(r["compensation"], "Detected")
        self.assertEqual(self.card(body, "Staff days with no OT / comp decision"), 1)


class AdversarialStrictModeTests(_Base):
    """The whole fixture again with Strict attendance (lunch punches, DailyShiftLog): the stored verdicts are
    written by a different code path, and the reports must read them the same way."""

    @classmethod
    def setUpTestData(cls):
        cls.build_world()
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        for emp in cls.staff:
            AttendanceDayRecord.objects.filter(employee=emp, source="auto").delete()
            compute_range_records(emp, MAR, date(2026, 3, 31), ps)

    def test_every_flagged_day_has_its_minutes_re_derived(self):
        body = self.run_report("late-coming-detail", **MONTH_RANGE, employmentType="staff")
        rows = self.data(body)
        flagged = AttendanceDayRecord.objects.filter(is_late=True, employee__employment_type="staff").count()
        self.assertEqual(len(rows), flagged)
        self.assertGreater(len(rows), 5)
        self.assertEqual([r["employeeCode"] + r["date"] for r in rows if r["lateMinutes"] is None], [])
        body = self.run_report("early-out", **MONTH_RANGE, employmentType="staff")
        rows = self.data(body)
        self.assertEqual(
            len(rows), AttendanceDayRecord.objects.filter(early_leave=True, employee__employment_type="staff").count()
        )
        self.assertEqual([r["employeeCode"] + r["date"] for r in rows if r["earlyMinutes"] is None], [])

    def test_the_penalty_breakdown_still_agrees_with_the_payslip(self):
        by = self.keyed(self.run_report("late-penalty-breakdown", period=MONTH), "employeeCode")
        for emp in (self.e1, self.e2, self.e3, self.e4):
            with self.subTest(emp.employee_code):
                slip = _generate_staff_payroll(emp, 3, 2026)["slip"]
                paid = slip.breakdown_details["deductions"]["lateSummary"]
                row = by[(emp.employee_code,)]
                self.assertEqual(row["poolTotal"], paid["totalLateCount"])
                self.assertEqual(row["billable"], paid["billableLateCount"])
                self.assertEqual(row["salaryDeduction"], float(slip.other_deductions))

    def test_the_night_late_column_is_offered_in_strict_mode(self):
        body = self.run_report("late-summary-counts", period=MONTH, employmentType="staff")
        self.assertIn("nightLate", [c["key"] for c in body["columns"]])

    def test_every_report_runs_in_strict_mode(self):
        for rid in REPORT_IDS:
            with self.subTest(rid):
                self.run_report(rid, **PARAMS[rid])


class AdversarialParityTests(_Base):
    """Figures that two screens of the same company must agree on."""

    def test_absent_days_equal_the_absent_days_payroll_pays_for(self):
        body = self.run_report("absenteeism", **MONTH_RANGE, employmentType="staff", employeeStatus="all")
        by = self.keyed(body, "employeeCode")
        for emp in (self.e1, self.e2, self.e3, self.e4, self.e7):
            with self.subTest(emp.employee_code):
                summary = (
                    _generate_staff_payroll(emp, 3, 2026)["slip"].breakdown_details["summary"]
                    if emp.salary_amount
                    else None
                )
                if summary is None:
                    continue
                row = by.get((emp.employee_code,))
                self.assertEqual(row["absentDays"] if row else 0, summary["absentDays"])

    def test_present_and_half_days_equal_payroll(self):
        body = self.run_report("perfect-attendance", period=MONTH, employeeStatus="all")
        by = self.keyed(body, "employeeCode")
        for emp in (self.e1, self.e2, self.e3, self.e4):
            with self.subTest(emp.employee_code):
                summary = _generate_staff_payroll(emp, 3, 2026)["slip"].breakdown_details["summary"]
                row = by[(emp.employee_code,)]
                self.assertEqual(row["presentDays"] + row["halfDays"], summary["presentDays"])
                self.assertEqual(row["halfDays"], summary["halfShiftDays"])

    def test_production_gross_equals_the_production_payroll_gross(self):
        from .payroll_views import _generate_production_payroll

        body = self.run_report("production-shift-register", dateFrom="2026-03-01", dateTo="2026-03-31")
        by = self.keyed(body, "employeeCode")
        for emp in (self.e5, self.e6):
            with self.subTest(emp.employee_code):
                res = _generate_production_payroll(emp, MAR, date(2026, 3, 31))
                self.assertEqual(by[(emp.employee_code,)]["estimatedGross"], float(res["payroll"].gross_salary))


class AdversarialFilterFuzzTests(_Base):
    """Every filter option of every report, on screen and in both files, must answer (no 500 / no crash)."""

    def test_every_option_of_every_filter_runs_and_exports(self):
        for rid in REPORT_IDS:
            spec = registry.get_spec(rid)
            base = PARAMS[rid]
            variants = [{}]
            for f in spec.filters:
                if f.kind == "select":
                    variants += [{f.key: v} for v, _l in f.options]
                elif f.kind == "boolean":
                    variants += [{f.key: "true"}, {f.key: "false"}]
                elif f.kind == "employmentType":
                    variants += [{"employmentType": "staff"}, {"employmentType": "production"}]
                elif f.kind == "employeeStatus":
                    variants += [{"employeeStatus": v} for v in ("active", "inactive", "all")]
            for extra in variants:
                with self.subTest(rid, extra=extra):
                    params = {**base, **extra}
                    r = self.call(f"/api/reports/run/{rid}", **params)
                    self.assertEqual(r.status_code, 200, (rid, extra, r.content[:300]))
                    for fmt in ("xlsx", "pdf"):
                        e = self.call(f"/api/reports/export/{rid}", fmt=fmt, **params)
                        self.assertEqual(e.status_code, 200, (rid, extra, fmt, e.content[:300]))

    def test_combined_switches(self):
        combos = {
            "half-day": [{"view": "summary", "cause": "left_early"}, {"view": "summary", "halfWorked": "unknown"}],
            "worked-hours-shortfall": [{"view": "daily", "minShortfall": "60", "deductLunch": "false"}],
            "department-strength": [{"groupBy": "department", "employeeStatus": "inactive"}],
            "absenteeism": [{"includeNoAbsence": "true", "minConsecutive": "10", "bridgeWeeklyOffs": "false"}],
            "late-coming-detail": [
                {"poolFilter": "counted", "minLate": "60", "shift": "gen", "permissionEffect": "none"}
            ],
        }
        for rid, lst in combos.items():
            for extra in lst:
                with self.subTest(rid, extra=extra):
                    body = self.run_report(rid, **{**PARAMS[rid], **extra})
                    self.assertIsInstance(body["rows"], list)
