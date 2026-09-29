"""
Report Center - group G2 (payroll: statutory statements, salary deductions, overtime, controls).

Every figure below is derived by hand from a small February-2026 payroll that is generated through the
REAL payroll engine (payroll_views._generate_staff_payroll / _generate_production_payroll) from manual
attendance rows, so the reports are checked against exactly what payroll stored.

February 2026 starts on a Sunday: 24 Mon-Sat working days, 28 calendar days. Salary 24,000 -> daily rate 1,000.

Run via: python manage.py test api.tests_reporting_payroll_statutory   (use the scratchpad run_tests.py wrapper)
"""

import io
from datetime import date, datetime, time, timezone
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Branch,
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    Department,
    Designation,
    Employee,
    EmployeePermission,
    HRUser,
    OvertimeRecord,
    Payroll,
    PayrollSettings,
    Role,
    SalarySlip,
)
from .payroll_views import _build_working_days, _generate_production_payroll, _generate_staff_payroll
from .permission_registry import all_module_keys
from .reporting import registry

MONTH, YEAR = 2, 2026
WORKING_DAYS = _build_working_days(MONTH, YEAR, False, set())  # 24 Mon-Sat days
P = {"period": "2026-02"}
PROD1 = (date(2026, 2, 2), date(2026, 2, 11))
PROD2 = (date(2026, 2, 16), date(2026, 2, 25))

G2_IDS = (
    "pf-statement", "esi-statement", "statutory-coverage", "late-salary-impact", "attendance-salary-loss",
    "overtime-register", "overtime-payment-summary", "compensation-credits", "compensation-day-announcements",
    "payroll-exceptions", "min-wage-compliance", "payroll-slip-reconciliation",
)


def _headers(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _staff(code, salary, dept, branch, **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name=f"E{code}", last_name="Staff", employment_type="staff", status="active",
        salary_type="monthly", salary_amount=Decimal(salary) if salary is not None else None,
        department=dept, branch=branch, **kw,
    )


def _day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status=status, shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"), source="manual", **kw,
    )


def _present_all(emp, **kw):
    for d in WORKING_DAYS:
        _day(emp, d, **kw)


def _ot(emp, day, minutes, status="announced", ctype="pay", announced_at=None, by="HR One"):
    return OvertimeRecord.objects.create(
        employee=emp, date=day, shift_end_time=time(17, 30), last_punch_out=time(19, 30), ot_minutes=minutes,
        status=status, compensation_type=ctype if status == "announced" else None,
        announced_by=by if status == "announced" else None,
        announced_at=announced_at if status == "announced" else None,
    )


class _Base(TestCase):
    """The shared payroll: A (OT + relaxation credits), B (loss + lates), C (advance, branch 2), D (above the
    ESI/PF ceilings, permissions), L (left after payroll), P1 (production, two periods), E (no slip)."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.staff_payroll_rules_enabled = True
        ps.pf_rate, ps.esi_rate, ps.esi_applicable_below = Decimal("12"), Decimal("0.75"), Decimal("21000")
        ps.prod_payroll_rules_enabled = True
        ps.prod_pf_rate, ps.prod_esi_rate, ps.prod_esi_applicable_below = Decimal("12"), Decimal("0.75"), Decimal("21000")
        ps.prod_pf_ef_enabled = False
        ps.prod_late_detection_enabled = False
        ps.late_free_allowance = 3
        ps.late_deduction_slabs = [{"fromLates": 1, "deductionShifts": 0.5}, {"fromLates": 4, "deductionShifts": 1}]
        ps.permission_monthly_cap = 3
        ps.attendance_mode = "simple"
        ps.compensation_feature_enabled = True
        ps.ot_detection_enabled = True
        ps.min_wage_rate = Decimal("0")
        ps.save()

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.d_cut = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.d_adm = Department.objects.create(name="ADMIN", branch=cls.b1)
        cls.d_sew = Department.objects.create(name="SEWING", branch=cls.b2)
        cls.d_stitch = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.desig = Designation.objects.create(title="Operator")
        bank = dict(bank_name="SBI", bank_account="123456789012", bank_ifsc="SBIN0001234")

        cls.A = _staff("3001", "20400", cls.d_cut, cls.b1, designation=cls.desig, uan_number="100000000001",
                       pf_number="TN/A/1", esi_number="1111111111", **bank)
        cls.B = _staff("3002", "24000", cls.d_cut, cls.b1, uan_number="100000000002", pf_number="TN/B/2", **bank)
        cls.C = _staff("3003", "15000", cls.d_sew, cls.b2)  # no bank, no statutory numbers
        cls.D = _staff("3004", "60000", cls.d_adm, cls.b1, uan_number="100000000004", pf_number="TN/D/4", **bank)
        cls.L = _staff("3006", "18000", cls.d_cut, cls.b1, uan_number="100000000006", pf_number="TN/L/6",
                       esi_number="2222222222", **bank)
        cls.E = _staff("3007", "12000", cls.d_sew, cls.b2, **bank)  # never gets a slip
        cls.F = _staff("3008", None, cls.d_cut, cls.b1)  # no salary configured
        cls.P1 = Employee.objects.create(
            employee_code="P001", first_name="Prod", last_name="One", employment_type="production", status="active",
            salary_per_shift=Decimal("500"), department=cls.d_stitch, branch=cls.b1, uan_number="100000000009",
            pf_number="TN/P/9", **bank,
        )

        # A: full month, plus OT (2 pay days paid in the slip, 2 relaxation credits, one detected, one rejected)
        _present_all(cls.A)
        at = datetime(2026, 2, 27, 20, 30, tzinfo=timezone.utc)  # 28-Feb 02:00 IST
        _ot(cls.A, date(2026, 2, 2), 120, announced_at=at)
        _ot(cls.A, date(2026, 2, 3), 90, announced_at=at)
        r1 = _ot(cls.A, date(2026, 2, 4), 100, ctype="relaxation", announced_at=at)
        _ot(cls.A, date(2026, 2, 5), 75, status="detected")
        _ot(cls.A, date(2026, 2, 6), 80, status="rejected")
        r2 = _ot(cls.A, date(2026, 2, 7), 95, ctype="relaxation", announced_at=at)
        cls.credit_avail = CompensationLeaveCredit.objects.create(employee=cls.A, source_overtime_record=r1)
        cls.credit_used = CompensationLeaveCredit.objects.create(
            employee=cls.A, source_overtime_record=r2, status="used", used_date=date(2026, 2, 20)
        )
        _generate_staff_payroll(cls.A, MONTH, YEAR)

        # B: 18 full (5 of them late), 2 half, 2 absent, 2 unpaid leave
        for i, d in enumerate(WORKING_DAYS):
            if i < 18:
                _day(cls.B, d, is_late=i < 5)
            elif i < 20:
                _day(cls.B, d, "half_shift", "0.50")
            elif i < 22:
                _day(cls.B, d, "absent", "0")
            else:
                _day(cls.B, d, "on_leave", "0")
        _generate_staff_payroll(cls.B, MONTH, YEAR)
        _ot(cls.B, date(2026, 2, 10), 60, announced_at=at)  # announced AFTER the slip: pending

        # C: full month + one advance instalment, and a relaxation credit
        _present_all(cls.C)
        adv = Advance.objects.create(
            employee=cls.C, advance_type="general", amount=Decimal("1000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("1000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=MONTH, year=YEAR, amount=Decimal("1000"))
        _generate_staff_payroll(cls.C, MONTH, YEAR)
        r3 = _ot(cls.C, date(2026, 2, 11), 70, ctype="relaxation", announced_at=at)
        cls.credit_c = CompensationLeaveCredit.objects.create(employee=cls.C, source_overtime_record=r3)

        # D: 2 lates + 1 early-out + 5 approved permissions (3 in cap, 2 excess)
        for i, d in enumerate(WORKING_DAYS):
            _day(cls.D, d, is_late=i < 2, early_leave=(i == 2))
        for day in range(2, 7):
            EmployeePermission.objects.create(employee=cls.D, date=date(2026, 2, day), status="approved")
        _generate_staff_payroll(cls.D, MONTH, YEAR)

        # L: full month, then leaves the company
        _present_all(cls.L)
        _generate_staff_payroll(cls.L, MONTH, YEAR)
        Employee.objects.filter(pk=cls.L.pk).update(status="inactive")

        # E: no slip, but an announced pay OT day
        _ot(cls.E, date(2026, 2, 12), 130, announced_at=at)

        # P1: two production periods in the month
        for i in range(10):
            _day(cls.P1, date(2026, 2, 2 + i), shifts="1.50" if i < 5 else "1.00")
        _generate_production_payroll(cls.P1, *PROD1)
        for d in range(16, 20):
            _day(cls.P1, date(2026, 2, d))
        _generate_production_payroll(cls.P1, *PROD2)

        # HR users
        cls.admin = HRUser.objects.create(username="g2_admin", password_hash="x", is_super_admin=True)
        cls.all_modules = ("payroll", "production_payroll", "salary_slip", "compensation")

        def mk(name, perms, branch=None):
            role = Role.objects.create(name=name, permissions=perms)
            return HRUser.objects.create(username=name, password_hash="x", role=role, branch=branch)

        cls.u_branch1 = mk("g2_b1", {"reports": "view", "payroll": "view", "production_payroll": "view",
                                     "compensation": "view"}, cls.b1)
        cls.u_reports_only = mk("g2_plain", {"reports": "view"})
        cls.u_prod_only = mk("g2_prod", {"reports": "view", "production_payroll": "view"})
        cls.u_staff_only = mk("g2_staff", {"reports": "view", "payroll": "view"})
        cls.u_comp_only = mk("g2_comp", {"reports": "view", "compensation": "view"})

    # -- helpers -------------------------------------------------------------------------------------
    def run_report(self, report_id, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{report_id}", params, **_headers(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, report_id, fmt, user=None, **params):
        return self.client.get(f"/api/reports/export/{report_id}", {"fmt": fmt, **params}, **_headers(user or self.admin))

    @staticmethod
    def col(body, key):
        return [r.get(key) for r in body["rows"] if r.get("_kind") is None]

    @staticmethod
    def data_rows(body):
        return [r for r in body["rows"] if r.get("_kind") is None]

    def by_code(self, body):
        return {r["employeeCode"]: r for r in self.data_rows(body)}

    def summary(self, body):
        return {s["label"]: s["value"] for s in body["summary"]}


# -- smoke: PF -----------------------------------------------------------------------------------------
class PfStatementTests(_Base):
    def test_golden_rows(self):
        body = self.run_report("pf-statement", **P)
        rows = self.by_code(body)
        self.assertEqual(list(rows), ["3001", "3002", "3003", "3004", "3006", "P001"])
        a = rows["3001"]
        self.assertEqual((a["pfWages"], a["eeShare"], a["epsShare"], a["erEpfShare"], a["erTotal"]), (10200.0, 1224.0, 850.0, 374.0, 1224.0))
        print(body["totals"], body["summary"])


class _Dump(_Base):
    def test_dump(self):
        import json
        for rid, params in (
            ("esi-statement", P), ("statutory-coverage", {}), ("late-salary-impact", P), ("attendance-salary-loss", P),
            ("overtime-register", {"dateFrom": "2026-02-01", "dateTo": "2026-02-28"}), ("overtime-payment-summary", P),
            ("compensation-credits", {}), ("compensation-day-announcements", {}), ("payroll-exceptions", P),
            ("min-wage-compliance", P), ("payroll-slip-reconciliation", P),
        ):
            body = self.run_report(rid, **params)
            print("=====", rid, json.dumps({k: body[k] for k in ("rowCount", "totals", "summary", "notes")}, indent=None))
            for r in body["rows"]:
                print("   ", json.dumps(r))
