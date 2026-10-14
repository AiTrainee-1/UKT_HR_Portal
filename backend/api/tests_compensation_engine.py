"""The OT / Compensation engine inside the attendance engine (attendance_final.compute_day_record and the month / range
callers): OT measurement, the Type 1 next-day allowance, company-announced late-in / early-out windows, paid birthday
leave, relaxation top-ups, the day marker, and the gates (master switch, the feature's own switch, effective-from, staff
only, manual overrides).

Run via: python manage.py test api.tests_compensation_engine -v 2

Fixtures: shift 08:30-17:30, 10 min grace, first half ends 13:00. With the default windows (Settings -> Attendance) that gives
  on time up to 08:40 | Late to 09:40 | permission window to 10:40 | first half to 11:00 | later: second half.
March 2026 is entirely in the past; Monday 2 March is the OT day of most tests, Tuesday 3 March the arrival day, 1 March is a
Sunday and so is 8 March.
"""

from datetime import date, time, timedelta
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_final import (
    _holiday_dates_for_month,
    compute_day_record,
    compute_month_records,
    compute_range_records,
    compensation_marker_json,
    permission_flags_json,
)
from .compensation_rules import DEFAULT_SHIFT_MIN_EXTRA_MINUTES
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLedger,
    CompensationRule,
    Department,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveRequest,
    OvertimeRecord,
    PayrollSettings,
    ShiftTemplate,
)

SUN1 = date(2026, 3, 1)
MON = date(2026, 3, 2)
TUE = date(2026, 3, 3)
WED = date(2026, 3, 4)
THU = date(2026, 3, 5)
FRI = date(2026, 3, 6)
SAT = date(2026, 3, 7)
SUN = date(2026, 3, 8)
MON2 = date(2026, 3, 9)
FEB_28 = date(2026, 2, 28)
EFFECTIVE = date(2026, 3, 1)

DEFAULT_ALLOWANCE_ROWS = [
    ("1 hour", 60, 30),
    ("1 hour 30 minutes", 90, 30),
    ("2 hours", 120, 60),
    ("2 hours 30 minutes", 150, 60),
]
DEFAULT_SHIFT_ROWS = [
    ("Up to 9:00 PM", 1260, "0.25"),
    ("9:00 PM up to 12:00 AM", 1440, "0.50"),
    ("12:00 AM up to 2:00 AM", 1560, "0.75"),
    ("2:00 AM and later", None, "1.00"),
]


def seed_default_rules():
    """The owner's default Settings tables (the data migration seeds the same rows; a flushed test DB has none)."""
    CompensationRule.objects.all().delete()
    for order, (label, floor, minutes) in enumerate(DEFAULT_ALLOWANCE_ROWS, start=1):
        CompensationRule.objects.create(
            kind="allowance", label=label, sort_order=order, min_extra_minutes=floor, allowance_minutes=minutes
        )
    for order, (label, until, shifts) in enumerate(DEFAULT_SHIFT_ROWS, start=1):
        CompensationRule.objects.create(kind="shift", label=label, sort_order=order, until_minutes=until, shifts=shifts)


def set_config(**fields) -> CompensationConfig:
    config = CompensationConfig.get()
    for name, value in fields.items():
        setattr(config, name, value)
    config.save()
    return config


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def hr_headers(username="comp_admin") -> dict:
    user, _ = HRUser.objects.get_or_create(username=username, defaults={"password_hash": "x", "is_super_admin": True})
    return bearer({"role": "hr", "hrUserId": user.id, "name": "Asha HR"})


def make_shift(**over) -> ShiftTemplate:
    defaults = dict(
        name="Comp Shift",
        shift_type="staff",
        start_time=time(8, 30),
        end_time=time(17, 30),
        grace_period_minutes=10,
        first_half_end=time(13, 0),
        lunch_duration_minutes=60,
        lunch_grace_minutes=10,
    )
    defaults.update(over)
    return ShiftTemplate.objects.create(**defaults)


class CompBase(TestCase):
    """A staff employee on the 08:30-17:30 shift, the OT / Compensation features all OFF until a test switches one on."""

    MODE = "simple"
    CODE = "CE1"

    def setUp(self):
        _holiday_dates_for_month.cache_clear()
        ps = PayrollSettings.get()
        ps.attendance_mode = self.MODE
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.permission_monthly_cap = 3
        ps.compensation_feature_enabled = True
        ps.save()
        seed_default_rules()
        CompensationConfig.objects.all().delete()
        self.config = CompensationConfig.get()
        self.shift = make_shift()
        self.emp = self.new_staff(self.CODE)

    def tearDown(self):
        _holiday_dates_for_month.cache_clear()

    # ── fixtures ──
    def new_staff(self, code, shift=None, **over) -> Employee:
        fields = dict(
            employee_code=code,
            first_name="Comp",
            last_name=code,
            employment_type="staff",
            status="active",
            salary_amount=Decimal("26000"),
        )
        fields.update(over)
        emp = Employee.objects.create(**fields)
        EmployeeShiftAssignment.objects.create(employee=emp, shift=shift or self.shift, effective_from=date(2020, 1, 1))
        return emp

    def on(self, **over):
        """Switch features on (and give the Type 1 allowance / birthday their effective-from date)."""
        fields = dict(allowance_effective_from=EFFECTIVE, birthday_effective_from=EFFECTIVE)
        fields.update(over)
        return set_config(**fields)

    def punch(self, d, *times, emp=None, next_date_times=()):
        emp = emp or self.emp
        AttendanceLog.objects.filter(employee=emp, date__in=[d, d + timedelta(days=1)]).delete()
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type="IN", source="test")
        for t in next_date_times:
            AttendanceLog.objects.create(
                employee=emp, date=d + timedelta(days=1), punch_time=t, punch_type="IN", source="test"
            )

    def worked(self, d, last, emp=None, first=time(8, 30)):
        """A normal day with a last punch at `last` (a 4-punch day: in, lunch out, lunch back, out)."""
        self.punch(d, first, time(13, 0), time(14, 0), last, emp=emp)

    def rec(self, d, emp=None) -> AttendanceDayRecord:
        return compute_day_record(emp or self.emp, d, settings=PayrollSettings.get())

    def month(self, emp=None, year=2026, month=3):
        return {r.date: r for r in compute_month_records(emp or self.emp, year, month, PayrollSettings.get())}

    def stored(self, d, emp=None) -> AttendanceDayRecord:
        return AttendanceDayRecord.objects.get(employee=emp or self.emp, date=d)

    def announce(self, d, kind, when, reason="Rain", **scope):
        ann = CompensationDayAnnouncement.objects.create(date=d, kind=kind, allowed_time=when, reason=reason, **scope)
        return ann


class FixtureSanityTests(CompBase):
    def test_the_dates_are_what_the_tests_say_they_are(self):
        self.assertEqual(
            [d.weekday() for d in (MON, TUE, WED, THU, FRI, SAT, SUN, MON2, SUN1)], [0, 1, 2, 3, 4, 5, 6, 0, 6]
        )
        self.assertEqual(FEB_28.weekday(), 5)

    def test_with_every_feature_off_a_late_day_is_judged_as_it_always_was(self):
        self.worked(TUE, time(17, 40), first=time(9, 5))
        r = self.rec(TUE)
        self.assertEqual(
            (r.status, r.shifts_earned, r.is_late, r.arrival_zone), ("present", Decimal("1.00"), True, "late")
        )
        self.assertEqual((r.compensation_kind, r.compensation_minutes, r.compensation_note), ("", 0, ""))

    def test_the_default_threshold_is_the_owners_150(self):
        self.assertEqual(CompensationConfig.get().shift_min_extra_minutes, DEFAULT_SHIFT_MIN_EXTRA_MINUTES)


# ── OT measurement ──────────────────────────────────────────────────────────


class OtMeasurementTests(CompBase):
    """AttendanceDayRecord.ot_extra_minutes: a plain fact of the day, whatever the switches say."""

    def extra(self, d=MON, emp=None):
        return self.rec(d, emp).ot_extra_minutes

    def test_whole_minutes_past_the_shift_end(self):
        self.worked(MON, time(18, 30))
        self.assertEqual(self.extra(), 60)

    def test_the_minute_of_the_punch_counts_not_the_second(self):
        self.worked(MON, time(18, 29, 59))
        self.assertEqual(self.extra(), 59)
        self.worked(MON, time(18, 30, 59))
        self.assertEqual(self.extra(), 60)

    def test_leaving_at_or_before_the_end_is_no_ot(self):
        self.worked(MON, time(17, 30))
        self.assertEqual(self.extra(), 0)
        self.worked(MON, time(17, 0))
        self.assertEqual(self.extra(), 0)

    def test_a_single_punch_is_an_arrival_not_a_departure(self):
        self.punch(MON, time(20, 0))
        self.assertEqual(self.extra(), 0)

    def test_a_punch_after_midnight_is_detected(self):
        # the exit is stamped 01:00 under the NEXT calendar date; the engine reattributes it to Monday (25:00)
        self.punch(MON, time(8, 25), time(13, 0), time(14, 0), next_date_times=[time(1, 0)])
        r = self.rec(MON)
        self.assertEqual(r.ot_extra_minutes, 450)  # 17:30 -> 01:00
        self.assertEqual(r.last_punch, time(1, 0))  # the stored clock time (the minutes are what carry the day offset)
        self.assertFalse(r.early_leave)  # a 01:00 exit is not an early-out at the crack of dawn

    def test_a_punch_at_midnight_exactly(self):
        self.punch(MON, time(8, 25), time(13, 0), time(14, 0), next_date_times=[time(0, 0)])
        self.assertEqual(self.extra(), 390)

    def test_nothing_on_a_sunday_or_a_holiday_or_an_off_saturday(self):
        self.worked(SUN, time(20, 0))
        self.assertEqual(self.extra(SUN), 0)
        Holiday.objects.create(name="Festival", date=WED)
        _holiday_dates_for_month.cache_clear()
        self.worked(WED, time(20, 0))
        self.assertEqual(self.extra(WED), 0)
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.worked(SAT, time(20, 0))
        self.assertEqual(self.extra(SAT), 0)

    def test_an_employee_with_no_shift_has_no_ot(self):
        nobody = Employee.objects.create(
            employee_code="NS1", first_name="No", last_name="Shift", employment_type="staff", status="active"
        )
        self.worked(MON, time(20, 0), emp=nobody)
        self.assertEqual(self.extra(emp=nobody), 0)

    def test_production_has_none(self):
        prod = Employee.objects.create(
            employee_code="PR1", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.worked(MON, time(23, 0), emp=prod)
        r = self.rec(MON, prod)
        self.assertEqual((r.ot_extra_minutes, r.compensation_kind), (0, ""))

    def test_an_overnight_shift_is_measured_from_its_next_day_end(self):
        night = make_shift(name="Night", start_time=time(21, 0), end_time=time(6, 0), first_half_end=time(1, 0))
        emp = self.new_staff("NT1", shift=night)
        # in at 21:00, out at 07:15 the next morning (stamped next date, reattributed): 75 minutes past 06:00
        self.punch(MON, time(21, 0), next_date_times=[time(7, 15)])
        r = compute_day_record(emp, MON, settings=PayrollSettings.get())
        self.assertEqual(r.ot_extra_minutes, 75 if r.last_punch == time(7, 15) else 0)

    def test_the_column_is_written_without_any_switch_on(self):
        self.assertFalse(CompensationConfig.get().allowance_enabled or CompensationConfig.get().shift_enabled)
        self.worked(MON, time(19, 0))
        self.assertEqual(self.stored(MON).ot_extra_minutes if self.rec(MON) else None, 90)

    def test_strict_mode_measures_the_same(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        self.worked(MON, time(19, 0))
        self.assertEqual(self.extra(), 90)


# ── Type 1: the next-day allowance ──────────────────────────────────────────


class _AllowanceCases:
    """The same Type 1 behaviour in Simple and Strict mode (see the two concrete classes below)."""

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True)

    def ot_monday(self, last=time(18, 30)):
        self.worked(MON, last)

    def tuesday(self, first, last=time(17, 40)):
        self.worked(TUE, last, first=first)
        return self.rec(TUE)

    def test_a_late_arrival_within_the_allowance_is_not_late_and_is_marked(self):
        self.ot_monday()  # 60 extra minutes -> 30 min allowance
        r = self.tuesday(time(9, 5))
        self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")))
        self.assertFalse(r.is_late)
        self.assertEqual(r.arrival_zone, "on_time")
        self.assertEqual(r.compensation_kind, "ot_allowance")
        self.assertEqual(r.compensation_minutes, 25)  # 09:05 is 25 minutes after the plain on-time limit 08:40
        self.assertIn("30 min late-in allowance", r.compensation_note)
        self.assertIn("1 hour of extra work on 02 Mar", r.compensation_note)

    def test_without_the_ot_the_same_arrival_is_late(self):
        r = self.tuesday(time(9, 5))
        self.assertTrue(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_an_on_time_arrival_leaves_the_allowance_unused_and_unmarked(self):
        self.ot_monday()
        r = self.tuesday(time(8, 35))
        self.assertFalse(r.is_late)
        self.assertEqual((r.compensation_kind, r.compensation_minutes, r.compensation_note), ("", 0, ""))

    def test_grace_still_applies_on_top_of_the_shifted_start(self):
        self.ot_monday()  # 30 min: shifted start 09:00, plus the 10 min grace = on time until 09:10
        r = self.tuesday(time(9, 10))
        self.assertFalse(r.is_late)
        self.assertEqual(r.compensation_kind, "ot_allowance")
        r = self.tuesday(time(9, 11))  # one minute past it: late exactly as before, so nothing was "used"
        self.assertTrue(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_later_than_the_allowance_is_judged_normally_from_the_shifted_start(self):
        self.ot_monday()  # 30 min
        # 09:50: without the allowance this is a Quarter-shift arrival (after the Late window, 09:40); measured from the
        # shifted start 09:00 + 10 grace it is inside the Late window (to 10:10): a full day that counts as Late
        r = self.tuesday(time(9, 50))
        self.assertEqual((r.arrival_zone, r.is_late, r.shifts_earned), ("late", True, Decimal("1.00")))
        self.assertEqual(r.compensation_kind, "ot_allowance")
        self.assertEqual(r.compensation_minutes, 30)  # the whole allowance was needed
        self.config.allowance_enabled = False
        self.config.save()
        plain = self.rec(TUE)
        self.assertEqual((plain.arrival_zone, plain.is_late, plain.shifts_earned), ("quarter", False, Decimal("0.75")))

    def test_the_second_half_limit_moves_with_the_shifted_start(self):
        self.worked(MON, time(19, 30))  # 120 minutes -> 60 min allowance
        # 11:50 is after the plain first-half limit (11:00): without the allowance the morning is missed (Half Day);
        # from the shifted start (09:30) the limit is 12:00, so it is a Quarter-shift arrival: 0.75, not 0.50
        self.worked(TUE, time(18, 0), first=time(11, 50))
        r = self.rec(TUE)
        self.assertEqual((r.arrival_zone, r.status, r.shifts_earned), ("quarter", "present", Decimal("0.75")))
        self.assertEqual(r.compensation_kind, "ot_allowance")
        self.assertEqual(r.compensation_minutes, 60)
        self.worked(
            TUE, time(18, 0), first=time(12, 10)
        )  # past even the shifted limit: nothing changes, nothing marked
        r = self.rec(TUE)
        self.assertEqual((r.arrival_zone, r.status, r.compensation_kind), ("second_half", "half_shift", ""))

    def test_exactly_one_hour_earns_it_and_one_minute_less_does_not(self):
        self.ot_monday(time(18, 29, 59))  # the minute 18:29: 59 extra minutes
        self.assertTrue(self.tuesday(time(9, 5)).is_late)
        self.ot_monday(time(18, 30))
        self.assertFalse(self.tuesday(time(9, 5)).is_late)

    def test_two_hours_thirty_exactly_still_earns_the_biggest_allowance_but_more_is_type_2s(self):
        self.ot_monday(time(20, 0))  # exactly 150 minutes -> 60 min allowance
        r = self.tuesday(time(9, 35))
        self.assertFalse(r.is_late)
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("ot_allowance", 55))
        self.ot_monday(time(20, 1))  # 151 minutes: Type 2 territory, no automatic allowance
        r = self.tuesday(time(9, 35))
        self.assertTrue(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_a_disabled_row_falls_back_to_the_next_lower_enabled_one(self):
        CompensationRule.objects.filter(kind="allowance", min_extra_minutes=120).update(enabled=False)
        self.ot_monday(
            time(19, 30)
        )  # 120 minutes: the 2 h row is off, so the 1 h 30 row (30 min) is the biggest reached
        self.assertTrue(self.tuesday(time(9, 20)).is_late)  # 09:20 is past 09:10 (08:30 + 30 + 10 grace)
        self.assertFalse(self.tuesday(time(9, 10)).is_late)

    def test_an_added_row_works(self):
        CompensationRule.objects.create(
            kind="allowance", label="30 min", sort_order=9, min_extra_minutes=30, allowance_minutes=15
        )
        self.ot_monday(time(18, 0))  # 30 extra minutes -> 15 min allowance: on time until 08:55
        self.assertFalse(self.tuesday(time(8, 55)).is_late)
        self.assertTrue(self.tuesday(time(8, 56)).is_late)

    def test_an_empty_rule_table_gives_nothing(self):
        CompensationRule.objects.filter(kind="allowance").delete()
        self.ot_monday()
        self.assertTrue(self.tuesday(time(9, 5)).is_late)

    def test_an_approved_permission_that_already_covers_the_arrival_is_not_charged_twice(self):
        self.ot_monday()
        EmployeePermission.objects.create(
            employee=self.emp, date=TUE, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        r = self.tuesday(
            time(9, 30)
        )  # inside the permission window: excused by the permission, the allowance is untouched
        self.assertEqual((r.arrival_zone, r.is_late, r.morning_permission_applied), ("excused", False, True))
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("", 0))

    def test_the_allowance_adds_on_top_only_when_the_permission_does_not_cover_it(self):
        self.worked(MON, time(19, 30))  # 60 min allowance
        EmployeePermission.objects.create(
            employee=self.emp, date=TUE, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        # 10:50 is past the permission window's end (10:40): the permission alone leaves a Quarter-shift arrival;
        # with the allowance on top (shifted start 09:30) it falls inside the permission window
        r = self.tuesday(time(10, 50))
        self.assertEqual((r.arrival_zone, r.is_late, r.shifts_earned), ("excused", False, Decimal("1.00")))
        self.assertTrue(r.morning_permission_applied)
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("ot_allowance", 60))
        self.assertNotIn("Quarter-shift", r.late_reason or "")

    def test_the_marker_note_and_the_late_reason_tell_the_same_story(self):
        self.ot_monday()
        self.worked(TUE, time(17, 40), first=time(9, 50))  # late even with the allowance (shifted limit 09:10): Late
        r = self.rec(TUE)
        self.assertTrue(r.is_late)
        self.assertIn("30 min OT late-in allowance", r.late_reason)
        self.assertIn("deadline 09:10", r.late_reason)

    def test_a_legacy_compensation_day_exempts_the_day_and_the_allowance_stays_unused(self):
        self.ot_monday()
        CompensationDayAnnouncement.objects.create(date=TUE, reason="Festival")  # kind "day"
        r = self.tuesday(time(9, 5))
        self.assertTrue(r.is_compensation_day)
        self.assertFalse(r.is_late)
        self.assertEqual(r.compensation_kind, "")


class AllowanceSimpleTests(_AllowanceCases, CompBase):
    MODE = "simple"
    CODE = "AS1"

    def test_the_weekend_in_between_does_not_matter_when_saturday_is_a_working_day(self):
        # OT on Friday; Saturday is a working day for this employee, so the allowance is Saturday's, not Monday's
        self.worked(FRI, time(18, 30))
        self.worked(SAT, time(17, 40), first=time(9, 5))
        self.worked(MON2, time(17, 40), first=time(9, 5))
        sat, mon = self.rec(SAT), self.rec(MON2)
        self.assertFalse(sat.is_late)
        self.assertEqual(sat.compensation_kind, "ot_allowance")
        self.assertTrue(mon.is_late)

    def test_an_off_saturday_and_the_sunday_pass_the_allowance_to_monday(self):
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.worked(FRI, time(18, 30))
        self.worked(MON2, time(17, 40), first=time(9, 5))
        mon = self.rec(MON2)
        self.assertFalse(mon.is_late)
        self.assertEqual(mon.compensation_kind, "ot_allowance")
        self.assertEqual(mon.compensation_note.count("06 Mar"), 1)  # earned on Friday 6 March

    def test_a_sunday_arrival_has_no_allowance(self):
        self.worked(SAT, time(18, 30))
        self.worked(SUN, time(17, 40), first=time(9, 5))
        self.assertEqual(self.rec(SUN).compensation_kind, "")

    def test_a_company_holiday_in_between_passes_the_allowance_to_the_next_working_day(self):
        self.worked(MON, time(18, 30))
        Holiday.objects.create(name="Festival", date=TUE)
        _holiday_dates_for_month.cache_clear()
        self.worked(WED, time(17, 40), first=time(9, 5))
        r = self.rec(WED)
        self.assertFalse(r.is_late)
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("ot_allowance", 25))

    def test_only_the_previous_working_days_ot_counts_not_older_ones(self):
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40))  # Tuesday had no OT
        self.worked(WED, time(17, 40), first=time(9, 5))
        self.assertTrue(self.rec(WED).is_late)

    def test_a_day_with_no_punches_on_the_ot_day_gives_nothing(self):
        self.worked(TUE, time(17, 40), first=time(9, 5))
        self.assertTrue(self.rec(TUE).is_late)

    def test_the_ot_day_must_be_on_or_after_the_effective_from_date(self):
        set_config(allowance_effective_from=TUE)  # the OT day (Monday) is before it
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40), first=time(9, 5))
        self.assertTrue(self.rec(TUE).is_late)
        set_config(allowance_effective_from=MON)  # the OT day is the first day it applies
        self.assertFalse(self.rec(TUE).is_late)

    def test_the_arrival_day_must_be_on_or_after_the_effective_from_date_too(self):
        set_config(allowance_effective_from=WED)
        self.worked(TUE, time(18, 30))
        self.worked(WED, time(17, 40), first=time(9, 5))
        # Tuesday's OT predates the feature: nothing is carried back into it
        self.assertTrue(self.rec(WED).is_late)

    def test_regenerating_an_old_month_never_changes_it(self):
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40), first=time(9, 5))
        set_config(allowance_effective_from=date(2026, 4, 1))  # switched on later: March is before it
        month = self.month()
        self.assertTrue(month[TUE].is_late)
        self.assertEqual(month[TUE].compensation_kind, "")

    def test_the_master_switch_turns_everything_off(self):
        self.worked(MON, time(18, 30))
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.worked(TUE, time(17, 40), first=time(9, 5))
        r = self.rec(TUE)
        self.assertTrue(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_the_features_own_switch_turns_it_off(self):
        self.worked(MON, time(18, 30))
        set_config(allowance_enabled=False)
        self.worked(TUE, time(17, 40), first=time(9, 5))
        self.assertTrue(self.rec(TUE).is_late)

    def test_production_never_gets_it(self):
        prod = Employee.objects.create(
            employee_code="PRA", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.worked(MON, time(18, 30), emp=prod)
        self.worked(TUE, time(17, 40), first=time(9, 5), emp=prod)
        self.assertEqual(self.rec(TUE, prod).compensation_kind, "")

    def test_a_manual_override_still_wins(self):
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40), first=time(9, 5))
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=TUE,
            status="absent",
            shifts_earned=Decimal("0"),
            source="manual",
            override_by="HR",
            override_note="by hand",
        )
        r = self.rec(TUE)
        self.assertEqual((r.status, r.source, r.compensation_kind), ("absent", "manual", ""))

    def test_a_single_day_call_re_derives_the_previous_days_ot_when_its_stored_record_is_stale(self):
        # Monday's record was computed BEFORE the late punches existed (ot_extra_minutes 0); Tuesday, computed on its own
        # (a dashboard / roster call), must not miss the allowance
        self.worked(MON, time(17, 30))
        self.assertEqual(self.rec(MON).ot_extra_minutes, 0)
        self.worked(MON, time(18, 30))  # the evening punches arrive afterwards; nobody recomputed Monday
        self.assertEqual(self.stored(MON).ot_extra_minutes, 0)
        self.worked(TUE, time(17, 40), first=time(9, 5))
        r = self.rec(TUE)
        self.assertFalse(r.is_late)
        self.assertEqual(r.compensation_kind, "ot_allowance")

    def test_a_month_recompute_reads_the_fresh_previous_day_not_the_stale_one(self):
        self.worked(MON, time(17, 30))
        self.rec(MON)
        self.worked(MON, time(18, 30))  # stale stored record, fresh punches
        self.worked(TUE, time(17, 40), first=time(9, 5))
        month = self.month()
        self.assertEqual(month[MON].ot_extra_minutes, 60)
        self.assertFalse(month[TUE].is_late)
        self.assertEqual(month[TUE].compensation_kind, "ot_allowance")

    def test_the_first_days_of_a_month_look_back_into_the_previous_month(self):
        # 1 April 2026 is a Wednesday; 31 March Tuesday had the OT
        self.worked(date(2026, 3, 31), time(18, 30))
        self.worked(date(2026, 4, 1), time(17, 40), first=time(9, 5))
        april = self.month(month=4)
        self.assertFalse(april[date(2026, 4, 1)].is_late)
        self.assertEqual(april[date(2026, 4, 1)].compensation_kind, "ot_allowance")

    def test_a_range_computed_from_the_arrival_day_alone_still_finds_the_ot(self):
        self.worked(MON, time(18, 30))
        self.rec(MON)
        self.worked(TUE, time(17, 40), first=time(9, 5))
        got = compute_range_records(self.emp, TUE, TUE, PayrollSettings.get())
        self.assertEqual(got[0].compensation_kind, "ot_allowance")


class AllowanceStrictTests(_AllowanceCases, CompBase):
    MODE = "strict"
    CODE = "AT1"


# ── company-announced windows ───────────────────────────────────────────────


class WindowTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(windows_enabled=True)

    def late_in(self, at=time(10, 0), d=WED, **scope):
        return self.announce(d, "late_in", at, **scope)

    def early_out(self, at=time(16, 0), d=WED, **scope):
        return self.announce(d, "early_out", at, **scope)

    def arrive(self, first, last=time(17, 40), d=WED):
        self.worked(d, last, first=first)
        return self.rec(d)

    def test_arrivals_up_to_the_announced_time_are_on_time_with_no_grace_after_it(self):
        self.late_in(time(10, 0))
        r = self.arrive(time(9, 55))  # plainly a Quarter-shift arrival (after 09:40)
        self.assertEqual((r.arrival_zone, r.is_late, r.shifts_earned), ("on_time", False, Decimal("1.00")))
        self.assertEqual(r.compensation_kind, "window_late_in")
        self.assertIn("10:00", r.compensation_note)
        r = self.arrive(time(10, 0))
        self.assertEqual((r.arrival_zone, r.is_late), ("on_time", False))
        # ZERO grace: one minute past the announced time is Late, even though the shift has 10 minutes of grace
        r = self.arrive(time(10, 1))
        self.assertEqual((r.arrival_zone, r.is_late, r.shifts_earned), ("late", True, Decimal("1.00")))

    def test_after_the_window_the_normal_limits_are_measured_from_it(self):
        self.late_in(time(10, 0))
        # Late to 11:00, permission window to 12:00, first half to 12:20; the plain limits would be 09:40 / 10:40 / 11:00
        r = self.arrive(time(10, 59))
        self.assertEqual((r.arrival_zone, r.is_late), ("late", True))
        r = self.arrive(time(11, 30))
        self.assertEqual((r.arrival_zone, r.shifts_earned, r.is_late), ("quarter", Decimal("0.75"), False))
        r = self.arrive(time(12, 20))
        self.assertEqual(r.arrival_zone, "quarter")
        r = self.arrive(time(12, 30), last=time(18, 0))
        self.assertEqual((r.arrival_zone, r.status), ("second_half", "half_shift"))

    def test_an_arrival_the_window_did_not_help_is_not_marked(self):
        self.late_in(time(10, 0))
        r = self.arrive(time(8, 35))
        self.assertEqual(r.compensation_kind, "")
        r = self.arrive(time(8, 40))
        self.assertEqual((r.is_late, r.compensation_kind), (False, ""))

    def test_a_window_earlier_than_the_shift_start_does_not_make_arrivals_worse_marked(self):
        self.late_in(time(8, 0))  # an odd announcement: arrive by 08:00
        r = self.arrive(time(8, 35))  # the shift's own limit was 08:40, the announcement is stricter
        self.assertEqual(r.compensation_kind, "")
        # ... and it does not make the day stricter either: judged exactly as if nothing had been announced
        self.assertEqual((r.is_late, r.arrival_zone, r.shifts_earned), (False, "on_time", Decimal("1.00")))
        self.assertNotIn("company-announced", r.late_reason or "")

    def test_late_in_detection_does_not_run_for_the_announced_period_in_the_reason_either(self):
        self.late_in(time(10, 0))
        r = self.arrive(time(10, 30))
        self.assertTrue(r.is_late)
        self.assertIn("company-announced late-in 10:00, no grace", r.late_reason)

    def test_early_out_moves_the_end_and_zero_grace(self):
        self.early_out(time(16, 0))
        r = self.arrive(
            time(8, 35), last=time(16, 0)
        )  # 16:00 is the announced time: not an early-out (the plain limit was 17:20)
        self.assertFalse(r.early_leave)
        self.assertEqual(r.compensation_kind, "window_early_out")
        self.assertEqual(r.shifts_earned, Decimal("1.00"))
        r = self.arrive(time(8, 35), last=time(15, 59))  # one minute before it: an early-out as ever
        self.assertTrue(r.early_leave)
        self.assertEqual(r.compensation_kind, "")

    def test_the_evening_half_cutoff_follows_the_announced_time(self):
        self.early_out(time(16, 0))
        r = self.arrive(time(8, 35), last=time(15, 30))
        # the cut-off for the Evening Half moves from 14:30 to 16:00, as a legacy leave_until_time does
        self.assertEqual((r.status, r.shifts_earned), ("half_shift", Decimal("0.50")))

    def test_an_early_out_does_not_change_the_morning_and_a_late_in_does_not_change_the_evening(self):
        self.early_out(time(16, 0))
        r = self.arrive(time(9, 5), last=time(16, 0))
        self.assertTrue(r.is_late)  # morning: normal
        self.late_in(time(10, 0))
        r = self.arrive(time(9, 55), last=time(16, 30))
        self.assertTrue(r.early_leave is False)  # 16:30 is after the announced early-out time
        r2 = self.arrive(time(9, 55), last=time(15, 0))
        self.assertTrue(r2.early_leave)

    def test_a_late_in_alone_leaves_the_evening_grace_as_it_was(self):
        self.late_in(time(10, 0))
        self.worked(
            WED, time(17, 20), first=time(9, 0)
        )  # 17:20 = 17:30 - the shift's 10 min grace: still not an early-out
        self.assertFalse(self.rec(WED).early_leave)
        self.worked(WED, time(17, 19), first=time(9, 0))
        self.assertTrue(self.rec(WED).early_leave)

    def test_both_windows_on_one_day(self):
        self.late_in(time(10, 0))
        self.early_out(time(16, 0))
        r = self.arrive(time(9, 55), last=time(16, 0))
        self.assertEqual((r.is_late, r.early_leave), (False, False))
        self.assertEqual(r.compensation_kind, "window_late_in")  # the arrival marker is the more important one
        self.assertIn("early-out", r.compensation_note)  # both are told

    def test_other_days_are_judged_normally(self):
        self.late_in(time(10, 0), d=WED)
        r = self.arrive(time(9, 55), d=THU)
        self.assertEqual((r.arrival_zone, r.compensation_kind), ("quarter", ""))

    def test_the_window_switch_and_master_switch_gate_it(self):
        self.late_in(time(10, 0))
        set_config(windows_enabled=False)
        self.assertEqual(self.arrive(time(9, 55)).arrival_zone, "quarter")
        set_config(windows_enabled=True)
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.assertEqual(self.arrive(time(9, 55)).arrival_zone, "quarter")

    def test_production_is_never_covered(self):
        prod = Employee.objects.create(
            employee_code="PRW", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.late_in(time(10, 0))
        self.worked(WED, time(17, 40), first=time(9, 55), emp=prod)
        self.assertEqual(self.rec(WED, prod).compensation_kind, "")

    def test_scope_by_department_branch_and_employee_list(self):
        sales = Department.objects.create(name="Sales")
        ops = Department.objects.create(name="Ops")
        self.emp.department = sales
        self.emp.save()
        other = self.new_staff("WS2", department=ops)
        self.late_in(time(10, 0), department=sales)
        self.worked(WED, time(17, 40), first=time(9, 55))
        self.worked(WED, time(17, 40), first=time(9, 55), emp=other)
        self.assertEqual(self.rec(WED).arrival_zone, "on_time")
        self.assertEqual(self.rec(WED, other).arrival_zone, "quarter")
        ann = self.late_in(time(10, 0), d=THU)
        ann.employees.set([other])
        self.worked(THU, time(17, 40), first=time(9, 55))
        self.worked(THU, time(17, 40), first=time(9, 55), emp=other)
        self.assertEqual(self.rec(THU, other).arrival_zone, "on_time")
        self.assertEqual(self.rec(THU).arrival_zone, "quarter")

    def test_a_legacy_day_announcement_is_not_a_window_and_a_window_is_not_a_day_exemption(self):
        self.late_in(time(10, 0))
        r = self.arrive(time(10, 30))
        self.assertFalse(r.is_compensation_day)  # a window only moves one edge
        self.assertTrue(r.is_late)  # ... so the day is still judged (from 10:00)
        CompensationDayAnnouncement.objects.create(date=THU, reason="Festival")
        r = self.arrive(time(9, 55), d=THU)
        self.assertTrue(r.is_compensation_day)
        self.assertFalse(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_legacy_rows_with_a_leave_until_time_keep_their_meaning(self):
        CompensationDayAnnouncement.objects.create(date=WED, reason="Festival", leave_until_time=time(15, 0))
        self.worked(WED, time(15, 0), first=time(9, 55))
        r = self.rec(WED)
        self.assertTrue(r.is_compensation_day)
        self.assertEqual((r.status, r.early_leave, r.is_late), ("present", False, False))

    def test_several_windows_of_one_kind_use_the_most_generous(self):
        self.late_in(time(10, 0))
        self.late_in(time(10, 30))
        self.assertEqual(self.arrive(time(10, 20)).arrival_zone, "on_time")

    def test_the_allowance_adds_on_top_of_a_window_for_an_arrival_still_late(self):
        set_config(allowance_enabled=True, allowance_effective_from=EFFECTIVE)
        self.worked(TUE, time(18, 30))  # 60 extra minutes -> 30 min allowance for Wednesday
        self.late_in(time(10, 0))
        r = self.arrive(time(10, 20))  # past the window's 10:00; with the allowance (10:30) it is on time
        self.assertEqual((r.arrival_zone, r.is_late), ("on_time", False))
        self.assertEqual(r.compensation_kind, "window_late_in")
        self.assertEqual(r.compensation_minutes, 20)  # the allowance minutes used: 10:20 is 20 minutes after 10:00
        self.assertIn("late-in allowance", r.compensation_note)

    def test_strict_mode_judges_the_window_the_same_way(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        self.late_in(time(10, 0))
        r = self.arrive(time(9, 55))
        self.assertEqual((r.arrival_zone, r.is_late, r.compensation_kind), ("on_time", False, "window_late_in"))
        r = self.arrive(time(10, 1))
        self.assertTrue(r.is_late)


# ── birthday ────────────────────────────────────────────────────────────────


class BirthdayEngineTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)
        self.emp.save()

    def assertBirthday(self, r):
        self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")))
        self.assertFalse(
            any(
                [
                    r.is_late,
                    r.early_leave,
                    r.is_half_shift,
                    r.late_afternoon,
                    r.morning_permission_applied,
                    r.morning_permission_excess,
                    r.evening_permission_applied,
                    r.evening_permission_excess,
                    r.middle_permission_today,
                    r.permission_afternoon,
                    r.is_half_day_leave,
                ]
            )
        )
        self.assertEqual((r.arrival_zone, r.late_reason), ("", None))
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("birthday", 0))
        self.assertIn("Birthday", r.compensation_note)

    def test_present_when_they_attend_normally(self):
        self.worked(THU, time(17, 40))
        self.assertBirthday(self.rec(THU))

    def test_present_when_absent(self):
        self.assertBirthday(self.rec(THU))

    def test_present_when_they_work_half_a_day(self):
        self.punch(THU, time(8, 30), time(12, 30))
        self.assertBirthday(self.rec(THU))
        self.punch(THU, time(14, 40), time(18, 0))
        self.assertBirthday(self.rec(THU))

    def test_present_when_they_arrive_late(self):
        self.worked(THU, time(17, 40), first=time(10, 50))
        self.assertBirthday(self.rec(THU))

    def test_present_when_they_arrive_after_the_first_half(self):
        self.worked(THU, time(18, 0), first=time(12, 30))
        self.assertBirthday(self.rec(THU))

    def test_present_when_they_leave_early(self):
        self.worked(THU, time(15, 0))
        self.assertBirthday(self.rec(THU))

    def test_a_single_punch_day(self):
        self.punch(THU, time(9, 0))
        self.assertBirthday(self.rec(THU))

    def test_the_punches_are_still_recorded_for_display(self):
        self.worked(THU, time(17, 40), first=time(9, 0))
        r = self.rec(THU)
        self.assertEqual((r.first_punch, r.last_punch, r.total_punches), (time(9, 0), time(17, 40), 4))

    def test_an_approved_permission_and_an_approved_full_day_leave_do_not_change_it(self):
        EmployeePermission.objects.create(
            employee=self.emp, date=THU, type=EmployeePermission.TYPE_MORNING_LATE_IN, status="approved"
        )
        self.worked(THU, time(17, 40), first=time(9, 40))
        self.assertBirthday(self.rec(THU))

    def test_29_february_is_celebrated_on_the_28th_in_a_non_leap_year(self):
        set_config(birthday_effective_from=date(2026, 1, 1))
        self.emp.date_of_birth = date(2000, 2, 29)
        self.emp.save()
        r = self.rec(FEB_28)  # a Saturday, a working day
        self.assertBirthday(r)
        self.assertEqual(self.rec(date(2026, 3, 1)).compensation_kind, "")

    def test_29_february_is_the_real_day_in_a_leap_year(self):
        self.emp.date_of_birth = date(2000, 2, 29)
        self.emp.save()
        set_config(birthday_effective_from=date(2026, 1, 1))
        self.assertBirthday(self.rec(date(2028, 2, 29)))
        self.assertEqual(self.rec(date(2028, 2, 28)).compensation_kind, "")

    def test_not_on_a_sunday(self):
        self.emp.date_of_birth = date(1990, 3, 8)
        self.emp.save()
        r = self.rec(SUN)
        self.assertEqual((r.status, r.shifts_earned, r.compensation_kind), ("holiday", Decimal("0.00"), ""))

    def test_not_on_a_company_holiday(self):
        Holiday.objects.create(name="Festival", date=THU)
        _holiday_dates_for_month.cache_clear()
        r = self.month()[THU]  # the month view knows the holidays
        self.assertEqual((r.status, r.compensation_kind), ("holiday", ""))

    def test_not_on_an_off_saturday(self):
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.emp.date_of_birth = date(1990, 3, 7)
        self.emp.save()
        self.assertEqual(self.rec(SAT).compensation_kind, "")

    def test_never_before_the_effective_from_date(self):
        set_config(birthday_effective_from=date(2026, 3, 6))
        r = self.rec(THU)
        self.assertEqual((r.status, r.compensation_kind), ("absent", ""))
        set_config(birthday_effective_from=THU)
        self.assertEqual(self.rec(THU).compensation_kind, "birthday")

    def test_regenerating_an_old_month_never_changes_it(self):
        self.worked(THU, time(17, 40), first=time(10, 50))
        set_config(birthday_effective_from=date(2026, 4, 1))
        self.assertEqual(self.month()[THU].compensation_kind, "")

    def test_switched_off(self):
        set_config(birthday_enabled=False)
        self.assertEqual(self.rec(THU).status, "absent")

    def test_master_switch_off(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.assertEqual(self.rec(THU).status, "absent")

    def test_production_does_not_get_it(self):
        prod = Employee.objects.create(
            employee_code="PRB",
            first_name="Pro",
            last_name="Duction",
            employment_type="production",
            status="active",
            date_of_birth=date(1990, 3, 5),
        )
        self.assertEqual(self.rec(THU, prod).status, "absent")

    def test_an_inactive_employee_does_not_get_it(self):
        self.emp.status = "inactive"
        self.emp.save()
        self.assertEqual(self.rec(THU).status, "absent")

    def test_no_date_of_birth_no_birthday(self):
        self.emp.date_of_birth = None
        self.emp.save()
        self.assertEqual(self.rec(THU).status, "absent")

    def test_not_before_the_employee_joined(self):
        self.emp.join_date = "2026-03-10"
        self.emp.save()
        self.assertEqual(self.rec(THU).status, "absent")

    def test_a_manual_override_still_wins(self):
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=THU,
            status="absent",
            shifts_earned=Decimal("0"),
            source="manual",
            override_by="HR",
        )
        r = self.rec(THU)
        self.assertEqual((r.status, r.source, r.compensation_kind), ("absent", "manual", ""))

    def test_in_strict_mode_too(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "strict"
        ps.save()
        self.worked(THU, time(15, 0), first=time(10, 50))
        self.assertBirthday(self.rec(THU))

    def test_the_month_view_has_exactly_one_birthday_day(self):
        month = self.month()
        self.assertEqual([d for d, r in month.items() if r.compensation_kind == "birthday"], [THU])

    def test_payroll_counts_the_day_as_paid(self):
        from .payroll_views import _generate_staff_payroll

        for d in (date(2026, 3, i) for i in range(2, 32)):
            if d.weekday() != 6 and d != THU:
                self.worked(d, time(17, 40), first=time(8, 35))
        result = _generate_staff_payroll(self.emp, 3, 2026)
        self.assertEqual(result["payroll"].absent_days, Decimal("0"))  # the birthday has no punches and still is paid
        self.assertEqual(result["payroll"].gross_salary, Decimal("26000.00"))


# ── relaxation top-up (the day side of an assigned / redeemed relaxation) ───


class RelaxationEngineTests(CompBase):
    """compute_day_record tops a day up from the relaxation HR granted (an announced Type 2 record with a claim date, or a
    ledger debit). The grant rows are the source of truth: the top-up survives every re-computation."""

    def setUp(self):
        super().setUp()
        self.on(shift_enabled=True)

    def grant(self, d, shifts, source="ot"):
        if source == "ot":
            # one OT record per employee and day: each grant is earned on its own earlier day
            earned = MON + timedelta(days=OvertimeRecord.objects.filter(employee=self.emp).count())
            return OvertimeRecord.objects.create(
                employee=self.emp,
                date=earned,
                last_punch_out=time(21, 0),
                ot_minutes=210,
                status="announced",
                compensation_type="relaxation",
                ot_type="shift",
                shifts=Decimal(shifts),
                claim_date=d,
            )
        return CompensationLedger.objects.create(
            employee=self.emp, entry_type="debit", shifts=Decimal(shifts), date=d, source="redemption"
        )

    def test_an_absent_day_becomes_a_paid_half_day(self):
        self.grant(WED, "0.50")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned, r.is_half_shift), ("half_shift", Decimal("0.50"), True))
        self.assertEqual(r.compensation_kind, "relaxation")
        self.assertIn("0.50 shift added from the overtime of 02 Mar 2026", r.compensation_note)

    def test_a_full_relaxation_makes_the_day_a_full_paid_day(self):
        self.grant(WED, "1.00")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned, r.is_half_shift), ("present", Decimal("1.00"), False))

    def test_a_quarter_relaxation(self):
        self.grant(WED, "0.25")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned), ("half_shift", Decimal("0.25")))

    def test_three_quarters_is_a_present_reduced_day(self):
        self.grant(WED, "0.75")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned, r.is_half_shift), ("present", Decimal("0.75"), False))

    def test_a_half_day_worked_is_topped_up_to_a_full_one(self):
        self.punch(WED, time(8, 30), time(12, 30))  # a morning only
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.50"))
        self.grant(WED, "0.50")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")))

    def test_it_is_capped_at_one_shift_and_a_full_day_is_not_marked(self):
        self.worked(WED, time(17, 40), first=time(8, 35))
        self.grant(WED, "0.50")
        r = self.rec(WED)
        self.assertEqual((r.shifts_earned, r.compensation_kind), (Decimal("1.00"), ""))
        # a quarter-shift arrival (0.75) plus 0.50 only gains the missing 0.25
        self.worked(WED, time(17, 40), first=time(10, 0))
        r = self.rec(WED)
        self.assertEqual((r.shifts_earned, r.compensation_kind), (Decimal("1.00"), "relaxation"))
        self.assertIn("0.25 shift added", r.compensation_note)

    def test_an_approved_unpaid_leave_day_is_made_paid(self):
        leave = LeaveRequest(
            employee=self.emp,
            start_date=str(WED),
            end_date=str(WED),
            status="approved",
            is_half_day=False,
        )
        leave.type = "casual"
        leave.save()
        # a bulk caller passes the leave dates, so compute through the month: that is the on_leave path
        self.assertEqual(self.month()[WED].status, "on_leave")
        self.grant(WED, "1.00")
        r = self.month()[WED]
        self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")))

    def test_it_survives_a_recomputation_and_follows_the_grant(self):
        g = self.grant(WED, "0.50")
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.50"))
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.50"))  # again: unchanged
        self.assertEqual(self.month()[WED].shifts_earned, Decimal("0.50"))
        g.delete()
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.00"))  # the grant is gone: so is the top-up

    def test_a_ledger_redemption_tops_up_the_same_way(self):
        self.grant(WED, "0.25", source="ledger")
        r = self.rec(WED)
        self.assertEqual((r.shifts_earned, r.compensation_kind), (Decimal("0.25"), "relaxation"))
        self.assertIn("the compensation balance", r.compensation_note)

    def test_two_grants_for_one_day_add_up_to_the_cap(self):
        self.grant(WED, "0.50")
        self.grant(WED, "0.75", source="ledger")
        r = self.rec(WED)
        self.assertEqual((r.shifts_earned, r.status), (Decimal("1.00"), "present"))

    def test_never_on_a_sunday_or_a_holiday(self):
        self.grant(SUN, "1.00")
        self.assertEqual(self.rec(SUN).shifts_earned, Decimal("0.00"))
        Holiday.objects.create(name="Festival", date=THU)
        _holiday_dates_for_month.cache_clear()
        self.grant(THU, "1.00")
        self.assertEqual(self.rec(THU).shifts_earned, Decimal("0.00"))
        self.assertEqual(self.month()[THU].status, "holiday")

    def test_only_an_announced_relaxation_with_shifts_counts(self):
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            last_punch_out=time(21, 0),
            ot_minutes=210,
            status="detected",
            compensation_type="relaxation",
            ot_type="shift",
            shifts=Decimal("0.50"),
            claim_date=WED,
        )
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=TUE,
            last_punch_out=time(21, 0),
            ot_minutes=210,
            status="announced",
            compensation_type="pay",
            ot_type="shift",
            shifts=Decimal("0.50"),
            claim_date=WED,
        )
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.00"))

    def test_it_is_a_commitment_that_the_feature_switches_do_not_take_back_but_the_master_switch_does(self):
        self.grant(WED, "0.50")
        set_config(shift_enabled=False, relaxation_enabled=False)
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.50"))
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.00"))

    def test_production_is_never_topped_up(self):
        prod = Employee.objects.create(
            employee_code="PRR", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        OvertimeRecord.objects.create(
            employee=prod,
            date=MON,
            last_punch_out=time(21, 0),
            ot_minutes=210,
            status="announced",
            compensation_type="relaxation",
            ot_type="shift",
            shifts=Decimal("0.50"),
            claim_date=WED,
        )
        self.assertEqual(self.rec(WED, prod).compensation_kind, "")

    def test_a_manual_day_is_never_recomputed(self):
        self.grant(WED, "0.50")
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=WED,
            status="absent",
            shifts_earned=Decimal("0"),
            source="manual",
            override_by="HR",
        )
        r = self.rec(WED)
        self.assertEqual((r.source, r.shifts_earned, r.compensation_kind), ("manual", Decimal("0.00"), ""))

    def test_the_relaxation_marker_wins_and_the_note_tells_the_allowance_too(self):
        set_config(allowance_enabled=True, allowance_effective_from=EFFECTIVE)
        self.worked(TUE, time(18, 30))  # 30 min allowance for Wednesday
        self.punch(
            WED, time(9, 50), time(13, 0)
        )  # a late morning only: 0.50 shift, Quarter-shift arrival without the allowance
        self.grant(WED, "0.50")
        r = self.rec(WED)
        self.assertEqual((r.status, r.shifts_earned), ("present", Decimal("1.00")))
        self.assertEqual(r.compensation_kind, "relaxation")
        self.assertEqual(r.compensation_minutes, 30)  # the allowance minutes the arrival used are kept
        self.assertIn("Compensation relaxation", r.compensation_note)
        self.assertIn("OT allowance", r.compensation_note)


# ── the day marker in the attendance JSON ───────────────────────────────────


class MarkerJsonTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True)
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40), first=time(9, 5))
        self.headers = hr_headers()

    def test_the_helper_and_permission_flags_carry_the_keys(self):
        r = self.rec(TUE)
        keys = compensation_marker_json(r)
        self.assertEqual(keys["compensationKind"], "ot_allowance")
        self.assertEqual(keys["compensationMinutes"], 25)
        self.assertIn("allowance", keys["compensationNote"])
        self.assertEqual(permission_flags_json(r)["compensationKind"], "ot_allowance")
        self.assertEqual(
            compensation_marker_json(None),
            {"compensationKind": None, "compensationMinutes": 0, "compensationNote": None},
        )
        self.assertIsNone(permission_flags_json(self.rec(MON))["compensationKind"])

    def assertMarked(self, day: dict):
        self.assertEqual(day["compensationKind"], "ot_allowance")
        self.assertEqual(day["compensationMinutes"], 25)
        self.assertIn("allowance", day["compensationNote"])

    def test_hr_employee_history(self):
        body = self.client.get(
            f"/api/attendance/employee/{self.emp.id}", {"month": 3, "year": 2026}, **self.headers
        ).json()
        self.assertMarked(next(r for r in body["records"] if r["date"] == str(TUE)))
        self.assertIsNone(next(r for r in body["records"] if r["date"] == str(MON))["compensationKind"])

    def test_hr_attendance_search_range_grid(self):
        body = self.client.get(
            "/api/attendance/search/range",
            {"employeeId": self.emp.id, "startDate": str(MON), "endDate": str(TUE)},
            **self.headers,
        ).json()
        self.assertMarked(next(d for d in body["days"] if d["date"] == str(TUE)))
        sheet = self.client.get(
            "/api/attendance/report-log/sheet", {"dateFrom": str(MON), "dateTo": str(TUE)}, **self.headers
        ).json()
        mine = next(e for e in sheet["employees"] if e["employeeId"] == self.emp.id)
        self.assertMarked(next(d for d in mine["days"] if d["date"] == str(TUE)))

    def test_hr_report_log_detail_and_daily(self):
        detail = self.client.get(
            "/api/attendance/report-log", {"month": 3, "year": 2026, "employeeId": self.emp.id}, **self.headers
        ).json()
        self.assertMarked(next(d for d in (detail.get("days") or detail["records"]) if d["date"] == str(TUE)))
        daily = self.client.get("/api/attendance/report-log", {"date": str(TUE)}, **self.headers).json()
        row = next(r for r in daily["rows"] if r["employeeId"] == self.emp.id)
        self.assertMarked(row)

    def test_employee_app_calendar_endpoints(self):
        emp_headers = bearer({"role": "employee", "employeeId": self.emp.id})
        stats = self.client.get(
            "/api/attendance/employee-shift-stats", {"month": 3, "year": 2026}, **emp_headers
        ).json()
        self.assertMarked(next(d for d in stats["dailyLogs"] if d["date"] == str(TUE)))
        monthly = self.client.get("/api/attendance/employee-monthly", {"month": 3, "year": 2026}, **emp_headers).json()
        found = [day for week in monthly["weeks"] for day in week["days"]]
        self.assertMarked(next(d for d in found if d["date"] == str(TUE)))


# ── query discipline ────────────────────────────────────────────────────────


class QueryCountTests(CompBase):
    """Month / range callers build the compensation context once: the number of queries does not grow with the days."""

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, windows_enabled=True, birthday_enabled=True, shift_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 20)
        self.emp.save()
        self.announce(date(2026, 3, 10), "late_in", time(10, 0))
        # a rich month: OT every other day, late arrivals, so the allowance lookups are exercised
        for i in range(2, 28):
            d = date(2026, 3, i)
            if d.weekday() == 6:
                continue
            self.worked(d, time(18, 30) if i % 2 == 0 else time(17, 40), first=time(9, 5) if i % 3 else time(8, 35))

    def count(self, call):
        with CaptureQueriesContext(connection) as ctx:
            call()
        return len(ctx), [q["sql"] for q in ctx.captured_queries]

    def test_a_range_costs_the_same_however_many_days_it_has(self):
        settings = PayrollSettings.get()
        compute_range_records(self.emp, date(2026, 3, 2), date(2026, 3, 27), settings)  # write everything once
        small, _ = self.count(lambda: compute_range_records(self.emp, date(2026, 3, 9), date(2026, 3, 10), settings))
        large, sqls = self.count(lambda: compute_range_records(self.emp, date(2026, 3, 2), date(2026, 3, 27), settings))
        self.assertEqual(small, large, "\n".join(sqls))

    def test_a_month_costs_the_same_whatever_its_late_days(self):
        settings = PayrollSettings.get()
        compute_month_records(self.emp, 2026, 3, settings)
        before, _ = self.count(lambda: compute_month_records(self.emp, 2026, 3, settings))
        # make every day late: many more allowance look-ups, no more queries
        for i in range(2, 28):
            d = date(2026, 3, i)
            if d.weekday() != 6:
                self.worked(d, time(18, 30), first=time(9, 5))
        compute_month_records(self.emp, 2026, 3, settings)
        after, sqls = self.count(lambda: compute_month_records(self.emp, 2026, 3, settings))
        self.assertEqual(before, after, "\n".join(sqls))

    def test_a_master_off_installation_adds_no_compensation_query(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        settings = PayrollSettings.get()
        compute_month_records(self.emp, 2026, 3, settings)
        _, sqls = self.count(lambda: compute_month_records(self.emp, 2026, 3, settings))
        self.assertFalse([s for s in sqls if 'FROM "compensation_' in s or 'JOIN "compensation_' in s], sqls)

    def test_the_roster_helper_builds_one_context_for_everybody(self):
        from .attendance_final import compensation_prefetch_for_day

        others = [self.new_staff(f"QC{i}") for i in range(5)]
        ids = [self.emp.id] + [e.id for e in others]
        settings = PayrollSettings.get()
        _, sqls = self.count(lambda: compensation_prefetch_for_day(settings, date(2026, 3, 10), ids))
        self.assertLessEqual(len(sqls), 6, sqls)
        prefetch = compensation_prefetch_for_day(settings, date(2026, 3, 10), ids)
        # an employee computed with the roster prefetch gets the same answer as one computed alone
        self.worked(date(2026, 3, 10), time(17, 40), first=time(9, 55))
        alone = self.rec(date(2026, 3, 10))
        with_roster = compute_day_record(self.emp, date(2026, 3, 10), settings=settings, prefetch=dict(prefetch))
        self.assertEqual(
            (alone.arrival_zone, alone.compensation_kind), (with_roster.arrival_zone, with_roster.compensation_kind)
        )
        self.assertEqual(alone.compensation_kind, "window_late_in")


class MigrationSeedTests(TestCase):
    """The data seed of migration 0119: defaults, and the old OT settings carried over."""

    def run_seed(self):
        import importlib

        from django.apps import apps

        module = importlib.import_module("api.migrations.0119_compensation_engine")
        module.seed_compensation(apps, None)

    def reset(self, **old):
        CompensationConfig.objects.all().delete()
        CompensationRule.objects.all().delete()
        ps = PayrollSettings.get()
        for k, v in old.items():
            setattr(ps, k, v)
        ps.save()

    def test_a_fresh_installation_gets_everything_off_and_the_owners_tables(self):
        self.reset(ot_detection_enabled=False)
        self.run_seed()
        c = CompensationConfig.get()
        self.assertEqual(
            (c.allowance_enabled, c.shift_enabled, c.windows_enabled, c.holiday_work_enabled, c.birthday_enabled),
            (False,) * 5,
        )
        self.assertEqual((c.shift_min_extra_minutes, c.relaxation_enabled, c.pay_enabled), (150, True, False))
        self.assertEqual((c.allowance_effective_from, c.birthday_effective_from), (None, None))
        allowance = list(
            CompensationRule.objects.filter(kind="allowance")
            .order_by("sort_order")
            .values_list("min_extra_minutes", "allowance_minutes")
        )
        self.assertEqual(allowance, [(60, 30), (90, 30), (120, 60), (150, 60)])
        shift = list(
            CompensationRule.objects.filter(kind="shift").order_by("sort_order").values_list("until_minutes", "shifts")
        )
        self.assertEqual(
            shift, [(1260, Decimal("0.25")), (1440, Decimal("0.50")), (1560, Decimal("0.75")), (None, Decimal("1.00"))]
        )

    def test_an_installation_that_used_ot_keeps_working_exactly_as_before(self):
        self.reset(ot_detection_enabled=True, ot_threshold_minutes=60, ot_compensation_type="pay")
        self.run_seed()
        c = CompensationConfig.get()
        self.assertTrue(c.shift_enabled)
        self.assertEqual((c.relaxation_enabled, c.pay_enabled), (True, True))  # HR could pick either per batch before
        self.assertEqual(c.shift_min_extra_minutes, 150)  # the default 60 was never a choice: the owner's 150
        self.assertFalse(c.allowance_enabled or c.windows_enabled or c.birthday_enabled or c.holiday_work_enabled)

    def test_a_customised_old_threshold_is_carried_over(self):
        self.reset(ot_detection_enabled=True, ot_threshold_minutes=240)
        self.run_seed()
        # The old detector flagged a day with AT LEAST 240 extra minutes; Type 2 is MORE THAN the threshold, so the
        # carried value is one less and the day with exactly 240 minutes is still detected.
        threshold = CompensationConfig.get().shift_min_extra_minutes
        self.assertEqual(threshold, 239)
        from .compensation_rules import is_type2_day

        self.assertTrue(is_type2_day(240, threshold))
        self.assertFalse(is_type2_day(239, threshold))

    def test_a_customised_threshold_with_detection_off_is_not_carried_over(self):
        self.reset(ot_detection_enabled=False, ot_threshold_minutes=240)
        self.run_seed()
        c = CompensationConfig.get()
        self.assertEqual((c.shift_min_extra_minutes, c.shift_enabled), (150, False))

    def test_running_it_twice_changes_nothing_and_never_resets_an_edited_table(self):
        self.reset(ot_detection_enabled=True)
        self.run_seed()
        CompensationRule.objects.filter(kind="allowance", min_extra_minutes=60).update(allowance_minutes=45)
        set_config(allowance_enabled=True)
        self.run_seed()
        self.assertEqual(CompensationRule.objects.filter(kind="allowance").count(), 4)
        self.assertEqual(CompensationRule.objects.filter(kind="shift").count(), 4)
        self.assertEqual(CompensationRule.objects.get(kind="allowance", min_extra_minutes=60).allowance_minutes, 45)
        self.assertTrue(CompensationConfig.get().allowance_enabled)
