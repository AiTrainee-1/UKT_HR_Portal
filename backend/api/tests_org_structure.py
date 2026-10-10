"""Departments and Designations pages: the aggregated endpoints, and the edit/validation rules around them.

  GET /api/departments/overview, /api/departments/<id>/employees, /api/designations/tree, /api/designations/<id>/employees
  PUT /api/departments/<id>, POST /api/departments (validation), PUT /api/designations/<id> (branch rule)

Run via: DATABASE_URL= DB_NAME=uktex_org python manage.py test api.tests_org_structure --noinput
"""

import json

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Department, Designation, Employee, HRUser, Role


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _employee(code, branch=None, dept=None, desig=None, kind="staff", status="active"):
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Org",
        employment_type=kind,
        status=status,
        branch=branch,
        department=dept,
        designation=desig,
    )


class _World(TestCase):
    """Two branches. Head Office: Cutting (2 staff, 3 production, 1 inactive) and Empty (nobody).
    Unit 2: Sewing (1 staff, 1 production)."""

    def setUp(self):
        self.admin = HRUser.objects.create(username="org_admin", password_hash="x", is_super_admin=True)
        self.ho = Branch.objects.create(name="ORG Head Office", code="ORGHO")
        self.u2 = Branch.objects.create(name="ORG Unit 2", code="ORGU2")
        self.cutting = Department.objects.create(name="ORG Cutting", description="Cut room", branch=self.ho)
        self.empty = Department.objects.create(name="ORG Empty", branch=self.ho)
        self.sewing = Department.objects.create(name="ORG Sewing", branch=self.u2)
        self.master = Designation.objects.create(title="ORG Master", department=self.cutting, level="senior")
        self.helper = Designation.objects.create(title="ORG Helper", department=self.cutting, level="junior")
        self.tailor = Designation.objects.create(title="ORG Tailor", department=self.sewing, level="mid")
        self.floating = Designation.objects.create(title="ORG Floating", department=None, level="manager")
        _employee("ORG1", self.ho, self.cutting, self.master, "staff")
        _employee("ORG2", self.ho, self.cutting, self.master, "staff")
        _employee("ORG3", self.ho, self.cutting, self.helper, "production")
        _employee("ORG4", self.ho, self.cutting, self.helper, "production")
        _employee("ORG5", self.ho, self.cutting, self.helper, "production")
        _employee("ORG6", self.ho, self.cutting, self.helper, "production", status="inactive")
        _employee("ORG7", self.u2, self.sewing, self.tailor, "staff")
        _employee("ORG8", self.u2, self.sewing, self.tailor, "production")
        _employee("ORG9", self.ho, None, None, "staff")  # no department, no designation

    def scoped(self, branch, perms=None):
        role = Role.objects.create(
            name=f"ORG role {branch.code}", permissions=perms or {"employees": "edit", "employees.departments": "edit"}
        )
        return HRUser.objects.create(username=f"org_{branch.code}", password_hash="x", role=role, branch=branch)

    def get(self, path, user=None):
        return self.client.get(path, **_bearer(user or self.admin))

    def send(self, method, path, body, user=None):
        return getattr(self.client, method)(
            path, json.dumps(body), content_type="application/json", **_bearer(user or self.admin)
        )

    @staticmethod
    def by_name(rows, key="name"):
        return {r[key]: r for r in rows}


class DepartmentOverviewTests(_World):
    def test_counts_split_into_staff_and_production_and_exclude_inactive(self):
        body = self.get("/api/departments/overview").json()
        rows = self.by_name(body["departments"])
        cutting = rows["ORG Cutting"]
        self.assertEqual((cutting["activeStaff"], cutting["activeProduction"], cutting["active"]), (2, 3, 5))
        self.assertEqual(cutting["inactive"], 1)
        self.assertEqual(cutting["activeOther"], 0)
        self.assertEqual(cutting["designationCount"], 2)
        self.assertEqual(cutting["branchName"], "ORG Head Office")
        self.assertEqual(cutting["description"], "Cut room")

    def test_a_department_with_nobody_is_listed_with_zeros(self):
        empty = self.by_name(self.get("/api/departments/overview").json()["departments"])["ORG Empty"]
        self.assertEqual(
            (empty["activeStaff"], empty["activeProduction"], empty["active"], empty["inactive"]), (0, 0, 0, 0)
        )
        self.assertEqual(empty["designationCount"], 0)

    def test_people_without_a_department_are_counted_apart(self):
        unassigned = self.get("/api/departments/overview").json()["unassigned"]
        self.assertEqual(unassigned["active"], 1)
        self.assertEqual(unassigned["staff"], 1)

    def test_an_unscoped_login_sees_every_branch(self):
        body = self.get("/api/departments/overview").json()
        names = {d["name"] for d in body["departments"]}
        self.assertTrue({"ORG Cutting", "ORG Empty", "ORG Sewing"} <= names)
        self.assertTrue({self.ho.id, self.u2.id} <= {b["id"] for b in body["branches"]})

    def test_a_branch_scoped_login_sees_only_its_own_departments_and_people(self):
        body = self.get("/api/departments/overview", self.scoped(self.u2)).json()
        self.assertEqual([d["name"] for d in body["departments"]], ["ORG Sewing"])
        sewing = body["departments"][0]
        self.assertEqual((sewing["activeStaff"], sewing["activeProduction"]), (1, 1))
        self.assertEqual([b["id"] for b in body["branches"]], [self.u2.id])
        self.assertEqual(body["unassigned"]["active"], 0)  # the one unassigned employee belongs to Head Office

    def test_counts_follow_the_employees_own_branch_like_the_employees_list(self):
        # an employee of Head Office filed under Unit 2's department: the Unit 2 login does not see them (the
        # Employees list would not show them either), the Head Office login counts nothing for a department it
        # cannot open.
        _employee("ORG10", self.ho, self.sewing, None, "staff")
        u2 = self.get("/api/departments/overview", self.scoped(self.u2)).json()["departments"][0]
        self.assertEqual(u2["active"], 2)
        admin = self.by_name(self.get("/api/departments/overview").json()["departments"])["ORG Sewing"]
        self.assertEqual(admin["active"], 3)

    def test_a_role_without_the_departments_module_is_refused(self):
        nobody = self.scoped(self.u2, {"employees": "hidden"})
        self.assertEqual(self.get("/api/departments/overview", nobody).status_code, 403)

    def test_a_view_only_role_may_read_but_not_edit(self):
        viewer = self.scoped(self.u2, {"employees": "view"})
        self.assertEqual(self.get("/api/departments/overview", viewer).status_code, 200)
        self.assertEqual(self.send("put", f"/api/departments/{self.sewing.id}", {"name": "X"}, viewer).status_code, 403)

    def test_no_token_is_rejected(self):
        self.assertIn(self.client.get("/api/departments/overview").status_code, (401, 403))


class DepartmentEmployeesTests(_World):
    def test_lists_light_rows_active_first(self):
        body = self.get(f"/api/departments/{self.cutting.id}/employees").json()
        self.assertEqual(body["department"]["name"], "ORG Cutting")
        codes = [e["employeeCode"] for e in body["employees"]]
        self.assertEqual(codes, ["ORG1", "ORG2", "ORG3", "ORG4", "ORG5", "ORG6"])
        self.assertEqual(body["employees"][-1]["status"], "inactive")
        first = body["employees"][0]
        self.assertEqual(
            set(first),
            {
                "id",
                "employeeCode",
                "name",
                "designationId",
                "designationTitle",
                "departmentId",
                "departmentName",
                "employmentType",
                "status",
            },
        )  # nothing about pay, bank or photo
        self.assertEqual(first["designationTitle"], "ORG Master")

    def test_another_branchs_department_is_a_404_for_a_scoped_login(self):
        self.assertEqual(
            self.get(f"/api/departments/{self.cutting.id}/employees", self.scoped(self.u2)).status_code, 404
        )

    def test_only_the_scoped_branchs_people_are_listed(self):
        _employee("ORG10", self.ho, self.sewing, None, "staff")
        rows = self.get(f"/api/departments/{self.sewing.id}/employees", self.scoped(self.u2)).json()["employees"]
        self.assertEqual({e["employeeCode"] for e in rows}, {"ORG7", "ORG8"})

    def test_an_empty_department_returns_an_empty_list(self):
        self.assertEqual(self.get(f"/api/departments/{self.empty.id}/employees").json()["employees"], [])


class DesignationTreeTests(_World):
    def test_each_designation_carries_its_department_branch_level_and_split(self):
        body = self.get("/api/designations/tree").json()
        rows = self.by_name(body["designations"], "title")
        master = rows["ORG Master"]
        self.assertEqual(
            (master["departmentName"], master["branchName"], master["level"]),
            ("ORG Cutting", "ORG Head Office", "senior"),
        )
        self.assertEqual((master["activeStaff"], master["activeProduction"], master["inactive"]), (2, 0, 0))
        helper = rows["ORG Helper"]
        self.assertEqual(
            (helper["activeStaff"], helper["activeProduction"], helper["active"], helper["inactive"]), (0, 3, 3, 1)
        )

    def test_a_designation_with_no_department_is_listed_for_an_unscoped_login(self):
        floating = self.by_name(self.get("/api/designations/tree").json()["designations"], "title")["ORG Floating"]
        self.assertIsNone(floating["departmentId"])
        self.assertIsNone(floating["branchId"])

    def test_departments_come_along_even_with_no_designation(self):
        depts = self.by_name(self.get("/api/designations/tree").json()["departments"])
        self.assertIn("ORG Empty", depts)
        self.assertEqual(depts["ORG Cutting"]["active"], 5)

    def test_a_branch_scoped_login_sees_only_its_branch_and_no_floating_designations(self):
        user = self.scoped(self.u2, {"employees": "edit"})
        body = self.get("/api/designations/tree", user).json()
        self.assertEqual([d["title"] for d in body["designations"]], ["ORG Tailor"])
        self.assertEqual([d["name"] for d in body["departments"]], ["ORG Sewing"])
        self.assertEqual([b["id"] for b in body["branches"]], [self.u2.id])
        self.assertEqual(body["designations"][0]["activeStaff"], 1)

    def test_a_role_without_the_designations_module_is_refused(self):
        nobody = self.scoped(self.u2, {"employees": "edit", "employees.designations": "hidden"})
        self.assertEqual(self.get("/api/designations/tree", nobody).status_code, 403)

    def test_designation_employees(self):
        body = self.get(f"/api/designations/{self.helper.id}/employees").json()
        self.assertEqual(body["designation"]["title"], "ORG Helper")
        self.assertEqual([e["employeeCode"] for e in body["employees"]], ["ORG3", "ORG4", "ORG5", "ORG6"])
        self.assertEqual({e["employmentType"] for e in body["employees"]}, {"production"})

    def test_designation_employees_of_another_branch_is_a_404_for_a_scoped_login(self):
        user = self.scoped(self.u2, {"employees": "edit"})
        self.assertEqual(self.get(f"/api/designations/{self.master.id}/employees", user).status_code, 404)
        self.assertEqual(self.get(f"/api/designations/{self.floating.id}/employees", user).status_code, 404)


class DepartmentWriteTests(_World):
    def test_create_requires_a_name(self):
        r = self.send("post", "/api/departments", {"name": "  ", "branchId": self.ho.id})
        self.assertEqual(r.status_code, 400)

    def test_create_with_a_duplicate_name_in_the_same_branch_is_a_400_not_a_500(self):
        r = self.send("post", "/api/departments", {"name": "ORG Cutting", "branchId": self.ho.id})
        self.assertEqual(r.status_code, 400)
        self.assertIn("already exists", r.json()["error"])

    def test_the_same_name_in_another_branch_is_fine(self):
        r = self.send("post", "/api/departments", {"name": "ORG Cutting", "branchId": self.u2.id})
        self.assertEqual(r.status_code, 201)

    def test_create_with_an_unknown_branch_is_a_400(self):
        self.assertEqual(self.send("post", "/api/departments", {"name": "ORG Z", "branchId": 987654}).status_code, 400)

    def test_edit_name_and_description(self):
        r = self.send(
            "put", f"/api/departments/{self.cutting.id}", {"name": " ORG Cutting Room ", "description": "New"}
        )
        self.assertEqual(r.status_code, 200)
        self.cutting.refresh_from_db()
        self.assertEqual((self.cutting.name, self.cutting.description), ("ORG Cutting Room", "New"))
        self.assertEqual(r.json()["employeeCount"], 5)

    def test_edit_cannot_take_a_name_already_used_in_the_branch(self):
        r = self.send("put", f"/api/departments/{self.cutting.id}", {"name": "ORG Empty"})
        self.assertEqual(r.status_code, 400)

    def test_edit_can_keep_its_own_name_and_clear_the_description(self):
        r = self.send("patch", f"/api/departments/{self.cutting.id}", {"name": "ORG Cutting", "description": ""})
        self.assertEqual(r.status_code, 200)
        self.cutting.refresh_from_db()
        self.assertIsNone(self.cutting.description)

    def test_edit_never_moves_the_branch(self):
        self.send("put", f"/api/departments/{self.cutting.id}", {"name": "ORG Cutting", "branchId": self.u2.id})
        self.cutting.refresh_from_db()
        self.assertEqual(self.cutting.branch_id, self.ho.id)

    def test_a_scoped_login_cannot_edit_another_branchs_department(self):
        r = self.send("put", f"/api/departments/{self.cutting.id}", {"name": "Hijack"}, self.scoped(self.u2))
        self.assertEqual(r.status_code, 404)

    def test_delete_leaves_employees_and_designations_unassigned(self):
        self.assertEqual(
            self.client.delete(f"/api/departments/{self.cutting.id}", **_bearer(self.admin)).status_code, 200
        )
        self.assertEqual(Employee.objects.get(employee_code="ORG1").department_id, None)
        self.master.refresh_from_db()
        self.assertIsNone(self.master.department_id)


class DesignationWriteTests(_World):
    def test_a_scoped_login_cannot_move_a_designation_into_another_branch(self):
        user = self.scoped(self.u2, {"employees": "edit"})
        r = self.send("put", f"/api/designations/{self.tailor.id}", {"departmentId": self.cutting.id}, user)
        self.assertEqual(r.status_code, 404)
        self.tailor.refresh_from_db()
        self.assertEqual(self.tailor.department_id, self.sewing.id)

    def test_a_scoped_login_cannot_orphan_a_designation(self):
        user = self.scoped(self.u2, {"employees": "edit"})
        r = self.send("put", f"/api/designations/{self.tailor.id}", {"departmentId": None}, user)
        self.assertEqual(r.status_code, 400)

    def test_a_scoped_login_may_rename_and_change_level(self):
        user = self.scoped(self.u2, {"employees": "edit"})
        r = self.send(
            "put", f"/api/designations/{self.tailor.id}", {"title": "ORG Senior Tailor", "level": "senior"}, user
        )
        self.assertEqual(r.status_code, 200)
        self.tailor.refresh_from_db()
        self.assertEqual((self.tailor.title, self.tailor.level), ("ORG Senior Tailor", "senior"))

    def test_a_blank_title_is_refused(self):
        self.assertEqual(self.send("put", f"/api/designations/{self.tailor.id}", {"title": " "}).status_code, 400)

    def test_an_unscoped_login_may_still_move_it_anywhere_or_nowhere(self):
        self.assertEqual(
            self.send("put", f"/api/designations/{self.tailor.id}", {"departmentId": self.cutting.id}).status_code, 200
        )
        self.assertEqual(
            self.send("put", f"/api/designations/{self.tailor.id}", {"departmentId": None}).status_code, 200
        )
