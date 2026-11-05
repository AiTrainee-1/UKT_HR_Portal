"""
Report Center - HR Reports (category ``hr``): hr-salary-statement, the printed Salary Statement.

The report must show exactly what Payroll > Salary Statement (GET /api/payroll/salary-statement) shows, because both call
the same builder. It lists the figures unit by unit (owner 2026-11-04: split the exports by unit, like the Report Log's Late
exports): a band per unit, its departments, its total, serial numbers from 1 in every unit, a Unit column on every line.
The columns are the owner's (2026-11-05): Basic / Other / Total Salary, Present / CL / LOP / HD (holidays) / Total Days,
Earned Salary, PF / ESI / TDS / [Advance, only in a month with an advance recovered] / Others / Total Deduction, NET. Payrolls are made by the REAL engine (``_generate_staff_payroll``) from manual attendance day records,
for April 2026 (26 working days, like the printed statement), with "today" frozen after the month.

Run via: python manage.py test api.tests_reporting_hr_salary_statement -v 2
"""

import io
import re
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Branch,
    CasualLeaveRequest,
    Department,
    Designation,
    Employee,
    Holiday,
    HRUser,
    Payroll,
    PayrollSettings,
    Role,
    SalarySlip,
)
from .payroll_views import _build_working_days, _generate_staff_payroll
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.definitions import hr_reports_salary_statement as S
from .reporting.export_xlsx import HEADER_ROW

RID = "hr-salary-statement"
MONTH, YEAR = 4, 2026
WORKING = _build_working_days(MONTH, YEAR, False, set())  # 26 Mon-Sat days
PERIOD = "2026-04"

LABELS = [
    "SNO", "ID NO", "Name", "Designation", "Basic Salary", "Other Allowance", "Total Salary", "Present", "CL", "HD",
    "Total Days", "LOP", "Company Days", "Earned Salary", "PF", "ESI", "TDS", "Advance", "Others", "Total Deduction", "NET", "Remarks", "Unit",
]  # fmt: skip
KEYS = [
    "sno", "code", "name", "designation", "basic", "otherSalary", "total", "present", "cl", "hd", "totalDays", "lop",
    "companyDays", "eSalary", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net", "remarks", "unit",
]  # fmt: skip
PRINTED_TOTALS = [
    "basic", "otherSalary", "total", "eSalary", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net",
]  # fmt: skip
# the figures the report takes straight from the Payroll page's statement (Present / HD / Basic / Other Allowance are mapped)
VALUE_KEYS = [
    "code", "name", "designation", "total", "cl", "lop", "totalDays", "eSalary", "advance", "esi", "pf", "tds", "others",
    "totalDeduction", "net", "remarks",
]  # fmt: skip

# The attendance engine only computes days that have elapsed: with "today" fixed after the month the figures do not depend
# on the date the suite runs on.
_FROZEN_TODAY = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN_TODAY.start()


def tearDownModule():
    _FROZEN_TODAY.stop()


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def data_rows(body) -> list[dict]:
    return [r for r in body["rows"] if not r.get("_kind")]


def by_code(body) -> dict:
    return {r["code"]: r for r in data_rows(body)}


def headings(body) -> list[str]:
    """The department heading lines: structural lines that carry a name and no money at all."""
    return [r["name"] for r in body["rows"] if r.get("_kind") == "subtotal" and r["net"] is None]


def subtotals(body) -> dict[tuple[str, str], dict]:
    """The department Sub total lines, by (unit, department)."""
    return {
        (r["unit"], r["name"][: -len(" Sub total")]): r
        for r in body["rows"]
        if r.get("_kind") == "subtotal" and r["name"].endswith(" Sub total")
    }


def bands(body) -> list[str]:
    """The unit band lines: total-styled lines with a name and no money."""
    return [r["name"] for r in body["rows"] if r.get("_kind") == "total" and r["net"] is None]


def unit_totals(body) -> dict[str, dict]:
    return {r["unit"]: r for r in body["rows"] if r.get("_kind") == "total" and r["net"] is not None}


def day(emp, d, status="present", shifts="1.00"):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"),
        source="manual",
    )


class _World(TestCase):
    """April 2026, seven staff payrolls in two units, plus staff who have none.

    Unit 1: Accounts (2316 Meena: salary 29,500 split with a Petrol part, 22 days + 2 approved Casual Leave + 2 absent; 2896
    Lokesh: a half day, an advance of 6,000 with 2,000 recovered; 30071 Sriram: 3 days, now INACTIVE) and Admin (189, 226).
    Unit 2: Cutting (3000) and its own Admin department (5000: same NAME as Unit 1's Admin, a different department).
    No payroll: 4000 (Unit 1, active, counted), 4003 (Unit 2, active, counted), 4001 (joined in May: not counted yet),
    4002 (inactive) and a production worker."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        for key, value in {
            "attendance_mode": "simple",
            "late_deduction_slabs": [],
            "permission_monthly_cap": 3,
            "compensation_feature_enabled": True,
            "company_name": "U.K TEXTILES",
        }.items():
            setattr(ps, key, value)
        ps.save()

        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.b1)
        cls.admin_d = Department.objects.create(name="Admin", branch=cls.b1)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.b2)
        cls.admin_d2 = Department.objects.create(name="Admin", branch=cls.b2)
        cls.des_exec = Designation.objects.create(title="Accounts Executive")
        cls.des_op = Designation.objects.create(title="Operator")

        def staff(code, first, dept, branch, salary, designation=None, **kw):
            fields = {
                "status": "active",
                "salary_type": "monthly",
                "salary_amount": Decimal(salary),
                "department": dept,
                "branch": branch,
                "designation": designation or cls.des_op,
                **kw,
            }
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="Staff", employment_type="staff", **fields
            )

        cls.staff_maker = staff
        w = WORKING
        cls.meena = staff(
            "2316", "MEENATCHI", cls.accounts, cls.b1, "29500", cls.des_exec,
            salary_basic=Decimal("14750"), salary_da=Decimal("0"), salary_retaining_allowance=Decimal("0"),
            salary_other_allowance=Decimal("12750"), salary_petrol_allowance=Decimal("2000"), salary_hra=Decimal("0"),
            salary_special_allowance=Decimal("0"), salary_ca=Decimal("0"),
        )  # fmt: skip
        for d in w[:22]:
            day(cls.meena, d)
        for d in w[22:24]:
            day(cls.meena, d)  # an approved Casual Leave day is stored as a Present day
            CasualLeaveRequest.objects.create(employee=cls.meena, date=d, status="approved")
        for d in w[24:]:
            day(cls.meena, d, "absent", "0")

        cls.lokesh = staff("2896", "LOKESH", cls.accounts, cls.b1, "17500", cls.des_exec)
        for d in w[:20]:
            day(cls.lokesh, d)
        day(cls.lokesh, w[20], "half_shift", "0.50")
        day(cls.lokesh, w[21])
        CasualLeaveRequest.objects.create(employee=cls.lokesh, date=w[21], status="approved")
        for d in w[22:]:
            day(cls.lokesh, d, "absent", "0")
        advance = Advance.objects.create(
            employee=cls.lokesh, advance_type="general", amount=Decimal("6000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("6000"),
        )  # fmt: skip
        AdvanceRepayment.objects.create(advance=advance, month=MONTH, year=YEAR, amount=Decimal("2000"))

        cls.sriram = staff("30071", "SRIRAM", cls.accounts, cls.b1, "50000", cls.des_exec, status="inactive")
        for d in w[:3]:
            day(cls.sriram, d)
        for d in w[3:]:
            day(cls.sriram, d, "absent", "0")

        others = [
            staff("189", "MURUGAN", cls.admin_d, cls.b1, "50000"),
            staff("226", "KRISHNAN", cls.admin_d, cls.b1, "14000"),
            staff("3000", "CHITRA", cls.cutting, cls.b2, "21000"),
            staff("5000", "RAJA", cls.admin_d2, cls.b2, "16000"),
        ]
        for emp in others:
            for d in w:
                day(emp, d)
        cls.everyone = (cls.meena, cls.lokesh, cls.sriram, *others)
        cls.payrolls = {e.employee_code: _generate_staff_payroll(e, MONTH, YEAR)["payroll"] for e in cls.everyone}

        # staff payroll has not been run for
        staff("4000", "NOPAY", cls.accounts, cls.b1, "10000")
        staff("4003", "NOPAYTWO", cls.cutting, cls.b2, "10000")
        staff("4001", "LATEJOIN", cls.accounts, cls.b1, "10000", join_date="2026-05-01")
        staff("4002", "GONE", cls.accounts, cls.b1, "10000", status="inactive")
        Employee.objects.create(
            employee_code="P1", first_name="Prod", last_name="Worker", employment_type="production",
            status="active", salary_per_shift=Decimal("500"), department=cls.accounts, branch=cls.b1,
        )  # fmt: skip

        # people
        cls.admin = HRUser.objects.create(username="ss_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.payroll_user = user("ss_payroll", {"payroll": "view"})
        cls.salary_user = user("ss_salary", {"salary": "view", "salary_slip": "view"})
        cls.production_user = user("ss_production", {"production_payroll": "view"})
        cls.plain_user = user("ss_plain", {})
        cls.branch_user = user("ss_branch", {"payroll": "view"}, branch=cls.b1)

    # ── helpers ────────────────────────────────────────────────────────────
    def get(self, user=None, expect=200, **params):
        params = {"period": PERIOD, **params}
        r = self.client.get(f"/api/reports/run/{RID}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, fmt, user=None, expect=200, **params):
        params = {"period": PERIOD, "fmt": fmt, **params}
        r = self.client.get(f"/api/reports/export/{RID}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    def statement(self, extra="", user=None):
        r = self.client.get(
            f"/api/payroll/salary-statement?month={MONTH}&year={YEAR}{extra}", **hdr(user or self.admin)
        )
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def statement_rows(self, body=None) -> dict:
        body = body or self.statement()
        return {r["values"]["code"]: r["values"] for g in body["groups"] for r in g["rows"]}


# ═════════════════════════════════════════════════════════════════════════════
# Registration, columns and access
# ═════════════════════════════════════════════════════════════════════════════


class CatalogTests(_World):
    def test_the_report_is_registered_in_the_hr_group_with_the_printed_columns(self):
        spec = next(s for s in registry.all_specs() if s.id == RID)
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual((spec.title, spec.category), ("Salary Statement", "hr"))
        self.assertEqual([c.label for c in spec.columns], LABELS)
        self.assertEqual([c.key for c in spec.columns], KEYS)
        self.assertTrue(set(spec.modules) <= set(all_module_keys()), spec.modules)
        self.assertFalse(spec.super_admin_only)
        types = {c.key: c.type for c in spec.columns}
        self.assertEqual(types["sno"], "integer")
        for key in ("code", "name", "designation", "remarks", "unit"):
            self.assertEqual(types[key], "text", key)
        for key in ("present", "cl", "lop", "hd", "totalDays"):
            self.assertEqual(types[key], "number", key)
        for key in PRINTED_TOTALS:
            self.assertEqual(types[key], "currency", key)
        # exactly the printed statement's grand-total columns are added up
        self.assertEqual([c.key for c in spec.columns if c.total == "sum"], PRINTED_TOTALS)
        self.assertEqual(S.SUM_KEYS, tuple(PRINTED_TOTALS))

    def test_the_catalog_offers_it_with_its_filters(self):
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        report = next(r for r in body["reports"] if r["id"] == RID)
        self.assertEqual(report["category"], "hr")
        self.assertEqual([c["label"] for c in report["columns"]], LABELS)
        self.assertEqual(
            [(f["key"], f["kind"]) for f in report["filters"]],
            [
                ("period", "period"),
                ("branch", "branch"),
                ("department", "department"),
                ("designation", "designation"),
                ("employee", "employee"),
                ("employeeStatus", "employeeStatus"),
                ("paymentStatus", "select"),
            ],
        )
        status = next(f for f in report["filters"] if f["key"] == "employeeStatus")
        self.assertEqual(status["default"], "all")  # an employee who has since left stays on last month's statement

    def test_the_month_defaults_to_last_month(self):
        with patch("api.reporting.filters.ist_today", return_value=date(2026, 5, 10)):
            r = self.client.get(f"/api/reports/run/{RID}", **hdr(self.admin))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(data_rows(r.json())), 7)
        self.assertEqual(dict((f["label"], f["value"]) for f in r.json()["filters"])["Month"], "April 2026")

    def test_a_bad_month_is_a_400(self):
        r = self.client.get(f"/api/reports/run/{RID}", {"period": "April"}, **hdr(self.admin))
        self.assertEqual(r.status_code, 400)


class AccessTests(_World):
    def test_only_the_payroll_module_opens_it_like_the_statement_endpoint(self):
        for who in (self.payroll_user, self.admin):
            self.assertEqual(len(data_rows(self.get(user=who))), 7, who.username)
            self.assertEqual(self.export("xlsx", user=who).status_code, 200)
            self.assertEqual(
                self.client.get("/api/payroll/salary-statement?month=4&year=2026", **hdr(who)).status_code, 200
            )

    def test_a_role_without_payroll_access_is_refused_everywhere(self):
        """Salary and deductions are printed: the Salary / Salary Slip / Production Payroll modules are not enough."""
        for who in (self.salary_user, self.production_user, self.plain_user):
            catalog = self.client.get("/api/reports/catalog", **hdr(who)).json()
            self.assertNotIn(RID, [r["id"] for r in catalog["reports"]], who.username)
            r = self.client.get(f"/api/reports/run/{RID}", {"period": PERIOD}, **hdr(who))
            self.assertEqual(r.status_code, 403, who.username)
            self.assertEqual(r.json()["error"], "report_forbidden")
            for fmt in ("xlsx", "pdf"):
                r = self.client.get(f"/api/reports/export/{RID}", {"fmt": fmt, "period": PERIOD}, **hdr(who))
                self.assertEqual(r.status_code, 403, (who.username, fmt))
                self.assertEqual(r.json()["error"], "report_forbidden")

    def test_it_needs_an_hr_login(self):
        self.assertEqual(self.client.get(f"/api/reports/run/{RID}").status_code, 401)
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.meena.id})}"}
        self.assertEqual(self.client.get(f"/api/reports/run/{RID}", **emp).status_code, 403)

    def test_a_view_only_role_can_read_it(self):
        # payroll_user holds "view" (not edit) and reads everything: the report never writes
        body = self.get(user=self.payroll_user)
        self.assertEqual(len(data_rows(body)), 7)


# ═════════════════════════════════════════════════════════════════════════════
# What the rows say
# ═════════════════════════════════════════════════════════════════════════════


class ContentTests(_World):
    def test_every_number_equals_the_payroll_statement(self):
        body = self.get()
        expected = self.statement_rows()
        got = by_code(body)
        self.assertEqual(sorted(got), sorted(expected))
        self.assertEqual(len(got), 7)
        for code, row in got.items():
            for key in VALUE_KEYS:
                self.assertEqual(row[key], expected[code][key], (code, key))

    def test_unit_by_unit_then_department_with_serial_numbers_from_1_in_every_unit(self):
        body = self.get()
        self.assertEqual(bands(body), ["U1 – Unit 1   5 employees", "U2 – Unit 2   2 employees"])
        # inside a unit the departments are the statement's (name order, code order), so a department name is printed
        # plainly: each Admin is under its own unit's band
        self.assertEqual(headings(body), ["Accounts", "Admin", "Admin", "Cutting"])
        self.assertEqual([r["code"] for r in data_rows(body)], ["2316", "2896", "30071", "189", "226", "5000", "3000"])
        self.assertEqual([r["sno"] for r in data_rows(body)], [1, 2, 3, 4, 5, 1, 2])
        self.assertEqual([r["unit"] for r in data_rows(body)], ["U1"] * 5 + ["U2"] * 2)
        kinds = [(r.get("_kind"), r["name"]) for r in body["rows"]]
        self.assertEqual(kinds[0], ("total", "U1 – Unit 1   5 employees"))  # the unit's band first
        self.assertEqual(kinds[1], ("subtotal", "Accounts"))  # a heading right before its department's rows
        self.assertEqual(kinds[5], ("subtotal", "Accounts Sub total"))  # the Sub total right after them
        self.assertEqual(kinds[6], ("subtotal", "Admin"))
        self.assertEqual(kinds[10], ("total", "U1 – Unit 1 total"))
        self.assertEqual(kinds[11], ("total", "U2 – Unit 2   2 employees"))
        self.assertEqual(kinds[-1], ("total", "U2 – Unit 2 total"))
        # every structural line carries its unit too, so the Unit column filters a whole unit
        self.assertEqual({r["unit"] for r in body["rows"]}, {"U1", "U2"})
        # the figures are still the Payroll page's statement's, line for line
        statement = self.statement()
        self.assertEqual(sorted(by_code(body)), sorted(self.statement_rows(statement)))

    def test_a_known_row_matches_the_printed_example(self):
        row = by_code(self.get())["2316"]
        self.assertEqual(
            (row["name"], row["designation"], row["basic"], row["total"]),
            ("MEENATCHI Staff", "Accounts Executive", 14750.0, 29500.0),
        )
        self.assertEqual(
            (row["present"], row["cl"], row["lop"], row["hd"], row["totalDays"]), (22.0, 2.0, 2.0, 0.0, 24.0)
        )
        self.assertEqual((row["basic"], row["otherSalary"]), (14750.0, 14750.0))  # 50% + 50% of the salary
        lokesh = by_code(self.get())["2896"]
        # 20 days + a half day + a Casual Leave day: Present 20.5 (the half day counts 0.5), its missing half is LOP
        self.assertEqual(
            (lokesh["present"], lokesh["cl"], lokesh["lop"], lokesh["hd"], lokesh["totalDays"]), (20.5, 1.0, 4.5, 0.0, 21.5)
        )
        self.assertEqual(lokesh["advance"], 2000.0)
        self.assertNotIn("tAdvance", lokesh)
        self.assertEqual(by_code(self.get())["30071"]["remarks"], "LEFT")

    def test_department_subtotals_add_up_the_printed_columns(self):
        body = self.get()
        rows = data_rows(body)
        accounts = [r for r in rows if r["code"] in ("2316", "2896", "30071")]
        subs = subtotals(body)
        for key in PRINTED_TOTALS:
            self.assertAlmostEqual(subs[("U1", "Accounts")][key], round(sum(r[key] for r in accounts), 2), 2, key)
            self.assertAlmostEqual(subs[("U2", "Cutting")][key], by_code(body)["3000"][key], 2, key)
            self.assertAlmostEqual(subs[("U2", "Admin")][key], by_code(body)["5000"][key], 2, key)
        # the money the printed sheet does not add up stays blank on the subtotal
        for key in ("present", "cl", "hd", "totalDays", "lop", "companyDays"):  # the day columns are not added up
            self.assertIsNone(subs[("U1", "Accounts")][key], key)
        self.assertIsNone(subs[("U1", "Accounts")]["sno"])
        self.assertEqual(len(subs), 4)

    def test_the_grand_total_is_the_statements_total(self):
        body = self.get()
        statement = self.statement()
        for key in PRINTED_TOTALS:
            if key in VALUE_KEYS and statement["total"]["values"].get(key) is not None:  # the money both statements add
                self.assertAlmostEqual(body["totals"][key], statement["total"]["values"][key], 2, key)
            self.assertAlmostEqual(body["totals"][key], round(sum(r[key] for r in data_rows(body)), 2), 2, key)
        # subtotal lines are not counted twice
        self.assertAlmostEqual(body["totals"]["net"], round(sum(s["net"] for s in subtotals(body).values()), 2), 2)
        for key in ("present", "cl", "hd", "totalDays", "lop", "companyDays"):
            self.assertNotIn(key, body["totals"])
        # ... nor are the unit totals
        self.assertAlmostEqual(body["totals"]["net"], round(sum(u["net"] for u in unit_totals(body).values()), 2), 2)
        # no headline figures above the table (owner 2026-11-05)
        self.assertEqual(body["summary"], [])

    def test_the_notes_explain_the_columns(self):
        text = " ".join(self.get()["notes"])
        self.assertIn("Basic Salary is 50% of it and Other Allowance the other 50%", text)
        self.assertIn("Total Days = Present + CL + HD", text)
        self.assertIn("LOP = Company Days - Total Days", text)
        self.assertIn("Others is the Late Detection and Permission deduction", text)
        self.assertIn("Total Deduction = PF + ESI + TDS + Advance + Others", text)  # this month has an advance
        for gone in ("PTRL", "Others Allow", "Lop& PSAmt", "E salary"):
            self.assertNotIn(gone, text, gone)
        # a month (here: a selection) without an advance leaves Advance out of the sum too
        text = " ".join(self.get(branchIds=str(self.b2.id))["notes"])
        self.assertIn("Total Deduction = PF + ESI + TDS + Others", text)

    def test_staff_without_a_payroll_are_counted_in_the_notes_not_listed(self):
        body = self.get()
        listed = {r["code"] for r in data_rows(body)}
        self.assertFalse(listed & {"4000", "4001", "4002", "4003", "P1"})
        missing = [n for n in body["notes"] if "no payroll generated" in n]
        # 4000 (Unit 1) and 4003 (Unit 2): not 4001 (joins in May), 4002 (inactive) or the production worker
        self.assertEqual(len(missing), 1)
        self.assertTrue(missing[0].startswith("2 active staff member(s)"), missing[0])
        self.assertEqual(self.get(departmentIds=str(self.accounts.id))["notes"][-1][:2], "1 ")

    def test_a_month_with_no_payroll_lists_nobody_and_says_so(self):
        body = self.get(period="2026-03")
        self.assertEqual(body["rows"], [])
        self.assertIsNone(body["totals"])
        self.assertTrue(any("No staff payroll has been generated" in n for n in body["notes"]))

    def test_the_status_filter_defaults_to_everyone_with_a_payroll(self):
        self.assertIn("30071", by_code(self.get()))
        self.assertNotIn("30071", by_code(self.get(employeeStatus="active")))
        self.assertEqual(set(by_code(self.get(employeeStatus="inactive"))), {"30071"})
        # the 'no payroll yet' count is about ACTIVE staff whatever the filter says
        for status in ("all", "active", "inactive"):
            self.assertTrue(
                any(n.startswith("2 active staff member(s)") for n in self.get(employeeStatus=status)["notes"]), status
            )

    def test_the_scope_filters_narrow_the_statement_like_its_own_filters(self):
        dept = self.get(departmentIds=str(self.accounts.id))
        self.assertEqual([r["code"] for r in data_rows(dept)], ["2316", "2896", "30071"])
        self.assertEqual([r["sno"] for r in data_rows(dept)], [1, 2, 3])
        self.assertEqual(headings(dept), ["Accounts"])
        self.assertEqual(set(by_code(self.get(designationIds=str(self.des_op.id)))), {"189", "226", "3000", "5000"})
        self.assertEqual(list(by_code(self.get(employeeIds=str(self.lokesh.id)))), ["2896"])
        self.assertEqual(set(by_code(self.get(branchIds=str(self.b2.id)))), {"3000", "5000"})
        statement = self.statement(f"&departmentId={self.accounts.id}")
        self.assertEqual(by_code(dept)["2896"]["net"], self.statement_rows(statement)["2896"]["net"])

    def test_the_payment_status_filter(self):
        Payroll.objects.filter(pk=self.payrolls["2316"].pk).update(status=Payroll.STATUS_PAID)
        self.assertEqual(list(by_code(self.get(paymentStatus="paid"))), ["2316"])
        self.assertEqual(len(data_rows(self.get(paymentStatus="pending"))), 6)
        self.get(paymentStatus="nonsense", expect=400)


# ═════════════════════════════════════════════════════════════════════════════
# Branch isolation
# ═════════════════════════════════════════════════════════════════════════════


class BranchTests(_World):
    def test_a_branch_user_sees_only_their_own_unit_and_the_statements_numbers_for_it(self):
        body = self.get(user=self.branch_user)
        self.assertEqual([r["code"] for r in data_rows(body)], ["2316", "2896", "30071", "189", "226"])
        self.assertEqual(headings(body), ["Accounts", "Admin"])  # no 'Admin (Unit 1)': the other Admin is not visible
        # a unit login sees its own unit: one band and no unit total (it would only repeat the grand total)
        self.assertEqual(bands(body), ["U1 – Unit 1   5 employees"])
        self.assertEqual(unit_totals(body), {})
        expected = self.statement_rows(self.statement(user=self.branch_user))
        for code, row in by_code(body).items():
            self.assertEqual(row["net"], expected[code]["net"], code)
        self.assertEqual([r["sno"] for r in data_rows(body)], [1, 2, 3, 4, 5])

    def test_a_branch_user_cannot_widen_their_scope_with_a_parameter(self):
        for params in (
            {"branchIds": str(self.b2.id)},
            {"employeeIds": ",".join(str(e.id) for e in self.everyone if e.branch_id == self.b2.id)},
            {"departmentIds": str(self.cutting.id)},
        ):
            self.assertEqual(self.get(user=self.branch_user, **params)["rows"], [], params)

    def test_the_other_units_people_never_reach_the_notes_totals_or_exports(self):
        body = self.get(user=self.branch_user)
        # of the two staff without a payroll only Unit 1's 4000 is in this login's scope
        self.assertTrue(any(n.startswith("1 active staff member(s)") for n in body["notes"]), body["notes"])
        for key in PRINTED_TOTALS:
            self.assertAlmostEqual(body["totals"][key], round(sum(r[key] for r in data_rows(body)), 2), 2)
        ws = load_workbook(io.BytesIO(self.export("xlsx", user=self.branch_user).content)).active
        cells = " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)
        self.assertIn("MEENATCHI", cells)
        for hidden in ("CHITRA", "RAJA", "Cutting", "Unit 2"):
            self.assertNotIn(hidden, cells)

    def test_a_branch_user_gets_no_branch_filter(self):
        catalog = self.client.get("/api/reports/catalog", **hdr(self.branch_user)).json()
        report = next(r for r in catalog["reports"] if r["id"] == RID)
        self.assertNotIn("branch", [f["key"] for f in report["filters"]])


# ═════════════════════════════════════════════════════════════════════════════
# Exports
# ═════════════════════════════════════════════════════════════════════════════


class ExportTests(_World):
    def test_excel_is_the_screen_cell_for_cell(self):
        screen = self.get()
        r = self.export("xlsx")
        self.assertRegex(r["Content-Disposition"], r'filename="salary_statement_\d{8}_\d{4}\.xlsx"')
        ws = load_workbook(io.BytesIO(r.content)).active
        self.assertEqual([c.value for c in ws[HEADER_ROW]], LABELS)  # April has an advance: the Advance column is there
        self.assertEqual([c["label"] for c in screen["columns"]], LABELS)
        merged = {str(m) for m in ws.merged_cells.ranges}
        band_end = get_column_letter(len(KEYS) - 1)  # a band spans every column but Unit
        # the file has the screen's lines in order, with a blank row between departments and before a further unit
        filled = [
            n
            for n in range(HEADER_ROW + 1, ws.max_row + 1)
            if any(ws.cell(row=n, column=k + 1).value is not None for k in range(len(KEYS)))
        ]
        for i, row in enumerate(screen["rows"]):
            n = filled[i]
            excel = [ws.cell(row=n, column=k + 1).value for k in range(len(KEYS))]
            if row.get("_kind") == "total" and row["net"] is None:
                # a unit's band: one merged, filled cell over the statement's columns, its unit in the Unit column
                self.assertEqual(excel[0], row["name"], i)
                self.assertEqual(excel[-1], row["unit"], i)
                self.assertIn(f"A{n}:{band_end}{n}", merged)
                self.assertEqual(ws.cell(row=n, column=1).fill.fgColor.rgb[-6:], "E0E7FF")
                continue
            for k, key in enumerate(KEYS):
                want = row[key]
                got = excel[k]
                if isinstance(want, float):
                    self.assertAlmostEqual(got, want, 2, (i, key))
                else:
                    self.assertEqual(got if got != "" else None, want if want != "" else None, (i, key))
        total_row = [c.value for c in ws[filled[len(screen["rows"])]]]
        self.assertEqual(total_row[0], "TOTAL")
        self.assertEqual(total_row[KEYS.index("name")], "7 employees in 2 units")
        self.assertIsNone(total_row[KEYS.index("unit")])  # filtering one unit hides the grand total
        self.assertAlmostEqual(total_row[KEYS.index("net")], screen["totals"]["net"], 2)
        cells = " ".join(str(c.value) for rw in ws.iter_rows() for c in rw if c.value is not None)
        self.assertIn("April 2026", cells)  # the filter echo in the sheet header
        self.assertIn("Amounts in ₹", cells)
        self.assertIn("Basic Salary is 50% of it and Other Allowance the other 50%", cells)

    def test_the_excel_filters_by_unit_and_prints_a3_one_page_wide(self):
        ws = load_workbook(io.BytesIO(self.export("xlsx").content)).active
        last = next(n for n in range(HEADER_ROW, ws.max_row + 1) if ws.cell(row=n, column=1).value == "TOTAL")
        self.assertEqual(ws.auto_filter.ref, f"A{HEADER_ROW}:{get_column_letter(len(KEYS))}{last}")
        self.assertEqual(ws.freeze_panes, f"D{HEADER_ROW + 1}")  # the header and SNO / ID NO / Name stay in view
        self.assertEqual((ws.page_setup.paperSize, ws.page_setup.orientation), (8, "landscape"))
        self.assertEqual(ws.page_setup.fitToWidth, 1)
        money = ws.cell(row=HEADER_ROW + 3, column=KEYS.index("net") + 1)  # band, heading, then Meenatchi
        self.assertIsInstance(money.value, float)
        self.assertNotIn("₹", money.number_format)  # no ₹ on every cell: the title row says "Amounts in ₹"
        self.assertEqual(ws.cell(row=HEADER_ROW + 3, column=1).font.sz, 11)

    def test_pdf_is_a_real_pdf(self):
        r = self.export("pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertRegex(r["Content-Disposition"], r'\.pdf"$')
        self.assertGreater(len(r.content), 2000)

    def test_a_blank_row_separates_the_departments_in_both_files(self):
        from .reporting.definitions.hr_reports_salary_statement_files import GAP

        ws = load_workbook(io.BytesIO(self.export("xlsx").content)).active
        names = {n: ws.cell(row=n, column=KEYS.index("name") + 1).value for n in range(HEADER_ROW + 1, ws.max_row + 1)}
        rows = {n: [c.value for c in ws[n]] for n in names}

        def at(text):
            return next(n for n, v in names.items() if v == text)

        # after a department's Sub total one empty row, then the next department
        accounts = at("Accounts Sub total")
        self.assertTrue(all(v is None for v in rows[accounts + 1]), rows[accounts + 1])
        self.assertEqual(names[accounts + 2], "Admin")
        # a unit's last Sub total keeps the unit total right under it; then one empty row before the next unit's band
        self.assertEqual(names[at("Admin Sub total") + 1], "U1 – Unit 1 total")
        unit_total = at("U1 – Unit 1 total")
        self.assertTrue(all(v is None for v in rows[unit_total + 1]))
        self.assertEqual(rows[unit_total + 2][0], "U2 – Unit 2   2 employees")
        # no blank row under the header or above the TOTAL
        self.assertIsNotNone(rows[HEADER_ROW + 1][0])
        total = next(n for n, v in rows.items() if v[0] == "TOTAL")
        self.assertEqual(names[total - 1], "U2 – Unit 2 total")

        # the PDF draws the same lines: a blank row (as tall as a one-line row, no ruling) in the same places
        from .reporting.definitions import hr_reports_salary_statement_files as F

        kinds = [line.kind for line in F.statement_lines(self._blocks(), S.SUM_KEYS, {"net": 1.0})]
        self.assertEqual(kinds.count(GAP), 3)  # Accounts | Admin, Unit 1 | Unit 2, Admin | Cutting, and nowhere else
        for i, kind in enumerate(kinds):
            if kind == GAP:
                self.assertIn(kinds[i - 1], (F.SUB, F.UNIT_TOTAL))
                self.assertIn(kinds[i + 1], (F.HEADING, F.BAND))
        self.assertNotEqual(kinds[0], GAP)
        self.assertEqual(kinds[-2:], [F.UNIT_TOTAL, F.GRAND])

    def _blocks(self):
        from .payroll_insights import KIND_STAFF, staff_period
        from .payroll_statement_views import statement_rows

        payrolls = list(
            Payroll.objects.select_related(*S.PAYROLL_RELATIONS).filter(salary_mode="monthly", month=MONTH, year=YEAR)
        )
        values, _a, _b = statement_rows(payrolls, KIND_STAFF, staff_period(MONTH, YEAR))
        return S.unit_blocks(payrolls, values)

    def test_the_pdf_is_unit_by_unit_in_bigger_type(self):
        import pdfplumber

        with pdfplumber.open(io.BytesIO(self.export("pdf").content)) as pdf:
            page = pdf.pages[0]
            text = re.sub(r"\s+", " ", page.extract_text().replace("\xa0", " "))
            name = [w for w in page.extract_words(extra_attrs=["size"]) if w["text"] == "MEENATCHI"]
            self.assertEqual(round(page.width), 1191)  # A3 landscape, as before
        for line in ("U1 – Unit 1 5 employees", "U1 – Unit 1 total", "U2 – Unit 2 2 employees", "U2 – Unit 2 total"):
            self.assertIn(line, text)
        self.assertIn("TOTAL 7 employees in 2 units", text)
        self.assertIn("Amounts in ₹", text)
        # the title band, then straight away the column headers: no summary cards
        for card in ("Employees listed", "Total Salary ₹", "Earned Salary ₹", "Net Pay"):
            self.assertNotIn(card, text, card)
        self.assertLess(text.index("SALARY STATEMENT"), text.index("SNO"))
        self.assertNotIn("₹ 28,", text)  # amounts carry no ₹ on every cell
        # a seven-line statement gets the largest type (it used to be 6 pt for any statement)
        self.assertTrue(name)
        self.assertGreaterEqual(name[0]["size"], 9.5)

    def test_the_export_is_audited(self):
        from .models import AuditLog

        before = AuditLog.objects.count()
        self.export("xlsx")
        self.assertEqual(AuditLog.objects.count(), before + 1)
        self.assertIn("Salary Statement", AuditLog.objects.order_by("-id").first().record_description)


# ═════════════════════════════════════════════════════════════════════════════
# Cost and safety
# ═════════════════════════════════════════════════════════════════════════════


class CostAndSafetyTests(_World):
    def _queries(self, **params) -> int:
        params = {"period": PERIOD, **params}
        self.client.get(f"/api/reports/run/{RID}", params, **hdr(self.admin))  # warm-up (permission caches)
        with CaptureQueriesContext(connection) as q:
            r = self.client.get(f"/api/reports/run/{RID}", params, **hdr(self.admin))
        self.assertEqual(r.status_code, 200)
        return len(q)

    def test_the_query_count_does_not_grow_with_the_number_of_employees(self):
        before = self._queries()
        for i in range(10):
            emp = self.staff_maker(
                f"7{i:03d}", f"EXTRA{i}", (self.accounts, self.admin_d, self.cutting)[i % 3], self.b1, "20000"
            )
            for d in WORKING:
                day(emp, d)
            _generate_staff_payroll(emp, MONTH, YEAR)
            if i % 2:
                self.staff_maker(f"8{i:03d}", f"NOPAY{i}", self.accounts, self.b1, "9000")
        self.assertEqual(self._queries(), before)
        self.assertEqual(len(data_rows(self.get())), 17)

    def test_running_and_exporting_never_writes(self):
        def counts():
            return {
                m.__name__: m.objects.count()
                for m in apps.get_app_config("api").get_models()
                if m.__name__ != "AuditLog"  # an export is supposed to leave an audit entry
            }

        payrolls = list(Payroll.objects.order_by("id").values())
        slips = [
            (s.id, s.net_salary, s.total_deductions, s.breakdown_details) for s in SalarySlip.objects.order_by("id")
        ]
        before = counts()
        self.get()  # the HR login row exists from here on
        with CaptureQueriesContext(connection) as q:
            self.get()
            self.get(employeeStatus="active")
            self.export("pdf")
        written = [
            x["sql"][:100]
            for x in q.captured_queries
            if re.match(r"\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b", x["sql"], re.I)
            and "audit_log" not in x["sql"].lower()
        ]
        self.assertEqual(written, [])
        self.export("xlsx")
        self.assertEqual(counts(), before)
        self.assertEqual(list(Payroll.objects.order_by("id").values()), payrolls)
        self.assertEqual(
            [(s.id, s.net_salary, s.total_deductions, s.breakdown_details) for s in SalarySlip.objects.order_by("id")],
            slips,
        )

    def test_photo_and_password_columns_are_never_selected(self):
        with CaptureQueriesContext(connection) as q:
            self.get()
        for query in q.captured_queries:
            sql = query["sql"]
            self.assertNotIn("photo_url", sql)
            if '"hr_users"' not in sql:
                self.assertNotIn("password_hash", sql)

    def test_an_export_over_the_row_limit_is_refused_not_cut(self):
        with patch("api.reporting.runner.XLSX_ROW_LIMIT", 3):
            r = self.client.get(f"/api/reports/export/{RID}", {"fmt": "xlsx", "period": PERIOD}, **hdr(self.admin))
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"], "too_many_rows")


# ═════════════════════════════════════════════════════════════════════════════
# PF, ESI & TDS details (owner 2026-11-04: the PF / ESI / TDS deductions must be plain in the PDF and the Excel)
# ═════════════════════════════════════════════════════════════════════════════


def _rule(rule_id, low, high, rate, basis="first_portion"):
    return {"id": rule_id, "label": rule_id, "basis": basis, "minAmount": low, "maxAmount": high, "ratePercent": rate}


class StatutorySectionTests(TestCase):
    """April 2026: Kavin (Co Emp: PF 8% and ESI 10% of the first portion), Divya (on the TDS list at 10%) and Arun
    (neither), all present every working day."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        for key, value in {
            "attendance_mode": "simple",
            "late_deduction_slabs": [],
            "compensation_feature_enabled": True,
            "staff_pf_rules": [_rule("pf", 0, 25000, 8)],
            "staff_esi_rules": [_rule("esi", 0, 30000, 10)],
        }.items():
            setattr(ps, key, value)
        ps.save()
        cls.dept = Department.objects.create(name="Accounts")

        def staff(code, first, salary, **kw):
            emp = Employee.objects.create(
                employee_code=code, first_name=first, last_name="S", employment_type="staff", status="active",
                salary_type="monthly", salary_amount=Decimal(salary), department=cls.dept, **kw,
            )  # fmt: skip
            for d in WORKING:
                day(emp, d)
            return emp

        cls.kavin = staff("701", "KAVIN", "20000", co_emp_enabled=True)
        cls.divya = staff("702", "DIVYA", "30000", tds_enabled=True, tds_percent=Decimal("10"))
        cls.arun = staff("703", "ARUN", "18000")
        for emp in (cls.kavin, cls.divya, cls.arun):
            _generate_staff_payroll(emp, MONTH, YEAR)
        cls.admin = HRUser.objects.create(
            username="st_admin", password_hash="x", is_super_admin=True, full_name="Meena"
        )

    def export(self, fmt):
        r = self.client.get(f"/api/reports/export/{RID}", {"fmt": fmt, "period": PERIOD}, **hdr(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r

    def section_rows(self):
        ws = load_workbook(io.BytesIO(self.export("xlsx").content))["PF ESI TDS"]
        values = [[c.value for c in row] for row in ws.iter_rows()]
        header = values.index(next(v for v in values if v[0] == "SNO"))
        cols = values[header]
        rows = [dict(zip(cols, v)) for v in values[header + 1 :] if isinstance(v[0], int)]
        total = next(v for v in values if v[0] == "TOTAL")
        return cols, rows, dict(zip(cols, total)), values

    def test_the_excel_has_a_sheet_with_every_pf_esi_and_tds_line(self):
        wb = load_workbook(io.BytesIO(self.export("xlsx").content))
        self.assertEqual(wb.sheetnames, ["Salary Statement", "PF ESI TDS"])
        cols, rows, total, values = self.section_rows()
        self.assertEqual(
            cols,
            [
                "SNO", "ID NO", "Name", "Department", "Covered by", "PF / ESI wages", "PF %", "PF", "ESI %", "ESI",
                "TDS %", "TDS on (pay earned)", "TDS", "PF + ESI + TDS", "How it was worked out", "Unit",
            ],
        )  # fmt: skip
        self.assertEqual([r["ID NO"] for r in rows], ["701", "702"])  # Arun has none of the three: not listed
        self.assertEqual([r["Unit"] for r in rows], ["Other", "Other"])  # nobody here has a unit
        self.assertEqual(values[3][0], "Other – no unit set   2 employees")  # the unit's band under the header
        slip = SalarySlip.objects.get(employee=self.kavin, month=MONTH, year=YEAR)
        kavin = rows[0]
        self.assertEqual((kavin["Covered by"], kavin["PF %"], kavin["ESI %"]), ("Co Emp", 8, 10))
        self.assertAlmostEqual(kavin["PF"], float(slip.pf_deduction), 2)
        self.assertAlmostEqual(kavin["ESI"], float(slip.esi_deduction), 2)
        self.assertGreater(kavin["PF"], 0)
        self.assertAlmostEqual(kavin["PF / ESI wages"], 10000, 2)  # the first 50% of 20,000, all days paid
        self.assertIn("PF 8% of Basic + DA + Retaining Allowance", kavin["How it was worked out"])
        divya = rows[1]
        payroll = Payroll.objects.get(employee=self.divya, month=MONTH, year=YEAR)
        self.assertEqual((divya["Covered by"], divya["TDS %"]), ("TDS list", 10))
        self.assertAlmostEqual(divya["TDS"], float(payroll.tds_deduction), 2)
        self.assertGreater(divya["TDS"], 0)
        self.assertIn(divya["PF"], (0, None))
        self.assertAlmostEqual(total["PF"], kavin["PF"], 2)
        self.assertAlmostEqual(total["ESI"], kavin["ESI"], 2)
        self.assertAlmostEqual(total["TDS"], divya["TDS"], 2)
        self.assertAlmostEqual(total["PF + ESI + TDS"], kavin["PF"] + kavin["ESI"] + divya["TDS"], 2)
        notes = " ".join(str(v[0]) for v in values if v and isinstance(v[0], str))
        self.assertIn("2 of the 3 employees on this statement have PF, ESI or TDS: 1 in Co Emp", notes)

    def test_the_section_agrees_with_the_statements_own_columns(self):
        wb = load_workbook(io.BytesIO(self.export("xlsx").content))
        main = wb["Salary Statement"]
        labels = [c.value for c in main[HEADER_ROW]]
        lines = {
            r[labels.index("ID NO")]: r
            for r in main.iter_rows(min_row=HEADER_ROW + 1, values_only=True)
            if isinstance(r[0], int)
        }
        _cols, rows, _total, _values = self.section_rows()
        for r in rows:
            line = lines[r["ID NO"]]
            for key in ("PF", "ESI", "TDS"):
                self.assertAlmostEqual(line[labels.index(key)] or 0, r[key] or 0, 2, (r["ID NO"], key))

    def test_the_pdf_has_the_section_on_a_page_of_its_own(self):
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(self.export("pdf").content))
        last = reader.pages[-1].extract_text()
        self.assertIn("PF, ESI & TDS DETAILS", last)
        self.assertIn("KAVIN", last)
        self.assertIn("DIVYA", last)
        self.assertNotIn("PF, ESI & TDS DETAILS", reader.pages[0].extract_text())

    def test_the_screen_keeps_the_printed_statement_only(self):
        r = self.client.get(f"/api/reports/run/{RID}", {"period": PERIOD}, **hdr(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r.json()["sections"], [])

    def test_with_nobody_covered_the_section_says_so(self):
        Employee.objects.update(co_emp_enabled=False, tds_enabled=False, tds_percent=None)
        for emp in Employee.objects.all():
            _generate_staff_payroll(emp, MONTH, YEAR)
        ws = load_workbook(io.BytesIO(self.export("xlsx").content))["PF ESI TDS"]
        text = " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)
        self.assertIn("No employee on this statement is in Co Emp or on the TDS list", text)


# ═════════════════════════════════════════════════════════════════════════════
# Unit by unit (owner 2026-11-04: "split the records by their units, the same way as the Late Detection exports")
# ═════════════════════════════════════════════════════════════════════════════


class UnitTests(_World):
    def test_each_unit_total_adds_up_its_own_lines(self):
        body = self.get()
        units = unit_totals(body)
        self.assertEqual(sorted(units), ["U1", "U2"])
        for unit, total in units.items():
            mine = [r for r in data_rows(body) if r["unit"] == unit]
            for key in PRINTED_TOTALS:
                self.assertAlmostEqual(total[key], round(sum(r[key] for r in mine), 2), 2, (unit, key))
        for key in PRINTED_TOTALS:
            self.assertAlmostEqual(body["totals"][key], round(sum(u[key] for u in units.values()), 2), 2, key)

    def test_a_department_of_another_unit_working_here_is_told_apart(self):
        # Velu belongs to Unit 2 but sits in Unit 1's Admin department: Unit 2 now has two departments called Admin
        velu = self.staff_maker("6000", "VELU", self.admin_d, self.b2, "15000")
        for d in WORKING:
            day(velu, d)
        _generate_staff_payroll(velu, MONTH, YEAR)
        body = self.get()
        self.assertEqual(headings(body), ["Accounts", "Admin", "Admin (Unit 1)", "Admin (Unit 2)", "Cutting"])
        self.assertEqual(by_code(body)["6000"]["unit"], "U2")
        self.assertEqual([r["sno"] for r in data_rows(body) if r["unit"] == "U2"], [1, 2, 3])  # still in order
        self.assertEqual(bands(body)[1], "U2 – Unit 2   3 employees")

    def test_staff_with_no_unit_come_last_under_other(self):
        nobody = self.staff_maker("6100", "NOUNIT", self.accounts, None, "12000")
        for d in WORKING:
            day(nobody, d)
        _generate_staff_payroll(nobody, MONTH, YEAR)
        body = self.get()
        self.assertEqual(bands(body)[-1], "Other – no unit set   1 employee")
        self.assertEqual(data_rows(body)[-1]["code"], "6100")
        self.assertEqual((data_rows(body)[-1]["sno"], data_rows(body)[-1]["unit"]), (1, "Other"))

    def test_the_head_office_comes_first(self):
        Branch.objects.filter(pk=self.b2.pk).update(is_head_office=True)
        body = self.get()
        self.assertEqual(bands(body), ["HO – Unit 2   2 employees", "U1 – Unit 1   5 employees"])
        self.assertEqual([r["code"] for r in data_rows(body)][:2], ["5000", "3000"])


class ContinuedBandTests(TestCase):
    """The PDF of a long statement: a unit that runs onto the next page starts it with a "(contd.)" band naming the
    department that carries on, and a band never ends a page on its own."""

    def _out_and_blocks(self):
        from types import SimpleNamespace

        def unit(key, label, branch, departments):
            groups, sno = [], 0
            for name, people in departments:
                rows = []
                for i in range(people):
                    sno += 1
                    rows.append({"values": {"sno": sno, "code": f"{label}{sno:03d}", "name": f"{label} PERSON {sno}",
                                            "designation": "OPERATOR", "net": 1000.0, "eSalary": 1000.0}})  # fmt: skip
                groups.append({"key": name, "label": name, "rows": rows})
            count = sum(p for _n, p in departments)
            total = {k: 0.0 for k in S.SUM_KEYS} | {"net": 1000.0 * count, "eSalary": 1000.0 * count}
            return S.UnitBlock(key, label, branch, groups, count, total)

        blocks = [
            unit("1", "HO", "Head Office", [("ADMIN", 30), ("WEAVING", 120)]),
            unit("2", "U-1", "Unit 1", [("CUTTING", 70)]),
        ]
        total = {k: 0.0 for k in S.SUM_KEYS} | {"net": 220000.0, "eSalary": 220000.0}
        out = SimpleNamespace(
            spec=registry.get_spec(RID), columns=list(S.COLUMNS), filters=[("Month", "April 2026")], summary=[],
            totals=total, notes=["A note."], sections=[], generated_at="2026-11-04 10:00", generated_by="Test",
            truncated=False,
        )  # fmt: skip
        return out, blocks

    def test_a_unit_running_onto_the_next_page_starts_it_with_a_contd_band(self):
        import pypdf

        from .reporting.definitions.hr_reports_salary_statement_files import statement_pdf

        out, blocks = self._out_and_blocks()
        reader = pypdf.PdfReader(io.BytesIO(statement_pdf(out, blocks)))
        pages = [re.sub(r"\s+", " ", p.extract_text().replace("\xa0", " ")) for p in reader.pages]
        self.assertGreaterEqual(len(pages), 4)
        self.assertIn("HO – Head Office", pages[0])
        self.assertIn("150 employees", pages[0])
        self.assertNotIn("(contd.)", pages[0])
        contd = [p for p in pages if "HO – Head Office (contd.)" in p]
        self.assertTrue(contd)
        # WEAVING runs over several pages: every page it continues on says so
        self.assertTrue(any("WEAVING (contd.)" in p for p in contd), contd[0][:300])
        # the second unit's band never ends a page: it shares its page with its first department heading and row
        first = next(i for i, p in enumerate(pages) if "U-1 – Unit 1" in p and "70 employees" in p)
        self.assertIn("CUTTING", pages[first])
        self.assertIn("U-1001", pages[first])
        later = [p for p in pages[first + 1 :] if "U-1" in p and "(contd.)" in p]
        self.assertTrue(later)  # 70 people do not fit what is left of that page
        self.assertIn("TOTAL 220 employees in 2 units", pages[-1])


class OwnerColumnTests(_World):
    """The owner's columns (2026-11-05)."""

    def test_the_days_add_up_to_the_month(self):
        for row in data_rows(self.get()):
            self.assertAlmostEqual(row["present"] + row["cl"] + row["hd"], row["totalDays"], 2, row["code"])
            self.assertEqual(row["companyDays"], len(WORKING), row["code"])  # 26 company days in April (no Sundays)
            self.assertAlmostEqual(row["totalDays"] + row["lop"], row["companyDays"], 2, row["code"])
            self.assertEqual(row["basic"] * 2, row["total"], row["code"])
            self.assertAlmostEqual(row["basic"] + row["otherSalary"], row["total"], 2, row["code"])
            self.assertAlmostEqual(
                row["pf"] + row["esi"] + row["tds"] + row["advance"] + row["others"], row["totalDeduction"], 2
            )
            self.assertAlmostEqual(row["eSalary"] - row["totalDeduction"], row["net"], 2, row["code"])

    def test_a_company_holiday_is_hd_not_present(self):
        holiday = WORKING[5]
        Holiday.objects.create(name="Company day", date=holiday, holiday_type="company")
        hari = self.staff_maker("6200", "HARI", self.accounts, self.b1, "26000")
        for d in WORKING:
            if d != holiday:
                day(hari, d)
        _generate_staff_payroll(hari, MONTH, YEAR)
        row = by_code(self.get())["6200"]
        self.assertEqual((row["present"], row["cl"], row["lop"], row["hd"], row["totalDays"]), (25.0, 0.0, 0.0, 1.0, 26.0))

    def test_the_advance_column_appears_only_with_an_advance(self):
        with_advance = self.get()
        self.assertIn("advance", [c["key"] for c in with_advance["columns"]])
        self.assertIn("advance", with_advance["totals"])
        none = self.get(branchIds=str(self.b2.id))  # Unit 2 repays no advance this month
        self.assertEqual([c["key"] for c in none["columns"]], [k for k in KEYS if k != "advance"])
        self.assertNotIn("advance", none["totals"])
        ws = load_workbook(io.BytesIO(self.export("xlsx", branchIds=str(self.b2.id)).content)).active
        self.assertNotIn("Advance", [c.value for c in ws[HEADER_ROW]])
        labels = [c.value for c in ws[HEADER_ROW]]
        self.assertEqual(labels[labels.index("TDS") + 1], "Others")  # PF, ESI, TDS, Others, Total Deduction
        self.assertEqual(labels[labels.index("PF") : labels.index("NET")], ["PF", "ESI", "TDS", "Others", "Total Deduction"])
