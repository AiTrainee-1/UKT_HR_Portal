"""
Report Center 2026-11-19 layout - the Shift and Employee Details categories.

    shift:      assigned-shift-report, gained-shift-report, shift-change-history (rc_shift.py), and the recategorised
                shift-wise-attendance / shift-assignment-gaps (attendance_analysis_shifts.py)
    employees:  employee-overall-details, employee-fixed-salary, employee-monthly-shift, employee-time-card,
                employee-punch-details (rc_employee_details.py)

The week Mon 21 - Sun 27 Sep 2026 is seeded with stored day records (what payroll pays: reports never recompute) and the
punches behind them; production days are judged by the shift table from 1 Sep 2026. "Today" is pinned to 5 Oct 2026.
Production join dates are stored as spreadsheet serials ('01-01-45640'), the way the dev / production data has them.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_rc2_shift_emp py -3 manage.py test
         api.tests_reporting_rc_shift_employee
"""

import importlib
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest.mock import patch

import pdfplumber
from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    BiometricDevice,
    Branch,
    CompensationLedger,
    Department,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    OnDutyPunchVerification,
    OnDutySession,
    PayrollSettings,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionSpecialShiftAssignment,
    Role,
    SalaryIncrement,
    ShiftTemplate,
)
from .reporting import registry
from .reporting.definitions.employees_master_base import excel_serial_date, join_date_of
from .reporting.export_xlsx import HEADER_ROW
from .reporting.layout import LAYOUT

TODAY = date(2026, 10, 5)
MON = date(2026, 9, 21)
TUE, WED, THU, FRI, SAT, SUN = (MON + timedelta(days=i) for i in range(1, 7))
WEEK = {"dateFrom": "2026-09-21", "dateTo": "2026-09-27"}
SHIFT_IDS = ("assigned-shift-report", "gained-shift-report", "shift-change-history")
RECAT_IDS = ("shift-wise-attendance", "shift-assignment-gaps")
EMP_IDS = (
    "employee-overall-details",
    "employee-fixed-salary",
    "employee-monthly-shift",
    "employee-time-card",
    "employee-punch-details",
)
ALL_IDS = SHIFT_IDS + RECAT_IDS + EMP_IDS
ADMS = "biometric:adms:SN1"


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def at(text: str) -> time:
    return time(*[int(x) for x in text.split(":")])


def punch(emp, day, *times, source=ADMS):
    for text in times:
        AttendanceLog.objects.create(employee=emp, date=day, punch_time=at(text), punch_type="IN", source=source)


def record(emp, day, status, shifts, first=None, last=None, **kw):
    kw.setdefault("total_punches", 0)
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=day,
        status=status,
        shifts_earned=Decimal(shifts),
        first_punch=at(first) if first else None,
        last_punch=at(last) if last else None,
        **kw,
    )


def _ensure_production_rules():
    """The migration seeds the Day / Night / Sunday groups and the breaks (a TransactionTestCase may have flushed them);
    the shift table judges production days from 1 Sep 2026."""
    if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)
    config = ProductionShiftConfig.get()
    config.rules_effective_from = date(2026, 9, 1)
    config.rules_enabled = True
    config.save()


def data(body) -> list[dict]:
    return [r for r in body["rows"] if not r.get("_kind")]


def cards(body) -> dict:
    return {c["label"]: c["value"] for c in body["summary"]}


class _World(TestCase):
    @classmethod
    def setUpTestData(cls):
        _ensure_production_rules()
        PayrollSettings.get()
        cls.b1 = Branch.objects.create(name="Unit 1", code="RU1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="RU2")
        cls.admin_dept = Department.objects.create(name="ADMIN", branch=cls.b1)
        cls.stitch = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.other_dept = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.clerk = Designation.objects.create(title="Clerk")
        cls.operator = Designation.objects.create(title="Operator")

        cls.general = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=at("09:00"),
            end_time=at("18:00"),
            grace_period_minutes=15,
            first_half_end=at("13:30"),
            lunch_duration_minutes=60,
        )
        cls.late_general = ShiftTemplate.objects.create(
            name="Late General", shift_type="staff", start_time=at("10:00"), end_time=at("19:00")
        )
        cls.prod_shift = ShiftTemplate.objects.create(
            name="Production Shift", shift_type="production", start_time=at("08:30"), end_time=at("20:00")
        )

        def mk(code, first, **kw):
            kw.setdefault("employment_type", "staff")
            kw.setdefault("branch", cls.b1)
            kw.setdefault("department", cls.admin_dept if kw["employment_type"] == "staff" else cls.stitch)
            kw.setdefault("designation", cls.clerk if kw["employment_type"] == "staff" else cls.operator)
            return Employee.objects.create(employee_code=code, first_name=first, last_name="T", **kw)

        cls.s1 = mk(
            "RS001",
            "Sita",
            join_date="2024-01-10",
            salary_amount=Decimal("30000"),
            co_emp_enabled=True,
            bank_name="State Bank",
            bank_ifsc="SBIN0001",
            bank_account="1234 5678 9012",
            pf_number="PF123",
            esi_number="ESI9",
            uan_number="UAN1",
            father_name="Raman",
            gender="female",
        )
        cls.s2 = mk("RS002", "Ravi", join_date="2026-09-24", salary_amount=Decimal("20000"), tds_enabled=True)
        Employee.objects.filter(pk=cls.s2.pk).update(tds_percent=Decimal("10"))
        cls.p1 = mk(
            "RP001",
            "Pandi",
            employment_type="production",
            join_date="01-01-45640",  # 14-Dec-2024 as a spreadsheet serial
            salary_per_shift=Decimal("500"),
            production_pay_cycle="weekly",
        )
        cls.p2 = mk("RP002", "Nila", employment_type="production", join_date="01-01-45000")  # a night worker
        cls.p3 = mk("RP003", "Kumar", employment_type="production", join_date="01-01-46280")  # 15-Sep-2026, no template
        cls.x1 = mk("RX009", "Stranger", branch=cls.b2, department=cls.other_dept, join_date="2024-01-01")

        # shifts: s1 General until 30 Sep, then Late General (a shift change); s2 from 25 Sep (joined the 24th) and a
        # later one cancelled before it started; production on the template since 2020 (re-saved the same day)
        def assign(emp, shift, start, end=None, **kw):
            return EmployeeShiftAssignment.objects.create(
                employee=emp, shift=shift, effective_from=start, effective_to=end, **kw
            )

        cls.a_s1_old = assign(cls.s1, cls.general, date(2020, 1, 1), date(2026, 9, 30), assigned_by="HR")
        cls.a_s1_new = assign(cls.s1, cls.late_general, date(2026, 10, 1), assigned_by="HR Anita", notes="Moved")
        EmployeeShiftAssignment.objects.filter(pk=cls.a_s1_new.pk).update(
            created_at=datetime(2026, 9, 15, 10, 0, tzinfo=FACTORY_TZ)
        )
        assign(cls.s2, cls.general, date(2026, 9, 25), assigned_by="HR")
        assign(cls.s2, cls.late_general, date(2026, 10, 10), date(2026, 10, 9), assigned_by="HR")  # cancelled
        for emp in (cls.p1, cls.p2):
            assign(emp, cls.prod_shift, date(2020, 1, 1), date(2020, 1, 1), assigned_by="HR")
            assign(emp, cls.prod_shift, date(2020, 1, 1), assigned_by="HR (bulk)")
        assign(cls.x1, cls.general, date(2020, 1, 1))

        cls.special = ProductionShiftGroup.objects.create(
            label="Early special",
            kind="custom",
            applies_on="all",
            start_time=at("07:00"),
            first_punch_from=at("06:00"),
            first_punch_to=at("08:00"),
            main_out_time=at("15:00"),
            is_special=True,
            order=99,
        )
        ProductionSpecialShiftAssignment.objects.create(
            employee=cls.p3, group=cls.special, effective_from=date(2026, 9, 20), created_by="HR Bala"
        )

        # s1: on time Mon, a quarter-shift Tue, Penalty Early Out Wed, absent Thu, CL Fri, half Sat, Sunday off
        punch(cls.s1, MON, "08:55", "13:00", "13:45", "18:05")
        punch(cls.s1, TUE, "10:20", "18:00")
        punch(cls.s1, WED, "09:00", "16:00")
        punch(cls.s1, THU, "09:05:00", source="on_duty:approved")
        punch(cls.s1, SAT, "14:00", "18:00")
        record(cls.s1, MON, "present", "1.00", "08:55", "18:05", arrival_zone="on_time", total_punches=4)
        record(cls.s1, TUE, "present", "0.75", "10:20", "18:00", arrival_zone="quarter", total_punches=2)
        record(
            cls.s1,
            WED,
            "present",
            "0.75",
            "09:00",
            "16:00",
            arrival_zone="on_time",
            penalty_early_out=True,
            penalty_deduction=Decimal("0.25"),
            total_punches=2,
        )
        record(cls.s1, THU, "absent", "0.00", "09:05", total_punches=1)
        record(cls.s1, FRI, "present", "1.00", source="manual", override_note="Casual Leave (paid)")
        record(cls.s1, SAT, "half_shift", "0.50", "14:00", "18:00", arrival_zone="second_half", total_punches=2)
        record(cls.s1, SUN, "holiday", "0.00")
        # s2 joined Thursday: an office geo punch that day
        punch(cls.s2, THU, "09:00", source="geo:auto")
        record(cls.s2, THU, "half_shift", "0.50", "09:00", total_punches=1)
        # p1: 1.50 Monday (day shift to 20:00), 2.72 Tuesday (stored before quarter rounding), absent Wednesday
        punch(cls.p1, MON, "08:30", "12:45", "13:30", "20:00")
        punch(cls.p1, TUE, "08:30", "12:45", "13:30", "22:30")
        record(cls.p1, MON, "present", "1.50", "08:30", "20:00", total_punches=4)
        record(cls.p1, TUE, "present", "2.72", "08:30", "22:30", total_punches=4)
        record(cls.p1, WED, "absent", "0.00")
        # p2: a night shift Mon 21:00 -> Tue 05:30 (the closing punch belongs to Monday's shift day)
        punch(cls.p2, MON, "21:00:05")
        punch(cls.p2, TUE, "05:30:10")
        record(cls.p2, MON, "present", "1.50", "21:00:05", "05:30:10", total_punches=2)
        record(cls.p2, TUE, "absent", "0.00", total_punches=1)
        # the other unit
        punch(cls.x1, MON, "09:00", "18:00")
        record(cls.x1, MON, "present", "1.00", "09:00", "18:00", total_punches=2)

        BiometricDevice.objects.create(name="Main Gate", serial_number="SN1")
        session = OnDutySession.objects.create(employee=cls.s1, destination="Client site", status="completed")
        OnDutyPunchVerification.objects.create(
            session=session,
            employee=cls.s1,
            punch_date=THU,
            punch_time=at("09:05:00"),
            punch_type="IN",
            punch_number=1,
            latitude=Decimal("11.100000"),
            longitude=Decimal("77.300000"),
            accuracy_m=12.4,
            status="approved",
        )
        CompensationLedger.objects.create(
            employee=cls.s1, entry_type="credit", shifts=Decimal("1.00"), date=SUN, source="holiday_work"
        )
        SalaryIncrement.objects.create(
            employee=cls.s1,
            previous_salary=Decimal("27000"),
            new_salary=Decimal("30000"),
            percent=Decimal("11.11"),
            effective_date=date(2026, 4, 1),
        )

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        everything = {
            "employees": "view",
            "salary": "view",
            "payroll": "view",
            "attendance": "view",
            "shifts": "view",
        }
        cls.admin = HRUser.objects.create(username="rc2_admin", password_hash="x", is_super_admin=True)
        cls.viewer = user("rc2_viewer", everything)  # payroll VIEW: bank accounts masked
        cls.payroll_editor = user("rc2_payedit", {**everything, "payroll": "edit"})
        cls.employees_only = user("rc2_emp", {"employees": "view"})
        cls.no_bank = user("rc2_nobank", {**everything, "employees.profile.bank": "hidden"})
        cls.scoped = user("rc2_b1", everything, branch=cls.b1)

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def get(self, rid, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r.json()

    def export(self, rid, fmt, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:300])
        return r

    def row_of(self, body, code, **match) -> dict:
        rows = [r for r in data(body) if r.get("employeeCode") == code and all(r.get(k) == v for k, v in match.items())]
        self.assertEqual(len(rows), 1, (code, match, rows))
        return rows[0]


# ═════════════════════════════════════════════════════════════════════════════


class LayoutTests(_World):
    def test_ids_categories_and_order(self):
        mine = (".rc_shift", ".rc_employee_details", ".attendance_analysis_shifts", ".employees_master_base")
        self.assertEqual({k: v for k, v in registry.LOAD_ERRORS.items() if k.endswith(mine)}, {})
        for rid in SHIFT_IDS + RECAT_IDS:
            self.assertEqual(registry.get_spec(rid).category, "shift", rid)
        for rid in EMP_IDS:
            self.assertEqual(registry.get_spec(rid).category, "employees", rid)
        self.assertEqual(LAYOUT["shift"], SHIFT_IDS + RECAT_IDS)
        self.assertEqual(LAYOUT["employees"], EMP_IDS)
        catalog = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        listed = [r["id"] for r in catalog["reports"]]
        self.assertEqual([i for i in listed if i in SHIFT_IDS + RECAT_IDS], list(SHIFT_IDS + RECAT_IDS))
        self.assertEqual([i for i in listed if i in EMP_IDS], list(EMP_IDS))

    def test_spec_contract(self):
        for rid in ALL_IDS:
            spec = registry.get_spec(rid)
            self.assertTrue(spec.modules, rid)
            self.assertLessEqual(len(spec.filters), 8, rid)
            self.assertLess(len(spec.description), 220, rid)
            self.assertFalse([f for f in spec.filters if f.required and f.default is None], rid)

    def test_every_report_runs_on_its_defaults_and_exports(self):
        for rid in ALL_IDS:
            with self.subTest(report=rid):
                self.get(rid)
                params = WEEK if rid not in ("employee-overall-details", "employee-fixed-salary") else {}
                if rid == "employee-monthly-shift":
                    params = {"period": "2026-09"}
                x = self.export(rid, "xlsx", **params)
                self.assertTrue(x.content.startswith(b"PK"))
                p = self.export(rid, "pdf", **params)
                self.assertTrue(p.content.startswith(b"%PDF"))

    def test_branch_isolation(self):
        lists_people = set(ALL_IDS) - {"shift-change-history", "shift-wise-attendance", "shift-assignment-gaps"}
        for rid in ALL_IDS:
            with self.subTest(report=rid):
                params = {"period": "2026-09"} if rid == "employee-monthly-shift" else WEEK
                self.assertNotIn("RX009", str(self.get(rid, self.scoped, **params)))
                if rid in lists_people:  # an unscoped admin does see the other unit's employee
                    self.assertIn("RX009", str(self.get(rid, **params)))
                x = self.export(rid, "xlsx", self.scoped, **params)
                ws = load_workbook(io.BytesIO(x.content)).active
                self.assertNotIn("RX009", " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value))

    def test_query_count_does_not_grow_with_employees(self):
        params = {
            "assigned-shift-report": WEEK,
            "gained-shift-report": WEEK,
            "shift-change-history": {"dateFrom": "2020-01-01", "dateTo": "2022-12-31"},
            "shift-wise-attendance": WEEK,
            "shift-assignment-gaps": WEEK,
            "employee-overall-details": {},
            "employee-fixed-salary": {},
            "employee-monthly-shift": {"period": "2026-09"},
            "employee-time-card": WEEK,
            "employee-punch-details": WEEK,
        }

        def counts():
            out = {}
            for rid, p in params.items():
                with CaptureQueriesContext(connection) as q:
                    self.get(rid, **p)
                out[rid] = len(q)
            return out

        before = counts()
        for i in range(12):
            e = Employee.objects.create(
                employee_code=f"RQ{i:03d}",
                first_name="Bulk",
                last_name=str(i),
                employment_type="production" if i % 2 else "staff",
                branch=self.b1,
                department=self.admin_dept,
                designation=self.clerk,
                join_date="01-01-45000" if i % 2 else "2024-01-01",
                salary_amount=Decimal("15000"),
                bank_account="99990000",
            )
            EmployeeShiftAssignment.objects.create(employee=e, shift=self.general, effective_from=date(2020, 1, 1))
            punch(e, MON, "09:00", "18:00")
            record(e, MON, "present", "1.00", "09:00", "18:00", total_punches=2)
        after = counts()
        for rid in params:
            self.assertLessEqual(after[rid], before[rid], (rid, before[rid], after[rid]))
            self.assertLessEqual(after[rid], 25, rid)


class JoinDateTests(_World):
    def test_the_serial_decoder_is_opt_in(self):
        self.assertEqual(excel_serial_date("01-01-45640"), date(2024, 12, 14))
        self.assertEqual(excel_serial_date("45640"), date(2024, 12, 14))
        self.assertIsNone(excel_serial_date("01-01-99999"))  # beyond 2100: not a hire date
        self.assertIsNone(excel_serial_date("2024-12-14"))
        self.assertEqual(join_date_of(self.p1), (None, "unreadable"))  # the default the HR reports keep
        self.assertEqual(join_date_of(self.p1, decode_serial=True), (date(2024, 12, 14), "serial"))
        self.assertEqual(join_date_of(self.s1, decode_serial=True), (date(2024, 1, 10), "ok"))

    def test_hr_reports_keep_their_output(self):
        body = self.get("employee-confo-details", employeeIds=str(self.p1.id))
        self.assertIsNone(self.row_of(body, "RP001")["joinDate"])

    def test_production_absences_count_on_shift_wise_attendance(self):
        # the plain parser read p1's join date as year 4564 and masked the absence: no production line at all
        body = self.get("shift-wise-attendance", dateFrom="2026-09-23", dateTo="2026-09-23")
        rows = {r["shiftName"]: r for r in data(body)}
        self.assertEqual((rows["Production Shift"]["headcount"], rows["Production Shift"]["absent"]), (1, 1))
        self.assertEqual(rows["General"]["present"], 1)
        self.assertEqual(rows["General"]["shiftCredit"], 0.75)

    def test_shift_gaps_see_a_production_worker_with_a_serial_join_date(self):
        body = self.get("shift-assignment-gaps", **WEEK)
        gaps = {(r["employeeCode"], r["issue"]): r for r in data(body)}
        self.assertIn("No shift on 7 of 7 day(s)", gaps[("RP003", "No shift assigned")]["detail"])
        # s2 joined on the 24th and has a shift from the 25th: one day uncovered
        self.assertIn("No shift on 1 of 4 day(s)", gaps[("RS002", "No shift assigned")]["detail"])
        self.assertNotIn(("RP001", "No shift assigned"), gaps)


class AssignedShiftTests(_World):
    def test_template_and_special_shifts(self):
        body = self.get("assigned-shift-report", **WEEK)
        s1 = self.row_of(body, "RS001")
        self.assertEqual((s1["shiftName"], s1["shiftType"], s1["startTime"]), ("General", "Staff", "09:00"))
        special = self.row_of(body, "RP003")
        self.assertEqual((special["shiftName"], special["shiftType"]), ("Early special", "Production special"))
        self.assertEqual(
            (special["startTime"], special["endTime"], special["assignedBy"]), ("07:00", "15:00", "HR Bala")
        )
        self.assertEqual(cards(body)["Production special shifts"], 1)
        staff_only = self.get("assigned-shift-report", shiftType="staff", **WEEK)
        self.assertNotIn("RP003", [r["employeeCode"] for r in data(staff_only)])


class GainedShiftTests(_World):
    def test_day_cells_and_totals(self):
        body = self.get("gained-shift-report", **WEEK)
        s1 = self.row_of(body, "RS001")
        cells = [s1[f"d202609{d}"] for d in range(21, 28)]
        self.assertEqual(cells, ["1", "0.75", "0.75", "A", "CL", "0.5", "WO"])
        self.assertEqual(s1["shiftsEarned"], 4.0)
        self.assertEqual((s1["daysWorked"], s1["creditShifts"], s1["quarterDays"]), (4, 1.0, 1))
        self.assertEqual((s1["penaltyShifts"], s1["balanceCredits"]), (0.25, 1.0))
        s2 = self.row_of(body, "RS002")
        self.assertEqual([s2[f"d202609{d}"] for d in range(21, 25)], ["NA", "NA", "NA", "0.5"])
        p1 = self.row_of(body, "RP001")
        self.assertEqual([p1[f"d202609{d}"] for d in (21, 22, 23)], ["1.5", "2.72*", "A"])
        self.assertEqual((p1["shiftsEarned"], p1["outOfDate"]), (4.22, 1))
        p2 = self.row_of(body, "RP002")
        self.assertEqual((p2["d20260921"], p2["d20260922"]), ("1.5", "A"))
        total_row = next(r for r in body["rows"] if r.get("_kind") == "total")
        self.assertEqual(total_row["d20260921"], "5")  # s1 1 + p1 1.5 + p2 1.5 + the other unit's 1
        self.assertAlmostEqual(body["totals"]["shiftsEarned"], 4.0 + 0.5 + 4.22 + 1.5 + 1.0)
        scoped = self.get("gained-shift-report", self.scoped, **WEEK)
        self.assertEqual(next(r for r in scoped["rows"] if r.get("_kind") == "total")["d20260921"], "4")
        self.assertTrue(any("2.72" in n or "quarters" in n for n in body["notes"]))
        self.assertTrue(any("spreadsheet number" in n for n in body["notes"]))

    def test_employee_type_filter(self):
        body = self.get("gained-shift-report", employmentType="production", **WEEK)
        self.assertEqual({r["employeeCode"] for r in data(body)}, {"RP001", "RP002", "RP003"})

    def test_grid_exports(self):
        x = self.export("gained-shift-report", "xlsx", **WEEK)
        ws = load_workbook(io.BytesIO(x.content)).active
        header = [c.value for c in ws[HEADER_ROW]]
        self.assertIn("21 Mon", header)
        col = header.index("22 Tue") + 1
        row = next(r for r in range(HEADER_ROW + 1, ws.max_row + 1) if ws.cell(row=r, column=1).value == "RP001")
        self.assertEqual(ws.cell(row=row, column=col).value, "2.72*")
        self.assertEqual(ws.cell(row=row, column=col).fill.fgColor.rgb[-6:], "FED7AA")
        pdf = self.export("gained-shift-report", "pdf", **WEEK)
        with pdfplumber.open(io.BytesIO(pdf.content)) as doc:
            text = doc.pages[0].extract_text()
        self.assertIn("GAINED SHIFT REPORT", text)
        self.assertIn("2.72*", text)


class ShiftChangeHistoryTests(_World):
    def test_changes_in_a_period(self):
        body = self.get("shift-change-history", dateFrom="2026-09-01", dateTo="2026-10-31")
        change = self.row_of(body, "RS001")
        self.assertEqual(
            (change["change"], change["fromShift"], change["toShift"]), ("Shift changed", "General", "Late General")
        )
        self.assertEqual(
            (change["assignedBy"], change["recordedAt"], change["notes"]), ("HR Anita", "2026-09-15 10:00", "Moved")
        )
        cancelled = self.row_of(body, "RS002", effectiveFrom="2026-10-10")
        self.assertEqual(cancelled["change"], "Cancelled before it started")
        self.assertEqual(self.row_of(body, "RS002", effectiveFrom="2026-09-25")["change"], "New assignment")
        special = self.row_of(body, "RP003")
        self.assertEqual((special["change"], special["toShift"]), ("Production special shift", "Early special"))

    def test_same_day_resave_and_recorded_basis(self):
        body = self.get("shift-change-history", dateFrom="2020-01-01", dateTo="2020-12-31", employeeIds=str(self.p1.id))
        self.assertEqual([r["change"] for r in data(body)], ["New assignment", "Same shift again"])
        rec = self.get("shift-change-history", basis="recorded", dateFrom="2026-09-15", dateTo="2026-09-15")
        self.assertEqual([r["employeeCode"] for r in data(rec)], ["RS001"])
        only = self.get("shift-change-history", change="changed", dateFrom="2020-01-01", dateTo="2022-12-31")
        self.assertEqual(data(only), [])


class OverallDetailsTests(_World):
    def test_details_and_decoded_join_date(self):
        body = self.get("employee-overall-details")
        p1 = self.row_of(body, "RP001")
        self.assertEqual((p1["joinDate"], p1["payCycle"], p1["ratePerShift"]), ("2024-12-14", "Weekly", 500.0))
        self.assertEqual(p1["shift"], "Production Shift")
        s1 = self.row_of(body, "RS001")
        self.assertEqual(
            (s1["statutory"], s1["pfNumber"], s1["monthlySalary"]), ("Co Emp (PF / ESI)", "PF123", 30000.0)
        )
        self.assertEqual(self.row_of(body, "RS002")["statutory"], "TDS 10%")
        self.assertEqual(s1["bankAccount"], "123456789012")  # super admin: payroll edit
        self.assertNotIn("address", {c["key"] for c in body["columns"]})

    def test_bank_masking_and_hidden_columns(self):
        masked = self.row_of(self.get("employee-overall-details", self.viewer), "RS001")
        self.assertEqual(masked["bankAccount"], "********9012")
        full = self.row_of(self.get("employee-overall-details", self.payroll_editor), "RS001")
        self.assertEqual(full["bankAccount"], "123456789012")
        emp_only = self.get("employee-overall-details", self.employees_only)
        keys = {c["key"] for c in emp_only["columns"]}
        self.assertNotIn("monthlySalary", keys)
        self.assertIn("bankAccount", keys)
        self.assertNotIn("monthlySalary", self.row_of(emp_only, "RS001"))
        self.assertNotIn("30000", str(emp_only["rows"]))
        no_bank = self.get("employee-overall-details", self.no_bank)
        keys = {c["key"] for c in no_bank["columns"]}
        self.assertFalse({"bankAccount", "pfNumber", "uanNumber"} & keys)
        self.assertNotIn("bankAccount", self.row_of(no_bank, "RS001"))
        self.assertNotIn("9012", str(no_bank["rows"]))


class FixedSalaryTests(_World):
    def test_split_statutory_bank_and_increment(self):
        body = self.get("employee-fixed-salary", self.viewer)
        s1 = self.row_of(body, "RS001")
        self.assertEqual(
            (s1["monthlySalary"], s1["splitBasic"], s1["firstPortion"], s1["secondPortion"]),
            (30000.0, 5000.0, 15000.0, 15000.0),
        )
        self.assertEqual((s1["splitHra"], s1["splitState"]), (3000.0, "Automatic"))
        self.assertTrue(s1["pfEsi"].startswith(("PF", "ESI", "Co Emp")), s1["pfEsi"])
        self.assertEqual(self.row_of(body, "RS002")["pfEsi"], "TDS 10%")
        self.assertEqual(s1["bankAccount"], "********9012")
        self.assertEqual(
            (s1["lastIncrementDate"], s1["lastIncrementPct"], s1["initialSalary"]), ("2026-04-01", 11.11, 27000.0)
        )
        p1 = self.row_of(body, "RP001")
        self.assertEqual((p1["payBasis"], p1["ratePerShift"], p1["joinDate"]), ("Per shift", 500.0, "2024-12-14"))

    def test_needs_salary_or_payroll(self):
        self.get("employee-fixed-salary", self.employees_only, expect=403)

    def test_payroll_alone_never_shows_production_rates(self):
        # Production Payroll does not inherit from Payroll: rates follow the Salary category's per-kind rule
        role = Role.objects.create(name="rc2_payonly", permissions={"reports": "view", "payroll": "view"})
        pay_only = HRUser.objects.create(username="rc2_payonly", password_hash="x", role=role)
        body = self.get("employee-fixed-salary", pay_only)
        types = {r["employmentType"] for r in body["rows"]}
        self.assertTrue(types and all("roduction" not in str(t) for t in types), types)
        self.assertNotIn("RP001", str(body["rows"]))
        self.assertTrue(any("production" in n.lower() for n in body["notes"]), body["notes"])

        role = Role.objects.create(name="rc2_prodpay", permissions={"reports": "view", "production_payroll": "view"})
        prod_only = HRUser.objects.create(username="rc2_prodpay", password_hash="x", role=role)
        body = self.get("employee-fixed-salary", prod_only)
        self.assertEqual(self.row_of(body, "RP001")["ratePerShift"], 500.0)
        self.assertNotIn("RS001", str(body["rows"]))


class MonthlyShiftTests(_World):
    def test_days_rules_and_flags(self):
        body = self.get(
            "employee-monthly-shift", period="2026-09", employeeIds=f"{self.s1.id},{self.p1.id},{self.p2.id}"
        )
        tue = self.row_of(body, "RS001", date="2026-09-22")
        self.assertEqual(
            (tue["assignedShift"], tue["timings"], tue["dayRule"]), ("General", "09:00-18:00", "Quarter shift")
        )
        self.assertIn("Quarter shift (-0.25)", tue["flags"])
        self.assertIn("Penalty early out (-0.25)", self.row_of(body, "RS001", date="2026-09-23")["flags"])
        self.assertEqual(self.row_of(body, "RS001", date="2026-09-25")["status"], "Casual Leave")
        self.assertEqual(self.row_of(body, "RS001", date="2026-09-01")["status"], "Not processed")
        night = self.row_of(body, "RP002", date="2026-09-21")
        self.assertEqual(
            (night["dayRule"], night["shiftsEarned"], night["assignedShift"]), ("Night shift", 1.5, "Production Shift")
        )
        self.assertIn("Out of date", self.row_of(body, "RP001", date="2026-09-22")["flags"])
        sub = [r for r in body["rows"] if r.get("_kind") == "subtotal"]
        self.assertIn("Sita T (RS001) total", [r["employeeName"] for r in sub])

    def test_days_before_joining_are_not_listed(self):
        body = self.get("employee-monthly-shift", period="2026-09", employeeIds=str(self.s2.id))
        self.assertEqual(min(r["date"] for r in data(body)), "2026-09-24")


class TimeCardTests(_World):
    def test_staff_by_calendar_day_production_by_shift_day(self):
        body = self.get("employee-time-card", employeeIds=f"{self.s1.id},{self.p2.id}", **WEEK)
        mon = self.row_of(body, "RS001", date="2026-09-21")
        self.assertEqual((mon["in1"], mon["out1"], mon["in2"], mon["out2"]), ("08:55", "13:00", "13:45", "18:05"))
        self.assertEqual((mon["workedHours"], mon["shift"], mon["status"]), (8.42, "General", "Present"))
        self.assertEqual(self.row_of(body, "RS001", date="2026-09-25")["status"], "Casual Leave")
        self.assertIn("Quarter shift", self.row_of(body, "RS001", date="2026-09-22")["remarks"])
        night = self.row_of(body, "RP002", date="2026-09-21")
        self.assertEqual(
            (night["punches"], night["shift"], night["shiftsEarned"]), ("21:00, 05:30 (+1)", "Night shift", 1.5)
        )
        pdf = self.export("employee-time-card", "pdf", employeeIds=f"{self.s1.id},{self.p2.id}", **WEEK)
        with pdfplumber.open(io.BytesIO(pdf.content)) as doc:
            self.assertEqual(len(doc.pages), 2)
            self.assertIn("TIME CARD", doc.pages[0].extract_text())

    def test_production_worker_with_a_serial_join_date_is_on_the_rolls(self):
        body = self.get("employee-time-card", employeeIds=str(self.p1.id), **WEEK)
        self.assertEqual(len(data(body)), 7)
        self.assertEqual(self.row_of(body, "RP001", date="2026-09-21")["shift"], "Day shift")


class PunchDetailsTests(_World):
    def test_counts_for_source_device_and_location(self):
        body = self.get("employee-punch-details", **WEEK)
        close = self.row_of(body, "RP002", punchDate="2026-09-22")
        self.assertEqual((close["countsFor"], close["punchNo"], close["direction"]), ("2026-09-21", 2, "OUT"))
        self.assertEqual(close["placement"], "Closes the previous day's shift")
        first = self.row_of(body, "RS001", punchDate="2026-09-21", punchTime="08:55:00")
        self.assertEqual((first["device"], first["source"], first["direction"]), ("Main Gate (SN1)", "Biometric", "IN"))
        duty = self.row_of(body, "RS001", punchDate="2026-09-24")
        self.assertEqual((duty["source"], duty["location"]), ("On-Duty", "11.10000, 77.30000 (±12 m)"))
        geo = self.row_of(body, "RS002", punchDate="2026-09-24")
        self.assertEqual(geo["location"], "Inside the Unit 1 geofence (location not stored)")
        self.assertEqual(cards(body)["Closing the previous day"], 1)
