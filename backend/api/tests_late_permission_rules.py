"""
Late Detection / Permission / Half-Day Detection -the behaviours that make a deduction explainable
to the employee it was applied to, in BOTH attendance modes, plus the compatibility surface the
already-installed mobile app and deployed web app depend on while the backend is rolled out.

Run via: python manage.py test api.tests_late_permission_rules -v 2

Shift 09:00-18:00, 15 min grace, first half ends 13:30. Half-Day cut-offs at their defaults
(13:30 / 14:30). Every date is a weekday in a month that is already over.
"""

from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase

from .arrival_rules import hhmm, limits_for as arrival_limits_for
from .attendance_final import (
    compute_day_record,
    compute_range_records,
    half_period,
    infer_permission_type,
    late_pool_summary,
    permission_flags_json,
)
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    LeaveRequest,
    PayrollSettings,
    ShiftTemplate,
)
from .payroll_views import _generate_staff_payroll, staff_working_days


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr():
    admin, _ = HRUser.objects.get_or_create(
        username="rules_admin",
        defaults={"password_hash": "x", "is_super_admin": True},
    )
    return _bearer({"role": "hr", "hrUserId": admin.id})


def _emp_token(emp_id: int):
    return _bearer({"role": "employee", "employeeId": emp_id})


def _make_shift():
    return ShiftTemplate.objects.create(
        name="Rules Shift",
        shift_type="staff",
        start_time=time(9, 0),
        end_time=time(18, 0),
        grace_period_minutes=15,
        first_half_end=time(13, 30),
        lunch_duration_minutes=60,
        lunch_grace_minutes=10,
    )


class _RulesMixin:
    """The same assertions run against Simple and Strict mode (see the two concrete classes)."""

    MODE = None
    CODE = None

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.attendance_mode = cls.MODE
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.permission_monthly_cap = 3
        ps.late_free_allowance = 3
        ps.save()
        cls.shift = _make_shift()
        cls.emp = Employee.objects.create(
            employee_code=cls.CODE,
            first_name="Rules",
            last_name=cls.MODE.title(),
            employment_type="staff",
            status="active",
            salary_amount=Decimal("26000"),
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp,
            shift=cls.shift,
            effective_from=date(2020, 1, 1),
        )

    # ── helpers ──
    def _punch(self, d, *times):
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def _perm(self, d, kind, status="approved", **kw):
        return EmployeePermission.objects.create(employee=self.emp, date=d, type=kind, status=status, **kw)

    def _record(self, d):
        return compute_day_record(self.emp, d, settings=PayrollSettings.get())

    # ── Half-Day Detection: same rule in both modes ──
    def test_half_day_windows(self):
        full, second_only, first_only = date(2026, 4, 1), date(2026, 4, 2), date(2026, 4, 3)
        self._punch(full, time(9, 0), time(18, 0))
        self._punch(second_only, time(14, 35), time(18, 0))
        self._punch(first_only, time(9, 0), time(13, 0))
        self.assertEqual(self._record(full).status, "present")
        self.assertEqual(self._record(second_only).status, "half_shift")
        self.assertEqual(self._record(second_only).shifts_earned, Decimal("0.50"))
        self.assertEqual(self._record(first_only).status, "half_shift")

    def test_half_day_cutoffs_come_from_settings_not_from_the_shift(self):
        ps = PayrollSettings.get()
        ps.half_day_first_half_end_time = time(12, 0)
        ps.half_day_second_half_start_time = time(13, 0)
        ps.save()
        d = date(2026, 4, 6)
        self._punch(d, time(12, 30), time(18, 0))  # first punch after the (moved) morning cutoff
        self.assertEqual(self._record(d).status, "half_shift")

    # ── The morning arrival timeline (shift 09:00, grace 15: on time to 09:15, Late to 10:15,
    #    permission window to 11:15, first half to 11:35) ──
    def test_the_arrival_timeline_for_a_nine_o_clock_shift(self):
        cases = [
            # first punch, status, shifts earned, is_late, zone
            (time(9, 15), "present", "1.00", False, "on_time"),
            (time(9, 16), "present", "1.00", True, "late"),
            (time(10, 15), "present", "1.00", True, "late"),
            (time(10, 16), "present", "0.75", False, "quarter"),
            (time(11, 15), "present", "0.75", False, "quarter"),
            (time(11, 35), "present", "0.75", False, "quarter"),
            (time(11, 36), "half_shift", "0.50", False, "second_half"),
            (time(13, 40), "half_shift", "0.50", False, "second_half"),
        ]
        for i, (first, status, shifts, late, zone) in enumerate(cases):
            d = date(2026, 4, 1 + i)
            self._punch(d, first, time(18, 0))
            r = self._record(d)
            self.assertEqual(
                (r.status, str(r.shifts_earned), r.is_late, r.arrival_zone), (status, shifts, late, zone), first
            )

    def test_a_quarter_shift_arrival_is_not_also_a_late_in_and_says_why(self):
        d = date(2026, 4, 20)
        self._punch(d, time(11, 0), time(18, 0))
        r = self._record(d)
        self.assertFalse(r.is_late)
        self.assertNotIn("Morning Late-In", r.late_reason)
        self.assertIn("Quarter-shift arrival", r.late_reason)
        self.assertIn("first punch 11:00", r.late_reason)
        self.assertIn("0.25 shift deducted", r.late_reason)
        # one cause, one consequence: the late pool is not charged for the same morning
        self.assertEqual(late_pool_summary([r], 0, PayrollSettings.get())["late_in"], 0)

    def test_a_second_half_arrival_is_absent_until_a_second_half_punch(self):
        d = date(2026, 4, 21)
        self._punch(d, time(12, 30))  # 12:30 is after 11:35, and 14:30 has not come yet
        r = self._record(d)
        self.assertEqual(
            (r.status, r.shifts_earned, r.arrival_zone, r.is_late), ("absent", Decimal("0"), "second_half", False)
        )
        self.assertIn("Second-half arrival", r.late_reason)
        self._punch(d, time(12, 30), time(14, 35))  # the second-half punch is in
        r = self._record(d)
        self.assertEqual(
            (r.status, r.shifts_earned, r.is_half_shift, r.is_late), ("half_shift", Decimal("0.50"), True, False)
        )
        self.assertEqual(half_period(r, PayrollSettings.get()), "evening")

    def test_a_quarter_shift_arrival_who_never_makes_a_second_half_punch_is_a_half_day_not_docked_twice(self):
        d = date(2026, 4, 22)
        self._punch(d, time(11, 0), time(13, 0))  # came in time for the first half, gone before the second
        r = self._record(d)
        self.assertEqual((r.status, r.shifts_earned, r.arrival_zone), ("half_shift", Decimal("0.50"), "quarter"))
        self.assertEqual(half_period(r, PayrollSettings.get()), "morning")

    def test_an_approved_permission_excuses_up_to_the_end_of_the_permission_window(self):
        cases = [
            (time(10, 40), "present", "1.00", "excused"),  # after the Late window: the permission covers it
            (time(11, 15), "present", "1.00", "excused"),  # the last minute of the permission window
            (time(11, 16), "present", "0.75", "quarter"),  # the extra minutes are never covered
            (time(11, 36), "half_shift", "0.50", "second_half"),
        ]
        for i, (first, status, shifts, zone) in enumerate(cases):
            d = date(2026, 5, 4 + i)
            self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
            self._punch(d, first, time(18, 0))
            r = self._record(d)
            self.assertEqual(
                (r.status, str(r.shifts_earned), r.arrival_zone, r.is_late), (status, shifts, zone, False), first
            )
        excused = self._record(date(2026, 5, 4))
        self.assertTrue(excused.morning_permission_applied)
        self.assertIn("Approved Morning Late-In permission", excused.late_reason)
        self.assertEqual(late_pool_summary([excused], 0, PayrollSettings.get())["late_in"], 0)

    def test_a_permission_over_the_monthly_cap_excuses_nothing(self):
        for dd in (5, 6, 7, 8):
            self._perm(date(2026, 6, dd), EmployeePermission.TYPE_MORNING_LATE_IN)
        d = date(2026, 6, 8)  # the 4th: approved but Excess
        self._punch(d, time(10, 40), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.morning_permission_excess)
        self.assertEqual((r.arrival_zone, r.shifts_earned, r.is_late), ("quarter", Decimal("0.75"), False))

    def test_every_window_and_the_deduction_come_from_settings(self):
        ps = PayrollSettings.get()
        ps.arrival_late_window_minutes = 30  # Late to 09:45
        ps.arrival_permission_window_minutes = 30  # permission window to 10:15
        ps.arrival_extra_minutes = 10  # first half to 10:25
        ps.arrival_quarter_deduction = Decimal("0.50")
        ps.save()
        cases = [
            (time(9, 45), "1.00", "late"),
            (time(9, 46), "0.50", "quarter"),
            (time(10, 25), "0.50", "quarter"),
        ]
        for i, (first, shifts, zone) in enumerate(cases):
            d = date(2026, 6, 15 + i)
            self._punch(d, first, time(18, 0))
            r = self._record(d)
            self.assertEqual((str(r.shifts_earned), r.arrival_zone), (shifts, zone), first)
        d = date(2026, 6, 18)
        self._punch(d, time(10, 26), time(18, 0))
        self.assertEqual((self._record(d).status, self._record(d).arrival_zone), ("half_shift", "second_half"))

    def test_the_windows_follow_each_shifts_own_start_and_grace(self):
        late_shift = ShiftTemplate.objects.create(
            name="Late",
            shift_type="staff",
            start_time=time(14, 0),
            end_time=time(22, 0),
            grace_period_minutes=5,
            first_half_end=time(18, 0),
            lunch_duration_minutes=30,
            lunch_grace_minutes=5,
        )
        other = Employee.objects.create(
            employee_code=f"{self.CODE}B",
            first_name="Late",
            last_name="Shift",
            employment_type="staff",
            status="active",
        )
        EmployeeShiftAssignment.objects.create(employee=other, shift=late_shift, effective_from=date(2020, 1, 1))
        d = date(2026, 7, 13)
        for first, zone in (
            (time(14, 5), "on_time"),
            (time(15, 5), "late"),
            (time(16, 6), "quarter"),
            (time(16, 26), "second_half"),
        ):
            AttendanceLog.objects.filter(employee=other, date=d).delete()
            for tm in (first, time(21, 0)):
                AttendanceLog.objects.create(employee=other, date=d, punch_time=tm, punch_type="IN", source="test")
            self.assertEqual(compute_day_record(other, d, settings=PayrollSettings.get()).arrival_zone, zone, first)

    def test_switching_late_in_off_does_not_switch_the_quarter_rule_off(self):
        ps = PayrollSettings.get()
        ps.morning_late_in_enabled = False
        ps.save()
        late, quarter = date(2026, 7, 6), date(2026, 7, 7)
        self._punch(late, time(9, 40), time(18, 0))
        self._punch(quarter, time(11, 0), time(18, 0))
        self.assertEqual((self._record(late).is_late, str(self._record(late).shifts_earned)), (False, "1.00"))
        self.assertEqual(str(self._record(quarter).shifts_earned), "0.75")  # set the deduction to 0 to switch it off

    def test_an_employee_with_no_shift_keeps_the_fixed_first_half_cutoff(self):
        nobody = Employee.objects.create(
            employee_code=f"{self.CODE}N", first_name="No", last_name="Shift", employment_type="staff", status="active"
        )
        for d, first, status in (
            (date(2026, 7, 8), time(12, 0), "present"),
            (date(2026, 7, 9), time(14, 0), "half_shift"),
        ):
            for tm in (first, time(18, 0)):
                AttendanceLog.objects.create(employee=nobody, date=d, punch_time=tm, punch_type="IN", source="test")
            r = compute_day_record(nobody, d, settings=PayrollSettings.get())
            self.assertEqual((r.status, r.arrival_zone), (status, ""), first)

    def test_payroll_pays_a_quarter_shift_day_as_three_quarters_of_a_day_and_not_as_late(self):
        days = staff_working_days(self.emp, 8, 2026)
        for d in days:
            self._punch(d, time(9, 0), time(18, 0))
        full = _generate_staff_payroll(self.emp, 8, 2026)["slip"].breakdown_details
        self.assertEqual(full["summary"]["effectivePaidDays"], float(len(days)))
        self._punch(days[3], time(11, 0), time(18, 0))  # one quarter-shift arrival
        docked = _generate_staff_payroll(self.emp, 8, 2026)["slip"].breakdown_details
        self.assertEqual(docked["summary"]["effectivePaidDays"], len(days) - 0.25)
        self.assertEqual(docked["summary"]["lateDays"], 0)  # the quarter shift is not also a late
        self.assertEqual(docked["deductions"]["lateSummary"]["lateInCount"], 0)
        self.assertLess(docked["earnings"]["grossSalary"], full["earnings"]["grossSalary"])
        self.assertAlmostEqual(
            full["earnings"]["grossSalary"] - docked["earnings"]["grossSalary"],
            26000 / len(days) * 0.25,
            places=1,
        )
        # and the day is shown to HR as it was decided
        day = next(x for x in docked["days"] if x["date"] == days[3].isoformat())
        self.assertEqual((day["arrivalZone"], day["shiftsCompleted"], day["isLate"]), ("quarter", 0.75, False))

    def test_a_quarter_zone_arrival_that_is_already_a_half_day_is_not_docked_twice_and_says_so(self):
        d = date(2026, 4, 28)
        self._punch(d, time(11, 0), time(13, 0))
        r = self._record(d)
        self.assertEqual((r.status, r.shifts_earned), ("half_shift", Decimal("0.50")))
        self.assertIn("nothing further is deducted", r.late_reason)
        self.assertNotIn("0.25 shift deducted", r.late_reason)

    def test_the_attendance_api_says_where_the_first_punch_fell(self):
        d = date(2026, 4, 29)
        self._punch(d, time(11, 0), time(18, 0))
        hist = self.client.get(
            f"/api/attendance/employee/{self.emp.id}?month=4&year=2026", **_emp_token(self.emp.id)
        ).json()
        day = next(r for r in hist["records"] if r["date"] == d.isoformat())
        self.assertEqual((day["arrivalZone"], day["status"], day["isLate"]), ("quarter", "present", False))
        self.assertIn("Quarter-shift arrival", day["lateReason"])

    # ── Late Detection: the two switches are independent ──
    def test_the_two_detections_can_be_switched_off_independently(self):
        d = date(2026, 4, 7)
        self._punch(d, time(10, 0), time(16, 0))  # late AND early
        r = self._record(d)
        self.assertTrue(r.is_late)
        self.assertTrue(r.early_leave)
        ps = PayrollSettings.get()
        ps.morning_late_in_enabled = False
        ps.save()
        r = self._record(d)
        self.assertFalse(r.is_late)
        self.assertTrue(r.early_leave)
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = False
        ps.save()
        r = self._record(d)
        self.assertTrue(r.is_late)
        self.assertFalse(r.early_leave)

    # ── Permissions ──
    def test_morning_and_evening_permission_on_the_same_day_both_apply(self):
        # An employee can hold both on one day; only the last-updated one used to count.
        d = date(2026, 4, 8)
        self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
        self._perm(d, EmployeePermission.TYPE_EVENING_EARLY_OUT)
        self._punch(d, time(10, 10), time(17, 10))  # 70 min late, 50 min early against the real shift
        r = self._record(d)
        self.assertFalse(r.is_late)
        self.assertFalse(r.early_leave)
        self.assertTrue(r.morning_permission_applied)
        self.assertTrue(r.evening_permission_applied)
        self.assertFalse(r.morning_permission_excess or r.evening_permission_excess)

    def test_a_permission_saved_in_the_old_spelling_protects_the_day_like_a_new_one(self):
        d1, d2 = date(2026, 4, 9), date(2026, 4, 10)
        self._perm(d1, "Late In")  # what the installed mobile app has always sent
        self._perm(d2, "Early Out")
        self._punch(d1, time(10, 10), time(18, 0))
        self._punch(d2, time(9, 0), time(17, 10))
        self.assertFalse(self._record(d1).is_late)
        self.assertTrue(self._record(d1).morning_permission_applied)
        self.assertFalse(self._record(d2).early_leave)
        self.assertTrue(self._record(d2).evening_permission_applied)

    def test_an_untyped_permission_is_inferred_from_its_requested_time(self):
        morning, evening, nothing = date(2026, 4, 13), date(2026, 4, 14), date(2026, 4, 15)
        self._perm(morning, None, permission_time=time(10, 0))  # 60 min after the 09:00 start
        self._perm(evening, None, permission_time=time(17, 0))  # 60 min before the 18:00 end
        self._perm(nothing, None)  # no time at all: cannot infer
        self._punch(morning, time(10, 10), time(18, 0))
        self._punch(evening, time(9, 0), time(17, 10))
        self._punch(nothing, time(10, 10), time(18, 0))
        self.assertFalse(self._record(morning).is_late)
        self.assertFalse(self._record(evening).early_leave)
        self.assertTrue(self._record(nothing).is_late)  # shifts nothing
        self.assertFalse(self._record(nothing).morning_permission_applied)

    def test_every_permission_type_counts_toward_the_monthly_cap(self):
        for day in (4, 5, 6):
            self._perm(date(2026, 5, day), EmployeePermission.TYPE_MIDDLE_PERMISSION)
        d = date(2026, 5, 7)
        self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)  # the 4th approved one that month
        self._punch(d, time(10, 10), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_late)  # did not protect the day
        self.assertTrue(r.morning_permission_excess)
        self.assertFalse(r.morning_permission_applied)

    def test_a_rejected_permission_never_protects_or_counts(self):
        d = date(2026, 5, 11)
        self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN, status="rejected")
        self._punch(d, time(10, 10), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_late)
        self.assertFalse(r.morning_permission_applied or r.morning_permission_excess)

    # ── One occurrence, not two ──
    def test_an_excess_permission_and_the_lateness_it_failed_to_cover_count_once(self):
        days = [date(2026, 6, dd) for dd in (1, 2, 3, 4)]
        for d in days:
            self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
            self._punch(d, time(10, 10), time(18, 0))
        records = [self._record(d) for d in days]
        self.assertEqual([r.is_late for r in records], [False, False, False, True])
        pool = late_pool_summary(records, 4, PayrollSettings.get())
        self.assertEqual(pool["late_in"], 0)  # day 4's lateness IS the excess permission
        self.assertEqual(pool["excess_permissions"], 1)
        self.assertEqual(pool["total"], 1)

    def test_a_plain_late_day_still_counts_on_top_of_an_excess_permission(self):
        days = [date(2026, 6, dd) for dd in (1, 2, 3, 4)]
        for d in days:
            self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
            self._punch(d, time(10, 10), time(18, 0))
        plain = date(2026, 6, 8)
        self._punch(plain, time(9, 40), time(18, 0))
        records = [self._record(d) for d in days + [plain]]
        pool = late_pool_summary(records, 4, PayrollSettings.get())
        self.assertEqual((pool["late_in"], pool["excess_permissions"], pool["total"]), (1, 1, 2))
        self.assertEqual(pool["billable"], 0)  # 2 occurrences: still inside the 3 free

    def test_pool_can_be_restricted_to_working_days(self):
        d = date(2026, 6, 9)
        self._punch(d, time(9, 40), time(18, 0))
        records = [self._record(d)]
        ps = PayrollSettings.get()
        self.assertEqual(late_pool_summary(records, 0, ps)["late_in"], 1)
        self.assertEqual(late_pool_summary(records, 0, ps, counted_dates=set())["late_in"], 0)

    # ── The explanation HR reads back to an employee ──
    def test_the_reason_spells_out_how_the_deadline_was_built(self):
        d = date(2026, 7, 6)
        self._punch(d, time(9, 40), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.is_late)
        self.assertIn("deadline 09:15", r.late_reason)
        self.assertIn("shift start 09:00", r.late_reason)
        self.assertIn("15 min grace", r.late_reason)

    def test_the_reason_says_when_an_approved_permission_was_excess(self):
        for dd in (6, 7, 8, 9):
            self._perm(date(2026, 7, dd), EmployeePermission.TYPE_MORNING_LATE_IN)
        d = date(2026, 7, 9)
        self._punch(d, time(10, 10), time(18, 0))
        r = self._record(d)
        self.assertTrue(r.morning_permission_excess)
        self.assertIn("Excess", r.late_reason)
        self.assertIn("plain shift start", r.late_reason)

    # ── Payroll and the employee's own shift-stats screen show the same numbers ──
    def test_payroll_and_employee_shift_stats_agree(self):
        month = 3
        for dd in (2, 3, 4, 5):  # 3 protected + 1 excess morning permission
            self._perm(date(2026, month, dd), EmployeePermission.TYPE_MORNING_LATE_IN)
            self._punch(date(2026, month, dd), time(10, 10), time(18, 0))
        for dd in (9, 10):  # two plain lates
            self._punch(date(2026, month, dd), time(9, 40), time(18, 0))
        self._punch(date(2026, month, 11), time(9, 0), time(17, 0))  # one early-out
        self._punch(date(2026, month, 12), time(9, 0), time(18, 0))

        slip = _generate_staff_payroll(self.emp, month, 2026)["slip"]
        late = slip.breakdown_details["deductions"]["lateSummary"]
        self.assertEqual(
            (late["lateInCount"], late["earlyOutCount"], late["excessPermissionCount"], late["totalLateCount"]),
            (2, 1, 1, 4),
        )
        self.assertEqual(late["billableLateCount"], 1)

        resp = self.client.get(
            f"/api/attendance/employee-shift-stats?month={month}&year=2026",
            **_emp_token(self.emp.id),
        )
        self.assertEqual(resp.status_code, 200)
        stats = resp.json()["summary"]
        self.assertEqual(stats["lateInCount"], late["lateInCount"])
        self.assertEqual(stats["earlyOutCount"], late["earlyOutCount"])
        self.assertEqual(stats["excessPermissionCount"], late["excessPermissionCount"])
        self.assertEqual(stats["billableLateCount"], late["billableLateCount"])
        self.assertEqual(Decimal(stats["shiftDeductions"]), Decimal(str(late["shiftDeductions"])))

    # ── What the installed apps read ──
    # ── Cross-midnight, early-out agreement, excused days, wide ranges ──
    def test_an_exit_after_midnight_is_the_evening_half_not_an_early_out(self):
        # A 01:00 exit is reattributed from the next calendar date to this working day. Read as a bare
        # clock time it is "before 13:30" (Morning half only -a Half Day) and "before 18:00" (an
        # early-out); it is really 25:00, so the day is a Full Day and nobody left early.
        ps = PayrollSettings.get()
        ps.last_punch_post_shift_grace_hours = Decimal("9")
        ps.save()
        d = date(2026, 4, 20)  # Monday
        self._punch(d, time(9, 0), time(13, 0), time(14, 0))
        AttendanceLog.objects.create(
            employee=self.emp,
            date=d + timedelta(days=1),
            punch_time=time(1, 0),
            punch_type="IN",
            source="test",
        )
        r = self._record(d)
        self.assertEqual(r.status, "present")
        self.assertEqual(r.shifts_earned, Decimal("1.00"))
        self.assertFalse(r.early_leave)

    def test_both_modes_agree_on_when_someone_left_early(self):
        lone, at_lunch, full = date(2026, 4, 21), date(2026, 4, 22), date(2026, 4, 23)
        self._punch(lone, time(9, 0))
        self._punch(at_lunch, time(9, 0), time(13, 0))
        self._punch(full, time(9, 0), time(18, 0))
        self.assertFalse(self._record(lone).early_leave)  # a lone punch says nothing about leaving
        r = self._record(at_lunch)
        self.assertTrue(r.early_leave)  # left at 13:00, long before 18:00
        self.assertEqual(r.status, "half_shift")
        self.assertFalse(self._record(full).early_leave)

    def test_leaving_at_lunch_on_an_afternoon_half_day_leave_is_not_an_early_out(self):
        d = date(2026, 4, 24)
        self._punch(d, time(9, 0), time(13, 0))
        r = compute_day_record(
            self.emp,
            d,
            settings=PayrollSettings.get(),
            leave_dates=set(),
            holiday_dates=set(),
            half_day_leave_dates={d: LeaveRequest.HALF_DAY_AFTERNOON},
        )
        self.assertTrue(r.is_half_day_leave)
        self.assertFalse(r.early_leave)
        self.assertNotIn("Early-Out", r.late_reason or "")

    def test_a_range_over_three_months_still_ranks_the_middle_months_permissions(self):
        # Only the first and last month of a range used to get a cap-position list, so every
        # permission in the months between was treated as in-cap.
        days = [date(2026, 2, dd) for dd in (2, 3, 4, 5)]  # Mon-Thu, the middle month
        for d in days:
            self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
            self._punch(d, time(10, 10), time(18, 0))
        recs = {r.date: r for r in compute_range_records(self.emp, date(2026, 1, 26), date(2026, 3, 10))}
        self.assertEqual([recs[d].morning_permission_excess for d in days], [False, False, False, True])
        self.assertTrue(recs[days[3]].is_late)

    def test_attendance_history_carries_both_generations_of_permission_keys(self):
        d = date(2026, 4, 16)
        self._perm(d, EmployeePermission.TYPE_MORNING_LATE_IN)
        self._punch(d, time(10, 10), time(18, 0))
        resp = self.client.get(
            f"/api/attendance/employee/{self.emp.id}?month=4&year=2026",
            **_emp_token(self.emp.id),
        )
        self.assertEqual(resp.status_code, 200)
        day = next(r for r in resp.json()["records"] if r["date"] == d.isoformat())
        self.assertTrue(day["morningPermissionApplied"])
        self.assertTrue(day["permissionMorning"])  # deprecated mirror the old apps read
        self.assertTrue(day["permissionMorningWithRequest"])
        self.assertFalse(day["permissionEscalatedToHalfShift"])
        self.assertIn("isEarlyOut", day)
        self.assertFalse(day["isLate"])

    def test_employee_endpoints_explain_a_flagged_day(self):
        # The employee can see WHY: the exact deadline and how it was built, not just "Late".
        d = date(2026, 4, 17)
        self._punch(d, time(9, 40), time(18, 0))
        token = _emp_token(self.emp.id)
        hist = self.client.get(f"/api/attendance/employee/{self.emp.id}?month=4&year=2026", **token).json()
        day = next(r for r in hist["records"] if r["date"] == d.isoformat())
        self.assertTrue(day["isLate"])
        self.assertIn("deadline 09:15", day["lateReason"])
        self.assertIn("shift start 09:00 + 15 min grace", day["lateReason"])
        stats = self.client.get("/api/attendance/employee-shift-stats?month=4&year=2026", **token).json()
        row = next(r for r in stats["dailyLogs"] if r["date"] == d.isoformat())
        self.assertIn("deadline 09:15", row["lateReason"])
        # ...and states the company-wide rules it was judged by (the app cannot read settings).
        self.assertEqual(
            stats["policy"],
            {
                "morningLateInEnabled": True,
                "eveningEarlyOutEnabled": True,
                "halfDayFirstHalfEnd": "13:30",  # retired fixed cut-off, still reported for the installed apps
                "halfDaySecondHalfStart": "14:30",
                "lateWindowMinutes": 60,
                "permissionWindowMinutes": 60,
                "arrivalExtraMinutes": 20,
                "arrivalQuarterDeduction": 0.25,
                "permissionMonthlyCap": 3,
                "freeAllowance": 3,
                "permissionDurationMinutes": 60,
            },
        )


class ExcusedDayTests(TestCase):
    """Days HR or a paid-leave decision settles are never recomputed, so a flag left on them would
    keep billing in the late pool with nobody able to clear it."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.evening_early_out_enabled = True
        ps.save()
        cls.shift = _make_shift()
        cls.emp = Employee.objects.create(
            employee_code="EXCUSED1",
            first_name="Ex",
            last_name="Cused",
            employment_type="staff",
            status="active",
        )
        EmployeeShiftAssignment.objects.create(employee=cls.emp, shift=cls.shift, effective_from=date(2020, 1, 1))

    def _early_day(self, d):
        AttendanceLog.objects.filter(employee=self.emp, date=d).delete()
        for t in (time(9, 0), time(15, 0)):
            AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=t, punch_type="IN", source="test")
        rec = compute_day_record(self.emp, d, settings=PayrollSettings.get())
        self.assertTrue(rec.early_leave)  # precondition: the auto engine flagged it
        return rec

    def test_hr_can_waive_an_early_out_and_an_override_never_leaves_a_stale_one(self):
        from .growth_views import _resolve_override_fields, apply_override_values

        rec = self._early_day(date(2026, 5, 4))
        kept = _resolve_override_fields(rec, self.emp, {"status": "present"})
        self.assertTrue(kept["isEarlyOut"])  # untouched by HR -carried as flagged
        waived = _resolve_override_fields(rec, self.emp, {"status": "present", "isEarlyOut": False})
        apply_override_values(rec, waived, "hr")
        rec.refresh_from_db()
        self.assertEqual(rec.source, "manual")
        self.assertFalse(rec.early_leave)
        self.assertIsNone(rec.late_reason)
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["early_out"], 0)

    def test_an_absent_override_clears_the_early_out_too(self):
        from .growth_views import _resolve_override_fields

        rec = self._early_day(date(2026, 5, 5))
        self.assertFalse(_resolve_override_fields(rec, self.emp, {"status": "absent"})["isEarlyOut"])

    def test_a_request_saved_before_early_out_existed_clears_it_on_approval(self):
        from .growth_views import apply_override_values

        rec = self._early_day(date(2026, 5, 6))
        apply_override_values(
            rec,
            {
                "status": "present",
                "isLate": False,
                "isHalfShift": False,
                "firstPunch": "09:00",
                "lastPunch": "15:00",
                "shiftsEarned": "1.00",
                "note": "old request",
            },
            "hr",
        )
        rec.refresh_from_db()
        self.assertFalse(rec.early_leave)

    def test_an_approved_casual_leave_is_a_clean_paid_day(self):
        from .casual_leave_views import _write_attendance_for_cl
        from .models import AttendanceDayRecord, CasualLeaveRequest

        d = date(2026, 5, 7)
        self._early_day(d)
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=d, status=CasualLeaveRequest.STATUS_APPROVED)
        _write_attendance_for_cl(cl, "hr")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual((rec.status, rec.source, rec.early_leave, rec.is_late), ("present", "manual", False, False))
        self.assertIsNone(rec.late_reason)


class StrictModeRulesTests(_RulesMixin, TestCase):
    MODE = "strict"
    CODE = "RULES_STRICT"


class SimpleModeRulesTests(_RulesMixin, TestCase):
    MODE = "simple"
    CODE = "RULES_SIMPLE"


class PermissionTypeTests(TestCase):
    def test_every_spelling_normalizes_to_one_type(self):
        n = EmployeePermission.normalize_type
        for raw in ("morning_late_in", "Morning Late-In", "Late In", "late-in", "  LATE_IN "):
            self.assertEqual(n(raw), EmployeePermission.TYPE_MORNING_LATE_IN, raw)
        for raw in ("evening_early_out", "Evening Early-Out", "Early Out"):
            self.assertEqual(n(raw), EmployeePermission.TYPE_EVENING_EARLY_OUT, raw)
        for raw in ("middle_permission", "Middle One-Hour Permission", "Short Leave"):
            self.assertEqual(n(raw), EmployeePermission.TYPE_MIDDLE_PERMISSION, raw)
        for raw in (None, "", "coffee break"):
            self.assertIsNone(n(raw), raw)

    def test_type_values_lists_both_spellings_for_queryset_filters(self):
        self.assertEqual(
            EmployeePermission.type_values(EmployeePermission.TYPE_MORNING_LATE_IN),
            ["morning_late_in", "Late In"],
        )

    def test_inference_needs_a_time_and_a_shift(self):
        shift = _make_shift()
        self.assertIsNone(infer_permission_type(None, shift))
        self.assertIsNone(infer_permission_type(time(10, 0), None))
        self.assertEqual(infer_permission_type(time(10, 0), shift), EmployeePermission.TYPE_MORNING_LATE_IN)
        self.assertEqual(infer_permission_type(time(17, 0), shift), EmployeePermission.TYPE_EVENING_EARLY_OUT)
        self.assertEqual(infer_permission_type(time(13, 0), shift), EmployeePermission.TYPE_MIDDLE_PERMISSION)

    def test_flags_json_mirrors_the_deprecated_keys(self):
        self.assertFalse(permission_flags_json(None)["permissionMorning"])

        class Rec:
            morning_permission_applied = True
            evening_permission_applied = False
            morning_permission_excess = False
            evening_permission_excess = True
            middle_permission_today = True
            permission_afternoon = False

        flags = permission_flags_json(Rec())
        self.assertTrue(flags["permissionMorning"] and flags["permissionMorningWithRequest"])
        self.assertFalse(flags["permissionDeparture"])
        self.assertTrue(flags["eveningPermissionExcess"] and flags["middlePermissionToday"])
        self.assertEqual(flags["permissionZoneCount"], 1)


class PermissionApiTests(TestCase):
    """POST/GET/PUT /api/permissions -what the installed mobile app and the deployed web app send."""

    @classmethod
    def setUpTestData(cls):
        cls.shift = _make_shift()
        cls.emp = Employee.objects.create(
            employee_code="PERM_API",
            first_name="Perm",
            last_name="Api",
            employment_type="staff",
            status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=cls.emp,
            shift=cls.shift,
            effective_from=date(2020, 1, 1),
        )

    def setUp(self):
        super().setUp()
        # An employee may only request dates in the current month (api/request_window.py), and these tests file
        # dates in April 2026: pin India's "today" for the window inside that month.
        pin = mock.patch("api.request_window.ist_today", return_value=date(2026, 4, 28))
        pin.start()
        self.addCleanup(pin.stop)

    def _post(self, body, token=None):
        body = {"employeeId": self.emp.id, "reason": "test", **body}
        return self.client.post(
            "/api/permissions",
            body,
            content_type="application/json",
            **(token or _emp_token(self.emp.id)),
        )

    def test_old_spelling_and_a_duration_are_accepted_and_answered_in_the_old_spelling(self):
        r = self._post({"date": "2026-04-20", "permissionTime": "10:00", "type": "Late In", "durationMinutes": 30})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["type"], "Late In")  # old clients keep working
        self.assertEqual(body["typeKey"], "morning_late_in")
        self.assertEqual(body["typeLabel"], "Morning Late-In")
        self.assertEqual(body["durationMinutes"], 60)  # client duration never trusted
        row = EmployeePermission.objects.get(pk=body["id"])
        self.assertEqual(row.type, "morning_late_in")
        self.assertEqual(row.duration_minutes, 60)

    def test_the_new_spelling_is_accepted_and_still_answered_in_the_old_one(self):
        r = self._post({"date": "2026-04-21", "type": "evening_early_out"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["type"], "Early Out")
        self.assertEqual(r.json()["typeKey"], "evening_early_out")

    def test_a_type_that_names_nothing_is_rejected(self):
        r = self._post({"date": "2026-04-22", "type": "Coffee Break"})
        self.assertEqual(r.status_code, 400)

    def test_a_request_with_no_type_gets_one_inferred_from_its_time(self):
        r = self._post({"date": "2026-04-23", "permissionTime": "17:00"})  # what the old web app sends
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["typeKey"], "evening_early_out")

    def test_a_request_with_no_type_and_no_time_is_still_accepted_untyped(self):
        r = self._post({"date": "2026-04-24"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["typeKey"])
        self.assertIsNone(r.json()["type"])

    def test_the_same_kind_of_permission_twice_for_a_day_is_a_conflict(self):
        self.assertEqual(self._post({"date": "2026-04-27", "type": "Late In"}).status_code, 201)
        self.assertEqual(self._post({"date": "2026-04-27", "type": "morning_late_in"}).status_code, 409)
        self.assertEqual(self._post({"date": "2026-04-27", "type": "Early Out"}).status_code, 201)

    def test_list_names_the_outcome_of_each_request(self):
        base = date(2026, 5, 1)
        approved = [
            EmployeePermission.objects.create(
                employee=self.emp, date=base.replace(day=dd), type="Late In", status="approved"
            )
            for dd in (4, 5, 6, 7)
        ]
        EmployeePermission.objects.create(
            employee=self.emp, date=base.replace(day=8), type="Late In", status="rejected"
        )
        EmployeePermission.objects.create(
            employee=self.emp, date=base.replace(day=11), type="Late In", status="pending"
        )
        r = self.client.get("/api/permissions?month=5&year=2026", **_emp_token(self.emp.id))
        self.assertEqual(r.status_code, 200)
        by_id = {p["id"]: p for p in r.json()}
        labels = [by_id[p.id]["statusLabel"] for p in approved]
        self.assertEqual(labels, ["Allowed", "Allowed", "Allowed", "Overdue / Excess"])
        self.assertEqual([by_id[p.id]["capStatus"] for p in approved], ["within_cap"] * 3 + ["excess"])
        self.assertEqual(
            sorted(p["statusLabel"] for p in by_id.values() if p["status"] != "approved"), ["Not Allowed", "Pending"]
        )
        sample = next(iter(by_id.values()))
        self.assertEqual(sample["dailyLimit"], sample["monthlyLimit"])  # deprecated keys still answer
        self.assertEqual(sample["weeklyLimit"], sample["monthlyLimit"])

    def test_hr_can_classify_an_untyped_request(self):
        p = EmployeePermission.objects.create(employee=self.emp, date=date(2026, 6, 15), status="pending")
        r = self.client.put(
            f"/api/permissions/{p.id}",
            {"type": "Short Leave"},
            content_type="application/json",
            **_hr(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["typeKey"], "middle_permission")
        bad = self.client.put(
            f"/api/permissions/{p.id}",
            {"type": "nope"},
            content_type="application/json",
            **_hr(),
        )
        self.assertEqual(bad.status_code, 400)


class SettingsValidationTests(TestCase):
    def _put(self, body):
        return self.client.put("/api/payroll-settings", body, content_type="application/json", **_hr())

    def test_the_halves_cannot_overlap_backwards(self):
        r = self._put({"halfDayFirstHalfEndTime": "15:00", "halfDaySecondHalfStartTime": "14:00"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(PayrollSettings.get().half_day_first_half_end_time, time(13, 30))

    def test_a_valid_pair_is_saved_and_a_zero_gap_is_allowed(self):
        r = self._put({"halfDayFirstHalfEndTime": "13:00", "halfDaySecondHalfStartTime": "13:00"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["halfDayFirstHalfEndTime"], "13:00")

    def test_a_garbage_time_is_rejected(self):
        self.assertEqual(self._put({"halfDayFirstHalfEndTime": "25:99"}).status_code, 400)

    def test_cap_and_free_allowance_are_bounded(self):
        self.assertEqual(self._put({"permissionMonthlyCap": 99}).status_code, 400)
        self.assertEqual(self._put({"permissionMonthlyCap": -1}).status_code, 400)
        self.assertEqual(self._put({"lateFreeAllowance": -1}).status_code, 400)
        self.assertEqual(self._put({"permissionMonthlyCap": 5, "lateFreeAllowance": 2}).status_code, 200)

    def test_the_arrival_timeline_defaults_are_the_ones_agreed(self):
        body = self.client.get("/api/payroll-settings", **_hr()).json()
        self.assertEqual(
            (
                body["arrivalLateWindowMinutes"],
                body["arrivalPermissionWindowMinutes"],
                body["arrivalExtraMinutes"],
                body["arrivalQuarterDeduction"],
            ),
            (60, 60, 20, 0.25),
        )

    def test_the_arrival_timeline_is_saved_and_reaches_the_engine(self):
        r = self._put(
            {
                "arrivalLateWindowMinutes": 30,
                "arrivalPermissionWindowMinutes": 45,
                "arrivalExtraMinutes": 10,
                "arrivalQuarterDeduction": 0.5,
            }
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["arrivalLateWindowMinutes"], body["arrivalPermissionWindowMinutes"], body["arrivalExtraMinutes"]),
            (30, 45, 10),
        )
        self.assertEqual(body["arrivalQuarterDeduction"], 0.5)
        shift = ShiftTemplate(start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10)
        limits = arrival_limits_for(shift, PayrollSettings.get())
        # 09:10 on time, +30 Late, +45 permission, +10 extra
        self.assertEqual(
            [
                hhmm(x)
                for x in (limits.on_time_until, limits.late_until, limits.permission_until, limits.first_half_until)
            ],
            ["09:10", "09:40", "10:25", "10:35"],
        )

    def test_the_arrival_timeline_is_bounded(self):
        for body in (
            {"arrivalLateWindowMinutes": 241},
            {"arrivalLateWindowMinutes": -1},
            {"arrivalPermissionWindowMinutes": 500},
            {"arrivalExtraMinutes": -5},
            {"arrivalQuarterDeduction": 1.5},
            {"arrivalQuarterDeduction": -0.25},
            {"arrivalQuarterDeduction": 0.255},
        ):
            self.assertEqual(self._put(body).status_code, 400, body)
        self.assertEqual(self._put({"arrivalLateWindowMinutes": "abc"}).status_code, 400)
        ps = PayrollSettings.get()
        self.assertEqual(
            (ps.arrival_late_window_minutes, ps.arrival_permission_window_minutes, ps.arrival_extra_minutes),
            (60, 60, 20),
        )
        self.assertEqual(ps.arrival_quarter_deduction, Decimal("0.25"))
        # the edges are fine, and a zero deduction switches the quarter-shift rule off
        self.assertEqual(
            self._put(
                {"arrivalLateWindowMinutes": 0, "arrivalExtraMinutes": 240, "arrivalQuarterDeduction": 0}
            ).status_code,
            200,
        )

    def test_saving_only_second_half_start_no_longer_trips_over_the_retired_first_half_end(self):
        # the stored fixed First Half End is 13:30; the page no longer sends it, so an earlier Second Half Start alone is fine
        r = self._put({"halfDaySecondHalfStartTime": "13:00"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["halfDaySecondHalfStartTime"], "13:00")

    def test_the_two_detection_switches_round_trip(self):
        r = self._put({"morningLateInEnabled": False, "eveningEarlyOutEnabled": True})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["morningLateInEnabled"])
        self.assertTrue(body["eveningEarlyOutEnabled"])


class RollingDeploySchemaTests(TestCase):
    """The migration must stay safe while an OLD backend instance is still running against the
    NEW schema (and after a rollback): nothing it uses was dropped, and every column it does not
    know about can be left out of its INSERTs because the database supplies a default."""

    NEW_COLUMNS = {
        "payroll_settings": [
            "morning_late_in_enabled",
            "evening_early_out_enabled",
            "half_day_first_half_end_time",
            "half_day_second_half_start_time",
            "permission_monthly_cap",
            "arrival_late_window_minutes",
            "arrival_permission_window_minutes",
            "arrival_extra_minutes",
            "arrival_quarter_deduction",
        ],
        "attendance_day_records": [
            "arrival_zone",
            "morning_permission_applied",
            "evening_permission_applied",
            "morning_permission_excess",
            "evening_permission_excess",
            "middle_permission_today",
        ],
    }
    LEGACY_COLUMNS = {
        "payroll_settings": [
            "shift_punctuality_window_minutes",
            "permission_window_minutes",
            "max_permissions_per_day",
            "max_permissions_per_week",
            "half_shift_late_reference_time",
            "without_permission_free_allowance",
            "without_permission_deduction_slabs",
            "afternoon_late_can_cause_half_shift",
        ],
        "attendance_day_records": [
            "late_in_without_permission",
            "early_out_without_permission",
            "permission_morning",
            "permission_morning_with_request",
            "permission_departure",
            "permission_departure_with_request",
            "permission_zone_count",
            "permission_escalated_to_half_shift",
        ],
    }

    def _defaults(self):
        with connection.cursor() as cur:
            cur.execute(
                "select table_name, column_name, column_default from information_schema.columns "
                "where table_schema = current_schema() and table_name = any(%s)",
                [list(self.NEW_COLUMNS)],
            )
            return {(t, c): d for t, c, d in cur.fetchall()}

    def test_no_legacy_column_was_dropped_or_renamed(self):
        cols = self._defaults()
        for table, names in self.LEGACY_COLUMNS.items():
            for name in names:
                self.assertIn((table, name), cols, f"{table}.{name} must still exist")

    def test_every_column_the_old_backend_cannot_know_has_a_database_default(self):
        cols = self._defaults()
        for group in (self.NEW_COLUMNS, self.LEGACY_COLUMNS):
            for table, names in group.items():
                for name in names:
                    self.assertIsNotNone(cols[(table, name)], f"{table}.{name} needs a database default")


class Migration0103UpgradePathTests(TransactionTestCase):
    """The real production upgrade, replayed on the (throwaway) test database: schema at 0102 with
    legacy-shaped rows -> migrate to 0103 -> an OLD backend keeps inserting -> roll back to 0102.
    Everything here runs against the test database only."""

    BEFORE = [("api", "0102_whatsapp_alert_timing")]
    AFTER = [("api", "0103_late_permission_half_day_rewrite")]

    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return MigrationExecutor(connection).loader.project_state(targets).apps

    def tearDown(self):
        # Leave the test database at the latest schema whatever happened above.
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_upgrade_keeps_legacy_data_lets_an_old_backend_insert_and_rolls_back(self):
        old = self._migrate(self.BEFORE)
        Employee = old.get_model("api", "Employee")
        DayRecord = old.get_model("api", "AttendanceDayRecord")
        Permission = old.get_model("api", "EmployeePermission")
        emp = Employee.objects.create(
            employee_code="MIG_UP",
            first_name="Mig",
            last_name="Up",
            employment_type="staff",
            status="active",
        )
        DayRecord.objects.create(
            employee=emp,
            date=date(2026, 3, 2),
            status="present",
            permission_morning=True,
            permission_zone_count=1,
            late_in_without_permission=True,
        )
        Permission.objects.create(employee=emp, date=date(2026, 3, 2), type="Late In", status="approved")

        self._migrate(self.AFTER)

        with connection.cursor() as cur:
            # nothing legacy was rewritten or lost
            cur.execute(
                "select permission_morning, permission_zone_count, late_in_without_permission, "
                "morning_permission_applied, middle_permission_today from attendance_day_records"
            )
            self.assertEqual(cur.fetchone(), (True, 1, True, False, False))
            cur.execute("select type from employee_permissions")
            self.assertEqual(cur.fetchone()[0], "Late In")  # no data relabelled
            cur.execute("select morning_late_in_enabled, permission_monthly_cap from payroll_settings")
            for row in cur.fetchall():
                self.assertEqual(row, (True, 3))

        # An OLD backend instance (it only knows the 0102 model) inserts against the NEW schema.
        DayRecord.objects.create(employee=emp, date=date(2026, 3, 3), status="absent")
        Permission.objects.create(employee=emp, date=date(2026, 3, 3), type="Early Out", status="pending")
        with connection.cursor() as cur:
            cur.execute("select count(*) from attendance_day_records")
            self.assertEqual(cur.fetchone()[0], 2)

        # ...and the release can be rolled back.
        self._migrate(self.BEFORE)
        with connection.cursor() as cur:
            cur.execute(
                "select count(*) from information_schema.columns "
                "where table_name = 'attendance_day_records' and column_name = 'morning_permission_applied'"
            )
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute("select count(*) from attendance_day_records where permission_morning")
            self.assertEqual(cur.fetchone()[0], 1)  # legacy data still intact after rollback


class CompanyWideRuleGuardTests(TestCase):
    """The rules that decide late / half-day / allowed permission are company-wide: the attendance
    engine reads only the company row, so a branch login must not be able to save a private value
    that the Settings page would show but nothing would apply."""

    @classmethod
    def setUpTestData(cls):
        from .models import Branch, Role

        cls.branch = Branch.objects.create(name="Guard Unit")
        role = Role.objects.create(
            name="Guard Editor", permissions={"settings.attendance": "edit", "settings.late_detection": "edit"}
        )
        cls.branch_user = HRUser.objects.create(
            username="guard_branch", password_hash="x", role=role, branch=cls.branch, is_super_admin=False
        )

    def _branch_token(self):
        return _bearer({"role": "hr", "hrUserId": self.branch_user.id})

    def test_a_branch_login_cannot_change_a_company_wide_rule(self):
        for body in (
            {"permissionMonthlyCap": 9},
            {"morningLateInEnabled": False},
            {"eveningEarlyOutEnabled": True},
            {"halfDayFirstHalfEndTime": "12:00"},
            {"halfDaySecondHalfStartTime": "15:00"},
            {"arrivalLateWindowMinutes": 30},
            {"arrivalPermissionWindowMinutes": 30},
            {"arrivalExtraMinutes": 5},
            {"arrivalQuarterDeduction": 0.5},
        ):
            r = self.client.put("/api/payroll-settings", body, content_type="application/json", **self._branch_token())
            self.assertEqual(r.status_code, 403, body)
            self.assertEqual(r.json()["error"], "company_wide_rule")
        # ...and nothing leaked into the company row or the branch overlay.
        ps = PayrollSettings.get()
        self.assertEqual((ps.permission_monthly_cap, ps.morning_late_in_enabled), (3, True))

    def test_the_settings_response_tells_the_page_who_may_edit_them(self):
        as_branch = self.client.get("/api/payroll-settings", **self._branch_token()).json()
        as_admin = self.client.get("/api/payroll-settings", **_hr()).json()
        self.assertFalse(as_branch["companyWideRulesEditable"])
        self.assertTrue(as_admin["companyWideRulesEditable"])
        # a branch login still SEES the company-wide values
        self.assertEqual(as_branch["permissionMonthlyCap"], as_admin["permissionMonthlyCap"])
