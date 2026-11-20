"""
Report Center workspace contract: what the catalog tells the workspace about each report besides its filters.

    exportLimits  the row ceilings the run / export endpoints apply (screen, Excel, PDF), so the UI can say "too many
                  rows for a PDF - download Excel instead" before the click instead of after a 413
    autoRun       whether opening the report runs its default filters straight away (False: wait for "Show report")

Also pins the boolean contract the workspace relies on: a tick box whose default is ON can be switched off by sending
``key=false`` explicitly (an absent value means the default).

Run via: python manage.py test api.tests_reporting_rc_workspace -v 2
"""

from unittest import mock

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Department, Employee, HRUser
from .reporting import filters as F
from .reporting import layout, registry
from .reporting.runner import PDF_ROW_LIMIT, SCREEN_ROW_LIMIT, XLSX_ROW_LIMIT
from .reporting.types import INTEGER, TEXT, ColumnSpec, FilterSpec, ReportResult, ReportSpec

PROBE = "zz_ws_probe"
HEAVY = "zz_ws_heavy"


def _hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _run(ctx) -> ReportResult:
    rows = [
        {"code": e.employee_code, "flag": "on" if ctx.params.get("includeOff") else "off", "n": 1}
        for e in ctx.employees().order_by("employee_code")
    ]
    return ReportResult(rows=rows)


def _spec(report_id: str, **kw) -> ReportSpec:
    args = dict(
        id=report_id,
        title="Workspace probe",
        description="test only",
        category="employees",
        filters=(
            F.period(),
            FilterSpec("includeOff", "boolean", "Include days off", default=True),
            FilterSpec("compact", "boolean", "Compact", default=False),
            *F.scope(status="all"),
        ),
        columns=(ColumnSpec("code", "Code", TEXT), ColumnSpec("flag", "Flag", TEXT), ColumnSpec("n", "N", INTEGER)),
        run=_run,
    )
    args.update(kw)
    return ReportSpec(**args)


# The probes are listed as if the layout named them (only layout reports, saved Customise reports and the MD's own are
# listed and runnable since the 2026-11-19 cleanup).
_LISTED = {PROBE: ("employees", 900), HEAVY: ("employees", 901)}


@mock.patch.dict(layout._ORDER, _LISTED)
class WorkspaceCatalogContractTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        branch = Branch.objects.create(name="WS Unit", code="WSU")
        dept = Department.objects.create(name="WS DEPT", branch=branch)
        for code in ("WS_A", "WS_B"):
            Employee.objects.create(employee_code=code, first_name=code, last_name="T", department=dept, branch=branch)
        cls.admin = HRUser.objects.create(username="ws_admin", password_hash="x", is_super_admin=True)

    def setUp(self):
        self.probe = registry.register(_spec(PROBE))
        heavy = _spec(HEAVY, title="Heavy probe", screen_limit=2_000, pdf_max_rows=300)
        # ReportSpec has no auto_run field yet: the catalog reads the attribute when a spec carries one
        object.__setattr__(heavy, "auto_run", False)
        self.heavy = registry.register(heavy)

    def tearDown(self):
        for rid in (PROBE, HEAVY):
            registry._REGISTRY.pop(rid, None)

    def catalog(self) -> dict:
        r = self.client.get("/api/reports/catalog", **_hdr(self.admin))
        self.assertEqual(r.status_code, 200)
        return {x["id"]: x for x in r.json()["reports"]}

    def test_every_listed_report_carries_its_export_limits_and_auto_run(self):
        listed = self.catalog()
        self.assertIn(PROBE, listed)
        for rid, report in listed.items():
            limits = report["exportLimits"]
            self.assertEqual(set(limits), {"screen", "xlsx", "pdf"}, rid)
            self.assertTrue(all(isinstance(v, int) and v > 0 for v in limits.values()), rid)
            self.assertIsInstance(report["autoRun"], bool, rid)

    def test_default_limits_are_the_runner_ceilings(self):
        probe = self.catalog()[PROBE]
        self.assertEqual(
            probe["exportLimits"], {"screen": SCREEN_ROW_LIMIT, "xlsx": XLSX_ROW_LIMIT, "pdf": PDF_ROW_LIMIT}
        )
        self.assertTrue(probe["autoRun"])

    def test_per_report_overrides_and_auto_run_off_reach_the_catalog(self):
        heavy = self.catalog()[HEAVY]
        # Excel has no per-report override: the same 30,000 rows for every report
        self.assertEqual(heavy["exportLimits"], {"screen": 2_000, "xlsx": XLSX_ROW_LIMIT, "pdf": 300})
        self.assertFalse(heavy["autoRun"])

    def test_a_real_report_states_its_own_pdf_ceiling(self):
        listed = self.catalog()
        spec = registry.get_spec("hr-time-card")
        if spec is None or "hr-time-card" not in listed:
            self.skipTest("hr-time-card is not registered")
        self.assertEqual(listed["hr-time-card"]["exportLimits"]["pdf"], spec.pdf_max_rows or PDF_ROW_LIMIT)
        self.assertEqual(listed["hr-time-card"]["exportLimits"]["screen"], spec.screen_limit or SCREEN_ROW_LIMIT)

    def test_the_catalog_still_ships_columns_and_filters(self):
        probe = self.catalog()[PROBE]
        self.assertEqual([c["key"] for c in probe["columns"]], ["code", "flag", "n"])
        on = next(f for f in probe["filters"] if f["key"] == "includeOff")
        self.assertIs(on["default"], True)

    # ── the boolean contract the workspace sends ─────────────────────────────────────────────────────────────────────

    def run_probe(self, **params) -> dict:
        r = self.client.get(f"/api/reports/run/{PROBE}", {"period": "2026-09", **params}, **_hdr(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_a_default_on_tick_box_is_on_when_absent_and_off_when_sent_false(self):
        self.assertEqual({row["flag"] for row in self.run_probe()["rows"]}, {"on"})
        self.assertEqual({row["flag"] for row in self.run_probe(includeOff="false")["rows"]}, {"off"})
        self.assertEqual({row["flag"] for row in self.run_probe(includeOff="true")["rows"]}, {"on"})

    def test_the_applied_filters_stop_saying_yes_when_switched_off(self):
        shown = lambda body: {f["label"]: f["value"] for f in body["filters"]}  # noqa: E731
        self.assertEqual(shown(self.run_probe()).get("Include days off"), "Yes")
        self.assertNotIn("Include days off", shown(self.run_probe(includeOff="false")))

    def test_an_error_names_the_field_the_workspace_highlights(self):
        r = self.client.get(f"/api/reports/run/{PROBE}", {"period": "2026-13"}, **_hdr(self.admin))
        self.assertEqual(r.status_code, 400)
        self.assertEqual((r.json()["error"], r.json()["field"]), ("invalid_filter", "period"))
