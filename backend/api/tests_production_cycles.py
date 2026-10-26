"""
Production pay cycles: Weekly, BiWeekly and Monthly (four weeks).

Covers the period maths, the per-cycle settings, the engine's cycle awareness (stamp, monthly equivalent, late rules),
assigning production employees to a cycle, and the per-cycle payroll endpoints: a cycle's page only ever generates for
the people assigned to it, never overwrites what exists, and can generate one employee at a time.

Calendar used throughout (all in 2026): Monday 2 February starts every cycle -- Weekly weeks run Mon-Sun, BiWeekly
periods are 2-15 Feb and 16 Feb-1 Mar, the four-week Monthly period is 2 Feb-1 Mar. "Today" is 10 March, so every
February period has ended.

Run via: python manage.py test api.tests_production_cycles -v 2
"""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase

from .jwt_utils import sign_token
from .models import AttendanceDayRecord, Branch, Employee, HRUser, Payroll, PayrollSettings, Role, SalarySlip
from .payroll_views import _generate_production_payroll, late_shift_deduction
from .production_cycles import (
    CYCLES,
    WEEKDAYS,
    cycle_config,
    cycle_late_rules,
    merge_prod_cycles,
    normalize_cycle,
    normalize_week_start,
    prod_cycles_response,
)
from .production_period import (
    InvalidPeriodConfig,
    cycle_anchor,
    is_cycle_period,
    next_cycle_period,
    recent_cycle_periods,
    resolve_cycle_period,
)

TODAY = date(2026, 3, 10)
MON = date(2026, 2, 2)


def _today():
    """Freezes 'today' in every module that decides whether a period has ended."""
    return (
        patch("api.production_period.ist_today", return_value=TODAY),
        patch("api.production_payroll_views.ist_today", return_value=TODAY),
    )


def _settings(**fields) -> PayrollSettings:
    ps = PayrollSettings.get()
    for key, value in fields.items():
        setattr(ps, key, value)
    ps.save()
    return ps


def _cycles(**per_cycle) -> dict:
    return {name: dict(values) for name, values in per_cycle.items()}


ALL_FROM_MON = _cycles(
    weekly={"weekStart": "monday"},
    biweekly={"weekStart": "monday", "anchorDate": "2026-02-02"},
    monthly={"weekStart": "monday", "anchorDate": "2026-02-02"},
)


class _Ps:
    """The slice of PayrollSettings the pure helpers read."""

    def __init__(self, prod_cycles=None, allowance=3, slabs=None):
        self.prod_cycles = prod_cycles
        self.prod_late_free_allowance = allowance
        self.prod_late_deduction_slabs = slabs if slabs is not None else []


# ─────────────────────────────────────────────────────────────────────────────
#  Period maths
# ─────────────────────────────────────────────────────────────────────────────


class CyclePeriodTests(SimpleTestCase):
    def test_weekly_weeks_run_monday_to_sunday_with_no_date_set(self):
        ps = _Ps(_cycles(weekly={"weekStart": "monday"}))
        for day in (date(2026, 2, 2), date(2026, 2, 5), date(2026, 2, 8)):
            self.assertEqual(resolve_cycle_period(day, ps, "weekly"), (date(2026, 2, 2), date(2026, 2, 8)))
        self.assertEqual(resolve_cycle_period(date(2026, 2, 9), ps, "weekly"), (date(2026, 2, 9), date(2026, 2, 15)))

    def test_weekly_with_nothing_saved_starts_on_monday(self):
        self.assertEqual(
            resolve_cycle_period(date(2026, 2, 4), _Ps(None), "weekly"), (date(2026, 2, 2), date(2026, 2, 8))
        )

    def test_sunday_start_weeks_run_sunday_to_saturday(self):
        ps = _Ps(_cycles(weekly={"weekStart": "sunday"}))
        self.assertEqual(resolve_cycle_period(date(2026, 2, 4), ps, "weekly"), (date(2026, 2, 1), date(2026, 2, 7)))
        self.assertEqual(resolve_cycle_period(date(2026, 2, 8), ps, "weekly"), (date(2026, 2, 8), date(2026, 2, 14)))

    def test_biweekly_pairs_weeks_from_the_first_period_start(self):
        ps = _Ps(ALL_FROM_MON)
        self.assertEqual(resolve_cycle_period(date(2026, 2, 10), ps, "biweekly"), (date(2026, 2, 2), date(2026, 2, 15)))
        self.assertEqual(resolve_cycle_period(date(2026, 2, 16), ps, "biweekly"), (date(2026, 2, 16), date(2026, 3, 1)))
        # before the anchor the periods continue backwards
        self.assertEqual(resolve_cycle_period(date(2026, 2, 1), ps, "biweekly"), (date(2026, 1, 19), date(2026, 2, 1)))

    def test_monthly_is_four_whole_weeks_not_a_calendar_month(self):
        ps = _Ps(ALL_FROM_MON)
        self.assertEqual(resolve_cycle_period(date(2026, 2, 20), ps, "monthly"), (date(2026, 2, 2), date(2026, 3, 1)))
        self.assertEqual(resolve_cycle_period(date(2026, 3, 2), ps, "monthly"), (date(2026, 3, 2), date(2026, 3, 29)))

    def test_a_first_period_start_on_the_wrong_weekday_is_moved_back_to_the_start_weekday(self):
        ps = _Ps(_cycles(biweekly={"weekStart": "monday", "anchorDate": "2026-02-04"}))  # a Wednesday
        self.assertEqual(cycle_anchor(cycle_config(ps, "biweekly")), date(2026, 2, 2))
        sunday = _Ps(_cycles(biweekly={"weekStart": "sunday", "anchorDate": "2026-02-04"}))
        self.assertEqual(cycle_anchor(cycle_config(sunday, "biweekly")), date(2026, 2, 1))

    def test_a_week_may_start_on_any_weekday_and_ends_on_the_day_before_it_comes_round(self):
        # 4 February 2026 is a Wednesday: the week that holds it, for each weekday weeks may start on
        starts = {
            "monday": date(2026, 2, 2),
            "tuesday": date(2026, 2, 3),
            "wednesday": date(2026, 2, 4),
            "thursday": date(2026, 1, 29),
            "friday": date(2026, 1, 30),
            "saturday": date(2026, 1, 31),
            "sunday": date(2026, 2, 1),
        }
        self.assertEqual(list(starts), list(WEEKDAYS))
        for week_start, start in starts.items():
            ps = _Ps(_cycles(weekly={"weekStart": week_start}))
            self.assertEqual(
                resolve_cycle_period(date(2026, 2, 4), ps, "weekly"), (start, start + timedelta(days=6)), week_start
            )
            self.assertEqual(start.weekday(), WEEKDAYS.index(week_start), week_start)

    def test_every_start_weekday_gives_back_to_back_seven_day_weeks_with_no_gap_or_overlap(self):
        for number, week_start in enumerate(WEEKDAYS):
            ps = _Ps(_cycles(weekly={"weekStart": week_start}))
            day = date(2026, 6, 1)
            for _ in range(6):
                start, end = resolve_cycle_period(day, ps, "weekly")
                self.assertEqual((start.weekday(), (end - start).days), (number, 6), week_start)
                self.assertTrue(start <= day <= end, week_start)
                day = end + timedelta(days=1)  # the next week must begin on exactly this day

    def test_biweekly_and_monthly_count_from_the_first_period_start_on_any_start_weekday(self):
        # Friday weeks; a first period start of Wednesday 4 February is moved back to Friday 30 January
        ps = _Ps(
            _cycles(
                biweekly={"weekStart": "friday", "anchorDate": "2026-02-04"},
                monthly={"weekStart": "friday", "anchorDate": "2026-02-04"},
            )
        )
        self.assertEqual(cycle_anchor(cycle_config(ps, "biweekly")), date(2026, 1, 30))
        self.assertEqual(
            resolve_cycle_period(date(2026, 2, 10), ps, "biweekly"), (date(2026, 1, 30), date(2026, 2, 12))
        )
        self.assertEqual(
            resolve_cycle_period(date(2026, 2, 13), ps, "biweekly"), (date(2026, 2, 13), date(2026, 2, 26))
        )
        self.assertEqual(resolve_cycle_period(date(2026, 2, 20), ps, "monthly"), (date(2026, 1, 30), date(2026, 2, 26)))
        self.assertEqual(resolve_cycle_period(date(2026, 2, 27), ps, "monthly"), (date(2026, 2, 27), date(2026, 3, 26)))

    def test_a_period_of_another_start_weekday_is_not_one_of_the_cycles_periods(self):
        ps = _Ps(_cycles(weekly={"weekStart": "thursday"}))
        self.assertTrue(is_cycle_period(date(2026, 2, 5), date(2026, 2, 11), ps, "weekly"))  # Thursday to Wednesday
        self.assertFalse(is_cycle_period(date(2026, 2, 2), date(2026, 2, 8), ps, "weekly"))  # a Monday week

    def test_biweekly_and_monthly_need_a_first_period_start_but_weekly_does_not(self):
        ps = _Ps(_cycles(weekly={}, biweekly={"weekStart": "monday"}))
        resolve_cycle_period(MON, ps, "weekly")
        for cycle, label in (("biweekly", "BiWeekly"), ("monthly", "Monthly")):
            with self.assertRaisesMessage(InvalidPeriodConfig, f"Set the first period start date for {label}"):
                resolve_cycle_period(MON, ps, cycle)

    def test_a_period_is_exactly_one_of_the_cycles_periods_or_not(self):
        ps = _Ps(ALL_FROM_MON)
        self.assertTrue(is_cycle_period(date(2026, 2, 2), date(2026, 2, 15), ps, "biweekly"))
        self.assertFalse(is_cycle_period(date(2026, 2, 2), date(2026, 2, 8), ps, "biweekly"))  # one week
        self.assertFalse(is_cycle_period(date(2026, 2, 3), date(2026, 2, 16), ps, "biweekly"))  # shifted a day
        self.assertTrue(is_cycle_period(date(2026, 2, 2), date(2026, 3, 1), ps, "monthly"))

    def test_normalize_cycle_accepts_the_spellings_a_client_might_send(self):
        for raw in ("weekly", "Weekly", " WEEKLY "):
            self.assertEqual(normalize_cycle(raw), "weekly")
        for raw in ("biweekly", "BiWeekly", "bi-weekly", "bi_weekly"):
            self.assertEqual(normalize_cycle(raw), "biweekly")
        self.assertEqual(normalize_cycle("monthly"), "monthly")
        for raw in (None, "", "daily", "2weeks", 4):
            self.assertIsNone(normalize_cycle(raw))

    def test_normalize_week_start_accepts_weekdays_in_any_case_and_the_two_legacy_keys(self):
        for raw, expected in (
            ("monday", "monday"),
            (" Wednesday ", "wednesday"),
            ("SUNDAY", "sunday"),
            ("mon_sat", "monday"),  # the first release stored only these two
            ("sun_sat", "sunday"),
        ):
            self.assertEqual(normalize_week_start(raw), expected)
        for raw in (None, "", "tue_sat", "someday", "mon", 0, True):
            self.assertIsNone(normalize_week_start(raw))

    def test_a_stored_legacy_week_start_reads_as_its_weekday_and_an_unknown_one_as_monday(self):
        legacy = _Ps(_cycles(weekly={"weekStart": "sun_sat"}))
        self.assertEqual(cycle_config(legacy, "weekly").week_start, "sunday")
        self.assertEqual(resolve_cycle_period(date(2026, 2, 4), legacy, "weekly"), (date(2026, 2, 1), date(2026, 2, 7)))
        self.assertEqual(cycle_config(_Ps(_cycles(weekly={"weekStart": "someday"})), "weekly").week_start, "monday")


class NextPeriodTests(TestCase):
    def setUp(self):
        self.ps = _Ps(ALL_FROM_MON)

    def test_the_first_run_offers_the_latest_period_that_has_ended(self):
        # 10 March is inside the week of 9-15 March, which has not ended: the one before it is offered.
        self.assertEqual(next_cycle_period(self.ps, "weekly", TODAY), (date(2026, 3, 2), date(2026, 3, 8)))
        self.assertEqual(next_cycle_period(self.ps, "biweekly", TODAY), (date(2026, 2, 16), date(2026, 3, 1)))
        self.assertEqual(next_cycle_period(self.ps, "monthly", TODAY), (date(2026, 2, 2), date(2026, 3, 1)))

    def test_when_today_is_the_last_day_of_a_period_that_period_is_offered(self):
        self.assertEqual(next_cycle_period(self.ps, "weekly", date(2026, 3, 8)), (date(2026, 3, 2), date(2026, 3, 8)))

    def test_after_a_generated_period_the_next_one_follows_it(self):
        emp = Employee.objects.create(employee_code="NP1", first_name="N", last_name="P", employment_type="production")
        Payroll.objects.create(
            employee=emp,
            salary_mode="shift",
            month=2,
            year=2026,
            base_salary=0,
            gross_salary=0,
            final_salary=0,
            period_start=date(2026, 2, 2),
            period_end=date(2026, 2, 8),
            pay_cycle="weekly",
        )
        self.assertEqual(next_cycle_period(self.ps, "weekly", TODAY), (date(2026, 2, 9), date(2026, 2, 15)))
        # another cycle's history never moves this cycle's pointer
        self.assertEqual(next_cycle_period(self.ps, "biweekly", TODAY), (date(2026, 2, 16), date(2026, 3, 1)))

    def test_recent_periods_run_newest_first_and_cover_every_period_up_to_today(self):
        periods = recent_cycle_periods(self.ps, "weekly", TODAY, back=3)
        # next due is 2-8 March; the week holding today (9-15 March) is also offered; two before it
        self.assertEqual(
            periods,
            [
                (date(2026, 3, 9), date(2026, 3, 15)),
                (date(2026, 3, 2), date(2026, 3, 8)),
                (date(2026, 2, 23), date(2026, 3, 1)),
                (date(2026, 2, 16), date(2026, 2, 22)),
            ],
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Settings: prod_cycles
# ─────────────────────────────────────────────────────────────────────────────


class CycleSettingsTests(SimpleTestCase):
    def test_a_cycle_without_late_rules_uses_the_shared_production_rules(self):
        shared = [{"fromLates": 3, "deductionShifts": 0.25}]
        ps = _Ps(_cycles(weekly={"weekStart": "monday"}), allowance=3, slabs=shared)
        cfg = cycle_config(ps, "weekly")
        self.assertEqual((cfg.late_free_allowance, cfg.late_slabs, cfg.own_late_rules), (3, shared, False))
        self.assertEqual(cycle_late_rules(ps, "weekly"), (3, shared))
        self.assertEqual(cycle_late_rules(ps, None), (3, shared))

    def test_a_cycle_with_its_own_late_rules_uses_them_and_the_others_keep_the_shared_ones(self):
        own = [{"fromLates": 1, "deductionShifts": 0.5}]
        ps = _Ps(_cycles(weekly={"lateFreeAllowance": 1, "lateSlabs": own}), allowance=3, slabs=[])
        self.assertEqual(cycle_late_rules(ps, "weekly"), (1, own))
        self.assertEqual(cycle_late_rules(ps, "biweekly"), (3, []))
        self.assertTrue(cycle_config(ps, "weekly").own_late_rules)
        self.assertFalse(cycle_config(ps, "monthly").own_late_rules)

    def test_an_empty_own_slab_table_is_a_rule_of_its_own_not_the_shared_one(self):
        ps = _Ps(_cycles(weekly={"lateSlabs": []}), slabs=[{"fromLates": 1, "deductionShifts": 1}])
        self.assertEqual(cycle_late_rules(ps, "weekly")[1], [])
        self.assertTrue(cycle_config(ps, "weekly").own_late_rules)

    def test_the_response_lists_every_cycle_with_every_key(self):
        out = prod_cycles_response(_Ps(_cycles(biweekly={"weekStart": "sunday", "anchorDate": "2026-02-01"})))
        self.assertEqual(list(out), list(CYCLES))
        self.assertEqual(out["biweekly"]["weekStart"], "sunday")
        self.assertEqual(out["biweekly"]["anchorDate"], "2026-02-01")
        self.assertEqual(out["weekly"]["weekStart"], "monday")
        self.assertIsNone(out["weekly"]["anchorDate"])
        self.assertEqual(
            set(out["monthly"]), {"weekStart", "anchorDate", "lateFreeAllowance", "lateSlabs", "ownLateRules"}
        )

    def test_a_save_changes_only_the_cycles_and_keys_it_names(self):
        stored = _cycles(weekly={"weekStart": "sunday"}, biweekly={"anchorDate": "2026-02-02"})
        merged, problem = merge_prod_cycles(
            stored, {"biweekly": {"weekStart": "monday"}, "monthly": {"anchorDate": "2026-02-09"}}
        )
        self.assertIsNone(problem)
        self.assertEqual(merged["weekly"], {"weekStart": "sunday"})
        self.assertEqual(merged["biweekly"], {"anchorDate": "2026-02-02", "weekStart": "monday"})
        self.assertEqual(merged["monthly"], {"anchorDate": "2026-02-09"})

    def test_any_weekday_is_saved_and_a_legacy_key_is_saved_as_the_weekday_it_meant(self):
        for sent, stored in (
            ("thursday", "thursday"),
            ("Friday", "friday"),
            ("saturday", "saturday"),
            ("sun_sat", "sunday"),
            ("mon_sat", "monday"),
        ):
            merged, problem = merge_prod_cycles(None, {"weekly": {"weekStart": sent}})
            self.assertIsNone(problem, sent)
            self.assertEqual(merged, {"weekly": {"weekStart": stored}}, sent)

    def test_null_hands_a_cycles_late_rules_back_to_the_shared_ones(self):
        stored = _cycles(
            weekly={
                "lateFreeAllowance": 1,
                "lateSlabs": [{"fromLates": 1, "deductionShifts": 1.0}],
                "weekStart": "monday",
            }
        )
        merged, problem = merge_prod_cycles(stored, {"weekly": {"lateFreeAllowance": None, "lateSlabs": None}})
        self.assertIsNone(problem)
        self.assertEqual(merged, {"weekly": {"weekStart": "monday"}})

    def test_slabs_are_cleaned_sorted_and_deduplicated(self):
        merged, problem = merge_prod_cycles(
            None,
            {
                "weekly": {
                    "lateSlabs": [
                        {"fromLates": "6", "deductionShifts": "0.5"},
                        {"fromLates": 3, "deductionShifts": 0.25},
                        {"fromLates": 3, "deductionShifts": 0.3},
                    ]
                }
            },
        )
        self.assertIsNone(problem)
        self.assertEqual(
            merged["weekly"]["lateSlabs"],
            [
                {"fromLates": 3, "deductionShifts": 0.3},
                {"fromLates": 6, "deductionShifts": 0.5},
            ],
        )

    def test_everything_that_cannot_be_right_is_refused_with_a_message(self):
        cases = [
            ({"daily": {"weekStart": "monday"}}, "Unknown pay cycle"),
            ({"weekly": "monday"}, "Weekly settings must be an object"),
            ({"weekly": {"colour": "red"}}, "unknown setting 'colour'"),
            ({"weekly": {"weekStart": "tue_sat"}}, "week start must be a weekday"),
            ({"weekly": {"weekStart": "someday"}}, "week start must be a weekday"),
            ({"weekly": {"weekStart": 3}}, "week start must be a weekday"),
            ({"biweekly": {"anchorDate": "02/02/2026"}}, "first period start must be a real date"),
            ({"biweekly": {"anchorDate": "2026-02-30"}}, "first period start must be a real date"),
            ({"biweekly": {"anchorDate": "1999-12-27"}}, "between the years 2000 and 2100"),
            ({"monthly": {"lateFreeAllowance": -1}}, "free late days must be a whole number from 0 to 366"),
            ({"monthly": {"lateFreeAllowance": 367}}, "free late days"),
            ({"monthly": {"lateFreeAllowance": 1.5}}, "free late days"),
            ({"monthly": {"lateFreeAllowance": True}}, "free late days"),
            ({"monthly": {"lateFreeAllowance": "many"}}, "free late days"),
            ({"weekly": {"lateSlabs": "none"}}, "Late slabs must be a list"),
            ({"weekly": {"lateSlabs": [{"fromLates": 1}]}}, "numeric fromLates and deductionShifts"),
            ({"weekly": {"lateSlabs": [{"fromLates": 1, "deductionShifts": -1}]}}, "cannot be negative"),
            ({"weekly": {"lateSlabs": [{"fromLates": 1.5, "deductionShifts": 1}]}}, "whole number"),
            ({"weekly": {"lateSlabs": [{"fromLates": 999, "deductionShifts": 1}]}}, "more than 366"),
            ({"weekly": {"lateSlabs": [{"fromLates": 1, "deductionShifts": float("nan")}]}}, "finite"),
        ]
        for patch_body, part in cases:
            merged, problem = merge_prod_cycles(None, patch_body)
            self.assertIsNone(merged, patch_body)
            self.assertIn(part, problem, patch_body)
        self.assertIsNotNone(merge_prod_cycles(None, [])[1])

    def test_late_shift_deduction_reads_the_slabs_it_is_given(self):
        ps = _Ps(slabs=[{"fromLates": 1, "deductionShifts": 9}])
        own = [{"fromLates": 2, "deductionShifts": 0.5}, {"fromLates": 4, "deductionShifts": 1}]
        self.assertEqual(
            late_shift_deduction(3, ps, slabs_field="prod_late_deduction_slabs", slabs=own), Decimal("0.5")
        )
        self.assertEqual(late_shift_deduction(4, ps, slabs_field="prod_late_deduction_slabs", slabs=own), Decimal("1"))
        self.assertEqual(late_shift_deduction(1, ps, slabs_field="prod_late_deduction_slabs", slabs=own), Decimal("0"))
        self.assertEqual(late_shift_deduction(1, ps, slabs_field="prod_late_deduction_slabs"), Decimal("9"))
        self.assertEqual(late_shift_deduction(5, ps, slabs_field="prod_late_deduction_slabs", slabs=[]), Decimal("0"))


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers for the database tests
# ─────────────────────────────────────────────────────────────────────────────


def _hr(username="cyc_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _worker(code, cycle="weekly", per_shift="500.00", branch=None, status="active", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Worker",
        employment_type="production",
        status=status,
        salary_per_shift=Decimal(per_shift) if per_shift is not None else None,
        production_pay_cycle=cycle,
        branch=branch,
        **kw,
    )


def _shifts(emp, start, end, shifts="1.00"):
    day = start
    while day <= end:
        AttendanceDayRecord.objects.create(
            employee=emp, date=day, status="present", shifts_earned=Decimal(shifts), source="manual"
        )
        day += timedelta(days=1)


def _row(emp, start, end, cycle=None, status="pending", gross="100.00") -> Payroll:
    return Payroll.objects.create(
        employee=emp,
        salary_mode="shift",
        month=end.month,
        year=end.year,
        base_salary=gross,
        gross_salary=gross,
        final_salary=gross,
        status=status,
        period_start=start,
        period_end=end,
        pay_cycle=cycle,
    )


class CycleDbTestCase(TestCase):
    def setUp(self):
        _settings(
            prod_cycles=ALL_FROM_MON,
            prod_late_detection_enabled=False,
            prod_pf_rules=[],
            prod_esi_rules=[],
        )
        self.admin = _hr()
        self.patches = [p.start() for p in _today()]
        self.addCleanup(patch.stopall)

    def get(self, url, headers=None):
        return self.client.get(url, **(headers or self.admin))

    def post(self, url, body, headers=None):
        return self.client.post(url, body, content_type="application/json", **(headers or self.admin))

    def put(self, url, body, headers=None):
        return self.client.put(url, body, content_type="application/json", **(headers or self.admin))


# ─────────────────────────────────────────────────────────────────────────────
#  The engine
# ─────────────────────────────────────────────────────────────────────────────


class EngineCycleTests(CycleDbTestCase):
    def test_the_cycle_is_stamped_on_the_payroll_and_the_slip(self):
        emp = _worker("EC1")
        _shifts(emp, MON, date(2026, 2, 8))
        result = _generate_production_payroll(emp, MON, date(2026, 2, 8), pay_cycle="weekly")
        self.assertEqual(result["payroll"].pay_cycle, "weekly")
        self.assertEqual(result["slip"].pay_cycle, "weekly")
        self.assertEqual(result["slip"].breakdown_details["payCycle"], "weekly")

    def test_without_a_cycle_nothing_is_stamped_and_a_stamped_row_keeps_its_cycle(self):
        emp = _worker("EC2")
        _shifts(emp, MON, date(2026, 2, 8))
        first = _generate_production_payroll(emp, MON, date(2026, 2, 8))["payroll"]
        self.assertIsNone(first.pay_cycle)
        _generate_production_payroll(emp, MON, date(2026, 2, 8), pay_cycle="weekly")
        again = _generate_production_payroll(emp, MON, date(2026, 2, 8))["payroll"]
        self.assertEqual(again.pay_cycle, "weekly")

    def test_the_monthly_equivalent_follows_the_cycle(self):
        # 7 shifts x 500 = 3500 gross for the week; the ESI rule covers monthly earnings up to 12,000
        _settings(
            prod_esi_rules=[
                {"id": "e1", "label": "ESI", "basis": "total", "minAmount": 0, "maxAmount": 12000, "ratePercent": 0.75}
            ],
        )
        for cycle, factor, esi_applies in (
            ("weekly", 4, False),
            ("biweekly", 2, True),
            ("monthly", 1, True),
            (None, 2, True),
        ):
            emp = _worker(f"EM_{cycle}", cycle=cycle, co_emp_enabled=True)
            _shifts(emp, MON, date(2026, 2, 8))
            slip = _generate_production_payroll(emp, MON, date(2026, 2, 8), pay_cycle=cycle)["slip"]
            ded = slip.breakdown_details["deductions"]
            self.assertEqual(ded["monthlyEquivalent"], 3500.0 * factor, cycle)
            self.assertEqual(ded["monthlyEquivalentFactor"], factor, cycle)
            self.assertEqual(slip.esi_deduction > 0, esi_applies, cycle)

    def test_a_period_without_a_cycle_is_judged_like_a_biweekly_one(self):
        # (monthly equivalent x2, as the engine always did before the cycles existed)
        _settings(
            prod_pf_rules=[
                {"id": "p1", "label": "PF", "basis": "total", "minAmount": 0, "maxAmount": 0, "ratePercent": 12}
            ],
            prod_esi_rules=[
                {"id": "e1", "label": "ESI", "basis": "total", "minAmount": 0, "maxAmount": 21000, "ratePercent": 0.75}
            ],
        )
        a = _worker("EB1", cycle="biweekly", co_emp_enabled=True)
        b = _worker("EB2", cycle=None, co_emp_enabled=True)
        for emp in (a, b):
            _shifts(emp, MON, date(2026, 2, 15))
        with_cycle = _generate_production_payroll(a, MON, date(2026, 2, 15), pay_cycle="biweekly")["payroll"]
        without = _generate_production_payroll(b, MON, date(2026, 2, 15))["payroll"]
        self.assertGreater(with_cycle.deductions, 0)  # the rules did apply
        self.assertEqual(
            (with_cycle.gross_salary, with_cycle.deductions, with_cycle.final_salary),
            (without.gross_salary, without.deductions, without.final_salary),
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Settings API
# ─────────────────────────────────────────────────────────────────────────────


class CycleSettingsApiTests(CycleDbTestCase):
    URL = "/api/payroll-settings"

    def test_get_returns_every_cycle(self):
        body = self.get(self.URL).json()
        self.assertEqual(list(body["prodCycles"]), list(CYCLES))
        self.assertEqual(body["prodCycles"]["biweekly"]["anchorDate"], "2026-02-02")

    def test_put_merges_into_the_stored_cycles(self):
        r = self.put(self.URL, {"prodCycles": {"weekly": {"weekStart": "sunday", "lateFreeAllowance": 1}}})
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["prodCycles"]
        self.assertEqual(out["weekly"]["weekStart"], "sunday")
        self.assertEqual(out["weekly"]["lateFreeAllowance"], 1)
        self.assertTrue(out["weekly"]["ownLateRules"])
        self.assertEqual(out["biweekly"]["anchorDate"], "2026-02-02")  # untouched
        stored = PayrollSettings.objects.get(pk=1).prod_cycles
        self.assertEqual(stored["biweekly"]["anchorDate"], "2026-02-02")

    def test_any_weekday_can_be_saved_and_the_period_endpoints_follow_it(self):
        for number, week_start in enumerate(WEEKDAYS):
            r = self.put(self.URL, {"prodCycles": {"weekly": {"weekStart": week_start}}})
            self.assertEqual(r.status_code, 200, (week_start, r.content[:300]))
            self.assertEqual(r.json()["prodCycles"]["weekly"]["weekStart"], week_start)
            periods = self.get("/api/payroll/production/periods?cycle=weekly&back=3").json()["periods"]
            for p in periods:
                start, end = date.fromisoformat(p["periodStart"]), date.fromisoformat(p["periodEnd"])
                self.assertEqual((start.weekday(), (end - start).days), (number, 6), (week_start, p))
            nxt = self.get("/api/payroll/production/next-period?cycle=weekly").json()
            self.assertEqual(date.fromisoformat(nxt["periodStart"]).weekday(), number, week_start)

    def test_an_old_client_that_sends_a_legacy_key_is_saved_as_the_weekday_it_meant(self):
        r = self.put(self.URL, {"prodCycles": {"weekly": {"weekStart": "sun_sat"}}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["prodCycles"]["weekly"]["weekStart"], "sunday")
        self.assertEqual(PayrollSettings.objects.get(pk=1).prod_cycles["weekly"]["weekStart"], "sunday")

    def test_a_week_start_that_is_not_a_weekday_is_a_400_and_saves_nothing(self):
        before = PayrollSettings.objects.get(pk=1).prod_cycles
        r = self.put(self.URL, {"prodCycles": {"weekly": {"weekStart": "payday"}}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("week start must be a weekday", r.json()["error"])
        self.assertEqual(PayrollSettings.objects.get(pk=1).prod_cycles, before)

    def test_a_bad_value_is_a_400_and_saves_nothing(self):
        before = PayrollSettings.objects.get(pk=1).prod_cycles
        r = self.put(self.URL, {"companyName": "Nope Ltd", "prodCycles": {"monthly": {"anchorDate": "soon"}}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("first period start must be a real date", r.json()["error"])
        ps = PayrollSettings.objects.get(pk=1)
        self.assertEqual(ps.prod_cycles, before)
        self.assertNotEqual(ps.company_name, "Nope Ltd")

    def test_only_a_login_with_production_payroll_settings_edit_may_change_it(self):
        role = Role.objects.create(name="Payroll Rates", permissions={"settings.payroll": "edit"})
        denied = self.put(
            self.URL,
            {"prodCycles": {"weekly": {"weekStart": "sunday"}}},
            _hr("cyc_rates", super_admin=False, role=role),
        )
        self.assertEqual(denied.status_code, 403)
        self.assertIn("prodCycles", denied.json()["fields"])
        allowed_role = Role.objects.create(name="Production Pay", permissions={"settings.production_payroll": "edit"})
        ok = self.put(
            self.URL,
            {"prodCycles": {"weekly": {"weekStart": "sunday"}}},
            _hr("cyc_prod", super_admin=False, role=allowed_role),
        )
        self.assertEqual(ok.status_code, 200, ok.content)


# ─────────────────────────────────────────────────────────────────────────────
#  Assigning employees to a cycle
# ─────────────────────────────────────────────────────────────────────────────


class AssignmentTests(CycleDbTestCase):
    LIST = "/api/employees/production"
    ASSIGN = "/api/employees/production/assign"

    def setUp(self):
        super().setUp()
        self.w1 = _worker("AS1", cycle="weekly")
        self.w2 = _worker("AS2", cycle="weekly")
        self.b1 = _worker("AS3", cycle="biweekly")
        self.m1 = _worker("AS4", cycle="monthly")
        self.u1 = _worker("AS5", cycle=None)
        self.u2 = _worker("AS6", cycle=None)
        self.gone = _worker("AS7", cycle="weekly", status="inactive")
        self.staff = Employee.objects.create(
            employee_code="AS8", first_name="Staff", last_name="Person", employment_type="staff", status="active"
        )

    def codes(self, body):
        return [e["employeeCode"] for e in body["employees"]]

    def test_the_list_holds_production_employees_only_with_the_tab_counts(self):
        body = self.get(self.LIST).json()
        self.assertEqual(sorted(self.codes(body)), ["AS1", "AS2", "AS3", "AS4", "AS5", "AS6"])  # no staff, no inactive
        self.assertEqual(body["counts"], {"weekly": 2, "biweekly": 1, "monthly": 1, "unassigned": 2, "total": 6})

    def test_each_tab_lists_its_own_people_and_the_counts_do_not_change(self):
        for cycle, expect in (
            ("weekly", ["AS1", "AS2"]),
            ("biweekly", ["AS3"]),
            ("monthly", ["AS4"]),
            ("unassigned", ["AS5", "AS6"]),
            ("all", ["AS1", "AS2", "AS3", "AS4", "AS5", "AS6"]),
        ):
            body = self.get(f"{self.LIST}?cycle={cycle}").json()
            self.assertEqual(sorted(self.codes(body)), expect, cycle)
            self.assertEqual(body["counts"]["total"], 6, cycle)

    def test_status_search_and_a_bad_cycle(self):
        body = self.get(f"{self.LIST}?status=all").json()
        self.assertEqual(body["counts"]["total"], 7)
        self.assertEqual(self.codes(self.get(f"{self.LIST}?status=inactive").json()), ["AS7"])
        self.assertEqual(self.codes(self.get(f"{self.LIST}?search=as3").json()), ["AS3"])
        self.assertEqual(self.get(f"{self.LIST}?cycle=daily").status_code, 400)
        self.assertEqual(self.get(f"{self.LIST}?status=gone").status_code, 400)

    def test_a_row_shows_the_cycle_and_the_last_payroll(self):
        _row(self.w1, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly")
        _row(self.w1, date(2026, 2, 9), date(2026, 2, 15), cycle="weekly", status="paid")
        row = next(e for e in self.get(self.LIST).json()["employees"] if e["employeeCode"] == "AS1")
        self.assertEqual(row["payCycle"], "weekly")
        self.assertEqual(row["lastPayroll"]["periodEnd"], "2026-02-15")
        self.assertEqual(row["lastPayroll"]["status"], "paid")
        other = next(e for e in self.get(self.LIST).json()["employees"] if e["employeeCode"] == "AS5")
        self.assertIsNone(other["lastPayroll"])

    def test_assigning_moves_people_and_reports_the_new_counts(self):
        r = self.post(self.ASSIGN, {"employeeIds": [self.u1.id, self.u2.id], "cycle": "monthly"})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["updated"], body["unchanged"], body["skipped"]), (2, 0, []))
        self.assertEqual(body["counts"]["monthly"], 3)
        self.assertEqual(body["counts"]["unassigned"], 0)
        self.u1.refresh_from_db()
        self.assertEqual(self.u1.production_pay_cycle, "monthly")

    def test_people_already_on_the_cycle_are_unchanged_and_a_null_cycle_unassigns(self):
        r = self.post(self.ASSIGN, {"employeeIds": [self.w1.id, self.b1.id], "cycle": "weekly"}).json()
        self.assertEqual((r["updated"], r["unchanged"]), (1, 1))
        r = self.post(self.ASSIGN, {"employeeIds": [self.w1.id], "cycle": None}).json()
        self.assertEqual(r["updated"], 1)
        self.w1.refresh_from_db()
        self.assertIsNone(self.w1.production_pay_cycle)

    def test_a_staff_employee_or_a_missing_id_cannot_be_assigned(self):
        r = self.post(self.ASSIGN, {"employeeIds": [self.staff.id, 999999], "cycle": "weekly"}).json()
        self.assertEqual(r["updated"], 0)
        self.assertEqual(sorted(s["employeeId"] for s in r["skipped"]), sorted([self.staff.id, 999999]))
        self.staff.refresh_from_db()
        self.assertIsNone(self.staff.production_pay_cycle)

    def test_bad_requests_are_refused(self):
        for body in (
            {"cycle": "weekly"},
            {"employeeIds": [], "cycle": "weekly"},
            {"employeeIds": "1", "cycle": "weekly"},
            {"employeeIds": ["x"], "cycle": "weekly"},
            {"employeeIds": [self.u1.id], "cycle": "daily"},
        ):
            self.assertEqual(self.post(self.ASSIGN, body).status_code, 400, body)

    def test_a_move_reports_unpaid_payroll_left_on_the_old_cycle(self):
        _row(self.w1, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly", status="pending")
        r = self.post(self.ASSIGN, {"employeeIds": [self.w1.id, self.w2.id], "cycle": "monthly"}).json()
        self.assertEqual(r["pendingOnOtherCycle"], 1)

    def test_a_branch_login_sees_and_assigns_only_its_own_branch(self):
        mine, other = Branch.objects.create(name="Mine", code="MIN"), Branch.objects.create(name="Other", code="OTH")
        role = Role.objects.create(name="Branch HR", permissions={"employees": "edit"})
        branch_hr = _hr("cyc_branch", super_admin=False, role=role, branch=mine)
        a, b = _worker("BR1", cycle=None, branch=mine), _worker("BR2", cycle=None, branch=other)
        self.assertEqual(self.codes(self.get(self.LIST, branch_hr).json()), ["BR1"])
        r = self.post(self.ASSIGN, {"employeeIds": [a.id, b.id], "cycle": "weekly"}, branch_hr).json()
        self.assertEqual((r["updated"], [s["employeeId"] for s in r["skipped"]]), (1, [b.id]))
        b.refresh_from_db()
        self.assertIsNone(b.production_pay_cycle)

    def test_assigning_needs_edit_permission_on_employees(self):
        role = Role.objects.create(name="Viewer", permissions={"employees": "view"})
        viewer = _hr("cyc_viewer", super_admin=False, role=role)
        self.assertEqual(self.get(self.LIST, viewer).status_code, 200)
        self.assertEqual(
            self.post(self.ASSIGN, {"employeeIds": [self.u1.id], "cycle": "weekly"}, viewer).status_code, 403
        )

    def test_the_employee_json_carries_the_cycle(self):
        body = self.get(f"/api/employees/{self.w1.id}").json()
        self.assertEqual(body["productionPayCycle"], "weekly")


# ─────────────────────────────────────────────────────────────────────────────
#  Generating a cycle
# ─────────────────────────────────────────────────────────────────────────────

WEEK1 = {"periodStart": "2026-02-02", "periodEnd": "2026-02-08"}
FORT1 = {"periodStart": "2026-02-02", "periodEnd": "2026-02-15"}
GEN = "/api/payroll/production/generate"


class GenerateTests(CycleDbTestCase):
    def setUp(self):
        super().setUp()
        self.w1 = _worker("GN1", cycle="weekly")
        self.w2 = _worker("GN2", cycle="weekly")
        self.b1 = _worker("GN3", cycle="biweekly")
        self.u1 = _worker("GN4", cycle=None)
        self.staff = Employee.objects.create(
            employee_code="GN5", first_name="S", last_name="T", employment_type="staff", status="active"
        )
        for emp in (self.w1, self.w2, self.b1, self.u1):
            _shifts(emp, MON, date(2026, 2, 15))

    def rows(self, **kw):
        return Payroll.objects.filter(salary_mode="shift", period_start__isnull=False, **kw)

    def test_a_cycle_is_required(self):
        r = self.post(GEN, {})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Choose a pay cycle", r.json()["error"])
        self.assertEqual(self.post(GEN, {"cycle": "daily"}).status_code, 400)

    def test_only_the_people_assigned_to_the_cycle_are_paid(self):
        r = self.post(GEN, {"cycle": "weekly", **WEEK1})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["generated"], body["skipped"], body["alreadyGenerated"]), (2, 0, 0))
        self.assertEqual(sorted(self.rows().values_list("employee__employee_code", flat=True)), ["GN1", "GN2"])
        self.assertEqual(set(self.rows().values_list("pay_cycle", flat=True)), {"weekly"})
        self.assertEqual(set(SalarySlip.objects.values_list("pay_cycle", flat=True)), {"weekly"})

    def test_each_cycle_pays_its_own_people_for_its_own_period_length(self):
        self.assertEqual(self.post(GEN, {"cycle": "biweekly", **FORT1}).json()["generated"], 1)
        row = self.rows().get()
        self.assertEqual((row.employee_id, row.pay_cycle, row.period_end), (self.b1.id, "biweekly", date(2026, 2, 15)))
        self.assertEqual(row.gross_salary, Decimal("7000.00"))  # 14 shifts x 500

    def test_the_period_must_be_one_of_the_cycles_periods(self):
        r = self.post(GEN, {"cycle": "biweekly", **WEEK1})
        self.assertEqual(r.status_code, 400)
        self.assertIn("is not a BiWeekly period", r.json()["error"])
        self.assertIn("2026-02-02 to 2026-02-15", r.json()["error"])
        self.assertEqual(self.post(GEN, {"cycle": "weekly", "periodStart": "2026-02-02"}).status_code, 400)
        self.assertEqual(
            self.post(GEN, {"cycle": "weekly", "periodStart": "soon", "periodEnd": "later"}).status_code, 400
        )
        self.assertFalse(self.rows().exists())

    def test_a_period_that_has_not_ended_is_refused(self):
        r = self.post(GEN, {"cycle": "weekly", "periodStart": "2026-03-09", "periodEnd": "2026-03-15"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("has not ended yet", r.json()["error"])

    def test_without_a_period_the_next_due_one_is_generated_and_the_pointer_moves_on(self):
        body = self.post(GEN, {"cycle": "weekly"}).json()
        self.assertEqual((body["periodStart"], body["periodEnd"]), ("2026-03-02", "2026-03-08"))  # latest ended week
        self.assertEqual(set(self.rows().values_list("pay_cycle", flat=True)), {"weekly"})
        after = self.get("/api/payroll/production/next-period?cycle=weekly").json()
        self.assertEqual((after["periodStart"], after["periodEnded"]), ("2026-03-09", False))
        # the week holding today cannot be generated yet
        self.assertEqual(self.post(GEN, {"cycle": "weekly"}).status_code, 400)

    def test_generation_follows_the_saved_start_weekday(self):
        _settings(prod_cycles=_cycles(weekly={"weekStart": "thursday"}))
        monday_week = self.post(GEN, {"cycle": "weekly", **WEEK1})  # 2-8 February is a Monday week
        self.assertEqual(monday_week.status_code, 400)
        self.assertIn("is not a Weekly period", monday_week.json()["error"])
        thursday_week = self.post(GEN, {"cycle": "weekly", "periodStart": "2026-02-05", "periodEnd": "2026-02-11"})
        self.assertEqual(thursday_week.status_code, 201, thursday_week.content[:300])
        self.assertEqual(thursday_week.json()["generated"], 2)

    def test_a_cycle_with_no_first_period_start_says_so(self):
        _settings(prod_cycles=_cycles(weekly={"weekStart": "monday"}))
        r = self.post(GEN, {"cycle": "biweekly"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Set the first period start date for BiWeekly", r.json()["error"])

    def test_running_again_never_overwrites_payroll_that_exists(self):
        self.post(GEN, {"cycle": "weekly", **WEEK1})
        row = self.rows().get(employee=self.w1)
        row.bonus, row.final_salary, row.notes = Decimal("250.00"), row.final_salary + 250, "HR adjusted"
        row.save()
        body = self.post(GEN, {"cycle": "weekly", **WEEK1}).json()
        self.assertEqual((body["generated"], body["alreadyGenerated"]), (0, 2))
        row.refresh_from_db()
        self.assertEqual((row.bonus, row.notes), (Decimal("250.00"), "HR adjusted"))

    def test_one_employee_can_be_generated_on_their_own(self):
        r = self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], **WEEK1}).json()
        self.assertEqual((r["generated"], r["alreadyGenerated"]), (1, 0))
        self.assertEqual(list(self.rows().values_list("employee_id", flat=True)), [self.w1.id])
        # the rest of the cycle is still to do, and the run only fills the gap
        r = self.post(GEN, {"cycle": "weekly", **WEEK1}).json()
        self.assertEqual((r["generated"], r["alreadyGenerated"]), (1, 1))
        self.assertEqual(self.rows().count(), 2)

    def test_someone_outside_the_cycle_is_refused_with_the_reason(self):
        r = self.post(
            GEN, {"cycle": "weekly", "employeeIds": [self.b1.id, self.u1.id, self.staff.id, 999999], **WEEK1}
        ).json()
        self.assertEqual(r["generated"], 0)
        reasons = {d["employeeId"]: d["reason"] for d in r["skippedDetails"]}
        self.assertIn("Not assigned to the Weekly cycle (assigned to BiWeekly)", reasons[self.b1.id])
        self.assertIn("no pay cycle", reasons[self.u1.id])
        self.assertIn("Not a production employee", reasons[self.staff.id])
        self.assertIn("Not a production employee", reasons[999999])
        self.assertFalse(self.rows().exists())

    def test_an_inactive_employee_is_not_on_the_roster(self):
        self.w2.status = "inactive"
        self.w2.save()
        self.assertEqual(self.post(GEN, {"cycle": "weekly", **WEEK1}).json()["generated"], 1)
        r = self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w2.id], **WEEK1}).json()
        self.assertIn("Not an active employee", r["skippedDetails"][0]["reason"])

    def test_a_pending_payslip_is_recomputed_only_when_asked_and_a_paid_one_never(self):
        self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], **WEEK1})
        AttendanceDayRecord.objects.filter(employee=self.w1, date=date(2026, 2, 2)).update(
            shifts_earned=Decimal("1.50")
        )
        plain = self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], **WEEK1}).json()
        self.assertEqual((plain["generated"], plain["alreadyGenerated"]), (0, 1))
        again = self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], "regenerate": True, **WEEK1}).json()
        self.assertEqual(again["generated"], 1)
        row = self.rows().get(employee=self.w1)
        self.assertEqual(row.gross_salary, Decimal("3750.00"))  # 7.5 shifts x 500
        row.status = "paid"
        row.save()
        paid = self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], "regenerate": True, **WEEK1}).json()
        self.assertEqual(paid["generated"], 0)
        self.assertIn("Already paid", paid["skippedDetails"][0]["reason"])
        row.refresh_from_db()
        self.assertEqual((row.status, row.gross_salary), ("paid", Decimal("3750.00")))

    def test_days_already_paid_in_another_payslip_are_never_paid_twice(self):
        _row(self.w1, date(2026, 2, 1), date(2026, 2, 14))  # an older payslip (no cycle) covering most of the week
        r = self.post(GEN, {"cycle": "weekly", **WEEK1}).json()
        self.assertEqual(r["generated"], 1)  # w2 only
        self.assertIn(
            "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14", r["skippedDetails"][0]["reason"]
        )
        self.assertEqual(self.rows(employee=self.w1).count(), 1)

    def test_an_employee_without_a_rate_per_shift_is_skipped_with_the_reason(self):
        self.w2.salary_per_shift = None
        self.w2.save()
        r = self.post(GEN, {"cycle": "weekly", **WEEK1}).json()
        self.assertEqual((r["generated"], r["skipped"]), (1, 1))
        self.assertIn("No Salary Per Shift", r["skippedDetails"][0]["reason"])

    def test_a_branch_login_only_ever_pays_its_own_branch(self):
        mine, other = Branch.objects.create(name="Mine", code="MIN"), Branch.objects.create(name="Other", code="OTH")
        role = Role.objects.create(name="Branch Payroll", permissions={"production_payroll": "edit"})
        branch_hr = _hr("cyc_bpay", super_admin=False, role=role, branch=mine)
        a, b = _worker("GB1", cycle="weekly", branch=mine), _worker("GB2", cycle="weekly", branch=other)
        for emp in (a, b):
            _shifts(emp, MON, date(2026, 2, 8))
        self.assertEqual(self.post(GEN, {"cycle": "weekly", **WEEK1}, branch_hr).json()["generated"], 1)
        self.assertEqual(
            list(
                self.rows(employee__employee_code__in=["GB1", "GB2"]).values_list("employee__employee_code", flat=True)
            ),
            ["GB1"],
        )
        outside = self.post(GEN, {"cycle": "weekly", "employeeIds": [b.id], **WEEK1}, branch_hr).json()
        self.assertEqual(outside["generated"], 0)

    def test_generating_needs_edit_permission_on_production_payroll(self):
        role = Role.objects.create(name="Payroll Viewer", permissions={"production_payroll": "view"})
        viewer = _hr("cyc_pview", super_admin=False, role=role)
        self.assertEqual(self.post(GEN, {"cycle": "weekly", **WEEK1}, viewer).status_code, 403)
        self.assertEqual(self.get("/api/payroll/production?cycle=weekly", viewer).status_code, 200)


# ─────────────────────────────────────────────────────────────────────────────
#  Reading a cycle: list, skip check, summary, periods, period status
# ─────────────────────────────────────────────────────────────────────────────


class ReadTests(CycleDbTestCase):
    def setUp(self):
        super().setUp()
        self.w1 = _worker("RD1", cycle="weekly")
        self.w2 = _worker("RD2", cycle="weekly")
        self.b1 = _worker("RD3", cycle="biweekly")
        self.u1 = _worker("RD4", cycle=None)
        for emp in (self.w1, self.w2, self.b1):
            _shifts(emp, MON, date(2026, 2, 15))

    def test_the_list_holds_the_rows_of_the_cycle_only(self):
        _row(self.w1, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly")
        _row(self.b1, date(2026, 2, 2), date(2026, 2, 15), cycle="biweekly")
        # generated before the cycles existed: follows the employee's cycle today
        _row(self.w2, date(2026, 1, 1), date(2026, 1, 14), cycle=None)
        _row(self.u1, date(2026, 1, 1), date(2026, 1, 14), cycle=None)
        weekly = self.get("/api/payroll/production?cycle=weekly").json()
        self.assertEqual(sorted(r["employeeCode"] for r in weekly), ["RD1", "RD2"])
        self.assertEqual(
            sorted(r["employeeCode"] for r in self.get("/api/payroll/production?cycle=biweekly").json()), ["RD3"]
        )
        self.assertEqual(self.get("/api/payroll/production?cycle=monthly").json(), [])
        self.assertEqual(len(self.get("/api/payroll/production").json()), 4)  # without a cycle: everything, as before
        self.assertEqual(self.get("/api/payroll/production?cycle=daily").status_code, 400)
        self.assertEqual(weekly[0]["payCycle"] in ("weekly", None), True)

    def test_the_list_can_be_narrowed_to_one_period(self):
        _row(self.w1, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly")
        _row(self.w1, date(2026, 2, 9), date(2026, 2, 15), cycle="weekly")
        only = self.get("/api/payroll/production?cycle=weekly&periodStart=2026-02-09&periodEnd=2026-02-15").json()
        self.assertEqual([r["periodStart"] for r in only], ["2026-02-09"])

    def test_the_skip_check_changes_nothing_and_names_each_problem(self):
        self.w2.salary_per_shift = None
        self.w2.save()
        _row(self.w1, date(2026, 2, 1), date(2026, 2, 4), cycle=None)  # overlaps the week
        before = Payroll.objects.count()
        body = self.get(
            "/api/payroll/production/skip-check?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08"
        ).json()
        self.assertEqual(Payroll.objects.count(), before)
        self.assertEqual(SalarySlip.objects.count(), 0)
        self.assertEqual((body["totalChecked"], body["skippedCount"]), (2, 2))
        reasons = " | ".join(s["reason"] for s in body["skipped"])
        self.assertIn("Overlaps", reasons)
        self.assertIn("No Salary Per Shift", reasons)

    def test_the_skip_check_counts_payroll_that_already_exists(self):
        self.post(GEN, {"cycle": "weekly", **WEEK1})
        body = self.get(
            "/api/payroll/production/skip-check?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08"
        ).json()
        self.assertEqual((body["alreadyGenerated"], body["skippedCount"]), (2, 0))

    def test_the_summary_counts_each_cycle_and_the_unassigned(self):
        _row(self.w1, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly", gross="1200.00")
        _row(self.w2, date(2026, 2, 2), date(2026, 2, 8), cycle="weekly", status="paid", gross="900.00")
        body = self.get("/api/payroll/production/cycles").json()
        self.assertEqual((body["totalProduction"], body["unassigned"]), (4, 1))
        by = {c["cycle"]: c for c in body["cycles"]}
        self.assertEqual([by[c]["assigned"] for c in CYCLES], [2, 1, 0])
        self.assertEqual(by["weekly"]["pending"], {"records": 1, "employees": 1, "amount": 1200.0})
        self.assertEqual(by["weekly"]["label"], "Weekly")
        self.assertEqual(by["monthly"]["days"], 28)
        self.assertTrue(all(by[c]["configured"] for c in CYCLES))
        self.assertEqual(by["biweekly"]["next"]["periodStart"], "2026-02-16")

    def test_the_summary_says_when_a_cycle_has_no_first_period_start(self):
        _settings(prod_cycles=_cycles(weekly={"weekStart": "monday"}))
        by = {c["cycle"]: c for c in self.get("/api/payroll/production/cycles").json()["cycles"]}
        self.assertTrue(by["weekly"]["configured"])
        self.assertFalse(by["biweekly"]["configured"])
        self.assertIsNone(by["biweekly"]["next"])
        self.assertIn("first period start date", by["biweekly"]["configError"])

    def test_next_period_and_the_period_list(self):
        nxt = self.get("/api/payroll/production/next-period?cycle=weekly").json()
        self.assertEqual((nxt["periodStart"], nxt["periodEnded"], nxt["days"]), ("2026-03-02", True, 7))
        self.assertEqual(self.get("/api/payroll/production/next-period").status_code, 400)
        self.post(GEN, {"cycle": "weekly", **WEEK1})
        listing = self.get("/api/payroll/production/periods?cycle=weekly&back=4").json()
        self.assertEqual(listing["roster"], 2)
        first_week = next(p for p in listing["periods"] if p["periodStart"] == "2026-02-02")
        self.assertEqual((first_week["generated"], first_week["paid"], first_week["periodEnded"]), (2, 0, True))
        self.assertEqual(sum(1 for p in listing["periods"] if p["isNext"]), 1)
        self.assertEqual(listing["periods"][0]["periodStart"] >= listing["periods"][-1]["periodStart"], True)

    def test_the_period_status_lists_the_roster_with_what_each_has(self):
        self.w2.salary_per_shift = None
        self.w2.save()
        self.post(GEN, {"cycle": "weekly", "employeeIds": [self.w1.id], **WEEK1})
        body = self.get(
            "/api/payroll/production/period-status?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08"
        ).json()
        self.assertEqual(body["counts"], {"generated": 1, "paid": 0, "ready": 0, "blocked": 1})
        by = {e["employeeCode"]: e for e in body["employees"]}
        self.assertEqual(sorted(by), ["RD1", "RD2"])
        self.assertEqual(by["RD1"]["payroll"]["finalSalary"], 3500.0)
        self.assertIsNone(by["RD1"]["blockedReason"])
        self.assertIn("No Salary Per Shift", by["RD2"]["blockedReason"])
        self.assertIsNone(by["RD2"]["payroll"])

    def test_slips_can_be_listed_per_cycle(self):
        self.post(GEN, {"cycle": "weekly", **WEEK1})
        self.post(GEN, {"cycle": "biweekly", **FORT1})
        base = "/api/salary-slips?month=2&year=2026&employmentType=production"
        self.assertEqual(sorted(s["employeeCode"] for s in self.get(base + "&payCycle=weekly").json()), ["RD1", "RD2"])
        self.assertEqual([s["employeeCode"] for s in self.get(base + "&payCycle=biweekly").json()], ["RD3"])
        self.assertEqual(self.get(base + "&payCycle=monthly").json(), [])
        self.assertEqual(len(self.get(base).json()), 3)
        slip = self.get(base + "&payCycle=biweekly").json()[0]
        self.assertEqual(slip["payCycle"], "biweekly")


class PeriodLookupTests(CycleDbTestCase):
    def test_a_date_adds_the_period_that_holds_it_to_the_list(self):
        _worker("PL1", cycle="weekly")
        body = self.get("/api/payroll/production/periods?cycle=weekly&back=2&around=2025-11-05").json()
        starts = [p["periodStart"] for p in body["periods"]]
        self.assertIn("2025-11-03", starts)  # the Monday week holding Wednesday 5 November 2025
        self.assertEqual(starts, sorted(starts, reverse=True))
        self.assertEqual(len(starts), len(set(starts)))
        recent = [
            p["periodStart"] for p in self.get("/api/payroll/production/periods?cycle=weekly&back=2").json()["periods"]
        ]
        self.assertNotIn("2025-11-03", recent)

    def test_a_date_inside_the_list_changes_nothing_and_a_bad_date_is_refused(self):
        plain = self.get("/api/payroll/production/periods?cycle=weekly&back=3").json()["periods"]
        inside = self.get("/api/payroll/production/periods?cycle=weekly&back=3&around=2026-03-04").json()["periods"]
        self.assertEqual(plain, inside)
        self.assertEqual(self.get("/api/payroll/production/periods?cycle=weekly&around=yesterday").status_code, 400)


class BranchPointerTests(CycleDbTestCase):
    def test_another_branchs_payroll_does_not_move_this_branchs_next_period(self):
        mine, other = Branch.objects.create(name="Mine", code="MIN"), Branch.objects.create(name="Other", code="OTH")
        role = Role.objects.create(name="Branch Prod", permissions={"production_payroll": "edit"})
        branch_hr = _hr("cyc_bptr", super_admin=False, role=role, branch=mine)
        _worker("BP1", cycle="weekly", branch=mine)
        theirs = _worker("BP2", cycle="weekly", branch=other)
        _row(theirs, date(2026, 2, 9), date(2026, 2, 15), cycle="weekly")  # the other branch has paid a later week
        for_branch = self.get("/api/payroll/production/next-period?cycle=weekly", branch_hr).json()
        self.assertEqual(for_branch["periodStart"], "2026-03-02")  # nothing generated here yet: latest ended week
        for_company = self.get("/api/payroll/production/next-period?cycle=weekly").json()
        self.assertEqual(for_company["periodStart"], "2026-02-16")  # the company's pointer follows the paid week
        summary = self.get("/api/payroll/production/cycles", branch_hr).json()
        self.assertEqual({c["cycle"]: c["next"]["periodStart"] for c in summary["cycles"]}["weekly"], "2026-03-02")
