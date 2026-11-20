"""
Report Center - the Salary category (category id "payroll") of the 2026-11-19 layout:

    salary-statement, production-salary-report, staff-salary-report, gained-salary-report, expected-salary-report,
    department-salary-report, department-headcount-report, department-employee-report
    (api/reporting/definitions/rc_salary*.py)

April 2026 (30 days, Sundays 5/12/19/26 -> 26 company days; 14 April a declared holiday -> 25 working days). Payrolls are
made by the REAL engines (_generate_staff_payroll / _generate_production_payroll) from manual attendance day records, with
the attendance engine's "today" frozen after the month; the reports' own "today" is patched per test.

Staff (HO Accounts unless said): S101 Meena 27,000, Co Emp (PF 12% / ESI 0.75%), a quarter day (0.75), a half day and an
absent day; S102 Ravi 20,000, salary ON HOLD; S104 Neha 13,000 joined 10 April (a parked new joiner); S105 Gone 10,000
(paid, then left on 20 April); S201 Kumar 15,000 in U1 Cutting, recorded split, Marked as Paid; S202 Nopay (U1, no payroll).
Production: P101 Raja, BiWeekly (periods 23 Mar-5 Apr and 6-19 Apr, both ENDING in April), rate 500, a night shift, a 1.5
shift day, a quarter day and a 0.90 day stored before the quarter rules; P201 Selvi, Weekly (6-12 Apr) in U1 Cutting,
rate 400, join date stored as an Excel serial number.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_rc2_salary py -3 manage.py test api.tests_reporting_rc_salary
"""

import io
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import ROUND_HALF_UP, Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    Designation,
    Employee,
    Holiday,
    HRUser,
    Payroll,
    PayrollSettings,
    ResignationRequest,
    Role,
)
from .payroll_views import _generate_production_payroll, _generate_staff_payroll
from .permission_registry import all_module_keys
from .reporting import layout, registry
from .reporting.definitions import rc_salary_common as C
from .reporting.definitions.rc_salary import split_of
from .salary_split import default_split

IDS = (
    "salary-statement",
    "production-salary-report",
    "staff-salary-report",
    "gained-salary-report",
    "expected-salary-report",
    "department-salary-report",
    "department-headcount-report",
    "department-employee-report",
)
MONTH, YEAR = 4, 2026
APRIL = {"period": "2026-04"}
HOLIDAY = date(2026, 4, 14)
P_MARCH = (date(2026, 3, 23), date(2026, 4, 5))
P_APRIL = (date(2026, 4, 6), date(2026, 4, 19))
W_APRIL = (date(2026, 4, 6), date(2026, 4, 12))

_FROZEN = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN.start()


def tearDownModule():
    _FROZEN.stop()


def report_today(d: date):
    """The Report Center's own "today" (ReportContext.today and the filter defaults)."""
    return patch("api.reporting.filters.ist_today", return_value=d)


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def data_rows(body) -> list[dict]:
    return [r for r in body["rows"] if not r.get("_kind")]


def subtotal_rows(body) -> list[dict]:
    return [r for r in body["rows"] if r.get("_kind") == "subtotal"]


def money(value) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def day(emp, d, status="present", shifts="1.00", **kw):
    AttendanceDayRecord.objects.update_or_create(
        employee=emp,
        date=d,
        defaults={
            "status": status,
            "shifts_earned": Decimal(shifts),
            "is_half_shift": status == "half_shift",
            "source": "manual",
            **kw,
        },
    )


def april_working_days():
    return [d for d in days(date(2026, 4, 1), date(2026, 4, 30)) if d.weekday() != 6 and d != HOLIDAY]


def _rule(rule_id, rate):
    return {
        "id": rule_id,
        "label": rule_id,
        "basis": "first_portion",
        "minAmount": 0,
        "maxAmount": 100000,
        "ratePercent": rate,
    }


class _World(TestCase):
    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        for key, value in {
            "attendance_mode": "simple",
            "prod_attendance_mode": "simple",
            "late_deduction_slabs": [],
            "prod_late_detection_enabled": False,
            "compensation_feature_enabled": False,
            "staff_pf_rules": [_rule("pf", 12)],
            "staff_esi_rules": [_rule("esi", 0.75)],
            "prod_cycles": {
                "weekly": {"weekStart": "monday"},
                "biweekly": {"weekStart": "monday", "anchorDate": "2026-04-06"},
                "monthly": {"weekStart": "monday", "anchorDate": "2026-04-06"},
            },
        }.items():
            setattr(ps, key, value)
        ps.save()
        Holiday.objects.create(name="Tamil New Year", date=HOLIDAY, holiday_type="company")

        cls.ho, _ = Branch.objects.update_or_create(code="HO", defaults={"name": "Head Office", "is_head_office": True})
        cls.u1 = Branch.objects.create(name="Unit 1", code="Unit1")
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.ho)
        cls.weaving = Department.objects.create(name="Weaving", branch=cls.ho)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        cls.clerk = Designation.objects.create(title="Clerk")

        def staff(code, first, salary, dept=None, branch=None, gender="male", **kw):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="S", employment_type="staff", status="active",
                salary_type="monthly", salary_amount=Decimal(salary), department=dept or cls.accounts,
                branch=branch or cls.ho, designation=cls.clerk, gender=gender, **kw,
            )  # fmt: skip

        def worker(code, first, rate, cycle, dept, branch, gender="male", **kw):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="P", employment_type="production", status="active",
                salary_per_shift=Decimal(rate), production_pay_cycle=cycle, department=dept, branch=branch,
                gender=gender, **kw,
            )  # fmt: skip

        work = april_working_days()
        cls.meena = staff("S101", "Meena", "27000", gender="female", co_emp_enabled=True)
        day(cls.meena, date(2026, 4, 1), "present", "0.75")  # a quarter day
        day(cls.meena, date(2026, 4, 2), "half_shift", "0.50")
        day(cls.meena, date(2026, 4, 3), "absent", "0")
        for d in work[3:]:
            day(cls.meena, d)
        cls.ravi = staff("S102", "Ravi", "20000")
        cls.neha = staff("S104", "Neha", "13000", gender="female", join_date="2026-04-10")
        cls.gone = staff("S105", "Gone", "10000")
        cls.kumar = staff(
            "S201", "Kumar", "15000", cls.cutting, cls.u1,
            salary_basic=Decimal("4000"), salary_da=Decimal("2000"), salary_retaining_allowance=Decimal("1500"),
            salary_other_allowance=Decimal("3000"), salary_petrol_allowance=Decimal("1500"), salary_hra=Decimal("1500"),
            salary_special_allowance=Decimal("1000"), salary_ca=Decimal("500"),
        )  # fmt: skip
        cls.nopay = staff("S202", "Nopay", "12000", cls.cutting, cls.u1)
        for emp in (cls.ravi, cls.gone, cls.kumar):
            for d in work:
                day(emp, d)
        for d in work:
            if d >= date(2026, 4, 10):
                day(cls.neha, d)
        cls.staff_payrolls = {
            e.employee_code: _generate_staff_payroll(e, MONTH, YEAR)["payroll"]
            for e in (cls.meena, cls.ravi, cls.neha, cls.gone, cls.kumar)
        }
        Payroll.objects.filter(pk=cls.staff_payrolls["S102"].pk).update(on_hold=True)
        Payroll.objects.filter(pk=cls.staff_payrolls["S201"].pk).update(
            status=Payroll.STATUS_PAID, payment_status=Payroll.PAYMENT_PAID
        )
        Payroll.objects.filter(pk=cls.staff_payrolls["S101"].pk).update(status=Payroll.STATUS_PAID)  # Cleared only
        Employee.objects.filter(pk=cls.gone.pk).update(status="inactive")
        ResignationRequest.objects.create(
            employee=cls.gone, status="approved", last_working_date=date(2026, 4, 20),
            approved_at=datetime(2026, 4, 18, 6, 0, tzinfo=dt_timezone.utc),
        )  # fmt: skip

        cls.raja = worker("P101", "Raja", "500", "biweekly", cls.weaving, cls.ho)
        for d in days(*P_MARCH):
            day(cls.raja, d, "absent", "0") if d.weekday() == 6 else day(cls.raja, d)
        plan = {
            date(2026, 4, 6): ("present", "1.00", {"first_punch": time(21, 0), "last_punch": time(5, 30)}),  # night
            date(2026, 4, 7): ("present", "1.50", {}),  # more than one shift
            date(2026, 4, 8): ("present", "0.75", {}),  # a quarter day
            date(2026, 4, 10): ("present", "0.90", {}),  # stored before the quarter rules (off the 0.25 grid)
            date(2026, 4, 12): ("absent", "0", {}),
            HOLIDAY: ("absent", "0", {}),
            date(2026, 4, 19): ("absent", "0", {}),
        }
        for d in days(*P_APRIL):
            status, shifts, extra = plan.get(d, ("present", "1.00", {}))
            day(cls.raja, d, status, shifts, **extra)
        serial = (date(2026, 4, 8) - date(1899, 12, 30)).days
        cls.selvi = worker(
            "P201", "Selvi", "400", "weekly", cls.cutting, cls.u1, gender="female", join_date=f"01-01-{serial}"
        )
        for d in days(*W_APRIL):
            day(cls.selvi, d, "absent", "0") if d.weekday() == 6 else day(cls.selvi, d)
        cls.prod_payrolls = {
            "march": _generate_production_payroll(cls.raja, *P_MARCH, pay_cycle="biweekly")["payroll"],
            "april": _generate_production_payroll(cls.raja, *P_APRIL, pay_cycle="biweekly")["payroll"],
            "selvi": _generate_production_payroll(cls.selvi, *W_APRIL, pay_cycle="weekly")["payroll"],
        }

        cls.admin = HRUser.objects.create(username="rcs_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.payroll_user = user("rcs_payroll", {"payroll": "view"})
        cls.production_user = user("rcs_production", {"production_payroll": "view"})
        cls.salary_user = user("rcs_salary", {"salary": "view"})
        cls.plain_user = user("rcs_plain", {})
        cls.branch_user = user(
            "rcs_branch", {"payroll": "view", "production_payroll": "view", "salary": "view"}, branch=cls.u1
        )

    # ── helpers ────────────────────────────────────────────────────────────
    def get(self, rid, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r.json()

    def export(self, rid, fmt, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {**params, "fmt": fmt}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r

    def payroll(self, key) -> Payroll:
        p = self.staff_payrolls.get(key) or self.prod_payrolls[key]
        return Payroll.objects.get(pk=p.pk)


# ═════════════════════════════════════════════════════════════════════════════
#  Registration, catalog, access
# ═════════════════════════════════════════════════════════════════════════════


class CatalogTests(_World):
    def test_the_eight_reports_are_registered_in_the_salary_category_in_layout_order(self):
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual(layout.LAYOUT["payroll"], IDS)
        modules = set(all_module_keys())
        for rid in IDS:
            spec = registry.get_spec(rid)
            self.assertIsNotNone(spec, rid)
            self.assertEqual(spec.category, "payroll", rid)
            self.assertTrue(layout.is_listed(spec), rid)
            self.assertTrue(spec.modules and set(spec.modules) <= modules, rid)
            self.assertLessEqual(len(spec.filters), 8, rid)
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        listed = [r["id"] for r in body["reports"] if r["category"] == "payroll"]
        self.assertEqual(listed, list(IDS))

    def test_every_report_runs_on_its_defaults(self):
        for rid in IDS:
            with self.subTest(rid):
                self.get(rid)

    def test_owning_modules_gate_the_reports(self):
        for rid in IDS:
            self.get(rid, self.plain_user, expect=403, **APRIL)
        self.get("production-salary-report", self.payroll_user, expect=403)
        self.get("staff-salary-report", self.production_user, expect=403)
        self.get("staff-salary-report", self.payroll_user, **APRIL)
        self.get("gained-salary-report", self.salary_user, **APRIL)

    def test_a_role_sees_only_the_kind_of_payroll_it_may_open(self):
        staff_only = self.get("salary-statement", self.payroll_user, **APRIL)
        self.assertEqual({r["type"] for r in data_rows(staff_only)}, {"Staff"})
        self.assertTrue(any("staff figures only" in n for n in staff_only["notes"]))
        prod_only = self.get("salary-statement", self.production_user, **APRIL)
        self.assertEqual({r["type"] for r in data_rows(prod_only)}, {"Production"})
        # asking for the other kind lists nobody instead of switching
        self.assertEqual(
            data_rows(self.get("salary-statement", self.production_user, employmentType="staff", **APRIL)), []
        )
        # salary amounts follow the role too: Payroll alone does not open production rates
        body = self.get("department-employee-report", self.payroll_user)
        selvi = next(r for r in data_rows(body) if r["employeeCode"] == "P201")
        self.assertIsNone(selvi["ratePerShift"])
        self.assertTrue(any("production salaries" in n for n in body["notes"]))

    def test_branch_isolation(self):
        for rid, params in (
            ("salary-statement", APRIL),
            ("department-salary-report", APRIL),
            ("gained-salary-report", APRIL),
            ("department-employee-report", {}),
        ):
            body = self.get(rid, self.branch_user, **params)
            codes = {r.get("employeeCode") for r in data_rows(body)} - {None}
            depts = {r["department"] for r in data_rows(body)}
            self.assertTrue(depts <= {"Cutting"}, (rid, depts))
            self.assertTrue(codes <= {"S201", "S202", "P201"}, (rid, codes))
        self.assertEqual(
            {r["employeeCode"] for r in data_rows(self.get("salary-statement", self.branch_user, **APRIL))},
            {"S201", "P201"},
        )


# ═════════════════════════════════════════════════════════════════════════════
#  salary-statement
# ═════════════════════════════════════════════════════════════════════════════


class SalaryStatementTests(_World):
    RID = "salary-statement"

    def test_one_line_per_payroll_of_the_month_with_department_sub_totals(self):
        body = self.get(self.RID, **APRIL)
        rows = data_rows(body)
        self.assertEqual(
            [(r["department"], r["employeeCode"], r["payPeriod"]) for r in rows],
            [
                ("Accounts", "S101", "April 2026"),
                ("Accounts", "S102", "April 2026"),
                ("Cutting", "S201", "April 2026"),
                ("Cutting", "P201", "Weekly 6 Apr – 12 Apr 2026"),
                ("Weaving", "P101", "BiWeekly 23 Mar – 5 Apr 2026"),
                ("Weaving", "P101", "BiWeekly 6 Apr – 19 Apr 2026"),
            ],
        )
        self.assertEqual(
            [r["employeeName"] for r in subtotal_rows(body)], ["Accounts total", "Cutting total", "Weaving total"]
        )
        weaving = subtotal_rows(body)[2]
        self.assertEqual(weaving["net"], money(self.payroll("march").final_salary + self.payroll("april").final_salary))

    def test_money_is_the_payroll_rows(self):
        body = self.get(self.RID, **APRIL)
        listed = {"S101": "S101", "S102": "S102", "S201": "S201", "P201": "selvi"}
        rows = {r["employeeCode"]: r for r in data_rows(body) if r["employeeCode"] != "P101"}
        for code, key in listed.items():
            p = self.payroll(key)
            r = rows[code]
            self.assertEqual(r["net"], money(p.final_salary), code)
            self.assertEqual(r["gross"], money(p.gross_salary), code)
            self.assertEqual(r["totalDeduction"], money(p.deductions), code)
            self.assertEqual(r["earned"], money(p.gross_salary + p.ot_amount + p.bonus), code)
        everyone = [self.payroll(k) for k in ("S101", "S102", "S201", "selvi", "march", "april")]
        self.assertEqual(body["totals"]["net"], money(sum(p.final_salary for p in everyone)))
        # the staff figures equal Payroll > Salary Statement's (the same builder)
        page = self.client.get("/api/payroll/salary-statement?month=4&year=2026", **hdr(self.admin)).json()
        values = {row["values"]["code"]: row["values"] for g in page["groups"] for row in g["rows"]}
        for code in ("S101", "S102", "S201"):
            for key in ("pf", "esi", "tds", "advance", "others", "net"):
                self.assertEqual(rows[code][key], values[code][key], (code, key))

    def test_staff_days_lop_and_co_emp_deductions(self):
        meena = next(r for r in data_rows(self.get(self.RID, **APRIL)) if r["employeeCode"] == "S101")
        self.assertEqual((meena["daysPaid"], meena["lopDays"]), (24.25, 1.75))
        self.assertEqual(meena["gross"], money(Decimal("27000") * Decimal("24.25") / 26))
        self.assertEqual(meena["lopAmount"], money(27000 - meena["gross"]))
        self.assertGreater(meena["pf"], 0)
        self.assertGreater(meena["esi"], 0)
        self.assertEqual(meena["payment"], "Cleared")

    def test_production_lines_show_shifts_and_rate(self):
        rows = [r for r in data_rows(self.get(self.RID, **APRIL)) if r["employeeCode"] == "P101"]
        april = rows[1]
        self.assertEqual((april["shifts"], april["rate"], april["gross"]), (11.15, 500.0, 5575.0))
        self.assertEqual(
            (april["type"], april["daysPaid"], april["salary"], april["lopDays"]), ("Production", 14.0, None, None)
        )

    def test_workflow_lists_hold_new_joiner_inactive_and_payment(self):
        body = self.get(self.RID, **APRIL)
        ravi = next(r for r in data_rows(body) if r["employeeCode"] == "S102")
        self.assertIn("HOLD", ravi["remarks"])
        codes = [r["employeeCode"] for r in data_rows(body)]
        self.assertNotIn("S104", codes)  # parked new joiner
        self.assertNotIn("S105", codes)  # no longer active
        self.assertTrue(any("1 payroll(s) of employees who are no longer active" in n for n in body["notes"]))
        self.assertTrue(any("1 active staff member(s)" in n for n in body["notes"]))  # Nopay
        main = [r["employeeCode"] for r in data_rows(self.get(self.RID, payrollList="main", **APRIL))]
        self.assertNotIn("S102", main)
        skipped = data_rows(self.get(self.RID, payrollList="skipped", **APRIL))
        self.assertEqual(
            {r["employeeCode"]: r["remarks"].split(",")[0] for r in skipped}, {"S102": "HOLD", "S104": "NEW JOINER"}
        )
        payments = {r["employeeCode"]: r["payment"] for r in data_rows(body)}
        self.assertEqual(payments["S201"], "Paid")
        self.assertEqual(payments["S102"], "Pending")
        self.assertEqual(
            [r["employeeCode"] for r in data_rows(self.get(self.RID, paymentStatus="paid", **APRIL))], ["S201"]
        )
        self.assertEqual(
            [r["employeeCode"] for r in data_rows(self.get(self.RID, paymentStatus="cleared", **APRIL))], ["S101"]
        )
        self.assertEqual(len(data_rows(self.get(self.RID, paymentStatus="not_paid", **APRIL))), 5)
        self.assertEqual(
            {r["type"] for r in data_rows(self.get(self.RID, employmentType="production", **APRIL))}, {"Production"}
        )

    def test_files_carry_the_pf_esi_tds_details(self):
        xlsx = self.export(self.RID, "xlsx", **APRIL)
        book = load_workbook(io.BytesIO(xlsx.content), read_only=True)
        self.assertIn("PF ESI TDS", book.sheetnames)
        stat = [
            row for row in book["PF ESI TDS"].iter_rows(values_only=True) if row and "S101" in [str(c) for c in row]
        ]
        self.assertEqual(len(stat), 1)
        self.assertTrue(self.export(self.RID, "pdf", **APRIL).content.startswith(b"%PDF"))


# ═════════════════════════════════════════════════════════════════════════════
#  production-salary-report, staff-salary-report, department-salary-report
# ═════════════════════════════════════════════════════════════════════════════


class ProductionSalaryTests(_World):
    RID = "production-salary-report"

    def test_any_day_of_the_period_lists_that_period(self):
        body = self.get(self.RID, cycle="biweekly", dateFrom="2026-04-10", dateTo="2026-04-10")
        rows = data_rows(body)
        self.assertEqual([r["employeeCode"] for r in rows], ["P101"])
        p = self.payroll("april")
        self.assertEqual((rows[0]["shifts"], rows[0]["gross"], rows[0]["net"]), (11.15, 5575.0, money(p.final_salary)))
        self.assertIn({"label": "Pay period", "value": "06-Apr-2026 to 19-Apr-2026"}, body["filters"])
        state = next(s for s in body["summary"] if s["label"] == "Period status")
        self.assertEqual(state["value"], "Generated")

    def test_no_dates_lists_the_latest_generated_period(self):
        body = self.get(self.RID, cycle="biweekly")
        self.assertIn({"label": "Pay period", "value": "06-Apr-2026 to 19-Apr-2026"}, body["filters"])
        weekly = self.get(self.RID, cycle="weekly")
        self.assertEqual([r["employeeCode"] for r in data_rows(weekly)], ["P201"])

    def test_dates_touching_two_periods_are_refused_and_an_empty_period_is_named(self):
        r = self.client.get(
            f"/api/reports/run/{self.RID}", {"cycle": "biweekly", "dateFrom": "2026-04-01", "dateTo": "2026-04-10"},
            **hdr(self.admin),
        )  # fmt: skip
        self.assertEqual(r.status_code, 400)
        empty = self.get(self.RID, cycle="biweekly", dateFrom="2026-05-10", dateTo="2026-05-10")
        self.assertEqual(data_rows(empty), [])
        self.assertIn({"label": "Pay period", "value": "04-May-2026 to 17-May-2026"}, empty["filters"])


class StaffSalaryTests(_World):
    RID = "staff-salary-report"

    def test_split_components_days_and_money(self):
        rows = {r["employeeCode"]: r for r in data_rows(self.get(self.RID, **APRIL))}
        self.assertEqual(list(rows), ["S101", "S102", "S201"])
        kumar = rows["S201"]
        self.assertEqual(
            [kumar[k] for k in ("basic", "da", "retaining", "otherAllowance", "petrol", "hra", "special", "ca")],
            [4000.0, 2000.0, 1500.0, 3000.0, 1500.0, 1500.0, 1000.0, 500.0],
        )
        self.assertEqual(
            (kumar["salary"], kumar["companyDays"], kumar["daysPaid"], kumar["lopDays"]), (15000.0, 26, 26.0, 0.0)
        )
        self.assertIsNone(kumar["remarks"])
        meena = rows["S101"]
        auto = default_split(Decimal("27000"))
        self.assertEqual(meena["basic"], float(auto["basic"]))
        self.assertIn("AUTO SPLIT", meena["remarks"])
        p = self.payroll("S101")
        self.assertEqual(
            (meena["earned"], meena["net"]), (money(p.gross_salary + p.ot_amount + p.bonus), money(p.final_salary))
        )

    def test_split_follows_the_payroll_salary_after_an_increment(self):
        parts, recorded = split_of(self.kumar, Decimal("16000"))
        self.assertTrue(recorded)
        self.assertEqual(sum(parts.values()), Decimal("16000"))
        self.assertEqual(parts["basic"] + parts["da"] + parts["retaining_allowance"], Decimal("8000"))


class DepartmentSalaryTests(_World):
    RID = "department-salary-report"

    def test_department_and_type_lines_with_employer_contributions(self):
        body = self.get(self.RID, **APRIL)
        rows = {(r["department"], r["type"]): r for r in data_rows(body)}
        self.assertEqual(
            list(rows),
            [("Accounts", "Staff"), ("Cutting", "Staff"), ("Cutting", "Production"), ("Weaving", "Production")],
        )
        self.assertEqual([r["department"] for r in subtotal_rows(body)], ["Cutting total"])  # only where both kinds
        accounts = rows[("Accounts", "Staff")]
        meena, ravi = self.payroll("S101"), self.payroll("S102")
        self.assertEqual(accounts["headcount"], 2)
        self.assertEqual(accounts["net"], money(meena.final_salary + ravi.final_salary))
        self.assertGreater(accounts["employerPf"], 0)
        self.assertEqual(
            accounts["employerCost"], round(accounts["earned"] + accounts["employerPf"] + accounts["employerEsi"], 2)
        )
        weaving = rows[("Weaving", "Production")]
        self.assertEqual(weaving["headcount"], 1)  # one worker paid for two periods counts once
        self.assertEqual(weaving["net"], money(self.payroll("march").final_salary + self.payroll("april").final_salary))
        statement = self.get("salary-statement", **APRIL)
        self.assertEqual(body["totals"]["net"], statement["totals"]["net"])


# ═════════════════════════════════════════════════════════════════════════════
#  gained / expected salary
# ═════════════════════════════════════════════════════════════════════════════


class GainedExpectedTests(_World):
    def rows(self, rid, today, **params):
        with report_today(today):
            return {r["employeeCode"]: r for r in data_rows(self.get(rid, **{**APRIL, **params}))}

    def test_staff_gained_so_far_at_the_payroll_daily_rate(self):
        meena = self.rows("gained-salary-report", date(2026, 4, 15))["S101"]
        # Apr 1-15: 12 working days; 0.75 + 0.5 + absent + 9 full = 10.25 shifts; the 14th a paid holiday
        self.assertEqual(
            (meena["daysSoFar"], meena["shifts"], meena["holidays"], meena["paid"]), (12, 10.25, 1.0, 11.25)
        )
        self.assertEqual(meena["rate"], 1038.46)  # payroll_views.staff_daily_rate: 27,000 / 26
        self.assertEqual(meena["gained"], money(Decimal("27000") * Decimal("11.25") / 26))
        self.assertEqual((meena["from"], meena["to"], meena["upTo"]), ("2026-04-01", "2026-04-30", "2026-04-15"))

    def test_past_month_gained_equals_the_payroll_gross(self):
        rows = self.rows("gained-salary-report", date(2026, 12, 31))
        for code in ("S101", "S102", "S201"):
            self.assertEqual(rows[code]["gained"], money(self.payroll(code).gross_salary), code)

    def test_production_month_and_pay_period_windows(self):
        month = self.rows("gained-salary-report", date(2026, 4, 15))["P101"]
        self.assertEqual((month["shifts"], month["gained"]), (12.15, 6075.0))  # 4 (Apr 1-4) + 8.15 (Apr 6-15)
        self.assertIn("1 DAY(S) OUT OF DATE", month["remarks"])  # the 0.90 day
        period = self.rows("gained-salary-report", date(2026, 4, 15), window="payPeriod")["P101"]
        self.assertEqual((period["from"], period["to"], period["cycle"]), ("2026-04-06", "2026-04-19", "BiWeekly"))
        self.assertEqual((period["shifts"], period["gained"]), (8.15, 4075.0))

    def test_expected_is_gained_plus_full_attendance_still_to_come(self):
        staff = self.rows("expected-salary-report", date(2026, 4, 15))["S101"]
        self.assertEqual((staff["paid"], staff["toCome"]), (11.25, 13.0))
        self.assertEqual(staff["expected"], money(self.payroll("S101").gross_salary))  # every later day was worked
        self.assertEqual(staff["difference"], round(staff["expected"] - 27000, 2))
        prod = self.rows("expected-salary-report", date(2026, 4, 15), window="payPeriod")["P101"]
        self.assertEqual((prod["toCome"], prod["toComeAmount"], prod["expected"]), (3.0, 1500.0, 5575.0))
        self.assertEqual(prod["expected"], money(self.payroll("april").gross_salary))
        self.assertEqual(
            (prod["fixed"], prod["difference"]), (5500.0, 75.0)
        )  # 11 working days; the 1.5 day earned more

    def test_a_future_month_has_gained_nothing_and_expects_the_full_salary(self):
        rows = self.rows("expected-salary-report", date(2026, 3, 20))
        self.assertEqual((rows["S201"]["gained"], rows["S201"]["expected"]), (0.0, 15000.0))
        self.assertIsNone(rows["S201"]["upTo"])

    def test_a_new_joiner_expects_nothing_before_joining(self):
        neha = self.rows("expected-salary-report", date(2026, 4, 1))["S104"]
        # 10-30 April: 17 working days + the 14th, a holiday after the join date (paid, as payroll pays it)
        self.assertEqual(neha["toCome"], 18.0)
        self.assertIn("JOINED 10-04", neha["remarks"])


# ═════════════════════════════════════════════════════════════════════════════
#  department headcount / employee list
# ═════════════════════════════════════════════════════════════════════════════


class DepartmentListTests(_World):
    def test_headcount_joins_exits_and_fixed_salary(self):
        body = self.get("department-headcount-report", dateFrom="2026-04-01", dateTo="2026-04-30")
        rows = {r["department"]: r for r in data_rows(body)}
        accounts, cutting, weaving = rows["Accounts"], rows["Cutting"], rows["Weaving"]
        self.assertEqual(
            (accounts["staff"], accounts["production"], accounts["female"], accounts["male"]), (3, 0, 2, 1)
        )
        self.assertEqual((accounts["joined"], accounts["left"]), (1, 1))  # Neha joined 10 Apr; Gone left 20 Apr
        self.assertEqual(accounts["fixedSalary"], 60000.0)
        self.assertEqual((cutting["staff"], cutting["production"], cutting["total"]), (2, 1, 3))
        self.assertEqual(cutting["joined"], 1)  # Selvi: '01-01-<Excel serial>' read as 8 April 2026
        self.assertEqual((cutting["fixedSalary"], cutting["shiftWages"]), (27000.0, 400.0))
        self.assertEqual(weaving["shiftWages"], 500.0)
        self.assertTrue(any("spreadsheet serial" in n for n in body["notes"]))

    def test_employee_list_grouped_by_department(self):
        body = self.get("department-employee-report")
        self.assertEqual(
            [(r["department"], r["employeeCode"]) for r in data_rows(body)],
            [
                ("Accounts", "S101"),
                ("Accounts", "S102"),
                ("Accounts", "S104"),
                ("Cutting", "P201"),
                ("Cutting", "S201"),
                ("Cutting", "S202"),
                ("Weaving", "P101"),
            ],
        )
        subs = subtotal_rows(body)
        self.assertEqual(subs[0]["employeeName"], "Accounts: 3 employees")
        self.assertEqual(subs[0]["fixedSalary"], 60000.0)
        selvi = next(r for r in data_rows(body) if r["employeeCode"] == "P201")
        self.assertEqual((selvi["joinDate"], selvi["ratePerShift"], selvi["fixedSalary"]), ("2026-04-08", 400.0, None))

    def test_join_date_reader(self):
        serial = (date(2024, 12, 14) - date(1899, 12, 30)).days
        self.assertEqual(serial, 45640)
        self.assertEqual(C.join_date(Employee(join_date="01-01-45640")), (date(2024, 12, 14), C.JOIN_SERIAL))
        self.assertEqual(C.join_date(Employee(join_date="2020-05-06")), (date(2020, 5, 6), C.JOIN_OK))
        self.assertEqual(C.join_date(Employee(join_date="")), (None, C.JOIN_MISSING))
        self.assertEqual(C.join_date(Employee(join_date="soon")), (None, C.JOIN_UNREADABLE))


# ═════════════════════════════════════════════════════════════════════════════
#  exports and query budget
# ═════════════════════════════════════════════════════════════════════════════


class ExportAndBudgetTests(_World):
    def test_every_report_builds_excel_and_pdf(self):
        for rid in IDS:
            with self.subTest(rid):
                self.assertTrue(self.export(rid, "xlsx", **APRIL).content.startswith(b"PK"))
                self.assertTrue(self.export(rid, "pdf", **APRIL).content.startswith(b"%PDF"))

    def _queries(self, rid, params) -> int:
        with CaptureQueriesContext(connection) as cq:
            self.get(rid, **params)
        return len(cq.captured_queries)

    def test_query_count_stays_flat_as_people_are_added(self):
        cases = {rid: dict(APRIL) for rid in IDS}
        cases["production-salary-report"] = {"cycle": "biweekly", "dateFrom": "2026-04-10", "dateTo": "2026-04-10"}
        cases["department-headcount-report"] = {"dateFrom": "2026-04-01", "dateTo": "2026-04-30"}
        with report_today(date(2026, 4, 15)):
            before = {rid: self._queries(rid, params) for rid, params in cases.items()}
        for i in range(15):
            emp = Employee.objects.create(
                employee_code=f"X{i:03d}", first_name=f"Extra{i}", employment_type="staff", status="active",
                salary_amount=Decimal("10000"), department=self.cutting, branch=self.u1,
            )  # fmt: skip
            worker = Employee.objects.create(
                employee_code=f"Y{i:03d}", first_name=f"Prod{i}", employment_type="production", status="active",
                salary_per_shift=Decimal("300"), production_pay_cycle="biweekly", department=self.weaving, branch=self.ho,
            )  # fmt: skip
            for d in april_working_days()[:12]:
                day(emp, d)
                day(worker, d)
            Payroll.objects.create(
                employee=emp, salary_mode="monthly", month=MONTH, year=YEAR, total_working_days=26,
                base_salary=Decimal("10000"), gross_salary=Decimal("9000"), final_salary=Decimal("9000"),
            )  # fmt: skip
            Payroll.objects.create(
                employee=worker, salary_mode="shift", month=MONTH, year=YEAR, period_start=P_APRIL[0],
                period_end=P_APRIL[1], pay_cycle="biweekly", base_salary=Decimal("3000"), gross_salary=Decimal("3000"),
                final_salary=Decimal("3000"),
            )  # fmt: skip
        with report_today(date(2026, 4, 15)):
            after = {rid: self._queries(rid, params) for rid, params in cases.items()}
        for rid in IDS:
            self.assertLessEqual(after[rid], 25, rid)
            self.assertEqual(after[rid], before[rid], rid)
