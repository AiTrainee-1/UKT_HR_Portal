"""Settings -> Payroll and Production Payroll: range checks on PUT /api/payroll-settings.

A value that cannot be right is refused with a 400 and a message (several used to be a 500: a rate of 1000 does not
fit DECIMAL(5,2)), nothing of the request is saved, every value the Settings page can send still saves, and a value
already stored is accepted again unchanged, so an older page's leftovers never block a save.
"""

from decimal import Decimal

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, BranchSettingsOverride, HRUser, PayrollSettings, Role

SETTINGS = "/api/payroll-settings"


def _hr(username="spay_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


# What the redesigned tab's four Save buttons send (payroll/sections.ts), and the old page's "Save Payroll Settings".
RATES = {
    "staffPayrollRulesEnabled": True,
    "pfRate": 12,
    "esiRate": 0.75,
    "esiApplicableBelow": 21000,
    "prodPayrollRulesEnabled": True,
    "prodPfRate": 12,
    "prodEsiRate": 0.75,
    "prodEsiApplicableBelow": 21000,
    "payDay": 5,
    "bonusFyStartMonth": 4,
    "defaultSalaryPerShift": 300,
}
BONUS = {"bonusPercent": 8.33, "bonusWageCeiling": 7000, "bonusEligibilityCeiling": 21000}
OT = {"otDetectionEnabled": True, "otThresholdMinutes": 60, "otCompensationType": "pay"}
BANDS = [
    {"label": "Low", "minSalary": 0, "maxSalary": 20000, "pfRate": 12, "efRate": 0.75},
    {"label": "High", "minSalary": 20001, "maxSalary": 0, "pfRate": 12, "efRate": 0},
]
OLD_PAGE_RATES = {
    **{k: v for k, v in RATES.items() if k != "bonusFyStartMonth"},
    "prodPfEfEnabled": True,
    "prodPfEfRules": BANDS,
}
PERIOD = {
    "prodPeriodFrequency": "2weeks",
    "prodPeriodStyle": "calendar_month",
    "prodPeriodWeekdayAnchor": None,
    "prodPeriodAnchorDate": None,
    "prodPeriodCustomDays": None,
}
LATE = {
    "prodAttendanceMode": "strict",
    "prodLateDetectionEnabled": True,
    "prodLateFreeAllowance": 3,
    "prodLateDeductionSlabs": [{"fromLates": 3, "deductionShifts": 0.25}],
}


class RangeBase(TestCase):
    def setUp(self):
        self.admin = _hr()
        ps = PayrollSettings.get()
        ps.pf_rate = Decimal("12")
        ps.pay_day = 5
        ps.company_name = "Before Ltd"
        ps.save()

    def put(self, body, headers=None):
        return self.client.put(SETTINGS, body, content_type="application/json", **(headers or self.admin))

    def row(self):
        return PayrollSettings.objects.get(pk=1)

    def assert_refused(self, body, message_part):
        r = self.put({"companyName": "Should Not Stick", **body})
        self.assertEqual(r.status_code, 400, (body, r.content))
        self.assertIn(message_part, r.json()["error"], body)
        ps = self.row()
        self.assertEqual((ps.company_name, ps.pf_rate, ps.pay_day), ("Before Ltd", Decimal("12.00"), 5), body)


class AcceptedValuesTests(RangeBase):
    def test_every_save_button_of_both_tabs_still_saves(self):
        for body in (RATES, BONUS, OT, {"prodPfEfEnabled": True, "prodPfEfRules": BANDS}, OLD_PAGE_RATES, PERIOD, LATE):
            r = self.put(body)
            self.assertEqual(r.status_code, 200, (body, r.content))
        ps = self.row()
        self.assertEqual((ps.pf_rate, ps.esi_rate, ps.pay_day, ps.bonus_fy_start_month), (12, Decimal("0.75"), 5, 4))
        self.assertEqual(ps.prod_pf_ef_rules, BANDS)

    def test_the_edges_of_each_range_are_accepted(self):
        for key, attr, values in (
            ("pfRate", "pf_rate", (0, 100, 12.34, "7.5")),
            ("prodEsiRate", "prod_esi_rate", (0, 100, 3.25)),
            ("esiApplicableBelow", "esi_applicable_below", (0, 99999999.99, "21000.50")),
            ("bonusPercent", "bonus_percent", (0, 8.33, 20, 100)),
            ("bonusWageCeiling", "bonus_wage_ceiling", (0, 99999999.99)),
            ("defaultSalaryPerShift", "default_salary_per_shift", (0, 999999.99)),
            ("payDay", "pay_day", (1, 28, "15")),
            ("bonusFyStartMonth", "bonus_fy_start_month", (1, 12)),
            ("otThresholdMinutes", "ot_threshold_minutes", (0, 1, 1440)),  # 0 is what the old page could send
            ("prodPeriodCustomDays", "prod_period_custom_days", (1, 366, None)),
            ("prodLateFreeAllowance", "prod_late_free_allowance", (0, 366)),
        ):
            for value in values:
                r = self.put({key: value})
                self.assertEqual(r.status_code, 200, (key, value, r.content))
                stored = getattr(self.row(), attr)
                expected = None if value is None else Decimal(str(value))
                self.assertEqual(None if stored is None else Decimal(stored), expected, (key, value))

    def test_every_choice_the_page_offers_is_accepted(self):
        for key, values in (
            ("otCompensationType", ("pay", "relaxation")),
            ("prodPeriodFrequency", ("weekly", "2weeks", "3weeks", "monthly")),
            ("prodPeriodStyle", ("calendar_month", "custom_recurring", "weekday_anchored")),
            ("prodPeriodWeekdayAnchor", ("mon_sat", "sun_sat", None, "")),
            ("prodAttendanceMode", ("strict", "simple")),
        ):
            for value in values:
                if key == "prodPeriodStyle" and value == "weekday_anchored":
                    self.put({"prodPeriodFrequency": "2weeks"})
                r = self.put({key: value})
                self.assertEqual(r.status_code, 200, (key, value, r.content))


class RefusedValuesTests(RangeBase):
    def test_numbers_outside_their_range_are_refused_with_a_message(self):
        for body, message in (
            ({"pfRate": 100.01}, "Staff PF rate must be between 0 and 100, with at most 2 decimals."),
            ({"pfRate": -1}, "Staff PF rate must be between 0 and 100"),
            ({"pfRate": 12.345}, "with at most 2 decimals"),
            ({"esiRate": 150}, "Staff ESI rate must be between 0 and 100"),
            ({"prodPfRate": 101}, "Production PF rate"),
            ({"prodEsiRate": -0.5}, "Production ESI rate"),
            ({"esiApplicableBelow": -5}, "Staff ESI ceiling must be between 0 and 99999999.99"),
            ({"prodEsiApplicableBelow": 100000000}, "Production ESI ceiling"),
            ({"bonusPercent": 120}, "Bonus rate must be between 0 and 100"),
            ({"bonusWageCeiling": -1}, "Bonus wage ceiling"),
            ({"bonusEligibilityCeiling": 123456789}, "Bonus eligibility limit"),
            ({"defaultSalaryPerShift": 1000000}, "Default salary per shift must be between 0 and 999999.99"),
            ({"payDay": 0}, "Salary pay day must be a whole number from 1 to 28."),
            ({"payDay": 29}, "Salary pay day must be a whole number from 1 to 28."),
            ({"payDay": 5.5}, "Salary pay day must be a whole number"),
            ({"payDay": True}, "Salary pay day must be a whole number"),
            ({"bonusFyStartMonth": 0}, "Financial year start month must be a whole number from 1 to 12."),
            ({"bonusFyStartMonth": 13}, "Financial year start month"),
            ({"otThresholdMinutes": -1}, "OT threshold (minutes) must be a whole number from 0 to 1440."),
            ({"otThresholdMinutes": 1441}, "OT threshold (minutes)"),
            ({"prodPeriodCustomDays": 0}, "Custom Days must be a whole number from 1 to 366."),
            ({"prodPeriodCustomDays": 400}, "Custom Days"),
            ({"prodLateFreeAllowance": -1}, "Production free late allowance must be a whole number from 0 to 366."),
            ({"basicPercent": 250}, "Basic % must be between 0 and 100"),
            ({"hraPercent": -1}, "HRA %"),
        ):
            self.assert_refused(body, message)

    def test_values_too_big_for_their_column_are_a_400_not_a_500(self):
        # DECIMAL(5,2) holds at most 999.99, DECIMAL(10,2) at most 99,999,999.99, INTEGER about 2.1 billion.
        for body in (
            {"pfRate": 1000},
            {"bonusPercent": "1e3"},
            {"esiApplicableBelow": 1e11},
            {"payDay": 10**12},
            {"otThresholdMinutes": 2**40},
        ):
            r = self.put(body)
            self.assertEqual(r.status_code, 400, (body, r.content))

    def test_not_a_number_is_refused_rather_than_crashing(self):
        for value in ("NaN", "Infinity", "-Infinity", "sNaN"):
            self.assert_refused({"pfRate": value}, "Staff PF rate")
        self.assert_refused(
            {"prodLateDeductionSlabs": [{"fromLates": 3, "deductionShifts": "nan"}]},
            "Production Late slab values must be finite numbers",
        )
        self.assert_refused(
            {"prodLateDeductionSlabs": [{"fromLates": 3, "deductionShifts": "Infinity"}]},
            "finite numbers",
        )
        # Text in a number box is still the cast's own message.
        self.assert_refused({"payDay": "fifth"}, "Invalid value for payDay")

    def test_unknown_choices_are_refused(self):
        for body, message in (
            ({"otCompensationType": "bonus"}, "OT compensation type must be one of: pay, relaxation."),
            ({"prodPeriodFrequency": "4weeks"}, "Production pay period frequency must be one of: weekly, 2weeks"),
            ({"prodPeriodStyle": "fortnightly"}, "Production period style must be one of"),
            ({"prodPeriodWeekdayAnchor": "tue_sat"}, "Weekday anchor must be one of: mon_sat, sun_sat."),
            ({"prodAttendanceMode": "lenient"}, "Production attendance mode must be one of: strict, simple."),
        ):
            self.assert_refused(body, message)

    def test_monthly_periods_cannot_be_weekday_anchored(self):
        self.assert_refused(
            {
                "prodPeriodStyle": "weekday_anchored",
                "prodPeriodFrequency": "monthly",
                "prodPeriodAnchorDate": "2026-10-05",
            },
            "Monthly frequency cannot be used with Weekday Anchored periods",
        )
        self.assertEqual(self.put({"prodPeriodFrequency": "monthly"}).status_code, 200)
        self.assert_refused({"prodPeriodStyle": "weekday_anchored"}, "Monthly frequency cannot be used")

    def test_pf_ef_rules_are_checked_row_by_row(self):
        good = BANDS[0]
        for rows, message in (
            (["Low band"], "Production PF/EF rule 1: each rule needs a label"),
            ([good, {**good, "label": 5}], "Production PF/EF rule 2: the label must be text."),
            ([{**good, "minSalary": "abc"}], "Min Salary must be a number."),
            ([{**good, "maxSalary": True}], "Max Salary must be a number."),
            ([{**good, "pfRate": 101}], "PF % must be between 0 and 100, with at most 2 decimals."),
            ([{**good, "efRate": -1}], "EF % must be between 0 and 100"),
            ([{**good, "efRate": "NaN"}], "EF % must be a number."),
            ([{**good, "minSalary": 100000000}], "Min Salary must be between 0 and 99999999.99"),
            ([{**good, "minSalary": 5000, "maxSalary": 1000}], "Max Salary must be 0 (no upper limit) or at least"),
        ):
            self.assert_refused({"prodPfEfEnabled": True, "prodPfEfRules": rows}, message)
        self.assertEqual(self.row().prod_pf_ef_rules, [])

    def test_blank_band_values_are_read_as_0_like_payroll_does(self):
        rows = [{"label": None, "minSalary": None, "maxSalary": "", "pfRate": "12", "efRate": 0}]
        self.assertEqual(self.put({"prodPfEfRules": rows}).status_code, 200)
        self.assertEqual(self.row().prod_pf_ef_rules, rows)

    def test_one_bad_value_saves_nothing_of_the_request(self):
        r = self.put({**RATES, "pfRate": 10, "payDay": 31})
        self.assertEqual(r.status_code, 400)
        ps = self.row()
        self.assertEqual((ps.pf_rate, ps.pay_day, ps.staff_payroll_rules_enabled), (Decimal("12.00"), 5, False))


class StoredValuesTests(RangeBase):
    def test_a_value_already_stored_saves_again_unchanged(self):
        # As an older page could have stored them: outside today's ranges, but they are what is there.
        PayrollSettings.objects.filter(pk=1).update(
            pay_day=31,
            pf_rate=Decimal("150"),
            bonus_percent=Decimal("5.555"),
            ot_threshold_minutes=0,
            ot_compensation_type="weird",
            prod_period_style="weekday_anchored",
            prod_period_frequency="monthly",
            prod_pf_ef_rules=[{"label": 5, "minSalary": "abc"}],
        )
        stored = self.row()
        for body in (
            {**OLD_PAGE_RATES, "pfRate": 150, "payDay": 31, "prodPfEfRules": stored.prod_pf_ef_rules},
            {"bonusPercent": float(stored.bonus_percent), "bonusWageCeiling": 7000},
            {"otDetectionEnabled": False, "otThresholdMinutes": 0, "otCompensationType": "weird"},
            {
                "prodPeriodStyle": "weekday_anchored",
                "prodPeriodFrequency": "monthly",
                "prodPeriodAnchorDate": "2026-10-05",
            },
        ):
            r = self.put(body)
            self.assertEqual(r.status_code, 200, (body, r.content))
        ps = self.row()
        self.assertEqual((ps.pay_day, ps.pf_rate, ps.ot_threshold_minutes), (31, Decimal("150.00"), 0))
        self.assertFalse(ps.ot_detection_enabled)

        # Changing one of them is judged again.
        r = self.put({"payDay": 30})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Salary pay day", r.json()["error"])
        self.assertEqual(self.put({"payDay": 28}).status_code, 200)

    def test_a_branch_login_gets_the_same_checks_and_stores_nothing_when_refused(self):
        north = Branch.objects.create(name="North")
        role = Role.objects.create(name="North Payroll", permissions={"settings.payroll": "edit"})
        who = _hr("spay_north", super_admin=False, role=role, branch=north)
        r = self.put({"payDay": 31, "pfRate": 10}, who)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(BranchSettingsOverride.objects.filter(branch=north).exists())

        r = self.put({"payDay": 10, "pfRate": 10}, who)
        self.assertEqual(r.status_code, 200)
        overrides = BranchSettingsOverride.objects.get(branch=north).overrides
        self.assertEqual((overrides["pay_day"], Decimal(str(overrides["pf_rate"]))), (10, Decimal("10")))
        self.assertEqual((self.row().pay_day, self.row().pf_rate), (5, Decimal("12.00")))
