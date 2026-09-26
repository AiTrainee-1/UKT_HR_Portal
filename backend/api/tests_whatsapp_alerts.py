"""Automatic WhatsApp attendance alerts, punch reminders and Geo Attendance messages. WAClient is always mocked.

Punches in these tests are written through the SAME path the biometric device uses
(biometric_sync._ingest_punches), which also writes the legacy Attendance presence row for everyone who punches. Tests
that create AttendanceLog rows by hand miss that row, and missed the bug where it made the alert job treat every employee
who had punched as "HR already decided their day" and message nobody who had punched at all.
"""

from datetime import date, datetime, time
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings

from . import whatsapp_service
from .attendance_final import _holiday_dates_for_month
from .biometric_sync import _ingest_punches
from .clock import FACTORY_TZ
from .geo_attendance_views import resolve_on_duty_punch_hr, resolve_on_duty_session_hr, resolve_on_duty_session_hod
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    LeaveRequest,
    OnDutyPunchVerification,
    OnDutySession,
    PayrollSettings,
    ShiftTemplate,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .shift_engine import _t2s
from .whatsapp_alerts import (
    QUOTES,
    collapse_taps,
    due_missing_slot,
    due_reminder_slot,
    expected_slots,
    run_attendance_alerts,
    slot_is_pending,
)

CONFIG = dict(
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    WHATSAPP_SEND_DELAY_SECONDS=0,
)

WED = date(2026, 9, 23)  # an ordinary working Wednesday
SAT = date(2026, 9, 26)
SUN = date(2026, 9, 27)


def at(d, h, m=0):
    return datetime(d.year, d.month, d.day, h, m)


def hm(text: str) -> time:
    """ "09:14:23" / "9:05" -> time"""
    parts = [int(p) for p in text.split(":")]
    return time(*parts)


def _ok(msg_id="WAID"):
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": msg_id}}}
    return r


def _switches(**kw):
    defaults = dict(
        absent_alert_enabled=True,
        late_alert_enabled=True,
        four_punch_alert_enabled=True,
        missing_punch_alert_enabled=True,
    )
    defaults.update(kw)
    WhatsAppSettings.objects.update_or_create(pk=1, defaults=defaults)


@override_settings(**CONFIG)
class AlertBase(TestCase):
    """Shift 09:00-18:00, 15 min grace, lunch out at 13:00 for 60 min (back 14:00)."""

    def setUp(self):
        _holiday_dates_for_month.cache_clear()
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        self.shift = self.make_shift("Day", "09:00", "18:00", grace=15, lunch_out="13:00", lunch_minutes=60)
        self.emp = self.make_employee("A1", "Asha", "Kumar")
        _switches()
        patcher = mock.patch("api.whatsapp_service.requests.post", return_value=_ok())
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def make_shift(self, name, start, end, grace=15, lunch_out=None, lunch_minutes=60):
        return ShiftTemplate.objects.create(
            name=name,
            shift_type="staff",
            start_time=hm(start),
            end_time=hm(end),
            grace_period_minutes=grace,
            first_half_end=hm(lunch_out) if lunch_out else None,
            lunch_duration_minutes=lunch_minutes,
            lunch_grace_minutes=10,
        )

    def make_employee(self, code, first, last, phone="9000000001", shift=None, **kw):
        emp = Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name=last,
            phone=phone,
            employment_type=kw.pop("employment_type", "staff"),
            status=kw.pop("status", "active"),
            **kw,
        )
        EmployeeShiftAssignment.objects.create(
            employee=emp,
            shift=shift or self.shift,
            effective_from=date(2026, 1, 1),
            saturday_off=kw.get("saturday_off", False),
        )
        return emp

    def punch(self, emp, d, *times):
        """Record punches the way the biometric device does, presence row included."""
        rows = [
            (emp.employee_code, d, t if isinstance(t, time) else hm(t), "IN" if i % 2 == 0 else "OUT")
            for i, t in enumerate(times)
        ]
        _ingest_punches(rows, None, "biometric:test")

    def run_at(self, d, h, m=0):
        return run_attendance_alerts(now=at(d, h, m))

    def sent_texts(self):
        return [c.kwargs["json"]["message"] for c in self.post.call_args_list]

    def logs(self, doc_type=None):
        qs = WhatsAppMessageLog.objects.all()
        return qs.filter(document_type=doc_type) if doc_type else qs

    def tags_sent(self):
        """The dedupe tags sent so far, in the order they were sent: late, four1, missing2 ..."""
        return [k.split(":")[0] for k in WhatsAppMessageLog.objects.order_by("id").values_list("dedupe_key", flat=True)]


class MasterSwitchTests(AlertBase):
    def test_nothing_happens_with_every_switch_off(self):
        _switches(
            absent_alert_enabled=False,
            late_alert_enabled=False,
            four_punch_alert_enabled=False,
            missing_punch_alert_enabled=False,
        )
        self.assertEqual(self.run_at(WED, 10), {})
        self.post.assert_not_called()

    @override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN="")
    def test_nothing_happens_when_whatsapp_is_not_configured(self):
        self.assertEqual(self.run_at(WED, 10), {})
        self.assertFalse(self.logs().exists())

    def test_each_alert_obeys_only_its_own_switch(self):
        self.punch(self.emp, WED, "09:40")
        _switches(late_alert_enabled=False)
        self.assertNotIn("late_alert", self.run_at(WED, 9, 41))
        _switches(late_alert_enabled=True)
        self.assertEqual(self.run_at(WED, 9, 42), {"late_alert": 1})

    def test_the_attendance_master_switch_turns_all_of_them_off(self):
        self.punch(self.emp, WED, "09:40")
        WhatsAppSettings.objects.filter(pk=1).update(attendance_alerts_enabled=False)
        for h, m in ((8, 55), (9, 41), (9, 20), (10, 0), (18, 30)):
            self.assertEqual(self.run_at(WED, h, m), {})
        self.post.assert_not_called()


class HelperTests(SimpleTestCase):
    def test_a_second_tap_on_the_device_is_not_another_punch(self):
        s = _t2s
        self.assertEqual(collapse_taps([s(time(9, 0, 5)), s(time(9, 0, 20))]), [s(time(9, 0, 5))])
        self.assertEqual(collapse_taps([s(time(9, 0)), s(time(9, 4, 59))]), [s(time(9, 0))])
        # five minutes apart are two punches; the order given never matters
        self.assertEqual(len(collapse_taps([s(time(9, 5)), s(time(9, 0))])), 2)
        self.assertEqual(collapse_taps([]), [])

    def shift(self, **kw):
        base = dict(
            start_time=time(9, 0),
            end_time=time(18, 0),
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        base.update(kw)
        return mock.Mock(**base)

    def test_a_shift_with_lunch_expects_four_punches_at_its_own_times(self):
        slots = expected_slots(self.shift(), strict=True)
        self.assertEqual([s.name for s in slots], ["Morning check-in", "Lunch-out", "Lunch-in", "Evening check-out"])
        self.assertEqual([s.expected_s for s in slots], [9 * 3600, 13 * 3600, 14 * 3600, 18 * 3600])
        self.assertEqual([s.position for s in slots], ["1 of 4", "2 of 4", "3 of 4", "4 of 4"])
        # different shift, different times
        slots = expected_slots(
            self.shift(
                start_time=time(8, 30), first_half_end=time(12, 30), lunch_duration_minutes=45, end_time=time(17, 30)
            ),
            True,
        )
        self.assertEqual(
            [s.expected_s for s in slots], [8 * 3600 + 1800, 12 * 3600 + 1800, 13 * 3600 + 15 * 60, 17 * 3600 + 1800]
        )

    def test_simple_mode_or_no_lunch_or_a_lunch_that_doesnt_fit_expects_two(self):
        for shift, strict in (
            (self.shift(), False),
            (self.shift(first_half_end=None), True),
            (self.shift(first_half_end=time(8, 0)), True),  # lunch before the shift starts
            (self.shift(first_half_end=time(17, 30)), True),  # lunch ends after the shift
        ):
            slots = expected_slots(shift, strict)
            self.assertEqual([s.name for s in slots], ["Check-in", "Check-out"])
            self.assertEqual([s.position for s in slots], ["1 of 2", "2 of 2"])

    def test_which_punch_is_owed(self):
        slots = expected_slots(self.shift(), strict=True)
        owed = lambda n: [s.number for s in slots if slot_is_pending(s, slots, n)]  # noqa: E731
        self.assertEqual(owed(0), [1])
        self.assertEqual(owed(1), [2, 4])  # lunch-out, or the check-out if they skip lunch
        self.assertEqual(owed(2), [3])  # out for lunch: only lunch-in is owed, never the check-out
        self.assertEqual(owed(3), [4])
        self.assertEqual(owed(4), [])

    def test_reminder_and_missing_windows(self):
        slots = expected_slots(self.shift(), strict=True)
        lead, wait, end_s = 300, 1200, 18 * 3600
        nine = 9 * 3600
        self.assertIsNone(due_reminder_slot(slots, 0, nine - 301, lead))
        self.assertEqual(due_reminder_slot(slots, 0, nine - 300, lead).number, 1)  # 8:55:00
        self.assertEqual(due_reminder_slot(slots, 0, nine - 1, lead).number, 1)
        self.assertIsNone(due_reminder_slot(slots, 0, nine, lead))  # at the time itself: too late for a heads-up
        self.assertIsNone(due_reminder_slot(slots, 1, nine - 300, lead))  # they have already punched
        self.assertIsNone(due_missing_slot(slots, 0, nine + wait - 1, wait, lead, end_s))
        self.assertEqual(due_missing_slot(slots, 0, nine + wait, wait, lead, end_s).number, 1)  # 9:20
        # the check-in alert lapses when the lunch-out heads-up begins
        self.assertIsNotNone(due_missing_slot(slots, 0, 12 * 3600 + 54 * 60, wait, lead, end_s))
        self.assertIsNone(due_missing_slot(slots, 0, 12 * 3600 + 55 * 60, wait, lead, end_s))
        # the check-out alert runs for a few hours after the shift ends, then stops
        self.assertEqual(due_missing_slot(slots, 1, end_s + wait, wait, lead, end_s).number, 4)
        self.assertIsNone(due_missing_slot(slots, 1, end_s + 4 * 3600, wait, lead, end_s))


class ThirtyZeroTwentyRegressionTests(AlertBase):
    """Employee 30020 on 26 Sep 2026: shift 09:00-20:00, grace 11 minutes, simple attendance mode, biometric
    punch at 09:14:23. That is 3 min 23 s past his allowed 09:11, but no Late alert was sent: the punch ingest
    had written a presence row, and the alert job took any presence row to mean "HR already decided this day"."""

    def setUp(self):
        super().setUp()
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        regular = self.make_shift("Regular shift mens", "09:00", "20:00", grace=11, lunch_out="13:30", lunch_minutes=60)
        self.surya = self.make_employee("30020", "SURYA", "M", phone="9344859103", shift=regular)

    def test_the_late_alert_goes_out_once_the_punch_is_seen(self):
        self.punch(self.surya, SAT, "09:14:23")
        # the precondition that hid the bug: the ingest wrote the presence row
        self.assertTrue(Attendance.objects.filter(employee=self.surya, date=str(SAT), present=True).exists())
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.surya, source="manual").exists())

        self.assertEqual(self.run_at(SAT, 9, 15), {"late_alert": 1})
        text = self.sent_texts()[0]
        for expected in (
            "SURYA M",
            "26 Sep 2026",
            "Shift Start: 9:00 AM",
            "Grace Period: 11 minutes",
            "Your First Punch: 9:14 AM",
            "Late By: 4 minutes",  # 9:14:23 is 3 min 23 s after 9:11: counted up to whole minutes
            "maintain punctuality",
        ):
            self.assertIn(expected, text)
        log = self.logs("late_alert").get()
        self.assertEqual((log.employee_id, log.status, log.phone_number), (self.surya.id, "sent", "919344859103"))
        self.assertEqual(log.dedupe_key, f"late:{SAT.isoformat()}:{self.surya.id}")

    def test_it_is_not_repeated_by_the_minute_by_minute_job(self):
        self.punch(self.surya, SAT, "09:14:23")
        for minute in range(15, 60):
            self.run_at(SAT, 9, minute)
        for hour in range(10, 20):
            self.run_at(SAT, hour, 30)
        self.assertEqual(self.logs("late_alert").count(), 1)

    def test_a_punch_within_his_grace_is_not_late(self):
        self.punch(self.surya, SAT, "09:10:59")
        self.run_at(SAT, 9, 12)
        self.assertFalse(self.logs("late_alert").exists())
        self.assertIn(
            "within the allowed time",
            self.trace("30020", 9, 12),
        )

    def trace(self, code, h, m):
        out = StringIO()
        with mock.patch("api.management.commands.whatsapp_alert_trace.ist_now", return_value=at(SAT, h, m)):
            call_command("whatsapp_alert_trace", code, stdout=out)
        return out.getvalue()

    def test_the_trace_command_explains_the_decision_and_sends_nothing(self):
        self.punch(self.surya, SAT, "09:14:23")
        text = self.trace("30020", 9, 20)
        for expected in (
            "SURYA M",
            "grace 11 min (latest on-time punch 9:11 AM)",
            "Punches recorded today: 1 (9:14 AM)",
            "DUE: Late alert (first punch 9:14 AM, 4 minutes after 9:11 AM)",
            "Due right now: late_alert (late)",
        ):
            self.assertIn(expected, text)
        self.post.assert_not_called()
        self.assertFalse(self.logs().exists())
        # once it has gone out the trace says so
        self.run_at(SAT, 9, 20)
        self.assertIn("Late alert: already sent today", self.trace("30020", 9, 21))
        self.assertIn("late_alert [late:", self.trace("30020", 9, 21))

    def test_the_trace_names_what_blocks_an_employee(self):
        self.assertIn("no employee with this code", self.trace("NOPE", 9, 0))
        WhatsAppSettings.objects.filter(pk=1).update(attendance_alerts_enabled=False)
        self.assertIn("master 'Attendance Alerts (All)' switch is OFF", self.trace("30020", 9, 20))
        Employee.objects.filter(pk=self.surya.pk).update(employment_type="production")
        self.assertIn("Only ACTIVE STAFF", self.trace("30020", 9, 20))


class HrDecisionTests(AlertBase):
    """Only a decision by a person stops the alerts, never the presence row a punch leaves behind."""

    def test_a_presence_row_left_by_a_punch_is_not_a_decision(self):
        self.punch(self.emp, WED, "09:40")
        self.assertTrue(Attendance.objects.filter(employee=self.emp, date=str(WED)).exists())
        self.assertEqual(self.run_at(WED, 9, 41), {"late_alert": 1})

    def test_hr_marking_someone_present_with_no_punches_stops_the_alerts(self):
        Attendance.objects.create(employee=self.emp, date=str(WED), present=True)
        for h, m in ((8, 55), (9, 20), (10, 0)):
            self.assertEqual(self.run_at(WED, h, m), {})

    def test_a_day_record_written_by_hand_stops_the_alerts(self):
        AttendanceDayRecord.objects.create(employee=self.emp, date=WED, status="present", source="manual")
        self.punch(self.emp, WED, "09:40")
        for h, m in ((8, 55), (9, 41), (9, 20), (18, 30)):
            self.assertEqual(self.run_at(WED, h, m), {})

    def test_an_automatic_day_record_is_not_a_decision(self):
        AttendanceDayRecord.objects.create(employee=self.emp, date=WED, status="half_shift", source="auto")
        self.punch(self.emp, WED, "09:40")
        self.assertEqual(self.run_at(WED, 9, 41), {"late_alert": 1})


class AbsentAlertTests(AlertBase):
    """Absent = still no punch once the shift's punctuality window (60 minutes by default, Settings ->
    Attendance) has passed: the same "waits an hour, then Absent" rule the attendance engine uses."""

    def setUp(self):
        super().setUp()
        _switches(four_punch_alert_enabled=False, missing_punch_alert_enabled=False)  # keep other alerts out of these

    def test_not_sent_until_the_punctuality_window_has_passed(self):
        self.assertEqual(self.run_at(WED, 9, 59), {})
        self.assertEqual(self.run_at(WED, 10, 0), {"absent_alert": 1})

    def test_follows_the_punctuality_window_setting(self):
        ps = PayrollSettings.get()
        ps.shift_punctuality_window_minutes = 90
        ps.save()
        self.assertEqual(self.run_at(WED, 10, 29), {})
        self.assertEqual(self.run_at(WED, 10, 30), {"absent_alert": 1})

    def test_it_asks_politely_and_carries_the_employees_details(self):
        self.run_at(WED, 10, 30)
        text = self.sent_texts()[0]
        for expected in (
            "Hi Asha Kumar, we haven't received your attendance punch for today yet.",
            "Are you absent today, or did you forget to punch in?",
            "update your attendance or contact HR",
            "23 Sep 2026",
            "9:00 AM",
            "10:00 AM",
        ):
            self.assertIn(expected, text)
        self.assertNotIn("marked as *Absent*", text)
        self.assertEqual(self.post.call_args.kwargs["json"]["number"], "919000000001")

    def test_each_employee_is_judged_against_their_own_shift(self):
        early = self.make_shift("Early", "06:00", "14:00", grace=10)
        self.make_employee("E1", "Early", "Bird", phone="9000000002", shift=early)
        self.assertEqual(self.run_at(WED, 7, 0), {"absent_alert": 1})  # only the 06:00 shift's window has passed
        self.assertEqual(self.logs("absent_alert").get().employee.employee_code, "E1")
        self.assertEqual(self.run_at(WED, 10, 0), {"absent_alert": 1})  # now the 09:00 shift's
        self.assertEqual(self.logs("absent_alert").count(), 2)

    def test_sent_exactly_once_per_day_however_often_the_job_runs(self):
        for m in (0, 1, 2, 5, 10, 15, 20, 45):
            self.run_at(WED, 10, m)
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.logs("absent_alert").get().dedupe_key, f"absent:{WED.isoformat()}:{self.emp.id}")

    def test_not_sent_again_the_next_day_is_a_new_message(self):
        self.run_at(WED, 10)
        self.run_at(date(2026, 9, 24), 10)
        self.assertEqual(self.post.call_count, 2)

    def test_not_sent_once_the_shift_is_over(self):
        self.assertEqual(self.run_at(WED, 18, 0), {})

    def test_hr_can_add_extra_wait_minutes(self):
        _switches(absent_extra_minutes=30, four_punch_alert_enabled=False, missing_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 10, 29), {})
        self.assertEqual(self.run_at(WED, 10, 30), {"absent_alert": 1})

    def test_not_sent_to_someone_who_has_punched(self):
        self.punch(self.emp, WED, "09:05")
        self.assertNotIn("absent_alert", self.run_at(WED, 10))

    def test_not_sent_on_sundays_holidays_or_a_saturday_off(self):
        self.assertEqual(self.run_at(SUN, 10), {})
        Holiday.objects.create(name="Festival", date=WED)
        _holiday_dates_for_month.cache_clear()
        self.assertEqual(self.run_at(WED, 10), {})
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.assertEqual(self.run_at(SAT, 10), {})

    def test_not_sent_to_people_who_are_legitimately_away(self):
        away = {
            "leave": self.make_employee("L1", "On", "Leave"),
            "half": self.make_employee("L2", "Half", "Day"),
            "manual": self.make_employee("L3", "Manual", "Set"),
            "marked": self.make_employee("L5", "Marked", "Present"),
            "duty": self.make_employee("L4", "On", "Duty"),
        }
        for emp in (away["leave"], away["half"]):
            LeaveRequest.objects.create(
                employee=emp,
                start_date=WED.isoformat(),
                end_date=WED.isoformat(),
                status="approved",
                is_half_day=emp is away["half"],
                half_day_slot="morning" if emp is away["half"] else None,
            )
        AttendanceDayRecord.objects.create(employee=away["manual"], date=WED, status="present", source="manual")
        Attendance.objects.create(employee=away["marked"], date=str(WED), present=True)
        OnDutySession.objects.create(employee=away["duty"], destination="Client site", status="pending_hr")
        self.run_at(WED, 10)
        messaged = set(self.logs("absent_alert").values_list("employee__employee_code", flat=True))
        self.assertEqual(messaged, {"A1"})

    def test_pending_leave_does_not_excuse_and_compensation_days_do(self):
        LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), status="pending"
        )
        with mock.patch("api.whatsapp_alerts._compensation_day_for", return_value=object()):
            self.assertEqual(self.run_at(WED, 10), {})
        self.assertEqual(self.run_at(WED, 10), {"absent_alert": 1})

    def test_only_active_staff_with_a_shift_are_checked(self):
        self.make_employee("P1", "Prod", "Worker", employment_type="production")
        self.make_employee("G1", "Gone", "Away", status="resigned")
        noshift = Employee.objects.create(employee_code="N1", first_name="No", last_name="Shift", phone="9000000009")
        self.run_at(WED, 10)
        self.assertEqual(set(self.logs().values_list("employee__employee_code", flat=True)), {"A1"})
        self.assertFalse(WhatsAppMessageLog.objects.filter(employee=noshift).exists())

    def test_overnight_shifts_are_left_alone(self):
        self.shift.start_time, self.shift.end_time = time(22, 0), time(6, 0)
        self.shift.save()
        self.assertEqual(self.run_at(WED, 23), {})


class LateAlertTests(AlertBase):
    def setUp(self):
        super().setUp()
        _switches(four_punch_alert_enabled=False, missing_punch_alert_enabled=False, absent_alert_enabled=False)

    def test_the_example_from_the_brief(self):
        """Shift 9:00, grace 10 -> allowed until 9:10; first punch 9:25 -> late by 15 minutes."""
        shift = self.make_shift("Nine", "09:00", "18:00", grace=10)
        emp = self.make_employee("B1", "Bala", "Murugan", phone="9000000003", shift=shift)
        self.punch(emp, WED, "09:25")
        self.assertEqual(self.run_at(WED, 9, 26), {"late_alert": 1})
        text = self.sent_texts()[0]
        for expected in (
            "Hi Bala Murugan, your attendance has been marked as *Late* today.",
            "Shift Start: 9:00 AM",
            "Grace Period: 10 minutes",
            "Your First Punch: 9:25 AM",
            "Late By: 15 minutes",
            "maintain punctuality",
            "Every minute contributes to a productive workday",
        ):
            self.assertIn(expected, text)

    def test_a_first_punch_after_grace_is_late(self):
        self.punch(self.emp, WED, "09:40")
        self.assertEqual(self.run_at(WED, 9, 41), {"late_alert": 1})
        text = self.sent_texts()[0]
        for expected in ("Asha Kumar", "23 Sep 2026", "9:00 AM", "9:40 AM", "25 minutes", "15 minutes", "Late"):
            self.assertIn(expected, text)

    def test_it_is_sent_as_soon_as_the_punch_is_seen_and_not_before(self):
        self.assertEqual(self.run_at(WED, 9, 39), {})
        self.punch(self.emp, WED, "09:40")
        self.assertEqual(self.run_at(WED, 9, 40), {"late_alert": 1})

    def test_the_grace_boundary_to_the_second(self):
        # 9:00 + 15 minutes grace: 9:15:00 is on time, 9:15:01 is late by a minute
        for punch, late in (("09:14:59", False), ("09:15:00", False), ("09:15:01", True), ("09:16:00", True)):
            WhatsAppMessageLog.objects.all().delete()
            AttendanceLog.objects.all().delete()
            Attendance.objects.all().delete()
            self.punch(self.emp, WED, punch)
            self.run_at(WED, 10)
            self.assertEqual(self.logs("late_alert").exists(), late, punch)
        self.assertIn("Late By: 1 minute\n", self.logs("late_alert").get().message_text + "\n")

    def test_each_employees_own_grace_decides(self):
        strict = self.make_shift("Strict", "09:00", "18:00", grace=5)
        relaxed = self.make_shift("Relaxed", "09:00", "18:00", grace=30)
        a = self.make_employee("S1", "Strict", "One", phone="9000000004", shift=strict)
        b = self.make_employee("R1", "Relaxed", "Two", phone="9000000005", shift=relaxed)
        self.punch(a, WED, "09:20")
        self.punch(b, WED, "09:20")
        self.assertEqual(self.run_at(WED, 9, 21), {"late_alert": 1})
        self.assertEqual(self.logs("late_alert").get().employee.employee_code, "S1")
        self.assertIn("Grace Period: 5 minutes", self.sent_texts()[0])

    def test_each_employees_own_shift_start_decides(self):
        early = self.make_shift("Early", "06:00", "14:00", grace=10)
        e = self.make_employee("E1", "Early", "Bird", phone="9000000006", shift=early)
        self.punch(e, WED, "06:30")  # 20 minutes past allowed for THEIR shift
        self.punch(self.emp, WED, "06:30")  # far too early to be late for the 09:00 shift
        self.assertEqual(self.run_at(WED, 7), {"late_alert": 1})
        text = self.sent_texts()[0]
        self.assertIn("Shift Start: 6:00 AM", text)
        self.assertIn("Late By: 20 minutes", text)

    def test_the_status_says_what_it_does_to_the_day(self):
        ps = PayrollSettings.get()
        ps.permission_window_minutes = 60
        ps.save()
        for punch, status in (
            ("09:40", "Late\n"),  # inside the 60 minute window: still a full shift
            ("10:30", "counted as an automatic Permission"),  # the permission zone after it
            ("11:30", "Half Shift"),  # beyond both
        ):
            WhatsAppMessageLog.objects.all().delete()
            AttendanceLog.objects.all().delete()
            Attendance.objects.all().delete()
            self.punch(self.emp, WED, punch)
            self.run_at(WED, 12)
            self.assertIn(status, self.logs("late_alert").get().message_text + "\n", punch)

    def test_sent_once(self):
        self.punch(self.emp, WED, "09:40")
        for m in (40, 41, 45, 50, 59):
            self.run_at(WED, 9, m)
        self.run_at(WED, 10, 5)
        self.assertEqual(self.logs("late_alert").count(), 1)

    def test_a_later_punch_does_not_change_who_was_late(self):
        self.punch(self.emp, WED, "09:40", "13:00", "14:00", "18:00")
        self.run_at(WED, 18, 30)
        self.assertEqual(self.logs("late_alert").count(), 1)
        self.assertIn("9:40 AM", self.logs("late_alert").get().message_text)

    def test_an_approved_permission_excuses_it_but_a_pending_one_does_not(self):
        self.punch(self.emp, WED, "09:40")
        EmployeePermission.objects.create(employee=self.emp, date=WED, status="pending")
        self.assertEqual(self.run_at(WED, 10), {"late_alert": 1})
        WhatsAppMessageLog.objects.all().delete()
        EmployeePermission.objects.update(status="approved")
        self.assertEqual(self.run_at(WED, 10), {})

    def test_a_compensation_day_is_never_penalised(self):
        self.punch(self.emp, WED, "09:40")
        with mock.patch("api.whatsapp_alerts._compensation_day_for", return_value=object()):
            self.assertEqual(self.run_at(WED, 10), {})

    def test_an_early_bird_is_not_messaged(self):
        self.punch(self.emp, WED, "08:55", "13:00", "14:00", "18:05")
        self.assertEqual(self.run_at(WED, 19), {})

    def test_not_on_a_holiday_leave_or_when_hr_decided(self):
        self.punch(self.emp, WED, "09:40")
        Holiday.objects.create(name="Festival", date=WED)
        _holiday_dates_for_month.cache_clear()
        self.assertEqual(self.run_at(WED, 10), {})
        Holiday.objects.all().delete()
        _holiday_dates_for_month.cache_clear()
        LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), status="approved"
        )
        self.assertEqual(self.run_at(WED, 10), {})


class PunchReminderTests(AlertBase):
    """A friendly heads-up 5 minutes before each punch is expected, only if that punch is still missing."""

    def setUp(self):
        super().setUp()
        _switches(absent_alert_enabled=False, late_alert_enabled=False, missing_punch_alert_enabled=False)

    def test_check_in_reminder_five_minutes_before_the_shift_starts(self):
        self.assertEqual(self.run_at(WED, 8, 54), {})
        self.assertEqual(self.run_at(WED, 8, 55), {"four_punch_alert": 1})
        text = self.sent_texts()[0]
        for expected in (
            "Good morning, Asha Kumar",
            "your attendance punch is coming up in 5 minutes. Please remember to punch in on time.",
            "Morning check-in (1 of 4)",
            "expected at 9:00 AM",
            "Thank you for being one of the pillars of our team. Have a productive day!",
        ):
            self.assertIn(expected, text)
        self.assertTrue(any(q in text for q in QUOTES))
        self.assertNotIn("warning", text.lower())

    def test_each_of_the_four_punches_five_minutes_ahead_with_suitable_wording(self):
        cases = (
            # punches so far, run at, punch name, wording that must appear
            ((), (8, 55), "Morning check-in", "punch in on time"),
            (("09:00",), (12, 55), "Lunch-out", "lunch break is coming up in 5 minutes"),
            (("09:00", "13:00"), (13, 55), "Lunch-in", "lunch break ends in 5 minutes"),
            (("09:00", "13:00", "14:00"), (17, 55), "Evening check-out", "shift ends in 5 minutes"),
        )
        for punches, (h, m), name, wording in cases:
            WhatsAppMessageLog.objects.all().delete()
            AttendanceLog.objects.all().delete()
            Attendance.objects.all().delete()
            self.post.reset_mock()
            self.punch(self.emp, WED, *punches)
            self.assertEqual(self.run_at(WED, h, m), {"four_punch_alert": 1}, name)
            text = self.sent_texts()[0]
            self.assertIn(name, text)
            self.assertIn(wording, text)
            self.assertTrue(any(q in text for q in QUOTES), name)

    def test_the_greeting_follows_the_time_of_day(self):
        self.assertEqual(self.run_at(WED, 8, 55), {"four_punch_alert": 1})
        self.punch(self.emp, WED, "09:00")
        self.run_at(WED, 12, 55)
        self.punch(self.emp, WED, "13:00", "14:00")
        self.run_at(WED, 17, 55)
        greetings = [t.split(",")[0].split("\n")[0] for t in self.sent_texts()]
        self.assertEqual(greetings, ["Good morning", "Good afternoon", "Good evening"])

    def test_a_punch_already_made_gets_no_reminder(self):
        self.punch(self.emp, WED, "08:50")
        self.assertEqual(self.run_at(WED, 8, 55), {})  # checked in already
        self.punch(self.emp, WED, "12:50")  # lunch-out made early
        self.assertEqual(self.run_at(WED, 12, 55), {})

    def test_no_reminder_for_a_punch_whose_earlier_punch_is_missing(self):
        # never checked in: nobody reminds them of lunch, the check-in alerts cover them
        for h, m in ((12, 55), (13, 55)):
            self.assertEqual(self.run_at(WED, h, m), {})

    def test_the_checkout_reminder_reaches_someone_who_skipped_lunch_but_not_someone_out_at_lunch(self):
        self.punch(self.emp, WED, "09:00")
        self.assertEqual(self.run_at(WED, 17, 55), {"four_punch_alert": 1})  # clocked in, never out: owed a check-out
        WhatsAppMessageLog.objects.all().delete()
        self.punch(self.emp, WED, "13:00")  # now out for lunch and never back
        self.assertEqual(self.run_at(WED, 17, 55), {})  # the check-out isn't what they owe

    def test_sent_once_however_often_the_job_runs(self):
        for m in range(55, 60):
            self.run_at(WED, 8, m)
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.tags_sent(), ["four1"])

    def test_not_sent_after_the_punch_time_has_passed(self):
        self.assertEqual(self.run_at(WED, 9, 0), {})
        self.assertEqual(self.run_at(WED, 9, 5), {})

    def test_a_delayed_job_says_how_long_is_really_left(self):
        self.run_at(WED, 8, 58)
        self.assertIn("coming up in 2 minutes", self.sent_texts()[0])

    def test_the_lead_time_is_hrs_to_set(self):
        _switches(
            absent_alert_enabled=False,
            late_alert_enabled=False,
            missing_punch_alert_enabled=False,
            four_punch_lead_minutes=10,
        )
        self.assertEqual(self.run_at(WED, 8, 49), {})
        self.assertEqual(self.run_at(WED, 8, 50), {"four_punch_alert": 1})
        self.assertIn("in 10 minutes", self.sent_texts()[0])

    def test_each_employee_is_reminded_for_their_own_shift_times(self):
        early = self.make_shift("Early", "06:00", "14:00", grace=10, lunch_out="10:00", lunch_minutes=30)
        self.make_employee("E1", "Early", "Bird", phone="9000000002", shift=early)
        self.assertEqual(self.run_at(WED, 5, 55), {"four_punch_alert": 1})
        self.assertEqual(self.logs("four_punch_alert").get().employee.employee_code, "E1")
        self.assertEqual(self.run_at(WED, 8, 55), {"four_punch_alert": 1})  # now the 09:00 shift
        self.punch(self.emp, WED, "09:00")
        # Only lunch-out (12:55) is next for them, and the early-shift employee never checked in.
        self.assertEqual(self.run_at(WED, 9, 55), {})
        self.assertEqual(self.run_at(WED, 12, 55), {"four_punch_alert": 1})
        self.assertEqual(self.logs("four_punch_alert").filter(employee=self.emp).count(), 2)
        self.assertEqual(self.logs("four_punch_alert").filter(employee__employee_code="E1").count(), 1)

    def test_a_double_tap_on_the_device_is_still_one_punch(self):
        self.punch(self.emp, WED, "09:00:05")
        self.punch(self.emp, WED, "09:00:20")  # pressed twice
        self.assertEqual(AttendanceLog.objects.filter(employee=self.emp).count(), 2)
        self.assertEqual(self.run_at(WED, 12, 55), {"four_punch_alert": 1})
        self.assertIn("Lunch-out", self.sent_texts()[0])  # not skipped ahead to lunch-in

    def test_simple_mode_reminds_for_two_punches_only(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        self.assertEqual(self.run_at(WED, 8, 55), {"four_punch_alert": 1})
        self.punch(self.emp, WED, "09:00")
        for h, m in ((12, 55), (13, 55)):
            self.assertEqual(self.run_at(WED, h, m), {})
        self.assertEqual(self.run_at(WED, 17, 55), {"four_punch_alert": 1})
        self.assertIn("Check-out (2 of 2)", self.sent_texts()[-1])

    def test_no_reminder_for_someone_on_leave_or_decided_by_hr(self):
        LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), status="approved"
        )
        self.assertEqual(self.run_at(WED, 8, 55), {})

    def test_the_reminder_switch_is_separate_from_the_absent_alert(self):
        _switches(
            four_punch_alert_enabled=False,
            absent_alert_enabled=True,
            late_alert_enabled=False,
            missing_punch_alert_enabled=False,
        )
        self.assertEqual(self.run_at(WED, 8, 55), {})
        self.assertEqual(self.run_at(WED, 10, 0), {"absent_alert": 1})

    def test_the_quote_is_stable_for_a_person_a_day_and_a_punch(self):
        self.run_at(WED, 8, 55)
        first = self.sent_texts()[0]
        WhatsAppMessageLog.objects.all().delete()
        self.run_at(WED, 8, 56)
        self.assertEqual(first.split("💡")[1].split("\n")[0], self.sent_texts()[1].split("💡")[1].split("\n")[0])


class OnDutyReminderTests(AlertBase):
    """Employees working On-Duty get the same heads-ups, worded for their Geo Punch."""

    def setUp(self):
        super().setUp()
        _switches(absent_alert_enabled=False, late_alert_enabled=False, missing_punch_alert_enabled=False)
        self.session = OnDutySession.objects.create(
            employee=self.emp, destination="Tirupur Dyeing Unit", status=OnDutySession.STATUS_ACTIVE
        )

    def test_an_on_duty_employee_is_reminded_to_geo_punch_before_it_is_due(self):
        self.assertEqual(self.run_at(WED, 8, 54), {})
        self.assertEqual(self.run_at(WED, 8, 55), {"on_duty_punch_reminder": 1})
        text = self.sent_texts()[0]
        for expected in (
            "On-Duty Punch Reminder",
            "Good morning, Asha Kumar",
            "Geo Punch",
            "Tirupur Dyeing Unit",
            "1 of 4",
            "Morning check-in",
            "coming up in 5 minutes",
        ):
            self.assertIn(expected, text)
        self.assertEqual(self.logs("on_duty_punch_reminder").get().dedupe_key, f"duty1:{WED.isoformat()}:{self.emp.id}")

    def test_they_are_not_told_they_are_absent_late_or_missing_a_punch(self):
        _switches(
            absent_alert_enabled=True,
            late_alert_enabled=True,
            missing_punch_alert_enabled=True,
            four_punch_alert_enabled=False,
        )
        self.run_at(WED, 10, 30)
        for kind in ("absent_alert", "late_alert", "missing_punch_alert"):
            self.assertFalse(self.logs(kind).exists(), kind)

    def test_submitted_geo_punches_count_even_before_hr_approves_them(self):
        for number, at_time in ((1, time(9, 5)), (2, time(13, 2))):
            OnDutyPunchVerification.objects.create(
                session=self.session,
                employee=self.emp,
                punch_date=WED,
                punch_time=at_time,
                punch_type="IN" if number == 1 else "OUT",
                punch_number=number,
                latitude="11.1",
                longitude="77.3",
                photo="on_duty_punch_verifications/z.jpg",
            )
        # Two Geo Punches are in, so the lunch-in (expected 14:00) is next: reminded at 13:55, not before.
        self.assertEqual(self.run_at(WED, 13, 54), {})
        self.assertEqual(self.run_at(WED, 13, 55), {"on_duty_punch_reminder": 1})
        self.assertIn("Lunch-in", self.sent_texts()[0])
        self.assertIn("3 of 4", self.sent_texts()[0])

    def test_the_punch_reminder_switch_controls_them(self):
        _switches(four_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 8, 55), {})


class MissingPunchAlertTests(AlertBase):
    """A punch still missing 20 minutes (HR's setting) after it was expected: one polite message per punch."""

    def setUp(self):
        super().setUp()
        _switches(absent_alert_enabled=False, late_alert_enabled=False, four_punch_alert_enabled=False)

    def test_the_check_in_alert_comes_twenty_minutes_after_the_shift_starts(self):
        self.assertEqual(self.run_at(WED, 9, 19), {})
        self.assertEqual(self.run_at(WED, 9, 20), {"missing_punch_alert": 1})
        text = self.sent_texts()[0]
        for expected in (
            "Hi Asha Kumar, we noticed that your attendance punch is still missing.",
            "Expected Punch: 9:00 AM",
            "Current Status: Punch Not Recorded",
            "complete your attendance punch as soon as possible",
            "please contact HR",
        ):
            self.assertIn(expected, text)
        self.assertEqual(self.logs("missing_punch_alert").get().dedupe_key, f"missing1:{WED.isoformat()}:{self.emp.id}")

    def test_the_check_out_alert_says_the_checkout_is_missing(self):
        self.punch(self.emp, WED, "09:00", "13:00", "14:00")
        self.assertEqual(self.run_at(WED, 18, 19), {})
        self.assertEqual(self.run_at(WED, 18, 20), {"missing_punch_alert": 1})
        text = self.sent_texts()[0]
        self.assertIn("your check-out punch is still missing", text)
        self.assertIn("Expected Punch: 6:00 PM", text)
        self.assertIn("Punch Not Recorded", text)

    def test_lunch_punches_get_their_own_alerts_at_their_own_times(self):
        self.punch(self.emp, WED, "09:00")
        self.assertEqual(self.run_at(WED, 13, 19), {})
        self.assertEqual(self.run_at(WED, 13, 20), {"missing_punch_alert": 1})
        self.assertIn("lunch-out punch is still missing", self.sent_texts()[0])
        self.assertIn("Expected Punch: 1:00 PM", self.sent_texts()[0])
        self.punch(self.emp, WED, "13:05")
        self.assertEqual(self.run_at(WED, 14, 20), {"missing_punch_alert": 1})
        self.assertIn("lunch-in punch is still missing", self.sent_texts()[1])
        self.assertIn("Expected Punch: 2:00 PM", self.sent_texts()[1])

    def test_no_alert_when_the_punch_was_made_in_time(self):
        self.punch(self.emp, WED, "09:10")
        self.assertEqual(self.run_at(WED, 9, 30), {})
        self.assertEqual(self.run_at(WED, 9, 21), {})

    def test_a_complete_day_is_never_a_missing_punch(self):
        self.punch(self.emp, WED, "09:00", "13:00", "14:00", "18:01")
        for h, m in ((9, 30), (13, 30), (14, 30), (18, 30), (20, 0)):
            self.assertEqual(self.run_at(WED, h, m), {})

    def test_each_missing_punch_is_reported_once(self):
        for m in range(20, 60):
            self.run_at(WED, 9, m)
        for h in range(10, 13):
            self.run_at(WED, h, 15)
        self.assertEqual(self.tags_sent(), ["missing1"])

    def test_it_stops_when_the_day_has_moved_on(self):
        # the lunch-out heads-up starts at 12:55, so a check-in alert then would be stale
        self.assertEqual(self.run_at(WED, 12, 56), {})
        self.assertEqual(self.run_at(WED, 12, 54), {"missing_punch_alert": 1})

    def test_the_check_out_alert_lapses_hours_after_the_shift(self):
        self.punch(self.emp, WED, "09:00", "13:00", "14:00")
        self.assertEqual(self.run_at(WED, 22, 30), {})

    def test_the_wait_is_hrs_to_set(self):
        _switches(
            absent_alert_enabled=False,
            late_alert_enabled=False,
            four_punch_alert_enabled=False,
            missing_punch_after_minutes=45,
        )
        self.assertEqual(self.run_at(WED, 9, 44), {})
        self.assertEqual(self.run_at(WED, 9, 45), {"missing_punch_alert": 1})

    def test_each_employee_is_judged_against_their_own_shift(self):
        early = self.make_shift("Early", "06:00", "14:00", grace=10)
        self.make_employee("E1", "Early", "Bird", phone="9000000002", shift=early)
        self.assertEqual(self.run_at(WED, 6, 20), {"missing_punch_alert": 1})
        self.assertEqual(self.logs("missing_punch_alert").get().employee.employee_code, "E1")
        self.assertIn("Expected Punch: 6:00 AM", self.sent_texts()[0])

    def test_simple_mode_expects_two_punches(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        self.punch(self.emp, WED, "09:00")
        self.assertEqual(self.run_at(WED, 13, 20), {})  # no lunch punches in simple mode
        self.assertEqual(self.run_at(WED, 18, 20), {"missing_punch_alert": 1})
        self.assertIn("check-out", self.sent_texts()[0])

    def test_not_on_sundays_holidays_leave_or_after_hr_decided(self):
        self.assertEqual(self.run_at(SUN, 9, 30), {})
        LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), status="approved"
        )
        self.assertEqual(self.run_at(WED, 9, 30), {})

    def test_the_switch_controls_it(self):
        _switches(
            absent_alert_enabled=False,
            late_alert_enabled=False,
            four_punch_alert_enabled=False,
            missing_punch_alert_enabled=False,
        )
        self.assertEqual(self.run_at(WED, 9, 30), {})

    def test_wording_hr_saved_before_punches_were_judged_one_by_one_still_works(self):
        from .models import WhatsAppMessageTemplate

        WhatsAppMessageTemplate.objects.create(
            document_type="missing_punch_alert", message_body="{{employee_name}}: {{recorded}} in, {{missing}} to go"
        )
        self.punch(self.emp, WED, "09:00")
        self.run_at(WED, 13, 20)
        self.assertEqual(self.sent_texts(), ["Asha Kumar: 1 of 4 in, Lunch-out, Lunch-in, Evening check-out to go"])


class FullDaySimulationTests(AlertBase):
    """The job runs every minute all day. Play a whole working day through it minute by minute (punches arriving at
    their real times) and check exactly which messages went out, when, and that none was ever repeated."""

    def simulate(self, emp, punches, start=(8, 45), end=(20, 30)):
        arriving = {}
        for p in punches:
            t = hm(p)
            arriving.setdefault((t.hour, t.minute), []).append(p)
        sent = []  # (HH:MM, tag)
        for minute_of_day in range(start[0] * 60 + start[1], end[0] * 60 + end[1] + 1):
            h, m = divmod(minute_of_day, 60)
            for p in arriving.get((h, m), []):
                # each punch in its own ingest so the alternating IN/OUT stays right
                self.punch_one(emp, p)
            before = set(WhatsAppMessageLog.objects.values_list("id", flat=True))
            self.run_at(WED, h, m)
            for row in WhatsAppMessageLog.objects.exclude(id__in=before).order_by("id"):
                sent.append((f"{h:02d}:{m:02d}", row.dedupe_key.split(":")[0]))
        return sent

    def punch_one(self, emp, p):
        n = AttendanceLog.objects.filter(employee=emp, date=WED).count()
        _ingest_punches([(emp.employee_code, WED, hm(p), "IN" if n % 2 == 0 else "OUT")], None, "biometric:test")

    def test_an_on_time_employee_only_gets_the_friendly_heads_ups(self):
        sent = self.simulate(self.emp, ["08:58", "13:00", "14:01", "18:02"])
        self.assertEqual(sent, [("08:55", "four1"), ("12:55", "four2"), ("13:55", "four3"), ("17:55", "four4")])

    def test_a_late_employee_gets_the_reminder_then_missing_then_late_then_the_rest(self):
        sent = self.simulate(self.emp, ["09:25", "13:03", "14:05", "18:02"])
        self.assertEqual(
            sent,
            [
                ("08:55", "four1"),
                ("09:20", "missing1"),  # nothing recorded 20 minutes after 9:00
                ("09:25", "late"),  # the moment the 9:25 punch (past 9:15) is seen
                ("12:55", "four2"),
                ("13:55", "four3"),
                ("17:55", "four4"),
            ],
        )

    def test_someone_who_never_comes_in(self):
        sent = self.simulate(self.emp, [])
        self.assertEqual(sent, [("08:55", "four1"), ("09:20", "missing1"), ("10:00", "absent")])

    def test_someone_who_punches_in_and_then_forgets_everything(self):
        sent = self.simulate(self.emp, ["08:59"])
        self.assertEqual(
            sent,
            [
                ("08:55", "four1"),
                ("12:55", "four2"),
                ("13:20", "missing2"),  # lunch-out expected 13:00 + 20
                ("17:55", "four4"),  # clocked in and never out: the check-out heads-up
                ("18:20", "missing4"),
            ],
        )

    def test_two_employees_on_different_shifts_are_judged_separately(self):
        early = self.make_shift("Early", "06:00", "14:00", grace=10, lunch_out="10:00", lunch_minutes=30)
        other = self.make_employee("E1", "Early", "Bird", phone="9000000002", shift=early)
        sent = []
        for minute_of_day in range(5 * 60 + 45, 20 * 60 + 31):
            h, m = divmod(minute_of_day, 60)
            if (h, m) == (6, 25):
                self.punch_one(other, "06:25")  # 15 minutes past 06:10
            if (h, m) == (9, 5):
                self.punch_one(self.emp, "09:05")  # on time for 09:00 + 15
            before = set(WhatsAppMessageLog.objects.values_list("id", flat=True))
            self.run_at(WED, h, m)
            for row in WhatsAppMessageLog.objects.exclude(id__in=before).order_by("id"):
                sent.append((f"{h:02d}:{m:02d}", row.employee.employee_code, row.dedupe_key.split(":")[0]))
        mine = [(t, tag) for t, code, tag in sent if code == "A1"]
        theirs = [(t, tag) for t, code, tag in sent if code == "E1"]
        self.assertIn(("06:25", "late"), theirs)  # late for their 06:00 shift
        self.assertNotIn("late", [tag for _, tag in mine])  # 09:05 is fine for the 09:00 shift
        self.assertEqual(mine[0], ("08:55", "four1"))
        self.assertEqual(theirs[0], ("05:55", "four1"))
        self.assertEqual(len(sent), len(set((code, tag) for _, code, tag in sent)))  # nothing ever repeated


class DeliveryAndLoggingTests(AlertBase):
    def setUp(self):
        super().setUp()
        _switches(late_alert_enabled=False, four_punch_alert_enabled=False, missing_punch_alert_enabled=False)

    def test_a_sent_alert_is_logged_with_its_text_and_provider_id(self):
        self.run_at(WED, 10)
        log = self.logs("absent_alert").get()
        self.assertEqual((log.status, log.provider_message_id, log.phone_number), ("sent", "WAID", "919000000001"))
        self.assertIn("Asha Kumar", log.message_text)

    def test_a_provider_error_is_logged_and_not_retried_all_day(self):
        self.post.return_value = mock.Mock(
            status_code=200,
            content=b"x",
            text="",
            json=lambda: {"status": "error", "message": "Instance not connected"},
        )
        self.run_at(WED, 10)
        self.run_at(WED, 10, 5)
        log = self.logs("absent_alert").get()
        self.assertEqual(log.status, "failed")
        self.assertIn("Instance not connected", log.error_message)
        self.assertEqual(self.post.call_count, 1)

    def test_an_employee_without_a_phone_gets_a_failed_row_not_a_send(self):
        Employee.objects.filter(pk=self.emp.pk).update(phone="")
        self.run_at(WED, 10)
        log = self.logs("absent_alert").get()
        self.assertEqual(log.status, "failed")
        self.assertIn("No phone number", log.error_message)
        self.post.assert_not_called()

    def test_the_reservation_is_what_makes_a_message_exactly_once(self):
        first = whatsapp_service.send_notification(self.emp, "absent_alert", ["A", "d", "t"], dedupe_key="k:1")
        second = whatsapp_service.send_notification(self.emp, "absent_alert", ["A", "d", "t"], dedupe_key="k:1")
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(self.post.call_count, 1)

    def test_a_type_switched_off_in_message_settings_is_skipped_silently(self):
        from .models import WhatsAppMessageTemplate

        WhatsAppMessageTemplate.objects.create(document_type="absent_alert", is_enabled=False)
        self.assertEqual(self.run_at(WED, 10), {})
        self.assertFalse(self.logs().exists())

    def test_hr_can_reword_an_alert(self):
        from .models import WhatsAppMessageTemplate

        WhatsAppMessageTemplate.objects.create(document_type="absent_alert", message_body="{{1}}, where are you?")
        self.run_at(WED, 10)
        self.assertEqual(self.sent_texts(), ["Asha Kumar, where are you?"])


@override_settings(**CONFIG)
class GeoApprovalTests(TestCase):
    def setUp(self):
        self.emp = Employee.objects.create(
            employee_code="G1", first_name="Ravi", last_name="Nair", phone="9111111111", status="active"
        )
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"geo_approval_enabled": True})
        patcher = mock.patch("api.whatsapp_service.requests.post", return_value=_ok("GEO1"))
        self.post = patcher.start()
        self.addCleanup(patcher.stop)
        self.session = OnDutySession.objects.create(
            employee=self.emp, destination="ABC Traders, Coimbatore", status="pending_hr"
        )

    def texts(self):
        return [c.kwargs["json"]["message"] for c in self.post.call_args_list]

    def test_final_approval_confirms_with_what_the_employee_submitted(self):
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", "Carry the sample bag")
        self.assertEqual(len(self.texts()), 1)
        text = self.texts()[0]
        for expected in ("Ravi Nair", "approved", "ABC Traders, Coimbatore", "Priya (HR)", "Carry the sample bag"):
            self.assertIn(expected, text)
        self.assertIn(self.session.created_at.astimezone(FACTORY_TZ).strftime("%d %b %Y"), text)
        self.assertEqual(self.post.call_args.kwargs["json"]["number"], "919111111111")
        log = WhatsAppMessageLog.objects.get(document_type="geo_approval")
        self.assertEqual((log.status, log.document_ref_id, log.employee_id), ("sent", self.session.id, self.emp.id))
        self.assertEqual(log.dedupe_key, f"geo:{self.session.id}")

    def test_no_note_line_when_the_approver_left_no_comment(self):
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        self.assertNotIn("Note:", self.texts()[0])

    def test_rejection_by_hr_says_so_with_the_request_details_and_reason(self):
        resolve_on_duty_session_hr(self.session, "rejected", "Priya", "Not needed today")
        self.assertEqual(len(self.texts()), 1)
        text = self.texts()[0]
        for expected in ("Rejected", "Ravi Nair", "ABC Traders, Coimbatore", "Priya (HR)", "Not needed today"):
            self.assertIn(expected, text)
        self.assertNotIn("Approved", text)
        log = WhatsAppMessageLog.objects.get()
        self.assertEqual((log.document_type, log.related_module), ("geo_rejection", "on_duty"))
        self.assertEqual(log.dedupe_key, f"geo:{self.session.id}:rejected")

    def test_a_rejection_that_voided_punches_says_how_many(self):
        self.session.status = OnDutySession.STATUS_ACTIVE
        self.session.save()
        OnDutyPunchVerification.objects.create(
            session=self.session,
            employee=self.emp,
            punch_date=date(2026, 9, 23),
            punch_time=time(9, 12),
            punch_type="IN",
            punch_number=1,
            latitude="11.1",
            longitude="77.3",
            photo="on_duty_punch_verifications/q.jpg",
        )
        resolve_on_duty_session_hr(self.session, "rejected", "Priya", None)
        self.assertIn("1 punch(es)", self.texts()[0])

    def test_the_department_head_rejecting_is_final_and_says_who(self):
        self.session.status = OnDutySession.STATUS_PENDING_HOD
        self.session.save()
        resolve_on_duty_session_hod(self.session, "rejected", "Suresh", "Use the bus")
        text = self.texts()[0]
        for expected in ("Rejected", "Suresh (Department Head)", "Use the bus"):
            self.assertIn(expected, text)

    def test_the_department_head_approving_only_passes_it_to_hr_so_nothing_is_sent_yet(self):
        self.session.status = OnDutySession.STATUS_PENDING_HOD
        self.session.save()
        resolve_on_duty_session_hod(self.session, "approved", "Suresh", None)
        self.post.assert_not_called()

    def test_the_switch_covers_rejections_too(self):
        WhatsAppSettings.objects.filter(pk=1).update(geo_approval_enabled=False)
        resolve_on_duty_session_hr(self.session, "rejected", "Priya", None)
        self.post.assert_not_called()

    def test_the_switch_off_sends_nothing_but_the_approval_still_happens(self):
        WhatsAppSettings.objects.filter(pk=1).update(geo_approval_enabled=False)
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        self.post.assert_not_called()
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, OnDutySession.STATUS_ACTIVE)

    def test_a_messaging_crash_never_blocks_the_approval(self):
        with mock.patch("api.whatsapp_service.send_notification", side_effect=RuntimeError("boom")):
            resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, OnDutySession.STATUS_ACTIVE)

    def test_a_delivery_failure_is_logged_and_the_approval_still_happens(self):
        self.post.return_value = mock.Mock(
            status_code=200,
            content=b"x",
            text="",
            json=lambda: {"status": "error", "message": "Instance not connected"},
        )
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        self.assertEqual(WhatsAppMessageLog.objects.get().status, "failed")
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, OnDutySession.STATUS_ACTIVE)

    def test_approving_twice_confirms_once(self):
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        resolve_on_duty_session_hr(self.session, "approved", "Priya (HR)", None)
        self.assertEqual(self.post.call_count, 1)

    def _punch(self):
        self.session.status = OnDutySession.STATUS_ACTIVE
        self.session.save()
        return OnDutyPunchVerification.objects.create(
            session=self.session,
            employee=self.emp,
            punch_date=date(2026, 9, 23),
            punch_time=time(9, 12),
            punch_type="IN",
            punch_number=1,
            latitude="11.104100",
            longitude="77.341100",
            photo="on_duty_punch_verifications/x.jpg",
        )

    def test_an_approved_single_punch_restates_time_and_location(self):
        v = self._punch()
        resolve_on_duty_punch_hr(v, "approved", "Priya (HR)", None)
        text = self.texts()[0]
        for expected in ("Ravi Nair", "Check-In", "23 Sep 2026", "9:12 AM", "11.104100,77.341100", "Priya (HR)"):
            self.assertIn(expected, text)
        self.assertEqual(WhatsAppMessageLog.objects.get().document_type, "geo_punch_approval")

    def test_a_rejected_punch_restates_the_punch_and_gives_the_reason(self):
        v = self._punch()
        resolve_on_duty_punch_hr(v, "rejected", "Priya", "Photo was unclear")
        text = self.texts()[0]
        for expected in ("Rejected", "Ravi Nair", "Check-In", "23 Sep 2026", "9:12 AM", "Priya", "Photo was unclear"):
            self.assertIn(expected, text)
        log = WhatsAppMessageLog.objects.get()
        self.assertEqual((log.document_type, log.related_module), ("geo_punch_rejection", "on_duty_punch"))

    def test_a_bulk_decision_sends_no_per_punch_message(self):
        self._punch()
        v2 = OnDutyPunchVerification.objects.create(
            session=self.session,
            employee=self.emp,
            punch_date=date(2026, 9, 23),
            punch_time=time(18, 1),
            punch_type="OUT",
            punch_number=2,
            latitude="11.1",
            longitude="77.3",
            photo="on_duty_punch_verifications/y.jpg",
        )
        resolve_on_duty_punch_hr(v2, "approved", "Priya (HR)", None, notify=False)
        self.post.assert_not_called()
