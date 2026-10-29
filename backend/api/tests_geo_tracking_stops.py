"""Geo-Tracking: stationary-period (stop) detection on synthetic tracks, one scenario per way a real phone behaves, and a
replay of a real recorded track.

Every scenario builds its fixes by hand (arrive by a ride at 12 m/s with a fix every 3 s, stand still with a fix every
minute, leave by a ride) and calls journey.compute_journey with the default Params, so the expected answer can be read off
the construction. What they pin:
  - the 3-minute rule is about TIME at one place (not about a distance): a pause just under it is travel, a pause at it or
    over it is one stop, however few fixes the phone stored in it;
  - GPS jitter and one poor-accuracy fix neither break nor shorten a stop, indoor drift of 60-120 m at poor accuracy is
    one stop;
  - the stop starts at the first fix of the phone being at the place and ends at the last one: the ride in and the ride
    out are travel, not part of the stop (the "stable core");
  - SEQUENTIAL places are separate stops: a first break, a walk of a few dozen metres and a second break are two stops
    (judged by the fixes: tight blocks, clearly apart), while a phone that flip-flops between two positions or a person
    drifting indoors is one;
  - nothing is lost: every cleaned fix lies in exactly one travel / stop / gap time range, the ranges are contiguous.

Run:  python manage.py test api.tests_geo_tracking_stops --noinput
"""

import math
import random
from datetime import datetime
from datetime import timezone as dt_timezone

from django.test import SimpleTestCase

from .geo_tracking import journey
from .geo_tracking.journey import Fix, Params
from .geo_utils import haversine_distance_m
from .tests_geo_tracking_support import LAT0, LNG0, offset_latlng

E0 = 1_760_000_000
P = Params()


def fix(t, north=0.0, east=0.0, acc=10.0, activity="unknown") -> Fix:
    """A fix t seconds after E0, `north` / `east` metres from the origin."""
    lat, lng = offset_latlng(LAT0, LNG0, north, east)
    return Fix(t=E0 + t, lat=lat, lng=lng, acc=acc, activity=activity, seq=E0 + t)


def ride(t0, n, *, north0=0.0, east0=0.0, step_m=36.0, step_s=3, acc=8.0, activity="vehicle"):
    """n fixes every step_s seconds, step_m metres apart, heading north from (north0, east0): 12 m/s with the defaults."""
    return [fix(t0 + k * step_s, north0 + k * step_m, east0, acc, activity) for k in range(n)]


def arrive(t, north=0.0, east=0.0, n=21):
    """A ride whose LAST fix is at (north, east) at time t (the phone arrives there at t)."""
    return ride(t - (n - 1) * 3, n, north0=north - (n - 1) * 36.0, east0=east)


def leave(t, north=0.0, east=0.0, n=20):
    """A ride whose first fix is 36 m north of (north, east) at time t (the phone has just left the place)."""
    return ride(t, n, north0=north + 36.0, east0=east)


def stand(t0, seconds, *, every=60, north=0.0, east=0.0, acc=10.0, activity="still", jitter=0.0):
    """Fixes every `every` seconds from t0 to t0 + seconds at (north, east); jitter walks the four compass points."""
    pattern = [(jitter, 0.0), (0.0, jitter), (-jitter, 0.0), (0.0, -jitter)]
    out = []
    for k in range(seconds // every + 1):
        dn, de = pattern[k % 4]
        out.append(fix(t0 + k * every, north + dn, east + de, acc, activity))
    return out


def run(fixes, events=(), *, started=None, ended=None, p=P) -> journey.Journey:
    return journey.compute_journey(list(fixes), list(events), p, started_at=started, ended_at=ended)


def kinds(j):
    return [s.kind for s in j.segments]


def stops(j):
    return [s for s in j.segments if s.kind == "stop"]


def dist_to(center, north=0.0, east=0.0) -> float:
    return haversine_distance_m(center[0], center[1], *offset_latlng(LAT0, LNG0, north, east))


class JourneyAssertions(SimpleTestCase):
    """The invariants every journey keeps, whatever the scenario."""

    def assert_nothing_lost(self, j):
        segs = j.segments
        if not segs:
            return
        for before, after in zip(segs, segs[1:]):
            self.assertEqual(before.end, after.start, "segments must be contiguous")
        span = segs[-1].end - segs[0].start
        s = j.summary
        self.assertEqual(s["travel_s"] + s["stop_s"] + s["gap_s"], span)
        last = segs[-1].end
        for f in j.fixes:
            if f.t < segs[0].start or f.t > last:
                continue  # a fix before the leading gap / after the end cannot exist; guards the test, not the code
            owners = [x for x in segs if x.start <= f.t < x.end or (f.t == last and x.end == last)]
            self.assertEqual(len(owners), 1, f"fix at +{f.t - E0}s belongs to {len(owners)} ranges")
        if j.fixes:
            self.assertGreaterEqual(j.fixes[0].t, segs[0].start)
            self.assertLessEqual(j.fixes[-1].t, last)


class StationaryPeriodScenarios(JourneyAssertions):
    def test_s1_arrive_and_stand_four_minutes_with_a_fix_every_minute_is_one_stop(self):
        fixes = arrive(60) + stand(120, 180, every=60) + leave(303)
        j = run(fixes)
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertEqual((stop.start - E0, stop.end - E0, stop.duration_s), (60, 300, 240))
        self.assertEqual(stop.point_count, 5)  # the arrival fix and the four stand fixes
        self.assertLess(dist_to(stop.center), 2.0)
        self.assertFalse(stop.estimated)
        self.assert_nothing_lost(j)

    def test_s2_three_and_a_half_minutes_with_jitter_and_one_poor_outlier_is_one_stop(self):
        stand_fixes = stand(70, 200, every=10, jitter=25.0, acc=12.0)
        outlier = [k for k, f in enumerate(stand_fixes) if f.t == E0 + 150][0]
        stand_fixes[outlier] = fix(150, north=90.0, acc=80.0, activity="still")  # 90 m away, accuracy 80
        j = run(arrive(60) + stand_fixes + leave(273))
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertEqual((stop.start - E0, stop.end - E0, stop.duration_s), (60, 270, 210))
        self.assertEqual(stop.point_count, 22)  # the poor fix did not break it and is inside it
        # "radius" is how far the phone's positions strayed from the pin (the outlier), NOT a detection threshold
        self.assertGreater(stop.radius_m, 60.0)
        self.assertEqual(stop.meta["detectionRadiusM"], 50.0)
        self.assert_nothing_lost(j)

    def test_s3_five_minutes_with_only_two_fixes_is_one_stop(self):
        fixes = arrive(60) + [fix(340, east=40.0, activity="still")] + leave(343, east=40.0)
        j = run(fixes)
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertEqual((stop.start - E0, stop.end - E0, stop.duration_s, stop.point_count), (60, 340, 280, 2))
        self.assertFalse(stop.estimated)  # 280 s between the two fixes is not a hole in the data (gap = 300 s)
        self.assert_nothing_lost(j)

    def test_s3b_a_phone_that_leaves_right_after_its_last_fix_is_not_credited_with_idle_time(self):
        fixes = arrive(60) + [fix(340, east=40.0, activity="still")] + [fix(400, north=600.0, east=40.0)]
        j = run(fixes)
        (stop,) = stops(j)
        self.assertEqual(stop.end - E0, 340)  # not 400: the fix at 400 is 600 m away, the minute in between is travel
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        self.assertEqual((j.segments[2].start - E0, j.segments[2].end - E0), (340, 400))

    def test_s4_two_minutes_fifty_seconds_still_is_not_a_stop(self):
        j = run(arrive(60) + stand(70, 160, every=10) + leave(233))
        self.assertEqual(kinds(j), ["travel"])
        self.assertEqual(j.summary["stop_count"], 0)
        self.assert_nothing_lost(j)

    def test_s4b_the_threshold_itself_counts_and_one_second_less_does_not(self):
        at = run(arrive(60) + stand(120, 120, every=60) + leave(183 + 60))
        self.assertEqual((stops(at)[0].start - E0, stops(at)[0].end - E0), (60, 240))  # 180 s: a stop
        under = run(arrive(60) + stand(120, 119, every=119) + leave(183 + 59))
        self.assertEqual(stops(under), [])  # 179 s: not

    def test_s5_ten_minutes_indoors_with_drift_and_poor_accuracy_is_one_stop(self):
        indoor = []
        for k in range(1, 21):  # a fix every 30 s for 10 minutes, 60-120 m from the real spot, accuracy 40-80 m
            angle = math.radians(k * 137.5)
            d = 60.0 + (k * 37) % 61
            indoor.append(
                fix(60 + 30 * k, d * math.cos(angle), d * math.sin(angle), acc=40.0 + (k * 13) % 41, activity="still")
            )
        j = run(arrive(60) + indoor + leave(663))
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertGreater(stop.meta["detectionRadiusM"], 100.0)  # the radius widens with the poor accuracy
        # with R that wide a ride fix 36-72 m from the place cannot be told from drift: the stop may take one or two of
        # them (a few seconds), never lose a minute of the ten
        self.assertTrue(48 <= stop.start - E0 <= 60 and 660 <= stop.end - E0 <= 666, (stop.start - E0, stop.end - E0))
        self.assertGreaterEqual(stop.point_count, 21)
        self.assert_nothing_lost(j)

    def test_s6_a_ride_a_six_minute_stand_and_a_ride_the_stop_starts_at_the_first_stable_fix(self):
        j = run(arrive(60) + stand(120, 300, every=60) + leave(423))
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        before, stop, after = j.segments
        self.assertEqual((stop.start - E0, stop.end - E0, stop.duration_s), (60, 420, 360))
        # the ride is travel, all of it, up to the first fix at the place; the next ride starts at the last fix there
        self.assertEqual((before.start - E0, before.end - E0), (0, 60))
        self.assertEqual(after.start, stop.end)
        self.assertLess(dist_to(before.end_ll), 1.0)
        # no moving fix hides inside the stop
        inside = [f for f in j.fixes if stop.start < f.t <= stop.end]
        self.assertTrue(inside)
        self.assertTrue(all(f.activity == "still" for f in inside))
        # the radius is the real spread (nil: the phone did not move), the detection radius is the rule's R
        self.assertLess(stop.radius_m, 1.0)
        self.assertEqual(stop.meta["detectionRadiusM"], 50.0)
        self.assertEqual(stop.meta["coreRadiusM"], 50.0)
        self.assertEqual(stop.meta["fixCount"], 7)
        self.assertEqual(stop.meta["centreAccuracyM"], 10.0)
        self.assert_nothing_lost(j)

    def test_s6b_the_ride_is_trimmed_even_when_the_phone_never_says_vehicle(self):
        fixes = arrive(60) + stand(120, 300, every=60) + leave(423)
        fixes = [Fix(f.t, f.lat, f.lng, f.acc, activity="unknown", seq=f.seq) for f in fixes]
        (stop,) = stops(run(fixes))
        self.assertEqual((stop.start - E0, stop.end - E0), (60, 420))  # 36 m in 3 s is movement on its own

    def test_s6c_without_the_trimming_the_ride_would_have_made_the_pause_look_longer(self):
        # a 2:50 pause (60..230) and a first ride fix 10 s later, 36 m away, inside the detection radius: it used to
        # stretch the "stop" to 3:00 exactly. It is movement, so the pause stays a pause.
        j = run(arrive(60) + stand(70, 160, every=10) + leave(240))
        self.assertEqual(stops(j), [])
        self.assertEqual(kinds(j), ["travel"])
        self.assert_nothing_lost(j)

    def test_s7_slow_traffic_that_keeps_moving_is_travel_not_a_stop(self):
        for step_s, step_m, n in ((10, 20.0, 19), (3, 6.0, 61), (30, 60.0, 7)):  # 2 m/s for 180 s at three cadences
            with self.subTest(every=step_s):
                j = run(ride(0, n, step_m=step_m, step_s=step_s, activity="unknown"))
                self.assertEqual(kinds(j), ["travel"])
                self.assertEqual(j.summary["stop_count"], 0)
                self.assertAlmostEqual(j.summary["distance_m"], 360.0, delta=3.0)

    def test_s8_walking_around_a_compound_within_70_metres_for_twenty_minutes_is_one_stop(self):
        fixes = []
        for k in range(121):  # a fix every 10 s for 20 minutes, round a 35 m radius loop at a walking pace
            angle = 2 * math.pi * k * 10 * 1.2 / (2 * math.pi * 35.0)
            fixes.append(fix(10 * k, 35.0 * math.cos(angle), 35.0 * math.sin(angle), acc=10.0, activity="walking"))
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        (stop,) = j.segments
        self.assertEqual((stop.start - E0, stop.end - E0, stop.point_count), (0, 1200, 121))
        self.assertLess(stop.radius_m, 40.0)
        self.assertEqual(j.summary["distance_m"], 0.0)  # walking round a compound is not distance travelled
        self.assert_nothing_lost(j)

    def test_s9_a_stop_with_ten_minutes_of_no_signal_in_the_middle_is_one_estimated_stop(self):
        fixes = arrive(60) + stand(90, 150, every=30) + stand(840, 180, every=30) + leave(1023)
        j = run(fixes)
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertEqual((stop.start - E0, stop.end - E0, stop.duration_s), (60, 1020, 960))
        self.assertTrue(stop.estimated)
        self.assertEqual(stop.meta["gapInsideS"], 600)
        self.assertEqual(j.summary["gap_s"], 0)
        self.assertEqual(j.summary["flags"]["estimatedStops"], 1)
        self.assert_nothing_lost(j)


class SparseDataTests(JourneyAssertions):
    """Two stored fixes are enough: the phone reports once a minute (or once in five) while still."""

    def test_two_fixes_at_the_threshold_apart_and_close_together_are_a_stop(self):
        j = run([fix(0, activity="unknown"), fix(180, north=30.0)])
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.segments[0].duration_s, 180)

    def test_two_fixes_just_under_the_threshold_are_not(self):
        self.assertEqual(stops(run([fix(0), fix(179, north=30.0)])), [])

    def test_the_two_fixes_must_be_within_reach_of_each_other(self):
        self.assertEqual(stops(run([fix(0, acc=10.0), fix(200, north=180.0, acc=10.0)])), [])

    def test_a_poor_accuracy_widens_the_reach_of_the_pair(self):
        # 100 m apart: no stop at 10 m accuracy ...
        self.assertEqual(stops(run([fix(0, acc=10.0), fix(200, north=130.0, acc=10.0)])), [])
        # ... but at 60 m accuracy the detection radius is 120 m and the two fixes agree
        (stop,) = stops(run([fix(0, acc=60.0), fix(200, north=100.0, acc=60.0)]))
        self.assertEqual(stop.duration_s, 200)

    def test_a_five_minute_heartbeat_still_gives_a_stop(self):
        fixes = [fix(300 * k, north=(k % 2) * 20.0, acc=15.0, activity="still") for k in range(5)]  # 20 minutes
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.segments[0].duration_s, 1200)
        self.assert_nothing_lost(j)

    def test_a_single_poor_fix_does_not_shorten_a_stop(self):
        # the last fix of the stand is 100 m off but only good to 90 m: it belongs to the stop (accuracy-aware reach)
        fixes = arrive(60) + stand(120, 120, every=60) + [fix(300, north=100.0, acc=90.0, activity="still")]
        (stop,) = stops(run(fixes + leave(303, north=100.0)))
        self.assertEqual((stop.start - E0, stop.end - E0), (60, 300))

    def test_a_run_of_poor_fixes_in_the_middle_does_not_break_a_stop(self):
        # four fixes in a row, 125 m off but only good to 90 m (more than the two strays a stop tolerates, and beyond
        # the leniency of the first fixes of a run): the phone was indoors, the stop is one
        # (activity "unknown" throughout: the phone's own 'still' would rescue the run through another rule)
        poor = [fix(t, north=125.0, acc=90.0) for t in (150, 180, 210, 240)]
        steady = stand(90, 30, every=30, activity="unknown") + stand(270, 120, every=30, activity="unknown")
        j = run(arrive(60) + steady + poor + leave(393))
        self.assertEqual(kinds(j), ["travel", "stop", "travel"])
        (stop,) = stops(j)
        self.assertEqual((stop.start - E0, stop.end - E0), (60, 390))
        self.assert_nothing_lost(j)

    def test_the_same_fix_with_a_good_accuracy_is_a_departure(self):
        fixes = arrive(60) + stand(120, 120, every=60) + [fix(300, north=100.0, acc=8.0)]
        (stop,) = stops(run(fixes))
        self.assertEqual((stop.start - E0, stop.end - E0), (60, 240))


class MetaAndInvariantTests(JourneyAssertions):
    def test_the_stop_meta_carries_the_new_keys(self):
        j = run(arrive(60) + stand(120, 300, every=60, jitter=12.0, acc=14.0) + leave(423))
        (stop,) = stops(j)
        self.assertEqual(set(stop.meta), {"detectionRadiusM", "coreRadiusM", "fixCount", "centreAccuracyM"})
        self.assertEqual(stop.meta["fixCount"], stop.point_count)
        self.assertEqual(stop.meta["coreRadiusM"], stop.meta["detectionRadiusM"])
        self.assertEqual(stop.meta["centreAccuracyM"], 14.0)
        # `radius_m` = spread = the farthest fix from the centre: a 12 m jitter stays within 12-13 m, not within R = 50
        self.assertAlmostEqual(stop.radius_m, 12.0, delta=2.0)

    def test_the_stop_is_idempotent_and_independent_of_the_order_of_the_input(self):
        fixes = arrive(60) + stand(120, 300, every=60) + leave(423)
        shuffled = list(fixes)
        random.Random(11).shuffle(shuffled)
        self.assertEqual(run(fixes).segments, run(shuffled).segments)
        self.assertEqual(run(fixes).summary, run(fixes).summary)

    def test_the_partition_holds_on_random_stand_and_ride_tracks(self):
        rng = random.Random(5)
        for _ in range(40):
            fixes, t, north = [], 0, 0.0
            for _ in range(rng.randint(3, 9)):
                if rng.random() < 0.5:  # a ride of a few seconds-spaced fixes
                    n = rng.randint(3, 25)
                    fixes += ride(t, n, north0=north, step_m=rng.choice([8.0, 36.0]), activity="vehicle")
                    t += 3 * n
                    north += 36.0 * n
                else:  # a stand with a fix every so often and some jitter
                    seconds = rng.choice([60, 150, 200, 400, 900])
                    fixes += stand(
                        t, seconds, every=rng.choice([10, 30, 60]), north=north, jitter=rng.choice([0.0, 10.0, 30.0])
                    )
                    t += seconds + rng.choice([3, 10, 400])
            j = run(fixes, started=E0 - 20, ended=E0 + t + 500)
            self.assert_nothing_lost(j)


# the real recorded dev track 1 (a road trip of 27 fixes, 2026-10-28 UTC): (time, lat, lng, accuracy, the phone's activity)
TRACK1 = [
    ("07:50:44", 11.131284, 77.318855, 14.013999938964844, "still"),
    ("07:57:53", 11.131404, 77.318981, 100.0, "still"),
    ("08:03:59", 11.131287, 77.318852, 100.0, "still"),
    ("08:13:39", 11.132025, 77.326, 15.571000099182129, "still"),
    ("08:18:56", 11.132022, 77.325998, 17.163999557495117, "still"),
    ("08:26:32", 11.132077, 77.325996, 18.2549991607666, "still"),
    ("08:30:14", 11.132109, 77.325351, 56.23400115966797, "still"),
    ("08:35:22", 11.132141, 77.325408, 11.071999549865723, "still"),
    ("08:40:22", 11.132138, 77.32541, 5.701000213623047, "still"),
    ("08:45:23", 11.132119, 77.325465, 14.545000076293945, "still"),
    ("08:50:23", 11.132097, 77.325466, 8.680999755859375, "still"),
    ("08:53:43", 11.131714, 77.324867, 19.238000869750977, "vehicle"),
    ("08:53:54", 11.131352, 77.323879, 22.523000717163086, "vehicle"),
    ("08:54:04", 11.131008, 77.322705, 22.375999450683594, "vehicle"),
    ("08:54:13", 11.130539, 77.321853, 20.695999145507812, "vehicle"),
    ("08:54:24", 11.130552, 77.321497, 23.143999099731445, "vehicle"),
    ("08:54:43", 11.131317, 77.320682, 12.592000007629395, "vehicle"),
    ("08:54:52", 11.131246, 77.320245, 9.78600025177002, "vehicle"),
    ("08:55:03", 11.131028, 77.31956, 14.081000328063965, "vehicle"),
    ("08:55:13", 11.130858, 77.318862, 12.475000381469727, "vehicle"),
    ("08:55:23", 11.130909, 77.318569, 17.30699920654297, "vehicle"),
    ("08:55:33", 11.131268, 77.318596, 11.895999908447266, "walking"),
    ("08:56:09", 11.131132, 77.318425, 21.054000854492188, "walking"),
    ("08:57:11", 11.131333, 77.31853, 7.239999771118164, "walking"),
    ("08:57:57", 11.131463, 77.318848, 36.645999908447266, "still"),
    ("08:58:52", 11.131255, 77.31888, 26.683000564575195, "still"),
    ("09:05:46", 11.131287, 77.318856, 20.0, "still"),
]


def _track1_epoch(hms: str) -> int:
    h, m, s = (int(x) for x in hms.split(":"))
    return int(datetime(2026, 10, 28, h, m, s, tzinfo=dt_timezone.utc).timestamp())


def _track1_fixes() -> list[Fix]:
    return [
        Fix(t=_track1_epoch(t), lat=lat, lng=lng, acc=acc, activity=act, seq=k)
        for k, (t, lat, lng, acc, act) in enumerate(TRACK1)
    ]


class RealTrackReplay(JourneyAssertions):
    """The 27 fixes of the real On-Duty track 1 recorded on the dev server: a phone that reported once in five minutes
    while still. The first version of the stop rework gave three stops; the owner then showed that the second one
    (08:13:39-08:50:23) was TWO breaks 65 m apart (08:13:39-08:26:32, then 08:30:14-08:50:23), so there are four."""

    def setUp(self):
        self.j = run(_track1_fixes())
        self.stops = stops(self.j)

    def hms(self, t: int) -> str:
        return datetime.fromtimestamp(t, tz=dt_timezone.utc).strftime("%H:%M:%S")

    def test_the_four_stops_are_found(self):
        self.assertEqual(len(self.stops), 4)
        self.assertEqual(self.j.summary["stop_count"], 4)
        self.assertEqual(
            [(self.hms(s.start), self.hms(s.end)) for s in self.stops],
            [("07:50:44", "08:03:59"), ("08:13:39", "08:26:32"), ("08:30:14", "08:50:23"), ("08:55:33", "09:05:46")],
        )

    def test_the_first_and_the_last_stop_are_unchanged(self):
        first, last = self.stops[0], self.stops[3]
        self.assertEqual((first.duration_s, first.point_count, first.meta["detectionRadiusM"]), (795, 3, 200.0))
        self.assertLess(first.radius_m, 20.0)
        self.assertEqual((last.duration_s, last.point_count), (613, 6))
        self.assertLess(last.radius_m, 45.0)  # it was 81.7 before the first rework

    def test_the_two_breaks_are_each_tight_and_each_keeps_its_own_fixes(self):
        first_break, second_break = self.stops[1], self.stops[2]
        self.assertEqual((first_break.point_count, second_break.point_count), (3, 5))
        # radius_m is the spread of the stop's OWN fixes: 6 m, not the 65 m between the two places
        self.assertLess(first_break.radius_m, 8.0)
        self.assertLess(second_break.radius_m, 8.0)
        self.assertGreater(dist_between(first_break.center, second_break.center), 55.0)
        # the poor-accuracy fix at 08:30:14 (56 m) belongs to the second break it sits in, not to the first one
        self.assertEqual(self.hms(second_break.start), "08:30:14")
        self.assertEqual(self.hms(first_break.end), "08:26:32")

    def test_the_walk_between_the_breaks_is_a_short_travel_segment(self):
        self.assertEqual(kinds(self.j), ["stop", "gap", "stop", "travel", "stop", "travel", "stop"])
        walk = self.j.segments[3]
        self.assertEqual((self.hms(walk.start), self.hms(walk.end), walk.point_count), ("08:26:32", "08:30:14", 2))
        self.assertAlmostEqual(walk.distance_m, 65.0, delta=8.0)

    def test_the_third_stop_starts_after_the_last_moving_fix(self):
        last_vehicle = max(f.t for f in self.j.fixes if f.activity == "vehicle")
        stop = self.stops[3]
        self.assertGreater(stop.start, last_vehicle)
        self.assertEqual(self.hms(stop.start), "08:55:33")
        self.assertEqual(self.hms(self.stops[2].end), "08:50:23")  # the vehicle fix at 08:53:43 is travel

    def test_the_whole_route_between_the_last_two_stops_is_travel_and_reaches_both(self):
        travel = self.j.segments[5]
        self.assertEqual((travel.start, travel.end), (self.stops[2].end, self.stops[3].start))
        self.assertEqual(travel.point_count, 12)  # the last still fix, the ten vehicle fixes and the first walking fix
        self.assertEqual(self.j.summary["gap_s"], 580)  # 08:03:59 -> 08:13:39 is the only hole in the data

    def test_no_fix_is_lost(self):
        self.assertEqual(len(self.j.fixes), 27)
        self.assert_nothing_lost(self.j)

    def test_the_summary_adds_up(self):
        s = self.j.summary
        self.assertEqual(s["stop_s"], 795 + 773 + 1209 + 613)
        self.assertEqual(s["travel_s"], 222 + 310)
        self.assertEqual(
            s["travel_s"] + s["stop_s"] + s["gap_s"], _track1_epoch("09:05:46") - _track1_epoch("07:50:44")
        )

    def test_s11_the_two_breaks_alone_replay_as_two_stops(self):
        # IST 13:43:39-13:56:32 (A) and 14:00:14-14:20:23 (B): fixes 3..10 of the track (UTC 08:13:39-08:50:23)
        j = run(_track1_fixes()[3:11])
        self.assertEqual(kinds(j), ["stop", "travel", "stop"])
        a_stop, _, b_stop = j.segments
        self.assertEqual(
            [(self.hms(a_stop.start), self.hms(a_stop.end)), (self.hms(b_stop.start), self.hms(b_stop.end))],
            [("08:13:39", "08:26:32"), ("08:30:14", "08:50:23")],
        )
        self.assertEqual((a_stop.point_count, b_stop.point_count), (3, 5))
        self.assertEqual((a_stop.meta["fixCount"], b_stop.meta["fixCount"]), (3, 5))
        self.assertEqual((a_stop.meta["coreRadiusM"], b_stop.meta["coreRadiusM"]), (50.0, 50.0))
        self.assertEqual((a_stop.meta["centreAccuracyM"], b_stop.meta["centreAccuracyM"]), (17.2, 11.1))
        self.assert_nothing_lost(j)


def dist_between(a, b) -> float:
    return haversine_distance_m(a[0], a[1], b[0], b[1])


def visit(t0, north, east, seconds, *, every=60, acc=10.0, activity="still"):
    """A break: fixes every `every` seconds from t0 to t0 + seconds at (north, east)."""
    return stand(t0, seconds, every=every, north=north, east=east, acc=acc, activity=activity)


class SequentialPlaceScenarios(JourneyAssertions):
    """Every place where the person stopped for more than three minutes is a stop, however close it is to another one:
    the fixes decide (tight blocks that are clearly apart), not a radius."""

    def assert_stops(self, j, expected):
        got = [(s.start - E0, s.end - E0) for s in stops(j)]
        self.assertEqual(got, expected)
        self.assert_nothing_lost(j)

    def test_s12_two_breaks_65_metres_apart_with_a_fix_every_minute_are_two_stops(self):
        for activity in ("still", "unknown"):
            with self.subTest(activity=activity):
                fixes = visit(0, 0, 0, 300, activity=activity) + visit(360, 0, 65, 300, activity=activity)
                j = run(fixes)
                self.assertEqual(kinds(j), ["stop", "travel", "stop"])
                self.assert_stops(j, [(0, 300), (360, 660)])
                first, walk, second = j.segments
                self.assertEqual((walk.start, walk.end), (first.end, second.start))
                self.assertAlmostEqual(walk.distance_m, 65.0, delta=1.0)
                self.assertEqual(j.summary["stop_count"], 2)
                self.assertLess(first.radius_m, 1.0)
                self.assertLess(second.radius_m, 1.0)

    def test_s13_two_breaks_40_metres_apart_with_accuracy_8_are_two_stops(self):
        fixes = visit(0, 0, 0, 300, acc=8.0) + visit(360, 0, 40, 300, acc=8.0)
        self.assert_stops(run(fixes), [(0, 300), (360, 660)])

    def test_s13b_where_the_separation_starts(self):
        # accuracy 8: the centres must be more than 25 m apart (the GPS noise of two tight places is far smaller)
        for metres, expected in ((6, 1), (12, 1), (24, 1), (30, 2), (40, 2), (65, 2), (120, 2)):
            with self.subTest(metres=metres):
                fixes = visit(0, 0, 0, 300, acc=8.0) + visit(360, 0, float(metres), 300, acc=8.0)
                self.assertEqual(len(stops(run(fixes))), expected)

    def test_s13c_two_places_the_same_distance_apart_with_bad_accuracy_are_one(self):
        # 40 m apart but only good to 40 m each: the two stays cannot be told apart
        fixes = visit(0, 0, 0, 300, acc=40.0) + visit(360, 0, 40, 300, acc=40.0)
        self.assertEqual(len(stops(run(fixes))), 1)

    def test_s14_two_breaks_12_metres_apart_are_one_stop(self):
        j = run(visit(0, 0, 0, 300) + visit(360, 0, 12, 300))
        self.assert_stops(j, [(0, 660)])
        self.assertEqual(j.segments[0].point_count, 12)

    def test_s15_a_phone_that_flips_between_two_positions_every_minute_is_one_stop(self):
        for every, acc in ((60, 10.0), (30, 8.0), (60, 25.0)):
            with self.subTest(every=every, acc=acc):
                fixes = [
                    fix(every * k, east=60.0 * (k % 2), acc=acc, activity="still") for k in range(600 // every + 1)
                ]
                j = run(fixes)
                self.assertEqual(kinds(j), ["stop"])
                self.assert_nothing_lost(j)
                self.assertEqual(j.segments[0].duration_s, 600)

    def test_s15b_two_fixes_at_each_position_in_turn_is_still_one_stop(self):
        fixes = [fix(60 * k, east=60.0 * ((k // 2) % 2), acc=10.0, activity="still") for k in range(11)]
        self.assertEqual(kinds(run(fixes)), ["stop"])

    def test_s16_indoor_drift_with_poor_accuracy_is_one_stop(self):
        fixes = []
        for k in range(21):  # a fix every 30 s for 10 minutes, wandering up to 90 m, accuracy 50-90 m
            angle = math.radians(k * 137.5)
            d = (k * 37) % 91
            fixes.append(
                fix(30 * k, d * math.cos(angle), d * math.sin(angle), acc=50.0 + (k * 13) % 41, activity="still")
            )
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual((j.segments[0].start - E0, j.segments[0].end - E0, j.segments[0].point_count), (0, 600, 21))
        self.assert_nothing_lost(j)

    def test_s17_three_places_in_sequence_are_three_stops(self):
        fixes = visit(0, 0, 0, 240) + visit(300, 0, 70, 300) + visit(660, 0, 140, 240)
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop", "travel", "stop", "travel", "stop"])
        self.assert_stops(j, [(0, 240), (300, 600), (660, 900)])
        self.assertEqual([s.point_count for s in stops(j)], [5, 6, 5])

    def test_s18_sparse_two_fixes_per_place_are_two_stops(self):
        for activity in ("still", "unknown"):
            with self.subTest(activity=activity):
                fixes = [
                    fix(0, activity=activity),
                    fix(240, activity=activity),
                    fix(300, east=60.0, activity=activity),
                    fix(540, east=60.0, activity=activity),
                ]
                self.assert_stops(run(fixes), [(0, 240), (300, 540)])

    def test_s19_a_poor_fix_in_the_middle_of_the_first_break_does_not_block_the_split(self):
        first = visit(0, 0, 0, 480)
        k = [i for i, f in enumerate(first) if f.t == E0 + 240][0]
        first[k] = fix(240, north=90.0, acc=100.0, activity="still")  # 90 m off, good to 100 m
        for activity in ("still", "unknown"):
            with self.subTest(activity=activity):
                fixes = [Fix(f.t, f.lat, f.lng, f.acc, activity=activity, seq=f.seq) for f in first]
                fixes += visit(540, 0, 65, 300, activity=activity)
                self.assert_stops(run(fixes), [(0, 480), (540, 840)])

    def test_s19b_a_poor_fix_does_not_create_a_split_either(self):
        fixes = visit(0, 0, 0, 600)
        k = [i for i, f in enumerate(fixes) if f.t == E0 + 300][0]
        fixes[k] = fix(300, north=120.0, acc=100.0, activity="still")
        j = run(fixes)
        self.assertEqual(kinds(j), ["stop"])
        self.assertEqual(j.segments[0].point_count, 11)

    def test_s19c_a_poor_fix_at_the_seam_goes_to_the_place_it_belongs_to(self):
        # the first fix of the second break is a poor one (accuracy 56) 70 m from the first break: it is the second's
        second = visit(360, 0, 65, 300)
        second[0] = fix(360, east=70.0, acc=56.0, activity="still")
        j = run(visit(0, 0, 0, 300) + second)
        self.assert_stops(j, [(0, 300), (360, 660)])

    def test_s20_a_break_of_2m50_followed_by_a_break_of_6_minutes_is_the_second_only(self):
        short_first = visit(0, 0, 0, 170, every=10) + visit(230, 0, 65, 360)
        j = run(short_first)
        self.assertEqual(kinds(j), ["travel", "stop"])
        self.assert_stops(j, [(230, 590)])
        self.assertEqual(j.segments[1].point_count, 7)

    def test_s20b_and_the_other_way_round(self):
        j = run(visit(0, 0, 0, 360) + visit(420, 0, 65, 170, every=10))
        self.assertEqual(kinds(j), ["stop", "travel"])
        self.assert_stops(j, [(0, 360)])

    def test_s21_the_walk_between_two_breaks_is_travel_not_part_of_either(self):
        walk = [fix(300 + 10 * k, east=12.0 * k, activity="walking") for k in range(1, 6)]  # 5 fixes, 60 m
        fixes = visit(0, 0, 0, 300) + walk + visit(360, 0, 72, 300)
        j = run(fixes)
        self.assertEqual(len(stops(j)), 2)
        first, second = stops(j)
        self.assertEqual(first.start - E0, 0)
        self.assertGreaterEqual(first.end - E0, 300)
        self.assertLessEqual(first.end - E0, 320)  # the walk starts leaving at once: at most a fix or two stay
        self.assertEqual(second.end - E0, 660)
        self.assertGreater(j.summary["travel_s"], 0)
        self.assert_nothing_lost(j)

    def test_s21b_a_ride_in_two_breaks_and_a_ride_out(self):
        fixes = arrive(60) + visit(120, 0, 0, 300) + visit(480, 0, 65, 300) + leave(783, east=65.0)
        j = run(fixes)
        self.assertEqual(kinds(j), ["travel", "stop", "travel", "stop", "travel"])
        self.assert_stops(j, [(60, 420), (480, 780)])
        self.assertEqual(
            j.segments[2].point_count, 2
        )  # the walk: the last fix of the first break, the first of the second

    def test_s23_a_return_to_the_first_place_after_a_second_break_is_a_third_stop(self):
        j = run(visit(0, 0, 0, 300) + visit(360, 0, 65, 300) + visit(720, 0, 0, 300))
        self.assert_stops(j, [(0, 300), (360, 660), (720, 1020)])

    def test_s22_the_same_place_again_after_a_short_excursion_is_one_stop_but_another_place_is_a_new_one(self):
        brief = [fix(310, north=300.0), fix(320, north=400.0), fix(330, north=300.0)]
        same = run(visit(0, 0, 0, 300) + brief + visit(340, 0, 10, 300))
        self.assertEqual(len(stops(same)), 1)
        other = run(visit(0, 0, 0, 300) + brief + visit(340, 0, 60, 300))
        self.assertEqual(len(stops(other)), 2)

    def test_two_stops_at_the_same_gate_separated_by_a_ride_stay_two(self):
        # the stops 1 and 3 of the real track: 4 m apart but an hour apart with a ride in between
        fixes = arrive(60) + stand(120, 300, every=60) + leave(423, n=40) + arrive(2000, north=0.0) + stand(2060, 300)
        self.assertEqual(len(stops(run(fixes))), 2)

    def test_the_split_keeps_the_partition_on_random_multi_place_tracks(self):
        rng = random.Random(21)
        for _ in range(60):
            fixes, t = [], 0
            for _ in range(rng.randint(2, 6)):
                east = rng.choice([0.0, 20.0, 45.0, 70.0, 150.0])
                fixes += visit(
                    t,
                    rng.choice([0.0, 30.0]),
                    east,
                    rng.choice([120, 200, 300, 600]),
                    every=rng.choice([10, 30, 60]),
                    acc=rng.choice([8.0, 20.0, 60.0]),
                    activity=rng.choice(["still", "unknown"]),
                )
                t = fixes[-1].t - E0 + rng.choice([20, 60, 100])
            j = run(fixes, started=E0 - 10, ended=E0 + t + 400)
            self.assert_nothing_lost(j)
            found = stops(j)
            for a, b in zip(found, found[1:]):
                self.assertLessEqual(a.end, b.start)
