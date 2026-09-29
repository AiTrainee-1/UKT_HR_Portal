"""
Report Center - Employees & Manpower reports (group ``employees_master``).

Covers: employee-master, employee-contact-list, strength-statement, new-joinings, exits-register,
resignation-register, manpower-movement, statutory-compliance, data-quality-audit, birthdays,
work-anniversaries, service-milestones, age-compliance, workforce-profile, family-dependents, org-structure.

"Today" is pinned to 2026-09-29 (a Tuesday) so every expected number is hand-derived and deterministic.

Run via: python manage.py test api.tests_reporting_employees_master -v 2
"""

import io
from datetime import date, datetime, timedelta
from datetime import timezone as dt_tz
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .casual_leave_views import ELIGIBILITY_MONTHS, _service_months
from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    DepartmentHeadcount,
    DepartmentManager,
    Designation,
    Employee,
    EmployeeDocument,
    FamilyDependent,
    HRUser,
    ManagerDepartmentAssignment,
    ResignationRequest,
    Role,
    SalarySlip,
)
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.definitions import employees_master_base as B

TODAY = date(2026, 9, 29)  # Tuesday
MY_REPORTS = (
    "employee-master", "employee-contact-list", "strength-statement", "new-joinings", "exits-register",
    "resignation-register", "manpower-movement", "statutory-compliance", "data-quality-audit", "birthdays",
    "work-anniversaries", "service-milestones", "age-compliance", "workforce-profile", "family-dependents",
    "org-structure",
)  # fmt: skip


def utc(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=dt_tz.utc)


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def codes(body, key="employeeCode"):
    return [r[key] for r in body["rows"] if r.get("_kind") not in ("subtotal", "total")]


def cards(body):
    return {c["label"]: c["value"] for c in body["summary"]}


def data_rows(body):
    return [r for r in body["rows"] if r.get("_kind") not in ("subtotal", "total")]


class _World(TestCase):
    """Ten employees across two units (plus one legacy record with no branch / department)."""

    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.b3 = Branch.objects.create(name="Old Unit", code="OLD", is_active=False)
        cls.d_cut1 = Department.objects.create(name="CUTTING", branch=cls.b1)
        cls.d_sew1 = Department.objects.create(name="SEWING", branch=cls.b1)
        cls.d_cut2 = Department.objects.create(name="CUTTING", branch=cls.b2)  # same name, other unit
        cls.d_legacy = Department.objects.create(name="LEGACY", branch=None)
        cls.d_scrap = Department.objects.create(name="SCRAP", branch=cls.b3)
        cls.des_mgr = Designation.objects.create(title="Manager", department=cls.d_cut1, level="manager")
        cls.des_op = Designation.objects.create(title="Operator", department=cls.d_sew1, level="junior")
        cls.des_sup = Designation.objects.create(title="Supervisor", department=cls.d_sew1, level="senior")

        def mk(code, first, last, **kw):
            return Employee.objects.create(employee_code=code, first_name=first, last_name=last, **kw)

        cls.e1 = mk(
            "E1", "Arun", "Kumar", employment_type="staff", gender="male", branch=cls.b1, department=cls.d_cut1,
            designation=cls.des_mgr, join_date="2024-01-15", date_of_birth=date(1990, 3, 10), phone="9876543210",
            email="arun@example.com", emergency_contact="Ravi 9000000001", blood_group="O+", father_name="Kumar",
            address="12 Main St", salary_amount=Decimal("30000"), unit_code="U1-1", pf_number="TN/TPR/001",
            esi_number="1234567890", uan_number="100000000001", bank_name="HDFC", bank_account="5566778899001",
            bank_ifsc="HDFC0001234", id_proof="123412341234",
        )  # fmt: skip
        cls.e2 = mk(
            "E2", "Bala", "Devi", employment_type="production", gender="female", branch=cls.b1, department=cls.d_sew1,
            designation=cls.des_op, join_date="2026-09-05", date_of_birth=date(2001, 9, 29), phone="9876543211",
            blood_group="b+", address="45 Lake Rd", salary_per_shift=Decimal("500"), salary_type="weekly",
        )  # fmt: skip
        cls.e3 = mk(
            "E3", "Chitra", "Raj", employment_type="staff", gender="female", branch=cls.b2, department=cls.d_cut2,
            join_date="05-09-2026", date_of_birth=date(2000, 2, 29), phone="+91 98765 43212", father_name="Raj",
            pf_number="TN/TPR/002", esi_number="12345", uan_number="12345678901", bank_account="ABC123",
            bank_ifsc="BADIFSC",
        )  # fmt: skip
        cls.e4 = mk(
            "E4", "Dinesh", "Mani", employment_type="staff", gender="male", status="inactive", branch=cls.b1,
            department=cls.d_sew1, designation=cls.des_sup, join_date="2020-03-01", date_of_birth=date(1985, 7, 20),
            phone="9876543214", salary_amount=Decimal("25000"),
        )  # fmt: skip
        cls.e5 = mk(
            "E5", "Elango", "Raja", employment_type="production", gender="male", status="inactive", branch=cls.b1,
            department=cls.d_sew1, designation=cls.des_op, join_date="2025-06-10", date_of_birth=date(1992, 1, 1),
            phone="9876543215", salary_per_shift=Decimal("450"), salary_type="weekly",
        )  # fmt: skip
        cls.e6 = mk(
            "E6", "Farida", "Banu", employment_type="staff", gender="female", branch=None, department=None,
            join_date="2023-11-30", date_of_birth=date(1995, 12, 31), phone=None, address="9 Park St",
            father_name="Banu", blood_group="A+", emergency_contact="Salim 9000000006", salary_amount=Decimal("0"),
        )  # fmt: skip
        cls.e7 = mk(
            "E7", "Gopal", "Nair", employment_type="staff", gender=None, branch=cls.b1, department=cls.d_sew1,
            designation=cls.des_op, join_date="soon", date_of_birth=None, phone=None, salary_amount=Decimal("20000"),
            pf_number="PF-DUP-9",
        )  # fmt: skip
        cls.e8 = mk(
            "E8", "Hari", "Om", employment_type="production", gender="Male", branch=cls.b2, department=cls.d_cut2,
            join_date="2026-08-31", date_of_birth=date(2010, 5, 5), phone="9876543218", blood_group="AB-",
            esi_number="12345678901234567", uan_number="100000000008", bank_account="123456789",
            bank_ifsc="sbin0001234", salary_type="weekly",
        )  # fmt: skip
        cls.e9 = mk(
            "E9", "Indu", "Shree", employment_type="staff", gender="female", status="resigned", branch=cls.b2,
            department=cls.d_cut2, join_date="2019-01-01", date_of_birth=date(1980, 11, 11), phone="9876543219",
            salary_amount=Decimal("22000"),
        )  # fmt: skip
        cls.e10 = mk(
            "E10", "Jai", "Singh", employment_type="staff", gender="male", branch=cls.b1, department=cls.d_cut1,
            join_date="", date_of_birth=date(1960, 9, 1), phone="", address="7 Hill Rd", father_name="Singh",
            blood_group=" o+ ", salary_amount=Decimal("18000"), pf_number="pf dup 9",
        )  # fmt: skip
        # updated_at is auto_now: only .update() can pin it. It stands in for the (undated) manual-deactivation date.
        Employee.objects.filter(pk=cls.e5.pk).update(updated_at=utc(2026, 9, 10, 8, 0))
        Employee.objects.filter(pk=cls.e9.pk).update(updated_at=utc(2026, 1, 15, 20, 0))  # = 16-Jan 01:30 IST

        # HODs: E1 heads SEWING; E10 heads CUTTING (Unit 1); an INACTIVE HOD row covers CUTTING (Unit 2).
        m1 = DepartmentManager.objects.create(employee=cls.e1)
        ManagerDepartmentAssignment.objects.create(manager=m1, department=cls.d_sew1)
        m10 = DepartmentManager.objects.create(employee=cls.e10)
        ManagerDepartmentAssignment.objects.create(manager=m10, department=cls.d_cut1)
        m3 = DepartmentManager.objects.create(employee=cls.e3, is_active=False)
        ManagerDepartmentAssignment.objects.create(manager=m3, department=cls.d_cut2)
        DepartmentHeadcount.objects.create(department=cls.d_cut1, required_count=5)
        DepartmentHeadcount.objects.create(department=cls.d_sew1, required_count=1)
        DepartmentHeadcount.objects.create(department=cls.d_cut2, required_count=0)

        # Documents on file
        for cat in ("aadhaar_card", "pan_card", "bank_passbook"):
            cls.doc(cls.e1, cat)
        cls.doc(cls.e3, "aadhaar_card")

        # Payroll evidence for August 2026 (E8 is production: two weekly slips)
        SalarySlip.objects.create(
            employee=cls.e1, month=8, year=2026, slip_number="S-E1-08", pf_deduction=1800, esi_deduction=225
        )
        SalarySlip.objects.create(
            employee=cls.e8, month=8, year=2026, week_number=1, slip_number="S-E8-08-1", pf_deduction=60
        )
        SalarySlip.objects.create(
            employee=cls.e8, month=8, year=2026, week_number=2, slip_number="S-E8-08-2", pf_deduction=40
        )

        # Resignations
        def resign(emp, created, **kw):
            r = ResignationRequest.objects.create(employee=emp, **kw)
            ResignationRequest.objects.filter(pk=r.pk).update(created_at=created)
            return r

        cls.r1 = resign(
            cls.e4, utc(2026, 8, 10, 4, 0), reason="Better opportunity", last_working_date=date(2026, 8, 31),
            survey_q1_answer="Salary", survey_q2_answer="Yes", survey_q3_answer="Higher pay", status="approved",
            dept_head=cls.e1, dept_head_status="approved", dept_head_comment="Fine",
            dept_head_approved_at=utc(2026, 8, 12, 5, 0), hr_comment="OK", approved_by="HR Admin",
            approved_at=utc(2026, 8, 20, 10, 0),
        )  # fmt: skip
        cls.r2 = resign(
            cls.e1, utc(2026, 9, 20, 20, 0), reason="Relocation", last_working_date=date(2026, 10, 31),
            status="pending",
        )  # 21-Sep 01:30 IST
        cls.r3 = resign(
            cls.e3, utc(2026, 9, 1, 5, 0), reason="Health", status="rejected", rejected_by="dept_head",
            dept_head=cls.e10, dept_head_status="rejected", dept_head_approved_at=utc(2026, 9, 3, 5, 0),
        )  # fmt: skip
        cls.r4 = resign(
            cls.e7, utc(2026, 9, 15, 6, 0), reason="Studies", status="dept_approved", dept_head=cls.e1,
            dept_head_status="approved",
        )  # fmt: skip
        cls.r5 = resign(
            cls.e6, utc(2026, 9, 25, 6, 0), reason="Personal", status="rejected", rejected_by="hr",
            hr_comment="Not now",
        )  # fmt: skip

        # Users
        full = {"reports": "view", "employees": "view", "recruitment": "view", "casual_leave": "view", "payroll": "view"}
        cls.admin = HRUser.objects.create(username="em_admin", password_hash="x", is_super_admin=True)
        cls.role_full = Role.objects.create(name="em_full", permissions=full)
        cls.branch_user = HRUser.objects.create(username="em_b1", password_hash="x", role=cls.role_full, branch=cls.b1)
        cls.plain_user = HRUser.objects.create(
            username="em_plain", password_hash="x", role=Role.objects.create(name="em_plain", permissions={"reports": "view"})
        )
        cls.no_salary_user = HRUser.objects.create(
            username="em_nosal",
            password_hash="x",
            role=Role.objects.create(
                name="em_nosal", permissions={"reports": "view", "employees": "view", "recruitment": "view"}
            ),
        )

    @staticmethod
    def doc(emp, category):
        return EmployeeDocument.objects.create(
            employee=emp, category=category, file="employee_documents/x.pdf", original_filename="x.pdf"
        )

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        self.mock_today = p.start()
        self.addCleanup(p.stop)

    # -- helpers ---------------------------------------------------------------------------
    def get(self, rid, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, rid, fmt, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    def make(self, code, **kw):
        base = dict(first_name=code, last_name="Extra", employment_type="staff", status="active")
        base.update(kw)
        return Employee.objects.create(employee_code=code, **base)


# ═════════════════════════════════════════════════════════════════════════════
# Pure helpers
# ═════════════════════════════════════════════════════════════════════════════


class HelperTests(SimpleTestCase):
    def test_natural_code_order(self):
        codes_ = ["E10", "E2", "E1", "A9", "E02", "e3"]
        self.assertEqual(sorted(codes_, key=B.code_key), ["A9", "E1", "E02", "E2", "e3", "E10"])

    def test_age_and_tenure(self):
        self.assertEqual(B.age_on(date(2001, 9, 29), TODAY), 25)  # birthday today counts
        self.assertEqual(B.age_on(date(2001, 9, 30), TODAY), 24)
        self.assertEqual(B.age_on(date(2000, 2, 29), date(2026, 2, 28)), 25)  # leap-day baby, day before
        self.assertIsNone(B.age_on(date(2030, 1, 1), TODAY))  # future DOB
        self.assertIsNone(B.age_on(None, TODAY))
        self.assertEqual(B.months_between(date(2024, 1, 15), TODAY), 32)
        self.assertEqual(B.months_between(date(2023, 11, 30), TODAY), 33)
        self.assertEqual(B.tenure_text(32), "2y 8m")
        self.assertEqual(B.tenure_text(24), "2y")
        self.assertEqual(B.tenure_text(5), "5m")
        self.assertEqual(B.tenure_text(0), "<1m")
        self.assertIsNone(B.tenure_text(None))

    def test_add_months_clamps_to_month_end(self):
        self.assertEqual(B.add_months(date(2026, 8, 31), 6), date(2027, 2, 28))
        self.assertEqual(B.add_months(date(2023, 11, 30), 3), date(2024, 2, 29))
        self.assertEqual(B.add_months(date(2026, 11, 15), 3), date(2027, 2, 15))

    def test_casual_leave_date_agrees_with_the_casual_leave_engine(self):
        """clEligibleFrom must be the first day the app's own service-month rule reaches 6 months."""
        for joined in (
            date(2026, 3, 31), date(2026, 8, 31), date(2025, 8, 30), date(2024, 2, 29), date(2026, 1, 15),
            date(2026, 5, 31), date(2025, 12, 31),
        ):  # fmt: skip
            when = B.months_reached_on(joined, ELIGIBILITY_MONTHS)
            emp = Employee(join_date=joined.isoformat())
            self.assertGreaterEqual(_service_months(emp, when), ELIGIBILITY_MONTHS, joined)
            self.assertLess(_service_months(emp, when - timedelta(days=1)), ELIGIBILITY_MONTHS, joined)

    def test_feb_29_anniversaries_and_year_wrap(self):
        self.assertEqual(B.occurrence_in_year(2, 29, 2027), date(2027, 2, 28))
        self.assertEqual(B.occurrence_in_year(2, 29, 2028), date(2028, 2, 29))
        start, end = date(2026, 12, 20), date(2027, 1, 18)
        self.assertEqual(B.occurrence_in_window(12, 31, start, end), date(2026, 12, 31))
        self.assertEqual(B.occurrence_in_window(1, 5, start, end), date(2027, 1, 5))
        self.assertIsNone(B.occurrence_in_window(1, 19, start, end))
        self.assertEqual(B.occurrence_in_window(2, 29, date(2026, 2, 1), date(2026, 2, 28)), date(2026, 2, 28))

    def test_window_choices(self):
        self.assertEqual(B.window_bounds("thisMonth", TODAY), (date(2026, 9, 1), date(2026, 9, 30)))
        self.assertEqual(B.window_bounds("nextMonth", date(2026, 12, 5)), (date(2027, 1, 1), date(2027, 1, 31)))
        self.assertEqual(B.window_bounds("next7", TODAY), (TODAY, date(2026, 10, 5)))
        self.assertEqual(B.window_bounds("next30", TODAY), (TODAY, date(2026, 10, 28)))
        self.assertEqual(B.window_bounds("m02", TODAY), (date(2026, 2, 1), date(2026, 2, 28)))

    def test_masking_and_blood_group(self):
        self.assertEqual(B.mask_tail("1234567890123"), "*********0123")
        self.assertEqual(B.mask_tail("12 34"), "****")
        self.assertEqual(B.mask_tail("abc"), "***")
        self.assertIsNone(B.mask_tail("  "))
        self.assertIsNone(B.mask_tail(None))
        self.assertEqual(B.blood_group_of(" o+ "), "O+")
        self.assertEqual(B.blood_group_of("ab -"), "AB-")
        self.assertIsNone(B.blood_group_of("Z"))
        self.assertIsNone(B.blood_group_of(None))

    def test_gender_and_status_buckets(self):
        self.assertEqual([B.gender_bucket(g) for g in ("Male", " FEMALE ", "other", "Non-binary", "", None)],
                         ["male", "female", "other", "other", "unspecified", "unspecified"])  # fmt: skip
        self.assertEqual(B.gender_label("male"), "Male")
        self.assertEqual(B.gender_label("Non-binary"), "Non-binary")
        self.assertIsNone(B.gender_label(" "))
        self.assertEqual(B.status_label("resigned"), "Resigned")
        self.assertEqual(B.status_label(""), "Unknown")

    def test_ist_bounds_use_the_factory_day(self):
        start, end = B.ist_bounds(date(2026, 9, 21), date(2026, 9, 21))
        self.assertEqual(start, datetime(2026, 9, 20, 18, 30, tzinfo=dt_tz.utc))  # IST midnight = 18:30 UTC previous day
        self.assertEqual(end - start, timedelta(days=1))
        self.assertEqual(B.ist_date(utc(2026, 9, 20, 20, 0)), date(2026, 9, 21))


# ═════════════════════════════════════════════════════════════════════════════
# Catalog / access
# ═════════════════════════════════════════════════════════════════════════════


class CatalogAndAccessTests(_World):
    def test_all_sixteen_reports_are_registered_in_the_employees_category(self):
        specs = {s.id: s for s in registry.all_specs()}
        self.assertEqual(registry.LOAD_ERRORS, {})
        for rid in MY_REPORTS:
            self.assertIn(rid, specs)
            s = specs[rid]
            self.assertEqual(s.category, "employees", rid)
            self.assertTrue(s.modules, rid)
            for m in s.modules:
                self.assertIn(m, all_module_keys(), rid)
            self.assertFalse(s.super_admin_only, rid)

    def test_celebrations_family_has_both_variants(self):
        specs = {s.id: s for s in registry.all_specs()}
        self.assertEqual((specs["birthdays"].family, specs["birthdays"].variant), ("celebrations", "Birthdays"))
        self.assertEqual(specs["work-anniversaries"].family, "celebrations")
        self.assertNotEqual(specs["birthdays"].variant, specs["work-anniversaries"].variant)

    def test_catalog_lists_them_for_an_authorised_role_and_hides_them_otherwise(self):
        ids = {r["id"] for r in self.client.get("/api/reports/catalog", **hdr(self.branch_user)).json()["reports"]}
        self.assertTrue(set(MY_REPORTS) <= ids)
        ids = {r["id"] for r in self.client.get("/api/reports/catalog", **hdr(self.plain_user)).json()["reports"]}
        self.assertFalse(set(MY_REPORTS) & ids)

    def test_a_reports_only_role_gets_403_report_forbidden_on_run_and_export(self):
        for rid in MY_REPORTS:
            r = self.client.get(f"/api/reports/run/{rid}", **hdr(self.plain_user))
            self.assertEqual(r.status_code, 403, rid)
            self.assertEqual(r.json()["error"], "report_forbidden", rid)
            for fmt in ("xlsx", "pdf"):
                r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt}, **hdr(self.plain_user))
                self.assertEqual(r.status_code, 403, (rid, fmt))
                self.assertEqual(r.json()["error"], "report_forbidden", (rid, fmt))

    def test_owning_module_grants(self):
        def user(name, perms):
            return HRUser.objects.create(
                username=name, password_hash="x", role=Role.objects.create(name=name, permissions={"reports": "view", **perms})
            )

        payroll_only = user("em_pay_only", {"payroll": "view"})
        resign_only = user("em_res_only", {"recruitment.resignations": "view"})
        employees_only = user("em_emp_only", {"employees": "view"})
        # Statutory numbers: payroll, salary or employees access is enough.
        self.get("statutory-compliance", user=payroll_only)
        self.get("statutory-compliance", user=employees_only)
        self.get("employee-master", user=payroll_only, expect=403)
        # Resignation requests belong to the recruitment.resignations module only ...
        self.get("resignation-register", user=resign_only)
        self.get("resignation-register", user=employees_only, expect=403)
        # ... while exits are visible with either the employees or the resignations module.
        self.get("exits-register", user=resign_only)
        self.get("exits-register", user=employees_only)
        # New joinings: employees or recruitment.new_joinees
        self.get("new-joinings", user=user("em_nj", {"recruitment.new_joinees": "view"}))


# ═════════════════════════════════════════════════════════════════════════════
# employee-master
# ═════════════════════════════════════════════════════════════════════════════


class EmployeeMasterTests(_World):
    RID = "employee-master"

    def test_default_lists_active_employees_in_natural_code_order(self):
        body = self.get(self.RID)
        # E10 comes after E8 (a plain string sort would put it right after E1)
        self.assertEqual(codes(body), ["E1", "E2", "E3", "E6", "E7", "E8", "E10"])
        self.assertIsNone(body["totals"])
        self.assertEqual(
            cards(body),
            {
                "Total employees": 7, "Active": 7, "Inactive / left": 0, "Staff": 5, "Production": 2, "Male": 3,
                "Female": 3, "Other / not set": 1,
            },
        )  # fmt: skip

    def test_golden_row_values_and_standard_columns(self):
        body = self.get(self.RID)
        keys = [c["key"] for c in body["columns"]]
        self.assertEqual(
            keys,
            ["employeeCode", "employeeName", "gender", "age", "department", "designation", "branch", "employmentType",
             "joinDate", "tenure", "status", "phone"],
        )  # fmt: skip
        rows = {r["employeeCode"]: r for r in body["rows"]}
        e1 = rows["E1"]
        self.assertEqual(e1["employeeName"], "Arun Kumar")
        self.assertEqual((e1["gender"], e1["age"], e1["department"], e1["designation"]), ("Male", 36, "CUTTING", "Manager"))
        self.assertEqual((e1["branch"], e1["employmentType"], e1["joinDate"], e1["tenure"]), ("Unit 1", "Staff", "2024-01-15", "2y 8m"))
        self.assertEqual(rows["E2"]["age"], 25)  # birthday is today
        self.assertEqual(rows["E3"]["joinDate"], "2026-09-05")  # dd-mm-yyyy text parsed
        self.assertEqual(rows["E3"]["tenure"], "<1m")
        self.assertEqual(rows["E3"]["age"], 26)  # born 29-Feb-2000
        self.assertEqual(rows["E3"]["designation"], None)
        self.assertEqual(rows["E6"]["department"], "Unassigned")
        self.assertEqual(rows["E6"]["branch"], "No branch")
        self.assertIsNone(rows["E7"]["joinDate"])  # 'soon' is unreadable
        self.assertIsNone(rows["E7"]["age"])
        self.assertEqual(rows["E7"]["gender"], None)
        self.assertEqual(rows["E8"]["gender"], "Male")  # 'Male' typed with a capital

    def test_full_layout_adds_contact_fields_and_the_hod(self):
        body = self.get(self.RID, layout="full")
        self.assertEqual(len(body["columns"]), 19)
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual(rows["E1"]["unitCode"], "U1-1")
        self.assertEqual(rows["E1"]["fatherName"], "Kumar")
        self.assertEqual(rows["E1"]["email"], "arun@example.com")
        self.assertEqual(rows["E1"]["emergencyContact"], "Ravi 9000000001")
        self.assertEqual(rows["E1"]["bloodGroup"], "O+")
        self.assertEqual(rows["E1"]["dateOfBirth"], "1990-03-10")
        # one active HOD per employee: E1 heads SEWING, E10 heads CUTTING (Unit 1)
        self.assertEqual(rows["E2"]["hod"], "Arun Kumar")
        self.assertEqual(rows["E7"]["hod"], "Arun Kumar")
        self.assertEqual(rows["E1"]["hod"], "Jai Singh")
        self.assertIsNone(rows["E10"]["hod"])  # the HOD of the department has nobody above them
        self.assertIsNone(rows["E3"]["hod"])  # the HOD row covering CUTTING (Unit 2) is inactive
        self.assertIsNone(rows["E6"]["hod"])
        self.assertTrue(any("HOD" in n for n in body["notes"]))

    def test_sensitive_columns_never_appear(self):
        for layout in ("standard", "full"):
            body = self.get(self.RID, layout=layout, employeeStatus="all")
            columns = " ".join(c["key"].lower() for c in body["columns"])
            for word in ("salary", "bank", "ifsc", "account", "idproof", "address", "pf", "esi", "uan", "password", "photo"):
                self.assertNotIn(word, columns, word)
            values = str(body["rows"]).lower()
            for secret in ("1234567890123", "5566778899001", "123412341234", "hdfc", "12 main st", "30000", "tn/tpr/001", "100000000001"):
                self.assertNotIn(secret, values, secret)
    def test_status_filter_treats_any_non_active_text_as_inactive(self):
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E4", "E5", "E9"])  # E9 is 'resigned'
        self.assertEqual(len(codes(self.get(self.RID, employeeStatus="all"))), 10)
        body = self.get(self.RID, employeeStatus="all")
        self.assertEqual(cards(body)["Inactive / left"], 3)
        statuses = {r["employeeCode"]: r["status"] for r in body["rows"]}
        self.assertEqual((statuses["E4"], statuses["E9"], statuses["E1"]), ("Inactive", "Resigned", "Active"))

    def test_each_filter_narrows(self):
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_sew1.id))), ["E2", "E7"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_op.id))), ["E2", "E7"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2", "E8"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E3", "E8"])
        self.assertEqual(codes(self.get(self.RID, employeeIds=f"{self.e1.id},{self.e6.id}")), ["E1", "E6"])
        self.assertEqual(codes(self.get(self.RID, gender="male")), ["E1", "E8", "E10"])
        self.assertEqual(codes(self.get(self.RID, gender="female")), ["E2", "E3", "E6"])
        self.assertEqual(codes(self.get(self.RID, gender="unspecified")), ["E7"])
        self.assertEqual(codes(self.get(self.RID, gender="other")), [])

    def test_unrecognised_gender_text_is_bucketed_as_other(self):
        self.make("E11", gender="Non-binary", branch=self.b1)
        self.assertEqual(codes(self.get(self.RID, gender="other")), ["E11"])
        row = self.get(self.RID, gender="other")["rows"][0]
        self.assertEqual(row["gender"], "Non-binary")  # the raw value stays visible so it can be corrected

    def test_notes_report_unreadable_join_dates_and_missing_dob(self):
        notes = " ".join(self.get(self.RID)["notes"])
        self.assertIn("1 employee(s) have a join date that could not be read", notes)
        self.assertIn("1 employee(s) have no date of birth", notes)

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user, employeeStatus="all")
        self.assertEqual(codes(body), ["E1", "E2", "E4", "E5", "E7", "E10"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, employeeIds=str(self.e3.id))), [])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, employeeIds=str(self.e6.id))), [])  # no-branch record

    def test_hod_scope_shows_no_hod_across_branches_for_a_scoped_user(self):
        # Scoped user still gets HODs for their own employees
        body = self.get(self.RID, user=self.branch_user, layout="full")
        self.assertEqual({r["employeeCode"]: r["hod"] for r in body["rows"]}["E2"], "Arun Kumar")


# ═════════════════════════════════════════════════════════════════════════════
# employee-contact-list
# ═════════════════════════════════════════════════════════════════════════════


class ContactListTests(_World):
    RID = "employee-contact-list"

    def test_default_rows_summary_and_notes(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E1", "E2", "E3", "E6", "E7", "E8", "E10"])
        self.assertEqual(
            cards(body),
            {"Employees listed": 7, "Missing phone": 3, "Missing emergency contact": 5, "Blood group not recorded": 2},
        )
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual(rows["E2"]["bloodGroup"], "B+")  # 'b+' normalised
        self.assertEqual(rows["E10"]["bloodGroup"], "O+")  # ' o+ ' normalised
        self.assertEqual(rows["E3"]["phone"], "+91 98765 43212")
        self.assertIsNone(rows["E10"]["phone"])  # '' -> no value
        self.assertIsNone(rows["E3"]["bloodGroup"])
        self.assertTrue(any("Blood groups:" in n and "O+ 2" in n and "not recorded 2" in n for n in body["notes"]))
        self.assertNotIn("address", " ".join(c["key"].lower() for c in body["columns"]))
        self.assertNotIn("12 Main St", str(body))

    def test_blood_group_filter_including_not_recorded(self):
        self.assertEqual(codes(self.get(self.RID, bloodGroup="O+")), ["E1", "E10"])
        self.assertEqual(codes(self.get(self.RID, bloodGroup="unknown")), ["E3", "E7"])
        self.assertEqual(codes(self.get(self.RID, bloodGroup="A+")), ["E6"])

    def test_sort_orders(self):
        self.assertEqual(codes(self.get(self.RID, sortBy="bloodGroup")), ["E6", "E2", "E8", "E1", "E10", "E3", "E7"])
        self.assertEqual(codes(self.get(self.RID, sortBy="department")), ["E1", "E3", "E8", "E10", "E2", "E7", "E6"])
        self.assertEqual(codes(self.get(self.RID, sortBy="name")), ["E1", "E2", "E3", "E6", "E7", "E8", "E10"])
        self.assertEqual(self.get(self.RID, sortBy="bogus", expect=400)["error"], "invalid_filter")

    def test_scope_filters_and_isolation(self):
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_cut1.id))), ["E1", "E10"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2", "E8"])
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E4", "E5", "E9"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user)), ["E1", "E2", "E7", "E10"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# strength-statement
# ═════════════════════════════════════════════════════════════════════════════


class StrengthTests(_World):
    RID = "strength-statement"

    def test_department_view_golden(self):
        body = self.get(self.RID)
        self.assertEqual([c["label"] for c in body["columns"]][:2], ["Department", "Branch"])
        rows = body["rows"]
        self.assertEqual([r["group"] for r in rows], ["CUTTING", "CUTTING", "SEWING", "Unassigned"])
        # same-named departments of different units are separate rows, distinguished by branch
        self.assertEqual([r["branch"] for r in rows], ["Unit 1", "Unit 2", "Unit 1", None])
        keys = ("staff", "production", "male", "female", "otherOrUnset", "total")
        self.assertEqual([tuple(r[k] for k in keys) for r in rows], [(2, 0, 2, 0, 0, 2), (1, 1, 1, 1, 0, 2), (1, 1, 0, 1, 1, 2), (1, 0, 0, 1, 0, 1)])
        self.assertEqual([r["sharePct"] for r in rows], [28.57, 28.57, 28.57, 14.29])
        self.assertEqual(body["totals"], {"staff": 5, "production": 2, "male": 3, "female": 3, "otherOrUnset": 1, "total": 7})
        self.assertEqual(cards(body), {"Total strength": 7, "Staff": 5, "Production": 2, "Male": 3, "Female": 3, "Departments": 4})

    def test_totals_equal_the_sum_of_the_rows(self):
        for group_by in ("department", "designation", "branch"):
            body = self.get(self.RID, groupBy=group_by, employeeStatus="all")
            for k in ("staff", "production", "male", "female", "otherOrUnset", "total"):
                self.assertEqual(body["totals"][k], sum(r[k] for r in body["rows"]), (group_by, k))
            self.assertEqual(body["totals"]["total"], 10)
            self.assertEqual(body["totals"]["staff"] + body["totals"]["production"], 10)

    def test_designation_and_branch_views(self):
        body = self.get(self.RID, groupBy="designation")
        self.assertEqual([c["label"] for c in body["columns"]][:3], ["Designation", "Department", "Level"])
        rows = {r["group"]: r for r in body["rows"]}
        self.assertEqual(rows["Manager"]["total"], 1)
        self.assertEqual((rows["Manager"]["department"], rows["Manager"]["level"]), ("CUTTING", "manager"))
        self.assertEqual((rows["Operator"]["total"], rows["Operator"]["department"]), (2, "SEWING"))
        self.assertEqual(rows["No designation"]["total"], 4)
        self.assertEqual(body["rows"][-1]["group"], "No designation")  # unassigned always last
        body = self.get(self.RID, groupBy="branch")
        self.assertEqual([(r["group"], r["code"], r["total"]) for r in body["rows"]], [("Unit 1", "U1", 4), ("Unit 2", "U2", 2), ("No branch", None, 1)])

    def test_filters(self):
        self.assertEqual([r["total"] for r in self.get(self.RID, employmentType="production")["rows"]], [1, 1])
        body = self.get(self.RID, employeeStatus="inactive")
        self.assertEqual([(r["group"], r["branch"], r["staff"], r["production"], r["male"], r["female"]) for r in body["rows"]],
                         [("CUTTING", "Unit 2", 1, 0, 0, 1), ("SEWING", "Unit 1", 1, 1, 2, 0)])  # fmt: skip
        self.assertEqual([r["total"] for r in self.get(self.RID, branchIds=str(self.b2.id))["rows"]], [2])
        self.assertEqual([r["group"] for r in self.get(self.RID, departmentIds=str(self.d_sew1.id))["rows"]], ["SEWING"])
        self.assertEqual(self.get(self.RID, groupBy="designation", designationIds=str(self.des_mgr.id))["totals"]["total"], 1)

    def test_include_empty_groups(self):
        body = self.get(self.RID, includeEmpty="true")
        groups = [(r["group"], r["total"]) for r in body["rows"]]
        self.assertIn(("LEGACY", 0), groups)
        self.assertIn(("SCRAP", 0), groups)
        self.assertEqual(len(groups), 6)
        self.assertEqual(body["totals"]["total"], 7)

    def test_unknown_employment_type_and_gender_are_reported_not_hidden(self):
        self.make("E11", employment_type="contract", gender="Non-binary", branch=self.b1, department=self.d_cut1)
        body = self.get(self.RID)
        self.assertEqual(body["totals"]["total"], 8)
        self.assertEqual(body["totals"]["staff"] + body["totals"]["production"], 7)
        self.assertTrue(any("employment type other than staff or production" in n for n in body["notes"]))
        cutting = next(r for r in body["rows"] if r["group"] == "CUTTING" and r["branch"] == "Unit 1")
        self.assertEqual((cutting["total"], cutting["otherOrUnset"]), (3, 1))

    def test_branch_isolation_and_include_empty_do_not_leak(self):
        body = self.get(self.RID, user=self.branch_user)
        self.assertEqual([(r["group"], r["total"]) for r in body["rows"]], [("CUTTING", 2), ("SEWING", 2)])
        body = self.get(self.RID, user=self.branch_user, includeEmpty="true")
        self.assertEqual([r["group"] for r in body["rows"]], ["CUTTING", "SEWING"])  # LEGACY / SCRAP / Unit 2 stay hidden
        body = self.get(self.RID, user=self.branch_user, groupBy="branch", includeEmpty="true")
        self.assertEqual([r["group"] for r in body["rows"]], ["Unit 1"])
        self.assertEqual(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))["rows"], [])


# ═════════════════════════════════════════════════════════════════════════════
# new-joinings
# ═════════════════════════════════════════════════════════════════════════════


class NewJoiningsTests(_World):
    RID = "new-joinings"

    def test_default_period_is_this_month_and_parses_text_dates(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E2", "E3"])  # E3's join date is the text '05-09-2026'
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual(rows["E3"]["joinDate"], "2026-09-05")
        self.assertEqual((rows["E2"]["ageAtJoining"], rows["E3"]["ageAtJoining"]), (24, 26))
        self.assertEqual((rows["E2"]["docsMissing"], rows["E3"]["docsMissing"]), (6, 5))
        self.assertEqual(
            cards(body),
            {"Joined in period": 2, "Staff": 1, "Production": 1, "Still active": 2, "Left since joining": 0, "With documents pending": 2},
        )
        notes = " ".join(body["notes"])
        self.assertIn("1 employee(s) in scope have a join date that could not be read", notes)  # E7 'soon'
        self.assertIn("1 employee(s) in scope have no join date on file", notes)  # E10 ''

    def test_document_gap_counts_required_documents_only(self):
        for cat in ("pan_card", "aadhaar_card", "educational_certificate", "voter_id_or_birth_certificate", "bank_passbook", "production_employee_documents"):
            self.doc(self.e2, cat)
        self.doc(self.e3, "offer_letter")  # not a required category
        body = self.get(self.RID)
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual((rows["E2"]["docsMissing"], rows["E3"]["docsMissing"]), (0, 5))
        self.assertEqual(cards(body)["With documents pending"], 1)

    def test_ranges_are_inclusive_and_bounded(self):
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-08-01", dateTo="2026-08-31")), ["E8"])
        self.assertEqual(codes(self.get(self.RID, dateFrom="2023-11-30", dateTo="2023-11-30")), ["E6"])
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-01-01", dateTo="2026-12-31")), ["E8", "E2", "E3"])
        self.assertEqual(self.get(self.RID, dateFrom="2000-01-01", dateTo="2026-12-31", expect=400)["field"], "dateTo")

    def test_status_after_joining_and_filters(self):
        body = self.get(self.RID, dateFrom="2020-01-01", dateTo="2026-12-31")
        self.assertEqual(codes(body), ["E4", "E6", "E1", "E5", "E8", "E2", "E3"])  # by join date
        self.assertEqual(cards(body)["Still active"], 5)
        self.assertEqual(cards(body)["Left since joining"], 2)
        self.assertEqual(codes(self.get(self.RID, dateFrom="2020-01-01", dateTo="2026-12-31", employeeStatus="inactive")), ["E4", "E5"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2"])
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_sew1.id))), ["E2"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_op.id))), ["E2"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E3"])

    def test_future_join_dates_are_listed_when_the_range_covers_them(self):
        self.make("E11", join_date="2026-10-15", branch=self.b1)
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-10-01", dateTo="2026-10-31")), ["E11"])

    def test_salary_columns_are_permission_gated_and_null_safe(self):
        body = self.get(self.RID)
        self.assertIn("salaryAmount", [c["key"] for c in body["columns"]])
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual(rows["E2"]["salaryPerShift"], 500.0)
        self.assertIsNone(rows["E2"]["salaryAmount"])  # unknown is not zero
        self.assertIsNone(rows["E3"]["salaryAmount"])
        body = self.get(self.RID, user=self.no_salary_user)
        keys = [c["key"] for c in body["columns"]]
        self.assertNotIn("salaryAmount", keys)
        self.assertNotIn("salaryPerShift", keys)
        self.assertNotIn("salaryPerShift", body["rows"][0])
        self.assertTrue(any("Salary columns are hidden" in n for n in body["notes"]))
        self.assertIn("salaryAmount", [c["key"] for c in self.get(self.RID, user=self.branch_user)["columns"]])  # payroll: view

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user, dateFrom="2019-01-01", dateTo="2026-12-31")
        self.assertEqual(codes(body), ["E4", "E1", "E5", "E2"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# exits-register
# ═════════════════════════════════════════════════════════════════════════════


class ExitsRegisterTests(_World):
    RID = "exits-register"
    WIDE = dict(dateFrom="2025-01-01", dateTo="2026-12-31")

    def test_golden_exit_dates_basis_and_service(self):
        body = self.get(self.RID, **self.WIDE)
        self.assertEqual(codes(body), ["E9", "E4", "E5"])  # by exit date
        rows = {r["employeeCode"]: r for r in body["rows"]}
        # E4: approved resignation, dated by the last working date
        self.assertEqual((rows["E4"]["exitDate"], rows["E4"]["exitBasis"]), ("2026-08-31", "Resignation"))
        self.assertEqual((rows["E4"]["approvedBy"], rows["E4"]["approvedOn"], rows["E4"]["reason"]), ("HR Admin", "2026-08-20", "Better opportunity"))
        self.assertEqual(rows["E4"]["tenureMonths"], 77)
        # E5: manually deactivated, last modified 10-Sep 08:00 UTC = 13:30 IST
        self.assertEqual((rows["E5"]["exitDate"], rows["E5"]["exitBasis"]), ("2026-09-10", "Deactivated (approx.)"))
        self.assertEqual(rows["E5"]["tenureMonths"], 15)
        self.assertIsNone(rows["E5"]["approvedBy"])
        # E9: status 'resigned', last modified 15-Jan 20:00 UTC = 16-Jan 01:30 IST (the IST date, not the UTC one)
        self.assertEqual((rows["E9"]["exitDate"], rows["E9"]["exitBasis"]), ("2026-01-16", "Deactivated (approx.)"))
        self.assertEqual(rows["E9"]["tenureMonths"], 84)
        self.assertEqual(rows["E9"]["status"], "Resigned")
        self.assertEqual(
            cards(body),
            {"Total exits": 3, "Resignations": 1, "Manual deactivations": 2, "Staff": 2, "Production": 1, "Average service (months)": 58.7},
        )
        notes = " ".join(body["notes"])
        self.assertIn("approx", notes)
        self.assertIn("deleted from the system do not appear", notes)

    def test_default_range_is_this_month(self):
        self.assertEqual(codes(self.get(self.RID)), ["E5"])

    def test_exit_type_and_scope_filters(self):
        self.assertEqual(codes(self.get(self.RID, exitType="resignation", **self.WIDE)), ["E4"])
        self.assertEqual(codes(self.get(self.RID, exitType="manual", **self.WIDE)), ["E9", "E5"])
        self.assertEqual(codes(self.get(self.RID, employmentType="staff", **self.WIDE)), ["E9", "E4"])
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_cut2.id), **self.WIDE)), ["E9"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_sup.id), **self.WIDE)), ["E4"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id), **self.WIDE)), ["E9"])
        self.assertEqual(codes(self.get(self.RID, employeeIds=str(self.e5.id), **self.WIDE)), ["E5"])
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-01-16", dateTo="2026-01-16")), ["E9"])
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-01-15", dateTo="2026-01-15")), [])  # the UTC date must not match

    def test_an_approved_resignation_of_an_active_employee_is_not_an_exit(self):
        ResignationRequest.objects.create(
            employee=self.e1, status="approved", last_working_date=date(2026, 9, 15), approved_at=utc(2026, 9, 1, 5, 0)
        )
        self.assertNotIn("E1", codes(self.get(self.RID, **self.WIDE)))  # E1 is still active (re-activated)

    def test_latest_approved_resignation_wins_and_approval_date_is_the_fallback(self):
        e11 = self.make("E11", status="inactive", branch=self.b1, join_date="2024-06-15")
        ResignationRequest.objects.create(employee=e11, status="approved", last_working_date=date(2026, 3, 31), approved_at=utc(2026, 3, 1, 5, 0))
        ResignationRequest.objects.create(employee=e11, status="approved", last_working_date=date(2026, 6, 30), approved_at=utc(2026, 6, 1, 5, 0))
        e12 = self.make("E12", status="inactive", branch=self.b1)
        ResignationRequest.objects.create(employee=e12, status="approved", approved_at=utc(2026, 5, 31, 20, 0))  # no LWD; 1-Jun IST
        ResignationRequest.objects.create(employee=e12, status="rejected", last_working_date=date(2026, 2, 1))  # ignored
        rows = {r["employeeCode"]: r for r in self.get(self.RID, **self.WIDE)["rows"]}
        self.assertEqual((rows["E11"]["exitDate"], rows["E11"]["exitBasis"]), ("2026-06-30", "Resignation"))
        self.assertEqual((rows["E12"]["exitDate"], rows["E12"]["exitBasis"]), ("2026-06-01", "Resignation (approval date)"))
        self.assertIsNone(rows["E12"]["tenureMonths"])  # no join date -> no service figure
        self.assertEqual(self.get(self.RID, exitType="resignation", **self.WIDE)["rowCount"], 3)

    def test_exit_before_join_date_gives_no_service_figure_and_future_lwd_is_noted(self):
        e11 = self.make("E11", status="inactive", branch=self.b1, join_date="2026-10-20")
        ResignationRequest.objects.create(employee=e11, status="approved", last_working_date=date(2026, 10, 15))
        body = self.get(self.RID, dateFrom="2026-10-01", dateTo="2026-10-31")
        self.assertEqual(codes(body), ["E11"])
        self.assertIsNone(body["rows"][0]["tenureMonths"])
        self.assertTrue(any("last working date after today" in n for n in body["notes"]))

    def test_branch_isolation(self):
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, **self.WIDE)), ["E4", "E5"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id), **self.WIDE)), [])


# ═════════════════════════════════════════════════════════════════════════════
# resignation-register
# ═════════════════════════════════════════════════════════════════════════════


class ResignationRegisterTests(_World):
    RID = "resignation-register"

    def test_default_month_golden(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E3", "E7", "E1", "E6"])  # by request time
        rows = {r["employeeCode"]: r for r in body["rows"]}
        # request raised 20-Sep 20:00 UTC = 21-Sep 01:30 IST
        r2 = rows["E1"]
        self.assertEqual(r2["requestedOn"], "2026-09-21 01:30")
        self.assertEqual((r2["stage"], r2["status"], r2["pendingDays"], r2["noticeDays"]), ("Awaiting HOD", "Pending", 8, 40))
        self.assertEqual((rows["E7"]["stage"], rows["E7"]["pendingDays"], rows["E7"]["deptHead"]), ("Awaiting HR", 14, "Arun Kumar"))
        self.assertEqual((rows["E3"]["stage"], rows["E3"]["deptHead"], rows["E3"]["pendingDays"]), ("Rejected by HOD", "Jai Singh", None))
        self.assertEqual(rows["E6"]["stage"], "Rejected by HR")
        self.assertEqual(
            cards(body),
            {
                "Total requests": 4, "Awaiting HOD": 1, "Awaiting HR": 1, "Approved": 0, "Rejected by HOD": 1,
                "Rejected by HR": 1, "Avg days to decision": 2.0,
            },
        )  # fmt: skip

    def test_approved_request_and_average_decision_time(self):
        body = self.get(self.RID, dateFrom="2026-08-01", dateTo="2026-09-29", layout="full")
        self.assertEqual(codes(body), ["E4", "E3", "E7", "E1", "E6"])
        r1 = body["rows"][0]
        self.assertEqual(r1["requestedOn"], "2026-08-10 09:30")
        self.assertEqual((r1["lastWorkingDate"], r1["noticeDays"], r1["stage"]), ("2026-08-31", 21, "Approved"))
        self.assertEqual((r1["approvedBy"], r1["approvedAt"], r1["hrComment"]), ("HR Admin", "2026-08-20 15:30", "OK"))
        self.assertEqual((r1["deptHeadStatus"], r1["deptHeadAt"], r1["deptHeadComment"]), ("Approved", "2026-08-12 10:30", "Fine"))
        self.assertEqual((r1["surveyReason"], r1["surveyRecommend"], r1["surveyRetain"]), ("Salary", "Yes", "Higher pay"))
        self.assertIsNone(r1["pendingDays"])
        # (approved: 20-Aug - 10-Aug = 10) and (HOD rejection: 3-Sep - 1-Sep = 2) -> 6.0; the HR rejection has no time stamp
        self.assertEqual(cards(body)["Avg days to decision"], 6.0)

    def test_summary_layout_omits_comments_and_survey_answers(self):
        summary = self.get(self.RID)
        full = self.get(self.RID, layout="full")
        s_keys = {c["key"] for c in summary["columns"]}
        f_keys = {c["key"] for c in full["columns"]}
        self.assertTrue(s_keys < f_keys)
        for k in ("deptHeadComment", "hrComment", "surveyReason", "surveyRecommend", "surveyRetain"):
            self.assertNotIn(k, s_keys)
            self.assertIn(k, f_keys)
        self.assertEqual(len(f_keys), 21)

    def test_date_range_uses_the_ist_day(self):
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-09-21", dateTo="2026-09-21")), ["E1"])
        self.assertEqual(codes(self.get(self.RID, dateFrom="2026-09-20", dateTo="2026-09-20")), [])  # UTC date must not match

    def test_filters(self):
        wide = dict(dateFrom="2026-08-01", dateTo="2026-09-29")
        self.assertEqual(codes(self.get(self.RID, status="pending,dept_approved", **wide)), ["E7", "E1"])
        self.assertEqual(codes(self.get(self.RID, status="approved", **wide)), ["E4"])
        self.assertEqual(codes(self.get(self.RID, status="rejected", **wide)), ["E3", "E6"])
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_cut2.id), **wide)), ["E3"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id), **wide)), ["E3"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production", **wide)), [])
        self.assertEqual(codes(self.get(self.RID, employeeIds=str(self.e4.id), **wide)), ["E4"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_sup.id), **wide)), ["E4"])
        self.assertEqual(self.get(self.RID, status="bogus", expect=400)["field"], "status")

    def test_requests_of_inactive_employees_still_appear(self):
        # The approved resignation's employee (E4) is inactive: a transactional register must not drop them.
        self.assertIn("E4", codes(self.get(self.RID, dateFrom="2026-08-01", dateTo="2026-08-31")))

    def test_production_requests_from_the_mobile_flow_are_listed(self):
        r = ResignationRequest.objects.create(employee=self.e2, reason="Moving", status="pending")
        ResignationRequest.objects.filter(pk=r.pk).update(created_at=utc(2026, 9, 28, 5, 0))
        self.assertIn("E2", codes(self.get(self.RID, employmentType="production")))

    def test_branch_isolation(self):
        wide = dict(dateFrom="2026-08-01", dateTo="2026-09-29")
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, **wide)), ["E4", "E7", "E1"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id), **wide)), [])
        body = self.get(self.RID, user=self.branch_user, **wide)
        self.assertNotIn("E3", str(body))
        self.assertNotIn("E6", str(body))
        # the counters are computed over the scoped rows only
        self.assertEqual(cards(body)["Total requests"], 3)


# ═════════════════════════════════════════════════════════════════════════════
# manpower-movement
# ═════════════════════════════════════════════════════════════════════════════


class ManpowerMovementTests(_World):
    RID = "manpower-movement"

    def test_monthly_view_golden(self):
        body = self.get(self.RID, year="2026")
        rows = {r["group"]: r for r in body["rows"]}
        self.assertEqual(len(body["rows"]), 12)
        self.assertEqual([r["group"] for r in body["rows"]][:2], ["Jan 2026", "Feb 2026"])
        keys = ("joinedStaff", "joinedProduction", "joinedTotal", "leftStaff", "leftProduction", "leftTotal", "net")
        self.assertEqual(tuple(rows["Jan 2026"][k] for k in keys), (0, 0, 0, 1, 0, 1, -1))  # E9 (approx 16-Jan)
        self.assertEqual(tuple(rows["Aug 2026"][k] for k in keys), (0, 1, 1, 1, 0, 1, 0))  # E8 joined; E4 left 31-Aug
        self.assertEqual(tuple(rows["Sep 2026"][k] for k in keys), (1, 1, 2, 0, 1, 1, 1))  # E3+E2 joined; E5 left
        self.assertEqual(tuple(rows["Feb 2026"][k] for k in keys), (0, 0, 0, 0, 0, 0, 0))
        self.assertEqual(body["totals"], {"joinedStaff": 1, "joinedProduction": 2, "joinedTotal": 3, "leftStaff": 2, "leftProduction": 1, "leftTotal": 3, "net": 0, "exitRatePct": 30.0})
        # exit rate = leavers / (active today 7 + leavers in the year 3): 3/10 overall, 1/10 in each leaving month
        self.assertEqual((rows["Jan 2026"]["exitRatePct"], rows["Aug 2026"]["exitRatePct"], rows["Sep 2026"]["exitRatePct"]), (10.0, 10.0, 10.0))
        self.assertEqual(rows["Feb 2026"]["exitRatePct"], 0.0)
        self.assertEqual(cards(body), {"Joined": 3, "Left": 3, "Net movement": 0, "Exit rate": 30.0, "Active today": 7})
        self.assertTrue(any("approximation" in n for n in body["notes"]))
        self.assertTrue(any("1 leaver(s)" not in n and "2 leaver(s) have only an approximate" in n for n in body["notes"]))  # E5, E9

    def test_department_view_golden(self):
        body = self.get(self.RID, year="2026", groupBy="department")
        self.assertEqual([r["group"] for r in body["rows"]], ["CUTTING", "CUTTING", "SEWING", "Unassigned"])
        keys = ("joinedTotal", "leftTotal", "net", "exitRatePct")
        got = [tuple(r[k] for k in keys) for r in body["rows"]]
        # Unit 1 CUTTING: nobody moved (2 active). Unit 2 CUTTING: E3+E8 joined, E9 left 1/(2+1). SEWING: E2 joined,
        # E4+E5 left 2/(2+2). Unassigned: only E6, active since 2023.
        self.assertEqual(got, [(0, 0, 0, 0.0), (2, 1, 1, 33.33), (1, 2, -1, 50.0), (0, 0, 0, 0.0)])
        self.assertEqual((body["totals"]["joinedTotal"], body["totals"]["leftTotal"], body["totals"]["exitRatePct"]), (3, 3, 30.0))
        self.assertTrue(any("own active strength" in n for n in body["notes"]))

    def test_another_year_and_filters(self):
        body = self.get(self.RID, year="2025")
        self.assertEqual(body["totals"]["joinedTotal"], 1)  # E5 joined 10-Jun-2025 (a leaver later, in 2026)
        self.assertEqual(next(r for r in body["rows"] if r["group"] == "Jun 2025")["joinedProduction"], 1)
        self.assertEqual(body["totals"]["leftTotal"], 0)
        self.assertEqual(body["totals"]["exitRatePct"], 0.0)
        body = self.get(self.RID, year="2026", employmentType="production")
        self.assertEqual((body["totals"]["joinedTotal"], body["totals"]["leftTotal"]), (2, 1))
        body = self.get(self.RID, year="2026", branchIds=str(self.b2.id))
        self.assertEqual((body["totals"]["joinedTotal"], body["totals"]["leftTotal"]), (2, 1))
        body = self.get(self.RID, year="2026", departmentIds=str(self.d_sew1.id))
        self.assertEqual((body["totals"]["joinedTotal"], body["totals"]["leftTotal"]), (1, 2))

    def test_default_year_is_this_year(self):
        self.assertEqual(self.get(self.RID)["rows"][0]["group"], "Jan 2026")

    def test_a_person_who_joined_and_left_in_the_year_counts_in_both(self):
        e11 = self.make("E11", status="inactive", branch=self.b1, department=self.d_cut1, join_date="2026-02-10")
        ResignationRequest.objects.create(employee=e11, status="approved", last_working_date=date(2026, 4, 30))
        body = self.get(self.RID, year="2026")
        rows = {r["group"]: r for r in body["rows"]}
        self.assertEqual((rows["Feb 2026"]["joinedStaff"], rows["Apr 2026"]["leftStaff"]), (1, 1))
        self.assertEqual(body["totals"]["joinedTotal"], 4)
        self.assertEqual(body["totals"]["leftTotal"], 4)

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user, year="2026")
        # Unit 1 only: E2 joined; E4 + E5 left; active today E1, E2, E7, E10 -> 2 / (4 + 2)
        self.assertEqual((body["totals"]["joinedTotal"], body["totals"]["leftTotal"]), (1, 2))
        self.assertEqual(body["totals"]["exitRatePct"], 33.33)
        self.assertEqual(cards(body)["Active today"], 4)
        self.assertEqual(self.get(self.RID, user=self.branch_user, year="2026", branchIds=str(self.b2.id))["totals"]["joinedTotal"], 0)

    def test_empty_department_view_has_no_totals_row(self):
        body = self.get(self.RID, groupBy="department", departmentIds="999999")
        self.assertEqual(body["rows"], [])
        self.assertTrue(all(v is None for v in (body["totals"] or {}).values()))


# ═════════════════════════════════════════════════════════════════════════════
# statutory-compliance
# ═════════════════════════════════════════════════════════════════════════════


class StatutoryComplianceTests(_World):
    RID = "statutory-compliance"

    def rows(self, **params):
        body = self.get(self.RID, **params)
        return body, {r["employeeCode"]: r for r in body["rows"]}

    def test_default_lists_only_employees_with_gaps_and_summarises_everyone(self):
        body, rows = self.rows()
        self.assertEqual(codes(body), ["E2", "E3", "E6", "E7", "E8", "E10"])  # E1 is fully compliant
        self.assertEqual(
            cards(body),
            {
                "Employees checked": 7, "Fully compliant": 1, "PF number missing": 3, "ESI number missing": 4,
                "UAN missing": 4, "Bank details missing": 4, "Deducted, number missing": 1, "Completeness": 14.3,
            },
        )  # fmt: skip
        self.assertEqual({k: v["issueCount"] for k, v in rows.items()}, {"E2": 7, "E3": 6, "E6": 7, "E7": 7, "E8": 5, "E10": 7})

    def test_each_issue_is_named(self):
        _b, rows = self.rows()
        self.assertEqual(
            rows["E2"]["issues"],
            "PF number missing; ESI number missing; UAN missing; Bank account number and IFSC missing; "
            "Aadhaar document not uploaded; PAN document not uploaded; Bank passbook document not uploaded",
        )
        self.assertEqual(
            rows["E3"]["issues"],
            "IFSC format is invalid; Bank account should be 9-18 digits; UAN should be 12 digits; "
            "ESI number should be 10 (or 17) digits; PAN document not uploaded; Bank passbook document not uploaded",
        )
        self.assertIn("PF deducted in payroll but no PF number", rows["E8"]["issues"])

    def test_identifiers_are_text_and_bank_details_are_masked(self):
        body, rows = self.rows(includeCompliant="true")
        e1 = rows["E1"]
        self.assertEqual(e1["pfNumber"], "TN/TPR/001")
        self.assertEqual(e1["esiNumber"], "1234567890")
        self.assertEqual(e1["uanNumber"], "100000000001")
        self.assertEqual(e1["bankAccount"], "*********9001")
        self.assertEqual(e1["idProof"], "********1234")
        self.assertEqual(e1["bankIfsc"], "HDFC0001234")
        self.assertEqual(rows["E8"]["bankIfsc"], "SBIN0001234")  # upper-cased
        self.assertEqual(rows["E8"]["bankAccount"], "*****6789")
        self.assertEqual(rows["E8"]["esiNumber"], "12345678901234567")  # 17-digit legacy ESI kept in full, as text
        self.assertIsInstance(e1["uanNumber"], str)
        self.assertNotIn("5566778899001", str(body))
        self.assertNotIn("123412341234", str(body))

    def test_documents_and_payroll_evidence(self):
        _b, rows = self.rows(includeCompliant="true")
        self.assertEqual((rows["E1"]["aadhaarDoc"], rows["E1"]["panDoc"], rows["E1"]["passbookDoc"]), ("Yes", "Yes", "Yes"))
        self.assertEqual((rows["E3"]["aadhaarDoc"], rows["E3"]["panDoc"]), ("Yes", "No"))
        # August 2026 is "last month": E1 has a PF+ESI slip, E8's two weekly slips (60 + 40) add up to a PF deduction
        self.assertEqual((rows["E1"]["pfDeducted"], rows["E1"]["esiDeducted"]), ("Yes", "Yes"))
        self.assertEqual((rows["E8"]["pfDeducted"], rows["E8"]["esiDeducted"]), ("Yes", "No"))
        self.assertIsNone(rows["E2"]["pfDeducted"])  # no slip that month: unknown, not "No"
        body, rows = self.rows(includeCompliant="true", period="2026-09")
        self.assertIsNone(rows["E8"]["pfDeducted"])
        self.assertEqual(cards(body)["Deducted, number missing"], 0)
        self.assertEqual(rows["E8"]["issueCount"], 4)

    def test_issue_filter(self):
        expect = {
            "missing_pf": ["E2", "E6", "E8"],
            "missing_esi": ["E2", "E6", "E7", "E10"],
            "missing_uan": ["E2", "E6", "E7", "E10"],
            "missing_bank": ["E2", "E6", "E7", "E10"],
            "invalid_format": ["E3"],
            "no_aadhaar_doc": ["E2", "E6", "E7", "E8", "E10"],
            "no_pan_doc": ["E2", "E3", "E6", "E7", "E8", "E10"],
            "no_passbook_doc": ["E2", "E3", "E6", "E7", "E8", "E10"],
            "duplicate_id": ["E7", "E10"],
            "deducted_no_number": ["E8"],
        }
        for issue, want in expect.items():
            self.assertEqual(codes(self.get(self.RID, issue=issue)), want, issue)

    def test_duplicates_normalise_and_name_the_other_employee(self):
        _b, rows = self.rows()
        self.assertIn("PF number also used by E10", rows["E7"]["issues"])  # 'PF-DUP-9' == 'pf dup 9'
        self.assertIn("PF number also used by E7", rows["E10"]["issues"])

    def test_duplicates_are_found_across_departments_even_when_filtered(self):
        _b, rows = self.rows(departmentIds=str(self.d_sew1.id))
        self.assertEqual(sorted(rows), ["E2", "E7"])
        self.assertIn("also used by E10", rows["E7"]["issues"])  # E10 is in CUTTING, outside the filter

    def test_inactive_employees_are_never_flagged_as_duplicates(self):
        self.make("E11", status="inactive", branch=self.b1, pf_number="TN/TPR/001")
        body, rows = self.rows(employeeStatus="all", includeCompliant="true")
        self.assertNotIn("also used", rows["E11"]["issues"] or "")
        self.assertEqual(rows["E1"]["issueCount"], 0)  # a rejoiner's old record does not taint the active one

    def test_duplicate_detection_respects_branch_isolation(self):
        self.make("E11", branch=self.b2, pf_number="TN/TPR/001")
        _b, rows = self.rows(includeCompliant="true")
        self.assertIn("also used by E11", rows["E1"]["issues"])  # the admin sees the clash
        body = self.get(self.RID, user=self.branch_user, includeCompliant="true")
        e1 = next(r for r in body["rows"] if r["employeeCode"] == "E1")
        self.assertEqual(e1["issueCount"], 0)  # a Unit 1 user cannot see (or be told about) Unit 2's people
        self.assertNotIn("E11", str(body))

    def test_scope_filters_and_status(self):
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2", "E8"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E3", "E8"])
        self.assertEqual(codes(self.get(self.RID, employeeIds=str(self.e6.id))), ["E6"])
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E4", "E5", "E9"])
        self.assertEqual(cards(self.get(self.RID, employeeStatus="all"))["Employees checked"], 10)
        self.assertEqual(len(codes(self.get(self.RID, employeeStatus="all", includeCompliant="true"))), 10)

    def test_missing_uan_note_appears_when_almost_nobody_has_one(self):
        # 4 of 7 active employees lack a UAN: no note. Wipe the rest and the data-capture gap is stated.
        self.assertFalse(any("UAN cannot currently be entered" in n for n in self.get(self.RID)["notes"]))
        Employee.objects.filter(status="active").update(uan_number=None)
        self.assertTrue(any("UAN cannot currently be entered" in n for n in self.get(self.RID)["notes"]))

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user, includeCompliant="true")
        self.assertEqual(codes(body), ["E1", "E2", "E7", "E10"])
        self.assertEqual(cards(body)["Employees checked"], 4)
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# data-quality-audit
# ═════════════════════════════════════════════════════════════════════════════


class DataQualityTests(_World):
    RID = "data-quality-audit"

    def test_golden_default(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E2", "E3", "E6", "E7", "E8", "E10"])
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual({k: v["issueCount"] for k, v in rows.items()}, {"E2": 2, "E3": 5, "E6": 5, "E7": 8, "E8": 5, "E10": 4})
        self.assertEqual(rows["E2"]["issues"], "Father's name missing; Emergency contact missing")
        self.assertEqual(
            rows["E7"]["issues"],
            "Date of birth missing; Gender not set; Phone missing; Address missing; Join date 'soon' cannot be read; "
            "Father's name missing; Blood group missing; Emergency contact missing",
        )
        self.assertEqual(
            rows["E6"]["issues"], "Phone missing; No department; No designation; No branch; Monthly salary not set"
        )
        self.assertEqual(rows["E8"]["issues"], "Address missing; No designation; Per-shift rate not set; Father's name missing; Emergency contact missing")
        self.assertEqual(rows["E10"]["issues"], "Phone missing; Join date missing; No designation; Emergency contact missing")
        self.assertEqual(rows["E7"]["joinDate"], "soon")  # shown exactly as entered, so the fix is visible
        self.assertEqual(
            cards(body),
            {
                "Employees checked": 7, "Clean records": 1, "Records with issues": 6, "Profile completeness": 14.3,
                "Date of birth: issues": 1, "Gender: issues": 1, "Phone: issues": 3, "Address: issues": 3,
                "Join date: issues": 2, "Department / designation / branch: issues": 4, "Salary set-up: issues": 3,
                "Father's name, blood group, emergency contact: issues": 5,
            },
        )  # fmt: skip

    def test_include_clean_lists_everyone(self):
        body = self.get(self.RID, includeClean="true")
        self.assertEqual(len(body["rows"]), 7)
        e1 = next(r for r in body["rows"] if r["employeeCode"] == "E1")
        self.assertEqual((e1["issueCount"], e1["issues"]), (0, None))

    def test_check_selection(self):
        self.assertEqual(codes(self.get(self.RID, check="dob")), ["E7"])
        body = self.get(self.RID, check="phone,address")
        self.assertEqual(codes(body), ["E3", "E6", "E7", "E8", "E10"])
        self.assertEqual({r["employeeCode"]: r["issueCount"] for r in body["rows"]}, {"E3": 1, "E6": 1, "E7": 2, "E8": 1, "E10": 1})
        self.assertEqual(codes(self.get(self.RID, check="salary")), ["E3", "E6", "E8"])
        self.assertEqual(codes(self.get(self.RID, check="join_date")), ["E7", "E10"])
        self.assertEqual(codes(self.get(self.RID, check="org_unit")), ["E3", "E6", "E8", "E10"])
        self.assertEqual(self.get(self.RID, check="bogus", expect=400)["field"], "check")

    def test_status_and_scope_filters(self):
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E4", "E5", "E9"])
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_sew1.id))), ["E2", "E7"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2", "E8"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E3", "E8"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_op.id))), ["E2", "E7"])

    def test_implausible_dates_of_birth(self):
        self.make("E11", date_of_birth=date(2030, 1, 1), branch=self.b1, join_date="2026-01-01")
        self.make("E12", date_of_birth=date(2015, 1, 1), branch=self.b1, join_date="2026-01-01")  # age 11
        self.make("E13", date_of_birth=date(1930, 1, 1), branch=self.b1, join_date="2026-01-01")  # age 96
        self.make("E14", date_of_birth=date(1990, 1, 1), branch=self.b1, join_date="1989-06-01")  # born after joining
        rows = {r["employeeCode"]: r["issues"] for r in self.get(self.RID, check="dob")["rows"]}
        self.assertIn("Date of birth is in the future", rows["E11"])
        self.assertIn("Age 11 looks implausible", rows["E12"])
        self.assertIn("Age 96 looks implausible", rows["E13"])
        self.assertIn("Date of birth is not before the join date", rows["E14"])

    def test_join_date_in_the_future_and_unrecognised_values(self):
        self.make("E11", join_date="2027-01-01", gender="M", blood_group="Z", branch=self.b1)
        row = next(r for r in self.get(self.RID, check="join_date,gender,profile")["rows"] if r["employeeCode"] == "E11")
        self.assertIn("Join date is in the future", row["issues"])
        self.assertIn("Gender 'M' is not recognised", row["issues"])
        self.assertIn("Blood group 'Z' is not recognised", row["issues"])

    def test_phone_format_and_duplicates(self):
        self.make("E11", phone="12345", branch=self.b1)
        self.make("E12", phone="+91-98765-43210", branch=self.b1)  # same number as E1
        self.make("E13", phone="9000000013", branch=self.b1, status="inactive")
        self.make("E14", phone="9000000013", branch=self.b1)  # shares only with an inactive employee: not flagged
        rows = {r["employeeCode"]: r["issues"] for r in self.get(self.RID, check="phone", employeeStatus="all")["rows"]}
        self.assertIn("Phone is not a 10-digit number", rows["E11"])
        self.assertIn("Phone also used by E12", rows["E1"])
        self.assertIn("Phone also used by E1", rows["E12"])
        self.assertNotIn("E14", rows)
        self.assertNotIn("E13", rows)

    def test_duplicate_people_and_stray_spaces_in_codes(self):
        self.make("E11", first_name="Arun", last_name="Kumar", date_of_birth=date(1990, 3, 10), branch=self.b1)
        self.make("E12 ", branch=self.b1)  # trailing space
        body = self.get(self.RID, check="duplicates,code")
        rows = {r["employeeCode"]: r["issues"] for r in body["rows"]}
        self.assertIn("Same name and date of birth as E11", rows["E1"])
        self.assertIn("Same name and date of birth as E1", rows["E11"])
        self.assertIn("Employee code has stray spaces", rows["E12"])  # shown trimmed
        self.assertNotIn("E12 ", rows)

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user, includeClean="true")
        self.assertEqual(codes(body), ["E1", "E2", "E7", "E10"])
        self.assertEqual(cards(body)["Employees checked"], 4)
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# age-compliance
# ═════════════════════════════════════════════════════════════════════════════


class AgeComplianceTests(_World):
    RID = "age-compliance"

    def test_default_shows_exceptions(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E7", "E8", "E10"])
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual((rows["E7"]["flag"], rows["E7"]["age"]), ("DOB missing", None))
        self.assertEqual((rows["E8"]["flag"], rows["E8"]["age"]), ("Under age", 16))
        self.assertEqual((rows["E10"]["flag"], rows["E10"]["age"]), ("Over age", 66))
        self.assertEqual(cards(body), {"Under minimum age": 1, "Over maximum age": 1, "DOB missing / invalid": 1, "Total checked": 7})

    def test_show_choices(self):
        self.assertEqual(codes(self.get(self.RID, show="under_min")), ["E8"])
        self.assertEqual(codes(self.get(self.RID, show="over_max")), ["E10"])
        self.assertEqual(codes(self.get(self.RID, show="dob_missing")), ["E7"])
        body = self.get(self.RID, show="all")
        self.assertEqual(len(body["rows"]), 7)
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual(rows["E1"]["flag"], "OK")
        self.assertEqual(rows["E1"]["ageAtJoining"], 33)  # born 10-Mar-1990, joined 15-Jan-2024
        self.assertEqual(rows["E8"]["ageAtJoining"], 16)
        self.assertIsNone(rows["E7"]["ageAtJoining"])  # join date unreadable

    def test_thresholds_are_parameters(self):
        self.assertEqual(codes(self.get(self.RID, show="under_min", minAge="26")), ["E2", "E8"])  # E2 is 25
        self.assertEqual(codes(self.get(self.RID, show="under_min", minAge="25")), ["E8"])  # 25 is not under 25
        self.assertEqual(codes(self.get(self.RID, show="over_max", maxAge="30")), ["E1", "E10"])  # E6 is exactly 30
        self.assertEqual(self.get(self.RID, minAge="5", expect=400)["field"], "minAge")

    def test_future_date_of_birth_is_invalid_not_ok(self):
        self.make("E11", date_of_birth=date(2030, 1, 1), branch=self.b1)
        body = self.get(self.RID, show="dob_missing")
        self.assertEqual(codes(body), ["E7", "E11"])
        self.assertEqual(next(r for r in body["rows"] if r["employeeCode"] == "E11")["flag"], "DOB invalid")
        self.assertEqual(cards(body)["DOB missing / invalid"], 2)

    def test_age_proof_is_document_presence(self):
        rows = {r["employeeCode"]: r["birthProof"] for r in self.get(self.RID, show="all")["rows"]}
        self.assertEqual((rows["E1"], rows["E3"], rows["E8"]), ("Yes", "Yes", "No"))  # E1 / E3 uploaded an Aadhaar card
        self.doc(self.e8, "voter_id_or_birth_certificate")
        self.doc(self.e10, "pan_card")  # not an age proof
        rows = {r["employeeCode"]: r["birthProof"] for r in self.get(self.RID, show="all")["rows"]}
        self.assertEqual((rows["E8"], rows["E10"]), ("Yes", "No"))

    def test_scope_filters_and_isolation(self):
        self.assertEqual(len(codes(self.get(self.RID, employeeStatus="all", show="all"))), 10)
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E8"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E8"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user)), ["E7", "E10"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# family-dependents
# ═════════════════════════════════════════════════════════════════════════════


class FamilyDependentsTests(_World):
    RID = "family-dependents"

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        FamilyDependent.objects.create(
            employee=cls.e1, name="Priya", relation="spouse", date_of_birth=date(1992, 5, 1),
            is_insurance_nominee=True, covered_under_health_scheme=True,
        )  # fmt: skip
        FamilyDependent.objects.create(
            employee=cls.e1, name="Kiran", relation="child", date_of_birth=date(2018, 12, 1),
            covered_under_health_scheme=True,
        )  # fmt: skip
        FamilyDependent.objects.create(employee=cls.e2, name="Raman", relation="father")
        FamilyDependent.objects.create(employee=cls.e3, name="Lakshmi", relation="mother", is_insurance_nominee=True)
        FamilyDependent.objects.create(employee=cls.e4, name="Meena", relation="spouse")

    def test_golden_rows_and_summary(self):
        body = self.get(self.RID)
        self.assertEqual([(r["employeeCode"], r["dependentName"]) for r in body["rows"]],
                         [("E1", "Kiran"), ("E1", "Priya"), ("E2", "Raman"), ("E3", "Lakshmi")])  # fmt: skip
        rows = {r["dependentName"]: r for r in body["rows"]}
        self.assertEqual((rows["Priya"]["age"], rows["Kiran"]["age"]), (34, 7))
        self.assertIsNone(rows["Raman"]["age"])  # no date of birth -> blank, not 0
        self.assertEqual((rows["Priya"]["relation"], rows["Priya"]["isInsuranceNominee"], rows["Priya"]["coveredUnderHealthScheme"]), ("Spouse", "Yes", "Yes"))
        self.assertEqual((rows["Kiran"]["isInsuranceNominee"], rows["Raman"]["coveredUnderHealthScheme"]), ("No", "No"))
        self.assertEqual(cards(body), {"Dependents": 4, "Employees with dependents": 3, "Insurance nominees": 2, "Covered under health scheme": 2})
        self.assertTrue(any("cannot be added or edited from the HR portal" in n for n in body["notes"]))

    def test_filters(self):
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, relation="child")["rows"]], ["Kiran"])
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, nominee="true")["rows"]], ["Priya", "Lakshmi"])
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, healthScheme="true")["rows"]], ["Kiran", "Priya"])
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, employeeStatus="inactive")["rows"]], ["Meena"])
        self.assertEqual(len(self.get(self.RID, employeeStatus="all")["rows"]), 5)
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, branchIds=str(self.b2.id))["rows"]], ["Lakshmi"])
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, departmentIds=str(self.d_sew1.id))["rows"]], ["Raman"])
        self.assertEqual([r["dependentName"] for r in self.get(self.RID, employmentType="production")["rows"]], ["Raman"])

    def test_empty_table_is_a_valid_report(self):
        FamilyDependent.objects.all().delete()
        body = self.get(self.RID)
        self.assertEqual(body["rows"], [])
        self.assertEqual(cards(body)["Dependents"], 0)

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user)
        self.assertEqual([r["dependentName"] for r in body["rows"]], ["Kiran", "Priya", "Raman"])
        self.assertNotIn("Lakshmi", str(body))
        self.assertEqual(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))["rows"], [])


# ═════════════════════════════════════════════════════════════════════════════
# birthdays / work-anniversaries
# ═════════════════════════════════════════════════════════════════════════════


class BirthdayTests(_World):
    RID = "birthdays"

    def test_this_month_golden(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E10", "E2"])  # 1-Sep then 29-Sep
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual((rows["E10"]["birthday"], rows["E10"]["weekday"], rows["E10"]["turningAge"]), ("2026-09-01", "Tuesday", 66))
        self.assertEqual((rows["E2"]["birthday"], rows["E2"]["weekday"], rows["E2"]["turningAge"]), ("2026-09-29", "Tuesday", 25))
        self.assertEqual(rows["E2"]["dateOfBirth"], "2001-09-29")
        self.assertEqual(cards(body), {"Birthdays in window": 2, "No date of birth (not listed)": 1})
        self.assertTrue(any("Window: 01-Sep-2026 to 30-Sep-2026" in n for n in body["notes"]))
        self.assertTrue(any("1 employee(s) in scope have no date of birth" in n for n in body["notes"]))

    def test_named_months_and_windows(self):
        body = self.get(self.RID, window="m12")
        self.assertEqual([(r["employeeCode"], r["birthday"], r["turningAge"]) for r in body["rows"]], [("E6", "2026-12-31", 31)])
        self.assertEqual(codes(self.get(self.RID, window="m05")), ["E8"])
        self.assertEqual(codes(self.get(self.RID, window="nextMonth")), [])  # nobody in October
        self.assertEqual(codes(self.get(self.RID, window="next7")), ["E2"])  # today counts
        self.assertEqual(codes(self.get(self.RID, window="next30")), ["E2"])
        self.assertEqual(self.get(self.RID, window="m13", expect=400)["field"], "window")

    def test_feb_29_birthday_is_celebrated_on_28_feb_in_a_non_leap_year(self):
        body = self.get(self.RID, window="m02")
        self.assertEqual([(r["employeeCode"], r["birthday"], r["turningAge"], r["weekday"]) for r in body["rows"]], [("E3", "2026-02-28", 26, "Saturday")])
        self.mock_today.return_value = date(2028, 2, 10)  # 2028 is a leap year
        body = self.get(self.RID)
        self.assertEqual([(r["employeeCode"], r["birthday"], r["turningAge"]) for r in body["rows"]], [("E3", "2028-02-29", 28)])

    def test_window_wraps_from_december_into_january(self):
        self.make("E11", date_of_birth=date(1990, 1, 5), branch=self.b1)
        self.make("E12", date_of_birth=date(1990, 1, 19), branch=self.b1)  # one day past the window
        self.mock_today.return_value = date(2026, 12, 20)
        body = self.get(self.RID, window="next30")
        self.assertEqual([(r["employeeCode"], r["birthday"], r["turningAge"]) for r in body["rows"]],
                         [("E6", "2026-12-31", 31), ("E11", "2027-01-05", 37)])  # fmt: skip
        self.mock_today.return_value = date(2026, 12, 5)
        self.assertEqual(codes(self.get(self.RID, window="nextMonth")), ["E11", "E12"])  # January 2027

    def test_status_filter_and_dates_of_birth_from_the_future_or_this_year_are_skipped(self):
        self.make("E11", date_of_birth=date(2026, 9, 10), branch=self.b1)  # born this year: not "turning" anything yet
        self.make("E12", date_of_birth=date(1970, 9, 12), branch=self.b1, status="inactive")
        self.assertEqual(codes(self.get(self.RID)), ["E10", "E2"])
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E12"])
        self.assertEqual(codes(self.get(self.RID, employeeStatus="all")), ["E10", "E12", "E2"])

    def test_scope_filters_and_isolation(self):
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_cut1.id))), ["E10"])
        self.assertEqual(codes(self.get(self.RID, employmentType="production")), ["E2"])
        self.assertEqual(codes(self.get(self.RID, designationIds=str(self.des_op.id))), ["E2"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), [])
        self.make("E11", date_of_birth=date(1985, 9, 15), branch=self.b2, department=self.d_cut2)
        self.assertEqual(codes(self.get(self.RID)), ["E10", "E11", "E2"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user)), ["E10", "E2"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


class WorkAnniversaryTests(_World):
    RID = "work-anniversaries"

    def test_default_month_lists_only_completed_years(self):
        body = self.get(self.RID)  # September: E2 and E3 joined this September -> 0 years, not an anniversary
        self.assertEqual(body["rows"], [])
        self.assertEqual(cards(body), {"Anniversaries in window": 0, "Join date missing / unreadable (not listed)": 2})  # E7, E10

    def test_named_months(self):
        body = self.get(self.RID, window="m01")
        self.assertEqual([(r["employeeCode"], r["anniversary"], r["yearsCompleted"], r["joinDate"]) for r in body["rows"]], [("E1", "2026-01-15", 2, "2024-01-15")])
        body = self.get(self.RID, window="m11")
        self.assertEqual([(r["employeeCode"], r["yearsCompleted"]) for r in body["rows"]], [("E6", 3)])
        self.assertEqual(codes(self.get(self.RID, window="m08")), [])  # E8 joined 31-Aug-2026: zero years

    def test_inactive_employees_have_no_anniversary(self):
        self.assertEqual(codes(self.get(self.RID, window="m03")), [])  # E4 joined 1-Mar-2020 but is inactive
        self.assertEqual(codes(self.get(self.RID, window="m01")), ["E1"])  # E9 (inactive, 1-Jan-2019) excluded

    def test_minimum_years(self):
        self.assertEqual(codes(self.get(self.RID, window="m11", minYears="3")), ["E6"])
        self.assertEqual(codes(self.get(self.RID, window="m11", minYears="4")), [])
        self.assertEqual(self.get(self.RID, minYears="0", expect=400)["field"], "minYears")

    def test_feb_29_join_date_and_year_wrap(self):
        self.make("E11", join_date="2020-02-29", branch=self.b1)
        body = self.get(self.RID, window="m02")
        self.assertEqual([(r["employeeCode"], r["anniversary"], r["yearsCompleted"]) for r in body["rows"]], [("E11", "2026-02-28", 6)])
        self.mock_today.return_value = date(2028, 2, 1)
        self.assertEqual([(r["employeeCode"], r["anniversary"]) for r in self.get(self.RID)["rows"]], [("E11", "2028-02-29")])
        self.make("E12", join_date="03-01-2019", branch=self.b1)  # dd-mm-yyyy text: 3-Jan-2019
        self.mock_today.return_value = date(2026, 12, 20)
        body = self.get(self.RID, window="next30")
        self.assertEqual([(r["employeeCode"], r["anniversary"], r["yearsCompleted"]) for r in body["rows"]], [("E12", "2027-01-03", 8), ("E1", "2027-01-15", 3)])

    def test_ordering_and_filters(self):
        self.make("E11", join_date="2020-01-15", branch=self.b2, department=self.d_cut2, employment_type="production")
        body = self.get(self.RID, window="m01")
        self.assertEqual([(r["employeeCode"], r["yearsCompleted"]) for r in body["rows"]], [("E11", 6), ("E1", 2)])  # same day: more years first
        self.assertEqual(codes(self.get(self.RID, window="m01", employmentType="production")), ["E11"])
        self.assertEqual(codes(self.get(self.RID, window="m01", branchIds=str(self.b2.id))), ["E11"])
        self.assertEqual(codes(self.get(self.RID, window="m01", departmentIds=str(self.d_cut1.id))), ["E1"])
        self.assertEqual(codes(self.get(self.RID, window="m01", designationIds=str(self.des_mgr.id))), ["E1"])

    def test_branch_isolation(self):
        self.make("E11", join_date="2020-01-15", branch=self.b2, department=self.d_cut2)
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, window="m01")), ["E1"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, window="m01", branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# service-milestones
# ═════════════════════════════════════════════════════════════════════════════


class ServiceMilestoneTests(_World):
    RID = "service-milestones"

    def test_golden_default(self):
        body = self.get(self.RID)
        self.assertEqual(codes(body), ["E1", "E2", "E3", "E6", "E8"])  # E7 / E10 have no readable join date
        rows = {r["employeeCode"]: r for r in body["rows"]}
        e1 = rows["E1"]
        self.assertEqual((e1["serviceMonths"], e1["probationEnd"], e1["probationSource"]), (32, "2024-04-15", "Derived"))
        self.assertEqual((e1["clEligibleFrom"], e1["clEligible"]), ("2024-07-15", "Eligible"))
        e6 = rows["E6"]
        self.assertEqual((e6["serviceMonths"], e6["probationEnd"], e6["clEligibleFrom"], e6["clEligible"]), (33, "2024-02-29", "2024-05-30", "Eligible"))
        e3 = rows["E3"]
        self.assertEqual((e3["serviceMonths"], e3["probationEnd"], e3["clEligibleFrom"], e3["clEligible"]), (0, "2026-12-05", "2027-03-05", "Not yet"))
        self.assertEqual((rows["E2"]["clEligible"], rows["E2"]["clEligibleFrom"]), ("Not applicable", None))  # production
        self.assertEqual(rows["E8"]["probationEnd"], "2026-11-30")  # 31-Aug + 3 months, clamped to the month end
        self.assertEqual(
            cards(body),
            {
                "On probation": 3, "Probation ending in 30 days": 0, "Casual leave eligible": 2,
                "Casual leave not yet eligible": 1, "Join date missing (not listed)": 2,
            },
        )  # fmt: skip

    def test_month_end_joiner_matches_the_casual_leave_rule(self):
        self.make("E11", join_date="2026-03-31", branch=self.b1)
        row = next(r for r in self.get(self.RID)["rows"] if r["employeeCode"] == "E11")
        self.assertEqual(row["clEligibleFrom"], "2026-10-01")  # no 31-Sep: the sixth month completes on 1-Oct
        self.assertEqual((row["serviceMonths"], row["clEligible"]), (5, "Not yet"))  # today is 29-Sep

    def test_milestone_filter(self):
        self.assertEqual(codes(self.get(self.RID, milestone="cl_eligible")), ["E1", "E6"])
        self.assertEqual(codes(self.get(self.RID, milestone="cl_not_yet")), ["E3"])
        self.assertEqual(codes(self.get(self.RID, milestone="probation_over")), ["E1", "E6"])
        self.assertEqual(codes(self.get(self.RID, milestone="probation_ending")), [])

    def test_probation_policy_is_a_parameter(self):
        body = self.get(self.RID, probationMonths="1", milestone="probation_ending")  # 1 month: ends 5-Oct / 30-Sep
        self.assertEqual(codes(body), ["E2", "E3", "E8"])
        self.assertEqual(cards(body)["Probation ending in 30 days"], 3)
        body = self.get(self.RID, probationMonths="24", milestone="probation_over")  # 24 months: E1 ended 15-Jan-2026
        self.assertEqual(codes(body), ["E1", "E6"])
        self.assertEqual(body["rows"][0]["probationEnd"], "2026-01-15")

    def test_recorded_dates_beat_derived_ones(self):
        Employee.objects.filter(pk=self.e3.pk).update(probation_end_date=date(2026, 10, 15))
        Employee.objects.filter(pk=self.e2.pk).update(probation_end_date=date(2026, 10, 15), confirmation_date=date(2026, 9, 1))
        body = self.get(self.RID)
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertEqual((rows["E3"]["probationEnd"], rows["E3"]["probationSource"]), ("2026-10-15", "Recorded"))
        self.assertEqual(rows["E2"]["confirmationDate"], "2026-09-01")
        self.assertEqual(cards(body)["On probation"], 2)  # E2 is confirmed -> off probation
        self.assertEqual(codes(self.get(self.RID, milestone="probation_ending")), ["E3"])  # 15-Oct is within 30 days

    def test_scope_filters_and_isolation(self):
        self.assertEqual(codes(self.get(self.RID, employmentType="staff")), ["E1", "E3", "E6"])
        self.assertEqual(codes(self.get(self.RID, employeeStatus="inactive")), ["E4", "E5", "E9"])
        self.assertEqual(codes(self.get(self.RID, branchIds=str(self.b2.id))), ["E3", "E8"])
        self.assertEqual(codes(self.get(self.RID, departmentIds=str(self.d_cut1.id))), ["E1"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user)), ["E1", "E2"])
        self.assertEqual(codes(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])


# ═════════════════════════════════════════════════════════════════════════════
# workforce-profile
# ═════════════════════════════════════════════════════════════════════════════


class WorkforceProfileTests(_World):
    RID = "workforce-profile"

    @staticmethod
    def table(body):
        keys = ("staff", "production", "male", "female", "otherOrUnset", "total")
        return {r["bucket"]: tuple(r[k] for k in keys) for r in body["rows"]}

    def test_age_bands_golden(self):
        body = self.get(self.RID)
        self.assertEqual([r["bucket"] for r in body["rows"]], ["Under 18", "18-25", "26-35", "36-45", "46-55", "56+", "Unknown"])
        self.assertEqual(
            self.table(body),
            {
                "Under 18": (0, 1, 1, 0, 0, 1), "18-25": (0, 1, 0, 1, 0, 1), "26-35": (2, 0, 0, 2, 0, 2),
                "36-45": (1, 0, 1, 0, 0, 1), "46-55": (0, 0, 0, 0, 0, 0), "56+": (1, 0, 1, 0, 0, 1),
                "Unknown": (1, 0, 0, 0, 1, 1),
            },
        )  # fmt: skip
        self.assertEqual(body["totals"]["total"], 7)
        self.assertEqual(sum(r["total"] for r in body["rows"]), 7)
        self.assertEqual(
            cards(body),
            {"Employees": 7, "Average age (years)": 33.2, "Average service (years)": 1.1, "Date of birth unknown": 1, "Join date unknown": 2},
        )

    def test_tenure_bands(self):
        body = self.get(self.RID, dimension="tenureBand")
        self.assertEqual(
            self.table(body),
            {
                "Under 6 months": (1, 2, 1, 2, 0, 3), "6-12 months": (0, 0, 0, 0, 0, 0), "1-3 years": (2, 0, 1, 1, 0, 2),
                "3-5 years": (0, 0, 0, 0, 0, 0), "5+ years": (0, 0, 0, 0, 0, 0), "Unknown": (2, 0, 1, 0, 1, 2),
            },
        )  # fmt: skip

    def test_gender_blood_group_and_salary_type(self):
        body = self.get(self.RID, dimension="gender")
        self.assertEqual({k: v[-1] for k, v in self.table(body).items()}, {"Male": 3, "Female": 3, "Other": 0, "Not set": 1})
        body = self.get(self.RID, dimension="bloodGroup")
        t = self.table(body)
        self.assertEqual({k: v[-1] for k, v in t.items() if v[-1]}, {"A+": 1, "B+": 1, "AB-": 1, "O+": 2, "Unknown": 2})
        self.assertEqual([r["bucket"] for r in body["rows"]][-1], "Unknown")
        body = self.get(self.RID, dimension="salaryType")
        self.assertEqual(self.table(body), {"Monthly": (5, 0, 2, 2, 1, 5), "Weekly": (0, 2, 1, 1, 0, 2), "Unknown": (0, 0, 0, 0, 0, 0)})

    def test_unrecognised_values_get_their_own_row_instead_of_vanishing(self):
        self.make("E11", salary_type="fortnightly", branch=self.b1)
        body = self.get(self.RID, dimension="salaryType")
        self.assertEqual(self.table(body)["Fortnightly"][-1], 1)
        self.assertEqual(sum(r["total"] for r in body["rows"]), 8)

    def test_filters_and_status(self):
        self.assertEqual(self.get(self.RID, employeeStatus="all")["totals"]["total"], 10)
        self.assertEqual(self.get(self.RID, employeeStatus="inactive")["totals"]["total"], 3)
        self.assertEqual(self.get(self.RID, departmentIds=str(self.d_cut1.id))["totals"]["total"], 2)
        self.assertEqual(self.get(self.RID, branchIds=str(self.b2.id))["totals"]["total"], 2)
        self.assertEqual(self.get(self.RID, dimension="bogus", expect=400)["field"], "dimension")

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user)
        self.assertEqual(body["totals"]["total"], 4)  # E1, E2, E7, E10
        self.assertEqual(self.table(body)["Unknown"][-1], 1)
        self.assertEqual(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))["totals"]["total"], 0)


# ═════════════════════════════════════════════════════════════════════════════
# org-structure
# ═════════════════════════════════════════════════════════════════════════════


class OrgStructureTests(_World):
    RID = "org-structure"

    def test_golden(self):
        body = self.get(self.RID)
        labels = [(r["branch"] if r.get("_kind") != "subtotal" else "-", r["department"]) for r in body["rows"]]
        self.assertEqual(
            labels,
            [
                ("Old Unit (inactive)", "SCRAP"), ("-", "Old Unit (inactive) total"),
                ("Unit 1", "CUTTING"), ("Unit 1", "SEWING"), ("-", "Unit 1 total"),
                ("Unit 2", "CUTTING"), ("-", "Unit 2 total"),
                ("No branch", "LEGACY"), ("No branch", "Unassigned (no department)"), ("-", "No branch total"),
            ],
        )  # fmt: skip
        by = {(r["branch"], r["department"]): r for r in body["rows"] if r.get("_kind") != "subtotal"}
        keys = ("designations", "staff", "production", "hods", "required", "vacancy")
        self.assertEqual(tuple(by[("Unit 1", "CUTTING")][k] for k in keys), (1, 2, 0, "Jai Singh", 5, 3))
        self.assertEqual(tuple(by[("Unit 1", "SEWING")][k] for k in keys), (2, 1, 1, "Arun Kumar", 1, 0))  # plan met: vacancy 0, not blank
        self.assertEqual(tuple(by[("Unit 2", "CUTTING")][k] for k in keys), (0, 1, 1, None, None, None))  # inactive HOD; plan 0 = not planned
        self.assertEqual(by[("Old Unit (inactive)", "SCRAP")]["branchCode"], "OLD")
        self.assertEqual(by[("No branch", "Unassigned (no department)")]["staff"], 1)  # E6 has no department
        sub = {r["department"]: r for r in body["rows"] if r.get("_kind") == "subtotal"}
        self.assertEqual((sub["Unit 1 total"]["designations"], sub["Unit 1 total"]["staff"], sub["Unit 1 total"]["production"], sub["Unit 1 total"]["required"], sub["Unit 1 total"]["vacancy"]), (3, 3, 1, 6, 3))
        self.assertEqual(body["totals"], {"designations": 3, "staff": 5, "production": 2, "required": 6, "vacancy": 3})
        self.assertEqual(cards(body), {"Branches": 4, "Departments": 5, "Active employees": 7, "Planned positions": 6, "Open vacancies": 3})

    def test_totals_equal_the_rows(self):
        body = self.get(self.RID)
        rows = data_rows(body)
        for k in ("designations", "staff", "production", "required", "vacancy"):
            self.assertEqual(body["totals"][k], sum(r[k] or 0 for r in rows), k)
        self.assertEqual(body["totals"]["staff"] + body["totals"]["production"], 7)  # every active employee is counted once

    def test_inactive_employees_are_not_counted_and_hod_row_must_be_active(self):
        rows = {(r["branch"], r["department"]): r for r in data_rows(self.get(self.RID))}
        self.assertEqual(rows[("Unit 1", "SEWING")]["production"], 1)  # E5 (inactive production) not counted
        self.assertEqual(rows[("Unit 1", "SEWING")]["staff"], 1)  # E4 (inactive) not counted

    def test_branch_and_department_filters(self):
        body = self.get(self.RID, branchIds=str(self.b2.id))
        self.assertEqual([(r["branch"], r["department"]) for r in data_rows(body)], [("Unit 2", "CUTTING")])
        self.assertEqual((data_rows(body)[0]["staff"], data_rows(body)[0]["production"]), (1, 1))
        body = self.get(self.RID, departmentIds=str(self.d_sew1.id))
        self.assertEqual([(r["branch"], r["department"]) for r in data_rows(body)], [("Unit 1", "SEWING")])

    def test_branch_isolation(self):
        body = self.get(self.RID, user=self.branch_user)
        self.assertEqual([(r["branch"], r["department"]) for r in data_rows(body)], [("Unit 1", "CUTTING"), ("Unit 1", "SEWING")])
        self.assertEqual((body["totals"]["staff"], body["totals"]["production"]), (3, 1))
        text = str(body)
        for hidden in ("Unit 2", "Old Unit", "LEGACY", "SCRAP", "No branch"):
            self.assertNotIn(hidden, text)
        self.assertEqual(data_rows(self.get(self.RID, user=self.branch_user, branchIds=str(self.b2.id))), [])

    def test_employee_in_a_department_of_another_branch_still_counts(self):
        # legacy data: an employee of Unit 1 sitting in Unit 2's department must not vanish from the totals
        self.make("E11", branch=self.b1, department=self.d_cut2)
        body = self.get(self.RID, user=self.branch_user)
        cutting2 = next(r for r in data_rows(body) if r["branch"] == "Unit 2")
        self.assertEqual(cutting2["staff"], 1)
        self.assertEqual(body["totals"]["staff"] + body["totals"]["production"], 5)


# ═════════════════════════════════════════════════════════════════════════════
# Cross-cutting contract: exports, empty results, query counts, isolation
# ═════════════════════════════════════════════════════════════════════════════

WIDE = {
    "employee-master": {"employeeStatus": "all", "layout": "full"},
    "employee-contact-list": {"employeeStatus": "all"},
    "strength-statement": {"employeeStatus": "all"},
    "new-joinings": {"dateFrom": "2019-01-01", "dateTo": "2026-12-31"},
    "exits-register": {"dateFrom": "2025-01-01", "dateTo": "2026-12-31"},
    "resignation-register": {"dateFrom": "2026-08-01", "dateTo": "2026-09-29", "layout": "full"},
    "manpower-movement": {"year": "2026"},
    "statutory-compliance": {"employeeStatus": "all", "includeCompliant": "true"},
    "data-quality-audit": {"employeeStatus": "all", "includeClean": "true"},
    "birthdays": {"window": "next30"},
    "work-anniversaries": {"window": "thisMonth"},
    "service-milestones": {"employeeStatus": "all"},
    "age-compliance": {"employeeStatus": "all", "show": "all"},
    "workforce-profile": {"employeeStatus": "all"},
    "family-dependents": {"employeeStatus": "all"},
    "org-structure": {},
}
# Reports that always return a fixed grid of rows (all 12 months / all age bands) even when nothing matches.
FIXED_GRID = {"manpower-movement", "workforce-profile"}


class ContractTests(_World):
    def test_xlsx_round_trip_for_every_report(self):
        for rid in MY_REPORTS:
            body = self.get(rid, **WIDE[rid])
            r = self.export(rid, "xlsx", **WIDE[rid])
            self.assertTrue(r.content.startswith(b"PK"), rid)
            ws = load_workbook(io.BytesIO(r.content)).active
            header = [c.value for c in ws[7]]
            self.assertEqual(header, [c["label"] for c in body["columns"]], rid)
            self.assertIsNotNone(ws["A3"].value)
            if not body["rows"]:
                continue
            # the first TEXT column of the first data row round-trips exactly
            idx = next((i for i, c in enumerate(body["columns"]) if c["type"] == "text" and body["rows"][0].get(c["key"])), None)
            if idx is not None:
                self.assertEqual(ws.cell(row=8, column=idx + 1).value, body["rows"][0][body["columns"][idx]["key"]], rid)
            self.assertGreaterEqual(ws.max_row, 8 + len(body["rows"]) - 1, rid)

    def test_pdf_for_every_report(self):
        for rid in MY_REPORTS:
            r = self.export(rid, "pdf", **WIDE[rid])
            self.assertTrue(r.content.startswith(b"%PDF"), rid)
            self.assertIn("application/pdf", r["Content-Type"], rid)
            self.assertGreater(len(r.content), 1500, rid)

    def test_identifiers_stay_text_cells_in_excel(self):
        ws = load_workbook(io.BytesIO(self.export("statutory-compliance", "xlsx", **WIDE["statutory-compliance"]).content)).active
        header = [c.value for c in ws[7]]
        col = header.index("UAN") + 1
        cells = {ws.cell(row=r, column=1).value: ws.cell(row=r, column=col) for r in range(8, ws.max_row + 1)}
        self.assertEqual(cells["E1"].value, "100000000001")
        self.assertEqual(cells["E1"].data_type, "s")
        self.assertEqual(ws.cell(row=8, column=1).data_type, "s")

    def test_empty_results_work_on_screen_and_in_both_exports(self):
        for rid in MY_REPORTS:
            params = {**WIDE[rid], "departmentIds": "999999"}
            body = self.get(rid, **params)
            if rid not in FIXED_GRID:
                self.assertEqual(body["rows"], [], rid)
                self.assertEqual(body["rowCount"], 0, rid)
            else:
                self.assertTrue(all(all(not v for k, v in r.items() if k not in ("group", "bucket", "exitRatePct", "sharePct")) for r in body["rows"]), rid)
            for fmt in ("xlsx", "pdf"):
                self.assertEqual(self.export(rid, fmt, **params).status_code, 200, (rid, fmt))

    def test_no_query_count_growth_with_more_employees(self):
        # Warm caches first (roles, settings), then compare 10 employees against 22.
        variants = {rid: [WIDE[rid]] for rid in MY_REPORTS}
        variants["strength-statement"] = [{"groupBy": g, "employeeStatus": "all", "includeEmpty": "true"} for g in ("department", "designation", "branch")]
        variants["manpower-movement"] = [{"year": "2026", "groupBy": g} for g in ("month", "department")]
        variants["workforce-profile"] = [{"dimension": d, "employeeStatus": "all"} for d in ("ageBand", "tenureBand", "gender", "bloodGroup", "salaryType")]
        variants["work-anniversaries"] = [{"window": "thisMonth"}, {"window": "next30"}]

        def measure():
            out = {}
            for rid, plist in variants.items():
                for i, params in enumerate(plist):
                    self.client.get(f"/api/reports/run/{rid}", params, **hdr(self.admin))  # warm-up
                    with CaptureQueriesContext(connection) as q:
                        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(self.admin))
                    self.assertEqual(r.status_code, 200, (rid, params))
                    out[(rid, i)] = len(q)
            return out

        before = measure()
        for i in range(12):
            e = self.make(
                f"X{i}", first_name=f"Xa{i}", employment_type="staff" if i % 2 else "production", gender=("male", "female", None)[i % 3],
                status="active" if i % 3 else "inactive", branch=(self.b1, self.b2)[i % 2],
                department=(self.d_cut1, self.d_sew1, self.d_cut2)[i % 3], designation=(None, self.des_op, self.des_mgr)[i % 3],
                join_date=f"2026-09-{i + 1:02d}", date_of_birth=date(1985 + i, (i % 12) + 1, i + 1), phone=f"90000000{i:02d}",
                pf_number=f"PF{i}", bank_account=f"1234567{i:03d}", bank_ifsc="HDFC0001234", salary_amount=Decimal("1000"),
            )  # fmt: skip
            self.doc(e, "pan_card")
            FamilyDependent.objects.create(employee=e, name=f"Dep{i}", relation="child", date_of_birth=date(2015, 1, 1))
            if e.status != "active":
                ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 9, 1 + i), reason="x")
            else:
                ResignationRequest.objects.create(employee=e, status="pending", reason="y")
            SalarySlip.objects.create(employee=e, month=8, year=2026, slip_number=f"S-X{i}", pf_deduction=10)
        after = measure()
        for key, n in before.items():
            self.assertLessEqual(after[key] - n, 2, f"{key}: {n} -> {after[key]} queries")

    def test_branch_isolation_across_every_employee_level_report(self):
        # Give every date-driven report something to show in BOTH units.
        self.make("E11", date_of_birth=date(1985, 10, 3), join_date="2020-09-12", branch=self.b2, department=self.d_cut2)
        self.make("E12", date_of_birth=date(1985, 10, 4), join_date="2020-09-13", branch=self.b1, department=self.d_cut1)
        FamilyDependent.objects.create(employee=self.e1, name="Priya", relation="spouse")
        FamilyDependent.objects.create(employee=self.e3, name="Lakshmi", relation="mother")
        wide = {**WIDE, "birthdays": {"window": "next30"}, "work-anniversaries": {"window": "thisMonth"}}
        b2_only = {"E3", "E6", "E8", "E9", "E11", "Lakshmi"}
        for rid in MY_REPORTS:
            if rid in ("strength-statement", "manpower-movement", "workforce-profile", "org-structure"):
                continue
            admin_body = self.get(rid, **wide[rid])
            scoped = self.get(rid, user=self.branch_user, **wide[rid])
            self.assertTrue(b2_only & {str(v) for r in admin_body["rows"] for v in r.values()}, f"{rid}: fixture shows nothing from other units")
            leaked = b2_only & {str(v) for r in scoped["rows"] for v in r.values()}
            self.assertFalse(leaked, f"{rid} leaks {leaked}")
            # a scoped user cannot widen the scope with params
            for extra in ({"branchIds": str(self.b2.id)}, {"employeeIds": ",".join(str(e.id) for e in (self.e3, self.e6, self.e8, self.e9))}):
                widened = self.get(rid, user=self.branch_user, **wide[rid], **extra)
                self.assertFalse(b2_only & {str(v) for r in widened["rows"] for v in r.values()}, f"{rid} {extra}")

    def test_reports_never_write(self):
        before = (Employee.objects.count(), ResignationRequest.objects.count(), list(Employee.objects.values_list("pk", "updated_at").order_by("pk")))
        for rid in MY_REPORTS:
            self.get(rid, **WIDE[rid])
            self.export(rid, "xlsx", **WIDE[rid])
        after = (Employee.objects.count(), ResignationRequest.objects.count(), list(Employee.objects.values_list("pk", "updated_at").order_by("pk")))
        self.assertEqual(before, after)

    def test_exports_are_audited_and_row_counts_match(self):
        from .models import AuditLog

        n = AuditLog.objects.filter(action="export", module="reports").count()
        self.export("employee-master", "xlsx", employeeStatus="all")
        self.assertEqual(AuditLog.objects.filter(action="export", module="reports").count(), n + 1)
        log = AuditLog.objects.filter(action="export", module="reports").latest("id")
        self.assertIn("Employee Master Register", log.record_description)
        self.assertIn("10 rows", log.record_description)
