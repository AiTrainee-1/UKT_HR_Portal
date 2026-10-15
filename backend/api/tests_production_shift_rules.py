"""
Production shift rules: the engine (production_shift_rules.py + the production branch of attendance_final.py).

What is pinned here
-------------------
* Golden figures for every row of the owner's table, every band between two rows (hand computed), breaks, grace edges,
  odd / single / no punches, double taps, the Sunday and Night groups, group selection, rounding, minimum credit.
* The night session (a punch the next morning closes a night that began the day before): night only, a day plus the
  dinner return plus 05:30, a forgotten out-punch NOT closed by the next morning's arrival, consecutive nights chaining.
* A month computed by compute_month_records is identical to the same days computed one at a time.
* Hardening of the night session: runs of 8..62 nights in a row, 12 three-shift days in a row, half nights and Sundays in
  the middle (all equal to an unlimited look-back, fixed-point oracle written differently), the closing-punch guard
  (odd count + the derived close-by time + the session hours in whole minutes), days before the effective date and
  MANUAL days neither consuming nor being closed, one extra query only when the chain needs older punches, overlapping
  breaks merged, the cap after the rounding, circular group choice, first-punch window in whole minutes, and every way
  of asking (day, month, range, one-day range, roster prefetch) agreeing on random months.
* Days before the effective date are EXACTLY the legacy calculation: a snapshot of the legacy output over ~900 punch
  patterns, taken from the code BEFORE it was changed (tests_production_legacy_snapshot.json), must still come out.
* An independent, deliberately different implementation (minute by minute) agrees with the engine on hundreds of random
  punch lists, over the owner's rules and over random rule sets.
* Query counts do not grow with the days of a month or the employees of a roster.

Run via: python manage.py test api.tests_production_shift_rules -v 2
"""

import importlib
import json
import math
import random
from datetime import date, time, timedelta
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

from django.apps import apps as django_apps
from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from . import production_shift_rules as psr
from .attendance_final import (
    _compute_production,
    compute_day_record,
    compute_month_records,
    compute_range_records,
    production_day_result,
    production_prefetch_for,
    production_prefetch_for_day,
)
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    PayrollSettings,
    SalarySlip,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
    ProductionShiftSegment,
)

MON = date(2026, 2, 2)  # a Monday
TUE = MON + timedelta(days=1)
WED = MON + timedelta(days=2)
SUN = date(2026, 2, 8)  # a Sunday
SNAPSHOT = json.loads(Path(__file__).with_name("tests_production_legacy_snapshot.json").read_text(encoding="utf-8"))


def _migration():
    return importlib.import_module("api.migrations.0121_production_shift_rules")


def _t(text: str) -> time:
    parts = [int(x) for x in text.split(":")]
    parts += [0] * (3 - len(parts))
    return time(parts[0], parts[1], parts[2])


def S(text: str) -> int:
    """'08:30' -> seconds since the shift day's midnight; a trailing '+' is the next day ('05:30+')."""
    return psr.time_to_s(text.rstrip("+")) + (86400 if text.endswith("+") else 0)


def _config(**overrides):
    values = dict(
        rules_enabled=True,
        rules_effective_from=date(2026, 1, 1),
        rules_grace_minutes=5,
        rules_min_credit=Decimal("0.00"),
        rules_rounding_step=Decimal("0.01"),
        rules_rounding_mode="nearest",
        rules_full_day_value=Decimal("1.00"),
        rules_night_session_hours=24,  # the shipped default (it was 18: 08:30 open + a 05:30 close is 21 h)
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def _default_rows(disabled_rules=(), disabled_groups=(), breaks=True):
    """The owner's seed (the constants of the migration) as lightweight rows, the way the ORM would hand them over."""
    m = _migration()
    meta = [
        (1, "Day shift", "day", "mon_sat", time(8, 30), time(4, 0), time(16, 59, 59), time(20, 0), False, m.DAY_RULES),
        (
            2,
            "Night shift",
            "night",
            "all",
            time(21, 0),
            time(17, 0),
            time(23, 59, 59),
            time(5, 30),
            True,
            m.NIGHT_RULES,
        ),
        (
            3,
            "Sunday shift",
            "sunday",
            "sunday",
            time(8, 30),
            time(4, 0),
            time(16, 59, 59),
            time(17, 0),
            False,
            m.SUNDAY_RULES,
        ),
    ]
    groups, rules = [], []
    for gid, label, kind, applies_on, start, f_from, f_to, main_out, main_next, rule_rows in meta:
        groups.append(
            SimpleNamespace(
                id=gid,
                label=label,
                kind=kind,
                applies_on=applies_on,
                start_time=start,
                first_punch_from=f_from,
                first_punch_to=f_to,
                main_out_time=main_out,
                main_out_next_day=main_next,
                enabled=gid not in disabled_groups,
                order=gid,
            )
        )
        for i, (rule_label, out, out_next, value) in enumerate(rule_rows, start=1):
            rules.append(
                SimpleNamespace(
                    id=gid * 100 + i,
                    group_id=gid,
                    label=rule_label,
                    out_time=out,
                    out_next_day=out_next,
                    shift_value=Decimal(value),
                    enabled=(gid * 100 + i) not in disabled_rules,
                    order=i,
                )
            )
    break_rows = (
        [
            SimpleNamespace(id=i, label=label, start_time=a, end_time=b, enabled=True, order=i)
            for i, (label, a, b) in enumerate(m.BREAKS, start=1)
        ]
        if breaks
        else []
    )
    return groups, rules, break_rows


def ruleset(disabled_rules=(), disabled_groups=(), breaks=True, **config) -> psr.RuleSet:
    groups, rules, break_rows = _default_rows(disabled_rules, disabled_groups, breaks)
    return psr.build_ruleset(_config(**config), groups, rules, break_rows)


def day(punches, d=WED, rs=None) -> dict:
    """The new-rules result of one day: punches are 'HH:MM[:SS]' (a '+' suffix = the next morning)."""
    return psr.evaluate_day(rs or ruleset(), d, [S(p) for p in punches])


def shifts(punches, d=WED, rs=None) -> Decimal:
    return day(punches, d, rs)["shifts_earned"]


D = Decimal


# ═════════════════════════════════════════════════════════════════════════════
#  The table, band by band
# ═════════════════════════════════════════════════════════════════════════════


class OwnersTableTests(SimpleTestCase):
    def test_every_row_of_the_day_table(self):
        for out, value in [
            ("10:30", "0.25"),
            ("12:45", "0.50"),
            ("15:30", "0.75"),
            ("17:45", "1.00"),
            ("20:00", "1.50"),
            ("22:30", "2.00"),
            ("00:30+", "2.50"),
            ("05:30+", "3.00"),
        ]:
            with self.subTest(out=out):
                self.assertEqual(shifts(["08:30", out]), D(value))

    def test_the_night_table(self):
        self.assertEqual(shifts(["21:00", "00:00+"]), D("0.50"))
        self.assertEqual(shifts(["21:00", "05:30+"]), D("1.50"))

    def test_the_sunday_row(self):
        self.assertEqual(shifts(["08:30", "17:00"], SUN), D("1.00"))
        # no rule after 17:00 on a Sunday: capped until HR adds rows
        self.assertEqual(shifts(["08:30", "20:00"], SUN), D("1.00"))
        self.assertEqual(shifts(["08:30", "22:30"], SUN), D("1.00"))
        self.assertEqual(day(["08:30", "17:00"], SUN)["rule_group"], "Sunday shift")

    def test_the_owners_four_punch_days(self):
        self.assertEqual(shifts(["08:30", "12:45", "13:30", "20:00"]), D("1.50"))
        self.assertEqual(shifts(["08:30", "12:45", "13:30", "22:30"]), D("2.00"))
        self.assertEqual(shifts(["08:30", "12:45", "13:30", "20:00", "21:00", "05:30+"]), D("3.00"))
        self.assertEqual(shifts(["08:30", "12:45"]), D("0.50"))
        self.assertEqual(shifts(["08:30", "10:30"]), D("0.25"))

    def test_nobody_has_to_punch_at_a_break(self):
        # 08:30 in and 22:30 out with no lunch or dinner punches earns the same as with them
        self.assertEqual(shifts(["08:30", "22:30"]), shifts(["08:30", "12:45", "13:30", "22:30"]))

    def test_pro_rata_inside_each_band_is_by_paid_minutes(self):
        # hand computed from the table: paid minutes since 08:30 (tea, lunch and dinner removed) between two rows
        for out, value in [
            ("09:30", "0.13"),  # 60 paid of the first 120 -> 0.125 (half up)
            ("11:00", "0.28"),  # 135 paid (tea 10:30-10:45 not paid) -> 0.25 + 15/120 * 0.25 = 0.28125
            ("11:30", "0.34"),  # 165 paid -> 0.34375
            ("14:30", "0.63"),  # 300 paid (lunch and tea not paid) -> 0.625 (half up)
            ("16:30", "0.84"),  # 405 paid -> 0.84375
            ("19:00", "1.25"),  # 540 paid (17:45 tea not paid) -> 1.0 + 60/120 * 0.5
            ("21:30", "1.67"),  # 630 paid (dinner not paid) -> 1.5 + 30/90 * 0.5
            ("23:30", "2.25"),  # 750 paid -> 2.0 + 60/120 * 0.5
            ("03:00+", "2.75"),  # 960 paid -> 2.5 + 150/300 * 0.5
            ("06:30+", "3.00"),  # past the last row: capped
            ("09:30+", "3.00"),
        ]:
            with self.subTest(out=out):
                self.assertEqual(shifts(["08:30", out]), D(value))

    def test_night_bands(self):
        self.assertEqual(shifts(["21:00", "22:00"]), D("0.17"))  # 60 of 180 paid minutes -> 0.1667
        self.assertEqual(shifts(["21:00", "02:00+"]), D("0.86"))  # 300 paid -> 0.5 + 120/330
        self.assertEqual(shifts(["21:00", "07:00+"]), D("1.50"))  # capped

    def test_breaks_are_flat(self):
        # leaving inside a break earns exactly what the start of the break earned
        self.assertEqual(shifts(["08:30", "10:40"]), D("0.25"))
        self.assertEqual(shifts(["08:30", "13:00"]), D("0.50"))
        self.assertEqual(shifts(["08:30", "17:50"]), D("1.00"))
        self.assertEqual(shifts(["08:30", "20:30"]), D("1.50"))
        # a pair that lies entirely inside a break is worth nothing
        self.assertEqual(shifts(["08:30", "10:30", "10:35", "10:40"]), D("0.25"))

    def test_first_punch_early_or_within_grace_loses_nothing(self):
        for first in ("04:00", "08:00", "08:30", "08:34", "08:35"):
            with self.subTest(first=first):
                self.assertEqual(shifts([first, "20:00"]), D("1.50"))

    def test_a_late_first_punch_loses_value_at_the_bands_rate(self):
        self.assertEqual(shifts(["08:36", "20:00"]), D("1.49"))  # 6 paid minutes * 0.25/120 = 0.0125 lost
        self.assertEqual(shifts(["08:45", "20:00"]), D("1.47"))  # 0.03125 lost -> 1.46875
        self.assertEqual(shifts(["10:00", "20:00"]), D("1.31"))  # 90 minutes in -> 0.1875 lost -> 1.3125
        self.assertTrue(day(["08:36", "20:00"])["is_late"])
        self.assertFalse(day(["08:35", "20:00"])["is_late"])

    def test_grace_snaps_an_out_punch_up_to_the_ladder_point(self):
        self.assertEqual(shifts(["08:30", "17:42"]), D("1.00"))  # the 17:45 value
        self.assertEqual(shifts(["08:30", "17:44"]), D("1.00"))
        self.assertEqual(shifts(["08:30", "17:41"]), D("1.00"))
        self.assertEqual(shifts(["08:30", "17:40"]), D("0.99"))  # a full 5 minutes early: interpolated
        self.assertEqual(shifts(["08:30", "19:56"]), D("1.50"))
        self.assertEqual(shifts(["08:30", "19:55"]), D("1.48"))
        self.assertEqual(shifts(["08:30", "19:30"]), D("1.38"))
        # seconds do not count: 17:40:59 is the minute 17:40
        self.assertEqual(psr.evaluate_day(ruleset(), WED, [S("08:30"), S("17:40:59")])["shifts_earned"], D("0.99"))
        self.assertEqual(psr.evaluate_day(ruleset(), WED, [S("08:30"), S("17:41:59")])["shifts_earned"], D("1.00"))

    def test_grace_is_editable_and_zero_means_no_snap(self):
        self.assertEqual(shifts(["08:30", "17:42"], rs=ruleset(rules_grace_minutes=0)), D("0.99"))
        self.assertEqual(shifts(["08:30", "17:36"], rs=ruleset(rules_grace_minutes=10)), D("1.00"))
        self.assertEqual(shifts(["08:30", "17:35"], rs=ruleset(rules_grace_minutes=10)), D("0.98"))  # a full 10 early
        self.assertEqual(shifts(["08:40", "20:00"], rs=ruleset(rules_grace_minutes=10)), D("1.50"))
        self.assertFalse(day(["08:40", "20:00"], rs=ruleset(rules_grace_minutes=10))["is_late"])

    def test_a_worker_who_leaves_at_lunch_and_returns_late_is_paid_the_intervals(self):
        # 08:30-12:45 = 0.50; 16:00-20:00 = V(20:00) - V(16:00) = 1.5 - 0.78125; the gap outside the breaks is unpaid
        self.assertEqual(shifts(["08:30", "12:45", "16:00", "20:00"]), D("1.22"))
        self.assertEqual(shifts(["08:30", "12:45", "13:30", "20:00"]), D("1.50"))

    def test_odd_counts_ignore_the_open_last_punch(self):
        self.assertEqual(shifts(["08:30", "12:45", "13:30"]), D("0.50"))
        self.assertEqual(shifts(["08:30", "12:45", "13:30", "20:00", "21:00"]), D("1.50"))
        self.assertEqual(shifts(["08:30", "10:30", "12:45"]), D("0.25"))

    def test_one_punch_is_present_but_unpaid_and_none_is_absent(self):
        one = day(["08:30"])
        self.assertEqual((one["shifts_earned"], one["status"], one["is_half_shift"]), (D("0.00"), "half_shift", True))
        self.assertIsNone(one["last_punch"])
        self.assertFalse(one["early_leave"])
        none = psr.evaluate_day(ruleset(), WED, [])
        self.assertEqual((none["status"], none["shifts_earned"]), ("absent", D("0")))

    def test_a_double_tap_is_one_punch(self):
        # 08:30:00 and 08:30:40 are one arrival; five punches would otherwise flip in and out
        taps = [S("08:30:00"), S("08:30:40"), S("12:45"), S("13:30"), S("20:00:20"), S("20:01:00")]
        r = psr.evaluate_day(ruleset(), WED, taps)
        self.assertEqual(r["shifts_earned"], D("1.50"))
        # but two punches 5 minutes apart are two punches
        r = psr.evaluate_day(ruleset(), WED, [S("08:30"), S("08:35")])
        self.assertEqual(r["shifts_earned"], D("0.01"))

    def test_status_follows_the_full_day_value(self):
        self.assertEqual(day(["08:30", "17:45"])["status"], "present")  # 1.00 is not below 1.00
        self.assertEqual(day(["08:30", "17:40"])["status"], "half_shift")  # 0.99
        r = day(["08:30", "15:30"], rs=ruleset(rules_full_day_value=D("0.75")))
        self.assertEqual((r["status"], r["is_half_shift"]), ("present", False))

    def test_first_and_last_punch_are_the_resolved_clock_times(self):
        r = day(["21:00", "05:30+"])
        self.assertEqual((r["first_punch"], r["last_punch"]), (time(21, 0), time(5, 30)))
        r = day(["08:30:15", "12:45", "13:30", "20:00:40"])
        self.assertEqual((r["first_punch"], r["last_punch"]), (time(8, 30, 15), time(20, 0, 40)))

    def test_late_and_early_flags(self):
        self.assertFalse(day(["08:35", "20:00"])["is_late"])
        self.assertTrue(day(["08:36", "20:00"])["is_late"])
        self.assertFalse(day(["08:30", "19:55"])["early_leave"])  # exactly grace early is not early
        self.assertTrue(day(["08:30", "19:54"])["early_leave"])
        self.assertTrue(day(["08:30", "12:45"])["early_leave"])
        self.assertFalse(day(["08:30", "22:30"])["early_leave"])
        night = day(["21:00", "05:30+"])
        self.assertFalse(night["early_leave"])
        self.assertTrue(day(["21:00", "03:00+"])["early_leave"])
        self.assertTrue(day(["21:10", "05:30+"])["is_late"])

    def test_rounding_modes_and_steps(self):
        self.assertEqual(shifts(["08:30", "11:30"]), D("0.34"))  # 0.34375
        q = ruleset(rules_rounding_step=D("0.25"))
        self.assertEqual(shifts(["08:30", "11:30"], rs=q), D("0.25"))  # 0.34375 -> nearest 0.25
        self.assertEqual(shifts(["08:30", "12:15"], rs=q), D("0.50"))  # 0.4375 -> 0.50
        self.assertEqual(shifts(["08:30", "16:30"], rs=q), D("0.75"))  # 0.84375 -> 0.75
        self.assertEqual(shifts(["08:30", "09:30"], rs=ruleset(rules_rounding_step=D("0.05"))), D("0.15"))  # 0.125
        down = ruleset(rules_rounding_step=D("0.25"), rules_rounding_mode="down")
        self.assertEqual(shifts(["08:30", "16:30"], rs=down), D("0.75"))
        self.assertEqual(shifts(["08:30", "19:30"], rs=down), D("1.25"))  # 1.375 -> 1.25
        self.assertEqual(shifts(["08:30", "11:30"], rs=ruleset(rules_rounding_mode="down")), D("0.34"))
        self.assertEqual(shifts(["08:30", "09:30"], rs=ruleset(rules_rounding_mode="down")), D("0.12"))  # 0.125 down
        self.assertEqual(shifts(["08:30", "09:30"]), D("0.13"))  # nearest: half up, never banker's rounding

    def test_minimum_credit_needs_a_complete_pair(self):
        rs = ruleset(rules_min_credit=D("0.25"))
        self.assertEqual(shifts(["08:30", "08:40"], rs=rs), D("0.25"))  # 10 minutes would be 0.02
        self.assertEqual(shifts(["08:30"], rs=rs), D("0.00"))  # one punch is not a pair
        self.assertEqual(shifts(["08:30", "12:45"], rs=rs), D("0.50"))  # above the minimum: unchanged
        self.assertIn("minimum credit", day(["08:30", "08:40"], rs=rs)["rule_note"])

    def test_disabled_rule_and_disabled_group(self):
        # without the 17:45 row the ladder runs 15:30 (0.75, 360 paid) -> 20:00 (1.50, 600 paid)
        rs = ruleset(disabled_rules={104})
        self.assertEqual(shifts(["08:30", "17:45"], rs=rs), D("1.13"))  # 0.75 + 120/240 * 0.75 = 1.125
        self.assertEqual(shifts(["08:30", "20:00"], rs=rs), D("1.50"))
        # a disabled group: the Night group (applies every day) judges a Monday-Saturday day that fits no other
        rs = ruleset(disabled_groups={1})
        self.assertEqual(day(["08:30", "20:00"], rs=rs)["rule_group"], "Night shift")
        # a group whose rules are all disabled is dropped, not an error
        rs = ruleset(disabled_rules={301})
        self.assertEqual([g.label for g in rs.groups], ["Day shift", "Night shift"])
        # no group left at all: nothing to judge by (callers fall back to the legacy calculation)
        every = ruleset(disabled_groups={1, 2, 3})
        self.assertEqual(every.groups, ())
        self.assertFalse(every.applies(WED))
        self.assertIsNone(psr.evaluate_day(every, WED, [S("08:30"), S("20:00")]))

    def test_a_rule_at_or_before_the_start_is_ignored(self):
        groups, rules, breaks = _default_rows()
        rules.append(
            SimpleNamespace(
                id=999,
                group_id=1,
                label="bad",
                out_time=time(8, 0),
                out_next_day=False,
                shift_value=D("9.00"),
                enabled=True,
                order=99,
            )
        )
        rs = psr.build_ruleset(_config(), groups, rules, breaks)
        self.assertEqual(shifts(["08:30", "20:00"], rs=rs), D("1.50"))

    def test_every_figure_is_an_exact_two_decimal_decimal(self):
        rng = random.Random(5)
        rs = ruleset()
        for _ in range(200):
            punches = _random_punches(rng, _owner_cfg())
            result = psr.evaluate_day(rs, WED, punches)
            value = result["shifts_earned"]
            self.assertIsInstance(value, Decimal)
            if punches:
                self.assertEqual(value.as_tuple().exponent, -2)
                self.assertEqual(value, value.quantize(Decimal("0.01")))
                self.assertLessEqual(value, Decimal("3.00"))
                self.assertGreaterEqual(value, Decimal("0.00"))

    def test_notes_are_one_plain_sentence(self):
        self.assertEqual(
            day(["08:30", "17:50"])["rule_note"],
            "Day shift: left 17:50, 1.00 shift (17:45 rule)",
        )
        self.assertEqual(
            day(["08:30", "19:00"])["rule_note"],
            "Day shift: left 19:00, between 17:45 (1.00) and 20:00 (1.50): 1.25",
        )
        self.assertEqual(
            day(["08:30", "17:42"])["rule_note"],
            "Day shift: left 17:42, counted as 17:45 within the 5 min grace, 1.00 shift (17:45 rule)",
        )
        self.assertIn("past the last rule 05:30 (3.00)", day(["08:30", "07:00+"])["rule_note"])
        self.assertIn("arrived 09:00", day(["09:00", "20:00"])["rule_note"])
        self.assertIn("only one punch", day(["08:30"])["rule_note"])
        self.assertIn("no pair and is ignored", day(["08:30", "12:45", "13:30"])["rule_note"])
        self.assertTrue(
            day(["08:30", "12:45", "13:30", "20:00"])["rule_note"].startswith("Day shift: worked 08:30-12:45")
        )


# ═════════════════════════════════════════════════════════════════════════════
#  Which group judges the day
# ═════════════════════════════════════════════════════════════════════════════


class GroupSelectionTests(SimpleTestCase):
    def pick(self, first, d=WED, rs=None):
        g = psr.select_group(rs or ruleset(), d, S(first))
        return g.label if g else None

    def test_window_edges(self):
        self.assertEqual(self.pick("04:00"), "Day shift")
        self.assertEqual(self.pick("16:59"), "Day shift")
        self.assertEqual(self.pick("16:59:59"), "Day shift")
        self.assertEqual(self.pick("17:00"), "Night shift")
        self.assertEqual(self.pick("23:59"), "Night shift")

    def test_outside_every_window_the_nearest_start_wins(self):
        self.assertEqual(self.pick("03:59"), "Day shift")  # 4h31 from 08:30, 6h59 from 21:00
        # circular distance on the clock: 00:30 is 3h30 from 21:00 but 8h from 08:30
        self.assertEqual(self.pick("00:30"), "Night shift")
        self.assertEqual(self.pick("02:00"), "Night shift")  # 5h from 21:00, 6h30 from 08:30
        self.assertEqual(self.pick("03:30"), "Day shift")  # 6h30 from 21:00 against 5h from 08:30

    def test_sunday_uses_the_sunday_group_for_a_morning_punch(self):
        self.assertEqual(self.pick("08:30", SUN), "Sunday shift")
        self.assertEqual(self.pick("08:30", MON), "Day shift")
        self.assertEqual(self.pick("21:00", SUN), "Night shift")  # the Night group applies every day

    def test_no_group_for_the_weekday(self):
        groups, rules, breaks = _default_rows(disabled_groups={1, 2})
        rs = psr.build_ruleset(_config(), groups, rules, breaks)
        self.assertIsNone(psr.select_group(rs, MON, S("08:30")))
        self.assertIsNone(psr.evaluate_day(rs, MON, [S("08:30"), S("17:00")]))
        self.assertEqual(psr.select_group(rs, SUN, S("08:30")).label, "Sunday shift")

    def test_order_decides_between_overlapping_windows(self):
        groups, rules, breaks = _default_rows()
        groups[1].first_punch_from = time(4, 0)  # the Night window now overlaps the Day one
        rs = psr.build_ruleset(_config(), groups, rules, breaks)
        self.assertEqual(self.pick("08:30", rs=rs), "Day shift")

    def test_judge_day_for_a_stored_record(self):
        rs = ruleset()
        j = psr.judge_day(rs, WED, time(8, 41), time(19, 30))
        self.assertEqual(
            (j.group.label, j.is_late, j.late_minutes, j.early_leave, j.early_minutes),
            ("Day shift", True, 11, True, 30),
        )
        self.assertEqual((j.start_time, j.main_out_time, j.grace_minutes), (time(8, 30), time(20, 0), 5))
        ok = psr.judge_day(rs, WED, time(8, 35), time(19, 55))
        self.assertEqual((ok.is_late, ok.early_leave), (False, False))
        night = psr.judge_day(rs, WED, time(21, 0), time(5, 30))  # 05:30 is the next morning
        self.assertEqual(
            (night.group.label, night.is_late, night.early_leave, night.main_out_next_day),
            ("Night shift", False, False, True),
        )
        early = psr.judge_day(rs, WED, time(21, 0), time(3, 0))
        self.assertEqual((early.early_leave, early.early_minutes), (True, 150))
        alone = psr.judge_day(rs, WED, time(8, 30), None)
        self.assertEqual((alone.is_late, alone.early_leave), (False, False))
        self.assertIsNone(psr.judge_day(ruleset(disabled_groups={1, 2, 3}), WED, time(8, 30), None).group)


# ═════════════════════════════════════════════════════════════════════════════
#  The night session
# ═════════════════════════════════════════════════════════════════════════════


def _by_date(spec: dict) -> dict:
    """{date: ['HH:MM', ...]} -> {date: [(seconds, label)]} the way resolve_day wants it."""
    return {d: [(S(p), f"{d.isoformat()} {p}") for p in times] for d, times in spec.items()}


def _resolved(spec: dict, d: date, hours: int = 12) -> list:
    return [(s, ref) for s, ref in psr.resolve_day(_by_date(spec), d, hours)]


def _secs(spec: dict, d: date, hours: int = 12) -> list:
    return [s for s, _ref in _resolved(spec, d, hours)]


class NightSessionTests(SimpleTestCase):
    def test_night_only_worker_gets_the_morning_punch_on_the_day_the_night_began(self):
        spec = {MON: ["21:00"], TUE: ["05:30"]}
        self.assertEqual(_secs(spec, MON), [S("21:00"), S("05:30+")])
        self.assertEqual(_secs(spec, TUE), [])  # the 05:30 belongs to Monday's night
        r = psr.evaluate_day(ruleset(), MON, _secs(spec, MON))
        self.assertEqual(r["shifts_earned"], D("1.50"))
        self.assertEqual((r["first_punch"], r["last_punch"]), (time(21, 0), time(5, 30)))

    def test_day_then_dinner_then_the_next_morning(self):
        spec = {MON: ["08:30", "12:45", "13:30", "20:00", "21:00"], TUE: ["05:30"]}
        resolved = _secs(spec, MON)
        self.assertEqual(len(resolved), 6)
        self.assertEqual(psr.evaluate_day(ruleset(), MON, resolved)["shifts_earned"], D("3.00"))
        self.assertEqual(_secs(spec, TUE), [])

    def test_a_forgotten_out_punch_is_not_closed_by_the_next_mornings_arrival(self):
        spec = {MON: ["08:30", "12:45", "13:30"], TUE: ["08:25", "12:45", "13:30", "20:00"]}
        self.assertEqual(_secs(spec, MON), [S("08:30"), S("12:45"), S("13:30")])  # the gap is 18h55
        self.assertEqual(_secs(spec, TUE), [S("08:25"), S("12:45"), S("13:30"), S("20:00")])
        self.assertEqual(psr.evaluate_day(ruleset(), MON, _secs(spec, MON))["shifts_earned"], D("0.50"))
        # Tuesday is judged on its own punches
        self.assertEqual(psr.evaluate_day(ruleset(), TUE, _secs(spec, TUE))["shifts_earned"], D("1.50"))

    def test_the_gap_limit_is_inclusive_and_editable(self):
        self.assertEqual(len(_secs({MON: ["21:00"], TUE: ["09:00"]}, MON)), 2)  # exactly 12h
        self.assertEqual(len(_secs({MON: ["21:00"], TUE: ["09:01"]}, MON)), 1)
        self.assertEqual(len(_secs({MON: ["21:00"], TUE: ["09:01"]}, MON, hours=13)), 2)
        self.assertEqual(len(_secs({MON: ["21:00"], TUE: ["05:30"]}, MON, hours=8)), 1)  # 8h30 > 8h

    def test_an_even_count_closes_nothing(self):
        spec = {MON: ["08:30", "20:00"], TUE: ["05:30", "21:00"]}
        self.assertEqual(_secs(spec, MON), [S("08:30"), S("20:00")])
        self.assertEqual(_secs(spec, TUE), [S("05:30"), S("21:00")])

    def test_consecutive_nights_chain_day_after_day(self):
        # nights begin Mon..Fri 21:00 and end the next morning 05:30
        spec = {MON: ["21:00"]}
        for i in range(1, 5):
            spec[MON + timedelta(days=i)] = ["05:30", "21:00"]
        spec[MON + timedelta(days=5)] = ["05:30"]
        for i in range(5):
            d = MON + timedelta(days=i)
            with self.subTest(night=i):
                self.assertEqual(_secs(spec, d), [S("21:00"), S("05:30+")])
                self.assertEqual(psr.evaluate_day(ruleset(), d, _secs(spec, d))["shifts_earned"], D("1.50"))
        self.assertEqual(_secs(spec, MON + timedelta(days=5)), [])

    def test_the_chain_resolves_the_same_for_every_day_asked(self):
        # a 6-night chain with a day worker's week before it: the answer for a day never depends on how far back we start
        spec = {MON - timedelta(days=3): ["08:30", "12:45", "13:30", "20:00"], MON: ["21:00"]}
        for i in range(1, 6):
            spec[MON + timedelta(days=i)] = ["05:30", "21:00"]
        spec[MON + timedelta(days=6)] = ["05:30"]
        by = _by_date(spec)
        for i in range(6):
            d = MON + timedelta(days=i)
            full = [s for s, _r in psr.resolve_day(by, d, 12, lookback=7)]
            deeper = [s for s, _r in psr.resolve_day(by, d, 12, lookback=14)]
            self.assertEqual(full, deeper)

    def test_double_taps_do_not_flip_the_count(self):
        spec = {MON: ["21:00", "21:02"], TUE: ["05:30", "05:31"]}
        self.assertEqual(_secs(spec, MON), [S("21:00"), S("05:30+")])

    def test_the_closing_punch_keeps_its_own_record(self):
        resolved = _resolved({MON: ["21:00"], TUE: ["05:30"]}, MON)
        self.assertEqual(resolved[1][1], f"{TUE.isoformat()} 05:30")

    def test_a_night_that_starts_on_sunday_uses_the_night_group(self):
        spec = {SUN: ["21:00"], SUN + timedelta(days=1): ["05:30"]}
        r = psr.evaluate_day(ruleset(), SUN, _secs(spec, SUN))
        self.assertEqual((r["rule_group"], r["shifts_earned"]), ("Night shift", D("1.50")))

    def test_evaluate_with_session_is_the_whole_pipeline(self):
        rs = ruleset()
        by = {MON: [time(21, 0)], TUE: [time(5, 30)]}
        self.assertEqual(psr.evaluate_with_session(rs, MON, by)["shifts_earned"], D("1.50"))
        self.assertEqual(psr.evaluate_with_session(rs, TUE, by)["status"], "absent")
        before = ruleset(rules_effective_from=MON + timedelta(days=1))
        self.assertIsNone(psr.evaluate_with_session(before, MON, by))  # before the effective date: not judged here


# ═════════════════════════════════════════════════════════════════════════════
#  Days before the effective date are the legacy calculation, byte for byte
# ═════════════════════════════════════════════════════════════════════════════

_LEGACY_SEGMENTS = [
    ("Morning 1", "08:30", "10:30", "0.25"),
    ("Morning 2", "10:30", "12:45", "0.25"),
    ("Afternoon 1", "13:30", "15:30", "0.25"),
    ("Afternoon 2", "15:30", "17:30", "0.25"),
    ("Evening", "17:30", "20:00", "0.50"),
]


def _legacy_segments():
    return [
        ProductionShiftSegment(label=label, start_time=_t(a), end_time=_t(b), shift_value=Decimal(v), is_active=True)
        for label, a, b, v in _LEGACY_SEGMENTS
    ]


def _legacy_config(name):
    if name == "alt":
        return ProductionShiftConfig(punch1_time=time(9, 0), punch4_time=time(18, 0), grace_minutes=5)
    if name == "grace0":
        return ProductionShiftConfig(grace_minutes=0)
    return ProductionShiftConfig()


def _legacy_text(result, times) -> str:
    if not times:
        return f"{result['status']}|{result['shifts_earned']}"
    last = result["last_punch"]
    return "|".join(
        [
            str(result["shifts_earned"]),
            result["status"],
            str(result["is_late"]),
            str(result["is_half_shift"]),
            str(result["early_leave"]),
            result["first_punch"].strftime("%H:%M:%S"),
            last.strftime("%H:%M:%S") if last else "-",
        ]
    )


class LegacySnapshotTests(SimpleTestCase):
    """The legacy calculation, untouched: the snapshot was taken from the code before this work began."""

    def test_the_legacy_function_still_gives_the_recorded_answers(self):
        segments = _legacy_segments()
        checked = 0
        for name, entries in SNAPSHOT.items():
            config = _legacy_config(name)
            for key, expected in entries.items():
                times = [_t(x) for x in key.split(",")] if key else []
                got = _legacy_text(_compute_production(None, None, times, None, config, segments), times)
                self.assertEqual(got, expected, f"{name}: {key or '(no punches)'}")
                checked += 1
        self.assertGreater(checked, 900)

    def test_the_legacy_settings_are_never_touched_by_the_new_rules(self):
        config = ProductionShiftConfig()
        self.assertEqual(config.grace_minutes, 10)  # the legacy grace stays 10; the new one is its own field
        self.assertEqual(config.rules_grace_minutes, 5)
        self.assertEqual(
            (config.punch1_time, config.punch2_time, config.punch3_time, config.punch4_time),
            (time(8, 30), time(12, 45), time(13, 30), time(20, 0)),
        )


# ═════════════════════════════════════════════════════════════════════════════
#  The independent implementation: minute by minute
# ═════════════════════════════════════════════════════════════════════════════


def indep_shifts(cfg: dict, punches_s: list) -> Decimal:
    """A deliberately different way to get a day's shifts: walk every MINUTE a worker is on the clock and add that
    minute's rate. cfg: start (minute of day), points [(out minute since the shift day's midnight, value)], breaks
    [(start minute, end minute)] (repeated daily), grace, min_credit, step, mode."""
    kept = []
    for s in sorted(punches_s):
        if kept and s - kept[-1] < 300:
            continue
        kept.append(s)
    mins = [s // 60 for s in kept]
    pairs = len(mins) // 2
    if pairs == 0:
        return Decimal("0.00")
    start, grace = cfg["start"], cfg["grace"]
    points = sorted((o, Fraction(v)) for o, v in cfg["points"] if o > start)
    horizon = 3 * 1440 + 10

    def in_break(m):
        return any(b0 + 1440 * k <= m < b1 + 1440 * k for b0, b1 in cfg["breaks"] for k in (0, 1, 2))

    paid_before, running = {}, 0
    for m in range(start, horizon):
        paid_before[m] = running
        if not in_break(m):
            running += 1
    bands = []
    prev_paid, prev_value = 0, Fraction(0)
    for o, v in points:
        paid = paid_before[o]
        bands.append((prev_paid, paid, prev_value, v))
        prev_paid, prev_value = paid, v

    def minute_rate(m):
        if m < start or in_break(m):
            return Fraction(0)
        k = paid_before[m]
        for lo, hi, v0, v1 in bands:
            if lo <= k < hi:
                return (v1 - v0) / (hi - lo)
        return Fraction(0)

    total = Fraction(0)
    for i in range(pairs):
        a, b = mins[2 * i], mins[2 * i + 1]
        if i == 0 and a <= start + grace:
            a = start
        nxt = mins[2 * i + 2] if 2 * i + 2 < len(mins) else None
        for o, _v in points:
            if o >= b and o - b < grace:
                b = o if nxt is None else min(o, nxt)
                break
        total += sum((minute_rate(m) for m in range(a, b)), Fraction(0))
    if total < Fraction(cfg["min_credit"]):
        total = Fraction(cfg["min_credit"])
    step = Fraction(cfg["step"])
    units = total / step
    n = math.floor(units) if cfg["mode"] == "down" else math.floor(units + Fraction(1, 2))
    rounded = n * step
    if points:  # the cap comes AFTER the rounding
        rounded = min(rounded, points[-1][1])
    return (Decimal(rounded.numerator) / Decimal(rounded.denominator)).quantize(Decimal("0.01"))


def _owner_cfg(**over) -> dict:
    m = _migration()
    points = []
    for _label, out, nxt, value in m.DAY_RULES:
        points.append((out.hour * 60 + out.minute + (1440 if nxt else 0), value))
    cfg = dict(
        start=510,
        points=points,
        breaks=[(a.hour * 60 + a.minute, b.hour * 60 + b.minute) for _l, a, b in m.BREAKS],
        grace=5,
        min_credit="0",
        step="0.01",
        mode="nearest",
    )
    cfg.update(over)
    return cfg


def _rows_for(cfg: dict):
    """The rows (as the ORM would hand them over) of ONE all-day group built from an independent-implementation cfg."""
    group = SimpleNamespace(
        id=1,
        label="Random",
        kind="custom",
        applies_on="all",
        start_time=psr.s_to_time(cfg["start"] * 60),
        first_punch_from=time(0, 0),
        first_punch_to=time(23, 59, 59),
        main_out_time=None,
        main_out_next_day=False,
        enabled=True,
        order=1,
    )
    rules = [
        SimpleNamespace(
            id=i,
            group_id=1,
            label="",
            out_time=psr.s_to_time((o % 1440) * 60),
            out_next_day=o >= 1440,
            shift_value=Decimal(str(v)),
            enabled=True,
            order=i,
        )
        for i, (o, v) in enumerate(cfg["points"], start=1)
    ]
    breaks = [
        SimpleNamespace(
            id=i,
            label="",
            start_time=psr.s_to_time(a * 60),
            end_time=psr.s_to_time(b * 60),
            enabled=True,
            order=i,
        )
        for i, (a, b) in enumerate(cfg["breaks"], start=1)
    ]
    return [group], rules, breaks


def _paid_before_points(cfg: dict) -> list:
    """Paid minutes at each ladder point, counted minute by minute (independent of the module)."""

    def in_break(m):
        return any(b0 + 1440 * k <= m < b1 + 1440 * k for b0, b1 in cfg["breaks"] for k in (0, 1, 2))

    out = []
    for o, _v in cfg["points"]:
        out.append(sum(1 for m in range(cfg["start"], o) if not in_break(m)))
    return out


def _random_cfg(rng: random.Random) -> dict:
    """A random rule set whose points are told apart by PAID time (two points with the same paid time, or one at paid
    zero, cannot be told apart by a function of paid time: see DegeneratePointTests)."""
    while True:
        cfg = _random_cfg_once(rng)
        paid = _paid_before_points(cfg)
        if paid and paid[0] > 0 and all(b > a for a, b in zip(paid, paid[1:])):
            return cfg


def _random_cfg_once(rng: random.Random) -> dict:
    start = rng.choice([360, 480, 510, 540, 600, 1260])
    cuts = sorted(rng.sample(range(0, 1440), 2 * rng.randint(0, 4)))
    breaks = [(cuts[i], cuts[i + 1]) for i in range(0, len(cuts), 2)]
    outs = sorted(rng.sample(range(start + 1, min(start + 1800, 2879)), rng.randint(1, 8)))
    value = Decimal("0")
    points = []
    for i, o in enumerate(outs):
        value += (
            rng.choice([Decimal("0.05"), Decimal("0.25"), Decimal("0.5")])
            if i == 0
            else rng.choice([Decimal("0"), Decimal("0.05"), Decimal("0.25"), Decimal("0.5"), Decimal("1")])
        )
        points.append((o, value))
    return dict(
        start=start,
        points=points,
        breaks=breaks,
        grace=rng.randint(0, 10),
        min_credit=rng.choice(["0", "0", "0.25"]),
        step=rng.choice(["0.01", "0.05", "0.25"]),
        mode=rng.choice(["nearest", "down"]),
    )


def _random_punches(rng: random.Random, cfg: dict) -> list:
    n = rng.choice([0, 1, 2, 2, 3, 4, 4, 4, 5, 6, 7])
    out = []
    for _ in range(n):
        roll = rng.random()
        if roll < 0.35 and cfg["points"]:
            minute = rng.choice(cfg["points"])[0] - rng.randint(-2, 7)
        elif roll < 0.45:
            minute = cfg["start"] + cfg["grace"] + rng.randint(-2, 2)
        elif roll < 0.55 and cfg["breaks"]:
            b = rng.choice(cfg["breaks"])
            minute = rng.randint(b[0] - 3, b[1] + 3)
        else:
            minute = rng.randint(max(0, cfg["start"] - 120), min(2879, cfg["start"] + 1700))
        minute = max(0, min(2879, minute))
        out.append(minute * 60 + rng.choice([0, 0, 0, 7, 30, 59]))
    return out


class DifferentialTests(SimpleTestCase):
    def _compare(self, cfg, punches, label):
        groups, rules, breaks = _rows_for(cfg)
        rs = psr.build_ruleset(
            _config(
                rules_grace_minutes=cfg["grace"],
                rules_min_credit=Decimal(cfg["min_credit"]),
                rules_rounding_step=Decimal(cfg["step"]),
                rules_rounding_mode=cfg["mode"],
            ),
            groups,
            rules,
            breaks,
        )
        got = psr.evaluate_day(rs, WED, punches)
        expected = indep_shifts(cfg, punches)
        if not punches:
            self.assertEqual(got["shifts_earned"], Decimal("0"))
            return
        self.assertEqual(
            got["shifts_earned"], expected, f"{label}: punches={[(p // 60) for p in sorted(punches)]} cfg={cfg}"
        )

    def test_the_owners_rules_on_random_punch_lists(self):
        rng = random.Random(20261014)
        cfg = _owner_cfg()
        for i in range(500):
            punches = _random_punches(rng, cfg)
            self._compare(cfg, punches, f"owner #{i}")

    def test_the_owners_rules_with_every_grace(self):
        rng = random.Random(77)
        for grace in (0, 1, 3, 5, 10, 30):
            cfg = _owner_cfg(grace=grace)
            for i in range(60):
                self._compare(cfg, _random_punches(rng, cfg), f"grace {grace} #{i}")

    def test_random_rule_sets_on_random_punch_lists(self):
        rng = random.Random(4242)
        for i in range(400):
            cfg = _random_cfg(rng)
            self._compare(cfg, _random_punches(rng, cfg), f"random set #{i}")


class ParsePunchListTests(SimpleTestCase):
    def test_a_time_not_later_than_the_one_before_is_the_next_morning(self):
        self.assertEqual(
            psr.parse_punch_list(["08:30", "12:45", "13:30", "20:00", "21:00", "05:30"]),
            [S("08:30"), S("12:45"), S("13:30"), S("20:00"), S("21:00"), S("05:30+")],
        )
        self.assertEqual(psr.parse_punch_list(["21:00", "00:00"]), [S("21:00"), S("00:00+")])
        self.assertEqual(psr.parse_punch_list(["08:30", "08:30"]), [S("08:30"), S("08:30+")])
        self.assertEqual(psr.parse_punch_list([]), [])

    def test_bad_times_are_refused(self):
        for bad in ("8", "25:00", "08:61", "ab:cd", "08:30:99", ""):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                psr.parse_punch_list([bad])


class DegeneratePointTests(SimpleTestCase):
    """Two ladder points with the same PAID time (12:45 and 13:30 are either side of the same lunch) cannot be told
    apart by a value that depends on paid time: the later, higher point wins from that paid time on, and the earlier
    one still ramps up to its own value. The Settings page warns about a ladder point inside a break."""

    def test_the_later_point_wins_at_a_shared_paid_time(self):
        groups, rules, breaks = _default_rows()
        rules.append(
            SimpleNamespace(
                id=998,
                group_id=1,
                label="after lunch",
                out_time=time(13, 30),
                out_next_day=False,
                shift_value=D("0.60"),
                enabled=True,
                order=99,
            )
        )
        rs = psr.build_ruleset(_config(rules_grace_minutes=0), groups, rules, breaks)
        self.assertEqual(shifts(["08:30", "12:44"], rs=rs), D("0.50"))  # still the ramp to 12:45's 0.50 (0.4979)
        self.assertEqual(shifts(["08:30", "12:45"], rs=rs), D("0.60"))
        self.assertEqual(shifts(["08:30", "13:30"], rs=rs), D("0.60"))
        self.assertEqual(shifts(["08:30", "15:30"], rs=rs), D("0.75"))


# ═════════════════════════════════════════════════════════════════════════════
#  The database: seed, the engine inside compute_day_record, effective date, equivalence, queries
# ═════════════════════════════════════════════════════════════════════════════


def _ensure_seed():
    """The migration seeds the three groups and the breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        _migration().seed(django_apps, None)


def _set_rules(effective_from=date(2026, 1, 1), **fields):
    config = ProductionShiftConfig.get()
    config.rules_effective_from = effective_from
    for key, value in fields.items():
        setattr(config, key, value)
    config.save()
    return config


def _worker(code="PS1", per_shift="500.00") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Worker",
        employment_type="production",
        status="active",
        salary_per_shift=Decimal(per_shift),
    )


def _punch(emp, d, hhmm, kind="IN"):
    return AttendanceLog.objects.create(employee=emp, date=d, punch_time=_t(hhmm), punch_type=kind, source="manual")


def _punches(emp, d, *times):
    for hhmm in times:
        _punch(emp, d, hhmm)


def _record(emp, d):
    return AttendanceDayRecord.objects.get(employee=emp, date=d)


class SeedTests(TestCase):
    def setUp(self):
        _ensure_seed()

    def test_the_seed_is_exactly_the_owners_table(self):
        groups = list(ProductionShiftGroup.objects.order_by("order"))
        self.assertEqual([g.label for g in groups], ["Day shift", "Night shift", "Sunday shift"])
        day, night, sunday = groups
        self.assertEqual(
            (day.kind, day.applies_on, day.start_time, day.main_out_time, day.main_out_next_day),
            ("day", "mon_sat", time(8, 30), time(20, 0), False),
        )
        self.assertEqual((day.first_punch_from, day.first_punch_to), (time(4, 0), time(16, 59, 59)))
        self.assertEqual(
            (night.kind, night.applies_on, night.start_time, night.main_out_time, night.main_out_next_day),
            ("night", "all", time(21, 0), time(5, 30), True),
        )
        self.assertEqual((night.first_punch_from, night.first_punch_to), (time(17, 0), time(23, 59, 59)))
        self.assertEqual(
            (sunday.kind, sunday.applies_on, sunday.start_time, sunday.main_out_time),
            ("sunday", "sunday", time(8, 30), time(17, 0)),
        )

        def ladder(group):
            return [
                (r.out_time.strftime("%H:%M"), r.out_next_day, str(r.shift_value))
                for r in group.rules.order_by("order")
            ]

        self.assertEqual(
            ladder(day),
            [
                ("10:30", False, "0.25"),
                ("12:45", False, "0.50"),
                ("15:30", False, "0.75"),
                ("17:45", False, "1.00"),
                ("20:00", False, "1.50"),
                ("22:30", False, "2.00"),
                ("00:30", True, "2.50"),
                ("05:30", True, "3.00"),
            ],
        )
        self.assertEqual(ladder(night), [("00:00", True, "0.50"), ("05:30", True, "1.50")])
        self.assertEqual(ladder(sunday), [("17:00", False, "1.00")])
        self.assertEqual(
            [
                (b.start_time.strftime("%H:%M"), b.end_time.strftime("%H:%M"))
                for b in ProductionBreak.objects.order_by("order")
            ],
            [("10:30", "10:45"), ("12:45", "13:30"), ("15:30", "15:45"), ("17:45", "18:00"), ("20:00", "21:00")],
        )

    def test_the_defaults_of_the_new_columns(self):
        config = ProductionShiftConfig()
        self.assertEqual(
            (
                config.rules_enabled,
                config.rules_grace_minutes,
                config.rules_min_credit,
                config.rules_rounding_step,
                config.rules_rounding_mode,
                config.rules_full_day_value,
                config.rules_night_session_hours,
            ),
            # 24 hours (it was 12, then 18): 08:30 open + a 05:30 close is 21 h, which must still be one night session
            (True, 5, Decimal("0.00"), Decimal("0.01"), "nearest", Decimal("1.00"), 24),
        )

    def test_the_seed_is_idempotent_and_never_moves_a_chosen_date(self):
        _set_rules(date(2026, 3, 1))
        groups, rules, breaks = (
            ProductionShiftGroup.objects.count(),
            ProductionShiftRule.objects.count(),
            ProductionBreak.objects.count(),
        )
        _migration().seed(django_apps, None)
        _migration().seed(django_apps, None)
        self.assertEqual(
            (
                ProductionShiftGroup.objects.count(),
                ProductionShiftRule.objects.count(),
                ProductionBreak.objects.count(),
            ),
            (groups, rules, breaks),
        )
        self.assertEqual(ProductionShiftConfig.get().rules_effective_from, date(2026, 3, 1))

    def test_the_seed_dates_an_undated_row_and_creates_a_missing_one(self):
        ProductionShiftConfig.objects.filter(pk=1).update(rules_effective_from=None)
        _migration().seed(django_apps, None)
        self.assertIsNotNone(ProductionShiftConfig.objects.get(pk=1).rules_effective_from)
        ProductionShiftConfig.objects.all().delete()
        _migration().seed(django_apps, None)
        self.assertIsNotNone(ProductionShiftConfig.objects.get(pk=1).rules_effective_from)

    def test_a_fresh_row_starts_its_rules_today_never_in_the_past(self):
        from .clock import ist_today

        ProductionShiftConfig.objects.all().delete()
        self.assertEqual(ProductionShiftConfig.get().rules_effective_from, ist_today())
        ProductionShiftConfig.objects.all().delete()
        self.assertEqual(ProductionShiftConfig.objects.create(pk=1).rules_effective_from, ist_today())
        ProductionShiftConfig.objects.all().delete()
        self.assertEqual(
            ProductionShiftConfig.objects.create(pk=1, rules_effective_from=date(2026, 5, 5)).rules_effective_from,
            date(2026, 5, 5),
        )

    def test_the_loader_returns_what_was_saved(self):
        _set_rules()
        rs = psr.load_ruleset(ProductionShiftConfig.get())
        self.assertEqual([g.label for g in rs.groups], ["Day shift", "Night shift", "Sunday shift"])
        self.assertEqual(len(rs.groups[0].points), 8)
        self.assertEqual(len(rs.breaks), 5)
        self.assertEqual(rs.grace_minutes, 5)
        self.assertEqual(rs.effective_from, date(2026, 1, 1))
        # an edit shows up in a fresh load; disabled rows are left out
        ProductionShiftRule.objects.filter(group__kind="day", out_time=time(17, 45)).update(enabled=False)
        ProductionBreak.objects.filter(label="Lunch").update(enabled=False)
        rs = psr.load_ruleset(ProductionShiftConfig.get())
        self.assertEqual(len(rs.groups[0].points), 7)
        self.assertEqual(len(rs.breaks), 4)

    def test_the_gate_on_the_config_row(self):
        config = _set_rules(date(2026, 2, 10))
        self.assertFalse(psr.config_applies(config, date(2026, 2, 9)))
        self.assertTrue(psr.config_applies(config, date(2026, 2, 10)))
        self.assertIsNone(psr.rules_for_day(config, date(2026, 2, 9)))
        self.assertIsNotNone(psr.rules_for_day(config, date(2026, 2, 10)))
        config = _set_rules(date(2026, 2, 10), rules_enabled=False)
        self.assertIsNone(psr.rules_for_day(config, date(2026, 3, 1)))
        config = _set_rules(None)
        config.refresh_from_db()
        self.assertIsNone(psr.rules_for_day(ProductionShiftConfig.objects.get(pk=1), date(2026, 3, 1)))


class ProductionDayRecordTests(TestCase):
    def setUp(self):
        _ensure_seed()
        _set_rules()
        self.emp = _worker()

    def test_a_regular_day(self):
        _punches(self.emp, MON, "08:30", "12:45", "13:30", "20:00")
        rec = compute_day_record(self.emp, MON)
        self.assertEqual(
            (
                rec.status,
                rec.shifts_earned,
                rec.is_half_shift,
                rec.is_late,
                rec.early_leave,
                rec.first_punch,
                rec.last_punch,
                rec.total_punches,
                rec.computed_mode,
                rec.source,
            ),
            ("present", Decimal("1.50"), False, False, False, time(8, 30), time(20, 0), 4, "production", "auto"),
        )

    def test_the_new_value_for_overtime(self):
        _punches(self.emp, MON, "08:30", "12:45", "13:30", "22:30")
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("2.00"))
        # the legacy calculation could never pay more than 1.50
        _set_rules(date(2099, 1, 1))
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("1.50"))

    def test_a_night_is_credited_to_the_day_it_began(self):
        _punches(self.emp, MON, "21:00")
        _punches(self.emp, TUE, "05:30")
        mon, tue = compute_day_record(self.emp, MON), compute_day_record(self.emp, TUE)
        self.assertEqual(
            (mon.shifts_earned, mon.status, mon.first_punch, mon.last_punch),
            (Decimal("1.50"), "present", time(21, 0), time(5, 30)),
        )
        self.assertEqual(mon.total_punches, 1)  # the stored count stays the day's own raw punches
        self.assertEqual(
            (tue.status, tue.shifts_earned, tue.first_punch, tue.last_punch), ("absent", Decimal("0.00"), None, None)
        )
        self.assertEqual(tue.total_punches, 1)

    def test_day_dinner_and_the_next_morning(self):
        _punches(self.emp, MON, "08:30", "12:45", "13:30", "20:00", "21:00")
        _punches(self.emp, TUE, "05:30")
        rec = compute_day_record(self.emp, MON)
        self.assertEqual(
            (rec.shifts_earned, rec.first_punch, rec.last_punch), (Decimal("3.00"), time(8, 30), time(5, 30))
        )

    def test_a_forgotten_out_punch_is_not_closed_by_the_next_mornings_arrival(self):
        _punches(self.emp, MON, "08:30", "12:45", "13:30")
        _punches(self.emp, TUE, "08:25", "12:45", "13:30", "20:00")
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("0.50"))
        tue = compute_day_record(self.emp, TUE)
        self.assertEqual(
            (tue.shifts_earned, tue.first_punch, tue.last_punch), (Decimal("1.50"), time(8, 25), time(20, 0))
        )

    def test_a_sunday_uses_the_sunday_row(self):
        _punches(self.emp, SUN, "08:30", "17:00")
        rec = compute_day_record(self.emp, SUN)
        self.assertEqual((rec.shifts_earned, rec.status), (Decimal("1.00"), "present"))

    def test_one_punch_is_half_shift_and_unpaid_and_no_punches_is_absent(self):
        _punch(self.emp, MON, "08:30")
        rec = compute_day_record(self.emp, MON)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.is_half_shift, rec.last_punch),
            ("half_shift", Decimal("0.00"), True, None),
        )
        self.assertEqual(compute_day_record(self.emp, TUE).status, "absent")

    def test_late_and_early_flags_use_the_new_grace_and_the_groups_times(self):
        _punches(self.emp, MON, "08:40", "19:00")
        rec = compute_day_record(self.emp, MON)
        self.assertTrue(rec.is_late)  # 08:40 is after 08:30 + 5 (the legacy 10-minute grace would say on time)
        self.assertTrue(rec.early_leave)
        _punches(self.emp, TUE, "08:34", "19:56")
        rec = compute_day_record(self.emp, TUE)
        self.assertFalse(rec.is_late)
        self.assertFalse(rec.early_leave)

    def test_editing_the_rules_changes_the_day(self):
        _punches(self.emp, MON, "08:30", "17:45")
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("1.00"))
        ProductionShiftRule.objects.filter(group__kind="day", out_time=time(17, 45)).update(shift_value=Decimal("1.25"))
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("1.25"))

    def test_a_manual_record_is_never_recomputed(self):
        _punches(self.emp, MON, "08:30", "20:00")
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=MON,
            status="present",
            shifts_earned=Decimal("0.75"),
            source="manual",
        )
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("0.75"))
        self.assertEqual(
            [r.shifts_earned for r in compute_month_records(self.emp, 2026, 2) if r.date == MON], [Decimal("0.75")]
        )

    def test_a_company_holiday_with_punches_is_still_worked(self):
        _punches(self.emp, MON, "08:30", "12:45", "13:30", "20:00")
        rec = compute_day_record(self.emp, MON, holiday_dates={MON})
        self.assertEqual((rec.status, rec.shifts_earned), ("present", Decimal("1.50")))
        self.assertEqual(compute_day_record(self.emp, TUE, holiday_dates={TUE}).status, "holiday")

    def test_staff_are_untouched(self):
        staff = Employee.objects.create(
            employee_code="STF1",
            first_name="S",
            last_name="T",
            employment_type="staff",
            status="active",
            salary_type="monthly",
            salary_amount=Decimal("24000.00"),
        )
        _punches(staff, MON, "09:00", "18:00")
        rec = compute_day_record(staff, MON)
        self.assertEqual(rec.computed_mode, PayrollSettings.get().attendance_mode)
        self.assertEqual(rec.shifts_earned, Decimal("1.00"))  # the staff half-day rule, not the production ladder


class EffectiveDateTests(TestCase):
    def setUp(self):
        _ensure_seed()
        self.emp = _worker()
        self.before, self.first = date(2026, 2, 9), date(2026, 2, 10)  # Monday, Tuesday

    def _both(self, *times):
        _punches(self.emp, self.before, *times)
        _punches(self.emp, self.first, *times)
        return compute_day_record(self.emp, self.before), compute_day_record(self.emp, self.first)

    def test_the_day_before_the_date_is_legacy_and_the_date_itself_is_new(self):
        _set_rules(self.first)
        old, new = self._both("08:30", "12:45", "13:30", "22:30")
        self.assertEqual(old.shifts_earned, Decimal("1.50"))  # legacy: capped at the 1.5 of the segments
        self.assertEqual(new.shifts_earned, Decimal("2.00"))  # the owner's table

    def test_grace_differs_before_and_after(self):
        _set_rules(self.first)
        old, new = self._both("08:40", "20:00")
        self.assertFalse(old.is_late)  # legacy: 10 minute grace
        self.assertTrue(new.is_late)  # new: 5 minute grace

    def test_no_reattribution_before_the_date(self):
        _set_rules(self.first)
        _punches(self.emp, self.before, "21:00")
        _punches(self.emp, self.first, "05:30")
        before = compute_day_record(self.emp, self.before)
        self.assertEqual((before.shifts_earned, before.status), (Decimal("0.00"), "half_shift"))  # legacy: one punch
        self.assertEqual(before.last_punch, None)
        # a day the new rules do not judge neither consumes nor is closed: the 05:30 stays on the first day in force,
        # judged on its own (one punch: present but unpaid)
        first = compute_day_record(self.emp, self.first)
        self.assertEqual(
            (first.status, first.shifts_earned, first.first_punch), ("half_shift", Decimal("0.00"), time(5, 30))
        )

    def test_switched_off_undated_or_without_groups_means_legacy(self):
        _punches(self.emp, self.first, "08:30", "12:45", "13:30", "22:30")
        for label, change in [
            ("off", lambda: _set_rules(date(2026, 1, 1), rules_enabled=False)),
            ("undated", lambda: _set_rules(None)),
            ("no groups", lambda: (_set_rules(date(2026, 1, 1)), ProductionShiftGroup.objects.update(enabled=False))),
        ]:
            with self.subTest(label):
                _ensure_seed()
                change()
                self.assertEqual(compute_day_record(self.emp, self.first).shifts_earned, Decimal("1.50"))
                ProductionShiftGroup.objects.update(enabled=True)

    def test_legacy_grid_through_the_real_engine(self):
        """The recorded legacy answers, but through compute_day_record and the database, for days before the date."""
        _set_rules(date(2030, 1, 1))
        patterns = [k for k in SNAPSHOT["default"] if k and len(set(k.split(","))) == len(k.split(","))][:150]
        base = date(2025, 1, 1)
        for i, key in enumerate(patterns):
            d = base + timedelta(days=i)
            for hhmm in key.split(","):
                _punch(self.emp, d, hhmm)
        for i, key in enumerate(patterns):
            d = base + timedelta(days=i)
            rec = compute_day_record(self.emp, d)
            times = [_t(x) for x in key.split(",")]
            expected = SNAPSHOT["default"][key].split("|")
            self.assertEqual(rec.shifts_earned, Decimal(expected[0]).quantize(Decimal("0.01")), key)
            self.assertEqual(
                (rec.status, rec.is_late, rec.is_half_shift, rec.early_leave),
                (expected[1], expected[2] == "True", expected[3] == "True", expected[4] == "True"),
                key,
            )
            self.assertEqual(rec.first_punch, times[0], key)
            self.assertEqual(rec.last_punch, times[-1] if len(times) > 1 else None, key)

    def test_production_day_result_helper_is_pure_and_picks_the_right_calculation(self):
        _set_rules(self.first)
        config = ProductionShiftConfig.get()
        punches = [time(8, 30), time(12, 45), time(13, 30), time(22, 30)]
        before = production_day_result(self.before, {self.before: punches}, config=config)
        new = production_day_result(self.first, {self.first: punches}, config=config)
        self.assertEqual(before["shifts_earned"], Decimal("1.50"))
        self.assertNotIn("rule_note", before)
        self.assertEqual((new["shifts_earned"], new["rule_group"]), (Decimal("2.00"), "Day shift"))
        self.assertTrue(new["rule_note"])
        self.assertEqual(AttendanceDayRecord.objects.count(), 0)  # nothing was written


class FallbackAndBoundaryTests(TestCase):
    def setUp(self):
        _ensure_seed()
        self.emp = _worker("FB1")

    def test_no_group_for_the_weekday_falls_back_to_the_legacy_calculation(self):
        _set_rules(date(2026, 1, 1))
        ProductionShiftGroup.objects.filter(kind__in=["day", "night"]).update(enabled=False)
        _punches(self.emp, MON, "08:30", "12:45", "13:30", "22:30")
        self.assertEqual(compute_day_record(self.emp, MON).shifts_earned, Decimal("1.50"))  # legacy: capped
        _punches(self.emp, SUN, "08:30", "17:00")
        self.assertEqual(
            compute_day_record(self.emp, SUN).shifts_earned, Decimal("1.00")
        )  # the Sunday group still works

    def test_a_month_that_straddles_the_effective_date(self):
        _set_rules(date(2026, 2, 10))
        for d in (date(2026, 2, 9), date(2026, 2, 10)):
            _punches(self.emp, d, "08:30", "12:45", "13:30", "22:30")
        month = {r.date: r for r in compute_month_records(self.emp, 2026, 2)}
        self.assertEqual(month[date(2026, 2, 9)].shifts_earned, Decimal("1.50"))
        self.assertEqual(month[date(2026, 2, 10)].shifts_earned, Decimal("2.00"))
        # and the answer does not depend on how the days are asked for
        AttendanceDayRecord.objects.filter(employee=self.emp).delete()
        self.assertEqual(compute_day_record(self.emp, date(2026, 2, 9)).shifts_earned, Decimal("1.50"))
        self.assertEqual(compute_day_record(self.emp, date(2026, 2, 10)).shifts_earned, Decimal("2.00"))

    def test_a_legacy_day_does_not_hand_its_night_to_the_first_day_in_force(self):
        _set_rules(date(2026, 2, 10))
        _punch(self.emp, date(2026, 2, 9), "21:00")  # legacy day: judged on its own punches, consumes nothing
        _punches(self.emp, date(2026, 2, 10), "05:30", "21:00")  # in force: its own 05:30 stays its own
        _punch(self.emp, date(2026, 2, 11), "05:30")
        month = {r.date: r for r in compute_month_records(self.emp, 2026, 2)}
        self.assertEqual(
            (month[date(2026, 2, 9)].shifts_earned, month[date(2026, 2, 9)].last_punch), (Decimal("0.00"), None)
        )
        # 05:30 -> 21:00 on the Day table (the first punch counts as the start); the even count closes nothing
        self.assertEqual(
            (
                month[date(2026, 2, 10)].shifts_earned,
                month[date(2026, 2, 10)].first_punch,
                month[date(2026, 2, 10)].last_punch,
            ),
            (Decimal("1.50"), time(5, 30), time(21, 0)),
        )
        self.assertEqual(
            (month[date(2026, 2, 11)].status, month[date(2026, 2, 11)].first_punch), ("half_shift", time(5, 30))
        )
        # one day at a time agrees
        AttendanceDayRecord.objects.filter(employee=self.emp).delete()
        for d in (date(2026, 2, 9), date(2026, 2, 10), date(2026, 2, 11)):
            self.assertEqual(compute_day_record(self.emp, d).shifts_earned, month[d].shifts_earned)

    def test_the_week_of_a_nightshift_worker_through_the_range_engine(self):
        _set_rules(date(2026, 1, 1))
        _punch(self.emp, date(2026, 2, 2), "21:00")
        for i in range(3, 8):
            _punches(self.emp, date(2026, 2, i), "05:30", "21:00")
        _punch(self.emp, date(2026, 2, 8), "05:30")
        records = compute_range_records(self.emp, date(2026, 2, 2), date(2026, 2, 8))
        self.assertEqual([r.shifts_earned for r in records], [Decimal("1.50")] * 6 + [Decimal("0.00")])
        self.assertEqual(sum(r.shifts_earned for r in records), Decimal("9.00"))


def _month_logs(emp, first_day: date, days: int, seed: int):
    """A messy month of raw punches: day workers, overtime, night chains, forgotten out-punches, off days, Sundays."""
    rng = random.Random(seed)
    raw: dict = {}

    def add(d, hhmm):
        raw.setdefault(d, set()).add(hhmm)

    def jitter(base, spread=7):
        m = int(base[:2]) * 60 + int(base[3:]) + rng.randint(-spread, spread)
        return f"{m // 60:02d}:{m % 60:02d}"

    plan = None
    for i in range(days):
        d = first_day + timedelta(days=i)
        roll = rng.random()
        if plan == "night" and roll < 0.7:
            kind = "night"
        else:
            kind = rng.choice(["off", "day", "day", "day", "ot", "dinner_night", "night", "night", "forgot", "half"])
        plan = kind
        if kind == "day":
            for t in ("08:30", "12:45", "13:30", "20:00"):
                add(d, jitter(t))
        elif kind == "ot":
            for t in ("08:30", "12:45", "13:30", "22:30"):
                add(d, jitter(t))
        elif kind == "half":
            add(d, jitter("08:30"))
            add(d, jitter("12:45"))
        elif kind == "forgot":
            for t in ("08:30", "12:45", "13:30"):
                add(d, jitter(t))
        elif kind == "dinner_night":
            for t in ("08:30", "12:45", "13:30", "20:00", "21:00"):
                add(d, jitter(t))
            add(d + timedelta(days=1), jitter("05:30"))
        elif kind == "night":
            add(d, jitter("21:00"))
            if rng.random() < 0.9:
                add(d + timedelta(days=1), jitter("05:30"))
    for d, times in raw.items():
        for hhmm in times:
            _punch(emp, d, hhmm)
    return raw


FIELDS = (
    "status",
    "shifts_earned",
    "first_punch",
    "last_punch",
    "is_late",
    "early_leave",
    "is_half_shift",
    "total_punches",
    "primary_source",
    "computed_mode",
)


def _snap(rec):
    return tuple(getattr(rec, f) for f in FIELDS)


class MonthEqualsDayTests(TestCase):
    def setUp(self):
        _ensure_seed()
        _set_rules(date(2026, 1, 1))

    def test_a_month_computed_at_once_equals_the_same_days_one_at_a_time(self):
        emp = _worker("MONTH1")
        # begin a week before the month so the chain across Feb 1 needs the days before it
        _month_logs(emp, date(2026, 1, 22), 38, seed=11)
        month = {r.date: _snap(r) for r in compute_month_records(emp, 2026, 2)}
        self.assertEqual(len(month), 28)
        AttendanceDayRecord.objects.filter(employee=emp).delete()
        for d, expected in sorted(month.items()):
            self.assertEqual(_snap(compute_day_record(emp, d)), expected, d.isoformat())
        # the generated month really contains resolved nights, so the equality above is not vacuous
        nights = [
            s
            for s in month.values()
            if s[2] is not None and s[2] >= time(17, 0) and s[3] is not None and s[3] < time(12, 0)
        ]
        self.assertGreaterEqual(len(nights), 3)

    def test_range_equals_month_equals_day_for_several_seeds(self):
        for seed in (1, 2, 3, 4):
            emp = _worker(f"RANGE{seed}")
            _month_logs(emp, date(2026, 1, 22), 38, seed=seed)
            month = {r.date: _snap(r) for r in compute_month_records(emp, 2026, 2)}
            AttendanceDayRecord.objects.filter(employee=emp).delete()
            mid = {r.date: _snap(r) for r in compute_range_records(emp, date(2026, 2, 9), date(2026, 2, 20))}
            for d, snap in mid.items():
                self.assertEqual(snap, month[d], f"seed {seed} {d}")
            AttendanceDayRecord.objects.filter(employee=emp).delete()
            for d in (date(2026, 2, 1), date(2026, 2, 14), date(2026, 2, 28)):
                self.assertEqual(_snap(compute_day_record(emp, d)), month[d], f"seed {seed} {d}")

    def test_a_chain_of_nights_inside_a_month_credits_every_night(self):
        emp = _worker("CHAIN1")
        _punch(emp, date(2026, 2, 2), "21:00")
        for i in range(3, 9):
            _punches(emp, date(2026, 2, i), "05:30", "21:00")
        _punch(emp, date(2026, 2, 9), "05:30")
        month = {r.date: r for r in compute_month_records(emp, 2026, 2)}
        for i in range(2, 9):
            with self.subTest(day=i):
                rec = month[date(2026, 2, i)]
                self.assertEqual(
                    (rec.shifts_earned, rec.first_punch, rec.last_punch), (Decimal("1.50"), time(21, 0), time(5, 30))
                )
        self.assertEqual(month[date(2026, 2, 9)].status, "absent")
        self.assertEqual(sum(r.shifts_earned for r in month.values()), Decimal("10.50"))


class QueryCountTests(TestCase):
    def setUp(self):
        _ensure_seed()
        _set_rules(date(2026, 1, 1))

    def _count(self, fn):
        with CaptureQueriesContext(connection) as ctx:
            fn()
        return len(ctx)

    def test_a_month_costs_the_same_for_three_days_of_punches_or_twenty_five(self):
        few, many = _worker("QC_FEW"), _worker("QC_MANY")
        for d in (MON, TUE, WED):
            _punches(few, d, "08:30", "12:45", "13:30", "20:00")
        for i in range(25):
            d = date(2026, 2, 1) + timedelta(days=i)
            _punches(many, d, "08:30", "12:45", "13:30", "20:00")
        for emp in (few, many):
            compute_month_records(emp, 2026, 2)  # writes the records and warms the holiday cache
        self.assertEqual(
            self._count(lambda: compute_month_records(few, 2026, 2)),
            self._count(lambda: compute_month_records(many, 2026, 2)),
        )

    def test_the_new_rules_add_only_a_constant_over_the_legacy_calculation(self):
        emp = _worker("QC_LEG")
        for i in range(25):
            _punches(emp, date(2026, 2, 1) + timedelta(days=i), "08:30", "12:45", "13:30", "20:00")
        compute_month_records(emp, 2026, 2)
        with_rules = self._count(lambda: compute_month_records(emp, 2026, 2))
        _set_rules(date(2099, 1, 1))
        legacy = self._count(lambda: compute_month_records(emp, 2026, 2))
        self.assertLessEqual(with_rules - legacy, 3)  # the three rule tables, once for the whole month

    def test_every_employee_of_a_payroll_loop_costs_the_same(self):
        workers = [_worker(f"QC_P{i}") for i in range(4)]
        for w in workers:
            for i in range(10):
                _punches(w, date(2026, 2, 1) + timedelta(days=i), "08:30", "12:45", "13:30", "20:00")
            compute_range_records(w, date(2026, 2, 1), date(2026, 2, 28))
        counts = [
            self._count(lambda w=w: compute_range_records(w, date(2026, 2, 1), date(2026, 2, 28))) for w in workers
        ]
        self.assertEqual(len(set(counts)), 1, counts)

    def test_a_roster_day_reads_the_punch_and_rule_tables_a_fixed_number_of_times(self):
        workers = [_worker(f"QC_R{i}") for i in range(10)]
        d = MON
        for w in workers:
            _punches(w, d, "08:30", "12:45", "13:30", "20:00")
        settings = PayrollSettings.get()
        watched = (
            "attendance_logs",
            "production_shift_groups",
            "production_shift_rules",
            "production_breaks",
            "production_shift_config",
        )

        def roster(emps):
            config = ProductionShiftConfig.get()
            pf = production_prefetch_for_day([e.id for e in emps], d, config)
            logs = {}
            for log in AttendanceLog.objects.filter(employee__in=emps, date=d):
                logs.setdefault(log.employee_id, []).append(log)
            for e in emps:
                prefetch = {
                    "existing_day_records": {},
                    "manual_attendance_dates": set(),
                    **production_prefetch_for(pf, e.id),
                }
                compute_day_record(
                    e,
                    d,
                    punch_logs=logs.get(e.id, []),
                    settings=settings,
                    leave_dates=set(),
                    holiday_dates=set(),
                    prod_config=config,
                    prefetch=prefetch,
                )

        def reads(emps):
            with CaptureQueriesContext(connection) as ctx:
                roster(emps)
            return sum(
                1
                for q in ctx.captured_queries
                if any(t in q["sql"] for t in watched) and q["sql"].lstrip().upper().startswith("SELECT")
            )

        roster(workers)
        small, large = reads(workers[:3]), reads(workers)
        # config + ONE statement for the 3 rule tables (load_ruleset, one snapshot; was 3 statements) + the roster's
        # punch window + the test's own read of today's punches
        self.assertEqual(small, large)
        self.assertEqual(small, 4)

    def test_a_roster_day_with_the_prefetch_reads_no_punch_or_rule_table_per_employee(self):
        workers = [_worker(f"QC_Q{i}") for i in range(3)]
        for w in workers:
            _punches(w, MON, "08:30", "12:45", "13:30", "20:00")
        settings = PayrollSettings.get()
        config = ProductionShiftConfig.get()
        pf = production_prefetch_for_day([w.id for w in workers], MON, config)
        logs = {}
        for log in AttendanceLog.objects.filter(employee__in=workers, date=MON):
            logs.setdefault(log.employee_id, []).append(log)
        for w in workers:
            compute_day_record(
                w,
                MON,
                punch_logs=logs[w.id],
                settings=settings,
                leave_dates=set(),
                holiday_dates=set(),
                prod_config=config,
                prefetch={
                    "existing_day_records": {},
                    "manual_attendance_dates": set(),
                    **production_prefetch_for(pf, w.id),
                },
            )
        AttendanceDayRecord.objects.all().delete()
        with CaptureQueriesContext(connection) as ctx:
            for w in workers:
                compute_day_record(
                    w,
                    MON,
                    punch_logs=logs[w.id],
                    settings=settings,
                    leave_dates=set(),
                    holiday_dates=set(),
                    prod_config=config,
                    prefetch={
                        "existing_day_records": {},
                        "manual_attendance_dates": set(),
                        **production_prefetch_for(pf, w.id),
                    },
                )
        sql = " ".join(q["sql"] for q in ctx.captured_queries)
        for table in ("attendance_logs", "production_shift_groups", "production_shift_rules", "production_breaks"):
            self.assertNotIn(table, sql)

    def test_a_single_day_without_a_prefetch_is_one_extra_logs_read_and_the_rule_tables(self):
        emp = _worker("QC_ONE")
        _punches(emp, MON, "08:30", "12:45", "13:30", "20:00")
        compute_day_record(emp, MON)
        new = self._count(lambda: compute_day_record(emp, MON))
        _set_rules(date(2099, 1, 1))
        legacy = self._count(lambda: compute_day_record(emp, MON))
        self.assertLessEqual(new - legacy, 4)  # three rule tables + the 8-day punch window


class ProductionPayrollWithRulesTests(TestCase):
    """End to end: a production worker's payroll under the new rules (a weekly period)."""

    def setUp(self):
        _ensure_seed()
        _set_rules(date(2026, 1, 1))
        ps = PayrollSettings.get()
        for key, value in dict(
            prod_payroll_rules_enabled=False,
            prod_pf_ef_enabled=False,
            prod_pf_ef_rules=[],
            prod_late_detection_enabled=False,
        ).items():
            setattr(ps, key, value)
        ps.save()

    def test_pay_is_the_sum_of_the_days_shifts_times_the_rate(self):
        from .payroll_views import _generate_production_payroll

        emp = _worker("PAYR1", per_shift="500.00")
        _punches(emp, MON, "08:30", "12:45", "13:30", "20:00")  # 1.50
        _punches(emp, TUE, "08:30", "12:45", "13:30", "22:30")  # 2.00
        _punches(emp, WED, "21:00")  # night: 1.50 (closes Thursday morning)
        _punches(emp, WED + timedelta(days=1), "05:30")
        _punches(emp, date(2026, 2, 5), "21:00")  # a second night, out on Friday 05:30
        _punches(emp, date(2026, 2, 6), "05:30")
        _punches(emp, date(2026, 2, 7), "08:30", "17:42")  # Saturday 1.00 (grace)
        _punches(emp, SUN, "08:30", "17:00")  # Sunday 1.00
        result = _generate_production_payroll(emp, MON, SUN, pay_cycle="weekly")
        payroll = result["payroll"]
        self.assertEqual(payroll.present_days, Decimal("8.50"))  # 1.5 + 2 + 1.5 + 1.5 + 1 + 1
        self.assertEqual(payroll.gross_salary, Decimal("4250.00"))
        slip_days = {row["date"]: row for row in SalarySlip.objects.get(employee=emp).breakdown_details["days"]}
        self.assertEqual(
            (slip_days[WED.isoformat()]["firstPunch"], slip_days[WED.isoformat()]["lastPunch"]), ("21:00", "05:30")
        )
        self.assertEqual(slip_days[WED.isoformat()]["shiftsEarned"], 1.5)
        self.assertEqual(
            slip_days["2026-02-05"]["shiftsEarned"], 1.5
        )  # Thursday's own night (its 05:30 closed Wednesday's)
        self.assertEqual(slip_days["2026-02-06"]["status"], "absent")  # Friday's only punch closed Thursday's night


# ═════════════════════════════════════════════════════════════════════════════
#  Hardening: the night-session chain, the closing-punch guard, effective-date and manual-day guards
# ═════════════════════════════════════════════════════════════════════════════

CHAIN_START = date(2026, 1, 5)  # a Monday: a long chain from here crosses Sundays and a month boundary


def _rs_resolved(spec: dict, d: date, rs=None, manual=()) -> list:
    """The resolved punches of day d with EVERY guard of the rules switched on (hours, close-by, in force, manual)."""
    rs = rs or ruleset()
    return [s for s, _ref in psr.resolve_day(_by_date(spec), d, **psr.session_kwargs(rs, manual))]


def oracle_resolve(spec: dict, rs, manual=()) -> dict:
    """{date: resolved punch seconds} for every date of the spec, written differently from the engine: NO look-back at
    all. 'Is the first punch of day k taken by the day before?' is a vector over the whole span that is iterated (every
    entry recomputed from the previous vector, starting from 'everything is taken') until it stops changing."""
    dates = sorted(spec)
    first, last = dates[0], dates[-1] + timedelta(days=1)
    days = [first + timedelta(days=i) for i in range((last - first).days + 2)]
    raw = {}
    for k in days:
        kept = []
        for s in sorted(S(p) for p in spec.get(k, [])):
            if not kept or s - kept[-1] >= 300:
                kept.append(s)
        raw[k] = kept
    outs = [p.out_s for g in rs.groups for p in g.points] + [
        g.main_out_s for g in rs.groups if g.main_out_s is not None
    ]
    close_by = max([o - 86400 for o in outs if o >= 86400] + [0]) + 90 * 60
    limit_min = rs.night_session_hours * 60

    def eligible(k):
        prev = k - timedelta(days=1)
        if prev not in raw or not raw[k] or not raw[prev] or k in manual or prev in manual:
            return False
        if not (rs.applies(k) and rs.applies(prev)):
            return False
        f = raw[k][0] // 60 * 60
        return f <= close_by and f // 60 + 1440 - raw[prev][-1] // 60 <= limit_min

    taken = {k: True for k in days}
    for _ in range(len(days) + 2):
        new = {days[0]: False}
        for k in days[:-1]:
            base = raw[k][1:] if taken[k] else raw[k]
            new[k + timedelta(days=1)] = len(base) % 2 == 1 and eligible(k + timedelta(days=1))
        if new == taken:
            break
        taken = new
    out = {}
    for k in days[:-1]:
        base = raw[k][1:] if taken[k] else raw[k]
        nxt = k + timedelta(days=1)
        out[k] = base + ([raw[nxt][0] + 86400] if taken.get(nxt) else [])
    return out


def _night_chain(nights: int, start: date = CHAIN_START, first="21:00", last="05:30") -> dict:
    """A night-only worker: the first night is [21:00], every later day [05:30, 21:00], the day after the last [05:30]."""
    spec = {start: [first]}
    for i in range(1, nights):
        spec[start + timedelta(days=i)] = [last, first]
    spec[start + timedelta(days=nights)] = [last]
    return spec


class NightChainHardeningTests(SimpleTestCase):
    def test_a_long_run_of_nights_is_resolved_night_after_night(self):
        rs = ruleset()
        for nights in (8, 15, 16, 20, 31, 44, 62):
            spec = _night_chain(nights)
            expected = oracle_resolve(spec, rs)
            for i in range(nights + 2):
                d = CHAIN_START + timedelta(days=i)
                with self.subTest(nights=nights, day=i):
                    got = _rs_resolved(spec, d, rs)
                    self.assertEqual(got, expected[d])
                    if i < nights:
                        self.assertEqual(got, [S("21:00"), S("05:30+")])
                        r = psr.evaluate_day(rs, d, got)
                        # Sundays too: the night group applies on every weekday (no phantom Sunday 1.00)
                        self.assertEqual((r["rule_group"], r["shifts_earned"]), ("Night shift", D("1.50")))
                    else:
                        self.assertEqual(got, [])  # the day after the chain has nothing left (no phantom 0.00 day)
                        self.assertEqual(psr.evaluate_day(rs, d, got)["status"], "absent")

    def test_the_answer_does_not_depend_on_how_far_back_the_caller_looks(self):
        spec = _night_chain(30)
        by = _by_date(spec)
        kw = psr.session_kwargs(ruleset())
        for i in range(31):
            d = CHAIN_START + timedelta(days=i)
            full = [s for s, _r in psr.resolve_day(by, d, **kw)]
            narrow = {k: v for k, v in by.items() if k >= d - timedelta(days=7)}
            self.assertFalse(psr.needs_history(narrow, d, d - timedelta(days=7), **kw) and i < 8)
            if not psr.needs_history(narrow, d, d - timedelta(days=7), **kw):
                self.assertEqual([s for s, _r in psr.resolve_day(narrow, d, **kw)], full)
            else:
                self.assertGreaterEqual(i, 8)  # only a chain longer than the default window asks for more

    def test_the_walk_is_capped_at_62_days_and_says_so(self):
        rs = ruleset()
        spec = _night_chain(90)
        # exact while the chain's first day is within the walk: night 63 (the 62nd step back is night 1)
        self.assertEqual(_rs_resolved(spec, CHAIN_START + timedelta(days=62), rs), [S("21:00"), S("05:30+")])
        # beyond it the first day of the walk is assumed 'not consumed' (documented): night 64 is judged unclosed
        self.assertEqual(_rs_resolved(spec, CHAIN_START + timedelta(days=63), rs), [S("05:30"), S("21:00")])

    def test_twelve_three_shift_days_in_a_row(self):
        rs = ruleset()
        day = ["08:30", "12:45", "13:30", "20:00", "21:00"]
        spec = {CHAIN_START: day}
        for i in range(1, 12):
            spec[CHAIN_START + timedelta(days=i)] = ["05:30"] + day
        spec[CHAIN_START + timedelta(days=12)] = ["05:30"]
        expected = oracle_resolve(spec, rs)
        for i in range(13):
            d = CHAIN_START + timedelta(days=i)
            got = _rs_resolved(spec, d, rs)
            self.assertEqual(got, expected[d], d.isoformat())
            if i < 12:
                self.assertEqual(got, [S(p) for p in day] + [S("05:30+")])
                r = psr.evaluate_day(rs, d, got)
                # the Sunday group stops at its single 17:00 row (1.00) until HR adds rows
                self.assertEqual(r["shifts_earned"], D("1.00") if d.weekday() == 6 else D("3.00"), d.isoformat())
            else:
                self.assertEqual(got, [])

    def test_half_nights_chain_with_a_day_shift_and_a_sunday_worked_in_the_middle(self):
        rs = ruleset()
        d = [CHAIN_START + timedelta(days=i) for i in range(11)]
        spec = {
            d[0]: ["21:00"],
            d[1]: ["00:00", "21:00"],
            d[2]: ["00:00", "21:00"],
            d[3]: ["00:00", "08:30", "12:45", "13:30", "20:00"],  # the last half night's exit, then a plain day shift
            d[4]: ["21:00"],
            d[5]: ["00:00", "21:00"],
            d[6]: ["00:00", "08:30", "17:00"],  # Sunday (a Sunday shift after a night)
            d[7]: ["21:00"],
            d[8]: ["00:00", "21:00"],
            d[9]: ["00:00"],
        }
        self.assertEqual(d[6].weekday(), 6)
        expected = oracle_resolve(spec, rs)
        for day in d:
            self.assertEqual(_rs_resolved(spec, day, rs), expected[day], day.isoformat())
        night = [S("21:00"), S("00:00+")]
        for i in (0, 1, 2, 4, 5, 7, 8):
            self.assertEqual(_rs_resolved(spec, d[i], rs), night, i)
            self.assertEqual(psr.evaluate_day(rs, d[i], night)["shifts_earned"], D("0.50"))
        self.assertEqual(_rs_resolved(spec, d[3], rs), [S("08:30"), S("12:45"), S("13:30"), S("20:00")])
        self.assertEqual(_rs_resolved(spec, d[6], rs), [S("08:30"), S("17:00")])
        self.assertEqual(_rs_resolved(spec, d[9], rs), [])


class ClosingGuardTests(SimpleTestCase):
    """The next day's first punch closes an odd day only when it is early enough and close enough."""

    def _mon(self, mon, tue, rs=None):
        spec = {MON: mon, TUE: tue}
        return _rs_resolved(spec, MON, rs), _rs_resolved(spec, TUE, rs)

    def test_the_close_by_time_follows_the_rules(self):
        rs = ruleset()
        self.assertEqual(rs.close_by_s, S("07:00"))  # 05:30 + 90 min with the owner's tables
        groups, rules, breaks = _default_rows()
        rules.append(
            SimpleNamespace(
                id=999,
                group_id=2,
                label="x",
                out_time=time(7, 30),
                out_next_day=True,
                shift_value=D("1.75"),
                enabled=True,
                order=99,
            )
        )
        self.assertEqual(psr.build_ruleset(_config(), groups, rules, breaks).close_by_s, S("09:00"))
        self.assertEqual(rs.night_session_hours, 24)

    def test_a_normal_morning_arrival_after_a_forgotten_return_punch_is_not_consumed(self):
        mon, tue = self._mon(["08:30", "12:45", "20:00"], ["07:55", "12:45", "13:30", "20:00"])
        self.assertEqual(mon, [S("08:30"), S("12:45"), S("20:00")])
        self.assertEqual(tue, [S("07:55"), S("12:45"), S("13:30"), S("20:00")])
        rs = ruleset()
        self.assertEqual(psr.evaluate_day(rs, MON, mon)["shifts_earned"], D("0.50"))  # the odd rule: 20:00 is ignored
        self.assertEqual(psr.evaluate_day(rs, TUE, tue)["shifts_earned"], D("1.50"))  # Tuesday on its own punches

    def test_a_late_leaver_with_a_forgotten_punch_and_an_ordinary_arrival(self):
        mon, tue = self._mon(["08:30", "12:45", "22:30"], ["08:25", "12:45", "13:30", "20:00"])
        self.assertEqual(mon, [S("08:30"), S("12:45"), S("22:30")])
        self.assertEqual(tue[0], S("08:25"))
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("0.50"))

    def test_a_forgotten_lunch_out_punch_and_an_arrival_at_eight(self):
        mon, tue = self._mon(["08:30", "13:30", "20:00"], ["08:00", "12:45"])
        self.assertEqual(mon, [S("08:30"), S("13:30"), S("20:00")])
        self.assertEqual(tue, [S("08:00"), S("12:45")])
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("0.50"))

    def test_a_forgotten_exit_closed_at_three_in_the_morning_pays_up_to_that_punch(self):
        mon, tue = self._mon(["08:30", "12:45", "13:30"], ["03:00"])
        self.assertEqual(mon, [S("08:30"), S("12:45"), S("13:30"), S("03:00+")])  # 13.5 h < 24 h, 03:00 <= 07:00
        self.assertEqual(tue, [])
        # 0.50 until lunch, then 13:30 -> 03:00: V(03:00) = 2.50 + 150/300 * 0.50 = 2.75; V(13:30) = 0.50
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("2.75"))

    def test_a_close_at_01_31_is_closed_now(self):
        mon, tue = self._mon(["08:30", "12:45", "13:30"], ["01:31"])
        self.assertEqual(len(mon), 4)  # 12 h before it was closed too; now the limit is 24 h
        self.assertEqual(tue, [])
        # V(01:31) = 2.50 + 61/300 * 0.50 = 2.6017 -> 0.50 + (2.6017 - 0.50)
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("2.60"))

    def test_the_close_by_edge_in_minutes(self):
        for tue_first, closed in [
            ("06:59", True),
            ("07:00", True),
            ("07:00:59", True),
            ("07:01", False),
            ("07:55", False),
        ]:
            with self.subTest(first=tue_first):
                mon, tue = self._mon(["08:30", "12:45", "13:30"], [tue_first])
                self.assertEqual(len(mon), 4 if closed else 3)
                self.assertEqual(tue, [] if closed else [S(tue_first)])

    def test_an_even_day_never_gives_its_morning_away(self):
        mon, tue = self._mon(["08:30", "12:45", "13:30", "20:00"], ["03:00", "08:30"])
        self.assertEqual(mon, [S("08:30"), S("12:45"), S("13:30"), S("20:00")])
        self.assertEqual(tue, [S("03:00"), S("08:30")])

    def test_the_session_hours_edge_is_in_whole_minutes(self):
        # 20:00 open, hours = 10: the next 06:00:59 is exactly 10 h once the seconds are dropped, 06:01 is 10 h 01 min
        rs = ruleset(rules_night_session_hours=10)
        for tue_first, closed in [
            ("05:59", True),
            ("06:00", True),
            ("06:00:59", True),
            ("06:01", False),
            ("06:30", False),
        ]:
            with self.subTest(first=tue_first):
                mon, tue = self._mon(["08:30", "12:45", "20:00"], [tue_first], rs)
                self.assertEqual(len(mon), 4 if closed else 3)
                self.assertEqual(tue, [] if closed else [S(tue_first)])

    def test_a_saved_18_hour_limit_edge(self):
        # the default moved to 24 h; an 18 h limit HR saved earlier keeps its meaning. Open 13:00: +18 h is exactly
        # 07:00 (also the close-by time): 07:00:59 still closes, 07:01 does not
        rs = ruleset(rules_night_session_hours=18)
        for tue_first, closed in [("06:59", True), ("07:00:59", True), ("07:01", False)]:
            with self.subTest(first=tue_first):
                mon, tue = self._mon(["08:30", "12:45", "13:00"], [tue_first], rs)
                self.assertEqual(len(mon), 4 if closed else 3)

    def test_a_lone_morning_punch_is_closed_by_the_next_mornings_0530(self):
        # 08:30 in, 05:30 out the next morning is 21 h: inside the 24 h default (it was refused at 18 h)
        mon, tue = self._mon(["08:30"], ["05:30"])
        self.assertEqual(mon, [S("08:30"), S("05:30+")])
        self.assertEqual(tue, [])
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("3.00"))
        self.assertEqual(psr.evaluate_day(ruleset(), TUE, tue)["status"], "absent")

    def test_a_close_at_0330_after_a_lone_morning_punch_pays_the_same_as_the_preview_figure(self):
        mon, tue = self._mon(["08:30"], ["03:30"])
        self.assertEqual(mon, [S("08:30"), S("03:30+")])
        self.assertEqual(tue, [])
        self.assertEqual(psr.evaluate_day(ruleset(), MON, mon)["shifts_earned"], D("2.80"))

    def test_a_normal_arrival_after_a_lone_morning_punch_is_still_not_swallowed(self):
        # the close-by guard (05:30 + 90 min = 07:00) keeps 07:55 / 08:25 out, whatever the hours limit is
        for tue_first in ("07:55", "08:25"):
            with self.subTest(first=tue_first):
                mon, tue = self._mon(["08:30"], [tue_first, "12:45", "13:30", "20:00"])
                self.assertEqual(mon, [S("08:30")])
                self.assertEqual(tue, [S(tue_first), S("12:45"), S("13:30"), S("20:00")])

    def test_the_default_24_hour_edge_is_in_whole_minutes(self):
        # the default limit is 24 h. Open at 07:00: the next 07:00:59 is exactly 24 h once the seconds are dropped (and is
        # on the close-by time), 07:01 is 24 h 01 min (and past the close-by time)
        for tue_first, closed in [("06:59", True), ("07:00", True), ("07:00:59", True), ("07:01", False)]:
            with self.subTest(first=tue_first):
                mon, tue = self._mon(["07:00"], [tue_first])
                self.assertEqual(len(mon), 2 if closed else 1)
                self.assertEqual(tue, [] if closed else [S(tue_first)])

    def test_the_default_24_hour_edge_without_the_clock_guard(self):
        # no close-by time, so the hours limit alone decides: open 10:00, 24 h later is 10:00 the next day
        by = {MON: [(S("10:00"), None)], TUE: [(S("10:00:59"), None)]}
        self.assertEqual(len(psr.resolve_day(by, MON)), 2)  # exactly 24 h: the default hours
        by[TUE] = [(S("10:01"), None)]
        self.assertEqual(len(psr.resolve_day(by, MON)), 1)

    def test_a_limit_saved_earlier_is_still_honoured(self):
        # a value HR saved before the default moved (any 1..24) keeps its own meaning
        for hours in (1, 10, 18, 24):
            rs = ruleset(rules_night_session_hours=hours)
            self.assertEqual(rs.night_session_hours, hours)
        rs18 = ruleset(rules_night_session_hours=18)
        mon, tue = self._mon(["08:30"], ["05:30"], rs18)  # 21 h > 18 h: the saved limit still refuses it
        self.assertEqual((mon, tue), ([S("08:30")], [S("05:30")]))
        mon, tue = self._mon(["13:00"], ["06:59"], rs18)  # 17 h 59 min <= 18 h: still closed
        self.assertEqual(len(mon), 2)

    def test_the_gap_is_counted_in_whole_minutes_without_the_clock_guard(self):
        by = {MON: [(S("21:00"), None)], TUE: [(S("09:00:59"), None)]}
        self.assertEqual(len(psr.resolve_day(by, MON, 12)), 2)  # exactly 12 h
        by[TUE] = [(S("09:01"), None)]
        self.assertEqual(len(psr.resolve_day(by, MON, 12)), 1)


class InForceAndManualGuardTests(SimpleTestCase):
    def test_a_day_before_the_effective_date_neither_consumes_nor_is_closed(self):
        rs = ruleset(rules_effective_from=TUE)
        spec = {MON: ["21:00"], TUE: ["05:30"]}
        self.assertEqual(_rs_resolved(spec, MON, rs), [S("21:00")])  # Monday is legacy: not closed by Tuesday
        self.assertEqual(_rs_resolved(spec, TUE, rs), [S("05:30")])  # Tuesday is in force: Monday took nothing
        both = ruleset(rules_effective_from=MON)
        self.assertEqual(_rs_resolved(spec, MON, both), [S("21:00"), S("05:30+")])
        self.assertEqual(_rs_resolved(spec, TUE, both), [])

    def test_a_manual_day_neither_consumes_nor_is_closed(self):
        spec = {MON: ["21:00"], TUE: ["05:30"]}
        self.assertEqual(_rs_resolved(spec, MON, manual={TUE}), [S("21:00")])  # Tuesday's record stays untouched
        self.assertEqual(_rs_resolved(spec, TUE, manual={TUE}), [S("05:30")])
        self.assertEqual(_rs_resolved(spec, MON, manual={MON}), [S("21:00")])  # a manual Monday does not close
        self.assertEqual(_rs_resolved(spec, TUE, manual={MON}), [S("05:30")])  # ... and gives nothing away

    def test_a_manual_day_in_the_middle_of_a_chain_breaks_it_on_both_sides(self):
        wed = MON + timedelta(days=2)
        spec = {
            MON: ["21:00"],
            TUE: ["05:30", "21:00"],
            wed: ["05:30", "21:00"],
            wed + timedelta(days=1): ["05:30", "21:00"],
            wed + timedelta(days=2): ["05:30"],
        }
        rs = ruleset()
        got = {d: _rs_resolved(spec, d, rs, manual={wed}) for d in spec}
        self.assertEqual(got[MON], [S("21:00"), S("05:30+")])
        self.assertEqual(got[TUE], [S("21:00")])  # Wednesday is manual: not closed by it
        self.assertEqual(got[wed], [S("05:30"), S("21:00")])  # untouched
        self.assertEqual(got[wed + timedelta(days=1)], [S("05:30"), S("21:00")])  # Wednesday took nothing from it
        self.assertEqual(got[wed + timedelta(days=2)], [S("05:30")])  # Thursday (even) closes nothing
        for d, secs in oracle_resolve(spec, rs, {wed}).items():
            self.assertEqual(secs, _rs_resolved(spec, d, rs, manual={wed}), d.isoformat())

    def test_evaluate_with_session_takes_the_manual_dates(self):
        rs = ruleset()
        by = {MON: [time(21, 0)], TUE: [time(5, 30)]}
        self.assertEqual(psr.evaluate_with_session(rs, MON, by)["shifts_earned"], D("1.50"))
        self.assertEqual(psr.evaluate_with_session(rs, MON, by, manual={TUE})["shifts_earned"], D("0.00"))


class HardeningArithmeticTests(SimpleTestCase):
    def test_overlapping_and_duplicate_breaks_are_one_window(self):
        m = _migration()
        groups, rules, breaks = _default_rows()
        union = psr.build_ruleset(_config(), groups, rules, breaks)
        dirty = list(breaks) + [
            breaks[1],  # the lunch row twice
            SimpleNamespace(id=50, label="x", start_time=time(13, 0), end_time=time(14, 0), enabled=True, order=50),
            SimpleNamespace(id=51, label="y", start_time=time(12, 50), end_time=time(13, 10), enabled=True, order=51),
        ]
        clean_union = psr.build_ruleset(
            _config(),
            groups,
            rules,
            [b for b in breaks if b.label != "Lunch"]
            + [
                SimpleNamespace(
                    id=52, label="Lunch", start_time=time(12, 45), end_time=time(14, 0), enabled=True, order=52
                )
            ],
        )
        merged = psr.build_ruleset(_config(), groups, rules, dirty)
        self.assertEqual(merged.breaks, clean_union.breaks)
        self.assertEqual(len(m.BREAKS), 5)
        self.assertEqual(len(union.breaks), 5)
        self.assertEqual(len(merged.breaks), 5)
        for punches in (["08:30", "20:00"], ["08:30", "13:45"], ["08:30", "14:30"], ["08:30", "22:30"]):
            self.assertEqual(
                psr.evaluate_day(merged, WED, [S(p) for p in punches])["shifts_earned"],
                psr.evaluate_day(clean_union, WED, [S(p) for p in punches])["shifts_earned"],
            )
        # the paid-time helper alone is just as safe with a hand-made overlapping list
        raw = [psr.BreakWindow("a", 3600, 7200), psr.BreakWindow("b", 3600, 7200), psr.BreakWindow("c", 5400, 9000)]
        self.assertEqual(psr.paid_seconds(0, 10800, raw), 10800 - 5400)  # the union is 1h..2h30

    def test_the_cap_comes_after_the_rounding_and_a_minimum_credit_cannot_exceed_it(self):
        cfg = _owner_cfg(start=510, points=[(1020, "1.40")], breaks=[], step="0.25", mode="nearest")
        groups, rules, breaks = _rows_for(cfg)
        rs = psr.build_ruleset(_config(rules_rounding_step=D("0.25")), groups, rules, breaks)
        # 1.40 is 5.6 steps: rounding alone would give 1.50, which is more than the table pays
        self.assertEqual(psr.evaluate_day(rs, WED, [S("08:30"), S("17:00")])["shifts_earned"], D("1.40"))
        self.assertEqual(
            psr.evaluate_day(rs, WED, [S("08:30"), S("12:45")])["shifts_earned"], D("0.75")
        )  # below: rounds as usual
        rs2 = psr.build_ruleset(_config(rules_min_credit=D("2.00")), groups, rules, breaks)
        self.assertEqual(psr.evaluate_day(rs2, WED, [S("08:30"), S("08:45")])["shifts_earned"], D("1.40"))

    def test_the_first_punch_window_is_compared_in_whole_minutes(self):
        for first_to in (time(16, 59, 59), time(16, 59)):  # the seed holds 16:59:59, the Settings page saves 16:59
            groups, rules, breaks = _default_rows()
            groups[0].first_punch_to = first_to
            rs = psr.build_ruleset(_config(), groups, rules, breaks)
            with self.subTest(first_to=first_to):
                self.assertEqual(psr.select_group(rs, WED, S("16:59:30")).label, "Day shift")
                self.assertEqual(psr.select_group(rs, WED, S("16:59")).label, "Day shift")
                self.assertEqual(psr.select_group(rs, WED, S("17:00")).label, "Night shift")

    def test_the_group_outside_every_window_is_the_circularly_nearest_start(self):
        rs = ruleset()
        for first, label in [
            ("02:00", "Night shift"),
            ("01:00", "Night shift"),
            ("03:30", "Day shift"),
            ("00:00", "Night shift"),
        ]:
            self.assertEqual(psr.select_group(rs, WED, S(first)).label, label, first)
        # the same rule on a Sunday (Sunday group start 08:30 against the Night group's 21:00)
        self.assertEqual(psr.select_group(rs, SUN, S("02:00")).label, "Night shift")
        r = psr.evaluate_day(rs, WED, [S("02:00"), S("05:30")])
        self.assertEqual(r["rule_group"], "Night shift")


# ── An independent multi-day oracle against random roster months ──────────────


def _random_month_spec(rng: random.Random, start: date, days: int) -> dict:
    spec: dict = {}

    def add(d, hhmm):
        spec.setdefault(d, []).append(hhmm)

    def at(base, spread=6):
        m = int(base[:2]) * 60 + int(base[3:5]) + rng.randint(-spread, spread)
        m = max(0, min(1439, m))
        return f"{m // 60:02d}:{m % 60:02d}:{rng.choice([0, 0, 0, 20, 59]):02d}"

    prev = "off"
    for i in range(days):
        d = start + timedelta(days=i)
        roll = rng.random()
        if prev in ("night", "half_night") and roll < 0.8:
            kind = prev
        else:
            kind = rng.choice(
                [
                    "off",
                    "off",
                    "day",
                    "day",
                    "ot",
                    "night",
                    "night",
                    "half_night",
                    "dinner_night",
                    "forgot",
                    "forgot_lunch",
                    "half",
                    "sunday_day",
                    "late_arrival",
                    "dup",
                ]
            )
        prev = kind
        if kind == "day":
            for t in ("08:30", "12:45", "13:30", "20:00"):
                add(d, at(t))
        elif kind == "ot":
            for t in ("08:30", "12:45", "13:30", "22:30"):
                add(d, at(t))
        elif kind == "night":
            add(d, at("21:00"))
            if rng.random() < 0.9:
                add(d + timedelta(days=1), at("05:30", 40))
        elif kind == "half_night":
            add(d, at("21:00"))
            if rng.random() < 0.9:
                add(d + timedelta(days=1), at("00:00", 5) if rng.random() < 0.5 else "00:05")
        elif kind == "dinner_night":
            for t in ("08:30", "12:45", "13:30", "20:00", "21:00"):
                add(d, at(t))
            add(d + timedelta(days=1), at("05:30", 30))
        elif kind == "forgot":
            for t in ("08:30", "12:45", "13:30"):
                add(d, at(t))
            if rng.random() < 0.3:
                add(d + timedelta(days=1), at("03:00", 120))
        elif kind == "forgot_lunch":
            for t in ("08:30", "13:30", "20:00"):
                add(d, at(t))
        elif kind == "half":
            add(d, at("08:30"))
            add(d, at("12:45"))
        elif kind == "sunday_day":
            add(d, at("08:30"))
            add(d, at("17:00"))
        elif kind == "late_arrival":
            add(d, at("09:40", 30))
            add(d, at("20:00"))
        elif kind == "dup":
            t = at("08:30")
            add(d, t)
            add(d, t[:6] + "10")
            add(d, at("20:00"))
    return {d: v for d, v in spec.items() if start - timedelta(days=1) <= d <= start + timedelta(days=days + 1)}


class MultiDayDifferentialTests(SimpleTestCase):
    """The engine's resolver against the fixed-point oracle over random roster months: patterns of day, OT, night-only,
    half night, dinner night, forgotten punches, double taps, Sundays, days off, manual days and an effective date inside
    the month."""

    def test_random_roster_months_resolve_like_the_oracle(self):
        rng = random.Random(20261015)
        checked = 0
        for n in range(220):
            start = date(2026, 1, 1) + timedelta(days=rng.randint(0, 60))
            days = rng.choice([14, 31, 31, 45])
            spec = _random_month_spec(rng, start, days)
            if not spec:
                continue
            effective = rng.choice(
                [date(2025, 1, 1), date(2025, 1, 1), start + timedelta(days=rng.randint(1, days - 1))]
            )
            rs = ruleset(rules_effective_from=effective, rules_night_session_hours=rng.choice([10, 12, 18, 24, 24]))
            all_days = [start + timedelta(days=i) for i in range(-1, days + 1)]
            manual = {d for d in all_days if rng.random() < 0.06}
            expected = oracle_resolve(spec, rs, manual)
            kw = psr.session_kwargs(rs, manual)
            by = _by_date(spec)
            for d in all_days:
                if d not in expected:
                    continue
                got = [s for s, _r in psr.resolve_day(by, d, **kw)]
                self.assertEqual(
                    got, expected[d], f"month #{n} day {d} (effective {effective}, manual {sorted(manual)})"
                )
                checked += 1
                # the default window is enough exactly when needs_history says so
                narrow = {k: v for k, v in by.items() if k >= d - timedelta(days=7)}
                if not psr.needs_history(narrow, d, d - timedelta(days=7), **kw):
                    self.assertEqual([s for s, _r in psr.resolve_day(narrow, d, **kw)], got, f"narrow #{n} {d}")
        self.assertGreater(checked, 5000)

    def test_a_chain_of_every_length_up_to_the_cap_matches_the_oracle(self):
        rs = ruleset()
        for nights in range(1, 63):
            spec = _night_chain(nights)
            expected = oracle_resolve(spec, rs)
            last = CHAIN_START + timedelta(days=nights)
            self.assertEqual(
                _rs_resolved(spec, last - timedelta(days=1), rs), expected[last - timedelta(days=1)], nights
            )
            self.assertEqual(_rs_resolved(spec, last, rs), expected[last], nights)


# ── The database: every way of asking agrees ─────────────────────────────────


class LoneMorningPunchThroughTheEngineTests(TestCase):
    """A worker who punches only 08:30 on Tuesday and 05:30 on Wednesday earns 3.00 on Tuesday, every way of asking."""

    def setUp(self):
        _ensure_seed()
        _set_rules(date(2026, 1, 1))
        self.emp = _worker("LONE1")

    def _snaps(self):
        day = {d: _snap(compute_day_record(self.emp, d)) for d in (TUE, WED)}
        AttendanceDayRecord.objects.filter(employee=self.emp, source="auto").delete()
        month = {r.date: _snap(r) for r in compute_month_records(self.emp, 2026, 2) if r.date in (TUE, WED)}
        AttendanceDayRecord.objects.filter(employee=self.emp, source="auto").delete()
        rng = {r.date: _snap(r) for r in compute_range_records(self.emp, TUE, WED)}
        return day, month, rng

    def test_tuesday_is_three_shifts_wednesday_is_judged_on_its_own(self):
        _punches(self.emp, TUE, "08:30")
        _punches(self.emp, WED, "05:30")
        day, month, rng = self._snaps()
        self.assertEqual(month, day)
        self.assertEqual(rng, day)
        # _snap = (status, shifts, first, last, ...): Tuesday 08:30 -> 05:30 is 3.00, Wednesday has nothing left
        self.assertEqual(day[TUE][:4], ("present", D("3.00"), time(8, 30), time(5, 30)))
        self.assertEqual(day[WED][0], "absent")
        self.assertEqual(day[WED][1], D("0.00"))

    def test_the_engine_equals_the_preview_figure_for_a_close_at_0330(self):
        _punches(self.emp, TUE, "08:30")
        _punches(self.emp, WED, "03:30")
        day, month, rng = self._snaps()
        self.assertEqual(day[TUE][1], D("2.80"))
        self.assertEqual((month, rng), (day, day))
        self.assertEqual(day[WED][0], "absent")

    def test_a_normal_arrival_after_a_lone_morning_punch_is_not_swallowed_and_0700_is(self):
        for first, swallowed in [("07:55", False), ("08:25", False), ("07:01", False), ("07:00", True)]:
            with self.subTest(first=first):
                AttendanceLog.objects.filter(employee=self.emp).delete()
                AttendanceDayRecord.objects.filter(employee=self.emp).delete()
                _punches(self.emp, TUE, "08:30")
                _punches(self.emp, WED, first, *(() if swallowed else ("12:45", "13:30", "20:00")))
                tue, wed = compute_day_record(self.emp, TUE), compute_day_record(self.emp, WED)
                if swallowed:
                    self.assertEqual((wed.status, wed.shifts_earned), ("absent", D("0.00")))
                    self.assertGreater(tue.shifts_earned, D("2.00"))
                else:
                    self.assertEqual(tue.shifts_earned, D("0.00"))  # one lone punch is not a paid day
                    self.assertEqual(wed.shifts_earned, D("1.50"))  # Wednesday on its own four punches


def _manual_record(emp, d, shifts="0.75"):
    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status="present", shifts_earned=Decimal(shifts), source="manual"
    )


class ChainThroughTheEngineTests(TestCase):
    def setUp(self):
        _ensure_seed()
        _set_rules(date(2025, 1, 1))

    def _chain(self, emp, nights, start):
        _punch(emp, start, "21:00")
        for i in range(1, nights):
            _punches(emp, start + timedelta(days=i), "05:30", "21:00")
        _punch(emp, start + timedelta(days=nights), "05:30")

    def _every_way(self, emp, first, last):
        """{date: snapshot} from compute_range_records, checked against the month, one-day ranges and compute_day_record."""
        by_range = {r.date: _snap(r) for r in compute_range_records(emp, first, last)}
        months = {}
        for y, m in sorted({(d.year, d.month) for d in by_range}):
            months.update({r.date: _snap(r) for r in compute_month_records(emp, y, m)})
        for d, snap in sorted(by_range.items()):
            self.assertEqual(months[d], snap, f"month vs range {d}")
        AttendanceDayRecord.objects.filter(employee=emp, source="auto").delete()
        for d, snap in sorted(by_range.items()):
            self.assertEqual(_snap(compute_day_record(emp, d)), snap, f"day {d}")
        AttendanceDayRecord.objects.filter(employee=emp, source="auto").delete()
        for d, snap in sorted(by_range.items()):
            [rec] = compute_range_records(emp, d, d)
            self.assertEqual(_snap(rec), snap, f"one-day range {d}")
        return by_range

    def test_a_44_night_chain_across_a_month_boundary_is_the_same_every_way(self):
        emp = _worker("CH44")
        self._chain(emp, 44, date(2026, 1, 5))  # nights Jan 5 .. Feb 17, the 05:30 closing the last on Feb 18
        got = self._every_way(emp, date(2026, 1, 28), date(2026, 2, 21))
        for d, snap in got.items():
            if d <= date(2026, 2, 17):
                self.assertEqual(
                    (snap[0], snap[1], snap[2], snap[3]), ("present", Decimal("1.50"), time(21, 0), time(5, 30)), d
                )
            else:
                self.assertEqual(snap[0], "absent", d)

    def test_twelve_three_shift_days_through_the_engine(self):
        emp = _worker("CH3S")
        day = ("08:30", "12:45", "13:30", "20:00", "21:00")
        start = date(2026, 2, 2)  # a Monday
        _punches(emp, start, *day)
        for i in range(1, 12):
            _punches(emp, start + timedelta(days=i), "05:30", *day)
        _punch(emp, start + timedelta(days=12), "05:30")
        got = self._every_way(emp, start, start + timedelta(days=13))
        for i in range(12):
            d = start + timedelta(days=i)
            self.assertEqual(got[d][1], Decimal("1.00") if d.weekday() == 6 else Decimal("3.00"), d)

    def test_manual_days_through_the_engine(self):
        emp = _worker("CHMAN")
        start = date(2026, 2, 2)
        self._chain(emp, 6, start)
        _manual_record(emp, start + timedelta(days=3))
        got = self._every_way(emp, start, start + timedelta(days=7))
        # the manual Thursday keeps its record untouched; Wednesday is not closed by it; Friday is not emptied by it
        self.assertEqual(got[start + timedelta(days=3)][1], Decimal("0.75"))
        self.assertEqual(got[start + timedelta(days=2)][2:4], (time(21, 0), None))
        self.assertEqual(got[start + timedelta(days=2)][1], Decimal("0.00"))  # [21:00] alone: one punch, unpaid
        self.assertEqual(
            got[start + timedelta(days=4)][2:4], (time(5, 30), time(21, 0))
        )  # its own 05:30, its own 21:00

    def test_a_legacy_day_before_the_effective_date_in_the_middle_of_a_chain(self):
        _set_rules(date(2026, 2, 5))
        emp = _worker("CHEFF")
        start = date(2026, 2, 2)
        self._chain(emp, 6, start)
        got = self._every_way(emp, start, start + timedelta(days=7))
        # Feb 2..4 legacy (their own punches); Feb 5 is the first day in force and keeps its own 05:30 (the legacy day
        # before it took nothing), and as its count is even it closes nothing either
        for d in (date(2026, 2, 5), date(2026, 2, 6)):
            self.assertEqual(got[d][2:4], (time(5, 30), time(21, 0)), d)

    def test_the_extension_query_is_paid_only_when_the_chain_needs_it(self):
        chain, rest = _worker("QX1"), _worker("QX2")
        self._chain(chain, 30, date(2026, 1, 5))
        # the same shape but with a day off on Jan 28: a sync point inside the default window
        self._chain(rest, 22, date(2026, 1, 5))
        self._chain(rest, 6, date(2026, 1, 29))
        for emp in (chain, rest):
            compute_range_records(emp, date(2026, 2, 1), date(2026, 2, 3))

        def count(fn):
            with CaptureQueriesContext(connection) as ctx:
                fn()
            return len(ctx)

        for label, fn in [
            ("range", lambda emp: compute_range_records(emp, date(2026, 2, 1), date(2026, 2, 3))),
            ("month", lambda emp: compute_month_records(emp, 2026, 2)),
            ("day", lambda emp: compute_day_record(emp, date(2026, 2, 1))),
        ]:
            AttendanceDayRecord.objects.filter(source="auto").delete()
            c_chain = count(lambda: fn(chain))
            AttendanceDayRecord.objects.filter(source="auto").delete()
            c_rest = count(lambda: fn(rest))
            self.assertEqual(c_chain - c_rest, 1, label)

    def test_a_manual_day_costs_no_extra_query(self):
        emp = _worker("QM1")
        self._chain(emp, 5, date(2026, 2, 2))
        compute_month_records(emp, 2026, 2)

        def count():
            with CaptureQueriesContext(connection) as ctx:
                compute_month_records(emp, 2026, 2)
            return len(ctx)

        before = count()
        _manual_record(emp, date(2026, 1, 25))  # inside the chain's look-back window, outside the month
        self.assertEqual(count(), before)

    def test_the_roster_day_prefetch_resolves_the_chain_for_every_worker(self):
        workers = [_worker(f"RC{i}") for i in range(3)]
        self._chain(workers[0], 30, date(2026, 1, 5))  # needs the extension: its 30th night is Feb 3
        self._chain(workers[1], 3, date(2026, 2, 3))
        d = date(2026, 2, 3)
        _punches(workers[2], d, "08:30", "12:45", "13:30", "20:00")
        config = ProductionShiftConfig.get()
        pf = production_prefetch_for_day([w.id for w in workers], d, config)
        settings = PayrollSettings.get()
        via_roster = {}
        for w in workers:
            logs = list(AttendanceLog.objects.filter(employee=w, date=d).order_by("punch_time"))
            via_roster[w.id] = _snap(
                compute_day_record(
                    w,
                    d,
                    punch_logs=logs,
                    settings=settings,
                    leave_dates=set(),
                    holiday_dates=set(),
                    prod_config=config,
                    prefetch={
                        "existing_day_records": {},
                        "manual_attendance_dates": set(),
                        **production_prefetch_for(pf, w.id),
                    },
                )
            )
        AttendanceDayRecord.objects.all().delete()
        for w in workers:
            self.assertEqual(_snap(compute_day_record(w, d)), via_roster[w.id], w.employee_code)
        self.assertEqual(via_roster[workers[0].id][1], Decimal("1.50"))

    def test_the_settings_row_is_read_once_by_a_single_day_call(self):
        emp = _worker("CFG1")
        _punches(emp, MON, "08:30", "12:45", "13:30", "20:00")
        for effective in (date(2025, 1, 1), date(2099, 1, 1)):  # in force, then the legacy fallback
            _set_rules(effective)
            AttendanceDayRecord.objects.filter(employee=emp).delete()
            with CaptureQueriesContext(connection) as ctx:
                compute_day_record(emp, MON)
            reads = [
                q
                for q in ctx.captured_queries
                if "production_shift_config" in q["sql"] and q["sql"].lstrip().upper().startswith("SELECT")
            ]
            self.assertEqual(len(reads), 1, effective)

    def test_random_months_through_the_database_agree_every_way(self):
        rng = random.Random(7)
        for n in range(3):
            emp = _worker(f"RND{n}")
            start = date(2026, 1, 12) + timedelta(days=n * 3)
            spec = _random_month_spec(rng, start, 40)
            for d, times in spec.items():
                seen = set()
                for hhmm in times:
                    if hhmm[:5] not in seen:  # one log per minute keeps the generated data free of unique clashes
                        seen.add(hhmm[:5])
                        _punch(emp, d, hhmm[:5])
            for d in sorted(spec)[::9]:
                _manual_record(emp, d, "0.50")
            self._every_way(emp, start, start + timedelta(days=39))


class LoaderOneSnapshotTests(TestCase):
    """load_ruleset reads the groups, rules and breaks in ONE statement (one snapshot): a settings save that commits
    between three separate reads can no longer produce a table that was never saved."""

    def setUp(self):
        _ensure_seed()
        self.config = _set_rules()

    def _orm_ruleset(self, config):
        return psr.build_ruleset(
            config,
            list(ProductionShiftGroup.objects.order_by("order", "id")),
            list(ProductionShiftRule.objects.order_by("order", "id")),
            list(ProductionBreak.objects.order_by("order", "id")),
        )

    def test_the_three_tables_are_read_by_one_query(self):
        config = ProductionShiftConfig.get()
        with CaptureQueriesContext(connection) as ctx:
            psr.load_ruleset(config)
        self.assertEqual(len(ctx), 1, [q["sql"][:80] for q in ctx.captured_queries])
        sql = ctx.captured_queries[0]["sql"]
        for table in ("production_shift_groups", "production_shift_rules", "production_breaks"):
            self.assertIn(table, sql)

    def test_it_is_remembered_on_the_config_instance(self):
        config = ProductionShiftConfig.get()
        first = psr.load_ruleset(config)
        with CaptureQueriesContext(connection) as ctx:
            self.assertIs(psr.load_ruleset(config), first)
        self.assertEqual(len(ctx), 0)

    def test_the_result_is_the_one_the_orm_rows_build(self):
        def same(label):
            config = ProductionShiftConfig.get()
            self.assertEqual(psr.load_ruleset(config), self._orm_ruleset(ProductionShiftConfig.get()), label)

        same("seed")
        ProductionShiftRule.objects.filter(group__kind="day", out_time=time(17, 45)).update(enabled=False)
        ProductionBreak.objects.filter(label="Lunch").update(enabled=False)
        same("disabled rule and break")
        ProductionShiftGroup.objects.filter(kind="sunday").update(enabled=False)
        same("disabled group")
        group = ProductionShiftGroup.objects.get(kind="night")
        ProductionShiftRule.objects.create(
            group=group,
            label="Very late",
            out_time=time(6, 45),
            out_next_day=True,
            shift_value=Decimal("1.75"),
            order=99,
        )
        ProductionShiftGroup.objects.filter(pk=group.pk).update(main_out_time=None, first_punch_to=time(23, 59, 30))
        same("a new next-day rule, no standard departure, a first-punch window with seconds")
        ProductionBreak.objects.all().delete()
        same("no breaks")
        ProductionShiftRule.objects.all().delete()
        same("no rules at all")
        ProductionShiftGroup.objects.all().delete()
        same("an empty table")
        self.assertEqual(psr.load_ruleset(ProductionShiftConfig.get()).groups, ())

    def test_the_fallback_for_another_database_reads_the_same_rules(self):
        config = ProductionShiftConfig.get()
        with CaptureQueriesContext(connection) as ctx:
            groups, rules, breaks = psr._read_tables_orm()
        self.assertEqual(len(ctx), 3)
        self.assertEqual(
            psr.build_ruleset(config, groups, rules, breaks), psr.load_ruleset(ProductionShiftConfig.get())
        )
