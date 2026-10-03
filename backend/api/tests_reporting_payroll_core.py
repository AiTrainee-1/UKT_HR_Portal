"""
Report Center - payroll_core group: salary-slip, salary-register, salary-wages-statement, bank-advice,
salary-deduction-summary, department-salary-cost, production-wage-sheet, payroll-month-comparison,
annual-earnings-statement, payroll-payment-status, salary-master, employer-cost-ctc.

Salary slips are generated through the REAL payroll engines (payroll_views._generate_staff_payroll /
_generate_production_payroll), fed with manual AttendanceDayRecord rows exactly like tests_payroll_engine.py, so every
expected number below is plain arithmetic on the engine's own output.

Calendar: February 2026 starts on a Sunday and has exactly 24 Mon-Sat working days, so a salary of 24,000 has a daily
rate of exactly 1,000. January 2026 / March 2026 slips exist for two employees so the financial-year reports (FY 2025-26,
April start) have three months of data.

Run via: python manage.py test api.tests_reporting_payroll_core -v 2   (or through the throw-away-DB harness)
"""

import io
from datetime import date, datetime, time, timezone
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .compensation_views import _compensation_dict
from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    AuditLog,
    Branch,
    BranchSettingsOverride,
    Department,
    Designation,
    Employee,
    HRUser,
    OvertimeRecord,
    Payroll,
    PayrollSettings,
    Role,
    SalaryIncrement,
    SalarySlip,
)
from .payroll_views import _build_working_days, _generate_production_payroll, _generate_staff_payroll
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.definitions import payroll_core_common as common
from .reporting.definitions import payroll_core_slips as slips_module

IDS = [
    "salary-slip",
    "salary-register",
    "salary-wages-statement",
    "bank-advice",
    "salary-deduction-summary",
    "department-salary-cost",
    "production-wage-sheet",
    "payroll-month-comparison",
    "annual-earnings-statement",
    "payroll-payment-status",
    "salary-master",
    "employer-cost-ctc",
]
FEB = {"period": "2026-02"}
FY = {"financialYear": "2025-26"}
XLSX_MAGIC = b"PK"


def _hdr(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _configure(**fields):
    ps = PayrollSettings.get()
    for k, v in fields.items():
        setattr(ps, k, v)
    ps.save()
    return ps


def _day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"),
        source="manual",
        **kw,
    )


def _present_month(emp, year, month, days=None, **kw):
    for d in days if days is not None else _build_working_days(month, year, False, set()):
        _day(emp, d, **kw)


def _body_rows(body):
    return [r for r in body["rows"] if r.get("_kind") is None]


def _by_code(body, code, period=None):
    for r in _body_rows(body):
        if r.get("employeeCode") == code and (period is None or r.get("period") == period):
            return r
    raise AssertionError(f"no row for {code} {period} in {[r.get('employeeCode') for r in _body_rows(body)]}")


class PayrollCoreBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.cutting = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.sewing = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.finish = Department.objects.create(name="FINISHING", branch=cls.b2)
        cls.operator = Designation.objects.create(title="Operator")
        cls.supervisor = Designation.objects.create(title="Supervisor")

        _configure(
            staff_payroll_rules_enabled=True,
            pf_rate=Decimal("12"),
            esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"),
            late_free_allowance=1,
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}, {"fromLates": 4, "deductionShifts": 1}],
            permission_monthly_cap=3,
            attendance_mode="simple",
            compensation_feature_enabled=True,
            prod_payroll_rules_enabled=True,
            prod_pf_rate=Decimal("12"),
            prod_esi_rate=Decimal("0.75"),
            prod_esi_applicable_below=Decimal("21000"),
            prod_pf_ef_enabled=False,
            prod_pf_ef_rules=[],
            prod_late_detection_enabled=False,
            bonus_fy_start_month=4,
        )

        def staff(code, first, salary, dept, branch, desig=None, **kw):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="Test",
                employment_type="staff",
                department=dept,
                designation=desig,
                branch=branch,
                salary_type="monthly",
                salary_amount=Decimal(salary),
                **kw,
            )

        def prod(code, first, rate, dept, branch, desig=None, **kw):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="Prod",
                employment_type="production",
                department=dept,
                designation=desig,
                branch=branch,
                salary_per_shift=Decimal(rate),
                **kw,
            )

        cls.e1 = staff(
            "1001",
            "Anita",
            "24000.00",
            cls.cutting,
            cls.b1,
            cls.supervisor,
            join_date="2024-04-15",
            bank_name="HDFC Bank",
            bank_account="50100012345678",
            bank_ifsc="HDFC0001234",
            pf_number="PF/001",
        )
        cls.e2 = staff(
            "1002", "Bala", "20400.00", cls.sewing, cls.b1, cls.operator, join_date="15/06/2023", esi_number="ESI-77"
        )
        cls.e3 = staff(
            "1003",
            "Chitra",
            "30000.00",
            cls.finish,
            cls.b2,
            cls.operator,
            join_date="2022-01-10",
            bank_name="State Bank",
            bank_account="3000 1122 3344",
            bank_ifsc="sbin 0001234",
        )
        cls.e4 = staff(
            "1004",
            "Deepak",
            "12000.00",
            None,
            cls.b1,
            None,
            join_date="sometime",
            status="inactive",
            bank_name="HDFC Bank",
            bank_account="50100012345678",
            bank_ifsc="HDFC0001234",
        )
        cls.e5 = staff("73", "Zed", "15000.00", cls.sewing, cls.b1, cls.operator, join_date="2025-08-01")
        cls.p1 = prod(
            "2001",
            "Esha",
            "500.00",
            cls.cutting,
            cls.b1,
            cls.operator,
            bank_name="ICICI Bank",
            bank_account="6000111122223333",
            bank_ifsc="ICIC0000456",
        )
        cls.p2 = prod("2002", "Farook", "400.00", cls.finish, cls.b2, cls.operator)
        cls.staff_all = [cls.e1, cls.e2, cls.e3, cls.e4, cls.e5]

        # ── February 2026 attendance (manual rows are authoritative) ──
        feb = _build_working_days(2, 2026, False, set())
        assert len(feb) == 24
        for e in (cls.e1, cls.e3, cls.e4, cls.e5):
            _present_month(e, 2026, 2)
        _present_month(cls.e2, 2026, 2, feb[:15])
        for d in feb[15:18]:
            _day(cls.e2, d, is_late=True)  # 18 present, 3 of them late; 6 days without a record are absent
        # one announced pay-type overtime day for Anita
        OvertimeRecord.objects.create(
            employee=cls.e1,
            date=date(2026, 2, 2),
            last_punch_out=time(20, 0),
            ot_minutes=120,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_PAY,
        )
        adv = Advance.objects.create(
            employee=cls.e1,
            advance_type="term",
            amount=Decimal("5000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("5000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=2, year=2026, amount=Decimal("2000"))
        AdvanceRepayment.objects.create(advance=adv, month=3, year=2026, amount=Decimal("3000"))
        adv_p = Advance.objects.create(
            employee=cls.p1,
            advance_type="general",
            amount=Decimal("1000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("1000"),
        )
        AdvanceRepayment.objects.create(advance=adv_p, month=2, year=2026, amount=Decimal("1000"))

        # production attendance: period A = 2-8 Feb, period B = 9-15 Feb, P2 = 2-8 Feb
        for d in (date(2026, 2, 2), date(2026, 2, 3), date(2026, 2, 4)):
            _day(cls.p1, d, shifts="1.50")
        for d in (date(2026, 2, 5), date(2026, 2, 6), date(2026, 2, 7)):
            _day(cls.p1, d, shifts="1.00")
        for d in range(9, 15):
            _day(cls.p1, date(2026, 2, d), shifts="1.00")
        for d in range(2, 7):
            _day(cls.p2, date(2026, 2, d), shifts="1.00")

        # ── payroll generation through the real engines ──
        for e in cls.staff_all:
            _generate_staff_payroll(e, 2, 2026)
        _generate_production_payroll(cls.p1, date(2026, 2, 2), date(2026, 2, 8))
        _generate_production_payroll(cls.p1, date(2026, 2, 9), date(2026, 2, 15))
        _generate_production_payroll(cls.p2, date(2026, 2, 2), date(2026, 2, 8))

        # January and March 2026 for two staff (financial-year reports)
        for e in (cls.e1, cls.e3):
            for m in (1, 3):
                _present_month(e, 2026, m)
                _generate_staff_payroll(e, m, 2026)

        # ── payment state ──
        Payroll.objects.filter(employee=cls.e1, month=2, year=2026).update(status="paid")
        Payroll.objects.filter(employee=cls.p1, period_start=date(2026, 2, 2)).update(status="paid")
        # Payroll PATCH defect: final_salary differs from the slip's net for Chitra
        Payroll.objects.filter(employee=cls.e3, month=2, year=2026).update(final_salary=Decimal("28000.00"))

        # a stale legacy weekly production slip for Esha
        cls.legacy = SalarySlip.objects.create(
            employee=cls.p1,
            month=2,
            year=2026,
            week_number=2,
            slip_number="SS/2001/2026/02/W2",
            basic=Decimal("1000"),
            gross_salary=Decimal("1000"),
            net_salary=Decimal("1000"),
            total_deductions=Decimal("0"),
            present_days=Decimal("2.0"),
        )
        Payroll.objects.create(
            employee=cls.p1,
            salary_mode="shift",
            month=2,
            year=2026,
            week_number=2,
            base_salary=Decimal("1000"),
            gross_salary=Decimal("1000"),
            final_salary=Decimal("1000"),
        )

        # ── HR users ──
        cls.admin = HRUser.objects.create(username="pc_admin", password_hash="x", is_super_admin=True)

        def hr(name, perms, branch=None):
            role = Role.objects.create(name=f"pc_{name}", permissions=perms)
            return HRUser.objects.create(username=f"pc_{name}", password_hash="x", role=role, branch=branch)

        cls.hr = hr
        cls.plain = hr("plain", {"reports": "view"})
        cls.payroll_user = hr("payroll", {"reports": "view", "payroll": "view"})
        cls.branch_user = hr(
            "b1",
            {
                "reports": "view",
                "payroll": "view",
                "salary_slip": "view",
                "compensation": "view",
                "increment": "view",
                "production_payroll": "view",
            },
            branch=cls.b1,
        )
        cls.slip_user = hr("slip", {"reports": "view", "salary_slip": "view"})
        cls.prod_user = hr("prod", {"reports": "view", "production_payroll": "view"})
        cls.comp_user = hr("comp", {"reports": "view", "compensation": "view"})
        cls.inc_user = hr("inc", {"reports": "view", "increment": "view"})

    def setUp(self):
        # "today" is pinned so nothing depends on the day the suite runs (provisional flags, default financial year ...)
        patcher = mock.patch("api.reporting.filters.ist_today", return_value=date(2026, 9, 29))
        patcher.start()
        self.addCleanup(patcher.stop)

    # ── helpers ──
    def run_report(self, rid, user=None, **params):
        return self.client.get(f"/api/reports/run/{rid}", params, **_hdr(user or self.admin))

    def body(self, rid, user=None, **params):
        r = self.run_report(rid, user, **params)
        self.assertEqual(r.status_code, 200, r.content[:500])
        return r.json()

    def export(self, rid, fmt, user=None, **params):
        return self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **_hdr(user or self.admin))

    def xlsx(self, rid, user=None, **params):
        r = self.export(rid, "xlsx", user, **params)
        self.assertEqual(r.status_code, 200, r.content[:500])
        return load_workbook(io.BytesIO(r.content))


def _pdf(content):
    """(page count, extracted text) of a generated PDF."""
    import pdfplumber

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return len(pdf.pages), "\n".join((p.extract_text() or "") for p in pdf.pages)


def _assert_totals_match(tc, body, skip=()):
    """Totals row == sum of the data rows; every subtotal == the sum of the rows above it (since the last subtotal)."""
    cols = {c["key"]: c for c in body["columns"] if c["total"] == "sum"}
    data = _body_rows(body)
    for key in cols:
        if key in skip:
            continue
        expected = round(sum(r[key] or 0 for r in data), 2)
        tc.assertAlmostEqual((body["totals"] or {}).get(key) or 0, expected, places=2, msg=f"total of {key}")
    run = []
    for r in body["rows"]:
        if r.get("_kind") == "subtotal":
            for key in cols:
                if key in skip or key not in r:
                    continue
                tc.assertAlmostEqual(
                    r[key] or 0, round(sum(x[key] or 0 for x in run), 2), places=2, msg=f"subtotal {key}"
                )
            run = []
        else:
            run.append(r)


# ═════════════════════════════════════════════════════════════════════════════
#  pure helpers
# ═════════════════════════════════════════════════════════════════════════════


def _slip(**kw):
    base = dict(
        employee_id=1,
        month=2,
        year=2026,
        week_number=None,
        slip_number="X",
        basic=Decimal("0"),
        hra=Decimal("0"),
        allowances=Decimal("0"),
        incentives=Decimal("0"),
        bonuses=Decimal("0"),
        ot_amount=Decimal("0"),
        gross_salary=Decimal("0"),
        pf_deduction=Decimal("0"),
        esi_deduction=Decimal("0"),
        advance_deduction=Decimal("0"),
        other_deductions=Decimal("0"),
        total_deductions=Decimal("0"),
        net_salary=Decimal("0"),
        working_days=24,
        present_days=Decimal("0"),
        absent_days=Decimal("0"),
        paid_leave_days=Decimal("0"),
        unpaid_leave_days=Decimal("0"),
        late_days=0,
    )
    base.update(kw)
    return SalarySlip(**base)


PAST = date(2026, 9, 29)


class DeriveTests(TestCase):
    def test_staff_slip_without_a_snapshot_falls_back_to_stored_columns(self):
        s = _slip(
            gross_salary=Decimal("10000"),
            ot_amount=Decimal("500"),
            pf_deduction=Decimal("600"),
            advance_deduction=Decimal("100"),
            other_deductions=Decimal("50"),
            total_deductions=Decimal("750"),
            net_salary=Decimal("9750"),
            present_days=Decimal("20.0"),
            paid_leave_days=Decimal("2.0"),
            basic=Decimal("5000"),
            hra=Decimal("2000"),
            allowances=Decimal("3000"),
        )
        d = common.derive(s, PAST)
        self.assertEqual(d["total_earnings"], 10500.0)  # gross + OT
        self.assertEqual(d["late"], 50.0)  # no snapshot: total less PF/ESI/advance
        self.assertEqual(d["other"], 0.0)
        self.assertEqual(d["residual"], 50.0)
        self.assertEqual(d["paid_days"], 22.0)  # present + paid leave
        self.assertIsNone(d["monthly_rate"])
        self.assertIsNone(d["lop"])
        self.assertFalse(d["provisional"])
        self.assertFalse(d["has_snapshot"])
        self.assertEqual(d["type"], "Staff")

    def test_snapshot_values_win_and_residual_flags_manual_edits(self):
        s = _slip(
            gross_salary=Decimal("10750"),
            total_deductions=Decimal("350"),
            net_salary=Decimal("10400"),
            breakdown_details={
                "summary": {"effectivePaidDays": 21.5},
                "earnings": {"monthlySalary": 12000.0},
                "deductions": {"lateShiftPenalty": 300.0},
            },
        )
        d = common.derive(s, PAST)
        self.assertEqual(d["paid_days"], 21.5)  # effective paid days, not the rounded present_days
        self.assertEqual(d["monthly_rate"], 12000.0)
        self.assertEqual(d["lop"], 1250.0)  # 12000 - 10750
        self.assertEqual(d["late"], 300.0)
        self.assertEqual(d["other"], 50.0)  # 350 total - 300 late: an unexplained (manual / legacy) amount

    def test_production_late_penalty_lives_only_in_total_deductions(self):
        s = _slip(
            period_start=date(2026, 2, 2),
            period_end=date(2026, 2, 8),
            gross_salary=Decimal("3625"),
            basic=Decimal("3625"),
            total_deductions=Decimal("250"),
            net_salary=Decimal("3375"),
            present_days=Decimal("7.3"),  # 7.25 shifts rounded to 1 dp by the column
            breakdown_details={
                "summary": {"totalShifts": 7.25},
                "salaryPerShift": 500.0,
                "deductions": {"lateShiftPenalty": 250.0, "pfEfRule": None},
            },
        )
        d = common.derive(s, PAST)
        self.assertTrue(d["production"])
        self.assertEqual(d["late"], 250.0)
        self.assertEqual(d["other"], 0.0)  # slip.other_deductions is 0 for production yet the total holds the penalty
        self.assertEqual(d["residual"], 250.0)
        self.assertEqual(d["paid_days"], 7.25)  # from the snapshot, not the rounded column
        self.assertEqual(d["monthly_rate"], 500.0)
        self.assertIsNone(d["lop"])
        self.assertFalse(d["provisional"])

    def test_production_with_detection_off_has_no_late_figure(self):
        s = _slip(
            period_start=date(2026, 2, 2),
            period_end=date(2026, 2, 8),
            total_deductions=Decimal("100"),
            pf_deduction=Decimal("100"),
            breakdown_details={"deductions": {"lateShiftPenalty": None, "pf": 100.0}},
        )
        d = common.derive(s, PAST)
        self.assertIsNone(d["late"])
        self.assertEqual(d["other"], 0.0)

    def test_legacy_weekly_slip_is_production_and_labelled(self):
        s = _slip(week_number=2)
        self.assertTrue(common.is_legacy_weekly(s))
        self.assertTrue(common.is_production(s))
        self.assertEqual(common.period_label(s), "Feb 2026 - week 2")
        self.assertEqual(common.type_label(s), "Production")
        self.assertEqual(common.period_label(_slip()), "Feb 2026")
        self.assertEqual(
            common.period_label(_slip(period_start=date(2026, 2, 2), period_end=date(2026, 2, 8))),
            "02-Feb-2026 to 08-Feb-2026",
        )

    def test_provisional_only_for_staff_months_that_have_not_ended(self):
        self.assertTrue(common.is_provisional(_slip(), date(2026, 2, 10)))
        self.assertTrue(common.is_provisional(_slip(), date(2026, 2, 28)))  # the last day is not over yet
        self.assertFalse(common.is_provisional(_slip(), date(2026, 3, 1)))
        self.assertFalse(
            common.is_provisional(_slip(period_start=date(2026, 2, 2), period_end=date(2026, 2, 8)), date(2026, 2, 3))
        )

    def test_annotated_parts_are_used_instead_of_the_full_breakdown(self):
        s = _slip(gross_salary=Decimal("100"), net_salary=Decimal("100"))
        s.bd_summary = {"effectivePaidDays": 20.0}
        s.bd_earn = {"monthlySalary": 150.0}
        s.bd_ded = {"lateShiftPenalty": 0.0}
        s.bd_rate = None
        d = common.derive(s, PAST)
        self.assertEqual((d["paid_days"], d["monthly_rate"], d["lop"], d["late"]), (20.0, 150.0, 50.0, 0.0))


class HelperTests(TestCase):
    def test_natural_code_order(self):
        codes = ["1001", "73", "9", "30005", "A10", "A9", "2001"]
        self.assertEqual(sorted(codes, key=common.nat_key), ["9", "73", "1001", "2001", "30005", "A9", "A10"])
        self.assertEqual(common.nat_key(None), [])

    def test_amount_in_words_keeps_the_paise(self):
        self.assertEqual(common.amount_in_words(12500.50), "Rs. TWELVE THOUSAND FIVE HUNDRED AND FIFTY PAISE ONLY")
        self.assertEqual(common.amount_in_words(100000), "Rs. ONE LAKH ONLY")
        self.assertEqual(common.amount_in_words(0), "Rs. ZERO ONLY")
        self.assertEqual(common.amount_in_words(1.05), "Rs. ONE AND FIVE PAISE ONLY")

    def test_paid_means_the_word_paid_only(self):
        self.assertTrue(common.is_paid({"status": "paid"}))
        self.assertTrue(common.is_paid({"status": " PAID "}))
        self.assertFalse(common.is_paid({"status": "pending"}))
        self.assertFalse(common.is_paid({"status": "processed"}))
        self.assertFalse(common.is_paid({"status": None}))
        self.assertFalse(common.is_paid(None))
        self.assertEqual(common.status_text(None), "Pending")
        self.assertEqual(common.status_text({"status": "paid"}), "Paid")

    def test_payroll_key_separates_staff_months_from_production_periods(self):
        a = common.payroll_key(1, None, None, None, 2026, 2)
        b = common.payroll_key(1, date(2026, 2, 2), date(2026, 2, 8), None, 2026, 2)
        c = common.payroll_key(1, date(2026, 2, 9), date(2026, 2, 15), None, 2026, 2)
        d = common.payroll_key(1, None, None, 2, 2026, 2)
        self.assertEqual(len({a, b, c, d}), 4)

    def test_financial_year_windows(self):
        pairs = common.fy_pairs("2025-26", 4)
        self.assertEqual((pairs[0], pairs[-1], len(pairs)), ((2025, 4), (2026, 3), 12))
        self.assertEqual(common.fy_pairs("2025-26", 1)[0], (2025, 1))
        self.assertEqual(common.current_fy(date(2026, 3, 31), 4), "2025-26")
        self.assertEqual(common.current_fy(date(2026, 4, 1), 4), "2026-27")

    def test_subtotal_of_unknown_values_stays_unknown(self):
        rows = [
            {"g": "A", "employeeName": "x", "late": None, "net": 10},
            {"g": "A", "employeeName": "y", "late": None, "net": 5},
            {"g": "B", "employeeName": "z", "late": 2.5, "net": 1},
            {"g": "B", "employeeName": "w", "late": None, "net": 1},
        ]
        out = common.subtotals(rows, lambda r: r["g"], ["late", "net"])
        subs = [r for r in out if r.get("_kind") == "subtotal"]
        self.assertEqual(
            [(s["employeeName"], s["late"], s["net"]) for s in subs], [("A total", None, 15), ("B total", 2.5, 2)]
        )

    def test_slip_report_helpers(self):
        from .reporting.definitions import payroll_core_analysis as analysis
        from .reporting.definitions import payroll_core_payments as payments

        self.assertEqual(analysis.mask_account("50100012345678"), "XXXXXXXXXX5678")
        self.assertEqual(analysis.mask_account("123"), "XXXX")
        self.assertIsNone(analysis.mask_account("  "))
        self.assertEqual(
            slips_module._month_pairs(date(2026, 1, 15), date(2026, 3, 2)), [(2026, 1), (2026, 2), (2026, 3)]
        )
        self.assertEqual(
            slips_module._extra_shifts({"days": [{"shiftsEarned": 1.5}, {"shiftsEarned": 1.0}, {"shiftsEarned": 1.5}]}),
            1.0,
        )
        self.assertIsNone(slips_module._extra_shifts(None))
        self.assertIsNone(slips_module._extra_shifts({"days": None}))
        self.assertTrue(payments._IFSC.match("HDFC0001234"))
        self.assertFalse(payments._IFSC.match("HDFC1001234"))
        self.assertFalse(payments._IFSC.match("HDF0001234"))
        self.assertEqual(payments._acct(" 3000 1122\t3344 "), "300011223344")
        self.assertEqual(payments._ifsc("sbin 0001234"), "SBIN0001234")


# ═════════════════════════════════════════════════════════════════════════════
#  registry, access, read-only guarantees
# ═════════════════════════════════════════════════════════════════════════════

PERIOD_PARAMS = {
    "salary-slip": FEB,
    "salary-register": FEB,
    "salary-wages-statement": FEB,
    "bank-advice": FEB,
    "salary-deduction-summary": FEB,
    "department-salary-cost": FEB,
    "payroll-month-comparison": FY,
    "annual-earnings-statement": FY,
    "payroll-payment-status": FEB,
    "salary-master": {},
    "employer-cost-ctc": {},
    "production-wage-sheet": {"dateFrom": "2026-02-01", "dateTo": "2026-02-28"},
}
EMPTY_PARAMS = {
    "salary-slip": {"period": "2025-01"},
    "salary-register": {"period": "2025-01"},
    "salary-wages-statement": {"period": "2025-01"},
    "bank-advice": {"period": "2025-01"},
    "salary-deduction-summary": {"period": "2025-01"},
    "department-salary-cost": {"period": "2025-01"},
    "payroll-month-comparison": {"financialYear": "2018-19"},
    "annual-earnings-statement": {"financialYear": "2018-19"},
    "payroll-payment-status": {"period": "2025-01"},
    "salary-master": {"employeeIds": "999999"},
    "employer-cost-ctc": {"employeeIds": "999999"},
    "production-wage-sheet": {"dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
}


class RegistryAccessTests(PayrollCoreBase):
    def test_all_twelve_reports_are_registered_under_payroll(self):
        specs = {s.id: s for s in registry.all_specs()}
        self.assertEqual({k for k in registry.LOAD_ERRORS if "payroll_core" in k}, set())
        for rid in IDS:
            self.assertIn(rid, specs)
            s = specs[rid]
            self.assertEqual(s.category, "payroll", rid)
            self.assertTrue(s.modules, rid)
            for m in s.modules:
                self.assertIn(m, all_module_keys(), f"{rid}: {m}")
            self.assertRegex(s.id, r"^[a-z0-9-]+$")
            self.assertIsNone(s.family)  # no families in this group
            self.assertFalse(s.super_admin_only)

    def test_catalog_lists_them_for_admin_with_both_exports_and_resolved_defaults(self):
        r = self.client.get("/api/reports/catalog", **_hdr(self.admin))
        listed = {x["id"]: x for x in r.json()["reports"]}
        for rid in IDS:
            self.assertEqual(listed[rid]["exports"], ["xlsx", "pdf"])
        keys = {f["key"] for f in listed["salary-slip"]["filters"]}
        self.assertTrue({"period", "department", "designation", "employmentType", "employee", "paymentStatus"} <= keys)
        self.assertRegex(
            next(f for f in listed["salary-slip"]["filters"] if f["key"] == "period")["default"], r"^\d{4}-\d{2}$"
        )
        prod = next(f for f in listed["production-wage-sheet"]["filters"] if f["key"] == "dateRange")
        self.assertEqual(set(prod["default"]), {"dateFrom", "dateTo"})
        # branch-scoped user: no branch picker, and the production sheet has no employee-type picker at all
        scoped = {
            x["id"]: x for x in self.client.get("/api/reports/catalog", **_hdr(self.branch_user)).json()["reports"]
        }
        self.assertNotIn("branch", {f["key"] for f in scoped["salary-register"]["filters"]})
        self.assertNotIn("employmentType", {f["key"] for f in listed["production-wage-sheet"]["filters"]})

    def test_reports_module_alone_opens_none_of_them(self):
        listed = {x["id"] for x in self.client.get("/api/reports/catalog", **_hdr(self.plain)).json()["reports"]}
        for rid in IDS:
            self.assertNotIn(rid, listed)
            for url, extra in (("run", {}), ("export", {"fmt": "xlsx"})):
                r = self.client.get(f"/api/reports/{url}/{rid}", {**PERIOD_PARAMS[rid], **extra}, **_hdr(self.plain))
                self.assertEqual(r.status_code, 403, (rid, url))
                self.assertEqual(r.json()["error"], "report_forbidden", (rid, url))

    def test_each_owning_module_opens_its_reports_and_nothing_else(self):
        ok = lambda user, rid: self.run_report(rid, user, **PERIOD_PARAMS[rid]).status_code  # noqa: E731
        # salary_slip: the slip listing only
        self.assertEqual(ok(self.slip_user, "salary-slip"), 200)
        self.assertEqual(ok(self.slip_user, "salary-register"), 403)
        self.assertEqual(ok(self.slip_user, "bank-advice"), 403)
        # compensation: employer cost only (payroll also opens it)
        self.assertEqual(ok(self.comp_user, "employer-cost-ctc"), 200)
        self.assertEqual(ok(self.comp_user, "salary-slip"), 403)
        self.assertEqual(ok(self.payroll_user, "employer-cost-ctc"), 200)
        # increment / salary / payroll open the salary master
        self.assertEqual(ok(self.inc_user, "salary-master"), 200)
        self.assertEqual(ok(self.inc_user, "salary-register"), 403)
        self.assertEqual(ok(self.payroll_user, "salary-master"), 200)
        # payroll opens every money report
        for rid in IDS:
            self.assertEqual(ok(self.payroll_user, rid), 200, rid)

    def test_a_production_payroll_only_role_sees_production_slips_only(self):
        for rid, params in (
            ("salary-register", FEB),
            ("salary-slip", FEB),
            ("bank-advice", dict(FEB, paymentStatus="all")),
            ("salary-deduction-summary", FEB),
            ("payroll-payment-status", FEB),
        ):
            b = self.body(rid, self.prod_user, **params)
            codes = {r["employeeCode"] for r in _body_rows(b)}
            self.assertEqual(codes, {"2001", "2002"}, rid)
            self.assertTrue(any("production payroll only" in n for n in b["notes"]), rid)
        cost = self.body("department-salary-cost", self.prod_user, **FEB)
        self.assertEqual(cost["totals"]["headcount"], 2)  # P1 and P2 only
        self.assertAlmostEqual(cost["totals"]["netPay"], 6634.37, places=2)
        # a payroll holder is not restricted
        self.assertEqual(len(_body_rows(self.body("salary-register", self.payroll_user, **FEB))), 8)

    def test_screen_runs_never_write_to_the_database(self):
        for rid in IDS:
            with CaptureQueriesContext(connection) as q:
                self.body(rid, **PERIOD_PARAMS[rid])
            writes = [
                x["sql"][:80]
                for x in q.captured_queries
                if x["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
            ]
            self.assertEqual(writes, [], rid)

    def test_screen_runs_do_not_create_the_settings_row_on_a_fresh_install(self):
        # PayrollSettings.get() is get_or_create: a report that used it would INSERT the singleton on a GET
        PayrollSettings.objects.all().delete()
        for rid in IDS:
            self.assertEqual(self.run_report(rid, **PERIOD_PARAMS[rid]).status_code, 200, rid)
        self.assertEqual(PayrollSettings.objects.count(), 0)
        # ... and the CTC statement falls back to the model defaults instead of failing
        self.assertTrue(self.body("employer-cost-ctc")["rows"])

    def test_report_data_is_untouched_by_running_and_exporting_everything(self):
        def snapshot():
            return (
                AttendanceDayRecord.objects.count(),
                OvertimeRecord.objects.count(),
                SalarySlip.objects.count(),
                Payroll.objects.count(),
                list(Payroll.objects.order_by("id").values_list("updated_at", "status")),
                list(AdvanceRepayment.objects.order_by("id").values_list("is_processed", "amount")),
                list(Advance.objects.order_by("id").values_list("total_repaid", "outstanding", "status")),
            )

        before = snapshot()
        for rid in IDS:
            self.body(rid, **PERIOD_PARAMS[rid])
            for fmt in ("xlsx", "pdf"):
                self.assertEqual(self.export(rid, fmt, **PERIOD_PARAMS[rid]).status_code, 200, (rid, fmt))
        self.assertEqual(snapshot(), before)

    def test_exports_are_audited_once_each(self):
        before = AuditLog.objects.filter(action="export", module="reports").count()
        self.export("bank-advice", "xlsx", **FEB)
        self.assertEqual(AuditLog.objects.filter(action="export", module="reports").count(), before + 1)
        log = AuditLog.objects.filter(action="export", module="reports").latest("id")
        self.assertIn("Bank Transfer Advice", log.record_description)
        self.assertIn("XLSX", log.record_description)

    def test_bad_filters_are_400_with_the_field(self):
        for rid, params, field in (
            ("salary-register", {"period": "2026-13"}, "period"),
            ("salary-register", {"departmentIds": "x"}, "departmentIds"),
            ("salary-register", {"paymentStatus": "maybe"}, "paymentStatus"),
            ("department-salary-cost", {"financialYear": "1999-00"}, "financialYear"),
            ("production-wage-sheet", {"dateFrom": "2026-03-01", "dateTo": "2026-02-01"}, "dateFrom"),
            ("production-wage-sheet", {"dateFrom": "2020-01-01", "dateTo": "2026-02-01"}, "dateTo"),
            ("bank-advice", {"paymentMode": "cheque"}, "paymentMode"),
        ):
            r = self.run_report(rid, **params)
            self.assertEqual(r.status_code, 400, (rid, params))
            self.assertEqual(r.json()["field"], field, (rid, params))


# ═════════════════════════════════════════════════════════════════════════════
#  salary-slip
# ═════════════════════════════════════════════════════════════════════════════


class SalarySlipTests(PayrollCoreBase):
    def test_golden_rows_are_the_engines_own_numbers_in_natural_code_order(self):
        b = self.body("salary-slip", **FEB)
        self.assertEqual(
            [(r["employeeCode"], r["period"]) for r in b["rows"]],
            [
                ("73", "Feb 2026"),
                ("1001", "Feb 2026"),
                ("1002", "Feb 2026"),
                ("1003", "Feb 2026"),
                ("1004", "Feb 2026"),
                ("2001", "02-Feb-2026 to 08-Feb-2026"),
                ("2001", "09-Feb-2026 to 15-Feb-2026"),
                ("2002", "02-Feb-2026 to 08-Feb-2026"),
            ],
        )
        a = _by_code(b, "1001")
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "slipNumber",
                    "employeeName",
                    "department",
                    "designation",
                    "employmentType",
                    "workingDays",
                    "paidDays",
                    "absentDays",
                    "lateDays",
                    "basic",
                    "hra",
                    "otherAllowances",
                    "otAmount",
                    "totalEarnings",
                    "pfDeduction",
                    "esiDeduction",
                    "advanceDeduction",
                    "otherDeductions",
                    "totalDeductions",
                    "netPay",
                    "paymentStatus",
                )
            },
            {
                "slipNumber": "SS/1001/2026/02",
                "employeeName": "Anita Test",
                "department": "CUTTING",
                "designation": "Supervisor",
                "employmentType": "Staff",
                "workingDays": 24,
                "paidDays": 24.0,
                "absentDays": 0.0,
                "lateDays": 0,
                "basic": 12000.0,
                "hra": 4800.0,
                "otherAllowances": 7200.0,
                "otAmount": 1000.0,
                "totalEarnings": 25000.0,
                "pfDeduction": 1440.0,
                "esiDeduction": 0.0,
                "advanceDeduction": 2000.0,
                "otherDeductions": 0.0,
                "totalDeductions": 3440.0,
                "netPay": 21560.0,
                "paymentStatus": "Paid",
            },
        )
        # 18 of 24 days paid, 3 late (2 billable -> half a shift of 850) - all from the stored slip
        c = _by_code(b, "1002")
        self.assertEqual((c["paidDays"], c["absentDays"], c["lateDays"], c["totalEarnings"]), (18.0, 6.0, 3, 15300.0))
        self.assertEqual((c["pfDeduction"], c["esiDeduction"], c["otherDeductions"]), (918.0, 114.75, 425.0))
        self.assertEqual((c["totalDeductions"], c["netPay"], c["paymentStatus"]), (1457.75, 13842.25, "Pending"))
        # production: one slip per pay period, paid days = shifts, heads that do not apply are blank
        p = _by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")
        self.assertEqual(
            (p["employmentType"], p["paidDays"], p["basic"], p["netPay"]), ("Production", 7.5, 3750.0, 2271.87)
        )
        self.assertEqual((p["esiDeduction"], p["advanceDeduction"], p["totalDeductions"]), (28.13, 1000.0, 1478.13))
        self.assertIsNone(p["hra"])
        self.assertIsNone(p["otAmount"])
        # NULL department / designation and a leaver still appear
        d = _by_code(b, "1004")
        self.assertEqual((d["department"], d["designation"], d["netPay"]), ("Unassigned", None, 11190.0))

    def test_totals_summary_and_notes(self):
        b = self.body("salary-slip", **FEB)
        _assert_totals_match(self, b)
        self.assertEqual(b["totals"]["netPay"], 95414.12)
        self.assertEqual(
            b["totals"]["totalEarnings"], 106050.0
        )  # gross + OT, not the slip's gross-only "Total Earnings"
        self.assertEqual(b["totals"]["totalDeductions"], 10635.88)
        for r in _body_rows(b):  # every slip ties out: earnings - deductions = net
            self.assertAlmostEqual(r["totalEarnings"] - r["totalDeductions"], r["netPay"], places=2)
            self.assertAlmostEqual(
                r["pfDeduction"] + r["esiDeduction"] + r["advanceDeduction"] + r["otherDeductions"],
                r["totalDeductions"],
                places=2,
            )
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Salary slips"], s["Employees"], s["Paid slips"], s["Pending slips"]), (8, 7, 2, 6))
        self.assertEqual(
            (s["Total earnings"], s["Total deductions"], s["Total net pay"]), (106050.0, 10635.88, 95414.12)
        )
        text = " ".join(b["notes"])
        self.assertIn("OT Hours", text)  # the printed-slip quirks are flagged, not silently copied
        self.assertIn("Date of Payment", text)
        self.assertIn("DA/CA/EA/PTRL/TDS/LOP", text)
        self.assertIn("Legacy weekly", text)

    def test_every_filter_narrows(self):
        def codes(**p):
            return [r["employeeCode"] for r in self.body("salary-slip", **{**FEB, **p})["rows"]]

        self.assertEqual(codes(employmentType="production"), ["2001", "2001", "2002"])
        self.assertEqual(codes(employmentType="staff"), ["73", "1001", "1002", "1003", "1004"])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), ["1001"])
        self.assertEqual(codes(employeeIds=f"{self.e2.id},{self.e5.id}"), ["73", "1002"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(paymentStatus="paid"), ["1001", "2001"])
        self.assertEqual(len(codes(paymentStatus="pending")), 6)
        self.assertEqual(codes(period="2026-01"), ["1001", "1003"])
        self.assertEqual(codes(period="2026-03"), ["1001", "1003"])

    def test_legacy_weekly_slips_are_hidden_unless_asked_for(self):
        self.assertEqual(len(self.body("salary-slip", **FEB)["rows"]), 8)
        b = self.body("salary-slip", **FEB, includeLegacyWeekly="true")
        self.assertEqual(len(b["rows"]), 9)
        legacy = _by_code(b, "2001", "Feb 2026 - week 2")
        self.assertEqual(
            (legacy["flag"], legacy["employmentType"], legacy["netPay"]), ("Legacy weekly", "Production", 1000.0)
        )
        # the staff filter never lets a production slip in, legacy or not
        self.assertEqual(
            len(self.body("salary-slip", **FEB, includeLegacyWeekly="true", employmentType="staff")["rows"]), 5
        )
        self.assertEqual(
            len(self.body("salary-slip", **FEB, includeLegacyWeekly="true", employmentType="production")["rows"]), 4
        )

    def test_half_shift_days_count_half_in_paid_days(self):
        # 22 full days + 2 half-shift days: the slip's present_days column says 24, the money is for 23 days
        emp = Employee.objects.create(
            employee_code="3100",
            first_name="Half",
            last_name="Shift",
            employment_type="staff",
            department=self.cutting,
            branch=self.b1,
            salary_amount=Decimal("24000.00"),
        )
        days = _build_working_days(2, 2026, False, set())
        _present_month(emp, 2026, 2, days[:22])
        for d in days[22:]:
            _day(emp, d, "half_shift", "0.50")
        _generate_staff_payroll(emp, 2, 2026)
        row = _by_code(self.body("salary-slip", **FEB), "3100")
        self.assertEqual(SalarySlip.objects.get(employee=emp).present_days, Decimal("24.0"))
        self.assertEqual((row["paidDays"], row["totalEarnings"], row["basic"]), (23.0, 23000.0, 11500.0))
        register = _by_code(self.body("salary-register", **FEB), "3100")
        self.assertEqual((register["paidDays"], register["totalEarnings"]), (23.0, 23000.0))
        wages = _by_code(self.body("salary-wages-statement", **FEB), "3100")
        self.assertEqual((wages["lopAmount"], wages["basicFixed"], wages["basicEarned"]), (1000.0, 12000.0, 11500.0))

    def test_emailed_time_is_shown_in_ist(self):
        SalarySlip.objects.filter(employee=self.e1, month=2, year=2026).update(
            emailed_at=datetime(2026, 3, 1, 20, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(_by_code(self.body("salary-slip", **FEB), "1001")["emailedAt"], "2026-03-02 01:30")

    def test_provisional_staff_slips_are_flagged_production_never(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=date(2026, 2, 10)):
            b = self.body("salary-slip", **FEB)
        flags = {(r["employeeCode"], r["employmentType"]): r["flag"] for r in b["rows"]}
        self.assertEqual({v for (c, t), v in flags.items() if t == "Staff"}, {"Provisional"})
        self.assertEqual({v for (c, t), v in flags.items() if t == "Production"}, {None})
        self.assertTrue(any("PROVISIONAL" in n for n in b["notes"]))
        self.assertFalse(any("PROVISIONAL" in n for n in self.body("salary-slip", **FEB)["notes"]))

    def test_branch_isolation_cannot_be_widened(self):
        u = self.branch_user
        b = self.body("salary-slip", u, **FEB)
        self.assertEqual([r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002", "1004", "2001", "2001"])
        self.assertEqual(self.body("salary-slip", u, **FEB, branchIds=str(self.b2.id))["rows"], [])
        self.assertEqual(self.body("salary-slip", u, **FEB, employeeIds=str(self.e3.id))["rows"], [])
        self.assertEqual(self.body("salary-slip", u, **FEB, departmentIds=str(self.finish.id))["rows"], [])
        self.assertAlmostEqual(b["totals"]["netPay"], 65469.12, places=2)

    def test_pdf_is_the_real_printable_slips_two_per_page(self):
        r = self.export("salary-slip", "pdf", **FEB)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        pages, text = _pdf(r.content)
        self.assertEqual(pages, 4)  # 8 slips, two per landscape page
        self.assertEqual(text.count("SALARY SLIP"), 8)
        for name in ("Anita Test", "Bala Test", "Chitra Test", "Deepak Test", "Zed Test", "Esha Prod", "Farook Prod"):
            self.assertIn(name, text)
        self.assertIn("NET AMOUNT PAID", text)
        self.assertIn("February 2026", text)

    def test_pdf_honours_the_same_filters_as_the_screen(self):
        _, text = _pdf(self.export("salary-slip", "pdf", **FEB, employeeIds=str(self.e1.id)).content)
        self.assertEqual(text.count("SALARY SLIP"), 1)
        self.assertIn("Anita Test", text)
        self.assertNotIn("Bala Test", text)
        pages, text = _pdf(self.export("salary-slip", "pdf", **FEB, employmentType="production").content)
        self.assertEqual((pages, text.count("SALARY SLIP")), (2, 3))
        _, text = _pdf(self.export("salary-slip", "pdf", **FEB, paymentStatus="paid").content)
        self.assertEqual(text.count("SALARY SLIP"), 2)

    def test_pdf_respects_branch_isolation(self):
        _, text = _pdf(self.export("salary-slip", "pdf", self.branch_user, **FEB).content)
        self.assertEqual(text.count("SALARY SLIP"), 6)
        self.assertNotIn("Chitra Test", text)
        self.assertNotIn("Farook Prod", text)
        r = self.export("salary-slip", "pdf", self.branch_user, **FEB, branchIds=str(self.b2.id))
        self.assertEqual(r.status_code, 200)
        pages, text = _pdf(r.content)  # nothing to print: the standard report page, not a page of somebody's slip
        self.assertEqual(pages, 1)
        self.assertNotIn("NET AMOUNT PAID", text)
        self.assertNotIn("Chitra Test", text)

    def test_pdf_refuses_beyond_the_cap_with_a_helpful_message(self):
        with mock.patch.object(slips_module, "MAX_SLIPS_PER_PDF", 3):
            r = self.export("salary-slip", "pdf", **FEB)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "invalid_filter")
        self.assertIn("more than the 3 that fit in one PDF", r.json()["message"])
        self.assertIn("Narrow it", r.json()["message"])
        with mock.patch.object(slips_module, "MAX_SLIPS_PER_PDF", 3):  # exactly at the cap is fine
            self.assertEqual(self.export("salary-slip", "pdf", **FEB, employmentType="production").status_code, 200)

    def test_xlsx_round_trip(self):
        ws = self.xlsx("salary-slip", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:3], ["Slip no.", "Emp Code", "Employee"])
        self.assertIn("Net pay", header)
        first = [c.value for c in ws[8]]
        self.assertEqual(first[0], "SS/73/2026/02")
        self.assertEqual(first[1], "73")
        net = header.index("Net pay")
        self.assertEqual(first[net], 13987.5)
        self.assertEqual(ws.cell(row=8 + 8, column=net + 1).value, 95414.12)  # totals row
        codes = [ws.cell(row=r, column=2).value for r in range(8, 16)]
        self.assertEqual(codes, ["73", "1001", "1002", "1003", "1004", "2001", "2001", "2002"])

    def test_xlsx_respects_branch_isolation(self):
        ws = self.xlsx("salary-slip", self.branch_user, **FEB).active
        values = [c.value for row in ws.iter_rows() for c in row]
        self.assertIn("SS/1001/2026/02", values)
        self.assertNotIn("SS/1003/2026/02", values)

    def test_month_with_no_slips_says_so(self):
        b = self.body("salary-slip", period="2025-01")
        self.assertEqual(b["rows"], [])
        self.assertTrue(any("generated" in n for n in b["notes"]))
        for fmt in ("xlsx", "pdf"):
            self.assertEqual(self.export("salary-slip", fmt, period="2025-01").status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-register
# ═════════════════════════════════════════════════════════════════════════════


class SalaryRegisterTests(PayrollCoreBase):
    def test_golden_department_subtotals_and_totals(self):
        b = self.body("salary-register", **FEB)
        names = [r["employeeName"] for r in b["rows"]]
        self.assertEqual(
            names,
            [
                "Anita Test",
                "Esha Prod",
                "Esha Prod",
                "CUTTING total",
                "Chitra Test",
                "Farook Prod",
                "FINISHING total",
                "Zed Test",
                "Bala Test",
                "SEWING total",
                "Deepak Test",
                "Unassigned total",
            ],
        )
        subs = {r["employeeName"]: r for r in b["rows"] if r.get("_kind") == "subtotal"}
        self.assertEqual(subs["CUTTING total"]["netPay"], 26449.37)  # 21560 + 2271.87 + 2617.50
        self.assertEqual(subs["FINISHING total"]["netPay"], 29945.0)
        self.assertEqual(subs["SEWING total"]["netPay"], 27829.75)
        self.assertEqual(subs["Unassigned total"]["netPay"], 11190.0)
        self.assertEqual(subs["CUTTING total"]["totalEarnings"], 31750.0)
        self.assertEqual(subs["SEWING total"]["lateDeduction"], 425.0)
        _assert_totals_match(self, b)
        self.assertEqual(b["totals"]["netPay"], 95414.12)
        self.assertEqual(round(sum(s["netPay"] for s in subs.values()), 2), 95414.12)
        self.assertEqual(
            {
                k: b["totals"][k]
                for k in ("pfDeduction", "esiDeduction", "advanceDeduction", "lateDeduction", "otAmount")
            },
            {
                "pfDeduction": 6828.0,
                "esiDeduction": 382.88,
                "advanceDeduction": 3000.0,
                "lateDeduction": 425.0,
                "otAmount": 1000.0,
            },
        )

    def test_row_details_mixed_staff_and_production(self):
        b = self.body("salary-register", **FEB)
        e2 = _by_code(b, "1002")
        self.assertEqual(
            (
                e2["monthlyRate"],
                e2["workingDays"],
                e2["paidDays"],
                e2["absentDays"],
                e2["basic"],
                e2["hra"],
                e2["otherAllowances"],
                e2["lateDeduction"],
                e2["netPay"],
            ),
            (20400.0, 24, 18.0, 6.0, 7650.0, 3060.0, 4590.0, 425.0, 13842.25),
        )
        p = _by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")
        self.assertEqual((p["monthlyRate"], p["paidDays"], p["basic"], p["netPay"]), (500.0, 7.5, 3750.0, 2271.87))
        self.assertIsNone(p["hra"])
        self.assertIsNone(p["lateDeduction"])  # production late detection was off: unknown, not zero
        self.assertEqual(p["paymentStatus"], "Paid")

    def test_join_dates_are_parsed_from_mixed_text(self):
        b = self.body("salary-register", **FEB)
        self.assertEqual(_by_code(b, "1001")["joinDate"], "2024-04-15")
        self.assertEqual(_by_code(b, "1002")["joinDate"], "2023-06-15")  # stored as DD/MM/YYYY
        self.assertIsNone(_by_code(b, "1004")["joinDate"])  # unparseable text
        self.assertIsNone(_by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")["joinDate"])

    def test_group_by_options(self):
        by_type = self.body("salary-register", **FEB, groupBy="employmentType")
        subs = {r["employeeName"]: r["netPay"] for r in by_type["rows"] if r.get("_kind") == "subtotal"}
        self.assertEqual(subs, {"Production total": 6634.37, "Staff total": 88779.75})
        _assert_totals_match(self, by_type)
        flat = self.body("salary-register", **FEB, groupBy="none")
        self.assertFalse(any(r.get("_kind") for r in flat["rows"]))
        self.assertEqual(flat["totals"]["netPay"], 95414.12)
        self.assertEqual([r["employeeCode"] for r in flat["rows"]][:3], ["73", "1001", "1002"])

    def test_every_filter_narrows(self):
        def codes(**p):
            return [r["employeeCode"] for r in _body_rows(self.body("salary-register", **FEB, groupBy="none", **p))]

        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        self.assertEqual(
            sorted(codes(employeeStatus="active")), sorted(["73", "1001", "1002", "1003", "2001", "2001", "2002"])
        )
        self.assertEqual(len(codes(employeeStatus="all")), 8)  # leavers are included by default
        self.assertEqual(codes(employmentType="production"), ["2001", "2001", "2002"])
        self.assertEqual(codes(departmentIds=str(self.cutting.id)), ["1001", "2001", "2001"])
        self.assertEqual(codes(designationIds=str(self.operator.id)), ["73", "1002", "1003", "2001", "2001", "2002"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(paymentStatus="paid"), ["1001", "2001"])
        self.assertEqual(codes(employeeIds=str(self.e1.id)), ["1001"])

    def test_summary_counts_each_person_once(self):
        b = self.body("salary-register", **FEB)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Employees paid"], s["Salary slips"]), (7, 8))
        self.assertEqual(
            (s["Total net pay"], s["PF + ESI (employee)"], s["Late deductions"]), (95414.12, 7210.88, 425.0)
        )
        self.assertTrue(any("Employees who have since left are included" in n for n in b["notes"]))

    def test_legacy_weekly_row_only_with_the_toggle(self):
        b = self.body("salary-register", **FEB, includeLegacyWeekly="true", groupBy="none")
        legacy = _by_code(b, "2001", "Feb 2026 - week 2")
        self.assertEqual((legacy["netPay"], legacy["paidDays"]), (1000.0, 2.0))
        self.assertEqual(b["totals"]["netPay"], 96414.12)

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("salary-register", u, **FEB)
        self.assertNotIn("1003", {r["employeeCode"] for r in _body_rows(b)})
        self.assertNotIn("FINISHING total", [r["employeeName"] for r in b["rows"]])
        self.assertAlmostEqual(b["totals"]["netPay"], 65469.12, places=2)
        self.assertEqual(_body_rows(self.body("salary-register", u, **FEB, branchIds=str(self.b2.id))), [])
        self.assertEqual(_body_rows(self.body("salary-register", u, **FEB, employeeIds=str(self.p2.id))), [])

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("salary-register", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:4], ["Emp Code", "Employee", "Department", "Designation"])
        self.assertEqual([c.value for c in ws[8]][:2], ["1001", "Anita Test"])
        net = header.index("Net pay") + 1
        labels = [ws.cell(row=r, column=2).value for r in range(8, 21)]
        self.assertIn("CUTTING total", labels)
        self.assertEqual(ws.cell(row=20, column=net).value, 95414.12)  # grand total row after 12 rows + subtotals
        r = self.export("salary-register", "pdf", **FEB)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertIn("CUTTING total", _pdf(r.content)[1])


# ═════════════════════════════════════════════════════════════════════════════
#  salary-wages-statement
# ═════════════════════════════════════════════════════════════════════════════


class WagesStatementTests(PayrollCoreBase):
    def test_golden_fixed_and_earned_heads(self):
        b = self.body("salary-wages-statement", **FEB)
        a = _by_code(b, "1001")
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "monthlyRate",
                    "paidDays",
                    "basicFixed",
                    "hraFixed",
                    "allowancesFixed",
                    "basicEarned",
                    "hraEarned",
                    "allowancesEarned",
                    "incentives",
                    "otAmount",
                    "totalEarnings",
                    "lopAmount",
                )
            },
            {
                "monthlyRate": 24000.0,
                "paidDays": 24.0,
                "basicFixed": 12000.0,
                "hraFixed": 4800.0,
                "allowancesFixed": 7200.0,
                "basicEarned": 12000.0,
                "hraEarned": 4800.0,
                "allowancesEarned": 7200.0,
                "incentives": 0.0,
                "otAmount": 1000.0,
                "totalEarnings": 25000.0,
                "lopAmount": 0.0,
            },
        )
        # 20,400 a month, 18 of 24 days paid: fixed 50/20/30, earned 75% of that, loss of pay 20,400 - 15,300
        c = _by_code(b, "1002")
        self.assertEqual((c["basicFixed"], c["hraFixed"], c["allowancesFixed"]), (10200.0, 4080.0, 6120.0))
        self.assertEqual((c["basicEarned"], c["hraEarned"], c["allowancesEarned"]), (7650.0, 3060.0, 4590.0))
        self.assertEqual((c["totalEarnings"], c["lopAmount"]), (15300.0, 5100.0))
        # production: rate per shift, no fixed split, no per-head split, no loss of pay
        p = _by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")
        self.assertEqual(
            (p["monthlyRate"], p["paidDays"], p["basicEarned"], p["totalEarnings"]), (500.0, 7.5, 3750.0, 3750.0)
        )
        self.assertEqual((a["workingDays"], c["workingDays"], c["paidDays"]), (24, 24, 18.0))
        for k in (
            "basicFixed",
            "hraFixed",
            "allowancesFixed",
            "hraEarned",
            "allowancesEarned",
            "incentives",
            "otAmount",
            "lopAmount",
        ):
            self.assertIsNone(p[k], k)

    def test_totals_subtotals_and_summary(self):
        b = self.body("salary-wages-statement", **FEB)
        _assert_totals_match(self, b)
        t = b["totals"]
        self.assertEqual((t["basicFixed"], t["hraFixed"], t["allowancesFixed"]), (50700.0, 20280.0, 30420.0))
        self.assertEqual((t["basicEarned"], t["hraEarned"], t["allowancesEarned"]), (56900.0, 19260.0, 28890.0))
        self.assertEqual((t["otAmount"], t["totalEarnings"], t["lopAmount"]), (1000.0, 106050.0, 5100.0))
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(s["Fixed monthly wage bill (staff)"], 101400.0)  # 24000 + 20400 + 30000 + 12000 + 15000
        self.assertEqual((s["Total earnings"], s["Loss of pay"], s["Overtime"]), (106050.0, 5100.0, 1000.0))
        sub = next(r for r in b["rows"] if r.get("employeeName") == "SEWING total")
        self.assertEqual((sub["basicFixed"], sub["basicEarned"], sub["lopAmount"]), (17700.0, 15150.0, 5100.0))
        cutting = next(r for r in b["rows"] if r.get("employeeName") == "CUTTING total")
        self.assertEqual(
            (cutting["basicFixed"], cutting["hraEarned"]), (12000.0, 4800.0)
        )  # production adds nothing there

    def test_da_and_retaining_allowance_are_not_faked(self):
        b = self.body("salary-wages-statement", **FEB)
        for c in b["columns"]:
            self.assertNotRegex(c["label"].lower(), r"\bda\b|dearness|retaining", c["label"])
            self.assertNotRegex(c["key"].lower(), r"^da|retain")
        labels = [c["label"] for c in b["columns"]]
        self.assertIn("Allowances (earned)", labels)
        first = b["notes"][0]
        self.assertIn("DA", first)
        self.assertIn("Retaining Allowance", first)
        self.assertIn("NOT tracked", first)
        self.assertIn("combine", first)

    def test_fixed_split_is_the_engine_split_not_the_compensation_percentages(self):
        _configure(basic_percent=Decimal("40"), hra_percent=Decimal("10"))
        b = self.body("salary-wages-statement", **FEB)
        a = _by_code(b, "1001")
        self.assertEqual((a["basicFixed"], a["hraFixed"], a["allowancesFixed"]), (12000.0, 4800.0, 7200.0))

    def test_slip_without_a_snapshot_leaves_fixed_heads_blank(self):
        SalarySlip.objects.filter(employee=self.e5).update(breakdown_details=None)
        b = self.body("salary-wages-statement", **FEB)
        z = _by_code(b, "73")
        self.assertIsNone(z["monthlyRate"])
        self.assertIsNone(z["basicFixed"])
        self.assertIsNone(z["lopAmount"])
        self.assertEqual(z["basicEarned"], 7500.0)  # earned heads still come from the stored columns
        self.assertTrue(any("carry no salary snapshot" in n for n in b["notes"]))

    def test_filters_and_branch_isolation(self):
        def codes(user=None, **p):
            return [r["employeeCode"] for r in _body_rows(self.body("salary-wages-statement", user, **FEB, **p))]

        self.assertEqual(codes(employmentType="staff"), ["1001", "1003", "73", "1002", "1004"])
        self.assertEqual(codes(employmentType="production"), ["2001", "2001", "2002"])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(employeeIds=str(self.e3.id)), ["1003"])
        self.assertEqual(codes(paymentStatus="paid"), ["1001", "2001"])
        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), ["1001"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        legacy = self.body("salary-wages-statement", **FEB, includeLegacyWeekly="true")
        self.assertEqual(len(_body_rows(legacy)), 9)
        self.assertEqual(_by_code(legacy, "2001", "Feb 2026 - week 2")["totalEarnings"], 1000.0)
        self.assertEqual(codes(self.branch_user, branchIds=str(self.b2.id)), [])
        self.assertNotIn("1003", codes(self.branch_user))
        b = self.body("salary-wages-statement", self.branch_user, **FEB)
        self.assertNotIn("FINISHING total", [r["employeeName"] for r in b["rows"]])

    def test_xlsx_round_trip(self):
        ws = self.xlsx("salary-wages-statement", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertIn("Basic (fixed)", header)
        self.assertIn("Loss of pay", header)
        row = [c.value for c in ws[8]]
        self.assertEqual(row[0], "1001")
        self.assertEqual(row[header.index("Basic (fixed)")], 12000.0)
        text = [ws.cell(row=r, column=1).value for r in range(1, ws.max_row + 1)]
        self.assertTrue(
            any(isinstance(v, str) and "NOT tracked" in v for v in text)
        )  # the limitation travels with the file
        self.assertEqual(self.export("salary-wages-statement", "pdf", **FEB).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  production-wage-sheet
# ═════════════════════════════════════════════════════════════════════════════

FEB_RANGE = {"dateFrom": "2026-02-01", "dateTo": "2026-02-28"}


class ProductionWageSheetTests(PayrollCoreBase):
    def test_golden_rows(self):
        b = self.body("production-wage-sheet", **FEB_RANGE)
        self.assertEqual(
            [r["employeeName"] for r in b["rows"]],
            ["Esha Prod", "Esha Prod", "CUTTING total", "Farook Prod", "FINISHING total"],
        )
        a = _body_rows(b)[0]
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "periodStart",
                    "periodEnd",
                    "daysWorked",
                    "daysAbsent",
                    "totalShifts",
                    "extraShifts",
                    "ratePerShift",
                    "grossWages",
                    "pfDeduction",
                    "esiDeduction",
                    "advanceDeduction",
                    "lateDeduction",
                    "totalDeductions",
                    "netPay",
                    "pfRule",
                    "paymentStatus",
                )
            },
            {
                "periodStart": "2026-02-02",
                "periodEnd": "2026-02-08",
                "daysWorked": 6,
                "daysAbsent": 1,
                "totalShifts": 7.5,
                "extraShifts": 1.5,
                "ratePerShift": 500.0,
                "grossWages": 3750.0,
                "pfDeduction": 450.0,
                "esiDeduction": 28.13,
                "advanceDeduction": 1000.0,
                "lateDeduction": None,
                "totalDeductions": 1478.13,
                "netPay": 2271.87,
                "pfRule": "Flat rates",
                "paymentStatus": "Paid",
            },
        )
        second = _body_rows(b)[1]  # 9-15 Feb: six 1.0-shift days, no extra shift
        self.assertEqual(
            (
                second["periodStart"],
                second["totalShifts"],
                second["extraShifts"],
                second["grossWages"],
                second["netPay"],
            ),
            ("2026-02-09", 6.0, 0.0, 3000.0, 2617.5),
        )
        third = _body_rows(b)[2]
        self.assertEqual(
            (third["employeeCode"], third["totalShifts"], third["ratePerShift"], third["netPay"]),
            ("2002", 5.0, 400.0, 1745.0),
        )

    def test_shifts_come_from_the_breakdown_not_the_rounded_column(self):
        # 7.25 shifts: the Decimal(4,1) present_days column can only hold 7.3
        slip = SalarySlip.objects.get(employee=self.p2)
        bd = dict(slip.breakdown_details)
        bd["summary"] = {**bd["summary"], "totalShifts": 7.25}
        SalarySlip.objects.filter(pk=slip.pk).update(breakdown_details=bd, present_days=Decimal("7.3"))
        row = _body_rows(self.body("production-wage-sheet", **FEB_RANGE))[2]
        self.assertEqual(row["totalShifts"], 7.25)

    def test_totals_subtotals_summary_and_notes(self):
        b = self.body("production-wage-sheet", **FEB_RANGE)
        _assert_totals_match(self, b)
        t = b["totals"]
        self.assertEqual(
            (t["daysWorked"], t["totalShifts"], t["extraShifts"], t["grossWages"]), (17, 18.5, 1.5, 8750.0)
        )
        self.assertEqual(
            (t["pfDeduction"], t["esiDeduction"], t["advanceDeduction"], t["totalDeductions"], t["netPay"]),
            (1050.0, 65.63, 1000.0, 2115.63, 6634.37),
        )
        self.assertIsNone(t["lateDeduction"])  # detection was off everywhere: unknown, not 0.00
        cut = next(r for r in b["rows"] if r.get("employeeName") == "CUTTING total")
        self.assertIsNone(cut["lateDeduction"])
        self.assertEqual((cut["totalShifts"], cut["netPay"]), (13.5, 4889.37))
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Employees"], s["Total shifts"], s["Extra shifts (included)"]), (2, 18.5, 1.5))
        self.assertEqual(
            (s["Gross wages"], s["Total net pay"], s["Average shifts per employee"]), (8750.0, 6634.37, 9.25)
        )
        notes = " ".join(b["notes"])
        self.assertIn("ALREADY inside total shifts", notes)
        self.assertIn("gross x 2", notes)

    def test_pf_esi_salary_range_rule_label_is_shown(self):
        slip = SalarySlip.objects.get(employee=self.p2)
        bd = dict(slip.breakdown_details)
        bd["deductions"] = {**bd["deductions"], "pfEfRule": {"label": "Mid band", "pfRate": 12, "efRate": 1}}
        SalarySlip.objects.filter(pk=slip.pk).update(breakdown_details=bd)
        self.assertEqual(_body_rows(self.body("production-wage-sheet", **FEB_RANGE))[2]["pfRule"], "Mid band")

    def test_late_deduction_appears_when_detection_was_on(self):
        slip = SalarySlip.objects.get(employee=self.p2)
        bd = dict(slip.breakdown_details)
        bd["deductions"] = {**bd["deductions"], "lateShiftPenalty": 200.0}
        SalarySlip.objects.filter(pk=slip.pk).update(
            breakdown_details=bd,
            total_deductions=slip.total_deductions + Decimal("200"),
            net_salary=slip.net_salary - Decimal("200"),
        )
        b = self.body("production-wage-sheet", **FEB_RANGE)
        row = _body_rows(b)[2]
        self.assertEqual((row["lateDeduction"], row["totalDeductions"], row["netPay"]), (200.0, 455.0, 1545.0))
        self.assertEqual(b["totals"]["lateDeduction"], 200.0)

    def test_pay_period_window_is_by_period_end(self):
        def keys(**p):
            return [(r["employeeCode"], r["periodEnd"]) for r in _body_rows(self.body("production-wage-sheet", **p))]

        self.assertEqual(keys(dateFrom="2026-02-09", dateTo="2026-02-15"), [("2001", "2026-02-15")])
        self.assertEqual(
            keys(dateFrom="2026-02-08", dateTo="2026-02-08"), [("2001", "2026-02-08"), ("2002", "2026-02-08")]
        )
        self.assertEqual(keys(dateFrom="2026-02-16", dateTo="2026-02-28"), [])
        self.assertEqual(keys(dateFrom="2026-03-01", dateTo="2026-03-31", includeLegacyWeekly="true"), [])
        self.assertEqual(len(keys(dateFrom="2026-01-01", dateTo="2026-12-31")), 3)

    def test_other_filters_narrow(self):
        def codes(**p):
            return [
                (r["employeeCode"], r["periodEnd"])
                for r in _body_rows(self.body("production-wage-sheet", **FEB_RANGE, **p))
            ]

        self.assertEqual(codes(employeeIds=str(self.p2.id)), [("2002", "2026-02-08")])
        self.assertEqual(codes(departmentIds=str(self.cutting.id)), [("2001", "2026-02-08"), ("2001", "2026-02-15")])
        self.assertEqual(codes(branchIds=str(self.b2.id)), [("2002", "2026-02-08")])
        self.assertEqual(codes(paymentStatus="paid"), [("2001", "2026-02-08")])
        self.assertEqual(codes(paymentStatus="pending"), [("2001", "2026-02-15"), ("2002", "2026-02-08")])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), [])  # only staff are supervisors
        # staff slips never leak in: e1's staff slip has no pay period
        self.assertNotIn("1001", [c for c, _ in codes()])

    def test_legacy_weekly_slip_only_with_the_toggle(self):
        b = self.body("production-wage-sheet", **FEB_RANGE, includeLegacyWeekly="true")
        legacy = [r for r in _body_rows(b) if r["weekNumber"]]
        self.assertEqual(len(legacy), 1)
        self.assertEqual(
            (legacy[0]["weekNumber"], legacy[0]["periodStart"], legacy[0]["grossWages"], legacy[0]["totalShifts"]),
            (2, None, 1000.0, 2.0),
        )
        self.assertIsNone(legacy[0]["extraShifts"])  # no day list to count from
        self.assertEqual(len(_body_rows(self.body("production-wage-sheet", **FEB_RANGE))), 3)

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("production-wage-sheet", u, **FEB_RANGE)
        self.assertEqual({r["employeeCode"] for r in _body_rows(b)}, {"2001"})
        self.assertEqual(b["totals"]["netPay"], 4889.37)
        self.assertEqual(_body_rows(self.body("production-wage-sheet", u, **FEB_RANGE, branchIds=str(self.b2.id))), [])
        self.assertEqual(
            _body_rows(self.body("production-wage-sheet", u, **FEB_RANGE, employeeIds=str(self.p2.id))), []
        )

    def test_production_payroll_role_opens_it_but_a_salary_slip_role_does_not(self):
        self.assertEqual(self.run_report("production-wage-sheet", self.prod_user, **FEB_RANGE).status_code, 200)
        self.assertEqual(self.run_report("production-wage-sheet", self.payroll_user, **FEB_RANGE).status_code, 200)
        r = self.run_report("production-wage-sheet", self.slip_user, **FEB_RANGE)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "report_forbidden"))

    def test_xlsx_round_trip(self):
        ws = self.xlsx("production-wage-sheet", **FEB_RANGE).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:2], ["Emp Code", "Employee"])
        row = [c.value for c in ws[8]]
        self.assertEqual(row[0], "2001")
        self.assertEqual(row[header.index("Total shifts")], 7.5)
        self.assertEqual(row[header.index("Extra shifts")], 1.5)
        self.assertEqual(row[header.index("Net pay")], 2271.87)
        self.assertEqual(self.export("production-wage-sheet", "pdf", **FEB_RANGE).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  bank-advice
# ═════════════════════════════════════════════════════════════════════════════


class BankAdviceTests(PayrollCoreBase):
    def test_default_lists_what_is_still_to_be_paid_bank_first_then_cash(self):
        b = self.body("bank-advice", **FEB)
        self.assertEqual(
            [(r["employeeCode"], r.get("paymentMode")) for r in _body_rows(b)],
            [("1004", "Bank"), ("2001", "Bank"), ("1003", "Bank"), ("2002", "Cash"), ("73", "Cash"), ("1002", "Cash")],
        )
        subs = {r["employeeName"]: r["netPay"] for r in b["rows"] if r.get("_kind") == "subtotal"}
        self.assertEqual(subs, {"Bank transfer total": 42007.5, "Cash salary total": 29574.75})
        self.assertEqual(b["totals"]["netPay"], 71582.25)
        _assert_totals_match(self, b)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Total net pay"], s["Payments"]), (71582.25, 6))
        self.assertEqual(
            (s["Bank transfers"], s["Bank payments"], s["Cash salaries"], s["Cash payments"]), (42007.5, 3, 29574.75, 3)
        )
        self.assertEqual((s["Missing / invalid bank details"], s["Rows needing attention"]), (3, 2))

    def test_row_values_and_validity_checks(self):
        b = self.body("bank-advice", **FEB)
        e3 = _by_code(b, "1003")
        # spaces stripped, IFSC upper-cased, both kept as text
        self.assertEqual(
            (e3["bankName"], e3["bankAccount"], e3["bankIfsc"], e3["netPay"]),
            ("State Bank", "300011223344", "SBIN0001234", 28200.0),
        )
        self.assertEqual(
            (e3["check"], e3["narration"], e3["paymentStatus"]),
            ("Net differs from payroll", "SALARY FEB 2026", "Pending"),
        )
        e4 = _by_code(b, "1004")
        self.assertEqual(e4["check"], "Duplicate account")  # same account as Anita, an active employee
        self.assertEqual(_by_code(b, "2001")["check"], "OK")
        self.assertEqual(_by_code(b, "2001")["narration"], "WAGES 09FEB-15FEB2026")
        for code in ("2002", "73", "1002"):  # cash salaries are flagged, never dropped
            r = _by_code(b, code)
            self.assertEqual(
                (r["paymentMode"], r["check"], r["bankAccount"], r["bankIfsc"]), ("Cash", "No bank details", None, None)
            )

    def test_invalid_ifsc_zero_net_and_missing_ifsc_are_flagged(self):
        Employee.objects.filter(pk=self.e3.pk).update(bank_ifsc="BAD123")
        Employee.objects.filter(pk=self.e5.pk).update(bank_account="9999888877", bank_ifsc="")
        b = self.body("bank-advice", **FEB)
        self.assertIn("Invalid IFSC", _by_code(b, "1003")["check"])
        z = _by_code(b, "73")
        self.assertEqual((z["paymentMode"], z["check"]), ("Bank", "Invalid IFSC"))  # an account without a usable IFSC
        SalarySlip.objects.filter(employee=self.e2).update(net_salary=Decimal("0"))
        Payroll.objects.filter(employee=self.e2).update(final_salary=Decimal("0"))
        b = self.body("bank-advice", **FEB)
        self.assertEqual(_by_code(b, "1002")["check"], "No bank details; Zero/negative net")

    def test_payment_status_and_mode_and_bank_filters(self):
        def codes(**p):
            return [r["employeeCode"] for r in _body_rows(self.body("bank-advice", **FEB, **p))]

        self.assertEqual(len(codes(paymentStatus="all")), 8)
        self.assertEqual(codes(paymentStatus="paid"), ["1001", "2001"])
        self.assertEqual(codes(paymentMode="bank"), ["1004", "2001", "1003"])
        self.assertEqual(codes(paymentMode="cash"), ["2002", "73", "1002"])
        self.assertEqual(codes(bankName="hdfc"), ["1004"])  # case-insensitive contains, pending only
        self.assertEqual(codes(bankName="hdfc", paymentStatus="all"), ["1001", "1004"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(employmentType="production"), ["2001", "2002"])
        self.assertEqual(codes(employeeIds=str(self.e2.id)), ["1002"])

    def test_combine_periods_into_one_payment_line(self):
        # Esha: 2-8 Feb is PAID, 9-15 Feb is pending. One line of 4,889.37 marked Pending would ask the bank to pay the
        # paid period a second time, so periods are folded together only within the same payment state.
        b = self.body("bank-advice", **FEB, paymentStatus="all", combinePeriods="true")
        esha = [r for r in _body_rows(b) if r["employeeCode"] == "2001"]
        self.assertEqual(
            sorted((r["paymentStatus"], r["netPay"]) for r in esha), [("Paid", 2271.87), ("Pending", 2617.5)]
        )
        self.assertEqual(b["totals"]["netPay"], 95414.12)  # nothing lost or added by the split
        separate = self.body("bank-advice", **FEB, paymentStatus="all")
        self.assertEqual(len([r for r in _body_rows(separate) if r["employeeCode"] == "2001"]), 2)
        # the default (pending) view has just the unpaid period, i.e. exactly what still has to be transferred
        pending = self.body("bank-advice", **FEB, combinePeriods="true")
        (row,) = [r for r in _body_rows(pending) if r["employeeCode"] == "2001"]
        self.assertEqual((row["netPay"], row["paymentStatus"]), (2617.5, "Pending"))
        # two unpaid periods do fold into one payment line
        Payroll.objects.filter(employee=self.p1, period_start=date(2026, 2, 2)).update(status="pending")
        both = self.body("bank-advice", **FEB, combinePeriods="true")
        (row,) = [r for r in _body_rows(both) if r["employeeCode"] == "2001"]
        self.assertEqual((row["netPay"], row["paymentStatus"]), (4889.37, "Pending"))  # 2271.87 + 2617.50
        self.assertIn("+", row["period"])

    def test_amount_in_words_and_notes(self):
        b = self.body("bank-advice", **FEB)
        words = next(n for n in b["notes"] if n.startswith("Amount in words"))
        self.assertIn("bank transfers): Rs. FORTY TWO THOUSAND SEVEN AND FIFTY PAISE ONLY", words)  # 42,007.50
        self.assertIn(
            "including cash: Rs. SEVENTY ONE THOUSAND FIVE HUNDRED EIGHTY TWO AND TWENTY FIVE PAISE ONLY", words
        )
        self.assertTrue(any("HDFC Bulk Upload" in n for n in b["notes"]))
        self.assertTrue(any("no payment date" in n for n in b["notes"]))

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("bank-advice", u, **FEB, paymentStatus="all")
        self.assertEqual({r["employeeCode"] for r in _body_rows(b)}, {"73", "1001", "1002", "1004", "2001"})
        self.assertEqual(_body_rows(self.body("bank-advice", u, **FEB, branchIds=str(self.b2.id))), [])
        self.assertEqual(_body_rows(self.body("bank-advice", u, **FEB, employeeIds=str(self.e3.id))), [])
        # a branch user cannot even learn that a colleague in another branch shares an account
        Employee.objects.filter(pk=self.e3.pk).update(bank_account="50100012345678", bank_ifsc="HDFC0001234")
        b = self.body("bank-advice", u, **FEB)
        self.assertEqual(_by_code(b, "1004")["check"], "Duplicate account")  # Anita is in the same branch
        Employee.objects.filter(pk=self.e1.pk).update(bank_account="1111222233334444")
        Employee.objects.filter(pk=self.e4.pk).update(bank_account="50100012345678")
        b = self.body("bank-advice", u, **FEB)
        self.assertEqual(_by_code(b, "1004")["check"], "OK")  # the only other holder (Chitra) is in branch 2: invisible
        b = self.body("bank-advice", self.admin, **FEB)
        self.assertEqual(_by_code(b, "1004")["check"], "Duplicate account")

    def test_xlsx_carries_the_generic_report_plus_the_hdfc_bulk_upload_sheet(self):
        wb = self.xlsx("bank-advice", **FEB)
        self.assertEqual(len(wb.sheetnames), 2)
        self.assertEqual(wb.sheetnames[1], "HDFC Bulk Upload")
        ws = wb.worksheets[0]
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:3], ["Emp Code", "Employee", "Department"])
        self.assertEqual(ws.cell(row=8, column=header.index("Account no.") + 1).data_type, "s")
        hdfc = wb["HDFC Bulk Upload"]
        self.assertIn("TXN TYPE", hdfc["A1"].value)
        self.assertIn("BENE A/C NO", hdfc["C1"].value)
        self.assertEqual([c.value for c in hdfc[2]], ["M", "M / O", "M", "M", "M", "M", "M", "O", "M"])
        self.assertEqual(hdfc["A1"].fill.fgColor.rgb[-6:], "5B8C00")
        rows = [[c.value for c in r] for r in hdfc.iter_rows(min_row=3)]
        self.assertEqual([r[2] for r in rows], ["50100012345678", "6000111122223333", "300011223344"])
        self.assertEqual(
            rows[0], [None, None, "50100012345678", 11190.0, "DEEPAK TEST", "HDFC0001234", "HDFC BANK", None, None]
        )
        self.assertEqual([r[3] for r in rows], [11190.0, 2617.5, 28200.0])
        self.assertEqual(hdfc.cell(row=3, column=3).data_type, "s")  # an account number is text
        self.assertEqual(hdfc.cell(row=3, column=6).number_format, "@")
        # rows the bank would reject are kept out of the upload sheet
        Employee.objects.filter(pk=self.e3.pk).update(bank_ifsc="BAD")
        rows = [[c.value for c in r] for r in self.xlsx("bank-advice", **FEB)["HDFC Bulk Upload"].iter_rows(min_row=3)]
        self.assertEqual([r[2] for r in rows], ["50100012345678", "6000111122223333"])

    def test_hdfc_sheet_is_never_a_formula_and_respects_length_limits(self):
        Employee.objects.filter(pk=self.e3.pk).update(
            bank_name='=HYPERLINK("http://x")' + "Y" * 60, first_name="=cmd|calc"
        )
        rows = self.xlsx("bank-advice", **FEB)["HDFC Bulk Upload"]
        cells = [c for r in rows.iter_rows(min_row=3) for c in r if isinstance(c.value, str)]
        self.assertTrue(cells)
        for c in cells:
            self.assertEqual(c.data_type, "s", c.coordinate)
        e3 = [r for r in rows.iter_rows(min_row=3, values_only=True) if r[2] == "300011223344"][0]
        self.assertLessEqual(len(e3[6]), 40)
        self.assertTrue(e3[4].startswith("=CMD|CALC"))
        self.assertEqual(rows.max_row - 2, 3)

    def test_xlsx_without_bank_ready_rows_is_a_single_sheet(self):
        wb = self.xlsx("bank-advice", **FEB, paymentMode="cash")
        self.assertEqual(len(wb.sheetnames), 1)

    def test_pdf(self):
        r = self.export("bank-advice", "pdf", **FEB)
        self.assertEqual(r.status_code, 200)
        pages, text = _pdf(r.content)
        self.assertIn("Bank transfer", text)  # the subtotal label may wrap inside its cell
        self.assertIn("Cash salary total", text)
        self.assertIn("42,007.50", text)
        self.assertIn("300011223344", text)


# ═════════════════════════════════════════════════════════════════════════════
#  payroll-payment-status
# ═════════════════════════════════════════════════════════════════════════════


class PaymentStatusTests(PayrollCoreBase):
    def test_golden_rows_status_and_variance(self):
        b = self.body("payroll-payment-status", **FEB)
        self.assertEqual(len(b["rows"]), 8)  # the legacy weekly payroll row is not listed
        a = _by_code(b, "1001")
        self.assertEqual(
            (a["slipNet"], a["payrollNet"], a["variance"], a["paymentStatus"], a["match"]),
            (21560.0, 21560.0, 0.0, "Paid", "OK"),
        )
        c = _by_code(b, "1003")  # the payroll PATCH defect: final salary differs from the printed slip
        self.assertEqual(
            (c["slipNet"], c["payrollNet"], c["variance"], c["paymentStatus"], c["match"]),
            (28200.0, 28000.0, -200.0, "Pending", "Net differs"),
        )
        p = _by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")
        self.assertEqual((p["paymentStatus"], p["slipNet"]), ("Paid", 2271.87))
        self.assertEqual(sum(1 for r in b["rows"] if r["paymentStatus"] == "Paid"), 2)
        self.assertEqual(b["totals"]["slipNet"], 95414.12)
        self.assertEqual(b["totals"]["payrollNet"], 95214.12)
        self.assertEqual(b["totals"]["variance"], -200.0)
        _assert_totals_match(self, b)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(
            (s["Paid amount"], s["Paid slips"], s["Pending amount"], s["Pending slips"]), (23831.87, 2, 71582.25, 6)
        )
        self.assertEqual((s["Net variance (payroll - slip)"], s["Rows needing attention"]), (-200.0, 1))

    def test_last_updated_is_shown_in_ist(self):
        # 20:00 UTC on 1 March is 01:30 IST on 2 March
        Payroll.objects.filter(employee=self.e1, month=2, year=2026).update(
            updated_at=datetime(2026, 3, 1, 20, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            _by_code(self.body("payroll-payment-status", **FEB), "1001")["lastUpdated"], "2026-03-02 01:30"
        )

    def test_filters(self):
        def codes(**p):
            return [r["employeeCode"] for r in self.body("payroll-payment-status", **FEB, **p)["rows"]]

        self.assertEqual(codes(paymentStatus="paid"), ["1001", "2001"])
        self.assertEqual(len(codes(paymentStatus="pending")), 6)
        self.assertEqual(codes(onlyIssues="true"), ["1003"])
        self.assertEqual(codes(employmentType="production"), ["2001", "2001", "2002"])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(employeeIds=str(self.e4.id)), ["1004"])
        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        jan = self.body("payroll-payment-status", period="2026-01")
        self.assertEqual(
            [(r["employeeCode"], r["slipNet"]) for r in jan["rows"]], [("1001", 22560.0), ("1003", 28200.0)]
        )
        self.assertEqual(self.body("payroll-payment-status", period="2025-01")["rows"], [])

    def test_orphans_slip_without_payroll_and_payroll_without_slip(self):
        SalarySlip.objects.filter(employee=self.e5).delete()
        Payroll.objects.filter(employee=self.e2).delete()
        b = self.body("payroll-payment-status", **FEB)
        z = _by_code(b, "73")
        self.assertEqual(
            (z["match"], z["slipNet"], z["payrollNet"], z["variance"]), ("Payroll only", None, 13987.5, None)
        )
        c = _by_code(b, "1002")
        self.assertEqual(
            (c["match"], c["paymentStatus"], c["payrollNet"], c["lastUpdated"]), ("Slip only", "Pending", None, None)
        )
        self.assertEqual(
            sorted(r["employeeCode"] for r in self.body("payroll-payment-status", **FEB, onlyIssues="true")["rows"]),
            ["1002", "1003", "73"],
        )
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(s["Rows needing attention"], 3)

    def test_free_text_status_counts_as_pending(self):
        Payroll.objects.filter(employee=self.e3, month=2, year=2026).update(status="processing")
        Payroll.objects.filter(employee=self.e2, month=2, year=2026).update(status="PAID")
        b = self.body("payroll-payment-status", **FEB)
        self.assertEqual(_by_code(b, "1003")["paymentStatus"], "Pending")
        self.assertEqual(_by_code(b, "1002")["paymentStatus"], "Paid")

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("payroll-payment-status", u, **FEB)
        self.assertNotIn("1003", {r["employeeCode"] for r in b["rows"]})
        self.assertEqual(b["totals"]["variance"], 0)  # Chitra's variance is in the other branch
        self.assertEqual(self.body("payroll-payment-status", u, **FEB, branchIds=str(self.b2.id))["rows"], [])
        # an orphan payroll row in the other branch stays invisible too
        SalarySlip.objects.filter(employee=self.e3).delete()
        self.assertEqual(self.body("payroll-payment-status", u, **FEB, employeeIds=str(self.e3.id))["rows"], [])
        self.assertEqual(
            len(self.body("payroll-payment-status", self.admin, **FEB, employeeIds=str(self.e3.id))["rows"]), 1
        )

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("payroll-payment-status", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:3], ["Emp Code", "Employee", "Department"])
        self.assertIn("Slip net pay", header)
        self.assertEqual([c.value for c in ws[8]][0], "1001")  # department order: CUTTING first
        self.assertEqual(self.export("payroll-payment-status", "pdf", **FEB).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-deduction-summary
# ═════════════════════════════════════════════════════════════════════════════


class DeductionSummaryTests(PayrollCoreBase):
    def test_golden_rows_percent_and_subtotals(self):
        b = self.body("salary-deduction-summary", **FEB)
        c = _by_code(b, "1002")
        self.assertEqual(
            {
                k: c[k]
                for k in (
                    "totalEarnings",
                    "pfDeduction",
                    "esiDeduction",
                    "advanceDeduction",
                    "lateDeduction",
                    "otherDeductions",
                    "totalDeductions",
                    "deductionPct",
                    "netPay",
                )
            },
            {
                "totalEarnings": 15300.0,
                "pfDeduction": 918.0,
                "esiDeduction": 114.75,
                "advanceDeduction": 0.0,
                "lateDeduction": 425.0,
                "otherDeductions": 0.0,
                "totalDeductions": 1457.75,
                "deductionPct": 9.53,
                "netPay": 13842.25,
            },
        )
        a = _by_code(b, "1001")
        self.assertEqual((a["advanceDeduction"], a["totalDeductions"], a["deductionPct"]), (2000.0, 3440.0, 13.76))
        p = _by_code(b, "2001", "02-Feb-2026 to 08-Feb-2026")
        self.assertIsNone(p["lateDeduction"])  # production late detection off: no figure
        self.assertEqual((p["otherDeductions"], p["advanceDeduction"], p["totalDeductions"]), (0.0, 1000.0, 1478.13))
        sew = next(r for r in b["rows"] if r.get("employeeName") == "SEWING total")
        self.assertEqual((sew["totalDeductions"], sew["totalEarnings"], sew["deductionPct"]), (2470.25, 30300.0, 8.15))
        _assert_totals_match(self, b)
        self.assertEqual(b["totals"]["totalDeductions"], 10635.88)
        self.assertEqual(b["totals"]["netPay"], 95414.12)

    def test_summary_shares_and_notes(self):
        b = self.body("salary-deduction-summary", **FEB)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(
            (s["Total deductions"], s["PF"], s["ESI"], s["Advance recovery"], s["Late deduction"], s["Other / manual"]),
            (10635.88, 6828.0, 382.88, 3000.0, 425.0, 0.0),
        )
        self.assertEqual((s["Employees with deductions"], s["Deductions as % of earnings"]), (7, 10.03))
        shares = next(n for n in b["notes"] if n.startswith("Share of total deductions"))
        self.assertIn("PF 64.2%", shares)  # 6828 / 10635.88
        self.assertTrue(any("NOT deduction lines" in n for n in b["notes"]))
        self.assertTrue(any("regenerated months" in n for n in b["notes"]))

    def test_deduction_head_filter(self):
        def codes(head=None, **p):
            extra = {"deductionHead": head} if head else {}
            return [r["employeeCode"] for r in _body_rows(self.body("salary-deduction-summary", **FEB, **extra, **p))]

        self.assertEqual(len(codes()), 8)  # default: any deduction
        self.assertEqual(codes("advance"), ["1001", "2001"])
        self.assertEqual(codes("late"), ["1002"])
        self.assertEqual(sorted(codes("esi")), sorted(["1002", "1004", "73", "2001", "2001", "2002"]))
        self.assertEqual(codes("other"), [])
        self.assertEqual(len(codes("all")), 8)
        # a slip with no deduction at all only shows under "All slips"
        SalarySlip.objects.filter(employee=self.e5).update(
            pf_deduction=0,
            esi_deduction=0,
            total_deductions=0,
            net_salary=Decimal("15000"),
        )
        self.assertNotIn("73", codes())
        self.assertIn("73", codes("all"))

    def test_other_amount_exposes_manual_edits(self):
        SalarySlip.objects.filter(employee=self.e3).update(
            total_deductions=Decimal("2000"), net_salary=Decimal("28000")
        )
        r = _by_code(self.body("salary-deduction-summary", **FEB), "1003")
        self.assertEqual((r["pfDeduction"], r["otherDeductions"], r["totalDeductions"]), (1800.0, 200.0, 2000.0))

    def test_zero_earnings_do_not_divide_by_zero(self):
        SalarySlip.objects.filter(employee=self.e4).update(gross_salary=0, ot_amount=0)
        r = _by_code(self.body("salary-deduction-summary", **FEB), "1004")
        self.assertIsNone(r["deductionPct"])

    def test_group_by_and_other_filters(self):
        b = self.body("salary-deduction-summary", **FEB, groupBy="employmentType")
        subs = {r["employeeName"]: r["totalDeductions"] for r in b["rows"] if r.get("_kind") == "subtotal"}
        self.assertEqual(subs, {"Production total": 2115.63, "Staff total": 8520.25})
        _assert_totals_match(self, b)
        flat = self.body("salary-deduction-summary", **FEB, groupBy="none")
        self.assertFalse(any(r.get("_kind") for r in flat["rows"]))
        for params, expected in (
            ({"employmentType": "production"}, ["2001", "2001", "2002"]),
            ({"departmentIds": str(self.finish.id)}, ["1003", "2002"]),
            ({"branchIds": str(self.b2.id)}, ["1003", "2002"]),
            ({"employeeIds": str(self.e1.id)}, ["1001"]),
            ({"employeeStatus": "inactive"}, ["1004"]),
        ):
            got = [
                r["employeeCode"]
                for r in _body_rows(self.body("salary-deduction-summary", **FEB, groupBy="none", **params))
            ]
            self.assertEqual(got, expected, params)

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("salary-deduction-summary", u, **FEB)
        self.assertNotIn("1003", {r["employeeCode"] for r in _body_rows(b)})
        self.assertEqual(_body_rows(self.body("salary-deduction-summary", u, **FEB, branchIds=str(self.b2.id))), [])
        self.assertEqual(_body_rows(self.body("salary-deduction-summary", u, **FEB, employeeIds=str(self.p2.id))), [])
        self.assertAlmostEqual(b["totals"]["netPay"], 65469.12, places=2)

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("salary-deduction-summary", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertIn("Deduction %", header)
        self.assertEqual([c.value for c in ws[8]][:2], ["1001", "Anita Test"])
        self.assertEqual(self.export("salary-deduction-summary", "pdf", **FEB).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  department-salary-cost
# ═════════════════════════════════════════════════════════════════════════════


def _dept(body, name, kind=None):
    for r in body["rows"]:
        if r["department"] == name and (kind is None or r["employmentType"] == kind):
            return r
    raise AssertionError(f"no department row {name} {kind}")


class DepartmentCostTests(PayrollCoreBase):
    def test_golden_department_rows(self):
        b = self.body("department-salary-cost", **FEB)
        self.assertEqual([r["department"] for r in b["rows"]], ["CUTTING", "FINISHING", "SEWING", "Unassigned"])
        c = _dept(b, "CUTTING")
        self.assertEqual(
            {
                k: c[k]
                for k in (
                    "employmentType",
                    "headcount",
                    "slips",
                    "basic",
                    "hra",
                    "otherAllowances",
                    "grossEarned",
                    "otAmount",
                    "totalEarnings",
                    "employeePf",
                    "employeeEsi",
                    "employerEstimate",
                    "employerCost",
                    "advanceRecovered",
                    "lateDeduction",
                    "totalDeductions",
                    "netPay",
                    "avgNetPerEmployee",
                )
            },
            # Basic = Anita 12000 + Esha's two production period wages 3750 + 3000; HRA / allowances are staff only
            {
                "employmentType": "Staff + Production",
                "headcount": 2,
                "slips": 3,
                "basic": 18750.0,
                "hra": 4800.0,
                "otherAllowances": 7200.0,
                "grossEarned": 30750.0,
                "otAmount": 1000.0,
                "totalEarnings": 31750.0,
                "employeePf": 2250.0,
                "employeeEsi": 50.63,
                # employer PF 12% of basic (12000 + 3750 + 3000) = 2250.00; ESI 3.25% of gross (3750 + 3000) = 219.375 -> 219.38
                "employerEstimate": 2469.38,
                "employerCost": 34219.38,
                "advanceRecovered": 3000.0,
                "lateDeduction": 0.0,
                "totalDeductions": 5300.63,
                "netPay": 26449.37,
                "avgNetPerEmployee": 13224.68,
            },
        )
        s = _dept(b, "SEWING")
        self.assertEqual(
            (s["employmentType"], s["headcount"], s["grossEarned"], s["lateDeduction"], s["netPay"]),
            ("Staff", 2, 30300.0, 425.0, 27829.75),
        )
        self.assertEqual((s["employerEstimate"], s["employerCost"]), (2802.75, 33102.75))  # 1818.00 + 984.75
        f = _dept(b, "FINISHING")
        self.assertEqual((f["netPay"], f["employerEstimate"], f["employerCost"]), (29945.0, 2105.0, 34105.0))
        u = _dept(b, "Unassigned")  # NULL department is a row of its own
        self.assertEqual((u["headcount"], u["netPay"], u["employerEstimate"]), (1, 11190.0, 1110.0))

    def test_company_totals_shares_and_summary(self):
        b = self.body("department-salary-cost", **FEB)
        t = b["totals"]
        self.assertEqual((t["headcount"], t["slips"]), (7, 8))  # each person once, even with two production slips
        self.assertEqual(
            (t["totalEarnings"], t["employerEstimate"], t["employerCost"], t["netPay"]),
            (106050.0, 8487.13, 114537.13, 95414.12),
        )
        self.assertEqual((t["totalDeductions"], t["advanceRecovered"], t["lateDeduction"]), (10635.88, 3000.0, 425.0))
        # the three earning heads add up to gross pay (production wages sit under Basic)
        self.assertEqual((t["basic"], t["hra"], t["otherAllowances"]), (56900.0, 19260.0, 28890.0))
        self.assertEqual(round(t["basic"] + t["hra"] + t["otherAllowances"], 2), t["grossEarned"])
        _assert_totals_match(self, b, skip=("headcount", "slips"))
        self.assertEqual(sum(r["headcount"] for r in b["rows"]), t["headcount"])
        self.assertAlmostEqual(sum(r["sharePct"] for r in b["rows"]), 100.0, delta=0.05)
        self.assertEqual(_dept(b, "CUTTING")["sharePct"], 29.88)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Employees paid"], s["Net pay"], s["Employer cost (estimate)"]), (7, 95414.12, 114537.13))
        self.assertEqual(
            (s["Staff net pay"], s["Production net pay"], s["Cost per head"]), (88779.75, 6634.37, 16362.45)
        )
        self.assertEqual(s["Largest department share (CUTTING)"], 29.88)
        notes = " ".join(b["notes"])
        self.assertIn("CURRENT department", notes)
        self.assertIn("ESTIMATE", notes)
        self.assertIn("Unassigned", notes)

    def test_department_and_type_breakdown_with_subtotals(self):
        b = self.body("department-salary-cost", **FEB, breakdown="department_type")
        self.assertEqual(
            [(r["department"], r["employmentType"], r.get("_kind")) for r in b["rows"]],
            [
                ("CUTTING", "Production", None),
                ("CUTTING", "Staff", None),
                ("CUTTING total", "Staff + Production", "subtotal"),
                ("FINISHING", "Production", None),
                ("FINISHING", "Staff", None),
                ("FINISHING total", "Staff + Production", "subtotal"),
                ("SEWING", "Staff", None),
                ("Unassigned", "Staff", None),
            ],
        )
        prod = _dept(b, "CUTTING", "Production")
        self.assertEqual(
            (prod["headcount"], prod["slips"], prod["grossEarned"], prod["netPay"]), (1, 2, 6750.0, 4889.37)
        )
        self.assertEqual(
            (prod["employerEstimate"], prod["otAmount"]), (1029.38, 0.0)
        )  # PF 810.00 + ESI 219.375 -> 219.38
        sub = _dept(b, "CUTTING total")
        self.assertEqual((sub["headcount"], sub["netPay"]), (2, 26449.37))
        self.assertEqual(b["totals"]["headcount"], 7)
        self.assertEqual(b["totals"]["netPay"], 95414.12)  # subtotals are not double counted
        prod_only = self.body("department-salary-cost", **FEB, breakdown="department_type", employmentType="production")
        self.assertEqual(
            [(r["department"], r["employmentType"]) for r in prod_only["rows"]],
            [("CUTTING", "Production"), ("FINISHING", "Production")],
        )

    def test_financial_year_replaces_the_month(self):
        b = self.body("department-salary-cost", **FY, period="2026-02")
        self.assertEqual(b["totals"]["netPay"], 193934.12)
        self.assertEqual((b["totals"]["headcount"], b["totals"]["slips"]), (7, 12))
        c = _dept(b, "CUTTING")
        self.assertEqual(
            (c["slips"], c["grossEarned"], c["advanceRecovered"], c["netPay"]), (5, 78750.0, 6000.0, 68569.37)
        )
        self.assertEqual(_dept(b, "FINISHING")["netPay"], 86345.0)
        self.assertEqual(_dept(b, "SEWING")["netPay"], 27829.75)  # only Feb has slips for Bala and Zed
        same = self.body("department-salary-cost", **FY, period="2026-01")
        self.assertEqual(same["totals"]["netPay"], 193934.12)
        self.assertTrue(any("FY" in f["value"] or "2025" in f["value"] for f in b["filters"]))
        self.assertTrue(any("Apr 2025 to Mar 2026" in n for n in b["notes"]))

    def test_month_window_excludes_other_months(self):
        b = self.body("department-salary-cost", period="2026-01")
        self.assertEqual(b["totals"]["netPay"], 50760.0)  # Anita 22560 + Chitra 28200
        self.assertEqual([r["department"] for r in b["rows"]], ["CUTTING", "FINISHING"])

    def test_every_filter_narrows(self):
        def depts(**p):
            return [r["department"] for r in self.body("department-salary-cost", **FEB, **p)["rows"]]

        self.assertEqual(depts(employmentType="staff"), ["CUTTING", "FINISHING", "SEWING", "Unassigned"])
        self.assertEqual(depts(employmentType="production"), ["CUTTING", "FINISHING"])
        self.assertEqual(depts(departmentIds=str(self.sewing.id)), ["SEWING"])
        self.assertEqual(depts(branchIds=str(self.b2.id)), ["FINISHING"])
        self.assertEqual(depts(employeeStatus="inactive"), ["Unassigned"])
        self.assertEqual(depts(employeeStatus="active"), ["CUTTING", "FINISHING", "SEWING"])
        prod = self.body("department-salary-cost", **FEB, employmentType="production")
        self.assertEqual(prod["totals"]["netPay"], 6634.37)
        self.assertEqual(prod["totals"]["headcount"], 2)

    def test_legacy_weekly_slip_only_with_the_toggle(self):
        b = self.body("department-salary-cost", **FEB, includeLegacyWeekly="true")
        self.assertEqual(b["totals"]["netPay"], 96414.12)
        self.assertEqual(b["totals"]["slips"], 9)
        self.assertEqual(b["totals"]["headcount"], 7)  # Esha is still one person

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("department-salary-cost", u, **FEB)
        self.assertEqual([r["department"] for r in b["rows"]], ["CUTTING", "SEWING", "Unassigned"])
        self.assertEqual((b["totals"]["headcount"], b["totals"]["netPay"]), (5, 65469.12))
        self.assertEqual(self.body("department-salary-cost", u, **FEB, branchIds=str(self.b2.id))["rows"], [])
        self.assertEqual(self.body("department-salary-cost", u, **FEB, departmentIds=str(self.finish.id))["rows"], [])

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("department-salary-cost", **FEB).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:3], ["Department", "Type", "Employees"])
        self.assertEqual([c.value for c in ws[8]][:3], ["CUTTING", "Staff + Production", 2])
        net = header.index("Net pay") + 1
        self.assertEqual(ws.cell(row=12, column=net).value, 95414.12)  # totals row after four departments
        self.assertEqual(self.export("department-salary-cost", "pdf", **FEB).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  payroll-month-comparison
# ═════════════════════════════════════════════════════════════════════════════


class MonthComparisonTests(PayrollCoreBase):
    def test_twelve_months_in_financial_year_order_with_deltas(self):
        b = self.body("payroll-month-comparison", **FY)
        self.assertEqual(
            [r["monthLabel"] for r in b["rows"]],
            [
                "Apr 2025",
                "May 2025",
                "Jun 2025",
                "Jul 2025",
                "Aug 2025",
                "Sep 2025",
                "Oct 2025",
                "Nov 2025",
                "Dec 2025",
                "Jan 2026",
                "Feb 2026",
                "Mar 2026",
            ],
        )
        rows = {r["monthLabel"]: r for r in b["rows"]}
        for m in ("Apr 2025", "Aug 2025", "Dec 2025"):  # months without payroll stay in as zero rows
            self.assertEqual((rows[m]["slips"], rows[m]["netPay"], rows[m]["flag"]), (0, 0.0, "No payroll"))
        jan, feb, mar = rows["Jan 2026"], rows["Feb 2026"], rows["Mar 2026"]
        self.assertEqual((jan["employeesPaid"], jan["slips"], jan["netPay"]), (2, 2, 50760.0))
        self.assertEqual((feb["employeesPaid"], feb["slips"], feb["netPay"]), (7, 8, 95414.12))
        self.assertEqual((mar["employeesPaid"], mar["slips"], mar["netPay"]), (2, 2, 47760.0))
        self.assertEqual((feb["totalEarnings"], feb["otAmount"], feb["totalDeductions"]), (106050.0, 1000.0, 10635.88))
        self.assertEqual((jan["totalEarnings"], jan["totalDeductions"]), (54000.0, 3240.0))  # 2 x PF (1440 + 1800)
        self.assertEqual((feb["momChangeAmount"], feb["momChangePct"]), (44654.12, 87.97))
        self.assertEqual((mar["momChangeAmount"], mar["momChangePct"]), (-47654.12, -49.94))
        self.assertEqual((jan["momChangeAmount"], jan["momChangePct"]), (50760.0, None))  # previous month is zero: no %
        self.assertIsNone(rows["Apr 2025"]["momChangeAmount"])  # first month has nothing before it
        self.assertEqual(feb["avgNetPerEmployee"], 13630.59)
        self.assertIsNone(rows["Apr 2025"]["avgNetPerEmployee"])

    def test_totals_and_summary(self):
        b = self.body("payroll-month-comparison", **FY)
        t = b["totals"]
        self.assertEqual((t["employeesPaid"], t["slips"], t["netPay"]), (7, 12, 193934.12))
        self.assertEqual(round(sum(r["netPay"] for r in b["rows"]), 2), t["netPay"])
        self.assertEqual(round(sum(r["slips"] for r in b["rows"]), 2), t["slips"])
        _assert_totals_match(self, b, skip=("employeesPaid",))
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(s["Net pay for FY 2025-26"], 193934.12)
        self.assertEqual(s["Highest month (Feb 2026)"], 95414.12)
        self.assertEqual(s["Lowest month (Mar 2026)"], 47760.0)
        self.assertEqual(s["Average monthly net pay"], 64644.71)  # 193934.12 / 3 months with payroll
        self.assertEqual(s["Employees paid in the year"], 7)

    def test_current_month_is_marked_provisional(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=date(2026, 3, 10)):
            b = self.body("payroll-month-comparison", **FY)
        rows = {r["monthLabel"]: r for r in b["rows"]}
        self.assertEqual(rows["Mar 2026"]["flag"], "Provisional")
        self.assertIsNone(rows["Feb 2026"]["flag"])

    def test_default_is_the_current_financial_year(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=date(2026, 3, 10)):
            b = self.body("payroll-month-comparison")
        self.assertEqual(b["rows"][0]["monthLabel"], "Apr 2025")
        self.assertEqual(b["totals"]["netPay"], 193934.12)

    def test_type_department_and_branch_filters(self):
        prod = self.body("payroll-month-comparison", **FY, employmentType="production")
        rows = {r["monthLabel"]: r for r in prod["rows"]}
        self.assertEqual(
            (rows["Feb 2026"]["employeesPaid"], rows["Feb 2026"]["slips"], rows["Feb 2026"]["netPay"]), (2, 3, 6634.37)
        )
        self.assertEqual(rows["Jan 2026"]["slips"], 0)
        self.assertEqual(prod["totals"]["netPay"], 6634.37)
        staff = self.body("payroll-month-comparison", **FY, employmentType="staff")
        self.assertEqual(staff["totals"]["netPay"], 187299.75)
        dept = self.body("payroll-month-comparison", **FY, departmentIds=str(self.finish.id))
        self.assertEqual(dept["totals"]["netPay"], 28200 * 3 + 1745)
        branch = self.body("payroll-month-comparison", **FY, branchIds=str(self.b2.id))
        self.assertEqual(branch["totals"]["netPay"], 28200 * 3 + 1745)

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("payroll-month-comparison", u, **FY)
        rows = {r["monthLabel"]: r for r in b["rows"]}
        self.assertEqual(
            (rows["Jan 2026"]["netPay"], rows["Feb 2026"]["netPay"], rows["Mar 2026"]["netPay"]),
            (22560.0, 65469.12, 19560.0),
        )
        self.assertEqual(rows["Feb 2026"]["employeesPaid"], 5)
        other = self.body("payroll-month-comparison", u, **FY, branchIds=str(self.b2.id))
        self.assertEqual({r["netPay"] for r in other["rows"]}, {0.0})  # nothing in the other branch is visible
        self.assertEqual((other["totals"]["slips"], other["totals"]["netPay"]), (0, 0))

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("payroll-month-comparison", **FY).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:3], ["Month", "Employees paid", "Slips"])
        self.assertEqual([c.value for c in ws[8]][:3], ["Apr 2025", 0, 0])
        self.assertEqual(ws.cell(row=18, column=header.index("Net pay") + 1).value, 95414.12)  # February
        self.assertEqual(ws.cell(row=20, column=header.index("Net pay") + 1).value, 193934.12)  # totals row
        self.assertEqual(self.export("payroll-month-comparison", "pdf", **FY).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  annual-earnings-statement
# ═════════════════════════════════════════════════════════════════════════════


class AnnualStatementTests(PayrollCoreBase):
    def test_golden_employee_rows(self):
        b = self.body("annual-earnings-statement", **FY)
        self.assertEqual([r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002", "1003", "1004", "2001", "2002"])
        a = _by_code(b, "1001")
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "employmentType",
                    "period",
                    "monthsPaid",
                    "basic",
                    "hra",
                    "otherAllowances",
                    "otAmount",
                    "totalEarnings",
                    "pfDeduction",
                    "esiDeduction",
                    "advanceDeduction",
                    "lateDeduction",
                    "totalDeductions",
                    "netPay",
                    "avgMonthlyNet",
                )
            },
            {
                "employmentType": "Staff",
                "period": "FY 2025-26",
                "monthsPaid": 3,
                "basic": 36000.0,
                "hra": 14400.0,
                "otherAllowances": 21600.0,
                "otAmount": 1000.0,
                "totalEarnings": 73000.0,
                "pfDeduction": 4320.0,
                "esiDeduction": 0.0,
                "advanceDeduction": 5000.0,
                "lateDeduction": 0.0,
                "totalDeductions": 9320.0,
                "netPay": 63680.0,
                "avgMonthlyNet": 21226.67,
            },
        )
        c = _by_code(b, "1002")
        self.assertEqual(
            (c["monthsPaid"], c["totalEarnings"], c["esiDeduction"], c["lateDeduction"], c["netPay"]),
            (1, 15300.0, 114.75, 425.0, 13842.25),
        )
        # production: two period slips in one month count as ONE month paid; Basic is the period wages
        p = _by_code(b, "2001")
        self.assertEqual(
            (p["employmentType"], p["monthsPaid"], p["basic"], p["hra"], p["totalEarnings"]),
            ("Production", 1, 6750.0, 0.0, 6750.0),
        )
        self.assertEqual(
            (p["pfDeduction"], p["esiDeduction"], p["advanceDeduction"], p["lateDeduction"], p["netPay"]),
            (810.0, 50.63, 1000.0, 0.0, 4889.37),
        )
        self.assertEqual(_by_code(b, "1003")["netPay"], 84600.0)
        self.assertEqual(_by_code(b, "1004")["department"], "Unassigned")

    def test_totals_and_summary(self):
        b = self.body("annual-earnings-statement", **FY)
        _assert_totals_match(self, b)
        t = b["totals"]
        self.assertEqual(
            (t["netPay"], t["monthsPaid"]), (193934.12, 11)
        )  # 3 + 3 + five people with one month + Esha and Farook
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual((s["Employees"], s["Total net pay"]), (7, 193934.12))
        self.assertEqual(round(s["Total earnings"] - t["totalDeductions"], 2), 193934.12)
        self.assertEqual(round(s["Total PF"] + s["Total ESI"], 2), round(t["pfDeduction"] + t["esiDeduction"], 2))
        notes = " ".join(b["notes"])
        self.assertIn("NOT a Form 16", notes)
        self.assertIn("Apr 2025 to Mar 2026", notes)

    def test_month_wise_rows_for_one_employee(self):
        b = self.body("annual-earnings-statement", **FY, employeeIds=str(self.e1.id), monthWise="true")
        self.assertEqual(
            [(r["period"], r["netPay"], r["monthsPaid"]) for r in b["rows"]],
            [("Jan 2026", 22560.0, 1), ("Feb 2026", 21560.0, 1), ("Mar 2026", 19560.0, 1)],
        )
        self.assertEqual(b["rows"][2]["advanceDeduction"], 3000.0)  # the March instalment
        self.assertEqual(b["totals"]["netPay"], 63680.0)
        wise = self.body("annual-earnings-statement", **FY, monthWise="true", employmentType="production")
        self.assertEqual(
            [(r["employeeCode"], r["period"]) for r in wise["rows"]], [("2001", "Feb 2026"), ("2002", "Feb 2026")]
        )

    def test_a_financial_year_without_payroll_is_empty_and_prior_years_are_excluded(self):
        self.assertEqual(self.body("annual-earnings-statement", financialYear="2024-25")["rows"], [])
        self.assertEqual(
            self.body("annual-earnings-statement", financialYear="2026-27")["rows"], []
        )  # April start: Apr 2026 on

    def test_calendar_year_start_month(self):
        _configure(bonus_fy_start_month=1)
        b = self.body(
            "annual-earnings-statement", financialYear="2026-27"
        )  # Jan-Dec 2026 when the year starts in January
        self.assertEqual(b["totals"]["netPay"], 193934.12)
        self.assertTrue(any("Jan 2026 to Dec 2026" in n for n in b["notes"]))

    def test_every_filter_narrows(self):
        def codes(**p):
            return [r["employeeCode"] for r in self.body("annual-earnings-statement", **FY, **p)["rows"]]

        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        self.assertEqual(codes(employeeStatus="active"), ["73", "1001", "1002", "1003", "2001", "2002"])
        self.assertEqual(codes(employmentType="production"), ["2001", "2002"])
        self.assertEqual(codes(employmentType="staff"), ["73", "1001", "1002", "1003", "1004"])
        self.assertEqual(codes(departmentIds=str(self.cutting.id)), ["1001", "2001"])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), ["1001"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(employeeIds=f"{self.e2.id},{self.p2.id}"), ["1002", "2002"])

    def test_an_employee_who_changed_type_has_a_row_per_type(self):
        Employee.objects.filter(pk=self.e5.pk).update(
            employment_type="production"
        )  # Zed's staff slip is still a staff slip
        b = self.body("annual-earnings-statement", **FY, employeeIds=str(self.e5.id))
        self.assertEqual([(r["employmentType"], r["netPay"]) for r in b["rows"]], [("Staff", 13987.5)])
        self.assertEqual(
            self.body("annual-earnings-statement", **FY, employeeIds=str(self.e5.id), employmentType="production")[
                "rows"
            ],
            [],
        )

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("annual-earnings-statement", u, **FY)
        self.assertNotIn("1003", [r["employeeCode"] for r in b["rows"]])
        self.assertAlmostEqual(b["totals"]["netPay"], 63680.0 + 13842.25 + 11190.0 + 13987.5 + 4889.37, places=2)
        self.assertEqual(self.body("annual-earnings-statement", u, **FY, branchIds=str(self.b2.id))["rows"], [])
        self.assertEqual(self.body("annual-earnings-statement", u, **FY, employeeIds=str(self.p2.id))["rows"], [])

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("annual-earnings-statement", **FY).active
        header = [c.value for c in ws[7]]
        self.assertEqual(header[:2], ["Emp Code", "Employee"])
        self.assertEqual([c.value for c in ws[8]][:2], ["73", "Zed Test"])
        self.assertEqual(ws.cell(row=8 + 7, column=header.index("Net pay") + 1).value, 193934.12)
        self.assertEqual(self.export("annual-earnings-statement", "pdf", **FY).status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  salary-master
# ═════════════════════════════════════════════════════════════════════════════


class SalaryMasterTests(PayrollCoreBase):
    def _increments(self):
        SalaryIncrement.objects.create(
            employee=self.e1,
            previous_salary=Decimal("20000"),
            new_salary=Decimal("22000"),
            percent=Decimal("10.00"),
            effective_date=date(2025, 4, 1),
        )
        SalaryIncrement.objects.create(
            employee=self.e1,
            previous_salary=Decimal("22000"),
            new_salary=Decimal("24000"),
            percent=Decimal("9.09"),
            effective_date=date(2025, 10, 1),
        )

    def test_golden_rows(self):
        self._increments()
        b = self.body("salary-master")
        self.assertEqual(
            [r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002", "1003", "2001", "2002"]
        )  # active only
        a = _by_code(b, "1001")
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "branch",
                    "employmentType",
                    "joinDate",
                    "currentSalary",
                    "salaryPerShift",
                    "initialSalary",
                    "totalIncrement",
                    "incrementCount",
                    "lastIncrementDate",
                    "lastIncrementPct",
                    "pfNumber",
                    "esiNumber",
                    "uanNumber",
                    "bankAccount",
                    "status",
                )
            },
            {
                "branch": "Unit 1",
                "employmentType": "Staff",
                "joinDate": "2024-04-15",
                "currentSalary": 24000.0,
                "salaryPerShift": None,
                "initialSalary": 20000.0,
                "totalIncrement": 4000.0,
                "incrementCount": 2,
                "lastIncrementDate": "2025-10-01",
                "lastIncrementPct": 9.09,
                "pfNumber": "PF/001",
                "esiNumber": None,
                "uanNumber": None,
                "bankAccount": "XXXXXXXXXX5678",
                "status": "Active",
            },
        )
        c = _by_code(b, "1002")  # no increment history: initial salary falls back to the current one
        self.assertEqual(
            (c["initialSalary"], c["totalIncrement"], c["incrementCount"], c["lastIncrementDate"], c["joinDate"]),
            (20400.0, None, 0, None, "2023-06-15"),
        )
        self.assertEqual((c["esiNumber"], c["bankAccount"]), ("ESI-77", None))
        p = _by_code(b, "2001")
        self.assertEqual(
            (p["employmentType"], p["currentSalary"], p["salaryPerShift"], p["initialSalary"]),
            ("Production", None, 500.0, None),
        )
        self.assertEqual(_by_code(b, "1003")["bankAccount"], "XXXXXXXX3344")

    def test_initial_salary_recorded_at_joining_wins(self):
        self._increments()
        Employee.objects.filter(pk=self.e1.pk).update(initial_salary=Decimal("18000"))
        self.assertEqual(_by_code(self.body("salary-master"), "1001")["initialSalary"], 18000.0)

    def test_full_account_number_is_never_shown(self):
        b = self.body("salary-master")
        text = str(b)
        for full in ("50100012345678", "300011223344", "6000111122223333"):
            self.assertNotIn(full, text)
        ws = self.xlsx("salary-master").active
        cells = [str(c.value) for row in ws.iter_rows() for c in row if c.value is not None]
        self.assertNotIn("50100012345678", " ".join(cells))

    def test_summary(self):
        b = self.body("salary-master")
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(s["Employees"], 6)
        self.assertEqual(s["Monthly salary commitment (staff)"], 89400.0)  # 24000 + 20400 + 30000 + 15000
        self.assertEqual((s["Average staff salary"], s["Average rate per shift"]), (22350.0, 450.0))
        self.assertEqual(
            (s["No salary / rate"], s["No bank account"], s["No PF number"], s["No ESI number"]), (0, 3, 5, 5)
        )
        self.assertTrue(any("6 employee(s) have no UAN" in n for n in b["notes"]))

    def test_missing_data_filter(self):
        def codes(kind, **p):
            return [r["employeeCode"] for r in self.body("salary-master", missingData=kind, **p)["rows"]]

        self.assertEqual(codes("no_bank"), ["73", "1002", "2002"])
        self.assertEqual(codes("no_pf"), ["73", "1002", "1003", "2001", "2002"])
        self.assertEqual(codes("no_esi"), ["73", "1001", "1003", "2001", "2002"])
        self.assertEqual(len(codes("no_uan")), 6)
        self.assertEqual(codes("no_salary"), [])
        Employee.objects.create(
            employee_code="3001", first_name="Nil", last_name="Salary", employment_type="staff", branch=self.b1
        )
        Employee.objects.create(
            employee_code="3002", first_name="Nil", last_name="Rate", employment_type="production", branch=self.b1
        )
        self.assertEqual(codes("no_salary"), ["3001", "3002"])
        self.assertEqual(codes("no_bank", employeeStatus="inactive"), [])  # Deepak has a bank account

    def test_every_filter_narrows(self):
        def codes(**p):
            return [r["employeeCode"] for r in self.body("salary-master", **p)["rows"]]

        self.assertEqual(codes(employeeStatus="all")[-3:], ["1004", "2001", "2002"])
        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        self.assertEqual(codes(employmentType="production"), ["2001", "2002"])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), ["1001"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003", "2002"])
        self.assertEqual(codes(employeeIds=str(self.e3.id)), ["1003"])
        # a leaver with no department / designation is still listed
        row = _by_code(self.body("salary-master", employeeStatus="inactive"), "1004")
        self.assertEqual(
            (row["department"], row["designation"], row["joinDate"], row["status"]),
            ("Unassigned", None, None, "Inactive"),
        )

    def test_branch_isolation(self):
        self._increments()
        u = self.branch_user
        b = self.body("salary-master", u)
        self.assertEqual([r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002", "2001"])
        self.assertEqual(self.body("salary-master", u, branchIds=str(self.b2.id))["rows"], [])
        self.assertEqual(self.body("salary-master", u, employeeIds=str(self.e3.id))["rows"], [])
        # increment history of an employee in the other branch never leaks into the aggregates
        SalaryIncrement.objects.create(
            employee=self.e3,
            previous_salary=Decimal("1"),
            new_salary=Decimal("2"),
            percent=Decimal("1"),
            effective_date=date(2025, 5, 5),
        )
        self.assertEqual(_by_code(self.body("salary-master", u), "1001")["incrementCount"], 2)
        self.assertEqual(_by_code(self.body("salary-master", self.admin), "1003")["incrementCount"], 1)

    def test_xlsx_keeps_identifiers_as_text(self):
        ws = self.xlsx("salary-master").active
        header = [c.value for c in ws[7]]
        row = [c for c in ws[9]]  # second employee by code order: 1001
        self.assertEqual(row[0].value, "1001")
        pf = header.index("PF number")
        self.assertEqual(row[pf].value, "PF/001")
        self.assertEqual(row[pf].data_type, "s")
        self.assertEqual(row[header.index("Monthly salary")].value, 24000.0)
        self.assertEqual(self.export("salary-master", "pdf").status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  employer-cost-ctc
# ═════════════════════════════════════════════════════════════════════════════


class EmployerCostTests(PayrollCoreBase):
    def test_golden_rows(self):
        b = self.body("employer-cost-ctc")
        self.assertEqual(
            [r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002", "1003"]
        )  # active with a monthly salary
        a = _by_code(b, "1001")
        self.assertEqual(
            {
                k: a[k]
                for k in (
                    "branch",
                    "employmentType",
                    "splitStatus",
                    "basic",
                    "da",
                    "retainingAllowance",
                    "otherAllowance",
                    "petrolAllowance",
                    "hra",
                    "specialAllowance",
                    "ca",
                    "employerPf",
                    "employerEsi",
                    "grossMonthly",
                    "annualCtc",
                )
            },
            {
                "branch": "Unit 1",
                "employmentType": "Staff",
                "splitStatus": "Automatic",
                # nobody here has a recorded split, so the automatic 50% + 50% split of 24,000 is shown
                "basic": 4000.0,
                "da": 4000.0,
                "retainingAllowance": 4000.0,
                "otherAllowance": 2400.0,
                "petrolAllowance": 2400.0,
                "hra": 2400.0,
                "specialAllowance": 2400.0,
                "ca": 2400.0,
                "employerPf": 1440.0,
                "employerEsi": 0.0,
                "grossMonthly": 24000.0,
                "annualCtc": 305280.0,
            },
        )
        c = _by_code(b, "1002")  # 20,400 is within the ESI ceiling: 0.75% of salary
        self.assertEqual(
            (c["basic"], c["otherAllowance"], c["employerPf"], c["employerEsi"], c["annualCtc"]),
            (3400.0, 2040.0, 1224.0, 153.0, 261324.0),
        )
        self.assertEqual(
            (_by_code(b, "1003")["annualCtc"], _by_code(b, "73")["employerEsi"], _by_code(b, "73")["annualCtc"]),
            (381600.0, 112.5, 192150.0),
        )
        t = b["totals"]
        self.assertEqual(
            (t["grossMonthly"], t["employerPf"], t["employerEsi"], t["annualCtc"]), (89400.0, 5364.0, 265.5, 1140354.0)
        )
        _assert_totals_match(self, b)
        s = {x["label"]: x["value"] for x in b["summary"]}
        self.assertEqual(
            (s["Employees"], s["Monthly cost to company"], s["Annual cost to company"]), (4, 95029.5, 1140354.0)
        )
        self.assertEqual(s["Average annual CTC"], 285088.5)

    def test_matches_the_compensation_page_exactly(self):
        # a branch that overrides the PF rate, and an employee with a hand-made recorded split, must give the same
        # numbers as compensation_views (which shares the calculation, api.ctc)
        BranchSettingsOverride.objects.create(branch=self.b2, overrides={"pf_rate": 10})
        # 1002 earns 20,400: a hand-made split, 10,200 (8,000 + 1,200 + 1,000) and 10,200 (2,000 + 3,000 + 1,500 + 2,200 + 1,500)
        Employee.objects.filter(pk=self.e2.pk).update(
            salary_basic=Decimal("8000.00"),
            salary_da=Decimal("1200.00"),
            salary_retaining_allowance=Decimal("1000.00"),
            salary_other_allowance=Decimal("2000.00"),
            salary_petrol_allowance=Decimal("3000.00"),
            salary_hra=Decimal("1500.00"),
            salary_special_allowance=Decimal("2200.00"),
            salary_ca=Decimal("1500.00"),
        )
        b = self.body("employer-cost-ctc", employeeStatus="all")
        keys = (
            "basic",
            "da",
            "retainingAllowance",
            "otherAllowance",
            "petrolAllowance",
            "hra",
            "specialAllowance",
            "ca",
            "employerPf",
            "employerEsi",
            "grossMonthly",
            "annualCtc",
        )
        for e in (self.e1, self.e2, self.e3, self.e4, self.e5):
            e = Employee.objects.select_related("department", "designation", "branch").get(pk=e.pk)
            expected = _compensation_dict(e)
            row = _by_code(b, e.employee_code)
            self.assertEqual({k: row[k] for k in keys}, {k: expected[k] for k in keys}, e.employee_code)
        c = _by_code(b, "1003")
        self.assertEqual(
            (c["basic"] + c["da"] + c["retainingAllowance"], c["employerPf"]), (15000.0, 1500.0)
        )  # PF 10% of the first portion (half of 30,000)
        d = _by_code(b, "1002")  # the recorded split is shown as recorded, not re-worked
        self.assertEqual((d["basic"], d["petrolAllowance"], d["employerPf"]), (8000.0, 3000.0, 1224.0))
        self.assertEqual((d["splitStatus"], _by_code(b, "1001")["splitStatus"]), ("Recorded", "Automatic"))

    def test_employees_without_a_recorded_split_are_counted_in_a_note(self):
        b = self.body("employer-cost-ctc")
        self.assertTrue(any("4 employee(s) have no salary split recorded yet" in n for n in b["notes"]), b["notes"])
        Employee.objects.filter(pk=self.e1.pk).update(
            salary_basic=Decimal("12000.00"),
            salary_da=Decimal("0"),
            salary_retaining_allowance=Decimal("0"),
            salary_other_allowance=Decimal("12000.00"),
            salary_petrol_allowance=Decimal("0"),
            salary_hra=Decimal("0"),
            salary_special_allowance=Decimal("0"),
            salary_ca=Decimal("0"),
        )
        b = self.body("employer-cost-ctc")
        self.assertTrue(any("3 employee(s) have no salary split recorded yet" in n for n in b["notes"]), b["notes"])
        self.assertEqual(_by_code(b, "1001")["employerPf"], 1440.0)  # the split does not move the totals

    def test_a_stored_split_the_salary_has_moved_away_from_is_not_shown(self):
        # salary changed by a route that did not re-scale the split: the rows must still add up to the salary
        Employee.objects.filter(pk=self.e1.pk).update(
            salary_basic=Decimal("1000.00"),
            salary_da=Decimal("0"),
            salary_retaining_allowance=Decimal("0"),
            salary_other_allowance=Decimal("1000.00"),
            salary_petrol_allowance=Decimal("0"),
            salary_hra=Decimal("0"),
            salary_special_allowance=Decimal("0"),
            salary_ca=Decimal("0"),
        )  # a valid split of 2,000, but the salary is 24,000
        b = self.body("employer-cost-ctc")
        row = _by_code(b, "1001")
        self.assertEqual((row["basic"], row["otherAllowance"]), (4000.0, 2400.0))
        self.assertTrue(any("4 employee(s) have no salary split recorded yet" in n for n in b["notes"]), b["notes"])

    def test_production_employees_without_a_monthly_salary_are_left_out_with_a_note(self):
        b = self.body("employer-cost-ctc")
        self.assertNotIn("2001", {r["employeeCode"] for r in b["rows"]})
        self.assertTrue(any("2 employee(s) with no monthly salary are left out" in n for n in b["notes"]))
        # one with a monthly salary is included, computed with the production rates
        Employee.objects.filter(pk=self.p1.pk).update(salary_amount=Decimal("18000"))
        row = _by_code(self.body("employer-cost-ctc"), "2001")
        self.assertEqual(
            (
                row["employmentType"],
                row["basic"] + row["da"] + row["retainingAllowance"],
                row["employerPf"],
                row["employerEsi"],
            ),
            ("Production", 9000.0, 1080.0, 135.0),
        )

    def test_the_ctc_statement_is_not_tied_to_the_compensation_feature_switch(self):
        """The switch stops the background OT / Compensation features; the Compensation page (and so this same CTC
        statement) stays available to whoever holds the permission."""
        for on in (False, True):
            _configure(compensation_feature_enabled=on)
            for who in (self.comp_user, self.payroll_user, None):
                args = (who,) if who else ()
                b = self.body("employer-cost-ctc", *args)
                self.assertEqual(len(b["rows"]), 4, (on, who))
                self.assertFalse(any("switched off" in n for n in b["notes"]), (on, who))
            for fmt in ("xlsx", "pdf"):
                self.assertEqual(self.export("employer-cost-ctc", fmt, self.comp_user).status_code, 200)

    def test_notes_call_it_an_estimate(self):
        b = self.body("employer-cost-ctc")
        text = " ".join(b["notes"])
        self.assertIn("ESTIMATE", text)
        self.assertIn("3.25%", text)

    def test_every_filter_narrows(self):
        def codes(**p):
            return [r["employeeCode"] for r in self.body("employer-cost-ctc", **p)["rows"]]

        self.assertEqual(codes(employeeStatus="all"), ["73", "1001", "1002", "1003", "1004"])
        self.assertEqual(codes(employeeStatus="inactive"), ["1004"])
        self.assertEqual(codes(employmentType="staff"), ["73", "1001", "1002", "1003"])
        self.assertEqual(codes(employmentType="production"), [])
        self.assertEqual(codes(departmentIds=str(self.sewing.id)), ["73", "1002"])
        self.assertEqual(codes(designationIds=str(self.supervisor.id)), ["1001"])
        self.assertEqual(codes(branchIds=str(self.b2.id)), ["1003"])
        self.assertEqual(codes(employeeIds=str(self.e2.id)), ["1002"])

    def test_branch_isolation(self):
        u = self.branch_user
        b = self.body("employer-cost-ctc", u)
        self.assertEqual([r["employeeCode"] for r in b["rows"]], ["73", "1001", "1002"])
        self.assertEqual(self.body("employer-cost-ctc", u, branchIds=str(self.b2.id))["rows"], [])
        self.assertEqual(self.body("employer-cost-ctc", u, employeeIds=str(self.e3.id))["rows"], [])
        self.assertEqual(b["totals"]["grossMonthly"], 59400.0)

    def test_xlsx_and_pdf(self):
        ws = self.xlsx("employer-cost-ctc").active
        header = [c.value for c in ws[7]]
        self.assertIn("Annual CTC (est.)", header)
        self.assertEqual([c.value for c in ws[8]][:2], ["73", "Zed Test"])
        self.assertEqual(ws.cell(row=8, column=header.index("Annual CTC (est.)") + 1).value, 192150.0)
        self.assertEqual(self.export("employer-cost-ctc", "pdf").status_code, 200)


# ═════════════════════════════════════════════════════════════════════════════
#  cross-cutting: empty results, file signatures, N+1 guard
# ═════════════════════════════════════════════════════════════════════════════


class CrossCuttingTests(PayrollCoreBase):
    def test_empty_result_works_on_screen_and_in_both_exports(self):
        for rid in IDS:
            with self.subTest(rid):
                params = EMPTY_PARAMS[rid]
                b = self.body(rid, **params)
                if rid not in ("payroll-month-comparison",):  # the comparison always lists its 12 months
                    self.assertEqual(_body_rows(b), [], rid)
                self.assertIsInstance(b["notes"], list)
                x = self.export(rid, "xlsx", **params)
                self.assertEqual((x.status_code, x.content[:2]), (200, XLSX_MAGIC), rid)
                self.assertEqual(len(load_workbook(io.BytesIO(x.content)).worksheets) >= 1, True)
                p = self.export(rid, "pdf", **params)
                self.assertEqual((p.status_code, p.content[:4]), (200, b"%PDF"), rid)

    def test_populated_exports_have_valid_signatures(self):
        for rid in IDS:
            with self.subTest(rid):
                params = PERIOD_PARAMS[rid]
                x = self.export(rid, "xlsx", **params)
                self.assertEqual((x.status_code, x.content[:2]), (200, XLSX_MAGIC), rid)
                self.assertIn("spreadsheetml", x["Content-Type"])
                ws = load_workbook(io.BytesIO(x.content)).worksheets[0]
                self.assertEqual(ws["A3"].value, registry.get_spec(rid).title.upper())
                self.assertTrue(ws["A8"].value not in (None, ""), rid)
                p = self.export(rid, "pdf", **params)
                self.assertEqual((p.status_code, p.content[:4]), (200, b"%PDF"), rid)
                self.assertIn("application/pdf", p["Content-Type"])

    def test_wide_reports_print_on_a3_landscape_so_money_columns_do_not_wrap(self):
        a3 = {
            "salary-register",
            "salary-wages-statement",
            "department-salary-cost",
            "production-wage-sheet",
            "annual-earnings-statement",
            "salary-master",
            "employer-cost-ctc",
        }
        for rid in IDS:
            if rid == "salary-slip":
                continue  # the real slips: two per landscape A4 page
            with self.subTest(rid):
                pdf_bytes = self.export(rid, "pdf", **PERIOD_PARAMS[rid]).content
                import pdfplumber

                with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                    width = pdf.pages[0].width
                self.assertEqual(width > 1000, rid in a3, (rid, width))  # A3 landscape 1191pt, A4 landscape 842pt

    # ── N+1 guard ──
    def _extra(self, n):
        """n more employees in branch 1 (a mix of staff and production) with February slips and payroll rows."""
        emps = []
        for i in range(n):
            production = i % 3 == 0
            emps.append(
                Employee(
                    employee_code=f"9{i:03d}",
                    first_name=f"Extra{i}",
                    last_name="Emp",
                    employment_type="production" if production else "staff",
                    department=self.cutting if i % 2 else self.sewing,
                    designation=self.operator,
                    branch=self.b1,
                    salary_amount=None if production else Decimal("18000"),
                    salary_per_shift=Decimal("450") if production else None,
                    bank_name="HDFC Bank",
                    bank_account=f"7000{i:08d}",
                    bank_ifsc="HDFC0009999",
                    join_date="2025-01-05",
                    pf_number=f"PF{i}",
                )
            )
        emps = Employee.objects.bulk_create(emps)
        slips, payrolls = [], []
        for e in emps:
            if e.employment_type == "production":
                ps, pe = date(2026, 2, 16), date(2026, 2, 22)
                bd = {
                    "type": "production",
                    "salaryPerShift": 450.0,
                    "summary": {"daysWorked": 6, "daysAbsent": 1, "totalShifts": 6.0},
                    "days": [{"shiftsEarned": 1.0}] * 6,
                    "deductions": {"lateShiftPenalty": None, "pf": 324.0},
                }
                kw = dict(
                    period_start=ps,
                    period_end=pe,
                    basic=Decimal("2700"),
                    gross_salary=Decimal("2700"),
                    pf_deduction=Decimal("324"),
                    total_deductions=Decimal("324"),
                    net_salary=Decimal("2376"),
                    working_days=7,
                    present_days=Decimal("6.0"),
                    slip_number=f"SS/{e.employee_code}/2026-02-16_2026-02-22",
                )
                pkw = dict(
                    salary_mode="shift",
                    period_start=ps,
                    period_end=pe,
                    base_salary=Decimal("2700"),
                    gross_salary=Decimal("2700"),
                    deductions=Decimal("324"),
                    final_salary=Decimal("2376"),
                )
            else:
                bd = {
                    "type": "staff",
                    "summary": {"effectivePaidDays": 24.0, "totalWorkingDays": 24},
                    "earnings": {"monthlySalary": 18000.0},
                    "deductions": {"lateShiftPenalty": 0.0, "pf": 1080.0},
                }
                kw = dict(
                    basic=Decimal("9000"),
                    hra=Decimal("3600"),
                    allowances=Decimal("5400"),
                    gross_salary=Decimal("18000"),
                    pf_deduction=Decimal("1080"),
                    total_deductions=Decimal("1080"),
                    net_salary=Decimal("16920"),
                    working_days=24,
                    present_days=Decimal("24.0"),
                    slip_number=f"SS/{e.employee_code}/2026/02",
                )
                pkw = dict(
                    salary_mode="monthly",
                    base_salary=Decimal("18000"),
                    gross_salary=Decimal("18000"),
                    deductions=Decimal("1080"),
                    final_salary=Decimal("16920"),
                )
            slips.append(SalarySlip(employee=e, month=2, year=2026, breakdown_details=bd, **kw))
            payrolls.append(Payroll(employee=e, month=2, year=2026, **pkw))
        SalarySlip.objects.bulk_create(slips)
        Payroll.objects.bulk_create(payrolls)
        return emps

    def _queries(self, rid, params, fmt=None):
        with CaptureQueriesContext(connection) as ctx:
            if fmt:
                r = self.export(rid, fmt, **params)
            else:
                r = self.run_report(rid, **params)
            self.assertEqual(r.status_code, 200, (rid, r.content[:200]))
        return len(ctx.captured_queries)

    def test_query_count_does_not_grow_with_the_number_of_employees(self):
        three = [self.e1, self.e2, self.p1]
        ids3 = ",".join(str(e.id) for e in three)
        params = {rid: {**PERIOD_PARAMS[rid], "employeeIds": ids3} for rid in IDS}
        for rid in ("department-salary-cost", "payroll-month-comparison"):
            params[rid] = {**PERIOD_PARAMS[rid]}  # no employee picker on these two
        before = {(rid, fmt): self._queries(rid, params[rid], fmt) for rid in IDS for fmt in (None, "xlsx")}
        extras = self._extra(12)
        ids15 = ",".join(str(e.id) for e in three + extras)
        for rid in IDS:
            if "employeeIds" in params[rid]:
                params[rid]["employeeIds"] = ids15
        for rid in IDS:
            for fmt in (None, "xlsx"):
                after = self._queries(rid, params[rid], fmt)
                self.assertLessEqual(abs(after - before[(rid, fmt)]), 2, (rid, fmt, before[(rid, fmt)], after))
        # and the extra rows really were counted (the guard is not vacuous)
        b = self.body("salary-register", **FEB, employeeIds=ids15, groupBy="none")
        self.assertEqual(len(_body_rows(b)), 4 + 12 + 0)  # e1, e2, p1 (2 slips) + 12 extras

    def test_slip_pdf_query_count_grows_by_at_most_one_lookup_per_slip(self):
        # build_bulk_salary_slip_pdf reads the leave balances of every slip separately (existing behaviour, reused
        # unchanged); everything else in the export is constant.
        three = [self.e1, self.e2, self.e5]
        ids = ",".join(str(e.id) for e in three)
        a = self._queries("salary-slip", {**FEB, "employeeIds": ids}, "pdf")
        extras = self._extra(8)
        staff_extras = [e for e in extras if e.employment_type == "staff"]
        ids2 = ids + "," + ",".join(str(e.id) for e in staff_extras)
        b = self._queries("salary-slip", {**FEB, "employeeIds": ids2}, "pdf")
        self.assertLessEqual(b - a, len(staff_extras) + 1)


# ═════════════════════════════════════════════════════════════════════════════
#  adversarial review (independent reviewer): every test below states what SHOULD hold.
#  A failing test is a demonstrated defect in the definitions / framework, not a broken test.
# ═════════════════════════════════════════════════════════════════════════════


class AdversarialReviewTests(PayrollCoreBase):
    # ── stale (mid-month generated) staff slips ──
    def test_a_slip_first_generated_mid_month_is_still_flagged_after_the_month_has_ended(self):
        # Zed's February slip was generated on 10 Feb (the 18 days still to come counted as absent) and never
        # regenerated. Viewed in September it must not look like a clean, final slip.
        stamp = datetime(2026, 2, 10, 6, 0, tzinfo=timezone.utc)
        SalarySlip.objects.filter(employee=self.e5, month=2, year=2026).update(generated_at=stamp)
        Payroll.objects.filter(employee=self.e5, month=2, year=2026).update(updated_at=stamp)
        b = self.body("salary-slip", **FEB)
        self.assertEqual(_by_code(b, "73")["flag"], "Provisional")
        self.assertTrue(any("PROVISIONAL" in n for n in b["notes"]))

    # ── branch isolation of the filter description printed on screen / in every export header ──
    def test_filter_description_does_not_name_employees_or_departments_of_another_branch(self):
        # branch-1 login asks about a branch-2 employee and a branch-2 department by id
        b = self.body(
            "salary-register",
            self.branch_user,
            employeeIds=str(self.e3.id),
            departmentIds=str(self.finish.id),
            **FEB,
        )
        self.assertEqual(_body_rows(b), [])  # the rows are correctly empty ...
        shown = " | ".join(f"{f['label']}: {f['value']}" for f in b["filters"])
        # ... but the header must not spell out who / what those ids are
        self.assertNotIn("1003", shown)
        self.assertNotIn("Chitra", shown)
        self.assertNotIn("FINISHING", shown)

    # ── statutory identifiers are only for payroll roles (brief: "PF/ESI/UAN limited to roles with payroll access") ──
    def test_pf_esi_uan_numbers_are_hidden_from_a_role_that_only_holds_increment(self):
        Employee.objects.filter(pk=self.e1.pk).update(uan_number="100200300400")
        b = self.body("salary-master", self.inc_user, employeeIds=str(self.e1.id))
        row = _by_code(b, "1001")
        self.assertIsNone(row["pfNumber"])
        self.assertIsNone(row["esiNumber"])
        self.assertIsNone(row["uanNumber"])
        # ... while the payroll role keeps them
        row = _by_code(self.body("salary-master", self.payroll_user, employeeIds=str(self.e1.id)), "1001")
        self.assertEqual(row["pfNumber"], "PF/001")

    # ── bank advice: an employee whose periods are only partly paid ──
    def test_combined_line_of_a_partly_paid_employee_does_not_ask_to_pay_the_paid_period_again(self):
        # Esha: period 2-8 Feb is PAID, period 9-15 Feb is pending
        pending = SalarySlip.objects.get(employee=self.p1, period_start=date(2026, 2, 9))
        b = self.body("bank-advice", paymentStatus="all", combinePeriods="true", **FEB)
        row = _by_code(b, "2001")
        self.assertTrue(
            row["paymentStatus"] != "Pending" or abs(row["netPay"] - float(pending.net_salary)) < 0.01,
            f"a 'Pending' line of {row['netPay']} includes the already-paid period (pending part is {pending.net_salary})",
        )

    def test_hdfc_bulk_upload_sheet_never_repeats_salaries_that_are_already_paid(self):
        # only PAID rows selected: a bank upload of them would pay everybody a second time
        wb = self.xlsx("bank-advice", paymentStatus="paid", **FEB)
        paid_accounts = []
        if "HDFC Bulk Upload" in wb.sheetnames:
            ws = wb["HDFC Bulk Upload"]
            paid_accounts = [ws.cell(row=r, column=3).value for r in range(3, ws.max_row + 1)]
        self.assertEqual([a for a in paid_accounts if a], [])

    # ── GET must not write (salary slip PDF) ──
    def test_slip_pdf_export_does_not_create_the_company_document_settings_row(self):
        from .models import CompanyDocumentSettings

        CompanyDocumentSettings.objects.all().delete()
        r = self.export("salary-slip", "pdf", **FEB)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(CompanyDocumentSettings.objects.count(), 0)

    # ── production-only role: the Staff filter must not silently become "production" ──
    def test_production_only_role_asking_for_staff_slips_gets_nothing_not_production_slips(self):
        for rid in ("salary-register", "salary-slip", "salary-deduction-summary"):
            b = self.body(rid, self.prod_user, employmentType="staff", **FEB)
            self.assertEqual(_body_rows(b), [], rid)

    # ── summary card must be over the whole payroll ──
    def test_deduction_percentage_card_is_not_inflated_by_hiding_slips_without_deductions(self):
        # Zed (15,000) has PF; give the deduction-free slip of a new employee to the same month
        emp = Employee.objects.create(
            employee_code="8001",
            first_name="Nodeduct",
            last_name="Test",
            employment_type="staff",
            department=self.sewing,
            branch=self.b1,
            salary_amount=Decimal("50000"),
        )
        SalarySlip.objects.create(
            employee=emp,
            month=2,
            year=2026,
            slip_number="SS/8001/2026/02",
            basic=Decimal("25000"),
            hra=Decimal("10000"),
            allowances=Decimal("15000"),
            gross_salary=Decimal("50000"),
            net_salary=Decimal("50000"),
            working_days=24,
            present_days=Decimal("24"),
        )
        card = lambda b: next(s for s in b["summary"] if s["label"] == "Deductions as % of earnings")["value"]  # noqa: E731
        every = self.body("salary-deduction-summary", deductionHead="all", **FEB)
        default = self.body("salary-deduction-summary", **FEB)
        self.assertAlmostEqual(card(default), card(every), places=2)

    def test_the_reports_reconcile_with_each_other_to_the_paisa(self):
        """Same month, same population: every report that shows earnings / deductions / net must agree."""
        reg = self.body("salary-register", groupBy="none", **FEB)["totals"]
        wages = self.body("salary-wages-statement", **FEB)["totals"]
        ded = self.body("salary-deduction-summary", deductionHead="all", groupBy="none", **FEB)["totals"]
        cost = self.body("department-salary-cost", **FEB)["totals"]
        bank = self.body("bank-advice", paymentStatus="all", **FEB)["totals"]
        status_rows = _body_rows(self.body("payroll-payment-status", **FEB))
        comp = next(r for r in _body_rows(self.body("payroll-month-comparison", **FY)) if r["monthLabel"] == "Feb 2026")
        annual = self.body("annual-earnings-statement", monthWise="true", **FY)
        annual_feb = [r for r in _body_rows(annual) if r["period"] == "Feb 2026"]
        prod = self.body("production-wage-sheet", dateFrom="2026-02-01", dateTo="2026-02-28")["totals"]
        prod_rows = [
            r
            for r in _body_rows(self.body("salary-register", groupBy="none", **FEB))
            if r["employmentType"] == "Production"
        ]

        self.assertAlmostEqual(reg["netPay"], ded["netPay"], places=2)
        self.assertAlmostEqual(reg["netPay"], cost["netPay"], places=2)
        self.assertAlmostEqual(reg["netPay"], bank["netPay"], places=2)
        self.assertAlmostEqual(reg["netPay"], comp["netPay"], places=2)
        self.assertAlmostEqual(reg["netPay"], round(sum(r["netPay"] for r in annual_feb), 2), places=2)
        self.assertAlmostEqual(reg["netPay"], round(sum(r["slipNet"] for r in status_rows), 2), places=2)
        self.assertAlmostEqual(reg["totalEarnings"], wages["totalEarnings"], places=2)
        self.assertAlmostEqual(reg["totalEarnings"], cost["totalEarnings"], places=2)
        self.assertAlmostEqual(reg["totalEarnings"], ded["totalEarnings"], places=2)
        self.assertAlmostEqual(reg["totalEarnings"], comp["totalEarnings"], places=2)
        self.assertAlmostEqual(reg["totalDeductions"], ded["totalDeductions"], places=2)
        self.assertAlmostEqual(reg["totalDeductions"], cost["totalDeductions"], places=2)
        self.assertAlmostEqual(reg["totalDeductions"], comp["totalDeductions"], places=2)
        self.assertAlmostEqual(reg["pfDeduction"], ded["pfDeduction"], places=2)
        self.assertAlmostEqual(reg["pfDeduction"], cost["employeePf"], places=2)
        self.assertAlmostEqual(reg["esiDeduction"], cost["employeeEsi"], places=2)
        self.assertAlmostEqual(reg["advanceDeduction"], cost["advanceRecovered"], places=2)
        # production: the wage sheet is the same money as the production rows of the register
        self.assertAlmostEqual(prod["netPay"], round(sum(r["netPay"] for r in prod_rows), 2), places=2)
        self.assertAlmostEqual(prod["grossWages"], round(sum(r["totalEarnings"] for r in prod_rows), 2), places=2)
        # and the slip listing agrees with the register row by row
        slips = {(r["employeeCode"], r["period"]): r for r in _body_rows(self.body("salary-slip", **FEB))}
        for r in _body_rows(self.body("salary-register", groupBy="none", **FEB)):
            s = slips[(r["employeeCode"], r["period"])]
            for k in ("netPay", "totalEarnings", "totalDeductions", "pfDeduction", "esiDeduction", "advanceDeduction"):
                self.assertAlmostEqual(r[k], s[k], places=2, msg=(r["employeeCode"], k))

    def _hostile(self):
        """Real-world dirt: old-engine slips without a snapshot, a negative net, odd codes / names / accounts."""
        odd = Employee.objects.create(
            employee_code="A-12",
            first_name="=1+1<b>&Co",
            last_name="குமார்",  # Tamil letters (not in the bundled font)
            employment_type="staff",
            branch=None,
            salary_amount=Decimal("9000"),
            bank_name="  ",
            bank_account="AC-1234 5678 9012 3456 7890 1234 5678 90",
            bank_ifsc="hdfc0abc123",
            join_date="31/12/2020",
            pf_number="0123456789",
            uan_number="00987654321",
        )
        old_staff = SalarySlip.objects.create(
            employee=odd,
            month=2,
            year=2026,
            slip_number="SS/A-12/2026/02",
            basic=Decimal("4500"),
            hra=Decimal("1800"),
            allowances=Decimal("2700"),
            gross_salary=Decimal("9000"),
            pf_deduction=Decimal("540"),
            advance_deduction=Decimal("9000"),
            other_deductions=Decimal("100"),
            total_deductions=Decimal("9640"),
            net_salary=Decimal("-640"),
            working_days=24,
            present_days=Decimal("24"),
        )
        Payroll.objects.create(
            employee=odd,
            salary_mode="monthly",
            month=2,
            year=2026,
            base_salary=Decimal("9000"),
            gross_salary=Decimal("9000"),
            deductions=Decimal("9640"),
            final_salary=Decimal("-640"),
            status="Paid ",
        )
        Payroll.objects.create(  # a duplicate payroll row (NULL columns defeat the unique constraint)
            employee=odd,
            salary_mode="monthly",
            month=2,
            year=2026,
            base_salary=Decimal("9000"),
            gross_salary=Decimal("9000"),
            deductions=Decimal("0"),
            final_salary=Decimal("9000"),
            status="pending",
        )
        # production slip generated by an old engine: no snapshot, no payroll row
        SalarySlip.objects.create(
            employee=self.p2,
            month=2,
            year=2026,
            period_start=date(2026, 2, 16),
            period_end=date(2026, 2, 22),
            slip_number="SS/2002/2026-02-16_2026-02-22",
            basic=Decimal("1200"),
            gross_salary=Decimal("1200"),
            net_salary=Decimal("1200"),
            working_days=7,
            present_days=Decimal("3.0"),
        )
        return odd, old_staff

    def test_dirty_real_world_rows_do_not_crash_any_report_or_export(self):
        odd, _slip_row = self._hostile()
        for rid in IDS:
            params = dict(PERIOD_PARAMS[rid])
            if rid == "bank-advice":
                params["paymentStatus"] = "all"
            if rid == "salary-master":
                params["employeeStatus"] = "all"
            with self.subTest(rid):
                b = self.body(rid, **params)
                self.assertIsInstance(b["rows"], list)
                for fmt in ("xlsx", "pdf"):
                    r = self.export(rid, fmt, **params)
                    self.assertEqual(r.status_code, 200, (rid, fmt, r.content[:300]))

    def test_dirty_rows_are_reported_honestly(self):
        odd, _slip_row = self._hostile()
        reg = self.body("salary-register", groupBy="none", **FEB)
        row = _by_code(reg, "A-12")
        self.assertEqual(row["netPay"], -640.0)
        self.assertEqual(row["joinDate"], "2020-12-31")
        self.assertEqual(row["department"], "Unassigned")
        # the duplicate payroll rows resolve to ONE status, and 'Paid ' (padded) is still the word paid or not paid - never both
        self.assertIn(row["paymentStatus"], ("Paid", "Pending"))
        # the register still adds up
        _assert_totals_match(self, reg)
        # deduction summary: negative net does not break the percentage
        ded = self.body("salary-deduction-summary", deductionHead="all", groupBy="none", **FEB)
        self.assertGreater(_by_code(ded, "A-12")["deductionPct"], 100)
        # bank advice: a negative net can never be paid
        bank = _by_code(self.body("bank-advice", paymentStatus="all", **FEB), "A-12")
        self.assertIn("Zero/negative net", bank["check"])
        # the old production slip without a snapshot still shows its shifts from the stored column
        prod = [
            r
            for r in _body_rows(self.body("production-wage-sheet", dateFrom="2026-02-01", dateTo="2026-02-28"))
            if r["periodStart"] == "2026-02-16"
        ]
        self.assertEqual(len(prod), 1)
        self.assertEqual(prod[0]["totalShifts"], 3.0)
        self.assertEqual(prod[0]["grossWages"], 1200.0)

    def test_an_account_number_the_bank_cannot_take_is_flagged_and_never_silently_truncated(self):
        # 30-character account (typing mistake / two numbers pasted together) with a perfectly valid IFSC and a positive net
        bad = "1234567890123456789012345678AB"
        Employee.objects.filter(pk=self.e5.pk).update(bank_name="HDFC Bank", bank_account=bad, bank_ifsc="HDFC0001234")
        b = self.body("bank-advice", paymentStatus="all", **FEB)
        row = _by_code(b, "73")
        self.assertNotEqual(row["check"], "OK", "an unusable account number must be flagged")
        wb = self.xlsx("bank-advice", paymentStatus="all", **FEB)
        ws = wb["HDFC Bulk Upload"]
        uploaded = [ws.cell(row=r, column=3).value for r in range(3, ws.max_row + 1)]
        self.assertNotIn(bad[:25], uploaded, "the bank upload must never carry a silently cut-off account number")

    def test_excel_never_turns_a_name_into_a_formula_and_keeps_identifiers_as_text(self):
        self._hostile()
        wb = self.xlsx("bank-advice", paymentStatus="all", **FEB)
        ws = wb.worksheets[0]
        found = False
        for row in ws.iter_rows(min_row=8):
            if row[0].value == "A-12":
                found = True
                self.assertEqual(row[1].data_type, "s")
                self.assertTrue(str(row[1].value).startswith("=1+1"))
                self.assertEqual(row[4].data_type, "s")
        self.assertTrue(found)
        wb = self.xlsx("salary-master", employeeStatus="all")
        ws = wb.worksheets[0]
        for row in ws.iter_rows(min_row=8):
            if row[0].value == "A-12":
                pf = [c for c in row if c.value == "0123456789"]
                self.assertTrue(pf and pf[0].data_type == "s")

    def test_every_filter_option_and_toggle_survives_screen_and_both_exports(self):
        """Fuzz: each select option / boolean toggle of each report, alone and with the other toggles on, must not 500."""
        for rid in IDS:
            spec = registry.get_spec(rid)
            base = dict(PERIOD_PARAMS[rid])
            variants = [{}]
            for f in spec.filters:
                if f.kind == "select":
                    variants += [{f.key: v} for v, _l in f.options]
                elif f.kind == "boolean":
                    variants.append({f.key: "true"})
                elif f.kind == "employmentStatus" or f.kind == "employeeStatus":
                    variants += [{"employeeStatus": s} for s in ("active", "inactive", "all")]
                elif f.kind == "employmentType":
                    variants += [{"employmentType": s} for s in ("staff", "production")]
            everything_on = {f.key: "true" for f in spec.filters if f.kind == "boolean"}
            variants.append(everything_on)
            for extra in variants:
                params = {**base, **extra}
                for user in (self.admin, self.branch_user, self.prod_user):
                    if rid in ("employer-cost-ctc",) and user is self.prod_user:
                        continue  # not reachable for a production-payroll-only role (403)
                    if rid == "salary-master" and user is self.prod_user:
                        continue
                    r = self.run_report(rid, user, **params)
                    self.assertEqual(r.status_code, 200, (rid, params, user.username, r.content[:300]))
                    if user is not self.admin:
                        continue  # the exports render the same rows; one user is enough to exercise the builders
                    for fmt in ("xlsx", "pdf"):
                        e = self.export(rid, fmt, user, **params)
                        self.assertEqual(e.status_code, 200, (rid, params, fmt, user.username, e.content[:300]))


# ═════════════════════════════════════════════════════════════════════════════
#  follow-ups to the adversarial review: the edges of each fix
# ═════════════════════════════════════════════════════════════════════════════


class ReviewFollowUpTests(PayrollCoreBase):
    def test_provisional_looks_at_the_last_known_computation_day(self):
        past = date(2026, 9, 29)
        self.assertTrue(common.is_provisional(_slip(), past, date(2026, 2, 10)))  # computed mid-month, never redone
        self.assertTrue(common.is_provisional(_slip(), past, date(2026, 2, 28)))  # on the last day: not over yet
        self.assertFalse(common.is_provisional(_slip(), past, date(2026, 3, 3)))  # regenerated after month end
        self.assertFalse(common.is_provisional(_slip(), past, None))  # nothing to suggest it is stale

    def test_a_slip_regenerated_after_the_month_ended_is_not_provisional(self):
        # regeneration keeps SalarySlip.generated_at (auto_now_add) but upserts the Payroll row (auto_now updated_at)
        SalarySlip.objects.filter(employee=self.e5, month=2, year=2026).update(
            generated_at=datetime(2026, 2, 10, 6, 0, tzinfo=timezone.utc)
        )
        Payroll.objects.filter(employee=self.e5, month=2, year=2026).update(
            updated_at=datetime(2026, 3, 3, 6, 0, tzinfo=timezone.utc)
        )
        b = self.body("salary-slip", **FEB)
        self.assertIsNone(_by_code(b, "73")["flag"])
        self.assertFalse(any("PROVISIONAL" in n for n in b["notes"]))

    def test_statutory_numbers_and_their_missing_data_filters_need_payroll_salary_or_employees_access(self):
        Employee.objects.filter(pk=self.e1.pk).update(uan_number="100200300400")
        r = self.run_report("salary-master", self.inc_user, missingData="no_pf")
        self.assertEqual(r.status_code, 400)  # the filter would reveal which employees have a PF number
        b = self.body("salary-master", self.inc_user)
        self.assertTrue(_body_rows(b))
        self.assertNotIn("No PF number", {c["label"] for c in b["summary"]})
        self.assertTrue(any("hidden" in n for n in b["notes"]))
        wb = self.xlsx("salary-master", self.inc_user)
        values = {c.value for ws in wb.worksheets for row in ws.iter_rows() for c in row}
        self.assertFalse(values & {"PF/001", "ESI-77", "100200300400"})
        # a role that can open the payroll data keeps them, in the Excel file too
        wb = self.xlsx("salary-master", self.payroll_user)
        values = {c.value for ws in wb.worksheets for row in ws.iter_rows() for c in row}
        self.assertTrue({"PF/001", "ESI-77", "100200300400"} <= values)

    def test_a_production_only_role_asking_for_staff_gets_no_staff_money_from_any_payroll_report(self):
        for rid, extra in (
            ("salary-wages-statement", {}),
            ("bank-advice", {"paymentStatus": "all"}),
            ("payroll-payment-status", {}),
            ("department-salary-cost", {}),
        ):
            with self.subTest(rid):
                b = self.body(rid, self.prod_user, employmentType="staff", **FEB, **extra)
                self.assertEqual(_body_rows(b), [])

    def test_bank_upload_sheet_skips_paid_and_unusable_rows_even_when_every_status_is_listed(self):
        # a punctuated account number is flagged (the bank's column takes letters and digits only) ...
        Employee.objects.filter(pk=self.e5.pk).update(
            bank_name="HDFC Bank", bank_account="AC-12345", bank_ifsc="HDFC0001234"
        )
        b = self.body("bank-advice", paymentStatus="all", **FEB)
        self.assertIn("Invalid account no.", _by_code(b, "73")["check"])
        # ... and the upload sheet carries neither it nor anything already paid
        ws = self.xlsx("bank-advice", paymentStatus="all", **FEB)["HDFC Bulk Upload"]
        amounts = [ws.cell(row=r, column=4).value for r in range(3, ws.max_row + 1)]
        paid = [
            float(SalarySlip.objects.get(employee=self.e1, month=2, year=2026).net_salary),  # Anita
            float(SalarySlip.objects.get(employee=self.p1, period_start=date(2026, 2, 2)).net_salary),  # Esha, week 1
        ]
        for value in paid:
            self.assertNotIn(value, amounts)
        self.assertIn(2617.5, amounts)  # Esha's unpaid week is still to be paid
        self.assertNotIn("AC-12345", [ws.cell(row=r, column=3).value for r in range(3, ws.max_row + 1)])
