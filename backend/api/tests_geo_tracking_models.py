"""Geo-Tracking: the tables, their constraints, indexes and defaults (migration 0132_geo_tracking).

Run:  DB_NAME=uktex_fix_geo python manage.py test api.tests_geo_tracking_models --noinput
"""

from datetime import timedelta
from datetime import time as dtime

from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.test import TestCase

from .models import (
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    DutyTrackSegment,
    GeoTrackingSettings,
    OnDutyPunchVerification,
    OnDutySession,
    TrackingConsent,
    TrackingDevice,
)
from .tests_geo_tracking_support import LAT0, LNG0, T0, GeoBase


def _constraints(table: str) -> dict:
    with connection.cursor() as cursor:
        return connection.introspection.get_constraints(cursor, table)


class TableShapeTests(TestCase):
    def test_table_names_are_the_ones_the_spec_fixes(self):
        names = {
            GeoTrackingSettings: "geo_tracking_settings",
            DutyTrack: "duty_tracks",
            DutyTrackPoint: "duty_track_points",
            DutyTrackEvent: "duty_track_events",
            DutyTrackSegment: "duty_track_segments",
            TrackingDevice: "tracking_devices",
            TrackingConsent: "tracking_consents",
        }
        for model, table in names.items():
            self.assertEqual(model._meta.db_table, table)
            self.assertIn(table, connection.introspection.table_names())

    def test_there_are_no_model_changes_the_migration_does_not_cover(self):
        call_command("makemigrations", "api", check=True, dry_run=True, verbosity=0)

    def test_the_active_track_unique_index_is_partial_on_employee(self):
        found = [c for c in _constraints("duty_tracks").values() if c["unique"] and c["columns"] == ["employee_id"]]
        self.assertEqual(len(found), 1)
        with connection.cursor() as cursor:
            cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_active_duty_track_per_employee'")
            definition = cursor.fetchone()[0]
        self.assertIn("WHERE", definition)
        self.assertIn("'active'", definition)

    def test_the_indexes_the_spec_lists_exist_with_their_columns(self):
        by_name = {name: c["columns"] for name, c in _constraints("duty_tracks").items() if c["index"]}
        self.assertEqual(by_name["duty_track_emp_started"], ["employee_id", "started_at"])
        self.assertEqual(by_name["duty_track_status"], ["status"])
        self.assertEqual(by_name["duty_track_started"], ["started_at"])
        self.assertEqual(by_name["duty_track_branch_started"], ["branch_id", "started_at"])
        points = {name: c["columns"] for name, c in _constraints("duty_track_points").items() if c["index"]}
        self.assertEqual(points["track_point_track_rec"], ["track_id", "recorded_at"])
        self.assertEqual(points["track_point_emp_rec"], ["employee_id", "recorded_at"])
        events = {name: c["columns"] for name, c in _constraints("duty_track_events").items() if c["index"]}
        self.assertEqual(events["track_event_track_start"], ["track_id", "started_at"])
        self.assertEqual(events["track_event_track_kind"], ["track_id", "kind"])
        segments = {name: c["columns"] for name, c in _constraints("duty_track_segments").items() if c["index"]}
        self.assertEqual(segments["track_segment_track_start"], ["track_id", "started_at"])

    def test_the_point_and_segment_uniques_cover_the_spec_columns(self):
        uniques = lambda table: {tuple(c["columns"]) for c in _constraints(table).values() if c["unique"]}
        self.assertIn(("employee_id", "device_id", "seq"), uniques("duty_track_points"))
        self.assertIn(("employee_id", "device_id", "seq"), uniques("duty_track_events"))
        self.assertIn(("track_id", "seq_no"), uniques("duty_track_segments"))
        self.assertIn(("employee_id", "device_id"), uniques("tracking_devices"))
        self.assertIn(("session_id",), uniques("duty_tracks"))

    def test_the_event_unique_ignores_events_without_a_seq(self):
        with connection.cursor() as cursor:
            cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_track_event_device_seq'")
            definition = cursor.fetchone()[0]
        self.assertIn("seq IS NOT NULL", definition)

    def test_time_columns_are_timezone_aware_and_coordinates_are_decimal_9_6(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns "
                "WHERE table_name IN ('duty_tracks','duty_track_points','duty_track_events','duty_track_segments','tracking_devices',"
                "'tracking_consents','geo_tracking_settings') AND data_type IN ('timestamp with time zone','timestamp without time zone','numeric')"
            )
            rows = cursor.fetchall()
        self.assertTrue(rows)
        for table, column, data_type, precision, scale in rows:
            self.assertNotEqual(data_type, "timestamp without time zone", f"{table}.{column}")
            if data_type == "numeric":
                self.assertEqual((precision, scale), (9, 6), f"{table}.{column}")

    def test_every_new_table_has_created_at_except_the_singleton_which_has_updated_at(self):
        for model in (DutyTrack, DutyTrackPoint, DutyTrackEvent, DutyTrackSegment, TrackingDevice, TrackingConsent):
            names = {f.name for f in model._meta.get_fields()}
            self.assertTrue({"created_at", "received_at"} & names, model.__name__)
        self.assertIn("updated_at", {f.name for f in GeoTrackingSettings._meta.get_fields()})

    def test_photo2_is_a_nullable_file_column_on_the_punch_verification(self):
        field = OnDutyPunchVerification._meta.get_field("photo2")
        self.assertTrue(field.null)
        self.assertTrue(field.blank)
        self.assertEqual(field.upload_to, OnDutyPunchVerification._meta.get_field("photo").upload_to)
        self.assertEqual(field.db_column, "photo2")


class SettingsDefaultsTests(TestCase):
    def test_get_creates_the_one_row_with_the_owner_defaults(self):
        s = GeoTrackingSettings.get()
        self.assertEqual(s.pk, 1)
        self.assertEqual(
            (
                s.enabled,
                s.stop_seconds,
                s.stop_radius_m,
                s.stop_accuracy_factor,
                s.merge_stop_gap_seconds,
                s.gap_seconds,
            ),
            (True, 180, 50, 2.0, 120, 300),
        )
        self.assertEqual((s.signal_lost_seconds, s.max_accuracy_m, s.max_speed_kmh), (600, 100, 200))
        self.assertEqual((s.sample_moving_seconds, s.sample_still_seconds, s.distance_filter_m), (3, 60, 10))
        self.assertEqual((s.upload_batch_points, s.upload_interval_seconds, s.retention_days), (30, 60, 365))
        self.assertEqual(s.day_end_time, dtime(23, 50))
        self.assertEqual((s.onduty_punch_photos, s.notice_version, s.reverse_geocode_provider), (1, 1, "off"))
        self.assertTrue(s.notice_text.strip())
        self.assertEqual(GeoTrackingSettings.get().pk, 1)
        self.assertEqual(GeoTrackingSettings.objects.count(), 1)

    def test_a_raw_insert_that_names_no_columns_still_works_because_of_the_database_defaults(self):
        with connection.cursor() as cursor:
            cursor.execute("INSERT INTO geo_tracking_settings (id) VALUES (7)")
            cursor.execute(
                "SELECT stop_seconds, day_end_time, reverse_geocode_provider FROM geo_tracking_settings WHERE id = 7"
            )
            self.assertEqual(cursor.fetchone(), (180, dtime(23, 50), "off"))


class ConstraintTests(GeoBase):
    def test_an_old_release_can_insert_a_punch_verification_without_photo2(self):
        session = self.make_session(self.asha)
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO on_duty_punch_verifications (session_id, employee_id, punch_date, punch_time, punch_type, punch_number, "
                "latitude, longitude, is_mocked, photo, status, created_at) VALUES (%s, %s, '2026-10-28', '10:00:00', 'IN', 1, "
                "11.0, 77.0, false, 'x.jpg', 'pending', now())",
                [session.pk, self.asha.pk],
            )
        self.assertFalse(OnDutyPunchVerification.objects.get(session=session).photo2)

    def test_an_employee_cannot_have_two_active_tracks(self):
        self.make_track(self.asha)
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_track(self.asha, T0 + timedelta(hours=1))

    def test_an_ended_track_does_not_block_a_new_active_one_and_other_employees_are_free(self):
        self.make_track(self.asha, ended_at=T0 + timedelta(hours=1))
        self.make_track(self.asha, T0 + timedelta(hours=2))
        self.make_track(self.meena)
        self.assertEqual(DutyTrack.objects.filter(status="active").count(), 2)

    def test_a_session_has_at_most_one_track(self):
        track = self.make_track(self.asha, ended_at=T0 + timedelta(hours=1))
        with self.assertRaises(IntegrityError), transaction.atomic():
            DutyTrack.objects.create(session=track.session, employee=self.asha, started_at=T0 + timedelta(hours=3))

    def test_a_point_is_unique_per_employee_device_and_seq(self):
        track = self.make_track(self.asha)
        base = dict(track=track, employee=self.asha, device_id="d1", recorded_at=T0, latitude=LAT0, longitude=LNG0)
        DutyTrackPoint.objects.create(seq=1, **base)
        with self.assertRaises(IntegrityError), transaction.atomic():
            DutyTrackPoint.objects.create(seq=1, **base)
        DutyTrackPoint.objects.create(seq=2, **base)  # another seq
        DutyTrackPoint.objects.create(seq=1, **{**base, "device_id": "d2"})  # another device
        DutyTrackPoint.objects.create(seq=1, **{**base, "employee": self.meena, "track": self.make_track(self.meena)})

    def test_bulk_create_with_ignore_conflicts_drops_the_duplicate_silently(self):
        track = self.make_track(self.asha)
        base = dict(track=track, employee=self.asha, device_id="d1", recorded_at=T0, latitude=LAT0, longitude=LNG0)
        DutyTrackPoint.objects.bulk_create(
            [DutyTrackPoint(seq=5, **base), DutyTrackPoint(seq=6, **base)], ignore_conflicts=True
        )
        DutyTrackPoint.objects.bulk_create(
            [DutyTrackPoint(seq=6, **base), DutyTrackPoint(seq=7, **base)], ignore_conflicts=True
        )
        self.assertEqual(sorted(DutyTrackPoint.objects.values_list("seq", flat=True)), [5, 6, 7])

    def test_events_are_unique_per_device_seq_but_server_events_without_a_seq_repeat_freely(self):
        track = self.make_track(self.asha)
        base = dict(track=track, employee=self.asha, kind="APP_KILLED", started_at=T0)
        DutyTrackEvent.objects.create(device_id="d1", seq=3, **base)
        with self.assertRaises(IntegrityError), transaction.atomic():
            DutyTrackEvent.objects.create(device_id="d1", seq=3, **base)
        DutyTrackEvent.objects.create(device_id="", seq=None, source="server", **base)
        DutyTrackEvent.objects.create(device_id="", seq=None, source="server", **base)
        self.assertEqual(DutyTrackEvent.objects.count(), 3)

    def test_segment_numbers_are_unique_within_a_track(self):
        track = self.make_track(self.asha)
        base = dict(track=track, kind="stop", started_at=T0, ended_at=T0 + timedelta(minutes=5))
        DutyTrackSegment.objects.create(seq_no=1, **base)
        with self.assertRaises(IntegrityError), transaction.atomic():
            DutyTrackSegment.objects.create(seq_no=1, **base)
        DutyTrackSegment.objects.create(seq_no=2, **base)

    def test_a_device_is_unique_per_employee(self):
        TrackingDevice.objects.create(employee=self.asha, device_id="d1")
        with self.assertRaises(IntegrityError), transaction.atomic():
            TrackingDevice.objects.create(employee=self.asha, device_id="d1")
        TrackingDevice.objects.create(employee=self.meena, device_id="d1")

    def test_deleting_a_track_deletes_its_rows_and_deleting_the_session_deletes_the_track(self):
        track = self.make_track(self.asha)
        DutyTrackPoint.objects.create(
            track=track, employee=self.asha, device_id="d", seq=1, recorded_at=T0, latitude=LAT0, longitude=LNG0
        )
        DutyTrackEvent.objects.create(track=track, employee=self.asha, kind="GPS_OFF", started_at=T0)
        DutyTrackSegment.objects.create(
            track=track, seq_no=1, kind="gap", started_at=T0, ended_at=T0 + timedelta(minutes=6)
        )
        track.session.delete()
        self.assertEqual(
            [
                DutyTrack.objects.count(),
                DutyTrackPoint.objects.count(),
                DutyTrackEvent.objects.count(),
                DutyTrackSegment.objects.count(),
            ],
            [0, 0, 0, 0],
        )

    def test_a_deleted_event_leaves_the_segment_it_explained(self):
        track = self.make_track(self.asha)
        ev = DutyTrackEvent.objects.create(track=track, employee=self.asha, kind="GPS_OFF", started_at=T0)
        seg = DutyTrackSegment.objects.create(
            track=track, seq_no=1, kind="gap", started_at=T0, ended_at=T0 + timedelta(minutes=6), event=ev
        )
        ev.delete()
        seg.refresh_from_db()
        self.assertIsNone(seg.event_id)

    def test_column_defaults_of_a_fresh_track(self):
        track = self.make_track(self.asha)
        track.refresh_from_db()
        self.assertEqual(
            (track.state, track.points_count, track.events_count, track.mock_points), ("waiting_first_fix", 0, 0, 0)
        )
        self.assertEqual(
            (track.distance_m, track.travel_s, track.stop_s, track.gap_s, track.stop_count), (0, 0, 0, 0, 0)
        )
        self.assertEqual(track.flags, {})
        self.assertEqual(track.end_reason, "")
        self.assertEqual(OnDutySession.objects.get(pk=track.session_id).track.pk, track.pk)
