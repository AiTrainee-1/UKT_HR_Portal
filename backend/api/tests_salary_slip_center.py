"""HR -> Payroll -> Salary Slip (owner 2026-11-20): standalone slips worked out from employee details, attendance and
salary only - never from (or into) payroll. Pins the money against the payroll engine's own rules, the independence from
payroll, the page's own Hold, new joiners, the options, the API rights / branch scope and the three files.

Run via: python manage.py test api.tests_salary_slip_center
"""

import io
from datetime import date
from decimal import Decimal

from django.db import transaction
from django.test import TestCase

from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    Branch,
    Department,
    Employee,
    Holiday,
    HRUser,
    Payroll,
    Role,
    SalarySlip,
    StandaloneSalaryHold,
    StandaloneSalarySlip,
)
from .payroll_views import _generate_staff_payroll
from .permission_registry import resolve_module
from .salary_slip_center import engine
from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _day, _present_all, _production, _rule, _staff

URL = "/api/salary-slip-center/"


class _Rollback(Exception):
    pass


def _payroll_figures(emp, month=MONTH, year=YEAR) -> dict:
    """What the payroll engine works out for the same month, rolled back so nothing is kept."""
    out = {}
    try:
        with transaction.atomic():
            res = _generate_staff_payroll(emp, month, year, allow_locked=True)
            slip, p = res["slip"], res["payroll"]
            out = {
                "gross": slip.gross_salary,
                "pf": slip.pf_deduction,
                "esi": slip.esi_deduction,
                "tds": slip.tds_deduction,
                "others": slip.other_deductions,
                "advance": slip.advance_deduction,
                "net": p.final_salary,
            }
            raise _Rollback()
    except _Rollback:
        pass
    return out


def _mine(result: dict) -> dict:
    ded = {line["key"]: Decimal(str(line["amount"])) for line in result["deductions"]}
    zero = Decimal("0")
    return {
        "gross": Decimal(str(result["grossTotal"])),
        "pf": ded.get("pf", zero),
        "esi": ded.get("esi", zero),
        "tds": ded.get("tds", zero),
        "others": ded.get("late", zero) + ded.get("permission", zero),
        "advance": ded.get("advance", zero),
        "net": Decimal(str(result["net"])),
    }


def _advance(emp, amount, month=MONTH, year=YEAR):
    adv = Advance.objects.create(
        employee=emp, advance_type="general", amount=Decimal(amount), status="approved",
        total_repaid=Decimal("0"), outstanding=Decimal(amount),
    )  # fmt: skip
    return AdvanceRepayment.objects.create(advance=adv, month=month, year=year, amount=Decimal(amount))


class _Base(TestCase):
    def setUp(self):
        _configure(
            staff_pf_rules=[],
            staff_esi_rules=[],
            late_free_allowance=3,
            permission_monthly_cap=3,
            attendance_mode="simple",
        )
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        _holiday_dates_for_month.cache_clear()


class EngineMatchesPayrollRulesTests(_Base):
    """The same figures the payroll engine works out, for every part of the staff policy."""

    def assertSameAsPayroll(self, emp):
        result = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual(_mine(result), _payroll_figures(emp))
        return result

    def test_full_month(self):
        emp = _staff(code="SC_FULL", salary="24000.00")
        _present_all(emp)
        result = self.assertSameAsPayroll(emp)
        self.assertEqual(result["grossTotal"], 24000.0)
        self.assertEqual(result["net"], 24000.0)
        # the earnings lines are the salary split and add up to the gross to the paisa
        self.assertEqual(sum(Decimal(str(line["amount"])) for line in result["earnings"]), Decimal("24000.00"))
        self.assertEqual(result["kind"], "staff")
        self.assertEqual(result["slipNumber"], f"SSL/SC_FULL/{YEAR}/{MONTH:02d}")

    def test_absences_half_days_and_a_holiday(self):
        emp = _staff(code="SC_MIX", salary="31000.00")
        holiday = WORKING_DAYS[4]
        Holiday.objects.create(name="Festival", date=holiday)
        days = [d for d in WORKING_DAYS if d != holiday]
        _present_all(emp, days[:-3])
        _day(emp, days[-3], status="half_shift", shifts="0.50")
        result = self.assertSameAsPayroll(emp)
        by_key = {row["key"]: row["value"] for row in result["days"]}
        self.assertEqual(by_key["holidayDays"], 1)
        self.assertEqual(by_key["halfShiftDays"], 1)
        self.assertLess(result["grossTotal"], 31000.0)
        self.assertTrue(any(row["status"] == "holiday" and row["note"] == "Festival" for row in result["calendar"]))

    def test_pf_esi_late_and_advance(self):
        _configure(
            staff_pf_rules=[_rule("pf1", 0, 25000, 12)],
            staff_esi_rules=[_rule("esi1", 0, 30000, "0.75")],
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": "0.25"}],
            late_free_allowance=0,
        )
        emp = _staff(code="SC_STAT", salary="20400.00", co_emp_enabled=True)
        _present_all(emp, WORKING_DAYS[2:])
        _day(emp, WORKING_DAYS[0], is_late=True)
        _day(emp, WORKING_DAYS[1], is_late=True)
        _advance(emp, "1500.00")
        result = self.assertSameAsPayroll(emp)
        keys = [line["key"] for line in result["deductions"]]
        self.assertIn("pf", keys)
        self.assertIn("esi", keys)
        self.assertIn("advance", keys)
        self.assertEqual(result["statement"]["advance"], 1500.0)

    def test_tds_employee(self):
        emp = _staff(code="SC_TDS", salary="50000.00", tds_enabled=True, tds_percent=Decimal("10"))
        _present_all(emp)
        result = self.assertSameAsPayroll(emp)
        self.assertEqual(_mine(result)["tds"], Decimal("5000.00"))


class EngineRulesTests(_Base):
    def test_options_switch_each_deduction_off(self):
        _configure(staff_pf_rules=[_rule("pf1", 0, 25000, 12)])
        emp = _staff(code="SC_OPT", salary="20000.00", co_emp_enabled=True)
        _present_all(emp)
        _advance(emp, "800.00")
        on = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual({line["key"] for line in on["deductions"]}, {"pf", "advance"})
        off = engine.calculate(emp, MONTH, YEAR, {"statutory": False, "lateDeductions": False, "advances": False})
        self.assertEqual(off["deductions"], [])
        self.assertEqual(off["net"], 20000.0)
        self.assertEqual(off["options"], {"statutory": False, "lateDeductions": False, "advances": False})

    def test_advance_instalment_is_read_only(self):
        emp = _staff(code="SC_ADV_RO")
        _present_all(emp)
        repayment = _advance(emp, "700.00")
        engine.calculate(emp, MONTH, YEAR)
        repayment.refresh_from_db()
        self.assertFalse(repayment.is_processed)
        self.assertEqual(Advance.objects.get(pk=repayment.advance_id).total_repaid, Decimal("0"))

    def test_nothing_is_written_to_payroll(self):
        emp = _staff(code="SC_NOPAY")
        _present_all(emp)
        StandaloneSalarySlip.objects.all().delete()
        engine.calculate(emp, MONTH, YEAR)
        self.assertFalse(Payroll.objects.filter(employee=emp).exists())
        self.assertFalse(SalarySlip.objects.filter(employee=emp).exists())

    def test_no_salary_and_future_month_say_why(self):
        emp = _staff(code="SC_NOSAL", salary="1.00")
        emp.salary_amount = None
        emp.save()
        with self.assertRaisesMessage(engine.CannotCalculate, "No monthly salary on the profile"):
            engine.calculate(emp, MONTH, YEAR)
        with self.assertRaisesMessage(engine.CannotCalculate, "has not started yet"):
            engine.calculate(_staff(code="SC_FUT"), 12, 2099)

    def test_new_joiner_is_paid_from_the_joining_date(self):
        joined = WORKING_DAYS[10]
        emp = _staff(code="SC_NEW", salary="27000.00", join_date=joined.isoformat())
        _present_all(emp, [d for d in WORKING_DAYS if d >= joined])
        early_holiday = WORKING_DAYS[2]
        Holiday.objects.create(name="Before joining", date=early_holiday)
        result = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual(_mine(result), _payroll_figures(emp))
        statuses = {row["date"]: row["status"] for row in result["calendar"]}
        self.assertEqual(statuses[WORKING_DAYS[0].isoformat()], "not_joined")
        self.assertTrue(any("Joined on" in note for note in result["notes"]))

    def test_attendance_before_the_joining_date_still_counts_like_payroll(self):
        # a joining date typed later than the first worked days: attendance decides the pay, as in payroll
        emp = _staff(code="SC_LATEJOIN", salary="26000.00", join_date=WORKING_DAYS[5].isoformat())
        _present_all(emp)
        result = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual(_mine(result), _payroll_figures(emp))
        prod = _production(code="SC_LATEJOIN_P", join_date=WORKING_DAYS[5].isoformat())
        for d in WORKING_DAYS[:4]:
            _day(prod, d)
        self.assertEqual(engine.calculate(prod, MONTH, YEAR)["grossTotal"], 2000.0)

    def test_month_in_progress_is_counted_to_today(self):
        emp = _staff(code="SC_NOW")
        _present_all(emp, WORKING_DAYS[:5])
        today = WORKING_DAYS[4]
        result = engine.calculate(emp, MONTH, YEAR, today=today)
        self.assertTrue(result["period"]["inProgress"])
        self.assertEqual(result["period"]["countedTo"], today.isoformat())
        self.assertTrue(any(row["status"] == "future" for row in result["calendar"]))
        self.assertTrue(result["notes"][0].startswith("Counted up to"))

    def test_inactive_employee_gets_a_slip(self):
        emp = _staff(code="SC_INACT")
        Employee.objects.filter(pk=emp.pk).update(status="inactive")
        emp.refresh_from_db()
        _present_all(emp)
        result = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual(result["employee"]["status"], "inactive")
        self.assertIn("This employee is inactive.", result["notes"])

    def test_production_month_is_shifts_times_rate(self):
        emp = _production(code="SC_PROD", per_shift="500.00")
        days = WORKING_DAYS[:10]
        for d in days[:9]:
            _day(emp, d)
        _day(emp, days[9], status="half_shift", shifts="0.50")
        _advance(emp, "300.00")
        result = engine.calculate(emp, MONTH, YEAR)
        self.assertEqual(result["kind"], "production")
        self.assertEqual(result["grossTotal"], 4750.0)
        self.assertEqual(result["statement"]["shifts"], 9.5)
        self.assertEqual(result["deductionsTotal"], 300.0)
        self.assertEqual(result["net"], 4450.0)


def _token(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"}


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.head = Branch.objects.create(name="SC Head Office", code="SC_HO", is_head_office=True)
        self.unit = Branch.objects.create(name="SC Unit 9", code="Unit9")
        dept = Department.objects.create(name="ACCOUNTS", branch=self.head)
        self.admin = HRUser.objects.create(username="slip_admin", password_hash="x", is_super_admin=True)
        self.a = _staff(code="SCA_1", salary="26000.00", branch=self.head, department=dept,
                        bank_account="123456789012", bank_ifsc="HDFC0000001", bank_name="HDFC")  # fmt: skip
        self.b = _staff(code="SCA_2", salary="18000.00", branch=self.head)
        Employee.objects.filter(pk=self.b.pk).update(status="inactive")
        self.b.refresh_from_db()
        self.c = _staff(code="SCA_3", salary="22000.00", branch=self.unit, join_date=date(YEAR, MONTH, 10).isoformat(),
                        bank_account="99887766", bank_ifsc="SBIN0000001")  # fmt: skip
        self.p = _production(code="SCA_P", branch=self.unit, bank_account="5555", bank_ifsc="ICIC0000001")
        for emp in (self.a, self.b, self.c):
            _present_all(emp)
        for d in WORKING_DAYS[:8]:
            _day(self.p, d)
        self.auth = _token(self.admin)

    def _get(self, path, auth=None, **params):
        return self.client.get(URL + path, params, **(auth or self.auth))

    def _post(self, path, body, auth=None):
        return self.client.post(URL + path, body, content_type="application/json", **(auth or self.auth))

    def _generate(self, *emps, auth=None):
        return self._post("generate", {"month": MONTH, "year": YEAR, "employeeIds": [e.id for e in emps]}, auth)

    def test_permission_key_guards_the_api(self):
        self.assertEqual(resolve_module("salary-slip-center/employees"), "salary_slip_center")
        self.assertEqual(resolve_module("salary-slip-center/download/bank-file"), "salary_slip_center")

    def test_list_has_every_status_and_the_tab_facts(self):
        res = self._get("employees", month=MONTH, year=YEAR)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        rows = {r["code"]: r for r in body["employees"]}
        self.assertTrue({"SCA_1", "SCA_2", "SCA_3", "SCA_P"} <= set(rows))
        self.assertEqual(rows["SCA_2"]["status"], "inactive")
        self.assertTrue(rows["SCA_3"]["isNewJoiner"])
        self.assertFalse(rows["SCA_1"]["isNewJoiner"])
        self.assertEqual(rows["SCA_P"]["category"], "production")
        self.assertEqual(rows["SCA_P"]["salaryPerShift"], 500.0)
        self.assertEqual(rows["SCA_1"]["bankAccountMasked"], "XXXXXXXX9012")
        self.assertEqual(rows["SCA_2"]["bankIssue"], "No bank account number")
        self.assertIsNone(rows["SCA_1"]["slip"])
        self.assertTrue(body["canEdit"])
        self.assertEqual(body["defaultOptions"], {"statutory": True, "lateDeductions": True, "advances": True})

    def test_generate_saves_replaces_and_lists_the_slip(self):
        res = self._generate(self.a, self.p)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()["generated"]), 2)
        self.assertEqual(StandaloneSalarySlip.objects.filter(month=MONTH, year=YEAR).count(), 2)
        self._generate(self.a)
        self.assertEqual(StandaloneSalarySlip.objects.filter(employee=self.a).count(), 1)
        rows = {r["code"]: r for r in self._get("employees", month=MONTH, year=YEAR).json()["employees"]}
        self.assertEqual(rows["SCA_1"]["slip"]["net"], 26000.0)
        self.assertEqual(rows["SCA_1"]["slip"]["generatedBy"], "slip_admin")
        saved = self._get("slip", month=MONTH, year=YEAR, employeeId=self.a.id).json()
        self.assertEqual(saved["result"]["net"], 26000.0)
        # payroll never sees it
        self.assertFalse(Payroll.objects.filter(employee=self.a).exists())

    def test_generate_lists_who_could_not_be_worked_out(self):
        self.b.salary_amount = None
        self.b.save()
        body = self._generate(self.a, self.b).json()
        self.assertEqual([g["employeeId"] for g in body["generated"]], [self.a.id])
        self.assertEqual(body["skipped"][0]["reason"], "No monthly salary on the profile")

    def test_preview_saves_nothing_and_takes_the_options(self):
        res = self._get("preview", month=MONTH, year=YEAR, employeeId=self.a.id, statutory=0, late=0, advances=0)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["result"]["options"]["statutory"], False)
        self.assertFalse(StandaloneSalarySlip.objects.exists())

    def test_hold_and_release(self):
        res = self._post("hold", {"month": MONTH, "year": YEAR, "employeeIds": [self.a.id], "hold": True,
                                  "reason": "Documents pending"})  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["employees"][0]["onHold"])
        row = {r["code"]: r for r in self._get("employees", month=MONTH, year=YEAR).json()["employees"]}["SCA_1"]
        self.assertEqual((row["onHold"], row["holdReason"]), (True, "Documents pending"))
        # a hold is per month
        other = {r["code"]: r for r in self._get("employees", month=1, year=YEAR).json()["employees"]}["SCA_1"]
        self.assertFalse(other["onHold"])
        self._post("hold", {"month": MONTH, "year": YEAR, "employeeIds": [self.a.id], "hold": False})
        self.assertFalse(StandaloneSalaryHold.objects.exists())

    def test_downloads_need_saved_slips(self):
        res = self._get("download/slips", month=MONTH, year=YEAR, ids=f"{self.a.id},{self.c.id}")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(sorted(res.json()["missing"]), sorted([self.a.id, self.c.id]))

    def test_slip_pdfs_and_statement_files(self):
        self._generate(self.a, self.c, self.p)
        ids = f"{self.a.id},{self.c.id},{self.p.id}"
        for layout in ("single", "double"):
            res = self._get("download/slips", month=MONTH, year=YEAR, ids=ids, layout=layout)
            self.assertEqual(res.status_code, 200, res.content[:200])
            self.assertEqual(res["Content-Type"], "application/pdf")
            self.assertTrue(res.content.startswith(b"%PDF"))
        one = self._get("download/slips", month=MONTH, year=YEAR, ids=str(self.a.id))
        self.assertIn("Salary-Slip-SCA_1-", one["Content-Disposition"])
        pdf = self._get("download/statement", month=MONTH, year=YEAR, ids=ids, fmt="pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        xlsx = self._get("download/statement", month=MONTH, year=YEAR, ids=ids, fmt="xlsx")
        self.assertEqual(xlsx.status_code, 200)
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(xlsx.content))
        self.assertEqual(wb.sheetnames, ["Staff", "Production", "Summary"])
        staff_values = [c for row in wb["Staff"].iter_rows(values_only=True) for c in row if c is not None]
        self.assertIn("SCA_1", staff_values)
        self.assertIn("NEW JOINER", staff_values)

    def test_bank_check_and_file_leave_out_held_and_no_bank(self):
        self.b.salary_amount = Decimal("18000.00")
        self.b.save()
        self._generate(self.a, self.b, self.c)
        self._post("hold", {"month": MONTH, "year": YEAR, "employeeIds": [self.c.id], "hold": True})
        ids = f"{self.a.id},{self.b.id},{self.c.id},{self.p.id}"
        check = self._get("bank-check", month=MONTH, year=YEAR, ids=ids).json()
        self.assertEqual([r["code"] for r in check["included"]], ["SCA_1"])
        reasons = {r["code"]: r["reason"] for r in check["leftOut"]}
        self.assertEqual(reasons, {"SCA_2": "No bank account number", "SCA_3": "On hold", "SCA_P": "Not generated yet"})
        res = self._get("download/bank-file", month=MONTH, year=YEAR, ids=ids)
        self.assertEqual(res.status_code, 200, res.content[:200])
        from openpyxl import load_workbook

        ws = load_workbook(io.BytesIO(res.content)).active
        rows = list(ws.iter_rows(min_row=3, values_only=True))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][2:6], ("SCA_1", "123456789012", 26000.0, "SCA_1 STAFF"))

    def test_view_only_role_reads_but_cannot_generate_or_hold(self):
        role = Role.objects.create(name="Slip viewer", permissions={"salary_slip_center": "view"})
        viewer = HRUser.objects.create(username="slip_viewer", password_hash="x", role=role)
        auth = _token(viewer)
        res = self._get("employees", auth=auth, month=MONTH, year=YEAR)
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()["canEdit"])
        self.assertEqual(self._generate(self.a, auth=auth).status_code, 403)
        hold = self._post("hold", {"month": MONTH, "year": YEAR, "employeeIds": [self.a.id], "hold": True}, auth)
        self.assertEqual(hold.status_code, 403)

    def test_hidden_without_the_key_and_payslip_rights_open_it(self):
        none = Role.objects.create(name="Nothing", permissions={})
        nobody = HRUser.objects.create(username="slip_nobody", password_hash="x", role=none)
        self.assertEqual(self._get("employees", auth=_token(nobody), month=MONTH, year=YEAR).status_code, 403)
        # until a role sets it, the page follows Staff Payroll -> Payslip
        payslips = Role.objects.create(name="Payslips", permissions={"salary_slip": "edit"})
        clerk = HRUser.objects.create(username="slip_clerk", password_hash="x", role=payslips)
        self.assertEqual(self._generate(self.a, auth=_token(clerk)).status_code, 200)

    def test_branch_login_sees_only_its_branch(self):
        role = Role.objects.create(name="Unit slips", permissions={"salary_slip_center": "edit"})
        unit_user = HRUser.objects.create(username="slip_unit", password_hash="x", role=role, branch=self.unit)
        auth = _token(unit_user)
        codes = {r["code"] for r in self._get("employees", auth=auth, month=MONTH, year=YEAR).json()["employees"]}
        self.assertIn("SCA_3", codes)
        self.assertNotIn("SCA_1", codes)
        res = self._generate(self.a, auth=auth)
        self.assertEqual(res.status_code, 400)
        self.assertFalse(StandaloneSalarySlip.objects.filter(employee=self.a).exists())

    def test_generate_refuses_too_many_at_once(self):
        res = self._post("generate", {"month": MONTH, "year": YEAR, "employeeIds": list(range(1, 60))})
        self.assertEqual(res.status_code, 400)
        self.assertIn("at most 50", res.json()["error"])
