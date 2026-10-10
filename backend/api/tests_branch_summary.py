"""Manage Branch: GET /api/branches/summary (headcount, departments and the unit-code counter of each branch)."""

from django.test import TestCase

from .branch_summary_views import summarize_branches
from .jwt_utils import sign_token
from .models import Branch, Department, Employee, HRUser, Role


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _employee(code, branch=None, department=None, kind="staff", status="active"):
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Test",
        employment_type=kind,
        status=status,
        branch=branch,
        department=department,
    )


class BranchSummaryTests(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="bs_admin", password_hash="x", is_super_admin=True)
        self.ho = Branch.objects.create(name="BS Head Office", code="BSHO", is_head_office=True, next_employee_seq=7)
        self.u2 = Branch.objects.create(name="BS Unit 2", code="BSU2")
        self.cutting = Department.objects.create(name="BS Cutting", branch=self.ho)
        self.admin_dept = Department.objects.create(name="BS Admin", branch=self.ho)
        _employee("BS1", self.ho, self.admin_dept)
        _employee("BS2", self.ho, self.cutting, kind="production")
        _employee("BS3", self.ho, self.cutting, kind="production")
        _employee("BS4", self.ho, self.cutting, kind="production", status="inactive")
        _employee("BS5", None)

    def get(self, user=None):
        return self.client.get("/api/branches/summary", **_bearer(user or self.admin))

    def row(self, body, branch):
        return next(r for r in body["branches"] if r["branchId"] == branch.id)

    def test_counts_split_by_type_and_status(self):
        body = self.get().json()
        ho = self.row(body, self.ho)
        self.assertEqual((ho["staffActive"], ho["productionActive"], ho["inactive"]), (1, 2, 1))
        self.assertEqual(ho["nextEmployeeSeq"], 7)
        # a branch nobody belongs to is still listed, with zeros
        u2 = self.row(body, self.u2)
        self.assertEqual((u2["staffActive"], u2["productionActive"], u2["inactive"]), (0, 0, 0))
        self.assertEqual(u2["departments"], [])

    def test_departments_carry_their_active_headcount(self):
        ho = self.row(self.get().json(), self.ho)
        counts = {d["name"]: d["activeCount"] for d in ho["departments"]}
        self.assertEqual(counts, {"BS Admin": 1, "BS Cutting": 2})

    def test_employees_with_no_branch_are_counted_apart(self):
        self.assertGreaterEqual(self.get().json()["unassignedActive"], 1)

    def test_a_deleted_branch_is_not_listed(self):
        self.u2.is_active = False
        self.u2.save()
        ids = [r["branchId"] for r in self.get().json()["branches"]]
        self.assertNotIn(self.u2.id, ids)
        self.assertIn(self.ho.id, ids)

    def test_a_branch_scoped_login_sees_only_its_own_branch(self):
        role = Role.objects.create(name="BS Viewer", permissions={"employees": "view"})
        scoped = HRUser.objects.create(username="bs_scoped", password_hash="x", role=role, branch=self.u2)
        body = self.get(scoped).json()
        self.assertEqual([r["branchId"] for r in body["branches"]], [self.u2.id])
        self.assertEqual(body["unassignedActive"], 0)

    def test_summary_function_matches_the_endpoint(self):
        self.assertEqual(summarize_branches(None), self.get().json())

    def test_a_role_without_the_branches_module_is_refused(self):
        role = Role.objects.create(name="BS Nothing", permissions={"dashboard": "view"})
        nobody = HRUser.objects.create(username="bs_nobody", password_hash="x", role=role)
        self.assertEqual(self.get(nobody).status_code, 403)

    def test_a_role_that_may_view_branches_can_read_it(self):
        role = Role.objects.create(name="BS Branch Viewer", permissions={"employees.branches": "view"})
        viewer = HRUser.objects.create(username="bs_viewer", password_hash="x", role=role)
        self.assertEqual(self.get(viewer).status_code, 200)

    def test_an_employee_token_is_refused(self):
        emp = _employee("BS9", self.ho)
        token = sign_token({"role": "employee", "employeeId": emp.id})
        r = self.client.get("/api/branches/summary", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(r.status_code, 403)

    def test_the_summary_cannot_be_written(self):
        r = self.client.post("/api/branches/summary", **_bearer(self.admin))
        self.assertEqual(r.status_code, 405)


class BranchCodeTests(TestCase):
    """A repeated branch code used to reach the database's unique constraint and come back as a 500."""

    def setUp(self):
        self.admin = HRUser.objects.create(username="bc_admin", password_hash="x", is_super_admin=True)

    def call(self, method, url, body):
        return getattr(self.client, method)(url, body, content_type="application/json", **_bearer(self.admin))

    def test_duplicate_code_is_refused_on_create_and_edit(self):
        first = self.call("post", "/api/branches", {"name": "Code A", "code": "CD1"})
        self.assertEqual(first.status_code, 201)
        again = self.call("post", "/api/branches", {"name": "Code B", "code": "CD1"})
        self.assertEqual(again.status_code, 400)
        other = self.call("post", "/api/branches", {"name": "Code C", "code": "CD2"})
        self.assertEqual(other.status_code, 201)
        clash = self.call("put", f"/api/branches/{other.json()['id']}", {"code": "CD1"})
        self.assertEqual(clash.status_code, 400)
        same = self.call("put", f"/api/branches/{other.json()['id']}", {"code": "CD2"})
        self.assertEqual(same.status_code, 200)

    def test_blank_codes_do_not_collide(self):
        a = self.call("post", "/api/branches", {"name": "Blank A", "code": ""})
        b = self.call("post", "/api/branches", {"name": "Blank B", "code": "  "})
        self.assertEqual((a.status_code, b.status_code), (201, 201))
        self.assertIsNone(b.json()["code"])
