"""Geo-Tracking: GET /api/tracking/journeys/day-map, the one-request feed of the On-Duty Map (every journey of a day with its
route: travel polylines, stops, gaps).

Run:  DB_NAME=uktex_fix_geo python manage.py test api.tests_geo_tracking_onduty_map --noinput
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .models import AuditLog, DutyTrack, DutyTrackSegment
from .tests_geo_tracking_support import T0, UTC, GeoBase

IST = ZoneInfo("Asia/Kolkata")
URL = "/api/tracking/journeys/day-map"
DAY = "2026-10-28"  # T0 is 10:00 IST on this day


def travel(track, seq, start, minutes, polyline, *, distance=1800.0):
    return DutyTrackSegment.objects.create(
        track=track,
        seq_no=seq,
        kind=DutyTrackSegment.KIND_TRAVEL,
        started_at=start,
        ended_at=start + timedelta(minutes=minutes),
        duration_s=minutes * 60,
        distance_m=distance,
        start_lat=polyline[0][0],
        start_lng=polyline[0][1],
        end_lat=polyline[-1][0],
        end_lng=polyline[-1][1],
        polyline=polyline,
    )


def stop(track, seq, start, minutes, lat, lng):
    return DutyTrackSegment.objects.create(
        track=track,
        seq_no=seq,
        kind=DutyTrackSegment.KIND_STOP,
        started_at=start,
        ended_at=start + timedelta(minutes=minutes),
        duration_s=minutes * 60,
        center_lat=lat,
        center_lng=lng,
        radius_m=30.0,
        address="Buyer office",
    )


class DayMapTests(GeoBase):
    def setUp(self):
        super().setUp()
        # Asha: a finished journey of the day, a drive, a stop and a drive
        self.asha_track = self.make_track(
            self.asha,
            T0,
            ended_at=T0 + timedelta(hours=2),
            distance_m=4200.0,
            stop_count=1,
            last_latitude=11.05,
            last_longitude=77.05,
        )
        travel(self.asha_track, 1, T0, 20, [[11.0, 77.0], [11.02, 77.02]])
        stop(self.asha_track, 2, T0 + timedelta(minutes=20), 12, 11.02, 77.02)
        travel(self.asha_track, 3, T0 + timedelta(minutes=32), 25, [[11.02, 77.02], [11.05, 77.05]])
        # Ravi (Unit 2): still recording
        self.ravi_track = self.make_track(
            self.ravi,
            T0 + timedelta(hours=1),
            last_point_at=T0 + timedelta(hours=1, minutes=20),
            last_latitude=11.5,
            last_longitude=77.5,
            state="moving",
        )
        travel(self.ravi_track, 1, T0 + timedelta(hours=1), 20, [[11.4, 77.4], [11.5, 77.5]])
        # Meena: another day
        self.meena_track = self.make_track(
            self.meena, T0 - timedelta(days=1), ended_at=T0 - timedelta(days=1) + timedelta(hours=1)
        )

    def day(self, user, date=DAY):
        return self.as_hr(user, "get", URL, date=date)

    def test_lists_the_journeys_of_the_day_with_their_routes_in_one_answer(self):
        res = self.day(self.hr_super)
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["date"], DAY)
        self.assertEqual({j["id"] for j in body["journeys"]}, {self.asha_track.pk, self.ravi_track.pk})
        asha = next(j for j in body["journeys"] if j["id"] == self.asha_track.pk)
        # the list-row fields and the last known position are there ...
        for key in (
            "employeeId",
            "employeeName",
            "department",
            "destination",
            "status",
            "state",
            "approvalStatus",
            "distanceM",
            "stopCount",
            "startedAt",
            "endedAt",
            "lastLatitude",
            "lastLongitude",
        ):
            self.assertIn(key, asha)
        self.assertEqual((asha["employeeName"], asha["status"], asha["stopCount"]), ("Asha Kumar", "ended", 1))
        self.assertEqual((asha["lastLatitude"], asha["lastLongitude"]), (11.05, 77.05))
        # ... and so is the route: the segments in order, a drive with its polyline, a stop with its centre
        kinds = [s["kind"] for s in asha["segments"]]
        self.assertEqual(kinds, ["travel", "stop", "travel"])
        self.assertEqual(asha["segments"][0]["polyline"], [[11.0, 77.0], [11.02, 77.02]])
        self.assertEqual((asha["segments"][1]["centerLat"], asha["segments"][1]["centerLng"]), (11.02, 77.02))
        self.assertEqual(asha["segments"][1]["address"], "Buyer office")
        self.assertEqual([s["seqNo"] for s in asha["segments"]], [1, 2, 3])

    def test_the_day_is_an_india_day_and_another_day_has_other_journeys(self):
        other = self.day(self.hr_super, "2026-10-27").json()["journeys"]
        self.assertEqual([j["id"] for j in other], [self.meena_track.pk])
        self.assertEqual(self.day(self.hr_super, "2026-10-20").json()["journeys"], [])

    def test_the_default_day_is_today(self):
        now = timezone.now()
        track = self.make_track(self.meena, now - timedelta(minutes=30), last_point_at=now - timedelta(minutes=1))
        body = self.as_hr(self.hr_super, "get", URL).json()
        self.assertEqual(body["date"], str(now.astimezone(IST).date()))
        self.assertIn(track.pk, [j["id"] for j in body["journeys"]])

    def test_a_journey_that_runs_over_midnight_is_on_both_days(self):
        started = datetime(2026, 10, 27, 18, 25, tzinfo=UTC)  # 23:55 IST on the 27th
        track = self.make_track(
            self.meena,
            started,
            last_point_at=datetime(2026, 10, 28, 3, 30, tzinfo=UTC),  # 09:00 IST on the 28th
        )
        self.assertIn(track.pk, [j["id"] for j in self.day(self.hr_super, "2026-10-27").json()["journeys"]])
        self.assertIn(track.pk, [j["id"] for j in self.day(self.hr_super, "2026-10-28").json()["journeys"]])
        self.assertNotIn(track.pk, [j["id"] for j in self.day(self.hr_super, "2026-10-29").json()["journeys"]])

    def test_a_track_with_no_position_yet_is_on_the_day_it_started(self):
        track = self.make_track(self.meena, datetime(2026, 10, 28, 5, 0, tzinfo=UTC))
        self.assertIn(track.pk, [j["id"] for j in self.day(self.hr_super).json()["journeys"]])
        self.assertNotIn(track.pk, [j["id"] for j in self.day(self.hr_super, "2026-10-29").json()["journeys"]])

    def test_a_bad_date_is_refused(self):
        for bad in ("28-10-2026", "tomorrow", "2026-13-01"):
            self.assertEqual(self.day(self.hr_super, bad).status_code, 400, bad)

    def test_branch_scoped_like_the_journey_list(self):
        self.assertEqual([j["id"] for j in self.day(self.hr_ho).json()["journeys"]], [self.asha_track.pk])
        self.assertEqual([j["id"] for j in self.day(self.hr_u2).json()["journeys"]], [self.ravi_track.pk])

    def test_who_may_read_it(self):
        self.assertEqual(self.as_employee(self.asha, "get", URL, date=DAY).status_code, 403)
        self.assertEqual(self.day(self.hr_nogeo).status_code, 403)
        self.assertEqual(self.day(self.hr_viewer).status_code, 200)

    def test_the_number_of_queries_does_not_grow_with_the_journeys_and_a_read_writes_no_audit_row(self):
        def queries():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.day(self.hr_super).status_code, 200)
            return len(ctx)

        queries()  # the first call also warms the permission and settings caches
        audit_before = AuditLog.objects.count()
        few = queries()
        for n in range(6):
            emp = self.employee(f"H{n}", "Extra", f"Person{n}", self.ho)
            track = self.make_track(emp, T0 + timedelta(minutes=n), ended_at=T0 + timedelta(hours=1))
            travel(track, 1, T0, 10, [[11.0, 77.0], [11.01, 77.01]])
        self.assertEqual(len(self.day(self.hr_super).json()["journeys"]), 8)
        self.assertEqual(queries(), few)
        self.assertEqual(AuditLog.objects.count(), audit_before)

    def test_ordered_by_employee_name(self):
        names = [j["employeeName"] for j in self.day(self.hr_super).json()["journeys"]]
        self.assertEqual(names, sorted(names))
        self.assertEqual(DutyTrack.objects.filter(employee=self.asha).count(), 1)
