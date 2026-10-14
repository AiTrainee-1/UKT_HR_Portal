"""The pure rule arithmetic of the OT / Compensation engine (compensation_rules.py): no database.

Every boundary of the owner's tables is pinned here: exactly 1 h, 59 minutes, exactly 2 h 30, 21:00 sharp, 00:00, 02:00,
06:00 and later, disabled rows, added rows, empty tables, plus the ladder / allowance validation Settings relies on.

Run via: python manage.py test api.tests_compensation_rules -v 2
"""

from datetime import date, time
from decimal import Decimal

from django.test import SimpleTestCase

from . import compensation_rules as r
from .compensation_rules import AllowanceRule, ShiftRule

DEFAULT_ALLOWANCE = [
    AllowanceRule(60, 30, label="1 hour"),
    AllowanceRule(90, 30, label="1 hour 30 minutes"),
    AllowanceRule(120, 60, label="2 hours"),
    AllowanceRule(150, 60, label="2 hours 30 minutes"),
]
DEFAULT_LADDER = [
    ShiftRule(1260, Decimal("0.25")),
    ShiftRule(1440, Decimal("0.50")),
    ShiftRule(1560, Decimal("0.75")),
    ShiftRule(None, Decimal("1.00")),
]


class ClockTests(SimpleTestCase):
    def test_clock_to_minutes_takes_times_and_text_and_drops_seconds(self):
        self.assertEqual(r.clock_to_minutes(time(21, 0, 59)), 1260)
        self.assertEqual(r.clock_to_minutes("21:00"), 1260)
        self.assertEqual(r.clock_to_minutes("00:05:30"), 5)
        self.assertEqual(r.clock_to_minutes(time(0, 0)), 0)

    def test_after_midnight_is_1440_plus(self):
        self.assertEqual(r.minutes_to_clock(1500), "01:00")
        self.assertEqual(r.minutes_to_clock(1440), "00:00")
        self.assertEqual(r.minutes_to_clock(1259), "20:59")
        self.assertEqual(r.describe_clock(1260), "9:00 PM")
        self.assertEqual(r.describe_clock(1440), "12:00 AM (next day)")
        self.assertEqual(r.describe_clock(1500), "1:00 AM (next day)")
        self.assertEqual(r.describe_clock(0), "12:00 AM")
        self.assertEqual(r.describe_clock(12 * 60), "12:00 PM")

    def test_describe_duration(self):
        self.assertEqual(r.describe_duration(60), "1 hour")
        self.assertEqual(r.describe_duration(90), "1 hour 30 minutes")
        self.assertEqual(r.describe_duration(150), "2 hours 30 minutes")
        self.assertEqual(r.describe_duration(45), "45 minutes")
        self.assertEqual(r.describe_duration(1), "1 minute")

    def test_seconds_to_minutes_is_the_minute_the_punch_was_made_in(self):
        self.assertEqual(r.seconds_to_minutes(20 * 3600 + 59 * 60 + 59), 20 * 60 + 59)
        self.assertEqual(r.seconds_to_minutes(21 * 3600), 1260)


class ExtraMinutesTests(SimpleTestCase):
    END = 17 * 3600 + 30 * 60  # a 17:30 shift end

    def test_whole_minutes_past_the_end(self):
        self.assertEqual(r.extra_minutes(18 * 3600 + 30 * 60, self.END), 60)
        self.assertEqual(
            r.extra_minutes(18 * 3600 + 29 * 60 + 59, self.END), 59
        )  # the minute 18:29, one short of an hour
        self.assertEqual(r.extra_minutes(self.END, self.END), 0)
        self.assertEqual(r.extra_minutes(17 * 3600, self.END), 0)  # before the end: never negative

    def test_a_punch_after_midnight_is_past_the_end_not_before_it(self):
        # 01:00 the next calendar day, as the engine's seconds-since-this-day's-midnight list carries it
        one_am = 86400 + 3600
        self.assertEqual(r.extra_minutes(one_am, self.END), 450)
        # the clock-time subtraction the first OT screen used would have said 3600 - 63000 < 0
        self.assertLess(3600 - self.END, 0)

    def test_an_overnight_shift_end_is_past_86400(self):
        end = 86400 + 6 * 3600  # a shift ending at 06:00 the next day
        self.assertEqual(r.extra_minutes(86400 + 7 * 3600, end), 60)


class AllowanceTests(SimpleTestCase):
    def test_default_table_boundaries(self):
        a = lambda extra: r.allowance_minutes_for(extra, DEFAULT_ALLOWANCE)  # noqa: E731
        self.assertEqual(a(0), 0)
        self.assertEqual(a(59), 0)  # one minute short of the first schedule
        self.assertEqual(a(60), 30)  # exactly 1 h
        self.assertEqual(a(89), 30)
        self.assertEqual(a(90), 30)  # 1 h 30
        self.assertEqual(a(119), 30)
        self.assertEqual(a(120), 60)  # 2 h
        self.assertEqual(a(149), 60)
        self.assertEqual(a(150), 60)  # exactly 2 h 30
        self.assertEqual(a(10_000), 60)  # the biggest schedule keeps applying above it

    def test_applies_only_up_to_the_type_2_threshold(self):
        a = lambda extra: r.allowance_minutes_for(extra, DEFAULT_ALLOWANCE, max_extra=150)  # noqa: E731
        self.assertEqual(a(150), 60)  # exactly 2 h 30 is still Type 1's
        self.assertEqual(a(151), 0)  # more than 2 h 30 is Type 2's

    def test_the_row_with_the_biggest_min_extra_wins_not_the_biggest_allowance(self):
        rows = [AllowanceRule(60, 90), AllowanceRule(120, 15)]
        self.assertEqual(r.allowance_minutes_for(130, rows), 15)
        self.assertEqual(r.allowance_minutes_for(100, rows), 90)

    def test_a_disabled_row_is_skipped(self):
        rows = [
            AllowanceRule(60, 30),
            AllowanceRule(90, 30),
            AllowanceRule(120, 60),
            AllowanceRule(150, 60, enabled=False),
        ]
        self.assertEqual(r.allowance_minutes_for(150, rows), 60)  # falls back to the 2 h row
        rows[2] = AllowanceRule(120, 60, enabled=False)
        self.assertEqual(r.allowance_minutes_for(150, rows), 30)  # then to the 1 h 30 row
        self.assertEqual(r.allowance_minutes_for(60, [AllowanceRule(60, 30, enabled=False)]), 0)

    def test_an_added_row_works(self):
        rows = DEFAULT_ALLOWANCE + [AllowanceRule(30, 15, label="Half an hour")]
        self.assertEqual(r.allowance_minutes_for(30, rows), 15)
        self.assertEqual(r.allowance_minutes_for(45, rows), 15)
        self.assertEqual(r.allowance_minutes_for(60, rows), 30)

    def test_an_empty_table_gives_nothing(self):
        self.assertEqual(r.allowance_minutes_for(200, []), 0)
        self.assertEqual(r.allowance_minutes_for(200, None), 0)
        self.assertIsNone(r.allowance_rule_for(200, []))

    def test_a_zero_minute_rule_is_a_valid_no_op(self):
        self.assertEqual(r.allowance_minutes_for(60, [AllowanceRule(60, 0)]), 0)

    def test_none_or_negative_extra_gives_nothing(self):
        self.assertEqual(r.allowance_minutes_for(None, DEFAULT_ALLOWANCE), 0)
        self.assertEqual(r.allowance_minutes_for(-5, DEFAULT_ALLOWANCE), 0)


class ShiftLadderTests(SimpleTestCase):
    def s(self, minutes, rows=DEFAULT_LADDER):
        return r.shift_for_last_punch(minutes, rows)

    def test_default_ladder_boundaries(self):
        self.assertEqual(self.s(20 * 60), Decimal("0.25"))  # 20:00
        self.assertEqual(self.s(20 * 60 + 59), Decimal("0.25"))  # 20:59 is still before 21:00
        self.assertEqual(self.s(21 * 60), Decimal("0.50"))  # 21:00 sharp is already the 0.50 row
        self.assertEqual(self.s(23 * 60 + 59), Decimal("0.50"))
        self.assertEqual(self.s(24 * 60), Decimal("0.75"))  # 00:00 is the 0.75 row
        self.assertEqual(self.s(24 * 60 + 59), Decimal("0.75"))
        self.assertEqual(self.s(25 * 60 + 59), Decimal("0.75"))  # 01:59
        self.assertEqual(self.s(26 * 60), Decimal("1.00"))  # 02:00
        self.assertEqual(self.s(30 * 60), Decimal("1.00"))  # 06:00 and later
        self.assertEqual(self.s(40 * 60), Decimal("1.00"))

    def test_the_threshold_decides_whether_a_day_qualifies_at_all(self):
        f = lambda extra: r.shift_for_last_punch(20 * 60 + 30, DEFAULT_LADDER, extra=extra, min_extra_minutes=150)  # noqa: E731
        self.assertIsNone(f(150))  # exactly 2 h 30 is Type 1's
        self.assertEqual(f(151), Decimal("0.25"))
        self.assertIsNone(f(60))
        self.assertTrue(r.is_type2_day(151, 150))
        self.assertFalse(r.is_type2_day(150, 150))

    def test_rows_are_looked_up_in_until_order_whatever_the_order_given(self):
        shuffled = [DEFAULT_LADDER[3], DEFAULT_LADDER[1], DEFAULT_LADDER[0], DEFAULT_LADDER[2]]
        self.assertEqual(self.s(22 * 60, shuffled), Decimal("0.50"))
        self.assertEqual(self.s(40 * 60, shuffled), Decimal("1.00"))

    def test_a_disabled_row_is_skipped(self):
        rows = [
            ShiftRule(1260, Decimal("0.25")),
            ShiftRule(1440, Decimal("0.50"), enabled=False),
            ShiftRule(1560, Decimal("0.75")),
            ShiftRule(None, Decimal("1.00")),
        ]
        self.assertEqual(self.s(22 * 60, rows), Decimal("0.75"))  # the 0.50 row is off: the next row up takes it

    def test_an_added_row_works(self):
        rows = [ShiftRule(1200, Decimal("0.25")), *DEFAULT_LADDER]  # a new "before 20:00" row
        self.assertEqual(self.s(19 * 60 + 59, rows), Decimal("0.25"))
        self.assertEqual(self.s(20 * 60, rows), Decimal("0.25"))  # then the 21:00 row takes 20:00-20:59 as before

    def test_no_enabled_row_or_an_empty_ladder_gives_none(self):
        self.assertIsNone(self.s(22 * 60, []))
        self.assertIsNone(self.s(22 * 60, [ShiftRule(None, Decimal("1.00"), enabled=False)]))
        self.assertIsNone(self.s(22 * 60, None))

    def test_a_ladder_without_a_no_limit_row_has_a_gap_after_its_last_limit(self):
        rows = [ShiftRule(1260, Decimal("0.25")), ShiftRule(1440, Decimal("0.50"))]
        self.assertEqual(self.s(1439, rows), Decimal("0.50"))
        self.assertIsNone(self.s(1440, rows))

    def test_normalise_shifts_only_accepts_the_four_steps(self):
        for value, expected in [
            (0.25, "0.25"),
            ("0.5", "0.50"),
            (0.75, "0.75"),
            (1, "1.00"),
            ("1.00", "1.00"),
            (Decimal("0.50"), "0.50"),
        ]:
            self.assertEqual(r.normalise_shifts(value), Decimal(expected), value)
        for bad in (0, 0.3, 1.25, 2, -0.25, "x", None, True, "", "0.255"):
            self.assertIsNone(r.normalise_shifts(bad), bad)


class ValidationTests(SimpleTestCase):
    def a(self, *rows):
        return r.validate_allowance_rows(list(rows))

    def s(self, *rows):
        return r.validate_shift_rows(list(rows))

    def test_the_defaults_are_valid(self):
        self.assertEqual(
            self.a(
                *[
                    {"min_extra_minutes": x.min_extra_minutes, "allowance_minutes": x.allowance_minutes}
                    for x in DEFAULT_ALLOWANCE
                ]
            ),
            [],
        )
        self.assertEqual(self.s(*[{"until_minutes": x.until_minutes, "shifts": x.shifts} for x in DEFAULT_LADDER]), [])

    def test_allowance_minutes_must_be_0_to_240(self):
        ok = {"min_extra_minutes": 60, "allowance_minutes": 240}
        self.assertEqual(self.a(ok), [])
        self.assertEqual(self.a({**ok, "allowance_minutes": 0}), [])
        self.assertIn("between 0 and 240", self.a({**ok, "allowance_minutes": 241})[0])
        self.assertIn("between 0 and 240", self.a({**ok, "allowance_minutes": -1})[0])
        self.assertIn("between 0 and 240", self.a({**ok, "allowance_minutes": None})[0])
        self.assertIn("between 0 and 240", self.a({**ok, "allowance_minutes": 30.5})[0])

    def test_min_extra_minutes_must_be_a_whole_number_of_at_least_one(self):
        self.assertIn("at least 1", self.a({"min_extra_minutes": 0, "allowance_minutes": 30})[0])
        self.assertIn("at least 1", self.a({"min_extra_minutes": None, "allowance_minutes": 30})[0])
        self.assertIn("at least 1", self.a({"min_extra_minutes": "x", "allowance_minutes": 30})[0])
        self.assertEqual(self.a({"min_extra_minutes": 1, "allowance_minutes": 30}), [])

    def test_two_enabled_allowance_rows_cannot_start_at_the_same_point(self):
        problems = self.a(
            {"min_extra_minutes": 60, "allowance_minutes": 30},
            {"min_extra_minutes": 60, "allowance_minutes": 45},
        )
        self.assertIn("both start at 1 hour", problems[0])
        # a disabled duplicate is fine
        self.assertEqual(
            self.a(
                {"min_extra_minutes": 60, "allowance_minutes": 30},
                {"min_extra_minutes": 60, "allowance_minutes": 45, "enabled": False},
            ),
            [],
        )

    def test_shifts_must_be_one_of_the_four_steps(self):
        self.assertIn("0.25, 0.50, 0.75 or 1", self.s({"until_minutes": None, "shifts": 0.3})[0])
        self.assertIn("0.25, 0.50, 0.75 or 1", self.s({"until_minutes": None, "shifts": 2})[0])
        self.assertEqual(self.s({"until_minutes": None, "shifts": 1}), [])

    def test_the_ladder_must_strictly_increase_among_enabled_rows(self):
        problems = self.s(
            {"until_minutes": 1440, "shifts": 0.25},
            {"until_minutes": 1260, "shifts": 0.5},
            {"until_minutes": None, "shifts": 1},
        )
        self.assertIn("later than the row before it", problems[0])
        equal = self.s(
            {"until_minutes": 1260, "shifts": 0.25},
            {"until_minutes": 1260, "shifts": 0.5},
            {"until_minutes": None, "shifts": 1},
        )
        self.assertIn("later than the row before it", equal[0])
        # a DISABLED row out of order does not matter
        self.assertEqual(
            self.s(
                {"until_minutes": 1440, "shifts": 0.25},
                {"until_minutes": 1260, "shifts": 0.5, "enabled": False},
                {"until_minutes": None, "shifts": 1},
            ),
            [],
        )

    def test_only_the_last_enabled_row_may_and_must_have_no_limit(self):
        early = self.s({"until_minutes": None, "shifts": 0.25}, {"until_minutes": 1440, "shifts": 1})
        self.assertTrue(any("not the last row" in p for p in early))
        no_open = self.s({"until_minutes": 1260, "shifts": 0.25}, {"until_minutes": 1440, "shifts": 1})
        self.assertTrue(any("must have no time limit" in p for p in no_open))
        # the open row may be disabled only if another enabled row is last and open
        self.assertEqual(self.s({"until_minutes": None, "shifts": 1}), [])

    def test_the_limit_is_bounded(self):
        self.assertIn("between", self.s({"until_minutes": 0, "shifts": 1, "enabled": True})[0])
        self.assertIn("between", self.s({"until_minutes": 3000, "shifts": 1})[0])
        self.assertIn("between", self.s({"until_minutes": "x", "shifts": 1})[0])

    def test_an_empty_table_has_no_syntax_problem(self):
        self.assertEqual(self.a(), [])
        self.assertEqual(self.s(), [])

    def test_labels_are_length_limited(self):
        long = "x" * 81
        self.assertIn("longer than 80", self.a({"min_extra_minutes": 60, "allowance_minutes": 30, "label": long})[0])
        self.assertIn("longer than 80", self.s({"until_minutes": None, "shifts": 1, "label": long})[0])


class BirthdayTests(SimpleTestCase):
    def test_month_and_day_match_in_any_year(self):
        self.assertTrue(r.is_birthday(date(1990, 3, 5), date(2026, 3, 5)))
        self.assertFalse(r.is_birthday(date(1990, 3, 5), date(2026, 3, 6)))
        self.assertFalse(r.is_birthday(date(1990, 3, 5), date(2026, 4, 5)))

    def test_29_february_is_28_february_in_a_non_leap_year_only(self):
        dob = date(2000, 2, 29)
        self.assertTrue(r.is_birthday(dob, date(2026, 2, 28)))
        self.assertFalse(r.is_birthday(dob, date(2026, 3, 1)))  # not also on 1 March
        self.assertTrue(r.is_birthday(dob, date(2028, 2, 29)))  # a leap year: the real day
        self.assertFalse(r.is_birthday(dob, date(2028, 2, 28)))
        self.assertTrue(r.is_birthday(dob, date(2024, 2, 29)))
        self.assertTrue(r.is_birthday(dob, date(2100, 2, 28)))  # 2100 is not a leap year

    def test_28_february_is_never_moved(self):
        self.assertTrue(r.is_birthday(date(1999, 2, 28), date(2028, 2, 28)))
        self.assertFalse(r.is_birthday(date(1999, 2, 28), date(2028, 2, 29)))

    def test_no_date_of_birth(self):
        self.assertFalse(r.is_birthday(None, date(2026, 3, 5)))


class WorkingDayWalkTests(SimpleTestCase):
    def test_the_previous_working_day_skips_off_days(self):
        # Monday 9 March 2026: Sunday 8 is off, Saturday 7 is working
        off = lambda d: d.weekday() == 6  # noqa: E731
        self.assertEqual(r.previous_working_day(date(2026, 3, 9), off), date(2026, 3, 7))
        # with Saturday off too, Friday 6
        off2 = lambda d: d.weekday() in (5, 6)  # noqa: E731
        self.assertEqual(r.previous_working_day(date(2026, 3, 9), off2), date(2026, 3, 6))
        self.assertEqual(r.previous_working_day(date(2026, 3, 4), off), date(2026, 3, 3))

    def test_nothing_within_the_look_back_is_none(self):
        self.assertIsNone(r.previous_working_day(date(2026, 3, 9), lambda d: True))
        # a long break: more off days than the look-back
        self.assertIsNone(
            r.previous_working_day(date(2026, 3, 20), lambda d: date(2026, 3, 1) <= d < date(2026, 3, 20))
        )
        off = lambda d: date(2026, 3, 2) <= d < date(2026, 3, 11)  # noqa: E731
        self.assertIsNone(r.previous_working_day(date(2026, 3, 11), off, lookback=9))
        self.assertEqual(r.previous_working_day(date(2026, 3, 11), off), date(2026, 3, 1))  # the 10th day back
        self.assertEqual(
            r.previous_working_day(date(2026, 3, 11), lambda d: date(2026, 3, 3) <= d < date(2026, 3, 11)),
            date(2026, 3, 2),
        )


class ZoneRankTests(SimpleTestCase):
    def test_better_zones_rank_lower(self):
        self.assertLess(r.zone_rank("on_time"), r.zone_rank("late"))
        self.assertLess(r.zone_rank("late"), r.zone_rank("quarter"))
        self.assertLess(r.zone_rank("quarter"), r.zone_rank("second_half"))
        self.assertEqual(r.zone_rank("late"), r.zone_rank("excused"))
        self.assertEqual(r.zone_rank(None), 0)
