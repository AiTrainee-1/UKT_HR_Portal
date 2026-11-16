"""Staff and Production departments / designations (owner, 2026-11-16; org_category.py).

* the data migration 0150 (split_org_categories): mixed departments are split, production-only ones become Production,
  designations follow, the HOD links / department holidays / compensation days / shift templates / promotions of a split
  department are carried over, and a second run changes nothing;
* the server rules: a department's kind on create / edit (only an empty one can switch), designations of their
  department's kind, case-insensitive duplicates per (name, branch, kind), an employee's department and designation of
  the employee's kind on create / edit / assign / promotion, name lookups (the bulk upload) within the kind;
* the ``?category=`` filter and the ``category`` field on every departments / designations endpoint.

Run via: DATABASE_URL= DB_TEST_NAME=test_uktex_orgcat py -3 manage.py test api.tests_org_category --noinput
"""

import importlib
import json
from datetime import date

from django.apps import apps as django_apps
from django.test import TestCase

from .jwt_utils import sign_token
from .models import (
    Branch,
    CompensationDayAnnouncement,
    Department,
    DepartmentManager,
    Designation,
    Employee,
    Holiday,
    HRUser,
    ManagerDepartmentAssignment,
    Promotion,
    Role,
    ShiftTemplate,
)
from .org_lookup import OrgLookup

MIGRATION = importlib.import_module("api.migrations.0150_org_category_split")


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _emp(code, branch, dept=None, desig=None, kind="staff", status="active"):
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Cat",
        phone="9000000000",
        employment_type=kind,
        status=status,
        branch=branch,
        department=dept,
        designation=desig,
    )


class _Api(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="cat_admin", password_hash="x", is_super_admin=True)
        self.unit1 = Branch.objects.create(name="CAT Unit1", code="CATU1")
        self.unit2 = Branch.objects.create(name="CAT Unit2", code="CATU2")

    def get(self, path, user=None):
        return self.client.get(path, **_bearer(user or self.admin))

    def send(self, method, path, body, user=None):
        return getattr(self.client, method)(
            path, json.dumps(body), content_type="application/json", **_bearer(user or self.admin)
        )


# ── The data migration ──────────────────────────────────────────────────────


class MigrationSplitTests(TestCase):
    """The dev database's shapes: a mixed CUTTING (staff + production, one production inactive), a production-only
    SEWING, a staff-only ACCOUNTS, an empty STORE; a HOD over CUTTING, a CUTTING holiday and compensation day, a
    production shift template on CUTTING, and a production worker's promotion into CUTTING."""

    def setUp(self):
        self.unit1 = Branch.objects.create(name="MIG Unit1", code="MIGU1")
        self.cutting = Department.objects.create(name="CUTTING", description="Cut room", branch=self.unit1)
        self.sewing = Department.objects.create(name="SEWING", branch=self.unit1)
        self.accounts = Department.objects.create(name="ACCOUNTS", branch=self.unit1)
        self.store = Department.objects.create(name="STORE", branch=self.unit1)
        self.master = Designation.objects.create(title="Cutting Master", department=self.cutting)
        self.loose = Designation.objects.create(title="Helper", department=None)
        self.s1 = _emp("MS1", self.unit1, self.cutting, self.master, "staff")
        self.s2 = _emp("MS2", self.unit1, self.cutting, None, "staff")
        self.p1 = _emp("MP1", self.unit1, self.cutting, None, "production")
        self.p2 = _emp("MP2", self.unit1, self.cutting, self.master, "production")  # a staff title, see below
        self.p3 = _emp("MP3", self.unit1, self.cutting, None, "production", status="inactive")
        self.p4 = _emp("MP4", self.unit1, self.sewing, self.loose, "production")
        self.a1 = _emp("MA1", self.unit1, self.accounts, None, "staff")
        hod_emp = _emp("MH1", self.unit1, self.accounts, None, "staff")
        self.hod = DepartmentManager.objects.create(employee=hod_emp)
        ManagerDepartmentAssignment.objects.create(manager=self.hod, department=self.cutting)
        Holiday.objects.create(name="Cutting day", date=date(2026, 12, 1), department=self.cutting, branch=self.unit1)
        CompensationDayAnnouncement.objects.create(date=date(2026, 12, 2), department=self.cutting)
        listed = CompensationDayAnnouncement.objects.create(date=date(2026, 12, 3), department=self.cutting)
        listed.employees.add(self.p1)
        self.prod_shift = ShiftTemplate.objects.create(
            name="Cut night", shift_type="production", start_time="20:00", end_time="05:00", department=self.cutting
        )
        self.staff_shift = ShiftTemplate.objects.create(
            name="Cut day", shift_type="staff", start_time="09:00", end_time="18:00", department=self.cutting
        )
        Promotion.objects.create(
            employee=self.p1,
            new_department=self.cutting,
            previous_department=self.sewing,
            effective_date=date(2026, 1, 1),
        )

    def run_split(self):
        return MIGRATION.split_org_categories(django_apps)

    def copy_of_cutting(self):
        return Department.objects.get(name="CUTTING", branch=self.unit1, category="production")

    def test_a_mixed_department_is_split_and_production_moves_to_the_copy(self):
        stats = self.run_split()
        self.cutting.refresh_from_db()
        self.assertEqual(self.cutting.category, "staff")
        copy = self.copy_of_cutting()
        self.assertEqual((copy.description, copy.branch_id), ("Cut room", self.unit1.id))
        self.assertEqual(
            set(Employee.objects.filter(department=self.cutting).values_list("employee_code", flat=True)),
            {"MS1", "MS2"},
        )
        # every production employee, the inactive one too
        self.assertEqual(
            set(Employee.objects.filter(department=copy).values_list("employee_code", flat=True)), {"MP1", "MP2", "MP3"}
        )
        self.assertEqual((stats["departments_split"], stats["employees_moved"]), (1, 3))

    def test_one_kind_departments_take_that_kind_and_empty_ones_stay_staff(self):
        self.run_split()
        self.assertEqual(Department.objects.get(pk=self.sewing.pk).category, "production")
        self.assertEqual(Department.objects.get(pk=self.accounts.pk).category, "staff")
        self.assertEqual(Department.objects.get(pk=self.store.pk).category, "staff")

    def test_the_heads_of_the_original_also_head_the_copy(self):
        self.run_split()
        self.assertTrue(ManagerDepartmentAssignment.objects.filter(manager=self.hod, department=self.cutting).exists())
        self.assertTrue(
            ManagerDepartmentAssignment.objects.filter(manager=self.hod, department=self.copy_of_cutting()).exists()
        )

    def test_department_holidays_and_compensation_days_are_copied_shift_and_promotion_follow(self):
        self.run_split()
        copy = self.copy_of_cutting()
        self.assertEqual(Holiday.objects.filter(department=copy, name="Cutting day").count(), 1)
        self.assertEqual(Holiday.objects.filter(department=self.cutting).count(), 1)
        # only the announcement with no employee list is per department
        self.assertEqual(
            list(CompensationDayAnnouncement.objects.filter(department=copy).values_list("date", flat=True)),
            [date(2026, 12, 2)],
        )
        self.assertEqual(ShiftTemplate.objects.get(pk=self.prod_shift.pk).department_id, copy.id)
        self.assertEqual(ShiftTemplate.objects.get(pk=self.staff_shift.pk).department_id, self.cutting.id)
        promo = Promotion.objects.get(employee=self.p1)
        self.assertEqual(promo.new_department_id, copy.id)
        self.assertEqual(promo.previous_department_id, self.sewing.id)  # not the split department: untouched

    def test_designations_follow_their_department_and_wrong_kind_holders_get_their_own(self):
        stats = self.run_split()
        self.assertEqual(Designation.objects.get(pk=self.master.pk).category, "staff")
        # a no-department title only production employees hold becomes Production
        self.assertEqual(Designation.objects.get(pk=self.loose.pk).category, "production")
        # the production worker who held the staff "Cutting Master" now holds a Production one in their department
        self.p2.refresh_from_db()
        own = self.p2.designation
        self.assertEqual(
            (own.title, own.category, own.department_id), ("Cutting Master", "production", self.copy_of_cutting().id)
        )
        self.assertEqual(Employee.objects.get(pk=self.s1.pk).designation_id, self.master.id)
        self.assertEqual((stats["designations_created"], stats["employees_redesignated"]), (1, 1))

    def test_nobody_is_left_in_a_department_or_designation_of_the_other_kind(self):
        self.run_split()
        for e in Employee.objects.select_related("department", "designation"):
            kind = "production" if e.employment_type == "production" else "staff"
            if e.department_id:
                self.assertEqual(e.department.category, kind, e.employee_code)
            if e.designation_id:
                self.assertEqual(e.designation.category, kind, e.employee_code)

    def test_a_second_run_changes_nothing(self):
        self.run_split()
        snapshot = (
            list(Department.objects.order_by("id").values_list("id", "name", "category")),
            list(Designation.objects.order_by("id").values_list("id", "category", "department_id")),
            list(Employee.objects.order_by("id").values_list("id", "department_id", "designation_id")),
            ManagerDepartmentAssignment.objects.count(),
            Holiday.objects.count(),
            CompensationDayAnnouncement.objects.count(),
        )
        stats = self.run_split()
        self.assertFalse(any(stats.values()), stats)
        self.assertEqual(
            snapshot,
            (
                list(Department.objects.order_by("id").values_list("id", "name", "category")),
                list(Designation.objects.order_by("id").values_list("id", "category", "department_id")),
                list(Employee.objects.order_by("id").values_list("id", "department_id", "designation_id")),
                ManagerDepartmentAssignment.objects.count(),
                Holiday.objects.count(),
                CompensationDayAnnouncement.objects.count(),
            ),
        )


# ── Departments ─────────────────────────────────────────────────────────────


class DepartmentRuleTests(_Api):
    def test_create_takes_the_kind_and_an_old_client_gets_staff(self):
        r = self.send(
            "post", "/api/departments", {"name": "Cutting", "branchId": self.unit1.id, "category": "production"}
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["category"], "production")
        r = self.send("post", "/api/departments", {"name": "Accounts", "branchId": self.unit1.id})
        self.assertEqual(r.json()["category"], "staff")
        r = self.send("post", "/api/departments", {"name": "X", "branchId": self.unit1.id, "category": "contract"})
        self.assertEqual(r.status_code, 400)

    def test_the_same_name_may_exist_once_per_branch_and_kind_ignoring_case(self):
        ok = self.send("post", "/api/departments", {"name": "CUTTING", "branchId": self.unit1.id, "category": "staff"})
        self.assertEqual(ok.status_code, 201)
        again = self.send(
            "post", "/api/departments", {"name": " cutting ", "branchId": self.unit1.id, "category": "staff"}
        )
        self.assertEqual(again.status_code, 400)
        self.assertIn("Staff department", again.json()["error"])
        other_kind = self.send(
            "post", "/api/departments", {"name": "Cutting", "branchId": self.unit1.id, "category": "production"}
        )
        self.assertEqual(other_kind.status_code, 201)
        other_branch = self.send("post", "/api/departments", {"name": "cutting", "branchId": self.unit2.id})
        self.assertEqual(other_branch.status_code, 201)

    def test_only_an_empty_department_changes_kind_and_its_designations_go_along(self):
        dept = Department.objects.create(name="Store", branch=self.unit1)
        title = Designation.objects.create(title="Storekeeper", department=dept)
        r = self.send("put", f"/api/departments/{dept.id}", {"category": "production"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Designation.objects.get(pk=title.pk).category, "production")
        _emp("D1", self.unit1, dept, None, "production", status="inactive")
        r = self.send("put", f"/api/departments/{dept.id}", {"category": "staff"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("1 employee", r.json()["error"])
        self.assertEqual(Department.objects.get(pk=dept.pk).category, "production")

    def test_a_department_whose_designation_someone_elsewhere_holds_keeps_its_kind(self):
        dept = Department.objects.create(name="Empty", branch=self.unit1)
        title = Designation.objects.create(title="Floater", department=dept)
        _emp("D2", self.unit1, None, title, "staff")
        r = self.send("put", f"/api/departments/{dept.id}", {"category": "production"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("hold", r.json()["error"])

    def test_rename_into_a_taken_name_of_the_kind_is_refused(self):
        Department.objects.create(name="Packing", branch=self.unit1)
        dept = Department.objects.create(name="Pack", branch=self.unit1)
        r = self.send("put", f"/api/departments/{dept.id}", {"name": "PACKING"})
        self.assertEqual(r.status_code, 400)
        r = self.send("put", f"/api/departments/{dept.id}", {"name": "PACKING", "category": "production"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_lists_carry_the_kind_and_filter_by_it(self):
        Department.objects.create(name="Cutting", branch=self.unit1, category="staff")
        Department.objects.create(name="Cutting", branch=self.unit1, category="production")
        rows = self.get("/api/departments").json()
        self.assertEqual(sorted(r["category"] for r in rows), ["production", "staff"])
        self.assertTrue(all(r["branchName"] == "CAT Unit1" for r in rows))
        only = self.get("/api/departments?category=production").json()
        self.assertEqual([r["category"] for r in only], ["production"])
        overview = self.get("/api/departments/overview?category=staff").json()
        self.assertEqual([d["category"] for d in overview["departments"]], ["staff"])
        self.assertEqual(len(self.get("/api/departments/overview").json()["departments"]), 2)
        self.assertEqual(self.get("/api/departments?category=nope").status_code, 400)
        self.assertEqual(self.get("/api/departments/overview?category=nope").status_code, 400)


# ── Designations ────────────────────────────────────────────────────────────


class DesignationRuleTests(_Api):
    def setUp(self):
        super().setUp()
        self.staff_dept = Department.objects.create(name="Cutting", branch=self.unit1)
        self.prod_dept = Department.objects.create(name="Cutting", branch=self.unit1, category="production")

    def test_a_designation_is_of_its_departments_kind_whatever_is_sent(self):
        r = self.send(
            "post", "/api/designations", {"title": "Cutter", "departmentId": self.prod_dept.id, "category": "staff"}
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["category"], "production")
        loose = self.send("post", "/api/designations", {"title": "Helper", "category": "production"})
        self.assertEqual(loose.json()["category"], "production")
        old = self.send("post", "/api/designations", {"title": "Clerk"})
        self.assertEqual(old.json()["category"], "staff")

    def test_title_is_trimmed_and_a_duplicate_in_the_department_is_refused(self):
        r = self.send("post", "/api/designations", {"title": "  Sr.   Tailor ", "departmentId": self.staff_dept.id})
        self.assertEqual(r.json()["title"], "Sr. Tailor")
        dup = self.send("post", "/api/designations", {"title": "sr. tailor", "departmentId": self.staff_dept.id})
        self.assertEqual(dup.status_code, 400)
        # the same title in the production CUTTING is a different designation
        other = self.send("post", "/api/designations", {"title": "Sr. Tailor", "departmentId": self.prod_dept.id})
        self.assertEqual(other.status_code, 201)
        self.assertEqual(self.send("post", "/api/designations", {"title": "   "}).status_code, 400)

    def test_a_bad_department_id_is_a_404_not_a_500(self):
        for bad in ("abc", 999999, "1.5"):
            r = self.send("post", "/api/designations", {"title": "X", "departmentId": bad})
            self.assertEqual(r.status_code, 404, (bad, r.content))
        self.assertEqual(self.get("/api/designations?departmentId=abc").status_code, 400)

    def test_a_held_designation_cannot_move_to_the_other_kind(self):
        title = Designation.objects.create(title="Supervisor", department=self.staff_dept)
        _emp("G1", self.unit1, self.staff_dept, title, "staff")
        r = self.send("put", f"/api/designations/{title.id}", {"departmentId": self.prod_dept.id})
        self.assertEqual(r.status_code, 400)
        self.assertIn("nobody holds", r.json()["error"])
        empty = Designation.objects.create(title="Checker", department=self.staff_dept)
        r = self.send("put", f"/api/designations/{empty.id}", {"departmentId": self.prod_dept.id})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["category"], "production")

    def test_lists_carry_the_kind_and_filter_by_it(self):
        Designation.objects.create(title="A", department=self.staff_dept)
        Designation.objects.create(title="B", department=self.prod_dept, category="production")
        self.assertEqual([d["title"] for d in self.get("/api/designations?category=production").json()], ["B"])
        self.assertEqual(len(self.get("/api/designations").json()), 2)
        tree = self.get("/api/designations/tree?category=staff").json()
        self.assertEqual([d["title"] for d in tree["designations"]], ["A"])
        self.assertEqual([d["category"] for d in tree["departments"]], ["staff"])
        self.assertEqual(len(self.get("/api/designations/tree").json()["departments"]), 2)


# ── Employees ───────────────────────────────────────────────────────────────


class EmployeeRuleTests(_Api):
    def setUp(self):
        super().setUp()
        self.staff_dept = Department.objects.create(name="Cutting", branch=self.unit1)
        self.prod_dept = Department.objects.create(name="Cutting", branch=self.unit1, category="production")
        self.staff_title = Designation.objects.create(title="Supervisor", department=self.staff_dept)
        self.prod_title = Designation.objects.create(title="Cutter", department=self.prod_dept, category="production")

    def create(self, **body):
        base = {
            "employeeCode": "E1",
            "firstName": "A",
            "lastName": "B",
            "phone": "9000000001",
            "branchId": self.unit1.id,
        }
        return self.send("post", "/api/employees", {**base, **body})

    def test_create_refuses_a_department_of_the_other_kind(self):
        r = self.create(employmentType="production", departmentId=self.staff_dept.id)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Staff department", r.json()["error"])
        r = self.create(employmentType="production", departmentId=self.prod_dept.id, designationId=self.staff_title.id)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Staff designation", r.json()["error"])
        r = self.create(employmentType="production", departmentId=self.prod_dept.id, designationId=self.prod_title.id)
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_department_named_in_text_is_found_or_made_in_the_employees_kind(self):
        r = self.create(employmentType="production", department="cutting")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Employee.objects.get(employee_code="E1").department_id, self.prod_dept.id)
        r = self.create(employeeCode="E2", employmentType="production", department="Packing", designation="Packer")
        self.assertEqual(r.status_code, 201, r.content)
        emp = Employee.objects.select_related("department", "designation").get(employee_code="E2")
        self.assertEqual((emp.department.category, emp.designation.category), ("production", "production"))

    def test_changing_the_type_needs_a_matching_or_no_department_in_the_same_save(self):
        emp = _emp("E3", self.unit1, self.staff_dept, self.staff_title, "staff")
        r = self.send("patch", f"/api/employees/{emp.id}", {"employmentType": "production"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Changing someone to Production", r.json()["error"])
        self.assertEqual(Employee.objects.get(pk=emp.pk).employment_type, "staff")
        r = self.send(
            "patch",
            f"/api/employees/{emp.id}",
            {"employmentType": "production", "departmentId": self.prod_dept.id, "designationId": None},
        )
        self.assertEqual(r.status_code, 200, r.content)
        emp.refresh_from_db()
        self.assertEqual(
            (emp.employment_type, emp.department_id, emp.designation_id), ("production", self.prod_dept.id, None)
        )

    def test_edit_refuses_a_new_department_of_the_other_kind_but_not_an_unrelated_change(self):
        emp = _emp("E4", self.unit1, self.staff_dept, None, "staff")
        r = self.send("patch", f"/api/employees/{emp.id}", {"departmentId": self.prod_dept.id})
        self.assertEqual(r.status_code, 400)
        # left in a department of the other kind from before the split: editing the phone still works
        legacy = _emp("E5", self.unit1, self.staff_dept, None, "production")
        r = self.send(
            "patch", f"/api/employees/{legacy.id}", {"phone": "9111111111", "departmentId": self.staff_dept.id}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.send("patch", f"/api/employees/{emp.id}", {"departmentId": "abc"}).status_code, 404)

    def test_a_promotion_stays_in_the_kind(self):
        emp = _emp("E6", self.unit1, self.staff_dept, self.staff_title, "staff")
        r = self.send("post", "/api/promotions", {"employeeId": emp.id, "newDepartmentId": self.prod_dept.id})
        self.assertEqual(r.status_code, 400)
        other = Department.objects.create(name="Stores", branch=self.unit1)
        r = self.send("post", "/api/promotions", {"employeeId": emp.id, "newDepartmentId": other.id})
        self.assertEqual(r.status_code, 201, r.content)


class AssignEndpointTests(_Api):
    def setUp(self):
        super().setUp()
        self.staff_dept = Department.objects.create(name="Cutting", branch=self.unit1)
        self.prod_dept = Department.objects.create(name="Cutting", branch=self.unit1, category="production")
        self.prod_title = Designation.objects.create(title="Cutter", department=self.prod_dept, category="production")
        self.worker = _emp("W1", self.unit1, None, None, "production")
        role = Role.objects.create(
            name="CAT dept editor",
            permissions={"employees": "view", "employees.departments": "edit", "employees.designations": "edit"},
        )
        self.editor = HRUser.objects.create(username="cat_editor", password_hash="x", role=role)

    def test_the_departments_page_permission_is_enough_to_assign(self):
        r = self.send(
            "post",
            "/api/departments/assign",
            {"employeeId": self.worker.id, "departmentId": self.prod_dept.id},
            self.editor,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Employee.objects.get(pk=self.worker.pk).department_id, self.prod_dept.id)
        # the general employee edit still needs the Employees module
        r = self.send("patch", f"/api/employees/{self.worker.id}", {"departmentId": None}, self.editor)
        self.assertEqual(r.status_code, 403)
        r = self.send(
            "post",
            "/api/designations/assign",
            {"employeeId": self.worker.id, "designationId": self.prod_title.id},
            self.editor,
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.send(
            "post", "/api/departments/assign", {"employeeId": self.worker.id, "departmentId": None}, self.editor
        )
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(Employee.objects.get(pk=self.worker.pk).department_id)

    def test_a_view_only_role_cannot_assign(self):
        role = Role.objects.create(name="CAT viewer", permissions={"employees.departments": "view"})
        viewer = HRUser.objects.create(username="cat_viewer", password_hash="x", role=role)
        r = self.send(
            "post", "/api/departments/assign", {"employeeId": self.worker.id, "departmentId": self.prod_dept.id}, viewer
        )
        self.assertEqual(r.status_code, 403)

    def test_the_other_kind_and_bad_ids_are_refused(self):
        r = self.send(
            "post", "/api/departments/assign", {"employeeId": self.worker.id, "departmentId": self.staff_dept.id}
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Production department", r.json()["error"])
        self.assertEqual(
            self.send("post", "/api/departments/assign", {"employeeId": "x", "departmentId": 1}).status_code, 400
        )
        self.assertEqual(
            self.send("post", "/api/departments/assign", {"employeeId": 999999, "departmentId": None}).status_code, 404
        )
        self.assertEqual(
            self.send(
                "post", "/api/designations/assign", {"employeeId": self.worker.id, "designationId": 999999}
            ).status_code,
            404,
        )

    def test_a_branch_login_cannot_reach_another_branchs_department(self):
        role = Role.objects.create(name="CAT u2", permissions={"employees.departments": "edit"})
        u2 = HRUser.objects.create(username="cat_u2", password_hash="x", role=role, branch=self.unit2)
        r = self.send(
            "post", "/api/departments/assign", {"employeeId": self.worker.id, "departmentId": self.prod_dept.id}, u2
        )
        self.assertEqual(r.status_code, 404)


class NameLookupTests(TestCase):
    """The bulk upload's name matching (org_lookup.py): by name + branch + kind; unknown names created in the kind."""

    def setUp(self):
        self.unit1 = Branch.objects.create(name="LK Unit1", code="LKU1")
        self.staff_cut = Department.objects.create(name="CUTTING", branch=self.unit1)
        self.prod_cut = Department.objects.create(name="CUTTING", branch=self.unit1, category="production")

    def test_departments_match_within_the_kind(self):
        org = OrgLookup()
        self.assertEqual(org.department("cutting", self.unit1.id, category="production").obj, self.prod_cut)
        self.assertEqual(org.department(" Cutting ", self.unit1.id, category="staff").obj, self.staff_cut)
        made = org.department("Packing", self.unit1.id, category="production")
        self.assertTrue(made.created)
        self.assertEqual(made.obj.category, "production")
        # a staff row naming Packing gets a Staff Packing, not the production one just made
        staff = org.department("Packing", self.unit1.id, category="staff")
        self.assertTrue(staff.created)
        self.assertNotEqual(staff.obj.id, made.obj.id)

    def test_designations_are_made_in_the_department_and_kind(self):
        org = OrgLookup()
        made = org.designation("Cutter", self.prod_cut, category="production")
        self.assertEqual((made.obj.department_id, made.obj.category), (self.prod_cut.id, "production"))
        loose = org.designation("Helper", None, category="production")
        self.assertEqual((loose.obj.department_id, loose.obj.category), (None, "production"))
        # a staff "Helper" is not the production one
        self.assertNotEqual(org.designation("Helper", None, category="staff").obj.id, loose.obj.id)
