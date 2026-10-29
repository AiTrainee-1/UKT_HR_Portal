"""Geo-Tracking: POST /api/tracking/batch (api/geo_tracking/ingest.py).

Run:  DB_NAME=uktex_fix_geo python manage.py test api.tests_geo_tracking_ingest --noinput
"""

import json
import threading
from datetime import timedelta
from unittest import mock

from django.db import connection
from django.test import TransactionTestCase

from .geo_tracking import background, ingest
from .jwt_utils import sign_token
from .models import (
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    DutyTrackSegment,
    Employee,
    GeoTrackingSettings,
    OnDutySession,
    TrackingConsent,
    TrackingDevice,
)
from .tests_geo_tracking_support import LAT0, LNG0, T0, GeoBase, event, ms, offset_latlng, point, snake_deep

NOW = T0 + timedelta(minutes=20)


def pts(seq0, n, t0=T0, *, north0=0.0, step_m=20.0, step_s=10, **extra):
    """n points moving north from north0, one every step_s."""
    out = []
    for k in range(n):
        lat, lng = offset_latlng(LAT0, LNG0, north0 + k * step_m, 0.0)
        out.append(point(seq0 + k, t0 + timedelta(seconds=k * step_s), lat, lng, **extra))
    return out


class IngestBase(GeoBase):
    def setUp(self):
        super().setUp()
        self.track = self.make_track(self.asha, T0)
        self.consent(self.asha)

    def ingest(self, points=(), events=(), *, device="dev-1", now=NOW, emp=None, **extra):
        body = {"deviceId": device, "points": list(points), "events": list(events), **extra}
        return ingest.ingest_batch(emp or self.asha, body, now=now)

    def refresh(self):
        self.track.refresh_from_db()
        return self.track


class BasicTests(IngestBase):
    def test_a_batch_is_stored_counted_and_acknowledged(self):
        body = {
            "deviceId": "dev-1",
            "app": {"version": "3.2.0", "os": "android", "osVersion": "14", "model": "Pixel 6"},
            "health": {
                "permission": "always",
                "locationEnabled": True,
                "backgroundRestricted": False,
                "batteryOptimised": False,
                "powerSave": False,
                "batteryPct": 71,
                "charging": False,
                "network": "cell",
            },
            "points": pts(1, 3),
            "events": [],
        }
        answer = ingest.ingest_batch(self.asha, body, now=NOW)
        self.assertEqual(
            (
                answer["ok"],
                answer["ackSeq"],
                answer["accepted"],
                answer["duplicates"],
                answer["rejected"],
                answer["trackActive"],
                answer["endReason"],
            ),
            (True, 3, 3, 0, 0, True, None),
        )
        self.assertEqual(answer["serverTime"], NOW.isoformat())
        self.assertEqual(
            set(answer["config"]),
            {
                "sampleMovingSeconds",
                "sampleStillSeconds",
                "distanceFilterM",
                "uploadBatchPoints",
                "uploadIntervalSeconds",
                "maxAccuracyM",
            },
        )
        rows = list(DutyTrackPoint.objects.filter(track=self.track).order_by("seq"))
        self.assertEqual([r.seq for r in rows], [1, 2, 3])
        first = rows[0]
        self.assertEqual(
            (first.device_id, first.employee_id, first.activity, first.network, first.provider, first.is_mock),
            ("dev-1", self.asha.pk, "unknown", "wifi", "gps", False),
        )
        self.assertEqual((first.battery_pct, first.accuracy_m, first.received_at), (80, 8.0, NOW))
        track = self.refresh()
        self.assertEqual((track.points_count, track.mock_points, track.events_count), (3, 0, 0))
        self.assertEqual(track.last_point_at, T0 + timedelta(seconds=20))
        self.assertAlmostEqual(float(track.last_latitude), offset_latlng(LAT0, LNG0, 40.0, 0.0)[0], places=5)
        self.assertEqual((track.last_battery_pct, track.last_network, track.last_device_id), (80, "wifi", "dev-1"))
        device = TrackingDevice.objects.get(employee=self.asha, device_id="dev-1")
        self.assertEqual(
            (device.platform, device.os_version, device.model, device.app_version, device.permission_level),
            ("android", "14", "Pixel 6", "3.2.0", "always"),
        )
        self.assertEqual(
            (device.location_enabled, device.background_restricted, device.battery_optimised, device.power_save),
            (True, False, False, False),
        )
        self.assertEqual(
            (device.last_battery_pct, device.last_network, device.last_seen_at, device.last_heartbeat_at),
            (71, "cell", NOW, NOW),
        )

    def test_resending_a_batch_is_harmless(self):
        batch = pts(1, 5)
        first = self.ingest(batch)
        second = self.ingest(batch)
        self.assertEqual((first["accepted"], first["duplicates"]), (5, 0))
        self.assertEqual((second["accepted"], second["duplicates"], second["rejected"], second["ackSeq"]), (0, 5, 0, 5))
        self.assertEqual(DutyTrackPoint.objects.count(), 5)
        self.assertEqual(self.refresh().points_count, 5)

    def test_a_partly_known_batch_stores_only_the_new_rows(self):
        self.ingest(pts(1, 5))
        answer = self.ingest(pts(4, 5, T0 + timedelta(seconds=30), north0=60.0))
        self.assertEqual((answer["accepted"], answer["duplicates"], answer["ackSeq"]), (3, 2, 8))
        self.assertEqual(self.refresh().points_count, 8)

    def test_the_same_seq_from_another_device_is_a_different_point(self):
        self.ingest(pts(1, 2), device="dev-1")
        answer = self.ingest(pts(1, 2), device="dev-2")
        self.assertEqual(answer["accepted"], 2)
        self.assertEqual(DutyTrackPoint.objects.count(), 4)

    def test_acknowledgement_is_the_highest_seq_dealt_with_in_the_request(self):
        self.assertEqual(self.ingest(pts(10, 3))["ackSeq"], 12)
        self.assertEqual(self.ingest(pts(10, 2))["ackSeq"], 11)  # only seq 10 and 11 were sent this time
        self.assertEqual(self.ingest([])["ackSeq"], 0)  # nothing sent, nothing acknowledged
        answer = self.ingest(pts(20, 1), [event(25, "APP_KILLED", T0 + timedelta(seconds=30))])
        self.assertEqual(answer["ackSeq"], 25)  # points and events share the device-wide counter

    def test_a_row_refused_for_good_is_still_acknowledged_so_the_app_can_drop_it(self):
        bad = point(31, T0, 95.0, 77.0)  # latitude out of range
        answer = self.ingest([point(30, T0), bad])
        self.assertEqual((answer["accepted"], answer["rejected"], answer["ackSeq"]), (1, 1, 31))

    def test_a_row_with_no_usable_seq_is_rejected_and_never_acknowledged(self):
        bad = point(5, T0)
        del bad["seq"]
        answer = self.ingest([bad])
        self.assertEqual((answer["accepted"], answer["rejected"], answer["ackSeq"]), (0, 1, 0))

    def test_rows_are_stored_in_one_bulk_insert_and_the_query_count_does_not_grow_with_the_batch(self):
        from django.test.utils import CaptureQueriesContext

        def count(n, device):
            with mock.patch.object(ingest, "_maybe_rebuild"), CaptureQueriesContext(connection) as ctx:
                ingest.ingest_batch(self.asha, {"deviceId": device, "points": pts(1, n)}, now=NOW)
            inserts = [q for q in ctx.captured_queries if q["sql"].startswith('INSERT INTO "duty_track_points"')]
            return len(ctx), len(inserts)

        small_total, small_inserts = count(5, "a")
        big_total, big_inserts = count(300, "b")
        self.assertEqual((small_inserts, big_inserts), (1, 1))
        self.assertLessEqual(big_total, small_total + 1)


class ValidationTests(IngestBase):
    def bad_rows(self):
        good = point(1, T0)
        return {
            "latitude too high": {**good, "latitude": 90.5},
            "latitude too low": {**good, "latitude": -91},
            "longitude too high": {**good, "longitude": 180.1},
            "longitude too low": {**good, "longitude": -200},
            "latitude text": {**good, "latitude": "north"},
            "latitude missing": {k: v for k, v in good.items() if k != "latitude"},
            "longitude nan": {**good, "longitude": "nan"},
            "latitude inf": {**good, "latitude": "inf"},
            "null island": {**good, "latitude": 0, "longitude": 0},
            "negative accuracy": {**good, "accuracy": -1},
            "accuracy missing": {k: v for k, v in good.items() if k != "accuracy"},
            "accuracy text": {**good, "accuracy": "good"},
            "time missing": {k: v for k, v in good.items() if k != "recordedAt"},
            "time garbage": {**good, "recordedAt": "yesterday-ish"},
            "time boolean": {**good, "recordedAt": True},
            "time absurd future": {**good, "recordedAt": ms(NOW + timedelta(days=3))},
            "time before 2000": {**good, "recordedAt": 1000},
            "seq missing": {k: v for k, v in good.items() if k != "seq"},
            "seq negative": {**good, "seq": -4},
            "seq fraction": {**good, "seq": 1.5},
            "seq text": {**good, "seq": "abc"},
            "not an object": "a string",
        }

    def test_every_kind_of_bad_row_is_counted_rejected_and_never_fails_the_batch(self):
        bad = self.bad_rows()
        rows = [point(100 + i, T0 + timedelta(seconds=i)) for i in range(3)]
        for i, (name, row) in enumerate(bad.items()):
            answer = self.ingest(rows + [row], device=f"dev-{i}")
            self.assertEqual((answer["accepted"], answer["rejected"]), (3, 1), name)
            self.assertTrue(answer["ok"], name)

    def test_good_rows_around_a_bad_one_are_stored(self):
        rows = pts(1, 3) + [point(4, T0, 120.0, 77.0)] + pts(5, 2, T0 + timedelta(seconds=60))
        answer = self.ingest(rows)
        self.assertEqual((answer["accepted"], answer["rejected"]), (5, 1))
        self.assertEqual(sorted(DutyTrackPoint.objects.values_list("seq", flat=True)), [1, 2, 3, 5, 6])

    def test_the_reason_of_each_rejection_is_reported(self):
        answer = self.ingest([point(1, T0, 95.0, 77.0), {**point(2, T0), "accuracy": -2}])
        self.assertEqual(answer["rejectedReasons"], {"coordinates": 1, "accuracy": 1})

    def test_optional_numbers_that_make_no_sense_are_dropped_not_fatal(self):
        row = {
            **point(1, T0),
            "speed": -1,
            "bearing": 700,
            "altitude": "high",
            "activity": "teleporting",
            "network": "tin-can",
            "provider": "magic",
        }
        self.assertEqual(self.ingest([row])["accepted"], 1)
        stored = DutyTrackPoint.objects.get(seq=1)
        self.assertEqual((stored.speed_mps, stored.bearing_deg, stored.altitude_m), (None, None, None))
        self.assertEqual((stored.activity, stored.network, stored.provider), ("unknown", "unknown", "unknown"))

    def test_activity_network_and_battery_spellings_are_normalised(self):
        rows = [
            {**point(1, T0), "activity": "IN_VEHICLE", "network": "Cellular", "battery": 0.5},
            {**point(2, T0 + timedelta(seconds=10)), "activity": "on_foot", "network": "WIFI", "battery": 250},
        ]
        self.ingest(rows)
        one, two = DutyTrackPoint.objects.order_by("seq")
        self.assertEqual((one.activity, one.network, one.battery_pct), ("vehicle", "cell", 50))
        self.assertEqual((two.activity, two.network, two.battery_pct), ("walking", "wifi", None))

    def test_mock_points_are_stored_flagged_and_counted(self):
        self.ingest(
            [
                point(1, T0, isMocked=True),
                point(2, T0 + timedelta(seconds=10), isMocked="true"),
                point(3, T0 + timedelta(seconds=20)),
            ]
        )
        self.assertEqual(DutyTrackPoint.objects.filter(is_mock=True).count(), 2)
        self.assertEqual(self.refresh().mock_points, 2)

    def test_a_missing_device_id_is_refused(self):
        with self.assertRaises(ingest.BatchError) as ctx:
            ingest.ingest_batch(self.asha, {"points": pts(1, 1)}, now=NOW)
        self.assertEqual((ctx.exception.status, ctx.exception.body["code"]), (400, "DEVICE_ID_REQUIRED"))

    def test_points_and_events_must_be_lists(self):
        with self.assertRaises(ingest.BatchError) as ctx:
            ingest.ingest_batch(self.asha, {"deviceId": "d", "points": {"seq": 1}}, now=NOW)
        self.assertEqual(ctx.exception.status, 400)


class NamingAndTimeFormatTests(IngestBase):
    def test_snake_case_at_every_level_is_read_like_camel_case(self):
        camel = {
            "deviceId": "dev-c",
            "app": {"version": "1.0", "os": "android", "osVersion": "13", "model": "A"},
            "health": {"permission": "always", "locationEnabled": True, "batteryPct": 40, "powerSave": True},
            "points": pts(1, 2),
            "events": [event(3, "LOW_BATTERY", T0 + timedelta(seconds=30), meta={"levelPct": 14})],
        }
        snake = snake_deep({**camel, "deviceId": "dev-s"})
        a = ingest.ingest_batch(self.asha, camel, now=NOW)
        b = ingest.ingest_batch(self.asha, snake, now=NOW)
        for key in ("accepted", "duplicates", "rejected", "ackSeq"):
            self.assertEqual(a[key], b[key], key)
        self.assertEqual(DutyTrackPoint.objects.filter(device_id="dev-s").count(), 2)
        self.assertEqual(DutyTrackEvent.objects.filter(device_id="dev-s", kind="LOW_BATTERY").count(), 1)
        self.assertEqual(
            DutyTrackEvent.objects.get(device_id="dev-s").meta, {"level_pct": 14}
        )  # the app's own decamelizing
        c, s = (TrackingDevice.objects.get(device_id=d) for d in ("dev-c", "dev-s"))
        for field in (
            "platform",
            "os_version",
            "model",
            "app_version",
            "permission_level",
            "location_enabled",
            "power_save",
            "last_battery_pct",
        ):
            self.assertEqual(getattr(c, field), getattr(s, field), field)

    def test_the_point_fields_are_read_in_both_spellings(self):
        row = {
            "seq": 1,
            "recorded_at": ms(T0),
            "latitude": LAT0,
            "longitude": LNG0,
            "accuracy": 5,
            "speed": 3.2,
            "bearing": 90,
            "altitude": 410.5,
            "activity": "walking",
            "battery": 55,
            "charging": True,
            "network": "wifi",
            "provider": "fused",
            "is_mocked": True,
        }
        self.ingest([row])
        p = DutyTrackPoint.objects.get()
        self.assertEqual(
            (p.speed_mps, p.bearing_deg, p.altitude_m, p.activity, p.battery_pct, p.charging, p.provider, p.is_mock),
            (3.2, 90.0, 410.5, "walking", 55, True, "fused", True),
        )

    def test_time_may_be_epoch_milliseconds_seconds_or_iso(self):
        from zoneinfo import ZoneInfo

        base = T0 + timedelta(seconds=5)
        forms = {
            1: ms(base),
            2: int(base.timestamp()),
            3: base.isoformat(),
            4: base.isoformat().replace("+00:00", "Z"),
            5: str(ms(base)),
            6: base.astimezone(ZoneInfo("Asia/Kolkata")).isoformat(),
        }
        rows = [
            {**point(seq, base), "recordedAt": value, "latitude": LAT0 + seq * 0.0001} for seq, value in forms.items()
        ]
        answer = self.ingest(rows)
        self.assertEqual(answer["accepted"], len(forms), answer)
        for p in DutyTrackPoint.objects.all():
            self.assertEqual(p.recorded_at, base, p.seq)

    def test_a_naive_iso_time_is_read_as_utc(self):
        self.ingest([{**point(1, T0), "recordedAt": "2026-10-28T04:30:00"}])
        self.assertEqual(DutyTrackPoint.objects.get().recorded_at, T0)

    def test_event_times_are_read_in_every_format_too(self):
        evs = [
            event(1, "APP_RESTARTED", T0 + timedelta(seconds=1), startedAt=ms(T0 + timedelta(seconds=1))),
            {"seq": 2, "type": "app_killed", "started_at": (T0 + timedelta(seconds=2)).isoformat()},
        ]
        self.assertEqual(self.ingest([], evs)["accepted"], 2)
        self.assertEqual(
            sorted(DutyTrackEvent.objects.filter(device_id="dev-1").values_list("kind", flat=True)),
            ["APP_KILLED", "APP_RESTARTED"],
        )


class LimitsTests(IngestBase):
    def test_more_than_500_points_is_refused_and_nothing_is_stored(self):
        with self.assertRaises(ingest.BatchError) as ctx:
            self.ingest(pts(1, 501))
        self.assertEqual((ctx.exception.status, ctx.exception.body["code"]), (413, "BATCH_TOO_LARGE"))
        self.assertEqual(DutyTrackPoint.objects.count(), 0)

    def test_more_than_100_events_is_refused(self):
        with self.assertRaises(ingest.BatchError) as ctx:
            self.ingest([], [event(i, "LOW_BATTERY", T0 + timedelta(seconds=i)) for i in range(1, 102)])
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(DutyTrackEvent.objects.filter(kind="LOW_BATTERY").count(), 0)

    def test_exactly_the_limits_are_accepted(self):
        points = pts(1, 500, step_m=5.0, step_s=1)
        events = [event(1000 + i, "LOW_BATTERY", T0 + timedelta(seconds=i)) for i in range(100)]
        answer = self.ingest(points, events)
        self.assertEqual((answer["accepted"], answer["rejected"]), (600, 0))

    def test_a_body_over_a_megabyte_is_refused_before_it_is_read(self):
        big = json.dumps({"deviceId": "d", "points": [], "events": [], "padding": "x" * (1024 * 1024 + 10)})
        r = self.client.post(
            "/api/tracking/batch",
            big,
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {sign_token({'role': 'employee', 'employeeId': self.asha.id})}",
        )
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["code"], "BATCH_TOO_LARGE")


class ConsentAndTrackGateTests(GeoBase):
    def setUp(self):
        super().setUp()
        self.track = self.make_track(self.asha, T0)

    def test_without_an_accepted_notice_the_batch_is_refused(self):
        with self.assertRaises(ingest.BatchError) as ctx:
            ingest.ingest_batch(self.asha, {"deviceId": "d", "points": pts(1, 2)}, now=NOW)
        self.assertEqual((ctx.exception.status, ctx.exception.body["code"]), (403, "CONSENT_REQUIRED"))
        self.assertEqual(ctx.exception.body["noticeVersion"], 1)
        self.assertEqual(DutyTrackPoint.objects.count(), 0)

    def test_over_http_the_refusal_is_a_403_with_the_code(self):
        r = self.batch(self.asha, pts(1, 2))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["code"], "CONSENT_REQUIRED")

    def test_a_consent_for_an_older_notice_version_no_longer_counts(self):
        self.consent(self.asha, version=1)
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"notice_version": 2})
        with self.assertRaises(ingest.BatchError) as ctx:
            ingest.ingest_batch(self.asha, {"deviceId": "d", "points": pts(1, 2)}, now=NOW)
        self.assertEqual(ctx.exception.body["code"], "CONSENT_REQUIRED")
        self.consent(self.asha, version=2)
        self.assertEqual(ingest.ingest_batch(self.asha, {"deviceId": "d", "points": pts(1, 2)}, now=NOW)["accepted"], 2)

    def test_consent_is_per_employee(self):
        self.consent(self.meena)
        self.make_track(self.meena)
        self.assertEqual(
            ingest.ingest_batch(self.meena, {"deviceId": "d", "points": pts(1, 1)}, now=NOW)["accepted"], 1
        )
        with self.assertRaises(ingest.BatchError):
            ingest.ingest_batch(self.asha, {"deviceId": "d", "points": pts(1, 1)}, now=NOW)

    def test_an_employee_with_no_track_gets_not_active_and_nothing_stored(self):
        self.consent(self.ravi)
        answer = ingest.ingest_batch(
            self.ravi, {"deviceId": "d", "points": pts(1, 3), "events": [event(4, "APP_KILLED", T0)]}, now=NOW
        )
        self.assertEqual(
            (answer["trackActive"], answer["accepted"], answer["duplicates"], answer["rejected"], answer["endReason"]),
            (False, 0, 0, 4, None),
        )
        self.assertEqual(answer["ackSeq"], 4)  # nothing can ever be stored: the app drains its queue
        self.assertEqual(
            (DutyTrackPoint.objects.count(), DutyTrackEvent.objects.filter(employee=self.ravi).count()), (0, 0)
        )

    def test_the_no_track_answer_needs_no_consent(self):
        answer = ingest.ingest_batch(self.ravi, {"deviceId": "d", "points": pts(1, 1)}, now=NOW)
        self.assertFalse(answer["trackActive"])

    def test_with_tracking_switched_off_in_the_settings_nothing_is_stored(self):
        self.consent(self.asha)
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"enabled": False})
        answer = ingest.ingest_batch(self.asha, {"deviceId": "d", "points": pts(1, 2)}, now=NOW)
        self.assertEqual((answer["trackActive"], answer["accepted"]), (False, 0))
        self.assertEqual(DutyTrackPoint.objects.count(), 0)

    def test_an_hr_token_cannot_use_the_employee_endpoint(self):
        r = self.as_hr(self.hr_super, "post", "/api/tracking/batch", {"deviceId": "d", "points": []})
        self.assertEqual(r.status_code, 403)


class LateUploadTests(IngestBase):
    def end_at(self, minutes=60):
        end = T0 + timedelta(minutes=minutes)
        DutyTrack.objects.filter(pk=self.track.pk).update(
            status="ended", ended_at=end, end_reason="manual", state="ended"
        )
        return end

    def test_late_points_up_to_five_minutes_after_the_end_are_accepted(self):
        end = self.end_at()
        rows = [
            point(1, end - timedelta(minutes=1), LAT0, LNG0),
            point(2, end, LAT0 + 0.0001, LNG0),
            point(3, end + timedelta(minutes=4, seconds=59), LAT0 + 0.0002, LNG0),
            point(4, end + timedelta(minutes=5, seconds=1), LAT0 + 0.0003, LNG0),
            point(5, end + timedelta(minutes=30), LAT0 + 0.0004, LNG0),
        ]
        answer = self.ingest(rows, now=end + timedelta(hours=1))
        self.assertEqual(
            (answer["accepted"], answer["rejected"], answer["trackActive"], answer["endReason"]),
            (3, 2, False, "manual"),
        )
        self.assertEqual(sorted(DutyTrackPoint.objects.values_list("seq", flat=True)), [1, 2, 3])
        self.assertEqual(self.refresh().points_count, 3)
        self.assertEqual(answer["ackSeq"], 5)

    def test_late_data_rebuilds_the_journey_at_once(self):
        end = self.end_at()
        self.ingest(pts(1, 20, end - timedelta(seconds=190), north0=0.0), now=end + timedelta(minutes=2))
        self.assertGreater(DutyTrack.objects.get(pk=self.track.pk).rebuilt_at, end)
        self.assertEqual(DutyTrackSegment.objects.filter(track=self.track).count(), 2)  # the leading gap and the travel
        self.assertGreater(DutyTrack.objects.get(pk=self.track.pk).distance_m, 0)

    def test_late_events_follow_the_same_window(self):
        end = self.end_at()
        evs = [
            event(1, "APP_KILLED", end - timedelta(seconds=30)),
            event(2, "APP_RESTARTED", end + timedelta(minutes=6)),
        ]
        answer = self.ingest([], evs, now=end + timedelta(minutes=10))
        self.assertEqual((answer["accepted"], answer["rejected"]), (1, 1))

    def test_a_late_batch_does_not_wake_the_ended_track(self):
        end = self.end_at()
        self.ingest(pts(1, 3, end - timedelta(seconds=30)), now=end + timedelta(minutes=1))
        track = self.refresh()
        self.assertEqual(
            (track.status, track.state, track.ended_at, track.end_reason), ("ended", "ended", end, "manual")
        )

    def test_points_before_the_track_started_get_two_minutes_of_slack(self):
        answer = self.ingest(
            [point(1, T0 - timedelta(minutes=1)), point(2, T0 - timedelta(minutes=3), LAT0 + 0.001, LNG0)], now=NOW
        )
        self.assertEqual((answer["accepted"], answer["rejected"]), (1, 1))

    def test_rows_go_to_the_track_their_time_belongs_to(self):
        end = self.end_at(60)
        second = self.make_track(self.asha, T0 + timedelta(minutes=90))
        rows = [
            point(1, end - timedelta(minutes=2), LAT0, LNG0),  # the first track
            point(2, end + timedelta(minutes=3), LAT0 + 0.0001, LNG0),  # its grace window
            point(3, end + timedelta(minutes=20), LAT0 + 0.0002, LNG0),  # between the tracks: nobody's
            point(4, T0 + timedelta(minutes=89), LAT0 + 0.0003, LNG0),  # 1 minute before the second started: its slack
            point(5, T0 + timedelta(minutes=95), LAT0 + 0.0004, LNG0),  # the second track
        ]
        answer = self.ingest(rows, now=T0 + timedelta(minutes=100))
        self.assertEqual((answer["accepted"], answer["rejected"], answer["trackActive"]), (4, 1, True))
        by_track = {}
        for p in DutyTrackPoint.objects.all():
            by_track.setdefault(p.track_id, []).append(p.seq)
        self.assertEqual({k: sorted(v) for k, v in by_track.items()}, {self.track.pk: [1, 2], second.pk: [4, 5]})
        self.assertEqual((self.refresh().points_count, DutyTrack.objects.get(pk=second.pk).points_count), (2, 2))


class EventPairingTests(IngestBase):
    def events(self, track=None):
        return list(
            DutyTrackEvent.objects.filter(track=track or self.track)
            .exclude(kind="TRACKING_STARTED")
            .order_by("started_at", "id")
        )

    def test_an_interval_event_is_stored_open_and_closed_by_its_end_event(self):
        pairs = [
            ("GPS_OFF", "GPS_ON"),
            ("NETWORK_LOST", "NETWORK_RESTORED"),
            ("AIRPLANE_ON", "AIRPLANE_OFF"),
            ("POWER_SAVE_ON", "POWER_SAVE_OFF"),
        ]
        seq = 1
        for start_kind, end_kind in pairs:
            a, b = T0 + timedelta(seconds=seq * 10), T0 + timedelta(seconds=seq * 10 + 200)
            answer = self.ingest([], [event(seq, start_kind, a)], now=NOW)
            self.assertEqual(answer["accepted"], 1)
            open_row = DutyTrackEvent.objects.get(track=self.track, kind=start_kind)
            self.assertIsNone(open_row.ended_at, start_kind)
            answer = self.ingest([], [event(seq + 1, end_kind, b)], now=NOW)
            self.assertEqual((answer["accepted"], answer["duplicates"]), (1, 0))
            open_row.refresh_from_db()
            self.assertEqual(open_row.ended_at, b, start_kind)
            seq += 2
        # no row was ever stored for an END kind
        self.assertFalse(
            DutyTrackEvent.objects.filter(
                kind__in=["GPS_ON", "NETWORK_RESTORED", "AIRPLANE_OFF", "POWER_SAVE_OFF"]
            ).exists()
        )
        self.assertEqual(self.refresh().events_count, 4)  # one row per interval

    def test_start_and_end_in_the_same_batch_pair_up(self):
        a, b = T0 + timedelta(seconds=50), T0 + timedelta(seconds=300)
        answer = self.ingest([], [event(2, "GPS_ON", b), event(1, "GPS_OFF", a)])  # even out of order
        self.assertEqual((answer["accepted"], answer["rejected"]), (2, 0))
        (row,) = self.events()
        self.assertEqual((row.kind, row.started_at, row.ended_at), ("GPS_OFF", a, b))
        self.assertEqual(self.refresh().events_count, 1)  # the END event is not a row of its own

    def test_an_end_with_no_open_start_is_a_zero_length_event(self):
        at = T0 + timedelta(seconds=77)
        answer = self.ingest([], [event(9, "GPS_ON", at)])
        self.assertEqual(answer["accepted"], 1)
        (row,) = self.events()
        self.assertEqual((row.kind, row.started_at, row.ended_at, row.seq), ("GPS_OFF", at, at, 9))
        self.assertTrue(row.meta["unpaired"])
        self.assertEqual(row.meta["endKind"], "GPS_ON")

    def test_an_end_that_comes_before_the_open_start_does_not_close_it(self):
        self.ingest([], [event(1, "GPS_OFF", T0 + timedelta(seconds=100))])
        self.ingest([], [event(2, "GPS_ON", T0 + timedelta(seconds=50))])
        rows = self.events()
        self.assertEqual(len(rows), 2)
        self.assertIsNone([r for r in rows if r.seq == 1][0].ended_at)

    def test_a_second_start_while_one_is_open_is_a_duplicate(self):
        self.ingest([], [event(1, "GPS_OFF", T0 + timedelta(seconds=10))])
        answer = self.ingest([], [event(2, "GPS_OFF", T0 + timedelta(seconds=40))])
        self.assertEqual((answer["accepted"], answer["duplicates"]), (0, 1))
        self.assertEqual(len(self.events()), 1)

    def test_the_end_closes_the_latest_open_interval_of_its_own_kind_only(self):
        self.ingest(
            [], [event(1, "GPS_OFF", T0 + timedelta(seconds=10)), event(2, "NETWORK_LOST", T0 + timedelta(seconds=20))]
        )
        self.ingest([], [event(3, "NETWORK_RESTORED", T0 + timedelta(seconds=60))])
        gps, net = DutyTrackEvent.objects.get(kind="GPS_OFF"), DutyTrackEvent.objects.get(kind="NETWORK_LOST")
        self.assertIsNone(gps.ended_at)
        self.assertEqual(net.ended_at, T0 + timedelta(seconds=60))

    def test_a_resent_end_event_is_a_duplicate_and_adds_nothing(self):
        self.ingest([], [event(1, "GPS_OFF", T0 + timedelta(seconds=10))])
        end = [event(2, "GPS_ON", T0 + timedelta(seconds=90))]
        self.assertEqual(self.ingest([], end)["accepted"], 1)
        again = self.ingest([], end)
        self.assertEqual((again["accepted"], again["duplicates"], again["ackSeq"]), (0, 1, 2))
        self.assertEqual(len(self.events()), 1)

    def test_a_resent_start_event_is_a_duplicate(self):
        start = [event(1, "APP_KILLED", T0 + timedelta(seconds=10))]
        self.ingest([], start)
        self.assertEqual(self.ingest([], start)["duplicates"], 1)
        self.assertEqual(len(self.events()), 1)

    def test_point_events_are_stored_with_their_place_and_meta(self):
        e = event(
            1,
            "PERMISSION_CHANGED",
            T0 + timedelta(seconds=30),
            latitude=LAT0,
            longitude=LNG0,
            meta={"from": "always", "to": "while_using"},
        )
        self.ingest([], [e])
        (row,) = self.events()
        self.assertEqual(
            (row.kind, row.source, row.ended_at, row.meta, float(row.latitude)),
            ("PERMISSION_CHANGED", "device", None, {"from": "always", "to": "while_using"}, LAT0),
        )

    def test_every_device_kind_is_accepted_and_the_server_only_ones_are_not(self):
        kinds = list(DutyTrackEvent.DEVICE_KINDS)
        evs = [event(i + 1, kind, T0 + timedelta(seconds=10 * i)) for i, kind in enumerate(kinds)]
        self.assertEqual(self.ingest([], evs)["accepted"], len(kinds))
        refused = self.ingest(
            [], [event(100, "SIGNAL_LOST", T0), event(101, "SERVER_NOTE", T0), event(102, "NOT_A_KIND", T0)]
        )
        self.assertEqual((refused["accepted"], refused["rejected"]), (0, 3))

    def test_a_bad_coordinate_on_an_event_is_dropped_not_the_event(self):
        self.ingest([], [event(1, "LOW_BATTERY", T0 + timedelta(seconds=5), latitude=500, longitude=LNG0)])
        (row,) = self.events()
        self.assertEqual((row.latitude, row.longitude), (None, None))

    def test_oversized_meta_is_replaced_by_a_marker(self):
        self.ingest([], [event(1, "MOCK_LOCATION", T0 + timedelta(seconds=5), meta={"blob": "x" * 5000})])
        self.assertEqual(self.events()[0].meta, {"truncated": True})

    def test_a_closed_interval_sent_whole_is_stored_closed(self):
        a, b = T0 + timedelta(seconds=10), T0 + timedelta(seconds=70)
        self.ingest([], [event(1, "NETWORK_LOST", a, endedAt=ms(b))])
        (row,) = self.events()
        self.assertEqual((row.started_at, row.ended_at), (a, b))

    def test_an_interval_still_open_when_the_track_ends_is_closed_by_end_track(self):
        from .geo_tracking import sessions

        self.ingest([], [event(1, "GPS_OFF", T0 + timedelta(seconds=10))])
        end = T0 + timedelta(minutes=30)
        sessions.end_track(self.track, "manual", now=end)
        self.assertEqual(DutyTrackEvent.objects.get(kind="GPS_OFF").ended_at, end)

    def test_events_only_batches_update_the_device_and_the_state(self):
        answer = self.ingest(
            [],
            [event(1, "GPS_OFF", T0 + timedelta(seconds=10))],
            health={"permission": "denied", "locationEnabled": False},
        )
        self.assertEqual(answer["accepted"], 1)
        track = self.refresh()
        self.assertEqual(track.state, "location_off")
        self.assertEqual(track.state_since, T0 + timedelta(seconds=10))
        self.assertEqual(TrackingDevice.objects.get().permission_level, "denied")


class SnapshotAndStateTests(IngestBase):
    def test_the_snapshot_follows_the_newest_point_not_the_last_in_the_batch(self):
        rows = list(reversed(pts(1, 4)))  # newest first
        self.ingest(rows)
        track = self.refresh()
        self.assertEqual(track.last_point_at, T0 + timedelta(seconds=30))
        self.assertAlmostEqual(float(track.last_latitude), offset_latlng(LAT0, LNG0, 60.0, 0.0)[0], places=5)

    def test_an_older_late_batch_does_not_move_the_snapshot_back(self):
        self.ingest(pts(10, 3, T0 + timedelta(minutes=5)))
        self.ingest(pts(1, 3, T0))
        self.assertEqual(self.refresh().last_point_at, T0 + timedelta(minutes=5, seconds=20))
        self.assertEqual(DutyTrackPoint.objects.count(), 6)

    def test_batches_arriving_out_of_order_keep_exact_counters(self):
        self.ingest(pts(11, 5, T0 + timedelta(minutes=2)))
        self.ingest(pts(1, 5, T0))
        self.assertEqual(self.refresh().points_count, 10)
        self.assertEqual(DutyTrackPoint.objects.filter(track=self.track).count(), 10)

    def test_the_state_is_moving_while_travelling_and_stationary_after_a_long_dwell(self):
        self.ingest(pts(1, 10, step_m=150.0), now=T0 + timedelta(seconds=100))
        self.assertEqual(self.refresh().state, "moving")
        place = offset_latlng(LAT0, LNG0, 1350.0, 0.0)
        dwell = [point(100 + k, T0 + timedelta(seconds=100 + 10 * k), place[0], place[1]) for k in range(30)]
        self.ingest(dwell, now=T0 + timedelta(seconds=400))
        track = self.refresh()
        self.assertEqual(track.state, "stationary")
        self.assertEqual(
            track.state_since, T0 + timedelta(seconds=90)
        )  # the stop reaches back to the drive's last fix, at the same place

    def test_a_point_in_the_future_is_flagged_and_does_not_push_the_snapshot_past_now(self):
        row = point(1, NOW + timedelta(minutes=30))
        self.ingest([row])
        self.assertTrue(DutyTrackPoint.objects.get().time_suspect)
        self.assertEqual(self.refresh().last_point_at, NOW)

    def test_a_far_off_client_clock_flags_every_row_of_the_batch(self):
        self.ingest(pts(1, 3), clientTime=ms(NOW - timedelta(hours=2)))
        self.assertEqual(DutyTrackPoint.objects.filter(time_suspect=True).count(), 3)
        self.ingest(pts(10, 3, T0 + timedelta(seconds=40)), device="dev-2", clientTime=ms(NOW + timedelta(seconds=30)))
        self.assertEqual(DutyTrackPoint.objects.filter(time_suspect=False).count(), 3)

    def test_a_signal_lost_event_is_closed_when_data_arrives_again(self):
        lost = DutyTrackEvent.objects.create(
            track=self.track,
            employee=self.asha,
            kind="SIGNAL_LOST",
            source="server",
            started_at=T0 + timedelta(minutes=1),
        )
        self.ingest(pts(1, 2, T0 + timedelta(minutes=15)))
        lost.refresh_from_db()
        self.assertEqual(lost.ended_at, NOW)

    def test_health_values_that_are_missing_do_not_blank_what_is_known(self):
        self.ingest(
            pts(1, 1), app={"version": "1.0", "model": "Pixel"}, health={"permission": "always", "batteryPct": 50}
        )
        self.ingest(pts(2, 1, T0 + timedelta(seconds=10)), app={}, health={})
        d = TrackingDevice.objects.get()
        self.assertEqual(
            (d.app_version, d.model, d.permission_level, d.last_battery_pct), ("1.0", "Pixel", "always", 50)
        )

    def test_permission_spellings_are_normalised(self):
        for given, stored in [
            ("when_in_use", "while_using"),
            ("granted_always", "always"),
            ("Denied", "denied"),
            ("???", "unknown"),
        ]:
            self.ingest([], health={"permission": given})
            self.assertEqual(TrackingDevice.objects.get().permission_level, stored, given)


class RebuildSchedulingTests(IngestBase):
    def test_the_first_batch_rebuilds_and_the_next_ones_wait_thirty_seconds(self):
        self.ingest(pts(1, 20), now=NOW)
        first = self.refresh().rebuilt_at
        self.assertEqual(first, NOW)
        self.ingest(pts(30, 20, T0 + timedelta(minutes=5)), now=NOW + timedelta(seconds=10))
        self.assertEqual(self.refresh().rebuilt_at, first)  # throttled
        self.ingest(pts(60, 20, T0 + timedelta(minutes=8)), now=NOW + timedelta(seconds=31))
        self.assertEqual(self.refresh().rebuilt_at, NOW + timedelta(seconds=31))

    def test_a_batch_with_only_duplicates_does_not_rebuild(self):
        self.ingest(pts(1, 5), now=NOW)
        DutyTrack.objects.filter(pk=self.track.pk).update(rebuilt_at=None)
        self.ingest(pts(1, 5), now=NOW + timedelta(minutes=5))
        self.assertIsNone(self.refresh().rebuilt_at)

    def test_a_big_track_rebuilds_in_the_background_and_not_inside_the_request(self):
        DutyTrack.objects.filter(pk=self.track.pk).update(points_count=ingest.INLINE_REBUILD_MAX_POINTS + 1)
        with (
            mock.patch.object(background, "inline_mode", return_value=False),
            mock.patch.object(background, "run_job") as run_job,
        ):
            self.ingest(pts(1, 3), now=NOW)
        run_job.assert_called_once()
        self.assertIs(run_job.call_args.args[1], background.rebuild_job)
        self.assertIsNone(self.refresh().rebuilt_at)

    def test_a_failing_rebuild_never_fails_the_batch(self):
        with mock.patch("api.geo_tracking.journey.rebuild", side_effect=RuntimeError("boom")):
            answer = self.ingest(pts(1, 3))
        self.assertEqual(answer["accepted"], 3)


class ConcurrencyTests(TransactionTestCase):
    """Two real connections: batches that overlap, and a batch racing end_track, must leave exact counters."""

    def setUp(self):
        from .models import Department

        self.dept = Department.objects.create(name="Race")
        self.emp = Employee.objects.create(
            employee_code="RC1",
            first_name="Race",
            last_name="Car",
            status="active",
            employment_type="staff",
            join_date="2020-01-01",
        )
        self.session = OnDutySession.objects.create(employee=self.emp, destination="Far", status="pending_hod")
        self.track = DutyTrack.objects.create(session=self.session, employee=self.emp, started_at=T0, state_since=T0)
        TrackingConsent.objects.create(employee=self.emp, device_id="d", notice_version=1)

    def run_threads(self, *targets):
        errors = []
        barrier = threading.Barrier(len(targets))

        def wrap(fn):
            def runner():
                try:
                    barrier.wait(timeout=10)
                    fn()
                except Exception as exc:  # noqa: BLE001 - reported below
                    errors.append(exc)
                finally:
                    connection.close()

            return runner

        threads = [threading.Thread(target=wrap(t)) for t in targets]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertEqual(errors, [])

    def test_two_overlapping_batches_never_double_count(self):
        batch = pts(1, 120, step_m=10.0, step_s=5)
        other = pts(
            61, 120, T0 + timedelta(seconds=300), north0=600.0, step_m=10.0, step_s=5
        )  # seq 61..180 overlap 61..120

        def send(rows):
            return lambda: ingest.ingest_batch(self.emp, {"deviceId": "d", "points": rows}, now=NOW)

        self.run_threads(send(batch), send(other))
        stored = DutyTrackPoint.objects.filter(track=self.track).count()
        self.assertEqual(stored, 180)
        self.assertEqual(DutyTrack.objects.get(pk=self.track.pk).points_count, 180)

    def test_a_batch_racing_end_track_keeps_the_counters_exact(self):
        from .geo_tracking import sessions

        rows = pts(1, 200, T0 + timedelta(seconds=600), step_m=10.0, step_s=5)

        def send():
            ingest.ingest_batch(self.emp, {"deviceId": "d", "points": rows}, now=T0 + timedelta(hours=2))

        def finish():
            sessions.end_track(DutyTrack.objects.get(pk=self.track.pk), "manual", now=T0 + timedelta(minutes=30))

        self.run_threads(send, finish)
        track = DutyTrack.objects.get(pk=self.track.pk)
        self.assertEqual(track.status, "ended")
        self.assertEqual(track.points_count, DutyTrackPoint.objects.filter(track=track).count())
        # whichever won the race: rows later than ended_at + 5 min were refused if the end came first
        late = DutyTrackPoint.objects.filter(track=track, recorded_at__gt=track.ended_at + timedelta(minutes=5)).count()
        if late:
            self.assertEqual(track.points_count, 200)  # the batch won: they were accepted before the end
        self.assertEqual(DutyTrackEvent.objects.filter(track=track, kind="TRACKING_STOPPED").count(), 1)

    def test_concurrent_rebuilds_leave_one_consistent_set_of_segments(self):
        from .geo_tracking import journey
        from .models import DutyTrackSegment

        rows = pts(
            1, 300, step_m=100.0, step_s=10
        )  # a long drive: a few polylines, quick to compute, slow enough to overlap
        DutyTrackPoint.objects.bulk_create(
            [
                DutyTrackPoint(
                    track=self.track,
                    employee=self.emp,
                    device_id="d",
                    seq=r["seq"],
                    recorded_at=T0 + timedelta(seconds=10 * i),
                    latitude=r["latitude"],
                    longitude=r["longitude"],
                    accuracy_m=8,
                )
                for i, r in enumerate(rows)
            ]
        )

        def rebuild_a_few_times():
            for _ in range(4):
                journey.rebuild(self.track.pk)

        self.run_threads(rebuild_a_few_times, rebuild_a_few_times, rebuild_a_few_times)
        segments = list(
            DutyTrackSegment.objects.filter(track=self.track).order_by("seq_no").values_list("seq_no", "kind")
        )
        self.assertEqual(segments, [(1, "travel")])
