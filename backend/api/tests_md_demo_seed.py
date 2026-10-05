"""The MD demo-data seeder (``manage.py seed_md_demo``).

What these tests pin down:

* SAFETY: the command refuses any database whose name does not end in ``_e2e`` (and says why), for loading and purging alike.
* the data is complete and deterministic: counts per domain, the same seed twice gives the same totals, another seed does not;
* the planted STORIES are really in the data, found the way a dashboard would find them (a problem department, a Monday and
  day-after-holiday spike, a unit's bad fortnight, an employee absent five days running, chronic absentees and habitual
  late-comers, overtime concentrated in two departments, tea-break overruns, repeat outpass users, a payroll month that jumps
  for a nameable reason ...);
* it is VALID for the application: every stored day verdict equals what the real attendance engine computes again from the
  same punches, salary slips add up, and the application's own endpoints and reports run on it;
* ``--purge`` removes exactly what was created and leaves what was already there alone; a second plain run does nothing.

The tests run the command in the test database, whose name does not end in ``_e2e``, so the name check is stood in for
(``active_database_name``) except in the tests of the refusal itself. Run with a private database:
``DB_TEST_NAME=test_uktex_demo python manage.py test api.tests_md_demo_seed --noinput``.
"""

import json
import shutil
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from io import StringIO
from pathlib import Path
from unittest import mock

from django.apps import apps
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.models import Count
from django.test import SimpleTestCase, TestCase

from .attendance_final import _leave_dates_for_month, compute_day_record
from .jwt_utils import sign_token
from .management.commands.md_demo import attendance, common, org, purge
from .management.commands.md_demo.names import NameFactory
from .management.commands.md_demo.people import add_months
from .management.commands.md_demo.verdicts import production_verdict, staff_verdict
from .models import (
    Advance,
    AdvanceRepayment,
    Bonus,
    Applicant,
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    Department,
    DepartmentHeadcount,
    Employee,
    EmployeeShiftAssignment,
    GateDevice,
    Holiday,
    HrLoginAttempt,
    HRUser,
    Job,
    LeaveRequest,
    LoginSession,
    OutpassRequest,
    OvertimeRecord,
    PayrollRun,
    PayrollSettings,
    ProductionShiftConfig,
    ProductionShiftSegment,
    ResignationRequest,
    SalaryIncrement,
    SalarySlip,
    ScreeningCandidate,
    ShiftTemplate,
    TeaBreakLog,
    TeaBreakRule,
    Visitor,
    VisitorVisit,
)

TODAY = date(2026, 10, 5)  # a Monday
NOW = time(15, 30)
SAFE_NAME = "uktex_demo_e2e"
SMALL = ["--employees", "60", "--days", "30", "--today", TODAY.isoformat(), "--now", "15:30", "--seed", "42"]
TINY = ["--employees", "20", "--days", "7", "--today", TODAY.isoformat(), "--now", "15:30", "--seed", "42"]
KNOWN_ACTIONS = {
    "login",
    "login_failed",
    "login_blocked",
    "create",
    "update",
    "delete",
    "export",
    "approve",
    "lock",
    "backup",
}


@contextmanager
def throwaway_name(name: str = SAFE_NAME):
    """Stand in for a database called ``*_e2e``: the test database itself is not named like one."""
    with mock.patch.object(common, "active_database_name", return_value=name):
        yield


def run(*args: str, manifest_dir: Path) -> str:
    out = StringIO()
    with throwaway_name():
        call_command("seed_md_demo", *args, "--manifest-dir", str(manifest_dir), stdout=out, stderr=out)
    return out.getvalue()


def table_counts() -> dict[str, int]:
    """Row counts of every table of the application (what a purge must leave exactly as it was)."""
    return {m._meta.label: m.objects.count() for m in apps.get_app_config("api").get_models()}


def hr_headers(username: str) -> dict:
    user = HRUser.objects.get(username=username)
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'username': username})}"}


def fingerprint() -> dict:
    """Totals that must be identical for the same seed: counts, sums and a few distributions."""
    slips = SalarySlip.objects.filter(employee__employee_code__startswith="DM-")
    gross = sum(s.gross_salary for s in slips)
    return {
        "counts": {k: v for k, v in table_counts().items() if k not in ("api.GateQRCode",)},
        "statuses": sorted(Counter(AttendanceDayRecord.objects.values_list("status", flat=True)).items()),
        "gross": str(gross),
        "salaries": str(sum(e.salary_amount or 0 for e in Employee.objects.filter(employee_code__startswith="DM-"))),
        "late": AttendanceDayRecord.objects.filter(is_late=True).count(),
        "overrun": sum(
            1
            for o, i in TeaBreakLog.objects.filter(in_at__isnull=False).values_list("out_at", "in_at")
            if (i - o) > timedelta(minutes=15, seconds=30)
        ),
    }


# ─── the name rule ────────────────────────────────────────────────────────────────────────────────────────────


class SafetyTests(TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_refuses_a_database_whose_name_does_not_end_in_e2e_and_says_why(self):
        before = table_counts()
        name = connection.settings_dict["NAME"]
        self.assertFalse(name.endswith("_e2e"))
        with self.assertRaises(CommandError) as ctx:
            call_command("seed_md_demo", *TINY, "--manifest-dir", str(self.dir), stdout=StringIO())
        message = str(ctx.exception)
        self.assertIn(name, message)
        self.assertIn("_e2e", message)
        self.assertIn("throwaway", message)
        self.assertEqual(table_counts(), before, "a refusal must not write anything")
        self.assertEqual(list(self.dir.iterdir()), [], "nor leave a manifest behind")

    def test_purge_and_reload_are_refused_too(self):
        for flag in ("--purge", "--reload"):
            with self.assertRaises(CommandError, msg=flag):
                call_command("seed_md_demo", flag, "--manifest-dir", str(self.dir), stdout=StringIO())

    def test_the_rule_is_a_suffix_and_case_sensitive(self):
        for bad in ("uktex_e2e_backup", "UKTex_DB", "e2e", "demo_E2E", "uktex_e2e "):
            with throwaway_name(bad), self.assertRaises(CommandError, msg=bad):
                call_command("seed_md_demo", *TINY, "--manifest-dir", str(self.dir), stdout=StringIO())
        with throwaway_name("anything_e2e"):
            self.assertEqual(common.require_throwaway_database(), "anything_e2e")

    def test_the_command_is_not_run_by_migrate_or_test_setup(self):
        """Nothing in the tests' own database creation seeded demo data."""
        self.assertFalse(Employee.objects.filter(employee_code__startswith=common.CODE_PREFIX).exists())
        self.assertFalse(HRUser.objects.filter(username=common.MD_USERNAME).exists())

    def test_a_dev_machines_real_clock_never_reaches_the_future(self):
        with self.assertRaisesMessage(CommandError, "future"), throwaway_name():
            call_command("seed_md_demo", "--today", "2099-01-01", "--manifest-dir", str(self.dir), stdout=StringIO())

    def test_bad_options_are_explained(self):
        for args, text in (
            (["--employees", "5"], "--employees"),
            (["--days", "2"], "--days"),
            (["--now", "noon"], "--now"),
            (["--today", "05/10/2026"], "--today"),
        ):
            with self.assertRaisesMessage(CommandError, text), throwaway_name():
                call_command("seed_md_demo", *args, "--manifest-dir", str(self.dir), stdout=StringIO())


# ─── the seeded company ───────────────────────────────────────────────────────────────────────────────────────


class DemoDataTests(TestCase):
    """One small company (60 employees, a 30-day activity window, 6 payroll months), loaded once for all of these."""

    @classmethod
    def setUpTestData(cls):
        cls.dir = Path(tempfile.mkdtemp())
        cls.output = run(*SMALL, manifest_dir=cls.dir)
        cls.manifest = json.loads(next(cls.dir.glob("manifest-*.json")).read_text(encoding="utf-8"))
        cls.stories = cls.manifest["stories"]
        cls.holidays = set(Holiday.objects.values_list("date", flat=True))
        cls.sat_off = set(
            EmployeeShiftAssignment.objects.filter(saturday_off=True).values_list("employee_id", flat=True)
        )
        cls.people = {
            e.id: e
            for e in Employee.objects.filter(employee_code__startswith="DM-").select_related("department", "branch")
        }
        cls.rows = list(
            AttendanceDayRecord.objects.filter(employee__employee_code__startswith="DM-").values_list(
                "employee_id", "date", "status", "is_late", "total_punches", "shifts_earned"
            )
        )

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.dir, ignore_errors=True)

    # --- the people and the organisation ---

    def test_the_company_has_its_shape(self):
        emps = Employee.objects.filter(employee_code__startswith="DM-")
        self.assertEqual(emps.count(), 60)
        production = emps.filter(employment_type="production").count()
        self.assertEqual(production, round(60 * 0.65))
        self.assertEqual(emps.filter(employment_type="staff").count(), 60 - production)
        units = {b.name for b in Branch.objects.filter(employees__employee_code__startswith="DM-").distinct()}
        self.assertEqual(len(units), 4, units)  # a head office and three production units
        self.assertEqual(
            Branch.objects.filter(is_head_office=True, name="Head Office").count(), 1
        )  # the migrations' own, reused
        per_unit = (
            Department.objects.filter(description__endswith=common.DEMO_TAG)
            .values("branch__name")
            .annotate(n=Count("id"))
        )
        for row in per_unit:
            self.assertTrue(6 <= row["n"] <= 9, row)  # 6-9 departments per unit
        self.assertEqual(
            ShiftTemplate.objects.filter(branch__in=Branch.objects.all())
            .filter(name__in=["Office Shift", "Staff Shift", "Regular Shift", "Extended Shift"])
            .count(),
            10,
        )
        self.assertGreaterEqual(Holiday.objects.count(), 20)
        self.assertEqual(Employee.objects.filter(employee_code__startswith="DM-", unit_code__isnull=True).count(), 0)

    def test_codes_names_and_dates_look_real(self):
        emps = list(Employee.objects.filter(employee_code__startswith="DM-"))
        self.assertEqual(len({e.employee_code for e in emps}), 60)
        self.assertEqual(len({(e.first_name, e.last_name) for e in emps}), 60, "no two people read alike")
        self.assertTrue(
            all(e.join_date and date.fromisoformat(e.join_date) <= TODAY for e in emps)
        )  # TEXT dates, as in the app
        years = {int(e.join_date[:4]) for e in emps}
        self.assertGreaterEqual(max(years) - min(years), 6, "joining dates spread over years")
        recent = [e for e in emps if date.fromisoformat(e.join_date) >= TODAY - timedelta(days=183)]
        self.assertGreaterEqual(len(recent), 2, "some joined in the last six months")
        self.assertTrue(all(e.email is None or e.email.endswith(".example") for e in emps), "no deliverable addresses")
        self.assertTrue(all(len(e.phone) == 10 and e.phone.isdigit() for e in emps))
        self.assertGreaterEqual(len({e.gender for e in emps}), 2)
        self.assertTrue(all(18 <= (TODAY - e.date_of_birth).days / 365.25 <= 65 for e in emps))
        for e in emps:  # the salary split is always exactly half and half
            first = e.salary_basic + e.salary_da + e.salary_retaining_allowance
            self.assertIn(first, (e.salary_amount / 2, (e.salary_amount + Decimal("0.01")) / 2), e.employee_code)

    def test_exits_have_reasons_and_dates(self):
        left = Employee.objects.filter(employee_code__startswith="DM-", status="inactive")
        self.assertGreaterEqual(left.count(), 2)
        staff_left = left.filter(employment_type="staff")
        for emp in staff_left:
            r = ResignationRequest.objects.get(employee=emp, status="approved")
            self.assertTrue(r.reason and r.last_working_date and r.last_working_date >= TODAY - timedelta(days=366))
        production_left = left.filter(employment_type="production")
        for emp in (
            production_left
        ):  # deactivated by HR: the exit date is the record's last-modified day (the app's own fallback)
            self.assertLess(emp.updated_at.date(), TODAY)
            self.assertFalse(ResignationRequest.objects.filter(employee=emp).exists())

    def test_the_md_and_the_hr_accounts(self):
        md = HRUser.objects.get(username="md_demo")
        self.assertTrue(md.is_md and md.is_active and not md.is_super_admin)
        self.assertIsNone(md.branch_id)
        self.assertIsNone(md.role_id)
        self.assertEqual(HRUser.objects.filter(is_md=True).count(), 1)
        names = set(HRUser.objects.filter(username__endswith="_demo").values_list("username", flat=True))
        self.assertEqual(len(names), 7)
        manager = HRUser.objects.get(username="hr_demo")
        self.assertEqual(manager.role.name, "HR Manager")
        self.assertTrue(HRUser.objects.get(username="unit2hr_demo").branch_id)  # a unit-level HR account

    def test_every_demo_account_can_sign_in_and_the_md_lands_in_the_md_portal(self):
        for username in ("md_demo", "hr_demo", "payroll_demo"):
            r = self.client.post(
                "/api/auth/hr-login",
                {"username": username, "password": common.DEMO_PASSWORD},
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, (username, r.content[:200]))
            self.assertEqual(r.json()["isMd"], username == "md_demo")
        r = self.client.post(
            "/api/auth/hr-login", {"username": "md_demo", "password": "wrong"}, content_type="application/json"
        )
        self.assertEqual(r.status_code, 401)

    def test_leave_types_balances_and_requests(self):
        self.assertGreaterEqual(LeaveRequest.objects.filter(employee__employee_code__startswith="DM-").count(), 5)
        self.assertEqual(
            set(LeaveRequest.objects.values_list("status", flat=True)) - {"approved", "rejected", "pending"}, set()
        )
        balances = (
            Employee.objects.filter(employee_code__startswith="DM-", status="active").first().leave_balances.all()
        )
        self.assertGreaterEqual(balances.count(), 5)
        for b in balances:
            self.assertEqual(b.remaining, b.allocated - b.used)
        for leave in LeaveRequest.objects.filter(
            status="approved", employee__employee_code__startswith="DM-"
        ):  # an approved leave is "on leave" in attendance
            day = date.fromisoformat(leave.start_date)
            if day < TODAY:
                row = AttendanceDayRecord.objects.filter(employee=leave.employee, date=day).first()
                if row is not None and leave.employee.employment_type == "staff":
                    self.assertEqual(row.status, "on_leave", (leave.employee.employee_code, day))

    # --- attendance: the shape of the data ---

    def scheduled(self, emp_id: int, day: date) -> bool:
        emp = self.people[emp_id]
        if day in self.holidays or day.weekday() == 6:
            return False
        return not (emp.employment_type == "staff" and day.weekday() == 5 and emp_id in self.sat_off)

    def absence(self, keep) -> float:
        """Share of scheduled days (approved leave and today excluded) that were absent, for the rows ``keep`` accepts."""
        absent = total = 0
        for emp_id, day, status, *_ in self.rows:
            if day >= TODAY or status == "on_leave" or not self.scheduled(emp_id, day) or not keep(emp_id, day):
                continue
            total += 1
            absent += status == "absent"
        self.assertGreater(total, 50, "too few rows to say anything")
        return absent / total

    def test_day_records_cover_the_history_and_never_the_future(self):
        dates = [r[1] for r in self.rows]
        self.assertEqual(max(dates), TODAY)
        self.assertLessEqual(min(dates), date(2026, 4, 1), "the first payroll month is covered")
        for emp_id, emp in self.people.items():
            first = date.fromisoformat(emp.join_date)
            mine = [r[1] for r in self.rows if r[0] == emp_id]
            self.assertTrue(all(d >= first for d in mine), "no record before the joining date")
        self.assertEqual(set(r[2] for r in self.rows), {"present", "absent", "half_shift", "holiday", "on_leave"})
        self.assertEqual(
            AttendanceDayRecord.objects.filter(employee__employee_code__startswith="DM-", date__gt=TODAY).count(), 0
        )

    def test_sundays_and_holidays_are_stored_the_way_the_engine_stores_them(self):
        for emp_id, day, status, *_ in self.rows:
            emp = self.people[emp_id]
            if day in self.holidays and status != "on_leave":
                self.assertEqual(status, "holiday", (emp.employee_code, day))
            if day.weekday() == 6 and emp.employment_type == "staff" and status != "on_leave":
                self.assertEqual(status, "holiday")  # production work Sundays: their idle Sundays are absent rows

    def test_saturday_off_is_stored_as_absent_rows_with_no_punches(self):
        self.assertTrue(self.sat_off, "some staff have Saturday off")
        seen = 0
        for emp_id, day, status, late, punches, shifts in self.rows:
            if emp_id in self.sat_off and day.weekday() == 5 and day not in self.holidays and status != "on_leave":
                self.assertEqual((status, punches), ("absent", 0), (self.people[emp_id].employee_code, day))
                seen += 1
        self.assertGreater(seen, 20)

    def test_today_is_provisional(self):
        today_rows = AttendanceDayRecord.objects.filter(employee__employee_code__startswith="DM-", date=TODAY)
        self.assertGreater(today_rows.count(), 20)
        self.assertFalse(
            AttendanceLog.objects.filter(date=TODAY, punch_time__gt=NOW).exists(), "no punch from the future"
        )
        for row in today_rows.exclude(total_punches=0):
            self.assertLessEqual(row.last_punch or row.first_punch, NOW)
        # a day still running: people who have not yet left are a half day until their evening punch arrives
        halves = today_rows.filter(status="half_shift").count()
        self.assertGreater(halves, today_rows.filter(status="present").count())
        self.assertGreater(today_rows.filter(status="absent").count(), 0)

    def test_punches_are_naive_local_times_in_ascending_order_with_a_biometric_source(self):
        logs = list(
            AttendanceLog.objects.filter(employee__employee_code__startswith="DM-", date=date(2026, 9, 30)).order_by(
                "employee_id", "punch_time"
            )
        )
        self.assertTrue(logs)
        by_emp = defaultdict(list)
        for log in logs:
            by_emp[log.employee_id].append(log)
            self.assertTrue(log.source.startswith(("biometric:", "missing_punch:")))
            self.assertIsNone(log.punch_time.tzinfo)
        for punches in by_emp.values():
            self.assertEqual([p.punch_type for p in punches][:2], ["IN", "OUT"][: len(punches)])
            self.assertEqual(len({p.punch_time for p in punches}), len(punches))

    # --- attendance: the planted stories ---

    def test_a_problem_department_has_about_twice_the_companys_absence(self):
        company = self.absence(lambda e, d: True)
        washing = self.absence(
            lambda e, d: self.people[e].department.name == "Washing" and self.people[e].branch.name.startswith("Unit 3")
        )
        self.assertGreater(washing, 1.6 * company, (washing, company))

    def test_monday_and_the_day_after_a_holiday_are_the_bad_days(self):
        monday = self.absence(lambda e, d: d.weekday() == 0)
        midweek = self.absence(lambda e, d: d.weekday() in (2, 3))
        self.assertGreater(monday, 1.25 * midweek, (monday, midweek))
        after = self.absence(lambda e, d: (d - timedelta(days=1)) in self.holidays and d.weekday() != 0)
        ordinary = self.absence(
            lambda e, d: (d - timedelta(days=1)) not in self.holidays and d.weekday() in (1, 2, 3, 4)
        )
        self.assertGreater(after, 1.3 * ordinary, (after, ordinary))

    def test_one_unit_has_a_bad_fortnight(self):
        story = self.stories["badFortnight"]
        first, last = date.fromisoformat(story["from"]), date.fromisoformat(story["to"])
        self.assertEqual((last - first).days, 13)
        unit = lambda e: self.people[e].branch.name.startswith("Unit 2")  # noqa: E731
        inside = self.absence(lambda e, d: unit(e) and first <= d <= last)
        outside = self.absence(lambda e, d: unit(e) and not first <= d <= last)
        self.assertGreater(inside, 1.5 * outside, (inside, outside))
        other = self.absence(lambda e, d: not unit(e) and first <= d <= last)
        self.assertGreater(inside, 1.4 * other, "the other units had a normal fortnight")

    def test_the_last_three_weeks_improve_a_little(self):
        odds = attendance.Simulator.improving
        sim = mock.Mock(today=TODAY)
        self.assertEqual(odds(sim, TODAY), attendance.IMPROVEMENT_FLOOR)
        self.assertEqual(odds(sim, TODAY - timedelta(days=attendance.IMPROVING_DAYS)), 1.0)
        series = [odds(sim, TODAY - timedelta(days=n)) for n in range(attendance.IMPROVING_DAYS, -1, -1)]
        self.assertEqual(series, sorted(series, reverse=True))
        self.assertLess(attendance.IMPROVEMENT_FLOOR, 1.0)
        self.assertGreater(attendance.IMPROVEMENT_FLOOR, 0.6, "a slight improvement, not a collapse")
        last = self.absence(lambda e, d: d >= TODAY - timedelta(days=21))
        before = self.absence(lambda e, d: TODAY - timedelta(days=84) <= d < TODAY - timedelta(days=21))
        self.assertLess(last, before * 1.15, "the recent weeks are not worse than the weeks before")

    def streak_of(self, emp_id: int) -> tuple[int, date | None]:
        """Longest run of absent scheduled days (weekly offs and holidays between two absences do not break it)."""
        best, run, start, best_start = 0, 0, None, None
        for e, day, status, *_ in sorted((r for r in self.rows if r[0] == emp_id), key=lambda r: r[1]):
            if day >= TODAY or not self.scheduled(e, day):
                continue
            if status == "absent":
                run += 1
                start = start or day
                if run > best:
                    best, best_start = run, start
            else:
                run, start = 0, None
        return best, best_start

    def test_one_employee_was_absent_five_working_days_running_with_no_leave_on_record(self):
        story = self.stories["fiveDayAbsence"]
        emp = Employee.objects.get(employee_code=story["employee"])
        first, last = date.fromisoformat(story["from"]), date.fromisoformat(story["to"])
        days = [first + timedelta(days=i) for i in range(5)]
        self.assertEqual([d.weekday() for d in days], [0, 1, 2, 3, 4])
        statuses = {
            r.date: r.status
            for r in AttendanceDayRecord.objects.filter(
                employee=emp, date__range=(first - timedelta(days=3), last + timedelta(days=3))
            )
        }
        self.assertEqual({statuses[d] for d in days}, {"absent"})
        self.assertNotEqual(statuses.get(first - timedelta(days=1)), "absent")
        self.assertNotIn(statuses.get(last + timedelta(days=1)), ("absent",))
        for leave in LeaveRequest.objects.filter(employee=emp):
            self.assertFalse(
                date.fromisoformat(leave.start_date) <= last and date.fromisoformat(leave.end_date) >= first,
                "no leave covers it",
            )
        self.assertEqual(self.streak_of(emp.id)[0], 5)
        approved = self.stories[
            "fiveDayApprovedLeave"
        ]  # for contrast: five days of approved leave are on leave, not absent
        other = Employee.objects.get(employee_code=approved["employee"])
        self.assertEqual(
            AttendanceDayRecord.objects.filter(
                employee=other, date__range=(approved["from"], approved["to"]), status="on_leave"
            ).count(),
            5,
        )

    def test_chronic_absentees_and_habitual_late_comers_stand_out(self):
        company = self.absence(lambda e, d: True)
        for code in self.stories["chronicAbsentees"]:
            emp_id = Employee.objects.get(employee_code=code).id
            self.assertGreater(self.absence(lambda e, d: e == emp_id), 2 * company, code)
        late_share = lambda keep: (
            sum(r[3] for r in self.rows if keep(r) and r[2] in ("present", "half_shift"))
            / max(1, sum(1 for r in self.rows if keep(r) and r[2] in ("present", "half_shift")))
        )  # noqa: E731
        baseline = late_share(lambda r: r[1] < TODAY)
        for code in self.stories["habitualLateComers"]:
            emp_id = Employee.objects.get(employee_code=code).id
            self.assertGreater(late_share(lambda r: r[0] == emp_id and r[1] < TODAY), 3 * baseline, code)

    def test_overtime_is_concentrated_in_packing_and_merchandising(self):
        by_dept = defaultdict(lambda: [0, 0])
        for emp_id, day, status, late, punches, shifts in self.rows:
            emp = self.people[emp_id]
            if emp.employment_type != "production" or status not in ("present", "half_shift") or day >= TODAY:
                continue
            by_dept[emp.department.name][0] += shifts >= Decimal("1.5")
            by_dept[emp.department.name][1] += 1
        rate = lambda names: sum(by_dept[n][0] for n in names) / max(1, sum(by_dept[n][1] for n in names))  # noqa: E731
        others = [n for n in by_dept if n not in ("Packing", "Stitching")]
        self.assertGreater(rate(["Packing"]), 3 * rate(others))
        staff_ot = Counter(
            OvertimeRecord.objects.filter(employee__employee_code__startswith="DM-").values_list(
                "employee__department__name", flat=True
            )
        )
        self.assertGreater(staff_ot["Merchandising"], 0.3 * sum(staff_ot.values()), staff_ot)

    def test_a_few_punches_go_missing_and_overtime_follows_the_engines_rule(self):
        odd = AttendanceDayRecord.objects.filter(employee__employee_code__startswith="DM-", total_punches__in=[1, 3])
        self.assertGreater(odd.count(), 3)
        for row in odd.filter(employee__employment_type="staff", total_punches=1).exclude(arrival_zone="second_half"):
            self.assertEqual(row.status, "half_shift")  # "a lone punch is a half day by rule"
        for ot in OvertimeRecord.objects.filter(employee__employee_code__startswith="DM-")[:50]:
            self.assertGreaterEqual(ot.ot_minutes, 60)
            self.assertEqual(ot.employee.employment_type, "staff")

    def test_the_device_outage_left_no_records_at_all(self):
        outage = [date.fromisoformat(d) for d in self.stories["deviceOutage"]["days"]]
        self.assertEqual(len(outage), 2)
        unit3 = Employee.objects.filter(employee_code__startswith="DM-", branch__name__startswith="Unit 3")
        for day in outage:
            self.assertEqual(AttendanceDayRecord.objects.filter(employee__in=unit3, date=day).count(), 0)
            self.assertGreater(
                AttendanceDayRecord.objects.filter(date=day, employee__employee_code__startswith="DM-").count(),
                10,
                "other units are unaffected",
            )

    def test_a_sample_of_stored_days_equals_what_the_real_engine_computes(self):
        fields = [
            "status",
            "shifts_earned",
            "is_late",
            "is_half_shift",
            "early_leave",
            "late_afternoon",
            "morning_permission_applied",
            "evening_permission_applied",
            "middle_permission_today",
            "permission_afternoon",
            "arrival_zone",
            "late_reason",
            "first_punch",
            "last_punch",
            "total_punches",
            "computed_mode",
            "primary_source",
        ]
        strata = defaultdict(list)
        for row in AttendanceDayRecord.objects.filter(employee__employee_code__startswith="DM-", source="auto"):
            key = (
                row.computed_mode,
                row.status,
                row.arrival_zone,
                row.is_late,
                row.late_afternoon,
                row.total_punches % 2,
                str(row.shifts_earned),
            )
            strata[key].append(row.id)
        picked = [pk for _key, ids in sorted(strata.items(), key=lambda kv: str(kv[0])) for pk in ids[:2]]
        self.assertGreater(len(strata), 12, "the sample touches many kinds of day")
        checked = 0
        for pk in picked:
            row = AttendanceDayRecord.objects.select_related("employee").get(pk=pk)
            before = {f: getattr(row, f) for f in fields}
            leave = _leave_dates_for_month(row.employee, row.date.year, row.date.month)
            fresh = compute_day_record(
                row.employee, row.date, holiday_dates=self.holidays, leave_dates=leave, half_day_leave_dates={}
            )
            for f in fields:
                self.assertEqual(before[f], getattr(fresh, f), (row.employee.employee_code, str(row.date), f))
            checked += 1
        self.assertEqual(checked, len(picked))

    # --- tea breaks ---

    def breaks(self):
        rows = []
        shift_of = {a.employee_id: a.shift.name for a in EmployeeShiftAssignment.objects.select_related("shift")}
        for log in TeaBreakLog.objects.filter(employee__employee_code__startswith="DM-").select_related(
            "employee__department"
        ):
            minutes = round((log.in_at - log.out_at).total_seconds() / 60) if log.in_at else None
            rows.append(
                (
                    log.employee.employee_code,
                    log.employee.department.name,
                    shift_of.get(log.employee_id),
                    minutes,
                    log.out_at,
                )
            )
        return rows

    def test_tea_breaks_are_mostly_inside_the_allowance_with_one_group_overrunning(self):
        self.assertEqual(TeaBreakRule.objects.get(pk=1).allowed_minutes, 15)
        done = [r for r in self.breaks() if r[3] is not None]
        self.assertGreater(len(done), 300)
        share = lambda rows: sum(r[3] > 15 for r in rows) / max(1, len(rows))  # noqa: E731
        group = [r for r in done if (r[1], r[2]) == ("Stitching", "Extended Shift")]
        rest = [
            r
            for r in done
            if (r[1], r[2]) != ("Stitching", "Extended Shift") and r[0] not in self.stories["teaBreakRepeatOffenders"]
        ]
        self.assertGreater(len(group), 40)
        self.assertLess(share(rest), 0.25, "most breaks are fine")
        self.assertGreater(share(group), 2 * share(rest), (share(group), share(rest)))
        offenders = [r for r in done if r[0] in self.stories["teaBreakRepeatOffenders"]]
        self.assertGreater(share(offenders), 0.45)
        self.assertTrue(all(4 <= r[3] <= 60 for r in done))

    def test_the_last_week_of_tea_breaks_is_worse(self):
        start = TODAY - timedelta(days=6)
        done = [r for r in self.breaks() if r[3] is not None]
        week = [r for r in done if r[4].astimezone(common.FACTORY_TZ).date() >= start]
        before = [r for r in done if r[4].astimezone(common.FACTORY_TZ).date() < start]
        share = lambda rows: sum(r[3] > 15 for r in rows) / len(rows)  # noqa: E731
        self.assertGreater(share(week), share(before), (share(week), share(before)))

    def test_breaks_are_only_taken_by_people_at_work_and_open_ones_are_old_or_running(self):
        for log in TeaBreakLog.objects.filter(employee__employee_code__startswith="DM-", in_at__isnull=False)[:300]:
            local = log.out_at.astimezone(common.FACTORY_TZ)
            punches = list(
                AttendanceLog.objects.filter(employee=log.employee, date=local.date())
                .order_by("punch_time")
                .values_list("punch_time", flat=True)
            )
            self.assertTrue(punches, "a break by someone with no punch that day")
            self.assertGreater(local.time(), punches[0])
        self.assertFalse(TeaBreakLog.objects.filter(out_at__gt=common.at(TODAY, NOW)).exists())
        self.assertGreater(log := TeaBreakLog.objects.filter(in_at__isnull=True).count(), 0, log)

    # --- visitors and outpasses ---

    def test_visitors_have_a_weekday_pattern_repeat_visitors_and_after_hours_visits(self):
        by_day = Counter()
        for (moment,) in VisitorVisit.objects.values_list("visited_at"):
            by_day[moment.astimezone(common.FACTORY_TZ).weekday()] += 1
        self.assertGreater(by_day[1] + by_day[2] + by_day[3], 3 * by_day[5])
        counts = Counter(VisitorVisit.objects.values_list("visitor_id", flat=True))
        self.assertGreaterEqual(max(counts.values()), 3, "somebody comes again and again")
        late = [
            m
            for (m,) in VisitorVisit.objects.values_list("visited_at")
            if not 8 <= m.astimezone(common.FACTORY_TZ).hour < 18 or m.astimezone(common.FACTORY_TZ).weekday() == 6
        ]
        self.assertGreaterEqual(len(late), 1)
        self.assertTrue(all(v.aadhaar_number.startswith(common.VISITOR_TAG) for v in Visitor.objects.all()))
        self.assertFalse(
            any(hasattr(VisitorVisit, f) for f in ("left_at", "checked_out_at", "out_time")),
            "visitors have no check-out",
        )

    def test_outpasses_have_repeat_users_passes_never_returned_and_old_pending_requests(self):
        now = common.at(TODAY, NOW)
        requests = OutpassRequest.objects.filter(employee__employee_code__startswith="DM-")
        self.assertGreater(requests.count(), 15)
        waiting = requests.filter(status="pending", created_at__lt=now - timedelta(hours=24))
        self.assertGreaterEqual(waiting.count(), 1, "approvals pending more than a day")
        never = requests.filter(
            exited_at__isnull=False, entered_at__isnull=True, created_at__lt=now - timedelta(days=2)
        ).exclude(pass_type="early_dismissal")
        self.assertGreaterEqual(never.count(), 1, "a pass whose holder never came back")
        per_person = Counter(requests.values_list("employee__employee_code", flat=True))
        repeaters = self.stories["outpassRepeatUsers"]
        held = sum(per_person[c] for c in repeaters) / sum(per_person.values())
        their_share_of_people = len(repeaters) / len(self.people)
        self.assertGreater(held, 3 * their_share_of_people, (per_person.most_common(5), held, their_share_of_people))
        for r in requests.filter(status="approved", exited_at__isnull=False):
            self.assertLessEqual(
                r.exited_at, r.approved_at + timedelta(minutes=60), "the pass is scanned while it is valid"
            )
            if r.entered_at:
                self.assertGreater(r.entered_at, r.exited_at)
        self.assertTrue(all(r.approved_at is None for r in requests.filter(status="pending")))

    # --- payroll ---

    def test_six_closed_months_of_pay_runs_each_adding_up(self):
        months = [(2026, m) for m in range(4, 10)]
        runs = {(r.year, r.month): r for r in PayrollRun.objects.filter(run_code__startswith=common.RUN_CODE_PREFIX)}
        self.assertEqual(sorted(runs), months)
        self.assertEqual(runs[(2026, 9)].status, "approved")
        self.assertTrue(all(runs[m].status == "locked" for m in months[:-1]))
        for key, run in runs.items():
            slips = SalarySlip.objects.filter(payroll_run=run)
            self.assertEqual(sum(s.gross_salary for s in slips), run.total_gross)
            self.assertEqual(sum(s.total_deductions for s in slips), run.total_deductions)
            self.assertEqual(sum(s.net_salary for s in slips), run.total_net)
            self.assertEqual(run.total_employees, len({s.employee_id for s in slips}))
            for s in slips:
                self.assertEqual(s.gross_salary + s.ot_amount - s.total_deductions, s.net_salary, s.slip_number)
                # the lines on a slip add up to its gross (overtime is outside it): the payroll page's "what the money
                # is made of" has nothing to hide under "not itemised"
                self.assertEqual(
                    s.basic + s.hra + s.allowances + s.incentives + s.bonuses, s.gross_salary, s.slip_number
                )
                self.assertEqual(
                    s.pf_deduction + s.esi_deduction + s.advance_deduction + s.other_deductions,
                    s.total_deductions,
                    s.slip_number,
                )

    def test_slips_follow_the_engines_working_days_and_the_attendance_of_the_month(self):
        from .payroll_views import _build_working_days

        checked = 0
        for slip in SalarySlip.objects.filter(
            employee__employee_code__startswith="DM-", period_start__isnull=True, month=8, year=2026
        ):
            emp = slip.employee
            saturday_off = emp.id in self.sat_off
            expected = _build_working_days(
                8, 2026, saturday_off, {d for d in self.holidays if d.month == 8 and d.year == 2026}
            )
            self.assertEqual(slip.working_days, len(expected), slip.slip_number)
            rows = {r[1]: r for r in self.rows if r[0] == emp.id}
            effective = sum(
                (
                    rows[d][5]
                    if rows[d][2] in ("present", "half_shift") and rows[d][5] > 0
                    else Decimal(1)
                    if rows[d][2] in ("present", "half_shift")
                    else 0
                )
                for d in expected
                if d in rows
            )
            self.assertEqual(slip.breakdown_details["summary"]["effectivePaidDays"], float(effective), slip.slip_number)
            checked += 1
        self.assertGreater(checked, 5)
        # production: a period slip's shifts are the shifts the day records add up to (the outage unit is paid from paper)
        for slip in SalarySlip.objects.filter(
            employee__employee_code__startswith="DM-", period_start__isnull=False, month=9, year=2026
        ).exclude(employee__branch__name__startswith="Unit 3")[:15]:
            days = AttendanceDayRecord.objects.filter(
                employee=slip.employee, date__range=(slip.period_start, slip.period_end)
            )
            shifts = sum(d.shifts_earned for d in days)
            self.assertEqual(
                slip.present_days, shifts.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), slip.slip_number
            )
            rate = Decimal(str(slip.breakdown_details["salaryPerShift"]))
            self.assertEqual(
                slip.gross_salary - slip.bonuses, (shifts * rate).quantize(Decimal("0.01")), slip.slip_number
            )

    def test_payroll_cost_moves_with_a_visible_jump_in_the_bonus_month(self):
        totals = {}
        for y, m in [(2026, n) for n in range(4, 10)]:
            slips = SalarySlip.objects.filter(employee__employee_code__startswith="DM-", year=y, month=m)
            totals[m] = (sum(s.gross_salary for s in slips), sum(s.bonuses for s in slips))
        self.assertEqual(self.stories["bonusMonth"], "2026-09")
        self.assertGreater(totals[9][0], totals[8][0] * Decimal("1.08"), "September jumps")
        self.assertGreater(totals[9][1], 0)
        self.assertTrue(all(totals[m][1] == 0 for m in range(4, 9)), "no bonus before the bonus month")
        for m in range(5, 9):  # the rest drifts: neither flat nor wild
            change = abs(totals[m][0] / totals[m - 1][0] - 1)
            self.assertLess(change, Decimal("0.25"), (m, change))
        paid = sum(b.bonus_amount for b in Bonus.objects.filter(employee__employee_code__startswith="DM-"))
        self.assertEqual(paid, totals[9][1])

    def test_an_increment_starts_in_one_month_and_is_what_the_slips_show(self):
        month = self.stories["incrementMonth"]
        year, mon = (int(x) for x in month.split("-"))
        first = date(year, mon, 1)
        raises = SalaryIncrement.objects.filter(
            employee__employee_code__startswith="DM-", effective_date=first, employee__employment_type="staff"
        )
        self.assertGreater(raises.count(), 0)
        for inc in raises:
            before = SalarySlip.objects.filter(
                employee=inc.employee, year=add_months(first, -1).year, month=add_months(first, -1).month
            ).first()
            after = SalarySlip.objects.filter(employee=inc.employee, year=year, month=mon).first()
            if before is not None:
                self.assertEqual(
                    Decimal(str(before.breakdown_details["earnings"]["monthlySalary"])), inc.previous_salary
                )
            self.assertEqual(Decimal(str(after.breakdown_details["earnings"]["monthlySalary"])), inc.new_salary)
            if not SalaryIncrement.objects.filter(employee=inc.employee, effective_date__gt=first).exists():
                self.assertEqual(
                    inc.employee.salary_amount, inc.new_salary
                )  # no later change (a promotion) moved it again

    def test_joiners_and_leavers_are_paid_only_while_they_work(self):
        for emp in Employee.objects.filter(employee_code__startswith="DM-"):
            join = date.fromisoformat(emp.join_date)
            for slip in SalarySlip.objects.filter(employee=emp):
                end = slip.period_end or date(slip.year, slip.month, 28)
                self.assertGreaterEqual(end, join, (emp.employee_code, slip.slip_number))
        leaver = (
            Employee.objects.filter(employee_code__startswith="DM-", status="inactive")
            .exclude(updated_at__lt=common.at(date(2026, 4, 1), time(0, 0)))
            .first()
        )
        if leaver is not None:
            gone = leaver.updated_at.astimezone(common.FACTORY_TZ).date()
            self.assertFalse(SalarySlip.objects.filter(employee=leaver, period_start__gt=gone).exists())
            self.assertFalse(
                SalarySlip.objects.filter(
                    employee=leaver,
                    period_start__isnull=True,
                    year=gone.year + (gone.month == 12),
                    month=gone.month % 12 + 1,
                ).exists()
            )

    def test_advances_are_repaid_through_payroll_and_the_books_balance(self):
        advances = Advance.objects.filter(employee__employee_code__startswith="DM-")
        self.assertGreaterEqual(advances.count(), 3)
        for a in advances.filter(status__in=["approved", "closed"]):
            paid = sum(r.amount for r in a.repayments.filter(is_processed=True))
            self.assertEqual(a.total_repaid, paid)
            self.assertEqual(a.outstanding, a.amount - paid)
            self.assertEqual(sum(r.amount for r in a.repayments.all()), a.amount, "the schedule adds up to the advance")
        self.assertTrue(all(a.outstanding == 0 for a in advances.filter(status="closed")))
        in_slips = sum(s.advance_deduction for s in SalarySlip.objects.filter(payroll_run__isnull=False))
        in_runs = sum(r.amount for r in AdvanceRepayment.objects.filter(is_processed=True, payroll_run__isnull=False))
        self.assertEqual(in_slips, in_runs)

    def test_staff_overtime_pay_is_one_day_per_announced_pay_day(self):
        for slip in SalarySlip.objects.filter(
            employee__employee_code__startswith="DM-", period_start__isnull=True, ot_amount__gt=0
        )[:20]:
            days = OvertimeRecord.objects.filter(
                employee=slip.employee,
                date__year=slip.year,
                date__month=slip.month,
                status="announced",
                compensation_type="pay",
            ).count()
            daily = Decimal(str(slip.breakdown_details["earnings"]["dailyRate"]))
            self.assertEqual(slip.ot_amount, (daily * days).quantize(Decimal("0.01")), slip.slip_number)

    # --- recruitment ---

    def test_recruitment_has_positions_of_every_age_a_funnel_and_gaps(self):
        jobs = list(Job.objects.filter(description__endswith=common.DEMO_TAG))
        ages = sorted(
            (TODAY - j.created_at.astimezone(common.FACTORY_TZ).date()).days for j in jobs if j.status == "open"
        )
        self.assertGreaterEqual(len(jobs), 10)
        self.assertLess(ages[0], 14)
        self.assertGreaterEqual(ages[-1], 60, "a position open far too long")
        self.assertGreaterEqual(sum(a >= 45 for a in ages), 2)
        self.assertEqual(
            set(Applicant.objects.values_list("status", flat=True)), {"applied", "attended", "selected", "rejected"}
        )
        upcoming = [
            a
            for a in Applicant.objects.exclude(interview_date__isnull=True)
            if date.fromisoformat(a.interview_date) >= TODAY
        ]
        self.assertGreater(len(upcoming), 0, "interviews coming up")
        self.assertTrue(
            set(ScreeningCandidate.objects.values_list("status", flat=True))
            <= {"uploaded", "not_shortlisted", "shortlisted", "selected", "rejected"}
        )
        self.assertGreaterEqual(len(set(ScreeningCandidate.objects.values_list("status", flat=True))), 2)
        short = [
            hc
            for hc in DepartmentHeadcount.objects.select_related("department")
            if hc.required_count
            > Employee.objects.filter(department=hc.department, employment_type="staff", status="active").count()
        ]
        self.assertGreaterEqual(len(short), 3, "departments below their target headcount")

    def test_resignations_are_pending_recent_and_one_is_stuck(self):
        rows = ResignationRequest.objects.filter(employee__employee_code__startswith="DM-")
        waiting = rows.filter(status__in=["pending", "dept_approved"])
        self.assertGreaterEqual(waiting.count(), 1)
        self.assertGreaterEqual(
            max((common.at(TODAY, NOW) - r.created_at).days for r in waiting), 10, "one waits almost two weeks"
        )
        self.assertTrue(all(r.employee.employment_type == "staff" for r in rows), "only staff resign through the app")
        self.assertTrue(rows.filter(status="approved").exists())

    # --- activity ---

    def test_the_audit_trail_uses_the_applications_own_action_strings(self):
        rows = AuditLog.objects.filter(ip_address__startswith="10.77.") | AuditLog.objects.filter(
            ip_address__startswith="203.0.113."
        )
        self.assertGreater(rows.count(), 200)
        self.assertLessEqual(set(rows.values_list("action", flat=True)), KNOWN_ACTIONS)
        users = set(rows.values_list("user_name", flat=True))
        self.assertGreaterEqual(
            len(
                users
                & {"Priya Venkatesh", "Karthikeyan R", "Meenakshi S", "Arun Prakash", "Lakshmi Narayanan", "Ganesan P"}
            ),
            5,
        )
        self.assertTrue(
            all(r.user_id is None and r.user_type == "hr" for r in rows), "HR audit rows carry the name, not an id"
        )
        text = {a.record_description for a in rows.filter(action="login")}
        self.assertTrue(any(t.endswith("logged in") and "(hr_demo)" in t for t in text))
        window_start = TODAY - timedelta(days=29)
        joined = sum(1 for e in self.people.values() if window_start <= date.fromisoformat(e.join_date) <= TODAY)
        created = rows.filter(
            action="create", module="employees", record_description__startswith="Created employee DM-"
        ).count()
        self.assertTrue(
            joined - 1 <= created <= joined, (created, joined)
        )  # whoever joined inside the window was created by HR
        self.assertTrue(
            rows.filter(module="payroll", record_description__startswith="Generated staff payroll").exists()
        )
        self.assertTrue(
            rows.filter(module="reports", action="export", record_description__contains=" - XLSX - ").exists()
        )

    def test_sensitive_actions_after_hours_bursts_and_sign_ins(self):
        rows = AuditLog.objects.filter(ip_address__startswith="10.77.") | AuditLog.objects.filter(
            ip_address__startswith="203.0.113."
        )
        self.assertTrue(rows.filter(action="delete", module="employees").exists(), "a delete")
        self.assertTrue(rows.filter(action="lock", module="payroll").exists(), "a payroll run locked")
        self.assertTrue(rows.filter(action="approve", module="payroll").exists())
        self.assertTrue(
            rows.filter(module="user_management", record_description__startswith="Updated role:").exists(),
            "a role change",
        )
        self.assertTrue(rows.filter(module="settings").exists())
        local_hours = [
            a.created_at.astimezone(common.FACTORY_TZ).hour
            for a in rows.exclude(action__in=["login_failed", "login_blocked"])
        ]
        self.assertGreaterEqual(sum(h >= 21 or h < 6 for h in local_hours), 8, "after-hours bursts")
        failed = HrLoginAttempt.objects.filter(success=False, ip_address__startswith="203.0.113.")
        self.assertGreaterEqual(failed.count(), 5)
        self.assertTrue(
            rows.filter(action="login_blocked", record_description="Locked-out login attempt for: admin").exists()
        )
        self.assertGreater(LoginSession.objects.filter(hr_user__username__endswith="_demo").count(), 40)
        self.assertTrue(
            LoginSession.objects.filter(
                ip_address__startswith="203.0.113.", device_label="Chrome on Android 14"
            ).exists(),
            "a new device",
        )
        self.assertTrue(
            LoginSession.objects.exclude(revoked_at=None).exists()
            and LoginSession.objects.filter(revoked_at=None).exists()
        )
        self.assertEqual(HRUser.objects.get(username="hr_demo").last_login is not None, True)

    def test_no_demo_network_address_could_be_real(self):
        for ip in set(AuditLog.objects.filter(ip_address__isnull=False).values_list("ip_address", flat=True)) - {None}:
            if ip.startswith("10.77.") or ip.startswith(("203.0.113.", "198.51.100.")):
                continue
            self.fail(f"an address outside the demo ranges: {ip}")

    # --- valid for the application ---

    def test_the_applications_own_endpoints_run_on_it(self):
        h = hr_headers("hr_demo")
        urls = [
            "/api/employees?page=1&pageSize=20",
            "/api/departments",
            "/api/branches",
            "/api/shifts",
            "/api/holidays?year=2026",
            "/api/leave-requests",
            "/api/advances",
            "/api/salary-slips?month=9&year=2026",
            "/api/payroll?month=9&year=2026",
            "/api/payroll/production",
            "/api/jobs",
            "/api/applicants",
            "/api/recruitment/dashboard",
            "/api/recruitment/resignations",
            "/api/recruitment/department-headcount",
            "/api/recruitment/resume-screening/candidates?status=shortlisted",
            "/api/visitor/summary",
            "/api/visitor/records",
            "/api/outpass/summary",
            "/api/outpass-requests",
            "/api/tea-break/summary",
            "/api/tea-break/records",
            "/api/attendance/daily?date=2026-10-02",
            "/api/attendance/company-summary",
            "/api/dashboard/hr-summary",
            "/api/missing-punch-requests",
            "/api/casual-leaves",
            "/api/permissions",
        ]
        for url in urls:
            r = self.client.get(url, **h)
            self.assertEqual(r.status_code, 200, (url, r.content[:200]))
        page = self.client.get("/api/employees?page=1&pageSize=50", **h).json()
        self.assertGreaterEqual(page["count"], 60)

    def test_the_report_center_runs_on_it(self):
        h = hr_headers("hr_demo")
        window = "dateFrom=2026-09-01&dateTo=2026-09-30"
        for report in (
            "absenteeism",
            "late-coming-detail",
            "half-day",
            "department-strength",
            "perfect-attendance",
            "shift-roster",
        ):
            r = self.client.get(f"/api/reports/run/{report}?{window}", **h)
            self.assertEqual(r.status_code, 200, (report, r.content[:200]))
        r = self.client.get(f"/api/reports/run/absenteeism?{window}&includeNoAbsence=true", **h).json()
        self.assertGreater(len(r["rows"]), 0)

    def test_branch_isolation_applies_to_the_unit_level_hr_account(self):
        page = self.client.get("/api/employees?page=1&pageSize=100", **hr_headers("unit2hr_demo")).json()
        self.assertTrue(page["results"])
        self.assertEqual({e["branchName"] for e in page["results"]}, {"Unit 2 - Avinashi Road"})

    def test_the_md_portal_is_open_to_the_md_only(self):
        md = hr_headers("md_demo")
        me = self.client.get("/api/md/me", **md)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], "md_demo")
        org_ = self.client.get("/api/md/org", **md).json()
        self.assertTrue(
            {"Unit 1 - Kangeyam Road", "Unit 2 - Avinashi Road", "Unit 3 - Palladam Road"}
            <= {b["name"] for b in org_["branches"]}
        )
        self.assertTrue(any(d["name"] == "Washing" and d["employees"] >= 1 for d in org_["departments"]))
        self.assertEqual(self.client.get("/api/md/me", **hr_headers("hr_demo")).status_code, 403)

    def test_the_command_reports_what_it_made_and_how_to_sign_in(self):
        self.assertIn("Loaded", self.output)
        self.assertIn("Planted stories", self.output)
        self.assertIn("md_demo", self.output)
        self.assertNotIn(common.DEMO_PASSWORD, self.output, "the password is never echoed")
        self.assertEqual(self.manifest["database"], SAFE_NAME)
        self.assertTrue(self.manifest["rows"]["api.AttendanceDayRecord"])

    def test_a_second_run_changes_nothing(self):
        before = table_counts()
        out = run(*SMALL, manifest_dir=self.dir)
        self.assertIn("already holds the demo data", out)
        self.assertEqual(table_counts(), before)

    def test_the_same_seed_gives_the_same_company_and_another_seed_a_different_one(self):
        first = fingerprint()
        run("--reload", *SMALL, manifest_dir=self.dir)
        self.assertEqual(fingerprint(), first)
        other = [a if a != "42" else "43" for a in SMALL]
        run("--reload", *other, manifest_dir=self.dir)
        changed = fingerprint()
        self.assertNotEqual(changed["gross"], first["gross"])
        self.assertNotEqual(changed["statuses"], first["statuses"])


# ─── purge ────────────────────────────────────────────────────────────────────────────────────────────────────


class PurgeTests(TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        # rows that were there first: they must survive everything
        self.branch = Branch.objects.create(name="Pre Branch", code="PRE", location="Elsewhere")
        self.dept = Department.objects.create(name="Pre Department", branch=self.branch)
        self.emp = Employee.objects.create(
            employee_code="PRE-001",
            first_name="Pre",
            last_name="Existing",
            branch=self.branch,
            department=self.dept,
            status="active",
        )
        self.user = HRUser.objects.create(username="pre_user", password_hash="x", full_name="Pre User")
        self.visitor = Visitor.objects.create(name="Pre Visitor", phone="9000000099")
        self.audit = AuditLog.objects.create(
            user_name="Pre User",
            action="login",
            module="auth",
            record_description="Pre User logged in",
            ip_address="192.168.1.7",
        )
        self.run = PayrollRun.objects.create(run_code="PRE-RUN-1", month=3, year=2026)
        self.shift = ShiftTemplate.objects.create(
            name="Pre Shift", branch=self.branch, start_time=time(9), end_time=time(18)
        )
        self.head_office = Branch.objects.filter(is_head_office=True).order_by("id").first()
        self.seq_before = self.head_office.next_employee_seq
        self.before = table_counts()

    def assert_pre_existing_rows_intact(self):
        self.assertEqual(Employee.objects.get(pk=self.emp.pk).first_name, "Pre")
        self.assertEqual(Department.objects.get(pk=self.dept.pk).name, "Pre Department")
        self.assertEqual(HRUser.objects.get(pk=self.user.pk).username, "pre_user")
        self.assertEqual(Visitor.objects.get(pk=self.visitor.pk).phone, "9000000099")
        self.assertEqual(AuditLog.objects.get(pk=self.audit.pk).ip_address, "192.168.1.7")
        self.assertEqual(PayrollRun.objects.get(pk=self.run.pk).run_code, "PRE-RUN-1")
        self.assertEqual(ShiftTemplate.objects.get(pk=self.shift.pk).name, "Pre Shift")
        self.assertEqual(Branch.objects.get(pk=self.branch.pk).code, "PRE")
        self.assertTrue(Branch.objects.get(pk=self.head_office.pk).is_head_office)

    def test_purge_removes_everything_it_created_and_nothing_else(self):
        run(*TINY, manifest_dir=self.dir)
        grown = table_counts()
        self.assertGreater(grown["api.AttendanceDayRecord"], self.before["api.AttendanceDayRecord"])
        self.assertGreater(Branch.objects.get(pk=self.head_office.pk).next_employee_seq, self.seq_before)
        out = run("--purge", manifest_dir=self.dir)
        self.assertIn("removed", out)
        self.assertEqual(table_counts(), self.before, "every table is back to exactly what it was")
        self.assertEqual(
            Branch.objects.get(pk=self.head_office.pk).next_employee_seq, self.seq_before, "the unit-code counter too"
        )
        self.assert_pre_existing_rows_intact()
        self.assertEqual(purge.leftover_counts(), {k: 0 for k in purge.leftover_counts()})
        self.assertEqual(list(self.dir.glob("manifest-*.json")), [], "the record of created rows goes with them")
        self.assertFalse(PayrollSettings.objects.exists() and not self.before["api.PayrollSettings"])

    def test_pre_existing_settings_and_tea_rule_are_kept(self):
        PayrollSettings.objects.create(pk=1, company_name="Already Here")
        TeaBreakRule.objects.create(pk=1, allowed_minutes=20)
        out = run(*TINY, manifest_dir=self.dir)
        self.assertIn("already exists", out)
        self.assertEqual(TeaBreakRule.objects.get(pk=1).allowed_minutes, 20)
        run("--purge", manifest_dir=self.dir)
        self.assertEqual(PayrollSettings.objects.get(pk=1).company_name, "Already Here")
        self.assertEqual(TeaBreakRule.objects.get(pk=1).allowed_minutes, 20)

    def test_a_second_run_without_purge_adds_nothing_and_reload_starts_over(self):
        run(*TINY, manifest_dir=self.dir)
        once = table_counts()
        self.assertIn("already holds", run(*TINY, manifest_dir=self.dir))
        self.assertEqual(table_counts(), once)
        run("--reload", "--employees", "14", *TINY[2:], manifest_dir=self.dir)
        self.assertEqual(Employee.objects.filter(employee_code__startswith="DM-").count(), 14)
        run("--purge", manifest_dir=self.dir)
        self.assertEqual(table_counts(), self.before)

    def test_without_the_manifest_the_tagged_rows_still_go(self):
        run(*TINY, manifest_dir=self.dir)
        for path in self.dir.glob("manifest-*.json"):
            path.unlink()
        out = run("--purge", manifest_dir=self.dir)
        self.assertIn("No manifest", out)
        self.assertEqual(purge.leftover_counts(), {k: 0 for k in purge.leftover_counts()})
        self.assertEqual(Employee.objects.filter(employee_code__startswith="DM-").count(), 0)
        self.assertEqual(HRUser.objects.filter(username__endswith="_demo").count(), 0)
        self.assertEqual(Department.objects.filter(description__endswith=common.DEMO_TAG).count(), 0)
        self.assertEqual(GateDevice.objects.filter(username__startswith="dm-gate-").count(), 0)
        self.assert_pre_existing_rows_intact()

    def test_a_manifest_that_belongs_to_another_database_state_is_ignored(self):
        """Numbers in a stale manifest must never delete rows that merely have the same numbers."""
        stale = {
            "version": common.MANIFEST_VERSION,
            "database": SAFE_NAME,
            "fingerprint": {"mdUserId": 1, "mdCreatedAt": "2020-01-01T00:00:00+00:00"},
            "rows": {
                "api.Department": [[self.dept.pk, self.dept.pk]],
                "api.Branch": [[self.branch.pk, self.branch.pk]],
                "api.ShiftTemplate": [[self.shift.pk, self.shift.pk]],
                "api.Employee": [[self.emp.pk, self.emp.pk]],
            },
            "singletons": {},
            "branchSeq": {},
        }
        common.write_manifest(common.manifest_path(self.dir, SAFE_NAME), stale)
        out = run("--purge", manifest_dir=self.dir)
        self.assertIn("different database state", out)
        self.assert_pre_existing_rows_intact()
        self.assertEqual(table_counts(), self.before)

    def test_a_manifest_is_only_trusted_for_the_database_it_was_written_for(self):
        run(*TINY, manifest_dir=self.dir)
        manifest = common.read_manifest(common.manifest_path(self.dir, SAFE_NAME))
        self.assertTrue(purge.manifest_matches_database(manifest, SAFE_NAME))
        self.assertFalse(purge.manifest_matches_database(manifest, "another_e2e"))
        manifest["fingerprint"]["mdUserId"] += 1000
        self.assertFalse(purge.manifest_matches_database(manifest, SAFE_NAME))
        self.assertFalse(purge.manifest_matches_database(None, SAFE_NAME))
        run("--purge", manifest_dir=self.dir)

    def test_it_will_not_adopt_accounts_or_a_second_md_it_did_not_make(self):
        HRUser.objects.create(username="hr_demo", password_hash="x")
        with self.assertRaisesMessage(CommandError, "hr_demo"):
            run(*TINY, manifest_dir=self.dir)
        HRUser.objects.filter(username="hr_demo").delete()
        HRUser.objects.create(username="the_real_md", password_hash="x", is_md=True)
        with self.assertRaisesMessage(CommandError, "the_real_md"):
            run(*TINY, manifest_dir=self.dir)
        self.assertEqual(
            Employee.objects.filter(employee_code__startswith="DM-").count(), 0, "a refused load leaves nothing behind"
        )

    def test_a_failure_part_way_leaves_nothing_behind(self):
        with mock.patch(
            "api.management.commands.md_demo.recruitment.create_headcount_targets", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                run(*TINY, manifest_dir=self.dir)
        self.assertEqual(table_counts(), self.before)
        self.assertEqual(list(self.dir.glob("manifest-*.json")), [])


# ─── the pure parts ───────────────────────────────────────────────────────────────────────────────────────────


class HelperTests(SimpleTestCase):
    def test_allocation_adds_up_and_honours_minimums(self):
        self.assertEqual(common.allocate(10, [1, 1, 1]), [4, 3, 3])
        self.assertEqual(sum(common.allocate(157, [8, 30, 8, 6, 9, 2, 2, 2])), 157)
        self.assertGreaterEqual(common.allocate(10, [1, 1, 8], [3, 0, 0])[0], 3)
        self.assertEqual(
            sum(common.allocate(4, [1, 1, 1], [3, 3, 3])), 4, "minimums give way when there are too few people"
        )

    def test_manifest_ranges_round_trip(self):
        ids = [5, 6, 7, 20, 22, 23, 7]
        self.assertEqual(common.compress(ids), [[5, 7], [20, 20], [22, 23]])
        self.assertEqual(list(common.expand(common.compress(ids))), [5, 6, 7, 20, 22, 23])
        self.assertEqual(common.compress([]), [])

    def test_decisions_happen_in_office_hours_and_never_on_sunday(self):
        night = common.at(date(2026, 10, 6), time(1, 18))
        self.assertEqual(common.office_hours(night).time(), time(9, 18))
        evening = common.at(date(2026, 10, 3), time(19, 40))  # a Saturday evening: Sunday is off, so Monday
        moved = common.office_hours(evening)
        self.assertEqual((moved.date(), moved.time()), (date(2026, 10, 5), time(9, 40)))
        noon = common.at(date(2026, 10, 6), time(12, 5))
        self.assertEqual(common.office_hours(noon), noon)

    def test_the_plan_knows_its_closed_months_and_history(self):
        plan = common.Plan(seed=1, employees=30, days=30, today=date(2026, 1, 10), now=time(12, 0))
        self.assertEqual(plan.closed_months, [(2025, 7), (2025, 8), (2025, 9), (2025, 10), (2025, 11), (2025, 12)])
        self.assertEqual(plan.window_start, date(2025, 12, 12))
        self.assertEqual(plan.history_start, date(2025, 7, 1), "attendance reaches back to the first payroll month")
        long = common.Plan(seed=1, employees=30, days=400, today=date(2026, 1, 10), now=time(12, 0))
        self.assertEqual(long.history_start, long.window_start)

    def test_names_phones_and_addresses_are_unique_and_fictional(self):
        names = NameFactory(common.Streams(5)("n"))
        people = [names.person() for _ in range(300)]
        self.assertEqual(len({p.full for p in people}), 300)
        phones = {names.phone() for _ in range(300)}
        self.assertEqual(len(phones), 300)
        self.assertTrue(all(p.startswith("9") and len(p) == 10 for p in phones))
        self.assertTrue(names.email(people[0]).endswith("@uktextiles.example"))

    def test_streams_are_independent_and_repeatable(self):
        a, b = common.Streams(42), common.Streams(42)
        self.assertEqual([a("x").random() for _ in range(3)], [b("x").random() for _ in range(3)])
        self.assertNotEqual(a("x").random(), a("y").random())
        self.assertNotEqual(common.Streams(43)("x").random(), a("x").random())

    def test_the_demo_calendar_is_tamil_nadus(self):
        calendar = org.holiday_dates(date(2026, 4, 1), date(2026, 10, 31))
        self.assertEqual(calendar[date(2026, 4, 14)][0], "Tamil New Year")
        self.assertEqual(calendar[date(2026, 10, 2)][0], "Gandhi Jayanthi")
        self.assertEqual(calendar[date(2026, 9, 14)][0], "Vinayagar Chathurthi")  # a Monday: the day after is a spike

    def test_department_tables_are_consistent(self):
        for unit, specs in org.DEPARTMENTS.items():
            if unit != "HO":
                self.assertTrue(6 <= len(specs) <= 9, unit)
            for spec in specs:
                titles = org.designations_for(unit, spec.name)
                self.assertTrue(any(d.head for d in titles), f"{unit} {spec.name} has a head")
                if spec.prod_weight:
                    self.assertTrue(any(d.kind == "production" for d in titles))
                if spec.staff_weight:
                    self.assertTrue(any(d.kind == "staff" for d in titles))


class VerdictTests(TestCase):
    """The verdict helpers on hand-made punches: what a dashboard should make of a day."""

    def setUp(self):
        self.settings = PayrollSettings.get()
        self.shift = ShiftTemplate(
            name="Office",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
        )

    def day(self, *clock, perms=()):
        return staff_verdict(self.settings, self.shift, [time(*c) for c in clock], list(perms))

    def test_a_full_day_on_time(self):
        d = self.day((8, 55), (13, 0, 10), (13, 50), (18, 5))
        self.assertEqual(
            (d.status, d.shifts, d.is_late, d.arrival_zone, len(d.punches)),
            ("present", Decimal("1.00"), False, "on_time", 4),
        )
        self.assertEqual(
            d.ot_minutes, 5
        )  # the last punch is five minutes past the end: not overtime (the threshold is 60)

    def test_late_quarter_and_second_half_arrivals(self):
        late = self.day((9, 40), (13, 0), (13, 50), (18, 5))
        self.assertEqual(
            (late.status, late.shifts, late.is_late, late.arrival_zone), ("present", Decimal("1.00"), True, "late")
        )
        self.assertTrue(late.late_reason.startswith("Morning Late-In"))
        quarter = self.day((10, 40), (13, 0), (13, 50), (18, 5))
        self.assertEqual(
            (quarter.status, quarter.shifts, quarter.is_late, quarter.arrival_zone),
            ("present", Decimal("0.75"), False, "quarter"),
        )
        second = self.day((12, 30), (18, 0))
        self.assertEqual(
            (second.status, second.shifts, second.arrival_zone), ("half_shift", Decimal("0.50"), "second_half")
        )

    def test_a_missing_evening_punch_makes_a_half_day_and_overtime_is_minutes_past_the_end(self):
        d = self.day((8, 55), (13, 0), (13, 50))
        self.assertEqual((d.status, d.shifts, d.first_punch), ("half_shift", Decimal("0.50"), time(8, 55)))
        ot = self.day((8, 55), (13, 0), (13, 50), (19, 30))
        self.assertEqual(ot.ot_minutes, 90)

    def test_a_permission_excuses_a_late_arrival_and_is_remembered(self):
        d = self.day((10, 5), (13, 0), (13, 50), (18, 5), perms=["morning_late_in"])
        self.assertEqual(
            (d.arrival_zone, d.is_late, d.morning_permission_applied, d.status), ("excused", False, True, "present")
        )
        self.assertIn("Approved Morning Late-In permission", d.late_reason)

    def test_a_slow_return_from_lunch_is_night_late_but_costs_nothing(self):
        d = self.day((8, 55), (13, 0), (14, 20), (18, 5))
        self.assertTrue(d.late_afternoon)
        self.assertEqual((d.status, d.shifts), ("present", Decimal("1.00")))

    def test_production_shifts_come_from_the_segments_a_worked_span_covers(self):
        config = ProductionShiftConfig()
        segments = list(ProductionShiftSegment.objects.filter(is_active=True))
        full = production_verdict(config, segments, [time(8, 28), time(12, 45), time(13, 30), time(17, 35)])
        self.assertEqual((full.status, full.shifts, full.is_late), ("present", Decimal("1.00"), False))
        extra = production_verdict(config, segments, [time(8, 28), time(12, 45), time(13, 30), time(20, 0)])
        self.assertEqual(extra.shifts, Decimal("1.50"))
        late = production_verdict(config, segments, [time(8, 50), time(12, 45), time(13, 30), time(17, 35)])
        self.assertEqual((late.status, late.shifts, late.is_late), ("half_shift", Decimal("0.75"), True))
        self.assertEqual(production_verdict(config, segments, [time(8, 30)]).first_punch, time(8, 30))
