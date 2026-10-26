"""PF / ESI / TDS: the rule lists, the settings API, the Co Emp <-> TDS categories, the payroll arithmetic that ties them
together, the CoPortal scope, the coverage counts and the data migration of the retired methods.

Calendar and helpers are the payroll engine suite's (February 2026: 24 Mon-Sat working days, so a salary of 24,000 has a
daily rate of exactly 1,000). A 24,000 salary has the automatic split: first portion (Basic + DA + Retaining Allowance)
12,000, of which Basic is 4,000.

Run via: python manage.py test api.tests_pf_esi
"""

import importlib
from datetime import date
from decimal import Decimal

from django.apps import apps as django_apps
from django.test import SimpleTestCase, TestCase

from . import pf_esi, salary_split
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    AuditLog,
    Branch,
    BranchSettingsOverride,
    Employee,
    HRUser,
    PayrollSettings,
    Role,
    SalarySlip,
)
from .payroll_views import _generate_production_payroll, _generate_staff_payroll
from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _day, _present_all, _rule

SETTINGS = "/api/pf-esi-settings"
TDS = "/api/tds/employees"
COVERAGE = "/api/pf-esi/coverage"
EMPLOYEES = "/api/employees"


def _auth(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _hr_user(username, *, super_admin=False, permissions=None, branch=None) -> HRUser:
    role = Role.objects.create(name=f"role_{username}", permissions=permissions or {}) if permissions else None
    return HRUser.objects.create(
        username=username, password_hash="x", is_super_admin=super_admin, role=role, branch=branch
    )


def _staff(code, salary="24000.00", branch=None, **extra) -> Employee:
    fields = dict(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        salary_type="monthly",
        salary_amount=Decimal(salary),
        branch=branch,
    )
    return Employee.objects.create(**{**fields, **extra})


def _worker(code, per_shift="500.00", branch=None, **extra) -> Employee:
    fields = dict(
        employee_code=code,
        first_name=code,
        last_name="Worker",
        employment_type="production",
        status="active",
        salary_per_shift=Decimal(per_shift),
        branch=branch,
    )
    return Employee.objects.create(**{**fields, **extra})


def _slip(emp) -> SalarySlip:
    return SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)


def _generate(emp) -> SalarySlip:
    """Generate (or regenerate) the February 2026 payroll of a staff employee and return the slip."""
    _generate_staff_payroll(emp, MONTH, YEAR)
    return _slip(emp)


PF = _rule("pf1", 0, 25000, 12)  # PF below 25,000 Basic
ESI = _rule("esi1", 0, 30000, "0.75")  # ESI below 30,000 Basic: its own, independent limit


class Base(TestCase):
    def setUp(self):
        _configure(
            staff_pf_rules=[PF],
            staff_esi_rules=[ESI],
            prod_pf_rules=[],
            prod_esi_rules=[],
            attendance_mode="simple",
            compensation_feature_enabled=True,
            late_deduction_slabs=[],
            prod_late_detection_enabled=False,
        )
        self.admin = _hr_user("pf_admin", super_admin=True)
        self.north = Branch.objects.create(name="North", code="N")
        self.south = Branch.objects.create(name="South", code="S")

    def get(self, url, user=None, **params):
        return self.client.get(url, params, **_auth(user or self.admin))

    def send(self, method, url, body=None, user=None):
        return getattr(self.client, method)(
            url, body or {}, content_type="application/json", **_auth(user or self.admin)
        )

    def put_rules(self, body, user=None):
        return self.send("put", SETTINGS, body, user)

    def version(self, **params):
        return self.get(SETTINGS, **params).json()["version"]


# ─────────────────────────────────────────────────────────────────────────────
#  Rule validation
# ─────────────────────────────────────────────────────────────────────────────


class RuleValidationTests(SimpleTestCase):
    def clean(self, rows, emp_class="staff", kind="pf"):
        return pf_esi.clean_rule_list(rows, emp_class, kind)

    def refused(self, rows, *parts, field=None, index=None, emp_class="staff", kind="pf"):
        with self.assertRaises(pf_esi.RulesInvalid) as caught:
            self.clean(rows, emp_class, kind)
        for part in parts:
            self.assertIn(part, caught.exception.message)
        if field is not None:
            self.assertEqual(caught.exception.field, field)
        if index is not None:
            self.assertEqual(caught.exception.index, index)
        return caught.exception

    def test_a_good_list_is_normalised_and_ids_labels_and_basis_are_filled_in(self):
        rows = self.clean(
            [
                {"minAmount": "0", "maxAmount": "24999.99", "ratePercent": "12"},
                {
                    "id": "keep",
                    "label": " Mid ",
                    "basis": "total",
                    "minAmount": 25000,
                    "maxAmount": 0,
                    "ratePercent": 0.75,
                },
            ]
        )
        self.assertEqual(rows[0]["label"], "Rule 1")
        self.assertEqual(rows[0]["basis"], "basic")
        self.assertTrue(rows[0]["id"] and rows[0]["id"] != rows[1]["id"])
        self.assertEqual((rows[0]["minAmount"], rows[0]["maxAmount"], rows[0]["ratePercent"]), (0, 24999.99, 12))
        self.assertEqual(
            rows[1],
            {"id": "keep", "label": "Mid", "basis": "total", "minAmount": 25000, "maxAmount": 0, "ratePercent": 0.75},
        )

    def test_an_empty_list_is_valid_and_means_no_deduction(self):
        self.assertEqual(self.clean([]), [])

    def test_bounds(self):
        good = {"minAmount": 0, "maxAmount": 100, "ratePercent": 5}
        self.refused([{**good, "minAmount": -1}], "Minimum amount", field="minAmount", index=0)
        self.refused([{**good, "minAmount": 100000000}], "Minimum amount must be between", field="minAmount")
        self.refused([{**good, "maxAmount": -5}], "Maximum amount", field="maxAmount")
        self.refused([{**good, "maxAmount": 100000000}], "Maximum amount", field="maxAmount")
        self.refused([{**good, "minAmount": 500, "maxAmount": 100}], "at least the minimum", field="maxAmount")
        self.refused([{**good, "ratePercent": 100.01}], "Percentage must be between 0 and 100", field="ratePercent")
        self.refused([{**good, "ratePercent": -1}], "Percentage must be between 0 and 100", field="ratePercent")
        self.refused([{**good, "ratePercent": None}], "Percentage is required", field="ratePercent")
        self.refused([{**good, "ratePercent": ""}], "Percentage is required", field="ratePercent")
        self.assertEqual(self.clean([{**good, "ratePercent": 100}])[0]["ratePercent"], 100)
        self.assertEqual(self.clean([{**good, "ratePercent": 0}])[0]["ratePercent"], 0)
        self.assertEqual(
            self.clean([{**good, "minAmount": 99999999.99, "maxAmount": 99999999.99}])[0]["maxAmount"], 99999999.99
        )

    def test_numbers_must_be_numbers_with_at_most_two_decimals(self):
        good = {"minAmount": 0, "maxAmount": 100, "ratePercent": 5}
        for bad in ("abc", True, [1], {"a": 1}, "NaN", "Infinity", "-Infinity"):
            self.refused([{**good, "ratePercent": bad}], "Percentage must be a number", field="ratePercent")
            self.refused([{**good, "minAmount": bad}], "Minimum amount must be a number", field="minAmount")
        self.refused([{**good, "ratePercent": 12.345}], "at most two decimal places", field="ratePercent")
        for huge in ("1e999999999", 1e300, "9" * 60):
            self.refused([{**good, "maxAmount": huge}], "Maximum amount", field="maxAmount")
            self.refused([{**good, "ratePercent": huge}], "Percentage", field="ratePercent")
        self.refused([{**good, "minAmount": "1.005"}], "at most two decimal places", field="minAmount")

    def test_basis_label_id_and_shape(self):
        good = {"minAmount": 0, "maxAmount": 100, "ratePercent": 5}
        self.refused([{**good, "basis": "gross"}], "basis must be", field="basis")
        self.refused([{**good, "label": 5}], "label must be text", field="label")
        self.refused([{**good, "label": "x" * 81}], "at most 80", field="label")
        self.refused([{**good, "id": "x" * 41}], "at most 40", field="id")
        self.refused([{**good, "id": True}], "id must be text", field="id")
        self.refused(
            [{**good, "id": "same"}, {**good, "id": "same", "minAmount": 200, "maxAmount": 300}], "same id", index=1
        )
        self.refused(["Low band"], "each rule needs", field="list", index=0)
        self.refused("not a list", "must be a list", field="list")
        self.refused([good] * 51, "at most 50", field="list")

    def test_ranges_of_one_list_may_not_overlap_and_the_message_names_both_rules(self):
        error = self.refused(
            [
                {"label": "A", "minAmount": 0, "maxAmount": 25000, "ratePercent": 12},
                {"label": "Gap", "minAmount": 30001, "maxAmount": 40000, "ratePercent": 1},
                {"label": "B", "minAmount": 20000, "maxAmount": 30000, "ratePercent": 5},
            ],
            'Staff PF rules 1 ("A") and 3 ("B") overlap',
            "0–25,000 and 20,000–30,000",
            index=2,
        )
        self.assertEqual((error.other_index, error.list_key), (0, "staff.pfRules"))
        self.assertEqual(error.payload()["otherRuleIndex"], 0)

    def test_touching_ranges_overlap_because_both_ends_are_inclusive(self):
        self.refused(
            [
                {"minAmount": 0, "maxAmount": 25000, "ratePercent": 1},
                {"minAmount": 25000, "maxAmount": 0, "ratePercent": 2},
            ],
            "overlap",
        )
        rows = self.clean(
            [
                {"minAmount": 0, "maxAmount": "24999.99", "ratePercent": 1},
                {"minAmount": 25000, "maxAmount": 0, "ratePercent": 2},
            ]
        )
        self.assertEqual(len(rows), 2)

    def test_an_open_ended_rule_overlaps_anything_above_its_minimum(self):
        self.refused(
            [
                {"minAmount": 10000, "maxAmount": 0, "ratePercent": 1},
                {"minAmount": 50000, "maxAmount": 60000, "ratePercent": 2},
            ],
            "overlap",
            "10,000 and above",
        )

    def test_two_open_ended_rules_overlap(self):
        self.refused(
            [{"minAmount": 0, "maxAmount": 0, "ratePercent": 1}, {"minAmount": 5, "maxAmount": 0, "ratePercent": 2}],
            "overlap",
        )

    def test_the_same_range_on_different_bases_is_not_an_overlap(self):
        rows = self.clean(
            [
                {"basis": "basic", "minAmount": 0, "maxAmount": 25000, "ratePercent": 1},
                {"basis": "total", "minAmount": 0, "maxAmount": 25000, "ratePercent": 2},
            ]
        )
        self.assertEqual([r["basis"] for r in rows], ["basic", "total"])

    def test_the_message_names_the_list(self):
        self.refused(
            [{"minAmount": 0, "maxAmount": 1, "ratePercent": 101}],
            "Production ESI rule 1",
            emp_class="production",
            kind="esi",
        )


class ParsingAndMatchingTests(SimpleTestCase):
    def test_a_malformed_stored_row_is_skipped_never_fatal(self):
        rules = pf_esi.parse_rules(
            [
                "x",
                {"basis": "weird"},
                {"minAmount": "abc"},
                {"id": "ok", "basis": "total", "minAmount": 0, "maxAmount": 5, "ratePercent": 1},
            ]
        )
        self.assertEqual([r.id for r in rules], ["ok"])
        self.assertEqual(pf_esi.parse_rules(None), [])
        self.assertEqual(pf_esi.parse_rules("nope"), [])

    def test_matching_is_inclusive_and_first_match_wins(self):
        rules = pf_esi.parse_rules(
            [
                {"id": "a", "basis": "basic", "minAmount": 0, "maxAmount": 100, "ratePercent": 1},
                {"id": "b", "basis": "basic", "minAmount": 100, "maxAmount": 0, "ratePercent": 2},
            ]
        )
        amounts = {"basic": Decimal("100"), "first_portion": Decimal("1"), "total": Decimal("1")}
        rule, tested = pf_esi.match_rule(rules, amounts)
        self.assertEqual((rule.id, tested), ("a", Decimal("100")))
        self.assertEqual(pf_esi.match_rule(rules, {"basic": Decimal("100.01")})[0].id, "b")
        self.assertEqual(pf_esi.match_rule(rules, None), (None, None))
        self.assertEqual(pf_esi.match_rule([], amounts), (None, None))

    def test_the_version_is_a_stable_hash_of_the_content(self):
        lists = {key: [] for key in pf_esi.RULE_FIELDS}
        same = {key: [] for key in pf_esi.RULE_FIELDS}
        changed = {**lists, ("staff", "pf"): [{"id": "a"}]}
        self.assertEqual(pf_esi.version_of(lists), pf_esi.version_of(same))
        self.assertNotEqual(pf_esi.version_of(lists), pf_esi.version_of(changed))
        self.assertEqual(len(pf_esi.version_of(lists)), 16)


# ─────────────────────────────────────────────────────────────────────────────
#  Worked examples: the engine
# ─────────────────────────────────────────────────────────────────────────────


class StaffWorkedExampleTests(Base):
    def test_basic_below_the_pf_limit_gets_pf_on_the_prorated_first_portion(self):
        emp = _staff("W1", co_emp_enabled=True)
        _present_all(emp, WORKING_DAYS[:12])  # half the month
        slip = _generate(emp)
        # first portion 12,000 x 12/24 = 6,000 ; Basic 4,000 < 25,000
        self.assertEqual((slip.basic, slip.pf_deduction), (Decimal("6000.00"), Decimal("720.00")))
        self.assertEqual(slip.esi_deduction, Decimal("45.00"))  # 0.75% of the same 6,000
        self.assertEqual(slip.net_salary, Decimal("12000.00") - Decimal("765.00"))

    def test_basic_above_the_pf_limit_gets_no_pf(self):
        emp = _staff("W2", salary="186000.00", co_emp_enabled=True)  # automatic split: Basic 31,000
        _present_all(emp)
        slip = _generate(emp)
        self.assertEqual(slip.pf_deduction, Decimal("0.00"))  # 31,000 > 25,000
        self.assertEqual(slip.esi_deduction, Decimal("0.00"))  # 31,000 > 30,000 too
        self.assertEqual(slip.net_salary, Decimal("186000.00"))

    def test_esi_has_its_own_limit(self):
        emp = _staff(
            "W3", salary="162000.00", co_emp_enabled=True
        )  # Basic 27,000: over the PF limit, under the ESI one
        _present_all(emp)
        slip = _generate(emp)
        self.assertEqual(slip.pf_deduction, Decimal("0.00"))
        self.assertEqual(slip.esi_deduction, Decimal("607.50"))  # 0.75% of the 81,000 first portion

    def test_a_non_co_emp_employee_gets_neither(self):
        emp = _staff("W4")
        _present_all(emp)
        slip = _generate(emp)
        self.assertEqual((slip.pf_deduction, slip.esi_deduction, slip.tds_deduction), (0, 0, 0))
        self.assertEqual(slip.net_salary, Decimal("24000.00"))

    def test_a_tds_employee_gets_tds_only(self):
        emp = _staff("W5", tds_enabled=True, tds_percent=Decimal("10"))
        _present_all(emp)
        slip = _generate(emp)
        self.assertEqual((slip.pf_deduction, slip.esi_deduction), (0, 0))
        self.assertEqual((slip.tds_deduction, slip.net_salary), (Decimal("2400.00"), Decimal("21600.00")))

    def test_the_payroll_json_carries_the_tds_figures(self):
        emp = _staff("W6", tds_enabled=True, tds_percent=Decimal("10"))
        _present_all(emp)
        _generate(emp)
        rows = self.get("/api/payroll", month=MONTH, year=YEAR).json()
        row = next(r for r in rows if r["employeeId"] == emp.id)
        self.assertEqual(
            (row["tdsDeduction"], row["tdsPercent"], row["deductions"], row["finalSalary"]),
            (2400.0, 10.0, 2400.0, 21600.0),
        )
        other = _staff("W7")
        _present_all(other)
        _generate(other)
        row = next(r for r in self.get("/api/payroll", month=MONTH, year=YEAR).json() if r["employeeId"] == other.id)
        self.assertEqual((row["tdsDeduction"], row["tdsPercent"]), (0.0, None))


class RoundTripTests(Base):
    """Co Emp -> TDS -> Co Emp, with the payroll generated at every stage."""

    def test_the_whole_cycle(self):
        emp = _staff("R1", branch=self.north, co_emp_enabled=True)
        _present_all(emp)
        first = _generate(emp)
        self.assertEqual((first.pf_deduction, first.esi_deduction, first.tds_deduction), (1440, Decimal("90.00"), 0))

        # 1. Co Emp -> TDS in one step
        r = self.send("post", TDS, {"employeeCode": "R1", "percent": 10})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["movedFromPfEsi"])
        emp.refresh_from_db()
        self.assertEqual((emp.co_emp_enabled, emp.tds_enabled, emp.tds_percent), (False, True, Decimal("10.00")))
        self.assertEqual(_slip(emp).pf_deduction, Decimal("1440.00"))  # the stored slip is never recomputed by a change
        again = _generate(emp)
        self.assertEqual((again.pf_deduction, again.esi_deduction, again.tds_deduction), (0, 0, Decimal("2400.00")))

        # 2. TDS -> Co Emp through the existing toggle
        r = self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": True})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["coEmpEnabled"], body["tdsEnabled"], body["tdsPercent"]), (True, False, None))
        emp.refresh_from_db()
        self.assertIsNone(emp.tds_percent)
        back = _generate(emp)
        self.assertEqual((back.pf_deduction, back.esi_deduction, back.tds_deduction), (1440, Decimal("90.00"), 0))
        self.assertIsNone(back.tds_percent)

        # 3. and out of both: removed from Co Emp only -> nothing at all
        self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": False})
        emp.refresh_from_db()
        nothing = _generate(emp)
        self.assertEqual((nothing.pf_deduction, nothing.esi_deduction, nothing.tds_deduction), (0, 0, 0))

    def test_removing_from_tds_leaves_the_employee_in_no_category(self):
        emp = _staff("R2", tds_enabled=True, tds_percent=Decimal("5"))
        r = self.send("delete", f"{TDS}/{emp.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["removed"])
        emp.refresh_from_db()
        self.assertEqual((emp.co_emp_enabled, emp.tds_enabled, emp.tds_percent), (False, False, None))
        _present_all(emp)
        self.assertEqual(_generate(emp).total_deductions, Decimal("0.00"))

    def test_an_employee_is_never_in_both_categories(self):
        emp = _staff("R3", branch=self.north, co_emp_enabled=True)
        self.send("post", TDS, {"employeeCode": "R3", "percent": 3})
        self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": True})
        self.send("post", TDS, {"employeeCode": "R3", "percent": 4})
        emp.refresh_from_db()
        self.assertEqual((emp.co_emp_enabled, emp.tds_enabled), (False, True))
        self.assertFalse(Employee.objects.filter(co_emp_enabled=True, tds_enabled=True).exists())


class ProductionWorkedExampleTests(Base):
    """Weekly / BiWeekly / Monthly cycles: the period's gross is scaled to a month (x4 / x2 / x1) before it is tested."""

    MON = date(2026, 2, 2)

    def setUp(self):
        super().setUp()
        _configure(
            prod_pf_rules=[_rule("p", 0, 20000, 12, "total")],
            prod_esi_rules=[_rule("e", 0, 12000, 1, "total")],
        )

    def run_cycle(self, cycle, days, code, **extra):
        emp = _worker(code, **extra)
        for offset in range(days):
            _day(emp, date(2026, 2, 2 + offset), shifts="1.00")
        start, end = self.MON, date(2026, 2, 1 + days)
        _generate_production_payroll(emp, start, end, pay_cycle=cycle)
        return SalarySlip.objects.get(employee=emp, period_start=start, period_end=end)

    def test_each_cycle_scales_the_period_pay_to_a_month(self):
        # 7 shifts x 500 = 3,500 for a week; the same pay is judged as 14,000 (weekly), 7,000 (biweekly), 3,500 (monthly)
        weekly = self.run_cycle("weekly", 7, "PW", co_emp_enabled=True)
        biweekly = self.run_cycle("biweekly", 7, "PB", co_emp_enabled=True)
        monthly = self.run_cycle("monthly", 7, "PM", co_emp_enabled=True)
        for slip, factor in ((weekly, 4), (biweekly, 2), (monthly, 1)):
            deductions = slip.breakdown_details["deductions"]
            self.assertEqual(
                (deductions["monthlyEquivalent"], deductions["monthlyEquivalentFactor"]), (3500.0 * factor, factor)
            )
            # first portion of 3,500 = 1,750: PF 12% = 210.00 whatever the cycle (all three are inside the PF range)
            self.assertEqual(slip.pf_deduction, Decimal("210.00"))
        # ESI covers monthly earnings up to 12,000: weekly (14,000) is out, the other two are in
        self.assertEqual(weekly.esi_deduction, Decimal("0.00"))
        self.assertEqual(biweekly.esi_deduction, Decimal("17.50"))  # 1% of 1,750
        self.assertEqual(monthly.esi_deduction, Decimal("17.50"))

    def test_the_first_portion_basis_is_half_of_the_monthly_equivalent(self):
        # 7 shifts x 1,000 = 7,000 for a week -> monthly equivalent 28,000, first portion 14,000
        _configure(prod_pf_rules=[_rule("fp", 0, 14000, 12, "first_portion")], prod_esi_rules=[])
        inside = self.run_cycle("weekly", 7, "FP1", per_shift="1000.00", co_emp_enabled=True)
        self.assertEqual(inside.pf_deduction, Decimal("420.00"))  # 12% of the period's first portion (3,500)
        _configure(prod_pf_rules=[_rule("fp", 0, "13999.99", 12, "first_portion")])
        outside = self.run_cycle("weekly", 7, "FP2", per_shift="1000.00", co_emp_enabled=True)
        self.assertEqual(outside.pf_deduction, Decimal("0.00"))

    def test_a_branch_override_applies_to_the_workers_of_that_branch(self):
        self.put_rules(
            {
                "branchId": self.north.id,
                "expectedVersion": self.version(branchId=self.north.id),
                "production": {"pfRules": [_rule("n", 0, 0, 6, "total")]},
            }
        )
        north = self.run_cycle("biweekly", 7, "BN", branch=self.north, co_emp_enabled=True)
        south = self.run_cycle("biweekly", 7, "BS", branch=self.south, co_emp_enabled=True)
        self.assertEqual(
            (north.pf_deduction, south.pf_deduction), (Decimal("105.00"), Decimal("210.00"))
        )  # 6% / 12% of 1,750

    def test_a_non_co_emp_worker_gets_nothing_in_any_cycle(self):
        for cycle in ("weekly", "biweekly", "monthly"):
            slip = self.run_cycle(cycle, 7, f"N_{cycle}")
            self.assertEqual((slip.pf_deduction, slip.esi_deduction, slip.tds_deduction), (0, 0, 0), cycle)

    def test_a_tds_worker_gets_tds_in_every_cycle(self):
        for cycle in ("weekly", "biweekly", "monthly"):
            slip = self.run_cycle(cycle, 7, f"T_{cycle}", tds_enabled=True, tds_percent=Decimal("10"))
            self.assertEqual(
                (slip.pf_deduction, slip.esi_deduction, slip.tds_deduction, slip.net_salary),
                (0, 0, Decimal("350.00"), Decimal("3150.00")),
                cycle,
            )


# ─────────────────────────────────────────────────────────────────────────────
#  Settings API
# ─────────────────────────────────────────────────────────────────────────────


class SettingsReadTests(Base):
    def test_the_global_rules_are_returned_with_everything_the_page_needs(self):
        body = self.get(SETTINGS).json()
        self.assertEqual(body["scope"], {"branchId": None, "branchName": None, "isOverride": False})
        self.assertTrue(body["canEdit"])
        self.assertEqual(body["staff"]["pfRules"], [PF])
        self.assertEqual(body["staff"]["esiRules"], [{**ESI, "ratePercent": 0.75}])
        self.assertEqual((body["production"]["pfRules"], body["production"]["esiRules"]), ([], []))
        self.assertEqual({o["value"] for o in body["basisOptions"]}, {"basic", "first_portion", "total"})
        self.assertEqual(body["limits"]["maxRulesPerList"], 50)
        listed = {b["name"]: b["hasOverride"] for b in body["branches"]}
        self.assertEqual({k: listed[k] for k in ("North", "South")}, {"North": False, "South": False})
        self.assertTrue(all(isinstance(b["id"], int) for b in body["branches"]))
        self.assertEqual(len(body["version"]), 16)

    def test_any_hr_login_can_read_but_cannot_edit_and_gets_no_branch_list(self):
        reader = _hr_user("reader", permissions={"employees": "view"})
        body = self.get(SETTINGS, reader).json()
        self.assertFalse(body["canEdit"])
        self.assertEqual(body["branches"], [])
        self.assertEqual(body["staff"]["pfRules"], [PF])

    def test_a_branch_login_sees_its_own_branch_rules_and_cannot_ask_for_another(self):
        self.put_rules(
            {
                "branchId": self.north.id,
                "expectedVersion": self.version(branchId=self.north.id),
                "staff": {"pfRules": [_rule("n", 0, 0, 5)]},
            }
        )
        north_user = _hr_user("north_hr", permissions={"employees": "view"}, branch=self.north)
        south_user = _hr_user("south_hr", permissions={"employees": "view"}, branch=self.south)
        north = self.get(SETTINGS, north_user).json()
        self.assertEqual(north["scope"], {"branchId": self.north.id, "branchName": "North", "isOverride": True})
        self.assertEqual(north["staff"]["pfRules"][0]["ratePercent"], 5)
        south = self.get(SETTINGS, south_user).json()
        self.assertEqual(south["scope"], {"branchId": self.south.id, "branchName": "South", "isOverride": False})
        self.assertEqual(south["staff"]["pfRules"], [PF])  # no override: follows the global rules
        self.assertEqual(self.get(SETTINGS, south_user, branchId=self.north.id).status_code, 403)
        self.assertEqual(self.get(SETTINGS, south_user, branchId=self.south.id).status_code, 200)

    def test_a_super_admin_can_look_at_any_branch_and_a_bad_branch_is_refused(self):
        body = self.get(SETTINGS, branchId=self.south.id).json()
        self.assertEqual(body["scope"], {"branchId": self.south.id, "branchName": "South", "isOverride": False})
        self.assertEqual(self.get(SETTINGS, branchId=99999).status_code, 404)
        self.assertEqual(self.get(SETTINGS, branchId="abc").status_code, 400)

    def test_it_needs_an_hr_login(self):
        self.assertEqual(self.client.get(SETTINGS).status_code, 401)
        token = sign_token({"role": "employee", "employeeId": 1})
        self.assertEqual(self.client.get(SETTINGS, HTTP_AUTHORIZATION=f"Bearer {token}").status_code, 403)
        self.assertEqual(self.client.get(COVERAGE).status_code, 401)
        self.assertEqual(self.client.get(TDS).status_code, 401)


class SettingsWriteTests(Base):
    def put(self, **body):
        body.setdefault(
            "expectedVersion", self.version(**({"branchId": body["branchId"]} if body.get("branchId") else {}))
        )
        return self.put_rules(body)

    def test_only_the_super_admin_can_write(self):
        editor = _hr_user("editor", permissions={"settings": "edit", "settings.payroll": "edit", "employees": "edit"})
        before = PayrollSettings.get().staff_pf_rules
        for method, url, body in (
            ("put", SETTINGS, {"expectedVersion": self.version(), "staff": {"pfRules": []}}),
            ("delete", f"{SETTINGS}?branchId={self.north.id}", None),
        ):
            r = self.send(method, url, body, editor)
            self.assertEqual(r.status_code, 403, (method, r.content))
            self.assertEqual(r.json()["error"], "permission_denied")
        self.assertEqual(PayrollSettings.get().staff_pf_rules, before)
        branch_editor = _hr_user("branch_editor", permissions={"settings.payroll": "edit"}, branch=self.north)
        r = self.send("put", SETTINGS, {"expectedVersion": self.version(), "staff": {"pfRules": []}}, branch_editor)
        self.assertEqual(r.status_code, 403)
        self.assertFalse(BranchSettingsOverride.objects.exists())

    def test_a_non_hr_token_cannot_write(self):
        employee_token = sign_token({"role": "employee", "employeeId": 1})
        r = self.client.put(
            SETTINGS, {"expectedVersion": "x", "staff": {"pfRules": []}}, content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {employee_token}",
        )  # fmt: skip
        self.assertEqual(r.status_code, 403)

    def test_a_global_save_replaces_only_the_lists_that_are_sent(self):
        r = self.put(
            staff={"pfRules": [_rule("new", 0, 20000, 10, label="New PF")]},
            production={"esiRules": [_rule("pe", 0, 0, 1, "total")]},
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["staff"]["pfRules"][0]["label"], "New PF")
        self.assertEqual(body["staff"]["esiRules"][0]["id"], "esi1")  # not sent: kept
        self.assertEqual(body["production"]["esiRules"][0]["basis"], "total")
        ps = PayrollSettings.get()
        self.assertEqual([r["id"] for r in ps.staff_pf_rules], ["new"])
        self.assertEqual([r["id"] for r in ps.prod_esi_rules], ["pe"])
        self.assertEqual(ps.prod_pf_rules, [])
        self.assertFalse(BranchSettingsOverride.objects.exists())

    def test_deleting_a_rule_is_sending_the_list_without_it(self):
        r = self.put(staff={"pfRules": [], "esiRules": []})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["staff"]["pfRules"], r.json()["staff"]["esiRules"]), ([], []))
        emp = _staff("D1", co_emp_enabled=True)
        _present_all(emp)
        self.assertEqual(_generate(emp).total_deductions, Decimal("0.00"))

    def test_the_new_version_changes_when_the_content_does(self):
        before = self.version()
        r = self.put(staff={"pfRules": [_rule("x", 0, 1, 1)]})
        self.assertNotEqual(r.json()["version"], before)
        self.assertEqual(r.json()["version"], self.version())

    def test_a_stale_save_is_refused_and_changes_nothing(self):
        stale = self.version()
        self.assertEqual(self.put(staff={"pfRules": [_rule("first", 0, 0, 1)]}).status_code, 200)
        r = self.put_rules({"expectedVersion": stale, "staff": {"pfRules": [_rule("late", 0, 0, 2)]}})
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual(body["error"], "stale_version")
        self.assertEqual(body["currentVersion"], self.version())
        self.assertIn("changed by someone else", body["message"])
        self.assertEqual([r["id"] for r in PayrollSettings.get().staff_pf_rules], ["first"])

    def test_expected_version_is_required(self):
        r = self.put_rules({"staff": {"pfRules": []}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("expectedVersion", r.json()["error"])
        r = self.put_rules({"expectedVersion": "", "staff": {"pfRules": []}})
        self.assertEqual(r.status_code, 400)

    def test_a_save_with_nothing_to_save_is_refused(self):
        r = self.put_rules({"expectedVersion": self.version()})
        self.assertEqual(r.status_code, 400)
        r = self.put_rules({"expectedVersion": self.version(), "staff": "x"})
        self.assertEqual(r.status_code, 400)

    def test_a_bad_rule_is_a_400_that_names_the_list_the_rule_and_the_field_and_saves_nothing(self):
        before = PayrollSettings.get().staff_pf_rules
        r = self.put(
            production={
                "pfRules": [
                    _rule("ok", 0, 10, 1),
                    {"label": "Broken", "minAmount": 0, "maxAmount": 5, "ratePercent": 150},
                ]
            },
            staff={"pfRules": []},
        )
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertEqual((body["list"], body["ruleIndex"], body["field"]), ("production.pfRules", 1, "ratePercent"))
        self.assertIn('Production PF rule 2 ("Broken")', body["error"])
        self.assertEqual(
            PayrollSettings.get().staff_pf_rules, before
        )  # the valid staff list in the same request did not save

    def test_overlapping_ranges_are_refused(self):
        r = self.put(staff={"pfRules": [_rule("a", 0, 25000, 12), _rule("b", 20000, 0, 5)]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("overlap", r.json()["error"])
        self.assertEqual(r.json()["otherRuleIndex"], 0)

    def test_the_save_is_audit_logged_with_the_old_and_new_lists(self):
        self.put(staff={"pfRules": [_rule("audited", 0, 0, 3)]})
        entry = AuditLog.objects.filter(module="settings", action="update").latest("id")
        self.assertIn("PF / ESI rules updated for all units (global)", entry.record_description)
        self.assertIn("staff.pfRules (1 rule)", entry.record_description)
        self.assertEqual(entry.old_values["staff.pfRules"][0]["id"], "pf1")
        self.assertEqual(entry.new_values["staff.pfRules"][0]["id"], "audited")

    def test_a_refused_save_writes_no_audit_entry(self):
        before = AuditLog.objects.count()
        self.put_rules({"expectedVersion": "stale", "staff": {"pfRules": []}})
        self.put(staff={"pfRules": [{"minAmount": 5, "maxAmount": 1, "ratePercent": 1}]})
        self.assertEqual(AuditLog.objects.count(), before)


class BranchOverrideTests(Base):
    def save_branch(self, branch, **lists):
        r = self.put_rules({"branchId": branch.id, "expectedVersion": self.version(branchId=branch.id), **lists})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_a_branch_save_creates_a_copy_of_all_four_lists_and_leaves_the_global_rules_alone(self):
        before = PayrollSettings.get().staff_pf_rules
        body = self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        self.assertEqual(body["scope"], {"branchId": self.north.id, "branchName": "North", "isOverride": True})
        overrides = BranchSettingsOverride.objects.get(branch=self.north).overrides
        self.assertEqual(set(overrides), set(pf_esi.RULE_FIELD_NAMES))
        self.assertEqual(overrides["staff_esi_rules"][0]["id"], "esi1")  # copied from the global rules
        self.assertEqual(PayrollSettings.get().staff_pf_rules, before)
        listed = {b["name"]: b["hasOverride"] for b in self.get(SETTINGS).json()["branches"]}
        self.assertEqual({k: listed[k] for k in ("North", "South")}, {"North": True, "South": False})
        self.assertEqual(sum(listed.values()), 1)

    def test_the_branch_override_beats_the_global_rules_and_a_branch_without_one_follows_them(self):
        self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        in_north = _staff("B1", branch=self.north, co_emp_enabled=True)
        in_south = _staff("B2", branch=self.south, co_emp_enabled=True)
        nowhere = _staff("B3", branch=None, co_emp_enabled=True)
        for emp in (in_north, in_south, nowhere):
            _present_all(emp)
        self.assertEqual(_generate(in_north).pf_deduction, Decimal("600.00"))  # 5% of 12,000
        self.assertEqual(_generate(in_south).pf_deduction, Decimal("1440.00"))  # global 12%
        self.assertEqual(_generate(nowhere).pf_deduction, Decimal("1440.00"))
        self.assertEqual(_slip(in_north).breakdown_details["deductions"]["statutory"]["rulesScope"], "branch")
        self.assertEqual(_slip(in_south).breakdown_details["deductions"]["statutory"]["rulesScope"], "global")

    def test_a_later_global_change_reaches_the_branch_without_an_override_but_not_the_one_with(self):
        self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        r = self.put_rules({"expectedVersion": self.version(), "staff": {"pfRules": [_rule("g2", 0, 0, 10)]}})
        self.assertEqual(r.status_code, 200)
        in_north = _staff("B4", branch=self.north, co_emp_enabled=True)
        in_south = _staff("B5", branch=self.south, co_emp_enabled=True)
        for emp in (in_north, in_south):
            _present_all(emp)
        self.assertEqual(_generate(in_north).pf_deduction, Decimal("600.00"))
        self.assertEqual(_generate(in_south).pf_deduction, Decimal("1200.00"))

    def test_deleting_the_override_makes_the_branch_follow_the_global_rules_again(self):
        self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        r = self.send("delete", f"{SETTINGS}?branchId={self.north.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["scope"]["isOverride"], False)
        self.assertEqual(body["staff"]["pfRules"], [PF])
        self.assertFalse(BranchSettingsOverride.objects.filter(branch=self.north).exists())
        emp = _staff("B6", branch=self.north, co_emp_enabled=True)
        _present_all(emp)
        self.assertEqual(_generate(emp).pf_deduction, Decimal("1440.00"))
        self.assertTrue(AuditLog.objects.filter(module="settings", record_description__contains="reset").exists())

    def test_deleting_keeps_the_branchs_other_private_settings(self):
        BranchSettingsOverride.objects.create(branch=self.north, overrides={"pay_day": 12})
        self.save_branch(self.north, staff={"pfRules": []})
        self.send("delete", f"{SETTINGS}?branchId={self.north.id}")
        self.assertEqual(BranchSettingsOverride.objects.get(branch=self.north).overrides, {"pay_day": 12})

    def test_delete_needs_a_branch_and_an_existing_one_and_is_harmless_when_there_is_no_override(self):
        r = self.send("delete", SETTINGS)
        self.assertEqual(r.status_code, 400)
        self.assertIn("branchId is required", r.json()["error"])
        self.assertEqual(self.send("delete", f"{SETTINGS}?branchId=99999").status_code, 404)
        r = self.send("delete", f"{SETTINGS}?branchId={self.south.id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(PayrollSettings.get().staff_pf_rules, [PF])

    def test_a_branch_save_is_judged_against_the_branchs_own_version(self):
        stale = self.version(branchId=self.north.id)
        self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        r = self.put_rules({"branchId": self.north.id, "expectedVersion": stale, "staff": {"pfRules": []}})
        self.assertEqual(r.status_code, 409)

    def test_a_branch_that_inherits_goes_stale_when_the_global_rules_change(self):
        inherited = self.version(branchId=self.south.id)
        self.put_rules({"expectedVersion": self.version(), "staff": {"pfRules": [_rule("g2", 0, 0, 10)]}})
        r = self.put_rules({"branchId": self.south.id, "expectedVersion": inherited, "staff": {"pfRules": []}})
        self.assertEqual(r.status_code, 409)

    def test_unrelated_settings_saved_by_a_branch_login_never_touch_its_rule_override(self):
        self.save_branch(self.north, staff={"pfRules": [_rule("n1", 0, 0, 5)]})
        # the global rules later become identical to the branch's: the override must still be kept as stored
        self.put_rules({"expectedVersion": self.version(), "staff": {"pfRules": [_rule("n1", 0, 0, 5)]}})
        saver = _hr_user("north_settings", permissions={"settings.payroll": "edit"}, branch=self.north)
        r = self.send("put", "/api/payroll-settings", {"payDay": 9}, saver)
        self.assertEqual(r.status_code, 200, r.content)
        overrides = BranchSettingsOverride.objects.get(branch=self.north).overrides
        self.assertEqual(overrides["pay_day"], 9)
        self.assertEqual(set(overrides) & set(pf_esi.RULE_FIELD_NAMES), set(pf_esi.RULE_FIELD_NAMES))

    def test_the_generic_settings_api_cannot_write_the_rules(self):
        r = self.send(
            "put",
            "/api/payroll-settings",
            {"staffPfRules": [_rule("x", 0, 0, 99)], "staff_pf_rules": [_rule("y", 0, 0, 98)]},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(PayrollSettings.get().staff_pf_rules, [PF])
        self.assertNotIn("staffPfRules", self.get("/api/payroll-settings").json())


# ─────────────────────────────────────────────────────────────────────────────
#  TDS endpoints
# ─────────────────────────────────────────────────────────────────────────────


class TdsEndpointTests(Base):
    def add(self, code, percent=10, user=None):
        return self.send("post", TDS, {"employeeCode": code, "percent": percent}, user)

    def test_adding_a_non_co_emp_employee(self):
        emp = _staff("T1", branch=self.north)
        r = self.add("T1", "12.5")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertFalse(body["movedFromPfEsi"])
        self.assertEqual(
            body["employee"],
            {
                "id": emp.id,
                "employeeCode": "T1",
                "name": "T1 Staff",
                "departmentName": None,
                "designationTitle": None,
                "branchId": self.north.id,
                "branchName": "North",
                "employmentType": "staff",
                "status": "active",
                "tdsPercent": 12.5,
            },
        )
        emp.refresh_from_db()
        self.assertEqual((emp.tds_enabled, emp.co_emp_enabled, emp.tds_percent), (True, False, Decimal("12.50")))

    def test_adding_a_co_emp_employee_moves_them(self):
        emp = _staff("T2", co_emp_enabled=True)
        r = self.add("T2")
        self.assertEqual(r.status_code, 201)
        self.assertTrue(r.json()["movedFromPfEsi"])
        emp.refresh_from_db()
        self.assertEqual((emp.co_emp_enabled, emp.tds_enabled), (False, True))

    def test_the_code_is_matched_exactly_then_case_insensitively(self):
        emp = _staff("uk77")
        _staff("UK78")
        self.assertEqual(self.add("UK77").status_code, 201)
        emp.refresh_from_db()
        self.assertTrue(emp.tds_enabled)
        self.assertEqual(self.add("  uk78 ").status_code, 201)

    def test_unknown_code_inactive_employee_and_bad_input(self):
        r = self.add("NOPE")
        self.assertEqual((r.status_code, r.json()["code"]), (404, "employee_not_found"))
        self.assertIn("No employee with code 'NOPE'", r.json()["error"])
        _staff("T3", status="inactive")
        r = self.add("T3")
        self.assertEqual((r.status_code, r.json()["code"]), (400, "employee_inactive"))
        _staff("T4")
        for bad in (0, -1, 100.01, 101, "abc", None, True, "12.345", "NaN", "Infinity", [5]):
            r = self.add("T4", bad)
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("Percentage must be greater than 0", r.json()["error"], bad)
        self.assertFalse(Employee.objects.get(employee_code="T4").tds_enabled)
        r = self.send("post", TDS, {"percent": 5})
        self.assertEqual(r.status_code, 400)
        self.assertIn("employeeCode", r.json()["error"])
        self.assertEqual(self.add("T4", 100).status_code, 201)  # the edge is allowed

    def test_adding_twice_is_a_409_that_says_so_and_keeps_the_first_percentage(self):
        _staff("T5")
        self.add("T5", 10)
        r = self.add("T5", 20)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "already_in_tds"))
        self.assertIn("T5 is already in TDS (10%)", r.json()["error"])
        self.assertEqual(Employee.objects.get(employee_code="T5").tds_percent, Decimal("10.00"))

    def test_changing_the_percentage(self):
        emp = _staff("T6")
        self.add("T6", 10)
        r = self.send("patch", f"{TDS}/{emp.id}", {"percent": 7.25})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["employee"]["tdsPercent"], 7.25)
        self.assertEqual(self.send("patch", f"{TDS}/{emp.id}", {"percent": 0}).status_code, 400)
        self.assertEqual(Employee.objects.get(pk=emp.pk).tds_percent, Decimal("7.25"))

    def test_changing_or_removing_an_employee_who_is_not_in_tds_is_a_404(self):
        emp = _staff("T7")
        for method, body in (("patch", {"percent": 5}), ("delete", None)):
            r = self.send(method, f"{TDS}/{emp.id}", body)
            self.assertEqual((r.status_code, r.json()["code"]), (404, "not_in_tds"), method)
        self.assertEqual(self.send("patch", f"{TDS}/999999", {"percent": 5}).status_code, 404)

    def test_every_change_is_audit_logged(self):
        emp = _staff("T8", co_emp_enabled=True)
        self.add("T8", 10)
        self.send("patch", f"{TDS}/{emp.id}", {"percent": 12})
        self.send("delete", f"{TDS}/{emp.id}")
        logs = list(AuditLog.objects.filter(module="employees", record_id=emp.id).order_by("id"))
        texts = [entry.record_description for entry in logs]
        self.assertEqual(len(logs), 3, texts)
        self.assertIn("Added T8 -T8 Staff to TDS at 10% (taken out of Co Emp", texts[0])
        self.assertIn("from 10% to 12%", texts[1])
        self.assertIn("Removed T8 -T8 Staff from TDS", texts[2])
        self.assertEqual(logs[0].old_values["coEmpEnabled"], True)
        self.assertEqual(logs[0].new_values, {"coEmpEnabled": False, "tdsEnabled": True, "tdsPercent": 10.0})

    def test_turning_co_emp_on_for_a_tds_employee_is_audit_logged_too(self):
        emp = _staff("T9", branch=self.north, tds_enabled=True, tds_percent=Decimal("4"))
        self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": True})
        self.assertTrue(
            AuditLog.objects.filter(module="employees", record_description__contains="from TDS to Co Emp").exists()
        )

    def test_the_list_filters_search_and_counts(self):
        a = _staff("L1", branch=self.north)
        b = _worker("L2", branch=self.south)
        c = _staff("L3", branch=self.north)
        Employee.objects.filter(pk=c.pk).update(status="inactive")
        for emp in (a, b, c):
            Employee.objects.filter(pk=emp.pk).update(tds_enabled=True, tds_percent=Decimal("5"))
        _staff("L4")  # not in TDS
        everything = self.get(TDS).json()
        self.assertEqual(sorted(e["employeeCode"] for e in everything["employees"]), ["L1", "L2", "L3"])
        self.assertEqual(everything["counts"], {"all": 3, "staff": 2, "production": 1})
        staff = self.get(TDS, type="staff").json()
        self.assertEqual(sorted(e["employeeCode"] for e in staff["employees"]), ["L1", "L3"])
        self.assertEqual(staff["counts"]["all"], 3)  # the badges do not move with the filter
        self.assertEqual([e["employeeCode"] for e in self.get(TDS, type="production").json()["employees"]], ["L2"])
        self.assertEqual(
            [
                e["employeeCode"]
                for e in self.get(TDS, status="active").json()["employees"]
                if e["employmentType"] == "staff"
            ],
            ["L1"],
        )
        self.assertEqual([e["employeeCode"] for e in self.get(TDS, search="l2").json()["employees"]], ["L2"])
        self.assertEqual([e["employeeCode"] for e in self.get(TDS, search="L1 Staff").json()["employees"]], ["L1"])
        self.assertEqual([e["employeeCode"] for e in self.get(TDS, branchId=self.south.id).json()["employees"]], ["L2"])
        self.assertEqual(self.get(TDS, type="nope").status_code, 400)
        self.assertEqual(self.get(TDS, status="nope").status_code, 400)

    def test_permissions_follow_the_employees_module(self):
        viewer = _hr_user("tds_viewer", permissions={"employees": "view"})
        editor = _hr_user("tds_editor", permissions={"employees": "edit"})
        nobody = _hr_user("tds_nobody", permissions={"employees": "hidden"})
        emp = _staff("P1")
        self.assertEqual(self.get(TDS, viewer).status_code, 200)
        self.assertEqual(self.add("P1", 5, viewer).status_code, 403)
        self.assertEqual(self.get(TDS, nobody).status_code, 403)
        self.assertEqual(self.add("P1", 5, nobody).status_code, 403)
        self.assertEqual(self.add("P1", 5, editor).status_code, 201)
        self.assertEqual(self.send("patch", f"{TDS}/{emp.id}", {"percent": 6}, viewer).status_code, 403)
        self.assertEqual(self.send("delete", f"{TDS}/{emp.id}", None, viewer).status_code, 403)
        self.assertEqual(self.send("delete", f"{TDS}/{emp.id}", None, editor).status_code, 200)

    def test_a_branch_login_only_reaches_its_own_branch(self):
        mine = _staff("S1", branch=self.north)
        theirs = _staff("S2", branch=self.south)
        user = _hr_user("north_tds", permissions={"employees": "edit"}, branch=self.north)
        self.assertEqual(self.add("S2", 5, user).status_code, 404)  # another branch's code looks like an unknown one
        self.assertFalse(Employee.objects.get(pk=theirs.pk).tds_enabled)
        self.assertEqual(self.add("S1", 5, user).status_code, 201)
        Employee.objects.filter(pk=theirs.pk).update(tds_enabled=True, tds_percent=Decimal("5"))
        listed = [e["employeeCode"] for e in self.get(TDS, user).json()["employees"]]
        self.assertEqual(listed, ["S1"])
        self.assertEqual(self.get(TDS, user).json()["counts"]["all"], 1)
        self.assertEqual(self.send("patch", f"{TDS}/{theirs.id}", {"percent": 9}, user).status_code, 404)
        self.assertEqual(self.send("delete", f"{TDS}/{theirs.id}", None, user).status_code, 404)
        self.assertEqual(self.send("delete", f"{TDS}/{mine.id}", None, user).status_code, 200)

    def test_an_employee_token_is_refused(self):
        token = sign_token({"role": "employee", "employeeId": 1})
        r = self.client.get(TDS, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(r.status_code, 403)


class EmployeeJsonAndCoEmpToggleTests(Base):
    def test_the_employee_json_carries_the_tds_fields(self):
        emp = _staff("J1", branch=self.north, tds_enabled=True, tds_percent=Decimal("7.5"))
        plain = _staff("J2", branch=self.north, co_emp_enabled=True)
        body = self.get(f"{EMPLOYEES}/{emp.id}").json()
        self.assertEqual((body["tdsEnabled"], body["tdsPercent"], body["coEmpEnabled"]), (True, 7.5, False))
        body = self.get(f"{EMPLOYEES}/{plain.id}").json()
        self.assertEqual((body["tdsEnabled"], body["tdsPercent"], body["coEmpEnabled"]), (False, None, True))
        listed = {e["employeeCode"]: e for e in self.get(EMPLOYEES).json()}
        self.assertEqual((listed["J1"]["tdsEnabled"], listed["J2"]["tdsEnabled"]), (True, False))

    def test_tds_fields_in_a_patch_are_ignored(self):
        emp = _staff("J3", branch=self.north)
        r = self.send("patch", f"{EMPLOYEES}/{emp.id}", {"tdsEnabled": True, "tdsPercent": 50, "firstName": "Renamed"})
        self.assertEqual(r.status_code, 200)
        emp.refresh_from_db()
        self.assertEqual((emp.first_name, emp.tds_enabled, emp.tds_percent), ("Renamed", False, None))

    def test_co_emp_must_be_a_real_boolean(self):
        emp = _staff("J4", branch=self.north)
        for bad in ("true", "false", 1, 0, None, []):
            r = self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": bad})
            self.assertEqual(r.status_code, 400, bad)
            self.assertEqual(r.json()["error"], "coEmpEnabled must be true or false")
        self.assertFalse(Employee.objects.get(pk=emp.pk).co_emp_enabled)
        self.assertEqual(self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": True}).status_code, 200)

    def test_turning_co_emp_off_or_on_for_a_normal_employee_is_unchanged(self):
        emp = _staff("J5", branch=self.north)
        on = self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": True}).json()
        self.assertEqual((on["coEmpEnabled"], on["tdsEnabled"]), (True, False))
        off = self.send("patch", f"{EMPLOYEES}/{emp.id}", {"coEmpEnabled": False}).json()
        self.assertEqual((off["coEmpEnabled"], off["tdsEnabled"]), (False, False))

    def test_an_unrelated_patch_never_changes_the_category(self):
        emp = _staff("J6", branch=self.north, tds_enabled=True, tds_percent=Decimal("5"))
        self.send("patch", f"{EMPLOYEES}/{emp.id}", {"firstName": "Same"})
        emp.refresh_from_db()
        self.assertEqual((emp.tds_enabled, emp.tds_percent, emp.co_emp_enabled), (True, Decimal("5.00"), False))


# ─────────────────────────────────────────────────────────────────────────────
#  CoPortal scope
# ─────────────────────────────────────────────────────────────────────────────


class CoPortalScopeTests(TestCase):
    def setUp(self):
        from django.test import override_settings

        patcher = override_settings(CO_PORTAL_API_KEY="portal-key")
        patcher.enable()
        self.addCleanup(patcher.disable)
        self.co = _staff("CP1", co_emp_enabled=True)
        self.tds = _staff("CP2", tds_enabled=True, tds_percent=Decimal("5"))
        self.neither = _staff("CP3")
        for emp in (self.co, self.tds, self.neither):
            AttendanceLog.objects.create(
                employee=emp, date=date(2026, 2, 2), punch_time="09:00", punch_type="IN", source="test"
            )

    def get(self, path):
        return self.client.get(f"/api/co-portal/{path}", HTTP_X_PORTAL_KEY="portal-key")

    def test_employees_are_the_co_emp_ones_and_the_tds_ones(self):
        codes = sorted(e["employeeCode"] for e in self.get("employees").json()["results"])
        self.assertEqual(codes, ["CP1", "CP2"])

    def test_attendance_logs_follow_the_same_scope(self):
        codes = sorted({row["employeeCode"] for row in self.get("attendance-logs").json()["results"]})
        self.assertEqual(codes, ["CP1", "CP2"])

    def test_no_pf_esi_or_tds_marker_leaks_to_the_portal(self):
        row = next(e for e in self.get("employees").json()["results"] if e["employeeCode"] == "CP2")
        for key in row:
            self.assertNotIn("tds", key.lower())
            self.assertNotIn("coemp", key.lower())

    def test_an_employee_leaving_both_categories_leaves_the_portal(self):
        Employee.objects.filter(pk=self.tds.pk).update(tds_enabled=False, tds_percent=None)
        self.assertEqual([e["employeeCode"] for e in self.get("employees").json()["results"]], ["CP1"])

    def test_moving_between_the_categories_keeps_the_employee_visible_and_stamps_updated_at(self):
        before = Employee.objects.get(pk=self.co.pk).updated_at
        admin = _hr_user("cp_admin", super_admin=True)
        r = self.client.post(
            TDS, {"employeeCode": "CP1", "percent": 5}, content_type="application/json", **_auth(admin)
        )
        self.assertEqual(r.status_code, 201)
        self.assertGreater(Employee.objects.get(pk=self.co.pk).updated_at, before)
        codes = sorted(e["employeeCode"] for e in self.get("employees").json()["results"])
        self.assertEqual(codes, ["CP1", "CP2"])

    def test_the_shared_endpoint_visible_filter_uses_the_same_scope(self):
        from .shared_datasets import _visible_to_external

        codes = sorted(_visible_to_external(Employee.objects.all(), True).values_list("employee_code", flat=True))
        self.assertEqual(codes, ["CP1", "CP2"])
        self.assertEqual(_visible_to_external(Employee.objects.all(), False).count(), 3)


# ─────────────────────────────────────────────────────────────────────────────
#  Coverage
# ─────────────────────────────────────────────────────────────────────────────


class CoverageTests(Base):
    def setUp(self):
        super().setUp()
        _configure(
            prod_pf_rules=[_rule("pp", 0, 20000, 12, "total")],
            prod_esi_rules=[_rule("pe", 0, 12000, 1, "total")],
        )
        # staff: both (Basic 4,000) / PF only (Basic 27,000 is over... see below) / neither / TDS / not Co Emp
        self.both = _staff("V1", co_emp_enabled=True)
        self.esi_only = _staff(
            "V2", salary="162000.00", co_emp_enabled=True
        )  # Basic 27,000: over the PF limit, under ESI
        self.neither = _staff("V3", salary="300000.00", co_emp_enabled=True)  # Basic 50,000: over both
        self.tds = _staff("V4", tds_enabled=True, tds_percent=Decimal("5"))
        self.plain = _staff("V5")
        self.inactive = _staff("V6", co_emp_enabled=True)
        Employee.objects.filter(pk=self.inactive.pk).update(status="inactive")
        # production: one with a generated slip (inside PF, outside ESI), one never generated, one TDS, one plain
        self.p1 = _worker("V7", per_shift="1000.00", co_emp_enabled=True)
        for offset in range(7):
            _day(self.p1, date(2026, 2, 2 + offset), shifts="1.00")
        _generate_production_payroll(
            self.p1, date(2026, 2, 2), date(2026, 2, 8), pay_cycle="weekly"
        )  # 7,000 x4 = 28,000
        self.p2 = _worker("V8", co_emp_enabled=True)
        self.p3 = _worker("V9", tds_enabled=True, tds_percent=Decimal("2"))
        self.p4 = _worker("V10")

    def test_the_counts_by_class(self):
        body = self.get(COVERAGE).json()
        self.assertEqual(
            body["staff"],
            {
                "total": 5, "coEmp": 3, "tds": 1, "notCoEmp": 1, "withPf": 1, "withEsi": 2, "withBoth": 1,
                "withAny": 2, "withNeither": 1, "notEvaluated": 0,
            },
        )  # fmt: skip
        # V7: monthly equivalent 28,000 -> outside both production ranges; V8 has no payroll yet
        self.assertEqual(
            body["production"],
            {
                "total": 4, "coEmp": 2, "tds": 1, "notCoEmp": 1, "withPf": 0, "withEsi": 0, "withBoth": 0,
                "withAny": 0, "withNeither": 1, "notEvaluated": 1,
            },
        )  # fmt: skip
        self.assertEqual(body["filters"], {"type": "all", "branchId": None})
        self.assertNotIn("employees", body)

    def test_the_invariants_hold(self):
        body = self.get(COVERAGE).json()
        for key in ("staff", "production"):
            c = body[key]
            self.assertEqual(c["total"], c["coEmp"] + c["tds"] + c["notCoEmp"], key)
            self.assertEqual(c["coEmp"], c["withAny"] + c["withNeither"] + c["notEvaluated"], key)

    def test_inactive_employees_are_not_counted(self):
        self.assertEqual(self.get(COVERAGE, type="staff").json()["staff"]["total"], 5)

    def test_the_type_filter_omits_the_other_class(self):
        body = self.get(COVERAGE, type="staff").json()
        self.assertIn("staff", body)
        self.assertNotIn("production", body)
        self.assertEqual(self.get(COVERAGE, type="production").json()["production"]["total"], 4)
        self.assertEqual(self.get(COVERAGE, type="x").status_code, 400)

    def test_detail_rows_say_who_is_in_which_state(self):
        rows = {r["employeeCode"]: r for r in self.get(COVERAGE, detail=1).json()["employees"]}
        self.assertEqual(set(rows), {"V1", "V2", "V3", "V4", "V5", "V7", "V8", "V9", "V10"})
        self.assertEqual((rows["V1"]["status"], rows["V1"]["pf"], rows["V1"]["esi"]), ("pf_esi", True, True))
        self.assertEqual((rows["V1"]["pfRatePercent"], rows["V1"]["esiRatePercent"]), (12, 0.75))
        self.assertEqual((rows["V2"]["status"], rows["V2"]["pf"], rows["V2"]["esi"]), ("esi_only", False, True))
        self.assertEqual((rows["V3"]["status"], rows["V3"]["pf"]), ("neither", False))
        self.assertEqual(
            (rows["V4"]["status"], rows["V4"]["category"], rows["V4"]["tdsPercent"], rows["V4"]["pf"]),
            ("tds", "tds", 5.0, None),
        )
        self.assertEqual((rows["V5"]["status"], rows["V5"]["category"]), ("not_co_emp", "none"))
        self.assertEqual((rows["V7"]["status"], rows["V8"]["status"]), ("neither", "not_evaluated"))
        self.assertEqual(rows["V8"]["pf"], None)

    def test_a_branch_override_changes_the_count_for_that_branch_only(self):
        Employee.objects.filter(pk__in=[self.both.pk, self.esi_only.pk]).update(branch=self.north)
        self.put_rules(
            {
                "branchId": self.north.id,
                "expectedVersion": self.version(branchId=self.north.id),
                "staff": {"pfRules": [], "esiRules": []},
            }
        )
        rows = {r["employeeCode"]: r for r in self.get(COVERAGE, detail=1, type="staff").json()["employees"]}
        self.assertEqual(rows["V1"]["status"], "neither")  # North has no rules at all
        self.assertEqual(rows["V3"]["status"], "neither")  # unchanged: no branch
        self.assertEqual(self.get(COVERAGE, branchId=self.north.id).json()["staff"]["total"], 2)

    def test_a_branch_login_is_counted_within_its_branch(self):
        Employee.objects.filter(pk__in=[self.both.pk, self.plain.pk]).update(branch=self.north)
        user = _hr_user("cov_north", permissions={"employees": "view"}, branch=self.north)
        body = self.get(COVERAGE, user).json()
        self.assertEqual((body["staff"]["total"], body["staff"]["coEmp"], body["production"]["total"]), (2, 1, 0))

    def test_permission_is_the_employees_module(self):
        nobody = _hr_user("cov_nobody", permissions={"employees": "hidden"})
        self.assertEqual(self.get(COVERAGE, nobody).status_code, 403)
        self.assertEqual(self.get(COVERAGE, _hr_user("cov_viewer", permissions={"employees": "view"})).status_code, 200)


# ─────────────────────────────────────────────────────────────────────────────
#  Employer cost (CTC)
# ─────────────────────────────────────────────────────────────────────────────


class CtcTests(Base):
    def test_employer_figures_use_the_same_rules_for_co_emp_employees_only(self):
        from .ctc import ctc_figures

        co = _staff("C1", co_emp_enabled=True)
        plain = _staff("C2")
        tds = _staff("C3", tds_enabled=True, tds_percent=Decimal("5"))
        ps = PayrollSettings.get()
        self.assertEqual((ctc_figures(co, ps)["employerPf"], ctc_figures(co, ps)["employerEsi"]), (1440.0, 90.0))
        self.assertEqual(ctc_figures(co, ps)["annualCtc"], (24000 + 1440 + 90) * 12)
        for emp in (plain, tds):
            figures = ctc_figures(emp, ps)
            self.assertEqual(
                (figures["employerPf"], figures["employerEsi"], figures["annualCtc"]), (0.0, 0.0, 288000.0)
            )


# ─────────────────────────────────────────────────────────────────────────────
#  Registry
# ─────────────────────────────────────────────────────────────────────────────


class RegistryTests(SimpleTestCase):
    def test_the_new_endpoints_are_gated_the_way_the_spec_says(self):
        from .permission_registry import resolve_module

        self.assertEqual(resolve_module("tds/employees"), "employees")
        self.assertEqual(resolve_module("tds/employees/12"), "employees")
        self.assertEqual(resolve_module("pf-esi/coverage"), "employees")
        self.assertIsNone(resolve_module("pf-esi-settings"))  # readable by every HR login; the view guards writes


# ─────────────────────────────────────────────────────────────────────────────
#  The data migration of the retired methods
# ─────────────────────────────────────────────────────────────────────────────

MIGRATION = importlib.import_module("api.migrations.0127_pf_esi_rules_data")


def _old(**values) -> dict:
    base = {
        "pf_rate": Decimal("0"),
        "esi_rate": Decimal("0"),
        "esi_applicable_below": Decimal("21000"),
        "prod_pf_rate": Decimal("0"),
        "prod_esi_rate": Decimal("0"),
        "prod_esi_applicable_below": Decimal("21000"),
        "prod_pf_ef_enabled": False,
        "prod_pf_ef_rules": [],
        "staff_payroll_rules_enabled": False,
        "prod_payroll_rules_enabled": False,
    }
    return {**base, **values}


def _shape(rules):
    """(basis, min, max, rate) of each rule."""
    return [(r["basis"], r["minAmount"], r["maxAmount"], r["ratePercent"]) for r in rules]


class MigrationConversionTests(SimpleTestCase):
    convert = staticmethod(MIGRATION.convert_settings)

    def test_nothing_enabled_means_no_rules(self):
        out = self.convert(_old(pf_rate=Decimal("12"), esi_rate=Decimal("0.75"), prod_pf_rate=Decimal("12")))
        self.assertEqual(out, {"staff_pf_rules": [], "staff_esi_rules": [], "prod_pf_rules": [], "prod_esi_rules": []})

    def test_stored_bands_that_were_switched_off_are_not_carried_over(self):
        bands = [{"label": "Staff", "minSalary": 15000, "maxSalary": 25000, "pfRate": 10, "efRate": 20}]
        self.assertEqual(self.convert(_old(prod_pf_ef_enabled=False, prod_pf_ef_rules=bands))["prod_pf_rules"], [])

    def test_staff_flat_rates_become_total_basis_rules(self):
        out = self.convert(
            _old(
                staff_payroll_rules_enabled=True,
                pf_rate=Decimal("12"),
                esi_rate=Decimal("0.75"),
                esi_applicable_below=Decimal("21000"),
            )
        )
        self.assertEqual(_shape(out["staff_pf_rules"]), [("total", 0, 0, 12)])
        self.assertEqual(_shape(out["staff_esi_rules"]), [("total", 0, 21000, 0.75)])
        self.assertEqual(out["staff_pf_rules"][0]["label"], "Migrated flat PF")
        self.assertEqual((out["prod_pf_rules"], out["prod_esi_rules"]), ([], []))

    def test_a_zero_rate_or_a_zero_ceiling_creates_no_rule(self):
        out = self.convert(
            _old(
                staff_payroll_rules_enabled=True,
                pf_rate=Decimal("0"),
                esi_rate=Decimal("0.75"),
                esi_applicable_below=Decimal("0"),
            )
        )
        self.assertEqual(
            (out["staff_pf_rules"], out["staff_esi_rules"]), ([], [])
        )  # a 0 ceiling meant ESI never applied

    def test_production_flat_rates(self):
        out = self.convert(
            _old(
                prod_payroll_rules_enabled=True,
                prod_pf_rate=Decimal("12"),
                prod_esi_rate=Decimal("0.75"),
                prod_esi_applicable_below=Decimal("21000"),
            )
        )
        self.assertEqual(_shape(out["prod_pf_rules"]), [("total", 0, 0, 12)])
        self.assertEqual(_shape(out["prod_esi_rules"]), [("total", 0, 21000, 0.75)])

    def test_production_bands_become_one_pf_and_one_esi_rule_each(self):
        bands = [
            {"label": "Low", "minSalary": 0, "maxSalary": 10000, "pfRate": 0, "efRate": 0},
            {"label": "Mid", "minSalary": 10001, "maxSalary": 20000, "pfRate": 12, "efRate": 1},
            {"label": "Top", "minSalary": 20001, "maxSalary": 0, "pfRate": 12, "efRate": 0},
        ]
        out = self.convert(_old(prod_pf_ef_enabled=True, prod_pf_ef_rules=bands))
        self.assertEqual(_shape(out["prod_pf_rules"]), [("total", 10001, 20000, 12), ("total", 20001, 0, 12)])
        self.assertEqual(_shape(out["prod_esi_rules"]), [("total", 10001, 20000, 1)])
        self.assertEqual([r["label"] for r in out["prod_pf_rules"]], ["Mid (PF)", "Top (PF)"])
        self.assertEqual(len({r["id"] for r in out["prod_pf_rules"] + out["prod_esi_rules"]}), 3)

    def test_the_flat_rates_keep_applying_where_no_band_does_and_a_zero_band_still_blocks_them(self):
        bands = [
            {"label": "Exempt", "minSalary": 0, "maxSalary": 10000, "pfRate": 0, "efRate": 0},
            {"label": "Mid", "minSalary": 15000, "maxSalary": 20000, "pfRate": 5, "efRate": 0},
        ]
        out = self.convert(
            _old(
                prod_pf_ef_enabled=True, prod_pf_ef_rules=bands, prod_payroll_rules_enabled=True,
                prod_pf_rate=Decimal("12"), prod_esi_rate=Decimal("1"), prod_esi_applicable_below=Decimal("30000"),
            )
        )  # fmt: skip
        # PF: the Exempt band took 0..10,000 (old engine: matched band wins even at 0%), Mid is 15,000..20,000, the flat
        # 12% covers what is left: 10,000.01..14,999.99 and 20,000.01 up
        self.assertEqual(
            _shape(out["prod_pf_rules"]),
            [("total", 15000, 20000, 5), ("total", 10000.01, 14999.99, 12), ("total", 20000.01, 0, 12)],
        )
        # ESI: no band has an ESI rate; the flat 1% (ceiling 30,000) covers what the bands do not
        self.assertEqual(
            _shape(out["prod_esi_rules"]),
            [("total", 10000.01, 14999.99, 1), ("total", 20000.01, 30000, 1)],
        )

    def test_overlapping_old_bands_are_cut_back_so_the_new_lists_validate(self):
        bands = [
            {"label": "A", "minSalary": 0, "maxSalary": 20000, "pfRate": 10, "efRate": 5},
            {"label": "B", "minSalary": 10000, "maxSalary": 30000, "pfRate": 12, "efRate": 1},
        ]
        out = self.convert(_old(prod_pf_ef_enabled=True, prod_pf_ef_rules=bands))
        self.assertEqual(_shape(out["prod_pf_rules"]), [("total", 0, 20000, 10), ("total", 20000.01, 30000, 12)])
        for emp_class, kind, field in (("production", "pf", "prod_pf_rules"), ("production", "esi", "prod_esi_rules")):
            pf_esi.clean_rule_list(out[field], emp_class, kind)  # no overlap, all in range

    def test_a_band_that_could_never_match_is_dropped(self):
        bands = [{"label": "Never", "minSalary": 5000, "maxSalary": 1000, "pfRate": 12, "efRate": 1}]
        out = self.convert(_old(prod_pf_ef_enabled=True, prod_pf_ef_rules=bands))
        self.assertEqual((out["prod_pf_rules"], out["prod_esi_rules"]), ([], []))

    def test_junk_in_the_stored_values_never_crashes(self):
        out = self.convert(
            _old(prod_pf_ef_enabled=True, prod_pf_ef_rules=["x", {"minSalary": "abc", "pfRate": None}, {"label": "L", "pfRate": "7"}],
                 staff_payroll_rules_enabled="true", pf_rate="abc", esi_rate=None)
        )  # fmt: skip
        self.assertEqual(out["staff_pf_rules"], [])
        self.assertEqual(
            _shape(out["prod_pf_rules"]), [("total", 0, 0, 7)]
        )  # min "abc" read as 0, then "L" at 7% over what is left


class MigrationRunTests(TestCase):
    """forwards() on real rows, as the migration runs it."""

    def run_forwards(self):
        MIGRATION.forwards(django_apps, None)

    def test_the_universal_row_and_a_branch_override_are_converted_and_nothing_is_invented(self):
        PayrollSettings.objects.update_or_create(
            pk=1,
            defaults=dict(
                staff_payroll_rules_enabled=True, pf_rate=Decimal("12"), esi_rate=Decimal("0.75"),
                esi_applicable_below=Decimal("21000"), prod_payroll_rules_enabled=False,
                staff_pf_rules=[], staff_esi_rules=[], prod_pf_rules=[], prod_esi_rules=[],
            ),
        )  # fmt: skip
        north = Branch.objects.create(name="North")
        south = Branch.objects.create(name="South")
        quiet = Branch.objects.create(name="Quiet")
        BranchSettingsOverride.objects.create(branch=north, overrides={"pf_rate": "9", "pay_day": 3})
        BranchSettingsOverride.objects.create(branch=south, overrides={"staff_payroll_rules_enabled": False})
        BranchSettingsOverride.objects.create(branch=quiet, overrides={"pay_day": 4})
        self.run_forwards()
        ps = PayrollSettings.objects.get(pk=1)
        self.assertEqual(_shape(ps.staff_pf_rules), [("total", 0, 0, 12)])
        self.assertEqual(_shape(ps.staff_esi_rules), [("total", 0, 21000, 0.75)])
        self.assertEqual((ps.prod_pf_rules, ps.prod_esi_rules), ([], []))
        north_overrides = BranchSettingsOverride.objects.get(branch=north).overrides
        self.assertEqual(_shape(north_overrides["staff_pf_rules"]), [("total", 0, 0, 9)])  # its own 9%
        self.assertEqual(_shape(north_overrides["staff_esi_rules"]), [("total", 0, 21000, 0.75)])  # global value
        self.assertEqual(north_overrides["pay_day"], 3)  # untouched
        self.assertEqual(north_overrides["pf_rate"], "9")  # the retired key stays (additive only)
        south_overrides = BranchSettingsOverride.objects.get(branch=south).overrides
        self.assertEqual(south_overrides["staff_pf_rules"], [])  # the branch had switched the rules OFF
        self.assertEqual(south_overrides["prod_pf_rules"], [])
        self.assertEqual(
            BranchSettingsOverride.objects.get(branch=quiet).overrides, {"pay_day": 4}
        )  # no retired key: follows global

    def test_a_branch_whose_converted_rules_equal_the_global_ones_keeps_following_the_global_rules(self):
        PayrollSettings.objects.update_or_create(
            pk=1,
            defaults=dict(staff_payroll_rules_enabled=True, pf_rate=Decimal("12"), esi_rate=Decimal("0"),
                          staff_pf_rules=[], staff_esi_rules=[], prod_pf_rules=[], prod_esi_rules=[]),
        )  # fmt: skip
        branch = Branch.objects.create(name="Same")
        BranchSettingsOverride.objects.create(branch=branch, overrides={"pf_rate": "12"})
        self.run_forwards()
        self.assertEqual(BranchSettingsOverride.objects.get(branch=branch).overrides, {"pf_rate": "12"})

    def test_running_it_twice_changes_nothing_more(self):
        PayrollSettings.objects.update_or_create(
            pk=1,
            defaults=dict(staff_payroll_rules_enabled=True, pf_rate=Decimal("12"),
                          staff_pf_rules=[], staff_esi_rules=[], prod_pf_rules=[], prod_esi_rules=[]),
        )  # fmt: skip
        self.run_forwards()
        first = list(PayrollSettings.objects.get(pk=1).staff_pf_rules)
        self.run_forwards()
        self.assertEqual(PayrollSettings.objects.get(pk=1).staff_pf_rules, first)

    def test_rules_already_set_are_never_overwritten(self):
        PayrollSettings.objects.update_or_create(
            pk=1,
            defaults=dict(staff_payroll_rules_enabled=True, pf_rate=Decimal("12"),
                          staff_pf_rules=[PF], staff_esi_rules=[], prod_pf_rules=[], prod_esi_rules=[]),
        )  # fmt: skip
        self.run_forwards()
        self.assertEqual(PayrollSettings.objects.get(pk=1).staff_pf_rules, [PF])

    def test_a_fresh_install_with_no_settings_row_is_fine(self):
        PayrollSettings.objects.all().delete()
        self.run_forwards()
        self.assertFalse(PayrollSettings.objects.exists())

    def test_a_converted_set_of_lists_passes_the_api_validation(self):
        PayrollSettings.objects.update_or_create(
            pk=1,
            defaults=dict(
                prod_pf_ef_enabled=True,
                prod_pf_ef_rules=[
                    {"label": "A", "minSalary": 0, "maxSalary": 20000, "pfRate": 10, "efRate": 5},
                    {"label": "B", "minSalary": 10000, "maxSalary": 0, "pfRate": 12, "efRate": 1},
                ],
                prod_payroll_rules_enabled=True, prod_pf_rate=Decimal("3"),
                staff_pf_rules=[], staff_esi_rules=[], prod_pf_rules=[], prod_esi_rules=[],
            ),
        )  # fmt: skip
        self.run_forwards()
        ps = PayrollSettings.objects.get(pk=1)
        pf_esi.clean_rule_list(ps.prod_pf_rules, "production", "pf")
        pf_esi.clean_rule_list(ps.prod_esi_rules, "production", "esi")


class SchemaTests(TestCase):
    def test_new_columns_have_database_defaults_so_an_old_release_can_still_insert(self):
        # db_default: an old instance running during a rolling deploy inserts rows without knowing these columns.
        from django.db import connection

        wanted = {
            "payroll_settings": ("staff_pf_rules", "staff_esi_rules", "prod_pf_rules", "prod_esi_rules"),
            "employees": ("tds_enabled",),
            "salary_slips": ("tds_deduction",),
            "payrolls": ("tds_deduction",),
        }
        with connection.cursor() as cursor:
            for table, columns in wanted.items():
                cursor.execute(
                    "SELECT column_name, column_default, is_nullable FROM information_schema.columns "
                    "WHERE table_name = %s AND column_name = ANY(%s)",
                    [table, list(columns)],
                )
                found = {name: (default, nullable) for name, default, nullable in cursor.fetchall()}
                self.assertEqual(set(found), set(columns), table)
                for name, (default, nullable) in found.items():
                    self.assertIsNotNone(default, f"{table}.{name} has no database default")
                    self.assertEqual(nullable, "NO", f"{table}.{name}")

    def test_employees_default_to_no_tds(self):
        emp = _staff("SC1")
        self.assertEqual((emp.tds_enabled, emp.tds_percent), (False, None))

    def test_retired_columns_still_exist_but_nothing_reads_them(self):
        names = {f.name for f in PayrollSettings._meta.get_fields()}
        for retired in ("pf_rate", "esi_rate", "esi_applicable_below", "prod_pf_rate", "prod_esi_rate", "prod_esi_applicable_below",
                        "prod_pf_ef_enabled", "prod_pf_ef_rules", "staff_payroll_rules_enabled", "prod_payroll_rules_enabled"):  # fmt: skip
            self.assertIn(retired, names)
        # setting them to dramatic values changes no payroll
        _configure(attendance_mode="simple", compensation_feature_enabled=True, late_deduction_slabs=[], staff_pf_rules=[], staff_esi_rules=[],
                   pf_rate=Decimal("50"), esi_rate=Decimal("50"), staff_payroll_rules_enabled=True)  # fmt: skip
        emp = _staff("SC2", co_emp_enabled=True)
        _present_all(emp)
        self.assertEqual(_generate(emp).total_deductions, Decimal("0.00"))


class SplitAwareTests(Base):
    def test_the_recorded_split_decides_basic_but_the_first_portion_is_always_half(self):
        parts = {
            "basic": Decimal("30000"),
            "da": Decimal("0"),
            "retaining_allowance": Decimal("0"),
            "other_allowance": Decimal("30000"),
            "petrol_allowance": Decimal("0"),
            "hra": Decimal("0"),
            "special_allowance": Decimal("0"),
            "ca": Decimal("0"),
        }
        emp = _staff(
            "SP1", salary="60000.00", co_emp_enabled=True, **{salary_split.COLUMNS[c]: v for c, v in parts.items()}
        )
        auto = _staff("SP2", salary="60000.00", co_emp_enabled=True)  # automatic split: Basic 10,000
        for e in (emp, auto):
            _present_all(e)
        self.assertEqual(_generate(emp).pf_deduction, Decimal("0.00"))  # Basic 30,000 > 25,000
        self.assertEqual(_generate(auto).pf_deduction, Decimal("3600.00"))  # Basic 10,000 <= 25,000: 12% of 30,000
