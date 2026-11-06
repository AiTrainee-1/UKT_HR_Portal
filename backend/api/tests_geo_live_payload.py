"""Geo Attendance: what the Live Map's refreshes cost the server.

The Live Map reads /tracking/live and /live-location/team every 20 s, the sidebar badge reads the pending punch verifications
on every HR page, and the On-Duty Map reads the day map every 20 s. None of them shows an employee's photo (a base64 data URL
of up to ~2 MB per employee), so none may load it; and the old live feed reads every employee's newest ping in one query
instead of one query per employee.

Run:  DATABASE_URL= DB_TEST_NAME=uktex_test_geo_ui py -3 manage.py test api.tests_geo_live_payload --noinput
"""

from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .models import LiveLocationPing
from .tests_geo_tracking_support import T0, GeoBase

PHOTO = "data:image/jpeg;base64," + "A" * 20_000


def ping(emp, lat, lng, minutes_ago, mocked=False):
    p = LiveLocationPing.objects.create(employee=emp, latitude=lat, longitude=lng, accuracy_m=9, is_mocked=mocked)
    LiveLocationPing.objects.filter(pk=p.pk).update(recorded_at=timezone.now() - timedelta(minutes=minutes_ago))
    return p


class NoPhotoInTheRefreshesTests(GeoBase):
    def setUp(self):
        super().setUp()
        for emp in (self.asha, self.meena, self.ravi):
            emp.photo_url = PHOTO
            emp.location_tracking_enabled = True
            emp.save(update_fields=["photo_url", "location_tracking_enabled"])
        self.make_track(self.asha, T0, last_point_at=T0 + timedelta(minutes=5), last_latitude=11.1, last_longitude=77.3)
        self.make_track(self.ravi, T0, last_point_at=T0 + timedelta(minutes=6), last_latitude=11.2, last_longitude=77.4)

    def sql_of(self, url, **params):
        with CaptureQueriesContext(connection) as queries:
            res = self.as_hr(self.hr_super, "get", url, **params)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res, " ".join(q["sql"] for q in queries.captured_queries)

    def test_the_live_board_does_not_load_photos(self):
        res, sql = self.sql_of("/api/tracking/live")
        self.assertEqual(len(res.json()), 2)
        self.assertNotIn("photo_url", sql)
        self.assertNotIn(PHOTO[:40], res.content.decode())

    def test_the_day_map_and_the_journey_list_do_not_load_photos(self):
        res, sql = self.sql_of("/api/tracking/journeys/day-map", date="2026-10-28")
        self.assertEqual(len(res.json()["journeys"]), 2)
        self.assertNotIn("photo_url", sql)
        res, sql = self.sql_of("/api/tracking/journeys")
        self.assertEqual(res.json()["total"], 2)
        self.assertNotIn("photo_url", sql)

    def test_one_journey_does_not_load_the_photo(self):
        track = self.make_track(self.meena, T0)
        res, sql = self.sql_of(f"/api/tracking/journeys/{track.pk}")
        self.assertEqual(res.json()["track"]["employeeName"], "Meena Devi")
        self.assertNotIn("photo_url", sql)

    def test_the_pending_punch_list_does_not_load_photos(self):
        _res, sql = self.sql_of("/api/on-duty-punch-verifications", status="pending")
        self.assertIn("on_duty_punch_verifications", sql)
        self.assertNotIn("photo_url", sql)


class OldLiveFeedTests(GeoBase):
    def setUp(self):
        super().setUp()
        for emp in (self.asha, self.meena, self.ravi):
            emp.location_tracking_enabled = True
            emp.photo_url = PHOTO
            emp.save(update_fields=["location_tracking_enabled", "photo_url"])

    def team(self, user=None):
        with CaptureQueriesContext(connection) as queries:
            res = self.as_hr(user or self.hr_super, "get", "/api/live-location/team")
        self.assertEqual(res.status_code, 200)
        return res.json(), queries

    def test_each_employee_gets_their_newest_ping_and_none_without_one(self):
        ping(self.asha, 11.10, 77.30, 30)
        ping(self.asha, 11.11, 77.31, 2, mocked=True)  # the newest
        ping(self.ravi, 11.20, 77.40, 10)
        ping(self.ravi, 11.29, 77.49, 60 * 30)  # older than the retention window: never shown
        body, _ = self.team()
        by_code = {r["employeeCode"]: r for r in body}
        self.assertEqual(set(by_code), {"G1", "G2", "G3"})
        self.assertEqual((by_code["G1"]["latitude"], by_code["G1"]["longitude"]), (11.11, 77.31))
        self.assertTrue(by_code["G1"]["isMocked"])
        self.assertEqual((by_code["G3"]["latitude"], by_code["G3"]["longitude"]), (11.2, 77.4))
        self.assertIsNone(by_code["G2"]["latitude"])
        self.assertIsNone(by_code["G2"]["lastSeenAt"])
        self.assertEqual(by_code["G1"]["employeeName"], "Asha Kumar")
        self.assertEqual(by_code["G1"]["department"], "Sales")

    def test_the_number_of_queries_does_not_grow_with_the_employees_and_no_photo_is_read(self):
        ping(self.asha, 11.1, 77.3, 5)
        _, few = self.team()
        for i in range(8):
            emp = self.employee(f"GX{i}", "Extra", str(i), self.ho)
            emp.location_tracking_enabled = True
            emp.photo_url = PHOTO
            emp.save(update_fields=["location_tracking_enabled", "photo_url"])
            ping(emp, 11.0 + i / 100, 77.0, 3)
        body, many = self.team()
        self.assertEqual(len(body), 11)
        self.assertEqual(len(many.captured_queries), len(few.captured_queries))
        self.assertNotIn("photo_url", " ".join(q["sql"] for q in many.captured_queries))

    def test_stays_inside_the_branch_of_a_branch_login(self):
        ping(self.ravi, 11.2, 77.4, 5)
        body, _ = self.team(self.hr_ho)
        self.assertEqual({r["employeeCode"] for r in body}, {"G1", "G2"})
