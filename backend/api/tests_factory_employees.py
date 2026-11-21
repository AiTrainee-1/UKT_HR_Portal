"""Employees -> Factory Employees (owner 2026-11-20): the list, create, add / remove, labels, history, rights, branch
scope, and that a factory employee is an ordinary employee for both payrolls.

Run via: python manage.py test api.tests_factory_employees
"""

from datetime import date
from decimal import Decimal

from django.test import TestCase

from .attendance_final import _holiday_dates_for_month
from .clock import ist_today
from .jwt_utils import sign_token
from .models import Branch, Employee, EmployeeShiftAssignment, FactoryLabel, HRUser, Payroll, Role, ShiftTemplate
from .payroll_views import _generate_production_payroll, _generate_staff_payroll
from .permission_registry import resolve_module
from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _day, _present_all

URL = "/api/employees/factory"


def _token(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"}


class _FactoryBase(TestCase):
    def setUp(self):
        _configure(staff_pf_rules=[], staff_esi_rules=[], attendance_mode="simple", prod_late_detection_enabled=False)
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        _holiday_dates_for_month.cache_clear()
        self.branch = Branch.objects.create(name="FE Head Office", code="FE_HO", is_head_office=True)
        self.other = Branch.objects.create(name="FE Unit", code="FE_U9")
        self.admin = HRUser.objects.create(username="fe_admin", password_hash="x", is_super_admin=True)
        self.auth = _token(self.admin)
        self.driver = FactoryLabel.objects.get_or_create(name="Driver", defaults={"color": "#2563eb"})[0]

    def post(self, path, body, auth=None):
        return self.client.post(URL + path, body, content_type="application/json", **(auth or self.auth))

    def create(self, code="FE1", **extra):
        body = {
            "employeeCode": code, "firstName": "Murugan", "lastName": "K", "phone": "9876500011",
            "employmentType": "staff", "branchId": self.branch.id, "salaryAmount": "18000", "labelId": self.driver.id,
            **extra,
        }  # fmt: skip
        return self.post("", body)


class FactoryEmployeesTests(_FactoryBase):
    def test_create_makes_an_ordinary_employee_with_the_label(self):
        res = self.create()
        self.assertEqual(res.status_code, 201, res.content)
        row = res.json()
        self.assertEqual(
            (row["code"], row["label"], row["employmentType"], row["isFactory"]), ("FE1", "Driver", "staff", True)
        )
        self.assertTrue(row["payrollReady"])
        emp = Employee.objects.get(employee_code="FE1")
        # the employee create rules ran: the automatic 50/50 salary split and a Unit Code
        self.assertEqual(emp.salary_basic + emp.salary_da + emp.salary_retaining_allowance, Decimal("9000.00"))
        self.assertTrue(emp.unit_code)
        # and the usual refusals come back as they are
        self.assertIn("already exists", self.create().json()["error"])
        self.assertIn("Phone", self.create(code="FE2", phone="").json()["error"])

    def test_list_filters_counts_and_shift(self):
        a = Employee.objects.get(pk=self.create("FE1").json()["id"])
        self.create("FE2", labelId=None)
        shift = ShiftTemplate.objects.create(name="FE General", start_time="09:00", end_time="18:00")
        EmployeeShiftAssignment.objects.create(employee=a, shift=shift, effective_from=date(2026, 1, 1))
        Employee.objects.create(employee_code="NOTFE", first_name="Other", last_name="X", branch=self.branch)
        body = self.client.get(URL, **self.auth).json()
        self.assertEqual({r["code"] for r in body["employees"]}, {"FE1", "FE2"})
        self.assertEqual(body["counts"]["byLabel"], {str(self.driver.id): 1})
        self.assertEqual(body["counts"]["unlabeled"], 1)
        row = next(r for r in body["employees"] if r["code"] == "FE1")
        self.assertEqual((row["shift"]["name"], row["shift"]["startTime"]), ("FE General", "09:00"))
        only = self.client.get(URL, {"labelId": "none"}, **self.auth).json()["employees"]
        self.assertEqual([r["code"] for r in only], ["FE2"])
        self.assertEqual(body["counts"]["total"], 2)
        labels = {label["name"]: label["employees"] for label in body["labels"]}
        self.assertEqual(labels["Driver"], 1)

    def test_add_existing_label_and_remove(self):
        emp = Employee.objects.create(employee_code="EX1", first_name="Selvi", last_name="R", branch=self.branch)
        cands = self.client.get(URL + "/candidates", {"search": "selvi"}, **self.auth).json()["employees"]
        self.assertEqual([c["code"] for c in cands], ["EX1"])
        self.assertEqual(self.post("/add", {"employeeIds": [emp.id], "labelId": self.driver.id}).json()["updated"], 1)
        emp.refresh_from_db()
        self.assertTrue(emp.is_factory)
        chef = FactoryLabel.objects.get_or_create(name="Chef")[0]
        self.post("/label", {"employeeIds": [emp.id], "labelId": chef.id})
        emp.refresh_from_db()
        self.assertEqual(emp.factory_label_id, chef.id)
        self.post("/remove", {"employeeIds": [emp.id]})
        emp.refresh_from_db()
        self.assertEqual((emp.is_factory, emp.factory_label_id), (False, None))
        self.assertTrue(Employee.objects.filter(pk=emp.pk).exists())  # still an employee
        history = self.client.get(f"{URL}/{emp.id}/history", **self.auth).json()["items"]
        self.assertEqual(len(history), 5)  # added, DRIVER applied, label Chef, CHEF applied, removed
        self.assertIn("Removed from Factory Employees", history[0]["description"])

    def test_labels_crud(self):
        res = self.post("/labels", {"name": "Gardener"})
        self.assertEqual(res.status_code, 201)
        label = res.json()
        self.assertRegex(label["color"], r"^#[0-9a-f]{6}$")
        self.assertIn("already exists", self.post("/labels", {"name": "gardener"}).json()["error"])
        res = self.client.patch(f"{URL}/labels/{label['id']}", {"name": "Garden", "color": "#123456"},
                                content_type="application/json", **self.auth)  # fmt: skip
        self.assertEqual((res.json()["name"], res.json()["color"]), ("Garden", "#123456"))
        emp = Employee.objects.get(pk=self.create("FE5", labelId=label["id"]).json()["id"])
        res = self.client.delete(f"{URL}/labels/{label['id']}", **self.auth)
        self.assertEqual((res.status_code, res.json()["employees"]), (409, 1))
        res = self.client.delete(f"{URL}/labels/{label['id']}?unassign=1", **self.auth)
        self.assertEqual(res.status_code, 204)
        emp.refresh_from_db()
        self.assertIsNone(emp.factory_label_id)

    def test_factory_employees_are_paid_by_their_payroll_like_anyone(self):
        staff = Employee.objects.get(pk=self.create("FE_S", salaryAmount="24000").json()["id"])
        _present_all(staff)
        p = _generate_staff_payroll(staff, MONTH, YEAR)["payroll"]
        self.assertEqual(p.final_salary, Decimal("24000.00"))
        prod = Employee.objects.get(
            pk=self.create("FE_P", employmentType="production", salaryAmount=None, salaryPerShift="500").json()["id"]
        )
        row = next(r for r in self.client.get(URL, **self.auth).json()["employees"] if r["code"] == "FE_P")
        self.assertEqual(row["payrollIssue"], "No pay cycle (in no Production Payroll yet)")
        for d in WORKING_DAYS[:3]:
            _day(prod, d)
        p = _generate_production_payroll(prod, WORKING_DAYS[0], WORKING_DAYS[0].replace(day=7))["payroll"]
        self.assertEqual(p.gross_salary, Decimal("1500.00"))
        self.assertTrue(Payroll.objects.filter(employee=prod).exists())

    def test_rights_and_branch_scope(self):
        self.assertEqual(resolve_module("employees/factory"), "employees.factory")
        self.assertEqual(resolve_module("employees/factory/labels/3"), "employees.factory")
        role = Role.objects.create(name="FE viewer", permissions={"employees.factory": "view"})
        viewer = HRUser.objects.create(username="fe_viewer", password_hash="x", role=role)
        body = self.client.get(URL, **_token(viewer))
        self.assertEqual(body.status_code, 200)
        self.assertFalse(body.json()["canEdit"])
        self.assertEqual(self.post("/labels", {"name": "Nope"}, auth=_token(viewer)).status_code, 403)
        unit_role = Role.objects.create(name="FE unit", permissions={"employees": "edit"})
        unit = HRUser.objects.create(username="fe_unit", password_hash="x", role=unit_role, branch=self.other)
        self.create("FE_HO1")
        self.assertEqual(self.client.get(URL, **_token(unit)).json()["employees"], [])
        ho_emp = Employee.objects.get(employee_code="FE_HO1")
        res = self.post("/remove", {"employeeIds": [ho_emp.id]}, auth=_token(unit))
        self.assertEqual(res.status_code, 400)
        ho_emp.refresh_from_db()
        self.assertTrue(ho_emp.is_factory)


class FactoryShiftsAndPayrollTests(_FactoryBase):
    """Owner 2026-11-20 corrections: existing shifts only (assign / remove), and the payroll category with the Production
    Payroll frequency, both with this page's own rights."""

    def emp(self, code, **extra):
        return Employee.objects.get(pk=self.create(code, **extra).json()["id"])

    def test_shifts_list_assign_and_remove(self):
        shift = ShiftTemplate.objects.create(name="FE Day", start_time="09:00", end_time="18:00")
        a = self.emp("FS1")
        body = self.client.get(URL + "/shifts", **self.auth).json()
        day = next(s for s in body["shifts"] if s["id"] == shift.id)
        self.assertEqual(day["employees"], [])
        # wherever the new employee is now (a default shift or none), they are listed once
        placed = [p["code"] for s in body["shifts"] for p in s["employees"]] + [p["code"] for p in body["noShift"]]
        self.assertEqual(placed.count("FS1"), 1)
        plan = self.post("/shifts/plan", {"shiftId": shift.id, "employeeIds": [a.id]})
        self.assertEqual(plan.status_code, 200, plan.content)
        res = self.post("/shifts/apply", {"shiftId": shift.id, "employeeIds": [a.id]})
        self.assertIn(res.status_code, (200, 201), res.content)
        body = self.client.get(URL + "/shifts", **self.auth).json()
        day = next(s for s in body["shifts"] if s["id"] == shift.id)
        self.assertEqual([p["code"] for p in day["employees"]], ["FS1"])
        res = self.post("/shifts/remove", {"employeeIds": [a.id]})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["ended"], 1)
        body = self.client.get(URL + "/shifts", **self.auth).json()
        day = next(s for s in body["shifts"] if s["id"] == shift.id)
        # on it up to and including today (today's attendance keeps it), off it from tomorrow
        self.assertEqual(day["employees"][0]["effectiveTo"], ist_today().isoformat())
        # never a non-factory employee
        other = Employee.objects.create(employee_code="NOTF", first_name="N", last_name="F", branch=self.branch)
        self.assertEqual(self.post("/shifts/apply", {"shiftId": shift.id, "employeeIds": [other.id]}).status_code, 400)

    def test_production_needs_a_frequency_and_lands_on_that_cycle(self):
        a = self.emp("FP1")
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "production", "salaryPerShift": "450"})
        self.assertEqual(res.status_code, 400)
        self.assertIn("Weekly, BiWeekly or Monthly", res.json()["error"])
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "production", "payCycle": "biweekly",
                                     "salaryPerShift": "450"})  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        a.refresh_from_db()
        self.assertEqual(
            (a.employment_type, a.production_pay_cycle, a.salary_per_shift),
            ("production", "biweekly", Decimal("450.00")),
        )
        row = res.json()["updated"][0]
        self.assertTrue(row["payrollReady"])
        # back to Staff Payroll: monthly, off every production cycle
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "staff", "salaryAmount": "21000"})
        self.assertEqual(res.status_code, 200, res.content)
        a.refresh_from_db()
        self.assertEqual(
            (a.employment_type, a.production_pay_cycle, a.salary_amount), ("staff", None, Decimal("21000.00"))
        )
        self.assertEqual(a.salary_basic + a.salary_da + a.salary_retaining_allowance, Decimal("10500.00"))

    def test_a_worker_with_payroll_moves_cycle_only_with_a_reason(self):
        a = self.emp("FP2", employmentType="production", salaryAmount=None, salaryPerShift="500")
        self.post("/payroll", {"employeeIds": [a.id], "category": "production", "payCycle": "weekly"})
        for d in WORKING_DAYS[:3]:
            _day(a, d)
        _generate_production_payroll(a, WORKING_DAYS[0], WORKING_DAYS[0].replace(day=8), pay_cycle="weekly")
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "production", "payCycle": "monthly"})
        self.assertEqual((res.status_code, res.json()["code"]), (409, "confirm_cycle_change"))
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "production", "payCycle": "monthly",
                                     "confirm": True, "reason": "Moved to the monthly team"})  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        a.refresh_from_db()
        self.assertEqual(a.production_pay_cycle, "monthly")
        from .models import ProductionCycleTransfer

        self.assertTrue(ProductionCycleTransfer.objects.filter(employee=a, to_cycle="monthly").exists())

    def test_the_page_key_is_enough_for_shifts_and_payroll(self):
        role = Role.objects.create(name="FE only", permissions={"employees.factory": "edit"})
        hr = HRUser.objects.create(username="fe_only", password_hash="x", role=role)
        auth = _token(hr)
        a = self.emp("FK1")
        shift = ShiftTemplate.objects.create(name="FE Night", start_time="20:00", end_time="05:00")
        self.assertEqual(self.client.get(URL + "/shifts", **auth).status_code, 200)
        res = self.post("/shifts/apply", {"shiftId": shift.id, "employeeIds": [a.id]}, auth=auth)
        self.assertIn(res.status_code, (200, 201), res.content)
        res = self.post("/payroll", {"employeeIds": [a.id], "category": "production", "payCycle": "weekly",
                                     "salaryPerShift": "400"}, auth=auth)  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        viewer = HRUser.objects.create(username="fe_view2", password_hash="x",
                                       role=Role.objects.create(name="FE v2", permissions={"employees.factory": "view"}))  # fmt: skip
        self.assertEqual(
            self.post("/shifts/plan", {"shiftId": shift.id, "employeeIds": [a.id]}, auth=_token(viewer)).status_code,
            200,
        )
        self.assertEqual(self.post("/shifts/remove", {"employeeIds": [a.id]}, auth=_token(viewer)).status_code, 403)


class LabelIsDepartmentTests(_FactoryBase):
    """Owner 2026-11-20: a factory employee's label is their department and designation everywhere in the HRMS."""

    def test_the_label_becomes_department_and_designation_and_the_employees_page_shows_it(self):
        from .models import Department

        admin = Department.objects.create(name="FE ADMIN", branch=self.branch, category="staff")
        emp = Employee.objects.create(
            employee_code="LD1", first_name="Surya", last_name="M", branch=self.branch, department=admin,
            salary_amount=Decimal("16000"),
        )  # fmt: skip
        res = self.post("/add", {"employeeIds": [emp.id], "labelId": self.driver.id})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["moved"][0]["code"], "LD1")
        emp.refresh_from_db()
        self.assertEqual((emp.department.name, emp.designation.title), ("DRIVER", "DRIVER"))
        self.assertEqual((emp.department.category, emp.department.branch_id), ("staff", self.branch.id))
        # the main Employees list shows it
        rows = self.client.get("/api/employees", {"search": "LD1"}, **self.auth).json()
        rows = rows["employees"] if isinstance(rows, dict) and "employees" in rows else rows
        rows = rows["results"] if isinstance(rows, dict) else rows
        row = next(r for r in rows if r.get("employeeCode") == "LD1")
        self.assertEqual(row.get("departmentName"), "DRIVER")
        # a second driver reuses the same department and designation
        other = Employee.objects.get(pk=self.create("LD2").json()["id"])
        self.assertEqual((other.department_id, other.designation_id), (emp.department_id, emp.designation_id))

    def test_changing_the_label_moves_them_and_removing_it_keeps_them(self):
        emp = Employee.objects.get(pk=self.create("LD3").json()["id"])
        chef = FactoryLabel.objects.get_or_create(name="Chef")[0]
        self.post("/label", {"employeeIds": [emp.id], "labelId": chef.id})
        emp.refresh_from_db()
        self.assertEqual(emp.department.name, "CHEF")
        self.post("/label", {"employeeIds": [emp.id], "labelId": None})
        emp.refresh_from_db()
        self.assertEqual((emp.factory_label_id, emp.department.name), (None, "CHEF"))

    def test_switching_to_production_uses_the_production_kind(self):
        emp = Employee.objects.get(pk=self.create("LD4").json()["id"])
        res = self.post("/payroll", {"employeeIds": [emp.id], "category": "production", "payCycle": "weekly",
                                     "salaryPerShift": "450"})  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        emp.refresh_from_db()
        self.assertEqual((emp.department.name, emp.department.category), ("DRIVER", "production"))
        self.assertEqual((emp.designation.title, emp.designation.category), ("DRIVER", "production"))

    def test_renaming_the_label_renames_its_own_department(self):
        label = self.post("/labels", {"name": "Gardener"}).json()
        emp = Employee.objects.get(pk=self.create("LD5", labelId=label["id"]).json()["id"])
        self.assertEqual(emp.department.name, "GARDENER")
        dept_id = emp.department_id
        res = self.client.patch(f"{URL}/labels/{label['id']}", {"name": "Garden Staff"}, content_type="application/json",
                                **self.auth)  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        emp.refresh_from_db()
        self.assertEqual(
            (emp.department_id, emp.department.name, emp.designation.title), (dept_id, "GARDEN STAFF", "GARDEN STAFF")
        )
