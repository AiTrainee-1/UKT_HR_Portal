"""
Report Center layout (the owner's 2026-11-19 cleanup, reporting/layout.py): what is listed, where, in which order, and
that nothing else can be reached.

    * every LAYOUT id is registered, in the category the layout names, with the title the brief gives it;
    * no listed report sits in a retired category (leave / gate / finance / admin), and every other registered report
      is RETIRED: not in the catalog, and its run / export endpoints answer 404;
    * the HR category (the owner's quality reference) is exactly what git HEAD had: ids, titles, categories, filters,
      columns (a readable copy below plus a digest of every other spec field);
    * the catalog lists the layout in the layout's order, then the saved Customise reports, under the categories HR
      Reports / Attendance / Shift / Salary / Employee Details / Customise (+ Executive (MD) for the MD only);
    * every listed report runs on its default filters and builds Excel + PDF on a seeded month with staff and production
      employees (stored day verdicts and payroll);
    * a derive()d report's pinned filters cannot be overridden from the query string.

Also home of list_retired_reports() / unlist_retired_reports(): the test modules that keep guarding a RETIRED report's
logic through the HTTP endpoints (its definition stays, because the MD portal analytics and the gate exports reuse its
helpers) list every report again for as long as they run, from their setUpModule / tearDownModule.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_rc2_layout py -3 manage.py test api.tests_reporting_rc_layout
"""

import dataclasses
import hashlib
import io
import json
import random
from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.core.management import call_command
from django.http import QueryDict
from django.test import RequestFactory, TestCase
from openpyxl import load_workbook

from .attendance_final import compute_day_record
from .jwt_utils import sign_token
from .models import (
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    PayrollSettings,
    Role,
    SavedCustomReport,
    ShiftTemplate,
)
from .payroll_views import PayrollSkip, _generate_production_payroll, _generate_staff_payroll
from .permission_registry import all_module_keys
from .reporting import filters as F
from .reporting import layout, registry
from .reporting.derive import derive
from .reporting.export_xlsx import HEADER_ROW
from .reporting.runner import run_report
from .reporting.types import TEXT, ColumnSpec, ReportResult, ReportSpec

# ── listing the retired reports again, for the modules that test them ────────────────────────────────────────────────


class _EveryReportListed(dict):
    """A stand-in for layout._ORDER that answers "listed" for every report id: the layout's reports keep their places,
    the retired ones follow in registration order, and a report a test registers on the fly is listed as well."""

    def __contains__(self, key):
        return True


_RETIRED_PATCHES: list = []


def list_retired_reports() -> None:
    """List every registered report again, as before the 2026-11-19 layout, until unlist_retired_reports().

    For the test modules that keep guarding a retired report's logic through /api/reports/run|export (those answer 404
    for a retired id by design). Call it from the module's setUpModule(), and unlist_retired_reports() from its
    tearDownModule(); the patches stack, so a module entered twice in one run is balanced."""
    order = _EveryReportListed(layout._ORDER)
    for i, spec in enumerate(registry.all_specs()):
        if not dict.__contains__(order, spec.id):  # (dict's own test: `in` says yes to everything here)
            order[spec.id] = (spec.category, 10_000 + i)
    patcher = mock.patch.object(layout, "_ORDER", order)
    patcher.start()
    _RETIRED_PATCHES.append(patcher)


def unlist_retired_reports() -> None:
    _RETIRED_PATCHES.pop().stop()


# ── the fixed layout (the owner's brief, rc2_spec) ───────────────────────────────────────────────────────────────────

EXPECTED_LAYOUT = {
    "hr": (
        "employee-confo-details",
        "production-daily-punches",
        "production-shift-rules",
        "hr-salary-statement",
        "hr-production-salary-statement",
        "hr-daily-movement-register",
        "hr-punching-register",
        "hr-strength-register",
        "hr-attendance-register-summary",
        "hr-time-card",
    ),
    "attendance": (
        "staff-attendance-report",
        "production-attendance-report",
        "staff-time-card-report",
        "time-card-shift-count",
        "production-time-card-punches",
        "production-shift-ot-punches",
        "production-all-punches",
        "leave-report",
        "employee-overall-leave",
        "late-detection",
        "monthly-misspunch",
        "geo-attendance",
        "on-duty-report",
        "on-duty-punch-details",
        "attendance-log-report",
        "production-attendance-log",
    ),
    "shift": (
        "assigned-shift-report",
        "gained-shift-report",
        "shift-change-history",
        "shift-wise-attendance",
        "shift-assignment-gaps",
    ),
    "payroll": (
        "salary-statement",
        "production-salary-report",
        "staff-salary-report",
        "gained-salary-report",
        "expected-salary-report",
        "department-salary-report",
        "department-headcount-report",
        "department-employee-report",
    ),
    "employees": (
        "employee-overall-details",
        "employee-fixed-salary",
        "employee-monthly-shift",
        "employee-time-card",
        "employee-punch-details",
    ),
}
FLAT_LAYOUT = [rid for ids in EXPECTED_LAYOUT.values() for rid in ids]

# The titles the brief names (the two recategorised Shift reports keep their own).
TITLES = {
    "staff-attendance-report": "Staff Attendance Report",
    "production-attendance-report": "Production Attendance Report",
    "staff-time-card-report": "Staff Time Card Report",
    "time-card-shift-count": "Time Card with Shift Count Report",
    "production-time-card-punches": "Production Time Card with Punch Details",
    "production-shift-ot-punches": "Production Shift with OT Punch Details",
    "production-all-punches": "Production All Punch Records",
    "leave-report": "Leave Report",
    "employee-overall-leave": "Individual Employee Overall Leave Report",
    "late-detection": "Late Detection Report",
    "monthly-misspunch": "Monthly Misspunch Records",
    "geo-attendance": "Geo Attendance Report",
    "on-duty-report": "On-Duty Report",
    "on-duty-punch-details": "On-Duty with Punch Details",
    "attendance-log-report": "Attendance Log Report",
    "production-attendance-log": "Production Attendance Log Report",
    "assigned-shift-report": "Assigned Shift Report",
    "gained-shift-report": "Gained Shift Report",
    "shift-change-history": "Shift Change History",
    "salary-statement": "Salary Statement",
    "production-salary-report": "Production Salary Report",
    "staff-salary-report": "Staff Salary Report",
    "gained-salary-report": "Gained Salary Report",
    "expected-salary-report": "Expected Salary Report",
    "department-salary-report": "Department-wise Salary Report",
    "department-headcount-report": "Department-wise Headcount Report",
    "department-employee-report": "Department-wise Employee Report",
    "employee-overall-details": "Employee Overall Details",
    "employee-fixed-salary": "Employee Fixed Salary Details",
    "employee-monthly-shift": "Employee Monthly Shift Details",
    "employee-time-card": "Employee Time Card",
    "employee-punch-details": "Employee Punch Details",
}

# The categories the catalog shows, in order (id, label); the MD also gets "md" after them.
SHOWN_CATEGORIES = [
    ("hr", "HR Reports"),
    ("attendance", "Attendance"),
    ("shift", "Shift"),
    ("payroll", "Salary"),
    ("employees", "Employee Details"),
    ("customise", "Customise"),
]
RETIRED_CATEGORIES = {"leave", "gate", "finance", "admin"}

# ── the HR category as git HEAD (0254f9e) registered it ──────────────────────────────────────────────────────────────
# (id, title, modules, filters (key, kind, default), columns (key, label, type)); category "hr" for all ten.
HR_AT_HEAD = (
    (
        "employee-confo-details",
        "Employee Confo Details",
        ("salary", "payroll"),
        (
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employeeType", "select", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "active"),
        ),
        (
            ("employeeCode", "Employee Code", "text"),
            ("employeeName", "Name", "text"),
            ("department", "Department", "text"),
            ("designation", "Designation", "text"),
            ("salary", "Salary", "text"),
            ("assignedHod", "Assigned HOD", "text"),
            ("joinDate", "Date of Joining", "date"),
            ("shift", "Shift Assign", "text"),
        ),
    ),
    (
        "production-daily-punches",
        "Production Daily Punches",
        ("attendance",),
        (
            ("dateRange", "dateRange", "today"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "all"),
        ),
        (
            ("employeeName", "Employee Name", "text"),
            ("employeeCode", "Employee Code", "text"),
            ("designation", "Designation", "text"),
            ("department", "Department", "text"),
            ("date", "Date", "date"),
            ("day", "Day", "text"),
            ("shift", "Shift", "text"),
            ("punchCount", "Total Punch Count", "integer"),
            ("shiftsEarned", "Shifts Earned", "number"),
            ("late", "Late", "badge"),
            ("early", "Early", "badge"),
            ("punches", "All Punches (exact times)", "text"),
            ("ruleApplied", "Rule applied", "text"),
        ),
    ),
    (
        "production-shift-rules",
        "Production Shift Rules",
        ("attendance",),
        (),
        (
            ("kind", "Type", "badge"),
            ("group", "Group", "text"),
            ("appliesOn", "Applies on", "text"),
            ("starts", "Starts", "time"),
            ("outTime", "Out time", "text"),
            ("shiftValue", "Shift value", "number"),
            ("detail", "Detail", "text"),
        ),
    ),
    (
        "hr-salary-statement",
        "Salary Statement",
        ("payroll",),
        (
            ("period", "period", "lastMonth"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employee", "employee", None),
            ("paymentStatus", "select", None),
            ("section", "select", None),
        ),
        (
            ("sno", "SNO", "integer"),
            ("code", "ID NO", "text"),
            ("name", "Name", "text"),
            ("designation", "Designation", "text"),
            ("basic", "Basic Salary", "currency"),
            ("otherSalary", "Other Allowance", "currency"),
            ("total", "Total Salary", "currency"),
            ("present", "Present", "number"),
            ("cl", "CL", "number"),
            ("hd", "HD", "number"),
            ("totalDays", "Total Days", "number"),
            ("lop", "LOP", "number"),
            ("companyDays", "Company Days", "integer"),
            ("eSalary", "Earned Salary", "currency"),
            ("pf", "PF", "currency"),
            ("esi", "ESI", "currency"),
            ("tds", "TDS", "currency"),
            ("advance", "Advance", "currency"),
            ("others", "Others", "currency"),
            ("totalDeduction", "Total Deduction", "currency"),
            ("net", "NET", "currency"),
            ("remarks", "Remarks", "text"),
            ("unit", "Unit", "text"),
        ),
    ),
    (
        "hr-production-salary-statement",
        "Production Salary Statement",
        ("production_payroll.exports",),
        (
            ("cycle", "select", "weekly"),
            ("dateRange", "dateRange", "none"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employee", "employee", None),
            ("paymentStatus", "select", None),
        ),
        (
            ("sno", "SNO", "integer"),
            ("code", "ID NO", "text"),
            ("name", "Name", "text"),
            ("designation", "Designation", "text"),
            ("rate", "Rate / Shift", "currency"),
            ("days", "Days Paid", "number"),
            ("worked", "Days Worked", "number"),
            ("absent", "Absent", "number"),
            ("shifts", "Shifts", "number"),
            ("eSalary", "Gross Earned", "currency"),
            ("pf", "PF", "currency"),
            ("esi", "ESI", "currency"),
            ("tds", "TDS", "currency"),
            ("advance", "Advance", "currency"),
            ("others", "Others", "currency"),
            ("totalDeduction", "Total Deduction", "currency"),
            ("net", "NET", "currency"),
            ("remarks", "Remarks", "text"),
            ("unit", "Unit", "text"),
        ),
    ),
    (
        "hr-daily-movement-register",
        "Daily Movement Register",
        ("attendance",),
        (
            ("dateRange", "dateRange", "today"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employmentType", "employmentType", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "active"),
        ),
        (
            ("sno", "SNo", "integer"),
            ("ticketNo", "TicketNo", "text"),
            ("empName", "EmpName", "text"),
            ("date", "Date", "text"),
            ("time1", "Time1", "text"),
            ("time2", "Time2", "text"),
            ("time3", "Time3", "text"),
            ("time4", "Time4", "text"),
            ("time5", "Time5", "text"),
            ("time6", "Time6", "text"),
            ("time7", "Time7", "text"),
            ("time8", "Time8", "text"),
            ("time9", "Time9", "text"),
            ("time10", "Time10", "text"),
            ("time11", "Time11", "text"),
            ("time12", "Time12", "text"),
        ),
    ),
    (
        "hr-punching-register",
        "Punching Register (Employees Present List)",
        ("attendance",),
        (
            ("dateRange", "dateRange", "today"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employmentType", "employmentType", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "active"),
        ),
        (
            ("sno", "SNo", "integer"),
            ("ticketNo", "Ticket No", "text"),
            ("empName", "Employee Name", "text"),
            ("designation", "Designation", "text"),
            ("nature", "Nature of Emp", "text"),
            ("date", "Date", "text"),
            ("shiftIn", "Shift InTime", "text"),
            ("actIn", "Act InTime", "text"),
            ("lateHours", "Late Hours", "text"),
        ),
    ),
    (
        "hr-strength-register",
        "Strength Register (Attendance Abstract)",
        ("attendance", "employees"),
        (
            ("dateRange", "dateRange", "today"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employmentType", "employmentType", None),
            ("splitByGender", "boolean", True),
        ),
        (
            ("sno", "S.No.", "integer"),
            ("department", "Department", "text"),
            ("designation", "Designation", "text"),
            ("onRollMale", "ON Roll Strength - Male", "integer"),
            ("onRollFemale", "ON Roll Strength - Female", "integer"),
            ("presentMale", "Present Strength - Male", "integer"),
            ("presentFemale", "Present Strength - Female", "integer"),
        ),
    ),
    (
        "hr-attendance-register-summary",
        "Attendance Register (Summary)",
        ("attendance",),
        (
            ("dateRange", "dateRange", "thisMonth"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employmentType", "employmentType", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "all"),
        ),
        (
            ("sno", "SNo", "integer"),
            ("department", "Department", "text"),
            ("employeeCode", "TicketNo", "text"),
            ("employeeName", "EmpName", "text"),
            ("designation", "Designation", "text"),
            ("present", "Present", "number"),
            ("ot", "OT", "number"),
            ("total", "Total", "number"),
            ("leaveDays", "Leave Days", "number"),
        ),
    ),
    (
        "hr-time-card",
        "Time Card (Form 25 B)",
        ("attendance",),
        (
            ("dateRange", "dateRange", "thisMonth"),
            ("branch", "branch", None),
            ("department", "department", None),
            ("designation", "designation", None),
            ("employmentType", "employmentType", None),
            ("employee", "employee", None),
            ("employeeStatus", "employeeStatus", "all"),
            ("deductLunch", "boolean", False),
        ),
        (
            ("employeeCode", "Employee Code", "text"),
            ("employeeName", "Employee Name", "text"),
            ("department", "Department", "text"),
            ("designation", "Designation", "text"),
            ("sno", "SNo", "integer"),
            ("date", "Date", "text"),
            ("inTime", "In Time", "text"),
            ("lunchOut", "Lunch Out", "text"),
            ("lunchIn", "Lunch In", "text"),
            ("outTime", "Out Time", "text"),
            ("otIn", "OT In", "text"),
            ("otOut", "OT Out", "text"),
            ("totalHrs", "Total Hrs", "text"),
            ("totalOtHrs", "Total OT Hrs", "text"),
            ("present", "Present", "number"),
            ("ot", "OT", "number"),
        ),
    ),
)
# sha256 of _hr_snapshot() at git HEAD: every other field too (descriptions, icons, widths, totals, options, help text,
# limits, landscape, the custom builders ...). If this fails on purpose, the HR category changed: the owner said it must not.
HR_DIGEST_AT_HEAD = "ed5a50dc27b499a07e0a1b9be5835b1790a43a706d9901707ecb4df7dee0c101"


def _hr_snapshot() -> list[dict]:
    out = []
    for rid in EXPECTED_LAYOUT["hr"]:
        s = registry.get_spec(rid)
        out.append(
            {
                "id": s.id,
                "title": s.title,
                "category": s.category,
                "description": s.description,
                "modules": list(s.modules),
                "icon": s.icon,
                "family": s.family,
                "variant": s.variant,
                "landscape": s.landscape,
                "superAdminOnly": s.super_admin_only,
                "mdOnly": s.md_only,
                "filters": [dataclasses.asdict(f) for f in s.filters],
                "columns": [dataclasses.asdict(c) for c in s.columns],
                "pdfBuilder": s.pdf_builder is not None,
                "xlsxBuilder": s.xlsx_builder is not None,
                "screenLimit": s.screen_limit,
                "pdfMaxRows": s.pdf_max_rows,
            }
        )
    return out


def _digest(snapshot: list[dict]) -> str:
    canon = json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


# ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

# The Report Center's "today" while the defaults run on the seeded month (June 2026): its last day (this month / today =
# June, for the attendance reports) and mid-July (last month = June, for the salary reports, which open on last month).
SEEDED_TODAYS = (date(2026, 6, 30), date(2026, 7, 15))


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def default_query(spec_json: dict) -> dict:
    """What the workspace sends for a report's default filters (the catalog's resolved defaults)."""
    q: dict = {}
    for f in spec_json["filters"]:
        kind, d = f["kind"], f.get("default")
        if kind == "period" and d:
            q["period"] = d
        elif kind == "year" and d:
            q["year"] = d
        elif kind == "dateRange" and d:
            q["dateFrom"], q["dateTo"] = d["dateFrom"], d["dateTo"]
        elif kind == "employeeStatus" and d:
            q["employeeStatus"] = d
        elif kind == "select" and d:
            q[f["key"]] = ",".join(d) if isinstance(d, list) else d
        elif kind == "boolean" and d is not None:
            q[f["key"]] = "true" if d else "false"
        elif kind == "number" and d is not None:
            q[f["key"]] = d
    return q


def report_today(d: date) -> tuple:
    """Patchers pinning the Report Center's "today" (filter defaults, ReportContext.today, the catalog's defaults)."""
    return (
        mock.patch("api.reporting.filters.ist_today", return_value=d),
        mock.patch("api.reporting.views.ist_today", return_value=d),
    )


class _Catalog(TestCase):
    def catalog(self, user) -> dict:
        r = self.client.get("/api/reports/catalog", **hdr(user))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def get(self, path, user, **params):
        return self.client.get(path, params, **hdr(user))


# ── the layout itself (no database rows needed beyond the users) ─────────────────────────────────────────────────────


class LayoutTests(_Catalog):
    @classmethod
    def setUpTestData(cls):
        cls.admin = HRUser.objects.create(username="rc_layout_admin", password_hash="x", is_super_admin=True)
        cls.md = HRUser.objects.create(username="rc_layout_md", password_hash="x", is_md=True)
        cls.viewer = HRUser.objects.create(
            username="rc_layout_viewer",
            password_hash="x",
            role=Role.objects.create(name="rc_layout_all_view", permissions={k: "view" for k in all_module_keys()}),
        )

    def test_every_layout_id_is_registered_in_its_category_with_the_briefs_title(self):
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual({k: tuple(v) for k, v in layout.LAYOUT.items()}, EXPECTED_LAYOUT)
        self.assertEqual(len(FLAT_LAYOUT), len(set(FLAT_LAYOUT)), "a report is listed twice")
        self.assertEqual(
            {cat: len(ids) for cat, ids in EXPECTED_LAYOUT.items()},
            {"hr": 10, "attendance": 16, "shift": 5, "payroll": 8, "employees": 5},
        )
        for cat, ids in EXPECTED_LAYOUT.items():
            for rid in ids:
                with self.subTest(report=rid):
                    spec = registry.get_spec(rid)
                    self.assertIsNotNone(spec, f"{rid} is in the layout but not registered")
                    self.assertEqual(spec.category, cat)
                    self.assertTrue(layout.is_listed(spec))
                    self.assertFalse(spec.md_only or spec.super_admin_only, "a listed report must be open to roles")
                    self.assertTrue(spec.modules, "a listed report names the module(s) that own its data")
                    if rid in TITLES:
                        self.assertEqual(spec.title, TITLES[rid])
                    self.assertLessEqual(len(spec.filters), 8, "keep the filter count low (at most 8)")

    def test_no_listed_report_sits_in_a_retired_category_and_every_other_report_is_retired(self):
        listed_categories = {c for c, _ in SHOWN_CATEGORIES}
        retired = []
        for spec in registry.all_specs():
            with self.subTest(report=spec.id):
                if spec.md_only:
                    self.assertEqual(spec.category, "md")
                    self.assertTrue(layout.is_listed(spec))
                elif layout.is_listed(spec):
                    self.assertIn(spec.category, listed_categories)
                    self.assertIn(spec.id, FLAT_LAYOUT)
                else:
                    retired.append(spec)
                if spec.category in RETIRED_CATEGORIES:
                    self.assertFalse(layout.is_listed(spec), f"{spec.id} is listed in a retired category")
        self.assertGreater(len(retired), 100, "the old catalog's reports are expected to stay registered, retired")
        # the recategorised Shift reports moved; nothing listed is left behind in its old category
        self.assertEqual(registry.get_spec("shift-wise-attendance").category, "shift")
        self.assertEqual(registry.get_spec("shift-assignment-gaps").category, "shift")

    def test_the_hr_category_is_exactly_what_git_head_had(self):
        for want in HR_AT_HEAD:
            rid, title, modules, filters, columns = want
            with self.subTest(report=rid):
                spec = registry.get_spec(rid)
                self.assertEqual(spec.category, "hr")
                self.assertEqual(spec.title, title)
                self.assertEqual(tuple(spec.modules), modules)
                self.assertEqual(tuple((f.key, f.kind, f.default) for f in spec.filters), filters)
                self.assertEqual(tuple((c.key, c.label, c.type) for c in spec.columns), columns)
        self.assertEqual([w[0] for w in HR_AT_HEAD], list(EXPECTED_LAYOUT["hr"]))
        self.assertEqual(_digest(_hr_snapshot()), HR_DIGEST_AT_HEAD, "an HR report's spec changed")
        # and the catalog serves them like that
        cat = {r["id"]: r for r in self.catalog(self.admin)["reports"]}
        for rid, title, _modules, filters, columns in HR_AT_HEAD:
            self.assertEqual(cat[rid]["title"], title)
            self.assertEqual(cat[rid]["category"], "hr")
            self.assertEqual([f["key"] for f in cat[rid]["filters"]], [f[0] for f in filters])
            self.assertEqual([(c["key"], c["label"]) for c in cat[rid]["columns"]], [(c[0], c[1]) for c in columns])

    def test_retired_reports_answer_404_on_run_and_export_for_everyone(self):
        retired = [s.id for s in registry.all_specs() if not layout.is_listed(s)]
        # a few the old catalog was known for: still registered (shared helpers), no longer reachable
        for rid in ("employee-master", "audit-log", "salary-register", "attendance-muster-sheet", "hr-users"):
            self.assertIsNotNone(registry.get_spec(rid), rid)
            self.assertIn(rid, retired)
        for rid in retired:
            with self.subTest(report=rid):
                r = self.get(f"/api/reports/run/{rid}", self.admin)
                self.assertEqual(r.status_code, 404, r.content[:200])
                self.assertEqual(r.json()["error"], "not_found")
                for fmt in ("xlsx", "pdf"):
                    self.assertEqual(self.get(f"/api/reports/export/{rid}", self.admin, fmt=fmt).status_code, 404)
                # the MD may open every LISTED report, never a retired one
                self.assertEqual(self.get(f"/api/reports/run/{rid}", self.md).status_code, 404)
                self.assertEqual(self.get(f"/api/reports/run/{rid}", self.viewer).status_code, 404)

    def test_the_catalog_lists_the_layout_in_order_then_the_saved_custom_reports(self):
        saved = SavedCustomReport.objects.create(
            name="Monthly Employee Performance Report",
            dataset="employees",
            fields=["emp.code", "emp.name"],
            filters={},
            created_by=self.admin,
        )
        body = self.catalog(self.admin)
        ids = [r["id"] for r in body["reports"]]
        self.assertEqual(ids, [*FLAT_LAYOUT, f"custom-{saved.pk}"])
        self.assertEqual([r["category"] for r in body["reports"]][-1], "customise")
        for r in body["reports"]:
            self.assertIn("exportLimits", r)
            self.assertIn("autoRun", r)
        # an all-modules role sees the same list
        self.assertEqual([r["id"] for r in self.catalog(self.viewer)["reports"]], ids)
        # the MD: the same, then its own executive reports
        md_ids = [r["id"] for r in self.catalog(self.md)["reports"]]
        md_only = [s.id for s in registry.all_specs() if s.md_only]
        self.assertTrue(md_only)
        self.assertEqual([i for i in md_ids if i not in md_only], ids)
        self.assertEqual(sorted(i for i in md_ids if i in md_only), sorted(md_only))

    def test_the_categories_shown(self):
        counts = {cat: len(ids) for cat, ids in EXPECTED_LAYOUT.items()}
        for who in (self.admin, self.viewer):
            cats = self.catalog(who)["categories"]
            self.assertEqual([(c["id"], c["label"]) for c in cats], SHOWN_CATEGORIES, who.username)
            self.assertEqual({c["id"]: c["count"] for c in cats}, {**counts, "customise": 0}, who.username)
        md_cats = self.catalog(self.md)["categories"]
        self.assertEqual([(c["id"], c["label"]) for c in md_cats], [*SHOWN_CATEGORIES, ("md", "Executive (MD)")])
        # a role with Reports and Attendance only: no retired group ever appears, Customise only with its own grant
        clerk = HRUser.objects.create(
            username="rc_layout_clerk",
            password_hash="x",
            role=Role.objects.create(
                name="rc_layout_clerk",
                permissions={"reports": "view", "attendance": "view", "reports.customise": "hidden"},
            ),
        )
        shown = [c["id"] for c in self.catalog(clerk)["categories"]]
        self.assertTrue(shown)
        self.assertFalse(set(shown) & (RETIRED_CATEGORIES | {"md", "customise"}), shown)
        self.assertEqual(shown, [c for c, _ in SHOWN_CATEGORIES if c in shown], "categories keep the layout's order")


# ── derive(): pinned filters are not open to the query string ────────────────────────────────────────────────────────

BASE_PROBE, DERIVED_PROBE = "zz_rc_layout_base", "zz_rc_layout_derived"


def _probe_run(ctx) -> ReportResult:
    return ReportResult(
        rows=[
            {"code": e.employee_code, "type": e.employment_type, "kind": ctx.params.get("kind")}
            for e in ctx.employees().order_by("employee_code")
        ]
    )


class DeriveTests(_Catalog):
    @classmethod
    def setUpTestData(cls):
        cls.admin = HRUser.objects.create(username="rc_derive_admin", password_hash="x", is_super_admin=True)
        general = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=15
        )
        for code, kind in (("DS1", "staff"), ("DS2", "staff"), ("DP1", "production")):
            emp = Employee.objects.create(employee_code=code, first_name=code, last_name="T", employment_type=kind)
            EmployeeShiftAssignment.objects.create(employee=emp, shift=general, effective_from=date(2020, 1, 1))

    def setUp(self):
        base = registry.register(
            ReportSpec(
                id=BASE_PROBE,
                title="Derive probe base",
                description="test only",
                category="employees",
                filters=(
                    F.select("kind", "Kind", (("a", "A"), ("b", "B")), default="a"),
                    *F.scope(status="all"),
                ),
                columns=(
                    ColumnSpec("code", "Code", TEXT),
                    ColumnSpec("type", "Type", TEXT),
                    ColumnSpec("kind", "Kind", TEXT),
                ),
                run=_probe_run,
                modules=("employees",),
            )
        )
        self.addCleanup(registry._REGISTRY.pop, BASE_PROBE, None)
        self.derived = derive(
            base.id,
            id=DERIVED_PROBE,
            title="Derive probe (staff, kind B)",
            description="test only",
            category="employees",
            pin={"employment_type": "staff", "kind": "b"},
            drop=("employmentType", "kind"),
        )
        self.addCleanup(registry._REGISTRY.pop, DERIVED_PROBE, None)
        listed = mock.patch.dict(layout._ORDER, {BASE_PROBE: ("employees", 900), DERIVED_PROBE: ("employees", 901)})
        listed.start()
        self.addCleanup(listed.stop)

    def run_rows(self, rid, **params):
        r = self.get(f"/api/reports/run/{rid}", self.admin, **params)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()["rows"]

    def test_the_base_follows_the_query_string(self):
        rows = self.run_rows(BASE_PROBE, employmentType="production", kind="b")
        self.assertEqual([(r["code"], r["type"], r["kind"]) for r in rows], [("DP1", "production", "b")])

    def test_a_pinned_value_wins_over_the_query_string(self):
        for params in ({}, {"employmentType": "production", "kind": "a"}, {"employmentType": "staff", "kind": "a"}):
            with self.subTest(params=params):
                rows = self.run_rows(DERIVED_PROBE, **params)
                self.assertEqual(
                    [(r["code"], r["type"], r["kind"]) for r in rows], [("DS1", "staff", "b"), ("DS2", "staff", "b")]
                )
        # the export runs the same pinned report
        x = self.get(f"/api/reports/export/{DERIVED_PROBE}", self.admin, fmt="xlsx", employmentType="production")
        self.assertEqual(x.status_code, 200)
        ws = load_workbook(io.BytesIO(x.content)).active
        codes = [ws.cell(row=HEADER_ROW + 1 + i, column=1).value for i in range(3)]
        self.assertEqual(codes[:2], ["DS1", "DS2"])
        self.assertNotEqual(codes[2], "DP1")

    def test_the_pinned_filters_are_not_offered(self):
        derived = next(r for r in self.catalog(self.admin)["reports"] if r["id"] == DERIVED_PROBE)
        keys = [f["key"] for f in derived["filters"]]
        self.assertNotIn("employmentType", keys)
        self.assertNotIn("kind", keys)
        self.assertIn("department", keys)
        self.assertIsNone(self.derived.family)

    def test_the_layouts_derived_report_ignores_its_dropped_filters(self):
        # assigned-shift-report = shift-roster with the shift-name text and Saturday choices dropped
        spec = next(r for r in self.catalog(self.admin)["reports"] if r["id"] == "assigned-shift-report")
        keys = [f["key"] for f in spec["filters"]]
        self.assertNotIn("shift", keys)
        self.assertNotIn("saturdayOff", keys)
        plain = self.get("/api/reports/run/assigned-shift-report", self.admin)
        self.assertEqual(plain.status_code, 200, plain.content[:300])
        self.assertGreaterEqual(plain.json()["rowCount"], 3)
        # the base would narrow to nobody on these; the derived entry does not declare them, so they change nothing
        narrowed = self.get(
            "/api/reports/run/assigned-shift-report", self.admin, shift="zz-no-such-shift", saturdayOff="yes"
        )
        self.assertEqual(narrowed.status_code, 200)
        self.assertEqual(narrowed.json()["rows"], plain.json()["rows"])


# ── every listed report on a seeded month ────────────────────────────────────────────────────────────────────────────

# Reports whose default run on the seeded month must show data rows (the rest may legitimately be empty on the seed:
# geo punches, on-duty, shift changes, misspunch requests ...).
MUST_HAVE_ROWS = {
    "employee-confo-details",
    "hr-attendance-register-summary",
    "hr-time-card",
    "staff-attendance-report",
    "production-attendance-report",
    "staff-time-card-report",
    "time-card-shift-count",
    "production-time-card-punches",
    "production-all-punches",
    "attendance-log-report",
    "production-attendance-log",
    "leave-report",
    "assigned-shift-report",
    "gained-shift-report",
    "shift-wise-attendance",
    "department-headcount-report",
    "department-employee-report",
    "employee-overall-details",
    "employee-fixed-salary",
    "employee-monthly-shift",
    "employee-time-card",
    "employee-punch-details",
    # last month = June (the salary reports open on last month; HR's Production Salary Statement opens on Weekly)
    "hr-salary-statement",
    "salary-statement",
    "production-salary-report",
    "staff-salary-report",
    "department-salary-report",
}


# ── the HR category's OUTPUT on the seeded month ─────────────────────────────────────────────────────────────────────

# sha256 (first 16 hex) and data-row count of each HR report's run payload on its default filters, on the seeded month
# (EveryListedReportTests' seed, random.seed(20261119)), with the generated time / by and any id left out. Measured with
# git HEAD's (0254f9e) api/reporting package on the same seed (scratch run: HEAD's reporting package swapped in, the
# working tree's models / engine / seed / payroll), and identical with this tree's: the HR category's output is what HEAD
# printed. Not covered by this seed: a production worker on a SPECIAL shift, whose early-morning punch the shared
# night-session resolution now places on the shift day the engine gives it (employee_id passed, 2026-11-19; see
# tests_reporting_rc_attendance_production.SpecialShiftFixTests) - for everybody else nothing changed.
HR_OUTPUT_AT_HEAD = {
    "2026-06-30/employee-confo-details": ("0a23fb4397a2a887", 35),
    "2026-06-30/production-daily-punches": ("86e7f737aaff9f40", 25),
    "2026-06-30/production-shift-rules": ("cc6124ad178f3233", 16),
    "2026-06-30/hr-salary-statement": ("496096f4af6cd6b7", 0),
    "2026-06-30/hr-production-salary-statement": ("fec76a7afc442c52", 0),
    "2026-06-30/hr-daily-movement-register": ("11abaed1ca5ee74f", 34),
    "2026-06-30/hr-punching-register": ("5d3671874cc28673", 34),
    "2026-06-30/hr-strength-register": ("471d4120df9186d4", 19),
    "2026-06-30/hr-attendance-register-summary": ("90839fbee745f451", 35),
    "2026-06-30/hr-time-card": ("9aa8e9b7a5358ae3", 1050),
    "2026-07-15/employee-confo-details": ("c2c9c4e6ebca92f8", 35),
    "2026-07-15/production-daily-punches": ("edc5c115a6be2142", 0),
    "2026-07-15/production-shift-rules": ("cc6124ad178f3233", 16),
    "2026-07-15/hr-salary-statement": ("95a179715ffcf3fa", 10),
    "2026-07-15/hr-production-salary-statement": ("fec76a7afc442c52", 0),
    "2026-07-15/hr-daily-movement-register": ("54450dc517c8031f", 0),
    "2026-07-15/hr-punching-register": ("83a14556517cfe06", 0),
    "2026-07-15/hr-strength-register": ("763b6cccd60850a9", 19),
    "2026-07-15/hr-attendance-register-summary": ("05f0a1eb4a8ebb14", 35),
    "2026-07-15/hr-time-card": ("3c4a82ee31afa1cd", 525),
}


def _hr_output_digest(payload: dict) -> str:
    def clean(v):
        if isinstance(v, dict):
            return {
                k: clean(x)
                for k, x in v.items()
                if k not in ("generatedAt", "generatedBy", "id") and not k.endswith(("Id", "_id"))
            }
        if isinstance(v, list):
            return [clean(x) for x in v]
        return v

    text = json.dumps(clean(payload), sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class EveryListedReportTests(_Catalog):
    """seed_data: 10 staff + 25 production employees with punches, shifts, leave and holidays for June 2026; the stored
    day verdicts are worked out by the engine (what the background refresh does) and payroll is generated for June (the
    staff month and the production BiWeekly period 1-14 June, at a rate per shift the seed leaves blank)."""

    @classmethod
    def setUpTestData(cls):
        random.seed(20261119)  # seed_data draws names, punches and leave at random: the same seed every run
        call_command(
            "seed_data", confirm=True, verbosity=0, stdout=io.StringIO(), stderr=io.StringIO()
        )  # its check mark cannot be printed to a cp1252 console
        ps = PayrollSettings.get()
        ps.prod_cycles = {
            "weekly": {"weekStart": "monday"},
            "biweekly": {"weekStart": "monday", "anchorDate": "2026-06-01"},
            "monthly": {"weekStart": "monday", "anchorDate": "2026-06-01"},
        }
        ps.save()
        Employee.objects.filter(employment_type="production").update(
            salary_per_shift=Decimal("520"), production_pay_cycle="biweekly"
        )
        june = [date(2026, 6, 1) + timedelta(days=i) for i in range(30)]
        employees = list(Employee.objects.order_by("employee_code"))
        for emp in employees:
            for d in june:
                compute_day_record(emp, d)
        cls.payrolls = {"staff": 0, "production": 0}
        for emp in employees:
            try:
                if emp.employment_type == "production":
                    _generate_production_payroll(emp, date(2026, 6, 1), date(2026, 6, 14), pay_cycle="biweekly")
                else:
                    _generate_staff_payroll(emp, 6, 2026)
                cls.payrolls[emp.employment_type] += 1
            except PayrollSkip:
                pass
        cls.kinds = {e.employment_type for e in employees}
        cls.admin = HRUser.objects.create(username="rc_every_admin", password_hash="x", is_super_admin=True)

    def test_the_seed_has_both_kinds_and_their_payroll(self):
        self.assertEqual(self.kinds, {"staff", "production"})
        self.assertGreater(self.payrolls["staff"], 0)
        self.assertGreater(self.payrolls["production"], 0)

    def test_every_listed_report_runs_on_its_defaults_and_builds_excel_and_pdf(self):
        with_rows: set[str] = set()
        for today in SEEDED_TODAYS:
            patches = report_today(today)
            for p in patches:
                p.start()
            try:
                with_rows |= self._run_and_export_everything(str(today))
            finally:
                for p in patches:
                    p.stop()
        missing = sorted(MUST_HAVE_ROWS - with_rows)
        self.assertFalse(missing, f"no data rows on the seeded month: {missing}")

    def _run_and_export_everything(self, label: str) -> set[str]:
        reports = self.catalog(self.admin)["reports"]
        self.assertEqual([r["id"] for r in reports], FLAT_LAYOUT)
        with_rows = set()
        for spec in reports:
            rid = spec["id"]
            with self.subTest(report=rid, today=label):
                q = default_query(spec)
                r = self.get(f"/api/reports/run/{rid}", self.admin, **q)
                self.assertEqual(r.status_code, 200, r.content[:400])
                body = r.json()
                self.assertEqual(body["id"], rid)
                self.assertTrue(body["columns"], "no columns")
                if any(not row.get("_kind") for row in body["rows"]):
                    with_rows.add(rid)
                x = self.get(f"/api/reports/export/{rid}", self.admin, **q, fmt="xlsx")
                self.assertEqual(x.status_code, 200, x.content[:300])
                self.assertTrue(x.content.startswith(b"PK"))
                ws = load_workbook(io.BytesIO(x.content)).active
                if registry.get_spec(rid).xlsx_builder is None:
                    # the generic sheet repeats the screen's columns (a report with its own builder lays out its own)
                    header = [c.value for c in ws[HEADER_ROW]]
                    self.assertEqual(header[: len(body["columns"])], [c["label"] for c in body["columns"]])
                p = self.get(f"/api/reports/export/{rid}", self.admin, **q, fmt="pdf")
                self.assertEqual(p.status_code, 200, p.content[:300])
                self.assertTrue(p.content.startswith(b"%PDF"))
        return with_rows

    def test_every_listed_report_runs_on_its_defaults_today(self):
        # today is far from the seeded month: mostly empty, never an error
        for spec in self.catalog(self.admin)["reports"]:
            with self.subTest(report=spec["id"]):
                r = self.get(f"/api/reports/run/{spec['id']}", self.admin, **default_query(spec))
                self.assertEqual(r.status_code, 200, r.content[:400])

    def test_the_hr_categorys_output_is_what_git_head_printed(self):
        def request():
            r = RequestFactory().get("/")
            r.jwt_user = {"role": "hr", "hrUserId": self.admin.id}
            r._report_hr_user = self.admin
            return r

        got = {}
        for today in SEEDED_TODAYS:
            with mock.patch("api.reporting.filters.ist_today", return_value=today):
                for rid in EXPECTED_LAYOUT["hr"]:
                    spec = registry.get_spec(rid)
                    q = QueryDict(mutable=True)
                    for f in spec.filters:
                        d = F.resolve_default(f, today)
                        if f.kind in ("period", "employeeStatus") and d:
                            q[f.kind] = d
                        elif f.kind == "year" and d:
                            q["year"] = str(d)
                        elif f.kind == "dateRange" and d and d.get("dateFrom"):
                            q["dateFrom"], q["dateTo"] = d["dateFrom"], d["dateTo"]
                        elif f.kind == "select" and d:
                            q[f.key] = ",".join(d) if isinstance(d, list) else d
                        elif f.kind == "boolean" and d is not None:
                            q[f.key] = "true" if d else "false"
                        elif f.kind == "number" and d is not None:
                            q[f.key] = str(d)
                    payload = run_report(request(), spec, q).payload()
                    rows = sum(1 for r in payload["rows"] if not r.get("_kind"))
                    got[f"{today}/{rid}"] = (_hr_output_digest(payload), rows)
        for key, want in HR_OUTPUT_AT_HEAD.items():
            with self.subTest(run=key):
                self.assertEqual(got.get(key), want, "an HR report's output changed: the owner said it must not")
        self.assertEqual(set(got), set(HR_OUTPUT_AT_HEAD))
