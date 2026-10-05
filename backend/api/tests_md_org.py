"""GET /api/md/org: the units and departments the MD's filter bars offer."""

from .models import Branch, Department, Employee
from .tests_md_support import MdApiTestCase


class OrgStructureTests(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Org Unit One", code="OU1", is_head_office=False)
        cls.u2 = Branch.objects.create(name="Org Unit Two", code="OU2", is_active=False)
        cls.stitch1 = Department.objects.create(name="Org Stitching", branch=cls.u1)
        cls.stitch2 = Department.objects.create(name="Org Stitching", branch=cls.u2)
        cls.loose = Department.objects.create(name="Org Floating", branch=None)
        for code, status in (("OA", "active"), ("OB", "active"), ("OC", "inactive")):
            Employee.objects.create(
                employee_code=code, first_name=code, last_name="T", department=cls.stitch1, branch=cls.u1, status=status
            )

    def rows(self):
        body = self.get("/api/md/org").json()
        return (
            {b["name"]: b for b in body["branches"]},
            {(d["name"], d["branchName"]): d for d in body["departments"]},
        )

    def test_lists_every_unit_with_its_state(self):
        branches, _ = self.rows()
        self.assertEqual(branches["Org Unit One"]["id"], self.u1.id)
        self.assertTrue(branches["Org Unit One"]["isActive"])
        self.assertFalse(branches["Org Unit Two"]["isActive"])

    def test_a_department_name_in_two_units_is_listed_once_per_unit(self):
        _, departments = self.rows()
        self.assertIn(("Org Stitching", "Org Unit One"), departments)
        self.assertIn(("Org Stitching", "Org Unit Two"), departments)

    def test_headcount_counts_active_people_only(self):
        _, departments = self.rows()
        self.assertEqual(departments[("Org Stitching", "Org Unit One")]["employees"], 2)
        self.assertEqual(departments[("Org Stitching", "Org Unit Two")]["employees"], 0)

    def test_a_department_without_a_unit_is_still_offered(self):
        _, departments = self.rows()
        floating = departments[("Org Floating", None)]
        self.assertIsNone(floating["branchId"])
        self.assertEqual(floating["employees"], 0)
