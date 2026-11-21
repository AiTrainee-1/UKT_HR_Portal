"""The automatic On-Duty tracking alerts (geo_tracking/alerts.py, owner brief 2026-11-21).

Pinned here:
  * the six kinds are detected from the data the phone and the server already keep: an open GPS_OFF event / the health
    block (location off), the phone's permission level, background restriction / battery optimisation, the watchdog's
    SIGNAL_LOST (a silent phone), the day's punches (no first punch in time; fewer than 4 at the check time or at Done), and
    a long wait without a punch (one reminder per wait);
  * the episode rules: a debounce before the employee is told (a blip never alerts), the Department Head after the grace
    period when it is still not fixed (never for a reminder), never twice in one episode, resolved when it clears, the same
    problem within the cooldown is the same episode, after it a new one;
  * each channel decides with its own settings only: Phone Notify Control's master / kind switch and recipients, WhatsApp
    Control's kind switch (OFF by default) and send queue; a kind no channel carries is not tracked at all;
  * the development machine's WhatsApp recipient lock still holds for these messages;
  * the settings (Geo Attendance -> Settings), the HR log endpoint and the notification's View target.

Run: DATABASE_URL= DB_TEST_NAME=test_uktex_geo_alerts py -3 manage.py test api.tests_geo_tracking_alerts --noinput
"""

from datetime import date, time, timedelta
from unittest import mock

from django.test import override_settings

from . import mobile_messages, notification_targets, push_templates, whatsapp_catalog, whatsapp_service
from .geo_tracking import alerts, watchdog
from .models import (
    DepartmentManager,
    DutyTrack,
    DutyTrackEvent,
    GeoTrackingAlert,
    GeoTrackingSettings,
    ManagerDepartmentAssignment,
    MobileMessageSettings,
    Notification,
    OnDutyPunchVerification,
    TrackingDevice,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .tests_geo_tracking_support import T0, GeoBase
from .tests_whatsapp_support import META, NO_META, FakeMeta, approve_templates

A = GeoTrackingAlert
DAY = date(2026, 10, 28)  # T0 is 10:00 IST on this day
KINDS = (
    "location_off",
    "permission_restricted",
    "background_restricted",
    "tracking_failure",
    "missing_punch",
    "punch_reminder",
)
WA_SWITCHES = (
    "geo_location_off_enabled",
    "geo_permission_restricted_enabled",
    "geo_background_restricted_enabled",
    "geo_missing_punch_enabled",
    "geo_punch_reminder_enabled",
    "geo_tracking_failure_enabled",
)


def at(minutes: float):
    return T0 + timedelta(minutes=minutes)


@override_settings(**NO_META)
class AlertBase(GeoBase):
    def setUp(self):
        super().setUp()
        self.head = self.employee("H1", "Suresh", "R", self.ho)
        manager = DepartmentManager.objects.create(employee=self.head)
        ManagerDepartmentAssignment.objects.create(manager=manager, department=self.dept)
        self.track = self.make_track(self.asha, T0, last_device_id="dev-1")
        self.seq = 0
        # a first punch at 10:05 keeps the Missing Geo-Punch rule quiet unless a test is about it
        self.punch(10, 5)

    # ── builders ──────────────────────────────────────────────────────────

    def punch(self, hour: int, minute: int, emp=None, number: int | None = None):
        emp = emp or self.asha
        n = number or OnDutyPunchVerification.objects.filter(employee=emp, punch_date=DAY).count() + 1
        return OnDutyPunchVerification.objects.create(
            session=self.track.session if emp == self.asha else DutyTrack.objects.get(employee=emp).session,
            employee=emp,
            punch_date=DAY,
            punch_time=time(hour, minute),
            punch_type="IN" if n % 2 else "OUT",
            punch_number=n,
            latitude=11.0,
            longitude=77.0,
            photo="on_duty_punch_verifications/test.jpg",
        )

    def no_punches(self):
        OnDutyPunchVerification.objects.filter(employee=self.asha).delete()

    def event(self, kind: str, minutes: float, track=None, ended: float | None = None):
        track = track or self.track
        self.seq += 1
        return DutyTrackEvent.objects.create(
            track=track,
            employee_id=track.employee_id,
            device_id="dev-1",
            seq=self.seq,
            kind=kind,
            started_at=at(minutes),
            ended_at=at(ended) if ended is not None else None,
        )

    def device(self, emp=None, device_id="dev-1", seen: float = 1, **health):
        values = {"permission_level": "always", "location_enabled": True, "last_seen_at": at(seen)}
        values.update(health)
        return TrackingDevice.objects.update_or_create(employee=emp or self.asha, device_id=device_id, defaults=values)[
            0
        ]

    def tick(self, minutes: float):
        return alerts.run_alerts(at(minutes))

    def settings(self, **values):
        s = GeoTrackingSettings.get()
        for k, v in values.items():
            setattr(s, k, v)
        s.save()

    def notes(self, source="geo_location_off", **filters):
        return Notification.objects.filter(source=source, **filters).order_by("id")

    def episode(self, kind="location_off", **filters):
        return A.objects.filter(kind=kind, **filters).order_by("-id").first()


class LocationOffTests(AlertBase):
    def test_the_employee_is_alerted_after_the_debounce_then_the_head_after_the_grace(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(6)
        alert = self.episode()
        self.assertIsNotNone(alert)
        self.assertEqual(alert.detected_at, at(5))  # when it really went off (the event), not when it was seen
        self.assertIsNone(alert.employee_sent_at)  # still inside the 2-minute debounce
        self.assertFalse(self.notes().exists())

        self.assertEqual(self.tick(8).get("employee"), 1)
        note = self.notes().get()
        self.assertEqual((note.employee_id, note.type), (self.asha.pk, "on_duty"))
        self.assertEqual(note.title, "Location is turned off")
        self.assertIn("10:05 AM", note.message)
        self.assertIn("turn Location back on", note.message)
        self.assertEqual(note.dedupe_key, f"geoalert:{alert.pk}:employee:{self.track.session_id}")
        alert.refresh_from_db()
        self.assertEqual((alert.employee_push, alert.employee_notification_id), (alerts.OUT_MADE, note.pk))
        self.assertEqual(alert.employee_whatsapp, alerts.OUT_OFF)  # WhatsApp Control: off by default

        self.tick(20)  # the head is due 15 minutes after the employee's alert (8 + 15 = 23)
        self.assertFalse(self.notes(employee=self.head).exists())
        self.assertEqual(self.tick(24).get("hod"), 1)
        hod = self.notes(employee=self.head).get()
        self.assertEqual(hod.type, "on_duty")
        self.assertIn("Asha Kumar (G1)", hod.message)
        self.assertIn("since 10:05 AM", hod.message)
        self.assertIn("alerted at 10:08 AM", hod.message)
        alert.refresh_from_db()
        self.assertEqual((alert.hod_id, alert.hod_push), (self.head.pk, alerts.OUT_MADE))

        # never twice in one episode, however many runs see it
        for minute in (26, 30, 60):
            self.tick(minute)
        self.assertEqual(self.notes().count(), 2)
        self.assertEqual(A.objects.count(), 1)

    def test_a_blip_inside_the_debounce_never_alerts(self):
        off = self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(6)
        self.assertEqual(A.objects.count(), 1)
        DutyTrackEvent.objects.filter(pk=off.pk).update(ended_at=at(6.5))
        self.tick(8)
        self.assertEqual(A.objects.count(), 0)  # an episode never alerted is not kept
        self.assertFalse(self.notes().exists())

    def test_fixed_resolves_the_episode_and_a_quick_recurrence_is_the_same_episode(self):
        off = self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        DutyTrackEvent.objects.filter(pk=off.pk).update(ended_at=at(9))
        self.tick(10)
        alert = self.episode()
        self.assertEqual((alert.resolved_at, alert.resolution), (at(10), A.RESOLVED_FIXED))
        self.assertFalse(self.notes(employee=self.head).exists())  # fixed before the grace: the head is never told

        # off again 20 minutes later (inside the 30-minute cooldown): the same episode reopens, nobody is told again
        self.event(DutyTrackEvent.KIND_GPS_OFF, 30)
        self.tick(33)
        self.assertEqual(A.objects.count(), 1)
        alert.refresh_from_db()
        self.assertIsNone(alert.resolved_at)
        self.assertEqual(self.notes(employee=self.asha).count(), 1)

    def test_after_the_cooldown_it_is_a_new_episode(self):
        off = self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        DutyTrackEvent.objects.filter(pk=off.pk).update(ended_at=at(9))
        self.tick(10)
        self.event(DutyTrackEvent.KIND_GPS_OFF, 50)  # 40 minutes after it ended: past the cooldown
        self.tick(51)
        self.tick(53)
        self.assertEqual(A.objects.filter(kind="location_off").count(), 2)
        self.assertEqual(self.notes(employee=self.asha).count(), 2)

    def test_the_health_block_alone_also_counts(self):
        self.device(location_enabled=False)
        self.tick(4)
        self.tick(7)
        self.assertEqual(self.notes().count(), 1)
        self.assertEqual(self.episode().detail["seenBy"], "health")

    def test_the_end_of_the_track_resolves_its_episodes(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        DutyTrack.objects.filter(pk=self.track.pk).update(
            status=DutyTrack.STATUS_ENDED, ended_at=at(12), end_reason=DutyTrack.END_ADMIN
        )
        self.tick(30)
        alert = self.episode()
        self.assertEqual(alert.resolution, A.RESOLVED_TRACK_ENDED)
        self.assertFalse(self.notes(employee=self.head).exists())


class PhoneStateTests(AlertBase):
    def test_a_permission_short_of_always_alerts_with_how_to_fix_it(self):
        self.device(permission_level="while_using")
        self.tick(3)
        self.tick(6)
        note = self.notes("geo_permission_restricted").get()
        self.assertEqual(note.title, "Allow location all the time")
        self.assertIn("'Only while using the app'", note.message)
        self.assertIn("Allow all the time", note.message)

    def test_always_or_an_unknown_permission_never_alerts(self):
        for level in ("always", "unknown"):
            self.device(permission_level=level)
            self.tick(3)
            self.tick(10)
        self.assertFalse(A.objects.exists())

    def test_a_phone_not_heard_from_during_the_track_says_nothing(self):
        self.device(permission_level="denied", seen=-60)  # last seen an hour before the track started
        self.tick(3)
        self.tick(10)
        self.assertFalse(A.objects.exists())

    def test_battery_optimisation_or_background_restriction_alerts(self):
        self.device(battery_optimised=True)
        self.tick(3)
        self.tick(6)
        note = self.notes("geo_background_restricted").get()
        self.assertIn("battery optimisation is on", note.message)
        self.assertIn("Unrestricted", note.message)
        self.device(battery_optimised=False, background_restricted=False)
        self.tick(8)
        self.assertEqual(self.episode("background_restricted").resolution, A.RESOLVED_FIXED)

    def test_a_silent_phone_is_a_tracking_failure_found_by_the_watchdog(self):
        # nothing has arrived since the track started: after the signal-lost time (10 minutes) the watchdog writes
        # SIGNAL_LOST and the alert goes at once (the silence itself was the wait)
        watchdog.run_watchdog(at(5))
        self.assertFalse(A.objects.exists())
        result = watchdog.run_watchdog(at(11))
        self.assertEqual(result["signalLost"], 1)
        self.assertEqual(result["alerts"].get("employee"), 1)
        note = self.notes("geo_tracking_failure").get()
        self.assertEqual(note.title, "On-Duty tracking stopped")
        self.assertIn("since 10:00 AM", note.message)
        # the phone talks again: the next batch closes SIGNAL_LOST and the episode is fixed
        DutyTrackEvent.objects.filter(kind=DutyTrackEvent.KIND_SIGNAL_LOST).update(ended_at=at(13))
        DutyTrack.objects.filter(pk=self.track.pk).update(last_point_at=at(13))
        watchdog.run_watchdog(at(14))
        self.assertEqual(self.episode("tracking_failure").resolution, A.RESOLVED_FIXED)


class MissingPunchTests(AlertBase):
    def test_no_first_punch_within_the_wait(self):
        self.no_punches()
        self.tick(29)
        self.assertFalse(A.objects.exists())
        self.tick(31)
        note = self.notes("geo_missing_punch").get()
        self.assertEqual(note.title, "Geo-Punch missing")
        self.assertIn("no Geo-Punch recorded since the On-Duty started at 10:00 AM", note.message)
        self.assertEqual(self.episode("missing_punch").key, alerts.KEY_FIRST)
        self.tick(46)  # 15 minutes later still nothing: the head is told
        self.assertEqual(self.notes("geo_missing_punch", employee=self.head).count(), 1)
        self.punch(10, 50)
        self.tick(52)
        self.assertEqual(self.episode("missing_punch").resolution, A.RESOLVED_FIXED)

    def test_fewer_than_four_punches_at_the_check_time(self):
        self.punch(13, 0)  # 2 of 4 by 19:00
        self.tick(8 * 60 + 59)  # 18:59 IST
        self.assertFalse(A.objects.filter(kind="missing_punch").exists())
        self.tick(9 * 60 + 1)  # 19:01
        note = self.notes("geo_missing_punch").get()
        self.assertIn("only 2 of the day's 4 punches are recorded", note.message)
        self.assertEqual(self.episode("missing_punch").key, alerts.KEY_DAY)
        # the punches arrive: fixed (the 4th ends the track in real life; the day episode closes as fixed)
        self.punch(19, 5)
        self.punch(19, 6)
        self.tick(9 * 60 + 8)
        self.assertEqual(self.episode("missing_punch").resolution, A.RESOLVED_FIXED)
        self.assertFalse(self.notes("geo_missing_punch", employee=self.head).exists())

    def test_marking_the_duty_done_with_punches_missing(self):
        DutyTrack.objects.filter(pk=self.track.pk).update(
            status=DutyTrack.STATUS_ENDED, ended_at=at(6 * 60), end_reason=DutyTrack.END_MANUAL
        )
        self.tick(6 * 60 + 2)  # 16:02, two minutes after Done with 1 of 4
        note = self.notes("geo_missing_punch").get()
        self.assertIn("only 1 of the day's 4 punches is recorded", note.message)
        self.assertIn("raise a Missing Punch request", note.message)
        self.tick(6 * 60 + 20)  # still missing after the grace: the head
        self.assertEqual(self.notes("geo_missing_punch", employee=self.head).count(), 1)
        alerts.run_alerts(at(14 * 60 + 5))  # 00:05 the next day
        self.assertEqual(self.episode("missing_punch").resolution, A.RESOLVED_DAY_OVER)

    def test_the_check_time_and_the_wait_follow_the_settings(self):
        self.no_punches()
        self.settings(missing_first_punch_minutes=60)
        self.tick(45)
        self.assertFalse(A.objects.exists())
        self.tick(61)
        self.assertEqual(self.notes("geo_missing_punch").count(), 1)


class ReminderTests(AlertBase):
    def test_one_reminder_per_wait_and_never_to_the_head(self):
        self.tick(3 * 60 + 4)  # 13:04: 2 h 59 min after the 10:05 punch
        self.assertFalse(A.objects.filter(kind="punch_reminder").exists())
        self.tick(3 * 60 + 6)  # 13:06
        note = self.notes("geo_punch_reminder").get()
        self.assertEqual(note.title, "Geo-Punch reminder")
        self.assertIn("since your punch at 10:05 AM", note.message)
        for minute in (3 * 60 + 30, 4 * 60, 5 * 60):
            self.tick(minute)
        self.assertEqual(self.notes("geo_punch_reminder").count(), 1)
        self.assertFalse(Notification.objects.filter(employee=self.head).exists())
        # a punch starts a new wait: the reminder is over, the next one comes three hours after it
        self.punch(15, 10)
        self.tick(5 * 60 + 12)
        self.assertEqual(self.episode("punch_reminder").resolution, A.RESOLVED_FIXED)
        self.tick(8 * 60 + 11)  # 18:11
        self.assertEqual(self.notes("geo_punch_reminder").count(), 2)

    def test_no_reminder_while_a_missing_punch_alert_speaks(self):
        self.no_punches()
        self.tick(31)  # Missing Geo-Punch (first)
        self.tick(3 * 60 + 1)
        self.assertFalse(A.objects.filter(kind="punch_reminder").exists())

    def test_the_wait_follows_the_settings(self):
        self.settings(punch_reminder_minutes=60)
        self.tick(66)
        self.assertEqual(self.notes("geo_punch_reminder").count(), 1)


class ChannelAndSwitchTests(AlertBase):
    def test_an_employee_outside_the_phone_recipients_gets_nothing(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"recipient_mode": "production"})
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(24)
        self.assertFalse(Notification.objects.filter(source="geo_location_off").exists())
        alert = self.episode()
        self.assertEqual((alert.employee_push, alert.hod_push), (alerts.OUT_NOT_RECIPIENT, alerts.OUT_NOT_RECIPIENT))

    def test_a_kind_no_channel_carries_is_not_tracked(self):
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["geo_location_off"]})
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.assertFalse(A.objects.exists())
        MobileMessageSettings.objects.filter(pk=1).update(push_enabled=False, disabled_types=[])
        self.tick(9)
        self.assertFalse(A.objects.exists())

    def test_the_head_stage_follows_the_settings(self):
        self.settings(alert_hod_enabled=False)
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(40)
        self.assertFalse(self.notes(employee=self.head).exists())
        self.settings(alert_hod_enabled=True, alert_hod_grace_minutes=5)
        self.tick(41)
        self.assertEqual(self.notes(employee=self.head).count(), 1)

    def test_no_department_head_is_recorded_not_retried(self):
        DepartmentManager.objects.all().delete()
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(24)
        self.tick(30)
        alert = self.episode()
        self.assertEqual(
            (alert.hod_push, alert.hod_whatsapp, alert.hod_id), (alerts.OUT_NO_HEAD, alerts.OUT_NO_HEAD, None)
        )

    def test_a_head_is_never_told_about_themselves(self):
        head_track = self.make_track(self.head, T0, last_device_id="dev-h")
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5, track=head_track)
        self.tick(8)
        self.tick(24)
        alert = A.objects.get(track=head_track, kind="location_off")
        self.assertEqual(alert.hod_push, alerts.OUT_NO_HEAD)

    def test_switching_the_automation_off_ends_every_open_episode(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.settings(alerts_enabled=False)
        self.tick(24)
        self.assertEqual(self.episode().resolution, A.RESOLVED_ALERTS_OFF)
        self.assertFalse(self.notes(employee=self.head).exists())

    def test_whatsapp_kinds_start_off(self):
        s = WhatsAppSettings.get()
        for column in WA_SWITCHES:
            self.assertFalse(getattr(s, column), column)
        for key in alerts.KINDS.values():
            for doc_type in filter(None, (key.whatsapp, key.whatsapp_hod)):
                self.assertIsNotNone(whatsapp_service.switch_off_reason(doc_type, "", s), doc_type)


@override_settings(**META)
class WhatsAppChannelTests(AlertBase):
    def setUp(self):
        super().setUp()
        self.meta = FakeMeta.install(self)
        approve_templates(*whatsapp_catalog.types_in("geo_alerts"))
        type(self.asha).objects.filter(pk=self.asha.pk).update(phone="9123456780")
        type(self.head).objects.filter(pk=self.head.pk).update(phone="9876543210")
        type(self.meena).objects.filter(pk=self.meena.pk).update(phone="9000000002")

    def switch_on(self, *columns):
        WhatsAppSettings.get()
        WhatsAppSettings.objects.update(**{c: True for c in columns})

    def test_each_channel_decides_with_its_own_switch(self):
        self.switch_on("geo_location_off_enabled")
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["geo_location_off"]})
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        alert = self.episode()
        self.assertEqual((alert.employee_push, alert.employee_whatsapp), (alerts.OUT_OFF, alerts.OUT_QUEUED))
        self.assertFalse(Notification.objects.filter(source="geo_location_off").exists())
        sent = self.meta.sent[-1]
        self.assertEqual((sent["to"], sent["template"]), ("919123456780", "hrms_geo_location_off"))
        self.assertEqual(sent["params"]["since"], "10:05 AM")
        self.tick(24)  # the head's copy follows the same switch, with its own template
        sent = self.meta.sent[-1]
        self.assertEqual((sent["to"], sent["template"]), ("919876543210", "hrms_geo_location_off_hod"))
        self.assertEqual(sent["params"]["employee_code"], "G1")
        self.assertEqual(sent["params"]["alerted_at"], "10:08 AM")
        log = WhatsAppMessageLog.objects.get(document_type="geo_location_off_hod")
        self.assertEqual(log.dedupe_key, f"geoalert:{alert.pk}:hod:{self.track.session_id}")

    def test_with_its_switch_off_whatsapp_sends_nothing(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(24)
        self.assertEqual(self.meta.sent, [])
        self.assertEqual(self.episode().employee_whatsapp, alerts.OUT_OFF)
        self.assertEqual(self.notes().count(), 2)  # the phone carried both stages on its own

    def test_the_development_machines_recipient_lock_still_holds(self):
        self.switch_on("geo_location_off_enabled")
        meena_track = self.make_track(self.meena, T0, last_device_id="dev-2")
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5, track=meena_track)
        with (
            override_settings(WHATSAPP_ONLY_TO_EMPLOYEES=["G1"]),
            mock.patch("api.whatsapp_service.local_dev_server", return_value=True),
        ):
            self.tick(8)
        self.assertEqual({s["to"] for s in self.meta.sent}, {"919123456780"})  # G1 only: never anybody else
        refused = WhatsAppMessageLog.objects.get(employee=self.meena)
        self.assertNotEqual(refused.status, "sent")
        self.assertIn(whatsapp_service.DEV_SAFETY, refused.error_message)


class RegistryTests(AlertBase):
    def test_phone_notify_control_lists_the_six_switches_in_the_owners_words(self):
        rows = [r for r in mobile_messages.controls() if r["group"] == "tracking"]
        self.assertEqual(
            [r["label"] for r in rows],
            [
                "Location turned off alert",
                "Background location permission restricted alert",
                "Background app restriction alert",
                "Missing Geo-Punch alert",
                "Geo-Punch reminder",
                "On-Duty tracking failure alert",
            ],
        )
        self.assertEqual({r["groupLabel"] for r in rows}, {"On-Duty tracking alerts"})
        for r in rows:
            self.assertEqual(mobile_messages.category_of_key(r["key"]), "on_duty")
            self.assertIsNotNone(push_templates.spec(r["key"]), r["key"])
            self.assertIn(r["key"], mobile_messages.valid_keys())
        self.assertEqual({k.source for k in alerts.KINDS.values()}, {r["key"] for r in rows})

    def test_whatsapp_control_has_its_own_six_switches_and_two_templates_each(self):
        self.assertEqual(len(whatsapp_catalog.types_in("geo_alerts")), 11)
        self.assertFalse(set(whatsapp_catalog.individually_switched()) & set(whatsapp_catalog.types_in("geo_alerts")))
        for kind in alerts.KINDS.values():
            spec = whatsapp_catalog.get(kind.whatsapp)
            self.assertEqual(spec.default_template_name, f"hrms_{kind.whatsapp}")
            if kind.whatsapp_hod:
                hod = whatsapp_catalog.get(kind.whatsapp_hod)
                self.assertEqual((hod.switch, hod.escalation_of), (spec.switch, spec.key))

    def test_the_whatsapp_settings_answer_shows_and_saves_the_switches(self):
        body = self.as_hr(self.hr_super, "get", "/api/whatsapp-control/settings").json()
        mine = {f["key"]: f for f in body["features"] if f["group"] == "geo_alerts"}
        self.assertEqual(len(mine), 6)
        self.assertFalse(any(f["enabled"] for f in mine.values()))
        self.assertIn("geo_alerts", [g["key"] for g in body["groups"]])
        self.assertEqual(body["messageTypes"]["geo_location_off_hod"]["switches"], ["geoLocationOffEnabled"])
        r = self.as_hr(self.hr_super, "patch", "/api/whatsapp-control/settings", {"geoMissingPunchEnabled": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(WhatsAppSettings.get().geo_missing_punch_enabled)

    def test_the_phone_controls_switch_one_kind(self):
        r = self.as_hr(
            self.hr_super, "put", "/api/mobile-app/messages/controls", {"types": {"geo_punch_reminder": False}}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("geo_punch_reminder", MobileMessageSettings.get().disabled_types)

    def test_the_view_target_opens_on_duty_or_the_heads_approvals(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(24)
        mine = notification_targets.target_for(self.notes(employee=self.asha).get())
        self.assertEqual((mine["kind"], mine["id"], mine["role"]), ("on_duty", self.track.session_id, "self"))
        head = notification_targets.target_for(self.notes(employee=self.head).get())
        self.assertEqual(
            (head["kind"], head["role"], head["category"], head["id"]),
            ("approvals", "approver", "on_duty", self.track.session_id),
        )


class SettingsAndLogTests(AlertBase):
    def test_the_settings_read_and_write_the_timing(self):
        body = self.as_hr(self.hr_editor, "get", "/api/tracking/settings").json()
        self.assertEqual(
            {k: body[k] for k in ("alertsEnabled", "alertDebounceMinutes", "alertHodGraceMinutes", "punchCheckTime")},
            {"alertsEnabled": True, "alertDebounceMinutes": 2, "alertHodGraceMinutes": 15, "punchCheckTime": "19:00"},
        )
        r = self.as_hr(
            self.hr_editor,
            "put",
            "/api/tracking/settings",
            {
                "alertDebounceMinutes": 5,
                "punchCheckTime": "18:30",
                "punchReminderMinutes": 120,
                "alertHodEnabled": False,
            },
        )
        self.assertEqual(r.status_code, 200, r.content)
        s = GeoTrackingSettings.get()
        self.assertEqual(
            (s.alert_debounce_minutes, s.punch_check_time, s.punch_reminder_minutes, s.alert_hod_enabled),
            (5, time(18, 30), 120, False),
        )
        for bad in ({"alertDebounceMinutes": 99}, {"punchCheckTime": "10:00"}, {"punchReminderMinutes": 5}):
            r = self.as_hr(self.hr_editor, "put", "/api/tracking/settings", bad)
            self.assertEqual(r.status_code, 400, bad)

    def test_hr_reads_the_log_in_their_scope(self):
        self.event(DutyTrackEvent.KIND_GPS_OFF, 5)
        self.tick(8)
        self.tick(24)
        # (T0 is in October; the default window is the last 7 days of the real clock)
        r = self.as_hr(self.hr_super, "get", "/api/tracking/live/alerts", days=31)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["total"], body["open"], body["openByKind"]), (1, 1, {"location_off": 1}))
        row = body["results"][0]
        self.assertEqual((row["kind"], row["employeeCode"], row["open"]), ("location_off", "G1", True))
        self.assertEqual([s["stage"] for s in row["stages"]], ["employee", "hod"])
        self.assertEqual(row["stages"][0]["push"]["outcome"], "made")
        self.assertEqual(row["stages"][1]["recipientName"], "Suresh R")
        self.assertEqual(row["stages"][0]["whatsapp"]["label"], "Switched off")
        self.assertEqual(row["summary"], "Location off since 10:05 AM")
        # the Head Office's login sees it, Unit 2's does not; an employee token and a role without the page are refused
        self.assertEqual(self.as_hr(self.hr_ho, "get", "/api/tracking/live/alerts", status="open").json()["total"], 1)
        self.assertEqual(self.as_hr(self.hr_u2, "get", "/api/tracking/live/alerts", status="open").json()["total"], 0)
        self.assertEqual(self.as_employee(self.asha, "get", "/api/tracking/live/alerts").status_code, 403)
        self.assertEqual(self.as_hr(self.hr_nogeo, "get", "/api/tracking/live/alerts").status_code, 403)
        self.assertEqual(self.as_hr(self.hr_super, "get", "/api/tracking/live/alerts", kind="nope").status_code, 400)
        self.assertEqual(
            self.as_hr(self.hr_super, "get", "/api/tracking/live/alerts", status="open").json()["total"], 1
        )


class KindsCoverTests(AlertBase):
    def test_every_kind_has_its_label_and_channels(self):
        self.assertEqual(tuple(alerts.KINDS), KINDS)
        self.assertEqual(tuple(k for k, _ in A.KIND_CHOICES), KINDS)
