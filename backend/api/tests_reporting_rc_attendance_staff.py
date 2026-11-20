"""
Report Center 2026-11-19 layout, Attendance category, staff slice: staff-attendance-report, staff-time-card-report,
time-card-shift-count, late-detection, monthly-misspunch, attendance-log-report.

The week Mon 2 - Sun 8 November 2026 ("today" is pinned to Tue 10 Nov). Shift General 09:00-18:00, 10 min grace.
Staff day records are seeded as the engine stores them (the reports read stored verdicts, never compute); the
production days are computed by the engine itself (``compute_day_record``) under the shift table, in force from 1 Oct.

    ALICE (staff)  Mon on time P | Tue quarter-shift arrival P 0.75 | Wed Penalty Early Out P 0.75 | Thu Late P
                   Fri company holiday | Sat absent | Sun weekly off
    BOB   (staff)  Mon second-half arrival, single punch, half day + a pending Missing Punch request
                   Tue full-day CL | Wed on-duty | Thu half-day CL (other half worked) | Sat odd biometric punches made
                   whole by an approved Missing Punch request
    NEWBIE (staff) joins Thu 5 Nov (the stored absences before that are outside service)
    CAROL (staff, other branch) Mon arrival excused by a permission
    NIGHT (production, join date stored as Excel-serial text) Mon 21:00 -> Tue 05:30 night shift
    DAYW  (production) Mon 08:30-20:00 (1.50), Wed three punches (odd), Thu a stored 2.72 (before the quarter rule)

Run via: python manage.py test api.tests_reporting_rc_attendance_staff -v 2
"""

import importlib
import io
from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .attendance_final import _holiday_dates_for_month, compute_day_record
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Department,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    MissingPunchRequest,
    PayrollSettings,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    Role,
    ShiftTemplate,
)
from .reporting import registry
from .reporting.export_xlsx import HEADER_ROW
from .reporting.layout import LAYOUT

TODAY = date(2026, 11, 10)
MON = date(2026, 11, 2)
TUE, WED, THU, FRI, SAT, SUN = (MON + timedelta(days=i) for i in range(1, 7))
WEEK = {"dateFrom": MON.isoformat(), "dateTo": SUN.isoformat()}
SRC = "biometric:adms:SN1"

GRID = "staff-attendance-report"
CARD = "staff-time-card-report"
COUNT = "time-card-shift-count"
LATE = "late-detection"
MISS = "monthly-misspunch"
LOG = "attendance-log-report"
IDS = (GRID, CARD, COUNT, LATE, MISS, LOG)


def hdr(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def punch(emp, day: date, *times: str, source: str = SRC) -> None:
    for text in times:
        hh, mm = (int(x) for x in text.split(":"))
        AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(hh, mm), punch_type="IN", source=source)


def tm(text: str | None):
    if text is None:
        return None
    hh, mm = (int(x) for x in text.split(":"))
    return time(hh, mm)


def day_rec(emp, day, status, shifts, *, first=None, last=None, n=0, **kw):
    kw.setdefault("primary_source", "Biometric" if n else None)
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=day,
        status=status,
        shifts_earned=Decimal(str(shifts)),
        first_punch=tm(first),
        last_punch=tm(last),
        total_punches=n,
        is_half_shift=status == "half_shift",
        **kw,
    )


def _ensure_production_seed():
    """The migration seeds the production shift groups and breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)


class _World(TestCase):
    @classmethod
    def setUpTestData(cls):
        _holiday_dates_for_month.cache_clear()
        _ensure_production_seed()
        config = ProductionShiftConfig.get()
        config.rules_effective_from = date(2026, 10, 1)
        config.save()
        ps = PayrollSettings.get()
        ps.morning_late_in_enabled = True
        ps.save()

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.cutting = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.stitch = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.packing = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.cutter = Designation.objects.create(title="Cutter")
        cls.shift = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
        )
        Holiday.objects.create(name="Company Day", date=FRI)

        def staff(code, first, dept, branch, join="2026-01-05", **kw):
            emp = Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="T",
                department=dept,
                branch=branch,
                designation=cls.cutter,
                employment_type="staff",
                join_date=join,
                **kw,
            )
            EmployeeShiftAssignment.objects.create(employee=emp, shift=cls.shift, effective_from=date(2026, 1, 1))
            return emp

        def production(code, first, join):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="W",
                department=cls.stitch,
                branch=cls.b1,
                employment_type="production",
                join_date=join,
            )

        cls.alice = staff("S001", "Alice", cls.cutting, cls.b1)
        cls.bob = staff("S002", "Bob", cls.cutting, cls.b1)
        cls.newbie = staff("S003", "Newbie", cls.cutting, cls.b1, join="2026-11-05")
        cls.carol = staff("S004", "Carol", cls.packing, cls.b2)
        cls.gone = staff("S005", "Gone", cls.cutting, cls.b1, status="inactive")
        cls.night = production("P001", "Night", "01-01-45640")  # Excel-serial text, as the production rows hold it
        cls.dayw = production("P002", "Dayw", "2024-02-01")

        # ── ALICE ────────────────────────────────────────────────────────────
        a = cls.alice
        punch(a, MON, "08:55", "18:05")
        day_rec(a, MON, "present", 1, first="08:55", last="18:05", n=2, arrival_zone="on_time")
        punch(a, TUE, "10:30", "18:05")
        day_rec(
            a,
            TUE,
            "present",
            "0.75",
            first="10:30",
            last="18:05",
            n=2,
            arrival_zone="quarter",
            late_reason="Quarter-shift arrival: first punch 10:30 is after the Late window ended (10:10): 0.25 shift "
            "deducted; not counted as Late",
        )
        punch(a, WED, "08:58", "16:30")
        day_rec(
            a,
            WED,
            "present",
            "0.75",
            first="08:58",
            last="16:30",
            n=2,
            arrival_zone="on_time",
            penalty_early_out=True,
            penalty_deduction=Decimal("0.25"),
            early_out_minutes=90,
        )
        punch(a, THU, "09:30", "18:02")
        day_rec(a, THU, "present", 1, first="09:30", last="18:02", n=2, arrival_zone="late", is_late=True)
        day_rec(a, FRI, "holiday", 0)
        day_rec(a, SAT, "absent", 0)
        day_rec(a, SUN, "holiday", 0)

        # ── BOB ──────────────────────────────────────────────────────────────
        b = cls.bob
        punch(b, MON, "14:00")
        day_rec(b, MON, "half_shift", "0.5", first="14:00", n=1, arrival_zone="second_half")
        MissingPunchRequest.objects.create(
            employee=b,
            date=MON,
            punch_time=time(9, 0),
            punch_type="IN",
            punch_slot="morning_in",
            reason="Forgot",
            status="pending_hod",
        )
        CasualLeaveRequest.objects.create(employee=b, date=TUE, status="approved", portion="full")
        day_rec(b, TUE, "present", 1, source="manual", override_note="Casual Leave (paid) - approved")
        punch(b, WED, "09:00", "18:00", source="on_duty:approved")
        day_rec(
            b, WED, "present", 1, first="09:00", last="18:00", n=2, arrival_zone="on_time", primary_source="On-Duty"
        )
        CasualLeaveRequest.objects.create(employee=b, date=THU, status="approved", portion="first_half")
        punch(b, THU, "13:30", "18:00")
        day_rec(b, THU, "present", 1, first="13:30", last="18:00", n=2, arrival_zone="second_half")
        day_rec(b, FRI, "holiday", 0)
        punch(b, SAT, "09:00", "13:00", "14:00")
        punch(b, SAT, "18:00", source="missing_punch:approved")
        day_rec(b, SAT, "present", 1, first="09:00", last="18:00", n=4, arrival_zone="on_time")
        MissingPunchRequest.objects.create(
            employee=b,
            date=SAT,
            punch_time=time(18, 0),
            punch_type="OUT",
            punch_slot="evening_out",
            reason="Forgot",
            status="approved",
        )
        day_rec(b, SUN, "holiday", 0)

        # ── NEWBIE: the engine stored absences before the joining date ───────
        n = cls.newbie
        for d in (MON, TUE, WED):
            day_rec(n, d, "absent", 0)
        punch(n, THU, "08:59", "18:00")
        day_rec(n, THU, "present", 1, first="08:59", last="18:00", n=2, arrival_zone="on_time")
        day_rec(n, FRI, "holiday", 0)
        punch(n, SAT, "08:59", "18:00")
        day_rec(n, SAT, "present", 1, first="08:59", last="18:00", n=2, arrival_zone="on_time")
        day_rec(n, SUN, "holiday", 0)

        # ── CAROL (Unit 2): an arrival an approved permission excused ────────
        punch(cls.carol, MON, "10:00", "18:00")
        day_rec(
            cls.carol,
            MON,
            "present",
            1,
            first="10:00",
            last="18:00",
            n=2,
            arrival_zone="excused",
            morning_permission_applied=True,
        )

        # ── production, judged by the engine itself ──────────────────────────
        def at(emp, day, *hms):
            for hh, mm, ss in hms:
                AttendanceLog.objects.create(
                    employee=emp, date=day, punch_time=time(hh, mm, ss), punch_type="IN", source="biometric:dev1"
                )

        at(cls.night, MON, (21, 0, 5))
        at(cls.night, TUE, (5, 30, 10))
        at(cls.dayw, MON, (8, 29, 40), (12, 45, 5), (13, 30, 10), (20, 0, 3))
        at(cls.dayw, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0))
        at(cls.dayw, THU, (8, 30, 0), (22, 0, 0))
        with mock.patch("api.attendance_final.ist_today", return_value=TODAY):
            for emp in (cls.night, cls.dayw):
                for i in range(7):
                    d = MON + timedelta(days=i)
                    if emp is cls.dayw and d == THU:
                        continue
                    compute_day_record(emp, d)
        # a production day stored before the quarter rule (2.72 is off the 0.25 grid): shown as stored, flagged
        day_rec(cls.dayw, THU, "present", "2.72", first="08:30", last="22:00", n=2, primary_source="Biometric")

        # ── users ────────────────────────────────────────────────────────────
        cls.admin = HRUser.objects.create(username="rc_att_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.att_user = user("rc_att_viewer", {"attendance": "view"})
        cls.branch_user = user("rc_att_branch", {"attendance": "view"}, branch=cls.b1)
        cls.reports_only = user("rc_att_reports_only", {})

    def setUp(self):
        p = mock.patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    # helpers ------------------------------------------------------------------
    def get(self, rid, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r.json()

    def export(self, rid, fmt, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r

    @staticmethod
    def data(body) -> list[dict]:
        return [r for r in body["rows"] if not r.get("_kind")]

    def by_day(self, body) -> dict:
        return {(r["employeeCode"], r["date"]): r for r in self.data(body)}

    @staticmethod
    def summary(body) -> dict:
        return {s["label"]: s["value"] for s in body["summary"]}


# ═════════════════════════════════════════════════════════════════════════════
class RegistrationTests(_World):
    def test_ids_categories_and_layout_order(self):
        self.assertEqual(registry.LOAD_ERRORS, {})
        for rid in IDS:
            spec = registry.get_spec(rid)
            self.assertIsNotNone(spec, rid)
            self.assertEqual(spec.category, "attendance")
            self.assertEqual(spec.modules, ("attendance",))
            self.assertIn(rid, LAYOUT["attendance"])
            self.assertLessEqual(len(spec.filters), 8, rid)
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        listed = [r["id"] for r in body["reports"] if r["category"] == "attendance"]
        mine = [rid for rid in LAYOUT["attendance"] if rid in IDS]
        self.assertEqual([rid for rid in listed if rid in IDS], mine)

    def test_every_report_runs_on_its_defaults(self):
        for rid in IDS:
            with self.subTest(report=rid):
                body = self.get(rid)
                self.assertIsInstance(body["rows"], list)
                self.assertLessEqual(len(body["summary"]), 6)

    def test_access_needs_the_attendance_module(self):
        for rid in IDS:
            with self.subTest(report=rid):
                self.get(rid, user=self.att_user, **WEEK)
                r = self.client.get(f"/api/reports/run/{rid}", WEEK, **hdr(self.reports_only))
                self.assertEqual(r.status_code, 403, r.content[:200])

    def test_xlsx_and_pdf_build_and_match_the_screen(self):
        for rid in IDS:
            with self.subTest(report=rid):
                params = {**WEEK, "period": "2026-11"}
                if rid == COUNT:
                    params["staffType"] = "all"
                screen = self.get(rid, **params)
                x = self.export(rid, "xlsx", **params)
                self.assertTrue(x.content.startswith(b"PK"))
                ws = load_workbook(io.BytesIO(x.content)).active
                header = [c.value for c in ws[HEADER_ROW]]
                self.assertEqual(header[: len(screen["columns"])], [c["label"] for c in screen["columns"]])
                p = self.export(rid, "pdf", **params)
                self.assertTrue(p.content.startswith(b"%PDF"))

    def test_bad_filters_are_400(self):
        self.get(GRID, expect=400, dateFrom="2026-10-01", dateTo="2026-11-30")  # over 31 days
        self.get(LATE, expect=400, arrival="nonsense", **WEEK)
        self.get(MISS, expect=400, period="2026-13")
        self.get(COUNT, expect=400, staffType="contract", **WEEK)


# ═════════════════════════════════════════════════════════════════════════════
class StaffAttendanceGridTests(_World):
    def rows(self, **extra):
        body = self.get(GRID, **WEEK, **extra)
        return body, {r["employeeCode"]: r for r in self.data(body)}

    def test_cells_show_quarter_penalty_holiday_and_weekly_off(self):
        _body, rows = self.rows()
        a = rows["S001"]
        cells = [a[f"d{(MON + timedelta(days=i)).strftime('%Y%m%d')}"] for i in range(7)]
        self.assertEqual(cells, ["P", "P¾", "P¾", "P", "H", "A", "WO"])

    def test_alice_totals_and_eff_from_shifts_earned(self):
        _body, rows = self.rows()
        a = rows["S001"]
        self.assertEqual(
            (a["present"], a["half"], a["absent"], a["leave"], a["off"], a["late"], a["quarter"], a["penaltyEo"]),
            (4, 0, 1, 0, 2, 1, 1, 1),
        )
        self.assertEqual(a["workingDays"], 5)  # Mon-Thu + Sat; Fri is a holiday, Sun a weekly off
        # Shifts paid, as staff payroll pays these dates: 3.5 earned on the working days + Friday's declared holiday
        self.assertEqual((a["shifts"], a["offDayShifts"]), (4.5, 0.0))
        self.assertEqual(a["attendancePct"], 70.0)  # 3.5 / 5, the quarter and penalty days count 0.75

    def test_bob_casual_leave_on_duty_and_second_half(self):
        _body, rows = self.rows()
        b = rows["S002"]
        cells = [b[f"d{(MON + timedelta(days=i)).strftime('%Y%m%d')}"] for i in range(7)]
        self.assertEqual(cells, ["½E", "CL", "OD", "CL½", "H", "P", "WO"])
        self.assertEqual((b["present"], b["half"], b["casualLeave"], b["onDuty"]), (3, 1, 1.5, 1))
        self.assertEqual(b["shifts"], 5.5)  # 4.5 earned on the working days + the paid holiday
        self.assertEqual(b["attendancePct"], 90.0)

    def test_sunday_and_holiday_work_is_not_a_paid_day(self):
        # Alice also worked Sunday (0.75) and the holiday (1.00): stored, shown, but staff payroll pays neither as a day
        AttendanceDayRecord.objects.filter(employee=self.alice, date__in=(FRI, SUN)).delete()
        day_rec(self.alice, SUN, "present", "0.75", first="09:00", last="16:00", n=2)
        day_rec(self.alice, FRI, "present", "1.00", first="09:00", last="18:00", n=2)
        body, rows = self.rows()
        a = rows["S001"]
        self.assertEqual((a["shifts"], a["offDayShifts"], a["attendancePct"]), (4.5, 1.75, 70.0))
        self.assertEqual(body["totals"]["offDayShifts"], round(sum(r["offDayShifts"] for r in rows.values()), 2))
        self.assertEqual(self.summary(body)["Shifts paid"], body["totals"]["shifts"])

    def test_days_before_joining_are_blank_and_not_counted(self):
        _body, rows = self.rows()
        n = rows["S003"]
        self.assertIsNone(n["d20261102"])
        self.assertEqual(n["d20261105"], "P")
        self.assertEqual((n["absent"], n["workingDays"], n["attendancePct"]), (0, 2, 100.0))

    def test_staff_only_and_no_dormant_leaver(self):
        _body, rows = self.rows(employeeStatus="all")
        self.assertNotIn("P001", rows)
        self.assertNotIn("S005", rows)  # inactive with no record

    def test_strength_row_totals_and_summary(self):
        body, rows = self.rows()
        strength = next(r for r in body["rows"] if r.get("_kind") == "total")
        self.assertEqual(strength["d20261102"], 3)  # Alice, Bob, Carol
        self.assertEqual(body["totals"]["shifts"], round(sum(r["shifts"] for r in rows.values()), 2))
        s = self.summary(body)
        self.assertEqual(s["Quarter / penalty days"], 2)
        self.assertEqual(s["Employees"], 4)

    def test_branch_isolation(self):
        body = self.get(GRID, user=self.branch_user, **WEEK)
        self.assertNotIn("S004", str(body["rows"]))
        x = self.export(GRID, "xlsx", user=self.branch_user, **WEEK)
        ws = load_workbook(io.BytesIO(x.content)).active
        self.assertNotIn("S004", " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None))

    def test_xlsx_colours_the_deduction_cells(self):
        x = self.export(GRID, "xlsx", **WEEK)
        ws = load_workbook(io.BytesIO(x.content)).active
        header = [c.value for c in ws[HEADER_ROW]]
        col = header.index("3 Tu") + 1
        for r in range(HEADER_ROW + 1, ws.max_row + 1):
            if ws.cell(row=r, column=2).value == "S001":
                cell = ws.cell(row=r, column=col)
                self.assertEqual(cell.value, "P¾")
                self.assertEqual(cell.fill.fgColor.rgb[-6:], "FFF2CC")
                break
        else:
            self.fail("Alice's row not found")


# ═════════════════════════════════════════════════════════════════════════════
class StaffTimeCardTests(_World):
    def test_quarter_and_penalty_columns(self):
        rows = self.by_day(self.get(CARD, **WEEK))
        tue = rows[("S001", TUE.isoformat())]
        self.assertEqual((tue["arrival"], tue["quarterDeduction"], tue["shiftsEarned"]), ("Quarter", 0.25, 0.75))
        self.assertTrue(tue["remarks"].startswith("Quarter shift (-0.25)"))
        wed = rows[("S001", WED.isoformat())]
        self.assertEqual((wed["penaltyDeduction"], wed["earlyOutMinutes"]), (0.25, 90))  # the engine's stored minutes
        self.assertIn("Penalty early out (-0.25, left 90 min early)", wed["remarks"])
        thu = rows[("S001", THU.isoformat())]
        self.assertEqual((thu["arrival"], thu["lateMinutes"]), ("Late", 30))
        self.assertEqual(rows[("S002", MON.isoformat())]["arrival"], "Second half")

    def test_staff_only_with_a_total_line_per_employee(self):
        body = self.get(CARD, **WEEK)
        self.assertNotIn("P001", str(body["rows"]))
        subs = [r for r in body["rows"] if r.get("_kind") == "subtotal"]
        alice = next(r for r in subs if r["employeeName"] == "S001 total")
        self.assertEqual(
            (alice["shiftsEarned"], alice["quarterDeduction"], alice["penaltyDeduction"]), (3.5, 0.25, 0.25)
        )

    def test_show_only_and_hide_off_days(self):
        rows = self.data(self.get(CARD, dayStatus="quarter", **WEEK))
        self.assertEqual([(r["employeeCode"], r["date"]) for r in rows], [("S001", TUE.isoformat())])
        rows = self.data(self.get(CARD, dayStatus="penalty", **WEEK))
        self.assertEqual([(r["employeeCode"], r["date"]) for r in rows], [("S001", WED.isoformat())])
        rows = self.data(self.get(CARD, hideOffDays="true", employeeIds=str(self.alice.id), **WEEK))
        self.assertEqual(len(rows), 5)  # the holiday and the Sunday are left out

    def test_the_printable_card_builds(self):
        p = self.export(CARD, "pdf", employeeIds=str(self.alice.id), **WEEK)
        self.assertTrue(p.content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
class ShiftCountTests(_World):
    def test_staff_by_default(self):
        body = self.get(COUNT, **WEEK)
        codes = {r["employeeCode"] for r in self.data(body)}
        self.assertTrue({"S001", "S002"} <= codes)
        self.assertFalse(any(c.startswith("P") for c in codes))
        self.assertEqual(self.by_day(body)[("S001", TUE.isoformat())]["shiftCount"], 0.75)

    def test_production_night_shift_is_one_shift_day(self):
        rows = self.by_day(self.get(COUNT, staffType="production", **WEEK))
        mon = rows[("P001", MON.isoformat())]
        engine = AttendanceDayRecord.objects.get(employee=self.night, date=MON)
        self.assertEqual(mon["punches"], "21:00, 05:30 (+1)")
        self.assertEqual(mon["shift"], "Night shift")
        self.assertEqual(mon["shiftCount"], float(engine.shifts_earned))
        self.assertGreater(mon["shiftCount"], 0)
        self.assertNotIn("Out of date", mon["remarks"] or "")
        # the closing punch is not listed again on Tuesday (no shift began that day)
        tue = rows[("P001", TUE.isoformat())]
        self.assertIsNone(tue["punches"])
        self.assertNotIn("Out of date", tue["remarks"] or "")

    def test_production_day_over_one_shift_and_the_out_of_date_flag(self):
        rows = self.by_day(self.get(COUNT, staffType="production", **WEEK))
        mon = rows[("P002", MON.isoformat())]
        self.assertEqual((mon["shift"], mon["shiftCount"]), ("Day shift", 1.5))
        thu = rows[("P002", THU.isoformat())]
        self.assertEqual(thu["shiftCount"], 2.72)
        self.assertIn("Out of date", thu["remarks"])

    def test_excel_serial_join_date_does_not_hide_the_worker(self):
        rows = self.by_day(self.get(COUNT, staffType="production", **WEEK))
        self.assertNotIn("Outside joining", rows[("P001", MON.isoformat())]["remarks"] or "")

    def test_total_line_per_employee(self):
        body = self.get(COUNT, staffType="production", **WEEK)
        subs = {r["employeeName"]: r for r in body["rows"] if r.get("_kind") == "subtotal"}
        total = subs["Dayw W (P002) total"]
        days = [r for r in self.data(body) if r["employeeCode"] == "P002"]
        self.assertEqual(total["shiftCount"], round(sum(r["shiftCount"] or 0 for r in days), 2))
        self.assertTrue(total["punches"].endswith("worked"))


# ═════════════════════════════════════════════════════════════════════════════
class LateDetectionTests(_World):
    def test_every_zone_is_listed(self):
        body = self.get(LATE, **WEEK)
        got = {(r["employeeCode"], r["date"]): r for r in self.data(body)}
        self.assertEqual(
            set(got),
            {
                ("S001", TUE.isoformat()),
                ("S001", THU.isoformat()),
                ("S002", MON.isoformat()),
                ("S002", THU.isoformat()),  # a second-half arrival covered by a half-day CL
                ("S004", MON.isoformat()),
            },
        )
        q = got[("S001", TUE.isoformat())]
        self.assertEqual(
            (q["arrival"], q["lateMinutes"], q["beyondGrace"], q["quarterDeduction"], q["shiftsEarned"]),
            ("Quarter", 90, 80, 0.25, 0.75),
        )
        self.assertEqual(q["poolStatus"], "Not a late mark (quarter shift)")
        late = got[("S001", THU.isoformat())]
        self.assertEqual((late["arrival"], late["lateMinutes"], late["poolStatus"]), ("Late", 30, "Counted"))
        excused = got[("S004", MON.isoformat())]
        self.assertEqual((excused["arrival"], excused["lateMinutes"]), ("Excused", 60))
        self.assertEqual(got[("S002", MON.isoformat())]["arrival"], "Second half")
        s = self.summary(body)
        self.assertEqual(
            (s["Counted in late pool"], s["Quarter-shift days"], s["Shifts deducted (quarter)"]), (1, 1, 0.25)
        )

    def test_arrival_and_minimum_filters(self):
        rows = self.data(self.get(LATE, arrival="quarter", **WEEK))
        self.assertEqual([r["arrival"] for r in rows], ["Quarter"])
        rows = self.data(self.get(LATE, arrival="late,excused", **WEEK))
        self.assertEqual(sorted(r["arrival"] for r in rows), ["Excused", "Late"])
        rows = self.data(self.get(LATE, minLate="60", **WEEK))
        self.assertTrue(all(r["lateMinutes"] >= 60 for r in rows))
        self.assertNotIn("Late", [r["arrival"] for r in rows])

    def test_branch_isolation(self):
        body = self.get(LATE, user=self.branch_user, **WEEK)
        self.assertNotIn("S004", str(body["rows"]))


# ═════════════════════════════════════════════════════════════════════════════
class MisspunchTests(_World):
    def rows(self, **extra):
        return self.by_day(self.get(MISS, period="2026-11", **extra))

    def test_single_odd_and_request_days(self):
        rows = self.rows()
        mon = rows[("S002", MON.isoformat())]
        self.assertEqual(
            (mon["issue"], mon["requestStatus"], mon["punches"]), ("Single punch", "Pending (HOD)", "14:00")
        )
        self.assertIn("09:00 Morning Check-In - Pending (HOD)", mon["requested"])
        self.assertEqual((mon["status"], mon["shiftsEarned"]), ("Half Day", 0.5))
        sat = rows[("S002", SAT.isoformat())]
        self.assertEqual((sat["issue"], sat["requestStatus"], sat["punchCount"]), ("Fixed by request", "Approved", 4))
        odd = rows[("P002", WED.isoformat())]
        self.assertEqual((odd["issue"], odd["employeeType"], odd["punchCount"]), ("Odd punches", "Production", 3))

    def test_a_night_shift_is_not_a_misspunch(self):
        rows = self.rows()
        self.assertNotIn(("P001", MON.isoformat()), rows)
        self.assertNotIn(("P001", TUE.isoformat()), rows)

    def test_show_filter(self):
        self.assertEqual(set(self.rows(show="fixed")), {("S002", SAT.isoformat())})
        self.assertEqual(set(self.rows(show="pending")), {("S002", MON.isoformat())})
        self.assertEqual(set(self.rows(show="no_request")), {("P002", WED.isoformat())})
        self.assertEqual(set(self.rows(staffType="staff")), {("S002", MON.isoformat()), ("S002", SAT.isoformat())})

    def test_a_future_month_is_empty(self):
        body = self.get(MISS, period="2027-01")
        self.assertEqual(body["rows"], [])


# ═════════════════════════════════════════════════════════════════════════════
class AttendanceLogTests(_World):
    def test_flags_punches_and_arrival(self):
        rows = self.by_day(self.get(LOG, **WEEK))
        tue = rows[("S001", TUE.isoformat())]
        self.assertEqual(
            (tue["arrival"], tue["punches"], tue["firstIn"], tue["lastOut"]),
            ("Quarter", "10:30, 18:05", "10:30", "18:05"),
        )
        self.assertIn("Quarter shift (-0.25)", tue["flags"])
        wed = rows[("S001", WED.isoformat())]
        self.assertIn("Penalty early out", wed["flags"])
        self.assertEqual(wed["earlyOutMinutes"], 90)
        self.assertEqual(rows[("S002", WED.isoformat())]["source"], "On-Duty")
        self.assertNotIn(("P001", MON.isoformat()), rows)  # staff only
        self.assertNotIn(("S003", MON.isoformat()), rows)  # before joining

    def test_flag_and_status_filters(self):
        rows = self.data(self.get(LOG, flag="quarter", **WEEK))
        self.assertEqual([(r["employeeCode"], r["date"]) for r in rows], [("S001", TUE.isoformat())])
        rows = self.data(self.get(LOG, flag="penalty", **WEEK))
        self.assertEqual([(r["employeeCode"], r["date"]) for r in rows], [("S001", WED.isoformat())])
        rows = self.data(self.get(LOG, status="half", **WEEK))
        self.assertEqual([(r["employeeCode"], r["date"]) for r in rows], [("S002", MON.isoformat())])


# ═════════════════════════════════════════════════════════════════════════════
class QueryBudgetTests(_World):
    PARAMS = {
        GRID: WEEK,
        CARD: WEEK,
        COUNT: {**WEEK, "staffType": "all"},
        LATE: WEEK,
        MISS: {"period": "2026-11"},
        LOG: WEEK,
    }

    def add_staff(self, n: int, start: int) -> None:
        emps = Employee.objects.bulk_create(
            Employee(
                employee_code=f"X{start + i:04d}",
                first_name=f"Extra{i}",
                last_name="T",
                department=self.cutting,
                branch=self.b1,
                employment_type="staff",
                join_date="2025-01-01",
            )
            for i in range(n)
        )
        EmployeeShiftAssignment.objects.bulk_create(
            EmployeeShiftAssignment(employee=e, shift=self.shift, effective_from=date(2026, 1, 1)) for e in emps
        )
        recs, logs = [], []
        for e in emps:
            for i in range(7):
                d = MON + timedelta(days=i)
                quarter = i == 1
                recs.append(
                    AttendanceDayRecord(
                        employee=e,
                        date=d,
                        status="present",
                        shifts_earned=Decimal("0.75") if quarter else Decimal("1"),
                        arrival_zone="quarter" if quarter else "on_time",
                        first_punch=time(10, 30) if quarter else time(9, 0),
                        last_punch=time(18, 0),
                        total_punches=2,
                    )
                )
                logs.append(AttendanceLog(employee=e, date=d, punch_time=time(9, 0), punch_type="IN", source=SRC))
                logs.append(AttendanceLog(employee=e, date=d, punch_time=time(18, 0), punch_type="IN", source=SRC))
        AttendanceDayRecord.objects.bulk_create(recs)
        AttendanceLog.objects.bulk_create(logs)

    def count(self, rid) -> tuple[int, int]:
        with CaptureQueriesContext(connection) as cq:
            body = self.get(rid, **self.PARAMS[rid])
        return len(cq.captured_queries), len(body["rows"])

    def test_query_count_does_not_grow_with_the_roster(self):
        self.add_staff(5, 0)
        small = {rid: self.count(rid) for rid in IDS}
        self.add_staff(40, 100)
        for rid in IDS:
            with self.subTest(report=rid):
                q, rows = self.count(rid)
                if rid != MISS:  # the extra people have complete punches: no misspunch rows
                    self.assertGreater(rows, small[rid][1])
                self.assertEqual(q, small[rid][0], f"{rid}: {small[rid][0]} -> {q} queries")
                self.assertLessEqual(q, 25, rid)

    def test_no_report_loads_the_photo_or_the_password_hash(self):
        Employee.objects.filter(id=self.alice.id).update(photo_url="data:image/png;base64," + "A" * 50_000)
        for rid in IDS:
            with self.subTest(report=rid):
                with CaptureQueriesContext(connection) as cq:
                    self.get(rid, **self.PARAMS[rid])
                sql = " ".join(q["sql"] for q in cq.captured_queries)
                self.assertNotIn('"employees"."photo_url"', sql)
                self.assertNotIn('"employees"."password_hash"', sql)
