"""Geo-Tracking: GET /api/tracking/journeys/<id>/trail, the route trail the HR map draws (every stored fix, compact, in time
order). What it pins: the shape of the answer, the time order, which fixes are flagged used=false (the ones the cleaning step
drops), the stop numbering (the same seqNo as the stop segments), the thinning over MAX_TRAIL_POINTS, the fallback once the
raw rows are purged, branch scoping and who may call it (HR only), and the audit entry.

Run:  python manage.py test api.tests_geo_tracking_trail --noinput
"""

from datetime import datetime, timedelta
from unittest import mock

from django.test import SimpleTestCase

from .geo_tracking import hr_views, journey
from .models import AuditLog, DutyTrack, DutyTrackPoint
from .tests_geo_tracking_support import LAT0, LNG0, T0, GeoBase, employee_headers, ms, offset_latlng
from .tests_geo_tracking_views import drive_points, dwell_points

POINT_KEYS = {"t", "lat", "lng", "acc", "spd", "act", "bat", "net", "prov", "mock", "used", "stop"}
BODY_KEYS = {"trackId", "source", "total", "count", "truncated", "points"}


def raw_point(track, seq, offset_s, north=0.0, east=0.0, **extra) -> DutyTrackPoint:
    """A stored fix `offset_s` seconds after T0, `north` / `east` metres from the origin."""
    lat, lng = offset_latlng(LAT0, LNG0, north, east)
    fields = {
        "accuracy_m": 8.0,
        "activity": "unknown",
        "battery_pct": 70,
        "network": "cell",
        "provider": "fused",
    }
    fields.update(extra)
    return DutyTrackPoint(
        track=track,
        employee=track.employee,
        device_id="d1",
        seq=seq,
        recorded_at=T0 + timedelta(seconds=offset_s),
        latitude=round(lat, 6),
        longitude=round(lng, 6),
        **fields,
    )


class TrailBase(GeoBase):
    URL = "/api/tracking/journeys/{pk}/trail"

    def setUp(self):
        super().setUp()
        self.end = T0 + timedelta(minutes=60)
        self.track = self.make_track(self.asha, T0, ended_at=self.end, last_device_id="d1")

    def trail(self, user=None, pk=None, **params):
        return self.as_hr(user or self.hr_super, "get", self.URL.format(pk=pk or self.track.pk), **params)

    def body(self, **kw) -> dict:
        r = self.trail(**kw)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def store(self, rows, track=None):
        DutyTrackPoint.objects.bulk_create(rows)
        track = track or self.track
        DutyTrack.objects.filter(pk=track.pk).update(points_count=DutyTrackPoint.objects.filter(track=track).count())

    def journey_with_a_stop(self):
        """A drive (0..290 s), a 10 minute stop at 4350 m (290..910 s) and a drive away (910..1150 s), rebuilt."""
        drive_points(self.track, 30, seq0=1)
        dwell_points(self.track, seq0=100, t0=T0 + timedelta(seconds=300), north=4350.0)
        drive_points(self.track, 25, seq0=200, t0=T0 + timedelta(seconds=910), north0=4350.0)
        journey.rebuild(self.track)
        self.track.refresh_from_db()

    def detail_segments(self) -> list[dict]:
        return self.as_hr(self.hr_super, "get", f"/api/tracking/journeys/{self.track.pk}").json()["segments"]


def iso_ms(value: str) -> int:
    return int(round(datetime.fromisoformat(value).timestamp() * 1000))


class TrailShapeTests(TrailBase):
    def test_the_body_and_every_point_have_exactly_the_contract_keys(self):
        self.store(
            [
                raw_point(
                    self.track,
                    1,
                    0,
                    activity="still",
                    speed_mps=2.5,
                    battery_pct=87,
                    network="wifi",
                    provider="gps",
                    accuracy_m=14.013999938964844,
                ),
                raw_point(self.track, 2, 30, north=10.0),
            ]
        )
        body = self.body()
        self.assertEqual(set(body), BODY_KEYS)
        self.assertEqual(
            (body["trackId"], body["source"], body["total"], body["count"], body["truncated"]),
            (self.track.pk, "points", 2, 2, False),
        )
        for p in body["points"]:
            self.assertEqual(set(p), POINT_KEYS)
        first = body["points"][0]
        lat, lng = offset_latlng(LAT0, LNG0)
        self.assertEqual(
            first,
            {
                "t": ms(T0),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "acc": 14.0,
                "spd": 9.0,  # 2.5 m/s is 9 km/h
                "act": "still",
                "bat": 87,
                "net": "wifi",
                "prov": "gps",
                "mock": False,
                "used": True,
                "stop": None,
            },
        )
        second = body["points"][1]
        self.assertIsNone(second["spd"])  # the phone sent no speed
        self.assertEqual((second["act"], second["net"], second["prov"]), ("unknown", "cell", "fused"))

    def test_t_is_epoch_milliseconds_and_coordinates_have_six_decimals(self):
        row = raw_point(self.track, 1, 0)
        row.recorded_at = T0 + timedelta(milliseconds=1234)
        row.latitude, row.longitude = 11.1312844, 77.3188551  # more digits than the column stores
        self.store([row])
        (p,) = self.body()["points"]
        self.assertEqual(p["t"], ms(T0) + 1234)
        self.assertEqual((p["lat"], p["lng"]), (11.131284, 77.318855))
        self.assertIsInstance(p["lat"], float)

    def test_a_fake_location_fix_is_flagged_mock_and_still_used(self):
        self.store([raw_point(self.track, 1, 0, is_mock=True), raw_point(self.track, 2, 10, north=5.0)])
        points = self.body()["points"]
        self.assertEqual([(p["mock"], p["used"]) for p in points], [(True, True), (False, True)])

    def test_a_track_without_points_answers_an_empty_trail(self):
        body = self.body()
        self.assertEqual(
            (body["source"], body["total"], body["count"], body["truncated"], body["points"]),
            ("points", 0, 0, False, []),
        )


class TrailOrderAndUsedTests(TrailBase):
    def test_points_come_in_time_order_whatever_order_they_arrived_in(self):
        rows = [raw_point(self.track, seq, off) for seq, off in ((1, 40), (2, 10), (3, 30), (4, 20), (5, 0))]
        self.store(rows)
        times = [p["t"] for p in self.body()["points"]]
        self.assertEqual(times, [ms(T0) + 1000 * s for s in (0, 10, 20, 30, 40)])

    def test_points_with_the_same_time_come_in_seq_order(self):
        self.store([raw_point(self.track, 9, 10, north=30.0), raw_point(self.track, 4, 10, north=20.0)])
        points = self.body()["points"]
        lat_4 = round(offset_latlng(LAT0, LNG0, 20.0)[0], 6)
        lat_9 = round(offset_latlng(LAT0, LNG0, 30.0)[0], 6)
        self.assertEqual([p["lat"] for p in points], [lat_4, lat_9])

    def test_the_fixes_the_cleaning_step_drops_are_flagged_used_false_and_still_listed(self):
        rows = [raw_point(self.track, k + 1, 10 * k, north=150.0 * k) for k in range(20)]
        rows[5] = raw_point(self.track, 6, 50, north=750.0, accuracy_m=500.0)  # inaccurate (limit 100 m)
        rows[10] = raw_point(self.track, 11, 100, north=50_000.0)  # 50 km away, 10 s after its neighbour: a teleport
        rows.append(raw_point(self.track, 100, 190, north=150.0 * 19))  # an exact duplicate of the last fix
        self.store(rows)
        body = self.body()
        self.assertEqual((body["total"], body["count"]), (21, 21))
        used = {p["t"]: p["used"] for p in body["points"]}
        self.assertFalse(used[ms(T0) + 50_000])
        self.assertFalse(used[ms(T0) + 100_000])
        flags = [p["used"] for p in body["points"]]
        self.assertEqual(flags.count(False), 3)  # the inaccurate fix, the teleport and the duplicate
        self.assertFalse(flags[-1])  # the duplicate is the later of the two identical fixes
        self.assertTrue(flags[-2])
        # the same fixes are the ones the pipeline reports as dropped
        fixes = [
            journey.fix_from_row(r)
            for r in DutyTrackPoint.objects.filter(track=self.track).values(*hr_views._TRAIL_ROW_FIELDS)
        ]
        cleaned = journey.clean(fixes, journey.Params())
        self.assertEqual((cleaned.dropped_accuracy, cleaned.dropped_teleport, cleaned.dropped_duplicate), (1, 1, 1))

    def test_a_fix_over_the_accuracy_limit_follows_the_setting(self):
        from .models import GeoTrackingSettings

        self.store([raw_point(self.track, 1, 0, accuracy_m=60.0), raw_point(self.track, 2, 10, north=5.0)])
        self.assertTrue(all(p["used"] for p in self.body()["points"]))
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"max_accuracy_m": 50})
        self.assertEqual([p["used"] for p in self.body()["points"]], [False, True])


class TrailStopNumberingTests(TrailBase):
    def test_stop_is_the_seqno_of_the_stop_segment_that_holds_the_fix(self):
        self.journey_with_a_stop()
        segments = self.detail_segments()
        stop_seg = next(s for s in segments if s["kind"] == "stop")
        self.assertEqual(stop_seg["seqNo"], 2)
        start, end = iso_ms(stop_seg["startedAt"]), iso_ms(stop_seg["endedAt"])
        points = self.body()["points"]
        self.assertEqual(len(points), 30 + 61 + 25)
        inside = [p for p in points if start <= p["t"] <= end]
        outside = [p for p in points if not start <= p["t"] <= end]
        self.assertTrue(inside and outside)
        self.assertTrue(all(p["stop"] == stop_seg["seqNo"] for p in inside))
        self.assertTrue(all(p["stop"] is None for p in outside))
        # the fix that starts the stop and the fix that ends it belong to it (the range is closed)
        self.assertEqual(inside[0]["t"], start)
        self.assertEqual(inside[-1]["t"], end)

    def test_two_stops_are_numbered_by_their_own_segments(self):
        drive_points(self.track, 20, seq0=1)  # 0..190 s, ends at 2850 m
        dwell_points(self.track, seq0=100, t0=T0 + timedelta(seconds=200), north=2850.0, seconds=300)
        drive_points(self.track, 20, seq0=200, t0=T0 + timedelta(seconds=510), north0=2850.0 + 150.0, step_m=150.0)
        dwell_points(self.track, seq0=300, t0=T0 + timedelta(seconds=720), north=6000.0, seconds=300)
        journey.rebuild(self.track)
        stop_seqs = [s["seqNo"] for s in self.detail_segments() if s["kind"] == "stop"]
        self.assertEqual(len(stop_seqs), 2)
        numbers = {p["stop"] for p in self.body()["points"]} - {None}
        self.assertEqual(numbers, set(stop_seqs))

    def test_without_segments_no_fix_belongs_to_a_stop(self):
        self.store([raw_point(self.track, k + 1, 10 * k) for k in range(30)])  # nothing rebuilt yet
        self.assertTrue(all(p["stop"] is None for p in self.body()["points"]))


class TrailThinningTests(SimpleTestCase):
    def test_thin_indices_keeps_the_must_have_indices_and_stays_within_the_limit(self):
        got = hr_views.thin_indices(1000, {0, 999, 500, 123}, 50)
        self.assertLessEqual(len(got), 50)
        self.assertEqual(got, sorted(set(got)))
        self.assertTrue({0, 999, 500, 123} <= set(got))

    def test_thin_indices_thins_the_must_have_set_itself_when_it_is_over_the_limit(self):
        keep = set(range(0, 1000, 2))
        got = hr_views.thin_indices(1000, keep, 100)
        self.assertEqual(len(got), 100)
        self.assertEqual((got[0], got[-1]), (0, 998))
        self.assertTrue(set(got) <= keep)


class TrailTruncationTests(TrailBase):
    def test_a_long_track_is_thinned_but_keeps_its_ends_its_segment_boundaries_and_its_dropped_fixes(self):
        self.journey_with_a_stop()
        DutyTrackPoint.objects.bulk_create([raw_point(self.track, 900, 1200, north=9000.0, accuracy_m=500.0)])
        segments = self.detail_segments()
        boundaries = {iso_ms(s[k]) for s in segments for k in ("startedAt", "endedAt")}
        with mock.patch.object(hr_views, "MAX_TRAIL_POINTS", 40):
            body = self.body()
        self.assertTrue(body["truncated"])
        self.assertEqual(body["total"], 30 + 61 + 25 + 1)
        self.assertEqual(body["count"], len(body["points"]))
        self.assertLess(body["count"], body["total"])
        self.assertLessEqual(body["count"], 40)
        times = [p["t"] for p in body["points"]]
        self.assertEqual(times, sorted(times))
        self.assertEqual((times[0], times[-1]), (ms(T0), ms(T0) + 1_200_000))  # the first and the last fix
        kept = set(times)
        # every segment boundary that is a fix time is still there (a gap's start is the last fix before it)
        fix_times = {ms(T0) + 1000 * s for s in range(0, 290 + 1, 10)} | {
            ms(T0) + 1000 * s for s in range(300, 901, 10)
        }
        fix_times |= {ms(T0) + 1000 * s for s in range(910, 1151, 10)}
        for b in boundaries & fix_times:
            self.assertIn(b, kept)
        self.assertIn(ms(T0) + 1_200_000, kept)
        self.assertFalse([p for p in body["points"] if p["t"] == ms(T0) + 1_200_000][0]["used"])

    def test_a_track_of_exactly_the_limit_is_not_truncated(self):
        self.store([raw_point(self.track, k + 1, 3 * k, north=10.0 * k) for k in range(30)])
        with mock.patch.object(hr_views, "MAX_TRAIL_POINTS", 30):
            body = self.body()
        self.assertEqual((body["truncated"], body["total"], body["count"]), (False, 30, 30))

    def test_more_than_8000_points_come_back_as_at_most_8000(self):
        self.assertEqual(hr_views.MAX_TRAIL_POINTS, 8000)
        self.store([raw_point(self.track, k + 1, 3 * k, north=10.0 * k) for k in range(8100)], track=self.track)
        body = self.body()
        self.assertEqual((body["truncated"], body["total"]), (True, 8100))
        self.assertLessEqual(body["count"], 8000)
        self.assertLess(body["count"], body["total"])
        self.assertEqual(body["count"], len(body["points"]))
        times = [p["t"] for p in body["points"]]
        self.assertEqual((times[0], times[-1]), (ms(T0), ms(T0) + 3000 * 8099))
        self.assertEqual(times, sorted(times))


class TrailPurgedTests(TrailBase):
    def purge(self):
        DutyTrackPoint.objects.filter(track=self.track).delete()
        DutyTrack.objects.filter(pk=self.track.pk).update(flags={"purgedAt": "2027-10-28T00:00:00+00:00"})

    def test_after_the_retention_purge_the_trail_is_built_from_the_segments(self):
        self.journey_with_a_stop()
        detail = self.as_hr(self.hr_super, "get", f"/api/tracking/journeys/{self.track.pk}").json()
        self.purge()
        body = self.body()
        self.assertEqual(set(body), BODY_KEYS)
        self.assertEqual((body["source"], body["truncated"], body["trackId"]), ("segments", False, self.track.pk))
        self.assertEqual(body["total"], body["count"])
        points = body["points"]
        self.assertGreater(len(points), 3)
        for p in points:
            self.assertEqual(set(p), POINT_KEYS)
            self.assertTrue(p["used"])
            self.assertTrue(isinstance(p["lat"], float) and isinstance(p["lng"], float) and isinstance(p["t"], int))
            for key in ("acc", "spd", "act", "bat", "net", "prov", "mock"):
                self.assertIsNone(p[key], key)
        times = [p["t"] for p in points]
        self.assertEqual(times, sorted(times))
        # built like the journey detail's own fallback path: the travel vertices and the stop centres
        fallback = self.as_hr(self.hr_super, "get", f"/api/tracking/journeys/{self.track.pk}").json()
        self.assertEqual(fallback["pathSource"], "segments")
        self.assertEqual([[p["lat"], p["lng"], p["t"]] for p in points], fallback["path"])
        self.assertEqual(len(points), len(detail["path"]) if detail["pathSource"] == "segments" else len(points))
        # the stop centre carries the stop's number (so do the vertices that sit exactly on its start and end instants)
        stop_seg = next(s for s in fallback["segments"] if s["kind"] == "stop")
        start, end = iso_ms(stop_seg["startedAt"]), iso_ms(stop_seg["endedAt"])
        numbered = [p for p in points if p["stop"] == stop_seg["seqNo"]]
        self.assertTrue(all(start <= p["t"] <= end for p in numbered))
        self.assertTrue(all(p["stop"] is None for p in points if not start <= p["t"] <= end))
        centre = [p for p in points if (p["lat"], p["lng"]) == (stop_seg["centerLat"], stop_seg["centerLng"])]
        self.assertTrue(centre)
        self.assertTrue(all(p["stop"] == stop_seg["seqNo"] for p in centre))

    def test_a_purged_track_without_segments_answers_an_empty_trail_not_a_500(self):
        self.purge()
        body = self.body()
        self.assertEqual((body["source"], body["total"], body["points"]), ("segments", 0, []))

    def test_points_that_vanished_without_the_purge_flag_fall_back_too(self):
        self.journey_with_a_stop()
        DutyTrackPoint.objects.filter(track=self.track).delete()
        self.assertEqual(self.body()["source"], "segments")


class TrailAccessTests(TrailBase):
    def setUp(self):
        super().setUp()
        self.store([raw_point(self.track, k + 1, 10 * k, north=150.0 * k) for k in range(12)])
        self.other = self.make_track(self.ravi, T0, ended_at=self.end)
        self.store(
            [
                raw_point(
                    self.other,
                    k + 1,
                    10 * k,
                    north=150.0 * k,
                )
                for k in range(5)
            ],
            track=self.other,
        )

    def test_an_unknown_journey_is_not_found(self):
        r = self.trail(pk=999999)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"], "Journey not found")

    def test_another_branchs_journey_is_not_found_and_leaves_no_audit_entry(self):
        self.assertEqual(self.trail(self.hr_ho, self.other.pk).status_code, 404)
        self.assertEqual(self.trail(self.hr_u2, self.track.pk).status_code, 404)
        self.assertFalse(AuditLog.objects.filter(module="geo_tracking").exists())
        self.assertEqual(self.trail(self.hr_ho, self.track.pk).status_code, 200)
        self.assertEqual(self.trail(self.hr_u2, self.other.pk).status_code, 200)
        self.assertEqual(self.trail(self.hr_super, self.other.pk).status_code, 200)

    def test_the_trail_carries_only_the_asked_tracks_points(self):
        self.assertEqual(self.body(pk=self.other.pk)["total"], 5)
        self.assertEqual(self.body()["total"], 12)

    def test_no_token_is_unauthorised(self):
        self.assertEqual(self.client.get(self.URL.format(pk=self.track.pk)).status_code, 401)

    def test_an_employee_token_is_forbidden_even_for_the_employees_own_track(self):
        r = self.client.get(self.URL.format(pk=self.track.pk), **employee_headers(self.asha))
        self.assertEqual(r.status_code, 403)

    def test_a_view_only_hr_role_can_read_it_and_one_without_geo_attendance_cannot(self):
        self.assertEqual(self.trail(self.hr_viewer).status_code, 200)
        self.assertEqual(self.trail(self.hr_editor).status_code, 200)
        self.assertEqual(self.trail(self.hr_nogeo).status_code, 403)

    def test_only_get_is_allowed(self):
        r = self.as_hr(self.hr_super, "post", self.URL.format(pk=self.track.pk), {})
        self.assertEqual(r.status_code, 405)

    def test_every_view_of_the_trail_is_audit_logged(self):
        self.trail(self.hr_ho)
        entry = AuditLog.objects.get(module="geo_tracking", action="view")
        self.assertEqual(entry.record_id, self.track.pk)
        self.assertEqual((entry.user_type, entry.branch_id), ("hr", self.ho.pk))
        self.assertIn("Asha Kumar", entry.record_description)
        self.assertIn("route trail", entry.record_description)
        self.trail(self.hr_ho)
        self.assertEqual(AuditLog.objects.filter(module="geo_tracking", action="view").count(), 2)
