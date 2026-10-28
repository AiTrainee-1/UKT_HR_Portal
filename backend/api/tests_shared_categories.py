"""
Endpoint Sharing: DATA CATEGORIES (staff | production) and permanent / expiring keys.

The owner's rule: a key is made for ONE category, and ONLY that category's data may ever come out of it. These tests try to
break that rule from every side, so a future change cannot quietly mix Staff and Production data.

What is pinned here
-------------------
CATALOG   every dataset declares how a category applies to it (scope function XOR neutral), a dataset that declares neither
          (or both) is a start-up error, only the holiday calendar is neutral, apply_category fails closed.
PUBLIC    for EVERY dataset x BOTH categories (seed data holds staff and production employees side by side): the rows are
          exactly that category's, no duplicates across pages, `meta.total` counts only that category, and no query string
          (other category's employmentType / employeeCode / departmentId / branchId, case variants, duplicated parameters,
          page and pageSize extremes), locked filter or field selection can widen it; an endpoint locked to the other category
          answers zero rows; a legacy key (category "") is unchanged; the two keys of one endpoint return disjoint row sets
          whose union is the legacy key's rows; an unrecognised stored category returns nothing.
CREATE    category is required and exact; the expiry is explicit (permanent XOR expiresAt, every malformed shape is a 400);
          a category that contradicts the endpoint's locked employmentType is refused; the key JSON, the audit row and the
          listing carry category and permanent.
LIFETIME  a permanent key has expires_at NULL and works however far the clock moves; an expiring key stops at its instant
          (datetime with / without offset, date = end of that day in factory time).
PREVIEW   the admin preview takes an optional category and shows what a key of that category would see.

Run via: python manage.py test api.tests_shared_categories
"""

import dataclasses
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.core.cache import cache
from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import shared_datasets as sd
from .clock import FACTORY_TZ
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    Department,
    Designation,
    Employee,
    Holiday,
    LeaveRequest,
    Payroll,
    SharedEndpoint,
    SharedEndpointAccessLog,
    SharedEndpointKey,
)
from .tests_shared_endpoints import INVALID_KEY, ManageBase, key_body, key_headers, make_endpoint, make_key

STAFF, PRODUCTION = "staff", "production"
CATEGORIES = (STAFF, PRODUCTION)
OTHER = {STAFF: PRODUCTION, PRODUCTION: STAFF}

#: the datasets whose rows belong to ONE employee (their rows are cut by that employee's type)
EMPLOYEE_BOUND = ("employees", "attendance-days", "attendance-punches", "leave-requests", "payroll-summary")
#: organisation datasets: a row is listed for a category only if it has an employee of it ({dataset: (Employee column, model)})
ORG_UNITS = {
    "departments": ("department_id", Department),
    "branches": ("branch_id", Branch),
    "designations": ("designation_id", Designation),
}
#: the parameters each dataset needs to answer at all (the seed data lives inside these windows)
PARAMS = {
    "employees": {"status": "all"},
    "attendance-days": {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"},
    "attendance-punches": {"dateFrom": "2026-10-12", "dateTo": "2026-10-18"},
    "payroll-summary": {"month": "2026-09"},
}
#: one field per dataset that touches NO employee column: the category must still apply when the page does not even read them
MINIMAL_FIELDS = {
    "employees": ["firstName"],
    "departments": ["name"],
    "branches": ["code"],
    "designations": ["level"],
    "attendance-days": ["date"],
    "attendance-punches": ["time"],
    "leave-requests": ["days"],
    "holidays": ["name"],
    "payroll-summary": ["month"],
}
#: how one API row of each dataset is identified (the seed makes every identity unique)
IDENTITY = {
    "employees": lambda r: r["employeeCode"],
    "departments": lambda r: r["id"],
    "branches": lambda r: r["id"],
    "designations": lambda r: r["id"],
    "attendance-days": lambda r: (r["employeeCode"], r["date"]),
    "attendance-punches": lambda r: (r["employeeCode"], r["date"], r["time"]),
    "leave-requests": lambda r: (r["employeeCode"], r["startDate"]),
    "holidays": lambda r: (r["date"], r["name"]),
    "payroll-summary": lambda r: (r["employeeCode"], r["month"], r["year"], r["periodStart"]),
}


def _in(category, employee) -> bool:
    return category is None or employee.employment_type == category


def want(dataset: str, category) -> set:
    """The rows a key of `category` (None = every category: a legacy key) must see, worked out in plain Python from the
    rows themselves, NOT with the scope functions under test."""
    employees = list(Employee.objects.all())
    if dataset == "employees":
        return {e.employee_code for e in employees if _in(category, e)}
    if dataset in ORG_UNITS:
        column, model = ORG_UNITS[dataset]
        used = {getattr(e, column) for e in employees if _in(category, e) and getattr(e, column) is not None}
        return {row.id for row in model.objects.all() if category is None or row.id in used}
    if dataset == "attendance-days":
        rows = AttendanceDayRecord.objects.select_related("employee")
        return {
            (r.employee.employee_code, r.date.isoformat())
            for r in rows
            if _in(category, r.employee) and date(2026, 10, 1) <= r.date <= date(2026, 10, 31)
        }
    if dataset == "attendance-punches":
        rows = AttendanceLog.objects.select_related("employee")
        return {
            (r.employee.employee_code, r.date.isoformat(), r.punch_time.strftime("%H:%M:%S"))
            for r in rows
            if _in(category, r.employee) and date(2026, 10, 12) <= r.date <= date(2026, 10, 18)
        }
    if dataset == "leave-requests":
        rows = LeaveRequest.objects.select_related("employee")
        return {(r.employee.employee_code, r.start_date) for r in rows if _in(category, r.employee)}
    if dataset == "holidays":
        return {(h.date.isoformat(), h.name) for h in Holiday.objects.all()}
    if dataset == "payroll-summary":
        rows = Payroll.objects.select_related("employee")
        return {
            (
                r.employee.employee_code,
                r.month,
                r.year,
                r.period_start.isoformat() if r.period_start else None,
            )
            for r in rows
            if _in(category, r.employee) and (r.year, r.month) == (2026, 9)
        }
    raise AssertionError(dataset)


class SeedMixin:
    """Staff AND production employees side by side, with rows in every dataset for both, plus organisation units that only
    one category uses, one both use and one nobody uses."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        mk_branch = Branch.objects.create
        cls.b_staff = mk_branch(name="CAT Staff Branch", code="CATBS")
        cls.b_prod = mk_branch(name="CAT Production Branch", code="CATBP")
        cls.b_both = mk_branch(name="CAT Shared Branch", code="CATBB")
        cls.b_closed = mk_branch(name="CAT Closed Production Branch", code="CATBC")
        cls.b_none = mk_branch(name="CAT Empty Branch", code="CATBN")
        cls.d_staff = Department.objects.create(name="CAT Staff Dept", branch=cls.b_staff)
        cls.d_prod = Department.objects.create(name="CAT Production Dept", branch=cls.b_prod)
        cls.d_both = Department.objects.create(name="CAT Shared Dept", branch=cls.b_both)
        cls.d_closed = Department.objects.create(name="CAT Closed Production Dept", branch=cls.b_closed)
        cls.d_none = Department.objects.create(name="CAT Empty Dept", branch=cls.b_none)
        cls.g_staff = Designation.objects.create(title="CAT Staff Title", department=cls.d_staff)
        cls.g_prod = Designation.objects.create(title="CAT Production Title", department=cls.d_prod)
        cls.g_both = Designation.objects.create(title="CAT Shared Title", department=cls.d_both)
        cls.g_closed = Designation.objects.create(title="CAT Closed Production Title", department=cls.d_closed)
        cls.g_none = Designation.objects.create(title="CAT Empty Title", department=cls.d_none)

        def employee(code, kind, **kw):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Cat",
                employment_type=kind,
                status=kw.pop("status", "active"),
                **kw,
            )

        cls.s1 = employee("CATS1", STAFF, department=cls.d_staff, branch=cls.b_staff, designation=cls.g_staff)
        cls.s2 = employee("CATS2", STAFF, department=cls.d_both, branch=cls.b_both, designation=cls.g_both)
        cls.s3 = employee(
            "CATS3", STAFF, status="inactive", department=cls.d_staff, branch=cls.b_staff, designation=cls.g_staff
        )
        cls.s4 = employee("CATS4", STAFF)  # no department, branch or designation at all
        cls.p1 = employee("CATP1", PRODUCTION, department=cls.d_prod, branch=cls.b_prod, designation=cls.g_prod)
        cls.p2 = employee("CATP2", PRODUCTION, department=cls.d_both, branch=cls.b_both, designation=cls.g_both)
        cls.p3 = employee(
            "CATP3",
            PRODUCTION,
            status="inactive",
            department=cls.d_closed,
            branch=cls.b_closed,
            designation=cls.g_closed,
        )
        cls.p4 = employee("CATP4", PRODUCTION)
        everyone = (cls.s1, cls.s2, cls.s3, cls.s4, cls.p1, cls.p2, cls.p3, cls.p4)

        for emp in everyone:
            AttendanceDayRecord.objects.create(employee=emp, date=date(2026, 10, 14), status="present")
        for emp in (cls.s1, cls.p1):
            AttendanceDayRecord.objects.create(employee=emp, date=date(2026, 10, 15), status="absent")
        for emp, at in (
            (cls.s1, time(8, 0)),
            (cls.s2, time(8, 5)),
            (cls.p1, time(8, 10)),
            (cls.p2, time(8, 15)),
            (cls.p4, time(8, 20)),
        ):
            AttendanceLog.objects.create(
                employee=emp, date=date(2026, 10, 14), punch_time=at, punch_type="IN", source="manual"
            )
        AttendanceLog.objects.create(
            employee=cls.s1, date=date(2026, 10, 14), punch_time=time(17, 0), punch_type="OUT", source="manual"
        )
        AttendanceLog.objects.create(
            employee=cls.p1, date=date(2026, 10, 14), punch_time=time(17, 5), punch_type="OUT", source="manual"
        )
        for emp in (cls.s1, cls.s2, cls.p1, cls.p2, cls.p3):
            LeaveRequest.objects.create(
                employee=emp, start_date="2026-10-20", end_date="2026-10-21", total_days=Decimal("2"), status="approved"
            )
        Holiday.objects.create(name="CAT Holiday A", date=date(2026, 10, 20), holiday_type="national")
        Holiday.objects.create(name="CAT Holiday B", date=date(2026, 11, 1), holiday_type="company")
        for emp in (cls.s1, cls.s2):
            Payroll.objects.create(
                employee=emp,
                salary_mode="monthly",
                month=9,
                year=2026,
                base_salary=Decimal("20000"),
                gross_salary=Decimal("20000"),
                final_salary=Decimal("19000"),
            )
        for emp, start in ((cls.p1, date(2026, 9, 1)), (cls.p1, date(2026, 9, 8)), (cls.p2, date(2026, 9, 1))):
            Payroll.objects.create(
                employee=emp,
                salary_mode="shift",
                month=9,
                year=2026,
                period_start=start,
                period_end=start + timedelta(days=6),
                base_salary=Decimal("700"),
                gross_salary=Decimal("4900"),
                final_salary=Decimal("4900"),
            )

    @staticmethod
    def type_of() -> dict[str, str]:
        return {e.employee_code: e.employment_type for e in Employee.objects.all()}


# ═══ the catalog ═══════════════════════════════════════════════════════════════════════════════════════════════


class CategoryCatalogTests(SimpleTestCase):
    def test_the_categories_are_the_employment_types(self):
        self.assertEqual(sd.CATEGORIES, (STAFF, PRODUCTION))
        self.assertEqual({value for value, _label in Employee.EMPLOYMENT_TYPES}, set(sd.CATEGORIES))

    def test_every_dataset_declares_a_scope_or_neutral_and_never_both(self):
        for ds in sd.DATASETS.values():
            with self.subTest(dataset=ds.key):
                # a neutral dataset has no scope function, every other one has one: exactly one of the two is declared
                self.assertEqual(ds.category_scope is None, ds.category_neutral)
                self.assertEqual(sd.category_problems(ds), [])

    def test_only_the_holiday_calendar_is_neutral(self):
        self.assertEqual({k for k, ds in sd.DATASETS.items() if ds.category_neutral}, {"holidays"})
        self.assertEqual(
            {k for k, ds in sd.DATASETS.items() if ds.category_scope is not None},
            set(EMPLOYEE_BOUND) | set(ORG_UNITS),
        )

    def test_a_dataset_that_declares_neither_or_both_is_a_start_up_error(self):
        neither = dataclasses.replace(sd.EMPLOYEES, key="neither", category_scope=None, category_neutral=False)
        both = dataclasses.replace(sd.EMPLOYEES, key="both", category_neutral=True)
        self.assertEqual(
            sd.category_problems(neither), ["neither: declares neither category_scope nor category_neutral"]
        )
        self.assertEqual(sd.category_problems(both), ["both: declares both category_scope and category_neutral"])
        for bad in (neither, both):
            with self.subTest(dataset=bad.key):
                original = dict(sd.DATASETS)
                sd.DATASETS[bad.key] = bad
                try:
                    with self.assertRaises(RuntimeError) as raised:
                        sd._verify_catalog()
                    self.assertIn("category", str(raised.exception))
                finally:
                    sd.DATASETS.clear()
                    sd.DATASETS.update(original)
                sd._verify_catalog()

    def test_the_catalog_json_says_how_the_category_applies(self):
        shown = {d["key"]: d["categoryScope"] for d in sd.catalog_json()["datasets"]}
        self.assertEqual(shown, {k: ("neutral" if k == "holidays" else "employee") for k in sd.DATASETS})


class SourceGuardTests(TestCase):
    """The category is applied by BOTH callers of the catalog, through the one function, with the key's own category."""

    def setUp(self):
        super().setUp()
        cache.clear()

    def test_the_public_call_applies_the_keys_category_to_the_queryset(self):
        ep = make_endpoint(slug="guard-ep", fields=["employeeCode"])
        staff, _ = make_key(ep, "s", category=STAFF)
        with mock.patch.object(sd, "apply_category", wraps=sd.apply_category) as spy:
            self.assertEqual(self.client.get("/api/shared/guard-ep", **key_headers(staff)).status_code, 200)
        self.assertEqual(spy.call_count, 1)
        dataset, queryset, category = spy.call_args.args
        self.assertEqual((dataset.key, category), ("employees", STAFF))
        self.assertTrue(hasattr(queryset, "query"))

    def test_a_failed_call_never_reaches_the_data(self):
        ep = make_endpoint(slug="guard-ep", fields=["employeeCode"])
        make_key(ep, "s", category=STAFF)
        with mock.patch.object(sd, "apply_category", wraps=sd.apply_category) as spy:
            self.assertEqual(self.client.get("/api/shared/guard-ep").status_code, 401)
        self.assertEqual(spy.call_count, 0)


# ═══ the public call ═══════════════════════════════════════════════════════════════════════════════════════════


class PublicBase(SeedMixin, TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self._eps: dict[str, SharedEndpoint] = {}
        self._keys: dict[tuple, str] = {}

    def ep_for(self, dataset: str, minimal: bool = False) -> SharedEndpoint:
        name = (dataset, minimal)
        if name not in self._eps:
            fields = MINIMAL_FIELDS[dataset] if minimal else [f.key for f in sd.DATASETS[dataset].fields]
            slug = f"cat-{dataset}" + ("-min" if minimal else "")
            self._eps[name] = make_endpoint(
                slug=slug, dataset=dataset, fields=fields, name=slug, rate_limit_per_minute=6000
            )
        return self._eps[name]

    def key_for(self, dataset: str, category: str, minimal: bool = False) -> str:
        name = (dataset, category, minimal)
        if name not in self._keys:
            self._keys[name] = make_key(self.ep_for(dataset, minimal), category or "legacy", category=category)[0]
        return self._keys[name]

    def get(self, dataset: str, category: str, params=None, minimal=False, **extra):
        """One raw call of the dataset's endpoint with a key of `category` ("" = a legacy key)."""
        url = self.ep_for(dataset, minimal).slug
        merged = {**PARAMS.get(dataset, {}), **(params or {})}
        return self.client.get(
            f"/api/shared/{url}", merged, **key_headers(self.key_for(dataset, category, minimal)), **extra
        )

    def fetch_all(self, dataset: str, category: str, params=None, page_size=3, minimal=False):
        """(every row over all pages, the set of `total`s the pages reported, the first page's meta)."""
        rows, totals, first, page = [], set(), None, 1
        while True:
            r = self.get(dataset, category, {**(params or {}), "page": page, "pageSize": page_size}, minimal)
            self.assertEqual(r.status_code, 200, r.content[:300])
            body = r.json()
            rows += body["data"]
            totals.add(body["meta"]["total"])
            first = first or body["meta"]
            if not body["meta"]["hasMore"]:
                return rows, totals, first
            page += 1
            self.assertLess(page, 500, "paging never ended")

    def assert_belongs(self, dataset: str, rows: list, category: str):
        """No row of an employee of the OTHER category (employee-bound datasets carry the employee's code)."""
        kinds = self.type_of()
        for row in rows:
            if dataset in EMPLOYEE_BOUND:
                self.assertEqual(kinds[row["employeeCode"]], category, f"{dataset}: {row}")
            if dataset == "employees":
                self.assertEqual(row["employmentType"], category)


class EveryDatasetEveryCategoryTests(PublicBase):
    def test_the_seed_is_meaningful(self):
        """Guards the matrix below against passing vacuously: both categories have rows, and they differ."""
        for dataset in sd.DATASETS:
            with self.subTest(dataset=dataset):
                staff, production, everything = want(dataset, STAFF), want(dataset, PRODUCTION), want(dataset, None)
                self.assertTrue(staff and production)
                if dataset == "holidays":
                    self.assertEqual(staff, production)
                else:
                    self.assertNotEqual(staff, production)
                    self.assertLess(staff, everything)  # a proper subset: the other category's rows are missing

    def test_a_key_sees_exactly_its_own_categorys_rows_for_every_dataset(self):
        for dataset in sd.DATASETS:
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    expected = want(dataset, category)
                    rows, totals, meta = self.fetch_all(dataset, category)
                    ids = [IDENTITY[dataset](r) for r in rows]
                    self.assertEqual(len(ids), len(set(ids)), "a row came twice")
                    self.assertEqual(set(ids), expected)
                    self.assertEqual(totals, {len(expected)}, "meta.total counted something else")
                    self.assertEqual(meta["category"], category)
                    self.assert_belongs(dataset, rows, category)
                    self.assertFalse(set(ids) & (want(dataset, OTHER[category]) - expected))

    def test_the_category_still_applies_when_the_page_reads_no_employee_column(self):
        for dataset in sd.DATASETS:
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    rows, totals, _meta = self.fetch_all(dataset, category, minimal=True)
                    self.assertEqual(totals, {len(want(dataset, category))})
                    self.assertEqual(len(rows), len(want(dataset, category)))

    def test_a_legacy_key_is_unchanged_and_says_so(self):
        for dataset in sd.DATASETS:
            with self.subTest(dataset=dataset):
                rows, totals, meta = self.fetch_all(dataset, "")
                self.assertEqual({IDENTITY[dataset](r) for r in rows}, want(dataset, None))
                self.assertEqual(totals, {len(want(dataset, None))})
                self.assertIsNone(meta["category"])

    def test_the_x_api_key_header_is_scoped_the_same(self):
        key = self.key_for("employees", PRODUCTION)
        body = self.client.get("/api/shared/cat-employees", {"status": "all"}, HTTP_X_API_KEY=key).json()
        self.assertEqual({r["employeeCode"] for r in body["data"]}, want("employees", PRODUCTION))
        self.assertEqual(body["meta"]["category"], PRODUCTION)

    def test_organisation_units_appear_for_a_category_only_if_it_has_employees(self):
        def names(dataset, category, field):
            return {r[field] for r in self.fetch_all(dataset, category)[0] if r[field].startswith("CAT ")}

        for dataset, field, staff_only, production_only, shared, empty, closed in (
            (
                "departments",
                "name",
                "CAT Staff Dept",
                "CAT Production Dept",
                "CAT Shared Dept",
                "CAT Empty Dept",
                "CAT Closed Production Dept",
            ),
            (
                "branches",
                "name",
                "CAT Staff Branch",
                "CAT Production Branch",
                "CAT Shared Branch",
                "CAT Empty Branch",
                "CAT Closed Production Branch",
            ),
            (
                "designations",
                "title",
                "CAT Staff Title",
                "CAT Production Title",
                "CAT Shared Title",
                "CAT Empty Title",
                "CAT Closed Production Title",
            ),
        ):
            with self.subTest(dataset=dataset):
                self.assertEqual(names(dataset, STAFF, field), {staff_only, shared})
                # a unit whose only production employee is inactive still belongs to production (every departmentId of
                # the category's employee rows must resolve)
                self.assertEqual(names(dataset, PRODUCTION, field), {production_only, shared, closed})
                self.assertEqual(
                    names(dataset, "", field), {staff_only, production_only, shared, empty, closed}
                )  # (a legacy key sees the unit nobody uses too)

    def test_the_holiday_calendar_is_the_same_for_both_categories(self):
        for category in CATEGORIES:
            rows, totals, _meta = self.fetch_all("holidays", category)
            self.assertEqual({r["name"] for r in rows}, {"CAT Holiday A", "CAT Holiday B"})
            self.assertEqual(totals, {2})

    def test_default_status_filter_stays_inside_the_category(self):
        for category in CATEGORIES:
            r = self.get("employees", category, {"status": "active"})
            codes = {row["employeeCode"] for row in r.json()["data"]}
            active = {e.employee_code for e in Employee.objects.filter(status="active", employment_type=category)}
            self.assertEqual(codes, active)
            self.assertEqual(r.json()["meta"]["total"], len(active))
        for category in CATEGORIES:  # no status given: the dataset default (active)
            url = "/api/shared/cat-employees"
            body = self.client.get(url, **key_headers(self.key_for("employees", category))).json()
            self.assertTrue(all(r["employmentType"] == category and r["status"] == "active" for r in body["data"]))

    def test_a_category_key_costs_the_same_queries_as_a_legacy_key(self):
        for dataset in sd.DATASETS:
            counts = {}
            for category in (STAFF, ""):
                self.get(dataset, category)  # warm-up (the hourly log purge, caches)
                with CaptureQueriesContext(connection) as ctx:
                    self.assertEqual(self.get(dataset, category).status_code, 200)
                counts[category] = len(ctx)
            with self.subTest(dataset=dataset):
                self.assertEqual(counts[STAFF], counts[""])


class NoQueryStringCanWidenACategoryTests(PublicBase):
    CODE = {STAFF: "CATS1", PRODUCTION: "CATP1"}
    ONLY_DEPT = {STAFF: "d_staff", PRODUCTION: "d_prod"}
    ONLY_BRANCH = {STAFF: "b_staff", PRODUCTION: "b_prod"}

    def attacks(self, dataset: str, category: str):
        """(label, params, True when the OTHER category's rows were named, so NOTHING may come back)."""
        other = OTHER[category]
        flt = sd.filter_map(sd.DATASETS[dataset])
        out = []
        if "employmentType" in flt:
            out += [
                ("other employmentType", {"employmentType": other}, True),
                ("own employmentType", {"employmentType": category}, False),
            ]
        if "employeeCode" in flt:
            out += [
                ("other employee's code", {"employeeCode": self.CODE[other]}, True),
                ("own employee's code", {"employeeCode": self.CODE[category]}, False),
            ]
        if "departmentId" in flt:
            out += [
                ("other category's only department", {"departmentId": getattr(self, self.ONLY_DEPT[other]).id}, True),
                ("a department both categories use", {"departmentId": self.d_both.id}, False),
            ]
        if "branchId" in flt:
            out += [
                ("other category's only branch", {"branchId": getattr(self, self.ONLY_BRANCH[other]).id}, True),
                ("a branch both categories use", {"branchId": self.b_both.id}, False),
            ]
        return out

    def test_narrowing_parameters_only_narrow(self):
        for dataset in sd.DATASETS:
            for category in CATEGORIES:
                for label, params, names_other in self.attacks(dataset, category):
                    with self.subTest(dataset=dataset, category=category, attack=label):
                        rows, totals, _meta = self.fetch_all(dataset, category, params)
                        ids = {IDENTITY[dataset](r) for r in rows}
                        self.assertTrue(ids <= want(dataset, category), "a row outside the category came back")
                        self.assert_belongs(dataset, rows, category)
                        if names_other:
                            self.assertEqual((rows, totals), ([], {0}))
                        else:
                            self.assertTrue(rows, "the narrowing parameter should still find the category's own rows")
                            self.assertEqual(totals, {len(rows)})

    def test_hostile_spellings_are_refused_never_widened(self):
        for dataset, ds in sd.DATASETS.items():
            if "employmentType" not in sd.filter_map(ds):
                continue
            for category in CATEGORIES:
                for label, params in (
                    ("name in lower case", {"employmenttype": OTHER[category]}),
                    ("name in upper case", {"EMPLOYMENTTYPE": OTHER[category]}),
                    ("name with a suffix", {"employmentType[]": OTHER[category]}),
                    ("value in capitals", {"employmentType": OTHER[category].upper()}),
                    ("value capitalised", {"employmentType": OTHER[category].capitalize()}),
                    ("value with a space", {"employmentType": OTHER[category] + " "}),
                    ("both values", {"employmentType": "staff,production"}),
                    ("a wildcard", {"employmentType": "*"}),
                    ("all", {"employmentType": "all"}),
                    ("empty", {"employmentType": ""}),
                    ("SQL", {"employmentType": "staff' OR '1'='1"}),
                    ("a NUL", {"employmentType": "staff\x00"}),
                ):
                    with self.subTest(dataset=dataset, category=category, attack=label):
                        r = self.get(dataset, category, params)
                        self.assertEqual(r.status_code, 400, r.content[:200])
                        self.assertEqual(r.json()["error"], "invalid_parameter")
                        self.assertNotIn("data", r.json())

    def test_a_parameter_given_twice_is_refused(self):
        for dataset in sd.DATASETS:
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    r = self.get(dataset, category, {"page": ["1", "2"]})
                    self.assertEqual(r.status_code, 400)
                    if "employmentType" in sd.filter_map(sd.DATASETS[dataset]):
                        r = self.get(dataset, category, {"employmentType": [STAFF, PRODUCTION]})
                        self.assertEqual((r.status_code, r.json()["error"]), (400, "invalid_parameter"))

    def test_page_extremes_stay_inside_the_category(self):
        for dataset in sd.DATASETS:
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    expected = want(dataset, category)
                    # the deepest page that is still allowed: empty, and the total is still the category's own
                    r = self.get(dataset, category, {"page": 4001, "pageSize": 50}).json()
                    self.assertEqual((r["data"], r["meta"]["total"], r["meta"]["hasMore"]), ([], len(expected), False))
                    # one page far too deep, and a page number past the maximum: refused, never an answer
                    self.assertEqual(self.get(dataset, category, {"page": 4002, "pageSize": 50}).status_code, 400)
                    self.assertEqual(self.get(dataset, category, {"page": 1_000_001}).status_code, 400)
                    self.assertEqual(self.get(dataset, category, {"page": 0}).status_code, 400)
                    # the biggest page: capped, and only the category's rows
                    r = self.get(dataset, category, {"pageSize": 100_000}).json()
                    self.assertEqual(r["meta"]["total"], len(expected))
                    self.assertEqual({IDENTITY[dataset](x) for x in r["data"]}, expected)
                    self.assertLessEqual(r["meta"]["pageSize"], 200)
                    self.assertEqual(self.get(dataset, category, {"pageSize": 0}).status_code, 400)

    def test_total_never_counts_the_other_category(self):
        for dataset in EMPLOYEE_BOUND:
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    body = self.get(dataset, category, {"pageSize": 1}).json()
                    self.assertEqual(len(body["data"]), 1)
                    self.assertEqual(body["meta"]["total"], len(want(dataset, category)))
                    self.assertLess(body["meta"]["total"], len(want(dataset, None)))

    def test_error_and_refusal_answers_carry_no_category_data(self):
        ep = self.ep_for("employees")
        expired, _ = make_key(ep, "late", category=STAFF, expires_at=timezone.now() - timedelta(seconds=1))
        revoked, row = make_key(ep, "old", category=PRODUCTION)
        SharedEndpointKey.objects.filter(pk=row.pk).update(revoked_at=timezone.now())
        for presented in (expired, revoked, "uks_abcdefgh_" + "A" * 43):
            r = self.client.get("/api/shared/cat-employees", **key_headers(presented))
            self.assertEqual((r.status_code, r.json()), (401, INVALID_KEY))  # the same answer: no category leaks


class LockedFilterTests(PublicBase):
    def locked_endpoint(self, dataset: str, **locked) -> SharedEndpoint:
        fields = [f.key for f in sd.DATASETS[dataset].fields]
        return make_endpoint(
            slug=f"locked-{dataset}", dataset=dataset, fields=fields, locked_filters=locked, rate_limit_per_minute=6000
        )

    def call(self, ep: SharedEndpoint, key: str, params=None):
        merged = {**PARAMS.get(ep.dataset, {}), **(params or {})}
        merged = {k: v for k, v in merged.items() if k not in ep.locked_filters or k in (params or {})}
        return self.client.get(f"/api/shared/{ep.slug}", merged, **key_headers(key))

    def test_an_endpoint_locked_to_the_other_category_reads_nothing(self):
        """The create call refuses such a key (see CreateKeyTests); forced through the database it still returns NOTHING."""
        for dataset in ("employees", "attendance-days", "payroll-summary"):
            for locked_to, key_category in ((PRODUCTION, STAFF), (STAFF, PRODUCTION)):
                with self.subTest(dataset=dataset, locked_to=locked_to, key=key_category):
                    ep = self.locked_endpoint(dataset, employmentType=locked_to)
                    wrong, _ = make_key(ep, "wrong", category=key_category)
                    right, _ = make_key(ep, "right", category=locked_to)
                    legacy, _ = make_key(ep, "legacy")
                    body = self.call(ep, wrong).json()
                    self.assertEqual((body["data"], body["meta"]["total"]), ([], 0))
                    body = self.call(ep, right).json()
                    self.assertEqual(body["meta"]["total"], len(want(dataset, locked_to)))
                    self.assertEqual(self.call(ep, legacy).json()["meta"]["total"], len(want(dataset, locked_to)))
                    ep.delete()

    def test_a_locked_filter_cannot_widen_a_key(self):
        ep = self.locked_endpoint("employees", status="all", departmentId=str(self.d_both.id))
        staff, _ = make_key(ep, "s", category=STAFF)
        production, _ = make_key(ep, "p", category=PRODUCTION)
        self.assertEqual({r["employeeCode"] for r in self.call(ep, staff).json()["data"]}, {"CATS2"})
        self.assertEqual({r["employeeCode"] for r in self.call(ep, production).json()["data"]}, {"CATP2"})

    def test_a_locked_employee_code_of_the_other_category_reads_nothing(self):
        ep = self.locked_endpoint("employees", status="all", employeeCode="CATP1")
        staff, _ = make_key(ep, "s", category=STAFF)
        production, _ = make_key(ep, "p", category=PRODUCTION)
        self.assertEqual(self.call(ep, staff).json()["meta"]["total"], 0)
        self.assertEqual(self.call(ep, production).json()["meta"]["total"], 1)

    def test_locking_an_endpoint_to_the_other_category_later_makes_the_key_read_nothing(self):
        ep = make_endpoint(slug="later-ep", fields=["employeeCode"], rate_limit_per_minute=6000)
        staff, _ = make_key(ep, "s", category=STAFF)
        self.assertGreater(
            self.client.get("/api/shared/later-ep", {"status": "all"}, **key_headers(staff)).json()["meta"]["total"], 0
        )
        SharedEndpoint.objects.filter(pk=ep.pk).update(locked_filters={"employmentType": PRODUCTION})
        body = self.client.get("/api/shared/later-ep", **key_headers(staff)).json()
        self.assertEqual((body["data"], body["meta"]["total"]), ([], 0))

    def test_a_locked_parameter_still_cannot_be_overridden_by_the_caller(self):
        ep = self.locked_endpoint("employees", employmentType=STAFF)
        staff, _ = make_key(ep, "s", category=STAFF)
        r = self.call(ep, staff, {"employmentType": PRODUCTION})
        self.assertEqual((r.status_code, r.json()["error"]), (400, "invalid_parameter"))


class FailClosedTests(PublicBase):
    def test_an_unrecognised_stored_category_returns_nothing_for_every_dataset(self):
        for bogus in ("bogus", "Staff", "STAFF", " staff", "staff ", "production\n", "all", "both", " ", "staff,prod"):
            for dataset in sd.DATASETS:
                with self.subTest(category=bogus, dataset=dataset):
                    ep = self.ep_for(dataset)
                    key, _ = make_key(ep, "bogus", category=bogus)
                    body = self.client.get(f"/api/shared/{ep.slug}", PARAMS.get(dataset, {}), **key_headers(key)).json()
                    self.assertEqual((body["data"], body["meta"]["total"]), ([], 0))

    def test_apply_category_on_querysets(self):
        for ds in sd.DATASETS.values():
            base = sd.build_queryset(ds, {}, [ds.fields[0].key])
            with self.subTest(dataset=ds.key):
                self.assertEqual(sd.apply_category(ds, base, "").count(), base.count())  # legacy: unscoped
                self.assertEqual(sd.apply_category(ds, base, None).count(), base.count())
                for bogus in ("bogus", "Staff", "all", "staff "):
                    self.assertEqual(sd.apply_category(ds, base, bogus).count(), 0, bogus)

    def test_a_scoped_dataset_that_lost_its_scope_returns_nothing(self):
        """Defence in depth: a dataset object that somehow declares nothing is NOT served unscoped."""
        naked = dataclasses.replace(sd.EMPLOYEES, category_scope=None, category_neutral=False)
        base = sd.build_queryset(naked, {}, ["employeeCode"])
        self.assertGreater(base.count(), 0)
        self.assertEqual(sd.apply_category(naked, base, STAFF).count(), 0)

    def test_the_scope_functions_use_inner_joins_so_a_row_without_an_employee_cannot_match(self):
        for key in ("attendance-days", "attendance-punches", "leave-requests", "payroll-summary"):
            ds = sd.DATASETS[key]
            sql = str(sd.apply_category(ds, sd.build_queryset(ds, {}, MINIMAL_FIELDS[key]), STAFF).query)
            with self.subTest(dataset=key):
                self.assertIn("INNER JOIN", sql)
                self.assertIn('"employees"."employment_type"', sql)
                self.assertNotIn("LEFT OUTER JOIN", sql)
                self.assertFalse(ds.base().model._meta.get_field("employee").null, "an orphan row is possible: test it")

    def test_organisation_scopes_do_not_duplicate_rows(self):
        for key in ORG_UNITS:
            ds = sd.DATASETS[key]
            for category in CATEGORIES:
                scoped = sd.apply_category(ds, sd.build_queryset(ds, {}, ["id"]), category)
                ids = list(scoped.values_list("id", flat=True))
                with self.subTest(dataset=key, category=category):
                    self.assertEqual(len(ids), len(set(ids)))
                    self.assertEqual(set(ids), want(key, category))
        self.assertIn(
            "EXISTS",
            str(sd.apply_category(sd.DEPARTMENTS, sd.build_queryset(sd.DEPARTMENTS, {}, ["name"]), STAFF).query),
        )

    def test_payroll_follows_the_employees_current_type_not_the_salary_mode(self):
        """A DECISION worth pinning: the category is Employee.employment_type, the same rule for every dataset. An employee
        moved from production to staff takes their old production payroll rows with them to the staff key."""
        mover = Employee.objects.create(
            employee_code="CATM1", first_name="Mover", last_name="Cat", employment_type=STAFF, status="active"
        )
        Payroll.objects.create(
            employee=mover,
            salary_mode="shift",
            month=9,
            year=2026,
            period_start=date(2026, 9, 1),
            period_end=date(2026, 9, 7),
            base_salary=Decimal("700"),
            gross_salary=Decimal("4900"),
            final_salary=Decimal("4900"),
        )
        staff = {r["employeeCode"] for r in self.fetch_all("payroll-summary", STAFF)[0]}
        production = {r["employeeCode"] for r in self.fetch_all("payroll-summary", PRODUCTION)[0]}
        self.assertIn("CATM1", staff)
        self.assertNotIn("CATM1", production)


class DisjointUnionInvariantTests(SeedMixin, ManageBase):
    """The PROD-like invariant: one endpoint, two keys made through the real management API at the same time (a staff key
    and a production key) next to a legacy key. Employee datasets: disjoint row sets whose union is the legacy rows."""

    def make_endpoint_and_keys(self, dataset: str):
        ds = sd.DATASETS[dataset]
        body = {
            "slug": f"inv-{dataset}",
            "name": f"Invariant {dataset}",
            "dataset": dataset,
            "fields": [f.key for f in ds.fields],
            "acknowledgeSensitive": True,
            "rateLimitPerMinute": 6000,
        }
        ep = self.make(**body)
        keys = {}
        for category in CATEGORIES:
            r = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", key_body(category, category))
            self.assertEqual(r.status_code, 201, r.content[:300])
            self.assertEqual(r.json()["category"], category)
            keys[category] = r.json()["key"]
        keys[""] = make_key(SharedEndpoint.objects.get(pk=ep["id"]), "legacy")[0]
        return ep, keys

    def rows(self, dataset: str, ep: dict, key: str):
        out, page = [], 1
        while True:
            params = {**PARAMS.get(dataset, {}), "page": page, "pageSize": 4}
            r = self.client.get(f"/api/shared/{ep['slug']}", params, **key_headers(key))
            self.assertEqual(r.status_code, 200, r.content[:300])
            body = r.json()
            out += [IDENTITY[dataset](x) for x in body["data"]]
            if not body["meta"]["hasMore"]:
                return out, body["meta"]["total"]
            page += 1

    def test_two_keys_of_one_endpoint_return_disjoint_rows_that_add_up_to_the_legacy_rows(self):
        for dataset in sd.DATASETS:
            with self.subTest(dataset=dataset):
                ep, keys = self.make_endpoint_and_keys(dataset)
                (staff, staff_total), (production, production_total), (legacy, legacy_total) = (
                    self.rows(dataset, ep, keys[STAFF]),
                    self.rows(dataset, ep, keys[PRODUCTION]),
                    self.rows(dataset, ep, keys[""]),
                )
                for rows, total in ((staff, staff_total), (production, production_total), (legacy, legacy_total)):
                    self.assertEqual(len(rows), len(set(rows)))
                    self.assertEqual(len(rows), total)
                if dataset in EMPLOYEE_BOUND:
                    self.assertFalse(set(staff) & set(production), "the two categories overlap")
                    self.assertEqual(set(staff) | set(production), set(legacy))
                    self.assertEqual(staff_total + production_total, legacy_total)
                elif dataset in ORG_UNITS:
                    # a unit both categories use is in both; one nobody uses is in neither
                    both = set(staff) & set(production)
                    self.assertTrue(both)
                    self.assertEqual(set(staff) | set(production), set(legacy) - self.unused(dataset))
                else:
                    self.assertEqual((set(staff), set(production)), (set(legacy), set(legacy)))

    @staticmethod
    def unused(dataset: str) -> set:
        return want(dataset, None) - want(dataset, STAFF) - want(dataset, PRODUCTION)

    def test_the_category_survives_a_change_to_the_endpoint(self):
        ep, keys = self.make_endpoint_and_keys("employees")
        before = self.rows("employees", ep, keys[STAFF])
        self.assertEqual(self.put(ep, name="Renamed", pageSizeDefault=7, pageSizeMax=9).status_code, 200)
        self.assertEqual(self.put(ep, fields=["employeeCode", "employmentType"]).status_code, 200)
        self.assertEqual(self.rows("employees", ep, keys[STAFF]), before)
        self.assertEqual(
            self.put(ep, lockedFilters={"employmentType": PRODUCTION}).status_code, 200
        )  # now contradicts the key
        self.assertEqual(self.rows("employees", ep, keys[STAFF]), ([], 0))
        self.assertEqual(self.rows("employees", ep, keys[PRODUCTION])[1], len(want("employees", PRODUCTION)))


# ═══ creating keys ═════════════════════════════════════════════════════════════════════════════════════════════

CATEGORY_MESSAGE = "Choose which data this key may read: Staff or Production."
EXPIRY_MESSAGE = "Choose when the key expires, or make it a permanent key."
BOTH_MESSAGE = "Choose either an expiry date or a permanent key, not both."
PERMANENT_MESSAGE = "The permanent switch must be true or false."


class CreateKeyTests(ManageBase):
    def setUp(self):
        super().setUp()
        self.ep = self.make()
        self.keys_url = f"/api/shared-endpoints/{self.ep['id']}/keys"

    def post(self, body):
        return self.call("POST", self.keys_url, body)

    def refused(self, body, message=None):
        before = (SharedEndpointKey.objects.count(), self.audits("key_create").count())
        r = self.post(body)
        self.assertEqual(r.status_code, 400, f"{body} -> {r.content[:200]}")
        payload = r.json()
        self.assertTrue(payload["error"].endswith("."), payload)
        if message is not None:
            self.assertEqual(payload["error"], message)
        self.assertNotIn("key", payload)
        self.assertEqual(before, (SharedEndpointKey.objects.count(), self.audits("key_create").count()))
        return payload

    def future(self, **delta) -> datetime:
        return (timezone.now() + timedelta(**delta)).replace(microsecond=0)

    # category -----------------------------------------------------------------------------------------------

    def test_the_category_is_required_and_exact(self):
        self.refused({"label": "k", "permanent": True}, CATEGORY_MESSAGE)
        for bad in (
            None,
            "",
            " ",
            "all",
            "both",
            "any",
            "employee",
            "Staff",
            "STAFF",
            "Production",
            " staff",
            "staff ",
            "staff\n",
            "production,staff",
            "staff|production",
            ["staff"],
            ["staff", "production"],
            {"staff": True},
            1,
            0,
            True,
            False,
            1.5,
        ):
            with self.subTest(category=bad):
                self.refused(key_body("k", bad), CATEGORY_MESSAGE)

    def test_both_categories_are_accepted_and_come_back_on_the_key(self):
        for category in CATEGORIES:
            r = self.post(key_body(f"{category} key", category))
            self.assertEqual(r.status_code, 201, r.content[:300])
            body = r.json()
            self.assertEqual((body["category"], body["permanent"]), (category, True))
            self.assertEqual(SharedEndpointKey.objects.get(pk=body["id"]).category, category)
            self.assertEqual(r["Cache-Control"], "no-store")
            self.assertRegex(body["key"], r"^uks_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$")

    def test_the_label_is_still_checked_first(self):
        self.refused({"category": "staff", "permanent": True}, "The key label is required.")
        self.refused({"label": "", "category": "bogus"}, "The key label is required.")

    def test_a_category_that_contradicts_the_endpoints_locked_filter_is_refused(self):
        for dataset in ("employees", "attendance-days", "payroll-summary"):
            for locked_to in CATEGORIES:
                with self.subTest(dataset=dataset, locked_to=locked_to):
                    ep = self.make(
                        slug=f"lock-{dataset}-{locked_to}",
                        dataset=dataset,
                        fields=["employeeCode"],
                        lockedFilters={"employmentType": locked_to}
                        | ({"dateFrom": "2026-10-01", "dateTo": "2026-10-02"} if dataset == "attendance-days" else {})
                        | ({"month": "2026-09"} if dataset == "payroll-summary" else {}),
                    )
                    url = f"/api/shared-endpoints/{ep['id']}/keys"
                    r = self.call("POST", url, key_body("k", OTHER[locked_to]))
                    self.assertEqual(r.status_code, 400, r.content[:300])
                    self.assertIn(f"fixed to {locked_to} data", r.json()["error"])
                    self.assertTrue(r.json()["error"].endswith("."))
                    self.assertEqual(SharedEndpointKey.objects.filter(endpoint_id=ep["id"]).count(), 0)
                    ok = self.call("POST", url, key_body("k", locked_to))
                    self.assertEqual(ok.status_code, 201, ok.content[:300])
                    self.assertEqual(ok.json()["category"], locked_to)

    def test_other_locked_filters_do_not_restrict_the_category(self):
        ep = self.make(slug="locked-status", lockedFilters={"status": "all"})
        for category in CATEGORIES:
            r = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", key_body("k", category))
            self.assertEqual(r.status_code, 201)

    def test_a_dataset_without_an_employment_filter_takes_either_category(self):
        for dataset in ("holidays", "departments", "leave-requests", "attendance-punches"):
            ep = self.make(slug=f"free-{dataset}", dataset=dataset, fields=[sd.DATASETS[dataset].fields[0].key])
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    r = self.call("POST", f"/api/shared-endpoints/{ep['id']}/keys", key_body("k", category))
                    self.assertEqual(r.status_code, 201, r.content[:300])

    # the expiry ---------------------------------------------------------------------------------------------

    def test_the_expiry_must_be_chosen_explicitly(self):
        for name, extra in {
            "nothing": {},
            "permanent false": {"permanent": False},
            "permanent null": {"permanent": None},
            "empty expiry": {"expiresAt": ""},
            "null expiry": {"expiresAt": None},
            "false and empty": {"permanent": False, "expiresAt": ""},
            "null and null": {"permanent": None, "expiresAt": None},
        }.items():
            with self.subTest(case=name):
                self.refused({"label": "k", "category": "staff", **extra}, EXPIRY_MESSAGE)

    def test_permanent_and_an_expiry_together_are_refused(self):
        for expires in (
            self.future(days=5).date().isoformat(),
            self.future(days=5).isoformat(),
            "2020-01-01",
            "garbage",
            "   ",
            12345,
            True,
        ):
            with self.subTest(expires=expires):
                self.refused({"label": "k", "category": "staff", "permanent": True, "expiresAt": expires}, BOTH_MESSAGE)

    def test_permanent_must_be_a_real_boolean(self):
        for bad in ("true", "false", "True", "TRUE", "yes", "1", "", 1, 0, 1.0, [], [True], {}, {"a": 1}):
            with self.subTest(permanent=bad):
                self.refused({"label": "k", "category": "staff", "permanent": bad}, PERMANENT_MESSAGE)
                # not even with a perfectly good expiry next to it
                self.refused(
                    {
                        "label": "k",
                        "category": "staff",
                        "permanent": bad,
                        "expiresAt": self.future(days=3).date().isoformat(),
                    },
                    PERMANENT_MESSAGE,
                )

    def test_permanent_true_with_an_empty_expiry_makes_a_permanent_key(self):
        for extra in ({}, {"expiresAt": None}, {"expiresAt": ""}):
            with self.subTest(extra=extra):
                r = self.post({"label": "k", "category": "production", "permanent": True, **extra})
                self.assertEqual(r.status_code, 201, r.content[:300])
                body = r.json()
                self.assertEqual((body["permanent"], body["expiresAt"], body["status"]), (True, None, "active"))
                self.assertIsNone(SharedEndpointKey.objects.get(pk=body["id"]).expires_at)

    def test_every_bad_expiry_is_a_400_and_creates_nothing(self):
        now = timezone.now()
        for name, bad in {
            "past date": "2020-01-01",
            "yesterday": (now - timedelta(days=2)).date().isoformat(),
            "past datetime with offset": (now - timedelta(minutes=1)).isoformat(),
            "past naive datetime": (now - timedelta(hours=1)).astimezone(FACTORY_TZ).strftime("%Y-%m-%dT%H:%M:%S"),
            "past Zulu": (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "right now": now.isoformat(),
            "date over ten years": (now + timedelta(days=3651)).date().isoformat(),
            "datetime over ten years": (now + timedelta(days=3651)).isoformat(),
            "naive datetime over ten years": (now + timedelta(days=3651)).strftime("%Y-%m-%dT%H:%M:%S"),
            "year 1 with an offset": "0001-01-01T00:00:00+14:00",
            "year 9999 with an offset": "9999-12-31T23:59:59-14:00",
            "year 9999": "9999-12-31",
            "words": "tomorrow",
            "not a month": "2026-13-45",
            "not a day": "2030-02-30",
            "european order": "31/12/2030",
            "hour 25": "2030-01-01T25:00:00",
            "arabic digits": "٢٠٣٠-٠١-٠١",
            "a number": 12345,
            "a float": 1.5,
            "a boolean": True,
            "a list": ["2030-01-01"],
            "an object": {"date": "2030-01-01"},
            "whitespace": "   ",
            "SQL": "2030-01-01'; DROP TABLE shared_endpoint_keys; --",
        }.items():
            with self.subTest(expires=name):
                self.refused(key_body("k", "staff", expiresAt=bad))
        self.assertEqual(SharedEndpointKey.objects.count(), 0)

    def test_a_date_expires_at_the_end_of_that_day_in_factory_time(self):
        day = (timezone.now() + timedelta(days=30)).astimezone(FACTORY_TZ).date()
        body = self.post(key_body("k", "staff", expiresAt=day.isoformat())).json()
        expected = datetime.combine(day, time(23, 59, 59), tzinfo=FACTORY_TZ)
        self.assertEqual(SharedEndpointKey.objects.get(pk=body["id"]).expires_at, expected)
        self.assertEqual(body["expiresAt"], f"{day.isoformat()}T23:59:59+05:30")
        self.assertEqual((body["permanent"], body["status"]), (False, "active"))
        self.assertEqual(SharedEndpointKey.objects.get(pk=body["id"]).expires_at.astimezone(dt_timezone.utc).hour, 18)

    def test_a_datetime_with_or_without_an_offset_is_taken_exactly(self):
        base = self.future(days=2).astimezone(FACTORY_TZ).replace(tzinfo=None)  # a wall-clock time in factory time
        cases = {
            "naive is factory time": (base.strftime("%Y-%m-%dT%H:%M:%S"), base.replace(tzinfo=FACTORY_TZ)),
            "naive with a space": (base.strftime("%Y-%m-%d %H:%M:%S"), base.replace(tzinfo=FACTORY_TZ)),
            "naive without seconds": (base.strftime("%Y-%m-%dT%H:%M"), base.replace(second=0, tzinfo=FACTORY_TZ)),
            "with the factory offset": (base.strftime("%Y-%m-%dT%H:%M:%S") + "+05:30", base.replace(tzinfo=FACTORY_TZ)),
            "UTC offset": (base.strftime("%Y-%m-%dT%H:%M:%S") + "+00:00", base.replace(tzinfo=dt_timezone.utc)),
            "Zulu": (base.strftime("%Y-%m-%dT%H:%M:%S") + "Z", base.replace(tzinfo=dt_timezone.utc)),
            "a western offset": (
                base.strftime("%Y-%m-%dT%H:%M:%S") + "-08:00",
                base.replace(tzinfo=dt_timezone(timedelta(hours=-8))),
            ),
            "with microseconds": (
                base.strftime("%Y-%m-%dT%H:%M:%S") + ".250000+05:30",
                base.replace(microsecond=250000, tzinfo=FACTORY_TZ),
            ),
        }
        for name, (text, instant) in cases.items():
            with self.subTest(case=name):
                r = self.post(key_body("k", "production", expiresAt=text))
                self.assertEqual(r.status_code, 201, r.content[:300])
                stored = SharedEndpointKey.objects.get(pk=r.json()["id"]).expires_at
                self.assertEqual(stored, instant)
                self.assertFalse(r.json()["permanent"])
                self.assertEqual(r.json()["expiresAt"], stored.astimezone(FACTORY_TZ).isoformat(timespec="seconds"))

    def test_ten_years_is_the_longest_an_expiry_may_be(self):
        ok = (timezone.now() + timedelta(days=3649)).replace(microsecond=0)
        self.assertEqual(self.post(key_body("k", "staff", expiresAt=ok.isoformat())).status_code, 201)
        self.assertEqual(
            self.post(key_body("k2", "staff", expiresAt=(ok + timedelta(days=3)).isoformat())).status_code, 400
        )

    # still the same limits and trail --------------------------------------------------------------------------

    def test_the_audit_row_carries_category_and_permanence_and_never_the_key(self):
        permanent = self.post(key_body("Permanent one", "production")).json()
        dated_day = (timezone.now() + timedelta(days=40)).astimezone(FACTORY_TZ).date()
        dated = self.post(key_body("Dated one", "staff", expiresAt=dated_day.isoformat())).json()
        logs = {log.new_values["label"]: log for log in self.audits("key_create")}
        a, b = logs["Permanent one"], logs["Dated one"]
        self.assertEqual(
            (a.new_values["category"], a.new_values["permanent"], a.new_values["expiresAt"]), ("production", True, None)
        )
        self.assertEqual(
            (b.new_values["category"], b.new_values["permanent"], b.new_values["expiresAt"]),
            ("staff", False, f"{dated_day.isoformat()}T23:59:59+05:30"),
        )
        self.assertIn("production data, permanent", a.record_description)
        self.assertIn("staff data, expires " + dated_day.isoformat(), b.record_description)
        self.assertTrue(a.record_description.startswith("Created API key 'Permanent one' ("))
        for log, made in ((a, permanent), (b, dated)):
            blob = f"{log.record_description} {log.old_values} {log.new_values}"
            self.assertNotIn(made["key"], blob)
            self.assertNotIn(made["key"][13:], blob)
            self.assertEqual(log.record_id, self.ep["id"])

    def test_the_ten_live_key_limit_counts_permanent_and_dated_keys_of_both_categories(self):
        for i in range(10):
            body = (
                key_body(f"K{i}", CATEGORIES[i % 2])
                if i % 3
                else key_body(f"K{i}", CATEGORIES[i % 2], expiresAt=self.future(days=9).isoformat())
            )
            self.assertEqual(self.post(body).status_code, 201)
        r = self.post(key_body("eleventh", "staff"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("10", r.json()["error"])

    def test_the_listing_shows_category_and_permanent_and_legacy_keys_as_null(self):
        legacy_plain, legacy = make_key(SharedEndpoint.objects.get(pk=self.ep["id"]), "Old key")
        _unused, legacy_dated = make_key(
            SharedEndpoint.objects.get(pk=self.ep["id"]), "Old dated key", expires_at=timezone.now() + timedelta(days=3)
        )
        self.post(key_body("New staff", "staff"))
        self.post(key_body("New production", "production", expiresAt=self.future(days=9).isoformat()))
        rows = {k["label"]: k for k in self.call("GET", self.keys_url).json()["keys"]}
        self.assertEqual((rows["New staff"]["category"], rows["New staff"]["permanent"]), ("staff", True))
        self.assertEqual(
            (rows["New production"]["category"], rows["New production"]["permanent"]), ("production", False)
        )
        self.assertEqual((rows["Old key"]["category"], rows["Old key"]["permanent"]), (None, True))
        self.assertEqual((rows["Old dated key"]["category"], rows["Old dated key"]["permanent"]), (None, False))
        self.assertNotIn(legacy_plain, str(rows))
        self.assertEqual((legacy.category, legacy_dated.category), ("", ""))
        self.assertEqual(SharedEndpointAccessLog.objects.count(), 0)

    def test_the_access_log_has_no_new_columns(self):
        self.assertEqual(
            {f.name for f in SharedEndpointAccessLog._meta.get_fields() if f.concrete},
            {"id", "endpoint", "endpoint_slug", "key", "at", "status", "rows", "origin", "ip", "duration_ms", "error"},
        )

    def test_a_key_that_cannot_be_made_is_never_usable(self):
        self.refused({"label": "k", "category": "staff"}, EXPIRY_MESSAGE)
        self.assertEqual(SharedEndpointKey.objects.count(), 0)
        self.assertEqual(
            self.client.get("/api/shared/hr-people", **key_headers("uks_abcdefgh_" + "A" * 43)).status_code, 401
        )

    def test_the_new_column_has_a_database_default_for_the_previous_release(self):
        """A rolling deploy: the old release inserts a key WITHOUT the column; it must get the legacy value, not an error."""
        ep = SharedEndpoint.objects.get(pk=self.ep["id"])
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO shared_endpoint_keys (endpoint_id, label, prefix, key_hash, created_by, created_at, last_used_ip) "
                "VALUES (%s, 'old release', 'abcd1234', %s, '', now(), '')",
                [ep.id, "f" * 64],
            )
        row = SharedEndpointKey.objects.get(key_hash="f" * 64)
        self.assertEqual(row.category, "")
        field = SharedEndpointKey._meta.get_field("category")
        self.assertEqual((field.default, field.db_default, field.max_length, field.blank), ("", "", 12, True))


# ═══ the lifetime of a key ═════════════════════════════════════════════════════════════════════════════════════


class KeyLifetimeTests(ManageBase):
    def setUp(self):
        super().setUp()
        self.ep = self.make(slug="life-ep", fields=["employeeCode"])
        self.keys_url = f"/api/shared-endpoints/{self.ep['id']}/keys"
        for code, kind in (("LIFE1", STAFF), ("LIFE2", PRODUCTION)):
            Employee.objects.create(
                employee_code=code, first_name=code, last_name="L", employment_type=kind, status="active"
            )

    def new(self, label, category=STAFF, **extra):
        r = self.call("POST", self.keys_url, key_body(label, category, **extra))
        self.assertEqual(r.status_code, 201, r.content[:300])
        return r.json()

    def call_at(self, key: str, instant: datetime) -> int:
        with mock.patch("django.utils.timezone.now", return_value=instant):
            cache.clear()
            return self.client.get("/api/shared/life-ep", **key_headers(key)).status_code

    def test_a_permanent_key_never_expires(self):
        made = self.new("Forever", PRODUCTION)
        self.assertEqual((made["permanent"], made["expiresAt"], made["status"]), (True, None, "active"))
        self.assertIsNone(SharedEndpointKey.objects.get(pk=made["id"]).expires_at)
        now = timezone.now()
        for delta in (
            timedelta(0),
            timedelta(days=1),
            timedelta(days=366),
            timedelta(days=3651),
            timedelta(days=365 * 50),
            timedelta(days=365 * 500),
        ):
            with self.subTest(after=delta):
                self.assertEqual(self.call_at(made["key"], now + delta), 200)
        with mock.patch("django.utils.timezone.now", return_value=now + timedelta(days=365 * 50)):
            row = next(k for k in self.call("GET", self.keys_url).json()["keys"] if k["id"] == made["id"])
        self.assertEqual(
            (row["status"], row["permanent"], row["expiresAt"], row["category"]), ("active", True, None, "production")
        )

    def test_a_permanent_key_still_stops_when_it_is_revoked(self):
        made = self.new("Forever")
        self.assertEqual(self.client.get("/api/shared/life-ep", **key_headers(made["key"])).status_code, 200)
        self.assertEqual(self.call("DELETE", f"{self.keys_url}/{made['id']}").json()["status"], "revoked")
        self.assertEqual(self.call_at(made["key"], timezone.now()), 401)
        self.assertEqual(self.call_at(made["key"], timezone.now() + timedelta(days=9)), 401)

    def test_a_dated_key_stops_exactly_at_its_datetime(self):
        expires = (timezone.now() + timedelta(minutes=5)).astimezone(FACTORY_TZ).replace(microsecond=0)
        for name, text in {
            "with offset": expires.isoformat(),
            "Zulu": expires.astimezone(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "naive factory time": expires.strftime("%Y-%m-%dT%H:%M:%S"),
        }.items():
            made = self.new(name, STAFF, expiresAt=text)
            with self.subTest(case=name):
                self.assertEqual(SharedEndpointKey.objects.get(pk=made["id"]).expires_at, expires)
                self.assertEqual(self.call_at(made["key"], expires - timedelta(hours=1)), 200)
                self.assertEqual(self.call_at(made["key"], expires - timedelta(seconds=5)), 200)
                self.assertEqual(self.call_at(made["key"], expires - timedelta(seconds=1)), 200)
                self.assertEqual(self.call_at(made["key"], expires), 401)  # at the instant: already over
                self.assertEqual(self.call_at(made["key"], expires + timedelta(seconds=1)), 401)
                self.assertEqual(self.call_at(made["key"], expires + timedelta(days=400)), 401)
                with mock.patch("django.utils.timezone.now", return_value=expires + timedelta(seconds=1)):
                    row = next(k for k in self.call("GET", self.keys_url).json()["keys"] if k["id"] == made["id"])
                self.assertEqual((row["status"], row["permanent"]), ("expired", False))

    def test_a_dates_key_works_through_the_last_second_of_that_day_in_factory_time(self):
        day = (timezone.now() + timedelta(days=30)).astimezone(FACTORY_TZ).date()
        made = self.new("Dated", PRODUCTION, expiresAt=day.isoformat())
        last = datetime.combine(day, time(23, 59, 59), tzinfo=FACTORY_TZ)
        self.assertEqual(self.call_at(made["key"], datetime.combine(day, time(0, 0, 0), tzinfo=FACTORY_TZ)), 200)
        self.assertEqual(self.call_at(made["key"], datetime.combine(day, time(12, 0, 0), tzinfo=FACTORY_TZ)), 200)
        self.assertEqual(self.call_at(made["key"], last - timedelta(seconds=1)), 200)
        self.assertEqual(self.call_at(made["key"], last), 401)
        self.assertEqual(
            self.call_at(made["key"], datetime.combine(day + timedelta(days=1), time(0, 0, 0), tzinfo=FACTORY_TZ)), 401
        )
        # the same instant seen from UTC: 18:29:59 on that day is still the factory's last second
        self.assertEqual(
            self.call_at(made["key"], datetime.combine(day, time(18, 29, 58), tzinfo=dt_timezone.utc)), 200
        )
        self.assertEqual(self.call_at(made["key"], datetime.combine(day, time(18, 30, 0), tzinfo=dt_timezone.utc)), 401)

    def test_permanent_and_dated_keys_side_by_side_while_the_clock_moves(self):
        permanent = self.new("Permanent", STAFF)
        dated = self.new("Dated", STAFF, expiresAt=(timezone.now() + timedelta(days=30)).date().isoformat())
        now = timezone.now()
        self.assertEqual((self.call_at(permanent["key"], now), self.call_at(dated["key"], now)), (200, 200))
        later = now + timedelta(days=45)
        self.assertEqual((self.call_at(permanent["key"], later), self.call_at(dated["key"], later)), (200, 401))
        with mock.patch("django.utils.timezone.now", return_value=later):
            rows = {k["label"]: k for k in self.call("GET", self.keys_url).json()["keys"]}
            live = self.call("GET", f"/api/shared-endpoints/{self.ep['id']}").json()["liveKeys"]
        self.assertEqual((rows["Permanent"]["status"], rows["Dated"]["status"]), ("active", "expired"))
        self.assertEqual(live, 1)  # the expired key does not count, the permanent one does

    def test_the_category_holds_for_a_permanent_key_however_late_it_is_used(self):
        made = self.new("Staff forever", STAFF)
        far = timezone.now() + timedelta(days=365 * 30)
        with mock.patch("django.utils.timezone.now", return_value=far):
            cache.clear()
            body = self.client.get("/api/shared/life-ep", {"status": "all"}, **key_headers(made["key"])).json()
        codes = {r["employeeCode"] for r in body["data"]}
        self.assertIn("LIFE1", codes)
        self.assertNotIn("LIFE2", codes)
        self.assertEqual(body["meta"]["category"], STAFF)

    def test_an_expired_dated_key_gets_the_same_answer_as_a_stranger(self):
        made = self.new("Dated", STAFF, expiresAt=(timezone.now() + timedelta(days=2)).date().isoformat())
        with mock.patch("django.utils.timezone.now", return_value=timezone.now() + timedelta(days=5)):
            cache.clear()
            r = self.client.get("/api/shared/life-ep", **key_headers(made["key"]))
        self.assertEqual((r.status_code, r.json()), (401, INVALID_KEY))
        self.assertEqual(
            SharedEndpointAccessLog.objects.filter(status=401).values_list("error", flat=True).first(), "key_expired"
        )


# ═══ the admin preview ═════════════════════════════════════════════════════════════════════════════════════════


class PreviewCategoryTests(SeedMixin, ManageBase):
    def preview(self, ep, **body):
        return self.call("POST", f"/api/shared-endpoints/{ep['id']}/preview", body)

    def test_a_preview_without_a_category_is_unscoped_as_before(self):
        ep = self.make(slug="pv-emp", fields=["employeeCode", "employmentType"], lockedFilters={"status": "all"})
        body = self.preview(ep).json()
        self.assertIsNone(body["meta"]["category"])
        self.assertEqual(body["meta"]["total"], len(want("employees", None)))
        self.assertEqual(self.preview(ep, category=None).json()["meta"]["total"], len(want("employees", None)))

    def test_a_preview_with_a_category_shows_what_a_key_of_that_category_sees(self):
        for dataset in sd.DATASETS:
            ds = sd.DATASETS[dataset]
            extra = {"lockedFilters": {"status": "all"}} if dataset == "employees" else {}
            ep = self.make(
                slug=f"pv-{dataset}",
                dataset=dataset,
                fields=[f.key for f in ds.fields],
                acknowledgeSensitive=True,
                **extra,
            )
            filters = PARAMS.get(dataset, {})
            filters = {k: v for k, v in filters.items() if k not in extra.get("lockedFilters", {})}
            for category in CATEGORIES:
                with self.subTest(dataset=dataset, category=category):
                    r = self.preview(ep, category=category, filters=filters, limit=5)
                    self.assertEqual(r.status_code, 200, r.content[:300])
                    body = r.json()
                    self.assertEqual(body["meta"]["category"], category)
                    self.assertTrue(body["meta"]["preview"])
                    self.assertEqual(body["meta"]["total"], len(want(dataset, category)))
                    ids = {IDENTITY[dataset](x) for x in body["data"]}
                    self.assertTrue(ids <= want(dataset, category))
                    self.assertEqual(len(body["data"]), min(5, len(want(dataset, category))))
                    self.type_check(dataset, body["data"], category)

    def type_check(self, dataset, rows, category):
        kinds = self.type_of()
        for row in rows:
            if dataset in EMPLOYEE_BOUND:
                self.assertEqual(kinds[row["employeeCode"]], category)

    def test_a_preview_of_the_other_category_cannot_be_widened_by_filters(self):
        ep = self.make(slug="pv-emp", fields=["employeeCode"])
        r = self.preview(ep, category=STAFF, filters={"status": "all", "employmentType": PRODUCTION}).json()
        self.assertEqual((r["data"], r["meta"]["total"]), ([], 0))
        r = self.preview(ep, category=PRODUCTION, filters={"status": "all", "employeeCode": "CATS1"}).json()
        self.assertEqual((r["data"], r["meta"]["total"]), ([], 0))

    def test_the_preview_category_is_staff_or_production_and_nothing_else(self):
        ep = self.make(slug="pv-emp", fields=["employeeCode"])
        for bad in (
            "",
            " ",
            "all",
            "both",
            "Staff",
            "PRODUCTION",
            "staff ",
            "employee",
            1,
            0,
            True,
            False,
            ["staff"],
            {"a": 1},
        ):
            with self.subTest(category=bad):
                r = self.preview(ep, category=bad)
                self.assertEqual(r.status_code, 400, r.content[:200])
                self.assertEqual(r.json()["error"], "The preview category must be staff or production.")

    def test_a_preview_still_needs_no_key_and_writes_no_log(self):
        ep = self.make(slug="pv-emp", fields=["employeeCode"])
        self.assertEqual(self.preview(ep, category=STAFF).status_code, 200)
        self.assertEqual((SharedEndpointAccessLog.objects.count(), SharedEndpointKey.objects.count()), (0, 0))

    def test_the_preview_calls_the_same_function_as_the_public_call(self):
        ep = self.make(slug="pv-emp", fields=["employeeCode"])
        with mock.patch.object(sd, "apply_category", wraps=sd.apply_category) as spy:
            self.preview(ep, category=PRODUCTION)
            self.preview(ep)
        self.assertEqual([c.args[2] for c in spy.call_args_list], [PRODUCTION, None])


# ═══ the guide and the catalog the owner reads ════════════════════════════════════════════════════════════════


class GuideCategoryTests(ManageBase):
    def test_the_guide_explains_the_category_and_the_expiry_rules(self):
        ep = self.make()
        guide = self.call("GET", f"/api/shared-endpoints/{ep['id']}/guide").json()
        notes = " ".join(guide["access"]["notes"])
        for phrase in (
            "ONE category of data",
            "Staff or Production",
            "meta.category",
            "older key",
            "permanent",
            "holiday",
        ):
            self.assertIn(phrase, notes)
        self.assertEqual(guide["response"]["sample"]["meta"]["category"], "staff")
        # additive only: every key the guide had before is still there
        for key in (
            "baseUrl",
            "url",
            "method",
            "headers",
            "parameters",
            "lockedFilters",
            "pagination",
            "response",
            "errors",
            "examples",
            "access",
        ):
            self.assertIn(key, guide)

    def test_the_catalog_names_the_scope_of_every_dataset(self):
        body = self.call("GET", "/api/shared-endpoints/catalog").json()
        self.assertEqual(
            {d["key"]: d["categoryScope"] for d in body["datasets"]},
            {k: ("neutral" if k == "holidays" else "employee") for k in sd.DATASETS},
        )
