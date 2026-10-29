"""Geo-Tracking: the journey pipeline (api/geo_tracking/journey.py) on synthetic tracks, and rebuild(track) on the database.

Every pipeline test builds its track from a few helpers (drive / dwell / explicit points) so the expected answer can be read
off the construction: a 3-minute stop exactly at / under / over the threshold, merged stops, GPS jitter, a drive with a gap
of each cause, distance against the haversine of a known path, and the invariant that travel + stop + gap seconds add up to
the covered duty time.

Run:  DB_NAME=uktex_fix_geo python manage.py test api.tests_geo_tracking_pipeline --noinput
"""

import math
import random
from datetime import timedelta

from django.test import SimpleTestCase

from .geo_tracking import journey
from .geo_tracking.journey import Ev, Fix, Params
from .geo_utils import haversine_distance_m
from .models import DutyTrack, DutyTrackEvent, DutyTrackPoint, DutyTrackSegment, GeoTrackingSettings
from .tests_geo_tracking_support import LAT0, LNG0, T0, GeoBase, offset_latlng

E0 = 1_760_000_000
P = Params()


def F(t, north=0.0, east=0.0, acc=8.0, **kw) -> Fix:
    """A fix t seconds after E0, `north`/`east` metres from the origin."""
    lat, lng = offset_latlng(LAT0, LNG0, north, east)
    return Fix(t=E0 + t, lat=lat, lng=lng, acc=acc, seq=kw.pop("seq", E0 + t), **kw)


def drive(t0, n, *, step_s=10, step_m=150.0, north0=0.0, east0=0.0, heading="north", acc=8.0, **kw):
    out = []
    for k in range(n):
        d = k * step_m
        out.append(
            F(
                t0 + k * step_s,
                north0 + (d if heading == "north" else 0.0),
                east0 + (d if heading == "east" else 0.0),
                acc,
                **kw,
            )
        )
    return out


def dwell(t0, seconds, *, step_s=10, north=0.0, east=0.0, jitter=0.0, acc=8.0, **kw):
    """Fixes every step_s from t0 to t0+seconds inclusive, standing at (north, east) (jitter walks the four compass points)."""
    pattern = [(jitter, 0.0), (0.0, jitter), (-jitter, 0.0), (0.0, -jitter)]
    out = []
    for k in range(seconds // step_s + 1):
        dn, de = pattern[k % 4]
        out.append(F(t0 + k * step_s, north + dn, east + de, acc, **kw))
    return out


def run(fixes, events=(), *, started=None, ended=None, p=P) -> journey.Journey:
    return journey.compute_journey(list(fixes), list(events), p, started_at=started, ended_at=ended)


def kinds(j):
    return [s.kind for s in j.segments]


class StopThresholdTests(SimpleTestCase):
    def test_a_dwell_of_exactly_the_threshold_is_a_stop(self):
        j = run(dwell(0, 180))
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.segments[0].duration_s, 180)

    def test_a_dwell_just_under_the_threshold_is_not_a_stop(self):
        j = run(dwell(0, 170))
        self.assertEqual(kinds(j), ["travel"])
        self.assertEqual(j.summary["stop_count"], 0)

    def test_a_dwell_over_the_threshold_is_a_stop_with_its_place_and_times(self):
        j = run(dwell(0, 190, north=500.0, east=-200.0))
        (stop,) = j.segments
        self.assertEqual((stop.kind, stop.start - E0, stop.end - E0, stop.duration_s), ("stop", 0, 190, 190))
        self.assertAlmostEqual(
            haversine_distance_m(stop.center[0], stop.center[1], *offset_latlng(LAT0, LNG0, 500.0, -200.0)),
            0,
            delta=1.0,
        )
        self.assertEqual(stop.point_count, 20)
        self.assertEqual(j.summary["longest_stop_s"], 190)

    def test_the_threshold_follows_the_setting(self):
        longer = Params(stop_seconds=600)
        self.assertEqual(kinds(run(dwell(0, 400), p=longer)), ["travel"])
        self.assertEqual(kinds(run(dwell(0, 610), p=longer)), ["stop"])

    def test_a_drive_a_stop_and_a_drive(self):
        a = drive(0, 30)  # 290 s north, ending at 4350 m
        stop = dwell(300, 300, north=4350.0)
        b = drive(610, 30, north0=4350.0)
        j = run(a + stop + b)
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        self.assertEqual(j.summary["stop_count"], 1)
        # the drive's last fix and the next drive's first fix are at the same place as the dwell: the stop reaches them
        self.assertEqual(j.segments[1].start, E0 + 290)
        self.assertEqual(j.segments[1].end, E0 + 610)
        self.assertEqual(j.segments[2].start, j.segments[1].end)

    def test_a_walking_pause_shorter_than_the_threshold_stays_travel(self):
        a = drive(0, 20)
        pause = dwell(200, 100, north=2850.0)
        b = drive(310, 20, north0=2850.0)
        self.assertEqual(kinds(run(a + pause + b)), ["travel"])


class MergedStopTests(SimpleTestCase):
    def test_two_dwells_70_metres_apart_with_a_short_walk_between_are_two_stops(self):
        # two breaks of four minutes each, tight and 70 m apart, are two places whatever radius the stop rule uses: every
        # place where the person stopped for more than three minutes is a stop of its own (this used to be ONE stop)
        stop_a = dwell(0, 240)
        walk = [F(250, 0, 14), F(260, 0, 28), F(270, 0, 42), F(280, 0, 56)]
        stop_b = dwell(290, 240, east=70.0)
        j = run(stop_a + walk + stop_b)
        self.assertEqual(kinds(j), ["stop", "travel", "stop"])
        first, _, second = j.segments
        # the walk's first fix (14 m from the first place) is still "there"; the fix half way (28 m from the first,
        # 42 m from the second) belongs to neither and is travel
        self.assertEqual((first.start - E0, first.end - E0), (0, 250))
        self.assertEqual((second.start - E0, second.end - E0), (270, 530))
        self.assertLessEqual(first.radius_m, 14.0)
        self.assertLessEqual(second.radius_m, 28.0)

    def test_two_stops_further_apart_than_twice_the_radius_stay_two(self):
        stop_a = dwell(0, 240)
        walk = [F(250, 0, 40), F(260, 0, 80), F(270, 0, 120)]
        stop_b = dwell(280, 240, east=160.0)
        j = run(stop_a + walk + stop_b)
        self.assertEqual(kinds(j).count("stop"), 2)

    def test_two_stops_at_the_same_place_separated_by_a_long_excursion_stay_two(self):
        stop_a = dwell(0, 240)
        out_and_back = [F(240 + 10 * k, 0, 150 * min(k, 20 - k)) for k in range(1, 20)]  # 190 s away and back
        stop_b = dwell(440, 240, east=60.0)
        j = run(stop_a + out_and_back + stop_b)
        self.assertEqual(kinds(j).count("stop"), 2)
        self.assertEqual(j.summary["stop_count"], 2)

    def test_two_stops_at_the_same_place_with_a_brief_excursion_are_one(self):
        stop_a = dwell(0, 240)
        brief = [F(250, 0, 300), F(260, 0, 400), F(270, 0, 300)]
        stop_b = dwell(280, 240, east=10.0)  # 10 m is the same place; 60 m (see below) is another one
        j = run(stop_a + brief + stop_b)
        self.assertEqual(kinds(j), ["stop"])

    def test_two_stops_60_metres_apart_with_a_brief_excursion_stay_two(self):
        stop_a = dwell(0, 240)
        brief = [F(250, 0, 300), F(260, 0, 400), F(270, 0, 300)]
        stop_b = dwell(280, 240, east=60.0)
        j = run(stop_a + brief + stop_b)
        self.assertEqual(kinds(j).count("stop"), 2)


class JitterTests(SimpleTestCase):
    def test_jitter_inside_the_accuracy_radius_does_not_break_a_stop(self):
        j = run(dwell(0, 900, jitter=15.0, acc=20.0))
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.summary["stop_count"], 1)

    def test_a_poor_accuracy_widens_the_radius_so_wide_scatter_is_still_one_stop(self):
        j = run(dwell(0, 900, jitter=100.0, acc=60.0))
        self.assertEqual(kinds(j), ["stop"])

    def test_the_same_scatter_with_good_accuracy_is_not_a_stop(self):
        j = run(dwell(0, 900, jitter=100.0, acc=8.0))
        self.assertNotIn("stop", kinds(j))

    def test_a_stray_fix_inside_a_long_stop_is_tolerated(self):
        fixes = dwell(0, 600)
        fixes[30] = F(300, 120.0, 0.0, 10.0)  # one spike 120 m away
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.segments[0].end - E0, 600)

    def test_two_stray_fixes_in_a_row_are_tolerated_too(self):
        fixes = dwell(0, 600)
        fixes[30] = F(300, 120.0, 0.0, 10.0)
        fixes[31] = F(310, 130.0, 0.0, 10.0)
        self.assertEqual(kinds(run(fixes)), ["stop"])

    def test_the_stop_centre_is_the_median_not_dragged_by_the_stray_fix(self):
        fixes = dwell(0, 600, north=1000.0)
        fixes[30] = F(300, 1120.0, 0.0, 10.0)
        (stop,) = run(fixes).segments
        self.assertAlmostEqual(
            haversine_distance_m(*stop.center, *offset_latlng(LAT0, LNG0, 1000.0, 0.0)), 0, delta=1.0
        )


class DistanceTests(SimpleTestCase):
    def test_distance_matches_the_haversine_of_a_known_path_within_one_percent(self):
        leg_one = drive(0, 34, step_m=150.0, heading="north")  # 33 steps = 4950 m
        leg_two = [F(340 + 10 * k, 4950.0, 150.0 * (k + 1)) for k in range(20)]  # east, 3000 m
        j = run(leg_one + leg_two)
        expected = 4950.0 + 3000.0
        self.assertAlmostEqual(j.summary["distance_m"], expected, delta=expected * 0.01)
        self.assertEqual(kinds(j), ["travel"])

    def test_the_summary_distance_equals_the_sum_of_consecutive_haversines(self):
        fixes = drive(0, 40, step_m=130.0)
        exact = sum(haversine_distance_m(a.lat, a.lng, b.lat, b.lng) for a, b in zip(fixes, fixes[1:]))
        self.assertAlmostEqual(run(fixes).summary["distance_m"], exact, places=3)

    def test_standing_still_adds_no_distance_even_with_jitter(self):
        j = run(drive(0, 20) + dwell(200, 900, north=2850.0, jitter=12.0, acc=15.0))
        self.assertLess(j.summary["distance_m"], 2850.0 + 1.0)
        self.assertEqual(kinds(j), ["travel", "stop"])

    def test_speeds_are_reported_in_kmh(self):
        j = run(drive(0, 30, step_m=150.0))  # 15 m/s = 54 km/h
        (travel,) = j.segments
        self.assertAlmostEqual(travel.avg_speed_kmh, 54.0, delta=0.5)
        self.assertAlmostEqual(travel.max_speed_kmh, 54.0, delta=0.5)
        self.assertAlmostEqual(j.summary["max_speed_kmh"], 54.0, delta=0.5)


class GapTests(SimpleTestCase):
    def hole(self, events, *, hole_s=1200, jump_m=6000.0):
        """5 minutes of driving, a hole of `hole_s` seconds, then driving again from `jump_m` further north."""
        before = drive(0, 31)  # t 0..300
        after = drive(300 + hole_s, 31, north0=4500.0 + jump_m)
        j = run(before + after, events)
        return [s for s in j.segments if s.kind == "gap"], j

    def test_every_cause_is_recognised(self):
        g0, g1 = 300, 1500
        cases = [
            ("gps_off", [Ev("GPS_OFF", E0 + g0 + 30, E0 + g1 - 30)]),
            ("network_lost", [Ev("NETWORK_LOST", E0 + g0, E0 + g1)]),
            ("network_lost", [Ev("AIRPLANE_ON", E0 + g0 - 100, E0 + g1 + 100)]),
            ("app_killed", [Ev("APP_KILLED", E0 + g0 + 60)]),
            ("app_killed", [Ev("APP_RESTARTED", E0 + g1 + 20)]),
            ("device_shutdown", [Ev("DEVICE_SHUTDOWN", E0 + g0 + 10)]),
            ("device_shutdown", [Ev("DEVICE_BOOT", E0 + g1 - 5)]),
            ("permission", [Ev("PERMISSION_CHANGED", E0 + g0 + 20)]),
            ("power_save", [Ev("POWER_SAVE_ON", E0 + g0 - 50, E0 + g1)]),
            ("power_save", [Ev("BACKGROUND_RESTRICTED", E0 + g0 + 15)]),
            ("signal_lost", [Ev("SIGNAL_LOST", E0 + g0, E0 + g1)]),
            ("unknown", []),
            ("unknown", [Ev("LOW_BATTERY", E0 + g0 + 100)]),
        ]
        for cause, events in cases:
            gaps, _ = self.hole(events)
            self.assertEqual(len(gaps), 1, cause)
            self.assertEqual(gaps[0].cause, cause, events)
            self.assertEqual((gaps[0].start - E0, gaps[0].end - E0), (g0, g1))
            self.assertFalse(gaps[0].estimated)

    def test_an_event_that_does_not_reach_the_gap_does_not_explain_it(self):
        gaps, _ = self.hole([Ev("GPS_OFF", E0 - 500, E0 - 100), Ev("APP_KILLED", E0 + 5000)])
        self.assertEqual(gaps[0].cause, "unknown")

    def test_an_open_interval_event_explains_a_gap_it_started_in(self):
        gaps, _ = self.hole([Ev("GPS_OFF", E0 + 400, None)])
        self.assertEqual(gaps[0].cause, "gps_off")

    def test_with_several_events_the_stronger_cause_wins(self):
        gaps, _ = self.hole(
            [
                Ev("NETWORK_LOST", E0 + 300, E0 + 1500),
                Ev("GPS_OFF", E0 + 400, E0 + 1000),
                Ev("DEVICE_SHUTDOWN", E0 + 350),
            ]
        )
        self.assertEqual(gaps[0].cause, "device_shutdown")
        gaps, _ = self.hole([Ev("NETWORK_LOST", E0 + 300, E0 + 1500), Ev("GPS_OFF", E0 + 400, E0 + 1000)])
        self.assertEqual(gaps[0].cause, "gps_off")

    def test_the_gap_remembers_the_event_that_explains_it(self):
        gaps, _ = self.hole([Ev("GPS_OFF", E0 + 400, E0 + 1000, id=77)])
        self.assertEqual(gaps[0].event_id, 77)

    def test_the_gap_threshold_is_strict(self):
        at = run(drive(0, 11) + drive(100 + 300, 11, north0=1500.0 + 4000.0))  # exactly 300 s with no fix
        over = run(drive(0, 11) + drive(100 + 301, 11, north0=1500.0 + 4000.0))
        self.assertNotIn("gap", kinds(at))
        self.assertEqual(kinds(over).count("gap"), 1)

    def test_a_gap_is_not_distance_travelled(self):
        gaps, j = self.hole([])
        self.assertAlmostEqual(j.summary["distance_m"], 4500.0 + 4500.0, delta=90.0)  # two drives of 4500 m
        self.assertGreater(gaps[0].meta["straightLineM"], 5000.0)
        self.assertGreater(j.summary["flags"]["gapStraightLineM"], 5000.0)

    def test_a_gap_whose_two_ends_are_within_75_metres_is_part_of_a_stop(self):
        before = dwell(0, 120, north=100.0)
        after = dwell(1500, 120, north=100.0 + 70.0)  # 70 m away: beyond R (50 m) but within 75 m
        j = run(before + after)
        self.assertEqual(kinds(j), ["stop"])
        (stop,) = j.segments
        self.assertEqual((stop.start - E0, stop.end - E0), (0, 1620))
        self.assertTrue(stop.estimated)
        self.assertEqual(stop.meta["gapInsideS"], 1380)

    def test_a_gap_whose_ends_are_80_metres_apart_stays_a_gap(self):
        before = dwell(0, 120, north=100.0)
        after = dwell(1500, 120, north=100.0 + 90.0)
        j = run(before + after)
        self.assertIn("gap", kinds(j))

    def test_a_gap_inside_a_stop_does_not_split_it(self):
        j = run(dwell(0, 300) + dwell(3000, 300))
        self.assertEqual(kinds(j), ["stop"])
        (stop,) = j.segments
        self.assertEqual(stop.duration_s, 3300)
        self.assertTrue(stop.estimated)
        self.assertEqual(stop.meta["gapInsideS"], 2700)

    def test_a_stop_before_a_real_gap_and_another_after_it(self):
        j = run(dwell(0, 300, north=0.0) + dwell(2000, 300, north=3000.0))
        self.assertEqual(kinds(j), ["stop", "gap", "stop"])
        self.assertEqual(j.summary["gap_s"], 1700)


class TotalsTests(SimpleTestCase):
    def composite(self):
        parts = (
            drive(0, 30)  # 0..290
            + dwell(300, 600, north=4350.0)  # a stop 300..900
            + drive(910, 25, north0=4350.0)  # 910..1150
            + drive(2150, 25, north0=9000.0)  # a gap 1150..2150 (a km of road nobody recorded)
            + dwell(2400, 900, north=12600.0)  # a stop from the drive's last fix (2390) to 3300
        )
        return parts

    def assert_partition(self, j):
        segs = j.segments
        self.assertTrue(segs)
        for before, after in zip(segs, segs[1:]):
            self.assertEqual(before.end, after.start, "segments must be contiguous")
        span = segs[-1].end - segs[0].start
        s = j.summary
        self.assertEqual(s["travel_s"] + s["stop_s"] + s["gap_s"], span)
        self.assertEqual(s["summary_through"] - s["range_start"], span)
        self.assertEqual(sum(x.duration_s for x in segs), span)

    def test_travel_plus_stop_plus_gap_is_exactly_the_covered_duty_time(self):
        j = run(self.composite())
        self.assertEqual(kinds(j).count("stop"), 2)
        self.assertEqual(kinds(j).count("gap"), 1)
        self.assert_partition(j)

    def test_the_partition_holds_with_leading_and_trailing_gaps_on_a_finished_track(self):
        fixes = self.composite()
        j = run(fixes, started=E0 - 1000, ended=E0 + 5000)
        self.assert_partition(j)
        self.assertEqual(j.segments[0].kind, "gap")
        self.assertEqual(j.segments[0].meta["edge"], "leading")
        self.assertEqual(j.segments[-1].meta["edge"], "trailing")
        self.assertEqual(j.summary["range_start"], E0 - 1000)
        self.assertEqual(j.summary["summary_through"], E0 + 5000)

    def test_an_active_track_gets_no_trailing_gap_however_late_it_is(self):
        j = run(drive(0, 10), started=E0, ended=None)
        self.assertEqual(kinds(j), ["travel"])
        self.assertEqual(j.summary["summary_through"], E0 + 90)

    def test_short_leading_and_trailing_idle_is_not_a_gap_but_is_reported(self):
        j = run(drive(100, 10), started=E0, ended=E0 + 100 + 90 + 200)
        self.assertEqual(kinds(j), ["travel"])
        self.assertEqual(j.summary["flags"]["leadingIdleS"], 100)
        self.assertEqual(j.summary["flags"]["trailingIdleS"], 200)

    def test_the_partition_holds_on_random_tracks(self):
        rng = random.Random(7)
        for _ in range(25):
            fixes, t, north = [], 0, 0.0
            for _ in range(rng.randint(30, 120)):
                t += rng.choice([5, 10, 10, 10, 30, 60, 400, 900])
                north += rng.choice([0.0, 0.0, 5.0, 40.0, 200.0])
                fixes.append(F(t, north, rng.uniform(-10, 10), rng.choice([5, 8, 12, 30])))
            j = run(fixes, started=E0 - 50, ended=E0 + t + 700)
            if j.segments:
                self.assert_partition(j)


class EdgeCaseTests(SimpleTestCase):
    def test_no_points_and_an_active_track_has_nothing_to_show(self):
        j = run([], started=E0)
        self.assertEqual((j.segments, j.path), ([], []))
        self.assertEqual((j.summary["distance_m"], j.summary["stop_count"], j.summary["first_point_at"]), (0, 0, None))
        self.assertTrue(j.summary["flags"]["noData"])

    def test_no_points_on_a_finished_track_is_one_no_data_gap_explained_by_events(self):
        j = run([], [Ev("GPS_OFF", E0 + 100, None, id=5)], started=E0, ended=E0 + 3000)
        (gap,) = j.segments
        self.assertEqual((gap.kind, gap.cause, gap.duration_s, gap.estimated), ("gap", "gps_off", 3000, True))
        self.assertEqual(gap.meta["edge"], "no_data")
        self.assertEqual(j.summary["gap_s"], 3000)

    def test_a_short_finished_track_with_no_points_has_no_segments(self):
        self.assertEqual(run([], started=E0, ended=E0 + 200).segments, [])

    def test_a_track_with_only_events_summarises_to_zero(self):
        j = run([], [Ev("TRACKING_STARTED", E0), Ev("APP_KILLED", E0 + 50)], started=E0, ended=E0 + 100)
        self.assertEqual((j.segments, j.summary["stop_count"], j.summary["distance_m"]), ([], 0, 0))

    def test_one_point_makes_no_travel_and_no_stop(self):
        j = run([F(0)])
        self.assertEqual(j.segments, [])
        self.assertEqual(j.summary["first_point_at"], E0)
        self.assertEqual(len(j.path), 1)

    def test_one_point_on_a_finished_track_has_leading_and_trailing_gaps(self):
        j = run([F(1000)], started=E0, ended=E0 + 3000)
        self.assertEqual(kinds(j), ["gap", "gap"])
        self.assertEqual(j.summary["gap_s"], 3000)

    def test_two_identical_points_are_one(self):
        j = run([F(0), F(0)])
        self.assertEqual(j.summary["flags"]["droppedDuplicate"], 1)
        self.assertEqual(j.summary["flags"]["usedPoints"], 1)

    def test_all_points_inaccurate_leaves_nothing_but_says_why(self):
        j = run([F(10 * k, k * 20.0, acc=250.0) for k in range(30)])
        self.assertEqual(j.segments, [])
        self.assertTrue(j.summary["flags"]["allInaccurate"])
        self.assertEqual(j.summary["flags"]["droppedAccuracy"], 30)

    def test_inaccurate_fixes_are_dropped_from_the_distance(self):
        fixes = drive(0, 30)
        fixes[10] = F(100, 9000.0, 0.0, acc=500.0)  # a wild fix, far off, with poor accuracy
        j = run(fixes)
        self.assertAlmostEqual(j.summary["distance_m"], 29 * 150.0, delta=1.0)
        self.assertEqual(j.summary["flags"]["droppedAccuracy"], 1)

    def test_a_teleport_is_rejected_and_does_not_inflate_the_distance(self):
        fixes = drive(0, 30)
        fixes[15] = F(150, 50_000.0, 0.0, acc=10.0)  # 50 km away 10 s later with good accuracy
        j = run(fixes)
        self.assertEqual(j.summary["flags"]["droppedTeleport"], 1)
        self.assertAlmostEqual(j.summary["distance_m"], 29 * 150.0, delta=1.0)

    def test_a_bad_first_fix_does_not_swallow_the_whole_journey(self):
        fixes = [F(0, 80_000.0, 0.0, acc=10.0)] + drive(10, 40)
        j = run(fixes)
        self.assertEqual(j.summary["flags"]["usedPoints"], 40)
        self.assertEqual(j.summary["flags"]["droppedTeleport"], 1)
        self.assertAlmostEqual(j.summary["distance_m"], 39 * 150.0, delta=1.0)

    def test_a_relocation_after_a_long_clean_run_is_kept_but_not_counted_as_travel(self):
        before = drive(0, 40)
        after = [F(400 + 10 * k, 200_000.0 + k * 150.0, 0.0) for k in range(10)]
        j = run(before + after)
        self.assertEqual(j.summary["flags"]["jumps"], 1)
        self.assertIn("gap", kinds(j))
        self.assertAlmostEqual(j.summary["distance_m"], 39 * 150.0 + 9 * 150.0, delta=2.0)

    def test_mock_points_are_kept_and_flagged(self):
        fixes = drive(0, 20)
        fixes[5] = Fix(fixes[5].t, fixes[5].lat, fixes[5].lng, 8.0, mock=True, seq=fixes[5].seq)
        fixes[6] = Fix(fixes[6].t, fixes[6].lat, fixes[6].lng, 8.0, mock=True, seq=fixes[6].seq)
        j = run(fixes)
        self.assertEqual(j.summary["flags"]["mockPoints"], 2)
        self.assertEqual(j.summary["flags"]["usedPoints"], 20)
        self.assertEqual(j.segments[0].meta["mockPoints"], 2)

    def test_out_of_order_and_late_points_give_the_same_journey(self):
        fixes = drive(0, 30) + dwell(300, 400, north=4350.0) + drive(710, 20, north0=4350.0)
        straight = run(fixes)
        shuffled = list(fixes)
        random.Random(3).shuffle(shuffled)
        again = run(shuffled)
        self.assertEqual(straight.segments, again.segments)
        self.assertEqual(straight.summary, again.summary)

    def test_the_pipeline_is_deterministic_and_idempotent(self):
        fixes = drive(0, 30) + dwell(300, 400, north=4350.0)
        self.assertEqual(run(fixes), run(fixes))

    def test_a_long_stop_at_the_very_start_and_at_the_very_end(self):
        fixes = dwell(0, 1800) + drive(1810, 20) + dwell(2010, 1800, north=2850.0)
        j = run(fixes, started=E0, ended=E0 + 3810)
        self.assertEqual(kinds(j), ["stop", "travel", "stop"])
        self.assertEqual(j.segments[0].start, E0)
        self.assertEqual(j.segments[-1].end, E0 + 3810)

    def test_a_still_activity_run_with_sparse_fixes_is_a_stop(self):
        # one fix every 10 minutes (more than the 5 minute gap), the phone says 'still', fixes drift 60 m around
        fixes = [F(600 * k, 60.0 * (k % 2), 0.0, acc=40.0, activity="still") for k in range(6)]
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        self.assertTrue(j.segments[0].estimated)

    def test_crossing_midnight_india_time_is_one_continuous_journey(self):
        # 18:20 UTC is 23:50 IST: the pipeline works in instants, a calendar date never splits anything
        t0 = int(T0.replace(hour=18, minute=20).timestamp()) - E0
        fixes = drive(t0, 40)
        j = run(fixes)
        self.assertEqual(kinds(j), ["travel"])
        self.assertEqual(j.segments[0].duration_s, 390)


class SimplifyTests(SimpleTestCase):
    def test_a_straight_line_collapses_to_its_two_ends(self):
        pts = [offset_latlng(LAT0, LNG0, k * 10.0, 0.0) for k in range(500)]
        self.assertEqual(journey.simplify_indices(pts, 400), [0, 499])

    def test_a_long_curve_is_capped_and_keeps_both_ends(self):
        pts = [
            offset_latlng(LAT0, LNG0, 500 * math.sin(k / 30.0) + k * 3, 500 * math.cos(k / 30.0)) for k in range(5000)
        ]
        keep = journey.simplify_indices(pts, 400)
        self.assertLessEqual(len(keep), 400)
        self.assertEqual((keep[0], keep[-1]), (0, 4999))
        self.assertEqual(keep, sorted(keep))

    def test_a_travel_polyline_never_has_more_than_400_vertices_and_the_path_never_more_than_1500(self):
        fixes = [F(10 * k, 800 * math.sin(k / 25.0), 800 * math.cos(k / 25.0) + k * 2.0) for k in range(6000)]
        j = run(fixes)
        for seg in j.segments:
            if seg.kind == "travel":
                self.assertLessEqual(len(seg.polyline), journey.MAX_POLYLINE_VERTICES)
        self.assertLessEqual(len(j.path), journey.MAX_PATH_POINTS)
        self.assertEqual(j.path[0][2], (E0) * 1000)  # epoch milliseconds
        self.assertEqual(j.path[-1][2], (E0 + 59990) * 1000)

    def test_simplification_keeps_the_shape_within_a_few_metres(self):
        fixes = drive(0, 40) + [F(400 + 10 * k, 5850.0, 150.0 * (k + 1)) for k in range(40)]
        (travel,) = run(fixes).segments
        self.assertLess(len(travel.polyline), 8)  # an L is three vertices
        corner = min(
            travel.polyline, key=lambda p: haversine_distance_m(p[0], p[1], *offset_latlng(LAT0, LNG0, 5850.0, 0.0))
        )
        self.assertLess(haversine_distance_m(corner[0], corner[1], *offset_latlng(LAT0, LNG0, 5850.0, 0.0)), 5.0)


class RebuildTests(GeoBase):
    """rebuild(track) reads the raw rows, runs the pipeline and replaces the derived rows in one transaction."""

    def add_points(self, track, fixes, device="d1"):
        DutyTrackPoint.objects.bulk_create(
            [
                DutyTrackPoint(
                    track=track,
                    employee=track.employee,
                    device_id=device,
                    seq=i + 1,
                    recorded_at=T0 + timedelta(seconds=f.t - E0),
                    latitude=round(f.lat, 6),
                    longitude=round(f.lng, 6),
                    accuracy_m=f.acc or 0,
                    activity=f.activity,
                    is_mock=f.mock,
                )
                for i, f in enumerate(fixes)
            ]
        )
        DutyTrack.objects.filter(pk=track.pk).update(points_count=len(fixes))

    def sample(self):
        return drive(0, 30) + dwell(300, 600, north=4350.0) + drive(910, 25, north0=4350.0)

    def test_rebuild_writes_segments_and_the_summary(self):
        track = self.make_track(self.asha)
        self.add_points(track, self.sample())
        result = journey.rebuild(track)
        track.refresh_from_db()
        segs = list(DutyTrackSegment.objects.filter(track=track).order_by("seq_no"))
        self.assertEqual([s.kind for s in segs], ["travel", "stop", "travel"])
        self.assertEqual([s.seq_no for s in segs], [1, 2, 3])
        self.assertEqual(track.stop_count, 1)
        self.assertEqual(track.longest_stop_s, 620)  # the dwell, plus the drive's neighbouring fixes at the same place
        self.assertEqual(track.stop_s, 620)
        self.assertAlmostEqual(track.distance_m, 29 * 150.0 + 24 * 150.0, delta=5.0)
        self.assertEqual(track.first_point_at, T0)
        self.assertEqual(track.summary_through, T0 + timedelta(seconds=1150))
        self.assertIsNotNone(track.rebuilt_at)
        self.assertEqual(result["segments"], 3)
        self.assertEqual(track.points_count, len(self.sample()))  # the counters are not the pipeline's

    def test_rebuild_is_idempotent(self):
        track = self.make_track(self.asha)
        self.add_points(track, self.sample())
        journey.rebuild(track)

        def snapshot():
            rows = list(
                DutyTrackSegment.objects.filter(track=track)
                .order_by("seq_no")
                .values(
                    "seq_no",
                    "kind",
                    "started_at",
                    "ended_at",
                    "duration_s",
                    "distance_m",
                    "center_lat",
                    "polyline",
                    "cause",
                )
            )
            t = DutyTrack.objects.values(
                "distance_m", "travel_s", "stop_s", "gap_s", "stop_count", "longest_stop_s", "flags"
            ).get(pk=track.pk)
            return rows, t

        first = snapshot()
        first_ids = list(DutyTrackSegment.objects.filter(track=track).values_list("id", flat=True))
        journey.rebuild(track)
        journey.rebuild(track.pk)
        self.assertEqual(snapshot(), first)
        self.assertEqual(DutyTrackSegment.objects.filter(track=track).count(), 3)
        self.assertNotEqual(list(DutyTrackSegment.objects.filter(track=track).values_list("id", flat=True)), first_ids)

    def test_late_points_change_the_rebuilt_result(self):
        track = self.make_track(self.asha)
        sample = self.sample()
        self.add_points(track, sample[:40])
        journey.rebuild(track)
        before = DutyTrack.objects.get(pk=track.pk).distance_m
        DutyTrackPoint.objects.bulk_create(
            [
                DutyTrackPoint(
                    track=track,
                    employee=self.asha,
                    device_id="d1",
                    seq=1000 + i,
                    recorded_at=T0 + timedelta(seconds=f.t - E0),
                    latitude=round(f.lat, 6),
                    longitude=round(f.lng, 6),
                    accuracy_m=8,
                )
                for i, f in enumerate(sample[40:])
            ]
        )
        journey.rebuild(track)
        self.assertGreater(DutyTrack.objects.get(pk=track.pk).distance_m, before)

    def test_events_explain_the_gap_and_the_segment_links_to_the_event(self):
        track = self.make_track(self.asha, ended_at=T0 + timedelta(seconds=2000))
        fixes = drive(0, 31) + drive(1500, 31, north0=10500.0)
        self.add_points(track, fixes)
        gps_off = DutyTrackEvent.objects.create(
            track=track,
            employee=self.asha,
            kind="GPS_OFF",
            started_at=T0 + timedelta(seconds=320),
            ended_at=T0 + timedelta(seconds=1400),
        )
        journey.rebuild(track)
        gap = DutyTrackSegment.objects.get(track=track, kind="gap")
        self.assertEqual((gap.cause, gap.event_id), ("gps_off", gps_off.pk))

    def test_an_address_found_earlier_survives_a_rebuild(self):
        track = self.make_track(self.asha)
        self.add_points(track, self.sample())
        journey.rebuild(track)
        DutyTrackSegment.objects.filter(track=track, kind="stop").update(address="Gandhipuram, Coimbatore")
        journey.rebuild(track)
        self.assertEqual(DutyTrackSegment.objects.get(track=track, kind="stop").address, "Gandhipuram, Coimbatore")

    def test_a_track_with_no_points_rebuilds_to_nothing(self):
        track = self.make_track(self.asha)
        journey.rebuild(track)
        track.refresh_from_db()
        self.assertEqual(DutyTrackSegment.objects.filter(track=track).count(), 0)
        self.assertEqual((track.distance_m, track.stop_count, track.first_point_at), (0, 0, None))
        self.assertTrue(track.flags["noData"])

    def test_a_purged_track_is_never_rebuilt_over_its_kept_segments(self):
        track = self.make_track(self.asha)
        self.add_points(track, self.sample())
        journey.rebuild(track)
        DutyTrackPoint.objects.filter(track=track).delete()
        DutyTrack.objects.filter(pk=track.pk).update(flags={"purgedAt": "2027-10-28T00:00:00+00:00"})
        result = journey.rebuild(track)
        self.assertEqual(result, {"skipped": "purged"})
        self.assertEqual(DutyTrackSegment.objects.filter(track=track).count(), 3)
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).stop_count, 1)

    def test_rebuild_uses_the_settings_thresholds(self):
        track = self.make_track(self.asha)
        self.add_points(track, drive(0, 20) + dwell(200, 300, north=2850.0))
        journey.rebuild(track)
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).stop_count, 1)
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"stop_seconds": 900})
        journey.rebuild(track)
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).stop_count, 0)

    def test_the_journey_of_a_finished_track_covers_up_to_its_end(self):
        track = self.make_track(self.asha, ended_at=T0 + timedelta(seconds=5000))
        self.add_points(track, drive(0, 20))
        journey.rebuild(track)
        track.refresh_from_db()
        self.assertEqual(track.summary_through, T0 + timedelta(seconds=5000))  # a trailing gap reaches the end
        self.assertEqual(track.gap_s, 5000 - 190)
