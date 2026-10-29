"""Geo-Tracking: the track's life (start with the request, end for exactly four reasons), the 23:50 day-end close, the watchdog,
retention, the reverse geocoder, and the two-photo On-Duty punch.

Run:  DB_NAME=uktex_fix_geo python manage.py test api.tests_geo_tracking_lifecycle --noinput
"""

import inspect
from datetime import date, datetime, time, timedelta
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError
from django.test import SimpleTestCase

from . import geo_attendance_views as GV
from . import geo_tracking_scheduler, on_duty_day_end, on_duty_day_end_scheduler
from .geo_tracking import background, geocode, ingest, journey, live, sessions, watchdog
from .models import (
    AttendanceLog,
    DepartmentManager,
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    DutyTrackSegment,
    GeoTrackingSettings,
    Employee,
    ManagerEmployeeAssignment,
    OnDutyPunchVerification,
    OnDutySession,
)
from .tests_geo_tracking_support import LAT0, LNG0, T0, UTC, GeoBase, employee_headers, offset_latlng, point
from .tests_geo_tracking_views import drive_points

REQUEST = "/api/on-duty-sessions/request"


class LifecycleBase(GeoBase):
    def submit(self, emp=None, destination="ABC Traders, Coimbatore"):
        r = self.as_employee(emp or self.asha, "post", REQUEST, {"destination": destination})
        self.assertEqual(r.status_code, 201, r.content)
        return OnDutySession.objects.get(pk=r.json()["sessionId"])

    def track_of(self, session) -> DutyTrack:
        return DutyTrack.objects.get(session=session)

    def decide(self, session, status="approved", user=None):
        return self.as_hr(
            user or self.hr_super, "patch", f"/api/on-duty-sessions/{session.pk}/status", {"status": status}
        )

    def snapshot(self, track):
        return {f.name: getattr(DutyTrack.objects.get(pk=track.pk), f.attname) for f in DutyTrack._meta.fields}


class StartTests(LifecycleBase):
    def test_the_request_creates_the_session_and_its_track_in_one_go(self):
        before = datetime.now(UTC)
        r = self.as_employee(self.asha, "post", REQUEST, {"destination": "ABC Traders"})
        after = datetime.now(UTC)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(
            (r.json()["status"], r.json()["approvalStatus"], r.json()["canPunch"]), ("active", "pending_hod", True)
        )  # unchanged
        session = OnDutySession.objects.get()
        track = self.track_of(session)
        self.assertEqual(
            (track.status, track.state, track.employee_id, track.branch_id, track.end_reason),
            ("active", "waiting_first_fix", self.asha.pk, self.ho.pk, ""),
        )
        self.assertTrue(before - timedelta(seconds=1) <= track.started_at <= after + timedelta(seconds=1))
        self.assertEqual(track.state_since, track.started_at)
        started = DutyTrackEvent.objects.get(track=track)
        self.assertEqual(
            (started.kind, started.source, started.seq, started.started_at, started.meta),
            ("TRACKING_STARTED", "server", None, track.started_at, {"sessionId": session.pk}),
        )
        self.assertEqual(track.events_count, 1)

    def test_the_session_and_the_track_are_created_inside_one_transaction(self):
        from django.db import connection

        base = len(connection.savepoint_ids)
        seen = {}
        real = sessions.start_track

        def spy(session, **kw):
            # the session row exists and we are inside the request's transaction (its outer atomic + the savepoint around this call)
            seen["depth"] = len(connection.savepoint_ids)
            seen["session_visible"] = OnDutySession.objects.filter(pk=session.pk).exists()
            return real(session, **kw)

        with mock.patch.object(sessions, "start_track", side_effect=spy):
            self.submit()
        self.assertEqual(seen["depth"] - base, 2)
        self.assertTrue(seen["session_visible"])

    def test_tracking_starts_before_any_approval_and_whatever_the_workflow_says(self):
        session = self.submit()
        self.assertEqual(session.status, "pending_hod")
        self.assertEqual(self.track_of(session).status, "active")

    def test_a_second_request_while_one_is_in_progress_is_refused_and_makes_no_second_track(self):
        self.submit()
        r = self.as_employee(self.asha, "post", REQUEST, {"destination": "Another"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(DutyTrack.objects.filter(employee=self.asha).count(), 1)
        self.assertEqual(OnDutySession.objects.filter(employee=self.asha).count(), 1)

    def test_a_refused_request_leaves_no_track_behind(self):
        r = self.as_employee(self.asha, "post", REQUEST, {"destination": "   "})
        self.assertEqual(r.status_code, 400)
        self.assertEqual((OnDutySession.objects.count(), DutyTrack.objects.count()), (0, 0))

    def test_with_tracking_switched_off_the_session_is_still_made_without_a_track(self):
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"enabled": False})
        session = self.submit()
        self.assertFalse(DutyTrack.objects.filter(session=session).exists())

    def test_a_failure_to_start_the_track_does_not_stop_the_employee_starting_duty(self):
        with mock.patch.object(sessions, "start_track", side_effect=DatabaseError("down")):
            session = self.submit()
        self.assertFalse(DutyTrack.objects.filter(session=session).exists())
        body = self.as_employee(self.asha, "get", "/api/tracking/state").json()  # the app's next call repairs it
        self.assertTrue(body["active"])
        self.assertEqual(DutyTrack.objects.get(session=session).status, "active")

    def test_an_active_track_whose_session_is_over_does_not_block_the_next_request(self):
        old = self.make_session(self.asha, employee_ended_at=T0)  # finished, but nothing ended its track
        stale = self.make_track(self.asha, T0 - timedelta(hours=1), session=old)
        session = self.submit()
        stale.refresh_from_db()
        self.assertEqual((stale.status, stale.end_reason), ("ended", "manual"))
        self.assertEqual(self.track_of(session).status, "active")
        self.assertEqual(DutyTrack.objects.filter(employee=self.asha, status="active").count(), 1)

    def test_a_new_request_after_the_end_starts_a_new_track(self):
        first = self.submit()
        self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete")
        second = self.submit()
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(self.track_of(first).status, "ended")
        self.assertEqual(self.track_of(second).status, "active")

    def test_start_track_is_idempotent_per_session_and_never_makes_a_second_active_track(self):
        session = self.submit()
        again = sessions.start_track(session)
        self.assertEqual(again.pk, self.track_of(session).pk)
        other_session = self.make_session(self.asha, status="pending_hod")
        self.assertIsNone(sessions.start_track(other_session))  # the first one still records
        self.assertEqual(DutyTrack.objects.filter(employee=self.asha).count(), 1)


class EndTests(LifecycleBase):
    def test_marking_the_duty_done_ends_the_track_for_the_manual_reason(self):
        session = self.submit()
        track = self.track_of(session)
        DutyTrack.objects.filter(pk=track.pk).update(started_at=datetime.now(UTC) - timedelta(hours=1))
        track.refresh_from_db()
        t = track.started_at + timedelta(seconds=10)
        self.consent(self.asha)
        answer = ingest.ingest_batch(
            self.asha,
            {
                "deviceId": "d",
                "points": [
                    point(1, t + timedelta(milliseconds=100)),
                    point(2, t + timedelta(milliseconds=200), LAT0 + 0.001, LNG0),
                ],
                "events": [{"seq": 3, "kind": "GPS_OFF", "startedAt": int(t.timestamp() * 1000) + 300}],
            },
        )
        self.assertEqual(answer["accepted"], 3)
        r = self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete")
        self.assertEqual(r.status_code, 200)
        session.refresh_from_db()
        track.refresh_from_db()
        self.assertEqual((track.status, track.end_reason, track.state), ("ended", "manual", "ended"))
        self.assertEqual(track.ended_at, session.employee_ended_at)
        self.assertEqual(track.state_since, track.ended_at)
        stopped = DutyTrackEvent.objects.get(track=track, kind="TRACKING_STOPPED")
        self.assertEqual(
            (stopped.started_at, stopped.meta, stopped.source), (track.ended_at, {"reason": "manual"}, "server")
        )
        gps = DutyTrackEvent.objects.get(track=track, kind="GPS_OFF")
        self.assertEqual(
            (gps.ended_at, gps.meta["closedBy"]), (track.ended_at, "track_end")
        )  # an interval open at the end ends with it
        self.assertIsNotNone(track.rebuilt_at)  # the final rebuild ran
        self.assertEqual(track.events_count, 3)  # started, GPS off, stopped
        self.assertEqual(track.points_count, 2)  # what was collected is kept

    def test_the_fourth_punch_ends_the_track(self):
        session = self.submit()
        for n in (1, 2, 3, 4):
            r = self.client.post(
                "/api/on-duty-sessions/punch",
                {
                    "latitude": "11.0",
                    "longitude": "77.0",
                    "punchNumber": str(n),
                    "photo": SimpleUploadedFile(f"p{n}.jpg", b"jpgdata", "image/jpeg"),
                },
                **employee_headers(self.asha),
            )
            self.assertEqual(r.status_code, 201, r.content)
            self.assertEqual(self.track_of(session).status, "active" if n < 4 else "ended")
        track = self.track_of(session)
        self.assertEqual(track.end_reason, "auto_4th_punch")
        session.refresh_from_db()
        self.assertEqual(session.employee_ended_at, track.ended_at)

    def test_the_day_end_close_ends_the_track(self):
        session = self.submit()
        result = on_duty_day_end.end_stale_on_duty_sessions()
        self.assertEqual(result["ended"] + result["sweptFromEarlierDays"], 1)
        track = self.track_of(session)
        self.assertEqual((track.status, track.end_reason), ("ended", "auto_day_end"))
        # an employee who never marked Done and was never approved: the request stays in HR's queue
        session.refresh_from_db()
        self.assertEqual(session.status, "pending_hod")
        self.assertIsNotNone(session.employee_ended_at)

    def test_a_rejection_ends_the_track_and_keeps_what_was_collected(self):
        session = self.submit()
        track = self.track_of(session)
        drive_points(track, 12)
        r = self.decide(session, "rejected")
        self.assertEqual(r.status_code, 200)
        track.refresh_from_db()
        self.assertEqual((track.status, track.end_reason, track.state), ("ended", "rejected", "ended"))
        self.assertEqual(DutyTrackPoint.objects.filter(track=track).count(), 12)
        self.assertEqual(DutyTrackEvent.objects.get(track=track, kind="TRACKING_STOPPED").meta, {"reason": "rejected"})
        self.assertGreater(
            DutyTrackSegment.objects.filter(track=track).count(), 0
        )  # the final rebuild kept the journey
        # the employee can request again
        self.assertEqual(self.as_employee(self.asha, "post", REQUEST, {"destination": "Again"}).status_code, 201)

    def test_a_department_head_rejecting_ends_the_track_too(self):
        boss = self.employee("G9", "Suresh", "Raj", self.ho)
        manager = DepartmentManager.objects.create(employee=boss)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.asha)
        session = self.submit()
        r = self.as_employee(
            boss, "patch", f"/api/manager/on-duty-sessions/{session.pk}/status", {"status": "rejected"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((self.track_of(session).status, self.track_of(session).end_reason), ("ended", "rejected"))

    def test_approval_never_ends_or_changes_the_track(self):
        session = self.submit()
        track = self.track_of(session)
        drive_points(track, 5)
        before = self.snapshot(track)
        events_before = DutyTrackEvent.objects.filter(track=track).count()
        r = self.decide(session, "approved")
        self.assertEqual(r.status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.status, "active")
        self.assertEqual(self.snapshot(track), before)
        self.assertEqual(DutyTrackEvent.objects.filter(track=track).count(), events_before)

    def test_a_two_stage_approval_changes_nothing_at_the_first_stage_either(self):
        boss = self.employee("G9", "Suresh", "Raj", self.ho)
        manager = DepartmentManager.objects.create(employee=boss)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.asha)
        session = self.submit()
        before = self.snapshot(self.track_of(session))
        self.as_employee(boss, "patch", f"/api/manager/on-duty-sessions/{session.pk}/status", {"status": "approved"})
        self.assertEqual(self.snapshot(self.track_of(session)), before)

    def test_approving_after_the_employee_already_finished_leaves_the_manual_end_alone(self):
        session = self.submit()
        self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete")
        ended = self.snapshot(self.track_of(session))
        self.decide(session, "approved")
        self.assertEqual(self.snapshot(self.track_of(session)), ended)
        self.assertEqual(self.track_of(session).end_reason, "manual")

    def test_rejecting_after_the_employee_finished_keeps_the_manual_reason(self):
        session = self.submit()
        self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete")
        ended_at = self.track_of(session).ended_at
        self.decide(session, "rejected")
        track = self.track_of(session)
        self.assertEqual((track.end_reason, track.ended_at), ("manual", ended_at))
        self.assertEqual(DutyTrackEvent.objects.filter(track=track, kind="TRACKING_STOPPED").count(), 1)

    def test_hr_approving_the_fourth_punch_of_a_still_active_session_ends_the_track(self):
        session = self.submit()
        self.decide(session, "approved")
        today = datetime.now(UTC).date()
        for punch_time, kind in ((time(9, 0), "IN"), (time(12, 0), "OUT"), (time(13, 0), "IN")):
            AttendanceLog.objects.create(
                employee=self.asha, date=today, punch_time=punch_time, punch_type=kind, source="biometric"
            )
        v = OnDutyPunchVerification.objects.create(
            session=session,
            employee=self.asha,
            punch_date=today,
            punch_time=time(18, 0),
            punch_type="OUT",
            punch_number=4,
            latitude=11.0,
            longitude=77.0,
            photo="x.jpg",
        )
        r = self.as_hr(
            self.hr_super, "patch", f"/api/on-duty-punch-verifications/{v.pk}/status", {"status": "approved"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        session.refresh_from_db()
        self.assertEqual((session.status, session.completion_reason), ("completed", "auto_4th_punch"))
        self.assertEqual(
            (self.track_of(session).status, self.track_of(session).end_reason), ("ended", "auto_4th_punch")
        )

    def test_end_track_is_idempotent_and_keeps_the_first_reason(self):
        session = self.submit()
        track = self.track_of(session)
        self.assertTrue(sessions.end_track(track, "manual"))
        first = self.snapshot(track)
        self.assertFalse(sessions.end_track(track, "rejected"))
        self.assertFalse(sessions.end_track(DutyTrack.objects.get(pk=track.pk), "auto_day_end"))
        self.assertEqual(self.snapshot(track), first)
        self.assertEqual(DutyTrackEvent.objects.filter(track=track, kind="TRACKING_STOPPED").count(), 1)
        self.assertEqual((track.status, track.end_reason), ("ended", "manual"))  # the caller's object reflects it

    def test_an_administrator_can_end_a_track_and_an_unknown_reason_is_refused(self):
        track = self.track_of(self.submit())
        with self.assertRaises(ValueError):
            sessions.end_track(track, "boredom")
        self.assertTrue(sessions.end_track(track, "admin"))
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).end_reason, "admin")

    def test_end_track_for_a_session_without_a_track_is_a_no_op(self):
        self.assertFalse(sessions.end_track_for_session(self.make_session(self.ravi), "manual"))

    def test_nothing_else_ends_a_track(self):
        session = self.submit()
        track = self.track_of(session)
        DutyTrack.objects.filter(pk=track.pk).update(
            last_point_at=datetime.now(UTC) - timedelta(hours=3), state="offline"
        )
        watchdog.run_watchdog()
        self.consent(self.asha)
        for _ in range(2):
            self.as_employee(self.asha, "get", "/api/tracking/state")
        self.decide(session, "approved")
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).status, "active")

    def test_a_failure_to_end_the_track_does_not_block_ending_the_session(self):
        session = self.submit()
        with mock.patch.object(sessions, "end_track_for_session", side_effect=DatabaseError("down")):
            r = self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete")
        self.assertEqual(r.status_code, 200)
        session.refresh_from_db()
        self.assertIsNotNone(session.employee_ended_at)
        self.assertEqual(self.track_of(session).status, "active")  # ... and the scheduler ends it within two minutes
        result = watchdog.run_watchdog()
        self.assertEqual(result["orphansEnded"], 1)
        track = self.track_of(session)
        self.assertEqual((track.status, track.end_reason), ("ended", "manual"))

    def test_the_final_rebuild_runs_in_a_background_thread_in_production(self):
        track = self.track_of(self.submit())
        started = []

        class FakeThread:
            def __init__(self, target=None, name=None, daemon=None):
                started.append((target, name, daemon))

            def start(self):
                pass

        with (
            mock.patch.object(background, "inline_mode", return_value=False),
            mock.patch.object(background.threading, "Thread", FakeThread),
        ):
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                sessions.end_track(track, "manual")
                self.assertEqual(started, [])  # nothing is started until the surrounding transaction commits
        self.assertEqual(len(callbacks), 1)
        self.assertEqual(len(started), 1)
        self.assertEqual((started[0][1], started[0][2]), (f"geo-tracking-('rebuild', {track.pk})", True))
        self.assertIsNone(DutyTrack.objects.get(pk=track.pk).rebuilt_at)  # not inside the request
        background._running.clear()

    def test_the_same_background_job_is_not_started_twice_at_once(self):
        calls = []
        with (
            mock.patch.object(background, "inline_mode", return_value=False),
            mock.patch.object(background.threading, "Thread") as thread,
        ):
            self.assertTrue(background.run_job("k", calls.append, 1))
            self.assertFalse(background.run_job("k", calls.append, 2))
        self.assertEqual(thread.call_count, 1)
        background._running.clear()

    def test_orphan_tracks_end_with_the_reason_their_session_shows(self):
        cases = [
            (dict(employee_ended_at=T0), "manual"),
            (dict(status="rejected"), "rejected"),
            (dict(status="completed", completion_reason="auto_4th_punch"), "auto_4th_punch"),
            (dict(status="completed", completion_reason="auto_day_end"), "auto_day_end"),
        ]
        for i, (fields, reason) in enumerate(cases):
            emp = self.employee(f"O{i}", "Orphan", str(i), self.ho)
            track = self.make_track(emp, T0, session=self.make_session(emp, **fields))
            self.assertEqual(sessions.reconcile_orphan_tracks(), 1, reason)
            self.assertEqual(DutyTrack.objects.get(pk=track.pk).end_reason, reason)
        live_emp = self.employee("O9", "Live", "One", self.ho)
        live_track = self.make_track(live_emp, T0)
        self.assertEqual(sessions.reconcile_orphan_tracks(), 0)
        self.assertEqual(DutyTrack.objects.get(pk=live_track.pk).status, "active")


class WholeDutyStoryTests(LifecycleBase):
    """One duty, end to end, through the HTTP API only: the request, the notice, a route uploaded in batches (a leg, a stop, a leg,
    eight minutes with location off, a leg), HR watching and approving, the employee finishing, a late upload, the journey."""

    def route(self, start):
        s = start.timestamp()
        at = lambda secs: start + timedelta(seconds=secs)
        points, seq = [], 0

        def add(secs, north):
            nonlocal seq
            seq += 1
            lat, lng = offset_latlng(LAT0, LNG0, north, 0.0)
            points.append(
                point(seq, at(secs), lat, lng, acc=9.0, battery=70 - seq // 10, network="cell", activity="vehicle")
            )

        for k in range(31):
            add(60 + 10 * k, k * 150.0)  # leg 1: 4500 m in 5 minutes
        for k in range(13):
            add(370 + 30 * k, 4500.0)  # six minutes standing at the buyer's
        for k in range(31):
            add(760 + 10 * k, 4500.0 + k * 150.0)  # leg 2
        events = [
            {"seq": seq + 1, "kind": "GPS_OFF", "startedAt": int((s + 1100) * 1000)},
            {"seq": seq + 2, "kind": "GPS_ON", "startedAt": int((s + 1600) * 1000)},
        ]
        seq += 2
        for k in range(31):
            add(1620 + 10 * k, 12000.0 + k * 150.0)  # leg 3, after 3 km nobody recorded
        return points, events

    def test_the_whole_duty(self):
        session = self.submit()
        track = self.track_of(session)
        start = datetime.now(UTC) - timedelta(hours=1)
        DutyTrack.objects.filter(pk=track.pk).update(started_at=start, state_since=start)
        # the notice
        state = self.as_employee(self.asha, "get", "/api/tracking/state").json()
        self.assertEqual((state["active"], state["consentRequired"]), (True, True))
        self.assertEqual(self.batch(self.asha, [point(1, start + timedelta(seconds=30))]).status_code, 403)
        self.as_employee(
            self.asha, "post", "/api/tracking/consent", {"deviceId": "dev-1", "noticeVersion": state["noticeVersion"]}
        )
        self.assertFalse(self.as_employee(self.asha, "get", "/api/tracking/state").json()["consentRequired"])
        # the route, in three uploads (the app's batches), one of them sent twice
        points, events = self.route(start)
        health = {
            "app": {"version": "3.2.0", "os": "android", "osVersion": "14", "model": "Pixel 6"},
            "health": {"permission": "always", "locationEnabled": True, "batteryPct": 68},
        }
        first = self.batch(self.asha, points[:44], extra=health)
        self.assertEqual((first.status_code, first.json()["accepted"], first.json()["ackSeq"]), (200, 44, 44))
        second = self.batch(self.asha, points[44:75], events[:1])
        again = self.batch(self.asha, points[44:75], events[:1])
        self.assertEqual((second.json()["accepted"], again.json()["accepted"], again.json()["duplicates"]), (32, 0, 32))
        third = self.batch(self.asha, points[75:], events[1:], snake=True)
        self.assertEqual(
            (third.json()["accepted"], third.json()["rejected"], third.json()["trackActive"]), (32, 0, True)
        )
        track.refresh_from_db()
        self.assertEqual(
            (track.points_count, track.events_count - 1), (len(points), 1)
        )  # 1 = the GPS-off interval (and its end)
        # HR sees the journey (the rebuild is throttled while recording: ask for a fresh one)
        self.assertEqual(self.as_hr(self.hr_ho, "post", f"/api/tracking/journeys/{track.pk}/rebuild").status_code, 200)
        detail = self.as_hr(self.hr_ho, "get", f"/api/tracking/journeys/{track.pk}").json()
        self.assertEqual([x["kind"] for x in detail["segments"]], ["travel", "stop", "travel", "gap", "travel"])
        stop, gap = detail["segments"][1], detail["segments"][3]
        self.assertGreaterEqual(stop["durationS"], 360)
        self.assertEqual((gap["cause"], gap["durationS"]), ("gps_off", 560))
        gps = [e for e in detail["events"] if e["kind"] == "GPS_OFF"]
        self.assertEqual((len(gps), gps[0]["durationS"], gps[0]["open"]), (1, 500, False))
        self.assertEqual((detail["device"]["model"], detail["device"]["permissionLevel"]), ("Pixel 6", "always"))
        self.assertEqual(detail["track"]["state"], "offline")  # the last point is half an hour old
        self.assertAlmostEqual(detail["summary"]["distanceM"], 3 * 30 * 150.0, delta=60.0)
        live = self.as_hr(self.hr_ho, "get", "/api/tracking/live").json()
        self.assertEqual([r["employeeCode"] for r in live], ["G1"])
        # approval changes nothing about the recording
        self.assertEqual(self.decide(session, "approved").status_code, 200)
        self.assertEqual(DutyTrack.objects.get(pk=track.pk).status, "active")
        # the employee finishes; what arrives a few minutes later (the offline queue) is still taken
        self.assertEqual(self.as_employee(self.asha, "post", "/api/on-duty-sessions/complete").status_code, 200)
        ended = DutyTrack.objects.get(pk=track.pk)
        self.assertEqual((ended.status, ended.end_reason), ("ended", "manual"))
        lat, lng = offset_latlng(LAT0, LNG0, 16500.0, 0.0)
        late = self.batch(
            self.asha,
            [
                point(500, ended.ended_at - timedelta(seconds=20), lat, lng),
                point(501, ended.ended_at + timedelta(minutes=4), lat, lng + 0.0002),
                point(502, ended.ended_at + timedelta(minutes=9), lat, lng + 0.0004),
            ],
        )
        body = late.json()
        self.assertEqual(
            (body["accepted"], body["rejected"], body["trackActive"], body["endReason"]), (2, 1, False, "manual")
        )
        final = self.as_hr(self.hr_ho, "get", f"/api/tracking/journeys/{track.pk}").json()
        self.assertEqual(final["track"]["status"], "ended")
        self.assertEqual(final["summary"]["pointsCount"], len(points) + 2)
        self.assertEqual(final["events"][-1]["kind"], "TRACKING_STOPPED")
        # the employee's own view and the HR export
        mine = self.as_employee(self.asha, "get", "/api/tracking/my-journeys").json()
        self.assertEqual((mine["total"], mine["results"][0]["endReason"]), (1, "manual"))
        self.assertEqual(
            mine["results"][0]["stopCount"], 2
        )  # the buyer, and the half hour at the end (the signal came back in the same place)
        self.assertEqual(self.as_hr(self.hr_ho, "get", f"/api/tracking/journeys/{track.pk}/export").status_code, 200)
        # and the next request starts a new track
        self.assertEqual(self.as_employee(self.asha, "post", REQUEST, {"destination": "Tomorrow"}).status_code, 201)


class DayEndSchedulerTests(SimpleTestCase):
    def test_the_old_23_00_close_is_gone(self):
        self.assertFalse(hasattr(on_duty_day_end_scheduler, "_HOUR"))
        self.assertFalse(hasattr(on_duty_day_end_scheduler, "_MINUTE"))
        for module in (on_duty_day_end_scheduler, on_duty_day_end):
            self.assertNotIn("23:00", inspect.getsource(module))
            self.assertNotIn("11 PM", inspect.getsource(module))
        self.assertEqual(on_duty_day_end_scheduler.DEFAULT_DAY_END, time(23, 50))

    def test_the_close_is_due_from_the_day_end_time_and_only_once_a_day(self):
        due = on_duty_day_end_scheduler.is_due
        end = time(23, 50)
        day = date(2026, 10, 28)
        self.assertFalse(due(datetime(2026, 10, 28, 23, 49, 59), end, None))
        self.assertTrue(due(datetime(2026, 10, 28, 23, 50, 0), end, None))
        self.assertTrue(due(datetime(2026, 10, 28, 23, 59, 59), end, day - timedelta(days=1)))
        self.assertFalse(due(datetime(2026, 10, 28, 23, 55), end, day))  # already ran today
        self.assertTrue(due(datetime(2026, 10, 29, 23, 50), end, day))  # tomorrow again
        self.assertFalse(due(datetime(2026, 10, 28, 23, 0), end, None))  # 23:00 no longer closes the day
        self.assertFalse(due(datetime(2026, 10, 28, 0, 5), end, None))
        self.assertTrue(due(datetime(2026, 10, 28, 22, 15), time(22, 15), None))

    def test_the_tick_runs_the_close_once_at_the_day_end_time(self):
        mod = on_duty_day_end_scheduler
        with (
            mock.patch.object(mod, "_last_run_date", None),
            mock.patch.object(mod, "day_end_time", return_value=time(23, 50)),
            mock.patch.object(mod, "_run_day_end") as run,
        ):
            with mock.patch("api.clock.ist_now", return_value=datetime(2026, 10, 28, 23, 49)):
                mod._tick()
            run.assert_not_called()
            with mock.patch("api.clock.ist_now", return_value=datetime(2026, 10, 28, 23, 50, 5)):
                mod._tick()
                mod._tick()
            self.assertEqual(run.call_count, 1)
            with mock.patch("api.clock.ist_now", return_value=datetime(2026, 10, 29, 23, 51)):
                mod._tick()
            self.assertEqual(run.call_count, 2)

    def test_a_failed_close_is_tried_again_on_the_next_tick(self):
        mod = on_duty_day_end_scheduler
        with (
            mock.patch.object(mod, "_last_run_date", None),
            mock.patch.object(mod, "day_end_time", return_value=time(23, 50)),
            mock.patch.object(mod, "_run_day_end", side_effect=[RuntimeError("db"), None]) as run,
        ):
            with mock.patch("api.clock.ist_now", return_value=datetime(2026, 10, 28, 23, 52)):
                mod._tick()
                mod._tick()
        self.assertEqual(run.call_count, 2)

    def test_the_scheduler_registers_one_light_interval_job_and_starts_no_thread_here(self):
        mod = on_duty_day_end_scheduler
        fake = mock.MagicMock(running=True)
        with mock.patch.object(mod, "get_scheduler", return_value=fake):
            mod.start_scheduler_if_needed()
        fake.add_job.assert_called_once()
        args, kwargs = fake.add_job.call_args
        self.assertEqual(
            (args[0], args[1], kwargs["id"], kwargs["minutes"]), (mod._tick, "interval", "on_duty_day_end", 1)
        )
        fake.start.assert_not_called()

    def test_every_scheduler_job_first_drops_a_dead_database_connection(self):
        with (
            mock.patch("django.db.close_old_connections") as close,
            mock.patch("api.geo_tracking.watchdog.run_watchdog") as dog,
            mock.patch("api.geo_tracking.watchdog.purge_old") as purge,
        ):
            geo_tracking_scheduler._run_watchdog()
            geo_tracking_scheduler._run_purge()
        self.assertEqual(close.call_count, 2)
        dog.assert_called_once()
        purge.assert_called_once()
        mod = on_duty_day_end_scheduler
        with (
            mock.patch("django.db.close_old_connections") as close,
            mock.patch.object(mod, "day_end_time", return_value=time(23, 50)),
        ):
            with mock.patch("api.clock.ist_now", return_value=datetime(2026, 10, 28, 12, 0)):
                mod._tick()
        close.assert_called_once()

    def test_the_geo_tracking_scheduler_registers_the_watchdog_and_the_purge(self):
        fake = mock.MagicMock(running=True)
        with mock.patch.object(geo_tracking_scheduler, "get_scheduler", return_value=fake):
            geo_tracking_scheduler.start_scheduler_if_needed()
        jobs = {call.kwargs["id"]: call for call in fake.add_job.call_args_list}
        self.assertEqual(set(jobs), {"geo_tracking_watchdog", "geo_tracking_purge"})
        self.assertEqual(
            (jobs["geo_tracking_watchdog"].args[1], jobs["geo_tracking_watchdog"].kwargs["minutes"]), ("interval", 2)
        )
        fake.start.assert_not_called()

    def test_no_scheduler_thread_is_started_under_the_test_runner(self):
        from django.apps import apps

        config = apps.get_app_config("api")
        with (
            mock.patch.object(geo_tracking_scheduler, "start_scheduler_if_needed") as geo,
            mock.patch.object(on_duty_day_end_scheduler, "start_scheduler_if_needed") as day,
        ):
            config._start_scheduler()
        geo.assert_not_called()
        day.assert_not_called()


class DayEndTimeSettingTests(GeoBase):
    def test_the_close_time_comes_from_the_settings(self):
        self.assertEqual(on_duty_day_end_scheduler.day_end_time(), time(23, 50))
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"day_end_time": time(21, 30)})
        self.assertEqual(on_duty_day_end_scheduler.day_end_time(), time(21, 30))

    def test_an_unreadable_setting_falls_back_to_23_50(self):
        with mock.patch("api.models.GeoTrackingSettings.get", side_effect=DatabaseError("not migrated")):
            self.assertEqual(on_duty_day_end_scheduler.day_end_time(), time(23, 50))


class WatchdogTests(LifecycleBase):
    def setUp(self):
        super().setUp()
        self.now = T0 + timedelta(hours=2)
        self.track = self.make_track(self.asha, T0, last_point_at=T0 + timedelta(minutes=5), state="moving")

    def lost(self):
        return list(DutyTrackEvent.objects.filter(track=self.track, kind="SIGNAL_LOST").order_by("id"))

    def test_a_silent_track_gets_exactly_one_open_signal_lost_event_and_goes_offline(self):
        for _ in range(3):
            result = watchdog.run_watchdog(self.now)
        (event,) = self.lost()
        self.assertEqual(
            (event.source, event.started_at, event.ended_at, event.seq),
            ("server", T0 + timedelta(minutes=5), None, None),
        )
        self.assertEqual(event.meta["detectedAt"], self.now.isoformat())
        self.track.refresh_from_db()
        self.assertEqual(
            (self.track.state, self.track.state_since, self.track.events_count),
            ("offline", T0 + timedelta(minutes=5), 1),
        )
        self.assertEqual(result["signalLost"], 0)  # the third run found nothing new

    def test_the_first_run_reports_what_it_did(self):
        self.assertEqual(watchdog.run_watchdog(self.now)["signalLost"], 1)

    def test_a_track_that_is_only_briefly_quiet_is_left_alone(self):
        DutyTrack.objects.filter(pk=self.track.pk).update(last_point_at=self.now - timedelta(minutes=9))
        watchdog.run_watchdog(self.now)
        self.assertEqual(self.lost(), [])

    def test_the_threshold_follows_the_setting(self):
        DutyTrack.objects.filter(pk=self.track.pk).update(last_point_at=self.now - timedelta(minutes=9))
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"signal_lost_seconds": 300})
        watchdog.run_watchdog(self.now)
        self.assertEqual(len(self.lost()), 1)

    def test_data_arriving_again_closes_the_event_and_the_next_silence_makes_a_new_one(self):
        watchdog.run_watchdog(self.now)
        self.consent(self.asha)
        later = self.now + timedelta(minutes=1)
        ingest.ingest_batch(self.asha, {"deviceId": "d", "points": [point(1, self.now, LAT0, LNG0)]}, now=later)
        (event,) = self.lost()
        self.assertEqual(event.ended_at, later)
        self.track.refresh_from_db()
        self.assertEqual(self.track.state, "moving")
        watchdog.run_watchdog(self.now + timedelta(minutes=30))
        self.assertEqual(len(self.lost()), 2)
        self.assertEqual(len([e for e in self.lost() if e.ended_at is None]), 1)

    def test_a_track_with_location_off_is_not_called_signal_lost(self):
        DutyTrackEvent.objects.create(
            track=self.track,
            employee=self.asha,
            kind="GPS_OFF",
            device_id="d",
            seq=1,
            started_at=T0 + timedelta(minutes=6),
        )
        watchdog.run_watchdog(self.now)
        self.assertEqual(self.lost(), [])
        self.track.refresh_from_db()
        self.assertEqual((self.track.state, self.track.state_since), ("location_off", T0 + timedelta(minutes=6)))

    def test_a_track_that_never_got_a_fix_is_waiting_then_offline(self):
        empty = self.make_track(self.meena, T0)
        watchdog.run_watchdog(T0 + timedelta(minutes=5))
        empty.refresh_from_db()
        self.assertEqual(empty.state, "waiting_first_fix")
        watchdog.run_watchdog(T0 + timedelta(minutes=11))
        empty.refresh_from_db()
        self.assertEqual(empty.state, "offline")
        (event,) = DutyTrackEvent.objects.filter(track=empty, kind="SIGNAL_LOST")
        self.assertEqual(event.started_at, T0)

    def test_ended_tracks_are_left_alone(self):
        ended = self.make_track(
            self.meena, T0, ended_at=T0 + timedelta(minutes=20), last_point_at=T0 + timedelta(minutes=10)
        )
        watchdog.run_watchdog(self.now)
        self.assertFalse(DutyTrackEvent.objects.filter(track=ended).exists())

    def test_the_open_signal_lost_interval_ends_when_the_track_ends(self):
        watchdog.run_watchdog(self.now)
        sessions.end_track(self.track, "manual", now=self.now + timedelta(minutes=5))
        (event,) = self.lost()
        self.assertEqual(event.ended_at, self.now + timedelta(minutes=5))

    def test_the_watchdog_refreshes_states_and_runs_the_orphan_check(self):
        orphan = self.make_track(self.meena, T0, session=self.make_session(self.meena, employee_ended_at=T0))
        result = watchdog.run_watchdog(self.now)
        self.assertEqual(result["orphansEnded"], 1)
        orphan.refresh_from_db()
        self.assertEqual(orphan.status, "ended")
        self.assertEqual(result["geocode"]["provider"], "off")


class StateRuleTests(SimpleTestCase):
    def classify(self, **kw):
        base = dict(
            status="active",
            now=T0 + timedelta(minutes=30),
            started_at=T0,
            last_point_at=T0 + timedelta(minutes=29),
            location_off=False,
            in_open_stop=False,
            signal_lost_seconds=600,
        )
        base.update(kw)
        return live.classify_state(**base)

    def test_each_state(self):
        self.assertEqual(self.classify(), "moving")
        self.assertEqual(self.classify(in_open_stop=True), "stationary")
        self.assertEqual(self.classify(location_off=True), "location_off")
        self.assertEqual(self.classify(location_off=True, in_open_stop=True), "location_off")
        self.assertEqual(self.classify(last_point_at=T0 + timedelta(minutes=19)), "offline")
        self.assertEqual(self.classify(last_point_at=T0 + timedelta(minutes=20, seconds=1)), "moving")
        self.assertEqual(self.classify(last_point_at=None, now=T0 + timedelta(minutes=5)), "waiting_first_fix")
        self.assertEqual(self.classify(last_point_at=None, now=T0 + timedelta(minutes=11)), "offline")
        self.assertEqual(self.classify(status="ended"), "ended")
        self.assertEqual(self.classify(status="ended", location_off=True), "ended")

    def test_a_stationary_phone_that_is_silent_is_offline_not_stationary(self):
        self.assertEqual(self.classify(in_open_stop=True, last_point_at=T0 + timedelta(minutes=10)), "offline")


class RetentionTests(LifecycleBase):
    def setUp(self):
        super().setUp()
        self.now = T0 + timedelta(days=400)
        self.old = self.make_track(self.asha, T0, ended_at=T0 + timedelta(hours=1))
        drive_points(self.old, 20)
        DutyTrackEvent.objects.create(
            track=self.old,
            employee=self.asha,
            kind="APP_KILLED",
            device_id="d",
            seq=900,
            started_at=T0 + timedelta(minutes=10),
        )
        journey.rebuild(self.old)
        self.old.refresh_from_db()
        self.recent = self.make_track(
            self.meena, self.now - timedelta(days=3), ended_at=self.now - timedelta(days=3) + timedelta(hours=1)
        )
        drive_points(self.recent, 10, t0=self.now - timedelta(days=3))

    def test_raw_rows_past_retention_go_and_segments_and_the_summary_stay(self):
        segments_before = list(
            DutyTrackSegment.objects.filter(track=self.old).order_by("seq_no").values_list("id", "kind", "duration_s")
        )
        summary_before = (self.old.distance_m, self.old.stop_count, self.old.travel_s, self.old.first_point_at)
        result = watchdog.purge_old(self.now)
        self.assertEqual((result["points"], result["events"], result["tracks"]), (20, 1, 1))
        self.assertEqual(DutyTrackPoint.objects.filter(track=self.old).count(), 0)
        self.assertEqual(DutyTrackEvent.objects.filter(track=self.old).count(), 0)
        self.assertEqual(
            list(
                DutyTrackSegment.objects.filter(track=self.old)
                .order_by("seq_no")
                .values_list("id", "kind", "duration_s")
            ),
            segments_before,
        )
        self.old.refresh_from_db()
        self.assertEqual(
            (self.old.distance_m, self.old.stop_count, self.old.travel_s, self.old.first_point_at), summary_before
        )
        self.assertIn("purgedAt", self.old.flags)
        self.assertEqual(DutyTrackPoint.objects.filter(track=self.recent).count(), 10)  # inside the window

    def test_the_window_follows_the_retention_setting(self):
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"retention_days": 2})
        result = watchdog.purge_old(self.now)
        self.assertEqual(result["tracks"], 2)
        self.assertEqual(DutyTrackPoint.objects.count(), 0)

    def test_an_active_track_is_never_purged(self):
        active = self.make_track(self.ravi, T0)
        drive_points(active, 5)
        watchdog.purge_old(self.now)
        self.assertEqual(DutyTrackPoint.objects.filter(track=active).count(), 5)

    def test_purging_twice_is_harmless_and_a_purged_journey_still_opens(self):
        watchdog.purge_old(self.now)
        again = watchdog.purge_old(self.now)
        self.assertEqual((again["points"], again["events"], again["tracks"]), (0, 0, 0))
        r = self.as_hr(self.hr_super, "get", f"/api/tracking/journeys/{self.old.pk}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["pathSource"], "segments")
        self.assertEqual(len(r.json()["segments"]), DutyTrackSegment.objects.filter(track=self.old).count())

    def test_a_large_purge_is_done_in_batches(self):
        with mock.patch.object(watchdog, "PURGE_BATCH", 7):
            result = watchdog.purge_old(self.now)
        self.assertEqual(result["points"], 20)


class GeocodeTests(LifecycleBase):
    def setUp(self):
        super().setUp()
        geocode._cache.clear()
        self.track = self.make_track(self.asha, T0, ended_at=T0 + timedelta(hours=2))
        places = [(0.0, 0.0), (0.0, 0.0), (800.0, 0.0), (1600.0, 0.0)]
        for n, (north, east) in enumerate(places, start=1):
            lat, lng = offset_latlng(LAT0, LNG0, north, east)
            DutyTrackSegment.objects.create(
                track=self.track,
                seq_no=n,
                kind="stop",
                started_at=T0 + timedelta(minutes=10 * n),
                ended_at=T0 + timedelta(minutes=10 * n + 6),
                duration_s=360,
                center_lat=round(lat, 6),
                center_lng=round(lng, 6),
            )
        DutyTrackSegment.objects.create(
            track=self.track, seq_no=9, kind="travel", started_at=T0, ended_at=T0 + timedelta(minutes=5)
        )

    def test_off_by_default_and_nothing_leaves_the_server(self):
        fetch = mock.Mock(return_value="x")
        self.assertEqual(
            geocode.run_geocode_worker(fetch=fetch), {"provider": "off", "looked_up": 0, "filled": 0, "cached": 0}
        )
        fetch.assert_not_called()
        with mock.patch("requests.get") as http:
            watchdog.run_watchdog(T0 + timedelta(hours=3))
        http.assert_not_called()
        self.assertFalse(DutyTrackSegment.objects.exclude(address="").exists())

    def test_with_nominatim_stops_get_addresses_one_lookup_per_place_at_most_one_per_second(self):
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"reverse_geocode_provider": "nominatim"})
        calls = []
        fetch = lambda lat, lng: calls.append((round(lat, 4), round(lng, 4))) or f"Place {len(calls)}"
        sleeps = []
        result = geocode.run_geocode_worker(fetch=fetch, sleep=sleeps.append)
        self.assertEqual(
            (result["looked_up"], result["filled"], result["cached"]), (3, 4, 1)
        )  # two stops at one place: one lookup
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(sleeps), 2)  # a pause before every lookup but the first
        self.assertTrue(all(0 < s <= 1.0 for s in sleeps))
        stops = DutyTrackSegment.objects.filter(kind="stop")
        self.assertFalse(stops.filter(address="").exists())
        self.assertEqual(DutyTrackSegment.objects.get(kind="travel").address, "")
        again = geocode.run_geocode_worker(fetch=fetch, sleep=sleeps.append)
        self.assertEqual((again["looked_up"], again["filled"]), (0, 0))  # nothing left to do

    def test_the_batch_is_limited_and_a_failed_lookup_is_skipped_not_fatal(self):
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"reverse_geocode_provider": "nominatim"})
        result = geocode.run_geocode_worker(limit=2, fetch=lambda lat, lng: "", sleep=lambda s: None)
        self.assertEqual((result["looked_up"], result["filled"]), (2, 0))
        self.assertEqual(DutyTrackSegment.objects.filter(kind="stop", address="").count(), 4)

    def test_the_real_lookup_names_the_application_and_survives_errors(self):
        class Reply:
            status_code = 200

            def json(self):
                return {"display_name": "Gandhipuram, Coimbatore"}

        with mock.patch("requests.get", return_value=Reply()) as http:
            self.assertEqual(geocode.fetch_nominatim(11.0, 77.0), "Gandhipuram, Coimbatore")
        headers = http.call_args.kwargs["headers"]
        self.assertIn("UKTextiles", headers["User-Agent"])
        self.assertEqual(http.call_args.kwargs["timeout"], geocode.TIMEOUT_S)
        with mock.patch("requests.get", side_effect=OSError("offline")):
            self.assertEqual(geocode.fetch_nominatim(11.0, 77.0), "")


class PunchPhotoTests(LifecycleBase):
    """The On-Duty punch takes one or two photos, as HR sets it (GeoTrackingSettings.onduty_punch_photos)."""

    PUNCH = "/api/on-duty-sessions/punch"

    def setUp(self):
        super().setUp()
        self.session = self.submit()

    def punch(self, *, photo=True, photo2=False, number=1, emp=None, **extra):
        data = {"latitude": "11.0", "longitude": "77.0", "punchNumber": str(number), **extra}
        if photo:
            data["photo"] = SimpleUploadedFile("first.jpg", b"FIRST-IMAGE", "image/jpeg")
        if photo2:
            data["photo2"] = SimpleUploadedFile("second.png", b"SECOND-IMAGE", "image/png")
        return self.client.post(self.PUNCH, data, **employee_headers(emp or self.asha))

    def policy(self, n):
        GeoTrackingSettings.objects.update_or_create(pk=1, defaults={"onduty_punch_photos": n})

    def test_one_photo_policy_accepts_one_photo_and_an_old_app(self):
        r = self.punch()
        self.assertEqual(r.status_code, 201, r.content)
        v = OnDutyPunchVerification.objects.get()
        self.assertTrue(v.photo)
        self.assertFalse(v.photo2)

    def test_one_photo_policy_still_keeps_a_second_photo_when_sent(self):
        self.assertEqual(self.punch(photo2=True).status_code, 201)
        v = OnDutyPunchVerification.objects.get()
        self.assertTrue(v.photo and v.photo2)

    def test_two_photo_policy_refuses_a_punch_without_the_second_photo(self):
        self.policy(2)
        r = self.punch()
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json(), {"error": "Two photos are required: please update the app", "code": "PHOTO2_REQUIRED"}
        )
        self.assertEqual(OnDutyPunchVerification.objects.count(), 0)

    def test_two_photo_policy_accepts_both(self):
        self.policy(2)
        r = self.punch(photo2=True)
        self.assertEqual(r.status_code, 201, r.content)
        v = OnDutyPunchVerification.objects.get()
        self.assertTrue(v.photo and v.photo2)

    def test_the_first_photo_is_still_required_under_either_policy(self):
        for n in (1, 2):
            self.policy(n)
            r = self.punch(photo=False, photo2=True)
            self.assertEqual(r.status_code, 400)
            self.assertNotIn("code", r.json())
            self.assertIn("selfie", r.json()["error"])

    def test_the_second_photo_is_checked_like_the_first(self):
        data = {
            "latitude": "11.0",
            "longitude": "77.0",
            "photo": SimpleUploadedFile("a.jpg", b"x", "image/jpeg"),
            "photo2": SimpleUploadedFile("b.gif", b"x", "image/gif"),
        }
        r = self.client.post(self.PUNCH, data, **employee_headers(self.asha))
        self.assertEqual(r.status_code, 400)
        self.assertIn(".gif", r.json()["error"])
        with mock.patch.object(GV, "MAX_PHOTO_BYTES", 5):
            data = {
                "latitude": "11.0",
                "longitude": "77.0",
                "photo": SimpleUploadedFile("a.jpg", b"123", "image/jpeg"),
                "photo2": SimpleUploadedFile("b.jpg", b"1234567", "image/jpeg"),
            }
            r = self.client.post(self.PUNCH, data, **employee_headers(self.asha))
        self.assertEqual(r.status_code, 400)
        self.assertIn("too large", r.json()["error"])
        self.assertEqual(OnDutyPunchVerification.objects.count(), 0)

    def test_the_photo_policy_matrix_over_every_policy_and_every_client(self):
        outcomes = {}
        for policy in (1, 2):
            for sends in ("old app (photo only)", "new app (both)"):
                OnDutyPunchVerification.objects.all().delete()
                self.policy(policy)
                r = self.punch(photo2=sends.startswith("new"))
                outcomes[(policy, sends)] = (r.status_code, r.json().get("code"))
        self.assertEqual(
            outcomes,
            {
                (1, "old app (photo only)"): (201, None),
                (1, "new app (both)"): (201, None),
                (2, "old app (photo only)"): (400, "PHOTO2_REQUIRED"),
                (2, "new app (both)"): (201, None),
            },
        )

    def test_the_status_payloads_say_how_many_photos_a_punch_takes(self):
        status = lambda: self.as_employee(self.asha, "get", "/api/on-duty-sessions/status").json()
        self.assertEqual(status()["requiredPhotos"], 1)
        self.policy(2)
        self.assertEqual(status()["requiredPhotos"], 2)
        self.assertEqual(self.as_employee(self.asha, "get", "/api/tracking/state").json()["punchPhotos"], 2)
        self.assertEqual(
            self.as_employee(self.asha, "get", "/api/attendance/geo-punch/status").json()["requiredPhotos"], 2
        )
        self.assertEqual(
            self.as_employee(self.ravi, "get", "/api/on-duty-sessions/status").json(),
            {"session": None, "punchVerifications": [], "requiredPhotos": 2},
        )

    def test_the_verification_dicts_say_whether_there_is_a_second_photo(self):
        self.punch()
        self.punch(photo2=True, number=2)
        rows = self.as_employee(self.asha, "get", "/api/on-duty-sessions/status").json()["punchVerifications"]
        self.assertEqual(
            [(r["punchNumber"], r["hasPhoto"], r["hasPhoto2"]) for r in rows], [(1, True, False), (2, True, True)]
        )
        hr_rows = self.as_hr(self.hr_super, "get", "/api/on-duty-punch-verifications").json()
        self.assertEqual({r["punchNumber"]: r["hasPhoto2"] for r in hr_rows}, {1: False, 2: True})

    def test_the_photo_endpoint_serves_the_second_image_for_n_2(self):
        self.punch(photo2=True)
        v = OnDutyPunchVerification.objects.get()
        url = f"/api/on-duty-punch-verifications/{v.pk}/photo"
        body = lambda r: b"".join(r.streaming_content)
        for who in (
            lambda **q: self.as_hr(self.hr_super, "get", url, **q),
            lambda **q: self.as_employee(self.asha, "get", url, **q),
        ):
            self.assertEqual(body(who()), b"FIRST-IMAGE")
            self.assertEqual(body(who(n=1)), b"FIRST-IMAGE")
            self.assertEqual(body(who(n=2)), b"SECOND-IMAGE")
        self.assertEqual(self.as_hr(self.hr_super, "get", url, n=3).status_code, 400)
        self.assertEqual(self.as_employee(self.meena, "get", url, n=2).status_code, 403)
        self.assertEqual(self.as_hr(self.hr_u2, "get", url, n=2).status_code, 403)  # another branch

    def test_asking_for_a_second_photo_that_does_not_exist_is_a_404(self):
        self.punch()
        v = OnDutyPunchVerification.objects.get()
        self.assertEqual(
            self.as_hr(self.hr_super, "get", f"/api/on-duty-punch-verifications/{v.pk}/photo", n=2).status_code, 404
        )
        self.assertEqual(
            self.as_hr(self.hr_super, "get", f"/api/on-duty-punch-verifications/{v.pk}/photo").status_code, 200
        )

    def test_the_rest_of_the_punch_is_unchanged(self):
        r = self.punch(photo2=True, accuracy="12.5", isMocked="true")
        body = r.json()
        self.assertEqual(
            (body["status"], body["punchNumber"], body["punchType"], body["sessionEnded"]),
            ("pending_hr_approval", 1, "IN", False),
        )
        v = OnDutyPunchVerification.objects.get()
        self.assertEqual((v.accuracy_m, v.is_mocked, v.status), (12.5, True, "pending"))


class LiveLocationPingUnchangedTests(LifecycleBase):
    def test_the_old_ping_flow_still_works_for_a_session_and_for_the_hr_toggle(self):
        ping = lambda emp: self.as_employee(
            emp, "post", "/api/live-location/ping", {"latitude": 11.0, "longitude": 77.0, "accuracy": 9}
        )
        r = ping(self.asha)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "TRACKING_DISABLED"))
        self.submit()
        self.assertEqual(ping(self.asha).status_code, 201)
        Employee.objects.filter(pk=self.ravi.pk).update(location_tracking_enabled=True)
        self.assertEqual(ping(self.ravi).status_code, 201)
        team = self.as_hr(self.hr_super, "get", "/api/live-location/team").json()
        self.assertEqual({row["employeeCode"] for row in team}, {"G3"})
