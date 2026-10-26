"""The separate PRODUCTION Bonus (staff keep bonus_percent / bonus_wage_ceiling / bonus_eligibility_ceiling, production has
prod_bonus_percent / prod_bonus_wage_ceiling / prod_bonus_eligibility_ceiling; the financial-year start month stays one
company value) and migrations 0128 (schema) / 0129 (copy of the current bonus values into the production twins).

Financial year 2025-26 (April 2025 - March 2026): twelve slips per employee, so the calculation base is
12 x min(basic, wage ceiling) and every figure below is derived by hand.

Run via: python manage.py test api.tests_prod_bonus -v 2
"""

import importlib
import json
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace

from django.apps import apps as live_apps
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from .growth_views import _calculate_bonus_for_employee, bonus_rules_for
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Bonus,
    Branch,
    BranchSettingsOverride,
    Employee,
    HRUser,
    PayrollSettings,
    SalarySlip,
)
from .payroll_views import _generate_production_payroll
from .user_settings import settings_for_employee

FY = "2025-26"
FY_MONTHS = [(2025, m) for m in range(4, 13)] + [(2026, m) for m in range(1, 4)]
copy_module = importlib.import_module("api.migrations.0129_prod_bonus_copy")


def _admin() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="bonus_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _employee(code, kind, basic, branch=None, **kw) -> Employee:
    """An active employee with a slip for every month of the financial year whose basic is `basic` (a production slip puts
    the whole period pay in `basic`, see growth_views)."""
    fields = (
        {"salary_type": "monthly", "salary_amount": Decimal(basic)}
        if kind == "staff"
        else {"salary_per_shift": Decimal("500.00")}
    )
    emp = Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name=kind.title(),
        employment_type=kind,
        status="active",
        branch=branch,
        **fields,
        **kw,
    )
    for year, month in FY_MONTHS:
        SalarySlip.objects.create(
            employee=emp, month=month, year=year, slip_number=f"BS/{code}/{year}/{month:02d}", basic=Decimal(basic)
        )
    return emp


def _settings(**fields) -> PayrollSettings:
    ps = PayrollSettings.get()
    for key, value in fields.items():
        setattr(ps, key, value)
    ps.save()
    return ps


def _calc(client):
    r = client.get(f"/api/bonus/calculate?financialYear={FY}", **_admin())
    assert r.status_code == 200, r.content
    return {row["employeeCode"]: row for row in r.json()["results"]}


class BonusSplitTests(TestCase):
    """Staff use the staff fields, production the prod_* fields, in the preview, the register and the helper."""

    @classmethod
    def setUpTestData(cls):
        _settings(
            bonus_percent=Decimal("10"),
            bonus_wage_ceiling=Decimal("6000"),
            bonus_eligibility_ceiling=Decimal("25000"),
            prod_bonus_percent=Decimal("15"),
            prod_bonus_wage_ceiling=Decimal("5000"),
            prod_bonus_eligibility_ceiling=Decimal("15000"),
        )
        cls.staff = _employee("BS1", "staff", "10000.00")  # eligible: 10,000 <= 25,000
        cls.staff_high = _employee("BS2", "staff", "16000.00")  # eligible as STAFF (<= 25,000)
        cls.prod = _employee("BP1", "production", "10000.00")  # eligible: 10,000 <= 15,000
        cls.prod_high = _employee("BP2", "production", "16000.00")  # NOT eligible as PRODUCTION (> 15,000)

    def test_the_helper_picks_the_set_by_employment_type(self):
        ps = PayrollSettings.get()
        self.assertEqual(bonus_rules_for(self.staff, ps), (Decimal("10.00"), Decimal("6000.00"), Decimal("25000.00")))
        self.assertEqual(bonus_rules_for(self.prod, ps), (Decimal("15.00"), Decimal("5000.00"), Decimal("15000.00")))

    def test_the_preview_applies_each_class_its_own_rate_ceiling_and_limit(self):
        rows = _calc(self.client)
        # staff: base 12 x min(10,000, 6,000) = 72,000 at 10%
        self.assertEqual(
            (rows["BS1"]["calculationBase"], rows["BS1"]["bonusPercent"], rows["BS1"]["bonusAmount"]),
            (72000.0, 10.0, 7200.0),
        )
        self.assertTrue(rows["BS1"]["eligible"])
        # production: base 12 x min(10,000, 5,000) = 60,000 at 15%
        self.assertEqual(
            (rows["BP1"]["calculationBase"], rows["BP1"]["bonusPercent"], rows["BP1"]["bonusAmount"]),
            (60000.0, 15.0, 9000.0),
        )
        self.assertTrue(rows["BP1"]["eligible"])
        # 16,000 a month: inside the staff limit, outside the production one
        self.assertTrue(rows["BS2"]["eligible"])
        self.assertEqual(rows["BS2"]["bonusAmount"], 7200.0)  # 12 x 6,000 x 10%
        self.assertFalse(rows["BP2"]["eligible"])
        self.assertEqual(rows["BP2"]["bonusAmount"], 0.0)
        self.assertIn("₹15,000 eligibility ceiling", rows["BP2"]["reason"])

    def test_the_generated_register_stores_the_class_rate(self):
        r = self.client.post(
            "/api/bonus/generate", json.dumps({"financialYear": FY}), content_type="application/json", **_admin()
        )
        self.assertEqual(r.status_code, 200, r.content)
        stored = {b.employee.employee_code: b for b in Bonus.objects.select_related("employee")}
        self.assertEqual(sorted(stored), ["BP1", "BS1", "BS2"])  # BP2 is not eligible as production
        self.assertEqual(
            (stored["BS1"].bonus_percent_applied, stored["BS1"].bonus_amount), (Decimal("10.00"), Decimal("7200.00"))
        )
        self.assertEqual(
            (stored["BP1"].bonus_percent_applied, stored["BP1"].bonus_amount), (Decimal("15.00"), Decimal("9000.00"))
        )
        self.assertEqual(stored["BP1"].calculation_base, Decimal("60000.00"))

    def test_changing_one_class_never_changes_the_other(self):
        before = _calc(self.client)
        _settings(bonus_percent=Decimal("20"), bonus_wage_ceiling=Decimal("9999"))
        after = _calc(self.client)
        self.assertEqual(after["BP1"], before["BP1"])  # production did not move
        self.assertEqual(after["BS1"]["bonusPercent"], 20.0)
        _settings(prod_bonus_percent=Decimal("8.33"), prod_bonus_wage_ceiling=Decimal("1000"))
        final = _calc(self.client)
        self.assertEqual(final["BS1"], after["BS1"])  # staff did not move
        self.assertEqual((final["BP1"]["bonusPercent"], final["BP1"]["calculationBase"]), (8.33, 12000.0))

    def test_the_financial_year_start_month_stays_one_company_value(self):
        _settings(bonus_fy_start_month=4)
        base = _calc(self.client)
        _settings(bonus_fy_start_month=1)  # 2025-26 is now Jan 2025 - Dec 2025 for BOTH classes: only 9 slips each
        moved = _calc(self.client)
        self.assertEqual(moved["BS1"]["recordsConsidered"], 9)
        self.assertEqual(moved["BP1"]["recordsConsidered"], 9)
        self.assertEqual(base["BS1"]["recordsConsidered"], 12)

    def test_an_employee_with_no_slips_uses_the_class_limit_on_the_profile_salary(self):
        # no slips: the wage is the profile salary; staff 20,000 <= 25,000 eligible, but a production profile has no salary_amount
        emp = Employee.objects.create(
            employee_code="BS3",
            first_name="No",
            last_name="Slips",
            employment_type="staff",
            status="active",
            salary_amount=Decimal("20000"),
        )
        row = _calculate_bonus_for_employee(emp, FY, PayrollSettings.get())
        self.assertTrue(row["eligible"])
        self.assertEqual((row["calculationBase"], row["bonusAmount"]), (0.0, 0.0))


class BonusBranchOverrideTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        _settings(
            bonus_percent=Decimal("10"),
            prod_bonus_percent=Decimal("15"),
            bonus_wage_ceiling=Decimal("6000"),
            prod_bonus_wage_ceiling=Decimal("5000"),
        )
        cls.unit = Branch.objects.create(name="Bonus Unit A")
        cls.other = Branch.objects.create(name="Bonus Unit B")
        BranchSettingsOverride.objects.create(
            branch=cls.unit, overrides={"prod_bonus_percent": "20", "prod_bonus_wage_ceiling": "4000"}
        )
        BranchSettingsOverride.objects.create(branch=cls.other, overrides={"bonus_percent": "12"})
        cls.prod_a = _employee("BOP_A", "production", "10000.00", branch=cls.unit)
        cls.prod_b = _employee("BOP_B", "production", "10000.00", branch=cls.other)
        cls.staff_a = _employee("BOS_A", "staff", "10000.00", branch=cls.unit)
        cls.staff_b = _employee("BOS_B", "staff", "10000.00", branch=cls.other)

    def test_a_branch_override_of_the_production_fields_applies_to_its_production_people_only(self):
        rows = _calc(self.client)
        # unit A: production rate 20% on a 4,000 ceiling -> 12 x 4,000 x 20% = 9,600
        self.assertEqual((rows["BOP_A"]["bonusPercent"], rows["BOP_A"]["bonusAmount"]), (20.0, 9600.0))
        # unit B overrides only the STAFF rate: its production people follow the company production values
        self.assertEqual((rows["BOP_B"]["bonusPercent"], rows["BOP_B"]["bonusAmount"]), (15.0, 9000.0))
        # staff are untouched by a production override, and follow their own staff override
        self.assertEqual((rows["BOS_A"]["bonusPercent"], rows["BOS_A"]["bonusAmount"]), (10.0, 7200.0))
        self.assertEqual((rows["BOS_B"]["bonusPercent"], rows["BOS_B"]["bonusAmount"]), (12.0, 8640.0))

    def test_the_generated_register_applies_each_units_own_values(self):
        """POST /api/bonus/generate resolves the settings PER EMPLOYEE (settings_for_employee), exactly like the preview: the
        stored percent and amount of a unit with its own production values are that unit's, not the company's."""
        r = self.client.post(
            "/api/bonus/generate", json.dumps({"financialYear": FY}), content_type="application/json", **_admin()
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["generated"], 4)
        stored = {b.employee.employee_code: b for b in Bonus.objects.select_related("employee")}
        self.assertEqual(sorted(stored), ["BOP_A", "BOP_B", "BOS_A", "BOS_B"])
        got = {code: (b.bonus_percent_applied, b.calculation_base, b.bonus_amount) for code, b in stored.items()}
        self.assertEqual(got["BOP_A"], (Decimal("20.00"), Decimal("48000.00"), Decimal("9600.00")))  # 12 x 4,000 at 20%
        self.assertEqual(
            got["BOP_B"], (Decimal("15.00"), Decimal("60000.00"), Decimal("9000.00"))
        )  # company production
        self.assertEqual(got["BOS_A"], (Decimal("10.00"), Decimal("72000.00"), Decimal("7200.00")))  # company staff
        self.assertEqual(got["BOS_B"], (Decimal("12.00"), Decimal("72000.00"), Decimal("8640.00")))  # unit B staff rate
        # and the register says what the preview said
        preview = _calc(self.client)
        for code, (percent, base, amount) in got.items():
            self.assertEqual(
                (preview[code]["bonusPercent"], preview[code]["calculationBase"], preview[code]["bonusAmount"]),
                (float(percent), float(base), float(amount)),
                code,
            )

    def test_the_overlay_reads_the_new_fields_with_the_right_types(self):
        ps = settings_for_employee(self.prod_a)
        self.assertEqual(ps.prod_bonus_percent, Decimal("20"))
        self.assertEqual(ps.prod_bonus_wage_ceiling, Decimal("4000"))
        self.assertEqual(ps.prod_bonus_eligibility_ceiling, Decimal("21000"))  # not overridden: the company value


# ─────────────────────────────────────────────────────────────────────────────
#  The ceilings are applied PER PAYSLIP
# ─────────────────────────────────────────────────────────────────────────────


class ProductionBonusPerPayslipTests(TestCase):
    """A production payslip holds the pay of ONE pay period (Weekly 7 days, BiWeekly 14, Monthly 4 weeks) in `basic`, and the
    bonus applies the wage ceiling to every payslip of the financial year and judges eligibility on the LATEST payslip. So the
    production ceilings mean "per payslip", not "per month": 52 Weekly, 26 BiWeekly or 13 Monthly (four-week) payslips a year.
    The user guide's worked examples are exactly these numbers. Production values: 12% / ceiling 5,000 / limit 15,000."""

    @classmethod
    def setUpTestData(cls):
        _settings(
            prod_bonus_percent=Decimal("12"),
            prod_bonus_wage_ceiling=Decimal("5000"),
            prod_bonus_eligibility_ceiling=Decimal("15000"),
        )

    def worker(self, code, cycle, pay):
        """A production worker paid `pay` for every pay period of the year: 52 / 26 / 13 payslips ending on the Sundays of
        the financial year 2025-26, each stored the way the engine stores it (period dates, the period gross in `basic`,
        month / year = the month the period ENDS in)."""
        days, count, first_end = {
            "weekly": (7, 52, date(2025, 4, 6)),
            "biweekly": (14, 26, date(2025, 4, 13)),
            "monthly": (28, 13, date(2025, 4, 27)),
        }[cycle]
        emp = Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Production",
            employment_type="production",
            status="active",
            salary_per_shift=Decimal("500.00"),
            production_pay_cycle=cycle,
        )
        for n in range(count):
            end = first_end + timedelta(days=days * n)
            SalarySlip.objects.create(
                employee=emp,
                month=end.month,
                year=end.year,
                period_start=end - timedelta(days=days - 1),
                period_end=end,
                pay_cycle=cycle,
                slip_number=f"PS/{code}/{end.isoformat()}",
                basic=Decimal(pay),
                gross_salary=Decimal(pay),
            )
        return _calculate_bonus_for_employee(emp, FY, PayrollSettings.get())

    def test_the_weekly_cycle(self):
        under = self.worker("PW1", "weekly", "2000")  # each weekly payslip is under the ceiling: all of it counts
        self.assertEqual((under["recordsConsidered"], under["calculationBase"]), (52, 104000.0))
        self.assertEqual((under["eligible"], under["bonusAmount"]), (True, 12480.0))  # 104,000 x 12%
        over = self.worker("PW2", "weekly", "6000")  # 6,000 a week: each payslip is cut to the 5,000 ceiling
        self.assertEqual((over["calculationBase"], over["bonusAmount"]), (260000.0, 31200.0))  # 52 x 5,000 x 12%
        self.assertTrue(over["eligible"])  # 6,000 is under the 15,000 limit: a week's pay is judged, not a month's
        self.assertFalse(self.worker("PW3", "weekly", "16000")["eligible"])  # a payslip above the limit is not eligible

    def test_the_biweekly_cycle(self):
        under = self.worker("PB1", "biweekly", "4000")
        self.assertEqual((under["recordsConsidered"], under["calculationBase"]), (26, 104000.0))
        self.assertEqual(under["bonusAmount"], 12480.0)
        over = self.worker("PB2", "biweekly", "7000")  # about 15,000 a month, yet only 5,000 per payslip counts
        self.assertEqual((over["calculationBase"], over["bonusAmount"], over["eligible"]), (130000.0, 15600.0, True))
        gone = self.worker("PB3", "biweekly", "16000")
        self.assertEqual((gone["eligible"], gone["bonusAmount"]), (False, 0.0))
        self.assertIn("exceeds the \u20b915,000 eligibility ceiling", gone["reason"])

    def test_the_monthly_cycle_is_four_weeks_so_thirteen_payslips_a_year(self):
        under = self.worker("PM1", "monthly", "4000")
        self.assertEqual((under["recordsConsidered"], under["calculationBase"]), (13, 52000.0))
        self.assertEqual(under["bonusAmount"], 6240.0)  # 52,000 x 12%
        over = self.worker("PM2", "monthly", "10000")
        self.assertEqual((over["calculationBase"], over["bonusAmount"], over["eligible"]), (65000.0, 7800.0, True))
        self.assertFalse(self.worker("PM3", "monthly", "16000")["eligible"])

    def test_the_same_yearly_pay_gives_a_different_bonus_on_each_cycle(self):
        """The reason the guide says so: about 130,000 a year on three cycles, one ceiling and one rate."""
        weekly = self.worker("PY_W", "weekly", "2500")  # 52 x 2,500
        biweekly = self.worker("PY_B", "biweekly", "5000")  # 26 x 5,000
        monthly = self.worker("PY_M", "monthly", "10000")  # 13 x 10,000
        self.assertEqual(
            (weekly["bonusAmount"], biweekly["bonusAmount"], monthly["bonusAmount"]), (15600.0, 15600.0, 7800.0)
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Production payroll, late and cycles are untouched
# ─────────────────────────────────────────────────────────────────────────────


class ProductionPayrollUnaffectedTests(TestCase):
    def test_bonus_and_permission_settings_change_nothing_in_production_payroll_or_its_late_rules(self):
        ps = _settings(
            prod_late_detection_enabled=True,
            prod_late_free_allowance=0,
            prod_late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}],
        )
        emp = Employee.objects.create(
            employee_code="PUN1",
            first_name="Prod",
            last_name="Unaffected",
            employment_type="production",
            status="active",
            salary_per_shift=Decimal("500.00"),
        )
        start, end = date(2026, 2, 2), date(2026, 2, 8)
        for n in range(2, 9):
            AttendanceDayRecord.objects.create(
                employee=emp,
                date=date(2026, 2, n),
                status="present",
                shifts_earned=Decimal("1.00"),
                is_late=(n == 3),
                source="manual",
            )
        before = _generate_production_payroll(emp, start, end)["slip"]
        _settings(
            prod_bonus_percent=Decimal("20"),
            prod_bonus_wage_ceiling=Decimal("1"),
            bonus_percent=Decimal("1"),
            permission_pricing_enabled=True,
            permission_free_allowance=0,
            permission_deduction_slabs=[{"fromPermissions": 1, "deductionShifts": 1}],
        )
        after = _generate_production_payroll(emp, start, end)["slip"]
        for field in ("gross_salary", "total_deductions", "net_salary", "other_deductions", "late_days"):
            self.assertEqual(getattr(before, field), getattr(after, field), field)
        self.assertEqual(before.breakdown_details["deductions"], after.breakdown_details["deductions"])
        self.assertEqual(ps.prod_late_free_allowance, 0)


# ─────────────────────────────────────────────────────────────────────────────
#  Migration 0129: the copy
# ─────────────────────────────────────────────────────────────────────────────


class CopyHelpersTests(SimpleTestCase):
    def row(self, **values):
        base = {
            "bonus_percent": Decimal("8.33"),
            "bonus_wage_ceiling": Decimal("7000"),
            "bonus_eligibility_ceiling": Decimal("21000"),
            "prod_bonus_percent": Decimal("8.33"),
            "prod_bonus_wage_ceiling": Decimal("7000"),
            "prod_bonus_eligibility_ceiling": Decimal("21000"),
        }
        return SimpleNamespace(**{**base, **values})

    def test_the_universal_row_copies_only_never_edited_twins(self):
        row = self.row(bonus_percent=Decimal("10"), bonus_wage_ceiling=Decimal("9000"))
        changed = copy_module.copy_universal(row)
        self.assertEqual(sorted(changed), ["prod_bonus_percent", "prod_bonus_wage_ceiling"])
        self.assertEqual((row.prod_bonus_percent, row.prod_bonus_wage_ceiling), (Decimal("10"), Decimal("9000")))
        self.assertEqual(
            row.prod_bonus_eligibility_ceiling, Decimal("21000")
        )  # the staff value was the default: no change

    def test_a_twin_that_was_already_edited_is_left_alone_and_a_second_run_changes_nothing(self):
        row = self.row(bonus_percent=Decimal("10"), prod_bonus_percent=Decimal("12"))
        self.assertEqual(copy_module.copy_universal(row), [])
        self.assertEqual(row.prod_bonus_percent, Decimal("12"))
        row = self.row(bonus_percent=Decimal("10"))
        copy_module.copy_universal(row)
        self.assertEqual(copy_module.copy_universal(row), [])  # idempotent

    def test_a_branch_override_mirrors_only_the_bonus_keys_it_sets(self):
        overrides = {"bonus_percent": "11", "pf_rate": "5", "late_free_allowance": 2}
        mirrored = copy_module.copy_override(overrides)
        self.assertEqual(mirrored, {**overrides, "prod_bonus_percent": "11"})
        self.assertEqual(
            overrides, {"bonus_percent": "11", "pf_rate": "5", "late_free_allowance": 2}
        )  # input untouched
        self.assertEqual(copy_module.copy_override(mirrored), mirrored)  # idempotent

    def test_an_existing_production_key_wins_and_no_value_is_invented(self):
        overrides = {"bonus_wage_ceiling": "8000", "prod_bonus_wage_ceiling": "6500"}
        self.assertEqual(copy_module.copy_override(overrides), overrides)
        self.assertEqual(copy_module.copy_override({"pay_day": 7}), {"pay_day": 7})
        self.assertEqual(copy_module.copy_override({}), {})
        self.assertEqual(copy_module.copy_override(None), {})


class CopyForwardsTests(TestCase):
    """The real migration function against the real tables."""

    def test_forwards_copies_the_universal_row_and_every_branch_override_that_sets_a_bonus_key(self):
        _settings(
            bonus_percent=Decimal("10"),
            bonus_wage_ceiling=Decimal("9000"),
            bonus_eligibility_ceiling=Decimal("25000"),
        )
        a, b, c = (Branch.objects.create(name=f"Copy {n}") for n in "ABC")
        BranchSettingsOverride.objects.create(branch=a, overrides={"bonus_percent": "11", "pf_rate": "5"})
        BranchSettingsOverride.objects.create(branch=b, overrides={"pay_day": 9})
        BranchSettingsOverride.objects.create(
            branch=c, overrides={"bonus_wage_ceiling": "8000", "prod_bonus_wage_ceiling": "6500"}
        )
        copy_module.forwards(live_apps, None)
        ps = PayrollSettings.objects.get(pk=1)
        self.assertEqual(
            (ps.prod_bonus_percent, ps.prod_bonus_wage_ceiling, ps.prod_bonus_eligibility_ceiling),
            (Decimal("10.00"), Decimal("9000.00"), Decimal("25000.00")),
        )
        self.assertEqual(
            (ps.bonus_percent, ps.bonus_wage_ceiling, ps.bonus_eligibility_ceiling),
            (Decimal("10.00"), Decimal("9000.00"), Decimal("25000.00")),
        )
        got = {o.branch.name: o.overrides for o in BranchSettingsOverride.objects.select_related("branch")}
        self.assertEqual(got["Copy A"], {"bonus_percent": "11", "pf_rate": "5", "prod_bonus_percent": "11"})
        self.assertEqual(got["Copy B"], {"pay_day": 9})
        self.assertEqual(got["Copy C"], {"bonus_wage_ceiling": "8000", "prod_bonus_wage_ceiling": "6500"})
        # a second run changes nothing, even after HR edited a production value
        ps.prod_bonus_percent = Decimal("13")
        ps.save()
        copy_module.forwards(live_apps, None)
        self.assertEqual(PayrollSettings.objects.get(pk=1).prod_bonus_percent, Decimal("13.00"))
        self.assertEqual(
            {o.branch.name: o.overrides for o in BranchSettingsOverride.objects.select_related("branch")}, got
        )

    def test_a_fresh_install_without_a_settings_row_is_fine(self):
        PayrollSettings.objects.all().delete()
        copy_module.forwards(live_apps, None)  # nothing was ever configured: nothing to copy, nothing invented
        self.assertFalse(PayrollSettings.objects.exists())


class Migration0128And0129UpgradePathTests(TransactionTestCase):
    """The real production upgrade, replayed on the (throwaway) test database: schema at 0127 with a configured bonus ->
    0128 (the columns arrive with database defaults; an OLD backend keeps inserting) -> 0129 (the copy) -> rolled back."""

    SCHEMA = [("api", "0128_permission_slabs_prod_bonus")]
    AFTER = [("api", "0129_prod_bonus_copy")]
    # The state this release was built on: what 0128 itself depends on. Derived, so the name of the migration before it is
    # not repeated here, and the number of the LAST migration of the project never matters.
    BEFORE = [
        dependency
        for dependency in importlib.import_module(
            "api.migrations.0128_permission_slabs_prod_bonus"
        ).Migration.dependencies
        if dependency[0] == "api"
    ]

    def setUp(self):
        # Rolling the schema back to BEFORE un-applies every migration written after this release as well: when one of them
        # cannot be reversed, this test cannot do its job and says why (instead of failing in an unrelated-looking way).
        executor = MigrationExecutor(connection)
        stuck = [
            f"{migration.app_label}.{migration.name}"
            for migration, backwards in executor.migration_plan(self.BEFORE)
            if backwards and not all(operation.reversible for operation in migration.operations)
        ]
        if stuck:
            self.skipTest(f"cannot roll back to {self.BEFORE[0][1]}: {', '.join(stuck)} is not reversible")

    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return MigrationExecutor(connection).loader.project_state(targets).apps

    def tearDown(self):
        # leave the test database at the latest schema whatever happened above
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    def _columns(self):
        with connection.cursor() as cur:
            cur.execute(
                "select column_name, column_default from information_schema.columns "
                "where table_schema = current_schema() and table_name = 'payroll_settings'"
            )
            return dict(cur.fetchall())

    def test_upgrade_copies_the_bonus_values_lets_an_old_backend_insert_and_rolls_back(self):
        old = self._migrate(self.BEFORE)
        Settings = old.get_model("api", "PayrollSettings")
        Branch_ = old.get_model("api", "Branch")
        Override = old.get_model("api", "BranchSettingsOverride")
        Settings.objects.all().delete()
        Settings.objects.create(
            pk=1,
            bonus_percent=Decimal("10"),
            bonus_wage_ceiling=Decimal("9000"),
            bonus_eligibility_ceiling=Decimal("25000"),
        )
        a, b, c = (Branch_.objects.create(name=f"Up {n}") for n in "ABC")
        Override.objects.create(branch=a, overrides={"bonus_percent": "11", "pf_rate": "5"})
        Override.objects.create(branch=b, overrides={"pay_day": 9})
        Override.objects.create(branch=c, overrides={"bonus_wage_ceiling": "8000", "prod_bonus_wage_ceiling": "6500"})
        self.assertNotIn("prod_bonus_percent", self._columns())

        # 0128: only the columns arrive (with database defaults), nothing is copied yet
        self._migrate(self.SCHEMA)
        columns = self._columns()
        for name in (
            "permission_pricing_enabled",
            "permission_free_allowance",
            "permission_deduction_slabs",
            "prod_bonus_percent",
            "prod_bonus_wage_ceiling",
            "prod_bonus_eligibility_ceiling",
        ):
            self.assertIsNotNone(columns.get(name), f"{name} needs a database default")
        with connection.cursor() as cur:
            cur.execute("select prod_bonus_percent, prod_bonus_wage_ceiling from payroll_settings where id = 1")
            self.assertEqual(cur.fetchone(), (Decimal("8.33"), Decimal("7000.00")))

        # an OLD backend instance (it only knows the 0127 model) inserts against the NEW schema
        Settings.objects.create(pk=2, company_name="Old release")
        with connection.cursor() as cur:
            cur.execute(
                "select permission_pricing_enabled, permission_free_allowance, permission_deduction_slabs, "
                "prod_bonus_percent, prod_bonus_wage_ceiling, prod_bonus_eligibility_ceiling "
                "from payroll_settings where id = 2"
            )
            # (the raw cursor hands a jsonb column back as text)
            self.assertEqual(cur.fetchone(), (False, 0, "[]", Decimal("8.33"), Decimal("7000.00"), Decimal("21000.00")))
        Settings.objects.filter(pk=2).delete()

        # 0129: the copy
        new = self._migrate(self.AFTER)
        row = new.get_model("api", "PayrollSettings").objects.get(pk=1)
        self.assertEqual(
            (row.prod_bonus_percent, row.prod_bonus_wage_ceiling, row.prod_bonus_eligibility_ceiling),
            (Decimal("10.00"), Decimal("9000.00"), Decimal("25000.00")),
        )
        self.assertEqual((row.bonus_percent, row.bonus_wage_ceiling), (Decimal("10.00"), Decimal("9000.00")))
        got = {
            o.branch.name: o.overrides
            for o in new.get_model("api", "BranchSettingsOverride").objects.select_related("branch")
        }
        self.assertEqual(got["Up A"], {"bonus_percent": "11", "pf_rate": "5", "prod_bonus_percent": "11"})
        self.assertEqual(got["Up B"], {"pay_day": 9})
        self.assertEqual(got["Up C"], {"bonus_wage_ceiling": "8000", "prod_bonus_wage_ceiling": "6500"})

        # running the copy again changes nothing
        copy_module.forwards(new, None)
        again = new.get_model("api", "PayrollSettings").objects.get(pk=1)
        self.assertEqual(again.prod_bonus_percent, Decimal("10.00"))

        # ...and the release can be rolled back; the staff values are intact
        self._migrate(self.BEFORE)
        columns = self._columns()
        self.assertNotIn("prod_bonus_percent", columns)
        self.assertNotIn("permission_pricing_enabled", columns)
        with connection.cursor() as cur:
            cur.execute("select bonus_percent, bonus_wage_ceiling, bonus_eligibility_ceiling from payroll_settings")
            self.assertEqual(cur.fetchone(), (Decimal("10.00"), Decimal("9000.00"), Decimal("25000.00")))
