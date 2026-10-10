"""Promotion / Increment pages: the read-only additions behind the redesign.

`GET /api/increments/history` lists every increment (branch-scoped, newest first) with the employee's department,
designation, branch and type; `GET /api/promotions` gained an optional `?limit=` and two extra fields. Nothing here
changes how a promotion or an increment is applied: `test_applying_*` pin that the existing POSTs still behave.

Run via: python manage.py test api.tests_career_pages
"""

import json
from datetime import date
from decimal import Decimal

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Department, Designation, Employee, HRUser, Promotion, Role, SalaryIncrement


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class CareerPagesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = HRUser.objects.create(username="career_admin", password_hash="x", is_super_admin=True)
        cls.hq = Branch.objects.create(name="Career HQ", code="CHQ")
        cls.unit = Branch.objects.create(name="Career Unit", code="CUN")
        cls.dept = Department.objects.create(name="Career Stitching", branch=cls.hq)
        cls.sup = Designation.objects.create(title="Career Supervisor", department=cls.dept)
        cls.mgr = Designation.objects.create(title="Career Manager", department=cls.dept)
        cls.asha = cls._emp("CAR001", "Asha", cls.hq, "20000.00")
        cls.ravi = cls._emp("CAR002", "Ravi", cls.unit, "30000.00")
        for emp, prev, new, eff in (
            (cls.asha, "20000.00", "22000.00", date(2026, 1, 1)),
            (cls.asha, "22000.00", "24200.00", date(2026, 6, 1)),
            (cls.ravi, "30000.00", "31500.00", date(2026, 3, 1)),
        ):
            SalaryIncrement.objects.create(
                employee=emp,
                previous_salary=Decimal(prev),
                new_salary=Decimal(new),
                percent=Decimal("10.00"),
                effective_date=eff,
            )

    @classmethod
    def _emp(cls, code, first, branch, salary):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="Career",
            employment_type="staff",
            status="active",
            branch=branch,
            department=cls.dept,
            designation=cls.sup,
            salary_type="monthly",
            salary_amount=Decimal(salary),
        )

    def get(self, url, user=None):
        return self.client.get(url, **_bearer(user or self.admin))

    def post(self, url, body, user=None):
        return self.client.post(
            url, data=json.dumps(body), content_type="application/json", **_bearer(user or self.admin)
        )

    # ── increment history ────────────────────────────────────────────────────

    def test_history_lists_every_increment_newest_first_with_the_employee_context(self):
        r = self.get("/api/increments/history")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["total"], 3)
        self.assertEqual([x["effectiveDate"] for x in body["results"]], ["2026-06-01", "2026-03-01", "2026-01-01"])
        first = body["results"][0]
        self.assertEqual(first["employeeCode"], "CAR001")
        self.assertEqual(first["department"], "Career Stitching")
        self.assertEqual(first["designation"], "Career Supervisor")
        self.assertEqual(first["branchName"], "Career HQ")
        self.assertEqual(first["employmentType"], "staff")
        # the fields the old list already had are still there, unchanged
        self.assertEqual((first["previousSalary"], first["newSalary"], first["percent"]), (22000.0, 24200.0, 10.0))

    def test_history_is_cut_at_limit_but_total_still_says_how_many_there_are(self):
        body = self.get("/api/increments/history?limit=2").json()
        self.assertEqual((len(body["results"]), body["total"]), (2, 3))

    def test_a_bad_limit_falls_back_to_the_default_instead_of_failing(self):
        r = self.get("/api/increments/history?limit=lots")
        self.assertEqual((r.status_code, len(r.json()["results"])), (200, 3))

    def test_a_branch_scoped_login_only_sees_its_own_branch(self):
        role = Role.objects.create(name="Career Clerk", permissions={"increment": "view"})
        clerk = HRUser.objects.create(username="career_clerk", password_hash="x", role=role, branch=self.unit)
        body = self.get("/api/increments/history", clerk).json()
        self.assertEqual([x["employeeCode"] for x in body["results"]], ["CAR002"])
        self.assertEqual(body["total"], 1)

    def test_a_role_without_the_increment_module_cannot_read_the_history(self):
        role = Role.objects.create(name="Career Other", permissions={"leave": "edit"})
        other = HRUser.objects.create(username="career_other", password_hash="x", role=role)
        self.assertEqual(self.get("/api/increments/history", other).status_code, 403)

    def test_a_view_only_role_can_read_the_history_but_not_add_an_increment(self):
        role = Role.objects.create(name="Career Viewer", permissions={"increment": "view"})
        viewer = HRUser.objects.create(username="career_viewer", password_hash="x", role=role)
        self.assertEqual(self.get("/api/increments/history", viewer).status_code, 200)
        r = self.post("/api/increments", {"employeeId": self.asha.id, "percent": 5}, viewer)
        self.assertEqual(r.status_code, 403)

    # ── promotions list ──────────────────────────────────────────────────────

    def _promote(self, emp, eff):
        return Promotion.objects.create(
            employee=emp,
            previous_designation=self.sup,
            new_designation=self.mgr,
            previous_department=self.dept,
            new_department=self.dept,
            effective_date=eff,
        )

    def test_promotions_carry_branch_and_type_and_keep_their_old_fields(self):
        self._promote(self.asha, date(2026, 2, 1))
        row = self.get("/api/promotions").json()[0]
        self.assertEqual((row["branchName"], row["employmentType"]), ("Career HQ", "staff"))
        self.assertEqual(
            (row["employeeCode"], row["previousDesignation"], row["newDesignation"]),
            ("CAR001", "Career Supervisor", "Career Manager"),
        )

    def test_promotions_limit_is_optional_and_bounded(self):
        for n in range(1, 4):
            self._promote(self.asha, date(2026, n, 1))
        self.assertEqual(len(self.get("/api/promotions").json()), 3)
        self.assertEqual(len(self.get("/api/promotions?limit=2").json()), 2)
        self.assertEqual(len(self.get("/api/promotions?limit=0").json()), 1)  # never "no limit" and never an error
        self.assertEqual(len(self.get("/api/promotions?limit=zzz").json()), 3)

    # ── the existing write paths are unchanged ───────────────────────────────

    def test_applying_an_increment_still_moves_the_salary_exactly_as_before(self):
        r = self.post("/api/increments", {"employeeId": self.ravi.id, "percent": 10, "effectiveDate": "2026-07-01"})
        self.assertEqual(r.status_code, 201, r.content)
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.salary_amount, Decimal("33000.00"))
        self.assertEqual(self.get("/api/increments/history").json()["total"], 4)

    def test_applying_a_promotion_still_updates_the_profile_and_refuses_no_change(self):
        r = self.post("/api/promotions", {"employeeId": self.asha.id, "newDesignationId": self.mgr.id})
        self.assertEqual(r.status_code, 201, r.content)
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.designation_id, self.mgr.id)
        again = self.post("/api/promotions", {"employeeId": self.asha.id, "newDesignationId": self.mgr.id})
        self.assertEqual(again.status_code, 400)
