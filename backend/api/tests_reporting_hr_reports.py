"""
Report Center - HR Reports (category ``hr``): employee-confo-details.

One line per employee: code, name, department, designation, salary, assigned HOD, date of joining and shift.
"Today" is pinned to 2026-09-29 (a Tuesday) so every expected value is hand-derived and deterministic.

Run via: python manage.py test api.tests_reporting_hr_reports -v 2
"""

import io
from datetime import date, time
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    DepartmentManager,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    Role,
    ShiftTemplate,
)
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.definitions import hr_reports as H
from .reporting.export_xlsx import HEADER_ROW

TODAY = date(2026, 9, 29)  # Tuesday
RID = "employee-confo-details"
NA = "Not Assigned"
LABELS = [
    "Employee Code",
    "Name",
    "Department",
    "Designation",
    "Salary",
    "Assigned HOD",
    "Date of Joining",
    "Shift Assign",
]
KEYS = ["employeeCode", "employeeName", "department", "designation", "salary", "assignedHod", "joinDate", "shift"]


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def codes(body) -> list[str]:
    return [r["employeeCode"] for r in body["rows"]]


def cards(body) -> dict:
    return {c["label"]: c["value"] for c in body["summary"]}


class _World(TestCase):
    """Ten people across two units: every HOD / shift / salary / joining-date situation the report can meet."""

    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.d_cut1 = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.d_sew1 = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.d_cut2 = Department.objects.create(name="CUTTING", branch=cls.b2)
        cls.des_mgr = Designation.objects.create(title="Manager", department=cls.d_cut1, level="manager")
        cls.des_op = Designation.objects.create(title="Operator", department=cls.d_sew1, level="junior")

        def mk(code, first, last, **kw):
            return Employee.objects.create(employee_code=code, first_name=first, last_name=last, **kw)

        cls.e1 = mk(
            "E1", "Arun", "Kumar", employment_type="staff", branch=cls.b1, department=cls.d_cut1,
            designation=cls.des_mgr, join_date="2024-01-15", salary_amount=Decimal("30000"),
        )  # fmt: skip
        cls.e2 = mk(
            "E2", "Bala", "Devi", employment_type="production", branch=cls.b1, department=cls.d_sew1,
            designation=cls.des_op, join_date="2026-09-05", salary_per_shift=Decimal("500"), salary_type="weekly",
        )  # fmt: skip
        cls.e3 = mk(
            "E3", "Chitra", "Raj", employment_type="staff", branch=cls.b2, department=cls.d_cut2,
            join_date="05-09-2026", salary_amount=Decimal("4500"), salary_type="weekly",
        )  # fmt: skip
        cls.e4 = mk(
            "E4", "Dinesh", "Mani", employment_type="staff", status="inactive", branch=cls.b1,
            department=cls.d_sew1, designation=cls.des_op, join_date="2020-03-01", salary_amount=Decimal("25000"),
        )  # fmt: skip
        cls.e5 = mk(
            "E5", "Elango", "Raja", employment_type="contract", branch=cls.b1, department=cls.d_cut1,
            join_date="2025-06-10", salary_amount=Decimal("12000"),
        )  # fmt: skip
        cls.e6 = mk(
            "E6", "Farida", "Banu", employment_type="staff", branch=None, department=None, join_date="",
            salary_amount=Decimal("0"),
        )  # fmt: skip
        cls.e7 = mk(
            "E7", "Gopal", "Nair", employment_type="staff", branch=cls.b1, department=cls.d_sew1,
            designation=cls.des_op, join_date="soon",
        )  # fmt: skip
        cls.e8 = mk(
            "E8", "Hari", "Om", employment_type="production", branch=cls.b2, department=cls.d_cut2,
            join_date="2026-08-31",
        )  # fmt: skip
        cls.e10 = mk(
            "E10", "Jai", "Singh", employment_type="staff", branch=cls.b1, department=cls.d_cut1,
            join_date="2023-02-01", salary_amount=Decimal("1234567.5"),
        )  # fmt: skip

        # HODs: E1 heads SEWING, E10 heads CUTTING (Unit 1); an INACTIVE head covers CUTTING (Unit 2).
        cls.m1 = DepartmentManager.objects.create(employee=cls.e1)
        ManagerDepartmentAssignment.objects.create(manager=cls.m1, department=cls.d_sew1)
        cls.m10 = DepartmentManager.objects.create(employee=cls.e10)
        ManagerDepartmentAssignment.objects.create(manager=cls.m10, department=cls.d_cut1)
        m3 = DepartmentManager.objects.create(employee=cls.e3, is_active=False)
        ManagerDepartmentAssignment.objects.create(manager=m3, department=cls.d_cut2)

        # Shifts
        def shift(name, kind, start, end, branch=None):
            return ShiftTemplate.objects.create(
                name=name, shift_type=kind, start_time=start, end_time=end, branch=branch
            )

        cls.general = shift("General", "staff", time(9, 0), time(18, 0), cls.b1)
        cls.prod_a = shift("Production A", "production", time(8, 0), time(17, 0), cls.b1)
        cls.prod_b = shift("Production B", "production", time(14, 0), time(22, 0), cls.b1)

        def assign(emp, sh, start, end=None):
            return EmployeeShiftAssignment.objects.create(
                employee=emp, shift=sh, effective_from=start, effective_to=end
            )

        assign(cls.e1, cls.general, date(2024, 1, 15))
        assign(cls.e2, cls.prod_a, date(2026, 9, 5))
        assign(cls.e4, cls.general, date(2020, 3, 1))
        assign(cls.e5, cls.general, date(2026, 10, 5))  # starts after today
        assign(cls.e7, cls.general, date(2026, 1, 1), date(2026, 9, 1))  # ended before today
        assign(cls.e8, cls.prod_a, date(2026, 1, 1))  # two cover today: the later start wins
        assign(cls.e8, cls.prod_b, date(2026, 9, 15))
        assign(cls.e10, cls.general, date(2023, 2, 1), TODAY)  # last day is today: still in force

        # Users
        cls.admin = HRUser.objects.create(username="hr_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.salary_user = user("hr_salary", {"salary": "view"})
        cls.payroll_user = user("hr_payroll", {"payroll": "view"})
        cls.employees_user = user(
            "hr_employees", {"employees": "view", "attendance": "view", "user_management": "view"}
        )
        cls.plain_user = user("hr_plain", {})
        cls.branch_user = user("hr_branch", {"payroll": "view"}, branch=cls.b1)

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def get(self, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{RID}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, fmt, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{RID}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    def rows(self, **params) -> dict:
        return {r["employeeCode"]: r for r in self.get(**params)["rows"]}


# ═════════════════════════════════════════════════════════════════════════════
# Pure helpers
# ═════════════════════════════════════════════════════════════════════════════


class SalaryTextTests(SimpleTestCase):
    def emp(self, **kw):
        return Employee(**{"employment_type": "staff", **kw})

    def test_staff_is_paid_monthly_unless_the_record_says_weekly(self):
        self.assertEqual(H._salary_text(self.emp(salary_amount=Decimal("30000"))), "₹30,000.00 / month")
        self.assertEqual(
            H._salary_text(self.emp(salary_amount=Decimal("4500"), salary_type="weekly")), "₹4,500.00 / week"
        )
        self.assertEqual(
            H._salary_text(self.emp(salary_amount=Decimal("4500"), salary_type=" Weekly ")), "₹4,500.00 / week"
        )
        self.assertEqual(H._salary_text(self.emp(salary_amount=Decimal("100"), salary_type="")), "₹100.00 / month")

    def test_production_is_paid_per_shift_whatever_the_salary_type(self):
        for salary_type in ("monthly", "weekly"):
            emp = self.emp(
                employment_type="production", salary_per_shift=Decimal("450.5"), salary_type=salary_type,
                salary_amount=Decimal("99999"),
            )  # fmt: skip
            self.assertEqual(H._salary_text(emp), "₹450.50 / shift")

    def test_other_types_use_the_salary_amount(self):
        emp = self.emp(employment_type="contract", salary_amount=Decimal("12000"), salary_per_shift=Decimal("700"))
        self.assertEqual(H._salary_text(emp), "₹12,000.00 / month")

    def test_indian_digit_grouping(self):
        self.assertEqual(H._salary_text(self.emp(salary_amount=Decimal("1234567.5"))), "₹12,34,567.50 / month")

    def test_nothing_entered_is_blank_never_zero(self):
        self.assertIsNone(H._salary_text(self.emp()))
        self.assertIsNone(H._salary_text(self.emp(salary_amount=Decimal("0"))))
        self.assertIsNone(H._salary_text(self.emp(employment_type="production", salary_amount=Decimal("500"))))


# ═════════════════════════════════════════════════════════════════════════════
# Registration, catalog and access
# ═════════════════════════════════════════════════════════════════════════════


class CatalogAndAccessTests(_World):
    def test_the_report_is_registered_in_its_own_hr_category_with_the_requested_columns(self):
        spec = next(s for s in registry.all_specs() if s.id == RID)
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual((spec.title, spec.category), ("Employee Confo Details", "hr"))
        self.assertEqual([c.label for c in spec.columns], LABELS)
        self.assertEqual([c.key for c in spec.columns], KEYS)
        self.assertFalse(spec.super_admin_only)
        self.assertTrue(set(spec.modules) <= set(all_module_keys()), spec.modules)

    def test_the_catalog_has_an_hr_reports_group_holding_it(self):
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        group = next(c for c in body["categories"] if c["id"] == "hr")
        self.assertEqual(group["label"], "HR Reports")
        self.assertEqual(group["count"], 1)
        ids = [c["id"] for c in body["categories"]]
        self.assertEqual(ids.index("hr"), ids.index("employees") + 1)  # sits beside Employees
        report = next(r for r in body["reports"] if r["id"] == RID)
        self.assertEqual(report["category"], "hr")
        self.assertEqual([c["label"] for c in report["columns"]], LABELS)
        self.assertEqual(
            [(f["key"], f["kind"]) for f in report["filters"]],
            [
                ("branch", "branch"),
                ("department", "department"),
                ("designation", "designation"),
                ("employeeType", "select"),
                ("employee", "employee"),
                ("employeeStatus", "employeeStatus"),
            ],
        )
        kind = next(f for f in report["filters"] if f["key"] == "employeeType")
        self.assertTrue(kind["multi"])
        self.assertEqual(
            [(o["value"], o["label"]) for o in kind["options"]],
            [("staff", "Staff"), ("production", "Production"), ("other", "Other")],
        )
        status = next(f for f in report["filters"] if f["key"] == "employeeStatus")
        self.assertEqual(status["default"], "active")

    def test_salary_or_payroll_access_opens_it(self):
        for who in (self.salary_user, self.payroll_user, self.admin):
            self.assertEqual(codes(self.get(user=who))[:2], ["E1", "E2"], who.username)
            self.assertEqual(self.export("xlsx", user=who).status_code, 200)

    def test_a_role_without_salary_or_payroll_access_is_refused_everywhere(self):
        """The report prints salary, so 'employees' (or a reports-only grant) is not enough."""
        for who in (self.employees_user, self.plain_user):
            catalog = self.client.get("/api/reports/catalog", **hdr(who)).json()
            self.assertNotIn(RID, [r["id"] for r in catalog["reports"]], who.username)
            self.assertNotIn("hr", [c["id"] for c in catalog["categories"]], who.username)
            r = self.client.get(f"/api/reports/run/{RID}", **hdr(who))
            self.assertEqual(r.status_code, 403, who.username)
            self.assertEqual(r.json()["error"], "report_forbidden")
            for fmt in ("xlsx", "pdf"):
                r = self.client.get(f"/api/reports/export/{RID}", {"fmt": fmt}, **hdr(who))
                self.assertEqual(r.status_code, 403, (who.username, fmt))
                self.assertEqual(r.json()["error"], "report_forbidden")

    def test_it_needs_an_hr_login(self):
        self.assertEqual(self.client.get(f"/api/reports/run/{RID}").status_code, 401)
        emp = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.e1.id})}"}
        self.assertEqual(self.client.get(f"/api/reports/run/{RID}", **emp).status_code, 403)


# ═════════════════════════════════════════════════════════════════════════════
# What the rows say
# ═════════════════════════════════════════════════════════════════════════════


class RowTests(_World):
    def test_default_lists_active_employees_in_natural_code_order(self):
        body = self.get()
        # E10 sorts after E8 (a plain string sort would put it right after E1); E4 is inactive
        self.assertEqual(codes(body), ["E1", "E2", "E3", "E5", "E6", "E7", "E8", "E10"])
        self.assertEqual([c["key"] for c in body["columns"]], KEYS)
        self.assertIsNone(body["totals"])
        self.assertFalse(body["truncated"])

    def test_golden_rows(self):
        rows = self.rows()
        self.assertEqual(
            rows["E1"],
            {
                "employeeCode": "E1",
                "employeeName": "Arun Kumar",
                "department": "CUTTING",
                "designation": "Manager",
                "salary": "₹30,000.00 / month",
                "assignedHod": "Jai Singh",
                "joinDate": "2024-01-15",
                "shift": "General",
            },
        )
        self.assertEqual(
            rows["E2"],
            {
                "employeeCode": "E2",
                "employeeName": "Bala Devi",
                "department": "SEWING",
                "designation": "Operator",
                "salary": "₹500.00 / shift",
                "assignedHod": "Arun Kumar",
                "joinDate": "2026-09-05",
                "shift": "Production A",
            },
        )

    def test_assigned_hod_is_the_name_or_not_assigned(self):
        rows = self.rows(employeeStatus="all")
        self.assertEqual(rows["E1"]["assignedHod"], "Jai Singh")  # E1 works in CUTTING, which E10 heads
        self.assertEqual(rows["E2"]["assignedHod"], "Arun Kumar")
        self.assertEqual(rows["E4"]["assignedHod"], "Arun Kumar")  # an inactive employee still has one
        self.assertEqual(rows["E5"]["assignedHod"], "Jai Singh")
        self.assertEqual(rows["E7"]["assignedHod"], "Arun Kumar")
        self.assertEqual(rows["E10"]["assignedHod"], NA)  # the head of CUTTING has nobody above them
        self.assertEqual(rows["E3"]["assignedHod"], NA)  # the only head of CUTTING (Unit 2) is switched off
        self.assertEqual(rows["E6"]["assignedHod"], NA)  # no department, no individual assignment
        self.assertEqual(rows["E8"]["assignedHod"], NA)

    def test_an_individual_assignment_beats_department_coverage(self):
        ManagerEmployeeAssignment.objects.create(manager=self.m10, employee=self.e2)
        rows = self.rows()
        self.assertEqual(rows["E2"]["assignedHod"], "Jai Singh")  # E1 still holds SEWING as a whole
        self.assertEqual(rows["E7"]["assignedHod"], "Arun Kumar")

    def test_an_employee_carved_out_of_the_department_has_no_hod(self):
        from .models import ManagerEmployeeExclusion

        ManagerEmployeeExclusion.objects.create(manager=self.m1, employee=self.e7)
        self.assertEqual(self.rows()["E7"]["assignedHod"], NA)

    def test_an_inactive_hod_is_never_shown(self):
        self.m1.is_active = False
        self.m1.save()
        rows = self.rows()
        self.assertEqual(rows["E2"]["assignedHod"], NA)
        self.assertEqual(rows["E7"]["assignedHod"], NA)

    def test_the_shift_in_force_today_is_shown_by_the_engines_rule(self):
        rows = self.rows(employeeStatus="all")
        self.assertEqual(rows["E1"]["shift"], "General")
        self.assertEqual(rows["E4"]["shift"], "General")
        self.assertEqual(rows["E8"]["shift"], "Production B")  # of two covering today, the later start wins
        self.assertEqual(rows["E10"]["shift"], "General")  # its last day is today
        self.assertEqual(rows["E7"]["shift"], NA)  # ended on 1-Sep
        self.assertEqual(rows["E3"]["shift"], NA)  # never assigned
        self.assertEqual(rows["E6"]["shift"], NA)

    def test_a_shift_that_starts_later_is_shown_and_footnoted(self):
        body = self.get()
        self.assertEqual({r["employeeCode"]: r["shift"] for r in body["rows"]}["E5"], "General")
        self.assertTrue(any("1 employee(s) have no shift in force yet" in n for n in body["notes"]), body["notes"])

    def test_a_shift_that_ended_yesterday_is_not_assigned(self):
        EmployeeShiftAssignment.objects.filter(employee=self.e10).update(effective_to=date(2026, 9, 28))
        self.assertEqual(self.rows()["E10"]["shift"], NA)

    def test_the_next_scheduled_shift_is_the_earliest_one(self):
        EmployeeShiftAssignment.objects.create(employee=self.e3, shift=self.general, effective_from=date(2026, 11, 1))
        EmployeeShiftAssignment.objects.create(employee=self.e3, shift=self.prod_a, effective_from=date(2026, 10, 10))
        self.assertEqual(self.rows()["E3"]["shift"], "Production A")

    def test_salary_is_shown_with_its_unit(self):
        rows = self.rows(employeeStatus="all")
        self.assertEqual(rows["E1"]["salary"], "₹30,000.00 / month")
        self.assertEqual(rows["E2"]["salary"], "₹500.00 / shift")  # production: per shift, though its type says weekly
        self.assertEqual(rows["E3"]["salary"], "₹4,500.00 / week")
        self.assertEqual(rows["E5"]["salary"], "₹12,000.00 / month")
        self.assertEqual(rows["E10"]["salary"], "₹12,34,567.50 / month")
        self.assertIsNone(rows["E6"]["salary"])  # 0 means nothing entered
        self.assertIsNone(rows["E7"]["salary"])
        self.assertIsNone(rows["E8"]["salary"])  # a production employee with no rate per shift

    def test_joining_date_is_read_from_the_text_column(self):
        rows = self.rows()
        self.assertEqual(rows["E1"]["joinDate"], "2024-01-15")
        self.assertEqual(rows["E3"]["joinDate"], "2026-09-05")  # typed dd-mm-yyyy
        self.assertIsNone(rows["E6"]["joinDate"])  # blank
        self.assertIsNone(rows["E7"]["joinDate"])  # 'soon'

    def test_department_and_designation_gaps_read_plainly(self):
        rows = self.rows()
        self.assertEqual(rows["E6"]["department"], "Unassigned")
        self.assertIsNone(rows["E6"]["designation"])
        self.assertIsNone(rows["E3"]["designation"])
        self.assertEqual(rows["E3"]["employeeName"], "Chitra Raj")

    def test_summary_cards_and_notes(self):
        body = self.get()
        self.assertEqual(
            cards(body),
            {
                "Employees listed": 8, "Staff": 5, "Production": 2, "Other types": 1,
                "No HOD assigned": 4, "No shift assigned": 3,
            },
        )  # fmt: skip
        text = " ".join(body["notes"])
        for part in ("Salary is the amount", "rate per shift", "Assigned HOD", "Shift Assign", "29-Sep-2026"):
            self.assertIn(part, text)
        self.assertTrue(any("have no salary entered" in n for n in body["notes"]), body["notes"])
        self.assertTrue(any("joining date" in n for n in body["notes"]), body["notes"])

    def test_sensitive_columns_never_appear(self):
        body = self.get(employeeStatus="all")
        forbidden = {"bankName", "bankAccount", "bankIfsc", "idProof", "address", "pfNumber", "esiNumber", "uanNumber"}
        self.assertFalse({c["key"] for c in body["columns"]} & forbidden)
        for row in body["rows"]:
            self.assertEqual(set(row), set(KEYS))

    def test_no_employees_gives_an_empty_report_not_an_error(self):
        Employee.objects.all().delete()
        body = self.get()
        self.assertEqual(body["rows"], [])
        self.assertEqual(cards(body)["Employees listed"], 0)
        self.assertIsNone(body["totals"])


# ═════════════════════════════════════════════════════════════════════════════
# Filters
# ═════════════════════════════════════════════════════════════════════════════


class FilterTests(_World):
    def test_each_employee_type_on_its_own(self):
        self.assertEqual(codes(self.get(employeeType="staff")), ["E1", "E3", "E6", "E7", "E10"])
        self.assertEqual(codes(self.get(employeeType="production")), ["E2", "E8"])
        self.assertEqual(codes(self.get(employeeType="other")), ["E5"])

    def test_several_types_at_once(self):
        self.assertEqual(codes(self.get(employeeType="staff,production")), ["E1", "E2", "E3", "E6", "E7", "E8", "E10"])
        self.assertEqual(codes(self.get(employeeType="production,other")), ["E2", "E5", "E8"])
        self.assertEqual(
            codes(self.get(employeeType="staff,production,other")), codes(self.get())
        )  # all three = no type filter

    def test_other_types_are_listed_with_their_own_name_for_the_salary_unit(self):
        Employee.objects.create(
            employee_code="E11", first_name="Kala", last_name="Devi", employment_type="Trainee", status="active",
            salary_amount=Decimal("8000"),
        )  # fmt: skip
        rows = self.rows(employeeType="other")
        self.assertEqual(sorted(rows), ["E11", "E5"])
        self.assertEqual(rows["E11"]["salary"], "₹8,000.00 / month")

    def test_type_filter_combines_with_the_other_filters(self):
        self.assertEqual(codes(self.get(employeeType="staff", departmentIds=str(self.d_cut1.id))), ["E1", "E10"])
        self.assertEqual(codes(self.get(employeeType="staff", designationIds=str(self.des_op.id))), ["E7"])
        self.assertEqual(codes(self.get(employeeType="production", branchIds=str(self.b2.id))), ["E8"])
        self.assertEqual(codes(self.get(employeeType="staff", employeeIds=f"{self.e1.id},{self.e2.id}")), ["E1"])
        self.assertEqual(codes(self.get(employeeType="staff", employeeStatus="inactive")), ["E4"])

    def test_status_filter(self):
        self.assertEqual(codes(self.get(employeeStatus="inactive")), ["E4"])
        self.assertEqual(codes(self.get(employeeStatus="all")), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E10"])

    def test_the_chosen_filters_are_echoed_in_the_result(self):
        body = self.get(employeeType="staff,other", departmentIds=str(self.d_cut1.id))
        applied = {f["label"]: f["value"] for f in body["filters"]}
        self.assertEqual(applied["Employee type"], "Staff, Other")
        self.assertEqual(applied["Department"], "CUTTING")

    def test_repeats_blanks_and_spaces_in_the_type_list_are_harmless(self):
        self.assertEqual(codes(self.get(employeeType="production,,production ,")), ["E2", "E8"])
        self.assertEqual(codes(self.get(employeeType="")), codes(self.get()))

    def test_unknown_or_hostile_types_are_a_400_naming_the_field(self):
        for bad in ("contract", "Staff", "x" * 500, "staff;drop", "\u0000", "-1", "staff,bogus"):
            r = self.client.get(f"/api/reports/run/{RID}", {"employeeType": bad}, **hdr(self.admin))
            self.assertEqual(r.status_code, 400, repr(bad))
            self.assertEqual(r.json()["field"], "employeeType", repr(bad))

    def test_the_classic_employment_type_parameter_is_ignored_not_trusted(self):
        # this report declares its own type filter; the framework's staff|production one is not part of it
        self.assertEqual(codes(self.get(employmentType="production")), codes(self.get()))


# ═════════════════════════════════════════════════════════════════════════════
# Branch isolation
# ═════════════════════════════════════════════════════════════════════════════


class BranchIsolationTests(_World):
    def test_a_branch_user_sees_only_their_own_branch(self):
        body = self.get(user=self.branch_user)
        self.assertEqual(codes(body), ["E1", "E2", "E5", "E7", "E10"])  # Unit 1, active
        self.assertNotIn("Chitra", str(body))
        self.assertNotIn("Hari", str(body))

    def test_a_branch_user_cannot_widen_their_scope_with_a_parameter(self):
        for params in ({"branchIds": str(self.b2.id)}, {"employeeIds": f"{self.e3.id},{self.e8.id}"}):
            self.assertEqual(codes(self.get(user=self.branch_user, **params)), [], params)

    def test_a_branch_user_gets_no_branch_filter_and_a_scoped_export(self):
        catalog = self.client.get("/api/reports/catalog", **hdr(self.branch_user)).json()
        report = next(r for r in catalog["reports"] if r["id"] == RID)
        self.assertNotIn("branch", [f["key"] for f in report["filters"]])
        ws = load_workbook(io.BytesIO(self.export("xlsx", user=self.branch_user).content)).active
        cells = " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)
        self.assertNotIn("Chitra", cells)
        self.assertIn("Arun Kumar", cells)

    def test_the_branch_filter_narrows_an_unscoped_user(self):
        self.assertEqual(codes(self.get(branchIds=str(self.b2.id))), ["E3", "E8"])


# ═════════════════════════════════════════════════════════════════════════════
# Exports
# ═════════════════════════════════════════════════════════════════════════════


class ExportTests(_World):
    def test_excel_carries_the_same_columns_and_rows_as_the_screen(self):
        params = {"employeeType": "staff,production"}
        screen = self.get(**params)
        r = self.export("xlsx", **params)
        self.assertRegex(r["Content-Disposition"], r'filename="employee_confo_details_\d{8}_\d{4}\.xlsx"')
        ws = load_workbook(io.BytesIO(r.content)).active
        self.assertEqual([c.value for c in ws[HEADER_ROW]][:8], LABELS)
        for i, row in enumerate(screen["rows"]):
            got = [ws.cell(row=HEADER_ROW + 1 + i, column=n + 1).value for n in range(8)]
            self.assertEqual(got[0], row["employeeCode"])
            self.assertEqual(got[1], row["employeeName"])
            self.assertEqual(got[4] or None, row["salary"])
            self.assertEqual(got[5], row["assignedHod"])
            self.assertEqual(got[7], row["shift"])
        cells = " ".join(str(c.value) for rw in ws.iter_rows() for c in rw if c.value is not None)
        self.assertIn("Employee type", cells)  # the filter echo in the sheet header
        self.assertIn("Staff, Production", cells)

    def test_pdf_renders(self):
        r = self.export("pdf", employeeType="production")
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertRegex(r["Content-Disposition"], r'\.pdf"$')

    def test_the_export_is_audited(self):
        from .models import AuditLog

        before = AuditLog.objects.count()
        self.export("xlsx", employeeType="other")
        entry = AuditLog.objects.order_by("-id").first()
        self.assertEqual(AuditLog.objects.count(), before + 1)
        self.assertIn("Employee Confo Details", entry.record_description)
        self.assertIn("XLSX", entry.record_description)
        self.assertIn("Employee type: Other", entry.record_description)


# ═════════════════════════════════════════════════════════════════════════════
# Cost and safety
# ═════════════════════════════════════════════════════════════════════════════


class CostAndSafetyTests(_World):
    def _queries(self, **params) -> int:
        self.client.get(f"/api/reports/run/{RID}", params, **hdr(self.admin))  # warm-up (permission caches)
        with CaptureQueriesContext(connection) as q:
            r = self.client.get(f"/api/reports/run/{RID}", params, **hdr(self.admin))
        self.assertEqual(r.status_code, 200)
        return len(q)

    def test_the_query_count_does_not_grow_with_the_number_of_employees(self):
        before = self._queries(employeeStatus="all")
        for i in range(25):
            emp = Employee.objects.create(
                employee_code=f"X{i}", first_name=f"Xa{i}", last_name="Extra", employment_type=("staff", "production")[i % 2],
                branch=self.b1, department=(self.d_cut1, self.d_sew1)[i % 2], designation=self.des_op,
                join_date=f"2026-09-{i + 1:02d}", salary_amount=Decimal("1000"), salary_per_shift=Decimal("100"),
            )  # fmt: skip
            EmployeeShiftAssignment.objects.create(employee=emp, shift=self.general, effective_from=date(2026, 1, 1))
            if i % 3 == 0:
                ManagerEmployeeAssignment.objects.create(manager=self.m10, employee=emp)
        self.assertEqual(self._queries(employeeStatus="all"), before)
        self.assertEqual(len(self.get(employeeStatus="all")["rows"]), 9 + 25)

    def test_photo_and_password_columns_are_never_selected(self):
        with CaptureQueriesContext(connection) as q:
            self.get(employeeStatus="all")
            self.export("xlsx", employeeStatus="all")
        for query in q.captured_queries:
            sql = query["sql"]
            self.assertNotIn("photo_url", sql)
            if '"hr_users"' not in sql:  # the login lookup reads the HR user's own hash; nothing else may
                self.assertNotIn("password_hash", sql)

    def test_running_and_exporting_never_writes(self):
        from django.apps import apps

        def counts():
            return {
                m.__name__: m.objects.count()
                for m in apps.get_app_config("api").get_models()
                if m.__name__ != "AuditLog"  # an export is supposed to leave an audit entry
            }

        before = counts()
        self.get(employeeStatus="all")
        self.export("xlsx")
        self.export("pdf")
        self.assertEqual(counts(), before)

    def test_a_row_over_the_limit_is_refused_for_export_not_silently_cut(self):
        with patch("api.reporting.runner.XLSX_ROW_LIMIT", 3):
            r = self.client.get(f"/api/reports/export/{RID}", {"fmt": "xlsx"}, **hdr(self.admin))
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"], "too_many_rows")
