"""
Report Center - attendance_core reports: time-card, daily-attendance, absentee-list-daily,
attendance-muster-sheet, attendance-summary-monthly, punch-log, punch-exceptions, unmatched-punches,
manual-overrides.

Run via: python manage.py test api.tests_reporting_attendance_core -v 2

Every date is in August 2026 (a month that is already over: "today" is patched to 2026-09-05), so nothing
depends on the real clock. Shift 09:00-18:00, 15 min grace, first half ends 13:30, lunch 60 min; the
half-day cut-offs are at their defaults (13:30 / 14:30); Early-Out detection is switched ON.

Calendar used (2026): Mon 3, Tue 4, Wed 5, Thu 6 (company holiday), Fri 7, Sat 8, Sun 9, Mon 10.
"""

import io
from datetime import date, datetime, time, timezone
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .attendance_final import _holiday_dates_for_month, compute_range_records
from .jwt_utils import sign_token
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    DailyShiftLog,
    Department,
    Designation,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveRequest,
    LeaveType,
    PayrollSettings,
    ResignationRequest,
    Role,
    ShiftTemplate,
    UnmatchedPunch,
)
from .reporting import registry

IDS = [
    "time-card", "daily-attendance", "absentee-list-daily", "attendance-muster-sheet",
    "attendance-summary-monthly", "punch-log", "punch-exceptions", "unmatched-punches", "manual-overrides",
]
TODAY = date(2026, 9, 5)
PERIOD = {"dateFrom": "2026-08-03", "dateTo": "2026-08-10"}
SRC = "biometric:adms:SN1"


def d(day: int) -> date:
    return date(2026, 8, day)


def tm(text: str) -> time:
    parts = [int(x) for x in text.split(":")]
    return time(*parts)


def punch(emp, day: date, *times: str, source: str = SRC) -> None:
    for text in times:
        AttendanceLog.objects.create(employee=emp, date=day, punch_time=tm(text), punch_type="IN", source=source)


def hr_headers(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def seed_records(emp, first: date, last: date) -> None:
    """Persist the engine's verdicts the way opening the Attendance screens does (test set-up only)."""
    with mock.patch("api.attendance_final.ist_today", return_value=TODAY):
        compute_range_records(emp, first, last, PayrollSettings.get())


class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        _holiday_dates_for_month.cache_clear()
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.save()

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.cutting = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.sewing = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.packing = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.cutter = Designation.objects.create(title="Cutter")
        cls.tailor = Designation.objects.create(title="Tailor")

        cls.shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30), lunch_duration_minutes=60,
        )

        def mk(code, first, dept, branch, desig=None, **kw):
            emp = Employee.objects.create(
                employee_code=code, first_name=first, last_name="T", department=dept, branch=branch,
                designation=desig, **kw,
            )
            return emp

        cls.alice = mk("AC001", "Alice", cls.cutting, cls.b1, cls.cutter, employment_type="staff")
        cls.bob = mk("AC002", "Bob", cls.cutting, cls.b1, cls.cutter, employment_type="staff")
        cls.carol = mk("AC003", "Carol", cls.sewing, cls.b1, cls.tailor, employment_type="staff")
        cls.pat = mk("AC004", "Pat", cls.sewing, cls.b1, cls.tailor, employment_type="production")
        cls.zed = mk("AC005", "Zed", cls.packing, cls.b2, None, employment_type="staff")
        cls.leo = mk("AC006", "Leo", cls.cutting, cls.b1, cls.cutter, employment_type="staff", status="inactive")
        for emp in (cls.alice, cls.bob, cls.zed, cls.leo):
            EmployeeShiftAssignment.objects.create(employee=emp, shift=cls.shift, effective_from=date(2020, 1, 1))
        # Carol's schedule has Saturdays off (payroll's rule; the engine itself stores such a Saturday as absent)
        EmployeeShiftAssignment.objects.create(
            employee=cls.carol, shift=cls.shift, effective_from=date(2020, 1, 1), saturday_off=True
        )

        Holiday.objects.create(name="Test Holiday", date=d(6))

        # ── raw punches ──────────────────────────────────────────────────────
        punch(cls.alice, d(3), "08:55", "13:00", "13:45", "18:05")
        punch(cls.bob, d(3), "09:40", "18:10")
        punch(cls.pat, d(3), "08:30", "12:45", "13:30", "20:00")
        punch(cls.zed, d(3), "09:00", "18:00", source="geo:auto")
        punch(cls.leo, d(3), "09:00", "18:00", source="on_duty:approved")
        punch(cls.alice, d(4), "09:10")
        punch(cls.bob, d(4), "09:00", "19:30")
        punch(cls.carol, d(4), "09:00", "15:00")
        punch(cls.pat, d(4), "08:50", "20:00")
        punch(cls.alice, d(5), "09:00", "09:02", "13:00", "13:45", "18:00", "18:01")
        punch(cls.bob, d(5), "09:00", "13:00")
        punch(cls.bob, d(5), "18:00", source="manual:punch-view")
        punch(cls.carol, d(7), "15:00")
        punch(cls.bob, d(10), "10:00", "18:00", source="missing_punch:approved")

        # ── leave, permission, casual leave, legacy presence ─────────────────
        sl, _ = LeaveType.objects.get_or_create(code="SL", defaults={"name": "Sick Leave"})
        LeaveRequest.objects.create(
            employee=cls.carol, leave_type_ref=sl, type="sick", start_date="2026-08-05", end_date="2026-08-05",
            total_days=1, status="approved",
        )
        EmployeePermission.objects.create(
            employee=cls.bob, date=d(10), permission_time=time(9, 0), status="approved", type="morning_late_in",
            duration_minutes=60,
        )
        CasualLeaveRequest.objects.create(employee=cls.carol, date=d(10), status="approved")
        Attendance.objects.create(employee=cls.zed, date="2026-08-07", present=True)

        # ── frozen manual days (written before the range is computed, which never touches them) ──
        def frozen(emp, day, by, note, first=None, last=None):
            return AttendanceDayRecord.objects.create(
                employee=emp, date=day, status="present", shifts_earned="1.00", source="manual",
                override_by=by, override_note=note, first_punch=first, last_punch=last,
            )

        frozen(cls.alice, d(10), "HR Anita", "Missed punch due to power cut", time(9, 0), time(18, 0))
        frozen(cls.carol, d(10), "HOD Meena", "Casual Leave (paid) -approved")
        frozen(cls.pat, d(10), "HR Anita", "Compensation Alternative Day (paid) -redeemed")

        for emp in (cls.alice, cls.bob, cls.carol, cls.pat, cls.zed, cls.leo):
            seed_records(emp, d(3), d(10))

        # HR's Informed call on absent days
        AttendanceDayRecord.objects.filter(employee=cls.carol, date=d(3)).update(is_informed=True)
        AttendanceDayRecord.objects.filter(employee=cls.zed, date=d(5)).update(is_informed=False)

        # ── override requests (attendance date d; created / reviewed stamps are UTC and shown in IST) ──
        def utc(day, hour, minute=0):
            return datetime(2026, 8, day, hour, minute, tzinfo=timezone.utc)

        def before(status="absent", shifts="0.00"):
            return {"status": status, "isLate": False, "isEarlyOut": False, "isHalfShift": False,
                    "firstPunch": None, "lastPunch": None, "shiftsEarned": shifts}

        def after(status="present", shifts="1.00", first="09:00", last="18:00", note=None):
            return {"status": status, "isLate": False, "isEarlyOut": False, "isHalfShift": False,
                    "firstPunch": first, "lastPunch": last, "shiftsEarned": shifts, "note": note}

        def request(emp, day, status, by, created, **kw):
            req = AttendanceOverrideRequest.objects.create(
                employee=emp, date=day, status=status, requested_by=by, **kw
            )
            AttendanceOverrideRequest.objects.filter(pk=req.pk).update(created_at=created)
            return req

        cls.req_approved = request(
            cls.alice, d(10), "approved", "HR Anita", utc(10, 3, 30), previous_values=before(),
            requested_values=after(note="Missed punch due to power cut"), reason="Missed punch due to power cut",
            reviewed_by="HOD Ravi", review_comment="Verified with gate", reviewed_at=utc(11, 5, 0),
        )
        cls.req_pending = request(
            cls.bob, d(7), "pending", "HR Anita", utc(8, 4, 0), previous_values=before(),
            requested_values=after(status="half_shift", shifts="0.50", first="09:00", last=None), reason="Left after lunch",
        )
        cls.req_rejected = request(
            cls.zed, d(8), "rejected", "HR Kumar", utc(9, 4, 0), previous_values=before(),
            requested_values=after(), reason="Sat work", reviewed_by="HOD Sita", review_comment="No evidence",
            reviewed_at=utc(9, 9, 0),
        )
        cls.req_other_branch = request(
            cls.zed, d(9), "pending", "HR Kumar", utc(9, 5, 0), previous_values=before(), requested_values=after(),
            reason="Sunday shift",
        )

        # ── device IDs that match no employee (stamps are UTC; shown in IST) ──
        def unmatched(uid, serial, label, count, last_date, resolved=False, note=""):
            row = UnmatchedPunch.objects.create(
                device_user_id=uid, device_serial=serial, device_label=label, punch_count=count,
                last_punch_date=last_date, last_punch_time=time(9, 5, 7), resolved=resolved, resolved_note=note,
            )
            UnmatchedPunch.objects.filter(pk=row.pk).update(
                first_seen_at=utc(1, 4, 0), last_seen_at=utc(last_date.day, 4, 0)
            )
            return row

        unmatched("9001", "SN-A", "Gate A", 12, d(3))
        unmatched("9002", "", "", 5, date(2026, 9, 2))
        unmatched(cls.leo.employee_code, "SN-A", "Gate A", 3, d(3))
        unmatched("9003", "SN-B", "Gate B", 7, d(4), resolved=True, note="Test device")

        # ── users ────────────────────────────────────────────────────────────
        cls.admin = HRUser.objects.create(username="ac_admin", password_hash="x", is_super_admin=True)
        cls.role_ok = Role.objects.create(name="ac_ok", permissions={"reports": "view", "attendance": "view"})
        cls.branch_user = HRUser.objects.create(username="ac_b1", password_hash="x", role=cls.role_ok, branch=cls.b1)
        cls.no_module = HRUser.objects.create(
            username="ac_none", password_hash="x", role=Role.objects.create(name="ac_none", permissions={"reports": "view"})
        )

    @classmethod
    def tearDownClass(cls):
        _holiday_dates_for_month.cache_clear()
        super().tearDownClass()

    def setUp(self):
        patcher = mock.patch("api.reporting.filters.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)
        _holiday_dates_for_month.cache_clear()
        self._registered = []

    def tearDown(self):
        for rid in self._registered:
            registry._REGISTRY.pop(rid, None)

    # -- helpers ---------------------------------------------------------------
    def get(self, path, user=None, **params):
        return self.client.get(path, params, **hr_headers(user or self.admin))

    def run_report(self, rid, user=None, **params):
        r = self.get(f"/api/reports/run/{rid}", user, **params)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def export(self, rid, fmt, user=None, **params):
        return self.get(f"/api/reports/export/{rid}", user, fmt=fmt, **params)

    def codes(self, body, key="employeeCode"):
        return [r[key] for r in body["rows"] if not r.get("_kind")]

    def data_rows(self, body):
        return [r for r in body["rows"] if not r.get("_kind")]

    def row(self, body, code, date_iso=None):
        for r in body["rows"]:
            if r.get("_kind"):
                continue
            if r.get("employeeCode") == code and (date_iso is None or r.get("date") == date_iso):
                return r
        raise AssertionError(f"no row for {code} {date_iso}")


class SmokeTests(Base):
    def test_every_report_is_registered_and_well_formed(self):
        registry.all_specs()
        self.assertEqual(registry.LOAD_ERRORS, {})
        for rid in IDS:
            spec = registry.get_spec(rid)
            self.assertIsNotNone(spec, rid)
            self.assertEqual(spec.category, "attendance")
            self.assertEqual(spec.modules, ("attendance",))

    def test_every_report_runs_and_exports_for_admin(self):
        for rid in IDS:
            body = self.run_report(rid, **PERIOD, period="2026-08")
            self.assertIn("columns", body, rid)
            for fmt, sig in (("xlsx", b"PK"), ("pdf", b"%PDF")):
                r = self.export(rid, fmt, **PERIOD, period="2026-08")
                self.assertEqual(r.status_code, 200, f"{rid} {fmt}: {r.content[:200]}")
                self.assertTrue(r.content.startswith(sig), f"{rid} {fmt}")



class DebugDump(Base):
    def test_dump(self):
        def show(rid, **params):
            body = self.run_report(rid, **params)
            print("\n=====", rid, params)
            print("SUMMARY", [(x["label"], x["value"]) for x in body["summary"]])
            print("TOTALS", body["totals"])
            for n in body["notes"]:
                print("NOTE", n)
            for r in body["rows"]:
                print({k: v for k, v in r.items() if v is not None})

        show("punch-log", dateFrom="2026-08-05", dateTo="2026-08-05")
        show("punch-log", dateFrom="2026-08-05", dateTo="2026-08-05", source="manual")
        show("punch-log", dateFrom="2026-08-03", dateTo="2026-08-05", punchPosition="last")
        show("punch-exceptions", **PERIOD)
        show("unmatched-punches")
        show("unmatched-punches", resolved="resolved")
        show("manual-overrides", dateFrom="2026-08-01", dateTo="2026-08-31")
