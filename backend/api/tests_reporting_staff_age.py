"""Staff Age Analysis (reporting/definitions/rc_staff_age.py, owner 2026-11-28): the staff list by department with each
age in its band, the band counts per department, per unit (all units: each unit and the overall total) and overall.

Run via: python manage.py test api.tests_reporting_staff_age -v 2
"""

from datetime import date
from unittest.mock import patch

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Department, Designation, Employee, HRUser
from .reporting.definitions.rc_staff_age import band_of

TODAY = date(2026, 11, 28)
RID = "staff-age-analysis"


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def born(age: int) -> date:
    """A birthday that makes the person `age` on TODAY (born earlier in the year)."""
    return date(TODAY.year - age, 1, 15)


class StaffAgeAnalysisTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = HRUser.objects.create(username="age_admin", password_hash="x", is_super_admin=True)
        cls.u1 = Branch.objects.create(name="Unit 1")
        cls.u2 = Branch.objects.create(name="Unit 2")
        cls.mgmt = Department.objects.create(name="Management")
        cls.acc = Department.objects.create(name="Accounts")
        clerk = Designation.objects.create(title="Clerk")

        def staff(code, age, dept, unit, gender="male", **kw):
            return Employee.objects.create(
                employee_code=code, first_name=code, last_name="", status="active", employment_type="staff",
                department=dept, branch=unit, designation=clerk, gender=gender,
                date_of_birth=born(age) if age is not None else None, **kw,
            )  # fmt: skip

        staff("A1", 24, cls.acc, cls.u1, "female")
        staff("A2", 29, cls.acc, cls.u1)
        staff("A3", 43, cls.acc, cls.u2, "female")
        staff("M1", 66, cls.mgmt, cls.u1)
        staff("M2", 55, cls.mgmt, cls.u2)
        staff("M3", 78, cls.mgmt, cls.u2)
        staff("M4", None, cls.mgmt, cls.u1)
        # a production employee: out with the default Staff type
        Employee.objects.create(
            employee_code="P1", first_name="P1", last_name="", status="active", employment_type="production",
            department=cls.acc, branch=cls.u1, date_of_birth=born(30),
        )  # fmt: skip

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def run_report(self, **params):
        r = self.client.get(f"/api/reports/run/{RID}", {"employmentType": "staff", **params}, **hdr(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:500])
        return r.json()

    def test_the_bands(self):
        self.assertEqual(
            [band_of(a) for a in (0, 25, 26, 30, 31, 45, 46, 55, 56, 75, 76, None)],
            ["b0", "b0", "b26", "b26", "b31", "b41", "b46", "b51", "b56", "b56", "b76", None],
        )

    def test_department_groups_ages_in_their_bands_and_totals(self):
        body = self.run_report()
        rows = body["rows"]
        heads = [r for r in rows if r.get("_kind") == "subtotal"]
        # departments alphabetical, each headed by its band counts
        self.assertEqual([h["employeeName"] for h in heads], ["Accounts · 3 people", "Management · 4 people"])
        self.assertEqual((heads[0]["b0"], heads[0]["b26"], heads[0]["b41"]), (1, 1, 1))
        self.assertEqual((heads[1]["b51"], heads[1]["b56"], heads[1]["b76"]), (1, 1, 1))
        people = [r for r in rows if not r.get("_kind")]
        self.assertEqual([p["employeeCode"] for p in people], ["A1", "A2", "A3", "M1", "M2", "M3", "M4"])
        self.assertEqual([p["sno"] for p in people], list(range(1, 8)))
        a1 = people[0]
        self.assertEqual((a1["age"], a1["b0"], a1.get("b26")), (24, 24, None))  # the age written in its band
        self.assertEqual((people[-1]["age"], people[-1].get("b56")), (None, None))  # no date of birth: no band
        keys = [c["key"] for c in body["columns"]]
        self.assertIn("b76", keys)  # someone is 78: the "76 & above" band appears
        self.assertIn("unit", keys)  # two units in the result
        self.assertEqual((body["totals"]["b56"], body["totals"]["b76"], body["totals"]["b0"]), (1, 1, 1))
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(
            (cards["Staff"], cards["Units"], cards["Youngest"], cards["Oldest"], cards["No date of birth"]),
            (7, 2, 24, 78, 1),
        )
        self.assertEqual(cards["Average age"], round((24 + 29 + 43 + 66 + 55 + 78) / 6, 1))

    def test_all_units_give_each_units_counts_and_the_overall_total(self):
        body = self.run_report()
        sections = {s["title"]: s for s in body["sections"]}
        units = sections["Unit-wise age profile"]
        by_unit = {r["unit"]: r for r in units["rows"]}
        self.assertEqual((by_unit["Unit 1"]["staff"], by_unit["Unit 2"]["staff"]), (4, 3))
        self.assertEqual((by_unit["Unit 1"]["female"], by_unit["Unit 1"]["noDob"]), (1, 1))
        self.assertEqual((by_unit["Unit 2"]["b41"], by_unit["Unit 2"]["b51"], by_unit["Unit 2"]["b76"]), (1, 1, 1))
        self.assertEqual((units["totals"]["unit"], units["totals"]["staff"]), ("Overall total", 7))
        depts = {r["department"]: r for r in sections["Department-wise age profile"]["rows"]}
        self.assertEqual((depts["Accounts"]["staff"], depts["Management"]["avgAge"]), (3, round((66 + 55 + 78) / 3, 1)))

    def test_one_unit_has_no_unit_column_or_unit_table(self):
        body = self.run_report(branchIds=str(self.u1.id))
        self.assertNotIn("unit", [c["key"] for c in body["columns"]])
        self.assertEqual([s["title"] for s in body["sections"]], ["Department-wise age profile"])
        self.assertEqual(len([r for r in body["rows"] if not r.get("_kind")]), 4)

    def test_listed_in_employee_details_and_exports(self):
        catalog = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        flat = str(catalog)
        self.assertIn(RID, flat)
        for fmt in ("xlsx", "pdf"):
            r = self.client.get(
                f"/api/reports/export/{RID}", {"fmt": fmt, "employmentType": "staff"}, **hdr(self.admin)
            )
            self.assertEqual(r.status_code, 200, r.content[:300])
            self.assertGreater(len(r.content), 1000)
