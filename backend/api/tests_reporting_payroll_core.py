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
    "salary-slip", "salary-register", "salary-wages-statement", "bank-advice", "salary-deduction-summary",
    "department-salary-cost", "production-wage-sheet", "payroll-month-comparison", "annual-earnings-statement",
    "payroll-payment-status", "salary-master", "employer-cost-ctc",
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
        employee=emp, date=d, status=status, shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"), source="manual", **kw,
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
            staff_payroll_rules_enabled=True, pf_rate=Decimal("12"), esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"), late_free_allowance=1,
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}, {"fromLates": 4, "deductionShifts": 1}],
            permission_monthly_cap=3, attendance_mode="simple", compensation_feature_enabled=True,
            prod_payroll_rules_enabled=True, prod_pf_rate=Decimal("12"), prod_esi_rate=Decimal("0.75"),
            prod_esi_applicable_below=Decimal("21000"), prod_pf_ef_enabled=False, prod_pf_ef_rules=[],
            prod_late_detection_enabled=False, bonus_fy_start_month=4,
        )

        def staff(code, first, salary, dept, branch, desig=None, **kw):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="Test", employment_type="staff", department=dept,
                designation=desig, branch=branch, salary_type="monthly", salary_amount=Decimal(salary), **kw,
            )

        def prod(code, first, rate, dept, branch, desig=None, **kw):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="Prod", employment_type="production", department=dept,
                designation=desig, branch=branch, salary_per_shift=Decimal(rate), **kw,
            )

        cls.e1 = staff("1001", "Anita", "24000.00", cls.cutting, cls.b1, cls.supervisor, join_date="2024-04-15",
                       bank_name="HDFC Bank", bank_account="50100012345678", bank_ifsc="HDFC0001234", pf_number="PF/001")
        cls.e2 = staff("1002", "Bala", "20400.00", cls.sewing, cls.b1, cls.operator, join_date="15/06/2023",
                       esi_number="ESI-77")
        cls.e3 = staff("1003", "Chitra", "30000.00", cls.finish, cls.b2, cls.operator, join_date="2022-01-10",
                       bank_name="State Bank", bank_account="3000 1122 3344", bank_ifsc="sbin 0001234")
        cls.e4 = staff("1004", "Deepak", "12000.00", None, cls.b1, None, join_date="sometime", status="inactive",
                       bank_name="HDFC Bank", bank_account="50100012345678", bank_ifsc="HDFC0001234")
        cls.e5 = staff("73", "Zed", "15000.00", cls.sewing, cls.b1, cls.operator, join_date="2025-08-01")
        cls.p1 = prod("2001", "Esha", "500.00", cls.cutting, cls.b1, cls.operator, bank_name="ICICI Bank",
                      bank_account="6000111122223333", bank_ifsc="ICIC0000456")
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
            employee=cls.e1, date=date(2026, 2, 2), last_punch_out=time(20, 0), ot_minutes=120,
            status=OvertimeRecord.STATUS_ANNOUNCED, compensation_type=OvertimeRecord.TYPE_PAY,
        )
        adv = Advance.objects.create(
            employee=cls.e1, advance_type="term", amount=Decimal("5000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("5000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=2, year=2026, amount=Decimal("2000"))
        AdvanceRepayment.objects.create(advance=adv, month=3, year=2026, amount=Decimal("3000"))
        adv_p = Advance.objects.create(
            employee=cls.p1, advance_type="general", amount=Decimal("1000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("1000"),
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
            employee=cls.p1, month=2, year=2026, week_number=2, slip_number="SS/2001/2026/02/W2",
            basic=Decimal("1000"), gross_salary=Decimal("1000"), net_salary=Decimal("1000"),
            total_deductions=Decimal("0"), present_days=Decimal("2.0"),
        )
        Payroll.objects.create(
            employee=cls.p1, salary_mode="shift", month=2, year=2026, week_number=2, base_salary=Decimal("1000"),
            gross_salary=Decimal("1000"), final_salary=Decimal("1000"),
        )

        # ── HR users ──
        cls.admin = HRUser.objects.create(username="pc_admin", password_hash="x", is_super_admin=True)

        def hr(name, perms, branch=None):
            role = Role.objects.create(name=f"pc_{name}", permissions=perms)
            return HRUser.objects.create(username=f"pc_{name}", password_hash="x", role=role, branch=branch)

        cls.hr = hr
        cls.plain = hr("plain", {"reports": "view"})
        cls.payroll_user = hr("payroll", {"reports": "view", "payroll": "view"})
        cls.branch_user = hr("b1", {"reports": "view", "payroll": "view", "salary_slip": "view", "compensation": "view",
                                    "increment": "view", "production_payroll": "view"}, branch=cls.b1)
        cls.slip_user = hr("slip", {"reports": "view", "salary_slip": "view"})
        cls.prod_user = hr("prod", {"reports": "view", "production_payroll": "view"})
        cls.comp_user = hr("comp", {"reports": "view", "compensation": "view"})
        cls.inc_user = hr("inc", {"reports": "view", "increment": "view"})

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

