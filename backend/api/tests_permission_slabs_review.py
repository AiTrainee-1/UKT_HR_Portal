"""Review round for the separate Production Bonus and the Permission Deduction Slabs: the fixes and the tests that pin them.

What is pinned here (each class names the finding it answers):

* settings permission groups follow the keys the Settings split moved between tabs (FIELD_GROUPS, prodCycles key by key);
* every slab cleaner answers a 400, never a 500, to absurd input (digit strings over Python's int limit, 1e999, NaN ...);
* the statutory "Late Detection - Salary Impact" report lists and counts a slip whose only deduction is the permission one,
  and has an ON test of its own;
* a production employee is never permission-priced, by any caller;
* the HR "compute shifts" recompute prices from the same rounded daily rate as payroll (to the paisa);
* one scenario whose excess / priced / billable / absorbed counts all differ, asserted in EVERY caller (slip, monthly summary,
  preview, reports, insights), plus pending / rejected permissions and a flagged non-working day through the non-slip callers;
* rounding on an exact half-paisa tie and the no-daily-rate path; report filters, summary tiles and the OFF shape; the day-level
  late reports under ON; the "changed since generated" marker of the slab table; the MonthlyShiftSummary column mapping.

Calendar and helpers are those of tests_permission_slabs.py: February 2026 (24 working days, daily rate 1,000 for a salary of
24,000), payrolls built with the REAL engine from manual AttendanceDayRecord rows.

Run via: python manage.py test api.tests_permission_slabs_review -v 2
"""

import json
import shutil
import tempfile
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase

from .attendance_final import late_pool_summary
from .models import (
    AttendanceDayRecord,
    Bonus,
    Branch,
    Employee,
    EmployeePermission,
    MonthlyShiftSummary,
    PayrollSettings,
    SalarySlip,
)
from .payroll_views import _d2, clean_permission_slabs, late_pool_pricing
from .shift_engine import compute_monthly_shift_summary
from .tests_md_demo_seed import SMALL, run
from .tests_permission_slabs import (
    FLAT_HALF,
    MIDDLE,
    MONTH,
    SETTINGS,
    SLABS,
    SUNDAY,
    WORKING,
    YEAR,
    _admin,
    _ded,
    _employee_token,
    _login,
    _on,
    _present_month,
    _scenario,
    _settings,
    _slip,
    _staff,
)

_FROZEN_TODAY = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN_TODAY.start()


def tearDownModule():
    _FROZEN_TODAY.stop()


# ─────────────────────────────────────────────────────────────────────────────
#  Settings permission groups follow the moved keys
# ─────────────────────────────────────────────────────────────────────────────


class FieldGroupTests(TestCase):
    """The Settings split moved the production late rules to Late Detection -> Production and the suggested salary per shift to
    Production Payroll -> Pay & Bonus. The role that owns the new tab must be able to save them; the role that owned the old
    one keeps the access it had."""

    LATE = {"settings.late_detection": "edit"}
    PRODUCTION = {"settings.production_payroll": "edit"}
    PAYROLL = {"settings.payroll": "edit"}

    def put(self, body, headers):
        return self.client.put(SETTINGS, json.dumps(body), content_type="application/json", **headers)

    def role(self, name, permissions):
        return _login(name, permissions)

    def assertAllowed(self, body, headers, label=""):
        r = self.put(body, headers)
        self.assertEqual(r.status_code, 200, (label, body, r.content))

    def assertDenied(self, body, headers, fields=None, label=""):
        r = self.put(body, headers)
        self.assertEqual(r.status_code, 403, (label, body, r.content))
        # the body shape the Settings page reads is unchanged: the same error code, message and the refused keys
        self.assertEqual(
            r.json(),
            {
                "error": "permission_denied",
                "message": "You do not have edit access to this settings section.",
                "fields": fields if fields is not None else list(body),
            },
            (label, body),
        )

    def test_the_suggested_salary_per_shift_accepts_either_the_production_or_the_old_payroll_group(self):
        production = self.role("p_only", self.PRODUCTION)
        payroll = self.role("pay_only", self.PAYROLL)
        late = self.role("l_only", self.LATE)
        view_only = self.role("viewer", {"settings.production_payroll": "view", "settings.payroll": "view"})
        neither = self.role("nobody", {})
        body = {"defaultSalaryPerShift": 450}
        self.assertAllowed(body, production)
        self.assertAllowed(body, payroll)
        self.assertDenied(body, late)
        self.assertDenied(body, view_only)
        self.assertDenied(body, neither)
        self.assertEqual(PayrollSettings.get().default_salary_per_shift, Decimal("450.00"))

    def test_the_production_bonus_and_the_salary_per_shift_save_together_for_a_production_only_role(self):
        # the Pay & Bonus form may send both boxes in one request: one production grant must be enough for the whole save
        production = self.role("p_both", self.PRODUCTION)
        self.assertAllowed({"prodBonusPercent": 12, "defaultSalaryPerShift": 460}, production)
        row = PayrollSettings.get()
        self.assertEqual((row.prod_bonus_percent, row.default_salary_per_shift), (Decimal("12.00"), Decimal("460.00")))
        # ...and a role with only Staff Payroll cannot touch the production bonus (it never could)
        self.assertDenied({"prodBonusPercent": 9}, self.role("pay_b", self.PAYROLL))

    def test_the_production_late_keys_accept_either_late_detection_or_production_payroll(self):
        bodies = (
            {"prodLateDetectionEnabled": True},
            {"prodAttendanceMode": "simple"},
            {"prodLateFreeAllowance": 2},
            {"prodLateDeductionSlabs": [{"fromLates": 1, "deductionShifts": 0.5}]},
            {
                "prodLateDetectionEnabled": False,
                "prodAttendanceMode": "strict",
                "prodLateFreeAllowance": 1,
                "prodLateDeductionSlabs": [],
            },
        )
        late = self.role("late_k", self.LATE)
        production = self.role("prod_k", self.PRODUCTION)
        both = self.role("both_k", {**self.LATE, **self.PRODUCTION})
        payroll = self.role("pay_k", self.PAYROLL)
        neither = self.role("none_k", {"settings.attendance": "edit"})
        for body in bodies:
            self.assertAllowed(body, late, "late_detection only")
            self.assertAllowed(body, production, "production_payroll only")
            self.assertAllowed(body, both, "both")
            self.assertDenied(body, payroll, label="staff payroll only")
            self.assertDenied(body, neither, label="neither")

    def test_a_save_mixing_a_late_key_with_a_period_key_needs_the_group_of_each_part(self):
        late = self.role("late_m", self.LATE)
        production = self.role("prod_m", self.PRODUCTION)
        both = self.role("both_m", {**self.LATE, **self.PRODUCTION})
        # a top-level production late key beside a Production Payroll key (the shared period rules)
        body = {"prodLateDetectionEnabled": True, "defaultSalaryPerShift": 410}
        self.assertDenied(body, late, ["defaultSalaryPerShift"])  # only the key the role may not edit is named
        self.assertAllowed(body, production)
        self.assertAllowed(body, both)

    def test_prod_cycles_is_judged_key_by_key(self):
        late_keys = {"weekly": {"lateFreeAllowance": 2, "lateSlabs": [{"fromLates": 1, "deductionShifts": 0.25}]}}
        late_nulls = {"biweekly": {"lateFreeAllowance": None, "lateSlabs": None}}  # "use the shared rules again"
        period_keys = {"weekly": {"weekStart": "wednesday"}, "monthly": {"anchorDate": "2026-01-05"}}
        both_kinds = {"weekly": {"weekStart": "monday", "lateFreeAllowance": 1}}
        both_kinds_split = {"weekly": {"lateFreeAllowance": 1}, "monthly": {"weekStart": "sunday"}}
        unknown_inner = {"weekly": {"bogus": 1}}
        not_an_object = {"weekly": 5}
        late = self.role("late_c", self.LATE)
        production = self.role("prod_c", self.PRODUCTION)
        both = self.role("both_c", {**self.LATE, **self.PRODUCTION})
        neither = self.role("none_c", {"settings.payroll": "edit", "settings.attendance": "edit"})

        for cycles in (late_keys, late_nulls):  # the late keys: either group is enough
            for headers in (late, production, both):
                self.assertAllowed({"prodCycles": cycles}, headers, str(cycles))
            self.assertDenied({"prodCycles": cycles}, neither)
        for cycles in (period_keys, both_kinds, both_kinds_split):  # a period key needs Production Payroll
            self.assertDenied({"prodCycles": cycles}, late, label=str(cycles))
            self.assertDenied({"prodCycles": cycles}, neither, label=str(cycles))
            self.assertAllowed({"prodCycles": cycles}, production, str(cycles))
            self.assertAllowed({"prodCycles": cycles}, both, str(cycles))
        # a key nobody knows is treated as a production one: the late-only role is refused, the other role gets as far as the
        # validation (a 400 naming the key)
        for cycles in (unknown_inner, not_an_object):
            self.assertDenied({"prodCycles": cycles}, late, label=str(cycles))
            self.assertEqual(self.put({"prodCycles": cycles}, production).status_code, 400, str(cycles))
        # an empty or malformed value needs what it always needed
        for value in ({}, [], "x", None, {"weekly": {}}):
            self.assertDenied({"prodCycles": value}, late, label=str(value))

    def test_a_late_only_role_saves_the_late_part_without_touching_the_period_part(self):
        production = self.role("p_seed", self.PRODUCTION)
        self.assertAllowed(
            {"prodCycles": {"weekly": {"weekStart": "wednesday", "anchorDate": "2026-01-07"}}}, production
        )
        late = self.role("l_seed", self.LATE)
        self.assertAllowed({"prodCycles": {"weekly": {"lateFreeAllowance": 2}}}, late)
        stored = PayrollSettings.get().prod_cycles
        self.assertEqual(
            stored["weekly"], {"weekStart": "wednesday", "anchorDate": "2026-01-07", "lateFreeAllowance": 2}
        )

    def test_a_branch_login_keeps_the_branch_overlay_and_the_company_wide_guard(self):
        branch = Branch.objects.create(name="Group Unit")
        headers = _login("br_late", self.LATE, branch)
        self.assertAllowed({"prodLateDetectionEnabled": True, "prodLateFreeAllowance": 1}, headers)
        self.assertFalse(PayrollSettings.get().prod_late_detection_enabled)  # the company row is untouched
        r = self.put({"permissionFreeAllowance": 3}, headers)  # still a company-wide rule
        self.assertEqual((r.status_code, r.json()["error"]), (403, "company_wide_rule"))


# ─────────────────────────────────────────────────────────────────────────────
#  Slab cleaners: 400, never 500
# ─────────────────────────────────────────────────────────────────────────────

HUGE = "9" * 5000  # more digits than Python converts to an int


class SlabCleanerHardeningTests(TestCase):
    def setUp(self):
        self.admin = _admin()
        PayrollSettings.get()

    def put_raw(self, raw: str):
        return self.client.put(SETTINGS, raw, content_type="application/json", **self.admin)

    def put(self, body):
        return self.put_raw(json.dumps(body))

    def refused(self, body_or_raw, label=""):
        r = self.put_raw(body_or_raw) if isinstance(body_or_raw, str) else self.put(body_or_raw)
        self.assertEqual(r.status_code, 400, (label, str(body_or_raw)[:120], r.content[:200]))
        return r

    def test_the_permission_cleaner_returns_a_problem_for_absurd_numbers(self):
        for row in (
            {"fromPermissions": HUGE, "deductionShifts": 1},
            {"fromPermissions": "1" + "0" * 4300, "deductionShifts": 1},
            {"fromPermissions": 1, "deductionShifts": HUGE},
            {"fromPermissions": 1, "deductionShifts": "1" + "0" * 4300},
            {"fromPermissions": 10**400, "deductionShifts": 1},
            {"fromPermissions": 1, "deductionShifts": 10**400},
            {"fromPermissions": float("inf"), "deductionShifts": 1},
            {"fromPermissions": float("nan"), "deductionShifts": 1},
            {"fromPermissions": 1e300, "deductionShifts": 1},
            {"fromPermissions": 1, "deductionShifts": float("nan")},
            # not numbers anybody typed
            {"fromPermissions": "1_0", "deductionShifts": 1},
            {"fromPermissions": "1e1", "deductionShifts": 1},
            {"fromPermissions": "١٢", "deductionShifts": 1},  # Arabic-Indic digits
            {"fromPermissions": " ", "deductionShifts": 1},
            {"fromPermissions": 1, "deductionShifts": "1_0"},
            {"fromPermissions": 1, "deductionShifts": "1e1"},
            {"fromPermissions": 1, "deductionShifts": "١"},
            {"fromPermissions": 1, "deductionShifts": "Infinity"},
            {"fromPermissions": 1, "deductionShifts": "-Infinity"},
            {"fromPermissions": 1, "deductionShifts": "0x10"},
            {"fromPermissions": 1, "deductionShifts": "1,5"},
            {"fromPermissions": 1, "deductionShifts": {"a": 1}},
        ):
            cleaned, problem = clean_permission_slabs([row])  # must not raise
            self.assertIsNone(cleaned, row)
            self.assertTrue(problem, row)

    def test_the_permission_cleaner_still_accepts_what_people_type(self):
        rows = [
            {"fromPermissions": " 3 ", "deductionShifts": " 0.5 "},
            {"fromPermissions": "007", "deductionShifts": "1"},
            {"fromPermissions": 4, "deductionShifts": "12.34"},
            {"fromPermissions": 5.0, "deductionShifts": 0},
            {"fromPermissions": 6, "deductionShifts": "-0"},
        ]
        cleaned, problem = clean_permission_slabs(rows)
        self.assertIsNone(problem)
        self.assertEqual([r["fromPermissions"] for r in cleaned], [3, 4, 5, 6, 7])
        self.assertEqual([r["deductionShifts"] for r in cleaned], [0.5, 12.34, 0.0, 0.0, 1.0])
        self.assertEqual(str(cleaned[3]["deductionShifts"]), "0.0")  # never -0.0

    def test_the_permission_slab_save_is_a_400_for_a_huge_digit_string(self):
        for rows in (
            [{"fromPermissions": HUGE, "deductionShifts": 1}],
            [{"fromPermissions": 1, "deductionShifts": HUGE}],
            [{"fromPermissions": "1_0", "deductionShifts": 1}],
            [{"fromPermissions": 1, "deductionShifts": "1e1"}],
        ):
            self.refused({"companyName": "Should Not Stick", "permissionDeductionSlabs": rows})
        raw = '{"companyName": "Should Not Stick", "permissionDeductionSlabs": [{"fromPermissions": 1, "deductionShifts": 1e999}]}'
        self.refused(raw, "1e999")
        self.assertNotEqual(PayrollSettings.get().company_name, "Should Not Stick")
        self.assertEqual(PayrollSettings.get().permission_deduction_slabs, [])

    def test_the_late_slab_saves_are_a_400_for_absurd_numbers_and_store_nothing(self):
        before_staff = PayrollSettings.get().late_deduction_slabs
        for key in ("lateDeductionSlabs", "prodLateDeductionSlabs"):
            for row in (
                {"fromLates": HUGE, "deductionShifts": 1},
                {"fromLates": 1, "deductionShifts": HUGE},
                {"fromLates": 1, "deductionShifts": "nan"},
                {"fromLates": 1, "deductionShifts": "inf"},
                {"fromLates": 1, "deductionShifts": "-inf"},
                {"fromLates": "inf", "deductionShifts": 1},
                {"fromLates": 10**400, "deductionShifts": 1},
                {"fromLates": 1, "deductionShifts": 10**400},
            ):
                self.refused({"companyName": "Should Not Stick", key: [row]}, f"{key} {str(row)[:60]}")
            for raw_row in (
                '{"fromLates": 1e999, "deductionShifts": 1}',
                '{"fromLates": 1, "deductionShifts": 1e999}',
                '{"fromLates": -1e999, "deductionShifts": 1}',
                '{"fromLates": 1, "deductionShifts": -1e999}',
            ):
                self.refused(f'{{"companyName": "Should Not Stick", "{key}": [{raw_row}]}}', f"{key} {raw_row}")
        row = PayrollSettings.get()
        self.assertNotEqual(row.company_name, "Should Not Stick")
        self.assertEqual(row.late_deduction_slabs, before_staff)
        self.assertEqual(row.prod_late_deduction_slabs, [])

    def test_the_late_slab_saves_still_accept_what_they_always_accepted(self):
        r = self.put(
            {
                "lateDeductionSlabs": [
                    {"fromLates": "6", "deductionShifts": "0.5"},
                    {"fromLates": 3, "deductionShifts": 0.25},
                ],
                "prodLateDeductionSlabs": [{"fromLates": 2, "deductionShifts": 1}],
            }
        )
        self.assertEqual(r.status_code, 200, r.content)
        row = PayrollSettings.get()
        self.assertEqual(
            row.late_deduction_slabs,
            [{"fromLates": 3, "deductionShifts": 0.25}, {"fromLates": 6, "deductionShifts": 0.5}],
        )
        self.assertEqual(row.prod_late_deduction_slabs, [{"fromLates": 2, "deductionShifts": 1.0}])

    def test_the_cycle_late_rules_are_a_400_for_absurd_numbers(self):
        for cycles in (
            {"weekly": {"lateFreeAllowance": 10**400}},
            {"weekly": {"lateFreeAllowance": float("inf")}},
            {"weekly": {"lateFreeAllowance": HUGE}},
            {"weekly": {"lateFreeAllowance": "1_0"}},
            {"weekly": {"lateSlabs": [{"fromLates": HUGE, "deductionShifts": 1}]}},
            {"weekly": {"lateSlabs": [{"fromLates": 1, "deductionShifts": HUGE}]}},
            {"weekly": {"lateSlabs": [{"fromLates": 10**400, "deductionShifts": 1}]}},
            {"weekly": {"lateSlabs": [{"fromLates": 1, "deductionShifts": 10**400}]}},
            {"weekly": {"lateSlabs": [{"fromLates": "nan", "deductionShifts": 1}]}},
            {"weekly": {"lateSlabs": [{"fromLates": 1, "deductionShifts": "nan"}]}},
        ):
            self.refused({"companyName": "Should Not Stick", "prodCycles": cycles}, str(cycles)[:80])
        self.refused(
            '{"companyName": "Should Not Stick", "prodCycles": {"weekly": {"lateFreeAllowance": 1e999}}}', "1e999"
        )
        self.refused(
            '{"companyName": "Should Not Stick", "prodCycles": {"weekly": {"lateSlabs": [{"fromLates": 1e999, "deductionShifts": 1}]}}}',
            "1e999 slab",
        )
        self.assertNotEqual(PayrollSettings.get().company_name, "Should Not Stick")
        self.assertIsNone(PayrollSettings.get().prod_cycles)

    def test_the_other_numeric_settings_are_a_400_for_a_huge_digit_string_too(self):
        for body in (
            {"payDay": HUGE},
            {"permissionFreeAllowance": HUGE},
            {"permissionMonthlyCap": HUGE},
            {"lateFreeAllowance": HUGE},
            {"bonusPercent": HUGE},
            {"prodBonusWageCeiling": HUGE},
            {"defaultSalaryPerShift": HUGE},
            {"prodLateFreeAllowance": HUGE},
        ):
            self.refused({"companyName": "Should Not Stick", **body}, str(body)[:60])
        self.assertNotEqual(PayrollSettings.get().company_name, "Should Not Stick")


# ─────────────────────────────────────────────────────────────────────────────
#  The statutory Late Detection - Salary Impact report
# ─────────────────────────────────────────────────────────────────────────────


def _report(client, report_id, **params):
    r = client.get(f"/api/reports/run/{report_id}", params, **_admin())
    assert r.status_code == 200, (report_id, params, r.content[:400])
    return r.json()


def _by_code(body):
    return {row["employeeCode"]: row for row in body["rows"] if row.get("employeeCode")}


def _tile(body, label):
    return next(t["value"] for t in body["summary"] if t["label"] == label)


class StatutoryLateReportTests(TestCase):
    """late-salary-impact reads the figures frozen on the slips: with the switch ON it must list and count a slip whose only
    deduction is the permission one, and carry every permission figure of the slip."""

    @classmethod
    def setUpTestData(cls):
        _on(free=0, slabs=SLABS)
        # PERM: six approved permissions, nobody late: excess 3, billable 3 -> slab 3 = 0.5 shift = 500, pool total 0
        cls.perm = _scenario(_staff("SL_PERM"), perms=6)
        # BOTH: 6 plain lates (3 billable = 0.25 shift = 250) + 4 approved permissions (excess 1 = 0.25 shift = 250)
        cls.both = _scenario(_staff("SL_BOTH"), late=6, perms=4)
        # CLEAN: nothing at all
        cls.clean = _scenario(_staff("SL_CLEAN"))
        cls.perm_slip, cls.both_slip, cls.clean_slip = _slip(cls.perm), _slip(cls.both), _slip(cls.clean)

    def run_report(self, **params):
        return _report(self.client, "late-salary-impact", period="2026-02", **params)

    def test_the_slips_are_what_we_expect(self):
        ded = _ded(self.perm_slip)
        self.assertEqual(
            (ded["lateSummary"]["totalLateCount"], ded["lateShiftPenalty"], ded["permissionPenalty"]), (0, 0.0, 500.0)
        )
        self.assertEqual(self.perm_slip.other_deductions, Decimal("500.00"))
        self.assertEqual(self.both_slip.other_deductions, Decimal("500.00"))
        self.assertEqual(self.clean_slip.other_deductions, Decimal("0.00"))

    def test_a_slip_whose_only_deduction_is_the_permission_one_is_listed_by_default(self):
        body = self.run_report()  # minLates defaults to "1 or more lates"
        rows = _by_code(body)
        self.assertIn("SL_PERM", rows)
        self.assertNotIn("SL_CLEAN", rows)  # nothing to show
        row = rows["SL_PERM"]
        self.assertEqual(row["totalLateCount"], 0)
        self.assertEqual(row["lateDeductionAmount"], float(self.perm_slip.other_deductions))
        self.assertEqual(row["shiftDeductions"], 0.5)
        self.assertEqual(
            (row["permissionPricedCount"], row["permissionBillableCount"], row["permissionDeduction"]), (3, 3, 500.0)
        )
        # the summary counts it: late deduction, shifts, the person and the average per deducted employee
        self.assertEqual(_tile(body, "Late deduction"), 1000.0)  # 500 (permissions only) + 500 (SL_BOTH)
        self.assertEqual(_tile(body, "Shifts deducted"), 1.0)  # 0.5 + (0.25 late + 0.25 permission)
        self.assertEqual(_tile(body, "Average per deducted employee"), 500.0)
        self.assertEqual(_tile(body, "Employees with lates"), 2)

    def test_every_figure_of_the_both_slip_is_carried(self):
        row = _by_code(self.run_report())["SL_BOTH"]
        self.assertEqual(row["totalLateCount"], 6)
        self.assertEqual(row["lateDeductionAmount"], 500.0)  # late 250 + permission 250: the whole other_deductions
        self.assertEqual(row["lateDeductionAmount"], float(self.both_slip.other_deductions))
        self.assertEqual(row["shiftDeductions"], 0.5)  # 0.25 late + 0.25 permission
        self.assertEqual(
            (row["permissionPricedCount"], row["permissionBillableCount"], row["permissionDeduction"]), (1, 1, 250.0)
        )
        self.assertEqual(row["billableLateCount"], 3)

    def test_the_permission_columns_exist_only_when_a_slip_was_priced(self):
        body = self.run_report()
        keys = [c["key"] for c in body["columns"]]
        for key in ("permissionPricedCount", "permissionBillableCount", "permissionDeduction"):
            self.assertIn(key, keys)
        self.assertTrue(any("Permission Deduction Slabs ON" in n for n in body["notes"]))
        self.assertTrue(any("deduction for excess permissions" in n for n in body["notes"]))

    def test_the_other_minimum_filters_and_only_deducted(self):
        everyone = _by_code(self.run_report(minLates="all"))
        self.assertEqual({"SL_PERM", "SL_BOTH", "SL_CLEAN"}, set(everyone))
        # "3 or more lates": the late pool of SL_BOTH reaches it; the permission-only slip still carries a deduction
        three = _by_code(self.run_report(minLates="3"))
        self.assertEqual({"SL_PERM", "SL_BOTH"}, set(three))
        deducted = _by_code(self.run_report(minLates="all", onlyDeducted="true"))
        self.assertEqual({"SL_PERM", "SL_BOTH"}, set(deducted))

    def test_switched_off_the_filter_is_the_one_it_always_was(self):
        # the SAME data priced with the switch OFF: the excess permissions are pool marks, so every deducted slip has a
        # pool total; and a slip below the chosen minimum is still not listed just because it lost money
        _settings(
            permission_pricing_enabled=False,
            late_free_allowance=0,
            late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.25}],
        )
        low = _scenario(_staff("SL_LOW"), late=2)
        _slip(low)
        rows = _by_code(self.run_report(minLates="3"))
        self.assertNotIn("SL_LOW", rows)  # 2 lates cost money (0.25 shift) but are below "3 or more"
        self.assertIn("SL_LOW", _by_code(self.run_report(minLates="1")))
        self.assertIn("SL_LOW", _by_code(self.run_report(minLates="all", onlyDeducted="true")))


class StatutoryLateReportOffTests(TestCase):
    def test_switched_off_the_report_has_no_permission_columns(self):
        _settings(permission_pricing_enabled=False)
        emp = _scenario(_staff("SL_OFF"), late=6, perms=5)
        slip = _slip(emp)
        body = _report(self.client, "late-salary-impact", period="2026-02")
        row = _by_code(body)["SL_OFF"]
        self.assertNotIn("permissionPricedCount", row)
        self.assertEqual(row["lateDeductionAmount"], float(slip.other_deductions))
        self.assertEqual(row["totalLateCount"], 8)  # 6 + 2 excess: the excess permissions are marks in the pool


# ─────────────────────────────────────────────────────────────────────────────
#  Production employees are never permission-priced
# ─────────────────────────────────────────────────────────────────────────────


def _production(code="PRODP", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Worker",
        employment_type="production",
        status="active",
        salary_amount=Decimal("24000.00"),
        salary_per_shift=Decimal("500.00"),
        **kw,
    )


def _production_month(emp, perms=6):
    """A production worker with `perms` approved permissions in February 2026 and every working day present."""
    _present_month(emp, MONTH)
    for n in range(perms):
        EmployeePermission.objects.create(employee=emp, date=WORKING[n], type=MIDDLE, status="approved")
    return emp


class ProductionNeverPricedTests(TestCase):
    def summary(self, emp):
        records = list(AttendanceDayRecord.objects.filter(employee=emp, date__year=YEAR, date__month=MONTH))
        return compute_monthly_shift_summary(
            emp, YEAR, MONTH, Decimal("1000"), records=records, counted_dates=set(WORKING)
        )

    def figures(self, row):
        return (
            row.shift_deductions,
            row.salary_deduction_amount,
            row.permission_overage_count,
            row.permissions_used,
            row.total_late_count,
            row.billable_late_count,
        )

    def test_a_production_summary_with_the_switch_on_equals_the_one_with_the_switch_off(self):
        emp = _production_month(_production())
        _settings(permission_pricing_enabled=False, permission_deduction_slabs=SLABS)
        off = self.figures(self.summary(emp))
        _on(free=0, slabs=SLABS)
        on = self.figures(self.summary(emp))
        self.assertEqual(on, off)
        self.assertEqual(
            on[:2], (Decimal("0.00"), Decimal("0.00"))
        )  # nothing priced: 6 approved, cap 3, free allowance 3

    def test_the_switch_does_change_a_staff_summary_so_the_gate_is_what_keeps_production_out(self):
        staff = _scenario(_staff("STAFFP"), perms=6)
        _on(free=0, slabs=SLABS)
        row = self.summary(staff)
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.50"), Decimal("500.00")))

    def test_the_stored_settings_are_never_touched_by_the_gate(self):
        emp = _production_month(_production())
        _on(free=0, slabs=SLABS)
        self.summary(emp)
        row = PayrollSettings.objects.get(pk=1)
        self.assertTrue(row.permission_pricing_enabled)
        self.assertEqual(row.permission_deduction_slabs, SLABS)

    def test_the_hr_recompute_only_ever_recomputes_staff(self):
        prod = _production_month(_production("PRODRC"))
        staff = _scenario(_staff("STAFFRC"), perms=6)
        _on(free=0, slabs=SLABS)
        r = self.client.post(
            "/api/attendance/compute-shifts",
            json.dumps({"month": MONTH, "year": YEAR}),
            content_type="application/json",
            **_admin(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["employees"], 1)
        self.assertFalse(MonthlyShiftSummary.objects.filter(employee=prod).exists())
        self.assertEqual(MonthlyShiftSummary.objects.get(employee=staff).salary_deduction_amount, Decimal("500.00"))

    def test_the_shift_stats_preview_of_a_production_worker_never_shows_permission_pricing(self):
        emp = _production_month(_production("PRODPV"))
        _on(free=0, slabs=SLABS)
        r = self.client.get(f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(emp))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIs(body["policy"]["permissionPricingEnabled"], False)
        self.assertEqual(body["policy"]["permissionDeductionSlabs"], [])
        summary = body["summary"]
        self.assertIs(summary["permissionPricingEnabled"], False)
        self.assertEqual(
            (
                summary["permissionPricedCount"],
                summary["permissionBillableCount"],
                summary["permissionShiftDeductions"],
            ),
            (0, 0, 0.0),
        )
        self.assertEqual(summary["permissionDeductionAmount"], "0")
        self.assertIsNone(summary["lateShiftDeductions"])
        # and the very same call for a STAFF worker does show it (the gate is the difference)
        staff = _scenario(_staff("STAFFPV"), perms=6)
        again = self.client.get(
            f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(staff)
        ).json()
        self.assertIs(again["policy"]["permissionPricingEnabled"], True)
        self.assertEqual(again["policy"]["permissionDeductionSlabs"], SLABS)
        self.assertEqual(again["summary"]["permissionPricedCount"], 3)

    def test_the_permission_reports_have_no_pool_or_excess_for_a_production_worker(self):
        _production_month(_production("PRODRP"))
        _on(free=0, slabs=SLABS)
        counts = _report(
            self.client,
            "permission-monthly-counts",
            dateFrom="2026-02-01",
            dateTo="2026-02-28",
            employmentType="production",
        )
        row = _by_code(counts)["PRODRP"]
        self.assertEqual(
            (row["totalApproved"], row["excess"]), (6, 0)
        )  # six approved, yet nothing is ever "beyond the cap"
        penalty = _report(self.client, "late-penalty-breakdown", period="2026-02", employmentType="production")
        self.assertNotIn("PRODRP", _by_code(penalty))  # the pool and its deduction are a staff concept


# ─────────────────────────────────────────────────────────────────────────────
#  HR recompute rounds the daily rate like payroll
# ─────────────────────────────────────────────────────────────────────────────


class RecomputeRoundingTests(TestCase):
    """March 2026 has 26 working days: a salary of 10,000 is 384.615384.. a day, stored 384.62. Every shift deduction is priced
    from the ROUNDED rate in payroll, so the recompute button has to pass the rounded one too."""

    def recompute(self, emp):
        r = self.client.post(
            "/api/attendance/compute-shifts",
            json.dumps({"month": 3, "year": YEAR, "employeeId": emp.id}),
            content_type="application/json",
            **_admin(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        return MonthlyShiftSummary.objects.get(employee=emp, year=YEAR, month=3)

    def test_the_recomputed_summary_equals_the_payslip_to_the_paisa_with_the_switch_on(self):
        _on(free=0, slabs=[{"fromPermissions": 1, "deductionShifts": 0.25}])
        emp = _scenario(_staff("RC_ON", salary="10000.00"), late=6, perms=4, month=3)
        slip = _slip(emp, 3)
        self.assertEqual(slip.other_deductions, Decimal("192.32"))  # 96.16 late + 96.16 permission
        summary = self.recompute(emp)
        self.assertEqual(summary.salary_deduction_amount, slip.other_deductions)
        self.assertEqual(summary.shift_deductions, Decimal("0.50"))

    def test_and_with_the_switch_off(self):
        _settings(permission_pricing_enabled=False)
        emp = _scenario(_staff("RC_OFF", salary="10000.00"), late=6, month=3)  # 3 billable = 0.25 shift
        slip = _slip(emp, 3)
        self.assertEqual(slip.other_deductions, Decimal("96.16"))  # 0.25 x 384.62 = 96.155, half-up
        self.assertEqual(self.recompute(emp).salary_deduction_amount, slip.other_deductions)

    def test_an_employee_without_a_salary_gets_shifts_and_no_rupee_figure(self):
        _settings(permission_pricing_enabled=False)
        emp = _scenario(_staff("RC_NOSAL", salary="0"), late=6, month=3)
        summary = self.recompute(emp)
        self.assertEqual(
            (summary.shift_deductions, summary.salary_deduction_amount), (Decimal("0.25"), Decimal("0.00"))
        )


# ─────────────────────────────────────────────────────────────────────────────
#  One scenario whose counts all differ, in every caller
# ─────────────────────────────────────────────────────────────────────────────


class DistinctCountsParityTests(TestCase):
    """Free allowance 1; one day that is late AND carries an excess Morning permission on the same edge; six more approved
    permissions on clean days: approved 7, excess 4, absorbed by the late day 1, priced 3, free used 1, billable 2 -> slab
    1..2 = 0.25 shift = 250. The late pool holds that one day (total 1, inside the free allowance of 3): so
    excess != priced != billable in every caller, and a mix-up between them shows up as a wrong number."""

    @classmethod
    def setUpTestData(cls):
        _on(free=1, slabs=SLABS)
        cls.emp = _scenario(_staff("DP1"), same_in=1, perms=6)
        cls.slip = _slip(cls.emp)
        # a second person with ONLY priced permissions (no late day at all): approved 5 = excess 2 = priced 2, free 1, billable 1
        cls.only = _scenario(_staff("DP_ONLY"), perms=5)
        _slip(cls.only)
        cls.clean = _scenario(_staff("DP_CLEAN"))
        _slip(cls.clean)

    def test_the_slip(self):
        perm = _ded(self.slip)["permissionSummary"]
        self.assertEqual(
            perm,
            {
                "enabled": True,
                "approved": 7,
                "cap": 3,
                "excess": 4,
                "absorbedByLate": 1,
                "priced": 3,
                "freeAllowance": 1,
                "freeUsed": 1,
                "billable": 2,
                "shifts": 0.25,
                "penalty": 250.0,
            },
        )
        late = _ded(self.slip)["lateSummary"]
        self.assertEqual((late["lateInCount"], late["totalLateCount"], late["billableLateCount"]), (1, 1, 0))
        self.assertEqual(self.slip.other_deductions, Decimal("250.00"))

    def test_the_monthly_summary_row(self):
        row = MonthlyShiftSummary.objects.get(employee=self.emp, year=YEAR, month=MONTH)
        self.assertEqual(row.permission_overage_count, 4)  # the plain excess fact, not the priced pool
        self.assertEqual((row.total_late_count, row.billable_late_count), (1, 0))
        self.assertEqual(row.permissions_used, 1)  # the late pool's free allowance used (1 of 3)
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.25"), Decimal("250.00")))

    def test_the_employee_preview(self):
        body = self.client.get(
            f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(self.emp)
        ).json()
        summary = body["summary"]
        self.assertEqual(summary["excessPermissionCount"], 4)
        self.assertEqual(summary["permissionOverageCount"], 4)
        self.assertEqual(summary["permissionPricedCount"], 3)
        self.assertEqual(summary["permissionBillableCount"], 2)
        self.assertEqual((summary["lateInCount"], summary["totalLateCount"]), (1, 1))
        self.assertEqual((summary["lateShiftDeductions"], summary["permissionShiftDeductions"]), (0.0, 0.25))
        self.assertEqual(Decimal(summary["salaryDeductionAmount"]), self.slip.other_deductions)
        self.assertEqual(Decimal(summary["permissionDeductionAmount"]), Decimal("250.00"))

    def test_the_late_reports(self):
        penalty = _by_code(_report(self.client, "late-penalty-breakdown", period="2026-02"))["DP1"]
        self.assertEqual(
            (penalty["excessPermissions"], penalty["permissionPriced"], penalty["permissionBillable"]), (4, 3, 2)
        )
        self.assertEqual((penalty["poolTotal"], penalty["billable"], penalty["permissionShifts"]), (1, 0, 0.25))
        self.assertEqual(penalty["salaryDeduction"], float(self.slip.other_deductions))
        counts = _by_code(_report(self.client, "late-summary-counts", period="2026-02"))["DP1"]
        self.assertEqual(
            (counts["excessPermissions"], counts["permissionPriced"], counts["permissionBillable"]), (4, 3, 2)
        )
        self.assertEqual((counts["poolTotal"], counts["billable"], counts["approvedPermissions"]), (1, 0, 7))

    def test_the_permission_reports(self):
        impact = _by_code(_report(self.client, "permission-excess-salary-impact", period="2026-02"))["DP1"]
        self.assertEqual((impact["approvedPermissions"], impact["excessPermissions"]), (7, 4))
        self.assertEqual(impact["pricedPermissions"], 3)  # priced, not billable (2) and not excess (4)
        self.assertEqual((impact["permissionDeduction"], impact["excessCost"]), (250.0, 250.0))
        counts = _by_code(
            _report(self.client, "permission-monthly-counts", dateFrom="2026-02-01", dateTo="2026-02-28")
        )["DP1"]
        self.assertEqual((counts["totalApproved"], counts["excess"]), (7, 4))

    def test_the_statutory_late_report(self):
        row = _by_code(_report(self.client, "late-salary-impact", period="2026-02", minLates="all"))["DP1"]
        self.assertEqual((row["permissionPricedCount"], row["permissionBillableCount"]), (3, 2))
        self.assertEqual(row["permissionDeduction"], 250.0)
        self.assertEqual((row["totalLateCount"], row["lateDeductionAmount"]), (1, 250.0))
        self.assertEqual(row["shiftDeductions"], 0.25)

    def test_the_insights(self):
        issues = self.client.get(f"/api/payroll/issues?month={MONTH}&year={YEAR}", **_admin()).json()["issues"]
        mine = [i for i in issues if i["employeeCode"] == "DP1"]
        perm = next(i for i in mine if i["code"] == "excess_permission")
        facts = perm["facts"]
        self.assertEqual(
            (
                facts["excessPermissions"],
                facts["absorbedByLate"],
                facts["priced"],
                facts["free"],
                facts["billable"],
            ),
            (4, 1, 3, 1, 2),
        )
        self.assertEqual(facts["shiftDeductions"], 0.25)
        self.assertEqual(perm["impact"]["amount"], 250.0)
        self.assertFalse([i for i in mine if i["code"] == "late_penalty"])  # the late pool costs nothing here

    # ── filters, tiles and the OFF shape of the day-level / counts reports ──
    def test_only_affected_keeps_a_person_whose_only_cost_is_priced_permissions(self):
        everyone = _by_code(_report(self.client, "late-penalty-breakdown", period="2026-02"))
        self.assertEqual({"DP1", "DP_ONLY", "DP_CLEAN"}, set(everyone))
        affected = _by_code(_report(self.client, "late-penalty-breakdown", period="2026-02", onlyAffected="true"))
        self.assertEqual({"DP1", "DP_ONLY"}, set(affected))  # DP_ONLY has no late day, but 2 priced permissions
        only = affected["DP_ONLY"]
        self.assertEqual((only["poolTotal"], only["permissionPriced"], only["permissionBillable"]), (0, 2, 1))

    def test_only_billable_and_the_over_the_allowance_tile_count_billable_permissions(self):
        body = _report(self.client, "late-summary-counts", period="2026-02", onlyBillable="true")
        self.assertEqual({"DP1", "DP_ONLY"}, set(_by_code(body)))  # billable LATES are 0 for both: billable permissions
        self.assertEqual(_tile(body, "Over the free allowance"), 2)
        everyone = _report(self.client, "late-summary-counts", period="2026-02")
        self.assertEqual(_tile(everyone, "Over the free allowance"), 2)
        self.assertEqual(_tile(everyone, "Permission free allowance / month"), 1)

    def test_switched_off_the_counts_and_permission_reports_keep_exactly_the_old_shape(self):
        _settings(permission_pricing_enabled=False)
        counts = _report(self.client, "late-summary-counts", period="2026-02")
        keys = [c["key"] for c in counts["columns"]]
        self.assertNotIn("permissionPriced", keys)
        self.assertNotIn("permissionBillable", keys)
        self.assertNotIn("permissionPriced", _by_code(counts)["DP1"])
        self.assertNotIn("Permission free allowance / month", [t["label"] for t in counts["summary"]])
        self.assertFalse(any("Permission Deduction Slabs" in n for n in counts["notes"]))
        monthly = _report(self.client, "permission-monthly-counts", dateFrom="2026-02-01", dateTo="2026-02-28")
        self.assertTrue(any("join the late pool" in n for n in monthly["notes"]), monthly["notes"])
        self.assertFalse(any("priced on their own" in n for n in monthly["notes"]))
        impact = _report(self.client, "permission-excess-salary-impact", period="2026-02")
        self.assertIn("columns", impact)  # the slip WAS priced, so its columns are still shown for that month


class DayLevelLateReportsTests(TestCase):
    """The day reports label a flagged day that carries an excess permission on the same edge: merged into the excess permission
    while the switch is OFF, counted in the late pool itself while it is ON."""

    @classmethod
    def setUpTestData(cls):
        # approved 5 (a Morning and an Evening one on the two flagged days + 3 Middle): cap 3, so 2 are excess and each is on
        # the same edge as a flagged day
        cls.emp = _scenario(_staff("DL1"), same_in=1, same_out=1, perms=3)

    def statuses(self, report_id):
        body = _report(self.client, report_id, dateFrom="2026-02-01", dateTo="2026-02-28")
        return [r["poolStatus"] for r in body["rows"] if r.get("employeeCode") == "DL1"]

    def test_the_late_coming_detail_under_on_counts_the_same_edge_day(self):
        _on(free=0, slabs=SLABS)
        self.assertEqual(self.statuses("late-coming-detail"), ["Counted"])

    def test_the_early_out_report_under_on_counts_the_same_edge_day(self):
        _on(free=0, slabs=SLABS)
        self.assertEqual(self.statuses("early-out"), ["Counted"])

    def test_under_off_the_same_days_are_merged_into_the_excess_permission(self):
        _settings(permission_pricing_enabled=False)
        self.assertEqual(self.statuses("late-coming-detail"), ["Merged with excess permission"])
        self.assertEqual(self.statuses("early-out"), ["Merged with excess permission"])


# ─────────────────────────────────────────────────────────────────────────────
#  Pending / rejected permissions and a flagged non-working day, through the non-slip callers
# ─────────────────────────────────────────────────────────────────────────────


class NonSlipCallerFilterTests(TestCase):
    """1 plain late + 3 approved permissions + 1 pending + 1 rejected permission + a late SUNDAY record (not a working day).
    Late slabs 1 -> 0.25, 2 -> 0.5, free 0; permission slabs ON (1 -> 0.5 shift). Only the plain late counts: 250 on the slip,
    and the monthly summary and the preview must say the same (a pending / rejected permission or a Sunday counted by either
    would show 0.5 / 500 or more)."""

    @classmethod
    def setUpTestData(cls):
        _on(
            free=0,
            slabs=FLAT_HALF,
            late_free_allowance=0,
            late_deduction_slabs=[
                {"fromLates": 1, "deductionShifts": 0.25},
                {"fromLates": 2, "deductionShifts": 0.5},
            ],
        )
        cls.emp = _scenario(_staff("NS1"), late=1, perms=3, extra_records=((SUNDAY, {"is_late": True}),))
        EmployeePermission.objects.create(employee=cls.emp, date=WORKING[10], type=MIDDLE, status="pending")
        EmployeePermission.objects.create(employee=cls.emp, date=WORKING[11], type=MIDDLE, status="rejected")
        cls.slip = _slip(cls.emp)

    def test_the_slip_counts_only_the_plain_late(self):
        ded = _ded(self.slip)
        self.assertEqual((ded["lateSummary"]["totalLateCount"], ded["permissionSummary"]["approved"]), (1, 3))
        self.assertEqual((ded["lateShiftPenalty"], ded["permissionPenalty"]), (250.0, 0.0))

    def test_the_monthly_summary_agrees(self):
        row = MonthlyShiftSummary.objects.get(employee=self.emp, year=YEAR, month=MONTH)
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.25"), Decimal("250.00")))
        self.assertEqual((row.permission_overage_count, row.total_late_count), (0, 1))

    def test_a_direct_recompute_of_the_summary_agrees(self):
        records = list(AttendanceDayRecord.objects.filter(employee=self.emp, date__year=YEAR, date__month=MONTH))
        row = compute_monthly_shift_summary(
            self.emp, YEAR, MONTH, Decimal("1000"), records=records, counted_dates=set(WORKING)
        )
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.25"), Decimal("250.00")))

    def test_the_preview_agrees(self):
        summary = self.client.get(
            f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(self.emp)
        ).json()["summary"]
        self.assertEqual(
            (Decimal(summary["shiftDeductions"]), Decimal(summary["salaryDeductionAmount"])),
            (Decimal("0.25"), Decimal("250.00")),
        )
        self.assertEqual((summary["excessPermissionCount"], summary["lateInCount"]), (0, 1))
        self.assertEqual(summary["permissionPricedCount"], 0)

    def test_the_late_reports_agree(self):
        row = _by_code(_report(self.client, "late-penalty-breakdown", period="2026-02"))["NS1"]
        self.assertEqual((row["poolTotal"], row["excessPermissions"], row["salaryDeduction"]), (1, 0, 250.0))


# ─────────────────────────────────────────────────────────────────────────────
#  Rounding and the no-rate path
# ─────────────────────────────────────────────────────────────────────────────


class RoundingTests(TestCase):
    def test_an_exact_half_paisa_tie_rounds_up_on_the_slip_and_in_the_summary(self):
        """Salary 2,400.48 over February's 24 working days = 100.02 a day; 6 plain lates -> 3 billable -> 0.25 shift ->
        25.005, which half-up makes 25.01 (half-even or round-down would make it 25.00)."""
        _settings(permission_pricing_enabled=False)
        emp = _scenario(_staff("TIE1", salary="2400.48"), late=6)
        slip = _slip(emp)
        self.assertEqual(slip.other_deductions, Decimal("25.01"))
        self.assertEqual(_ded(slip)["lateShiftPenalty"], 25.01)
        row = MonthlyShiftSummary.objects.get(employee=emp, year=YEAR, month=MONTH)
        self.assertEqual(row.salary_deduction_amount, Decimal("25.01"))

    def test_the_permission_line_rounds_half_up_on_its_own(self):
        # 100.02 a day x 0.25 shift = 25.005 for the permission line as well; the two lines are rounded one by one
        _on(free=0, slabs=[{"fromPermissions": 1, "deductionShifts": 0.25}])
        emp = _scenario(_staff("TIE2", salary="2400.48"), late=6, perms=4)
        slip = _slip(emp)
        ded = _ded(slip)
        self.assertEqual((ded["lateShiftPenalty"], ded["permissionPenalty"]), (25.01, 25.01))
        self.assertEqual(slip.other_deductions, Decimal("50.02"))
        self.assertEqual(
            MonthlyShiftSummary.objects.get(employee=emp, year=YEAR, month=MONTH).salary_deduction_amount,
            Decimal("50.02"),
        )

    def test_no_daily_rate_means_shifts_but_no_rupee_figure(self):
        ps = _on(free=0, slabs=SLABS)
        pool = late_pool_summary((), 6, ps)  # approved 6, cap 3: excess 3, billable 3 -> 0.5 shift
        for rate in (None, Decimal("0"), 0):
            pricing = late_pool_pricing(pool, ps, rate)
            self.assertEqual(pricing["permission_shifts"], Decimal("0.5"), rate)
            self.assertEqual(
                (pricing["permission_penalty"], pricing["late_penalty"], pricing["penalty"]), (0, 0, 0), rate
            )
            self.assertEqual(pricing["shifts"], Decimal("0.5"), rate)
        self.assertEqual(late_pool_pricing(pool, ps, Decimal("1000"))["penalty"], Decimal("500.00"))


# ─────────────────────────────────────────────────────────────────────────────
#  The "changed since this payroll was generated" marker of the slab table
# ─────────────────────────────────────────────────────────────────────────────


class SlabTableChangedMarkerTests(TestCase):
    def details(self, slip):
        payroll = slip.employee.payrolls.get(month=MONTH, year=YEAR)
        body = self.client.get(f"/api/payroll/{payroll.id}/details", **_admin()).json()
        return {item["key"]: item for group in body["rules"] for item in group["items"]}

    def test_the_marker_flips_only_when_the_table_prices_the_stored_count_differently(self):
        _on(free=0, slabs=SLABS)
        emp = _scenario(_staff("CH1"), perms=6)  # excess 3, billable 3 -> slab 3 = 0.5 shift (500)
        slip = _slip(emp)
        item = self.details(slip)["permission_slabs"]
        self.assertFalse(item["changed"])
        self.assertIn("3 billable excess permissions cost 0.5 shift", item["applied"])
        # an edit that does not touch row 3 prices the same 3 permissions the same: not changed
        _settings(permission_deduction_slabs=[*SLABS, {"fromPermissions": 20, "deductionShifts": 2}])
        self.assertFalse(self.details(slip)["permission_slabs"]["changed"])
        # an edit that moves row 3 changes what 3 billable permissions cost: changed, with the new price in the detail
        _settings(
            permission_deduction_slabs=[
                {"fromPermissions": 1, "deductionShifts": 0.25},
                {"fromPermissions": 3, "deductionShifts": 1},
            ]
        )
        changed = self.details(slip)["permission_slabs"]
        self.assertTrue(changed["changed"])
        self.assertIn("would take", changed["detail"])
        self.assertIn("1 shift", changed["detail"])
        # the LATE slabs are a different table: editing them never flags the permission one
        _settings(permission_deduction_slabs=SLABS, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 9}])
        items = self.details(slip)
        self.assertFalse(items["permission_slabs"]["changed"])


# ─────────────────────────────────────────────────────────────────────────────
#  The MonthlyShiftSummary column mapping
# ─────────────────────────────────────────────────────────────────────────────


class MonthlySummaryColumnTests(TestCase):
    """Every column of the row the installed My Shift screens read, in an OFF and an ON scenario that includes an early-out day.
    Evening Early-Out detection must be on for the engine to flag one; the manual day records carry the flag directly."""

    def row(self, emp):
        return MonthlyShiftSummary.objects.get(employee=emp, year=YEAR, month=MONTH)

    def test_off(self):
        _settings(permission_pricing_enabled=False, late_free_allowance=3)
        emp = _scenario(_staff("MC_OFF"), late=2, early=2, perms=5)  # pool: 2 + 2 + excess 2 = 6; free 3 -> billable 3
        _slip(emp)
        row = self.row(emp)
        self.assertEqual(row.total_shifts, Decimal("24.00"))  # every working day present, 1 shift each
        self.assertEqual(row.total_late_count, 4)  # late-in AND early-out days (not the excess permissions)
        self.assertEqual(row.permission_overage_count, 2)  # approved 5 - cap 3
        self.assertEqual(row.permissions_used, 3)  # the late pool's free allowance used
        self.assertEqual(row.billable_late_count, 3)
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.25"), Decimal("250.00")))

    def test_on(self):
        _on(free=1, slabs=SLABS, late_free_allowance=3)
        emp = _scenario(_staff("MC_ON"), late=2, early=2, perms=5)  # pool 4 (free 3 -> billable 1: below slab 3 = 0);
        _slip(emp)  # excess 2: priced, free 1, billable 1 -> 0.25 shift
        row = self.row(emp)
        self.assertEqual(row.total_shifts, Decimal("24.00"))
        self.assertEqual(row.total_late_count, 4)
        self.assertEqual(row.permission_overage_count, 2)
        self.assertEqual(row.permissions_used, 3)
        self.assertEqual(row.billable_late_count, 1)
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.25"), Decimal("250.00")))


# ─────────────────────────────────────────────────────────────────────────────
#  The MD demo data prices the way the engine does
# ─────────────────────────────────────────────────────────────────────────────


class MdDemoPricingTests(TestCase):
    """seed_md_demo writes closed payroll months with the engine's own functions. With distinct staff / production bonus values
    and Permission Deduction Slabs ON (cap 0 so every approved permission is excess), its production bonus rows must use the
    PRODUCTION rate and a staff slip's other deductions must be the late penalty plus the permission penalty."""

    @classmethod
    def setUpTestData(cls):
        _settings(
            bonus_percent=Decimal("10"),
            bonus_eligibility_ceiling=Decimal("999999"),  # every staff member is eligible, so staff rows exist
            prod_bonus_percent=Decimal("12"),
            permission_monthly_cap=0,
            permission_pricing_enabled=True,
            permission_free_allowance=0,
            permission_deduction_slabs=[{"fromPermissions": 1, "deductionShifts": 0.25}],
        )
        cls.dir = Path(tempfile.mkdtemp())
        run(*SMALL, manifest_dir=cls.dir)

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_a_production_bonus_row_uses_the_production_rate_and_a_staff_one_the_staff_rate(self):
        rows = list(Bonus.objects.filter(employee__employee_code__startswith="DM-").select_related("employee"))
        production = [b for b in rows if b.employee.employment_type == "production"]
        staff = [b for b in rows if b.employee.employment_type == "staff"]
        self.assertTrue(production and staff, (len(production), len(staff)))
        for b in production:
            self.assertEqual(b.bonus_percent_applied, Decimal("12.00"), b.employee.employee_code)
            self.assertEqual(b.bonus_amount, _d2(b.calculation_base * Decimal("12") / 100), b.employee.employee_code)
        for b in staff:
            self.assertEqual(b.bonus_percent_applied, Decimal("10.00"), b.employee.employee_code)
            self.assertEqual(b.bonus_amount, _d2(b.calculation_base * Decimal("10") / 100), b.employee.employee_code)

    def test_a_staff_slip_carries_the_permission_penalty_in_its_totals(self):
        slips = list(
            SalarySlip.objects.filter(employee__employee_code__startswith="DM-", employee__employment_type="staff")
        )
        self.assertTrue(slips)
        priced = 0
        for slip in slips:
            ded = slip.breakdown_details["deductions"]
            self.assertEqual(ded["permissionSummary"]["enabled"], True, slip.slip_number)
            self.assertEqual(
                slip.other_deductions,
                _d2(Decimal(str(ded["lateShiftPenalty"])) + Decimal(str(ded["permissionPenalty"]))),
            )
            self.assertEqual(
                slip.total_deductions,
                slip.pf_deduction
                + slip.esi_deduction
                + slip.tds_deduction
                + slip.advance_deduction
                + slip.other_deductions,
                slip.slip_number,
            )
            priced += ded["permissionPenalty"] > 0
        self.assertGreater(priced, 0, "no demo slip carries a permission penalty")
