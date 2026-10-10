"""The Managing Director reads the whole Report Center (company-wide, read-only) and owns the md_only reports; nothing
changes for any other account."""

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Department, Employee, HRUser, Role
from .reporting import registry
from .reporting import filters as F
from .reporting.access import is_md
from .reporting.types import CATEGORY_IDS, TEXT, ColumnSpec, ReportResult, ReportSpec


def headers_for(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _run(ctx):
    rows = [{"code": e.employee_code} for e in ctx.employees()]
    return ReportResult(rows=rows, summary=[{"label": "People", "value": len(rows), "format": "integer"}])


def _spec(report_id, **kw):
    args = dict(
        id=report_id,
        title=f"Probe {report_id}",
        description="test only",
        category="employees",
        filters=(*F.scope(status="all"),),
        columns=(ColumnSpec("code", "Code", TEXT, 1),),
        run=_run,
    )
    args.update(kw)
    return ReportSpec(**args)


class MdAndReports(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        dept = Department.objects.create(name="CUTTING", branch=cls.b1)
        for code, branch in (("E1", cls.b1), ("E2", cls.b2)):
            Employee.objects.create(employee_code=code, first_name=code, last_name="T", department=dept, branch=branch)
        cls.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        cls.md = HRUser.objects.create(username="md", password_hash="x", is_md=True)  # no role, no branch
        cls.clerk = HRUser.objects.create(
            username="clerk",
            password_hash="x",
            role=Role.objects.create(name="Reports only", permissions={"reports": "view"}),
        )
        cls.plain = HRUser.objects.create(username="plain", password_hash="x")  # no role at all

    def setUp(self):
        self._registered = []
        for spec in (
            _spec("zz_open"),
            _spec("zz_payroll_gated", modules=("payroll",)),
            _spec("zz_admin_only", super_admin_only=True, category="admin"),
            _spec("zz_md_only", md_only=True, category="md"),
        ):
            registry.register(spec)
            self._registered.append(spec.id)

    def tearDown(self):
        for rid in self._registered:
            registry._REGISTRY.pop(rid, None)

    def get(self, path, user, **params):
        return self.client.get(path, params, **headers_for(user))

    def catalog_ids(self, user):
        r = self.get("/api/reports/catalog", user)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        found = set()
        for key in ("reports", "items", "results"):
            for item in body.get(key, []):
                found.add(item["id"])
        return found

    def run_report(self, rid, user):
        return self.get(f"/api/reports/run/{rid}", user)

    def test_there_is_a_category_for_the_executive_reports(self):
        self.assertIn("md", CATEGORY_IDS)

    def test_the_md_opens_every_report_even_gated_and_admin_only_ones_with_no_role(self):
        for rid in ("zz_open", "zz_payroll_gated", "zz_admin_only"):
            r = self.run_report(rid, self.md)
            self.assertEqual(r.status_code, 200, (rid, r.content))
            self.assertEqual(len(r.json()["rows"]), 2, rid)  # company-wide: both branches

    def test_the_md_sees_the_executive_reports_and_nobody_else_does(self):
        self.assertEqual(self.run_report("zz_md_only", self.md).status_code, 200)
        for who in (self.admin, self.clerk):
            self.assertEqual(
                self.run_report("zz_md_only", who).status_code, 404, who.username
            )  # hidden: it does not exist
        self.assertEqual(self.run_report("zz_md_only", self.plain).status_code, 403)  # no Reports access at all

    def test_the_md_catalog_lists_the_executive_category_and_other_catalogs_do_not(self):
        self.assertIn("zz_md_only", self.catalog_ids(self.md))
        self.assertNotIn("zz_md_only", self.catalog_ids(self.admin))
        self.assertNotIn("zz_md_only", self.catalog_ids(self.clerk))
        cats = lambda u: {c["id"] for c in self.get("/api/reports/catalog", u).json()["categories"]}  # noqa: E731
        self.assertIn("md", cats(self.md))
        self.assertNotIn("md", cats(self.admin))
        self.assertNotIn("md", cats(self.clerk))

    def test_other_accounts_are_exactly_as_before(self):
        # a role with Reports but not Payroll still cannot open a payroll-owned report
        self.assertEqual(self.run_report("zz_payroll_gated", self.clerk).status_code, 403)
        self.assertEqual(self.run_report("zz_open", self.clerk).status_code, 200)
        # an admin-only report stays hidden from a role
        self.assertEqual(self.run_report("zz_admin_only", self.clerk).status_code, 404)
        # an account with no role at all still gets nothing from the Report Center
        self.assertEqual(self.run_report("zz_open", self.plain).status_code, 403)
        # the super administrator still opens the normal reports
        self.assertEqual(self.run_report("zz_payroll_gated", self.admin).status_code, 200)

    def test_the_md_exports_reports_as_well(self):
        r = self.get("/api/reports/export/zz_open", self.md, fmt="xlsx")
        self.assertEqual(r.status_code, 200, r.content[:200])

    def test_being_the_md_does_not_open_the_rest_of_the_hr_portal(self):
        for path in ("/api/salary-slips", "/api/payroll", "/api/hr-users", "/api/audit-logs"):
            self.assertIn(self.get(path, self.md).status_code, (401, 403, 404), path)

    def test_a_branch_limited_md_is_still_company_wide_in_reports(self):
        """An MD account is meant to have no branch; if one is set by hand, reports still read company-wide."""
        HRUser.objects.filter(pk=self.md.pk).update(branch=self.b1)
        self.assertEqual(len(self.run_report("zz_open", self.md).json()["rows"]), 2)

    def test_the_helper_agrees(self):
        class R:
            jwt_user = {"hrUserId": self.md.id}

        self.assertTrue(is_md(R()))
