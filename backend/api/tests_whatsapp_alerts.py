"""Automatic WhatsApp attendance alerts, punch reminders and Geo Attendance messages. WAClient is always mocked."""

from datetime import date, datetime, time
from unittest import mock

from django.test import TestCase, override_settings

from . import whatsapp_service
from .attendance_final import _holiday_dates_for_month
from .clock import FACTORY_TZ
from .geo_attendance_views import resolve_on_duty_punch_hr, resolve_on_duty_session_hr, resolve_on_duty_session_hod
from .models import (
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
from .whatsapp_alerts import due_reminder, run_attendance_alerts

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
    """Shift 09:00-18:00, 15 min grace, lunch from 13:00 for 60 min (+10 grace)."""

    def setUp(self):
        _holiday_dates_for_month.cache_clear()
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        self.shift = ShiftTemplate.objects.create(
            name="Day",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.emp = self.make_employee("A1", "Asha", "Kumar")
        _switches()
        patcher = mock.patch("api.whatsapp_service.requests.post", return_value=_ok())
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def make_employee(self, code, first, last, phone="9000000001", **kw):
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
            employee=emp, shift=self.shift, effective_from=date(2026, 1, 1), saturday_off=kw.get("saturday_off", False)
        )
        return emp

    def punch(self, emp, d, *times):
        for i, t in enumerate(times):
            AttendanceLog.objects.create(
                employee=emp, date=d, punch_time=t, punch_type="IN" if i % 2 == 0 else "OUT", source="biometric"
            )

    def run_at(self, d, h, m=0):
        return run_attendance_alerts(now=at(d, h, m))

    def sent_texts(self):
        return [c.kwargs["json"]["message"] for c in self.post.call_args_list]

    def logs(self, doc_type=None):
        qs = WhatsAppMessageLog.objects.all()
        return qs.filter(document_type=doc_type) if doc_type else qs


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
        _switches(late_alert_enabled=False, four_punch_alert_enabled=False, missing_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 10), {"absent_alert": 1})
        _switches(absent_alert_enabled=False, late_alert_enabled=False)
        self.punch(self.emp, WED, time(9, 40))
        self.assertEqual(self.run_at(WED, 10), {})

    def test_the_attendance_master_switch_turns_all_of_them_off(self):
        _switches(attendance_alerts_enabled=False)
        self.assertEqual(self.run_at(WED, 10), {})
        self.post.assert_not_called()
        _switches(attendance_alerts_enabled=True)
        self.assertEqual(self.run_at(WED, 10), {"absent_alert": 1})


class AbsentAlertTests(AlertBase):
    """Absent = still no punch once the shift's punctuality window (60 minutes by default, Settings ->
    Attendance) has passed: the same "waits an hour, then Absent" rule the attendance engine uses."""

    def test_not_sent_until_the_punctuality_window_has_passed(self):
        _switches(four_punch_alert_enabled=False)  # keep the check-in reminder out of this
        self.assertEqual(self.run_at(WED, 9, 59), {})
        self.assertEqual(self.run_at(WED, 10, 0), {"absent_alert": 1})

    def test_follows_the_punctuality_window_setting(self):
        _switches(four_punch_alert_enabled=False)
        ps = PayrollSettings.get()
        ps.shift_punctuality_window_minutes = 90
        ps.save()
        self.assertEqual(self.run_at(WED, 10, 29), {})
        self.assertEqual(self.run_at(WED, 10, 30), {"absent_alert": 1})

    def test_message_says_absent_with_the_employees_details(self):
        self.run_at(WED, 10, 30)
        text = self.sent_texts()[0]
        for expected in ("Asha Kumar", "23 Sep 2026", "9:00 AM", "10:00 AM", "Absent", "not been recorded"):
            self.assertIn(expected, text)
        self.assertEqual(self.post.call_args.kwargs["json"]["number"], "919000000001")

    def test_sent_exactly_once_per_day_however_often_the_job_runs(self):
        for m in (0, 5, 10, 15, 20, 45):
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
        _switches(absent_extra_minutes=30, four_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 10, 29), {})
        self.assertEqual(self.run_at(WED, 10, 30), {"absent_alert": 1})

    def test_not_sent_to_someone_who_has_punched(self):
        self.punch(self.emp, WED, time(9, 5))
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
    def test_a_first_punch_after_grace_is_late(self):
        self.punch(self.emp, WED, time(9, 40))
        self.assertEqual(self.run_at(WED, 9, 41), {"late_alert": 1})
        text = self.sent_texts()[0]
        for expected in ("Asha Kumar", "23 Sep 2026", "9:00 AM", "9:40 AM", "40 minutes", "Late"):
            self.assertIn(expected, text)

    def test_the_status_says_what_it_does_to_the_day(self):
        ps = PayrollSettings.get()
        ps.permission_window_minutes = 60
        ps.save()
        for punch, status in (
            (time(9, 40), "Late\n"),  # inside the 60 minute window: still a full shift
            (time(10, 30), "counted as an automatic Permission"),  # the permission zone after it
            (time(11, 30), "Half Shift"),  # beyond both
        ):
            WhatsAppMessageLog.objects.all().delete()
            AttendanceLog.objects.all().delete()
            self.punch(self.emp, WED, punch)
            self.run_at(WED, 12)
            self.assertIn(status, self.logs("late_alert").get().message_text + "\n", punch)

    def test_on_the_grace_boundary_is_not_late(self):
        self.punch(self.emp, WED, time(9, 15))
        self.assertEqual(self.run_at(WED, 10), {})

    def test_sent_once(self):
        self.punch(self.emp, WED, time(9, 40))
        self.run_at(WED, 10)
        self.run_at(WED, 10, 5)
        self.assertEqual(self.logs("late_alert").count(), 1)

    def test_an_approved_permission_excuses_it_but_a_pending_one_does_not(self):
        self.punch(self.emp, WED, time(9, 40))
        EmployeePermission.objects.create(employee=self.emp, date=WED, status="pending")
        self.assertEqual(self.run_at(WED, 10), {"late_alert": 1})
        WhatsAppMessageLog.objects.all().delete()
        EmployeePermission.objects.update(status="approved")
        self.assertEqual(self.run_at(WED, 10), {})

    def test_an_early_bird_is_not_messaged(self):
        self.punch(self.emp, WED, time(8, 55), time(13, 0), time(14, 0), time(18, 5))
        self.assertEqual(self.run_at(WED, 19), {})


class PunchReminderTests(AlertBase):
    """A friendly reminder for each of the day's four punches that is still missing."""

    def test_lunch_out_missing(self):
        self.punch(self.emp, WED, time(9, 0))
        self.assertEqual(self.run_at(WED, 13, 19), {})  # 13:00 + 10 lunch grace + 10 wait = 13:20
        self.assertEqual(self.run_at(WED, 13, 20), {"four_punch_alert": 1})
        text = self.sent_texts()[0]
        self.assertIn("Lunch-out", text)
        self.assertIn("1:00 PM", text)

    def test_lunch_in_missing(self):
        self.punch(self.emp, WED, time(9, 0), time(13, 5))
        # out 13:05 + 60 lunch + 10 grace + 10 wait = 14:25
        self.assertEqual(self.run_at(WED, 14, 24), {})
        self.assertEqual(self.run_at(WED, 14, 25), {"four_punch_alert": 1})
        text = self.sent_texts()[0]
        self.assertIn("Lunch-in", text)
        self.assertIn("2:15 PM", text)

    def test_an_early_finish_is_not_mistaken_for_a_lunch_out(self):
        self.punch(self.emp, WED, time(9, 0), time(16, 30))
        self.assertEqual(self.run_at(WED, 17, 30), {})

    def test_each_missed_punch_alerts_once_and_a_full_day_never(self):
        self.punch(self.emp, WED, time(9, 0))
        self.run_at(WED, 13, 30)
        self.run_at(WED, 13, 40)
        self.assertEqual(self.logs("four_punch_alert").count(), 1)
        other = self.make_employee("F1", "Full", "Day")
        self.punch(other, WED, time(9, 0), time(13, 0), time(14, 0), time(18, 0))
        self.run_at(WED, 15)
        self.assertFalse(self.logs("four_punch_alert").filter(employee=other).exists())

    def test_not_applicable_in_simple_mode_or_without_a_lunch_window(self):
        self.punch(self.emp, WED, time(9, 0))
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        self.assertEqual(self.run_at(WED, 14), {})
        ps.attendance_mode = "strict"
        ps.save()
        self.shift.first_half_end = None
        self.shift.save()
        self.assertEqual(self.run_at(WED, 14), {})

    def test_check_in_reminder_goes_once_the_wait_has_passed_and_before_the_absent_cutoff(self):
        self.assertEqual(self.run_at(WED, 9, 9), {})  # 09:00 + 10 minute wait
        self.assertEqual(self.run_at(WED, 9, 10), {"four_punch_alert": 1})
        text = self.sent_texts()[0]
        for expected in ("Punch Reminder", "Friendly reminder", "Morning check-in", "1 of 4", "23 Sep 2026", "9:00 AM"):
            self.assertIn(expected, text)
        # once the absent cutoff arrives the absent alert takes over, and there is no second reminder
        self.assertEqual(self.run_at(WED, 10), {"absent_alert": 1})
        self.assertEqual(self.logs("four_punch_alert").count(), 1)

    def test_check_out_reminder_after_the_shift_ends(self):
        self.punch(self.emp, WED, time(9, 0), time(13, 0), time(14, 0))
        _switches(missing_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 18, 9), {})
        self.assertEqual(self.run_at(WED, 18, 10), {"four_punch_alert": 1})
        text = self.sent_texts()[0]
        for expected in ("Evening check-out", "4 of 4", "6:00 PM"):
            self.assertIn(expected, text)
        self.assertEqual(self.logs("four_punch_alert").get().dedupe_key, f"four4:{WED.isoformat()}:{self.emp.id}")

    def test_someone_who_never_punched_lunch_still_gets_the_check_out_reminder(self):
        self.punch(self.emp, WED, time(9, 0))
        _switches(missing_punch_alert_enabled=False)
        self.run_at(WED, 13, 20)  # lunch-out reminder
        self.run_at(WED, 18, 10)  # and the check-out reminder
        self.assertEqual(
            sorted(self.logs("four_punch_alert").values_list("dedupe_key", flat=True)),
            sorted([f"four2:{WED.isoformat()}:{self.emp.id}", f"four4:{WED.isoformat()}:{self.emp.id}"]),
        )

    def test_simple_mode_reminds_for_two_punches(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        self.assertEqual(self.run_at(WED, 9, 10), {"four_punch_alert": 1})
        self.assertIn("1 of 2", self.sent_texts()[0])
        self.punch(self.emp, WED, time(9, 5))
        _switches(missing_punch_alert_enabled=False)
        self.run_at(WED, 18, 10)
        self.assertIn("2 of 2", self.sent_texts()[-1])
        self.assertIn("Check-out", self.sent_texts()[-1])

    def test_the_wait_is_hrs_to_set(self):
        _switches(four_punch_wait_minutes=0)
        self.assertEqual(self.run_at(WED, 9, 0), {"four_punch_alert": 1})

    def test_no_reminder_for_someone_on_leave_or_after_a_full_day(self):
        LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), status="approved"
        )
        self.assertEqual(self.run_at(WED, 9, 30), {})
        self.assertEqual(self.run_at(WED, 18, 30), {})

    def test_the_reminder_switch_is_separate_from_the_absent_alert(self):
        _switches(four_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 9, 30), {})
        self.assertEqual(self.run_at(WED, 10), {"absent_alert": 1})


class DueReminderTests(TestCase):
    """The pure "which punch is due now" rule."""

    def setUp(self):
        self.shift = ShiftTemplate(
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )

    def due(self, n, times, at_h, at_m=0, strict=True, wait=10, cutoff=10 * 3600):
        return due_reminder(
            n=n,
            times=[h * 3600 + m * 60 for h, m in times],
            shift=self.shift,
            now_s=at_h * 3600 + at_m * 60,
            wait_s=wait * 60,
            strict=strict,
            cutoff_s=cutoff,
        )

    def test_each_of_the_four_punches(self):
        self.assertEqual(self.due(0, [], 9, 30)[0], 1)
        self.assertEqual(self.due(1, [(9, 0)], 13, 30)[0], 2)
        self.assertEqual(self.due(2, [(9, 0), (13, 5)], 14, 30)[0], 3)
        self.assertEqual(self.due(3, [(9, 0), (13, 5), (14, 10)], 18, 15)[0], 4)

    def test_nothing_is_due_before_its_time_or_when_the_day_is_complete(self):
        self.assertIsNone(self.due(0, [], 9, 5))
        self.assertIsNone(self.due(1, [(9, 0)], 12, 0))
        self.assertIsNone(self.due(4, [(9, 0), (13, 0), (14, 0), (18, 0)], 19))
        self.assertIsNone(self.due(0, [], 10, 0))  # too late for a check-in reminder: the absent alert's turn

    def test_a_pending_geo_punch_is_not_in_the_log_but_the_schedule_still_applies(self):
        # Two punches submitted (only one approved so far): lunch-in is due at the scheduled time.
        self.assertEqual(self.due(2, [(9, 0)], 14, 30, cutoff=None)[0], 3)

    def test_the_position_reads_x_of_y(self):
        self.assertEqual(self.due(0, [], 9, 30)[3], "1 of 4")
        self.assertEqual(self.due(0, [], 9, 30, strict=False)[3], "1 of 2")
        self.assertEqual(self.due(1, [(9, 0)], 18, 30, strict=False)[3], "2 of 2")


class OnDutyReminderTests(AlertBase):
    """Employees working On-Duty get the same reminders, worded for their Geo Punch."""

    def setUp(self):
        super().setUp()
        self.session = OnDutySession.objects.create(
            employee=self.emp, destination="Tirupur Dyeing Unit", status=OnDutySession.STATUS_ACTIVE
        )

    def test_an_on_duty_employee_is_reminded_to_geo_punch(self):
        self.assertEqual(self.run_at(WED, 9, 10), {"on_duty_punch_reminder": 1})
        text = self.sent_texts()[0]
        for expected in ("On-Duty Punch Reminder", "Geo Punch", "Tirupur Dyeing Unit", "1 of 4", "Morning check-in"):
            self.assertIn(expected, text)
        self.assertEqual(self.logs("on_duty_punch_reminder").get().dedupe_key, f"duty1:{WED.isoformat()}:{self.emp.id}")

    def test_they_are_not_told_they_are_absent_or_late(self):
        self.run_at(WED, 10, 30)
        self.assertFalse(self.logs("absent_alert").exists())
        self.assertFalse(self.logs("late_alert").exists())
        self.assertFalse(self.logs("missing_punch_alert").exists())

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
        # No log entry for the pending punch, so the scheduled time is used: 13:10 + 60 lunch + 10 grace + 10 wait.
        self.assertEqual(self.run_at(WED, 14, 29), {})
        self.assertEqual(self.run_at(WED, 14, 30), {"on_duty_punch_reminder": 1})
        self.assertIn("Lunch-in", self.sent_texts()[0])
        self.assertIn("3 of 4", self.sent_texts()[0])

    def test_the_punch_reminder_switch_controls_them(self):
        _switches(four_punch_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 9, 30), {})


class MissingPunchAlertTests(AlertBase):
    def test_end_of_day_with_punches_missing(self):
        _switches(four_punch_alert_enabled=False)
        self.punch(self.emp, WED, time(9, 0), time(13, 0), time(14, 0))
        self.assertEqual(self.run_at(WED, 18, 29), {})  # shift ends 18:00, HR default wait 30 min
        self.assertEqual(self.run_at(WED, 18, 30), {"missing_punch_alert": 1})
        text = self.sent_texts()[0]
        self.assertIn("3 of 4", text)
        self.assertIn("Evening check-out", text)
        self.assertIn("23 Sep 2026", text)

    def test_lists_every_missing_punch(self):
        self.punch(self.emp, WED, time(9, 0))
        _switches(four_punch_alert_enabled=False)
        self.run_at(WED, 19)
        self.assertIn("Lunch-out, Lunch-in, Evening check-out", self.sent_texts()[0])

    def test_a_complete_day_or_an_absent_day_is_not_a_missing_punch(self):
        full = self.make_employee("F1", "Full", "Day")
        self.punch(full, WED, time(9, 0), time(13, 0), time(14, 0), time(18, 0))
        _switches(absent_alert_enabled=False)
        self.assertEqual(self.run_at(WED, 19), {})  # self.emp never punched: absent, not "missing"

    def test_simple_mode_expects_two_punches(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        _switches(four_punch_alert_enabled=False)
        self.punch(self.emp, WED, time(9, 0))
        self.run_at(WED, 19)
        text = self.sent_texts()[0]
        self.assertIn("1 of 2", text)
        self.assertIn("Check-out", text)

    def test_wait_is_configurable(self):
        _switches(missing_punch_after_minutes=90, four_punch_alert_enabled=False)
        self.punch(self.emp, WED, time(9, 0))
        self.assertEqual(self.run_at(WED, 19, 29), {})
        self.assertEqual(self.run_at(WED, 19, 30), {"missing_punch_alert": 1})


class DeliveryAndLoggingTests(AlertBase):
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
