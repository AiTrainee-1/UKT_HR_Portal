"""The morning arrival timeline as pure rules (arrival_rules.py). The same worked examples as
frontend/src/lib/arrival-rules.test.ts, so the Settings preview and the engine can never disagree about which side of a
limit a punch is on. The engine behaviour itself (status, shifts earned, late pool) is in tests_late_permission_rules.py."""

from datetime import time
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase

from .arrival_rules import (
    ZONE_EXCUSED,
    ZONE_LATE,
    ZONE_ON_TIME,
    ZONE_QUARTER,
    ZONE_SECOND_HALF,
    explain,
    hhmm,
    limits_for,
    zone_of,
)

DEFAULTS = SimpleNamespace(
    arrival_late_window_minutes=60,
    arrival_permission_window_minutes=60,
    arrival_extra_minutes=20,
    arrival_quarter_deduction=Decimal("0.25"),
)


def _shift(start=time(9, 0), grace=15):
    return SimpleNamespace(start_time=start, grace_period_minutes=grace)


def _secs(h, m, s=0):
    return h * 3600 + m * 60 + s


class LimitsTests(SimpleTestCase):
    def test_every_limit_follows_the_previous_one(self):
        limits = limits_for(_shift(grace=10), DEFAULTS)
        self.assertEqual(
            [
                hhmm(x)
                for x in (limits.on_time_until, limits.late_until, limits.permission_until, limits.first_half_until)
            ],
            ["09:10", "10:10", "11:10", "11:30"],
        )

    def test_they_follow_each_shifts_own_start_and_grace(self):
        limits = limits_for(_shift(start=time(14, 0), grace=5), DEFAULTS)
        self.assertEqual(
            [
                hhmm(x)
                for x in (limits.on_time_until, limits.late_until, limits.permission_until, limits.first_half_until)
            ],
            ["14:05", "15:05", "16:05", "16:25"],
        )

    def test_they_follow_the_settings(self):
        custom = SimpleNamespace(
            arrival_late_window_minutes=30,
            arrival_permission_window_minutes=30,
            arrival_extra_minutes=10,
            arrival_quarter_deduction=Decimal("0.5"),
        )
        limits = limits_for(_shift(grace=15), custom)
        self.assertEqual(
            [
                hhmm(x)
                for x in (limits.on_time_until, limits.late_until, limits.permission_until, limits.first_half_until)
            ],
            ["09:15", "09:45", "10:15", "10:25"],
        )

    def test_no_shift_means_no_timeline(self):
        self.assertIsNone(limits_for(None, DEFAULTS))
        self.assertIsNone(limits_for(SimpleNamespace(start_time=None, grace_period_minutes=0), DEFAULTS))

    def test_junk_settings_fall_back_instead_of_breaking_a_day(self):
        junk = SimpleNamespace(
            arrival_late_window_minutes=None,
            arrival_permission_window_minutes="x",
            arrival_extra_minutes=-5,
            arrival_quarter_deduction=Decimal("0.25"),
        )
        limits = limits_for(_shift(grace=0), junk)
        self.assertEqual(hhmm(limits.late_until), "10:00")  # None -> default 60
        self.assertEqual(hhmm(limits.permission_until), "11:00")  # "x" -> default 60
        self.assertEqual(hhmm(limits.first_half_until), "11:00")  # negative -> 0


class ZoneTests(SimpleTestCase):
    limits = limits_for(_shift(grace=15), DEFAULTS)  # 09:15 / 10:15 / 11:15 / 11:35

    def test_a_first_punch_falls_in_exactly_one_zone(self):
        table = [
            ((9, 15), ZONE_ON_TIME),
            ((9, 16), ZONE_LATE),
            ((10, 15), ZONE_LATE),
            ((10, 16), ZONE_QUARTER),
            ((11, 15), ZONE_QUARTER),
            ((11, 35), ZONE_QUARTER),
            ((11, 36), ZONE_SECOND_HALF),
            ((13, 40), ZONE_SECOND_HALF),
            ((6, 0), ZONE_ON_TIME),
        ]
        for (h, m), zone in table:
            self.assertEqual(zone_of(_secs(h, m), self.limits, False), zone, (h, m))

    def test_seconds_never_move_a_limit(self):
        self.assertEqual(zone_of(_secs(9, 15, 59), self.limits, False), ZONE_ON_TIME)
        self.assertEqual(zone_of(_secs(9, 16, 0), self.limits, False), ZONE_LATE)
        self.assertEqual(zone_of(_secs(10, 15, 59), self.limits, False), ZONE_LATE)
        self.assertEqual(zone_of(_secs(11, 35, 59), self.limits, False), ZONE_QUARTER)

    def test_a_covering_permission_excuses_to_the_end_of_the_permission_window_only(self):
        table = [
            ((9, 15), ZONE_ON_TIME),
            ((9, 40), ZONE_EXCUSED),
            ((10, 40), ZONE_EXCUSED),
            ((11, 15), ZONE_EXCUSED),
            ((11, 16), ZONE_QUARTER),
            ((11, 36), ZONE_SECOND_HALF),
        ]
        for (h, m), zone in table:
            self.assertEqual(zone_of(_secs(h, m), self.limits, True), zone, (h, m))

    def test_a_punch_after_midnight_of_the_working_day_is_second_half(self):
        self.assertEqual(zone_of(_secs(25, 0), self.limits, False), ZONE_SECOND_HALF)


class ExplainTests(SimpleTestCase):
    limits = limits_for(_shift(grace=15), DEFAULTS)

    def test_the_sentences_name_the_punch_and_the_limits(self):
        excused = explain(ZONE_EXCUSED, _secs(10, 40), self.limits, True, Decimal("0.25"))
        self.assertIn("first punch 10:40", excused)
        self.assertIn("until 11:15", excused)
        quarter = explain(ZONE_QUARTER, _secs(11, 0), self.limits, False, Decimal("0.25"))
        self.assertIn("after the Late window ended (10:15)", quarter)
        self.assertIn("0.25 shift deducted", quarter)
        self.assertIn("until 11:35", quarter)
        with_permission = explain(ZONE_QUARTER, _secs(11, 20), self.limits, True, Decimal("0.25"))
        self.assertIn("after the permission window ended (11:15)", with_permission)
        second = explain(ZONE_SECOND_HALF, _secs(12, 30), self.limits, False, Decimal("0.25"))
        self.assertIn("first punch 12:30", second)
        self.assertIn("(11:35)", second)
        self.assertIn("Absent until a second-half punch", second)

    def test_a_zero_deduction_and_an_already_half_day_are_worded_honestly(self):
        self.assertIn("no shift deducted (set to 0)", explain(ZONE_QUARTER, _secs(11, 0), self.limits, False, 0))
        half = explain(ZONE_QUARTER, _secs(11, 0), self.limits, False, Decimal("0.25"), deducted=False)
        self.assertIn("nothing further is deducted", half)
        self.assertNotIn("0.25 shift deducted", half)

    def test_on_time_and_late_have_no_sentence_of_their_own(self):
        self.assertIsNone(explain(ZONE_ON_TIME, _secs(9, 0), self.limits, False, Decimal("0.25")))
        self.assertIsNone(explain(ZONE_LATE, _secs(9, 30), self.limits, False, Decimal("0.25")))

    def test_hhmm_wraps_past_midnight(self):
        self.assertEqual(hhmm(_secs(25, 5)), "01:05")
