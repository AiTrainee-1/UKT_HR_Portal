"""
Report Center, Attendance group: the production reports (reporting/definitions/rc_attendance_production.py).

production-attendance-report, production-time-card-punches, production-shift-ot-punches, production-all-punches and
production-attendance-log read a production day by SHIFT DAY with the engine's own rules (night sessions, the 06:00
early-arrival guard, double taps, special shifts, quarters) and show the STORED verdict (the AttendanceDayRecord the
engine wrote, which production payroll reads). The roster below has every shape: a day with extra shifts, a quarter day,
a night chain, a late / early day, a forgotten out punch, an early arrival after one, a worker on a special shift, a
Sunday, a day HR entered by hand, a day stored before quarter rounding, an unprocessed day and a double tap.

"Today" is pinned to 2026-09-29; the shift table judges every day from 2026-09-01.

Run via: python manage.py test api.tests_reporting_rc_attendance_production -v 2
"""

import importlib
import io
from datetime import date, time, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .attendance_final import compute_day_record
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    BiometricDevice,
    Branch,
    Department,
    Designation,
    Employee,
    HRUser,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
    ProductionSpecialShiftAssignment,
    Role,
)
from .reporting.export_xlsx import HEADER_ROW
from .reporting.layout import LAYOUT

TODAY = date(2026, 9, 29)
EFFECTIVE = date(2026, 9, 1)
MON = date(2026, 9, 21)
TUE, WED, THU, FRI, SAT, SUN = (MON + timedelta(days=i) for i in range(1, 7))
WEEK = [MON + timedelta(days=i) for i in range(7)]
LEGACY_DAY = date(2026, 8, 31)  # a Monday before the rules start

GRID = "production-attendance-report"
CARD = "production-time-card-punches"
OT = "production-shift-ot-punches"
PUNCHES = "production-all-punches"
LOG = "production-attendance-log"
ALL = (GRID, CARD, OT, PUNCHES, LOG)
RANGE = {"dateFrom": MON.isoformat(), "dateTo": SUN.isoformat()}


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _ensure_seed():
    """The migration seeds the three groups and the breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.filter(is_special=False).exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)


def _log(emp, day, *times, source="biometric:dev1"):
    for hh, mm, ss in times:
        AttendanceLog.objects.create(
            employee=emp, date=day, punch_time=time(hh, mm, ss), punch_type="IN", source=source
        )


class _World(TestCase):
    @classmethod
    def setUpTestData(cls):
        _ensure_seed()
        config = ProductionShiftConfig.get()
        config.rules_effective_from = EFFECTIVE
        config.save()
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.dept = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.dept2 = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.des = Designation.objects.create(title="Operator", department=cls.dept, level="junior")

        def mk(code, **kw):
            kw.setdefault("branch", cls.b1)
            kw.setdefault("department", cls.dept)
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Worker",
                employment_type="production",
                designation=cls.des,
                status="active",
                **kw,
            )

        cls.day_w = mk("D1")
        cls.quarter_w = mk("Q1")
        cls.late_w = mk("L1")
        cls.night_w = mk("N1")
        cls.forgot_w = mk("F1")
        cls.early_w = mk("E1")
        cls.special_w = mk("S1")
        cls.sunday_w = mk("SU1")
        cls.manual_w = mk("M1")
        cls.unprocessed_w = mk("U1")
        cls.other_unit = mk("U9", branch=cls.b2, department=cls.dept2)
        cls.staff = Employee.objects.create(
            employee_code="ST1", first_name="Staff", last_name="Sam", employment_type="staff", branch=cls.b1
        )

        # D1: Mon 1.50 (to the 20:00 main departure), Tue 2.00 (to 22:30: one extra shift), Thu stored before quarter
        # rounding (1.47, set below), Sat a double tap, and a legacy day before the rules start
        _log(cls.day_w, MON, (8, 29, 40), (12, 45, 0), (13, 30, 0), (20, 0, 3))
        _log(cls.day_w, TUE, (8, 30, 0), (12, 45, 0), (13, 30, 0), (22, 30, 20))
        _log(cls.day_w, THU, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        _log(cls.day_w, SAT, (8, 30, 0), (8, 31, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        _log(cls.day_w, LEGACY_DAY, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        # Q1: leaves at the afternoon tea, a quarter day (0.75); the last punch came from an ADMS push
        _log(cls.quarter_w, MON, (8, 30, 0), (12, 45, 0), (13, 30, 0))
        _log(cls.quarter_w, MON, (15, 30, 0), source="biometric:adms:SN-GATE")
        # L1: late 08:50 and leaves 17:30 (before the 20:00 standard departure)
        _log(cls.late_w, MON, (8, 50, 0), (12, 45, 0), (13, 30, 0), (17, 30, 0))
        # N1: two nights in a row, each closed by the next morning's punch
        _log(cls.night_w, MON, (21, 0, 5))
        _log(cls.night_w, TUE, (5, 30, 10), (21, 0, 8))
        _log(cls.night_w, WED, (5, 31, 0))
        # F1: Wednesday without an out punch; Thursday's 08:31 arrival is after the close-by time, so it stays Thursday's
        _log(cls.forgot_w, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0))
        _log(cls.forgot_w, THU, (8, 31, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        # E1: Monday without an out punch; Tuesday's 06:10 is inside the close-by time but from 06:00: the early arrival
        _log(cls.early_w, MON, (8, 30, 0), (12, 45, 0), (13, 30, 0))
        _log(cls.early_w, TUE, (6, 10, 0), (12, 45, 0), (13, 30, 0), (17, 45, 0))
        # S1: on a special shift (07:00 start, 15:00 = 1.00). Monday without an out punch; Tuesday 05:00 is the special
        # shift's early arrival (from 04:30), so it never closes Monday. By the default groups it would.
        special = ProductionShiftGroup.objects.create(
            label="Early special",
            kind="custom",
            applies_on="mon_sat",
            start_time=time(7, 0),
            first_punch_from=time(5, 0),
            first_punch_to=time(10, 0),
            main_out_time=time(15, 0),
            main_out_next_day=False,
            enabled=True,
            order=10,
            is_special=True,
        )
        ProductionShiftRule.objects.create(
            group=special, label="", out_time=time(15, 0), out_next_day=False, shift_value=Decimal("1.00"), order=1
        )
        ProductionSpecialShiftAssignment.objects.create(employee=cls.special_w, group=special, effective_from=EFFECTIVE)
        _log(cls.special_w, MON, (7, 0, 0), (11, 0, 0), (11, 30, 0))
        _log(cls.special_w, TUE, (5, 0, 0), (15, 0, 0))
        # SU1: a Sunday 08:30 -> 17:00 (the Sunday shift, 1.00)
        _log(cls.sunday_w, SUN, (8, 30, 0), (17, 0, 0))
        # M1: HR entered Wednesday by hand (2.50) over punches that would give 1.50
        _log(cls.manual_w, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        AttendanceDayRecord.objects.create(
            employee=cls.manual_w,
            date=WED,
            status="present",
            shifts_earned=Decimal("2.50"),
            source="manual",
            override_note="HR entry",
        )
        # U1: punched on Friday, but nobody has worked the day out yet (no stored record)
        _log(cls.unprocessed_w, FRI, (8, 30, 0), (20, 0, 0))
        _log(cls.other_unit, MON, (8, 30, 0), (20, 0, 0))
        _log(cls.staff, MON, (9, 0, 0), (18, 0, 0))
        BiometricDevice.objects.create(name="Gate A", serial_number="SN-GATE")

        # what the background refresh does: the engine stores its verdict for every production day (the reports read it)
        for emp in Employee.objects.filter(employment_type="production").exclude(employee_code="U1"):
            for day in (LEGACY_DAY, *WEEK):
                compute_day_record(emp, day)
        AttendanceDayRecord.objects.filter(employee=cls.day_w, date=THU).update(shifts_earned=Decimal("1.47"))

        cls.admin = HRUser.objects.create(username="hr_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.attendance_user = user("hr_att", {"attendance": "view"})
        cls.salary_user = user("hr_sal", {"salary": "view", "payroll": "view"})
        cls.branch_user = user("hr_branch1", {"attendance": "view"}, branch=cls.b1)

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def get(self, rid, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, rid, fmt="xlsx", user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    @staticmethod
    def data(body) -> list[dict]:
        return [r for r in body["rows"] if not r.get("_kind")]

    def by_day(self, body) -> dict:
        return {(r["employeeCode"], r["date"]): r for r in self.data(body)}

    def rec(self, emp, day):
        return AttendanceDayRecord.objects.get(employee=emp, date=day)


# ═════════════════════════════════════════════════════════════════════════════
#  Catalog, access, defaults
# ═════════════════════════════════════════════════════════════════════════════


class CatalogTests(_World):
    def test_the_five_reports_are_listed_in_the_attendance_group_in_layout_order(self):
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        listed = [r["id"] for r in body["reports"] if r["category"] == "attendance"]
        for rid in ALL:
            self.assertIn(rid, LAYOUT["attendance"])
            self.assertIn(rid, listed)
        order = [rid for rid in listed if rid in ALL]
        self.assertEqual(order, [rid for rid in LAYOUT["attendance"] if rid in ALL])
        titles = {r["id"]: r["title"] for r in body["reports"]}
        self.assertEqual(titles[GRID], "Production Attendance Report")
        self.assertEqual(titles[CARD], "Production Time Card with Punch Details")
        self.assertEqual(titles[OT], "Production Shift with OT Punch Details")
        self.assertEqual(titles[PUNCHES], "Production All Punch Records")
        self.assertEqual(titles[LOG], "Production Attendance Log Report")

    def test_filters_are_production_only_and_few(self):
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        for report in body["reports"]:
            if report["id"] not in ALL:
                continue
            kinds = [f["kind"] for f in report["filters"]]
            self.assertNotIn("employmentType", kinds, report["id"])  # production is fixed
            self.assertLessEqual(len(kinds), 8, report["id"])
            self.assertEqual(kinds[0], "dateRange")
            status = next(f for f in report["filters"] if f["kind"] == "employeeStatus")
            self.assertEqual(status["default"], "active")
            for f in report["filters"]:
                if f["kind"] == "boolean":
                    self.assertFalse(f["default"], (report["id"], f["key"]))

    def test_every_report_runs_on_its_defaults(self):
        for rid in ALL:
            body = self.get(rid)
            self.assertIn("rows", body, rid)

    def test_the_attendance_module_owns_them(self):
        for rid in ALL:
            self.get(rid, user=self.attendance_user, **RANGE)
            self.get(rid, user=self.salary_user, expect=403, **RANGE)
        self.assertEqual(self.client.get(f"/api/reports/run/{GRID}").status_code, 401)

    def test_a_branch_login_sees_its_own_branch_only(self):
        for rid in ALL:
            mine = {r.get("employeeCode") for r in self.data(self.get(rid, user=self.branch_user, **RANGE))}
            everyone = {r.get("employeeCode") for r in self.data(self.get(rid, **RANGE))}
            self.assertNotIn("U9", mine, rid)
            self.assertNotIn("ST1", everyone, rid)  # staff never appear
            if rid != PUNCHES:
                self.assertIn("U9", everyone, rid)
            self.assertIn("D1", mine, rid)

    def test_the_range_is_capped_at_a_month(self):
        for rid in ALL:
            self.get(rid, expect=400, dateFrom="2026-08-01", dateTo="2026-09-29")


# ═════════════════════════════════════════════════════════════════════════════
#  2. Production Attendance Report (the grid)
# ═════════════════════════════════════════════════════════════════════════════


def k(d: date) -> str:
    return f"d{d.strftime('%Y%m%d')}"


class GridTests(_World):
    def grid(self, **extra):
        body = self.get(GRID, **RANGE, **extra)
        return body, {r["employeeCode"]: r for r in self.data(body)}

    def test_each_cell_is_the_stored_shifts_of_the_shift_day(self):
        _body, rows = self.grid()
        d1 = rows["D1"]
        self.assertEqual((d1[k(MON)], d1[k(TUE)], d1[k(WED)]), ("1.50", "2.00", "A"))
        self.assertEqual(rows["Q1"][k(MON)], "0.75")  # a quarter day
        n1 = rows["N1"]
        self.assertEqual((n1[k(MON)], n1[k(TUE)], n1[k(WED)]), ("1.50", "1.50", "A"))  # the night sits on its start day
        self.assertEqual(rows["M1"][k(WED)], "2.50")  # HR's value
        self.assertEqual(rows["SU1"][k(SUN)], "1.00")
        self.assertEqual(rows["S1"][k(TUE)], "1.00")  # judged by the special shift
        self.assertIsNone(rows["U1"][k(FRI)])  # not processed: a dash
        for code, row in rows.items():
            for d in WEEK:
                rec = AttendanceDayRecord.objects.filter(employee__employee_code=code, date=d).first()
                if rec is not None and rec.status in ("present", "half_shift"):
                    self.assertEqual(row[k(d)].rstrip("*"), f"{rec.shifts_earned:.2f}", (code, d))

    def test_a_value_stored_before_quarter_rounding_is_shown_and_flagged(self):
        body, rows = self.grid()
        self.assertEqual(rows["D1"][k(THU)], "1.47*")
        self.assertIn("off the 0.25 grid", " ".join(body["notes"]))

    def test_the_totals_per_worker(self):
        _body, rows = self.grid()
        d1 = rows["D1"]
        # Mon 1.50, Tue 2.00, Thu 1.47, Sat 1.50 (the double tap is not a second in)
        self.assertEqual((d1["worked"], d1["below"], d1["late"]), (4, 0, 0))
        self.assertAlmostEqual(d1["total"], 6.47)
        self.assertAlmostEqual(d1["extra"], 0.5 + 1.0 + 0.47 + 0.5)
        n1 = rows["N1"]
        self.assertEqual((n1["worked"], n1["nights"], n1["total"], n1["extra"]), (2, 2, 3.0, 1.0))
        q1 = rows["Q1"]
        self.assertEqual((q1["worked"], q1["below"], q1["total"]), (1, 1, 0.75))
        l1 = rows["L1"]
        self.assertEqual((l1["late"], l1["worked"]), (1, 1))
        self.assertEqual(rows["D1"]["absent"], 3)  # Wed, Fri and Sun stored absent

    def test_the_day_totals_and_the_summary(self):
        body, rows = self.grid()
        structural = [r for r in body["rows"] if r.get("_kind")]
        workers = next(r for r in structural if r["employeeName"] == "Workers present")
        shifts = next(r for r in structural if r["employeeName"] == "Shifts earned")
        mon_workers = sum(1 for r in rows.values() if r[k(MON)] not in (None, "A", "0.00", "H", "L"))
        self.assertEqual(workers[k(MON)], mon_workers)
        mon_total = sum(float(r[k(MON)].rstrip("*")) for r in rows.values() if r[k(MON)] not in (None, "A", "H", "L"))
        self.assertAlmostEqual(shifts[k(MON)], mon_total)
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(cards["Production employees"], len(rows))
        self.assertAlmostEqual(cards["Total shifts"], sum(r["total"] for r in rows.values()))
        self.assertEqual(cards["Days not processed"], 7)  # U1 has no stored day at all
        self.assertAlmostEqual(body["totals"]["total"], cards["Total shifts"])

    def test_the_excel_file_is_coloured_and_the_pdf_is_a_landscape_register(self):
        sheet = load_workbook(io.BytesIO(self.export(GRID, **RANGE).content)).active
        header = [c.value for c in sheet[HEADER_ROW]]
        col = header.index("22 Tu") + 1
        code_col = header.index("Emp Code") + 1
        d1_row = next(r for r in range(HEADER_ROW + 1, sheet.max_row + 1) if sheet.cell(r, code_col).value == "D1")
        cell = sheet.cell(d1_row, col)
        self.assertEqual(cell.value, "2.00")
        self.assertTrue(cell.fill.fgColor.rgb.endswith("9FE0B0"))  # extra shifts
        workers_row = next(
            r
            for r in range(HEADER_ROW + 1, sheet.max_row + 1)
            if sheet.cell(r, code_col + 1).value == "Workers present"
        )
        self.assertIsInstance(sheet.cell(workers_row, col).value, int)
        pdf = self.export(GRID, fmt="pdf", **RANGE).content
        self.assertTrue(pdf.startswith(b"%PDF"))
        month = self.export(GRID, fmt="pdf", dateFrom="2026-09-01", dateTo="2026-09-29").content
        self.assertTrue(month.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  5. Production Time Card with Punch Details
# ═════════════════════════════════════════════════════════════════════════════


class TimeCardTests(_World):
    def card(self, **extra):
        return self.by_day(self.get(CARD, **RANGE, **extra))

    def test_a_night_is_one_shift_day_with_its_closing_punch_marked(self):
        rows = self.card()
        mon = rows[("N1", MON.isoformat())]
        self.assertEqual((mon["p1"], mon["p2"], mon.get("p3")), ("21:00", "05:30 (+1)", None))
        self.assertEqual((mon["group"], mon["firstIn"], mon["lastOut"]), ("Night shift", "21:00", "05:30 (+1)"))
        self.assertEqual((mon["hours"], mon["shiftsEarned"]), (8.5, 1.5))
        self.assertIn("Closed next morning", mon["flags"])
        tue = rows[("N1", TUE.isoformat())]
        self.assertEqual((tue["p1"], tue["p2"]), ("21:00", "05:31 (+1)"))  # the 05:30 that closed Monday is not here
        wed = rows[("N1", WED.isoformat())]
        self.assertIsNone(wed["p1"])  # its only punch closed Tuesday's night
        self.assertEqual(wed["status"], "Absent")

    def test_the_early_arrival_guard_keeps_a_morning_punch_on_its_own_day(self):
        rows = self.card()
        mon = rows[("E1", MON.isoformat())]
        self.assertEqual((mon["p1"], mon["p2"], mon["p3"], mon.get("p4")), ("08:30", "12:45", "13:30", None))
        self.assertIn("Odd punches", mon["flags"])
        tue = rows[("E1", TUE.isoformat())]
        self.assertEqual((tue["p1"], tue["firstIn"], tue["shiftsEarned"]), ("06:10", "06:10", 1.0))
        # a forgotten out punch is not closed by an ordinary next-morning arrival either
        self.assertEqual(rows[("F1", THU.isoformat())]["p1"], "08:31")

    def test_a_worker_on_a_special_shift_is_read_with_it(self):
        rows = self.card()
        mon = rows[("S1", MON.isoformat())]
        self.assertEqual((mon["p1"], mon["p2"], mon["p3"], mon.get("p4")), ("07:00", "11:00", "11:30", None))
        self.assertEqual(mon["group"], "Early special (special)")
        tue = rows[("S1", TUE.isoformat())]
        self.assertEqual(
            (tue["p1"], tue["p2"], tue["group"], tue["shiftsEarned"]),
            ("05:00", "15:00", "Early special (special)", 1.0),
        )

    def test_late_and_early_minutes_come_from_the_group_on_a_day_stored_late_or_early(self):
        row = self.card()[("L1", MON.isoformat())]
        self.assertEqual((row["lateMinutes"], row["earlyMinutes"]), (20, 150))
        self.assertIn("Late", row["flags"])
        self.assertIsNone(self.card()[("D1", MON.isoformat())]["lateMinutes"])  # 08:29 is on time

    def test_every_day_with_a_total_line_per_worker_and_the_worked_days_option(self):
        body = self.get(CARD, **RANGE, employeeIds=str(self.day_w.id))
        days = self.data(body)
        self.assertEqual([r["date"] for r in days], [d.isoformat() for d in WEEK])
        total = next(r for r in body["rows"] if r.get("_kind") == "subtotal")
        self.assertAlmostEqual(total["shiftsEarned"], 6.47)
        self.assertEqual(total["group"], "4 days worked")
        sat = next(r for r in days if r["date"] == SAT.isoformat())
        self.assertEqual((sat["p1"], sat["p2"]), ("08:30", "08:31"))  # every stored punch, the double tap too
        self.assertIn("Double tap (1)", sat["flags"])
        self.assertEqual(sat["hours"], 10.75)  # 08:30-12:45 + 13:30-20:00, the double tap not paired
        worked = self.data(self.get(CARD, **RANGE, employeeIds=str(self.day_w.id), days="worked"))
        self.assertEqual([r["date"] for r in worked], [d.isoformat() for d in (MON, TUE, THU, SAT)])

    def test_an_unprocessed_day_and_a_manual_day(self):
        rows = self.card()
        u1 = rows[("U1", FRI.isoformat())]
        self.assertEqual((u1["status"], u1["shiftsEarned"], u1["p1"]), ("Not processed", None, "08:30"))
        m1 = rows[("M1", WED.isoformat())]
        self.assertEqual((m1["group"], m1["shiftsEarned"]), ("Manual entry", 2.5))
        self.assertIn("Entered by HR", m1["flags"])

    def test_a_legacy_day_is_read_by_calendar_date(self):
        row = self.by_day(self.get(CARD, dateFrom=LEGACY_DAY.isoformat(), dateTo=LEGACY_DAY.isoformat()))[
            ("D1", LEGACY_DAY.isoformat())
        ]
        self.assertEqual(row["group"], "Legacy rules")
        self.assertEqual(row["shiftsEarned"], float(self.rec(self.day_w, LEGACY_DAY).shifts_earned))

    def test_exports(self):
        sheet = load_workbook(io.BytesIO(self.export(CARD, **RANGE).content)).active
        header = [c.value for c in sheet[HEADER_ROW]]
        self.assertEqual(header[:6], ["Emp Code", "Employee", "Department", "Shift day", "Day", "Group"])
        self.assertIn("P1", header)
        self.assertTrue(self.export(CARD, fmt="pdf", **RANGE).content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  6. Production Shift with OT Punch Details
# ═════════════════════════════════════════════════════════════════════════════


class OvertimeTests(_World):
    def ot(self, **extra):
        return self.by_day(self.get(OT, **RANGE, **extra))

    def test_a_day_with_one_extra_shift(self):
        row = self.ot()[("D1", TUE.isoformat())]
        self.assertEqual((row["regularShift"], row["extraShifts"], row["shiftsEarned"]), (1.0, 1.0, 2.0))
        # 1.00 is reached at the 17:45 rule; 17:45-22:30 less the evening tea (15 min) and the dinner (1 h) = 3.50 h
        self.assertEqual((row["otFrom"], row["otHours"], row["otPunches"]), ("17:45", 3.5, "22:30"))
        self.assertEqual(row["punches"], "08:30, 12:45, 13:30, 22:30")

    def test_a_night_reaches_a_full_shift_after_midnight(self):
        row = self.ot()[("N1", MON.isoformat())]
        # 21:00-00:00 = 0.50, then 1.00 more over 00:00-05:30: 1.00 is reached at 02:45 the next morning
        self.assertEqual((row["regularShift"], row["extraShifts"]), (1.0, 0.5))
        self.assertEqual((row["otFrom"], row["otHours"], row["otPunches"]), ("02:45 (+1)", 2.75, "05:30 (+1)"))

    def test_a_day_without_extra_shifts_has_no_ot_part(self):
        rows = self.ot()
        q1 = rows[("Q1", MON.isoformat())]
        self.assertEqual((q1["regularShift"], q1["extraShifts"], q1["otFrom"], q1["otHours"]), (0.75, 0.0, None, None))
        self.assertNotIn(("D1", WED.isoformat()), rows)  # absent days are not listed

    def test_the_extra_part_of_a_manual_or_out_of_date_day_comes_from_the_stored_value(self):
        rows = self.ot()
        m1 = rows[("M1", WED.isoformat())]
        self.assertEqual((m1["extraShifts"], m1["otFrom"]), (1.5, None))
        self.assertIn("not measured", m1["flags"])
        thu = rows[("D1", THU.isoformat())]
        self.assertAlmostEqual(thu["extraShifts"], 0.47)
        self.assertIn("Out of date", thu["flags"])

    def test_only_days_with_extra_shifts(self):
        rows = self.ot(otOnly="true")
        self.assertTrue(rows)
        self.assertTrue(all(r["extraShifts"] > 0 for r in rows.values()))
        self.assertNotIn(("Q1", MON.isoformat()), rows)

    def test_totals_and_summary(self):
        body = self.get(OT, **RANGE, employeeIds=str(self.day_w.id))
        total = next(r for r in body["rows"] if r.get("_kind") == "subtotal")
        self.assertEqual(total["regularShift"], 4.0)
        self.assertAlmostEqual(total["extraShifts"], 2.47)
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(cards["Days with extra shifts"], 4)
        self.assertEqual(cards["Regular shifts"], 4.0)

    def test_exports(self):
        self.assertEqual(self.export(OT, **RANGE).status_code, 200)
        self.assertTrue(self.export(OT, fmt="pdf", **RANGE).content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  7. Production All Punch Records
# ═════════════════════════════════════════════════════════════════════════════


class AllPunchesTests(_World):
    def punches(self, **params):
        return self.data(self.get(PUNCHES, **params))

    def test_every_punch_with_the_shift_day_it_counts_for(self):
        rows = self.punches(**RANGE, employeeIds=str(self.night_w.id))
        listed = [(r["punchDate"], r["punchTime"], r["shiftDay"], r["direction"]) for r in rows]
        self.assertEqual(
            listed,
            [
                ("2026-09-21", "21:00:05", "2026-09-21", "In"),
                ("2026-09-22", "05:30:10", "2026-09-21", "Out"),
                ("2026-09-22", "21:00:08", "2026-09-22", "In"),
                ("2026-09-23", "05:31:00", "2026-09-22", "Out"),
            ],
        )
        self.assertIn("Closes the night shift of 21-Sep-2026", rows[1]["note"])

    def test_the_range_lists_what_was_stamped_in_it_plus_the_closing_punch_of_its_last_night(self):
        rows = self.punches(dateFrom=TUE.isoformat(), dateTo=TUE.isoformat(), employeeIds=str(self.night_w.id))
        self.assertEqual(
            [(r["punchDate"], r["shiftDay"]) for r in rows],
            [("2026-09-22", "2026-09-21"), ("2026-09-22", "2026-09-22"), ("2026-09-23", "2026-09-22")],
        )

    def test_double_taps_devices_and_sources(self):
        sat = [r for r in self.punches(**RANGE, employeeIds=str(self.day_w.id)) if r["shiftDay"] == SAT.isoformat()]
        self.assertEqual([r["direction"] for r in sat], ["In", "Double tap", "Out", "In", "Out"])
        self.assertEqual([r["punchNo"] for r in sat], [1, 2, 3, 4, 5])
        self.assertEqual((sat[0]["device"], sat[0]["source"], sat[0]["storedType"]), ("dev1", "Biometric", "IN"))
        q1 = self.punches(**RANGE, employeeIds=str(self.quarter_w.id))
        self.assertEqual([r["device"] for r in q1], ["dev1", "dev1", "dev1", "Gate A"])  # the ADMS serial's name
        self.assertEqual(len(self.punches(**RANGE, source="geo")), 0)
        self.assertEqual(len(self.punches(**RANGE, source="biometric")), len(self.punches(**RANGE)))

    def test_counts_and_exports(self):
        body = self.get(PUNCHES, **RANGE)
        rows = self.data(body)
        stored = AttendanceLog.objects.filter(
            employee__employment_type="production", employee__branch=self.b1, date__gte=MON, date__lte=SUN
        )
        self.assertEqual(len([r for r in rows if r["employeeCode"] != "U9"]), stored.count())
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(cards["Closing punches next morning"], 2)
        self.assertEqual(cards["Double taps"], 1)
        self.assertEqual(self.export(PUNCHES, **RANGE).status_code, 200)
        self.assertTrue(self.export(PUNCHES, fmt="pdf", **RANGE).content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  16. Production Attendance Log Report
# ═════════════════════════════════════════════════════════════════════════════


class LogTests(_World):
    def log(self, **extra):
        return self.by_day(self.get(LOG, **RANGE, **extra))

    def test_one_line_per_worker_per_shift_day_that_agrees_with_the_stored_day(self):
        rows = self.log()
        self.assertEqual(len(rows), 11 * 7)  # every production worker in scope, every day of the week
        checked = 0
        for (code, day), row in rows.items():
            rec = AttendanceDayRecord.objects.filter(employee__employee_code=code, date=day).first()
            if rec is None:
                self.assertEqual(row["status"], "Not processed")
                continue
            self.assertEqual(Decimal(str(row["shiftsEarned"])), rec.shifts_earned, (code, day))
            self.assertEqual("Late" in (row["flags"] or "").split("; "), bool(rec.is_late), (code, day))
            if rec.source != "manual" and rec.first_punch is not None:
                self.assertEqual(row["firstIn"], rec.first_punch.strftime("%H:%M"), (code, day))
                if rec.last_punch is not None:
                    self.assertEqual(row["lastOut"].split(" ")[0], rec.last_punch.strftime("%H:%M"), (code, day))
                checked += 1
        self.assertGreaterEqual(checked, 14)

    def test_group_hours_and_flags(self):
        rows = self.log()
        mon = rows[("D1", MON.isoformat())]
        self.assertEqual(
            (mon["group"], mon["hours"], mon["punchCount"], mon["source"]), ("Day shift", 10.75, 4, "Biometric")
        )
        self.assertEqual(rows[("SU1", SUN.isoformat())]["group"], "Sunday shift")
        self.assertEqual(rows[("N1", MON.isoformat())]["punches"], "21:00, 05:30 (+1)")
        self.assertEqual(rows[("M1", WED.isoformat())]["source"], "Manual")

    def test_status_and_flag_filters(self):
        night = self.log(flag="night")
        self.assertEqual(set(night), {("N1", MON.isoformat()), ("N1", TUE.isoformat())})
        outdated = self.log(flag="outdated")
        self.assertEqual(set(outdated), {("D1", THU.isoformat())})
        unprocessed = self.log(status="unprocessed")
        self.assertEqual({code for code, _d in unprocessed}, {"U1"})
        worked = self.log(status="worked")
        self.assertTrue(all(r["shiftsEarned"] > 0 for r in worked.values()))
        extra = self.log(flag="extra")
        self.assertIn(("D1", TUE.isoformat()), extra)
        self.assertNotIn(("Q1", MON.isoformat()), extra)

    def test_a_punch_after_the_day_was_stored_is_flagged(self):
        _log(self.quarter_w, MON, (20, 0, 0))
        row = self.log()[("Q1", MON.isoformat())]
        self.assertIn("punches changed after the day was stored", row["flags"])
        self.assertEqual(row["shiftsEarned"], 0.75)  # still the stored value

    def test_exports(self):
        sheet = load_workbook(io.BytesIO(self.export(LOG, **RANGE).content)).active
        self.assertEqual([c.value for c in sheet[HEADER_ROW]][:4], ["Shift day", "Day", "Emp Code", "Employee"])
        self.assertTrue(self.export(LOG, fmt="pdf", **RANGE).content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  Cost, writes, and the shared special-shift fix
# ═════════════════════════════════════════════════════════════════════════════


class CostTests(_World):
    def queries(self, rid, **params) -> int:
        self.get(rid, **params)  # warm the permission caches
        with CaptureQueriesContext(connection) as q:
            self.get(rid, **params)
        return len(q)

    def test_the_query_count_is_small_and_does_not_grow_with_workers_or_days(self):
        before = {rid: self.queries(rid, **RANGE) for rid in ALL}
        for rid, n in before.items():
            self.assertLessEqual(n, 25, rid)
        for i in range(15):
            emp = Employee.objects.create(
                employee_code=f"X{i}",
                first_name=f"X{i}",
                last_name="Worker",
                employment_type="production",
                designation=self.des,
                branch=self.b1,
                department=self.dept,
                status="active",
            )
            for d in WEEK:
                _log(emp, d, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
            _log(emp, MON, (21, 0, 0))
            _log(emp, TUE, (5, 30, 0))
            for d in WEEK[:3]:
                compute_day_record(emp, d)
        for rid in ALL:
            self.assertEqual(self.queries(rid, **RANGE), before[rid], rid)
            self.assertEqual(self.queries(rid, dateFrom="2026-09-01", dateTo="2026-09-29"), before[rid], rid)

    def test_the_reports_never_write(self):
        from django.apps import apps

        def counts():
            return {
                m.__name__: m.objects.count()
                for m in apps.get_app_config("api").get_models()
                if m.__name__ != "AuditLog"
            }

        before = counts()
        for rid in ALL:
            self.get(rid, **RANGE)
            self.export(rid, **RANGE)
            self.export(rid, fmt="pdf", **RANGE)
        self.assertEqual(counts(), before)

    def test_an_export_over_the_limit_is_refused(self):
        with patch("api.reporting.runner.XLSX_ROW_LIMIT", 3):
            for rid in (CARD, PUNCHES, LOG):
                self.export(rid, expect=413, **RANGE)


class SpecialShiftFixTests(_World):
    """production_judge passes the worker's id to the night-session resolution (as the engine does), so the shared
    callers place a special-shift worker's punches on the day the engine stored them on."""

    def test_hr_production_daily_punches_places_the_special_shift_workers_morning_punch_like_the_engine(self):
        body = self.get("production-daily-punches", **RANGE, employeeIds=str(self.special_w.id))
        rows = self.by_day(body)
        self.assertEqual(rows[("S1", MON.isoformat())]["punches"], "07:00:00, 11:00:00, 11:30:00")
        self.assertEqual(rows[("S1", TUE.isoformat())]["punches"], "05:00:00, 15:00:00")
        self.assertEqual(
            rows[("S1", TUE.isoformat())]["shiftsEarned"], float(self.rec(self.special_w, TUE).shifts_earned)
        )

    def test_the_attendance_registers_place_it_the_same_way(self):
        # the Daily Movement Register reads the punches through the shared AttendanceData loader
        body = self.get(
            "hr-daily-movement-register",
            dateFrom=MON.isoformat(),
            dateTo=TUE.isoformat(),
            employeeIds=str(self.special_w.id),
        )
        rows = {r["date"]: r for r in self.data(body)}
        mon, tue = rows["21/09/26 Mon"], rows["22/09/26 Tue"]
        self.assertEqual((mon["time1"], mon["time3"], mon["time4"]), ("7:00 AM-I", "11:30 AM-I", None))
        self.assertEqual((tue["time1"], tue["time2"]), ("5:00 AM-I", "3:00 PM-I"))

    def test_without_the_workers_id_the_default_groups_would_have_closed_monday(self):
        from . import production_shift_rules as psr
        from .reporting.definitions.production_judge import resolve_shift_day

        ruleset = psr.load_ruleset(ProductionShiftConfig.get())
        by_date = {
            d: [(h * 3600 + m * 60 + s, (d, i)) for i, (h, m, s) in enumerate(times)]
            for d, times in ((MON, ((7, 0, 0), (11, 0, 0), (11, 30, 0))), (TUE, ((5, 0, 0), (15, 0, 0))))
        }
        self.assertEqual(len(resolve_shift_day(ruleset, MON, by_date)), 4)  # the old answer: 05:00 closed Monday
        self.assertEqual(len(resolve_shift_day(ruleset, MON, by_date, employee_id=self.special_w.id)), 3)
